/* ═════════════════════════════════════════════════════════════════════════
 * A LINE IS ADDRESSABLE FOR EVERY ID A PRODUCER CAN STORE — and the two
 * editors agree about which line that is.
 *
 * test/estimate-line-addressability.test.js and test/co-line-addressability
 * .test.js hold the TYPE half of this: a stored 12345 is a number, a row is an
 * HTML attribute and therefore a string, and every strict compare missed.
 * All twenty-seven type shapes were fixed and stayed fixed.
 *
 * WHAT THIS FILE IS ABOUT IS CHARACTERS, and it is a different failure with a
 * different cause. Eight shapes — apostrophe, backslash, trailing backslash,
 * raw LF, stored CR, stored CRLF, NUL, and a break-out payload — left the
 * estimate row completely inert: every field dead, delete a no-op, the save
 * pill undisturbed. Two of them were worse than dead:
 *
 *   BACKSLASH COMPILED SILENTLY. 'l_a\b' is l_a + U+0008, so the handler ran
 *   perfectly against a line that does not exist. No error, nothing logged.
 *
 *   THE BREAK-OUT SHAPE EXECUTED. escapeHTML maps ' to &#39;, the HTML parser
 *   decodes it back before the JavaScript parser sees the attribute, and an id
 *   of  ');f();//  fired three separate script executions in one interaction.
 *
 * And the two editors DISAGREED about the same stored record: the change-order
 * editor binds with addEventListener and survived thirty-three of thirty-six,
 * losing only the three the HTML PARSER REWRITES in an attribute value (CR,
 * CRLF, NUL). One editor could edit a line the other could not reach.
 *
 * FOUR PROPERTIES, asserted per shape and per editor:
 *
 *   ADDRESSABLE   typing into row N changes row N and ONLY row N; deleting row
 *                 N removes row N and only row N; the save is armed.
 *   INERT SOURCE  the stored bytes execute nothing, in either editor.
 *   AGREEMENT     both editors resolve the SAME stored line for the same id.
 *   NO REPRICE    the record's money and every line's SECTION are untouched by
 *                 the paint, the address and the delete of a different line.
 *
 * PROVENANCE, not invention: every id is pushed through the REAL agent door
 * (PD.validateOps -> applyLineAdds -> a JSON round trip, which is the JSONB
 * column) and asserted to have been ACCEPTED and STORED VERBATIM before any
 * conclusion is drawn from it. A shape the door refuses is not a shape a
 * producer can store, and the test says so rather than assuming it.
 * ═════════════════════════════════════════════════════════════════════════ */
'use strict';

const H = require('./helpers/estimate-editor-harness.js');
const CH = require('./helpers/change-order-editor-harness.js');
const PD = require('../server/services/payload-dispatcher');
const P = require('../js/pricing-pipeline.js');
const DOM = require('../js/dom-ref.js');

const D = PD.internals;
const BASE_ALT = 'alt_default';
const tick = () => new Promise((r) => setTimeout(r, 5));
const clone = (v) => JSON.parse(JSON.stringify(v));

/* The characters. Every one of these was measured against the shipped bytes;
 * the eight marked DEAD are the ones that left the row inert, and BREAKOUT is
 * the one that ran code. The type shapes live in the two addressability
 * suites and are not repeated here. */
const SHAPES = [
  ['plain string (the control)', 'l_ok1'],
  ['APOSTROPHE — closes the JS string literal', "l_a'b"],
  ['BACKSLASH — compiled to U+0008 and missed silently', 'l_a\\b'],
  ['TRAILING BACKSLASH', 'l_a\\'],
  ['raw LF', 'l_a\nb'],
  ['stored CR — the HTML parser rewrites it to LF', 'l_a\rb'],
  ['stored CRLF — likewise', 'l_a\r\nb'],
  ['NUL — the HTML parser rewrites it to U+FFFD', 'l_a\u0000b'],
  ['BREAK-OUT  \');f();//  — fired three executions', "');window.__PWN.push(1);//"],
  ['ATTRIBUTE BREAK-OUT — an attacker-authored onmouseover', 'x" onmouseover="window.__PWN.push(1)" data-z="'],
  ['double quote', 'l_a"b'],
  ['angle brackets + ampersand', 'l_<a>&b'],
  ['literal text &#39;', 'l_a&#39;b'],
  ['backtick and ${}', 'l_`${1}`b'],
  ['tab', 'l_a\tb'],
  ['form feed', 'l_a\fb'],
  ['vertical tab', 'l_a\u000Bb'],
  ['DEL 0x7f', 'l_a\u007Fb'],
  ['U+2028 line separator', 'l_a\u2028b'],
  ['U+2029 paragraph separator', 'l_a\u2029b'],
  ['NEL 0x85', 'l_a\u0085b'],
  ['non-breaking space', 'l_a b'],
  ['emoji (a surrogate pair)', 'l_a\u{1F600}b'],
  ['a lone surrogate', 'l_a\ud800b'],
  ['CSS selector metacharacters  ] [ .', 'l_a].[b'],
  ['slash and hash', 'l_a/#b'],
  ['percent', 'l_a%20b'],
  ['leading and trailing space', '  l_a  '],
  ['the string "constructor"', 'constructor'],
  ['a 300-character id', 'l_' + 'x'.repeat(300)],
];

/* THE PRODUCER DOOR. Exactly the path a model's payload takes:
 * validateOps at emit time, applyLineAdds at apply time, then the JSON round
 * trip that is the JSONB column. */
function storedRecord(estId, rawId) {
  const data = {
    id: estId, title: 'T ' + estId, defaultMarkup: 0, feeFlat: 500, feePct: 2, taxPct: 7,
    alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: BASE_ALT, lines: [],
  };
  const adds = [
    { description: 'Slab prep', qty: 1, unit: 'ls', unit_cost: 3400, section_name: 'General Conditions' },
    { description: 'Rebar #4', qty: 800, unit: 'lf', unit_cost: 1.15, section_name: 'Materials & Supplies Costs', markup_pct: 15 },
    { line_id: rawId, description: 'TARGET', qty: 10, unit: 'ea', unit_cost: 25, section_name: 'Materials & Supplies Costs' },
    { description: 'Concrete pump', qty: 1, unit: 'day', unit_cost: 1250, section_name: 'Subcontractors Costs' },
    { description: 'Finishers', qty: 32, unit: 'hr', unit_cost: 62, section_name: 'Direct Labor', markup_pct: 25 },
  ];
  PD.validateOps('estimate', { line_adds: adds });
  D.applyLineAdds(data, adds);
  data.lines.filter((l) => l.section === '__section_header__')
    .forEach((h, i) => { h.markup = [10, 20, 30, 40][i % 4]; });
  return clone(data);
}

function coRecord(rawId) {
  return {
    id: 'co_1', job_id: 1, co_number: 'CO-001', title: 'CO', status: 'draft', is_locked: false,
    lines: [
      { id: 'co_s0', description: 'Materials', label: 'Materials', section: '__section_header__', markup: 10, markupMode: 'percent' },
      { id: 'co_l1', description: 'Rebar', qty: 800, unit: 'lf', unitCost: 1.15, markup: '', markupMode: 'percent' },
      { id: rawId, description: 'TARGET', qty: 10, unit: 'ea', unitCost: 25, markup: '', markupMode: 'percent' },
      { id: 'co_s1', description: 'Labor', label: 'Labor', section: '__section_header__', markup: 25, markupMode: 'percent' },
      { id: 'co_l3', description: 'Finishers', qty: 32, unit: 'hr', unitCost: 62, markup: '', markupMode: 'percent' },
    ],
  };
}

/* WHICH SECTION IS EACH LINE IN — the money-safety signature. An estimate's
 * sections are delimited by __section_header__ rows and membership is ARRAY
 * POSITION, so anything that reorders or drops a line re-sections the estimate
 * and moves money between scopes while the cost total sits still. */
function membership(lines) {
  const out = [];
  let header = null;
  (lines || []).forEach((l) => {
    if (!l || typeof l !== 'object') return;
    if (l.section === '__section_header__') { header = l.description || '(unnamed)'; return; }
    out.push((l.description || '') + ' :: ' + (header === null ? '(no section)' : header));
  });
  return out;
}

function price(est, lines) {
  const group = (lines || []).filter((l) => l && l.alternateId === est.activeAlternateId);
  const per = P.computeForLines(est, group);
  const marked = P.resolveMarkedUp(per, est);
  const ft = P.applyFeesAndTax(P.num(marked), est, P.sumOfPriced([per]));
  return { cost: per.subtotal.toFixed(2), sell: P.num(marked).toFixed(2), total: ft.total.toFixed(2) };
}

afterAll(() => { H.closeAll(); CH.closeAll(); });

/* ═════════════════════════════════════════════════════════════════════════
 * A ROW THAT CANNOT BE ADDRESSED IS VISIBLY BROKEN.
 *
 * Encoding removes every shape we know of, so this path should be unreachable
 * — which is exactly why it has to shout when it is reached. `if (!line)
 * return;` is the shape that cost this project days: the field takes the
 * keystroke, the record never moves, the pill reads "No changes", and there is
 * nothing in the console. The state below is a real one: another surface (the
 * live writer, a second tab's save, an agent apply) removed the line while the
 * table was still painted.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an unaddressable row is shown, not swallowed', () => {
  let h;
  beforeEach(() => {
    h = H.boot();
    h.hydrate([storedRecord('est_open', 'l_gone')]);
    h.open('est_open');
    // The row is painted. Now the line leaves the record underneath it.
    const i = h.lines().findIndex((l) => l.description === 'TARGET');
    h.lines().splice(i, 1);
  });
  afterEach(() => { try { h.w.close(); } catch (e) {} });

  test('a keystroke on it says so, and marks the row', () => {
    const row = h.rows().find((r) => r.id === 'l_gone');
    expect(row).toBeTruthy();
    h.typeInto(row.el, 'unitCost', 1650);
    expect(h.w.__alerts.join(' ')).toMatch(/lost its address/i);
    expect(h.w.__alerts.join(' ')).toMatch(/NOT saved/i);
    expect(row.el.getAttribute('data-line-unreachable')).toBe('1');
  });

  test('a delete on it says so too, rather than looking like it worked', () => {
    const row = h.rows().find((r) => r.id === 'l_gone');
    const n = h.lines().length;
    row.el.querySelector('[data-cell="delete"] button')
      .dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
    expect(h.w.__alerts.join(' ')).toMatch(/lost its address/i);
    expect(h.lines()).toHaveLength(n);
  });
});

describe.each(SHAPES)('id shape: %s', (label, rawId) => {
  /* ── PROVENANCE ─────────────────────────────────────────────────────── */
  test('the producer door accepts it and stores it VERBATIM', () => {
    expect(() => PD.validateOps('estimate', { line_adds: [{ line_id: rawId, description: 'T', qty: 1, unit_cost: 1 }] }))
      .not.toThrow();
    const rec = storedRecord('est_open', rawId);
    const stored = rec.lines.find((l) => l.description === 'TARGET').id;
    // Not "close enough": the exact bytes, through validate, apply and JSONB.
    expect(stored).toBe(rawId);
  });

  /* ── THE ESTIMATE EDITOR ────────────────────────────────────────────── */
  describe('the estimate editor', () => {
    let h, rec, before, est;

    beforeEach(() => {
      rec = storedRecord('est_open', rawId);
      h = H.boot();
      h.w.eval('window.__PWN=[]; window.__err=[]; window.onerror=function(m){window.__err.push(String(m));return true;};');
      h.hydrate([rec]);
      h.open('est_open');
      before = clone(h.lines());
      est = h.w.appData.estimates[0];
    });
    afterEach(() => { try { h.w.close(); } catch (e) {} });

    const targetRow = () => {
      const rows = h.rows();
      const t = h.lines().find((l) => l && l.description === 'TARGET');
      return { rows, t, row: rows.find((r) => r.id === String(t.id)) };
    };

    test('the row paints and ADDRESSES the stored line', () => {
      const { rows, t, row } = targetRow();
      expect(rows).toHaveLength(before.length);
      // The DOM address is the ENCODED id, and it decodes back to the record.
      expect(row).toBeTruthy();
      expect(row.key).toBe(DOM.enc(t.id));
      expect(DOM.dec(row.key)).toBe(String(t.id));
    });

    test('nothing stored is compiled: the paint executes no script', () => {
      const { row } = targetRow();
      // Painting alone, plus a hover, plus a click anywhere on the row —
      // the attribute break-out shape fired on MOUSEOVER, without a click.
      row.el.dispatchEvent(new h.w.MouseEvent('mouseover', { bubbles: true }));
      row.el.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
      expect(h.w.__PWN).toEqual([]);
      // And no attacker-authored attribute made it onto the element.
      const attrs = Array.from(row.el.attributes).map((a) => a.name.toLowerCase());
      expect(attrs.filter((a) => /^on/.test(a))).toEqual([]);
    });

    test('typing into that row changes that row and ONLY that row, and arms the save', () => {
      const { t, row } = targetRow();
      const idx = h.lines().indexOf(t);

      h.typeInto(row.el, 'unitCost', 1650);
      h.typeInto(row.el, 'description', 'RENAMED BY HAND');

      const after = h.lines();
      expect(after[idx].unitCost).toBe(1650);
      expect(after[idx].description).toBe('RENAMED BY HAND');
      // Every other line byte-identical, at the same index.
      const moved = after
        .map((l, i) => (JSON.stringify(l) === JSON.stringify(before[i]) ? null : i))
        .filter((i) => i !== null);
      expect(moved).toEqual([idx]);
      // The pill is the thing the old defect left lying: a keystroke that
      // reaches the record must also arm the autosave.
      expect(h.w.document.getElementById('ee-save-indicator').textContent).toMatch(/Unsaved/);
    });

    test('deleting that row removes that row and only that row, in order', async () => {
      const { t, row } = targetRow();
      const del = row.el.querySelector('[data-cell="delete"] button');
      expect(del).toBeTruthy();
      del.dispatchEvent(new h.w.MouseEvent('click', { bubbles: true }));
      await tick();
      const after = h.lines();
      expect(after).toHaveLength(before.length - 1);
      expect(after.some((l) => String(l.id) === String(t.id))).toBe(false);
      expect(after.map((l) => l.description))
        .toEqual(before.filter((l) => l.description !== 'TARGET').map((l) => l.description));
      expect(h.w.__PWN).toEqual([]);
    });

    test('the SECTION HEADER above it re-prices, and moves the money it should', () => {
      // A dead header is worse than a dead line: it is the multiplier for
      // every line beneath it, and it goes on painting its name and its
      // markup box while refusing the number typed into it.
      const header = h.lines().find((l) => l.section === '__section_header__' && /Materials/.test(l.description));
      const hrow = h.rows().find((r) => r.id === String(header.id));
      expect(hrow).toBeTruthy();
      const total0 = price(est, h.lines()).total;

      const box = hrow.el.querySelector('input[data-ee-act="sect-markup"]');
      expect(box).toBeTruthy();
      box.value = '35';
      box.dispatchEvent(new h.w.Event('change', { bubbles: true }));

      expect(Number(h.lines().find((l) => l.id === header.id).markup)).toBe(35);
      expect(price(est, h.lines()).total).not.toBe(total0);
      expect(h.w.__PWN).toEqual([]);
    });

    test('painting and addressing the row re-prices NOTHING and re-sections NOTHING', () => {
      // The open + paint above already happened in beforeEach; this asserts
      // the record it left behind is the record the door produced.
      const produced = storedRecord('est_open', rawId).lines;
      expect(membership(h.lines())).toEqual(membership(produced));
      expect(price(est, h.lines())).toEqual(price(est, produced));
      // The stored id itself is untouched — an encoding is a rendering step,
      // never a migration.
      expect(h.lines().find((l) => l.description === 'TARGET').id).toBe(rawId);
    });

    test('the row is byte-stable across a repaint', () => {
      // js/line-identity.js invariant 2 — an address is minted once and never
      // re-derived, because a row that changes address on a repaint detaches
      // the caret from the cell being typed into. Repainted through the real
      // door rather than a private function.
      const first = h.rows().map((r) => r.key);
      h.open('est_open');
      expect(h.rows().map((r) => r.key)).toEqual(first);
      expect(new Set(first).size).toBe(first.length);   // …and unique
    });
  });

  /* ── THE CHANGE-ORDER EDITOR, on the same stored id ─────────────────── */
  describe('the change-order editor', () => {
    let c, before;

    beforeEach(() => {
      c = CH.boot();
      c.w.eval('window.__PWN=[];');
      c.setCo(coRecord(rawId));
      before = clone(c.lines());
    });
    afterEach(() => { try { c.w.close(); } catch (e) {} });

    const targetTr = () => Array.from(c.w.document.querySelectorAll('#p86CoLineTable tr[data-line-id]'))
      .find((tr) => {
        const i = tr.querySelector('[data-line-field="description"]');
        return i && String(i.value).indexOf('TARGET') === 0;
      });

    test('the row ADDRESSES the stored line', () => {
      const tr = targetTr();
      expect(tr).toBeTruthy();
      expect(tr.getAttribute('data-line-id')).toBe(DOM.enc(rawId));
      expect(DOM.dec(tr.getAttribute('data-line-id'))).toBe(String(rawId));
    });

    test('typing into that row changes that row and ONLY that row', () => {
      const tr = targetTr();
      const idx = c.lines().findIndex((l) => l.description === 'TARGET');
      const q = tr.querySelector('[data-line-field="unitCost"]');
      q.value = '1650';
      q.dispatchEvent(new c.w.Event('input', { bubbles: true }));

      const after = c.lines();
      expect(Number(after[idx].unitCost)).toBe(1650);
      const moved = after
        .map((l, i) => (JSON.stringify(l) === JSON.stringify(before[i]) ? null : i))
        .filter((i) => i !== null);
      expect(moved).toEqual([idx]);
      expect(c.w.__PWN).toEqual([]);
    });

    test('deleting that row removes that row and only that row', () => {
      const tr = targetTr();
      tr.querySelector('[data-line-del]').click();
      const after = c.lines();
      expect(after).toHaveLength(before.length - 1);
      expect(after.some((l) => String(l.id) === String(rawId))).toBe(false);
      expect(after.map((l) => l.description))
        .toEqual(before.filter((l) => l.description !== 'TARGET').map((l) => l.description));
      expect(c.w.__PWN).toEqual([]);
    });
  });

  /* ── THE TWO EDITORS AGREE ──────────────────────────────────────────── */
  test('both editors paint the SAME address for the same stored id', () => {
    const h = H.boot();
    h.hydrate([storedRecord('est_open', rawId)]);
    h.open('est_open');
    const eeKey = h.rows().find((r) => r.el.textContent.indexOf('TARGET') >= 0
      || (r.el.querySelector('textarea') || {}).value === 'TARGET');
    const eeAttr = eeKey ? eeKey.key : null;
    try { h.w.close(); } catch (e) {}

    const c = CH.boot();
    c.setCo(coRecord(rawId));
    const tr = Array.from(c.w.document.querySelectorAll('#p86CoLineTable tr[data-line-id]'))
      .find((x) => {
        const i = x.querySelector('[data-line-field="description"]');
        return i && String(i.value).indexOf('TARGET') === 0;
      });
    const coAttr = tr ? tr.getAttribute('data-line-id') : null;
    try { c.w.close(); } catch (e) {}

    // One address, one encoder, two editors. Before this change the estimate
    // editor could reach rows the change-order editor could not, and the
    // change-order editor could reach rows the estimate editor could not.
    expect({ ee: eeAttr, co: coAttr }).toEqual({ ee: DOM.enc(rawId), co: DOM.enc(rawId) });
  });
});
