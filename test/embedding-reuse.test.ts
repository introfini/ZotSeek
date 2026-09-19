import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { splitReusable, ReuseCandidate, StoredEmbeddings } from '../src/core/embedding-reuse';

const MODEL = 'nomic-embed-text-v1.5';
const OTHER_MODEL = 'other-model-v1.0';

function candidate(itemId: number, index: number, text: string): ReuseCandidate {
  return { id: `${itemId}_${index}`, itemId, text };
}

function stored(modelId: string, byItem: Map<number, Map<string, number[]>>): StoredEmbeddings {
  return { modelId, byItem };
}

describe('splitReusable', () => {
  test('embeds everything when nothing is stored', () => {
    const chunks = [candidate(1, 0, 'alpha'), candidate(1, 1, 'beta')];
    const result = splitReusable(chunks, stored(MODEL, new Map()), MODEL);
    assert.equal(result.toEmbed.length, 2);
    assert.equal(result.reused.size, 0);
  });

  test('reuses every chunk when all texts are unchanged', () => {
    const byItem = new Map([[1, new Map([['alpha', [0.1, 0.2]], ['beta', [0.3, 0.4]]])]]);
    const result = splitReusable([candidate(1, 0, 'alpha'), candidate(1, 1, 'beta')], stored(MODEL, byItem), MODEL);
    assert.equal(result.toEmbed.length, 0);
    assert.deepEqual(result.reused.get('1_0'), { embedding: [0.1, 0.2], modelId: MODEL });
    assert.deepEqual(result.reused.get('1_1'), { embedding: [0.3, 0.4], modelId: MODEL });
  });

  test('splits a partial overlap, which is the note-edit case', () => {
    const byItem = new Map([[1, new Map([['unchanged', [0.5]]])]]);
    const result = splitReusable([candidate(1, 0, 'unchanged'), candidate(1, 1, 'edited')], stored(MODEL, byItem), MODEL);
    assert.deepEqual(result.toEmbed, [candidate(1, 1, 'edited')]);
    assert.equal(result.reused.size, 1);
    assert.deepEqual(result.reused.get('1_0'), { embedding: [0.5], modelId: MODEL });
  });

  test('reuses the same vector for text repeated within one item', () => {
    const byItem = new Map([[1, new Map([['same', [0.7]]])]]);
    const result = splitReusable([candidate(1, 0, 'same'), candidate(1, 1, 'same')], stored(MODEL, byItem), MODEL);
    assert.equal(result.toEmbed.length, 0);
    assert.deepEqual(result.reused.get('1_0'), { embedding: [0.7], modelId: MODEL });
    assert.deepEqual(result.reused.get('1_1'), { embedding: [0.7], modelId: MODEL });
  });

  test('never hands one item stored vector to another item', () => {
    const byItem = new Map([[2, new Map([['shared', [0.9]]])]]);
    const result = splitReusable([candidate(1, 0, 'shared')], stored(MODEL, byItem), MODEL);
    assert.deepEqual(result.toEmbed, [candidate(1, 0, 'shared')]);
    assert.equal(result.reused.size, 0);
  });

  test('reuses a chunk that moved to a different position', () => {
    const byItem = new Map([[1, new Map([['moved', [0.2]]])]]);
    const result = splitReusable([candidate(1, 3, 'moved')], stored(MODEL, byItem), MODEL);
    assert.equal(result.toEmbed.length, 0);
    assert.deepEqual(result.reused.get('1_3'), { embedding: [0.2], modelId: MODEL });
  });

  test('keeps the caller id verbatim rather than rebuilding it', () => {
    const byItem = new Map([[1, new Map([['x', [0.1]]])]]);
    const result = splitReusable([{ id: 'custom-key', itemId: 1, text: 'x' }], stored(MODEL, byItem), MODEL);
    assert.deepEqual(result.reused.get('custom-key'), { embedding: [0.1], modelId: MODEL });
  });

  test('produces a clean miss when the stored model differs', () => {
    const chunks = [candidate(1, 0, 'text'), candidate(1, 1, 'other')];
    const byItem = new Map([[1, new Map([['text', [0.5, 0.6]], ['other', [0.7, 0.8]]])]]);
    const result = splitReusable(chunks, stored(OTHER_MODEL, byItem), MODEL);
    assert.deepEqual(result.toEmbed, chunks);
    assert.equal(result.reused.size, 0);
  });
});
