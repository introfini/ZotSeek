/**
 * Self-test suite for Task 10: housekeeping methods in vector-store-sqlite.
 *
 * Exercises the v8-schema-aware versions of:
 *  - getStats: totals exclude orphan rows
 *  - getCount: chunk count excluding orphan-owned chunks
 *  - getItemCount: item count excluding orphans
 *
 * The clear() scenario is intentionally skipped on the dev DB because it
 * deletes every row in chunks/items/orphan_items. The SQL is exercised by
 * later end-to-end tests on a disposable database.
 */

import { selfTest, scenario, assertEq, assertTrue, Scenario } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const DB = 'zotseek';

async function countItemsExcludingOrphans(): Promise<number> {
  const v = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.items WHERE library_key != 'orphan'`
  );
  return Number(v) || 0;
}

async function countAllChunks(): Promise<number> {
  const v = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.chunks`
  );
  return Number(v) || 0;
}

async function countLiveChunks(): Promise<number> {
  const v = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.chunks c
     INNER JOIN ${DB}.items i ON c.item_pk = i.item_pk
     WHERE i.library_key != 'orphan'`
  );
  return Number(v) || 0;
}

async function countOrphanItems(): Promise<number> {
  const v = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.items WHERE library_key = 'orphan'`
  );
  return Number(v) || 0;
}

selfTest.register('task-10-housekeeping', async () => {
  return [
    await scenario('getStats returns correct indexedPapers (excluding orphans)', async () => {
      const expected = await countItemsExcludingOrphans();
      const stats = await vectorStoreSQLite.getStats();
      assertEq(stats.indexedPapers, expected, 'indexedPapers must exclude orphans');
    }),

    await scenario('getStats returns correct totalChunks (live only)', async () => {
      const expected = await countLiveChunks();
      const stats = await vectorStoreSQLite.getStats();
      assertEq(stats.totalChunks, expected, 'totalChunks must exclude orphan-owned chunks');
    }),

    await scenario('getStats storage size is plausible', async () => {
      const stats = await vectorStoreSQLite.getStats();
      assertTrue(
        stats.storageUsedBytes > 0,
        `expected storageUsedBytes > 0, got ${stats.storageUsedBytes}`
      );
    }),

    await scenario('getCount returns live chunk count (excluding orphans)', async () => {
      const expected = await countLiveChunks();
      const actual = await vectorStoreSQLite.getCount();
      assertEq(actual, expected, 'getCount must equal live chunk count');
    }),

    await scenario('getItemCount returns item count excluding orphans', async () => {
      const expected = await countItemsExcludingOrphans();
      const actual = await vectorStoreSQLite.getItemCount();
      assertEq(actual, expected, 'getItemCount must exclude orphans');
    }),

    await scenario('getCount and getItemCount stay consistent with each other', async () => {
      const totalChunks = await countAllChunks();
      const liveChunks = await vectorStoreSQLite.getCount();
      assertTrue(
        liveChunks <= totalChunks,
        `live chunks (${liveChunks}) must be <= total chunks (${totalChunks})`
      );
      const itemCount = await vectorStoreSQLite.getItemCount();
      const orphanCount = await countOrphanItems();
      const rawItemTotal = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB}.items`
      );
      assertEq(
        itemCount + orphanCount,
        Number(rawItemTotal) || 0,
        'itemCount + orphanCount must equal total items'
      );
    }),

    // clear() truncates chunks, items, and orphan_items. Running it against
    // the dev DB would wipe ~785MB of indexed content. The SQL itself is
    // simple (DELETE FROM each table + DELETE FROM sqlite_sequence WHERE
    // name='items') and will be exercised end-to-end on a disposable DB.
    {
      name: 'clear() truncates all tables (skipped on dev DB)',
      status: 'skip',
      durationMs: 0,
      details: 'Destructive against live data; verified by end-to-end tests on disposable DB.',
    } satisfies Scenario,
  ];
});
