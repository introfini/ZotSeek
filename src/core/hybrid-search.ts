/**
 * Hybrid Search - Combines semantic search with Zotero keyword search
 *
 * Uses Reciprocal Rank Fusion (RRF) to merge results from:
 * 1. Semantic search (embedding similarity)
 * 2. Zotero's built-in quick search (keywords, metadata)
 *
 * This addresses limitations of pure semantic search:
 * - Author names: "Smith 2023" → keyword search finds the author
 * - Acronyms: "RLHF" → keyword matches exact term
 * - Technical terms: "p < 0.05" → keyword captures exact notation
 * - Zotero metadata: tags, collections, item types
 */

import { Logger } from '../utils/logger';
import { SearchEngine, SearchResult } from './search-engine';
import { TextSourceType } from './vector-store-sqlite';
import { applyMinSimilarity, ChunkMatch } from './keyword-backfill';

declare const Zotero: any;

export interface HybridSearchResult {
  itemId: number;
  itemKey: string;
  title: string;
  creators: string;
  year: number;

  // Scores from different sources
  semanticScore: number | null;    // Cosine similarity (0-1)
  keywordScore: number | null;     // Normalized keyword relevance

  // Combined score
  rrfScore: number;                // RRF combined score

  // Rank information (for debugging/display)
  semanticRank: number | null;
  keywordRank: number | null;

  // Source indicator: 'both' | 'semantic' | 'keyword'
  source: 'both' | 'semantic' | 'keyword';

  // Original text source from semantic search (e.g., 'methods', 'findings', 'summary')
  textSource?: TextSourceType;

  // Chunk identification (for all-chunks mode)
  chunkIndex?: number;        // Chunk index within the item

  // Text of the matched chunk (top results only) — for snippet display on hover
  chunkText?: string;

  // Location information from matched chunk
  pageNumber?: number;        // 1-based page number
  paragraphIndex?: number;    // 0-based paragraph index within page

  // Multi-query scores (for tooltip display in multi-query search)
  queryScores?: number[];     // Individual scores from each query
}

export interface HybridSearchOptions {
  // How many results to fetch from each source before fusion
  semanticTopK?: number;      // Default: 50
  keywordTopK?: number;       // Default: 50

  // Final results limit
  finalTopK?: number;         // Default: 20

  // RRF constant (higher = more weight to lower ranks)
  rrfK?: number;              // Default: 60

  // Minimum semantic similarity to include
  minSimilarity?: number;     // Default: 0.3

  // Weight balance (0 = keyword only, 1 = semantic only)
  semanticWeight?: number;    // Default: 0.5 (equal weight)

  // Scope
  collectionId?: number;      // Limit to collection
  libraryId?: number;         // Limit to library

  // Search mode override
  mode?: 'hybrid' | 'semantic' | 'keyword';

  // Return all chunks instead of MaxSim aggregation (for location-level results)
  returnAllChunks?: boolean;  // Default: false
}

const DEFAULT_OPTIONS: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> = {
  semanticTopK: 50,
  keywordTopK: 50,
  finalTopK: 20,
  rrfK: 60,
  minSimilarity: 0.3,
  semanticWeight: 0.5,
  returnAllChunks: false,
};

export interface QueryAnalysis {
  semanticWeight: number;
  reasoning: string;
  detectedPatterns: string[];
}

/**
 * Hybrid Search Engine
 * Combines semantic and keyword search using Reciprocal Rank Fusion
 */
export class HybridSearchEngine {
  private logger: Logger;
  private semanticSearch: SearchEngine;

  constructor(semanticSearchEngine: SearchEngine) {
    this.logger = new Logger('HybridSearch');
    this.semanticSearch = semanticSearchEngine;
  }

  /**
   * Perform hybrid search combining semantic and keyword results
   */
  async search(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    const opts = { ...DEFAULT_OPTIONS, ...options };

    this.logger.info(`Hybrid search: "${query.substring(0, 50)}${query.length > 50 ? '...' : ''}"`);

    // Handle mode overrides
    if (opts.mode === 'semantic') {
      return this.semanticOnlySearch(query, opts);
    } else if (opts.mode === 'keyword') {
      return this.keywordOnlySearch(query, opts);
    }

    // Embed the query once. The semantic leg needs it, and so does the keyword
    // back-fill below; embedding twice would double the inference cost.
    const queryEmbedding = await this.semanticSearch.embedQueryNormalized(query);

    // Run both searches in parallel
    const [semanticResults, keywordResults] = await Promise.all([
      this.semanticSearchQuery(query, opts, queryEmbedding),
      this.keywordSearchQuery(query, opts),
    ]);

    this.logger.info(`Got ${semanticResults.length} semantic, ${keywordResults.length} keyword results`);

    // Fuse results using RRF
    const fusedResults = this.reciprocalRankFusion(
      semanticResults,
      keywordResults,
      opts
    );

    // Give the keyword-only hits the similarity and the chunk they arrived
    // without, so the threshold below applies to the whole set instead of
    // half of it (issue #44).
    const backfilled = await this.backfillKeywordHits(fusedResults, queryEmbedding, opts);

    const kept = applyMinSimilarity(fusedResults, opts.minSimilarity);
    const top = kept.slice(0, opts.finalTopK);

    await Promise.all([
      this.populateItemMetadata(top),
      this.populateBackfilledChunkText(top, backfilled),
    ]);

    return top;
  }

  /**
   * Give keyword-only hits the similarity and location they arrived without.
   *
   * Zotero's quick search matches at item level, so its hits carry no chunk and
   * no score. That left `minSimilarity` gating only the semantic leg, and left
   * those results with nothing citable (issue #44). The item is indexed and the
   * query is already embedded, so recovering both is a cosine over that item's
   * own chunks, read from the cache the semantic leg just used.
   *
   * Runs over the whole fused set rather than the top K, because the scores it
   * produces are what the threshold is applied to next. Items with no chunks
   * under the active model stay unscored and are exempt from the threshold.
   *
   * @returns the matched chunk per item ID, for the chunk-text fetch afterwards.
   */
  private async backfillKeywordHits(
    results: HybridSearchResult[],
    queryEmbedding: Float32Array,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> & HybridSearchOptions
  ): Promise<Map<number, ChunkMatch>> {
    const needing = results.filter(
      r => r.semanticScore === null && typeof r.itemId === 'number' && r.itemId > 0
    );
    if (needing.length === 0) return new Map();

    let matches: Map<number, ChunkMatch>;
    try {
      matches = await this.semanticSearch.scoreItems(
        queryEmbedding,
        needing.map(r => r.itemId),
        { libraryId: opts.libraryId }
      );
    } catch (e) {
      // A failed back-fill must not fail the search: results simply stay as
      // they were before the fix.
      this.logger.error('Keyword back-fill failed:', e);
      return new Map();
    }

    for (const result of needing) {
      const match = matches.get(result.itemId);
      if (!match) continue;
      result.semanticScore = match.similarity;
      result.chunkIndex = match.chunkIndex;
      if (match.textSource !== undefined) result.textSource = match.textSource;
      if (match.pageNumber !== undefined) result.pageNumber = match.pageNumber;
      if (match.paragraphIndex !== undefined) result.paragraphIndex = match.paragraphIndex;
    }

    this.logger.info(`Back-filled ${matches.size}/${needing.length} keyword-only hits`);
    return matches;
  }

  /**
   * Fetch the chunk text for back-filled results, so they have a snippet to
   * show and an agent has something to quote.
   *
   * Deliberately runs after the threshold and the top-K slice: chunk text is one
   * query per row, and only the rows actually being returned need it.
   */
  private async populateBackfilledChunkText(
    results: HybridSearchResult[],
    matches: Map<number, ChunkMatch>
  ): Promise<void> {
    if (matches.size === 0) return;

    const pending: Array<{ result: HybridSearchResult; itemPk: number; chunkIndex: number }> = [];
    for (const result of results) {
      if (result.chunkText) continue;
      const match = matches.get(result.itemId);
      if (!match || match.itemPk === undefined) continue;
      pending.push({ result, itemPk: match.itemPk, chunkIndex: match.chunkIndex });
    }
    if (pending.length === 0) return;

    const texts = await this.semanticSearch.fetchChunkTexts(
      pending.map(p => ({ itemPk: p.itemPk, chunkIndex: p.chunkIndex }))
    );
    for (const p of pending) {
      const text = texts.get(`${p.itemPk}:${p.chunkIndex}`);
      if (text) p.result.chunkText = text;
    }
  }

  /**
   * Semantic-only search (converts to HybridSearchResult format)
   */
  private async semanticOnlySearch(
    query: string,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> & HybridSearchOptions
  ): Promise<HybridSearchResult[]> {
    const results = await this.semanticSearchQuery(query, opts);

    const hybridResults: HybridSearchResult[] = results.map((r, index) => ({
      itemId: r.itemId,
      itemKey: '',
      title: '',
      creators: '',
      year: 0,
      semanticScore: r.score,
      keywordScore: null,
      rrfScore: r.score, // Use raw score for semantic-only
      semanticRank: index + 1,
      keywordRank: null,
      source: 'semantic' as const,
      textSource: r.textSource,
      chunkIndex: r.chunkIndex,
      chunkText: r.chunkText,
      pageNumber: r.pageNumber,
      paragraphIndex: r.paragraphIndex,
    }));

    await this.populateItemMetadata(hybridResults.slice(0, opts.finalTopK));
    return hybridResults.slice(0, opts.finalTopK);
  }

  /**
   * Keyword-only search (converts to HybridSearchResult format)
   */
  private async keywordOnlySearch(
    query: string,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> & HybridSearchOptions
  ): Promise<HybridSearchResult[]> {
    const results = await this.keywordSearchQuery(query, opts);

    const hybridResults: HybridSearchResult[] = results.map((r, index) => ({
      itemId: r.itemId,
      itemKey: '',
      title: '',
      creators: '',
      year: 0,
      semanticScore: null,
      keywordScore: r.score,
      rrfScore: r.score, // Use raw score for keyword-only
      semanticRank: null,
      keywordRank: index + 1,
      source: 'keyword' as const,
    }));

    await this.populateItemMetadata(hybridResults.slice(0, opts.finalTopK));
    return hybridResults.slice(0, opts.finalTopK);
  }

  /**
   * Semantic search using embeddings
   */
  private async semanticSearchQuery(
    query: string,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> & HybridSearchOptions,
    queryEmbedding?: Float32Array
  ): Promise<Array<{ itemId: number; score: number; textSource?: TextSourceType; chunkIndex?: number; chunkText?: string; pageNumber?: number; paragraphIndex?: number }>> {
    try {
      // Initialize search engine if needed
      if (!this.semanticSearch.isReady()) {
        await this.semanticSearch.init();
      }

      const results = await this.semanticSearch.search(query, {
        topK: opts.returnAllChunks ? opts.semanticTopK * 3 : opts.semanticTopK, // Get more chunks when returning all
        minSimilarity: opts.minSimilarity,
        libraryId: opts.libraryId,
        returnAllChunks: opts.returnAllChunks,
        queryEmbedding,
      });

      // Drop orphan results (no resolved local itemId) — hybrid search needs a
      // local item for keyword merging and navigation.
      let filteredResults = results.filter(
        (r): r is SearchResult & { itemId: number } => r.itemId !== undefined
      );

      // Filter out books if preference is set
      const excludeBooks = Zotero.Prefs.get('zotseek.excludeBooks', true) ?? true;
      if (excludeBooks) {
        const kept: typeof filteredResults = [];
        for (const r of filteredResults) {
          try {
            const item = await Zotero.Items.getAsync(r.itemId);
            if (item && item.itemType !== 'book') {
              kept.push(r);
            }
          } catch {
            // If we can't get the item, include it anyway
            kept.push(r);
          }
        }
        filteredResults = kept;
      }

      return filteredResults.map((r) => ({
        itemId: r.itemId,
        score: r.similarity,
        textSource: r.textSource,
        chunkIndex: r.chunkIndex,
        chunkText: r.chunkText,
        pageNumber: r.pageNumber,
        paragraphIndex: r.paragraphIndex,
      }));
    } catch (error) {
      this.logger.error('Semantic search failed:', error);
      return [];
    }
  }

  /**
   * Keyword search using Zotero's built-in search
   *
   * Zotero's quicksearch doesn't rank by relevance, so we add our own scoring:
   * - Title contains query terms → higher score
   * - Year matches query year → bonus
   * - Author matches query pattern → bonus
   */
  private async keywordSearchQuery(
    query: string,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>> & HybridSearchOptions
  ): Promise<Array<{ itemId: number; score: number }>> {
    try {
      // Use Zotero's quick search
      const search = new Zotero.Search();
      search.libraryID = opts.libraryId || Zotero.Libraries.userLibraryID;

      // Add collection constraint if specified
      if (opts.collectionId) {
        search.addCondition('collectionID', 'is', opts.collectionId.toString());
      }

      // Quick search searches title, creators, year, tags, etc.
      // This is the same search used in Zotero's search bar
      search.addCondition('quicksearch-everything', 'contains', query);

      // Exclude attachments and notes - we only want regular items
      search.addCondition('itemType', 'isNot', 'attachment');
      search.addCondition('itemType', 'isNot', 'note');

      // Exclude books if preference is set
      const excludeBooks = Zotero.Prefs.get('zotseek.excludeBooks', true) ?? true;
      if (excludeBooks) {
        search.addCondition('itemType', 'isNot', 'book');
      }

      const itemIds = await search.search();

      // Extract query components for scoring
      const queryLower = query.toLowerCase();
      const queryTerms = queryLower.split(/\s+/).filter(t => t.length > 1);
      const queryYearMatch = query.match(/\b(19|20)\d{2}\b/);
      const queryYear = queryYearMatch ? queryYearMatch[0] : null;

      // Score each result based on match quality
      const scoredResults: Array<{ itemId: number; score: number }> = [];

      for (const itemId of itemIds.slice(0, opts.keywordTopK * 2)) { // Get more to allow reranking
        try {
          const item = await Zotero.Items.getAsync(itemId);
          if (!item) continue;

          let score = 0.5; // Base score

          // Title matching
          const title = (item.getField('title') || '').toLowerCase();
          let titleMatchCount = 0;
          for (const term of queryTerms) {
            if (title.includes(term)) {
              titleMatchCount++;
            }
          }
          // Bonus for title matches (up to 0.3)
          if (queryTerms.length > 0) {
            score += 0.3 * (titleMatchCount / queryTerms.length);
          }

          // Exact title match bonus
          if (queryTerms.length > 0 && queryTerms.every(term => title.includes(term))) {
            score += 0.15; // All query terms in title
          }

          // Year matching
          if (queryYear) {
            const itemDate = item.getField('date') || '';
            if (itemDate.includes(queryYear)) {
              score += 0.15; // Year match bonus
            }
          }

          // Author matching (check if query contains author-like patterns)
          // Only check names with 3+ chars to avoid false positives like "Li" in "literature"
          const creators = item.getCreators();
          if (creators && creators.length > 0) {
            for (const creator of creators) {
              const lastName = (creator.lastName || '').toLowerCase();
              if (lastName && lastName.length >= 3 && queryLower.includes(lastName)) {
                score += 0.1; // Author match bonus
                break;
              }
            }
          }

          // Cap score at 1.0 (100%)
          score = Math.min(score, 1.0);

          scoredResults.push({ itemId, score });
        } catch (e) {
          // If we can't get item metadata, use base score
          scoredResults.push({ itemId, score: 0.5 });
        }
      }

      // Sort by score descending
      scoredResults.sort((a, b) => b.score - a.score);

      // Return top K with normalized scores
      return scoredResults.slice(0, opts.keywordTopK);
    } catch (error) {
      this.logger.error('Keyword search failed:', error);
      return [];
    }
  }

  /**
   * Reciprocal Rank Fusion
   *
   * Combines results from multiple ranked lists using the formula:
   * RRF(d) = Σ weight_i / (k + rank_i(d))
   *
   * Properties:
   * - Doesn't need score normalization (works on ranks only)
   * - Higher k = more emphasis on top ranks relative to lower ranks
   * - Typical k = 60 (from original RRF paper by Cormack et al.)
   *
   * @param semanticResults - Results from semantic search, ordered by similarity
   * @param keywordResults - Results from keyword search, ordered by relevance
   * @param opts - Options including rrfK and semanticWeight
   */
  private reciprocalRankFusion(
    semanticResults: Array<{ itemId: number; score: number; textSource?: TextSourceType; chunkIndex?: number; chunkText?: string; pageNumber?: number; paragraphIndex?: number }>,
    keywordResults: Array<{ itemId: number; score: number }>,
    opts: Required<Omit<HybridSearchOptions, 'collectionId' | 'libraryId' | 'mode'>>
  ): HybridSearchResult[] {
    const k = opts.rrfK;
    const semanticWeight = opts.semanticWeight;
    const keywordWeight = 1 - semanticWeight;

    // When returnAllChunks is true, use itemId-chunkIndex as key to preserve all chunks
    // Otherwise, use just itemId (MaxSim-style aggregation)
    const useChunkKey = opts.returnAllChunks;

    // Build maps for quick lookup
    // Key is either "itemId" or "itemId-chunkIndex" depending on mode
    const semanticMap = new Map<string, { itemId: number; chunkIndex?: number; chunkText?: string; rank: number; score: number; textSource?: TextSourceType; pageNumber?: number; paragraphIndex?: number }>();
    semanticResults.forEach((r, index) => {
      const key = useChunkKey ? `${r.itemId}-${r.chunkIndex ?? 0}` : String(r.itemId);
      // In all-chunks mode, keep all entries; in MaxSim mode, keep only first (best) per item
      if (!semanticMap.has(key)) {
        semanticMap.set(key, {
          itemId: r.itemId,
          chunkIndex: r.chunkIndex,
          chunkText: r.chunkText,
          rank: index + 1,
          score: r.score,
          textSource: r.textSource,
          pageNumber: r.pageNumber,
          paragraphIndex: r.paragraphIndex,
        });
      }
    });

    const keywordMap = new Map<string, { itemId: number; rank: number; score: number }>();
    keywordResults.forEach((r, index) => {
      const key = String(r.itemId);
      if (!keywordMap.has(key)) {
        keywordMap.set(key, { itemId: r.itemId, rank: index + 1, score: r.score });
      }
    });

    // Get all unique keys from both result sets
    const allKeys = new Set<string>([
      ...semanticMap.keys(),
      ...keywordResults.map(r => String(r.itemId)),
    ]);

    // Calculate RRF score for each unique entry
    const fusedResults: HybridSearchResult[] = [];

    for (const key of allKeys) {
      const semantic = semanticMap.get(key);
      // For keyword, always use itemId (keyword search doesn't have chunks)
      const itemId = semantic?.itemId ?? parseInt(key.split('-')[0]);
      const keyword = keywordMap.get(String(itemId));

      // RRF formula with weights:
      // RRF(d) = semanticWeight / (k + semantic_rank) + keywordWeight / (k + keyword_rank)
      let rrfScore = 0;
      if (semantic) {
        rrfScore += semanticWeight * (1 / (k + semantic.rank));
      }
      if (keyword) {
        rrfScore += keywordWeight * (1 / (k + keyword.rank));
      }

      // Determine source
      let source: 'both' | 'semantic' | 'keyword';
      if (semantic && keyword) {
        source = 'both';
      } else if (semantic) {
        source = 'semantic';
      } else {
        source = 'keyword';
      }

      fusedResults.push({
        itemId,
        itemKey: '',  // Will be populated later
        title: '',
        creators: '',
        year: 0,
        semanticScore: semantic?.score ?? null,
        keywordScore: keyword?.score ?? null,
        rrfScore,
        semanticRank: semantic?.rank ?? null,
        keywordRank: keyword?.rank ?? null,
        source,
        textSource: semantic?.textSource,
        chunkIndex: semantic?.chunkIndex,
        chunkText: semantic?.chunkText,
        pageNumber: semantic?.pageNumber,
        paragraphIndex: semantic?.paragraphIndex,
      });
    }

    // Sort by RRF score descending (highest score first)
    fusedResults.sort((a, b) => b.rrfScore - a.rrfScore);

    return fusedResults;
  }

  /**
   * Populate item metadata (title, creators, year) for results
   */
  private async populateItemMetadata(results: HybridSearchResult[]): Promise<void> {
    for (const result of results) {
      try {
        const item = await Zotero.Items.getAsync(result.itemId);
        if (item) {
          result.itemKey = item.key;
          result.title = item.getField('title') || 'Untitled';

          // Get year from date field
          const dateStr = item.getField('date');
          if (dateStr) {
            const yearMatch = dateStr.match(/\d{4}/);
            if (yearMatch) {
              result.year = parseInt(yearMatch[0]);
            }
          }

          // Format creators
          const creators = item.getCreators();
          if (creators && creators.length > 0) {
            const firstAuthor = creators[0].lastName || creators[0].name || '';
            if (creators.length === 1) {
              result.creators = firstAuthor;
            } else if (creators.length === 2) {
              const secondAuthor = creators[1].lastName || creators[1].name || '';
              result.creators = `${firstAuthor} & ${secondAuthor}`;
            } else {
              result.creators = `${firstAuthor} et al.`;
            }
          }
        }
      } catch (error) {
        this.logger.warn(`Failed to get metadata for item ${result.itemId}:`, error);
      }
    }
  }

  /**
   * Analyze query to determine optimal search strategy
   *
   * Returns recommended weights based on query characteristics:
   * - Author patterns → boost keyword
   * - Year patterns → boost keyword
   * - Acronyms → boost keyword
   * - Exact phrases (quotes) → boost keyword
   * - Questions → boost semantic
   * - Long conceptual queries → boost semantic
   */
  analyzeQuery(query: string): QueryAnalysis {
    const tokens = query.toLowerCase().split(/\s+/);
    const detectedPatterns: string[] = [];

    // Patterns that suggest keyword search is important
    const hasYear = /\b(19|20)\d{2}\b/.test(query);
    const hasAuthorPattern = /\b[A-Z][a-z]+\s+(et\s+al\.?|&|\band\b)/i.test(query);
    const hasAcronym = /\b[A-Z]{2,}\b/.test(query);
    const hasQuotes = query.includes('"') || query.includes("'");
    const hasSpecialChars = /[<>=]/.test(query);
    const hasShortTerms = tokens.some(t => t.length <= 3 && t.length > 0);

    // Patterns that suggest semantic search is important
    const isQuestion = /^(what|how|why|when|where|which|who)\b/i.test(query);
    const isConceptual = tokens.length >= 4 && !hasYear && !hasAuthorPattern;
    const hasConceptualPhrases = /\b(related to|similar to|about|regarding|concerning)\b/i.test(query);

    let keywordBoost = 0;

    if (hasYear) {
      keywordBoost += 0.15;
      detectedPatterns.push('year');
    }
    if (hasAuthorPattern) {
      keywordBoost += 0.2;
      detectedPatterns.push('author pattern');
    }
    if (hasAcronym) {
      keywordBoost += 0.1;
      detectedPatterns.push('acronym');
    }
    if (hasQuotes) {
      keywordBoost += 0.15;
      detectedPatterns.push('exact phrase');
    }
    if (hasSpecialChars) {
      keywordBoost += 0.1;
      detectedPatterns.push('special characters');
    }
    if (hasShortTerms && tokens.length <= 2) {
      keywordBoost += 0.1;
      detectedPatterns.push('short terms');
    }

    let semanticBoost = 0;
    if (isQuestion) {
      semanticBoost += 0.15;
      detectedPatterns.push('question');
    }
    if (isConceptual) {
      semanticBoost += 0.1;
      detectedPatterns.push('conceptual');
    }
    if (hasConceptualPhrases) {
      semanticBoost += 0.1;
      detectedPatterns.push('conceptual phrases');
    }

    // Base weight is 0.5 (equal), adjust based on detected patterns
    // Clamp to [0.2, 0.8] to always give both methods some weight
    const semanticWeight = Math.max(0.2, Math.min(0.8, 0.5 + semanticBoost - keywordBoost));

    let reasoning: string;
    if (detectedPatterns.length > 0) {
      reasoning = detectedPatterns.join(', ');
    } else {
      reasoning = 'balanced query';
    }

    return {
      semanticWeight,
      reasoning,
      detectedPatterns,
    };
  }

  /**
   * Smart search that auto-adjusts weights based on query analysis
   */
  async smartSearch(query: string, options: HybridSearchOptions = {}): Promise<HybridSearchResult[]> {
    const analysis = this.analyzeQuery(query);
    this.logger.info(`Query analysis: weight=${analysis.semanticWeight.toFixed(2)}, ${analysis.reasoning}`);

    return this.search(query, {
      ...options,
      semanticWeight: analysis.semanticWeight,
    });
  }

  /**
   * Get source indicator emoji for display
   */
  static getSourceIndicator(result: HybridSearchResult): string {
    switch (result.source) {
      case 'both':
        return '🔗';  // Found in both searches (high confidence)
      case 'semantic':
        return '🧠';  // Found by semantic search only
      case 'keyword':
        return '🔤';  // Found by keyword search only
      default:
        return '';
    }
  }

  /**
   * Get source description for tooltips
   */
  static getSourceDescription(result: HybridSearchResult): string {
    switch (result.source) {
      case 'both':
        return `Found by both semantic (rank #${result.semanticRank}) and keyword (rank #${result.keywordRank}) search`;
      case 'semantic':
        return `Found by semantic search (rank #${result.semanticRank}, similarity ${((result.semanticScore || 0) * 100).toFixed(0)}%)`;
      case 'keyword':
        return `Found by keyword search (rank #${result.keywordRank})`;
      default:
        return '';
    }
  }
}

// Export types for use in UI
export type SearchMode = 'hybrid' | 'semantic' | 'keyword';

