import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  selectNoteBackfillCandidates,
  collectNoteBackfillItems,
  NoteBackfillDeps,
} from '../src/utils/note-backfill';

/** Minimal stand-in for a Zotero item as the backfill selection sees it. */
function item(id: number, opts: {
  regular?: boolean;
  deleted?: boolean;
  notes?: number[];
  noGetNotes?: boolean;
  throwsOnNotes?: boolean;
} = {}) {
  const base: any = {
    id,
    isRegularItem: () => opts.regular !== false,
    deleted: opts.deleted === true,
  };
  if (!opts.noGetNotes) {
    base.getNotes = () => {
      if (opts.throwsOnNotes) throw new Error('boom');
      return opts.notes ?? [];
    };
  }
  return base;
}

/**
 * Default world: nothing is excluded, every item resolves to an identity,
 * every item is indexed, and every note id resolves to a live note. Each test
 * overrides only the rule it is about.
 */
function deps(overrides: Partial<NoteBackfillDeps> = {}): NoteBackfillDeps & {
  indexedCalls: number[];
} {
  const indexedCalls: number[] = [];
  const base: NoteBackfillDeps = {
    hasExcludeTag: () => false,
    identityOf: (i: any) => ({ libraryKey: 'user', itemKey: `K${i.id}` }),
    isIndexed: async (_libraryKey: string, itemKey: string) => {
      indexedCalls.push(Number(itemKey.slice(1)));
      return true;
    },
    getNote: async (noteId: number) => ({ deleted: noteId < 0 }),
  };
  return Object.assign(base, overrides, { indexedCalls }) as any;
}

test('keeps an indexed regular item that has a live child note', async () => {
  const d = deps();
  const out = await selectNoteBackfillCandidates([item(1, { notes: [10] })], d);
  assert.deepEqual(out.map((i: any) => i.id), [1]);
});

test('drops items with no notes, notes/attachments, and trashed items', async () => {
  const d = deps();
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [] }),
    item(2, { regular: false, notes: [10] }),
    item(3, { deleted: true, notes: [10] }),
    item(4, { noGetNotes: true }),
    item(5, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [5]);
});

test('drops an item whose every child note is in the trash', async () => {
  // Negative ids resolve to a note with deleted: true in the fake world.
  const d = deps();
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [-10, -11] }),
    item(2, { notes: [-10, 11] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [2]);
});

test('drops an item that is not yet indexed under the active model', async () => {
  // Ordinary Update Index already covers it, notes included, so a backfill
  // would only duplicate that work.
  const d = deps({ isIndexed: async (_lk: string, itemKey: string) => itemKey === 'K2' });
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [10] }),
    item(2, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [2]);
});

test('drops excluded items and items with no resolvable identity', async () => {
  const d = deps({
    hasExcludeTag: (i: any) => i.id === 1,
    identityOf: (i: any) => (i.id === 2 ? null : { libraryKey: 'user', itemKey: `K${i.id}` }),
  });
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [10] }),
    item(2, { notes: [10] }),
    item(3, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [3]);
});

test('does not query the index for items that failed a cheaper rule', async () => {
  // The store lookup is the only per-item database query in the scan; on a
  // large library it must not run for items that have no notes at all.
  const d = deps();
  await selectNoteBackfillCandidates([
    item(1, { notes: [] }),
    item(2, { notes: [10] }),
    item(3, { regular: false, notes: [10] }),
  ], d);
  assert.deepEqual(d.indexedCalls, [2]);
});

test('de-duplicates an item that appears twice', async () => {
  const d = deps();
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [10] }),
    item(1, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [1]);
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
  const out = await selectNoteBackfillCandidates([
    item(1, { notes: [10] }),
    item(2, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [2]);
  assert.equal(errors.length, 1);
});

test('an unreadable note is skipped without losing its siblings', async () => {
  const errors: string[] = [];
  const d = deps({
    getNote: async (noteId: number) => {
      if (noteId === 10) throw new Error('unreadable');
      return { deleted: false };
    },
    onError: (m: string) => errors.push(m),
  });
  const out = await selectNoteBackfillCandidates([item(1, { notes: [10, 11] })], d);
  assert.deepEqual(out.map((i: any) => i.id), [1]);
  assert.equal(errors.length, 1);
});

test('a throwing getNotes drops the item instead of the run', async () => {
  const errors: string[] = [];
  const d = deps({ onError: (m: string) => errors.push(m) });
  const out = await selectNoteBackfillCandidates([
    item(1, { throwsOnNotes: true }),
    item(2, { notes: [10] }),
  ], d);
  assert.deepEqual(out.map((i: any) => i.id), [2]);
  assert.equal(errors.length, 1);
});

test('collectNoteBackfillItems scans every library it is given', async () => {
  const calls: Array<number | undefined> = [];
  const api = {
    getLibraryItems: async (libraryId?: number) => {
      calls.push(libraryId);
      return libraryId === 1 ? [item(1, { notes: [10] })] : [item(2, { notes: [] })];
    },
  };
  const out = await collectNoteBackfillItems(api, [1, 7], deps());
  assert.deepEqual(calls, [1, 7]);
  assert.deepEqual(out.map((i: any) => i.id), [1]);
});

test('collectNoteBackfillItems survives a library that cannot be listed', async () => {
  const errors: string[] = [];
  const api = {
    getLibraryItems: async (libraryId?: number) => {
      if (libraryId === 1) throw new Error('group gone');
      return [item(2, { notes: [10] })];
    },
  };
  const out = await collectNoteBackfillItems(api, [1, 7], deps({ onError: (m: string) => errors.push(m) }));
  assert.deepEqual(out.map((i: any) => i.id), [2]);
  assert.equal(errors.length, 1);
});
