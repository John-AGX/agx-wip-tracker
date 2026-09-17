// THE WORK-ORDER NOTIFICATIONS IN THE CATALOG, AND THEIR HEADING IN MY ACCOUNT.
//
// server/notify-events.js is the one list My Account renders and the senders
// gate on. Pinned here:
//   * the six work-order keys, contiguous, in order, grouped 'Work orders',
//     each on email and push, where ticket_approval used to sit;
//   * every other key and its channels unchanged;
//   * the preference shape the senders read: email off only when
//     notification_prefs[key] === false, push off only when
//     notification_prefs.push[key] === false;
//   * js/account.js renderPrefRows prints the group heading once, above the
//     group, and a rule where the group ends — driven from the shipped
//     function's own text in jsdom.
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');
const { extractFunction, compile } = require('./helpers/browser-fn');

jest.mock('../server/db', () => ({ pool: { query: jest.fn(async () => ({ rows: [] })) } }));
jest.mock('../server/push', () => ({ sendPush: jest.fn(async () => ({ sent: 1 })) }));

const events = require('../server/notify-events');

const WORK_ORDER_KEYS = [
  'ticket_approval', 'ticket_waiting', 'ticket_assignment', 'ticket_problem', 'ticket_crew_activity', 'work_order_digest',
];

describe('the catalog', () => {
  test('six work-order rows, contiguous and in order, where ticket_approval sat', () => {
    const keys = events.NOTIFY_EVENTS.map((e) => e.key);
    expect(keys).toEqual([
      'agent_task', 'scribe_draft', 'messages', 'task_due', 'event_reminder', 'reminder', 'schedule_assignment',
      ...WORK_ORDER_KEYS,
      'job_assignment', 'password_reset',
    ]);
  });

  test('each work-order row is grouped "Work orders" and rides email and push', () => {
    for (const key of WORK_ORDER_KEYS) {
      const ev = events.NOTIFY_EVENTS.find((e) => e.key === key);
      expect(ev.group).toBe('Work orders');
      expect(ev.channels).toEqual({ email: true, push: true });
      expect(typeof ev.label).toBe('string');
      expect(ev.desc.length).toBeGreaterThan(20);
    }
    const grouped = events.NOTIFY_EVENTS.filter((e) => e.group).map((e) => e.key);
    expect(grouped).toEqual(WORK_ORDER_KEYS);
  });

  test('labels and descriptions as worded', () => {
    const byKey = Object.fromEntries(events.NOTIFY_EVENTS.map((e) => [e.key, e]));
    expect(byKey.ticket_approval.label).toBe('Work orders to approve');
    expect(byKey.ticket_waiting.label).toBe('Work orders still waiting');
    expect(byKey.ticket_assignment.label).toBe('Work order assignments');
    expect(byKey.ticket_assignment.desc).toBe('When someone assigns a work order to you.');
    expect(byKey.ticket_problem.label).toBe('Problems flagged by crews');
    expect(byKey.ticket_crew_activity.label).toBe('Crew activity');
    expect(byKey.ticket_crew_activity.desc).toContain('At most one notice per work order every 30 minutes.');
    expect(byKey.work_order_digest.label).toBe('Work orders morning digest');
    expect(byKey.ticket_approval.desc).toContain('the company admins are told');
    expect(byKey.ticket_waiting.desc).toContain('more than 2 business days');
  });

  test('the rows that were there keep their channels', () => {
    const byKey = Object.fromEntries(events.NOTIFY_EVENTS.map((e) => [e.key, e]));
    expect(byKey.scribe_draft.channels).toEqual({ email: false, push: true });
    expect(byKey.schedule_assignment.channels).toEqual({ email: true, push: false });
    expect(byKey.job_assignment.channels).toEqual({ email: true, push: false });
    expect(byKey.password_reset.channels).toEqual({ email: true, push: false });
  });
});

describe('the preference shape', () => {
  test('push is off only when prefs.push[key] === false; the flat email key does not mute push', () => {
    expect(events.pushAllowed({}, 'ticket_problem')).toBe(true);
    expect(events.pushAllowed({ ticket_problem: false }, 'ticket_problem')).toBe(true);
    expect(events.pushAllowed({ push: { ticket_problem: false } }, 'ticket_problem')).toBe(false);
    expect(events.pushAllowed({ push: { ticket_problem: true } }, 'ticket_problem')).toBe(true);
    // There is no nested {email, push} per key.
    expect(events.pushAllowed({ ticket_problem: { push: false } }, 'ticket_problem')).toBe(true);
  });

  test('sendPushForEvent honours the push mute for a work-order key', async () => {
    const push = require('../server/push');
    push.sendPush.mockClear();
    const muted = await events.sendPushForEvent(10, 'ticket_crew_activity', { title: 't' }, { push: { ticket_crew_activity: false } });
    expect(muted).toEqual({ sent: 0, muted: true });
    expect(push.sendPush).not.toHaveBeenCalled();
    await events.sendPushForEvent(10, 'ticket_crew_activity', { title: 't' }, {});
    expect(push.sendPush).toHaveBeenCalledWith(10, { tag: 'ticket_crew_activity', title: 't' });
  });
});

describe('My Account prints the group heading', () => {
  const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'account.js'), 'utf8');

  function render(list, prefs) {
    const dom = new JSDOM('<!doctype html><div id="pane"></div>');
    const win = dom.window;
    const saved = [];
    const renderPrefRows = compile(
      [extractFunction(SRC, 'escapeHTML'), extractFunction(SRC, 'renderPrefRows')],
      ['window', 'document', 'savePrefs'],
      [win, win.document, (p) => saved.push(JSON.parse(JSON.stringify(p)))],
      'renderPrefRows'
    );
    const pane = win.document.getElementById('pane');
    renderPrefRows(pane, prefs || {}, list, true);
    return { pane, saved, win };
  }

  test('one heading above the six rows, a rule after them, none elsewhere', () => {
    const { pane } = render(events.NOTIFY_EVENTS);
    const headings = pane.querySelectorAll('.p86-pref-group');
    expect(headings).toHaveLength(1);
    expect(headings[0].textContent).toBe('Work orders');
    const children = Array.from(pane.children);
    const at = children.indexOf(headings[0]);
    const titles = children.slice(at + 1, at + 7).map((el) => el.querySelector('.p86-pref-title').textContent);
    expect(titles).toEqual([
      'Work orders to approve', 'Work orders still waiting', 'Work order assignments',
      'Problems flagged by crews', 'Crew activity', 'Work orders morning digest',
    ]);
    expect(children[at + 7].className).toBe('p86-pref-group-end');
    expect(children[at + 8].querySelector('.p86-pref-title').textContent).toBe('Job assignments');
    expect(pane.querySelectorAll('.p86-pref-group-end')).toHaveLength(1);
  });

  test('the toggles still read and write the flat email key and the nested push key', () => {
    const { pane, saved, win } = render(events.NOTIFY_EVENTS, { ticket_problem: false, push: { ticket_crew_activity: false } });
    expect(pane.querySelector('input[data-pref-email="ticket_problem"]').checked).toBe(false);
    expect(pane.querySelector('input[data-pref-push="ticket_problem"]').checked).toBe(true);
    expect(pane.querySelector('input[data-pref-push="ticket_crew_activity"]').checked).toBe(false);
    const box = pane.querySelector('input[data-pref-push="work_order_digest"]');
    box.checked = false;
    box.dispatchEvent(new win.Event('change'));
    expect(saved[saved.length - 1].push).toEqual({ ticket_crew_activity: false, work_order_digest: false });
  });

  test('a group name is escaped; a catalog with no groups prints no heading', () => {
    const { pane } = render([{ key: 'x', label: 'X', desc: 'd', group: '<b>Grp</b>', channels: { email: true, push: false } }]);
    expect(pane.querySelector('.p86-pref-group').innerHTML).toBe('&lt;b&gt;Grp&lt;/b&gt;');
    const plain = render([{ key: 'y', label: 'Y', desc: 'd', channels: { email: true, push: false } }]).pane;
    expect(plain.querySelectorAll('.p86-pref-group, .p86-pref-group-end')).toHaveLength(0);
  });

  test('MUTANT: print the heading on every grouped row and the page shows it six times', () => {
    const anchor = '      if (group && group !== prevGroup) {';
    const src = SRC.replace(/\r\n/g, '\n');
    if (src.split(anchor).length !== 2) throw new Error('anchor not found');
    const mutated = src.replace(anchor, () => '      if (group) {');
    const dom = new JSDOM('<!doctype html><div id="pane"></div>');
    const fn = compile(
      [extractFunction(mutated, 'escapeHTML'), extractFunction(mutated, 'renderPrefRows')],
      ['window', 'document', 'savePrefs'], [dom.window, dom.window.document, () => {}], 'renderPrefRows');
    const pane = dom.window.document.getElementById('pane');
    fn(pane, {}, events.NOTIFY_EVENTS, true);
    expect(pane.querySelectorAll('.p86-pref-group')).toHaveLength(6);
  });
});
