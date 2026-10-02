/* THE THINGS THAT BECAME TRUE BECAUSE TIME PASSED.
 *
 * Four standing conditions — a lead's follow-up date, an invoice past due, a
 * bill's payment date, an RFI nobody answered — collected into ONE morning
 * message per person.
 *
 * WHAT THIS FILE IS REALLY GUARDING, in order of how much damage the mistake
 * does:
 *
 *   1. ONE EMAIL PER PERSON PER DAY. "Past due" has a near edge and no far
 *      edge, and there is no per-recipient throttle anywhere in this repo. Four
 *      per-row scanners would have put four emails in one inbox in the same
 *      minute on day one, and hundreds the day somebody imports a spreadsheet
 *      of past follow-up dates. The digest IS the safety mechanism, so the
 *      tests that prove it is one email come first.
 *   2. NOTHING CROSSES A TENANT, and the way this cron proves it is unusual:
 *      it has no req.user and no per-org loop, so the predicate is
 *      `<record>.organization_id = u.organization_id` on the join. The mock
 *      below reads that term OFF THE STATEMENT — hardcoding it here is how two
 *      mutations stayed invisible in money-notices.test.js.
 *   3. THE CLOCK IS THE RECIPIENT'S. This server runs in UTC; a Florida
 *      contractor at 8pm must not be told an invoice is a day late before it
 *      is.
 *   4. AN ANSWERED RFI IS NOT WAITING. `closed_at IS NULL` is not a synonym
 *      for open, and the shipped /overdue route treated it as one.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const { liveLine, liveLines } = require('./helpers/live-line');

let tables;
let queries;
let settings;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    // A real pool hands out a dedicated connection, and a session advisory
    // lock belongs to THAT connection. The emulation below is what makes the
    // lock tests mean anything: holding it blocks a second taker, and
    // releasing a client that still holds the lock is recorded as a leak.
    connect: async () => {
      const client = {
        _holds: false,
        query: async (sql, params) => {
          const t = String(sql);
          if (/pg_try_advisory_lock/.test(t)) {
            if (mockLockState.held) return { rows: [{ got: false }] };
            mockLockState.held = true;
            client._holds = true;
            mockLockState.takes++;
            return { rows: [{ got: true }] };
          }
          if (/pg_advisory_unlock/.test(t)) {
            mockLockState.held = false;
            client._holds = false;
            mockLockState.releases++;
            return { rows: [{ ok: true }] };
          }
          return mockRunQuery(sql, params);
        },
        release: () => {
          if (client._holds) mockLockState.leaked++;
          mockLockState.clientsReleased++;
        },
      };
      mockLockState.clientsTaken++;
      return client;
    },
  },
}));

let mockLockState;

const sentEmail = [];
const sentPush = [];
jest.mock('../server/email', () => ({
  isEnabled: () => true,
  sendEmail: async (m) => { sentEmail.push(m); return { ok: true }; },
  sendForEvent: async () => ({ skipped: true }),
}));
jest.mock('../server/push', () => ({
  sendPush: async (userId, payload) => { sentPush.push({ userId, payload }); return { sent: 1 }; },
}));

const ORG = 1;
const OTHER_ORG = 2;

function rowsOf(n) { return tables[n] || []; }
function userById(id) { return rowsOf('users').find((u) => Number(u.id) === Number(id)) || null; }
function jobById(id) { return rowsOf('jobs').find((j) => String(j.id) === String(id)) || null; }

// The identity columns every scan selects about its recipient.
function who(u) {
  const org = rowsOf('organizations').find((o) => Number(o.id) === Number(u.organization_id)) || null;
  return {
    uid: u.id, email: u.email, name: u.name, notification_prefs: u.notification_prefs || {},
    user_tz: u.timezone || null,
    org_tz: org ? org.timezone : null,
    org_id: org ? org.id : null,
    org_name: org ? org.name : null,
  };
}

// `reachable` and the date horizon, both read off the statement so removing
// either from the real query is observable here.
function passesCommon(text, u, dueIso, horizonIso) {
  if (/u\.active = TRUE/.test(text) && u.active === false) return false;
  if (/u\.email IS NOT NULL/.test(text) && !u.email) return false;
  if (/CURRENT_DATE \+ INTERVAL '1 day'/.test(text) && dueIso > horizonIso) return false;
  if (!/CURRENT_DATE/.test(text)) return true;
  return true;
}

// The server's own "today"; the horizon is one day past it. Fixed so the tests
// are not clock-dependent.
const SERVER_TODAY = '2026-10-02';
const HORIZON = '2026-10-03';

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (/^SELECT value FROM app_settings WHERE key = \$1/.test(text)) {
    const v = settings[p[0]];
    return { rows: v ? [{ value: v }] : [] };
  }
  if (/^INSERT INTO app_settings/.test(text)) {
    settings[p[0]] = JSON.parse(p[1]);
    return { rows: [], rowCount: 1 };
  }

  // ── leads ──────────────────────────────────────────────────────────────
  if (/FROM leads l/.test(text)) {
    const scoped = /l\.organization_id = u\.organization_id/.test(text);
    const terminalFiltered = /NOT \(l\.status = ANY/.test(text);
    const terminal = (p[0] || []);
    const out = [];
    for (const l of rowsOf('leads')) {
      const u = userById(l.salesperson_id);
      if (!u) continue;
      if (scoped && !sameOrg(l.organization_id, u.organization_id)) continue;
      if (!l.next_followup_at) continue;
      if (terminalFiltered && terminal.indexOf(l.status) !== -1) continue;
      if (!passesCommon(text, u, l.next_followup_at, HORIZON)) continue;
      out.push(Object.assign(who(u), { id: l.id, label: l.title, due_iso: l.next_followup_at }));
    }
    return { rows: out };
  }

  // ── invoices ───────────────────────────────────────────────────────────
  if (/FROM invoices i/.test(text)) {
    const scoped = /i\.organization_id = u\.organization_id/.test(text);
    const statusFiltered = /i\.status IN \('sent', 'partial'\)/.test(text);
    const balanceFiltered = /\(i\.total - i\.amount_paid\) > 0\.005/.test(text);
    const out = [];
    for (const i of rowsOf('invoices')) {
      const u = userById(i.owner_id);
      if (!u) continue;
      if (scoped && !sameOrg(i.organization_id, u.organization_id)) continue;
      if (!i.due_date) continue;
      if (statusFiltered && ['sent', 'partial'].indexOf(i.status) === -1) continue;
      const bal = Number(i.total) - Number(i.amount_paid || 0);
      if (balanceFiltered && !(bal > 0.005)) continue;
      if (!passesCommon(text, u, i.due_date, HORIZON)) continue;
      // THE AMOUNT COMES OFF THE STATEMENT. Computing the balance here
      // regardless of what the query asked for made 'show the total instead of
      // the balance' invisible — the same way money-notices.test.js's mock once
      // hid two tenancy mutations by filtering on its own authority.
      const asksBalance = /\(i\.total - i\.amount_paid\) AS amount/.test(text);
      out.push(Object.assign(who(u), {
        id: i.id, label: i.invoice_number || i.id,
        amount: asksBalance ? bal : Number(i.total), due_iso: i.due_date,
      }));
    }
    return { rows: out };
  }

  // ── bills ──────────────────────────────────────────────────────────────
  if (/FROM job_vendor_bills b/.test(text)) {
    // The org term is on the JOB, not the bill — a bill's own stamp is nullable.
    const scopedViaJob = /j\.organization_id = u\.organization_id/.test(text);
    const scopedViaBill = /b\.organization_id = u\.organization_id/.test(text);
    const statusFiltered = /b\.status IN \('open', 'approved'\)/.test(text);
    const ladder = /COALESCE\(b\.owner_id, j\.owner_id\)/.test(text);
    const out = [];
    for (const b of rowsOf('bills')) {
      const j = jobById(b.job_id);
      if (!j) continue;                       // job_id is NOT NULL + ON DELETE CASCADE
      const uid = ladder ? (b.owner_id || j.owner_id) : b.owner_id;
      const u = userById(uid);
      if (!u) continue;
      if (scopedViaJob && !sameOrg(j.organization_id, u.organization_id)) continue;
      if (scopedViaBill && !sameOrg(b.organization_id, u.organization_id)) continue;
      if (!b.due_date) continue;              // no bill_date fallback, by design
      if (statusFiltered && ['open', 'approved'].indexOf(b.status) === -1) continue;
      if (!passesCommon(text, u, b.due_date, HORIZON)) continue;
      out.push(Object.assign(who(u), {
        id: b.id, label: b.bill_number || b.id, amount: b.amount, due_iso: b.due_date,
      }));
    }
    return { rows: out };
  }

  // ── workflow items ─────────────────────────────────────────────────────
  if (/FROM job_workflow_items w/.test(text)) {
    const scoped = /w\.organization_id = u\.organization_id/.test(text);
    const closedFiltered = /w\.closed_at IS NULL/.test(text);
    const archivedFiltered = /w\.archived_at IS NULL/.test(text);
    const ladder = /COALESCE\(w\.responsible_user_id, w\.created_by_user_id\)/.test(text);
    // The open-door fragment, read off the statement exactly as shipped.
    const openDoor = require('../server/services/workflow-open-door');
    const statusFiltered = text.indexOf(openDoor.openSql('w').replace(/\s+/g, ' ')) !== -1;
    const out = [];
    for (const w of rowsOf('workflow')) {
      const uid = ladder ? (w.responsible_user_id || w.created_by_user_id) : w.responsible_user_id;
      const u = userById(uid);
      if (!u) continue;
      if (scoped && !sameOrg(w.organization_id, u.organization_id)) continue;
      if (archivedFiltered && w.archived_at) continue;
      if (closedFiltered && w.closed_at) continue;
      if (statusFiltered && !openDoor.isOpen(w.type, w.status)) continue;
      if (!w.due_date) continue;
      if (!passesCommon(text, u, w.due_date, HORIZON)) continue;
      out.push(Object.assign(who(u), {
        id: w.id, type: w.type, label: (w.number ? w.number + ' — ' : '') + w.subject, due_iso: w.due_date,
      }));
    }
    return { rows: out };
  }

  return { rows: [], rowCount: 0 };
}

// SQL equality semantics: NULL = NULL is NOT true. This is the whole reason an
// org-less record is skipped rather than broadcast to every tenant.
function sameOrg(a, b) {
  if (a == null || b == null) return false;
  return String(a) === String(b);
}

function freshTables() {
  return {
    organizations: [
      { id: ORG, name: 'AG Exteriors', timezone: 'America/New_York' },
      { id: OTHER_ORG, name: 'Elsewhere Inc', timezone: 'America/Denver' },
    ],
    users: [
      { id: 10, name: 'Dana', email: 'dana@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 11, name: 'Mo', email: 'mo@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 12, name: 'Sam', email: 'sam@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 14, name: 'Pat', email: 'pat@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 90, name: 'Elsewhere', email: 'nope@other.test', organization_id: OTHER_ORG, active: true, notification_prefs: {} },
      { id: 99, name: 'Gone', email: 'gone@agx.test', organization_id: ORG, active: false, notification_prefs: {} },
    ],
    jobs: [
      { id: 'j1', owner_id: 14, organization_id: ORG },
      { id: 'jOther', owner_id: 90, organization_id: OTHER_ORG },
      { id: 'jNoOrg', owner_id: 10, organization_id: null },
    ],
    leads: [
      { id: 'L1', title: 'Citi Lakes rewrap', salesperson_id: 12, organization_id: ORG, status: 'in_progress', next_followup_at: '2026-10-01' },
    ],
    invoices: [
      { id: 'I1', invoice_number: 'INV-1042', owner_id: 10, organization_id: ORG, status: 'sent', due_date: '2026-09-20', total: 12500, amount_paid: 0 },
    ],
    bills: [
      { id: 'B1', bill_number: 'ABC-99', owner_id: 11, job_id: 'j1', organization_id: ORG, status: 'open', due_date: '2026-10-02', amount: 3400 },
    ],
    workflow: [
      { id: 'W1', type: 'rfi', number: 'RFI-01', subject: 'Parapet detail', responsible_user_id: 12, created_by_user_id: 10, organization_id: ORG, status: 'open', closed_at: null, archived_at: null, due_date: '2026-09-28' },
    ],
  };
}

const cron = require('../server/deadline-digest-cron');

// 08:30 America/New_York on 2026-10-02 — inside every recipient's window.
const MORNING = new Date('2026-10-02T12:30:00Z');

beforeEach(() => {
  tables = freshTables();
  queries = [];
  settings = {};
  mockLockState = { held: false, takes: 0, releases: 0, leaked: 0, clientsTaken: 0, clientsReleased: 0 };
  sentEmail.length = 0;
  sentPush.length = 0;
});

const run = (over) => cron.runOnce(Object.assign({ now: MORNING }, over || {}));
const to = () => sentEmail.map((m) => m.to).sort();
const body = (i) => sentEmail[(i || 0)].text;
// Address a recipient by name. The arrival order of the emails is the scan
// order (leads first), NOT the order of this file's fixtures, and three tests
// here were reading one person's message and asserting about another's.
const mailTo = (addr) => sentEmail.find((m) => m.to === addr);
const textTo = (addr) => (mailTo(addr) || { text: '' }).text;
const allText = () => sentEmail.map((m) => m.text).join('\n');

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE EMAIL PER PERSON PER DAY — the safety argument
 * ══════════════════════════════════════════════════════════════════════════*/
describe('one message, not four', () => {
  test('a person with all four kinds gets ONE email listing all four', async () => {
    // Everything lands on Dana.
    tables.leads[0].salesperson_id = 10;
    tables.bills[0].owner_id = 10;
    tables.workflow[0].responsible_user_id = 10;
    const r = await run();
    expect(to()).toEqual(['dana@agx.test']);
    expect(sentEmail).toHaveLength(1);
    expect(r.sent).toBe(1);
    const t = body();
    expect(t).toContain('Leads to follow up');
    expect(t).toContain('Invoices owed to you');
    expect(t).toContain('Bills to pay');
    expect(t).toContain('RFIs and submittals waiting');
  });

  test('four people with one thing each get one email each', async () => {
    const r = await run();
    expect(to()).toEqual(['dana@agx.test', 'mo@agx.test', 'sam@agx.test']);
    // Sam has both the lead and the RFI — still one email.
    expect(sentEmail.filter((m) => m.to === 'sam@agx.test')).toHaveLength(1);
    expect(r.sent).toBe(3);
  });

  test('a long backlog is capped, and the message SAYS it was capped', async () => {
    tables.invoices = [];
    for (let i = 1; i <= 12; i++) {
      tables.invoices.push({
        id: 'I' + i, invoice_number: 'INV-' + i, owner_id: 10, organization_id: ORG,
        status: 'sent', due_date: '2026-09-0' + ((i % 9) + 1), total: 100 * i, amount_paid: 0,
      });
    }
    await run();
    const t = textTo('dana@agx.test');
    expect(t).toContain('Invoices owed to you (12)');
    expect(t).toContain('and ' + (12 - cron.SECTION_CAP) + ' more');
    const listed = t.split('\n').filter((l) => l.trim().startsWith('- INV-'));
    expect(listed).toHaveLength(cron.SECTION_CAP);
  });

  test('nobody with nothing due is emailed', async () => {
    tables.leads = []; tables.invoices = []; tables.bills = []; tables.workflow = [];
    const r = await run();
    expect(sentEmail).toHaveLength(0);
    expect(r.sent).toBe(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TENANCY — no req.user, no per-org loop
 * ══════════════════════════════════════════════════════════════════════════*/
describe('nothing crosses a tenant', () => {
  test('a LEAD in another org never reaches a salesperson in this one', async () => {
    // Sam is in this org; the lead is not. Only the join's org term can tell.
    tables.leads.push({ id: 'L9', title: 'FOREIGN LEAD', salesperson_id: 12, organization_id: OTHER_ORG, status: 'in_progress', next_followup_at: '2026-09-01' });
    await run();
    expect(allText()).not.toContain('FOREIGN LEAD');
  });

  test('an RFI in another org never reaches the person responsible here', async () => {
    tables.workflow.push({ id: 'W9', type: 'rfi', number: 'RFI-FOREIGN', subject: 'Not yours', responsible_user_id: 12, created_by_user_id: 10, organization_id: OTHER_ORG, status: 'open', closed_at: null, archived_at: null, due_date: '2026-09-01' });
    await run();
    expect(allText()).not.toContain('RFI-FOREIGN');
  });

  test('an INVOICE in another org never reaches a user in this one', async () => {
    tables.invoices.push({ id: 'I9', invoice_number: 'FOREIGN', owner_id: 10, organization_id: OTHER_ORG, status: 'sent', due_date: '2026-09-01', total: 999, amount_paid: 0 });
    await run();
    expect(body()).not.toContain('FOREIGN');
  });

  test('an ORG-LESS record is skipped, not broadcast to every tenant', async () => {
    // This is the failure mode a per-org loop with `OR organization_id IS NULL`
    // would have: the orphan matches in EVERY org's pass. Here the join term is
    // an equality, and NULL = NULL is not true, so it matches nobody.
    tables.invoices.push({ id: 'I8', invoice_number: 'ORPHAN', owner_id: 10, organization_id: null, status: 'sent', due_date: '2026-09-01', total: 50, amount_paid: 0 });
    await run();
    expect(sentEmail.some((m) => m.text.includes('ORPHAN'))).toBe(false);
  });

  test('a bill is reached through its JOB, because its own stamp is nullable', async () => {
    tables.bills[0].organization_id = null;    // legacy, pre-backfill
    await run();
    const mo = sentEmail.find((m) => m.to === 'mo@agx.test');
    expect(mo).toBeDefined();
    expect(mo.text).toContain('ABC-99');
  });

  test('a bill on ANOTHER tenant’s job is not mailed, however its owner column points', async () => {
    tables.bills.push({ id: 'B9', bill_number: 'FOREIGN-BILL', owner_id: 11, job_id: 'jOther', organization_id: ORG, status: 'open', due_date: '2026-09-01', amount: 10 });
    await run();
    expect(sentEmail.some((m) => m.text.includes('FOREIGN-BILL'))).toBe(false);
  });

  test('a deactivated teammate is not mailed', async () => {
    tables.invoices[0].owner_id = 99;
    await run();
    expect(to()).not.toContain('gone@agx.test');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CLOCK IS THE RECIPIENT'S
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the recipient’s own day decides', () => {
  test('an item due tomorrow is not in today’s message', async () => {
    tables.invoices[0].due_date = '2026-10-03';
    await run();
    expect(sentEmail.some((m) => m.to === 'dana@agx.test')).toBe(false);
  });

  test('an item due TODAY is in it, labelled "Due today" rather than late', async () => {
    tables.invoices[0].due_date = '2026-10-02';
    await run();
    const m = sentEmail.find((x) => x.to === 'dana@agx.test');
    expect(m.text).toContain('Due today');
    expect(m.text).not.toContain('days late');
  });

  test('a late item says how late, counted in calendar days', async () => {
    tables.invoices[0].due_date = '2026-09-28';
    await run();
    expect(textTo('dana@agx.test')).toContain('4 days late');
  });

  test('one day late is singular', async () => {
    tables.invoices[0].due_date = '2026-10-01';
    await run();
    expect(textTo('dana@agx.test')).toContain('1 day late');
    expect(textTo('dana@agx.test')).not.toContain('1 days late');
  });

  test('the local date, not the server’s: at 21:00 Denver it is still the 2nd', async () => {
    // 05:00Z on the 3rd is 01:00 on the 3rd in New York and 23:00 on the 2nd in
    // Denver — the instant that tells the two apart. An item due the 3rd is due
    // today for the New Yorker and not yet for the Denver user, so the server’s
    // own UTC date (the 3rd) is right for neither of them by itself.
    tables.users.find((u) => u.id === 10).timezone = 'America/Denver';
    tables.invoices[0].due_date = '2026-10-03';
    tables.leads = []; tables.bills = []; tables.workflow = [];   // Dana alone
    const r = await cron.runOnce({ now: new Date('2026-10-03T05:00:00Z'), force: true });
    expect(sentEmail).toHaveLength(0);
    expect(r.items).toBe(0);
    // and the SAME instant for a New York user, where it IS already the 3rd:
    tables.users.find((u) => u.id === 10).timezone = 'America/New_York';
    const r2 = await cron.runOnce({ now: new Date('2026-10-03T05:00:00Z'), force: true });
    expect(r2.items).toBe(1);
    expect(textTo('dana@agx.test')).toContain('Due today');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * AN ANSWERED RFI IS NOT WAITING
 * ══════════════════════════════════════════════════════════════════════════*/
describe('what still needs action', () => {
  test('an ANSWERED rfi is not waiting — closed_at is NULL on one forever', async () => {
    tables.workflow[0].status = 'answered';
    await run();
    const sam = sentEmail.find((m) => m.to === 'sam@agx.test');
    // Sam still has the lead; the RFI section must be gone.
    expect(sam.text).not.toContain('RFIs and submittals waiting');
  });

  test('a SENT transmittal is not waiting either', async () => {
    tables.workflow[0] = Object.assign({}, tables.workflow[0], { type: 'transmittal', status: 'sent', number: 'TRX-01' });
    await run();
    expect(sentEmail.some((m) => m.text.includes('TRX-01'))).toBe(false);
  });

  test('a submittal awaiting revision IS waiting', async () => {
    tables.workflow[0] = Object.assign({}, tables.workflow[0], { type: 'submittal', status: 'revise_resubmit', number: 'SUB-02' });
    await run();
    expect(sentEmail.some((m) => m.text.includes('SUB-02'))).toBe(true);
  });

  test('an archived or closed item is never waiting', async () => {
    tables.workflow.push({ id: 'W2', type: 'rfi', number: 'RFI-09', subject: 'Closed one', responsible_user_id: 12, created_by_user_id: 10, organization_id: ORG, status: 'open', closed_at: '2026-09-01T00:00:00Z', archived_at: null, due_date: '2026-08-01' });
    tables.workflow.push({ id: 'W3', type: 'rfi', number: 'RFI-10', subject: 'Archived one', responsible_user_id: 12, created_by_user_id: 10, organization_id: ORG, status: 'open', closed_at: null, archived_at: '2026-09-01T00:00:00Z', due_date: '2026-08-01' });
    await run();
    expect(allText()).not.toContain('RFI-09');
    expect(allText()).not.toContain('RFI-10');
  });

  test('with nobody responsible it goes to whoever raised it', async () => {
    tables.workflow[0].responsible_user_id = null;   // ON DELETE SET NULL
    await run();
    const dana = sentEmail.find((m) => m.to === 'dana@agx.test');   // created_by
    expect(dana.text).toContain('RFI-01');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT COUNTS AS STILL OWED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('what counts', () => {
  test('a draft invoice has no deadline; a paid one has no balance', async () => {
    tables.invoices[0].status = 'draft';
    await run();
    expect(sentEmail.some((m) => m.to === 'dana@agx.test')).toBe(false);
    sentEmail.length = 0;
    tables.invoices[0].status = 'sent';
    tables.invoices[0].amount_paid = tables.invoices[0].total;
    await run();
    expect(sentEmail.some((m) => m.to === 'dana@agx.test')).toBe(false);
  });

  test('a part-paid invoice shows the BALANCE, not the total', async () => {
    tables.invoices[0].status = 'partial';
    tables.invoices[0].amount_paid = 10000;        // of 12500
    await run();
    expect(textTo('dana@agx.test')).toContain('$2,500.00');
    expect(textTo('dana@agx.test')).not.toContain('$12,500.00');
  });

  test('a bill with no due date is never guessed at from its bill date', async () => {
    tables.bills[0].due_date = null;
    await run();
    expect(sentEmail.some((m) => m.to === 'mo@agx.test')).toBe(false);
  });

  test('a paid or voided bill is not owed', async () => {
    for (const status of ['paid', 'void']) {
      sentEmail.length = 0;
      tables.bills[0].status = status;
      await run();
      expect(sentEmail.some((m) => m.to === 'mo@agx.test')).toBe(false);
    }
  });

  test('a bill nobody entered falls to the job’s PM, the one person who cannot be null', async () => {
    tables.bills[0].owner_id = null;
    await run();
    const pat = sentEmail.find((m) => m.to === 'pat@agx.test');   // jobs.owner_id
    expect(pat).toBeDefined();
    expect(pat.text).toContain('ABC-99');
  });

  test('a won or lost lead is not waiting for a call', async () => {
    for (const status of cron.TERMINAL_LEAD_STATUSES) {
      sentEmail.length = 0;
      tables.leads[0].status = status;
      await run();
      expect(sentEmail.some((m) => m.text.includes('Citi Lakes'))).toBe(false);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SWITCHES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('preferences', () => {
  test('a section switched off disappears; the rest of the message stays', async () => {
    tables.leads[0].salesperson_id = 10;
    tables.users.find((u) => u.id === 10).notification_prefs = { invoice_past_due: false };
    await run();
    const m = sentEmail.find((x) => x.to === 'dana@agx.test');
    expect(m.text).toContain('Leads to follow up');
    expect(m.text).not.toContain('Invoices owed to you');
  });

  test('every section off means no email at all', async () => {
    tables.users.find((u) => u.id === 10).notification_prefs = {
      lead_followup: false, invoice_past_due: false, bill_payment_due: false, workflow_overdue: false,
    };
    await run();
    expect(to()).not.toContain('dana@agx.test');
  });

  test('email off but push on still pushes', async () => {
    tables.users.find((u) => u.id === 10).notification_prefs = { invoice_past_due: false };
    await run();
    expect(to()).not.toContain('dana@agx.test');
    expect(sentPush.map((x) => x.userId)).toContain(10);
  });

  test('push off, email on: the email goes and the push does not', async () => {
    tables.users.find((u) => u.id === 10).notification_prefs = { push: { invoice_past_due: false } };
    await run();
    expect(to()).toContain('dana@agx.test');
    expect(sentPush.map((x) => x.userId)).not.toContain(10);
  });

  test('the catalog carries all four switches, in one contiguous group', () => {
    const { NOTIFY_EVENTS } = require('../server/notify-events');
    const keys = Object.values(cron.KEYS);
    for (const k of keys) {
      const row = NOTIFY_EVENTS.find((e) => e.key === k);
      expect([k, !!row]).toEqual([k, true]);
      expect([k, row.group]).toEqual([k, 'Deadlines']);
      expect([k, row.channels]).toEqual([k, { email: true, push: true }]);
    }
    const grouped = NOTIFY_EVENTS.filter((e) => e.group === 'Deadlines').map((e) => e.key);
    expect(grouped).toEqual(keys);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WINDOW AND THE LEDGER
 * ══════════════════════════════════════════════════════════════════════════*/
describe('once a day, in the morning', () => {
  test('nothing sends at 3am local', async () => {
    const r = await cron.runOnce({ now: new Date('2026-10-02T07:00:00Z') });  // 03:00 ET
    expect(sentEmail).toHaveLength(0);
    expect(r.people.every((p) => p.skipped === 'outside_window')).toBe(true);
  });

  test('a second tick on the same local day sends nothing more', async () => {
    await run();
    const first = sentEmail.length;
    expect(first).toBeGreaterThan(0);
    const r = await cron.runOnce({ now: new Date('2026-10-02T14:30:00Z') });  // 10:30 ET
    expect(sentEmail).toHaveLength(first);
    expect(r.people.every((p) => p.skipped === 'already_today')).toBe(true);
  });

  test('tomorrow it sends again — a standing condition is still true tomorrow', async () => {
    await run();
    const first = sentEmail.length;
    await cron.runOnce({ now: new Date('2026-10-03T12:30:00Z') });
    expect(sentEmail.length).toBeGreaterThan(first);
  });

  test('force ignores both the window and the ledger', async () => {
    await run();
    sentEmail.length = 0;
    await cron.runOnce({ now: new Date('2026-10-02T07:00:00Z'), force: true });
    expect(sentEmail.length).toBeGreaterThan(0);
  });

  test('the ledger is written after EACH person, so one failure cannot re-mail the rest', async () => {
    // cert-expiry-cron saves once after its whole loop, so a throw loses the
    // markers for everyone already mailed in that tick and the next tick mails
    // them all again. This one saves per recipient.
    const saves = [];
    const realQuery = mockRunQuery;
    await run();
    const inserts = queries.filter((q) => /^INSERT INTO app_settings/.test(q.sql));
    expect(inserts.length).toBe(sentEmail.length);
    expect(realQuery).toBe(mockRunQuery);
    expect(saves).toEqual([]);
  });

  test('the ledger key is one per person per day, not one per record', async () => {
    tables.leads[0].salesperson_id = 10;
    tables.bills[0].owner_id = 10;
    tables.workflow[0].responsible_user_id = 10;
    await run();
    const fires = Object.keys(settings[cron.LEDGER_KEY].fires);
    expect(fires).toEqual(['deadlines|10|2026-10-02']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DRY RUN THAT ACTUALLY COUNTS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the dry run', () => {
  test('reports real per-person counts and sends nothing', async () => {
    // cert-expiry-cron's dry path skips its scan entirely (`if (wouldRun &&
    // !dry)`), so it reports zero candidates for every org — useless for a scan
    // whose only risk is volume. This one runs the whole pipeline.
    const r = await run({ dry: true });
    expect(sentEmail).toHaveLength(0);
    expect(r.dry).toBe(true);
    expect(r.sent).toBeGreaterThan(0);
    expect(r.items).toBeGreaterThan(0);
    expect(r.people.some((p) => p.wouldSend && p.email > 0)).toBe(true);
  });

  test('a dry run records nothing, so the real one still sends', async () => {
    await run({ dry: true });
    expect(settings[cron.LEDGER_KEY]).toBeUndefined();
    await run();
    expect(sentEmail.length).toBeGreaterThan(0);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE REPLICA SENDS, WHATEVER THE REPLICA COUNT IS
 *
 * Every cron here dedupes through ONE JSONB row rewritten whole, which is
 * safe for one replica and nothing else — work-order-notify-cron.js says so
 * in its own header. Whether this app runs one replica cannot be read from
 * this repository at all: ecosystem.config.js pins instances: 1 and only the
 * pm2 path reads it, while Railway keeps the number in its dashboard. So the
 * cron does not depend on the answer.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('two replicas do not both send', () => {
  test('a tick takes the advisory lock and gives it back', async () => {
    await run();
    expect(mockLockState.takes).toBe(1);
    expect(mockLockState.releases).toBe(1);
    expect(mockLockState.held).toBe(false);
  });

  test('a second replica ticking at the same minute skips, it does not race', async () => {
    // Hold the lock as the other replica would.
    mockLockState.held = true;
    const r = await run();
    expect(r.skippedTick).toBe('locked');
    expect(sentEmail).toHaveLength(0);
    expect(settings[cron.LEDGER_KEY]).toBeUndefined();
  });

  test('the connection is never returned to the pool still holding the lock', async () => {
    // The failure this guards is silent and permanent: a pooled connection
    // parked with the lock held means every later tick fails to acquire it and
    // the digest stops forever, with nothing in the log to say why.
    await run();
    expect(mockLockState.leaked).toBe(0);
    expect(mockLockState.clientsReleased).toBe(mockLockState.clientsTaken);
  });

  test('one scan exploding costs that section only — and still gives the lock back', async () => {
    // Written the other way round first, asserting the whole tick failed, and
    // the suite said otherwise: gather() catches PER SCAN on purpose, so a dead
    // invoices query must not cost somebody their bills and RFIs. That is the
    // behaviour worth pinning, and the lock has to come back either way.
    tables.invoices = { [Symbol.iterator]: () => { throw new Error('pg exploded'); } };
    tables.leads[0].salesperson_id = 10;
    tables.bills[0].owner_id = 10;
    tables.workflow[0].responsible_user_id = 10;

    const r = await run();

    const m = textTo('dana@agx.test');
    expect(m).toContain('Leads to follow up');
    expect(m).toContain('Bills to pay');
    expect(m).toContain('RFIs and submittals waiting');
    expect(m).not.toContain('Invoices owed to you');
    expect(r.sent).toBe(1);

    expect(mockLockState.held).toBe(false);
    expect(mockLockState.releases).toBe(1);
    expect(mockLockState.leaked).toBe(0);
  });

  test('the release sits in a finally, so no later edit can skip it', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'deadline-digest-cron.js'), 'utf8');
    expect(liveLine(src, '} finally {')).toBe(true);
    expect(liveLine(src, 'if (release) await release();')).toBe(true);
  });

  test('a dry run takes no lock — a preview must run when you ask for it', async () => {
    mockLockState.held = true;            // a real tick is in progress
    const r = await run({ dry: true });
    expect(r.skippedTick).toBeUndefined();
    expect(r.sent).toBeGreaterThan(0);
    expect(mockLockState.takes).toBe(0);
  });

  test('the lock key cannot collide with the only other advisory lock here', () => {
    // routes/admin-agents-routes.js uses 0x86 * 1000000 + orgId, so every real
    // org id lands at 134000001 and up.
    expect(cron.TICK_LOCK_KEY).toBeLessThan(0x86 * 1000000);
    const src = fs.readFileSync(path.join(__dirname, "..", "server", "routes", "admin-agents-routes.js"), "utf8");
    expect(src).toContain('0x86 * 1000000');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE OPEN DOOR, ON ITS OWN
 * ══════════════════════════════════════════════════════════════════════════*/
describe('workflow-open-door', () => {
  const door = require('../server/services/workflow-open-door');

  test('open means status, per type', () => {
    expect(door.isOpen('rfi', 'open')).toBe(true);
    expect(door.isOpen('rfi', 'answered')).toBe(false);
    expect(door.isOpen('rfi', 'closed')).toBe(false);
    expect(door.isOpen('submittal', 'submitted')).toBe(true);
    expect(door.isOpen('submittal', 'revise_resubmit')).toBe(true);
    expect(door.isOpen('submittal', 'approved')).toBe(false);
    expect(door.isOpen('transmittal', 'pending')).toBe(true);
    expect(door.isOpen('transmittal', 'sent')).toBe(false);
  });

  test('a type it cannot speak for is NOT open — silence beats guessing', () => {
    expect(door.isOpen('invoice', 'open')).toBe(false);
    expect(door.isOpen(undefined, 'open')).toBe(false);
  });

  test('the SQL names every type, carries no bind parameters, and respects the alias', () => {
    const sql = door.openSql('w');
    expect(sql).toContain("w.type = 'rfi'");
    expect(sql).toContain("w.type = 'submittal'");
    expect(sql).toContain("w.type = 'transmittal'");
    expect(sql).not.toMatch(/\$\d/);           // droppable into any query unrenumbered
    expect(door.openSql('job_workflow_items')).toContain('job_workflow_items.status');
  });

  test('the SQL and the JS agree, status for status', () => {
    const sql = door.openSql('w');
    for (const type of Object.keys(door.OPEN_STATUSES)) {
      for (const status of door.OPEN_STATUSES[type]) {
        expect([type, status, door.isOpen(type, status)]).toEqual([type, status, true]);
        expect(sql).toContain("'" + status + "'");
      }
    }
  });

  test('an unsafe alias or status literal is refused rather than interpolated', () => {
    expect(() => door.openSql("w; DROP TABLE users; --")).toThrow();
  });

  test('the route asks this module instead of keeping its own copy', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'job-workflow-routes.js'), 'utf8');
    expect(liveLines(src, "require('../services/workflow-open-door')").length).toBe(1);
    expect(liveLines(src, 'openDoor.openSql(').length).toBeGreaterThan(0);
    // The vacuous arms are gone. job_workflow_items.organization_id is NOT
    // NULL, so a tolerance arm on it could never match a row; eight of them
    // were counted against docs/TENANCY-GRADUATION.md item 9 for nothing.
    // EXACTLY ONE live arm is left in this file, and it is on a different
    // table: jobs.organization_id IS nullable, so there it is load-bearing.
    const arms = liveLines(src, 'organization_id IS NULL');
    expect(arms).toHaveLength(1);
    expect(arms[0]).toContain('FROM jobs');
  });

  test('the overdue route filters on BOTH the status door and closed_at', () => {
    // closed_at alone is the bug; status alone loses idx_jwi_due_open.
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'routes', 'job-workflow-routes.js'), 'utf8');
    const i = src.indexOf("router.get('/overdue'");
    expect(i).toBeGreaterThan(-1);
    const route = src.slice(i, i + 1600);
    expect(route).toContain('closed_at IS NULL');
    expect(route).toContain('openDoor.openSql(');
    expect(route).toContain('WHERE organization_id = $1');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE CRON IS ARMED, AND ITS LEDGER IS DECLARED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('wiring', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('it is started at boot, beside the other digests', () => {
    const src = read('server/index.js');
    expect(liveLine(src, "require('./deadline-digest-cron').start();")).toBe(true);
  });

  test('its ledger key is declared, or it is an undeclared app_settings key', () => {
    const keys = require('../server/services/app-settings-keys');
    expect(keys.isDeclaredKey(cron.LEDGER_KEY)).toBe(true);
    expect(keys.classOf(cron.LEDGER_KEY)).toBe('internal');
    expect(keys.readCapabilityFor(cron.LEDGER_KEY)).toBe(null);
    expect(keys.writeCapabilityFor(cron.LEDGER_KEY)).toBe(null);
  });

  test('no date column is read through toISOString — a DATE comes back as LOCAL midnight', () => {
    // cert-expiry-cron.js has exactly this bug inside its dedupe key.
    const src = read('server/deadline-digest-cron.js');
    expect(liveLines(src, '.toISOString()')).toEqual([]);
    expect(src).toContain("to_char(");
  });

  test('every scan over-fetches by a day, because the recipient’s date decides', () => {
    const src = read('server/deadline-digest-cron.js');
    expect(liveLines(src, "CURRENT_DATE + INTERVAL '1 day'").length).toBe(1);
    expect(liveLines(src, 'HORIZON').length).toBeGreaterThanOrEqual(5);  // the const + four scans
  });

  test('it adds NO new organization_id IS NULL tolerance arm', () => {
    const src = read('server/deadline-digest-cron.js');
    expect(liveLines(src, 'organization_id IS NULL')).toEqual([]);
    expect(liveLines(src, 'organization_id = u.organization_id').length).toBeGreaterThanOrEqual(3);
  });
});
