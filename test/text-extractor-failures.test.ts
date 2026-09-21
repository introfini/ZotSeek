/**
 * What happens to the rest of a batch when one item cannot be extracted.
 *
 * Issue #54: a user with ~5000 items got "Indexing failed: console is not
 * defined" and an aborted run, because the catch meant to contain a single
 * item's failure called console (absent in the plugin scope) and the
 * ReferenceError escaped it. The console rule itself is pinned statically in
 * no-console-in-plugin-scope.test.ts, since Node has a console and cannot
 * reproduce that. What is pinned here is the policy that makes the class of
 * bug survivable at all, and which the embedding stage already had since
 * v1.10.0: one item that fails costs that item, not the run.
 *
 * The same issue asked for the failure to say which item it was. "item 260"
 * is a local database id, which means nothing to a user looking at a library
 * and does not even survive being copied to another machine.
 */

import './helpers/zotero-stub';
import { installZoteroStub } from './helpers/zotero-stub';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { TextExtractor, describeItem, ExtractionProgress } from '../src/core/text-extractor';

/** Long enough to survive the chunker's short-text filters. */
const ABSTRACT = 'A study of retrieval over academic libraries. '.repeat(8);

interface ItemOpts {
  title?: string;
  throwsOnField?: boolean;
  libraryID?: number;
}

/** Minimal stand-in for a Zotero item as abstract-mode extraction sees it. */
function item(id: number, opts: ItemOpts = {}): any {
  return {
    id,
    key: `KEY${id}`,
    libraryID: opts.libraryID ?? 1,
    getField(field: string) {
      if (opts.throwsOnField) throw new Error('too much recursion');
      if (field === 'title') return opts.title ?? `Paper ${id}`;
      if (field === 'abstractNote') return ABSTRACT;
      return '';
    },
    getNotes: () => [],
  };
}

beforeEach(() => {
  const stub = installZoteroStub({ 'zotseek.indexNotes': false });
  stub.Libraries = { get: (id: number) => (id === 1 ? { libraryType: 'user' } : null) };
});

test('describeItem names the item by title and stable identity, not just its local id', () => {
  const described = describeItem(item(260, { title: 'Attention Is All You Need' }));

  assert.match(described, /260/);
  assert.match(described, /Attention Is All You Need/);
  assert.match(described, /user\/KEY260/);
});

test('describeItem still identifies an item whose own fields throw', () => {
  // The item is the thing that is broken, so reading it may fail too. A
  // describe that throws would take down the error handler that called it.
  const described = describeItem(item(260, { throwsOnField: true }));

  assert.match(described, /260/);
  assert.doesNotMatch(described, /Paper 260/);
});

test('one item that cannot be extracted does not stop the rest of the batch', async () => {
  const extractor = new TextExtractor();

  const extracted = await extractor.extractChunksFromItems(
    [item(1), item(2, { throwsOnField: true }), item(3)],
    'abstract',
  );

  assert.deepEqual(extracted.map((e) => e.itemId), [1, 3]);
});

test('an extraction failure is reported through the progress callback', async () => {
  const extractor = new TextExtractor();
  const seen: ExtractionProgress[] = [];

  await extractor.extractChunksFromItems(
    [item(1), item(2, { title: 'Broken Paper', throwsOnField: true })],
    'abstract',
    undefined,
    (progress) => seen.push({ ...progress }),
  );

  const failures = seen.filter((p) => p.status === 'error');
  assert.equal(failures.length, 1);
  assert.match(failures[0].currentTitle, /2/);
});
