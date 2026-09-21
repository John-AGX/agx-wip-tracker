/**
 * @jest-environment jsdom
 */
// REPLY ONLY on the office's work order screen (1.50) — js/service-tickets.js.
//
// A line the office marks reply only (tasks.kind 'follow_up': a call, an email,
// a confirmation) is finished without a completion photo. On the work order:
//
//   * its card shows a "Reply only" tag where field work shows "Needs photo",
//     and its tick box is not stopped by the no-photo check;
//   * a switch in the card body turns reply only on or off (PATCH kind
//     follow_up / todo), and puts itself back if the server refuses;
//   * the Add row has a "Reply only" box that creates the line as one, then
//     clears.
//
// The server's rules are in work-order-reply-only.test.js and
// work-order-task-doors.test.js. Driven through the REAL js/service-tickets.js
// (the officeEnv of work-order-uploads.test.js); each piece is then broken on a
// copy of the script and the same drive shows what it is for.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const EXT_SRC = read('js/service-ticket-ext.js');
const QUEUE_SRC = read('js/photo-upload-queue.js');
const UPLOADS_SRC = read('js/work-order-uploads.js');
const EDITOR_SRC = read('js/service-ticket-editor.js');
const MOVE_SRC = read('js/service-ticket-status-move.js');
const TICKETS_SRC = read('js/service-tickets.js');
const JOB_LABEL = require('../js/job-label.js');

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1) throw new Error('anchor not found: ' + from);
  if (src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not unique: ' + from);
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('mutation did not change the source: ' + from);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 8; i++) await tick(); }

// r1 is a reply-only line with no photo; t1 is field work with no photo.
function officeEnv(opts) {
  opts = opts || {};
  document.head.innerHTML = '';
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: 'job_77' };
  // _canEdit false is the job gate js/service-tickets.js canEditJob reads.
  window.appData = { jobs: [{ id: 'job_77', jobNumber: 'RV2008', title: 'Fairways', _canEdit: opts.canEdit !== false }], leads: [] };
  window.p86JobLabel = JOB_LABEL;
  const ticket = { id: 'st_1', ticket_number: 'WO-0012', title: 'Fairways punch list', status: 'in_progress', priority: 'high', job_id: 'job_77', lead_id: null, materials: [] };
  const state = {
    tasks: [
      { id: 'r1', title: 'Reply to the owner confirming receipt', status: 'open', kind: 'follow_up', photos: [], notes: [] },
      { id: 't1', title: '4208 Fairway Run — leak', status: 'open', kind: 'todo', photos: [], notes: [] },
    ],
    updates: [], creates: [], ticks: [],
  };
  const readTicket = () => ({
    ticket: JSON.parse(JSON.stringify(ticket)),
    tasks: JSON.parse(JSON.stringify(state.tasks)),
    events: [], revisions: [], participants: [], site_photos: [],
  });
  window.p86Api = {
    serviceTickets: {
      list: jest.fn(() => Promise.resolve({ tickets: [ticket] })),
      get: jest.fn(() => Promise.resolve(readTicket())),
      materialSources: jest.fn(() => Promise.resolve({ files: [] })),
      assignees: jest.fn(() => Promise.resolve({ users: [] })),
      setSubtaskDone: jest.fn((ticketId, taskId, done) => {
        state.ticks.push([ticketId, taskId, done]);
        const t = state.tasks.find((x) => x.id === taskId);
        t.status = done ? 'done' : 'open';
        return Promise.resolve({ ok: true, ticket_status: 'in_progress' });
      }),
    },
    tasks: {
      update: jest.fn((id, body) => {
        state.updates.push([id, body]);
        if (opts.refuse) return Promise.reject(Object.assign(new Error(opts.refuse), { status: 403 }));
        Object.assign(state.tasks.find((x) => x.id === id), body);
        return Promise.resolve({ task: {} });
      }),
      create: jest.fn((body) => {
        state.creates.push(body);
        state.tasks.push({ id: 'n' + state.creates.length, title: body.title, status: 'open', kind: body.kind || 'todo', photos: [], notes: [] });
        return Promise.resolve({ task: {} });
      }),
    },
    attachments: { upload: jest.fn() },
  };
  window.p86Auth = { hasCapability: () => true };
  window.p86Toast = jest.fn();
  window.p86Attachments = { openLightbox: jest.fn() };
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  for (const g of ['p86StExt', 'p86PhotoQueue', 'p86WorkOrderUploads', 'p86StEditor', 'p86MoveTicketStatus']) delete window[g];
  window.eval(EXT_SRC);
  window.eval(QUEUE_SRC);
  window.eval(UPLOADS_SRC);
  window.eval(EDITOR_SRC);
  window.eval(MOVE_SRC);
  window.eval(opts.src || TICKETS_SRC);
  return state;
}

async function openTicket() {
  window.renderJobServiceTickets('job_77');
  await flush();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-st-detail');
}

const card = (d, id) => d.querySelector('.p86-wo-sub[data-task="' + id + '"]');
const toasts = () => window.p86Toast.mock.calls.map((c) => c[0]);

describe('the line\'s card', () => {
  test('a reply-only line is tagged Reply only, not Needs photo; field work with no photo still says Needs photo', async () => {
    officeEnv();
    const d = await openTicket();
    expect(card(d, 'r1').querySelector('.p86-wo-reply').textContent).toBe('Reply only');
    expect(card(d, 'r1').querySelector('.p86-wo-needs')).toBeNull();
    expect(card(d, 't1').querySelector('.p86-wo-needs').textContent).toBe('Needs photo');
    expect(card(d, 't1').querySelector('.p86-wo-reply')).toBeNull();
  });

  test('its tick box says no photo is needed, and ticking it with no photo sends the tick', async () => {
    const s = officeEnv();
    const d = await openTicket();
    const check = card(d, 'r1').querySelector('.p86-wo-check');
    expect(check.getAttribute('title')).toBe('Mark done — reply only, no photo needed');
    check.click();
    await flush();
    expect(s.ticks).toEqual([['st_1', 'r1', true]]);
    expect(toasts()).not.toContain('Add a completion photo before marking this complete.');
  });

  test('CONTROL: field work with no photo is stopped at the tick box and asks for its photo', async () => {
    const s = officeEnv();
    const d = await openTicket();
    card(d, 't1').querySelector('.p86-wo-check').click();
    await flush();
    expect(s.ticks).toEqual([]);
    expect(toasts()).toContain('Add a completion photo before marking this complete.');
  });

  test('MUTANT: the tick box not asking the kind -> the office cannot tick a reply-only line', async () => {
    const s = officeEnv({ src: mutate(TICKETS_SRC, "if (done && !hasCompletion && task().kind !== 'follow_up') {", 'if (done && !hasCompletion) {') });
    const d = await openTicket();
    card(d, 'r1').querySelector('.p86-wo-check').click();
    await flush();
    expect(s.ticks).toEqual([]);
  });

  test('MUTANT: the card not asking the kind -> the reply-only line says Needs photo', async () => {
    officeEnv({ src: mutate(TICKETS_SRC, "var replyOnly = t.kind === 'follow_up';", 'var replyOnly = false;') });
    const d = await openTicket();
    expect(card(d, 'r1').querySelector('.p86-wo-needs').textContent).toBe('Needs photo');
  });
});

describe('the switch in the card', () => {
  test('it shows the line as it is: on for the reply-only line, off for field work', async () => {
    officeEnv();
    const d = await openTicket();
    expect(card(d, 'r1').querySelector('.p86-wo-replyonly-in').checked).toBe(true);
    expect(card(d, 't1').querySelector('.p86-wo-replyonly-in').checked).toBe(false);
  });

  test('turning it on PATCHes kind follow_up, says so, and the card redraws as reply only', async () => {
    const s = officeEnv();
    const d = await openTicket();
    const sw = card(d, 't1').querySelector('.p86-wo-replyonly-in');
    sw.checked = true;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(s.updates).toEqual([['t1', { kind: 'follow_up' }]]);
    expect(toasts()).toContain('Reply only: this line can be checked off without a photo.');
    expect(card(d, 't1').querySelector('.p86-wo-reply').textContent).toBe('Reply only');
  });

  test('turning it off PATCHes kind todo', async () => {
    const s = officeEnv();
    const d = await openTicket();
    const sw = card(d, 'r1').querySelector('.p86-wo-replyonly-in');
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(s.updates).toEqual([['r1', { kind: 'todo' }]]);
    expect(toasts()).toContain('This line needs a completion photo again.');
  });

  test('a refusal is shown verbatim and the switch goes back to what the line still is', async () => {
    const refusal = 'This line was finished as reply only, with no completion photo. Add a completion photo to it, or reopen it, before it needs one.';
    officeEnv({ refuse: refusal });
    const d = await openTicket();
    const sw = card(d, 'r1').querySelector('.p86-wo-replyonly-in');
    sw.checked = false;
    sw.dispatchEvent(new Event('change', { bubbles: true }));
    await flush();
    expect(window.p86Toast).toHaveBeenCalledWith(refusal, 'error');
    expect(sw.checked).toBe(true);
    expect(sw.disabled).toBe(false);
  });

  test('someone who cannot edit gets no switch at all', async () => {
    officeEnv({ canEdit: false });
    const d = await openTicket();
    expect(d.querySelector('.p86-wo-replyonly-in')).toBeNull();
    expect(card(d, 'r1').querySelector('.p86-wo-reply').textContent).toBe('Reply only');
  });
});

describe('the Add row', () => {
  test('with Reply only ticked the new line is created as one, and the box clears', async () => {
    const s = officeEnv();
    const d = await openTicket();
    d.querySelector('.p86-st-task-new').value = 'Confirm the leak with the owner';
    d.querySelector('.p86-st-task-replyonly').checked = true;
    d.querySelector('.p86-st-task-go').click();
    await flush();
    expect(s.creates).toEqual([{ title: 'Confirm the leak with the owner', service_ticket_id: 'st_1', entity_type: 'job', entity_id: 'job_77', kind: 'follow_up' }]);
    const box = document.querySelector('#job-service-tickets .p86-st-task-replyonly');
    expect(box.checked).toBe(false);
  });

  test('unticked, the line is field work: no kind is sent', async () => {
    const s = officeEnv();
    const d = await openTicket();
    d.querySelector('.p86-st-task-new').value = 'Bldg 4213 — slats';
    d.querySelector('.p86-st-task-go').click();
    await flush();
    expect(s.creates).toHaveLength(1);
    expect(s.creates[0]).not.toHaveProperty('kind');
  });

  test('MUTANT: the box not read -> a reply-only line is created as field work', async () => {
    const s = officeEnv({ src: mutate(TICKETS_SRC, "if (replyBox && replyBox.checked) payload.kind = 'follow_up';", '') });
    const d = await openTicket();
    d.querySelector('.p86-st-task-new').value = 'Confirm the leak with the owner';
    d.querySelector('.p86-st-task-replyonly').checked = true;
    d.querySelector('.p86-st-task-go').click();
    await flush();
    expect(s.creates[0]).not.toHaveProperty('kind');
  });
});
