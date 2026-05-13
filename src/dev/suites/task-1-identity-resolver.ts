/**
 * Self-test suite for Task 1: identity-resolver module.
 *
 * Exercises libraryKeyFromLocalID, localLibraryIDFromKey, identityFromItem,
 * localItemIDFromIdentity, and findIdentityByItemKey against the live Zotero
 * state in the dev profile. The suite picks a real item from the user library
 * so the round-trip checks have something to resolve.
 *
 * Note: the `group:<groupID>` branch of libraryKeyFromLocalID/localLibraryIDFromKey
 * is untested here because the dev profile has no group library available.
 */

import { selfTest, scenario, assertEq, assertTrue } from '../self-test';
import {
  libraryKeyFromLocalID,
  localLibraryIDFromKey,
  identityFromItem,
  localItemIDFromIdentity,
  findIdentityByItemKey,
  bulkResolve,
} from '../../core/identity-resolver';

declare const Zotero: any;

/**
 * Pick a regular item from the user library to use as the round-trip subject.
 * Returns null if the library is empty (in which case dependent scenarios skip).
 */
async function pickUserLibraryItem(): Promise<any | null> {
  const userLibraryID = Zotero.Libraries.userLibraryID;
  // getAll(libraryID, asIDs=false, onlyTopLevel=true) is async in Z8/Z9.
  // Top-level so we avoid attachments/notes and keep the sample stable.
  const items: any[] = (await Zotero.Items.getAll(userLibraryID, false, true)) || [];
  for (const item of items) {
    if (item && item.key && !item.deleted && item.isRegularItem && item.isRegularItem()) {
      return item;
    }
  }
  return null;
}

selfTest.register('task-1-identity-resolver', async () => {
  const sampleItem = await pickUserLibraryItem();

  return [
    await scenario("libraryKeyFromLocalID returns 'user' for user library", async () => {
      const key = libraryKeyFromLocalID(Zotero.Libraries.userLibraryID);
      assertEq(key, 'user');
    }),

    await scenario('libraryKeyFromLocalID returns null for invalid library id', async () => {
      const key = libraryKeyFromLocalID(-999999);
      assertEq(key, null);
    }),

    await scenario("localLibraryIDFromKey('user') returns current userLibraryID", async () => {
      const id = localLibraryIDFromKey('user');
      assertEq(id, Zotero.Libraries.userLibraryID);
    }),

    await scenario('identityFromItem on a real indexed item produces matching itemKey', async () => {
      assertTrue(sampleItem, 'no user-library item available to test against');
      const identity = identityFromItem(sampleItem);
      assertTrue(identity, 'identityFromItem returned null');
      assertEq(identity!.libraryKey, 'user');
      assertEq(identity!.itemKey, sampleItem.key);
    }),

    await scenario('localItemIDFromIdentity round-trips', async () => {
      assertTrue(sampleItem, 'no user-library item available to test against');
      const identity = identityFromItem(sampleItem);
      assertTrue(identity, 'identityFromItem returned null');
      const localID = localItemIDFromIdentity(identity!);
      assertEq(localID, sampleItem.id);
    }),

    await scenario('findIdentityByItemKey resolves by key alone', async () => {
      assertTrue(sampleItem, 'no user-library item available to test against');
      const found = findIdentityByItemKey(sampleItem.key);
      assertTrue(found, 'findIdentityByItemKey returned null for known key');
      assertEq(found!.itemKey, sampleItem.key);
    }),

    await scenario('findIdentityByItemKey returns null for unknown key', async () => {
      const found = findIdentityByItemKey('ZZZZZZZZ');
      assertEq(found, null);
    }),

    await scenario('bulkResolve returns only resolvable identities', async () => {
      assertTrue(sampleItem, 'no user-library item available');
      const real = identityFromItem(sampleItem);
      assertTrue(real, 'identity for sample item should be non-null');
      const fake = { libraryKey: 'user', itemKey: 'ZZZZZZZZ' };
      const map = bulkResolve([real!, fake]);
      assertEq(map.size, 1, 'bulkResolve should drop unresolvable');
      assertEq(map.get(`${real!.libraryKey}|${real!.itemKey}`), sampleItem.id);
    }),
  ];
});
