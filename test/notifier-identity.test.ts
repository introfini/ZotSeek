/**
 * Cleaning up the index when an item is erased for good.
 *
 * The 'delete' notifier fires after the item is gone, so `Zotero.Items.get()`
 * returns nothing and the stable (library_key, item_key) identity cannot be
 * read off the item any more. The cleanup then fell back to a lookup by local
 * id, which the index has not stored since schema v8, so an item erased
 * without passing through the trash left its rows behind. Zotero hands the
 * identity over in the notifier's extraData instead, as `{libraryID, key}`
 * per id (verified on 10.0.3: `{"12840":{"libraryID":1,"key":"XHFLX6W8"}}`).
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { identityFromNotifierData } from '../src/core/notifier-identity';

const libraryKeyOf = (libraryID: number) => (libraryID === 1 ? 'user' : libraryID === 5 ? 'group:42' : null);

test('reads the identity of an erased item from the notifier extraData', () => {
  assert.deepEqual(
    identityFromNotifierData({ libraryID: 1, key: 'XHFLX6W8' }, libraryKeyOf),
    { libraryKey: 'user', itemKey: 'XHFLX6W8' },
  );
  assert.deepEqual(
    identityFromNotifierData({ libraryID: 5, key: 'ABCD1234' }, libraryKeyOf),
    { libraryKey: 'group:42', itemKey: 'ABCD1234' },
  );
});

test('returns null when the extraData has no usable identity', () => {
  assert.equal(identityFromNotifierData(undefined, libraryKeyOf), null);
  assert.equal(identityFromNotifierData({}, libraryKeyOf), null);
  assert.equal(identityFromNotifierData({ libraryID: 1 }, libraryKeyOf), null);
  assert.equal(identityFromNotifierData({ key: 'XHFLX6W8' }, libraryKeyOf), null);
  assert.equal(identityFromNotifierData({ libraryID: 1, key: '' }, libraryKeyOf), null);
});

test('returns null for a library the index does not cover', () => {
  // Feed libraries resolve to no library_key; nothing of theirs is indexed.
  assert.equal(identityFromNotifierData({ libraryID: 9, key: 'XHFLX6W8' }, libraryKeyOf), null);
});
