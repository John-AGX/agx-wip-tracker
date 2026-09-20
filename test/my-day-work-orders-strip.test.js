/* My Day — the work-orders strip (js/my-day.js), release 1.33.
 * ═══════════════════════════════════════════════════════════════════════════
 * 1.33 took work-order BUILDINGS off every task list: a building is a line on
 * a work order, not a to-do. The removal and its replacement ship together,
 * and this strip is one of the replacements — the place where the person a
 * building is assigned to still sees it, and still has a way to finish it.
 *
 * So the tests here are not "does a section render". They are the four
 * promises the removal is only safe if we keep:
 *   • the work I am on today is ABOVE my task list, not buried under it;
 *   • each building is one tap from the detail that can mark it done;
 *   • the strip is crew-facing, so no price and no internal note reaches it;
 *   • a dead or missing my-buildings feed costs the strip and NOTHING else —
 *     My Day renders exactly as it did before.
 *
 * TIME ZONE. Pinned to America/New_York (a negative offset) before anything
 * else loads, because the day-boundary mutant below only has teeth in a zone
 * where UTC midnight and local midnight fall on different dates.
 */
'use strict';

process.env.TZ = 'America/New_York';

const fs = require('fs');
const path = require('path');

const MY_DAY_JS = path.join(__dirname, '..', 'js', 'my-day.js');
const SRC = fs.readFileSync(MY_DAY_JS, 'utf8');
const settle = () => new Promise((r) => setTimeout(r, 30));

function pad(n) { return String(n).padStart(2, '0'); }

// The LOCAL calendar day, the same way the file's own isoDate() does it.
function localDay(offsetDays) {
  const d = new Date();
  d.setDate(d.getDate() + (offsetDays || 0));
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

const TODAY = localDay(0);
const TOMORROW = localDay(1);
const NEXT_WEEK = localDay(7);
const LAST_WEEK = localDay(-7);

function ticket(over) {
  return Object.assign({
    id: 'st_1',
    ticket_number: 'WO-1041',
    title: 'Metrowest — exterior repaint',
    status: 'in_progress',
    priority: 'normal',
    scheduled_for: null,
    due_date: null,
    street_address: '6168 Raleigh Street',
    city: 'Orlando',
    job_id: 'j_77',
    lead_id: null,
    job_number: 'S2142',
    job_title: 'Metrowest Apartments',
    lead_title: null,
    my_buildings_open: 2,
    my_buildings_total: 3,
    my_next_due: TODAY,
    is_overdue: false,
    buildings: [
      { id: 'tk_b1', title: 'Building 4', status: 'open', due_date: TODAY, completed_at: null },
      { id: 'tk_b2', title: 'Building 7', status: 'in_progress', due_date: TOMORROW, completed_at: null },
      { id: 'tk_b3', title: 'Building 2', status: 'done', due_date: LAST_WEEK, completed_at: '2026-09-14T15:00:00.000Z' }
    ]
  }, over || {});
}

async function mountDay(o) {
  o = o || {};
  const { JSDOM } = require('jsdom');
  const dom = new JSDOM('<!doctype html><body><div id="host"></div></body>',
    { runScripts: 'outside-only', url: 'https://project86.test/' });
  const w = dom.window;
  const opened = [];
  const myBuildingsCalls = [];

  w.p86Auth = { getUser: () => ({ id: 7, name: 'Dana Ruiz' }) };
  w.p86Tasks = { openDetail: (id) => opened.push(id) };
  w.switchTab = () => {};
  w.fetch = () => Promise.resolve({ ok: true, json: () => Promise.resolve({ threads: [] }) });

  w.p86Api = {
    calendar: { list: () => Promise.resolve({ events: [] }) },
    schedule: { list: () => Promise.resolve({ entries: [] }) },
    tasks: { list: () => Promise.resolve({ tasks: o.tasks || [] }) }
  };
  if (o.serviceTickets !== false) {
    w.p86Api.serviceTickets = {
      myBuildings: (opts) => {
        myBuildingsCalls.push(opts);
        if (o.reject) return Promise.reject(new Error('my-buildings is down'));
        return Promise.resolve({
          tickets: o.tickets || [], today: TODAY,
          total: (o.tickets || []).length, buildings_open: 0, has_more: false, next_offset: null
        });
      }
    };
  }

  w.eval(o.src || SRC);
  const host = w.document.getElementById('host');
  w.p86MyDay.renderInto(host, { showEmail: false });
  await settle();
  return { w, host, opened, myBuildingsCalls, body: host.querySelector('.myday-embed-body') };
}

const heads = (body) =>
  Array.prototype.map.call(body.querySelectorAll('.myday-sec-h'), (e) => e.textContent.trim());
const sectionAfter = (body, label) => {
  const hs = body.querySelectorAll('.myday-sec-h');
  for (const h of hs) if (h.textContent.trim() === label) return h.parentNode;
  return null;
};

const DUE_TASK = { id: 'tk_9', title: 'Call the inspector', due_date: TODAY, priority: 'normal' };

describe('My Day — the work-orders strip', () => {
  test('a work order whose next building is due today renders ABOVE the task list', async () => {
    const r = await mountDay({ tickets: [ticket()], tasks: [DUE_TASK] });
    expect(heads(r.body)).toEqual(['Work orders', 'Tasks due']);

    // Not just "both present" — the strip must come FIRST in document order.
    const all = Array.prototype.slice.call(r.body.querySelectorAll('.myday-sec-h'));
    const wo = all.findIndex((e) => e.textContent.trim() === 'Work orders');
    const tk = all.findIndex((e) => e.textContent.trim() === 'Tasks due');
    expect(wo).toBeGreaterThanOrEqual(0);
    expect(wo).toBeLessThan(tk);

    const card = r.body.querySelector('[data-kind="workorder"]');
    expect(card.textContent).toContain('Metrowest — exterior repaint');
    expect(card.textContent).toContain('WO-1041');
    expect(card.textContent).toContain('2 buildings open');
    expect(card.textContent).toContain('S2142');
    expect(card.textContent).toContain('Metrowest Apartments');
    expect(r.myBuildingsCalls).toEqual([{ limit: 100 }]);
  });

  test('"needs me today" is the whole filter: next week is out, scheduled-today and an overdue ticket due-date are in', async () => {
    const nextWeek = await mountDay({
      tickets: [ticket({ id: 'st_far', my_next_due: NEXT_WEEK, buildings: [] })]
    });
    expect(heads(nextWeek.body)).not.toContain('Work orders');

    const scheduledToday = await mountDay({
      tickets: [ticket({ id: 'st_sched', my_next_due: null, scheduled_for: TODAY })]
    });
    expect(heads(scheduledToday.body)).toContain('Work orders');

    const ticketOverdue = await mountDay({
      tickets: [ticket({ id: 'st_od', my_next_due: null, due_date: LAST_WEEK, is_overdue: true })]
    });
    expect(heads(ticketOverdue.body)).toContain('Work orders');
    expect(sectionAfter(ticketOverdue.body, 'Work orders').textContent).toContain('overdue');

    // One that matches on nothing at all stays out even with open buildings.
    const none = await mountDay({
      tickets: [ticket({ id: 'st_none', my_next_due: NEXT_WEEK, due_date: NEXT_WEEK, scheduled_for: NEXT_WEEK })]
    });
    expect(heads(none.body)).not.toContain('Work orders');
  });

  test('each open building is a row, and tapping one opens its task detail', async () => {
    const r = await mountDay({ tickets: [ticket()] });
    const rows = r.body.querySelectorAll('[data-kind="building"]');
    // The done building is not a row — only what is still owed.
    expect(Array.prototype.map.call(rows, (e) => e.getAttribute('data-id'))).toEqual(['tk_b1', 'tk_b2']);
    expect(rows[0].textContent).toContain('Building 4');

    rows[1].dispatchEvent(new r.w.MouseEvent('click', { bubbles: true }));
    expect(r.opened).toEqual(['tk_b2']);
  });

  test('the summary counts work orders, and a day that is only a work order is not "nothing on the books"', async () => {
    const r = await mountDay({ tickets: [ticket()], tasks: [] });
    const summary = r.body.querySelector('.myday-summary');
    expect(summary.textContent).toContain('1 work order');
    expect(r.body.querySelector('.myday-empty')).toBeNull();
    expect(r.body.textContent).not.toContain('Nothing on the books today');

    const two = await mountDay({
      tickets: [ticket(), ticket({ id: 'st_2', ticket_number: 'WO-1042', buildings: [] })]
    });
    expect(two.body.querySelector('.myday-summary').textContent).toContain('2 work orders');

    // And a genuinely empty day is still empty.
    const empty = await mountDay({ tickets: [], tasks: [] });
    expect(empty.body.textContent).toContain('Nothing on the books today');
  });

  test('a rejected my-buildings costs the strip and nothing else', async () => {
    const ok = await mountDay({ tickets: [], tasks: [DUE_TASK] });
    const dead = await mountDay({ reject: true, tickets: [ticket()], tasks: [DUE_TASK] });

    expect(heads(dead.body)).not.toContain('Work orders');
    // The rest of the day is byte-identical to the run that never had a strip.
    expect(sectionAfter(dead.body, 'Tasks due').innerHTML)
      .toBe(sectionAfter(ok.body, 'Tasks due').innerHTML);
    expect(dead.body.querySelector('.myday-summary').textContent)
      .toBe(ok.body.querySelector('.myday-summary').textContent);
  });

  test('an api.js too old to have serviceTickets does not throw — the day still renders', async () => {
    const r = await mountDay({ serviceTickets: false, tasks: [DUE_TASK] });
    expect(heads(r.body)).toEqual(['Tasks due']);
    expect(r.body.querySelector('.myday-err')).toBeNull();
    expect(r.body.textContent).toContain('Call the inspector');
  });

  test('crew-facing: no price and no internal note reaches the DOM', async () => {
    const r = await mountDay({
      tickets: [ticket({
        internal_notes: 'Do not tell the customer we ate the trip charge',
        contract_amount: 18450.75,
        price: 18450.75,
        labor_cost: 6200
      })]
    });
    const html = r.body.innerHTML;
    expect(html).not.toContain('Do not tell the customer');
    expect(html).not.toContain('18450');
    expect(html).not.toContain('18,450');
    expect(html).not.toContain('6200');
    expect(html).not.toMatch(/\$\s?\d/);
    // Belt and braces: the section really did render, so the absence above
    // is the projection doing its job and not an empty strip.
    expect(heads(r.body)).toContain('Work orders');
  });

  test('MUTANT: with the boundary at < instead of <=, the work order due TODAY disappears', async () => {
    const anchor = 'if (nd && nd <= today) return true;';
    expect(SRC.split(anchor)).toHaveLength(2);
    const mutant = SRC.split(anchor).join('if (nd && nd < today) return true;');

    const only = ticket({ my_next_due: TODAY, due_date: null, scheduled_for: null });
    expect(heads((await mountDay({ tickets: [only] })).body)).toContain('Work orders');
    expect(heads((await mountDay({ src: mutant, tickets: [only] })).body)).not.toContain('Work orders');
  });

  test('MUTANT: reading a DATE column as an instant flips a day — tomorrow leaks into today', async () => {
    // The zone has to actually be behind UTC or this proves nothing.
    expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);

    const anchor = "if (typeof v === 'string') return v.slice(0, 10);";
    expect(SRC.split(anchor)).toHaveLength(2);
    // Bug A: parse the bare YYYY-MM-DD as UTC midnight, then read it back with
    // local getters. West of Greenwich that is the PREVIOUS day.
    const mutant = SRC.split(anchor).join("if (typeof v === 'string') return isoDate(new Date(v));");

    const tomorrow = ticket({ id: 'st_tmrw', my_next_due: TOMORROW, due_date: null, scheduled_for: null, buildings: [] });
    expect(heads((await mountDay({ tickets: [tomorrow] })).body)).not.toContain('Work orders');
    expect(heads((await mountDay({ src: mutant, tickets: [tomorrow] })).body)).toContain('Work orders');
  });
});
