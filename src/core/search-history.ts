/**
 * Recent search queries for the search dialog's main query box.
 *
 * Semantic search is exploratory in a way keyword search is not: a user
 * reformulates the same question several times and gets a better result on the
 * fourth phrasing, with no way to reconstruct which phrasing that was. Someone
 * who typed keywords remembers them; someone who wrote a sentence does not.
 *
 * Only the query text is kept, in one preference holding a JSON array, newest
 * first. That preference is user-editable, survives downgrades and can be
 * written by an older build, so every read here is defensive: a malformed or
 * unexpected value yields an empty history rather than throwing inside the
 * dialog's startup path.
 *
 * Module-level functions rather than a class: they need no instance state, and
 * module scope is the reliable shape under this project's esbuild IIFE bundle.
 */

declare const Zotero: any;

/** Preference holding the JSON array of past queries (extensions prefix). */
export const SEARCH_HISTORY_PREF = 'zotseek.searchHistory';

/** How many distinct queries are remembered. */
export const MAX_SEARCH_HISTORY = 10;

/**
 * Turn a stored preference value into a usable history list.
 *
 * Accepts only what it recognises: a JSON string holding an array of non-empty
 * strings. Anything else (malformed JSON, an object, a number, entries left by
 * a future format) degrades to an empty history or is filtered out.
 */
export function parseSearchHistory(raw: unknown): string[] {
  if (typeof raw !== 'string' || !raw) return [];

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e: any) {
    debugLog('malformed search history pref ignored: ' + (e?.message || e));
    return [];
  }

  if (!Array.isArray(parsed)) return [];

  const history: string[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'string') continue;
    const query = entry.trim();
    if (!query) continue;
    if (history.includes(query)) continue;
    history.push(query);
    if (history.length >= MAX_SEARCH_HISTORY) break;
  }
  return history;
}

/**
 * Return a new history with `query` at the top.
 *
 * Re-running a query already in the list moves it up rather than adding a
 * duplicate, the list is capped at MAX_SEARCH_HISTORY, and an empty or
 * whitespace-only query leaves the history untouched. Queries are stored
 * trimmed, so one that differs from an existing entry only by surrounding
 * whitespace is the same entry.
 */
export function addToSearchHistory(history: string[], query: string): string[] {
  const trimmed = typeof query === 'string' ? query.trim() : '';
  if (!trimmed) return history.slice();

  const rest = history.filter((entry) => entry !== trimmed);
  return [trimmed, ...rest].slice(0, MAX_SEARCH_HISTORY);
}

/** Read the stored history, newest first. Never throws. */
export function loadSearchHistory(): string[] {
  try {
    return parseSearchHistory(Zotero.Prefs.get(SEARCH_HISTORY_PREF, true));
  } catch (e: any) {
    debugLog('could not read search history: ' + (e?.message || e));
    return [];
  }
}

/**
 * Record a query that actually ran and return the resulting history.
 *
 * A no-op for an empty query, and for one already at the top of the list, so
 * repeating the same search does not rewrite the preference.
 */
export function recordSearchQuery(query: string): string[] {
  const current = loadSearchHistory();
  const updated = addToSearchHistory(current, query);

  const unchanged =
    updated.length === current.length && updated.every((q, i) => q === current[i]);
  if (unchanged) return current;

  try {
    Zotero.Prefs.set(SEARCH_HISTORY_PREF, JSON.stringify(updated), true);
  } catch (e: any) {
    // Losing the history is not worth failing a search the user just ran.
    debugLog('could not save search history: ' + (e?.message || e));
    return current;
  }
  return updated;
}

/**
 * Forget every recorded query.
 *
 * A search history is a record of what someone has been thinking about, and it
 * shows in screenshots and screen shares, so clearing it has to be reachable
 * from the dialog and has to leave nothing behind in the preference.
 */
export function clearSearchHistory(): void {
  try {
    Zotero.Prefs.set(SEARCH_HISTORY_PREF, '[]', true);
  } catch (e: any) {
    debugLog('could not clear search history: ' + (e?.message || e));
  }
}

/** Log without assuming Zotero is present (this module is unit-tested in Node). */
function debugLog(message: string): void {
  try {
    Zotero?.debug?.('[ZotSeek:SearchHistory] ' + message);
  } catch {
    // Nothing to log to; the caller already has its fallback.
  }
}
