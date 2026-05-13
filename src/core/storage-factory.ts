/**
 * Storage Factory - Provides the SQLite vector store
 *
 * SQLite is the only supported storage backend:
 * - O(1) indexed lookups
 * - In-memory caching with pre-normalized Float32Arrays for fast search
 * - Lower memory usage (loads on demand)
 * - Atomic updates (single row INSERT/UPDATE)
 * - Uses separate database file (zotseek.sqlite) attached to Zotero's connection
 */

import { vectorStoreSQLite } from './vector-store-sqlite';

// Re-export types from SQLite store
export type { PaperEmbedding, VectorStoreStats, ItemIndexStatus } from './vector-store-sqlite';

/**
 * Storage interface that the SQLite backend implements
 */
export interface IVectorStore {
  init(): Promise<void>;
  put(embedding: import('./vector-store-sqlite').PaperEmbedding): Promise<void>;
  putBatch(embeddings: import('./vector-store-sqlite').PaperEmbedding[]): Promise<void>;
  get(itemId: number): Promise<import('./vector-store-sqlite').PaperEmbedding | undefined>;
  getItemChunks(itemId: number): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  deleteItemChunks(itemId: number): Promise<void>;
  getAll(): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  getByLibrary(libraryId: number): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  getUniqueItemIds(): Promise<number[]>;
  getIndexStatusMap(itemIds: number[]): Promise<Map<number, import('./vector-store-sqlite').ItemIndexStatus>>;
  isIndexed(itemId: number): Promise<boolean>;
  needsReindex(itemId: number, contentHash: string): Promise<boolean>;
  delete(itemId: number): Promise<void>;
  clear(): Promise<void>;
  getStats(): Promise<import('./vector-store-sqlite').VectorStoreStats>;
  getMetadata(key: string): Promise<any>;
  setMetadata(key: string, value: any): Promise<void>;
  isReady(): boolean;
  close(): Promise<void>;
  // New methods for database management
  deleteDatabase(): Promise<void>;
  getDatabasePath(): string;
}

/**
 * Get the vector store (SQLite-based)
 */
export function getVectorStore(): IVectorStore {
  return vectorStoreSQLite as IVectorStore;
}
