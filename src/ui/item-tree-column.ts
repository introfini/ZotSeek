/**
 * ZotSeek index-status column for the Zotero item tree.
 *
 * Shows per-item indexing state so users can see at a glance which papers
 * are fully indexed, partially indexed (chunk limit hit), out of date, or
 * not indexed at all. Resolves issue #30 — silent truncation of long PDFs.
 *
 * Design:
 * - Registers ONE column via Zotero.ItemTreeManager.
 * - Status is computed from an in-memory cache keyed by item_id, hydrated
 *   in batches when getCellText() is called for unknown ids.
 * - Cache is invalidated whenever indexing writes happen (see invalidate()).
 * - "Outdated" detection is cheap: compares item.dateModified to indexed_at.
 */

import { Logger } from '../utils/logger';
import { IVectorStore, ItemIndexStatus } from '../core/storage-factory';
import { identityFromItem, StableIdentity } from '../core/identity-resolver';

declare const Zotero: any;

export type IndexState =
  | 'not-indexed'
  | 'indexed'
  | 'partial'   // wasTruncated === true
  | 'outdated'  // item.dateModified > indexed_at
  | 'excluded'; // tag-based exclusion

interface CacheEntry {
  state: IndexState;
  // Raw status fields used to build the tooltip
  status: ItemIndexStatus | null;
  // Local timestamp for cache eviction
  cachedAt: number;
}

const CACHE_TTL_MS = 60 * 1000;        // Status cache stays warm for 1 minute
const BATCH_HYDRATE_SIZE = 200;        // Max ids to hit the DB with at once
const COLUMN_DATA_KEY = 'zotseek-index-status';
const EXCLUDE_TAG = 'zotseek:exclude'; // Must match hasExcludeTag() in index.ts

// Single-character status glyphs — kept ASCII-only so the column stays
// readable in all themes and is safe across Zotero versions.
const GLYPHS: Record<IndexState, string> = {
  'not-indexed': '',
  'indexed': '✓',
  'partial': '◐',
  'outdated': '↻',
  'excluded': '⊘',
};

export class ItemTreeIndexColumn {
  private logger = new Logger('IndexColumn');
  private cache = new Map<number, CacheEntry>();
  private pending = new Map<number, Promise<void>>();
  private registeredKey: string | null = null;
  private vectorStore: IVectorStore | null = null;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * Register the column with Zotero's ItemTreeManager.
   * Safe to call multiple times — only registers once.
   */
  async register(vectorStore: IVectorStore): Promise<void> {
    if (this.registeredKey) return;

    this.vectorStore = vectorStore;

    const itm = Zotero?.ItemTreeManager;
    if (!itm || typeof itm.registerColumns !== 'function') {
      this.logger.warn('Zotero.ItemTreeManager.registerColumns unavailable — column not registered');
      return;
    }

    try {
      const registered = await itm.registerColumns({
        dataKey: COLUMN_DATA_KEY,
        label: 'ZotSeek',
        pluginID: 'zotseek@zotero.org',
        dataProvider: (item: any, _dataKey: string) => this.getCellText(item),
        zoteroPersist: ['width', 'hidden', 'sortDirection'],
        // Zotero 9 expects width as a string (e.g. "40"), not a number.
        width: '40',
        staticWidth: true,
        // Show the column in the main library view by default. Users can hide
        // it through the column-header context menu if they want; persistence
        // is handled by `zoteroPersist`.
        enabledTreeIDs: ['main'],
      });

      // registerColumns returns an array of registered dataKeys (or false per
      // failed registration). Treat any truthy entry as success.
      const flat = Array.isArray(registered) ? registered : [registered];
      const success = flat.some((v: any) => v);
      this.registeredKey = success ? COLUMN_DATA_KEY : null;
      if (!success) {
        this.logger.warn(`registerColumns returned ${JSON.stringify(registered)} for ${COLUMN_DATA_KEY}`);
        return;
      }

      // First-run UX: surface the column the first time the user installs
      // this version. After that we respect their visibility preference via
      // zoteroPersist. A pref guards against re-showing the column if the
      // user has explicitly hidden it.
      try {
        const PREF_SHOWN = 'zotseek.indexStatusColumn.firstShown';
        const alreadyShown = Zotero.Prefs.get(PREF_SHOWN, true);
        if (!alreadyShown) {
          const revealed = await this.showColumnOnce();
          // Only burn the flag once we have actually flipped the column.
          // If the tree isn't ready yet, fall through so the next startup
          // can try again.
          if (revealed) Zotero.Prefs.set(PREF_SHOWN, true, true);
        }
      } catch (e: any) {
        this.logger.debug(`first-run column reveal skipped: ${e?.message || e}`);
      }
      this.logger.info(`Registered item-tree column "${COLUMN_DATA_KEY}"`);
    } catch (e: any) {
      this.logger.error(`Failed to register column: ${e?.message || e}`);
    }
  }

  /**
   * Unregister on plugin shutdown.
   */
  async unregister(): Promise<void> {
    if (!this.registeredKey) return;
    try {
      const itm = Zotero?.ItemTreeManager;
      if (itm && typeof itm.unregisterColumns === 'function') {
        await itm.unregisterColumns(this.registeredKey);
      }
    } catch (e: any) {
      this.logger.warn(`Failed to unregister column: ${e?.message || e}`);
    }
    this.registeredKey = null;
    this.cache.clear();
    this.pending.clear();
    if (this.refreshTimer) {
      clearTimeout(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  /**
   * One-shot: ask the main item tree to unhide our column. Used the very
   * first time the column is registered so users see the new indicator.
   *
   * `toggleHidden` on the virtualized table expects a numeric index into
   * its internal column array, not a dataKey — caught while debugging.
   */
  private async showColumnOnce(): Promise<boolean> {
    // Retry briefly because at startup the item tree's internal column
    // array can lag behind ItemTreeManager.registerColumns by a tick or two.
    // We poll a handful of times with short backoff before giving up; this
    // keeps the auto-show cheap when the tree is already ready and resilient
    // when it isn't.
    const MAX_TRIES = 10;
    const DELAY_MS = 300;
    for (let attempt = 0; attempt < MAX_TRIES; attempt++) {
      try {
        const win = Zotero.getMainWindow();
        const itemsView = win?.ZoteroPane?.itemsView;
        const tree = itemsView?.tree;
        const inner = tree?._columns;
        if (inner && typeof inner.getAsArray === 'function') {
          const arr = inner.getAsArray();
          const idx = arr.findIndex((c: any) => String(c.dataKey || '').includes(COLUMN_DATA_KEY));
          if (idx >= 0) {
            if (arr[idx].hidden) inner.toggleHidden(idx);
            return !inner.getAsArray()[idx].hidden;
          }
        }
      } catch (e: any) {
        this.logger.debug(`showColumnOnce attempt ${attempt}: ${e?.message || e}`);
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }
    return false;
  }

  /**
   * Drop cached status entries — call after any indexing operation.
   * The next paint will re-hydrate from the DB.
   */
  invalidate(itemIds?: number[]): void {
    if (!itemIds) {
      this.cache.clear();
      // Force the tree to repaint
      this.refreshTree();
      return;
    }
    for (const id of itemIds) this.cache.delete(id);
    this.refreshTree();
  }

  /**
   * Called synchronously by Zotero for every visible row.
   * Must return a string immediately — async hydration happens in the
   * background and the tree is refreshed when results arrive.
   */
  private getCellText(item: any): string {
    if (!item || !item.id) return '';

    // Regular items only — skip notes, attachments, annotations.
    // These types don't get indexed, so an empty cell is the honest answer.
    if (typeof item.isRegularItem === 'function' && !item.isRegularItem()) {
      return '';
    }

    const cached = this.cache.get(item.id);
    if (cached && (Date.now() - cached.cachedAt) < CACHE_TTL_MS) {
      return this.renderState(cached.state, item, cached.status);
    }

    // Not in cache — schedule a background hydration but return something now
    this.scheduleHydration(item.id);
    return cached ? this.renderState(cached.state, item, cached.status) : '';
  }

  /**
   * Background batch loader. Coalesces ids that arrive during the same
   * tick into a single DB query.
   */
  private scheduleHydration(itemId: number): void {
    if (this.pending.has(itemId)) return;

    // Mark this id as pending immediately so duplicate requests don't queue
    const placeholder = new Promise<void>((resolve) => {
      // Microtask defer — batches up everything Zotero asks for in this paint
      Promise.resolve().then(async () => {
        let hydrated = false;
        try {
          // Drain all ids that ended up pending during the same microtask
          const ids = Array.from(this.pending.keys()).slice(0, BATCH_HYDRATE_SIZE);
          if (ids.length > 0) {
            await this.hydrateBatch(ids);
            hydrated = true;
          }
        } finally {
          for (const id of this.pending.keys()) this.pending.delete(id);
          resolve();
          if (hydrated) this.refreshTree();
        }
      });
    });
    this.pending.set(itemId, placeholder);
  }

  private async hydrateBatch(ids: number[]): Promise<void> {
    if (!this.vectorStore || ids.length === 0) return;
    try {
      // Resolve items and their stable identities up front. We do the
      // identity resolution here (rather than letting the legacy id-keyed
      // shim do it inside the store) so we only walk Zotero.Items.get()
      // once per batch — meaningful on libraries with thousands of items.
      const items = ids
        .map((id) => Zotero.Items.get(id))
        .filter((it: any) => !!it);

      const identities: StableIdentity[] = items
        .map((it: any) => identityFromItem(it))
        .filter((i: StableIdentity | null): i is StableIdentity => i !== null);

      const byIdentity = identities.length > 0
        ? await this.vectorStore.getIndexStatusByIdentity(identities)
        : new Map<string, ItemIndexStatus>();

      const now = Date.now();
      // Build a per-item-id view that downstream cache lookups expect.
      const seen = new Set<number>();
      for (const item of items) {
        const identity = identityFromItem(item);
        const status = identity
          ? (byIdentity.get(`${identity.libraryKey}|${identity.itemKey}`) || null)
          : null;
        const cacheStatus = status ? { ...status, itemId: item.id } : null;
        this.cache.set(item.id, {
          status: cacheStatus,
          state: cacheStatus ? (cacheStatus.wasTruncated ? 'partial' : 'indexed') : 'not-indexed',
          cachedAt: now,
        });
        seen.add(item.id);
      }
      // Any ids we couldn't resolve (deleted/feed/etc.) still need to be
      // marked so we don't re-hydrate them every paint.
      for (const id of ids) {
        if (seen.has(id)) continue;
        this.cache.set(id, { status: null, state: 'not-indexed', cachedAt: now });
      }
    } catch (e: any) {
      this.logger.error(`hydrateBatch failed: ${e?.message || e}`);
    }
  }

  /**
   * Resolve the displayed glyph for an item, refining the cached state
   * with item-side info (exclusion tag, dateModified vs indexed_at).
   */
  private renderState(baseState: IndexState, item: any, status: ItemIndexStatus | null): string {
    // Exclusion overrides everything — the user explicitly opted this item out
    if (hasZotseekExcludeTag(item)) return GLYPHS['excluded'];

    if (baseState === 'not-indexed') return GLYPHS['not-indexed'];

    // Outdated detection — cheap string comparison on ISO timestamps
    if (status && status.indexedAt) {
      const dateModified: string | undefined = item.dateModified;
      if (dateModified && dateModified > status.indexedAt) {
        return GLYPHS['outdated'];
      }
    }

    return GLYPHS[baseState];
  }

  /**
   * Ask Zotero to repaint the item tree(s) so newly hydrated rows show
   * the right value.  Debounced to avoid scroll-jumping when many calls
   * arrive in quick succession (hydration batches, indexing checkpoints).
   *
   * Uses tree.invalidate() instead of refreshAndMaintainSelection() so
   * scroll position is preserved — fixes #34.
   */
  private refreshTree(): void {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      try {
        const win = Zotero.getMainWindow();
        const itemsView = win?.ZoteroPane?.itemsView;
        const tree = itemsView?.tree;
        if (tree && typeof tree.invalidate === 'function') {
          // Clear Zotero's internal row cache so dataProvider is re-called
          // for visible rows. Without this, invalidate() re-renders from
          // stale cached cell text. This is the same pattern Zotero uses
          // internally for preference-driven repaints.
          if (itemsView._rowCache) itemsView._rowCache = {};
          tree.invalidate();
        }
      } catch {
        // Non-critical — the next user interaction will repaint anyway.
      }
    }, 500);
  }
}

/**
 * Module-level helper (matches the pattern documented in CLAUDE.md
 * for utility functions inside the IIFE bundle).
 */
function hasZotseekExcludeTag(item: any): boolean {
  try {
    if (typeof item.getTags !== 'function') return false;
    const tags = item.getTags() as Array<{ tag: string }>;
    for (const t of tags) {
      if (t.tag === EXCLUDE_TAG) return true;
    }
  } catch {
    // ignore
  }
  return false;
}

export const itemTreeIndexColumn = new ItemTreeIndexColumn();
