/**
 * @jest-environment jsdom
 */
// THE ERRAND IS ON THE APPROVAL CARD, NOT BEHIND THE PREVIEW BUTTON.
//
// 86 fills a pickup by READING A PHOTOGRAPH of the order confirmation
// (routes/admin-agents-routes.js AGENT_SYSTEM_BASELINE, and the door in
// services/payload-dispatcher.js). Everything a card normally shows about a
// target is its op keys, behind "⏷ Preview" — and Approve sits right beside
// that button. For an errand transcribed off a picture that is one click too
// many: a plausible wrong order number sends somebody to a Pro Desk for
// nothing, and the card is the last place to catch it.
//
// So a pickup target's store, order number, window and list are drawn into
// the card body itself. What this file proves:
//   * they are visible with nothing expanded, and BEFORE the Approve button;
//   * they are there whether or not the Scribe supplied a changeset — the
//     changeset is what the Preview block prefers, and it would otherwise
//     take the errand's place;
//   * an ordinary target draws no such block, and an applied card draws none
//     either (the task is the record by then);
//   * a junk pickup cannot stop the card rendering.
//
// The real script runs in jsdom, exactly as payload-compact-card.test.js
// drives it.
'use strict';

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'payload-artifact.js'), 'utf8');
const ORDER = '300901261260239973';

beforeEach(() => {
  document.body.innerHTML = '<div id="host"></div>';
  delete window.PayloadArtifact;
  window.fetch = jest.fn(async () => ({ ok: true, status: 200, json: async () => ({}) }));
  // eslint-disable-next-line no-eval
  window.eval(SRC);
});

const FULL = {
  store: "Lowe's", branch: 'Plant City Pro Desk', order_ref: ORDER,
  phone: '(813) 555-0100', window_start: '08:00', window_end: '12:00',
  items: [{ qty: 49, unit: 'ea', description: '96" aluminium soffit vent' },
    { qty: 4, unit: 'tube', description: 'White exterior caulk' }],
};
const task = (pickup) => ({ entity_type: 'task', ops: { op: 'create', fields: Object.assign(
  { title: "Pick up 49 soffit vents — Lowe's Plant City", kind: 'pickup', due_date: '2026-10-02' },
  pickup ? { pickup } : {}) } });
const payload = (over) => Object.assign({ id: 'pl_1', filename: 'Task.p86.json', status: 'ready',
  file_content: '{}', targets: [task(FULL)] }, over || {});

const card = (p) => window.PayloadArtifact.render(payload(p), document.getElementById('host'));
// The errand block: the one visible <pre> on the card. The Preview block is
// the other <pre> and starts display:none, which is the whole point.
const shown = (el) => Array.from(el.querySelectorAll('pre')).filter((p) => p.style.display !== 'none');

describe('the errand is readable without expanding anything', () => {
  test('store, order number, window, phone and every line are on the card', () => {
    const blocks = shown(card());
    expect(blocks).toHaveLength(1);
    const text = blocks[0].textContent;
    for (const want of ["Lowe's — Plant City Pro Desk", ORDER, '08:00–12:00', '(813) 555-0100',
      '49 ea 96" aluminium soffit vent', '4 tube White exterior caulk']) {
      expect([want, text]).toEqual([want, expect.stringContaining(want)]);
    }
  });

  test('…and it comes BEFORE the Approve button, not after it', () => {
    // Reading it should not need a scroll past the control that commits it.
    const el = card();
    const kids = Array.from(el.children);
    const block = kids.indexOf(shown(el)[0]);
    const actions = kids.findIndex((k) => Array.from(k.querySelectorAll('button'))
      .some((b) => (b.textContent || '').indexOf('Approve') !== -1));
    expect([block > -1, actions > -1, block < actions]).toEqual([true, true, true]);
  });

  test('a changeset does not take its place', () => {
    // The Preview block prefers the Scribe's dry-run changeset over the op
    // summary. The errand is drawn separately for exactly this reason: with a
    // changeset present the op summary is never rendered at all.
    const el = card({ changeset: [{ entity_type: 'task', summary: 'creates a task' }] });
    expect(shown(el)[0].textContent).toContain(ORDER);
  });

  test('the preview still starts collapsed', () => {
    const all = Array.from(card().querySelectorAll('pre'));
    expect(all).toHaveLength(2);
    expect(all.filter((p) => p.style.display === 'none')).toHaveLength(1);
  });

  test('two errands in one bundle both show, separated', () => {
    const el = card({ targets: [task(FULL), task({ store: 'Home Depot',
      items: [{ qty: 2, description: 'White exterior caulk' }] })] });
    const text = shown(el)[0].textContent;
    expect(text).toContain("Lowe's");
    expect(text).toContain('Home Depot');
    expect(text).toContain('\n\n');
  });
});

describe('and nothing else grew a block', () => {
  test('an ordinary task target draws none', () => {
    expect(shown(card({ targets: [task(null)] }))).toHaveLength(0);
  });

  test('a service ticket draws none', () => {
    expect(shown(card({ targets: [{ entity_type: 'service_ticket',
      ops: { op: 'create', fields: { title: 'Roof survey', job_id: 'j1' } } }] }))).toHaveLength(0);
  });

  test('an APPLIED card draws none — the task is the record by then', () => {
    expect(shown(card({ status: 'applied' }))).toHaveLength(0);
  });

  test('junk in the pickup cannot stop the card rendering', () => {
    for (const p of [null, 'nope', 42, [], {}, { items: 'not a list' }, { items: [null, 7, {}] },
      { store: { nested: true }, items: [{ qty: 1, description: 'x' }] }]) {
      document.getElementById('host').innerHTML = '';
      let el;
      expect(() => { el = card({ targets: [task(p)] }); }).not.toThrow();
      expect(el).toBeTruthy();
      expect(Array.from(el.querySelectorAll('button'))
        .some((b) => (b.textContent || '').indexOf('Approve') !== -1)).toBe(true);
    }
  });

  test('no raw payload id or model title leaks into the block', () => {
    // The card's own rule, and the errand block is not an exception to it.
    const el = card({ targets: [task(Object.assign({ note: 'ask for Dave' }, FULL))] });
    const text = shown(el)[0].textContent;
    expect(text).not.toContain('pl_1');
    expect(text).not.toContain('Task.p86.json');
  });
});
