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
  NoteSource,
  chunkNotes,
  getChunkOptionsFromPrefs,
  getIndexingMode
} from '../utils/chunker';
import { noteHtmlToText } from '../utils/note-text';
import { TextSourceType } from './vector-store-sqlite';

declare const Zotero: any;

/**
 * Read every child note of an item, convert HTML to plain text, and chunk
 * each note on its own, so no chunk ever mixes two notes and every chunk
 * records which note it came from. Module-level (not a class method) because
 * SpiderMonkey does not reliably register all class methods added to a
 * class compiled into this project's esbuild IIFE bundle: a method added
 * here can be missing from the runtime prototype even though it is present
 * in the build output, so utility functions that do not need `this` are
 * kept as plain module-level functions instead.
 */
async function collectNoteChunks(
  item: ZoteroItem,
  title: string,
  options: ChunkOptions
): Promise<Chunk[]> {
  if (!Zotero.Prefs.get('zotseek.indexNotes', true)) return [];

  const getNotes = (item as any).getNotes;
  if (typeof getNotes !== 'function') return [];
  const noteIds: number[] = getNotes.call(item) || [];
  if (noteIds.length === 0) return [];

  const parts: NoteSource[] = [];
  for (const noteId of noteIds) {
    // Per-note try/catch: a throw from getAsync or getNote() would otherwise
    // reach extractChunksFromItem's catch, which returns null and drops the
    // whole item. One unreadable note must cost that note, not the paper.
    try {
      const note = await Zotero.Items.getAsync(noteId);
      if (!note || note.deleted) continue;
      const text = noteHtmlToText(note.getNote() || '');
      if (text) parts.push({ key: note.key, text });
    } catch (error: any) {
      Zotero.debug(
        `[ZotSeek:TextExtractor] Skipping note ${noteId} on item ${item.id}: ` +
        `${error?.message || error?.toString() || 'Unknown error'}`
      );
    }
  }
  if (parts.length === 0) return [];

  return chunkNotes(title, parts, options);
}

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

      const noteChunks = await collectNoteChunks(item, title, chunkOptions);
      if (noteChunks.length > 0) {
        const base = chunks.length;
        chunks = chunks.concat(noteChunks.map((c, i) => ({ ...c, index: base + i })));
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
