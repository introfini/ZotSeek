/**
 * Which chunk represents a keyword hit.
 *
 * A hit the keyword leg found exists because the query string is literally in
 * the item, so the passage shown must be one that contains it. Ranking those
 * candidates by cosine alone picked a passage that merely read like the query
 * and then reported its page, telling the user the match was somewhere it is
 * not. Term coverage decides; cosine only breaks ties.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  bestChunkPerItem,
  countMatchingTerms,
  escapeLikePattern,
  keywordTerms,
} from '../src/core/keyword-backfill';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Unit vectors, so every similarity below is exact: [1,0] against [0.6,0.8] is 0.6.
const chunk = (
  itemId: number,
  chunkIndex: number,
  embedding: number[],
  extra: object = {},
) => ({ itemId, chunkIndex, itemPk: 50, embedding: new Float32Array(embedding), ...extra });

const QUERY = new Float32Array([1, 0]);
const hits = (entries: Array<[string, number]>) => new Map<string, number>(entries);

describe('choosing the chunk for a keyword hit', () => {
  test('prefers the chunk containing more of the query terms over the nearer one', () => {
    // Chunk 0 is the semantically closest passage and contains nothing; chunk 1
    // is the note that actually holds the phrase. The note must win.
    const matches = bestChunkPerItem(
      QUERY,
      [chunk(1, 0, [1, 0]), chunk(1, 1, [0, 1])],
      [1],
      { termHits: hits([['50:1', 2]]) },
    );

    assert.equal(matches.get(1)?.chunkIndex, 1);
    assert.equal(matches.get(1)?.termHits, 2);
  });

  test('more terms beats fewer terms, whichever is closer', () => {
    const matches = bestChunkPerItem(
      QUERY,
      [chunk(1, 0, [1, 0]), chunk(1, 1, [0.6, 0.8]), chunk(1, 2, [0, 1])],
      [1],
      { termHits: hits([['50:0', 1], ['50:1', 3], ['50:2', 2]]) },
    );

    assert.equal(matches.get(1)?.chunkIndex, 1);
  });

  test('cosine breaks a tie between chunks covering the query equally', () => {
    const matches = bestChunkPerItem(
      QUERY,
      [chunk(1, 0, [0, 1]), chunk(1, 1, [0.6, 0.8]), chunk(1, 2, [1, 0])],
      [1],
      { termHits: hits([['50:0', 2], ['50:1', 2], ['50:2', 2]]) },
    );

    assert.equal(matches.get(1)?.chunkIndex, 2);
    assert.equal(matches.get(1)?.similarity, 1);
  });

  test('collapses to the old cosine ordering when no chunk contains a term', () => {
    // A keyword hit matched on metadata alone: nothing in the text to prefer,
    // so the behaviour is exactly what it was before term coverage existed.
    const chunks = [chunk(1, 0, [0.6, 0.8]), chunk(1, 1, [1, 0]), chunk(1, 2, [0, 1])];

    const ranked = bestChunkPerItem(QUERY, chunks, [1], { termHits: hits([]) });
    const cosineOnly = bestChunkPerItem(QUERY, chunks, [1]);

    assert.equal(ranked.get(1)?.chunkIndex, cosineOnly.get(1)?.chunkIndex);
    assert.equal(ranked.get(1)?.similarity, cosineOnly.get(1)?.similarity);
  });

  test('a semantic hit keeps its closest chunk, since no term map is supplied', () => {
    // Passing no options must not change ranking: that path is the semantic
    // leg, where the nearest chunk IS the reason the item matched.
    const matches = bestChunkPerItem(QUERY, [chunk(1, 0, [1, 0]), chunk(1, 1, [0, 1])], [1]);

    assert.equal(matches.get(1)?.chunkIndex, 0);
    assert.equal(matches.get(1)?.termHits, undefined);
  });

  test('ranks each item on its own chunks', () => {
    const matches = bestChunkPerItem(
      QUERY,
      [
        chunk(1, 0, [1, 0], { itemPk: 50 }),
        chunk(1, 1, [0, 1], { itemPk: 50 }),
        chunk(2, 0, [1, 0], { itemPk: 60 }),
        chunk(2, 1, [0, 1], { itemPk: 60 }),
      ],
      [1, 2],
      { termHits: hits([['50:1', 1]]) },
    );

    assert.equal(matches.get(1)?.chunkIndex, 1); // term coverage
    assert.equal(matches.get(2)?.chunkIndex, 0); // cosine, nothing matched
  });
});

describe('counting the terms a chunk contains', () => {
  test('counts a repeated term once, so repetition cannot outrank coverage', () => {
    assert.equal(countMatchingTerms('rcis rcis rcis', ['rcis', '2025']), 1);
    assert.equal(countMatchingTerms('rcis 2025', ['rcis', '2025']), 2);
  });

  test('matches regardless of case on either side', () => {
    assert.equal(countMatchingTerms('Accepted at RCIS 2025', ['rcis']), 1);
    assert.equal(countMatchingTerms('accepted at rcis', keywordTerms('RCIS')), 1);
  });

  test('counts nothing when there is no text or no terms', () => {
    assert.equal(countMatchingTerms(undefined, ['rcis']), 0);
    assert.equal(countMatchingTerms('rcis 2025', []), 0);
  });
});

describe('the query terms', () => {
  test('lowercases, splits on whitespace and drops single characters', () => {
    assert.deepEqual(keywordTerms('  RCIS   2025 a X '), ['rcis', '2025']);
  });

  test('counts a term repeated in the query once', () => {
    assert.deepEqual(keywordTerms('bias automation bias'), ['bias', 'automation']);
  });

  test('is the same tokenisation the keyword relevance scorer uses', () => {
    // The scorer used to spell the rule out inline; two notions of a term would
    // drift apart silently.
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'hybrid-search.ts'),
      'utf8',
    );
    assert.match(source, /const queryTerms = keywordTerms\(query\)/);
    assert.equal(/split\(\/\\s\+\/\)\.filter/.test(source), false);
  });
});

describe('query text reaching a LIKE pattern', () => {
  test('escapes the wildcards, so a query containing % does not match everything', () => {
    assert.equal(escapeLikePattern('100%'), '%100\\%%');
    assert.equal(escapeLikePattern('a_b'), '%a\\_b%');
    assert.equal(escapeLikePattern('back\\slash'), '%back\\\\slash%');
    assert.equal(escapeLikePattern('rcis'), '%rcis%');
  });

  test('escaping is idempotent in meaning: the term is matched literally', () => {
    // Everything between the framing % is the literal term, each wildcard
    // preceded by the escape character the SQL declares.
    const pattern = escapeLikePattern('50%_off');
    assert.equal(pattern.slice(1, -1), '50\\%\\_off');
  });

  test('the term-match query binds every pattern and declares the escape', () => {
    // A term interpolated into the SQL would be an injection point in a
    // database that also holds the user's library.
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'vector-store-sqlite.ts'),
      'utf8',
    );
    assert.match(source, /chunk_text LIKE \? ESCAPE '\\\\'/);
    assert.match(source, /patterns = terms\.map\(escapeLikePattern\)/);
  });

  test('the term-match read is scoped to the requested items', () => {
    // Unscoped, the LIKE scans every chunk in the library: 200,000+ rows here,
    // seconds per search.
    const source = readFileSync(
      path.join(__dirname, '..', 'src', 'core', 'vector-store-sqlite.ts'),
      'utf8',
    );
    assert.match(source, /item_pk IN \(\$\{pks\.map\(\(\) => '\?'\)\.join\(','\)\}\)/);
  });
});
