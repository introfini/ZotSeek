/**
 * Stable progress window implementation using zotero-plugin-toolkit
 * This replaces the crashing native implementation
 */

import { ProgressWindowHelper } from 'zotero-plugin-toolkit';
import { Logger } from './logger';
import { attachMinimizeFollower } from './minimize-follower';
import { pickOwnPopupWindow, removeInjectedControls } from './progress-window-claim';

// Popup windows already claimed by a StableProgressWindow instance. A claim
// retry must never adopt a sibling instance's popup (issue #49).
const claimedPopupWindows = new WeakSet<object>();

function enumerateWindows(Svc: any): any[] {
  const wins: any[] = [];
  const en = Svc.wm.getEnumerator(null);
  while (en.hasMoreElements()) wins.push(en.getNext());
  return wins;
}

// A window can be our popup while it is still loading (about:blank) or once
// it has loaded progressWindow.xhtml. Anything else is foreign.
function canBeProgressPopup(win: any): boolean {
  try {
    const href = win.location?.href;
    return href === 'about:blank'
      || (typeof href === 'string' && href.includes('progressWindow.xhtml'));
  } catch {
    return false;
  }
}

/**
 * Hide or show a chrome window without closing it, via nsIBaseWindow.
 * Note: the visibility getter does not read back the value set here, so
 * callers must track the intended state themselves and only ever write.
 */
function setChromeWindowVisibility(win: any, visible: boolean): void {
  try {
    const ci =
      win.Ci ?? (globalThis as any).Ci ?? (globalThis as any).Components?.interfaces;
    const baseWin = win.docShell?.treeOwner?.QueryInterface?.(ci.nsIBaseWindow);
    if (baseWin) baseWin.visibility = visible;
  } catch {
    // The popup may be mid-teardown; losing one visibility toggle is harmless
  }
}

// Set default icon for all progress windows
ProgressWindowHelper.setIconURI(
  'default',
  `chrome://zotseek/content/icons/favicon.png`
);

export interface StableProgressOptions {
  title: string;
  closeOnClick?: boolean;
  cancelCallback?: () => void;
}

// Cap on visible checkpoint lines. Every createLine makes Zotero's _move()
// sizeToContent + bottom-anchor the popup, while our resizeTo keeps the top
// edge fixed, so unbounded line growth ratchets the window upward off-screen
// (issue #14). Older checkpoints rotate out instead of adding lines.
const MAX_CHECKPOINT_LINES = 4;

/**
 * Stable progress window with dynamic height sizing
 */
export class StableProgressWindow {
  private progressWindow: any;
  private progressWin: any = null; // The actual window object
  private logger: Logger;
  private cancelled = false;
  private cancelCallback?: () => void;
  private currentLine: any;
  private startTime: number;
  private title: string;

  // Pause/resume state
  private paused = false;
  private resumeResolver: (() => void) | null = null;
  private pausedAt: number = 0;
  private totalPausedMs: number = 0;
  private pauseButton: any = null;

  // Track checkpoint lines for reverse-order display (newest first)
  private checkpointTexts: string[] = [];
  private checkpointStartIndex: number = -1; // Index of first checkpoint line in toolkit's lines array
  private checkpointLineCount = 0; // Lines actually created (capped at MAX_CHECKPOINT_LINES)

  // Detach function for the macOS minimize follower (null when not attached)
  private detachMinimizeFollower: (() => void) | null = null;

  // Windows that existed before show() opened our popup; the popup is the one
  // window not in this set (issue #49)
  private preShowWindows: WeakSet<object> | null = null;
  // Once our claimed popup is gone, never claim another window
  private popupLost = false;
  // Set by complete(); blocks pause/cancel injection after the run is over
  private completed = false;
  // Fallback close timer living on the main window, immune to the popup's
  // own mouseover-cancelled timer (issue #49)
  private fallbackCloseWin: any = null;
  private fallbackCloseId: any = null;

  constructor(options: StableProgressOptions) {
    this.logger = new Logger('StableProgress');
    this.title = options.title;
    this.cancelCallback = options.cancelCallback;
    this.startTime = Date.now();

    try {
      // Snapshot the open windows so the popup created by show() below can be
      // positively identified as the one window missing from this set
      const Svc = this.getServices();
      if (Svc?.wm) {
        this.preShowWindows = new WeakSet();
        for (const w of enumerateWindows(Svc)) this.preShowWindows.add(w);
      }

      // Create the progress window with toolkit
      this.progressWindow = new ProgressWindowHelper(options.title, {
        closeOnClick: options.closeOnClick ?? false,
        closeTime: -1, // Don't auto-close
      });

      // Create initial progress line
      this.currentLine = this.progressWindow.createLine({
        text: 'Initializing...',
        type: 'default',
        progress: 0,
      });

      // Show the window
      this.progressWindow.show();

      // Claim our popup in the same tick as show(): openDialog registers the
      // window in the window mediator synchronously, so the enumeration diff
      // against the snapshot is exactly our popup and nothing else
      this.findProgressWindow();

      // Resize the window after it loads
      // Must use setTimeout because the window isn't ready immediately after show()
      const Z = (globalThis as any).Zotero;
      const mainWindow = Z?.getMainWindow?.();

      const doInitialResize = () => {
        this.ensureSize();
      };

      // Use the main window's setTimeout for reliable execution
      if (mainWindow?.setTimeout) {
        mainWindow.setTimeout(doInitialResize, 100);
      } else if (typeof setTimeout !== 'undefined') {
        setTimeout(doInitialResize, 100);
      }

      // On macOS the popup does not follow the main window's minimize (the
      // `dependent` window feature is a no-op for top-level windows in the
      // Cocoa widget), so mirror minimize/restore onto it ourselves
      if (Z?.isMac && mainWindow) {
        this.detachMinimizeFollower = attachMinimizeFollower({
          mainWindow,
          findPopupWindow: () => this.findProgressWindow(),
          setPopupVisible: setChromeWindowVisibility,
        });
      }

      this.logger.debug(`Progress window created: ${options.title}`);
    } catch (error) {
      this.logger.error('Failed to create progress window:', error);
      // Fall back to console logging
      this.useFallback();
    }
  }
  
  /**
   * Update progress with text and percentage
   */
  updateProgress(text: string, percent?: number | null, additionalInfo?: string[]): void {
    if (this.cancelled) return;
    
    try {
      // Build the full text
      let fullText = text;
      if (additionalInfo && additionalInfo.length > 0) {
        fullText += '\n' + additionalInfo.join('\n');
      }
      
      // Update the progress line
      if (this.progressWindow && this.currentLine) {
        this.progressWindow.changeLine({
          text: fullText,
          progress: percent ?? 0,
        });
        this.ensureSize();
      } else {
        // Fallback to logging
        this.logger.info(`Progress: ${fullText} (${percent ?? 0}%)`);
      }
    } catch (error) {
      this.logger.error('Failed to update progress:', error);
      this.useFallback();
    }
  }
  
  /**
   * Set headline (title) of the progress window
   */
  setHeadline(text: string): void {
    if (this.cancelled) return;
    
    try {
      // Toolkit doesn't have changeHeadline, so we update the line text
      this.updateProgress(text, null);
    } catch (error) {
      this.logger.error('Failed to set headline:', error);
    }
  }
  
  /**
   * Add a status line with optional icon
   */
  addLine(text: string, icon?: 'chrome://zotero/skin/tick.png' | 'chrome://zotero/skin/cross.png'): void {
    if (this.cancelled) return;

    try {
      // Determine type based on icon
      let type: 'default' | 'success' | 'fail' = 'default';
      if (icon?.includes('tick')) {
        type = 'success';
      } else if (icon?.includes('cross')) {
        type = 'fail';
      }

      // Create a new line for status messages
      if (this.progressWindow) {
        this.progressWindow.createLine({
          text,
          type,
          progress: 100,
        });
        this.ensureSize();
      } else {
        this.logger.info(`Status: ${text}`);
      }
    } catch (error) {
      this.logger.error('Failed to add line:', error);
    }
  }

  /**
   * Add a checkpoint line in reverse order (newest first)
   * This keeps the most recent checkpoint visible at the top of the checkpoint section
   */
  addCheckpointLine(text: string): void {
    if (this.cancelled) return;

    try {
      if (!this.progressWindow) {
        this.logger.info(`Checkpoint: ${text}`);
        return;
      }

      // Keep only the texts that can still be displayed
      this.checkpointTexts.push(text);
      if (this.checkpointTexts.length > MAX_CHECKPOINT_LINES) {
        this.checkpointTexts.shift();
      }

      // Create a new line only while under the cap; afterwards texts rotate
      // through the existing lines so the window height stays bounded
      if (this.checkpointLineCount === 0) {
        this.checkpointStartIndex = this.progressWindow.lines?.length || 0;
      }
      if (this.checkpointLineCount < MAX_CHECKPOINT_LINES) {
        this.progressWindow.createLine({
          text: '', // Will be filled by the update below
          type: 'success',
          progress: 100,
        });
        this.checkpointLineCount++;
      }

      // Update the visible checkpoint lines in reverse order (newest first)
      for (let i = 0; i < this.checkpointLineCount; i++) {
        this.progressWindow.changeLine({
          idx: this.checkpointStartIndex + i,
          text: this.checkpointTexts[this.checkpointTexts.length - 1 - i] ?? '',
          type: 'success',
          progress: 100,
        });
      }
      this.ensureSize();
    } catch (error) {
      this.logger.error('Failed to add checkpoint line:', error);
    }
  }
  
  /**
   * Complete the progress with success message
   */
  complete(message?: string, autoClose = true): void {
    if (this.cancelled) return;

    try {
      // The run is over: pause/cancel no longer apply
      this.completed = true;
      this.removeControls();

      if (this.progressWindow) {
        // Update to success state
        this.progressWindow.changeLine({
          text: message || 'Complete!',
          type: 'success',
          progress: 100,
        });
        this.ensureSize();

        // Auto-close after delay (15 seconds to allow reading stats)
        if (autoClose) {
          this.progressWindow.startCloseTimer(15000);
          // Zotero cancels that timer on mouseover and only re-arms it after
          // a fragile mouseout coordinate check (issue #49), so force the
          // close from the main window's event loop as well
          this.scheduleFallbackClose(16000);
        }
      } else {
        this.logger.info(`Complete: ${message || 'Done'}`);
      }
    } catch (error) {
      this.logger.error('Failed to complete progress:', error);
    }
  }
  
  /**
   * Show error and optionally close
   */
  error(message: string, autoClose = false): void {
    try {
      if (this.progressWindow) {
        // Update to error state
        this.progressWindow.changeLine({
          text: message,
          type: 'fail',
          progress: 100,
        });
        this.ensureSize();

        // Keep error visible longer
        if (autoClose) {
          this.progressWindow.startCloseTimer(8000);
          this.scheduleFallbackClose(9000);
        }
      } else {
        this.logger.error(`Error shown: ${message}`);
      }
    } catch (error) {
      this.logger.error('Failed to show error:', error);
    }
  }
  
  /**
   * Close the progress window
   */
  close(): void {
    try {
      this.clearFallbackClose();
      this.detachMinimizeFollower?.();
      this.detachMinimizeFollower = null;
      if (this.progressWindow) {
        this.progressWindow.close();
        this.logger.debug('Progress window closed');
      }
    } catch (error) {
      this.logger.error('Failed to close progress window:', error);
    }
  }
  
  /**
   * Check if cancelled
   */
  isCancelled(): boolean {
    return this.cancelled;
  }
  
  /**
   * Cancel the operation
   */
  cancel(): void {
    this.cancelled = true;
    this.paused = false;
    this.logger.info('Progress cancelled by user');

    // Unblock waitIfPaused() so the loop can reach the cancel check
    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }

    if (this.cancelCallback) {
      this.cancelCallback();
    }

    this.close();
  }

  /**
   * Pause the operation
   */
  pause(): void {
    if (this.paused || this.cancelled) return;
    this.paused = true;
    this.pausedAt = Date.now();
    this.logger.info('Progress paused by user');
    this.updatePauseButtonState();
  }

  /**
   * Resume the operation
   */
  resume(): void {
    if (!this.paused) return;
    this.paused = false;
    this.totalPausedMs += Date.now() - this.pausedAt;
    this.pausedAt = 0;
    this.logger.info('Progress resumed by user');
    this.updatePauseButtonState();

    if (this.resumeResolver) {
      this.resumeResolver();
      this.resumeResolver = null;
    }
  }

  /**
   * Wait if paused. Resolves immediately if not paused.
   * Call this at checkpoint boundaries in the indexing loop.
   */
  async waitIfPaused(): Promise<void> {
    if (!this.paused) return;
    return new Promise<void>(resolve => {
      this.resumeResolver = resolve;
    });
  }

  /**
   * Check if paused
   */
  isPaused(): boolean {
    return this.paused;
  }

  /**
   * Fallback to console logging
   */
  private useFallback(): void {
    this.logger.warn('Using console logging fallback for progress');
    this.progressWindow = null;
  }

  /**
   * Get Services object from available sources
   */
  private getServices(): any {
    try {
      const Z = (globalThis as any).Zotero;
      const mainWindow = Z?.getMainWindow?.();
      return mainWindow?.Services || (globalThis as any).Services;
    } catch {
      return null;
    }
  }

  /**
   * Find the progress window belonging to this instance.
   *
   * The window is claimed once, by diffing the window enumeration against
   * the pre-show() snapshot; matching by the 'Progress' title is forbidden,
   * because every Zotero.ProgressWindow popup carries that title and a title
   * match adopts stale popups from earlier runs (issue #49: duplicate dead
   * pause/cancel buttons, the wrong window resized). Once the claimed popup
   * is gone this instance has no window, ever.
   */
  private findProgressWindow(): any {
    // Validate cached reference is still open
    if (this.progressWin) {
      try {
        if (!this.progressWin.closed) return this.progressWin;
      } catch {
        // Window was destroyed
      }
      this.progressWin = null;
      this.pauseButton = null; // Button was in the old window
      this.popupLost = true;
    }
    if (this.popupLost) return null;

    try {
      const Svc = this.getServices();
      if (!Svc?.wm || !this.preShowWindows) return null;
      const win = pickOwnPopupWindow({
        preExisting: this.preShowWindows,
        windows: enumerateWindows(Svc),
        isClaimed: (w) => claimedPopupWindows.has(w),
        matches: canBeProgressPopup,
      });
      if (win) {
        claimedPopupWindows.add(win);
        this.progressWin = win;
      }
      return win;
    } catch {
      // Ignore errors
    }
    return null;
  }

  // Window size constraints
  private readonly minHeight = 120;
  private readonly maxHeight = 400;

  /**
   * Resize window to fit content and stay within main Zotero window bounds
   */
  private ensureSize(): void {
    try {
      const win = this.findProgressWindow();
      if (!win) return;

      const doc = win.document;
      const Z = (globalThis as any).Zotero;
      const mainWindow = Z?.getMainWindow?.();

      // Calculate actual content height
      let targetHeight = win.outerHeight;
      const textBox = doc.getElementById('zotero-progress-text-box');
      if (textBox) {
        // Get all child item boxes and sum their heights
        const items = textBox.querySelectorAll('.zotero-progress-item-hbox');
        const headline = doc.getElementById('zotero-progress-text-headline');

        let contentHeight = headline ? headline.getBoundingClientRect().height : 20;
        items.forEach((item: Element) => {
          contentHeight += (item as HTMLElement).getBoundingClientRect().height + 4; // 4px gap
        });

        // Add padding
        targetHeight = Math.ceil(contentHeight) + 40; // 40px padding for margins

        // Clamp between min and max height
        targetHeight = Math.max(this.minHeight, Math.min(this.maxHeight, targetHeight));

        // ±2px tolerance: under Windows display scaling outerHeight rarely
        // round-trips resizeTo exactly, and resizing on every update feeds
        // the position drift
        if (Math.abs(win.outerHeight - targetHeight) > 2) {
          win.resizeTo(win.outerWidth, targetHeight);
        }
      }

      // Re-anchor the bottom edge to the main window bottom. Zotero's own
      // _move() bottom-anchors after sizeToContent while resizeTo above keeps
      // the top edge fixed; correcting in one direction only lets the window
      // ratchet upward off-screen (issue #14), so always re-anchor
      if (mainWindow) {
        const mainBottom = mainWindow.screenY + mainWindow.outerHeight;
        let newY = mainBottom - targetHeight - 10; // 10px padding from bottom
        const availTop = win.screen?.availTop ?? 0;
        if (newY < availTop) newY = availTop;
        if (Math.abs(win.screenY - newY) > 2) {
          win.moveTo(win.screenX, newY);
        }
      }

      // Inject pause button if not yet present
      this.injectPauseButton();
    } catch {
      // Ignore resize/position errors
    }
  }

  /**
   * Inject pause/play and cancel buttons into the progress window
   */
  private injectPauseButton(): void {
    try {
      if (this.completed) return;
      const win = this.findProgressWindow();
      if (!win) return;
      if (this.pauseButton) return;

      const doc = win.document;
      const headline = doc.getElementById('zotero-progress-text-headline');
      if (!headline) return;

      const btnStyle = 'padding: 2px 8px; font-size: 12px; cursor: pointer; border: 1px solid var(--material-border, #ccc); border-radius: 4px; background: var(--material-background, #f5f5f5); vertical-align: middle;';

      // Pause/play button
      const pauseBtn = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
      pauseBtn.setAttribute('id', 'zotseek-pause-btn');
      pauseBtn.textContent = '\u23F8';
      pauseBtn.title = 'Pause indexing';
      pauseBtn.style.cssText = `margin-left: 8px; ${btnStyle}`;

      pauseBtn.addEventListener('click', () => {
        if (this.paused) {
          this.resume();
        } else {
          this.pause();
        }
      });

      // Cancel button
      const cancelBtn = doc.createElementNS('http://www.w3.org/1999/xhtml', 'button');
      cancelBtn.setAttribute('id', 'zotseek-cancel-btn');
      cancelBtn.textContent = '\u2715';
      cancelBtn.title = 'Cancel indexing';
      cancelBtn.style.cssText = `margin-left: 4px; ${btnStyle}`;

      cancelBtn.addEventListener('click', () => {
        this.cancel();
      });

      headline.appendChild(pauseBtn);
      headline.appendChild(cancelBtn);
      this.pauseButton = pauseBtn;
    } catch (error) {
      this.logger.debug(`Could not inject control buttons: ${error}`);
    }
  }

  /**
   * Remove the injected pause/cancel controls from our popup
   */
  private removeControls(): void {
    try {
      const win = this.findProgressWindow();
      if (win?.document) removeInjectedControls(win.document);
    } catch {
      // Popup may already be gone
    }
    this.pauseButton = null;
  }

  /**
   * Schedule a close() from the main window's event loop. The popup's own
   * close timer can be cancelled by a mouseover and never re-armed (issue
   * #49); this one cannot. Harmless if Zotero's timer wins the race:
   * close() on a closed window is a no-op.
   */
  private scheduleFallbackClose(ms: number): void {
    this.clearFallbackClose();
    try {
      const Z = (globalThis as any).Zotero;
      const mainWindow = Z?.getMainWindow?.();
      const setT = mainWindow?.setTimeout?.bind(mainWindow)
        ?? (typeof setTimeout !== 'undefined' ? setTimeout : null);
      if (!setT) return;
      this.fallbackCloseWin = mainWindow ?? null;
      this.fallbackCloseId = setT(() => {
        this.fallbackCloseId = null;
        this.close();
      }, ms);
    } catch {
      // Zotero's own close timer remains the only close path
    }
  }

  private clearFallbackClose(): void {
    if (this.fallbackCloseId == null) return;
    try {
      const clearT = this.fallbackCloseWin?.clearTimeout?.bind(this.fallbackCloseWin)
        ?? (typeof clearTimeout !== 'undefined' ? clearTimeout : null);
      clearT?.(this.fallbackCloseId);
    } catch {
      // Ignore: a fired or unclearable timer just means one extra no-op close()
    }
    this.fallbackCloseId = null;
    this.fallbackCloseWin = null;
  }

  /**
   * Update pause button text/state
   */
  private updatePauseButtonState(): void {
    if (!this.pauseButton) return;
    try {
      if (this.paused) {
        this.pauseButton.textContent = '\u25B6';
        this.pauseButton.title = 'Resume indexing';
      } else {
        this.pauseButton.textContent = '\u23F8';
        this.pauseButton.title = 'Pause indexing';
      }
    } catch {
      // Ignore if window was closed
    }
  }

  /**
   * Calculate and format ETA
   */
  formatETA(current: number, total: number): string {
    if (current === 0) return '';
    
    const currentPause = this.paused ? (Date.now() - this.pausedAt) : 0;
    const elapsed = Date.now() - this.startTime - this.totalPausedMs - currentPause;
    const avgTimePerItem = elapsed / current;
    const remaining = total - current;
    const etaMs = remaining * avgTimePerItem;
    
    const etaMin = Math.floor(etaMs / 60000);
    const etaSec = Math.floor((etaMs % 60000) / 1000);
    
    return etaMin > 0 ? `${etaMin}m ${etaSec}s` : `${etaSec}s`;
  }
  
  /**
   * Update with ETA calculation
   */
  updateProgressWithETA(text: string, current: number, total: number): void {
    const percent = Math.round((current / total) * 100);
    const eta = this.formatETA(current, total);
    
    const additionalInfo = [
      `${current}/${total} items`,
      eta ? `ETA: ${eta}` : ''
    ].filter(Boolean);
    
    this.updateProgress(text, percent, additionalInfo);
  }
}

/**
 * Quick notification helper
 */
export function showQuickNotification(
  message: string,
  type: 'default' | 'success' | 'fail' = 'default',
  duration = 5000
): void {
  try {
    new ProgressWindowHelper('Semantic Search')
      .createLine({
        text: message,
        type,
        progress: 100,
      })
      .show(duration);
  } catch (error) {
    console.error('Failed to show notification:', error);
  }
}
