/**
 * Preferences pane handler
 * Manages the preference window UI and interactions
 */

import { getZotero } from '../utils/zotero-helper';
import { getString, translateDOM } from '../utils/locale';
import { autoIndexManager } from '../core/auto-index-manager';

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
      // Translate UI strings
      translateDOM(window.document);

      // Initialize preferences
      this.initPreferences();

      // Show Zotero 7 performance warning only on Zotero 7 (Firefox < 128)
      this.initVersionWarning();

      // Set up event listeners
      this.initEventListeners();

      // Auto-load stats
      await this.loadStatsAndCheckMismatch();

      this.logger.info('Preference pane initialized successfully');
    } catch (error) {
      this.logger.error(`Failed to initialize preferences: ${error}`);
    }
  }

  /**
   * Show performance warning only on Zotero 7 (Firefox < 128)
   */
  private initVersionWarning(): void {
    if (!this.window) return;
    const doc = this.window.document;
    const Z = getZotero();
    if (!Z) return;

    const perfWarning = doc.getElementById('zotseek-perf-warning');
    if (perfWarning) {
      // Show warning only on Firefox < 128 (Zotero 7)
      const platformVersion = Z.platformMajorVersion || 0;
      const isZotero7 = platformVersion > 0 && platformVersion < 128;
      perfWarning.style.display = isZotero7 ? 'block' : 'none';
      this.logger.debug(`Performance warning ${isZotero7 ? 'shown' : 'hidden'} (Firefox ${platformVersion})`);
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

    this.setInputValue('zotseek-pref-autoIndexDelay', prefs.autoIndexDelay);

    // Show/hide delay row based on auto-index state
    this.updateAutoIndexDelayVisibility(prefs.autoIndex);

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
      setText('zotseek-stat-avgchunks', stats.avgChunksPerPaper.toString());
      setText('zotseek-stat-storage', stats.storageSize);
      setText('zotseek-stat-dbpath', stats.databasePath || '-');
      setText('zotseek-stat-model', stats.modelId);
      setText('zotseek-stat-lastindexed', stats.lastIndexed);

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
          'abstract': getString('pref.abstractOnly'),
          'full': getString('pref.fullPaper')
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
      pw.changeHeadline(getString('pref.compacted'));
      pw.addDescription(result);
      pw.show();
      pw.startCloseTimer(4000);
      // Refresh stats to show new size
      await this.loadStatsAndCheckMismatch();
    } catch (e: any) {
      const pw = new Z.ProgressWindow({ closeOnClick: true });
      pw.changeHeadline(getString('pref.compactionFailed'));
      pw.addDescription(e?.message || String(e));
      pw.show();
      pw.startCloseTimer(4000);
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
   * Clean up when preference pane is closed
   */
  destroy(): void {
    this.window = null;
    this.logger.info('Preference pane destroyed');
  }
}

// Create singleton instance
export const preferencesManager = new PreferencesManager();
