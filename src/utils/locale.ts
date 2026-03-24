/**
 * Locale - Fluent-based i18n for ZotSeek
 * Uses Zotero 8's native Localization API backed by .ftl files.
 */

declare const Zotero: any;
declare const Localization: any;

let l10n: any = null;

function getL10n(): any {
  if (!l10n) {
    try {
      const LocalizationClass = typeof Localization !== 'undefined'
        ? Localization
        : (Zotero.getMainWindow() as any).Localization;
      l10n = new LocalizationClass(['zotseek.ftl'], true);
    } catch (e) {
      Zotero?.debug?.('[ZotSeek] Failed to initialize Localization: ' + e);
    }
  }
  return l10n;
}

/**
 * Get a localized string by Fluent message ID.
 * @param key - The message key WITHOUT 'zotseek-' prefix (e.g., 'menu-findSimilar')
 *              The prefix is added automatically.
 * @param args - Optional Fluent arguments (e.g., { count: 5 })
 */
export function getString(key: string, args?: Record<string, string | number>): string {
  const fullKey = 'zotseek-' + key;
  const loc = getL10n();
  if (!loc) return fullKey;

  try {
    const messages = loc.formatMessagesSync([{ id: fullKey, args }]);
    if (messages?.[0]?.value) {
      return messages[0].value;
    }
  } catch (e) {
    // Fluent may not be ready yet
  }
  return fullKey;
}
