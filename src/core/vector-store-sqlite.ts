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
const SCHEMA_VERSION = 8;            // v8: stable identity (library_key + item_key + item_pk surrogate)

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
      itemId: number;
      chunkIndex: number;
      itemKey: string;
      title: string;
      textSource: TextSourceType;
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
    }

    await this.createIndexes();
    await this.updateSchemaVersion();

    this.logger.debug('Tables created successfully (v8)');
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
   * Store a paper embedding (single chunk)
   */
  async put(embedding: PaperEmbedding): Promise<void> {
    await this.ensureInit();

    const embeddingStr = this.embeddingToBase64(embedding.embedding);
    const chunkIndex = embedding.chunkIndex ?? 0;

    // Write item-level data
    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.items
      (item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash,
       was_truncated, pages_indexed, pages_total)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      embedding.itemId,
      embedding.itemKey,
      embedding.libraryId,
      embedding.title,
      embedding.abstract || null,
      embedding.modelId,
      embedding.indexedAt,
      embedding.contentHash,
      embedding.wasTruncated ? 1 : 0,
      embedding.pagesIndexed ?? 0,
      embedding.pagesTotal ?? 0,
    ]);

    // Write chunk-level data
    await Zotero.DB.queryAsync(`
      INSERT OR REPLACE INTO ${DB_NAME}.chunks
      (item_id, chunk_index, chunk_text, text_source, embedding, page_number, paragraph_index, start_char, end_char, bbox)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      embedding.itemId,
      chunkIndex,
      embedding.chunkText || null,
      embedding.textSource,
      embeddingStr,
      embedding.pageNumber ?? null,
      embedding.paragraphIndex ?? null,
      embedding.startChar ?? null,
      embedding.endChar ?? null,
      embedding.bbox ?? null,
    ]);

    this.logger.debug(`Stored embedding for item ${embedding.itemId} chunk ${chunkIndex}${embedding.pageNumber ? ` (p.${embedding.pageNumber})` : ''}`);
    this.invalidateCache();
  }

  /**
   * Store multiple embeddings in a batch using transaction
   */
  async putBatch(embeddings: PaperEmbedding[]): Promise<void> {
    await this.ensureInit();

    this.logger.info(`Storing ${embeddings.length} embeddings...`);
    // Log what item IDs we're storing (unique)
    const itemIds = [...new Set(embeddings.map(e => e.itemId))];
    this.logger.info(`Storing embeddings for ${itemIds.length} items: ${JSON.stringify(itemIds)}`);

    // Count how many have location data
    const withLocation = embeddings.filter(e => e.pageNumber != null).length;
    if (withLocation > 0) {
      this.logger.info(`${withLocation}/${embeddings.length} chunks have location data`);
    }

    // Use Zotero's transaction for better performance
    await Zotero.DB.executeTransaction(async () => {
      // Deduplicate item inserts - only insert once per item_id
      const insertedItems = new Set<number>();

      for (const embedding of embeddings) {
        const embeddingStr = this.embeddingToBase64(embedding.embedding);
        const chunkIndex = embedding.chunkIndex ?? 0;

        // Write item-level data (once per item)
        if (!insertedItems.has(embedding.itemId)) {
          await Zotero.DB.queryAsync(`
            INSERT OR REPLACE INTO ${DB_NAME}.items
            (item_id, item_key, library_id, title, abstract, model_id, indexed_at, content_hash,
             was_truncated, pages_indexed, pages_total)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `, [
            embedding.itemId,
            embedding.itemKey,
            embedding.libraryId,
            embedding.title,
            embedding.abstract || null,
            embedding.modelId,
            embedding.indexedAt,
            embedding.contentHash,
            embedding.wasTruncated ? 1 : 0,
            embedding.pagesIndexed ?? 0,
            embedding.pagesTotal ?? 0,
          ]);
          insertedItems.add(embedding.itemId);
        }

        // Write chunk-level data
        await Zotero.DB.queryAsync(`
          INSERT OR REPLACE INTO ${DB_NAME}.chunks
          (item_id, chunk_index, chunk_text, text_source, embedding, page_number, paragraph_index, start_char, end_char, bbox)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `, [
          embedding.itemId,
          chunkIndex,
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

    // Verify storage
    const verifyRows = await Zotero.DB.queryAsync(`SELECT COUNT(*) as count FROM ${DB_NAME}.chunks`);
    this.logger.info(`Verification: table now has ${verifyRows?.[0]?.count || 0} total embedding chunks`);
    this.invalidateCache();
  }

  /**
   * Delete all chunks for an item before re-indexing
   */
  async deleteItemChunks(itemId: number): Promise<void> {
    await this.ensureInit();

    await Zotero.DB.queryAsync(`
      DELETE FROM ${DB_NAME}.chunks WHERE item_id = ?
    `, [itemId]);
    await Zotero.DB.queryAsync(`
      DELETE FROM ${DB_NAME}.items WHERE item_id = ?
    `, [itemId]);

    this.logger.debug(`Deleted all chunks for item ${itemId}`);
    this.invalidateCache();
  }

  /**
   * Get all chunks for a specific item
   * Uses columnQueryAsync and parallel fetching for reliability
   */
  async getItemChunks(itemId: number): Promise<PaperEmbedding[]> {
    await this.ensureInit();

    // First get all chunk indexes for this item
    let chunkIndexes: number[] = [];
    try {
      const raw = await Zotero.DB.columnQueryAsync(
        `SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? ORDER BY chunk_index`,
        [itemId]
      );
      chunkIndexes = (raw || []).map((v: any) => Number(v));
    } catch (e) {
      this.logger.error(`getItemChunks(${itemId}): Failed to get chunk indexes: ${e}`);
      return [];
    }

    if (chunkIndexes.length === 0) return [];

    // Fetch all chunks in parallel
    const chunks = await Promise.all(
      chunkIndexes.map(ci => this.getChunk(itemId, ci))
    );

    return chunks.filter((c): c is PaperEmbedding => c !== undefined);
  }

  /**
   * Get the summary embedding (chunk_index=0) for a specific item - O(1) lookup
   * Note: We select specific columns instead of SELECT * because Zotero's DB
   * wrapper can have issues with SELECT * on rows with large TEXT columns.
   */
  async get(itemId: number): Promise<PaperEmbedding | undefined> {
    await this.ensureInit();

    this.logger.debug(`Getting summary embedding for item ${itemId}`);

    // Check existence first using lightweight query - safe in Zotero 8
    const checkRow = await Zotero.DB.queryAsync(`SELECT item_id FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = 0`, [itemId]);
    if (!checkRow || checkRow.length === 0) {
      // Try to get any chunk if summary doesn't exist
      const anyChunk = await Zotero.DB.queryAsync(`SELECT item_id, chunk_index FROM ${DB_NAME}.chunks WHERE item_id = ? ORDER BY chunk_index LIMIT 1`, [itemId]);
      if (!anyChunk || anyChunk.length === 0) {
        return undefined;
      }
      // Get the first available chunk
      return this.getChunk(itemId, anyChunk[0].chunk_index);
    }

    return this.getChunk(itemId, 0);
  }

  /**
   * Get a specific chunk for an item
   * Uses parallel valueQueryAsync calls - most reliable method in Zotero 8
   */
  async getChunk(itemId: number, chunkIndex: number): Promise<PaperEmbedding | undefined> {
    await this.ensureInit();

    // Use parallel valueQueryAsync calls - most reliable method in Zotero 8
    // Item-level fields from items table, chunk-level fields from chunks table
    try {
      const [
        item_key, library_id, title, model_id, indexed_at, content_hash, abstract,
        text_source, chunk_text, embedding,
        page_number, paragraph_index, start_char, end_char, bbox
      ] = await Promise.all([
        // Item-level fields (from items table)
        Zotero.DB.valueQueryAsync(`SELECT item_key FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT library_id FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT title FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT model_id FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        Zotero.DB.valueQueryAsync(`SELECT abstract FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
        // Chunk-level fields (from chunks table)
        Zotero.DB.valueQueryAsync(`SELECT text_source FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT chunk_text FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT embedding FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        // Location columns (from chunks table)
        Zotero.DB.valueQueryAsync(`SELECT page_number FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT paragraph_index FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT start_char FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT end_char FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
        Zotero.DB.valueQueryAsync(`SELECT bbox FROM ${DB_NAME}.chunks WHERE item_id = ? AND chunk_index = ?`, [itemId, chunkIndex]),
      ]);

      // Check if row exists
      if (!item_key || !embedding) {
        return undefined;
      }

      return {
        itemId,
        chunkIndex,
        itemKey: item_key,
        libraryId: Number(library_id) || 0,
        title: title || '',
        abstract: abstract || undefined,
        chunkText: chunk_text || undefined,
        textSource: (text_source as TextSourceType) || 'abstract',
        embedding: this.base64ToEmbedding(embedding),
        modelId: model_id || '',
        indexedAt: indexed_at || '',
        contentHash: content_hash || '',
        // Location fields (v4)
        pageNumber: page_number != null ? Number(page_number) : undefined,
        paragraphIndex: paragraph_index != null ? Number(paragraph_index) : undefined,
        startChar: start_char != null ? Number(start_char) : undefined,
        endChar: end_char != null ? Number(end_char) : undefined,
        bbox: bbox || undefined,
      };
    } catch (e) {
      this.logger.error(`getChunk(${itemId}, ${chunkIndex}): Failed: ${e}`);
      return undefined;
    }
  }

  /**
   * Get all embeddings with in-memory caching
   * Returns cached data if available, otherwise fetches from DB and caches
   */
  async getAllCached(): Promise<Array<{
    itemId: number;
    chunkIndex: number;
    itemKey: string;
    title: string;
    textSource: TextSourceType;
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
        itemId: e.itemId,
        chunkIndex: e.chunkIndex,
        itemKey: e.itemKey,
        title: e.title,
        textSource: e.textSource,
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
   * Get all embeddings (all chunks)
   * Uses two-table schema: fetches item data into Map, then assembles with chunk data
   */
  async getAll(): Promise<PaperEmbedding[]> {
    await this.ensureInit();

    // Step 1: Get all chunk keys from chunks table
    let chunkItemIds: number[] = [];
    let chunkIndexes: number[] = [];

    try {
      const rawIds = await Zotero.DB.columnQueryAsync(
        `SELECT item_id FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`
      );
      const rawChunks = await Zotero.DB.columnQueryAsync(
        `SELECT chunk_index FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`
      );

      if (rawIds && rawChunks && rawIds.length === rawChunks.length) {
        chunkItemIds = rawIds.map((v: any) => Number(v));
        chunkIndexes = rawChunks.map((v: any) => Number(v));
      }
    } catch (e) {
      this.logger.error(`getAll(): columnQueryAsync failed: ${e}`);
      return [];
    }

    if (chunkItemIds.length === 0) {
      this.logger.debug('getAll(): No embeddings found');
      return [];
    }

    this.logger.debug(`getAll(): Found ${chunkItemIds.length} chunks, fetching data...`);

    // Step 2: Build item metadata Map from items table
    const itemMap = new Map<number, {
      itemKey: string; libraryId: number; title: string; abstract?: string;
      modelId: string; indexedAt: string; contentHash: string;
    }>();

    try {
      const [iIds, iKeys, iLibs, iTitles, iAbstracts, iModels, iIndexedAts, iHashes] = await Promise.all([
        Zotero.DB.columnQueryAsync(`SELECT item_id FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT item_key FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT library_id FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT title FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT abstract FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT model_id FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items ORDER BY item_id`),
        Zotero.DB.columnQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items ORDER BY item_id`),
      ]);

      if (iIds) {
        for (let i = 0; i < iIds.length; i++) {
          itemMap.set(Number(iIds[i]), {
            itemKey: iKeys?.[i] || '',
            libraryId: Number(iLibs?.[i]) || 0,
            title: iTitles?.[i] || '',
            abstract: iAbstracts?.[i] || undefined,
            modelId: iModels?.[i] || '',
            indexedAt: iIndexedAts?.[i] || '',
            contentHash: iHashes?.[i] || '',
          });
        }
      }
    } catch (e) {
      this.logger.error(`getAll(): Failed to fetch item metadata: ${e}`);
      return [];
    }

    // Step 3: Fetch chunk-level columns in parallel
    let embeddings: string[] = [];
    try {
      embeddings = await Zotero.DB.columnQueryAsync(
        `SELECT embedding FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`
      ) || [];
    } catch (e) {
      this.logger.error(`getAll(): Failed to fetch embeddings column: ${e}`);
      return [];
    }

    if (embeddings.length !== chunkItemIds.length) {
      this.logger.error(`getAll(): Embedding count mismatch: ${embeddings.length} vs ${chunkItemIds.length}`);
      return [];
    }

    const [textSources, chunkTexts, pageNumbers, paragraphIndexes, startChars, endChars, bboxes] = await Promise.all([
      Zotero.DB.columnQueryAsync(`SELECT text_source FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT chunk_text FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT page_number FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT paragraph_index FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT start_char FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT end_char FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
      Zotero.DB.columnQueryAsync(`SELECT bbox FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`),
    ]);

    // Step 4: Assemble results using item Map for O(1) lookup
    const results: PaperEmbedding[] = [];
    for (let i = 0; i < chunkItemIds.length; i++) {
      const item = itemMap.get(chunkItemIds[i]);
      if (!item) {
        this.logger.debug(`getAll(): Skipping orphan chunk for item_id=${chunkItemIds[i]}`);
        continue;
      }

      results.push({
        itemId: chunkItemIds[i],
        chunkIndex: chunkIndexes[i],
        itemKey: item.itemKey,
        libraryId: item.libraryId,
        title: item.title,
        abstract: item.abstract,
        chunkText: chunkTexts?.[i] || undefined,
        textSource: (textSources?.[i] as TextSourceType) || 'abstract',
        embedding: this.base64ToEmbedding(embeddings[i]),
        modelId: item.modelId,
        indexedAt: item.indexedAt,
        contentHash: item.contentHash,
        pageNumber: pageNumbers?.[i] != null ? Number(pageNumbers[i]) : undefined,
        paragraphIndex: paragraphIndexes?.[i] != null ? Number(paragraphIndexes[i]) : undefined,
        startChar: startChars?.[i] != null ? Number(startChars[i]) : undefined,
        endChar: endChars?.[i] != null ? Number(endChars[i]) : undefined,
        bbox: bboxes?.[i] || undefined,
      });
    }

    this.logger.debug(`getAll(): Returning ${results.length} embeddings`);
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
   * Get unique item IDs (for counting papers, not chunks)
   */
  async getUniqueItemIds(): Promise<number[]> {
    await this.ensureInit();

    try {
      if (Zotero.DB.columnQueryAsync) {
        const ids = await Zotero.DB.columnQueryAsync(`
          SELECT item_id FROM ${DB_NAME}.items ORDER BY item_id
        `);
        return (ids || []).map((v: any) => Number(v)).filter((n: number) => Number.isFinite(n));
      }
    } catch (e) {
      this.logger.debug(`getUniqueItemIds(): columnQueryAsync failed: ${e}`);
    }

    const rows = await Zotero.DB.queryAsync(`
      SELECT item_id FROM ${DB_NAME}.items ORDER BY item_id
    `);
    if (!rows) return [];
    return rows.map((r: any) => Number(r.item_id)).filter((n: number) => Number.isFinite(n));
  }

  /**
   * Get embeddings for a specific library
   * Note: We split queries to avoid DB wrapper issues.
   */
  async getByLibrary(libraryId: number): Promise<PaperEmbedding[]> {
    await this.ensureInit();

    // Step 1: Build item metadata Map for this library
    const itemMap = new Map<number, {
      itemKey: string; libraryId: number; title: string; abstract?: string;
      modelId: string; indexedAt: string; contentHash: string;
    }>();

    try {
      const [iIds, iKeys, iTitles, iAbstracts, iModels, iIndexedAts, iHashes] = await Promise.all([
        Zotero.DB.columnQueryAsync(`SELECT item_id FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT item_key FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT title FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT abstract FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT model_id FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
        Zotero.DB.columnQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items WHERE library_id = ? ORDER BY item_id`, [libraryId]),
      ]);

      if (iIds && iIds.length > 0) {
        for (let i = 0; i < iIds.length; i++) {
          itemMap.set(Number(iIds[i]), {
            itemKey: iKeys?.[i] || '',
            libraryId,
            title: iTitles?.[i] || '',
            abstract: iAbstracts?.[i] || undefined,
            modelId: iModels?.[i] || '',
            indexedAt: iIndexedAts?.[i] || '',
            contentHash: iHashes?.[i] || '',
          });
        }
      }
    } catch (e) {
      this.logger.error(`getByLibrary(${libraryId}): Failed to fetch item metadata: ${e}`);
    }

    // Zotero 8 fallback: if columnQueryAsync failed, try row-by-row
    if (itemMap.size === 0) {
      const itemIds = await this.getItemIdsSafe('WHERE library_id = ?', [libraryId]);
      if (itemIds.length === 0) return [];

      this.logger.debug(`getByLibrary(${libraryId}): Batch metadata failed, fetching ${itemIds.length} items row-by-row`);
      for (const itemId of itemIds) {
        try {
          const [item_key, title, abstract, model_id, indexed_at, content_hash] = await Promise.all([
            Zotero.DB.valueQueryAsync(`SELECT item_key FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
            Zotero.DB.valueQueryAsync(`SELECT title FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
            Zotero.DB.valueQueryAsync(`SELECT abstract FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
            Zotero.DB.valueQueryAsync(`SELECT model_id FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
            Zotero.DB.valueQueryAsync(`SELECT indexed_at FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
            Zotero.DB.valueQueryAsync(`SELECT content_hash FROM ${DB_NAME}.items WHERE item_id = ?`, [itemId]),
          ]);
          itemMap.set(itemId, {
            itemKey: item_key || '',
            libraryId,
            title: title || '',
            abstract: abstract || undefined,
            modelId: model_id || '',
            indexedAt: indexed_at || '',
            contentHash: content_hash || '',
          });
        } catch (e) {
          this.logger.error(`getByLibrary(): Error fetching item ${itemId}: ${e}`);
        }
      }
    }

    if (itemMap.size === 0) return [];

    // Step 2: Get chunks for these items using IN clause
    const itemIdList = Array.from(itemMap.keys());
    const placeholders = itemIdList.map(() => '?').join(',');

    // Fetch chunk keys and data
    let chunkItemIds: number[] = [];
    let chunkIndexes: number[] = [];
    let embeddingStrs: string[] = [];
    let textSources: string[] = [];

    try {
      [chunkItemIds, chunkIndexes, embeddingStrs, textSources] = await Promise.all([
        Zotero.DB.columnQueryAsync(`SELECT item_id FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList).then((r: any) => (r || []).map(Number)),
        Zotero.DB.columnQueryAsync(`SELECT chunk_index FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList).then((r: any) => (r || []).map(Number)),
        Zotero.DB.columnQueryAsync(`SELECT embedding FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList).then((r: any) => r || []),
        Zotero.DB.columnQueryAsync(`SELECT text_source FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList).then((r: any) => r || []),
      ]) as [number[], number[], string[], string[]];
    } catch (e) {
      this.logger.error(`getByLibrary(${libraryId}): Failed to fetch chunks: ${e}`);
    }

    if (chunkItemIds.length === 0) {
      // Fallback: use getChunkKeysByLibrary and getChunk
      const chunks = await this.getChunkKeysByLibrary(libraryId);
      if (chunks.length === 0) return [];

      this.logger.debug(`getByLibrary(${libraryId}): Chunk batch failed, fetching ${chunks.length} chunks row-by-row`);
      const results: PaperEmbedding[] = [];
      for (const { itemId, chunkIndex } of chunks) {
        const chunk = await this.getChunk(itemId, chunkIndex);
        if (chunk) results.push(chunk);
      }
      return results;
    }

    // Step 3: Assemble results
    const [chunkTexts, pageNumbers, paragraphIndexes, startChars, endChars, bboxes] = await Promise.all([
      Zotero.DB.columnQueryAsync(`SELECT chunk_text FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
      Zotero.DB.columnQueryAsync(`SELECT page_number FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
      Zotero.DB.columnQueryAsync(`SELECT paragraph_index FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
      Zotero.DB.columnQueryAsync(`SELECT start_char FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
      Zotero.DB.columnQueryAsync(`SELECT end_char FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
      Zotero.DB.columnQueryAsync(`SELECT bbox FROM ${DB_NAME}.chunks WHERE item_id IN (${placeholders}) ORDER BY item_id, chunk_index`, itemIdList),
    ]);

    const results: PaperEmbedding[] = [];
    for (let i = 0; i < chunkItemIds.length; i++) {
      const item = itemMap.get(chunkItemIds[i]);
      if (!item) continue;

      results.push({
        itemId: chunkItemIds[i],
        chunkIndex: chunkIndexes[i],
        itemKey: item.itemKey,
        libraryId: item.libraryId,
        title: item.title,
        abstract: item.abstract,
        chunkText: chunkTexts?.[i] || undefined,
        textSource: (textSources?.[i] as TextSourceType) || 'abstract',
        embedding: this.base64ToEmbedding(embeddingStrs[i]),
        modelId: item.modelId,
        indexedAt: item.indexedAt,
        contentHash: item.contentHash,
        pageNumber: pageNumbers?.[i] != null ? Number(pageNumbers[i]) : undefined,
        paragraphIndex: paragraphIndexes?.[i] != null ? Number(paragraphIndexes[i]) : undefined,
        startChar: startChars?.[i] != null ? Number(startChars[i]) : undefined,
        endChar: endChars?.[i] != null ? Number(endChars[i]) : undefined,
        bbox: bboxes?.[i] || undefined,
      });
    }

    return results;
  }

  /**
   * Get only the embedding vectors (for search) - more efficient
   */
  async getEmbeddingsOnly(): Promise<Array<{ itemId: number; embedding: number[] }>> {
    await this.ensureInit();

    // Fetch item_id and embedding from chunks table (one per chunk, not per item)
    let chunkItemIds: number[] = [];
    let embeddingStrs: string[] = [];

    try {
      const rawIds = await Zotero.DB.columnQueryAsync(
        `SELECT item_id FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`
      );
      chunkItemIds = (rawIds || []).map((v: any) => Number(v));

      embeddingStrs = await Zotero.DB.columnQueryAsync(
        `SELECT embedding FROM ${DB_NAME}.chunks ORDER BY item_id, chunk_index`
      ) || [];
    } catch (e) {
      this.logger.warn(`Failed to batch fetch embeddings only: ${e}`);
    }

    if (chunkItemIds.length === 0 || embeddingStrs.length !== chunkItemIds.length) {
      return [];
    }

    return chunkItemIds.map((id: number, i: number) => ({
      itemId: id,
      embedding: this.base64ToEmbedding(embeddingStrs[i]),
    }));
  }


  /**
   * Check if item is indexed (has at least one chunk)
   * Uses valueQueryAsync for most reliable existence check
   */
  async isIndexed(itemId: number): Promise<boolean> {
    await this.ensureInit();

    try {
      // valueQueryAsync returns the value or false/undefined if no rows
      const result = await Zotero.DB.valueQueryAsync(
        `SELECT 1 FROM ${DB_NAME}.items WHERE item_id = ? LIMIT 1`,
        [itemId]
      );
      // Must check for exact value 1, as valueQueryAsync can return false/undefined when no rows
      const isIndexed = result === 1;
      this.logger.debug(`isIndexed(${itemId}): result=${result}, type=${typeof result}, returning=${isIndexed}`);
      return isIndexed;
    } catch (e) {
      this.logger.error(`isIndexed(${itemId}): Failed: ${e}`);
      return false;
    }
  }

  /**
   * Get the number of chunks for an item
   */
  async getChunkCount(itemId: number): Promise<number> {
    await this.ensureInit();

    try {
      const rows = await Zotero.DB.queryAsync(`
        SELECT COUNT(*) as count FROM ${DB_NAME}.chunks WHERE item_id = ?
      `, [itemId]);
      return rows?.[0]?.count || 0;
    } catch (e) {
      return 0;
    }
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
    await this.ensureInit();

    // Run several columnQueryAsync calls in parallel — same workaround used
    // elsewhere in this file for the Zotero 8 DB wrapper that flakes on
    // multi-column SELECTs.
    try {
      const placeholders = itemIds.map(() => '?').join(',');
      const [ids, indexedAts, truncs, pIdx, pTot, chunkCounts] = await Promise.all([
        Zotero.DB.columnQueryAsync(
          `SELECT item_id FROM ${DB_NAME}.items WHERE item_id IN (${placeholders})`,
          itemIds
        ),
        Zotero.DB.columnQueryAsync(
          `SELECT indexed_at FROM ${DB_NAME}.items WHERE item_id IN (${placeholders}) ORDER BY item_id`,
          itemIds
        ),
        Zotero.DB.columnQueryAsync(
          `SELECT was_truncated FROM ${DB_NAME}.items WHERE item_id IN (${placeholders}) ORDER BY item_id`,
          itemIds
        ),
        Zotero.DB.columnQueryAsync(
          `SELECT pages_indexed FROM ${DB_NAME}.items WHERE item_id IN (${placeholders}) ORDER BY item_id`,
          itemIds
        ),
        Zotero.DB.columnQueryAsync(
          `SELECT pages_total FROM ${DB_NAME}.items WHERE item_id IN (${placeholders}) ORDER BY item_id`,
          itemIds
        ),
        // Chunk counts joined by item_id, ordered by item_id to align with the
        // other columns above.
        Zotero.DB.queryAsync(
          `SELECT item_id, COUNT(*) AS cnt FROM ${DB_NAME}.chunks
           WHERE item_id IN (${placeholders})
           GROUP BY item_id ORDER BY item_id`,
          itemIds
        ),
      ]);

      // Build sorted ids list as the anchor — other parallel queries are
      // already ordered by item_id so positions align.
      const sortedIds: number[] = (ids || [])
        .map((v: any) => Number(v))
        .sort((a: number, b: number) => a - b);

      // Map chunk counts by id for easy lookup
      const chunkCountMap = new Map<number, number>();
      for (const row of (chunkCounts || [])) {
        chunkCountMap.set(Number(row.item_id), Number(row.cnt) || 0);
      }

      for (let i = 0; i < sortedIds.length; i++) {
        const id = sortedIds[i];
        result.set(id, {
          itemId: id,
          indexedAt: String(indexedAts?.[i] ?? ''),
          wasTruncated: Number(truncs?.[i] ?? 0) === 1,
          pagesIndexed: Number(pIdx?.[i] ?? 0),
          pagesTotal: Number(pTot?.[i] ?? 0),
          chunkCount: chunkCountMap.get(id) ?? 0,
        });
      }
    } catch (e) {
      this.logger.error(`getIndexStatusMap(): ${e}`);
    }

    return result;
  }

  /**
   * Check if item needs re-indexing
   */
  async needsReindex(itemId: number, contentHash: string): Promise<boolean> {
    await this.ensureInit();

    const rows = await Zotero.DB.queryAsync(`
      SELECT content_hash FROM ${DB_NAME}.items WHERE item_id = ?
    `, [itemId]);

    if (!rows || rows.length === 0) return true;
    return rows[0].content_hash !== contentHash;
  }

  /**
   * Delete embedding for an item
   */
  async delete(itemId: number): Promise<void> {
    await this.ensureInit();

    await Zotero.DB.queryAsync(`
      DELETE FROM ${DB_NAME}.chunks WHERE item_id = ?
    `, [itemId]);
    await Zotero.DB.queryAsync(`
      DELETE FROM ${DB_NAME}.items WHERE item_id = ?
    `, [itemId]);

    this.logger.debug(`Deleted embedding for item ${itemId}`);
    this.invalidateCache();
  }

  /**
   * Clear all embeddings
   */
  async clear(): Promise<void> {
    await this.ensureInit();

    await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.chunks`);
    await Zotero.DB.queryAsync(`DELETE FROM ${DB_NAME}.items`);
    this.logger.info('Cleared all embeddings');
    this.invalidateCache();
  }

  /**
   * Get count of stored embedding chunks
   */
  async getCount(): Promise<number> {
    if (!this.initialized) return 0;

    try {
      const rows = await Zotero.DB.queryAsync(`
        SELECT COUNT(*) as count FROM ${DB_NAME}.chunks
      `);

      if (!rows || rows.length === 0) return 0;
      return rows[0]?.count || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get count of unique items (papers)
   */
  async getItemCount(): Promise<number> {
    if (!this.initialized) return 0;

    try {
      const rows = await Zotero.DB.queryAsync(`
        SELECT COUNT(*) as count FROM ${DB_NAME}.items
      `);

      if (!rows || rows.length === 0) return 0;
      return rows[0]?.count || 0;
    } catch (e) {
      return 0;
    }
  }

  /**
   * Get store statistics
   * Uses robust fallbacks for Zotero 8 DB wrapper quirks
   */
  async getStats(): Promise<VectorStoreStats> {
    await this.ensureInit();

    this.logger.debug('getStats(): Fetching statistics...');

    // Count total chunks - use valueQueryAsync for reliability
    let chunkCount = 0;
    try {
      const countResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks
      `);
      chunkCount = Number(countResult) || 0;
      this.logger.debug(`getStats(): Total chunks = ${chunkCount}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to count chunks: ${e}`);
    }

    // Count unique items (papers) - use valueQueryAsync
    let itemCount = 0;
    try {
      const itemCountResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.items
      `);
      itemCount = Number(itemCountResult) || 0;
      this.logger.debug(`getStats(): Unique items = ${itemCount}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to count items: ${e}`);
    }

    // Get model ID
    let modelId = 'none';
    try {
      const modelResult = await Zotero.DB.valueQueryAsync(`
        SELECT model_id FROM ${DB_NAME}.items LIMIT 1
      `);
      if (modelResult) {
        modelId = String(modelResult);
      }
      this.logger.debug(`getStats(): Model = ${modelId}`);
    } catch (e) {
      this.logger.error(`getStats(): Failed to get model: ${e}`);
    }

    // Get last indexed date
    let lastIndexed: Date | null = null;
    try {
      const lastResult = await Zotero.DB.valueQueryAsync(`
        SELECT MAX(indexed_at) FROM ${DB_NAME}.items
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

    // Count chunks with location data (v4 feature)
    let chunksWithLocation = 0;
    try {
      const locationResult = await Zotero.DB.valueQueryAsync(`
        SELECT COUNT(*) FROM ${DB_NAME}.chunks WHERE page_number IS NOT NULL
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
}

// Export singleton
export const vectorStoreSQLite = new VectorStoreSQLite();
