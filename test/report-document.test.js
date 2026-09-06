// The published snapshot is served to the public internet. This test feeds
// buildDocument FULL database rows — every internal column an attachment
// actually carries — so that a field accidentally added to the projection
// fails here rather than shipping to a client's browser.
'use strict';

const assert = require('assert');
const d = require('../server/services/report-document');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

// A realistic attachment row, including the columns a guest must NEVER see.
function attRow(id, over) {
  return Object.assign({
    id: id,
    filename: id + '.jpg',
    mime_type: 'image/jpeg',
    thumb_url: 'https://cdn.example/' + id + '_thumb.jpg',
    web_url: 'https://cdn.example/' + id + '_web.jpg',
    caption: '',
    annotations: null,
    lat: 28.5, lng: -81.4,
    // ── everything below is internal and must not survive ──
    uploaded_by: 42,
    uploaded_by_name: 'Crew Member Name',
    entity_type: 'project',
    entity_id: 'proj_secret',
    organization_id: 7,
    folder: 'Internal/Do Not Send',
    extracted_text: 'OCR TEXT WITH INTERNAL NOTES',
    thumb_key: 'project/proj_secret/att_key.jpg',
    original_url: 'https://cdn.example/' + id + '_original.jpg',
    size_bytes: 123456,
    tags: ['internal-only']
  }, over || {});
}

const baseReport = {
  title: 'Punch List',
  summary: 'Summary text',
  template_type: 'punch-list',
  style_pack: 'clean',
  cover_page: { enabled: true, company_name: 'AG Exteriors', co_amount: '$12,500', pm_name: 'John' },
  sections_raw: [
    {
      id: 'sec_1', label: 'Exterior', layout: 'single-photo', photoSize: 'small',
      descSide: 'right', descSides: {}, pin_style: 'photo',
      captions: { att_1: 'north wall' }, text_body: '',
      photo_ids: ['att_1', 'att_gone'], attachment_ids: []
    },
    {
      id: 'sec_2', label: 'Notes', layout: 'text-block',
      text_body: 'Narrative body', photo_ids: [], attachment_ids: []
    }
  ]
};

function build(over) {
  return d.buildDocument(Object.assign({
    report: baseReport,
    photoRows: [attRow('att_1')],
    fileRows: [],
    project: { name: 'Citi Lakes', address_text: '123 Main St' },
    orgName: 'AG Exteriors',
    hideFinancials: true
  }, over || {}));
}

console.log('report-document');

test('no internal attachment field survives into the document', function () {
  const json = JSON.stringify(build());
  [
    'uploaded_by', 'Crew Member Name', 'proj_secret', 'Internal/Do Not Send',
    'OCR TEXT WITH INTERNAL NOTES', 'att_key.jpg', 'internal-only',
    'original_url', 'thumb_key', 'extracted_text', 'size_bytes'
  ].forEach(function (leak) {
    assert.ok(json.indexOf(leak) < 0, 'LEAKED "' + leak + '" into the public document');
  });
});

test('a photo exposes exactly the whitelisted keys', function () {
  const p = build().sections[0].photos[0];
  assert.deepStrictEqual(Object.keys(p).sort(),
    ['annotations', 'caption', 'filename', 'id', 'lat', 'lng', 'mime_type', 'num', 'thumb_url', 'web_url']);
});

test('financials are DROPPED from the payload, not merely hidden', function () {
  const hidden = build({ hideFinancials: true });
  assert.ok(!('co_amount' in hidden.cover_page), 'co_amount must not be in the payload');
  assert.ok(JSON.stringify(hidden).indexOf('12,500') < 0, 'the figure itself leaked');
  const shown = build({ hideFinancials: false });
  assert.strictEqual(shown.cover_page.co_amount, '$12,500');
});

test('financials default to hidden when the flag is omitted', function () {
  const doc = d.buildDocument({
    report: baseReport, photoRows: [attRow('att_1')], fileRows: [],
    project: {}, orgName: 'X'
  });
  assert.ok(!('co_amount' in doc.cover_page), 'omitted flag must mean HIDDEN');
});

test('unresolvable photo ids are dropped, never rendered as a placeholder', function () {
  const doc = build();
  assert.strictEqual(doc.sections[0].photos.length, 1);
  assert.ok(JSON.stringify(doc).indexOf('att_gone') < 0, 'a dead id must not appear at all');
});

test('numbering is continuous and skips unresolvable ids', function () {
  const nums = d.numberPhotos(
    [{ photo_ids: ['a', 'dead', 'b'] }, { photo_ids: ['b', 'c'] }],
    function (id) { return id !== 'dead'; }
  );
  // Object.assign: numberPhotos returns a null-prototype map on purpose, so a
  // photo id of "__proto__" or "constructor" cannot collide with Object.prototype.
  assert.deepStrictEqual(Object.assign({}, nums), { a: 1, b: 2, c: 3 });
});

test('a text-only section keeps its layout and body (hydrateSections drops both)', function () {
  const s2 = build().sections[1];
  assert.strictEqual(s2.layout, 'text-block');
  assert.strictEqual(s2.text_body, 'Narrative body');
});

test('presentation fields survive (hydrateSections drops these too)', function () {
  const s1 = build().sections[0];
  assert.strictEqual(s1.photoSize, 'small');
  assert.strictEqual(s1.pin_style, 'photo');
  assert.strictEqual(s1.descSide, 'right');
});

test('the section caption overrides the attachment caption', function () {
  assert.strictEqual(build().sections[0].photos[0].caption, 'north wall');
});

test('hostile template/style/layout values clamp instead of passing through', function () {
  const doc = d.buildDocument({
    report: {
      title: 'x', sections_raw: [{ id: 's', layout: '<script>', photoSize: 'huge', pin_style: 'evil', photo_ids: [] }],
      template_type: '../../etc/passwd', style_pack: 'javascript:alert(1)'
    },
    photoRows: [], fileRows: [], project: {}, orgName: 'X', hideFinancials: true
  });
  assert.strictEqual(doc.template_type, 'walkthrough');
  assert.strictEqual(doc.style_pack, 'clean');
  assert.strictEqual(doc.sections[0].layout, 'photo-grid');
  assert.strictEqual(doc.sections[0].photoSize, 'small');
  assert.strictEqual(doc.sections[0].pin_style, 'photo');
});

test('free text is length-capped', function () {
  const doc = d.buildDocument({
    report: { title: 'x', summary: 'S'.repeat(99999), sections_raw: [] },
    photoRows: [], fileRows: [], project: {}, orgName: 'X', hideFinancials: true
  });
  assert.ok(doc.summary.length <= 5000, 'summary not capped: ' + doc.summary.length);
});

test('a malformed report does not throw', function () {
  assert.doesNotThrow(function () {
    d.buildDocument({ report: {}, photoRows: [], fileRows: [], project: null, orgName: null });
    d.buildDocument({ report: { sections_raw: 'not-an-array' }, photoRows: [], fileRows: [] });
    d.buildDocument({});
  });
});

console.log(failures ? '\nreport-document: ' + failures + ' FAILED' : '\nreport-document: all passed');
process.exit(failures ? 1 : 0);
