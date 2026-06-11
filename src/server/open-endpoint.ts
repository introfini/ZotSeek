/**
 * HTTP launcher endpoint: GET /zotseek/open?target=select|pdf&key=...&library=...&page=...
 *
 * Many chat clients only linkify http(s) URLs, so zotero:// deep links are
 * not clickable in them — and embedded webviews additionally block the
 * protocol handoff to zotero:// even when a link IS clicked. This endpoint
 * sidesteps both problems: the request is served by the Zotero process
 * itself, so it performs the action directly via the Zotero API (select the
 * item / open the PDF at the matched page) and returns a small confirmation
 * page. No protocol handoff is involved, so it works from embedded webviews,
 * browsers, and curl alike.
 *
 * Mirrors Zotero's own zotero:// protocol handlers: select uses
 * Zotero_Tabs.select('zotero-pane') + ZoteroPane.selectItems; pdf uses
 * Zotero.FileHandlers.open(item, {location: {pageIndex: page - 1}})
 * (pageIndex is 0-based; our page param is the 1-based page number).
 *
 * This endpoint opts into browser traffic (allowRequestsFromUnsafeWebContent):
 * clicks arrive from real browsers/webviews (Mozilla/ UA), which Zotero's
 * server would otherwise cancel before init runs. The risk is contained:
 * input is strictly validated, the endpoint exposes no data, and the worst
 * a malicious page can do is open/focus Zotero. Prefetch requests are
 * detected and ignored so link previews don't trigger spurious opens.
 *
 * Module-level functions + plain-constructor endpoint (esbuild IIFE safety).
 */

declare const Zotero: any;

export const OPEN_PATH = '/zotseek/open';

const KEY_RE = /^[A-Z0-9]{8}$/;
const GROUP_RE = /^group:\d+$/;

type EndpointResponse = [number, string, string];

interface OpenParams {
  target: 'select' | 'pdf';
  key: string;
  library: string; // 'user' | 'group:<id>'
  page?: number;
}

/** Parse and strictly validate query params; null when anything is off. */
export function parseOpenParams(sp: URLSearchParams): OpenParams | null {
  const target = sp.get('target') || '';
  const key = (sp.get('key') || '').trim().toUpperCase();
  const library = (sp.get('library') || 'user').trim();
  const pageRaw = sp.get('page');
  if (target !== 'select' && target !== 'pdf') return null;
  if (!KEY_RE.test(key)) return null;
  if (library !== 'user' && !GROUP_RE.test(library)) return null;
  let page: number | undefined;
  if (pageRaw != null && pageRaw !== '') {
    if (!/^\d+$/.test(pageRaw)) return null;
    page = parseInt(pageRaw, 10);
    if (page < 1) return null;
  }
  return { target, key, library, page };
}

/** zotero:// URI for the manual-fallback link shown on the result page. */
export function buildZoteroUri(params: OpenParams): string {
  const prefix =
    params.library === 'user'
      ? 'library'
      : `groups/${params.library.slice('group:'.length)}`;
  if (params.target === 'select') {
    return `zotero://select/${prefix}/items/${params.key}`;
  }
  return (
    `zotero://open-pdf/${prefix}/items/${params.key}` +
    (params.page ? `?page=${params.page}` : '')
  );
}

function isPrefetch(headers: any): boolean {
  const h = headers || {};
  const purpose = String(h['sec-purpose'] || h['purpose'] || h['x-moz'] || '').toLowerCase();
  return purpose.includes('prefetch') || purpose.includes('prerender');
}

function activateZotero(win: any): void {
  try {
    if (Zotero.Utilities?.Internal?.activate) {
      Zotero.Utilities.Internal.activate(win);
    } else {
      win?.focus?.();
    }
  } catch {
    try { win?.focus?.(); } catch { /* ignore */ }
  }
}

/**
 * Perform the open action inside Zotero. Returns an error string on
 * failure, null on success.
 */
async function performOpenAction(params: OpenParams): Promise<string | null> {
  const libraryId =
    params.library === 'user'
      ? Zotero.Libraries.userLibraryID
      : Zotero.Groups.getLibraryIDFromGroupID(Number(params.library.slice('group:'.length)));
  if (!libraryId && libraryId !== 0) {
    return `Library "${params.library}" was not found in this Zotero.`;
  }
  const itemID = Zotero.Items.getIDFromLibraryAndKey(libraryId, params.key);
  if (!itemID) {
    return `Item ${params.key} was not found in this Zotero library.`;
  }
  const win = Zotero.getMainWindow?.();
  if (params.target === 'select') {
    const zp = Zotero.getActiveZoteroPane?.() || win?.ZoteroPane;
    if (!zp) return 'No Zotero window is open.';
    try { win?.Zotero_Tabs?.select?.('zotero-pane'); } catch { /* ignore */ }
    await zp.selectItems([itemID]);
  } else {
    const item = Zotero.Items.get(itemID);
    const location = params.page ? { pageIndex: params.page - 1 } : undefined;
    await Zotero.FileHandlers.open(item, { location });
  }
  if (win) activateZotero(win);
  return null;
}

function resultPage(title: string, detail: string, fallbackUri?: string): string {
  const fallback = fallbackUri
    ? `<p style="color: #666;">If Zotero did not come to the front, try the direct link: <a href="${fallbackUri}">${fallbackUri}</a></p>`
    : '';
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>${title}</title>
</head>
<body style="font-family: system-ui, sans-serif; margin: 2em; color: #333;">
<p><strong>${title}</strong></p>
<p>${detail}</p>
${fallback}
</body>
</html>`;
}

export async function handleOpenRequest(requestData: any): Promise<EndpointResponse> {
  const params = parseOpenParams(requestData.searchParams);
  if (!params) {
    return [
      400,
      'text/plain',
      'Invalid parameters. Expected: target=select|pdf, key=<8-char item key>, ' +
        'optional library=user|group:<id>, optional page=<n> (pdf only).',
    ];
  }
  // Link-preview prefetchers must not trigger the action; the real click
  // that follows will (a 204 is not cached as a page).
  if (isPrefetch(requestData.headers)) {
    return [204, 'text/plain', ''];
  }
  // Every embedded value below passed strict validation in parseOpenParams.
  const uri = buildZoteroUri(params);
  let error: string | null;
  try {
    error = await performOpenAction(params);
  } catch (e: any) {
    error = e?.message || String(e);
  }
  if (error) {
    return [404, 'text/html', resultPage('Could not open in Zotero', error, uri)];
  }
  const detail =
    params.target === 'select'
      ? `Item ${params.key} is now selected in Zotero. You can close this tab.`
      : `The PDF is now open in Zotero${params.page ? ` at page ${params.page}` : ''}. You can close this tab.`;
  return [200, 'text/html', resultPage('Opened in Zotero ✓', detail, uri)];
}

/**
 * Endpoint constructor for Zotero.Server.Endpoints. Unlike the other
 * ZotSeek endpoints, this one allows browser-originated requests —
 * being clicked from a browser or embedded webview is its entire purpose.
 */
export function ZotSeekOpenEndpoint(this: any) {}
ZotSeekOpenEndpoint.prototype = {
  supportedMethods: ['GET'],
  supportedDataTypes: ['application/json'],
  permitBookmarklet: false,
  allowRequestsFromUnsafeWebContent: true,
  init: handleOpenRequest,
};
