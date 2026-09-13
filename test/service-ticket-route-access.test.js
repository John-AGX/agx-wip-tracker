// THE SERVICE-TICKET REST DOORS — WHO MAY SEE AND CHANGE A TICKET, EXECUTED.
//
// ── WHAT THIS FILE PINS ───────────────────────────────────────────────────
// Four boundary holes in the shipped ticket routes, closed so that the AI doors
// (86 reading a ticket, the Scribe drafting one) copy a correct rule instead of
// a broken one:
//
//   1. THE NARROW TIER WAS NEVER NARROWED. JOBS_VIEW_ASSIGNED / JOBS_EDIT_OWN
//      were accepted and then nothing asked whether the job was the caller's,
//      so a crew lead granted ONE job could read and edit every job's tickets.
//      Every decision in both route files now goes through
//      services/service-ticket-access.js#mayAccessTicketParent, and a caller
//      who holds the narrow capability but not THIS job gets the same 404 a
//      missing ticket gets — never a 403 that says "it exists, not for you".
//   2. THE LIST HAD NO GATE AT ALL. Any signed-in user, whatever the role, could
//      list every ticket in the org with its scope and internal notes.
//   3. THE DETAIL READ LEAKED PRIVATE TO-DOS. A personal to-do can hang off a
//      ticket; opening the ticket showed its title to everyone and counted it
//      in the progress bar. The guest (token) read had the same gap, worse.
//   4. THE ASSIGNEE WAS WRITTEN RAW. The foreign key proves a user EXISTS, not
//      whose they are, so a ticket could be assigned to another tenant's user.
//
// ── HOW ───────────────────────────────────────────────────────────────────
// Nothing here reads route source as a pass condition. The REAL handlers run —
// real requireAuth over a signed JWT, real requireOrgId, the real role cache
// loaded from a `roles` table — against node:sqlite through the pg shim, and
// the assertions are on what came back and on what the rows say afterwards.
//
// Then every guard is REMOVED from a copy of the shipped file and the identical
// drive is shown to produce the exact wrong outcome the guard exists to stop.
// A guard nobody has watched fire is a guard nobody has evidence for.
//
// The mutant copies go to the OS temp dir, never into server/: other suites
// census server/ for source and would intermittently catch a file that existed
// for two hundred milliseconds. Every require in the copy is rewritten to an
// absolute path so it loads the SAME db pool, auth cache and access module the
// shipped file does.
//
// ── THE CRLF TRAP ─────────────────────────────────────────────────────────
// Both route files are CRLF on disk and the anchors below are written LF. An
// LF-anchored replace against CRLF bytes changes nothing, the "mutant" is the
// shipped code, and the test passes having proved nothing. mutant() normalises
// every anchor to the file's own line ending and THROWS when an anchor is
// absent, matches more than once, or moves no bytes.
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const ROUTES_DIR = path.join(__dirname, '..', 'server', 'routes');
const TICKET_ROUTES = path.join(ROUTES_DIR, 'service-ticket-routes.js');
const SHARE_ROUTES = path.join(ROUTES_DIR, 'service-ticket-share-routes.js');

const TABLES = [
  'organizations', 'users', 'roles', 'jobs', 'job_access', 'leads', 'tasks',
  'service_tickets', 'service_ticket_events', 'service_ticket_shares',
  'service_ticket_revisions', 'service_ticket_participants',
  // The detail and the share read now carry each subtask's photos (the
  // work-order view), so the ticket read touches attachments too.
  'attachments',
];

// The people. Role names are deliberately NOT 'admin' / 'system_admin', so no
// adminish short-circuit anywhere can stand in for the capability under test.
const WIDE = 10;      // JOBS_VIEW_ALL + JOBS_EDIT_ANY + both lead caps
const CREW = 20;      // the narrow tier only: JOBS_VIEW_ASSIGNED + JOBS_EDIT_OWN
const LEADER = 30;    // lead capabilities only
const NOBODY = 40;    // signed in, no ticket-relevant capability at all
const OTHER = 60;     // a second narrow-tier user in the same org
const RIVAL = 50;     // a user in ANOTHER organization

const USERS = {
  [WIDE]: { role: 'st_wide', org: 1 },
  [CREW]: { role: 'st_crew', org: 1 },
  [LEADER]: { role: 'st_leads', org: 1 },
  [NOBODY]: { role: 'st_none', org: 1 },
  [OTHER]: { role: 'st_crew', org: 1 },
  [RIVAL]: { role: 'st_wide', org: 2 },
};

const ORG1_TICKETS = ['st_conv', 'st_j1', 'st_j2', 'st_j3', 'st_j4', 'st_l1'];

let eng;
let auth;
let ticketRouter;
let shareRouter;

function seed() {
  const caps = (list) => "'" + JSON.stringify(list) + "'";
  eng.db.exec(`
    DELETE FROM organizations; DELETE FROM users; DELETE FROM roles; DELETE FROM jobs;
    DELETE FROM job_access; DELETE FROM leads; DELETE FROM tasks; DELETE FROM service_tickets;
    DELETE FROM service_ticket_events; DELETE FROM service_ticket_shares;
    DELETE FROM service_ticket_revisions; DELETE FROM service_ticket_participants;

    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO roles (name, capabilities) VALUES
      ('st_wide',  ${caps(['JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_crew',  ${caps(['JOBS_VIEW_ASSIGNED', 'JOBS_EDIT_OWN'])}),
      ('st_leads', ${caps(['LEADS_VIEW', 'LEADS_EDIT'])}),
      ('st_none',  ${caps(['ESTIMATES_VIEW'])});
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'Wendy Wide', 'w@agx.test', 'st_wide', 1),
      (20, 'Carl Crew', 'c@agx.test', 'st_crew', 1),
      (30, 'Lena Leads', 'l@agx.test', 'st_leads', 1),
      (40, 'Nora None', 'n@agx.test', 'st_none', 1),
      (60, 'Otto Other', 'o@agx.test', 'st_crew', 1),
      (50, 'Rival Ray', 'r@rival.test', 'st_wide', 2);

    -- j1: CREW holds a VIEW grant.  j2: CREW holds an EDIT grant.
    -- j3: CREW owns it.             j4: CREW has nothing; OTHER holds a grant.
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j2', 10, '{}', 1), ('j3', 20, '{}', 1),
      ('j4', 10, '{}', 1), ('j9', 50, '{}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 20, 'view'), ('j2', 20, 'edit'), ('j4', 60, 'edit');
    INSERT INTO leads (id, title, organization_id) VALUES
      ('l1', 'Maple St reroof', 1), ('l9', 'Rival lead', 2);

    -- st_conv is a converted lead's ticket: it carries BOTH parents, and the
    -- job governs it.
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, checklist, created_at) VALUES
      ('st_j1',   1, 'Gate on j1',     'j1', NULL, 'open', '[]', '2026-09-01 10:00:01'),
      ('st_j2',   1, 'Gate on j2',     'j2', NULL, 'open', '[]', '2026-09-01 10:00:02'),
      ('st_j3',   1, 'Gate on j3',     'j3', NULL, 'open', '[]', '2026-09-01 10:00:03'),
      ('st_j4',   1, 'Gate on j4',     'j4', NULL, 'open', '[]', '2026-09-01 10:00:04'),
      ('st_conv', 1, 'Converted gate', 'j4', 'l1', 'open', '[]', '2026-09-01 10:00:05'),
      ('st_l1',   1, 'Lead gate',      NULL, 'l1', 'open', '[]', '2026-09-01 10:00:06'),
      ('st_b',    2, 'RIVAL gate',     'j9', NULL, 'open', '[]', '2026-09-01 10:00:07');

    -- Three tasks under st_j1: one org task, one of CREW's personal to-dos,
    -- and one of OTHER's. Only the first is anybody-who-can-see-the-ticket's.
    INSERT INTO tasks (id, organization_id, title, status, scope, owner_user_id, service_ticket_id, entity_type, entity_id, created_at) VALUES
      ('k_org',   1, 'Order the latch',            'done', 'org',      NULL, 'st_j1', 'job', 'j1', '2026-09-02 08:00:01'),
      ('k_crew',  1, 'CREW-PRIVATE call supplier', 'open', 'personal', 20,   'st_j1', 'job', 'j1', '2026-09-02 08:00:02'),
      ('k_other', 1, 'OTHER-PRIVATE dentist',      'done', 'personal', 60,   'st_j1', 'job', 'j1', '2026-09-02 08:00:03');
  `);
}

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), {
    jsonColumns: ['checklist', 'capabilities', 'detail', 'fields', 'data'],
  });
  eng.db.exec('CREATE UNIQUE INDEX idx_stp_ticket_user ON service_ticket_participants (ticket_id, user_id)');
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seed();
  await auth.refreshRoleCache();
  ticketRouter = require('../server/routes/service-ticket-routes');
  shareRouter = require('../server/routes/service-ticket-share-routes');
});

// Fire-and-forget continuations (last-seen bumps, share stats, event rows)
// must drain before the engine closes or jest reports a late log as a failure
// this file manufactured.
const flush = () => new Promise((r) => setTimeout(r, 25));

let mutantPaths = [];
afterEach(async () => {
  await flush();
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* never loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
});

beforeEach(() => seed());

// ── the drive ─────────────────────────────────────────────────────────────
function fakeRes() {
  const res = { statusCode: 200, body: undefined, headersSent: false };
  res.status = (c) => { res.statusCode = c; return res; };
  res.json = (p) => { res.body = p; res.headersSent = true; return res; };
  res.set = () => res;
  return res;
}

function tokenFor(uid) {
  const u = USERS[uid];
  return auth.signToken({ id: uid, email: uid + '@t.test', name: 'U' + uid, role: u.role, organization_id: u.org });
}

// Runs the WHOLE middleware chain of one declared route — requireAuth and
// requireOrgId included — the way express would.
async function drive(router, method, routePath, opts) {
  const o = opts || {};
  const layer = router.stack.find((l) => l.route && l.route.path === routePath && l.route.methods[method]);
  if (!layer) throw new Error('route not declared: ' + method + ' ' + routePath);
  let chain = layer.route.stack.map((s) => s.handle);
  if (o.fromHandler) {
    // Skip library middleware in front of a named handler (the token doors'
    // rate limiters). The name is asserted, so a renamed loader fails loudly
    // instead of the drive silently starting somewhere else.
    const at = chain.findIndex((h) => h.name === o.fromHandler);
    if (at < 0) throw new Error('no handler named ' + o.fromHandler + ' on ' + routePath);
    chain = chain.slice(at);
  }
  const res = fakeRes();
  const req = {
    method: method.toUpperCase(),
    params: o.params || {},
    query: o.query || {},
    body: o.body || {},
    cookies: {},
    headers: o.as ? { authorization: 'Bearer ' + tokenFor(o.as) } : {},
    protocol: 'https',
    get: () => 'project86.test',
  };
  for (const h of chain) {
    let advanced = false;
    await h(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  return res;
}

const readTicket = (router, as, id) => drive(router, 'get', '/:id', { as, params: { id } });
const listTickets = (router, as, query) => drive(router, 'get', '/', { as, query });
const patchTicket = (router, as, id, body) => drive(router, 'patch', '/:id', { as, params: { id }, body });
const createTicket = (router, as, body) => drive(router, 'post', '/', { as, body });
const mint = (router, as, id) => drive(router, 'post', '/service-tickets/:id/share', { as, params: { id }, body: { scope: 'view' } });

const row = (id) => eng.all('SELECT * FROM service_tickets WHERE id = ?', id)[0];
const listIds = (res) => (res.body && res.body.tickets ? res.body.tickets.map((t) => t.id).sort() : res.body);

// ── mutant(): remove ONE guard from a copy of the shipped file ─────────────
function absolutizeRequires(src, fromDir) {
  return src.replace(/require\((['"])([^'"]+)\1\)/g, (_m, _q, spec) => {
    const resolved = spec.charAt(0) === '.'
      ? require.resolve(path.resolve(fromDir, spec))
      : require.resolve(spec, { paths: [fromDir] });
    return 'require(' + JSON.stringify(resolved.split(path.sep).join('/')) + ')';
  });
}

function mutant(file, pairs) {
  const SOURCE = fs.readFileSync(file, 'utf8');
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    const r = String(replace).replace(/\r?\n/g, eol);
    const hits = out.split(f).length - 1;
    if (hits === 0) {
      throw new Error('MUTATION ANCHOR NOT FOUND — the guard moved or the line endings differ. Anchor:\n'
        + JSON.stringify(f.slice(0, 200)));
    }
    if (hits > 1) {
      throw new Error('MUTATION ANCHOR IS AMBIGUOUS (' + hits + ' matches) — it would mutate more than '
        + 'the one guard under test. Anchor:\n' + JSON.stringify(f.slice(0, 200)));
    }
    const next = out.split(f).join(r);
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + JSON.stringify(f.slice(0, 80)));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_st_mutant_' + process.pid + '_'
    + Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out, path.dirname(file)), 'utf8');
  mutantPaths.push(p);
  return require(p);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HARNESS ITSELF, FIRST. If mutant() cannot mutate, every mutant below is
 * decoration.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness is not the thing being fooled', () => {
  test('an anchor that is not in the file THROWS instead of passing quietly', () => {
    expect(() => mutant(TICKET_ROUTES, [['this string is nowhere in the routes', 'x']]))
      .toThrow(/MUTATION ANCHOR NOT FOUND/);
  });

  test('an anchor that matches more than one site THROWS', () => {
    expect(() => mutant(TICKET_ROUTES, [["return res.status(404).json({ error: 'Service ticket not found' });", 'x']]))
      .toThrow(/AMBIGUOUS/);
  });

  test('an identical replacement THROWS instead of passing quietly', () => {
    const a = "const TICKET_NOT_FOUND = 'Service ticket not found';";
    expect(() => mutant(TICKET_ROUTES, [[a, a]])).toThrow(/MUTATION CHANGED NO BYTES/);
  });

  test('both route files are CRLF, so the normalisation above is load-bearing', () => {
    // If this ever flips to LF the anchors still work; the assertion is here so
    // the reason for the eol dance stays checkable rather than folklore.
    for (const f of [TICKET_ROUTES, SHARE_ROUTES]) {
      const s = fs.readFileSync(f, 'utf8');
      expect(s.indexOf('\r\n')).toBeGreaterThan(-1);
    }
  });

  test('a loaded mutant is a DIFFERENT router that shares the same database', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "const TICKET_NOT_FOUND = 'Service ticket not found';",
      "const TICKET_NOT_FOUND = 'MUTANT not found';"]]);
    expect(mut).not.toBe(ticketRouter);
    expect((await readTicket(mut, WIDE, 'st_nope')).body).toEqual({ error: 'MUTANT not found' });
    expect((await readTicket(mut, WIDE, 'st_j1')).statusCode).toBe(200);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HOLE 1 — THE NARROW TIER, ON EVERY DOOR
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the detail door: the narrow tier means "jobs I own or was granted"', () => {
  test('a narrow-tier user reads a ticket on a job they hold a VIEW grant on, and one they own', async () => {
    expect((await readTicket(ticketRouter, CREW, 'st_j1')).statusCode).toBe(200);
    expect((await readTicket(ticketRouter, CREW, 'st_j3')).statusCode).toBe(200);
  });

  test('on a job they are not on, the answer is the SAME 404 as a missing or foreign ticket', async () => {
    const notOnIt = await readTicket(ticketRouter, CREW, 'st_j4');
    const absent = await readTicket(ticketRouter, CREW, 'st_nope');
    const foreign = await readTicket(ticketRouter, CREW, 'st_b');
    expect(notOnIt.statusCode).toBe(404);
    // Status AND body: a different sentence would be the same oracle a 403 is.
    expect([notOnIt.statusCode, notOnIt.body]).toEqual([absent.statusCode, absent.body]);
    expect([foreign.statusCode, foreign.body]).toEqual([absent.statusCode, absent.body]);
    expect(JSON.stringify(notOnIt.body)).not.toContain('Gate on j4');
  });

  test('the events timeline answers the same way', async () => {
    const r = await drive(ticketRouter, 'get', '/:id/events', { as: CREW, params: { id: 'st_j4' } });
    expect(r.statusCode).toBe(404);
    expect((await drive(ticketRouter, 'get', '/:id/events', { as: CREW, params: { id: 'st_j1' } })).statusCode).toBe(200);
  });

  test('no relevant capability at all is a 403 naming the capability, as before', async () => {
    const r = await readTicket(ticketRouter, NOBODY, 'st_j1');
    expect(r.statusCode).toBe(403);
    expect(r.body.error).toBe('Missing capability: JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED');
    expect((await readTicket(ticketRouter, LEADER, 'st_j1')).statusCode).toBe(403);
    expect((await readTicket(ticketRouter, CREW, 'st_l1')).statusCode).toBe(403);
  });

  test('a converted lead\'s ticket is governed by its JOB, not its lead', async () => {
    expect((await readTicket(ticketRouter, LEADER, 'st_l1')).statusCode).toBe(200);
    const conv = await readTicket(ticketRouter, LEADER, 'st_conv');
    expect(conv.statusCode).toBe(403);
    expect(conv.body.error).toMatch(/JOBS_VIEW_ALL/);
  });
});

describe('the write doors: a view grant sees, only an edit grant or ownership changes', () => {
  test('a VIEW grant cannot PATCH — and the row is untouched', async () => {
    const r = await patchTicket(ticketRouter, CREW, 'st_j1', { title: 'crew renamed it' });
    expect(r.statusCode).toBe(404);
    expect(r.body).toEqual({ error: 'Service ticket not found' });
    expect(row('st_j1').title).toBe('Gate on j1');
  });

  test('an EDIT grant and ownership both can', async () => {
    expect((await patchTicket(ticketRouter, CREW, 'st_j2', { title: 'edit grant' })).statusCode).toBe(200);
    expect(row('st_j2').title).toBe('edit grant');
    expect((await patchTicket(ticketRouter, CREW, 'st_j3', { title: 'owner' })).statusCode).toBe(200);
    expect(row('st_j3').title).toBe('owner');
  });

  test('status and archive refuse a view grant the same way', async () => {
    const s = await drive(ticketRouter, 'post', '/:id/status', { as: CREW, params: { id: 'st_j1' }, body: { status: 'scheduled' } });
    expect(s.statusCode).toBe(404);
    expect(row('st_j1').status).toBe('open');
    const d = await drive(ticketRouter, 'delete', '/:id', { as: CREW, params: { id: 'st_j1' } });
    expect(d.statusCode).toBe(404);
    expect(row('st_j1').archived_at).toBeNull();
  });

  test('CREATE checks write access on the parent it was given, after the in-org proof', async () => {
    const count = () => eng.count("SELECT 1 FROM service_tickets WHERE title = 'new one'");
    const viewOnly = await createTicket(ticketRouter, CREW, { title: 'new one', job_id: 'j1' });
    const notOn = await createTicket(ticketRouter, CREW, { title: 'new one', job_id: 'j4' });
    const absent = await createTicket(ticketRouter, CREW, { title: 'new one', job_id: 'j_nope' });
    const foreign = await createTicket(ticketRouter, CREW, { title: 'new one', job_id: 'j9' });
    for (const r of [viewOnly, notOn, foreign]) {
      expect([r.statusCode, r.body]).toEqual([absent.statusCode, absent.body]);
    }
    expect(absent.body).toEqual({ error: 'Job not found' });
    expect(count()).toBe(0);

    expect((await createTicket(ticketRouter, CREW, { title: 'new one', job_id: 'j2' })).statusCode).toBe(200);
    expect(count()).toBe(1);
  });

  test('CREATE on a lead needs LEADS_EDIT, and the job wins when both are named', async () => {
    expect((await createTicket(ticketRouter, LEADER, { title: 'lead one', lead_id: 'l1' })).statusCode).toBe(200);
    const crewOnLead = await createTicket(ticketRouter, CREW, { title: 'lead two', lead_id: 'l1' });
    expect(crewOnLead.statusCode).toBe(403);
    expect(crewOnLead.body.error).toBe('Missing capability: LEADS_EDIT');
    const leaderOnJob = await createTicket(ticketRouter, LEADER, { title: 'both', job_id: 'j1', lead_id: 'l1' });
    expect(leaderOnJob.statusCode).toBe(403);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title IN ('lead two','both')")).toBe(0);
  });

  // THE SECOND PARENT IS NOT AN ORACLE ON THE FIRST. The create door used to
  // prove the job, then the lead, and only THEN ask whether the job was the
  // caller's — so {a job you are not on, a bogus lead} answered "Lead not found"
  // while {an absent job, a bogus lead} answered "Job not found", and a crew
  // lead could walk job ids and learn which exist. The job decides; it is
  // settled completely (in-org, then access) before the lead is looked at.
  const twoParents = () => eng.count("SELECT 1 FROM service_tickets WHERE title = 'two parents'");
  const JOB_404 = [404, { error: 'Job not found' }];
  const LEAD_404 = [404, { error: 'Lead not found' }];

  test('CREATE with both parents: a job you are not on answers exactly as an absent job, whatever the lead', async () => {
    const make = (as, job_id, lead_id) => createTicket(ticketRouter, as, { title: 'two parents', job_id, lead_id });
    const absent = await make(CREW, 'j_nope', 'l_nope');
    expect([absent.statusCode, absent.body]).toEqual(JOB_404);
    const cases = [
      [CREW, 'j4', 'l_nope'],   // not on it, bogus lead — THE finding
      [CREW, 'j1', 'l_nope'],   // a view grant only, bogus lead
      [CREW, 'j9', 'l_nope'],   // another tenant's job, bogus lead
      [CREW, 'j4', 'l9'],       // not on it, another tenant's lead
      [CREW, 'j4', 'l1'],       // not on it, a real in-org lead
      [CREW, 'j_nope', 'l1'],   // absent job, a real in-org lead
      [WIDE, 'j9', 'l1'],       // a wide user still cannot name another tenant's job
      [WIDE, 'j_nope', 'l1'],
    ];
    for (const [as, job, lead] of cases) {
      const r = await make(as, job, lead);
      expect([as, job, lead, r.statusCode, r.body]).toEqual([as, job, lead, absent.statusCode, absent.body]);
    }
    expect(twoParents()).toBe(0);
  });

  test('CREATE with both parents: once the job is settled, the lead is still proved in-org', async () => {
    for (const [as, job] of [[CREW, 'j2'], [CREW, 'j3'], [WIDE, 'j1']]) {
      for (const lead of ['l_nope', 'l9']) {
        const r = await createTicket(ticketRouter, as, { title: 'two parents', job_id: job, lead_id: lead });
        expect([as, job, lead, r.statusCode, r.body]).toEqual([as, job, lead].concat(LEAD_404));
      }
    }
    expect(twoParents()).toBe(0);
    const ok = await createTicket(ticketRouter, CREW, { title: 'two parents', job_id: 'j2', lead_id: 'l1' });
    expect(ok.statusCode).toBe(200);
    const stored = row(ok.body.ticket.id);
    expect([stored.job_id, stored.lead_id, stored.organization_id]).toEqual(['j2', 'l1', 1]);
  });

  test('CREATE with ONE parent answers as it always has: in-org proof first, then capability', async () => {
    const one = (as, body) => createTicket(ticketRouter, as, Object.assign({ title: 'one parent' }, body))
      .then((r) => [r.statusCode, r.body]);
    for (const as of [WIDE, LEADER, CREW, NOBODY]) {
      expect([as, await one(as, { lead_id: 'l_nope' })]).toEqual([as, LEAD_404]);
      expect([as, await one(as, { lead_id: 'l9' })]).toEqual([as, LEAD_404]);
      expect([as, await one(as, { job_id: 'j_nope' })]).toEqual([as, JOB_404]);
      expect([as, await one(as, { job_id: 'j9' })]).toEqual([as, JOB_404]);
    }
    expect(await one(NOBODY, { job_id: 'j1' })).toEqual([403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }]);
    expect(await one(NOBODY, { lead_id: 'l1' })).toEqual([403, { error: 'Missing capability: LEADS_EDIT' }]);
    expect(await one(CREW, { job_id: 'j4' })).toEqual(JOB_404);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title = 'one parent'")).toBe(0);
  });
});

describe('the share-routes doors ask the same rule', () => {
  const shares = () => eng.count('SELECT 1 FROM service_ticket_shares');

  test('minting a link: not on the job is 404, a view grant is 404, an edit grant mints', async () => {
    const notOn = await mint(shareRouter, CREW, 'st_j4');
    const absent = await mint(shareRouter, CREW, 'st_nope');
    expect([notOn.statusCode, notOn.body]).toEqual([404, absent.body]);
    expect((await mint(shareRouter, CREW, 'st_j1')).statusCode).toBe(404);
    expect(shares()).toBe(0);
    expect((await mint(shareRouter, CREW, 'st_j2')).statusCode).toBe(200);
    expect(shares()).toBe(1);
    expect((await mint(shareRouter, NOBODY, 'st_j1')).statusCode).toBe(403);
  });

  test('the links list, participants and the revisions inbox are reads: a view grant sees them', async () => {
    for (const p of ['/service-tickets/:id/shares', '/service-tickets/:id/participants', '/service-tickets/:id/revisions']) {
      expect({ p, s: (await drive(shareRouter, 'get', p, { as: CREW, params: { id: 'st_j4' } })).statusCode }).toEqual({ p, s: 404 });
      expect({ p, s: (await drive(shareRouter, 'get', p, { as: CREW, params: { id: 'st_j1' } })).statusCode }).toEqual({ p, s: 200 });
    }
  });

  test('accepting a revision and adding a participant are writes: a view grant cannot', async () => {
    eng.db.exec("INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, fields, status, created_at) " +
      "VALUES ('rev1', 1, 'st_j1', '{\"scope_proposed\":\"bigger\"}', 'pending', '2026-09-03 09:00:00')");
    const acc = await drive(shareRouter, 'post', '/service-tickets/:id/revisions/:rid/accept',
      { as: CREW, params: { id: 'st_j1', rid: 'rev1' }, body: {} });
    expect(acc.statusCode).toBe(404);
    expect(eng.all("SELECT status FROM service_ticket_revisions WHERE id = 'rev1'")[0].status).toBe('pending');
    const add = await drive(shareRouter, 'post', '/service-tickets/:id/participants',
      { as: CREW, params: { id: 'st_j1' }, body: { user_id: OTHER } });
    expect(add.statusCode).toBe(404);
    expect(eng.count('SELECT 1 FROM service_ticket_participants')).toBe(0);
  });
});

// ── THE THREE WRITE DOORS NOTHING PINNED ──────────────────────────────────
// Revoke, reject and participant DELETE each call ticketAccessOk(…, 'write'),
// and until now no test would have noticed that call disappearing or being
// downgraded to 'read'. Each is the ticket's WRITE surface in the office's
// hands: a narrow-tier user who could reach them on a job they only view — or
// are not on at all — could switch off the crew's link, throw away a guest's
// suggestion, or strip a colleague off the work order.
//
// Every ticket gets its OWN share, revision and participant, so a refusal on
// st_j1 that quietly wrote st_j2's rows still shows in the snapshot.
const DOOR_TICKETS = ['st_j1', 'st_j2', 'st_j4'];

function seedDoorRows() {
  const exp = new Date(Date.now() + 86400000).toISOString();
  for (const t of DOOR_TICKETS) {
    eng.db.exec(`
      INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, expires_at, view_count, created_at)
        VALUES ('sh_${t}', 1, '${t}', 'hash_${t}', 'view', '${exp}', 0, '2026-09-03 09:00:00');
      INSERT INTO service_ticket_revisions (id, organization_id, ticket_id, fields, status, created_at)
        VALUES ('rev_${t}', 1, '${t}', '{"scope_proposed":"bigger"}', 'pending', '2026-09-03 09:00:00');
      INSERT INTO service_ticket_participants (id, organization_id, ticket_id, user_id, access_level, created_at)
        VALUES ('p_${t}', 1, '${t}', ${OTHER}, 'view', '2026-09-03 09:00:00');
    `);
  }
}

// Everything any of the three doors could touch, for every ticket at once.
const doorState = () => ({
  shares: eng.all('SELECT id, ticket_id, revoked_at FROM service_ticket_shares ORDER BY id'),
  revisions: eng.all('SELECT id, ticket_id, status, resolved_by, resolved_at, resolution_note FROM service_ticket_revisions ORDER BY id'),
  participants: eng.all('SELECT id, ticket_id, user_id, access_level FROM service_ticket_participants ORDER BY id'),
  events: eng.count('SELECT 1 FROM service_ticket_events'),
});

const WRITE_DOORS = [
  {
    name: 'revoke a link',
    go: (router, as, t) => drive(router, 'post', '/service-tickets/:id/shares/:sid/revoke',
      { as, params: { id: t, sid: 'sh_' + t }, body: {} }),
    landed: (t) => eng.all('SELECT revoked_at FROM service_ticket_shares WHERE id = ?', 'sh_' + t)[0].revoked_at != null,
  },
  {
    name: 'reject a revision',
    go: (router, as, t) => drive(router, 'post', '/service-tickets/:id/revisions/:rid/reject',
      { as, params: { id: t, rid: 'rev_' + t }, body: { note: 'not this one' } }),
    landed: (t) => eng.all('SELECT status FROM service_ticket_revisions WHERE id = ?', 'rev_' + t)[0].status === 'rejected',
  },
  {
    name: 'remove a participant',
    go: (router, as, t) => drive(router, 'delete', '/service-tickets/:id/participants/:userId',
      { as, params: { id: t, userId: String(OTHER) } }),
    landed: (t) => eng.count('SELECT 1 FROM service_ticket_participants WHERE id = ?', 'p_' + t) === 0,
  },
];

const NOT_FOUND = [404, { error: 'Service ticket not found' }];
const NO_WRITE_CAP = [403, { error: 'Missing capability: JOBS_EDIT_ANY JOBS_EDIT_OWN' }];
const answer = (r) => [r.statusCode, r.body];

describe('revoke, reject and participant DELETE ask for WRITE access on the ticket\'s job', () => {
  beforeEach(() => seedDoorRows());

  for (const door of WRITE_DOORS) {
    test(door.name + ': a view grant, a job never granted, and no capability are refused — and no row moves', async () => {
      const before = doorState();
      const absent = await door.go(shareRouter, CREW, 'st_nope');
      expect(answer(absent)).toEqual(NOT_FOUND);

      // A view grant SEES the job (the read doors above answer 200) but may not
      // change what hangs off it. Same 404 as a ticket that does not exist.
      expect(answer(await door.go(shareRouter, CREW, 'st_j1'))).toEqual(answer(absent));
      expect(doorState()).toEqual(before);

      // Not on the job at all: indistinguishable from absent.
      expect(answer(await door.go(shareRouter, CREW, 'st_j4'))).toEqual(answer(absent));
      expect(doorState()).toEqual(before);

      // No job capability: the 403 that names what is missing.
      expect(answer(await door.go(shareRouter, NOBODY, 'st_j1'))).toEqual(NO_WRITE_CAP);
      expect(doorState()).toEqual(before);

      for (const t of DOOR_TICKETS) expect({ t, landed: door.landed(t) }).toEqual({ t, landed: false });
    });

    test(door.name + ': an EDIT grant goes through, on that ticket only — so the refusals above are about access', async () => {
      const before = doorState();
      const r = await door.go(shareRouter, CREW, 'st_j2');
      expect(r.statusCode).toBe(200);
      expect(door.landed('st_j2')).toBe(true);
      expect(door.landed('st_j1')).toBe(false);
      expect(door.landed('st_j4')).toBe(false);
      expect(doorState()).not.toEqual(before);
    });
  }
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HOLE 2 — THE LIST
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the list shows what the same rule allows, in SQL', () => {
  test('wide: every ticket in the org, job- and lead-parented, never another org\'s', async () => {
    const r = await listTickets(ticketRouter, WIDE);
    expect(r.statusCode).toBe(200);
    expect(listIds(r)).toEqual(ORG1_TICKETS);
    expect(JSON.stringify(r.body)).not.toContain('RIVAL');
  });

  test('assigned: only tickets on jobs the caller owns or holds ANY grant on', async () => {
    expect(listIds(await listTickets(ticketRouter, CREW))).toEqual(['st_j1', 'st_j2', 'st_j3']);
  });

  test('lead-only: lead-only tickets, and NOT a converted ticket that carries a job', async () => {
    expect(listIds(await listTickets(ticketRouter, LEADER))).toEqual(['st_l1']);
  });

  test('no capability: an empty list with a 200 — and service_tickets is never queried', async () => {
    const before = eng.log.length;
    const r = await listTickets(ticketRouter, NOBODY);
    expect([r.statusCode, r.body]).toEqual([200, { tickets: [] }]);
    const ran = eng.log.slice(before).filter((e) => /service_tickets/i.test(e.sql));
    expect(ran).toEqual([]);
  });

  test('the caller\'s filters still compose with the visibility gate', async () => {
    expect(listIds(await listTickets(ticketRouter, CREW, { job_id: 'j4' }))).toEqual([]);
    expect(listIds(await listTickets(ticketRouter, CREW, { job_id: 'j2' }))).toEqual(['st_j2']);
    expect(listIds(await listTickets(ticketRouter, WIDE, { lead_id: 'l1' }))).toEqual(['st_conv', 'st_l1']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HOLE 3 — PRIVATE TO-DOS UNDER A TICKET
 * ══════════════════════════════════════════════════════════════════════════*/
describe('another user\'s personal to-do is absent from the detail, the progress and the list counts', () => {
  test('the detail lists org tasks plus the caller\'s OWN to-dos, and progress counts those rows', async () => {
    const wide = await readTicket(ticketRouter, WIDE, 'st_j1');
    expect(wide.body.tasks.map((t) => t.id)).toEqual(['k_org']);
    expect([wide.body.progress.tasksTotal, wide.body.progress.tasksDone]).toEqual([1, 1]);
    expect(JSON.stringify(wide.body)).not.toMatch(/PRIVATE/);

    const crew = await readTicket(ticketRouter, CREW, 'st_j1');
    expect(crew.body.tasks.map((t) => t.id).sort()).toEqual(['k_crew', 'k_org']);
    expect([crew.body.progress.tasksTotal, crew.body.progress.tasksDone]).toEqual([2, 1]);
    expect(JSON.stringify(crew.body)).not.toContain('OTHER-PRIVATE');
  });

  test('the list\'s progress counts use the same boundary', async () => {
    const pick = (r) => { const t = r.body.tickets.find((x) => x.id === 'st_j1'); return [t.task_total, t.task_done]; };
    expect(pick(await listTickets(ticketRouter, WIDE))).toEqual([1, 1]);
    expect(pick(await listTickets(ticketRouter, CREW))).toEqual([2, 1]);
  });

  test('a share-link guest sees org tasks only — a token has no owner to match', async () => {
    const svc = require('../server/services/service-tickets');
    const token = svc.genToken();
    eng.db.exec("INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, expires_at, view_count, created_at) VALUES " +
      "('sh1', 1, 'st_j1', '" + svc.hashToken(token) + "', 'view', '" + new Date(Date.now() + 86400000).toISOString() + "', 0, '2026-09-03 09:00:00')");
    const r = await drive(shareRouter, 'get', '/service-ticket-share/:token',
      { params: { token }, fromHandler: 'loadTicketShare' });
    expect(r.statusCode).toBe(200);
    expect(r.body.tasks.map((t) => t.title)).toEqual(['Order the latch']);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * HOLE 4 — THE ASSIGNEE
 * ══════════════════════════════════════════════════════════════════════════*/
describe('assignee_user_id is proved to be a user in this organization', () => {
  const REFUSAL = { error: 'Assignee is not a user in this organization' };

  test('CREATE: a foreign user is 400 and nothing is inserted; an absent id gets the same answer', async () => {
    const foreign = await createTicket(ticketRouter, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: RIVAL });
    const absent = await createTicket(ticketRouter, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: 9999 });
    const junk = await createTicket(ticketRouter, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: 'abc' });
    for (const r of [foreign, absent, junk]) expect([r.statusCode, r.body]).toEqual([400, REFUSAL]);
    expect(eng.count("SELECT 1 FROM service_tickets WHERE title = 'assigned'")).toBe(0);
  });

  test('CREATE: an in-org user is stored as a number, and an empty string stores NULL', async () => {
    const ok = await createTicket(ticketRouter, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: String(OTHER) });
    expect(ok.statusCode).toBe(200);
    expect(row(ok.body.ticket.id).assignee_user_id).toBe(OTHER);
    const cleared = await createTicket(ticketRouter, WIDE, { title: 'unassigned', job_id: 'j1', assignee_user_id: '' });
    expect(cleared.statusCode).toBe(200);
    expect(row(cleared.body.ticket.id).assignee_user_id).toBeNull();
  });

  test('PATCH: a foreign user is 400, and the OTHER fields in that body are not written either', async () => {
    const r = await patchTicket(ticketRouter, WIDE, 'st_j2', { title: 'half applied?', assignee_user_id: RIVAL });
    expect([r.statusCode, r.body]).toEqual([400, REFUSAL]);
    expect(row('st_j2').title).toBe('Gate on j2');
    expect(row('st_j2').assignee_user_id).toBeNull();
  });

  test('PATCH: an in-org user lands, and null / empty clears as it always has', async () => {
    expect((await patchTicket(ticketRouter, WIDE, 'st_j2', { assignee_user_id: OTHER })).statusCode).toBe(200);
    expect(row('st_j2').assignee_user_id).toBe(OTHER);
    expect((await patchTicket(ticketRouter, WIDE, 'st_j2', { assignee_user_id: '' })).statusCode).toBe(200);
    expect(row('st_j2').assignee_user_id).toBeNull();
    await patchTicket(ticketRouter, WIDE, 'st_j2', { assignee_user_id: OTHER });
    expect((await patchTicket(ticketRouter, WIDE, 'st_j2', { assignee_user_id: null })).statusCode).toBe(200);
    expect(row('st_j2').assignee_user_id).toBeNull();
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * EVERY GUARD, REMOVED — the identical drive, and the defect it restores
 * ══════════════════════════════════════════════════════════════════════════*/
const ACCESS_PASS = '  if (verdict && verdict.ok === true) return true;';
const ACCESS_PASS_WIDENED = "  if (verdict && (verdict.ok === true || verdict.reason === 'not_assigned')) return true;";

describe('mutants: the narrow tier', () => {
  test('let not_assigned through (the OLD rule) and a crew lead reads and edits a job they are not on', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      ACCESS_PASS + "\n  const reason = verdict && verdict.reason;\n  if (reason === 'not_assigned') {\n"
        + '    res.status(404).json({ error: notFoundBody || TICKET_NOT_FOUND });',
      ACCESS_PASS_WIDENED + "\n  const reason = verdict && verdict.reason;\n  if (reason === 'not_assigned') {\n"
        + '    res.status(404).json({ error: notFoundBody || TICKET_NOT_FOUND });']]);
    expect((await readTicket(mut, CREW, 'st_j4')).statusCode).toBe(200);
    expect((await patchTicket(mut, CREW, 'st_j1', { title: 'crew renamed it' })).statusCode).toBe(200);
    expect(row('st_j1').title).toBe('crew renamed it');
    expect((await createTicket(mut, CREW, { title: 'sneaky', job_id: 'j4' })).statusCode).toBe(200);
  });

  test('answer not_assigned with a 403 and it becomes an existence oracle', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '    res.status(404).json({ error: notFoundBody || TICKET_NOT_FOUND });',
      "    res.status(403).json({ error: 'You are not on this job' });"]]);
    const notOn = await readTicket(mut, CREW, 'st_j4');
    const absent = await readTicket(mut, CREW, 'st_nope');
    expect(notOn.statusCode).toBe(403);
    expect([notOn.statusCode, notOn.body]).not.toEqual([absent.statusCode, absent.body]);
  });

  test('ask PATCH for READ access and a view grant edits the ticket', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });\n\n"
        + "    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;",
      "    if (!ticket) return res.status(404).json({ error: TICKET_NOT_FOUND });\n\n"
        + "    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;"]]);
    expect((await patchTicket(mut, CREW, 'st_j1', { title: 'view grant wrote this' })).statusCode).toBe(200);
    expect(row('st_j1').title).toBe('view grant wrote this');
  });

  test('share routes: let not_assigned through and a crew lead mints a link on a job they are not on', async () => {
    const mut = mutant(SHARE_ROUTES, [[ACCESS_PASS, ACCESS_PASS_WIDENED]]);
    expect((await mint(mut, CREW, 'st_j4')).statusCode).toBe(200);
    expect(eng.count("SELECT 1 FROM service_ticket_shares WHERE ticket_id = 'st_j4'")).toBe(1);
  });

  test('share routes: ask the mint for READ access and a view grant mints a link', async () => {
    const mut = mutant(SHARE_ROUTES, [[
      "    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;\n\n"
        + '    // A link is a promise; a draft is not one.',
      "    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;\n\n"
        + '    // A link is a promise; a draft is not one.']]);
    expect((await mint(mut, CREW, 'st_j1')).statusCode).toBe(200);
    expect(eng.count("SELECT 1 FROM service_ticket_shares WHERE ticket_id = 'st_j1'")).toBe(1);
  });
});

describe('mutants: the create door settles the deciding parent first', () => {
  const CREATE_ACCESS = "    if (!(await ticketAccessOk(req, res, parent, 'write', orgId, parentMissing))) return;";
  const DECIDING_PROOF = "    if (!(await assertEntityInOrg(jobId ? 'job' : 'lead', jobId || leadId, orgId))) {";
  const SECONDARY_PROOF = "    if (jobId && leadId && !(await assertEntityInOrg('lead', leadId, orgId))) {";

  test('prove the lead BEFORE the access answer (the old order) and job existence leaks through the lead', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      CREATE_ACCESS,
      "    if (leadId && !(await assertEntityInOrg('lead', leadId, orgId))) {\n"
        + "      return res.status(404).json({ error: 'Lead not found' });\n"
        + '    }\n'
        + CREATE_ACCESS]]);
    const notOn = await createTicket(mut, CREW, { title: 'two parents', job_id: 'j4', lead_id: 'l_nope' });
    const absent = await createTicket(mut, CREW, { title: 'two parents', job_id: 'j_nope', lead_id: 'l_nope' });
    expect([notOn.statusCode, notOn.body]).toEqual([404, { error: 'Lead not found' }]);
    expect([absent.statusCode, absent.body]).toEqual([404, { error: 'Job not found' }]);
    expect([notOn.statusCode, notOn.body]).not.toEqual([absent.statusCode, absent.body]);
  });

  test('prove the LEAD as the deciding parent and a wide user raises a ticket on another tenant\'s job', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      DECIDING_PROOF,
      "    if (!(await assertEntityInOrg(leadId ? 'lead' : 'job', leadId || jobId, orgId))) {"]]);
    const r = await createTicket(mut, WIDE, { title: 'two parents', job_id: 'j9', lead_id: 'l1' });
    expect(r.statusCode).toBe(200);
    expect([row(r.body.ticket.id).job_id, row(r.body.ticket.id).organization_id]).toEqual(['j9', 1]);
  });

  test('drop the secondary lead proof and another tenant\'s lead is written onto the ticket', async () => {
    const mut = mutant(TICKET_ROUTES, [[SECONDARY_PROOF, '    if (false) {']]);
    const r = await createTicket(mut, WIDE, { title: 'two parents', job_id: 'j1', lead_id: 'l9' });
    expect(r.statusCode).toBe(200);
    expect(row(r.body.ticket.id).lead_id).toBe('l9');
  });
});

describe('mutants: revoke, reject and participant DELETE', () => {
  beforeEach(() => seedDoorRows());

  // The access call is byte-identical on every write door in the file, so each
  // anchor carries the statement that FOLLOWS it — without that tail the
  // harness would (rightly) refuse the anchor as ambiguous.
  const CHECK_WRITE = "    if (!(await ticketAccessOk(req, res, ticket, 'write', orgId))) return;\n";
  const CHECK_READ = "    if (!(await ticketAccessOk(req, res, ticket, 'read', orgId))) return;\n";
  const TAIL = {
    'revoke a link': '\n    // The org predicate is in the WHERE, never in an `if` above it.',
    'reject a revision': "\n    const { rows } = await pool.query(\n      `UPDATE service_ticket_revisions\n          SET status = 'rejected'",
    'remove a participant': '    const { rows } = await pool.query(\n      `DELETE FROM service_ticket_participants',
  };

  for (const door of WRITE_DOORS) {
    test(door.name + ': remove the access check and all three refused callers write', async () => {
      const mut = mutant(SHARE_ROUTES, [[CHECK_WRITE + TAIL[door.name], '    // MUTANT: no access check\n' + TAIL[door.name]]]);
      // A distinct ticket per caller: revoke and reject are single-shot, so a
      // second call on one ticket would 404 for a reason that is not access.
      expect((await door.go(mut, CREW, 'st_j1')).statusCode).toBe(200);
      expect(door.landed('st_j1')).toBe(true);
      expect((await door.go(mut, CREW, 'st_j4')).statusCode).toBe(200);
      expect(door.landed('st_j4')).toBe(true);
      expect((await door.go(mut, NOBODY, 'st_j2')).statusCode).toBe(200);
      expect(door.landed('st_j2')).toBe(true);
    });

    test(door.name + ': ask for READ access and a view grant writes — while the other two refusals hold', async () => {
      const mut = mutant(SHARE_ROUTES, [[CHECK_WRITE + TAIL[door.name], CHECK_READ + TAIL[door.name]]]);
      expect((await door.go(mut, CREW, 'st_j1')).statusCode).toBe(200);
      expect(door.landed('st_j1')).toBe(true);
      // The downgrade widens exactly the view-grant arm and nothing else.
      expect(answer(await door.go(mut, CREW, 'st_j4'))).toEqual(NOT_FOUND);
      expect(door.landed('st_j4')).toBe(false);
      expect(answer(await door.go(mut, NOBODY, 'st_j2'))).toEqual([403, { error: 'Missing capability: JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED' }]);
      expect(door.landed('st_j2')).toBe(false);
    });
  }
});

describe('mutants: the list', () => {
  test('drop the visibility gate and a no-capability user lists every ticket in the org', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "    if (!visible.length) return res.json({ tickets: [] });\n    where.push('(' + visible.join(' OR ') + ')');",
      '    // MUTANT: no visibility gate']]);
    expect(listIds(await listTickets(mut, NOBODY))).toEqual(ORG1_TICKETS);
    expect(listIds(await listTickets(mut, CREW))).toEqual(ORG1_TICKETS);
  });

  test('match the grant on ANY user and a crew lead lists tickets on a job granted to someone else', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      'OR EXISTS (SELECT 1 FROM job_access a WHERE a.job_id = t.job_id AND a.user_id = ${me})',
      'OR EXISTS (SELECT 1 FROM job_access a WHERE a.job_id = t.job_id AND a.user_id IS NOT NULL)']]);
    expect(listIds(await listTickets(mut, CREW))).toEqual(['st_conv', 'st_j1', 'st_j2', 'st_j3', 'st_j4']);
  });

  test('drop the owner arm and a crew lead loses the tickets on their OWN job', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      'EXISTS (SELECT 1 FROM jobs j WHERE j.id = t.job_id AND j.owner_id = ${me})\n            OR ',
      '']]);
    expect(listIds(await listTickets(mut, CREW))).toEqual(['st_j1', 'st_j2']);
  });

  test('read "lead-only" as "has a lead" and a converted job\'s ticket reaches a lead-only role', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      "'(t.job_id IS NULL AND t.lead_id IS NOT NULL)'",
      "'t.lead_id IS NOT NULL'"]]);
    expect(listIds(await listTickets(mut, LEADER))).toEqual(['st_conv', 'st_l1']);
  });
});

describe('mutants: private to-dos', () => {
  test('drop the detail predicate and another user\'s to-do is listed AND counted', async () => {
    // The replacement still references $3, so the statement binds the same
    // three parameters — the ONLY change is that the predicate stops filtering.
    const mut = mutant(TICKET_ROUTES, [[
      "\n            AND (scope = 'org' OR (scope = 'personal' AND owner_user_id = $3))",
      '\n            AND ($3 IS NULL OR $3 IS NOT NULL)']]);
    const r = await readTicket(mut, WIDE, 'st_j1');
    expect(r.body.tasks.map((t) => t.id).sort()).toEqual(['k_crew', 'k_org', 'k_other']);
    expect([r.body.progress.tasksTotal, r.body.progress.tasksDone]).toEqual([3, 2]);
    expect(JSON.stringify(r.body)).toContain('OTHER-PRIVATE');
  });

  test('drop the list count predicate and the progress bar counts private to-dos', async () => {
    const mut = mutant(TICKET_ROUTES, [
      ["AND k.archived_at IS NULL\n                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_total,",
        'AND k.archived_at IS NULL\n                  AND (${caller} IS NULL OR ${caller} IS NOT NULL)) AS task_total,'],
      ["AND k.status = 'done'\n                  AND (k.scope = 'org' OR (k.scope = 'personal' AND k.owner_user_id = ${caller}))) AS task_done",
        "AND k.status = 'done'\n                  AND (${caller} IS NULL OR ${caller} IS NOT NULL)) AS task_done"],
    ]);
    const t = (await listTickets(mut, WIDE)).body.tickets.find((x) => x.id === 'st_j1');
    expect([t.task_total, t.task_done]).toEqual([3, 2]);
  });

  test('drop the guest predicate and a share link carries a PM\'s private to-do titles', async () => {
    const svc = require('../server/services/service-tickets');
    const mut = mutant(SHARE_ROUTES, [["\n            AND scope = 'org'\n          ORDER BY created_at ASC", '\n          ORDER BY created_at ASC']]);
    const token = svc.genToken();
    eng.db.exec("INSERT INTO service_ticket_shares (id, organization_id, ticket_id, token_hash, scope, expires_at, view_count, created_at) VALUES " +
      "('sh1', 1, 'st_j1', '" + svc.hashToken(token) + "', 'view', '" + new Date(Date.now() + 86400000).toISOString() + "', 0, '2026-09-03 09:00:00')");
    const r = await drive(mut, 'get', '/service-ticket-share/:token', { params: { token }, fromHandler: 'loadTicketShare' });
    expect(r.body.tasks.map((x) => x.title)).toEqual(expect.arrayContaining(['OTHER-PRIVATE dentist', 'CREW-PRIVATE call supplier']));
  });
});

describe('mutants: the assignee', () => {
  test('skip the proof on CREATE and another tenant\'s user is written onto the ticket', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '        const proved = await proveAssignee(body[k], orgId);',
      '        const proved = { ok: true, value: body[k] };']]);
    const r = await createTicket(mut, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: RIVAL });
    expect(r.statusCode).toBe(200);
    expect(row(r.body.ticket.id).assignee_user_id).toBe(RIVAL);
  });

  test('skip the proof on PATCH and the same cross-tenant write lands', async () => {
    const mut = mutant(TICKET_ROUTES, [[
      '        const proved = await proveAssignee(v, orgId);',
      '        const proved = { ok: true, value: v };']]);
    expect((await patchTicket(mut, WIDE, 'st_j2', { assignee_user_id: RIVAL })).statusCode).toBe(200);
    expect(row('st_j2').assignee_user_id).toBe(RIVAL);
  });

  test('drop the org predicate from the proof and a foreign user passes while an absent one still fails', async () => {
    // The point of this mutant: existence is NOT tenancy. A check that only
    // proves the user exists is exactly what the foreign key already did.
    const mut = mutant(TICKET_ROUTES, [[
      "    'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2',",
      "    'SELECT 1 FROM users WHERE id = $1 AND $2 IS NOT NULL',"]]);
    expect((await createTicket(mut, WIDE, { title: 'assigned', job_id: 'j1', assignee_user_id: RIVAL })).statusCode).toBe(200);
    expect((await createTicket(mut, WIDE, { title: 'ghost', job_id: 'j1', assignee_user_id: 9999 })).statusCode).toBe(400);
  });
});

describe('the office doors announce an arrival at Awaiting approval', () => {
  // The notice itself is pinned in service-ticket-notify.test.js. What is
  // pinned HERE is that the office doors call it — on work_complete and on
  // nothing else — with the ticket and the person who made the move.
  const notify = require('../server/services/service-ticket-notify');
  let calls;
  let real;
  beforeEach(() => {
    calls = [];
    real = notify.notifyAwaitingApproval;
    notify.notifyAwaitingApproval = async (db, opts) => { calls.push(opts); return { sent: 0 }; };
  });
  afterEach(() => { notify.notifyAwaitingApproval = real; });

  test('POST /:id/status: in_progress is silent, work_complete announces it once', async () => {
    const step = (status) => drive(ticketRouter, 'post', '/:id/status', { as: WIDE, params: { id: 'st_j2' }, body: { status } });
    expect((await step('in_progress')).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    expect((await step('work_complete')).statusCode).toBe(200);
    expect(calls).toHaveLength(1);
    expect([calls[0].ticket.id, calls[0].reason, calls[0].actor.userId]).toEqual(['st_j2', 'office_moved', 10]);
  });

  test('the last subtask done announces it; a subtask that leaves work outstanding does not', async () => {
    eng.db.exec(`
      UPDATE service_tickets SET status = 'in_progress' WHERE id = 'st_j1';
      UPDATE tasks SET status = 'open' WHERE id = 'k_org';
      INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id, created_at) VALUES
        ('k_two', 1, 'Bldg 2', 'open', 'org', 'st_j1', 'job', 'j1', '2026-09-02 08:00:04');
      INSERT INTO attachments (id, entity_type, entity_id, filename, mime_type, tags, organization_id, position) VALUES
        ('ph1', 'task', 'k_org', 'a.jpg', 'image/jpeg', '["completion"]', 1, 0),
        ('ph2', 'task', 'k_two', 'b.jpg', 'image/jpeg', '["completion"]', 1, 0);
    `);
    const done = (taskId) => drive(ticketRouter, 'post', '/:id/subtasks/:taskId/done',
      { as: WIDE, params: { id: 'st_j1', taskId }, body: { done: true } });
    expect((await done('k_org')).statusCode).toBe(200);
    expect(calls).toHaveLength(0);
    const last = await done('k_two');
    expect([last.statusCode, last.body.ticket_status]).toEqual([200, 'work_complete']);
    expect(calls).toHaveLength(1);
    expect([calls[0].ticket.id, calls[0].reason]).toEqual(['st_j1', 'all_subtasks_done']);
  });
});

describe('the office sending a ticket back clears the approval notice window', () => {
  test('Work complete -> In progress clears approval_notified_at, so the next arrival is announced', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'work_complete', approval_notified_at = datetime('now') WHERE id = 'st_j2'");
    const r = await drive(ticketRouter, 'post', '/:id/status', { as: WIDE, params: { id: 'st_j2' }, body: { status: 'in_progress' } });
    expect(r.statusCode).toBe(200);
    expect([row('st_j2').status, row('st_j2').approval_notified_at]).toEqual(['in_progress', null]);
  });

  test('moving on to Approved keeps it — approval is not a send-back', async () => {
    eng.db.exec("UPDATE service_tickets SET status = 'work_complete', approval_notified_at = datetime('now') WHERE id = 'st_j2'");
    const r = await drive(ticketRouter, 'post', '/:id/status', { as: WIDE, params: { id: 'st_j2' }, body: { status: 'approved' } });
    expect(r.statusCode).toBe(200);
    expect(row('st_j2').approval_notified_at).not.toBeNull();
  });
});
