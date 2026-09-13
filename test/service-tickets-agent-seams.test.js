/**
 * @jest-environment jsdom
 */
// S7, the client side of an agent-drafted service ticket.
//
// Four seams, each driven through the REAL browser source rather than a
// reading of it:
//
//   1. js/service-tickets.js refresh() repaints whichever surface is mounted.
//      It used to return early with no job in view, so a ticket 86 drafted on
//      a LEAD never appeared on the lead panel.
//   2. The same refresh must not repaint an open work order out from under the
//      PM (caret in it, or a field changed and not saved), and a refused
//      refresh is remembered, not dropped.
//   3. "Draft with 86" / "Ask 86" seed an UNSENT prompt through the AI panel's
//      public seam, name the parent by forward-facing name, and are offered
//      only where the user may act.
//   4. js/refresh.js routes a service_ticket write to that refresh exactly
//      once, and js/voice-output.js speaks a [service_ticket, task, task]
//      bundle as one work order with its tasks.
//
// WHY EVERY DRIVE TAKES A SOURCE STRING. Each guard below is also shown to
// FIRE: the drive is re-run against a copy of the shipped file with that guard
// broken, and the outcome has to come out wrong. A test that stays green with
// its guard removed is evidence of nothing. The files are CRLF on disk, so a
// mutation anchored on a literal written here could silently match nothing
// and hand back the shipped code; mutate() normalizes EOL first and FAILS when
// the bytes did not move.
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8').replace(/\r\n/g, '\n');
const TICKETS_SRC = read('js/service-tickets.js');
const REFRESH_SRC = read('js/refresh.js');
const VOICE_SRC = read('js/voice-output.js');
const JOB_LABEL = require('../js/job-label.js');

function mutate(src, from, to) {
  const at = src.indexOf(from);
  if (at === -1) throw new Error('MUTATION ANCHOR NOT FOUND: ' + from);
  if (src.indexOf(from, at + from.length) !== -1) throw new Error('MUTATION ANCHOR NOT UNIQUE: ' + from);
  const out = src.slice(0, at) + to + src.slice(at + from.length);
  if (out === src) throw new Error('MUTATION DID NOT CHANGE THE SOURCE: ' + from);
  return out;
}

const tick = () => new Promise((r) => setTimeout(r, 0));
async function flush() { for (let i = 0; i < 5; i++) await tick(); }

const TICKET = () => ({
  id: 'st_901', ticket_number: 'ST-0012', title: 'Gate will not latch',
  status: 'open', priority: 'normal', job_id: 'job_77', lead_id: null,
  scope_proposed: 'Rehang the gate', scheduled_for: null, due_date: null,
});

// A fresh page for one drive. Every global the module reads at call time is
// set here, so no drive inherits another's state.
function env(opts) {
  const o = opts || {};
  document.body.innerHTML = '<div id="job-service-tickets"></div><div id="lead-host"></div>';
  const job = { id: 'job_77', jobNumber: 'RV2006', title: 'Waterside 1 Siding Replacement' };
  if (o.jobCanEdit === false) job._canEdit = false;
  const store = { job: [], lead: [] };
  const calls = [];
  window.appState = { currentJobId: null };
  window.appData = {
    jobs: [job],
    leads: [{ id: 'lead_42', title: 'Harbor Pointe roof leak', street_address: '12 Bay St', city: 'Tampa' }],
  };
  window.p86JobLabel = JOB_LABEL;
  window.p86Api = {
    serviceTickets: {
      list: jest.fn((q) => {
        calls.push(Object.assign({}, q));
        return Promise.resolve({ tickets: (q.job_id ? store.job : store.lead).slice() });
      }),
      get: jest.fn((id) => Promise.resolve({
        ticket: store.job.concat(store.lead).find((t) => t.id === id),
        tasks: [], events: [], revisions: [], participants: [],
      })),
    },
  };
  const caps = new Set(o.caps || ['LEADS_EDIT']);
  window.p86Auth = { hasCapability: (k) => caps.has(k) };
  window.p86AI = o.noAi ? undefined : { ask: jest.fn(), open: jest.fn() };
  window.p86Toast = jest.fn();
  window.alert = jest.fn();
  window.confirm = jest.fn();
  delete window.p86ServiceTickets;
  delete window.renderJobServiceTickets;
  return { store, calls, job };
}

function load(src) { window.eval(src); }

const jobCalls = (calls) => calls.filter((c) => c.job_id).length;
const leadCalls = (calls) => calls.filter((c) => c.lead_id).length;

async function openJob(e) {
  window.appState.currentJobId = 'job_77';
  window.renderJobServiceTickets('job_77');
  await flush();
}

async function expandFirst() {
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return document.querySelector('#job-service-tickets .p86-st-row.is-open .p86-st-detail');
}

// ── 1. refresh repaints whichever surface is mounted ──────────────────────
async function driveLeadRefresh(src) {
  const e = env();
  load(src);
  const host = document.getElementById('lead-host');
  await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42', { id: 'lead_42', title: 'Harbor Pointe roof leak' });
  await flush();
  const before = host.textContent;
  e.store.lead.push(Object.assign(TICKET(), { id: 'st_902', job_id: null, lead_id: 'lead_42', title: 'Soffit sagging at gable' }));
  window.p86ServiceTickets.refresh();
  const during = host.textContent;
  await flush();
  return { before, during, after: host.textContent, leadCalls: leadCalls(e.calls), jobCalls: jobCalls(e.calls) };
}

describe('refresh() repaints whichever surface is mounted', () => {
  test('a LEAD-parented ticket repaints the lead panel with no job in view', async () => {
    const r = await driveLeadRefresh(TICKETS_SRC);
    expect(r.before).toContain('No service tickets on this lead.');
    expect(r.after).toContain('Soffit sagging at gable');
    expect(r.leadCalls).toBe(2);
    expect(r.jobCalls).toBe(0);
  });

  test('the refresh is QUIET — the list being read is not blanked to Loading while it refetches', async () => {
    const r = await driveLeadRefresh(TICKETS_SRC);
    expect(r.during).not.toMatch(/Loading/);
  });

  test('the job manager repaints when its job is the one on screen', async () => {
    const e = env();
    load(TICKETS_SRC);
    await openJob(e);
    e.store.job.push(TICKET());
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(document.getElementById('job-service-tickets').textContent).toContain('Gate will not latch');
    expect(jobCalls(e.calls)).toBe(2);
  });

  test('a converted ticket on BOTH surfaces repaints both', async () => {
    const e = env();
    load(TICKETS_SRC);
    await openJob(e);
    await window.p86ServiceTickets.mountLeadPanel(document.getElementById('lead-host'), 'lead_42');
    await flush();
    const both = Object.assign(TICKET(), { lead_id: 'lead_42' });
    e.store.job.push(both);
    e.store.lead.push(both);
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(document.getElementById('job-service-tickets').textContent).toContain('Gate will not latch');
    expect(document.getElementById('lead-host').textContent).toContain('Gate will not latch');
  });

  test('a job the user has LEFT is not refetched — _state.jobId outlives the page', async () => {
    const e = env();
    load(TICKETS_SRC);
    await openJob(e);
    window.appState.currentJobId = null;
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(jobCalls(e.calls)).toBe(1);
  });

  test('a failed BACKGROUND refetch keeps the rows on screen instead of an error nobody asked for', async () => {
    const e = env();
    e.store.lead.push(Object.assign(TICKET(), { job_id: null, lead_id: 'lead_42' }));
    load(TICKETS_SRC);
    const host = document.getElementById('lead-host');
    await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42');
    await flush();
    window.p86Api.serviceTickets.list = jest.fn(() => Promise.reject(new Error('network down')));
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    await window.p86ServiceTickets.refresh();
    await flush();
    warn.mockRestore();
    expect(host.textContent).toContain('Gate will not latch');
    expect(host.textContent).not.toContain('network down');
  });

  test('a lead panel no longer in the document is not refetched', async () => {
    const e = env();
    load(TICKETS_SRC);
    const host = document.getElementById('lead-host');
    await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42');
    await flush();
    host.remove();
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(leadCalls(e.calls)).toBe(1);
  });
});

// ── 2. an open work order is not repainted out from under the PM ──────────
async function driveOpenTicket(src, how) {
  const e = env();
  e.store.job.push(TICKET());
  load(src);
  await openJob(e);
  const detail = await expandFirst();
  const scope = detail.querySelector('.p86-st-scope');
  if (how === 'typed-and-left') scope.value = 'Rehang the gate and replace the latch';
  if (how === 'focused') scope.focus();
  const n0 = jobCalls(e.calls);
  await window.p86ServiceTickets.refresh();
  await flush();
  const refetchedNow = jobCalls(e.calls) > n0;
  const scopeSurvived = !!document.querySelector('.p86-st-scope') &&
    document.querySelector('.p86-st-scope').value === scope.value;
  // Collapse the ticket: the edits go with it, so the deferred refresh is due.
  if (how === 'focused') scope.blur();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return { refetchedNow, scopeSurvived, refetchedAfterCollapse: jobCalls(e.calls) > n0 };
}

describe('an open ticket holding edits is not repainted, and the refresh is not lost', () => {
  test('a scope typed and not saved survives a background refresh', async () => {
    const r = await driveOpenTicket(TICKETS_SRC, 'typed-and-left');
    expect(r.refetchedNow).toBe(false);
    expect(r.scopeSurvived).toBe(true);
  });

  test('...and the refused refresh runs once the ticket is collapsed', async () => {
    const r = await driveOpenTicket(TICKETS_SRC, 'typed-and-left');
    expect(r.refetchedAfterCollapse).toBe(true);
  });

  test('the caret in the scope refuses the repaint too', async () => {
    const r = await driveOpenTicket(TICKETS_SRC, 'focused');
    expect(r.refetchedNow).toBe(false);
  });

  test('an open ticket with NO edits still refreshes — selects with no `selected` attribute are not dirty', async () => {
    const r = await driveOpenTicket(TICKETS_SRC, 'clean');
    expect(r.refetchedNow).toBe(true);
  });

  test('a share link just minted survives a background refresh — it can never be shown again', async () => {
    const r = await driveMintedLink(TICKETS_SRC);
    // Precondition: the drive really minted and showed the link, with the share
    // panel open and nothing typed in it (so no OTHER rule is what holds).
    expect(r.linkShownBefore).toBe(ONE_TIME_LINK);
    expect(r.panelOpenNothingTyped).toBe(true);
    expect(r.refetchedNow).toBe(false);
    expect(r.linkAfterRefresh).toBe(ONE_TIME_LINK);
  });

  test('...and the refresh it deferred runs once the ticket is collapsed', async () => {
    const r = await driveMintedLink(TICKETS_SRC);
    expect(r.refetchedAfterCollapse).toBe(true);
  });

  test('an open share panel with NO link minted does not hold the refresh', async () => {
    const r = await driveMintedLink(TICKETS_SRC, { mint: false });
    expect(r.panelOpenNothingTyped).toBe(true);
    expect(r.refetchedNow).toBe(true);
  });
});

// The minted link is the one thing on the row that is neither a caret nor an
// unsaved value: its input is readonly and nothing is typed to mint it (email
// and name are optional). The Copy click then fires focusout, which flushes the
// latch — so the refresh is driven through that exact path as well as directly.
const ONE_TIME_LINK = 'https://app.example/st/share/tok_shown_once';
async function driveMintedLink(src, opts) {
  const o = opts || {};
  const e = env();
  e.store.job.push(TICKET());
  window.p86Api.serviceTickets.shares = jest.fn(() => Promise.resolve({ shares: [] }));
  window.p86Api.serviceTickets.share = jest.fn(() => Promise.resolve({ link: ONE_TIME_LINK, email_sent: false }));
  load(src);
  await openJob(e);
  const detail = await expandFirst();
  detail.querySelector('.p86-st-share').click();
  await flush();
  const panel = document.querySelector('.p86-st-sharewrap');
  const panelOpenNothingTyped = !!panel && !panel.hidden &&
    panel.querySelector('.p86-st-share-email').value === '' &&
    panel.querySelector('.p86-st-share-name').value === '';
  if (o.mint !== false) {
    document.querySelector('.p86-st-share-go').click();
    await flush();
  }
  const shown = () => {
    const inp = document.querySelector('#job-service-tickets .p86-st-share-out input');
    return inp ? inp.value : null;
  };
  const linkShownBefore = shown();
  const n0 = jobCalls(e.calls);
  await window.p86ServiceTickets.refresh();
  await flush();
  // The Copy click's focusout retries the latch; it must not flush it either.
  const pane = document.getElementById('job-service-tickets');
  pane.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
  await flush();
  const refetchedNow = jobCalls(e.calls) > n0;
  const linkAfterRefresh = shown();
  document.querySelector('#job-service-tickets .p86-st-row-head').click();
  await flush();
  return {
    linkShownBefore, panelOpenNothingTyped, refetchedNow, linkAfterRefresh,
    refetchedAfterCollapse: jobCalls(e.calls) > n0,
  };
}

// ── 3. the 86 hand-offs ────────────────────────────────────────────────────
async function driveDraftOnJob(src, opts) {
  const e = env(opts);
  load(src);
  await openJob(e);
  const btn = document.querySelector('#job-service-tickets .p86-st-draft86');
  if (btn) btn.click();
  return { btn: !!btn, asks: window.p86AI ? window.p86AI.ask.mock.calls : [] };
}

async function driveDraftOnLead(src, opts) {
  env(opts);
  load(src);
  const host = document.getElementById('lead-host');
  await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42', { id: 'lead_42', title: 'Harbor Pointe roof leak' });
  await flush();
  const btn = host.querySelector('.p86-st-draft86');
  if (btn) btn.click();
  return { btn: !!btn, asks: window.p86AI ? window.p86AI.ask.mock.calls : [] };
}

async function driveAskOnTicket(src, status) {
  const e = env();
  e.store.job.push(Object.assign(TICKET(), { status: status || 'open' }));
  load(src);
  await openJob(e);
  const detail = await expandFirst();
  const btn = detail.querySelector('.p86-st-ask86');
  if (btn) btn.click();
  return { btn: !!btn, asks: window.p86AI.ask.mock.calls, save: !!detail.querySelector('.p86-st-save') };
}

describe('Draft with 86 — job manager', () => {
  test('seeds an UNSENT prompt against the job, naming it by number and title', async () => {
    const r = await driveDraftOnJob(TICKETS_SRC);
    expect(r.btn).toBe(true);
    expect(r.asks).toHaveLength(1);
    const [prompt, opts] = r.asks[0];
    expect(prompt).toContain('Draft a service ticket on job RV2006 Waterside 1 Siding Replacement.');
    expect(prompt).toMatch(/scope of work/);
    expect(prompt).toMatch(/scheduled/);
    expect(prompt).toMatch(/child tasks/);
    expect(opts).toEqual({ entityType: 'job', entityId: 'job_77', autoSend: false });
  });

  test('never writes the raw job id into the text the PM and the model read', async () => {
    const r = await driveDraftOnJob(TICKETS_SRC);
    expect(r.asks[0][0]).not.toContain('job_77');
  });

  test('is not offered on a job the user cannot edit', async () => {
    const r = await driveDraftOnJob(TICKETS_SRC, { jobCanEdit: false });
    expect(r.btn).toBe(false);
  });

  test('is not offered where the AI panel is not loaded', async () => {
    const r = await driveDraftOnJob(TICKETS_SRC, { noAi: true });
    expect(r.btn).toBe(false);
  });

  test('if the panel disappears before the click it says so in-app — never a native dialog', async () => {
    env();
    load(TICKETS_SRC);
    await openJob();
    const btn = document.querySelector('#job-service-tickets .p86-st-draft86');
    delete window.p86AI;
    btn.click();
    expect(window.p86Toast).toHaveBeenCalledWith(expect.stringMatching(/86 is not available/), 'error');
    expect(window.alert).not.toHaveBeenCalled();
    expect(window.confirm).not.toHaveBeenCalled();
  });
});

describe('Draft with 86 — lead panel', () => {
  test('seeds an UNSENT prompt naming the lead by title, with its address to tell look-alikes apart', async () => {
    const r = await driveDraftOnLead(TICKETS_SRC);
    expect(r.btn).toBe(true);
    const [prompt, opts] = r.asks[0];
    expect(prompt).toContain('Draft a service ticket on the lead "Harbor Pointe roof leak" at 12 Bay St, Tampa.');
    expect(prompt).not.toContain('lead_42');
    expect(opts.autoSend).toBe(false);
  });

  test('does NOT open the panel in lead mode, which sends no current_context', async () => {
    const r = await driveDraftOnLead(TICKETS_SRC);
    expect(r.asks[0][1].entityType).toBeUndefined();
  });

  test('needs LEADS_EDIT, the same gate as the lead header button', async () => {
    const r = await driveDraftOnLead(TICKETS_SRC, { caps: ['LEADS_VIEW'] });
    expect(r.btn).toBe(false);
  });
});

describe('Ask 86 on an open ticket', () => {
  test('seeds a prompt to read THAT ticket by number, title and id, on the job by name', async () => {
    const r = await driveAskOnTicket(TICKETS_SRC);
    expect(r.btn).toBe(true);
    const [prompt, opts] = r.asks[0];
    expect(prompt).toContain('Read service ticket ST-0012 "Gate will not latch" (ticket id st_901) on job RV2006 Waterside 1 Siding Replacement');
    expect(opts).toEqual({ entityType: 'job', entityId: 'job_77', autoSend: false });
  });

  test('is a read, so a CLOSED ticket (no edit controls) still offers it', async () => {
    const r = await driveAskOnTicket(TICKETS_SRC, 'closed');
    expect(r.save).toBe(false);
    expect(r.btn).toBe(true);
  });
});

// ── 4. the registry entry and the spoken read-back ─────────────────────────
async function driveRegistryBundle(refreshSrc) {
  const e = env();
  load(TICKETS_SRC);
  delete window.p86Refresh;
  load(refreshSrc);
  await window.p86ServiceTickets.mountLeadPanel(document.getElementById('lead-host'), 'lead_42');
  await flush();
  const spy = jest.spyOn(window.p86ServiceTickets, 'refresh');
  window.p86Tasks = { refresh: jest.fn() };
  window.p86Refresh.fromTargets([
    { entity_type: 'service_ticket', entity_id: 'st_902' },
    { entity_type: 'task', entity_id: 't_1' },
    { entity_type: 'task', entity_id: 't_2' },
  ], 'pl_s7_bundle');
  await window.p86Refresh.flush();
  await flush();
  const out = {
    ticketRefreshes: spy.mock.calls.length,
    taskRefreshes: window.p86Tasks.refresh.mock.calls.length,
    leadCalls: leadCalls(e.calls),
  };
  delete window.p86Tasks;
  return out;
}

describe('js/refresh.js — a service_ticket write reaches the ticket surfaces once', () => {
  test('a [service_ticket, task, task] bundle refreshes the ticket pane ONCE and the task surfaces ONCE', async () => {
    const r = await driveRegistryBundle(REFRESH_SRC);
    expect(r.ticketRefreshes).toBe(1);
    expect(r.taskRefreshes).toBe(1);
    expect(r.leadCalls).toBe(2);   // the mount, then the refetch the write caused
  });
});

function speak(src, targets) {
  load(src);
  return window.p86VoiceOutput.buildConfirmation({ affected_targets: targets });
}
const T = (entity_type, extra) => Object.assign({ entity_type, entity_id: entity_type + '_x' }, extra || {});

describe('js/voice-output.js — a ticket bundle is one work order and its tasks', () => {
  test('[service_ticket, task, task] is not "3 tasks added" and not "3 service tickets"', () => {
    const line = speak(VOICE_SRC, [T('service_ticket', { title: 'Gate will not latch' }), T('task'), T('task')]);
    expect(line).toBe('Got it — service ticket created for Gate will not latch, with 2 tasks.');
  });

  test('target ORDER does not change the sentence — a child first is still the ticket', () => {
    const line = speak(VOICE_SRC, [T('task', { title: 'Replace latch' }), T('task'), T('service_ticket', { title: 'Gate will not latch' })]);
    expect(line).toBe('Got it — service ticket created for Gate will not latch, with 2 tasks.');
  });

  test('a lone ticket and a plural bundle both read correctly', () => {
    expect(speak(VOICE_SRC, [T('service_ticket', { title: 'Gate will not latch' })]))
      .toBe('Got it — service ticket created for Gate will not latch.');
    expect(speak(VOICE_SRC, [T('service_ticket'), T('service_ticket'), T('task')]))
      .toBe('Got it — 2 service tickets created, with 1 task.');
  });

  test('tasks added to an EXISTING ticket are not read back as a new ticket', () => {
    // The shape the dispatcher's receipt carries on an update (op / updated).
    const line = speak(VOICE_SRC, [
      T('service_ticket', { title: 'Gate will not latch', op: 'update', updated: true, created: false }),
      T('task', { rolled_up: true }),
    ]);
    expect(line).toBe('Got it — service ticket updated for Gate will not latch, 1 task added.');
  });

  test('a plain task bundle is spoken exactly as before', () => {
    expect(speak(VOICE_SRC, [T('task'), T('task')])).toBe('Got it — 2 tasks added.');
  });

  test('an UPDATE applied through the Live Writer door is not read back as a new ticket', () => {
    // That door has no receipt: targets carry type and id only, so the changeset
    // is the one thing that knows the ticket already existed.
    const line = speakDetail(VOICE_SRC, liveWriterDetail([
      CS('service_ticket', 'st_901', { title: 'Gate will not latch' }, { title: 'Gate will not latch', scope_proposed: 'Rehang' }),
      CS('task', 'tk_1', null, { title: 'Replace latch' }),
    ]));
    expect(line).toBe('Got it — service ticket updated, 1 task added.');
  });

  test('a CREATE through the Live Writer door is still a new ticket (before is null)', () => {
    const line = speakDetail(VOICE_SRC, liveWriterDetail([
      CS('service_ticket', 'st_902', null, { title: 'Gate will not latch' }),
      CS('task', 'tk_1', null, { title: 'Replace latch' }),
    ]));
    expect(line).toBe('Got it — service ticket created, with 1 task.');
  });

  test('another ticket edited in the same changeset does not lend its edit to a new one', () => {
    const line = speakDetail(VOICE_SRC, {
      affected_targets: [T('service_ticket', { entity_id: 'st_new' }), T('task')],
      apply_changeset: [
        CS('service_ticket', 'st_old', { title: 'Old' }, { title: 'Old' }),
        CS('service_ticket', 'st_new', null, { title: 'New' }),
      ],
    });
    expect(line).toBe('Got it — service ticket created, with 1 task.');
  });

  test('a target with no id takes any existing entry of its type', () => {
    const line = speakDetail(VOICE_SRC, {
      affected_targets: [{ entity_type: 'service_ticket' }],
      apply_changeset: [CS('service_ticket', 'st_901', { title: 'Old' }, { title: 'Old' })],
    });
    expect(line).toBe('Got it — service ticket updated.');
  });
});

function speakDetail(src, detail) {
  load(src);
  return window.p86VoiceOutput.buildConfirmation(detail);
}
const CS = (entity_type, id, before, after) => ({ entity_type, id, before, after });
// Exactly what js/live-writer.js dispatches as p86:payload-applied for a
// server-side / approve-in-chat apply: targets rebuilt from the changeset.
function liveWriterDetail(changeset) {
  return {
    payload_id: 'pl_1', title: '', emitting_agent_key: 'scribe', apply_summary: '',
    affected_targets: changeset.map((e) => ({ entity_type: e.entity_type, entity_id: e.id })),
    apply_changeset: changeset,
  };
}

// ── the guards above, each shown to FIRE ─────────────────────────────────────
describe('mutation: each guard, broken, turns its drive wrong', () => {
  test('M1 drop the lead arm of refresh() → the lead panel never repaints', async () => {
    const m = mutate(TICKETS_SRC, 'if (leadPanelMounted() && api()) {', 'if (false) {');
    const r = await driveLeadRefresh(m);
    expect(r.after).not.toContain('Soffit sagging at gable');
  });

  test('M2 trust _state.jobId alone → a job the user left is refetched', async () => {
    const m = mutate(TICKETS_SRC,
      'return cur != null && String(cur) === String(_state.jobId);', 'return true;');
    const e = env();
    load(m);
    await openJob(e);
    window.appState.currentJobId = null;
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(jobCalls(e.calls)).toBe(2);
  });

  test('M3 compare focus only, not unsaved values → a typed scope is repainted away', async () => {
    const m = mutate(TICKETS_SRC,
      '} else if (f.value !== f.defaultValue) {\n        return true;\n      }', '}');
    const r = await driveOpenTicket(m, 'typed-and-left');
    expect(r.refetchedNow).toBe(true);
    expect(r.scopeSurvived).toBe(false);
  });

  test('M4 per-option defaultSelected → every untouched select reads dirty and no open ticket ever refreshes', async () => {
    const m = mutate(TICKETS_SRC,
      'if (f.selectedIndex !== def) return true;',
      'for (var k = 0; k < f.options.length; k++) { if (f.options[k].selected !== f.options[k].defaultSelected) return true; }');
    const r = await driveOpenTicket(m, 'clean');
    expect(r.refetchedNow).toBe(false);
  });

  test('M5 drop the latch → the refused refresh is lost and the list stays stale after collapse', async () => {
    const m = mutate(TICKETS_SRC,
      'if (_state.busy || detailHoldsEdits(host)) _state.stale = true;',
      'if (_state.busy || detailHoldsEdits(host)) { /* dropped */ }');
    const r = await driveOpenTicket(m, 'typed-and-left');
    expect(r.refetchedAfterCollapse).toBe(false);
  });

  test('M6 Draft button without the edit gate → offered on a job the user cannot edit', async () => {
    const m = mutate(TICKETS_SRC, '(canEdit && aiAsk()', '(aiAsk()');
    const r = await driveDraftOnJob(m, { jobCanEdit: false });
    expect(r.btn).toBe(true);
  });

  test('M7 name the lead by id → the raw id reaches the prompt', async () => {
    const m = mutate(TICKETS_SRC,
      "(name ? 'the lead \"' + name + '\"' : 'this lead')", "('lead ' + leadId)");
    const r = await driveDraftOnLead(m);
    expect(r.asks[0][0]).toContain('lead_42');
  });

  test('M8 open the lead draft in lead mode → the context-less mode is used', async () => {
    const m = mutate(TICKETS_SRC,
      'ai.ask(draftPromptForLead(leadId, lead), { autoSend: false });',
      "ai.ask(draftPromptForLead(leadId, lead), { entityType: 'lead', entityId: leadId, autoSend: false });");
    const r = await driveDraftOnLead(m);
    expect(r.asks[0][1].entityType).toBe('lead');
  });

  test('M9 gate Ask 86 behind edit → a closed ticket loses it', async () => {
    const m = mutate(TICKETS_SRC, "((canEdit || aiAsk()) ? '<div class=\"p86-st-actions\">' +",
      "(canEdit ? '<div class=\"p86-st-actions\">' +");
    const r = await driveAskOnTicket(m, 'closed');
    expect(r.btn).toBe(false);
  });

  test('M10 ticket path also in TASK_PATHS → the ticket pane repaints TWICE per bundle', async () => {
    const m = mutate(REFRESH_SRC, "var TASK_PATHS = ['p86Tasks.refresh',",
      "var TASK_PATHS = ['p86ServiceTickets.refresh', 'p86Tasks.refresh',");
    const r = await driveRegistryBundle(m);
    expect(r.ticketRefreshes).toBe(2);
  });

  test('M11 no registry entry → an approved ticket moves no surface', async () => {
    const m = mutate(REFRESH_SRC, "service_ticket: surfaceEntry(['p86ServiceTickets.refresh'])",
      "service_ticket_gone: surfaceEntry(['p86ServiceTickets.refresh'])");
    const r = await driveRegistryBundle(m);
    expect(r.ticketRefreshes).toBe(0);
    expect(r.leadCalls).toBe(1);
  });

  test('M13 refresh through mountLeadPanel → the list being read blanks to Loading', async () => {
    const m = mutate(TICKETS_SRC,
      'work.push(loadLeadPanel(_leadPanel.host, _leadPanel.leadId, true));',
      'work.push(mountLeadPanel(_leadPanel.host, _leadPanel.leadId));');
    const r = await driveLeadRefresh(m);
    expect(r.during).toMatch(/Loading/);
  });

  test('M14 caret check gone → a focused, unchanged scope is repainted', async () => {
    const m = mutate(TICKETS_SRC, 'if (holdsCaret(open)) return true;', '');
    const r = await driveOpenTicket(m, 'focused');
    expect(r.refetchedNow).toBe(true);
  });

  test('M15 quiet refetch failure shown anyway → the rows are replaced by an error', async () => {
    const m = mutate(TICKETS_SRC, '      if (quiet) {\n', '      if (false) {\n');
    const e = env();
    e.store.lead.push(Object.assign(TICKET(), { job_id: null, lead_id: 'lead_42' }));
    load(m);
    const host = document.getElementById('lead-host');
    await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42');
    await flush();
    window.p86Api.serviceTickets.list = jest.fn(() => Promise.reject(new Error('network down')));
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(host.textContent).toContain('network down');
  });

  test('M16 no isConnected check → a detached lead panel is still refetched', async () => {
    const m = mutate(TICKETS_SRC, 'return !!(h && _leadPanel.leadId && h.isConnected);',
      'return !!(h && _leadPanel.leadId);');
    const e = env();
    load(m);
    const host = document.getElementById('lead-host');
    await window.p86ServiceTickets.mountLeadPanel(host, 'lead_42');
    await flush();
    host.remove();
    await window.p86ServiceTickets.refresh();
    await flush();
    expect(leadCalls(e.calls)).toBe(2);
  });

  test('M17 ignore the receipt op → an edit is announced as a new ticket', () => {
    const m = mutate(VOICE_SRC,
      "var edited = !!(firstParent && (firstParent.updated === true || firstParent.op === 'update'));",
      'var edited = false;');
    const line = speak(m, [T('service_ticket', { title: 'Gate will not latch', op: 'update', updated: true }), T('task')]);
    expect(line).toBe('Got it — service ticket created for Gate will not latch, with 1 task.');
  });

  test('M18 no minted-link hold → the refresh repaints the row and the one-time link is gone', async () => {
    const m = mutate(TICKETS_SRC, 'if (minted && minted.value) return true;', '');
    const r = await driveMintedLink(m);
    expect(r.linkShownBefore).toBe(ONE_TIME_LINK);
    expect(r.refetchedNow).toBe(true);
    expect(r.linkAfterRefresh).not.toBe(ONE_TIME_LINK);
  });

  test('M19 no changeset fallback → a Live Writer update is announced as a new ticket', () => {
    const m = mutate(VOICE_SRC,
      'if (!edited && firstParent) edited = changesetShowsExisting(detail.apply_changeset, parentType, firstParent);', '');
    const line = speakDetail(m, liveWriterDetail([
      CS('service_ticket', 'st_901', { title: 'Old' }, { title: 'Old' }), CS('task', 'tk_1', null, {}),
    ]));
    expect(line).toBe('Got it — service ticket created, with 1 task.');
  });

  test('M20 ignore `before` → a Live Writer CREATE is announced as an update', () => {
    const m = mutate(VOICE_SRC,
      'if (!e || e.entity_type !== type || e.before == null) continue;',
      'if (!e || e.entity_type !== type) continue;');
    const line = speakDetail(m, liveWriterDetail([
      CS('service_ticket', 'st_902', null, { title: 'New' }), CS('task', 'tk_1', null, {}),
    ]));
    expect(line).toBe('Got it — service ticket updated, 1 task added.');
  });

  test('M21 no id match → an edit elsewhere in the changeset makes a new ticket read as updated', () => {
    const m = mutate(VOICE_SRC,
      'if (tid == null || String(e.id) === String(tid)) return true;', 'return true;');
    const line = speakDetail(m, {
      affected_targets: [T('service_ticket', { entity_id: 'st_new' }), T('task')],
      apply_changeset: [
        CS('service_ticket', 'st_old', { title: 'Old' }, { title: 'Old' }),
        CS('service_ticket', 'st_new', null, { title: 'New' }),
      ],
    });
    expect(line).toBe('Got it — service ticket updated, 1 task added.');
  });

  test('M22 id match with no any-entry arm → a target with no id never reads as updated', () => {
    const m = mutate(VOICE_SRC,
      'if (tid == null || String(e.id) === String(tid)) return true;',
      'if (String(e.id) === String(tid)) return true;');
    const line = speakDetail(m, {
      affected_targets: [{ entity_type: 'service_ticket' }],
      apply_changeset: [CS('service_ticket', 'st_901', { title: 'Old' }, { title: 'Old' })],
    });
    expect(line).toBe('Got it — service ticket created.');
  });

  test('M12 no parent rule in the read-back → the bundle is miscounted again', () => {
    const m = mutate(VOICE_SRC, 'if (pet && CHILD_NOUN[pet]) { parentType = pet; break; }', '');
    const line = speak(m, [T('service_ticket', { title: 'Gate will not latch' }), T('task'), T('task')]);
    expect(line).toBe('Got it — 3 service tickets created.');
  });
});
