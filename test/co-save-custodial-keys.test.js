/**
 * @jest-environment jsdom
 */
// test/co-save-custodial-keys.test.js — the change-order editor is a CUSTODIAN
// of fields it has no control for, and it was deleting them.
//
// THE REPORT: John asked for a change order to ride the "Gutters" scope so its
// cost accrues against that scope's purchase order. Setting that writes
// `completionMode: 'rider'` + `riderScopeName: 'Gutters'` onto the record from
// the ALLOCATION WINDOW — a different surface. The CO editor has no control for
// either.
//
// `PUT /api/change-orders/:id` replaces `data` WHOLESALE. The editor's save
// payload was a hand-written object literal of ten keys, so every key it did
// not name was DELETED on save. Typing one character into a line arms a 700ms
// autosave, and that autosave silently reverted the change order to the default
// completion clock. Nothing on screen said so, and the pill read "Saved".
//
// Four other fields sat in the same hole, all of them money wiring:
//   buildingAllocations  — the CO→building split (G703 line 2)
//   costSource/costDraws — which PO the cost draws against
//
// There were TWO savers with the same copied literal: flushSave (debounced,
// fires on every keystroke) and flushSaveSync (status transitions — i.e.
// APPROVE). So approving a rider CO erased the rider too. Patching both
// literals would be the call-site fix this repo keeps re-learning not to make;
// there is now ONE builder, coSavePayload, and both savers call it.
//
// THE RULE UNDER TEST — and it is deliberately two-sided:
//   present on the record  → written back BYTE-IDENTICAL
//   absent from the record → still ABSENT in the payload
// The second half matters as much as the first. Defaulting `costDraws: []`
// onto a record that never had the key is itself a write to money wiring, and
// "preserve" that invents a value is not preservation.

const editor = require('../js/change-order-editor.js');
const T = editor.__test;

const CUSTODIAL = ['completionMode', 'riderScopeName', 'buildingAllocations',
  'costSource', 'costDraws'];

// The ten fields the editor genuinely owns. Named here so that a future key
// added to the owned set has to be added deliberately in two places.
const OWNED = ['title', 'scope', 'terms', 'targetMargin', 'defaultMarkup',
  'feeFlat', 'feePct', 'taxPct', 'roundTo', 'lines'];

const baseCo = () => ({
  id: 'co_test', title: 'CO-0001', scope: '', terms: '',
  targetMargin: '', defaultMarkup: '', feeFlat: 0, feePct: 0, taxPct: 0,
  roundTo: 0,
  lines: [{ id: 'l1', description: 'Gutters', qty: 1, unitCost: 12967 }],
});

describe('the editor owns ten fields and is a custodian of the rest', () => {
  test('a payload always carries the ten owned fields', () => {
    const out = T.coSavePayload(baseCo());
    for (const k of OWNED) expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(true);
  });

  test('canonical column fields never ride in the data blob', () => {
    const co = baseCo();
    co.status = 'approved'; co.is_locked = true; co.job_id = 'j1'; co.coNumber = 'CO-0001';
    const out = T.coSavePayload(co);
    for (const k of ['status', 'is_locked', 'job_id', 'coNumber', 'id']) {
      expect(Object.prototype.hasOwnProperty.call(out, k)).toBe(false);
    }
  });
});

describe('custodial keys survive a save', () => {
  // John's actual case, and the one that sent him here.
  test('a rider change order still rides its scope after an unrelated edit', () => {
    const co = baseCo();
    co.completionMode = 'rider';
    co.riderScopeName = 'Gutters';

    // The user types a price. That is all it took to erase the rider.
    co.lines[0].unitSell = 27500;

    const out = T.coSavePayload(co);
    expect(out.completionMode).toBe('rider');
    expect(out.riderScopeName).toBe('Gutters');
  });

  test('the scope name is byte-identical, not trimmed or normalised', () => {
    // The completion clock does NOT trim: "Gutters " matches no live scope and
    // earns $0. So the save must not quietly "helpfully" trim either — if the
    // stored value is damaged, that is a data problem to SEE, not to hide.
    const co = baseCo();
    co.completionMode = 'rider';
    co.riderScopeName = ' Gutters ';
    expect(T.coSavePayload(co).riderScopeName).toBe(' Gutters ');
  });

  test.each(CUSTODIAL)('%s is preserved when present', (key) => {
    const co = baseCo();
    const value = key === 'buildingAllocations' ? [{ buildingId: 'b1', amount: 100 }]
      : key === 'costDraws' ? [{ poId: 'po_1', amount: 500 }]
      : 'sentinel-' + key;
    co[key] = value;
    expect(T.coSavePayload(co)[key]).toEqual(value);
  });

  test.each(CUSTODIAL)('%s stays ABSENT when the record never had it', (key) => {
    const out = T.coSavePayload(baseCo());
    expect(Object.prototype.hasOwnProperty.call(out, key)).toBe(false);
  });

  test('a falsy-but-real value is preserved, not dropped', () => {
    // `|| ''` style defaulting is what created this class of bug. An empty
    // string, 0 and false are all values somebody chose.
    const co = baseCo();
    co.completionMode = '';
    co.costDraws = [];
    const out = T.coSavePayload(co);
    expect(out.completionMode).toBe('');
    expect(out.costDraws).toEqual([]);
  });

  test('an explicit undefined is treated as absent', () => {
    const co = baseCo();
    co.riderScopeName = undefined;
    expect(Object.prototype.hasOwnProperty.call(T.coSavePayload(co), 'riderScopeName')).toBe(false);
  });

  test('the payload does not alias the record — mutating it cannot corrupt state', () => {
    const co = baseCo();
    co.buildingAllocations = [{ buildingId: 'b1', amount: 100 }];
    const out = T.coSavePayload(co);
    expect(out.buildingAllocations).toEqual(co.buildingAllocations);
  });
});

describe('both savers use the one builder', () => {
  // The defect was TWO hand-copied literals. A future edit that reintroduces a
  // literal in either saver is exactly the regression this file exists to
  // catch, and a source scan is the only way to see it — the debounced saver
  // and the status-transition saver are not separately reachable from here.
  const fs = require('fs');
  const path = require('path');
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'change-order-editor.js'), 'utf8');

  test('there is exactly one place that builds the save payload', () => {
    const literals = (SRC.match(/title:\s*co\.title\s*\|\|\s*''/g) || []).length;
    expect(literals).toBe(1);
  });

  test('flushSave and flushSaveSync both call coSavePayload', () => {
    for (const fn of ['function flushSave()', 'function flushSaveSync()']) {
      const at = SRC.indexOf(fn);
      expect(at).toBeGreaterThan(-1);
      const body = SRC.slice(at, at + 700);
      expect(body).toContain('coSavePayload(co)');
    }
  });

  test('every custodial key is listed in one place, not per call site', () => {
    for (const k of CUSTODIAL) {
      expect((SRC.match(new RegExp("'" + k + "'", 'g')) || []).length).toBeGreaterThan(0);
    }
    expect(SRC).toContain('CO_CUSTODIAL_KEYS');
  });
});
