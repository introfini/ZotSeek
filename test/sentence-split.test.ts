/**
 * Splitting an oversized paragraph into sentences.
 *
 * The chunker did this with `text.match(/[^.!?]+[.!?]+/g) || [text]`, in three
 * places. On text with no `.`, `!` or `?` in it, that regex backtracks
 * quadratically, and past roughly 50,000 characters SpiderMonkey's regex stack
 * gives out and it throws `InternalError: too much recursion`.
 *
 * That is issue #54's underlying error, and the reporter's item turned out to
 * be a 99,841-character Python source file saved with the Zotero connector,
 * with zero `.`, `!` or `?` in the whole thing. Measured in Zotero 10.0.3:
 * 40,000 characters took 1.6s and survived, 55,000 threw. Anything whose
 * extracted text holds a paragraph that long without an ASCII sentence
 * terminator hits it, which includes source code, data dumps, CSV exports,
 * logs, and Chinese or Japanese text, whose terminators are `。！？` rather
 * than the ASCII ones.
 *
 * Node does not reproduce the throw (V8 grinds through the same input instead
 * of overflowing), so what is pinned here is the cost, with a margin of two
 * orders of magnitude, plus exact equivalence with the regex on every input
 * the regex survives. The equivalence is what makes replacing it safe:
 * including the fact that the regex drops whatever follows the last
 * terminator, which is preserved deliberately rather than quietly fixed
 * alongside a crash.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { splitIntoSentences } from '../src/utils/chunker';

/** What the chunker used to do, kept here as the oracle. */
function regexSplit(text: string): string[] {
  return text.match(/[^.!?]+[.!?]+/g) || [text];
}

const CASES = [
  '',
  ' ',
  'no terminators at all',
  'One sentence.',
  'Hello world. Second sentence! Third?',
  'Text after the last dot. is dropped by the regex',
  'a.b.c',
  '...',
  '!?.',
  'Multiple!!! Bangs??? Here.',
  'Line one.\nLine two.\n',
  'Ends with whitespace after dot.   ',
  '.leading terminator',
  'ünïcödé wörds with no terminator',
  '句子没有 ASCII 终止符',
];

test('splitIntoSentences agrees with the regex it replaces', () => {
  for (const input of CASES) {
    assert.deepEqual(
      splitIntoSentences(input),
      regexSplit(input),
      `disagreed on ${JSON.stringify(input)}`,
    );
  }
});

test('splitIntoSentences agrees with the regex on generated input', () => {
  // Deterministic pseudo-random strings over an alphabet that is mostly
  // ordinary characters with terminators sprinkled in, so both the
  // many-sentences and the no-terminator shapes get generated.
  const alphabet = 'aaaabbbcc   \n.!?';
  let seed = 12345;
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

  for (let i = 0; i < 500; i++) {
    const length = next() % 60;
    let s = '';
    for (let j = 0; j < length; j++) s += alphabet[next() % alphabet.length];
    assert.deepEqual(
      splitIntoSentences(s),
      regexSplit(s),
      `disagreed on ${JSON.stringify(s)}`,
    );
  }
});

test('splitIntoSentences stays linear on a large paragraph with no terminators', () => {
  // 100,000 characters is the shape that throws in Zotero. The regex needs
  // several seconds for it here; anything that does not backtrack needs
  // single-digit milliseconds, so this bound separates them by ~100x and is
  // not a timing race.
  const text = 'abcdefghij'.repeat(10_000);

  const started = Date.now();
  const sentences = splitIntoSentences(text);
  const elapsed = Date.now() - started;

  assert.deepEqual(sentences, [text]);
  assert.ok(elapsed < 300, `took ${elapsed}ms, which means it is still backtracking`);
});
