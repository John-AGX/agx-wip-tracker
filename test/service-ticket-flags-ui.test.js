/**
 * @jest-environment jsdom
 */
// FLAG A PROBLEM (1.29) — THE OFFICE SIDE, EXECUTED.
//
// js/service-ticket-flags.js (window.p86TicketFlags) is everything the office
// sees of a problem a crew flagged:
//
//   * the ticket list badges — "1 problem" / "2 problems" on any ticket with an
//     open flag (closed ones too: they still need clearing), and "N suggestions
//     waiting" / "New from crew" only while the ticket is not closed or
//     cancelled;
//   * the "Problems from the crew" panel — open cards first, the typed name
//     marked unverified, resolved cards behind "Show N resolved", and the
//     Resolve note only for someone who can edit;
//   * Resolve — an empty note never reaches the server and says why; a note is
//     sent as resolveFlag(ticketId, flagId, note), then the ticket refreshes;
//     a refusal is shown in the server's own words;
//   * the job's Service Tickets chip — red while any problem is open, amber for
//     suggestions or new crew activity only, empty when nothing needs the
//     office, and never painted onto a job that is not the one on screen;
//   * the registration with window.p86StExt ('ticket-flags', order 30) that
//     js/service-tickets.js calls, and the one guarded line in
//     js/workspace-layout.js that asks for the chip.
//
// The shipped file is evaluated as the browser script it is, in jsdom. Each
// guard is then removed from a copy (CRLF normalised, anchor exactly once) and
// the same check goes red.
'use strict';

const fs = require('fs');
const path = require('path');

const FLAGS_PATH = path.join(__dirname, '..', 'js', 'service-ticket-flags.js');
const SRC = fs.readFileSync(FLAGS_PATH, 'utf8');
const LAYOUT_PATH = path.join(__dirname, '..', 'js', 'workspace-layout.js');
const { createRegistry } = require('../js/service-ticket-ext.js');

const RESOLVE_FIRST = 'Say how it was handled first — the crew sees this note.';
const PLACEHOLDER = 'How was it handled? Shown on the crew link — no prices.';

let toasts;
let resolveCalls;
let listCalls;
let lightbox;

function httpError(status, message) {
  const e = new Error(message);
  e.status = status;
  e.data = { error: message };
  return e;
}

// Evaluates a copy of the module into a fresh window state. opts.resolve is
// what resolveFlag answers (a value resolves, an Error rejects); opts.list
// what list answers.
function boot(src, opts) {
  const o = opts || {};
  toasts = [];
  resolveCalls = [];
  listCalls = [];
  lightbox = [];
  document.body.innerHTML = '';
  window.p86Toast = (msg, kind) => toasts.push([msg, kind]);
  window.p86Api = {
    serviceTickets: {
      resolveFlag: jest.fn((id, flagId, note) => {
        resolveCalls.push([id, flagId, note]);
        return o.resolve instanceof Error ? Promise.reject(o.resolve) : Promise.resolve(o.resolve || { ok: true });
      }),
      list: jest.fn((params) => {
        listCalls.push(params);
        return o.list instanceof Error ? Promise.reject(o.list) : Promise.resolve(o.list || { tickets: [] });
      }),
    },
  };
  window.p86Attachments = { openLightbox: (photos, idx, lopts) => lightbox.push({ photos, idx, lopts }) };
  window.appState = { currentJobId: 'j1' };
  window.p86StExt = o.noRegistry ? undefined : createRegistry();
  delete window.p86TicketFlags;
  // eslint-disable-next-line no-new-func
  new Function(String(src).replace(/\r\n/g, '\n'))();
  return window.p86TicketFlags;
}

function mutantSrc(anchor, replacement) {
  const src = SRC.replace(/\r\n/g, '\n');
  const hits = src.split(anchor).length - 1;
  if (hits !== 1) throw new Error('anchor not found' + (hits > 1 ? ' (ambiguous: ' + hits + ')' : '') + ': ' + JSON.stringify(anchor.slice(0, 100)));
  return src.split(anchor).join(replacement);
}

const settle = () => new Promise((r) => setTimeout(r, 0));

function mount(html) {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.appendChild(host);
  return host;
}

const T = { id: 'st_1', status: 'in_progress', title: 'Latitude 28 rails' };

function flag(over) {
  return Object.assign({
    id: 'f1', task_id: null, task_title: null, category: 'no_access', note: 'Gate locked',
    author_label: 'Marco', via_revoked_link: false, status: 'open',
    created_at: '2026-09-14T13:05:00.000Z', resolved_at: null, resolved_by_name: null, resolution_note: null,
    photos: [],
  }, over || {});
}

const FLAGS = [
  flag({ id: 'f_res', status: 'resolved', category: 'other', note: 'Old issue', resolved_at: '2026-09-14T15:00:00.000Z', resolved_by_name: 'Wendy Wide', resolution_note: 'Handled on site', created_at: '2026-09-13T10:00:00.000Z' }),
  flag({ id: 'f_safe', task_id: 'k1', task_title: 'Bldg 784 — Side A: rail', category: 'safety', note: 'Loose rail on stair 2', created_at: '2026-09-14T12:00:00.000Z', photos: [{ id: 'p1', thumb_url: 'https://cdn.test/p1_t', web_url: 'https://cdn.test/p1_w' }, { id: 'p2', thumb_url: 'https://cdn.test/p2_t', web_url: 'https://cdn.test/p2_w' }] }),
  flag({ id: 'f_gate', category: 'no_access', note: 'Gate locked', via_revoked_link: true, author_label: null }),
];

// ── rowBadgesHTML ─────────────────────────────────────────────────────────
function checkBadges(F) {
  const text = (row) => {
    const host = mount(F.rowBadgesHTML(row));
    return Array.from(host.querySelectorAll('.p86-st-badge')).map((b) => b.className.replace('p86-st-badge ', '') + ':' + b.textContent);
  };
  expect(text({ status: 'open', open_flags: 1 })).toEqual(['is-flag:1 problem']);
  expect(text({ status: 'open', open_flags: 2, pending_suggestions: 1, new_from_crew: true }))
    .toEqual(['is-flag:2 problems', 'is-sugg:1 suggestion waiting', 'is-new:New from crew']);
  expect(text({ status: 'in_progress', pending_suggestions: 3 })).toEqual(['is-sugg:3 suggestions waiting']);
  expect(text({ status: 'in_progress', open_flags: 0, pending_suggestions: 0, new_from_crew: false })).toEqual([]);
  for (const status of ['closed', 'cancelled']) {
    expect([status, text({ status, open_flags: 2, pending_suggestions: 4, new_from_crew: true })]).toEqual([status, ['is-flag:2 problems']]);
  }
  // Approved and Work complete are not closed: the office still acts on them.
  expect(text({ status: 'approved', pending_suggestions: 1, new_from_crew: true })).toEqual(['is-sugg:1 suggestion waiting', 'is-new:New from crew']);
  const host = mount(F.rowBadgesHTML({ status: 'open', open_flags: 1, pending_suggestions: 1, new_from_crew: true }));
  expect(host.querySelector('.is-flag').getAttribute('title')).toBe('Open problems flagged by the crew');
  expect(host.querySelector('.is-sugg').getAttribute('title')).toBe('Suggestions from a crew link waiting for you');
  expect(host.querySelector('.is-new').getAttribute('title')).toBe('The crew added something since this ticket was last opened');
}

describe('rowBadgesHTML: the list badges', () => {
  test('wording, plurals, and suggestion/new badges hidden on closed and cancelled while problems stay', () => {
    checkBadges(boot(SRC));
  });

  test('MUTANT: the closed/cancelled check removed -> a closed ticket nags about suggestions', () => {
    const F = boot(mutantSrc('    if (!isTerminal(row)) {\n      var waiting', '    if (true) {\n      var waiting'));
    expect(() => checkBadges(F)).toThrow();
  });
});

// ── panelHTML ─────────────────────────────────────────────────────────────
const headOf = (id) => (id === 'k1' ? 'Bldg 784' : '');

describe('panelHTML: Problems from the crew', () => {
  test('nothing at all when there are no flags', () => {
    const F = boot(SRC);
    expect(F.panelHTML([], T, { canResolve: true })).toBe('');
    expect(F.panelHTML(null, T, { canResolve: true })).toBe('');
  });

  test('open cards first, the name marked unverified, resolved behind "Show 1 resolved"', () => {
    const F = boot(SRC);
    const html = F.panelHTML(FLAGS, T, { canResolve: true, headOf });
    const host = mount(html);
    expect(host.children).toHaveLength(1);                         // one root element
    const panel = host.querySelector('.p86-st-flags');
    expect(panel.querySelector('.p86-st-lbl').textContent).toBe('Problems from the crew 2 open');
    const topLevel = Array.from(panel.children).filter((c) => c.classList.contains('p86-st-flag')).map((c) => c.getAttribute('data-flag'));
    expect(topLevel).toEqual(['f_safe', 'f_gate']);

    const safe = panel.querySelector('[data-flag="f_safe"]');
    expect(safe.classList.contains('cat-safety')).toBe(true);
    expect(safe.querySelector('.p86-st-flag-cat').textContent).toBe('Safety');
    expect(safe.querySelector('.p86-st-flag-where').textContent).toBe('Bldg 784');
    expect(safe.querySelector('.p86-st-flag-who').textContent).toBe('Marcounverified');
    expect(safe.querySelector('.p86-st-rev-claim').getAttribute('title')).toBe('Typed by the guest. Nobody signed in to prove it.');
    expect(safe.querySelector('.p86-st-flag-note').textContent).toBe('Loose rail on stair 2');
    expect(safe.querySelectorAll('.p86-st-flag-thumb img')).toHaveLength(2);
    expect(safe.querySelector('.p86-st-flag-acts')).not.toBeNull();

    const gate = panel.querySelector('[data-flag="f_gate"]');
    expect(gate.querySelector('.p86-st-flag-where').textContent).toBe('Whole work order');
    expect(gate.querySelector('.p86-st-flag-who').textContent).toBe('Someone on the linkunverified');
    expect(gate.querySelector('.p86-st-rev-revoked').textContent).toBe('link revoked');

    const input = safe.querySelector('input.p86-st-flag-note-in');
    expect(input.getAttribute('placeholder')).toBe(PLACEHOLDER);
    expect(input.getAttribute('maxlength')).toBe('1000');
    expect(safe.querySelector('.p86-st-flag-resolve-go').textContent).toBe('Resolve');

    const more = panel.querySelector('.p86-st-flags-more');
    expect(more.textContent).toBe('Show 1 resolved');
    const box = panel.querySelector('.p86-st-flags-resolved');
    expect(box.hidden).toBe(true);
    const res = box.querySelector('[data-flag="f_res"]');
    expect(res.querySelector('.p86-st-flag-res').textContent).toMatch(/^Resolved by Wendy Wide · .+ — Handled on site$/);
    expect(res.querySelector('.p86-st-flag-note-in')).toBeNull();
  });

  test('no Resolve note or button for someone who cannot edit; the cards still show', () => {
    const F = boot(SRC);
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: false, headOf }));
    expect(host.querySelectorAll('.p86-st-flag')).toHaveLength(3);
    expect(host.querySelector('.p86-st-flag-note-in')).toBeNull();
    expect(host.querySelector('.p86-st-flag-resolve-go')).toBeNull();
  });

  test('MUTANT: Resolve offered regardless of canResolve -> the view-only office sees it', () => {
    const F = boot(mutantSrc('    if (open && opts.canResolve) {\n', '    if (open) {\n'));
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: false, headOf }));
    expect(host.querySelector('.p86-st-flag-note-in')).not.toBeNull();
  });

  test('everything the crew typed is escaped', () => {
    const F = boot(SRC);
    const evil = flag({ id: 'f_x"><b>', note: '<img src=x onerror=alert(1)>', author_label: '<script>alert(2)</script>', category: 'extra_damage"><i>' });
    const html = F.panelHTML([evil], T, { canResolve: true });
    expect(html).not.toMatch(/<img src=x/);
    expect(html).not.toMatch(/<script>/);
    expect(html).not.toMatch(/<b>|<i>/);
    const host = mount(html);
    expect(host.querySelector('.p86-st-flag-note').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(host.querySelector('.p86-st-flag-cat').textContent).toBe('Other');
  });

  test('MUTANT: the note not escaped -> markup from the crew link runs in the office', () => {
    const F = boot(mutantSrc("      '<div class=\"p86-st-flag-note\">' + esc(f.note) + '</div>';", "      '<div class=\"p86-st-flag-note\">' + f.note + '</div>';"));
    const host = mount(F.panelHTML([flag({ note: '<b class="planted">x</b>' })], T, { canResolve: true }));
    expect(host.querySelector('.planted')).not.toBeNull();
  });

  test('"Show N resolved" opens and closes, and stays open across a repaint of the same ticket', () => {
    const F = boot(SRC);
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf }));
    F.wire(host, T, { canResolve: true, onChanged: () => {} });
    const more = host.querySelector('.p86-st-flags-more');
    more.click();
    expect(more.textContent).toBe('Hide resolved');
    expect(more.getAttribute('aria-expanded')).toBe('true');
    expect(host.querySelector('.p86-st-flags-resolved').hidden).toBe(false);
    const again = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf }));
    expect(again.querySelector('.p86-st-flags-more').textContent).toBe('Hide resolved');
    expect(again.querySelector('.p86-st-flags-resolved').hidden).toBe(false);
    more.click();
    expect(more.textContent).toBe('Show 1 resolved');
    expect(host.querySelector('.p86-st-flags-resolved').hidden).toBe(true);
  });

  test('a photo thumb opens the lightbox on that photo, labelled with the problem', () => {
    const F = boot(SRC);
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf }));
    F.wire(host, T, { canResolve: true });
    host.querySelectorAll('[data-flag="f_safe"] .p86-st-flag-thumb')[1].click();
    expect(lightbox).toHaveLength(1);
    expect(lightbox[0].idx).toBe(1);
    expect(lightbox[0].photos.map((p) => p.id)).toEqual(['p1', 'p2']);
    expect(lightbox[0].lopts).toEqual({ parentLabel: 'Problem · Safety' });
  });

  test('openFlagsByTask counts open flags per building only', () => {
    const F = boot(SRC);
    expect(F.openFlagsByTask(FLAGS.concat([flag({ id: 'f9', task_id: 'k1', status: 'open' }), flag({ id: 'f8', task_id: 'k2', status: 'resolved' })])))
      .toEqual({ k1: 2 });
    expect(F.openFlagsByTask(undefined)).toEqual({});
  });
});

// ── Resolve ───────────────────────────────────────────────────────────────
function panelFor(F, opts) {
  const host = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf }));
  const changed = [];
  F.wire(host, T, Object.assign({ canResolve: true, onChanged: () => { changed.push(true); return Promise.resolve(); } }, opts || {}));
  return { host, changed, card: host.querySelector('[data-flag="f_safe"]') };
}

async function checkEmptyNote(F) {
  const { card, changed } = panelFor(F);
  card.querySelector('.p86-st-flag-note-in').value = '   ';
  card.querySelector('.p86-st-flag-resolve-go').click();
  await settle();
  expect(resolveCalls).toEqual([]);
  expect(toasts).toEqual([[RESOLVE_FIRST, 'error']]);
  expect(document.activeElement).toBe(card.querySelector('.p86-st-flag-note-in'));
  expect(changed).toEqual([]);
}

describe('Resolve', () => {
  test('an empty note never reaches the server and says why', async () => {
    await checkEmptyNote(boot(SRC));
  });

  test('MUTANT: the empty-note guard removed -> an empty resolve is sent', async () => {
    const F = boot(mutantSrc('    if (!note) {\n', '    if (false) {\n'));
    await expect(checkEmptyNote(F)).rejects.toThrow();
  });

  test('a note is sent as resolveFlag(ticketId, flagId, note), then "Problem resolved" and the refresh', async () => {
    const F = boot(SRC);
    const { card, changed } = panelFor(F);
    const input = card.querySelector('.p86-st-flag-note-in');
    input.value = '  Rail re-fastened  ';
    card.querySelector('.p86-st-flag-resolve-go').click();
    await settle();
    await settle();
    expect(resolveCalls).toEqual([['st_1', 'f_safe', 'Rail re-fastened']]);
    expect(toasts).toEqual([['Problem resolved', 'success']]);
    expect(changed).toEqual([true]);
    // Emptied before the refresh, so a saved note never holds the repaint.
    expect(input.value).toBe('');
  });

  test('Enter in the note resolves', async () => {
    const F = boot(SRC);
    const { card, changed } = panelFor(F);
    const input = card.querySelector('.p86-st-flag-note-in');
    input.value = 'Called the owner';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await settle();
    await settle();
    expect(resolveCalls).toEqual([['st_1', 'f_safe', 'Called the owner']]);
    expect(changed).toEqual([true]);
  });

  test('a refusal is shown in the server\'s words and nothing refreshes', async () => {
    const F = boot(SRC, { resolve: httpError(404, 'That problem is not on this ticket, or it was already resolved.') });
    const { card, changed } = panelFor(F);
    card.querySelector('.p86-st-flag-note-in').value = 'Done';
    card.querySelector('.p86-st-flag-resolve-go').click();
    await settle();
    await settle();
    expect(toasts).toEqual([['That problem is not on this ticket, or it was already resolved.', 'error']]);
    expect(changed).toEqual([]);
    expect(card.querySelector('.p86-st-flag-resolve-go').disabled).toBe(false);
    expect(card.querySelector('.p86-st-flag-note-in').value).toBe('Done');
  });

  test('a double click sends one resolve', async () => {
    const F = boot(SRC);
    const { card } = panelFor(F);
    card.querySelector('.p86-st-flag-note-in').value = 'Done';
    const go = card.querySelector('.p86-st-flag-resolve-go');
    go.click();
    go.click();
    await settle();
    await settle();
    expect(resolveCalls).toHaveLength(1);
  });

  test('wiring twice adds one listener, and the latest ticket and options win', async () => {
    const F = boot(SRC);
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf }));
    const first = [];
    const second = [];
    F.wire(host, T, { canResolve: true, onChanged: () => first.push(1) });
    F.wire(host, T, { canResolve: true, onChanged: () => second.push(1) });
    const card = host.querySelector('[data-flag="f_safe"]');
    card.querySelector('.p86-st-flag-note-in').value = 'Done';
    card.querySelector('.p86-st-flag-resolve-go').click();
    await settle();
    await settle();
    expect(resolveCalls).toHaveLength(1);
    expect([first.length, second.length]).toEqual([0, 1]);
  });
});

// ── registerAction ────────────────────────────────────────────────────────
describe('registerAction: the card actions slot', () => {
  test('a visible action is a button on the card; clicking it runs with the flag, ticket and ctx', () => {
    const F = boot(SRC);
    const runs = [];
    const ctx = { ticketId: 'st_1' };
    expect(F.registerAction({
      key: 'co', label: 'Start change order', title: 'Draft a change order from this problem',
      visible: (f) => f.status === 'open',
      run: (f, t, c) => runs.push([f.id, t.id, c]),
    })).toBe(true);
    const host = mount(F.panelHTML(FLAGS, T, { canResolve: true, headOf, ctx }));
    F.wire(host, T, { canResolve: true, ctx });
    const buttons = Array.from(host.querySelectorAll('[data-flag-act="co"]'));
    expect(buttons.map((b) => b.closest('.p86-st-flag').getAttribute('data-flag'))).toEqual(['f_safe', 'f_gate']);
    expect(buttons[0].textContent).toBe('Start change order');
    buttons[1].click();
    expect(runs).toEqual([['f_gate', 'st_1', ctx]]);
    expect(F.registerAction({ label: 'no key' })).toBe(false);
  });
});

// ── eventWhat ─────────────────────────────────────────────────────────────
describe('eventWhat: the timeline wording', () => {
  test('flag_raised, flag_resolved and a photo added to a problem; anything else is left to the host', () => {
    const F = boot(SRC);
    expect(F.eventWhat({ kind: 'flag_raised', detail: { flag_id: 'f1', category: 'safety', task_id: 'k1' } }, 'Bldg 784')).toBe('flagged a problem on Bldg 784 — Safety');
    expect(F.eventWhat({ kind: 'flag_raised', detail: '{"flag_id":"f1","category":"material_short","task_id":null}' }, '')).toBe('flagged a problem — Material short');
    expect(F.eventWhat({ kind: 'flag_resolved', detail: { flag_id: 'f1', category: 'safety', task_id: 'k1' } }, 'Bldg 784')).toBe('resolved a problem on Bldg 784');
    expect(F.eventWhat({ kind: 'flag_resolved', detail: {} }, '')).toBe('resolved a problem');
    expect(F.eventWhat({ kind: 'photo_added', detail: { flag_id: 'f1', kind: 'flag' } }, '')).toBe('added a photo to a problem');
    expect(F.eventWhat({ kind: 'photo_added', detail: { task_id: 'k1', kind: 'completion' } }, 'Bldg 784')).toBeNull();
    expect(F.eventWhat({ kind: 'note_added', detail: {} }, '')).toBeNull();
  });
});

// ── the job chip ──────────────────────────────────────────────────────────
function chipDom(jobId) {
  document.body.innerHTML =
    '<button class="ws-right-tab" data-panel="job-service-tickets">Service Tickets<span class="ws-right-tab-chip" data-jobchip="job-service-tickets"></span></button>';
  if (jobId !== undefined) window.appState.currentJobId = jobId;
  return document.querySelector('[data-jobchip="job-service-tickets"]');
}

const ROWS = {
  flagged: [{ id: 'a', status: 'in_progress', open_flags: 1 }, { id: 'b', status: 'open', pending_suggestions: 2 }, { id: 'c', status: 'open', new_from_crew: true }],
  suggestionsOnly: [{ id: 'b', status: 'open', pending_suggestions: 2 }, { id: 'd', status: 'in_progress' }],
  quiet: [{ id: 'd', status: 'in_progress', open_flags: 0, pending_suggestions: 0, new_from_crew: false }, { id: 'e', status: 'closed', pending_suggestions: 3, new_from_crew: true }],
};

async function checkChipTones(F) {
  const chip = chipDom('j1');
  await F.fillJobChip('j1', ROWS.flagged);
  expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['3', 'r']);
  expect(chip.parentNode.getAttribute('title')).toBe('Service tickets needing you: 1 with open problems · 1 with suggestions waiting · 1 new from crew');
  await F.fillJobChip('j1', ROWS.suggestionsOnly);
  expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['1', 'o']);
  await F.fillJobChip('j1', ROWS.quiet);
  expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['', null]);
  expect(chip.parentNode.hasAttribute('title')).toBe(false);
}

async function checkOtherJob(F) {
  const chip = chipDom('j2');
  await F.fillJobChip('j1', ROWS.flagged);
  expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['', null]);
}

describe('fillJobChip: the Service Tickets count', () => {
  test('red while any problem is open, amber for suggestions only, empty when nothing needs the office', async () => {
    await checkChipTones(boot(SRC));
  });

  test('never paints onto a job that is not the one on screen', async () => {
    await checkOtherJob(boot(SRC));
  });

  test('MUTANT: the current-job check removed -> another job\'s count lands on this tab', async () => {
    const F = boot(mutantSrc("    if (!app || app.currentJobId == null || String(app.currentJobId) !== String(jobId)) return false;\n", ''));
    window.appState = { currentJobId: 'j2' };
    await expect(checkOtherJob(F)).rejects.toThrow();
  });

  test('MUTANT: the tone ignores problems -> an open safety problem shows amber', async () => {
    const F = boot(mutantSrc("chip.setAttribute('data-tone', a.problems ? 'r' : 'o');", "chip.setAttribute('data-tone', 'o');"));
    await expect(checkChipTones(F)).rejects.toThrow();
  });

  test('without rows it fetches the job\'s tickets once, shares an in-flight fetch, and uses the list for a minute', async () => {
    const F = boot(SRC, { list: { tickets: ROWS.flagged } });
    const chip = chipDom('j1');
    await Promise.all([F.fillJobChip('j1'), F.fillJobChip('j1')]);
    expect(listCalls).toEqual([{ job_id: 'j1' }]);
    expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['3', 'r']);
    await F.fillJobChip('j1');
    expect(listCalls).toHaveLength(1);
    const realNow = Date.now;
    try {
      Date.now = () => realNow() + 61 * 1000;
      await F.fillJobChip('j1');
    } finally {
      Date.now = realNow;
    }
    expect(listCalls).toHaveLength(2);
  });

  test('rows handed over replace the cache, so the next bare call does not fetch', async () => {
    const F = boot(SRC, { list: { tickets: ROWS.flagged } });
    const chip = chipDom('j1');
    await F.fillJobChip('j1', ROWS.suggestionsOnly);
    await F.fillJobChip('j1');
    expect(listCalls).toEqual([]);
    expect(chip.getAttribute('data-tone')).toBe('o');
  });

  test('a failed fetch leaves the chip alone and never throws', async () => {
    const F = boot(SRC, { list: httpError(500, 'boom') });
    const chip = chipDom('j1');
    chip.textContent = '2';
    await expect(F.fillJobChip('j1')).resolves.toBe(false);
    expect(chip.textContent).toBe('2');
  });
});

// ── markSeen ──────────────────────────────────────────────────────────────
describe('markSeen: opening the ticket clears New from crew', () => {
  test('office_seen true: the row, the list and the chip forget it', async () => {
    const F = boot(SRC);
    const chip = chipDom('j1');
    const rows = [{ id: 'c', status: 'open', new_from_crew: true }, { id: 'd', status: 'open' }];
    await F.fillJobChip('j1', rows);
    expect(chip.textContent).toBe('1');
    const rowEl = mount('<div class="p86-st-row">' + F.rowBadgesHTML(rows[0]) + '</div>');
    const copy = Object.assign({}, rows[0]);
    expect(F.markSeen(rowEl, copy, rows, 'j1', true)).toBe(true);
    expect([copy.new_from_crew, rows[0].new_from_crew]).toEqual([false, false]);
    expect(rowEl.querySelector('.is-new')).toBeNull();
    await settle();
    expect([chip.textContent, chip.getAttribute('data-tone')]).toEqual(['', null]);
  });

  test('office_seen false (a caller who can only view): nothing changes', () => {
    const F = boot(SRC);
    const rows = [{ id: 'c', status: 'open', new_from_crew: true }];
    const rowEl = mount('<div class="p86-st-row">' + F.rowBadgesHTML(rows[0]) + '</div>');
    expect(F.markSeen(rowEl, rows[0], rows, 'j1', false)).toBe(false);
    expect(rows[0].new_from_crew).toBe(true);
    expect(rowEl.querySelector('.is-new')).not.toBeNull();
  });
});

// ── registration with the ticket screen ───────────────────────────────────
describe('p86StExt: registered as ticket-flags, order 30', () => {
  function ctxFor(over) {
    return Object.assign({
      ticketId: 'st_1', t: T, canEdit: true,
      r: { flags: FLAGS },
      taskTitle: (id) => (id === 'k1' ? 'Bldg 784 — Side A: rail' : ''),
      parseSubtaskTitle: (title) => ({ head: String(title).split(' — ')[0], sides: [] }),
      refresh: jest.fn(() => Promise.resolve()),
    }, over || {});
  }

  test('the registry lists it at 30 with its hooks', () => {
    boot(SRC);
    const entry = window.p86StExt.list().find((e) => e.name === 'ticket-flags');
    expect(entry.order).toBe(30);
    for (const hook of ['rowBadges', 'detailSections', 'cardMeta', 'eventWhat', 'onRowExpanded', 'onListPainted']) {
      expect([hook, typeof entry.ext[hook]]).toEqual([hook, 'function']);
    }
  });

  test('no registry on the page: the module still loads and answers', () => {
    const F = boot(SRC, { noRegistry: true });
    expect(typeof F.panelHTML).toBe('function');
  });

  test('rowBadges and cardMeta through the registry', () => {
    boot(SRC);
    const X = window.p86StExt;
    expect(X.html('rowBadges', { status: 'open', open_flags: 2 }, {})).toContain('2 problems');
    const ctx = ctxFor();
    expect(X.html('cardMeta', { id: 'k1' }, ctx)).toBe('<span class="p86-wo-flagchip">Needs office</span>');
    expect(X.html('cardMeta', { id: 'k2' }, ctx)).toBe('');
    expect(X.html('cardMeta', { id: 'k1' }, ctxFor({ r: { flags: [flag({ task_id: 'k1', status: 'resolved' })] } }))).toBe('');
  });

  test('detailSections: one "flags" section after the site card, headed by the building head; Resolve refreshes the ticket', async () => {
    boot(SRC);
    const ctx = ctxFor();
    const sections = window.p86StExt.collect('detailSections', ctx);
    expect(sections).toHaveLength(1);
    const [sec] = sections[0];
    expect([sec.key, sec.slot]).toEqual(['flags', 'afterSite']);
    const host = mount(sec.html);
    expect(host.querySelector('[data-flag="f_safe"] .p86-st-flag-where').textContent).toBe('Bldg 784');
    const node = host.firstElementChild;
    sec.wire(node, ctx);
    const card = node.querySelector('[data-flag="f_safe"]');
    card.querySelector('.p86-st-flag-note-in').value = 'Fixed';
    card.querySelector('.p86-st-flag-resolve-go').click();
    await settle();
    await settle();
    expect(resolveCalls).toEqual([['st_1', 'f_safe', 'Fixed']]);
    expect(ctx.refresh).toHaveBeenCalledTimes(1);
  });

  test('detailSections for a caller who cannot edit has no Resolve; a ticket with no flags has an empty section', () => {
    boot(SRC);
    const ctx = ctxFor({ canEdit: false });
    const [[sec]] = window.p86StExt.collect('detailSections', ctx);
    const host = mount(sec.html);
    expect(host.querySelectorAll('.p86-st-flag')).toHaveLength(3);
    expect(host.querySelector('.p86-st-flag-note-in')).toBeNull();
    expect(window.p86StExt.collect('detailSections', ctxFor({ r: {} }))[0][0].html).toBe('');
  });

  test('eventWhat through the registry is escaped html, with the building head from the host', () => {
    boot(SRC);
    const helpers = { esc: (s) => s, head: (id) => (id === 'k1' ? 'Bldg <784>' : ''), statusLabel: (s) => s };
    expect(window.p86StExt.first('eventWhat', { kind: 'flag_raised', detail: { category: 'safety', task_id: 'k1' } }, helpers))
      .toBe('flagged a problem on Bldg &lt;784&gt; — Safety');
    expect(window.p86StExt.first('eventWhat', { kind: 'status_changed', detail: {} }, helpers)).toBeNull();
  });

  test('onRowExpanded clears New from crew only when the read says office_seen; onListPainted paints the chip', async () => {
    boot(SRC);
    const X = window.p86StExt;
    const chip = chipDom('j1');
    const rows = [{ id: 'c', status: 'open', new_from_crew: true }];
    X.collect('onListPainted', document.body, { jobId: 'j1', tickets: rows, filter: 'all' });
    await settle();
    expect(chip.textContent).toBe('1');
    const rowEl = mount('<div>' + X.html('rowBadges', rows[0], {}) + '</div>');
    X.collect('onRowExpanded', rowEl, rows[0], { office_seen: false }, { jobId: 'j1', tickets: rows });
    expect(rows[0].new_from_crew).toBe(true);
    X.collect('onRowExpanded', rowEl, rows[0], { office_seen: true }, { jobId: 'j1', tickets: rows });
    await settle();
    expect(rows[0].new_from_crew).toBe(false);
    expect(rowEl.querySelector('.is-new')).toBeNull();
    expect(chip.textContent).toBe('');
  });
});

// ── no prices, no native dialogs, no forbidden helper names ───────────────
describe('module hygiene', () => {
  const code = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  test('no native confirm/prompt/alert, no appData writes, no date helper the calendar ledger would have to classify', () => {
    expect(code).not.toMatch(/\b(confirm|prompt|alert)\s*\(/);
    expect(code).not.toMatch(/appData/);
    expect(code).not.toMatch(/function\s+(fmtDate\w*|fmtDay\w*|formatDate\w*|todayISO)\s*\(/);
  });
});

// ── js/workspace-layout.js asks for the chip ──────────────────────────────
describe('js/workspace-layout.js refreshJobNavChips', () => {
  // The function lifted out of the shipped file by balanced braces and run.
  function lift(src) {
    const text = src.replace(/\r\n/g, '\n');
    const start = text.indexOf('  function refreshJobNavChips(jobId) {');
    if (start < 0) throw new Error('refreshJobNavChips not found');
    let depth = 0;
    let end = -1;
    for (let i = text.indexOf('{', start); i < text.length; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    }
    // eslint-disable-next-line no-new-func
    return new Function(text.slice(start, end) + '\nreturn refreshJobNavChips;')();
  }
  const LAYOUT = fs.readFileSync(LAYOUT_PATH, 'utf8');
  const LINE = "      if (window.p86TicketFlags && typeof window.p86TicketFlags.fillJobChip === 'function') window.p86TicketFlags.fillJobChip(jobId);\n";

  beforeEach(() => {
    document.body.innerHTML = '<span data-jobchip="job-invoices"></span><div id="appJobnavAttn"></div>';
    window.appData = { buildings: [], jobChangeOrders: [], jobPurchaseOrders: [] };
    window.getJobWIP = () => ({ displayMargin: 12, arOutstanding: 0 });
  });
  afterEach(() => {
    delete window.p86TicketFlags;
    delete window.getJobWIP;
    delete window.appData;
  });

  test('the job being painted is handed to fillJobChip; the other chips still paint', () => {
    const calls = [];
    window.p86TicketFlags = { fillJobChip: (id) => calls.push(id) };
    lift(LAYOUT)('j7');
    expect(calls).toEqual(['j7']);
    window.appState = { currentJobId: 'j8' };
    lift(LAYOUT)();
    expect(calls).toEqual(['j7', 'j8']);
  });

  test('without the flags module the nav is untouched and nothing throws', () => {
    delete window.p86TicketFlags;
    expect(() => lift(LAYOUT)('j7')).not.toThrow();
    window.p86TicketFlags = { fillJobChip: 'not a function' };
    expect(() => lift(LAYOUT)('j7')).not.toThrow();
  });

  test('the call sits inside the function\'s try, exactly once', () => {
    const text = LAYOUT.replace(/\r\n/g, '\n');
    expect(text.split(LINE).length - 1).toBe(1);
    const fn = text.slice(text.indexOf('  function refreshJobNavChips(jobId) {'), text.indexOf('  window.refreshJobNavChips = refreshJobNavChips;'));
    const at = fn.indexOf(LINE);
    expect(at).toBeGreaterThan(fn.indexOf('    try {'));
    expect(at).toBeLessThan(fn.indexOf('    } catch (e) { /* never break the nav */ }'));
  });

  test('MUTANT: the line removed -> the chip is never asked for', () => {
    const text = LAYOUT.replace(/\r\n/g, '\n');
    expect(text.split(LINE).length - 1).toBe(1);
    const calls = [];
    window.p86TicketFlags = { fillJobChip: (id) => calls.push(id) };
    lift(text.split(LINE).join(''))('j7');
    expect(calls).toEqual([]);
  });
});
