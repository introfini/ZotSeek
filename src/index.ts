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
import { autoIndexManager, isNoteIndexingEnabled } from './core/auto-index-manager';
import { getString } from './utils/locale';
// Use stable progress window from toolkit to avoid crashes
import { StableProgressWindow, showQuickNotification } from './utils/stable-progress';
// UI components
import { searchDialog } from './ui/search-dialog';
import { searchDialogWithVTable } from './ui/search-dialog-with-vtable';
import { similarDocumentsWrapper } from './ui/similar-documents-wrapper';
import { toolbarButton } from './ui/toolbar-button';
import { shouldShowCollectionMenu } from './ui/collection-menu';
import { itemTreeIndexColumn } from './ui/item-tree-column';
import { preferencesManager } from './ui/preferences';
import { identityFromItem, libraryKeyFromLocalID, localItemIDFromIdentity } from './core/identity-resolver';
import { getActiveModelId } from './core/model-registry';
import { splitReusable, ReuseCandidate, StoredEmbeddings } from './core/embedding-reuse';
import { initServerManager, shutdownServerManager } from './server/server-manager';
import { registerModelsResourceSubstitution, verifyModelsResourceSubstitution } from './core/model-download';
// Self-test harness (mounted only when extensions.zotseek.devMode = true)
import { selfTest as zotseekSelfTest } from './dev/self-test';
// Task suites: imported for registration side effects only.
import './dev/suites/task-1-identity-resolver';
import './dev/suites/task-6-write-delete';
import './dev/suites/task-7-lookups';
import './dev/suites/task-8-reads';
import './dev/suites/task-9-status-map';
import './dev/suites/task-10-housekeeping';
import './dev/suites/task-13-search';
import './dev/suites/mcp-server';
import './dev/suites/task-37a-model-registry';
import './dev/suites/task-37b-schema-v9';
import './dev/suites/task-37c-model-aware-store';
import './dev/suites/task-37d-partitioned-search';
import './dev/suites/task-37e-model-download';
import './dev/suites/task-50-note-reuse';
import './dev/suites/task-50-note-identity';
import './dev/suites/task-42a-loopback';
import './dev/suites/task-42b-server-registry';
import './dev/suites/task-42c-server-client';
import './dev/suites/task-47-z10-db-hooks';
import './dev/suites/task-44-hybrid-backfill';
import { collectCollectionItems } from './utils/collection-items';
import { collectNoteBackfillItems, NoteBackfillDeps } from './utils/note-backfill';
import { identityFromNotifierData } from './core/notifier-identity';
import { isSearchInProgress } from './core/search-activity';

/**
 * Don't bother compacting zotseek.sqlite on idle below this much reclaimable
 * space. Mirrors the threshold the preferences button label uses.
 */
const IDLE_COMPACT_MIN_BYTES = 10 * 1024 * 1024;

/**
 * Persisted scope of a bulk-index run, used to offer resume on next startup
 * if the run was interrupted (cancel, crash, sleep, plugin reload).
 */
type BulkScope =
  | { type: 'library'; libraryId: number }
  | { type: 'all-libraries' }
  | { type: 'collection'; libraryId: number; collectionId: number }
  | { type: 'collections'; collections: Array<{ libraryId: number; collectionId: number }> }
  // Backfill of note text into items that are ALREADY indexed. The libraries
  // are resolved from zotseek.indexScope when the run starts and travel with
  // the marker, so a resumed run covers the libraries it began with even if
  // the preference changed in between.
  | { type: 'notes-backfill'; libraryIds: number[] };

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
 * Wire the notes-backfill selection to the live Zotero and the vector store.
 *
 * Module-level rather than a class method: it needs no `this`, and SpiderMonkey
 * does not reliably register methods added to the class compiled into this
 * esbuild IIFE bundle.
 */
function makeNoteBackfillDeps(store: IVectorStore): NoteBackfillDeps {
  return {
    hasExcludeTag,
    identityOf: (item: any) => identityFromItem(item),
    isIndexed: (libraryKey: string, itemKey: string) => store.isIndexedByIdentity(libraryKey, itemKey),
    getNote: (noteId: number) => Zotero.Items.getAsync(noteId),
    onError: (message: string) => Zotero.debug(`[ZotSeek] ${message}`),
  };
}

interface ChunkForEmbedding { id: string; text: string; title: string; }
interface EmbedChunksResult {
  embeddings: Map<string, { embedding: number[]; modelId: string }>;
  failedChunks: number;
  failedItems: Set<string>;
}

// One HTTP request carries up to this many chunks on the server runtime.
const SERVER_EMBED_GROUP = 32;

/**
 * Embed a list of chunks with the active pipeline. Shared by the three
 * indexing paths (indexLibrary, auto-index, reindexForActiveModel).
 *
 * Worker runtime: per-chunk with one retry; a chunk that fails twice is
 * skipped and reported (embedding compute is local, failures are per-chunk).
 *
 * Server runtime: groups of SERVER_EMBED_GROUP per request. Errors are NOT
 * swallowed per chunk: the client already retried with backoff, and a dead
 * server must stop the run cleanly (ServerUnavailableError propagates to the
 * caller's outer catch). Falling back to the in-process model is forbidden -
 * it would mix vector spaces under one model_id.
 *
 * onProgress(processed) runs after each chunk (worker) or group (server);
 * it may throw (e.g. 'Cancelled by user') to abort the run.
 */
async function embedChunks(
  chunks: ChunkForEmbedding[],
  onProgress: (processed: number) => Promise<void> | void,
): Promise<EmbedChunksResult> {
  const embeddings = new Map<string, { embedding: number[]; modelId: string }>();
  let failedChunks = 0;
  const failedItems = new Set<string>();

  if (embeddingPipeline.isServerBacked()) {
    const modelId = getActiveModelId();
    for (let i = 0; i < chunks.length; i += SERVER_EMBED_GROUP) {
      const group = chunks.slice(i, i + SERVER_EMBED_GROUP);
      const vectors = await embeddingPipeline.embedDocuments(group.map(c => c.text));
      group.forEach((c, j) => embeddings.set(c.id, { embedding: vectors[j], modelId }));
      await onProgress(Math.min(i + group.length, chunks.length));
    }
    return { embeddings, failedChunks, failedItems };
  }

  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    try {
      const result = await embeddingPipeline.embed(chunk.text);
      if (result) embeddings.set(chunk.id, result);
    } catch (embedException: any) {
      // Retry once before giving up on this chunk
      try {
        Zotero.debug(`[ZotSeek] Embedding failed for chunk ${chunk.id} ("${chunk.title}"), retrying: ${embedException?.message || embedException}`);
        await new Promise(resolve => setTimeout(resolve, 500));
        const retryResult = await embeddingPipeline.embed(chunk.text);
        if (retryResult) embeddings.set(chunk.id, retryResult);
      } catch {
        failedChunks++;
        failedItems.add(chunk.title);
        Zotero.debug(`[ZotSeek] Skipping chunk ${chunk.id} ("${chunk.title}") after retry failure: ${embedException?.message || embedException}`);
      }
    }
    await onProgress(i + 1);
    // Yield to UI thread periodically
    if ((i + 1) % 5 === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }
  }
  return { embeddings, failedChunks, failedItems };
}

/**
 * Re-index wrapper around embedChunks that reuses embeddings for chunks whose
 * text has not changed since the item was last indexed under the active
 * model. Builds reuse candidates from the same extracted batch the chunk
 * records come from, so itemId is still in scope, and only sends the
 * genuinely new/changed chunks to embedChunks.
 *
 * Not used by reindexForActiveModel: its items have no chunks under the
 * active model yet, so every lookup would be a guaranteed miss and a wasted
 * query.
 *
 * @param options.knownUnindexed The caller has already established that none
 *   of these items has chunks under the active model (the bulk path filters on
 *   isIndexedByIdentity, which is model-aware). The store lookup would then be
 *   a guaranteed miss: three queries per item, ~45,000 on a 15,000 item
 *   library, all returning nothing. Skips it and embeds everything.
 */
async function embedChunksWithReuse(
  store: IVectorStore,
  extracted: Array<{ itemId: number; chunks: Array<{ index: number; text: string }> }>,
  chunks: ChunkForEmbedding[],
  onProgress: (processed: number) => Promise<void> | void,
  options?: { knownUnindexed?: boolean },
): Promise<EmbedChunksResult> {
  const modelId = getActiveModelId();

  const stored: StoredEmbeddings = { modelId, byItem: new Map() };
  if (!options?.knownUnindexed) {
    for (const { itemId } of extracted) {
      if (stored.byItem.has(itemId)) continue;
      const item = Zotero.Items.get(itemId);
      const identity = item ? identityFromItem(item) : null;
      if (!identity) continue;
      stored.byItem.set(
        itemId,
        await store.getChunkTextEmbeddings(identity.libraryKey, identity.itemKey, modelId)
      );
    }
  }

  const candidates: ReuseCandidate[] = [];
  for (const e of extracted) {
    for (const chunk of e.chunks) {
      candidates.push({ id: `${e.itemId}_${chunk.index}`, itemId: e.itemId, text: chunk.text });
    }
  }

  const { toEmbed, reused } = splitReusable(candidates, stored, modelId);
  if (reused.size > 0) {
    Zotero.debug(`[ZotSeek] Reusing ${reused.size} of ${candidates.length} embeddings; embedding ${toEmbed.length}`);
  }

  const wanted = new Set(toEmbed.map(c => c.id));
  // Count the reused chunks as already processed, otherwise the caller's
  // percentage divides progress by the unfiltered chunk count and under-reports.
  const result = await embedChunks(
    chunks.filter(c => wanted.has(c.id)),
    (processed) => onProgress(processed + reused.size)
  );
  for (const [key, value] of reused) {
    result.embeddings.set(key, value);
  }
  // A fully reused batch never enters embedChunks' loop, so onProgress — where
  // the callers put their pause and cancel checks — would never fire and Cancel
  // would do nothing for that batch. Report completion once, unconditionally.
  await onProgress(reused.size + toEmbed.length);
  return result;
}

/**
 * Chunk types that carry document body text, as opposed to the title/abstract
 * summary chunk or a child note. 'fulltext' is not produced by the current
 * chunker but is a stored text_source value, so it is listed for safety.
 */
const DOCUMENT_CHUNK_TYPES = new Set<string>(['methods', 'findings', 'content', 'fulltext']);

/**
 * Whether the item has a PDF attachment registered in Zotero, regardless of
 * whether its file can be opened right now. An unreachable file is precisely
 * the case this is used to detect, so file existence is deliberately not part
 * of the test.
 */
async function hasPDFAttachment(item: any): Promise<boolean> {
  try {
    const attachmentIDs: number[] = item?.getAttachments?.() || [];
    for (const attId of attachmentIDs) {
      const att = await Zotero.Items.getAsync(attId);
      if (!att || typeof att.isAttachment !== 'function' || !att.isAttachment()) continue;
      if ((att.attachmentMIMEType || '') === 'application/pdf') return true;
      const path = att.getFilePath?.() || '';
      if (path && /\.pdf$/i.test(path)) return true;
    }
  } catch (e: any) {
    Zotero.debug(`[ZotSeek] hasPDFAttachment failed for item ${item?.id}: ${e?.message || e}`);
  }
  return false;
}

/**
 * Decide which of the freshly extracted items a RE-INDEX path may write.
 *
 * Two paths replace an already-indexed item's chunks rather than adding to
 * them: the auto-index path, which runs unattended off an ordinary user
 * action, and the notes backfill, whose candidate set is by definition items
 * that already have chunks under the active model. Both are more exposed than
 * ordinary bulk indexing, which only ever writes items that have no chunks
 * yet and so can never overwrite anything.
 *
 * Two guards, both drops rather than partial writes:
 *
 *  - Unchanged content. The stored hash for the active model already matches,
 *    so the write would produce byte-identical chunks. This removes the entire
 *    no-op re-index path, which is the common case for note notifications.
 *  - A previously-indexed item's full mode re-index produced no document body
 *    although the item has a PDF. The file is unreachable (a linked file on an
 *    unmounted volume, download-as-needed) or PDFWorker failed; replacing a
 *    fully indexed paper with a single summary chunk would be invisible
 *    damage, because item_models survives so the item still reads as indexed
 *    and every bulk path skips it afterwards. Only clearing and rebuilding the
 *    index repairs that. This guard only applies to a genuine re-index: an
 *    item's first indexing pass falls through and is written abstract-only,
 *    same as before this guard existed, so a scanned/image-only PDF (which
 *    never has extractable text) or an ordinary PDF whose extraction simply
 *    hasn't finished yet still gets its imperfect-but-real abstract-only
 *    index instead of being skipped forever.
 *
 * Module-level rather than a class method: SpiderMonkey does not reliably
 * register methods added to the class compiled into this esbuild IIFE bundle.
 */
async function filterReindexTargets(
  store: IVectorStore,
  extracted: ExtractedChunks[],
  indexingMode: string,
  logger: { info: (...args: any[]) => void; warn: (...args: any[]) => void },
): Promise<ExtractedChunks[]> {
  const modelId = getActiveModelId();
  const keep: ExtractedChunks[] = [];

  for (const e of extracted) {
    const item = Zotero.Items.get(e.itemId);
    const identity = item ? identityFromItem(item) : null;

    if (identity) {
      let changed = true;
      try {
        changed = await store.needsReindexByIdentity(
          identity.libraryKey, identity.itemKey, e.contentHash, modelId
        );
      } catch (err: any) {
        // A failed lookup must not block indexing; fall through and write.
        logger.warn(`Re-index check failed for "${e.title}": ${err?.message || err}`);
      }
      if (!changed) {
        logger.info(`Skipping "${e.title}": content unchanged since the last index`);
        continue;
      }
    }

    if (indexingMode === 'full' && !e.chunks.some(c => DOCUMENT_CHUNK_TYPES.has(c.type))) {
      let alreadyIndexed = false;
      if (identity) {
        try {
          alreadyIndexed = await store.isIndexedByIdentity(identity.libraryKey, identity.itemKey);
        } catch (err: any) {
          // A failed lookup must not block indexing; fall through and write.
          logger.warn(`Indexed-status check failed for "${e.title}": ${err?.message || err}`);
        }
      }

      if (alreadyIndexed && item && await hasPDFAttachment(item)) {
        logger.warn(
          `Skipping re-index of "${e.title}": full mode produced no document text ` +
          `although the item has a PDF and was already indexed (file unreachable or ` +
          `extraction failed). Keeping the existing chunks rather than replacing them ` +
          `with a summary.`
        );
        continue;
      }
    }

    keep.push(e);
  }

  return keep;
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
  private collectionMenuPopupHandler: ((event: Event) => void) | null = null;

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
   */
  private initDefaultPreferences(): void {
    const Z = getZotero();
    if (!Z) return;

    // Store minSimilarity as int (30 = 0.3, divide by 100 when reading)
    // Using nomic-embed-text-v1.5 with 8192 token context window
    const defaults: { [key: string]: any } = {
      'zotseek.minSimilarityPercent': 30,  // 30% = 0.3
      'zotseek.topK': 20,
      'zotseek.autoIndex': false,
      'zotseek.autoIndexDelay': 10,   // Seconds to wait after last item before auto-indexing
      'zotseek.indexingMode': 'full',  // 'abstract' or 'full' - full paper mode is default for better search quality
      'zotseek.maxTokens': 2000,       // Firefox 140+ handles larger chunks efficiently
      'zotseek.maxChunksPerPaper': 100,
      'zotseek.excludeBooks': true,        // Exclude books from search/indexing by default
      'zotseek.excludeTag': 'zotseek-exclude', // Tag name to exclude items from indexing
      'zotseek.indexStatusColumn.firstShown': false, // First-run flag for index-status column
      'zotseek.mcpServer.enabled': false, // Opt-in local MCP/REST endpoints for AI agents
      'zotseek.embeddingModel': 'nomic-embed-text-v1.5',
      'zotseek.indexScope': 'user', // 'user' (My Library) or 'all' (all libraries)
      'zotseek.serverModels': '[]', // JSON array of server-backed model entries (issue #42)
      'zotseek.autoCompact': true, // Reclaim space in zotseek.sqlite during Zotero's idle maintenance (Zotero 10+)
      'zotseek.indexNotes': false,      // Index child note text with the parent item (issue #50)
      'zotseek.noteIndexDelay': 60,     // Quiet period in seconds before re-indexing after a note edit
      'zotseek.searchHistory': '[]',    // JSON array of the last 10 queries run in the search dialog, newest first
      // Experimental: run embeddings on the GPU via WebGPU (Zotero 11+ only).
      // Off by default: Firefox 153's WebGPU is 6-11x SLOWER than the WASM
      // path for this workload (measured on Apple Silicon; see issue #2).
      // The GPU path also needs fp16 weights (onnx/model_fp16.onnx), which
      // are not bundled.
      'zotseek.webgpu.enabled': false,
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

    // Map resource://zotseek-models/ to the profile-side models directory so
    // Transformers.js in the ChromeWorker can load downloaded models locally.
    try {
      registerModelsResourceSubstitution();
      const reason = verifyModelsResourceSubstitution();
      if (reason !== null) {
        // Not fatal: the bundled model resolves over chrome:// and still works.
        // But every downloaded model is unloadable until this is fixed, so say
        // so at error level rather than leaving it to a later, opaque failure.
        this.logger.error(`models resource substitution is not usable (${reason}); downloaded models will not load`);
      }
    } catch (e: any) {
      this.logger.error(`models resource substitution failed: ${e?.message || e}; downloaded models will not load`);
    }

    // Local MCP/REST endpoints for AI agents (opt-in via preferences)
    initServerManager();

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

    // If a previous bulk indexing run was interrupted (cancel, crash, sleep,
    // plugin reload), offer to resume. Runs after auto-index manager so its
    // state is settled. Non-blocking — failure here doesn't fail startup.
    this.checkAndOfferResume().catch((e: any) => {
      this.logger.debug(`checkAndOfferResume failed: ${e?.message || e}`);
    });

    // Piggyback on Zotero's idle database maintenance to compact our own
    // attached database (Zotero 10+; no-op on older versions).
    this.registerIdleCompaction();

    // Register the item-tree index-status column.
    // Needs the vector store to be initialised — do it lazily by ensuring
    // the store is ready first, but only if the user opens it later. To keep
    // startup snappy we register the column with a getter that will trigger
    // lazy init on first lookup.
    try {
      // Lazy: pass a vector store wrapper that triggers ensureStoreReady on demand
      await this.ensureStoreReady();
      if (this.vectorStore) {
        await itemTreeIndexColumn.register(this.vectorStore);
        this.logger.info('Item-tree index-status column registered');
      }
    } catch (e: any) {
      this.logger.warn(`Could not register item-tree column: ${e?.message || e}`);
    }

    // Dev-only self-test harness (gated by extensions.zotseek.devMode pref)
    try {
      const devMode = Z.Prefs.get('zotseek.devMode', true) === true;
      if (devMode) {
        Z.ZotSeek = Z.ZotSeek || {};
        Z.ZotSeek._selfTest = zotseekSelfTest;

        // Turn on debug capture too. Zotero.debug() output is discarded unless
        // both of these are set, so without it the harness runs but its logs --
        // and any swallowed exception it was meant to surface -- are lost.
        try {
          Z.Debug.init(true);
          Z.Debug.setStore(true);
        } catch (e: any) {
          this.logger.debug(`Could not enable debug capture: ${e?.message || e}`);
        }

        this.logger.info('Self-test harness mounted (devMode=true, debug capture on)');
      }
    } catch (e: any) {
      this.logger.warn(`Self-test harness failed to mount: ${e?.message || e}`);
    }

    this.logger.info('=== Plugin Started Successfully ===');
    this.logInstallOrigin();
  }

  /**
   * Log where the plugin's code was actually loaded from.
   *
   * An installed XPI silently overrides a dev-mode proxy file, even when Zotero
   * is started with -purgecaches, so a rebuild appears to have no effect and
   * nothing in the UI says why. `rootURI` tells the two apart at a glance:
   *
   *   file:///.../zotseek/build/     proxy file, changes take effect
   *   jar:file:///...xpi!/           packaged XPI, the build directory is ignored
   *
   * Cheap enough to always emit; the alternative is remembering to ask
   * AddonManager by hand every time something looks stale.
   */
  private logInstallOrigin(): void {
    try {
      const rootURI = this.info?.rootURI || '';
      const mode = rootURI.startsWith('jar:')
        ? 'packaged XPI (rebuilds of the build/ directory will NOT take effect)'
        : 'unpackaged directory (dev proxy file)';
      this.logger.info(`Loaded from ${mode}: ${rootURI || 'unknown'}`);
    } catch (e: any) {
      this.logger.debug(`Could not determine install origin: ${e?.message || e}`);
    }
  }

  /**
   * Register a callback on Zotero's idle database maintenance so zotseek.sqlite
   * gets compacted without the user having to find the button in preferences.
   *
   * Zotero 10 runs backup + VACUUM after 300s of idle, and offers onIdle so
   * owners of ATTACHed databases can reclaim their own space in the same
   * window -- its own VACUUM covers only the main database, as its source says.
   *
   * The callbacks run on every idle pass, even when Zotero's own vacuum
   * declines to run (it is throttled to roughly fortnightly). Our throttle is
   * therefore the reclaimable-bytes threshold below, not Zotero's schedule. `zotseek.sqlite` fragments heavily after re-indexes, model
   * switches and orphan purges, so this is where that space comes back.
   *
   * Absent before Zotero 10, so feature-detected; older versions keep the
   * manual Compact Database button as the only path.
   */
  private registerIdleCompaction(): void {
    const Z = getZotero();
    if (typeof Z?.DB?.onIdle !== 'function') {
      this.logger.debug('Zotero.DB.onIdle unavailable; automatic compaction disabled');
      return;
    }

    Z.DB.onIdle(async () => {
      try {
        await this.runIdleCompaction();
      } catch (e: any) {
        // Never let this escape into Zotero's maintenance loop.
        this.logger.error(`Idle compaction failed: ${e?.message || e}`);
      }
    });

    this.logger.info('Registered Zotero.DB.onIdle hook for automatic compaction');
  }

  /**
   * Decide whether an idle pass should compact, and do it if so.
   *
   * compactDatabase() runs DETACH -> IOUtils.move -> ATTACH, which would pull
   * the schema out from under an in-flight indexing run or search, hence the
   * guards. The
   * size threshold matches the one the preferences button label already uses:
   * below ~10 MB the VACUUM costs more than the space it returns.
   */
  private async runIdleCompaction(): Promise<void> {
    const Z = getZotero();

    if (Z?.Prefs.get('zotseek.autoCompact', true) === false) return;
    if (this.indexing) {
      this.logger.debug('Idle compaction skipped: indexing in progress');
      return;
    }
    if (isSearchInProgress()) {
      // The idle observer needs 300s without user input, so a human searching
      // in the dialog cannot collide with this. An agent searching over the
      // MCP/REST server while the user is away from the machine can.
      this.logger.debug('Idle compaction skipped: search in progress');
      return;
    }
    if (!this.vectorStore?.isReady?.()) return;

    const reclaimable = Number(await (this.vectorStore as any).getReclaimableBytes?.()) || 0;
    if (reclaimable < IDLE_COMPACT_MIN_BYTES) {
      this.logger.debug(`Idle compaction skipped: only ${reclaimable} bytes reclaimable`);
      return;
    }

    this.logger.info(`Idle compaction starting (${reclaimable} bytes reclaimable)`);
    const { beforeBytes, afterBytes } = await (this.vectorStore as any).compactDatabase();
    this.logger.info(`Idle compaction done: ${beforeBytes} -> ${afterBytes} bytes`);
  }

  /**
   * If a previous bulk-indexing run was interrupted, offer the user a chance
   * to resume it. The intent (library or collection) was persisted by
   * `indexItems` when the run started; we only ask if there are still
   * un-indexed items in that scope.
   */
  private async checkAndOfferResume(): Promise<void> {
    const Z = getZotero();
    if (!Z) return;

    const PENDING_PREF = 'zotseek.bulkIndex.pendingScope';
    let raw: string | undefined;
    try {
      raw = Z.Prefs.get(PENDING_PREF, true) as string | undefined;
    } catch {
      return;
    }
    if (!raw) return;

    let scope: BulkScope | null = null;
    try {
      scope = JSON.parse(raw) as BulkScope;
    } catch {
      // Corrupt pref — clear it and move on
      try { Z.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }
      return;
    }

    // Rebuild the candidate item list for the recorded scope, then ask the
    // user whether to resume. Cheap to compute (no embedding work yet).
    let items: any[] = [];
    let label = '';
    try {
      if (scope.type === 'notes-backfill') {
        // Rebuilt through the same selection the menu action uses, so a
        // resumed backfill works from the same rules as the run it resumes.
        await this.ensureStoreReady();
        if (!this.vectorStore) return;
        items = await collectNoteBackfillItems(
          this.zoteroAPI,
          scope.libraryIds,
          makeNoteBackfillDeps(this.vectorStore),
        );
        label = getString('resume-scopeNotes');
      } else if (scope.type === 'all-libraries') {
        items = await this.zoteroAPI.getAllLibraryItems();
        label = getString('resume-scopeLibrary');
      } else if (scope.type === 'library') {
        items = await this.zoteroAPI.getLibraryItems(scope.libraryId);
        const userLibraryID = Z.Libraries.userLibraryID;
        label = scope.libraryId === userLibraryID
          ? getString('resume-scopeUserLibrary')
          : getString('resume-scopeLibrary');
      } else if (scope.type === 'collections') {
        // Same helper as onIndexCollection, so the two can never drift.
        items = await collectCollectionItems(this.zoteroAPI, scope.collections);
        label = getString('resume-scopeCollections', { count: scope.collections.length });
      } else {
        items = await this.zoteroAPI.getCollectionItems(scope.collectionId, scope.libraryId);
        const collection = await Z.Collections.getAsync(scope.collectionId);
        label = collection?.name
          ? getString('resume-scopeCollection', { name: collection.name })
          : getString('resume-scopeCollection', { name: '?' });
      }
    } catch (e: any) {
      this.logger.debug(`checkAndOfferResume: could not rebuild scope: ${e?.message || e}`);
      try { Z.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }
      return;
    }

    // Filter out items that are already indexed — they're done, so no
    // resume work is needed for them.
    await this.ensureStoreReady();
    if (!this.vectorStore) return;

    const pending: any[] = [];
    if (scope.type === 'notes-backfill') {
      // Every backfill candidate is already indexed by definition, so the
      // not-indexed filter below would throw the whole list away. The scope's
      // own selection has already applied the equivalent rules. Items the
      // interrupted run had already reached are re-listed here and dropped
      // after extraction by the unchanged-content guard, so they cost a second
      // extraction but are never re-embedded or re-written.
      pending.push(...items);
    } else {
      for (const item of items) {
        if (!item?.isRegularItem?.()) continue;
        if (hasExcludeTag(item)) continue;
        const identity = identityFromItem(item);
        if (!identity) continue;
        const indexed = await this.vectorStore.isIndexedByIdentity(identity.libraryKey, identity.itemKey);
        if (!indexed) pending.push(item);
      }
    }

    if (pending.length === 0) {
      // Nothing left to do — clear the marker silently.
      try { Z.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }
      this.logger.info('Resume marker found but no pending items — clearing');
      return;
    }

    const win = Z.getMainWindow();
    const proceed = Services.prompt.confirm(
      win,
      getString('resume-title'),
      getString('resume-message', { count: pending.length, scope: label })
    );

    if (!proceed) {
      try { Z.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }
      this.logger.info('User declined resume — clearing marker');
      return;
    }

    this.logger.info(`Resuming bulk index for ${pending.length} items (${label})`);
    await this.indexItems(pending, scope);
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
            const cleanedIds: number[] = [];
            for (const id of ids) {
              const numericId = typeof id === 'string' ? parseInt(id, 10) : id;
              if (isNaN(numericId)) continue;
              // A trashed item is still there to read the stable identity
              // off. A permanently erased one is gone, and Zotero passes its
              // {libraryID, key} in extraData instead; without that the
              // legacy id-based shim below finds nothing (local ids are not
              // stored since schema v8) and the rows were left behind.
              const item = Zotero.Items.get(numericId);
              const identity = item
                ? identityFromItem(item)
                : identityFromNotifierData(_extraData?.[numericId], libraryKeyFromLocalID);
              if (identity) {
                await this.vectorStore.deleteItem(identity.libraryKey, identity.itemKey);
                cleanedIds.push(numericId);
                cleaned++;
                continue;
              }
              // Fallback for items that no longer have a resolvable identity
              await this.vectorStore.delete(numericId);
              cleanedIds.push(numericId);
              cleaned++;
            }

            if (cleaned > 0) {
              itemTreeIndexColumn.invalidate(cleanedIds);
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
   */
  private registerWithXUL(Z: any): void {
    this.logger.info('Registering menus via XUL injection');

    const win = Z.getMainWindow();
    if (!win) {
      this.logger.warn('No main window available for XUL injection');
      return;
    }

    const doc = win.document;

    // Collection-pane menu (issue #61). Registered before the item menu so a
    // missing item menu cannot take it down with it.
    const collectionMenu = doc.getElementById('zotero-collectionmenu');
    if (!collectionMenu) {
      this.logger.warn('Could not find zotero-collectionmenu');
    } else if (!doc.getElementById('zotseek-collection-submenu')) {
      const collectionSeparator = doc.createXULElement('menuseparator');
      collectionSeparator.id = 'zotseek-collection-separator';

      const collectionSubmenu = doc.createXULElement('menu');
      collectionSubmenu.id = 'zotseek-collection-submenu';
      collectionSubmenu.setAttribute('label', getString('menu-submenu'));

      const collectionSubmenuPopup = doc.createXULElement('menupopup');
      collectionSubmenuPopup.id = 'zotseek-collection-submenu-popup';
      collectionSubmenu.appendChild(collectionSubmenuPopup);

      const collectionOpenSearchItem = doc.createXULElement('menuitem');
      collectionOpenSearchItem.id = 'zotseek-collection-open-dialog';
      collectionOpenSearchItem.setAttribute('label', getString('menu-openZotSeek'));
      collectionOpenSearchItem.addEventListener('command', () => searchDialogWithVTable.open());

      const collectionSubmenuSeparator = doc.createXULElement('menuseparator');
      collectionSubmenuSeparator.id = 'zotseek-collection-submenu-separator';

      const collectionIndexItem = doc.createXULElement('menuitem');
      collectionIndexItem.id = 'zotseek-collection-index-collection';
      collectionIndexItem.setAttribute('label', getString('menu-indexCollection'));
      collectionIndexItem.addEventListener('command', () => this.onIndexCollection());

      const collectionIndexLibraryItem = doc.createXULElement('menuitem');
      collectionIndexLibraryItem.id = 'zotseek-collection-index-library';
      collectionIndexLibraryItem.setAttribute('label', getString('menu-updateLibrary'));
      collectionIndexLibraryItem.addEventListener('command', () => this.onIndexLibrary());

      collectionSubmenuPopup.appendChild(collectionOpenSearchItem);
      collectionSubmenuPopup.appendChild(collectionSubmenuSeparator);
      collectionSubmenuPopup.appendChild(collectionIndexItem);
      collectionSubmenuPopup.appendChild(collectionIndexLibraryItem);

      collectionMenu.appendChild(collectionSeparator);
      collectionMenu.appendChild(collectionSubmenu);

      // Zotero only toggles the menu entries it owns, so ours would otherwise
      // show on libraries, feeds, saved searches and the trash too. The
      // selection is final by now: Zotero awaits buildCollectionContextMenu()
      // before it opens the popup.
      this.collectionMenuPopupHandler = (event: Event) => {
        if (event.target !== collectionMenu) return;
        const hidden = !shouldShowCollectionMenu((win as any).ZoteroPane);
        collectionSeparator.hidden = hidden;
        collectionSubmenu.hidden = hidden;
      };
      collectionMenu.addEventListener('popupshowing', this.collectionMenuPopupHandler);
    }

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

    // Create "Find Similar Documents" menu item (stays at top level: the one
    // action that operates on the specific right-clicked item, and the most
    // frequently used, so it should not cost an extra hover)
    const findSimilarItem = doc.createXULElement('menuitem');
    findSimilarItem.id = 'zotseek-find-similar';
    findSimilarItem.setAttribute('label', getString('menu-findSimilar'));
    findSimilarItem.addEventListener('command', () => this.onFindSimilar());

    // Create the "ZotSeek" submenu that holds every other action
    const submenu = doc.createXULElement('menu');
    submenu.id = 'zotseek-submenu';
    submenu.setAttribute('label', getString('menu-submenu'));

    const submenuPopup = doc.createXULElement('menupopup');
    submenuPopup.id = 'zotseek-submenu-popup';
    submenu.appendChild(submenuPopup);

    // Create "Open ZotSeek" menu item for general search
    const openSearchItem = doc.createXULElement('menuitem');
    openSearchItem.id = 'zotseek-open-dialog';
    openSearchItem.setAttribute('label', getString('menu-openZotSeek'));
    openSearchItem.addEventListener('command', () => searchDialogWithVTable.open());

    const submenuSeparator1 = doc.createXULElement('menuseparator');
    submenuSeparator1.id = 'zotseek-submenu-separator-1';

    // Create "Index Selected" menu item
    const indexSelectedItem = doc.createXULElement('menuitem');
    indexSelectedItem.id = 'zotseek-index-selected';
    indexSelectedItem.setAttribute('label', getString('menu-indexSelected'));
    indexSelectedItem.addEventListener('command', () => this.onIndexSelected());

    // Create "Index Collection" menu item
    const indexCollectionItem = doc.createXULElement('menuitem');
    indexCollectionItem.id = 'zotseek-index-collection';
    indexCollectionItem.setAttribute('label', getString('menu-indexCollection'));
    indexCollectionItem.addEventListener('command', () => this.onIndexCollection());

    // Create "Index Library" menu item
    const indexLibraryItem = doc.createXULElement('menuitem');
    indexLibraryItem.id = 'zotseek-index-library';
    indexLibraryItem.setAttribute('label', getString('menu-updateLibrary'));
    indexLibraryItem.addEventListener('command', () => this.onIndexLibrary());

    // Create "Add Note Text to Index" menu item
    const backfillNotesItem = doc.createXULElement('menuitem');
    backfillNotesItem.id = 'zotseek-backfill-notes';
    backfillNotesItem.setAttribute('label', getString('menu-backfillNotes'));
    backfillNotesItem.addEventListener('command', () => this.onBackfillNotes());

    const submenuSeparator2 = doc.createXULElement('menuseparator');
    submenuSeparator2.id = 'zotseek-submenu-separator-2';

    // Create "Remove from Index" menu item
    const removeFromIndexItem = doc.createXULElement('menuitem');
    removeFromIndexItem.id = 'zotseek-remove-from-index';
    removeFromIndexItem.setAttribute('label', getString('menu-removeFromIndex'));
    removeFromIndexItem.addEventListener('command', () => this.onRemoveFromIndex());

    submenuPopup.appendChild(openSearchItem);
    submenuPopup.appendChild(submenuSeparator1);
    submenuPopup.appendChild(indexSelectedItem);
    submenuPopup.appendChild(indexCollectionItem);
    submenuPopup.appendChild(indexLibraryItem);
    submenuPopup.appendChild(backfillNotesItem);
    submenuPopup.appendChild(submenuSeparator2);
    submenuPopup.appendChild(removeFromIndexItem);

    itemMenu.appendChild(separator);
    itemMenu.appendChild(findSimilarItem);
    itemMenu.appendChild(submenu);

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
        label: getString('pref-title'),
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
      getString('indexing-clearConfirmTitle'),
      getString('indexing-clearConfirmMsg')
    );

    if (!confirmed) return;

    // Create stable progress window for clearing
    const progressWindow = new StableProgressWindow({
      title: getString('indexing-clearTitle'),
    });

    try {
      progressWindow.updateProgress(getString('indexing-initStorage'), null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        progressWindow.updateProgress(getString('indexing-deletingAll'), 50);
        await this.vectorStore.clear();

        progressWindow.complete(getString('indexing-clearedSuccess'));
        this.logger.info('Index cleared via preferences');

        // Show additional alert for confirmation
        setTimeout(() => {
          this.showAlert(getString('indexing-clearedMsg'));
        }, 500);
      }
    } catch (error: any) {
      this.logger.error(`Failed to clear index: ${error}`);
      progressWindow.error(`Failed to clear index: ${error.message || error}`, true);
      this.showAlert(`Failed to clear index: ${error.message || error}`);
    }
  }

  /**
   * Public method to index all libraries (called from preferences pane)
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
      getString('indexing-rebuildConfirmTitle'),
      getString('indexing-rebuildConfirmMsg')
    );

    if (!confirmed) return;

    // First clear the index
    const progressWindow = new StableProgressWindow({
      title: getString('indexing-rebuildingTitle'),
    });

    try {
      progressWindow.updateProgress(getString('indexing-clearingExisting'), null);
      await this.ensureStoreReady();

      if (this.vectorStore) {
        await this.vectorStore.clear();
        this.logger.info('Index cleared for rebuild');
        progressWindow.addLine(getString('indexing-existingCleared'), 'chrome://zotero/skin/tick.png');

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

      setText('zotseek-stat-papers', getString('indexing-loading'));

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
   * Compact the database to reclaim space after migrations or deletions.
   */
  public async compactDatabase(): Promise<string> {
    await this.ensureStoreReady();
    if (!this.vectorStore) throw new Error('Store not ready');
    if (this.indexing) throw new Error('Cannot compact while indexing is in progress');

    const result = await (this.vectorStore as any).compactDatabase();
    const beforeMB = (result.beforeBytes / (1024 * 1024)).toFixed(1);
    const afterMB = (result.afterBytes / (1024 * 1024)).toFixed(1);
    const savedMB = ((result.beforeBytes - result.afterBytes) / (1024 * 1024)).toFixed(1);
    return `Compacted: ${beforeMB} MB -> ${afterMB} MB (saved ${savedMB} MB)`;
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
      this.showAlert(getString('indexing-alreadyInProgress'));
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    const selectedItems = this.zoteroAPI.getSelectedItems();
    if (selectedItems.length === 0) {
      this.showAlert(getString('indexing-selectItems'));
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
      this.showAlert(getString('indexing-alreadyInProgress'));
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // Get the selected collections using ZoteroPane. Zotero 10 removed the
    // singular getter in favour of a plural one for multi-collection selection;
    // the old name still exists but throws, so feature-detect the new one and
    // fall back for Zotero 8/9, where only one collection can be selected.
    const ZoteroPane = Z.getActiveZoteroPane();
    const collections: any[] = typeof ZoteroPane?.getSelectedCollections === 'function'
      ? (ZoteroPane.getSelectedCollections() || [])
      : [ZoteroPane?.getSelectedCollection()].filter(Boolean);

    if (collections.length === 0) {
      this.showAlert(getString('indexing-selectCollection'));
      return;
    }

    const items = await collectCollectionItems(
      this.zoteroAPI,
      collections.map((c: any) => ({ libraryId: c.libraryID, collectionId: c.id })),
    );

    if (items.length === 0) {
      this.showAlert(collections.length === 1
        ? getString('indexing-emptyCollection', { name: collections[0].name })
        : getString('indexing-emptyCollections', { count: collections.length }));
      return;
    }

    // Keep the single-collection scope shape: it is what 1.19.0 wrote, so a
    // pending marker stays readable across the upgrade, and it gives the
    // resume prompt a collection name instead of a bare count.
    const scope: BulkScope = collections.length === 1
      ? { type: 'collection', libraryId: collections[0].libraryID, collectionId: collections[0].id }
      : {
        type: 'collections',
        collections: collections.map((c: any) => ({ libraryId: c.libraryID, collectionId: c.id })),
      };

    const label = collections.map((c: any) => `"${c.name}"`).join(', ');
    this.logger.info(`Indexing ${collections.length} collection(s) ${label} (${items.length} items)`);
    await this.indexItems(items, scope);
  }

  /**
   * Read the user's index scope preference.
   * 'user' = My Library only, 'all' = all libraries (user + groups).
   */
  private getIndexScope(): 'user' | 'all' {
    const Z = getZotero();
    try {
      const scope = Z?.Prefs.get('zotseek.indexScope', true);
      if (scope === 'all') return 'all';
    } catch (e: any) {
      this.logger.debug(`Could not read indexScope pref: ${e?.message || e}`);
    }
    return 'user';
  }

  /**
   * Index all libraries (user + groups)
   */

  private async onIndexLibrary(): Promise<void> {
    if (this.indexing) {
      this.showAlert(getString('indexing-alreadyInProgress'));
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    const scope = this.getIndexScope();
    const userLibraryID = Z.Libraries.userLibraryID;

    let items: any[];
    let bulkScope: BulkScope;
    let scopeLabel: string;
    if (scope === 'all') {
      this.logger.info('Indexing all libraries');
      items = await this.zoteroAPI.getAllLibraryItems();
      bulkScope = { type: 'all-libraries' };
      scopeLabel = getString('indexing-scopeAll');
    } else {
      this.logger.info('Indexing user library only');
      items = await this.zoteroAPI.getLibraryItems(userLibraryID);
      bulkScope = { type: 'library', libraryId: userLibraryID };
      scopeLabel = getString('indexing-scopeUser');
    }
    this.logger.info(`Found ${items.length} items to index`);

    const confirmed = Services.prompt.confirm(
      Z.getMainWindow(),
      getString('indexing-updateTitle'),
      getString('indexing-updateConfirmMsg', { scope: scopeLabel })
    );

    if (!confirmed) return;

    await this.indexItems(items, bulkScope);
  }

  /**
   * Backfill note text into items that are already in the index.
   *
   * Update Library Index decides what to skip by presence, not by content, so
   * switching note indexing on leaves an already-indexed library exactly as it
   * was: the items whose notes are missing are precisely the ones that path
   * refuses to touch. This is the one bulk action that re-indexes items that
   * are already there, and it is limited to the items that can gain from it.
   */
  private async onBackfillNotes(): Promise<void> {
    if (this.indexing) {
      this.showAlert(getString('indexing-alreadyInProgress'));
      return;
    }

    const Z = getZotero();
    if (!Z) return;

    // With note indexing off, every candidate would be re-indexed to produce
    // exactly the chunks it already has. Nothing to do but say so.
    if (!isNoteIndexingEnabled()) {
      this.showAlert(getString('notesBackfill-disabled'));
      return;
    }

    // Same scope rule as Update Library Index, resolved to concrete library
    // ids so the resume marker is not at the mercy of a later pref change.
    const libraryIds = this.getIndexScope() === 'all'
      ? this.zoteroAPI.getAllLibraries().map((lib) => lib.libraryID)
      : [Z.Libraries.userLibraryID];

    await this.ensureStoreReady();
    if (!this.vectorStore) return;

    showQuickNotification(getString('notesBackfill-scanning'), 'default');
    const candidates = await collectNoteBackfillItems(
      this.zoteroAPI,
      libraryIds,
      makeNoteBackfillDeps(this.vectorStore),
    );
    this.logger.info(
      `Notes backfill: ${candidates.length} indexed item(s) with notes across ${libraryIds.length} library/libraries`
    );

    if (candidates.length === 0) {
      this.showAlert(getString('notesBackfill-none'));
      return;
    }

    const confirmed = Services.prompt.confirm(
      Z.getMainWindow(),
      getString('notesBackfill-title'),
      getString('notesBackfill-confirmMsg', { count: candidates.length })
    );
    if (!confirmed) return;

    await this.indexItems(candidates, { type: 'notes-backfill', libraryIds });
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
      showQuickNotification(getString('indexing-noItemsSelected'), 'default');
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
        ? getString('indexing-removedItems', { count: removed })
        : getString('indexing-notInIndex');
      showQuickNotification(msg, removed > 0 ? 'success' : 'default');
      this.logger.info(msg);
    } catch (error: any) {
      this.logger.error(`Failed to remove from index: ${error?.message || error}`);
      showQuickNotification(getString('indexing-removeFailed'), 'fail');
    }
  }

  /**
   * Index items for semantic search
   * Uses the configurable indexing mode (abstract, fulltext, or hybrid)
   *
   * Implements checkpoint/incremental saving:
   * - Skips already-indexed items (allows resuming after crash)
   * - Saves embeddings in batches of ~10 items (prevents total loss on crash)
   * - Memory efficient (only one batch in memory at a time)
   *
   * @param scope - Optional scope marker used to persist "this bulk run is in
   *                progress" so the next startup can offer to resume it after
   *                a crash or sleep. Pass undefined for one-off runs.
   */
  private async indexItems(items: any[], scope?: BulkScope): Promise<void> {
    this.indexing = true;
    const Z = getZotero();

    // A notes backfill is the only run that re-indexes items already in the
    // index, so it is the only one that skips the already-indexed filter and
    // needs the overwrite guards. Derived from the scope marker rather than
    // from a caller-supplied flag: no other path can reach either behaviour,
    // and the crash-resume path gets both for free because it replays the
    // same marker.
    const isNoteBackfill = scope?.type === 'notes-backfill';

    // Persist intent for auto-resume after crash/sleep. Only bother for runs
    // big enough that resuming saves real time — single-item indexing doesn't
    // need to survive a restart.
    const PENDING_PREF = 'zotseek.bulkIndex.pendingScope';
    const RESUME_THRESHOLD = 25;
    if (scope && items.length >= RESUME_THRESHOLD) {
      try {
        Z?.Prefs.set(PENDING_PREF, JSON.stringify(scope), true);
      } catch (e: any) {
        this.logger.debug(`Could not persist resume scope: ${e?.message || e}`);
      }
    }
    const indexStartTime = Date.now(); // Track total indexing time

    // Checkpoint batch size - save every N items to prevent data loss.
    // Kept small (10) so a cancel or crash mid-batch loses at most ~10 items
    // of extraction/embedding work. Trade-off: more transaction overhead.
    const CHECKPOINT_BATCH_SIZE = 10;

    // Create stable progress window using toolkit
    const progressWindow = new StableProgressWindow({
      title: getString('indexing-title'),
      cancelCallback: () => {
        this.indexing = false;
        this.logger.info('Indexing cancelled by user');
      }
    });

    try {
      // Ensure vector store is ready
      progressWindow.updateProgress(getString('indexing-initStorage'), null);
      await this.ensureStoreReady();

      // Get indexing mode
      const indexingMode = getIndexingMode(Z);
      this.logger.info(`Indexing mode: ${indexingMode}`);
      progressWindow.addLine(getString('indexing-mode', { mode: indexingMode }));

      // === PHASE 1: Filter out excluded and already-indexed items ===
      progressWindow.setHeadline(getString('indexing-checking'));
      const itemsToIndex: any[] = [];
      let skippedExcluded = 0;
      for (const item of items) {
        if (hasExcludeTag(item)) {
          skippedExcluded++;
          continue;
        }
        const identity = identityFromItem(item);
        if (!identity) continue;
        if (isNoteBackfill) {
          // Every candidate is already indexed; that filter is exactly what
          // makes the backfill necessary, so it must not run here.
          itemsToIndex.push(item);
          continue;
        }
        const isIndexed = await this.vectorStore!.isIndexedByIdentity(identity.libraryKey, identity.itemKey);
        if (!isIndexed) {
          itemsToIndex.push(item);
        }
      }
      if (skippedExcluded > 0) {
        this.logger.info(`Skipped ${skippedExcluded} items with exclusion tag`);
        progressWindow.addLine(getString('indexing-skippedExcluded', { count: skippedExcluded }), 'chrome://zotero/skin/tick.png');
      }
      const skippedAlreadyIndexed = items.length - itemsToIndex.length - skippedExcluded;
      if (skippedAlreadyIndexed > 0) {
        this.logger.info(`Skipped ${skippedAlreadyIndexed} already-indexed items`);
        progressWindow.addLine(getString('indexing-skippedIndexed', { count: skippedAlreadyIndexed }), 'chrome://zotero/skin/tick.png');
      }

      // If all items are already indexed, we're done
      if (itemsToIndex.length === 0) {
        progressWindow.setHeadline(getString('indexing-allIndexed'));
        progressWindow.addLine(getString('indexing-allInIndex', { count: items.length }), 'chrome://zotero/skin/tick.png');
        progressWindow.complete(getString('indexing-nothingToIndex'), true);
        return;
      }

      // Reset pipeline to ensure fresh initialization
      embeddingPipeline.reset();

      progressWindow.updateProgress(getString('indexing-loadingModel'), null);
      await embeddingPipeline.init();
      this.logger.info('Embedding pipeline initialized (Transformers.js)')
      progressWindow.addLine(getString('indexing-modelLoaded'), 'chrome://zotero/skin/tick.png');

      // === PHASE 2: Process items in batches with checkpoints ===
      const totalBatches = Math.ceil(itemsToIndex.length / CHECKPOINT_BATCH_SIZE);
      let totalItemsIndexed = 0;
      let totalChunksIndexed = 0;
      let totalItemsSkipped = 0; // Items with no extractable content
      let totalItemsGuarded = 0; // Re-index targets dropped by filterReindexTargets
      let totalItemsTruncated = 0; // Items where maxChunksPerPaper cut content
      const truncatedTitles: string[] = []; // For end-of-run summary log
      let totalItemsFailed = 0; // Items whose extraction raised an error
      const failedTitles: string[] = []; // For end-of-run summary log

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
        progressWindow.setHeadline(getString('indexing-batchExtracting', { current: batchNumber, total: totalBatches }));
        this.logger.info(`Batch ${batchNumber}/${totalBatches}: Extracting ${batchItems.length} items`);

        const batchFailures: string[] = [];
        const extractedRaw = await textExtractor.extractChunksFromItems(
          batchItems,
          indexingMode,
          undefined,
          (progress) => {
            if (progressWindow.isCancelled()) {
              throw new Error('Cancelled by user');
            }
            // An item that raised an error is not the same as one with no
            // text, and the user can only act on the first if they are told
            // which item it was (#54). currentTitle carries the description.
            if (progress.status === 'error') {
              batchFailures.push(progress.currentTitle);
              return;
            }
            progressWindow.updateProgressWithETA(
              `Batch ${batchNumber}/${totalBatches}: ${progress.currentTitle}`,
              batchStart + progress.current,
              itemsToIndex.length
            );
          }
        );

        if (batchFailures.length > 0) {
          const itemList = batchFailures.join(', ');
          totalItemsFailed += batchFailures.length;
          failedTitles.push(...batchFailures);
          this.logger.warn(`Batch ${batchNumber}: ${batchFailures.length} items could not be extracted: ${itemList}`);
          progressWindow.addLine(getString('indexing-extractionFailed', { count: batchFailures.length, items: itemList }));
        }

        const batchSkipped = batchItems.length - extractedRaw.length;
        totalItemsSkipped += batchSkipped;

        // A backfill overwrites items that are already indexed, so it carries
        // the same two drops the auto-index path does: an unchanged content
        // hash (the notes are already in the index and the write would be
        // byte-identical), and a full-mode run that produced no document text
        // for an item that has a PDF, where writing would replace a whole
        // paper with a summary plus its notes because the file is unreachable.
        // Ordinary bulk indexing only writes items with no chunks at all, so
        // it has nothing to overwrite and skips the check.
        const extractedBatch = isNoteBackfill
          ? await filterReindexTargets(this.vectorStore!, extractedRaw, indexingMode, this.logger)
          : extractedRaw;
        totalItemsGuarded += extractedRaw.length - extractedBatch.length;

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

        progressWindow.setHeadline(getString('indexing-batchEmbedding', { current: batchNumber, total: totalBatches }));
        this.logger.info(`Batch ${batchNumber}/${totalBatches}: Embedding ${batchChunks.length} chunks`);

        const { embeddings: embeddingMap, failedChunks, failedItems } = await embedChunksWithReuse(
          this.vectorStore!,
          extractedBatch,
          batchChunks,
          async (processed) => {
            await progressWindow.waitIfPaused();
            if (progressWindow.isCancelled()) {
              throw new Error('Cancelled by user');
            }
            progressWindow.updateProgressWithETA(
              getString('indexing-batchEmbeddingChunks', { current: batchNumber, total: totalBatches }),
              batchStart + Math.floor((processed / Math.max(batchChunks.length, 1)) * batchItems.length),
              itemsToIndex.length
            );
          },
          // Phase 1 kept only items isIndexedByIdentity said were NOT indexed
          // under the active model, so there is nothing to reuse there and the
          // lookup would be a guaranteed miss. A notes backfill is the
          // opposite case: every item already has chunks under the active
          // model and only its note chunks are new, so the lookup pays for
          // itself and the document chunks are never re-embedded.
          { knownUnindexed: !isNoteBackfill }
        );

        if (failedChunks > 0) {
          const itemList = Array.from(failedItems).join(', ');
          this.logger.warn(`Batch ${batchNumber}: ${failedChunks} chunks failed embedding and were skipped in: ${itemList}`);
          progressWindow.addLine(getString('indexing-chunksFailed', { count: failedChunks, items: itemList }));
        }

        // === STEP 3: Save this batch (CHECKPOINT) ===
        progressWindow.setHeadline(getString('indexing-batchSaving', { current: batchNumber, total: totalBatches }));

        const batchEmbeddings: PaperEmbedding[] = [];
        for (const extracted of extractedBatch) {
          if (extracted.wasTruncated) {
            totalItemsTruncated++;
            truncatedTitles.push(extracted.title);
            const coverage = extracted.pagesTotal > 0
              ? `${extracted.pagesIndexed}/${extracted.pagesTotal} pages`
              : `${extracted.chunks.length} chunks`;
            this.logger.warn(
              `⚠ Truncated at chunk limit: "${extracted.title}" (${coverage}). ` +
              `Increase Max Chunks per Paper or switch to Summary mode to capture full content.`
            );
          }

          for (const chunk of extracted.chunks) {
            const embeddingKey = `${extracted.itemId}_${chunk.index}`;
            const embeddingResult = embeddingMap.get(embeddingKey);

            if (embeddingResult) {
              const libraryKey = libraryKeyFromLocalID(extracted.libraryId);
              if (!libraryKey) {
                this.logger.warn(`[bulk-index] Cannot resolve libraryKey for item ${extracted.itemId} (libraryId=${extracted.libraryId}); skipping chunk`);
                continue;
              }
              batchEmbeddings.push({
                itemId: extracted.itemId,
                chunkIndex: chunk.index,
                libraryKey,
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
                noteKey: chunk.noteKey,
                startChar: chunk.startChar,
                endChar: chunk.endChar,
                wasTruncated: extracted.wasTruncated,
                pagesIndexed: extracted.pagesIndexed,
                pagesTotal: extracted.pagesTotal,
              });
            }
          }
        }

        // Save this batch to database. replaceItems makes the delete of any
        // pre-existing chunks for the active model part of the same
        // transaction as the write, so an interruption can never leave an
        // item with its old chunks gone and no new ones.
        await this.vectorStore!.putBatch(batchEmbeddings, { replaceItems: true });

        // Refresh the index-status column for the items we just touched
        itemTreeIndexColumn.invalidate(extractedBatch.map(e => e.itemId));

        totalItemsIndexed += extractedBatch.length;
        totalChunksIndexed += batchEmbeddings.length;

        this.logger.info(`Checkpoint ${batchNumber}/${totalBatches}: Saved ${batchEmbeddings.length} chunks from ${extractedBatch.length} items`);
        progressWindow.addCheckpointLine(getString('indexing-checkpoint', { current: batchNumber, total: totalBatches, items: extractedBatch.length, chunks: batchEmbeddings.length }));
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
      progressWindow.setHeadline(getString('indexing-complete'));
      progressWindow.addLine(getString('indexing-completeMode', { mode: indexingMode }), 'chrome://zotero/skin/tick.png');
      if (skippedAlreadyIndexed > 0) {
        progressWindow.addLine(getString('indexing-completePrevious', { count: skippedAlreadyIndexed }), 'chrome://zotero/skin/tick.png');
      }
      progressWindow.addLine(getString('indexing-completeNew', { count: totalItemsIndexed }), 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(getString('indexing-completeChunks', { count: totalChunksIndexed }), 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(getString('indexing-completeAvg', { avg: avgChunksPerItem }), 'chrome://zotero/skin/tick.png');
      progressWindow.addLine(getString('indexing-completeDuration', { duration: durationFormatted }), 'chrome://zotero/skin/tick.png');

      if (totalItemsSkipped > 0) {
        progressWindow.addLine(getString('indexing-completeNoContent', { count: totalItemsSkipped }));
      }

      if (totalItemsGuarded > 0) {
        progressWindow.addLine(getString('indexing-completeUnchanged', { count: totalItemsGuarded }));
      }

      if (totalItemsFailed > 0) {
        progressWindow.addLine(
          getString('indexing-completeFailed', { count: totalItemsFailed }),
          'chrome://zotero/skin/cross.png'
        );
        // Repeat to the debug log so the list survives the auto-close
        this.logger.warn(
          `Indexing summary: ${totalItemsFailed} items could not be extracted. ` +
          `Affected (first 5): ${failedTitles.slice(0, 5).join(' | ')}`
        );
      }

      if (totalItemsTruncated > 0) {
        // Show a prominent warning so users notice partial indexing
        progressWindow.addLine(
          getString('indexing-completeTruncated', { count: totalItemsTruncated }),
          'chrome://zotero/skin/cross.png'
        );
        // Repeat to debug log so the warning survives the auto-close
        this.logger.warn(
          `Indexing summary: ${totalItemsTruncated} of ${totalItemsIndexed} items hit the Max Chunks per Paper limit. ` +
          `Affected (first 5): ${truncatedTitles.slice(0, 5).join(' | ')}`
        );
      }

      progressWindow.complete(getString('indexing-completeSuccess'), true);

      // Successful completion — clear the resume marker so the next startup
      // doesn't pester the user about a finished run.
      try { Z?.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }

    } catch (error: any) {
      if (progressWindow.isCancelled()) {
        this.logger.info('Indexing cancelled by user');
        showQuickNotification(getString('indexing-cancelled'), 'default', 3000);
        // Explicit cancel = user's choice. Don't prompt them to resume on
        // next startup; they can re-trigger Index Library themselves.
        try { Z?.Prefs.clear(PENDING_PREF, true); } catch { /* ignore */ }
      } else {
        this.logger.error(`Indexing failed: ${error}`);
        progressWindow.error(getString('indexing-failed', { error: error.message || error }), false);
        // Keep window open for 10 seconds so user can see the error
        setTimeout(() => progressWindow.close(), 10000);
        this.showAlert(getString('indexing-failed', { error: error.message || error }));
        // Leave PENDING_PREF set — user may want to retry on next startup.
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
    progressWin.changeHeadline(getString('indexing-progressTitle'));

    // Get truncated title for display (max 35 chars)
    const firstTitle = items[0]?.getField?.('title') || 'item';
    const truncTitle = firstTitle.length > 35 ? firstTitle.substring(0, 32) + '...' : firstTitle;
    const displayText = items.length === 1 ? truncTitle : `${items.length} items`;

    const itemRow = new progressWin.ItemProgress(
      'chrome://zotero/skin/spinner-16px.png',
      getString('indexing-progressItem', { title: displayText })
    );
    progressWin.show();

    try {
      // Ensure vector store is ready
      await this.ensureStoreReady();

      // Get indexing mode
      const indexingMode = getIndexingMode(Z);

      // Only tear the worker down when it cannot be used as it stands. Since
      // note edits reach this path, a reset here is routine rather than rare,
      // and it rejects every pending job with "Pipeline reset" — including the
      // query embedding of a search the user is waiting on. It also reloads
      // the ONNX model to embed nothing whenever reuse covers every chunk.
      if (!embeddingPipeline.isReady()) {
        itemRow.setText(getString('indexing-progressLoadingModel'));
        if (!isSearchInProgress()) {
          embeddingPipeline.reset();
        }
      }
      await embeddingPipeline.init();

      // Drop items trashed since they were queued: the cleanup observer deletes
      // a trashed item's embeddings on the trash event, and the quiet period
      // makes "edit a note, then trash the parent" likely enough that writing
      // them back here would leave a trashed item searchable — exactly what
      // that observer exists to prevent.
      const liveItems = items.filter(item => !item.deleted);

      // Filter out items with exclusion tag
      const filteredItems = liveItems.filter(item => !hasExcludeTag(item));
      if (filteredItems.length === 0) {
        this.logger.info(liveItems.length === 0
          ? 'All queued items were trashed before indexing ran'
          : 'All items excluded by tag');
        try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
        itemRow.setText(getString('indexing-allExcluded'));
        progressWin.startCloseTimer(3000);
        return;
      }

      // Extract chunks from items
      itemRow.setText(getString('indexing-extracting'));
      const allExtracted = await textExtractor.extractChunksFromItems(filteredItems, indexingMode);

      if (allExtracted.length === 0) {
        this.logger.info('No content extracted from items');
        try { itemRow.setIcon('chrome://zotero/skin/cross.png'); } catch { /* ignore */ }
        itemRow.setText(getString('indexing-noContent'));
        progressWin.startCloseTimer(3000);
        return;
      }

      const extractedItems = await filterReindexTargets(
        this.vectorStore!, allExtracted, indexingMode, this.logger
      );
      if (extractedItems.length === 0) {
        this.logger.info('Nothing to re-index: every queued item is already up to date');
        try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
        itemRow.setText(getString('indexing-alreadyUpToDate'));
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
      const { embeddings: embeddingMap, failedChunks, failedItems } = await embedChunksWithReuse(
        this.vectorStore!,
        extractedItems,
        textsForEmbedding,
        (processed) => {
          itemRow.setText(getString('indexing-embedding', { current: processed, total: textsForEmbedding.length }));
        }
      );

      // Store embeddings with chunk metadata
      itemRow.setText(getString('indexing-saving'));
      const paperEmbeddings: PaperEmbedding[] = [];
      let autoTruncatedCount = 0;

      for (const extracted of extractedItems) {
        if (extracted.wasTruncated) {
          autoTruncatedCount++;
          const coverage = extracted.pagesTotal > 0
            ? `${extracted.pagesIndexed}/${extracted.pagesTotal} pages`
            : `${extracted.chunks.length} chunks`;
          this.logger.warn(
            `⚠ Auto-index truncated: "${extracted.title}" (${coverage}). ` +
            `Increase Max Chunks per Paper to capture full content.`
          );
        }

        const libraryKey = libraryKeyFromLocalID(extracted.libraryId);
        if (!libraryKey) {
          this.logger.warn(`[auto-index] Cannot resolve libraryKey for item ${extracted.itemId} (libraryId=${extracted.libraryId}); skipping`);
          continue;
        }
        for (const chunk of extracted.chunks) {
          const embeddingKey = `${extracted.itemId}_${chunk.index}`;
          const embeddingData = embeddingMap.get(embeddingKey);
          if (!embeddingData) continue;

          paperEmbeddings.push({
            itemId: extracted.itemId,
            chunkIndex: chunk.index,
            libraryKey,
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
            noteKey: chunk.noteKey,
            startChar: chunk.startChar,
            endChar: chunk.endChar,
            wasTruncated: extracted.wasTruncated,
            pagesIndexed: extracted.pagesIndexed,
            pagesTotal: extracted.pagesTotal,
          });
        }
      }

      // Store in vector store
      // replaceItems: this is a re-index path once note edits trigger
      // auto-index, so an item whose chunk count shrank must not keep orphaned
      // high-index chunks. Doing the delete here, inside putBatch's own
      // transaction, means an interruption mid-run cannot leave an item with
      // its old chunks deleted and no new ones written. An item that produced
      // no embeddings at all is not in this batch, so it is never deleted.
      await this.vectorStore!.putBatch(paperEmbeddings, { replaceItems: true });

      // Refresh column status for the items we just indexed
      itemTreeIndexColumn.invalidate(extractedItems.map(e => e.itemId));

      if (failedChunks > 0) {
        const itemList = Array.from(failedItems).join(', ');
        this.logger.warn(`Auto-index: ${failedChunks} chunks failed in: ${itemList}`);
      }
      this.logger.info(`Auto-indexed ${extractedItems.length} items (${paperEmbeddings.length} chunks, ${failedChunks} failed)`);

      // Show success - use try-catch for setIcon as it may not exist in all Zotero versions
      try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
      itemRow.setText(failedChunks > 0
        ? getString('indexing-chunksIndexedWithFailed', { count: paperEmbeddings.length, failed: failedChunks })
        : getString('indexing-chunksIndexed', { count: paperEmbeddings.length }));

      if (autoTruncatedCount > 0) {
        // Append a partial-content warning so the user sees it before the window auto-closes
        try {
          const warnRow = new progressWin.ItemProgress(
            'chrome://zotero/skin/cross.png',
            getString('indexing-completeTruncated', { count: autoTruncatedCount })
          );
          warnRow.setProgress(100);
        } catch { /* ignore — progress row API can vary across Zotero versions */ }
        progressWin.startCloseTimer(8000);
      } else {
        progressWin.startCloseTimer(3000);
      }

    } catch (error: any) {
      this.logger.error(`Auto-indexing failed: ${error?.message || error}`);
      // Show error in progress window - use try-catch for setIcon
      const errMsg = error?.message || 'Unknown error';
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

    // Select first result in Zotero (itemId is resolved per-session and may
    // be missing if the local item was deleted; skip in that case).
    if (results.length > 0 && results[0].itemId !== undefined) {
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

    // Unregister local MCP/REST endpoints and pref observer
    shutdownServerManager();

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

    // Unregister item-tree column
    await itemTreeIndexColumn.unregister();

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
      'zotseek-submenu',
      'zotseek-separator',
      'zotseek-collection-submenu',
      'zotseek-collection-separator',
    ];
    for (const id of ids) {
      const el = doc.getElementById(id);
      if (el) el.remove();
    }
    if (this.collectionMenuPopupHandler) {
      doc.getElementById('zotero-collectionmenu')
        ?.removeEventListener('popupshowing', this.collectionMenuPopupHandler);
      this.collectionMenuPopupHandler = null;
    }
    this.logger.debug('XUL elements removed');
  }

  /**
   * Index items that are missing coverage for the currently active embedding
   * model, without touching other models' existing chunks.
   *
   * Called from the preferences pane after the user switches models and
   * confirms the background re-index prompt.
   */
  public async reindexForActiveModel(): Promise<void> {
    if (this.indexing) {
      this.logger.debug('reindexForActiveModel: indexing already in progress, skipping');
      return;
    }

    this.indexing = true;
    const Z = getZotero();
    // Capture once — used for getItemsMissingModel and logging; embed() returns
    // the modelId it actually used so chunks carry it rather than this snapshot.
    const activeModelId = getActiveModelId();

    const progressWin = new (Z.ProgressWindow as any)({ closeOnClick: true });
    progressWin.changeHeadline('[ZotSeek] Indexing for new model...');
    const itemRow = new progressWin.ItemProgress(
      'chrome://zotero/skin/spinner-16px.png',
      'Looking up items...'
    );
    progressWin.show();

    try {
      await this.ensureStoreReady();

      const missing = await this.vectorStore!.getItemsMissingModel(activeModelId);

      if (missing.length === 0) {
        try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
        itemRow.setText('All items already covered by this model.');
        progressWin.startCloseTimer(3000);
        return;
      }

      // Resolve (libraryKey, itemKey) pairs to local Zotero items, skipping
      // unresolvable ones (dead group-library items) before extraction/embedding.
      const zoteroItems: any[] = [];
      for (const { libraryKey, itemKey } of missing) {
        const localId = localItemIDFromIdentity({ libraryKey, itemKey });
        if (localId == null) continue;
        const item = Zotero.Items.get(localId);
        if (!item) continue;
        if (hasExcludeTag(item)) continue;
        zoteroItems.push(item);
      }

      if (zoteroItems.length === 0) {
        try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
        itemRow.setText('No eligible items to index.');
        progressWin.startCloseTimer(3000);
        return;
      }

      itemRow.setText(`Loading model for ${zoteroItems.length} items...`);
      // Do NOT call reset(): the prefs handler already loaded the active model
      // via setModel. init() is idempotent — returns immediately if already ready.
      await embeddingPipeline.init();

      const indexingMode = getIndexingMode(Z);

      // === Checkpoint batching — mirrors indexItems' structure for crash recovery ===
      // Each batch of CHECKPOINT_BATCH_SIZE items is extracted, embedded, and saved
      // independently so a crash loses at most one batch's work.
      const CHECKPOINT_BATCH_SIZE = 10;
      const totalBatches = Math.ceil(zoteroItems.length / CHECKPOINT_BATCH_SIZE);
      let totalItemsIndexed = 0;
      let totalChunksIndexed = 0;
      let totalFailedChunks = 0;

      this.logger.info(`reindexForActiveModel: ${zoteroItems.length} items in ${totalBatches} batches, model ${activeModelId}`);

      for (let batchStart = 0; batchStart < zoteroItems.length; batchStart += CHECKPOINT_BATCH_SIZE) {
        const batchEnd = Math.min(batchStart + CHECKPOINT_BATCH_SIZE, zoteroItems.length);
        const batchItems = zoteroItems.slice(batchStart, batchEnd);
        const batchNumber = Math.floor(batchStart / CHECKPOINT_BATCH_SIZE) + 1;

        // STEP 1: Extract chunks for this batch
        itemRow.setText(`Extracting batch ${batchNumber}/${totalBatches}...`);
        this.logger.info(`reindexForActiveModel: batch ${batchNumber}/${totalBatches}: extracting ${batchItems.length} items`);

        const extractedBatch = await textExtractor.extractChunksFromItems(batchItems, indexingMode);

        if (extractedBatch.length === 0) {
          this.logger.info(`reindexForActiveModel: batch ${batchNumber} produced no extractable content, skipping`);
          continue;
        }

        // STEP 2: Embed all chunks in this batch
        const batchChunks: Array<{ id: string; text: string; title: string }> = [];
        for (const extracted of extractedBatch) {
          for (const chunk of extracted.chunks) {
            batchChunks.push({ id: `${extracted.itemId}_${chunk.index}`, text: chunk.text, title: extracted.title });
          }
        }

        itemRow.setText(`Embedding batch ${batchNumber}/${totalBatches} (${batchChunks.length} chunks)...`);
        this.logger.info(`reindexForActiveModel: batch ${batchNumber}/${totalBatches}: embedding ${batchChunks.length} chunks`);

        const { embeddings: embeddingMap, failedChunks, failedItems } = await embedChunks(
          batchChunks,
          () => { /* no per-chunk progress text in this path, matches prior behavior */ }
        );

        if (failedChunks > 0) {
          totalFailedChunks += failedChunks;
          this.logger.warn(`reindexForActiveModel: batch ${batchNumber}: ${failedChunks} chunks failed in: ${Array.from(failedItems).join(', ')}`);
        }

        // STEP 3: Save this batch (CHECKPOINT) — no deleteItemChunks: items have
        // no active-model chunks yet; putBatch adds alongside other models' chunks.
        itemRow.setText(`Saving batch ${batchNumber}/${totalBatches}...`);
        const batchEmbeddings: PaperEmbedding[] = [];
        for (const extracted of extractedBatch) {
          const libKey = libraryKeyFromLocalID(extracted.libraryId);
          if (!libKey) {
            this.logger.warn(`[reindex] Cannot resolve libraryKey for item ${extracted.itemId} (libraryId=${extracted.libraryId}); skipping`);
            continue;
          }
          for (const chunk of extracted.chunks) {
            const embeddingKey = `${extracted.itemId}_${chunk.index}`;
            const embeddingData = embeddingMap.get(embeddingKey);
            if (!embeddingData) continue;
            batchEmbeddings.push({
              itemId: extracted.itemId,
              chunkIndex: chunk.index,
              libraryKey: libKey,
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
              noteKey: chunk.noteKey,
              startChar: chunk.startChar,
              endChar: chunk.endChar,
              wasTruncated: extracted.wasTruncated,
              pagesIndexed: extracted.pagesIndexed,
              pagesTotal: extracted.pagesTotal,
            });
          }
        }

        await this.vectorStore!.putBatch(batchEmbeddings);
        itemTreeIndexColumn.invalidate(extractedBatch.map(e => e.itemId));

        totalItemsIndexed += extractedBatch.length;
        totalChunksIndexed += batchEmbeddings.length;
        this.logger.info(`reindexForActiveModel: checkpoint ${batchNumber}/${totalBatches}: saved ${batchEmbeddings.length} chunks from ${extractedBatch.length} items`);
      }

      this.logger.info(`reindexForActiveModel: indexed ${totalItemsIndexed} items (${totalChunksIndexed} chunks, ${totalFailedChunks} failed) for model ${activeModelId}`);
      try { itemRow.setIcon('chrome://zotero/skin/tick.png'); } catch { /* ignore */ }
      itemRow.setText(totalFailedChunks > 0
        ? `${totalChunksIndexed} chunks indexed (${totalFailedChunks} failed)`
        : `${totalChunksIndexed} chunks indexed`);
      progressWin.startCloseTimer(4000);

    } catch (error: any) {
      this.logger.error(`reindexForActiveModel failed: ${error?.message || error}`);
      try { itemRow.setIcon('chrome://zotero/skin/cross.png'); } catch { /* ignore */ }
      itemRow.setText(`Error: ${error?.message || 'unknown'}`);
      progressWin.startCloseTimer(4000);
    } finally {
      this.indexing = false;
    }
  }

  // Public API for other plugins/scripts
  public api = {
    search: (query: string, options?: any) => searchEngine.search(query, options),
    findSimilar: (itemId: number, options?: any) => searchEngine.findSimilar(itemId, options),
    indexItems: (items: any[]) => this.indexItems(items),
    getStats: () => this.vectorStore?.getStats() ?? Promise.resolve({ totalPapers: 0, indexedPapers: 0, modelId: 'none', lastIndexed: null, storageUsedBytes: 0 }),
    compactDatabase: () => this.compactDatabase(),
    getReclaimableBytes: () => (this.vectorStore as any)?.getReclaimableBytes?.() ?? Promise.resolve(0),
    isReady: () => this.initialized && embeddingPipeline.isReady(),
    reindexForActiveModel: () => this.reindexForActiveModel(),
  };
}

// Create plugin instance
const addon = new ZotSeekPlugin();

// Attach to Zotero global (like BetterNotes does)
const Z = getZotero();
if (Z) {
  Z.ZotSeek = addon;
  // Exposed for runtime diagnostics/testing via execute_js
  Z.ZotSeek.StableProgressWindow = StableProgressWindow;
}

// Also expose on _globalThis for bootstrap access
if (typeof _globalThis !== 'undefined') {
  _globalThis.addon = addon;
}
