/**
 * `console` does not exist in the scope the plugin runs in.
 *
 * bootstrap.js loads content/scripts/index.js through
 * Services.scriptloader.loadSubScript into a plain object scope that carries
 * Zotero, rootURI and document, and nothing else. Verified at runtime on
 * Zotero 10.0.3: in that scope `typeof console` is "undefined" and
 * `'console' in scope` is false, while the chrome context every debugging
 * tool runs in (Browser Toolbox, Run JavaScript, the MCP bridge) does have
 * one. That asymmetry is why this class of bug survives manual testing.
 *
 * A `console.*` call there throws ReferenceError. Inside a catch block it is
 * worse than useless: the catch exists to contain a failure, and the throw
 * escapes it, so a contained error becomes a fatal one. That is issue #54,
 * where one unreadable item aborted an entire library indexing run and the
 * user was shown "Indexing failed: console is not defined" in place of the
 * real error, whose stack was discarded by the same line.
 *
 * Node has a `console`, so the failure cannot be reproduced in this runner.
 * The rule is pinned statically instead, the same way the worker polyfill
 * banner is pinned in worker-polyfill.test.ts.
 *
 * Scope: only the module graph reachable from src/index.ts, which is the
 * bundle that ends up in that scope. The search dialog and the embedding
 * worker are separate bundles that run in a window and in a ChromeWorker
 * respectively, and both of those really do have a console.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = path.resolve(__dirname, '..');
const entry = path.join(rootDir, 'src', 'index.ts');

/** Resolve a relative import specifier to a file on disk, or null. */
function resolveImport(fromFile: string, spec: string): string | null {
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, path.join(base, 'index.ts')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Walk the relative-import graph from an entry point. Bare specifiers are
 * node_modules and are skipped: third-party code is not ours to police, and
 * the toolkit reaches for a console through its own guarded paths.
 */
function moduleGraph(entryFile: string): string[] {
  const seen = new Set<string>();
  const queue = [entryFile];

  while (queue.length) {
    const file = queue.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);

    const source = fs.readFileSync(file, 'utf8');
    const specifiers = [...source.matchAll(/(?:from|import)\s+['"](\.[^'"]+)['"]/g)];
    for (const [, spec] of specifiers) {
      const resolved = resolveImport(file, spec);
      if (resolved) queue.push(resolved);
    }
  }

  return [...seen];
}

/** Every `console.<something>` outside a comment, as "path:line". */
function consoleCalls(file: string): string[] {
  const hits: string[] = [];
  const lines = fs.readFileSync(file, 'utf8').split('\n');
  let inBlockComment = false;

  lines.forEach((line, i) => {
    const trimmed = line.trim();
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      return;
    }
    if (trimmed.startsWith('//')) return;
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      return;
    }
    if (/\bconsole\s*\./.test(line)) {
      hits.push(`${path.relative(rootDir, file)}:${i + 1}`);
    }
  });

  return hits;
}

test('the module graph reachable from src/index.ts is non-trivial', () => {
  // Guards the guard: a broken resolver would silently police nothing.
  const graph = moduleGraph(entry);
  assert.ok(graph.length > 15, `expected the main bundle graph, got ${graph.length} files`);
  assert.ok(
    graph.some((f) => f.endsWith('core/text-extractor.ts')),
    'text-extractor.ts should be reachable from the entry point',
  );
});

test('no source in the plugin-scope bundle calls console', () => {
  const offenders = moduleGraph(entry).flatMap(consoleCalls).sort();

  assert.deepEqual(
    offenders,
    [],
    `console is not defined in the plugin scope; use Zotero.debug or a Logger instead:\n  ${offenders.join('\n  ')}`,
  );
});
