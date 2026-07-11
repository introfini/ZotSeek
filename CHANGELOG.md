# Changelog

All notable changes to ZotSeek - Semantic Search for Zotero will be documented in this file.

## [1.17.0] - 2026-07-11

### Added
- **Selectable local embedding models** (#37) - Choose between four curated models in **Settings → ZotSeek → Embedding Model**. The bundled default (`nomic-embed-text-v1.5`, English, 768 dims) is joined by three on-demand multilingual models: `paraphrase-multilingual-MiniLM-L12-v2` (384 dims, small/fast, ~135 MB), `multilingual-e5-base` (768 dims, balanced, ~110 MB), and `bge-m3` (1024 dims, highest quality, ~570 MB). Non-bundled models download once from Hugging Face to the Zotero profile directory; nothing from your library ever leaves your machine.
- **Per-model embedding retention and background re-index on switch** - Switching models keeps embeddings from all previously used models. Items indexed with the new model are available immediately; items not yet covered are re-indexed in the background. Switching back to a previous model is instant.
- **Manage downloaded models panel** - A new panel in Settings shows per-model index statistics (items, chunks, and embedding storage) and allows deleting models you no longer need (deletes model files and removes that model's embeddings from the database). The built-in model and the currently active model cannot be removed; each shows an inline reason ("Built-in" / "Active") with a tooltip, and a caption in the panel explains the rule.
- **Coverage indicator and "Index remaining" button** - The Embedding Model settings page now shows "N of M items searchable with the active model." When coverage is incomplete, an **Index remaining N** button triggers a background re-index for the missing items. The button shows "Indexing in the background..." and stays disabled while a run is in progress. There are now three model-aware ways to index the library, all preserving other models' embeddings: (1) the prompt on model switch, (2) the Index remaining button, (3) the existing toolbar/right-click "Index Library" action, which now backfills items missing coverage for the active model instead of reporting "already indexed."

### Technical
- **Schema v9** - `chunks` table primary key extended to `(item_pk, chunk_index, model_id)` to support per-model embedding storage for the same chunk. New `item_models` table records per-(item, model) indexing status (`item_pk`, `model_id`, `indexed_at`, `content_hash`, `was_truncated`, `pages_indexed`, `pages_total`), replacing the per-item status columns on `items` that were model-specific. Automatic migration from v8: existing rows are migrated to the active model's slot; pre-migration backup written to `zotseek.sqlite.v8.bak`. Search is partitioned by `model_id` - queries only compare against embeddings produced by the currently active model.
- New `src/core/model-registry.ts` - single source of truth for the curated model set. Each `ModelConfig` specifies dimensions, pooling strategy (`mean`/`cls`), instruction prefixes for queries vs documents, ONNX file path, files to download, and whether the model is bundled.
- `EmbeddingPipeline.init()` reads the active model via `getActiveModel()` on every initialisation; `setActiveModelId()` persists the choice to `zotseek.embeddingModel`. Non-bundled model files are served via a `resource://zotseek-models/` alias pointing to the download directory; the bundled model loads from `chrome://zotseek/content/models/`.
- **Model-aware identity-keyed reads** - `isIndexedByIdentity()` checks coverage against `item_models` for the active `model_id`, so indexing skip logic (auto-index, manual index, "Index remaining") only treats an item as already indexed when its embeddings exist for the *active* model. Similarly, `getChunkByPk()` and `getItemChunksByIdentity()` (used by `find_similar` / "Find Related Documents") filter by `model_id`, so similarity comparisons always stay within the active model's vector space.

---

## [1.16.1] - 2026-06-11

### Fixed
- `mode=hybrid` over MCP/REST now returns the same ranking as the ZotSeek dialog: it honors the hybrid-search preferences, including automatic weight adjustment and the user's minimum-similarity setting. Previously it ran a fixed 50/50 fusion, producing a different order than the UI for the same query. Reported in #38.

### Added
- `min_similarity` parameter (0–1) on the MCP `search` tool and `minSimilarity` on `GET /zotseek/search`, defaulting to the user's ZotSeek preference.

---

## [1.16.0] - 2026-06-11

### Added
- **Local MCP server for AI agents (opt-in)** (#38) — ZotSeek now speaks the Model Context Protocol on Zotero's local HTTP server, so MCP clients like Claude Code can run semantic searches over your library with no extra software. Results include `zotero://` deep links that open papers (or the exact matched PDF page) directly in Zotero, plus `http://localhost` launcher variants for chat clients that only render `http(s)` links as clickable. Enable it in **Settings → ZotSeek → AI Agent Access**.
- **Native REST endpoints for scripts and CLI tools** (#32) — `GET /zotseek/search`, `GET /zotseek/similar`, and `GET /zotseek/stats` on `localhost:23119`, sharing the same read-only tool layer and result shapes as the MCP server.

### Technical
- New `src/server/` module: a shared read-only tool layer over the existing search engines (`http-tools.ts`), a stateless JSON-RPC 2.0 endpoint implementing the MCP Streamable HTTP transport (`mcp-endpoint.ts`), REST endpoints (`rest-endpoints.ts`), a link launcher (`open-endpoint.ts`) that performs select/open-PDF actions directly inside Zotero when `http://localhost:23119/zotseek/open` links are clicked (works even from embedded webviews that block `zotero://` handoff; prefetch-safe), and pref-observed registration on `Zotero.Server.Endpoints` gated by `zotseek.mcpServer.enabled` (`server-manager.ts`, default off, toggles live). Covered by a 21-scenario self-test suite. See [docs/MCP.md](docs/MCP.md).

---

## [1.15.1] - 2026-06-10

### Fixed
- **Indexing progress window drifts upward off-screen** (#14) — During long indexing runs, the progress popup crept upward with each checkpoint until it disappeared above the screen (reported on Windows, mechanism present on all platforms). Two interacting causes: checkpoint lines accumulated without limit, so Zotero's own bottom-anchored repositioning kept pushing the window's top edge higher, while ZotSeek's height clamp resized from the top edge and only ever corrected the position upward. Checkpoint history now rotates through at most 4 visible lines (newest first), and the window is deterministically re-anchored to the bottom of the main Zotero window on every update.

### Technical
- `StableProgressWindow.addCheckpointLine()` (`src/utils/stable-progress.ts`) caps created lines at `MAX_CHECKPOINT_LINES` (4) and rotates checkpoint texts through the existing lines instead of growing the popup. `ensureSize()` now always re-anchors the window bottom to `mainWindow` bottom (clamped to `screen.availTop`) instead of only moving up on overflow, and uses a ±2px tolerance on height/position comparisons so Windows display-scaling rounding can't trigger a resize/move on every update.
- `StableProgressWindow` is exposed as `Zotero.ZotSeek.StableProgressWindow` for runtime diagnostics via the dev console.

---

## [1.15.0] - 2026-06-04

### Added
- **Matched-passage preview on hover** (#36) — Hovering a search result now shows a floating tooltip with the actual text of the passage that matched your query, alongside its location (page & paragraph), section type, and match score. This makes it easy to judge relevance without opening each paper. In keyword and hybrid searches, the query terms are highlighted inside the snippet; the snippet is windowed around the first matched term so the relevant part is always visible.

### Changed
- **"By Section" results now show the match location** — The Location column (page & paragraph) is now populated in "By Section" mode, showing where the best-matching passage was found. Previously the location was only shown in "By Location" mode. You now get one diverse result per paper *and* the exact location of its strongest match, without the list being dominated by many passages from a single long paper.

### Technical
- The matched chunk's text is now surfaced to the UI. `SearchResult` and `HybridSearchResult` carry an optional `chunkText`, populated only for the visible top-K results: `SearchEngine.search()` batch-fetches the text for the matched chunks after slicing (`populateChunkText()` + new `VectorStoreSQLite.getChunkTexts()`), so `chunk_text` stays out of the in-memory embedding cache and RAM use is unaffected on large libraries. No schema change or re-indexing required (`chunk_text` was already stored).
- `SearchResultsTable` (`src/ui/results-table.ts`) renders the snippet as a custom floating tooltip. It uses `mousemove` delegation on the table container (resolving the row via the `zotseek-results-table-row-<index>` id that `VirtualizedTable` assigns), so it survives row-DOM recycling during scroll. The tooltip is hidden on scroll/re-render/clear and torn down on destroy. Snippet text and query terms are HTML-escaped before any `<mark>` wrapping. `search-dialog-vtable.ts` passes query terms via `setQueryTerms()` only for keyword/hybrid mode (no literal terms exist in pure-semantic search).
- `getRowData()` no longer gates the Location column on `granularity === 'location'`; it formats `pageNumber`/`paragraphIndex` whenever present (the MaxSim result already carries the best chunk's location), falling back to "—" for keyword-only matches or abstract-only indexing.

---

## [1.14.5] - 2026-06-01

### Fixed
- **Indexing fails part-way through on large libraries with `no such table: zotseek.items`** (#35) — The `zotseek.sqlite` database is ATTACHed to Zotero's main SQLite connection, an attachment that lives only as long as that connection. On a long indexing run (e.g. ~5,900 items) Zotero can recycle its connection mid-run (sync, lock recovery, or a backup), silently dropping the attachment while ZotSeek's internal `attached`/`initialized` flags stay true. Every subsequent query then failed with `no such table: zotseek.items`, so indexing stalled and flooded the Error Console. ZotSeek now verifies the attachment is still live before each operation and transparently re-attaches (recreating the schema if needed) when Zotero has dropped it, so indexing survives connection recycling.

### Technical
- `VectorStoreSQLite.ensureInit()` (`src/core/vector-store-sqlite.ts`) now checks `PRAGMA database_list` for the `zotseek` schema and calls a new `reattachAfterConnectionLoss()` when it's missing. The check is skipped inside a Zotero transaction (ATTACH/DETACH is illegal there, and `ensureInit()` always runs before a transaction opens). New helpers: `isAttachmentLive()` and `reattachAfterConnectionLoss()`.

---

## [1.14.4] - 2026-05-26

### Fixed
- **Item list scroll jumps to the selected row during indexing** (#34) — While ZotSeek's column repainted (as items got indexed or the cache hydrated), the list would snap your scroll position back to the selected item, making it hard to browse a large library while indexing ran. The column now repaints in place without disturbing scroll position.

### Technical
- `src/ui/item-tree-column.ts` replaces `refreshAndMaintainSelection()` with `tree.invalidate()` for column repaints: the former rebuilt the whole tree and snapped scroll to the selection, the latter only re-renders visible rows in place. Repaints are debounced over a 500ms window to coalesce the rapid updates during indexing/hydration, Zotero's `_rowCache` is cleared before `invalidate()` so `dataProvider` is re-called for visible rows, empty hydration batches skip the refresh, and the debounce timer is cleaned up on shutdown.

---

## [1.14.3] - 2026-05-25

### Fixed
- **Zotero crashes when indexing large collections** — Indexing could exhaust memory and crash Zotero after only a handful of papers, especially with small chunk sizes (which produce many chunks per paper). Each embedding left an ONNX Runtime tensor allocated in the worker's WASM heap; at ~100 chunks/paper this accumulated hundreds of MB within 3-5 papers. Tensors are now released after each embedding, so indexing stays within a stable memory budget regardless of collection size.

### Technical
- `src/worker/embedding-worker.ts` calls `output.dispose()` after `Array.from(output.data)` extracts the embedding (guarded with a `typeof === 'function'` check for compatibility). Any Transformers.js pipeline tensor must be disposed after use, or the WASM heap leaks ~3KB per embedding until the worker crashes.

---

## [1.14.2] - 2026-05-19

### Changed
- **Compact Database button now shows reclaimable space** (#33 follow-up) — the button label in Preferences > Database Stats updates dynamically to "Compact Database (reclaim 754 MB)" when SQLite is holding onto significant free pages, so it's obvious when compaction is worth running. After the v8 migration finished, SQLite kept the dropped v7 tables' space as internal free pages, causing the `zotseek.sqlite` file to roughly double in size on disk despite holding the same data. The Compact action (which uses `VACUUM INTO` to rewrite a fresh file) reclaims that space, but until now there was no visual cue that there was anything to reclaim. The hint hides below ~10 MB so it doesn't nag for trivial gains.

### Technical
- New `VectorStoreSQLite.getReclaimableBytes()` reads `PRAGMA zotseek.freelist_count * PRAGMA zotseek.page_size` — both O(1) header reads, no scanning.
- Exposed on `Zotero.ZotSeek.api.getReclaimableBytes` so preferences can poll it.
- `PreferencesManager.loadCompactionInfo()` runs on pane init alongside `loadHealthStats()`, formats the value (MB up to 1024, GB above), and overrides the button's Fluent label. After a successful compaction the info reloads so the hint disappears.

---

## [1.14.1] - 2026-05-18

### Fixed
- **v8 migration aborts on libraries with duplicate `item_key` rows** (#33) — Upgrading from 1.13.1 → 1.14.0 could fail with `UNIQUE constraint failed: items.library_key, items.item_key`, leaving the database stuck in a rollback loop: the UI showed 0 indexed papers, storage size errored, and every indexing attempt died with `SQLite init failed`. The v6/v7 schema allowed two rows in `items` with the same `item_key` (e.g. when a Zotero item had been deleted and re-added locally), but v8's `UNIQUE(library_key, item_key)` rejected the second INSERT. The migration now deduplicates rows by `(library_key, item_key)` before insertion: it keeps the canonical row (newest `indexed_at`) and remaps the collapsed duplicates' chunks to the canonical `item_pk`. No data is lost — chunks from collapsed duplicates are merged in on `chunk_index` slots the canonical didn't cover.

### Technical
- `migrateToV8` (`src/core/vector-store-sqlite.ts`) groups resolved rows by `(library_key, item_key)` before inserting into the new `items` table. Each group elects a canonical via `indexed_at DESC, item_id DESC`; non-canonical `item_id`s are still added to `_id_map` so their chunks survive. Chunk copy is split into two passes — canonical first (plain INSERT, no possible conflict), then non-canonical with `INSERT OR IGNORE` so the canonical's chunk always wins on `(item_pk, chunk_index)` collisions.
- Affected users with a stuck install can restore `zotseek.sqlite.v7.bak` (written automatically before the migration started) over `zotseek.sqlite` and re-upgrade.

---

## [1.14.0] - 2026-05-13

### Added
- **Cross-machine database portability** (#27) — `zotseek.sqlite` can now be copied between machines without re-indexing, even when local Zotero item IDs differ between installations. The plugin identifies items by Zotero's stable item keys (the same identifiers used by the Zotero web API), so embeddings survive the move. Migration runs automatically on first start; a pre-migration backup is written to `zotseek.sqlite.v7.bak`.
- **Resume interrupted indexing on startup** (#31) — If a previous "Index Library" or "Index Collection" run was interrupted by a crash, sleep, plugin reload, or Zotero quit, the next startup now asks "Resume indexing N items?" and continues exactly where it stopped. Explicit cancels do not re-prompt — only true interruptions do.
- **Indexing status column** (#30) — A new "ZotSeek" column in the item list shows whether each paper is fully indexed (`✓`), partially indexed (`◐`), out of date (`↻`), excluded (`⊘`), or not indexed (empty). The column appears automatically on first install; users can hide or move it like any other Zotero column.
- **Partial-content warning** (#30) — The indexing progress window now adds a summary line "⚠ Partial content: N item(s) hit the Max Chunks per Paper limit" whenever truncation happened, and the debug log gains one `[ZotSeek] ⚠ Truncated at chunk limit: "<title>" (<pages>/<total> pages)` line per affected paper.
- **Database Health panel** in Preferences showing the count of unresolved embeddings (items no longer present in the current Zotero library), with a Purge Orphans action to reclaim space.
- README section documenting how to copy `zotseek.sqlite` between machines.

### Changed
- **Smaller checkpoint batch** (#31) — Bulk-index checkpoint batch dropped from 25 items to 10. A cancel or crash mid-batch now loses at most ~10 items of extraction/embedding work instead of ~25.
- **Embedding worker auto-recovers** (#31) — If the embedding ChromeWorker dies mid-run (sleep/wake, OOM, parent process recycle), the next `embed()` call silently tears it down and re-initialises before retrying. Bounded by 2 recovery attempts per embed to avoid infinite loops on a permanently broken state.

### Technical
- **Schema v8** introduces stable cross-machine identity. The `items` table is keyed by autoincrement `item_pk` with `UNIQUE(library_key, item_key)`. `library_key` is `'user'` or `'group:<groupID>'`, both stable across all machines syncing the same library; `item_key` is Zotero's 8-character `Item.key`. The `chunks` table uses `item_pk` as its foreign key instead of local Zotero `itemID`.
- Schema v8 also carries the v7 per-item status columns introduced in this release: `was_truncated`, `pages_indexed`, `pages_total`. Both migration paths (v6→v7→v8 and v7→v8) are defensive — they detect schema state by introspecting `PRAGMA table_info`, not by reading `schema_version`.
- New `identity-resolver` module centralizes Zotero ID ↔ ZotSeek identity mapping.
- v7 → v8 migration resolves each row via its stored `item_key` and works uniformly whether running on the original machine or after a cross-machine copy.
- `src/utils/chunker.ts` exposes new `chunkDocumentEx` / `chunkDocumentWithPagesEx` returning `{chunks, wasTruncated, pagesIndexed, pagesTotal}`. Every `break` hit by the `maxChunks` ceiling now flags `wasTruncated`.
- New `VectorStoreSQLite.getIndexStatusByIdentity(identities)` API returns batched status with `(libraryKey, itemKey)` keying; the legacy `getIndexStatusMap(itemIds)` is preserved as an identity-resolving shim.
- `src/index.ts` persists the bulk-index scope (`zotseek.bulkIndex.pendingScope`) when starting a run of 25+ items and clears it on successful completion or explicit cancel. New `checkAndOfferResume()` runs at startup, rebuilds the candidate list, filters out items already indexed, and prompts via `Services.prompt.confirm` if any remain.
- `src/core/embedding-pipeline.ts` adds `recoverWorker()` and rewrites `embed()` as a retry loop that distinguishes worker-death (signalled by the `WORKER_DIED` error code rejected from any in-flight job inside `onerror`) from regular embedding failures.
- New module `src/ui/item-tree-column.ts` registers the column via `Zotero.ItemTreeManager.registerColumns`. Cell text is served from a per-item in-memory cache that is hydrated lazily in batches when the tree paints, and invalidated on every `putBatch`/`delete`. "Out of date" detection compares `item.dateModified > indexed_at` as a cheap proxy. First-run UX auto-shows the column once, guarded by `zotseek.indexStatusColumn.firstShown`.

---

## [1.13.1] - 2026-04-24

### Fixed
- **Preferences now actually apply to search** (#29) - "Results to show" and "Minimum similarity" were silently ignored by the search dialog, which always returned up to 50 results and filtered at 20% similarity regardless of user settings. Both prefs are now honored in the main search dialog (single-query and multi-query AND/OR) and in the Find Similar Documents dialog.

### Technical
- `src/ui/search-dialog-vtable.ts` reads `zotseek.topK` and `zotseek.minSimilarityPercent` on dialog open and passes them to the hybrid search engine. For multi-query searches, sub-queries still use a broad threshold (0.15) so AND intersections can form, and the user's threshold is applied to the final combined score.
- `src/ui/similar-documents-dialog.ts` passes the same prefs to `findSimilar()` instead of the hardcoded `topK: 20`.

---

## [1.13.0] - 2026-04-22

### Added
- **Save Results as Collection** (#28) - Export search results into a Zotero collection so the list survives closing the search dialog. Two entry points:
  - Footer button **"Save Results as Collection"** in both the main search dialog and the Find Similar Documents dialog. Exports every result in the current list.
  - Submenu entry **Add to Collection → New collection...** in the main search dialog. Exports only the right-clicked subset.
  - The modal pre-fills a suggested name (e.g. `ZotSeek: "llm" · 2026-04-21`) and shows a live status line (`N items → My Library`). New collections land at the target library's root; drag them into a subfolder from Zotero's sidebar if you want.
  - When a single result set spans multiple libraries (personal + group), a Library dropdown appears so you can pick which library receives the new collection. Items in other libraries are reported as skipped in the confirmation.

### Technical
- New shared module `src/ui/collection-export.ts` centralizes collection operations. The existing right-click "Add to Collection -> pick existing" flow and the new bulk/submenu flows all go through it (single source of truth).
- New modal dialog at `content/collectionExportDialog.xhtml` with its own esbuild bundle (`collection-export-dialog.js`).
- Localization via the project's sync `Localization` helper (`getString`). The DOMLocalization available as `document.l10n` is async at modal open time and its `formatValueSync` throws; the modal uses `getString` to avoid this.
- Fluent strings referenced via `data-l10n-id` use the `.attribute = value` form so Fluent sets the named attribute (`.title`, `.label`, `.value`) instead of wiping the element's children.

---

## [1.12.0] - 2026-04-11

### Changed
- **Dropped Zotero 7 support** — ZotSeek now requires Zotero 8 or newer. Users on Zotero 7 should upgrade to Zotero 8+, or stay on ZotSeek v1.11.x. Zotero 7 (Firefox 115) was ~8-10x slower on WASM/SIMD, and removing the compatibility layer simplifies indexing and unlocks larger default chunks.
- **Zotero 9 compatibility** — `strict_max_version` bumped to `9.*` so the plugin loads on Zotero 9.0 (released 2026-04-10). Verified end-to-end on Zotero 9.0 / Firefox 140.9.0esr: plugin load, preferences pane, embedding worker, semantic search (~150ms), and clean shutdown.
- **Default `maxTokens` is now 2000** unconditionally (previously 800 on Zotero 7, 2000 on Zotero 8). Existing users keep their stored value; change it in Settings → ZotSeek if you want the new default.

### Technical
- Removed version-aware defaults in `src/index.ts`, `src/utils/chunker.ts`, `src/worker/embedding-worker.ts`, and `src/core/embedding-pipeline.ts`.
- Removed Zotero 7 performance-warning banner from the preferences pane and its FTL strings (`zotseek-pref-zotero7Note`, `zotseek-pref-zotero7Desc`).
- `scripts/release.js` now emits both `strict_min_version` and `strict_max_version` when regenerating `update.json`.

---

## [1.11.1] - 2026-03-25

### Added
- **Chinese (zh-CN) Localization** - Complete Chinese translation for the entire UI (fixes #16)
  - Preferences panel, search dialog, similar documents dialog, context menus, indexing progress, and status messages
  - Uses Zotero's native Fluent (.ftl) localization system
  - Resolves locale interference with Better Notes and Translate for Zotero plugins

### Technical
- **i18n Infrastructure** - Added Fluent-based localization with `getString()` API and `data-l10n-id` DOM translation
  - 150+ translated strings across all user-facing surfaces
  - Adding new languages requires only a new `.ftl` file in `locale/`

---

## [1.11.0] - 2026-03-23

### Added
- **Database Compaction** - New "Compact Database" button in Settings to reclaim unused space after migrations or deletions
  - Uses SQLite `VACUUM INTO` for safe compaction of the ATTACHed database

### Improved
- **Identify Failed Items During Indexing** - When chunks fail to embed, the progress window and debug log now show the titles of affected items instead of just a count (addresses feedback in #19)

### Fixed
- **Storage Size Reporting** - Stats panel now shows actual database file size instead of a rough estimation that could be ~10x too low (fixes #25)
  - Added GB formatting for large databases
- **Oversized Paragraph Handling** - Documents with very long paragraphs (no line breaks) are now split at sentence boundaries instead of truncated (fixes #20)
  - Previously, a 33K-char paragraph produced 1 truncated chunk, losing ~70% of content
  - Now splits into multiple properly-sized chunks, preserving all content with page location data

### Technical
- **Base64 Embedding Storage** - Embeddings now stored as base64 instead of JSON, reducing per-embedding size by ~73% (4 KB vs 16 KB per 768-dim vector)
  - Existing JSON embeddings are read transparently and converted to base64 on next re-index
  - Re-index your library after updating to get the full size reduction
- **Normalized Database Schema** - Split single `embeddings` table into `items` (one row per paper) and `chunks` (one row per embedding chunk)
  - Eliminates duplication of title, abstract, and metadata across all chunks for the same paper
  - Schema v6 migration runs automatically on startup

---

## [1.10.0] - 2026-02-20

### Added
- **Configurable Auto-Index Delay** - Set how long to wait after the last item is added before auto-indexing starts (closes #21)
  - Default: 10 seconds (configurable from 1-300 seconds in Settings)
  - Each new item resets the countdown, preventing indexing during bulk imports
  - Inspired by Better BibTeX's auto-export delay
- **Pause/Play and Cancel on Manual Indexing** - Control long-running indexing operations
  - Pause (⏸) and cancel (✕) buttons in the progress window during Update Index and Rebuild Index
  - Pauses at batch boundaries (every 25 items) with all progress saved
  - ETA calculation accounts for paused time
  - Cancellation shows a quiet notification instead of an error alert

### Fixed
- **Resilient Embedding** - Single chunk failures no longer crash the entire indexing operation (fixes #19)
  - Each chunk gets one automatic retry before being skipped
  - Skipped chunks are logged and reported in the progress window
  - Remaining items continue indexing normally
  - Applies to both manual and auto-indexing

### Changed
- Auto-index batch timer now uses proper debounce (resets on each new item instead of firing after the first)

---

## [1.9.0] - 2026-02-07

### Added
- **Auto-Cleanup on Delete/Trash** - Embeddings are automatically removed when items are deleted or trashed
  - Prevents ghost search results from orphaned data
  - Always active regardless of auto-index setting (data integrity concern)
  - Registered as a separate Notifier observer in plugin startup
- **"Remove from ZotSeek Index"** - New right-click context menu item to manually remove items from the index
  - Supports multi-select (remove several items at once)
  - Shows quick notification with count of removed items
  - Safe to use on non-indexed items (no-op, no error)
- **Tag-Based Exclusion** - Exclude items from indexing by tagging them
  - Default tag: `zotseek-exclude` (configurable in Settings → ZotSeek → Advanced Settings)
  - Works during manual indexing (Update Library Index, Index Selected, Index Collection)
  - Works during auto-indexing of new items
  - Leave the tag name empty to disable exclusion
  - Tip: Use Zotero's Advanced Search to bulk-tag items by title, type, or collection

### Technical
- Added `cleanupNotifierID` field and `registerCleanupObserver()` for delete/trash event handling
- Cleanup observer uses `vectorStore.delete()` which is idempotent (DELETE WHERE returns 0 rows for non-indexed items)
- Context menu handler filters to `isRegularItem()` to skip attachments/notes
- Tag exclusion uses module-level `hasExcludeTag()` function (not class method) for SpiderMonkey compatibility
- Exclusion check runs before `isIndexed` check in Phase 1 filtering for efficiency

---

## [1.8.0] - 2026-01-30

### Added
- **Multi-Select in Search Results** - Select multiple items using standard shortcuts
  - Shift+click to select a range of items
  - Cmd/Ctrl+click to toggle individual items
  - "Open Selected" button selects all items in Zotero library when multiple selected
- **Right-Click Context Menu** - Batch operations on selected results
  - "Show in Library" - Selects item(s) in the main Zotero pane
  - "Add to Collection" - Submenu to add selected items to any collection
- **Dark Mode Improvements** - Better text contrast on selected rows in both light and dark modes

### Fixed
- **Database Persistence** - Fixed database being wiped on plugin reload during development
  - Only deletes database on true uninstall (ADDON_UNINSTALL), not on upgrade/reload

### Technical
- Added `selectItems()` method to ZoteroAPI for multi-item selection
- Context menu uses XUL `menupopup` with dynamic collection submenu
- Database operations wrapped in `Zotero.DB.executeTransaction()` for proper locking
- Added `getSelectedIndices()` and `getSelectedResults()` methods to results table

---

## [1.7.0] - 2026-01-26

### Added
- **Multi-Query Search** - Combine up to 4 search queries with AND/OR logic
  - Click "+" to add additional query fields (up to 4 total)
  - **AND mode**: Find papers matching ALL queries (intersection)
  - **OR mode**: Find papers matching ANY query (union)
  - Three AND combination formulas: Minimum (strict), Product (balanced), Average (lenient)
  - Per-query scores shown in Match column: e.g., "73% (77|73|68)" shows combined score and individual scores
  - Great for finding papers at the intersection of multiple topics

### Changed
- **Improved Progress Window** - Dynamic sizing and better checkpoint display
  - Dynamic height that adjusts to content (min: 120px, max: 400px)
  - Checkpoint messages now display in reverse order (newest first)
  - Window stays within main Zotero window bounds

### Technical
- Added `queryCount` state management for dynamic query fields
- Implemented parallel search execution with `Promise.all()` for multi-query
- Score combination using configurable formulas (min, geometric mean, average)
- Extended `HybridSearchResult` interface with `queryScores` array for per-query tracking
- Query removal shifts values to maintain contiguity (removing Q2 of 4 shifts Q3→Q2, Q4→Q3)

---

## [1.6.0] - 2026-01-24

### Added
- **Checkpoint Saving** - Indexing now saves progress every 25 items
  - Resume safely after crash by simply re-running "Update Index"
  - Already-indexed items are automatically skipped
  - Shows batch progress during indexing (Batch X/Y)
- **Settings Button** - Quick access to ZotSeek preferences from the search dialog
  - Located in bottom-left corner of search dialog
  - Opens directly to the ZotSeek settings pane

### Changed
- **Redesigned Settings Panel** - Modern, visual preferences UI
  - Index statistics displayed as colorful cards (Papers, Chunks, Storage)
  - Indexing mode selection with visual radio-style cards
  - Organized sections: Auto-Indexing, Search Settings, Advanced Settings
  - Action buttons with visual hierarchy (green for recommended, yellow for destructive)
- **Improved Alerts** - Dialogs now show "ZotSeek" title instead of generic "[JavaScript Application]"

### Technical
- Implemented batch processing with `CHECKPOINT_BATCH_SIZE = 25`
- Added `isIndexed()` check to skip already-indexed items
- Replaced `win.alert()` with `Services.prompt.alert()` for proper dialog titles
- Added `updateModeCards()` for syncing visual state of mode selection cards

---

## [1.5.0] - 2026-01-20

### Added
- **Auto-Index New Items** - Automatically index papers when you add them to your library
  - Enable via Settings → ZotSeek → "Auto-index new items"
  - Waits for PDF attachments with automatic retry (exponential backoff)
  - Batches multiple items together during bulk imports
  - Shows live progress indicator while indexing
  - Respects your indexing mode setting (Abstract or Full Document)
- **Column Sorting** - Click column headers to sort search results
  - Sort by Match %, Year, Title, Authors, or Source
  - Smart defaults: Match/Year sort descending, text columns ascending
  - Visual indicators (▲/▼) show current sort direction

### Technical
- New `AutoIndexManager` singleton using `Zotero.Notifier.registerObserver()` API
- Added `indexItemsSilent()` method for background indexing with progress window
- Fixed `setIcon` compatibility issue with Zotero's ProgressWindow API

---

## [1.4.0] - 2026-01-15

### Added
- **Zotero 7 Support** - Now compatible with both Zotero 7 (stable) and Zotero 8 (beta)
  - Extended `strict_min_version` from `7.999` to `6.999`
  - Same feature set across both versions
- **Full Paper Mode Default** - Full Document indexing is now the default for better search quality
- **Version-Aware Performance Warning** - Preferences panel shows performance note only on Zotero 7
  - Warns about slower WASM performance on Firefox 115
  - Hidden on Zotero 8 where performance is optimal

### Changed
- **Version-Aware Defaults** - Chunk size defaults optimized per Zotero version
  - Zotero 7: 800 tokens per chunk (faster on slower WASM)
  - Zotero 8: 2000 tokens per chunk (full speed)

### Known Issues
- **Zotero 7 Full Document Indexing is ~8-10x Slower** - Firefox 115 (Zotero 7) has significantly slower WASM SIMD performance than Firefox 140 (Zotero 8)
  - Abstract mode works at normal speed on both versions
  - Full Document mode on Zotero 7: ~6 seconds per chunk vs ~0.5 seconds on Zotero 8
  - Worker automatically limits chunks to 3000 chars on Zotero 7
  - **Recommendation:** Use Abstract mode on Zotero 7 for faster indexing, or upgrade to Zotero 8

### Technical
- **Automated Release Script** - New `npm run release` workflow
  - Interactive version bumping via bumpp
  - Auto-generates `update.json` from `package.json` version
  - Builds and packages XPI in one command
- **Version Sync** - `package.json` is now the source of truth for version
  - `manifest.json` and `update.json` are synced automatically
- **Zotero Version Detection** - Detects Firefox version via `Zotero.platformMajorVersion`
  - Passed to ChromeWorker for chunk size optimization
  - Used in preferences UI for conditional warning display
- **Improved Worker Error Handling** - Better error messages from ChromeWorker failures

---

## [1.3.0] - 2026-01-08

### Added
- **Search from PDF Selection** - Select text in PDF and right-click to find related documents
  - Appears in context menu when text is selected: "Find Related Documents"
  - Opens ZotSeek search dialog pre-filled with selected passage
  - Automatically excludes the current document from search results
  - Great for exploring concepts while reading
- **GPU Acceleration (Experimental)** - Automatic WebGPU detection for faster indexing
  - Up to 10-20x faster embeddings when WebGPU is available
  - Automatic fallback to CPU (WASM) when WebGPU is not supported
  - Check debug console for "Model loaded on GPU" or "Model loaded on CPU"
  - Note: Waiting for Zotero/Firefox to enable WebGPU (Firefox 141+ on Windows, macOS/Linux coming)

### Fixed
- **Scrolling on Windows** - Fixed VirtualizedTable scrolling in search dialogs on Windows
  - Results list now scrolls properly when content exceeds visible area
  - Affects both main ZotSeek search and "Find Similar Documents" dialogs

### Technical
- Added `createViewContextMenu` event listener for PDF reader text selection
- Search dialog now accepts `initialQuery` and `excludeItemId` parameters
- Added WebGPU detection with automatic fallback to WASM in embedding worker
- Used absolute positioning for bounded height in XUL windows (fixes CSS flex issues)

---

## [1.2.0] - 2026-01-05

### Added
- **Result Granularity Toggle** - Switch between two search result views in Full Document mode:
  - **By Section** (default): Aggregated results showing 1 result per paper with best matching section
  - **By Location**: All matching paragraphs with exact page & paragraph numbers and individual scores
- **References Filtering** - Bibliography sections are now automatically excluded from indexing
  - Detects section headers: "References", "Bibliography", "Works Cited", "Literature Cited"
  - Recognizes citation entry patterns: `[1]`, `Smith, J. (2021).`, DOI links
  - Stops indexing once references section is detected
- **Passage-Level Location** - Results in "By Location" mode show exact page and paragraph numbers
- **PDF Navigation** - Clicking a result in "By Location" mode opens PDF to the exact page

### Technical
- Added `returnAllChunks` option to search pipeline for parent-child retrieval pattern
- Added `chunkIndex` field to search results for unique chunk identification
- Implemented `computeAllChunkResultsFloat32()` for all-chunks mode in SearchEngine
- Modified RRF fusion to use `itemId-chunkIndex` composite key when returning all chunks
- Added `isReferencesHeader()` and `isReferenceEntry()` detection in chunker

---

## [1.1.0] - 2025-12-27

### Changed
- **Database Storage** - Moved from tables in Zotero's main database to separate `zotseek.sqlite` file
  - Uses SQLite ATTACH DATABASE pattern (inspired by Better BibTeX)
  - Keeps Zotero's main database clean and unbloated
  - Automatic migration from old schema (no user action required)
- **Menu Label** - Renamed "Index for ZotSeek" to "Index Selected for ZotSeek" for clarity

### Added
- **Database Path Display** - Settings panel now shows the database file location
- **Uninstall Cleanup** - Automatically removes database file and preferences on plugin uninstall

### Technical
- Database file stored at: `<Zotero Data Directory>/zotseek.sqlite`
- Migration copies data from old `zs_` tables, then drops them and runs VACUUM
- Added `getDatabasePath()` and `deleteDatabase()` methods to vector store

---

## [1.0.0] - 2025-12-26

### Initial Release 🎉

#### Core Features
- 🔍 **Semantic Search** - Find papers by meaning using local AI embeddings (nomic-embed-text-v1.5)
- 📚 **Find Similar Papers** - Right-click any paper to discover semantically related papers
- 🔎 **ZotSeek Search Dialog** - Search your library with natural language queries
- 🔗 **Hybrid Search** - Combines AI embeddings with Zotero's keyword search using RRF
  - Three search modes: Hybrid (recommended), Semantic Only, Keyword Only
  - Result indicators: 🔗 (both sources), 🧠 (semantic only), 🔤 (keyword only)
- 🗂️ **Flexible Indexing** - Index individual collections or entire library
  - Abstract mode: Fast, uses title + abstract only
  - Fulltext mode: Complete document analysis with section-aware chunking
- 🔒 **100% Local** - No data sent to cloud, works offline after model loads

#### Smart Features
- 📑 **Section-Aware Results** - Shows which section matched (Abstract, Methods, Results)
- 🎯 **Query Analysis** - Automatically adjusts weights based on query type
- ⚡ **Lightning Fast** - First search ~200ms, subsequent searches <50ms with caching
- 💾 **Smart Caching** - Pre-normalized Float32Arrays for instant searches
- 📊 **Stable Progress Tracking** - Reliable progress bars with ETA

#### Technical
- 🧠 **ChromeWorker Implementation** - Transformers.js runs in background thread
- 🛡️ **Rock-Solid SQLite** - Reliable parallel queries for Zotero 8
- ⚙️ **Settings Panel** - Easy configuration in Zotero preferences
- ❌ **Cancellation Support** - Cancel long-running operations anytime
