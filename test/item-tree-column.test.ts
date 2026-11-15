/**
 * Unregistering the index status column.
 *
 * Zotero namespaces a plugin column's dataKey with the plugin ID before
 * storing it, and registerColumns() returns that namespaced key: verified on
 * Zotero 10.0.9, where the column is stored as
 * `zotseek\@zotero\.org-zotseek-index-status` and the plain
 * `zotseek-index-status` is unknown. Unregistering with the plain key logged
 * "Can't remove unknown option" every time the plugin was disabled, removed
 * or updated, and the column only went away because Zotero's own shutdown
 * observer removes a plugin's columns after its shutdown hook has run.
 */

import './helpers/zotero-stub';
import { installZoteroStub } from './helpers/zotero-stub';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ItemTreeIndexColumn } from '../src/ui/item-tree-column';

// What Zotero returns: CSS.escape(`${pluginID}-${dataKey}`)
const NAMESPACED_KEY = 'zotseek\\@zotero\\.org-zotseek-index-status';

test('unregisters the column under the key Zotero returned when registering it', async () => {
  // firstShown skips the first-run reveal, which needs a real item tree
  const stub = installZoteroStub({ 'zotseek.indexStatusColumn.firstShown': true });
  const unregistered: unknown[] = [];
  stub.ItemTreeManager = {
    registerColumns: async () => [NAMESPACED_KEY],
    unregisterColumns: async (keys: unknown) => { unregistered.push(keys); },
  };

  const column = new ItemTreeIndexColumn();
  await column.register({} as any);
  await column.unregister();

  assert.deepEqual(unregistered, [NAMESPACED_KEY]);
});
