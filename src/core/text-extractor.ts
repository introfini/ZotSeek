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
import { identityFromItem } from './identity-resolver';
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

/**
 * Name an item well enough for a user to find it in their library.
 *
 * `item.id` alone is a local database id: it means nothing in the Zotero UI,
 * differs between machines, and was exactly what issue #54 could not act on.
 * Title and stable identity are both added when they can be read.
 *
 * Never throws. It is called from error handlers, where the item itself may
 * be the thing that is broken, and a throw there would escape the catch.
 * Module-level rather than a class method for the reason documented above
 * collectNoteChunks: SpiderMonkey does not reliably register every class
 * method compiled into this project's esbuild IIFE bundle.
 */
export function describeItem(item: any): string {
  const parts = [`item ${item?.id ?? '?'}`];

  try {
    const title = item?.getField?.('title');
    if (title) parts.push(`"${title}"`);
  } catch {
    /* unreadable title: the id and identity still say which item it is */
  }

  try {
    const identity = identityFromItem(item);
    if (identity) parts.push(`(${identity.libraryKey}/${identity.itemKey})`);
  } catch {
    /* unresolvable library: fall back to the local id alone */
  }

  return parts.join(' ');
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
    options?: ChunkOptions,
    onError?: (message: string) => void
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
          const result = chunkDocumentWithPagesEx(title, abstract, pages, indexingMode, chunkOptions);
          chunks = result.chunks;
          wasTruncated = result.wasTruncated;
          pagesIndexed = result.pagesIndexed;
          pagesTotal = result.pagesTotal;
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
      this.logger.error(`Failed to extract chunks from ${describeItem(item)}: ${errorMessage}`);
      // Returning null on its own is indistinguishable from an item that
      // simply has no text, which is ordinary. Tell the caller which it was.
      onError?.(errorMessage);
      if (errorStack) {
        // Zotero.debug, never console: this runs in the plugin scope, which has
        // no console, and a ReferenceError thrown here would escape the very
        // catch that is meant to keep one bad item from ending the run (#54).
        Zotero.debug(`[ZotSeek:TextExtractor] Stack trace for ${describeItem(item)}: ${errorStack}`);
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

      // Reading the item can fail too, and a throw here used to end the whole
      // batch before extraction was even attempted. describeItem never throws.
      let title: string;
      try {
        title = item.getField('title') || 'Untitled';
      } catch {
        title = describeItem(item);
      }

      // Deliberately outside the per-item guard below: callers cancel a run by
      // throwing from this callback, and that throw has to reach them.
      if (onProgress) {
        onProgress({
          current: i + 1,
          total: items.length,
          currentTitle: title,
          status: 'extracting',
          skipped,
        });
      }

      // One item that fails costs that item, not the run. The embedding stage
      // has worked this way since v1.10.0; extraction did not, and a single
      // unreadable item aborted a whole 5000-item library (#54).
      const failures: string[] = [];
      let extracted: ExtractedChunks | null = null;
      try {
        extracted = await this.extractChunksFromItem(
          item, indexingMode, chunkOptions, (message) => failures.push(message),
        );
      } catch (error: any) {
        // extractChunksFromItem catches its own errors, so arriving here means
        // that net tore. Contain it rather than trusting it twice.
        const message = error?.message || error?.toString() || 'Unknown error';
        failures.push(message);
        this.logger.error(`Extraction threw for ${describeItem(item)}: ${message}`);
        if (error?.stack) Zotero.debug(`[ZotSeek:TextExtractor] ${error.stack}`);
      }

      if (extracted) {
        results.push(extracted);
        totalChunks += extracted.chunks.length;
      } else {
        skipped++;
      }

      if (failures.length > 0 && onProgress) {
        onProgress({
          current: i + 1,
          total: items.length,
          currentTitle: describeItem(item),
          status: 'error',
          skipped,
        });
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
