/**
 * FIFO queue for bulk indexing jobs.
 *
 * A user action that arrives while indexing is already running is parked here
 * and started once the current run finishes. Kept free of Zotero globals so the
 * ordering, de-duplication and failure rules can be unit-tested.
 */

export interface IndexingJob {
  /** Identity used to refuse a second copy of the same work while one is queued. */
  key: string;
  /** Human-readable description, shown in notifications. */
  label: string;
  run: () => Promise<void>;
}

export interface IndexingQueueOptions {
  /** True while indexing that is not managed by this queue is running. */
  isExternallyBusy?: () => boolean;
  logger?: { error: (message: string) => void };
}

export class IndexingQueue {
  private jobs: IndexingJob[] = [];
  private running = false;
  private currentJobKey: string | null = null;

  constructor(private readonly options: IndexingQueueOptions = {}) {}

  get isRunning(): boolean {
    return this.running;
  }

  get length(): number {
    return this.jobs.length;
  }

  /** Key of the job currently executing, or null. */
  get currentKey(): string | null {
    return this.currentJobKey;
  }

  has(key: string): boolean {
    return this.jobs.some(job => job.key === key);
  }

  /** Append a job. Returns false when a job with the same key is already waiting. */
  enqueue(job: IndexingJob): boolean {
    if (this.has(job.key)) return false;
    this.jobs.push(job);
    return true;
  }

  /** Discard every waiting job. The running job, if any, is not affected. Returns how many were dropped. */
  clear(): number {
    const dropped = this.jobs.length;
    this.jobs = [];
    return dropped;
  }

  labels(): string[] {
    return this.jobs.map(job => job.label);
  }

  /**
   * Queue an optional job at the tail, then start draining. Used for immediate
   * runs: when nothing is busy the queue is empty, so the job runs straight away.
   */
  runOrDrain(job?: IndexingJob): Promise<void> {
    if (job) this.enqueue(job);
    return this.drain();
  }

  /**
   * Run waiting jobs one after another until the queue is empty or another
   * indexing run becomes active. Calling it while already draining does nothing;
   * the running loop picks up anything added in the meantime.
   */
  async drain(): Promise<void> {
    if (this.running) return;
    if (this.isBusyExternally()) return;

    this.running = true;
    try {
      while (this.jobs.length > 0 && !this.isBusyExternally()) {
        const job = this.jobs.shift()!;
        this.currentJobKey = job.key;
        try {
          await job.run();
        } catch (error: any) {
          this.options.logger?.error(
            `Queued indexing job "${job.label}" failed: ${error?.message || error}`
          );
        } finally {
          this.currentJobKey = null;
        }
      }
    } finally {
      this.running = false;
    }
  }

  private isBusyExternally(): boolean {
    return this.options.isExternallyBusy?.() ?? false;
  }
}
