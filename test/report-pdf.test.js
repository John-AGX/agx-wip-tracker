// The PDF must be produced by the SAME renderer as the preview, the printed
// page and the share portal. These tests assert that without needing a browser
// installed — they check the HTML that goes into Chromium, which is where a
// second renderer would first show up.
'use strict';

const assert = require('assert');
const svc = require('../server/services/report-pdf');

// No local harness: this file's cases are plain jest tests. It used to define
// its own `test()`, which SHADOWED jest's global and left the suite reporting
// success through console.log while jest saw zero tests — and the trailing
// process.exit() then crashed the worker, so `npm test` went red on a file
// that was actually passing.

const doc = {
  title: 'Punch List / QC',
  summary: 'Overall summary text',
  style_pack: 'field-notebook',
  org_name: 'AG Exteriors',
  project_address: '12024 Meadow Bend Loop',
  cover_page: { enabled: true, company_name: 'AG Exteriors', walkthrough_date: 'Aug 25, 2026', date: 'Aug 25, 2026' },
  sections: [
    { id: 's1', label: 'Exterior items', layout: 'single-photo', photoSize: 'small',
      descSide: 'right', descSides: {},
      photos: [{ id: 'a', web_url: 'https://cdn/a_web.jpg', caption: '8 LF', num: 1,
                 shot_at: '2026-08-25T10:00:00Z', uploaded_by_name: 'John Thilking' }],
      files: [] },
    { id: 's2', label: 'Notes', layout: 'text-block', text_body: 'Narrative', photos: [], files: [] }
  ]
};

console.log('report-pdf');

test('the browser renderer loads and runs under Node', function () {
  const r = svc.renderer();
  assert.strictEqual(typeof r.render, 'function');
  assert.ok(r.render({ sections: [], cover_page: { enabled: false } }).indexOf('p86-report-preview-paper') >= 0);
});

test('the PDF html comes from that renderer, not a second one', function () {
  const html = svc.documentHtml(doc);
  // Markers only the shared renderer emits.
  assert.ok(html.indexOf('p86-report-preview-paper') >= 0);
  assert.ok(html.indexOf('p86-report-preview-section') >= 0);
  assert.ok(html.indexOf('data-style-pack="field-notebook"') >= 0, 'style pack must reach the PDF');
  assert.ok(html.indexOf('Punch List / QC') >= 0);
  assert.ok(html.indexOf('Exterior items') >= 0 && html.indexOf('Narrative') >= 0);
});

test('the document stylesheet is INLINED, not linked', function () {
  const html = svc.documentHtml(doc);
  // Chromium loads this from a string with no origin, so a relative href would
  // resolve to nothing and the PDF would silently come out unstyled.
  assert.ok(html.indexOf('<link') < 0, 'no <link> may be used');
  assert.ok(html.indexOf('.p86-report-cover-title') >= 0, 'paper css missing');
  assert.ok(html.indexOf('@media print') >= 0, 'print rules missing — page breaks would be wrong');
});

test('page geometry is declared for Letter portrait', function () {
  const html = svc.documentHtml(doc);
  assert.ok(html.indexOf('size: letter portrait') >= 0);
  assert.ok(html.indexOf('margin: 0.4in') >= 0);
});

test('the paper element does not fight @page for the width', function () {
  const html = svc.documentHtml(doc);
  assert.ok(html.indexOf('.p86-report-preview-paper{width:100%') >= 0,
    'the on-screen fixed width must be overridden or the PDF is narrow');
});

test('the number badge reaches the PDF as a span, never a button', function () {
  const html = svc.documentHtml(doc);
  // Assert on the BODY only. The stylesheet legitimately mentions <button> in a
  // comment explaining why the badge is not one; checking the whole document
  // would fail on its own documentation.
  const body = html.slice(html.indexOf('</style>'));
  assert.ok(body.indexOf('<span class="p86-report-photo-num">') >= 0, 'badge missing');
  assert.ok(body.indexOf('<button') < 0, 'a global print rule hides buttons — the document must contain none');
});

test('an internal PDF keeps the uploader; that is the caller\'s choice, not the renderer\'s', function () {
  const html = svc.documentHtml(doc);
  assert.ok(html.indexOf('John Thilking') >= 0,
    'a PDF filed into the project should carry who took the photo');
});

test('malformed input does not throw', function () {
  assert.doesNotThrow(function () {
    svc.documentHtml({});
    svc.documentHtml({ sections: null, cover_page: null });
  });
});

test('renderReportPdf reports a missing browser clearly rather than crashing', async function () {
  // Not asserting a render here — that needs Chromium. What matters is that the
  // absence of one produces a message a user can act on.
  //
  // 30s, not jest's 5s default. Launching a browser — or failing to find one —
  // is slow, and on a loaded machine it overran the default and reported as a
  // FAILURE rather than a timeout. That is what made the whole suite look
  // non-deterministic: three runs over identical bytes gave 5, 32 and 7
  // failures as the 5s ceiling landed on whichever suites were unlucky. A
  // timeout dressed as a failure is worse than a slow test.
  try {
    await svc.renderReportPdf(doc);
  } catch (e) {
    assert.ok(/browser engine|Failed to launch|Could not find/i.test(e.message),
      'unhelpful error: ' + e.message);
  }
}, 30000);

