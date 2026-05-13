/**
 * Text Extractor - Extract text from Zotero items for embedding
 * 
 * Supports two indexing modes:
 * - abstract: Title + Abstract only (fast, good for most uses)
 * - full: Title + Abstract + PDF sections (thorough, for deep research)
 */

import { Logger } from '../utils/logger';
import { ZoteroAPI, ZoteroItem } from '../utils/zotero-api';
import {
  Chunk,
  ChunkOptions,
  IndexingMode,
  chunkDocumentEx,
  chunkDocumentWithPagesEx,
  getChunkOptionsFromPrefs,
  getIndexingMode
} from '../utils/chunker';
import { TextSourceType } from './vector-store-sqlite';

declare const Zotero: any;

export interface ExtractedText {
  itemId: number;
  itemKey: string;
  libraryId: number;
  title: string;
  text: string;
  source: TextSourceType;
  contentHash: string;
}

export interface ExtractedChunks {
  itemId: number;
  itemKey: string;
  libraryId: number;
  title: string;
  abstract: string | null;
  chunks: Chunk[];
  contentHash: string;

  // Indexing status — populated from the chunker so callers can detect
  // when the maxChunksPerPaper limit cut off content from a long paper.
  wasTruncated: boolean;
  pagesIndexed: number;
  pagesTotal: number;
}

export interface ExtractionProgress {
  current: number;
  total: number;
  currentTitle: string;
  status: 'extracting' | 'done' | 'error';
  skipped: number;
}

export type ExtractionProgressCallback = (progress: ExtractionProgress) => void;

export class TextExtractor {
  private zoteroAPI: ZoteroAPI;
  private logger: Logger;

  constructor() {
    this.zoteroAPI = new ZoteroAPI();
    this.logger = new Logger('TextExtractor');
  }

  /**
   * Extract text from a single item (legacy method for backward compatibility)
   */
  async extractFromItem(item: ZoteroItem): Promise<ExtractedText | null> {
    try {
      const title = item.getField('title') || 'Untitled';
      
      // Extract text using preferred sources
      const { text, source } = await this.zoteroAPI.extractText(item);
      
      if (!text || text.length < 10) {
        this.logger.warn(`Insufficient text for item ${item.id}: ${title}`);
        return null;
      }

      // Generate content hash for change detection
      const contentHash = this.hashContent(text);

      return {
        itemId: item.id,
        itemKey: item.key,
        libraryId: item.libraryID,
        title,
        text,
        source,
        contentHash,
      };
    } catch (error) {
      this.logger.error(`Failed to extract text from item ${item.id}:`, error);
      return null;
    }
  }

  /**
   * Extract chunks from a single item based on indexing mode
   * Uses page-by-page extraction for accurate page numbers in 'full' mode
   */
  async extractChunksFromItem(
    item: ZoteroItem,
    mode?: IndexingMode,
    options?: ChunkOptions
  ): Promise<ExtractedChunks | null> {
    try {
      const title = item.getField('title') || 'Untitled';
      const abstract = item.getField('abstractNote') || null;

      // Get indexing mode from preference if not specified
      const indexingMode = mode ?? getIndexingMode(Zotero);
      const chunkOptions = options ?? getChunkOptionsFromPrefs(Zotero);

      let chunks: Chunk[];
      let wasTruncated = false;
      let pagesIndexed = 0;
      let pagesTotal = 0;

      if (indexingMode === 'full') {
        // Use page-by-page extraction for accurate page numbers
        const pages = await this.zoteroAPI.getFullTextByPage(item.id);

        if (pages && pages.length > 0) {
          // Use new page-aware chunker for accurate page numbers
          this.logger.debug(`Using page-by-page chunking for item ${item.id} (${pages.length} pages)`);
          try {
            const result = chunkDocumentWithPagesEx(title, abstract, pages, indexingMode, chunkOptions);
            chunks = result.chunks;
            wasTruncated = result.wasTruncated;
            pagesIndexed = result.pagesIndexed;
            pagesTotal = result.pagesTotal;
          } catch (chunkError: any) {
            console.error(`[TextExtractor] chunkDocumentWithPagesEx failed for item ${item.id}:`,
              chunkError?.message || chunkError?.toString() || chunkError);
            console.error(`[TextExtractor] Stack:`, chunkError?.stack);
            throw chunkError;
          }
        } else {
          // Fallback to legacy chunker if page extraction fails
          this.logger.debug(`Falling back to legacy chunking for item ${item.id}`);
          const fulltext = await this.zoteroAPI.getFullText(item.id);
          const totalPages = await this.zoteroAPI.getPageCount(item.id);
          if (totalPages) {
            chunkOptions.totalPages = totalPages;
          }
          const result = chunkDocumentEx(title, abstract, fulltext, indexingMode, chunkOptions);
          chunks = result.chunks;
          wasTruncated = result.wasTruncated;
          pagesIndexed = result.pagesIndexed;
          pagesTotal = result.pagesTotal || (totalPages || 0);
        }
      } else {
        // Abstract mode - no fulltext needed
        const result = chunkDocumentEx(title, abstract, null, indexingMode, chunkOptions);
        chunks = result.chunks;
        wasTruncated = result.wasTruncated;
        pagesIndexed = result.pagesIndexed;
        pagesTotal = result.pagesTotal;
      }

      if (chunks.length === 0) {
        this.logger.warn(`No chunks generated for item ${item.id}: ${title}`);
        return null;
      }

      // Log chunk distribution by page for debugging
      const pageDistribution = new Map<number, number>();
      for (const chunk of chunks) {
        const page = chunk.pageNumber || 0;
        pageDistribution.set(page, (pageDistribution.get(page) || 0) + 1);
      }
      const pageInfo = [...pageDistribution.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([page, count]) => `p${page}:${count}`)
        .join(' ');
      this.logger.debug(`Item ${item.id}: ${chunks.length} chunks across pages [${pageInfo}]`);

      // Generate content hash from all chunk texts
      const allText = chunks.map(c => c.text).join('\n\n');
      const contentHash = this.hashContent(allText);

      return {
        itemId: item.id,
        itemKey: item.key,
        libraryId: item.libraryID,
        title,
        abstract,
        chunks,
        contentHash,
        wasTruncated,
        pagesIndexed,
        pagesTotal,
      };
    } catch (error: any) {
      // Better error logging - Error objects don't serialize well
      const errorMessage = error?.message || error?.toString() || 'Unknown error';
      const errorStack = error?.stack || '';
      this.logger.error(`Failed to extract chunks from item ${item.id}: ${errorMessage}`);
      if (errorStack) {
        console.error(`[TextExtractor] Stack trace for item ${item.id}:`, errorStack);
      }
      return null;
    }
  }

  /**
   * Extract text from multiple items with progress callback (legacy)
   */
  async extractFromItems(
    items: ZoteroItem[],
    onProgress?: ExtractionProgressCallback
  ): Promise<ExtractedText[]> {
    const results: ExtractedText[] = [];
    let skipped = 0;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = item.getField('title') || 'Untitled';

      // Report progress
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: items.length,
          currentTitle: title,
          status: 'extracting',
          skipped,
        });
      }

      const extracted = await this.extractFromItem(item);
      if (extracted) {
        results.push(extracted);
      } else {
        skipped++;
      }

      // Yield to UI thread periodically
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Report completion
    if (onProgress) {
      onProgress({
        current: items.length,
        total: items.length,
        currentTitle: '',
        status: 'done',
        skipped,
      });
    }

    this.logger.info(`Extracted text from ${results.length}/${items.length} items (${skipped} skipped)`);

    return results;
  }

  /**
   * Extract chunks from multiple items with progress callback
   */
  async extractChunksFromItems(
    items: ZoteroItem[],
    mode?: IndexingMode,
    options?: ChunkOptions,
    onProgress?: ExtractionProgressCallback
  ): Promise<ExtractedChunks[]> {
    const results: ExtractedChunks[] = [];
    let skipped = 0;
    let totalChunks = 0;

    // Get mode and options once
    const indexingMode = mode ?? getIndexingMode(Zotero);
    const chunkOptions = options ?? getChunkOptionsFromPrefs(Zotero);
    
    this.logger.info(`Extracting chunks with mode: ${indexingMode}`);

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const title = item.getField('title') || 'Untitled';

      // Report progress
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: items.length,
          currentTitle: title,
          status: 'extracting',
          skipped,
        });
      }

      const extracted = await this.extractChunksFromItem(item, indexingMode, chunkOptions);
      if (extracted) {
        results.push(extracted);
        totalChunks += extracted.chunks.length;
      } else {
        skipped++;
      }

      // Yield to UI thread periodically
      if (i % 10 === 0) {
        await new Promise(resolve => setTimeout(resolve, 0));
      }
    }

    // Report completion
    if (onProgress) {
      onProgress({
        current: items.length,
        total: items.length,
        currentTitle: '',
        status: 'done',
        skipped,
      });
    }

    this.logger.info(`Extracted ${totalChunks} chunks from ${results.length}/${items.length} items (${skipped} skipped)`);

    return results;
  }

  /**
   * Generate a hash for content to detect changes
   */
  private hashContent(content: string): string {
    // Use a simple hash for change detection
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  }

  /**
   * Get regular items (not notes/attachments) from a collection
   */
  async getItemsFromCollection(collectionId: number): Promise<ZoteroItem[]> {
    return this.zoteroAPI.getCollectionItems(collectionId);
  }

  /**
   * Get regular items from a library
   */
  async getItemsFromLibrary(libraryId: number): Promise<ZoteroItem[]> {
    return this.zoteroAPI.getLibraryItems(libraryId);
  }
}

// Singleton instance
export const textExtractor = new TextExtractor();
