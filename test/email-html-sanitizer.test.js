/**
 * @jest-environment jsdom
 */
// test/email-html-sanitizer.test.js — the XSS gate on the E2 reading pane.
//
// (The docblock above must be the FIRST thing in the file — Jest only
// reads the environment pragma out of the leading comment.)
//
// Email bodies are the most hostile input Project 86 renders: arbitrary
// third-party HTML from anyone who can reach the dropbox address. The
// reading pane defends in two independent layers —
//   1. sanitizeEmailHtml() strips dangerous nodes/attributes (THIS FILE),
//   2. the body is then rendered in an iframe with sandbox (no
//      allow-scripts) and a CSP that permits only inline styles and
//      data: images.
// Layer 2 is what makes a miss in layer 1 survivable, but layer 1 is what
// these tests hold the line on. They also cover the tracking-pixel rule
// from docs/email-hub-premium.md: remote images NEVER load by default.
//
// js/email-hub.js is a browser IIFE that needs a DOM, so the suite runs
// under jsdom and loads the file into that window.

const fs = require('fs');
const path = require('path');

let sanitize;

beforeAll(() => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'email-hub.js'), 'utf8');
  // INDIRECT eval, so the IIFE evaluates in the global scope where jsdom's
  // window/document/localStorage live. (vm.runInThisContext would drop it
  // into the Node VM context instead, where `document` does not exist.)
  // The module needs nothing else and registers window.p86EmailHub on load.
  // eslint-disable-next-line no-eval
  (0, eval)(src);
  sanitize = window.p86EmailHub.__sanitize;
});

describe('sanitizeEmailHtml — script execution', () => {
  test('removes script tags entirely', () => {
    const r = sanitize('<p>hi</p><script>alert(1)</script>');
    expect(r.html).not.toMatch(/script/i);
    expect(r.html).toContain('hi');
  });

  test('removes every inline event handler, whatever the casing', () => {
    const r = sanitize('<div onclick="steal()" OnMouseOver="x()" ONLOAD="y()">t</div>');
    expect(r.html.toLowerCase()).not.toContain('onclick');
    expect(r.html.toLowerCase()).not.toContain('onmouseover');
    expect(r.html.toLowerCase()).not.toContain('onload');
    expect(r.html).toContain('t');
  });

  test('strips javascript: hrefs', () => {
    const r = sanitize('<a href="javascript:alert(1)">click</a>');
    expect(r.html).not.toMatch(/javascript:/i);
    expect(r.html).toContain('click');
  });

  test('strips javascript: hidden behind whitespace and control characters', () => {
    // The classic filter bypass — "java\tscript:" and "java\0script:" are
    // both live URLs in some parsers.
    const TAB = String.fromCharCode(9), NUL = String.fromCharCode(0), LF = String.fromCharCode(10);
    ['java' + TAB + 'script:alert(1)',
     'java' + NUL + 'script:alert(1)',
     'java' + LF + 'script:alert(1)',
     '  JaVaScRiPt:alert(1)'].forEach((url) => {
      const r = sanitize('<a href="' + url + '">x</a>');
      expect(r.html.toLowerCase()).not.toContain('alert(1)');
    });
  });

  test('strips vbscript: and data:text/html URLs', () => {
    expect(sanitize('<a href="vbscript:msgbox(1)">x</a>').html).not.toMatch(/vbscript:/i);
    expect(sanitize('<a href="data:text/html;base64,PHNjcmlwdD4=">x</a>').html).not.toMatch(/data:text\/html/i);
  });

  test('blocks every data: URL except images', () => {
    // data:image is inert — it fetches nothing. data:text/html and
    // data:application/* are same-origin document injections.
    ['data:text/html,<script>alert(1)</script>',
     'data:application/xhtml+xml,<html/>',
     'data:text/javascript,alert(1)'].forEach((url) => {
      expect(sanitize('<a href="' + url + '">x</a>').html).not.toContain('data:');
    });
    const okImg = sanitize('<img src="data:image/png;base64,iVBORw0KGgo=">').html;
    expect(okImg).toContain('data:image/png');
  });

  test('removes embedding vectors (iframe / object / embed / form / input)', () => {
    const r = sanitize(
      '<iframe src="https://evil.test"></iframe>' +
      '<object data="x.swf"></object><embed src="x">' +
      '<form action="https://evil.test"><input name="pw"></form>' +
      '<p>body</p>'
    );
    ['iframe', 'object', 'embed', 'form', 'input'].forEach((tag) => {
      expect(r.html.toLowerCase()).not.toContain('<' + tag);
    });
    expect(r.html).toContain('body');
  });

  test('removes base and meta so a message cannot rewrite relative URLs or refresh', () => {
    const r = sanitize('<base href="https://evil.test/"><meta http-equiv="refresh" content="0;url=https://evil.test"><p>x</p>');
    expect(r.html.toLowerCase()).not.toContain('<base');
    expect(r.html.toLowerCase()).not.toContain('<meta');
  });
});

describe('sanitizeEmailHtml — tracking pixels', () => {
  test('blocks remote images by default and counts them', () => {
    const r = sanitize('<img src="https://tracker.test/p.gif?u=123"><img src="http://x.test/a.png">');
    expect(r.blockedImages).toBe(2);
    expect(r.html).not.toContain('tracker.test');
    expect(r.html).not.toContain('x.test');
    expect(r.html).toContain('data-blocked');
  });

  test('keeps inline data: images — they phone nobody', () => {
    const px = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
    const r = sanitize('<img src="' + px + '">');
    expect(r.blockedImages).toBe(0);
    expect(r.html).toContain('data:image/gif');
  });

  test('loads remote images only when explicitly asked', () => {
    const r = sanitize('<img src="https://tracker.test/p.gif">', { showImages: true });
    expect(r.blockedImages).toBe(0);
    expect(r.html).toContain('tracker.test');
  });

  test('strips srcset / background / lowsrc, which would smuggle a remote fetch past the src rewrite', () => {
    const r = sanitize('<img src="https://a.test/x.png" srcset="https://b.test/2x.png 2x" lowsrc="https://c.test/l.png">' +
                       '<td background="https://d.test/bg.png">c</td>');
    expect(r.html).not.toContain('b.test');
    expect(r.html).not.toContain('c.test');
    expect(r.html).not.toContain('d.test');
  });
});

describe('sanitizeEmailHtml — link hygiene', () => {
  test('forces target=_blank and a noopener/noreferrer rel on every link', () => {
    const r = sanitize('<a href="https://ok.test/page">go</a>');
    expect(r.html).toContain('target="_blank"');
    expect(r.html).toMatch(/rel="[^"]*noopener/);
    expect(r.html).toMatch(/rel="[^"]*noreferrer/);
  });

  test('leaves ordinary http(s) and mailto links intact', () => {
    expect(sanitize('<a href="https://ok.test/x">a</a>').html).toContain('https://ok.test/x');
    expect(sanitize('<a href="mailto:a@b.test">a</a>').html).toContain('mailto:a@b.test');
  });
});

describe('sanitizeEmailHtml — quoted text', () => {
  test('drops quoted blocks by default and reports that they exist', () => {
    const r = sanitize('<p>my reply</p><blockquote>the whole thread</blockquote>');
    expect(r.hasQuotes).toBe(true);
    expect(r.html).toContain('my reply');
    expect(r.html).not.toContain('the whole thread');
  });

  test('keeps them when the reader asks', () => {
    const r = sanitize('<p>my reply</p><blockquote>the whole thread</blockquote>', { showQuotes: true });
    expect(r.html).toContain('the whole thread');
  });

  test('recognizes the Gmail and Outlook quote containers too', () => {
    expect(sanitize('<div class="gmail_quote">old</div><p>new</p>').hasQuotes).toBe(true);
    expect(sanitize('<div id="divRplyFwdMsg">old</div><p>new</p>').hasQuotes).toBe(true);
  });

  test('reports no quotes on a plain message', () => {
    expect(sanitize('<p>just a note</p>').hasQuotes).toBe(false);
  });
});

describe('sanitizeEmailHtml — robustness', () => {
  test('survives empty / null / non-string input', () => {
    [null, undefined, '', 0, {}].forEach((bad) => {
      const r = sanitize(bad);
      expect(typeof r.html).toBe('string');
      expect(r.blockedImages).toBe(0);
    });
  });

  test('survives malformed markup without throwing', () => {
    expect(() => sanitize('<div><p>unclosed <b>bold <script>x')).not.toThrow();
  });

  test('keeps the layout markup real emails depend on', () => {
    const r = sanitize('<table><tr><td style="padding:8px">cell</td></tr></table><style>p{color:red}</style>');
    expect(r.html).toContain('<table');
    expect(r.html).toContain('cell');
    expect(r.html).toContain('padding:8px');
  });
});
