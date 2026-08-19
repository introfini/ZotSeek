import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
// http-tools pulls in the search engine and the embedding pipeline, which touch
// the Zotero global while their module bodies are evaluated. This import
// installs the stub as a side effect and MUST stay above the one below: import
// hoisting means a function call here would run too late.
import './helpers/zotero-stub';
import { isAllowedOrigin } from '../src/server/http-tools';

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
