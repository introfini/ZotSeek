import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

const { diagnose } = require('../scripts/dev-install.js');

/** Everything agreeing: proxy in place, pointing at the build, Zotero in step. */
const healthy = {
  hasXpi: false,
  hasProxy: true,
  proxyTarget: '/repo/build',
  buildDir: '/repo/build',
  buildVersion: '1.21.0',
  registeredVersion: '1.21.0',
  registeredPath: '/repo/build',
};

describe('diagnose', () => {
  test('reports a healthy dev install', () => {
    assert.equal(diagnose(healthy).status, 'ok');
  });

  test('an installed XPI outranks every other finding', () => {
    // The XPI wins over the proxy inside Zotero, so it must win in the report
    // too: fixing anything else first would waste the developer's time.
    const d = diagnose({ ...healthy, hasXpi: true, proxyTarget: '/elsewhere', registeredVersion: '1.0.0' });
    assert.equal(d.status, 'xpi');
  });

  test('reports a missing install', () => {
    assert.equal(diagnose({ ...healthy, hasProxy: false }).status, 'not-installed');
  });

  test('reports a proxy pointing at another directory', () => {
    assert.equal(diagnose({ ...healthy, proxyTarget: '/some/other/build' }).status, 'wrong-target');
  });

  test('reports a stale registration when Zotero is behind the build', () => {
    // This is what silently installs the released XPI over the proxy: Zotero
    // keeps the version it first read, so update.json always looks newer.
    const d = diagnose({ ...healthy, registeredVersion: '1.20.0' });
    assert.equal(d.status, 'stale-registration');
    assert.equal(d.registeredVersion, '1.20.0');
    assert.equal(d.buildVersion, '1.21.0');
  });

  test('reports a stale registration when Zotero recorded another path', () => {
    assert.equal(
      diagnose({ ...healthy, registeredPath: '/an/old/checkout/build' }).status,
      'stale-registration',
    );
  });

  test('stays quiet when Zotero has never registered the plugin', () => {
    // First run after dev:install, before Zotero has started: there is no
    // registration to be stale, and warning about it would be noise.
    assert.equal(
      diagnose({ ...healthy, registeredVersion: null, registeredPath: null }).status,
      'ok',
    );
  });
});
