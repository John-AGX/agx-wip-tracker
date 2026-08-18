// Step 1 of the safety property: close every write that lands NULL.
//
// The agent path got its own gate (test/agent-turn-org-gate.test.js). It was
// the SMALLER half. requireOrgId existed in exactly six route files —
// auth, job, qb-cost, report, schedule, sub — while ~30 others bound
// `req.user.organization_id` straight into an INSERT with no gate at all.
//
// An org-less caller is not hypothetical. It is a state this system
// explicitly supports: db.js logs "[org] Admin … has NO organization" by
// name, services/user-org-scope.js's entire tolerance rationale is that such
// users must stay reachable, and sub-portal invite acceptance deliberately
// creates one when neither the sub's nor the inviter's org is known. So every
// door below could land a NULL-org row today, on the plain HTTP path, with no
// agent involved — and post-tightening those rows are invisible the moment
// they are written.
//
// Two shapes of fix, and which one a door gets is not a style choice:
//
//   requireOrgId  — the door has a request and a user. Refuse: 409
//                   ORG_UNRESOLVED (permanent, names the admin action) or 503
//                   ORG_LOOKUP_FAILED (retryable). Never save unscoped.
//   DERIVE        — the door has no usable caller org, but the row's PARENT
//                   has one. Read it from the parent. That is evidence, and it
//                   is the same anchor the read path resolves through.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const R = (f) => read('server', 'routes', f);
const CLIENT = R('client-routes.js');
const LEAD = R('lead-routes.js');
const EST = R('estimate-routes.js');
const INV = R('invoice-routes.js');
const PAYAPP = R('pay-application-routes.js');
const PO = R('purchase-order-routes.js');
const TASKSHARE = R('task-share-routes.js');
const SUBPORTAL = R('sub-portal-routes.js');
const FIN = read('server', 'services', 'job-financials.js');
const DB = read('server', 'db.js');

// The middleware list on one route mount (handles multi-line mounts).
function mount(src, verb, routePath) {
  const needle = 'router.' + verb + "('" + routePath + "'";
  const i = src.indexOf(needle);
  if (i === -1) throw new Error('no mount: ' + verb + ' ' + routePath);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('=> {') + 4);
}

describe('every create door with a request now refuses rather than saving unscoped', () => {
  const DOORS = [
    ['clients POST',            CLIENT, 'post', '/'],
    ['clients CSV import',      CLIENT, 'post', '/import'],
    ['leads POST',              LEAD,   'post', '/'],
    ['leads CSV import',        LEAD,   'post', '/import'],
    ['estimates bulk/save',     EST,    'put',  '/bulk/save'],
    ['invoices POST',           INV,    'post', '/invoices'],
    ['invoice from pay app',    INV,    'post', '/jobs/:jobId/invoices/from-pay-application/:payAppId'],
    ['payments POST',           INV,    'post', '/payments'],
    ['pay applications POST',   PAYAPP, 'post', '/jobs/:jobId/pay-applications'],
    ['purchase orders POST',    PO,     'post', '/jobs/:jobId/purchase-orders'],
  ];

  test.each(DOORS)('%s carries requireOrgId', (_name, src, verb, p) => {
    expect(mount(src, verb, p)).toMatch(/requireOrgId/);
  });

  test.each(DOORS)('%s runs the capability gate FIRST', (_name, src, verb, p) => {
    // An org-less caller who would have been 403'd anyway must not be told
    // about their org state instead — that answer discloses org state to
    // someone the capability gate should have stopped. Same ordering rule
    // test/org-divergence-count.test.js asserts for requireRole.
    const line = mount(src, verb, p);
    expect(line.indexOf('requireCapability')).toBeLessThan(line.indexOf('requireOrgId'));
  });

  test('the INSERTs bind the GATE\'s answer, not the raw claim', () => {
    // Leaving `req.user.organization_id` in the values array would make the
    // middleware decorative: it would refuse the null case and then still read
    // the same possibly-stale field. req.orgId is what requireOrgId resolved,
    // and resolveOrgId repairs req.user.organization_id from the users row when
    // the claim was missing.
    expect(CLIENT).toMatch(/const vals = \[id, parentId, req\.orgId\]/);
    expect(CLIENT).toMatch(/const vals = \[id, name, parentId, req\.orgId\];/);
    expect(CLIENT).toMatch(/\[id, company, req\.orgId\]/);
    expect((LEAD.match(/const vals = \[id, req\.user\.id, req\.orgId\]/g) || []).length).toBe(2);
    expect(EST).toMatch(/JSON\.stringify\(blob\), req\.orgId, estMarketId\]/);
    expect(PAYAPP).toMatch(/\[id, req\.params\.jobId, req\.orgId, req\.user\.id/);
    expect(PO).toMatch(/\[id, jobId, req\.orgId, req\.user\.id, subId/);
  });

  test('none of those create statements still binds the ungated claim', () => {
    expect(LEAD).not.toMatch(/const vals = \[id, req\.user\.id, req\.user\.organization_id\]/);
    expect(EST).not.toMatch(/JSON\.stringify\(blob\), req\.user\.organization_id/);
    expect(PAYAPP).not.toMatch(/\[id, req\.params\.jobId, req\.user\.organization_id/);
  });
});

describe('money rows are born inside a tenant, or not born', () => {
  test('the two money STAMPS refuse instead of writing a longhand NULL', () => {
    // `orgId == null ? null : orgId` is a NULL-stamp spelled out. This is the
    // shared service BOTH the HTTP routes and the agent payload dispatcher
    // land in, so it is the last place that can refuse.
    //
    // Only the two INSERT sites change. The other occurrences of that
    // expression in this file are READ predicates, where a null parameter is
    // a lookup value and not a row that will exist forever — turning those
    // into refusals would break by-id reads for no boundary gain.
    expect(FIN).toMatch(/requireOrgForMoney\(orgId, 'invoice'\)/);
    expect(FIN).toMatch(/requireOrgForMoney\(orgId, 'purchase order'\)/);
    // The two values arrays that decide what is WRITTEN no longer carry the
    // longhand null. Read predicates elsewhere in the file still do, and
    // correctly: there a null parameter selects the legacy NULL-org rows.
    expect(FIN).toMatch(/\[id, requireOrgForMoney\(orgId, 'invoice'\), ownerId \|\| null, jobId \|\| null,/);
    expect(FIN).toMatch(/\[id, jobId, requireOrgForMoney\(orgId, 'purchase order'\), ownerId \|\| null, subId,/);
    expect(FIN).not.toMatch(/\[id, orgId == null \? null : orgId, ownerId/);
    expect(FIN).not.toMatch(/\[id, jobId, orgId == null \? null : orgId, ownerId/);
  });

  test('the refusal explains BOTH consequences, not just visibility', () => {
    const fn = FIN.slice(FIN.indexOf('function requireOrgForMoney'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/readable by every tenant/);
    // The one nobody names: nextInvoiceNumber's predicate is
    // `($1 IS NULL AND organization_id IS NULL)`, so NULL-org rows number in
    // their own space and a run of them forks the sequence.
    expect(body).toMatch(/outside the numbering/);
    expect(FIN).toMatch(/\(\$1 IS NULL AND organization_id IS NULL\)/);
  });

  test('nothing is saved before the refusal', () => {
    // It is evaluated inside the values array of the INSERT itself, so the
    // throw happens before the statement is issued.
    const seg = FIN.slice(FIN.indexOf('INSERT INTO invoices'));
    expect(seg.slice(0, 1200)).toMatch(/requireOrgForMoney/);
  });
});

describe('doors with no usable caller org DERIVE from the parent', () => {
  test('the task-share photo is stamped from the task the handler already loaded', () => {
    // This looked like the one genuinely underivable population: a logged-out
    // crew member, so uploaded_by is NULL by design (no rung 3) and the INSERT
    // named no organization_id (no rung 2). But the parent is a TASK,
    // tasks.organization_id is NOT NULL, and loadShare SELECTed the whole row
    // onto req.task before the handler ran. The value was in hand.
    expect(DB).toMatch(/CREATE TABLE IF NOT EXISTS tasks[\s\S]{0,4000}?organization_id\s+INTEGER NOT NULL/);
    expect(TASKSHARE).toMatch(/req\.task = tR\.rows\[0\]/);
    const ins = TASKSHARE.slice(TASKSHARE.indexOf('INSERT INTO attachments'));
    expect(ins.slice(0, 900)).toMatch(/organization_id/);
    expect(ins).toMatch(/req\.task\.organization_id\]/);
  });

  test('the sub-portal upload derives from the PARENT, never from the sub', () => {
    // A sub-portal user's own org is the WRONG source: the file belongs to
    // whatever tenant owns the job it hangs on, and the sub is a guest with a
    // grant, not a member.
    const seg = SUBPORTAL.slice(SUBPORTAL.indexOf('let parentOrgId = null;'));
    expect(seg.slice(0, 900)).toMatch(/ENTITY_TABLES\[entity_type\]/);
    expect(seg.slice(0, 900)).toMatch(/SELECT organization_id FROM ' \+ parentTable/);
    expect(seg).not.toMatch(/req\.user\.organization_id/);
    const ins = SUBPORTAL.slice(SUBPORTAL.indexOf('INSERT INTO attachments'));
    expect(ins.slice(0, 700)).toMatch(/organization_id\)/);
    expect(ins).toMatch(/position, req\.user\.id, parentOrgId/);
  });

  test('an unresolvable parent leaves NULL and is COUNTED — it is never guessed', () => {
    // The whole safety property in one branch: a row whose org cannot be
    // derived stays NULL and shows up in the audit, rather than being assigned
    // a tenant nothing evidenced. A wrong tenant is worse than none.
    expect(SUBPORTAL).toMatch(/not fatal and not a guess/i);
    expect(SUBPORTAL).toMatch(/org-boundary/);
  });
});

describe('the boundary widened, nothing narrowed', () => {
  test('a caller-supplied sub id is proved at the PO create door too', () => {
    const seg = PO.slice(PO.indexOf("router.post('/jobs/:jobId/purchase-orders'"));
    expect(seg.slice(0, 1600)).toMatch(/await subInOrg\(pool, subId, req\.orgId\)/);
    expect(seg.slice(0, 1600)).toMatch(/status\(404\)/);
  });

  test('no tolerance arm was dropped and no constraint added', () => {
    for (const src of [CLIENT, LEAD, EST, INV, PO]) {
      expect((src.match(/organization_id IS NULL/g) || []).length).toBeGreaterThan(0);
    }
    expect(DB).not.toMatch(/SET NOT NULL/);
  });

  test('requireOrgId now reaches past the original six files', () => {
    const files = fs.readdirSync(path.join(__dirname, '..', 'server', 'routes'))
      .filter((f) => f.endsWith('.js'))
      .filter((f) => R(f).indexOf('requireOrgId') !== -1);
    // Was: auth, job, qb-cost, report, schedule, sub.
    expect(files.length).toBeGreaterThanOrEqual(12);
    for (const f of ['client-routes.js', 'lead-routes.js', 'estimate-routes.js',
                     'invoice-routes.js', 'pay-application-routes.js',
                     'purchase-order-routes.js', 'admin-agents-routes.js']) {
      expect({ f, gated: files.indexOf(f) !== -1 }).toEqual({ f, gated: true });
    }
  });
});
