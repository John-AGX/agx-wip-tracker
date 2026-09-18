// js/service-ticket-co.js — Start change order on the office ticket screen
// (Work Orders 1.29, B8).
//
// What is proved:
//   * prefillFor: the dialog's title, description and ticked photos for each
//     source — the ticket itself, a crew suggestion, a building note and a
//     flagged problem — with the office's flag wording ('Extra damage — Bldg
//     784', 'Problem — …' for other).
//   * sourceButtonHTML: "Start change order" until one exists for that exact
//     source, then "CO-4 started", which opens it.
//   * registration with window.p86StExt ('ticket-co', order 50): the row chip,
//     the status chip, the Change orders list, the actions button only for
//     someone who may start one, the suggestion and note buttons, the timeline
//     wording, and the card action on window.p86TicketFlags.
//   * the dialog: what it sends, the inline refusals, the 24-photo cap, the
//     duplicate question with Start another, and what happens after a start —
//     the toast, the ticket re-read, p86Refresh('co', {id, jobId}) and the change
//     order editor opening, with the ticket re-read again when it closes.
//
// The REAL file runs: in node for the pure helpers, in jsdom with
// js/service-ticket-ext.js and js/service-ticket-flags.js loaded first, as
// index.html does. Mutants: a temp copy, CRLF normalised, each anchor exactly
// once or 'anchor not found'.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { JSDOM } = require('jsdom');

const CO_PATH = path.join(__dirname, '..', 'js', 'service-ticket-co.js');
const EXT_PATH = path.join(__dirname, '..', 'js', 'service-ticket-ext.js');
const FLAGS_PATH = path.join(__dirname, '..', 'js', 'service-ticket-flags.js');
const CO_SRC = fs.readFileSync(CO_PATH, 'utf8');
const EXT_SRC = fs.readFileSync(EXT_PATH, 'utf8');
const FLAGS_SRC = fs.readFileSync(FLAGS_PATH, 'utf8');

const made = [];
afterAll(() => {
  for (const p of made) {
    try { delete require.cache[require.resolve(p)]; } catch (_) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (_) { /* already gone */ }
  }
});

function writeMutant(edits) {
  let out = CO_SRC.replace(/\r\n/g, '\n');
  for (const [find, replace] of edits) {
    if (out.split(find).length !== 2) throw new Error('anchor not found');
    out = out.split(find).join(replace);
  }
  const p = path.join(os.tmpdir(), '_p86_w4c_co_' + process.pid + '_' + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, out, 'utf8');
  made.push(p);
  return p;
}

const pure = (edits) => (edits ? require(writeMutant(edits)) : require(CO_PATH)).__test;

// ── fixtures ──────────────────────────────────────────────────────────────
function photos(prefix, n) {
  const out = [];
  for (let i = 1; i <= n; i++) out.push({ id: prefix + i, kind: i === 1 ? 'before' : 'completion', thumb_url: '/t/' + prefix + i + '.jpg', web_url: '/w/' + prefix + i + '.jpg' });
  return out;
}

function readFixture(over) {
  return Object.assign({
    ticket: { id: 'st_1', title: 'Stairs on Maple', status: 'in_progress', job_id: 'j1', lead_id: null, archived_at: null },
    site: { job_number: 'J-784', name: 'Maple Court', address: '12 Maple Ct' },
    tasks: [
      {
        id: 'k1', title: 'Bldg 784 — Side A: rail post; tread 3', status: 'done', photos: photos('p784_', 2),
        notes: [{ id: 'ev_n1', note: 'Rot behind the siding, about 6 feet', by: 'Marco', at: '2026-09-10T10:00:00Z' }],
      },
      { id: 'k2', title: 'Bldg 790', status: 'open', photos: photos('p790_', 1), notes: [] },
    ],
    revisions: [
      { id: 'rev1', note: 'Found a cracked stringer', fields: '{"scope_proposed":"Replace the stringer on 790"}', status: 'pending' },
      { id: 'rev2', note: '', fields: { scope_proposed: 'Only a scope' }, status: 'accepted' },
    ],
    flags: [
      { id: 'fl1', task_id: 'k1', category: 'extra_damage', note: 'Joist is rotten', status: 'open', photos: [{ id: 'pf1', thumb_url: '/t/pf1.jpg' }] },
      { id: 'fl2', task_id: null, category: 'other', note: 'Neighbour complained', status: 'open', photos: [] },
    ],
    site_photos: [{ id: 'ps1', thumb_url: '/t/ps1.jpg' }],
    change_orders: [],
  }, over || {});
}

const ctxOf = (r) => ({ t: r.ticket, r });

/* ═══════════════════════════════════════════════════════════════════════════
 * PURE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('prefillFor', () => {
  const { prefillFor } = pure();

  test('the ticket itself: "Extra work — <ticket>", nothing described, no photos ticked', () => {
    expect(prefillFor('ticket', null, ctxOf(readFixture()))).toEqual({
      kind: 'ticket', id: null, title: 'Extra work — Stairs on Maple', description: '', photoIds: [],
    });
  });

  test('a suggestion: its note and proposed scope, a blank line between', () => {
    const r = readFixture();
    expect(prefillFor('revision', 'rev1', ctxOf(r))).toMatchObject({
      kind: 'revision', id: 'rev1', title: 'Extra work — Stairs on Maple',
      description: 'Found a cracked stringer\n\nReplace the stringer on 790', photoIds: [],
    });
    expect(prefillFor('revision', 'rev2', ctxOf(r)).description).toBe('Only a scope');
  });

  test('a building note: the building in the title, the note, that building\'s photos ticked', () => {
    expect(prefillFor('building_note', 'ev_n1', ctxOf(readFixture()))).toEqual({
      kind: 'building_note', id: 'ev_n1', title: 'Extra work — Bldg 784',
      description: 'Rot behind the siding, about 6 feet', photoIds: ['p784_1', 'p784_2'],
    });
  });

  test('a flagged problem: the office label and the building, the flag\'s own photos ticked', () => {
    const r = readFixture();
    expect(prefillFor('flag', 'fl1', ctxOf(r))).toEqual({
      kind: 'flag', id: 'fl1', title: 'Extra damage — Bldg 784', description: 'Joist is rotten', photoIds: ['pf1'],
    });
    // 'other' reads as Problem, and a ticket-level flag names the ticket.
    expect(prefillFor('flag', 'fl2', ctxOf(r)).title).toBe('Problem — Stairs on Maple');
  });

  test('the host\'s subtask parser is used when the ctx carries one', () => {
    const ctx = Object.assign(ctxOf(readFixture()), { parseSubtaskTitle: () => ({ head: 'PARSED', sides: [] }) });
    expect(prefillFor('building_note', 'ev_n1', ctx).title).toBe('Extra work — PARSED');
  });

  test('an id that is not on the read falls back to the ticket wording', () => {
    expect(prefillFor('flag', 'nope', ctxOf(readFixture()))).toMatchObject({ title: 'Extra work — Stairs on Maple', description: '', photoIds: [] });
  });

  test('titles are cut to 200 characters and at most 24 photos are ticked', () => {
    const r = readFixture({ ticket: { id: 'st_1', title: 'x'.repeat(400), job_id: 'j1' } });
    r.tasks[0].photos = photos('many_', 30);
    expect(Array.from(prefillFor('ticket', null, ctxOf(r)).title)).toHaveLength(200);
    expect(prefillFor('building_note', 'ev_n1', ctxOf(r)).photoIds).toHaveLength(24);
  });
});

describe('the buttons, chips and list', () => {
  const t = pure();
  const linked = [
    { id: 'co_4', co_number: 'CO-4', status: 'draft', title: 'Rot', source_kind: 'building_note', source_id: 'ev_n1' },
    { id: 'co_2', co_number: 'CO-2', status: 'approved', title: 'Stringer <b>', source_kind: 'revision', source_id: 'rev1' },
    { id: 'co_5', co_number: 'CO-5', status: 'applied', title: 'Again', source_kind: 'revision', source_id: 'rev1' },
  ];

  test('sourceButtonHTML: Start change order until one exists for that source, then CO-N started', () => {
    expect(t.sourceButtonHTML('building_note', 'ev_x', linked))
      .toBe('<button type="button" class="p86-st-co-src" data-co-src="building_note" data-co-src-id="ev_x">Start change order</button>');
    expect(t.sourceButtonHTML('building_note', 'ev_n1', linked))
      .toBe('<button type="button" class="p86-st-co-src is-linked" data-co-open="co_4">CO-4 started</button>');
    // Two from the same suggestion: the newest names the button.
    expect(t.sourceButtonHTML('revision', 'rev1', linked)).toContain('data-co-open="co_5">CO-5 started');
    // The same id under another kind is not linked.
    expect(t.sourceButtonHTML('flag', 'ev_n1', linked)).toContain('Start change order');
  });

  test('sourceButtonHTML: nothing to start without the right, and a plain label when the CO cannot be opened', () => {
    expect(t.sourceButtonHTML('flag', 'fl1', [], { canStart: false })).toBe('');
    expect(t.sourceButtonHTML('building_note', 'ev_n1', linked, { canStart: false, canOpen: false }))
      .toBe('<span class="p86-st-co-src is-linked">CO-4 started</span>');
    expect(t.sourceButtonHTML('flag', 'f"><img>', [])).toContain('data-co-src-id="f&quot;&gt;&lt;img&gt;"');
  });

  test('chipHTML: CO draft over CO pending over CO approved over nothing', () => {
    expect(t.chipHTML(linked)).toContain('>CO draft</span>');
    expect(t.chipHTML(linked).indexOf('<span class="p86-st-co-chip is-draft"')).toBe(0);
    expect(t.chipHTML(linked.slice(1))).toContain('>CO approved</span>');
    // The two arms were exhaustive over draft|approved|applied. Move the work
    // order's only change order to pending and BOTH some() calls went false:
    // the chip vanished and the ticket read as though none was ever started.
    expect(t.chipHTML([{ id: 'c9', status: 'pending' }])).toContain('>CO pending</span>');
    expect(t.chipHTML([{ id: 'c9', status: 'pending' }])).toContain('is-pending');
    // Draft still outranks it, and approved does not hide it.
    expect(t.chipHTML([{ id: 'c8', status: 'draft' }, { id: 'c9', status: 'pending' }])).toContain('>CO draft</span>');
    expect(t.chipHTML([{ id: 'c9', status: 'pending' }, { id: 'ca', status: 'approved' }])).toContain('>CO pending</span>');
    expect(t.chipHTML([])).toBe('');
    expect(t.rowChipHTML({ co_draft_count: 2 })).toContain('>CO draft</span>');
    expect(t.rowChipHTML({ co_draft_count: 0 })).toBe('');
    expect(t.rowChipHTML({})).toBe('');
  });

  test('listHTML: each CO with its number, title, state and Open, marked office only', () => {
    const html = t.listHTML(linked);
    expect(html).toContain('Change orders <span class="p86-st-co-note">Office only — not on the crew link</span>');
    expect(html.match(/class="p86-st-co-row"/g)).toHaveLength(3);
    expect(html).toContain('Stringer &lt;b&gt;');
    expect(html).toContain('>Draft</span>');
    expect(html).toContain('>Approved</span>');
    expect(html).toContain('>Applied</span>');
    // "Pending approval", never a bare "Pending" — and the pill has a class to
    // colour, which it did not when stateLabel fell to its generic capitaliser.
    const pend = t.listHTML([{ id: 'c9', co_number: 'CO-9', title: 'Extra', status: 'pending' }]);
    expect(pend).toContain('>Pending approval</span>');
    expect(pend).toContain('p86-st-co-state is-pending');
    expect(html.match(/data-co-open="/g)).toHaveLength(3);
    expect(t.listHTML(linked, { canOpen: false })).not.toContain('data-co-open');
    expect(t.listHTML([])).toBe('');
  });

  test('timeline wording for change_order_started', () => {
    const head = () => 'Bldg 784';
    expect(t.eventWhat({ kind: 'change_order_started', detail: { co_number: 'CO-4', source_kind: 'ticket' } }, { head }))
      .toBe('started change order CO-4');
    expect(t.eventWhat({ kind: 'change_order_started', detail: '{"co_number":"CO-4","source_kind":"revision"}' }, { head }))
      .toBe('started change order CO-4 from a suggestion');
    expect(t.eventWhat({ kind: 'change_order_started', detail: { co_number: 'CO-4', source_kind: 'building_note', task_id: 'k1' } }, { head }))
      .toBe('started change order CO-4 from a note on Bldg 784');
    expect(t.eventWhat({ kind: 'change_order_started', detail: { co_number: 'CO-<4>', source_kind: 'flag', task_id: 'k1' } }, { head }))
      .toBe('started change order CO-&lt;4&gt; from a flag on Bldg 784');
    expect(t.eventWhat({ kind: 'flag_raised', detail: {} }, { head })).toBeNull();
  });

  test('MUTANT: without the linked lookup a started source still offers a second start', () => {
    const mut = pure([['    var linked = linkedFor(rows, kind, id);\n', '    var linked = null;\n']]);
    expect(mut.sourceButtonHTML('building_note', 'ev_n1', linked)).toContain('Start change order');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * IN A PAGE
 * ══════════════════════════════════════════════════════════════════════════*/
const flush = () => new Promise((r) => setTimeout(r, 0));
const windows = [];
afterEach(() => {
  while (windows.length) {
    try { windows.pop().close(); } catch (_) { /* closed */ }
  }
});

function boot(opts) {
  const o = opts || {};
  const dom = new JSDOM('<!doctype html><html><body><div class="p86-st-detail"></div></body></html>', {
    runScripts: 'outside-only', url: 'https://project86.test/jobs/j1/job-service-tickets',
  });
  const win = dom.window;
  windows.push(win);
  const caps = o.caps || ['ESTIMATES_EDIT'];
  const env = { win, doc: win.document, calls: [], toasts: [], refreshes: [], opened: [], hostRefreshes: 0 };
  win.p86Auth = { hasCapability: (k) => caps.indexOf(k) >= 0 };
  win.p86Toast = (msg, kind) => env.toasts.push([msg, kind]);
  win.p86Refresh = (type, opts2) => env.refreshes.push([type, opts2]);
  win.p86ChangeOrders = { open: (id, opts2) => env.opened.push([id, opts2]), defaultTerms: 'Standard terms.' };
  win.p86ServiceTickets = { refresh: () => { env.hostRefreshes++; } };
  win.appData = { jobs: o.jobs || [{ id: 'j1' }] };
  const answers = (o.answers || []).slice();
  win.p86Api = {
    serviceTickets: {
      startChangeOrder: (id, payload) => {
        env.calls.push([id, JSON.parse(JSON.stringify(payload))]);
        const next = answers.length ? answers.shift() : { ok: true, change_order: { id: 'co_new', job_id: 'j1', co_number: 'CO-4', status: 'draft' } };
        return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
      },
    },
  };
  win.eval(EXT_SRC);
  if (o.flagsFirst !== false) win.eval(FLAGS_SRC);
  win.eval(o.src || CO_SRC);
  if (o.flagsFirst === false) win.eval(FLAGS_SRC);
  return env;
}

function refusal(status, message, data) {
  return Object.assign(new Error(message), { status, data: Object.assign({ error: message }, data || {}) });
}

// Paints the detail the way the host does for the slots this module uses, and
// wires it once.
function mount(env, r, extra) {
  const X = env.win.p86StExt;
  const ctx = Object.assign({ ticketId: r.ticket.id, t: r.ticket, r, canEdit: true, refresh: jest.fn(() => Promise.resolve()) }, extra || {});
  const secs = [].concat.apply([], X.collect('detailSections', ctx));
  const bySlot = (slot) => secs.filter((s) => s.slot === slot).map((s) => s.html).join('');
  const d = env.doc.querySelector('.p86-st-detail');
  d.innerHTML =
    '<span class="p86-st-statusctl">In progress</span>' + bySlot('statusMeta') +
    bySlot('afterSite') +
    '<div class="p86-st-revs">' + r.revisions.map((rev) => '<div class="p86-st-rev">' + X.html('revisionActions', rev, ctx) + '</div>').join('') + '</div>' +
    bySlot('afterRevisions') +
    r.tasks.map((task) => '<div class="p86-wo-sub" data-task="' + task.id + '">' +
      task.notes.map((n) => '<div class="p86-wo-note">' + n.note + X.html('noteActions', n, task, ctx) + '</div>').join('') + '</div>').join('') +
    '<div class="p86-st-actions">' + bySlot('actions') + '</div>';
  d._st = ctx;
  const flagsSec = secs.find((s) => s.key === 'flags');
  if (flagsSec && flagsSec.html && flagsSec.wire) flagsSec.wire(d.querySelector('.p86-st-flags'), ctx);
  X.collect('wireDetail', d, ctx);
  return { d, ctx, secs };
}

function click(env, el) {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new env.win.MouseEvent('click', { bubbles: true, cancelable: true }));
}

const modal = (env) => env.doc.querySelector('.p86-st-co-modal');

describe('registration', () => {
  test('ticket-co, order 50, and every hook the screen asks for', () => {
    const env = boot();
    const X = env.win.p86StExt;
    const entry = X.list().find((e) => e.name === 'ticket-co');
    expect(entry && entry.order).toBe(50);
    expect(X.html('rowBadges', { co_draft_count: 1 }, {})).toContain('>CO draft</span>');

    const r = readFixture({ change_orders: [{ id: 'co_4', co_number: 'CO-4', status: 'draft', title: 'Rot', source_kind: 'building_note', source_id: 'ev_n1' }] });
    const { secs } = mount(env, r);
    const mine = secs.filter((s) => /^co-/.test(s.key)).map((s) => [s.key, s.slot]);
    expect(mine).toEqual([['co-chip', 'statusMeta'], ['co-list', 'afterRevisions'], ['co-start', 'actions']]);
    const chip = secs.find((s) => s.key === 'co-chip').html;
    expect(chip.indexOf('<span ')).toBe(0);
    expect(secs.find((s) => s.key === 'co-start').html).toContain('data-co-src="ticket">Start change order</button>');
    expect(X.collect('eventWhat', { kind: 'change_order_started', detail: { co_number: 'CO-4', source_kind: 'ticket' } }, {}))
      .toContain('started change order CO-4');
  });

  test('the actions button only for someone who may start one: ESTIMATES_EDIT, on a job, not cancelled or archived, job editable', () => {
    const startHtml = (env, r) => [].concat.apply([], env.win.p86StExt.collect('detailSections', ctxOf(r))).find((s) => s.key === 'co-start').html;
    expect(startHtml(boot(), readFixture())).not.toBe('');
    expect(startHtml(boot({ caps: ['ESTIMATES_VIEW'] }), readFixture())).toBe('');
    expect(startHtml(boot(), readFixture({ ticket: { id: 'st_l', title: 'Lead', status: 'open', job_id: null, lead_id: 'l1' } }))).toBe('');
    expect(startHtml(boot(), readFixture({ ticket: { id: 'st_c', title: 'C', status: 'cancelled', job_id: 'j1' } }))).toBe('');
    expect(startHtml(boot(), readFixture({ ticket: { id: 'st_a', title: 'A', status: 'open', job_id: 'j1', archived_at: '2026-09-01' } }))).toBe('');
    expect(startHtml(boot({ jobs: [{ id: 'j1', _canEdit: false }] }), readFixture())).toBe('');
    // Closed tickets are allowed: extra work often surfaces at close.
    expect(startHtml(boot(), readFixture({ ticket: { id: 'st_x', title: 'X', status: 'closed', job_id: 'j1' } }))).not.toBe('');
  });

  test('suggestions and building notes get the button; a started one says CO-4 started', () => {
    const env = boot();
    const r = readFixture({ change_orders: [{ id: 'co_4', co_number: 'CO-4', status: 'draft', source_kind: 'building_note', source_id: 'ev_n1' }] });
    const { d } = mount(env, r);
    expect(d.querySelector('[data-co-src="revision"][data-co-src-id="rev1"]')).not.toBeNull();
    expect(d.querySelector('[data-co-src="revision"][data-co-src-id="rev2"]')).not.toBeNull();
    expect(d.querySelector('.p86-wo-note [data-co-open="co_4"]').textContent).toBe('CO-4 started');
    expect(d.querySelector('.p86-st-cos [data-co-open="co_4"]').textContent).toBe('Open');
  });

  test('a flagged problem card carries the button, from the card action registered on p86TicketFlags', () => {
    const env = boot();
    const r = readFixture();
    const { d } = mount(env, r);
    const card = d.querySelector('.p86-st-flag[data-flag="fl1"]');
    expect(card).not.toBeNull();
    const btn = card.querySelector('[data-co-src="flag"][data-co-src-id="fl1"]');
    expect(btn && btn.textContent).toBe('Start change order');
    click(env, btn);
    expect(modal(env).querySelector('.p86-st-co-title-in').value).toBe('Extra damage — Bldg 784');
    expect(Array.from(modal(env).querySelectorAll('.p86-st-co-pick:checked')).map((x) => x.value)).toEqual(['pf1']);
    expect(modal(env).querySelector('.p86-st-co-group-head').textContent).toBe('Photos on this problem');
  });

  test('loaded before the flags module, the card action still arrives once the page has parsed', async () => {
    const env = boot({ flagsFirst: false });
    await new Promise((resolve) => {
      if (env.doc.readyState !== 'loading') return resolve();
      env.doc.addEventListener('DOMContentLoaded', resolve);
    });
    const html = env.win.p86TicketFlags.panelHTML(readFixture().flags, readFixture().ticket, { canResolve: true, ctx: ctxOf(readFixture()) });
    expect(html).toContain('data-co-src="flag" data-co-src-id="fl1"');
  });

  test('MUTANT: canStart without the capability shows the button to someone who cannot edit change orders', () => {
    const env = boot({ caps: [], src: fs.readFileSync(writeMutant([[
      "      jobEditable(t.job_id) && hasCap('ESTIMATES_EDIT'));", '      jobEditable(t.job_id));']]), 'utf8') });
    const secs = [].concat.apply([], env.win.p86StExt.collect('detailSections', ctxOf(readFixture())));
    expect(secs.find((s) => s.key === 'co-start').html).toContain('Start change order');
  });
});

describe('the Start a change order dialog', () => {
  test('from the ticket: the sub-note, the prefill, and a blank description refused inline with nothing sent', async () => {
    const env = boot();
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-st-co-start'));
    const m = modal(env);
    expect(m.querySelector('.p86-st-modal-head').textContent).toBe('Start a change order');
    expect(m.querySelector('.p86-st-co-sub').textContent)
      .toBe('Creates a draft change order on J-784 · Maple Court. You price it in the change order. Nothing is added to the crew link.');
    expect(m.querySelector('.p86-st-co-title-in').value).toBe('Extra work — Stairs on Maple');
    expect(m.querySelector('.p86-st-co-desc').getAttribute('placeholder')).toBe('What did the crew find, and where?');
    expect([m.querySelector('.p86-st-co-qty').value, m.querySelector('.p86-st-co-unit').value]).toEqual(['1', 'ea']);
    expect(m.querySelector('.p86-st-co-help').textContent).toBe('Tick the photos that show the extra work. Up to 24.');
    expect(Array.from(m.querySelectorAll('.p86-st-co-group-head')).map((h) => h.textContent)).toEqual(['Bldg 784', 'Bldg 790', 'Site photos']);
    expect(m.querySelectorAll('.p86-st-co-pick:checked')).toHaveLength(0);
    expect(m.querySelector('.p86-st-co-go').textContent).toBe('Create draft change order');

    click(env, m.querySelector('.p86-st-co-go'));
    await flush();
    const err = m.querySelector('.p86-st-co-err');
    expect([err.hidden, err.textContent]).toEqual([false, 'Describe the extra work.']);
    expect(env.calls).toEqual([]);

    m.querySelector('.p86-st-co-title-in').value = '   ';
    m.querySelector('.p86-st-co-desc').value = 'More rot';
    click(env, m.querySelector('.p86-st-co-go'));
    expect(err.textContent).toBe('Give the change order a title.');
    m.querySelector('.p86-st-co-title-in').value = 'Extra';
    m.querySelector('.p86-st-co-qty').value = '0';
    click(env, m.querySelector('.p86-st-co-go'));
    expect(err.textContent).toBe('Quantity must be a number above zero.');
    expect(env.calls).toEqual([]);
  });

  test('a start sends the source, the fields, the ticked photos and the default terms; then toast, re-read, p86Refresh(\'co\') and the editor opens', async () => {
    const env = boot();
    const { d, ctx } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    const m = modal(env);
    expect(Array.from(m.querySelectorAll('.p86-st-co-pick:checked')).map((x) => x.value)).toEqual(['p784_1', 'p784_2']);
    const site = m.querySelector('.p86-st-co-pick[value="ps1"]');
    site.checked = true;
    site.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    m.querySelector('.p86-st-co-qty').value = '2.5';
    m.querySelector('.p86-st-co-unit').value = 'lf';
    click(env, m.querySelector('.p86-st-co-go'));
    await flush(); await flush();

    expect(env.calls).toEqual([['st_1', {
      source: { kind: 'building_note', id: 'ev_n1' },
      title: 'Extra work — Bldg 784',
      description: 'Rot behind the siding, about 6 feet',
      qty: 2.5,
      unit: 'lf',
      photo_ids: ['p784_1', 'p784_2', 'ps1'],
      terms: 'Standard terms.',
    }]]);
    expect(env.toasts).toEqual([['Draft change order CO-4 created', 'success']]);
    expect(modal(env)).toBeNull();
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
    expect(env.refreshes).toEqual([['co', { id: 'co_new', jobId: 'j1' }]]);
    expect(env.opened.map((o) => o[0])).toEqual(['co_new']);
    // Closing the editor re-reads the ticket through the host (which honours
    // unsaved edits).
    env.opened[0][1].onClose();
    expect(env.hostRefreshes).toBe(1);
  });

  test('a suggestion prefill reaches the server with its id', async () => {
    const env = boot();
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('[data-co-src="revision"][data-co-src-id="rev1"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush();
    expect(env.calls[0][1]).toMatchObject({
      source: { kind: 'revision', id: 'rev1' },
      description: 'Found a cracked stringer\n\nReplace the stringer on 790',
      photo_ids: [],
    });
  });

  test('a duplicate asks: Start another resends with allow_duplicate, Open CO-4 opens the existing one', async () => {
    const dupe = refusal(409, 'A change order was already started from this — CO-4.', { existing: { id: 'co_4', co_number: 'CO-4', status: 'draft' } });
    const env = boot({ answers: [dupe] });
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush(); await flush();
    const box = modal(env).querySelector('.p86-st-co-dupe');
    expect(box.hidden).toBe(false);
    expect(box.querySelector('.p86-st-co-dupe-msg').textContent).toBe('A change order was already started from this: CO-4 (Draft).');
    expect(box.querySelector('.p86-st-co-dupe-open').textContent).toBe('Open CO-4');
    expect(env.calls[0][1].allow_duplicate).toBeUndefined();

    click(env, box.querySelector('.p86-st-co-again'));
    await flush(); await flush();
    expect(env.calls).toHaveLength(2);
    expect(env.calls[1][1].allow_duplicate).toBe(true);
    expect(env.opened.map((o) => o[0])).toEqual(['co_new']);
  });

  test('Open CO-4 on the duplicate question closes the dialog and opens the change order', async () => {
    const dupe = refusal(409, 'A change order was already started from this — CO-4.', { existing: { id: 'co_4', co_number: 'CO-4', status: 'draft' } });
    const env = boot({ answers: [dupe] });
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush(); await flush();
    click(env, modal(env).querySelector('.p86-st-co-dupe-open'));
    expect(modal(env)).toBeNull();
    expect(env.opened.map((o) => o[0])).toEqual(['co_4']);
    expect(env.calls).toHaveLength(1);
  });

  test('any other refusal is shown inline, word for word, and the dialog stays', async () => {
    const env = boot({ answers: [refusal(404, 'One of those photos is not on this work order.')] });
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush(); await flush();
    const err = modal(env).querySelector('.p86-st-co-err');
    expect([err.hidden, err.getAttribute('role'), err.textContent]).toEqual([false, 'alert', 'One of those photos is not on this work order.']);
    expect(modal(env).querySelector('.p86-st-co-go').disabled).toBe(false);
    expect(env.refreshes).toEqual([]);
  });

  test('the 25th photo is refused with the cap sentence', () => {
    const env = boot();
    const r = readFixture();
    r.tasks[1].photos = photos('bulk_', 30);
    const { d } = mount(env, r);
    click(env, d.querySelector('.p86-st-co-start'));
    const boxes = Array.from(modal(env).querySelectorAll('.p86-st-co-pick'));
    boxes.slice(0, 25).forEach((b) => {
      b.checked = true;
      b.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    });
    expect(modal(env).querySelectorAll('.p86-st-co-pick:checked')).toHaveLength(24);
    expect(modal(env).querySelector('.p86-st-co-err').textContent).toBe('Pick up to 24 photos.');
  });

  test('Open on the Change orders list opens the editor; Escape closes the dialog', () => {
    const env = boot();
    const r = readFixture({ change_orders: [{ id: 'co_2', co_number: 'CO-2', status: 'approved', title: 'Earlier', source_kind: 'ticket', source_id: null }] });
    const { d } = mount(env, r);
    click(env, d.querySelector('.p86-st-cos [data-co-open="co_2"]'));
    expect(env.opened.map((o) => o[0])).toEqual(['co_2']);
    click(env, d.querySelector('.p86-st-co-start'));
    expect(modal(env)).not.toBeNull();
    env.doc.dispatchEvent(new env.win.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(modal(env)).toBeNull();
  });

  test('one listener per detail element: wiring twice opens one dialog per click', () => {
    const env = boot();
    const { d, ctx } = mount(env, readFixture());
    env.win.p86ServiceTicketCo.wire(d, ctx);
    env.win.p86StExt.collect('wireDetail', d, ctx);
    const appended = jest.spyOn(env.doc.body, 'appendChild');
    click(env, d.querySelector('.p86-st-co-start'));
    expect(appended).toHaveBeenCalledTimes(1);
    expect(env.doc.querySelectorAll('.p86-st-co-back')).toHaveLength(1);
  });

  test('MUTANT: the wrong refresh type (change_order) is not a registered type, so the job\'s change orders stay stale', async () => {
    const env = boot({ src: fs.readFileSync(writeMutant([["W.p86Refresh('co', {", "W.p86Refresh('change_order', {"]]), 'utf8') });
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush(); await flush();
    expect(env.refreshes.map((x) => x[0])).toEqual(['change_order']);
  });

  test('MUTANT: Start another without allow_duplicate asks the same question forever', async () => {
    const dupe = () => refusal(409, 'A change order was already started from this — CO-4.', { existing: { id: 'co_4', co_number: 'CO-4', status: 'draft' } });
    const env = boot({
      answers: [dupe(), dupe()],
      src: fs.readFileSync(writeMutant([['    if (allowDuplicate) payload.allow_duplicate = true;\n', '']]), 'utf8'),
    });
    const { d } = mount(env, readFixture());
    click(env, d.querySelector('.p86-wo-note [data-co-src="building_note"]'));
    click(env, modal(env).querySelector('.p86-st-co-go'));
    await flush(); await flush();
    click(env, modal(env).querySelector('.p86-st-co-again'));
    await flush(); await flush();
    expect(env.calls[1][1].allow_duplicate).toBeUndefined();
    expect(modal(env).querySelector('.p86-st-co-dupe').hidden).toBe(false);
  });

  test('MUTANT: no photo cap and a 25th photo is ticked', () => {
    const env = boot({ src: fs.readFileSync(writeMutant([['      if (box.checked && picked(o).length > PHOTO_MAX) {', '      if (false) {']]), 'utf8') });
    const r = readFixture();
    r.tasks[1].photos = photos('bulk_', 30);
    const { d } = mount(env, r);
    click(env, d.querySelector('.p86-st-co-start'));
    Array.from(modal(env).querySelectorAll('.p86-st-co-pick')).slice(0, 25).forEach((b) => {
      b.checked = true;
      b.dispatchEvent(new env.win.Event('change', { bubbles: true }));
    });
    expect(modal(env).querySelectorAll('.p86-st-co-pick:checked')).toHaveLength(25);
  });
});

describe('house rules for this file', () => {
  test('never writes appData, no date helpers, no native dialogs, CRLF', () => {
    const code = CO_SRC.replace(/\/\/.*$/gm, '');
    expect(code).not.toMatch(/appData\.[A-Za-z]+\s*=[^=]|appData\.[A-Za-z]+\.(push|splice)\(/);
    expect(code).not.toMatch(/p86JobsHubRefresh/);
    expect(CO_SRC).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
    expect(code).not.toMatch(/(^|[^.\w])(alert|confirm|prompt)\s*\(/);
    expect(CO_SRC.indexOf('\r\n')).toBeGreaterThan(-1);
  });
});
