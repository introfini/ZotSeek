/**
 * Keeps a progress popup in sync with the main window's minimized state.
 *
 * On macOS the `dependent` window feature is a no-op for top-level chrome
 * windows (Firefox's Cocoa widget only attaches child windows for popups),
 * so Zotero's progress popup neither hides nor minimizes with the main
 * window; it lingers on screen over other applications (issue #14). This
 * module mirrors the main window's minimize/restore onto the popup.
 *
 * Pure logic with injected dependencies so it can be unit-tested in Node.
 */

export interface MinimizeFollowerDeps {
  mainWindow: {
    addEventListener(type: string, listener: () => void): void;
    removeEventListener(type: string, listener: () => void): void;
    windowState: number;
    STATE_MINIMIZED?: number;
  };
  /** Returns the popup window to follow, or null when it cannot be found. */
  findPopupWindow: () => { closed: boolean } | null;
  setPopupVisible: (popupWin: unknown, visible: boolean) => void;
}

const DEFAULT_STATE_MINIMIZED = 2;

/**
 * Attach a sizemodechange listener to the main window. Returns a detach
 * function; the follower also detaches itself once the popup is gone.
 */
export function attachMinimizeFollower(deps: MinimizeFollowerDeps): () => void {
  const { mainWindow, findPopupWindow, setPopupVisible } = deps;
  let attached = false;

  const onSizeModeChange = (): void => {
    const popup = findPopupWindow();
    if (!popup || popup.closed) {
      detach();
      return;
    }
    const minimizedState = mainWindow.STATE_MINIMIZED ?? DEFAULT_STATE_MINIMIZED;
    setPopupVisible(popup, mainWindow.windowState !== minimizedState);
  };

  const detach = (): void => {
    if (!attached) return;
    attached = false;
    mainWindow.removeEventListener('sizemodechange', onSizeModeChange);
  };

  mainWindow.addEventListener('sizemodechange', onSizeModeChange);
  attached = true;
  return detach;
}
