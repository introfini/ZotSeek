import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { attachMinimizeFollower } from '../src/utils/minimize-follower';

// Minimal stand-in for a chrome window's sizemodechange surface
class FakeMainWindow {
  STATE_MINIMIZED = 2;
  windowState = 3; // normal
  private listeners: Array<() => void> = [];

  addEventListener(type: string, listener: () => void): void {
    if (type === 'sizemodechange') this.listeners.push(listener);
  }

  removeEventListener(type: string, listener: () => void): void {
    if (type === 'sizemodechange') {
      this.listeners = this.listeners.filter(l => l !== listener);
    }
  }

  fireSizeModeChange(newState: number): void {
    this.windowState = newState;
    for (const l of [...this.listeners]) l();
  }

  get listenerCount(): number {
    return this.listeners.length;
  }
}

describe('minimize follower', () => {
  let main: FakeMainWindow;
  let popup: { closed: boolean } | null;
  let calls: Array<{ win: unknown; visible: boolean }>;

  const deps = () => ({
    mainWindow: main,
    findPopupWindow: () => popup,
    setPopupVisible: (win: unknown, visible: boolean) => {
      calls.push({ win, visible });
    },
  });

  beforeEach(() => {
    main = new FakeMainWindow();
    popup = { closed: false };
    calls = [];
  });

  test('hides the popup when the main window minimizes', () => {
    attachMinimizeFollower(deps());
    main.fireSizeModeChange(2);

    assert.deepEqual(calls, [{ win: popup, visible: false }]);
  });

  test('shows the popup again when the main window is restored', () => {
    attachMinimizeFollower(deps());
    main.fireSizeModeChange(2);
    main.fireSizeModeChange(3);

    assert.deepEqual(calls, [
      { win: popup, visible: false },
      { win: popup, visible: true },
    ]);
  });

  test('detach() removes the listener and stops all visibility changes', () => {
    const detach = attachMinimizeFollower(deps());
    detach();
    main.fireSizeModeChange(2);

    assert.equal(calls.length, 0);
    assert.equal(main.listenerCount, 0);
  });

  test('self-detaches when the popup has closed', () => {
    attachMinimizeFollower(deps());
    popup = { closed: true };
    main.fireSizeModeChange(2);

    assert.equal(calls.length, 0);
    assert.equal(main.listenerCount, 0, 'listener must not leak after the popup is gone');
  });

  test('self-detaches when the popup can no longer be found', () => {
    attachMinimizeFollower(deps());
    popup = null;
    main.fireSizeModeChange(2);

    assert.equal(calls.length, 0);
    assert.equal(main.listenerCount, 0);
  });

  test('falls back to state 2 when the window has no STATE_MINIMIZED constant', () => {
    (main as any).STATE_MINIMIZED = undefined;
    attachMinimizeFollower(deps());
    main.fireSizeModeChange(2);

    assert.deepEqual(calls, [{ win: popup, visible: false }]);
  });

  test('detach() is safe to call twice', () => {
    const detach = attachMinimizeFollower(deps());
    detach();
    assert.doesNotThrow(() => detach());
  });
});
