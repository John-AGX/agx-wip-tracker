/**
 * @jest-environment jsdom
 */
// THE OFFICE'S BILLING PANEL (js/service-ticket-billing.js).
//
// Driven in jsdom against the shipped module. The properties that matter here
// are not "does it render" — they are the four decisions John made on
// 2026-09-26, each of which has a wrong version that looks identical on
// screen until somebody bills the wrong number:
//
//   * the panel NEVER recomputes money. Every total it shows is the server's,
//     from the same functions the bill is built with, so a rounding rule can
//     only ever live in one place;
//   * the market's rate is OFFERED, and the panel says plainly when the rate
//     this ticket is using is no longer the market's;
//   * a catalogue price is a button, not a pre-filled box;
//   * an inherited markup and a chosen markup do not look the same;
//   * and over contract, the box will not carry more than the price.
'use strict';

require('../js/service-ticket-ext.js');
require('../js/service-ticket-billing.js');
const BL = window.p86TicketBilling;

function sheet(over) {
  return Object.assign({
    enabled: true,
    bill_as: 'time_materials',
    destination: { kind: 'change_order', job_id: 'j1' },
    rate: { value: 95, source: 'market', market_default: 95 },
    default_markup_pct: 15,
    lines: [
      { kind: 'labor', id: 'lb1', description: 'Replaced the check valve.', work_date: '2026-09-14',
        task_title: 'Bldg 4', qty: 13, unit: 'hr', unit_cost: 95, cost_source: 'rate',
        markup_pct: null, effective_markup_pct: 15, receipts: 0,
        ready: true, ext: 1235, unit_sell: 109.25, total: 1420.25 },
      { kind: 'material', id: 'mt1', description: '2in PVC check valve', work_date: null,
        task_title: null, qty: 1, unit: 'ea', unit_cost: 42.5, cost_source: 'typed',
        markup_pct: 30, effective_markup_pct: 30, receipts: 2,
        ready: true, ext: 42.5, unit_sell: 55.25, total: 55.25 },
      { kind: 'material', id: 'mt2', description: 'Pipe dope', work_date: null, task_title: null,
        qty: 2, unit: 'ea', unit_cost: null, cost_source: null,
        markup_pct: null, effective_markup_pct: 15, receipts: 0,
        catalog: { unit_cost: 6.25, unit: 'ea', matched: 'Pipe dope' },
        ready: false, ext: null, unit_sell: null, total: null },
    ],
    totals: { cost: 1277.5, markup: 198.25, price: 1475.75 },
    contract: null,
    waiting: 0,
    billed: null,
    blockers: [{ code: 'no_cost', message: 'Give every material a cost before billing.', count: 1, ids: ['mt2'] }],
  }, over || {});
}

function mount(opts) {
  const o = opts || {};
  const calls = [];
  const ok = () => Promise.resolve({ ok: true, billed: { kind: 'change_order', number: 'CO-3' } });
  window.p86Api = { serviceTickets: {
    setBilling: (id, body) => { calls.push(['setBilling', id, body]); return ok(); },
    setBillingLine: (id, kind, line, body) => { calls.push(['setBillingLine', id, kind, line, body]); return ok(); },
    bill: (id, body) => { calls.push(['bill', id, body]); return ok(); },
    writeOffBilling: (id, reason) => { calls.push(['writeOff', id, reason]); return ok(); },
  } };
  window.p86Confirm = () => Promise.resolve(true);
  window.p86Prompt = () => Promise.resolve(o.reason === undefined ? 'Warranty.' : o.reason);
  window.p86Toast = () => {};

  const ctx = {
    t: Object.assign({ id: 'st_j', status: 'approved', bill_as: 'time_materials', job_id: 'j1' }, o.t || {}),
    r: { billing: o.sheet === undefined ? sheet() : o.sheet, field_log: o.log || { materials: [] } },
    canEdit: o.canEdit !== false,
  };
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const paint = () => {
    const secs = BL.extension.detailSections(ctx);
    host.innerHTML = secs.length ? secs[0].html : '';
    if (secs.length && host.firstElementChild) secs[0].wire(host.firstElementChild, ctx);
  };
  ctx.refresh = () => { paint(); return Promise.resolve(); };
  paint();
  return { host, calls, ctx, paint };
}

const q = (h, sel) => h.querySelector(sel);
const all = (h, sel) => Array.from(h.querySelectorAll(sel));
const text = (h) => (h.textContent || '').replace(/\s+/g, ' ').trim();
const flush = () => new Promise((r) => setTimeout(r, 0));

// ── 1. when there is a panel at all ──────────────────────────────────────
describe('the panel exists only where money does', () => {
  test('no billing on the read, no section', () => {
    expect(BL.extension.detailSections({ r: {}, t: {} })).toEqual([]);
  });

  test('a ticket that bills nothing draws nothing', () => {
    expect(BL.extension.detailSections({ r: { billing: { enabled: false } }, t: {} })).toEqual([]);
  });

  test('and it sits after the field log, never before it', () => {
    const fl = require('../js/service-ticket-field-log.js');
    expect(BL.extension.order).toBeGreaterThan(fl.extension.order);
  });
});

// ── 2. THE PANEL DOES NOT DO ARITHMETIC ──────────────────────────────────
describe('every number shown is the server’s', () => {
  test('the totals row is the sheet’s totals, not a sum of the rows', () => {
    // Deliberately INCONSISTENT input: the rows add to 1475.50 and the totals
    // say 9999. If the panel ever starts adding up its own rows this goes red
    // — which is the point, because then a rounding rule would live twice.
    const s = sheet({ totals: { cost: 1, markup: 2, price: 9999 } });
    const { host } = mount({ sheet: s });
    const foot = all(host, '.p86-bl-grid tfoot td').map((td) => text(td));
    expect(foot).toEqual(['Totals', '$1.00', '$2.00', '$9,999.00']);
  });

  test('a line total is the server’s, even when it disagrees with qty × cost', () => {
    const s = sheet();
    s.lines[0].total = 4242.42;
    const { host } = mount({ sheet: s });
    expect(text(q(host, '.p86-bl-line[data-line="lb1"] .p86-bl-total'))).toBe('$4,242.42');
  });

  test('the module contains no money arithmetic \u2014 only formatting', () => {
    // A backstop under the behavioural tests above, and deliberately NARROW.
    // The first version of this forbade '/ 100)' outright and caught the
    // QUANTITY formatter's Math.round(n * 100) / 100, which is rounding a
    // display, not pricing anything. A scanner that flags honest code teaches
    // the next reader to delete it. So it names the three shapes that would
    // actually mean money is being computed here, and nothing else.
    const path = require('path');
    const raw = require('fs').readFileSync(path.join(__dirname, '..', 'js', 'service-ticket-billing.js'), 'utf8');
    // Prose about the formula is not the formula.
    const src = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    expect(src).not.toMatch(/1\s*\+[^;\n]*markup/i);              // cost × (1 + m/100)
    expect(src).not.toMatch(/reduce\s*\(/);                        // summing the lines
    expect(src).not.toMatch(/(unit_cost|unit_sell)\s*[*]/);        // qty × cost
    expect(src).not.toMatch(/[*]\s*[\w.]*(unit_cost|unit_sell)/);
    // …and it still reads every total straight off the sheet.
    expect(src).toMatch(/money\(s\.totals\.price\)/);
  });
});

// ── 3. the rate ──────────────────────────────────────────────────────────
describe('the labour rate', () => {
  test('with no rate set, the market’s is offered as a button', () => {
    const s = sheet({ rate: { value: null, source: null, market_default: 95 } });
    const { host } = mount({ sheet: s });
    expect(text(q(host, '.p86-bl-offer'))).toContain('This market bills at $95.00/hr');
    expect(q(host, '.p86-bl-usemarket')).not.toBe(null);
  });

  test('pressing it asks the SERVER for the market rate — the number is not copied in the browser', async () => {
    const s = sheet({ rate: { value: null, source: null, market_default: 95 } });
    const { host, calls } = mount({ sheet: s });
    q(host, '.p86-bl-usemarket').click();
    await flush();
    expect(calls).toEqual([['setBilling', 'st_j', { use_market_rate: true }]]);
  });

  test('a rate that no longer matches the market SAYS SO, rather than quietly changing', () => {
    const s = sheet({ rate: { value: 95, source: 'market', market_default: 250 } });
    const { host } = mount({ sheet: s });
    const t = text(q(host, '.p86-bl-offer'));
    expect(t).toContain('now bills at $250.00/hr');
    expect(t).toContain('using $95.00');
    // …and the box still holds the STAMPED rate, not the market's.
    expect(q(host, '.p86-bl-in[data-f="labor_rate"]').value).toBe('95');
  });

  test('when they agree there is nothing to press', () => {
    const { host } = mount({});
    expect(text(q(host, '.p86-bl-offer'))).toBe('From the market default.');
    expect(q(host, '.p86-bl-usemarket')).toBe(null);
  });

  test('the rate commits on change, not on every keystroke', async () => {
    const { host, calls } = mount({});
    const el = q(host, '.p86-bl-in[data-f="labor_rate"]');
    el.value = '11';
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    el.value = '112.5';
    el.dispatchEvent(new window.Event('input', { bubbles: true }));
    expect(calls).toEqual([]);            // nothing yet — a repaint would eat the cursor
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(calls).toEqual([['setBilling', 'st_j', { labor_rate: '112.5' }]]);
  });

  test('clearing it sends null, not an empty string', async () => {
    const { host, calls } = mount({});
    const el = q(host, '.p86-bl-in[data-f="labor_rate"]');
    el.value = '';
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(calls[0][2]).toEqual({ labor_rate: null });
  });
});

// ── 4. a material's cost ─────────────────────────────────────────────────
describe('a material’s cost', () => {
  test('the catalogue price is a BUTTON, and the box beside it is empty', () => {
    const { host } = mount({});
    const row = q(host, '.p86-bl-line[data-line="mt2"]');
    expect(q(row, 'input[data-f="unit_cost"]').value).toBe('');
    expect(text(q(row, '.p86-bl-cat'))).toBe('Bought at $6.25');
  });

  test('pressing it records that the price came from the catalogue', async () => {
    const { host, calls } = mount({});
    q(host, '.p86-bl-line[data-line="mt2"] .p86-bl-cat').click();
    await flush();
    expect(calls).toEqual([['setBillingLine', 'st_j', 'material', 'mt2', { unit_cost: '6.25', cost_source: 'catalog' }]]);
  });

  test('a line that already has a cost is not offered one', () => {
    const { host } = mount({});
    expect(q(host, '.p86-bl-line[data-line="mt1"] .p86-bl-cat')).toBe(null);
  });

  test('a typed cost does not claim to be the catalogue’s', async () => {
    const { host, calls } = mount({});
    const el = q(host, '.p86-bl-line[data-line="mt2"] input[data-f="unit_cost"]');
    el.value = '7.15';
    el.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(calls[0][4]).toEqual({ unit_cost: '7.15' });   // no cost_source: the server says 'typed'
  });

  test('a costless line says so instead of showing $0.00', () => {
    const { host } = mount({});
    expect(text(q(host, '.p86-bl-line[data-line="mt2"] .p86-bl-total'))).toBe('needs a cost');
    expect(text(q(host, '.p86-bl-line[data-line="mt2"] .p86-bl-total'))).not.toContain('0.00');
  });

  test('labour takes no cost box — there is one rate, set once, above', () => {
    const { host } = mount({});
    const row = q(host, '.p86-bl-line[data-line="lb1"]');
    expect(q(row, 'input[data-f="unit_cost"]')).toBe(null);
    expect(text(q(row, '.p86-bl-cost'))).toBe('$95.00');
  });

  test('the receipts are reachable from the row the price came off', () => {
    const { host } = mount({});
    expect(text(q(host, '.p86-bl-line[data-line="mt1"] .p86-bl-shot'))).toBe('2 receipts');
    expect(q(host, '.p86-bl-line[data-line="mt2"] .p86-bl-shot')).toBe(null);
  });
});

// ── 5. markup ────────────────────────────────────────────────────────────
describe('markup', () => {
  test('an INHERITED markup shows the ticket’s number as a placeholder, not a value', () => {
    const { host } = mount({});
    const el = q(host, '.p86-bl-line[data-line="lb1"] input[data-f="markup_pct"]');
    expect(el.value).toBe('');            // nobody chose it
    expect(el.getAttribute('placeholder')).toBe('15');
    expect(q(host, '.p86-bl-line[data-line="lb1"] .p86-bl-markup').className).toContain('is-inherited');
  });

  test('a CHOSEN markup is a value, and does not read as inherited', () => {
    const { host } = mount({});
    const el = q(host, '.p86-bl-line[data-line="mt1"] input[data-f="markup_pct"]');
    expect(el.value).toBe('30');
    expect(q(host, '.p86-bl-line[data-line="mt1"] .p86-bl-markup').className).not.toContain('is-inherited');
  });

  test('a chosen ZERO is a value too — the case that reads as absent everywhere else', () => {
    const s = sheet();
    s.lines[0].markup_pct = 0;
    s.lines[0].effective_markup_pct = 0;
    const { host } = mount({ sheet: s });
    const el = q(host, '.p86-bl-line[data-line="lb1"] input[data-f="markup_pct"]');
    expect(el.value).toBe('0');
    expect(q(host, '.p86-bl-line[data-line="lb1"] .p86-bl-markup').className).not.toContain('is-inherited');
  });
});

// ── 6. the contract ceiling ──────────────────────────────────────────────
describe('a contract price is the price', () => {
  const contract = () => sheet({
    bill_as: 'contract',
    rate: { value: null, source: null, market_default: null },
    lines: [{ kind: 'contract', id: 'contract', description: 'ST-0001 — Rail repaint', qty: 1, unit: null,
      unit_cost: 8000, markup_pct: null, effective_markup_pct: 0, receipts: 0,
      ready: true, ext: 8000, unit_sell: 8000, total: 8000 }],
    totals: { cost: 8000, markup: 0, price: 8000 },
    contract: { amount: 8000, remaining: 0 },
    blockers: [],
  });

  test('the amount box cannot be dragged past the price', () => {
    const { host } = mount({ sheet: contract() });
    const el = q(host, '.p86-bl-in[data-f="amount"]');
    expect(el.getAttribute('max')).toBe('8000');
    expect(el.value).toBe('8000');
  });

  test('and the panel names the road past it instead of offering a way through', () => {
    const { host } = mount({ sheet: contract() });
    const cap = text(q(host, '.p86-bl-cap'));
    expect(cap).toContain('change order');
    // No override anywhere on the panel — the refusal is absolute.
    expect(host.innerHTML).not.toMatch(/override|force|anyway|i mean it/i);
  });

  // John, 2026-09-27: "if a service ticket needs a change order it should
  // create one in the jobs change orders section." It already did — the
  // change-order door has always written to ticket.job_id. What it did not
  // do was say so where somebody hits the ceiling, which turned a refusal
  // into a dead end.
  test('the road sits at the wall: the cap line carries the change-order button', () => {
    const { host } = mount({ sheet: contract() });
    const cap = q(host, '.p86-bl-cap');
    expect(text(cap)).toContain('extra work is a change order on this job');
    const btn = q(cap, '.p86-bl-co');
    expect(btn).not.toBe(null);
    // The SAME button the change-order panel draws, not a second way in: the
    // delegated [data-co-src] handler on the detail element opens the one
    // flow, with its one already-started guard.
    expect(btn.getAttribute('data-co-src')).toBe('ticket');
  });

  test('and the panel does not swallow the click — it has to reach the detail element', () => {
    // The billing panel has its own delegated click handler. If it ever
    // called stopPropagation, or claimed this button, the button would look
    // right and do nothing.
    const { host, calls } = mount({ sheet: contract() });
    let reached = null;
    host.addEventListener('click', (e) => {
      const src = e.target.closest && e.target.closest('[data-co-src]');
      if (src) reached = src.getAttribute('data-co-src');
    });
    q(host, '.p86-bl-co').click();
    expect(reached).toBe('ticket');
    expect(calls).toEqual([]);          // and it billed nothing on the way past
  });

  test('a ticket on a LEAD says there is no change orders section to put one in', () => {
    // A lead has no job, so John's rule has nowhere to land. Saying so is the
    // only honest answer; the alternative is a button that 404s.
    const { host } = mount({ sheet: contract(), t: { id: 'st_l', job_id: null, lead_id: 'ld1' } });
    const cap = text(q(host, '.p86-bl-cap'));
    expect(cap).toContain('belongs to a lead, not a job');
    expect(cap).toContain('needs a job first');
    expect(q(host, '.p86-bl-co')).toBe(null);
  });

  test('a reader who cannot edit sees the sentence and no button', () => {
    const { host } = mount({ sheet: contract(), canEdit: false });
    expect(text(q(host, '.p86-bl-cap'))).toContain('extra work is a change order');
    expect(q(host, '.p86-bl-co')).toBe(null);
  });

  test('billing sends the amount', async () => {
    const { host, calls } = mount({ sheet: contract() });
    q(host, '.p86-bl-bill').click();
    await flush();
    expect(calls).toEqual([['bill', 'st_j', { amount: '8000' }]]);
  });

  test('a contract line carries no markup box — there is nothing to mark up', () => {
    const { host } = mount({ sheet: contract() });
    expect(q(host, '.p86-bl-line input[data-f="markup_pct"]')).toBe(null);
  });

  test('and no labour rate either — a contract ticket has no labour lines', () => {
    // Caught by looking at the rendered panel, not by a test: the rate row
    // was drawn on a contract ticket, where it is a control that changes
    // nothing. A box that does nothing still reads as a box you should fill.
    const { host } = mount({ sheet: contract() });
    expect(q(host, '.p86-bl-in[data-f="labor_rate"]')).toBe(null);
    expect(q(host, '.p86-bl-in[data-f="default_markup_pct"]')).toBe(null);
    // …while a work order still has both.
    const wo = mount({});
    expect(q(wo.host, '.p86-bl-in[data-f="labor_rate"]')).not.toBe(null);
  });
});

// ── 7. raising the draft ─────────────────────────────────────────────────
describe('raising the draft', () => {
  test('blocked while anything is outstanding, and it says what', () => {
    const { host } = mount({});
    expect(q(host, '.p86-bl-bill').disabled).toBe(true);
    expect(text(q(host, '.p86-bl-blockers'))).toBe('Give every material a cost before billing.');
  });

  test('ALL the blockers are listed, not the first one', () => {
    const s = sheet({ blockers: [
      { code: 'no_rate', message: 'Set the labour rate before billing.' },
      { code: 'no_cost', message: 'Give every material a cost before billing.' },
      { code: 'waiting', message: 'Decide the time and materials still waiting before billing.' },
    ] });
    const { host } = mount({ sheet: s });
    expect(all(host, '.p86-bl-blockers li').length).toBe(3);
  });

  test('cleared, it names the document it will make and says nothing is sent', () => {
    const { host } = mount({ sheet: sheet({ blockers: [] }) });
    expect(q(host, '.p86-bl-bill').disabled).toBe(false);
    expect(text(q(host, '.p86-bl-bill'))).toBe('Raise draft change order');
    expect(text(q(host, '.p86-bl-note'))).toContain('Nothing is sent');
  });

  test('a lead’s work order says INVOICE, because there is no contract to change', () => {
    const s = sheet({ blockers: [], destination: { kind: 'invoice', lead_id: 'ld1' } });
    const { host } = mount({ sheet: s });
    expect(text(q(host, '.p86-bl-bill'))).toBe('Raise draft invoice');
    expect(text(q(host, '.p86-bl-note'))).toContain('a draft invoice');
  });

  test('it asks once, and the question names the total', async () => {
    let asked = null;
    // AFTER mount: mount() installs a default p86Confirm, and setting this
    // first would simply be overwritten.
    const { host, calls } = mount({ sheet: sheet({ blockers: [] }) });
    window.p86Confirm = (t) => { asked = t; return Promise.resolve(true); };
    q(host, '.p86-bl-bill').click();
    await flush();
    expect(asked).toContain('$1,475.75');
    expect(calls).toEqual([['bill', 'st_j', {}]]);
  });

  test('and a no bills nothing', async () => {
    const { host, calls } = mount({ sheet: sheet({ blockers: [] }) });
    window.p86Confirm = () => Promise.resolve(false);
    q(host, '.p86-bl-bill').click();
    await flush();
    expect(calls).toEqual([]);
  });
});

// ── 8. once it is billed ─────────────────────────────────────────────────
describe('once it is billed', () => {
  const billed = () => sheet({
    billed: { kind: 'change_order', id: 'co_1', number: 'CO-3', at: '2026-09-26T12:00:00Z' },
    blockers: [{ code: 'already_billed', message: 'This work order has already been billed.' }],
  });

  test('the panel says what it became, and offers to open it', () => {
    const { host } = mount({ sheet: billed() });
    expect(text(q(host, '.p86-bl-state'))).toContain('became a draft change order — CO-3');
    expect(q(host, '.p86-bl-open')).not.toBe(null);
  });

  test('there is nothing left to press', () => {
    const { host } = mount({ sheet: billed() });
    expect(q(host, '.p86-bl-bill')).toBe(null);
    expect(q(host, '.p86-bl-writeoff')).toBe(null);
    expect(q(host, '.p86-bl-in[data-f="labor_rate"]')).toBe(null);
  });

  test('a written-off ticket says why', () => {
    const s = sheet({ billed: { kind: 'written_off', reason: 'Warranty return on our own work.' }, blockers: [] });
    const { host } = mount({ sheet: s });
    expect(text(q(host, '.p86-bl-state'))).toBe('Written off. Warranty return on our own work.');
  });
});

// ── 9. writing it off ────────────────────────────────────────────────────
describe('writing it off', () => {
  test('it asks why, and sends the reason', async () => {
    const { host, calls } = mount({});
    q(host, '.p86-bl-writeoff').click();
    await flush();
    expect(calls).toEqual([['writeOff', 'st_j', 'Warranty.']]);
  });

  test('no reason, no write-off — the panel does not send an empty one', async () => {
    const { host, calls } = mount({ reason: '   ' });
    q(host, '.p86-bl-writeoff').click();
    await flush();
    expect(calls).toEqual([]);
  });
});

// ── 10. a reader who cannot edit ─────────────────────────────────────────
describe('a reader who cannot edit', () => {
  test('sees the numbers and can change none of them', () => {
    const { host } = mount({ canEdit: false });
    expect(text(q(host, '.p86-bl-grid tfoot'))).toContain('$1,475.75');
    expect(all(host, 'input').every((i) => i.disabled)).toBe(true);
    expect(q(host, '.p86-bl-bill')).toBe(null);
    expect(q(host, '.p86-bl-writeoff')).toBe(null);
    expect(q(host, '.p86-bl-cat')).toBe(null);
  });
});

// ── 11. the timeline ─────────────────────────────────────────────────────
describe('what the timeline says', () => {
  test('a bill names the document and the money', () => {
    expect(BL.eventWhat({ kind: 'billed', detail: { destination: 'change_order', document_number: 'CO-3', price: 1475.75 } }))
      .toBe('Billed — draft change order CO-3, $1,475.75');
  });

  test('an invoice reads as one', () => {
    expect(BL.eventWhat({ kind: 'billed', detail: { destination: 'invoice', document_number: 'INV-12', price: 840 } }))
      .toBe('Billed — draft invoice INV-12, $840.00');
  });

  test('a write-off carries its reason', () => {
    expect(BL.eventWhat({ kind: 'written_off', detail: { reason: 'Goodwill.' } })).toBe('Written off — Goodwill.');
  });

  test('and it says nothing about events that are not its own', () => {
    expect(BL.eventWhat({ kind: 'labor_sent', detail: {} })).toBe(null);
  });
});

// ── 12. money is formatted, never invented ───────────────────────────────
describe('the unit labels survive the app\u2019s global label rule', () => {
  test('the $ and the /hr are not uppercased into "/HR"', () => {
    // css/styles.css has a global \`label { text-transform: uppercase }\` that
    // reaches every descendant, and these boxes sit inside a <label>. The
    // panel rendered "/HR" until .p86-bl-money-in reset it. A stylesheet
    // assertion, because there is no cascade in jsdom to measure.
    const css = require('fs').readFileSync(
      require('path').join(__dirname, '..', 'css', 'service-ticket-billing.css'), 'utf8');
    const at = css.indexOf('.p86-bl-money-in {');
    expect(at).toBeGreaterThan(0);
    expect(css.slice(at, css.indexOf('}', at))).toMatch(/text-transform:\s*none/);
  });
});

describe('formatting', () => {
  test('to the cent, with thousands, and a blank stays blank', () => {
    expect(BL.money(1475.75)).toBe('$1,475.75');
    expect(BL.money(840)).toBe('$840.00');
    expect(BL.money(1234567.5)).toBe('$1,234,567.50');
    expect(BL.money(0)).toBe('$0.00');
    // A missing number is NOT zero — that is the whole point of a costless line.
    expect(BL.money(null)).toBe('');
    expect(BL.money('')).toBe('');
    expect(BL.money('abc')).toBe('');
  });
});
