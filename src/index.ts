/**
 * ZotSeek - Semantic Search for Zotero
 *
 * Main entry point for the plugin.
 */

// Access Zotero through the global context set by bootstrap
declare const _globalThis: any;
declare const Zotero: any;
declare const ChromeUtils: any;
declare const Components: any;
declare const Services: any;  // Zotero 8 global Services object

// Import core modules
import { PaperEmbedding, getVectorStore, IVectorStore } from './core/storage-factory';
import { embeddingPipeline, EmbeddingProgress } from './core/embedding-pipeline';
import { searchEngine, SearchResult } from './core/search-engine';
import { textExtractor, ExtractedText, ExtractedChunks } from './core/text-extractor';
import { ZoteroAPI } from './utils/zotero-api';
import { getIndexingMode } from './utils/chunker';
import { getZotero } from './utils/zotero-helper';
import { autoIndexManager } from './core/auto-index-manager';
// Use stable progress window from toolkit to avoid crashes
import { StableProgressWindow, showQuickNotification } from './utils/stable-progress';
// UI components
import { searchDialog } from './ui/search-dialog';
import { searchDialogWithVTable } from './ui/search-dialog-with-vtable';
import { similarDocumentsWrapper } from './ui/similar-documents-wrapper';
import { toolbarButton } from './ui/toolbar-button';
import { preferencesManager } from './ui/preferences';

interface PluginInfo {
  id: string;
  version: string;
  rootURI: string;
}

/**
 * Simple logger - only uses Zotero.debug (no console)
 */
class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = `[${prefix}]`;
  }

  private log(level: string, ...args: any[]): void {
    const msg = `${this.prefix} [${level}] ${args.join(' ')}`;
    const Z = getZotero();
    if (Z && Z.debug) {
      Z.debug(msg);
    }
  }

  info(...args: any[]): void {
    this.log('INFO', ...args);
  }

  warn(...args: any[]): void {
    this.log('WARN', ...args);
  }

  error(...args: any[]): void {
    this.log('ERROR', ...args);
  }

  debug(...args: any[]): void {
    this.log('DEBUG', ...args);
  }
}

/**
 * Check if an item has the exclusion tag (module-level to avoid prototype issues)
 */
function hasExcludeTag(item: any): boolean {
  // Use Zotero global directly (not getZotero()) to avoid IIFE scope issues
  try {
    const excludeTag = Zotero.Prefs.get('zotseek.excludeTag', true);
    if (!excludeTag) return false;
    return item.getTags?.()?.some((t: any) => t.tag === excludeTag) ?? false;
  } catch {
    return false;
  }
}

/**
 * Main plugin class
 */
class ZotSeekPlugin {
  private info: PluginInfo | null = null;
  private logger: Logger;
  private zoteroAPI: ZoteroAPI;
  public vectorStore: IVectorStore | null = null;  // Public for preference pane access
  private initialized = false;
  private indexing = false;
  private cleanupNotifierID: string | null = null;

  // Hooks for bootstrap.js
  public hooks = {
    onStartup: () => this.onStartup(),
    onShutdown: () => this.onShutdown(),
    onMainWindowLoad: (win: Window) => this.onMainWindowLoad(win),
    onMainWindowUnload: (win: Window) => this.onMainWindowUnload(win),
    onPrefsEvent: (type: string, data: any) => this.onPrefsEvent(type, data),
  };

  constructor() {
    this.logger = new Logger('ZotSeek');
    this.zoteroAPI = new ZoteroAPI();
    this.logger.debug('Plugin initialized with ZoteroToolkit logging');
  }

  setInfo(info: PluginInfo): void {
    this.info = info;
    this.logger.info(`Plugin version: ${info.version}`);
  }

  /**
   * Initialize default preferences if not already set
   * Note: Zotero prefs only support string, int, bool - not float
   * Defaults are version-aware: Zotero 7 (Firefox < 128) uses smaller chunks
   */
  private initDefaultPreferences(): void {
    const Z = getZotero();
    if (!Z) return;

    // Detect Firefox version for version-aware defaults
    // Firefox 115 (Zotero 7) has ~8-10x slower WASM than Firefox 140 (Zotero 8)
    const platformVersion = Z.platformMajorVersion || 0;
    const isSlowFirefox = platformVersion > 0 && platformVersion < 128;

    if (isSlowFirefox) {
      this.logger.info(`Firefox ${platformVersion} detected - using optimized defaults for slower WASM`);
    }

    // Store minSimilarity as int (30 = 0.3, divide by 100 when reading)
    // Using nomic-embed-text-v1.5 with 8192 token context window
    const defaults: { [key: string]: any } = {
      'zotseek.minSimilarityPercent': 30,  // 30% = 0.3
      'zotseek.topK': 20,
      'zotseek.autoIndex': false,
      'zotseek.autoIndexDelay': 10,   // Seconds to wait after last item before auto-indexing
      'zotseek.indexingMode': 'full',  // 'abstract' or 'full' - full paper mode is default for better search quality
      // Version-aware chunking defaults:
      // - Zotero 8 (FF 140): Larger chunks (2000 tokens), faster WASM
      // - Zotero 7 (FF 115): Smaller chunks (800 tokens), slower WASM needs O(n²) mitigation
      // Both use 100 max chunks for good coverage of full papers
      'zotseek.maxTokens': isSlowFirefox ? 800 : 2000,
      'zotseek.maxChunksPerPaper': 100,
      'zotseek.excludeBooks': true,        // Exclude books from search/indexing by default
      'zotseek.excludeTag': 'zotseek-exclude', // Tag name to exclude items from indexing
    };

    for (const [key, defaultValue] of Object.entries(defaults)) {
      try {
        const currentValue = Z.Prefs.get(key, true);
        if (currentValue === undefined) {
          this.logger.info(`Setting default preference: ${key} = ${defaultValue}`);
          Z.Prefs.set(key, defaultValue, true);
        } else {
          this.logger.info(`Preference ${key} already set: ${currentValue}`);
        }
      } catch (e) {
        this.logger.warn(`Failed to set preference ${key}: ${e}`);
      }
    }
  }

  async onStartup(): Promise<void> {
    const Z = getZotero();
    if (!Z) {
      this.logger.error('Zotero not available');
      return;
    }

    // Wait for UI to be ready
    await Z.uiReadyPromise;

    // Log startup with timestamp
    this.logger.info('=== ZotSeek Starting ===');
    this.logger.info(`Version: ${this.info?.version || 'unknown'}`);
    this.logger.info(`Time: ${new Date().toISOString()}`);

    // Set default preferences if not already set
    this.initDefaultPreferences();

    // Initialize core modules
    try {
      await this.initializeCore();
    } catch (error) {
      this.logger.error(`Failed to initialize core modules: ${error}`);
    }

    // Register cleanup observer for delete/trash events (always active, not gated on autoIndex)
    this.registerCleanupObserver();

    // Register context menu using Zotero 8 MenuManager API (preferred)
    // Falls back to XUL injection for older versions
    this.registerContextMenu();

    // Register preference pane
    this.registerPreferencePane();

    // Add toolbar button for semantic search
    const win = Z.getMainWindow();
    if (win) {
      toolbarButton.add(win);
      toolbarButton.registerToolsMenu(win);
      this.logger.info('Toolbar button and Tools menu added');
    }

    // Register reader toolbar button
    await toolbarButton.registerReaderToolbar();
    this.logger.info('Reader toolbar button registered');

    // Register reader text selection context menu ("Find Related Papers")
    await toolbarButton.registerReaderContextMenu();
    this.logger.info('Reader context menu registered');

    // Initialize auto-index manager (monitors for new items)
    this.initAutoIndexManager();

    this.logger.info('=== Plugin Started Successfully ===');
  }

  /**
   * Initialize auto-index manager for monitoring new items
   */
  private initAutoIndexManager(): void {
    // Set callback to index items (silent mode for auto-indexing)
    autoIndexManager.setIndexCallback(async (items: any[]) => {
      await this.indexItemsSilent(items);
    });

    // Set vector store reference for checking indexed status
    if (this.vectorStore) {
      autoIndexManager.setVectorStore(this.vectorStore);
    }

    // Start monitoring (respects autoIndex preference)
    autoIndexManager.start();
    this.logger.info('Auto-index manager initialized');
  }

  /**
   * Register a Notifier observer that cleans up embeddings when items are deleted or trashed.
   * This runs unconditionally (independent of the autoIndex preference) because
   * orphaned embeddings cause ghost search results — a data integrity concern.
   */
  private registerCleanupObserver(): void {
    const Z = getZotero();
    if (!Z) return;

    this.cleanupNotifierID = Z.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          _type: string,
          ids: Array<string | number>,
          _extraData: any
        ) => {
          if (event !== 'delete' && event !== 'trash') return;

          try {
            // Ensure vector store is available (lazy init if needed)
            await this.ensureStoreReady();
            if (!this.vectorStore) return;

            let cleaned = 0;
            for (const id of ids) {
              const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
              if (isNaN(numericId)) continue;
              await this.vectorStore.delete(numericId);
              cleaned++;
            }

            if (cleaned > 0) {
              this.logger.info(`Cleaned up embeddings for ${cleaned} ${event === 'trash' ? 'trashed' : 'deleted'} items`);
            }
          } catch (error: any) {
            // Non-critical: log but don't throw — deletion of non-indexed items is a no-op
            this.logger.error(`Failed to clean up embeddings on ${event}: ${error?.message || error}`);
          }
        }
      },
      ['item'],
      'zotseek-cleanup'
    );

    this.logger.info('Cleanup observer registered (handles delete/trash events)');
  }

  private async initializeCore(): Promise<void> {
    this.logger.info('Initializing core modules...');

    // Get SQLite vector store (lazy initialization)
    this.vectorStore = getVectorStore();

    // Don't initialize store on startup - do it lazily on first use
    this.logger.info('Vector store configured (will initialize on first use)');

    this.initialized = true;
  }

  /**
   * Ensure vector store is initialized before use
   */
  private async ensureStoreReady(): Promise<void> {
    if (!this.vectorStore) {
      this.logger.info('Getting vector store...');
      this.vectorStore = getVectorStore();
      // Update auto-index manager with vector store reference
      autoIndexManager.setVectorStore(this.vectorStore);
    }

    if (!this.vectorStore.isReady()) {
      this.logger.info('Initializing vector store...');
      try {
        await this.vectorStore.init();
        this.logger.info('Vector store initialized');
      } catch (error: any) {
        this.logger.error(`Vector store init failed: ${error?.message || error}`);
        throw error;
      }
    }
  }

  onMainWindowLoad(window: Window): void {
    this.logger.info('Main window loaded');
    // Menu is registered via MenuManager in onStartup, no need to re-register here
  }

  onMainWindowUnload(window: Window): void {
    this.logger.info('Main window unloading');
    // MenuManager handles cleanup automatically
  }

  /**
   * Handle preference pane events
   */
  async onPrefsEvent(type: string, data: any): Promise<void> {
    switch (type) {
      case 'load':
        this.logger.info('Preference pane loaded');
        await preferencesManager.init(data.window);
        break;
      case 'unload':
        this.logger.info('Preference pane unloaded');
        preferencesManager.destroy();
        break;
      case 'updateModeCards':
        preferencesManager.updateModeCards();
        break;
      default:
        break;
    }
  }

  /**
   * Register context menu items
   * Note: MenuManager API requires l10nID (localization) for labels.
   * Using XUL injection for now as it works with plain text labels.
   * Reference: https://www.zotero.org/support/dev/zotero_8_for_developers
   */
  private registerContextMenu(): void {
    const Z = getZotero();
    if (!Z) return;

    // Use XUL injection - works reliably with plain text labels
    // MenuManager API requires l10nID localization which we haven't set up yet
    this.registerWithXUL(Z);
  }

  /**
   * Register menus using XUL element injection
   * Works on both Zotero 7 and 8
   */
  private registerWithXUL(Z: any): void {
    this.logger.info('Registering menus via XUL injection');

    const win = Z.getMainWindow();
    if (!win) {
      this.logger.warn('No main window available for XUL injection');
      return;
    }

    const doc = win.document;
    const itemMenu = doc.getElementById('zotero-itemmenu');

    if (!itemMenu) {
      this.logger.warn('Could not find zotero-itemmenu');
      return;
    }

    // Check if already registered
    if (doc.getElementById('zotseek-find-similar')) {
      this.logger.debug('Context menu already registered');
      return;
    }

    // Create separator
    const separator = doc.createXULElement('menuseparator');
    separator.id = 'zotseek-separator';

    // Create "Find Similar Documents" menu item
    const findSimilarItem = doc.createXULElement('menuitem');
    findSimilarItem.id = 'zotseek-find-similar';
    findSimilarItem.setAttribute('label', 'Find Similar Documents');
    findSimilarItem.addEventListener('command', () => this.onFindSimilar());

    // Create "Open ZotSeek" menu item for general search
    const openSearchItem = doc.createXULElement('menuitem');
    openSearchItem.id = 'zotseek-open-dialog';
    openSearchItem.setAttribute('label', 'Open ZotSeek...');
    openSearchItem.addEventListener('command', () => searchDialogWithVTable.open());

    // Create "Index Selected" menu item
    const indexSelectedItem = doc.createXULElement('menuitem');
    indexSelectedItem.id = 'zotseek-index-selected';
    indexSelectedItem.setAttribute('label', 'Index Selected for ZotSeek');
    indexSelectedItem.addEventListener('command', () => this.onIndexSelected());

    // Create "Index Collection" menu item
    const indexCollectionItem = doc.createXULElement('menuitem');
    indexCollectionItem.id = 'zotseek-index-collection';
    indexCollectionItem.setAttribute('label', 'Index Current Collection');
    indexCollectionItem.addEventListener('command', () => this.onIndexCollection());

    // Create "Index Library" menu item
    const indexLibraryItem = doc.createXULElement('menuitem');
    indexLibraryItem.id = 'zotseek-index-library';
    indexLibraryItem.setAttribute('label', 'Update Library Index');
    indexLibraryItem.addEventListener('command', () => this.onIndexLibrary());

    // Create "Remove from Index" menu item
    const removeFromIndexItem = doc.createXULElement('menuitem');
    removeFromIndexItem.id = 'zotseek-remove-from-index';
    removeFromIndexItem.setAttribute('label', 'Remove from ZotSeek Index');
    removeFromIndexItem.addEventListener('command', () => this.onRemoveFromIndex());

    itemMenu.appendChild(separator);
    itemMenu.appendChild(findSimilarItem);
    itemMenu.appendChild(openSearchItem);
    itemMenu.appendChild(indexSelectedItem);
    itemMenu.appendChild(indexCollectionItem);
    itemMenu.appendChild(indexLibraryItem);
    itemMenu.appendChild(removeFromIndexItem);

    this.logger.info('Context menu registered successfully');
  }

  /**
   * Register the preference pane
   * Reference: https://www.zotero.org/support/dev/zotero_7_for_developers#preference_panes
   */
  private registerPreferencePane(): void {
    const Z = getZotero();
    if (!Z || !Z.PreferencePanes) {
      this.logger.warn('Zotero.PreferencePanes not available');
      return;
    }

    try {
      Z.PreferencePanes.register({
        pluginID: this.info?.id || 'zotseek@zotero.org',
        src: `${this.info?.rootURI || 'chrome://zotseek/'}content/preferences.xhtml`,
        label: 'ZotSeek',
        image: `${this.info?.rootURI || 'chrome://zotseek/'}content/icons/favicon.png`,
      });
      this.logger.info('Preference pane registered successfully');
    } catch (error) {
      this.logger.error(`Failed to register preference pane: ${error}`);
    }
  }

  /**
   * Public method to clear the index (called from preferences pane)
   */
  public async clearIndex(): Promise<void> {
    const Z = getZotero();

    const confirmed = Services.prompt.confirm(
      Z?.getMainWindow(),
      'Clear ZotSeek Index',
      'This will delete all stored embeddings. You will need to re-index your library.\n\nContinue?'
    );

    if (!confirmed) return;

    // Create stable progress window for clearing
    const progressWindow = new StableProgressWindow({
      title: 'Clearing ZotSeek Index',
    });

    try {
      progressWindow.updateProgress('Initializing storage...', null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        progressWindow.updateProgress('Deleting all embeddings...', 50);
        await this.vectorStore.clear();

        progressWindow.complete('Index cleared successfully!');
        this.logger.info('Index cleared via preferences');

        // Show additional alert for confirmation
        setTimeout(() => {
          this.showAlert('Index cleared successfully.\n\nYou can now re-index your library.');
        }, 500);
      }
    } catch (error: any) {
      this.logger.error(`Failed to clear index: ${error}`);
      progressWindow.error(`Failed to clear index: ${error.message || error}`, true);
      this.showAlert(`Failed to clear index: ${error.message || error}`);
    }
  }

  /**
   * Public method to index the entire library (called from preferences pane)
   */
  public indexLibrary(): void {
    this.onIndexLibrary();
  }

  /**
   * Public method to rebuild the index (clear + reindex)
   * This ensures the new indexing mode setting is applied
   */
  public async rebuildIndex(): Promise<void> {
    const Z = getZotero();

    const confirmed = Services.prompt.confirm(
      Z?.getMainWindow(),
      'Rebuild ZotSeek Index',
      'This will delete all stored embeddings and rebuild the index with your current settings.\n\n' +
      'This may take several minutes depending on library size.\n\nContinue?'
    );

    if (!confirmed) return;

    // First clear the index
    const progressWindow = new StableProgressWindow({
      title: 'Rebuilding ZotSeek Index',
    });

    try {
      progressWindow.updateProgress('Clearing existing index...', null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        await this.vectorStore.clear();
        this.logger.info('Index cleared for rebuild');
        progressWindow.addLine('✓ Existing index cleared', 'chrome://zotero/skin/tick.png');

        // Close the progress window briefly
        progressWindow.close();

        // Now trigger re-indexing of the entire library
        await this.onIndexLibrary();
      }
    } catch (error: any) {
      this.logger.error(`Failed to rebuild index: ${error}`);
      progressWindow.error(`Failed to rebuild index: ${error.message || error}`, true);
      this.showAlert(`Failed to rebuild index: ${error.message || error}`);
    }
  }

  /**
   * Public method to refresh stats in the preferences pane
   */
  public async refreshStats(): Promise<void> {
    const doc = getZotero()?.getMainWindow()?.document;
    if (!doc) return;

    const setText = (id: string, value: string) => {
      const el = doc.getElementById(id);
      if (el) el.textContent = value;
    };

      setText('zotseek-stat-papers', 'Loading...');

    try {
      const stats = await this.getStats();
      setText('zotseek-stat-papers', stats.indexedPapers.toLocaleString());
      setText('zotseek-stat-chunks', stats.totalChunks.toLocaleString());
      setText('zotseek-stat-avgchunks', stats.avgChunksPerPaper.toString());
      setText('zotseek-stat-storage', stats.storageSize);
      setText('zotseek-stat-dbpath', stats.databasePath || '-');
      setText('zotseek-stat-model', stats.modelId);
      setText('zotseek-stat-lastindexed', stats.lastIndexed);
    } catch (e) {
      this.logger.error(`Failed to refresh stats: ${e}`);
      setText('zotseek-stat-papers', 'Error');
    }
  }

  /**
   * Public method to get index statistics (called from preferences pane)
   */
  public async getStats(): Promise<{
    indexedPapers: number;
    totalChunks: number;
    avgChunksPerPaper: number;
    modelId: string;
    storageSize: string;
    databasePath: string;
    lastIndexed: string;
    lastIndexDuration?: string;
    indexedWithMode?: string;
  }> {
    try {
      this.logger.debug('getStats() called');
      await this.ensureStoreReady();
      if (!this.vectorStore) {
        this.logger.warn('getStats(): vectorStore is null');
        // Try to get database path even if store is not ready
        let databasePath = '-';
        try {
          const Z = getZotero();
          if (Z?.DataDirectory?.dir) {
            databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
          }
        } catch (e) { /* ignore */ }

        return {
          indexedPapers: 0,
          totalChunks: 0,
          avgChunksPerPaper: 0,
          modelId: 'none',
          storageSize: '0 KB',
          databasePath,
          lastIndexed: 'Never',
        };
      }

      this.logger.debug('getStats(): Calling vectorStore.getStats()');
      const stats = await this.vectorStore.getStats();
      this.logger.debug(`getStats(): Got stats: ${JSON.stringify(stats)}`);

      // Get the indexing mode that was used to build the current index
      let indexedWithMode: string | undefined;
      try {
        const storedMode = await this.vectorStore.getMetadata('indexingMode');
        if (storedMode) {
          // Convert to human-readable format
          // Support both old mode names (fulltext, hybrid) and new (full)
          const modeLabels: { [key: string]: string } = {
            'abstract': 'Abstract Only',
            'full': 'Full Paper',
            // Legacy mode names for backward compatibility
            'fulltext': 'Full Paper',
            'hybrid': 'Full Paper'
          };
          indexedWithMode = modeLabels[storedMode] || storedMode;
        }
      } catch (e) {
        this.logger.debug(`Could not get indexing mode from metadata: ${e}`);
      }

      // Get the last index duration
      let lastIndexDuration: string | undefined;
      try {
        const storedDuration = await this.vectorStore.getMetadata('lastIndexDurationMs');
        if (storedDuration) {
          const durationMs = parseInt(storedDuration, 10);
          if (!isNaN(durationMs)) {
            lastIndexDuration = this.formatDuration(durationMs);
          }
        }
      } catch (e) {
        this.logger.debug(`Could not get last index duration from metadata: ${e}`);
      }

      // Format storage size
      let storageSize: string;
      if (stats.storageUsedBytes < 1024) {
        storageSize = `${stats.storageUsedBytes} B`;
      } else if (stats.storageUsedBytes < 1024 * 1024) {
        storageSize = `${(stats.storageUsedBytes / 1024).toFixed(1)} KB`;
      } else if (stats.storageUsedBytes < 1024 * 1024 * 1024) {
        storageSize = `${(stats.storageUsedBytes / (1024 * 1024)).toFixed(1)} MB`;
      } else {
        storageSize = `${(stats.storageUsedBytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
      }

      // Format last indexed date
      let lastIndexed: string;
      if (stats.lastIndexed) {
        lastIndexed = stats.lastIndexed.toLocaleString();
      } else {
        lastIndexed = 'Never';
      }

      // Get database path - use vectorStore method if available, otherwise construct it
      let databasePath = '-';
      try {
        if (this.vectorStore && typeof this.vectorStore.getDatabasePath === 'function') {
          databasePath = this.vectorStore.getDatabasePath();
        } else {
          // Fallback: construct path directly
          const Z = getZotero();
          if (Z?.DataDirectory?.dir) {
            databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
          }
        }
      } catch (e) {
        this.logger.debug(`Could not get database path: ${e}`);
      }

      return {
        indexedPapers: stats.indexedPapers,
        totalChunks: stats.totalChunks,
        avgChunksPerPaper: stats.avgChunksPerPaper,
        modelId: stats.modelId === 'none' ? 'None' : stats.modelId.replace('Xenova/', ''),
        storageSize,
        databasePath,
        lastIndexed,
        lastIndexDuration,
        indexedWithMode,
      };
    } catch (error) {
      this.logger.error(`Failed to get stats: ${error}`);
      // Try to get database path even on error
      let databasePath = '-';
      try {
        const Z = getZotero();
        if (Z?.DataDirectory?.dir) {
          databasePath = Z.DataDirectory.dir + '/zotseek.sqlite';
        }
      } catch (e) { /* ignore */ }

      return {
        indexedPapers: 0,
        totalChunks: 0,
        avgChunksPerPaper: 0,
        modelId: 'Error',
        storageSize: 'Error',
        databasePath,
        lastIndexed: 'Error',
      };
    }
  }

  /**
   * Index selected items for semantic search
   */
  private async onIndexSelected(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    const selectedItems = this.zoteroAPI.getSelectedItems();
    if (selectedItems.length === 0) {
      this.showAlert('Please select items to index.');
      return;
    }

    this.logger.info(`Indexing ${selectedItems.length} selected items`);
    await this.indexItems(selectedItems);
  }

  /**
   * Index current collection
   * Reference: https://windingwind.github.io/doc-for-zotero-plugin-dev/main/collection-operations.html
   */
  private async onIndexCollection(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // Get the selected collection using ZoteroPane
    const ZoteroPane = Z.getActiveZoteroPane();
    const collection = ZoteroPane?.getSelectedCollection();

    if (!collection) {
      this.showAlert('Please select a collection first.\n\n(Click on a collection in the left sidebar)');
      return;
    }

    const collectionName = collection.name;
    const items = collection.getChildItems().filter((item: any) => item.isRegularItem());

    if (items.length === 0) {
      this.showAlert(`Collection "${collectionName}" has no items to index.`);
      return;
    }

    this.logger.info(`Indexing collection "${collectionName}" (${items.length} items)`);
    await this.indexItems(items);
  }

  /**
   * Index entire library
   */
  private async onIndexLibrary(): Promise<void> {
    if (this.indexing) {
      this.showAlert('Indexing already in progress...');
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // Use Services.prompt for Zotero 8 compatibility
    const confirmed = Services.prompt.confirm(
      Z.getMainWindow(),
      'ZotSeek - Update Library Index',
      'This will index all unindexed items in your library for semantic search.\n\n' +
      'Items that are already indexed will be skipped.\n\n' +
      'This may take several minutes depending on the number of new items.\n\n' +
      'Continue?'
    );

    if (!confirmed) return;

    this.logger.info('Indexing entire library');
    const items = await this.zoteroAPI.getLibraryItems();
    this.logger.info(`Found ${items.length} items to index`);

    await this.indexItems(items);
  }

  /**
   * Remove selected items from the ZotSeek index
   */
  private async onRemoveFromIndex(): Promise<void> {
    const Z = getZotero();
    if (!Z) return;

    const ZoteroPane = Z.getActiveZoteroPane();
    const selectedItems = ZoteroPane?.getSelectedItems() || [];

    if (selectedItems.length === 0) {
      showQuickNotification('No items selected', 'default');
      return;
    }

    try {
      await this.ensureStoreReady();
      if (!this.vectorStore) return;

      let removed = 0;
      for (const item of selectedItems) {
        if (item.isRegularItem()) {
          await this.vectorStore.delete(item.id);
          removed++;
        }
      }

      const msg = removed > 0
        ? `Removed ${removed} item${removed !== 1 ? 's' : ''} from index`
        : 'Selected items were not in the index';
      showQuickNotification(msg, removed > 0 ? 'success' : 'default');
      this.logger.info(msg);
    } catch (error: any) {
      this.logger.error(`Failed to remove from index: ${error?.message || error}`);
      showQuickNotification('Failed to remove from index', 'fail');
    }
  }

  /**
   * Index items for semantic search
   * Uses the configurable indexing mode (abstract, fulltext, or hybrid)
   *
   * Implements checkpoint/incremental saving:
   * - Skips already-indexed items (allows resuming after crash)
   * - Saves embeddings in batches of ~25 items (prevents total loss on crash)
   * - Memory efficient (only one batch in memory at a time)
   */
  private async indexItems(items: any[]): Promise<void> {
    this.indexing = true;
    const Z = getZotero();
    const indexStartTime = Date.now(); // Track total indexing time

    // Checkpoint batch size - save every N items to prevent data loss
    const CHECKPOINT_BATCH_SIZE = 25;

    // Create stable progress window using toolkit
    const progressWindow = new StableProgressWindow({
      title: 'ZotSeek Indexing',
      cancelCallback: () => {
        this.indexing = false;
        this.logger.info('Indexing cancelled by user');
      }
    });

    try {
      // Ensure vector store is ready
      progressWindow.updateProgress('Initializing storage...', null);
      await this.ensureStoreReady();

      // Get indexing mode
      const indexingMode = getIndexingMode(Z);
      this.logger.info(`Indexing mode: ${indexingMode}`);
      progressWindow.addLine(`Indexing mode: ${indexingMode}`);

      // === PHASE 1: Filter out excluded and already-indexed items ===
      progressWindow.setHeadline('Checking for already-indexed items...');
      const itemsToIndex: any[] = [];
      let skippedExcluded = 0;
      for (const item of items) {
        if (hasExcludeTag(item)) {
          skippedExcluded++;
          continue;
        }
        const isIndexed = await this.vectorStore!.isIndexed(item.id);
        if (!isIndexed) {
          itemsToIndex.push(item);
        }
      }
      if (skippedExcluded > 0) {
        this.logger.info(`Skipped ${skippedExcluded} items with exclusion tag`);
        progressWindow.addLine(`✓ Skipped ${skippedExcluded} excluded items (tag)`, 'chrome://zotero/skin/tick.png');
      }
      const skippedAlreadyIndexed = items.length - itemsToIndex.length - skippedExcluded;
      if (skippedAlreadyIndexed > 0) {
        this.logger.info(`Skipped ${skippedAlreadyIndexed} already-indexed items`);
        progressWindow.addLine(`✓ Skipped ${skippedAlreadyIndexed} already-indexed items`, 'chrome://zotero/skin/tick.png');
      }

      // If all items are already indexed, we're done
      if (itemsToIndex.length === 0) {
        progressWindow.setHeadline('All items already indexed!');
        progressWindow.addLine(`✓ ${items.length} items already in index`, 'chrome://zotero/skin/tick.png');
        progressWindow.complete('Nothing to index - all items are up to date!', true);
        return;
      }

      // Reset pipeline to ensure fresh initialization
      embeddingPipeline.reset();

      progressWindow.updateProgress('Loading AI model (Transformers.js)...', null);
      await embeddingPipeline.init();
      this.logger.info('Embedding pipeline initialized (Transformers.js)')
      progressWindow.addLine('✓ AI model loaded', 'chrome://zotero/skin/tick.png');

      // === PHASE 2: Process items in batches with checkpoints ===
      const totalBatches = Math.ceil(itemsToIndex.length / CHECKPOINT_BATCH_SIZE);
      let totalItemsIndexed = 0;
      let totalChunksIndexed = 0;
      let totalItemsSkipped = 0; // Items with no extractable content

      this.logger.info(`Processing ${itemsToIndex.length} items in ${totalBatches} batches of ${CHECKPOINT_BATCH_SIZE}`);

      for (let batchStart = 0; batchStart < itemsToIndex.length; batchStart += CHECKPOINT_BATCH_SIZE) {
        await progressWindow.waitIfPaused();
        if (progressWindow.isCancelled()) {
          throw new Error('Cancelled by user');
        }

        const batchEnd = Math.min(batchStart + CHECKPOINT_BATCH_SIZE, itemsToIndex.length);
        const batchItems = itemsToIndex.slice(batchStart, batchEnd);
        const batchNumber = Math.floor(batchStart / CHECKPOINT_BATCH_SIZE) + 1;

        // === STEP 1: Extract chunks for this batch ===
        progressWindow.setHeadline(`Batch ${batchNumber}/${totalBatches}: Extracting text...`);
        this.logger.info(`Batch ${batchNumber}/${totalBatches}: Extracting ${batchItems.length} items`);

        const extractedBatch = await textExtractor.extractChunksFromItems(
          batchItems,
          indexingMode,
          undefined,
          (progress) => {
            if (progressWindow.isCancelled()) {
              throw new Error('Cancelled by user');
            }
            progressWindow.updateProgressWithETA(
              `Batch ${batchNumber}/${totalBatches}: ${progress.currentTitle}`,
              batchStart + progress.current,
              itemsToIndex.length
            );
          }
        );

        const batchSkipped = batchItems.length - extractedBatch.length;
        totalItemsSkipped += batchSkipped;

        // === STEP 2: Generate embeddings for this batch ===
        const batchChunks: Array<{ id: string; text: string; title: string }> = [];
        for (const extracted of extractedBatch) {
          for (const chunk of extracted.chunks) {
            batchChunks.push({
              id: `${extracted.itemId}_${chunk.index}`,
              text: chunk.text,
              title: extracted.title,
            });
          }
        }

        progressWindow.setHeadline(`Batch ${batchNumber}/${totalBatches}: Generating embeddings...`);
        this.logger.info(`Batch ${batchNumber}/${totalBatches}: Embedding ${batchChunks.length} chunks`);

        const embeddingMap = new Map<string, { embedding: number[]; modelId: string }>();
        let chunkProcessed = 0;

        let failedChunks = 0;
        const failedItems = new Set<string>();
        for (const chunk of batchChunks) {
          await progressWindow.waitIfPaused();
          if (progressWindow.isCancelled()) {
            throw new Error('Cancelled by user');
          }

          chunkProcessed++;
          progressWindow.updateProgressWithETA(
            `Batch ${batchNumber}/${totalBatches}: Embedding chunks`,
            batchStart + Math.floor((chunkProcessed / batchChunks.length) * batchItems.length),
            itemsToIndex.length
          );

          try {
            const result = await embeddingPipeline.embed(chunk.text);
            if (result) {
              embeddingMap.set(chunk.id, result);
            }
          } catch (embedException: any) {
            // Retry once before giving up on this chunk
            try {
              this.logger.warn(`Embedding failed for chunk ${chunk.id} ("${chunk.title}"), retrying: ${embedException?.message || embedException}`);
              await new Promise(resolve => setTimeout(resolve, 500));
              const retryResult = await embeddingPipeline.embed(chunk.text);
              if (retryResult) {
                embeddingMap.set(chunk.id, retryResult);
              }
            } catch {
              failedChunks++;
              failedItems.add(chunk.title);
              this.logger.error(`Skipping chunk ${chunk.id} ("${chunk.title}") after retry failure: ${embedException?.message || embedException}`);
            }
          }

          // Yield to UI thread periodically
          if (chunkProcessed % 5 === 0) {
            await new Promise(resolve => setTimeout(resolve, 0));
          }
        }

        if (failedChunks > 0) {
          const itemList = Array.from(failedItems).join(', ');
          this.logger.warn(`Batch ${batchNumber}: ${failedChunks} chunks failed embedding and were skipped in: ${itemList}`);
          progressWindow.addLine(`⚠ ${failedChunks} chunks skipped in: ${itemList}`);
        }

        // === STEP 3: Save this batch (CHECKPOINT) ===
        progressWindow.setHeadline(`Batch ${batchNumber}/${totalBatches}: Saving checkpoint...`);

        const batchEmbeddings: PaperEmbedding[] = [];
        for (const extracted of extractedBatch) {
          // Delete existing chunks for this item before adding new ones
          await this.vectorStore!.deleteItemChunks(extracted.itemId);

          for (const chunk of extracted.chunks) {
            const embeddingKey = `${extracted.itemId}_${chunk.index}`;
            const embeddingResult = embeddingMap.get(embeddingKey);

            if (embeddingResult) {
              batchEmbeddings.push({
                itemId: extracted.itemId,
                chunkIndex: chunk.index,
                itemKey: extracted.itemKey,
                libraryId: extracted.libraryId,
                title: extracted.title,
                abstract: extracted.abstract || undefined,
                chunkText: chunk.text,
                textSource: chunk.type,
                embedding: embeddingResult.embedding,
                modelId: embeddingResult.modelId,
                indexedAt: new Date().toISOString(),
                contentHash: extracted.contentHash,
                pageNumber: chunk.pageNumber,
                paragraphIndex: chunk.paragraphIndex,
                startChar: chunk.startChar,
                endChar: chunk.endChar,
              });
            }
          }
        }

        // Save this batch to database
        await this.vectorStore!.putBatch(batchEmbeddings);

        totalItemsIndexed += extractedBatch.length;
        totalChunksIndexed += batchEmbeddings.length;

        this.logger.info(`Checkpoint ${batchNumber}/${totalBatches}: Saved ${batchEmbeddings.length} chunks from ${extractedBatch.length} items`);
        progressWindow.addCheckpointLine(`✓ Checkpoint ${batchNumber}/${totalBatches}: ${extractedBatch.length} items, ${batchEmbeddings.length} chunks saved`);
      }

      // Store the indexing mode in metadata so we know what mode was used to build the index
      await this.vectorStore!.setMetadata('indexingMode', indexingMode);
      this.logger.info(`Stored indexing mode '${indexingMode}' in metadata`);

      // Calculate and store indexing duration
      const indexDurationMs = Date.now() - indexStartTime;
      await this.vectorStore!.setMetadata('lastIndexDurationMs', String(indexDurationMs));
      this.logger.info(`Indexing completed in ${indexDurationMs}ms`);

      // Calculate stats for display
      const avgChunksPerItem = totalItemsIndexed > 0
        ? Math.round((totalChunksIndexed / totalItemsIndexed) * 10) / 10
        : 0;

      // Format duration for display
      const durationFormatted = this.formatDuration(indexDurationMs);

      // Show completion
      progressWindow.setHeadline('Indexing Complete!');
      progressWindow.addLine(`✓ Mode: ${indexingMode}`, 'chrome://zotero/skin/tick.png');
      if (skippedAlreadyIndexed > 0) {
        progressWindow.addLine(`✓ Previously indexed: ${skippedAlreadyIndexed} items`, 'chrome://zotero/skin/tick.png');
      }
      progressWindow.addLine(`✓ Newly indexed: ${totalItemsIndexed} items`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Total chunks: ${totalChunksIndexed}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Avg chunks/item: ${avgChunksPerItem}`, 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(`✓ Duration: ${durationFormatted}`, 'chrome://zotero/skin/tick.png');

      if (totalItemsSkipped > 0) {
        progressWindow.addLine(`⚠ No content: ${totalItemsSkipped} items`);
      }

      progressWindow.complete('Indexing completed successfully!', true);

    } catch (error: any) {
      if (progressWindow.isCancelled()) {
        this.logger.info('Indexing cancelled by user');
        showQuickNotification('Indexing cancelled', 'default', 3000);
      } else {
        this.logger.error(`Indexing failed: ${error}`);
        progressWindow.error(`Indexing failed: ${error.message || error}`, false);
        // Keep window open for 10 seconds so user can see the error
        setTimeout(() => progressWindow.close(), 10000);
        this.showAlert(`Indexing failed: ${error.message || error}`);
      }
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Index items silently (for auto-indexing)
   * Shows a progress indicator while running
   */
  private async indexItemsSilent(items: any[]): Promise<void> {
    if (this.indexing) {
      this.logger.debug('Indexing already in progress, skipping auto-index');
      return;
    }

    if (items.length === 0) {
      return;
    }

    this.indexing = true;
    const Z = getZotero();

    this.logger.info(`Auto-indexing ${items.length} items...`);

    // Show progress window immediately
    const progressWin = new (Z.ProgressWindow as any)({ closeOnClick: true });
    progressWin.changeHeadline('ZotSeek');

    // Get truncated title for display (max 35 chars)
    const firstTitle = items[0]?.getField?.('title') || 'item';
    const truncTitle = firstTitle.length > 35 ? firstTitle.substring(0, 32) + '...' : firstTitle;
    const displayText = items.length === 1 ? truncTitle : `${items.length} items`;

    const itemRow = new progressWin.ItemProgress(
      'chrome://zotero/skin/spinner-16px.png',
      `Indexing: ${displayText}`
    );
    progressWin.show();

    try {
      // Ensure vector store is ready
      await this.ensureStoreReady();

      // Get indexing mode
      const indexingMode = getIndexingMode(Z);

      // Reset pipeline to ensure fresh initialization
      itemRow.setText('Loading model...');
      embeddingPipeline.reset();
      await embeddingPipeline.init();

      // Filter out items with exclusion tag
      const filteredItems = items.filter(item => !hasExcludeTag(item));
      if (filteredItems.length === 0) {
        this.logger.info('All items excluded by tag');
        try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
        itemRow.setText('All items excluded by tag');
        progressWin.startCloseTimer(3000);
        return;
      }

      // Extract chunks from items
      itemRow.setText('Extracting...');
      const extractedItems = await textExtractor.extractChunksFromItems(filteredItems, indexingMode);

      if (extractedItems.length === 0) {
        this.logger.info('No content extracted from items');
        try { itemRow.setIcon('chrome://zotero/skin/cross.png'); } catch { /* ignore */ }
        itemRow.setText('✗ No content found');
        progressWin.startCloseTimer(3000);
        return;
      }

      // Count total chunks
      const totalChunks = extractedItems.reduce((sum, item) => sum + item.chunks.length, 0);
      this.logger.info(`Extracted ${totalChunks} chunks from ${extractedItems.length} items`);

      // Prepare chunks for embedding
      const textsForEmbedding: Array<{ id: string; text: string; title: string }> = [];
      for (const extracted of extractedItems) {
        for (const chunk of extracted.chunks) {
          textsForEmbedding.push({
            id: `${extracted.itemId}_${chunk.index}`,
            text: chunk.text,
            title: extracted.title,
          });
        }
      }

      // Generate embeddings with progress updates
      const embeddingMap = new Map<string, { embedding: number[]; modelId: string }>();
      let processed = 0;
      let failedChunks = 0;

      const failedItems = new Set<string>();
      for (const item of textsForEmbedding) {
        processed++;
        itemRow.setText(`Embedding ${processed}/${textsForEmbedding.length}...`);
        try {
          const result = await embeddingPipeline.embed(item.text);
          if (result) {
            embeddingMap.set(item.id, result);
          }
        } catch (embedException: any) {
          // Retry once before giving up
          try {
            this.logger.warn(`Auto-index embed failed for ${item.id} ("${item.title}"), retrying: ${embedException?.message || embedException}`);
            await new Promise(resolve => setTimeout(resolve, 500));
            const retryResult = await embeddingPipeline.embed(item.text);
            if (retryResult) {
              embeddingMap.set(item.id, retryResult);
            }
          } catch {
            failedChunks++;
            failedItems.add(item.title);
            this.logger.error(`Auto-index skipping chunk ${item.id} ("${item.title}"): ${embedException?.message || embedException}`);
          }
        }
      }

      // Store embeddings with chunk metadata
      itemRow.setText('Saving...');
      const paperEmbeddings: PaperEmbedding[] = [];

      for (const extracted of extractedItems) {
        for (const chunk of extracted.chunks) {
          const embeddingKey = `${extracted.itemId}_${chunk.index}`;
          const embeddingData = embeddingMap.get(embeddingKey);
          if (!embeddingData) continue;

          paperEmbeddings.push({
            itemId: extracted.itemId,
            chunkIndex: chunk.index,
            itemKey: extracted.itemKey,
            libraryId: extracted.libraryId,
            title: extracted.title,
            abstract: extracted.abstract || undefined,
            chunkText: chunk.text,
            textSource: chunk.type,
            embedding: embeddingData.embedding,
            modelId: embeddingData.modelId,
            indexedAt: new Date().toISOString(),
            contentHash: extracted.contentHash,
            pageNumber: chunk.pageNumber,
            paragraphIndex: chunk.paragraphIndex,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
          });
        }
      }

      // Store in vector store
      await this.vectorStore!.putBatch(paperEmbeddings);

      if (failedChunks > 0) {
        const itemList = Array.from(failedItems).join(', ');
        this.logger.warn(`Auto-index: ${failedChunks} chunks failed in: ${itemList}`);
      }
      this.logger.info(`Auto-indexed ${extractedItems.length} items (${paperEmbeddings.length} chunks, ${failedChunks} failed)`);

      // Show success - use try-catch for setIcon as it may not exist in all Zotero versions
      try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
      const failedNote = failedChunks > 0 ? ` (${failedChunks} chunks skipped)` : '';
      itemRow.setText(`✓ ${paperEmbeddings.length} chunks indexed${failedNote}`);
      progressWin.startCloseTimer(3000);

    } catch (error: any) {
      this.logger.error(`Auto-indexing failed: ${error?.message || error}`);
      // Show error in progress window - use try-catch for setIcon
      const errMsg = (error?.message || 'Unknown error').substring(0, 30);
      try { itemRow.setIcon('chrome://zotero/skin/cross.png'); } catch { /* ignore */ }
      itemRow.setText(`✗ Error: ${errMsg}`);
      progressWin.startCloseTimer(4000);
    } finally {
      this.indexing = false;
    }
  }

  /**
   * Format duration in milliseconds to human-readable string
   */
  private formatDuration(ms: number): string {
    if (ms < 1000) {
      return `${ms}ms`;
    } else if (ms < 60000) {
      return `${(ms / 1000).toFixed(1)}s`;
    } else if (ms < 3600000) {
      const minutes = Math.floor(ms / 60000);
      const seconds = Math.round((ms % 60000) / 1000);
      return `${minutes}m ${seconds}s`;
    } else {
      const hours = Math.floor(ms / 3600000);
      const minutes = Math.round((ms % 3600000) / 60000);
      return `${hours}h ${minutes}m`;
    }
  }

  /**
   * Find papers similar to selected item
   */
  private async onFindSimilar(): Promise<void> {
    this.logger.info('Find Similar Documents triggered');

    const Z = getZotero();
    if (!Z) return;

    const selectedItems = this.zoteroAPI.getSelectedItems();
    if (selectedItems.length === 0) {
      this.showAlert('Please select an item first.');
      return;
    }

    const item = selectedItems[0];
    const title = item.getField('title');
    this.logger.info(`Finding papers similar to: ${title}`);
    this.logger.info(`Item ID: ${item.id}, Key: ${item.key}, Type: ${typeof item.id}`);

    try {
      // Ensure store is ready
      await this.ensureStoreReady();

      // Check if item is indexed
      this.logger.debug(`Checking if item ${item.id} is indexed...`);
      const isIndexed = await this.vectorStore!.isIndexed(item.id);
      this.logger.debug(`isIndexed result: ${isIndexed}`);

      if (!isIndexed) {
        // Use Services.prompt for Zotero 8 compatibility
        const indexNow = Services.prompt.confirm(
          Z.getMainWindow(),
          'ZotSeek - Item Not Indexed',
          `"${title}" is not indexed yet.\n\nWould you like to index it now?`
        );

        if (indexNow) {
          await this.indexItems([item]);
        } else {
          return;
        }
      }

      // Check if embedding pipeline is ready
      if (!embeddingPipeline.isReady()) {
        // The dialog will show its own loading message
        await embeddingPipeline.init();
      }

      // Open the similar documents dialog
      similarDocumentsWrapper.open(item);

    } catch (error) {
      this.logger.error(`Find similar failed: ${error}`);
      this.showAlert(`Search failed: ${error}`);
    }
  }

  /**
   * Display search results in a dialog
   */
  private showSearchResults(queryTitle: string, results: SearchResult[]): void {
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (!win) return;

    const resultText = results.map((r, i) =>
      `${i + 1}. [${Math.round(r.similarity * 100)}%] ${r.title}`
    ).join('\n');

    win.alert(
      `Similar to: "${queryTitle}"\n\n` +
      `Found ${results.length} similar papers:\n\n` +
      resultText +
      '\n\n(Click on items in the list to navigate)'
    );

    // Select first result in Zotero
    if (results.length > 0) {
      this.zoteroAPI.selectItem(results[0].itemId);
    }
  }

  /**
   * Show progress (placeholder - will be replaced with proper UI)
   */
  private showProgress(message: string, current: number, total: number): void {
    this.logger.info(`Progress: ${message} (${current}/${total})`);
    // TODO: Show actual progress bar UI
  }

  /**
   * Show alert dialog using proper Zotero/Mozilla prompt service
   */
  private showAlert(message: string, title = 'ZotSeek'): void {
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (!win) return;

    try {
      // Use Mozilla's prompt service for proper titled dialogs
      const ps = Services.prompt;
      if (ps) {
        ps.alert(win, title, message);
      } else {
        // Fallback to window.alert if Services not available
        win.alert(message);
      }
    } catch (error) {
      this.logger.error('Failed to show alert:', error);
    }
  }

  async onShutdown(): Promise<void> {
    this.logger.info('Shutting down plugin');

    // Unregister cleanup observer
    if (this.cleanupNotifierID) {
      const Z = getZotero();
      if (Z) {
        Z.Notifier.unregisterObserver(this.cleanupNotifierID);
      }
      this.cleanupNotifierID = null;
    }

    // Stop auto-index manager
    autoIndexManager.stop();

    // Remove XUL-injected menu elements and toolbar button
    const Z = getZotero();
    const win = Z?.getMainWindow();
    if (win) {
      this.removeXULElements(win);
      toolbarButton.remove(win);
    }

    // Unregister Tools menu and reader toolbar
    toolbarButton.unregisterToolsMenu();
    toolbarButton.unregisterReaderToolbar();

    if (this.vectorStore) {
      await this.vectorStore.close();
    }
  }

  /**
   * Remove XUL-injected menu elements (fallback cleanup)
   */
  private removeXULElements(window: Window): void {
    const doc = window.document;
    const ids = [
      'zotseek-find-similar',
      'zotseek-open-dialog',
      'zotseek-index-selected',
      'zotseek-index-collection',
      'zotseek-index-library',
      'zotseek-remove-from-index',
      'zotseek-separator',
    ];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
    this.logger.debug('XUL elements removed');
  }

  // Public API for other plugins/scripts
  public api = {
    search: (query: string, options?: any) => searchEngine.search(query, options),
    findSimilar: (itemId: number, options?: any) => searchEngine.findSimilar(itemId, options),
    indexItems: (items: any[]) => this.indexItems(items),
    getStats: () => this.vectorStore?.getStats() ?? Promise.resolve({ totalPapers: 0, indexedPapers: 0, modelId: 'none', lastIndexed: null, storageUsedBytes: 0 }),
    isReady: () => this.initialized && embeddingPipeline.isReady(),
  };
}

// Create plugin instance
const addon = new ZotSeekPlugin();

// Attach to Zotero global (like BetterNotes does)
const Z = getZotero();
if (Z) {
  Z.ZotSeek = addon;
}

// Also expose on _globalThis for bootstrap access
if (typeof _globalThis !== 'undefined') {
  _globalThis.addon = addon;
}
