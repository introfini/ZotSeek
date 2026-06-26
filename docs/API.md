# ZotSeek Plugin API

ZotSeek exposes a JavaScript API at `Zotero.ZotSeek.api` that other Zotero plugins can use to run local semantic searches against the user's indexed library.

All operations are local — embeddings are generated via Transformers.js (ONNX Runtime, WASM) and stored in a local SQLite file. No network calls are made.

> Looking for access from *outside* Zotero (CLI scripts, AI agents, MCP clients)? See [MCP.md](MCP.md) for the local MCP server and REST endpoints.

## Checking availability

```js
// Check if ZotSeek is installed
if (!Zotero.ZotSeek?.api) {
  throw new Error("ZotSeek plugin is not installed");
}

// Optionally check if the pipeline is already warm
if (Zotero.ZotSeek.api.isReady()) {
  // Pipeline loaded, searches will be fast
}
```

`isReady()` returns `true` when the embedding pipeline is loaded and the vector store is initialized. The pipeline loads lazily on first use — you don't need to wait for `isReady()` before calling `search()`.

## Cold start

The embedding pipeline (ONNX model, ~30s to load) initializes automatically on the first call to `search()`. Subsequent calls are instant. If you want to pre-warm the pipeline, call `search()` with a dummy query during your plugin's startup.

Methods that don't need the embedding pipeline (`findSimilar`, `getStats`, `isReady`) are available immediately.

## Methods

### `search(query, options?)`

Run a semantic search against the indexed library. Auto-initializes the embedding pipeline on first call.

```js
const results = await Zotero.ZotSeek.api.search("transformer attention mechanisms", {
  topK: 20,
  minSimilarity: 0.3,
});
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `query` | `string` | *(required)* | Natural language search query |
| `options.topK` | `number` | `20` | Maximum number of results |
| `options.minSimilarity` | `number` | `0.3` | Minimum cosine similarity threshold (0–1) |
| `options.libraryId` | `number` | — | Restrict search to a specific library |
| `options.excludeItemIds` | `number[]` | — | Item IDs to exclude from results |
| `options.returnAllChunks` | `boolean` | `false` | Return all matching chunks instead of one result per paper |

**Returns:** `Promise<SearchResult[]>`

```ts
interface SearchResult {
  itemId: number;          // Zotero internal item ID
  itemKey: string;         // Portable Zotero item key (syncs across libraries)
  title: string;
  similarity: number;      // 0–1 cosine similarity score
  textSource: string;      // "summary" | "methods" | "findings" | "content" | "abstract"
  matchedChunkIndex?: number;
  chunkIndex?: number;     // Present when returnAllChunks=true
  authors?: string[];
  year?: number;
  pageNumber?: number;     // 1-based page number of matched chunk
  paragraphIndex?: number; // 0-based paragraph index within page
}
```

Results are ranked by similarity (descending). When `returnAllChunks` is `false` (default), MaxSim aggregation is used: each paper appears once with the score of its best-matching chunk.

### `findSimilar(itemId, options?)`

Find papers similar to a given item. Uses the item's stored embeddings as the query — does not need the embedding pipeline.

```js
const similar = await Zotero.ZotSeek.api.findSimilar(item.id, {
  topK: 10,
});
```

**Parameters:**

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `itemId` | `number` | *(required)* | Zotero item ID of the source paper (must be indexed) |
| `options` | `SearchOptions` | — | Same options as `search()` |

**Returns:** `Promise<SearchResult[]>` — same format as `search()`, excluding the source item.

### `indexItems(items)`

Index one or more Zotero items (extract text, generate embeddings, store in database).

```js
const items = Zotero.Items.getAll(Zotero.Libraries.userLibraryID);
await Zotero.ZotSeek.api.indexItems(items);
```

**Parameters:**

| Parameter | Type | Description |
|-----------|------|-------------|
| `items` | `Zotero.Item[]` | Array of Zotero item objects |

**Returns:** `Promise<void>`

Items that are already indexed (matching content hash) are skipped. Progress is saved in checkpoints every ~25 items, so it's safe to interrupt.

### `getStats()`

Get statistics about the current index. Available immediately (no pipeline needed).

```js
const stats = await Zotero.ZotSeek.api.getStats();
```

**Returns:** `Promise<VectorStoreStats>`

```ts
interface VectorStoreStats {
  totalPapers: number;
  indexedPapers: number;
  totalChunks: number;
  avgChunksPerPaper: number;
  modelId: string;              // active model id, e.g. "nomic-embed-text-v1.5"
  activeModel: string;          // active model id (explicit field)
  coverage: {                   // items searchable with the active model
    covered: number;
    total: number;
  };
  lastIndexed: Date | null;
  storageUsedBytes: number;
  chunksWithLocation: number;   // Chunks that have page numbers
  locationCoveragePercent: number;
}
```

### `reindexForActiveModel()`

Index every item that is not yet covered by the currently active embedding model, in the background. Embeddings produced by other models are preserved. This is the same action triggered by the "Index remaining" button in Settings and by the prompt shown when you switch models.

```js
await Zotero.ZotSeek.api.reindexForActiveModel();
```

**Returns:** `Promise<void>` - resolves when the background indexing run completes.

### `compactDatabase()`

Compact the database file to reclaim unused space. Useful after large deletions or schema migrations. Cannot be called while indexing is in progress.

```js
const result = await Zotero.ZotSeek.compactDatabase();
// result: "Compacted: 1701.8 MB -> 850.9 MB (saved 850.9 MB)"
```

**Returns:** `Promise<string>` - Human-readable summary of before/after sizes.

**Throws:** If called during active indexing or if the store is not ready.

> **Note:** This method is on `Zotero.ZotSeek` (not `Zotero.ZotSeek.api`).

### `isReady()`

Check if the embedding pipeline is loaded and ready. Useful to show loading state in your UI, but not required before calling `search()`.

```js
const ready = Zotero.ZotSeek.api.isReady();
```

**Returns:** `boolean`

## Example: Plugin integration

```js
async function searchWithZotSeek(query) {
  // Check if ZotSeek is installed
  if (!Zotero.ZotSeek?.api) {
    throw new Error("ZotSeek plugin is not installed");
  }

  // search() auto-initializes the pipeline on first call (~30s)
  // Subsequent calls are instant
  const results = await Zotero.ZotSeek.api.search(query, {
    topK: 10,
    minSimilarity: 0.4,
  });

  // Each result has itemId, itemKey, title, similarity, pageNumber, etc.
  return results.map(r => ({
    key: r.itemKey,
    title: r.title,
    score: r.similarity,
    page: r.pageNumber,
  }));
}
```

## Notes

- **This is an in-process JavaScript API, not a web service.** It can only be called from code running inside Zotero — other plugins, the Browser Toolbox console, or via the MCP Bridge's `zotero_execute_js`. External tools (Python scripts, CLI, HTTP requests) cannot call it directly.
- All methods are async except `isReady()`.
- `itemId` is Zotero's internal numeric ID (local to this profile). `itemKey` is the portable string key that syncs across libraries.
- The embedding model is `Xenova/nomic-embed-text-v1.5` (768 dimensions). Query text is automatically prefixed with `search_query:` for asymmetric search.
