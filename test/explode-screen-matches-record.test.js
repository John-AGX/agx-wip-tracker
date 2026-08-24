/**
 * @jest-environment jsdom
 */
// test/explode-screen-matches-record.test.js
//
// WHAT IS ON SCREEN IS WHAT IS IN THE RECORD, AND EVERYTHING THAT MOVED THE
// RECORD ARMED THE SAVE.
//
// Its sibling test/explode-replaces-or-refuses.test.js states the properties
// over a corpus. This file states the two that only a REAL SCREEN can answer,
// through js/change-order-editor.js's own bytes and the shipped delegation a
// person's finger reaches:
//
//     [data-asm-toggle]  →  [data-asm-explode]  →  p86Confirm  →  doIt()
//
// The shipped 1.21 explode failed both, and it failed them TOGETHER, which is
// what made it so hard to notice:
//
//   • the destroyed row was STILL PAINTED, because paintLines() lived past the
//     empty-specs early return in coApplyBulkAddLineItems and was never
//     reached. The change order had lost a line and the table said otherwise.
//
//   • no save was armed, because markDirty() lived past the same return. Close
//     the editor and the deletion was silently dropped — close() flushes only
//     `if (_state.dirty)`. Touch ANY other field and the deletion was written
//     to the server alongside an edit that had nothing to do with it.
//
// So the loss was invisible, deferred, and triggered by something else. That
// third property — WHAT THE SERVER IS ACTUALLY SENT AFTERWARDS — is the one
// that matters most to a person whose line disappeared, and it is asserted on
// the real PUT payload, not on internal state.

const path = require('path');
const P = require('../js/pricing-pipeline.js');

global.window.p86Pricing = P;
window.p86Pricing = P;
// eslint-disable-next-line global-require, import/no-dynamic-require
const editor = require(path.join(__dirname, '..', 'js', 'change-order-editor.js'));
const T = editor.__test;

let confirms;
let notices;
let puts;

// The ids paintLines()/paintTotals()/paintSaveStatus() write into — every one
// of them a getElementById target in the shipped file. Nothing is invented.
function mount() {
  document.body.innerHTML =
    '<div id="co-editor-overlay">' +
      '<input data-field="targetMargin" /><input data-field="roundTo" />' +
      '<div id="p86CoSaveStatus"></div>' +
      '<div id="p86CoTotals"></div><div id="p86CoLineTable"></div>' +
    '</div>';
  confirms = [];
  notices = [];
  puts = [];
  window.__ok = true;
  window.p86Confirm = (o) => { confirms.push(o && o.message); return Promise.resolve(window.__ok); };
  window.p86Alert = (o) => { notices.push(o && o.message); return Promise.resolve(); };
  window.p86Api = {
    isAuthenticated: () => true,
    changeOrders: {
      update: (id, data) => {
        puts.push({ id, data: JSON.parse(JSON.stringify(data)) });
        return Promise.resolve({ change_order: { updated_at: 'T', status: 'draft' } });
      },
    },
  };
  window.alert = () => {};
}

beforeEach(() => { jest.useFakeTimers(); mount(); });
afterEach(() => { jest.useRealTimers(); });

const comp = (over) => Object.assign(
  { description: 'Extrusion', qty_per_unit: 1, unit_cost: 2000, cost_code: 'materials', unit: 'ea' }, over || {});

function makeCo(rollupOver, breakdown) {
  return {
    id: 'co_1', title: 'Cage adds', defaultMarkup: 20,
    lines: [
      { id: 's_mat', section: '__section_header__', label: 'Materials', btCategory: 'materials', markup: 10, markupMode: 'percent' },
      Object.assign({
        id: 'ROLLUP', description: 'Pool cage package', qty: 2, unit: 'ea',
        unitCost: 6000, markup: 35, markupMode: 'percent', sourceAssemblyId: 47,
        assemblyBreakdown: breakdown || [comp(), comp({ description: 'Crew day', cost_code: 'labor', unit_cost: 1500 })],
      }, rollupOver || {}),
      { id: 'OTHER', description: 'Base scope', qty: 1, unit: 'ea', unitCost: 10000, markup: '' },
    ],
  };
}

// THE SHIPPED USER PATH. Nothing is called by name: the strip is clicked open
// and the Explode control inside it is clicked, through the delegation
// paintLines() itself wires up.
// _coAsmOpen is module state keyed by line id and lives for the life of the
// module, so a toggle is not the same as "open" — and a REFUSED explode leaves
// it open where a completed one deletes the key. Ask for the control; if the
// toggle closed the strip instead, toggle back.
function openStrip() {
  const strip = () => document.querySelector('[data-asm-toggle="ROLLUP"]');
  if (!strip()) throw new Error('no assembly strip painted for the rollup');
  strip().click();
  if (!document.querySelector('[data-asm-explode="ROLLUP"]')) strip().click();
}

async function explode(co) {
  T.setCo(co);
  T.paintLines();
  openStrip();
  const btn = document.querySelector('[data-asm-explode="ROLLUP"]');
  if (!btn) throw new Error('no Explode control painted');
  btn.click();
  await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
}

// WHAT THE TABLE SAYS — the line ids the painted rows are addressed by.
const painted = () => Array.from(document.querySelectorAll('#p86CoLineTable [data-line-id]'))
  .map((el) => el.getAttribute('data-line-id'));
// WHAT THE RECORD HOLDS.
const held = () => (T.getCo().lines || []).map((l) => String(l.id));

describe('PROPERTY — after an explode, the screen and the record say the same thing', () => {
  test('a healthy rollup: replaced on screen and in the record, together', async () => {
    await explode(makeCo());
    expect(confirms).toHaveLength(1);
    expect(confirms[0]).toContain('into 2 editable lines');
    expect(held()).not.toContain('ROLLUP');
    expect(painted()).toEqual(held());
  });

  test.each([
    ['a credit rollup', { qty: -1 }, undefined],
    ['a zero-quantity rollup', { qty: 0 }, undefined],
    ['a recipe that is all "included, no charge"', {}, [comp({ qty_per_unit: 0 })]],
  ])('%s: nothing happens, and the screen still shows the line', async (_name, over, bd) => {
    await explode(makeCo(over, bd));
    // No dialog was raised asking to approve something that will not happen.
    expect(confirms).toHaveLength(0);
    // The person was told, in words, why.
    expect(notices).toHaveLength(1);
    expect(notices[0].length).toBeGreaterThan(20);
    // The line is still held...
    expect(held()).toContain('ROLLUP');
    // ...and still painted. THIS PAIRING is the whole property: the shipped
    // bytes broke it by removing the first and leaving the second.
    expect(painted()).toEqual(held());
    expect(painted()).toContain('ROLLUP');
  });
});

describe('PROPERTY — nothing reaches the server that the person did not do', () => {
  test('a healthy explode is SAVED, once, and the payload is the exploded record', async () => {
    await explode(makeCo());
    jest.advanceTimersByTime(5000);
    await Promise.resolve(); await Promise.resolve();
    expect(puts).toHaveLength(1);
    const ids = puts[0].data.lines.map((l) => String(l.id));
    expect(ids).not.toContain('ROLLUP');
    expect(ids).toEqual(held());
  });

  test.each([
    ['credit', { qty: -1 }],
    ['zero quantity', { qty: 0 }],
  ])('a refused explode (%s) never reaches the server, however long you wait', async (_n, over) => {
    await explode(makeCo(over));
    jest.advanceTimersByTime(60000);
    await Promise.resolve(); await Promise.resolve();
    expect(puts).toHaveLength(0);
  });

  // ══ THE DEFERRED LOSS ══
  // This is what actually happened to a person: explode a credit line, see
  // nothing change, carry on editing something else — and the unrelated edit
  // carries the deletion to the server. The assertion is on the PUT BODY,
  // because that is the thing the server writes.
  test('a later, unrelated edit saves a payload that STILL CONTAINS the rollup', async () => {
    await explode(makeCo({ qty: -1 }));
    jest.advanceTimersByTime(5000);
    expect(puts).toHaveLength(0);
    // Type into a different line, the way the shipped table does it.
    const cell = document.querySelector('[data-line-id="OTHER"] [data-line-field="qty"]');
    expect(cell).toBeTruthy();
    cell.value = '3';
    cell.dispatchEvent(new window.Event('input', { bubbles: true }));
    jest.advanceTimersByTime(5000);
    await Promise.resolve(); await Promise.resolve();
    expect(puts.length).toBeGreaterThan(0);
    const saved = puts[puts.length - 1].data.lines.map((l) => String(l.id));
    expect(saved).toContain('ROLLUP');          // ← the line survived
    expect(saved).toEqual(held());
  });

  test('cancelling the confirm saves nothing and paints nothing away', async () => {
    window.__ok = false;
    const co = makeCo();
    T.setCo(co);
    T.paintLines();
    openStrip();
    const before = painted();
    document.querySelector('[data-asm-explode="ROLLUP"]').click();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    jest.advanceTimersByTime(5000);
    expect(confirms).toHaveLength(1);
    expect(puts).toHaveLength(0);
    expect(painted()).toEqual(before);
    expect(held()).toContain('ROLLUP');
  });
});
