import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  estimateTokens,
  chunkDocument,
  chunkDocumentEx,
  createPageEstimationContext,
  estimatePageNumber,
  estimatePageForRange,
  countParagraphsUpTo,
  getChunkOptionsFromPrefs,
  getIndexingMode,
} from '../src/utils/chunker';

/**
 * Prose with real sentence boundaries. The chunker can only split an oversized
 * paragraph at sentence ends, so filler like 'x '.repeat(n) is NOT a valid
 * stand-in for body text: it produces one unsplittable chunk and would make
 * these assertions test the wrong thing.
 */
function paragraphs(count: number, sentencesEach = 12): string {
  const out: string[] = [];
  for (let p = 0; p < count; p++) {
    const sentences: string[] = [];
    for (let s = 0; s < sentencesEach; s++) {
      sentences.push(`Paragraph ${p} sentence ${s} discusses semantic retrieval over academic text.`);
    }
    out.push(sentences.join(' '));
  }
  return out.join('\n\n');
}

describe('estimateTokens', () => {
  test('counts whitespace-separated words at ~1.3 tokens each', () => {
    assert.equal(estimateTokens('one two three four five'), Math.ceil(5 * 1.3));
  });

  test('is zero for empty or whitespace-only input', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('   \n\n  '), 0);
  });

  test('collapses runs of whitespace rather than counting them as words', () => {
    assert.equal(estimateTokens('a    b\n\n\tc'), estimateTokens('a b c'));
  });
});

describe('chunkDocument, abstract mode', () => {
  test('produces exactly one summary chunk and ignores the fulltext', () => {
    const chunks = chunkDocument('A Title', 'An abstract long enough to be kept as its own text.', paragraphs(20), 'abstract');
    assert.equal(chunks.length, 1);
    assert.equal(chunks[0].type, 'summary');
    assert.match(chunks[0].text, /A Title/);
    assert.match(chunks[0].text, /An abstract long enough/);
  });

  test('falls back to the title alone when the abstract is too short to be useful', () => {
    // Under 50 characters the abstract is treated as noise and dropped.
    const chunks = chunkDocument('A Title', 'Too short.', null, 'abstract');
    assert.equal(chunks[0].text, 'A Title');
  });

  test('truncates a very long title instead of emitting it whole', () => {
    const chunks = chunkDocument('T'.repeat(500), null, null, 'abstract');
    assert.ok(chunks[0].text.length < 500, 'long title is cut down');
    assert.match(chunks[0].text, /\.\.\.$/, 'and marked as truncated');
  });
});

describe('chunkDocument, full mode', () => {
  test('emits the summary chunk first, then body chunks', () => {
    const chunks = chunkDocument('T', 'An abstract that is comfortably longer than fifty characters.', paragraphs(6), 'full');
    assert.ok(chunks.length > 1, 'body produced chunks beyond the summary');
    assert.equal(chunks[0].type, 'summary');
    assert.ok(chunks.slice(1).every((c) => c.type !== 'summary'), 'only one summary chunk');
  });

  test('numbers chunks consecutively from zero', () => {
    const chunks = chunkDocument('T', null, paragraphs(8), 'full');
    assert.deepEqual(chunks.map((c) => c.index), chunks.map((_, i) => i));
  });

  test('ignores fulltext under 500 characters as not meaningful', () => {
    const chunks = chunkDocument('T', null, 'Short body text.', 'full');
    assert.equal(chunks.length, 1, 'only the summary survives');
    assert.equal(chunks[0].type, 'summary');
  });

  test('treats maxTokens as a ceiling for splittable prose', () => {
    const { chunks } = chunkDocumentEx('T', null, paragraphs(10), 'full', { maxTokens: 150, maxChunks: 200 });
    const body = chunks.filter((c) => c.type !== 'summary');
    assert.ok(body.length > 1, 'prose was actually split');
    for (const c of body) {
      assert.ok(
        estimateTokens(c.text) <= 150,
        `chunk of ${estimateTokens(c.text)} tokens exceeds the 150 ceiling`,
      );
    }
  });

  test('respects the default character ceiling when no options are given', () => {
    // The explicit-option tests below would still pass if DEFAULT_OPTIONS were
    // widened, so exercise the no-options path that production uses too.
    const { chunks } = chunkDocumentEx('T', null, paragraphs(60), 'full');
    for (const c of chunks) {
      assert.ok(c.text.length <= 8000, `chunk of ${c.text.length} chars exceeds the default maxChars`);
    }
  });

  test('respects the default chunk cap when no options are given', () => {
    const { chunks } = chunkDocumentEx('T', null, paragraphs(400), 'full');
    assert.ok(chunks.length <= 100, `${chunks.length} chunks exceeds the default maxChunks of 100`);
  });

  test('never exceeds the hard character limit the embedding worker enforces', () => {
    // maxChars must match MAX_CHARS in the worker; a longer chunk would be
    // silently truncated at embedding time, or crash it.
    const { chunks } = chunkDocumentEx('T', null, paragraphs(30), 'full', { maxChars: 1000, maxChunks: 500 });
    for (const c of chunks) {
      assert.ok(c.text.length <= 1000, `chunk of ${c.text.length} chars exceeds maxChars`);
    }
  });
});

describe('chunk limit and truncation reporting', () => {
  test('reports wasTruncated when the cap cuts content short', () => {
    const { chunks, wasTruncated } = chunkDocumentEx('T', null, paragraphs(40), 'full', { maxTokens: 100, maxChunks: 3 });
    assert.equal(chunks.length, 3);
    assert.equal(wasTruncated, true);
  });

  test('does not claim truncation when everything fitted', () => {
    const { wasTruncated } = chunkDocumentEx('T', null, paragraphs(3), 'full', { maxTokens: 2000, maxChunks: 100 });
    assert.equal(wasTruncated, false);
  });
});

describe('page estimation', () => {
  test('calibrates chars-per-page from the real page count when Zotero supplies it', () => {
    const ctx = createPageEstimationContext(10_000, 5);
    assert.equal(ctx.charsPerPage, 2000);
  });

  test('falls back to a default when the page count is unknown or zero', () => {
    const unknown = createPageEstimationContext(10_000);
    const zero = createPageEstimationContext(10_000, 0);
    assert.equal(unknown.charsPerPage, zero.charsPerPage);
    assert.ok(unknown.charsPerPage > 0);
  });

  test('page numbers are 1-based and clamped to the document length', () => {
    const ctx = createPageEstimationContext(10_000, 5);
    assert.equal(estimatePageNumber(0, ctx), 1, 'offset 0 is page 1, not 0');
    assert.equal(estimatePageNumber(-50, ctx), 1, 'a negative offset cannot go below page 1');
    assert.equal(estimatePageNumber(2500, ctx), 2);
    assert.equal(estimatePageNumber(999_999, ctx), 5, 'clamped to totalPages');
  });

  test('a range is attributed to the page containing its midpoint', () => {
    const ctx = createPageEstimationContext(10_000, 5);
    // Midpoint 2500 lands on page 2 even though the range starts on page 1.
    assert.equal(estimatePageForRange(1000, 4000, ctx), 2);
  });

  test('counts paragraphs preceding a character position', () => {
    const text = 'first\n\nsecond\n\nthird';
    assert.equal(countParagraphsUpTo(text, 0), 0);
    assert.equal(countParagraphsUpTo(text, text.indexOf('second')), 1);
    assert.equal(countParagraphsUpTo(text, text.indexOf('third')), 2);
  });
});

describe('preference reading', () => {
  // These two take Zotero as an explicit argument, so they need no global stub.
  const fakeZotero = (prefs: Record<string, unknown>) => ({
    Prefs: { get: (k: string) => prefs[k] },
    debug: () => {},
  });

  test('reads chunk options from prefs', () => {
    const opts = getChunkOptionsFromPrefs(fakeZotero({
      'zotseek.maxTokens': 512,
      'zotseek.maxChunksPerPaper': 7,
    }));
    assert.equal(opts.maxTokens, 512);
    assert.equal(opts.maxChunks, 7);
  });

  test('falls back to the documented defaults when prefs are unset', () => {
    // Pinned, not just checked for plausibility. These are the values the
    // README and settings pane document, and they are what production actually
    // runs with whenever a pref is missing. maxChars in particular must match
    // MAX_CHARS in the embedding worker.
    const opts = getChunkOptionsFromPrefs(fakeZotero({}));
    assert.equal(opts.maxTokens, 2000);
    assert.equal(opts.maxChunks, 100);
    assert.equal(opts.maxChars, 8000);
  });

  test('ignores non-numeric pref values rather than passing them through', () => {
    const opts = getChunkOptionsFromPrefs(fakeZotero({
      'zotseek.maxTokens': 'lots',
      'zotseek.maxChunksPerPaper': null,
    }));
    assert.equal(opts.maxTokens, 2000);
    assert.equal(opts.maxChunks, 100);
  });

  test('recognises both indexing modes', () => {
    assert.equal(getIndexingMode(fakeZotero({ 'zotseek.indexingMode': 'abstract' })), 'abstract');
    assert.equal(getIndexingMode(fakeZotero({ 'zotseek.indexingMode': 'full' })), 'full');
  });

  test('falls back to abstract mode, NOT to the documented default of full', () => {
    // Pinning current behaviour, which contradicts the shipped default.
    // getIndexingMode is `mode === 'full' ? 'full' : 'abstract'`, written for
    // v1.0.0 when abstract was the default. The default became 'full' later
    // (src/index.ts) but this fallback was never updated, so a missing or
    // corrupt pref silently downgrades indexing to abstract-only, which is a
    // large and invisible search-quality loss.
    //
    // In practice the startup defaults loop sets the pref, so this only bites
    // when it is cleared or has an unexpected value. Change this test when the
    // fallback is fixed.
    assert.equal(getIndexingMode(fakeZotero({})), 'abstract');
    assert.equal(getIndexingMode(fakeZotero({ 'zotseek.indexingMode': 'nonsense' })), 'abstract');
    assert.equal(getIndexingMode(undefined), 'abstract');
  });
});
