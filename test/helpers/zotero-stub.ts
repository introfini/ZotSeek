/**
 * Minimal stand-in for the `Zotero` global.
 *
 * Some modules under test reach for `Zotero` while their module body is being
 * evaluated (a singleton constructed at import time, for example), so the stub
 * has to be installed on globalThis *before* the module is required, not just
 * before the function under test is called.
 *
 * Deliberately not a full mock. It exists so pure logic can be reached, not so
 * Zotero behaviour can be simulated: anything that genuinely depends on Zotero
 * belongs in the in-Zotero self-test harness under src/dev/ instead.
 */

export interface ZoteroStub {
  prefs: Map<string, unknown>;
  debugLog: string[];
  [key: string]: any;
}

export function installZoteroStub(prefs: Record<string, unknown> = {}): ZoteroStub {
  const store = new Map<string, unknown>(Object.entries(prefs));
  const debugLog: string[] = [];

  const stub: ZoteroStub = {
    prefs: store,
    debugLog,
    debug: (msg: string) => { debugLog.push(String(msg)); },
    logError: (e: unknown) => { debugLog.push(`ERROR ${String(e)}`); },
    Prefs: {
      get: (key: string) => store.get(key),
      set: (key: string, value: unknown) => { store.set(key, value); },
      clear: (key: string) => { store.delete(key); },
    },
    Items: {},
    Libraries: {},
  };

  (globalThis as any).Zotero = stub;
  return stub;
}

export function removeZoteroStub(): void {
  delete (globalThis as any).Zotero;
}

// Install on import, as a side effect.
//
// This is deliberate and load-bearing: `import` statements are hoisted, so a
// call to installZoteroStub() written above an import still runs *after* that
// import's module body. Modules that touch Zotero while being evaluated (the
// embedding pipeline builds a singleton in its constructor, for instance) would
// throw before any test code ran. Importing this module first is the only
// ordering that works, so tests should write:
//
//     import './helpers/zotero-stub';          // must come first
//     import { thing } from '../src/...';
//
// Tests that need a clean pref store call installZoteroStub() again in a hook.
installZoteroStub();
