# Changelog

All notable changes to ZotSeek - Semantic Search for Zotero will be documented in this file.

## [Unreleased]

### Added
- **Chinese (zh-CN) Localization** - ZotSeek menus and dialogs now appear in Chinese for Chinese system users (may fix #16)
  - May also resolve locale interference with Better Notes and Translate for Zotero plugins

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
