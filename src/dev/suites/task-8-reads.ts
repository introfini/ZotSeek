/**
 * Self-test suite for Task 8: read methods refactor in vector-store-sqlite.
 *
 * Exercises identity-keyed read API and deprecated id-based shims:
 *  - getByIdentity returns embedding for known item; undefined for unknown
 *  - getItemChunksByIdentity returns all chunks for an item
 *  - getAll returns PaperEmbedding[] with libraryKey/itemKey populated,
 *    orphans excluded, embeddings 768-dim
 *  - getByLibrary translates libraryId to libraryKey
 *  - deprecated get(itemId) shim mirrors getByIdentity
 *  - getAllCached entries include itemPk and resolved itemId (or -1 for orphans)
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';
import { getActiveModelId } from '../../core/model-registry';

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

async function pickMultiChunkItem(): Promise<KnownItem | null> {
  // Find a non-orphan item with >1 chunks
  // Count within one model: an item holding one chunk under each of two models
  // is not a multi-chunk item for this purpose, and picking it would make the
  // scenario below assert nothing.
  const rows = await Zotero.DB.columnQueryAsync(
    `SELECT c.item_pk FROM ${DB}.chunks c
     INNER JOIN ${DB}.items i ON c.item_pk = i.item_pk
     WHERE i.library_key != 'orphan' AND c.model_id = ?
     GROUP BY c.item_pk HAVING COUNT(*) > 1
     ORDER BY c.item_pk LIMIT 1`,
    [getActiveModelId()]
  );
  if (!rows || !rows.length) return null;
  const pk = Number(rows[0]);
  const [lk, ik] = await Promise.all([
    Zotero.DB.valueQueryAsync(`SELECT library_key FROM ${DB}.items WHERE item_pk = ?`, [pk]),
    Zotero.DB.valueQueryAsync(`SELECT item_key FROM ${DB}.items WHERE item_pk = ?`, [pk]),
  ]);
  return {
    libraryKey: String(lk),
    itemKey: String(ik),
    itemPk: pk,
  };
}

selfTest.register('task-8-reads', async () => {
  const known = await pickKnownIndexedItem();
  const multi = await pickMultiChunkItem();

  return [
    await scenario('getByIdentity returns embedding for known item', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const e = await vectorStoreSQLite.getByIdentity(known!.libraryKey, known!.itemKey);
      assertTrue(e !== undefined, 'expected PaperEmbedding, got undefined');
      assertEq(e!.libraryKey, known!.libraryKey);
      assertEq(e!.itemKey, known!.itemKey);
      assertTrue(Array.isArray(e!.embedding), 'expected embedding array');
      assertEq(e!.embedding.length, 768);
    }),

    await scenario('getByIdentity returns undefined for unknown identity', async () => {
      const e = await vectorStoreSQLite.getByIdentity('user', 'ZZZZZZZZ');
      assertEq(e, undefined);
    }),

    await scenario('getItemChunksByIdentity returns all chunks for an item', async () => {
      assertTrue(multi, 'no multi-chunk non-orphan item available');
      // Count under the active model only: since schema v9 the same item can
      // hold chunks for several models, and getItemChunksByIdentity returns
      // just the active one so find_similar never mixes dimensions.
      const expected = Number(
        await Zotero.DB.valueQueryAsync(
          `SELECT COUNT(*) FROM ${DB}.chunks WHERE item_pk = ? AND model_id = ?`,
          [multi!.itemPk, getActiveModelId()]
        )
      );
      const chunks = await vectorStoreSQLite.getItemChunksByIdentity(
        multi!.libraryKey,
        multi!.itemKey
      );
      assertEq(chunks.length, expected);
      assertTrue(
        chunks.every(c => c.libraryKey === multi!.libraryKey && c.itemKey === multi!.itemKey),
        'all chunks must share identity'
      );
    }),

    await scenario('getAll returns PaperEmbedding[] with libraryKey populated', async () => {
      const all = await vectorStoreSQLite.getAll();
      assertTrue(Array.isArray(all), 'expected array');
      const expected = Number(
        await Zotero.DB.valueQueryAsync(
          `SELECT COUNT(*) FROM ${DB}.chunks c INNER JOIN ${DB}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan'`
        )
      );
      assertEq(all.length, expected);
      // No orphans, every libraryKey is 'user' or 'group:N', every itemKey is 8 chars
      for (const e of all.slice(0, 100)) {
        assertTrue(
          e.libraryKey === 'user' || e.libraryKey.startsWith('group:'),
          `unexpected libraryKey ${e.libraryKey}`
        );
        assertEq(e.itemKey.length, 8);
        assertTrue(typeof e.itemPk === 'number' && e.itemPk > 0, 'expected positive itemPk');
      }
    }),

    await scenario('getByLibrary translates libraryId to libraryKey', async () => {
      const userLibID = Zotero.Libraries.userLibraryID;
      const results = await vectorStoreSQLite.getByLibrary(userLibID);
      assertTrue(Array.isArray(results), 'expected array');
      // If there are any user items at all, they must all be tagged 'user'
      if (results.length > 0) {
        assertTrue(
          results.every(e => e.libraryKey === 'user'),
          'expected all results to have libraryKey="user"'
        );
      }
    }),

    await scenario('deprecated get(itemId) shim works', async () => {
      assertTrue(known, 'no non-orphan indexed item available');
      const libID =
        known!.libraryKey === 'user'
          ? Zotero.Libraries.userLibraryID
          : null;
      assertTrue(libID !== null, 'cannot resolve library ID');
      const localID = Zotero.Items.getIDFromLibraryAndKey(libID, known!.itemKey);
      assertTrue(typeof localID === 'number' && localID > 0, 'no live Zotero ID');
      const fromShim = await vectorStoreSQLite.get(localID);
      const fromIdentity = await vectorStoreSQLite.getByIdentity(known!.libraryKey, known!.itemKey);
      assertTrue(fromShim !== undefined, 'shim returned undefined');
      assertTrue(fromIdentity !== undefined, 'identity returned undefined');
      assertEq(fromShim!.itemPk, fromIdentity!.itemPk);
      assertEq(fromShim!.chunkIndex, fromIdentity!.chunkIndex);
    }),

    await scenario('getAllCached has itemPk and resolves itemId', async () => {
      const cached = await vectorStoreSQLite.getAllCached();
      assertTrue(Array.isArray(cached), 'expected array');
      assertTrue(cached.length > 0, 'expected at least one cached entry');
      for (const c of cached.slice(0, 50)) {
        assertTrue(typeof c.itemPk === 'number' && c.itemPk > 0, 'expected positive itemPk');
        assertTrue(typeof c.itemId === 'number', 'expected numeric itemId (or -1 for orphans)');
        assertTrue(
          c.libraryKey === 'user' || c.libraryKey.startsWith('group:'),
          `unexpected libraryKey ${c.libraryKey}`
        );
        assertEq(c.itemKey.length, 8);
        assertTrue(c.embedding instanceof Float32Array, 'expected Float32Array embedding');
      }
    }),
  ];
});
