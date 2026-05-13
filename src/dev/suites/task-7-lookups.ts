/**
 * Self-test suite for Task 7: lookup methods refactor in vector-store-sqlite.
 *
 * Exercises identity-keyed lookup API and the deprecated id-based shims:
 *  - isIndexedByIdentity (true for known, false for unknown)
 *  - getChunkCountByIdentity matches direct SQL count
 *  - needsReindexByIdentity (false when hash matches, true when differs/unknown)
 *  - getUniqueItemIds returns current local Zotero IDs, excludes orphans
 *  - deprecated isIndexed(itemId) shim delegates correctly
 *
 * Tests are read-only against the production DB state.
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const DB = 'zotseek';

interface KnownItemRow {
  libraryKey: string;
  itemKey: string;
  itemPk: number;
  contentHash: string;
}

/**
 * Pick the first non-orphan indexed item from the DB. Returns null if none.
 */
async function pickKnownIndexedItem(): Promise<KnownItemRow | null> {
  const [libKeys, itemKeys, pks, hashes] = await Promise.all([
    Zotero.DB.columnQueryAsync(
      `SELECT library_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_pk FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT content_hash FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 1`
    ).then((r: any) => r || []),
  ]);
  if (!libKeys.length) return null;
  return {
    libraryKey: String(libKeys[0]),
    itemKey: String(itemKeys[0]),
    itemPk: Number(pks[0]),
    contentHash: String(hashes[0] || ''),
  };
}

selfTest.register('task-7-lookups', async () => {
  const known = await pickKnownIndexedItem();

  return [
    await scenario('isIndexedByIdentity returns true for known indexed item', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const result = await vectorStoreSQLite.isIndexedByIdentity(
        known!.libraryKey,
        known!.itemKey
      );
      assertEq(result, true);
    }),

    await scenario('isIndexedByIdentity returns false for unknown identity', async () => {
      const result = await vectorStoreSQLite.isIndexedByIdentity('user', 'ZZZZZZZZ');
      assertEq(result, false);
    }),

    await scenario('getChunkCountByIdentity returns chunk count', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const expected = Number(
        await Zotero.DB.valueQueryAsync(
          `SELECT COUNT(*) FROM ${DB}.chunks WHERE item_pk = ?`,
          [known!.itemPk]
        )
      );
      const actual = await vectorStoreSQLite.getChunkCountByIdentity(
        known!.libraryKey,
        known!.itemKey
      );
      assertEq(actual, expected);
    }),

    await scenario('needsReindexByIdentity returns false when contentHash matches', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const result = await vectorStoreSQLite.needsReindexByIdentity(
        known!.libraryKey,
        known!.itemKey,
        known!.contentHash
      );
      assertEq(result, false);
    }),

    await scenario('needsReindexByIdentity returns true when contentHash differs', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const result = await vectorStoreSQLite.needsReindexByIdentity(
        known!.libraryKey,
        known!.itemKey,
        'different-hash'
      );
      assertEq(result, true);
    }),

    await scenario('needsReindexByIdentity returns true for unknown item', async () => {
      const result = await vectorStoreSQLite.needsReindexByIdentity(
        'user',
        'ZZZZZZZZ',
        'any-hash'
      );
      assertEq(result, true);
    }),

    await scenario('getUniqueItemIds returns array of current local Zotero IDs', async () => {
      const ids = await vectorStoreSQLite.getUniqueItemIds();
      assertTrue(Array.isArray(ids), 'expected array');
      assertTrue(
        ids.every((n: number) => typeof n === 'number' && Number.isFinite(n)),
        'expected array of numbers'
      );
      // Sanity: each must resolve to a real Zotero item
      for (const id of ids) {
        const item = Zotero.Items.get(id);
        assertTrue(item && typeof item === 'object', `expected Zotero item for id ${id}`);
      }
      // Count should be at most the total non-orphan items in the DB
      const totalRows = Number(
        await Zotero.DB.valueQueryAsync(
          `SELECT COUNT(*) FROM ${DB}.items WHERE library_key != 'orphan'`
        )
      );
      assertTrue(
        ids.length <= totalRows,
        `expected getUniqueItemIds().length (${ids.length}) <= non-orphan rows (${totalRows})`
      );
    }),

    await scenario('deprecated isIndexed(itemId) shim delegates correctly', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      // Resolve the local Zotero item ID from stable identity
      const libraryID =
        known!.libraryKey === 'user'
          ? Zotero.Libraries.userLibraryID
          : null;
      assertTrue(libraryID !== null, 'unable to resolve library ID from key');
      const localID = Zotero.Items.getIDFromLibraryAndKey(libraryID, known!.itemKey);
      assertTrue(
        typeof localID === 'number' && localID > 0,
        `expected live Zotero ID for ${known!.libraryKey}/${known!.itemKey}`
      );
      const result = await vectorStoreSQLite.isIndexed(localID);
      assertEq(result, true);
    }),
  ];
});
