import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import {
  MODELS, DEFAULT_MODEL_ID, getModel, getActiveModel,
  isAllowedHfPath, applyPrefix, legacyModelIdToShortId,
} from '../../core/model-registry';

declare const Zotero: any;

selfTest.register('task-37a-model-registry', async () => {
  return [
    await scenario('registry has the four curated models', async () => {
      assertEq(MODELS.length, 4);
      assertTrue(getModel(DEFAULT_MODEL_ID), 'default model missing from registry');
    }),
    await scenario('only nomic is bundled', async () => {
      const bundled = MODELS.filter(m => m.bundled).map(m => m.id);
      assertEq(bundled.join(','), 'nomic-embed-text-v1.5');
    }),
    await scenario('dimensions are correct per model', async () => {
      assertEq(getModel('nomic-embed-text-v1.5')!.dimensions, 768);
      assertEq(getModel('paraphrase-multilingual-MiniLM-L12-v2')!.dimensions, 384);
      assertEq(getModel('multilingual-e5-base')!.dimensions, 768);
      assertEq(getModel('bge-m3')!.dimensions, 1024);
    }),
    await scenario('bge-m3 uses cls pooling, others mean', async () => {
      assertEq(getModel('bge-m3')!.pooling, 'cls');
      assertEq(getModel('nomic-embed-text-v1.5')!.pooling, 'mean');
    }),
    await scenario('applyPrefix uses per-model prefixes', async () => {
      assertEq(applyPrefix('cats', 'query', getModel('nomic-embed-text-v1.5')!), 'search_query: cats');
      assertEq(applyPrefix('cats', 'doc', getModel('multilingual-e5-base')!), 'passage: cats');
      assertEq(applyPrefix('cats', 'query', getModel('bge-m3')!), 'cats');
    }),
    await scenario('allowlist accepts registry hfPaths and rejects others', async () => {
      assertTrue(isAllowedHfPath('Xenova/bge-m3'), 'should allow registry hfPath');
      assertTrue(!isAllowedHfPath('evil/exfiltrator'), 'should reject non-registry hfPath');
    }),
    await scenario('legacy hfPath model_id maps to short id', async () => {
      assertEq(legacyModelIdToShortId('Xenova/nomic-embed-text-v1.5'), 'nomic-embed-text-v1.5');
      assertEq(legacyModelIdToShortId('bge-m3'), 'bge-m3');
    }),
    await scenario('active model resolves to default when pref unset/unknown', async () => {
      Zotero.Prefs.set('zotseek.embeddingModel', 'does-not-exist', true);
      assertEq(getActiveModel().id, DEFAULT_MODEL_ID);
      Zotero.Prefs.set('zotseek.embeddingModel', DEFAULT_MODEL_ID, true);
    }),
  ];
});
