/**
 * MCP (Model Context Protocol) endpoint over Zotero's local HTTP server.
 *
 * Implements the minimal stateless subset of the Streamable HTTP transport:
 * JSON-RPC 2.0 over POST, plain application/json responses, no SSE, no
 * sessions (no Mcp-Session-Id — permitted by the MCP spec and deliberate:
 * Zotero's DB connection can recycle mid-session, so the less state the
 * better; see CLAUDE.md pitfall #11).
 *
 * Connect with: claude mcp add --transport http --scope user zotseek http://localhost:23119/zotseek/mcp
 *
 * Module-level functions + plain-constructor endpoint (pitfall #6).
 */
import {
  runSearchTool,
  runFindSimilarTool,
  runIndexStatusTool,
  isAllowedOrigin,
} from './http-tools';

declare const Zotero: any;

export const MCP_PATH = '/zotseek/mcp';

// Newest MCP revision this server knows; echoed back when the client
// requests an unknown/invalid version.
const LATEST_PROTOCOL_VERSION = '2025-06-18';

// Protocol revisions this server will echo back verbatim. A client asking
// for anything outside this set is answered with LATEST_PROTOCOL_VERSION.
const SUPPORTED_PROTOCOL_VERSIONS = ['2024-11-05', '2025-03-26', '2025-06-18'];

const TOOL_DEFINITIONS = [
  {
    name: 'search',
    description:
      "Semantic search over the user's Zotero library using ZotSeek's local " +
      'embeddings. Returns papers ranked by relevance, with matched text ' +
      'excerpts and page numbers where available. Each result carries ' +
      'zotero:// deep links: links.select opens the item in Zotero, ' +
      'links.openPdf opens the PDF at the matched page — include them when ' +
      'citing results to the user. If your client does not render zotero:// ' +
      'URIs as clickable links, use links.selectHttp / links.openPdfHttp ' +
      'instead (same action via a local http launcher). 100% local; no data ' +
      'leaves the machine. ' +
      'Hybrid-mode scores are RRF values (small numbers, ~0.005-0.03) meaningful only for ranking within one result set; semantic-mode scores are 0-1 cosine similarities.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural-language search query' },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
        mode: {
          type: 'string',
          enum: ['hybrid', 'semantic', 'keyword'],
          default: 'hybrid',
          description:
            'hybrid = semantic + keyword fused with RRF, honoring the user\'s ' +
            'ZotSeek preferences including automatic weight adjustment (same ' +
            'results as the ZotSeek dialog); semantic = embeddings only; ' +
            'keyword = Zotero keyword search only',
        },
        min_similarity: {
          type: 'number',
          minimum: 0,
          maximum: 1,
          description:
            'Minimum semantic similarity (0-1). Defaults to the user\'s ' +
            'ZotSeek preference (typically 0.3).',
        },
        granularity: {
          type: 'string',
          enum: ['papers', 'passages'],
          default: 'papers',
          description:
            'papers = one result per paper (best-matching chunk); ' +
            'passages = every matching chunk as its own result',
        },
        library_key: {
          type: 'string',
          description:
            "'user' for the personal library, or 'group:<groupID>' to limit the search to one group library. " +
            'Omit to search all indexed libraries.',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'find_similar',
    description:
      'Find papers similar to a known library item, using its stored ' +
      'embeddings. Identify the item by its 8-character Zotero item key. ' +
      'Results carry zotero:// deep links (links.select / links.openPdf; ' +
      'use the links.selectHttp / links.openPdfHttp variants when your ' +
      'client only linkifies http URLs).',
    inputSchema: {
      type: 'object',
      properties: {
        item_key: {
          type: 'string',
          description: '8-character Zotero item key of the source paper (must be indexed)',
        },
        library_key: {
          type: 'string',
          default: 'user',
          description: "'user' for the personal library, or 'group:<groupID>'",
        },
        max_results: { type: 'integer', minimum: 1, maximum: 100, default: 10 },
      },
      required: ['item_key'],
    },
  },
  {
    name: 'index_status',
    description:
      'Report ZotSeek index status: number of indexed papers, total chunks, ' +
      'embedding model, last-indexed time. Call this first to check whether ' +
      'search results will be meaningful.',
    inputSchema: { type: 'object', properties: {} },
  },
];

type EndpointResponse = [number, string, string];

function rpcError(id: any, code: number, message: string): object {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

function ok(id: any, result: any): EndpointResponse {
  return [200, 'application/json', JSON.stringify({ jsonrpc: '2.0', id: id ?? null, result })];
}

function err(status: number, id: any, code: number, message: string): EndpointResponse {
  return [status, 'application/json', JSON.stringify(rpcError(id, code, message))];
}

function toolText(payload: any, isError = false): object {
  const result: any = {
    content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }],
  };
  if (isError) result.isError = true;
  return result;
}

async function callTool(id: any, params: any): Promise<EndpointResponse> {
  const name = params?.name;
  const args = params?.arguments || {};
  let payload: any;
  try {
    if (name === 'search') {
      payload = await runSearchTool(args);
    } else if (name === 'find_similar') {
      payload = await runFindSimilarTool(args);
    } else if (name === 'index_status') {
      payload = await runIndexStatusTool();
    } else {
      return err(200, id, -32602, `Unknown tool: ${String(name)}`);
    }
  } catch (e: any) {
    // Tool execution errors are MCP tool results, not protocol errors,
    // so the agent can read the message and react.
    return ok(id, toolText({ error: e?.message || String(e) }, true));
  }
  return ok(id, toolText(payload));
}

export async function handleMcpRequest(requestData: any): Promise<EndpointResponse> {
  const headers = requestData?.headers || {};
  if (!isAllowedOrigin(headers['origin'])) {
    return err(403, null, -32600, 'Forbidden: non-local Origin');
  }

  const msg = requestData?.data;
  if (
    !msg || typeof msg !== 'object' || Array.isArray(msg) ||
    msg.jsonrpc !== '2.0' || typeof msg.method !== 'string'
  ) {
    return err(400, null, -32600, 'Invalid JSON-RPC 2.0 request');
  }

  const { id, method, params } = msg;

  // Notifications (no response body expected). 202 per the MCP spec.
  // Zotero's responseCodes table has no 202 entry, so the status line's
  // reason phrase comes out as "undefined" — harmless; clients ignore
  // reason phrases, and the status code itself is correct.
  if (method.startsWith('notifications/')) {
    return [202, 'text/plain', ''];
  }

  try {
    switch (method) {
      case 'initialize': {
        const requested = params?.protocolVersion;
        const protocolVersion =
          typeof requested === 'string' && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
            ? requested
            : LATEST_PROTOCOL_VERSION;
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: 'zotseek',
            version: Zotero.ZotSeek?.info?.version || 'unknown',
          },
        });
      }
      case 'ping':
        return ok(id, {});
      case 'tools/list':
        return ok(id, { tools: TOOL_DEFINITIONS });
      case 'tools/call':
        return callTool(id, params);
      default:
        return err(200, id, -32601, `Method not found: ${method}`);
    }
  } catch (e: any) {
    return err(200, id, -32603, e?.message || 'Internal error');
  }
}

/**
 * Endpoint constructor for Zotero.Server.Endpoints. Plain constructor with
 * explicit prototype — the shape Zotero's own endpoints use, and the most
 * reliable under the esbuild IIFE bundle (pitfall #6).
 */
export function ZotSeekMCPEndpoint(this: any) {}
ZotSeekMCPEndpoint.prototype = {
  supportedMethods: ['POST'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  init: handleMcpRequest,
};
