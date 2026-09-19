/**
 * Self-test suite for issue #50: schema v10 (chunks.note_key) and the note
 * identity it carries. Read-only against the production DB state, except for
 * the round-trip scenario, which writes and deletes its own throwaway item.
 */

import { selfTest, scenario, assertEq, assertTrue, assertContains } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';
import { getActiveModelId } from '../../core/model-registry';

declare const Zotero: any;

const DB = 'zotseek';
const PROBE_KEY = 'ZSV10PRB';

async function chunkColumns(): Promise<string[]> {
  const rows: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB}.table_info(chunks)`);
  return (rows || []).map((r: any) => r.name);
}

selfTest.register('task-50-note-identity', async () => {
  // Force init/migration to have run.
  await vectorStoreSQLite.getStats();
  const modelId = getActiveModelId();

  return [
    await scenario('chunks table has the note_key column', async () => {
      assertContains(await chunkColumns(), 'note_key', 'chunks.note_key missing');
    }),
    await scenario('note_key is nullable, so pre-v10 rows survive', async () => {
      const rows: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB}.table_info(chunks)`);
      const col = (rows || []).find((r: any) => r.name === 'note_key');
      assertTrue(!!col, 'note_key column missing');
      assertEq(Number(col.notnull), 0, 'note_key must be nullable');
      assertEq(String(col.type).toUpperCase(), 'TEXT');
    }),
    await scenario('schema_version is 10', async () => {
      const v = await Zotero.DB.valueQueryAsync(
        `SELECT value FROM ${DB}.metadata WHERE key = 'schema_version'`);
      assertEq(String(v), '10');
    }),
    await scenario('migration is idempotent: a second init adds no second column', async () => {
      await (vectorStoreSQLite as any).migrateToV10?.();
      const cols = await chunkColumns();
      assertEq(cols.filter((c) => c === 'note_key').length, 1, 'note_key duplicated');
    }),
    await scenario('note_key survives a write/read round trip', async () => {
      // Throwaway identity; removed at the end of the scenario.
      await vectorStoreSQLite.put({
        libraryKey: 'user',
        itemKey: PROBE_KEY,
        chunkIndex: 0,
        title: 'ZotSeek v10 probe',
        chunkText: 'Probe chunk standing in for a note.',
        textSource: 'note',
        embedding: new Array(768).fill(0.01),
        modelId,
        indexedAt: new Date().toISOString(),
        contentHash: 'v10probe',
        noteKey: 'NOTEPRB1',
      });
      try {
        const stored = await Zotero.DB.valueQueryAsync(
          `SELECT c.note_key FROM ${DB}.chunks c JOIN ${DB}.items i ON i.item_pk = c.item_pk
            WHERE i.library_key = 'user' AND i.item_key = ? AND c.model_id = ?`,
          [PROBE_KEY, modelId]
        );
        assertEq(String(stored), 'NOTEPRB1', 'note_key not persisted');
      } finally {
        await vectorStoreSQLite.deleteItem('user', PROBE_KEY);
      }
    }),
    await scenario('every stored note_key belongs to a note chunk', async () => {
      const mismatched = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB}.chunks WHERE note_key IS NOT NULL AND text_source != 'note'`);
      assertEq(Number(mismatched), 0, 'non-note chunks must not carry a note_key');
    }),
    await scenario('a note chunk never shares its index with another chunk', async () => {
      // Per-note chunking re-bases indices across the combined set; a collision
      // would silently overwrite a chunk, since the PK is
      // (item_pk, chunk_index, model_id).
      const dupes = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM (
           SELECT item_pk, chunk_index, model_id, COUNT(*) AS n
             FROM ${DB}.chunks GROUP BY item_pk, chunk_index, model_id HAVING n > 1
         )`);
      assertEq(Number(dupes), 0, 'duplicate (item_pk, chunk_index, model_id)');
    }),
  ];
});
