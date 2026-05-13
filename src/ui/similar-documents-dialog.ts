/**
 * Similar Documents Dialog with VirtualizedTableHelper
 * 
 * Shows documents similar to the selected item in a native Zotero table
 */

import { SearchResultsTable } from './results-table';
import { searchEngine, SearchResult } from '../core/search-engine';
import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';
import { getString } from '../utils/locale';
import { exportItemsToNewCollection } from './collection-export';

class SimilarDocumentsDialog {
  private logger: Logger;
  private resultsTable: SearchResultsTable | null = null;
  private results: SearchResult[] = [];
  private enrichedData: Map<number, any> = new Map();
  private sourceItemId: number | null = null;
  private sourceTitle: string | null = null;

  constructor() {
    this.logger = new Logger('SimilarDocumentsDialog');
  }

  /**
   * Initialize the dialog
   */
  async init(win: Window): Promise<void> {
    this.logger.info('Initializing similar documents dialog');

    // Register FTL for localization
    (win as any).MozXULElement?.insertFTLIfNeeded('zotseek.ftl');

    try {
      // Get the source item ID from window arguments (primitives only, no live objects)
      let windowArgs = (win as any).arguments?.[0];
      // Unwrap XPConnect compartment wrapper if needed (Better Notes pattern)
      if (windowArgs && !windowArgs.sourceItemId && windowArgs.wrappedJSObject) {
        windowArgs = windowArgs.wrappedJSObject;
      }
      if (windowArgs?.sourceItemId) {
        this.sourceItemId = typeof windowArgs.sourceItemId === 'number'
          ? windowArgs.sourceItemId
          : parseInt(windowArgs.sourceItemId, 10);
        this.sourceTitle = windowArgs.sourceTitle || null;
        this.logger.debug('Source item ID:', this.sourceItemId, 'Title:', this.sourceTitle);
      }

      // Initialize the results table
      this.resultsTable = new SearchResultsTable({
        containerId: 'similar-documents-results-container',
        onSelectionChange: (indices) => this.onSelectionChange(indices),
        onActivate: (index) => this.onActivate(index),
      });

      await this.resultsTable.init(win);
      this.logger.debug('Results table initialized');

      // Set up event handlers
      this.setupEventHandlers(win);

      // Automatically search for similar documents
      if (this.sourceItemId) {
        await this.findSimilarDocuments();
      }

    } catch (error) {
      this.logger.error('Failed to initialize dialog:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setStatus(getString('similar-initFailed', { error: errorMessage }), 'error');
      // Log the full error for debugging
      if (error instanceof Error && error.stack) {
        this.logger.error('Error stack:', error.stack);
      }
    }
  }

  /**
   * Set up event handlers
   */
  private setupEventHandlers(win: Window): void {
    const doc = win.document;

    // Open button
    const openBtn = doc.getElementById('similar-documents-open-btn');
    openBtn?.addEventListener('command', () => this.openSelected());

    const saveCollectionBtn = doc.getElementById('similar-documents-save-collection-btn');
    saveCollectionBtn?.addEventListener('command', () => this.saveResultsAsCollection());

    // Close button
    const closeBtn = doc.getElementById('similar-documents-close-btn');
    closeBtn?.addEventListener('command', () => this.close());

    // Keyboard shortcuts
    doc.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        this.close();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        this.openSelected();
      }
    });
  }

  /**
   * Find similar documents to the source item
   */
  private async findSimilarDocuments(): Promise<void> {
    if (!this.sourceItemId) {
      this.setStatus(getString('similar-noSource'), 'error');
      return;
    }

    try {
      this.setStatus(getString('similar-finding'), 'loading');

      // Make sure we have Zotero available
      const Z = getZotero();
      if (!Z) {
        throw new Error('Zotero not available');
      }

      // Initialize search engine if needed
      if (searchEngine && !searchEngine.isReady()) {
        this.logger.debug('Search engine not ready, initializing...');
        this.setStatus(getString('similar-loadingModel'), 'loading');
        await searchEngine.init();
        this.logger.debug('Search engine initialized');
      }

      // Set source document title (passed as primitive, no cross-window access needed)
      if (this.sourceTitle) {
        this.setSourceInfo(this.sourceTitle);
      } else {
        // Fallback: fetch title from Zotero if not passed
        try {
          const sourceItem = await Z.Items.getAsync(this.sourceItemId);
          if (sourceItem) {
            const fetchedTitle: string = sourceItem.getField('title') || '';
            this.sourceTitle = fetchedTitle;
            this.setSourceInfo(fetchedTitle);
          }
        } catch (e) {
          this.logger.warn('Could not fetch source item title:', e);
        }
      }

      // Find similar documents
      this.setStatus(getString('similar-searching'), 'loading');
      this.logger.debug('Source item ID:', this.sourceItemId);

      // Read result-limit preferences (set from the preferences pane)
      const topKPref = Z?.Prefs?.get('zotseek.topK', true);
      const minSimPref = Z?.Prefs?.get('zotseek.minSimilarityPercent', true);
      const topK = (typeof topKPref === 'number' && topKPref > 0) ? Math.floor(topKPref) : 20;
      const minSimilarity = (typeof minSimPref === 'number' && minSimPref >= 0 && minSimPref <= 100)
        ? minSimPref / 100
        : 0.3;

      // findSimilar always excludes the source item from results internally,
      // so no excludeSelf flag is needed.
      const results = await searchEngine.findSimilar(this.sourceItemId, {
        topK,
        minSimilarity,
      });

      if (results.length === 0) {
        this.setStatus(getString('similar-noResults'), 'info');
        this.results = [];
        await this.resultsTable?.setResults([]);
        return;
      }

      // Store results
      this.results = results;

      // Enrich results with Zotero metadata
      await this.enrichResults();

      // Update table
      await this.resultsTable?.setResults(this.results, this.enrichedData);

      // Update status
      this.setStatus(getString('similar-found', { count: results.length }), 'success');
      
      // Enable open button if we have results
      this.setOpenButtonEnabled(true);
      this.setSaveCollectionButtonEnabled(true);

      // Select first result
      this.resultsTable?.selectIndex(0);

    } catch (error) {
      this.logger.error('Search failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setStatus(getString('similar-searchFailed', { error: errorMessage }), 'error');
      // Log the full error for debugging
      if (error instanceof Error && error.stack) {
        this.logger.error('Error stack:', error.stack);
      }
    }
  }

  /**
   * Enrich search results with Zotero metadata
   */
  private async enrichResults(): Promise<void> {
    const Z = getZotero();
    if (!Z) return;

    this.enrichedData.clear();
    
    for (const result of this.results) {
      const localId = result.itemId;
      if (localId === undefined) {
        // Orphan: item not in current Zotero library, skip enrichment.
        this.logger.debug(`Skipping enrichment for orphan result (${result.libraryKey}, ${result.itemKey})`);
        continue;
      }
      try {
        const item = await Z.Items.getAsync(localId);
        if (item) {
          const enriched: any = {
            title: item.getField('title') || result.title || 'Untitled',
            authors: [],
            year: undefined,
          };

          // Get year from date field
          const dateStr = item.getField('date');
          if (dateStr) {
            const yearMatch = dateStr.match(/\d{4}/);
            if (yearMatch) {
              enriched.year = parseInt(yearMatch[0]);
            }
          }

          // Get authors
          const creators = item.getCreators();
          this.logger.debug(`Item ${localId} has ${creators.length} creators`);

          enriched.authors = creators
            .filter((c: any) => c.creatorType === 'author' || c.creatorType === 1)
            .map((c: any) => {
              if (c.lastName && c.firstName) {
                return `${c.lastName}, ${c.firstName.charAt(0)}.`;
              } else if (c.lastName) {
                return c.lastName;
              } else if (c.name) {
                return c.name;
              } else {
                return '';
              }
            })
            .filter((name: string) => name);

          // Fallback for authors
          if (enriched.authors.length === 0) {
            try {
              const firstCreator = item.getCreator(0);
              if (firstCreator && firstCreator.lastName) {
                const name = firstCreator.firstName
                  ? `${firstCreator.lastName}, ${firstCreator.firstName.charAt(0)}.`
                  : firstCreator.lastName;
                enriched.authors = [name];
              }
            } catch (e) {
              this.logger.debug(`No creators for item ${localId}`);
            }
          }

          this.logger.debug(`Item ${localId} authors: ${enriched.authors.join(', ')}`);
          this.enrichedData.set(localId, enriched);

          // Also update the result object
          result.authors = enriched.authors;
          result.year = enriched.year;
        }
      } catch (e) {
        this.logger.warn(`Failed to get metadata for item ${localId}:`, e);
      }
    }

    // Re-render table with enriched data
    await this.resultsTable?.render();
  }

  /**
   * Handle selection change
   */
  private onSelectionChange(indices: number[]): void {
    this.setOpenButtonEnabled(indices.length > 0);
  }

  /**
   * Handle double-click/enter on row
   */
  private onActivate(index: number): void {
    this.openItem(index);
  }

  /**
   * Open selected documents
   */
  private openSelected(): void {
    const selected = this.resultsTable?.getSelectedResult();
    if (selected) {
      // The results table stores AnySearchResult; this dialog only ever puts
      // SearchResult instances into it, so the cast is safe.
      const index = this.results.indexOf(selected as SearchResult);
      if (index >= 0) {
        this.openItem(index);
      }
    }
  }

  /**
   * Footer button: export the full results set (deduped) to a new collection.
   */
  private async saveResultsAsCollection(): Promise<void> {
    if (!this.resultsTable || this.results.length === 0) return;
    // Dedupe: getResultItemIds() returns one entry per row, not per item.
    const itemIds = [...new Set(this.resultsTable.getResultItemIds())];
    if (itemIds.length === 0) return;

    const date = new Date().toISOString().slice(0, 10);
    const MAX = 60;
    const rawTitle = (this.sourceTitle || '').trim();
    const truncTitle = rawTitle.length > MAX ? rawTitle.slice(0, MAX - 1) + '…' : rawTitle;
    const suggestedName = truncTitle.length > 0
      ? `ZotSeek: similar to “${truncTitle}” · ${date}`
      : `ZotSeek similar results · ${date}`;

    try {
      const summary = await exportItemsToNewCollection({
        items: itemIds,
        suggestedName,
        window,
        logger: this.logger,
      });
      if (summary === null) return;
      const base = getString('export-statusExported',
        { count: summary.addedCount, name: summary.collectionName });
      const full = summary.skippedCount > 0
        ? getString('export-statusExportedSkipped',
            { count: summary.addedCount, name: summary.collectionName, skipped: summary.skippedCount })
        : base;
      this.setStatus(full, 'success');
    } catch (error: any) {
      const msg = error?.message || error?.toString() || 'Unknown error';
      this.logger.error(`Export to collection failed: ${msg}`);
      if (error?.stack) this.logger.error('Error stack:', error.stack);
      this.setStatus(getString('export-statusFailed'), 'error');
    }
  }

  /**
   * Open a specific item
   */
  private openItem(index: number): void {
    if (index < 0 || index >= this.results.length) return;

    const result = this.results[index];
    const localId = result.itemId;
    if (localId === undefined) {
      this.logger.warn(`Cannot open orphan result (${result.libraryKey}, ${result.itemKey})`);
      this.setStatus('Item is not in your local Zotero library', 'error');
      return;
    }
    const Z = getZotero();
    if (!Z) return;

    try {
      // Select the item in the library
      const zp = Z.getActiveZoteroPane();
      if (zp && zp.selectItem) {
        zp.selectItem(localId);
        this.logger.info(`Opened item: ${result.title}`);
        
        // Close dialog after opening
        this.close();
      }
    } catch (error) {
      this.logger.error('Failed to open item:', error);
    }
  }

  /**
   * Set the source document info
   */
  private setSourceInfo(title: string): void {
    const statusText = window.document.getElementById('similar-documents-source-text');
    if (statusText) {
      const truncatedTitle = title.length > 80 ? title.substring(0, 77) + '...' : title;
      statusText.setAttribute('value', getString('similar-similarTo') + truncatedTitle);
    }
  }

  /**
   * Set status message
   */
  private setStatus(message: string, type: 'info' | 'loading' | 'success' | 'error' = 'info'): void {
    const statusText = window.document.getElementById('similar-documents-status-text');
    if (statusText) {
      statusText.setAttribute('value', message);
      
      // Set color based on type
      const color = {
        info: '#666',
        loading: '#1976d2',
        success: '#4caf50',
        error: '#f44336',
      }[type];
      statusText.style.color = color;
    }
  }

  /**
   * Enable/disable open button
   */
  private setOpenButtonEnabled(enabled: boolean): void {
    const openBtn = window.document.getElementById('similar-documents-open-btn');
    if (openBtn) {
      if (enabled) {
        openBtn.removeAttribute('disabled');
      } else {
        openBtn.setAttribute('disabled', 'true');
      }
    }
  }

  /**
   * Enable/disable the Save Results as Collection button.
   */
  private setSaveCollectionButtonEnabled(enabled: boolean): void {
    const btn = window.document.getElementById('similar-documents-save-collection-btn');
    if (!btn) return;
    if (enabled) btn.removeAttribute('disabled');
    else btn.setAttribute('disabled', 'true');
  }

  /**
   * Close the dialog
   */
  private close(): void {
    // Close the current dialog window, not the main window
    if (window && window.close) {
      window.close();
    }
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.resultsTable?.destroy();
    this.resultsTable = null;
    this.results = [];
    this.enrichedData.clear();
    this.sourceItemId = null;
    this.sourceTitle = null;
    this.logger.debug('Dialog cleaned up');
  }
}

// Create singleton instance
export const similarDocumentsDialog = new SimilarDocumentsDialog();

// Set up for standalone dialog bundle
declare const Zotero: any;

// Initialize when DOM is ready
document.addEventListener("DOMContentLoaded", () => {
  init();
});

async function init() {
  try {
    await similarDocumentsDialog.init(window);
  } catch (error: any) {
    const message = error?.message || error?.toString() || 'Unknown error';
    const stack = error?.stack || '';
    Zotero.debug(`[ZotSeek] Failed to initialize similar documents dialog: ${message}`);
    if (stack) Zotero.debug(`[ZotSeek] Stack: ${stack}`);
  }
}

// Cleanup on window unload
window.addEventListener("unload", () => {
  similarDocumentsDialog.cleanup();
});
