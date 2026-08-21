/**
 * The esbuild polyfill banner runs at the top level of every bundle,
 * including the embedding worker. In a worker global scope, `navigator`
 * is an accessor inherited from WorkerGlobalScope.prototype, not an own
 * property -- so a top-level `var navigator` hoists an own `undefined`
 * binding that shadows the real object, and the banner then replaces it
 * with a fake that has no `gpu` and a hardcoded `hardwareConcurrency`.
 * That single line silently disabled WebGPU detection and multi-core
 * WASM threading in the worker (issue #2).
 *
 * Node's vm (V8) does not reproduce SpiderMonkey's global-var shadowing
 * (V8 reuses the inherited binding and `typeof navigator` sees it), so
 * the mechanism itself is pinned by a static check: no top-level
 * `var self` / `var navigator` in the banner. The vm tests then pin the
 * required behavior: a worker-like global keeps its native navigator,
 * and a bare main-thread sandbox still gets `self` and a fallback
 * `navigator`.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';

const { polyfillBanner } = require('../scripts/polyfill-banner.js');

/** Build a vm context whose global inherits `navigator` from a prototype,
 *  the way WorkerGlobalScope.prototype provides it in a real worker. */
function workerLikeContext() {
  const workerNavigator = { userAgent: 'FakeWorker', hardwareConcurrency: 12, gpu: {} };
  const proto = {};
  Object.defineProperty(proto, 'navigator', {
    get() { return workerNavigator; },
    configurable: true,
  });
  const globalObj = Object.create(proto);
  const context = vm.createContext(globalObj);
  // vm contexts do not define globalThis on the sandbox object itself;
  // mirror what a real JS global does.
  vm.runInContext('this.globalThis = this;', context);
  return { context, workerNavigator };
}

test('banner preserves the native worker navigator (gpu, hardwareConcurrency)', () => {
  const { context, workerNavigator } = workerLikeContext();
  vm.runInContext(polyfillBanner, context);
  const nav = vm.runInContext('navigator', context);
  assert.equal(nav, workerNavigator, 'banner must not shadow or replace the inherited navigator');
  assert.ok(vm.runInContext("'gpu' in navigator", context), 'gpu must remain visible after the banner runs');
  assert.equal(vm.runInContext('navigator.hardwareConcurrency', context), 12);
});

test('banner does not hoist top-level var bindings for worker globals', () => {
  // The mechanism behind the bug: `var navigator` at the top level of a
  // classic script creates an own global binding even before assignment.
  assert.ok(!/\bvar\s+(navigator|self)\b/.test(polyfillBanner),
    'banner must not declare var self / var navigator at the top level');
});

test('banner still fills in self and navigator where they are missing', () => {
  const globalObj: any = {};
  const context = vm.createContext(globalObj);
  vm.runInContext('this.globalThis = this;', context);
  vm.runInContext(polyfillBanner, context);
  // Note: vm proxies the inner global, so identity must be checked inside.
  assert.ok(vm.runInContext('self === globalThis', context), 'self must be defined in a bare sandbox');
  const nav = vm.runInContext('navigator', context);
  assert.equal(nav.userAgent, 'Zotero');
  assert.equal(typeof nav.hardwareConcurrency, 'number');
});
