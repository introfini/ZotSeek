/**
 * Polyfill banner prepended to the esbuild bundles.
 *
 * Transformers.js expects a browser-like environment (`self`, `navigator`).
 * The plugin's main-thread sandbox (bootstrap loadSubScript) lacks both, so
 * the banner fills them in there.
 *
 * The banner MUST NOT declare `var self` / `var navigator` at the top level:
 * in a worker, a top-level `var` creates an own binding on the global object
 * that shadows the native `WorkerGlobalScope.prototype` getters, replacing the
 * real `navigator` (with `gpu` and the true `hardwareConcurrency`) with the
 * fake below. That is why detection must go through `globalThis.<name>`,
 * which reads the inherited getter instead of hoisting a new binding.
 */
const polyfillBanner = `
// Polyfills for Transformers.js in Zotero's privileged context.
// Uses globalThis property checks (NOT top-level var declarations, which
// would shadow the native worker globals -- see scripts/polyfill-banner.js).
if (typeof globalThis.self === 'undefined') {
  globalThis.self = globalThis;
}
if (typeof globalThis.navigator === 'undefined') {
  globalThis.navigator = { userAgent: 'Zotero', hardwareConcurrency: 4 };
}
`;

module.exports = { polyfillBanner };
