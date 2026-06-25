import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const LK = 'user';
const IK = 'ZZTESTKEY';          // synthetic test item key (won't resolve to a real item)
function fakeEmbedding(modelId: string, dims: number) {
  return {
    libraryKey: LK, itemKey: IK, title: 'Test', abstract: undefined,
    modelId, indexedAt: new Date().toISOString(), contentHash: 'h',
    chunkIndex: 0, textSource: 'abstract' as const,
    embedding: new Array(dims).fill(0.1),
  };
}

selfTest.register('task-37c-model-aware-store', async () => {
  await vectorStoreSQLite.deleteItem(LK, IK).catch(() => {});
  await vectorStoreSQLite.put(fakeEmbedding('nomic-embed-text-v1.5', 768));
  await vectorStoreSQLite.put(fakeEmbedding('bge-m3', 1024));
  return [
    await scenario('same item holds chunks for two models', async () => {
      const n = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(DISTINCT c.model_id) FROM zotseek.chunks c
         JOIN zotseek.items i ON c.item_pk = i.item_pk
         WHERE i.library_key = ? AND i.item_key = ?`, [LK, IK]);
      assertEq(Number(n), 2);
    }),
    await scenario('item_models has one row per model', async () => {
      const n = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM zotseek.item_models im
         JOIN zotseek.items i ON im.item_pk = i.item_pk
         WHERE i.library_key = ? AND i.item_key = ?`, [LK, IK]);
      assertEq(Number(n), 2);
    }),
    await scenario('getAllCached surfaces modelId for the chunk', async () => {
      const all = await (vectorStoreSQLite as any).getAllCached();
      const mine = all.filter((e: any) => e.itemKey === IK);
      assertTrue(mine.length >= 2, 'both model chunks present in cache');
      const models = new Set(mine.map((e: any) => e.modelId));
      assertTrue(models.has('nomic-embed-text-v1.5') && models.has('bge-m3'),
        'getAllCached exposes per-chunk modelId');
    }),
    await scenario('coverage counts items per model', async () => {
      const cov = await vectorStoreSQLite.getCoverage('bge-m3');
      assertTrue(cov.covered >= 1, 'bge-m3 coverage should include the test item');
      assertTrue(cov.total >= cov.covered, 'total >= covered');
    }),
    await scenario('deleteChunksForItem scopes to one model', async () => {
      await vectorStoreSQLite.deleteChunksForItem(LK, IK, 'bge-m3');
      const left = await Zotero.DB.columnQueryAsync(
        `SELECT DISTINCT c.model_id FROM zotseek.chunks c
         JOIN zotseek.items i ON c.item_pk = i.item_pk
         WHERE i.library_key = ? AND i.item_key = ?`, [LK, IK]);
      assertEq(left.join(','), 'nomic-embed-text-v1.5');
    }),
    await scenario('deleteModelEmbeddings removes only that model', async () => {
      // re-add bge-m3 so we can delete it library-wide
      await vectorStoreSQLite.put(fakeEmbedding('bge-m3', 1024));
      await vectorStoreSQLite.deleteModelEmbeddings('bge-m3');
      const left = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(DISTINCT c.model_id) FROM zotseek.chunks c
         JOIN zotseek.items i ON c.item_pk = i.item_pk
         WHERE i.library_key = ? AND i.item_key = ?`, [LK, IK]);
      assertEq(Number(left), 1);
    }),
    await scenario('getStats reports the active short model id', async () => {
      const stats = await vectorStoreSQLite.getStats();
      assertEq(stats.modelId, 'nomic-embed-text-v1.5');
    }),
    await scenario('cleanup', async () => {
      await vectorStoreSQLite.deleteItem(LK, IK);
      assertTrue(true);
    }),
  ];
});
