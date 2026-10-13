/**
 * External index providers: other plugins that keep their own index (first of
 * all SeekBook, a full-text index for books) and whose passages ZotSeek mixes
 * into its results.
 *
 * Kept in this one module on purpose, so the fork stays close to upstream:
 * HybridSearchEngine.search() calls mergeExternalResults() on its final list,
 * nothing else in ZotSeek knows about providers. Without an enabled, available
 * provider the result list passes through unchanged.
 *
 * Fusion works on ranks only (RRF, k = 60), never on raw scores: the two
 * indexes may use different models and their similarities are not comparable.
 */

import type { HybridSearchResult } from './hybrid-search';

declare const Zotero: any;

/** Pref (global key, like all zotseek.* prefs): mix in SeekBook results. Off until the user enables it. */
export const SEEKBOOK_PREF = 'zotseek.includeSeekBook';
export const EXTERNAL_RRF_K = 60;

export interface ExternalHit {
  itemKey: string;
  libraryKey: string;
  title: string;
  authors: string[];
  year: number | null;
  score: number;
  semanticScore: number | null;
  keywordScore: number | null;
  snippet: string;
  page?: number;
  pageEnd?: number;
  pageLabel?: string | null;
  chapter?: string | null;
  attachmentKey?: string;
  attachmentTitle?: string;
  chunkIndex?: number;
}

export interface ExternalSearchOptions {
  topK: number;
  libraryKey?: string;
  itemKeys?: string[];
  mode?: 'hybrid' | 'semantic' | 'keyword';
}

export interface ExternalProvider {
  id: string;
  label: string;
  /** Installed and exposing a compatible API. */
  isAvailable(): boolean;
  /** Books (or items) in its index; 0 = nothing to search. */
  indexedCount(): Promise<number>;
  search(query: string, opts: ExternalSearchOptions): Promise<ExternalHit[]>;
}

/** Fields a provider adds to a ZotSeek result; ZotSeek's own results never have them. */
export interface ExternalResultFields {
  externalSource?: string;
  attachmentKey?: string;
  attachmentTitle?: string;
  pageEnd?: number;
  pageLabel?: string | null;
  chapter?: string | null;
}

export type FusedResult = HybridSearchResult & ExternalResultFields;

/** SeekBook through its in-process JS API (`Zotero.SeekBook`, same shapes as its REST API). */
export const seekBookProvider: ExternalProvider = {
  id: 'seekbook',
  label: 'SeekBook',
  isAvailable() {
    const sb = Zotero?.SeekBook;
    return !!sb && sb.apiVersion === 1 && typeof sb.search === 'function' && typeof sb.stats === 'function';
  },
  async indexedCount() {
    const stats = await Zotero.SeekBook.stats();
    return Number(stats?.indexedBooks) || 0;
  },
  async search(query, opts) {
    const res = await Zotero.SeekBook.search(query, {
      topK: opts.topK, libraryKey: opts.libraryKey, itemKeys: opts.itemKeys, mode: opts.mode,
    });
    return (res?.results || []).map((r: any) => ({
      itemKey: r.itemKey,
      libraryKey: r.libraryKey,
      title: r.title || '',
      authors: Array.isArray(r.authors) ? r.authors : [],
      year: typeof r.year === 'number' ? r.year : null,
      score: Number(r.score) || 0,
      semanticScore: typeof r.semanticScore === 'number' ? r.semanticScore : null,
      keywordScore: typeof r.keywordScore === 'number' ? r.keywordScore : null,
      snippet: r.matchedChunk?.snippet || '',
      page: r.matchedChunk?.page,
      pageEnd: r.matchedChunk?.pageEnd,
      pageLabel: r.matchedChunk?.pageLabel ?? null,
      chapter: r.matchedChunk?.chapter ?? null,
      attachmentKey: r.matchedChunk?.attachmentKey,
      attachmentTitle: r.matchedChunk?.attachmentTitle,
      chunkIndex: r.matchedChunk?.chunkIndex,
    }));
  },
};

const providers: ExternalProvider[] = [seekBookProvider];

/** For other plugins that want to contribute results the same way (see docs). */
export function registerExternalProvider(p: ExternalProvider): () => void {
  const i = providers.findIndex((x) => x.id === p.id);
  if (i >= 0) providers.splice(i, 1);
  providers.push(p);
  return () => {
    const j = providers.indexOf(p);
    if (j >= 0) providers.splice(j, 1);
  };
}

export function isSeekBookEnabled(): boolean {
  return Zotero?.Prefs?.get(SEEKBOOK_PREF, true) === true;
}

/** Providers that are switched on and installed. */
export function activeProviders(): ExternalProvider[] {
  return providers.filter((p) => p.id !== 'seekbook' || isSeekBookEnabled()).filter((p) => {
    try { return p.isAvailable(); } catch { return false; }
  });
}

/**
 * Pure fusion of ZotSeek's final list with external lists by rank.
 * `chunkMode` (returnAllChunks): every passage is its own row; otherwise one row
 * per item (its best passage), and an item found by both sides gets both
 * rank contributions. Returns at most `topK` rows, best first.
 */
export function fuseResults(
  own: HybridSearchResult[],
  external: { source: string; hits: (ExternalHit & { itemId: number })[] }[],
  topK: number,
  chunkMode: boolean,
  k = EXTERNAL_RRF_K,
): FusedResult[] {
  const rows = new Map<string, { row: FusedResult; score: number }>();
  own.forEach((r, i) => {
    const key = chunkMode ? `own:${r.itemId}:${r.chunkIndex ?? 0}:${i}` : `item:${r.itemId}`;
    const prev = rows.get(key);
    if (prev) prev.score += 1 / (k + i + 1);
    else rows.set(key, { row: { ...r }, score: 1 / (k + i + 1) });
  });
  for (const list of external) {
    const seen = new Set<number>();
    list.hits.forEach((h, i) => {
      if (!chunkMode && seen.has(h.itemId)) return; // best passage per item only
      seen.add(h.itemId);
      const add = 1 / (k + i + 1);
      const key = chunkMode ? `${list.source}:${h.itemId}:${h.attachmentKey}:${h.chunkIndex}` : `item:${h.itemId}`;
      const prev = rows.get(key);
      if (prev) {
        prev.score += add;
        if (prev.row.source !== 'both' && !prev.row.externalSource) prev.row.source = 'both';
        return;
      }
      rows.set(key, { row: toResult(h, list.source), score: add });
    });
  }
  return [...rows.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map(({ row, score }) => ({ ...row, rrfScore: score }));
}

function toResult(h: ExternalHit & { itemId: number }, source: string): FusedResult {
  return {
    itemId: h.itemId,
    itemKey: h.itemKey,
    title: h.title,
    creators: h.authors.join('; '),
    year: h.year ?? 0,
    semanticScore: h.semanticScore,
    keywordScore: h.keywordScore,
    rrfScore: h.score,
    semanticRank: null,
    keywordRank: null,
    source: h.semanticScore !== null && h.keywordScore !== null ? 'both' : h.keywordScore !== null ? 'keyword' : 'semantic',
    // 'book' is not one of ZotSeek's text sources; consumers treat unknown values as plain text.
    textSource: 'book' as any,
    chunkIndex: h.chunkIndex,
    chunkText: h.snippet,
    pageNumber: h.page,
    externalSource: source,
    attachmentKey: h.attachmentKey,
    attachmentTitle: h.attachmentTitle,
    pageEnd: h.pageEnd,
    pageLabel: h.pageLabel,
    chapter: h.chapter,
  };
}

function libraryKeyOf(libraryID: number): string | undefined {
  if (libraryID === Zotero.Libraries.userLibraryID) return 'user';
  const groupID = Zotero.Groups.getGroupIDFromLibraryID?.(libraryID);
  return groupID ? `group:${groupID}` : undefined;
}

/** Keys of the books in a collection and its subcollections (books only: that is what SeekBook indexes). */
function bookKeysInCollection(collectionId: number): string[] {
  const keys = new Set<string>();
  const walk = (c: any) => {
    for (const item of c?.getChildItems?.(false) || []) {
      if (item?.isRegularItem?.() && item.itemType === 'book') keys.add(item.key);
    }
    for (const sub of c?.getChildCollections?.(false) || []) walk(sub);
  };
  walk(Zotero.Collections.get(collectionId));
  return [...keys];
}

/**
 * Hook for HybridSearchEngine.search(): adds the hits of active providers to
 * ZotSeek's final list. Provider failures are logged and never break the search.
 */
export async function mergeExternalResults(
  own: HybridSearchResult[],
  query: string,
  opts: { finalTopK?: number; libraryId?: number; collectionId?: number; mode?: 'hybrid' | 'semantic' | 'keyword'; returnAllChunks?: boolean },
): Promise<HybridSearchResult[]> {
  const active = activeProviders();
  if (!active.length) return own;
  const topK = opts.finalTopK ?? 20;
  const searchOpts: ExternalSearchOptions = { topK, mode: opts.mode };
  if (opts.libraryId !== undefined) searchOpts.libraryKey = libraryKeyOf(opts.libraryId);
  if (opts.collectionId !== undefined) {
    searchOpts.itemKeys = bookKeysInCollection(opts.collectionId);
    if (!searchOpts.itemKeys.length) return own;
  }
  const lists: { source: string; hits: (ExternalHit & { itemId: number })[] }[] = [];
  for (const p of active) {
    try {
      if ((await p.indexedCount()) <= 0) continue;
      const hits = await p.search(query, searchOpts);
      const resolved: (ExternalHit & { itemId: number })[] = [];
      for (const h of hits) {
        const libraryID = h.libraryKey === 'user' ? Zotero.Libraries.userLibraryID
          : Zotero.Groups.getLibraryIDFromGroupID(Number(String(h.libraryKey).split(':')[1]));
        const item = libraryID ? Zotero.Items.getByLibraryAndKey(libraryID, h.itemKey) : null;
        if (item) resolved.push({ ...h, itemId: item.id });
      }
      if (resolved.length) lists.push({ source: p.id, hits: resolved });
    } catch (e: any) {
      Zotero.debug(`[ZotSeek:External] ${p.id} search failed: ${e?.message || e}`);
    }
  }
  if (!lists.length) return own;
  return fuseResults(own, lists, topK, !!opts.returnAllChunks);
}
