import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { PerWindowUI, hasLibraryView, isLibraryTabEvent, itemsViewsOf } from '../src/ui/per-window-ui';

type Win = { name: string };

// Records every set-up and tear-down, in order
function recorder(opts: { failSetUp?: Set<string>; failTearDown?: Set<string> } = {}) {
  const log: string[] = [];
  const ui = new PerWindowUI<Win>((win) => {
    if (opts.failSetUp?.has(win.name)) throw new Error(`set-up failed: ${win.name}`);
    log.push(`up:${win.name}`);
    return () => {
      if (opts.failTearDown?.has(win.name)) throw new Error(`tear-down failed: ${win.name}`);
      log.push(`down:${win.name}`);
    };
  });
  return { ui, log };
}

describe('per-window UI (issue #70)', () => {
  const a = { name: 'a' };
  const b = { name: 'b' };

  test('ignores a window that loads before start, then start covers it', () => {
    const { ui, log } = recorder();
    ui.windowLoaded(a);
    assert.deepEqual(log, []);
    ui.start([a]);
    assert.deepEqual(log, ['up:a']);
  });

  test('sets up a window that opens after start (a reopened or second window)', () => {
    const { ui, log } = recorder();
    ui.start([a]);
    ui.windowLoaded(b);
    assert.deepEqual(log, ['up:a', 'up:b']);
  });

  test('sets up a window once however many times it loads', () => {
    const { ui, log } = recorder();
    ui.start([a]);
    ui.windowLoaded(a);
    ui.windowLoaded(a);
    assert.deepEqual(log, ['up:a']);
  });

  test('tears down on unload and sets up again on the next load (Zotero 11 cycles a window)', () => {
    const { ui, log } = recorder();
    ui.start([a]);
    ui.windowUnloaded(a);
    ui.windowLoaded(a);
    assert.deepEqual(log, ['up:a', 'down:a', 'up:a']);
  });

  test('ignores the unload of a window it never set up', () => {
    const { ui, log } = recorder();
    ui.start([]);
    ui.windowUnloaded(a);
    assert.deepEqual(log, []);
  });

  test('stop tears down every window and ignores later loads', () => {
    const { ui, log } = recorder();
    ui.start([a, b]);
    ui.stop();
    ui.windowLoaded(a);
    assert.deepEqual(log, ['up:a', 'up:b', 'down:a', 'down:b']);
  });

  test('a window whose set-up threw is retried on its next load', () => {
    const failSetUp = new Set(['a']);
    const { ui, log } = recorder({ failSetUp });
    ui.start([a, b]);
    failSetUp.clear();
    ui.windowLoaded(a);
    assert.deepEqual(log, ['up:b', 'up:a']);
  });

  test('a tear-down that throws does not stop the others', () => {
    const { ui, log } = recorder({ failTearDown: new Set(['a']) });
    ui.start([a, b]);
    ui.stop();
    assert.deepEqual(log, ['up:a', 'up:b', 'down:b']);
  });
});

describe('hasLibraryView', () => {
  test('a Zotero 10 window always has its library view', () => {
    assert.equal(hasLibraryView({ ZoteroPane: {} }), true);
  });

  test('a Zotero 11 window has one only while ZoteroPane.libraryView is set', () => {
    assert.equal(hasLibraryView({ ZoteroPane: { libraryView: {} } }), true);
    assert.equal(hasLibraryView({ ZoteroPane: { libraryView: null } }), false);
  });

  test('a window without ZoteroPane has none', () => {
    assert.equal(hasLibraryView({}), false);
    assert.equal(hasLibraryView(null), false);
  });
});

describe('itemsViewsOf', () => {
  const a = { name: 'tree a' };
  const b = { name: 'tree b' };

  test('a Zotero 10 window has the one items view of its pane', () => {
    assert.deepEqual(itemsViewsOf({ ZoteroPane: { itemsView: a } }), [a]);
  });

  test('a Zotero 11 window has one per library tab, not only the active one', () => {
    const pane = { itemsView: a, libraryViews: [{ itemsView: a }, { itemsView: b }] };
    assert.deepEqual(itemsViewsOf({ ZoteroPane: pane }), [a, b]);
  });

  test('skips a library tab that is unloaded, and a window with no library tab', () => {
    assert.deepEqual(itemsViewsOf({ ZoteroPane: { libraryViews: [{ itemsView: null }, { itemsView: b }] } }), [b]);
    assert.deepEqual(itemsViewsOf({ ZoteroPane: { itemsView: null, libraryViews: [] } }), []);
    assert.deepEqual(itemsViewsOf({}), []);
  });
});

describe('isLibraryTabEvent', () => {
  const lib = { t1: { type: 'library' } };
  const reader = { t1: { type: 'reader' } };

  test('matches a library tab being added, selected or loaded', () => {
    for (const event of ['add', 'select', 'load']) {
      assert.equal(isLibraryTabEvent(event, 'tab', ['t1'], lib), true, event);
    }
  });

  test('ignores reader tabs, closes and other notifier types', () => {
    assert.equal(isLibraryTabEvent('select', 'tab', ['t1'], reader), false);
    assert.equal(isLibraryTabEvent('close', 'tab', ['t1'], lib), false);
    assert.equal(isLibraryTabEvent('add', 'item', ['t1'], lib), false);
    assert.equal(isLibraryTabEvent('select', 'tab', ['t1'], undefined), false);
  });
});
