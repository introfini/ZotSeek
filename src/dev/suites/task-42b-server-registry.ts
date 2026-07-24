import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import {
  MODELS, DEFAULT_MODEL_ID, getAllModels, getModel, getActiveModel,
  sanitizeServerModelId, inferServerPrefixes,
  getServerModelEntries, addServerModel, removeServerModel,
} from '../../core/model-registry';

declare const Zotero: any;

const TEST_ENTRY = {
  id: 'server:test-nomic', label: 'test-nomic (server)',
  baseUrl: 'http://127.0.0.1:1234', serverModelName: 'test-nomic',
  dimensions: 768, queryPrefix: 'search_query: ', docPrefix: 'search_document: ',
};

selfTest.register('task-42b-server-registry', async () => {
  const prevPref = Zotero.Prefs.get('zotseek.serverModels', true);
  const prevActive = Zotero.Prefs.get('zotseek.embeddingModel', true);
  try {
    return [
      await scenario('sanitizeServerModelId produces namespaced slug', async () => {
        assertEq(sanitizeServerModelId('Nomic Embed Text v1.5 (GGUF)'), 'server:nomic-embed-text-v1.5-gguf');
        assertTrue(sanitizeServerModelId('///').startsWith('server:'), 'degenerate name still namespaced');
      }),
      await scenario('inferServerPrefixes matches known families', async () => {
        assertEq(inferServerPrefixes('text-embedding-nomic-embed-text-v1.5').queryPrefix, 'search_query: ');
        assertEq(inferServerPrefixes('multilingual-e5-large').docPrefix, 'passage: ');
        assertEq(inferServerPrefixes('bge-m3').queryPrefix, '');
      }),
      await scenario('add/get/remove roundtrip via pref', async () => {
        Zotero.Prefs.set('zotseek.serverModels', '[]', true);
        addServerModel(TEST_ENTRY);
        assertEq(getServerModelEntries().length, 1);
        const m = getModel('server:test-nomic');
        assertTrue(!!m, 'getModel finds server model');
        assertEq(m!.runtime, 'server');
        assertEq(m!.dimensions, 768);
        assertEq(getAllModels().length, MODELS.length + 1);
        removeServerModel('server:test-nomic');
        assertEq(getServerModelEntries().length, 0);
      }),
      await scenario('malformed pref is ignored, curated models unaffected', async () => {
        Zotero.Prefs.set('zotseek.serverModels', '{not json', true);
        assertEq(getServerModelEntries().length, 0);
        assertEq(getAllModels().length, MODELS.length);
      }),
      await scenario('active pref pointing at removed server model falls back to default', async () => {
        Zotero.Prefs.set('zotseek.serverModels', '[]', true);
        Zotero.Prefs.set('zotseek.embeddingModel', 'server:gone', true);
        assertEq(getActiveModel().id, DEFAULT_MODEL_ID);
      }),
      await scenario('curated models all carry runtime onnx', async () => {
        assertTrue(MODELS.every(m => m.runtime === 'onnx'), 'runtime field present on curated set');
      }),
    ];
  } finally {
    Zotero.Prefs.set('zotseek.serverModels', typeof prevPref === 'string' ? prevPref : '[]', true);
    Zotero.Prefs.set('zotseek.embeddingModel', prevActive ?? DEFAULT_MODEL_ID, true);
  }
});
