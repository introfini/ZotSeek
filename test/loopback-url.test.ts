import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
// Installs the Zotero stub as a side effect; must stay above the import below.
import { installZoteroStub } from './helpers/zotero-stub';
import {
  assertLoopbackUrl,
  parseAllowedRemoteHosts,
  isRemoteAllowedHost,
  ALLOWED_REMOTE_HOSTS_PREF,
} from '../src/core/loopback-url';

let zotero = installZoteroStub();
beforeEach(() => { zotero = installZoteroStub(); });

test('loopback hosts are allowed without configuration', () => {
  for (const url of ['http://127.0.0.1:1234', 'http://localhost:11434/v1/models', 'http://[::1]:8080']) {
    assert.doesNotThrow(() => assertLoopbackUrl(url));
  }
});

test('remote hosts are rejected by default', () => {
  assert.throws(() => assertLoopbackUrl('https://gpu01.example.org'), { code: 'LOOPBACK_REJECTED' });
});

test('an allowed remote host is accepted, others still rejected', () => {
  zotero.prefs.set(ALLOWED_REMOTE_HOSTS_PREF, 'gpu01.example.org');
  assert.equal(assertLoopbackUrl('https://gpu01.example.org/v1/embeddings').hostname, 'gpu01.example.org');
  assert.ok(isRemoteAllowedHost('gpu01.example.org'));
  assert.throws(() => assertLoopbackUrl('https://evil.com'), { code: 'LOOPBACK_REJECTED' });
  assert.throws(() => assertLoopbackUrl('https://gpu01.example.org.evil.com'), { code: 'LOOPBACK_REJECTED' });
});

test('credentials in the URL stay rejected for allowed hosts', () => {
  zotero.prefs.set(ALLOWED_REMOTE_HOSTS_PREF, 'gpu01.example.org');
  assert.throws(() => assertLoopbackUrl('https://u:p@gpu01.example.org'), { code: 'LOOPBACK_REJECTED' });
});

test('host list parsing normalizes schemes, ports, case and duplicates', () => {
  assert.deepEqual(
    parseAllowedRemoteHosts(' https://GPU01.Example.org:443/x, gpu01:11434 gpu01,, bad/host?x '),
    ['gpu01.example.org', 'gpu01', 'bad'],
  );
  assert.deepEqual(parseAllowedRemoteHosts(undefined), []);
  assert.deepEqual(parseAllowedRemoteHosts(''), []);
});
