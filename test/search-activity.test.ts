import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import {
  isSearchInProgress,
  trackSearch,
  __resetSearchActivity,
} from '../src/core/search-activity';

describe('search activity tracking', () => {
  beforeEach(() => __resetSearchActivity());

  test('reports nothing in progress when idle', () => {
    assert.equal(isSearchInProgress(), false);
  });

  test('reports a search in progress only while it runs', async () => {
    let observed: boolean | null = null;
    await trackSearch(async () => {
      observed = isSearchInProgress();
    });

    assert.equal(observed, true, 'flag must be set inside the search');
    assert.equal(isSearchInProgress(), false, 'flag must clear afterwards');
  });

  test('stays set until the last concurrent search finishes', async () => {
    // The MCP server can be answering an agent while the user searches in the
    // dialog; one finishing must not clear the other's flag.
    let releaseFirst!: () => void;
    const first = trackSearch(() => new Promise<void>(r => { releaseFirst = r; }));
    const second = trackSearch(async () => {});
    await second;

    assert.equal(isSearchInProgress(), true, 'the first search is still running');
    releaseFirst();
    await first;
    assert.equal(isSearchInProgress(), false);
  });

  test('clears the flag when the search throws', async () => {
    // A failed search that left the flag set would block idle compaction for
    // the rest of the session.
    await assert.rejects(trackSearch(async () => { throw new Error('boom'); }));

    assert.equal(isSearchInProgress(), false);
  });

  test('returns whatever the tracked search returned', async () => {
    assert.equal(await trackSearch(async () => 42), 42);
  });
});
