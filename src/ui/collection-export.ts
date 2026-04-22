/**
 * Shared collection-export logic for ZotSeek.
 *
 * Callers: src/ui/search-dialog-vtable.ts and src/ui/similar-documents-dialog.ts.
 * Opens content/collectionExportDialog.xhtml for name + library selection.
 * New collections always land at the target library's root; users can drag
 * them into a subfolder in Zotero's sidebar afterwards.
 */

import { Logger } from '../utils/logger';

declare const Zotero: any;

/**
 * Input/output contract for the modal dialog (collectionExportDialog.xhtml).
 * The caller constructs `input`, hands the whole object to openDialog() as its
 * 4th argument, and reads `output` after the dialog closes.
 *
 * `output === null` means the user canceled.
 */
export interface ExportDialogArgs {
  input: {
    suggestedName: string;
    items: number[];        // caller-deduped item IDs, may span libraries
  };
  output: null | {
    name: string;
    libraryID: number;
    filteredItems: number[]; // narrowed to chosen library, excluding deleted
    skippedCount: number;    // items.length - filteredItems.length
  };
}

/**
 * Summary returned to callers on successful export.
 */
export interface ExportSummary {
  collectionID: number;
  collectionName: string;
  libraryID: number;
  addedCount: number;
  skippedCount: number;
}

/**
 * Open the modal, let the user choose name (and library when results span
 * multiple libraries), then create the collection at the library root and
 * add the items in a single Zotero transaction.
 *
 * Returns the summary on success, or null if the user canceled the modal.
 * Throws on Zotero DB failure; callers are expected to catch and surface a
 * short status string.
 */
export async function exportItemsToNewCollection(opts: {
  items: number[];
  suggestedName: string;
  window: Window;
  logger: Logger;
}): Promise<ExportSummary | null> {
  const { items, suggestedName, window, logger } = opts;

  if (items.length === 0) {
    logger.warn('exportItemsToNewCollection called with empty items array');
    return null;
  }

  // Build the dialog args object.
  const dialogArgs: ExportDialogArgs = {
    input: { suggestedName, items },
    output: null,
  };

  // Open the modal. The 'modal' feature blocks until the window closes.
  // Cast to any: openDialog is Firefox/Zotero-specific and not on the standard Window type.
  (window as any).openDialog(
    'chrome://zotseek/content/collectionExportDialog.xhtml',
    '',
    'chrome,dialog,modal,centerscreen,resizable=no',
    dialogArgs
  );

  // After the window closes, read the output.
  const out = dialogArgs.output;
  if (out === null) {
    logger.debug('Export dialog canceled by user');
    return null;
  }

  // Create + populate the collection in a single transaction.
  // Always created at library root; user can drag into a subfolder afterwards.
  logger.info(`Creating collection "${out.name}" in library ${out.libraryID} with ${out.filteredItems.length} items`);

  let collectionID: number = -1;
  await Zotero.DB.executeTransaction(async () => {
    const coll = new Zotero.Collection();
    coll.libraryID = out.libraryID;
    coll.name = out.name;
    await coll.save();
    await coll.addItems(out.filteredItems);
    collectionID = coll.id;
  });

  return {
    collectionID,
    collectionName: out.name,
    libraryID: out.libraryID,
    addedCount: out.filteredItems.length,
    skippedCount: out.skippedCount,
  };
}

/**
 * Add the given items to an existing collection. Wraps the call in a Zotero
 * transaction (required by the Zotero DB contract).
 *
 * Throws on failure. Returns the collection name and added count for caller
 * status messages.
 */
export async function addItemsToCollection(opts: {
  items: number[];
  collectionID: number;
  logger: Logger;
}): Promise<{ collectionName: string; addedCount: number }> {
  const { items, collectionID, logger } = opts;
  logger.info(`Adding items ${items.join(', ')} to collection ${collectionID}`);

  const collection = Zotero.Collections.get(collectionID);
  if (!collection) {
    const msg = `Collection ${collectionID} not found`;
    logger.error(msg);
    throw new Error(msg);
  }
  const collectionName = collection.name as string;

  await Zotero.DB.executeTransaction(async () => {
    await collection.addItems(items);
  });

  logger.info(`Added ${items.length} items to collection "${collectionName}"`);
  return { collectionName, addedCount: items.length };
}

/**
 * Fill the given XUL menupopup with one menuitem per collection in the items'
 * library, sorted alphabetically, capped at 20 entries with a "...N more"
 * disabled trailing item. Calls onPickCollection when the user clicks an entry.
 *
 * Does NOT add a "New collection..." item - that's the caller's concern.
 */
export function populateCollectionMenu(opts: {
  popup: Element;
  items: number[];
  doc: Document;
  logger: Logger;
  onPickCollection: (collectionID: number) => Promise<void>;
}): void {
  const { popup, items, doc, logger, onPickCollection } = opts;

  try {
    if (items.length === 0) return;
    const firstItem = Zotero.Items.get(items[0]);
    const libraryID = firstItem?.libraryID ?? Zotero.Libraries.userLibraryID;

    const collections = (Zotero.Collections.getByLibrary(libraryID) as any[]) || [];

    if (collections.length === 0) {
      const none = doc.createElementNS(
        'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul',
        'menuitem'
      );
      none.setAttribute('data-l10n-id', 'zotseek-search-noCollections');
      none.setAttribute('disabled', 'true');
      popup.appendChild(none);
      return;
    }

    collections.sort((a, b) => a.name.localeCompare(b.name));

    const maxCollections = 20;
    for (let i = 0; i < Math.min(collections.length, maxCollections); i++) {
      const collection = collections[i];
      const item = doc.createElementNS(
        'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul',
        'menuitem'
      );
      item.setAttribute('label', collection.name);
      item.addEventListener('command', async () => {
        await onPickCollection(collection.id);
      });
      popup.appendChild(item);
    }

    if (collections.length > maxCollections) {
      const more = doc.createElementNS(
        'http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul',
        'menuitem'
      );
      more.setAttribute('data-l10n-id', 'zotseek-search-moreCollections');
      more.setAttribute('data-l10n-args', JSON.stringify({ count: collections.length - maxCollections }));
      more.setAttribute('disabled', 'true');
      popup.appendChild(more);
    }
  } catch (error: any) {
    logger.error(`Failed to populate collection menu: ${error?.message || error}`);
  }
}
