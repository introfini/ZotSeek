/**
 * Candidate selection for "Re-index Items with CJK Text".
 *
 * Before 1.22.3 the chunker's token estimate counted whitespace-separated
 * words, so Chinese and Japanese paragraphs were dropped from the index and
 * the item was still recorded as fully indexed at the hash of its complete
 * text (issue #60). Fixing the estimate repairs nothing on its own: bulk
 * Update Index skips indexed items by presence, and the auto-index path skips
 * them by unchanged hash. This action re-indexes exactly the items that can
 * gain from the fix, and the rules for picking them are pinned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  hasCjkText,
  selectCjkReindexCandidates,
  collectCjkReindexItems,
  extractedHasCjkText,
  CjkReindexDeps,
} from '../src/utils/cjk-reindex';

function item(id: number, opts: {
  regular?: boolean;
  deleted?: boolean;
  title?: string;
  abstract?: string;
  throwsOnField?: boolean;
} = {}) {
  return {
    id,
    isRegularItem: () => opts.regular !== false,
    deleted: opts.deleted === true,
    getField: (field: string) => {
      if (opts.throwsOnField) throw new Error('boom');
      if (field === 'title') return opts.title ?? '';
      if (field === 'abstractNote') return opts.abstract ?? '';
      return '';
    },
  };
}

/**
 * Default world: nothing excluded, every item resolves, every item is indexed,
 * and no stored chunk holds CJK text. Each test overrides one rule.
 */
function deps(overrides: Partial<CjkReindexDeps> = {}) {
  const indexedCalls: number[] = [];
  const chunkCalls: number[] = [];
  const base: CjkReindexDeps = {
    hasExcludeTag: () => false,
    identityOf: (i: any) => ({ libraryKey: 'user', itemKey: `K${i.id}` }),
    isIndexed: async (_lk: string, itemKey: string) => {
      indexedCalls.push(Number(itemKey.slice(1)));
      return true;
    },
    hasCjkChunks: async (_lk: string, itemKey: string) => {
      chunkCalls.push(Number(itemKey.slice(1)));
      return false;
    },
  };
  return Object.assign(base, overrides, { indexedCalls, chunkCalls });
}

const ids = (items: any[]) => items.map((i) => i.id);

test('hasCjkText recognises Han, kana and Hangul and nothing else', () => {
  assert.equal(hasCjkText('社会资本'), true);
  assert.equal(hasCjkText('ひらがな'), true);
  assert.equal(hasCjkText('カタカナ'), true);
  assert.equal(hasCjkText('한국어'), true);
  assert.equal(hasCjkText('A title with 一 character'), true);
  assert.equal(hasCjkText('Plain English, with punctuation!'), false);
  assert.equal(hasCjkText('Ünïcödé Ελληνικά кириллица'), false);
  assert.equal(hasCjkText(''), false);
  assert.equal(hasCjkText(undefined as any), false);
});

test('keeps an indexed item whose title is in Chinese', async () => {
  const d = deps();
  const out = await selectCjkReindexCandidates([item(1, { title: '社会资本与知识共享' })], d);
  assert.deepEqual(ids(out), [1]);
});

test('keeps an indexed item whose abstract is in Chinese under a Latin title', async () => {
  const d = deps();
  const out = await selectCjkReindexCandidates([item(1, { title: 'Social capital', abstract: '本文研究社会资本' })], d);
  assert.deepEqual(ids(out), [1]);
});

test('keeps an item with Latin metadata when its stored chunks hold CJK text', async () => {
  const d = deps({ hasCjkChunks: async () => true });
  const out = await selectCjkReindexCandidates([item(1, { title: 'Social capital' })], d);
  assert.deepEqual(ids(out), [1]);
});

test('drops an item with no CJK anywhere', async () => {
  const d = deps();
  const out = await selectCjkReindexCandidates([item(1, { title: 'Social capital', abstract: 'Nothing CJK here.' })], d);
  assert.deepEqual(ids(out), []);
});

test('drops a CJK item that is not indexed yet: Update Index covers it', async () => {
  const d = deps({ isIndexed: async () => false });
  const out = await selectCjkReindexCandidates([item(1, { title: '社会资本' })], d);
  assert.deepEqual(ids(out), []);
});

test('drops notes and attachments, trashed items, excluded items and unresolvable ones', async () => {
  const d = deps({
    hasExcludeTag: (i: any) => i.id === 3,
    identityOf: (i: any) => (i.id === 4 ? null : { libraryKey: 'user', itemKey: `K${i.id}` }),
  });
  const out = await selectCjkReindexCandidates([
    item(1, { regular: false, title: '社会资本' }),
    item(2, { deleted: true, title: '社会资本' }),
    item(3, { title: '社会资本' }),
    item(4, { title: '社会资本' }),
    item(5, { title: '社会资本' }),
  ], d);
  assert.deepEqual(ids(out), [5]);
});

test('does not query stored chunks for an item whose metadata already has CJK', async () => {
  const d = deps();
  await selectCjkReindexCandidates([item(1, { title: '社会资本' })], d);
  assert.deepEqual(d.chunkCalls, []);
  assert.deepEqual(d.indexedCalls, [1]);
});

test('does not query the indexed flag for an item whose metadata has no CJK', async () => {
  // The chunk lookup is scoped to the active model, so a hit already proves
  // the item is indexed; a second query per English item would double the
  // cost of scanning a large library for nothing.
  const chunkCalls: number[] = [];
  const d = deps({
    hasCjkChunks: async (_lk: string, itemKey: string) => {
      chunkCalls.push(Number(itemKey.slice(1)));
      return true;
    },
  });
  const out = await selectCjkReindexCandidates([item(1, { title: 'Social capital' })], d);
  assert.deepEqual(ids(out), [1]);
  assert.deepEqual(d.indexedCalls, []);
  assert.deepEqual(chunkCalls, [1]);
});

test('de-duplicates an item that appears twice', async () => {
  const d = deps();
  const out = await selectCjkReindexCandidates([item(1, { title: '社会资本' }), item(1, { title: '社会资本' })], d);
  assert.deepEqual(ids(out), [1]);
  assert.deepEqual(d.indexedCalls, [1]);
});

test('one failing item does not abort the scan', async () => {
  const errors: string[] = [];
  const d = deps({
    isIndexed: async (_lk: string, itemKey: string) => {
      if (itemKey === 'K1') throw new Error('db gone');
      return true;
    },
    onError: (m: string) => errors.push(m),
  });
  const out = await selectCjkReindexCandidates([
    item(1, { title: '社会资本' }),
    item(2, { throwsOnField: true }),
    item(3, { title: '社会资本' }),
  ], d);
  assert.deepEqual(ids(out), [3]);
  assert.equal(errors.length, 2);
});

test('collectCjkReindexItems gathers every library and survives one that fails', async () => {
  const errors: string[] = [];
  const api = {
    getLibraryItems: async (libraryId?: number) => {
      if (libraryId === 2) throw new Error('no such library');
      return [item(libraryId! * 10, { title: '社会资本' })];
    },
  };
  const out = await collectCjkReindexItems(api, [1, 2, 3], deps({ onError: (m) => errors.push(m) }));
  assert.deepEqual(ids(out), [10, 30]);
  assert.equal(errors.length, 1);
});

test('extractedHasCjkText looks at the text that will be embedded, not the metadata', () => {
  assert.equal(extractedHasCjkText({ chunks: [{ text: 'Title\n\nEnglish body.' }, { text: 'Title\n\n社会资本' }] }), true);
  assert.equal(extractedHasCjkText({ chunks: [{ text: 'Title\n\nEnglish body.' }] }), false);
  assert.equal(extractedHasCjkText({ chunks: [] }), false);
});
