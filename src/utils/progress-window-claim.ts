/**
 * Pure logic for positively identifying the progress popup a
 * StableProgressWindow instance owns (issue #49).
 *
 * Every Zotero.ProgressWindow popup is titled 'Progress', so matching by
 * title adopts stale popups from earlier runs (or Zotero's own save popups).
 * Instead, the instance snapshots the open windows before showing its popup
 * and claims the window that appeared afterwards.
 */

/**
 * Pick the popup window this instance owns from a window enumeration in
 * creation order (oldest first).
 *
 * A window qualifies when it did not exist before the popup was opened, is
 * not claimed by another instance, is still open, and passes `matches`. The
 * oldest qualifying window wins: the instance's own popup is created in the
 * constructor's tick, so any foreign popup that qualifies can only have been
 * opened later.
 */
export function pickOwnPopupWindow<W extends { closed?: boolean }>(args: {
  preExisting: { has(win: W): boolean };
  windows: readonly W[];
  isClaimed(win: W): boolean;
  matches(win: W): boolean;
}): W | null {
  for (const win of args.windows) {
    if (win.closed) continue;
    if (args.preExisting.has(win)) continue;
    if (args.isClaimed(win)) continue;
    if (!args.matches(win)) continue;
    return win;
  }
  return null;
}

/**
 * Remove the pause/cancel controls ZotSeek injected into a progress popup.
 * Removes duplicates too: popups polluted by pre-fix versions can carry
 * several pairs.
 */
export function removeInjectedControls(doc: {
  querySelectorAll(selector: string): ArrayLike<{ remove(): void }>;
}): number {
  let removed = 0;
  for (const selector of ['#zotseek-pause-btn', '#zotseek-cancel-btn']) {
    const els = doc.querySelectorAll(selector);
    for (let i = els.length - 1; i >= 0; i--) {
      els[i].remove();
      removed++;
    }
  }
  return removed;
}
