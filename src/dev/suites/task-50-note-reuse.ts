/**
 * Self-test suite for issue #50: the store read that backs embedding reuse.
 * Read-only against the production DB state.
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';
import { getActiveModelId } from '../../core/model-registry';

declare const Zotero: any;

const DB = 'zotseek';

selfTest.register('task-50-note-reuse', async () => {
  const modelId = getActiveModelId();
  const row = await Zotero.DB.valueQueryAsync(
    `SELECT i.library_key || '|' || i.item_key
       FROM ${DB}.items i JOIN ${DB}.chunks c ON c.item_pk = i.item_pk
      WHERE c.model_id = ? LIMIT 1`,
    [modelId]
  );
  const [libraryKey, itemKey] = row ? String(row).split('|') : ['', ''];

  return [
    await scenario('returns an empty map for an unknown item', async () => {
      const map = await vectorStoreSQLite.getChunkTextEmbeddings('user', 'ZZZZZZZZ', modelId);
      assertEq(map.size, 0, 'unknown item should yield no rows');
    }),
    await scenario('returns one entry per distinct chunk text', async () => {
      if (!row) return;
      const map = await vectorStoreSQLite.getChunkTextEmbeddings(libraryKey, itemKey, modelId);
      const distinct = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(DISTINCT c.chunk_text)
           FROM ${DB}.chunks c JOIN ${DB}.items i ON i.item_pk = c.item_pk
          WHERE i.library_key = ? AND i.item_key = ? AND c.model_id = ?`,
        [libraryKey, itemKey, modelId]
      );
      assertEq(map.size, Number(distinct), 'map size should match distinct chunk texts');
    }),
    await scenario('decodes embeddings to non-empty float arrays', async () => {
      if (!row) return;
      const map = await vectorStoreSQLite.getChunkTextEmbeddings(libraryKey, itemKey, modelId);
      const first = map.values().next().value;
      assertTrue(Array.isArray(first) && first.length > 0, 'embedding should decode to a vector');
    }),
    await scenario('returns nothing for a model with no chunks', async () => {
      if (!row) return;
      const map = await vectorStoreSQLite.getChunkTextEmbeddings(libraryKey, itemKey, 'no-such-model');
      assertEq(map.size, 0, 'unknown model should yield no rows');
    }),
  ];
});
