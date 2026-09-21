/**
 * What happens to a "sentence" longer than the hard character limit.
 *
 * `splitChunkByCharLimit` capped such a sentence with
 * `sentence.substring(0, availableChars)` and moved on, so everything past
 * the first 8,000 characters of it was discarded. Nothing recorded the loss:
 * the item was written with `was_truncated = 0` and every later run skipped
 * it as already indexed.
 *
 * Measured in Zotero on the item from #54, a 99,244-character source file:
 * 24,038 characters reached the index, 76% was dropped, and the item reported
 * itself fully indexed.
 *
 * This is not really about source code. A sentence only exceeds 8,000
 * characters when the text has no sentence boundaries in it, which is also
 * true of tables lifted out of PDFs, data appendices, bad OCR, and Chinese or
 * Japanese text, whose terminators are `。！？` rather than the ASCII ones the
 * chunker looks for.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chunkDocumentEx } from '../src/utils/chunker';

const MAX_CHARS = 8000;

/** Body text with no sentence terminator anywhere, as one paragraph. */
function unbrokenText(chars: number): string {
  return 'abcdefghij klmnopqrst '.repeat(Math.ceil(chars / 22)).slice(0, chars);
}

/** Everything the chunks hold, with each chunk's repeated title prefix removed. */
function indexedBody(chunks: Array<{ text: string }>, title: string): string {
  return chunks
    .map((c) => (c.text.startsWith(`${title}\n\n`) ? c.text.slice(title.length + 2) : c.text))
    .join('');
}

test('a paragraph with no sentence boundaries is not cut down to one chunk', () => {
  const title = 'A Paper';
  const body = unbrokenText(50_000);

  const { chunks } = chunkDocumentEx(title, null, body, 'full', { maxChars: MAX_CHARS });

  const bodyChunks = chunks.filter((c) => c.type !== 'summary');
  assert.ok(
    bodyChunks.length >= 6,
    `50,000 characters at ${MAX_CHARS} per chunk needs at least 6 chunks, got ${bodyChunks.length}`,
  );
});

test('no text is dropped when a paragraph has no sentence boundaries', () => {
  const title = 'A Paper';
  const body = unbrokenText(50_000);

  const { chunks } = chunkDocumentEx(title, null, body, 'full', { maxChars: MAX_CHARS });

  const kept = indexedBody(chunks.filter((c) => c.type !== 'summary'), title);
  // Chunk text is trimmed at the edges, so compare without whitespace.
  assert.equal(
    kept.replace(/\s+/g, ''),
    body.replace(/\s+/g, ''),
    'characters went missing between the source text and the chunks',
  );
});

test('every chunk still respects the hard character limit', () => {
  const { chunks } = chunkDocumentEx('A Paper', null, unbrokenText(50_000), 'full', {
    maxChars: MAX_CHARS,
  });

  const tooLong = chunks.filter((c) => c.text.length > MAX_CHARS);
  assert.deepEqual(tooLong.map((c) => c.text.length), []);
});

test('hitting the chunk ceiling is still reported as truncated', () => {
  // The ceiling is the honest way to lose text: the caller is told.
  const { chunks, wasTruncated } = chunkDocumentEx(
    'A Paper', null, unbrokenText(200_000), 'full', { maxChars: MAX_CHARS, maxChunks: 5 },
  );

  assert.equal(chunks.length, 5);
  assert.equal(wasTruncated, true);
});

test('slicing an oversized run never splits a surrogate pair', () => {
  // A hard cut at a code-unit boundary can leave half of an astral character
  // at the end of one chunk and half at the start of the next, which is not
  // valid text and goes straight to the embedding model. Astral characters
  // are ordinary in the scripts most likely to reach this path at all.
  const body = '𝄞'.repeat(20_000); // 2 code units each, no sentence terminators

  const { chunks } = chunkDocumentEx('A Paper', null, body, 'full', { maxChars: MAX_CHARS });

  const lone = chunks.filter((c) => /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?:^|[^\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(c.text));
  assert.deepEqual(lone.map((c) => c.index), [], 'a chunk ended or began mid-character');
});
