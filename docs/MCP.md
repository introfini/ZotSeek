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
claude mcp add --transport http --scope user zotseek http://localhost:23119/zotseek/mcp
```

For **OpenAI Codex**, add it with (registers globally for your user):

```bash
codex mcp add zotseek --url http://localhost:23119/zotseek/mcp
```

or equivalently in `~/.codex/config.toml`:

```toml
[mcp_servers.zotseek]
url = "http://localhost:23119/zotseek/mcp"
```

Any other MCP client that supports the HTTP transport works the same way (for example, a Claude Desktop custom connector). Point it at the URL above.

## MCP Tools

| Tool | Arguments | Returns |
|------|-----------|---------|
| `search` | `query` *(required)*; `max_results` (1–100, default 10); `mode` (`hybrid` \| `semantic` \| `keyword`, default `hybrid`); `granularity` (`papers` \| `passages`, default `papers`); `min_similarity` (0–1, defaults to your ZotSeek preference); `library_key` (`user` or `group:<groupID>`, omit to search all indexed libraries) | Ranked results from a semantic/keyword search over the library |
| `find_similar` | `item_key` *(required, 8-character Zotero key)*; `library_key` (`user` or `group:<groupID>`, default `user`); `max_results` (1–100, default 10) | Papers similar to a known library item, by its stored embeddings |
| `index_status` | *(none)* | `{ready, modelLoaded, indexedPapers, totalChunks, modelId, activeModel, coverage, lastIndexed, storageUsedBytes}` |

`mode` mirrors the ZotSeek UI: **hybrid** fuses semantic and keyword results with RRF, honoring your ZotSeek preferences including automatic weight adjustment, so it returns the same ranking you see in the ZotSeek dialog; **semantic** uses embeddings only (same code path as the [JS API](API.md)'s `search()`); **keyword** uses Zotero's keyword search only. `granularity` controls whether you get one result per paper (`papers`, best-matching chunk) or every matching chunk as its own result (`passages`).

`library_key` narrows `search` to a single library; when omitted, results come from every indexed library. Note the different default on `find_similar`: there `library_key` identifies the library of the *source* item and defaults to `user`.

For `index_status`, `ready` is `true` when the index contains papers; the embedding model itself lazy-loads on the first search, adding ~30s to that first call when `modelLoaded` is `false`. `modelLoaded` reports whether that pipeline is already warm. A `ready: true, modelLoaded: false` status means searches will work but the first one will be slow. `activeModel` is the short identifier of the currently configured embedding model (e.g. `"bge-m3"`). `coverage` is `{ covered, total }` — the number of library items indexed under that model vs. the total items in the index, letting agents detect when a model switch has left items to be re-indexed.

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
  "semanticScore": 0.763,
  "keywordScore": 0.65,
  "source": "both",
  "matchedChunk": {
    "snippet": "The Transformer relies entirely on self-attention to compute representations...",
    "page": 3,
    "textSource": "methods"
  },
  "links": {
    "select": "zotero://select/library/items/ABCD2345",
    "selectHttp": "http://localhost:23119/zotseek/open?target=select&key=ABCD2345",
    "openPdf": "zotero://open-pdf/library/items/WXYZ6789?page=3",
    "openPdfHttp": "http://localhost:23119/zotseek/open?target=pdf&key=WXYZ6789&page=3"
  }
}
```

Notes on the shape:

- `source` (`"both"` | `"semantic"` | `"keyword"`) is present on `search` results only — it reports which engine found the item.
- `libraryKey` is `"user"` or `"group:<groupID>"`, or `null` for items that can no longer be resolved locally (e.g. indexed on another machine and not present in this library); a `null` `libraryKey` also means no `links` are emitted.
- `authors` is a formatted string for `search` results and an array of strings for `find_similar` results.
- `matchedChunk` is `null` when no excerpt or page is available; `page` and `textSource` may be absent within it. In `hybrid` mode this is now rare: hits found only by the keyword engine are matched against the item's own chunks before the response is built, so they carry an excerpt like any other result. It stays `null` for items that match on Zotero metadata but have never been indexed by ZotSeek.
- `score` is a relevance score (RRF score for `search`, cosine similarity for `find_similar`), rounded to three decimals. RRF scores are small by construction (typically 0.005-0.03) and only meaningful for ranking within a single result set; don't read them as percentages. Cosine scores (semantic mode, `find_similar`) range 0-1.
- `semanticScore` and `keywordScore` are the two values behind a fused `search` result: the cosine similarity (0-1) and the normalised keyword relevance. Either is `null` when that engine did not find the item, matching `source`. Use `semanticScore` whenever you need to compare results **across** searches — pooling several query variations, applying your own threshold, or explaining to a user why a source was retrieved. `score` cannot do that: it is a rank-fusion value, so a rank-1 result from a weak query looks identical to a rank-1 result from a good one.

#### `minSimilarity`

`minSimilarity` drops every result whose similarity to the query falls below it. In `semantic` mode and in `hybrid` mode that covers the whole result set, including hits the keyword engine contributed. In `keyword` mode nothing is compared against the query vector, so the parameter has no effect there.

Items that cannot be scored at all — matched on Zotero metadata but never indexed by ZotSeek — are exempt rather than dropped: there is no vector to compare, and removing them would silently discard metadata matches that hybrid search has always returned. They are recognisable by a `null` `matchedChunk`.

### Deep links

Each result carries `zotero://` deep links so an agent can cite a paper with a link that opens it directly in Zotero:

| Field | Opens | Notes |
|-------|-------|-------|
| `links.select` | The item in the Zotero main pane | Always present for a resolvable item |
| `links.openPdf` | The item's PDF in Zotero's reader, at the matched page | Present only when the item has a PDF; the `?page=N` lands you on the exact page that matched |
| `links.selectHttp` | Same as `select`, via a local http launcher | For clients that only linkify `http(s)` URLs |
| `links.openPdfHttp` | Same as `openPdf`, via a local http launcher | Present whenever `openPdf` is |

These links work only on the machine where this Zotero instance is running. Used together with `matchedChunk.page`, they give an agent page-precise grounding: it can quote the matched passage and hand the user a link that opens the PDF right at that page.

**Which form to use:** some chat clients only turn `http(s)://` URLs into clickable links and leave custom schemes like `zotero://` as plain text — and embedded webviews often block the protocol handoff even when the link is clicked. The `*Http` variants exist for those clients: they point at `GET /zotseek/open` on the local server, and since that request is answered by Zotero itself, the action happens directly inside Zotero (the item is selected, or the PDF opens at the page) — no `zotero://` handoff involved. The page that loads just confirms it. Clients that render `zotero://` links directly (Claude Code, for example) get a smoother jump with the plain `select`/`openPdf` forms.

## REST API

The same operations and result shapes are available as plain `GET` endpoints for scripts and CLI tools. All are served on `localhost:23119`.

| Endpoint | Query parameters |
|----------|------------------|
| `GET /zotseek/search` | `q` *(required)*, `topK`, `mode`, `granularity`, `minSimilarity` (0–1, see below), `libraryKey` (`user` or `group:N`, omit to search all indexed libraries) |
| `GET /zotseek/similar` | `itemKey` *(required)*, `libraryKey` (`user` or `group:N`), `topK` |
| `GET /zotseek/stats` | *(none)* |
| `GET /zotseek/open` | `target` (`select` \| `pdf`) *(required)*, `key` *(required)*, `library` (`user` or `group:N`), `page` (pdf only) — selects the item or opens the PDF directly in Zotero and returns a confirmation page (`404` if the item isn't in this library) |

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
      "links": { "select": "zotero://select/library/items/ABCD2345", "selectHttp": "http://localhost:23119/zotseek/open?target=select&key=ABCD2345", "openPdf": "zotero://open-pdf/library/items/WXYZ6789?page=3", "openPdfHttp": "http://localhost:23119/zotseek/open?target=pdf&key=WXYZ6789&page=3" }
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
| **Not reachable from web pages** | Zotero's server blocks browser-originated requests to the search and stats endpoints before they reach ZotSeek, and ZotSeek additionally validates the `Origin` header. The one deliberate exception is the `GET /zotseek/open` link launcher, which browsers can reach by design — it exposes no data and can only select an item or open a PDF in Zotero (strictly validated input, prefetch requests ignored) |
| **100% local** | All search and inference run on your machine; no data leaves it |

## See also

- [API.md](API.md) — the in-Zotero JavaScript API (`Zotero.ZotSeek.api`) for other Zotero plugins running inside Zotero.
- [SEARCH_ARCHITECTURE.md](SEARCH_ARCHITECTURE.md) — how hybrid search, RRF fusion, and chunking work.
