/**
 * Self-test suite for Task 6: write/delete refactor in vector-store-sqlite.
 *
 * Exercises the new identity-based write/delete API:
 *  - getOrCreateItemPk dedup via put-upsert behaviour
 *  - put writes a new items row when the identity is unseen
 *  - put updates metadata when the identity already exists
 *  - deleteItem removes both items and chunks rows in one transaction
 *  - putBatch dedups items across multiple chunks (1 item, N chunks)
 *  - putBatch handles multiple distinct items in one transaction
 *
 * The dev DB has thousands of real indexed items. To avoid polluting it,
 * every scenario picks (or creates) an UNINDEXED item, runs its assertions,
 * and cleans up via deleteItem before returning.
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite, PaperEmbedding } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const DB = 'zotseek';

function makeEmbedding(
  itemKey: string,
  overrides: Partial<PaperEmbedding> = {}
): PaperEmbedding {
  return {
    libraryKey: 'user',
    itemKey,
    chunkIndex: 0,
    title: 'Task 6 test item',
    abstract: 'abstract for test',
    chunkText: 'test chunk text',
    textSource: 'abstract',
    embedding: new Array(768).fill(0),
    modelId: 'test-model',
    indexedAt: new Date().toISOString(),
    contentHash: 'hash-original',
    ...overrides,
  } as PaperEmbedding;
}

/**
 * Locate an UNINDEXED item in the user library. We pull all indexed item_keys
 * from zotseek.items, then iterate Zotero.Items.getAll until we find one
 * whose key isn't in that set. Returns null if every item is already indexed
 * (very unlikely in practice).
 */
async function pickUnindexedUserItem(): Promise<any | null> {
  const indexedKeysRaw = (await Zotero.DB.columnQueryAsync(
    `SELECT item_key FROM ${DB}.items WHERE library_key = 'user'`
  )) || [];
  const indexedKeys = new Set<string>(indexedKeysRaw.map((k: any) => String(k)));

  const userLibraryID = Zotero.Libraries.userLibraryID;
  const items: any[] =
    (await Zotero.Items.getAll(userLibraryID, false, true)) || [];
  for (const item of items) {
    if (
      item &&
      item.key &&
      !item.deleted &&
      typeof item.isRegularItem === 'function' &&
      item.isRegularItem() &&
      !indexedKeys.has(item.key)
    ) {
      return item;
    }
  }
  return null;
}

/**
 * Convenience: read item_pk for an identity, or null if absent.
 */
async function lookupItemPk(itemKey: string): Promise<number | null> {
  const pk = await Zotero.DB.valueQueryAsync(
    `SELECT item_pk FROM ${DB}.items WHERE library_key = 'user' AND item_key = ?`,
    [itemKey]
  );
  if (!pk) return null;
  const n = Number(pk);
  return n > 0 ? n : null;
}

async function chunkCountForPk(pk: number): Promise<number> {
  const n = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.chunks WHERE item_pk = ?`,
    [pk]
  );
  return Number(n || 0);
}

selfTest.register('task-6-write-delete', async () => {
  const sample = await pickUnindexedUserItem();

  return [
    await scenario('put writes new item row with identity', async () => {
      assertTrue(sample, 'no unindexed user-library item available');
      // Ensure clean slate
      await vectorStoreSQLite.deleteItem('user', sample.key);
      try {
        const e = makeEmbedding(sample.key);
        await vectorStoreSQLite.put(e);
        const pk = await lookupItemPk(sample.key);
        assertTrue(pk !== null, 'expected items row created by put');
        // verify metadata column was written through
        const title = await Zotero.DB.valueQueryAsync(
          `SELECT title FROM ${DB}.items WHERE item_pk = ?`,
          [pk]
        );
        assertEq(title, 'Task 6 test item');
      } finally {
        await vectorStoreSQLite.deleteItem('user', sample.key);
      }
    }),

    await scenario('put on same identity updates metadata', async () => {
      assertTrue(sample, 'no unindexed user-library item available');
      await vectorStoreSQLite.deleteItem('user', sample.key);
      try {
        await vectorStoreSQLite.put(makeEmbedding(sample.key));
        const pk1 = await lookupItemPk(sample.key);
        assertTrue(pk1 !== null, 'first put must create row');

        // Second put with different title + content_hash, same identity
        await vectorStoreSQLite.put(
          makeEmbedding(sample.key, {
            title: 'Task 6 UPDATED title',
            contentHash: 'hash-updated',
            indexedAt: new Date(Date.now() + 1000).toISOString(),
          })
        );

        const pk2 = await lookupItemPk(sample.key);
        assertEq(pk2, pk1, 'item_pk must be stable across re-put');

        const rowCount = Number(
          await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${DB}.items WHERE library_key = 'user' AND item_key = ?`,
            [sample.key]
          )
        );
        assertEq(rowCount, 1, 'must be exactly one items row');

        const title = await Zotero.DB.valueQueryAsync(
          `SELECT title FROM ${DB}.items WHERE item_pk = ?`,
          [pk2]
        );
        assertEq(title, 'Task 6 UPDATED title');
        const hash = await Zotero.DB.valueQueryAsync(
          `SELECT content_hash FROM ${DB}.items WHERE item_pk = ?`,
          [pk2]
        );
        assertEq(hash, 'hash-updated');
      } finally {
        await vectorStoreSQLite.deleteItem('user', sample.key);
      }
    }),

    await scenario('getOrCreateItemPk returns same pk for same identity', async () => {
      assertTrue(sample, 'no unindexed user-library item available');
      await vectorStoreSQLite.deleteItem('user', sample.key);
      try {
        await vectorStoreSQLite.put(makeEmbedding(sample.key));
        await vectorStoreSQLite.put(makeEmbedding(sample.key));
        const count = Number(
          await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${DB}.items WHERE library_key = 'user' AND item_key = ?`,
            [sample.key]
          )
        );
        assertEq(count, 1, 'two puts on same identity must yield one row');
      } finally {
        await vectorStoreSQLite.deleteItem('user', sample.key);
      }
    }),

    await scenario('deleteItem cascades chunks', async () => {
      assertTrue(sample, 'no unindexed user-library item available');
      await vectorStoreSQLite.deleteItem('user', sample.key);
      try {
        await vectorStoreSQLite.put(makeEmbedding(sample.key, { chunkIndex: 0 }));
        await vectorStoreSQLite.put(makeEmbedding(sample.key, { chunkIndex: 1 }));
        const pk = await lookupItemPk(sample.key);
        assertTrue(pk !== null, 'item row must exist before deleteItem');
        const before = await chunkCountForPk(pk!);
        assertEq(before, 2, 'expected 2 chunks before deleteItem');

        await vectorStoreSQLite.deleteItem('user', sample.key);

        const pkAfter = await lookupItemPk(sample.key);
        assertEq(pkAfter, null, 'items row must be gone after deleteItem');
        // chunks rows must be gone too (FK CASCADE off, so the method
        // must delete them explicitly)
        const remaining = Number(
          await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${DB}.chunks WHERE item_pk = ?`,
            [pk]
          )
        );
        assertEq(remaining, 0, 'expected zero chunks for deleted item_pk');
      } finally {
        await vectorStoreSQLite.deleteItem('user', sample.key);
      }
    }),

    await scenario('putBatch dedups items across multiple chunks', async () => {
      assertTrue(sample, 'no unindexed user-library item available');
      await vectorStoreSQLite.deleteItem('user', sample.key);
      try {
        const batch: PaperEmbedding[] = [
          makeEmbedding(sample.key, { chunkIndex: 0, chunkText: 'c0' }),
          makeEmbedding(sample.key, { chunkIndex: 1, chunkText: 'c1' }),
          makeEmbedding(sample.key, { chunkIndex: 2, chunkText: 'c2' }),
        ];
        await vectorStoreSQLite.putBatch(batch);

        const itemRows = Number(
          await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${DB}.items WHERE library_key = 'user' AND item_key = ?`,
            [sample.key]
          )
        );
        assertEq(itemRows, 1, 'one item row expected');

        const pk = await lookupItemPk(sample.key);
        assertTrue(pk !== null, 'item row missing');
        const chunkRows = await chunkCountForPk(pk!);
        assertEq(chunkRows, 3, 'three chunks expected');
      } finally {
        await vectorStoreSQLite.deleteItem('user', sample.key);
      }
    }),

    await scenario('putBatch handles multiple items in one transaction', async () => {
      // Need TWO distinct unindexed items
      const indexedKeysRaw =
        (await Zotero.DB.columnQueryAsync(
          `SELECT item_key FROM ${DB}.items WHERE library_key = 'user'`
        )) || [];
      const indexedKeys = new Set<string>(indexedKeysRaw.map((k: any) => String(k)));
      const userLibraryID = Zotero.Libraries.userLibraryID;
      const items: any[] =
        (await Zotero.Items.getAll(userLibraryID, false, true)) || [];
      const unindexed: any[] = [];
      for (const item of items) {
        if (
          item &&
          item.key &&
          !item.deleted &&
          typeof item.isRegularItem === 'function' &&
          item.isRegularItem() &&
          !indexedKeys.has(item.key)
        ) {
          unindexed.push(item);
          if (unindexed.length >= 2) break;
        }
      }
      assertTrue(unindexed.length >= 2, 'need 2 unindexed items for this scenario');
      const [a, b] = unindexed;
      await vectorStoreSQLite.deleteItem('user', a.key);
      await vectorStoreSQLite.deleteItem('user', b.key);
      try {
        const batch: PaperEmbedding[] = [];
        for (const item of [a, b]) {
          for (let ci = 0; ci < 3; ci++) {
            batch.push(makeEmbedding(item.key, { chunkIndex: ci, chunkText: `${item.key}-${ci}` }));
          }
        }
        await vectorStoreSQLite.putBatch(batch);

        const itemRows = Number(
          await Zotero.DB.valueQueryAsync(
            `SELECT COUNT(*) FROM ${DB}.items WHERE library_key = 'user' AND item_key IN (?, ?)`,
            [a.key, b.key]
          )
        );
        assertEq(itemRows, 2, 'two distinct item rows expected');

        const pkA = await lookupItemPk(a.key);
        const pkB = await lookupItemPk(b.key);
        assertTrue(pkA !== null && pkB !== null, 'both item_pks must exist');
        assertEq(await chunkCountForPk(pkA!), 3, '3 chunks for item A');
        assertEq(await chunkCountForPk(pkB!), 3, '3 chunks for item B');
      } finally {
        await vectorStoreSQLite.deleteItem('user', a.key);
        await vectorStoreSQLite.deleteItem('user', b.key);
      }
    }),
  ];
});
