/**
 * Resolve a set of collections to the de-duplicated list of regular items they
 * contain, subcollections included.
 *
 * Goes through the Search API rather than `collection.getChildItems()` for two
 * reasons: it descends into subcollections, which is what the resume path has
 * always done (so a cancelled run no longer comes back with a different item
 * set than it started with), and it honours the excludeBooks pref the same way
 * Index Library and auto-indexing already do.
 *
 * De-duplicates because a paper filed in two of the selected collections is
 * still one indexing job.
 *
 * A free function in its own module rather than a ZotSeekPlugin method: it
 * needs no `this`, both callers (the menu action and the crash-resume path)
 * share it, and SpiderMonkey does not reliably expose added private methods on
 * the prototype of esbuild's minified class expression.
 *
 * `zoteroAPI` is structurally typed so tests can pass a stub.
 */
export async function collectCollectionItems(
  zoteroAPI: { getCollectionItems: (collectionId: number, libraryId?: number) => Promise<any[]> },
  entries: Array<{ libraryId: number; collectionId: number }>,
): Promise<any[]> {
  const seen = new Set<number>();
  const items: any[] = [];
  for (const entry of entries) {
    const collectionItems = await zoteroAPI.getCollectionItems(entry.collectionId, entry.libraryId);
    for (const item of collectionItems || []) {
      if (!item?.isRegularItem?.()) continue;
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}
