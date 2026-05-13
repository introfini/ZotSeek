// src/core/identity-resolver.ts
/**
 * Identity Resolver
 *
 * Bidirectional mapping between Zotero's local (mutable) IDs and ZotSeek's
 * stable identity (library_key + item_key).
 *
 * - library_key: 'user' for the user library, or 'group:<groupID>' where
 *   <groupID> is the server-assigned Zotero group ID. Stable across all
 *   machines syncing the same library.
 * - item_key: Zotero.Item.key (8-char string), stable for the lifetime of
 *   the item and identical on every machine that syncs.
 *
 * Local Zotero IDs (Item.id, Library.libraryID) are auto-increment integers
 * regenerated per installation. Never store them; resolve on demand.
 */

import { Logger } from '../utils/logger';

declare const Zotero: any;

export interface StableIdentity {
  libraryKey: string;
  itemKey: string;
}

const logger = new Logger('IdentityResolver');

/**
 * Convert a Zotero local libraryID to a stable library_key.
 * Returns null for unknown / feed libraries (we don't index those).
 */
export function libraryKeyFromLocalID(libraryID: number): string | null {
  try {
    const lib = Zotero.Libraries.get(libraryID);
    if (!lib) return null;
    if (lib.libraryType === 'user') return 'user';
    if (lib.libraryType === 'group') {
      const groupID = lib.groupID;
      if (!groupID) {
        logger.warn(`Group library ${libraryID} has no groupID; sync may be incomplete`);
        return null;
      }
      return `group:${groupID}`;
    }
    // 'feed' libraries and any future types are ignored
    return null;
  } catch (e: any) {
    logger.error(`libraryKeyFromLocalID(${libraryID}): ${e?.message || e}`);
    if (e?.stack) Zotero.debug(e.stack);
    return null;
  }
}

/**
 * Convert a stable library_key back to a current local libraryID.
 * Returns null if the library is not present in this Zotero installation
 * (e.g. group was left, user signed into a different account, etc.).
 */
export function localLibraryIDFromKey(libraryKey: string): number | null {
  try {
    if (libraryKey === 'user') {
      return Zotero.Libraries.userLibraryID;
    }
    if (libraryKey.startsWith('group:')) {
      const groupID = parseInt(libraryKey.slice(6), 10);
      if (!Number.isFinite(groupID)) return null;
      const group = Zotero.Groups.get(groupID);
      return group ? group.libraryID : null;
    }
    return null;
  } catch (e: any) {
    logger.error(`localLibraryIDFromKey(${libraryKey}): ${e?.message || e}`);
    if (e?.stack) Zotero.debug(e.stack);
    return null;
  }
}

/**
 * Build a StableIdentity from a Zotero Item.
 * Returns null if the item is in an unindexable library (feeds).
 */
export function identityFromItem(item: any): StableIdentity | null {
  if (!item) return null;
  if (item.libraryID == null) return null;
  const libraryKey = libraryKeyFromLocalID(item.libraryID);
  if (!libraryKey) return null;
  if (!item.key) return null;
  return { libraryKey, itemKey: item.key };
}

/**
 * Look up the current local Zotero itemID for a stable identity.
 * Returns null if the item does not exist locally (orphan, not synced yet,
 * or in a library no longer joined).
 */
export function localItemIDFromIdentity(identity: StableIdentity): number | null {
  const libraryID = localLibraryIDFromKey(identity.libraryKey);
  if (libraryID === null) return null;
  try {
    const id = Zotero.Items.getIDFromLibraryAndKey(libraryID, identity.itemKey);
    return id || null;
  } catch (e: any) {
    logger.error(`localItemIDFromIdentity(${identity.libraryKey}, ${identity.itemKey}): ${e?.message || e}`);
    if (e?.stack) Zotero.debug(e.stack);
    return null;
  }
}

/**
 * Bulk-resolve identities to local IDs in one pass. Useful when filtering
 * a result set for navigation. Returns a Map from `libraryKey|itemKey` to
 * local itemID; missing items are absent from the map.
 */
export function bulkResolve(identities: StableIdentity[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const id of identities) {
    const local = localItemIDFromIdentity(id);
    if (local !== null) result.set(`${id.libraryKey}|${id.itemKey}`, local);
  }
  return result;
}

/**
 * Search across all known libraries for an item by its key alone.
 * Used by the v8 migration when the row's stored library_id is unreliable
 * (cross-machine copy). The first match wins; if you have a hint about which
 * library is more likely, pass it as `preferLibraryID`.
 */
export function findIdentityByItemKey(
  itemKey: string,
  preferLibraryID?: number
): StableIdentity | null {
  if (!itemKey) return null;

  try {
    const libs: any[] = Zotero.Libraries.getAll();
    // Order: hinted library first, then user, then groups.
    const ordered = [...libs].sort((a, b) => {
      if (preferLibraryID !== undefined) {
        if (a.libraryID === preferLibraryID) return -1;
        if (b.libraryID === preferLibraryID) return 1;
      }
      if (a.libraryType === 'user' && b.libraryType !== 'user') return -1;
      if (b.libraryType === 'user' && a.libraryType !== 'user') return 1;
      return 0;
    });

    for (const lib of ordered) {
      if (lib.libraryType !== 'user' && lib.libraryType !== 'group') continue;
      const id = Zotero.Items.getIDFromLibraryAndKey(lib.libraryID, itemKey);
      if (id) {
        const libraryKey = libraryKeyFromLocalID(lib.libraryID);
        if (libraryKey) return { libraryKey, itemKey };
      }
    }
    return null;
  } catch (e: any) {
    logger.error(`findIdentityByItemKey(${itemKey}): ${e?.message || e}`);
    if (e?.stack) Zotero.debug(e.stack);
    return null;
  }
}
