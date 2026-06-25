import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

selfTest.register('task-37d-partitioned-search', async () => {
  // Seed two synthetic items, each indexed under a different model id.
  const mk = (key: string, modelId: string, dims: number) => ({
    libraryKey: 'user', itemKey: key, title: 'P', abstract: undefined,
    modelId, indexedAt: new Date().toISOString(), contentHash: 'h',
    chunkIndex: 0, textSource: 'abstract' as const, embedding: new Array(dims).fill(0.2),
  });
  await vectorStoreSQLite.deleteItem('user', 'ZZPART_A').catch(() => {});
  await vectorStoreSQLite.deleteItem('user', 'ZZPART_B').catch(() => {});
  await vectorStoreSQLite.put(mk('ZZPART_A', 'nomic-embed-text-v1.5', 768));
  await vectorStoreSQLite.put(mk('ZZPART_B', 'bge-m3', 1024));
  return [
    await scenario('getAllCached exposes modelId for filtering', async () => {
      const all = await (vectorStoreSQLite as any).getAllCached();
      const seen = new Set(all.map((e: any) => e.modelId));
      assertTrue(seen.has('nomic-embed-text-v1.5') && seen.has('bge-m3'),
        'both model ids should be present pre-filter');
    }),
    await scenario('filtering by active model excludes the other model', async () => {
      const all = await (vectorStoreSQLite as any).getAllCached();
      const active = 'nomic-embed-text-v1.5';
      const filtered = all.filter((e: any) => e.modelId === active);
      assertTrue(filtered.every((e: any) => e.modelId === active), 'only active model remains');
      assertTrue(!filtered.some((e: any) => e.itemKey === 'ZZPART_B'), 'bge-m3 item excluded');
    }),
    await scenario('cleanup', async () => {
      await vectorStoreSQLite.deleteItem('user', 'ZZPART_A');
      await vectorStoreSQLite.deleteItem('user', 'ZZPART_B');
      assertTrue(true);
    }),
  ];
});
