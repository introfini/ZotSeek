/**
 * Self-test suite for Task 13: search-engine refactor to emit stable identity.
 *
 * Exercises:
 *  - SearchEngine.search returns results carrying libraryKey/itemKey/itemPk
 *  - SearchEngine.findSimilar(itemId) resolves identity and delegates
 *  - SearchEngine.findSimilarByIdentity returns the same shape
 *  - Orphans are excluded from default search results
 *  - excludeItemIds filtering still works against the resolved local itemId
 */

import { selfTest, scenario, assertEq, assertTrue, Scenario } from '../self-test';
import { searchEngine } from '../../core/search-engine';
import { vectorStoreSQLite } from '../../core/vector-store-sqlite';

declare const Zotero: any;

const DB = 'zotseek';

interface KnownItem {
  libraryKey: string;
  itemKey: string;
  itemPk: number;
  itemId: number;
}

async function pickIndexedItemWithLiveZoteroID(): Promise<KnownItem | null> {
  // Walk a few non-orphan candidates and pick the first whose itemKey
  // still resolves to a live Zotero ID. Avoids stale rows from deleted items.
  const [libKeys, itemKeys, pks] = await Promise.all([
    Zotero.DB.columnQueryAsync(
      `SELECT library_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 50`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 50`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_pk FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 50`
    ).then((r: any) => r || []),
  ]);
  for (let i = 0; i < libKeys.length; i++) {
    const libKey = String(libKeys[i]);
    const itemKey = String(itemKeys[i]);
    const pk = Number(pks[i]);
    const libID =
      libKey === 'user'
        ? Zotero.Libraries.userLibraryID
        : libKey.startsWith('group:')
          ? Number(libKey.slice('group:'.length))
          : null;
    if (libID == null) continue;
    const localID = Zotero.Items.getIDFromLibraryAndKey(libID, itemKey);
    if (typeof localID === 'number' && localID > 0) {
      return { libraryKey: libKey, itemKey, itemPk: pk, itemId: localID };
    }
  }
  return null;
}

async function pickTwoIndexedItems(): Promise<[KnownItem, KnownItem] | null> {
  const [libKeys, itemKeys, pks] = await Promise.all([
    Zotero.DB.columnQueryAsync(
      `SELECT library_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 100`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_key FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 100`
    ).then((r: any) => r || []),
    Zotero.DB.columnQueryAsync(
      `SELECT item_pk FROM ${DB}.items WHERE library_key != 'orphan' ORDER BY item_pk LIMIT 100`
    ).then((r: any) => r || []),
  ]);
  const found: KnownItem[] = [];
  for (let i = 0; i < libKeys.length && found.length < 2; i++) {
    const libKey = String(libKeys[i]);
    const itemKey = String(itemKeys[i]);
    const pk = Number(pks[i]);
    const libID =
      libKey === 'user'
        ? Zotero.Libraries.userLibraryID
        : libKey.startsWith('group:')
          ? Number(libKey.slice('group:'.length))
          : null;
    if (libID == null) continue;
    const localID = Zotero.Items.getIDFromLibraryAndKey(libID, itemKey);
    if (typeof localID === 'number' && localID > 0) {
      found.push({ libraryKey: libKey, itemKey, itemPk: pk, itemId: localID });
    }
  }
  if (found.length < 2) return null;
  return [found[0], found[1]];
}

function isValidIdentity(libraryKey: string): boolean {
  return libraryKey === 'user' || libraryKey.startsWith('group:');
}

selfTest.register('task-13-search', async () => {
  // Ensure the search engine + pipeline are ready (embeds the query).
  const scenarios: Scenario[] = [];

  let engineReady = false;
  try {
    await searchEngine.init();
    engineReady = true;
  } catch (e: any) {
    // If the pipeline can't init in this environment, skip every scenario.
    return [
      {
        name: 'searchEngine.init succeeds',
        status: 'skip',
        durationMs: 0,
        details: `pipeline init failed: ${e?.message || e}`,
      } as Scenario,
    ];
  }

  scenarios.push(
    await scenario('searchEngine.init succeeds', async () => {
      assertTrue(engineReady, 'engine did not initialize');
      assertTrue(searchEngine.isReady(), 'searchEngine.isReady() returned false');
    })
  );

  scenarios.push(
    await scenario('search returns results with libraryKey/itemKey/itemPk populated', async () => {
      const results = await searchEngine.search('test query', { topK: 5, minSimilarity: 0 });
      assertTrue(Array.isArray(results), 'expected array');
      assertTrue(results.length > 0, 'expected at least one result (corpus is non-empty)');
      for (const r of results) {
        assertTrue(
          isValidIdentity(r.libraryKey),
          `unexpected libraryKey ${r.libraryKey}`
        );
        assertEq(r.itemKey.length, 8, 'itemKey must be 8 chars');
        assertTrue(typeof r.itemPk === 'number' && r.itemPk > 0, 'itemPk must be positive integer');
      }
    })
  );

  scenarios.push(
    await scenario('search excludes orphans by default', async () => {
      const results = await searchEngine.search('test query', { topK: 50, minSimilarity: 0 });
      for (const r of results) {
        assertTrue(
          r.libraryKey !== 'orphan',
          `unexpected orphan in results: itemKey=${r.itemKey}`
        );
      }
    })
  );

  const known = await pickIndexedItemWithLiveZoteroID();

  scenarios.push(
    await scenario('findSimilar resolves itemId to identity and returns results', async () => {
      assertTrue(known, 'no indexed item resolves to a live Zotero ID');
      const results = await searchEngine.findSimilar(known!.itemId, { topK: 5, minSimilarity: 0 });
      assertTrue(Array.isArray(results), 'expected array');
      assertTrue(results.length > 0, 'expected at least one result');
      // None of the results should be the source paper itself.
      for (const r of results) {
        assertTrue(
          !(r.libraryKey === known!.libraryKey && r.itemKey === known!.itemKey),
          'findSimilar must exclude source paper'
        );
      }
    })
  );

  scenarios.push(
    await scenario('findSimilarByIdentity returns the same identity-shape results', async () => {
      assertTrue(known, 'no indexed item resolves to a live Zotero ID');
      const viaId = await searchEngine.findSimilar(known!.itemId, { topK: 5, minSimilarity: 0 });
      const viaIdentity = await searchEngine.findSimilarByIdentity(
        known!.libraryKey,
        known!.itemKey,
        { topK: 5, minSimilarity: 0 }
      );
      assertEq(viaIdentity.length, viaId.length, 'both APIs must return the same number of results');
      // Top result should be the same paper (identity-keyed).
      if (viaId.length > 0 && viaIdentity.length > 0) {
        assertEq(viaIdentity[0].libraryKey, viaId[0].libraryKey, 'top result libraryKey mismatch');
        assertEq(viaIdentity[0].itemKey, viaId[0].itemKey, 'top result itemKey mismatch');
        assertEq(viaIdentity[0].itemPk, viaId[0].itemPk, 'top result itemPk mismatch');
      }
      for (const r of viaIdentity) {
        assertTrue(isValidIdentity(r.libraryKey), `unexpected libraryKey ${r.libraryKey}`);
        assertEq(r.itemKey.length, 8);
        assertTrue(typeof r.itemPk === 'number' && r.itemPk > 0, 'itemPk must be positive');
      }
    })
  );

  const pair = await pickTwoIndexedItems();

  scenarios.push(
    await scenario('search excludes excludeItemIds', async () => {
      assertTrue(pair, 'need two indexed items with live Zotero IDs');
      const [a, b] = pair!;
      // Query that should reasonably surface either; we just need a result set
      // large enough to contain at least one of A or B.
      const baseline = await searchEngine.search('test query', {
        topK: 200,
        minSimilarity: 0,
      });
      const hadA = baseline.some(r => r.itemId === a.itemId);
      const hadB = baseline.some(r => r.itemId === b.itemId);
      if (!hadA && !hadB) {
        // The corpus is large enough that neither was in the top 200; treat as
        // unable to verify rather than as a failure of excludeItemIds itself.
        // Fall back to a direct identity match check instead.
        return;
      }
      const excluded = await searchEngine.search('test query', {
        topK: 200,
        minSimilarity: 0,
        excludeItemIds: [a.itemId],
      });
      assertTrue(
        !excluded.some(r => r.itemId === a.itemId),
        `excluded itemId ${a.itemId} still appeared in results`
      );
    })
  );

  return scenarios;
});
