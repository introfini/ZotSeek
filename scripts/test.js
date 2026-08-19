#!/usr/bin/env node
/**
 * Node test runner for the parts of the codebase that do not need Zotero.
 *
 * Most of this plugin can only be exercised inside Zotero, and that is what the
 * self-test harness in src/dev/ is for. But a few modules are pure logic, and
 * chunker.ts in particular decides what text ever reaches the embedding model,
 * so a silent regression there lowers search quality without failing anything.
 * Those modules are worth a sub-second feedback loop.
 *
 * Tests are TypeScript and import from ../src directly. esbuild (already a
 * dependency) bundles each test file to CommonJS in .test-build/, and Node's
 * built-in runner executes them. No test framework, no new dependencies.
 *
 *   npm test              run everything
 *   npm test -- chunker   run test files whose name matches
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const testDir = path.resolve(rootDir, 'test');
const outDir = path.resolve(rootDir, '.test-build');
const filter = process.argv.slice(2).find((a) => !a.startsWith('-'));

if (!fs.existsSync(testDir)) {
  console.error(`No test directory at ${testDir}`);
  process.exit(2);
}

let entries = fs
  .readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !filter || f.includes(filter))
  .map((f) => path.join(testDir, f));

if (entries.length === 0) {
  console.error(filter ? `No test files match "${filter}"` : 'No *.test.ts files found');
  process.exit(2);
}

// Rebuild from scratch: a stale bundle from a deleted test would still run.
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const build = spawnSync(
  'npx',
  [
    'esbuild',
    ...entries,
    '--bundle',
    '--platform=node',
    '--format=cjs',
    '--out-extension:.js=.cjs',
    `--outdir=${outDir}`,
    '--log-level=warning',
    // Node's own test module must stay external; bundling it would break the runner.
    '--external:node:test',
    '--external:node:assert',
  ],
  { cwd: rootDir, encoding: 'utf8', stdio: 'inherit', shell: process.platform === 'win32' },
);

if (build.status !== 0) {
  console.error('\nTest bundle failed to build.');
  process.exit(build.status || 1);
}

// Pass the bundles explicitly rather than the directory: `node --test <dir>`
// skips dot-directories, and .test-build is one.
const bundles = fs
  .readdirSync(outDir)
  .filter((f) => f.endsWith('.cjs'))
  .map((f) => path.join(outDir, f));

if (bundles.length === 0) {
  console.error('Nothing was bundled; no tests to run.');
  process.exit(1);
}

const run = spawnSync('node', ['--test', ...bundles], {
  cwd: rootDir,
  stdio: 'inherit',
});

process.exit(run.status === null ? 1 : run.status);
