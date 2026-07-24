/**
 * HTTP client for a local OpenAI-compatible inference server (issue #42).
 *
 * One implementation covers LM Studio, Ollama, llama.cpp server and vLLM,
 * all of which expose POST /v1/embeddings and GET /v1/models on localhost.
 * Every request URL is re-validated as loopback-only (see loopback-url.ts).
 */

import { assertLoopbackUrl } from './loopback-url';

declare const Zotero: any;

// Plugin main-thread sandbox (bootstrap loadSubScript) has fetch and URL but
// lacks the AbortController DOM global. Resolve it once, borrowing from the
// main window when the bare global is missing (see CLAUDE.md pitfall).
let abortControllerCtor: any | undefined;
function getAbortControllerCtor(): any | null {
  if (abortControllerCtor !== undefined) return abortControllerCtor;
  if (typeof AbortController !== 'undefined') {
    abortControllerCtor = AbortController;
  } else {
    try {
      const win = Zotero.getMainWindow?.();
      abortControllerCtor = win?.AbortController || null;
    } catch {
      abortControllerCtor = null;
    }
  }
  return abortControllerCtor;
}

export interface ServerClientConfig {
  baseUrl: string;
  serverModelName: string;
  apiKey?: string;
}

export class ServerUnavailableError extends Error {
  code = 'SERVER_UNAVAILABLE' as const;
  constructor(public baseUrl: string, detail: string) {
    super(
      `Local inference server unreachable at ${baseUrl} (${detail}). ` +
      `Start the server or switch the embedding model in ZotSeek settings.`
    );
    this.name = 'ServerUnavailableError';
  }
}

// Backoff between retry attempts (network error, timeout or 5xx only).
const RETRY_DELAYS_MS = [2000, 5000, 15000];
const REQUEST_TIMEOUT_MS = 30000;

export class ServerEmbeddingClient {
  constructor(private cfg: ServerClientConfig) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { 'Content-Type': 'application/json' };
    if (this.cfg.apiKey) h['Authorization'] = `Bearer ${this.cfg.apiKey}`;
    return h;
  }

  /** One HTTP round-trip. Throws Error with .status for HTTP errors. */
  private async request(path: string, init: { method: string; body?: string }, timeoutMs = REQUEST_TIMEOUT_MS): Promise<any> {
    // Loopback validation at request time: the privacy gate, no override.
    const url = assertLoopbackUrl(new URL(path, this.cfg.baseUrl).href);
    const AC = getAbortControllerCtor();
    const ctrl = AC ? new AC() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), timeoutMs) : null;
    try {
      const doFetch = fetch(url.href, {
        ...init,
        headers: this.headers(),
        redirect: 'error', // a redirect off-loopback must abort, never be followed
        ...(ctrl ? { signal: ctrl.signal } : {}),
      });
      // Without AbortController the fetch itself is never cancelled, but the
      // caller still gets a timely timeout error instead of hanging forever.
      const resp = ctrl
        ? await doFetch
        : await Promise.race([
            doFetch,
            new Promise<never>((_, rej) =>
              setTimeout(() => rej(new Error(`Request timed out after ${timeoutMs}ms`)), timeoutMs)
            ),
          ]);
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        const err: any = new Error(`HTTP ${resp.status}: ${body.slice(0, 300)}`);
        err.status = resp.status;
        throw err;
      }
      return await resp.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Model ids the server offers, for the settings dropdown. */
  async listModels(): Promise<string[]> {
    const json = await this.request('/v1/models', { method: 'GET' }, 10000);
    return (Array.isArray(json?.data) ? json.data : []).map((m: any) => String(m.id));
  }

  /** Test embed; returns the embedding dimensions the server produces. */
  async probe(): Promise<number> {
    const out = await this.embed(['zotseek probe'], 0);
    return out[0]?.length || 0;
  }

  /**
   * Embed a batch of texts (caller applies task prefixes first).
   * Retries network errors, timeouts and 5xx up to `retries` times with
   * backoff; 4xx fails immediately (configuration problem, retrying won't
   * help). After retries are exhausted, throws ServerUnavailableError.
   */
  async embed(texts: string[], retries = 3): Promise<number[][]> {
    let lastErr: any;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt > 0) {
        const delay = RETRY_DELAYS_MS[Math.min(attempt - 1, RETRY_DELAYS_MS.length - 1)];
        await new Promise(r => setTimeout(r, delay));
      }
      try {
        const json = await this.request('/v1/embeddings', {
          method: 'POST',
          body: JSON.stringify({ model: this.cfg.serverModelName, input: texts }),
        });
        const data = Array.isArray(json?.data) ? [...json.data] : [];
        if (data.length !== texts.length) {
          const err: any = new Error(`server returned ${data.length} embeddings for ${texts.length} inputs`);
          err.status = 500; // treat as transient server misbehaviour
          throw err;
        }
        data.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
        return data.map((d: any) => d.embedding as number[]);
      } catch (e: any) {
        // Loopback-validation errors must propagate untouched (never
        // retried, never wrapped as "unavailable"): validation errors carry
        // code LOOPBACK_REJECTED (see loopback-url.ts).
        if (e?.code === 'LOOPBACK_REJECTED') {
          throw e;
        }
        const status = e?.status;
        if (typeof status === 'number' && status >= 400 && status < 500) {
          throw new Error(
            `Inference server rejected the request (${e.message}). ` +
            `Check the model name and server configuration.`
          );
        }
        lastErr = e; // network error, timeout or 5xx: retry
      }
    }
    throw new ServerUnavailableError(this.cfg.baseUrl, lastErr?.message || 'no response');
  }
}
