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
  textSource?: TextSourceType;
  pageNumber?: number;
  paragraphIndex?: number;
  noteKey?: string;
}

/**
 * MaxSim over the chunks of the requested items: for each item, the single
 * chunk closest to the query.
 *
 * Both sides are expected to be L2-normalized (which is what the embedding
 * cache and `SearchEngine`'s query vector already are), so the dot product is
 * the cosine similarity.
 *
 * Items with no chunks under the active model produce no entry, which is how
 * callers tell "scored badly" apart from "never indexed".
 */
export function bestChunkPerItem(
  query: Float32Array,
  chunks: ScorableChunk[],
  itemIds: Iterable<number>,
): Map<number, ChunkMatch> {
  const wanted = itemIds instanceof Set ? itemIds : new Set(itemIds);
  const best = new Map<number, ChunkMatch>();
  if (wanted.size === 0) return best;

  for (const chunk of chunks) {
    const itemId = chunk.itemId;
    if (itemId === undefined || !wanted.has(itemId)) continue;

    const vector = chunk.embedding;
    if (!vector || vector.length !== query.length) continue;

    let similarity = 0;
    for (let i = 0; i < query.length; i++) {
      similarity += query[i] * vector[i];
    }

    const current = best.get(itemId);
    if (current && current.similarity >= similarity) continue;

    const match: ChunkMatch = { similarity, chunkIndex: chunk.chunkIndex };
    if (chunk.itemPk !== undefined) match.itemPk = chunk.itemPk;
    if (chunk.textSource !== undefined) match.textSource = chunk.textSource;
    if (chunk.pageNumber !== undefined) match.pageNumber = chunk.pageNumber;
    if (chunk.paragraphIndex !== undefined) match.paragraphIndex = chunk.paragraphIndex;
    if (chunk.noteKey !== undefined) match.noteKey = chunk.noteKey;
    best.set(itemId, match);
  }

  return best;
}
