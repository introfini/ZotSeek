/**
 * Candidate selection for the notes backfill.
 *
 * Bulk "Update Library Index" decides what to skip by presence, not by
 * content: an item that already has chunks under the active model is left
 * alone whatever changed about it. That is what makes a backfill necessary.
 * Turning note indexing on does nothing to a library that is already indexed,
 * because the items whose notes are missing from the index are exactly the
 * ones the bulk path refuses to touch. Only editing each note by hand (which
 * goes through the auto-index path) would pick them up.
 *
 * This module picks out those items so the ordinary bulk pipeline can re-index
 * them: batching, progress with pause and cancel, per-batch checkpoints and
 * crash resume all come along unchanged.
 *
 * Free functions in their own module rather than ZotSeekPlugin methods: they
 * need no `this`, two callers share them (the menu action and the crash-resume
 * path), and SpiderMonkey does not reliably expose added private methods on
 * the prototype of esbuild's minified class expression. Every dependency is
 * injected, which also lets the selection rules be tested outside Zotero.
 */

/** Everything the selection needs from Zotero and from the vector store. */
export interface NoteBackfillDeps {
  /** True when the item carries the user's exclusion tag. */
  hasExcludeTag(item: any): boolean;
  /** Stable (library_key, item_key) identity, or null when unresolvable. */
  identityOf(item: any): { libraryKey: string; itemKey: string } | null;
  /** Whether the item already has chunks under the ACTIVE model. */
  isIndexed(libraryKey: string, itemKey: string): Promise<boolean>;
  /** Resolve a child note id to the note item. */
  getNote(noteId: number): Promise<{ deleted?: boolean } | null>;
  /** Optional diagnostic sink; never throws. */
  onError?(message: string): void;
}

/**
 * Whether the item has at least one child note that is not in the trash.
 *
 * `getNotes()` already excludes trashed notes on current Zotero, but the
 * extractor re-checks `deleted` on each resolved note and this has to agree
 * with it: an item selected here whose only note is trashed would be
 * re-indexed to produce exactly the chunks it already has.
 */
async function hasLiveChildNote(item: any, deps: NoteBackfillDeps): Promise<boolean> {
  const getNotes = item?.getNotes;
  if (typeof getNotes !== 'function') return false;

  let noteIds: number[];
  try {
    noteIds = getNotes.call(item) || [];
  } catch (error: any) {
    deps.onError?.(`getNotes failed for item ${item?.id}: ${error?.message || error}`);
    return false;
  }
  if (noteIds.length === 0) return false;

  for (const noteId of noteIds) {
    try {
      const note = await deps.getNote(noteId);
      if (note && !note.deleted) return true;
    } catch (error: any) {
      // One unreadable note must cost that note, not the whole item.
      deps.onError?.(`Could not resolve note ${noteId} on item ${item?.id}: ${error?.message || error}`);
    }
  }
  return false;
}

/**
 * Reduce a list of items to the ones a notes backfill has to re-index.
 *
 * Rules, applied in the order that is cheapest to test, so the one database
 * query per item runs last and only for items that got that far:
 *
 *  - a regular item: notes and attachments are never indexed on their own
 *  - not in the trash
 *  - not carrying the exclusion tag
 *  - has at least one child note that is not in the trash
 *  - already indexed under the active model. An item with notes that is NOT
 *    indexed yet needs no backfill: ordinary Update Index already covers it,
 *    and it will pick the notes up on the way through.
 *
 * De-duplicates by item id, so overlapping inputs cost one re-index.
 */
export async function selectNoteBackfillCandidates(
  items: any[],
  deps: NoteBackfillDeps,
): Promise<any[]> {
  const seen = new Set<number>();
  const candidates: any[] = [];

  for (const item of items || []) {
    if (!item?.isRegularItem?.()) continue;
    if (item.deleted) continue;
    if (seen.has(item.id)) continue;
    seen.add(item.id);

    try {
      if (deps.hasExcludeTag(item)) continue;
      if (!(await hasLiveChildNote(item, deps))) continue;

      const identity = deps.identityOf(item);
      if (!identity) continue;
      if (!(await deps.isIndexed(identity.libraryKey, identity.itemKey))) continue;

      candidates.push(item);
    } catch (error: any) {
      // A single failing item must not abort the scan of a whole library.
      deps.onError?.(`Note backfill check failed for item ${item?.id}: ${error?.message || error}`);
    }
  }

  return candidates;
}

/**
 * Gather the backfill candidates across a set of libraries.
 *
 * The library ids are resolved by the caller from `zotseek.indexScope` and
 * persisted in the resume marker, so an interrupted run comes back with the
 * same libraries it started with even if the preference changed meanwhile.
 */
export async function collectNoteBackfillItems(
  zoteroAPI: { getLibraryItems: (libraryId?: number) => Promise<any[]> },
  libraryIds: number[],
  deps: NoteBackfillDeps,
): Promise<any[]> {
  const all: any[] = [];
  for (const libraryId of libraryIds || []) {
    try {
      const items = await zoteroAPI.getLibraryItems(libraryId);
      if (items?.length) all.push(...items);
    } catch (error: any) {
      deps.onError?.(`Could not list items for library ${libraryId}: ${error?.message || error}`);
    }
  }
  return selectNoteBackfillCandidates(all, deps);
}
