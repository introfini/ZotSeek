import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { pickOwnPopupWindow, removeInjectedControls } from '../src/utils/progress-window-claim';

type FakeWindow = { name: string; closed: boolean };

const win = (name: string, closed = false): FakeWindow => ({ name, closed });

function pick(args: {
  preExisting: FakeWindow[];
  windows: FakeWindow[];
  claimed?: FakeWindow[];
  matches?: (w: FakeWindow) => boolean;
}): FakeWindow | null {
  const claimed = args.claimed ?? [];
  return pickOwnPopupWindow({
    preExisting: new Set(args.preExisting),
    windows: args.windows,
    isClaimed: (w) => claimed.includes(w),
    matches: args.matches ?? (() => true),
  });
}

describe('pickOwnPopupWindow', () => {
  test('returns null when every window predates the snapshot', () => {
    const main = win('main');
    const stale = win('stale-popup');
    assert.equal(pick({ preExisting: [main, stale], windows: [main, stale] }), null);
  });

  test('returns the single window that appeared after the snapshot', () => {
    const main = win('main');
    const ours = win('ours');
    assert.equal(pick({ preExisting: [main], windows: [main, ours] }), ours);
  });

  test('skips windows claimed by another instance', () => {
    const main = win('main');
    const theirs = win('theirs');
    const ours = win('ours');
    assert.equal(
      pick({ preExisting: [main], windows: [main, theirs, ours], claimed: [theirs] }),
      ours
    );
  });

  test('skips closed windows', () => {
    const main = win('main');
    const gone = win('gone', true);
    assert.equal(pick({ preExisting: [main], windows: [main, gone] }), null);
  });

  test('prefers the oldest new window when a foreign popup appeared later', () => {
    const main = win('main');
    const ours = win('ours');
    const foreign = win('foreign-opened-later');
    assert.equal(pick({ preExisting: [main], windows: [main, ours, foreign] }), ours);
  });

  test('applies the matches predicate', () => {
    const main = win('main');
    const foreign = win('foreign');
    const ours = win('ours');
    assert.equal(
      pick({
        preExisting: [main],
        windows: [main, foreign, ours],
        matches: (w) => w.name !== 'foreign',
      }),
      ours
    );
  });
});

describe('removeInjectedControls', () => {
  function fakeDoc(counts: { pause: number; cancel: number }) {
    const removed: string[] = [];
    const make = (id: string, i: number) => ({
      remove() {
        removed.push(`${id}#${i}`);
      },
    });
    const els: Record<string, Array<{ remove(): void }>> = {
      '#zotseek-pause-btn': Array.from({ length: counts.pause }, (_, i) => make('pause', i)),
      '#zotseek-cancel-btn': Array.from({ length: counts.cancel }, (_, i) => make('cancel', i)),
    };
    return {
      doc: { querySelectorAll: (sel: string) => els[sel] ?? [] },
      removed,
    };
  }

  test('removes every injected pause and cancel button, including duplicates', () => {
    const { doc, removed } = fakeDoc({ pause: 2, cancel: 2 });
    assert.equal(removeInjectedControls(doc), 4);
    assert.deepEqual(removed.sort(), ['cancel#0', 'cancel#1', 'pause#0', 'pause#1']);
  });

  test('returns 0 on a document without injected controls', () => {
    const { doc } = fakeDoc({ pause: 0, cancel: 0 });
    assert.equal(removeInjectedControls(doc), 0);
  });
});
