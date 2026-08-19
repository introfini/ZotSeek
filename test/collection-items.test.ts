import { test } from 'node:test';
import assert from 'node:assert/strict';
import { collectCollectionItems } from '../src/utils/collection-items';

/** Minimal stand-in for a Zotero item as collectCollectionItems sees it. */
const item = (id: number, regular = true) => ({ id, isRegularItem: () => regular });

function fakeAPI(byCollection: Record<number, any[]>) {
  const calls: Array<{ collectionId: number; libraryId?: number }> = [];
  return {
    calls,
    getCollectionItems: async (collectionId: number, libraryId?: number) => {
      calls.push({ collectionId, libraryId });
      return byCollection[collectionId] ?? [];
    },
  };
}

test('de-duplicates items shared between collections, keeping first-seen order', async () => {
  const api = fakeAPI({ 10: [item(1), item(2)], 20: [item(2), item(3)] });
  const items = await collectCollectionItems(api, [
    { libraryId: 1, collectionId: 10 },
    { libraryId: 1, collectionId: 20 },
  ]);
  assert.deepEqual(items.map((i: any) => i.id), [1, 2, 3]);
});

test('drops attachments, notes and malformed rows', async () => {
  const api = fakeAPI({ 10: [item(1), item(2, false), { id: 3 }, null] });
  const items = await collectCollectionItems(api, [{ libraryId: 1, collectionId: 10 }]);
  assert.deepEqual(items.map((i: any) => i.id), [1]);
});

test('keeps each collection with its own library, for cross-library selections', async () => {
  // Zotero 10 lets a selection span libraries, so the library ID must travel
  // with each collection rather than being assumed to be the user library.
  const api = fakeAPI({ 10: [item(1)], 20: [item(2)] });
  await collectCollectionItems(api, [
    { libraryId: 1, collectionId: 10 },
    { libraryId: 7, collectionId: 20 },
  ]);
  assert.deepEqual(api.calls, [
    { collectionId: 10, libraryId: 1 },
    { collectionId: 20, libraryId: 7 },
  ]);
});

test('an empty selection resolves without touching the API', async () => {
  const api = fakeAPI({});
  assert.deepEqual(await collectCollectionItems(api, []), []);
  assert.equal(api.calls.length, 0);
});

test('tolerates a collection that resolves to nothing', async () => {
  const api = fakeAPI({ 10: [] });
  assert.deepEqual(await collectCollectionItems(api, [{ libraryId: 1, collectionId: 10 }]), []);
});
