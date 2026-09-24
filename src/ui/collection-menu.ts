/**
 * Visibility rule for the ZotSeek entry in the collection-pane context menu.
 *
 * Zotero builds `zotero-collectionmenu` by walking only its own first N
 * children, so anything a plugin appends stays visible for every row type:
 * libraries, feeds, saved searches, the trash. The collection actions only
 * make sense on collections, so the entry hides itself for everything else
 * (issue #61).
 *
 * Pure logic with an injected pane so it can be unit-tested in Node.
 */

export interface CollectionTreeRowLike {
  isCollection(): boolean;
}

export interface CollectionPaneLike {
  getCollectionTreeRows?: () => CollectionTreeRowLike[] | null | undefined;
  getCollectionTreeRow?: () => CollectionTreeRowLike | null | undefined;
}

/**
 * Rows currently selected in the collection pane. Zotero 10 added multi-row
 * selection and turned the singular getter into a stub that throws, so the
 * plural name is feature-detected first and the singular one is only a
 * Zotero 8/9 fallback.
 */
export function getSelectedCollectionTreeRows(pane: CollectionPaneLike | null | undefined): CollectionTreeRowLike[] {
  if (!pane) return [];
  if (typeof pane.getCollectionTreeRows === 'function') {
    return pane.getCollectionTreeRows() || [];
  }
  if (typeof pane.getCollectionTreeRow === 'function') {
    const row = pane.getCollectionTreeRow();
    return row ? [row] : [];
  }
  return [];
}

/**
 * True when the selection is one or more collections and nothing else, which
 * is exactly the set `onIndexCollection()` can act on.
 */
export function shouldShowCollectionMenu(pane: CollectionPaneLike | null | undefined): boolean {
  const rows = getSelectedCollectionTreeRows(pane);
  return rows.length > 0 && rows.every((row) => row.isCollection());
}
