/**
 * How the keyword half of hybrid search asks Zotero for a collection.
 *
 * Issue #51: `collectionID is X` restricts the result set to items that are in
 * the collection, and a child attachment or child note is not in a collection,
 * only its parent is. So every match originating in a PDF's body or in a note
 * was dropped by Zotero before v1.22.0's crediting step could attribute it to
 * the paper it belongs to. Measured on a real library: a string present only
 * in one paper's attachment and notes gave 17 matches library-wide and 0 in
 * each of the four collections holding that paper.
 *
 * Two conditions fix it, and both were measured against a running Zotero
 * before being written here:
 *
 * - `includeParentsAndChildren` expands the set to the children of the
 *   collection's items, which puts those matches back in front of our own
 *   resolution step (51 -> 342 raw hits on one collection). It does not leak
 *   an item from outside the collection: across 435 expanded hits in three
 *   collections, every single one resolved to an item that is in the
 *   collection, so no membership filter is needed.
 *
 * - `recursive` covers subcollections. Indexing a collection has included
 *   them since v1.20.0, so without this you can index a collection and then
 *   fail to search what you just indexed. On a collection holding 1 item
 *   directly and 5 subcollections, this is the difference between 2 hits and
 *   726.
 *
 * What is asserted here is the query ZotSeek builds, because the matching
 * itself is Zotero's and cannot run in this runner. The behaviour it produces
 * was verified in Zotero.
 */

import './helpers/zotero-stub';
import { installZoteroStub, ZoteroStub } from './helpers/zotero-stub';
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { HybridSearchEngine } from '../src/core/hybrid-search';

type Condition = [string, string, string?];

let searches: Array<{ libraryID?: number; conditions: Condition[] }>;

/** Stand in for Zotero.Search, recording the query instead of running it. */
function installSearchRecorder(stub: ZoteroStub): void {
  searches = [];
  const built = searches;

  stub.Libraries = { userLibraryID: 1 };
  stub.Items = { getAsync: async () => [] };
  stub.Search = class {
    libraryID: number | undefined;
    conditions: Condition[] = [];
    constructor() {
      built.push(this as any);
    }
    addCondition(name: string, operator: string, value?: string) {
      this.conditions.push([name, operator, value]);
    }
    async search(): Promise<number[]> {
      return [];
    }
  };
}

/** Run the keyword leg alone, which is the only leg that touches Zotero.Search. */
async function keywordQuery(options: Record<string, unknown>): Promise<void> {
  const engine = new HybridSearchEngine({} as any);
  await (engine as any).keywordSearchQuery('RCIS 2025', options);
}

function conditionNames(): string[] {
  assert.equal(searches.length, 1, 'expected exactly one Zotero.Search');
  return searches[0].conditions.map((c) => c[0]);
}

beforeEach(() => {
  installSearchRecorder(installZoteroStub());
});

test('a collection-scoped keyword search reaches the children of the collection items', async () => {
  await keywordQuery({ collectionId: 42, libraryId: 1 });

  assert.ok(
    conditionNames().includes('includeParentsAndChildren'),
    'without it, a match inside a PDF or a note is dropped before it can be credited to its parent',
  );
});

test('a collection-scoped keyword search covers subcollections', async () => {
  await keywordQuery({ collectionId: 42, libraryId: 1 });

  assert.ok(
    conditionNames().includes('recursive'),
    'indexing a collection includes subcollections, so searching one must too',
  );
});

test('a library-wide keyword search adds no collection conditions', async () => {
  await keywordQuery({ libraryId: 1 });

  const names = conditionNames();
  assert.deepEqual(names.filter((n) => n !== 'quicksearch-everything'), []);
});
