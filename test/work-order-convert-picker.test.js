/**
 * @jest-environment jsdom
 */
// THE CONVERT SCREEN (js/convert-picker.js) — "what is this becoming?"
//
// The screen that asks the question the three-way convert answers. What is
// driven here is everything that is not decoration: what counts as a price,
// when Continue is offered, and when the $10k nudge appears — plus the one
// cross-file fact that can silently rot, which is that the screen and the
// server agree about where that line is.
//
// The DOM half is driven for real (jsdom) rather than asserted about strings:
// the defect worth catching is "Continue was offered for a service ticket with
// no price", and that is a property of the button, not of the source.
'use strict';

require('../js/convert-picker.js');
const picker = window.p86ConvertPicker;
const server = require('../server/services/service-ticket-convert');

afterEach(() => {
  document.body.innerHTML = '';
});

describe('the screen and the server agree where the $10k line is', () => {
  test('one number, in both files', () => {
    expect(picker.SOFT_CEILING).toBe(server.SERVICE_TICKET_SOFT_CEILING);
    expect(picker.SOFT_CEILING).toBe(10000);
  });

  test('and neither of them refuses a bigger one — it is a nudge, not a rule', () => {
    // The screen still offers Continue …
    expect(picker.priceFor('service_ticket', '250000', 0)).toBe(250000);
    // … and says so.
    expect(picker.nudgeFor('service_ticket', 250000)).toMatch(/Still your call/);
  });
});

describe('what counts as a price', () => {
  test('a dollar sign and commas are still a price', () => {
    expect(picker.readMoney('$9,350.00')).toBe(9350);
    expect(picker.readMoney('  8250 ')).toBe(8250);
    expect(picker.readMoney('.50')).toBe(0.5);
    expect(picker.readMoney('0')).toBe(0);
  });

  test('and what is not one answers null rather than NaN or zero', () => {
    for (const bad of ['', '   ', 'abc', '12.345', '-1', '1e6', null, undefined]) {
      expect(picker.readMoney(bad)).toBeNull();
    }
  });
});

describe('a service ticket is only offered when it has a price', () => {
  test('typed beats the estimate; blank falls back to it', () => {
    expect(picker.priceFor('service_ticket', '9000', 9350)).toBe(9000);
    expect(picker.priceFor('service_ticket', '', 9350)).toBe(9350);
    expect(picker.priceFor('service_ticket', '   ', 9350)).toBe(9350);
  });

  test('no estimate and nothing typed is NOT a price', () => {
    expect(picker.priceFor('service_ticket', '', 0)).toBeNull();
    expect(picker.priceFor('service_ticket', 'nope', 0)).toBeNull();
  });

  test('the other two kinds are never priced here', () => {
    expect(picker.priceFor('work_order', '500', 9350)).toBeNull();
    expect(picker.priceFor('job', '500', 9350)).toBeNull();
    expect(picker.priceFor(null, '500', 9350)).toBeNull();
  });
});

describe('the nudge', () => {
  test('appears on a service ticket over the line, and names the number', () => {
    expect(picker.nudgeFor('service_ticket', 12400)).toMatch(/\$12,400\.00/);
    expect(picker.nudgeFor('service_ticket', 12400)).toMatch(/usually a job/);
  });

  test('never on the line itself or under it', () => {
    expect(picker.nudgeFor('service_ticket', 10000)).toBe('');
    expect(picker.nudgeFor('service_ticket', 9999.99)).toBe('');
  });

  test('and never on a work order or a job, whatever the number', () => {
    expect(picker.nudgeFor('work_order', 99999)).toBe('');
    expect(picker.nudgeFor('job', 99999)).toBe('');
    expect(picker.nudgeFor('service_ticket', null)).toBe('');
  });
});

// ── the screen itself ───────────────────────────────────────────────────

function openPicker(opts) {
  const done = picker.open(opts || {});
  return { done: done, root: document.querySelector('.p86-convert-modal') };
}
const cardFor = (root, key) => root.querySelector('[data-cv="' + key + '"]');
const ok = (root) => root.querySelector('#p86cvOk');
const nudge = (root) => root.querySelector('#p86cvNudge');
const amount = (root) => root.querySelector('#p86cvAmount');
const priceBox = (root) => root.querySelector('#p86cvPrice');

function type(el, value) {
  el.value = value;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

describe('the screen offers all three, and nothing before a choice', () => {
  test('three cards, and Continue is dead until one is picked', async () => {
    const { root, done } = openPicker({ leadTitle: 'Building 4 stair treads' });
    expect(root.querySelectorAll('[data-cv]').length).toBe(3);
    for (const key of ['job', 'service_ticket', 'work_order']) {
      expect(cardFor(root, key)).toBeTruthy();
    }
    expect(ok(root).disabled).toBe(true);
    root.querySelector('#p86cvCancel').click();
    await expect(done).resolves.toBeNull();
  });

  test('the lead and its estimate are named at the top', () => {
    const { root } = openPicker({ leadTitle: 'Gate motor down', hasEstimate: true, estimateTotal: 9350 });
    expect(root.textContent).toContain('Gate motor down');
    expect(root.textContent).toContain('$9,350.00');
  });

  test('and a lead with no estimate says so rather than showing nothing', () => {
    const { root } = openPicker({ leadTitle: 'Roof leak' });
    expect(root.textContent).toContain('no estimate attached');
  });
});

describe('picking a work order', () => {
  test('offers Continue at once, asks for no price, and resolves without one', async () => {
    const { root, done } = openPicker({ leadTitle: 'Gate motor down' });
    cardFor(root, 'work_order').click();
    expect(ok(root).disabled).toBe(false);
    expect(priceBox(root).style.display).toBe('none');
    ok(root).click();
    await expect(done).resolves.toEqual({ target: 'work_order', contractAmount: null });
  });
});

describe('picking a service ticket', () => {
  test('with an estimate: Continue at once, and the price is left to the estimate', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs', hasEstimate: true, estimateTotal: 9350 });
    cardFor(root, 'service_ticket').click();
    expect(priceBox(root).style.display).not.toBe('none');
    expect(ok(root).disabled).toBe(false);
    ok(root).click();
    // contractAmount stays null on purpose: the server reads the number off
    // the estimate, so the ticket and the proposal cannot disagree about it.
    await expect(done).resolves.toEqual({ target: 'service_ticket', contractAmount: null });
  });

  test('with NO estimate: Continue stays dead until a price is typed', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs' });
    cardFor(root, 'service_ticket').click();
    expect(ok(root).disabled).toBe(true);
    type(amount(root), 'not a price');
    expect(ok(root).disabled).toBe(true);
    type(amount(root), '$2,500');
    expect(ok(root).disabled).toBe(false);
    ok(root).click();
    await expect(done).resolves.toEqual({ target: 'service_ticket', contractAmount: 2500 });
  });

  test('a typed price is carried, and it overrides the estimate', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs', hasEstimate: true, estimateTotal: 9350 });
    cardFor(root, 'service_ticket').click();
    type(amount(root), '9000');
    ok(root).click();
    await expect(done).resolves.toEqual({ target: 'service_ticket', contractAmount: 9000 });
  });

  test('the nudge appears over the line and goes away under it, without blocking', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs' });
    cardFor(root, 'service_ticket').click();
    type(amount(root), '12400');
    expect(nudge(root).style.display).not.toBe('none');
    expect(nudge(root).textContent).toContain('$12,400.00');
    expect(ok(root).disabled).toBe(false);          // a nudge, never a block
    type(amount(root), '8000');
    expect(nudge(root).style.display).toBe('none');
    ok(root).click();
    await expect(done).resolves.toEqual({ target: 'service_ticket', contractAmount: 8000 });
  });

  test('switching to a work order takes the price box and the nudge with it', () => {
    const { root } = openPicker({ leadTitle: 'Stairs' });
    cardFor(root, 'service_ticket').click();
    type(amount(root), '12400');
    expect(nudge(root).style.display).not.toBe('none');
    cardFor(root, 'work_order').click();
    expect(priceBox(root).style.display).toBe('none');
    expect(nudge(root).style.display).toBe('none');
    expect(ok(root).disabled).toBe(false);
  });
});

describe('picking a job', () => {
  test('resolves to the road that already existed, with no price of its own', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs', hasEstimate: true, estimateTotal: 9350 });
    cardFor(root, 'job').click();
    expect(priceBox(root).style.display).toBe('none');
    ok(root).click();
    await expect(done).resolves.toEqual({ target: 'job', contractAmount: null });
  });
});

describe('cancelling', () => {
  test('the backdrop closes it with no choice made', async () => {
    const { root, done } = openPicker({ leadTitle: 'Stairs' });
    cardFor(root, 'work_order').click();
    root.click();                                    // the backdrop itself
    await expect(done).resolves.toBeNull();
    expect(document.querySelector('.p86-convert-modal')).toBeNull();
  });
});
