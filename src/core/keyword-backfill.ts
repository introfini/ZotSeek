/**
 * Back-fill for keyword-only hybrid hits.
 *
 * Zotero's quick search matches at item level, so the keyword leg of hybrid
 * search returns items with no chunk and no similarity, which left those results
 * with nothing citable and nothing to display (issue #44). The item is already
 * indexed and the query is already embedded, so recovering both is a cosine over
 * that item's own chunks — no second search and no second inference.
 *
 * The recovered score is reported, never used to reject: hybrid search applies
 * `minSimilarity` inside the semantic leg, where a similarity is the right test,
 * and leaves keyword evidence alone. See the note in `HybridSearchEngine.search`.
 *
 * This function is pure so it can be tested outside Zotero; the wiring that
 * feeds it the embedding cache lives in search-engine.ts and hybrid-search.ts.
 */

import type { TextSourceType } from './vector-store-sqlite';

/** A chunk vector as the search cache holds it: already L2-normalized. */
export interface ScorableChunk {
  itemId?: number;
  itemPk?: number;
  chunkIndex: number;
  embedding: Float32Array;
  textSource?: TextSourceType;
  pageNumber?: number;
  paragraphIndex?: number;
  noteKey?: string;
}

/** The winning chunk for one item, with everything needed to cite it. */
export interface ChunkMatch {
  similarity: number;
  chunkIndex: number;
  /** Needed to fetch the chunk text, which is keyed by (itemPk, chunkIndex). */
  itemPk?: number;
  /**
   * Distinct query terms found in this chunk's text. Set only when the chunk
   * was chosen for a keyword hit, where term coverage outranks cosine.
   */
  termHits?: number;
  textSource?: TextSourceType;
  pageNumber?: number;
  paragraphIndex?: number;
  noteKey?: string;
}

export interface ChunkChoiceOptions {
  /**
   * How many distinct query terms each chunk's text contains, keyed
   * `${itemPk}:${chunkIndex}`. Chunks absent from the map contain none.
   *
   * Supplied only for hits the keyword leg found. Those hits exist because the
   * query string is literally in the item, so the passage worth showing is one
   * that actually holds it; cosine only breaks ties between equally covering
   * passages. A semantic hit gets no term map, because there the closest chunk
   * IS the reason the item matched.
   */
  termHits?: Map<string, number>;
}

/**
 * The single chunk that best represents each requested item.
 *
 * Ranked by how many distinct query terms the chunk contains (descending), and
 * then by cosine similarity. With no term counts supplied — or none of the
 * item's chunks containing a term — every candidate sits at zero terms and the
 * ranking is pure MaxSim, which is the plain semantic behaviour.
 *
 * Both sides of the dot product are expected to be L2-normalized (which is what
 * the embedding cache and `SearchEngine`'s query vector already are), so it is
 * the cosine similarity.
 *
 * Items with no chunks under the active model produce no entry, which is how
 * callers tell "scored badly" apart from "never indexed".
 */
export function bestChunkPerItem(
  query: Float32Array,
  chunks: ScorableChunk[],
  itemIds: Iterable<number>,
  options: ChunkChoiceOptions = {},
): Map<number, ChunkMatch> {
  const wanted = itemIds instanceof Set ? itemIds : new Set(itemIds);
  const best = new Map<number, ChunkMatch>();
  if (wanted.size === 0) return best;

  const termHits = options.termHits;

  for (const chunk of chunks) {
    const itemId = chunk.itemId;
    if (itemId === undefined || !wanted.has(itemId)) continue;

    const vector = chunk.embedding;
    if (!vector || vector.length !== query.length) continue;

    let similarity = 0;
    for (let i = 0; i < query.length; i++) {
      similarity += query[i] * vector[i];
    }

    const hits = termHits
      ? (chunk.itemPk !== undefined ? termHits.get(`${chunk.itemPk}:${chunk.chunkIndex}`) ?? 0 : 0)
      : 0;

    const current = best.get(itemId);
    if (current) {
      const currentHits = current.termHits ?? 0;
      if (currentHits > hits) continue;
      if (currentHits === hits && current.similarity >= similarity) continue;
    }

    const match: ChunkMatch = { similarity, chunkIndex: chunk.chunkIndex };
    if (termHits) match.termHits = hits;
    if (chunk.itemPk !== undefined) match.itemPk = chunk.itemPk;
    if (chunk.textSource !== undefined) match.textSource = chunk.textSource;
    if (chunk.pageNumber !== undefined) match.pageNumber = chunk.pageNumber;
    if (chunk.paragraphIndex !== undefined) match.paragraphIndex = chunk.paragraphIndex;
    if (chunk.noteKey !== undefined) match.noteKey = chunk.noteKey;
    best.set(itemId, match);
  }

  return best;
}

/**
 * The query terms the keyword leg works with: lowercased, whitespace-separated,
 * single characters dropped, each term counted once.
 *
 * `keywordSearchQuery` scores title matches with exactly this notion of a term,
 * and the chunk chosen to represent a keyword hit is ranked with it too, so both
 * live here rather than being spelled out twice.
 */
export function keywordTerms(query: string): string[] {
  const seen = new Set<string>();
  for (const token of (query || '').toLowerCase().split(/\s+/)) {
    if (token.length > 1) seen.add(token);
  }
  return Array.from(seen);
}

/**
 * How many distinct terms the text contains.
 *
 * A term that occurs three times in a chunk is still one term matched: the
 * count measures coverage of the query, not density, so a chunk repeating one
 * word cannot outrank a chunk carrying the whole phrase.
 */
export function countMatchingTerms(text: string | undefined | null, terms: string[]): number {
  if (!text || terms.length === 0) return 0;
  const haystack = text.toLowerCase();
  let count = 0;
  for (const term of terms) {
    if (haystack.includes(term)) count++;
  }
  return count;
}

/**
 * Turn a query term into a LIKE pattern that matches it literally.
 *
 * The text being matched is whatever the user typed, so `%` and `_` arrive as
 * ordinary characters and must not be honoured as wildcards: a query containing
 * a bare `%` would otherwise match every chunk in the library and hand the hit
 * an arbitrary passage again. The pattern is always bound as a parameter; the
 * escaping is about meaning, not about injection.
 *
 * Callers must pair this with `ESCAPE '\'` in the SQL.
 */
export function escapeLikePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}
