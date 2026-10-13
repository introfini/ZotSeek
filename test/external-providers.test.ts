import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuseResults } from '../src/core/external-providers';

const own = (itemId: number, chunkIndex = 0): any => ({
  itemId, itemKey: `P${itemId}`, title: `Paper ${itemId}`, creators: '', year: 2020, semanticScore: 0.8, keywordScore: null,
  rrfScore: 0.03, semanticRank: 1, keywordRank: null, source: 'semantic', chunkIndex,
});
const hit = (itemId: number, chunkIndex: number, attachmentKey = 'A1'): any => ({
  itemId, itemKey: `B${itemId}`, libraryKey: 'user', title: `Book ${itemId}`, authors: ['Muster'], year: 2016, score: 0.02,
  semanticScore: 0.7, keywordScore: null, snippet: `passage ${chunkIndex}`, page: 10 + chunkIndex, pageEnd: 11 + chunkIndex,
  pageLabel: String(chunkIndex), chapter: 'Kapitel 2', attachmentKey, attachmentTitle: 'Teil 1', chunkIndex,
});

test('interleaves by rank and carries book fields', () => {
  const out = fuseResults([own(1), own(2), own(3)], [{ source: 'seekbook', hits: [hit(10, 5), hit(11, 1)] }], 4, false);
  assert.deepEqual(out.map((r) => r.itemId), [1, 10, 2, 11]);
  const book = out[1];
  assert.equal(book.externalSource, 'seekbook');
  assert.equal(book.attachmentKey, 'A1');
  assert.equal(book.pageNumber, 15);
  assert.equal(book.chunkText, 'passage 5');
  assert.equal(book.chapter, 'Kapitel 2');
  assert.equal(book.creators, 'Muster');
  assert.equal(out[0].externalSource, undefined, 'own results unchanged');
});

test('item mode: one row per book, an item on both sides adds up', () => {
  const out = fuseResults([own(1), own(10)], [{ source: 'seekbook', hits: [hit(10, 1), hit(10, 2), hit(12, 0)] }], 10, false);
  assert.deepEqual(out.map((r) => r.itemId), [10, 1, 12]);
  assert.equal(out[0].source, 'both');
});

test('chunk mode keeps every passage', () => {
  const out = fuseResults([own(1, 0), own(1, 1)], [{ source: 'seekbook', hits: [hit(10, 1), hit(10, 2, 'A2')] }], 10, true);
  assert.equal(out.length, 4);
  assert.deepEqual(out.filter((r) => r.externalSource).map((r) => r.attachmentKey), ['A1', 'A2']);
});

test('without external hits the list is unchanged in order', () => {
  const list = [own(3), own(1), own(2)];
  assert.deepEqual(fuseResults(list, [], 10, false).map((r) => r.itemId), [3, 1, 2]);
});
