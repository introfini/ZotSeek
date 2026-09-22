/**
 * Chinese and Japanese text has no spaces between words, and the chunker's
 * token estimate counted whitespace-separated words. A 1,500-character
 * Chinese paragraph therefore estimated at 2 tokens, sat under the
 * MIN_PARA_TOKENS gate (15) and was dropped without setting any truncation
 * flag, so the item was recorded as fully indexed (issue #60).
 *
 * Measured on the reporter's sample PDF as Zotero 10.0.3's PDFWorker returns
 * it: the page whose text layer carries a space at every punctuation mark kept
 * 534 of 534 CJK characters, the page without them kept 309, and a page whose
 * lines were not joined with spaces at all (the CNKI-style layers the report
 * describes) kept 0. Across the reporter's library, 498 of 1,444 items had
 * 10-23% of their page text in the index.
 *
 * The estimate feeds three gates, and the sentence splitter only knew the
 * ASCII terminators, so an oversized CJK paragraph that the fixed estimate
 * now routes to the sentence path would have been one unsplittable sentence.
 * Both are pinned here.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { estimateTokens, splitIntoSentences, chunkDocumentWithPagesEx } from '../src/utils/chunker';

const SENTENCES = [
  '社会资本理论认为行动者所嵌入的社会网络结构能够为其带来信息影响力与信任等多重资源。',
  '在中国社会的人情互惠实践中，关系认同构成了社会资本运作的微观基础，而组织内部的强连带通过情感支持与资源互换促进了知识转移。',
  '研究采用问卷调查与结构方程模型检验了社会资本各维度对知识共享质量的作用机制，发现结构维度关系维度与认知维度均产生显著的正向影响，这一结论与既有文献的理论预期保持一致。',
];
const PARAGRAPH = SENTENCES.join('').repeat(3); // 534 CJK characters, no ASCII whitespace

const CJK = /[㐀-鿿　-〿＀-￯]/g;
const cjkCount = (s: string) => (s.match(CJK) || []).length;

/**
 * Page text as Zotero's PDFWorker returned the sample PDF: the heading on its
 * own line, then the body with each 40-character line joined by a space.
 */
function pdfWorkerPage(n: number, body: string, joinLinesWith: string): string {
  const lines: string[] = [];
  for (let i = 0; i < body.length; i += 40) lines.push(body.slice(i, i + 40));
  return `Sample Page ${n}: CJK paragraph handling\n${lines.join(joinLinesWith)}`;
}

describe('estimateTokens on CJK text', () => {
  test('counts each CJK character as a token', () => {
    assert.equal(estimateTokens('汉字'.repeat(20)), 40);
  });

  test('a 1,500-character Chinese paragraph is nowhere near the 15-token gate', () => {
    assert.ok(estimateTokens(SENTENCES[0].repeat(40)) > 1000);
  });

  test('adds CJK characters to the word estimate of the Latin text around them', () => {
    // 4 CJK characters plus one Latin word at 1.3 tokens.
    assert.equal(estimateTokens('社会资本 theory'), 4 + Math.ceil(1.3));
  });

  test('does not count a CJK character both as a character and as a word', () => {
    assert.equal(estimateTokens('资源。'), 3);
  });

  test('leaves the English estimate exactly where it was', () => {
    assert.equal(estimateTokens('one two three four five'), Math.ceil(5 * 1.3));
  });
});

describe('splitIntoSentences on CJK terminators', () => {
  test('splits at 。！？ and keeps every character', () => {
    const text = '第一句。第二句！第三句？';
    assert.deepEqual(splitIntoSentences(text), ['第一句。', '第二句！', '第三句？']);
    assert.equal(splitIntoSentences(text).join(''), text);
  });

  test('keeps the tail after the last CJK terminator', () => {
    assert.deepEqual(splitIntoSentences('第一句。没有句号的结尾'), ['第一句。', '没有句号的结尾']);
  });

  test('treats a run of mixed terminators as one boundary', () => {
    assert.deepEqual(splitIntoSentences('真的？！是的。'), ['真的？！', '是的。']);
  });
});

describe('chunkDocumentWithPagesEx on Chinese pages', () => {
  const opts = { maxTokens: 2000, maxChunks: 100, maxChars: 8000 };

  for (const [label, joiner] of [['spaces', ' '], ['nothing', '']] as const) {
    test(`keeps every CJK character of a page whose lines are joined with ${label}`, () => {
      const page = { pageNumber: 1, text: pdfWorkerPage(1, PARAGRAPH, joiner) };
      const result = chunkDocumentWithPagesEx('Test title', '', [page], 'full', opts);
      const body = result.chunks.filter(c => c.type !== 'summary');
      const kept = body.reduce((n, c) => n + cjkCount(c.text), 0);
      assert.equal(kept, cjkCount(page.text), `kept ${kept} of ${cjkCount(page.text)} CJK characters`);
      assert.equal(result.wasTruncated, false);
    });
  }

  test('cuts the sliding window at a CJK sentence end rather than mid-sentence', () => {
    const page = { pageNumber: 1, text: pdfWorkerPage(1, PARAGRAPH, '') };
    const body = chunkDocumentWithPagesEx('Test title', '', [page], 'full', opts).chunks
      .filter(c => c.type !== 'summary');
    assert.ok(body.length >= 2, 'a 534-character page should produce more than one window');
    for (const c of body) {
      assert.match(c.text.trimEnd(), /[。！？]$/, `chunk ends mid-sentence: ${JSON.stringify(c.text.slice(-20))}`);
    }
  });

  test('splits an oversized CJK paragraph at sentence ends and loses nothing', () => {
    const big = SENTENCES.join('').repeat(20); // ~3,500 characters, one paragraph
    const page = { pageNumber: 1, text: `标题\n\n${big}\n\n${big}` };
    const result = chunkDocumentWithPagesEx('Test title', '', [page], 'full', { ...opts, maxTokens: 500 });
    const body = result.chunks.filter(c => c.type !== 'summary');
    assert.ok(body.length >= 14, `expected the two paragraphs to split into many chunks, got ${body.length}`);
    for (const c of body) {
      assert.ok(cjkCount(c.text) <= 500, `chunk of ${cjkCount(c.text)} CJK characters exceeds the 500-token ceiling`);
      assert.match(c.text.trimEnd(), /[。！？]$/, 'chunk ends mid-sentence');
    }
    assert.equal(body.reduce((n, c) => n + cjkCount(c.text), 0), cjkCount(big) * 2);
  });
});
