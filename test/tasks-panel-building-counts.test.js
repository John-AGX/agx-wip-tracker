/* The Tasks panel's building line, the Punch-list note, the entity card and
 * the office punch list (js/tasks.js, js/entity-card.js,
 * js/service-tickets.js) — releases 1.33 and 1.35.
 * ═══════════════════════════════════════════════════════════════════════════
 * 1.33 took work-order BUILDINGS off every task list. On a job or a lead that
 * leaves a Tasks panel that can read "no tasks yet" while four buildings are
 * open on a work order for that exact job — worse than the thing it replaced.
 * So the removal ships with a pointer: a count and a link to the Service
 * Tickets page on the panel, and the same count as a plain summary line on
 * the compact entity card.
 *
 * Three rules this file is really guarding:
 *   • SILENCE IS A VALID ANSWER. Nothing open, a refusal, or an entity type
 *     that cannot carry a work order all render an EMPTY element — no
 *     spinner, no "none", nothing anybody has to be taught to ignore.
 *   • JOBS AND LEADS ONLY. Nothing else carries a work order, so nothing else
 *     may spend a request asking.
 *   • NOBODY OWNS A BUILDING (1.35). The count is the JOB's or LEAD's, never
 *     a person's, and the office screen where a per-building picker would be
 *     added offers none — the last describe in this file drives the real
 *     js/service-tickets.js to say so.
 *   • THE NEW CALL CANNOT REACH THE OLD PATHS. test/work-order-task-doors.js
 *     mounts js/tasks.js against a p86Api that has ONLY a `tasks` key, and
 *     js/entity-card.js holds an absolute rule that a task lookup can never
 *     stop the card rendering. An unguarded reach for p86Api.serviceTickets
 *     breaks both against any browser holding an older cached api.js. The
 *     mutants at the bottom are those exact failures.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const TASKS_JS = path.join(__dirname, '..', 'js', 'tasks.js');
const CARD_JS = path.join(__dirname, '..', 'js', 'entity-card.js');
const TASKS_SRC = fs.readFileSync(TASKS_JS, 'utf8');
const CARD_SRC = fs.readFileSync(CARD_JS, 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 30));

// ── One mounter for the panel: window, call log, [data-building-line]. ──
function tasksWindow(o) {
  o = o || {};
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div><div id="my-tasks"></div></body>',
    { runScripts: 'outside-only', url: 'https://project86.test/' });
  const w = dom.window;
  const calls = { buildingCounts: [], taskList: [], routed: [] };
  w.p86Toast = function () {};
  w.p86Toast.show = w.p86Toast;
  w.p86Api = {
    isAuthenticated: () => false,
    users: { list: () => Promise.resolve({ users: [] }) },
    tasks: {
      list: (f) => { calls.taskList.push(f); return Promise.resolve({ tasks: o.tasks || [] }); },
      get: () => Promise.resolve({ task: null }),
      update: () => Promise.resolve({ task: null })
    }
  };
  if (!o.noServiceTickets) {
    w.p86Api.serviceTickets = {
      buildingCounts: (type, id) => {
        calls.buildingCounts.push([type, id]);
        return o.reject ? Promise.reject(new Error('not yours')) : Promise.resolve(o.counts || {});
      }
    };
  }
  if (o.router) w.p86Router = { go: (p) => calls.routed.push(p) };
  w.eval(o.src || TASKS_SRC);
  return { w, calls, host: w.document.getElementById('host') };
}

async function panel(o) {
  o = o || {};
  const ctx = tasksWindow(o);
  const ctl = ctx.w.p86Tasks.mountEntityPanel(
    ctx.host, o.entityType || 'job', o.entityId || 'j1', o.label || 'Latitude');
  await settle();
  return Object.assign(ctx, { ctl, line: ctx.host.querySelector('[data-building-line]') });
}

describe('js/tasks.js — the Tasks panel building line', () => {
  test('a job with buildings open says so once, with both nouns pluralised', async () => {
    const many = await panel({ counts: { buildings_open: 4, work_orders: 2 } });
    expect(many.calls.buildingCounts).toEqual([['job', 'j1']]);
    expect(many.line.textContent.trim()).toBe('4 buildings open across 2 work orders →');

    const one = await panel({ entityId: 'j2', counts: { buildings_open: 1, work_orders: 1 } });
    expect(one.line.textContent.trim()).toBe('1 building open across 1 work order →');

    // A lead carries work orders too.
    const lead = await panel({ entityType: 'lead', entityId: 'l9', counts: { buildings_open: 3, work_orders: 1 } });
    expect(lead.calls.buildingCounts).toEqual([['lead', 'l9']]);
    expect(lead.line.textContent.trim()).toBe('3 buildings open across 1 work order →');

    // 1.35: it is the JOB's or LEAD's own open count across its work orders.
    // It never was, and may never become, "your buildings".
    for (const re of [/your\s+buildings?/i, /my\s+buildings?/i, /buildings?\s+(?:is|are)?\s*assigned/i]) {
      expect([String(re), re.test(many.line.innerHTML)]).toEqual([String(re), false]);
    }

    // The Tasks list itself is untouched: still entity-scoped, still no
    // knowledge of buildings.
    expect(many.calls.taskList).toEqual([{ entity_type: 'job', entity_id: 'j1' }]);
  });

  test('nothing open, a refusal, and a type that cannot carry one all render EMPTY', async () => {
    const zero = await panel({ counts: { buildings_open: 0, work_orders: 0 } });
    const refused = await panel({ reject: true });
    const client = await panel({ entityType: 'client', entityId: 'c1' });
    const old = await panel({ noServiceTickets: true });

    expect(client.calls.buildingCounts).toEqual([]);
    expect(old.calls.buildingCounts).toEqual([]);
    for (const r of [zero, refused, client, old]) {
      expect(r.line).not.toBeNull();
      expect(r.line.innerHTML).toBe('');
      expect(r.host.textContent).not.toMatch(/Loading buildings|No buildings|buildings open/i);
    }
  });

  test('the link goes to the Service Tickets page — not a per-job filter that does not exist', async () => {
    const r = await panel({ counts: { buildings_open: 4, work_orders: 2 } });
    const a = r.line.querySelector('a');
    expect(a).not.toBeNull();
    expect(a.getAttribute('href')).toBe('/service-tickets');
    expect(a.getAttribute('href')).not.toMatch(/[?&]/);
  });

  test('with an app router present the link routes instead of reloading', async () => {
    const r = await panel({ router: true, counts: { buildings_open: 2, work_orders: 1 } });
    const a = r.line.querySelector('a');
    const ev = new r.w.MouseEvent('click', { bubbles: true, cancelable: true });
    a.dispatchEvent(ev);
    expect(r.calls.routed).toEqual(['/service-tickets']);
    expect(ev.defaultPrevented).toBe(true);
  });

  test('ctl.refresh re-reads the count', async () => {
    const r = await panel({ counts: { buildings_open: 4, work_orders: 2 } });
    expect(r.calls.buildingCounts).toHaveLength(1);
    r.ctl.refresh();
    await settle();
    expect(r.calls.buildingCounts).toEqual([['job', 'j1'], ['job', 'j1']]);
    expect(r.line.textContent.trim()).toBe('4 buildings open across 2 work orders →');
  });

  test('mountList still mounts against a p86Api that has ONLY a tasks key', async () => {
    const ctx = tasksWindow({ noServiceTickets: true, tasks: [{ id: 'k1', title: 'Bldg 1', status: 'open' }] });
    expect(() => ctx.w.p86Tasks.mountList(ctx.host, {}, {})).not.toThrow();
    await settle();
    expect(ctx.w.document.querySelector('[data-toggle]')).not.toBeNull();
    expect(ctx.host.textContent).toContain('Bldg 1');
    expect(ctx.calls.buildingCounts).toEqual([]);
  });

  test('the Punch list tab says where buildings actually live', async () => {
    const ctx = tasksWindow({});
    ctx.w.p86Tasks.renderMyTasksTab();
    await settle();

    const pane = ctx.w.document.getElementById('my-tasks');
    const punchTab = pane.querySelector('[data-tab="punch"]');
    expect(punchTab).not.toBeNull();
    punchTab.dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
    await settle();

    const note = pane.querySelector('.p86-punch-wo-note');
    expect(note).not.toBeNull();
    expect(note.textContent.trim().replace(/\s+/g, ' '))
      .toBe('Buildings on a work order are on the work order — see Service Tickets → My work. ' +
        'No building is assigned to one person: everyone the work order is assigned to is equally ' +
        'responsible for every building on its punch list.');
    // The tab is not renamed and still lists what it always listed.
    expect(punchTab.textContent).toBe('Punch list');
    expect(pane.querySelector('#teamList')).not.toBeNull();
    expect(ctx.calls.taskList[ctx.calls.taskList.length - 1].kind).toBe('punch');

    // The note belongs to the punch tab alone.
    pane.querySelector('[data-tab="team"]').dispatchEvent(new ctx.w.MouseEvent('click', { bubbles: true }));
    await settle();
    expect(pane.querySelector('.p86-punch-wo-note')).toBeNull();
  });
});

describe('js/entity-card.js — loadTasks carries the building count, optionally', () => {
  function cardWindow(o) {
    o = o || {};
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM('<!doctype html><body></body>',
      { runScripts: 'outside-only', url: 'https://project86.test/' });
    const w = dom.window;
    const calls = { buildingCounts: [], taskList: [] };
    w.p86Api = {
      tasks: {
        list: (f) => {
          calls.taskList.push(f);
          return Promise.resolve({ tasks: [{ id: 't1', title: 'Send the W-9', due_date: null }] });
        }
      }
    };
    if (!o.noServiceTickets) {
      w.p86Api.serviceTickets = {
        buildingCounts: (type, id) => {
          calls.buildingCounts.push([type, id]);
          return o.reject ? Promise.reject(new Error('nope')) : Promise.resolve(o.counts || {});
        }
      };
    }
    w.eval(o.src || CARD_SRC);
    return { w, calls };
  }

  const load = (w, type, id) => new Promise((res) => w.p86EntityCard.loadTasks(type, id, 2, res));

  test("a 'sub' never asks for a building count, and still gets its tasks", async () => {
    const c = cardWindow();
    const vm = await load(c.w, 'sub', 's1');
    expect(c.calls.buildingCounts).toEqual([]);
    expect(vm.tasks.map((t) => t.title)).toEqual(['Send the W-9']);
    expect(vm.buildings).toBeNull();
  });

  test('a job gets both, and the card renders one muted summary line', async () => {
    const c = cardWindow({ counts: { buildings_open: 4, work_orders: 2 } });
    const vm = await load(c.w, 'job', 'j1');
    expect(c.calls.buildingCounts).toEqual([['job', 'j1']]);
    expect(vm.buildings).toEqual({ open: 4, workOrders: 2 });
    expect(vm.tasks.map((t) => t.title)).toEqual(['Send the W-9']);

    const html = c.w.p86EntityCard.render({
      kind: 'job', title: 'Latitude', tasks: vm.tasks, tasksMore: vm.more, buildings: vm.buildings
    });
    expect(html).toContain('4 buildings open across 2 work orders');
    expect(html).toContain('Send the W-9');
    // A summary line, not a link and not a task row — the card is a summary.
    expect(html).not.toContain('<a ');
    expect(html).not.toContain('/service-tickets');

    const one = c.w.p86EntityCard.render({ kind: 'job', title: 'L', buildings: { open: 1, workOrders: 1 } });
    expect(one).toContain('1 building open across 1 work order');
  });

  // 1.35: the count was never one person's, and now there is no such reading
  // to be had — a building is never assigned, and everyone the work order is
  // assigned to is equally responsible for every building on it.
  test('the line counts the ENTITY, names no person, and says who is responsible', async () => {
    const c = cardWindow({ counts: { buildings_open: 4, work_orders: 2 } });
    const vm = await load(c.w, 'job', 'j1');
    const html = c.w.p86EntityCard.render({
      kind: 'job', title: 'Latitude', tasks: [], tasksMore: 0, buildings: vm.buildings
    });
    for (const re of [/your\s+buildings?/i, /my\s+buildings?/i, /buildings?\s+(?:is|are)?\s*assigned/i]) {
      expect([String(re), re.test(html)]).toEqual([String(re), false]);
    }
    // Not vacuous: the scan does catch a line that hands them to somebody.
    expect(/your\s+buildings?/i.test('<div>Your buildings: 4 open</div>')).toBe(true);

    // The rule is in reach of the line it qualifies.
    expect(html).toContain('Everyone the work order is assigned to is responsible for every building on it.');
    // …and the door behind it asks the JOB, never a person.
    expect(c.calls.buildingCounts).toEqual([['job', 'j1']]);
  });

  test('a refusal, a zero and an older api.js all leave the card exactly as it was', async () => {
    const refused = cardWindow({ reject: true });
    expect((await load(refused.w, 'job', 'j1')).buildings).toBeNull();

    const zero = cardWindow({ counts: { buildings_open: 0, work_orders: 0 } });
    expect((await load(zero.w, 'job', 'j1')).buildings).toBeNull();

    const old = cardWindow({ noServiceTickets: true });
    const vm = await load(old.w, 'job', 'j1');
    expect(vm.buildings).toBeNull();
    expect(vm.tasks.map((t) => t.title)).toEqual(['Send the W-9']);

    // The new key absent or null renders the card byte-identically to 1.32.
    const before = old.w.p86EntityCard.render({ kind: 'job', title: 'Latitude', tasks: [{ title: 'Send the W-9' }] });
    const after = old.w.p86EntityCard.render({ kind: 'job', title: 'Latitude', tasks: [{ title: 'Send the W-9' }], buildings: null });
    expect(after).toBe(before);
  });

  test('MUTANT: without the job/lead restriction, every entity type spends a request', async () => {
    const anchor = "    if (entityType !== 'job' && entityType !== 'lead') return Promise.resolve(null);\n";
    const src = CARD_SRC.replace(/\r\n/g, '\n');
    expect(src.split(anchor)).toHaveLength(2);
    const mutant = src.split(anchor).join('');

    const c = cardWindow({ src: mutant, counts: { buildings_open: 4, work_orders: 2 } });
    const vm = await load(c.w, 'sub', 's1');
    // Red: the 'sub' now asks a question no sub can answer, and wears the
    // answer meant for jobs.
    expect(c.calls.buildingCounts).toEqual([['sub', 's1']]);
    expect(vm.buildings).toEqual({ open: 4, workOrders: 2 });
  });

  test('MUTANT: without the job/lead restriction on the panel, a client asks too', async () => {
    const anchor = "    var CAN_HAVE_BUILDINGS = (entityType === 'job' || entityType === 'lead');\n";
    const src = TASKS_SRC.replace(/\r\n/g, '\n');
    expect(src.split(anchor)).toHaveLength(2);
    const mutant = src.split(anchor).join('    var CAN_HAVE_BUILDINGS = true;\n');

    const r = await panel({ src: mutant, entityType: 'client', entityId: 'c1', counts: { buildings_open: 4, work_orders: 2 } });
    expect(r.calls.buildingCounts).toEqual([['client', 'c1']]);
    expect(r.line.textContent.trim()).toBe('4 buildings open across 2 work orders →');
  });

  /* ── THE ONLY REAL CALLER (js/leads.js) ────────────────────────────────
   * p86EntityCard.render() takes whatever view-model it is handed, so the
   * tests above can pass with a `buildings` key that NOTHING in the app ever
   * sets. js/leads.js mountLeadCard is the only caller of loadTasks in the
   * whole of js/, so these two assertions are the difference between the line
   * shipping and the request being spent for nothing.
   */
  const LEADS_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'leads.js'), 'utf8').replace(/\r\n/g, '\n');
  const mountLeadCardSrc = () => {
    const a = LEADS_SRC.indexOf('function mountLeadCard(');
    expect(a).toBeGreaterThan(-1);
    const b = LEADS_SRC.indexOf('window.p86MountLeadCard = mountLeadCard;', a);
    return LEADS_SRC.slice(a, b < 0 ? LEADS_SRC.length : b);
  };

  test("the lead card's view-model actually carries `buildings` — the key is not set by anything else", () => {
    const src = mountLeadCardSrc();
    // paint(taskVm) builds the view-model p86EntitySubnav.mount renders.
    const vmStart = src.indexOf('window.p86EntitySubnav.mount(');
    expect(vmStart).toBeGreaterThan(-1);
    const vm = src.slice(vmStart, src.indexOf('}, onAct);', vmStart));
    expect(vm).toMatch(/tasks:\s*\(taskVm && taskVm\.tasks\)/);
    expect(vm).toMatch(/buildings:\s*\(taskVm && taskVm\.buildings\)/);
  });

  test('the post-fetch repaint admits buildings with no tasks — the case the line exists for', () => {
    const src = mountLeadCardSrc();
    // The shipped gate, evaluated as written. A lead with four open buildings
    // and zero follow-ups is exactly the card that must repaint.
    const m = /if \((vm && \(?\(.*?\)\)?)\) paint\(vm\);/.exec(src.replace(/\n\s*\/\/[^\n]*/g, ''));
    expect(m).not.toBeNull();
    // eslint-disable-next-line no-new-func
    const gate = new Function('vm', 'return !!(' + m[1] + ');');

    expect(gate({ tasks: [], buildings: { open: 4, workOrders: 2 } })).toBe(true);
    expect(gate({ tasks: [{ title: 'Send the W-9' }], buildings: null })).toBe(true);
    // Nothing to say is still nothing to repaint: the immediate paint(null)
    // already drew the card, and a second identical paint is churn.
    expect(gate({ tasks: [], buildings: null })).toBe(false);
    expect(gate(null)).toBe(false);
  });

  test('MUTANT: the 1.32 gate (tasks only) strands the lead with buildings and no follow-ups', () => {
    const gate = new Function('vm', 'return !!(vm && vm.tasks && vm.tasks.length);');
    // Red on the exact case: the count arrived, and the card never repaints.
    expect(gate({ tasks: [], buildings: { open: 4, workOrders: 2 } })).toBe(false);
  });

  test('MUTANT: an unguarded reach for p86Api.serviceTickets takes the whole Tasks panel down', async () => {
    const src = TASKS_SRC.replace(/\r\n/g, '\n');
    const anchor = [
      '      var p = null;',
      '      try {',
      '        if (window.p86Api && window.p86Api.serviceTickets',
      "          && typeof window.p86Api.serviceTickets.buildingCounts === 'function') {",
      '          p = window.p86Api.serviceTickets.buildingCounts(entityType, String(entityId));',
      '        }',
      '      } catch (e) { p = null; }',
      ''
    ].join('\n');
    expect(src.split(anchor)).toHaveLength(2);
    const mutant = src.split(anchor)
      .join('      var p = window.p86Api.serviceTickets.buildingCounts(entityType, String(entityId));\n');

    // Guarded: an older cached api.js costs the LINE and nothing else.
    const ok = await panel({ noServiceTickets: true });
    expect(ok.line.innerHTML).toBe('');
    expect(ok.host.querySelector('[data-task-list]')).not.toBeNull();

    // Unguarded: mountEntityPanel throws, so the entity page loses its
    // Tasks panel outright — the exact browser (stale api.js) the guard is for.
    const ctx = tasksWindow({ src: mutant, noServiceTickets: true });
    expect(() => ctx.w.p86Tasks.mountEntityPanel(ctx.host, 'job', 'j1', 'Latitude')).toThrow();
  });
});

/* ── THE OFFICE PUNCH LIST (js/service-tickets.js) — release 1.35 ────────
 * The owner, 2026-09-20: "i dont want assignments to individual buildings
 * like that, whoever is assigned to the ticket, task or work order is evenly
 * responsible."
 *
 * The office work-order screen is the one place a per-building picker would
 * ever be added, so this drives the REAL js/service-tickets.js (with the
 * editor kit, the extension registry and the status-move helper loaded before
 * it, as index.html does) and holds four things:
 *   • the ticket keeps its ONE Assigned to — the RECORD's, a real dropdown —
 *     and it is not inside a building card;
 *   • a building card has no owner, no initials and no picker, even when the
 *     server (wrongly) sends one on the row;
 *   • the punch list SAYS the rule, on its header and under the Add box;
 *   • adding a building sends no assignee_user_id, so the refusal the server
 *     now answers with (409 building_not_assignable) is unreachable from here.
 * The two mutants at the end are those last two guards, broken.
 */
describe('the office punch list never offers to assign a building', () => {
  const ROOT_DIR = path.join(__dirname, '..');
  const read = (rel) => fs.readFileSync(path.join(ROOT_DIR, rel), 'utf8').replace(/\r\n/g, '\n');
  const TICKETS_SRC = read('js/service-tickets.js');
  const EDITOR_SRC = read('js/service-ticket-editor.js');
  const EXT_SRC = read('js/service-ticket-ext.js');
  const MOVE_SRC = read('js/service-ticket-status-move.js');
  const JOB_LABEL = require('../js/job-label.js');
  const copy = (v) => JSON.parse(JSON.stringify(v));
  const flush = async () => { for (let i = 0; i < 14; i++) await new Promise((r) => setTimeout(r, 0)); };

  const BUILDINGS = () => [
    { id: 'tk_1', title: 'Bldg 784 — Side A: rail post', status: 'open', photos: [], notes: [] },
    { id: 'tk_2', title: 'Bldg 790 — Side D: stringer', status: 'open', photos: [], notes: [] },
  ];

  async function office(o) {
    o = o || {};
    const { JSDOM } = require('jsdom');
    const dom = new JSDOM(
      '<!doctype html><body><div id="scroller"><div id="job-service-tickets"></div></div></body>',
      { runScripts: 'outside-only', url: 'https://project86.test/' });
    const w = dom.window;
    const calls = { taskCreate: [] };
    const tickets = [{
      id: 'st_1', ticket_number: 'WO-0001', title: 'Replace stair treads', status: 'open',
      priority: 'normal', job_id: 'job_77', lead_id: null, scope_proposed: '', due_date: null,
      scheduled_for: null, assignee_user_id: 10, assignee_name: 'Pat Office',
      task_total: 2, task_done: 0,
    }];
    const tasks = o.tasks || BUILDINGS();
    w.appState = { currentJobId: 'job_77' };
    w.appData = { jobs: [{ id: 'job_77', jobNumber: 'RV2006', title: 'Waterside' }], leads: [] };
    w.p86JobLabel = JOB_LABEL;
    w.p86Api = {
      serviceTickets: {
        list: () => Promise.resolve({ tickets: copy(tickets) }),
        get: () => Promise.resolve({
          ticket: copy(tickets[0]), tasks: copy(tasks), events: [], revisions: [],
          participants: [], site: null,
          progress: { tasksTotal: tasks.length, tasksDone: 0 },
        }),
        update: () => Promise.resolve({ ok: true, ticket: copy(tickets[0]), changed: [] }),
        assignees: () => Promise.resolve({ users: [{ id: 10, name: 'Pat Office' }, { id: 12, name: 'Rosa Diaz' }] }),
        shares: () => Promise.resolve({ shares: [] }),
      },
      tasks: { create: (p) => { calls.taskCreate.push(p); return Promise.resolve({ ok: true }); } },
      users: { list: () => Promise.resolve({ users: [{ id: 10, name: 'Pat Office' }, { id: 12, name: 'Rosa Diaz' }] }) },
      attachments: { upload: () => Promise.resolve({ ok: true }) },
    };
    w.p86Auth = { hasCapability: () => true, getUser: () => ({ id: 10 }) };
    w.p86Toast = () => {};
    w.p86Confirm = () => Promise.resolve(true);
    w.p86ConfirmTernary = () => Promise.resolve(null);
    w.eval(EXT_SRC);
    w.eval(EDITOR_SRC);
    w.eval(MOVE_SRC);
    w.eval(o.src || TICKETS_SRC);
    w.renderJobServiceTickets('job_77');
    await flush();
    const pane = w.document.getElementById('job-service-tickets');
    pane.querySelector('.p86-st-row[data-ticket="st_1"] .p86-st-row-head').click();
    await flush();
    return { w, pane, calls, detail: pane.querySelector('.p86-st-row.is-open .p86-st-detail') };
  }

  const cards = (d) => Array.from(d.querySelectorAll('.p86-wo-sub'));

  test('the ONE assignee control on the screen is the work order\'s, and no card holds it', async () => {
    const r = await office();
    const d = r.detail;
    expect(cards(d)).toHaveLength(2); // the punch list really did render

    const pickers = d.querySelectorAll('[data-st-field="assignee_user_id"]');
    expect(pickers).toHaveLength(1);
    expect(pickers[0].tagName).toBe('SELECT');
    // It belongs to the RECORD's fields, not to any building.
    expect(pickers[0].closest('.p86-wo-sub')).toBeNull();

    cards(d).forEach((c) => {
      expect(c.querySelectorAll('select')).toHaveLength(0);
      expect(c.querySelectorAll('[data-st-field="assignee_user_id"]')).toHaveLength(0);
      expect(c.querySelectorAll('.p86-st-who, [data-user], [data-assign], [data-assignee]')).toHaveLength(0);
      expect(/assign/i.test(c.textContent)).toBe(false);
    });
  });

  test('an owner the server (wrongly) sends on a building row is drawn nowhere', async () => {
    const withOwners = BUILDINGS().map((t, i) => Object.assign(t, {
      assignee_user_id: 40 + i, assignee_name: i ? 'Marco Vega' : 'Dana Ruiz', assignee_initials: 'DR',
    }));
    const r = await office({ tasks: withOwners });
    expect(cards(r.detail)).toHaveLength(2);
    const html = r.detail.innerHTML;
    expect(html).not.toContain('Marco Vega');
    expect(html).not.toContain('Dana Ruiz');
    expect(html).not.toContain('assignee_name');
  });

  test('the punch list says the rule where it is made — the header and the Add box', async () => {
    const RULE = 'No building is assigned to one person. Everyone this work order is assigned to ' +
      'is equally responsible for every building on its punch list.';
    const r = await office();
    expect(r.detail.querySelector('.p86-wo-punch-head .p86-st-lbl').getAttribute('title')).toBe(RULE);
    const note = r.detail.querySelector('.p86-st-task-note').textContent;
    expect(note).toContain(RULE);
    expect(note).toContain("Set the work order's Assigned to above");
    expect(note).toContain('Service Tickets → My work');
    // And it never tells the office a building has an owner to find.
    expect(note).not.toMatch(/whoever a building is assigned to/i);
  });

  test('adding a building sends a title and its parents — never an assignee', async () => {
    const r = await office();
    r.detail.querySelector('.p86-st-task-new').value = 'Bldg 612 — Side B: tread 3';
    r.detail.querySelector('.p86-st-task-go').click();
    await flush();
    expect(r.calls.taskCreate).toEqual([{
      title: 'Bldg 612 — Side B: tread 3',
      service_ticket_id: 'st_1',
      entity_type: 'job',
      entity_id: 'job_77',
    }]);
    // Said as its own assertion: this is the key the server refuses with 409
    // building_not_assignable, and the office never sends it.
    expect(Object.keys(r.calls.taskCreate[0])).not.toContain('assignee_user_id');
  });

  test('MUTANT: an owner chip on a building card puts a name on something nobody owns', async () => {
    const anchor = "          (notes.length ? '<span class=\"p86-wo-chip\">' + notes.length + ' note' + " +
      "(notes.length === 1 ? '' : 's') + '</span>' : '') +";
    expect(TICKETS_SRC.split(anchor)).toHaveLength(2);
    const mutant = TICKETS_SRC.split(anchor).join(anchor +
      "\n          '<span class=\"p86-wo-chip p86-st-who\" data-user=\"' + escAttr(t.assignee_user_id || '') + " +
      "'\">' + esc(t.assignee_name || 'Unassigned') + '</span>' +");

    const withOwners = BUILDINGS().map((t) => Object.assign(t, { assignee_user_id: 40, assignee_name: 'Marco Vega' }));
    const r = await office({ src: mutant, tasks: withOwners });
    // Both guards above go red: the card now carries an owner and a chip.
    expect(r.detail.innerHTML).toContain('Marco Vega');
    expect(cards(r.detail)[0].querySelectorAll('.p86-st-who').length).toBe(1);
  });

  test('MUTANT: an assignee on the Add payload makes the refusal reachable from the office', async () => {
    const anchor = [
      '      window.p86Api.tasks.create({',
      '        title: title,',
      '        service_ticket_id: t.id,',
    ].join('\n');
    expect(TICKETS_SRC.split(anchor)).toHaveLength(2);
    const mutant = TICKETS_SRC.split(anchor).join(anchor + '\n        assignee_user_id: 10,');

    const r = await office({ src: mutant });
    r.detail.querySelector('.p86-st-task-new').value = 'Bldg 612';
    r.detail.querySelector('.p86-st-task-go').click();
    await flush();
    expect(Object.keys(r.calls.taskCreate[0])).toContain('assignee_user_id');
  });
});
