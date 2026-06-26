/**
 * Shared tool layer for ZotSeek's local HTTP interfaces (MCP + REST).
 *
 * Module-level functions, not class methods (CLAUDE.md pitfall #6: class
 * methods in the esbuild IIFE bundle may not land on the runtime prototype).
 * Uses the `Zotero` global directly.
 *
 * All operations are read-only adapters over the existing search engines.
 */
import { searchEngine, SearchResult } from '../core/search-engine';
import { HybridSearchEngine, HybridSearchResult, SearchMode } from '../core/hybrid-search';
import { getVectorStore } from '../core/storage-factory';
import { getActiveModelId } from '../core/model-registry';
import { identityFromItem } from '../core/identity-resolver';
import { OPEN_PATH } from './open-endpoint';

declare const Zotero: any;

// One engine instance for all HTTP-facing searches (same wrapping the UI uses)
const hybridEngine = new HybridSearchEngine(searchEngine);

export interface MatchedChunk {
  snippet?: string;
  page?: number;
  textSource?: string;
}

export interface ResultLinks {
  /** Selects the item in the Zotero main pane */
  select: string;
  /** http launcher equivalent of `select`, for clients that only linkify http(s) URLs */
  selectHttp: string;
  /** Opens the PDF in Zotero's reader, at the matched page when known */
  openPdf?: string;
  /** http launcher equivalent of `openPdf` */
  openPdfHttp?: string;
}

export interface ToolResultItem {
  itemKey: string;
  libraryKey: string | null; // 'user' | 'group:<id>' | null when unresolvable
  title: string;
  authors?: string[] | string;
  year?: number;
  score: number;
  source?: 'both' | 'semantic' | 'keyword';
  matchedChunk: MatchedChunk | null;
  links?: ResultLinks;
}

export interface SearchToolArgs {
  query: string;
  max_results?: number;
  mode?: SearchMode;
  granularity?: 'papers' | 'passages';
  /** 0-1; defaults to the user's minSimilarityPercent preference */
  min_similarity?: number;
}

export interface FindSimilarToolArgs {
  item_key: string;
  library_key?: string;
  max_results?: number;
}

const VALID_MODES: SearchMode[] = ['hybrid', 'semantic', 'keyword'];

function clampInt(value: any, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? parseInt(value, 10) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(n)));
}

function clampFloat(value: any, min: number, max: number, fallback: number): number {
  const n = typeof value === 'string' ? parseFloat(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

/** The user's minimum-similarity preference, as the UI reads it. */
function prefMinSimilarity(): number {
  try {
    const pct = Zotero.Prefs.get('zotseek.minSimilarityPercent', true);
    if (typeof pct === 'number' && pct >= 0 && pct <= 100) return pct / 100;
  } catch {
    // fall through to default
  }
  return 0.3;
}

/** The auto-adjust-weights preference, as the UI reads it (default true). */
function prefAutoAdjustWeights(): boolean {
  try {
    return Zotero.Prefs.get('extensions.zotero.zotseek.hybridSearch.autoAdjustWeights', true) !== false;
  } catch {
    return true;
  }
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function chunkOf(r: { chunkText?: string; pageNumber?: number; textSource?: string }): MatchedChunk | null {
  if (!r.chunkText && r.pageNumber === undefined) return null;
  return {
    snippet: r.chunkText || undefined,
    page: r.pageNumber,
    textSource: r.textSource || undefined,
  };
}

function libraryKeyForItemId(itemId: number | undefined): string | null {
  if (!itemId) return null;
  try {
    const item = Zotero.Items.get(itemId);
    return item ? (identityFromItem(item)?.libraryKey ?? null) : null;
  } catch {
    return null;
  }
}

/**
 * zotero:// deep links for a result. `select` always works; `openPdf` is
 * added when the item has a PDF attachment, pointing at the matched page
 * when known. Note: open-pdf needs the ATTACHMENT key, not the parent
 * item key — resolved via getBestAttachment().
 */
async function buildLinks(
  libraryKey: string | null,
  itemKey: string,
  page?: number
): Promise<ResultLinks | undefined> {
  if (!itemKey) return undefined;
  const isGroup = !!libraryKey && libraryKey.startsWith('group:');
  if (libraryKey !== 'user' && !isGroup) return undefined; // orphan/unknown: no stable link
  const prefix = isGroup ? `groups/${libraryKey!.slice('group:'.length)}` : 'library';
  // http launcher base for clients that don't linkify zotero:// URIs
  const port = Zotero.Server?.port || 23119;
  const openBase = `http://localhost:${port}${OPEN_PATH}`;
  const libParam = isGroup ? `&library=${encodeURIComponent(libraryKey!)}` : '';
  const links: ResultLinks = {
    select: `zotero://select/${prefix}/items/${itemKey}`,
    selectHttp: `${openBase}?target=select&key=${itemKey}${libParam}`,
  };
  try {
    const libraryId = isGroup
      ? Zotero.Groups.getLibraryIDFromGroupID(Number(libraryKey!.slice('group:'.length)))
      : Zotero.Libraries.userLibraryID;
    const item = Zotero.Items.getByLibraryAndKey(libraryId, itemKey);
    const att = item ? await item.getBestAttachment() : null;
    if (att && (typeof att.isPDFAttachment !== 'function' || att.isPDFAttachment())) {
      const pageSuffix = page ? `?page=${page}` : '';
      links.openPdf = `zotero://open-pdf/${prefix}/items/${att.key}${pageSuffix}`;
      links.openPdfHttp =
        `${openBase}?target=pdf&key=${att.key}${libParam}` + (page ? `&page=${page}` : '');
    }
  } catch {
    // keep the select links only
  }
  return links;
}

async function mapHybridResult(r: HybridSearchResult): Promise<ToolResultItem> {
  const libraryKey = libraryKeyForItemId(r.itemId);
  return {
    itemKey: r.itemKey,
    libraryKey,
    title: r.title,
    authors: r.creators || undefined,
    year: r.year || undefined,
    score: round3(r.rrfScore),
    source: r.source,
    matchedChunk: chunkOf(r),
    links: await buildLinks(libraryKey, r.itemKey, r.pageNumber),
  };
}

async function mapSearchResult(r: SearchResult): Promise<ToolResultItem> {
  return {
    itemKey: r.itemKey,
    libraryKey: r.libraryKey || null,
    title: r.title,
    authors: r.authors && r.authors.length ? r.authors : undefined,
    year: r.year,
    score: round3(r.similarity),
    matchedChunk: chunkOf(r),
    links: await buildLinks(r.libraryKey || null, r.itemKey, r.pageNumber),
  };
}

/**
 * Defence-in-depth Origin check. Zotero's server already cancels browser
 * traffic (Mozilla/ User-Agent) before plugin endpoints run unless it
 * carries a Zotero-Allowed-Request or connector header, and it validates
 * the Host header. This check additionally rejects non-browser clients
 * that present a forged non-localhost Origin. Requests without an Origin
 * header (curl, native MCP clients) pass.
 */
export function isAllowedOrigin(origin: string | null | undefined): boolean {
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(origin);
}

export async function runSearchTool(args: SearchToolArgs): Promise<{ results: ToolResultItem[] }> {
  if (!args || typeof args.query !== 'string' || !args.query.trim()) {
    throw new Error('search: "query" is required and must be a non-empty string');
  }
  const finalTopK = clampInt(args.max_results, 1, 100, 10);
  const mode: SearchMode = args.mode && VALID_MODES.includes(args.mode) ? args.mode : 'hybrid';
  const returnAllChunks = args.granularity === 'passages';
  const minSimilarity =
    args.min_similarity !== undefined
      ? clampFloat(args.min_similarity, 0, 1, prefMinSimilarity())
      : prefMinSimilarity();
  const options = { mode, finalTopK, returnAllChunks, minSimilarity };
  // Mirror the UI (search-dialog-vtable): hybrid mode with the auto-adjust
  // pref uses smartSearch, which analyzes the query and tunes the
  // semantic/keyword weight. Without this, MCP/REST hybrid ran a fixed
  // 50/50 fusion and ranked differently from the ZotSeek dialog (#38).
  const query = args.query.trim();
  const results =
    mode === 'hybrid' && prefAutoAdjustWeights()
      ? await hybridEngine.smartSearch(query, options)
      : await hybridEngine.search(query, options);
  return { results: await Promise.all(results.map(mapHybridResult)) };
}

export async function runFindSimilarTool(args: FindSimilarToolArgs): Promise<{ results: ToolResultItem[] }> {
  const key = typeof args?.item_key === 'string' ? args.item_key.trim().toUpperCase() : '';
  if (!/^[A-Z0-9]{8}$/.test(key)) {
    throw new Error('find_similar: "item_key" must be an 8-character Zotero item key');
  }
  const libraryKey = typeof args.library_key === 'string' && args.library_key.trim() ? args.library_key.trim() : 'user';
  const topK = clampInt(args.max_results, 1, 100, 10);
  const results = await searchEngine.findSimilarByIdentity(libraryKey, key, { topK });
  return { results: await Promise.all(results.map(mapSearchResult)) };
}

export async function runIndexStatusTool(): Promise<object> {
  const store = getVectorStore();
  if (!store.isReady()) {
    await store.init();
  }
  const stats = await store.getStats();
  const activeModel = getActiveModelId();
  const coverage = await store.getCoverage(activeModel);
  return {
    // "Will searches return meaningful results?" — the embedding pipeline
    // lazy-loads on first search, so readiness is about the index itself.
    ready: stats.indexedPapers > 0,
    modelLoaded: Zotero.ZotSeek?.api?.isReady?.() ?? false,
    indexedPapers: stats.indexedPapers,
    totalChunks: stats.totalChunks,
    modelId: stats.modelId,
    activeModel,
    coverage,
    lastIndexed: stats.lastIndexed,
    storageUsedBytes: stats.storageUsedBytes,
  };
}
