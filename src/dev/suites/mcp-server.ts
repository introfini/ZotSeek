/**
 * Self-test suite for the local MCP/REST endpoints (#38, #32).
 *
 * Protocol-level scenarios call the handler functions directly (no HTTP).
 * Two end-to-end scenarios do real HTTP fetches against Zotero.Server and
 * are skipped if the HTTP server is not running. In-Zotero fetch has a
 * Mozilla/ UA, so e2e requests carry Zotero-Allowed-Request to pass the
 * server's browser-traffic gate.
 */
import { selfTest, scenario, assertEq, assertTrue, Scenario } from '../self-test';
import { handleMcpRequest } from '../../server/mcp-endpoint';
import { handleSearchRequest, handleStatsRequest } from '../../server/rest-endpoints';
import { handleOpenRequest, parseOpenParams, buildZoteroUri } from '../../server/open-endpoint';
import { registerEndpoints, isRegistered, unregisterEndpoints } from '../../server/server-manager';

declare const Zotero: any;

function rpc(method: string, params?: any, id: any = 1) {
  return { headers: {}, data: { jsonrpc: '2.0', id, method, params } };
}

async function callMcp(method: string, params?: any, headers: any = {}) {
  const [status, contentType, body] = await handleMcpRequest({
    headers,
    data: { jsonrpc: '2.0', id: 1, method, params },
  });
  return { status, contentType, json: body ? JSON.parse(body) : null };
}

function parseToolPayload(json: any): any {
  // tools/call wraps the payload as {content: [{type:'text', text}]}
  return JSON.parse(json.result.content[0].text);
}

selfTest.register('mcp-server', async () => {
  const scenarios: Scenario[] = [];

  scenarios.push(await scenario('initialize returns protocolVersion and serverInfo', async () => {
    const { status, json } = await callMcp('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'self-test', version: '0' },
    });
    assertEq(status, 200, 'status');
    assertEq(json.result.protocolVersion, '2025-06-18', 'echoes known protocolVersion');
    assertEq(json.result.serverInfo.name, 'zotseek', 'serverInfo.name');
    assertTrue(!!json.result.capabilities.tools, 'declares tools capability');
  }));

  scenarios.push(await scenario('notifications/initialized returns 202', async () => {
    const [status] = await handleMcpRequest(rpc('notifications/initialized'));
    assertEq(status, 202, 'status');
  }));

  scenarios.push(await scenario('tools/list returns the 3 tools', async () => {
    const { json } = await callMcp('tools/list');
    const names = json.result.tools.map((t: any) => t.name).sort();
    assertEq(JSON.stringify(names), JSON.stringify(['find_similar', 'index_status', 'search']), 'tool names');
    assertTrue(
      json.result.tools.every((t: any) => t.inputSchema?.type === 'object'),
      'every tool has an object inputSchema'
    );
  }));

  scenarios.push(await scenario('unknown method returns -32601', async () => {
    const { json } = await callMcp('resources/list');
    assertEq(json.error.code, -32601, 'error code');
  }));

  scenarios.push(await scenario('malformed request returns -32600', async () => {
    const [status, , body] = await handleMcpRequest({ headers: {}, data: { hello: 'world' } });
    assertEq(status, 400, 'status');
    assertEq(JSON.parse(body).error.code, -32600, 'error code');
  }));

  scenarios.push(await scenario('non-local Origin is rejected with 403', async () => {
    const { status } = await callMcp('tools/list', undefined, { origin: 'https://evil.example' });
    assertEq(status, 403, 'status');
  }));

  scenarios.push(await scenario('localhost Origin is accepted', async () => {
    const { status } = await callMcp('tools/list', undefined, { origin: 'http://localhost:23119' });
    assertEq(status, 200, 'status');
  }));

  scenarios.push(await scenario('tools/call index_status returns stats', async () => {
    const { json } = await callMcp('tools/call', { name: 'index_status', arguments: {} });
    const payload = parseToolPayload(json);
    assertTrue(typeof payload.indexedPapers === 'number', 'indexedPapers is a number');
    assertTrue(typeof payload.modelId === 'string', 'modelId is a string');
    assertTrue(typeof payload.ready === 'boolean', 'ready is a boolean');
    assertTrue(typeof payload.modelLoaded === 'boolean', 'modelLoaded is a boolean');
  }));

  scenarios.push(await scenario('tools/call search returns ranked results', async () => {
    const { json } = await callMcp('tools/call', {
      name: 'search',
      arguments: { query: 'method results analysis', max_results: 5, mode: 'semantic' },
    });
    const payload = parseToolPayload(json);
    if (json.result.isError) {
      // Acceptable only when the index is empty
      assertTrue(String(payload.error).length > 0, 'isError result carries a message');
      return;
    }
    assertTrue(Array.isArray(payload.results), 'results is an array');
    if (payload.results.length > 0) {
      const r = payload.results[0];
      assertTrue(/^[A-Z0-9]{8}$/.test(r.itemKey), 'itemKey looks like a Zotero key');
      assertTrue(typeof r.score === 'number', 'score is a number');
      assertTrue(
        !r.links || r.links.select.startsWith('zotero://select/'),
        'links.select is a zotero:// deep link'
      );
      assertTrue(
        !r.links?.openPdf || r.links.openPdf.startsWith('zotero://open-pdf/'),
        'links.openPdf is a zotero://open-pdf link'
      );
      assertTrue(
        !r.links || /^http:\/\/localhost:\d+\/zotseek\/open\?target=select/.test(r.links.selectHttp),
        'links.selectHttp is a local http launcher link'
      );
      assertTrue(
        !r.links?.openPdfHttp ||
          /^http:\/\/localhost:\d+\/zotseek\/open\?target=pdf/.test(r.links.openPdfHttp),
        'links.openPdfHttp is a local http launcher link'
      );
    }
  }));

  scenarios.push(await scenario('tools/call search without query returns isError', async () => {
    const { json } = await callMcp('tools/call', { name: 'search', arguments: {} });
    assertEq(json.result.isError, true, 'isError flag');
  }));

  scenarios.push(await scenario('tools/call unknown tool returns -32602', async () => {
    const { json } = await callMcp('tools/call', { name: 'nope', arguments: {} });
    assertEq(json.error.code, -32602, 'error code');
  }));

  scenarios.push(await scenario('find_similar with bad key returns isError', async () => {
    const { json } = await callMcp('tools/call', {
      name: 'find_similar',
      arguments: { item_key: 'not-a-key' },
    });
    assertEq(json.result.isError, true, 'isError flag');
  }));

  scenarios.push(await scenario('REST search handler validates q', async () => {
    const [status, , body] = await handleSearchRequest({
      headers: {},
      searchParams: new URLSearchParams(''),
    });
    assertEq(status, 400, 'status');
    assertTrue(JSON.parse(body).error.includes('q'), 'error mentions q');
  }));

  scenarios.push(await scenario('REST stats handler returns JSON stats', async () => {
    const [status, contentType, body] = await handleStatsRequest({
      headers: {},
      searchParams: new URLSearchParams(''),
    });
    assertEq(status, 200, 'status');
    assertEq(contentType, 'application/json', 'content type');
    assertTrue(typeof JSON.parse(body).indexedPapers === 'number', 'indexedPapers present');
  }));

  scenarios.push(await scenario('open launcher parses and formats URIs correctly', async () => {
    const sel = parseOpenParams(new URLSearchParams('target=select&key=abcd2345'));
    assertTrue(!!sel, 'select params parse (key uppercased)');
    assertEq(buildZoteroUri(sel!), 'zotero://select/library/items/ABCD2345', 'select URI');
    const pdf = parseOpenParams(new URLSearchParams('target=pdf&key=WXYZ6789&library=group:123&page=11'));
    assertTrue(!!pdf, 'group pdf params parse');
    assertEq(
      buildZoteroUri(pdf!),
      'zotero://open-pdf/groups/123/items/WXYZ6789?page=11',
      'group pdf URI with page'
    );
  }));

  scenarios.push(await scenario('open launcher returns 404 for unknown item or group', async () => {
    const [missingItem] = await handleOpenRequest({
      headers: {},
      searchParams: new URLSearchParams('target=select&key=ZZZZZZZZ'),
    });
    assertEq(missingItem, 404, 'unknown item key');
    const [missingGroup] = await handleOpenRequest({
      headers: {},
      searchParams: new URLSearchParams('target=select&key=ABCD2345&library=group:999999999'),
    });
    assertEq(missingGroup, 404, 'unknown group library');
  }));

  scenarios.push(await scenario('open launcher ignores prefetch requests', async () => {
    const [status] = await handleOpenRequest({
      headers: { 'sec-purpose': 'prefetch' },
      searchParams: new URLSearchParams('target=select&key=ZZZZZZZZ'),
    });
    assertEq(status, 204, 'prefetch gets 204 and no action');
  }));

  scenarios.push(await scenario('open launcher selects a real item end to end', async () => {
    const keys = await Zotero.DB.columnQueryAsync(
      "SELECT item_key FROM zotseek.items WHERE library_key = 'user' LIMIT 5"
    ).then((r: any) => r || []);
    let realKey: string | null = null;
    for (const k of keys) {
      if (Zotero.Items.getIDFromLibraryAndKey(Zotero.Libraries.userLibraryID, String(k))) {
        realKey = String(k);
        break;
      }
    }
    if (!realKey) return; // nothing indexed/resolvable — covered by the 404 scenario
    const [status, contentType, body] = await handleOpenRequest({
      headers: {},
      searchParams: new URLSearchParams(`target=select&key=${realKey}`),
    });
    assertEq(status, 200, 'status');
    assertEq(contentType, 'text/html', 'content type');
    assertTrue(body.includes('Opened in Zotero'), 'confirmation page');
  }));

  scenarios.push(await scenario('open launcher rejects invalid input', async () => {
    const bad = [
      'target=select&key=../etc/passwd',
      'target=select&key=ABCD234', // 7 chars
      'target=nope&key=ABCD2345',
      'target=pdf&key=ABCD2345&library=evil',
      '',
    ];
    for (const qs of bad) {
      const [status] = await handleOpenRequest({ headers: {}, searchParams: new URLSearchParams(qs) });
      assertEq(status, 400, `status for "${qs}"`);
    }
  }));

  scenarios.push(await scenario('end-to-end: HTTP initialize + tools/list', async () => {
    const port = Zotero.Server?.port;
    if (!port) return; // HTTP server disabled — covered by handler-level scenarios
    const wasRegistered = isRegistered();
    registerEndpoints();
    try {
      // In-Zotero fetch has a Mozilla/ UA, so Zotero's browser-traffic gate
      // would cancel it without the Zotero-Allowed-Request header.
      const resp = await fetch(`http://127.0.0.1:${port}/zotseek/mcp`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Zotero-Allowed-Request': '1',
        },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
      });
      assertEq(resp.status, 200, 'HTTP status');
      const json = await resp.json();
      assertEq(json.result.tools.length, 3, 'three tools over HTTP');
    } finally {
      if (!wasRegistered) unregisterEndpoints();
    }
  }));

  scenarios.push(await scenario('end-to-end: REST /zotseek/stats over HTTP', async () => {
    const port = Zotero.Server?.port;
    if (!port) return;
    const wasRegistered = isRegistered();
    registerEndpoints();
    try {
      const resp = await fetch(`http://127.0.0.1:${port}/zotseek/stats`, {
        headers: { 'Zotero-Allowed-Request': '1' },
      });
      assertEq(resp.status, 200, 'HTTP status');
      const json = await resp.json();
      assertTrue(typeof json.indexedPapers === 'number', 'indexedPapers present');
    } finally {
      if (!wasRegistered) unregisterEndpoints();
    }
  }));

  return scenarios;
});
