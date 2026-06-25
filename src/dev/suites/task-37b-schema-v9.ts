import { selfTest, scenario, assertEq, assertContains } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;
const DB = 'zotseek';

async function columns(table: string): Promise<string[]> {
  const rows: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB}.table_info(${table})`);
  return (rows || []).map((r: any) => r.name);
}

selfTest.register('task-37b-schema-v9', async () => {
  // Force init/migration to have run.
  await vectorStoreSQLite.getStats();
  return [
    await scenario('chunks table has model_id column', async () => {
      assertContains(await columns('chunks'), 'model_id', 'chunks.model_id missing');
    }),
    await scenario('item_models table exists with expected columns', async () => {
      const cols = await columns('item_models');
      assertContains(cols, 'item_pk');
      assertContains(cols, 'model_id');
      assertContains(cols, 'pages_indexed');
    }),
    await scenario('schema_version is 9', async () => {
      const v = await Zotero.DB.valueQueryAsync(
        `SELECT value FROM ${DB}.metadata WHERE key = 'schema_version'`);
      assertEq(String(v), '9');
    }),
  ];
});
