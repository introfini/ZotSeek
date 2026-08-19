#!/usr/bin/env node
/**
 * Type-check gate.
 *
 * esbuild strips TypeScript types without checking them, so `npm run build`
 * succeeds with type errors in the tree. This script runs `tsc --noEmit` and
 * compares the result against a recorded baseline of known-bad code, failing
 * only on errors that are new.
 *
 * Errors are compared by signature (file + TS code + message) with line and
 * column numbers stripped, so unrelated edits that shift lines around do not
 * produce spurious failures.
 *
 *   npm run typecheck            check against the baseline
 *   npm run typecheck -- --update  rewrite the baseline from the current tree
 */

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const rootDir = path.resolve(__dirname, '..');
const baselinePath = path.resolve(__dirname, 'typecheck-baseline.json');
const shouldUpdate = process.argv.slice(2).includes('--update');

/** `src/foo.ts(12,34): error TS2339: Message.` -> signature without position. */
function parseErrors(stdout) {
  const errors = [];
  for (const line of stdout.split('\n')) {
    const match = line.match(/^(.+?)\((\d+),(\d+)\): error (TS\d+): (.*)$/);
    if (!match) continue;
    const [, file, lineNo, , code, message] = match;
    errors.push({
      file: file.replace(/\\/g, '/'),
      code,
      message: message.trim(),
      signature: `${file.replace(/\\/g, '/')} ${code} ${message.trim()}`,
      reportedAt: lineNo,
    });
  }
  return errors;
}

function runTsc() {
  const result = spawnSync('npx', ['tsc', '--noEmit', '--project', 'tsconfig.test.json'], {
    cwd: rootDir,
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
  if (result.error) {
    console.error(`Could not run tsc: ${result.error.message}`);
    process.exit(2);
  }
  const output = `${result.stdout || ''}\n${result.stderr || ''}`;
  return { errors: parseErrors(output), status: result.status, output };
}

function byFile(errors) {
  const counts = {};
  for (const e of errors) counts[e.file] = (counts[e.file] || 0) + 1;
  return counts;
}

const { errors: current, status, output } = runTsc();

// tsc exits non-zero for problems that carry no file position at all -- a bad
// tsconfig, an unreadable file, a crash. Those produce no parseable error lines,
// so without this check the gate would report a clean run and pass. A gate that
// can silently pass is worse than no gate.
if (status !== 0 && current.length === 0) {
  console.error('tsc failed without reporting any file-level errors:\n');
  console.error(output.trim() || `(no output, exit code ${status})`);
  process.exit(2);
}

if (shouldUpdate) {
  const baseline = {
    comment:
      'Known type errors, tolerated so new ones can be detected. Regenerate with `npm run typecheck -- --update`. Shrink this list; never grow it deliberately.',
    generated: new Date().toISOString().slice(0, 10),
    total: current.length,
    signatures: current.map((e) => e.signature).sort(),
  };
  fs.writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`Baseline updated: ${current.length} known error(s) recorded.`);
  for (const [file, n] of Object.entries(byFile(current)).sort((a, b) => b[1] - a[1])) {
    console.log(`  ${n}  ${file}`);
  }
  process.exit(0);
}

if (!fs.existsSync(baselinePath)) {
  console.error(`No baseline at ${path.relative(rootDir, baselinePath)}.`);
  console.error('Create one with: npm run typecheck -- --update');
  process.exit(2);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, 'utf8'));
const known = new Set(baseline.signatures || []);

// A signature can legitimately occur more than once in a file, so compare
// multisets rather than sets: count occurrences on both sides.
const tally = (list) => list.reduce((m, s) => m.set(s, (m.get(s) || 0) + 1), new Map());
const currentTally = tally(current.map((e) => e.signature));
const baselineTally = tally(baseline.signatures || []);

const introduced = [];
for (const [sig, n] of currentTally) {
  const allowed = baselineTally.get(sig) || 0;
  if (n > allowed) {
    const example = current.find((e) => e.signature === sig);
    for (let i = 0; i < n - allowed; i++) introduced.push({ sig, example });
  }
}

const fixed = [];
for (const [sig, n] of baselineTally) {
  const still = currentTally.get(sig) || 0;
  if (still < n) fixed.push({ sig, count: n - still });
}

if (introduced.length > 0) {
  console.error(`\n${introduced.length} new type error(s) not in the baseline:\n`);
  for (const { sig, example } of introduced) {
    console.error(`  ${example.file}:${example.reportedAt}`);
    console.error(`    ${example.code}: ${example.message}`);
  }
  console.error('\nFix them, or if they are genuinely unavoidable record them with:');
  console.error('  npm run typecheck -- --update\n');
  process.exit(1);
}

console.log(`Type check clean: ${current.length} error(s), all known (baseline: ${baseline.total}).`);

if (fixed.length > 0) {
  const n = fixed.reduce((sum, f) => sum + f.count, 0);
  console.log(`\n${n} baseline error(s) no longer occur. Lock the improvement in with:`);
  console.log('  npm run typecheck -- --update');
  for (const { sig, count } of fixed) console.log(`  -${count}  ${sig.slice(0, 100)}`);
}
