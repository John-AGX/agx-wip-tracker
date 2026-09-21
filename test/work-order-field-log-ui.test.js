/**
 * @jest-environment jsdom
 */
// THE OFFICE'S TIME AND MATERIALS PANEL (js/service-ticket-field-log.js).
//
// Driven in jsdom against the shipped module: the panel is only there when the
// detail read carries field_log (the server sends it only on a work order
// billed after the work), the crew's claim is always shown beside an office
// correction, the totals are the ACCEPTED ones, and each button sends the
// body the server's decide / entry doors expect.
'use strict';

require('../js/service-ticket-ext.js');
require('../js/service-ticket-field-log.js');
const FL = window.p86TicketFieldLog;

function lines() {
  return {
    summary: { waiting: 1, accepted_person_hours: 12, accepted_labor: 1, accepted_materials: 0 },
    labor: [
      { id: 'l_wait', status: 'submitted', source: 'crew', author_label: 'Luis', work_date: '2026-09-21', crew_size: 1, hours: 8, work_performed: 'Tested the float switch.', person_hours: 8 },
      { id: 'l_fix', status: 'accepted', source: 'crew', author_label: 'Marco', work_date: '2026-09-21', crew_size: 2, hours: 6.5, office_hours: 6, work_performed: 'Replaced the check valve.', person_hours: 12 },
    ],
    materials: [],
  };
}

function mount(opts) {
  const o = opts || {};
  const calls = [];
  window.p86Api = { serviceTickets: {
    decideFieldLine: (id, kind, line, body) => { calls.push(['decide', id, kind, line, body]); return Promise.resolve({ ok: true }); },
    addLabor: (id, body) => { calls.push(['addLabor', id, body]); return Promise.resolve({ ok: true }); },
    addMaterial: (id, body) => { calls.push(['addMaterial', id, body]); return Promise.resolve({ ok: true }); },
  } };
  const ctx = {
    t: { id: 'st_tm', status: 'in_progress' },
    r: { tasks: [{ id: 'k1', title: 'Bldg 4 pump room' }], field_log: o.log === undefined ? lines() : o.log },
    canEdit: o.canEdit !== false,
    parseSubtaskTitle: (t) => ({ head: t }),
  };
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const paint = () => {
    const secs = FL.extension.detailSections(ctx);
    host.innerHTML = secs.length ? secs[0].html : '';
    if (secs.length) secs[0].wire(host.firstElementChild, ctx);
  };
  ctx.refresh = () => { paint(); return Promise.resolve(); };
  paint();
  return { host, calls, ctx };
}
const tick = () => new Promise((r) => setTimeout(r, 0));

describe('the panel is only on a work order billed after the work', () => {
  test('no field_log in the read, no panel at all', () => {
    expect(FL.extension.detailSections({ r: {}, t: { id: 'x' } })).toEqual([]);
    expect(FL.extension.detailSections({ r: { field_log: null }, t: { id: 'x' } })).toEqual([]);
  });

  test('registered with the ticket screen, after the crew’s problems', () => {
    const entry = window.p86StExt.list().find((e) => e.name === 'field-log');
    expect(entry && entry.order).toBe(35);
  });
});

describe('what the office sees', () => {
  test('the tech’s claim stays on screen beside the office correction', () => {
    const { host } = mount();
    const fixed = host.querySelector('[data-line="l_fix"]');
    expect(fixed.querySelector('.p86-fl-claim').textContent).toBe('6.5 h');
    expect(fixed.querySelector('.p86-fl-line-h strong').textContent).toBe('6 h');
  });

  test('the totals are the accepted ones, and the waiting lines are counted apart', () => {
    const { host } = mount();
    const sum = host.querySelector('.p86-fl-sum').textContent;
    expect(sum).toContain('12 person-hours accepted');
    expect(sum).toContain('1 line waiting on you');
    expect(host.querySelector('.p86-fl-badge').textContent).toBe('1 to review');
  });

  test('"Accept as sent" is offered only where the office changed the number', () => {
    const { host } = mount();
    expect(host.querySelector('[data-line="l_fix"] .p86-fl-accept').textContent).toBe('Accept as sent');
    expect(host.querySelector('[data-line="l_wait"] .p86-fl-accept').textContent).toBe('Accept');
  });

  test('a person who can only read the ticket gets no buttons', () => {
    const { host } = mount({ canEdit: false });
    expect(host.querySelectorAll('button').length).toBe(0);
  });

  test('a panel whose read failed says so instead of showing zeros', () => {
    const { host } = mount({ log: { labor: [], materials: [], summary: {}, failed: true } });
    expect(host.textContent).toContain('could not be loaded');
    expect(host.querySelector('.p86-fl-sum')).toBeNull();
  });
});

describe('what each button sends', () => {
  test('Accept and Reject', async () => {
    const { host, calls } = mount();
    host.querySelector('[data-line="l_wait"] .p86-fl-accept').click();
    await tick();
    host.querySelector('[data-line="l_wait"] .p86-fl-reject').click();
    await tick();
    expect(calls).toEqual([
      ['decide', 'st_tm', 'labor', 'l_wait', { decision: 'accept' }],
      ['decide', 'st_tm', 'labor', 'l_wait', { decision: 'reject' }],
    ]);
  });

  test('Change… accepts with the office’s numbers and its note', async () => {
    const { host, calls } = mount();
    host.querySelector('[data-line="l_wait"] .p86-fl-change').click();
    await tick();
    const form = host.querySelector('.p86-fl-changeform');
    form.querySelector('[data-f="hours"]').value = '7';
    form.querySelector('[data-f="note"]').value = 'Gate log says 7';
    form.querySelector('.p86-fl-save-change').click();
    await tick();
    expect(calls[0]).toEqual(['decide', 'st_tm', 'labor', 'l_wait', { decision: 'accept', hours: '7', crew_size: '1', note: 'Gate log says 7' }]);
    expect(host.querySelector('.p86-fl-changeform')).toBeNull();
  });

  test('Add time sends an office line, and what was typed survives a repaint', async () => {
    const { host, calls, ctx } = mount();
    host.querySelector('.p86-fl-open-add[data-kind="labor"]').click();
    await tick();
    const type = (f, v) => {
      const el = host.querySelector('.p86-fl-addform [data-f="' + f + '"]');
      el.value = v;
      el.dispatchEvent(new window.Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    };
    type('hours', '3');
    type('work_performed', 'Swapped the pressure switch.');
    await ctx.refresh();                       // another module repaints the ticket
    expect(host.querySelector('.p86-fl-addform [data-f="hours"]').value).toBe('3');
    type('task_id', 'k1');
    host.querySelector('.p86-fl-save-add').click();
    await tick();
    expect(calls[0][0]).toBe('addLabor');
    expect(calls[0][2]).toMatchObject({ hours: '3', crew_size: 1, task_id: 'k1', work_performed: 'Swapped the pressure switch.' });
  });
});

describe('the timeline', () => {
  test('names the new events by shape, never by what was typed', () => {
    expect(FL.eventWhat({ kind: 'labor_sent', detail: {} })).toBe('sent their time');
    expect(FL.eventWhat({ kind: 'field_line_decided', detail: { kind: 'labor', decision: 'accepted', corrected: true } }))
      .toBe('corrected and accepted a time line');
    expect(FL.eventWhat({ kind: 'field_line_decided', detail: '{"kind":"material","decision":"rejected"}' }))
      .toBe('rejected a material line');
    expect(FL.eventWhat({ kind: 'something_else' })).toBeNull();
  });
});
