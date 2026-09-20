/**
 * @jest-environment jsdom
 */
// THE SERVICE TICKETS PAGE, IN A BROWSER.
//
// js/work-orders-board.js (sidebar → Operations → Service Tickets) is loaded
// into jsdom with its collaborators stubbed
// (p86Api.serviceTickets.list, p86ServiceTickets.openTicket, p86Router.go,
// p86Toast) and driven the way a person would: render, click a view, type in
// the search, click a row, come back to the tab. What is pinned:
//   * the exact request each action sends, and the view and sort kept in
//     localStorage (the 1.29 page's key, p86_stp_filters);
//   * a late response from a previous view never paints over the current one;
//   * days late come from the server's "today", not this browser's clock;
//   * rows are real links, a plain click opens in the app (or falls back to the
//     link), a modified click is the browser's;
//   * Show more appends; a failed quiet refresh keeps the rows; a failed first
//     load offers Try again;
//   * everything interpolated is escaped, and nothing off the whitelist
//     reaches the page.
// test/service-tickets-page.test.js drives what the 1.29 page brought to it:
// the status pills, priority, jobs or leads, remembered filters, focus, the
// real job tab and the wiring.
// Mutants at the end break one guard in a copy of the source and show the
// same drive fail.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'work-orders-board.js'), 'utf8').replace(/\r\n/g, '\n');
const JOB_LABEL = require('../js/job-label.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 6; i++) await tick(); }
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function mutate(src, from, to) {
  if (src.split(from).length !== 2) throw new Error('anchor not found');
  const out = src.split(from).join(to);
  if (out === src) throw new Error('anchor not found');
  return out;
}

function row(over) {
  return Object.assign({
    id: 'st_1', ticket_number: 'WO-0001', title: 'Rehang the gate', job_id: 'j1', lead_id: null,
    status: 'in_progress', priority: 'normal', scheduled_for: null, due_date: null,
    assignee_user_id: null, assignee_name: null, completed_at: null, closed_at: null,
    created_at: '2026-09-01T10:00:00.000Z', updated_at: '2026-09-02T10:00:00.000Z',
    street_address: null, city: null, job_number: 'RV2001', job_title: 'Waterside 1', lead_title: null,
    task_total: 0, task_done: 0, pending_suggestions: 0, links_total: 1, links_live: 1, links_opened: 0,
    last_crew_at: null, open_flags: 0, office_seen_at: null, new_from_crew: false, is_overdue: false,
  }, over || {});
}

const COUNTS = { open: 12, my_approvals: 2, overdue: 3, due_week: 4, mine: 1, unassigned: 5, no_link: 6, flagged: 0, suggestions: 7 };
const STATUS_COUNTS = { all: 20, active: 12, draft: 1, scheduled: 2, in_progress: 5, awaiting_approval: 4, closed: 8 };
const FIRST = { board: 1, view: 'all', sort: 'created', limit: 50, offset: 0, include_counts: 1 };

let calls;
let myCalls;
let responder;
let host;

function boot(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="service-tickets" class="tab-content active"><div id="serviceTicketsHost"></div></div>';
  host = document.getElementById('serviceTicketsHost');
  window.localStorage.clear();
  if (o.storedView) window.localStorage.setItem('p86_stp_filters', JSON.stringify({ view: o.storedView }));
  window.history.replaceState({}, '', o.url || '/service-tickets');
  window.appData = { jobs: [{ id: 'j1', jobNumber: 'RV2001', title: 'Waterside 1' }] };
  window.p86JobLabel = JOB_LABEL;
  calls = [];
  responder = o.responder || (() => Promise.resolve({ tickets: [row()], today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS, status_counts: STATUS_COUNTS }));
  // 1.33: the page also holds GET /api/service-tickets/my-buildings for its
  // client-only My work view, and fires a count_only call beside every reset
  // load. This file never presses My work — test/work-orders-board-my-work.js
  // does — so the default body carries no total and the My work pill shows no
  // number, leaving every assertion below about the board door alone.
  myCalls = [];
  window.p86Api = {
    serviceTickets: {
      list: jest.fn((p) => { calls.push(Object.assign({}, p)); return responder(p, calls.length); }),
      myBuildings: jest.fn((p) => { myCalls.push(Object.assign({}, p)); return Promise.resolve({}); }),
    },
  };
  window.p86ServiceTickets = o.noOpenTicket ? { refresh: () => {} } : { openTicket: jest.fn(() => true) };
  window.p86Router = { go: jest.fn(() => true) };
  window.p86Toast = jest.fn();
  window.openEditLeadModal = undefined;
  window.eval(o.src || SRC);
  window.p86WorkOrdersBoard._assign = jest.fn();
  return window.p86WorkOrdersBoard;
}

const pill = (id) => host.querySelector('.p86-wob-views [data-view="' + id + '"]');
const statusPill = (id) => host.querySelector('.p86-wob-status [data-status="' + id + '"]');
const rowsIn = () => Array.from(host.querySelectorAll('a.p86-wob-row')).map((a) => a.getAttribute('data-id'));

function click(el, init) {
  const ev = new window.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true, button: 0 }, init || {}));
  el.dispatchEvent(ev);
  return ev;
}

// jsdom cannot navigate; a link whose default was not prevented would try. A
// last listener on the document records the verdict and then stops it.
let seenDefault;
beforeEach(() => {
  seenDefault = [];
  document.addEventListener('click', stopNav);
});
afterEach(() => {
  document.removeEventListener('click', stopNav);
  jest.useRealTimers();
});
function stopNav(e) { seenDefault.push(e.defaultPrevented); e.preventDefault(); }

describe('requests, views and counts', () => {
  test('the first render asks for every ticket, newest first, with counts, and the pills show them', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    expect(calls[0]).toEqual(FIRST);
    expect(pill('overdue').textContent).toBe('Overdue 3');
    // No view is on until one is pressed; the status is All.
    expect(host.querySelectorAll('.p86-wob-views [aria-pressed="true"]')).toHaveLength(0);
    expect(statusPill('all').getAttribute('aria-pressed')).toBe('true');
    expect(statusPill('all').classList.contains('active')).toBe(true);
    expect(statusPill('work_complete').textContent).toBe('Awaiting approval 4');
    // All open and Closed are the status pills' job now, not views.
    expect(pill('open')).toBeNull();
    expect(pill('closed')).toBeNull();
    expect(pill('my_approvals').getAttribute('title')).toBe('Work complete and waiting for you: jobs you run, or tickets you raised, are assigned or sent the crew link for');
    expect(host.querySelector('.p86-wob-total').textContent).toBe('1 ticket');
    expect(host.querySelector('.p86-wob-total').getAttribute('aria-live')).toBe('polite');
    expect(host.querySelector('h2').textContent).toBe('Service Tickets');
    expect(host.querySelector('.p86-wob-search').getAttribute('placeholder')).toBe('Search title, job, lead, assignee, WO # or address');
    expect(Array.from(host.querySelectorAll('.p86-wob-sort option')).map((x) => x.textContent))
      .toEqual(['Newest', 'Due date', 'Priority', 'Scheduled date', 'Recently updated']);
  });

  test('clicking Overdue asks for it and remembers it', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    click(pill('overdue'));
    await flush();
    expect(calls[1]).toEqual(Object.assign({}, FIRST, { view: 'overdue' }));
    expect(JSON.parse(window.localStorage.getItem('p86_stp_filters')).view).toBe('overdue');
    expect(pill('overdue').getAttribute('aria-pressed')).toBe('true');
  });

  test('a stored view that no longer exists falls back to no view; a stored real one is used', async () => {
    let b = boot({ storedView: 'bogus' });
    await b.render(host);
    expect(calls[0].view).toBe('all');
    b = boot({ storedView: 'flagged' });
    await b.render(host);
    expect(calls[0].view).toBe('flagged');
    // 1.33: my_work is a real id now, so it survives readSaved — but it is a
    // CLIENT-only view, so the page must go to my-buildings, not this door.
    b = boot({ storedView: 'my_work' });
    await b.render(host);
    await flush();
    expect(calls).toHaveLength(0);
    expect(myCalls).toContainEqual({ limit: 50, offset: 0 });
  });

  test('the board door is the default: My work is a pill, not the first request', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    expect(calls[0]).toEqual(FIRST);
    expect(pill('my_work')).not.toBeNull();
    expect(pill('my_work').getAttribute('aria-pressed')).toBe('false');
    // An empty count body leaves the pill with no number and nothing broken.
    expect(pill('my_work').textContent).toBe('My work');
    expect(myCalls).toEqual([{ count_only: 1 }]);
  });

  test('?view= on a full load of /work-orders wins over the stored view', async () => {
    const b = boot({ storedView: 'flagged', url: '/work-orders?view=my_approvals' });
    await b.render(host);
    expect(calls[0].view).toBe('my_approvals');
  });

  test('sort changes ask again from the top, and are remembered', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    const sel = host.querySelector('.p86-wob-sort');
    sel.value = 'priority';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    await flush();
    expect(calls[1]).toEqual(Object.assign({}, FIRST, { sort: 'priority' }));
    expect(JSON.parse(window.localStorage.getItem('p86_stp_filters')).sort).toBe('priority');
  });

  test('search is debounced, and a search with no match says so', async () => {
    const b = boot({ responder: (p) => Promise.resolve({ tickets: p.q ? [] : [row()], today: '2026-09-19', has_more: false, next_offset: null, total: p.q ? 0 : 1, counts: COUNTS }) });
    await b.render(host);
    await flush();
    const input = host.querySelector('.p86-wob-search');
    input.value = 'Map';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    input.value = 'Maple';
    input.dispatchEvent(new window.Event('input', { bubbles: true }));
    await wait(100);
    expect(calls).toHaveLength(1);
    await wait(300);
    await flush();
    expect(calls).toHaveLength(2);
    expect(calls[1]).toEqual(Object.assign({}, FIRST, { q: 'Maple' }));
    expect(host.querySelector('.p86-wob-list').textContent).toBe('No tickets match “Maple”.');
    click(pill('overdue'));
    await flush();
    expect(host.querySelector('.p86-wob-list').textContent).toBe('No tickets match “Maple” in Overdue.');
  });

  test('a late response from the previous view is dropped', async () => {
    const pending = [];
    const b = boot({ responder: () => new Promise((resolve) => pending.push(resolve)) });
    b.render(host);
    await flush();
    click(pill('overdue'));
    await flush();
    expect(pending).toHaveLength(2);
    pending[1]({ tickets: [row({ id: 'st_B', title: 'B view' })], today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS });
    await flush();
    pending[0]({ tickets: [row({ id: 'st_A', title: 'A view' })], today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS });
    await flush();
    expect(rowsIn()).toEqual(['st_B']);
  });

  test('a caller who can see nothing: the empty state and no count badges', async () => {
    const b = boot({ responder: () => Promise.resolve({ tickets: [] }) });
    await b.render(host);
    await flush();
    expect(host.querySelector('.p86-wob-list').textContent).toBe("No service tickets yet. Raise one from a job's Service Tickets tab or from a lead.");
    expect(host.querySelectorAll('.p86-st-pill-n')).toHaveLength(0);
    expect(host.querySelector('.p86-wob-foot').innerHTML).toBe('');
  });
});

describe('what a row says', () => {
  test('days late come from the server\'s today, not this browser\'s clock', async () => {
    jest.useFakeTimers({ now: new Date('2027-03-01T12:00:00Z'), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick'] });
    const b = boot({
      responder: () => Promise.resolve({
        today: '2026-09-19', has_more: false, next_offset: null, total: 3, counts: COUNTS,
        tickets: [
          row({ id: 'late', due_date: '2026-09-16', is_overdue: true }),
          row({ id: 'late_pg', due_date: '2026-09-18T00:00:00.000Z', is_overdue: true }),
          row({ id: 'today', due_date: '2026-09-19', status: 'open' }),
          row({ id: 'wc_today', due_date: '2026-09-19', status: 'work_complete' }),
        ],
      }),
    });
    await b.render(host);
    await flush();
    const due = (id) => host.querySelector('a[data-id="' + id + '"] .p86-wob-c-due');
    expect(due('late').textContent).toMatch(/Sep 16, 2026 · 3 days late$/);
    expect(due('late').classList.contains('is-late')).toBe(true);
    expect(due('late_pg').textContent).toMatch(/Sep 18, 2026 · 1 day late$/);
    expect(due('today').textContent).toBe('DueDue today');
    expect(due('today').classList.contains('is-today')).toBe(true);
    expect(due('wc_today').classList.contains('is-today')).toBe(false);
  });

  test('labels, buildings, assignee and the crew chips', async () => {
    const b = boot({
      responder: () => Promise.resolve({
        today: '2026-09-19', has_more: false, next_offset: null, total: 5, counts: COUNTS,
        tickets: [
          row({ id: 'a', links_total: 0, links_live: 0, task_total: 8, task_done: 3, assignee_name: 'Carl Crew', open_flags: 2, pending_suggestions: 1 }),
          row({ id: 'b', links_total: 2, links_live: 0, job_number: null, job_title: null }),
          row({ id: 'c', links_live: 1, links_opened: 1, new_from_crew: true, last_crew_at: new Date(Date.now() - 5 * 60000).toISOString() }),
          row({ id: 'd', status: 'closed', links_total: 0, open_flags: 1 }),
          row({ id: 'l', job_id: null, lead_id: 'l1', lead_title: 'Maple St reroof', ticket_number: null }),
        ],
      }),
    });
    await b.render(host);
    await flush();
    const cell = (id, c) => host.querySelector('a[data-id="' + id + '"] .p86-wob-c-' + c);
    expect(cell('a', 'crew').textContent).toBe('CrewNo crew link1 suggestion2 problems flagged');
    expect(cell('a', 'crew').querySelector('.is-warn').textContent).toBe('No crew link');
    expect(cell('a', 'crew').querySelector('.is-alert').textContent).toBe('2 problems flagged');
    expect(cell('a', 'bldg').querySelector('.p86-wob-bldg-d').textContent).toBe('3/8');
    expect(cell('a', 'bldg').querySelector('.p86-wob-bldg-m').textContent).toBe('3 of 8 buildings');
    expect(cell('a', 'assignee').textContent).toBe('AssigneeCarl Crew');
    expect(cell('b', 'assignee').textContent).toBe('AssigneeUnassigned');
    expect(cell('b', 'crew').querySelector('.p86-wob-chip').textContent).toBe('Link off');
    expect(cell('b', 'crew').querySelector('.p86-wob-chip').getAttribute('title')).toBe('Every link on this work order was turned off or has expired');
    // No label on the row: the loaded job record names it.
    expect(host.querySelector('a[data-id="b"] .p86-wob-job').textContent).toBe('RV2001 Waterside 1');
    expect(cell('c', 'crew').textContent).toBe('CrewLink openedNew from crewCrew 5 min ago');
    expect(cell('d', 'crew').textContent).toBe('Crew');
    expect(cell('a', 'status').textContent).toBe('StatusIn progress');
    expect(host.querySelector('a[data-id="l"] .p86-wob-job').textContent).toBe('Lead · Maple St reroof');
    expect(host.querySelector('a[data-id="a"]').getAttribute('aria-label')).toBe('Rehang the gate, RV2001 Waterside 1, In progress, no due date');
    expect(host.querySelector('.p86-wob-foot').textContent).toBe('Showing 5 of 5');
  });

  test('an interpolated title is text, and a column off the whitelist never reaches the page', async () => {
    const b = boot({
      responder: () => Promise.resolve({
        today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS,
        tickets: [row({ title: '<img src=x onerror=alert(1)>', assignee_name: '"><b>x</b>', scope_approved: '$48,000', internal_notes: 'OFFICE ONLY' })],
      }),
    });
    await b.render(host);
    await flush();
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.p86-wob-list b')).toBeNull();
    expect(host.querySelector('.p86-wob-title').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(host.innerHTML).not.toContain('48,000');
    expect(host.innerHTML).not.toContain('OFFICE ONLY');
    // The rows the page keeps (and every later paint and click reads) carry
    // the whitelist and nothing else, a missing key as null.
    const kept = b._rows();
    expect(kept).toHaveLength(1);
    expect(Object.keys(kept[0])).toEqual(Object.keys(row()));
    expect(JSON.stringify(kept)).not.toMatch(/48,000|OFFICE ONLY|scope_approved|internal_notes/);
  });

  test('a row missing keys is filled with nulls, and a Show more page is whitelisted too', async () => {
    const b = boot({
      responder: (_p, n) => Promise.resolve(n === 1
        ? { today: '2026-09-19', has_more: true, next_offset: 1, total: 2, counts: COUNTS, tickets: [{ id: 'bare', title: 'Bare' }] }
        : { today: '2026-09-19', has_more: false, next_offset: null, tickets: [row({ id: 'two', crew_takeoff: '{"x":1}' })] }),
    });
    await b.render(host);
    await flush();
    expect(b._rows()[0]).toEqual(Object.assign(Object.fromEntries(Object.keys(row()).map((k) => [k, null])), { id: 'bare', title: 'Bare' }));
    click(host.querySelector('.p86-wob-more'));
    await flush();
    expect(b._rows().map((r) => r.id)).toEqual(['bare', 'two']);
    expect(b._rows()[1]).not.toHaveProperty('crew_takeoff');
  });
});

describe('opening a row', () => {
  const ROWS = () => Promise.resolve({
    today: '2026-09-19', has_more: false, next_offset: null, total: 3, counts: COUNTS,
    tickets: [
      row({ id: 'st_1', job_id: 'j1' }),
      row({ id: 'st_lead', job_id: null, lead_id: 'l1', lead_title: 'Maple' }),
      row({ id: 'st_far', job_id: 'j7' }),
    ],
  });
  const a = (id) => host.querySelector('a[data-id="' + id + '"]');

  test('rows are links with the job and lead shapes', async () => {
    const b = boot({ responder: ROWS });
    await b.render(host);
    await flush();
    expect(a('st_1').getAttribute('href')).toBe('/jobs/j1/job-service-tickets?ticket=st_1');
    expect(a('st_lead').getAttribute('href')).toBe('/leads/l1');
  });

  test('a plain click opens the ticket in the app, a ctrl-click is left to the browser', async () => {
    const b = boot({ responder: ROWS });
    await b.render(host);
    await flush();
    click(a('st_1').querySelector('.p86-wob-title'));
    expect(seenDefault.pop()).toBe(true);
    expect(window.p86ServiceTickets.openTicket).toHaveBeenCalledWith('j1', 'st_1');
    for (const mod of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { button: 1 }]) {
      window.p86ServiceTickets.openTicket.mockClear();
      click(a('st_1'), mod);
      expect([mod, seenDefault.pop()]).toEqual([mod, false]);
      expect(window.p86ServiceTickets.openTicket).not.toHaveBeenCalled();
    }
  });

  test('a lead row goes through the router', async () => {
    const b = boot({ responder: ROWS });
    await b.render(host);
    await flush();
    click(a('st_lead'));
    expect(window.p86Router.go).toHaveBeenCalledWith('/leads/l1');
    expect(b._assign).not.toHaveBeenCalled();
  });

  test('a job that is not loaded, or no openTicket at all, is a full load of the link', async () => {
    let b = boot({ responder: ROWS });
    await b.render(host);
    await flush();
    click(a('st_far'));
    expect(b._assign).toHaveBeenCalledWith('/jobs/j7/job-service-tickets?ticket=st_far');
    expect(window.p86ServiceTickets.openTicket).not.toHaveBeenCalled();

    b = boot({ responder: ROWS, noOpenTicket: true });
    await b.render(host);
    await flush();
    click(a('st_1'));
    expect(seenDefault.pop()).toBe(true);
    expect(b._assign).toHaveBeenCalledWith('/jobs/j1/job-service-tickets?ticket=st_1');
  });
});

describe('paging, refresh and failure', () => {
  test('Show more asks for the next offset without counts and appends', async () => {
    const b = boot({
      responder: (p) => Promise.resolve(p.offset === 0
        ? { tickets: [row({ id: 'p1' }), row({ id: 'p2' })], today: '2026-09-19', has_more: true, next_offset: 50, total: 3, counts: COUNTS }
        : { tickets: [row({ id: 'p3' })], today: '2026-09-19', has_more: false, next_offset: null }),
    });
    await b.render(host);
    await flush();
    expect(host.querySelector('.p86-wob-foot').textContent).toBe('Showing 2 of 3Show more');
    click(host.querySelector('.p86-wob-more'));
    await flush();
    expect(calls[1]).toEqual({ board: 1, view: 'all', sort: 'created', limit: 50, offset: 50 });
    expect(rowsIn()).toEqual(['p1', 'p2', 'p3']);
    expect(host.querySelector('.p86-wob-more')).toBeNull();
    expect(pill('overdue').textContent).toBe('Overdue 3');
  });

  test('a failed quiet refresh keeps the rows and says so', async () => {
    let fail = false;
    const b = boot({ responder: () => (fail ? Promise.reject(new Error('offline')) : Promise.resolve({ tickets: [row()], today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS })) });
    await b.render(host);
    await flush();
    fail = true;
    await b.refresh();
    await flush();
    expect(calls[1]).toEqual(FIRST);
    expect(rowsIn()).toEqual(['st_1']);
    expect(window.p86Toast).toHaveBeenCalledWith("Couldn't refresh service tickets — showing what was loaded before.", 'error');
  });

  test('a failed first load offers Try again, and Try again loads', async () => {
    let fail = true;
    const b = boot({ responder: () => (fail ? Promise.reject(new Error('down')) : Promise.resolve({ tickets: [row()], today: '2026-09-19', has_more: false, next_offset: null, total: 1, counts: COUNTS })) });
    await b.render(host);
    await flush();
    expect(host.querySelector('.p86-wob-error').textContent).toBe("Couldn't load service tickets. Try again");
    fail = false;
    click(host.querySelector('.p86-wob-retry'));
    await flush();
    expect(rowsIn()).toEqual(['st_1']);
  });

  test('refresh off screen only marks stale; coming back paints what was loaded, then refetches quietly', async () => {
    const pending = [];
    const b = boot({ responder: () => new Promise((resolve) => pending.push(resolve)) });
    b.render(host);
    await flush();
    const many = [];
    for (let i = 0; i < 60; i++) many.push(row({ id: 'm' + i }));
    pending[0]({ tickets: many, today: '2026-09-19', has_more: true, next_offset: 60, total: 70, counts: COUNTS });
    await flush();
    document.getElementById('service-tickets').classList.remove('active');
    await b.refresh();
    expect(calls).toHaveLength(1);
    document.getElementById('service-tickets').classList.add('active');
    b.render(host);
    // Painted from what was loaded before the refetch answers.
    expect(rowsIn()).toHaveLength(60);
    expect(calls[1]).toEqual(Object.assign({}, FIRST, { limit: 60 }));
  });

  test('js/refresh.js sends a service_ticket write to this page as well as the job tab', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    window.p86ServiceTickets.refresh = jest.fn();
    const spy = jest.spyOn(b, 'refresh');
    window.eval(fs.readFileSync(path.join(__dirname, '..', 'js', 'refresh.js'), 'utf8'));
    await window.p86Refresh.now('service_ticket', { id: 'st_1' });
    await flush();
    expect(window.p86ServiceTickets.refresh).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('mutants', () => {
  test('the harness refuses an anchor that is not in the source', () => {
    expect(() => mutate(SRC, 'nowhere in the board client', 'x')).toThrow('anchor not found');
  });

  test('without the sequence guard, the late response paints over the current view', async () => {
    const src = mutate(SRC, '      if (my !== _state.seq) return;\n      var body = res || {};', '      var body = res || {};');
    const pending = [];
    const b = boot({ src, responder: () => new Promise((resolve) => pending.push(resolve)) });
    b.render(host);
    await flush();
    click(pill('overdue'));
    await flush();
    pending[1]({ tickets: [row({ id: 'st_B' })], today: '2026-09-19' });
    await flush();
    pending[0]({ tickets: [row({ id: 'st_A' })], today: '2026-09-19' });
    await flush();
    expect(rowsIn()).toEqual(['st_A']);
  });

  test('without the row whitelist, an office-only column is kept on the page', async () => {
    const src = mutate(SRC, 'body.tickets.map(mine ? pickMyWork : pick)', 'body.tickets.slice()');
    const b = boot({ src, responder: () => Promise.resolve({ tickets: [row({ scope_approved: '$48,000', internal_notes: 'OFFICE ONLY' })], today: '2026-09-19' }) });
    await b.render(host);
    await flush();
    expect(b._rows()[0]).toHaveProperty('scope_approved', '$48,000');
    expect(Object.keys(b._rows()[0])).not.toEqual(Object.keys(row()));
  });

  test('without escaping the title, the planted tag becomes an element', async () => {
    const src = mutate(SRC, "'<span class=\"p86-wob-title\">' + esc(title)", "'<span class=\"p86-wob-title\">' + title");
    const b = boot({ src, responder: () => Promise.resolve({ tickets: [row({ title: '<img src=x>' })], today: '2026-09-19' }) });
    await b.render(host);
    await flush();
    expect(host.querySelector('img')).not.toBeNull();
  });

  test('days late from the browser clock are wrong at another date', async () => {
    const src = mutate(SRC, 'var late = daysBetween(r.due_date, _state.today);', "var late = daysBetween(r.due_date, new Date().toISOString().slice(0, 10));");
    jest.useFakeTimers({ now: new Date('2026-09-25T12:00:00Z'), doNotFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'setImmediate', 'clearImmediate', 'queueMicrotask', 'nextTick'] });
    const b = boot({ src, responder: () => Promise.resolve({ tickets: [row({ due_date: '2026-09-16', is_overdue: true })], today: '2026-09-19' }) });
    await b.render(host);
    await flush();
    expect(host.querySelector('.p86-wob-c-due').textContent).not.toMatch(/3 days late$/);
  });

  test('without the modifier check, a ctrl-click is hijacked', async () => {
    const src = mutate(SRC, '        if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;\n', '');
    const b = boot({ src });
    await b.render(host);
    await flush();
    click(host.querySelector('a.p86-wob-row'), { ctrlKey: true });
    expect(seenDefault.pop()).toBe(true);
    expect(window.p86ServiceTickets.openTicket).toHaveBeenCalled();
  });

  test('without the loaded-job check, a job this browser has not loaded is opened in the app and lands nowhere', async () => {
    const src = mutate(SRC, "if (loadedJob(r.job_id) && st && typeof st.openTicket === 'function') {", "if (st && typeof st.openTicket === 'function') {");
    const b = boot({ src, responder: () => Promise.resolve({ tickets: [row({ id: 'st_far', job_id: 'j7' })], today: '2026-09-19' }) });
    await b.render(host);
    await flush();
    click(host.querySelector('a.p86-wob-row'));
    expect(window.p86ServiceTickets.openTicket).toHaveBeenCalledWith('j7', 'st_far');
    expect(b._assign).not.toHaveBeenCalled();
  });
});
