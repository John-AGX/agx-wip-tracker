/* SOMETHING LANDED ON YOUR JOB, AND NOBODY WAS TOLD.
 *
 * Two notices: a subcontractor put a document in a folder you shared, and
 * somebody logged a cost against a job you run.
 *
 * WHAT THIS FILE GUARDS:
 *
 *   1. THE RECIPIENT SURVIVES CONTACT WITH PRODUCTION. The obvious recipient
 *      for an upload is attachment_folder_grants.granted_by — and it is NULL
 *      across the population that matters, because the automatic PO grant binds
 *      `userId || null` and a Buildertrend sync tick has no user at all. Every
 *      test below that resolves a recipient does it with granted_by NULL unless
 *      it says otherwise, because that is the normal case, not the edge.
 *   2. ONE HANDLER FIRES EACH NOTICE. `attachments` has a dozen INSERT sites and
 *      the crew-link photo door ALREADY notifies the same table under
 *      ticket_crew_activity; `receipts` is re-pointed in bulk by two writers
 *      outside any create route. Either notice hung off the table mails the lot.
 *   3. THE MESSAGE CLAIMS ONLY WHAT IS TRUE. No photo on a receipt (it is
 *      attached afterwards), no assertion that the amount is right (the Cost
 *      Inbox labels it "AI-read · unconfirmed" itself), and nothing about who
 *      the actor is (POST /api/receipts has no capability check at all).
 *   4. NOBODY HEARS ABOUT THEIR OWN ACTION, which under act-as is two ids.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const { liveLine, liveLines } = require('./helpers/live-line');

let tables;
let queries;

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRunQuery(sql, params) },
}));

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

  if (/^SELECT id, name, organization_id FROM subs WHERE id = \$1/.test(text)) {
    const s = rowsOf('subs').find((x) => String(x.id) === String(p[0]));
    return { rows: s ? [s] : [] };
  }
  if (/^SELECT name FROM subs WHERE id = \$1/.test(text)) {
    const s = rowsOf('subs').find((x) => String(x.id) === String(p[0]));
    if (!s || !orgOk(s, p[1])) return { rows: [] };
    return { rows: [{ name: s.name }] };
  }
  if (/^SELECT owner_id, data FROM jobs WHERE id = \$1/.test(text)) {
    const j = rowsOf('jobs').find((x) => String(x.id) === String(p[0]));
    if (!j || !orgOk(j, p[1])) return { rows: [] };
    return { rows: [{ owner_id: j.owner_id, data: j.data || {} }] };
  }
  if (/^SELECT salesperson_id, title FROM leads WHERE id = \$1/.test(text)) {
    const l = rowsOf('leads').find((x) => String(x.id) === String(p[0]));
    if (!l || !orgOk(l, p[1])) return { rows: [] };
    return { rows: [{ salesperson_id: l.salesperson_id, title: l.title }] };
  }
  if (/^SELECT owner_id, data FROM estimates WHERE id = \$1/.test(text)) {
    const e = rowsOf('estimates').find((x) => String(x.id) === String(p[0]));
    if (!e || !orgOk(e, p[1])) return { rows: [] };
    return { rows: [{ owner_id: e.owner_id, data: e.data || {} }] };
  }
  if (/^SELECT name FROM clients WHERE id = \$1/.test(text)) {
    const c = rowsOf('clients').find((x) => String(x.id) === String(p[0]));
    if (!c || !orgOk(c, p[1])) return { rows: [] };
    return { rows: [{ name: c.name }] };
  }
  if (/^SELECT granted_by FROM attachment_folder_grants/.test(text)) {
    const g = rowsOf('grants').find((x) => String(x.sub_id) === String(p[0])
      && String(x.entity_type) === String(p[1]) && String(x.entity_id) === String(p[2]));
    return { rows: g ? [{ granted_by: g.granted_by }] : [] };
  }
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

  return { rows: [], rowCount: 0 };
}

const ORG = 1;
const OTHER_ORG = 2;

function freshTables() {
  return {
    users: [
      { id: 10, name: 'Dana', email: 'dana@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 11, name: 'Mo', email: 'mo@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 14, name: 'Pat', email: 'pat@agx.test', organization_id: ORG, active: true, notification_prefs: {} },
      { id: 90, name: 'Elsewhere', email: 'nope@other.test', organization_id: OTHER_ORG, active: true, notification_prefs: {} },
      { id: 99, name: 'Gone', email: 'gone@agx.test', organization_id: ORG, active: false, notification_prefs: {} },
      // The sub's own portal login is a real users row.
      { id: 50, name: 'Acme Roofing', email: 'acme@vendor.test', organization_id: ORG, active: true, role: 'sub', notification_prefs: {} },
    ],
    subs: [
      { id: 's1', name: 'Acme Roofing', organization_id: ORG },
      { id: 'sOrgless', name: 'Nowhere Ltd', organization_id: null },
    ],
    jobs: [
      { id: 'j1', owner_id: 14, organization_id: ORG, data: { jobNumber: '1042', title: 'River Landing' } },
      { id: 'jOther', owner_id: 90, organization_id: OTHER_ORG, data: { title: 'Not yours' } },
    ],
    leads: [{ id: 'L1', salesperson_id: 11, organization_id: ORG, title: 'Citi Lakes rewrap' }],
    estimates: [{ id: 'E1', owner_id: 10, organization_id: ORG, data: { title: 'Rewrap proposal' } }],
    clients: [{ id: 'C1', name: 'Citi Lakes HOA', organization_id: ORG }],
    // granted_by NULL is the NORMAL case: the automatic PO grant binds
    // `userId || null` and a sync tick has no user.
    grants: [{ sub_id: 's1', entity_type: 'job', entity_id: 'j1', granted_by: null }],
  };
}

const notices = require('../server/services/arrival-notices');
const db = { query: mockRunQuery };

beforeEach(() => {
  tables = freshTables();
  queries = [];
  sentEmail.length = 0;
  sentPush.length = 0;
  notices._resetBurst();
});

const to = () => sentEmail.map((m) => m.to).sort();
const body = () => (sentEmail[0] || { text: '' }).text;

function upload(over) {
  return notices.notifySubDocumentUploaded(db, Object.assign({
    subId: 's1', entityType: 'job', entityId: 'j1',
    folder: 'general', filename: 'COI-2026.pdf', actorIds: [50],
  }, over || {}));
}

function receipt(over) {
  return notices.notifyReceiptLogged(db, Object.assign({
    receipt: {
      id: 'r1', entity_type: 'job', entity_id: 'j1', amount: '248.19',
      vendor: 'Home Depot', cost_code: 'materials',
    },
    orgId: ORG, actorIds: [10], actorName: 'Dana',
  }, over || {}));
}

/* ═══════════════════════════════════════════════════════════════════════════
 * A SUBCONTRACTOR UPLOADED A DOCUMENT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a sub uploads a document', () => {
  test('it reaches the job’s PM even though granted_by is NULL', async () => {
    // THE case: every automatic grant has granted_by NULL, so a notice keyed on
    // it alone would be silent exactly where the population is largest.
    const r = await upload();
    expect(to()).toEqual(['pat@agx.test']);          // jobs.owner_id
    expect(r.sent).toBe(1);
  });

  test('whoever opened the folder is told too, when there is such a person', async () => {
    tables.grants[0].granted_by = 10;
    await upload();
    expect(to()).toEqual(['dana@agx.test', 'pat@agx.test']);
  });

  test('the same person who owns the job and opened the folder gets ONE copy', async () => {
    tables.grants[0].granted_by = 14;
    await upload();
    expect(to()).toEqual(['pat@agx.test']);
    expect(sentEmail).toHaveLength(1);
  });

  test('a lead-granted folder reaches the salesperson', async () => {
    tables.grants.push({ sub_id: 's1', entity_type: 'lead', entity_id: 'L1', granted_by: null });
    await upload({ entityType: 'lead', entityId: 'L1' });
    expect(to()).toEqual(['mo@agx.test']);
    expect(body()).toContain('Citi Lakes rewrap');
  });

  test('a CLIENT-granted folder has no owner: only whoever shared it is told', async () => {
    tables.grants.push({ sub_id: 's1', entity_type: 'client', entity_id: 'C1', granted_by: 10 });
    await upload({ entityType: 'client', entityId: 'C1' });
    expect(to()).toEqual(['dana@agx.test']);
  });

  test('a client folder shared by nobody reaches nobody — it is not guessed at', async () => {
    tables.grants.push({ sub_id: 's1', entity_type: 'client', entity_id: 'C1', granted_by: null });
    const r = await upload({ entityType: 'client', entityId: 'C1' });
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
    expect(sentEmail).toHaveLength(0);
  });

  test('the org comes from the SUB, not from the caller or the new row', async () => {
    // A sub-portal user's own organization_id can be NULL, and the attachment's
    // is derived from the parent and legitimately lands NULL. The sub record is
    // the one thing here that reliably names a tenant.
    const r = await upload({ subId: 'sOrgless' });
    expect([r.sent, r.skipped]).toEqual([0, 'no_org']);
  });

  test('another tenant’s job is never reached, however the id was guessed', async () => {
    const r = await upload({ entityId: 'jOther' });
    expect([r.sent, r.skipped]).toEqual([0, 'no_parent']);
    expect(to()).not.toContain('nope@other.test');
  });

  test('the sub is not told about their own upload', async () => {
    tables.grants[0].granted_by = 50;               // the sub's own portal user
    await upload();
    expect(to()).not.toContain('acme@vendor.test');
    expect(to()).toEqual(['pat@agx.test']);
  });

  test('the message reports the filename and claims nothing about what it is', async () => {
    await upload({ filename: 'scan_0001.pdf' });
    const t = body();
    expect(t).toContain('scan_0001.pdf');
    expect(t).toContain('Acme Roofing uploaded');
    expect(t).toContain('1042 · River Landing');
    // not a certificate, not insurance, not "your COI" — nothing interpreted
    expect(t.toLowerCase()).not.toContain('certificate');
    expect(t.toLowerCase()).not.toContain('insurance');
  });

  test('a hostile filename cannot inject markup into the email', async () => {
    await upload({ filename: '<img src=x onerror=alert(1)>.pdf' });
    expect(sentEmail[0].html).not.toContain('<img src=x');
    expect(sentEmail[0].html).toContain('&lt;img');
  });

  test('an owner who is NOT in this tenant is stopped by the recipient read', async () => {
    // The parent read cannot catch this one: the JOB is in the right org and
    // only its owner_id points elsewhere — a user who changed organisations,
    // or a mis-stamped row. The org term on the users lookup is the only
    // thing between that and another tenant\u2019s mailbox. Found by mutation:
    // stripping that term left every other test in this file green.
    tables.jobs[0].owner_id = 90;
    const r = await upload();
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
    expect(to()).not.toContain('nope@other.test');
  });

  test('a deactivated PM is skipped', async () => {
    tables.jobs[0].owner_id = 99;
    const r = await upload();
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * A COST WAS LOGGED
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a receipt is logged', () => {
  test('it reaches the job’s PM, not the person who captured it', async () => {
    const r = await receipt();
    expect(to()).toEqual(['pat@agx.test']);
    expect(r.sent).toBe(1);
  });

  test('under act-as BOTH ids are dropped', async () => {
    // The PM is acting as somebody; neither hears about their own capture.
    tables.jobs[0].owner_id = 14;
    const r = await receipt({ actorIds: [10, 14] });
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
  });

  test('a lead-linked receipt reaches the salesperson', async () => {
    await receipt({ receipt: { id: 'r2', entity_type: 'lead', entity_id: 'L1', amount: '80', vendor: 'Lowes', cost_code: 'materials' } });
    expect(to()).toEqual(['mo@agx.test']);
  });

  test('an UNLINKED capture notifies nobody — and that is the honest limit', async () => {
    // The default capture is unlinked (the modal opens on "— select a job —"),
    // and an unlinked unprocessed row is exactly the one somebody should go
    // finish. It has no recipient column anywhere, so this notice cannot be the
    // one that chases it.
    const r = await receipt({ receipt: { id: 'r3', entity_type: null, entity_id: null, amount: '12' } });
    expect([r.sent, r.skipped]).toEqual([0, 'not_linked']);
  });

  test('a CATEGORY receipt notifies nobody either', async () => {
    const r = await receipt({ receipt: { id: 'r4', entity_type: 'category', entity_id: 'cat_tools', amount: '12' } });
    expect([r.sent, r.skipped]).toEqual([0, 'not_linked']);
  });

  test('the message never mentions a photo — it is not attached yet', async () => {
    await receipt();
    // The TEXT body, deliberately: every email this repo sends carries the
    // logo at /images/logo-color.png through notice-text.emailShell, so an
    // assertion on the HTML would be testing the shell rather than the copy.
    const t = body().toLowerCase();
    expect(t).not.toContain('photo');
    expect(t).not.toContain('receipt image');
    expect(t).not.toContain('attached');
  });

  test('the amount is reported, never asserted as checked', async () => {
    await receipt();
    const t = body();
    expect(t).toContain('$248.19');
    expect(t).toContain('Amount on the receipt');
    expect(t).toContain('may not have been checked');
    // and in the HTML too: the mutation that replaced the caveat with
    // "Confirmed spend." touched only the HTML branch and this file did not
    // notice, because every other assertion here reads the text version.
    expect(sentEmail[0].html).toContain('may not have been checked');
    expect(sentEmail[0].html).not.toMatch(/Confirmed|Verified/i);
    // never a claim that the company spent this
    expect(t).not.toMatch(/spent \$|was charged \$/);
  });

  test('it says nothing about who the actor is — the route has no capability check', async () => {
    await receipt({ actorName: 'Whoever' });
    const t = body();
    expect(t).toContain('Whoever logged a cost');
    expect(t.toLowerCase()).not.toContain('crew');
    expect(t.toLowerCase()).not.toContain('colleague');
    expect(t.toLowerCase()).not.toContain('staff');
  });

  test('another tenant’s job is never reached', async () => {
    const r = await receipt({ receipt: { id: 'r5', entity_type: 'job', entity_id: 'jOther', amount: '1' } });
    expect([r.sent, r.skipped]).toEqual([0, 'no_parent']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE BURST CAP, KEYED ON THE PERSON
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a stack of receipts does not become a stack of emails', () => {
  test('one capturer is capped within the minute', async () => {
    const now = Date.parse('2026-10-02T12:00:00Z');
    let sent = 0;
    for (let i = 0; i < notices.BURST_CAP + 4; i++) {
      const r = await receipt({ now: now + i * 10 });
      if (!r.skipped) sent++;
    }
    expect(sent).toBe(notices.BURST_CAP);
  });

  test('and capping one capturer does NOT silence another', async () => {
    // money-notices caps on the literal strings 'estimate' | 'po' | 'bill', so
    // one org's burst starves every other tenant in the same process-minute.
    // Keyed on the person, a crew quiets their own PM's mail and nobody else's.
    const now = Date.parse('2026-10-02T12:00:00Z');
    for (let i = 0; i < notices.BURST_CAP + 2; i++) await receipt({ now: now + i });
    sentEmail.length = 0;
    const other = await receipt({ actorIds: [11], actorName: 'Mo', now: now + 99 });
    expect(other.skipped).toBeUndefined();
    expect(to()).toEqual(['pat@agx.test']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE SWITCHES
 * ══════════════════════════════════════════════════════════════════════════*/
describe('preferences', () => {
  test('each notice has its own switch, and they are independent', async () => {
    tables.users.find((u) => u.id === 14).notification_prefs = { receipt_logged: false };
    await upload();
    expect(to()).toEqual(['pat@agx.test']);          // uploads still arrive
    sentEmail.length = 0;
    await receipt();
    expect(to()).toEqual([]);                        // costs do not
    expect(sentPush.map((x) => x.userId)).toContain(14);  // push unaffected
  });

  test('both off on both channels means nothing is composed', async () => {
    tables.users.find((u) => u.id === 14).notification_prefs = {
      sub_document_uploaded: false, push: { sub_document_uploaded: false },
    };
    const r = await upload();
    expect([r.sent, r.skipped]).toEqual([0, 'nobody']);
  });

  test('the catalog carries both, in one contiguous group of their own', () => {
    const { NOTIFY_EVENTS } = require('../server/notify-events');
    const keys = Object.values(notices.KEYS);
    for (const k of keys) {
      const row = NOTIFY_EVENTS.find((e) => e.key === k);
      expect([k, !!row]).toEqual([k, true]);
      expect([k, row.group]).toEqual([k, 'Arrivals']);
    }
    expect(NOTIFY_EVENTS.filter((e) => e.group === 'Arrivals').map((e) => e.key)).toEqual(keys);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ONE HANDLER EACH — THE TRAP THAT WOULD DOUBLE-MAIL
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the doors', () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, '..', f), 'utf8');

  test('the sub-portal upload notifies, exactly once, from its own handler', () => {
    const src = read('server/routes/sub-portal-routes.js');
    expect(liveLines(src, 'notifySubDocumentUploaded').length).toBe(1);
    expect(liveLines(src, 'inflight.track(').length).toBe(1);
    // The call must also be REACHED. liveLines only asks whether a line is
    // uncommented, so wrapping it in `if (false)` left this green — the
    // statement has to begin the line for liveLine to accept it.
    expect(liveLine(src, "trackNotice('sub document notice', function () {")).toBe(true);
  });

  test('the Cost Inbox create notifies, exactly once, and drops both ids', () => {
    const src = read('server/routes/receipt-routes.js');
    expect(liveLines(src, 'notifyReceiptLogged').length).toBe(1);
    expect(liveLines(src, 'actorIds: [callerUserId(req), getAttributedUserId(req)]').length).toBe(1);
    expect(liveLine(src, "trackNotice('receipt notice', function () {")).toBe(true);
  });

  test('NOTHING else in the server calls either notifier', () => {
    // The crew-link photo door already notifies the same table as photo_added
    // under ticket_crew_activity, and `receipts` is re-pointed in bulk by two
    // writers outside any create route. A second caller is a double-mail.
    const dir = path.join(__dirname, '..', 'server');
    const callers = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(full); continue; }
        if (!e.name.endsWith('.js')) continue;
        const src = fs.readFileSync(full, 'utf8');
        if (/arrival-notices/.test(src)) {
          callers.push(path.relative(path.join(__dirname, '..'), full).replace(/\\/g, '/'));
        }
      }
    };
    walk(dir);
    expect(callers.sort()).toEqual([
      'server/routes/receipt-routes.js',
      'server/routes/sub-portal-routes.js',
      'server/services/arrival-notices.js',
    ]);
  });

  test('the Buildertrend sync cannot reach either notice', () => {
    const dir = path.join(__dirname, '..', 'server', 'services', 'clickr');
    for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.js'))) {
      const src = fs.readFileSync(path.join(dir, f), 'utf8');
      expect([f, /arrival-notices/.test(src)]).toEqual([f, false]);
    }
  });

  test('no new organization_id IS NULL arm is invented', () => {
    // Every arm in the notifier COPIES the one its neighbouring reads already
    // carry; none is new relative to the tables it touches.
    const src = read('server/services/arrival-notices.js');
    const arms = liveLines(src, 'organization_id IS NULL');
    expect(arms.length).toBe(5);                      // job, lead, estimate, client, sub
    for (const a of arms) expect(a).toContain('organization_id = $2');
  });
});
