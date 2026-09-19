import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { resolveKeywordMatches, KeywordMatchFacts } from '../src/core/keyword-parents';

const paper = (itemId: number, itemType = 'journalArticle'): KeywordMatchFacts => ({
  itemId,
  itemType,
  isRegularItem: true,
});

const child = (
  itemId: number,
  ownerId: number,
  itemType: 'attachment' | 'note' | 'annotation' = 'attachment',
  ownerItemType = 'journalArticle'
): KeywordMatchFacts => ({
  itemId,
  itemType,
  isRegularItem: false,
  owner: { itemId: ownerId, itemType: ownerItemType },
});

const orphan = (itemId: number, itemType: 'attachment' | 'note' = 'note'): KeywordMatchFacts => ({
  itemId,
  itemType,
  isRegularItem: false,
  owner: null,
});

const OPTS = { excludeBooks: false, limit: 100 };

describe('resolveKeywordMatches', () => {
  test('a matched PDF or note resolves to the paper it belongs to', () => {
    // The whole point of the fix: Zotero returns the attachment or the note,
    // and the result has to be the parent article.
    assert.deepEqual(resolveKeywordMatches([child(200, 7)], OPTS), [7]);
    assert.deepEqual(resolveKeywordMatches([child(201, 8, 'note')], OPTS), [8]);
  });

  test('a regular item passes through as itself', () => {
    assert.deepEqual(resolveKeywordMatches([paper(7), paper(8, 'conferencePaper')], OPTS), [7, 8]);
  });

  test('a standalone note or attachment is dropped', () => {
    // Nothing indexes them, so they have nothing to rank.
    assert.deepEqual(resolveKeywordMatches([orphan(300), orphan(301, 'attachment')], OPTS), []);
  });

  test('several matches on the same paper collapse to one result', () => {
    // Three PDFs and a note of the same paper, and the paper itself: one result.
    const children = [child(200, 7), child(201, 7), child(202, 7, 'note')];
    assert.deepEqual(resolveKeywordMatches(children, OPTS), [7]);
    assert.deepEqual(resolveKeywordMatches([...children, paper(7)], OPTS), [7]);
  });

  test('the position of an item is fixed by the first match that reaches it', () => {
    const matches = [child(200, 9), paper(7), child(201, 9)];
    assert.deepEqual(resolveKeywordMatches(matches, OPTS), [9, 7]);
  });

  test('the book filter reads the resolved parent, not the matched child', () => {
    // The match is an attachment, so an itemType condition in the search would
    // never see 'book'; only the resolved owner's type can.
    const matches = [child(200, 7, 'attachment', 'book'), child(201, 8)];
    assert.deepEqual(resolveKeywordMatches(matches, { excludeBooks: true, limit: 100 }), [8]);
    assert.deepEqual(resolveKeywordMatches(matches, { excludeBooks: false, limit: 100 }), [7, 8]);
  });

  test('the book filter still applies to a top-level book', () => {
    const matches = [paper(7, 'book'), paper(8)];
    assert.deepEqual(resolveKeywordMatches(matches, { excludeBooks: true, limit: 100 }), [8]);
  });

  test('the limit is applied after dedupe, not to the raw matches', () => {
    // Eleven attachments of one paper plus two other papers: slicing the raw
    // matches at three would return one paper; slicing after dedupe returns three.
    const matches: KeywordMatchFacts[] = [];
    for (let i = 0; i < 11; i++) matches.push(child(200 + i, 7));
    matches.push(paper(8), paper(9), paper(10));

    assert.deepEqual(resolveKeywordMatches(matches, { excludeBooks: false, limit: 3 }), [7, 8, 9]);
  });

  test('the limit is applied after the book filter, so books do not use up slots', () => {
    const matches = [paper(7, 'book'), paper(8), paper(9)];
    assert.deepEqual(resolveKeywordMatches(matches, { excludeBooks: true, limit: 2 }), [8, 9]);
  });
});
