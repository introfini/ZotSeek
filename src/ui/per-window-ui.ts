/**
 * Per-window UI bookkeeping (issue #70).
 *
 * ZotSeek's menus, toolbar button and Tools-menu localization live in each
 * main window's DOM. Injecting them once at startup leaves every later window
 * without them: on macOS a main window closed and reopened while Zotero keeps
 * running, and on Zotero 11 any additional window. This class sets the UI up
 * in every window that loads after start(), tears it down on unload, and
 * tolerates Zotero 11 loading and unloading the same window more than once
 * (its hooks follow the window's library views, not the window itself).
 */

type SetUp<W> = (win: W) => () => void;
type ErrorHandler<W> = (error: unknown, win: W, phase: 'setUp' | 'tearDown') => void;

export class PerWindowUI<W> {
  private started = false;
  private tearDowns = new Map<W, () => void>();

  constructor(private setUp: SetUp<W>, private onError: ErrorHandler<W> = () => {}) {}

  /** Set up every window already open; windows loading before this are ignored. */
  start(windows: W[]): void {
    this.started = true;
    for (const win of windows) this.attach(win);
  }

  windowLoaded(win: W): void {
    if (this.started) this.attach(win);
  }

  windowUnloaded(win: W): void {
    this.detach(win);
  }

  stop(): void {
    this.started = false;
    for (const win of [...this.tearDowns.keys()]) this.detach(win);
  }

  private attach(win: W): void {
    if (this.tearDowns.has(win)) return;
    try {
      this.tearDowns.set(win, this.setUp(win));
    } catch (error) {
      // Left unrecorded, so the window's next load tries again
      this.onError(error, win, 'setUp');
    }
  }

  private detach(win: W): void {
    const tearDown = this.tearDowns.get(win);
    if (!tearDown) return;
    this.tearDowns.delete(win);
    try {
      tearDown();
    } catch (error) {
      this.onError(error, win, 'tearDown');
    }
  }
}

/**
 * Whether a main window currently shows a library. Zotero 11 main windows can
 * hold only reader or note tabs (`ZoteroPane.libraryView` is null then), and
 * the plugin hooks only fire for windows with a library view. Zotero 10 has no
 * `libraryView`, and its one main window always shows the library.
 */
export function hasLibraryView(win: any): boolean {
  const pane = win?.ZoteroPane;
  if (!pane) return false;
  return !('libraryView' in pane) || !!pane.libraryView;
}

/**
 * Every loaded items view in a main window. Zotero 11 has one per library
 * tab (`ZoteroPane.libraryViews`), and `ZoteroPane.itemsView` is only the
 * active one; Zotero 10 has just `ZoteroPane.itemsView`.
 */
export function itemsViewsOf(win: any): any[] {
  const pane = win?.ZoteroPane;
  if (!pane) return [];
  const views = Array.isArray(pane.libraryViews)
    ? pane.libraryViews.map((view: any) => view?.itemsView)
    : [pane.itemsView];
  return views.filter(Boolean);
}

/**
 * Whether a Zotero.Notifier event means a library tab may have a new view.
 * Zotero 11 tells plugins only about a window's first library view, so the
 * toolbar of every later library tab is found through these events instead.
 */
export function isLibraryTabEvent(event: string, type: string, ids: unknown[], extraData: any): boolean {
  if (type !== 'tab' || !['add', 'select', 'load'].includes(event)) return false;
  return ids.some((id) => extraData?.[id as string]?.type === 'library');
}
