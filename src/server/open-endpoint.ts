/**
 * HTTP launcher endpoint: GET /zotseek/open?target=select|pdf&key=...&library=...&page=...
 *
 * Many chat clients only linkify http(s) URLs, so zotero:// deep links are
 * not clickable in them. This endpoint bridges the gap: an http link any
 * client can render, returning a tiny HTML page that forwards to the
 * corresponding zotero:// URI (meta refresh + manual fallback link).
 *
 * This endpoint opts into browser traffic (allowRequestsFromUnsafeWebContent):
 * clicks arrive from real browsers (Mozilla/ UA), which Zotero's server would
 * otherwise cancel before init runs. The risk is contained: input is strictly
 * validated, the endpoint exposes no data, and the worst a malicious page can
 * do is open/focus Zotero.
 *
 * Module-level functions + plain-constructor endpoint (esbuild IIFE safety).
 */

export const OPEN_PATH = '/zotseek/open';

const KEY_RE = /^[A-Z0-9]{8}$/;
const GROUP_RE = /^group:\d+$/;

type EndpointResponse = [number, string, string];

/**
 * Build the zotero:// URI from validated query parameters.
 * Returns null when any component fails validation — nothing unvalidated
 * is ever embedded in the response HTML.
 */
export function buildZoteroUri(params: {
  target: string;
  key: string;
  library: string;
  page?: string;
}): string | null {
  const { target, key, library, page } = params;
  if (!KEY_RE.test(key)) return null;
  let prefix: string;
  if (!library || library === 'user') {
    prefix = 'library';
  } else if (GROUP_RE.test(library)) {
    prefix = `groups/${library.slice('group:'.length)}`;
  } else {
    return null;
  }
  if (target === 'select') {
    return `zotero://select/${prefix}/items/${key}`;
  }
  if (target === 'pdf') {
    const pageSuffix = page && /^\d+$/.test(page) ? `?page=${page}` : '';
    return `zotero://open-pdf/${prefix}/items/${key}${pageSuffix}`;
  }
  return null;
}

export async function handleOpenRequest(requestData: any): Promise<EndpointResponse> {
  const sp: URLSearchParams = requestData.searchParams;
  const uri = buildZoteroUri({
    target: sp.get('target') || '',
    key: (sp.get('key') || '').trim().toUpperCase(),
    library: (sp.get('library') || 'user').trim(),
    page: sp.get('page') || undefined,
  });
  if (!uri) {
    return [
      400,
      'text/plain',
      'Invalid parameters. Expected: target=select|pdf, key=<8-char item key>, ' +
        'optional library=user|group:<id>, optional page=<n> (pdf only).',
    ];
  }
  // Every component of `uri` passed strict validation above, so embedding
  // it in the markup is safe.
  const html = `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="0;url=${uri}">
<title>Opening in Zotero…</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 2em; color: #333;">
<p>Opening in Zotero…</p>
<p><a href="${uri}">Click here</a> if nothing happens (Zotero must be running).</p>
</body>
</html>`;
  return [200, 'text/html', html];
}

/**
 * Endpoint constructor for Zotero.Server.Endpoints. Unlike the other
 * ZotSeek endpoints, this one allows browser-originated requests —
 * being clicked from a browser is its entire purpose.
 */
export function ZotSeekOpenEndpoint(this: any) {}
ZotSeekOpenEndpoint.prototype = {
  supportedMethods: ['GET'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: true,
  init: handleOpenRequest,
};
