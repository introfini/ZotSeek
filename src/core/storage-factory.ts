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

  // Identity-keyed methods (preferred)
  putBatch(embeddings: import('./vector-store-sqlite').PaperEmbedding[]): Promise<void>;
  put(embedding: import('./vector-store-sqlite').PaperEmbedding): Promise<void>;
  getByIdentity(libraryKey: string, itemKey: string): Promise<import('./vector-store-sqlite').PaperEmbedding | undefined>;
  getItemChunksByIdentity(libraryKey: string, itemKey: string): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  deleteItem(libraryKey: string, itemKey: string): Promise<void>;
  deleteChunksForItem(libraryKey: string, itemKey: string, modelId?: string): Promise<void>;
  isIndexedByIdentity(libraryKey: string, itemKey: string): Promise<boolean>;
  needsReindexByIdentity(libraryKey: string, itemKey: string, contentHash: string): Promise<boolean>;
  getChunkCountByIdentity(libraryKey: string, itemKey: string): Promise<number>;
  getIndexStatusByIdentity(identities: Array<{libraryKey: string; itemKey: string}>): Promise<Map<string, import('./vector-store-sqlite').ItemIndexStatus>>;
  getByLibraryKey(libraryKey: string): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;

  // Legacy id-keyed methods (deprecated, kept until call sites migrate)
  get(itemId: number): Promise<import('./vector-store-sqlite').PaperEmbedding | undefined>;
  getItemChunks(itemId: number): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  deleteItemChunks(itemId: number, modelId?: string): Promise<void>;
  delete(itemId: number): Promise<void>;
  isIndexed(itemId: number): Promise<boolean>;
  needsReindex(itemId: number, contentHash: string): Promise<boolean>;
  getIndexStatusMap(itemIds: number[]): Promise<Map<number, import('./vector-store-sqlite').ItemIndexStatus>>;
  getByLibrary(libraryId: number): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;

  // Model-scoped helpers
  getItemsMissingModel(modelId: string): Promise<Array<{ libraryKey: string; itemKey: string }>>;

  // Bulk / housekeeping
  getAll(): Promise<import('./vector-store-sqlite').PaperEmbedding[]>;
  getUniqueItemIds(): Promise<number[]>;
  clear(): Promise<void>;
  getStats(): Promise<import('./vector-store-sqlite').VectorStoreStats>;
  getMetadata(key: string): Promise<any>;
  setMetadata(key: string, value: any): Promise<void>;
  isReady(): boolean;
  close(): Promise<void>;
  deleteDatabase(): Promise<void>;
  getDatabasePath(): string;
}

/**
 * Get the vector store (SQLite-based)
 */
export function getVectorStore(): IVectorStore {
  return vectorStoreSQLite as IVectorStore;
}
