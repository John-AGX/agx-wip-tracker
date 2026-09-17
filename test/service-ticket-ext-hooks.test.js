/**
 * @jest-environment jsdom
 */
// js/service-tickets.js as the host of window.p86StExt (Work Orders 1.29,
// shared contracts 5.2). Every other office module adds to the work order
// screen through these hooks, so the host's side of the contract is driven
// here with stub modules through the REAL files: slots and their order, a
// section re-wired only when its markup changes, eventWhat before the built-in
// wording, confirmMove cancelling a move, and the row, card, note and
// suggestion hooks with the arguments they are promised.
//
// Mutants run on a CRLF-normalised copy; the anchor must occur exactly once.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TICKETS_SRC = read('js/service-tickets.js');
const EDITOR_SRC = read('js/service-ticket-editor.js');
const EXT_SRC = read('js/service-ticket-ext.js');
const MOVE_SRC = read('js/service-ticket-status-move.js');
const JOB_LABEL = require('../js/job-label.js');

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('anchor not found');
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 12; i++) await tick(); }
const copy = (v) => JSON.parse(JSON.stringify(v));

function env(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = { jobs: [Object.assign({ id: 'job_77', jobNumber: 'RV2006', title: 'Waterside' }, o.readOnly ? { _canEdit: false } : {})], leads: [] };
  window.p86JobLabel = JOB_LABEL;
  const s = {
    ticket: { id: 'st_1', ticket_number: 'WO-0001', title: 'Replace treads', status: o.status || 'open', priority: 'normal',
      job_id: 'job_77', lead_id: null, scope_proposed: 'Rehang', assignee_user_id: null, guest_log: 'Crew was here' },
    tasks: [{ id: 'tk_1', title: 'Bldg 784 — Side A: rail', status: 'open', photos: [],
      notes: [{ id: 'n_1', by: 'Sam', at: '2026-09-14T15:05:00.000Z', note: 'Rail loose' }, { by: 'Old', note: 'no id' }] }],
    events: [],
    revisions: [{ id: 'rv_1', status: 'pending', fields: { scope_proposed: 'Theirs' }, author_label: 'Rosa' }],
  };
  window.p86Api = {
    serviceTickets: {
      list: jest.fn(() => Promise.resolve({ tickets: [Object.assign(copy(s.ticket), { task_total: 1, task_done: 0 })] })),
      get: jest.fn(() => Promise.resolve({ ticket: copy(s.ticket), tasks: copy(s.tasks), events: copy(s.events), revisions: copy(s.revisions), participants: [], site: null, flags: [] })),
      setStatus: jest.fn(() => Promise.resolve({ ok: true, ticket: copy(s.ticket) })),
      assignees: jest.fn(() => Promise.resolve({ users: [] })),
    },
    users: { list: jest.fn(() => Promise.resolve({ users: [] })) },
  };
  window.p86Auth = { hasCapability: () => true, getUser: () => ({ id: 10 }) };
  window.p86Toast = jest.fn();
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  window.p86ConfirmTernary = jest.fn(() => Promise.resolve(null));
  if (o.noAi) delete window.p86AI; else window.p86AI = { ask: jest.fn() };
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  delete window.p86StExt;
  window.eval(EXT_SRC);
  window.eval(EDITOR_SRC);
  window.eval(MOVE_SRC);
  if (o.register) o.register(window.p86StExt);
  window.eval(o.src || TICKETS_SRC);
  return s;
}

const pane = () => document.getElementById('job-service-tickets');
const detail = () => pane().querySelector('.p86-st-row.is-open .p86-st-detail');

async function openTicket() {
  window.renderJobServiceTickets('job_77');
  await flush();
  pane().querySelector('.p86-st-row-head').click();
  await flush();
  return detail();
}

// A module that puts one section in every slot.
function slotModule(spy) {
  const one = (key, slot, tag) => ({
    key, slot,
    html: '<' + tag + ' class="stub-' + key + '">' + key + '</' + tag + '>',
    wire: (node, ctx) => spy.push([key, node.getAttribute('data-st-sec'), ctx.ticketId]),
  });
  return {
    order: 50,
    detailSections: () => [
      one('x-banner', 'banner', 'div'), one('x-site', 'afterSite', 'div'), one('x-scope', 'scopeCard', 'div'),
      one('x-revs', 'afterRevisions', 'div'), one('x-meta', 'statusMeta', 'span'), one('x-act', 'actions', 'button'),
    ],
  };
}

describe('detail sections render in their slots, in order', () => {
  test('each slot holds its section at the promised place, tagged and wired once', async () => {
    const wired = [];
    env({ register: (x) => x.register('stub', slotModule(wired)) });
    const d = await openTicket();
    const keyed = Array.from(d.querySelectorAll('[data-st-sec]')).map((n) => n.getAttribute('data-st-sec'));
    const at = (k) => keyed.indexOf(k);
    expect(at('x-banner')).toBe(at('stepper') + 1);
    expect(at('x-site')).toBe(at('site') + 1);
    expect(at('x-revs')).toBe(at('revs') + 1);
    // scopeCard: inside the scope card, after the field log.
    const scopeSec = d.querySelector('.p86-st-scopecard > [data-st-sec="x-scope"]');
    expect(scopeSec).not.toBeNull();
    expect(scopeSec.previousElementSibling.getAttribute('data-st-sec')).toBe('scopeextra');
    // statusMeta: a span right after the status control, in the Status row.
    const meta = d.querySelector('.p86-st-meta[data-for="status"] [data-st-sec="x-meta"]');
    expect(meta.tagName).toBe('SPAN');
    expect(meta.previousElementSibling.getAttribute('data-st-sec')).toBe('status');
    // actions: in the actions bar, after the built-in buttons.
    const bar = d.querySelector('.p86-st-actions');
    expect(bar.lastElementChild.getAttribute('data-st-sec')).toBe('x-act');
    expect(wired.map((w) => w[0]).sort()).toEqual(['x-act', 'x-banner', 'x-meta', 'x-revs', 'x-scope', 'x-site']);
    wired.forEach((w) => { expect(w[1]).toBe(w[0]); expect(w[2]).toBe('st_1'); });
  });

  test('two modules in one slot follow registry order', async () => {
    env({
      register: (x) => {
        x.register('late', { order: 60, detailSections: () => [{ key: 'b-late', slot: 'banner', html: '<div>late</div>' }] });
        x.register('early', { order: 10, detailSections: () => [{ key: 'b-early', slot: 'banner', html: '<div>early</div>' }] });
      },
    });
    const d = await openTicket();
    const keys = Array.from(d.querySelectorAll('[data-st-sec^="b-"]')).map((n) => n.getAttribute('data-st-sec'));
    expect(keys).toEqual(['b-early', 'b-late']);
  });

  test('a read-only ticket with no 86 still shows an actions bar for a module action', async () => {
    env({
      readOnly: true, noAi: true,
      register: (x) => x.register('print', { detailSections: () => [{ key: 'print-menu', slot: 'actions', html: '<button class="stub-print">Print</button>' }] }),
    });
    const d = await openTicket();
    expect(d.querySelector('.p86-st-actions .stub-print')).not.toBeNull();
    expect(d.querySelector('.p86-st-save')).toBeNull();
  });

  test('a section that throws does not cost the office the work order', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      env({ register: (x) => x.register('broken', { detailSections: () => { throw new Error('boom'); } }) });
      const d = await openTicket();
      expect(d.querySelector('.p86-st-scopecard')).not.toBeNull();
    } finally {
      warn.mockRestore();
    }
  });
});

describe('an update swaps a section only when its markup changed', () => {
  async function drive(src) {
    let label = 'one';
    const wires = [];
    env({
      src,
      register: (x) => x.register('bar', {
        detailSections: () => [{ key: 'wor-bar', slot: 'banner', html: '<div class="stub-bar">' + label + '</div>', wire: (n) => wires.push(n.textContent) }],
      }),
    });
    const d = await openTicket();
    const first = d.querySelector('[data-st-sec="wor-bar"]');
    await d._st.refresh();
    const afterSame = { node: d.querySelector('[data-st-sec="wor-bar"]'), wires: wires.slice() };
    label = 'two';
    await d._st.refresh();
    return { first, afterSame, afterChange: { node: d.querySelector('[data-st-sec="wor-bar"]'), wires: wires.slice() } };
  }

  test('unchanged html keeps the node and is not re-wired; changed html is swapped and wired again', async () => {
    const r = await drive();
    expect(r.afterSame.node).toBe(r.first);
    expect(r.afterSame.wires).toEqual(['one']);
    expect(r.afterChange.node).not.toBe(r.first);
    expect(r.afterChange.node.textContent).toBe('two');
    expect(r.afterChange.wires).toEqual(['one', 'two']);
  });

  test('FIRES: updates that skip extension sections leave the old markup', async () => {
    const broken = mutate(TICKETS_SRC, '    patchExtSections(d, ctx);\n', '');
    const r = await drive(broken);
    expect(r.afterChange.node.textContent).toBe('one');
  });

  test('a section that appears only after the first paint is put in its slot', async () => {
    let show = false;
    env({
      register: (x) => x.register('late', {
        detailSections: () => (show ? [{ key: 'notice-banner', slot: 'banner', html: '<div class="stub-notice">Nobody told</div>' }] : []),
      }),
    });
    const d = await openTicket();
    expect(d.querySelector('[data-st-sec="notice-banner"]')).toBeNull();
    show = true;
    await d._st.refresh();
    const node = d.querySelector('[data-st-sec="notice-banner"]');
    expect(node).not.toBeNull();
    expect(node.previousElementSibling.getAttribute('data-st-sec')).toBe('stepper');
    show = false;
    await d._st.refresh();
    expect(d.querySelector('.stub-notice')).toBeNull();
  });

  test('wireDetail runs once per detail; afterPaint after the paint and after each update', async () => {
    const wireDetail = jest.fn();
    const afterPaint = jest.fn();
    env({ register: (x) => x.register('w', { wireDetail, afterPaint }) });
    const d = await openTicket();
    await d._st.refresh();
    await d._st.refresh();
    expect(wireDetail).toHaveBeenCalledTimes(1);
    expect(wireDetail.mock.calls[0][0]).toBe(d);
    expect(afterPaint).toHaveBeenCalledTimes(3);
  });
});

describe('the ctx handed to modules', () => {
  test('carries the live ticket, the last read, and working helpers', async () => {
    let seen = null;
    env({ register: (x) => x.register('c', { wireDetail: (d, ctx) => { seen = ctx; } }) });
    const d = await openTicket();
    expect(seen).toBe(d._st);
    expect(seen).toMatchObject({ ticketId: 'st_1', canEdit: true, jobId: 'job_77', leadId: null });
    expect(seen.t.title).toBe('Replace treads');
    expect(Array.isArray(seen.r.tasks)).toBe(true);
    expect(seen.taskTitle('tk_1')).toBe('Bldg 784 — Side A: rail');
    expect(seen.parseSubtaskTitle('Bldg 784 — Side A: rail').head).toBe('Bldg 784');
    expect(seen.api()).toBe(window.p86Api.serviceTickets);
    expect(typeof seen.toast).toBe('function');
    await expect(seen.leave()).resolves.toBe(true);
    const lists = window.p86Api.serviceTickets.list.mock.calls.length;
    await seen.reload();
    await flush();
    expect(window.p86Api.serviceTickets.list.mock.calls.length).toBe(lists + 1);
  });
});

describe('eventWhat comes before the built-in wording', () => {
  test('a module that owns the kind words it; null leaves the built-in wording', async () => {
    env({
      register: (x) => {
        x.register('a', { order: 10, eventWhat: () => null });
        x.register('b', { order: 20, eventWhat: (e, h) => (e.kind === 'status_changed' ? 'sent it back to ' + h.esc(h.statusLabel(e.detail.to)) : null) });
        x.register('c', { order: 30, eventWhat: (e) => (e.kind === 'status_changed' ? 'LATER' : null) });
      },
    });
    const api = window.p86Api.serviceTickets;
    const events = [
      { kind: 'status_changed', actor_kind: 'user', detail: { from: 'work_complete', to: 'in_progress' }, created_at: '2026-09-14T12:00:00Z' },
      { kind: 'task_added', actor_kind: 'user', detail: JSON.stringify({ task_id: 'tk_gone', title: 'Bldg 9 — Side A: x' }), created_at: '2026-09-14T12:00:00Z' },
    ];
    const get = api.get;
    api.get = jest.fn((id) => get(id).then((r) => Object.assign(r, { events })));
    const d = await openTicket();
    const what = Array.from(d.querySelectorAll('.p86-st-event-what')).map((n) => n.textContent);
    expect(what).toEqual(['sent it back to In progress', 'added Bldg 9']);
  });

  test('FIRES: the built-in chain first, the module wording never shows', async () => {
    const broken = mutate(TICKETS_SRC, '    if (own.length) {\n      what = String(own[0]);\n    } else if', '    if (false) {\n    } else if');
    env({ src: broken, register: (x) => x.register('b', { eventWhat: () => 'OWNED' }) });
    const api = window.p86Api.serviceTickets;
    const get = api.get;
    api.get = jest.fn((id) => get(id).then((r) => Object.assign(r, { events: [{ kind: 'created', actor_kind: 'user', detail: {} }] })));
    const d = await openTicket();
    expect(d.querySelector('.p86-st-event-what').textContent).toBe('raised the ticket');
  });
});

describe('built-in timeline wording for 1.29 events', () => {
  test('reasons, overrides, notes, buildings and photos read as sentences', async () => {
    env();
    const E = (kind, detail) => ({ kind, actor_kind: 'user', detail, created_at: '2026-09-14T12:00:00Z' });
    const events = [
      E('status_changed', { from: 'in_progress', to: 'work_complete', reason: 'marked_complete' }),
      E('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'crew_undid_finish' }),
      E('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'subtask_added' }),
      E('status_changed', { from: 'work_complete', to: 'in_progress', reason: 'subtask_removed' }),
      E('status_changed', { from: 'in_progress', to: 'work_complete', override: 'buildings_open', open: 2, total: 5, note: 'Owner <asked>' }),
      E('task_removed', { task_id: 'tk_x', title: 'Bldg 5 — A: y', reason: 'archived' }),
      E('task_removed', { task_id: 'tk_x', title: 'Bldg 5 — A: y', reason: 'moved' }),
      E('photo_removed', { attachment_id: 'a', task_id: 'tk_1', kind: 'before', how: 'deleted' }),
      E('photo_removed', { attachment_id: 'a', task_id: null, kind: 'site', how: 'deleted' }),
      E('photo_retagged', { attachment_id: 'a', task_id: 'tk_1', from: 'before', to: 'completion' }),
      E('note_added', { photo_count: 2 }),
      E('note_added', { photo_count: 1 }),
      E('photo_added', { mime: 'image/jpeg', attachment_id: 'a' }),
      E('field_changed', { fields: ['title', 'street_address', 'city', 'internal_notes', 'assignee_user_id'] }),
    ];
    const api = window.p86Api.serviceTickets;
    const get = api.get;
    api.get = jest.fn((id) => get(id).then((r) => Object.assign(r, { events })));
    const d = await openTicket();
    const what = Array.from(d.querySelectorAll('.p86-st-event-what')).map((n) => n.textContent);
    expect(what).toEqual([
      'moved it to Work complete — the crew finished the whole work order',
      'moved it to In progress — the crew took back Finish whole work order',
      'moved it to In progress — a subtask was added',
      'moved it to In progress — its last subtask was removed',
      'moved it to Work complete with 2 of 5 subtasks still open — “Owner <asked>”',
      'removed Bldg 5',
      'took Bldg 5 off this work order',
      'removed a before photo from Bldg 784',
      'removed a site photo',
      'changed a before photo to a completion photo on Bldg 784',
      'added a field note with 2 photos',
      'added a field note with 1 photo',
      'added a site photo',
      'edited the title, the address, the internal notes, the assignee',
    ]);
    expect(d.querySelector('.p86-st-timeline').innerHTML).not.toContain('<asked>');
  });
});

describe('confirmMove, rowBadges, cardMeta, noteActions, revisionActions and the list hooks', () => {
  test('confirmMove null resets the select and sends nothing', async () => {
    env({ register: (x) => x.register('review', { confirmMove: () => Promise.resolve(null) }) });
    const d = await openTicket();
    const mv = d.querySelector('.p86-st-move');
    mv.value = 'cancelled';
    mv.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(window.p86Api.serviceTickets.setStatus).not.toHaveBeenCalled();
    expect(mv.value).toBe('');
    expect(mv.disabled).toBe(false);
  });

  test('rowBadges is drawn after the status on the row, with the list context', async () => {
    const rowBadges = jest.fn((row, listCtx) => (row.id === 'st_1' ? '<span class="stub-badge">1 problem flagged</span>' : ''));
    env({ register: (x) => x.register('flags', { rowBadges }) });
    window.renderJobServiceTickets('job_77');
    await flush();
    const badge = pane().querySelector('.p86-st-row-head .stub-badge');
    expect(badge.previousElementSibling.classList.contains('p86-st-status')).toBe(true);
    expect(rowBadges.mock.calls[0][1]).toMatchObject({ jobId: 'job_77', leadId: null, filter: 'all' });
  });

  test('cardMeta lands in the building meta; noteActions gets each note (with its id when there is one)', async () => {
    const noteActions = jest.fn((note) => (note.id ? '<button class="stub-note" data-note="' + note.id + '">CO</button>' : ''));
    env({ register: (x) => x.register('co', { cardMeta: (task) => '<span class="stub-chip">' + task.id + '</span>', noteActions }) });
    const d = await openTicket();
    expect(d.querySelector('.p86-wo-sub[data-task="tk_1"] .p86-wo-sub-meta .stub-chip').textContent).toBe('tk_1');
    expect(noteActions.mock.calls.map((c) => c[0].id)).toEqual(['n_1', undefined]);
    expect(noteActions.mock.calls[0][1].id).toBe('tk_1');
    expect(noteActions.mock.calls[0][2].ticketId).toBe('st_1');
    expect(Array.from(d.querySelectorAll('.p86-wo-note .stub-note')).map((b) => b.getAttribute('data-note'))).toEqual(['n_1']);
  });

  test('revisionActions is drawn in each suggestion row', async () => {
    env({ register: (x) => x.register('co', { revisionActions: (rev) => '<button class="stub-rev">' + rev.id + '</button>' }) });
    const d = await openTicket();
    expect(d.querySelector('.p86-st-rev[data-rev="rv_1"] .stub-rev').textContent).toBe('rv_1');
  });

  test('onRowExpanded after the ticket opens; onListPainted after each list paint', async () => {
    const onRowExpanded = jest.fn();
    const onListPainted = jest.fn();
    env({ register: (x) => x.register('flags', { onRowExpanded, onListPainted }) });
    await openTicket();
    expect(onListPainted).toHaveBeenCalledTimes(1);
    expect(onListPainted.mock.calls[0][0]).toBe(pane());
    expect(onListPainted.mock.calls[0][1]).toMatchObject({ jobId: 'job_77', filter: 'all' });
    expect(onRowExpanded).toHaveBeenCalledTimes(1);
    const [rowEl, row, response] = onRowExpanded.mock.calls[0];
    expect(rowEl.getAttribute('data-ticket')).toBe('st_1');
    expect(row.id).toBe('st_1');
    expect(Array.isArray(response.flags)).toBe(true);
  });

  test('no registry on the page: the ticket opens with no extensions', async () => {
    env();
    delete window.p86StExt;
    window.eval(TICKETS_SRC);
    const d = await openTicket();
    expect(d.querySelector('.p86-st-scopecard')).not.toBeNull();
  });
});

// The counters the badges are drawn from (open_flags, pending_suggestions,
// co_draft_count) are added by the LIST read only — the detail read carries
// none of them. Accepting or declining a suggestion, and a module resolving a
// problem, all end in an IN-PLACE detail update and never a list refetch, so
// the host recomputes them from that read. Without it the badge above the
// panel keeps saying a suggestion is waiting for the rest of the visit, while
// the panel under it shows it accepted.
describe('the row badges follow an in-place update', () => {
  const BADGES = {
    order: 20,
    rowBadges: (row) => ['pending_suggestions', 'open_flags', 'co_draft_count']
      .filter((k) => Number(row[k]) > 0)
      .map((k) => '<span class="stub-badge">' + k + ':' + Number(row[k]) + '</span>')
      .join(''),
  };
  const badges = () => Array.from(pane().querySelectorAll('.p86-st-row-head .stub-badge')).map((n) => n.textContent);

  // One ticket the LIST says has a suggestion waiting, an open problem and a
  // draft change order. The DETAIL read answers from `state`, which accept and
  // decline change the way the server would.
  function boot(opts) {
    const o = opts || {};
    const state = {
      revisions: [{ id: 'rv_1', status: 'pending', fields: { scope_proposed: 'Theirs' }, author_label: 'Rosa' }],
      flags: [{ id: 'fl_1', status: 'open' }],
      change_orders: [{ id: 'co_1', status: 'draft' }],
    };
    const s = env({ src: o.src, register: (x) => x.register('badges', BADGES) });
    const st = window.p86Api.serviceTickets;
    st.list = jest.fn(() => Promise.resolve({
      tickets: [Object.assign(copy(s.ticket), {
        task_total: 1, task_done: 0, pending_suggestions: 1, open_flags: 1, co_draft_count: 1,
      })],
    }));
    st.get = jest.fn(() => Promise.resolve({
      ticket: copy(s.ticket), tasks: copy(s.tasks), events: [], participants: [], site: null,
      progress: { tasksTotal: 1, tasksDone: 0 },
      revisions: copy(state.revisions), flags: copy(state.flags), change_orders: copy(state.change_orders),
    }));
    st.acceptRevision = jest.fn(() => { state.revisions[0].status = 'accepted'; return Promise.resolve({ ok: true }); });
    st.rejectRevision = jest.fn(() => { state.revisions[0].status = 'rejected'; return Promise.resolve({ ok: true }); });
    window.p86TicketFlags = { fillJobChip: jest.fn() };
    return state;
  }

  afterEach(() => { delete window.p86TicketFlags; });

  test('the badges start from the list read', async () => {
    boot();
    window.renderJobServiceTickets('job_77');
    await flush();
    expect(badges()).toEqual(['pending_suggestions:1', 'open_flags:1', 'co_draft_count:1']);
  });

  test('accepting the suggestion drops "waiting" and leaves the problem and the draft', async () => {
    boot();
    const d = await openTicket();
    d.querySelector('.p86-st-rev-accept').click();
    await flush();
    expect(window.p86Api.serviceTickets.acceptRevision).toHaveBeenCalledTimes(1);
    expect(d.querySelector('.p86-st-rev-state').textContent).toBe('accepted');
    expect(badges()).toEqual(['open_flags:1', 'co_draft_count:1']);
  });

  test('declining it drops it too', async () => {
    boot();
    const d = await openTicket();
    d.querySelector('.p86-st-rev-reject').click();
    await flush();
    expect(badges()).toEqual(['open_flags:1', 'co_draft_count:1']);
  });

  test('a module resolving the last problem clears its badge, and the job chip is given the same rows', async () => {
    const state = boot();
    const d = await openTicket();
    state.flags[0].status = 'resolved';
    await d._st.refresh();
    await flush();
    expect(badges()).toEqual(['pending_suggestions:1', 'co_draft_count:1']);
    const chip = window.p86TicketFlags.fillJobChip.mock.calls.pop();
    expect(chip[0]).toBe('job_77');
    expect(chip[1][0]).toMatchObject({ id: 'st_1', open_flags: 0, pending_suggestions: 1, co_draft_count: 1 });
  });

  test('MUTANT: an update that only merges the detail ticket leaves "1 waiting" on the row', async () => {
    boot({ src: mutate(TICKETS_SRC, "      entry.pending_suggestions = countInState(read.revisions, 'pending');\n", '') });
    const d = await openTicket();
    d.querySelector('.p86-st-rev-accept').click();
    await flush();
    expect(d.querySelector('.p86-st-rev-state').textContent).toBe('accepted');
    expect(badges()).toEqual(['pending_suggestions:1', 'open_flags:1', 'co_draft_count:1']);
  });
});
