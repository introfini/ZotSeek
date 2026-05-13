/**
 * ZotSeek Search Dialog with VirtualizedTable
 *
 * This dialog provides a native Zotero-style interface for semantic search
 * using the VirtualizedTableHelper from zotero-plugin-toolkit.
 */

import { SearchResultsTable } from './results-table';
import { SearchEngine, searchEngine, SearchResult } from '../core/search-engine';
import { HybridSearchEngine, HybridSearchResult, SearchMode } from '../core/hybrid-search';
import { ZoteroAPI } from '../utils/zotero-api';
import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';
import { getString } from '../utils/locale';
import {
  addItemsToCollection as sharedAddItemsToCollection,
  populateCollectionMenu as sharedPopulateCollectionMenu,
  exportItemsToNewCollection,
} from './collection-export';

declare const Zotero: any;

export class ZotSeekDialogVTable {
  private logger: Logger;
  private zoteroAPI: ZoteroAPI;
  private resultsTable: SearchResultsTable | null = null;
  private window: Window | null = null;

  // Raw results from search (all individual paragraph matches)
  private rawResults: HybridSearchResult[] = [];
  // Currently displayed results (may be aggregated in section mode)
  private displayedResults: HybridSearchResult[] = [];

  private enrichedData: Map<number, any> = new Map();
  private isSearching: boolean = false;
  private searchTimeout: number | null = null;
  private lastQuery: string = '';
  private autoSearchDelay: number = 500; // milliseconds to wait after typing stops
  private minQueryLength: number = 3; // minimum characters before auto-search triggers

  // Hybrid search
  private hybridSearch: HybridSearchEngine;
  private searchMode: SearchMode = 'hybrid';
  private autoAdjustWeights: boolean = true;

  // User-configurable result limits (read from prefs on dialog open)
  private userTopK: number = 20;
  private userMinSimilarity: number = 0.3;

  // Results granularity: 'section' shows aggregated by section, 'location' shows exact page/paragraph
  private granularity: 'section' | 'location' = 'section';

  // Indexing mode: 'abstract' or 'full' - affects whether granularity toggle is shown
  private indexingMode: 'abstract' | 'full' = 'abstract';

  // Item ID to exclude from results (e.g., the paper being read when using "Find Related Papers")
  private excludeItemId: number | undefined = undefined;

  // Multi-query state
  private queryCount: number = 1;  // Number of active query fields
  private combineOperator: 'and' | 'or' = 'and';
  private andFormula: 'min' | 'product' | 'average' = 'min';  // AND combination formula
  private maxQueries: number = 4;  // Support up to 4 queries

  constructor() {
    this.logger = new Logger('ZotSeekDialogVTable');
    this.zoteroAPI = new ZoteroAPI();
    this.hybridSearch = new HybridSearchEngine(searchEngine);
    
    // Load preferences
    this.loadPreferences();
  }
  
  /**
   * Load hybrid search preferences from Zotero prefs
   */
  private loadPreferences(): void {
    try {
      const Z = getZotero();
      if (Z && Z.Prefs) {
        const mode = Z.Prefs.get('extensions.zotero.zotseek.hybridSearch.mode', true);
        if (mode === 'hybrid' || mode === 'semantic' || mode === 'keyword') {
          this.searchMode = mode;
        }

        this.autoAdjustWeights = Z.Prefs.get('extensions.zotero.zotseek.hybridSearch.autoAdjustWeights', true) !== false;

        // Load result-limit preferences set from the preferences pane
        const topKPref = Z.Prefs.get('zotseek.topK', true);
        if (typeof topKPref === 'number' && topKPref > 0) {
          this.userTopK = Math.floor(topKPref);
        }
        const minSimPref = Z.Prefs.get('zotseek.minSimilarityPercent', true);
        if (typeof minSimPref === 'number' && minSimPref >= 0 && minSimPref <= 100) {
          this.userMinSimilarity = minSimPref / 100;
        }
        this.logger.info(`Result limits: topK=${this.userTopK}, minSimilarity=${this.userMinSimilarity}`);

        // Load indexing mode to determine if granularity toggle should be shown
        const indexMode = Z.Prefs.get('extensions.zotero.zotseek.indexingMode', true);
        this.logger.info(`Loaded indexingMode preference: "${indexMode}" (type: ${typeof indexMode})`);
        if (indexMode === 'abstract' || indexMode === 'full') {
          this.indexingMode = indexMode;
        } else {
          // Default to showing the toggle (full mode) if preference is unclear
          this.indexingMode = 'full';
          this.logger.warn(`Unknown indexingMode "${indexMode}", defaulting to "full"`);
        }
      }
    } catch (e) {
      this.logger.warn('Failed to load preferences, using defaults:', e);
    }
  }

  /**
   * Initialize the dialog (called from XHTML onload)
   */
  async init(win: Window): Promise<void> {
    this.window = win;
    const doc = win.document;

    // Register FTL for localization
    (win as any).MozXULElement?.insertFTLIfNeeded('zotseek.ftl');

    // Reload preferences each time dialog opens (in case they changed)
    this.loadPreferences();

    try {
      // Initialize results table
      this.resultsTable = new SearchResultsTable({
        containerId: 'zotseek-results-container',
        onSelectionChange: (indices) => this.onSelectionChange(indices),
        onActivate: (index) => this.onActivate(index),
        onContextMenu: (event, indices) => this.showContextMenu(event, indices),
      });

      await this.resultsTable.init(win);

      // Bind event handlers
      const searchBtn = doc.getElementById('zotseek-btn');
      const query1Input = doc.getElementById('zotseek-query-1') as HTMLInputElement;
      const openBtn = doc.getElementById('zotseek-open-btn');
      const closeBtn = doc.getElementById('zotseek-close-btn');

      searchBtn?.addEventListener('click', () => this.performSearch());

      // Add auto-search on input with debouncing for query 1
      query1Input?.addEventListener('input', (e) => this.onQueryInput(e));

      // Keep Enter key for immediate search
      query1Input?.addEventListener('keypress', (e) => {
        if (e.key === 'Enter' && !this.isSearching) {
          // Clear any pending auto-search
          if (this.searchTimeout) {
            win.clearTimeout(this.searchTimeout);
            this.searchTimeout = null;
          }
          this.performSearch();
        }
      });

      // Multi-query UI handlers
      const addQueryBtn = doc.getElementById('zotseek-add-query-btn');
      addQueryBtn?.addEventListener('click', () => this.addQueryField());

      // Combine operator dropdown
      const operatorSelect = doc.getElementById('query-combine-operator');
      operatorSelect?.addEventListener('command', (e) => {
        this.combineOperator = (e.target as any).value as 'and' | 'or';
        this.updateOperatorHint();
        this.updateFormulaVisibility();
        // Re-search if we have multiple queries with content
        if (this.getActiveQueries().length > 1) {
          this.lastQuery = '';  // Force re-search
          this.performSearch();
        }
      });

      // AND formula dropdown (only relevant when AND is selected)
      const formulaSelect = doc.getElementById('query-and-formula');
      formulaSelect?.addEventListener('command', (e) => {
        this.andFormula = (e.target as any).value as 'min' | 'product' | 'average';
        // Re-search if we have multiple queries with AND
        if (this.combineOperator === 'and' && this.getActiveQueries().length > 1) {
          this.lastQuery = '';  // Force re-search
          this.performSearch();
        }
      });

      // Bind input events for all query fields (2, 3, 4)
      for (let i = 2; i <= this.maxQueries; i++) {
        const queryInput = doc.getElementById(`zotseek-query-${i}`) as HTMLInputElement;
        queryInput?.addEventListener('input', (e) => this.onQueryInput(e));
        queryInput?.addEventListener('keypress', (e) => {
          if (e.key === 'Enter' && !this.isSearching) {
            if (this.searchTimeout) {
              win.clearTimeout(this.searchTimeout);
              this.searchTimeout = null;
            }
            this.performSearch();
          }
        });

        // Bind remove button for this query
        const removeBtn = doc.getElementById(`zotseek-remove-query-${i}-btn`);
        removeBtn?.addEventListener('click', () => this.removeQueryField(i));
      }

      openBtn?.addEventListener('click', () => this.openSelected());
      const saveCollectionBtn = doc.getElementById('zotseek-save-collection-btn');
      saveCollectionBtn?.addEventListener('command', () => this.saveAllResultsAsCollection());
      closeBtn?.addEventListener('click', () => this.close());

      // Settings button - opens ZotSeek preferences
      const settingsBtn = doc.getElementById('zotseek-settings-btn');
      settingsBtn?.addEventListener('click', () => this.openSettings());

      // Find Pages button
      const findPagesBtn = doc.getElementById('zotseek-find-pages-btn');
      findPagesBtn?.addEventListener('click', () => this.findExactPages());

      // Add keyboard shortcuts
      win.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
          this.close();
        }
      });
      
      // Initialize search mode dropdown
      const modeSelect = doc.getElementById('search-mode-select') as HTMLSelectElement;
      if (modeSelect) {
        // Set current value from preference
        modeSelect.value = this.searchMode;
        
        // Handle mode changes
        modeSelect.addEventListener('command', (e) => {
          const newMode = (e.target as HTMLSelectElement).value as SearchMode;
          this.setSearchMode(newMode);
        });
        
        // Also handle 'change' event for HTML select elements
        modeSelect.addEventListener('change', (e) => {
          const newMode = (e.target as HTMLSelectElement).value as SearchMode;
          this.setSearchMode(newMode);
        });
      }
      
      // Initialize granularity radio buttons
      // Only show granularity toggle when indexing mode is "full" (has page/paragraph data)
      const granularityRow = doc.getElementById('granularity-row');
      const sectionRadio = doc.getElementById('granularity-section') as HTMLInputElement;
      const locationRadio = doc.getElementById('granularity-location') as HTMLInputElement;

      if (granularityRow) {
        // Always show granularity toggle - it will just show "—" for location if no page data
        // This lets users see the option exists and understand why results might differ
        (granularityRow as HTMLElement).style.display = '';
        this.logger.info(`Granularity row shown (indexingMode="${this.indexingMode}")`);
      } else {
        this.logger.warn('granularity-row element not found!');
      }

      if (sectionRadio && locationRadio) {
        // Set initial state
        sectionRadio.checked = this.granularity === 'section';
        locationRadio.checked = this.granularity === 'location';

        // Handle changes
        sectionRadio.addEventListener('change', () => {
          if (sectionRadio.checked) {
            this.setGranularity('section');
          }
        });

        locationRadio.addEventListener('change', () => {
          if (locationRadio.checked) {
            this.setGranularity('location');
          }
        });
      }

      // Expose dialog methods globally for XUL command attribute and external callers
      (win as any).searchDialogVTable = {
        setSearchMode: (mode: SearchMode) => this.setSearchMode(mode),
        getSearchMode: () => this.getSearchMode(),
        setGranularity: (g: 'section' | 'location') => this.setGranularity(g),
        getGranularity: () => this.granularity,
        performSearch: () => this.performSearch(),  // For triggering search from opener
        setExcludeItemId: (id: number | undefined) => { this.excludeItemId = id; },  // For excluding current paper
        addQueryField: () => this.addQueryField(),  // For adding another query
        removeQueryField: (index?: number) => this.removeQueryField(index),  // For removing a query
        setCombineOperator: (op: 'and' | 'or') => {
          this.combineOperator = op;
          const operatorSelect = doc.getElementById('query-combine-operator') as any;
          if (operatorSelect) operatorSelect.value = op;
          this.updateOperatorHint();
        },
      };

      // Focus the input
      query1Input?.focus();

      // Check for initial query and exclude item from window arguments (e.g., from PDF text selection)
      const windowArgs = (win as any).arguments?.[0];
      const initialQuery = windowArgs?.initialQuery;
      const excludeItemId = windowArgs?.excludeItemId;

      // Set exclude item ID if provided (to filter out the paper being read)
      if (excludeItemId !== undefined) {
        this.excludeItemId = excludeItemId;
        this.logger.info(`Will exclude item ${excludeItemId} from search results`);
      }

      if (initialQuery && query1Input) {
        query1Input.value = initialQuery;
        const truncated = initialQuery.length > 50 ? initialQuery.substring(0, 50) + '...' : initialQuery;
        this.logger.info(`Pre-filling query from PDF selection: "${truncated}"`);

        // Trigger search after a brief delay to let UI settle
        win.setTimeout(() => {
          this.performSearch();
        }, 150);
      }

      this.logger.info(`Search dialog initialized (mode: ${this.searchMode})`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : '';
      this.logger.error('Failed to initialize dialog:', errorMessage);
      this.logger.error('Stack trace:', errorStack);
      this.setStatus(`Failed to initialize dialog: ${errorMessage}`);
    }
  }

  /**
   * Perform the search using hybrid search
   */
  private async performSearch(): Promise<void> {
    if (!this.window || this.isSearching) return;
    const doc = this.window.document;

    const activeQueries = this.getActiveQueries();

    if (activeQueries.length === 0) {
      this.setStatus('');
      return;
    }

    // Build cache key and skip if same as last search
    const queryCacheKey = this.buildQueryCacheKey();
    if (queryCacheKey === this.lastQuery && this.rawResults.length > 0) {
      return;
    }

    this.isSearching = true;
    this.lastQuery = queryCacheKey;
    const searchBtn = doc.getElementById('zotseek-btn') as HTMLButtonElement;
    if (searchBtn) {
      searchBtn.disabled = true;
      searchBtn.textContent = getString('search-searching');
    }

    try {
      this.setStatus(getString('search-initializing'));
      this.setOpenButtonEnabled(false);
      this.setSaveCollectionButtonEnabled(false);

      // Show search mode in status
      const modeLabel = this.searchMode === 'hybrid' ? getString('search-hybrid') :
                        this.searchMode === 'semantic' ? getString('search-semantic') : getString('search-keyword');

      // Initialize search engine if needed (hybrid search will init as needed)
      if (this.searchMode !== 'keyword' && !searchEngine.isReady()) {
        this.setStatus(getString('search-loadingModel'));
        await searchEngine.init();
      }

      // Determine if we need all chunks (location mode) or aggregated results (section mode)
      const returnAllChunks = this.granularity === 'location';

      // Single query: use existing flow
      if (activeQueries.length === 1) {
        await this.performSingleQuerySearch(activeQueries[0], modeLabel, returnAllChunks);
      } else {
        // Multiple queries: run in parallel and combine
        await this.performMultiQuerySearch(activeQueries, modeLabel, returnAllChunks);
      }

      // Filter out excluded item (e.g., the paper being read when using "Find Related Papers")
      if (this.excludeItemId !== undefined) {
        const beforeCount = this.rawResults.length;
        this.rawResults = this.rawResults.filter(r => r.itemId !== this.excludeItemId);
        if (beforeCount !== this.rawResults.length) {
          this.logger.debug(`Filtered out current paper (item ${this.excludeItemId}) from results`);
        }
      }

      // Apply granularity filtering
      this.displayedResults = this.applyGranularity(this.rawResults);
      this.setSaveCollectionButtonEnabled(this.displayedResults.length > 0);

      // Update table with results
      await this.resultsTable?.setHybridResults(this.displayedResults);

      // Force a re-render
      if (this.resultsTable) {
        await this.resultsTable.render();
      }

      // Update status with detailed info
      const statusMsg = activeQueries.length === 1
        ? this.buildStatusMessage()
        : this.buildMultiQueryStatusMessage(activeQueries);
      this.setStatus(statusMsg);

      // Enable Find Pages button if we have results
      this.setFindPagesEnabled(this.displayedResults.length > 0);

      // Don't steal focus - let user continue typing in whichever field they're in

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(getString('search-failed', { error: message }));
      this.logger.error('Search failed:', error);
    } finally {
      this.isSearching = false;
      if (searchBtn) {
        searchBtn.disabled = false;
        searchBtn.textContent = getString('search-searchLabel');
      }
    }
  }

  /**
   * Perform a single query search (original behavior)
   */
  private async performSingleQuerySearch(
    query: string,
    modeLabel: string,
    returnAllChunks: boolean
  ): Promise<void> {
    this.setStatus(getString('search-finding', { mode: modeLabel }));

    // Use smart search (auto-adjusts weights) or regular search based on preference
    if (this.searchMode === 'hybrid' && this.autoAdjustWeights) {
      this.rawResults = await this.hybridSearch.smartSearch(query, {
        finalTopK: this.userTopK,
        minSimilarity: this.userMinSimilarity,
        mode: this.searchMode,
        returnAllChunks,
      });
    } else {
      this.rawResults = await this.hybridSearch.search(query, {
        finalTopK: this.userTopK,
        minSimilarity: this.userMinSimilarity,
        mode: this.searchMode,
        returnAllChunks,
      });
    }
  }

  /**
   * Perform multi-query search with AND/OR combination
   */
  private async performMultiQuerySearch(
    queries: string[],
    modeLabel: string,
    returnAllChunks: boolean
  ): Promise<void> {
    const opLabel = this.combineOperator.toUpperCase();
    this.setStatus(getString('search-findingMulti', { mode: modeLabel, op: opLabel }));

    // Run searches for each query in parallel
    const searchPromises = queries.map(query => {
      if (this.searchMode === 'hybrid' && this.autoAdjustWeights) {
        return this.hybridSearch.smartSearch(query, {
          finalTopK: 100,  // Get more results for combining
          minSimilarity: 0.15,  // Lower threshold, combination will filter
          mode: this.searchMode,
          returnAllChunks,
        });
      } else {
        return this.hybridSearch.search(query, {
          finalTopK: 100,
          minSimilarity: 0.15,
          mode: this.searchMode,
          returnAllChunks,
        });
      }
    });

    const allResults = await Promise.all(searchPromises);

    // Combine results using AND/OR logic
    this.rawResults = this.combineMultiQueryResults(allResults, queries);

    this.logger.info(`Multi-query search (${opLabel}): Combined ${allResults.map(r => r.length).join('+')} results into ${this.rawResults.length}`);
  }
  
  /**
   * Build status message with search result summary
   */
  private buildStatusMessage(): string {
    if (this.displayedResults.length === 0) {
      return getString('search-noItemsFound');
    }

    // Count results by source
    let bothCount = 0;
    let semanticOnlyCount = 0;
    let keywordOnlyCount = 0;

    for (const r of this.displayedResults) {
      if (r.source === 'both') bothCount++;
      else if (r.source === 'semantic') semanticOnlyCount++;
      else if (r.source === 'keyword') keywordOnlyCount++;
    }

    // Build status with granularity info
    let statusParts: string[] = [];

    if (this.granularity === 'section' && this.rawResults.length !== this.displayedResults.length) {
      statusParts.push(getString('search-foundItemsFromMatches', { count: this.displayedResults.length, matches: this.rawResults.length }));
    } else {
      statusParts.push(getString('search-foundItems', { count: this.displayedResults.length }));
    }

    if (this.searchMode === 'hybrid' && bothCount > 0) {
      statusParts.push(`(🔗 ${bothCount} · 🧠 ${semanticOnlyCount} · 🔤 ${keywordOnlyCount})`);
    }

    return statusParts.join(' ');
  }

  /**
   * Apply granularity to results
   * - 'section': Aggregate by item, keep best score per item
   * - 'location': Show all individual matches
   */
  private applyGranularity(results: HybridSearchResult[]): HybridSearchResult[] {
    if (this.granularity === 'location') {
      // Show all individual paragraph matches
      return results;
    }

    // Section mode: Aggregate by itemId, keep best match per item
    const bestByItem = new Map<number, HybridSearchResult>();

    for (const result of results) {
      const existing = bestByItem.get(result.itemId);
      if (!existing) {
        bestByItem.set(result.itemId, result);
      } else {
        // Keep the one with higher score (use rrfScore for hybrid, semanticScore for semantic)
        const existingScore = existing.rrfScore ?? existing.semanticScore ?? 0;
        const newScore = result.rrfScore ?? result.semanticScore ?? 0;
        if (newScore > existingScore) {
          bestByItem.set(result.itemId, result);
        }
      }
    }

    // Return aggregated results, maintaining original order
    const itemOrder = new Map<number, number>();
    results.forEach((r, i) => {
      if (!itemOrder.has(r.itemId)) {
        itemOrder.set(r.itemId, i);
      }
    });

    return Array.from(bestByItem.values()).sort((a, b) => {
      return (itemOrder.get(a.itemId) ?? 0) - (itemOrder.get(b.itemId) ?? 0);
    });
  }
  
  /**
   * Set the search mode
   */
  setSearchMode(mode: SearchMode): void {
    this.searchMode = mode;
    this.logger.info(`Search mode changed to: ${mode}`);

    // Save preference
    try {
      const Z = getZotero();
      if (Z && Z.Prefs) {
        Z.Prefs.set('extensions.zotero.zotseek.hybridSearch.mode', mode, true);
      }
    } catch (e) {
      this.logger.warn('Failed to save search mode preference:', e);
    }

    // Clear results and re-search if there's a query
    this.lastQuery = '';
    this.rawResults = [];
    this.displayedResults = [];
    this.setSaveCollectionButtonEnabled(false);
    this.resultsTable?.setHybridResults([]);

    // Trigger new search if there are any active queries
    if (this.getActiveQueries().length > 0) {
      this.performSearch();
    }
  }
  
  /**
   * Get current search mode
   */
  getSearchMode(): SearchMode {
    return this.searchMode;
  }

  /**
   * Set the results granularity
   */
  async setGranularity(granularity: 'section' | 'location'): Promise<void> {
    const oldGranularity = this.granularity;
    this.granularity = granularity;
    this.logger.info(`Granularity changed to: ${granularity}`);

    // Update results table display mode
    if (this.resultsTable) {
      this.resultsTable.setGranularity(granularity);
    }

    // If granularity changed and we have a query, re-search to get appropriate data
    // Location mode needs all chunks, section mode needs aggregated results
    if (oldGranularity !== granularity && this.lastQuery) {
      // Clear lastQuery to force re-search
      const query = this.lastQuery;
      this.lastQuery = '';
      this.rawResults = [];
      this.displayedResults = [];
      this.setSaveCollectionButtonEnabled(false);
      await this.performSearch();
    }
  }

  // ==================== Multi-Query Methods ====================

  /**
   * Handle query input with debouncing (shared by all query fields)
   */
  private onQueryInput(e: Event): void {
    const win = this.window;
    if (!win) return;

    // Clear existing timeout
    if (this.searchTimeout) {
      win.clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    const activeQueries = this.getActiveQueries();

    // Don't search if no queries have content
    if (activeQueries.length === 0) {
      this.setStatus('');
      this.rawResults = [];
      this.displayedResults = [];
      this.setSaveCollectionButtonEnabled(false);
      this.enrichedData.clear();
      this.resultsTable?.setResults([]);
      this.lastQuery = '';
      return;
    }

    // Check minimum query length (at least one query should meet the minimum)
    const hasValidQuery = activeQueries.some(q => q.length >= this.minQueryLength);
    if (!hasValidQuery) {
      this.setStatus(`Type at least ${this.minQueryLength} characters...`);
      return;
    }

    // Build a cache key from all queries to check if we need to re-search
    const queryCacheKey = this.buildQueryCacheKey();
    if (queryCacheKey === this.lastQuery && this.rawResults.length > 0) {
      return;
    }

    // Set status to indicate we're waiting
    this.setStatus(getString('search-searchingMoment'));

    // Set new timeout for auto-search
    this.searchTimeout = win.setTimeout(() => {
      this.performSearch();
    }, this.autoSearchDelay);
  }

  /**
   * Build a cache key from all active queries
   */
  private buildQueryCacheKey(): string {
    const queries = this.getActiveQueries();
    if (queries.length === 1) {
      return queries[0];
    }
    // Include operator in key so changing AND/OR triggers re-search
    return `${queries.join('|')}:${this.combineOperator}`;
  }

  /**
   * Get all active queries (non-empty, from visible fields)
   */
  private getActiveQueries(): string[] {
    const queries: string[] = [];
    const doc = this.window?.document;
    if (!doc) return queries;

    for (let i = 1; i <= this.queryCount; i++) {
      const input = doc.getElementById(`zotseek-query-${i}`) as HTMLInputElement;
      const value = input?.value?.trim() || '';
      if (value.length >= this.minQueryLength) {
        queries.push(value);
      }
    }

    return queries;
  }

  /**
   * Add another query field (up to maxQueries)
   */
  private addQueryField(): void {
    if (this.queryCount >= this.maxQueries) return;

    this.queryCount++;
    this.updateQueryFieldsVisibility();

    // Focus the new field
    const newInput = this.window?.document.getElementById(`zotseek-query-${this.queryCount}`) as HTMLInputElement;
    newInput?.focus();

    this.logger.info(`Added query field ${this.queryCount}`);
  }

  /**
   * Remove a query field by index (2, 3, or 4)
   * Shifts values from higher queries down to fill the gap
   */
  private removeQueryField(index?: number): void {
    if (this.queryCount <= 1) return;

    const doc = this.window?.document;
    if (!doc) return;

    // If no index specified, remove the last query
    const targetIndex = index ?? this.queryCount;

    // Shift values from queries above this one down
    // e.g., if removing query 2 of 4: query3→query2, query4→query3
    for (let i = targetIndex; i < this.queryCount; i++) {
      const currentInput = doc.getElementById(`zotseek-query-${i}`) as HTMLInputElement;
      const nextInput = doc.getElementById(`zotseek-query-${i + 1}`) as HTMLInputElement;
      if (currentInput && nextInput) {
        currentInput.value = nextInput.value;
      }
    }

    // Clear the last query field (which is now either removed or duplicated)
    const lastInput = doc.getElementById(`zotseek-query-${this.queryCount}`) as HTMLInputElement;
    if (lastInput) {
      lastInput.value = '';
    }

    this.queryCount--;
    this.updateQueryFieldsVisibility();

    // Re-search with remaining queries
    this.lastQuery = '';
    this.performSearch();

    this.logger.info(`Removed query field ${targetIndex}, now have ${this.queryCount} queries`);
  }

  /**
   * Update visibility of query fields based on queryCount
   */
  private updateQueryFieldsVisibility(): void {
    const doc = this.window?.document;
    if (!doc) return;

    const hasMultipleQueries = this.queryCount > 1;

    // Show/hide operator row
    const operatorRow = doc.getElementById('query-operator-row') as HTMLElement;
    if (operatorRow) {
      operatorRow.style.display = hasMultipleQueries ? '' : 'none';
    }

    // Show/hide query rows 2-4 based on queryCount
    for (let i = 2; i <= this.maxQueries; i++) {
      const queryRow = doc.getElementById(`query-row-${i}`) as HTMLElement;
      if (queryRow) {
        queryRow.style.display = i <= this.queryCount ? '' : 'none';
      }
    }

    // Hide add button if max queries reached
    const addBtn = doc.getElementById('zotseek-add-query-btn') as HTMLElement;
    if (addBtn) {
      addBtn.style.display = this.queryCount >= this.maxQueries ? 'none' : '';
    }

    // Update operator hint text
    this.updateOperatorHint();

    // Update formula visibility based on operator
    this.updateFormulaVisibility();
  }

  /**
   * Update the operator hint text based on current selection and query count
   */
  private updateOperatorHint(): void {
    const doc = this.window?.document;
    if (!doc) return;

    const hintLabel = doc.getElementById('query-operator-hint');
    if (hintLabel) {
      const text = this.combineOperator === 'and'
        ? getString(this.queryCount > 2 ? 'search-matchAll' : 'search-matchBoth')
        : getString('search-matchAny');
      // XUL labels use 'value' attribute - clear both to ensure clean update
      hintLabel.textContent = '';
      hintLabel.setAttribute('value', text);
    }
  }

  /**
   * Show/hide the AND formula selector based on operator
   */
  private updateFormulaVisibility(): void {
    const doc = this.window?.document;
    if (!doc) return;

    const formulaContainer = doc.getElementById('query-formula-container');
    if (formulaContainer) {
      (formulaContainer as HTMLElement).style.display =
        this.combineOperator === 'and' ? '' : 'none';
    }
  }

  /**
   * Combine results from multiple queries using AND/OR logic
   */
  private combineMultiQueryResults(
    allResults: HybridSearchResult[][],
    queries: string[]
  ): HybridSearchResult[] {
    // Build map: itemId -> scores from each query
    const itemScores = new Map<number, {
      results: (HybridSearchResult | null)[],
      scores: (number | null)[]
    }>();

    // Collect all results by itemId
    allResults.forEach((results, queryIndex) => {
      for (const result of results) {
        if (!itemScores.has(result.itemId)) {
          itemScores.set(result.itemId, {
            results: new Array(queries.length).fill(null),
            scores: new Array(queries.length).fill(null)
          });
        }
        const entry = itemScores.get(result.itemId)!;
        entry.results[queryIndex] = result;
        // Use semanticScore for combination (more meaningful than RRF for cross-query)
        entry.scores[queryIndex] = result.semanticScore ?? result.rrfScore ?? 0;
      }
    });

    // Combine scores based on operator
    const combinedResults: HybridSearchResult[] = [];
    // Apply the user's configured minimum similarity to the COMBINED score so
    // "AND" requires every sub-score to clear the bar (combined = min), and
    // "OR" requires at least one sub-score to clear the bar (combined = max).
    const minThreshold = this.userMinSimilarity;

    for (const [itemId, { results, scores }] of itemScores) {
      const validScores = scores.filter((s): s is number => s !== null);

      if (validScores.length === 0) continue;

      let combinedScore: number;
      let meetsThreshold: boolean;

      if (this.combineOperator === 'and') {
        // AND: All queries should have results
        if (validScores.length < queries.length) {
          // Item doesn't match all queries - skip for strict AND
          continue;
        }
        // Apply selected AND formula
        combinedScore = this.applyAndFormula(validScores);
        meetsThreshold = combinedScore >= minThreshold;
      } else {
        // OR: Any query match counts, use MAX score
        combinedScore = Math.max(...validScores);
        meetsThreshold = combinedScore >= minThreshold;
      }

      if (!meetsThreshold) continue;

      // Use the result from the query with the best score
      const bestIndex = scores.findIndex(s => s === Math.max(...validScores));
      const bestResult = results[bestIndex] ?? results.find(r => r !== null)!;

      // Create combined result with updated scores and per-query scores for tooltip
      combinedResults.push({
        ...bestResult,
        semanticScore: combinedScore,
        rrfScore: combinedScore,
        queryScores: scores.map(s => s ?? 0),  // Store per-query scores for tooltip
      });
    }

    // Sort by combined score descending
    combinedResults.sort((a, b) => (b.semanticScore ?? 0) - (a.semanticScore ?? 0));

    return combinedResults.slice(0, this.userTopK);
  }

  /**
   * Apply the selected AND formula to combine scores
   * - min: Minimum score (strict - paper must be good for all queries)
   * - product: Multiply scores (penalizes if any query is weak)
   * - average: Average score (balanced approach)
   */
  private applyAndFormula(scores: number[]): number {
    switch (this.andFormula) {
      case 'min':
        return Math.min(...scores);
      case 'product':
        // Product of scores, but scale back to 0-1 range
        // For 2 scores: sqrt(a*b) = geometric mean
        return Math.pow(scores.reduce((a, b) => a * b, 1), 1 / scores.length);
      case 'average':
        return scores.reduce((a, b) => a + b, 0) / scores.length;
      default:
        return Math.min(...scores);
    }
  }

  /**
   * Build status message for multi-query search
   */
  private buildMultiQueryStatusMessage(queries: string[]): string {
    if (this.displayedResults.length === 0) {
      if (this.combineOperator === 'and') {
        return getString('search-noItemsMatchingAll');
      }
      return getString('search-noItemsFound');
    }

    const opLabel = this.combineOperator.toUpperCase();
    const truncatedQueries = queries.map(q =>
      q.length > 20 ? q.substring(0, 20) + '...' : q
    );

    // Build query expression with formula indicator for AND
    let queryExpr = truncatedQueries.join(` ${opLabel} `);
    if (this.combineOperator === 'and') {
      const formulaLabels: Record<string, string> = {
        min: 'min',
        product: 'prod',
        average: 'avg'
      };
      queryExpr += ` [${formulaLabels[this.andFormula]}]`;
    }

    let msg = getString('search-foundItemsQuery', { count: this.displayedResults.length, query: queryExpr });

    // Add source breakdown for hybrid mode
    if (this.searchMode === 'hybrid') {
      let bothCount = 0, semanticCount = 0, keywordCount = 0;
      for (const r of this.displayedResults) {
        if (r.source === 'both') bothCount++;
        else if (r.source === 'semantic') semanticCount++;
        else keywordCount++;
      }
      if (bothCount > 0) {
        msg += ` (🔗 ${bothCount} · 🧠 ${semanticCount} · 🔤 ${keywordCount})`;
      }
    }

    return msg;
  }

  /**
   * Handle selection change in table
   */
  private onSelectionChange(indices: number[]): void {
    this.setOpenButtonEnabled(indices.length > 0);

    // Don't update status with selection - the table highlight is enough
  }

  /**
   * Handle double-click / Enter on row
   */
  private onActivate(index: number): void {
    const result = this.resultsTable?.getResultAt(index);
    if (result) {
      const localId = result.itemId;
      if (localId === undefined) {
        const orphanKey = (result as SearchResult).itemKey ?? '?';
        const orphanLib = (result as SearchResult).libraryKey ?? '?';
        this.logger.warn(`Cannot open orphan result (${orphanLib}, ${orphanKey})`);
        this.setStatus('Item is not in your local Zotero library');
        return;
      }
      // Get page number (exact from Find Pages, or estimated from index)
      const exactPage = this.resultsTable?.getExactPage(localId);
      const hybridResult = result as HybridSearchResult;
      const pageNumber = exactPage || hybridResult.pageNumber;

      this.openItem(localId, pageNumber);
    }
  }

  /**
   * Open the selected item(s)
   * If multiple items are selected, selects them all in Zotero library
   * If single item, opens/navigates to it (with page if available)
   */
  private openSelected(): void {
    const results = this.resultsTable?.getSelectedResults() || [];

    if (results.length === 0) return;

    if (results.length === 1) {
      // Single selection: open with page navigation
      const result = results[0];
      const localId = result.itemId;
      if (localId === undefined) {
        const orphanKey = (result as SearchResult).itemKey ?? '?';
        const orphanLib = (result as SearchResult).libraryKey ?? '?';
        this.logger.warn(`Cannot open orphan result (${orphanLib}, ${orphanKey})`);
        this.setStatus('Item is not in your local Zotero library');
        return;
      }
      const exactPage = this.resultsTable?.getExactPage(localId);
      const hybridResult = result as HybridSearchResult;
      const pageNumber = exactPage || hybridResult.pageNumber;
      this.openItem(localId, pageNumber);
    } else {
      // Multiple selection: select all in Zotero library (skip orphans)
      const itemIds = results
        .map(r => r.itemId)
        .filter((id): id is number => id !== undefined);
      // Deduplicate in case same paper appears multiple times (different chunks)
      const uniqueIds = [...new Set(itemIds)];
      const orphanCount = results.length - itemIds.length;
      this.zoteroAPI.selectItems(uniqueIds);
      const orphanNote = orphanCount > 0 ? ` (${orphanCount} not in local library)` : '';
      this.setStatus(`Selected ${uniqueIds.length} items in library${orphanNote}`);
    }
  }

  /**
   * Open an item in Zotero, optionally to a specific page
   */
  private async openItem(itemId: number, pageNumber?: number): Promise<void> {
    try {
      // Select the item in the library
      this.zoteroAPI.selectItem(itemId);

      // If we have a page number, open PDF to that page
      if (pageNumber) {
        await this.zoteroAPI.openPDFToPage(itemId, pageNumber);
        this.logger.info(`Opened item ${itemId} to page ${pageNumber}`);
      }

      // Keep dialog open so user can browse more results
    } catch (error) {
      this.logger.error('Failed to open item:', error);
      this.setStatus('Failed to open item in Zotero');
    }
  }

  /**
   * Update status text
   */
  private setStatus(message: string): void {
    const statusEl = this.window?.document.getElementById('zotseek-status-text');
    if (statusEl) {
      statusEl.textContent = message;
    }
  }

  /**
   * Show context menu for selected items
   */
  private showContextMenu(event: MouseEvent, indices: number[]): void {
    this.logger.info(`Context menu triggered with ${indices.length} indices: ${indices.join(', ')}`);

    if (!this.window || indices.length === 0) return;

    const doc = this.window.document;
    const results = indices.map(i => this.resultsTable?.getResultAt(i)).filter(Boolean);
    if (results.length === 0) return;

    // Get unique item IDs (same paper might appear multiple times as different chunks).
    // Filter out orphan results that have no resolved local itemId.
    const itemIds = [
      ...new Set(
        results
          .map(r => r!.itemId)
          .filter((id): id is number => id !== undefined)
      ),
    ];
    const itemCount = itemIds.length;
    if (itemCount === 0) {
      this.logger.warn('Context menu skipped: all selected results are orphans (not in local library)');
      return;
    }

    // Create popup menu
    const popup = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menupopup');
    popup.id = 'zotseek-context-menu';

    // "Show in Library" option
    const showInLibrary = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menuitem');
    showInLibrary.setAttribute('label', itemCount === 1 ? getString('search-showInLibrary') : getString('search-showItemsInLibrary', { count: itemCount }));
    showInLibrary.addEventListener('command', () => {
      if (itemCount === 1) {
        this.zoteroAPI.selectItem(itemIds[0]);
      } else {
        this.zoteroAPI.selectItems(itemIds);
      }
      this.setStatus(`Selected ${itemCount} item${itemCount > 1 ? 's' : ''} in library`);
    });
    popup.appendChild(showInLibrary);

    // Separator
    const sep1 = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menuseparator');
    popup.appendChild(sep1);

    // "Add to Collection" submenu
    const addToCollection = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menu');
    addToCollection.setAttribute('label', getString('search-addToCollection'));
    const collectionPopup = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menupopup');

    // "New collection..." entry (opens the export dialog with the selected items)
    const newCollectionItem = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menuitem');
    newCollectionItem.setAttribute('data-l10n-id', 'zotseek-export-addToCollectionNew');
    newCollectionItem.addEventListener('command', async () => {
      await this.saveItemsAsNewCollection(itemIds, this.suggestedNameForQuery());
    });
    collectionPopup.appendChild(newCollectionItem);

    // Separator between "New collection..." and the existing-collections list.
    const sep = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menuseparator');
    collectionPopup.appendChild(sep);

    // Existing collections (fills the rest of the submenu)
    this.populateCollectionMenu(collectionPopup, itemIds);
    addToCollection.appendChild(collectionPopup);
    popup.appendChild(addToCollection);

    // Add popup to document and show it
    doc.documentElement.appendChild(popup);
    (popup as any).openPopupAtScreen(event.screenX, event.screenY, true);

    // Clean up popup after it closes
    popup.addEventListener('popuphidden', () => {
      popup.remove();
    });
  }

  /**
   * Populate collection submenu with available collections
   */
  private populateCollectionMenu(popup: Element, itemIds: number[]): void {
    const doc = this.window?.document;
    if (!doc) return;
    sharedPopulateCollectionMenu({
      popup,
      items: itemIds,
      doc,
      logger: this.logger,
      onPickCollection: (collectionID) => this.addItemsToCollection(itemIds, collectionID),
    });
  }

  /**
   * Add items to a collection
   */
  private async addItemsToCollection(itemIds: number[], collectionId: number): Promise<void> {
    try {
      const { collectionName, addedCount } = await sharedAddItemsToCollection({
        items: itemIds,
        collectionID: collectionId,
        logger: this.logger,
      });
      this.setStatus(`Added ${addedCount} item${addedCount > 1 ? 's' : ''} to "${collectionName}"`);
    } catch (error: any) {
      const errorMsg = error?.message || error?.toString() || 'Unknown error';
      this.logger.error(`Failed to add items to collection: ${errorMsg}`);
      if (error?.stack) {
        Zotero.debug(`[ZotSeek] Stack: ${error.stack}`);
      }
      this.setStatus('Failed to add items to collection');
    }
  }

  /**
   * Compose a suggested collection name based on the current query and date.
   * Truncates long queries to 60 chars.
   */
  private suggestedNameForQuery(): string {
    const date = new Date().toISOString().slice(0, 10);
    const rawQuery = (this.lastQuery || '').trim();
    const MAX = 60;
    const truncQuery = rawQuery.length > MAX ? rawQuery.slice(0, MAX - 1) + '…' : rawQuery;
    if (truncQuery.length === 0) {
      return `ZotSeek results · ${date}`;
    }
    return `ZotSeek: “${truncQuery}” · ${date}`;
  }

  /**
   * Invoke the export dialog for the given item IDs and show a status summary.
   * Used by both the submenu "New collection..." entry and the footer button.
   */
  private async saveItemsAsNewCollection(itemIds: number[], suggestedName: string): Promise<void> {
    if (!this.window || itemIds.length === 0) return;
    try {
      const summary = await exportItemsToNewCollection({
        items: itemIds,
        suggestedName,
        window: this.window,
        logger: this.logger,
      });
      if (summary === null) return; // user canceled
      const base = getString('export-statusExported',
        { count: summary.addedCount, name: summary.collectionName });
      const full = summary.skippedCount > 0
        ? getString('export-statusExportedSkipped',
            { count: summary.addedCount, name: summary.collectionName, skipped: summary.skippedCount })
        : base;
      this.setStatus(full);
    } catch (error: any) {
      const msg = error?.message || error?.toString() || 'Unknown error';
      this.logger.error(`Export to collection failed: ${msg}`);
      if (error?.stack) Zotero.debug(`[ZotSeek] Stack: ${error.stack}`);
      this.setStatus(getString('export-statusFailed'));
    }
  }

  /**
   * Footer button: export the full result set (deduped to unique items)
   * to a new collection.
   */
  private async saveAllResultsAsCollection(): Promise<void> {
    if (!this.resultsTable) return;
    // resultsTable.getResultItemIds() does NOT dedupe; in location-granularity
    // mode each row is a separate chunk with the same itemId. Dedupe here.
    const itemIds = [...new Set(this.resultsTable.getResultItemIds())];
    if (itemIds.length === 0) return;
    await this.saveItemsAsNewCollection(itemIds, this.suggestedNameForQuery());
  }

  /**
   * Enable/disable open button
   */
  private setOpenButtonEnabled(enabled: boolean): void {
    const btn = this.window?.document.getElementById('zotseek-open-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = !enabled;
    }
  }

  /**
   * Enable/disable the Save Results as Collection button.
   */
  private setSaveCollectionButtonEnabled(enabled: boolean): void {
    const btn = this.window?.document.getElementById('zotseek-save-collection-btn') as HTMLButtonElement;
    if (btn) btn.disabled = !enabled;
  }

  /**
   * Enable/disable find pages button
   */
  private setFindPagesEnabled(enabled: boolean): void {
    const btn = this.window?.document.getElementById('zotseek-find-pages-btn') as HTMLButtonElement;
    if (btn) {
      btn.disabled = !enabled;
    }
  }

  /**
   * Find exact PDF page numbers for all search results
   * Uses PDFWorker to search each PDF page-by-page
   */
  private async findExactPages(): Promise<void> {
    if (!this.resultsTable || this.displayedResults.length === 0) return;

    const findPagesBtn = this.window?.document.getElementById('zotseek-find-pages-btn') as HTMLButtonElement;
    if (findPagesBtn) {
      findPagesBtn.disabled = true;
      findPagesBtn.textContent = 'Finding...';
    }

    try {
      const itemIds = this.resultsTable.getResultItemIds();
      const foundPages = new Map<number, number>();
      let processed = 0;
      let found = 0;

      this.setStatus(`Finding page locations (0/${itemIds.length})...`);

      for (const itemId of itemIds) {
        processed++;

        // Get search text (title) for this item
        const searchText = this.resultsTable.getSearchTextForItem(itemId);
        if (!searchText) continue;

        // Find exact page using PDFWorker
        try {
          const page = await this.zoteroAPI.findExactPage(itemId, searchText);
          if (page !== null) {
            foundPages.set(itemId, page);
            found++;
          }
        } catch (error) {
          this.logger.warn(`Failed to find page for item ${itemId}:`, error);
        }

        // Update status periodically
        if (processed % 3 === 0 || processed === itemIds.length) {
          this.setStatus(`Finding page locations (${processed}/${itemIds.length})...`);
        }
      }

      // Update the table with found pages
      await this.resultsTable.updateExactPages(foundPages);

      // Show completion status
      this.setStatus(`Found ${found}/${processed} page locations`);
      this.logger.info(`Found exact pages for ${found}/${processed} items`);

    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Failed to find pages: ${message}`);
      this.logger.error('Find pages failed:', error);
    } finally {
      if (findPagesBtn) {
        findPagesBtn.disabled = false;
        findPagesBtn.textContent = 'Find Pages';
      }
    }
  }

  /**
   * Close the dialog
   */
  private close(): void {
    this.window?.close();
  }

  /**
   * Open ZotSeek preferences pane
   */
  private openSettings(): void {
    try {
      const Z = getZotero();
      const mainWindow = Z?.getMainWindow();
      if (mainWindow) {
        // Open Zotero preferences dialog
        const prefsWin = mainWindow.openDialog(
          'chrome://zotero/content/preferences/preferences.xhtml',
          'zotero-prefs',
          'chrome,titlebar,toolbar,centerscreen'
        );

        // After preferences window opens, navigate to ZotSeek pane
        prefsWin.addEventListener('load', () => {
          setTimeout(() => {
            const zotseekPane = prefsWin.document.querySelector('richlistitem[value$="zotseek@zotero.org"]') as HTMLElement;
            if (zotseekPane) {
              zotseekPane.click();
            }
          }, 100);
        });
      }
    } catch (error) {
      this.logger.error('Failed to open settings:', error);
    }
  }

  /**
   * Cleanup (called from XHTML onunload)
   */
  cleanup(): void {
    // Clear any pending search timeout
    if (this.searchTimeout && this.window) {
      this.window.clearTimeout(this.searchTimeout);
      this.searchTimeout = null;
    }

    this.resultsTable?.destroy();
    this.resultsTable = null;
    this.rawResults = [];
    this.displayedResults = [];
    this.setSaveCollectionButtonEnabled(false);
    this.enrichedData.clear();
    this.window = null;
    this.lastQuery = '';
    this.excludeItemId = undefined;  // Reset excluded item
    this.queryCount = 1;  // Reset to single query mode
    this.combineOperator = 'and';  // Reset operator
    this.andFormula = 'min';  // Reset formula
    this.logger.info('Search dialog cleaned up');
  }
}

// Export singleton for XHTML binding
export const zotseekDialogVTable = new ZotSeekDialogVTable();

// Set up for standalone dialog bundle - like BetterNotes does
// (Zotero is already declared at the top of the file)

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  try {
    await zotseekDialogVTable.init(window);
  } catch (error) {
    console.error('Failed to initialize dialog:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

// Cleanup on window unload
window.addEventListener("unload", () => {
  zotseekDialogVTable.cleanup();
});
