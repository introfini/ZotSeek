/**
 * Registers/unregisters ZotSeek's local HTTP endpoints (MCP + REST) on
 * Zotero.Server, gated by the opt-in pref `zotseek.mcpServer.enabled`
 * (default false). A pref observer toggles registration live, so changing
 * the checkbox in preferences needs no restart.
 *
 * Module-level functions (pitfall #6); uses the Zotero global directly.
 */
import { Logger } from '../utils/logger';
import { ZotSeekMCPEndpoint, MCP_PATH } from './mcp-endpoint';
import {
  ZotSeekSearchEndpoint,
  ZotSeekSimilarEndpoint,
  ZotSeekStatsEndpoint,
  REST_PATHS,
} from './rest-endpoints';
import { ZotSeekOpenEndpoint, OPEN_PATH } from './open-endpoint';

declare const Zotero: any;

const logger = new Logger('ZotSeekServer');

export const MCP_SERVER_PREF = 'zotseek.mcpServer.enabled';

let registered = false;
let observerSymbol: symbol | null = null;

const ALL_PATHS = [MCP_PATH, REST_PATHS.search, REST_PATHS.similar, REST_PATHS.stats, OPEN_PATH];

export function registerEndpoints(): void {
  if (registered) return;
  if (!Zotero.Server?.Endpoints) {
    logger.warn('Zotero.Server.Endpoints not available; cannot register');
    return;
  }
  Zotero.Server.Endpoints[MCP_PATH] = ZotSeekMCPEndpoint;
  Zotero.Server.Endpoints[REST_PATHS.search] = ZotSeekSearchEndpoint;
  Zotero.Server.Endpoints[REST_PATHS.similar] = ZotSeekSimilarEndpoint;
  Zotero.Server.Endpoints[REST_PATHS.stats] = ZotSeekStatsEndpoint;
  Zotero.Server.Endpoints[OPEN_PATH] = ZotSeekOpenEndpoint;
  registered = true;
  const port = Zotero.Server?.port;
  if (port) {
    logger.info(`Local endpoints registered on http://127.0.0.1:${port} (MCP: ${MCP_PATH})`);
  } else {
    logger.warn(
      'Endpoints registered, but Zotero HTTP server is not running. ' +
      'Enable "Allow other applications on this computer to communicate ' +
      'with Zotero" in Zotero Settings > Advanced.'
    );
  }
}

export function unregisterEndpoints(): void {
  if (!registered) return;
  for (const path of ALL_PATHS) {
    try {
      delete Zotero.Server.Endpoints[path];
    } catch {
      // ignore — endpoint may already be gone
    }
  }
  registered = false;
  logger.info('Local endpoints unregistered');
}

export function isRegistered(): boolean {
  return registered;
}

export function initServerManager(): void {
  try {
    if (Zotero.Prefs.get(MCP_SERVER_PREF, true) === true) {
      registerEndpoints();
    }
    observerSymbol = Zotero.Prefs.registerObserver(
      MCP_SERVER_PREF,
      (value: any) => {
        if (value === true) {
          registerEndpoints();
        } else {
          unregisterEndpoints();
        }
      },
      true
    );
  } catch (e: any) {
    logger.warn(`Server manager init failed: ${e?.message || e}`);
  }
}

export function shutdownServerManager(): void {
  try {
    if (observerSymbol) {
      Zotero.Prefs.unregisterObserver(observerSymbol);
      observerSymbol = null;
    }
  } catch {
    // ignore
  }
  unregisterEndpoints();
}
