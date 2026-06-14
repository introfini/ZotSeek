/**
 * Zotero API wrapper
 * Provides type-safe access to Zotero's internal APIs
 *
 * Reference: https://windingwind.github.io/doc-for-zotero-plugin-dev/main/item-operations.html
 */

import { TextSourceType } from '../core/vector-store-sqlite';

declare const Zotero: any;

export interface ZoteroItem {
  id: number;
  key: string;
  libraryID: number;
  itemType: string;
  getField(field: string): string;
  setField(field: string, value: string): void;
  getCreators(): ZoteroCreator[];
  getCreatorJSON(index: number): { firstName: string; lastName: string; creatorType: string };
  getBestAttachment(): Promise<ZoteroAttachment | null>;
  getAttachments(): number[];  // Returns attachment IDs
  getNotes(): number[];        // Returns note IDs
  isRegularItem(): boolean;
  isAttachment(): boolean;
  isNote(): boolean;
  relatedItems: string[];      // Related item keys
  addRelatedItem(item: ZoteroItem): void;
  saveTx(): Promise<number>;
}

export interface ZoteroCreator {
  firstName: string;
  lastName: string;
  creatorType: string;
}

export interface ZoteroAttachment {
  id: number;
  key: string;
  attachmentContentType: string;
  attachmentText: Promise<string>;  // Full text from PDF/HTML
  isPDFAttachment(): boolean;
  isSnapshotAttachment(): boolean;
  getFilePath(): Promise<string>;
}

export interface ZoteroCollection {
  id: number;
  key: string;
  name: string;
  libraryID: number;
  getChildItems(includeDeleted?: boolean): ZoteroItem[];
}

// Helper to log with Zotero.debug
function debug(msg: string): void {
  if (typeof Zotero !== 'undefined' && Zotero.debug) {
    Zotero.debug(`[ZoteroAPI] ${msg}`);
  }
}

/**
 * Wrapper for Zotero API access
 */
export class ZoteroAPI {
  /**
   * Get currently selected items in Zotero
   */
  getSelectedItems(): ZoteroItem[] {
    try {
      const pane = Zotero.getActiveZoteroPane();
      if (!pane) return [];
      return pane.getSelectedItems() || [];
    } catch (error) {
      debug(`Failed to get selected items: ${error}`);
      return [];
    }
  }

  /**
   * Get all items in a collection using Search API
   * Reference: https://windingwind.github.io/doc-for-zotero-plugin-dev/main/search-operations.html
   */
  async getCollectionItems(collectionId: number, libraryId?: number): Promise<ZoteroItem[]> {
    try {
      const s = new Zotero.Search();
      s.libraryID = libraryId || Zotero.Libraries.userLibraryID;
      s.addCondition('collectionID', 'is', collectionId);
      s.addCondition('recursive', 'true');  // Include subcollections
      s.addCondition('itemType', 'isNot', 'attachment');
      s.addCondition('itemType', 'isNot', 'note');

      // Exclude books if preference is set
      const excludeBooks = Zotero.Prefs.get('zotseek.excludeBooks', true) ?? true;
      if (excludeBooks) {
        s.addCondition('itemType', 'isNot', 'book');
      }

      const itemIDs = await s.search();
      return Zotero.Items.getAsync(itemIDs);
    } catch (error) {
      debug(`Failed to get collection items: ${error}`);
      return [];
    }
  }

  /**
   * Get all regular items in user's library using Search API
   */
  async getLibraryItems(libraryId?: number): Promise<ZoteroItem[]> {
    try {
      const s = new Zotero.Search();
      s.libraryID = libraryId || Zotero.Libraries.userLibraryID;
      s.addCondition('itemType', 'isNot', 'attachment');
      s.addCondition('itemType', 'isNot', 'note');

      // Exclude books if preference is set
      const excludeBooks = Zotero.Prefs.get('zotseek.excludeBooks', true) ?? true;
      if (excludeBooks) {
        s.addCondition('itemType', 'isNot', 'book');
      }

      const itemIDs = await s.search();
      return Zotero.Items.getAsync(itemIDs);
    } catch (error) {
      debug(`Failed to get library items: ${error}`);
      return [];
    }
  }

  /**
   * Get all indexable libraries (user + groups, excluding feeds).
   */
  getAllLibraries(): Array<{ libraryID: number; name: string; libraryType: string; groupID?: number }> {
    try {
      const libs: any[] = Zotero.Libraries.getAll();
      return libs
        .filter((lib: any) => lib.libraryType === 'user' || lib.libraryType === 'group')
        .map((lib: any) => ({
          libraryID: lib.libraryID,
          name: lib.name,
          libraryType: lib.libraryType,
          groupID: lib.groupID,
        }));
    } catch (error) {
      debug(`Failed to get all libraries: ${error}`);
      return [];
    }
  }

  /**
   * Get all regular items across all indexable libraries (user + groups).
   */
  async getAllLibraryItems(): Promise<ZoteroItem[]> {
    const libraries = this.getAllLibraries();
    const allItems: ZoteroItem[] = [];
    for (const lib of libraries) {
      try {
        const items = await this.getLibraryItems(lib.libraryID);
        debug(`Got ${items.length} items from library ${lib.name} (${lib.libraryType})`);
        allItems.push(...items);
      } catch (error) {
        debug(`Failed to get items for library ${lib.name}: ${error}`);
      }
    }
    return allItems;
  }

  /**
   * Get item by ID
   */
  getItem(itemId: number): ZoteroItem | null {
    try {
      return Zotero.Items.get(itemId);
    } catch (error) {
      debug(`Failed to get item ${itemId}: ${error}`);
      return null;
    }
  }

  /**
   * Get items by IDs
   */
  async getItems(itemIds: number[]): Promise<ZoteroItem[]> {
    try {
      return Zotero.Items.getAsync(itemIds);
    } catch (error) {
      debug(`Failed to get items: ${error}`);
      return [];
    }
  }

  /**
   * Get full text content for an item using attachment.attachmentText
   * Reference: https://windingwind.github.io/doc-for-zotero-plugin-dev/main/item-operations.html
   */
  async getFullText(itemId: number): Promise<string | null> {
    try {
      const item = this.getItem(itemId);
      if (!item || !item.isRegularItem()) return null;

      const attachmentIDs = item.getAttachments();
      const fulltext: string[] = [];

      for (const id of attachmentIDs) {
        const attachment = Zotero.Items.get(id) as ZoteroAttachment;
        if (attachment.isPDFAttachment() || attachment.isSnapshotAttachment()) {
          try {
            const text = await attachment.attachmentText;
            if (text) fulltext.push(text);
          } catch (e) {
            // Some attachments may not have text
          }
        }
      }

      return fulltext.join('\n\n') || null;
    } catch (error) {
      debug(`Failed to get full text for item ${itemId}: ${error}`);
      return null;
    }
  }

  /**
   * Get full text content page by page using PDFWorker
   * Returns array of {pageNumber, text} for each page
   */
  async getFullTextByPage(itemId: number): Promise<Array<{ pageNumber: number; text: string }> | null> {
    try {
      const item = this.getItem(itemId);
      if (!item || !item.isRegularItem()) return null;

      const attachmentIDs = item.getAttachments();

      for (const id of attachmentIDs) {
        const attachment = Zotero.Items.get(id);
        if (!attachment || !attachment.isPDFAttachment()) continue;

        // Get total pages first
        const pageInfo = await Zotero.Fulltext.getPages(id);
        if (!pageInfo || pageInfo.total <= 0) continue;

        const totalPages = pageInfo.total;
        const pages: Array<{ pageNumber: number; text: string }> = [];

        debug(`Extracting ${totalPages} pages for item ${itemId}`);

        // Extract text page by page
        // Note: PDFWorker uses \n for paragraph breaks and \f for page breaks
        for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
          try {
            const pageResult = await Zotero.PDFWorker.getFullText(id, [pageIndex], false, null);
            if (pageResult && pageResult.text) {
              pages.push({
                pageNumber: pageIndex + 1,  // 1-based page number
                text: pageResult.text
              });
            }
          } catch (pageError) {
            debug(`Error extracting page ${pageIndex + 1}: ${pageError}`);
            // Continue with other pages
          }
        }

        if (pages.length > 0) {
          debug(`Extracted ${pages.length} pages for item ${itemId}`);
          return pages;
        }
      }

      return null;
    } catch (error) {
      debug(`Failed to get page-by-page text for item ${itemId}: ${error}`);
      return null;
    }
  }

  /**
   * Extract text from item (title + abstract, with fulltext fallback)
   */
  async extractText(item: ZoteroItem): Promise<{ text: string; source: TextSourceType }> {
    const title = item.getField('title') || '';
    const abstract = item.getField('abstractNote') || '';

    // Prefer title + abstract
    if (abstract.length > 50) {
      return {
        text: `${title}\n\n${abstract}`,
        source: 'abstract'
      };
    }

    // Try full text from attachments
    const fullText = await this.getFullText(item.id);
    if (fullText && fullText.length > 100) {
      // Use first 500 words of full text
      const words = fullText.split(/\s+/).slice(0, 500);
      return {
        text: `${title}\n\n${words.join(' ')}`,
        source: 'fulltext'
      };
    }

    // Fall back to title only
    return {
      text: title,
      source: 'title_only'
    };
  }

  /**
   * Set two items as related to each other
   */
  async setRelated(itemA: ZoteroItem, itemB: ZoteroItem): Promise<void> {
    itemA.addRelatedItem(itemB);
    await itemA.saveTx();
    itemB.addRelatedItem(itemA);
    await itemB.saveTx();
    debug(`Set items ${itemA.id} and ${itemB.id} as related`);
  }

  /**
   * Format authors for display
   */
  formatAuthors(item: ZoteroItem): string {
    const creators = item.getCreators();
    const authors = creators.filter(c => c.creatorType === 'author');

    if (authors.length === 0) return '';
    if (authors.length === 1) return authors[0].lastName;
    if (authors.length === 2) return `${authors[0].lastName} & ${authors[1].lastName}`;
    return `${authors[0].lastName} et al.`;
  }

  /**
   * Get year from item
   */
  getYear(item: ZoteroItem): number | null {
    const date = item.getField('date');
    if (!date) return null;
    const year = parseInt(date.substring(0, 4), 10);
    return isNaN(year) ? null : year;
  }

  /**
   * Select an item in Zotero
   */
  selectItem(itemId: number): void {
    try {
      const pane = Zotero.getActiveZoteroPane();
      if (pane) {
        pane.selectItem(itemId);
      }
    } catch (error) {
      debug(`Failed to select item ${itemId}: ${error}`);
    }
  }

  /**
   * Select multiple items in Zotero
   */
  selectItems(itemIds: number[]): void {
    try {
      const pane = Zotero.getActiveZoteroPane();
      if (pane && itemIds.length > 0) {
        pane.selectItems(itemIds);
      }
    } catch (error) {
      debug(`Failed to select items: ${error}`);
    }
  }

  /**
   * Get total page count for an item's PDF attachment
   * Uses Zotero.Fulltext.getPages() for accurate page counts
   */
  async getPageCount(itemId: number): Promise<number | null> {
    try {
      const item = this.getItem(itemId);
      if (!item || !item.isRegularItem()) return null;

      const attachmentIDs = item.getAttachments();
      for (const id of attachmentIDs) {
        const attachment = Zotero.Items.get(id);
        if (attachment && attachment.isPDFAttachment()) {
          // Use Zotero's Fulltext API to get page count
          const pages = await Zotero.Fulltext.getPages(id);
          if (pages && pages.total > 0) {
            debug(`Item ${itemId}: ${pages.total} pages (${pages.indexedPages} indexed)`);
            return pages.total;
          }
        }
      }
      return null;
    } catch (error) {
      debug(`Failed to get page count for item ${itemId}: ${error}`);
      return null;
    }
  }

  /**
   * Find exact page number for a text snippet using PDFWorker
   * Searches each page until the snippet is found
   *
   * @param itemId - The parent item ID
   * @param snippet - Text snippet to search for (first ~100 chars of chunk)
   * @returns The 1-based page number, or null if not found
   */
  async findExactPage(itemId: number, snippet: string): Promise<number | null> {
    try {
      const item = this.getItem(itemId);
      if (!item || !item.isRegularItem()) return null;

      const attachmentIDs = item.getAttachments();
      for (const id of attachmentIDs) {
        const attachment = Zotero.Items.get(id);
        if (!attachment || !attachment.isPDFAttachment()) continue;

        // Get total pages first
        const pageInfo = await Zotero.Fulltext.getPages(id);
        if (!pageInfo || pageInfo.total <= 0) continue;

        const totalPages = pageInfo.total;

        // Normalize snippet for matching (remove extra whitespace, lowercase)
        const normalizedSnippet = snippet
          .toLowerCase()
          .replace(/\s+/g, ' ')
          .trim()
          .substring(0, 100); // Use first 100 chars for matching

        debug(`Searching for snippet in ${totalPages} pages: "${normalizedSnippet.substring(0, 50)}..."`);

        // Search each page using PDFWorker with specific page indices
        for (let pageIndex = 0; pageIndex < totalPages; pageIndex++) {
          try {
            // Get text for this specific page (0-indexed array)
            const pageResult = await Zotero.PDFWorker.getFullText(id, [pageIndex], false, null);

            if (pageResult && pageResult.text) {
              const normalizedPageText = pageResult.text
                .toLowerCase()
                .replace(/\s+/g, ' ');

              if (normalizedPageText.includes(normalizedSnippet)) {
                debug(`Found snippet on page ${pageIndex + 1}`);
                return pageIndex + 1; // Return 1-based page number
              }
            }
          } catch (pageError) {
            debug(`Error extracting page ${pageIndex}: ${pageError}`);
          }
        }

        debug(`Snippet not found in any page`);
        return null;
      }
      return null;
    } catch (error) {
      debug(`Failed to find exact page for item ${itemId}: ${error}`);
      return null;
    }
  }

  /**
   * Open PDF attachment for an item
   */
  async openPDF(itemId: number): Promise<void> {
    try {
      const item = this.getItem(itemId);
      if (!item) return;

      const attachment = await item.getBestAttachment();
      if (!attachment) return;

      await Zotero.Reader.open(attachment.id);
    } catch (error) {
      debug(`Failed to open PDF for item ${itemId}: ${error}`);
    }
  }

  /**
   * Open PDF to a specific page
   * @param itemId - The parent item ID
   * @param pageNumber - 1-based page number to navigate to
   */
  async openPDFToPage(itemId: number, pageNumber: number): Promise<void> {
    try {
      const item = this.getItem(itemId);
      if (!item) return;

      const attachment = await item.getBestAttachment();
      if (!attachment) return;

      // Convert 1-based page to 0-based pageIndex
      const location = { pageIndex: pageNumber - 1 };

      debug(`Opening PDF for item ${itemId} to page ${pageNumber}`);
      await Zotero.Reader.open(attachment.id, location);
    } catch (error) {
      debug(`Failed to open PDF to page for item ${itemId}: ${error}`);
    }
  }

  /**
   * Get user library ID
   */
  getUserLibraryID(): number {
    return Zotero.Libraries.userLibraryID;
  }
}

