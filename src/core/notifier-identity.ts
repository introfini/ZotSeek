/**
 * Identity of an item that no longer exists.
 *
 * The 'delete' notifier fires after a permanent erase, so `Zotero.Items.get()`
 * returns nothing and the stable (library_key, item_key) identity cannot be
 * read off the item. Zotero passes it in the notifier's extraData instead, as
 * `{libraryID, key}` per id (verified on 10.0.3:
 * `{"12840":{"libraryID":1,"key":"XHFLX6W8"}}`). Without this the cleanup
 * fell back to a lookup by local id, which the index has not stored since
 * schema v8, so an item erased without passing through the trash left its
 * rows behind.
 *
 * Pure so it can be tested outside Zotero: the library mapping is injected,
 * and index.ts passes `libraryKeyFromLocalID`.
 */

export interface NotifierIdentity {
  libraryKey: string;
  itemKey: string;
}

export function identityFromNotifierData(
  data: any,
  libraryKeyOf: (libraryID: number) => string | null,
): NotifierIdentity | null {
  const key = data?.key;
  const libraryID = data?.libraryID;
  if (typeof key !== 'string' || key.length === 0) return null;
  if (typeof libraryID !== 'number') return null;
  const libraryKey = libraryKeyOf(libraryID);
  return libraryKey ? { libraryKey, itemKey: key } : null;
}
