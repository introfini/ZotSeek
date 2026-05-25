# CLAUDE.md - ZotSeek Development Guide

## Project Overview

ZotSeek is a Zotero plugin that provides AI-powered semantic search for academic libraries. It uses local embeddings (Transformers.js with ONNX Runtime) to find similar papers by meaning, not just keywords.

## Build Commands

```bash
# Build the plugin (compiles TypeScript, bundles with esbuild)
npm run build

# Build and restart Zotero (full dev cycle)
npm run build && osascript -e 'quit app "Zotero"' 2>/dev/null; sleep 2 && open -a Zotero --args -purgecaches -jsconsole
```

## Development Mode Installation (Proxy File Method)

Zotero plugins can be installed in dev mode using a "proxy file" that points to the build directory. This avoids packaging an XPI for every change.

**Critical**: XPI files take precedence over proxy files. If both exist, Zotero loads the XPI and ignores the proxy file.

### Quick Setup (One-liner)

For this project, with Zotero **closed**:

```bash
# Set profile path variable for convenience
PROFILE="/Users/josefernandes/Library/Application Support/Zotero/Profiles/ang8h3n7.default"

# Remove any existing XPI, clear caches, create proxy file
rm -f "$PROFILE/extensions/zotseek@zotero.org.xpi" && \
rm -f "$PROFILE/extensions.json" "$PROFILE/addonStartup.json.lz4" && \
rm -rf "$PROFILE/extensions/staged/zotseek@zotero.org" && \
printf '/Users/josefernandes/Dev/Zotero/zotseek/build\n' > "$PROFILE/extensions/zotseek@zotero.org"
```

Then start Zotero:
```bash
open -a Zotero --args -purgecaches -jsconsole
```

### Detailed Setup Steps

1. **Quit Zotero first** — Zotero may clean up proxy files if running during creation

2. **Find your Zotero profile directory:**
   ```bash
   # macOS
   ~/Library/Application Support/Zotero/Profiles/<profile-id>.default/
   ```

3. **Remove any installed XPI** (critical — XPI overrides proxy file):
   ```bash
   rm -f "<profile>/extensions/zotseek@zotero.org.xpi"
   ```

4. **Clear extension caches:**
   ```bash
   rm -f "<profile>/extensions.json"
   rm -f "<profile>/addonStartup.json.lz4"
   rm -rf "<profile>/extensions/staged/zotseek@zotero.org"
   ```

5. **Create the proxy file:**
   ```bash
   printf '/absolute/path/to/zotseek/build\n' > "<profile>/extensions/zotseek@zotero.org"
   ```

   Example for this project:
   ```bash
   printf '/Users/josefernandes/Dev/Zotero/zotseek/build\n' > "/Users/josefernandes/Library/Application Support/Zotero/Profiles/ang8h3n7.default/extensions/zotseek@zotero.org"
   ```

6. **Proxy file requirements:**
   - Filename must match plugin ID exactly (`zotseek@zotero.org`)
   - Contains absolute path to `build/` directory
   - Must end with newline (`\n`)
   - Must be a plain text file, not a directory

7. **Start Zotero with cache purge:**
   ```bash
   open -a Zotero --args -purgecaches -jsconsole
   ```

### Switching from XPI to Proxy File

If you've been testing with an XPI and want to switch to proxy mode:

```bash
# 1. Quit Zotero
osascript -e 'quit app "Zotero"' 2>/dev/null; sleep 2

# 2. Remove XPI and create proxy (full reset)
PROFILE="/Users/josefernandes/Library/Application Support/Zotero/Profiles/ang8h3n7.default"
rm -f "$PROFILE/extensions/zotseek@zotero.org.xpi"
rm -f "$PROFILE/extensions.json" "$PROFILE/addonStartup.json.lz4"
rm -rf "$PROFILE/extensions/staged/zotseek@zotero.org"
printf '/Users/josefernandes/Dev/Zotero/zotseek/build\n' > "$PROFILE/extensions/zotseek@zotero.org"

# 3. Restart Zotero
open -a Zotero --args -purgecaches -jsconsole
```

### Verifying Proxy Mode is Active

Use the MCP Zotero tools to check where the plugin is loading from:

```javascript
// In Zotero execute JS (via MCP)
(async () => {
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addons = await AddonManager.getAllAddons();
    const zotseek = addons.find(a => a.id === "zotseek@zotero.org");
    if (zotseek) {
        return zotseek.getResourceURI("manifest.json").spec;
        // Should show: file:///Users/.../zotseek/build/manifest.json
        // NOT: jar:file:///...zotseek@zotero.org.xpi!/manifest.json
    }
})();
```

### Troubleshooting

If the plugin doesn't load:

1. **Check for XPI override** — Most common issue:
   ```bash
   ls -la "<profile>/extensions/" | grep zotseek
   # Should show only: zotseek@zotero.org (text file)
   # NOT: zotseek@zotero.org.xpi
   ```

2. **Verify proxy file format:**
   ```bash
   xxd "<profile>/extensions/zotseek@zotero.org"
   # Should show path ending with 0a (newline), no extra characters
   ```

3. **Check manifest.json version compatibility:**
   ```json
   "strict_min_version": "6.999",
   "strict_max_version": "8.*"
   ```

4. **Full reset** — When in doubt, quit Zotero and run the one-liner above

## Project Structure

```
zotseek/
├── src/
│   ├── core/           # Search engine, vector store, embeddings
│   ├── ui/             # Dialog components (search, results table)
│   └── utils/          # Zotero API wrapper, helpers
├── content/            # Static assets (XHTML dialogs, CSS, icons)
├── locale/             # Localization strings
├── build/              # Compiled output (this is what Zotero loads)
├── manifest.json       # Plugin metadata and version constraints
├── bootstrap.js        # Plugin lifecycle (startup, shutdown)
└── prefs.js            # Default preferences
```

## Key Files

- `manifest.json` - Plugin ID, version, Zotero compatibility
- `bootstrap.js` - Entry point, registers chrome and loads main script
- `src/index.ts` - Main plugin initialization, default preferences
- `src/ui/search-dialog-vtable.ts` - Search dialog with VirtualizedTable
- `src/core/search-engine.ts` - Semantic search implementation
- `src/core/vector-store-sqlite.ts` - Embedding storage with SQLite (schema v8: `items` + `chunks` tables, stable cross-machine identity)
- `src/utils/chunker.ts` - Text chunking logic (paragraph-based, section-aware)

## Key Configuration Defaults

Set in `src/index.ts`. Zotero 7 support was dropped in v1.12.0, so the minimum runtime is now Zotero 8 (Firefox 140 ESR) and the defaults are no longer version-aware.

| Setting | Default | Notes |
|---------|---------|-------|
| `maxTokens` | 2000 | Chunk size ceiling (O(n²) attention); Firefox 140+ handles this efficiently |
| `maxChunksPerPaper` | 100 | Covers most full papers |
| `indexingMode` | "full" | Full paper is default |
| `autoIndexDelay` | 10 | Seconds to wait after last item before auto-indexing (1-300) |

**Version gate:** `manifest.json` uses `strict_min_version: "7.999"` (Z8+) and `strict_max_version: "9.*"` (Z9 OK).

**Chunking behavior:** `maxTokens` is a ceiling, not a target. Text is split at paragraph boundaries (`\n\n`). Oversized paragraphs (exceeding `maxTokens`) are split at sentence boundaries into multiple chunks. Token estimation: ~1.3 tokens per word.

For detailed chunking documentation, see `docs/SEARCH_ARCHITECTURE.md#chunking-strategy`.

## Database Schema (v8)

The database `zotseek.sqlite` is ATTACHed to Zotero's main DB connection under the schema name `zotseek`. `SCHEMA_VERSION = 8`. It uses two normalized tables:

**`items` table** (one row per paper):
- `item_pk` (PK, autoincrement), `library_key`, `item_key`, `title`, `abstract`, `model_id`, `indexed_at`, `content_hash`, `was_truncated`, `pages_indexed`, `pages_total`
- `UNIQUE(library_key, item_key)` — stable cross-machine identity. `library_key` is `'user'` or `'group:<groupID>'`; `item_key` is Zotero's 8-character `Item.key`.

**`chunks` table** (one row per embedding chunk):
- `item_pk` + `chunk_index` (composite PK, `item_pk` FK to `items`), `chunk_text`, `text_source`, `embedding` (base64 TEXT), `page_number`, `paragraph_index`, `start_char`, `end_char`, `bbox`

**Identity resolution:** Local `Zotero.Item.id` values are never stored. The `src/core/identity-resolver.ts` module maps between Zotero IDs and `(library_key, item_key)` pairs at runtime, so `zotseek.sqlite` can be copied between machines without re-indexing.

**Embedding format:** Base64-encoded Float32Array bytes (4,096 bytes for 768 dims). The `base64ToEmbedding()` method also handles legacy JSON format for backward compatibility.

**Migration history:** v4 (location columns) -> v5 (base64 embeddings) -> v6 (items + chunks normalization) -> v7 (per-item indexing status: `was_truncated`, `pages_indexed`, `pages_total`) -> v8 (stable cross-machine identity: `item_pk` autoincrement PK, `UNIQUE(library_key, item_key)`, chunks FK to `item_pk`). v7 → v8 resolves each row by its stored `item_key`; pre-migration backup at `zotseek.sqlite.v7.bak`.

**Zotero DB quirk:** `queryAsync()` can return empty results for multi-column SELECTs in Zotero 8. All read paths use parallel `columnQueryAsync()` calls as a workaround.

## Debugging

- **Error Console**: Start Zotero with `-jsconsole` flag
- **Debug output**: Plugin logs with `Zotero.debug("[ZotSeek] ...")`
- **Inspect UI**: Use Browser Toolbox (Tools > Developer > Browser Toolbox in Firefox-based Zotero)

## Common Pitfalls

### 1. No `console` in Plugin Context

**Problem**: `console is not defined` error during execution.

**Solution**: Use `Zotero.debug()` instead of `console.log()`:

```typescript
// BAD - will crash
console.log("Hello");

// GOOD
Zotero.debug("[ZotSeek] Hello");

// Or use the Logger utility class
this.logger.debug("Hello");
this.logger.info("Important message");
this.logger.error("Something went wrong", error);
```

### 2. Regex Lookbehind Not Supported

**Problem**: Regex with lookbehind `(?<=...)` causes silent failures in Zotero's SpiderMonkey engine.

**Solution**: Use alternative patterns without lookbehind:

```typescript
// BAD - lookbehind may not work
text.split(/(?<=[.!?])\s*\n/);

// GOOD - iterate and check conditions manually
const lines = text.split('\n');
for (const line of lines) {
  if (/[.!?]$/.test(previousLine)) {
    // Handle paragraph break
  }
}
```

### 3. Error Objects Log as `{}`

**Problem**: Catching errors shows empty `{}` in logs because Error objects don't serialize to JSON.

**Solution**: Extract message and stack explicitly:

```typescript
} catch (error: any) {
  const message = error?.message || error?.toString() || 'Unknown error';
  const stack = error?.stack || '';
  this.logger.error(`Failed: ${message}`);
  if (stack) Zotero.debug(stack);
}
```

### 4. Changes Not Appearing After Rebuild (XPI Override)

**Problem**: You rebuild the plugin, restart Zotero with `-purgecaches`, but your changes don't appear. This is extremely frustrating because the build succeeds and Zotero restarts cleanly.

**Root Cause**: An XPI file exists alongside your proxy file. XPI files **always** take precedence over proxy files, even with `-purgecaches`. The `-purgecaches` flag only clears certain caches, it doesn't change extension loading priority.

**How to Diagnose**: Check where the plugin is actually loading from:

```javascript
// Run via MCP zotero_execute_js or Browser Toolbox console
(async () => {
    const {AddonManager} = ChromeUtils.importESModule("resource://gre/modules/AddonManager.sys.mjs");
    const addons = await AddonManager.getAllAddons();
    const zotseek = addons.find(a => a.id === "zotseek@zotero.org");
    return zotseek?.getResourceURI("manifest.json").spec;
})();
```

**What the output means:**
- `file:///Users/.../zotseek/build/manifest.json` — Good! Loading from proxy file (dev mode)
- `jar:file:///...zotseek@zotero.org.xpi!/manifest.json` — Bad! Loading from XPI, changes ignored

**Solution**: Quit Zotero and run the full reset (see "Switching from XPI to Proxy File" section above):

```bash
PROFILE="/Users/josefernandes/Library/Application Support/Zotero/Profiles/ang8h3n7.default"
rm -f "$PROFILE/extensions/zotseek@zotero.org.xpi"
rm -f "$PROFILE/extensions.json" "$PROFILE/addonStartup.json.lz4"
rm -rf "$PROFILE/extensions/staged/zotseek@zotero.org"
printf '/Users/josefernandes/Dev/Zotero/zotseek/build\n' > "$PROFILE/extensions/zotseek@zotero.org"
```

**Prevention**: After creating a release XPI, always verify you're back in proxy mode before continuing development.

### 5. Plugin Reload Doesn't Pick Up Code Changes (Bytecode Cache)

**Problem**: You rebuild the plugin, reload it via `zotero_plugin_reload` or the Add-ons Manager, but the new code doesn't execute. Debug logging you just added never appears, and the plugin behaves as if running old code.

**Root Cause**: SpiderMonkey caches compiled bytecode for script files. The `plugin_reload` mechanism re-runs bootstrap lifecycle hooks (startup/shutdown) but does NOT invalidate the bytecode cache for the actual JavaScript files. The cached old version continues to execute.

**How to Diagnose**: Add a unique debug string (e.g., a timestamp or `Zotero.debug("[ZotSeek] BUILD 12345")`) to the code. After rebuild + reload, check if it appears in the debug log. If not, you're running cached code.

**Solution**: Quit Zotero and restart with `-purgecaches`:

```bash
osascript -e 'quit app "Zotero"' 2>/dev/null; sleep 3 && open -a Zotero --args -purgecaches -jsconsole
```

**When it matters**: Any time you change `.ts`/`.js` source files. Static files (XHTML, CSS, locale strings) may be picked up by a reload, but JavaScript requires a full restart with cache purge.

**Prevention**: Always use the full restart command (from "Build Commands" above) during development instead of relying on plugin reload for code changes.

### 6. Module-Level Functions vs Class Methods in IIFE Bundle

**Problem**: A new private class method added to ZotSeekPlugin doesn't appear on the runtime prototype in SpiderMonkey, even though it's in the esbuild output.

**Root Cause**: SpiderMonkey may not properly register all class methods from esbuild's minified IIFE output. This appears to be an engine-specific issue with how esbuild compiles anonymous class expressions.

**Solution**: For utility functions that don't need `this` access, use module-level functions instead of class methods:

```typescript
// BAD - may not appear on prototype
class ZotSeekPlugin {
  private hasExcludeTag(item: any): boolean { ... }
}

// GOOD - works reliably in IIFE scope
function hasExcludeTag(item: any): boolean { ... }
class ZotSeekPlugin { ... }
```

**Important**: In module-level functions, use `Zotero` global directly instead of `getZotero()`, which may return null outside the class context.

### 7. `ItemTreeManager.registerColumns` Quirks (Zotero 9)

**Problem**: `registerColumns()` returns `[false]` silently when validation fails; the column never appears and no exception is thrown.

**Common validation traps in Zotero 9**:

| Option | Wrong | Right |
|--------|-------|-------|
| `width` | `40` (number) | `'40'` (string) |
| `defaultIn` / `disableIn` | deprecated | `enabledTreeIDs: ['main']` |

**Diagnosing**: enable debug logging (`Zotero.Debug.init(true); Zotero.Debug.setStore(true)`), call `registerColumns`, then grep the debug log for `ItemTreeColumnManager`. The real error is one line, e.g. `Option ["width"] must be string, got number`.

**Hidden by default**: plugin-registered columns are added hidden, even with `enabledTreeIDs`. To auto-show on first install, call `itemsView.tree._columns.toggleHidden(idx)` where `idx` is the **numeric column index** (not the dataKey). Guard with a `firstShown` pref so the user can hide it permanently.

**Race at startup**: `ZoteroPane.itemsView.tree._columns` can lag behind `registerColumns` by a tick or two even after `Z.uiReadyPromise` resolves. Retry with 300ms backoff for ~10 tries.

### 8. Schema-Version Marker Can Lie About Migration State

**Problem**: A new migration (`migrateToV<N>`) is skipped by its own `if (currentVersion >= N) return` guard, but the new columns are missing.

**Root cause**: `createTables()` runs `updateSchemaVersion()` with the current `SCHEMA_VERSION` constant unconditionally, including when the underlying `CREATE TABLE IF NOT EXISTS` is a no-op on an already-existing table. So when you bump `SCHEMA_VERSION` from 6 to 7, a Zotero with a v6 database has its `schema_version` row set to "7" before `migrateToV7` ever runs.

**Solution**: each migration should detect its own done-ness by inspecting the schema directly (e.g. `PRAGMA table_info(items)` for column presence), not by reading `schema_version`. The version marker is a hint; the schema is ground truth.

### 9. ONNX Tensor Memory Leak in ChromeWorker

**Problem**: Zotero crashes during indexing, especially with many chunks per paper (e.g. maxTokens=512 producing ~100 chunks/paper). Users see Zotero become unresponsive and then quit.

**Root cause**: The `generateEmbedding()` function in `embedding-worker.ts` calls `embeddingPipeline()` which returns an ONNX tensor. After `Array.from(output.data)` copies the embedding values to a JS array, the underlying WASM-allocated tensor buffer is never freed. Each tensor holds ~3KB of WASM heap. After ~500 embeddings, the WASM heap exhausts and the worker crashes.

**Solution**: Call `output.dispose()` after extracting the data:
```typescript
const embedding = Array.from(output.data as Float32Array);
if (typeof output.dispose === 'function') output.dispose();
```

**Rule**: Any ONNX Runtime tensor returned by Transformers.js pipelines must be disposed after use. This applies to any future code that calls `embeddingPipeline()` or similar Transformers.js APIs.

### 10. Chunk Size Does Not Significantly Affect Search Quality

**Finding**: Benchmark comparing maxTokens=512 vs maxTokens=2000 on 486 citation-pair queries shows no meaningful quality difference (MRR 0.2514 vs 0.2550, delta <1%). Indexing speed in WASM is also similar when `maxChunksPerPaper` is high (both strategies hit the cap). The chunk size setting is effectively a no-op for most libraries.

**Data**: Full eval framework in `eval/` directory, results in `eval/data/eval-results.json`.

## Documentation Guidelines

When adding features, update the appropriate documentation files. Each file serves a different audience and level of detail:

### File Purposes

| File | Audience | Purpose |
|------|----------|---------|
| `README.md` | End users | What features do and when to use them |
| `CHANGELOG.md` | Users & devs | Version history, what changed |
| `docs/SEARCH_ARCHITECTURE.md` | Developers | Deep technical docs: search algorithms, chunking strategy, data flow |
| `docs/DEVELOPMENT.md` | Contributors | Dev setup, ChromeWorker details, Transformers.js |
| `CLAUDE.md` | AI assistants | Quick reference for building/debugging, key defaults |

### When to Update Each File

**README.md** - Update when:
- Adding user-visible features (new buttons, modes, options)
- Changing behavior users will notice
- Adding new configuration options

What to include:
- Feature name and brief description
- When/why to use it
- Add to Features list if significant
- Add new section if feature needs explanation

**CHANGELOG.md** - Update when:
- Any release-worthy change
- Format: `## [X.Y.Z] - YYYY-MM-DD`

What to include:
- User-facing changes under `### Added`, `### Changed`, `### Fixed`
- Technical changes under `### Technical` (for developers)
- Be specific: "Added result granularity toggle" not "Updated search"

**docs/SEARCH_ARCHITECTURE.md** - Update when:
- Changing search algorithms or data flow
- Adding new search modes or options
- Modifying chunking strategy, embedding, or ranking logic
- Changing default configuration values

What to include:
- ASCII diagrams showing data flow
- Algorithm explanations with examples
- Configuration options and their effects (especially chunking trade-offs)
- Update Table of Contents when adding sections

**docs/DEVELOPMENT.md** - Update when:
- Changing build process or dependencies
- Adding new worker threads or async patterns
- Modifying ChromeWorker or Transformers.js integration

**CLAUDE.md** - Update when:
- Adding new common pitfalls or gotchas
- Changing project structure significantly
- Adding development shortcuts or commands
- Changing key default configuration values (update the defaults table)

### Documentation Style

- Use tables for options/modes comparisons
- Use ASCII diagrams for data flow (renders in GitHub)
- Keep README.md concise, link to detailed docs
- Include code examples in technical docs
- Update version numbers in CHANGELOG.md only

## Git Commit Guidelines

- **NEVER** add `Co-Authored-By` lines to commit messages
- **NEVER** add Claude or AI attribution in commits (causes unwanted GitHub contributors)

### Commit Message Format

```
Short summary line (imperative mood, ~50 chars)

- Bullet point with specific change
- Another change
- More details as needed

Note: Optional context or caveats (if relevant)
```

### Examples

```
Add Zotero 7 support with version-aware performance optimizations

- Extend compatibility to Zotero 7 (strict_min_version: 6.999)
- Make Full Paper mode the default indexing mode
- Add version-aware defaults (800 tokens on Z7, 2000 on Z8)
- Show performance warning only on Zotero 7 in preferences

Note: Full Document indexing is ~8-10x slower on Zotero 7 (Firefox 115)
compared to Zotero 8 (Firefox 140+) due to WASM SIMD performance.
```

```
Fix scrolling in VirtualizedTable dialogs on Windows

Use absolute positioning for results container to create bounded
dimensions from XUL flex parent. Enable scrolling in .tree-children
element which is VirtualizedTable's internal scrollable area.

- Add position: relative to .virtualized-table-container
- Use position: absolute on results containers for bounded height
- Set overflow-y: auto on .tree-children for scrolling
```

```
Add PDF text selection search with "Find Related Documents"

- Add context menu item when text is selected in PDF reader
- Pre-fill search dialog with selected passage
- Automatically exclude current document from results
- Uses createViewContextMenu event from Zotero Reader API
```

## GitHub Release Format

When creating a GitHub release, use this format:

### Release Title
```
vX.Y.Z — Short Feature Summary & Another Feature
```

Examples:
- `v1.2.0 — Passage-Level Search & References Filtering`
- `v1.3.0 — PDF Selection Search & Windows Scrolling Fix`

### Release Body Template

```markdown
## What's New

### 📄 Feature Name
Brief description of the feature:
- Bullet point details
- How to use it
- Benefits

### ⚡ Another Feature
Description with optional table:

| Column 1 | Column 2 |
|----------|----------|
| **Option A** | What it does |
| **Option B** | What it does |

> **Note:** Any important caveats or future plans

### 🐛 Bug Fix Name
What was fixed:
- Details about the fix
- What was affected

---

## Installation

1. Download `zotseek-X.Y.Z.xpi` below
2. In Zotero: Tools → Plugins → ⚙️ → Install Plugin From File
3. Select the downloaded `.xpi` file
4. Restart Zotero

---

## ⚠️ Upgrade Notes

Any required actions, or "No action required" if none.

---

**Full Changelog:** [`vPREV...vCURR`](../../compare/vPREV...vCURR)
```

### Emoji Guide for Features
- 📄 Document/file features
- ⚡ Performance improvements
- 🐛 Bug fixes
- 🔒 Privacy/security
- 🚫 Filtering/exclusion features
- 📍 Location/navigation features

## Release Process

### Quick Release

```bash
npm run release
```

This interactive script handles everything:
1. **Version bump** — Prompts via bumpp (patch/minor/major/custom)
2. **Sync files** — Updates `package.json`, `manifest.json`, auto-generates `update.json`
3. **Build** — Compiles TypeScript and bundles with esbuild
4. **Package** — Creates `zotseek-X.Y.Z.xpi` in project root

### After the Script

```bash
git add -A && git commit -m "Release vX.Y.Z"
git tag vX.Y.Z
git push && git push --tags
```

Then create GitHub release at `https://github.com/introfini/ZotSeek/releases/new`:
1. Select the tag you just pushed
2. Use release title format: `vX.Y.Z — Feature Summary`
3. Upload `zotseek-X.Y.Z.xpi`
4. Publish release

### Version Source of Truth

- **`package.json`** is the source of truth for version (bumpp reads/writes here)
- **`manifest.json`** is synced automatically by the release script
- **`update.json`** is auto-generated (never edit manually)

### Pitfall: `package.json` and `manifest.json` Can Drift Out of Sync

**Problem**: Running `npx bumpp --release patch` bumps `package.json` based on its own current value. If a previous release was hand-edited or aborted partway, `package.json` may be behind `manifest.json` (e.g. `package.json` at 1.13.1, `manifest.json` at 1.14.0). A patch bump then produces 1.13.2, not 1.14.1 — the result looks like a downgrade.

**How to detect**: Before bumping, compare:
```bash
grep '"version"' package.json
grep '"version"' manifest.json
```

**Solution**: If they disagree, set both to the same baseline before bumping, or skip bumpp and set `package.json`, `package-lock.json`, `manifest.json`, and `update.json` explicitly to the target version. The release script trusts `package.json` as the source of truth, so getting that right first is enough.

**Prevention**: After every release, verify `git diff HEAD~1 -- package.json manifest.json` shows both files moved to the same new version.

### Files Modified by Release Script

| File | Action |
|------|--------|
| `package.json` | Version bumped by bumpp |
| `manifest.json` | Version synced from package.json |
| `update.json` | Auto-generated with correct download URL |
| `zotseek-X.Y.Z.xpi` | Created in project root |

### Auto-Update URL

Zotero fetches updates from:
```
https://raw.githubusercontent.com/introfini/zotseek/main/update.json
```

**Important**: Push `update.json` to `main` branch for users to receive update notifications.
