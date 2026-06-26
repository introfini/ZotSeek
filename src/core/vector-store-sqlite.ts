/**
 * Vector Store - SQLite-based storage for paper embeddings
 *
 * Uses a separate SQLite database file (zotseek.sqlite) that is attached
 * to Zotero's database connection. This approach (inspired by Better BibTeX):
 * - Keeps Zotero's main database clean and unbloated
 * - Allows easy cleanup on uninstall (just delete the file)
 * - Uses Zotero.DB API through ATTACH DATABASE
 * - Provides complete data isolation
 *
 * Much faster than JSON file for:
 * - Large libraries (1000+ papers)
 * - Partial lookups (single item)
 * - Incremental updates
 */

import { Logger } from '../utils/logger';
import { legacyModelIdToShortId, DEFAULT_MODEL_ID, getActiveModelId } from './model-registry';
import {
  identityFromItem,
  localItemIDFromIdentity,
  localLibraryIDFromKey,
  bulkResolve,
  libraryKeyFromLocalID,
} from './identity-resolver';

declare const Zotero: any;
declare const PathUtils: any;
declare const IOUtils: any;

// Text source types - now includes specific section types for better retrieval info
export type TextSourceType = 
  | 'abstract'      // Title + abstract (summary chunk)
  | 'fulltext'      // Legacy: generic full text
  | 'title_only'    // Title only (no abstract available)
  | 'summary'       // Same as abstract, from chunker
  | 'methods'       // Introduction, Background, Methods, etc.
  | 'findings'      // Results, Discussion, Conclusions, etc.
  | 'content';      // Generic content (fallback when sections not detected)

export interface PaperEmbedding {
  // Internal surrogate PK (assigned by SQLite on insert). Optional on input,
  // present on output. Callers should not depend on its specific value.
  itemPk?: number;

  // STABLE identity (use these for any cross-session reference)
  libraryKey: string;       // 'user' | 'group:<groupID>'
  itemKey: string;          // Zotero 8-char key, stable across machines

  // LOCAL convenience (resolved at runtime, not stored as identity)
  itemId?: number;          // Current Zotero.Item.id for this row in this session

  chunkIndex: number;       // 0 = summary (title+abstract), 1+ = fulltext chunks
  /** @deprecated Use libraryKey for identity. This field is populated at read
   *  time from libraryKey but is not stored in v8. Will be removed in v2.1. */
  libraryId?: number;
  title: string;
  abstract?: string;
  chunkText?: string;       // The actual text that was embedded (for debugging)
  textSource: TextSourceType;
  embedding: number[];      // 768 dimensions (nomic-embed-text-v1.5)
  modelId: string;
  indexedAt: string;
  contentHash: string;

  // Passage-level location (Phase 1: passage-level evidence linking)
  pageNumber?: number;       // 1-based page number (null for legacy/abstract-only)
  paragraphIndex?: number;   // 0-based paragraph index within page
  startChar?: number;        // Character offset in full extracted text
  endChar?: number;          // End character offset
  bbox?: string;             // JSON: [l, t, r, b] bounding box coordinates

  // Per-item indexing status (v7) — same value across all chunks of an item.
  // Stored on the items table; populated here so putBatch can write it.
  wasTruncated?: boolean;    // True if maxChunksPerPaper limit cut off content
  pagesIndexed?: number;     // Number of distinct PDF pages with at least one chunk
  pagesTotal?: number;       // Total pages in the source PDF (0 if unknown)
}

/**
 * Per-item indexing status — used by the item-tree column to decide
 * whether to show "Indexed", "Partial", "Outdated", etc.
 */
export interface ItemIndexStatus {
  libraryKey: string;
  itemKey: string;
  // Legacy field kept for UI compatibility until item-tree-column is migrated.
  // Will be resolved at read time.
  itemId?: number;
  indexedAt: string;
  wasTruncated: boolean;
  pagesIndexed: number;
  pagesTotal: number;
  chunkCount: number;
}

export interface VectorStoreStats {
  totalPapers: number;
  indexedPapers: number;
  totalChunks: number;
  avgChunksPerPaper: number;
  modelId: string;
  lastIndexed: Date | null;
  storageUsedBytes: number;

  // Passage-level location stats
  chunksWithLocation: number;     // Chunks that have page_number set
  locationCoveragePercent: number; // Percentage of chunks with location data
}

// Database configuration
const DB_NAME = 'zotseek';           // Schema name when attached
const DB_FILE = 'zotseek.sqlite';    // Database filename
const SCHEMA_VERSION = 9;            // v9: per-model embeddings (chunks.model_id + item_models)

// Legacy table prefix (for migration from old schema)
const LEGACY_TABLE_PREFIX = 'zs_';

/**
 * SQLite-based Vector Store
 *
 * Uses a separate database file attached to Zotero's connection.
 * Benefits: O(1) lookups, lower memory, atomic updates, clean uninstall
 */
export class VectorStoreSQLite {
  private logger: Logger;
  private initialized = false;
  private attached = false;
  private cache: {
    data: Array<{
      itemPk: number;
      libraryKey: string;
      itemKey: string;
      itemId?: number;
      chunkIndex: number;
      title: string;
      textSource: TextSourceType;
      modelId: string;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>;
    validAt: number;  // timestamp
  } | null = null;

  constructor() {
    this.logger = new Logger('VectorStoreSQLite');
  }

  /**
   * Get the path to the ZotSeek database file
   */
  private getDbPath(): string {
    return PathUtils.join(Zotero.DataDirectory.dir, DB_FILE);
  }

  /**
   * Zotero 8 DB wrapper workaround:
   * - `queryAsync()` can return []/undefined for some SELECTs even when rows exist.
   * - `columnQueryAsync()` is often more reliable for simple one-column result sets.
   */
  private async getItemIdsSafe(whereSql = '', params: any[] = []): Promise<number[]> {
    await this.ensureInit();

    const sql = `
      SELECT item_id
      FROM ${DB_NAME}.items
      ${whereSql}
      ORDER BY item_id
    `;

    try {
      if (Zotero.DB.columnQueryAsync) {
        const ids = await Zotero.DB.columnQueryAsync(sql, params);
        return (ids || []).map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
      }
    } catch (e) {
      // Expected on some Zotero builds; we'll fall back to queryAsync below.
      this.logger.debug(`getItemIdsSafe(): columnQueryAsync failed: ${e}`);
    }

    try {
      const rows = await Zotero.DB.queryAsync(sql, params);
      if (!rows || rows.length === 0) return [];
      return rows.map((r: any) => Number(r.item_id)).filter((n: number) => Number.isFinite(n));
    } catch (e) {
      this.logger.debug(`getItemIdsSafe(): queryAsync failed: ${e}`);
      return [];
    }
  }

  /**
   * Initialize the SQLite database
   * - Attaches separate database file to Zotero's connection
   * - Migrates data from old schema if needed
   * - Creates tables in the attached database
   */
  async init(): Promise<void> {
    if (this.initialized) return;

    this.logger.info('Initializing SQLite vector store with separate database...');

    try {
      // Check if Zotero.DB exists
      if (!Zotero.DB) {
        throw new Error('Zotero.DB is not available');
      }

      // Attach the separate database
      await this.attachDatabase();

      // Check for and migrate from old schema (zs_ tables in main database)
      await this.migrateFromOldSchema();

      // Create tables if they don't exist
      this.logger.debug('Creating tables...');
      await this.createTables();

      // Migrate to v4 (add location columns) if needed
      await this.migrateToV4();

      // Migrate to v5 (base64 embedding storage) if needed
      await this.migrateToV5();

      // Migrate to v6 (normalize: split embeddings into items + chunks) if needed
      await this.migrateToV6();

      // Migrate to v7 (per-item indexing status columns) if needed
      await this.migrateToV7();

      // Migrate to v8 (stable identity: library_key + item_key + item_pk) if needed
      await this.migrateToV8();

      // Migrate to v9 (per-model embeddings: chunks.model_id + item_models) if needed
      await this.migrateToV9();

      this.initialized = true;
      this.logger.info('SQLite store initialized successfully');

      // Get count
      const count = await this.getCount();
      const itemCount = await this.getItemCount();
      this.logger.info(`SQLite store has ${count} embedding chunks for ${itemCount} items`);
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      this.logger.error(`Failed to initialize SQLite store: ${errorMsg}`);
      throw new Error(`SQLite init failed: ${errorMsg}`);
    }
  }

  /**
   * Attach the ZotSeek database to Zotero's connection
   */
  private async attachDatabase(): Promise<void> {
    if (this.attached) return;

    const dbPath = this.getDbPath();
    this.logger.info(`Attaching database: ${dbPath}`);

    try {
      // Check if already attached (e.g., from a previous session that didn't clean up)
      const databases = await Zotero.DB.queryAsync("PRAGMA database_list");
      const alreadyAttached = databases?.some((db: any) => db.name === DB_NAME);

      if (alreadyAttached) {
        this.logger.info('Database already attached');
        this.attached = true;
        return;
      }

      // Attach the database
      await Zotero.DB.queryAsync(`ATTACH DATABASE ? AS ${DB_NAME}`, [dbPath]);
      this.attached = true;
      this.logger.info('Database attached successfully');
    } catch (error: any) {
      this.logger.error(`Failed to attach database: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Detach the ZotSeek database from Zotero's connection
   */
  async detachDatabase(): Promise<void> {
    if (!this.attached) return;

    try {
      await Zotero.DB.queryAsync(`DETACH DATABASE ${DB_NAME}`);
      this.attached = false;
      this.logger.info('Database detached successfully');
    } catch (error: any) {
      this.logger.warn(`Failed to detach database: ${error?.message || error}`);
    }
  }

  /**
   * Whether the zotseek schema is still attached to Zotero's connection.
   *
   * The ATTACH is bound to Zotero's underlying SQLite connection, which can be
   * recycled mid-session (a sync, a `database is locked` recovery, a backup).
   * When that happens the attachment is silently dropped while our `attached`
   * flag stays true, so every later query fails with `no such table:
   * zotseek.items`. On a large library the indexing run is long enough that
   * this happens reliably part-way through (issue #35).
   */
  private async isAttachmentLive(): Promise<boolean> {
    try {
      const databases = await Zotero.DB.queryAsync('PRAGMA database_list');
      return !!databases?.some((db: any) => db.name === DB_NAME);
    } catch (e) {
      this.logger.debug(`isAttachmentLive() check failed: ${e}`);
      return false;
    }
  }

  /**
   * Re-establish the ATTACH after Zotero recycled its connection and dropped
   * our attached database. Clears the stale flag, re-attaches, and ensures the
   * schema exists (createTables is idempotent). Does not re-run migrations: the
   * file is already at the current schema version from the original init().
   */
  private async reattachAfterConnectionLoss(): Promise<void> {
    this.logger.warn('zotseek database attachment was lost; re-attaching...');
    this.attached = false;
    await this.attachDatabase();
    await this.createTables();
    this.invalidateCache();
    this.logger.info('zotseek database re-attached successfully');
  }

  /**
   * Migrate data from old schema (zs_ tables in Zotero's main database)
   * to the new separate database
   */
  private async migrateFromOldSchema(): Promise<void> {
    // Check if old tables exist in Zotero's main database
    let hasOldTables = false;
    try {
      const result = await Zotero.DB.valueQueryAsync(
        `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${LEGACY_TABLE_PREFIX}embeddings' LIMIT 1`
      );
      hasOldTables = result === 1;
    } catch (e) {
      this.logger.debug(`Error checking for old tables: ${e}`);
    }

    if (!hasOldTables) {
      this.logger.debug('No old schema found, skipping migration');
      return;
    }

    this.logger.info('Found old zs_ tables, starting migration...');

    try {
      // First, ensure the old-format embeddings table exists as migration target
      // (migrateToV6 will later convert this to items + chunks)
      await Zotero.DB.queryAsync(`
        CREATE TABLE IF NOT EXISTS ${DB_NAME}.embeddings (
          item_id INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          item_key TEXT NOT NULL,
          library_id INTEGER NOT NULL,
          title TEXT NOT NULL,
          abstract TEXT,
          chunk_text TEXT,
          text_source TEXT NOT NULL,
          embedding TEXT NOT NULL,
          model_id TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          page_number INTEGER,
          paragraph_index INTEGER,
          start_char INTEGER,
          end_char INTEGER,
          bbox TEXT,
          PRIMARY KEY (item_id, chunk_index)
        )
      `);

      // Check if we already have data in the new database
      const newCount = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB_NAME}.embeddings`
      );

      if (newCount && newCount > 0) {
        this.logger.info(`New database already has ${newCount} records, skipping data migration`);
      } else {
        // Migrate embeddings data
        this.logger.info('Migrating embeddings data...');

        // Get count of old records
        const oldCount = await Zotero.DB.valueQueryAsync(
          `SELECT COUNT(*) FROM ${LEGACY_TABLE_PREFIX}embeddings`
        );
        this.logger.info(`Found ${oldCount} records to migrate`);

        if (oldCount > 0) {
          // Copy data from old table to new table
          await Zotero.DB.queryAsync(`
            INSERT INTO ${DB_NAME}.embeddings
            (item_id, chunk_index, item_key, library_id, title, abstract, chunk_text,
             text_source, embedding, model_id, indexed_at, content_hash)
            SELECT item_id, chunk_index, item_key, library_id, title, abstract, chunk_text,
                   text_source, embedding, model_id, indexed_at, content_hash
            FROM ${LEGACY_TABLE_PREFIX}embeddings
          `);
          this.logger.info('Embeddings data migrated successfully');
        }

        // Migrate metadata
        const hasOldMetadata = await Zotero.DB.valueQueryAsync(
          `SELECT 1 FROM sqlite_master WHERE type='table' AND name='${LEGACY_TABLE_PREFIX}metadata' LIMIT 1`
        );

        if (hasOldMetadata === 1) {
          this.logger.info('Migrating metadata...');
          await Zotero.DB.queryAsync(`
            INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value)
            SELECT key, value FROM ${LEGACY_TABLE_PREFIX}metadata
          `);
          this.logger.info('Metadata migrated successfully');
        }
      }

      // Drop old tables from Zotero's main database
      this.logger.info('Dropping old tables from Zotero database...');
      await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${LEGACY_TABLE_PREFIX}embeddings`);
      await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${LEGACY_TABLE_PREFIX}metadata`);

      // Drop old indexes (they're automatically dropped with the table, but just in case)
      try {
        await Zotero.DB.queryAsync(`DROP INDEX IF EXISTS ${LEGACY_TABLE_PREFIX}idx_item_id`);
        await Zotero.DB.queryAsync(`DROP INDEX IF EXISTS ${LEGACY_TABLE_PREFIX}idx_library_id`);
        await Zotero.DB.queryAsync(`DROP INDEX IF EXISTS ${LEGACY_TABLE_PREFIX}idx_content_hash`);
      } catch (e) {
        // Indexes may not exist or already dropped
      }

      this.logger.info('Old tables dropped successfully');

      // Run VACUUM to reclaim space in Zotero's main database
      this.logger.info('Running VACUUM to reclaim space...');
      try {
        await Zotero.DB.queryAsync('VACUUM');
        this.logger.info('VACUUM completed');
      } catch (e) {
        this.logger.warn(`VACUUM failed (non-critical): ${e}`);
      }

      this.logger.info('Migration from old schema completed successfully');
    } catch (error: any) {
      this.logger.error(`Migration failed: ${error?.message || error}`);
      // Don't throw - we can still continue with a fresh database
    }
  }

  /**
   * Migrate to schema v4: Add passage-level location columns
   * These columns enable click-to-source functionality by storing:
   * - page_number: 1-based page number where the chunk appears
   * - paragraph_index: 0-based paragraph index within the page
   * - start_char/end_char: Character offsets in full text
   * - bbox: Bounding box coordinates as JSON [l, t, r, b]
   */
  private async migrateToV4(): Promise<void> {
    // Check current schema version
    let currentVersion = 0;
    try {
      const versionResult = await Zotero.DB.valueQueryAsync(
        `SELECT value FROM ${DB_NAME}.metadata WHERE key = 'schema_version'`
      );
      currentVersion = parseInt(versionResult, 10) || 0;
    } catch (e) {
      this.logger.debug(`Could not read schema version: ${e}`);
    }

    if (currentVersion >= 4) {
      this.logger.debug('Schema already at v4 or higher, skipping migration');
      return;
    }

    this.logger.info(`Migrating schema from v${currentVersion} to v4 (adding location columns)...`);

    try {
      // Check if columns already exist (in case of partial migration)
      const tableInfo = await Zotero.DB.queryAsync(
        `PRAGMA ${DB_NAME}.table_info(embeddings)`
      );
      const existingColumns = new Set(tableInfo?.map((col: any) => col.name) || []);

      // Add location columns if they don't exist
      const columnsToAdd = [
        { name: 'page_number', type: 'INTEGER' },
        { name: 'paragraph_index', type: 'INTEGER' },
        { name: 'start_char', type: 'INTEGER' },
        { name: 'end_char', type: 'INTEGER' },
        { name: 'bbox', type: 'TEXT' },  // JSON: [l, t, r, b]
      ];

      for (const col of columnsToAdd) {
        if (!existingColumns.has(col.name)) {
          this.logger.debug(`Adding column: ${col.name}`);
          await Zotero.DB.queryAsync(
            `ALTER TABLE ${DB_NAME}.embeddings ADD COLUMN ${col.name} ${col.type}`
          );
        } else {
          this.logger.debug(`Column ${col.name} already exists, skipping`);
        }
      }

      // Create index on page_number for efficient location queries
      await Zotero.DB.queryAsync(`
        CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_page_number
        ON embeddings(page_number)
      `);

      // Update schema version
      await Zotero.DB.queryAsync(`
        INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', '4')
      `);

      this.logger.info('Schema migration to v4 completed successfully');

      // Log stats about existing data
      const totalChunks = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB_NAME}.embeddings`
      );
      this.logger.info(`Existing chunks without location data: ${totalChunks}`);
      this.logger.info('Re-index your library to populate location data for existing papers');
    } catch (error: any) {
      this.logger.error(`Migration to v4 failed: ${error?.message || error}`);
      // Don't throw - existing functionality should still work
    }
  }

  private async migrateToV5(): Promise<void> {
    let currentVersion = 0;
    try {
      const versionResult = await Zotero.DB.valueQueryAsync(
        `SELECT value FROM ${DB_NAME}.metadata WHERE key = 'schema_version'`
      );
      currentVersion = parseInt(versionResult, 10) || 0;
    } catch (e) {
      this.logger.debug(`Could not read schema version: ${e}`);
    }

    if (currentVersion >= 5) {
      this.logger.debug('Schema already at v5 or higher, skipping migration');
      return;
    }

    this.logger.info(`Migrating schema from v${currentVersion} to v5 (base64 embeddings)...`);

    try {
      // No schema change needed - column stays TEXT
      // New writes use base64, reads handle both formats
      // Existing JSON data will be converted to base64 on next re-index

      await Zotero.DB.queryAsync(`
        INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value)
        VALUES ('schema_version', '5')
      `);

      const rowCount = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB_NAME}.embeddings`
      );
      this.logger.info(`Schema migration to v5 completed. ${rowCount} existing chunks use JSON format.`);
      this.logger.info('Re-index your library to convert to base64 format (~73% embedding size reduction).');
    } catch (error: any) {
      this.logger.error(`Migration to v5 failed: ${error?.message || error}`);
    }
  }

  /**
   * Migrate to schema v6: Normalize embeddings into items + chunks tables
   * Eliminates per-chunk duplication of item-level data (title, abstract, etc.)
   */
  private async migrateToV6(): Promise<void> {
    let currentVersion = 0;
    try {
      const versionResult = await Zotero.DB.valueQueryAsync(
        `SELECT value FROM ${DB_NAME}.metadata WHERE key = 'schema_version'`
      );
      currentVersion = parseInt(versionResult, 10) || 0;
    } catch (e) {
      this.logger.debug(`Could not read schema version: ${e}`);
    }

    if (currentVersion >= 6) {
      this.logger.debug('Schema already at v6 or higher, skipping migration');
      return;
    }

    // Check if old embeddings table exists (it should if we're migrating)
    const hasEmbeddings = await this.tableExists('embeddings');
    if (!hasEmbeddings) {
      this.logger.debug('No embeddings table found, skipping v6 migration');
      return;
    }

    this.logger.info(`Migrating schema from v${currentVersion} to v6 (items + chunks normalization)...`);

    try {
      await Zotero.DB.executeTransaction(async () => {
        // 1. Create items table
        await Zotero.DB.queryAsync(`
          CREATE TABLE IF NOT EXISTS ${DB_NAME}.items (
            item_id INTEGER PRIMARY KEY,
            item_key TEXT NOT NULL,
            library_id INTEGER NOT NULL,
            title TEXT NOT NULL,
            abstract TEXT,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            content_hash TEXT NOT NULL
          )
        `);

        // 2. Populate items from embeddings (prefer chunk_index=0 for item metadata)
        await Zotero.DB.queryAsync(`
          INSERT OR IGNORE INTO ${DB_NAME}.items
            (item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash)
          SELECT item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash
          FROM ${DB_NAME}.embeddings
          WHERE chunk_index = 0
        `);

        // Pick up any items that only have chunk_index > 0 (edge case)
        await Zotero.DB.queryAsync(`
          INSERT OR IGNORE INTO ${DB_NAME}.items
            (item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash)
          SELECT item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash
          FROM ${DB_NAME}.embeddings
          WHERE item_id NOT IN (SELECT item_id FROM ${DB_NAME}.items)
          GROUP BY item_id
        `);

        // 3. Create chunks table
        await Zotero.DB.queryAsync(`
          CREATE TABLE IF NOT EXISTS ${DB_NAME}.chunks (
            item_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            chunk_text TEXT,
            text_source TEXT NOT NULL,
            embedding TEXT NOT NULL,
            page_number INTEGER,
            paragraph_index INTEGER,
            start_char INTEGER,
            end_char INTEGER,
            bbox TEXT,
            PRIMARY KEY (item_id, chunk_index)
          )
        `);

        // 4. Copy chunk data from embeddings
        await Zotero.DB.queryAsync(`
          INSERT OR IGNORE INTO ${DB_NAME}.chunks
            (item_id, chunk_index, chunk_text, text_source, embedding,
             page_number, paragraph_index, start_char, end_char, bbox)
          SELECT item_id, chunk_index, chunk_text, text_source, embedding,
                 page_number, paragraph_index, start_char, end_char, bbox
          FROM ${DB_NAME}.embeddings
        `);

        // 5. Drop old embeddings table
        await Zotero.DB.queryAsync(`DROP TABLE IF EXISTS ${DB_NAME}.embeddings`);

        // 6. Create indexes on new tables
        await Zotero.DB.queryAsync(`
          CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_items_library_id ON items(library_id)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_items_content_hash ON items(content_hash)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_chunks_item_id ON chunks(item_id)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_chunks_page_number ON chunks(page_number)
        `);

        // 7. Update schema version
        await Zotero.DB.queryAsync(`
          INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', '6')
        `);
      });

      // Log migration stats
      const itemCount = await Zotero.DB.valueQueryAsync(`SELECT COUNT(*) FROM ${DB_NAME}.items`);
      const chunkCount = await Zotero.DB.valueQueryAsync(`SELECT COUNT(*) FROM ${DB_NAME}.chunks`);
      this.logger.info(`Schema migration to v6 completed: ${itemCount} items, ${chunkCount} chunks`);
    } catch (error: any) {
      this.logger.error(`Migration to v6 failed: ${error?.message || error}`);
      // Don't throw - if migration fails, the old embeddings table is still intact
    }
  }

  /**
   * Migrate to schema v7: Add per-item indexing status columns
   *
   * Adds three columns to items so the UI can show whether a paper was
   * fully or partially indexed and how many pages were covered:
   * - was_truncated:  0/1 — true when maxChunksPerPaper cut off content
   * - pages_indexed:  count of distinct PDF pages with at least one chunk
   * - pages_total:    total pages in the PDF (0 when unknown)
   */
  private async migrateToV7(): Promise<void> {
    // Detect v7 by checking for the columns directly, not by reading
    // schema_version. createTables() unconditionally bumps the version
    // even when it CREATE TABLE IF NOT EXISTS is a no-op, so the version
    // marker can lie. The columns are the ground truth.
    let existing: Set<string>;
    try {
      const itemsInfo: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB_NAME}.table_info(items)`);
      existing = new Set((itemsInfo || []).map((r: any) => r.name));
    } catch (e: any) {
      this.logger.error(`Could not introspect items table for v7 migration: ${e?.message || e}`);
      return;
    }

    if (
      existing.has('was_truncated') &&
      existing.has('pages_indexed') &&
      existing.has('pages_total')
    ) {
      this.logger.debug('items table already has v7 columns, skipping migration');
      return;
    }

    this.logger.info('Migrating items table to v7 (indexing status columns)...');

    try {
      if (!existing.has('was_truncated')) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${DB_NAME}.items ADD COLUMN was_truncated INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!existing.has('pages_indexed')) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${DB_NAME}.items ADD COLUMN pages_indexed INTEGER NOT NULL DEFAULT 0`
        );
      }
      if (!existing.has('pages_total')) {
        await Zotero.DB.queryAsync(
          `ALTER TABLE ${DB_NAME}.items ADD COLUMN pages_total INTEGER NOT NULL DEFAULT 0`
        );
      }

      await Zotero.DB.queryAsync(
        `INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', '7')`
      );

      this.logger.info('Schema migration to v7 completed');
    } catch (error: any) {
      this.logger.error(`Migration to v7 failed: ${error?.message || error}`);
      // Non-fatal: if the columns can't be added, the column UI will fall back
      // to chunk-count-only status and the rest of the plugin still works.
    }
  }

  /**
   * Migrate to schema v8: Stable cross-machine identity.
   *
   * v7 used `items.item_id` (Zotero's local auto-increment ID) as the primary
   * key, which breaks when the database is copied to another Zotero
   * installation because local item IDs aren't stable across machines.
   *
   * v8 introduces:
   * - `items.item_pk` (autoincrement surrogate, ZotSeek-internal)
   * - `items.library_key` ('user' | 'group:<groupID>', stable via sync)
   * - `items.item_key` (already existed, Zotero's stable 8-char key)
   * - UNIQUE(library_key, item_key) as the logical identity
   * - `chunks.item_pk` FK to items.item_pk
   *
   * Migration strategy: resolve each old row's identity using its stored
   * `item_key` and the current Zotero state. Works uniformly whether the
   * database was indexed on this machine OR copied from another. Rows
   * whose `item_key` doesn't resolve to any local Zotero item are moved
   * to the `orphan_items` table (data preserved, not searchable).
   *
   * Detection: presence of `library_key` column in items is the ground truth.
   * The `schema_version` row is unreliable (see CLAUDE.md pitfall #8).
   */
  private async migrateToV8(): Promise<void> {
    // Detect v8 by column presence
    let existing: Set<string>;
    try {
      const cols: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB_NAME}.table_info(items)`);
      existing = new Set((cols || []).map((c: any) => c.name));
    } catch (e: any) {
      this.logger.error(`migrateToV8: could not introspect items table: ${e?.message || e}`);
      return;
    }

    if (existing.has('library_key') && existing.has('item_pk')) {
      this.logger.debug('items table already at v8, skipping migration');
      return;
    }

    // Must have a v7 items table to migrate from
    if (!existing.has('item_id') || !existing.has('item_key')) {
      this.logger.debug('No v7 items table found, skipping v8 migration');
      return;
    }

    this.logger.info('Migrating schema from v7 to v8 (stable cross-machine identity)...');

    // === 1. Pre-migration backup ===
    const dbPath = this.getDbPath();
    const backupPath = `${dbPath}.v7.bak`;
    try {
      // Use IOUtils to copy the file; we need Zotero to flush first.
      // The simplest safe approach is to DETACH, copy, ATTACH.
      await this.detachDatabase();
      await IOUtils.copy(dbPath, backupPath, { noOverwrite: false });
      this.logger.info(`Pre-migration backup written to ${backupPath}`);
      await this.attachDatabase();
    } catch (e: any) {
      this.logger.error(`Backup failed, aborting migration: ${e?.message || e}`);
      // Ensure DB is attached so the rest of init doesn't break
      try { await this.attachDatabase(); } catch { /* ignore */ }
      throw new Error(`v8 migration aborted: backup failed (${e?.message || e})`);
    }

    // === 2. Resolve identity for every old row ===
    // We read the entire items table into memory (4000-10000 rows is trivial).
    // For each row, we resolve (library_key, item_key) using identity-resolver.

    const { findIdentityByItemKey, libraryKeyFromLocalID } = await import('./identity-resolver');

    let oldRows: Array<{
      item_id: number;
      item_key: string;
      library_id: number;
      title: string;
      abstract: string | null;
      model_id: string;
      indexed_at: string;
      content_hash: string;
      was_truncated: number;
      pages_indexed: number;
      pages_total: number;
    }> = [];

    try {
      // Use parallel columnQueryAsync to dodge the multi-column SELECT
      // empty-result quirk documented in CLAUDE.md.
      const orderBy = `ORDER BY item_id`;
      const [
        itemIds, itemKeys, libraryIds, titles, abstracts, modelIds,
        indexedAts, contentHashes, wasTruncateds, pagesIndexeds, pagesTotals
      ] = await Promise.all([
        Zotero.DB.columnQueryAsync(`SELECT item_id FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT item_key FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT library_id FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT title FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT abstract FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT model_id FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT was_truncated FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT pages_indexed FROM ${DB_NAME}.items ${orderBy}`),
        Zotero.DB.columnQueryAsync(`SELECT pages_total FROM ${DB_NAME}.items ${orderBy}`),
      ]);

      const n = (itemIds || []).length;
      for (let i = 0; i < n; i++) {
        oldRows.push({
          item_id: Number(itemIds[i]),
          item_key: itemKeys[i],
          library_id: Number(libraryIds[i]),
          title: titles[i],
          abstract: abstracts[i],
          model_id: modelIds[i],
          indexed_at: indexedAts[i],
          content_hash: contentHashes[i],
          was_truncated: Number(wasTruncateds[i] || 0),
          pages_indexed: Number(pagesIndexeds[i] || 0),
          pages_total: Number(pagesTotals[i] || 0),
        });
      }
    } catch (e: any) {
      this.logger.error(`migrateToV8: failed to read old items: ${e?.message || e}`);
      throw e;
    }

    this.logger.info(`migrateToV8: resolving identity for ${oldRows.length} items...`);

    type ResolvedRow = typeof oldRows[number] & {
      library_key: string | null;
      resolved: boolean;
    };

    const resolved: ResolvedRow[] = [];
    let matchedCount = 0;
    let orphanCount = 0;

    for (const row of oldRows) {
      // First try the row's stored library_id directly — fast path for upgrades
      // on the original machine.
      let libraryKey = libraryKeyFromLocalID(row.library_id);
      let stillMatches = false;
      if (libraryKey) {
        try {
          const liveID = Zotero.Items.getIDFromLibraryAndKey(row.library_id, row.item_key);
          stillMatches = !!(liveID && liveID === row.item_id);
        } catch (e: any) {
          stillMatches = false;
        }
      }

      if (libraryKey && stillMatches) {
        resolved.push({ ...row, library_key: libraryKey, resolved: true });
        matchedCount++;
        continue;
      }

      // Fall back to scanning all libraries by item_key (cross-machine copy case).
      let identity: { libraryKey: string; itemKey: string } | null = null;
      try {
        identity = findIdentityByItemKey(row.item_key, row.library_id);
      } catch (e: any) {
        identity = null;
      }

      if (identity) {
        resolved.push({ ...row, library_key: identity.libraryKey, resolved: true });
        matchedCount++;
      } else {
        resolved.push({ ...row, library_key: null, resolved: false });
        orphanCount++;
      }
    }

    this.logger.info(`migrateToV8: ${matchedCount} matched, ${orphanCount} orphans`);

    // === 2b. Deduplicate by (library_key, item_key) ===
    // v6/v7 items had `item_id INTEGER PRIMARY KEY` and NO uniqueness on
    // item_key. Two rows can share the same item_key when an item was deleted
    // and re-added locally (Zotero regenerates item_id but keeps the synced
    // item_key) or after a local DB restore. v8's UNIQUE(library_key, item_key)
    // would reject the second INSERT and roll back the whole transaction.
    //
    // Strategy: pick one canonical row per (library_key, item_key) — the one
    // with the most recent indexed_at (tiebreaker: largest item_id). Map the
    // other old item_ids to the canonical's new item_pk so their chunks still
    // get re-homed, but only the canonical row is inserted into items.
    type CanonicalRow = ResolvedRow & { duplicateOldIds: number[] };
    const dedupKey = (r: ResolvedRow) =>
      `${r.library_key || 'orphan'}|${r.item_key}`;
    const groups = new Map<string, ResolvedRow[]>();
    for (const r of resolved) {
      const k = dedupKey(r);
      const arr = groups.get(k);
      if (arr) arr.push(r);
      else groups.set(k, [r]);
    }

    const canonicals: CanonicalRow[] = [];
    let duplicateCount = 0;
    for (const [, rows] of groups) {
      if (rows.length === 1) {
        canonicals.push({ ...rows[0], duplicateOldIds: [] });
        continue;
      }
      // Pick canonical: newest indexed_at first, then largest item_id.
      rows.sort((a, b) => {
        const ta = a.indexed_at || '';
        const tb = b.indexed_at || '';
        if (tb !== ta) return tb < ta ? -1 : 1;
        return b.item_id - a.item_id;
      });
      const [head, ...rest] = rows;
      duplicateCount += rest.length;
      canonicals.push({ ...head, duplicateOldIds: rest.map(r => r.item_id) });
    }

    if (duplicateCount > 0) {
      this.logger.warn(
        `migrateToV8: collapsed ${duplicateCount} duplicate items ` +
        `into ${canonicals.length} unique (library_key, item_key) rows`
      );
    }

    // === 3. Build the new tables inside a transaction ===
    try {
      await Zotero.DB.executeTransaction(async () => {
        // Rename old tables out of the way
        await Zotero.DB.queryAsync(`ALTER TABLE ${DB_NAME}.items RENAME TO items_v7_old`);
        await Zotero.DB.queryAsync(`ALTER TABLE ${DB_NAME}.chunks RENAME TO chunks_v7_old`);

        // Create new v8 tables
        await Zotero.DB.queryAsync(`
          CREATE TABLE ${DB_NAME}.items (
            item_pk INTEGER PRIMARY KEY AUTOINCREMENT,
            library_key TEXT NOT NULL,
            item_key TEXT NOT NULL,
            title TEXT NOT NULL,
            abstract TEXT,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            was_truncated INTEGER NOT NULL DEFAULT 0,
            pages_indexed INTEGER NOT NULL DEFAULT 0,
            pages_total INTEGER NOT NULL DEFAULT 0,
            UNIQUE(library_key, item_key)
          )
        `);

        await Zotero.DB.queryAsync(`
          CREATE TABLE ${DB_NAME}.chunks (
            item_pk INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            chunk_text TEXT,
            text_source TEXT NOT NULL,
            embedding TEXT NOT NULL,
            page_number INTEGER,
            paragraph_index INTEGER,
            start_char INTEGER,
            end_char INTEGER,
            bbox TEXT,
            PRIMARY KEY (item_pk, chunk_index),
            FOREIGN KEY (item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
          )
        `);

        await Zotero.DB.queryAsync(`
          CREATE TABLE IF NOT EXISTS ${DB_NAME}.orphan_items (
            item_pk INTEGER PRIMARY KEY,
            library_key TEXT NOT NULL,
            item_key TEXT NOT NULL,
            detected_at TEXT NOT NULL,
            reason TEXT NOT NULL
          )
        `);

        // === 4. Copy data using the deduplicated canonical list ===
        // Insert one row per (library_key, item_key) group. Any duplicate
        // old item_ids are remapped to the canonical row's new item_pk so
        // their chunks survive (with canonical winning on chunk_index ties).

        const oldIdToNewPk = new Map<number, number>();
        const canonicalOldIds = new Set<number>();
        const nowIso = new Date().toISOString();

        for (const r of canonicals) {
          const libraryKey = r.library_key || 'orphan';

          if (r.resolved) {
            await Zotero.DB.queryAsync(`
              INSERT INTO ${DB_NAME}.items
                (library_key, item_key, title, abstract, model_id, indexed_at,
                 content_hash, was_truncated, pages_indexed, pages_total)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              libraryKey, r.item_key, r.title, r.abstract, r.model_id, r.indexed_at,
              r.content_hash, r.was_truncated, r.pages_indexed, r.pages_total
            ]);
          } else {
            // Orphan path: still insert into items so chunks can point at it,
            // but with a placeholder library_key. We also log to orphan_items
            // for UI surfacing.
            await Zotero.DB.queryAsync(`
              INSERT INTO ${DB_NAME}.items
                (library_key, item_key, title, abstract, model_id, indexed_at,
                 content_hash, was_truncated, pages_indexed, pages_total)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            `, [
              'orphan', r.item_key, r.title, r.abstract, r.model_id, r.indexed_at,
              r.content_hash, r.was_truncated, r.pages_indexed, r.pages_total
            ]);
          }
          const newPk = Number(await Zotero.DB.valueQueryAsync('SELECT last_insert_rowid()'));
          oldIdToNewPk.set(r.item_id, newPk);
          canonicalOldIds.add(r.item_id);
          for (const dupOldId of r.duplicateOldIds) {
            oldIdToNewPk.set(dupOldId, newPk);
          }

          if (!r.resolved) {
            await Zotero.DB.queryAsync(`
              INSERT INTO ${DB_NAME}.orphan_items
                (item_pk, library_key, item_key, detected_at, reason)
              VALUES (?, ?, ?, ?, ?)
            `, [newPk, 'orphan', r.item_key, nowIso, 'item_key not found in any current Zotero library']);
          }
        }

        // === 5. Copy chunks, remapping item_id -> item_pk ===
        // Two-pass copy so the canonical row's chunks win on chunk_index
        // collisions with chunks from collapsed duplicates.
        await Zotero.DB.queryAsync(`
          CREATE TEMPORARY TABLE _id_map (
            old_id INTEGER PRIMARY KEY,
            new_pk INTEGER NOT NULL,
            is_canonical INTEGER NOT NULL
          )
        `);
        for (const [oldId, newPk] of oldIdToNewPk.entries()) {
          await Zotero.DB.queryAsync(
            `INSERT INTO _id_map (old_id, new_pk, is_canonical) VALUES (?, ?, ?)`,
            [oldId, newPk, canonicalOldIds.has(oldId) ? 1 : 0]
          );
        }

        // Pass 1: canonical chunks (no possible (item_pk, chunk_index) conflict
        // because every canonical maps to a unique new_pk).
        await Zotero.DB.queryAsync(`
          INSERT INTO ${DB_NAME}.chunks
            (item_pk, chunk_index, chunk_text, text_source, embedding,
             page_number, paragraph_index, start_char, end_char, bbox)
          SELECT m.new_pk, c.chunk_index, c.chunk_text, c.text_source, c.embedding,
                 c.page_number, c.paragraph_index, c.start_char, c.end_char, c.bbox
          FROM ${DB_NAME}.chunks_v7_old c
          INNER JOIN _id_map m ON m.old_id = c.item_id
          WHERE m.is_canonical = 1
        `);

        // Pass 2: duplicate chunks fill in any chunk_index slots the canonical
        // didn't cover. OR IGNORE keeps the canonical's row on conflict.
        await Zotero.DB.queryAsync(`
          INSERT OR IGNORE INTO ${DB_NAME}.chunks
            (item_pk, chunk_index, chunk_text, text_source, embedding,
             page_number, paragraph_index, start_char, end_char, bbox)
          SELECT m.new_pk, c.chunk_index, c.chunk_text, c.text_source, c.embedding,
                 c.page_number, c.paragraph_index, c.start_char, c.end_char, c.bbox
          FROM ${DB_NAME}.chunks_v7_old c
          INNER JOIN _id_map m ON m.old_id = c.item_id
          WHERE m.is_canonical = 0
        `);

        await Zotero.DB.queryAsync('DROP TABLE _id_map');

        // === 6. Drop old tables and create indexes ===
        await Zotero.DB.queryAsync(`DROP TABLE ${DB_NAME}.items_v7_old`);
        await Zotero.DB.queryAsync(`DROP TABLE ${DB_NAME}.chunks_v7_old`);

        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_items_identity ON items(library_key, item_key)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_items_library_key ON items(library_key)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_items_content_hash ON items(content_hash)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_chunks_item_pk ON chunks(item_pk)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_chunks_page_number ON chunks(page_number)
        `);
        await Zotero.DB.queryAsync(`
          CREATE INDEX ${DB_NAME}.idx_orphan_items_identity ON orphan_items(library_key, item_key)
        `);

        // === 7. Update schema version ===
        await Zotero.DB.queryAsync(`
          INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', '8')
        `);
      });

      this.logger.info(`Schema migration to v8 completed: ${matchedCount} matched, ${orphanCount} orphans`);

      // Stash post-migration stats for the UI (optional but useful)
      await Zotero.DB.queryAsync(`
        INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('v8_migration_matched', ?)
      `, [String(matchedCount)]);
      await Zotero.DB.queryAsync(`
        INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('v8_migration_orphans', ?)
      `, [String(orphanCount)]);
      await Zotero.DB.queryAsync(`
        INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('v8_migration_completed_at', ?)
      `, [new Date().toISOString()]);

    } catch (error: any) {
      this.logger.error(`Migration to v8 FAILED: ${error?.message || error}`);
      this.logger.error(`Backup at ${backupPath}. To rollback: quit Zotero, restore the backup file over zotseek.sqlite.`);
      throw error;
    }
  }

  /**
   * Migrate schema from v8 to v9.
   *
   * v9 adds:
   * - `chunks.model_id TEXT NOT NULL` — identifies which embedding model produced each chunk
   * - New composite PK `(item_pk, chunk_index, model_id)` on chunks
   * - New `item_models` table — per-(item, model) indexing status
   *
   * Detection: presence of `model_id` column in chunks is ground truth (pitfall #8).
   * Backfills legacy hfPath model_ids (e.g. 'Xenova/nomic-embed-text-v1.5') to short ids
   * via legacyModelIdToShortId, reading per-item model_id from the items table.
   */
  private async migrateToV9(): Promise<void> {
    // Detect done-ness by column presence, not the schema-version marker (pitfall #8).
    let chunkCols: Set<string>;
    try {
      const cols: any[] = await Zotero.DB.queryAsync(`PRAGMA ${DB_NAME}.table_info(chunks)`);
      chunkCols = new Set((cols || []).map((c: any) => c.name));
    } catch (e: any) {
      const msg = e?.message || String(e);
      this.logger.error(`migrateToV9: cannot introspect chunks: ${msg}`);
      throw new Error(`v9 migration aborted: cannot introspect chunks (${msg})`);
    }
    if (chunkCols.has('model_id')) {
      this.logger.debug('chunks already at v9, skipping migration');
      return;
    }

    this.logger.info('Migrating schema from v8 to v9 (per-model embeddings)...');

    // 1. Pre-migration backup (DETACH -> copy -> ATTACH), mirroring migrateToV8.
    const dbPath = this.getDbPath();
    const backupPath = `${dbPath}.v8.bak`;
    try {
      await this.detachDatabase();
      await IOUtils.copy(dbPath, backupPath, { noOverwrite: false });
      this.logger.info(`Pre-migration backup written to ${backupPath}`);
      await this.attachDatabase();
    } catch (e: any) {
      this.logger.error(`v9 backup failed, aborting: ${e?.message || e}`);
      try { await this.attachDatabase(); } catch { /* ignore */ }
      throw new Error(`v9 migration aborted: backup failed (${e?.message || e})`);
    }

    try {
      await Zotero.DB.executeTransaction(async () => {
        // 2. Add chunks.model_id (nullable first; SQLite can't add NOT NULL w/o default to a populated table).
        await Zotero.DB.queryAsync(`ALTER TABLE ${DB_NAME}.chunks ADD COLUMN model_id TEXT`);

        // 3. Create item_models table.
        await Zotero.DB.queryAsync(`
          CREATE TABLE IF NOT EXISTS ${DB_NAME}.item_models (
            item_pk INTEGER NOT NULL,
            model_id TEXT NOT NULL,
            indexed_at TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            was_truncated INTEGER NOT NULL DEFAULT 0,
            pages_indexed INTEGER NOT NULL DEFAULT 0,
            pages_total INTEGER NOT NULL DEFAULT 0,
            PRIMARY KEY (item_pk, model_id),
            FOREIGN KEY (item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
          )
        `);

        // 4. Backfill chunks.model_id + populate item_models, set-based (O(distinct models)).
        const distinctLegacy: string[] = (await Zotero.DB.columnQueryAsync(
          `SELECT DISTINCT model_id FROM ${DB_NAME}.items`)) || [];
        for (const legacy of distinctLegacy) {
          const shortId = legacyModelIdToShortId(legacy || '') || DEFAULT_MODEL_ID;
          await Zotero.DB.queryAsync(`
            UPDATE ${DB_NAME}.chunks SET model_id = ?
            WHERE model_id IS NULL
              AND item_pk IN (SELECT item_pk FROM ${DB_NAME}.items WHERE model_id = ?)
          `, [shortId, legacy]);
          await Zotero.DB.queryAsync(`
            INSERT OR REPLACE INTO ${DB_NAME}.item_models
              (item_pk, model_id, indexed_at, content_hash, was_truncated, pages_indexed, pages_total)
            SELECT item_pk, ?, indexed_at, content_hash, was_truncated, pages_indexed, pages_total
            FROM ${DB_NAME}.items WHERE model_id = ?
          `, [shortId, legacy]);
        }
        // Orphan safety: any chunk whose item_pk has no matching items row keeps NULL; default it
        // so the NOT NULL rebuild below cannot abort the whole migration.
        await Zotero.DB.queryAsync(
          `UPDATE ${DB_NAME}.chunks SET model_id = ? WHERE model_id IS NULL`, [DEFAULT_MODEL_ID]);

        // 5. Rebuild chunks with the new composite PK (item_pk, chunk_index, model_id).
        await Zotero.DB.queryAsync(`ALTER TABLE ${DB_NAME}.chunks RENAME TO chunks_v8`);
        await Zotero.DB.queryAsync(`
          CREATE TABLE ${DB_NAME}.chunks (
            item_pk INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL DEFAULT 0,
            model_id TEXT NOT NULL,
            chunk_text TEXT,
            text_source TEXT NOT NULL,
            embedding TEXT NOT NULL,
            page_number INTEGER,
            paragraph_index INTEGER,
            start_char INTEGER,
            end_char INTEGER,
            bbox TEXT,
            PRIMARY KEY (item_pk, chunk_index, model_id),
            FOREIGN KEY (item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
          )
        `);
        await Zotero.DB.queryAsync(`
          INSERT INTO ${DB_NAME}.chunks
            (item_pk, chunk_index, model_id, chunk_text, text_source, embedding,
             page_number, paragraph_index, start_char, end_char, bbox)
          SELECT item_pk, chunk_index, model_id, chunk_text, text_source, embedding,
             page_number, paragraph_index, start_char, end_char, bbox
          FROM ${DB_NAME}.chunks_v8
        `);
        await Zotero.DB.queryAsync(`DROP TABLE ${DB_NAME}.chunks_v8`);

        // 7. Version bump.
        await Zotero.DB.queryAsync(
          `INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', '9')`
        );
      });
    } catch (error: any) {
      this.logger.error(`Migration to v9 FAILED: ${error?.message || error}`);
      this.logger.error(`Backup at ${backupPath}. To rollback: quit Zotero, restore the backup file over zotseek.sqlite.`);
      throw error;
    }

    this.logger.info('Migrated zotseek DB to schema v9');
    this.invalidateCache();
  }

  /**
   * Check if a table exists in the attached database
   */
  private async tableExists(tableName: string): Promise<boolean> {
    try {
      const result = await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB_NAME}.sqlite_master WHERE type='table' AND name=?`,
        [tableName]
      );
      return Number(result) > 0;
    } catch (e) {
      return false;
    }
  }

  /**
   * Create database schema in the attached database
   */
  private async createTables(): Promise<void> {
    // If old embeddings table exists (very old schema), defer to legacy migration.
    const oldTableExists = await this.tableExists('embeddings');
    if (oldTableExists) {
      this.logger.debug('Old embeddings table found, deferring to migration');
      return;
    }

    // If a v7 items table exists, the v8 migration will recreate the tables.
    // Skip create here; migrateToV8() handles the transition.
    const v7ItemsExists = await this.tableExists('items');
    if (v7ItemsExists) {
      // Check if it's already v8 (has library_key column)
      const cols = await Zotero.DB.queryAsync(`PRAGMA ${DB_NAME}.table_info(items)`);
      const hasLibraryKey = (cols || []).some((c: any) => c.name === 'library_key');
      if (!hasLibraryKey) {
        this.logger.debug('v7 items table present, deferring to migrateToV8');
        return;
      }
      // Already v8, fall through to ensure indexes exist
    } else {
      // Fresh install: create v8 schema from scratch
      await Zotero.DB.queryAsync(`
        CREATE TABLE IF NOT EXISTS ${DB_NAME}.items (
          item_pk INTEGER PRIMARY KEY AUTOINCREMENT,
          library_key TEXT NOT NULL,
          item_key TEXT NOT NULL,
          title TEXT NOT NULL,
          abstract TEXT,
          model_id TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          was_truncated INTEGER NOT NULL DEFAULT 0,
          pages_indexed INTEGER NOT NULL DEFAULT 0,
          pages_total INTEGER NOT NULL DEFAULT 0,
          UNIQUE(library_key, item_key)
        )
      `);

      await Zotero.DB.queryAsync(`
        CREATE TABLE IF NOT EXISTS ${DB_NAME}.chunks (
          item_pk INTEGER NOT NULL,
          chunk_index INTEGER NOT NULL DEFAULT 0,
          model_id TEXT NOT NULL,
          chunk_text TEXT,
          text_source TEXT NOT NULL,
          embedding TEXT NOT NULL,
          page_number INTEGER,
          paragraph_index INTEGER,
          start_char INTEGER,
          end_char INTEGER,
          bbox TEXT,
          PRIMARY KEY (item_pk, chunk_index, model_id),
          FOREIGN KEY (item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
        )
      `);

      await Zotero.DB.queryAsync(`
        CREATE TABLE IF NOT EXISTS ${DB_NAME}.item_models (
          item_pk INTEGER NOT NULL,
          model_id TEXT NOT NULL,
          indexed_at TEXT NOT NULL,
          content_hash TEXT NOT NULL,
          was_truncated INTEGER NOT NULL DEFAULT 0,
          pages_indexed INTEGER NOT NULL DEFAULT 0,
          pages_total INTEGER NOT NULL DEFAULT 0,
          PRIMARY KEY (item_pk, model_id),
          FOREIGN KEY (item_pk) REFERENCES items(item_pk) ON DELETE CASCADE
        )
      `);

      await Zotero.DB.queryAsync(`
        CREATE TABLE IF NOT EXISTS ${DB_NAME}.orphan_items (
          item_pk INTEGER PRIMARY KEY,
          library_key TEXT NOT NULL,
          item_key TEXT NOT NULL,
          detected_at TEXT NOT NULL,
          reason TEXT NOT NULL
        )
      `);
    }

    await this.createIndexes();
    await this.updateSchemaVersion();

    this.logger.debug('Tables created successfully (v9)');
  }

  /**
   * Create indexes for items and chunks tables
   */
  private async createIndexes(): Promise<void> {
    // Identity lookup (library_key, item_key) → item_pk. The UNIQUE constraint
    // on items already provides this, but an explicit index helps query planners.
    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_items_identity
      ON items(library_key, item_key)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_items_library_key
      ON items(library_key)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_items_content_hash
      ON items(content_hash)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_chunks_item_pk
      ON chunks(item_pk)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_chunks_page_number
      ON chunks(page_number)
    `);

    await Zotero.DB.queryAsync(`
      CREATE INDEX IF NOT EXISTS ${DB_NAME}.idx_orphan_items_identity
      ON orphan_items(library_key, item_key)
    `);
  }

  /**
   * Update schema version in metadata
   */
  private async updateSchemaVersion(): Promise<void> {
    // Ensure metadata table exists
    await Zotero.DB.queryAsync(`
      CREATE TABLE IF NOT EXISTS ${DB_NAME}.metadata (
        key TEXT PRIMARY KEY,
        value TEXT
      )
    `);

    // Set schema version
    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES ('schema_version', ?)
    `, [String(SCHEMA_VERSION)]);
  }

  /**
   * Convert embedding array to base64 string for storage
   * Stores raw Float32Array bytes as base64 (4096 bytes for 768 dims vs ~15000 JSON)
   */
  private embeddingToBase64(embedding: number[]): string {
    const float32 = new Float32Array(embedding);
    const bytes = new Uint8Array(float32.buffer);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
  }

  /**
   * Convert stored string back to embedding array
   * Handles both base64 (v5+) and legacy JSON TEXT (v4 and earlier)
   */
  private base64ToEmbedding(data: string): number[] {
    if (!data) {
      this.logger.error('base64ToEmbedding received null/undefined data');
      return [];
    }

    try {
      // Detect format: JSON starts with '[', base64 does not
      if (data.startsWith('[')) {
        // Legacy JSON format
        const parsed = JSON.parse(data);
        if (!Array.isArray(parsed)) {
          this.logger.error('base64ToEmbedding: JSON parsed to non-array');
          return [];
        }
        return parsed;
      }

      // Base64 format
      const binary = atob(data);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const float32 = new Float32Array(bytes.buffer);
      return Array.from(float32);
    } catch (e) {
      this.logger.error(`base64ToEmbedding failed: ${e}`);
      return [];
    }
  }

  /**
   * Convert a joined items+chunks row into a PaperEmbedding.
   * Resolves the local Zotero itemId on the fly via the identity resolver.
   */
  private rowToEmbedding(row: {
    itemPk: number;
    libraryKey: string;
    itemKey: string;
    title: string;
    abstract?: string | null;
    modelId: string;
    indexedAt: string;
    contentHash: string;
    chunkIndex: number;
    chunkText?: string | null;
    textSource: string;
    embedding: string;
    pageNumber?: number | null;
    paragraphIndex?: number | null;
    startChar?: number | null;
    endChar?: number | null;
    bbox?: string | null;
  }): PaperEmbedding {
    const itemId = localItemIDFromIdentity({
      libraryKey: row.libraryKey,
      itemKey: row.itemKey,
    }) ?? undefined;
    const libraryId = localLibraryIDFromKey(row.libraryKey) ?? undefined;

    return {
      itemPk: row.itemPk,
      libraryKey: row.libraryKey,
      itemKey: row.itemKey,
      itemId,
      libraryId,
      chunkIndex: row.chunkIndex,
      title: row.title,
      abstract: row.abstract || undefined,
      chunkText: row.chunkText || undefined,
      textSource: (row.textSource as TextSourceType) || 'abstract',
      embedding: this.base64ToEmbedding(row.embedding),
      modelId: row.modelId,
      indexedAt: row.indexedAt,
      contentHash: row.contentHash,
      pageNumber: row.pageNumber != null ? Number(row.pageNumber) : undefined,
      paragraphIndex: row.paragraphIndex != null ? Number(row.paragraphIndex) : undefined,
      startChar: row.startChar != null ? Number(row.startChar) : undefined,
      endChar: row.endChar != null ? Number(row.endChar) : undefined,
      bbox: row.bbox || undefined,
    };
  }

  /**
   * Resolve (library_key, item_key) to an existing item_pk, or create a new
   * row in items if absent. Updates item-level metadata on UPSERT.
   *
   * Uses a manual "SELECT then INSERT" pattern because the version of SQLite
   * bundled with Zotero 8 doesn't reliably support RETURNING.
   */
  private async getOrCreateItemPk(meta: {
    libraryKey: string;
    itemKey: string;
    title: string;
    abstract?: string | null;
    modelId: string;
    indexedAt: string;
    contentHash: string;
    wasTruncated?: boolean;
    pagesIndexed?: number;
    pagesTotal?: number;
  }): Promise<number> {
    // Try to find existing
    const existing = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [meta.libraryKey, meta.itemKey]
    );

    if (existing && Number(existing) > 0) {
      // Update metadata in case it changed (re-index path)
      await Zotero.DB.queryAsync(`
        UPDATE ${DB_NAME}.items
        SET title = ?, abstract = ?, model_id = ?, indexed_at = ?,
            content_hash = ?, was_truncated = ?, pages_indexed = ?, pages_total = ?
        WHERE item_pk = ?
      `, [
        meta.title, meta.abstract ?? null, meta.modelId, meta.indexedAt,
        meta.contentHash,
        meta.wasTruncated ? 1 : 0,
        meta.pagesIndexed ?? 0,
        meta.pagesTotal ?? 0,
        Number(existing)
      ]);
      return Number(existing);
    }

    // Insert new
    await Zotero.DB.queryAsync(`
      INSERT INTO ${DB_NAME}.items
        (library_key, item_key, title, abstract, model_id, indexed_at,
         content_hash, was_truncated, pages_indexed, pages_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      meta.libraryKey, meta.itemKey, meta.title, meta.abstract ?? null,
      meta.modelId, meta.indexedAt, meta.contentHash,
      meta.wasTruncated ? 1 : 0, meta.pagesIndexed ?? 0, meta.pagesTotal ?? 0
    ]);
    const newPk = await Zotero.DB.valueQueryAsync(`SELECT last_insert_rowid()`);
    return Number(newPk);
  }

  /**
   * Upsert a row in item_models for the given item_pk + model.
   * Called by put() and putBatch() after getOrCreateItemPk() so that
   * per-(item, model) indexing status is always kept current.
   */
  private async upsertItemModel(itemPk: number, m: {
    modelId: string; indexedAt: string; contentHash: string;
    wasTruncated?: boolean; pagesIndexed?: number; pagesTotal?: number;
  }): Promise<void> {
    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.item_models
        (item_pk, model_id, indexed_at, content_hash, was_truncated, pages_indexed, pages_total)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `, [itemPk, m.modelId, m.indexedAt, m.contentHash,
        m.wasTruncated ? 1 : 0, m.pagesIndexed ?? 0, m.pagesTotal ?? 0]);
  }

  /**
   * Check whether an item is indexed by stable identity.
   */
  async isIndexedByIdentity(libraryKey: string, itemKey: string): Promise<boolean> {
    await this.ensureInit();
    try {
      const result = await Zotero.DB.valueQueryAsync(
        `SELECT 1 FROM ${DB_NAME}.items
         WHERE library_key = ? AND item_key = ? LIMIT 1`,
        [libraryKey, itemKey]
      );
      return result === 1;
    } catch (e) {
      this.logger.error(`isIndexedByIdentity(${libraryKey}, ${itemKey}): ${e}`);
      return false;
    }
  }

  async getChunkCountByIdentity(libraryKey: string, itemKey: string): Promise<number> {
    await this.ensureInit();
    try {
      const result = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks c
        INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk
        WHERE i.library_key = ? AND i.item_key = ?
      `, [libraryKey, itemKey]);
      return Number(result) || 0;
    } catch (e) {
      return 0;
    }
  }

  async needsReindexByIdentity(libraryKey: string, itemKey: string, contentHash: string): Promise<boolean> {
    await this.ensureInit();
    const stored = await Zotero.DB.valueQueryAsync(
      `SELECT content_hash FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [libraryKey, itemKey]
    );
    if (!stored) return true;          // not indexed at all
    return String(stored) !== contentHash;
  }

  /**
   * Store a paper embedding (single chunk).
   *
   * Requires stable identity (libraryKey + itemKey) on the embedding.
   */
  async put(embedding: PaperEmbedding): Promise<void> {
    await this.ensureInit();

    if (!embedding.libraryKey || !embedding.itemKey) {
      throw new Error(`put: embedding missing libraryKey/itemKey identity`);
    }

    const itemPk = await this.getOrCreateItemPk({
      libraryKey: embedding.libraryKey,
      itemKey: embedding.itemKey,
      title: embedding.title,
      abstract: embedding.abstract,
      modelId: embedding.modelId,
      indexedAt: embedding.indexedAt,
      contentHash: embedding.contentHash,
      wasTruncated: embedding.wasTruncated,
      pagesIndexed: embedding.pagesIndexed,
      pagesTotal: embedding.pagesTotal,
    });

    const embeddingStr = this.embeddingToBase64(embedding.embedding);
    const chunkIndex = embedding.chunkIndex ?? 0;

    await this.upsertItemModel(itemPk, {
      modelId: embedding.modelId, indexedAt: embedding.indexedAt, contentHash: embedding.contentHash,
      wasTruncated: embedding.wasTruncated, pagesIndexed: embedding.pagesIndexed, pagesTotal: embedding.pagesTotal,
    });

    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.chunks
      (item_pk, chunk_index, model_id, chunk_text, text_source, embedding,
       page_number, paragraph_index, start_char, end_char, bbox)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      itemPk, chunkIndex, embedding.modelId,
      embedding.chunkText || null,
      embedding.textSource,
      embeddingStr,
      embedding.pageNumber ?? null,
      embedding.paragraphIndex ?? null,
      embedding.startChar ?? null,
      embedding.endChar ?? null,
      embedding.bbox ?? null,
    ]);

    this.logger.debug(`Stored chunk for (${embedding.libraryKey}, ${embedding.itemKey}) idx=${chunkIndex}`);
    this.invalidateCache();
  }

  /**
   * Store multiple embeddings in a batch using transaction.
   *
   * Resolves all unique (libraryKey, itemKey) identities to item_pks first
   * (dedup'd in-process), then writes chunks pointing at those pks.
   */
  async putBatch(embeddings: PaperEmbedding[]): Promise<void> {
    await this.ensureInit();
    if (embeddings.length === 0) return;

    this.logger.info(`Storing ${embeddings.length} embeddings...`);
    const idents = new Set(embeddings.map(e => `${e.libraryKey}|${e.itemKey}`));
    this.logger.info(`Storing embeddings for ${idents.size} unique items`);

    const withLocation = embeddings.filter(e => e.pageNumber != null).length;
    if (withLocation > 0) {
      this.logger.info(`${withLocation}/${embeddings.length} chunks have location data`);
    }

    await Zotero.DB.executeTransaction(async () => {
      // Resolve all unique items to item_pks (insert-or-update)
      const pkByIdent = new Map<string, number>();
      const seen = new Set<string>();
      for (const e of embeddings) {
        if (!e.libraryKey || !e.itemKey) {
          throw new Error('putBatch: embedding missing libraryKey/itemKey');
        }
        const key = `${e.libraryKey}|${e.itemKey}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const pk = await this.getOrCreateItemPk({
          libraryKey: e.libraryKey,
          itemKey: e.itemKey,
          title: e.title,
          abstract: e.abstract,
          modelId: e.modelId,
          indexedAt: e.indexedAt,
          contentHash: e.contentHash,
          wasTruncated: e.wasTruncated,
          pagesIndexed: e.pagesIndexed,
          pagesTotal: e.pagesTotal,
        });
        await this.upsertItemModel(pk, {
          modelId: e.modelId, indexedAt: e.indexedAt, contentHash: e.contentHash,
          wasTruncated: e.wasTruncated, pagesIndexed: e.pagesIndexed, pagesTotal: e.pagesTotal,
        });
        pkByIdent.set(key, pk);
      }

      // Write chunks
      for (const embedding of embeddings) {
        const key = `${embedding.libraryKey}|${embedding.itemKey}`;
        const itemPk = pkByIdent.get(key);
        if (!itemPk) throw new Error(`putBatch: lost pk for ${key}`); // defensive
        const embeddingStr = this.embeddingToBase64(embedding.embedding);
        const chunkIndex = embedding.chunkIndex ?? 0;

        await Zotero.DB.queryAsync(`
          INSERT OR REPLACE INTO ${DB_NAME}.chunks
          (item_pk, chunk_index, model_id, chunk_text, text_source, embedding,
           page_number, paragraph_index, start_char, end_char, bbox)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          itemPk, chunkIndex, embedding.modelId,
          embedding.chunkText || null,
          embedding.textSource,
          embeddingStr,
          embedding.pageNumber ?? null,
          embedding.paragraphIndex ?? null,
          embedding.startChar ?? null,
          embedding.endChar ?? null,
          embedding.bbox ?? null,
        ]);
      }
    });

    this.logger.info(`Stored ${embeddings.length} embeddings`);

    // Verification log only — not a correctness check
    const verifyRows = await Zotero.DB.queryAsync(
      `SELECT COUNT(*) as count FROM ${DB_NAME}.chunks`
    );
    this.logger.info(`Table now has ${verifyRows?.[0]?.count || 0} total embedding chunks`);
    this.invalidateCache();
  }

  /**
   * Delete all chunks AND the item row for a given stable identity.
   * No-op if the item is not indexed.
   *
   * SQLite foreign-key enforcement is OFF by default in Zotero's DB
   * connection, so we cannot rely on `ON DELETE CASCADE`. We delete
   * chunks explicitly inside a transaction.
   */
  async deleteItem(libraryKey: string, itemKey: string): Promise<void> {
    await this.ensureInit();

    const pk = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [libraryKey, itemKey]
    );
    if (!pk || Number(pk) <= 0) {
      this.logger.debug(`deleteItem: no item for (${libraryKey}, ${itemKey})`);
      return;
    }

    await Zotero.DB.executeTransaction(async () => {
      await Zotero.DB.queryAsync(
        `DELETE FROM ${DB_NAME}.chunks WHERE item_pk = ?`,
        [Number(pk)]
      );
      await Zotero.DB.queryAsync(
        `DELETE FROM ${DB_NAME}.item_models WHERE item_pk = ?`,
        [Number(pk)]
      );
      await Zotero.DB.queryAsync(
        `DELETE FROM ${DB_NAME}.items WHERE item_pk = ?`,
        [Number(pk)]
      );
      await Zotero.DB.queryAsync(
        `DELETE FROM ${DB_NAME}.orphan_items WHERE item_pk = ?`,
        [Number(pk)]
      );
    });

    this.logger.debug(`Deleted item (${libraryKey}, ${itemKey})`);
    this.invalidateCache();
  }

  /**
   * Delete only the chunks for an item, preserving the items row.
   * When modelId is provided, scopes the delete to that model only so
   * re-indexing one model does not wipe other models' chunks.
   * When omitted, deletes all chunks for the item (original behaviour).
   */
  async deleteChunksForItem(libraryKey: string, itemKey: string, modelId?: string): Promise<void> {
    await this.ensureInit();
    const pk = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [libraryKey, itemKey]
    );
    if (!pk || Number(pk) <= 0) return;
    await Zotero.DB.executeTransaction(async () => {
      if (modelId) {
        await Zotero.DB.queryAsync(
          `DELETE FROM ${DB_NAME}.chunks WHERE item_pk = ? AND model_id = ?`, [Number(pk), modelId]);
        await Zotero.DB.queryAsync(
          `DELETE FROM ${DB_NAME}.item_models WHERE item_pk = ? AND model_id = ?`, [Number(pk), modelId]);
      } else {
        // No model given: fully unindex the item, so drop its item_models rows too
        // (otherwise getCoverage would still count it as covered with no chunks left).
        await Zotero.DB.queryAsync(
          `DELETE FROM ${DB_NAME}.chunks WHERE item_pk = ?`,
          [Number(pk)]
        );
        await Zotero.DB.queryAsync(
          `DELETE FROM ${DB_NAME}.item_models WHERE item_pk = ?`,
          [Number(pk)]
        );
      }
    });
    this.invalidateCache();
  }

  /** @deprecated Use deleteItem(libraryKey, itemKey). Resolves identity via the resolver. */
  async delete(itemId: number): Promise<void> {
    await this.ensureInit();
    const item = Zotero.Items.get(itemId);
    if (!item) {
      this.logger.warn(`delete(${itemId}): item not in Zotero`);
      return;
    }
    const id = identityFromItem(item);
    if (!id) return;
    return this.deleteItem(id.libraryKey, id.itemKey);
  }

  /** @deprecated Use deleteChunksForItem(libraryKey, itemKey). */
  async deleteItemChunks(itemId: number, modelId?: string): Promise<void> {
    const item = Zotero.Items.get(itemId);
    if (!item) return;
    const id = identityFromItem(item);
    if (!id) return;
    return this.deleteChunksForItem(id.libraryKey, id.itemKey, modelId);
  }

  /**
   * Return items in the store that have no coverage for the given modelId.
   * Uses parallel columnQueryAsync calls (Zotero multi-column quirk).
   */
  async getItemsMissingModel(modelId: string): Promise<Array<{ libraryKey: string; itemKey: string }>> {
    await this.ensureInit();
    const [libraryKeys, itemKeys] = await Promise.all([
      Zotero.DB.columnQueryAsync(`
        SELECT i.library_key FROM ${DB_NAME}.items i
        WHERE i.library_key != 'orphan'
          AND NOT EXISTS (SELECT 1 FROM ${DB_NAME}.item_models im WHERE im.item_pk = i.item_pk AND im.model_id = ?)
        ORDER BY i.item_pk`, [modelId]).then((r: any) => r || []),
      Zotero.DB.columnQueryAsync(`
        SELECT i.item_key FROM ${DB_NAME}.items i
        WHERE i.library_key != 'orphan'
          AND NOT EXISTS (SELECT 1 FROM ${DB_NAME}.item_models im WHERE im.item_pk = i.item_pk AND im.model_id = ?)
        ORDER BY i.item_pk`, [modelId]).then((r: any) => r || []),
    ]);
    return (libraryKeys as string[]).map((lk: string, i: number) => ({ libraryKey: lk, itemKey: (itemKeys as string[])[i] }));
  }

  /**
   * Get all chunks for a specific item by local Zotero item ID.
   * @deprecated Use getItemChunksByIdentity(libraryKey, itemKey).
   */
  async getItemChunks(itemId: number): Promise<PaperEmbedding[]> {
    const item = Zotero.Items.get(itemId);
    if (!item) return [];
    const id = identityFromItem(item);
    if (!id) return [];
    return this.getItemChunksByIdentity(id.libraryKey, id.itemKey);
  }

  /**
   * Get all chunks for a specific item by stable identity.
   * Only returns chunks for the currently active embedding model, so
   * find_similar source vectors always match the candidate model.
   */
  async getItemChunksByIdentity(libraryKey: string, itemKey: string): Promise<PaperEmbedding[]> {
    await this.ensureInit();
    const pk = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [libraryKey, itemKey]
    );
    if (!pk) return [];

    const activeModelId = getActiveModelId();
    const rawChunkIdxs = await Zotero.DB.columnQueryAsync(
      `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_pk = ? AND model_id = ? ORDER BY chunk_index`,
      [Number(pk), activeModelId]
    );
    const chunkIndexes: number[] = (rawChunkIdxs || []).map((v: any) => Number(v));

    const chunks = await Promise.all(
      chunkIndexes.map((ci: number) => this.getChunkByPk(Number(pk), ci))
    );
    return chunks.filter((c): c is PaperEmbedding => c !== undefined);
  }

  /**
   * Get the summary embedding (chunk_index=0) for a specific item.
   * @deprecated Use getByIdentity(libraryKey, itemKey).
   */
  async get(itemId: number): Promise<PaperEmbedding | undefined> {
    const item = Zotero.Items.get(itemId);
    if (!item) return undefined;
    const id = identityFromItem(item);
    if (!id) return undefined;
    return this.getByIdentity(id.libraryKey, id.itemKey);
  }

  /**
   * Get the summary chunk for an item by stable identity. Falls back to the
   * lowest-indexed chunk when no chunk_index=0 row exists.
   */
  async getByIdentity(libraryKey: string, itemKey: string): Promise<PaperEmbedding | undefined> {
    await this.ensureInit();

    const pk = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [libraryKey, itemKey]
    );
    if (!pk || Number(pk) <= 0) return undefined;

    // Prefer summary chunk (chunk_index=0); otherwise pick the smallest index
    let chunkIndex = 0;
    const hasZero = await Zotero.DB.valueQueryAsync(
      `SELECT 1 FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = 0 LIMIT 1`,
      [Number(pk)]
    );
    if (hasZero !== 1) {
      const firstChunk = await Zotero.DB.valueQueryAsync(
        `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_pk = ? ORDER BY chunk_index LIMIT 1`,
        [Number(pk)]
      );
      if (firstChunk == null) return undefined;
      chunkIndex = Number(firstChunk);
    }

    return this.getChunkByPk(Number(pk), chunkIndex);
  }

  /**
   * Get a specific chunk for an item by local Zotero item ID.
   * @deprecated Use getChunkByPk for internal callers, or getByIdentity for external callers.
   */
  async getChunk(itemId: number, chunkIndex: number): Promise<PaperEmbedding | undefined> {
    const item = Zotero.Items.get(itemId);
    if (!item) return undefined;
    const id = identityFromItem(item);
    if (!id) return undefined;
    const pk = await Zotero.DB.valueQueryAsync(
      `SELECT item_pk FROM ${DB_NAME}.items WHERE library_key = ? AND item_key = ?`,
      [id.libraryKey, id.itemKey]
    );
    if (!pk) return undefined;
    return this.getChunkByPk(Number(pk), chunkIndex);
  }

  /**
   * Internal: fetch a chunk by item_pk + chunk_index, joined with items.
   * Uses parallel valueQueryAsync calls - most reliable method in Zotero 8.
   *
   * All chunk-table reads are scoped to the ACTIVE model so that find_similar
   * source vectors always come from the same model as the candidate set.
   * If the active-model chunk does not exist, returns undefined (the item has
   * not been indexed with the active model yet).
   */
  private async getChunkByPk(itemPk: number, chunkIndex: number): Promise<PaperEmbedding | undefined> {
    await this.ensureInit();
    try {
      const activeModelId = getActiveModelId();
      const [
        library_key, item_key, title, indexed_at, content_hash, abstract,
        text_source, chunk_text, embedding,
        page_number, paragraph_index, start_char, end_char, bbox
      ] = await Promise.all([
        Zotero.DB.valueQueryAsync(`SELECT library_key FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT item_key FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT title FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT abstract FROM ${DB_NAME}.items WHERE item_pk = ?`, [itemPk]),
        Zotero.DB.valueQueryAsync(`SELECT text_source FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT chunk_text FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT embedding FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT page_number FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT paragraph_index FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT start_char FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT end_char FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
        Zotero.DB.valueQueryAsync(`SELECT bbox FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ? AND model_id = ?`, [itemPk, chunkIndex, activeModelId]),
      ]);

      if (!library_key || !item_key || !embedding) return undefined;

      return this.rowToEmbedding({
        itemPk,
        libraryKey: library_key,
        itemKey: item_key,
        title: title || '',
        abstract,
        modelId: activeModelId,
        indexedAt: indexed_at || '',
        contentHash: content_hash || '',
        chunkIndex,
        chunkText: chunk_text,
        textSource: text_source || 'abstract',
        embedding,
        pageNumber: page_number,
        paragraphIndex: paragraph_index,
        startChar: start_char,
        endChar: end_char,
        bbox,
      });
    } catch (e) {
      this.logger.error(`getChunkByPk(${itemPk}, ${chunkIndex}): ${e}`);
      return undefined;
    }
  }

  /**
   * Batch-fetch chunk text for a set of (item_pk, chunk_index) pairs.
   *
   * Returns a map keyed by `${itemPk}:${chunkIndex}` -> chunk_text. Used to
   * enrich the small set of visible search results with a snippet, without
   * loading chunk text into the global embedding cache. Missing/empty chunks
   * are simply absent from the returned map.
   */
  async getChunkTexts(
    pairs: Array<{ itemPk: number; chunkIndex: number }>
  ): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    if (pairs.length === 0) return out;
    await this.ensureInit();

    // De-duplicate pairs (same chunk can back several results in some modes).
    const unique = new Map<string, { itemPk: number; chunkIndex: number }>();
    for (const p of pairs) unique.set(`${p.itemPk}:${p.chunkIndex}`, p);

    // Parallel single-value queries dodge the Zotero 8 multi-column SELECT quirk
    // (see CLAUDE.md). The batch is bounded by topK (~20-50), so this is cheap.
    const entries = Array.from(unique.values());
    const texts = await Promise.all(
      entries.map(p =>
        Zotero.DB.valueQueryAsync(
          `SELECT chunk_text FROM ${DB_NAME}.chunks WHERE item_pk = ? AND chunk_index = ?`,
          [p.itemPk, p.chunkIndex]
        ).catch(() => null)
      )
    );

    entries.forEach((p, i) => {
      const t = texts[i];
      if (typeof t === 'string' && t.length > 0) {
        out.set(`${p.itemPk}:${p.chunkIndex}`, t);
      }
    });
    return out;
  }

  /**
   * Get all embeddings with in-memory caching
   * Returns cached data if available, otherwise fetches from DB and caches
   */
  async getAllCached(): Promise<Array<{
    itemPk: number;
    libraryKey: string;
    itemKey: string;
    /** @deprecated Compatibility field: current local Zotero ID, or -1 for orphans. */
    itemId?: number;
    chunkIndex: number;
    title: string;
    textSource: TextSourceType;
    modelId: string;
    embedding: Float32Array;
    pageNumber?: number;
    paragraphIndex?: number;
  }>> {
    await this.ensureInit();

    // Check if cache is valid (less than 5 minutes old)
    const now = Date.now();
    if (this.cache && (now - this.cache.validAt) < 5 * 60 * 1000) {
      this.logger.debug(`getAllCached(): Cache hit! Returning ${this.cache.data.length} cached embeddings`);
      return this.cache.data;
    }

    this.logger.debug('getAllCached(): Cache miss, fetching from database...');

    // Fetch all embeddings using the reliable getAll method
    const embeddings = await this.getAll();

    // Convert to cached format with Float32Array and pre-normalized vectors
    const cachedData = embeddings.map(e => {
      // Convert to Float32Array
      const float32Embedding = new Float32Array(e.embedding);

      // Normalize the vector for faster similarity computation
      let norm = 0;
      for (let i = 0; i < float32Embedding.length; i++) {
        norm += float32Embedding[i] * float32Embedding[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < float32Embedding.length; i++) {
          float32Embedding[i] /= norm;
        }
      }

      return {
        itemPk: e.itemPk!,
        libraryKey: e.libraryKey,
        itemKey: e.itemKey,
        itemId: e.itemId ?? -1,
        chunkIndex: e.chunkIndex,
        title: e.title,
        textSource: e.textSource,
        modelId: e.modelId,
        embedding: float32Embedding,
        pageNumber: e.pageNumber,
        paragraphIndex: e.paragraphIndex,
      };
    });

    // Cache the data
    this.cache = {
      data: cachedData,
      validAt: now,
    };

    this.logger.debug(`getAllCached(): Cached ${cachedData.length} embeddings`);
    return cachedData;
  }

  /**
   * Invalidate the in-memory cache
   */
  invalidateCache(): void {
    if (this.cache) {
      this.logger.debug('invalidateCache(): Cache invalidated');
      this.cache = null;
    }
  }

  /**
   * Get all embeddings (all chunks) by joining items+chunks on item_pk.
   * Orphans (library_key='orphan') are excluded from results, even though
   * they remain in the database.
   *
   * Local Zotero IDs are bulk-resolved at read time via the identity resolver.
   */
  async getAll(): Promise<PaperEmbedding[]> {
    await this.ensureInit();

    // Fetch all chunks joined with items in one go using parallel column queries
    // (Zotero 8 DB wrapper workaround - multi-column SELECTs are unreliable).
    let pks: number[] = [];
    let libraryKeys: string[] = [];
    let itemKeys: string[] = [];
    let titles: string[] = [];
    let abstracts: (string | null)[] = [];
    let modelIds: string[] = [];
    let indexedAts: string[] = [];
    let contentHashes: string[] = [];
    let chunkIndexes: number[] = [];
    let chunkTexts: (string | null)[] = [];
    let textSources: string[] = [];
    let embeddings: string[] = [];
    let pageNumbers: (number | null)[] = [];
    let paragraphIndexes: (number | null)[] = [];
    let startChars: (number | null)[] = [];
    let endChars: (number | null)[] = [];
    let bboxes: (string | null)[] = [];

    try {
      [
        pks, libraryKeys, itemKeys, titles, abstracts, modelIds, indexedAts, contentHashes,
        chunkIndexes, chunkTexts, textSources, embeddings,
        pageNumbers, paragraphIndexes, startChars, endChars, bboxes
      ] = await Promise.all([
        Zotero.DB.columnQueryAsync(`SELECT c.item_pk FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => (r || []).map(Number)),
        Zotero.DB.columnQueryAsync(`SELECT i.library_key FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT i.item_key FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT i.title FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT i.abstract FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.model_id FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT i.indexed_at FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT i.content_hash FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.chunk_index FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => (r || []).map(Number)),
        Zotero.DB.columnQueryAsync(`SELECT c.chunk_text FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.text_source FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.embedding FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.page_number FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.paragraph_index FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.start_char FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.end_char FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT c.bbox FROM ${DB_NAME}.chunks c INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk WHERE i.library_key != 'orphan' ORDER BY c.item_pk, c.chunk_index`).then((r: any) => r || []),
      ]);
    } catch (e) {
      this.logger.error(`getAll(): batch failed: ${e}`);
      return [];
    }

    if (pks.length === 0) {
      this.logger.debug('getAll(): No embeddings found');
      return [];
    }

    // Bulk-resolve local Zotero IDs for the embedded rows
    const identities = pks.map((_, i) => ({
      libraryKey: libraryKeys[i],
      itemKey: itemKeys[i],
    }));
    const idMap = bulkResolve(identities);

    const results: PaperEmbedding[] = [];
    for (let i = 0; i < pks.length; i++) {
      const lookupKey = `${libraryKeys[i]}|${itemKeys[i]}`;
      results.push({
        itemPk: pks[i],
        libraryKey: libraryKeys[i],
        itemKey: itemKeys[i],
        itemId: idMap.get(lookupKey),
        libraryId: localLibraryIDFromKey(libraryKeys[i]) ?? undefined,
        chunkIndex: chunkIndexes[i],
        title: titles[i] || '',
        abstract: abstracts[i] || undefined,
        chunkText: chunkTexts[i] || undefined,
        textSource: (textSources[i] as TextSourceType) || 'abstract',
        embedding: this.base64ToEmbedding(embeddings[i]),
        modelId: modelIds[i] || '',
        indexedAt: indexedAts[i] || '',
        contentHash: contentHashes[i] || '',
        pageNumber: pageNumbers[i] != null ? Number(pageNumbers[i]) : undefined,
        paragraphIndex: paragraphIndexes[i] != null ? Number(paragraphIndexes[i]) : undefined,
        startChar: startChars[i] != null ? Number(startChars[i]) : undefined,
        endChar: endChars[i] != null ? Number(endChars[i]) : undefined,
        bbox: bboxes[i] || undefined,
      });
    }

    this.logger.debug(`getAll(): returning ${results.length} embeddings`);
    return results;
  }

  /**
   * Get all chunk keys (item_id, chunk_index pairs)
   * Uses robust fallback strategy for Zotero 8 DB wrapper quirks
   */
  private async getAllChunkKeys(): Promise<Array<{ itemId: number; chunkIndex: number }>> {
    // Try the batch query first
    const rows = await Zotero.DB.queryAsync(`
      SELECT item_id, chunk_index FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index
    `);

    if (rows && rows.length > 0) {
      return rows.map((r: any) => ({ itemId: r.item_id, chunkIndex: r.chunk_index }));
    }

    // Fallback: Get item IDs first using columnQueryAsync, then get chunk indexes per item
    this.logger.debug('getAllChunkKeys(): Batch query returned empty, using fallback...');

    const itemIds = await this.getItemIdsSafe();
    if (itemIds.length === 0) {
      this.logger.debug('getAllChunkKeys(): No item IDs found');
      return [];
    }

    this.logger.debug(`getAllChunkKeys(): Found ${itemIds.length} item IDs, fetching chunk indexes...`);
    const results: Array<{ itemId: number; chunkIndex: number }> = [];

    for (const itemId of itemIds) {
      try {
        // Try columnQueryAsync first for chunk indexes of this item
        let chunkIndexes: number[] = [];

        try {
          if (Zotero.DB.columnQueryAsync) {
            const indexes = await Zotero.DB.columnQueryAsync(
              `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? ORDER BY chunk_index`,
              [itemId]
            );
            if (indexes && indexes.length > 0) {
              chunkIndexes = indexes.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
            }
          }
        } catch (e) {
          this.logger.debug(`getAllChunkKeys(): columnQueryAsync failed for item ${itemId}: ${e}`);
        }

        // Fallback: try valueQueryAsync for single chunk (most items have chunk_index = 0)
        if (chunkIndexes.length === 0) {
          const singleIndex = await Zotero.DB.valueQueryAsync(
            `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? LIMIT 1`,
            [itemId]
          );
          if (singleIndex !== null && singleIndex !== undefined) {
            chunkIndexes = [Number(singleIndex)];
          }
        }

        // Add to results
        for (const chunkIndex of chunkIndexes) {
          results.push({ itemId, chunkIndex });
        }
      } catch (e) {
        this.logger.error(`getAllChunkKeys(): Error getting chunk indexes for item ${itemId}: ${e}`);
      }
    }

    this.logger.debug(`getAllChunkKeys(): Fallback found ${results.length} chunks`);
    return results;
  }

  /**
   * Get chunk keys for a specific library (item_id, chunk_index pairs)
   * Uses robust fallback strategy for Zotero 8 DB wrapper quirks
   */
  private async getChunkKeysByLibrary(libraryId: number): Promise<Array<{ itemId: number; chunkIndex: number }>> {
    // Try the batch query first - join chunks with items for library_id filter
    const rows = await Zotero.DB.queryAsync(`
      SELECT c.item_id, c.chunk_index FROM ${DB_NAME}.chunks c
      INNER JOIN ${DB_NAME}.items i ON c.item_id = i.item_id
      WHERE i.library_id = ? ORDER BY c.item_id, c.chunk_index
    `, [libraryId]);

    if (rows && rows.length > 0) {
      return rows.map((r: any) => ({ itemId: r.item_id, chunkIndex: r.chunk_index }));
    }

    // Fallback: Get item IDs first, then get chunk indexes per item
    this.logger.debug(`getChunkKeysByLibrary(${libraryId}): Batch query returned empty, using fallback...`);

    const itemIds = await this.getItemIdsSafe('WHERE library_id = ?', [libraryId]);
    if (itemIds.length === 0) {
      this.logger.debug(`getChunkKeysByLibrary(${libraryId}): No item IDs found`);
      return [];
    }

    this.logger.debug(`getChunkKeysByLibrary(${libraryId}): Found ${itemIds.length} item IDs, fetching chunk indexes...`);
    const results: Array<{ itemId: number; chunkIndex: number }> = [];

    for (const itemId of itemIds) {
      try {
        // Try columnQueryAsync first for chunk indexes of this item
        let chunkIndexes: number[] = [];

        try {
          if (Zotero.DB.columnQueryAsync) {
            const indexes = await Zotero.DB.columnQueryAsync(
              `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? ORDER BY chunk_index`,
              [itemId]
            );
            if (indexes && indexes.length > 0) {
              chunkIndexes = indexes.map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
            }
          }
        } catch (e) {
          this.logger.debug(`getChunkKeysByLibrary(): columnQueryAsync failed for item ${itemId}: ${e}`);
        }

        // Fallback: try valueQueryAsync for single chunk
        if (chunkIndexes.length === 0) {
          const singleIndex = await Zotero.DB.valueQueryAsync(
            `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? LIMIT 1`,
            [itemId]
          );
          if (singleIndex !== null && singleIndex !== undefined) {
            chunkIndexes = [Number(singleIndex)];
          }
        }

        // Add to results
        for (const chunkIndex of chunkIndexes) {
          results.push({ itemId, chunkIndex });
        }
      } catch (e) {
        this.logger.error(`getChunkKeysByLibrary(): Error getting chunk indexes for item ${itemId}: ${e}`);
      }
    }

    this.logger.debug(`getChunkKeysByLibrary(${libraryId}): Fallback found ${results.length} chunks`);
    return results;
  }

  /**
   * Return current local Zotero itemIDs for all indexed items.
   * Items whose stable identity does not resolve to a local Zotero item
   * (orphans) are excluded.
   */
  async getUniqueItemIds(): Promise<number[]> {
    await this.ensureInit();

    let libraryKeys: string[] = [];
    let itemKeys: string[] = [];
    try {
      [libraryKeys, itemKeys] = await Promise.all([
        Zotero.DB.columnQueryAsync(
          `SELECT library_key FROM ${DB_NAME}.items WHERE library_key != 'orphan' ORDER BY item_pk`
        ).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(
          `SELECT item_key FROM ${DB_NAME}.items WHERE library_key != 'orphan' ORDER BY item_pk`
        ).then((r: any) => r || []),
      ]);
    } catch (e) {
      this.logger.error(`getUniqueItemIds(): ${e}`);
      return [];
    }

    const result: number[] = [];
    for (let i = 0; i < libraryKeys.length; i++) {
      const localID = localItemIDFromIdentity({
        libraryKey: libraryKeys[i],
        itemKey: itemKeys[i]
      });
      if (localID !== null) result.push(localID);
    }
    return result;
  }

  /**
   * Get embeddings for a specific library by local Zotero library ID.
   * Translates to library_key and delegates to getByLibraryKey.
   */
  async getByLibrary(libraryId: number): Promise<PaperEmbedding[]> {
    const libraryKey = libraryKeyFromLocalID(libraryId);
    if (!libraryKey) return [];
    return this.getByLibraryKey(libraryKey);
  }

  /**
   * Get embeddings for a specific library by stable library_key.
   *
   * Note: Implemented as a filter on getAll() for code simplicity and correctness.
   * Acceptable for libraries with <50k chunks. If profiling shows this is a
   * bottleneck, inline a library-filtered version of the getAll JOIN.
   */
  async getByLibraryKey(libraryKey: string): Promise<PaperEmbedding[]> {
    await this.ensureInit();
    const all = await this.getAll();
    return all.filter(e => e.libraryKey === libraryKey);
  }

  /** @deprecated Use isIndexedByIdentity(libraryKey, itemKey). */
  async isIndexed(itemId: number): Promise<boolean> {
    await this.ensureInit();
    const item = Zotero.Items.get(itemId);
    if (!item) return false;
    const id = identityFromItem(item);
    if (!id) return false;
    return this.isIndexedByIdentity(id.libraryKey, id.itemKey);
  }

  /** @deprecated Use getChunkCountByIdentity(libraryKey, itemKey). */
  async getChunkCount(itemId: number): Promise<number> {
    const item = Zotero.Items.get(itemId);
    if (!item) return 0;
    const id = identityFromItem(item);
    if (!id) return 0;
    return this.getChunkCountByIdentity(id.libraryKey, id.itemKey);
  }

  /**
   * Get per-item indexing status for a list of items.
   *
   * Returns a Map keyed by item_id with indexedAt / wasTruncated /
   * pagesIndexed / pagesTotal / chunkCount. Items not in the index are
   * absent from the map. Designed for the item-tree column which can be
   * called with many ids at once.
   */
  async getIndexStatusMap(itemIds: number[]): Promise<Map<number, ItemIndexStatus>> {
    const result = new Map<number, ItemIndexStatus>();
    if (itemIds.length === 0) return result;

    const identities: Array<{ libraryKey: string; itemKey: string }> = [];
    const idByLookupKey = new Map<string, number>();
    for (const id of itemIds) {
      const item = Zotero.Items.get(id);
      if (!item) continue;
      const identity = identityFromItem(item);
      if (!identity) continue;
      identities.push(identity);
      idByLookupKey.set(`${identity.libraryKey}|${identity.itemKey}`, id);
    }

    const byIdentity = await this.getIndexStatusByIdentity(identities);

    for (const [lookupKey, status] of byIdentity.entries()) {
      const itemId = idByLookupKey.get(lookupKey);
      if (itemId !== undefined) {
        result.set(itemId, { ...status, itemId });
      }
    }

    return result;
  }

  /**
   * Identity-keyed variant of {@link getIndexStatusMap}.
   *
   * Returns a Map keyed by `${libraryKey}|${itemKey}` with per-item status.
   * Status fields and chunk count are scoped to the ACTIVE embedding model:
   * - Status (indexedAt / wasTruncated / pagesIndexed / pagesTotal) comes from
   *   `item_models` for the active model.
   * - chunkCount counts only active-model chunks.
   * - Items with no `item_models` row for the active model are absent from the map
   *   (not yet indexed with this model).
   *
   * Items not in the index at all are absent from the map. Batched in groups of 200
   * using a composite OR-clause because SQLite cannot match tuples via IN.
   */
  async getIndexStatusByIdentity(
    identities: Array<{ libraryKey: string; itemKey: string }>
  ): Promise<Map<string, ItemIndexStatus>> {
    await this.ensureInit();
    const result = new Map<string, ItemIndexStatus>();
    if (identities.length === 0) return result;

    const activeModelId = getActiveModelId();
    const CHUNK = 200;
    try {
      for (let start = 0; start < identities.length; start += CHUNK) {
        const batch = identities.slice(start, start + CHUNK);

        // SQLite cannot match tuples via IN, and Zotero 8's DB wrapper
        // returns mozIStorageRow objects for multi-column SELECTs that don't
        // expose named properties. Workaround: parallel columnQueryAsync per
        // column, anchored by a stable ORDER BY (item_pk).
        const placeholders = batch.map(() => '(library_key = ? AND item_key = ?)').join(' OR ');
        const params: any[] = [];
        for (const id of batch) { params.push(id.libraryKey, id.itemKey); }

        const baseWhere = `WHERE ${placeholders} ORDER BY item_pk`;
        const [pks, libKeys, itemKeys] = await Promise.all([
          Zotero.DB.columnQueryAsync(`SELECT item_pk FROM ${DB_NAME}.items ${baseWhere}`, params),
          Zotero.DB.columnQueryAsync(`SELECT library_key FROM ${DB_NAME}.items ${baseWhere}`, params),
          Zotero.DB.columnQueryAsync(`SELECT item_key FROM ${DB_NAME}.items ${baseWhere}`, params),
        ]);

        const pkArr: number[] = (pks || []).map((v: any) => Number(v));
        if (pkArr.length === 0) continue;

        // Read per-(item, model) status from item_models for the active model.
        const imPlaceholders = pkArr.map(() => '?').join(',');
        const imParams = [...pkArr, activeModelId];
        const [imPks, imIndexedAts, imTruncs, imPIdx, imPTot] = await Promise.all([
          Zotero.DB.columnQueryAsync(
            `SELECT item_pk FROM ${DB_NAME}.item_models WHERE item_pk IN (${imPlaceholders}) AND model_id = ? ORDER BY item_pk`,
            imParams
          ),
          Zotero.DB.columnQueryAsync(
            `SELECT indexed_at FROM ${DB_NAME}.item_models WHERE item_pk IN (${imPlaceholders}) AND model_id = ? ORDER BY item_pk`,
            imParams
          ),
          Zotero.DB.columnQueryAsync(
            `SELECT was_truncated FROM ${DB_NAME}.item_models WHERE item_pk IN (${imPlaceholders}) AND model_id = ? ORDER BY item_pk`,
            imParams
          ),
          Zotero.DB.columnQueryAsync(
            `SELECT pages_indexed FROM ${DB_NAME}.item_models WHERE item_pk IN (${imPlaceholders}) AND model_id = ? ORDER BY item_pk`,
            imParams
          ),
          Zotero.DB.columnQueryAsync(
            `SELECT pages_total FROM ${DB_NAME}.item_models WHERE item_pk IN (${imPlaceholders}) AND model_id = ? ORDER BY item_pk`,
            imParams
          ),
        ]);

        // Build a map: item_pk -> active-model status.
        const itemModelMap = new Map<number, {
          indexedAt: string; wasTruncated: boolean; pagesIndexed: number; pagesTotal: number;
        }>();
        for (let i = 0; i < (imPks || []).length; i++) {
          itemModelMap.set(Number(imPks[i]), {
            indexedAt: String(imIndexedAts?.[i] ?? ''),
            wasTruncated: Number(imTruncs?.[i] ?? 0) === 1,
            pagesIndexed: Number(imPIdx?.[i] ?? 0),
            pagesTotal: Number(imPTot?.[i] ?? 0),
          });
        }

        // Build chunk-count map keyed by item_pk, scoped to the active model.
        // Only query item_pks that have an item_models row (others are un-indexed for this model).
        const coveredPkArr = pkArr.filter(pk => itemModelMap.has(pk));
        const chunkCountMap = new Map<number, number>();
        if (coveredPkArr.length > 0) {
          const chunkPlaceholders = coveredPkArr.map(() => '?').join(',');
          const chunkParams = [...coveredPkArr, activeModelId];
          const [cPks, cCounts] = await Promise.all([
            Zotero.DB.columnQueryAsync(
              `SELECT item_pk FROM ${DB_NAME}.chunks WHERE item_pk IN (${chunkPlaceholders}) AND model_id = ? GROUP BY item_pk ORDER BY item_pk`,
              chunkParams
            ),
            Zotero.DB.columnQueryAsync(
              `SELECT COUNT(*) FROM ${DB_NAME}.chunks WHERE item_pk IN (${chunkPlaceholders}) AND model_id = ? GROUP BY item_pk ORDER BY item_pk`,
              chunkParams
            ),
          ]);
          for (let i = 0; i < (cPks || []).length; i++) {
            chunkCountMap.set(Number(cPks[i]), Number(cCounts[i]) || 0);
          }
        }

        for (let i = 0; i < pkArr.length; i++) {
          const pk = pkArr[i];
          const modelStatus = itemModelMap.get(pk);
          // No item_models row for this model -> item not covered -> skip.
          if (!modelStatus) continue;
          const lk = String(libKeys?.[i] ?? '');
          const ik = String(itemKeys?.[i] ?? '');
          const key = `${lk}|${ik}`;
          result.set(key, {
            libraryKey: lk,
            itemKey: ik,
            indexedAt: modelStatus.indexedAt,
            wasTruncated: modelStatus.wasTruncated,
            pagesIndexed: modelStatus.pagesIndexed,
            pagesTotal: modelStatus.pagesTotal,
            chunkCount: chunkCountMap.get(pk) ?? 0,
          });
        }
      }
    } catch (e) {
      this.logger.error(`getIndexStatusByIdentity(): ${e}`);
    }

    return result;
  }

  /** @deprecated Use needsReindexByIdentity. */
  async needsReindex(itemId: number, contentHash: string): Promise<boolean> {
    const { identityFromItem } = await import('./identity-resolver');
    const item = Zotero.Items.get(itemId);
    if (!item) return true;
    const id = identityFromItem(item);
    if (!id) return true;
    return this.needsReindexByIdentity(id.libraryKey, id.itemKey, contentHash);
  }

  /**
   * Clear all embeddings (v9 schema): empties chunks, item_models, items, and orphan_items,
   * and resets the autoincrement counter so item_pk starts back at 1.
   */
  async clear(): Promise<void> {
    await this.ensureInit();

    await Zotero.DB.executeTransaction(async () => {
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.chunks`);
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.item_models`);
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.items`);
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.orphan_items`);
      // Reset autoincrement counter so item_pks start from 1 again.
      // sqlite_sequence is the SQLite system table; failure here is non-fatal
      // (e.g. if AUTOINCREMENT was never used), so isolate the error.
      try {
        await Zotero.DB.queryAsync(
          `DELETE FROM ${DB_NAME}.sqlite_sequence WHERE name IN ('items')`
        );
      } catch (e) {
        this.logger.warn(`clear(): could not reset sqlite_sequence: ${e}`);
      }
    });
    this.invalidateCache();
    this.logger.info('Cleared all embeddings (v9 schema)');
  }

  /**
   * Get count of stored embedding chunks (excludes chunks belonging to
   * orphaned items so the figure matches what search will actually see).
   */
  async getCount(): Promise<number> {
    if (!this.initialized) return 0;

    try {
      const v = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks c
        INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk
        WHERE i.library_key != 'orphan'
      `);
      return Number(v) || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get count of unique items (papers), excluding orphans.
   */
  async getItemCount(): Promise<number> {
    if (!this.initialized) return 0;

    try {
      const v = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.items WHERE library_key != 'orphan'
      `);
      return Number(v) || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Return coverage for a specific model: how many non-orphan items have at
   * least one chunk indexed by that model vs. total non-orphan items.
   */
  async getCoverage(modelId: string): Promise<{ covered: number; total: number }> {
    await this.ensureInit();
    const total = Number(await Zotero.DB.valueQueryAsync(
      `SELECT COUNT(*) FROM ${DB_NAME}.items WHERE library_key != 'orphan'`));
    const covered = Number(await Zotero.DB.valueQueryAsync(
      `SELECT COUNT(DISTINCT im.item_pk) FROM ${DB_NAME}.item_models im
       JOIN ${DB_NAME}.items i ON im.item_pk = i.item_pk
       WHERE i.library_key != 'orphan' AND im.model_id = ?`, [modelId]));
    return { covered, total };
  }

  /**
   * Delete all chunks and item_models rows for a given model, leaving the
   * items identity rows intact. Returns the count of chunks deleted.
   */
  async deleteModelEmbeddings(modelId: string): Promise<number> {
    await this.ensureInit();
    let deleted = 0;
    await Zotero.DB.executeTransaction(async () => {
      deleted = Number(await Zotero.DB.valueQueryAsync(
        `SELECT COUNT(*) FROM ${DB_NAME}.chunks WHERE model_id = ?`, [modelId]));
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.chunks WHERE model_id = ?`, [modelId]);
      await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.item_models WHERE model_id = ?`, [modelId]);
    });
    this.invalidateCache();
    return deleted;
  }

  /**
   * Get store statistics
   * Uses robust fallbacks for Zotero 8 DB wrapper quirks
   */
  async getStats(): Promise<VectorStoreStats> {
    await this.ensureInit();

    this.logger.debug('getStats(): Fetching statistics...');

    // Count total chunks (excluding chunks owned by orphan items so the
    // user-visible totals match what search actually returns).
    let chunkCount = 0;
    try {
      const countResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks c
        INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk
        WHERE i.library_key != 'orphan'
      `);
      chunkCount = Number(countResult) || 0;
      this.logger.debug(`getStats(): Total chunks = ${chunkCount}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to count chunks: ${e}`);
    }

    // Count unique items (papers), excluding orphans.
    let itemCount = 0;
    try {
      const itemCountResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.items WHERE library_key != 'orphan'
      `);
      itemCount = Number(itemCountResult) || 0;
      this.logger.debug(`getStats(): Unique items = ${itemCount}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to count items: ${e}`);
    }

    // Report the currently active model (from preferences), not a stale
    // items.model_id value which holds the legacy hfPath string.
    const modelId = getActiveModelId();
    this.logger.debug(`getStats(): Model = ${modelId}`);

    // Get last indexed date among live (non-orphan) items.
    let lastIndexed: Date | null = null;
    try {
      const lastResult = await Zotero.DB.valueQueryAsync(`
        SELECT MAX(indexed_at) FROM ${DB_NAME}.items WHERE library_key != 'orphan'
      `);
      if (lastResult) {
        lastIndexed = new Date(String(lastResult));
      }
      this.logger.debug(`getStats(): Last indexed = ${lastIndexed}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to get last indexed: ${e}`);
    }

    // Get actual storage size from file
    let storageUsedBytes = 0;
    try {
      const dbPath = this.getDbPath();
      const fileInfo = await IOUtils.stat(dbPath);
      storageUsedBytes = fileInfo.size;
    } catch (e) {
      // Fallback to estimation if file stat fails
      this.logger.warn(`getStats(): Could not stat database file: ${e}`);
      storageUsedBytes = chunkCount * (768 * 4 + 200);
    }
    const avgChunksPerPaper = itemCount > 0 ? chunkCount / itemCount : 0;

    // Count chunks with location data (v4 feature), excluding orphans so the
    // coverage percent matches the chunkCount denominator above.
    let chunksWithLocation = 0;
    try {
      const locationResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks c
        INNER JOIN ${DB_NAME}.items i ON c.item_pk = i.item_pk
        WHERE c.page_number IS NOT NULL AND i.library_key != 'orphan'
      `);
      chunksWithLocation = Number(locationResult) || 0;
      this.logger.debug(`getStats(): Chunks with location = ${chunksWithLocation}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to count chunks with location: ${e}`);
    }

    const locationCoveragePercent = chunkCount > 0
      ? Math.round((chunksWithLocation / chunkCount) * 100)
      : 0;

    const stats: VectorStoreStats = {
      totalPapers: 0,
      indexedPapers: itemCount,
      totalChunks: chunkCount,
      avgChunksPerPaper: Math.round(avgChunksPerPaper * 10) / 10,
      modelId,
      lastIndexed,
      storageUsedBytes,
      // Location coverage (v4)
      chunksWithLocation,
      locationCoveragePercent,
    };

    this.logger.debug(`getStats(): Returning stats: ${JSON.stringify({...stats, lastIndexed: stats.lastIndexed?.toISOString()})}`);
    return stats;
  }

  /**
   * Get metadata value
   */
  async getMetadata(key: string): Promise<any> {
    await this.ensureInit();

    const rows = await Zotero.DB.queryAsync(`
      SELECT value FROM ${DB_NAME}.metadata WHERE key = ?
    `, [key]);

    if (!rows || rows.length === 0) return undefined;

    try {
      return JSON.parse(rows[0].value);
    } catch {
      return rows[0].value;
    }
  }

  /**
   * Set metadata value
   */
  async setMetadata(key: string, value: any): Promise<void> {
    await this.ensureInit();

    const stringValue = typeof value === 'string' ? value : JSON.stringify(value);

    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.metadata (key, value) VALUES (?, ?)
    `, [key, stringValue]);
  }

  /**
   * Ensure store is initialized
   */
  private async ensureInit(): Promise<void> {
    if (!this.initialized) {
      await this.init();
      return;
    }

    // Already initialized, but Zotero may have recycled its DB connection
    // mid-session and silently dropped our ATTACHed database. Verify the
    // attachment is still live and re-establish it if not, so a long indexing
    // run survives connection recycling instead of failing on every remaining
    // item with `no such table: zotseek.items` (issue #35).
    //
    // Skip while inside a Zotero transaction: ATTACH/DETACH is illegal there,
    // and public methods always call ensureInit() before opening one, so the
    // attachment is already verified for the duration of the transaction.
    if (Zotero.DB.inTransaction && Zotero.DB.inTransaction()) return;

    if (!(await this.isAttachmentLive())) {
      await this.reattachAfterConnectionLoss();
    }
  }

  /**
   * Check if store is ready
   */
  isReady(): boolean {
    return this.initialized;
  }

  /**
   * Close the vector store and detach the database
   */
  async close(): Promise<void> {
    this.invalidateCache();
    await this.detachDatabase();
    this.initialized = false;
    this.logger.debug('SQLite store closed');
  }

  /**
   * Compact the database to reclaim unused space.
   * Uses VACUUM INTO to create a compacted copy, then replaces the original.
   * This is necessary because SQLite VACUUM doesn't work on ATTACHed databases.
   */
  async compactDatabase(): Promise<{ beforeBytes: number; afterBytes: number }> {
    await this.ensureInit();

    const dbPath = this.getDbPath();
    const tempPath = dbPath + '.compact';

    // Get size before
    const beforeInfo = await IOUtils.stat(dbPath);
    const beforeBytes = beforeInfo.size;

    this.logger.info(`Compacting database (current size: ${beforeBytes} bytes)...`);

    try {
      // VACUUM INTO creates a fresh, compacted copy
      // Note: VACUUM INTO does not support parameter binding in SQLite's grammar
      const safePath = tempPath.replace(/'/g, "''");
      await Zotero.DB.queryAsync(`VACUUM ${DB_NAME} INTO '${safePath}'`);

      // Detach current database
      await Zotero.DB.queryAsync(`DETACH DATABASE ${DB_NAME}`);
      this.attached = false;

      // Replace original with compacted copy
      await IOUtils.move(tempPath, dbPath);

      // Re-attach
      await this.attachDatabase();

      // Get size after
      const afterInfo = await IOUtils.stat(dbPath);
      const afterBytes = afterInfo.size;

      this.logger.info(
        `Database compacted: ${beforeBytes} -> ${afterBytes} bytes ` +
        `(saved ${beforeBytes - afterBytes} bytes, ${Math.round((1 - afterBytes / beforeBytes) * 100)}%)`
      );

      this.invalidateCache();
      return { beforeBytes, afterBytes };
    } catch (error: any) {
      // Clean up temp file if it exists
      try { await IOUtils.remove(tempPath); } catch (e) { /* ignore */ }
      this.logger.error(`Compaction failed: ${error?.message || error}`);
      throw error;
    }
  }

  /**
   * Delete the database file (for uninstall cleanup)
   * Should be called after detaching the database
   */
  async deleteDatabase(): Promise<void> {
    const dbPath = this.getDbPath();
    this.logger.info(`Deleting database file: ${dbPath}`);

    try {
      // Make sure database is detached first
      await this.detachDatabase();

      // Delete the database file
      await IOUtils.remove(dbPath, { ignoreAbsent: true });
      this.logger.info('Database file deleted successfully');
    } catch (error: any) {
      this.logger.error(`Failed to delete database file: ${error?.message || error}`);
    }
  }

  /**
   * Get the database file path (for external use)
   */
  getDatabasePath(): string {
    return this.getDbPath();
  }

  /**
   * Bytes that would be reclaimed by VACUUM. Reads the SQLite freelist
   * (pages marked free by DROP/DELETE that the file still holds onto until
   * VACUUM rewrites the database).
   */
  async getReclaimableBytes(): Promise<number> {
    await this.ensureInit();
    try {
      const pageSize = await Zotero.DB.valueQueryAsync(`PRAGMA ${DB_NAME}.page_size`);
      const freelistCount = await Zotero.DB.valueQueryAsync(`PRAGMA ${DB_NAME}.freelist_count`);
      return Number(pageSize) * Number(freelistCount);
    } catch (e: any) {
      this.logger.warn(`getReclaimableBytes failed: ${e?.message || e}`);
      return 0;
    }
  }
}

// Export singleton
export const vectorStoreSQLite = new VectorStoreSQLite();
