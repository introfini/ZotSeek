# ZotSeek Plugin - Development Guide

> **📝 Disclaimer:** This is a development journal documenting lessons learned while building ZotSeek. It contains hard-won insights about Zotero 8 plugin development, ChromeWorker + Transformers.js integration, and SQLite quirks. Some information may be version-specific. Use as a reference, not a step-by-step tutorial.
>
> **Contributions welcome!** If you find errors or have improvements, please open an issue or PR.

---

A guide for building Zotero 8+ plugins with TypeScript, featuring lessons learned from running **Transformers.js v3** with local AI embeddings.

**Key Achievement:** This plugin runs **nomic-embed-text-v1.5** (8K tokens, 768 dims) in Zotero via ChromeWorker - see [ChromeWorker + Transformers.js Solution](#chromeworker--transformersjs-solution).

---

## Table of Contents

1. [Prerequisites](#prerequisites)
2. [Understanding Zotero Plugins](#understanding-zotero-plugins)
3. [Project Setup](#project-setup)
4. [Plugin Architecture](#plugin-architecture)
5. [Core Modules Explained](#core-modules-explained)
6. [Building the Plugin](#building-the-plugin)
7. [Testing in Zotero](#testing-in-zotero)
8. [Development Workflow](#development-workflow)
9. [Common Patterns](#common-patterns)
10. [Debugging & Console Output](#debugging--console-output)
11. [Troubleshooting](#troubleshooting)
12. [Lessons Learned](#lessons-learned)
13. [Resources](#resources)
14. [Hybrid Search Implementation](#hybrid-search-implementation)

---

## Prerequisites

Before starting, ensure you have:

```bash
# Node.js 18 or higher
node --version  # Should output v18.x.x or higher

# npm (comes with Node.js)
npm --version

# Zotero 8 or newer installed
# Download from: https://www.zotero.org/download/
```

### Recommended Tools

- **VS Code** or **Cursor** - IDE with TypeScript support
- **Zotero 8+** - The target platform (based on Firefox 140 ESR)
- **Git** - Version control

---

## Understanding Zotero Plugins

### What is a Zotero Plugin?

Zotero plugins are **bootstrapped extensions** that run inside Zotero's JavaScript environment. They can:

- Access Zotero's internal APIs (items, collections, full-text search)
- Modify the UI (add panels, menus, buttons)
- React to events (item added, selection changed)
- Store data (preferences, IndexedDB)

### Key Concepts

| Concept | Description |
|---------|-------------|
| **Bootstrap Extension** | A plugin pattern where lifecycle is managed via `bootstrap.js` |
| **Manifest** | `manifest.json` defines plugin metadata (no `main` field needed!) |
| **Root URI** | The base path to your plugin's files at runtime |
| **Zotero Pane** | The main Zotero window where items are displayed |

### Zotero 8+ Runtime

| Feature | Zotero 8+ |
|---------|-----------|
| Firefox Base | 140 ESR |
| Modules | ESM (.mjs) |
| Promises | Native JS |
| manifest.json | ✅ |

### Version Compatibility

ZotSeek targets Zotero 8 and newer:

```json
{
  "applications": {
    "zotero": {
      "strict_min_version": "7.999",
      "strict_max_version": "9.*"
    }
  }
}
```

> ⚠️ This guide targets **Zotero 8 and 9**. Earlier Zotero versions use a different structure and are no longer supported.

---

## Project Setup

### Step 1: Initialize the Project

```bash
mkdir zotseek
cd zotseek
npm init -y
```

### Step 2: Install Dependencies

```bash
# Development dependencies
npm install -D typescript esbuild @types/node

# Runtime dependencies (bundled into plugin)
npm install @huggingface/transformers
```

| Package | Purpose |
|---------|---------|
| `typescript` | TypeScript compiler for type checking |
| `esbuild` | Fast bundler that compiles TS → JS |
| `@huggingface/transformers` | Run ML models via ChromeWorker (v3 with 8K context models) |

> **Note:** We use `@huggingface/transformers` v3.8.1+ (not the older `@xenova/transformers` v2). Version 3.7+ includes critical fixes for ChromeWorker compatibility via the `wasmPaths` configuration.

> **Note:** We don't use `idb` because IndexedDB is not available in Zotero's privileged context. Instead, we use SQLite via `Zotero.DB` APIs for persistent storage.

### Step 3: Configure TypeScript

Create `tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "moduleResolution": "node",
    "lib": ["ES2020", "DOM"],
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "declaration": false,
    "outDir": "./build",
    "rootDir": "./src",
    "resolveJsonModule": true,
    "noEmit": true,
    "allowSyntheticDefaultImports": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "build"]
}
```

Key settings:
- `target: ES2020` - Firefox 140 supports modern JS
- `module: ESNext` - Use ES modules (esbuild will bundle)
- `noEmit: true` - TypeScript only type-checks; esbuild compiles

### Step 4: Create the Manifest

Create `manifest.json`:

```json
{
  "manifest_version": 2,
  "name": "ZotSeek - Semantic Search for Zotero",
  "version": "0.1.0",
  "description": "Semantic search using local AI embeddings",
  "author": "Your Name",
  "icons": {
    "48": "content/icons/icon48.png",
    "96": "content/icons/icon96.png"
  },
  "applications": {
    "zotero": {
      "id": "zotseek@zotero.org",
      "update_url": "https://example.com/update.json",
      "strict_min_version": "7.999",
      "strict_max_version": "9.*"
    }
  }
}
```

Important fields:
- `applications.zotero.id` - Unique identifier for your plugin
- `strict_min_version` / `strict_max_version` - Zotero version range

> ⚠️ **Do NOT include a `main` field** - Zotero doesn't use it. The script is loaded via `bootstrap.js`.

### Step 5: Create the Bootstrap File

Create `bootstrap.js` (must be plain JavaScript). This pattern is based on the official [Make It Red](https://github.com/zotero/make-it-red) example and working plugins like BetterNotes:

```javascript
/**
 * Bootstrap file - manages plugin lifecycle
 * Based on Zotero's Make It Red example
 */

var chromeHandle;

function install(data, reason) {}

async function startup({ id, version, resourceURI, rootURI }, reason) {
  // Wait for Zotero to initialize
  await Zotero.initializationPromise;

  // Register chrome content (required for content:// URLs)
  var aomStartup = Components.classes[
    "@mozilla.org/addons/addon-manager-startup;1"
  ].getService(Components.interfaces.amIAddonManagerStartup);
  var manifestURI = Services.io.newURI(rootURI + "manifest.json");
  chromeHandle = aomStartup.registerChrome(manifestURI, [
    ["content", "zotseek", rootURI + "content/"],
  ]);

  // Create context for the plugin script
  const ctx = {
    rootURI,
    Zotero,
    document: Zotero.getMainWindow()?.document,
  };
  ctx._globalThis = ctx;

  // Load the main script into the context
  Services.scriptloader.loadSubScript(
    `${rootURI}content/scripts/index.js`,
    ctx
  );

  // Initialize the plugin (it attaches itself to Zotero.ZotSeek)
  if (Zotero.ZotSeek) {
    Zotero.ZotSeek.setInfo({ id, version, rootURI });
    await Zotero.ZotSeek.hooks.onStartup();
  }
}

function onMainWindowLoad({ window: win }) {
  Zotero.ZotSeek?.hooks.onMainWindowLoad(win);
}

function onMainWindowUnload({ window: win }) {
  Zotero.ZotSeek?.hooks.onMainWindowUnload(win);
}

function shutdown({ id, version, resourceURI, rootURI }, reason) {
  if (reason === APP_SHUTDOWN) return;

  Zotero.ZotSeek?.hooks.onShutdown();

  if (chromeHandle) {
    chromeHandle.destruct();
    chromeHandle = null;
  }
}

function uninstall(data, reason) {}
```

The bootstrap lifecycle hooks (from [Plugin Lifecycle docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/plugin-lifecycle.html)):

| Hook | Triggered when... | Description |
|------|-------------------|-------------|
| `install()` | Plugin is installed or updated | Set up initial configurations |
| `startup()` | Plugin is being loaded | Initialize everything needed |
| `shutdown()` | Plugin is being unloaded | Clean up resources |
| `uninstall()` | Plugin is being uninstalled | Perform cleanup for uninstallation |
| `onMainWindowLoad()` | Main window opens (can happen multiple times) | Initialize UI changes |
| `onMainWindowUnload()` | Main window closes (can happen multiple times) | Remove window-specific changes |

> ⚠️ **Critical insight from docs:** "If the main Zotero window is already open when your plugin loads, `onMainWindowLoad` won't be called on the existing windows."
>
> **Solution:** Call `onMainWindowLoad` manually for existing windows:
> ```javascript
> async function startup(data, reason) {
>   // ... initialization ...
>
>   // Call onMainWindowLoad for any existing windows
>   await Promise.all(
>     Zotero.getMainWindows().map((win) => onMainWindowLoad(win))
>   );
> }
> ```
>
> Or simply register UI in `startup()` after `uiReadyPromise` (our approach).

---

## Plugin Architecture

### Directory Structure

```
zotseek/
├── src/                      # TypeScript source code
│   ├── index.ts              # Main entry point
│   ├── core/                 # Core functionality
│   │   ├── embedding-pipeline.ts
│   │   ├── search-engine.ts
│   │   ├── storage-factory.ts
│   │   ├── text-extractor.ts
│   │   └── vector-store-sqlite.ts
│   └── utils/                # Utilities
│       ├── logger.ts
│       └── zotero-api.ts
│
├── content/                  # Static content (copied to build)
│   ├── icons/                # Plugin icons
│   └── overlay.xhtml         # UI overlays
│
├── locale/                   # Localization
│   └── en-US/
│       └── zotseek.dtd
│
├── skin/                     # Styles
│   └── default/
│       └── styles.css
│
├── scripts/                  # Build scripts
│   └── build.js
│
├── build/                    # Build output (generated)
├── bootstrap.js              # Zotero lifecycle (plain JS)
├── manifest.json             # Plugin metadata
├── package.json
└── tsconfig.json
```

### Data Flow

```
Indexing:  User → TextExtractor → EmbeddingPipeline (768-dim) → SQLite
Searching: Query → Embed → Cosine Similarity → Results
```

---

## Core Modules Explained

### 1. Entry Point (`src/index.ts`)

The main file that:
- Gets the Zotero object via helper function
- Attaches plugin to `Zotero` global
- Provides hooks for bootstrap.js

```typescript
// Declare globals from bootstrap context
declare const _globalThis: any;
declare const Zotero: any;
declare const ChromeUtils: any;

// Helper to get Zotero object (handles IIFE scope issues)
function getZotero(): any {
  if (typeof _globalThis !== 'undefined' && _globalThis.Zotero) {
    return _globalThis.Zotero;
  }
  if (typeof Zotero !== 'undefined') {
    return Zotero;
  }
  // Zotero 8 fallback
  try {
    const { Zotero: Z } = ChromeUtils.importESModule(
      'chrome://zotero/content/zotero.mjs'
    );
    return Z;
  } catch (e) {
    return null;
  }
}

class ZotSeekPlugin {
  // Hooks for bootstrap.js to call
  public hooks = {
    onStartup: () => this.onStartup(),
    onShutdown: () => this.onShutdown(),
    onMainWindowLoad: (win: Window) => this.onMainWindowLoad(win),
    onMainWindowUnload: (win: Window) => this.onMainWindowUnload(win),
  };

  async onStartup() {
    const Z = getZotero();
    await Z.uiReadyPromise;
    // Register UI here (window is already open)
    const win = Z.getMainWindow();
    if (win) this.registerContextMenu(win);
  }

  onShutdown() { /* cleanup */ }
  onMainWindowLoad(win: Window) { /* optional */ }
  onMainWindowUnload(win: Window) { /* cleanup UI */ }
}

// Create instance and attach to Zotero global
const addon = new ZotSeekPlugin();
const Z = getZotero();
if (Z) Z.ZotSeek = addon;
```

### 2. Vector Store (`src/core/vector-store-sqlite.ts`)

Manages persistent storage of embeddings using **SQLite** (IndexedDB is not available in Zotero's privileged context):

```typescript
interface PaperEmbedding {
  itemId: number;           // Zotero item ID
  chunkIndex: number;       // 0 = summary, 1+ = fulltext chunks
  itemKey: string;          // Zotero item key
  libraryId: number;
  title: string;
  embedding: number[];      // 768-dimensional vector (nomic-embed-v1.5)
  modelId: string;          // Which model generated this
  contentHash: string;      // Detect content changes
}
```

**SQLite Benefits:**
- **O(1) lookups** - Indexed by itemId, instant retrieval
- **Lower memory** - Loads on demand with smart caching
- **Atomic updates** - Single row INSERT/UPDATE
- **In-memory caching** - Pre-normalized Float32Arrays for 4-5x faster searches
- **Uses Zotero's main database** - Tables with `ss_` prefix, no separate files

**Implementation details:**
```typescript
// Tables are created directly in Zotero's main database with ss_ prefix
await Zotero.DB.queryAsync(`
  CREATE TABLE IF NOT EXISTS ss_embeddings (
    item_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    item_key TEXT NOT NULL,
    library_id INTEGER NOT NULL,
    title TEXT NOT NULL,
    abstract TEXT,
    text_source TEXT NOT NULL,
    embedding TEXT NOT NULL,  -- JSON string of 384 floats
    model_id TEXT NOT NULL,
    indexed_at TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (item_id, chunk_index)
  )
`);

// Indexed for fast lookups
await Zotero.DB.queryAsync(`
  CREATE INDEX IF NOT EXISTS ss_idx_library_id ON ss_embeddings(library_id)
`);
```

**Note:** We store embeddings as JSON strings (`TEXT`) instead of binary blobs because Zotero's SQLite bindings don't handle ArrayBuffer well.

### 3. Embedding Pipeline (`src/core/embedding-pipeline.ts`)

Generates text embeddings using Transformers.js via **ChromeWorker** (see [ChromeWorker + Transformers.js Solution](#chromeworker--transformersjs-solution) below for the full implementation details).

```typescript
// Main thread - delegates to ChromeWorker
class EmbeddingPipeline {
  private worker: ChromeWorker | null = null;

  async init() {
    // Create ChromeWorker with bundled Transformers.js
    this.worker = new ChromeWorker(
      'chrome://zotseek/content/scripts/embedding-worker.js'
    );

    // Wait for model to load
    await this.sendWorkerMessage({ type: 'init' });
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.sendWorkerMessage({
      type: 'embed',
      data: { text }
    });
    return result.embedding;  // 384-dimensional vector
  }
}
```

Key concepts:
- **ChromeWorker** - Runs Transformers.js v3 in separate thread with privileged access
- **Feature extraction** - Converts text to 768-dimensional vectors (nomic-embed-text-v1.5)
- **8192 token context** - 16x larger than bge-small (512 tokens), enabling full-document embeddings
- **Instruction prefixes** - Uses `search_document:` for indexing, `search_query:` for queries
- **Quantized model** - Smaller, faster (~131MB quantized)
- **Mean pooling** - Averages token embeddings with normalization
- **Matryoshka embeddings** - 768 dims can be truncated to 256/128 with minimal quality loss
- **~200-300ms per embedding** - Fast enough for interactive use
- **wasmPaths configuration** - Critical for v3 to work in ChromeWorker (bypasses dynamic import)

### 4. Search Engine (`src/core/search-engine.ts`)

Performs similarity search using cosine similarity:

```typescript
class SearchEngine {
  async search(query: string): Promise<SearchResult[]> {
    // 1. Embed the query
    const queryVector = await this.pipeline.embed(query);

    // 2. Get all stored embeddings
    const papers = await this.store.getAll();

    // 3. Compute similarities
    const results = papers.map(paper => ({
      ...paper,
      similarity: this.cosineSimilarity(queryVector, paper.embedding)
    }));

    // 4. Sort and return top K
    return results
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 20);
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }
}
```

### 5. Text Extractor (`src/core/text-extractor.ts`)

Extracts text from Zotero items:

```typescript
class TextExtractor {
  async extractText(item: ZoteroItem) {
    const title = item.getField('title');
    const abstract = item.getField('abstractNote');

    // Prefer abstract if available
    if (abstract.length > 50) {
      return { text: `${title}\n\n${abstract}`, source: 'abstract' };
    }

    // Fallback to full-text from PDF
    const fullText = await Zotero.Fulltext.getItemContent(attachmentId);
    if (fullText) {
      return { text: `${title}\n\n${fullText}`, source: 'fulltext' };
    }

    // Last resort: title only
    return { text: title, source: 'title_only' };
  }
}
```

### 6. Zotero API Wrapper (`src/utils/zotero-api.ts`)

Type-safe access to Zotero's internal APIs:

```typescript
class ZoteroAPI {
  getSelectedItems(): ZoteroItem[] {
    return Zotero.getActiveZoteroPane().getSelectedItems();
  }

  async getCollectionItems(collectionId: number): Promise<ZoteroItem[]> {
    const collection = await Zotero.Collections.get(collectionId);
    return collection.getChildItems(false);
  }

  selectItem(itemId: number) {
    Zotero.getActiveZoteroPane().selectItem(itemId);
  }
}
```

Common Zotero APIs:
- `Zotero.Items.get(id)` - Get item by ID
- `Zotero.Collections.get(id)` - Get collection
- `Zotero.Fulltext.getItemContent(id)` - Get indexed full-text
- `Zotero.Prefs.get/set(key, value)` - Plugin preferences

---

## Building the Plugin

### Build Script (`scripts/build.js`)

```javascript
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

async function build() {
  // 1. Bundle TypeScript to JavaScript
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    outfile: 'build/content/scripts/index.js',
    format: 'iife',                    // Immediately invoked function
    globalName: 'ZotSeek', // Global variable name
    platform: 'browser',
    target: ['firefox140'],            // Zotero 8's Firefox ESR
    minify: process.env.NODE_ENV === 'production',
  });

  // 2. Copy static files
  fs.cpSync('content', 'build/content', { recursive: true });
  fs.cpSync('locale', 'build/locale', { recursive: true });
  fs.cpSync('skin', 'build/skin', { recursive: true });
  fs.copyFileSync('manifest.json', 'build/manifest.json');
  fs.copyFileSync('bootstrap.js', 'build/bootstrap.js');
}

build();
```

### Build Commands

Add to `package.json`:

```json
{
  "scripts": {
    "build": "node scripts/build.js",
    "build:dev": "node scripts/build.js --dev",
    "watch": "node scripts/build.js --watch"
  }
}
```

Run:

```bash
npm run build      # Production build
npm run build:dev  # Development build (with sourcemaps)
npm run watch      # Watch mode for development
```

---

## Build Tools: Custom Build vs zotero-plugin-scaffold

When building a Zotero plugin, you have two main approaches: a **custom build script** (like this project uses) or the **zotero-plugin-scaffold** tool from the community.

### Comparison

| Feature | **zotero-plugin-scaffold** | **Custom Build Script** |
|---------|----------------------------|-------------------------|
| **Hot Reload** | ✅ `zotero-plugin serve` - auto-reload on changes | ❌ Manual restart required |
| **Testing** | ✅ `zotero-plugin test` - integrated testing | ❌ Manual testing |
| **Release** | ✅ `zotero-plugin release` - auto XPI + update.json | ❌ Manual XPI creation |
| **GitHub Integration** | ✅ Auto-generates release files | ❌ Manual |
| **Build Config** | Single `zotero-plugin.config.ts` | Custom `scripts/build.js` |
| **Custom Builds** | ⚠️ Limited via `esbuildOptions` | ✅ Full control |
| **Learning Curve** | Medium (new tool) | Low (direct esbuild) |
| **Complex Requirements** | ⚠️ May need workarounds | ✅ Fully customizable |

### When to Use zotero-plugin-scaffold

The scaffold is excellent for:
- **Starting new plugins** from scratch
- Plugins with **standard structure** (single entry point)
- Need for **release automation** (GitHub releases, update.json)
- **Team projects** where standardization helps
- When **hot-reload** significantly improves your workflow

```bash
# Using the scaffold
npm install -D zotero-plugin-scaffold
```

```typescript
// zotero-plugin.config.ts
import { defineConfig } from "zotero-plugin-scaffold";

export default defineConfig({
  source: ["src", "addon"],
  dist: ".scaffold/build",
  name: "My Plugin",
  id: "my-plugin@example.org",
  build: {
    esbuildOptions: [
      {
        entryPoints: ["src/index.ts"],
        bundle: true,
        target: "firefox115",
        outfile: ".scaffold/build/addon/content/scripts/index.js",
      },
    ],
  },
});
```

```json
// package.json scripts with scaffold
{
  "scripts": {
    "start": "zotero-plugin serve",
    "build": "zotero-plugin build",
    "release": "zotero-plugin release",
    "test": "zotero-plugin test"
  }
}
```

### When to Use Custom Build Script

A custom build script is better for:
- **Complex requirements** like this plugin (ChromeWorker + Transformers.js)
- **Multiple entry points** (main bundle, worker bundle, dialog bundles)
- **Bundled assets** like AI models (23MB model files)
- **Custom polyfills** needed for privileged context
- When you need **full control** over the build process

This plugin has unique requirements that would require extensive scaffold customization:

1. **ChromeWorker bundle** - Separate entry point with Transformers.js
2. **Multiple dialog bundles** - `search-dialog-vtable.js`, `similar-documents-dialog.js`
3. **Bundled AI model** - 23MB model files in `content/models/`
4. **Custom polyfills** - Banner for `self`/`navigator` in privileged context

```javascript
// scripts/build.js - Custom build with multiple entry points
const buildOptions = [
  { entryPoints: ['src/index.ts'], outfile: 'build/content/scripts/index.js' },
  { entryPoints: ['src/worker/embedding-worker.ts'], outfile: 'build/content/scripts/embedding-worker.js' },
  { entryPoints: ['src/ui/search-dialog-vtable.ts'], outfile: 'build/content/scripts/search-dialog-vtable.js' },
];

for (const opts of buildOptions) {
  await esbuild.build({ ...commonOptions, ...opts });
}
```

### Recommendation

| Scenario | Recommendation |
|----------|----------------|
| New standard plugin | Use **zotero-plugin-scaffold** |
| Complex/specialized plugin | Use **custom build script** |
| Need hot-reload badly | Use **scaffold** or add file watcher to custom |
| Learning Zotero development | **Custom** (more educational) |
| Team with varying experience | **Scaffold** (standardized) |

For this semantic search plugin with ChromeWorker + Transformers.js, the custom build script provides necessary flexibility. For simpler plugins, the scaffold offers better developer experience.

### Resources

- [zotero-plugin-scaffold](https://github.com/northword/zotero-plugin-scaffold) - Build tool with hot-reload
- [zotero-plugin-template](https://github.com/windingwind/zotero-plugin-template) - Starter template using scaffold
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - Utility APIs for plugins

---

## Testing in Zotero

### Method 1: Extension Proxy File (Recommended for Development)

1. **Find your Zotero profile directory:**
   - macOS: `~/Library/Application Support/Zotero/Profiles/XXXXXXXX.default/`
   - Windows: `%APPDATA%\Zotero\Zotero\Profiles\XXXXXXXX.default\`
   - Linux: `~/.zotero/zotero/XXXXXXXX.default/`

2. **Create the extensions folder** (if it doesn't exist):
   ```bash
   mkdir -p ~/Library/Application\ Support/Zotero/Profiles/XXXXXXXX.default/extensions
   ```

3. **Create a proxy file** named after your extension ID:
   ```bash
   # The filename is your extension ID from manifest.json
   echo "/Users/yourname/Dev/zotseek/build" > \
     ~/Library/Application\ Support/Zotero/Profiles/XXXXXXXX.default/extensions/zotseek@zotero.org
   ```

4. **Force Zotero to re-read extensions:**
   - Open `prefs.js` in the profile directory
   - Delete lines containing `extensions.lastAppBuildId` and `extensions.lastAppVersion`
   - Save and close

5. **Start Zotero with debug flags:**
   ```bash
   # macOS
   open -a Zotero --args -purgecaches -ZoteroDebugText -jsconsole

   # Windows
   "C:\Program Files\Zotero\zotero.exe" -purgecaches -ZoteroDebugText -jsconsole

   # Linux
   zotero -purgecaches -ZoteroDebugText -jsconsole
   ```

Flags explained:
- `-purgecaches` - Clear cached files, reload plugin code
- `-ZoteroDebugText` - Enable debug output
- `-jsconsole` - Open the JavaScript console

### Method 2: Build XPI for Distribution

Create an XPI (ZIP) file for sharing:

```bash
cd build
zip -r ../zotseek.xpi *
```

Install in Zotero: Tools → Add-ons → Install Add-on From File

---

## Development Workflow

### Recommended Workflow

1. **Make changes** to TypeScript files in `src/`

2. **Build and restart** the plugin:
   ```bash
   npm run build && osascript -e 'quit app "Zotero"' 2>/dev/null; sleep 2 && open -a Zotero --args -purgecaches -jsconsole
   ```

3. **Check console** for errors (Help → Debug Output Logging → View Output)

4. **Test** your changes

5. **Repeat**

### Quick Reload Script (Recommended)

Create a one-liner alias or script for faster iteration:

```bash
# Add to ~/.zshrc or ~/.bashrc
alias zotdev='npm run build && osascript -e "quit app \"Zotero\"" 2>/dev/null; sleep 2 && open -a Zotero --args -purgecaches -jsconsole'
```

Or create a `dev-reload.sh` script in your project:

```bash
#!/bin/bash
# dev-reload.sh - Build and restart Zotero for development

echo "=== Building plugin ==="
npm run build

echo ""
echo "=== Restarting Zotero ==="
osascript -e 'quit app "Zotero"' 2>/dev/null
sleep 2
open -a Zotero --args -purgecaches -jsconsole
```

> ⚠️ **Why `open -a Zotero` alone doesn't work:** If Zotero is already running, `open -a Zotero` just brings the existing window to focus without restarting. You must **quit Zotero first** using `osascript -e 'quit app "Zotero"'` to force a fresh restart that loads your updated plugin.

### Watch Mode (Faster Iteration)

```bash
npm run watch  # Rebuilds on file changes
```

Then use the reload script to restart Zotero and pick up changes.

### Debugging Tips

1. **Use the JavaScript console:**
   - Start with `-jsconsole` flag
   - Or: Tools → Developer → Error Console

2. **Add debug logging:**
   ```typescript
   Zotero.debug('[ZotSeek] Your message here');
   ```

3. **Inspect Zotero objects:**
   ```javascript
   // In the console, you can run:
   Zotero.getActiveZoteroPane().getSelectedItems()
   ```

4. **View debug output:**
   - Help → Debug Output Logging → View Output

---

## Common Patterns

### Debug Logging

**Always use `Zotero.debug()` instead of `console.log()`:**

```typescript
// Basic logging
Zotero.debug('[MyPlugin] Starting up...');
Zotero.debug('[MyPlugin] Processing item: ' + item.id);

// With a logger class (recommended)
class Logger {
  private prefix: string;
  constructor(name: string) { this.prefix = `[${name}]`; }

  info(...args: any[]) {
    Zotero.debug(`${this.prefix} [INFO] ${args.join(' ')}`);
  }
  error(...args: any[]) {
    Zotero.debug(`${this.prefix} [ERROR] ${args.join(' ')}`);
  }
}

const log = new Logger('ZotSeek');
log.info('Plugin loaded');
log.error('Failed to process:', error);
```

**View logs:** Help → Debug Output Logging → View Output

---

### Accessing Zotero APIs

The [Zotero Data Model](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/zotero-data-model.html) organizes data into objects:
- **Items** (`Zotero.Item`) - Regular items, attachments, notes, annotations
- **Collections** (`Zotero.Collection`) - Folders for organizing items
- **Libraries** (`Zotero.Library`) - User library, group libraries

```typescript
// Get items by ID
const item = await Zotero.Items.getAsync(itemID);  // Async (recommended)
const item = Zotero.Items.get(itemID);             // Sync

// Get selected items
const items = Zotero.getActiveZoteroPane().getSelectedItems();

// Get item fields
const title = item.getField('title');
const abstract = item.getField('abstractNote');
const date = item.getField('date');

// Set item fields
item.setField('title', 'New Title');
await item.saveTx();  // Always save after changes!

// Get creators (authors)
const creators = item.getCreators();
const firstAuthor = creators[0]?.lastName;

// Check item type
item.isRegularItem();      // Regular item (not attachment/note)
item.isAttachment();       // Attachment
item.isNote();             // Note
item.isPDFAttachment();    // PDF attachment

// Get attachments
const attachment = await item.getBestAttachment();
const filePath = await attachment.getFilePath();

// Full-text search
const content = await Zotero.Fulltext.getItemContent(attachmentId);

// Create a new item
const newItem = new Zotero.Item('book');
newItem.setField('title', 'My Book');
newItem.addTag('my-tag');
await newItem.saveTx();

// Trash an item
await Zotero.Items.trashTx(item);
```

### Item Operations (Advanced)

See [Item Operations docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/item-operations.html) for detailed item manipulation.

```typescript
// Get item fields
const abstract = item.getField('abstractNote');
const title = item.getField('title');
const date = item.getField('date');

// Get creators
const creator = item.getCreator(0);        // {firstName, lastName, creatorTypeID, fieldMode}
const creatorJSON = item.getCreatorJSON(0); // {firstName, lastName, creatorType}

// Get child notes
const noteIDs = item.getNotes();
for (const id of noteIDs) {
  const note = Zotero.Items.get(id);
  const noteHTML = note.getNote();  // HTML content
}

// Get related items
const relatedItems = item.relatedItems;

// Set two items as related
itemA.addRelatedItem(itemB);
await itemA.saveTx();
itemB.addRelatedItem(itemA);
await itemB.saveTx();
```

**Get Attachment Full Text** (crucial for our plugin!):

```typescript
// Get full text from PDF/HTML attachments
async function getItemFullText(item: Zotero.Item): Promise<string[]> {
  const fulltext: string[] = [];

  if (item.isRegularItem()) {
    const attachmentIDs = item.getAttachments();
    for (const id of attachmentIDs) {
      const attachment = Zotero.Items.get(id);
      if (attachment.isPDFAttachment() || attachment.isSnapshotAttachment()) {
        const text = await attachment.attachmentText;
        if (text) fulltext.push(text);
      }
    }
  }

  return fulltext;
}
```

### Search Operations

Use `Zotero.Search` to query items programmatically. See [Search Operations docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/search-operations.html).

```typescript
// Create a search
const s = new Zotero.Search();
s.libraryID = Zotero.Libraries.userLibraryID;

// Search by tag
s.addCondition('tag', 'is', 'machine-learning');

// Search by creator
s.addCondition('creator', 'contains', 'Smith');

// Search in a collection
s.addCondition('collectionID', 'is', collectionID);

// Advanced options
s.addCondition('joinMode', 'any');        // 'any' = OR, 'all' = AND (default)
s.addCondition('recursive', 'true');      // Search subfolders
s.addCondition('noChildren', 'true');     // Only top-level items

// Execute the search - returns item IDs
const itemIDs = await s.search();

// Get the actual items
const items = await Zotero.Items.getAsync(itemIDs);
```

**Useful for our plugin:** We can use this to get all items in a collection for indexing:

```typescript
async function getCollectionItems(collectionID: number) {
  const s = new Zotero.Search();
  s.libraryID = Zotero.Libraries.userLibraryID;
  s.addCondition('collectionID', 'is', collectionID);
  s.addCondition('itemType', 'isNot', 'attachment');
  s.addCondition('itemType', 'isNot', 'note');

  const itemIDs = await s.search();
  return Zotero.Items.getAsync(itemIDs);
}
```

### HTTP Requests

Use `Zotero.HTTP` for network requests. See [HTTP Request docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/http-request.html).

```typescript
// GET request
const url = 'https://api.example.com/data';
const req = await Zotero.HTTP.request('GET', url);
Zotero.debug(req.status);      // 200
Zotero.debug(req.statusText);  // OK
Zotero.debug(req.response);    // string

// GET with JSON response
const req = await Zotero.HTTP.request('GET', url, {
  responseType: 'json'
});
Zotero.debug(req.response);  // parsed object

// POST request with JSON body
const data = { title: 'foo', body: 'bar' };
const req = await Zotero.HTTP.request('POST', url, {
  body: JSON.stringify(data),
  headers: {
    'Content-Type': 'application/json',
  },
  responseType: 'json',
});
```

**Useful for our plugin:** If using a remote embedding API instead of local Transformers.js:

```typescript
async function getRemoteEmbedding(text: string): Promise<number[]> {
  const req = await Zotero.HTTP.request('POST', 'https://api.openai.com/v1/embeddings', {
    body: JSON.stringify({
      model: 'text-embedding-3-small',
      input: text,
    }),
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    responseType: 'json',
  });

  return req.response.data[0].embedding;
}
```

### Web Workers for Heavy Tasks

**Critical for our plugin!** See [Web Worker docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/web-worker.html).

Embedding generation and vector search are computationally expensive. Running them in the main thread would freeze Zotero's UI. Use Web Workers to run heavy tasks in background threads.

#### Basic Worker Pattern

```typescript
// worker.js - runs in background thread
addEventListener('message', async (event) => {
  const { type, jobID, data } = event.data;

  if (type === 'generateEmbedding') {
    const embedding = await computeEmbedding(data.text);
    postMessage({ type: 'embeddingResult', jobID, embedding });
  }
});

// Main thread - plugin code
const worker = new Worker('chrome://zotseek/content/worker.js');

function generateEmbedding(text: string): Promise<number[]> {
  return new Promise((resolve) => {
    const jobID = Math.random().toString(36).substring(2, 15);

    worker.postMessage({ type: 'generateEmbedding', jobID, data: { text } });

    worker.addEventListener('message', function handler(event) {
      if (event.data.type === 'embeddingResult' && event.data.jobID === jobID) {
        worker.removeEventListener('message', handler);
        resolve(event.data.embedding);
      }
    });
  });
}
```

#### Accessing Zotero APIs from Worker

Workers can't access privileged APIs directly. Use message passing:

```typescript
// Main thread - wrapper for Zotero API
worker.addEventListener('message', (event) => {
  if (event.data.type === 'getItemText') {
    const { jobID, itemID } = event.data;
    const item = Zotero.Items.get(itemID);
    const text = item.getField('title') + ' ' + item.getField('abstractNote');
    worker.postMessage({ type: 'itemTextResult', jobID, text });
  }
});

// Worker - request data from main thread
async function getItemText(itemID: number): Promise<string> {
  return new Promise((resolve) => {
    const jobID = randomJobID();
    postMessage({ type: 'getItemText', jobID, itemID });

    addEventListener('message', function handler(event) {
      if (event.data.type === 'itemTextResult' && event.data.jobID === jobID) {
        removeEventListener('message', handler);
        resolve(event.data.text);
      }
    });
  });
}
```

#### Our Plugin's Worker Architecture

```
┌─────────────────────────────────────────────────────────┐
│                    Main Thread                          │
│  ┌─────────────┐  ┌──────────────┐  ┌───────────────┐  │
│  │ Zotero UI   │  │ Plugin Logic │  │ Zotero APIs   │  │
│  └─────────────┘  └──────┬───────┘  └───────────────┘  │
│                          │                              │
│                   postMessage()                         │
└──────────────────────────┼──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│                  Web Worker Thread                      │
│  ┌─────────────────┐  ┌─────────────────────────────┐  │
│  │ Transformers.js │  │ Vector Math (cosine sim)    │  │
│  │ (embeddings)    │  │ (search over 10k+ vectors)  │  │
│  └─────────────────┘  └─────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Chrome Worker**: A special worker with access to privileged APIs. See [Chrome Worker docs](https://developer.mozilla.org/en-US/docs/Mozilla/Add-ons/WebExtensions/Chrome_Worker) for more info.

---

## ChromeWorker + Transformers.js Solution

This section documents how we successfully implemented **true semantic search** using Transformers.js in a Zotero plugin. This was challenging because Zotero's privileged context lacks many browser APIs that Transformers.js expects.

### The Problem

Transformers.js cannot run directly in Zotero's main thread because:

1. **No `self` global** - Transformers.js expects browser/worker globals
2. **No `indexedDB`** - Used for model caching
3. **No `navigator.gpu`** - WebGPU not available
4. **Cache API crashes Zotero** - DOMCacheThread causes SIGSEGV
5. **WASM threading issues** - SharedArrayBuffer not fully supported

**Additional challenge with v3:** Transformers.js v3 uses `onnxruntime-web 1.19+` which internally does dynamic ES module imports (`await import('./ort-wasm-simd-threaded.jsep.mjs')`). Zotero's ChromeWorker historically doesn't support dynamic `import()`.

### The Solution: ChromeWorker + wasmPaths Configuration

We run Transformers.js in a **ChromeWorker** - a special Firefox/Zotero worker with privileged access. The worker is **bundled separately** with Transformers.js included.

**The breakthrough (December 2025):** Transformers.js v3.7.0 added `env.backends.onnx.wasm.wasmPaths` configuration that redirects WASM file loading to a custom path. This bypasses the dynamic import issue by allowing us to serve pre-bundled WASM files from a `chrome://` URL.

#### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                        MAIN THREAD                                │
│  ┌──────────────┐      ┌───────────────────────────────┐         │
│  │ Plugin Logic │ ←──→ │ EmbeddingPipeline (wrapper)   │         │
│  │ (index.ts)   │      │ - Manages worker lifecycle    │         │
│  └──────────────┘      │ - Sends/receives messages     │         │
│                        └───────────────────────────────┘         │
│                                      │                            │
│                              postMessage()                        │
└──────────────────────────────────────┼───────────────────────────┘
                                       │
┌──────────────────────────────────────▼───────────────────────────┐
│                      CHROMEWORKER THREAD                          │
│  ┌───────────────────────────────────────────────────────────┐   │
│  │                 embedding-worker.ts                        │   │
│  │  ┌───────────────────────┐  ┌────────────────────────┐    │   │
│  │  │ Transformers.js v3    │  │ nomic-embed-text-v1.5  │    │   │
│  │  │ @huggingface/...      │  │ (768 dims, 8K tokens)  │    │   │
│  │  └───────────────────────┘  └────────────────────────┘    │   │
│  │                                                            │   │
│  │  ┌───────────────────────────────────────────────────┐    │   │
│  │  │ wasmPaths → chrome://zotseek/content/wasm/ │    │   │
│  │  │ (bypasses dynamic import via bundled WASM files)   │    │   │
│  │  └───────────────────────────────────────────────────┘    │   │
│  └───────────────────────────────────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────┘
```

#### Worker Implementation (`src/worker/embedding-worker.ts`)

```typescript
/**
 * Embedding Worker - ChromeWorker for Transformers.js v3
 *
 * Uses nomic-embed-text-v1.5 with 8K token context window and instruction prefixes.
 * Key: wasmPaths configuration bypasses dynamic import issues.
 */

// Set up globals that Transformers.js expects
(globalThis as any).self = globalThis;
(globalThis as any).window = globalThis;
if (typeof navigator === 'undefined') {
  (globalThis as any).navigator = {
    userAgent: 'Zotero ChromeWorker',
    hardwareConcurrency: 4,
    language: 'en-US',
    languages: ['en-US', 'en'],
  };
}

// Import Transformers.js v3
import { pipeline, env } from '@huggingface/transformers';

// CRITICAL: Configure wasmPaths BEFORE any pipeline initialization
// This redirects WASM loading to bundled files, bypassing dynamic import issues
// This is the key to making v3 work in Zotero's ChromeWorker!
env.backends.onnx.wasm.wasmPaths = 'chrome://zotseek/content/wasm/';

// Configure for local/bundled operation
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'chrome://zotseek/content/models/';

// Disable browser caching (not available in ChromeWorker)
env.useBrowserCache = false;
(env as any).useCache = false;

// Single-threaded mode for ChromeWorker compatibility
env.backends.onnx.wasm.numThreads = 1;

// Worker state
let embeddingPipeline: any = null;

// Model configuration - nomic-embed-text-v1.5
// - 8192 token context window
// - 768 dimension embeddings (Matryoshka - can truncate to 256/128)
// - Instruction-aware: use search_document: and search_query: prefixes
// - Outperforms OpenAI text-embedding-3-small on MTEB
const MODEL_ID = 'Xenova/nomic-embed-text-v1.5';
const MODEL_OPTIONS = {
  quantized: true,         // Use model_quantized.onnx (~131MB)
  local_files_only: true,  // Only use local bundled files
};

// Instruction prefixes for nomic-embed-text-v1.5
const SEARCH_DOCUMENT_PREFIX = 'search_document: ';
const SEARCH_QUERY_PREFIX = 'search_query: ';

// nomic-embed supports 8192 tokens (~32K chars)
// Using 24K as safe limit to leave headroom for tokenization variance
const MAX_CHARS = 24000;

async function initPipeline(): Promise<void> {
  postMessage({ type: 'status', status: 'loading', message: `Loading model ${MODEL_ID}...` });

  embeddingPipeline = await pipeline('feature-extraction', MODEL_ID, MODEL_OPTIONS);

  postMessage({ type: 'status', status: 'ready', message: 'Model loaded' });
}

async function generateEmbedding(jobId: string, text: string, isQuery: boolean = false): Promise<void> {
  // Truncate if needed (should be rare with 8K context)
  let processedText = text.length > MAX_CHARS ? text.substring(0, MAX_CHARS) : text;

  // Add instruction prefix based on whether this is a query or document
  processedText = isQuery
    ? SEARCH_QUERY_PREFIX + processedText
    : SEARCH_DOCUMENT_PREFIX + processedText;

  const output = await embeddingPipeline!(processedText, {
    pooling: 'mean',     // nomic uses mean pooling
    normalize: true,     // Normalize for cosine similarity
  });

  const embedding = Array.from(output.data as Float32Array);  // 768 dimensions
  postMessage({ type: 'embedding', jobId, embedding, modelId: MODEL_ID });
}

// Handle messages from main thread
addEventListener('message', async (event: MessageEvent) => {
  const { type, jobId, data } = event.data;

  switch (type) {
    case 'init':
      await initPipeline();
      break;
    case 'embed':
      await generateEmbedding(jobId, data.text, data.isQuery || false);
      break;
  }
});

// Signal worker is loaded
postMessage({ type: 'status', status: 'initialized', message: 'Worker loaded' });
```

#### Build Configuration for Worker

The worker must be bundled **separately** with Transformers.js included. Additionally, you must copy the v3 WASM files:

```javascript
// scripts/build.js
const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

/**
 * CRITICAL: Copy Transformers.js v3 WASM files from node_modules
 * These are loaded via wasmPaths configuration in the worker
 */
function copyTransformersV3Files() {
  const transformersDir = path.resolve(__dirname, '../node_modules/@huggingface/transformers/dist');
  const ortDir = path.resolve(__dirname, '../node_modules/@huggingface/transformers/node_modules/onnxruntime-web/dist');
  const wasmDestDir = path.resolve(buildDir, 'content/wasm');

  fs.mkdirSync(wasmDestDir, { recursive: true });

  // v3 uses JSEP (JavaScript Execution Provider) WASM files
  const v3Files = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
    'ort-wasm-simd-threaded.mjs',
    'ort-wasm-simd-threaded.wasm',
  ];

  for (const file of v3Files) {
    let srcPath = path.join(transformersDir, file);
    if (!fs.existsSync(srcPath)) {
      srcPath = path.join(ortDir, file);
    }
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(wasmDestDir, file));
      console.log(`  Copied v3 WASM file: ${file}`);
    }
  }
}

async function build() {
  // Copy WASM files first!
  copyTransformersV3Files();

  // Main plugin bundle
  await esbuild.build({
    entryPoints: ['src/index.ts'],
    bundle: true,
    outfile: 'build/content/scripts/index.js',
    format: 'iife',
    platform: 'browser',
    target: ['firefox128'],  // Zotero 8
  });

  // Worker bundle with Transformers.js v3
  await esbuild.build({
    entryPoints: ['src/worker/embedding-worker.ts'],
    bundle: true,
    outfile: 'build/content/scripts/embedding-worker.js',
    format: 'iife',
    platform: 'browser',
    target: ['firefox128'],
    // Polyfills for Transformers.js
    define: {
      'self': 'globalThis',
      'window': 'globalThis',
    },
    banner: {
      js: `
        if (typeof navigator === 'undefined') {
          globalThis.navigator = {
            userAgent: 'Mozilla/5.0 Zotero',
            hardwareConcurrency: 4,
          };
        }
      `,
    },
  });
}

build();
```

**Key insight:** The `wasmPaths` configuration in the worker tells ONNX Runtime to load WASM files from `chrome://zotseek/content/wasm/` instead of trying to dynamically import them. This bypasses the dynamic `import()` issue in Zotero's ChromeWorker.

#### Main Thread Integration

The main thread creates the ChromeWorker and communicates via messages:

```typescript
// src/core/embedding-pipeline.ts
class EmbeddingPipeline {
  private worker: ChromeWorker | null = null;
  private pendingJobs = new Map<string, { resolve: Function; reject: Function }>();

  async init(): Promise<void> {
    // Create ChromeWorker
    this.worker = new ChromeWorker(
      'chrome://zotseek/content/scripts/embedding-worker.js'
    );

    // Handle messages from worker
    this.worker.onmessage = (event: MessageEvent) => {
      const { type, jobId, embedding, status, message, error } = event.data;

      if (type === 'status') {
        this.onProgress?.(status, message);
      } else if (type === 'embedding' && jobId) {
        this.pendingJobs.get(jobId)?.resolve(embedding);
        this.pendingJobs.delete(jobId);
      } else if (type === 'error' && jobId) {
        this.pendingJobs.get(jobId)?.reject(new Error(error));
        this.pendingJobs.delete(jobId);
      }
    };

    // Initialize pipeline
    await this.sendMessage({ type: 'init' });
  }

  async embed(text: string): Promise<number[]> {
    const jobId = crypto.randomUUID();

    return new Promise((resolve, reject) => {
      this.pendingJobs.set(jobId, { resolve, reject });
      this.worker!.postMessage({ type: 'embed', jobId, data: { text } });
    });
  }

  private sendMessage(msg: any): Promise<void> {
    return new Promise((resolve) => {
      const handler = (event: MessageEvent) => {
        if (event.data.type === 'status' && event.data.status === 'ready') {
          this.worker!.removeEventListener('message', handler);
          resolve();
        }
      };
      this.worker!.addEventListener('message', handler);
      this.worker!.postMessage(msg);
    });
  }
}
```

### Key Configuration for Zotero Compatibility (Transformers.js v3)

These settings are **critical** for Transformers.js v3 to work in Zotero:

| Setting | Purpose |
|---------|---------|
| `env.backends.onnx.wasm.wasmPaths = 'chrome://...'` | **THE KEY FIX** - Redirects WASM loading to bundled files, bypassing dynamic import |
| `env.useBrowserCache = false` | Prevents DOMCacheThread crash (SIGSEGV) |
| `env.useCache = false` | Disables all caching |
| `env.allowRemoteModels = false` | Don't fetch from network |
| `env.allowLocalModels = true` | Use local bundled models |
| `env.localModelPath = 'chrome://...'` | Path to bundled model files |
| `env.backends.onnx.wasm.numThreads = 1` | Single-threaded mode for stability |

### Trade-offs

| Benefit | Trade-off |
|---------|-----------|
| **True semantic search (768-dim vectors)** | Bundled model (~131MB) |
| **8192 token context (16x bge-small!)** | ~200-300ms per embedding |
| **Full documents in 1-3 chunks** | Larger plugin bundle (~135MB total) |
| **Instruction-aware** (query vs document prefixes) | Slightly more complex implementation |
| **Outperforms OpenAI text-embedding-3-small** | Requires re-indexing when upgrading models |
| Runs locally, no API keys needed | Single-threaded WASM (no multi-threading) |
| Works fully offline (bundled model) | Must rebuild index when upgrading models |
| Transformers.js v3 with latest features | Requires wasmPaths configuration |
| **Matryoshka embeddings** (can truncate dims) | Full 768 dims recommended for best quality |

### Performance

- **Model loading**: ~1.5s (bundled nomic-embed-text-v1.5, ~131MB)
- **Embedding generation**: ~200-300ms per chunk
- **Chunks per paper**: 1-3 (most papers fit in single chunk with 8K context!)
- **Memory usage**: ~400MB during embedding, lower after
- **Embedding dimensions**: 768 (Matryoshka - can truncate to 256/128)

### Zotero 8 Compatibility

For Zotero 8, use `Services.prompt` instead of deprecated `Components.classes`:

```typescript
// ❌ OLD - crashes in Zotero 8
const ps = Components.classes['@mozilla.org/embedcomp/prompt-service;1']
  .getService(Components.interfaces.nsIPromptService);

// ✅ NEW - Zotero 8 compatible
const confirmed = Services.prompt.confirm(
  Zotero.getMainWindow(),
  'Title',
  'Message'
);
```

---

### Privileged vs Unprivileged Contexts

**CRITICAL**: Zotero plugins run in a **privileged sandbox**, NOT a browser window. See [Privileged vs Unprivileged docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/privileged-vs-unprivileged.html).

#### What's Available in Plugin Sandbox

| Available ✅ | NOT Available ❌ |
|-------------|-----------------|
| `Zotero` | `window` (limited) |
| `ChromeUtils` | `document.body` |
| `Services` | `indexedDB` |
| `IOUtils` | `localStorage` |
| `PathUtils` | `self` |
| `ChromeWorker` | `navigator` (limited) |
| `Localization` | `fetch` (use `Zotero.HTTP`) |

#### Why Third-Party Libraries Often Fail

> ❗️ Missing global variables is the major cause that some third-party libraries designed for the web cannot work in the browser window.

Transformers.js initially failed in our plugin because:
- It expects `self` (browser/worker global) → NOT available in main thread
- It expects `navigator.hardwareConcurrency` → NOT available
- It uses `indexedDB` for model caching → NOT available
- It uses Cache API → **CRASHES ZOTERO** (DOMCacheThread SIGSEGV)
- WASM threading uses SharedArrayBuffer → Causes errors

#### Solutions for Library Compatibility

1. **Use ChromeWorker** (RECOMMENDED for ML libraries):
   - ChromeWorker runs in separate thread with privileged access
   - Can run Transformers.js with proper configuration
   - See [ChromeWorker + Transformers.js Solution](#chromeworker--transformersjs-solution) above

2. **Disable problematic features**:
   ```javascript
   // For Transformers.js in ChromeWorker:
   env.useBrowserCache = false;  // CRITICAL: prevents crash
   env.useCache = false;
   env.backends.onnx.wasm.numThreads = 1;  // Single-threaded
   ```

3. **Use Zotero APIs instead**:
   - `Zotero.HTTP.request()` instead of `fetch()`
   - `Zotero.File` instead of File API
   - `Zotero.DB` (SQLite) instead of `indexedDB`

4. **Use polyfills in worker**:
   ```javascript
   // In ChromeWorker, set up globals before importing library
   (globalThis as any).self = globalThis;
   (globalThis as any).window = globalThis;
   (globalThis as any).navigator = { userAgent: 'Zotero', hardwareConcurrency: 4 };
   ```

5. **Use remote APIs** via `Zotero.HTTP`:
   ```typescript
   // Alternative: use remote embedding API (OpenAI, etc.)
   const result = await Zotero.HTTP.request('POST', apiUrl, { ... });
   ```

#### File I/O in Privileged Context

Use `Zotero.File` APIs (recommended) or raw `IOUtils`/`PathUtils`. See [File I/O docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/file-io.html).

```typescript
// Reading file
const content = await Zotero.File.getContentsAsync(path);

// Writing file
await Zotero.File.putContentsAsync(path, content);

// Check if exists and remove
await Zotero.File.removeIfExists(path);

// Iterate directory
await Zotero.File.iterateDirectory(dirPath, (entry) => {
  Zotero.debug(entry.name);
});

// Join paths (cross-platform)
const fullPath = PathUtils.join(Zotero.DataDirectory.dir, 'myfile.json');
```

**File Picker** (for user selection):

```typescript
const { FilePicker } = ChromeUtils.import(
  'chrome://zotero/content/modules/filePicker.jsm'
);

const fp = new FilePicker();
fp.init(Zotero.getMainWindow(), 'Select File', fp.modeOpen);
fp.appendFilters(fp.filterAll);
const rv = await fp.show();

if (rv === fp.returnOK) {
  const content = await Zotero.File.getContentsAsync(fp.file);
}
```

### Adding Toolbar Buttons

Adding toolbar buttons to Zotero requires careful handling to inherit proper styling. The recommended approach is to **clone an existing toolbar button** to ensure consistent appearance.

#### Why Clone Existing Buttons?

Creating toolbar buttons from scratch often results in incorrect styling (wrong margins, sizes, etc.). By cloning an existing Zotero button like `#zotero-tb-lookup`, your button inherits:
- Proper spacing and margins
- Correct icon sizing
- Native Zotero look and feel

#### Implementation Pattern

```typescript
class ToolbarButton {
  private buttonId = 'my-plugin-toolbar-button';
  private separatorId = 'my-plugin-toolbar-separator';

  public add(window: any): void {
    const doc = window.document;

    // Check if button already exists
    if (doc.getElementById(this.buttonId)) return;

    // Find the items toolbar
    const toolbar = doc.querySelector('#zotero-items-toolbar');
    if (!toolbar) return;

    // Clone an existing toolbar button to inherit proper styling
    const lookupNode = toolbar.querySelector('#zotero-tb-lookup');

    if (!lookupNode) {
      // Fallback to creating button from scratch
      const button = this.createButtonFallback(doc);
      this.insertButton(toolbar, button);
      return;
    }

    // Clone the lookup button to get proper styling
    const button = lookupNode.cloneNode(true) as any;

    // Update the cloned button's attributes
    button.setAttribute('id', this.buttonId);
    button.setAttribute('label', 'SS');  // Short label
    button.setAttribute('tooltiptext', 'Open My Plugin Dialog');

    // Clear inherited event handlers
    button.setAttribute('command', '');
    button.setAttribute('oncommand', '');
    button.setAttribute('mousedown', '');
    button.setAttribute('onmousedown', '');

    // Set custom icon (20x20 for toolbar)
    button.style.listStyleImage = 'url("chrome://my-plugin/content/icons/icon-toolbar.svg")';

    // Add click handler
    button.addEventListener('click', () => this.handleClick());

    // Insert at desired position
    this.insertButton(toolbar, button);
  }

  private createButtonFallback(doc: any): any {
    const button = doc.createXULElement('toolbarbutton');
    button.id = this.buttonId;
    button.setAttribute('label', 'SS');
    button.setAttribute('tooltiptext', 'Open My Plugin Dialog');
    button.setAttribute('class', 'zotero-tb-button');
    button.style.listStyleImage = 'url("chrome://my-plugin/content/icons/icon-toolbar.svg")';
    button.addEventListener('click', () => this.handleClick());
    return button;
  }

  private insertButton(toolbar: any, button: any): void {
    const doc = toolbar.ownerDocument;
    const searchBox = toolbar.querySelector('#zotero-tb-search');

    // Create a separator for visual separation
    const separator = doc.createXULElement('toolbarseparator');
    separator.id = this.separatorId;

    if (searchBox) {
      // Insert button, then separator before search box
      toolbar.insertBefore(separator, searchBox);
      toolbar.insertBefore(button, separator);
    } else {
      toolbar.appendChild(button);
      toolbar.appendChild(separator);
    }
  }

  public remove(window: any): void {
    const doc = window.document;
    doc.getElementById(this.buttonId)?.remove();
    doc.getElementById(this.separatorId)?.remove();
  }
}
```

#### Toolbar Icon Requirements

For proper toolbar integration, create a dedicated toolbar icon:

1. **Size**: 20x20 pixels for toolbar icons
2. **Format**: SVG recommended for scalability
3. **Theming**: Use `context-fill` and `context-fill-opacity` for Zotero to control colors

```xml
<!-- icon-toolbar.svg -->
<?xml version="1.0" encoding="UTF-8"?>
<svg width="20" height="20" viewBox="0 0 96 96"
     xmlns="http://www.w3.org/2000/svg"
     fill="context-fill"
     fill-opacity="context-fill-opacity">
  <path d="..." />
</svg>
```

The `context-fill` attribute allows Zotero to automatically adjust icon colors based on the current theme (light/dark mode).

### Adding Reader Window Toolbar Buttons

The PDF reader in Zotero has its own toolbar. You can add buttons using `Zotero.Reader.registerEventListener`.

#### Implementation Pattern

```typescript
class ToolbarButton {
  private readerButtonClass = 'my-plugin-reader-button';
  private iconCache: Record<string, string> = {};

  /**
   * Register toolbar button in Reader windows
   */
  public async registerReaderToolbar(): Promise<void> {
    // Pre-cache the icon (Reader uses inline SVG, not CSS)
    await this.getIcon('chrome://my-plugin/content/icons/icon-toolbar.svg');

    // Register event listener for new reader windows
    Zotero.Reader.registerEventListener(
      'renderToolbar',
      (event: any) => this.readerToolbarCallback(event),
      'my-plugin@example.org'  // Plugin ID for cleanup
    );

    // Add button to any already-open readers
    if (Zotero.Reader._readers) {
      for (const reader of Zotero.Reader._readers) {
        await this.buildReaderButton(reader);
      }
    }
  }

  /**
   * Callback for reader toolbar render event
   */
  private readerToolbarCallback(event: any): void {
    const { append, doc, reader } = event;

    // Create HTML button (Reader uses HTML, not XUL!)
    const button = doc.createElement('button');
    button.className = `toolbar-button ${this.readerButtonClass}`;
    button.tabIndex = -1;
    button.title = 'My Plugin Action';

    // Set icon as inline SVG
    const iconSvg = this.iconCache['chrome://my-plugin/content/icons/icon-toolbar.svg'];
    if (iconSvg) {
      button.innerHTML = iconSvg;
    }

    // Add click handler
    button.addEventListener('click', () => {
      this.handleClick();
    });

    // Append using event's append function (handles cross-compartment issues)
    append(button);
  }

  /**
   * Build reader button for existing reader instances
   */
  private async buildReaderButton(reader: any): Promise<void> {
    await reader._initPromise;

    const customSections = reader._iframeWindow?.document.querySelector(
      '.toolbar .custom-sections'
    );
    if (!customSections) return;

    // Check if button already exists
    if (customSections.querySelector(`.${this.readerButtonClass}`)) return;

    const doc = customSections.ownerDocument;

    // Create append function with cross-compartment cloning
    const append = (...args: (string | Node)[]) => {
      customSections.append(
        ...Components.utils.cloneInto(args, reader._iframeWindow, {
          wrapReflectors: true,
          cloneFunctions: true,
        })
      );
    };

    this.readerToolbarCallback({
      append,
      reader,
      doc,
      type: 'renderToolbar',
      params: {},
    });
  }

  /**
   * Load and cache SVG icon
   */
  private async getIcon(src: string): Promise<string> {
    if (this.iconCache[src]) return this.iconCache[src];

    const response = await Zotero.HTTP.request('GET', src, {});
    this.iconCache[src] = response.response;
    return response.response;
  }
}
```

#### Key Differences from Main Toolbar

| Aspect | Main Toolbar | Reader Toolbar |
|--------|--------------|----------------|
| Element type | XUL (`toolbarbutton`) | HTML (`button`) |
| CSS class | `zotero-tb-button` | `toolbar-button` |
| Icon method | `style.listStyleImage` | Inline SVG in `innerHTML` |
| Registration | Direct DOM manipulation | `Zotero.Reader.registerEventListener` |
| Cleanup | Manual removal | Automatic by plugin ID |

#### Important Notes

1. **Use HTML elements** - The reader iframe uses HTML, not XUL
2. **Cache icons** - Load SVG content via `Zotero.HTTP.request` and cache it
3. **Cross-compartment cloning** - Use `Components.utils.cloneInto` when appending to reader iframe
4. **Handle existing readers** - Iterate `Zotero.Reader._readers` for already-open PDFs
5. **Plugin ID cleanup** - Zotero automatically removes event listeners when plugin is disabled

---

### Adding Context Menu Items

#### Zotero 8+ MenuManager API (Recommended)

Zotero 8 introduces a new official `Zotero.MenuManager` API for custom menus. This is the preferred approach as it:
- Auto-cleans up on plugin disable/uninstall
- Provides a structured way to define menus
- Supports conditional visibility via `onShowing`

> ⚠️ **Important**: MenuManager requires **Fluent localization (FTL)** for labels. Plain `label` attributes don't work - you must use `l10nID`.

🔗 Reference: [Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers)

#### Step 1: Create FTL Localization File

Create `locale/en-US/my-plugin-menu.ftl`:

```ftl
my-plugin-menuTools-search =
    .label = My Plugin Action
```

#### Step 2: Register Locale in bootstrap.js

Update `bootstrap.js` to register the locale directory:

```javascript
chromeHandle = aomStartup.registerChrome(manifestURI, [
  ["content", "my-plugin", rootURI + "content/"],
  ["locale", "my-plugin", "en-US", rootURI + "locale/en-US/"],  // Add this line
]);
```

#### Step 3: Register Menu with MenuManager

```typescript
public registerToolsMenu(window: any): void {
  // Load the FTL file for localization
  window.MozXULElement.insertFTLIfNeeded('my-plugin-menu.ftl');

  // Check if MenuManager is available (Zotero 8+)
  if (!Zotero.MenuManager) {
    this.logger.warn('MenuManager not available');
    return;
  }

  this.menuRegistrationId = Zotero.MenuManager.registerMenu({
    menuID: 'my-plugin-menuTools',
    pluginID: 'my-plugin@example.org',
    target: 'main/menubar/tools',  // Tools menu
    menus: [
      {
        menuType: 'separator',
      },
      {
        menuType: 'menuitem',
        l10nID: 'my-plugin-menuTools-search',  // References FTL file
        icon: 'chrome://my-plugin/content/icons/icon-toolbar.svg',
        onCommand: () => {
          this.handleClick();
        },
      },
    ],
  });
}

public unregisterToolsMenu(): void {
  if (this.menuRegistrationId && Zotero.MenuManager) {
    Zotero.MenuManager.unregisterMenu(this.menuRegistrationId);
    this.menuRegistrationId = null;
  }
}
```

#### Step 4: Call from Plugin Lifecycle

```typescript
// In onStartup
const win = Zotero.getMainWindow();
if (win) {
  toolbarButton.add(win);
  toolbarButton.registerToolsMenu(win);
}

// In onShutdown
if (win) {
  toolbarButton.remove(win);
  toolbarButton.unregisterToolsMenu();
}
```

**Available targets:**
| Target | Description |
|--------|-------------|
| `main/library/item` | Context menu for library items |
| `main/library/collection` | Context menu for collections |
| `main/menubar/file` | File menu in menubar |
| `main/menubar/edit` | Edit menu in menubar |
| `main/menubar/tools` | Tools menu in menubar |
| `reader/menubar/file` | File menu in reader window |

#### XUL Element Injection (Fallback for Zotero 7)

For older Zotero versions without MenuManager, or when you don't need localization:

```typescript
function addContextMenu() {
  const win = Zotero.getMainWindow();
  const doc = win.document;
  const menu = doc.getElementById('zotero-itemmenu');

  // Create menu item
  const menuItem = doc.createXULElement('menuitem');
  menuItem.id = 'my-plugin-menu';
  menuItem.setAttribute('label', 'My Action');  // Plain text works here!
  menuItem.addEventListener('command', () => {
    // Handle click
  });

  menu.appendChild(menuItem);
}

function removeContextMenu() {
  const win = Zotero.getMainWindow();
  const menuItem = win.document.getElementById('my-plugin-menu');
  if (menuItem) menuItem.remove();
}
```

#### Best Practice: Support Both

```typescript
private registerContextMenu(): void {
  const Z = getZotero();

  // Use MenuManager if available (Zotero 8+)
  if (Z.MenuManager && typeof Z.MenuManager.registerMenu === 'function') {
    this.menuId = Z.MenuManager.registerMenu({ ... });
  } else {
    // Fallback to XUL injection for Zotero 7
    this.registerWithXUL();
  }
}
```

### Storing Preferences

There are two ways to handle preferences:

**Method 1: Using `prefs.js` file (Recommended for defaults)**

Create a `prefs.js` file in your plugin root with default values:

```javascript
// prefs.js
pref("extensions.zotero.zotseek.topK", 20);
pref("extensions.zotero.zotseek.autoIndex", true);
pref("extensions.zotero.zotseek.maxTokens", 7000);  // For nomic-embed-v1.5 (8K token context)
```

These defaults are automatically loaded when the plugin is installed/enabled.

**Method 2: Setting preferences in code**

```typescript
// Note: Zotero.Prefs auto-prepends "extensions.zotero."
// So use SHORT keys without the prefix!

// Set default preference (use short key)
if (Zotero.Prefs.get('zotseek.setting', true) === undefined) {
  Zotero.Prefs.set('zotseek.setting', 'default', true);
}

// Get preference
const value = Zotero.Prefs.get('zotseek.setting', true);

// Set preference
Zotero.Prefs.set('zotseek.setting', 'new value', true);
```

> ⚠️ **Don't use full paths!** `Zotero.Prefs.set('extensions.zotero.myplugin.key')` results in `extensions.zotero.extensions.zotero.myplugin.key`

🔗 See [Preferences docs](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/preferences.html) for more details.

### ~~Using IndexedDB~~ → Use SQLite

> ⚠️ **IndexedDB is NOT available** in Zotero's privileged context. Use SQLite via `Zotero.DB` instead.

```typescript
// ❌ WRONG - IndexedDB throws "indexedDB is not defined"
import { openDB } from 'idb';
const db = await openDB('my-database', 1);  // FAILS!

// ✅ CORRECT - Use SQLite via Zotero.DB
// Create tables in Zotero's main database with a unique prefix
await Zotero.DB.queryAsync(`
  CREATE TABLE IF NOT EXISTS myplugin_data (
    id INTEGER PRIMARY KEY,
    key TEXT NOT NULL,
    value TEXT NOT NULL
  )
`);

// Read data
const value = await Zotero.DB.valueQueryAsync(
  'SELECT value FROM myplugin_data WHERE key = ?',
  ['mykey']
);

// Write data
await Zotero.DB.queryAsync(
  'INSERT OR REPLACE INTO myplugin_data (key, value) VALUES (?, ?)',
  ['mykey', JSON.stringify(data)]
);
```

**Why SQLite over file-based storage:**
- **O(1) lookups** - Indexed queries are instant
- **Atomic updates** - No need to rewrite entire files
- **Lower memory** - Load on demand, not all at once
- **Built-in** - No external dependencies

---

## Debugging & Console Output

Debugging Zotero plugins can be tricky because `console.log` is **not available** in the bootstrap context. Here's how to properly debug your plugin.

### Opening the Browser Console

The Browser Console shows all JavaScript output and errors:

1. **Menu:** Tools → Browser Console
2. **Keyboard:** `Cmd+Shift+J` (Mac) / `Ctrl+Shift+J` (Windows/Linux)
3. **Command line:** Start Zotero with the console open:
   ```bash
   open -a Zotero --args -jsconsole
   ```

### Logging Methods

#### ❌ Don't Use `console.log`
```javascript
// This will throw "console is not defined" in bootstrap.js
console.log("Hello");  // ERROR!
```

#### ✅ Use `Zotero.debug()` for Debug Log
```javascript
// Outputs to Zotero's debug log (Help → Debug Output Logging)
Zotero.debug("[MyPlugin] Hello from debug log");
```
Note: This goes to the **debug log file**, not the Browser Console.

#### ✅ Use Main Window Console for Browser Console
```javascript
// Outputs to Browser Console (visible immediately)
function logToConsole(message) {
  const win = Zotero.getMainWindow?.();
  if (win?.console) {
    win.console.log(message);
  }
}

logToConsole("[MyPlugin] Hello from Browser Console");
```

### Recommended Logging Pattern

Create a logger utility that outputs to both:

```javascript
// src/utils/logger.ts
function getConsole() {
  try {
    const win = Zotero?.getMainWindow?.();
    return win?.console || null;
  } catch (e) {
    return null;
  }
}

export function log(level, ...args) {
  const prefix = "[MyPlugin]";
  const message = `${prefix} [${level.toUpperCase()}] ${args.join(" ")}`;

  // Browser Console (visible in Tools → Browser Console)
  const console = getConsole();
  if (console) {
    switch (level) {
      case "error": console.error(message); break;
      case "warn": console.warn(message); break;
      default: console.log(message);
    }
  }

  // Also log to Zotero's debug output
  Zotero?.debug?.(message);
}

export const logger = {
  debug: (...args) => log("debug", ...args),
  info: (...args) => log("info", ...args),
  warn: (...args) => log("warn", ...args),
  error: (...args) => log("error", ...args),
};
```

### Development vs Production Builds

With `zotero-plugin` CLI, use `--dev` flag for development builds:

```bash
# Development build (enables debugging features)
npx zotero-plugin build --dev

# Production build (minified, no debug)
npx zotero-plugin build
```

### Debug Output Logging

For detailed debugging, enable Zotero's debug output:

1. Go to **Help → Debug Output Logging → Enable**
2. Reproduce the issue
3. Go to **Help → Debug Output Logging → View Output**
4. Or save to file: **Help → Debug Output Logging → Save to File**

### Quick Debug Tips

| What | How |
|------|-----|
| See errors immediately | Open Browser Console before testing |
| Log from bootstrap.js | Use `Zotero.debug()` only |
| Log from plugin code | Use `Zotero.getMainWindow().console` |
| Start with console open | `open -a Zotero --args -jsconsole` |
| Clear extension cache | Delete `extensions.lastApp*` from `prefs.js` |
| Force reload | `open -a Zotero --args -purgecaches` |

---

## Troubleshooting

### Plugin Not Loading

1. **Check extension ID matches:**
   - Filename of proxy file must match `applications.zotero.id` in manifest

2. **Verify proxy file contents:**
   ```bash
   cat ~/Library/.../extensions/zotseek@zotero.org
   # Should output: /path/to/your/build (no trailing newline)
   ```

3. **Delete extension cache:**
   ```bash
   cd ~/Library/Application\ Support/Zotero/Profiles/XXXX.default
   sed -i '' '/extensions.lastAppBuildId/d;/extensions.lastAppVersion/d' prefs.js
   ```

4. **Restart with cache purge:**
   ```bash
   open -a Zotero --args -purgecaches
   ```

### Common Errors

#### `console is not defined`
```
Error running bootstrap method 'startup' on your-addon@id
console is not defined
```
**Fix:** Remove all `console.log/warn/error` calls. Use `Zotero.debug()` instead.

#### `X.init is not a function`
```
ctx.ZotSeek.init is not a function
```
**Fix:** The plugin object isn't being exported correctly. Attach to `Zotero` global:
```javascript
const Z = getZotero();
if (Z) Z.ZotSeek = addon;
```

#### `Invalid preference value`
```
Invalid preference value '0.3' for pref 'extensions.zotero.extensions.zotero...'
```
**Fix:** Don't include `extensions.zotero.` prefix - Zotero adds it automatically:
```javascript
Zotero.Prefs.set('myplugin.key', value);  // NOT 'extensions.zotero.myplugin.key'
```

#### Plugin in Add-ons but no UI
The plugin loads but context menu/UI doesn't appear.
**Fix:** Register UI in `onStartup` after `uiReadyPromise`, not in `onMainWindowLoad`:
```javascript
async onStartup() {
  await Zotero.uiReadyPromise;
  const win = Zotero.getMainWindow();
  if (win) this.registerContextMenu(win);
}
```

### JavaScript Errors

1. **Check console output:**
   - Start with `-jsconsole`
   - Look for red errors

2. **Verify build output:**
   ```bash
   ls -la build/content/scripts/
   # Should see index.js
   ```

3. **Check for syntax errors:**
   ```bash
   npm run build  # Should complete without errors
   ```

### Transformers.js Issues

1. **Model loading fails:**
   - Check network access
   - Models download on first use (~80MB)

2. **Performance issues:**
   - Use quantized models
   - Process in batches with UI yields

3. **Memory issues:**
   - Clear model from memory when not needed
   - Use smaller models for large libraries

---

## Lessons Learned

These are hard-won lessons from actual debugging sessions. They'll save you hours!

### 1. No `console` in Zotero Context - Use `Zotero.debug()`

The `console` object is **not available** in Zotero's plugin context. Using it will crash your plugin!

```javascript
// ❌ WRONG - Will crash with "console is not defined"
console.log('Hello');
console.error('Error!');

// ✅ CORRECT - Use Zotero.debug()
Zotero.debug('[MyPlugin] Hello');
Zotero.debug('[MyPlugin] [ERROR] Something went wrong');
```

#### Creating a Logger Utility

Create a reusable logger class that wraps `Zotero.debug()`:

```typescript
class Logger {
  private prefix: string;

  constructor(prefix: string) {
    this.prefix = `[${prefix}]`;
  }

  private log(level: string, ...args: any[]): void {
    const msg = `${this.prefix} [${level}] ${args.join(' ')}`;
    const Z = getZotero();  // Use your getZotero helper
    if (Z && Z.debug) {
      Z.debug(msg);
    }
  }

  info(...args: any[]): void {
    this.log('INFO', ...args);
  }

  warn(...args: any[]): void {
    this.log('WARN', ...args);
  }

  error(...args: any[]): void {
    this.log('ERROR', ...args);
  }

  debug(...args: any[]): void {
    this.log('DEBUG', ...args);
  }
}

// Usage
const logger = new Logger('ZotSeek');
logger.info('Plugin started');
logger.error('Something failed:', errorMessage);
```

#### Viewing Debug Output

1. **Start Zotero with debug flags:**
   ```bash
   open -a Zotero --args -ZoteroDebugText
   ```

2. **View output:** Go to **Help → Debug Output Logging → View Output**

3. **Search** for your plugin prefix (e.g., `[ZotSeek]`)

Example output:
```
(3)(+0001860): [ZotSeek] [INFO] Find Similar Papers triggered
(3)(+0000001): [ZotSeek] [INFO] Finding papers similar to: My Paper Title
```

> 💡 **Tip:** The numbers `(3)` and `(+0001860)` are Zotero's internal log level and timing. Your messages appear after the colon.

### 2. No `main` Field in Manifest

```json
// ❌ WRONG - Zotero ignores this
{
  "main": "content/scripts/index.js"
}

// ✅ CORRECT - Load script via bootstrap.js
// (no main field needed)
```

### 3. Register UI in `onStartup`, Not `onMainWindowLoad`

The main window is typically already open when your plugin starts:

```javascript
// ❌ WRONG - onMainWindowLoad may never be called
function onMainWindowLoad({ window }) {
  registerContextMenu(window);
}

// ✅ CORRECT - Register in startup after uiReadyPromise
async function onStartup() {
  await Zotero.uiReadyPromise;
  const win = Zotero.getMainWindow();
  if (win) registerContextMenu(win);
}
```

### 4. Access Zotero via Helper Function

Inside an IIFE bundle, `Zotero` may not be directly accessible:

```javascript
// ✅ CORRECT - Helper function to get Zotero
function getZotero() {
  // Try context first
  if (typeof _globalThis !== 'undefined' && _globalThis.Zotero) {
    return _globalThis.Zotero;
  }
  // Try global
  if (typeof Zotero !== 'undefined') {
    return Zotero;
  }
  // Import via ChromeUtils (Zotero 8)
  try {
    const { Zotero: Z } = ChromeUtils.importESModule(
      'chrome://zotero/content/zotero.mjs'
    );
    return Z;
  } catch (e) {
    return null;
  }
}
```

### 5. Attach Plugin to `Zotero` Global

Like BetterNotes, attach your plugin to the `Zotero` object:

```javascript
// In your main script
const Z = getZotero();
if (Z) {
  Z.ZotSeek = addon;  // Now accessible as Zotero.ZotSeek
}
```

### 6. Proxy File: No Trailing Newline Issues

When creating the extension proxy file:

```bash
# ✅ CORRECT - Use printf (no trailing newline)
printf '/path/to/your/build' > extensions/your-addon@id

# ⚠️ Be careful with echo (may add newline)
echo -n '/path/to/your/build' > extensions/your-addon@id
```

### 7. Clear Extension Cache After Changes

After modifying the proxy file or first install:

```bash
# Delete these lines from prefs.js in Zotero profile:
# user_pref("extensions.lastAppBuildId", "...");
# user_pref("extensions.lastAppVersion", "...");

# Or use sed:
sed -i '' '/extensions.lastAppBuildId/d;/extensions.lastAppVersion/d' prefs.js
```

### 8. Zotero.Prefs Key Format

Zotero.Prefs automatically prepends `extensions.zotero.`:

```javascript
// ❌ WRONG - Results in "extensions.zotero.extensions.zotero...."
Zotero.Prefs.set('extensions.zotero.myplugin.key', value);

// ✅ CORRECT - Use short key
Zotero.Prefs.set('myplugin.key', value);
```

### 9. XUL Elements in Zotero 7/8

Use `createXULElement` for XUL elements:

```javascript
const doc = window.document;

// Create XUL menu item
const menuItem = doc.createXULElement('menuitem');
menuItem.id = 'my-menu-item';
menuItem.setAttribute('label', 'My Action');
menuItem.addEventListener('command', () => { /* handler */ });

// Create separator
const separator = doc.createXULElement('menuseparator');
```

### 10. Debug Without Restarting (Sometimes)

For UI changes, you sometimes need to restart. But for logic changes:

1. Use the Error Console to test code snippets
2. Access your plugin: `Zotero.ZotSeek`
3. Call methods directly to test

### 11. Transformers.js v3 in Zotero - ChromeWorker + wasmPaths is the Key

Running ML models in Zotero requires careful configuration. **Transformers.js v3** requires an additional `wasmPaths` configuration to work in ChromeWorker:

```javascript
// ❌ WRONG - Crashes or errors in main thread
import { pipeline } from '@huggingface/transformers';
const model = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5');

// ✅ CORRECT - Use ChromeWorker with specific env settings
// In embedding-worker.ts (bundled separately):
import { pipeline, env } from '@huggingface/transformers';

// CRITICAL for v3: Configure wasmPaths BEFORE pipeline initialization
// This redirects WASM loading to bundled files, bypassing dynamic import issues
env.backends.onnx.wasm.wasmPaths = 'chrome://zotseek/content/wasm/';

// Configure for local/bundled operation
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'chrome://zotseek/content/models/';

// Other critical settings
env.useBrowserCache = false;  // Prevents DOMCacheThread SIGSEGV
env.backends.onnx.wasm.numThreads = 1;  // Single-threaded mode

const model = await pipeline('feature-extraction', 'Xenova/nomic-embed-text-v1.5', {
  quantized: true,         // Use 8-bit quantized model (~131MB)
  local_files_only: true,  // Use bundled model files
});
```

Key learnings:
- **wasmPaths is THE KEY for v3** - Redirects WASM loading to bundled `chrome://` files
- **Cache API crashes Zotero** - Always disable `env.useBrowserCache`
- **WASM threading fails** - Set `numThreads = 1` for single-threaded mode
- **Bundle WASM files** - Copy from `node_modules/@huggingface/transformers/dist/`
- **Bundle model locally** - Use `local_files_only: true` with bundled model files
- **8K context models work!** - nomic-embed-text-v1.5 enables full-document embeddings
- **Instruction prefixes** - Use `search_document:` for indexing, `search_query:` for queries
- **Bundle worker separately** - Transformers.js v3 (~850KB) in worker only

#### Bundling Models for Offline Use (Updated December 2025)

To avoid network downloads and enable instant offline model loading, we bundle the embedding model directly with the plugin.

##### Model Evolution: MiniLM → BGE-small → jina-v2-small → nomic-embed-v1.5

| Aspect | MiniLM-L6-v2 | bge-small-en-v1.5 | jina-v2-small-en | **nomic-embed-v1.5** |
|--------|--------------|-------------------|------------------|----------------------|
| Transformers.js | v2 | v2 | v3 | **v3** |
| Context window | 256 tokens | 512 tokens | 8192 tokens | **8192 tokens** |
| Dimensions | 384 | 384 | 512 | **768** |
| ONNX size (quantized) | ~23 MB | ~32 MB | ~31 MB | **~131 MB** |
| Pooling | mean | cls | mean | **mean** |
| Chunks per paper | 10-20 | 5-10 | 1-3 | **1-3** |
| Instruction prefixes | No | No | No | **Yes** |
| Matryoshka | No | No | No | **Yes** |

##### Why nomic-embed-text-v1.5? (December 2025)

The latest upgrade provides even better retrieval quality:

- **Superior retrieval** - Outperforms OpenAI text-embedding-3-small and jina-v2 on MTEB benchmarks
- **Instruction-aware prefixes** - Uses `search_document:` for indexing and `search_query:` for queries
- **Matryoshka embeddings** - 768 dims can be truncated to 256/128 with minimal quality loss
- **Fully open** - Open weights, open training data, reproducible
- **Same 8K context** - No changes needed to chunking strategy

**Historical note:** Earlier attempts with Transformers.js v2 failed. The v3 upgrade with `wasmPaths` configuration enabled both jina-v2 and nomic-embed models. We chose nomic-embed-v1.5 for its superior retrieval quality and instruction-aware design.

##### Model Files Structure (nomic-embed-text-v1.5)

```
content/models/Xenova/nomic-embed-text-v1.5/
├── config.json
├── tokenizer.json
├── tokenizer_config.json
└── onnx/
    └── model_quantized.onnx (~131 MB)

content/wasm/
├── ort-wasm-simd-threaded.jsep.mjs
├── ort-wasm-simd-threaded.jsep.wasm
├── ort-wasm-simd-threaded.mjs
└── ort-wasm-simd-threaded.wasm
```

##### Downloading the Model Files

```bash
mkdir -p content/models/Xenova/nomic-embed-text-v1.5/onnx

# Download config files from nomic-ai (stored in Xenova directory for Transformers.js)
curl -L -o content/models/Xenova/nomic-embed-text-v1.5/config.json \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/config.json"

curl -L -o content/models/Xenova/nomic-embed-text-v1.5/tokenizer.json \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer.json"

curl -L -o content/models/Xenova/nomic-embed-text-v1.5/tokenizer_config.json \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/tokenizer_config.json"

# Download quantized model (~131MB)
curl -L -o content/models/Xenova/nomic-embed-text-v1.5/onnx/model_quantized.onnx \
  "https://huggingface.co/nomic-ai/nomic-embed-text-v1.5/resolve/main/onnx/model_quantized.onnx"
```

##### Worker Configuration for Transformers.js v3

```typescript
// src/worker/embedding-worker.ts
import { pipeline, env } from '@huggingface/transformers';  // Note: v3 package!

// CRITICAL: Configure wasmPaths BEFORE pipeline initialization
// This is what makes v3 work in Zotero's ChromeWorker!
env.backends.onnx.wasm.wasmPaths = 'chrome://zotseek/content/wasm/';

// Configure for local/bundled operation
env.allowRemoteModels = false;
env.allowLocalModels = true;
env.localModelPath = 'chrome://zotseek/content/models/';

// Disable caching (not available in ChromeWorker)
env.useBrowserCache = false;
(env as any).useCache = false;

// Single-threaded for stability
env.backends.onnx.wasm.numThreads = 1;

// Model configuration - nomic-embed-text-v1.5 (8K context, instruction-aware!)
const MODEL_ID = 'Xenova/nomic-embed-text-v1.5';
const MODEL_OPTIONS = {
  quantized: true,
  local_files_only: true,
};

// Instruction prefixes - CRITICAL for best retrieval quality!
const SEARCH_DOCUMENT_PREFIX = 'search_document: ';
const SEARCH_QUERY_PREFIX = 'search_query: ';

// For documents (indexing):
const docText = SEARCH_DOCUMENT_PREFIX + text;
const output = await pipeline(docText, { pooling: 'mean', normalize: true });

// For queries (searching):
const queryText = SEARCH_QUERY_PREFIX + query;
const output = await pipeline(queryText, { pooling: 'mean', normalize: true });
```

##### Embedding Configuration

Update dimension constants for nomic-embed-v1.5:

```typescript
// src/core/embedding-pipeline.ts
export const EMBEDDING_CONFIG = {
  dimensions: 768,  // nomic-embed-v1.5 outputs 768 dimensions (Matryoshka)
  transformersModelId: 'Xenova/nomic-embed-text-v1.5',
  maxTokens: 8192,  // 8K context window!
};
```

##### Chunking Updates for 8K Token Context

With 8K tokens, chunking strategy changes dramatically:

```typescript
// src/utils/chunker.ts
export interface ChunkOptions {
  maxTokens?: number;   // Default: 7000 (conservative, leaves headroom)
  maxChunks?: number;   // Default: 10 (fewer needed with large context)
}

// Most papers now fit in 1-3 chunks instead of 10-20!
// This improves search quality by preserving more context
```

##### Build Script Updates

The build script must copy both model AND WASM files:

```javascript
// scripts/build.js
function copyTransformersV3Files() {
  const transformersDir = path.resolve(__dirname, '../node_modules/@huggingface/transformers/dist');
  const wasmDestDir = path.resolve(buildDir, 'content/wasm');

  fs.mkdirSync(wasmDestDir, { recursive: true });

  // v3 WASM files - CRITICAL for ChromeWorker!
  const v3Files = [
    'ort-wasm-simd-threaded.jsep.mjs',
    'ort-wasm-simd-threaded.jsep.wasm',
  ];

  for (const file of v3Files) {
    const srcPath = path.join(transformersDir, file);
    if (fs.existsSync(srcPath)) {
      fs.copyFileSync(srcPath, path.join(wasmDestDir, file));
    }
  }
}
```

##### Performance Comparison

| Metric | bge-small (v2) | jina-v2-small (v3) | **nomic-v1.5 (v3)** | Improvement |
|--------|---------------|-------------------|---------------------|-------------|
| Context window | 512 tokens | 8192 tokens | **8192 tokens** | **16x vs bge** |
| Chunks per paper | 5-10 | 1-3 | **1-3** | **~5x fewer** |
| Dimensions | 384 | 512 | **768** | +50% capacity |
| Model Load Time | ~200ms | ~1.2s | **~1.5s** | Slightly slower |
| Embedding Time | ~200ms | ~200ms | **~200-300ms** | Same |
| MTEB Quality | Good | Better | **Best** | Outperforms OpenAI |

##### Migration Notes

**When upgrading from jina-v2-small to nomic-embed-v1.5:**

1. **Download new model** - See download commands above
2. **Update MODEL_ID** - Change to `Xenova/nomic-embed-text-v1.5`
3. **Add instruction prefixes** - Use `search_document:` and `search_query:`
4. **Update dimensions** - Change from 512 to 768
5. **Re-index library** - Required due to dimension change
6. **Remove old model** - Delete `content/models/Xenova/jina-embeddings-v2-small-en/`

**Breaking change:** The embedding dimensions changed from 512 to 768, so existing embeddings are incompatible. Users must re-index their library.

The ~131MB nomic-embed-text-v1.5 model provides:
- **Superior retrieval quality** - Outperforms OpenAI text-embedding-3-small on MTEB
- **Instruction-aware** - Uses `search_document:` and `search_query:` prefixes
- **Matryoshka embeddings** - Can truncate to 256/128 dims if storage is critical
- **Same 8K context window** - Most papers fit in 1-3 chunks
- **Offline support** with instant loading

### 12. Use Services.prompt in Zotero 8

The old `Components.classes` approach is deprecated:

```javascript
// ❌ OLD - Crashes in Zotero 8
const ps = Components.classes['@mozilla.org/embedcomp/prompt-service;1']
  .getService(Components.interfaces.nsIPromptService);
const confirmed = ps.confirm(window, 'Title', 'Message');

// ✅ NEW - Zotero 8 compatible
const confirmed = Services.prompt.confirm(
  Zotero.getMainWindow(),
  'Title',
  'Message'
);
```

### 13. SQLite in Zotero - Use Tables in Main DB, Not ATTACH

SQLite is the storage backend for this plugin. Avoid `ATTACH DATABASE` for separate files - it causes issues with transactions and can crash Zotero.

```javascript
// ❌ WRONG - ATTACH DATABASE causes issues
await Zotero.DB.queryAsync('ATTACH DATABASE ? AS mydb', ['/path/to/file.sqlite']);
await Zotero.DB.queryAsync('CREATE TABLE mydb.embeddings (...)');

// ✅ CORRECT - Create tables directly in Zotero's main DB with a prefix
await Zotero.DB.queryAsync(`
  CREATE TABLE IF NOT EXISTS ss_embeddings (
    item_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,
    embedding TEXT NOT NULL,
    ...
    PRIMARY KEY (item_id, chunk_index)
  )
`);

// Access via normal queries
await Zotero.DB.queryAsync('SELECT * FROM ss_embeddings WHERE item_id = ?', [itemId]);
```

Key learnings:
- **Use table prefix** (e.g., `ss_`) to avoid conflicts with Zotero's tables
- **Store embeddings as JSON strings** - SQLite bindings don't handle Float32Array well
- **Use transactions** for batch inserts to improve performance
- **Lazy initialization** - Don't initialize SQLite on plugin startup, only when needed
- **Tables persist** in Zotero's main database file (`zotero.sqlite`)
- **In-memory caching** - Cache embeddings as pre-normalized Float32Arrays for fast search

### 14. Zotero 8 DB wrapper quirk: `queryAsync()` may return empty results even when rows exist

This plugin hit a subtle Zotero 8 beta issue while implementing **Find Similar Papers**.

#### Symptom

The SQLite table clearly had data:

- `SELECT COUNT(*) FROM ss_embeddings` returned a non-zero count (e.g., 10)
- `isIndexed(itemId)` returned `true`
- `get(itemId)` could still retrieve the embedding (often via per-field fallbacks)

…but the similarity search returned:

- `Retrieved 0 embeddings from store`
- `Found 0 similar papers`

In other words: **the store had rows, but `getAll()` returned `[]`**.

#### UPDATE: Fixed with Reliable Methods (December 2025)

We've completely fixed this issue by replacing all `queryAsync()` calls for data retrieval with more reliable methods:

```typescript
// ❌ OLD - Unreliable in Zotero 8
const rows = await Zotero.DB.queryAsync(`SELECT * FROM ss_embeddings`);
// Often returns [] even when data exists!

// ✅ NEW - Reliable methods
// For single columns:
const ids = await Zotero.DB.columnQueryAsync(`SELECT item_id FROM ss_embeddings`);

// For single values:
const exists = await Zotero.DB.valueQueryAsync(`SELECT 1 FROM ss_embeddings WHERE item_id = ? LIMIT 1`, [itemId]);

// For multiple fields - fetch in parallel:
const [itemKey, title, embedding] = await Promise.all([
  Zotero.DB.valueQueryAsync(`SELECT item_key FROM ss_embeddings WHERE item_id = ?`, [itemId]),
  Zotero.DB.valueQueryAsync(`SELECT title FROM ss_embeddings WHERE item_id = ?`, [itemId]),
  Zotero.DB.valueQueryAsync(`SELECT embedding FROM ss_embeddings WHERE item_id = ?`, [itemId]),
]);
```

**Key principle:** Never use `queryAsync()` for reading data - only for writes (INSERT, UPDATE, DELETE).

#### Why it happens

On some Zotero 8 betas, the SQLite wrapper behind `Zotero.DB.queryAsync()` can occasionally return:

- `undefined`, or
- an empty array,

for certain `SELECT` queries (especially multi-column selects), **even though the database contains rows**.

This is why "count queries" may succeed while "metadata queries" come back empty.

#### The fix (robust fallback strategy)

The solution is to avoid relying on a single multi-column `queryAsync()` call when you *know* data should exist:

- Prefer `Zotero.DB.columnQueryAsync()` for single-column result sets (it's often more reliable for "ID list" queries).
- If metadata batch fetch returns empty, fetch a reliable list of item IDs first, then reconstruct rows using `Zotero.DB.valueQueryAsync()` per field.
- Don't gate the fallback on `getCount()` alone — if the ID list is available, just rebuild rows from IDs.

#### Key insight: multi-column queries are unreliable

| Query Type | Reliability |
|------------|-------------|
| `SELECT COUNT(*)` | ✅ Usually works |
| `columnQueryAsync("SELECT item_id ...")` | ✅ Usually works |
| `valueQueryAsync("SELECT field WHERE id = ?")` | ✅ Usually works |
| `queryAsync("SELECT col1, col2, col3 ...")` | ⚠️ May return empty |

The pattern: **use single-column queries to get keys, then fetch fields individually**.

**Tip:** Use `Zotero.debug()` for warnings, reserve `Zotero.logError()` for true errors only.

### 15. In-Memory Caching for Fast Search

Cache embeddings with pre-normalized Float32Arrays for 4-5x faster searches:

| Operation | Before | After | Improvement |
|-----------|--------|-------|-------------|
| First search | ~200ms | ~200ms | Same (cache miss) |
| Subsequent | ~200ms | <50ms | **4-5x faster** |

**Key techniques:**
- Cache expires after 5 minutes
- Pre-normalize vectors so similarity = dot product
- Use Float32Array (50% less memory than JS arrays)
- Invalidate cache on any data mutation (put, delete, clear)

### 16. Academic-Aware Document Chunking

For semantic search over academic papers, generic text splitting (by character count or sentence) loses important context. Academic papers have predictable structure that we can exploit.

#### The Problem with Generic Chunking

| Approach | Issue |
|----------|-------|
| Character-based | Cuts mid-sentence, loses context |
| Sentence-based | Ignores document structure |
| Fixed overlap | Wastes tokens on redundant content |

#### Our Solution: Section-Based Splitting

Academic papers follow conventions (IMRaD: Intro, Methods, Results, Discussion). We split at natural boundaries:

```typescript
// Matches common section headers
const SECTION_PATTERN = /\n(?=(?:\d+\.?\s+)?(?:Abstract|Introduction|Methods|Results|Discussion|Conclusion|...)\b)/i;

function splitAcademicText(text: string, maxChars: number): string[] {
  // 1. Split by section headers first
  const sections = text.split(SECTION_PATTERN);

  // 2. For sections > maxChars, split by paragraphs
  return sections.flatMap(section =>
    section.length > maxChars
      ? splitByParagraphs(section, maxChars)
      : [section]
  );
}
```

#### Schema for Multi-Chunk Storage

```sql
CREATE TABLE ss_embeddings (
    item_id INTEGER NOT NULL,
    chunk_index INTEGER NOT NULL DEFAULT 0,  -- 0 = summary, 1+ = content
    -- ... other fields
    PRIMARY KEY (item_id, chunk_index)
);
```

#### Search with MaxSim Aggregation

When searching across chunks, we use MaxSim - return the highest similarity from any chunk:

```typescript
for (const chunk of allChunks) {
  const sim = cosineSimilarity(query, chunk.embedding);
  const existing = results.get(chunk.itemId);
  if (!existing || sim > existing.maxSim) {
    results.set(chunk.itemId, { maxSim: sim, ...chunk });
  }
}
```

#### Indexing Modes

| Mode | Embeddings/Paper | Index Time | Storage | Quality |
|------|------------------|------------|---------|---------|
| `abstract` | 1 | ~150ms | ~10KB | Good |
| `fulltext` | 5-20 | ~1-3s | ~100KB | Better |
| `hybrid` | 6-21 | ~1-3s | ~100KB | Best |

#### Configuration

```javascript
// prefs.js - Updated for nomic-embed-text-v1.5 (8K token context)
pref("extensions.zotero.zotseek.indexingMode", "fulltext");  // "abstract" | "fulltext" | "hybrid"
pref("extensions.zotero.zotseek.maxTokens", 2000);           // Max tokens per chunk (model supports 8192)
pref("extensions.zotero.zotseek.maxChunksPerPaper", 10);     // Fewer chunks needed with larger context
```

#### Migration from V1 Schema

The plugin automatically migrates existing embeddings (v1 schema with single embedding per item) to the new v2 schema (with `chunk_index` column). Existing embeddings are assigned `chunk_index = 0`.

### 17. Context Menus: XUL vs MenuManager API

Zotero 8 introduces a new official `Zotero.MenuManager` API for custom menus. However, **it requires localization setup** (`l10nID`), not plain text labels.

#### MenuManager Requires Localization (l10nID)

The MenuManager API does NOT support plain `label` text - using it results in empty menu items!

```javascript
// ❌ WRONG - label property doesn't work
Zotero.MenuManager.registerMenu({
  menus: [{ menuType: 'menuitem', label: 'My Action' }]  // Empty menu item!
});

// ✅ CORRECT - requires l10nID with .ftl localization file
Zotero.MenuManager.registerMenu({
  menus: [{ menuType: 'menuitem', l10nID: 'my-plugin-action-label' }]
});
```

This requires setting up a `.ftl` localization file and registering it.

🔗 Reference: [Zotero Dev Discussion](https://groups.google.com/g/zotero-dev/c/JJ7c1XV0QHU)

#### XUL Injection (Recommended for Simple Cases)

For plugins that don't need localization, XUL injection works reliably on both Zotero 7 and 8:

```javascript
const doc = Zotero.getMainWindow().document;
const menu = doc.getElementById('zotero-itemmenu');

const menuItem = doc.createXULElement('menuitem');
menuItem.id = 'my-plugin-menu';
menuItem.setAttribute('label', 'My Action');  // Plain text works!
menuItem.addEventListener('command', () => doSomething());

menu.appendChild(menuItem);
```

**Note on icons:** Context menu icons are intentionally disabled on macOS (before macOS 26).

#### When to Use Which

| Approach | Pros | Cons |
|----------|------|------|
| **XUL Injection** | Plain text labels, simple setup | Manual cleanup needed |
| **MenuManager** | Auto-cleanup, official API | Requires `.ftl` localization setup |

**Our plugin uses XUL injection** - it's simpler and works everywhere.

🔗 Reference: [Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers)

### 18. Progress Windows (Use zotero-plugin-toolkit)

Native Zotero `ProgressWindow` can be unstable. Use **zotero-plugin-toolkit**'s `ProgressWindowHelper`:

```bash
npm install --save zotero-plugin-toolkit
```

```typescript
import { StableProgressWindow } from './utils/stable-progress';

const progress = new StableProgressWindow({
  title: 'Indexing Library',
  cancelCallback: () => { this.cancelled = true; }
});

progress.updateProgressWithETA('Processing...', 50, 100);  // Auto-calculates ETA
progress.complete('Done!', true);  // auto-close after 4s
```

**Best practices:** Always support cancellation for ops > 5s, show ETA, don't auto-close on errors.

🔗 [ProgressWindowHelper API](https://windingwind.github.io/zotero-plugin-toolkit/reference/Class.ProgressWindowHelper.html)

### 19. VirtualizedTableHelper: Native Zotero Tables

Use `VirtualizedTableHelper` from zotero-plugin-toolkit for native tables with virtualization, sorting, and resizing.

#### Critical Gotchas (Undocumented!)

1. **Use `staticWidth`, not `fixedWidth`** for fixed-width columns
2. **Always include `hidden: false`** on every column
3. **Container must be `hbox` with `virtualized-table-container` class**
4. **`getRowData` keys must exactly match column `dataKey` values**

```xml
<!-- Required XHTML structure -->
<hbox class="virtualized-table-container" flex="1" height="400">
  <html:div id="my-table-container" />
</hbox>
```

```xml
<!-- Required CSS includes for resize handles -->
<?xml-stylesheet href="chrome://zotero-platform/content/zotero-react-client.css" type="text/css"?>
<?xml-stylesheet href="chrome://zotero-platform/content/zotero.css" type="text/css"?>
```

See `src/ui/search-dialog-vtable.ts` for complete implementation.

### 20. Preference Panes: Clean Architecture

Use hooks pattern instead of inline JavaScript in XHTML:

```
preferences.xhtml → onload event → index.ts hooks → preferences.ts (logic)
```

```xml
<vbox onload="Zotero.MyPlugin?.hooks.onPrefsEvent('load', {window})"
      onunload="Zotero.MyPlugin?.hooks.onPrefsEvent('unload', {window})">
  <!-- Declarative UI only, no inline JS -->
</vbox>
```

**Key principles:**
1. Keep XHTML purely declarative
2. Route events through plugin hooks
3. Handle all logic in TypeScript modules
4. Use `Zotero.Prefs.get/set('key', true)` (second param avoids prefix doubling)

See `src/ui/preferences.ts` for complete implementation.

🔗 [Zotero 7 Preferences docs](https://www.zotero.org/support/dev/zotero_7_for_developers#preferences)

### 21. Toolbar Buttons & MenuManager with FTL Localization (December 2025)

Adding UI elements to Zotero's toolbar and menus requires specific patterns to ensure proper styling and functionality.

#### Toolbar Buttons: Clone for Proper Styling

Creating toolbar buttons from scratch results in incorrect margins and sizes. The solution is to **clone an existing button**:

```typescript
// ❌ WRONG - Inconsistent styling
const button = doc.createXULElement('toolbarbutton');
button.style.marginRight = '8px';  // Manual styling doesn't match Zotero's

// ✅ CORRECT - Clone existing button
const lookupNode = toolbar.querySelector('#zotero-tb-lookup');
const button = lookupNode.cloneNode(true);
button.setAttribute('id', 'my-plugin-button');
button.setAttribute('label', 'SS');
button.style.listStyleImage = 'url("chrome://my-plugin/content/icons/icon-toolbar.svg")';
```

**Key learnings:**
- Clone `#zotero-tb-lookup` to inherit proper toolbar styling
- Clear inherited event handlers (`command`, `oncommand`, etc.)
- Use 20x20 SVG icons with `context-fill` for theme support
- Add `toolbarseparator` elements for visual separation

#### MenuManager Requires FTL Localization

The `Zotero.MenuManager` API does NOT support plain `label` text - it requires Fluent localization:

```typescript
// ❌ WRONG - Results in empty menu item!
Zotero.MenuManager.registerMenu({
  menus: [{ menuType: 'menuitem', label: 'My Action' }]  // Empty!
});

// ✅ CORRECT - Use l10nID with FTL file
Zotero.MenuManager.registerMenu({
  menus: [{ menuType: 'menuitem', l10nID: 'my-plugin-action' }]
});
```

**Required setup:**

1. **Create FTL file** (`locale/en-US/my-plugin-menu.ftl`):
   ```ftl
   my-plugin-action =
       .label = My Plugin Action
   ```

2. **Register locale in bootstrap.js**:
   ```javascript
   chromeHandle = aomStartup.registerChrome(manifestURI, [
     ["content", "my-plugin", rootURI + "content/"],
     ["locale", "my-plugin", "en-US", rootURI + "locale/en-US/"],
   ]);
   ```

3. **Load FTL before registering menu**:
   ```typescript
   window.MozXULElement.insertFTLIfNeeded('my-plugin-menu.ftl');
   ```

**Key learnings:**
- MenuManager labels only work with `l10nID`, not `label`
- FTL files must be registered in `bootstrap.js` chrome registration
- Call `insertFTLIfNeeded()` before `registerMenu()`
- Use XUL injection for context menus if you don't need localization

#### Icon Theming with context-fill

For icons to adapt to Zotero's light/dark themes:

```xml
<svg fill="context-fill" fill-opacity="context-fill-opacity">
  <path d="..." />
</svg>
```

This allows Zotero to control the icon color based on the current theme.

---

## Resources

### Official Documentation

- [Zotero Plugin Development](https://www.zotero.org/support/dev/client_coding/plugin_development)
- [Zotero 7 for Developers](https://www.zotero.org/support/dev/zotero_7_for_developers)
- [Zotero 8 for Developers](https://www.zotero.org/support/dev/zotero_8_for_developers)
- [Zotero API Reference](https://www.zotero.org/support/dev/client_coding)

### Community Resources

- [Zotero Dev Google Group](https://groups.google.com/g/zotero-dev) - **Ask questions here!**
- [Zotero Plugin Template](https://github.com/windingwind/zotero-plugin-template) - TypeScript starter
- [Zotero Plugin Toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - Utility library
- [Zotero Plugin Dev Community](https://zotero-plugin.dev/) - Guides and tools

### Dev Docs for Zotero Plugin (Highly Recommended!)

Comprehensive plugin development documentation by windingwind:

- [Plugin File Structure](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/plugin-file-structure.html) - manifest.json, bootstrap.js, locale, prefs.js
- [Plugin Lifecycle](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/plugin-lifecycle.html) - Hooks: startup, shutdown, onMainWindowLoad, etc.
- [Zotero Data Model](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/zotero-data-model.html) - Items, Collections, Libraries, Attachments
- [Preferences](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/preferences.html) - Storing user settings
- [Notification System](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/notification-system.html) - Listening for events
- [Resource Registry](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/resource-registry.html) - Registering resources
- [Search Operations](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/search-operations.html) - Querying items programmatically
- [Item Operations](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/item-operations.html) - Creating, modifying, deleting items
- [Collection Operations](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/collection-operations.html) - Working with collections
- [HTTP Request](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/http-request.html) - Making HTTP requests
- [File I/O](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/file-io.html) - Reading and writing files
- [Web Worker](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/web-worker.html) - Running heavy tasks in background threads
- [Privileged vs Unprivileged](https://windingwind.github.io/doc-for-zotero-plugin-dev/main/privileged-vs-unprivileged.html) - Understanding execution contexts

### Libraries Used

- [Transformers.js v3](https://huggingface.co/docs/transformers.js) - ML in ChromeWorker (see [our solution](#chromeworker--transformersjs-solution))
- [@huggingface/transformers](https://www.npmjs.com/package/@huggingface/transformers) - npm package (v3.8.1+)
- [esbuild](https://esbuild.github.io/) - Fast bundler
- [zotero-plugin-toolkit](https://github.com/windingwind/zotero-plugin-toolkit) - UI utilities (progress windows, tables)

> **Note:** We don't use `idb` - IndexedDB isn't available in Zotero's privileged context. Use `Zotero.DB` (SQLite) instead.

### Model Information

- [nomic-embed-text-v1.5](https://huggingface.co/nomic-ai/nomic-embed-text-v1.5) - **Current model** (8K tokens, 768 dims, instruction-aware)
- [jina-embeddings-v2-small-en](https://huggingface.co/jinaai/jina-embeddings-v2-small-en) - Previous model (8K tokens, 512 dims)
- [bge-small-en-v1.5](https://huggingface.co/BAAI/bge-small-en-v1.5) - Legacy model (512 tokens, 384 dims)
- [all-MiniLM-L6-v2](https://huggingface.co/sentence-transformers/all-MiniLM-L6-v2) - Legacy model (256 tokens, 384 dims)

### Key References for v3 Migration

- [Transformers.js PR #1250](https://github.com/huggingface/transformers.js/pull/1250) - wasmPaths feature
- [Transformers.js PR #1231](https://github.com/huggingface/transformers.js/pull/1231) - ORT improvements
- [Chrome Extension Guide](https://medium.com/@vprprudhvi/running-transformers-js-inside-a-chrome-extension-manifest-v3-a-practical-patch-d7ce4d6a0eac) - Inspiration for wasmPaths approach

---

## Hybrid Search Implementation

The plugin combines semantic search with Zotero's keyword search using **Reciprocal Rank Fusion (RRF)**.

### Architecture

```
┌──────────────────────────────────────────────────────────────────┐
│                      HYBRID SEARCH FLOW                          │
├──────────────────────────────────────────────────────────────────┤
│                                                                  │
│  User Query: "Smith automation bias 2023"                        │
│                              │                                   │
│              ┌───────────────┼───────────────┐                   │
│              │               │               │                   │
│              ▼               │               ▼                   │
│  ┌───────────────────┐      │      ┌───────────────────┐        │
│  │ Semantic Search   │      │      │ Keyword Search    │        │
│  │ (Embeddings)      │      │      │ (Zotero API)      │        │
│  │                   │      │      │                   │        │
│  │ 1. Embed query    │      │      │ 1. quicksearch-   │        │
│  │ 2. Cosine sim     │      │      │    everything     │        │
│  │ 3. Rank by score  │      │      │ 2. Score matches  │        │
│  └─────────┬─────────┘      │      └─────────┬─────────┘        │
│            │                │                │                   │
│            │                ▼                │                   │
│            │    ┌───────────────────┐       │                   │
│            └───►│ Reciprocal Rank   │◄──────┘                   │
│                 │ Fusion (RRF)      │                           │
│                 │                   │                           │
│                 │ score = Σ 1/(k+r) │                           │
│                 └─────────┬─────────┘                           │
│                           │                                      │
│                           ▼                                      │
│            ┌──────────────────────────────┐                     │
│            │ Results with indicators:     │                     │
│            │ 🔗 Both  🧠 Semantic  🔤 Keyword │                   │
│            └──────────────────────────────┘                     │
│                                                                  │
└──────────────────────────────────────────────────────────────────┘
```

### Key Files

| File | Purpose |
|------|---------|
| `src/core/hybrid-search.ts` | HybridSearchEngine, RRF fusion, query analysis |
| `src/core/search-engine.ts` | Semantic search with cosine similarity |
| `src/ui/search-dialog-vtable.ts` | Search dialog with mode selector |
| `src/ui/results-table.ts` | VirtualizedTable with source indicators |

### Query Analysis

The `analyzeQuery()` function auto-adjusts semantic vs keyword weights:

```typescript
// Patterns that boost keyword weight
const hasYear = /\b(19|20)\d{2}\b/.test(query);        // "2023"
const hasAuthorPattern = /[A-Z][a-z]+\s+et\s+al/i.test(query); // "Smith et al."
const hasAcronym = /\b[A-Z]{2,}\b/.test(query);        // "RLHF"

// Patterns that boost semantic weight
const isQuestion = /^(what|how|why)/i.test(query);     // "how does..."
const isConceptual = tokens.length >= 4 && !hasYear;   // long natural query
```

### RRF Algorithm

```typescript
private reciprocalRankFusion(
  semanticResults: Array<{ itemId: number; score: number }>,
  keywordResults: Array<{ itemId: number; score: number }>,
  opts: { rrfK: number; semanticWeight: number }
): HybridSearchResult[] {
  const k = opts.rrfK; // typically 60

  for (const itemId of allItemIds) {
    const semantic = semanticMap.get(itemId);
    const keyword = keywordMap.get(itemId);

    let rrfScore = 0;
    if (semantic) {
      rrfScore += semanticWeight * (1 / (k + semantic.rank));
    }
    if (keyword) {
      rrfScore += keywordWeight * (1 / (k + keyword.rank));
    }
    // Items in BOTH lists get highest combined scores
  }
}
```

### Section-Aware Results

Chunks now store their actual section type:

```typescript
// In chunker.ts
type ChunkType = 'summary' | 'methods' | 'findings' | 'content';

// Stored in SQLite
textSource: chunk.type  // 'methods', 'findings', etc.

// Displayed in results
formatSource('methods') → 'Methods'
formatSource('findings') → 'Results'
```

For complete architecture details, see [docs/SEARCH_ARCHITECTURE.md](docs/SEARCH_ARCHITECTURE.md).

---

## Next Steps

After completing this tutorial, you can:

1. **Add UI components** - Create sidebar panels, dialogs
2. **Implement indexing** - Build the full indexing workflow
3. **Add search UI** - Create the search interface
4. **Optimize performance** - Batch processing, web workers
5. **Package for distribution** - Create XPI, update server

---

*Happy plugin development! 🚀*

