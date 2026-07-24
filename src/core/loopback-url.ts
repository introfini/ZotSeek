/**
 * Loopback-only URL validation for the local inference server (issue #42).
 *
 * ZotSeek's privacy guarantee for server-backed embeddings is that network
 * traffic provably cannot leave this machine. Every request URL passes
 * through this gate at request time - not just at configuration time - and
 * there is deliberately no override pref. See docs/SEARCH_ARCHITECTURE.md.
 */

const ALLOWED_HOSTNAMES = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

export class LoopbackRejectedError extends Error {
  code = 'LOOPBACK_REJECTED' as const;
  constructor(message: string) {
    super(message);
    this.name = 'LoopbackRejectedError';
  }
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
  if (!ALLOWED_HOSTNAMES.has(u.hostname)) {
    throw new LoopbackRejectedError(
      `ZotSeek only talks to an inference server on this machine ` +
      `(127.0.0.1, localhost or [::1]); got '${u.hostname}'`
    );
  }
  return u;
}
