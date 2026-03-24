/**
 * Toolbar Button for ZotSeek
 * Adds a button to Zotero's toolbar for quick access to semantic search
 * Also adds a button to the Reader window toolbar
 */

import { Logger } from '../utils/logger';
import { getString } from '../utils/locale';
import { searchDialogWithVTable } from './search-dialog-with-vtable';
import { similarDocumentsWrapper } from './similar-documents-wrapper';

declare const Zotero: any;
declare const document: any;
declare const Components: any;

// Plugin ID for event listener registration
const PLUGIN_ID = 'zotseek@zotero.org';

export class ToolbarButton {
  private logger: Logger;
  private buttonId = 'zotseek-toolbar-button';
  private separatorId = 'zotseek-toolbar-separator';
  private readerButtonClass = 'zotseek-reader-button';
  private menuRegistrationId: string | null = null;
  private iconCache: Record<string, string> = {};

  constructor() {
    this.logger = new Logger('ToolbarButton');
  }

  /**
   * Add toolbar button to the main window
   */
  public add(window: any): void {
    try {
      const doc = window.document;

      // Check if button already exists
      if (doc.getElementById(this.buttonId)) {
        this.logger.debug('Toolbar button already exists');
        return;
      }

      // Find the items toolbar (same approach as zotero-addons)
      const toolbar = doc.querySelector('#zotero-items-toolbar');

      if (!toolbar) {
        this.logger.warn('Could not find zotero-items-toolbar');
        return;
      }

      // Clone an existing toolbar button to inherit proper styling (like zotero-addons does)
      const lookupNode = toolbar.querySelector('#zotero-tb-lookup');

      if (!lookupNode) {
        this.logger.warn('Could not find lookup button to clone');
        // Fallback to creating button from scratch
        const button = this.createButtonFallback(doc);
        this.insertButton(toolbar, button);
        return;
      }

      // Clone the lookup button to get proper styling
      const button = lookupNode.cloneNode(true) as any;

      // Update the cloned button's attributes
      button.setAttribute('id', this.buttonId);
      button.setAttribute('label', 'SS');
      button.setAttribute('tooltiptext', getString('toolbar.openZotSeek'));
      button.setAttribute('command', '');
      button.setAttribute('oncommand', '');
      button.setAttribute('mousedown', '');
      button.setAttribute('onmousedown', '');

      // Set the icon (20x20 toolbar version)
      button.style.listStyleImage = 'url("chrome://zotseek/content/icons/icon-toolbar.svg")';

      // Add click handler
      button.addEventListener('click', () => {
        this.handleClick();
      });

      // Insert at the left of the toolbar
      this.insertButton(toolbar, button);

      this.logger.info('Toolbar button added successfully');
    } catch (error) {
      this.logger.error('Failed to add toolbar button:', error);
    }
  }

  /**
   * Fallback: Create the toolbar button element from scratch
   */
  private createButtonFallback(doc: any): any {
    const button = doc.createXULElement('toolbarbutton');

    button.id = this.buttonId;
    button.setAttribute('label', 'SS');
    button.setAttribute('tooltiptext', getString('toolbar.openZotSeek'));
    button.setAttribute('class', 'zotero-tb-button');

    // Set icon (20x20 toolbar version)
    button.style.listStyleImage = 'url("chrome://zotseek/content/icons/icon-toolbar.svg")';

    // Add click handler
    button.addEventListener('click', () => {
      this.handleClick();
    });

    return button;
  }

  /**
   * Insert the button after the default toolbar buttons (before search) with a separator
   */
  private insertButton(toolbar: any, button: any): void {
    const doc = toolbar.ownerDocument;
    const searchBox = toolbar.querySelector('#zotero-tb-search');
    
    // Create a separator to visually separate from search
    const separator = doc.createXULElement('toolbarseparator');
    separator.id = this.separatorId;
    
    if (searchBox) {
      // Insert button, then separator before search box
      toolbar.insertBefore(separator, searchBox);
      toolbar.insertBefore(button, separator);
    } else {
      toolbar.appendChild(button);
      toolbar.appendChild(separator);
    }
  }

  /**
   * Handle button click
   */
  private handleClick(): void {
    try {
      this.logger.info('Toolbar button clicked - opening search dialog');
      searchDialogWithVTable.open();
    } catch (error) {
      this.logger.error('Failed to open search dialog:', error);
    }
  }

  /**
   * Remove the toolbar button and separator
   */
  public remove(window: any): void {
    try {
      const doc = window.document;
      const button = doc.getElementById(this.buttonId);
      const separator = doc.getElementById(this.separatorId);

      if (button) {
        button.remove();
      }
      if (separator) {
        separator.remove();
      }
      this.logger.info('Toolbar button removed');
    } catch (error) {
      this.logger.error('Failed to remove toolbar button:', error);
    }
  }

  /**
   * Register menu item in Tools menu using Zotero MenuManager API
   */
  public registerToolsMenu(window: any): void {
    try {
      // Register the FTL localization file
      window.MozXULElement.insertFTLIfNeeded('zotseek-menu.ftl');

      // Check if MenuManager is available (Zotero 8+)
      if (!Zotero.MenuManager) {
        this.logger.warn('MenuManager not available - skipping Tools menu registration');
        return;
      }

      this.menuRegistrationId = Zotero.MenuManager.registerMenu({
        menuID: 'zotseek-menuTools',
        pluginID: 'zotseek@zotero.org',
        target: 'main/menubar/tools',
        menus: [
          {
            menuType: 'separator',
          },
          {
            menuType: 'menuitem',
            l10nID: 'zotseek-menuTools-search',
            icon: 'chrome://zotseek/content/icons/icon-toolbar.svg',
            onCommand: () => {
              this.handleClick();
            },
          },
        ],
      });

      this.logger.info('Tools menu item registered successfully');
    } catch (error) {
      this.logger.error('Failed to register Tools menu item:', error);
    }
  }

  /**
   * Unregister menu item from Tools menu
   */
  public unregisterToolsMenu(): void {
    try {
      if (this.menuRegistrationId && Zotero.MenuManager) {
        Zotero.MenuManager.unregisterMenu(this.menuRegistrationId);
        this.menuRegistrationId = null;
        this.logger.info('Tools menu item unregistered');
      }
    } catch (error) {
      this.logger.error('Failed to unregister Tools menu item:', error);
    }
  }

  // ============================================
  // Reader Window Toolbar
  // ============================================

  /**
   * Register toolbar button in Reader windows
   * Uses Zotero.Reader.registerEventListener to add button to PDF reader toolbar
   */
  public async registerReaderToolbar(): Promise<void> {
    try {
      // Pre-cache the icon
      await this.getIcon('chrome://zotseek/content/icons/icon-toolbar.svg');

      // Register event listener for new reader windows
      Zotero.Reader.registerEventListener(
        'renderToolbar',
        (event: any) => this.readerToolbarCallback(event),
        PLUGIN_ID
      );

      // Add button to any already-open readers
      if (Zotero.Reader._readers) {
        for (const reader of Zotero.Reader._readers) {
          await this.buildReaderButton(reader);
        }
      }

      this.logger.info('Reader toolbar button registered');
    } catch (error) {
      this.logger.error('Failed to register reader toolbar button:', error);
    }
  }

  /**
   * Unregister reader toolbar button event listener
   */
  public unregisterReaderToolbar(): void {
    try {
      // Zotero automatically cleans up event listeners registered with pluginID
      // when the plugin is disabled/uninstalled
      this.logger.info('Reader toolbar button unregistered');
    } catch (error) {
      this.logger.error('Failed to unregister reader toolbar button:', error);
    }
  }

  // ============================================
  // Reader Text Selection Context Menu
  // ============================================

  /**
   * Register context menu item for text selection in PDF reader
   * When user selects text and right-clicks, shows "Find Related Papers" option
   *
   * Based on: https://groups.google.com/g/zotero-dev/c/5fgn8bC_Z1U
   * Uses createViewContextMenu event to add menu items to text selection context menu
   */
  public async registerReaderContextMenu(): Promise<void> {
    try {
      Zotero.Reader.registerEventListener(
        'createViewContextMenu',
        (event: any) => this.readerContextMenuCallback(event),
        PLUGIN_ID
      );

      this.logger.info('Reader context menu registered');
    } catch (error) {
      this.logger.error('Failed to register reader context menu:', error);
    }
  }

  /**
   * Callback for reader view context menu (text selection)
   * Adds "Find Related Papers" option when text is selected
   */
  private readerContextMenuCallback(event: any): void {
    const { append, reader } = event;

    // Access selected text via internal reader API
    // Path discovered via zotero-dev discussion - may change in future versions
    // Zotero team considering adding event.params.selectedText officially
    const selectionRanges = reader._iframeWindow?.wrappedJSObject
      ?._reader?._primaryView?._selectionRanges;

    // Only show menu if text is selected
    if (!selectionRanges || selectionRanges.length === 0) {
      return;
    }

    // Extract text from selection ranges
    const selectedText = this.extractTextFromRanges(selectionRanges);

    // Skip if selection is too short (less than 3 chars)
    if (!selectedText || selectedText.trim().length < 3) {
      return;
    }

    // Get the current item ID to exclude from results
    // reader._item is the attachment (PDF), we want the parent item
    const currentItemId = this.getReaderItemId(reader);

    // Add the context menu item
    append({
      label: getString('menu.findRelated'),
      onCommand: () => {
        this.logger.info(`Context menu: searching for "${selectedText.substring(0, 50)}..." (excluding item ${currentItemId})`);
        searchDialogWithVTable.open(selectedText.trim(), currentItemId);
      }
    });
  }

  /**
   * Get the parent item ID from a reader instance
   * The reader shows an attachment (PDF), but we want the parent item (the paper)
   */
  private getReaderItemId(reader: any): number | undefined {
    try {
      const attachment = reader._item;
      if (!attachment) return undefined;

      // Get the parent item (the actual paper/article)
      if (attachment.parentItem) {
        return attachment.parentItem.id;
      } else if (attachment.parentItemID) {
        return attachment.parentItemID;
      }

      // If no parent, return the attachment's own ID
      return attachment.id;
    } catch (error) {
      this.logger.warn('Failed to get reader item ID:', error);
      return undefined;
    }
  }

  /**
   * Extract plain text from PDF selection ranges
   * Selection ranges are objects containing text content from the PDF viewer
   */
  private extractTextFromRanges(ranges: any[]): string {
    try {
      // Each range object should have a text property
      return ranges
        .map(r => r.text || '')
        .join(' ')
        .trim();
    } catch (error) {
      this.logger.warn('Failed to extract text from selection ranges:', error);
      return '';
    }
  }

  /**
   * Callback for reader toolbar render event
   */
  private readerToolbarCallback(event: any): void {
    const { append, doc, reader } = event;

    // Create the button element
    const button = doc.createElement('button');
    button.className = `toolbar-button ${this.readerButtonClass}`;
    button.tabIndex = -1;
    button.title = getString('toolbar.findSimilar');

    // Set the icon as innerHTML (inline SVG)
    const iconSvg = this.iconCache['chrome://zotseek/content/icons/icon-toolbar.svg'];
    if (iconSvg) {
      button.innerHTML = iconSvg;
    }

    // Add click handler - opens "Find Similar Documents" for the current item
    button.addEventListener('click', () => {
      this.handleReaderClick(reader);
    });

    // Append using the event's append function (handles cross-compartment issues)
    append(button);
  }

  /**
   * Handle click on reader toolbar button
   * Opens "Find Similar Documents" for the item being viewed
   */
  private handleReaderClick(reader: any): void {
    try {
      // Get the item being viewed in the reader
      // reader._item is the attachment (PDF), we need the parent item
      const attachment = reader._item;
      if (!attachment) {
        this.logger.warn('No item found in reader');
        return;
      }

      // Get the parent item (the actual paper/article)
      let item = attachment;
      if (attachment.parentItem) {
        item = attachment.parentItem;
        this.logger.debug(`Got parent item from attachment: ${item.id}`);
      } else if (attachment.parentItemID) {
        // Fallback: get parent by ID
        item = Zotero.Items.get(attachment.parentItemID);
        this.logger.debug(`Got parent item by ID: ${item?.id}`);
      }

      if (!item) {
        this.logger.warn('Could not get parent item from reader');
        return;
      }

      const title = item.getField('title') || attachment.getField('title');
      this.logger.info(`Reader button clicked - finding similar documents for: ${title} (ID: ${item.id})`);
      
      // Open the similar documents dialog for the parent item
      similarDocumentsWrapper.open(item);
    } catch (error) {
      this.logger.error('Failed to handle reader button click:', error);
    }
  }

  /**
   * Build reader button for an existing reader instance
   */
  private async buildReaderButton(reader: any): Promise<void> {
    try {
      await reader._initPromise;

      const customSections = reader._iframeWindow?.document.querySelector(
        '.toolbar .custom-sections'
      );

      if (!customSections) {
        return;
      }

      // Check if button already exists
      if (customSections.querySelector(`.${this.readerButtonClass}`)) {
        return;
      }

      const doc = customSections.ownerDocument;

      // Create the button directly here (since we need the reader reference for click handler)
      const button = doc.createElement('button');
      button.className = `toolbar-button ${this.readerButtonClass}`;
      button.tabIndex = -1;
      button.title = getString('toolbar.findSimilar');

      // Set the icon as innerHTML (inline SVG)
      const iconSvg = this.iconCache['chrome://zotseek/content/icons/icon-toolbar.svg'];
      if (iconSvg) {
        button.innerHTML = iconSvg;
      }

      // Add click handler with reader reference
      button.addEventListener('click', () => {
        this.handleReaderClick(reader);
      });

      // Append with cross-compartment cloning
      customSections.append(
        Components.utils.cloneInto(button, reader._iframeWindow, {
          wrapReflectors: true,
          cloneFunctions: true,
        })
      );
    } catch (error) {
      this.logger.error('Failed to build reader button:', error);
    }
  }

  /**
   * Load and cache an icon SVG
   */
  private async getIcon(src: string): Promise<string> {
    if (this.iconCache[src]) {
      return this.iconCache[src];
    }

    try {
      const response = await Zotero.HTTP.request('GET', src, {});
      this.iconCache[src] = response.response;
      return response.response;
    } catch (error) {
      this.logger.error('Failed to load icon:', src, error);
      return '';
    }
  }
}

// Export singleton instance
export const toolbarButton = new ToolbarButton();
