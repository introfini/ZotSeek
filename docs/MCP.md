# ZotSeek MCP Server & REST API

ZotSeek can expose your indexed library to AI agents and scripts through a local MCP server and matching REST endpoints, served on Zotero's own HTTP server.

This needs no extra software: the endpoints run inside the Zotero you already have open. They are **opt-in** (off by default), **read-only** (nothing can modify your library or the index), and bound to **localhost only** — no data leaves your machine.

Everything routes through the running Zotero, where your embeddings and index already live, so **Zotero must be running** for the endpoints to respond.

> Looking for the in-Zotero JavaScript API for other plugins (`Zotero.ZotSeek.api`)? See [API.md](API.md).

## Setup

### 1. Enable AI Agent Access

In Zotero, open **Settings → ZotSeek → AI Agent Access** and check **"Allow AI agents to search your library (local MCP server)"**. This is off by default. Toggling it takes effect immediately — no restart needed.

### 2. Allow Zotero's local HTTP server

The endpoints ride on Zotero's built-in HTTP server, which must be enabled: **Settings → Advanced → "Allow other applications on this computer to communicate with Zotero"**. If this is off, the ZotSeek pane shows a warning. Zotero serves on `localhost:23119`.

### 3. Connect your MCP client

The MCP endpoint is at `http://localhost:23119/zotseek/mcp` (Streamable HTTP transport, stateless).

For **Claude Code**, add it with:

```bash
claude mcp add --transport http zotseek http://localhost:23119/zotseek/mcp
```

Any MCP client that supports the HTTP transport works the same way (for example, a Claude Desktop custom connector). Point it at the URL above.

## MCP Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `search` | `query` *(required)*; `max_results` (1–100, default 10); `mode` (`hybrid` \| `semantic` \| `keyword`, default `hybrid`); `granularity` (`papers` \| `passages`, default `papers`) | Ranked results from a semantic/keyword search over the library |
| `find_similar` | `item_key` *(required, 8-character Zotero key)*; `library_key` (`user` or `group:<groupID>`, default `user`); `max_results` (1–100, default 10) | Papers similar to a known library item, by its stored embeddings |
| `index_status` | *(none)* | `{ready, modelLoaded, indexedPapers, totalChunks, modelId, lastIndexed, storageUsedBytes}` |

`mode` mirrors the ZotSeek UI: **hybrid** fuses semantic and keyword results with RRF, **semantic** uses embeddings only, **keyword** uses Zotero's keyword search only. `granularity` controls whether you get one result per paper (`papers`, best-matching chunk) or every matching chunk as its own result (`passages`).

For `index_status`, `ready` is `true` when the index contains papers; the embedding model itself lazy-loads on the first search, adding ~30s to that first call when `modelLoaded` is `false`. `modelLoaded` reports whether that pipeline is already warm. A `ready: true, modelLoaded: false` status means searches will work but the first one will be slow.

### Result shape

`search` and `find_similar` both return `{ "results": [...] }`, where each result item looks like this:

```json
{
  "itemKey": "ABCD2345",
  "libraryKey": "user",
  "title": "Attention Is All You Need",
  "authors": "Vaswani et al.",
  "year": 2017,
  "score": 0.016,
  "source": "both",
  "matchedChunk": {
    "snippet": "The Transformer relies entirely on self-attention to compute representations...",
    "page": 3,
    "textSource": "methods"
  },
  "links": {
    "select": "zotero://select/library/items/ABCD2345",
    "openPdf": "zotero://open-pdf/library/items/WXYZ6789?page=3"
  }
}
```

Notes on the shape:

- `source` (`"both"` | `"semantic"` | `"keyword"`) is present on `search` results only — it reports which engine found the item.
- `libraryKey` is `"user"` or `"group:<groupID>"`, or `null` for items that can no longer be resolved locally (e.g. indexed on another machine and not present in this library); a `null` `libraryKey` also means no `links` are emitted.
- `authors` is a formatted string for `search` results and an array of strings for `find_similar` results.
- `matchedChunk` is `null` when no excerpt or page is available; `page` and `textSource` may be absent within it.
- `score` is a relevance score (RRF score for `search`, cosine similarity for `find_similar`), rounded to three decimals. RRF scores are small by construction (typically 0.005-0.03) and only meaningful for ranking within a single result set; don't read them as percentages. Cosine scores (semantic mode, `find_similar`) range 0-1.

### Deep links

Each result carries `zotero://` deep links so an agent can cite a paper with a link that opens it directly in Zotero:

| Field | Opens | Notes |
|-------|-------|-------|
| `links.select` | The item in the Zotero main pane | Always present for a resolvable item |
| `links.openPdf` | The item's PDF in Zotero's reader, at the matched page | Present only when the item has a PDF; the `?page=N` lands you on the exact page that matched |

These links work only on the machine where this Zotero instance is running. Used together with `matchedChunk.page`, they give an agent page-precise grounding: it can quote the matched passage and hand the user a link that opens the PDF right at that page.

## REST API

The same operations and result shapes are available as plain `GET` endpoints for scripts and CLI tools. All are served on `localhost:23119`.

| Endpoint | Query parameters |
|----------|------------------|
| `GET /zotseek/search` | `q` *(required)*, `topK`, `mode`, `granularity` |
| `GET /zotseek/similar` | `itemKey` *(required)*, `libraryKey` (`user` or `group:N`), `topK` |
| `GET /zotseek/stats` | *(none)* |

Example:

```bash
curl 'http://localhost:23119/zotseek/search?q=transformer+attention&topK=2&mode=hybrid'
```

```json
{
  "results": [
    {
      "itemKey": "ABCD2345",
      "libraryKey": "user",
      "title": "Attention Is All You Need",
      "authors": "Vaswani et al.",
      "year": 2017,
      "score": 0.016,
      "source": "both",
      "matchedChunk": { "snippet": "The Transformer relies entirely on self-attention...", "page": 3, "textSource": "methods" },
      "links": { "select": "zotero://select/library/items/ABCD2345", "openPdf": "zotero://open-pdf/library/items/WXYZ6789?page=3" }
    }
  ]
}
```

### Errors

| Status | When |
|--------|------|
| `400` | Invalid input, or the search failed (e.g. missing `q` / `itemKey`, or an item not indexed), with `{"error": "..."}` |
| `403` | Request presents a forged non-local `Origin` header |
| `404` | AI Agent Access is disabled (the endpoints are not registered) |
| `500` | Unexpected internal failure on `GET /zotseek/stats`, with `{"error": "..."}` |

## Security

| Property | Guarantee |
|----------|-----------|
| **Opt-in** | Off by default; you enable it explicitly in ZotSeek settings |
| **Read-only** | Nothing exposed here can modify your library or the index — search and stats only |
| **Localhost only** | Endpoints bind to the loopback interface; not reachable from the network |
| **Not reachable from web pages** | Zotero's server blocks browser-originated requests before they reach the endpoint, and ZotSeek additionally validates the `Origin` header |
| **100% local** | All search and inference run on your machine; no data leaves it |

## See also

- [API.md](API.md) — the in-Zotero JavaScript API (`Zotero.ZotSeek.api`) for other Zotero plugins running inside Zotero.
- [SEARCH_ARCHITECTURE.md](SEARCH_ARCHITECTURE.md) — how hybrid search, RRF fusion, and chunking work.
