/**
 * @jest-environment jsdom
 */
// window.p86ServiceTickets.openTicket(jobId, ticketId) — the Work Orders page
// opens a work order on its job's Service Tickets tab (Work Orders 1.29, B5).
//
// Driven through the REAL js/service-tickets.js with a #job-service-tickets
// pane, stubbed p86Api.serviceTickets.list/get, and a p86Router.navigate stub
// that does what the router does for that route: render the job's tab.
//
//   - it navigates to the job's tab, and the ticket opens once the list loads
//   - a filter hiding the ticket is reset to All
//   - a ticket not on the list says so, and nothing opens
//   - the deep link is consumed once
//   - on the job already on screen, a ticket holding typed changes is asked
//     about first (with the real editor kit); Keep editing leaves nothing
//     waiting to open later, Discard opens the ticket asked for
//   - a deep link belongs to its job: another job never opens it or calls it
//     missing
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

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1 || src.indexOf(from, at + from.length) !== -1) throw new Error('anchor not found');
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('anchor not found');
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 10; i++) await tick(); }
const MISSING = "That work order isn't in this job's list. It may have been archived.";

const TICKETS = () => [
  { id: 'st_1', ticket_number: 'WO-1', title: 'Closed one', status: 'closed', priority: 'normal', job_id: 'j1', lead_id: null },
  { id: 'st_2', ticket_number: 'WO-2', title: 'Open one', status: 'open', priority: 'normal', job_id: 'j1', lead_id: null },
];

let scrolled;
function env(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="job-service-tickets"></div>';
  window.appState = { currentJobId: null };
  window.appData = { jobs: [{ id: 'j1', jobNumber: 'RV1', title: 'Job one' }, { id: 'j2', jobNumber: 'RV2', title: 'Job two' }], leads: [] };
  window.p86Api = {
    serviceTickets: {
      list: jest.fn((q) => Promise.resolve({ tickets: TICKETS().filter((t) => t.job_id === q.job_id) })),
      get: jest.fn((id) => Promise.resolve({
        ticket: TICKETS().find((t) => t.id === id), tasks: [], events: [], revisions: [], participants: [],
      })),
      update: jest.fn((id, body) => Promise.resolve({ ok: true, ticket: Object.assign(TICKETS().find((t) => t.id === id), body) })),
      assignees: jest.fn(() => Promise.resolve({ users: [] })),
      shares: jest.fn(() => Promise.resolve({ shares: [] })),
    },
    users: { list: jest.fn(() => Promise.resolve({ users: [] })) },
  };
  window.p86Auth = { hasCapability: () => true, getUser: () => ({ id: 1 }) };
  window.p86Toast = jest.fn();
  window.p86Confirm = jest.fn(() => Promise.resolve(true));
  window.p86ConfirmTernary = jest.fn(() => Promise.resolve(o.answer === undefined ? null : o.answer));
  window.p86Router = {
    navigate: jest.fn((route) => {
      window.appState.currentJobId = route.jobId;
      window.renderJobServiceTickets(route.jobId);
    }),
  };
  delete window.p86StExt;
  delete window.p86StEditor;
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  scrolled = [];
  window.HTMLElement.prototype.scrollIntoView = function (arg) { scrolled.push([this.getAttribute('data-ticket'), arg]); };
  // The editor kit and the registry, as index.html loads them, when a drive
  // needs editable fields and the unsaved-changes question.
  if (o.kit) {
    window.eval(EXT_SRC);
    window.eval(EDITOR_SRC);
  }
  window.eval(o.src || TICKETS_SRC);
}

afterAll(() => { delete window.HTMLElement.prototype.scrollIntoView; });

const pane = () => document.getElementById('job-service-tickets');
const openRows = () => Array.from(pane().querySelectorAll('.p86-st-row.is-open')).map((r) => r.getAttribute('data-ticket'));
const activeFilter = () => {
  const b = pane().querySelector('.p86-st-pill.active');
  return b ? b.getAttribute('data-filter') : null;
};

describe('openTicket opens a work order on its job', () => {
  test('navigates to the job tab, expands the ticket, reads it, and scrolls it into view', async () => {
    env();
    const ok = window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(ok).toBe(true);
    expect(window.p86Router.navigate).toHaveBeenCalledWith({ top: 'jobs', jobId: 'j1', jobSub: 'job-service-tickets' });
    expect(openRows()).toEqual(['st_2']);
    expect(window.p86Api.serviceTickets.get).toHaveBeenCalledWith('st_2');
    expect(scrolled).toEqual([['st_2', { block: 'start' }]]);
    expect(window.p86Toast).not.toHaveBeenCalled();
  });

  test('a filter that hides the ticket is reset to All, and the ticket opens', async () => {
    env();
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    pane().querySelector('.p86-st-pill[data-filter="closed"]').click();
    await flush();
    expect(activeFilter()).toBe('closed');
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(activeFilter()).toBe('all');
    expect(openRows()).toEqual(['st_2']);
  });

  test('a filter that already shows the ticket is kept', async () => {
    env();
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    pane().querySelector('.p86-st-pill[data-filter="closed"]').click();
    await flush();
    window.p86ServiceTickets.openTicket('j1', 'st_1');
    await flush();
    expect(activeFilter()).toBe('closed');
    expect(openRows()).toEqual(['st_1']);
  });

  test('a ticket not on the list says so, and nothing opens', async () => {
    env();
    window.p86ServiceTickets.openTicket('j1', 'st_gone');
    await flush();
    expect(window.p86Toast).toHaveBeenCalledWith(MISSING, 'error');
    expect(openRows()).toEqual([]);
    expect(window.p86Api.serviceTickets.get).not.toHaveBeenCalled();
  });

  test('the deep link is consumed once: after a collapse a second render does not reopen it', async () => {
    env();
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-row-head').click();
    await flush();
    expect(openRows()).toEqual([]);
    window.renderJobServiceTickets('j1');
    await flush();
    expect(openRows()).toEqual([]);
    expect(scrolled).toHaveLength(1);
  });

  test('without a router it opens the job and switches to the tab', async () => {
    jest.useFakeTimers();
    try {
      env();
      delete window.p86Router;
      window.switchTab = jest.fn();
      window.editJob = jest.fn();
      window.switchJobSubTab = jest.fn();
      expect(window.p86ServiceTickets.openTicket('j1', 'st_2')).toBe(true);
      expect(window.switchTab).toHaveBeenCalledWith('jobs');
      expect(window.editJob).toHaveBeenCalledWith('j1');
      jest.advanceTimersByTime(60);
      expect(window.switchJobSubTab).toHaveBeenCalledWith('job-service-tickets');
    } finally {
      jest.useRealTimers();
      delete window.switchTab;
      delete window.editJob;
      delete window.switchJobSubTab;
    }
  });

  test('no job or no ticket: nothing happens', () => {
    env();
    expect(window.p86ServiceTickets.openTicket('', 'st_2')).toBe(false);
    expect(window.p86ServiceTickets.openTicket('j1', '')).toBe(false);
    expect(window.p86Router.navigate).not.toHaveBeenCalled();
  });
});

// ── The job already on screen, and a deep link that belongs to one job ──
const scopeBox = () => pane().querySelector('.p86-st-row.is-open [data-st-field="scope_proposed"]');

// j1 painted, st_2 open with a typed scope, then the Work Orders page asks
// for st_1 on the same job.
async function typedThenOpen(answer, src) {
  env({ kit: true, answer, src });
  window.appState.currentJobId = 'j1';
  window.renderJobServiceTickets('j1');
  await flush();
  pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-row-head').click();
  await flush();
  const box = scopeBox();
  box.value = 'Typed scope';
  box.dispatchEvent(new window.Event('input', { bubbles: true }));
  window.p86ServiceTickets.openTicket('j1', 'st_1');
  await flush();
}

// Keep editing, then the PM discards and collapses, then an unrelated refresh
// of the same job lands: a link left waiting would open st_1 now.
async function keepThenRefresh(src) {
  await typedThenOpen(null, src);
  const r = { asked: window.p86ConfirmTernary.mock.calls.length, open: openRows(), scope: scopeBox() && scopeBox().value };
  window.p86ConfirmTernary = jest.fn(() => Promise.resolve('secondary'));
  pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-row-head').click();
  await flush();
  await window.p86ServiceTickets.refresh();
  await flush();
  r.afterRefresh = openRows();
  return r;
}

describe('openTicket on the job already on screen, with typed changes open', () => {
  test('Keep editing: asked once, the typed ticket stays, and nothing is left to open on a later refresh', async () => {
    const r = await keepThenRefresh();
    expect(r.asked).toBe(1);
    expect(r.open).toEqual(['st_2']);
    expect(r.scope).toBe('Typed scope');
    expect(r.afterRefresh).toEqual([]);
    expect(window.p86Toast).not.toHaveBeenCalledWith(MISSING, 'error');
  });

  test('Keep editing, then another job: no "isn\'t in this job\'s list" toast there', async () => {
    await typedThenOpen(null);
    window.appState.currentJobId = 'j2';
    window.renderJobServiceTickets('j2');
    await flush();
    expect(window.p86Toast).not.toHaveBeenCalledWith(MISSING, 'error');
  });

  test('Discard changes: the asked-for ticket opens and is scrolled to', async () => {
    await typedThenOpen('secondary');
    expect(window.p86ConfirmTernary).toHaveBeenCalledTimes(1);
    expect(openRows()).toEqual(['st_1']);
    expect(scrolled).toContainEqual(['st_1', { block: 'start' }]);
    expect(window.p86Api.serviceTickets.update).not.toHaveBeenCalled();
  });

  test('the ticket asked for is already the open one: no question, it stays open and is scrolled to', async () => {
    env({ kit: true });
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-row-head').click();
    await flush();
    const box = scopeBox();
    box.value = 'Typed scope';
    box.dispatchEvent(new window.Event('input', { bubbles: true }));
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(openRows()).toEqual(['st_2']);
    expect(scopeBox().value).toBe('Typed scope');
    expect(scrolled).toEqual([['st_2', { block: 'start' }]]);
  });

  test('a router that does not draw the tab again still opens the ticket on the pane that is there', async () => {
    env();
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    window.p86Router.navigate = jest.fn();
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(openRows()).toEqual(['st_2']);
  });
});

async function leftWaiting(src) {
  env({ src });
  // Navigation that never draws the tab: the link is left waiting for j1.
  window.p86Router.navigate = jest.fn();
  window.p86ServiceTickets.openTicket('j1', 'st_2');
  await flush();
  window.appState.currentJobId = 'j2';
  window.renderJobServiceTickets('j2');
  await flush();
  const onJ2 = { toasted: window.p86Toast.mock.calls.some((c) => c[0] === MISSING), open: openRows() };
  window.appState.currentJobId = 'j1';
  window.renderJobServiceTickets('j1');
  await flush();
  return { onJ2, onJ1: openRows() };
}

describe('a deep link belongs to its job', () => {
  test('another job neither opens it nor says it is missing, and it is not opened later out of the blue', async () => {
    const r = await leftWaiting();
    expect(r.onJ2).toEqual({ toasted: false, open: [] });
    expect(r.onJ1).toEqual([]);
  });
});

describe('mutation: each rule, broken, turns its drive wrong', () => {
  test('FIRES: a deep link not consumed when the question is asked stays waiting (asked twice, opens on the refresh)', async () => {
    const r = await keepThenRefresh(mutate(TICKETS_SRC,
      '    _deepTicket = null;\n    var kept = keptDetail(host);', '    var kept = keptDetail(host);'));
    expect(r.asked === 1 && r.afterRefresh.length === 0).toBe(false);
  });

  test('FIRES: opening without the question drops the typed scope', async () => {
    await typedThenOpen(null, mutate(TICKETS_SRC,
      '    leaveOpenTicket().then(function (go) {\n      if (!go || String(_state.jobId) !== String(jobId)) return;',
      '    Promise.resolve(true).then(function (go) {\n      if (!go || String(_state.jobId) !== String(jobId)) return;'));
    expect(window.p86ConfirmTernary).not.toHaveBeenCalled();
    expect(openRows()).toEqual(['st_1']);
  });

  test('FIRES: a deep link for any job is consumed by the first list, and says missing on the wrong job', async () => {
    const r = await leftWaiting(mutate(TICKETS_SRC,
      '    return !!_deepTicket && (_deepTicket.jobId == null || String(_deepTicket.jobId) === String(jobId));',
      '    return !!_deepTicket;'));
    expect(r.onJ2.toasted).toBe(true);
  });

  test('FIRES: without the post-navigate open, a router that does not redraw leaves the ticket closed', async () => {
    env({ src: mutate(TICKETS_SRC,
      '      if (deepFor(jobId) && _deepTicket.jobId != null && String(_state.jobId) === String(jobId) &&',
      '      if (false &&') });
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    window.p86Router.navigate = jest.fn();
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(openRows()).toEqual([]);
  });

  test('FIRES: without the filter reset the hidden ticket never opens', async () => {
    env({ src: mutate(TICKETS_SRC, "          if (!matchesFilter(hit)) _state.filter = 'all';\n", '') });
    window.appState.currentJobId = 'j1';
    window.renderJobServiceTickets('j1');
    await flush();
    pane().querySelector('.p86-st-pill[data-filter="closed"]').click();
    await flush();
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(openRows()).toEqual([]);
  });

  test('FIRES: without the missing-ticket branch nobody is told', async () => {
    env({ src: mutate(TICKETS_SRC,
      "          toast(\"That work order isn't in this job's list. It may have been archived.\", 'error');\n", '') });
    window.p86ServiceTickets.openTicket('j1', 'st_gone');
    await flush();
    expect(window.p86Toast).not.toHaveBeenCalled();
  });

  test('FIRES: a deep link that is not cleared reopens the ticket on every render', async () => {
    env({ src: mutate(TICKETS_SRC, '        _deepTicket = null;\n        var hit = ticketRow(want);', '        var hit = ticketRow(want);') });
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    pane().querySelector('.p86-st-row[data-ticket="st_2"] .p86-st-row-head').click();
    await flush();
    window.renderJobServiceTickets('j1');
    await flush();
    expect(openRows()).toEqual(['st_2']);
  });

  test('FIRES: without scrollToOpen the opened row is not scrolled to', async () => {
    env({ src: mutate(TICKETS_SRC, '          _state.scrollToOpen = true;\n', '') });
    window.p86ServiceTickets.openTicket('j1', 'st_2');
    await flush();
    expect(openRows()).toEqual(['st_2']);
    expect(scrolled).toEqual([]);
  });
});
