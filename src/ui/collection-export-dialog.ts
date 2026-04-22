/**
 * Modal dialog script for content/collectionExportDialog.xhtml.
 *
 * Reads ExportDialogArgs from window.arguments[0], populates UI,
 * and mutates args.output on OK, then closes.
 *
 * The new collection is always created at the target library's root.
 * Users can drag it into a subfolder from Zotero's sidebar afterwards.
 */

import type { ExportDialogArgs } from './collection-export';
import { getString } from '../utils/locale';

declare const Zotero: any;

(function initCollectionExportDialog() {
  document.addEventListener('DOMContentLoaded', () => {
    try {
      init();
    } catch (e: any) {
      const msg = e?.message || String(e);
      Zotero.debug(`[ZotSeek] Export dialog init failed: ${msg}`);
      if (e?.stack) Zotero.debug(e.stack);
    }
  });
})();

function getArgs(): ExportDialogArgs | null {
  let wa: any = (window as any).arguments?.[0];
  // Unwrap XPConnect cross-compartment wrapper if present.
  // Same trick used in similar-documents-dialog.ts:39.
  if (wa && !wa.input && wa.wrappedJSObject) wa = wa.wrappedJSObject;
  return wa ?? null;
}

function init(): void {
  const args = getArgs();
  if (!args || !args.input) {
    Zotero.debug('[ZotSeek] Export dialog: no window.arguments[0].input');
    window.close();
    return;
  }
  initWithArgs(args);
}

function initWithArgs(args: ExportDialogArgs): void {
  const doc = window.document;

  // --- Name field ---
  const nameInput = doc.getElementById('zotseek-export-name') as HTMLInputElement;
  nameInput.value = args.input.suggestedName;
  // Focus and select so typing replaces the suggestion.
  setTimeout(() => { nameInput.focus(); nameInput.select(); }, 0);

  // --- Compute library set ---
  // Silently drop items whose record no longer exists (deleted between search and export).
  const libraryOfItem = new Map<number, number>(); // itemID -> libraryID
  let deletedItemCount = 0;
  for (const id of args.input.items) {
    const it = Zotero.Items.get(id);
    if (it && it.libraryID != null) {
      libraryOfItem.set(id, it.libraryID);
    } else {
      deletedItemCount++;
    }
  }
  const libraryIDs = Array.from(new Set(libraryOfItem.values()));

  // --- Library dropdown (shown only when results span multiple libraries) ---
  const libRow = doc.getElementById('zotseek-export-library-row') as any;
  const libMenulist = doc.getElementById('zotseek-export-library') as any;
  if (libraryIDs.length <= 1) {
    libRow.style.display = 'none';
  } else {
    libRow.style.display = '';
    const libPopup = libMenulist.querySelector('menupopup');
    while (libPopup.firstChild) libPopup.removeChild(libPopup.firstChild);
    for (const libID of libraryIDs) {
      const libName = Zotero.Libraries.get(libID)?.name ?? `Library ${libID}`;
      const mi = doc.createElementNS('http://www.mozilla.org/keymaster/gatekeeper/there.is.only.xul', 'menuitem');
      mi.setAttribute('label', libName);
      mi.setAttribute('value', String(libID));
      libPopup.appendChild(mi);
    }
    libMenulist.value = String(libraryIDs[0]);
    libMenulist.addEventListener('command', () => refresh());
  }

  const getSelectedLibraryID = (): number => {
    if (libraryIDs.length === 0) return Zotero.Libraries.userLibraryID;
    if (libraryIDs.length === 1) return libraryIDs[0];
    return parseInt(libMenulist.value, 10);
  };

  // --- Status label ---
  const statusLabel = doc.getElementById('zotseek-export-status') as any;

  function formatReasons(skippedOtherLib: number, skippedDeleted: number): string {
    const reasons: string[] = [];
    if (skippedOtherLib > 0) {
      reasons.push(getString('export-reasonOtherLibrary', { count: skippedOtherLib }));
    }
    if (skippedDeleted > 0) {
      reasons.push(getString('export-reasonDeleted', { count: skippedDeleted }));
    }
    return reasons.join('; ');
  }

  function refresh(): void {
    const libraryID = getSelectedLibraryID();

    const filteredItems: number[] = [];
    let skippedOtherLib = 0;
    for (const [itemID, itemLib] of libraryOfItem.entries()) {
      if (itemLib === libraryID) filteredItems.push(itemID);
      else skippedOtherLib++;
    }

    const total = args.input.items.length;
    const kept = filteredItems.length;
    const destination = Zotero.Libraries.get(libraryID)?.name ?? '';

    if (kept === 0) {
      statusLabel.setAttribute('value', getString('export-itemcountEmpty'));
    } else if (skippedOtherLib === 0 && deletedItemCount === 0) {
      statusLabel.setAttribute('value',
        getString('export-itemcountSimple', { count: kept, destination }));
    } else {
      const reasons = formatReasons(skippedOtherLib, deletedItemCount);
      statusLabel.setAttribute('value',
        getString('export-itemcountFiltered', { kept, total, destination, reasons }));
    }

    // Stash the computed filtered set + skip count on the window so updateOkEnabled
    // and onSave can read it without a shared mutable closure binding. The dialog
    // is transient so this window-scoped state goes away when the modal closes.
    (window as any)._zotseekExportState = { filteredItems, skippedCount: total - kept };
    updateOkEnabled();
  }

  // --- OK button enable/disable ---
  const okBtn = doc.getElementById('zotseek-export-ok') as any;
  const cancelBtn = doc.getElementById('zotseek-export-cancel') as any;

  function updateOkEnabled(): void {
    const trimmedName = nameInput.value.trim();
    const state = (window as any)._zotseekExportState;
    const hasItems = state && state.filteredItems.length > 0;
    if (trimmedName.length > 0 && hasItems) {
      okBtn.removeAttribute('disabled');
    } else {
      okBtn.setAttribute('disabled', 'true');
    }
  }

  nameInput.addEventListener('input', updateOkEnabled);
  nameInput.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !okBtn.hasAttribute('disabled')) {
      onSave();
      e.preventDefault();
    }
  });

  doc.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Escape') window.close();
  });

  cancelBtn.addEventListener('command', () => window.close());
  okBtn.addEventListener('command', () => onSave());

  function onSave(): void {
    const state = (window as any)._zotseekExportState;
    if (!state || state.filteredItems.length === 0) return;
    const libraryID = getSelectedLibraryID();

    args.output = {
      name: nameInput.value.trim(),
      libraryID,
      filteredItems: state.filteredItems.slice(),
      skippedCount: state.skippedCount,
    };
    window.close();
  }

  // Initial render.
  refresh();
}
