/**
 * Loopback-only URL validation for the local inference server (issue #42).
 *
 * ZotSeek's privacy guarantee for server-backed embeddings is that network
 * traffic provably cannot leave this machine. Every request URL passes
 * through this gate at request time - not just at configuration time.
 *
 * The pref `zotseek.server.allowedRemoteHosts` (comma-separated host names,
 * empty by default) adds hosts on top of loopback, e.g. a GPU machine in the
 * local network. Setting it deliberately gives up the "never leaves this
 * machine" guarantee: the text of every indexed item and every search query
 * is sent to those hosts. See docs/SEARCH_ARCHITECTURE.md.
 */

declare const Zotero: any;

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export const ALLOWED_REMOTE_HOSTS_PREF = 'zotseek.server.allowedRemoteHosts';

export class LoopbackRejectedError extends Error {
  code = 'LOOPBACK_REJECTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackRejectedError';
  }
}

/** Normalizes one host entry: lower case, no scheme, port or path. Empty if unusable. */
export function normalizeHostEntry(entry: string): string {
  let h = entry.trim().toLowerCase();
  if (!h) return '';
  if (h.includes('://')) {
    try { return new URL(h).hostname; } catch { return ''; }
  }
  h = h.split('/')[0];
  if (!h.startsWith('[')) h = h.split(':')[0];
  return /^[a-z0-9.\-\[\]:]+$/.test(h) ? h : '';
}

export function parseAllowedRemoteHosts(raw: unknown): string[] {
  if (typeof raw !== 'string') return [];
  return Array.from(new Set(raw.split(/[,\s]+/).map(normalizeHostEntry).filter(Boolean)));
}

/** Hosts the user explicitly allowed in addition to loopback. */
export function getAllowedRemoteHosts(): string[] {
  try {
    return parseAllowedRemoteHosts(Zotero?.Prefs?.get(ALLOWED_REMOTE_HOSTS_PREF, true));
  } catch {
    return [];
  }
}

export function isRemoteAllowedHost(hostname: string): boolean {
  return !ALLOWED_HOSTNAMES.has(hostname) && getAllowedRemoteHosts().includes(hostname.toLowerCase());
}

export function assertLoopbackUrl(raw: string): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new LoopbackRejectedError(`Invalid server URL: '${raw}'`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new LoopbackRejectedError(`Server URL must use http or https, got '${u.protocol}'`);
  }
  if (u.username || u.password) {
    throw new LoopbackRejectedError('Server URL must not contain embedded credentials');
  }
  if (!ALLOWED_HOSTNAMES.has(u.hostname) && !getAllowedRemoteHosts().includes(u.hostname)) {
    throw new LoopbackRejectedError(
      `ZotSeek only talks to an inference server on this machine ` +
      `(127.0.0.1, localhost or [::1]); got '${u.hostname}'. ` +
      `To use a server on another machine, add it under "Allowed remote hosts" ` +
      `(this sends your library text to that server).`
    );
  }
  return u;
}
