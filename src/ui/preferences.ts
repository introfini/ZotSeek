/**
 * Preferences pane handler
 * Manages the preference window UI and interactions
 */

import { getZotero } from '../utils/zotero-helper';
import { getString } from '../utils/locale';
import { autoIndexManager } from '../core/auto-index-manager';

declare const Services: any;

class PreferencesManager {
  private window: Window | null = null;
  private logger: any;

  constructor() {
    const Z = getZotero();
    this.logger = {
      info: (msg: string) => Z?.debug(`[ZotSeek] [Preferences] ${msg}`),
      error: (msg: string) => Z?.debug(`[ZotSeek] [ERROR] [Preferences] ${msg}`),
      debug: (msg: string) => Z?.debug(`[ZotSeek] [DEBUG] [Preferences] ${msg}`)
    };
  }

  /**
   * Initialize the preference pane
   */
  async init(window: Window): Promise<void> {
    this.window = window;
    this.logger.info('Initializing preference pane');

    try {
      // Register FTL for localization (linkset in sub-pane XHTML isn't processed)
      (window as any).MozXULElement?.insertFTLIfNeeded('zotseek.ftl');

      // Initialize preferences
      this.initPreferences();

      // Set up event listeners
      this.initEventListeners();

      // Auto-load stats
      await this.loadStatsAndCheckMismatch();

      // Auto-load database health stats (orphan count)
      await this.loadHealthStats();

      // Auto-load reclaimable space info for the Compact Database button
      await this.loadCompactionInfo();

      this.logger.info('Preference pane initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize preferences: ${error}`);
    }
  }

  /**
   * Initialize preference values in UI elements
   */
  private initPreferences(): void {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z) return;

    // Read current preference values
    const prefs = {
      indexingMode: Z.Prefs.get('zotseek.indexingMode', true) || 'abstract',
      maxTokens: Z.Prefs.get('zotseek.maxTokens', true) ?? 7500,
      maxChunksPerPaper: Z.Prefs.get('zotseek.maxChunksPerPaper', true) ?? 5,
      topK: Z.Prefs.get('zotseek.topK', true) ?? 20,
      minSimilarity: Z.Prefs.get('zotseek.minSimilarityPercent', true) ?? 30,
      excludeBooks: Z.Prefs.get('zotseek.excludeBooks', true) ?? true,
      excludeTag: Z.Prefs.get('zotseek.excludeTag', true) || 'zotseek-exclude',
      autoIndex: Z.Prefs.get('zotseek.autoIndex', true) ?? false,
      autoIndexDelay: Z.Prefs.get('zotseek.autoIndexDelay', true) ?? 10,
      mcpServer: Z.Prefs.get('zotseek.mcpServer.enabled', true) ?? false,
    };

    this.logger.debug(`Loaded preferences: ${JSON.stringify(prefs)}`);

    // Set menulist values
    this.setMenulistValue('zotseek-pref-indexingMode', prefs.indexingMode);

    // Set input values
    this.setInputValue('zotseek-pref-maxTokens', prefs.maxTokens);
    this.setInputValue('zotseek-pref-maxChunksPerPaper', prefs.maxChunksPerPaper);
    this.setInputValue('zotseek-pref-topK', prefs.topK);
    this.setInputValue('zotseek-pref-minSimilarity', prefs.minSimilarity);

    // Set checkbox values
    this.setCheckboxValue('zotseek-pref-excludeBooks', prefs.excludeBooks);
    this.setCheckboxValue('zotseek-pref-autoIndex', prefs.autoIndex);
    this.setCheckboxValue('zotseek-pref-mcpServer', prefs.mcpServer);

    this.setInputValue('zotseek-pref-autoIndexDelay', prefs.autoIndexDelay);

    // Show/hide delay row based on auto-index state
    this.updateAutoIndexDelayVisibility(prefs.autoIndex);

    // Show/hide MCP server info/warning based on pref and Zotero.Server state
    this.updateMcpServerVisibility(prefs.mcpServer);

    // Set text input values
    this.setInputValue('zotseek-pref-excludeTag', prefs.excludeTag);

    // Update mode cards to match current selection
    this.updateModeCards();
  }

  /**
   * Update the visual state of mode selection cards
   * Uses CSS classes for dark mode support
   */
  updateModeCards(): void {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z) return;

    const currentMode = Z.Prefs.get('zotseek.indexingMode', true) || 'abstract';

    // Abstract card elements
    const abstractCard = doc.getElementById('zotseek-mode-abstract-card') as HTMLElement;
    const abstractRadio = doc.getElementById('zotseek-mode-abstract-radio') as HTMLElement;

    // Full card elements
    const fullCard = doc.getElementById('zotseek-mode-full-card') as HTMLElement;
    const fullRadio = doc.getElementById('zotseek-mode-full-radio') as HTMLElement;

    // Helper to update radio dot (uses CSS variable for theme support)
    const updateRadio = (radio: HTMLElement | null, selected: boolean) => {
      if (!radio) return;
      // Use CSS variable for border color
      radio.style.borderColor = selected ? 'var(--zotseek-blue)' : 'var(--zotseek-text-tertiary)';
      // Clear existing children
      while (radio.firstChild) {
        radio.removeChild(radio.firstChild);
      }
      // Add dot if selected (uses CSS variable for theme support)
      if (selected) {
        const dot = doc.createElement('span');
        dot.style.cssText = 'width: 8px; height: 8px; background: var(--zotseek-blue); border-radius: 50%;';
        radio.appendChild(dot);
      }
    };

    // Helper to swap CSS classes for card selection state
    const setCardSelected = (card: HTMLElement | null, selected: boolean) => {
      if (!card) return;
      card.classList.remove('zotseek-mode-card-selected', 'zotseek-mode-card-unselected');
      card.classList.add(selected ? 'zotseek-mode-card-selected' : 'zotseek-mode-card-unselected');
    };

    if (currentMode === 'abstract') {
      // Abstract selected
      setCardSelected(abstractCard, true);
      updateRadio(abstractRadio, true);

      // Full unselected
      setCardSelected(fullCard, false);
      updateRadio(fullRadio, false);
    } else {
      // Full selected
      setCardSelected(fullCard, true);
      updateRadio(fullRadio, true);

      // Abstract unselected
      setCardSelected(abstractCard, false);
      updateRadio(abstractRadio, false);
    }
  }

  /**
   * Set up event listeners for UI elements
   */
  private initEventListeners(): void {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z) return;

    // Indexing mode change
    const indexingModeMenu = doc.getElementById('zotseek-pref-indexingMode') as any;
    if (indexingModeMenu) {
      indexingModeMenu.addEventListener('command', () => {
        const value = indexingModeMenu.selectedItem?.value;
        if (value) {
          Z.Prefs.set('zotseek.indexingMode', value, true);
          this.logger.info(`Indexing mode changed to: ${value}`);
          // Check for mismatch after changing
          this.loadStatsAndCheckMismatch();
        }
      });
    }

    // Number inputs
    const numberInputs = [
      { id: 'zotseek-pref-maxTokens', pref: 'zotseek.maxTokens' },
      { id: 'zotseek-pref-maxChunksPerPaper', pref: 'zotseek.maxChunksPerPaper' },
      { id: 'zotseek-pref-topK', pref: 'zotseek.topK' },
      { id: 'zotseek-pref-minSimilarity', pref: 'zotseek.minSimilarityPercent' }
    ];

    for (const { id, pref } of numberInputs) {
      const input = doc.getElementById(id) as HTMLInputElement;
      if (input) {
        input.addEventListener('change', () => {
          const value = parseInt(input.value, 10);
          if (!isNaN(value)) {
            Z.Prefs.set(pref, value, true);
            this.logger.debug(`${pref} changed to: ${value}`);
          }
        });
      }
    }

    // Checkbox inputs
    const excludeBooksCheckbox = doc.getElementById('zotseek-pref-excludeBooks') as any;
    if (excludeBooksCheckbox) {
      excludeBooksCheckbox.addEventListener('command', () => {
        const checked = excludeBooksCheckbox.checked;
        Z.Prefs.set('zotseek.excludeBooks', checked, true);
        this.logger.info(`Exclude books changed to: ${checked}`);
      });
    }

    const autoIndexCheckbox = doc.getElementById('zotseek-pref-autoIndex') as any;
    if (autoIndexCheckbox) {
      autoIndexCheckbox.addEventListener('command', () => {
        const checked = autoIndexCheckbox.checked;
        Z.Prefs.set('zotseek.autoIndex', checked, true);
        this.logger.info(`Auto-index changed to: ${checked}`);
        // Reload auto-index manager to apply new setting
        autoIndexManager.reload();
        this.updateAutoIndexDelayVisibility(checked);
      });
    }

    const mcpServerCheckbox = doc.getElementById('zotseek-pref-mcpServer') as any;
    if (mcpServerCheckbox) {
      mcpServerCheckbox.addEventListener('command', () => {
        const checked = mcpServerCheckbox.checked;
        Z.Prefs.set('zotseek.mcpServer.enabled', checked, true);
        this.logger.info(`MCP server enabled changed to: ${checked}`);
        this.updateMcpServerVisibility(checked);
      });
    }

    // Auto-index delay input
    const autoIndexDelayInput = doc.getElementById('zotseek-pref-autoIndexDelay') as HTMLInputElement;
    if (autoIndexDelayInput) {
      autoIndexDelayInput.addEventListener('change', () => {
        let value = parseInt(autoIndexDelayInput.value, 10);
        if (isNaN(value) || value < 1) value = 1;
        if (value > 300) value = 300;
        autoIndexDelayInput.value = String(value);
        Z.Prefs.set('zotseek.autoIndexDelay', value, true);
        this.logger.info(`Auto-index delay changed to: ${value}s`);
      });
    }

    // Exclude tag input
    const excludeTagInput = doc.getElementById('zotseek-pref-excludeTag') as HTMLInputElement;
    if (excludeTagInput) {
      excludeTagInput.addEventListener('change', () => {
        const value = excludeTagInput.value.trim();
        Z.Prefs.set('zotseek.excludeTag', value, true);
        this.logger.info(`Exclude tag changed to: "${value}"`);
      });
    }

    // Button event listeners
    const refreshBtn = doc.getElementById('zotseek-refresh-stats');
    if (refreshBtn) {
      refreshBtn.addEventListener('command', () => this.loadStatsAndCheckMismatch());
    }

    const clearBtn = doc.getElementById('zotseek-clear-index');
    if (clearBtn) {
      clearBtn.addEventListener('command', () => this.clearIndex());
    }

    const rebuildBtn = doc.getElementById('zotseek-rebuild-index');
    if (rebuildBtn) {
      rebuildBtn.addEventListener('command', () => this.rebuildIndex());
    }

    const updateBtn = doc.getElementById('zotseek-update-index');
    if (updateBtn) {
      updateBtn.addEventListener('command', () => this.updateIndex());
    }

    const compactBtn = doc.getElementById('zotseek-compact-db');
    if (compactBtn) {
      compactBtn.addEventListener('command', () => this.compactDatabase());
    }

    const purgeOrphansBtn = doc.getElementById('zotseek-purge-orphans-btn');
    if (purgeOrphansBtn) {
      purgeOrphansBtn.addEventListener('command', () => this.purgeOrphans());
    }
  }

  /**
   * Load database health stats (orphan count) and update the label.
   */
  async loadHealthStats(): Promise<void> {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z) return;

    try {
      const raw = await Z.DB.valueQueryAsync(
        'SELECT COUNT(*) FROM zotseek.orphan_items'
      );
      const count = Number(raw) || 0;
      const label = doc.getElementById('zotseek-orphan-count');
      if (label) {
        label.setAttribute('data-l10n-args', JSON.stringify({ count }));
        // Fallback text for environments where Fluent doesn't translate immediately.
        label.textContent = `Unresolved embeddings: ${count}`;
      }
      this.logger.debug(`Health stats loaded: ${count} orphans`);
    } catch (e: any) {
      this.logger.error(`loadHealthStats failed: ${e?.message || e}`);
    }
  }

  /**
   * Purge all orphan embeddings after user confirmation.
   */
  private async purgeOrphans(): Promise<void> {
    if (!this.window) return;
    const Z = getZotero();
    if (!Z) return;

    try {
      const before = Number(await Z.DB.valueQueryAsync(
        'SELECT COUNT(*) FROM zotseek.orphan_items'
      )) || 0;

      const confirmed = Services.prompt.confirm(
        this.window,
        'ZotSeek',
        'This will permanently delete embeddings for items not found in your current Zotero library. Continue?'
      );
      if (!confirmed) return;

      await Z.DB.executeTransaction(async () => {
        await Z.DB.queryAsync(
          `DELETE FROM zotseek.chunks WHERE item_pk IN (
             SELECT item_pk FROM zotseek.items WHERE library_key = 'orphan'
           )`
        );
        await Z.DB.queryAsync(
          `DELETE FROM zotseek.items WHERE library_key = 'orphan'`
        );
        await Z.DB.queryAsync(`DELETE FROM zotseek.orphan_items`);
      });

      this.logger.info(`Purged ${before} orphan entries`);

      // Refresh stats: orphan count and overall index stats (chunks/storage).
      await this.loadHealthStats();
      await this.loadStatsAndCheckMismatch();

      const pw = new Z.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline('Orphans Purged');
      pw.addDescription(`Removed ${before} unresolved entries.`);
      pw.show();
      pw.startCloseTimer(4000);
    } catch (e: any) {
      this.logger.error(`purgeOrphans failed: ${e?.message || e}`);
      const pw = new Z.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline('Purge Failed');
      pw.addDescription(e?.message || String(e));
      pw.show();
      pw.startCloseTimer(4000);
    }
  }

  /**
   * Load statistics and check for indexing mode mismatch
   */
  async loadStatsAndCheckMismatch(): Promise<void> {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z?.ZotSeek) return;

    const setText = (id: string, value: string) => {
      const el = doc.getElementById(id);
      if (el) el.textContent = value;
    };

    setText('zotseek-stat-papers', '...');

    try {
      const stats = await Z.ZotSeek.getStats();
      
      // Update all statistics
      setText('zotseek-stat-papers', stats.indexedPapers.toLocaleString());
      setText('zotseek-stat-chunks', stats.totalChunks.toLocaleString());
      setText('zotseek-stat-storage', stats.storageSize);
      setText('zotseek-stat-dbpath', stats.databasePath || '-');
      setText('zotseek-stat-model-line', getString('pref-modelLine', { model: stats.modelId }));
      setText('zotseek-stat-avg-line', getString('pref-avgLine', { avg: stats.avgChunksPerPaper }));
      setText('zotseek-stat-lastindexed-line', getString('pref-lastIndexedLine', { date: stats.lastIndexed }));

      // Handle index duration display
      const durationLabel = doc.getElementById('zotseek-stat-duration-label');
      const durationValue = doc.getElementById('zotseek-stat-duration');
      if (stats.lastIndexDuration) {
        setText('zotseek-stat-duration', stats.lastIndexDuration);
        if (durationLabel) durationLabel.style.display = 'block';
        if (durationValue) durationValue.style.display = 'block';
      } else {
        if (durationLabel) durationLabel.style.display = 'none';
        if (durationValue) durationValue.style.display = 'none';
      }

      // Handle indexed mode display and mismatch warning
      const indexedModeLabel = doc.getElementById('zotseek-stat-indexedmode-label');
      const indexedModeValue = doc.getElementById('zotseek-stat-indexedmode');
      const warningBox = doc.getElementById('zotseek-indexmode-warning');

      if (stats.indexedWithMode) {
        setText('zotseek-stat-indexedmode', stats.indexedWithMode);
        if (indexedModeLabel) indexedModeLabel.style.display = 'block';
        if (indexedModeValue) indexedModeValue.style.display = 'block';

        // Check for mismatch
        const currentMode = Z.Prefs.get('zotseek.indexingMode', true) || 'abstract';
        const currentModeLabel = {
          'abstract': getString('pref-abstractOnly'),
          'full': getString('pref-fullPaper')
        }[currentMode] || currentMode;

        if (warningBox) {
          if (stats.indexedWithMode !== currentModeLabel && stats.indexedPapers > 0) {
            // Show warning - there's a mismatch
            warningBox.style.display = 'block';
            const indexedModeEl = doc.getElementById('zotseek-warning-indexed-mode');
            const currentModeEl = doc.getElementById('zotseek-warning-current-mode');
            if (indexedModeEl) indexedModeEl.textContent = stats.indexedWithMode;
            if (currentModeEl) currentModeEl.textContent = currentModeLabel;
          } else {
            // Hide warning - modes match or no papers indexed
            warningBox.style.display = 'none';
          }
        }
      } else {
        // No indexed mode stored (old index)
        if (indexedModeLabel) indexedModeLabel.style.display = 'none';
        if (indexedModeValue) indexedModeValue.style.display = 'none';
        if (warningBox) warningBox.style.display = 'none';
      }

      this.logger.debug('Stats loaded successfully');
    } catch (error) {
      setText('zotseek-stat-papers', 'Error');
      this.logger.error(`Failed to load stats: ${error}`);
    }
  }

  /**
   * Clear the index
   */
  private async clearIndex(): Promise<void> {
    const Z = getZotero();
    if (Z?.ZotSeek) {
      await Z.ZotSeek.clearIndex();
      // Refresh stats after clearing
      await this.loadStatsAndCheckMismatch();
    }
  }

  /**
   * Rebuild the index
   */
  private async rebuildIndex(): Promise<void> {
    const Z = getZotero();
    if (Z?.ZotSeek) {
      await Z.ZotSeek.rebuildIndex();
      // Stats will be refreshed after rebuild completes
    }
  }

  /**
   * Update the index
   */
  private updateIndex(): void {
    const Z = getZotero();
    if (Z?.ZotSeek) {
      Z.ZotSeek.indexLibrary();
      // Stats will be refreshed after indexing completes
    }
  }

  /**
   * Compact the database to reclaim space
   */
  async compactDatabase(): Promise<void> {
    if (!this.window) return;
    const Z = (this.window as any).Zotero;
    if (!Z?.ZotSeek?.compactDatabase) return;

    try {
      const result = await Z.ZotSeek.compactDatabase();
      // Show success as a brief progress window
      const pw = new Z.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(getString('pref-compacted'));
      pw.addDescription(result);
      pw.show();
      pw.startCloseTimer(4000);
      // Refresh stats to show new size and clear the "reclaim X MB" hint
      await this.loadStatsAndCheckMismatch();
      await this.loadCompactionInfo();
    } catch (e: any) {
      const pw = new Z.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(getString('pref-compactionFailed'));
      pw.addDescription(e?.message || String(e));
      pw.show();
      pw.startCloseTimer(4000);
    }
  }

  /**
   * Update the Compact Database button label with the current reclaimable
   * space, so users can see when compaction is worthwhile without clicking.
   * SQLite leaves freed pages inside the file after DROP/DELETE — those
   * pages accumulate after migrations and orphan purges, then go away on
   * VACUUM.
   */
  async loadCompactionInfo(): Promise<void> {
    if (!this.window) return;
    const Z = (this.window as any).Zotero;
    const btn = this.window.document.getElementById('zotseek-compact-db') as any;
    if (!btn) return;
    const baseLabel = 'Compact Database';

    if (!Z?.ZotSeek?.getReclaimableBytes) {
      btn.setAttribute('label', baseLabel);
      return;
    }

    try {
      const bytes = Number(await Z.ZotSeek.getReclaimableBytes()) || 0;
      // Below ~10 MB: keep the plain label; the cost of running VACUUM isn't
      // worth a single-digit-MB win, and the noisy "reclaim 2 MB" hint just
      // trains people to ignore it.
      if (bytes < 10 * 1024 * 1024) {
        btn.setAttribute('label', baseLabel);
        btn.removeAttribute('data-l10n-id');
        return;
      }
      const mb = bytes / (1024 * 1024);
      const display = mb >= 1024
        ? `${(mb / 1024).toFixed(1)} GB`
        : `${mb.toFixed(0)} MB`;
      btn.setAttribute('label', `${baseLabel} (reclaim ${display})`);
      // Override Fluent so our dynamic label isn't replaced at next pass.
      btn.removeAttribute('data-l10n-id');
      this.logger.debug(`Reclaimable space: ${display}`);
    } catch (e: any) {
      this.logger.warn(`loadCompactionInfo failed: ${e?.message || e}`);
      btn.setAttribute('label', baseLabel);
    }
  }

  /**
   * Helper to set menulist value
   */
  private setMenulistValue(menulistId: string, value: any): void {
    if (!this.window) return;
    const menulist = this.window.document.getElementById(menulistId) as any;
    if (!menulist) return;

    const strValue = String(value);
    const menupopup = menulist.querySelector('menupopup');
    if (menupopup) {
      const items = menupopup.querySelectorAll('menuitem');
      for (let i = 0; i < items.length; i++) {
        if (items[i].getAttribute('value') === strValue) {
          menulist.selectedIndex = i;
          break;
        }
      }
    }
  }

  /**
   * Helper to set input value
   */
  private setInputValue(inputId: string, value: any): void {
    if (!this.window) return;
    const input = this.window.document.getElementById(inputId) as HTMLInputElement;
    if (input && value !== undefined) {
      input.value = String(value);
    }
  }

  /**
   * Helper to set checkbox value
   */
  private setCheckboxValue(checkboxId: string, checked: boolean): void {
    if (!this.window) return;
    const checkbox = this.window.document.getElementById(checkboxId) as any;
    if (checkbox) {
      checkbox.checked = checked;
    }
  }

  /**
   * Show/hide the auto-index delay row based on checkbox state
   */
  private updateAutoIndexDelayVisibility(enabled: boolean): void {
    if (!this.window) return;
    const delayRow = this.window.document.getElementById('zotseek-autoindex-delay-row');
    if (delayRow) {
      (delayRow as HTMLElement).style.opacity = enabled ? '1' : '0.4';
      const input = this.window.document.getElementById('zotseek-pref-autoIndexDelay') as HTMLInputElement;
      if (input) input.disabled = !enabled;
    }
  }

  /**
   * Show/hide the MCP server info box and warning based on enabled state
   * and whether Zotero's local HTTP server is active.
   */
  private updateMcpServerVisibility(enabled: boolean): void {
    if (!this.window) return;
    const doc = this.window.document;
    const infoDiv = doc.getElementById('zotseek-mcpserver-info') as HTMLElement | null;
    const warningEl = doc.getElementById('zotseek-mcpserver-warning') as HTMLElement | null;
    const cmdEl = doc.getElementById('zotseek-mcpserver-command') as HTMLElement | null;

    if (!enabled) {
      if (infoDiv) infoDiv.style.display = 'none';
      if (warningEl) warningEl.style.display = 'none';
      return;
    }

    // Check if Zotero's local HTTP server is running
    const Z = getZotero();
    const port = (Z as any)?.Server?.port;

    if (port) {
      if (infoDiv) infoDiv.style.display = 'block';
      if (warningEl) warningEl.style.display = 'none';
      // Update command with actual port if it differs from the default
      if (cmdEl && port !== 23119) {
        cmdEl.textContent = `claude mcp add --transport http zotseek http://localhost:${port}/zotseek/mcp`;
      } else if (cmdEl) {
        cmdEl.textContent = 'claude mcp add --transport http zotseek http://localhost:23119/zotseek/mcp';
      }
    } else {
      if (infoDiv) infoDiv.style.display = 'none';
      if (warningEl) warningEl.style.display = 'block';
    }
  }

  /**
   * Clean up when preference pane is closed
   */
  destroy(): void {
    this.window = null;
    this.logger.info('Preference pane destroyed');
  }
}

// Create singleton instance
export const preferencesManager = new PreferencesManager();
