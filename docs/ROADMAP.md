# ZotSeek Roadmap

Potential improvements, feature ideas, and technical debt — gathered from GitHub issues, user feedback, and internal notes.

This is a living document. Items are loosely prioritized within each section but not committed to specific timelines.

## Completed

Features that have shipped. Kept here for reference.

| Feature | Version | Issue |
|---------|---------|-------|
| Sortable result columns (title, authors, year, score) | v1.5.0 | [#5](https://github.com/introfini/ZotSeek/issues/5) |
| Indexing checkpoints (saves every ~25 items, resumable) | v1.6.0 | [#7](https://github.com/introfini/ZotSeek/issues/7) |
| Multi-query boolean search (up to 4 queries, AND/OR) | v1.7.0 | [#9](https://github.com/introfini/ZotSeek/issues/9) |
| Multi-select & batch add to collection | v1.8.0 | [#11](https://github.com/introfini/ZotSeek/issues/11) |
| Tag-based exclusion (`zotseek-exclude`) | v1.9.0 | [#17](https://github.com/introfini/ZotSeek/issues/17) |
| Auto-cleanup on delete/trash | v1.9.0 | — |
| "Remove from ZotSeek Index" context menu | v1.9.0 | [#17](https://github.com/introfini/ZotSeek/issues/17) |
| Configurable auto-index delay (debounce, 1-300s) | next | [#21](https://github.com/introfini/ZotSeek/issues/21) |
| Pause/play and cancel during manual indexing | next | -- |
| Resilient embedding (skip failed chunks with retry) | next | [#19](https://github.com/introfini/ZotSeek/issues/19) |
| WebGPU detection with automatic CPU fallback | -- | [#2](https://github.com/introfini/ZotSeek/issues/2) |
| JavaScript API on `Zotero.ZotSeek.api` (search, findSimilar, indexItems, getStats) | -- | [#13](https://github.com/introfini/ZotSeek/issues/13) |
| Local MCP server for AI agents (`/zotseek/mcp`, opt-in, zotero:// deep links) | next | [#38](https://github.com/introfini/ZotSeek/issues/38) |
| Native REST endpoints (`/zotseek/search`, `/similar`, `/stats`) | next | [#32](https://github.com/introfini/ZotSeek/issues/32) |

## Performance & Indexing

### GPU-accelerated indexing
WebGPU detection and CPU fallback are already in place. Actual GPU acceleration is blocked on upstream: Zotero 8 ships Firefox 140 ESR, but WebGPU only landed in Firefox 141 (Windows-only). Linux and macOS support is still in progress at Mozilla. Once Zotero upgrades to an ESR with WebGPU, acceleration will activate automatically.

**Status:** Waiting on upstream (Zotero/Firefox ESR WebGPU support).

> GitHub: [#2](https://github.com/introfini/ZotSeek/issues/2)

### Portable index database
Make `zotseek.sqlite` portable between machines/profiles by using `item_key` (synced across libraries) instead of `item_id` (local numeric ID) as the primary lookup key. This would allow users to build the index on a fast machine and copy it elsewhere.

> GitHub: [#18](https://github.com/introfini/ZotSeek/issues/18)

## Search Features

### Nested boolean queries
Basic multi-query search (up to 4 fields, AND/OR) shipped in v1.7.0. Nested grouping like `(A OR B) AND (C OR D)` is not yet supported. Revisit if users need it.

> GitHub: [#9](https://github.com/introfini/ZotSeek/issues/9)

### HTTP API / CLI access
A JavaScript API exists on `Zotero.ZotSeek.api` for plugin-to-plugin use. A user requested an HTTP endpoint for CLI access and AI integration — e.g., embedding external text and querying the index from outside Zotero.

> GitHub: [#13](https://github.com/introfini/ZotSeek/issues/13)

## UI & UX

### Batch tagging from search results
Multi-select and "Add to Collection" are done (v1.8.0). Still missing: add tags to selected items directly from the search results context menu.

> GitHub: [#11](https://github.com/introfini/ZotSeek/issues/11)

### Localization / i18n
ZotSeek's own UI only has English strings — this is expected. However, a user reported that installing ZotSeek caused *other* plugins' strings (Translate for Zotero, Better Notes) and some built-in Zotero labels to switch to English. Needs investigation — may be a locale loading conflict.

> GitHub: [#16](https://github.com/introfini/ZotSeek/issues/16)

### macOS dock minimization
Indexing progress pane doesn't minimize properly when Zotero is in the macOS dock.

> GitHub: [#14](https://github.com/introfini/ZotSeek/issues/14)

## Technical Debt

### Consolidate chunking heuristics
The paragraph-based chunker has grown complex with section detection, token estimation, and page-aware splitting. Could benefit from a cleaner abstraction or configurable pipeline.

### Test coverage
Add automated tests for core components (vector store, search engine, chunker) to catch regressions, especially around edge cases in text extraction and embedding generation.

---

*Last updated: 2026-02-20*
