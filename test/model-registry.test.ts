import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Installs the Zotero stub as a side effect; must stay above the import below.
import { installZoteroStub, removeZoteroStub } from './helpers/zotero-stub';
import {
  MODELS,
  DEFAULT_MODEL_ID,
  getAllModels,
  getModel,
  isAllowedHfPath,
  legacyModelIdToShortId,
  getActiveModelId,
  getActiveModel,
  setActiveModelId,
  applyPrefix,
  modelBasePath,
  sanitizeServerModelId,
  inferServerPrefixes,
  getServerModelEntries,
  addServerModel,
  removeServerModel,
} from '../src/core/model-registry';

let zotero = installZoteroStub();
// Re-install per test so pref state cannot leak between them.
beforeEach(() => { zotero = installZoteroStub(); });
afterEach(() => { removeZoteroStub(); });

describe('the curated model set', () => {
  test('model ids are unique', () => {
    const ids = MODELS.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length);
  });

  test('every model declares a positive dimension count', () => {
    // Embeddings are stored as raw Float32 bytes, so a wrong or missing
    // dimension corrupts every vector written under that model.
    for (const m of MODELS) {
      assert.ok(m.dimensions > 0, `${m.id} has no dimensions`);
    }
  });

  test('the default model id actually exists in the set', () => {
    assert.ok(getModel(DEFAULT_MODEL_ID), `${DEFAULT_MODEL_ID} is not a known model`);
  });

  test('no bundled model id collides with the server namespace', () => {
    // model_id partitions the chunks table; a collision would mix vector spaces.
    for (const m of MODELS) {
      assert.ok(!m.id.startsWith('server:'), `${m.id} shadows the server namespace`);
    }
  });

  test('getAllModels exposes the set without allowing callers to mutate it', () => {
    const before = getAllModels().length;
    getAllModels().push({} as any);
    assert.equal(getAllModels().length, before, 'the registry was mutated through the returned array');
  });
});

describe('model lookup', () => {
  test('an unknown id resolves to nothing rather than a wrong model', () => {
    assert.equal(getModel('no-such-model'), undefined);
  });

  test('only HuggingFace paths from the curated set are allowed', () => {
    assert.equal(isAllowedHfPath(MODELS[0].hfPath), true);
    assert.equal(isAllowedHfPath('attacker/evil-model'), false);
  });

  test('a legacy stored HuggingFace path maps to its short id', () => {
    const m = MODELS.find((x) => x.hfPath);
    assert.equal(legacyModelIdToShortId(m!.hfPath), m!.id);
  });

  test('an already-short or unknown id passes through untouched', () => {
    assert.equal(legacyModelIdToShortId(DEFAULT_MODEL_ID), DEFAULT_MODEL_ID);
    assert.equal(legacyModelIdToShortId('something-else'), 'something-else');
  });
});

describe('the active model pref', () => {
  test('defaults when the pref is unset', () => {
    assert.equal(getActiveModelId(), DEFAULT_MODEL_ID);
  });

  test('defaults when the pref names a model that no longer exists', () => {
    // Otherwise a removed model would make search query an empty partition.
    zotero.prefs.set('zotseek.embeddingModel', 'retired-model');
    assert.equal(getActiveModelId(), DEFAULT_MODEL_ID);
  });

  test('round-trips a valid id through the pref', () => {
    const other = MODELS.find((m) => m.id !== DEFAULT_MODEL_ID)!;
    setActiveModelId(other.id);
    assert.equal(zotero.prefs.get('zotseek.embeddingModel'), other.id);
    assert.equal(getActiveModelId(), other.id);
    assert.equal(getActiveModel().id, other.id);
  });

  test('getActiveModel always returns a usable model', () => {
    zotero.prefs.set('zotseek.embeddingModel', 12345 as any);
    assert.ok(getActiveModel().dimensions > 0);
  });
});

describe('task prefixes and paths', () => {
  test('applies the query and document prefixes a model declares', () => {
    const m = { queryPrefix: 'search_query: ', docPrefix: 'search_document: ' } as any;
    assert.equal(applyPrefix('cats', 'query', m), 'search_query: cats');
    assert.equal(applyPrefix('cats', 'doc', m), 'search_document: cats');
  });

  test('leaves text untouched for models without prefixes', () => {
    const m = { queryPrefix: '', docPrefix: '' } as any;
    assert.equal(applyPrefix('cats', 'query', m), 'cats');
  });

  test('bundled and downloaded models resolve to different roots', () => {
    assert.notEqual(modelBasePath({ bundled: true } as any), modelBasePath({ bundled: false } as any));
  });
});

describe('server-backed models', () => {
  test('ids are namespaced and slugified', () => {
    assert.equal(sanitizeServerModelId('Nomic Embed v1.5'), 'server:nomic-embed-v1.5');
  });

  test('a name with no usable characters still yields a valid id', () => {
    assert.equal(sanitizeServerModelId('///'), 'server:model');
  });

  test('prefixes are inferred per model family', () => {
    assert.equal(inferServerPrefixes('nomic-embed-text').queryPrefix, 'search_query: ');
    assert.equal(inferServerPrefixes('multilingual-e5-large').queryPrefix, 'query: ');
    assert.deepEqual(inferServerPrefixes('some-other-model'), { queryPrefix: '', docPrefix: '' });
  });

  // Must satisfy isValidServerEntry in full: queryPrefix and docPrefix are
  // required strings, not optional, even when empty.
  const entry = {
    id: 'server:test', label: 'Test', baseUrl: 'http://127.0.0.1:1234',
    serverModelName: 'test', dimensions: 768, queryPrefix: '', docPrefix: '',
  };

  test('entries round-trip through the pref', () => {
    addServerModel(entry as any);
    assert.deepEqual(getServerModelEntries().map((e) => e.id), ['server:test']);
    removeServerModel('server:test');
    assert.deepEqual(getServerModelEntries(), []);
  });

  test('adding the same id twice replaces rather than duplicates', () => {
    addServerModel(entry as any);
    addServerModel({ ...entry, label: 'Renamed' } as any);
    const all = getServerModelEntries();
    assert.equal(all.length, 1);
    assert.equal(all[0].label, 'Renamed');
  });

  test('a malformed pref is ignored instead of throwing', () => {
    // A corrupt pref must not take the model picker down with it.
    zotero.prefs.set('zotseek.serverModels', 'not json at all');
    assert.deepEqual(getServerModelEntries(), []);
    zotero.prefs.set('zotseek.serverModels', '{"not":"an array"}');
    assert.deepEqual(getServerModelEntries(), []);
  });

  test('entries missing required fields are filtered out', () => {
    zotero.prefs.set('zotseek.serverModels', JSON.stringify([
      entry,                                   // valid
      { ...entry, id: 'no-namespace' },        // id not server:-prefixed
      { ...entry, id: 'server:b', dimensions: 0 }, // non-positive dimensions
      { ...entry, id: 'server:c', baseUrl: 42 },   // wrong type
      { ...entry, id: 'server:d', queryPrefix: undefined }, // required prefix missing
    ]));
    assert.deepEqual(getServerModelEntries().map((e) => e.id), ['server:test']);
  });
});
