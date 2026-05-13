/**
 * Auto-Index Manager
 *
 * Monitors Zotero for newly added items and automatically queues them
 * for indexing. Uses Zotero's Notifier API to detect changes.
 *
 * Features:
 * - Listens for item 'add' events
 * - Handles PDF not ready yet (retry with exponential backoff)
 * - Batches items to avoid overwhelming the system during bulk imports
 * - Respects user's autoIndex preference
 */

import { Logger } from '../utils/logger';
import { identityFromItem } from './identity-resolver';

declare const Zotero: any;

// Callback type for when items are ready to be indexed
type IndexCallback = (items: any[]) => Promise<void>;

export class AutoIndexManager {
  private static instance: AutoIndexManager | null = null;

  private logger: Logger;
  private notifierID: string | null = null;
  private running: boolean = false;

  // Queue of items waiting to be indexed
  private pendingItems: Set<number> = new Set();

  // Items waiting for PDF attachment to be ready
  private waitingForPDF: Map<number, { attempts: number; timer: any }> = new Map();

  // Batch processing
  private batchTimer: any = null;
  // Callback to trigger indexing
  private indexCallback: IndexCallback | null = null;

  // Reference to vector store for checking if already indexed
  private vectorStore: any = null;

  private constructor() {
    this.logger = new Logger('AutoIndexManager');
  }

  /**
   * Get singleton instance
   */
  public static getInstance(): AutoIndexManager {
    if (!AutoIndexManager.instance) {
      AutoIndexManager.instance = new AutoIndexManager();
    }
    return AutoIndexManager.instance;
  }

  /**
   * Set the callback to trigger indexing
   */
  public setIndexCallback(callback: IndexCallback): void {
    this.indexCallback = callback;
  }

  /**
   * Set the vector store reference for checking indexed status
   */
  public setVectorStore(store: any): void {
    this.vectorStore = store;
  }

  /**
   * Check if auto-indexing is enabled in preferences
   */
  private isEnabled(): boolean {
    try {
      const value = Zotero.Prefs.get('zotseek.autoIndex', true);
      return value === true;
    } catch (e) {
      this.logger.error(`Error reading autoIndex pref: ${e}`);
      return false;
    }
  }

  /**
   * Start monitoring for new items
   */
  public start(): void {
    if (this.running) {
      return;
    }

    if (!this.isEnabled()) {
      return;
    }

    // Register Zotero notifier observer
    this.notifierID = Zotero.Notifier.registerObserver(
      {
        notify: async (
          event: string,
          type: string,
          ids: Array<string | number>,
          extraData: any
        ) => {
          await this.handleNotify(event, type, ids, extraData);
        }
      },
      ['item'],
      'zotseek-auto-index'
    );

    this.running = true;
    this.logger.info('Auto-index monitoring started');
  }

  /**
   * Stop monitoring
   */
  public stop(): void {
    if (!this.running) {
      return;
    }

    // Unregister notifier
    if (this.notifierID) {
      Zotero.Notifier.unregisterObserver(this.notifierID);
      this.notifierID = null;
    }

    // Clear batch timer
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }

    // Clear waiting timers
    for (const [itemId, data] of this.waitingForPDF) {
      if (data.timer) {
        clearTimeout(data.timer);
      }
    }
    this.waitingForPDF.clear();
    this.pendingItems.clear();

    this.running = false;
    this.logger.info('Auto-index monitoring stopped');
  }

  /**
   * Reload configuration (call when preferences change)
   */
  public reload(): void {
    const enabled = this.isEnabled();

    if (enabled && !this.running) {
      this.start();
    } else if (!enabled && this.running) {
      this.stop();
    }
  }

  /**
   * Handle Zotero notifier events
   */
  private async handleNotify(
    event: string,
    type: string,
    ids: Array<string | number>,
    _extraData: any
  ): Promise<void> {
    // Only handle item events
    if (type !== 'item' || event !== 'add') {
      return;
    }

    // Re-check if still enabled (user might have changed preference)
    if (!this.isEnabled()) {
      this.stop();
      return;
    }

    try {
      for (const rawId of ids) {
        const itemId = rawId as number;
        const item = await Zotero.Items.getAsync(itemId);
        if (!item) continue;

        // Handle new top-level items (not attachments/notes)
        if (this.shouldProcess(item)) {
          this.logger.info(`New item detected: ${item.getField('title')}`);
          // Small delay to let attachments arrive
          await this.delay(2000);
          await this.enqueueIfReady(item);
          continue;
        }

        // Handle new attachment - check if parent is waiting for PDF
        if (item.isAttachment && item.isAttachment()) {
          const parentID = item.parentID as number | undefined;
          if (parentID && this.waitingForPDF.has(parentID)) {
            const parent = await Zotero.Items.getAsync(parentID);
            if (parent) {
              await this.enqueueIfReady(parent);
            }
          }
        }
      }
    } catch (error: any) {
      this.logger.error(`Error handling notification: ${error?.message || error}`);
    }
  }

  /**
   * Check if an item should be processed for auto-indexing
   */
  private shouldProcess(item: any): boolean {
    // Only process regular items (not notes, attachments, etc.)
    if (item.isNote() || item.isAttachment()) {
      return false;
    }

    // Must be top-level item
    if (item.parentID) {
      return false;
    }

    // Must have a title
    const title = item.getField('title') as string;
    if (!title || title.trim() === '') {
      return false;
    }

    // Exclude books if preference is set
    try {
      const excludeBooks = Zotero.Prefs.get('zotseek.excludeBooks', true);
      if (excludeBooks && item.itemType === 'book') {
        return false;
      }
    } catch {
      // Ignore preference errors
    }

    // Exclude items with exclusion tag
    try {
      const excludeTag = Zotero.Prefs.get('zotseek.excludeTag', true);
      if (excludeTag && item.getTags?.()?.some((t: any) => t.tag === excludeTag)) {
        return false;
      }
    } catch {
      // Ignore tag check errors
    }

    return true;
  }

  /**
   * Check if item has a usable PDF attachment
   */
  private async hasPDFAttachment(item: any): Promise<boolean> {
    try {
      const attachmentIDs: number[] = item.getAttachments?.() || [];
      for (const attId of attachmentIDs) {
        const att = await Zotero.Items.getAsync(attId);
        if (!att || !att.isAttachment()) continue;

        const mime = att.attachmentMIMEType || '';
        if (mime === 'application/pdf') {
          // Check if file exists
          const file = await att.getFile?.();
          if (file) {
            return true;
          }
        }

        // Fallback to extension check
        const path = att.getFilePath?.() || '';
        if (path && /\.pdf$/i.test(path)) {
          return true;
        }
      }
    } catch (error) {
      this.logger.debug(`Error checking PDF: ${error}`);
    }
    return false;
  }

  /**
   * Check if item is already indexed
   */
  private async isAlreadyIndexedItem(item: any): Promise<boolean> {
    if (!this.vectorStore) {
      return false;
    }

    // Check if store is ready
    if (!this.vectorStore.isReady || !this.vectorStore.isReady()) {
      return false;
    }

    try {
      const identity = identityFromItem(item);
      if (!identity) return false;
      return await this.vectorStore.isIndexedByIdentity(identity.libraryKey, identity.itemKey);
    } catch (e: any) {
      this.logger.error(`isAlreadyIndexedItem(${item?.id}): ${e?.message || e}`);
      return false;
    }
  }

  /**
   * Enqueue item if it's ready (has PDF and not already indexed)
   */
  private async enqueueIfReady(item: any): Promise<void> {
    const itemId = item.id;

    // Already in queue
    if (this.pendingItems.has(itemId)) {
      return;
    }

    // Already indexed
    if (await this.isAlreadyIndexedItem(item)) {
      this.clearWaitingState(itemId);
      return;
    }

    // Check for PDF attachment
    if (await this.hasPDFAttachment(item)) {
      // Ready to index
      this.clearWaitingState(itemId);
      this.pendingItems.add(itemId);
      this.logger.info(`Queued for auto-indexing: ${item.getField('title')}`);
      this.scheduleBatch();
      return;
    }

    // No PDF yet - schedule retry with exponential backoff
    const waitData = this.waitingForPDF.get(itemId) || { attempts: 0, timer: null };

    if (waitData.attempts >= 5) {
      // Give up after 5 attempts (no PDF available)
      this.clearWaitingState(itemId);
      return;
    }

    // Schedule retry (2s, 4s, 8s, 16s, 30s)
    const delayMs = Math.min(30000, 2000 * Math.pow(2, waitData.attempts));

    if (waitData.timer) {
      clearTimeout(waitData.timer);
    }

    waitData.attempts++;
    waitData.timer = setTimeout(async () => {
      try {
        const latestItem = await Zotero.Items.getAsync(itemId);
        if (latestItem) {
          await this.enqueueIfReady(latestItem);
        }
      } catch {
        // Ignore retry errors
      }
    }, delayMs);

    this.waitingForPDF.set(itemId, waitData);
  }

  /**
   * Clear waiting state for an item
   */
  private clearWaitingState(itemId: number): void {
    const waitData = this.waitingForPDF.get(itemId);
    if (waitData?.timer) {
      clearTimeout(waitData.timer);
    }
    this.waitingForPDF.delete(itemId);
  }

  /**
   * Schedule batch processing (debounced)
   * Resets timer on each call so indexing only fires
   * after items stop arriving for the configured delay.
   */
  private scheduleBatch(): void {
    // Reset timer on each new item (proper debounce)
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
    }

    // Read delay from preference at schedule time (dynamic)
    const delaySec = Math.max(1, Zotero.Prefs.get('zotseek.autoIndexDelay', true) ?? 10);

    this.batchTimer = setTimeout(() => {
      this.processBatch();
    }, delaySec * 1000);
  }

  /**
   * Process the queued batch of items
   */
  private async processBatch(): Promise<void> {
    this.batchTimer = null;

    if (this.pendingItems.size === 0 || !this.indexCallback) {
      return;
    }

    // Get all pending items
    const itemIds = Array.from(this.pendingItems);
    this.pendingItems.clear();

    try {
      // Get Zotero items
      const items = await Zotero.Items.getAsync(itemIds);
      const validItems = items.filter((item: any) => item && !item.isNote() && !item.isAttachment());

      if (validItems.length > 0) {
        // Trigger indexing via callback
        await this.indexCallback(validItems);
        this.logger.info(`Auto-indexed ${validItems.length} item(s)`);
      }
    } catch (error: any) {
      this.logger.error(`Auto-indexing failed: ${error?.message || error}`);
    }
  }

  /**
   * Get current queue status
   */
  public getStatus(): { running: boolean; pending: number; waiting: number } {
    return {
      running: this.running,
      pending: this.pendingItems.size,
      waiting: this.waitingForPDF.size
    };
  }

  /**
   * Utility: delay helper
   */
  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Export singleton getter
export const autoIndexManager = AutoIndexManager.getInstance();
