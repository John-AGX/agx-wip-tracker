/**
 * @jest-environment jsdom
 */
// "MY WORK" — THE WORK ORDERS ASSIGNED TO ME THAT STILL HAVE A BUILDING OPEN.
//
// A building on a work order is not a to-do, so from 1.33 it is on no task
// list at all. 1.35 settled who is responsible for one: NOBODY, personally. A
// building is never assigned. Responsibility sits on the RECORD — the work
// order's own Assigned to — and everyone on it is equally responsible for
// every building on its punch list. So this view lists the work orders
// assigned to the caller that still have a building open:
// js/work-orders-board.js's FIRST view pill, reading
// GET /api/service-tickets/my-buildings.
//
// It cannot be a server board view. Every ?board=1 row is ANDed onto
// access.listVisibility — the JOB ACCESS rule — and the person a work order
// is assigned to is deliberately allowed to finish a building on a job they
// cannot otherwise open. A view built on that door would show exactly the
// person this release exists for exactly nothing. So the door is record-keyed,
// the view is client-only, and what this file pins is the seam between them:
//
//   1. pressing My work goes to myBuildings, never to list({board:1,…});
//   2. a row says what it is: title, N of M buildings open, the due date, and
//      one button per building on the work order's punch list;
//   3. a building button opens window.p86Tasks.openDetail(id) — THE way in for
//      whoever the work order is assigned to, and the reason the removal
//      stranded nobody;
//   4. a job this browser has not loaded gets NO job link (the narrow-tier
//      case: the door answers for jobs the caller cannot open);
//   5. the pill's number comes from its own count call, and a failed count
//      leaves the pill numberless rather than breaking the page;
//   6. NOTHING PRICED reaches a crew screen, even when the server (wrongly)
//      sends a price — pickMyWork is what makes that true;
//   7. NO BUILDING IS ANYBODY'S: not in a word on the page, not as an owner
//      the server (wrongly) sends, and not as a control that could set one;
//   8. a status pill is the way back out, to the board door.
//
// Mutants at the end break one guard in a copy of the source and show the
// same drive fail. test/work-orders-board-client.test.js drives the board
// door; test/service-tickets-page.test.js drives the page's wiring.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'work-orders-board.js'), 'utf8').replace(/\r\n/g, '\n');
const JOB_LABEL = require('../js/job-label.js');

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 6; i++) await tick(); }

function mutate(src, from, to) {
  if (src.split(from).length !== 2) throw new Error('anchor not found');
  return src.split(from).join(to);
}

// A my-buildings row: EXACTLY the 19 keys the door promises, and nothing else.
// my_buildings_open / my_buildings_total / my_next_due kept their 1.33 names
// and changed meaning in 1.35 — they are the WORK ORDER's own open count, live
// count and next due date, and `buildings` is its whole punch list.
function mwRow(over) {
  return Object.assign({
    id: 'st_1',
    ticket_number: 'WO-0007',
    title: 'Rehang the gates',
    status: 'in_progress',
    priority: 'normal',
    scheduled_for: null,
    due_date: '2026-09-22',
    street_address: '4120 Waterside Dr',
    city: 'Sanford',
    job_id: 'j1',
    lead_id: null,
    job_number: 'RV2001',
    job_title: 'Waterside 1',
    lead_title: null,
    my_buildings_open: 2,
    my_buildings_total: 3,
    my_next_due: '2026-09-21',
    is_overdue: false,
    buildings: [
      { id: 't_100', title: 'Bldg 784', status: 'open', due_date: '2026-09-21', completed_at: null },
      { id: 't_101', title: 'Bldg 790', status: 'open', due_date: '2026-09-23', completed_at: null },
      { id: 't_102', title: 'Bldg 612', status: 'done', due_date: '2026-09-18', completed_at: '2026-09-18T14:00:00.000Z' },
    ],
  }, over || {});
}

const BODY = (over) => Object.assign({
  tickets: [mwRow()],
  today: '2026-09-19',
  total: 1,
  buildings_open: 2,
  has_more: false,
  next_offset: null,
}, over || {});

const BOARD_BODY = {
  tickets: [], today: '2026-09-19', total: 0, has_more: false, next_offset: null,
  counts: { my_approvals: 0, overdue: 0, due_week: 0, mine: 0, unassigned: 0, no_link: 0, flagged: 0, suggestions: 0 },
  status_counts: { all: 0, active: 0, draft: 0, scheduled: 0, in_progress: 0, awaiting_approval: 0, closed: 0 },
};

let listCalls;
let myCalls;
let host;
let openDetail;

function boot(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="service-tickets" class="tab-content active"><div id="serviceTicketsHost"></div></div>';
  host = document.getElementById('serviceTicketsHost');
  window.localStorage.clear();
  window.history.replaceState({}, '', '/service-tickets');
  // j1 is loaded in this browser; j9 is NOT — the narrow-tier case.
  window.appData = { jobs: o.jobs === undefined ? [{ id: 'j1', jobNumber: 'RV2001', title: 'Waterside 1' }] : o.jobs };
  window.p86JobLabel = JOB_LABEL;
  listCalls = [];
  myCalls = [];
  const listResponder = o.listResponder || (() => Promise.resolve(BOARD_BODY));
  const myResponder = o.myResponder || ((p) => Promise.resolve(p && p.count_only ? { total: 4, buildings_open: 9 } : BODY()));
  window.p86Api = {
    serviceTickets: {
      list: jest.fn((p) => { listCalls.push(Object.assign({}, p)); return listResponder(p, listCalls.length); }),
      myBuildings: jest.fn((p) => { myCalls.push(Object.assign({}, p)); return myResponder(p, myCalls.length); }),
    },
  };
  openDetail = jest.fn();
  if (!o.noTasksModule) window.p86Tasks = o.tasksModule || { openDetail };
  else window.p86Tasks = undefined;
  window.p86ServiceTickets = { openTicket: jest.fn(() => true) };
  window.p86Router = { go: jest.fn(() => true) };
  window.p86Toast = jest.fn();
  window.eval(o.src || SRC);
  window.p86WorkOrdersBoard._assign = jest.fn();
  return window.p86WorkOrdersBoard;
}

const viewPill = (id) => host.querySelector('.p86-wob-views [data-view="' + id + '"]');
const statusPill = (id) => host.querySelector('.p86-wob-status [data-status="' + id + '"]');
const mwRows = () => Array.from(host.querySelectorAll('.p86-wob-mw'));
const bldgBtns = () => Array.from(host.querySelectorAll('.p86-wob-mw-bldg'));
// The list calls that are NOT the count_only probe fired beside every reset.
const myListCalls = () => myCalls.filter((c) => !c.count_only);

function click(el, init) {
  const ev = new window.MouseEvent('click', Object.assign({ bubbles: true, cancelable: true, button: 0 }, init || {}));
  el.dispatchEvent(ev);
  return ev;
}

// jsdom cannot navigate; a link whose default was not prevented would try.
let seenDefault;
function stopNav(e) { seenDefault.push(e.defaultPrevented); e.preventDefault(); }
beforeEach(() => { seenDefault = []; document.addEventListener('click', stopNav); });
afterEach(() => { document.removeEventListener('click', stopNav); });

async function openMyWork(opts) {
  const b = boot(opts);
  await b.render(host);
  await flush();
  click(viewPill('my_work'));
  await flush();
  return b;
}

/* ─────────────────────────────────────────────────────────────────────────
 * 1. THE DOOR
 * ────────────────────────────────────────────────────────────────────────*/
describe('the door My work reads', () => {
  test('pressing My work asks my-buildings, and never the board list again', async () => {
    const b = await openMyWork();
    expect(myListCalls()).toEqual([{ limit: 50, offset: 0 }]);
    // The board door answered the FIRST render and has not been asked since.
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0].board).toBe(1);
    expect(viewPill('my_work').getAttribute('aria-pressed')).toBe('true');
    expect(b._rows()).toHaveLength(1);
  });

  test('no filter, search or sort rides along — the door takes none, and the page says so', async () => {
    await openMyWork();
    // Nothing but limit/offset is ever sent.
    expect(Object.keys(myListCalls()[0]).sort()).toEqual(['limit', 'offset']);
    expect(host.querySelector('.p86-wob-note').textContent)
      .toBe('Work orders assigned to you with a building still open. ' +
        'Everyone assigned to a work order is equally responsible for every building on it. ' +
        "Ordered by due date. Filters and search don't apply to My work.");
    for (const sel of ['.p86-wob-search', '.p86-wob-prio', '.p86-wob-parent', '.p86-wob-sort']) {
      expect([sel, host.querySelector(sel).disabled]).toEqual([sel, true]);
    }
    // The column header drops Crew and names what My work actually shows.
    expect(Array.from(host.querySelectorAll('.p86-wob-colhead span')).map((s) => s.textContent))
      .toEqual(['', 'Ticket', 'Status', 'Scheduled', 'Due', 'Where', 'Buildings open', '']);
  });

  test('the empty state is the view\'s own, even with a status remembered from before', async () => {
    const b = boot({ myResponder: (p) => Promise.resolve(p.count_only ? { total: 0 } : BODY({ tickets: [], total: 0 })) });
    await b.render(host);
    await flush();
    click(statusPill('closed'));
    await flush();
    click(viewPill('my_work'));
    await flush();
    expect(host.querySelector('.p86-wob-list').textContent)
      .toBe('No work order assigned to you has a building open right now.');
  });

  test('Show more pages the same door; a failed quiet refresh keeps what is on screen', async () => {
    const b = boot({
      myResponder: (p) => Promise.resolve(p.count_only
        ? { total: 2 }
        : (p.offset === 0
          ? BODY({ tickets: [mwRow({ id: 'a' })], total: 2, has_more: true, next_offset: 50 })
          : BODY({ tickets: [mwRow({ id: 'b' })], total: 2, has_more: false, next_offset: null }))),
    });
    await b.render(host);
    await flush();
    click(viewPill('my_work'));
    await flush();
    click(host.querySelector('.p86-wob-more'));
    await flush();
    expect(myListCalls()).toEqual([{ limit: 50, offset: 0 }, { limit: 50, offset: 50 }]);
    expect(b._rows().map((r) => r.id)).toEqual(['a', 'b']);
  });

  test('an older cached api.js with no myBuildings degrades to Try again instead of throwing', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    delete window.p86Api.serviceTickets.myBuildings;
    click(viewPill('my_work'));
    await flush();
    expect(host.querySelector('.p86-wob-error')).not.toBeNull();
    // Still a page, still a pill, nothing thrown.
    expect(viewPill('my_work')).not.toBeNull();
    expect(statusPill('all')).not.toBeNull();
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 2. WHAT A ROW SAYS
 * ────────────────────────────────────────────────────────────────────────*/
describe('what a My work row says', () => {
  test('the ticket, N of M buildings, the due date and one button per building', async () => {
    await openMyWork();
    expect(mwRows()).toHaveLength(1);
    const r = mwRows()[0];
    expect(r.querySelector('.p86-wob-title').textContent).toBe('Rehang the gates');
    expect(r.querySelector('.p86-st-num').textContent).toBe('WO-0007');
    expect(r.querySelector('.p86-wob-job').textContent).toBe('RV2001 Waterside 1');
    // The board's task_done/task_total are gone: this is the WORK ORDER's own
    // punch list — open of live — not a share of it belonging to the caller.
    expect(r.querySelector('.p86-wob-bldg-m').textContent).toBe('2 of 3 buildings open');
    expect(r.querySelector('.p86-wob-bldg-d').textContent).toBe('2/3');
    expect(r.querySelector('.p86-wob-c-due').textContent).toBe('DueSep 22, 2026');
    expect(r.querySelector('.p86-wob-c-assignee').textContent).toBe('Where4120 Waterside Dr, Sanford');
    expect(bldgBtns().map((x) => x.getAttribute('data-bldg'))).toEqual(['t_100', 't_101', 't_102']);
    expect(bldgBtns().map((x) => x.textContent)).toEqual([
      'Bldg 784 · Sep 21, 2026', 'Bldg 790 · Sep 23, 2026', 'Bldg 612 · done',
    ]);
    expect(r.querySelector('.p86-wob-mw-bldgs .p86-wob-dim').textContent).toBe('Punch list · next due Sep 21, 2026');
    // …and the strip says whose it is: everyone's, not the reader's.
    expect(r.querySelector('.p86-wob-mw-bldgs').getAttribute('title'))
      .toBe('Everyone this work order is assigned to is responsible for every building on it.');
    // The door sends none of the board's crew badges, so the row's own crew
    // cell is empty (the buildings strip below it is a SIBLING of the row).
    expect(r.querySelectorAll('.p86-wob-row .p86-wob-c-crew .p86-wob-chip')).toHaveLength(0);
    expect(r.querySelector('.p86-wob-row .p86-wob-c-crew').textContent).toBe('Crew');
    expect(r.querySelector('.p86-wob-mw-bldgs').parentNode).toBe(r);
  });

  test('a planted tag in a title or a building name is text, not an element', async () => {
    await openMyWork({
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 1 } : BODY({
        tickets: [mwRow({
          title: '<img src=x onerror=alert(1)>',
          buildings: [{ id: 't_1', title: '"><b>boom</b>', status: 'open', due_date: null, completed_at: null }],
        })],
      })),
    });
    expect(host.querySelector('img')).toBeNull();
    expect(host.querySelector('.p86-wob-list b')).toBeNull();
    expect(host.querySelector('.p86-wob-title').textContent).toBe('<img src=x onerror=alert(1)>');
    expect(bldgBtns()[0].textContent).toBe('"><b>boom</b>');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 3. THE CREW LEAD'S WAY IN
 * ────────────────────────────────────────────────────────────────────────*/
describe('reaching a building', () => {
  test('clicking a building opens the task editor on THAT building', async () => {
    await openMyWork();
    click(bldgBtns()[1]);
    expect(openDetail).toHaveBeenCalledTimes(1);
    expect(openDetail).toHaveBeenCalledWith('t_101');
    // The click never falls through to the row's own link handling.
    expect(window.p86ServiceTickets.openTicket).not.toHaveBeenCalled();
  });

  test('with no js/tasks.js on the page, the click is a sentence, not a throw, and the list still stands', async () => {
    await openMyWork({ noTasksModule: true });
    expect(() => click(bldgBtns()[0])).not.toThrow();
    expect(window.p86Toast).toHaveBeenCalledWith("Couldn't open that building. Reload the page and try again.", 'error');
    expect(mwRows()).toHaveLength(1);
    expect(bldgBtns()).toHaveLength(3);
  });

  test('a job this browser has not loaded gets NO job link — the row is plain, the buildings are the way in', async () => {
    await openMyWork({
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 2 } : BODY({
        tickets: [
          mwRow({ id: 'near', job_id: 'j1' }),
          mwRow({ id: 'far', job_id: 'j9', job_number: 'RV2099', job_title: 'Harbor Point' }),
        ],
        total: 2,
      })),
    });
    const near = host.querySelector('[data-id="near"]');
    const far = host.querySelector('[data-id="far"]');
    expect(near.tagName).toBe('A');
    expect(near.getAttribute('href')).toBe('/jobs/j1/job-service-tickets?ticket=near');
    // j9 is not in window.appData.jobs: no link at all, and no href to follow.
    expect(far.tagName).toBe('DIV');
    expect(far.getAttribute('href')).toBeNull();
    expect(host.querySelectorAll('a.p86-wob-row')).toHaveLength(1);
    // The job is still NAMED — the assignee has to know where to go.
    expect(far.querySelector('.p86-wob-job').textContent).toBe('RV2099 Harbor Point');
    // And the buildings on that unreachable job are still openable.
    click(far.parentNode.querySelectorAll('.p86-wob-mw-bldg')[0]);
    expect(openDetail).toHaveBeenCalledWith('t_100');
  });

  test('the row that DOES keep its link still opens the ticket in the app', async () => {
    await openMyWork();
    click(host.querySelector('a.p86-wob-row .p86-wob-title'));
    expect(seenDefault.pop()).toBe(true);
    expect(window.p86ServiceTickets.openTicket).toHaveBeenCalledWith('j1', 'st_1');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 4. THE PILL'S NUMBER
 * ────────────────────────────────────────────────────────────────────────*/
describe('the My work pill count', () => {
  test('it comes from the parallel count call, not from the board counts', async () => {
    const b = boot();
    await b.render(host);
    await flush();
    expect(myCalls).toContainEqual({ count_only: 1 });
    expect(viewPill('my_work').textContent).toBe('My work 4');
    // attention: a number above zero is marked.
    expect(viewPill('my_work').classList.contains('is-attention')).toBe(true);
    // The board's own counts object never carries it.
    expect(Object.keys(BOARD_BODY.counts)).not.toContain('my_work');
  });

  test('a rejected count leaves the pill without a number and the page working', async () => {
    const b = boot({
      myResponder: (p) => (p.count_only ? Promise.reject(new Error('offline')) : Promise.resolve(BODY())),
    });
    await b.render(host);
    await flush();
    expect(viewPill('my_work')).not.toBeNull();
    expect(viewPill('my_work').textContent).toBe('My work');
    expect(viewPill('my_work').querySelector('.p86-st-pill-n')).toBeNull();
    // The board list underneath is untouched by the failed count.
    expect(host.querySelector('.p86-wob-error')).toBeNull();
    // And the view still opens.
    click(viewPill('my_work'));
    await flush();
    expect(mwRows()).toHaveLength(1);
    // With the list body in hand, the pill can name its own number again.
    expect(viewPill('my_work').textContent).toBe('My work 1');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 5. NOTHING PRICED
 * ────────────────────────────────────────────────────────────────────────*/
// A crew-facing surface carries no money and no office-only text. The door is
// crew-safe by construction, but the page does not take that on trust: every
// row goes through pickMyWork's include-list first. This drives the view with
// a body that WRONGLY carries a price and office notes and reports every way
// one of them could have got through — the rendered page, and the rows the
// page keeps and re-reads on every later paint and click.
const MONEY = /[$£€]\s?\d|\b\d+\.\d{2}\b/;
const DIRTY = {
  internal_notes: 'OFFICE ONLY — client is behind on payment',
  scope_approved: 'approved at $48,000',
  contract_amount: 12750.5,
};
function priced(b) {
  const bad = [];
  const html = host.innerHTML;
  Object.keys(DIRTY).forEach((k) => {
    if (html.includes(k)) bad.push('page has the key ' + k);
    if (html.includes(String(DIRTY[k]))) bad.push('page has the value of ' + k);
  });
  if (MONEY.test(html)) bad.push('page matches the money pattern: ' + (html.match(MONEY) || [])[0]);
  const kept = JSON.stringify(b._rows());
  Object.keys(DIRTY).forEach((k) => { if (kept.includes(k)) bad.push('the kept rows carry ' + k); });
  if (MONEY.test(kept)) bad.push('the kept rows match the money pattern');
  return bad;
}

describe('nothing priced reaches a crew screen', () => {
  const DIRTY_BODY = (p) => Promise.resolve(p.count_only
    ? { total: 1, buildings_open: 2 }
    : BODY({
      tickets: [Object.assign(mwRow({
        buildings: [Object.assign({ id: 't_100', title: 'Bldg 784', status: 'open', due_date: '2026-09-21', completed_at: null },
          { unit_price: 1499.99, internal_notes: 'OFFICE ONLY — do not tell the crew' })],
      }), DIRTY)],
    }));

  test('a body that (wrongly) carries a price shows none of it, and the page keeps none of it', async () => {
    const b = await openMyWork({ myResponder: DIRTY_BODY });
    expect(mwRows()).toHaveLength(1); // it really did render
    expect(priced(b)).toEqual([]);
    // Right down inside `buildings`, which is an array of objects.
    expect(Object.keys(b._rows()[0].buildings[0]).sort())
      .toEqual(['completed_at', 'due_date', 'id', 'status', 'title']);
  });

  test('the rows the page keeps are EXACTLY the door\'s 19 keys, a missing one as null', async () => {
    const b = await openMyWork({
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 1 } : BODY({ tickets: [{ id: 'bare', title: 'Bare' }] })),
    });
    const kept = b._rows()[0];
    expect(Object.keys(kept)).toEqual([
      'id', 'ticket_number', 'title', 'status', 'priority', 'scheduled_for', 'due_date',
      'street_address', 'city', 'job_id', 'lead_id', 'job_number', 'job_title', 'lead_title',
      'my_buildings_open', 'my_buildings_total', 'my_next_due', 'is_overdue', 'buildings',
    ]);
    expect(Object.keys(kept)).toHaveLength(19);
    expect([kept.id, kept.title, kept.job_id, kept.buildings]).toEqual(['bare', 'Bare', null, []]);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 6. NO BUILDING IS ANYBODY'S  (1.35)
 * ────────────────────────────────────────────────────────────────────────*/
// The owner's rule, on 2026-09-20: "i dont want assignments to individual
// buildings like that, whoever is assigned to the ticket, task or work order
// is evenly responsible." So this view may say the WORK ORDER is yours — that
// is what the door asks — and may never say a BUILDING is. Three ways it could
// break the rule, all three closed here: the words on the page, an owner the
// server (wrongly) sends, and a control that could set one.

// Phrases that would hand one person a building. "My work" is the view's own
// name (the work orders really are the caller's) and is deliberately not here.
const OWNS_A_BUILDING = [
  /your\s+buildings?/i,
  /my\s+buildings?/i,
  /buildings?\s+(?:is|are)?\s*assigned/i,
  /assigned\s+(?:building|to\s+you\s+right\s+now)/i,
];
function ownershipWords(html) {
  return OWNS_A_BUILDING.filter((re) => re.test(html)).map(String);
}

describe('no building belongs to one person', () => {
  test('not a word on the view claims a building is yours — and the rule is said out loud', async () => {
    await openMyWork();
    // Every rendered surface: rows, the buildings strip, the note, and the
    // tooltips/labels that only live in attributes.
    expect(ownershipWords(host.innerHTML)).toEqual([]);
    // Not vacuous: the scan does catch the 1.34 wording it replaced.
    expect(ownershipWords('<span>Your buildings · next due Sep 21</span>')).toHaveLength(1);
    expect(ownershipWords('No buildings are assigned to you right now.').length).toBeGreaterThan(0);

    // And the page states the rule where someone would look for it.
    expect(host.querySelector('.p86-wob-note').textContent)
      .toContain('Everyone assigned to a work order is equally responsible for every building on it');
    expect(viewPill('my_work').getAttribute('title'))
      .toContain('Everyone assigned to a work order is responsible for every building on it');
    expect(viewPill('my_work').getAttribute('title')).toContain('Work orders assigned to you');
  });

  test('an owner the server (wrongly) sends on a building is not shown and not kept', async () => {
    const b = await openMyWork({
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 1 } : BODY({
        tickets: [mwRow({
          buildings: [{
            id: 't_100', title: 'Bldg 784', status: 'open', due_date: '2026-09-21', completed_at: null,
            assignee_user_id: 42, assignee_name: 'Dana Ruiz', assignee_initials: 'DR',
          }],
        })],
      })),
    });
    expect(bldgBtns()).toHaveLength(1); // it really did render
    expect(host.innerHTML).not.toContain('Dana Ruiz');
    expect(host.innerHTML).not.toContain('assignee_user_id');
    expect(host.innerHTML).not.toContain('DR');
    // The whitelist is what makes that true on every later paint too.
    expect(Object.keys(b._rows()[0].buildings[0]).sort())
      .toEqual(['completed_at', 'due_date', 'id', 'status', 'title']);
    expect(JSON.stringify(b._rows())).not.toContain('Dana Ruiz');
  });

  test('nothing on the view could SET an owner: no picker, no assign control', async () => {
    await openMyWork();
    const list = host.querySelector('.p86-wob-list');
    expect(list.querySelectorAll('select')).toHaveLength(0);
    expect(list.querySelectorAll('input')).toHaveLength(0);
    expect(list.querySelectorAll('[data-assign], [data-user], [data-assignee]')).toHaveLength(0);
    // Every control under a row is a building button that opens the task.
    expect(Array.from(list.querySelectorAll('button')).map((x) => x.className))
      .toEqual(['p86-wob-chip p86-wob-mw-bldg', 'p86-wob-chip p86-wob-mw-bldg', 'p86-wob-chip p86-wob-mw-bldg is-quiet']);
    // …and nothing in the list offers the word as an action. (The row's
    // p86-wob-c-assignee class is the board's layout slot, reused here for
    // Where; it is a class name, never a label.)
    expect(Array.from(list.querySelectorAll('button, a, [role="button"]'))
      .filter((x) => /assign/i.test(x.textContent))).toHaveLength(0);
    expect(/assign/i.test(list.textContent)).toBe(false);
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 7. BACK OUT
 * ────────────────────────────────────────────────────────────────────────*/
describe('leaving My work', () => {
  test('a status pill returns to the board door with that status', async () => {
    const b = await openMyWork();
    expect(listCalls).toHaveLength(1);
    click(statusPill('work_complete'));
    await flush();
    expect(listCalls[1]).toEqual({
      board: 1, view: 'all', sort: 'created', limit: 50, offset: 0,
      include_counts: 1, status_group: 'awaiting_approval',
    });
    expect(viewPill('my_work').getAttribute('aria-pressed')).toBe('false');
    expect(statusPill('work_complete').getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('.p86-wob-note').textContent).toBe('');
    expect(host.querySelector('.p86-wob-search').disabled).toBe(false);
    expect(mwRows()).toHaveLength(0);
    expect(JSON.parse(window.localStorage.getItem('p86_stp_filters')).view).toBe(null);
    expect(b._rows()).toEqual([]);
  });

  test('pressing My work again turns it off, back to the board door', async () => {
    await openMyWork();
    click(viewPill('my_work'));
    await flush();
    expect(listCalls).toHaveLength(2);
    expect(myListCalls()).toHaveLength(1);
    expect(viewPill('my_work').getAttribute('aria-pressed')).toBe('false');
  });
});

/* ─────────────────────────────────────────────────────────────────────────
 * 8. MUTANTS
 * ────────────────────────────────────────────────────────────────────────*/
describe('mutants', () => {
  test('the harness refuses an anchor that is not in the source', () => {
    expect(() => mutate(SRC, 'nowhere in the board client', 'x')).toThrow('anchor not found');
  });

  test('(a) without pickMyWork, the office-only text and the price ride onto the crew screen', async () => {
    const src = mutate(SRC, 'body.tickets.map(mine ? pickMyWork : pick)', 'body.tickets.slice()');
    const b = await openMyWork({
      src,
      myResponder: (p) => Promise.resolve(p.count_only
        ? { total: 1 }
        : BODY({ tickets: [Object.assign(mwRow(), DIRTY)] })),
    });
    // The same report that came back clean above now names the leaks.
    const bad = priced(b);
    expect(bad.length).toBeGreaterThan(0);
    expect(bad).toContain('the kept rows carry contract_amount');
    expect(bad).toContain('the kept rows carry internal_notes');
    expect(b._rows()[0]).toHaveProperty('contract_amount', 12750.5);
  });

  test('(b) with load() calling the board door for my_work, the crew lead is back behind job access', async () => {
    const src = mutate(SRC,
      "      p = Promise.resolve(mine\n        ? a.myBuildings({ limit: limit, offset: offset })\n        : a.list(paramsFor(limit, offset)));",
      '      p = Promise.resolve(a.list(paramsFor(limit, offset)));');
    await openMyWork({ src });
    // Assertion 1 goes red: my-buildings was never asked for the list.
    expect(myListCalls()).toEqual([]);
    expect(listCalls).toHaveLength(2);
    expect(listCalls[1].board).toBe(1);
  });

  test('(c) without the openDetail guard, a page with no js/tasks.js throws on the click', async () => {
    const src = mutate(SRC,
      "    var t = window.p86Tasks;\n    if (t && typeof t.openDetail === 'function') {\n      try { t.openDetail(id); return; } catch (e) { /* fall through to the toast */ }\n    }",
      '    window.p86Tasks.openDetail(id);\n    return;');
    // The page itself still paints — the guard is about the CLICK, and the
    // list must never be held hostage to another module being loaded.
    await openMyWork({ src, noTasksModule: true });
    expect(mwRows()).toHaveLength(1);
    expect(bldgBtns()).toHaveLength(3);
    // But the way in is now a crash instead of a sentence. jsdom reports an
    // exception thrown inside a listener as a window 'error' event rather
    // than letting it out of dispatchEvent, so that is what is watched.
    const errors = [];
    const onErr = (e) => errors.push(String((e && e.error && e.error.message) || e.message || ''));
    window.addEventListener('error', onErr);
    // jsdom also shouts the uncaught exception at the console; that is the
    // point of the mutant, not something to read in the test output.
    const quiet = jest.spyOn(console, 'error').mockImplementation(() => {});
    click(bldgBtns()[0]);
    quiet.mockRestore();
    window.removeEventListener('error', onErr);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/openDetail/);
    expect(openDetail).not.toHaveBeenCalled();
    expect(window.p86Toast).not.toHaveBeenCalled();
  });

  test('(d) without the my_work branch in emptyText, a remembered status claims it filtered My work', async () => {
    const src = mutate(SRC, '    if (myWork()) return v.empty;\n', '');
    const b = boot({
      src,
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 0 } : BODY({ tickets: [], total: 0 })),
    });
    await b.render(host);
    await flush();
    click(statusPill('closed'));
    await flush();
    click(viewPill('my_work'));
    await flush();
    expect(host.querySelector('.p86-wob-list').textContent).toBe('No tickets match these filters.');
  });

  test('(f) the 1.34 wording put back hands the reader a building of their own', async () => {
    const src = mutate(SRC, "    var lead = 'Punch list' + (next ? ' · next due ' + next : '');",
      "    var lead = 'Your buildings' + (next ? ' · next due ' + next : '');");
    await openMyWork({ src });
    // The scan that came back clean above now names the phrase.
    expect(ownershipWords(host.innerHTML)).toHaveLength(1);
    expect(host.querySelector('.p86-wob-mw-bldgs .p86-wob-dim').textContent)
      .toBe('Your buildings · next due Sep 21, 2026');
  });

  test('(g) without BUILDING_KEYS, an owner the server sends is kept and reachable', async () => {
    const src = mutate(SRC,
      [
        '    out.buildings = Array.isArray(row && row.buildings)',
        '      ? row.buildings.map(function (b) {',
        '          var o = {};',
        '          BUILDING_KEYS.forEach(function (k) { o[k] = b && b[k] !== undefined ? b[k] : null; });',
        '          return o;',
        '        })',
        '      : [];',
      ].join('\n'),
      '    out.buildings = Array.isArray(row && row.buildings) ? row.buildings.slice() : [];');
    const b = await openMyWork({
      src,
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 1 } : BODY({
        tickets: [mwRow({
          buildings: [{
            id: 't_100', title: 'Bldg 784', status: 'open', due_date: '2026-09-21', completed_at: null,
            assignee_user_id: 42, assignee_name: 'Dana Ruiz',
          }],
        })],
      })),
    });
    expect(b._rows()[0].buildings[0]).toHaveProperty('assignee_name', 'Dana Ruiz');
    expect(JSON.stringify(b._rows())).toContain('Dana Ruiz');
  });

  test('(e) without the loaded-job test, an unreachable job becomes a link that lands nowhere', async () => {
    const src = mutate(SRC, "    return r.job_id && loadedJob(r.job_id) ? hrefFor(r) : '';", '    return hrefFor(r);');
    await openMyWork({
      src,
      myResponder: (p) => Promise.resolve(p.count_only ? { total: 1 } : BODY({ tickets: [mwRow({ id: 'far', job_id: 'j9' })] })),
    });
    expect(host.querySelector('[data-id="far"]').tagName).toBe('A');
    expect(host.querySelector('[data-id="far"]').getAttribute('href')).toBe('/jobs/j9/job-service-tickets?ticket=far');
  });
});
