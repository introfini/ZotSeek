/**
 * Self-test suite for Task 9: getIndexStatusMap refactor in vector-store-sqlite.
 *
 * Exercises both the new identity-keyed status API and the legacy shim:
 *  - getIndexStatusByIdentity returns status for a known item
 *  - getIndexStatusByIdentity handles batches larger than the 200 chunk size
 *  - getIndexStatusByIdentity returns empty map for empty input
 *  - getIndexStatusByIdentity skips unknown identities
 *  - legacy getIndexStatusMap(itemIds) shim returns map keyed by itemId
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const DB = 'zotseek';

interface KnownItem {
  libraryKey: string;
  itemKey: string;
  itemPk: number;
}

async function pickKnownIndexedItem(): Promise<KnownItem | null> {
  const [libKeys, itemKeys, pks] = await Promise.all([
    Zotero.DB.columnQueryAsync(
      `SELECT library_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_pk FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
  ]);
  if (!libKeys.length) return null;
  return {
    libraryKey: String(libKeys[0]),
    itemKey: String(itemKeys[0]),
    itemPk: Number(pks[0]),
  };
}

async function pickKnownIndexedItems(limit: number): Promise<KnownItem[]> {
  const [libKeys, itemKeys, pks] = await Promise.all([
    Zotero.DB.columnQueryAsync(
      `SELECT library_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT ?`,
      [limit]
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT ?`,
      [limit]
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_pk FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT ?`,
      [limit]
    ).then((r: any) => r || []),
  ]);
  const out: KnownItem[] = [];
  for (let i = 0; i < libKeys.length; i++) {
    out.push({
      libraryKey: String(libKeys[i]),
      itemKey: String(itemKeys[i]),
      itemPk: Number(pks[i]),
    });
  }
  return out;
}

selfTest.register('task-9-status-map', async () => {
  const known = await pickKnownIndexedItem();

  return [
    await scenario('getIndexStatusByIdentity returns status for a known item', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const map = await vectorStoreSQLite.getIndexStatusByIdentity([
        { libraryKey: known!.libraryKey, itemKey: known!.itemKey },
      ]);
      assertEq(map.size, 1);
      const key = `${known!.libraryKey}|${known!.itemKey}`;
      const status = map.get(key);
      assertTrue(status !== undefined, 'expected status entry');
      assertEq(status!.libraryKey, known!.libraryKey);
      assertEq(status!.itemKey, known!.itemKey);
      assertTrue(typeof status!.indexedAt === 'string' && status!.indexedAt.length > 0, 'expected indexedAt');
      assertTrue(status!.chunkCount > 0, `expected chunkCount > 0, got ${status!.chunkCount}`);
    }),

    await scenario('getIndexStatusByIdentity handles batch larger than 200', async () => {
      const items = await pickKnownIndexedItems(250);
      assertTrue(items.length === 250, `expected 250 known items, got ${items.length}`);
      const identities = items.map(i => ({ libraryKey: i.libraryKey, itemKey: i.itemKey }));
      const map = await vectorStoreSQLite.getIndexStatusByIdentity(identities);
      assertEq(map.size, 250);
    }),

    await scenario('getIndexStatusByIdentity returns empty map for empty input', async () => {
      const map = await vectorStoreSQLite.getIndexStatusByIdentity([]);
      assertEq(map.size, 0);
    }),

    await scenario('getIndexStatusByIdentity skips unknown identities', async () => {
      const real = await pickKnownIndexedItems(2);
      assertTrue(real.length === 2, 'need 2 known items for this test');
      const identities = [
        { libraryKey: real[0].libraryKey, itemKey: real[0].itemKey },
        { libraryKey: real[1].libraryKey, itemKey: real[1].itemKey },
        { libraryKey: 'user', itemKey: 'ZZZZZZZZ' },
        { libraryKey: 'user', itemKey: 'YYYYYYYY' },
      ];
      const map = await vectorStoreSQLite.getIndexStatusByIdentity(identities);
      assertEq(map.size, 2);
    }),

    await scenario('legacy getIndexStatusMap(itemIds) shim works', async () => {
      // Pick known items, resolve to live Zotero local IDs.
      const items = await pickKnownIndexedItems(20);
      assertTrue(items.length > 0, 'no known indexed items');
      const userLibID = Zotero.Libraries.userLibraryID;
      const itemIds: number[] = [];
      for (const it of items) {
        if (it.libraryKey !== 'user') continue;
        const localID = Zotero.Items.getIDFromLibraryAndKey(userLibID, it.itemKey);
        if (typeof localID === 'number' && localID > 0) itemIds.push(localID);
        if (itemIds.length === 5) break;
      }
      assertTrue(itemIds.length === 5, `expected 5 live Zotero IDs, got ${itemIds.length}`);
      const map = await vectorStoreSQLite.getIndexStatusMap(itemIds);
      assertEq(map.size, 5);
      for (const id of itemIds) {
        const status = map.get(id);
        assertTrue(status !== undefined, `expected status for itemId=${id}`);
        assertEq(status!.itemId, id);
        assertTrue(typeof status!.libraryKey === 'string' && status!.libraryKey.length > 0, 'libraryKey missing');
        assertTrue(typeof status!.itemKey === 'string' && status!.itemKey.length === 8, 'itemKey missing/malformed');
        assertTrue(typeof status!.indexedAt === 'string' && status!.indexedAt.length > 0, 'indexedAt missing');
        assertTrue(status!.chunkCount > 0, `expected chunkCount > 0, got ${status!.chunkCount}`);
      }
    }),
  ];
});
