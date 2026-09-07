// Render a report document to a PDF, server-side.
//
// ── WHY THIS USES THE BROWSER'S OWN RENDERER ────────────────────────────
// The document is drawn by js/report-document.js — the SAME file the preview,
// the printed page and the public portal use. It can run here because it is
// pure: no DOM, no ambient state, a `doc` object in and an HTML string out.
// test/report-document-render.test.js already proves that by executing it in a
// bare sandbox, which is exactly what this service does at runtime.
//
// The alternative — pdfkit or pdfmake — means hand-drawing the document a
// second time. That is a second renderer, and this codebase has already paid
// for what two renderers cost: printed page breaks that disagreed with the
// preview, for months. A PDF that quietly differs from what the author
// approved is the same bug with a longer feedback loop.
//
// ── WHY CHROMIUM ────────────────────────────────────────────────────────
// Turning that HTML into pages with real pagination, image scaling and page
// breaks needs a layout engine. There is no lightweight pure-JS substitute
// that honours the CSS this document depends on.
//
// Rendering is ON DEMAND, never on publish: a report is shared far more often
// than it is filed, and Chromium is the most expensive thing this server does.
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..', '..');

// Load the browser renderer into a bare sandbox. Cached: reading and compiling
// it per request would be wasteful, and the module holds no state between
// calls (it exposes two pure functions).
let _renderer = null;
function renderer() {
  if (_renderer) return _renderer;
  const src = fs.readFileSync(path.join(ROOT, 'js', 'report-document.js'), 'utf8');
  const win = {};
  const sandbox = { window: win, console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: 'report-document.js' });
  if (!win.p86ReportDocument || typeof win.p86ReportDocument.render !== 'function') {
    throw new Error('report-document.js did not expose a renderer');
  }
  _renderer = win.p86ReportDocument;
  return _renderer;
}

function readCss(rel) {
  try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
  catch (e) { return ''; }
}

// One stylesheet for the document, inlined rather than linked: Chromium is
// loading this from a string with no origin, so a relative href would resolve
// to nothing and the PDF would come out unstyled — silently.
function documentHtml(doc) {
  const body = renderer().render(doc);
  return '<!DOCTYPE html><html><head><meta charset="utf-8" />' +
    '<style>' +
      // @page owns the geometry; the paper element must not also set a width.
      '@page { size: letter portrait; margin: 0.4in; }' +
      'html,body{margin:0;padding:0;background:#fff;}' +
      '.p86-report-preview-paper{width:100%;max-width:none;margin:0;padding:0;box-shadow:none;}' +
      readCss('css/report-paper.css') +
      readCss('css/report-style-packs.css') +
    '</style></head><body>' + body + '</body></html>';
}

// Chromium is required lazily so the whole server does not fail to boot on a
// machine that has no browser — the PDF route answers with a clear error
// instead, and every other feature keeps working.
function loadPuppeteer() {
  try { return require('puppeteer'); }
  catch (e) { return null; }
}

/**
 * @returns {Promise<Buffer>} the PDF bytes
 * @throws  with a message intended to be shown to the user
 */
async function renderReportPdf(doc) {
  const puppeteer = loadPuppeteer();
  if (!puppeteer) {
    throw new Error('PDF rendering is not available on this server (no browser engine installed).');
  }

  let browser = null;
  try {
    browser = await puppeteer.launch({
      headless: 'new',
      // Required in most containers: no sandbox namespaces, and /dev/shm is
      // typically 64MB, which a photo-heavy page will exhaust.
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none']
    });
    const page = await browser.newPage();

    // Photos come from the attachment CDN, so the page genuinely needs network.
    // networkidle0 waits for them; the timeout bounds a report whose images are
    // slow rather than letting a request hang.
    await page.setContent(documentHtml(doc), { waitUntil: 'networkidle0', timeout: 60000 });

    // print media, so the @media print rules in report-paper.css apply — the
    // per-page photo caps, the page-break rules, and the baked map instead of
    // the live one.
    await page.emulateMediaType('print');

    return await page.pdf({
      format: 'Letter',
      printBackground: true,
      preferCSSPageSize: true,
      timeout: 120000
    });
  } finally {
    if (browser) { try { await browser.close(); } catch (e) { /* best effort */ } }
  }
}

// Exposed for tests: proves the HTML is produced from the shared renderer
// without needing a browser present.
module.exports = { renderReportPdf, documentHtml, renderer };
