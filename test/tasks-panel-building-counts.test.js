/* The Tasks panel's building line, the Punch-list note, and the entity card
 * (js/tasks.js, js/entity-card.js) — release 1.33.
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
    expect(note.textContent.trim())
      .toBe('Buildings on a work order are on the work order — see Service Tickets → My work.');
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
