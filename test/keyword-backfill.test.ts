import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bestChunkPerItem, applyMinSimilarity } from '../src/core/keyword-backfill';

// Both sides of the dot product are unit vectors here, so every expected
// similarity below is exact and readable: [1,0] against [0.6,0.8] is 0.6.
const chunk = (itemId: number, chunkIndex: number, embedding: number[], extra: object = {}) => ({
  itemId,
  chunkIndex,
  embedding: new Float32Array(embedding),
  ...extra,
});

const QUERY = new Float32Array([1, 0]);

describe('bestChunkPerItem', () => {
  test('reports the best-matching chunk of an item, not the first one', () => {
    const matches = bestChunkPerItem(QUERY, [
      chunk(1, 0, [0.6, 0.8]),
      chunk(1, 1, [1, 0]),
      chunk(1, 2, [0, 1]),
    ], [1]);

    assert.equal(matches.get(1)?.chunkIndex, 1);
    assert.equal(matches.get(1)?.similarity, 1);
  });

  test('carries the location of the matched chunk, so the hit can be cited', () => {
    // itemPk travels with the match because the chunk text is fetched by
    // (itemPk, chunkIndex); without it a back-filled hit still has no snippet.
    const matches = bestChunkPerItem(QUERY, [
      chunk(1, 0, [0.6, 0.8], { itemPk: 55, pageNumber: 3, paragraphIndex: 1, textSource: 'fulltext' }),
      chunk(1, 1, [1, 0], { itemPk: 55, pageNumber: 7, paragraphIndex: 2, textSource: 'methods' }),
    ], [1]);

    assert.deepEqual(matches.get(1), {
      similarity: 1,
      chunkIndex: 1,
      itemPk: 55,
      pageNumber: 7,
      paragraphIndex: 2,
      textSource: 'methods',
    });
  });

  test('scores only the requested items, ignoring the rest of the cache', () => {
    // The cache holds every chunk in the library; back-filling ten keyword hits
    // must not turn into a scoring pass over the whole index.
    const matches = bestChunkPerItem(QUERY, [
      chunk(1, 0, [1, 0]),
      chunk(2, 0, [1, 0]),
      chunk(3, 0, [1, 0]),
    ], [2]);

    assert.deepEqual([...matches.keys()], [2]);
  });

  test('returns nothing for an item with no chunks under the active model', () => {
    // A keyword hit on an item ZotSeek never indexed: it stays unscorable.
    const matches = bestChunkPerItem(QUERY, [chunk(1, 0, [1, 0])], [1, 9]);

    assert.equal(matches.has(9), false);
    assert.equal(matches.size, 1);
  });
});

describe('applyMinSimilarity', () => {
  test('drops results scoring below the threshold', () => {
    const kept = applyMinSimilarity(
      [
        { itemId: 1, semanticScore: 0.42 },
        { itemId: 2, semanticScore: 0.11 },
      ],
      0.3,
    );

    assert.deepEqual(kept.map((r) => r.itemId), [1]);
  });

  test('keeps a result sitting exactly on the threshold', () => {
    const kept = applyMinSimilarity([{ itemId: 1, semanticScore: 0.3 }], 0.3);

    assert.equal(kept.length, 1);
  });

  test('keeps results that carry no score, since they cannot be gated', () => {
    // Items the keyword leg found but ZotSeek never indexed have no vector to
    // compare against. Excluding them would silently drop metadata matches that
    // hybrid search has always returned.
    const kept = applyMinSimilarity(
      [
        { itemId: 1, semanticScore: null },
        { itemId: 2, semanticScore: 0.05 },
      ],
      0.3,
    );

    assert.deepEqual(kept.map((r) => r.itemId), [1]);
  });
});
