import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
// Installs the Zotero stub as a side effect; must stay above the import below.
import { installZoteroStub, removeZoteroStub, ZoteroStub } from './helpers/zotero-stub';
import {
  SEARCH_HISTORY_PREF,
  MAX_SEARCH_HISTORY,
  parseSearchHistory,
  addToSearchHistory,
  loadSearchHistory,
  recordSearchQuery,
  clearSearchHistory,
} from '../src/core/search-history';

let zotero: ZoteroStub = installZoteroStub();
beforeEach(() => { zotero = installZoteroStub(); });
afterEach(() => { removeZoteroStub(); });

describe('building the search history list', () => {
  test('adds a query to an empty history', () => {
    assert.deepEqual(addToSearchHistory([], 'graph neural networks'), ['graph neural networks']);
  });

  test('puts the newest query first', () => {
    const history = addToSearchHistory(['older'], 'newer');
    assert.deepEqual(history, ['newer', 'older']);
  });

  test('re-running an existing query moves it to the top instead of duplicating it', () => {
    // The whole point of the feature: a user reformulates the same question
    // several times, and the fourth phrasing must not push the first out of
    // the list by being listed twice.
    const history = addToSearchHistory(['c', 'b', 'a'], 'a');
    assert.deepEqual(history, ['a', 'c', 'b']);
  });

  test('keeps only the most recent entries, discarding the oldest', () => {
    let history: string[] = [];
    for (let i = 1; i <= MAX_SEARCH_HISTORY + 3; i++) {
      history = addToSearchHistory(history, `query ${i}`);
    }

    assert.equal(history.length, MAX_SEARCH_HISTORY);
    assert.equal(history[0], `query ${MAX_SEARCH_HISTORY + 3}`, 'newest first');
    assert.equal(history[history.length - 1], 'query 4', 'the three oldest fell off');
    assert.ok(!history.includes('query 1'));
  });

  test('never records an empty or whitespace-only query', () => {
    assert.deepEqual(addToSearchHistory(['kept'], ''), ['kept']);
    assert.deepEqual(addToSearchHistory(['kept'], '   '), ['kept']);
    assert.deepEqual(addToSearchHistory(['kept'], '\t\n '), ['kept']);
  });

  test('stores the query trimmed', () => {
    assert.deepEqual(addToSearchHistory([], '  spaced out  '), ['spaced out']);
  });

  test('a query differing only by surrounding whitespace is not a new entry', () => {
    const history = addToSearchHistory(['attention is all you need'], '  attention is all you need ');
    assert.deepEqual(history, ['attention is all you need']);
  });

  test('does not mutate the list it was given', () => {
    const original = ['a'];
    addToSearchHistory(original, 'b');
    assert.deepEqual(original, ['a']);
  });
});

describe('reading a stored history defensively', () => {
  // A preference holding JSON is user-editable and survives downgrades, so
  // every shape below has to yield a usable list rather than throw inside the
  // dialog's startup path.
  test('accepts a well-formed JSON array', () => {
    assert.deepEqual(parseSearchHistory('["b","a"]'), ['b', 'a']);
  });

  test('yields an empty history for malformed JSON', () => {
    assert.deepEqual(parseSearchHistory('{not json'), []);
    assert.deepEqual(parseSearchHistory('["unterminated'), []);
  });

  test('yields an empty history for a non-array value', () => {
    assert.deepEqual(parseSearchHistory('{"a":1}'), []);
    assert.deepEqual(parseSearchHistory('"just a string"'), []);
    assert.deepEqual(parseSearchHistory('42'), []);
    assert.deepEqual(parseSearchHistory('null'), []);
  });

  test('yields an empty history when the pref is missing or not a string', () => {
    assert.deepEqual(parseSearchHistory(undefined), []);
    assert.deepEqual(parseSearchHistory(null), []);
    assert.deepEqual(parseSearchHistory(''), []);
    assert.deepEqual(parseSearchHistory(7), []);
  });

  test('drops entries that are not usable queries', () => {
    assert.deepEqual(
      parseSearchHistory('["good", 3, null, "  ", {"q":"x"}, "  padded  "]'),
      ['good', 'padded'],
    );
  });

  test('drops duplicates left by an older build, keeping the first', () => {
    assert.deepEqual(parseSearchHistory('["a","b","a"]'), ['a', 'b']);
  });

  test('caps an over-long stored list', () => {
    const stored = JSON.stringify(
      Array.from({ length: MAX_SEARCH_HISTORY + 5 }, (_, i) => `q${i}`),
    );
    assert.equal(parseSearchHistory(stored).length, MAX_SEARCH_HISTORY);
  });
});

describe('persisting the history in a preference', () => {
  test('starts empty when nothing was ever stored', () => {
    assert.deepEqual(loadSearchHistory(), []);
  });

  test('records a query and reads it back', () => {
    recordSearchQuery('bayesian priors');
    assert.deepEqual(loadSearchHistory(), ['bayesian priors']);
    assert.equal(zotero.prefs.get(SEARCH_HISTORY_PREF), '["bayesian priors"]');
  });

  test('records queries newest first', () => {
    recordSearchQuery('first');
    recordSearchQuery('second');
    assert.deepEqual(loadSearchHistory(), ['second', 'first']);
  });

  test('does not write an empty query', () => {
    recordSearchQuery('   ');
    assert.deepEqual(loadSearchHistory(), []);
    assert.equal(zotero.prefs.has(SEARCH_HISTORY_PREF), false);
  });

  test('survives a corrupt stored value instead of throwing', () => {
    zotero.prefs.set(SEARCH_HISTORY_PREF, 'not json at all');
    assert.deepEqual(loadSearchHistory(), []);

    recordSearchQuery('recovered');
    assert.deepEqual(loadSearchHistory(), ['recovered']);
  });

  test('clearing empties both the list and the preference', () => {
    recordSearchQuery('something private');
    clearSearchHistory();
    assert.deepEqual(loadSearchHistory(), []);
    const stored = zotero.prefs.get(SEARCH_HISTORY_PREF);
    assert.ok(stored === undefined || stored === '[]', `pref left as ${String(stored)}`);
  });

  test('a failing preference store degrades to an empty history', () => {
    zotero.Prefs.get = () => { throw new Error('prefs unavailable'); };
    assert.deepEqual(loadSearchHistory(), []);
  });

  test('a failing preference write does not propagate to the caller', () => {
    zotero.Prefs.set = () => { throw new Error('prefs read-only'); };
    assert.doesNotThrow(() => recordSearchQuery('still fine'));
    assert.doesNotThrow(() => clearSearchHistory());
  });
});
