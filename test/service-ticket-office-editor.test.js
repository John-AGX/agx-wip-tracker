/**
 * @jest-environment jsdom
 */
// The office work order screen keeps what the PM typed (Work Orders 1.29, A8
// and B2 UI), driven through the REAL js/service-tickets.js with the REAL
// editor kit (js/service-ticket-editor.js), extension registry
// (js/service-ticket-ext.js) and status move helper
// (js/service-ticket-status-move.js) loaded before it, as index.html does.
//
//   (a)(b) Save sends only the changed fields, with what they were when loaded
//   (c)(d) ticking a building updates in place and says when it completed the order
//   (e)(f) anything that would redraw the fields asks "Save your changes first?"
//   (g)    adding a building does not ask, and keeps the typing
//   (h)    Move to… goes through a registered confirmMove, with expected_status
//   (i)(j) a refused field is highlighted; an edit conflict keeps the typing
//   (k)(l) a tab return keeps the pane; a job switch keeps a draft
//   (m)    New ticket asks Due and Assigned to, and asks before discarding
//   (n)    the Assigned to picker, the initials chip and the Mine filter
//   (o)    an update keeps the anchor where it was on screen
//   (p)    a kept draft holds the page leave only while it can come back
//   (q)    the "changes are back" note goes when the changes do
//   (r)    the scroll anchor is looked up when the update lands
//
// Each guard is also shown to FIRE on a copy of the shipped source with that
// guard broken (CRLF normalised; the anchor must occur exactly once).
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
const STALE = 'This work order just changed. Reload to see the latest.';

const TICKETS = () => [
  { id: 'st_1', ticket_number: 'WO-0001', title: 'Replace stair treads', status: 'open', priority: 'normal',
    job_id: 'job_77', lead_id: null, scope_proposed: 'Rehang the gate', due_date: null, scheduled_for: null,
    assignee_user_id: 10, site_contact_name: 'Rosa', internal_notes: null, task_total: 2, task_done: 0 },
  { id: 'st_2', ticket_number: 'WO-0002', title: 'Fix the latch', status: 'in_progress', priority: 'high',
    job_id: 'job_77', lead_id: null, scope_proposed: '', assignee_user_id: null, task_total: 0, task_done: 0 },
  { id: 'st_3', ticket_number: 'WO-0003', title: 'Old closed one', status: 'closed', priority: 'normal',
    job_id: 'job_77', lead_id: null, scope_proposed: '', assignee_user_id: 10, task_total: 0, task_done: 0 },
  { id: 'st_8', ticket_number: 'WO-0008', title: 'Other job ticket', status: 'open', priority: 'normal',
    job_id: 'job_88', lead_id: null, scope_proposed: '', assignee_user_id: null, task_total: 0, task_done: 0 },
];
const TASKS = () => ({
  st_1: [
    { id: 'tk_1', title: 'Bldg 784 — Side A: rail post', status: 'open',
      photos: [{ id: 'ph_1', kind: 'completion', thumb_url: '/t/1.jpg' }], notes: [] },
    { id: 'tk_2', title: 'Bldg 790 — Side D: stringer', status: 'open', photos: [], notes: [] },
  ],
});

function env(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="scroller"><div id="job-service-tickets"></div></div>';
  window.appState = { currentJobId: 'job_77' };
  window.appData = {
    jobs: [{ id: 'job_77', jobNumber: 'RV2006', title: 'Waterside' }, { id: 'job_88', jobNumber: 'RV2007', title: 'Harbor' }],
    leads: [],
  };
  window.p86JobLabel = JOB_LABEL;
  const s = { tickets: TICKETS(), tasks: TASKS(), revisions: o.revisions || [], lists: 0 };
  const find = (id) => s.tickets.find((t) => t.id === id);
  window.p86Api = {
    serviceTickets: {
      list: jest.fn((q) => { s.lists++; return Promise.resolve({ tickets: copy(s.tickets.filter((t) => t.job_id === q.job_id)) }); }),
      get: jest.fn((id) => {
        const tasks = s.tasks[id] || [];
        return Promise.resolve({
          ticket: copy(find(id)), tasks: copy(tasks), events: [], revisions: copy(s.revisions),
          participants: [], site: null,
          progress: { tasksTotal: tasks.length, tasksDone: tasks.filter((k) => k.status === 'done').length },
        });
      }),
      update: jest.fn((id, body) => {
        const patch = Object.assign({}, body);
        delete patch.expected;
        Object.assign(find(id), patch);
        return Promise.resolve({ ok: true, ticket: copy(find(id)), changed: Object.keys(patch) });
      }),
      setStatus: jest.fn((id, status) => {
        find(id).status = status;
        return Promise.resolve({ ok: true, ticket: copy(find(id)) });
      }),
      setSubtaskDone: jest.fn((id, taskId, done) => {
        const k = s.tasks[id].find((x) => x.id === taskId);
        k.status = done ? 'done' : 'open';
        return Promise.resolve(o.doneResponse || { ok: true, task: copy(k), ticket_status: find(id).status });
      }),
      create: jest.fn((p) => Promise.resolve({ ok: true, ticket: Object.assign({ id: 'st_new' }, p) })),
      archive: jest.fn(() => Promise.resolve({ ok: true })),
      acceptRevision: jest.fn(() => Promise.resolve({ ok: true })),
      rejectRevision: jest.fn(() => Promise.resolve({ ok: true })),
      assignees: jest.fn(() => Promise.resolve({ users: [{ id: 10, name: 'Pat Office' }, { id: 12, name: 'Rosa Diaz' }] })),
      shares: jest.fn(() => Promise.resolve({ shares: [] })),
    },
    tasks: {
      create: jest.fn((p) => {
        s.tasks[p.service_ticket_id].push({ id: 'tk_new', title: p.title, status: 'open', photos: [], notes: [] });
        return Promise.resolve({ ok: true });
      }),
    },
    attachments: { upload: jest.fn(() => Promise.resolve({ ok: true })) },
    users: {
      list: jest.fn(() => Promise.resolve({ users: [{ id: 10, name: 'Pat Office' }, { id: 12, name: 'Rosa Diaz' }, { id: 14, name: 'Sam Crew' }] })),
    },
  };
  window.p86Auth = { hasCapability: () => true, getUser: () => ({ id: 10 }) };
  window.p86Toast = jest.fn();
  window.p86Confirm = jest.fn(() => Promise.resolve(o.confirm !== false));
  window.p86ConfirmTernary = jest.fn(() => Promise.resolve(o.answer === undefined ? null : o.answer));
  window.alert = jest.fn();
  window.confirm = jest.fn();
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  delete window.p86StExt;
  delete window.p86MoveTicketStatus;
  window.eval(EXT_SRC);
  window.eval(o.editorSrc || EDITOR_SRC);
  window.eval(MOVE_SRC);
  window.eval(o.src || TICKETS_SRC);
  return s;
}

const pane = () => document.getElementById('job-service-tickets');
const head = (id) => pane().querySelector('.p86-st-row[data-ticket="' + id + '"] .p86-st-row-head');
const detail = () => pane().querySelector('.p86-st-row.is-open .p86-st-detail');
const field = (k) => detail().querySelector('[data-st-field="' + k + '"]');
const toasts = () => window.p86Toast.mock.calls.map((c) => c[0]);
function type(el, v) {
  el.value = v;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

async function openTicket(id) {
  window.renderJobServiceTickets('job_77');
  await flush();
  head(id || 'st_1').click();
  await flush();
  return detail();
}

// ── (a) (b) Save ─────────────────────────────────────────────────────────
async function driveSaveDue(opts) {
  env(opts);
  await openTicket();
  type(field('due_date'), '2026-10-01');
  detail().querySelector('.p86-st-save').click();
  await flush();
  return window.p86Api.serviceTickets.update.mock.calls;
}

describe('(a)(b) Save sends only what changed', () => {
  test('(a) only Due changed: the patch is exactly that field and what it was when loaded', async () => {
    const calls = await driveSaveDue();
    expect(calls).toEqual([['st_1', { due_date: '2026-10-01', expected: { due_date: null } }]]);
    expect(toasts()).toContain('Ticket saved');
  });

  test('(b) nothing changed: no request, and the office is told', async () => {
    env();
    await openTicket();
    detail().querySelector('.p86-st-save').click();
    await flush();
    expect(window.p86Api.serviceTickets.update).not.toHaveBeenCalled();
    expect(toasts()).toContain('No changes to save.');
  });

  test('the unsaved note names the changed field', async () => {
    env();
    await openTicket();
    type(field('scope_proposed'), 'Rehang the gate and the latch');
    const note = detail().querySelector('.p86-st-dirty');
    expect(note.hidden).toBe(false);
    expect(note.textContent).toBe('Unsaved: Scope');
  });

  test('FIRES: buildPatch over every field sends unchanged keys too', async () => {
    const broken = mutate(EDITOR_SRC, 'var list = Array.isArray(keys) ? keys : dirtyKeys(root, b);',
      'var list = FIELDS.map(function (f) { return f.key; });');
    const calls = await driveSaveDue({ editorSrc: broken });
    expect(Object.keys(calls[0][1]).length).toBeGreaterThan(2);
  });
});

// ── (c) (d) ticking a building ───────────────────────────────────────────
async function driveTick(opts) {
  const s = env(opts);
  await openTicket();
  type(field('scope_proposed'), 'Typed and not saved');
  const lists = s.lists;
  detail().querySelector('.p86-wo-sub[data-task="tk_1"] .p86-wo-check').click();
  const duringText = detail().textContent;
  await flush();
  return {
    s,
    listRefetched: s.lists > lists,
    loadingShown: /Loading…/.test(duringText) || /Loading…/.test(detail().textContent),
    scope: field('scope_proposed').value,
    cardDone: detail().querySelector('.p86-wo-sub[data-task="tk_1"]').classList.contains('is-done'),
    doneCalls: window.p86Api.serviceTickets.setSubtaskDone.mock.calls,
  };
}

describe('(c)(d) ticking a building updates the ticket in place', () => {
  test('(c) the tick lands, the list is not refetched, nothing blanks, the typed scope stays, the card is done', async () => {
    const r = await driveTick();
    expect(r.doneCalls).toEqual([['st_1', 'tk_1', true]]);
    expect(r.listRefetched).toBe(false);
    expect(r.loadingShown).toBe(false);
    expect(r.scope).toBe('Typed and not saved');
    expect(r.cardDone).toBe(true);
  });

  test('(d) the last building done: the office is told the work order is awaiting approval', async () => {
    await driveTick({ doneResponse: { ok: true, ticket_status: 'work_complete' } });
    expect(toasts()).toContain('Every subtask is done — the work order is awaiting approval.');
  });

  test('a refusal with work_order_locked re-reads the ticket and shows the reason', async () => {
    env();
    await openTicket();
    window.p86Api.serviceTickets.setSubtaskDone = jest.fn(() => Promise.reject(Object.assign(
      new Error('This work order is approved. Reopen it before changing its punch list.'),
      { status: 409, data: { code: 'work_order_locked' } })));
    const gets = window.p86Api.serviceTickets.get.mock.calls.length;
    detail().querySelector('.p86-wo-sub[data-task="tk_1"] .p86-wo-check').click();
    await flush();
    expect(toasts()).toContain('This work order is approved. Reopen it before changing its punch list.');
    expect(window.p86Api.serviceTickets.get.mock.calls.length).toBeGreaterThan(gets);
  });

  test('FIRES: reading res.ticketStatus never tells the office', async () => {
    const broken = mutate(TICKETS_SRC, "res.ticket_status === 'work_complete'", "res.ticketStatus === 'work_complete'");
    await driveTick({ src: broken, doneResponse: { ok: true, ticket_status: 'work_complete' } });
    expect(toasts()).not.toContain('Every subtask is done — the work order is awaiting approval.');
  });

  test('FIRES: the tick reloading the list instead of updating in place refetches it', async () => {
    const broken = mutate(TICKETS_SRC,
      'return updateDetail(d, ctx.ticketId, { anchor: card }).catch(noop);\n      }, function (e) {\n        check.disabled = false;',
      '_state.openId = ctx.ticketId; return reload();\n      }, function (e) {\n        check.disabled = false;');
    const r = await driveTick({ src: broken });
    expect(r.listRefetched).toBe(true);
  });

  test('the shipped file never reads res.ticketStatus', () => {
    expect(TICKETS_SRC).not.toContain('res.ticketStatus');
    expect(TICKETS_SRC).not.toContain('ticketStatus');
  });
});

// ── (e) (f) the unsaved-changes question ─────────────────────────────────
async function driveCollapse(answer, src) {
  env({ answer, src });
  await openTicket();
  type(field('scope_proposed'), 'Typed scope');
  head('st_1').click();
  await flush();
  const asked = window.p86ConfirmTernary.mock.calls.map((c) => c[0]);
  return {
    asked,
    open: !!detail(),
    scope: detail() ? field('scope_proposed').value : null,
    updates: window.p86Api.serviceTickets.update.mock.calls,
  };
}

describe('(e) collapsing a ticket with typed changes asks first', () => {
  test('Keep editing: the question names Scope, and the row stays open with the typing', async () => {
    const r = await driveCollapse(null);
    expect(r.asked).toHaveLength(1);
    expect(r.asked[0].title).toBe('Save your changes first?');
    expect(r.asked[0].message).toBe("You changed Scope and haven't saved.");
    expect(r.asked[0]).toMatchObject({ primaryLabel: 'Save changes', secondaryLabel: 'Discard changes', cancelLabel: 'Keep editing' });
    expect(r.open).toBe(true);
    expect(r.scope).toBe('Typed scope');
  });

  test('Discard changes: it collapses without saving', async () => {
    const r = await driveCollapse('secondary');
    expect(r.open).toBe(false);
    expect(r.updates).toEqual([]);
  });

  test('Save changes: it saves the scope, then collapses', async () => {
    const r = await driveCollapse('primary');
    expect(r.updates).toEqual([['st_1', { scope_proposed: 'Typed scope', expected: { scope_proposed: 'Rehang the gate' } }]]);
    expect(r.open).toBe(false);
  });

  test('FIRES: a row-head click without the question collapses away the typing', async () => {
    const broken = mutate(TICKETS_SRC,
      "leaveOpenTicket().then(function (go) {\n          if (!go) return;\n          if (_state.openId === id)",
      "Promise.resolve(true).then(function (go) {\n          if (!go) return;\n          if (_state.openId === id)");
    const r = await driveCollapse(null, broken);
    expect(r.asked).toHaveLength(0);
    expect(r.open).toBe(false);
  });
});

describe('(f) the same question before every redraw that would lose the typing', () => {
  async function typedThen(act, opts) {
    const s = env(Object.assign({}, opts));
    await openTicket();
    type(field('scope_proposed'), 'Typed scope');
    await act(s);
    await flush();
    return window.p86ConfirmTernary.mock.calls.length;
  }

  test('opening another ticket: asked, and the first stays open', async () => {
    const asked = await typedThen(() => head('st_2').click());
    expect(asked).toBe(1);
    expect(pane().querySelector('.p86-st-row.is-open').getAttribute('data-ticket')).toBe('st_1');
  });

  test('a filter pill: asked, and the filter does not change', async () => {
    const asked = await typedThen(() => pane().querySelector('.p86-st-pill[data-filter="active"]').click());
    expect(asked).toBe(1);
    expect(pane().querySelector('.p86-st-pill.active').getAttribute('data-filter')).toBe('all');
  });

  test('+ New ticket: asked, and no New ticket box', async () => {
    const asked = await typedThen(() => pane().querySelector('.p86-st-new').click());
    expect(asked).toBe(1);
    expect(document.getElementById('p86StCreate')).toBeNull();
  });

  test('Archive: asked, and nothing archived', async () => {
    const asked = await typedThen(() => detail().querySelector('.p86-st-archive').click());
    expect(asked).toBe(1);
    expect(window.p86Api.serviceTickets.archive).not.toHaveBeenCalled();
  });

  test('Accept suggestion: asked, and nothing accepted', async () => {
    const asked = await typedThen(() => detail().querySelector('.p86-st-rev-accept').click(), {
      revisions: [{ id: 'rv_1', status: 'pending', fields: { scope_proposed: 'Their scope' }, author_label: 'Rosa' }],
    });
    expect(asked).toBe(1);
    expect(window.p86Api.serviceTickets.acceptRevision).not.toHaveBeenCalled();
  });

  test('a typed building note alone asks with the discard dialog, in both spellings', async () => {
    env();
    await openTicket();
    detail().querySelector('.p86-wo-sub[data-task="tk_1"] .p86-wo-note-in').value = 'Rail is loose';
    head('st_1').click();
    await flush();
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(window.p86Confirm.mock.calls[0][0]).toMatchObject({
      title: 'Discard unsaved changes?', message: 'Continuing loses the building note you typed.',
      confirmText: 'Discard', destructive: true,
    });
    expect(detail()).toBeNull();
  });
});

// ── (g) adding a building ────────────────────────────────────────────────
describe('(g) adding a building does not ask and keeps the typing', () => {
  test('tasks.create is called, the new card appears, the scope is intact', async () => {
    env();
    await openTicket();
    type(field('scope_proposed'), 'Typed scope');
    detail().querySelector('.p86-st-task-new').value = 'Bldg 800 — Side B: tread 2';
    detail().querySelector('.p86-st-task-go').click();
    await flush();
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(window.p86Api.tasks.create).toHaveBeenCalledWith({
      title: 'Bldg 800 — Side B: tread 2', service_ticket_id: 'st_1', entity_type: 'job', entity_id: 'job_77',
    });
    expect(detail().querySelector('.p86-wo-sub[data-task="tk_new"]')).not.toBeNull();
    expect(detail().querySelectorAll('.p86-wo-sub').length).toBe(3);
    expect(field('scope_proposed').value).toBe('Typed scope');
    expect(detail().querySelector('.p86-st-task-new').value).toBe('');
  });

  test('a building note typed on another card survives the new card', async () => {
    env();
    await openTicket();
    detail().querySelector('.p86-wo-sub[data-task="tk_2"] .p86-wo-note-in').value = 'Stringer cracked';
    detail().querySelector('.p86-st-task-new').value = 'Bldg 801';
    detail().querySelector('.p86-st-task-go').click();
    await flush();
    expect(detail().querySelector('.p86-wo-sub[data-task="tk_2"] .p86-wo-note-in').value).toBe('Stringer cracked');
  });
});

// ── (h) Move to… ─────────────────────────────────────────────────────────
async function driveMove(to, confirmMove, opts) {
  env(opts);
  const after = jest.fn();
  if (confirmMove !== undefined) window.p86StExt.register('test-review', { order: 10, confirmMove, afterStatus: after });
  await openTicket();
  const mv = detail().querySelector('.p86-st-move');
  mv.value = to;
  mv.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  return { calls: window.p86Api.serviceTickets.setStatus.mock.calls, mv, after };
}

describe('(h) Move to… asks the registered module, then moves with expected_status', () => {
  const REASON = { reason: 'Community pulled the work' };

  test('Cancelled: confirmMove is asked and its extra goes with expected_status', async () => {
    const confirmMove = jest.fn((ctx, to) => (to === 'cancelled' ? Promise.resolve(REASON) : undefined));
    const r = await driveMove('cancelled', confirmMove);
    expect(confirmMove).toHaveBeenCalledTimes(1);
    expect(confirmMove.mock.calls[0][0].ticketId).toBe('st_1');
    expect(r.calls).toEqual([['st_1', 'cancelled', { reason: 'Community pulled the work', expected_status: 'open' }]]);
    expect(r.after).toHaveBeenCalledTimes(1);
    expect(r.after.mock.calls[0].slice(2)).toEqual(['open', 'cancelled']);
    // Cancelled is terminal: the ticket is redrawn read-only.
    expect(detail().querySelector('.p86-st-save')).toBeNull();
  });

  test('confirmMove answering null cancels: nothing sent, the select is reset', async () => {
    const r = await driveMove('cancelled', () => Promise.resolve(null));
    expect(r.calls).toEqual([]);
    expect(r.mv.value).toBe('');
    expect(r.mv.disabled).toBe(false);
  });

  test('a forward move with no dialog sends just expected_status', async () => {
    const r = await driveMove('scheduled', () => undefined);
    expect(r.calls).toEqual([['st_1', 'scheduled', { expected_status: 'open' }]]);
  });

  test('a stale screen is told to reload and the ticket is re-read', async () => {
    env();
    window.p86Api.serviceTickets.setStatus = jest.fn(() => Promise.reject(Object.assign(new Error(STALE), { status: 409, data: { code: 'status_changed' } })));
    await openTicket();
    const gets = window.p86Api.serviceTickets.get.mock.calls.length;
    const mv = detail().querySelector('.p86-st-move');
    mv.value = 'scheduled';
    mv.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(toasts()).toContain(STALE);
    expect(window.p86Api.serviceTickets.get.mock.calls.length).toBeGreaterThan(gets);
    expect(detail().querySelector('.p86-st-move').value).toBe('');
  });

  test('FIRES: the move sent without the extra loses the reason', async () => {
    const broken = mutate(TICKETS_SRC, 'window.p86MoveTicketStatus(t, to, body)', 'window.p86MoveTicketStatus(t, to, {})');
    const r = await driveMove('cancelled', () => Promise.resolve(REASON), { src: broken });
    expect(r.calls[0][2]).toEqual({ expected_status: 'open' });
  });
});

// ── (i) (j) refusals ─────────────────────────────────────────────────────
describe('(i) a field the server refuses is highlighted', () => {
  test('400 with field due_date: the box is marked, focused, and the message shown', async () => {
    env();
    window.p86Api.serviceTickets.update = jest.fn(() => Promise.reject(Object.assign(
      new Error('Due date must be a real date (YYYY-MM-DD).'),
      { status: 400, data: { field: 'due_date', error: 'Due date must be a real date (YYYY-MM-DD).' } })));
    await openTicket();
    type(field('due_date'), '2026-02-28');
    detail().querySelector('.p86-st-save').click();
    await flush();
    expect(field('due_date').getAttribute('aria-invalid')).toBe('true');
    expect(document.activeElement).toBe(field('due_date'));
    const err = detail().querySelector('.p86-st-save-err');
    expect(err.hidden).toBe(false);
    expect(err.textContent).toBe('Due date must be a real date (YYYY-MM-DD).');
  });
});

async function driveConflict(editorSrc) {
  env({ editorSrc });
  let first = true;
  window.p86Api.serviceTickets.update = jest.fn(() => {
    if (!first) return Promise.resolve({ ok: true, ticket: Object.assign(TICKETS()[0], { scope_proposed: 'Mine' }), changed: ['scope_proposed'] });
    first = false;
    return Promise.reject(Object.assign(new Error('Someone else changed Scope while you were editing. Nothing was saved.'), {
      status: 409,
      data: { code: 'edit_conflict', fields: ['scope_proposed'], ticket: Object.assign(TICKETS()[0], { scope_proposed: 'X' }) },
    }));
  });
  await openTicket();
  type(field('scope_proposed'), 'Mine');
  detail().querySelector('.p86-st-save').click();
  await flush();
  const box = detail().querySelector('.p86-st-conflict');
  const banner = { hidden: box.hidden, text: box.textContent, scope: field('scope_proposed').value };
  detail().querySelector('.p86-st-save').click();
  await flush();
  return { banner, second: window.p86Api.serviceTickets.update.mock.calls[1] };
}

describe('(j) an edit conflict keeps the typing', () => {
  test('the banner names the field, the box keeps "Mine", and the next Save expects their "X"', async () => {
    const r = await driveConflict();
    expect(r.banner.hidden).toBe(false);
    expect(r.banner.text).toContain('Someone else changed Scope while you were editing.');
    expect(r.banner.scope).toBe('Mine');
    expect(r.second[1]).toEqual({ scope_proposed: 'Mine', expected: { scope_proposed: 'X' } });
  });

  test('"Use their version" puts theirs in the box', async () => {
    env();
    window.p86Api.serviceTickets.update = jest.fn(() => Promise.reject(Object.assign(new Error('conflict'), {
      status: 409,
      data: { code: 'edit_conflict', fields: ['scope_proposed'], ticket: Object.assign(TICKETS()[0], { scope_proposed: 'X' }) },
    })));
    await openTicket();
    type(field('scope_proposed'), 'Mine');
    detail().querySelector('.p86-st-save').click();
    await flush();
    detail().querySelector('.p86-st-conflict-use').click();
    expect(field('scope_proposed').value).toBe('X');
    expect(detail().querySelector('.p86-st-dirty').hidden).toBe(true);
  });

  test('FIRES: a patch without expected cannot carry their value', async () => {
    const broken = mutate(EDITOR_SRC, '    patch.expected = expected;\n', '');
    const r = await driveConflict(broken);
    expect(r.second[1].expected).toBeUndefined();
  });
});

// ── (k) (l) tab return and job switch ────────────────────────────────────
async function driveTabReturn(src) {
  const s = env({ src });
  await openTicket();
  type(field('scope_proposed'), 'Typed scope');
  const lists = s.lists;
  window.renderJobServiceTickets('job_77');
  const blanked = /Loading service tickets/.test(pane().textContent);
  await flush();
  return { blanked, lists: s.lists - lists, scope: detail() ? field('scope_proposed').value : null };
}

describe('(k) coming back to the same job keeps a pane holding edits', () => {
  test('not blanked, not refetched, and the scope is intact', async () => {
    const r = await driveTabReturn();
    expect(r.blanked).toBe(false);
    expect(r.lists).toBe(0);
    expect(r.scope).toBe('Typed scope');
  });

  test('a clean pane is refreshed quietly, with the open ticket kept', async () => {
    const s = env();
    await openTicket();
    const lists = s.lists;
    window.renderJobServiceTickets('job_77');
    expect(pane().textContent).not.toMatch(/Loading service tickets/);
    await flush();
    expect(s.lists).toBe(lists + 1);
    expect(detail()).not.toBeNull();
    expect(detail().textContent).not.toMatch(/Loading…/);
  });

  test('FIRES: without the same-job branch the pane blanks and the typing is gone', async () => {
    const broken = mutate(TICKETS_SRC, "if (_state.jobId === jobId && host.querySelector('.p86-st-wrap')) {", 'if (false) {');
    const r = await driveTabReturn(broken);
    expect(r.blanked).toBe(true);
    expect(r.scope).not.toBe('Typed scope');
  });
});

describe('(l) switching jobs keeps the typing as a draft', () => {
  test('back on the job, the reopened ticket has the typed scope and says so', async () => {
    env();
    await openTicket();
    type(field('scope_proposed'), 'Typed before the switch');
    window.appState.currentJobId = 'job_88';
    window.renderJobServiceTickets('job_88');
    await flush();
    window.appState.currentJobId = 'job_77';
    await openTicket('st_1');
    expect(field('scope_proposed').value).toBe('Typed before the switch');
    const note = detail().querySelector('.p86-st-draftnote');
    expect(note.textContent).toContain('Your unsaved changes to Scope are back in the boxes.');
    expect(detail().querySelector('.p86-st-dirty').textContent).toBe('Unsaved: Scope');
    note.querySelector('.p86-st-draftnote-discard').click();
    expect(field('scope_proposed').value).toBe('Rehang the gate');
  });

  test('a page leave with unsaved typing is stopped by beforeunload', async () => {
    env();
    await openTicket();
    type(field('scope_proposed'), 'Typed');
    const ev = new window.Event('beforeunload', { cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });
});

// ── (m) New ticket ───────────────────────────────────────────────────────
describe('(m) New ticket', () => {
  async function openNew() {
    env();
    window.renderJobServiceTickets('job_77');
    await flush();
    pane().querySelector('.p86-st-new').click();
    await flush();
    return document.getElementById('p86StCreate');
  }

  test('nothing typed: a backdrop click closes it at once', async () => {
    const box = await openNew();
    box.click();
    await flush();
    expect(window.p86Confirm).not.toHaveBeenCalled();
    expect(document.getElementById('p86StCreate')).toBeNull();
  });

  test('a typed title: the backdrop asks "Discard this new ticket?" in both spellings', async () => {
    const box = await openNew();
    box.querySelector('#p86StTitle').value = 'Gate';
    window.p86Confirm = jest.fn(() => Promise.resolve(false));
    box.click();
    await flush();
    expect(window.p86Confirm.mock.calls[0][0]).toMatchObject({
      title: 'Discard this new ticket?', message: 'What you typed will be lost.',
      confirmText: 'Discard', confirmLabel: 'Discard', cancelText: 'Keep editing', destructive: true,
    });
    expect(document.getElementById('p86StCreate')).not.toBeNull();
  });

  test('a blank title is refused in the box; the payload carries due_date and assignee_user_id', async () => {
    const box = await openNew();
    box.querySelector('#p86StCreateGo').click();
    await flush();
    expect(box.querySelector('.p86-st-save-err').textContent).toBe('Give the ticket a title.');
    expect(window.p86Api.serviceTickets.create).not.toHaveBeenCalled();
    const who = box.querySelector('#p86StAssignee');
    expect(Array.from(who.options).map((op) => op.textContent)).toEqual(['Unassigned', 'Pat Office', 'Rosa Diaz']);
    box.querySelector('#p86StTitle').value = 'Gate will not latch';
    box.querySelector('#p86StDue').value = '2026-10-02';
    who.value = '12';
    box.querySelector('#p86StCreateGo').click();
    await flush();
    expect(window.p86Api.serviceTickets.assignees).toHaveBeenCalledWith('job', 'job_77');
    expect(window.p86Api.serviceTickets.create.mock.calls[0][0]).toMatchObject({
      job_id: 'job_77', title: 'Gate will not latch', due_date: '2026-10-02', assignee_user_id: 12,
    });
  });

  test('a server 400 naming a field highlights that box', async () => {
    const box = await openNew();
    window.p86Api.serviceTickets.create = jest.fn(() => Promise.reject(Object.assign(new Error('Priority must be Low, Normal, High or Urgent.'),
      { status: 400, data: { field: 'priority', error: 'Priority must be Low, Normal, High or Urgent.' } })));
    box.querySelector('#p86StTitle').value = 'Gate';
    box.querySelector('#p86StCreateGo').click();
    await flush();
    expect(box.querySelector('.p86-st-modal-prio').getAttribute('aria-invalid')).toBe('true');
  });
});

// ── (n) assignee ─────────────────────────────────────────────────────────
describe('(n) Assigned to, the initials chip and Mine', () => {
  test('the picker lists who can open the job, the row shows initials, Mine counts my open tickets', async () => {
    env();
    await openTicket();
    const sel = field('assignee_user_id');
    expect(Array.from(sel.options).map((op) => op.textContent)).toEqual(['Unassigned', 'Pat Office', 'Rosa Diaz']);
    expect(sel.value).toBe('10');
    const chip = pane().querySelector('.p86-st-row[data-ticket="st_1"] .p86-st-who');
    expect(chip.textContent).toBe('PO');
    expect(chip.getAttribute('title')).toBe('Assigned to Pat Office');
    expect(pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-who')).toBeNull();
    expect(pane().querySelector('.p86-st-pill[data-filter="mine"] .p86-st-pill-n').textContent).toBe('1');
  });

  test('the Mine pill lists only the open ticket assigned to me', async () => {
    env();
    window.renderJobServiceTickets('job_77');
    await flush();
    pane().querySelector('.p86-st-pill[data-filter="mine"]').click();
    await flush();
    expect(Array.from(pane().querySelectorAll('.p86-st-row')).map((r) => r.getAttribute('data-ticket'))).toEqual(['st_1']);
  });
});

// ── (o) scroll ───────────────────────────────────────────────────────────
describe('(o) an in-place update keeps the anchor where it was', () => {
  test("the scroller's scrollTop moves by the anchor card's shift", async () => {
    env();
    await openTicket();
    const scroller = document.getElementById('scroller');
    scroller.style.overflowY = 'auto';
    Object.defineProperty(scroller, 'scrollHeight', { value: 2000, configurable: true });
    Object.defineProperty(scroller, 'clientHeight', { value: 500, configurable: true });
    scroller.scrollTop = 0;
    const original = detail().querySelector('.p86-wo-sub[data-task="tk_1"]');
    const spy = jest.spyOn(window.HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function () {
      const top = this === original ? 100 : (this.getAttribute && this.getAttribute('data-task') === 'tk_1' ? 160 : 0);
      return { top, bottom: top + 40, left: 0, right: 100, width: 100, height: 40 };
    });
    try {
      original.querySelector('.p86-wo-check').click();
      await flush();
    } finally {
      spy.mockRestore();
    }
    expect(detail().querySelector('.p86-wo-sub[data-task="tk_1"]')).not.toBe(original);
    expect(scroller.scrollTop).toBe(60);
  });
});

// ── (p) kept drafts and the page-leave guard ─────────────────────────────
// This module's own beforeunload listener, caught as it registers, so a
// listener left by an earlier test's copy of the module cannot answer.
function envWithLeave(opts) {
  const add = jest.spyOn(window, 'addEventListener');
  let s;
  let calls;
  try {
    s = env(opts);
  } finally {
    // Read before the restore, which clears the recorded calls.
    calls = add.mock.calls.filter((c) => c[0] === 'beforeunload');
    add.mockRestore();
  }
  const handler = calls[calls.length - 1][1];
  const held = () => {
    const ev = { preventDefault: jest.fn(), returnValue: undefined };
    handler(ev);
    return ev.preventDefault.mock.calls.length > 0;
  };
  return { s, held };
}

async function switchAwayAndBack(s, beforeBack) {
  window.appState.currentJobId = 'job_88';
  window.renderJobServiceTickets('job_88');
  await flush();
  if (beforeBack) await beforeBack();
  window.appState.currentJobId = 'job_77';
  window.renderJobServiceTickets('job_77');
  await flush();
}

const CLOSED_TOAST = 'This work order was Closed while you were editing — your changes to Scope were not saved.';

async function driveClosedElsewhere(src) {
  const { s, held } = envWithLeave({ src });
  await openTicket();
  type(field('scope_proposed'), 'Typed scope');
  s.tickets[0].status = 'closed';
  await detail()._st.refresh();
  await flush();
  const r = { toasted: toasts().includes(CLOSED_TOAST), readOnly: field('scope_proposed') === null, heldClosed: held() };
  head('st_1').click();
  await flush();
  r.heldCollapsed = held();
  return Object.assign(r, { s, held });
}

describe('(p) a kept draft holds the page only while it can come back', () => {
  test('closed elsewhere while typing: told, read-only, the page leave is not held; reopened, the typing returns', async () => {
    const r = await driveClosedElsewhere();
    expect(r.toasted).toBe(true);
    expect(r.readOnly).toBe(true);
    expect(r.heldClosed).toBe(false);
    expect(r.heldCollapsed).toBe(false);
    // Reopened elsewhere: once the list says so, the kept draft counts again
    // and comes back in the boxes.
    r.s.tickets[0].status = 'open';
    window.renderJobServiceTickets('job_77');
    await flush();
    expect(r.held()).toBe(true);
    head('st_1').click();
    await flush();
    expect(field('scope_proposed').value).toBe('Typed scope');
    expect(detail().querySelector('.p86-st-draftnote')).not.toBeNull();
  });

  test('archived elsewhere after a job switch: held while away, released once its job list shows it gone', async () => {
    const { s, held } = envWithLeave();
    await openTicket();
    type(field('scope_proposed'), 'Typed before the switch');
    let away;
    await switchAwayAndBack(s, () => {
      away = held();
      s.tickets = s.tickets.filter((t) => t.id !== 'st_1');
    });
    expect(away).toBe(true);
    expect(held()).toBe(false);
  });

  test('FIRES: counting every kept draft holds the page after the ticket was closed', async () => {
    const r = await driveClosedElsewhere(mutate(TICKETS_SRC,
      'if (Object.keys(_state.drafts).some(draftCanReturn)) return true;',
      'if (Object.keys(_state.drafts).length) return true;'));
    expect(r.heldClosed).toBe(true);
    expect(r.heldCollapsed).toBe(true);
  });
});

async function driveDraftNote(act, src) {
  const s = env({ src });
  await openTicket();
  type(field('scope_proposed'), 'Typed before the switch');
  await switchAwayAndBack(s);
  head('st_1').click();
  await flush();
  const shown = !!detail().querySelector('.p86-st-draftnote');
  await act();
  await flush();
  return { shown, after: !!detail().querySelector('.p86-st-draftnote') };
}

describe('(q) the "changes are back" note goes when the changes do', () => {
  const save = () => detail().querySelector('.p86-st-save').click();
  const typeBack = () => type(field('scope_proposed'), 'Rehang the gate');

  test('saved: the note goes', async () => {
    const r = await driveDraftNote(save);
    expect(r).toEqual({ shown: true, after: false });
    expect(toasts()).toContain('Ticket saved');
  });

  test('typed back to what it was: the note goes', async () => {
    expect(await driveDraftNote(typeBack)).toEqual({ shown: true, after: false });
  });

  test('another box typed in: the note stays', async () => {
    const r = await driveDraftNote(() => type(field('due_date'), '2026-10-01'));
    expect(r).toEqual({ shown: true, after: true });
  });

  test('FIRES: without the note check after a save and an update, the note outlives the save', async () => {
    let broken = mutate(TICKETS_SRC, "      syncDraftNote(d);\n      toast('Ticket saved');", "      toast('Ticket saved');");
    broken = mutate(broken, "    syncDraftNote(d);\n    extCollect('afterPaint', d, ctx);", "    extCollect('afterPaint', d, ctx);");
    expect((await driveDraftNote(save, broken)).after).toBe(true);
  });

  test('FIRES: without the note check on input, typing back leaves the note', async () => {
    const broken = mutate(TICKETS_SRC,
      '    ed.showDirty(d, ed.dirtyKeys(d, ctx.base));\n    syncDraftNote(d);\n  }',
      '    ed.showDirty(d, ed.dirtyKeys(d, ctx.base));\n  }');
    expect((await driveDraftNote(typeBack, broken)).after).toBe(true);
  });
});

// ── (r) an anchor redrawn while its update was on the way ────────────────
async function driveLateAnchor(src) {
  const s = env({ src });
  let release;
  window.p86Api.attachments.upload = jest.fn(() => {
    s.tasks.st_1[1].photos.push({ id: 'ph_new', kind: 'completion', thumb_url: '/t/n.jpg' });
    return new Promise((r) => { release = r; });
  });
  await openTicket();
  const kit = window.p86StEditor;
  const real = kit.keepScroll;
  const anchors = [];
  kit.keepScroll = function (anchor, fn, root) {
    // As it is when the kit measures it (the update itself may redraw it).
    anchors.push({
      connected: !!(anchor && anchor.isConnected),
      task: anchor && anchor.getAttribute ? anchor.getAttribute('data-task') : null,
      inDetail: !!(anchor && detail() && detail().contains(anchor)),
    });
    return real.call(this, anchor, fn, root);
  };
  const oldCard = detail().querySelector('.p86-wo-sub[data-task="tk_2"]');
  const inp = oldCard.querySelector('.p86-wo-up:not(.p86-wo-cam) input[data-kind="completion"]');
  Object.defineProperty(inp, 'files', { value: [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' })], configurable: true });
  inp.dispatchEvent(new window.Event('change', { bubbles: true }));
  await flush();
  // Another building ticked meanwhile: its re-read already carries the new
  // photo, so building tk_2's card is redrawn under the upload.
  detail().querySelector('.p86-wo-sub[data-task="tk_1"] .p86-wo-check').click();
  await flush();
  const replaced = !oldCard.isConnected;
  anchors.length = 0;
  release({ ok: true });
  await flush();
  kit.keepScroll = real;
  return { replaced, anchors };
}

describe('(r) the scroll anchor is looked up when the update lands', () => {
  test('the upload finishing after its card was redrawn anchors on the card now on screen', async () => {
    const r = await driveLateAnchor();
    expect(r.replaced).toBe(true);
    expect(r.anchors).toEqual([{ connected: true, task: 'tk_2', inDetail: true }]);
  });

  test('FIRES: the anchor as captured is the detached card', async () => {
    const r = await driveLateAnchor(mutate(TICKETS_SRC, 'ed.keepScroll(anchorNow(d, o.anchor),', 'ed.keepScroll(o.anchor || null,'));
    expect(r.anchors).toEqual([{ connected: false, task: 'tk_2', inDetail: false }]);
  });
});

// ── fallbacks and the upload path ────────────────────────────────────────
describe('without the editor kit, and the photo upload paths', () => {
  test('no editor kit: fields read-only with the refresh note, building cards still editable', async () => {
    env();
    delete window.p86StEditor;
    window.eval(TICKETS_SRC);
    await openTicket();
    expect(detail().querySelector('[data-st-field]')).toBeNull();
    expect(detail().textContent).toContain('Editing is unavailable — refresh the page.');
    expect(detail().querySelectorAll('.p86-wo-sub input[type=file]').length).toBe(8);
  });

  test('with the upload module on the page, a pick is handed to it with onSettled', async () => {
    env();
    const addPhotos = jest.fn();
    window.p86WorkOrderUploads = { addPhotos };
    try {
      await openTicket();
      const inp = detail().querySelector('.p86-wo-sub[data-task="tk_2"] .p86-wo-up:not(.p86-wo-cam) input[data-kind="before"]');
      const file = new window.File(['x'], 'a.jpg', { type: 'image/jpeg' });
      Object.defineProperty(inp, 'files', { value: [file], configurable: true });
      inp.dispatchEvent(new window.Event('change', { bubbles: true }));
      expect(addPhotos).toHaveBeenCalledTimes(1);
      const [card, input, files, opts] = addPhotos.mock.calls[0];
      expect(card.getAttribute('data-task')).toBe('tk_2');
      expect(input).toBe(inp);
      expect(files).toEqual([file]);
      expect(opts).toMatchObject({ ticketId: 'st_1', taskId: 'tk_2', kind: 'before' });
      const gets = window.p86Api.serviceTickets.get.mock.calls.length;
      await opts.onSettled();
      expect(window.p86Api.serviceTickets.get.mock.calls.length).toBe(gets + 1);
    } finally {
      delete window.p86WorkOrderUploads;
    }
  });

  test('without the upload module, a pick uploads one at a time and updates the ticket in place', async () => {
    const s = env();
    await openTicket();
    type(field('scope_proposed'), 'Typed scope');
    const inp = detail().querySelector('.p86-wo-sub[data-task="tk_2"] .p86-wo-up:not(.p86-wo-cam) input[data-kind="completion"]');
    const files = [new window.File(['x'], 'a.jpg', { type: 'image/jpeg' }), new window.File(['y'], 'b.jpg', { type: 'image/jpeg' })];
    Object.defineProperty(inp, 'files', { value: files, configurable: true });
    const lists = s.lists;
    const gets = window.p86Api.serviceTickets.get.mock.calls.length;
    inp.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(window.p86Api.attachments.upload.mock.calls.map((c) => [c[0], c[1], c[2].name, c[3]])).toEqual([
      ['task', 'tk_2', 'a.jpg', { tags: 'completion' }], ['task', 'tk_2', 'b.jpg', { tags: 'completion' }]]);
    expect(window.p86Api.serviceTickets.get.mock.calls.length).toBe(gets + 1);
    expect(s.lists).toBe(lists);
    expect(field('scope_proposed').value).toBe('Typed scope');
  });

  test('a tile tap is remembered on the card for the busy mark', async () => {
    env();
    await openTicket();
    const card = detail().querySelector('.p86-wo-sub[data-task="tk_2"]');
    const spy = jest.spyOn(window.HTMLInputElement.prototype, 'click').mockImplementation(() => {});
    try {
      card.querySelector('.p86-wo-camtile').click();
    } finally {
      spy.mockRestore();
    }
    expect(card._p86LastTap).toBe(card.querySelector('.p86-wo-camtile'));
  });
});
