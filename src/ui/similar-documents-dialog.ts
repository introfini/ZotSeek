/**
 * Similar Documents Dialog with VirtualizedTableHelper
 * 
 * Shows documents similar to the selected item in a native Zotero table
 */

import { SearchResultsTable } from './results-table';
import { searchEngine, SearchResult } from '../core/search-engine';
import { ZoteroAPI } from '../utils/zotero-api';
import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';
import { getString, translateDOM } from '../utils/locale';

class SimilarDocumentsDialog {
  private logger: Logger;
  private resultsTable: SearchResultsTable | null = null;
  private results: SearchResult[] = [];
  private enrichedData: Map<number, any> = new Map();
  private sourceItem: any = null;

  constructor() {
    this.logger = new Logger('SimilarDocumentsDialog');
  }

  /**
   * Initialize the dialog
   */
  async init(win: Window): Promise<void> {
    this.logger.info('Initializing similar documents dialog');

    // Translate UI strings
    translateDOM(win.document);

    try {
      // Get the source item from window arguments
      const windowArgs = (win as any).arguments?.[0];
      if (windowArgs?.sourceItem) {
        this.sourceItem = windowArgs.sourceItem;
        this.logger.debug('Source item:', this.sourceItem.id, this.sourceItem.getField('title'));
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
      if (this.sourceItem) {
        await this.findSimilarDocuments();
      }

    } catch (error) {
      this.logger.error('Failed to initialize dialog:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setStatus(getString('similar.initFailed', { error: errorMessage }), 'error');
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
    if (!this.sourceItem) {
      this.setStatus(getString('similar.noSource'), 'error');
      return;
    }

    try {
      this.setStatus(getString('similar.finding'), 'loading');

      // Make sure we have Zotero available
      const Z = getZotero();
      if (!Z) {
        throw new Error('Zotero not available');
      }

      // Initialize search engine if needed
      this.logger.debug('Checking if search engine is initialized...');
      try {
        const isInitialized = searchEngine && searchEngine.isInitialized && searchEngine.isInitialized();
        this.logger.debug('Search engine initialized status:', isInitialized);
        
        if (!isInitialized) {
          this.logger.debug('Search engine not initialized, initializing...');
          this.setStatus(getString('similar.loadingModel'), 'loading');
          await searchEngine.init();
          this.logger.debug('Search engine initialized');
        } else {
          this.logger.debug('Search engine already initialized');
        }
      } catch (initError) {
        this.logger.error('Error checking/initializing search engine:', initError);
        // Try to initialize anyway
        this.logger.debug('Attempting to initialize search engine...');
        this.setStatus('Loading AI model...', 'loading');
        await searchEngine.init();
        this.logger.debug('Search engine initialized after error');
      }

      // Get source document title
      const sourceTitle = this.sourceItem.getField('title');
      this.setSourceInfo(sourceTitle);

      // Find similar documents
      this.setStatus(getString('similar.searching'), 'loading');
      
      // Get the numeric item ID
      const itemId = this.sourceItem.id;
      this.logger.debug('Source item ID:', itemId, 'Type:', typeof itemId);
      
      // Convert to number if needed
      const numericId = typeof itemId === 'number' ? itemId : parseInt(itemId, 10);
      if (isNaN(numericId)) {
        throw new Error(`Invalid item ID: ${itemId}`);
      }
      
      const results = await searchEngine.findSimilar(numericId, {
        topK: 20,
        excludeSelf: true,
      });

      if (results.length === 0) {
        this.setStatus(getString('similar.noResults'), 'info');
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
      this.setStatus(getString('similar.found', { count: results.length }), 'success');
      
      // Enable open button if we have results
      this.setOpenButtonEnabled(true);

      // Select first result
      this.resultsTable?.selectIndex(0);

    } catch (error) {
      this.logger.error('Search failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      this.setStatus(getString('similar.searchFailed', { error: errorMessage }), 'error');
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
      try {
        const item = await Z.Items.getAsync(result.itemId);
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
          this.logger.debug(`Item ${result.itemId} has ${creators.length} creators`);
          
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
              this.logger.debug(`No creators for item ${result.itemId}`);
            }
          }

          this.logger.debug(`Item ${result.itemId} authors: ${enriched.authors.join(', ')}`);
          this.enrichedData.set(result.itemId, enriched);
          
          // Also update the result object
          result.authors = enriched.authors;
          result.year = enriched.year;
        }
      } catch (e) {
        this.logger.warn(`Failed to get metadata for item ${result.itemId}:`, e);
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
      const index = this.results.indexOf(selected);
      if (index >= 0) {
        this.openItem(index);
      }
    }
  }

  /**
   * Open a specific item
   */
  private openItem(index: number): void {
    if (index < 0 || index >= this.results.length) return;
    
    const result = this.results[index];
    const Z = getZotero();
    if (!Z) return;

    try {
      // Select the item in the library
      const zp = Z.getActiveZoteroPane();
      if (zp && zp.selectItem) {
        zp.selectItem(result.itemId);
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
      statusText.setAttribute('value', getString('similar.similarTo') + truncatedTitle);
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
    this.sourceItem = null;
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
  } catch (error) {
    console.error('Failed to initialize similar documents dialog:', error);
    if (error instanceof Error) {
      console.error('Stack:', error.stack);
    }
  }
}

// Cleanup on window unload
window.addEventListener("unload", () => {
  similarDocumentsDialog.cleanup();
});
