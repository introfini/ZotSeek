/**
 * Zotero notes are stored as HTML. Embedding models want plain text, and the
 * chunker splits on blank lines, so block-level markup has to become paragraph
 * breaks rather than disappear. Entities are unescaped only after tags are
 * stripped, so an escaped `&lt;p&gt;` in the note body is never mistaken for
 * markup.
 */

const ENTITIES: Record<string, string> = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&apos;': "'",
  '&nbsp;': ' ',
};

function unescapeEntities(text: string): string {
  let out = text;
  for (const [entity, char] of Object.entries(ENTITIES)) {
    out = out.split(entity).join(char);
  }
  return out.replace(/&#(\d+);/g, (_m, code) => String.fromCharCode(Number(code)));
}

export function noteHtmlToText(html: string): string {
  if (!html) return '';

  let text = html;
  text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  text = text.replace(/<img\b[^>]*\/?>/gi, '');
  text = text.replace(/<br\s*\/?>/gi, '\n');
  text = text.replace(/<hr\b[^>]*\/?>/gi, '\n\n');
  text = text.replace(/<li\b[^>]*>/gi, '- ');
  // td/th get a single newline, not a paragraph break: Better Notes tables are
  // a stated use case, and without separating them at all
  // `<td>a</td><td>b</td>` collapses to `ab`, a run-on word instead of two
  // cells. But splitting them into their own paragraphs fragments a table row
  // into cells short enough (often well under 50 characters) to be discarded
  // by the chunker's short-paragraph filter, silently losing the row. A plain
  // `\n` keeps cells readably separated while `</tr>` still closes the row as
  // one paragraph, long enough to survive that filter.
  text = text.replace(/<\/(td|th)>/gi, '\n');
  text = text.replace(/<\/(p|div|li|h[1-6]|blockquote|tr|pre|ul|ol)>/gi, '\n\n');
  text = text.replace(/<[^>]*>/g, '');
  text = unescapeEntities(text);

  text = text.replace(/\r\n?/g, '\n');
  text = text.replace(/[ \t]+/g, ' ');
  text = text.replace(/ *\n */g, '\n');
  text = text.replace(/\n{3,}/g, '\n\n');

  return text.trim();
}
