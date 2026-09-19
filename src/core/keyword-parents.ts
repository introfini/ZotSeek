/**
 * Resolving keyword matches to the items they belong to.
 *
 * Zotero's quick search matches wherever the text lives. When a query hits a
 * PDF's body or a note's text, the item Zotero returns is the attachment or the
 * note, not the paper. The keyword leg of hybrid search used to exclude those
 * two item types in the search itself, which dropped the match instead of
 * attributing it to the parent: every full-text and note keyword hit was
 * silently discarded, leaving the keyword leg matching titles, creators, years
 * and tags only.
 *
 * The fix is to let the children through and resolve them here. Two orderings
 * matter and are the reason this is a function rather than a few inline lines:
 *
 *  - the book filter reads the type of the *resolved* item, not the match's, so
 *    it has to run after resolution rather than as a search condition;
 *  - the top-K slice runs after dedupe, so one paper with eleven matching
 *    attachments takes one slot instead of eleven.
 *
 * Pure so it can be tested outside Zotero; the Zotero.Search call that feeds it
 * lives in hybrid-search.ts.
 */

/**
 * What one keyword match looks like once Zotero has been asked about it.
 *
 * `owner` is the item the match belongs to: for a child, the top-level item it
 * hangs from (a PDF's paper, a note's paper); absent for a top-level match.
 * Callers pass the top-level ancestor rather than the immediate parent so that
 * grandchildren, such as annotations under an attachment, resolve to the paper
 * in one step.
 */
export interface KeywordMatchFacts {
  /** The item id Zotero's search returned. */
  itemId: number;
  /** The matched item's own type ('attachment', 'note', 'journalArticle', ...). */
  itemType: string;
  /** Zotero's `isRegularItem()` for the matched item. */
  isRegularItem: boolean;
  /** The top-level item this match belongs to, when the match is a child. */
  owner?: { itemId: number; itemType: string } | null;
}

export interface ResolveKeywordMatchesOptions {
  /** Drop matches whose resolved item is a book (the `zotseek.excludeBooks` pref). */
  excludeBooks: boolean;
  /** How many resolved items to keep, applied after dedupe. */
  limit: number;
}

/**
 * Map matches to the items that should represent them, then filter, dedupe and
 * cap.
 *
 * A match with an owner resolves to that owner. A top-level regular item
 * resolves to itself. A standalone note or attachment resolves to nothing and
 * is dropped: ZotSeek does not index it, so there is nothing to rank.
 *
 * Order is preserved: the first match that resolves to an item fixes that
 * item's position, which keeps Zotero's own result order intact for the
 * relevance scoring that runs next.
 */
export function resolveKeywordMatches(
  matches: KeywordMatchFacts[],
  options: ResolveKeywordMatchesOptions
): number[] {
  const { excludeBooks, limit } = options;
  const resolved: number[] = [];
  const seen = new Set<number>();

  for (const match of matches) {
    let itemId: number;
    let itemType: string;

    if (match.owner) {
      itemId = match.owner.itemId;
      itemType = match.owner.itemType;
    } else if (match.isRegularItem) {
      itemId = match.itemId;
      itemType = match.itemType;
    } else {
      // A standalone note or attachment: nothing indexed, nothing to rank.
      continue;
    }

    if (excludeBooks && itemType === 'book') continue;
    if (seen.has(itemId)) continue;

    seen.add(itemId);
    resolved.push(itemId);
  }

  return limit >= 0 ? resolved.slice(0, limit) : resolved;
}
