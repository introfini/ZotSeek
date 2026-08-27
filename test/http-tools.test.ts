import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// http-tools pulls in the search engine and the embedding pipeline, which touch
// the Zotero global while their module bodies are evaluated. This import
// installs the stub as a side effect and MUST stay above the one below: import
// hoisting means a function call here would run too late.
import './helpers/zotero-stub';
import { isAllowedOrigin, componentScores } from '../src/server/http-tools';

// Only the pure guard is exercised here; the search tools themselves need a
// real index and live in the in-Zotero suite (src/dev/suites/mcp-server.ts).

describe('isAllowedOrigin', () => {
  test('accepts a request with no Origin header at all', () => {
    // curl and other non-browser clients send none; Zotero's own gate handles
    // browser traffic before the endpoint is reached.
    assert.equal(isAllowedOrigin(undefined), true);
    assert.equal(isAllowedOrigin(null), true);
    assert.equal(isAllowedOrigin(''), true);
  });

  test('accepts every loopback spelling, with and without a port', () => {
    for (const origin of [
      'http://localhost',
      'http://localhost:23119',
      'https://localhost:3000',
      'http://127.0.0.1',
      'http://127.0.0.1:8080',
      'http://[::1]',
      'http://[::1]:23119',
    ]) {
      assert.equal(isAllowedOrigin(origin), true, `${origin} should be allowed`);
    }
  });

  test('is case-insensitive on the scheme and host', () => {
    assert.equal(isAllowedOrigin('HTTP://LOCALHOST:23119'), true);
  });

  test('rejects remote origins', () => {
    for (const origin of ['https://evil.example', 'http://192.168.1.10', 'https://zotero.org']) {
      assert.equal(isAllowedOrigin(origin), false, `${origin} should be rejected`);
    }
  });

  test('rejects hosts that merely embed a loopback name', () => {
    // The guard must anchor, or `localhost.evil.com` would pass as local.
    for (const origin of [
      'http://localhost.evil.example',
      'http://notlocalhost',
      'http://127.0.0.1.evil.example',
      'https://evil.example/?x=http://localhost',
    ]) {
      assert.equal(isAllowedOrigin(origin), false, `${origin} should be rejected`);
    }
  });

  test('rejects non-http schemes pointing at loopback', () => {
    assert.equal(isAllowedOrigin('file://localhost'), false);
    assert.equal(isAllowedOrigin('ws://localhost:23119'), false);
  });
});

describe('componentScores', () => {
  test('reports both legs, rounded to three decimals', () => {
    // A consumer merging several searches needs a comparable number; the fused
    // RRF score is only meaningful inside one result set.
    assert.deepEqual(
      componentScores({ semanticScore: 0.7712345, keywordScore: 0.4204 }),
      { semanticScore: 0.771, keywordScore: 0.42 },
    );
  });

  test('reports null for the leg that did not contribute', () => {
    assert.deepEqual(
      componentScores({ semanticScore: 0.5, keywordScore: null }),
      { semanticScore: 0.5, keywordScore: null },
    );
    assert.deepEqual(
      componentScores({ semanticScore: null, keywordScore: 0.5 }),
      { semanticScore: null, keywordScore: 0.5 },
    );
  });

  test('keeps a genuine zero as zero, not as "did not contribute"', () => {
    // A chunk orthogonal to the query scores 0. Reporting that as null would
    // claim the semantic leg never saw the item, which is a different fact.
    assert.deepEqual(
      componentScores({ semanticScore: 0, keywordScore: 0 }),
      { semanticScore: 0, keywordScore: 0 },
    );
  });
});
