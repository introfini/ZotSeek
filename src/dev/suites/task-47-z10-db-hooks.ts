import { selfTest, scenario, assertTrue, assertEq } from '../self-test';
import { collectCollectionItems } from '../../utils/collection-items';

declare const Zotero: any;

/** Minimal stand-in for a Zotero item as collectCollectionItems sees it. */
function fakeItem(id: number, regular = true): any {
  return { id, isRegularItem: () => regular };
}

/** Stub API returning a canned item list per collection ID. */
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

selfTest.register('task-47-z10-db-hooks', async () => {
  return [
    await scenario('collectCollectionItems de-duplicates across collections', async () => {
      // Item 2 sits in both collections; it should be indexed once.
      const api = fakeAPI({ 10: [fakeItem(1), fakeItem(2)], 20: [fakeItem(2), fakeItem(3)] });
      const items = await collectCollectionItems(api, [
        { libraryId: 1, collectionId: 10 },
        { libraryId: 1, collectionId: 20 },
      ]);
      assertEq(items.length, 3, 'three distinct items');
      assertEq(items.map((i: any) => i.id).join(','), '1,2,3', 'first-seen order preserved');
    }),

    await scenario('collectCollectionItems drops non-regular items', async () => {
      const api = fakeAPI({ 10: [fakeItem(1), fakeItem(2, false), { id: 3 }] });
      const items = await collectCollectionItems(api, [{ libraryId: 1, collectionId: 10 }]);
      assertEq(items.length, 1, 'attachments/notes and shapeless rows are skipped');
      assertEq(items[0].id, 1);
    }),

    await scenario('collectCollectionItems passes the owning library per collection', async () => {
      // Zotero 10 allows selecting collections across libraries at once, so the
      // library ID must travel with each collection rather than being assumed.
      const api = fakeAPI({ 10: [fakeItem(1)], 20: [fakeItem(2)] });
      await collectCollectionItems(api, [
        { libraryId: 1, collectionId: 10 },
        { libraryId: 7, collectionId: 20 },
      ]);
      assertEq(api.calls.length, 2);
      assertEq(api.calls[0].libraryId, 1);
      assertEq(api.calls[1].libraryId, 7, 'group library ID is not overwritten by the user library');
    }),

    await scenario('empty selection resolves to no items without calling the API', async () => {
      const api = fakeAPI({});
      const items = await collectCollectionItems(api, []);
      assertEq(items.length, 0);
      assertEq(api.calls.length, 0);
    }),

    await scenario('a collection that resolves to nothing is tolerated', async () => {
      const api = fakeAPI({ 10: [] });
      const items = await collectCollectionItems(api, [{ libraryId: 1, collectionId: 10 }]);
      assertEq(items.length, 0, 'empty collection contributes nothing rather than throwing');
    }),

    await scenario('Zotero.DB exposes the hooks this build depends on', async () => {
      // Both are feature-detected in production; this records which path the
      // running client actually takes, so a failure here is informational on
      // Zotero 8/9 and meaningful on Zotero 10.
      const hasOnConnect = typeof Zotero.DB?.onConnect === 'function';
      const hasOnIdle = typeof Zotero.DB?.onIdle === 'function';
      Zotero.debug(`[ZotSeek] self-test: onConnect=${hasOnConnect} onIdle=${hasOnIdle} version=${Zotero.version}`);
      const major = parseInt(String(Zotero.version).split('.')[0], 10);
      if (major >= 10) {
        assertTrue(hasOnConnect, 'Zotero 10 must expose Zotero.DB.onConnect');
        assertTrue(hasOnIdle, 'Zotero 10 must expose Zotero.DB.onIdle');
      }
    }),

    await scenario('the onConnect re-attach hook is registered on the live store', async () => {
      if (typeof Zotero.DB?.onConnect !== 'function') return; // Zotero 8/9: lazy check only
      const callbacks = Zotero.DB._onConnectCallbacks;
      assertTrue(Array.isArray(callbacks), '_onConnectCallbacks is readable');
      assertTrue(callbacks.length > 0, 'at least one onConnect callback is registered');
    }),

    await scenario('recoverAttachment restores a dropped zotseek schema', async () => {
      // What the onConnect hook does. Staged with a manual DETACH because a
      // real reconnect would mean closing Zotero's live database.
      const store = Zotero.ZotSeek?.vectorStore;
      if (!store?.isReady?.()) return;
      await Zotero.DB.queryAsync('DETACH DATABASE zotseek');
      const gone = await Zotero.DB.queryAsync('PRAGMA database_list');
      assertTrue(!gone.some((d: any) => d.name === 'zotseek'), 'schema really was dropped');

      await store.recoverAttachment();

      const back = await Zotero.DB.queryAsync('PRAGMA database_list');
      assertTrue(back.some((d: any) => d.name === 'zotseek'), 'schema was re-attached');
      const stats = await store.getStats();
      assertTrue(Number(stats.totalPapers) >= 0, 'store is queryable again');
    }),

    await scenario('ensureInit still recovers on its own (Zotero 8/9 fallback)', async () => {
      // The lazy path predates onConnect and remains the only recovery on
      // versions without it, so it must keep working independently.
      const store = Zotero.ZotSeek?.vectorStore;
      if (!store?.isReady?.()) return;
      await Zotero.DB.queryAsync('DETACH DATABASE zotseek');
      const stats = await store.getStats(); // goes through ensureInit()
      const back = await Zotero.DB.queryAsync('PRAGMA database_list');
      assertTrue(back.some((d: any) => d.name === 'zotseek'), 'ensureInit re-attached without the hook');
      assertTrue(Number(stats.totalChunks ?? 0) > 0, 'real data came back, not a swallowed zero');
    }),

  ];
});
