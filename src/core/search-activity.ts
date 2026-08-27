/**
 * How many searches are running right now.
 *
 * Idle compaction takes zotseek.sqlite through DETACH -> move -> ATTACH, which
 * pulls the schema out from under anything mid-query. Bulk indexing was already
 * guarded by a flag on the plugin; searching was not, because the idle observer
 * only fires after 300 seconds without user input and someone searching in the
 * dialog is by definition typing. The MCP/REST server breaks that assumption:
 * an agent can search while the user is away from the machine.
 *
 * A counter rather than a boolean, because the server can be answering an agent
 * while the user searches in the dialog, and the first one to finish must not
 * clear the other's flag.
 *
 * Module-level rather than a class member on purpose: several unrelated call
 * sites need it, and module scope is the reliable shape under the esbuild IIFE
 * bundle (see CLAUDE.md, pitfall #6).
 */

let inFlight = 0;

/** True while at least one search is running. */
export function isSearchInProgress(): boolean {
  return inFlight > 0;
}

/**
 * Run a search with the in-flight count held up for its duration. The count is
 * released even when the search throws: a leaked count would block automatic
 * compaction for the rest of the session.
 */
export async function trackSearch<T>(fn: () => Promise<T>): Promise<T> {
  inFlight++;
  try {
    return await fn();
  } finally {
    inFlight--;
  }
}

/** Test-only: drop any leaked count between cases. */
export function __resetSearchActivity(): void {
  inFlight = 0;
}
