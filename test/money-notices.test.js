/* MONEY DECISIONS NOBODY WAS TOLD ABOUT.
 *
 * Four notices: a proposal recorded approved or declined, a purchase order
 * approved or finished, a vendor bill waiting for approval, a bill decided.
 * Every one of these was already written to the database and told to nobody.
 *
 * WHAT THIS FILE IS REALLY GUARDING is not the wording — it is the two things
 * that would turn a useful notice into a disaster:
 *
 *   1. THE SYNC MUST NEVER FIRE ONE. The Buildertrend sync re-statuses these
 *      same rows every thirty minutes with its own SQL on its own client, and
 *      it can mint a purchase order already at work_complete. A notice hung off
 *      a status column, off data.btStatus, off updated_at, off a trigger, or
 *      off a helper the sync shares would mail hundreds in one run. There is no
 *      actor to test instead — an unattended run has none. The route boundary
 *      is the whole guard, so the structural tests below assert that no
 *      notifier is reachable from services/clickr/ and that the one helper the
 *      sync genuinely shares (grantSubAccessForPO) has no notice on it.
 *
 *   2. NOBODY GETS A NOTICE ABOUT THEIR OWN CLICK, and nobody outside the
 *      organisation gets one at all.
 *
 * The recipients are read off real columns, deliberately NOT from the
 * capability that gates these routes: ESTIMATES_EDIT is held by the field-crew
 * role, so addressing a payable to its holders would mail the crew about money.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const express = require('express');
const http = require('http');

let tables;
let queries;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {},
    }),
  },
}));

// The two senders. Captured, never sent.
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

function rowsOf(n) { return tables[n] || []; }
function orgOk(row, orgId) { return row.organization_id == null || String(row.organization_id) === String(orgId); }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: rowsOf('roles') };

  // users — the recipient read, and the notification_prefs behind it.
  //
  // THE TERMS ARE READ OFF THE STATEMENT, not hardcoded here. Filtering by org
  // and active regardless of what the SQL asked made two mutations invisible:
  // strip either term from the query and this mock went on filtering, so the
  // test passed while the product would have mailed another tenant. Same
  // discipline as orgTermOk in notes-and-messages-tenant-scope.test.js.
  if (/^SELECT id, name, email, role, notification_prefs FROM users WHERE id = ANY/.test(text)) {
    const want = (p[0] || []).map(Number);
    const scoped = /organization_id = \$2/.test(text);
    const activeOnly = /active = TRUE/.test(text);
    return { rows: rowsOf('users').filter((u) => want.includes(Number(u.id))
      && (!scoped || String(u.organization_id) === String(p[1]))
      && (!activeOnly || u.active !== false)) };
  }
  if (/^SELECT notification_prefs FROM users WHERE id = \$1/.test(text)) {
    const u = rowsOf('users').find((x) => Number(x.id) === Number(p[0]));
    return { rows: u ? [{ notification_prefs: u.notification_prefs || {} }] : [] };
  }
  if (/^SELECT name FROM organizations WHERE id = \$1/.test(text)) return { rows: [{ name: 'AG Exteriors' }] };
  if (/FROM users WHERE id = \$1/.test(text)) {
    const u = rowsOf('users').find((x) => Number(x.id) === Number(p[0]));
    return { rows: u ? [u] : [] };
  }

  // jobs
  if (/^SELECT id, owner_id, data FROM jobs WHERE id = \$1/.test(text)) {
    const j = rowsOf('jobs').find((x) => String(x.id) === String(p[0]));
    if (!j || !orgOk(j, p[1])) return { rows: [] };
    return { rows: [j] };
  }

  // leads — the estimate's salesperson, through data->>'lead_id'
  if (/^SELECT l\.salesperson_id FROM leads l WHERE l\.id = \$1/.test(text)) {
    const l = rowsOf('leads').find((x) => String(x.id) === String(p[0]));
    if (!l || !orgOk(l, p[1])) return { rows: [] };
    return { rows: [{ salesperson_id: l.salesperson_id }] };
  }

  if (/^SELECT name FROM subs WHERE id = \$1/.test(text)) {
    const s = rowsOf('subs').find((x) => String(x.id) === String(p[0]));
    if (!s || !orgOk(s, p[1])) return { rows: [] };
    return { rows: [{ name: s.name }] };
  }

  // ── estimates ────────────────────────────────────────────────────────
  if (/^UPDATE estimates SET approval_status = 'approved'/.test(text)) {
    const e = rowsOf('estimates').find((x) => String(x.id) === String(p[0]));
    if (!e || !orgOk(e, p[1])) return { rows: [], rowCount: 0 };
    if (/approval_status IS DISTINCT FROM 'approved'/.test(text) && e.approval_status === 'approved') {
      return { rows: [], rowCount: 0 };
    }
    e.approval_status = 'approved';
    e.approved_at = e.approved_at && /COALESCE\(approved_at, NOW\(\)\)/.test(text) ? e.approved_at : '2026-10-01T00:00:00.000Z';
    e.approved_by = p[2];
    e.approval_method = p[3];
    e.declined_at = null; e.decline_reason = null;
    return { rows: [e], rowCount: 1 };
  }
  if (/^UPDATE estimates SET approval_status = 'declined'/.test(text)) {
    const e = rowsOf('estimates').find((x) => String(x.id) === String(p[0]));
    if (!e || !orgOk(e, p[1])) return { rows: [], rowCount: 0 };
    if (/approval_status IS DISTINCT FROM 'declined'/.test(text) && e.approval_status === 'declined') {
      return { rows: [], rowCount: 0 };
    }
    e.approval_status = 'declined';
    e.declined_at = e.declined_at && /COALESCE\(declined_at, NOW\(\)\)/.test(text) ? e.declined_at : '2026-10-01T00:00:00.000Z';
    e.decline_reason = p[2];
    if (/approved_at = NULL/.test(text)) { e.approved_at = null; e.approved_by = null; e.approval_method = null; e.signature = null; }
    return { rows: [e], rowCount: 1 };
  }
  if (/^SELECT approval_status, approved_at, approved_by, approval_method FROM estimates/.test(text)
      || /^SELECT approval_status, declined_at, decline_reason FROM estimates/.test(text)) {
    const e = rowsOf('estimates').find((x) => String(x.id) === String(p[0]));
    if (!e || !orgOk(e, p[1])) return { rows: [], rowCount: 0 };
    return { rows: [e], rowCount: 1 };
  }

  // ── bills ────────────────────────────────────────────────────────────
  if (/^UPDATE job_vendor_bills b SET approval_notified_at = NOW\(\)/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[0]));
    if (!b || b.status !== p[1]) return { rows: [], rowCount: 0 };
    // The org term, read off the statement. test/org-write-predicate-invariant
    // requires it ON the UPDATE rather than inherited from the caller's read,
    // and the anchor is the JOB, because a bill's own stamp is nullable.
    if (/j\.organization_id = \$3 OR j\.organization_id IS NULL/.test(text)) {
      const j = rowsOf('jobs').find((x) => String(x.id) === String(b.job_id));
      if (!j || !orgOk(j, p[2])) return { rows: [], rowCount: 0 };
    }
    if (/approval_notified_at IS NULL/.test(text) && b.approval_notified_at != null) return { rows: [], rowCount: 0 };
    b.approval_notified_at = '2026-10-01T00:00:00.000Z';
    return { rows: [], rowCount: 1 };
  }
  if (/^UPDATE job_vendor_bills SET approval_notified_at = NULL/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[0]));
    if (b) b.approval_notified_at = null;
    return { rows: [], rowCount: 1 };
  }
  // The status route's own two statements: the current-status read, scoped
  // through the job, and the transition.
  //
  // It also returns the job's OWNER, because the approval gate added in 1.92
  // asks whether the caller runs this job. The owner column is served off the
  // statement rather than assumed: drop `j.owner_id` from the route's SELECT
  // and this mock stops recognising it, which is how it should read — a gate
  // that cannot see the owner must not quietly default to allowing.
  if (/^SELECT b\.status, b\.job_id, j\.owner_id, ja\.access_level FROM job_vendor_bills b JOIN jobs j/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[0]));
    if (!b) return { rows: [], rowCount: 0 };
    const j = rowsOf('jobs').find((x) => String(x.id) === String(b.job_id));
    if (!j || !orgOk(j, p[1])) return { rows: [], rowCount: 0 };
    return { rows: [{ status: b.status, job_id: b.job_id, owner_id: j.owner_id, access_level: null }], rowCount: 1 };
  }
  if (/^UPDATE job_vendor_bills SET status = \$1/.test(text)) {
    const b = rowsOf('bills').find((x) => String(x.id) === String(p[3]));
    if (!b) return { rows: [], rowCount: 0 };
    b.status = p[0];
    if (p[0] === 'approved' || p[0] === 'paid') {
      b.approved_at = b.approved_at || '2026-10-01T00:00:00.000Z';
      b.approved_by = b.approved_by || p[1];
    }
    return { rows: [b], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const money = require('../server/services/money-notices');

function freshTables() {
  return {
    roles: [{ name: 'admin', capabilities: ['ESTIMATES_EDIT', 'ESTIMATES_VIEW'] }],
    users: [
      { id: 10, name: 'Dana', email: 'dana@agx.test', role: 'admin', organization_id: 1, notification_prefs: {} },
      { id: 11, name: 'Pat PM', email: 'pat@agx.test', role: 'pm', organization_id: 1, notification_prefs: {} },
      { id: 12, name: 'Sam Sales', email: 'sam@agx.test', role: 'pm', organization_id: 1, notification_prefs: {} },
      { id: 13, name: 'Muted Mo', email: 'mo@agx.test', role: 'pm', organization_id: 1,
        notification_prefs: { estimate_decided: false, po_status: false, bill_approval: false, bill_decided: false,
          push: { estimate_decided: false, po_status: false, bill_approval: false, bill_decided: false } } },
      { id: 77, name: 'Other Org', email: 'o@other.test', role: 'admin', organization_id: 2, notification_prefs: {} },
      { id: 14, name: 'Gone', email: 'gone@agx.test', role: 'pm', organization_id: 1, active: false, notification_prefs: {} },
    ],
    jobs: [{ id: 'job_1', owner_id: 11, organization_id: 1, data: { jobNumber: 'S2100', title: 'Citi Lakes Pool' } }],
    leads: [{ id: 'lead_1', salesperson_id: 12, organization_id: 1 }],
    subs: [{ id: 'sub_1', name: 'A Tree Surgeons', organization_id: 1 }],
    estimates: [
      { id: 'est_1', owner_id: 10, organization_id: 1, approval_status: 'sent',
        data: { title: 'Pool area repairs', lead_id: 'lead_1' } },
      { id: 'est_orphan', owner_id: 10, organization_id: 1, approval_status: 'sent',
        data: { title: 'No lead', lead_id: 'lead_GONE' } },
    ],
    bills: [
      { id: 'bill_1', job_id: 'job_1', owner_id: 10, organization_id: 1, status: 'open',
        bill_number: 'INV-900', amount: 15440, due_date: '2026-10-10', approval_notified_at: null },
    ],
    pos: [
      { id: 'po_1', job_id: 'job_1', owner_id: 10, sub_id: 'sub_1', po_number: '0014', status: 'approved',
        data: { title: 'Balcony work', total: 5050 } },
    ],
  };
}

beforeEach(() => { tables = freshTables(); queries = []; sentEmail.length = 0; sentPush.length = 0; money._resetBurst(); });

const ACTOR = { userId: 10, name: 'Dana' };
const to = () => sentEmail.map((m) => m.to).sort();
const pushedTo = () => sentPush.map((x) => x.userId).sort();

/* ═════════════════════════════════════════════════════════════════════════
 * WHO HEARS IT
 * ════════════════════════════════════════════════════════════════════════*/
describe('who hears a money decision', () => {
  test('a proposal decision goes to the lead’s salesperson, not to the capability', () => {
    return money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[0], decision: 'approved', approvedBy: 'Citi Lakes HOA',
      actorId: ACTOR.userId, actorName: ACTOR.name,
    }).then(() => {
      // Sam sells it (lead_1.salesperson_id = 12). Dana recorded it and is the
      // estimate's owner, and is excluded as the actor. Nobody else.
      expect(to()).toEqual(['sam@agx.test']);
    });
  });

  test('with no resolvable lead it falls back to the estimate’s owner', async () => {
    // data->>'lead_id' is a JSONB string that can outlive the lead it names.
    await money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[1], decision: 'approved', actorId: 99, actorName: 'Someone else',
    });
    expect(to()).toEqual(['dana@agx.test']);
  });

  test('a purchase order goes to the job’s PM and the PO’s raiser', async () => {
    await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'work_complete',
      subName: 'A Tree Surgeons', actorId: 99, actorName: 'Someone else',
    });
    expect(to()).toEqual(['dana@agx.test', 'pat@agx.test']);
  });

  test('a bill goes to the job’s PM and whoever entered it', async () => {
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99, actorName: 'Someone else',
    });
    expect(to()).toEqual(['dana@agx.test', 'pat@agx.test']);
  });

  test('NOBODY HEARS ABOUT THEIR OWN CLICK', async () => {
    // Dana is both the estimate's owner and the actor.
    await money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[1], decision: 'declined', actorId: 10, actorName: 'Dana',
    });
    expect(sentEmail).toHaveLength(0);
    expect(sentPush).toHaveLength(0);
  });

  test('another organisation never hears it, even named directly', async () => {
    tables.jobs[0].owner_id = 77;              // an org-2 user on an org-1 job
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99,
    });
    expect(to()).toEqual(['dana@agx.test']);
  });

  test('a deactivated user is not written to', async () => {
    tables.jobs[0].owner_id = 14;
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99,
    });
    expect(to()).toEqual(['dana@agx.test']);
  });

  test('switching the row off in My Account silences BOTH channels', async () => {
    tables.jobs[0].owner_id = 13;              // Muted Mo
    tables.bills[0].owner_id = 13;
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99,
    });
    expect(sentEmail).toHaveLength(0);
    expect(sentPush).toHaveLength(0);
  });

  test('and each CHANNEL is gated on its own, which is where the real guard is', async () => {
    // reachable() in front of the message is only an optimisation — it skips
    // the work for somebody who wants neither channel. The guard that matters
    // is per-channel inside notice-delivery deliver(), so mute the email half
    // alone and the push must still arrive.
    tables.users.push({ id: 15, name: 'Email Off', email: 'eo@agx.test', role: 'pm', organization_id: 1,
      notification_prefs: { bill_approval: false } });
    tables.jobs[0].owner_id = 15;
    tables.bills[0].owner_id = 15;
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99,
    });
    expect(sentEmail).toHaveLength(0);
    expect(pushedTo()).toEqual([15]);

    // and the other way round
    sentEmail.length = 0; sentPush.length = 0;
    tables.bills[0].approval_notified_at = null;
    tables.users[tables.users.length - 1].notification_prefs = { push: { bill_approval: false } };
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99,
    });
    expect(to()).toEqual(['eo@agx.test']);
    expect(sentPush).toHaveLength(0);
  });

  test('push rides alongside email, and each is gated on its own key', async () => {
    await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'approved', actorId: 99,
    });
    expect(pushedTo()).toEqual([10, 11]);
    expect(sentPush[0].payload.url).toContain('/jobs/job_1/job-purchase-orders');
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * WHAT IT SAYS — each of these is a factual claim that was wrong in a draft
 * ════════════════════════════════════════════════════════════════════════*/
describe('what the message is allowed to claim', () => {
  test('a proposal was RECORDED by a person — it does not say the client clicked', async () => {
    await money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[0], decision: 'approved', approvedBy: 'Citi Lakes HOA',
      actorId: 99, actorName: 'Dana',
    });
    const m = sentEmail[0];
    // Both routes need a logged-in ESTIMATES_EDIT user and approved_by is free
    // text typed into an "Approved by (client name)" box.
    expect(m.text).toContain('Dana recorded that Citi Lakes HOA approved');
    expect(m.text).not.toMatch(/the client (approved|accepted)/i);
  });

  test('a signature is named only when one is actually on the row', async () => {
    // The Purchase Orders hub has a BULK status setter that sends no
    // acceptance, so a PO reaches 'approved' with nothing signed. The sub's
    // NAME is passed in either way — it is on the row — so a draft that fell
    // back to it would print "signed by A Tree Surgeons" on a PO nobody signed.
    await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'approved',
      subName: 'A Tree Surgeons', actorId: 99, actorName: 'Dana',
    });
    expect(sentEmail[0].text).toContain('Sub: A Tree Surgeons');
    expect(sentEmail[0].text).not.toContain('signed by');

    // An acceptance that exists but was not accepted is still not a signature.
    sentEmail.length = 0;
    tables.pos[0].data.acceptance = { name: 'A Tree Surgeons', date: '2026-09-30', accepted: false };
    await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'approved',
      subName: 'A Tree Surgeons', actorId: 99, actorName: 'Dana',
    });
    expect(sentEmail[0].text).not.toContain('signed by');

    sentEmail.length = 0;
    tables.pos[0].data.acceptance = { name: 'A Tree Surgeons', date: '2026-09-30', accepted: true };
    await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'approved',
      subName: 'A Tree Surgeons', actorId: 99, actorName: 'Dana',
    });
    expect(sentEmail[0].text).toContain('signed by A Tree Surgeons');
  });

  test('a voided bill is called voided, never rejected', async () => {
    // 'void' is how a refusal AND a mis-keyed duplicate are both discarded, so
    // the message says what happened and does not guess why.
    await money.notifyBillDecided({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], to: 'void', actorId: 99, actorName: 'Dana',
    });
    expect(sentEmail[0].text).toContain('voided this bill');
    expect(sentEmail[0].text).not.toMatch(/reject/i);
  });

  test('a typed name cannot forge a second line anywhere it is printed', async () => {
    // Asserted where the NAME actually lands. The first version checked the
    // subject, which is built from the estimate title and never contains the
    // typed name at all — so that half was vacuously true, and removing either
    // squeeze left the suite green.
    await money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[0], decision: 'approved',
      approvedBy: 'HOA\nBcc: somewhere@else.test', actorId: 99, actorName: 'Dana',
    });
    const m = sentEmail[0];
    expect(m.text).toContain('HOA Bcc: somewhere@else.test');
    expect(m.text).not.toContain('HOA\nBcc:');
    expect(sentPush[0].payload.body).not.toContain('\n');
    expect(m.subject).not.toContain('\n');
  });

  test('and neither can a decline reason, which is 500 characters of free text', async () => {
    await money.notifyEstimateDecided({ query: mockRunQuery }, {
      estimate: tables.estimates[0], decision: 'declined',
      reason: 'too dear\nFrom: boss@agx.test', actorId: 99, actorName: 'Dana',
    });
    expect(sentEmail[0].text).not.toContain('\nFrom:');
  });

  test('only the two notable statuses say anything at all', async () => {
    for (const s of ['draft', 'issued', 'closed']) {
      const r = await money.notifyPoStatus({ query: mockRunQuery }, {
        po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: s, actorId: 99,
      });
      expect([s, r.skipped]).toEqual([s, 'not_notable']);
    }
    for (const s of ['paid', 'open']) {
      const r = await money.notifyBillDecided({ query: mockRunQuery }, {
        bill: tables.bills[0], orgId: 1, job: tables.jobs[0], to: s, actorId: 99,
      });
      expect([s, r.skipped]).toEqual([s, 'not_notable']);
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * ONCE PER WAIT, AND NOT ONCE PER WRITE
 * ════════════════════════════════════════════════════════════════════════*/
describe('the bill approval claim', () => {
  test('a second call for the same wait sends nothing', async () => {
    const a = await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    sentEmail.length = 0;
    const b = await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    expect([a.sent > 0, b.skipped]).toEqual([true, 'already_claimed']);
    expect(sentEmail).toHaveLength(0);
  });

  test('the claim is the UPDATE, not a read — it carries the IS NULL predicate', async () => {
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    const claim = queries.find((q) => /^UPDATE job_vendor_bills b SET approval_notified_at = NOW/.test(q.sql));
    expect(claim).toBeDefined();
    expect(claim.sql).toContain('b.approval_notified_at IS NULL');
    // it refuses a bill that is no longer open
    expect(claim.sql).toContain('b.status = $2');
    // and it carries its own org term rather than trusting the caller's read
    expect(claim.sql).toMatch(/j\.organization_id = \$3 OR j\.organization_id IS NULL/);
  });

  test('a bill that is no longer open is not announced as waiting', async () => {
    tables.bills[0].status = 'approved';
    tables.bills[0].approval_notified_at = null;
    const r = await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    expect(r.skipped).toBe('already_claimed');
    expect(sentEmail).toHaveLength(0);
  });

  test('clearing the claim lets the NEXT wait ask again', async () => {
    await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    tables.bills[0].approval_notified_at = null;   // what re-entering 'open' does
    sentEmail.length = 0;
    const again = await money.notifyBillAwaitingApproval({ query: mockRunQuery }, {
      bill: tables.bills[0], orgId: 1, job: tables.jobs[0], actorId: 99 });
    expect(again.sent).toBeGreaterThan(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * THE BULK SETTER
 * ════════════════════════════════════════════════════════════════════════*/
describe('a bulk status change does not mail a page of near-identical notices', () => {
  test('the burst cap stops it, and the rest are skipped rather than queued', async () => {
    // js/jobs-hub.js fires one request per selected row in PARALLEL, so forty
    // POs is forty notices in the same second.
    const results = [];
    for (let i = 0; i < money.BURST_CAP + 5; i++) {
      results.push(await money.notifyPoStatus({ query: mockRunQuery }, {
        po: Object.assign({}, tables.pos[0], { id: 'po_' + i }),
        orgId: 1, job: tables.jobs[0], to: 'work_complete', actorId: 99, now: 1700000000000,
      }));
    }
    const skipped = results.filter((r) => r.skipped === 'burst').length;
    expect(skipped).toBe(5);
    expect(results.filter((r) => r.sent > 0)).toHaveLength(money.BURST_CAP);
  });

  test('the cap is per window, so a later change is not punished', async () => {
    for (let i = 0; i < money.BURST_CAP; i++) {
      await money.notifyPoStatus({ query: mockRunQuery }, {
        po: Object.assign({}, tables.pos[0], { id: 'po_' + i }),
        orgId: 1, job: tables.jobs[0], to: 'work_complete', actorId: 99, now: 1700000000000 });
    }
    const later = await money.notifyPoStatus({ query: mockRunQuery }, {
      po: tables.pos[0], orgId: 1, job: tables.jobs[0], to: 'work_complete', actorId: 99,
      now: 1700000000000 + 61000 });
    expect(later.sent).toBeGreaterThan(0);
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * THE SYNC MUST NEVER FIRE ONE — the structural half
 * ════════════════════════════════════════════════════════════════════════*/
describe('the Buildertrend sync cannot reach a money notice', () => {
  const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8').replace(/\r\n/g, '\n');
  // CODE, NOT PROSE. The first version of these tests grepped for the string
  // "money-notices" and for "btStatus", and matched the explanatory comments
  // that mention both — including the comments in this change's own files. A
  // needle a comment satisfies proves nothing about what runs.
  const codeOf = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
  const REQUIRES_NOTICES = /require\((['"])[.\/]*[a-z\/-]*money-notices\1\)/;

  test('nothing under services/clickr/ requires money-notices', () => {
    // The sync re-statuses these rows every 30 minutes and can mint a purchase
    // order already at work_complete. One require here is hundreds of emails.
    const dir = path.join(__dirname, '..', 'server', 'services', 'clickr');
    const offenders = [];
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.js')) continue;
      const src = codeOf(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (REQUIRES_NOTICES.test(src)) offenders.push('server/services/clickr/' + f);
    }
    expect(offenders).toEqual([]);
  });

  test('the notifiers are called from route handlers only', () => {
    const dir = path.join(__dirname, '..', 'server');
    const callers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { walk(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = codeOf(fs.readFileSync(full, 'utf8'));
        if (REQUIRES_NOTICES.test(src)) callers.push(path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/'));
      }
    };
    walk(dir);
    // Three route files and nothing else. A fourth entry here is the review
    // question: can the sync reach it?
    expect(callers.sort()).toEqual([
      'server/routes/bill-routes.js',
      'server/routes/estimate-routes.js',
      'server/routes/purchase-order-routes.js',
    ]);
  });

  test('no notice hangs off grantSubAccessForPO — the one helper the sync shares', () => {
    // purchase-order-routes.js calls it after the status write and the sync
    // calls it after commit (grantPoSubAccessAfterCommit). A notice inside it
    // would fire for every matched PO in a run.
    const src = codeOf(read('server/services/po-sub-access.js'));
    expect(REQUIRES_NOTICES.test(src) || /notifyPoStatus/.test(src)).toBe(false);
  });

  test('no notice is wired to a status column, a trigger, or data.btStatus', () => {
    // Buildertrend's own proposal word (Approved, Declined) is refreshed into
    // data.btStatus on every apply, so a notice keyed on it would fire for
    // every worksheet in a run.
    expect(/btStatus/.test(codeOf(read('server/services/money-notices.js')))).toBe(false);
    for (const f of ['server/routes/bill-routes.js', 'server/routes/purchase-order-routes.js',
      'server/routes/estimate-routes.js']) {
      // Each call really is in this file's running code, not only described in
      // its comments.
      expect([f, REQUIRES_NOTICES.test(codeOf(read(f)))]).toEqual([f, true]);
    }
  });
});

/* ═════════════════════════════════════════════════════════════════════════
 * THROUGH THE REAL ROUTES
 *
 * The block above calls the notifiers directly, which says nothing about the
 * three guards that live in the handlers — and a mutation to each survived
 * this file until these existed:
 *
 *   · /approve and /decline stamped approved_at = NOW() and declined_at =
 *     NOW() with no COALESCE and no prior-status predicate, so a second
 *     click rewrote the date of a decision already recorded. /decline has no
 *     front-end double-click guard at all.
 *   · /decline left approved_at, approved_by, approval_method and signature
 *     in place while /approve already cleared the decline columns, so a
 *     declined estimate could still carry an approval signature.
 *   · a bill re-entering open has to CLEAR the notice claim, or the next
 *     genuine wait is silent for ever.
 * ════════════════════════════════════════════════════════════════════════*/
describe('through the real routes', () => {
  const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
  const { pool } = require('../server/db');
  let server, baseUrl;

  const DANA = { id: 10, email: 'dana@agx.test', role: 'admin', name: 'Dana', organization_id: 1 };

  beforeAll(async () => {
    tables = freshTables(); queries = [];
    setRolePool(pool);
    await refreshRoleCache();
    const app = express();
    app.use(express.json());
    app.use('/api/estimates', require('../server/routes/estimate-routes'));
    app.use('/api', require('../server/routes/bill-routes'));
    await new Promise((done) => {
      server = http.createServer(app);
      server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
    });
  });
  afterAll((done) => { server.close(() => done()); });

  async function call(method, path, user, body) {
    const res = await fetch(baseUrl + path, {
      method,
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(user) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    let json = null;
    try { json = await res.json(); } catch (e) { /* non-JSON */ }
    return { status: res.status, body: json };
  }

  test('approving twice records ONE decision and announces it once', async () => {
    const first = await call('POST', '/api/estimates/est_1/approve', DANA, { approved_by: 'Citi Lakes HOA' });
    expect(first.status).toBe(200);
    const stamped = tables.estimates.find((e) => e.id === 'est_1').approved_at;
    const firstSends = sentEmail.length;

    const again = await call('POST', '/api/estimates/est_1/approve', DANA, { approved_by: 'Someone Else' });
    expect(again.status).toBe(200);
    expect(again.body.unchanged).toBe(true);
    // The date of the decision does not move, and the second click says
    // nothing to anybody.
    expect(tables.estimates.find((e) => e.id === 'est_1').approved_at).toBe(stamped);
    expect(sentEmail.length).toBe(firstSends);
  });

  test('declining clears the approval stamps — no declined row keeps a signature', async () => {
    const e = tables.estimates.find((x) => x.id === 'est_1');
    e.approval_status = 'approved';
    e.approved_at = '2026-09-01T00:00:00.000Z';
    e.approved_by = 'Citi Lakes HOA';
    e.approval_method = 'manual';
    e.signature = { ink: 'yes' };
    const r = await call('POST', '/api/estimates/est_1/decline', DANA, { reason: 'went elsewhere' });
    expect(r.status).toBe(200);
    expect(e.approval_status).toBe('declined');
    expect([e.approved_at, e.approved_by, e.approval_method, e.signature]).toEqual([null, null, null, null]);
  });

  test('declining twice records ONE decision', async () => {
    await call('POST', '/api/estimates/est_1/decline', DANA, { reason: 'first' });
    const e = tables.estimates.find((x) => x.id === 'est_1');
    const stamped = e.declined_at;
    const again = await call('POST', '/api/estimates/est_1/decline', DANA, { reason: 'second' });
    expect(again.body.unchanged).toBe(true);
    expect(e.declined_at).toBe(stamped);
    expect(e.decline_reason).toBe('first');
  });

  test('a foreign estimate is still a 404, not an unchanged', async () => {
    tables.estimates.push({ id: 'est_theirs', owner_id: 77, organization_id: 2, approval_status: 'sent', data: {} });
    const r = await call('POST', '/api/estimates/est_theirs/approve', DANA, { approved_by: 'x' });
    expect(r.status).toBe(404);
  });

  test('sending a bill back to open clears the claim, so the next wait asks again', async () => {
    const b = tables.bills.find((x) => x.id === 'bill_1');
    b.status = 'approved';
    b.approval_notified_at = '2026-09-01T00:00:00.000Z';
    sentEmail.length = 0;
    const was = b.approval_notified_at;
    const r = await call('POST', '/api/bills/bill_1/status', DANA, { status: 'open' });
    expect(r.status).toBe(200);
    // The route clears the claim and then asks again, so a bill that comes
    // back for a second look is not silent.
    //
    // "not null" is NOT the assertion — the old claim is also not null, so
    // that passed whether or not the route cleared anything. What proves it is
    // that the stamp MOVED: cleared, then re-set by a fresh notice.
    await new Promise((d) => setTimeout(d, 30));
    expect(b.approval_notified_at).not.toBe(was);
    expect(b.approval_notified_at).not.toBe(null);
  });
});
