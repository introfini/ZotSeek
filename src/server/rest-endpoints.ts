/**
 * Plain REST endpoints over Zotero's local HTTP server (issue #32).
 * "Just curl it" interface: GET + query params + JSON out. Shares the
 * tool layer (and result shapes) with the MCP endpoint.
 */
import {
  runSearchTool,
  runFindSimilarTool,
  runIndexStatusTool,
  isAllowedOrigin,
} from './http-tools';

export const REST_PATHS = {
  search: '/zotseek/search',
  similar: '/zotseek/similar',
  stats: '/zotseek/stats',
};

type EndpointResponse = [number, string, string];

function json(status: number, payload: any): EndpointResponse {
  return [status, 'application/json', JSON.stringify(payload)];
}

function originGuard(requestData: any): EndpointResponse | null {
  const headers = requestData?.headers || {};
  if (!isAllowedOrigin(headers['origin'])) {
    return json(403, { error: 'Forbidden: non-local Origin' });
  }
  return null;
}

export async function handleSearchRequest(requestData: any): Promise<EndpointResponse> {
  const denied = originGuard(requestData);
  if (denied) return denied;
  const sp: URLSearchParams = requestData.searchParams;
  const q = sp.get('q');
  if (!q || !q.trim()) {
    return json(400, { error: 'Missing required query parameter: q' });
  }
  try {
    const payload = await runSearchTool({
      query: q,
      library_key: sp.get('libraryKey') || undefined,
      max_results: sp.get('topK') ? parseInt(sp.get('topK') as string, 10) : undefined,
      mode: (sp.get('mode') as any) || undefined,
      granularity: (sp.get('granularity') as any) || undefined,
      min_similarity: sp.get('minSimilarity')
        ? parseFloat(sp.get('minSimilarity') as string)
        : undefined,
    });
    return json(200, payload);
  } catch (e: any) {
    return json(400, { error: e?.message || String(e) });
  }
}

export async function handleSimilarRequest(requestData: any): Promise<EndpointResponse> {
  const denied = originGuard(requestData);
  if (denied) return denied;
  const sp: URLSearchParams = requestData.searchParams;
  const itemKey = sp.get('itemKey');
  if (!itemKey || !itemKey.trim()) {
    return json(400, { error: 'Missing required query parameter: itemKey' });
  }
  try {
    const payload = await runFindSimilarTool({
      item_key: itemKey,
      library_key: sp.get('libraryKey') || undefined,
      max_results: sp.get('topK') ? parseInt(sp.get('topK') as string, 10) : undefined,
    });
    return json(200, payload);
  } catch (e: any) {
    return json(400, { error: e?.message || String(e) });
  }
}

export async function handleStatsRequest(requestData: any): Promise<EndpointResponse> {
  const denied = originGuard(requestData);
  if (denied) return denied;
  try {
    return json(200, await runIndexStatusTool());
  } catch (e: any) {
    return json(500, { error: e?.message || String(e) });
  }
}

export function ZotSeekSearchEndpoint(this: any) {}
ZotSeekSearchEndpoint.prototype = {
  supportedMethods: ['GET'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  init: handleSearchRequest,
};

export function ZotSeekSimilarEndpoint(this: any) {}
ZotSeekSimilarEndpoint.prototype = {
  supportedMethods: ['GET'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  init: handleSimilarRequest,
};

export function ZotSeekStatsEndpoint(this: any) {}
ZotSeekStatsEndpoint.prototype = {
  supportedMethods: ['GET'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  init: handleStatsRequest,
};
