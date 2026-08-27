/**
 * Search Engine - Semantic search using cosine similarity
 * 
 * Supports multi-chunk documents with MaxSim aggregation:
 * - Each document may have multiple embedding chunks
 * - Search returns the max similarity across all chunks per document
 * - This ensures that matching any part of a document ranks it highly
 */

import { Logger } from '../utils/logger';
import { PaperEmbedding, IVectorStore, getVectorStore } from './storage-factory';
import { VectorStoreSQLite, TextSourceType } from './vector-store-sqlite';
import { EmbeddingPipeline, embeddingPipeline } from './embedding-pipeline';
import { identityFromItem } from './identity-resolver';
import { getActiveModelId } from './model-registry';
import { bestChunkPerItem, ChunkMatch } from './keyword-backfill';
import { trackSearch } from './search-activity';

declare const Zotero: any;

export interface SearchResult {
  // Stable identity (always present)
  itemPk: number;              // Internal surrogate PK; stable within DB lifetime, useful for de-dup
  libraryKey: string;          // 'user' | 'group:<groupID>' | 'orphan' (only if explicitly requested)
  itemKey: string;             // Zotero 8-char key, stable across machines

  // Resolved local convenience (may be undefined for orphans)
  itemId?: number;             // Current Zotero.Item.id resolved at read time
  libraryId?: number;          // Current local library ID resolved at read time

  title: string;
  similarity: number;          // 0-1 cosine similarity (max across chunks, or per-chunk if returnAllChunks)
  textSource: TextSourceType;  // Section type: summary, methods, findings, content
  matchedChunkIndex?: number;  // Which chunk had the highest similarity
  chunkIndex?: number;         // Chunk index (when returnAllChunks=true)
  chunkText?: string;          // Text of the matched chunk (populated for top results only, for snippet display)
  authors?: string[];          // Optional: author names for display
  year?: number;               // Optional: publication year for display
  pageNumber?: number;         // 1-based page number of matched chunk
  paragraphIndex?: number;     // 0-based paragraph index within page
}

export interface SearchOptions {
  topK?: number;
  minSimilarity?: number;
  libraryId?: number;
  excludeItemIds?: number[];
  returnAllChunks?: boolean;  // If true, return all matching chunks instead of MaxSim aggregation
  /**
   * Pre-computed, L2-normalized query vector. Lets a caller that already
   * embedded the query (hybrid search, which reuses it to back-fill its keyword
   * leg) skip a second inference — a whole extra HTTP round trip on a
   * server-backed model.
   */
  queryEmbedding?: Float32Array;
}

const DEFAULT_OPTIONS: Required<Omit<SearchOptions, 'libraryId' | 'excludeItemIds' | 'queryEmbedding'>> = {
  topK: 20,
  minSimilarity: 0.3,
  returnAllChunks: false,
};

/**
 * Internal structure for MaxSim aggregation
 */
interface ItemSimilarity {
  itemPk: number;
  libraryKey: string;
  itemKey: string;
  itemId?: number;
  libraryId?: number;
  title: string;
  textSource: TextSourceType;
  maxSimilarity: number;
  matchedChunkIndex: number;
  pageNumber?: number;
  paragraphIndex?: number;
}

export class SearchEngine {
  private store: IVectorStore | null = null;
  private pipeline: EmbeddingPipeline;
  private logger: Logger;

  constructor(pipeline: EmbeddingPipeline = embeddingPipeline) {
    this.pipeline = pipeline;
    this.logger = new Logger('SearchEngine');
  }

  /**
   * Initialize the search engine (pipeline and store)
   */
  async init(): Promise<void> {
    this.logger.info('Initializing search engine...');
    
    // Initialize embedding pipeline if needed
    if (!this.pipeline.isReady()) {
      this.logger.info('Initializing embedding pipeline...');
      await this.pipeline.init();
    }
    
    // Initialize vector store if needed
    const store = this.getStore();
    if (!store.isReady()) {
      this.logger.info('Initializing vector store...');
      await store.init();
    }
    
    this.logger.info('Search engine initialized');
  }

  /**
   * Check if the search engine is ready
   */
  isReady(): boolean {
    return this.pipeline.isReady();
  }

  /**
   * Get the vector store (lazy initialization)
   */
  private getStore(): IVectorStore {
    if (!this.store) {
      this.store = getVectorStore();
    }
    return this.store;
  }

  /**
   * Search for papers similar to a query string
   * Uses MaxSim aggregation: returns max similarity across all chunks per document
   */
  async search(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    return trackSearch(() => this.searchInternal(query, options));
  }

  private async searchInternal(query: string, options: SearchOptions = {}): Promise<SearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.logger.info(`Searching for: "${query.substring(0, 50)}..."`);
    const startTime = Date.now();

    const queryFloat32 = opts.queryEmbedding ?? (await this.embedQueryNormalized(query));

    let embeddings = await this.loadCandidateEmbeddings(opts.libraryId);

    // Filter out excluded items (by resolved local itemId; orphans are never excluded here)
    if (opts.excludeItemIds && opts.excludeItemIds.length > 0) {
      const excludeSet = new Set(opts.excludeItemIds);
      embeddings = embeddings.filter(
        e => e.itemId === undefined || e.itemId < 0 || !excludeSet.has(e.itemId)
      );
    }

    // Compute results: either all chunks or MaxSim aggregation
    let results: SearchResult[];
    if (opts.returnAllChunks) {
      // Return all matching chunks (for location/paragraph-level results)
      results = this.computeAllChunkResultsFloat32(queryFloat32, embeddings, opts.minSimilarity);
    } else {
      // Use MaxSim aggregation (one result per document with best chunk)
      results = this.computeMaxSimResultsFloat32(queryFloat32, embeddings, opts.minSimilarity);
    }

    // Sort by similarity (descending) and take top K
    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, opts.topK);

    // Enrich the visible results with the matched chunk's text (for snippet display).
    // Only the top K rows need it, so this is a small, bounded batch fetch — we
    // deliberately keep chunk_text out of the in-memory embedding cache to avoid
    // bloating RAM on large libraries.
    await this.populateChunkText(topResults);

    const searchTime = Date.now() - startTime;
    this.logger.info(`Found ${topResults.length} results in ${searchTime}ms`);

    return topResults;
  }

  /**
   * Find papers similar to a given paper, by local Zotero item ID.
   *
   * Resolves the local item to its stable identity (libraryKey + itemKey) and
   * delegates to {@link findSimilarByIdentity}. Prefer the identity-keyed
   * method for any code path that already has stable identity in hand.
   */
  async findSimilar(itemId: number, options: SearchOptions = {}): Promise<SearchResult[]> {
    const item = Zotero.Items.get(itemId);
    if (!item) {
      throw new Error(`findSimilar: item ${itemId} not in Zotero`);
    }
    const identity = identityFromItem(item);
    if (!identity) {
      throw new Error(`findSimilar: unable to resolve identity for item ${itemId}`);
    }
    return this.findSimilarByIdentity(identity.libraryKey, identity.itemKey, options);
  }

  /**
   * Find papers similar to a source paper identified by (libraryKey, itemKey).
   * Uses MaxSim aggregation: returns max similarity across all chunks per document.
   *
   * This is the identity-keyed entry point for "similar documents". Source paper
   * lookups go through the identity-keyed store API; callers don't need a live
   * Zotero item.
   */
  async findSimilarByIdentity(
    libraryKey: string,
    itemKey: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    return trackSearch(() => this.findSimilarByIdentityInternal(libraryKey, itemKey, options));
  }

  private async findSimilarByIdentityInternal(
    libraryKey: string,
    itemKey: string,
    options: SearchOptions = {}
  ): Promise<SearchResult[]> {
    this.logger.info(`Finding papers similar to (${libraryKey}, ${itemKey})`);

    const store = this.getStore();

    // Ensure store is initialized
    if (!store.isReady()) {
      this.logger.info('Store not ready, initializing...');
      await store.init();
    }

    // Get all chunks for the source paper via identity
    const sourceChunks = await store.getItemChunksByIdentity(libraryKey, itemKey);
    if (!sourceChunks || sourceChunks.length === 0) {
      // Fall back to single get-by-identity
      const sourcePaper = await store.getByIdentity(libraryKey, itemKey);
      if (!sourcePaper) {
        throw new Error(`Paper (${libraryKey}, ${itemKey}) not indexed`);
      }
      if (!sourcePaper.embedding || sourcePaper.embedding.length === 0) {
        throw new Error(`Paper (${libraryKey}, ${itemKey}) has invalid embedding data`);
      }
      return this.findSimilarWithEmbedding(
        sourcePaper.embedding,
        libraryKey,
        itemKey,
        sourcePaper.itemId,
        options
      );
    }

    // Validate source chunks
    const validSourceChunks = sourceChunks.filter(c =>
      c.embedding && Array.isArray(c.embedding) && c.embedding.length > 0
    );

    if (validSourceChunks.length === 0) {
      throw new Error(`Paper (${libraryKey}, ${itemKey}) has no valid embedding chunks`);
    }

    this.logger.debug(`Source paper has ${validSourceChunks.length} valid chunks`);

    // Resolve source itemId (may be undefined for orphans — in which case we
    // can't exclude self by itemId, but the identity match below covers it).
    const sourceItemId = sourceChunks[0].itemId;
    const excludeItemIds =
      sourceItemId !== undefined && sourceItemId >= 0
        ? [...(options.excludeItemIds || []), sourceItemId]
        : [...(options.excludeItemIds || [])];
    const opts = { ...DEFAULT_OPTIONS, ...options, excludeItemIds };

    // Get cached embeddings for fast similarity computation
    let embeddings: Array<{
      itemPk: number;
      libraryKey: string;
      itemKey: string;
      itemId?: number;
      libraryId?: number;
      chunkIndex: number;
      title: string;
      textSource: TextSourceType;
      modelId: string;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>;

    if (opts.libraryId !== undefined) {
      // For library-specific search, convert to cached format
      const paperEmbeddings = await store.getByLibrary(opts.libraryId);
      embeddings = paperEmbeddings.map(e => {
        const float32Embedding = new Float32Array(e.embedding);
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
          itemId: e.itemId,
          libraryId: e.libraryId,
          chunkIndex: e.chunkIndex,
          title: e.title,
          textSource: e.textSource,
          modelId: e.modelId,
          embedding: float32Embedding,
          pageNumber: e.pageNumber,
          paragraphIndex: e.paragraphIndex,
        };
      });
    } else {
      // Use cached embeddings (SQLite with in-memory cache)
      embeddings = await (store as VectorStoreSQLite).getAllCached();
    }

    // Filter candidates to only those indexed by the currently active embedding model.
    // This prevents dimension mismatches when the user switches models.
    const activeModelId = getActiveModelId();
    embeddings = embeddings.filter((e: any) => e.modelId === activeModelId);

    this.logger.info(`Retrieved ${embeddings.length} embedding chunks from store`);

    // Filter out the source paper by identity (covers both orphan and live cases)
    // and any excluded itemIds.
    const excludeSet = new Set(excludeItemIds);
    embeddings = embeddings.filter(e => {
      if (e.libraryKey === libraryKey && e.itemKey === itemKey) return false;
      if (e.itemId !== undefined && e.itemId >= 0 && excludeSet.has(e.itemId)) return false;
      return true;
    });

    // Filter out invalid embeddings (shouldn't happen with cached data)
    const validEmbeddings = embeddings.filter(e => e.embedding && e.embedding.length > 0);

    // Convert source chunks to normalized Float32Arrays
    const sourceFloat32Chunks = validSourceChunks.map(chunk => {
      const float32 = new Float32Array(chunk.embedding);
      let norm = 0;
      for (let i = 0; i < float32.length; i++) {
        norm += float32[i] * float32[i];
      }
      norm = Math.sqrt(norm);
      if (norm > 0) {
        for (let i = 0; i < float32.length; i++) {
          float32[i] /= norm;
        }
      }
      return float32;
    });

    // For multi-chunk source, use the maximum similarity from any source chunk
    // to any target chunk (MaxSim on both sides). Key by itemPk so orphans
    // (which have no itemId) participate correctly.
    const itemResults = new Map<number, ItemSimilarity>();

    for (const targetChunk of validEmbeddings) {
      let maxSim = 0;
      for (const sourceFloat32 of sourceFloat32Chunks) {
        const sim = this.dotProductFloat32(sourceFloat32, targetChunk.embedding);
        if (sim > maxSim) {
          maxSim = sim;
        }
      }

      const existing = itemResults.get(targetChunk.itemPk);
      if (!existing || maxSim > existing.maxSimilarity) {
        itemResults.set(targetChunk.itemPk, {
          itemPk: targetChunk.itemPk,
          libraryKey: targetChunk.libraryKey,
          itemKey: targetChunk.itemKey,
          itemId: targetChunk.itemId,
          libraryId: targetChunk.libraryId,
          title: targetChunk.title,
          textSource: targetChunk.textSource,
          maxSimilarity: maxSim,
          matchedChunkIndex: targetChunk.chunkIndex ?? 0,
        });
      }
    }

    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= opts.minSimilarity) {
        results.push({
          itemPk: item.itemPk,
          libraryKey: item.libraryKey,
          itemKey: item.itemKey,
          itemId: item.itemId,
          libraryId: item.libraryId,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
        });
      }
    }

    results.sort((a, b) => b.similarity - a.similarity);
    const topResults = results.slice(0, opts.topK);

    this.logger.info(`Found ${topResults.length} similar papers`);

    return topResults;
  }

  /**
   * Find similar papers using a single embedding (legacy single-chunk path).
   * Source identity is required so we can exclude the source row by identity,
   * not just itemId (orphans have no itemId).
   */
  private async findSimilarWithEmbedding(
    sourceEmbedding: number[],
    sourceLibraryKey: string,
    sourceItemKey: string,
    sourceItemId: number | undefined,
    options: SearchOptions
  ): Promise<SearchResult[]> {
    const store = this.getStore();
    const opts = { ...DEFAULT_OPTIONS, ...options };
    const excludeItemIds =
      sourceItemId !== undefined && sourceItemId >= 0
        ? [...(options.excludeItemIds || []), sourceItemId]
        : [...(options.excludeItemIds || [])];

    // Get all embeddings
    let embeddings: PaperEmbedding[];
    if (opts.libraryId !== undefined) {
      embeddings = await store.getByLibrary(opts.libraryId);
    } else {
      embeddings = await store.getAll();
    }

    // Filter out source paper by identity, plus any excluded itemIds.
    const excludeSet = new Set(excludeItemIds);
    embeddings = embeddings.filter(e => {
      if (e.libraryKey === sourceLibraryKey && e.itemKey === sourceItemKey) return false;
      if (e.itemId !== undefined && excludeSet.has(e.itemId)) return false;
      return true;
    });

    // Filter valid embeddings
    const validEmbeddings = embeddings.filter(e =>
      e.embedding && Array.isArray(e.embedding) && e.embedding.length > 0
    );

    // Use MaxSim aggregation
    const results = this.computeMaxSimResults(sourceEmbedding, validEmbeddings, opts.minSimilarity);

    // Sort and return top K
    results.sort((a, b) => b.similarity - a.similarity);
    return results.slice(0, opts.topK);
  }

  /**
   * Compute MaxSim results: max similarity per item across all its chunks.
   * Keys by itemPk so orphans (without itemId) participate correctly.
   */
  private computeMaxSimResults(
    queryEmbedding: number[],
    embeddings: PaperEmbedding[],
    minSimilarity: number
  ): SearchResult[] {
    const itemResults = new Map<number, ItemSimilarity>();

    for (const chunk of embeddings) {
      if (!chunk.embedding || !Array.isArray(chunk.embedding) || chunk.embedding.length === 0) {
        continue;
      }
      if (chunk.itemPk === undefined) {
        // Defensive: cannot key without surrogate PK
        continue;
      }

      const similarity = this.cosineSimilarity(queryEmbedding, chunk.embedding);

      const existing = itemResults.get(chunk.itemPk);
      if (!existing || similarity > existing.maxSimilarity) {
        itemResults.set(chunk.itemPk, {
          itemPk: chunk.itemPk,
          libraryKey: chunk.libraryKey,
          itemKey: chunk.itemKey,
          itemId: chunk.itemId,
          libraryId: chunk.libraryId,
          title: chunk.title,
          textSource: chunk.textSource,
          maxSimilarity: similarity,
          matchedChunkIndex: chunk.chunkIndex ?? 0,
        });
      }
    }

    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= minSimilarity) {
        results.push({
          itemPk: item.itemPk,
          libraryKey: item.libraryKey,
          itemKey: item.itemKey,
          itemId: item.itemId,
          libraryId: item.libraryId,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
        });
      }
    }

    return results;
  }

  /**
   * Compute cosine similarity between two vectors
   */
  private cosineSimilarity(a: number[], b: number[]): number {
    // Defensive checks
    if (!a || !Array.isArray(a)) {
      this.logger.error(`cosineSimilarity: vector 'a' is invalid: ${typeof a}`);
      return 0;
    }
    if (!b || !Array.isArray(b)) {
      this.logger.error(`cosineSimilarity: vector 'b' is invalid: ${typeof b}`);
      return 0;
    }
    if (a.length === 0 || b.length === 0) {
      return 0;
    }
    if (a.length !== b.length) {
      this.logger.error(`Vectors must have the same length (a=${a.length}, b=${b.length})`);
      return 0;
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }

    normA = Math.sqrt(normA);
    normB = Math.sqrt(normB);

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (normA * normB);
  }

  /**
   * Compute MaxSim results with Float32Array for optimal performance
   * Expects pre-normalized vectors for fast dot product computation
   */
  private computeMaxSimResultsFloat32(
    queryEmbedding: Float32Array,
    embeddings: Array<{
      itemPk: number;
      libraryKey: string;
      itemKey: string;
      itemId?: number;
      libraryId?: number;
      chunkIndex: number;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>,
    minSimilarity: number
  ): SearchResult[] {
    const itemResults = new Map<number, ItemSimilarity>();

    for (const chunk of embeddings) {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        continue;
      }

      // Since both vectors are normalized, dot product = cosine similarity
      const similarity = this.dotProductFloat32(queryEmbedding, chunk.embedding);

      // MaxSim: keep only the highest similarity per item (keyed by itemPk)
      const existing = itemResults.get(chunk.itemPk);
      if (!existing || similarity > existing.maxSimilarity) {
        itemResults.set(chunk.itemPk, {
          itemPk: chunk.itemPk,
          libraryKey: chunk.libraryKey,
          itemKey: chunk.itemKey,
          itemId: chunk.itemId,
          libraryId: chunk.libraryId,
          title: chunk.title,
          textSource: chunk.textSource,
          maxSimilarity: similarity,
          matchedChunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          paragraphIndex: chunk.paragraphIndex,
        });
      }
    }

    const results: SearchResult[] = [];
    for (const item of itemResults.values()) {
      if (item.maxSimilarity >= minSimilarity) {
        results.push({
          itemPk: item.itemPk,
          libraryKey: item.libraryKey,
          itemKey: item.itemKey,
          itemId: item.itemId,
          libraryId: item.libraryId,
          title: item.title,
          similarity: item.maxSimilarity,
          textSource: item.textSource,
          matchedChunkIndex: item.matchedChunkIndex,
          pageNumber: item.pageNumber,
          paragraphIndex: item.paragraphIndex,
        });
      }
    }

    return results;
  }

  /**
   * Compute ALL chunk results (no aggregation) with Float32Array
   * Returns every matching chunk with its individual score and location
   * Used for "By Location" mode in parent-child retrieval
   */
  private computeAllChunkResultsFloat32(
    queryEmbedding: Float32Array,
    embeddings: Array<{
      itemPk: number;
      libraryKey: string;
      itemKey: string;
      itemId?: number;
      libraryId?: number;
      chunkIndex: number;
      title: string;
      textSource: TextSourceType;
      embedding: Float32Array;
      pageNumber?: number;
      paragraphIndex?: number;
    }>,
    minSimilarity: number
  ): SearchResult[] {
    const results: SearchResult[] = [];

    for (const chunk of embeddings) {
      if (!chunk.embedding || chunk.embedding.length === 0) {
        continue;
      }

      // Since both vectors are normalized, dot product = cosine similarity
      const similarity = this.dotProductFloat32(queryEmbedding, chunk.embedding);

      if (similarity >= minSimilarity) {
        results.push({
          itemPk: chunk.itemPk,
          libraryKey: chunk.libraryKey,
          itemKey: chunk.itemKey,
          itemId: chunk.itemId,
          libraryId: chunk.libraryId,
          title: chunk.title,
          similarity,
          textSource: chunk.textSource,
          chunkIndex: chunk.chunkIndex,
          matchedChunkIndex: chunk.chunkIndex,
          pageNumber: chunk.pageNumber,
          paragraphIndex: chunk.paragraphIndex,
        });
      }
    }

    return results;
  }

  /**
   * Load every chunk vector eligible for scoring, L2-normalized and restricted
   * to the active embedding model (mixing models would compare vectors of
   * different dimensions).
   *
   * Global searches read the in-memory cache; a library-scoped search reads
   * that library's rows, which the cache does not partition.
   */
  private async loadCandidateEmbeddings(libraryId?: number): Promise<Array<{
    itemPk: number;
    libraryKey: string;
    itemKey: string;
    itemId?: number;
    libraryId?: number;
    chunkIndex: number;
    title: string;
    textSource: TextSourceType;
    modelId: string;
    embedding: Float32Array;
    pageNumber?: number;
    paragraphIndex?: number;
  }>> {
    const store = this.getStore();
    let embeddings;

    if (libraryId !== undefined) {
      // For library-specific search, we still need to use the non-cached method
      // Convert to the cached format
      const paperEmbeddings = await store.getByLibrary(libraryId);
      embeddings = paperEmbeddings.map(e => {
        const float32Embedding = new Float32Array(e.embedding);
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
          itemId: e.itemId,
          libraryId: e.libraryId,
          chunkIndex: e.chunkIndex,
          title: e.title,
          textSource: e.textSource,
          modelId: e.modelId,
          embedding: float32Embedding,
          pageNumber: e.pageNumber,
          paragraphIndex: e.paragraphIndex,
        };
      });
    } else {
      // Use cached embeddings for global search (SQLite with in-memory cache)
      embeddings = await (store as VectorStoreSQLite).getAllCached();
    }

    // Filter candidates to only those indexed by the currently active embedding model.
    // This prevents dimension mismatches when the user switches models.
    const activeModelId = getActiveModelId();
    return embeddings.filter((e: any) => e.modelId === activeModelId);
  }

  /**
   * Embed a search query and return it L2-normalized, so a dot product against
   * a stored chunk vector is the cosine similarity.
   */
  async embedQueryNormalized(query: string): Promise<Float32Array> {
    // Auto-initialize pipeline if needed (supports cold-start from API)
    if (!this.pipeline.isReady()) {
      this.logger.info('Auto-initializing embedding pipeline for search...');
      await this.pipeline.init();
    }

    // Use embedQuery for search queries (applies search_query: prefix)
    const { embedding } = await this.pipeline.embedQuery(query);

    const vector = new Float32Array(embedding);
    let norm = 0;
    for (let i = 0; i < vector.length; i++) {
      norm += vector[i] * vector[i];
    }
    norm = Math.sqrt(norm);
    if (norm > 0) {
      for (let i = 0; i < vector.length; i++) {
        vector[i] /= norm;
      }
    }
    return vector;
  }

  /**
   * Score a specific set of items against an already-embedded query, returning
   * each item's closest chunk (MaxSim). No threshold is applied: the caller
   * decides what to do with a low score, and an item missing from the result
   * means it has no chunks under the active model at all.
   *
   * This exists for hybrid search's keyword leg, whose hits arrive with no
   * vector attached (issue #44). It reads the same in-memory embedding cache
   * the semantic leg used, so it costs a dot product per chunk of the requested
   * items and touches neither the model nor the database.
   */
  async scoreItems(
    queryEmbedding: Float32Array,
    itemIds: number[],
    options: { libraryId?: number } = {}
  ): Promise<Map<number, ChunkMatch>> {
    if (itemIds.length === 0) return new Map();
    return trackSearch(() => this.scoreItemsInternal(queryEmbedding, itemIds, options));
  }

  private async scoreItemsInternal(
    queryEmbedding: Float32Array,
    itemIds: number[],
    options: { libraryId?: number }
  ): Promise<Map<number, ChunkMatch>> {

    const wanted = new Set(itemIds);
    const embeddings = await this.loadCandidateEmbeddings(options.libraryId);
    const candidates = embeddings.filter(e => e.itemId !== undefined && wanted.has(e.itemId));

    return bestChunkPerItem(queryEmbedding, candidates, wanted);
  }

  /**
   * Batch-fetch chunk texts by (itemPk, chunkIndex). Best-effort: a store that
   * cannot serve them yields an empty map rather than failing the search.
   */
  async fetchChunkTexts(
    pairs: Array<{ itemPk: number; chunkIndex: number }>
  ): Promise<Map<string, string>> {
    if (pairs.length === 0) return new Map();
    const store = this.getStore();
    if (typeof (store as VectorStoreSQLite).getChunkTexts !== 'function') return new Map();
    try {
      return await trackSearch(() => (store as VectorStoreSQLite).getChunkTexts(pairs));
    } catch (e) {
      this.logger.debug(`fetchChunkTexts failed (non-fatal): ${e}`);
      return new Map();
    }
  }

  /**
   * Fill in `chunkText` on the given results by batch-fetching the matched
   * chunk's text from the store. Best-effort: failures leave chunkText
   * undefined (the UI simply shows no snippet for that row).
   */
  private async populateChunkText(results: SearchResult[]): Promise<void> {
    if (results.length === 0) return;

    const store = this.getStore();
    if (typeof (store as VectorStoreSQLite).getChunkTexts !== 'function') return;

    const pairs = results
      .map(r => ({ itemPk: r.itemPk, chunkIndex: r.matchedChunkIndex }))
      .filter((p): p is { itemPk: number; chunkIndex: number } => p.chunkIndex !== undefined);
    if (pairs.length === 0) return;

    try {
      const texts = await (store as VectorStoreSQLite).getChunkTexts(pairs);
      for (const r of results) {
        if (r.matchedChunkIndex === undefined) continue;
        const text = texts.get(`${r.itemPk}:${r.matchedChunkIndex}`);
        if (text) r.chunkText = text;
      }
    } catch (e) {
      this.logger.debug(`populateChunkText failed (non-fatal): ${e}`);
    }
  }

  /**
   * Optimized dot product for normalized Float32Arrays
   * Since vectors are pre-normalized, dot product equals cosine similarity
   */
  private dotProductFloat32(a: Float32Array, b: Float32Array): number {
    if (a.length !== b.length) {
      this.logger.error(`Vectors must have the same length (a=${a.length}, b=${b.length})`);
      return 0;
    }

    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }

    return dotProduct;
  }

  /**
   * Get search statistics
   */
  async getStats(): Promise<{ indexedPapers: number; modelId: string }> {
    const store = this.getStore();
    const stats = await store.getStats();
    return {
      indexedPapers: stats.indexedPapers,
      modelId: stats.modelId,
    };
  }
}

// Singleton instance
export const searchEngine = new SearchEngine();
