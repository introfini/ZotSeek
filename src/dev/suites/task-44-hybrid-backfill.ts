/**
 * Self-test suite for issue #44: back-filling keyword-only hybrid hits.
 *
 * The keyword leg of hybrid search matches at item level, so before the fix its
 * results carried no chunk and no similarity. Two consequences, both exercised
 * here against the real library:
 *
 *  - `minSimilarity` filtered only the semantic leg, so raising it removed the
 *    grounded results and kept the ungrounded ones.
 *  - keyword-only hits had nothing citable, which is a poor answer from an API
 *    whose purpose is grounding.
 *
 * The pure scoring and filtering logic is unit-tested in Node
 * (test/keyword-backfill.test.ts); this suite covers the wiring that only
 * exists inside Zotero.
 */

import { selfTest, scenario, assertTrue, assertEq } from '../self-test';
import { HybridSearchEngine, HybridSearchResult } from '../../core/hybrid-search';
import { searchEngine } from '../../core/search-engine';
import { embeddingPipeline } from '../../core/embedding-pipeline';

declare const Zotero: any;

const DB = 'zotseek';

/**
 * Build an entity-like query from a real indexed item: a creator surname plus a
 * year. That is the query shape the issue measured at 90% keyword-only hits,
 * and it does not depend on any particular library's subject matter.
 */
async function entityQueryFromLibrary(): Promise<string | null> {
  const itemKeys: any[] = (await Zotero.DB.columnQueryAsync(
    `SELECT item_key FROM ${DB}.items WHERE library_key = 'user' ORDER BY item_pk LIMIT 100`
  )) || [];

  for (const key of itemKeys) {
    const itemId = Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, String(key));
    if (typeof itemId !== 'number' || itemId <= 0) continue;
    const item = await Zotero.Items.getAsync(itemId);
    if (!item || item.itemType === 'attachment' || item.itemType === 'note') continue;

    const creators = item.getCreators?.() || [];
    const surname = creators[0]?.lastName;
    const year = (item.getField('date') || '').match(/\b(19|20)\d{2}\b/)?.[0];
    if (surname && surname.length > 3 && year) return `${surname} ${year}`;
  }
  return null;
}

/** True when the item behind this result has chunks under the active model. */
async function isIndexed(result: HybridSearchResult): Promise<boolean> {
  const item = await Zotero.Items.getAsync(result.itemId);
  if (!item) return false;
  const count = await Zotero.DB.valueQueryAsync(
    `SELECT COUNT(*) FROM ${DB}.chunks c
       JOIN ${DB}.items i ON i.item_pk = c.item_pk
      WHERE i.library_key = 'user' AND i.item_key = ?`,
    [item.key]
  );
  return Number(count || 0) > 0;
}

selfTest.register('task-44-hybrid-backfill', async () => {
  const engine = new HybridSearchEngine(searchEngine);
  const query = await entityQueryFromLibrary();

  return [

    await scenario('an indexed keyword-only hit comes back with a similarity', async () => {
      if (!query) return;
      const results = await engine.search(query, { finalTopK: 10, minSimilarity: 0 });
      assertTrue(results.length > 0, `query "${query}" returned nothing to check`);

      const unscored: string[] = [];
      for (const r of results) {
        if (r.semanticScore !== null) continue;
        if (await isIndexed(r)) unscored.push(`${r.itemKey} (${r.source})`);
      }
      assertEq(unscored.length, 0, `indexed hits left without a score: ${unscored.join(', ')}`);
    }),

    await scenario('every back-filled hit carries something citable', async () => {
      if (!query) return;
      const results = await engine.search(query, { finalTopK: 10, minSimilarity: 0 });
      const backfilled = results.filter(r => r.source === 'keyword' && r.semanticScore !== null);
      // Not an early return: if nothing was back-filled, either the fix is
      // missing or the query produced no keyword-only hits, and both make the
      // rest of this suite meaningless.
      assertTrue(backfilled.length > 0, `"${query}" produced no back-filled keyword hits`);

      const empty = backfilled.filter(r => !r.chunkText && r.pageNumber === undefined);
      assertEq(empty.length, 0, `${empty.length}/${backfilled.length} back-filled hits have no chunk`);
    }),

    await scenario('a strict threshold leaves only genuinely unscorable hits', async () => {
      // The headline symptom of #44: at 0.99 the old code removed the semantic
      // hits and kept every keyword hit, because none of them had a similarity
      // to test. Anything indexed that survives 0.99 is that bug.
      if (!query) return;
      const strict = await engine.search(query, { finalTopK: 10, minSimilarity: 0.99 });

      const survivors: string[] = [];
      for (const r of strict) {
        if (r.semanticScore !== null && r.semanticScore >= 0.99) continue;
        if (await isIndexed(r)) survivors.push(`${r.itemKey} (${r.source}, score ${r.semanticScore})`);
      }
      assertEq(survivors.length, 0, `indexed hits survived a 0.99 threshold: ${survivors.join(', ')}`);
    }),

    await scenario('an unindexed keyword hit is exempt rather than dropped', async () => {
      // Items the keyword leg matched on metadata but ZotSeek never indexed
      // cannot be scored. Excluding them would silently remove matches hybrid
      // search has always returned, so they pass the threshold unscored.
      if (!query) return;
      const strict = await engine.search(query, { finalTopK: 10, minSimilarity: 0.99 });
      for (const r of strict) {
        assertTrue(
          r.semanticScore === null || r.semanticScore >= 0.99,
          `${r.itemKey} survived a 0.99 threshold with score ${r.semanticScore}`
        );
      }
    }),

    await scenario('the query is embedded once per hybrid search', async () => {
      // The back-fill reuses the vector the semantic leg already computed. A
      // second embedQuery would be a whole extra inference, or an extra HTTP
      // round trip on a server-backed model.
      if (!query) return;
      const original = embeddingPipeline.embedQuery.bind(embeddingPipeline);
      let calls = 0;
      (embeddingPipeline as any).embedQuery = async (q: string) => {
        calls++;
        return original(q);
      };
      try {
        await engine.search(query, { finalTopK: 10, minSimilarity: 0 });
      } finally {
        (embeddingPipeline as any).embedQuery = original;
      }
      assertEq(calls, 1, `embedQuery ran ${calls} times for one hybrid search`);
    }),

  ];
});
