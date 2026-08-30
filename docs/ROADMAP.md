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
| Configurable auto-index delay (debounce, 1-300s) | v1.10.0 | [#21](https://github.com/introfini/ZotSeek/issues/21) |
| Pause/play and cancel during manual indexing | v1.10.0 | — |
| Resilient embedding (skip failed chunks with retry) | v1.11.0 | [#19](https://github.com/introfini/ZotSeek/issues/19) |
| WebGPU detection with automatic CPU fallback | v1.3.0 | [#2](https://github.com/introfini/ZotSeek/issues/2) |
| JavaScript API on `Zotero.ZotSeek.api` (search, findSimilar, indexItems, getStats) | — | [#13](https://github.com/introfini/ZotSeek/issues/13) |
| Local MCP server for AI agents (`/zotseek/mcp`, opt-in, zotero:// deep links) | v1.16.0 | [#38](https://github.com/introfini/ZotSeek/issues/38) |
| Native REST endpoints (`/zotseek/search`, `/similar`, `/stats`) | v1.16.0 | [#32](https://github.com/introfini/ZotSeek/issues/32) |
| Portable index database (stable `(library_key, item_key)` identity, schema v8) | v1.14.0 | [#18](https://github.com/introfini/ZotSeek/issues/18) |
| Selectable local embedding models | v1.17.0 | [#37](https://github.com/introfini/ZotSeek/issues/37) |
| Group-library indexing (opt-in via `zotseek.indexScope`) | v1.18.0 | [#41](https://github.com/introfini/ZotSeek/issues/41) |
| Local inference server for embeddings | v1.19.0 | [#42](https://github.com/introfini/ZotSeek/issues/42) |
| Index several selected collections at once (Zotero 10) | next | — |
| Automatic database compaction during Zotero's idle maintenance (Zotero 10) | next | — |

## Performance & Indexing

### GPU-accelerated indexing
WebGPU detection and CPU fallback are already in place. Actual GPU acceleration is blocked on upstream: Zotero 8 ships Firefox 140 ESR, but WebGPU only landed in Firefox 141 (Windows-only). Linux and macOS support is still in progress at Mozilla. Once Zotero upgrades to an ESR with WebGPU, acceleration will activate automatically.

**Status:** Waiting on upstream (Zotero/Firefox ESR WebGPU support).

> GitHub: [#2](https://github.com/introfini/ZotSeek/issues/2)

## Search Features

### Nested boolean queries
Basic multi-query search (up to 4 fields, AND/OR) shipped in v1.7.0. Nested grouping like `(A OR B) AND (C OR D)` is not yet supported. Revisit if users need it.

> GitHub: [#9](https://github.com/introfini/ZotSeek/issues/9)

### HTTP API / CLI access
Shipped: the opt-in local server exposes MCP (`/zotseek/mcp`) and REST
(`/zotseek/search`, `/similar`, `/stats`) endpoints, documented in
[MCP.md](MCP.md). Still open from the original request: embedding *external*
text (text that is not already an item in the library) and querying with it.

> GitHub: [#13](https://github.com/introfini/ZotSeek/issues/13)

## UI & UX

### Batch tagging from search results
Multi-select and "Add to Collection" are done (v1.8.0). Still missing: add tags to selected items directly from the search results context menu.

> GitHub: [#11](https://github.com/introfini/ZotSeek/issues/11)

### Localization / i18n
ZotSeek's own UI only has English strings — this is expected. However, a user reported that installing ZotSeek caused *other* plugins' strings (Translate for Zotero, Better Notes) and some built-in Zotero labels to switch to English. Needs investigation — may be a locale loading conflict.

> GitHub: [#16](https://github.com/introfini/ZotSeek/issues/16)

### macOS dock minimization
Fixed, ships in the next release. Zotero 10 stopped the progress popup from floating over other applications, but on macOS it still lingered on screen when Zotero was minimized, because Firefox's Cocoa widget ignores the `dependent` window feature for top-level windows (Bugzilla [385714](https://bugzilla.mozilla.org/show_bug.cgi?id=385714), unfixed since 2007). ZotSeek now mirrors the main window's minimize/restore onto the popup itself (`src/utils/minimize-follower.ts`).

> GitHub: [#14](https://github.com/introfini/ZotSeek/issues/14)

## Technical Debt

### Consolidate chunking heuristics
The paragraph-based chunker has grown complex with section detection, token estimation, and page-aware splitting. Could benefit from a cleaner abstraction or configurable pipeline.

### Test coverage
Partially addressed.

- ✅ **Chunker** — 25 unit tests via `npm test` (102 across the whole suite),
  validated by mutation testing (widening the default token, character or chunk
  limits, changing the token estimate, or moving the abstract threshold all
  fail the suite).
- ✅ **Vector store** — covered by the in-Zotero self-test harness
  (`src/dev/suites/`), which needs a running Zotero and so cannot run in CI.
- ✅ **Model registry, collection resolution, loopback guard** — unit tested.
- ❌ **Search engine and hybrid search** — deliberately not unit tested. They
  need real embeddings and real Zotero items; mocking those produces tests that
  always pass and say nothing about retrieval quality. Measuring that is the
  eval framework's job.
- ⚠️ **Retrieval quality** — no regression net. The eval framework and its
  citation-pair dataset are not in the repository, so a change that quietly
  degrades search results would not be caught by anything.

---

*Last updated: 2026-08-30*
