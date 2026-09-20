/**
 * ZotSeek Search Dialog with VirtualizedTable
 * Provides a UI for semantic search queries using native Zotero table
 */

import { Logger } from '../utils/logger';
import { searchEngine, SearchResult } from '../core/search-engine';
import { ZoteroAPI } from '../utils/zotero-api';
import { getZotero } from '../utils/zotero-helper';

declare const Zotero: any;
declare const Services: any;
declare const Components: any;

/**
 * Bring a chrome window to the front. Module-level rather than a class method:
 * SpiderMonkey does not reliably register added class methods from this
 * project's esbuild IIFE bundle.
 */
function raiseWindow(win: any): void {
  // Two steps, because they solve two different problems and neither is
  // enough alone. `activate` brings the APPLICATION forward when the user is
  // in another app; measured on Zotero 10.0.3 / macOS it does not reorder
  // windows within Zotero. The visibility toggle reorders within the app.
  try {
    const activate = (Zotero as any)?.Utilities?.Internal?.activate;
    if (typeof activate === 'function') {
      activate.call((Zotero as any).Utilities.Internal, win);
    } else {
      win.focus();
    }
  } catch {
    // keep going: the toggle below is the half that actually raises
  }

  // Same technique the indexing progress popup uses (see minimize-follower).
  // The `visibility` setter only acts on a change and its getter does not read
  // back what was written, so a bare `= true` on an already-visible window is a
  // no-op: it has to go false first. Verified against a dialog sitting behind
  // the main window — `= true` alone left it behind, false-then-true raised it.
  try {
    const ci = (win as any).Ci
      ?? (globalThis as any).Ci
      ?? (globalThis as any).Components?.interfaces;
    const baseWin = win.docShell?.treeOwner?.QueryInterface?.(ci.nsIBaseWindow);
    if (baseWin) {
      baseWin.visibility = false;
      baseWin.visibility = true;
    }
  } catch {
    // Window may be mid-teardown; the caller still has a usable dialog
  }
}

export class ZotSeekDialogWithVTable {
  private logger: Logger;
  private zoteroAPI: ZoteroAPI;
  private window: any = null;
  private searchResults: SearchResult[] = [];
  
  constructor() {
    this.logger = new Logger('ZotSeekDialogVTable');
    this.zoteroAPI = new ZoteroAPI();
  }

  /**
   * Open the semantic search dialog with VirtualizedTable
   * @param initialQuery - Optional query to pre-fill and auto-search (e.g., from PDF text selection)
   * @param excludeItemId - Optional item ID to exclude from results (e.g., the paper being read)
   */
  public open(initialQuery?: string, excludeItemId?: number): void {
    try {
      if (this.isWindowOpen()) {
        // Raise the existing window rather than opening a second one.
        //
        // window.focus() alone does not reliably bring a chrome window forward
        // on macOS once the application is already frontmost, which is exactly
        // the case when the user clicks the toolbar button while the main
        // window has focus. Zotero ships a helper for this whose macOS branch
        // drops to ctypes to force the activation; feature-detected because it
        // is an internal API.
        raiseWindow(this.window);

        // If we have an initial query and window is already open, set it and search
        if (initialQuery) {
          const queryInput = this.window.document?.getElementById('zotseek-query') as HTMLInputElement;
          if (queryInput) {
            queryInput.value = initialQuery;
            // Set the exclude item ID if provided
            if (excludeItemId !== undefined) {
              (this.window as any).searchDialogVTable?.setExcludeItemId?.(excludeItemId);
            }
            // Trigger search via the dialog's exposed method
            (this.window as any).searchDialogVTable?.performSearch?.();
          }
        }
        return;
      }

      const Z = getZotero();
      if (!Z) {
        this.logger.error('Zotero not available');
        return;
      }

      // Open dialog window with VirtualizedTable version
      // Pass initialQuery and excludeItemId as window arguments
      this.window = Z.getMainWindow().openDialog(
        'chrome://zotseek/content/searchDialogVTable.xhtml',
        'zotseek-dialog-vtable',
        'chrome,centerscreen,resizable,dialog=no',
        {
          initialQuery: initialQuery || '',
          excludeItemId: excludeItemId
        }
      );

      this.logger.info(`Search dialog opened${initialQuery ? ' with initial query' : ''}${excludeItemId ? ` (excluding item ${excludeItemId})` : ''}`);
    } catch (error) {
      this.logger.error('Failed to open search dialog:', error);
      this.showError('Failed to open search dialog');
    }
  }

  /**
   * Check if the search window is open
   */
  private isWindowOpen(): boolean {
    return this.window && !this.window.closed && !Components.utils.isDeadWrapper(this.window);
  }

  /**
   * Show error message
   */
  private showError(message: string): void {
    const Z = getZotero();
    if (!Z) return;

    const ps = Services.prompt || Components.classes["@mozilla.org/embedcomp/prompt-service;1"]
      .getService(Components.interfaces.nsIPromptService);
    
    ps.alert(
      Z.getMainWindow(),
      'ZotSeek Error',
      message
    );
  }
}

// Export singleton instance
export const searchDialogWithVTable = new ZotSeekDialogWithVTable();
