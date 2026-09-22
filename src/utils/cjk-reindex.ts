/**
 * Candidate selection for "Re-index Items with CJK Text".
 *
 * Before 1.22.3 the chunker's token estimate counted whitespace-separated
 * words, and Chinese and Japanese prose has none, so CJK paragraphs fell
 * under the minimum-paragraph gate and were dropped, with the item still
 * recorded as fully indexed at the hash of its complete text (issue #60).
 * Fixing the estimate repairs nothing by itself: bulk Update Index skips
 * indexed items by presence, and the auto-index path skips them by unchanged
 * hash. This module picks out the items that can gain from the fix so the
 * ordinary bulk pipeline can re-index them, with its batching, progress,
 * checkpoints and crash resume unchanged.
 *
 * An item qualifies when it is indexed under the active model and CJK text
 * shows up in its title or abstract, or in the chunks the index already holds
 * for it. Zotero 10 keeps its own full-text index in a separate FTS database,
 * so there is no cheap third source; an item with Latin metadata whose CJK
 * body was lost entirely is not found here and needs Remove from Index plus
 * Index Selected Items.
 *
 * Free functions with injected dependencies, for the same reasons as
 * note-backfill.ts: two callers, no `this`, and testable outside Zotero.
 */

export interface CjkReindexDeps {
  /** True when the item carries the user's exclusion tag. */
  hasExcludeTag(item: any): boolean;
  /** Stable (library_key, item_key) identity, or null when unresolvable. */
  identityOf(item: any): { libraryKey: string; itemKey: string } | null;
  /** Whether the item already has chunks under the ACTIVE model. */
  isIndexed(libraryKey: string, itemKey: string): Promise<boolean>;
  /** Whether any chunk stored for the item under the ACTIVE model holds CJK text. */
  hasCjkChunks(libraryKey: string, itemKey: string): Promise<boolean>;
  /** Optional diagnostic sink; never throws. */
  onError?(message: string): void;
}

/**
 * Han, Hiragana, Katakana and Hangul: the scripts whose prose has no spaces
 * between words. Punctuation is deliberately left out; a full-width comma in
 * an otherwise Latin title says nothing about the body.
 */
const CJK_TEXT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u;

export function hasCjkText(text: string | null | undefined): boolean {
  return typeof text === 'string' && text.length > 0 && CJK_TEXT.test(text);
}

function metadataHasCjk(item: any): boolean {
  return hasCjkText(item.getField?.('title')) || hasCjkText(item.getField?.('abstractNote'));
}

/**
 * Reduce a list of items to the ones the CJK re-index has to touch.
 *
 * Rules, cheapest first, so the database queries run last and only once per
 * item: an item whose metadata has CJK needs just the indexed check, and an
 * item whose metadata has none needs just the chunk lookup, since that lookup
 * is scoped to the active model and a hit already proves the item is indexed.
 *
 * De-duplicates by item id, so overlapping inputs cost one re-index.
 */
export async function selectCjkReindexCandidates(
  items: any[],
  deps: CjkReindexDeps,
): Promise<any[]> {
  const seen = new Set<number>();
  const candidates: any[] = [];

  for (const item of items || []) {
    if (!item?.isRegularItem?.()) continue;
    if (item.deleted) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    try {
      if (deps.hasExcludeTag(item)) continue;
      const identity = deps.identityOf(item);
      if (!identity) continue;

      const qualifies = metadataHasCjk(item)
        ? await deps.isIndexed(identity.libraryKey, identity.itemKey)
        : await deps.hasCjkChunks(identity.libraryKey, identity.itemKey);
      if (qualifies) candidates.push(item);
    } catch (error: any) {
      // A single failing item must not abort the scan of a whole library.
      deps.onError?.(`CJK re-index check failed for item ${item?.id}: ${error?.message || error}`);
    }
  }

  return candidates;
}

/**
 * Gather the candidates across a set of libraries. The ids are resolved by the
 * caller from `zotseek.indexScope` and travel with the resume marker.
 */
export async function collectCjkReindexItems(
  zoteroAPI: { getLibraryItems: (libraryId?: number) => Promise<any[]> },
  libraryIds: number[],
  deps: CjkReindexDeps,
): Promise<any[]> {
  const all: any[] = [];
  for (const libraryId of libraryIds || []) {
    try {
      const items = await zoteroAPI.getLibraryItems(libraryId);
      if (items?.length) all.push(...items);
    } catch (error: any) {
      deps.onError?.(`Could not list items for library ${libraryId}: ${error?.message || error}`);
    }
  }
  return selectCjkReindexCandidates(all, deps);
}

/**
 * Whether the text that would actually be embedded holds CJK. Applied after
 * extraction so a Chinese title on an English PDF is not re-embedded for
 * nothing, and an English title on a Chinese PDF is.
 */
export function extractedHasCjkText(extracted: { chunks: Array<{ text: string }> }): boolean {
  return extracted.chunks.some((chunk) => hasCjkText(chunk.text));
}
