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
 * orders of magnitude, plus the contract the splitter has to keep.
 *
 * That contract is deliberately NOT "whatever the regex did". The regex
 * dropped everything after the last terminator, and while that costs 0.15% of
 * an oversized paragraph in a measured sample of real PDFs, it costs
 * everything on the documents this code path exists for: 90,000 characters
 * with one `.` near the start indexed 11 characters. Losing text silently is
 * the defect, not a behaviour worth preserving, so the splitter is pinned on
 * losing nothing instead.
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

test('splitIntoSentences loses nothing', () => {
  for (const input of CASES) {
    assert.equal(
      splitIntoSentences(input).join(''),
      input,
      `text went missing splitting ${JSON.stringify(input)}`,
    );
  }
});

test('splitIntoSentences breaks only after a terminator', () => {
  for (const input of CASES) {
    const parts = splitIntoSentences(input);
    // Every part but the last ends the sentence it carries; the last part is
    // whatever followed the final terminator, which has no boundary of its own.
    for (const part of parts.slice(0, -1)) {
      assert.match(part, /[.!?]$/, `${JSON.stringify(part)} does not end a sentence`);
    }
  }
});

test('splitIntoSentences keeps the text after the last terminator', () => {
  // The regex dropped this. On a document whose terminators all sit near the
  // start, that is the whole document.
  assert.deepEqual(splitIntoSentences('Header line. ' + 'x'.repeat(50)), [
    'Header line.',
    ' ' + 'x'.repeat(50),
  ]);
  assert.deepEqual(regexSplit('Header line. ' + 'x'.repeat(50)), ['Header line.']);
});

test('splitIntoSentences still matches the regex wherever the regex kept everything', () => {
  for (const input of CASES.filter((c) => /[.!?]\s*$/.test(c) && c.trim())) {
    assert.deepEqual(
      splitIntoSentences(input).filter((p) => /[.!?]$/.test(p)),
      regexSplit(input),
      `disagreed on ${JSON.stringify(input)}`,
    );
  }
});

test('splitIntoSentences loses nothing on generated input either', () => {
  // Deterministic pseudo-random strings over an alphabet that is mostly
  // ordinary characters with terminators sprinkled in, so both the
  // many-sentences and the no-terminator shapes get generated.
  const alphabet = 'aaaabbbcc   \n.!?';
  let seed = 12345;
  // The high bits, not the low ones: in a linear congruential generator with a
  // power-of-two modulus the low bits cycle with a tiny period, so `next() % 16`
  // produced almost the same character every time and this test was generating
  // strings of 'a' with no terminator in them at all.
  const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);
  const roll = (n: number) => (next() >>> 15) % n;

  for (let i = 0; i < 500; i++) {
    const length = roll(60);
    let s = '';
    for (let j = 0; j < length; j++) s += alphabet[roll(alphabet.length)];

    const parts = splitIntoSentences(s);
    const where = JSON.stringify(s);

    assert.equal(parts.join(''), s, `text went missing splitting ${where}`);

    for (const part of parts.slice(0, -1)) {
      assert.match(part, /[.!?]$/, `${JSON.stringify(part)} does not end a sentence, in ${where}`);
    }

    // Each part is one sentence: terminators appear only in the run that ends
    // it, or in a leading run that the previous break could not carry. Only
    // the first part can have a leading run, and only at the start of the
    // text, where there is no previous sentence to attach it to.
    for (const part of parts) {
      assert.match(part, /^[.!?]*[^.!?]*[.!?]*$/, `${JSON.stringify(part)} holds more than one sentence, in ${where}`);
    }
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
