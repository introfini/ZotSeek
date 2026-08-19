/**
 * Embedding Pipeline - Generate embeddings for semantic search
 *
 * Uses ChromeWorker + Transformers.js for high quality neural embeddings.
 */

import { Logger } from '../utils/logger';
import { getActiveModel, getModel, ModelConfig, modelBasePath, setActiveModelId, applyPrefix,
  requiresLocalFiles, missingModelMessage } from './model-registry';
import { isModelOnDisk } from './model-download';
import { ServerEmbeddingClient } from './server-embedding-client';

declare const ChromeWorker: any;

export interface EmbeddingResult {
  embedding: number[];
  modelId: string;
  processingTimeMs: number;
}

export interface EmbeddingProgress {
  current: number;
  total: number;
  currentTitle: string;
  status: 'loading' | 'processing' | 'done' | 'error';
}

export type ProgressCallback = (progress: EmbeddingProgress) => void;

/**
 * Embedding Pipeline with ChromeWorker support
 */
export class EmbeddingPipeline {
  private logger: Logger;
  private model: ModelConfig = getActiveModel();
  private worker: any = null;
  private serverClient: ServerEmbeddingClient | null = null;
  private workerReady = false;
  private pendingJobs = new Map<string, { resolve: Function; reject: Function }>();
  private ready = false;
  // In-flight init() promise so N concurrent cold-start callers share a single
  // worker creation instead of each spawning (and leaking) their own. Cleared
  // on failure so a later call can retry.
  private initPromise: Promise<void> | null = null;
  // Bounded recovery attempts so a permanently-broken worker doesn't loop forever
  // within a single embed() call. Resets on every successful embed.
  private consecutiveRecoveries = 0;
  private static MAX_RECOVERIES_PER_EMBED = 2;

  // Time allowed for the worker to report ready. Covers reading the model
  // off disk and initialising the WASM runtime, both of which scale with
  // model size and disk speed.
  private static WORKER_INIT_TIMEOUT_MS = 30000;

  constructor() {
    this.logger = new Logger('EmbeddingPipeline');
  }

  /**
   * Initialize the embedding pipeline
   */
  async init(): Promise<void> {
    if (this.ready) return;
    if (this.initPromise) return this.initPromise;
    this.model = getActiveModel();

    this.initPromise = (async () => {
      if (this.model.runtime === 'server') {
        this.logger.info(`Initializing server-backed embedding pipeline (${this.model.baseUrl})`);
        await this.initServerClient();  // Will throw on failure (unreachable / dimension mismatch)
      } else {
        // Downloaded models resolve over resource://zotseek-models/. If the
        // files are absent, Transformers.js fails with its own wording naming
        // that URL, which does not tell the user a download is needed or where
        // to start one. Nothing else in the load path checks, because
        // ensureModelDownloaded() is only ever called from the preferences UI.
        if (requiresLocalFiles(this.model) && !(await isModelOnDisk(this.model))) {
          this.logger.error(`Model files missing for "${this.model.id}"; refusing to start the worker`);
          throw new Error(missingModelMessage(this.model));
        }
        this.logger.info('Initializing embedding pipeline with Transformers.js');
        await this.initWorker();  // Will throw on failure
        this.logger.info('Using Transformers.js via ChromeWorker');
      }
      this.ready = true;
    })();
    const thisAttempt = this.initPromise;
    try {
      await thisAttempt;
    } catch (e) {
      // Reset so a later call can retry; a failed init must not poison retries.
      if (this.initPromise === thisAttempt) this.initPromise = null;
      throw e;
    }
  }

  /**
   * Initialize ChromeWorker for Transformers.js
   */
  private async initWorker(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        // Get worker script path
        const workerPath = 'chrome://zotseek/content/scripts/embedding-worker.js';

        this.logger.info(`Creating ChromeWorker: ${workerPath}`);
        this.worker = new ChromeWorker(workerPath);

        const timeout = setTimeout(() => {
          // Name the model and its size: a timeout on a 570 MB model on a slow
          // disk means something different from one on a bundled model, and the
          // bare message made issue #24 impossible to triage from the report.
          reject(new Error(
            `Worker initialization timeout after ${EmbeddingPipeline.WORKER_INIT_TIMEOUT_MS / 1000}s ` +
            `loading "${this.model.label}" (${this.model.approxSizeMB} MB, ${this.model.bundled ? 'bundled' : 'downloaded'})`,
          ));
        }, EmbeddingPipeline.WORKER_INIT_TIMEOUT_MS);

        this.worker.onmessage = (event: any) => {
          const { type, status, jobId, error, embedding, modelId, processingTimeMs, message, level, data } = event.data;

          if (type === 'log') {
            // Handle log messages from worker
            const logMessage = data ? `${message} - ${JSON.stringify(data)}` : message;
            switch(level) {
              case 'error':
                this.logger.error(logMessage);
                break;
              case 'warn':
                this.logger.warn(logMessage);
                break;
              case 'info':
              default:
                this.logger.info(logMessage);
                break;
            }
          } else if (type === 'status') {
            // Only log important status updates, suppress repetitive loading progress
            if (status !== 'loading' || !message?.includes('Loading model:')) {
              this.logger.info(`Worker status: ${status} - ${message}`);
            }
            if (status === 'ready') {
              clearTimeout(timeout);
              this.workerReady = true;
              resolve();
            }
          } else if (type === 'error') {
            this.logger.error(`Worker error: ${error}`);
            if (jobId && this.pendingJobs.has(jobId)) {
              const job = this.pendingJobs.get(jobId)!;
              this.pendingJobs.delete(jobId);
              job.reject(new Error(error));
            } else {
              clearTimeout(timeout);
              reject(new Error(error));
            }
          } else if (type === 'embedding' && jobId) {
            const job = this.pendingJobs.get(jobId);
            if (job) {
              this.pendingJobs.delete(jobId);
              job.resolve({ embedding, modelId, processingTimeMs });
            }
          }
        };

        this.worker.onerror = (event: any) => {
          // Extract detailed error info from ErrorEvent
          const errorInfo = {
            message: event.message || 'Unknown error',
            filename: event.filename || 'unknown',
            lineno: event.lineno || 0,
            colno: event.colno || 0,
            error: event.error?.toString() || event.error?.message || 'No error details',
          };
          this.logger.error(`Worker error: ${errorInfo.message} at ${errorInfo.filename}:${errorInfo.lineno}:${errorInfo.colno}`);
          this.logger.error(`Error details: ${errorInfo.error}`);
          clearTimeout(timeout);

          // Mark the worker as dead so embed() will trigger recovery.
          // Reject any in-flight jobs with a recoverable error code so the
          // caller knows to retry rather than treat as permanent failure.
          this.workerReady = false;
          for (const [jobId, job] of this.pendingJobs) {
            job.reject(new Error('WORKER_DIED'));
            this.pendingJobs.delete(jobId);
          }

          reject(new Error(`Worker failed: ${errorInfo.message}`));
        };

        this.worker.postMessage({
          type: 'init',
          model: {
            modelId: this.model.id,
            hfPath: this.model.hfPath,
            pooling: this.model.pooling,
            normalize: this.model.normalize,
            queryPrefix: this.model.queryPrefix,
            docPrefix: this.model.docPrefix,
            basePath: modelBasePath(this.model),
          },
        });

      } catch (error) {
        this.logger.error('Failed to create ChromeWorker:', error);
        reject(error);
      }
    });
  }

  /**
   * Initialize the server-backed branch: build the client and probe once to
   * (a) verify the server is reachable and (b) confirm the dimensions still
   * match what this model was configured with. A mismatch means the user
   * swapped the model behind the same name: indexing under the stored
   * model_id would corrupt the vector space, so we refuse.
   */
  private async initServerClient(): Promise<void> {
    const { baseUrl, serverModelName, apiKey } = this.model;
    if (!baseUrl || !serverModelName) {
      throw new Error(`Server model '${this.model.id}' is missing its server configuration`);
    }
    const client = new ServerEmbeddingClient({ baseUrl, serverModelName, apiKey });
    const dims = await client.probe();
    if (dims !== this.model.dimensions) {
      throw new Error(
        `Server model '${serverModelName}' now returns ${dims}-dimensional embeddings, ` +
        `but this ZotSeek model was added with ${this.model.dimensions}. ` +
        `The model behind this name has changed: remove and re-add it in ZotSeek settings ` +
        `(a re-index will be required).`
      );
    }
    this.serverClient = client;
  }

  /**
   * Generate embedding for text using worker
   * @param text - Text to embed
   * @param kind - 'query' for search queries, 'doc' for documents
   */
  private async embedWithWorker(text: string, kind: 'query' | 'doc' = 'doc'): Promise<EmbeddingResult> {
    return new Promise((resolve, reject) => {
      const jobId = Math.random().toString(36).substring(2, 15);

      this.pendingJobs.set(jobId, { resolve, reject });

      this.worker.postMessage({
        type: 'embed',
        jobId,
        data: { text, kind },
      });

      // Timeout for individual embedding
      // With smaller chunks (~2000 tokens), embeddings should take ~3-10 seconds
      // First embedding may be slower due to WASM compilation
      setTimeout(() => {
        if (this.pendingJobs.has(jobId)) {
          this.pendingJobs.delete(jobId);
          reject(new Error('Embedding timeout'));
        }
      }, 60000); // 60 seconds - enough for first-run WASM compilation
    });
  }

  /**
   * Generate embedding for a single text
   * @param text - Text to embed
   * @param kind - 'query' for search queries, 'doc' for documents
   *
   * Resilient against worker death: if the ChromeWorker has crashed (sleep,
   * OOM, parent process recycled the worker process), this method silently
   * tears it down and re-initialises before retrying. Bounded by
   * MAX_RECOVERIES_PER_EMBED to prevent an infinite loop on a permanently
   * broken state.
   */
  async embed(text: string, kind: 'query' | 'doc' = 'doc'): Promise<EmbeddingResult> {
    if (!this.ready) {
      await this.init();
    }
    if (this.model.runtime === 'server') {
      if (!this.serverClient) await this.init();
      const start = Date.now();
      const prefixed = applyPrefix(text, kind, this.model);
      // Search queries fail fast (1 retry); documents get the full backoff (3).
      const retries = kind === 'query' ? 1 : 3;
      const [embedding] = await this.serverClient!.embed([prefixed], retries);
      return { embedding, modelId: this.model.id, processingTimeMs: Date.now() - start };
    }
    for (let attempt = 0; ; attempt++) {
      if (!this.ready || !this.workerReady) {
        await this.recoverWorker();
      }
      try {
        const result = await this.embedWithWorker(text, kind);
        this.consecutiveRecoveries = 0;
        return result;
      } catch (e: any) {
        const isWorkerDeath = e?.message === 'WORKER_DIED' || !this.workerReady;
        if (!isWorkerDeath) throw e;
        if (attempt >= EmbeddingPipeline.MAX_RECOVERIES_PER_EMBED) {
          throw new Error(
            `Embedding worker died and could not be recovered after ${attempt + 1} attempts`
          );
        }
        this.consecutiveRecoveries++;
        this.logger.warn(
          `Embedding worker died - attempting recovery (${this.consecutiveRecoveries} total)`
        );
        // Loop: recoverWorker() will run at the top of the next iteration.
      }
    }
  }

  /**
   * Tear down the current worker (if any) and re-initialise. Used both for
   * the first init and for recovery after a worker crash.
   */
  private async recoverWorker(): Promise<void> {
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* ignore */ }
      this.worker = null;
    }
    this.serverClient = null;
    this.workerReady = false;
    this.ready = false;
    this.initPromise = null;
    this.pendingJobs.clear();
    await this.init();
  }

  /**
   * Convenience method for embedding search queries
   * Uses the model's query prefix for better retrieval
   */
  async embedQuery(query: string): Promise<EmbeddingResult> {
    return this.embed(query, 'query');
  }

  /**
   * Convenience method for embedding documents
   * Uses the model's document prefix for better retrieval
   */
  async embedDocument(text: string): Promise<EmbeddingResult> {
    return this.embed(text, 'doc');
  }

  /** True when the active model runs on a local inference server. */
  isServerBacked(): boolean {
    return getActiveModel().runtime === 'server';
  }

  /**
   * Batched document embedding: server runtime only. This is where the
   * native Metal/CUDA speedup materializes: one HTTP request carries many
   * chunks instead of one. Prefixes are applied here; pass raw chunk text.
   */
  async embedDocuments(texts: string[]): Promise<number[][]> {
    if (!this.ready) await this.init();
    if (this.model.runtime !== 'server' || !this.serverClient) {
      throw new Error('embedDocuments is only available with a server-backed model');
    }
    const prefixed = texts.map(t => applyPrefix(t, 'doc', this.model));
    return this.serverClient.embed(prefixed);
  }

  /**
   * Check if pipeline is ready
   */
  isReady(): boolean {
    return this.ready;
  }

  /**
   * Reset pipeline to force re-initialization with new settings
   */
  reset(): void {
    this.logger.info('Resetting embedding pipeline');
    if (this.worker) {
      try { this.worker.terminate(); } catch { /* ignore */ }
      this.worker = null;
    }
    this.serverClient = null;
    this.workerReady = false;
    this.ready = false;
    this.initPromise = null;
    this.consecutiveRecoveries = 0;
    for (const [, job] of this.pendingJobs) {
      job.reject(new Error('Pipeline reset'));
    }
    this.pendingJobs.clear();
  }

  /**
   * Switch to a different embedding model, tearing down and re-initialising
   * the worker. If modelId is unknown, falls back to the active model from prefs.
   */
  async setModel(modelId: string): Promise<void> {
    const found = getModel(modelId);
    if (!found) {
      this.logger.warn(`setModel: unknown model id '${modelId}', keeping active model`);
      return;
    }
    if (found.id === this.model.id && this.ready && this.workerReady) return;
    this.logger.info(`Switching embedding model to ${found.id}`);
    // The active model is defined by the pref; init() reads it via getActiveModel().
    // Persist it here so the worker reload picks up the requested model.
    setActiveModelId(found.id);
    this.reset();
    await this.init();
  }

  /**
   * Get current model ID
   */
  getModelId(): string {
    return this.model.id;
  }

  /**
   * Get model info
   */
  getModelInfo(): { id: string; dimensions: number; description: string } {
    return {
      id: this.model.id,
      dimensions: this.model.dimensions,
      description: `${this.model.label} (${this.model.dimensions} dims)`,
    };
  }

  /**
   * Cleanup worker
   */
  destroy(): void {
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.serverClient = null;
    this.pendingJobs.clear();
  }
}

// Singleton instance
export const embeddingPipeline = new EmbeddingPipeline();
