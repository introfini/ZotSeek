/**
 * Wrapper for opening the Similar Documents dialog
 */

import { Logger } from '../utils/logger';
import { getZotero } from '../utils/zotero-helper';

class SimilarDocumentsWrapper {
  private logger: Logger;

  constructor() {
    this.logger = new Logger('SimilarDocumentsWrapper');
  }

  /**
   * Open the similar documents dialog for a given item.
   * Passes only the item ID (a primitive) to avoid cross-window
   * XPCOM dead wrapper issues. The dialog re-fetches the item.
   */
  open(sourceItem: any): void {
    const Z = getZotero();
    if (!Z) {
      this.logger.error('Zotero not available');
      return;
    }

    try {
      const windowArgs = {
        sourceItemId: sourceItem.id,
        sourceTitle: sourceItem.getField('title'),
      };

      const win = Z.getMainWindow().openDialog(
        'chrome://zotseek/content/similarDocumentsDialog.xhtml',
        '',
        'chrome,centerscreen,resizable,dialog=no,width=900,height=600',
        windowArgs
      );

      if (win) {
        this.logger.info('Similar documents dialog opened');
      } else {
        this.logger.error('Failed to open similar documents dialog');
      }
    } catch (error) {
      this.logger.error('Error opening similar documents dialog:', error);
    }
  }
}

export const similarDocumentsWrapper = new SimilarDocumentsWrapper();
