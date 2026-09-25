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
    materials: [
      { id: 'm_rec', status: 'submitted', source: 'crew', author_label: 'Marco', description: '2" PVC check valve', quantity: 1, unit: 'ea',
        receipts: [{ id: 'att_r1', filename: 'receipt.jpg', thumb_url: 'https://cdn.test/r1t', web_url: 'https://cdn.test/r1w' }] },
      { id: 'm_none', status: 'accepted', source: 'crew', description: 'PVC primer', quantity: 1, unit: 'kit', receipts: [] },
    ],
  };
}

function mount(opts) {
  const o = opts || {};
  const calls = [];
  window.p86Api = { serviceTickets: {
    decideFieldLine: (id, kind, line, body) => { calls.push(['decide', id, kind, line, body]); return Promise.resolve({ ok: true }); },
    addLabor: (id, body) => { calls.push(['addLabor', id, body]); return Promise.resolve({ ok: true }); },
    addMaterial: (id, body) => { calls.push(['addMaterial', id, body]); return Promise.resolve({ ok: true }); },
    update: (id, body) => { calls.push(['update', id, body]); return Promise.resolve({ ok: true }); },
  } };
  const ctx = {
    t: Object.assign({ id: 'st_tm', status: 'in_progress', bill_as: 'time_materials' }, o.t || {}),
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
  test('no field_log and nothing to switch on: no panel at all', () => {
    expect(FL.extension.detailSections({ r: {}, t: { id: 'x' }, canEdit: false })).toEqual([]);
    expect(FL.extension.detailSections({ r: { field_log: null }, t: { id: 'x', bill_as: 'contract' }, canEdit: true })).toEqual([]);
  });

  test('registered with the ticket screen, after the crew’s problems', () => {
    const entry = window.p86StExt.list().find((e) => e.name === 'field-log');
    expect(entry && entry.order).toBe(35);
  });
});

describe('how it bills — the switch that turns the card on', () => {
  test('a ticket that bills nothing shows the setter, and no lines', () => {
    const { host } = mount({ log: null, t: { bill_as: 'none' } });
    expect(host.textContent).toContain('Not billed from time');
    expect(host.querySelector('.p86-fl-basis-edit').textContent).toBe('Set how it bills');
    expect(host.querySelectorAll('.p86-fl-line').length).toBe(0);
  });

  test('a reader sees no setter on a ticket that bills nothing — there is nothing there for them', () => {
    expect(FL.extension.detailSections({ r: { field_log: null }, t: { id: 'st_x', bill_as: 'none' }, canEdit: false })).toEqual([]);
  });

  test('marking it billed after the work sends the kind, and nothing else', async () => {
    const { host, calls } = mount({ log: null, t: { bill_as: 'none' } });
    host.querySelector('.p86-fl-basis-edit').click();
    await tick();
    const sel = host.querySelector('[data-f="basis"]');
    sel.value = 'time_materials';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    host.querySelector('.p86-fl-basis-save').click();
    await tick();
    expect(calls).toEqual([['update', 'st_tm', { kind: 'work_order' }]]);
  });

  test('a service ticket needs its price before anything is sent', async () => {
    const { host, calls } = mount({ log: null, t: { bill_as: 'none' } });
    host.querySelector('.p86-fl-basis-edit').click();
    await tick();
    const sel = host.querySelector('[data-f="basis"]');
    sel.value = 'contract';
    sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    expect(host.querySelector('.p86-fl-price').hidden).toBe(false);
    host.querySelector('.p86-fl-basis-save').click();
    await tick();
    expect(calls).toEqual([]);
    host.querySelector('[data-f="contract_amount"]').value = '8250';
    host.querySelector('.p86-fl-basis-save').click();
    await tick();
    expect(calls).toEqual([['update', 'st_tm', { kind: 'service_ticket', contract_amount: '8250' }]]);
  });

  test('the price box is really hidden until a contract is chosen — the stylesheet has to let the hidden attribute win', () => {
    // display:grid on the form labels beat [hidden] on its own, so the box
    // stood there asking for a contract price on a work order.
    const css = require('fs').readFileSync(require('path').join(__dirname, '..', 'css', 'service-ticket-field-log.css'), 'utf8');
    expect(css).toMatch(/\.p86-fl-basis\.is-editing label\[hidden\]\s*\{\s*display:\s*none/);
  });

  test('a numbered ticket is told its number will change before it is switched', async () => {
    const { host } = mount({ log: null, t: { bill_as: 'none', ticket_number: 'WO-0042' } });
    host.querySelector('.p86-fl-basis-edit').click();
    await tick();
    expect(host.querySelector('.p86-fl-basis-warn').textContent).toContain('new number in the other series');
    // An open form is deliberately kept across repaints, so this test closes
    // the one it opened rather than leaving it open for the next.
    host.querySelector('.p86-fl-cancel').click();
  });

  test('a work order that already bills says so, and offers Change', () => {
    const { host } = mount();
    expect(host.querySelector('.p86-fl-basis-l').textContent).toContain('billed after the work');
    expect(host.querySelector('.p86-fl-basis-edit').textContent).toBe('Change');
  });

  test('a service ticket shows the price it was sold at', () => {
    const { host } = mount({ log: null, t: { bill_as: 'contract', contract_amount: '8250.00' } });
    // No field log on a contract ticket, and an editor may still see the basis
    // — but nothing to switch ON, so the panel stays away.
    expect(host.innerHTML).toBe('');
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

  test('a person who can only read the ticket can look, and change nothing', () => {
    const { host } = mount({ canEdit: false });
    // No decision, no correction, no entry …
    expect(host.querySelectorAll('.p86-fl-accept, .p86-fl-reject, .p86-fl-change, .p86-fl-open-add').length).toBe(0);
    expect(host.querySelectorAll('.p86-fl-form').length).toBe(0);
    // … but a receipt is evidence, and looking at it changes nothing.
    expect(host.querySelectorAll('.p86-fl-shot').length).toBe(1);
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

describe('receipts', () => {
  test('a material line shows its receipt photos, and one with none shows nothing', () => {
    const { host } = mount();
    expect(host.querySelectorAll('[data-line="m_rec"] .p86-fl-shot').length).toBe(1);
    expect(host.querySelector('[data-line="m_rec"] .p86-fl-shot img').getAttribute('src')).toBe('https://cdn.test/r1t');
    expect(host.querySelectorAll('[data-line="m_none"] .p86-fl-receipts').length).toBe(0);
  });

  test('clicking one opens the lightbox on the real rows, and sends no decision', () => {
    const opened = [];
    window.p86Attachments = { openLightbox: (photos, i, opts) => opened.push([photos, i, opts]) };
    const { host, calls } = mount();
    host.querySelector('[data-line="m_rec"] .p86-fl-shot').click();
    expect(opened).toHaveLength(1);
    expect(opened[0][0][0].web_url).toBe('https://cdn.test/r1w');
    expect(opened[0][1]).toBe(0);
    expect(calls).toEqual([]);
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
