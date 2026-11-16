// src/web/markdown.ts is the one place where text from a person, a web page or the model becomes HTML. These
// tests hold it to its promise: a fixed set of tags, links to http(s) only, and nothing typed passes through raw.
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { looksFormatted, markdown } from '../src/web/markdown.ts';

const render = (s: string) => String(markdown(s));
const ALLOWED = new Set(['p', 'br', 'strong', 'em', 'code', 'a', 'ul', 'ol', 'li', 'h3', 'h4', 'blockquote', 'hr']);
const tagsIn = (out: string) => [...out.matchAll(/<\/?([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1].toLowerCase());

describe('Markdown rendering', () => {
  test('the constructs it knows', () => {
    assert.equal(render('# Title\n\nSome **bold** and *slanted* and `code`.'), '<h3>Title</h3><p>Some <strong>bold</strong> and <em>slanted</em> and <code>code</code>.</p>');
    assert.equal(render('- one\n- two\n\n1. first\n2. second'), '<ul><li>one</li><li>two</li></ul><ol><li>first</li><li>second</li></ol>');
    assert.equal(render('- [ ] milk\n- [x] eggs'), '<ul><li class="task">☐ milk</li><li class="task">☑ eggs</li></ul>');
    assert.equal(render('> said once\n\n---'), '<blockquote><p>said once</p></blockquote><hr />');
    assert.equal(render('line one\nline two'), '<p>line one<br />line two</p>');
    assert.equal(
      render('See [the menu](https://example.com/menu) or https://example.com/hours.'),
      '<p>See <a href="https://example.com/menu" target="_blank" rel="noopener noreferrer nofollow">the menu</a> or <a href="https://example.com/hours" target="_blank" rel="noopener noreferrer nofollow">https://example.com/hours</a>.</p>',
    );
  });

  const hostile: [string, string][] = [
    ['a script tag', '<script>alert(1)</script>'],
    ['an image with a handler', '<img src=x onerror=alert(1)>'],
    ['a tag inside bold', '**<b onmouseover=alert(1)>x</b>**'],
    ['a tag inside code', '`<svg onload=alert(1)>`'],
    ['a tag inside a heading', '# <iframe src="https://evil.example"></iframe>'],
    ['a tag inside a list item', '- <a href="javascript:alert(1)">tap</a>'],
    ['a tag inside a quote', '> <style>body{display:none}</style>'],
    ['a javascript link', '[tap me](javascript:alert(1))'],
    ['a data link', '[tap me](data:text/html,<script>alert(1)</script>)'],
    ['a link that breaks out of its attribute', '[x](https://example.com/"onmouseover="alert(1))'],
    ['a link label with a tag', '[<img src=x onerror=alert(1)>](https://example.com)'],
    ['a bare address that breaks out', 'https://example.com/"><script>alert(1)</script>'],
    ['an entity that would become a tag', '&lt;script&gt;alert(1)&lt;/script&gt;'],
    ['a half-open tag across lines', '<scr\nipt>alert(1)</scr\nipt>'],
  ];
  for (const [name, input] of hostile) {
    test(`${name} comes out as text`, () => {
      const out = render(input);
      const strange = tagsIn(out).filter((t) => !ALLOWED.has(t));
      assert.deepEqual(strange, [], out);
      assert.doesNotMatch(out, /<[^>]+\son[a-z]+\s*=/i, `no handler attribute: ${out}`);
      for (const m of out.matchAll(/<a\s[^>]*href="([^"]*)"/g)) assert.match(m[1], /^https?:\/\//, `only http(s) links: ${out}`);
      for (const m of out.matchAll(/<a\s([^>]*)>/g)) assert.match(m[1], /^href="[^"]*" target="_blank" rel="noopener noreferrer nofollow"$/, `a link carries nothing extra: ${out}`);
    });
  }

  test('plain values are not treated as Markdown, and formatted ones are', () => {
    assert.equal(looksFormatted('Corner table by the window'), false);
    assert.equal(looksFormatted('A12-345 #7'), false);
    assert.equal(looksFormatted('- flour\n- eggs'), true);
    assert.equal(looksFormatted('Use **cold** butter'), true);
  });
});
