import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { getSelectedCollectionTreeRows, shouldShowCollectionMenu } from '../src/ui/collection-menu';

const collection = { isCollection: () => true };
const library = { isCollection: () => false };
const feed = { isCollection: () => false };

describe('collection context menu visibility (issue #61)', () => {
  test('shows for a single collection', () => {
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [collection] }), true);
  });

  test('shows for several collections (Zotero 10 multi-select)', () => {
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [collection, collection] }), true);
  });

  test('hides for a library, a feed or any non-collection row', () => {
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [library] }), false);
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [feed] }), false);
  });

  test('hides for a mixed selection', () => {
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [collection, library] }), false);
  });

  test('hides with no selection or no pane', () => {
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => [] }), false);
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRows: () => null }), false);
    assert.equal(shouldShowCollectionMenu(null), false);
    assert.equal(shouldShowCollectionMenu({}), false);
  });

  test('prefers the plural getter, because the singular one throws on Zotero 10', () => {
    const pane = {
      getCollectionTreeRows: () => [collection],
      getCollectionTreeRow: () => { throw new Error('getCollectionTreeRow() is no longer supported'); },
    };
    assert.deepEqual(getSelectedCollectionTreeRows(pane), [collection]);
  });

  test('falls back to the singular getter on Zotero 8/9', () => {
    assert.deepEqual(getSelectedCollectionTreeRows({ getCollectionTreeRow: () => collection }), [collection]);
    assert.deepEqual(getSelectedCollectionTreeRows({ getCollectionTreeRow: () => null }), []);
    assert.equal(shouldShowCollectionMenu({ getCollectionTreeRow: () => library }), false);
  });
});
