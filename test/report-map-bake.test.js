// The static map is baked server-side for one reason: a Google Static Maps URL
// carries the API key in its query string, and the published snapshot is read
// by anonymous strangers. These tests exist mostly to prove the key cannot
// reach that snapshot, and that a failure to draw a map never blocks a publish.
'use strict';

const assert = require('assert');
const bake = require('../server/services/report-map-bake');

let failures = 0;
function test(name, fn) {
  const done = function () { console.log('  ok  ' + name); };
  try {
    const r = fn();
    if (r && typeof r.then === 'function') return r.then(done, function (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); });
    done();
  } catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

const photos = [
  { id: 'a', lat: 28.5, lng: -81.4, num: 1 },
  { id: 'b', lat: 28.6, lng: -81.5, num: 2 },
  { id: 'c', lat: 0, lng: 0, num: 3 },            // null island — must be dropped
  { id: 'd', lat: 'x', lng: 'y', num: 4 },        // junk — must be dropped
  { id: 'e', lat: 200, lng: -81.4, num: 5 }       // out of range — must be dropped
];

console.log('report-map-bake');

test('only real coordinates become pins', function () {
  const url = bake.staticMapUrl(photos, 'numbered', 'KEY123');
  const markers = (url.match(/markers=/g) || []).length;
  assert.strictEqual(markers, 2, 'expected 2 pins, got ' + markers);
});

test('pin labels use the document-wide photo number', function () {
  const url = bake.staticMapUrl([{ id: 'z', lat: 1, lng: 2, num: 7 }], 'numbered', 'K');
  assert.ok(url.indexOf('label:7') >= 0, 'should label with the report number, got: ' + url);
});

test('Static Maps cannot draw multi-character labels, so 10+ degrades to a dot', function () {
  const url = bake.staticMapUrl([{ id: 'z', lat: 1, lng: 2, num: 12 }], 'numbered', 'K');
  assert.ok(url.indexOf('label:') < 0, 'a 2-digit label must be dropped, not sent');
  assert.ok(url.indexOf('markers=') >= 0, 'the pin itself should still be drawn');
});

test('lettered pins wrap the same way', function () {
  assert.strictEqual(bake.indexToLetters(0), 'A');
  assert.strictEqual(bake.indexToLetters(25), 'Z');
  assert.ok(bake.indexToLetters(26).length > 1, 'past Z should be multi-char (and so unlabelled)');
});

test('no key, no URL — never a URL with an empty key on it', function () {
  assert.strictEqual(bake.staticMapUrl(photos, 'numbered', null), null);
  assert.strictEqual(bake.staticMapUrl(photos, 'numbered', ''), null);
});

test('no located photos means no map', function () {
  assert.strictEqual(bake.staticMapUrl([], 'numbered', 'K'), null);
  assert.strictEqual(bake.staticMapUrl([{ id: 'x', lat: 0, lng: 0 }], 'numbered', 'K'), null);
});

// ── The point of the whole module ───────────────────────────────────────
test('THE KEY NEVER REACHES THE SNAPSHOT', async function () {
  const stored = [];
  const fakeStorage = {
    put: async function (key, buf, type) {
      stored.push({ key: key, type: type, bytes: buf.length });
      return 'https://cdn.example/' + key;
    }
  };
  const realFetch = global.fetch;
  global.fetch = async function (url) {
    // The OUTBOUND call is allowed to carry the key — that is the whole point
    // of doing it server-side.
    assert.ok(String(url).indexOf('key=SECRET_KEY') >= 0, 'the server call should carry the key');
    return { ok: true, arrayBuffer: async function () { return new Uint8Array([137, 80, 78, 71]).buffer; } };
  };
  process.env.GEOCODING_API_KEY = 'SECRET_KEY';
  try {
    const doc = {
      sections: [
        { id: 's1', layout: 'photo-map', pin_style: 'numbered', photos: photos },
        { id: 's2', layout: 'photo-grid', photos: photos }
      ]
    };
    await bake.bakeDocumentMaps(fakeStorage, doc, 'rshare_1');
    const json = JSON.stringify(doc);
    assert.ok(json.indexOf('SECRET_KEY') < 0, 'THE API KEY LEAKED INTO THE DOCUMENT');
    assert.ok(json.indexOf('maps.googleapis.com') < 0, 'a keyed Google URL leaked into the document');
    assert.strictEqual(doc.sections[0].map_url, 'https://cdn.example/' + stored[0].key);
    assert.ok(!doc.sections[1].map_url, 'a non-map section must not get a map');
    assert.strictEqual(stored.length, 1);
    assert.strictEqual(stored[0].type, 'image/png');
  } finally {
    global.fetch = realFetch;
    delete process.env.GEOCODING_API_KEY;
  }
});

test('a failed fetch leaves no map and does NOT throw', async function () {
  const realFetch = global.fetch;
  global.fetch = async function () { return { ok: false, status: 403 }; };
  process.env.GEOCODING_API_KEY = 'K';
  try {
    const doc = { sections: [{ id: 's1', layout: 'photo-map', pin_style: 'tag', photos: photos }] };
    await bake.bakeDocumentMaps({ put: async function () { throw new Error('should not be called'); } }, doc, 'r1');
    assert.ok(!doc.sections[0].map_url, 'no map_url on failure');
  } finally { global.fetch = realFetch; delete process.env.GEOCODING_API_KEY; }
});

test('a thrown fetch also degrades quietly — publishing must not fail over a map', async function () {
  const realFetch = global.fetch;
  global.fetch = async function () { throw new Error('network down'); };
  process.env.GEOCODING_API_KEY = 'K';
  try {
    const doc = { sections: [{ id: 's1', layout: 'photo-map', photos: photos }] };
    await bake.bakeDocumentMaps({ put: async function () {} }, doc, 'r1');
    assert.ok(!doc.sections[0].map_url);
  } finally { global.fetch = realFetch; delete process.env.GEOCODING_API_KEY; }
});

test('with no key configured, publish still succeeds with no map', async function () {
  const saved = process.env.GEOCODING_API_KEY, saved2 = process.env.GOOGLE_MAPS_API_KEY;
  delete process.env.GEOCODING_API_KEY; delete process.env.GOOGLE_MAPS_API_KEY;
  try {
    const doc = { sections: [{ id: 's1', layout: 'photo-map', photos: photos }] };
    await bake.bakeDocumentMaps({ put: async function () { throw new Error('should not be called'); } }, doc, 'r1');
    assert.ok(!doc.sections[0].map_url);
  } finally {
    if (saved) process.env.GEOCODING_API_KEY = saved;
    if (saved2) process.env.GOOGLE_MAPS_API_KEY = saved2;
  }
});

setTimeout(function () {
  console.log(failures ? '\nreport-map-bake: ' + failures + ' FAILED' : '\nreport-map-bake: all passed');
  process.exit(failures ? 1 : 0);
}, 250);
