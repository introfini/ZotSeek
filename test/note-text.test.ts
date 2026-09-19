import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { noteHtmlToText } from '../src/utils/note-text';

describe('noteHtmlToText', () => {
  test('returns empty string for empty or whitespace-only input', () => {
    assert.equal(noteHtmlToText(''), '');
    assert.equal(noteHtmlToText('   \n  '), '');
    assert.equal(noteHtmlToText('<p>   </p>'), '');
  });

  test('strips tags and keeps the text', () => {
    assert.equal(noteHtmlToText('<p>Hello <b>world</b></p>'), 'Hello world');
  });

  test('turns block tags into paragraph breaks so the chunker sees boundaries', () => {
    const out = noteHtmlToText('<p>First para</p><p>Second para</p>');
    assert.equal(out, 'First para\n\nSecond para');
  });

  test('turns br into a single line break', () => {
    assert.equal(noteHtmlToText('one<br>two'), 'one\ntwo');
  });

  test('removes images entirely, including data URIs', () => {
    const html = '<p>before<img src="data:image/png;base64,AAAA"/>after</p>';
    assert.equal(noteHtmlToText(html), 'beforeafter');
  });

  test('drops script and style content', () => {
    assert.equal(noteHtmlToText('<style>p{color:red}</style><p>kept</p>'), 'kept');
    assert.equal(noteHtmlToText('<script>alert(1)</script><p>kept</p>'), 'kept');
  });

  test('unescapes entities after tags are stripped', () => {
    assert.equal(noteHtmlToText('<p>a &amp; b</p>'), 'a & b');
    assert.equal(noteHtmlToText('<p>&lt;p&gt; is a tag</p>'), '<p> is a tag');
    assert.equal(noteHtmlToText('<p>hard&nbsp;space</p>'), 'hard space');
    assert.equal(noteHtmlToText('<p>&#39;quoted&#39;</p>'), "'quoted'");
  });

  test('renders list items as dashed lines', () => {
    const out = noteHtmlToText('<ul><li>one</li><li>two</li></ul>');
    assert.match(out, /- one/);
    assert.match(out, /- two/);
  });

  test('collapses runs of blank lines to a single paragraph break', () => {
    const out = noteHtmlToText('<p>a</p><p></p><p></p><p>b</p>');
    assert.equal(out, 'a\n\nb');
  });

  test('separates table cells without breaking the row into separate paragraphs', () => {
    const html = '<table><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td></tr></table>';
    const out = noteHtmlToText(html);
    // Cells within a row are joined by a single newline (readable, not glued
    // together), while rows themselves stay separated by a paragraph break.
    assert.equal(out, 'alpha\nbeta\n\ngamma');
  });

  test('treats header cells as cells too, joined within the row by a single newline', () => {
    const out = noteHtmlToText('<table><tr><th>Year</th><th>Result</th></tr></table>');
    assert.equal(out, 'Year\nResult');
  });

  test('keeps a whole table row as one paragraph, not one paragraph per cell', () => {
    // This is the regression this test pins: an earlier fix made `</td>`/`</th>`
    // produce a paragraph break (`\n\n`), which stopped cells from gluing
    // together but fragmented every row into its own short paragraph. Those
    // fragments are exactly the kind the chunker's short-paragraph filter
    // discards downstream (chunker.ts:357), so a row survived here only to be
    // silently dropped later. A row must come out as a single paragraph: no
    // `\n\n` inside it, only between rows.
    const html =
      '<table><tr><td>alpha</td><td>beta</td><td>gamma</td></tr><tr><td>delta</td></tr></table>';
    const out = noteHtmlToText(html);
    const paragraphs = out.split('\n\n');
    assert.equal(paragraphs.length, 2);
    assert.equal(paragraphs[0], 'alpha\nbeta\ngamma');
    assert.equal(paragraphs[1], 'delta');
  });

  test('turns a horizontal rule into a paragraph break', () => {
    assert.equal(noteHtmlToText('<p>above</p><hr/><p>below</p>'), 'above\n\nbelow');
    assert.equal(noteHtmlToText('above<hr>below'), 'above\n\nbelow');
  });

  test('survives unclosed tags without losing text', () => {
    assert.equal(noteHtmlToText('<p>unclosed'), 'unclosed');
  });
});
