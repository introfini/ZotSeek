/**
 * Search Results Table using VirtualizedTableHelper
 * 
 * Uses zotero-plugin-toolkit's VirtualizedTableHelper to create a native
 * Zotero-style table for displaying semantic search results.
 */

import { VirtualizedTableHelper } from 'zotero-plugin-toolkit';
import { SearchResult } from '../core/search-engine';
import { HybridSearchResult, HybridSearchEngine } from '../core/hybrid-search';
import { getString } from '../utils/locale';
import { Logger } from '../utils/logger';

declare const Zotero: any;

// Union type for both result types
type AnySearchResult = SearchResult | HybridSearchResult;

export interface ResultsTableColumn {
  dataKey: string;
  label: string;
  width?: number;
  staticWidth?: boolean;  // Use staticWidth like zotero-addons
  fixedWidth?: boolean;   // Keep for compatibility
  flex?: number;
  hidden?: boolean;
}

export interface ResultsTableOptions {
  containerId: string;
  columns?: ResultsTableColumn[];
  onSelectionChange?: (indices: number[]) => void;
  onActivate?: (index: number) => void;  // Double-click or Enter
  onContextMenu?: (event: MouseEvent, indices: number[]) => void;  // Right-click
}

// Common words not worth highlighting in snippets (English query stopwords).
const SNIPPET_STOPWORDS = new Set<string>([
  'the', 'a', 'an', 'and', 'or', 'of', 'to', 'in', 'on', 'at', 'by', 'for',
  'with', 'as', 'is', 'are', 'was', 'were', 'be', 'been', 'it', 'its', 'this',
  'that', 'these', 'those', 'from', 'how', 'do', 'does', 'did', 'can', 'we',
  'they', 'their', 'them', 'about', 'into', 'than', 'then', 'but', 'not',
]);

const DEFAULT_COLUMNS: ResultsTableColumn[] = [
  {
    dataKey: 'indicator',
    label: '',  // No header label for indicator
    staticWidth: true,
    width: 32,
    hidden: false,
  },
  {
    dataKey: 'similarity',
    label: getString('column-match'),
    staticWidth: true,
    width: 110,  // Wider to fit per-query scores like "73% (77|77)"
    hidden: false,
  },
  {
    dataKey: 'title',
    label: getString('column-title'),
    fixedWidth: false,  // This column will flex
    hidden: false,
  },
  {
    dataKey: 'authors',
    label: getString('column-authors'),
    staticWidth: true,
    width: 180,
    hidden: false,
  },
  {
    dataKey: 'year',
    label: getString('column-year'),
    staticWidth: true,
    width: 50,
    hidden: false,
  },
  {
    dataKey: 'page',
    label: getString('column-location'),
    staticWidth: true,
    width: 90,
    hidden: false,
  },
  {
    dataKey: 'source',
    label: getString('column-section'),
    staticWidth: true,
    width: 80,
    hidden: false,
  },
];

export class SearchResultsTable {
  private logger: Logger;
  private tableHelper: InstanceType<typeof VirtualizedTableHelper> | null = null;
  private results: AnySearchResult[] = [];
  private enrichedResults: Map<number, any> = new Map();
  private exactPages: Map<number, number> = new Map();  // itemId -> exact page number
  private options: ResultsTableOptions;
  private container: HTMLElement | null = null;
  private isHybridMode: boolean = false;  // Track if showing hybrid results

  // Snippet hover tooltip state
  private doc: Document | null = null;
  private snippetTooltip: HTMLElement | null = null;
  private highlightTerms: string[] = [];  // Query terms to <mark> in the snippet (keyword/hybrid only)
  private boundOnTableMouseMove: ((e: MouseEvent) => void) | null = null;
  private boundHideTooltip: (() => void) | null = null;

  // Granularity mode: 'section' (aggregated) or 'location' (exact page/paragraph)
  private granularity: 'section' | 'location' = 'section';

  // Sort state tracking
  private currentSortColumn: string | null = null;
  private currentSortAscending: boolean = true;

  constructor(options: ResultsTableOptions) {
    this.logger = new Logger('SearchResultsTable');
    this.options = {
      columns: DEFAULT_COLUMNS,
      ...options,
    };
  }

  /**
   * Initialize the table in the given window/document
   */
  async init(win: Window): Promise<void> {
    this.logger.debug('Initializing SearchResultsTable...');
    
    const doc = win.document;
    this.doc = doc;
    this.container = doc.getElementById(this.options.containerId);

    if (!this.container) {
      const error = `Container element not found: ${this.options.containerId}`;
      this.logger.error(error);
      throw new Error(error);
    }

    this.logger.debug('Container found, clearing content...');
    // Clear any existing content
    this.container.innerHTML = '';

    try {
      this.logger.debug('Creating VirtualizedTableHelper...');
      
      // Check if VirtualizedTableHelper is available
      if (!VirtualizedTableHelper) {
        throw new Error('VirtualizedTableHelper is not available');
      }
      
      this.logger.debug('VirtualizedTableHelper constructor found, creating instance...');
      
      this.logger.debug('Columns configuration:', JSON.stringify(this.options.columns));
      
      // Create the VirtualizedTable - following zotero-addons pattern
      this.tableHelper = new VirtualizedTableHelper(win)
      .setContainerId(this.options.containerId)
      .setProp({
        id: 'zotseek-results-table',
        columns: this.options.columns,
        showHeader: true,
        multiSelect: true,
        staticColumns: false,  // Allow column resizing like zotero-addons
        disableFontSizeScaling: false,  // Match zotero-addons setting
        linesPerRow: 1.6,  // Match zotero-addons row height
      })
      .setProp('getRowCount', () => this.results.length)
      .setProp('getRowData', (index: number) => {
        const data = this.getRowData(index);
        this.logger.debug(`getRowData(${index}):`, JSON.stringify(data));
        return data;
      })
      .setProp('getRowString', (index: number) => this.results[index]?.title || '')
      .setProp('onSelectionChange', (selection: { selected: Set<number> }) => {
        if (this.options.onSelectionChange) {
          this.options.onSelectionChange(Array.from(selection.selected));
        }
      })
      .setProp('onActivate', (event: Event, indices: number[]) => {
        if (this.options.onActivate && indices.length > 0) {
          this.options.onActivate(indices[0]);
        }
      })
      .setProp('onColumnSort', (columnIndex: number) => {
        this.handleColumnSort(columnIndex);
      })
      .setProp('onItemContextMenu', (event: Event, x: number, y: number) => {
        this.logger.info(`onItemContextMenu called at (${x}, ${y})`);

        // Get selected indices from current selection
        const selectedIndices = this.getSelectedIndices();
        this.logger.info(`Selected indices: ${selectedIndices.join(', ')}`);

        if (selectedIndices.length === 0) {
          this.logger.info('No selection, skipping context menu');
          return;
        }

        // Call the context menu callback if provided
        if (this.options.onContextMenu) {
          this.logger.info('Calling onContextMenu callback');
          // Create a synthetic mouse event with screen coordinates
          const mouseEvent = event instanceof MouseEvent ? event : new MouseEvent('contextmenu', {
            screenX: x,
            screenY: y,
            clientX: x,
            clientY: y,
          });
          this.options.onContextMenu(mouseEvent, selectedIndices);
        } else {
          this.logger.info('No onContextMenu callback registered');
        }
      })
      .setProp('storeColumnPrefs', (prefs: any) => {
        // Store column preferences (width, order, visibility)
        this.logger.debug('Column preferences updated:', prefs);
      });

      this.logger.debug('VirtualizedTableHelper created, rendering...');
      // Render the table
      await this.tableHelper.render();

      // Set up the snippet hover tooltip (issue #36)
      this.setupSnippetTooltip();

      this.logger.info('Results table initialized');
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.logger.error('Failed to create VirtualizedTableHelper:', errorMessage);
      throw error;
    }
  }

  /**
   * Get formatted row data for display
   */
  private getRowData(index: number): Record<string, any> {
    const result = this.results[index];
    if (!result) {
      // Return empty data for all columns
      return {
        indicator: '',
        similarity: '',
        title: '',
        authors: '',
        year: '',
        source: '',
      };
    }

    const localId = result.itemId;
    const enriched = localId !== undefined ? this.enrichedResults.get(localId) : undefined;

    // Check if this is a hybrid search result
    const isHybrid = this.isHybridSearchResult(result);

    // Get the data with fallbacks
    let authors: string | string[];
    let year: number | undefined;
    let title: string;

    if (isHybrid) {
      // HybridSearchResult already has formatted data
      const hybridResult = result as HybridSearchResult;
      authors = hybridResult.creators || '';
      year = hybridResult.year;
      title = hybridResult.title || 'Untitled';
    } else {
      // SearchResult needs enrichment
      authors = enriched?.authors || (result as SearchResult).authors || [];
      year = enriched?.year || (result as SearchResult).year;
      title = enriched?.title || result.title || 'Untitled';
    }

    // Mark orphan results (item not present in current Zotero library)
    if (localId === undefined) {
      title = `[Not synced] ${title}`;
    }
    
    // Format the data for display
    const formattedAuthors = this.formatAuthors(authors);
    const formattedYear = year ? String(year) : '';
    const formattedSource = this.formatSource(isHybrid ? (result as HybridSearchResult).textSource : (result as SearchResult).textSource);
    
    // Format similarity/score
    let formattedSimilarity: string;
    if (isHybrid) {
      const hybridResult = result as HybridSearchResult;
      if (hybridResult.semanticScore !== null) {
        // Show semantic similarity score (0-100%)
        const mainScore = `${Math.round(hybridResult.semanticScore * 100)}%`;

        // If we have per-query scores, show them in a compact format
        if (hybridResult.queryScores && hybridResult.queryScores.length > 1) {
          const queryPcts = hybridResult.queryScores.map(s => Math.round(s * 100));
          formattedSimilarity = `${mainScore} (${queryPcts.join('|')})`;
        } else {
          formattedSimilarity = mainScore;
        }
      } else if (hybridResult.keywordScore !== null) {
        // Show keyword relevance score for keyword-only results
        formattedSimilarity = `${Math.round(hybridResult.keywordScore * 100)}%`;
      } else {
        formattedSimilarity = '—';
      }
    } else {
      formattedSimilarity = `${Math.round((result as SearchResult).similarity * 100)}%`;
    }
    
    // Get source indicator for hybrid results
    const indicator = isHybrid ? HybridSearchEngine.getSourceIndicator(result as HybridSearchResult) : '';
    
    // Location of the matched chunk, e.g. "p. 8, ¶3" (page 8, paragraph 3, 1-based).
    // Shown in BOTH granularity modes: in 'section' mode it's the location of the
    // single best-matching chunk (MaxSim) for that paper, in 'location' mode it's
    // the location of each individual chunk. Falls back to "—" when no page is
    // known (e.g. keyword-only matches, or abstract-only indexing).
    let formattedPage = '—';
    const pageNumber = isHybrid
      ? (result as HybridSearchResult).pageNumber
      : (result as SearchResult).pageNumber;
    const paragraphIndex = isHybrid
      ? (result as HybridSearchResult).paragraphIndex
      : (result as SearchResult).paragraphIndex;
    if (pageNumber) {
      const paraNum = (paragraphIndex ?? 0) + 1;  // Convert to 1-based
      formattedPage = `p. ${pageNumber}, ¶${paraNum}`;
    }

    // Create the row data object with EXACT column dataKey names
    const rowData: Record<string, any> = {
      indicator: indicator,
      similarity: formattedSimilarity,
      title: title,
      authors: formattedAuthors,
      year: formattedYear,
      page: formattedPage,
      source: formattedSource,
    };

    return rowData;
  }
  
  /**
   * Type guard to check if result is HybridSearchResult
   */
  private isHybridSearchResult(result: AnySearchResult): result is HybridSearchResult {
    return 'rrfScore' in result || 'source' in result;
  }


  /**
   * Format the text source (now includes section types)
   */
  private formatSource(source?: string): string {
    switch (source) {
      // Legacy types
      case 'abstract': return getString('source-abstract');
      case 'fulltext': return getString('source-fulltext');
      case 'title_only': return getString('source-title');
      // Section-specific types (new)
      case 'summary': return getString('source-abstract');
      case 'methods': return getString('source-methods');
      case 'findings': return getString('source-results');
      case 'content': return getString('source-content');
      default: return '';
    }
  }

  /**
   * Format authors array to string
   */
  private formatAuthors(authors?: string[] | any): string {
    // Handle if authors is not an array
    if (!authors) return '';
    if (!Array.isArray(authors)) {
      // If it's a string, return it directly
      if (typeof authors === 'string') return authors;
      // If it's a number or something else, return empty
      return '';
    }
    
    if (authors.length === 0) return '';
    
    // Filter out empty strings and ensure we have valid author names
    const validAuthors = authors.filter(a => a && typeof a === 'string' && a.trim());
    
    if (validAuthors.length === 0) return '';
    if (validAuthors.length === 1) return validAuthors[0];
    if (validAuthors.length === 2) return validAuthors.join(' & ');
    return `${validAuthors[0]} et al.`;
  }

  /**
   * Update the table with new SearchResult results
   */
  async setResults(results: SearchResult[], enrichedData?: Map<number, any>): Promise<void> {
    this.results = results;
    this.enrichedResults = enrichedData || new Map();
    this.exactPages.clear();  // Clear exact pages when results change
    this.isHybridMode = false;
    this.hideSnippetTooltip();

    if (this.tableHelper) {
      // Refresh the table to show new data
      await this.tableHelper.render();
      this.logger.debug(`Table updated with ${results.length} results`);
    }
  }

  /**
   * Update the table with hybrid search results
   * HybridSearchResult already contains metadata, so no enrichment needed
   */
  async setHybridResults(results: HybridSearchResult[]): Promise<void> {
    this.results = results;
    this.enrichedResults.clear();  // Not needed for hybrid results
    this.exactPages.clear();  // Clear exact pages when results change
    this.isHybridMode = true;
    this.hideSnippetTooltip();

    if (this.tableHelper) {
      // Refresh the table to show new data
      await this.tableHelper.render();
      this.logger.debug(`Table updated with ${results.length} hybrid results`);
    }
  }

  /**
   * Set exact page number for an item
   */
  setExactPage(itemId: number, pageNumber: number): void {
    this.exactPages.set(itemId, pageNumber);
  }

  /**
   * Update exact pages for multiple items and re-render
   */
  async updateExactPages(pages: Map<number, number>): Promise<void> {
    for (const [itemId, page] of pages) {
      this.exactPages.set(itemId, page);
    }
    if (this.tableHelper) {
      await this.tableHelper.render();
    }
  }

  /**
   * Get item IDs of current results (for finding pages).
   * Orphan results (no resolved local itemId) are filtered out.
   */
  getResultItemIds(): number[] {
    return this.results
      .map(r => r.itemId)
      .filter((id): id is number => id !== undefined);
  }

  /**
   * Get search text for an item (for finding exact page)
   * Uses title as it's typically on page 1 and works well for verification
   */
  getSearchTextForItem(itemId: number): string | null {
    const result = this.results.find(r => r.itemId === itemId);
    if (!result) return null;
    // Use title - it's typically on the first page of academic papers
    return result.title || null;
  }

  /**
   * Get exact page number for an item (if found via Find Pages)
   */
  getExactPage(itemId: number): number | undefined {
    return this.exactPages.get(itemId);
  }

  /**
   * Force a re-render of the table
   */
  async render(): Promise<void> {
    this.hideSnippetTooltip();
    if (this.tableHelper) {
      await this.tableHelper.render();
      this.logger.debug('Table re-rendered');
    }
  }

  /**
   * Get the currently selected result
   */
  getSelectedResult(): AnySearchResult | null {
    if (!this.tableHelper) return null;
    
    const tree = this.tableHelper.treeInstance;
    if (!tree) return null;
    
    const selection = tree.selection;
    if (!selection || selection.count === 0) return null;
    
    const index = selection.currentIndex;
    return this.results[index] || null;
  }

  /**
   * Get indices of all selected rows
   */
  getSelectedIndices(): number[] {
    if (!this.tableHelper) return [];

    const tree = this.tableHelper.treeInstance;
    if (!tree) return [];

    const selection = tree.selection;
    if (!selection || selection.count === 0) return [];

    const indices: number[] = [];
    for (let i = 0; i < this.results.length; i++) {
      if (selection.isSelected(i)) {
        indices.push(i);
      }
    }
    return indices;
  }

  /**
   * Get all selected results
   */
  getSelectedResults(): AnySearchResult[] {
    const indices = this.getSelectedIndices();
    return indices.map(i => this.results[i]).filter(Boolean);
  }

  /**
   * Get the result at a specific index
   */
  getResultAt(index: number): AnySearchResult | null {
    return this.results[index] || null;
  }

  /**
   * Clear all results
   */
  async clear(): Promise<void> {
    this.results = [];
    this.enrichedResults.clear();
    this.exactPages.clear();
    this.currentSortColumn = null;
    this.currentSortAscending = true;
    this.hideSnippetTooltip();
    if (this.tableHelper) {
      await this.tableHelper.render();
      this.updateSortIndicator();  // Clear sort indicator
    }
  }

  /**
   * Sort results by column
   */
  async sortBy(column: string, ascending: boolean = true): Promise<void> {
    const sortFn = (a: AnySearchResult, b: AnySearchResult): number => {
      let valA: any, valB: any;
      
      const isHybridA = this.isHybridSearchResult(a);
      const isHybridB = this.isHybridSearchResult(b);
      
      const enrichedA = a.itemId !== undefined ? this.enrichedResults.get(a.itemId) : undefined;
      const enrichedB = b.itemId !== undefined ? this.enrichedResults.get(b.itemId) : undefined;
      
      switch (column) {
        case 'similarity':
          if (isHybridA) {
            valA = (a as HybridSearchResult).semanticScore ?? (a as HybridSearchResult).rrfScore;
          } else {
            valA = (a as SearchResult).similarity;
          }
          if (isHybridB) {
            valB = (b as HybridSearchResult).semanticScore ?? (b as HybridSearchResult).rrfScore;
          } else {
            valB = (b as SearchResult).similarity;
          }
          break;
        case 'title':
          valA = a.title?.toLowerCase() || '';
          valB = b.title?.toLowerCase() || '';
          break;
        case 'year':
          if (isHybridA) {
            valA = (a as HybridSearchResult).year || 0;
          } else {
            valA = enrichedA?.year || (a as SearchResult).year || 0;
          }
          if (isHybridB) {
            valB = (b as HybridSearchResult).year || 0;
          } else {
            valB = enrichedB?.year || (b as SearchResult).year || 0;
          }
          break;
        case 'authors':
          if (isHybridA) {
            valA = ((a as HybridSearchResult).creators || '').toLowerCase();
          } else {
            valA = this.formatAuthors(enrichedA?.authors || (a as SearchResult).authors).toLowerCase();
          }
          if (isHybridB) {
            valB = ((b as HybridSearchResult).creators || '').toLowerCase();
          } else {
            valB = this.formatAuthors(enrichedB?.authors || (b as SearchResult).authors).toLowerCase();
          }
          break;
        case 'source':
          valA = (isHybridA ? (a as HybridSearchResult).textSource : (a as SearchResult).textSource) || '';
          valB = (isHybridB ? (b as HybridSearchResult).textSource : (b as SearchResult).textSource) || '';
          break;
        default:
          return 0;
      }
      
      if (valA < valB) return ascending ? -1 : 1;
      if (valA > valB) return ascending ? 1 : -1;
      return 0;
    };

    this.results.sort(sortFn);
    await this.tableHelper?.render();
  }

  /**
   * Handle column header click for sorting
   * Maps column index to dataKey and toggles sort direction
   */
  private handleColumnSort(columnIndex: number): void {
    const columns = this.options.columns || DEFAULT_COLUMNS;
    const column = columns[columnIndex];

    if (!column) {
      this.logger.debug(`Invalid column index: ${columnIndex}`);
      return;
    }

    const dataKey = column.dataKey;

    // Skip non-sortable columns
    if (dataKey === 'indicator' || dataKey === 'page') {
      this.logger.debug(`Column '${dataKey}' is not sortable`);
      return;
    }

    this.logger.debug(`Sorting by column: ${dataKey}`);

    // Determine sort direction
    let ascending: boolean;
    if (this.currentSortColumn === dataKey) {
      // Toggle direction if clicking the same column
      ascending = !this.currentSortAscending;
    } else {
      // New column: default direction based on column type
      // Similarity/year default to descending (highest first)
      // Text columns default to ascending (A-Z)
      ascending = dataKey !== 'similarity' && dataKey !== 'year';
    }

    // Update sort state
    this.currentSortColumn = dataKey;
    this.currentSortAscending = ascending;

    // Perform the sort
    this.sortBy(dataKey, ascending);

    this.logger.debug(`Sorted by ${dataKey} (${ascending ? 'ascending' : 'descending'})`);

    // Update visual sort indicator
    this.updateSortIndicator();
  }

  /**
   * Update the visual sort indicator (CSS classes) on column headers
   */
  private updateSortIndicator(): void {
    if (!this.container) return;

    // Find all header cells
    const headerCells = this.container.querySelectorAll('.tree-header .cell');

    headerCells.forEach((cell) => {
      const dataKey = cell.getAttribute('data-key');

      // Remove existing sort classes
      cell.classList.remove('sorted-ascending', 'sorted-descending');

      // Add sort class if this is the sorted column
      if (dataKey === this.currentSortColumn) {
        cell.classList.add(this.currentSortAscending ? 'sorted-ascending' : 'sorted-descending');
      }
    });
  }

  /**
   * Get current sort state (for UI indicators)
   */
  getSortState(): { column: string | null; ascending: boolean } {
    return {
      column: this.currentSortColumn,
      ascending: this.currentSortAscending,
    };
  }

  /**
   * Reset sort to default (by relevance score, descending)
   */
  async resetSort(): Promise<void> {
    this.currentSortColumn = 'similarity';
    this.currentSortAscending = false;
    await this.sortBy('similarity', false);
  }

  /**
   * Focus the table for keyboard navigation
   */
  focus(): void {
    this.tableHelper?.treeInstance?.focus();
  }

  /**
   * Set the granularity mode for result display
   * @param granularity 'section' for aggregated view, 'location' for exact page/paragraph
   */
  setGranularity(granularity: 'section' | 'location'): void {
    this.granularity = granularity;
    this.logger.debug(`Granularity set to: ${granularity}`);
  }

  /**
   * Get current granularity mode
   */
  getGranularity(): 'section' | 'location' {
    return this.granularity;
  }

  /**
   * Select a specific item by index
   */
  selectIndex(index: number): void {
    if (!this.tableHelper || index < 0 || index >= this.results.length) return;
    
    const tree = this.tableHelper.treeInstance;
    if (tree && tree.selection) {
      tree.selection.select(index);
      // ensureRowIsVisible might not be available in all versions
      if (typeof tree.ensureRowIsVisible === 'function') {
        tree.ensureRowIsVisible(index);
      }
    }
  }

  /**
   * Set the query terms to highlight inside the snippet tooltip.
   * Pass an empty array for pure-semantic searches (no literal terms to mark).
   */
  setQueryTerms(terms: string[]): void {
    // Strip surrounding punctuation, lowercase, de-duplicate, and drop common
    // stopwords + very short tokens — highlighting "in"/"of"/"the" is just noise.
    const seen = new Set<string>();
    this.highlightTerms = [];
    for (const t of terms) {
      const tok = (t || '').toLowerCase().replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');
      if (tok.length < 2 || seen.has(tok) || SNIPPET_STOPWORDS.has(tok)) continue;
      seen.add(tok);
      this.highlightTerms.push(tok);
    }
  }

  /**
   * Create the floating snippet tooltip element and wire hover/scroll handlers.
   * Uses event delegation on the table container so it survives the
   * VirtualizedTable recycling row DOM nodes during scroll.
   */
  private setupSnippetTooltip(): void {
    if (!this.doc || !this.container || this.snippetTooltip) return;

    const tip = this.doc.createElement('div');
    tip.className = 'zotseek-snippet-tooltip';
    tip.setAttribute('role', 'tooltip');
    tip.setAttribute('aria-hidden', 'true');
    // The table lives inside a XUL/XHTML dialog; appending to <html> keeps the
    // tooltip above the table and free of the container's overflow clipping.
    (this.doc.documentElement || this.doc.body).appendChild(tip);
    this.snippetTooltip = tip;

    this.boundOnTableMouseMove = (e: MouseEvent) => this.onTableMouseMove(e);
    this.boundHideTooltip = () => this.hideSnippetTooltip();

    this.container.addEventListener('mousemove', this.boundOnTableMouseMove);
    this.container.addEventListener('mouseleave', this.boundHideTooltip);
    // Hide while scrolling: the row under the cursor changes without a mousemove.
    this.container.addEventListener('scroll', this.boundHideTooltip, true);
  }

  /**
   * Resolve the result row under the cursor and show/hide its snippet tooltip.
   */
  private onTableMouseMove(e: MouseEvent): void {
    if (!this.snippetTooltip) return;

    const target = e.target as HTMLElement | null;
    const rowEl = target?.closest('[id^="zotseek-results-table-row-"]') as HTMLElement | null;
    if (!rowEl) {
      this.hideSnippetTooltip();
      return;
    }

    const idx = parseInt(rowEl.id.slice('zotseek-results-table-row-'.length), 10);
    if (Number.isNaN(idx)) {
      this.hideSnippetTooltip();
      return;
    }

    const result = this.results[idx];
    const html = result ? this.buildSnippetHtml(result) : null;
    if (!html) {
      this.hideSnippetTooltip();
      return;
    }

    this.snippetTooltip.innerHTML = html;
    this.snippetTooltip.classList.add('show');
    this.snippetTooltip.setAttribute('aria-hidden', 'false');
    this.positionTooltip(e.clientX, e.clientY);
  }

  /**
   * Position the tooltip near the cursor, flipping away from viewport edges.
   */
  private positionTooltip(x: number, y: number): void {
    const tip = this.snippetTooltip;
    const win = this.doc?.defaultView;
    if (!tip || !win) return;

    const pad = 16;
    const w = tip.offsetWidth;
    const h = tip.offsetHeight;
    let left = x + pad;
    let top = y + pad;
    if (left + w > win.innerWidth - 8) left = x - w - pad;
    if (top + h > win.innerHeight - 8) top = y - h - pad;
    tip.style.left = `${Math.max(8, left)}px`;
    tip.style.top = `${Math.max(8, top)}px`;
  }

  /**
   * Hide the snippet tooltip.
   */
  private hideSnippetTooltip(): void {
    if (!this.snippetTooltip) return;
    this.snippetTooltip.classList.remove('show');
    this.snippetTooltip.setAttribute('aria-hidden', 'true');
  }

  /**
   * Build the inner HTML of the snippet tooltip for a result, or null if the
   * result has no matched chunk text to show.
   */
  private buildSnippetHtml(result: AnySearchResult): string | null {
    const chunkText = (result as any).chunkText as string | undefined;
    if (!chunkText || !chunkText.trim()) return null;

    const snippet = this.windowSnippet(chunkText, 360);
    const body = this.highlightSnippet(snippet);

    // Metadata line: location, section, score
    const meta: string[] = [];
    const isHybrid = this.isHybridSearchResult(result);
    const pageNumber = (result as any).pageNumber as number | undefined;
    const paragraphIndex = (result as any).paragraphIndex as number | undefined;
    if (pageNumber) {
      const para = (paragraphIndex ?? 0) + 1;
      meta.push(`📍 ${getString('column-location')}: p. ${pageNumber}, ¶${para}`);
    }
    const sectionLabel = this.formatSource(
      isHybrid ? (result as HybridSearchResult).textSource : (result as SearchResult).textSource
    );
    if (sectionLabel) meta.push(`🏷️ ${sectionLabel}`);

    let score: number | null = null;
    if (isHybrid) {
      const h = result as HybridSearchResult;
      score = h.semanticScore ?? h.keywordScore;
    } else {
      score = (result as SearchResult).similarity;
    }
    if (score !== null && !Number.isNaN(score)) {
      meta.push(`🎯 ${Math.round(score * 100)}%`);
    }

    const head = meta.length
      ? `<div class="zotseek-snippet-meta">${meta.map(m => this.escapeHtml(m)).join('<span class="sep">·</span>')}</div>`
      : '';
    return `${head}<div class="zotseek-snippet-body">${body}</div>`;
  }

  /**
   * Trim a long chunk to a readable window. If there is a highlight term,
   * center the window on its first occurrence; otherwise take the start.
   */
  private windowSnippet(text: string, maxLen: number): string {
    const clean = text.replace(/\s+/g, ' ').trim();
    if (clean.length <= maxLen) return clean;

    let start = 0;
    if (this.highlightTerms.length > 0) {
      const lower = clean.toLowerCase();
      let firstHit = -1;
      for (const term of this.highlightTerms) {
        const i = lower.indexOf(term);
        if (i !== -1 && (firstHit === -1 || i < firstHit)) firstHit = i;
      }
      if (firstHit > maxLen / 2) start = firstHit - Math.floor(maxLen / 2);
    }

    let end = start + maxLen;
    let slice = clean.slice(start, end);
    if (start > 0) slice = `…${slice}`;
    if (end < clean.length) slice = `${slice}…`;
    return slice;
  }

  /**
   * Escape a snippet and wrap any highlight terms in <mark>.
   */
  private highlightSnippet(text: string): string {
    let out = this.escapeHtml(text);
    if (this.highlightTerms.length === 0) return out;

    // Longest terms first so compound terms aren't broken by shorter ones.
    const sorted = [...this.highlightTerms].sort((a, b) => b.length - a.length);
    for (const term of sorted) {
      const escaped = this.escapeHtml(term).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      if (!escaped) continue;
      // Word-boundary match so "in" doesn't light up inside "examining".
      const re = new RegExp(`\\b(${escaped})\\b`, 'gi');
      out = out.replace(re, '<mark>$1</mark>');
    }
    return out;
  }

  /**
   * Escape HTML special characters.
   */
  private escapeHtml(s: string): string {
    return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] as string));
  }

  /**
   * Cleanup
   */
  destroy(): void {
    // Tear down the snippet tooltip and its listeners
    if (this.container) {
      if (this.boundOnTableMouseMove) this.container.removeEventListener('mousemove', this.boundOnTableMouseMove);
      if (this.boundHideTooltip) {
        this.container.removeEventListener('mouseleave', this.boundHideTooltip);
        this.container.removeEventListener('scroll', this.boundHideTooltip, true);
      }
    }
    this.snippetTooltip?.remove();
    this.snippetTooltip = null;
    this.boundOnTableMouseMove = null;
    this.boundHideTooltip = null;
    this.highlightTerms = [];
    this.doc = null;

    // VirtualizedTableHelper doesn't have an unregister method
    // The React components are cleaned up automatically when the window closes
    this.tableHelper = null;
    this.results = [];
    this.enrichedResults.clear();
    this.exactPages.clear();
    this.currentSortColumn = null;
    this.currentSortAscending = true;
    this.container = null;
    this.logger.debug('Results table destroyed');
  }
}
