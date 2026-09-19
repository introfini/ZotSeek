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

  test('separates table cells instead of gluing them together', () => {
    const html = '<table><tr><td>alpha</td><td>beta</td></tr><tr><td>gamma</td></tr></table>';
    const out = noteHtmlToText(html);
    assert.equal(out, 'alpha\n\nbeta\n\ngamma');
  });

  test('treats header cells as cells too', () => {
    const out = noteHtmlToText('<table><tr><th>Year</th><th>Result</th></tr></table>');
    assert.equal(out, 'Year\n\nResult');
  });

  test('turns a horizontal rule into a paragraph break', () => {
    assert.equal(noteHtmlToText('<p>above</p><hr/><p>below</p>'), 'above\n\nbelow');
    assert.equal(noteHtmlToText('above<hr>below'), 'above\n\nbelow');
  });

  test('survives unclosed tags without losing text', () => {
    assert.equal(noteHtmlToText('<p>unclosed'), 'unclosed');
  });
});
