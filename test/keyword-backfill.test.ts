import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { bestChunkPerItem } from '../src/core/keyword-backfill';
import { readFileSync } from 'node:fs';
import path from 'node:path';

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

describe('the similarity threshold', () => {
  // The threshold is applied at source, inside the semantic leg, and nowhere
  // else. It used to be re-applied to the fused set as well (issue #44), which
  // could only ever reject keyword-only hits, because semantic and `both`
  // results arrive pre-filtered. Judging a literal-string match by how close the
  // item's meaning is to the query switched the keyword half of hybrid search
  // off at a high threshold, so the post-fusion pass is gone.
  //
  // The fusion and the leg wiring are private to a class that needs Zotero, so
  // the rule is pinned statically here and behaviourally in the in-Zotero suite
  // src/dev/suites/task-44-hybrid-backfill.ts.
  const source = readFileSync(
    path.join(__dirname, '..', 'src', 'core', 'hybrid-search.ts'),
    'utf8',
  );

  test('hands minSimilarity to the semantic leg, where a similarity is the right test', () => {
    assert.match(source, /minSimilarity:\s*opts\.minSimilarity/);
  });

  test('never rejects a fused result by its semantic score', () => {
    // Anything comparing a score against the threshold outside the options
    // plumbing would be a second gate, and the only rows it could drop are the
    // keyword-only ones.
    const comparisons = source.match(/semanticScore\s*[<>]=?/g) || [];
    assert.deepEqual(comparisons, []);
    assert.equal(source.includes('applyMinSimilarity'), false);
  });

  test('the dead threshold helper is gone rather than left unable to reject anything', () => {
    const backfill = readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'keyword-backfill.ts'),
      'utf8',
    );
    assert.equal(backfill.includes('applyMinSimilarity'), false);
  });
});
