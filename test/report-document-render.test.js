// js/report-document.js is loaded by the PUBLIC share portal, which is a page
// outside the app. The house rule is that a guest surface copies markup and
// never links app code, because every real renderer in the SPA reaches for app
// state and drags the app in behind it.
//
// This file is allowed to be the exception only while it stays PURE. That is
// what this test enforces: it runs the file in a bare sandbox with no app
// globals at all, and fails if it declares more than one global, reads ambient
// state, or emits an editor control. If you add an ambient read, fix the code —
// not this test.
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── WHY test() DELEGATES TO JEST WHEN JEST IS PRESENT ────────────────────
// This file is a standalone node script that ends in process.exit(). It is
// NAMED *.test.js, so jest collects it — and process.exit() inside a jest
// worker KILLS THE WORKER:
//
//     A jest worker process (pid=…) crashed for an unknown reason: exitCode=0
//
//  — this file's assertions then count as ZERO tests, and anything still queued
// on that worker goes with them. A worker that exits mid-run can TRUNCATE A
// FAILURE REPORT, and this suite is the instrument every claim in this repo
// leans on; an instrument that can drop the failure it was run to find is
// worse than a slow one.
//
// So test() hands off to jest when jest is there, and keeps the script
// behaviour — exit code included — under plain `node`. Nothing asserted
// changes. Only who counts it.
const UNDER_JEST = typeof global.it === 'function' && typeof global.expect === 'function';

let failures = 0;
function test(name, fn) {
  if (UNDER_JEST) return global.it(name, fn);
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const SRC_PATH = path.join(__dirname, '..', 'js', 'report-document.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');

// A window with NOTHING on it. If the module reaches for an app global it gets
// undefined and throws, which is the point.
function loadInSandbox() {
  const win = {};
  const sandbox = { window: win, document: undefined, console: console };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC, sandbox, { filename: 'report-document.js' });
  return win;
}

if (!UNDER_JEST) console.log('report-document-render');

test('loads with NO app globals present and declares exactly one', function () {
  const win = loadInSandbox();
  assert.deepStrictEqual(Object.keys(win), ['p86ReportDocument'],
    'expected exactly one global, got: ' + Object.keys(win).join(', '));
  assert.strictEqual(typeof win.p86ReportDocument.render, 'function');
  assert.strictEqual(typeof win.p86ReportDocument.wire, 'function');
});

// Comments are stripped first: this file DOCUMENTS what it must not touch,
// and naming a banned global in a comment is the opposite of a violation.
function sourceCode() {
  // Hand-rolled rather than regex: this helper exists to make the scan
  // trustworthy, so it should have no escaping of its own to get wrong.
  var out = [], inBlock = false;
  SRC.split(String.fromCharCode(10)).forEach(function (line) {
    var kept = [];
    for (var i = 0; i < line.length; i++) {
      var two = line.substr(i, 2);
      if (inBlock) { if (two === "*/") { inBlock = false; i++; } continue; }
      if (two === "/*") { inBlock = true; i++; continue; }
      if (two === "//") break;
      kept.push(line.charAt(i));
    }
    out.push(kept.join(""));
  });
  return out.join(String.fromCharCode(10));
}

test('source names no app state and no network', function () {
  const code = sourceCode();
  // Substring checks on the source, not behaviour: an ambient read down a
  // branch this test never takes would still be a violation.
  const banned = [
    'appData', 'p86Api', '_detailState', 'localStorage', 'sessionStorage',
    'p86Maps', 'fetch(', 'XMLHttpRequest', 'buildStaticMapsUrl',
    'maps.googleapis.com', 'require('
  ];
  banned.forEach(function (b) {
    assert.ok(code.indexOf(b) < 0, 'report-document.js must not reference ' + b);
  });
});

test('source links no SPA file', function () {
  const code = sourceCode();
  ['projects.js', 'api.js', 'auth.js', 'app.js'].forEach(function (f) {
    assert.ok(code.indexOf(f) < 0, 'must not name the SPA file ' + f);
  });
});

// ── Rendering ───────────────────────────────────────────────────────────
const doc = {
  v: 1,
  title: 'Punch List',
  summary: 'Overall summary',
  style_pack: 'clean',
  org_name: 'AG Exteriors',
  project_address: '123 Main St',
  cover_page: { enabled: true, company_name: 'AG Exteriors', walkthrough_date: 'Aug 25, 2026', pm_name: 'John' },
  sections: [
    {
      id: 's1', label: 'Exterior', layout: 'single-photo', photoSize: 'small',
      descSide: 'right', descSides: {},
      photos: [{
        id: 'att_1', filename: 'a.jpg', web_url: 'https://cdn/x_web.jpg', thumb_url: 'https://cdn/x_t.jpg',
        caption: '16 LF', shot_at: '2026-08-25T14:12:00Z', annotations: [{ t: 'line' }], lat: 28.5, lng: -81.4, num: 1
      }],
      files: []
    },
    { id: 's2', label: 'Notes', layout: 'text-block', text_body: 'Narrative <b>body</b>', photos: [], files: [] }
  ]
};

function html() { return loadInSandbox().p86ReportDocument.render(doc); }

test('renders the cover, summary, sections and a numbered photo', function () {
  const h = html();
  assert.ok(h.indexOf('p86-report-preview-paper') >= 0);
  assert.ok(h.indexOf('data-style-pack="clean"') >= 0);
  assert.ok(h.indexOf('Punch List') >= 0, 'title missing');
  assert.ok(h.indexOf('Overall summary') >= 0, 'summary missing');
  assert.ok(h.indexOf('Exterior') >= 0 && h.indexOf('Notes') >= 0, 'section labels missing');
  assert.ok(h.indexOf('>1</span>') >= 0, 'photo number badge missing');
  assert.ok(h.indexOf('x_web.jpg') >= 0, 'photo not rendered');
});

test('emits NO editor affordance a guest could click into nothing', function () {
  const h = html();
  ['<input', '<textarea', '<select', 'contenteditable',
   'data-rm-photo', 'data-side-swap', 'data-caption-input', 'data-open-photo',
   'p86-report-photo-remove', 'p86-report-photo-drag'].forEach(function (bad) {
    assert.ok(h.indexOf(bad) < 0, 'guest document contains editor affordance: ' + bad);
  });
});

test('the number badge is a span, not a button', function () {
  const h = html();
  // A global print rule hides every <button>, which is exactly how these
  // numbers vanished from a printed report once already.
  assert.ok(h.indexOf('<span class="p86-report-photo-num">') >= 0, 'badge should be a span');
  assert.ok(h.indexOf('<button') < 0, 'the document must contain no buttons at all');
});

test('user text is escaped, not interpolated', function () {
  const win = loadInSandbox();
  const h = win.p86ReportDocument.render({
    title: '<script>alert(1)</script>',
    sections: [{ id: 'x', label: '"><img onerror=alert(2) src=x>', layout: 'text-block',
                 text_body: '<b>not bold</b>', photos: [], files: [] }],
    cover_page: { enabled: false }
  });
  assert.ok(h.indexOf('<script>') < 0, 'script tag survived');
  // The property that matters is that no TAG survives. The literal text
  // "onerror=" can remain — with its < escaped it is inert prose, not markup.
  assert.ok(h.indexOf('<img') < 0, 'an img tag survived escaping');
  assert.ok(h.indexOf('&lt;img') >= 0, 'the injected tag should appear escaped');
  assert.ok(h.indexOf('<b>not bold</b>') < 0, 'raw html survived in body text');
  assert.ok(h.indexOf('&lt;b&gt;') >= 0, 'body text should be escaped');
});

test('a photo-map section never builds a maps URL', function () {
  const win = loadInSandbox();
  const h = win.p86ReportDocument.render({
    sections: [{ id: 'm', layout: 'photo-map', label: 'Map',
                 photos: [{ id: 'p', lat: 1, lng: 2, web_url: 'u', num: 1 }], files: [] }],
    cover_page: { enabled: false }
  });
  // No baked map_url → degrades to a photo grid. It must NEVER construct a
  // Google Maps URL, because that needs a key an anonymous page cannot hold.
  assert.ok(h.indexOf('googleapis') < 0, 'guest renderer must not build a maps URL');
  assert.ok(h.indexOf('p86-report-preview-section-grid') >= 0, 'should degrade to a grid');
});

test('a baked map_url renders as an image', function () {
  const win = loadInSandbox();
  const h = win.p86ReportDocument.render({
    sections: [{ id: 'm', layout: 'photo-map', photos: [], files: [], map_url: 'https://cdn/map.png' }],
    cover_page: { enabled: false }
  });
  assert.ok(h.indexOf('https://cdn/map.png') >= 0);
});

test('malformed input renders rather than throwing', function () {
  const win = loadInSandbox();
  assert.doesNotThrow(function () {
    win.p86ReportDocument.render(undefined);
    win.p86ReportDocument.render({});
    win.p86ReportDocument.render({ sections: 'nope', cover_page: null });
  });
});

if (!UNDER_JEST) {
  console.log(failures ? '\nreport-document-render: ' + failures + ' FAILED' : '\nreport-document-render: all passed');
  process.exit(failures ? 1 : 0);
}
