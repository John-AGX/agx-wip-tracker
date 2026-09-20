// SERVICE TICKETS AS A PAYLOAD ENTITY — THE WRITE SIDE, EXECUTED.
//
// ── WHAT IS UNDER TEST ───────────────────────────────────────────────────
// 86 never holds emit_payload_file. It asks the Scribe (scribe_write), the
// Scribe emits a payload, a human previews and approves it, and applyPayload
// hands each target to its dispatcher inside one transaction. This file drives
// that last leg — validateTarget, applyPayload (dry run AND real), and
// dispatchServiceTicket — against a real SQL engine built from the schema
// server/db.js writes, with role capabilities loaded into the real auth cache.
//
// Nothing here reads the dispatcher's source for a substring to decide a pass.
// Every guard is shown to FIRE by driving it, and then shown to be
// LOAD-BEARING by removing it from a copy of the shipped module and driving
// the same payload into the exact wrong outcome the guard exists to prevent.
//
// ── THE CRLF TRAP ────────────────────────────────────────────────────────
// The repo checks out CRLF. A mutation anchored on '\n' against CRLF bytes
// changes nothing, the "mutant" is the shipped code, and the mutation test
// passes having proved nothing. mutate() normalises every anchor to the file's
// own line ending and THROWS when an anchor is missing or the bytes did not
// move. The first describe block proves the harness itself does both.
//
// ── WHY TWO ENGINES FOR TWO OF THE TESTS ─────────────────────────────────
// With one sqlite handle behind both pool.query and pool.connect, anything
// written or read on the MODULE POOL is inside the payload's transaction, so a
// dispatcher that wrongly uses the pool behaves exactly like one that uses the
// transaction client. Two properties below are about that difference (a $new
// parent is invisible to the pool; a pool-side event survives a dry run's
// ROLLBACK), so those tests point pool.query at a second, identically seeded
// engine that the transaction cannot reach.
'use strict';

// Every mutant re-requires the whole dispatcher; under a full parallel run the
// default 5s hook budget timed out in afterEach (seen on the rebased tree).
jest.setTimeout(120000);

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const { isRenderableChangeset } = require('../server/services/changeset-guard');

const SERVER = path.join(__dirname, '..', 'server');
const SERVICES = path.join(SERVER, 'services');
const REAL = path.join(SERVICES, 'payload-dispatcher.js');
const SOURCE = fs.readFileSync(REAL, 'utf8');

const TABLES = ['service_tickets', 'service_ticket_events', 'tasks', 'jobs', 'leads',
  'users', 'organizations', 'roles', 'job_access'];

// Real capability names, real role cache. Each role is the smallest set that
// makes the case it is used for.
const ROLES = {
  pm_any: ['JOBS_EDIT_ANY', 'JOBS_VIEW_ALL', 'LEADS_EDIT', 'LEADS_VIEW'],
  crew_own: ['JOBS_EDIT_OWN', 'JOBS_VIEW_ASSIGNED'],
  leads_only: ['LEADS_EDIT', 'LEADS_VIEW'],
  viewer: ['JOBS_VIEW_ALL', 'LEADS_VIEW'],
};

let eng;
let engB;
let auth;

function seedInto(e) {
  e.db.exec(seedSql());
}
// The seed as SQL text, so a child process (see the DATE describe) seeds its
// own engine with exactly these rows.
function seedSql() {
  const roleRows = Object.entries(ROLES)
    .map(([name, caps]) => `('${name}', '${JSON.stringify(caps)}')`).join(',');
  return (`
    DELETE FROM service_tickets; DELETE FROM service_ticket_events; DELETE FROM tasks;
    DELETE FROM jobs; DELETE FROM leads; DELETE FROM users; DELETE FROM organizations;
    DELETE FROM roles; DELETE FROM job_access;
    INSERT INTO roles (name, capabilities) VALUES ${roleRows};
    INSERT INTO organizations (id, name) VALUES (1, 'AGX'), (2, 'Rival Co');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10, 'John', 'john@agx.test', 'pm_any', 1),
      (11, 'Cody', 'cody@agx.test', 'crew_own', 1),
      (12, 'Lena', 'lena@agx.test', 'leads_only', 1),
      (13, 'Vera', 'vera@agx.test', 'viewer', 1),
      (20, 'Rex',  'rex@rival.test', 'pm_any', 2);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{"jobNumber":"RV2000","title":"Maple Court"}', 1),
      ('j2', 11, '{"jobNumber":"RV2001","title":"Cody Own"}', 1),
      ('j3', 10, '{"jobNumber":"RV2002","title":"Granted"}', 1),
      ('j9', 20, '{"jobNumber":"RV9000","title":"Rival Job"}', 2);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES ('j3', 11, 'view');
    INSERT INTO leads (id, title, organization_id, status) VALUES
      ('l1', 'Maple roof lead', 1, 'new'),
      ('l9', 'Rival lead', 2, 'new');
    INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority, scope_proposed)
      VALUES
      ('st_open',    1, 'Leak at unit 4',   'j1', NULL, 'open',   'normal', 'Old scope text'),
      ('st_closed',  1, 'Finished gutters', 'j1', NULL, 'closed', 'normal', NULL),
      ('st_lead',    1, 'Survey the roof',  NULL, 'l1', 'draft',  'normal', NULL),
      ('st_foreign', 2, 'Rival ticket',     'j9', NULL, 'open',   'normal', 'their words');
  `);
}

const hashtext = (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; };

beforeAll(async () => {
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['detail', 'capabilities'] });
  engB = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['detail', 'capabilities'] });
  for (const e of [eng, engB]) {
    e.db.function('hashtext', hashtext);
    e.db.function('pg_advisory_xact_lock', (_k) => 1);
  }
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  auth = require('../server/auth');
  auth.setRolePool(eng.pool);
  seedInto(eng);
  seedInto(engB);
  await auth.refreshRoleCache();
});

const flush = () => new Promise((r) => setTimeout(r, 25));
afterAll(async () => {
  await flush();
  require('../server/db').pool.query = async () => ({ rows: [], rowCount: 0 });
  if (eng) eng.close();
  if (engB) engB.close();
});
beforeEach(() => { seedInto(eng); seedInto(engB); });

// ── mutate(): remove ONE guard from a copy, load it, hand it back ─────────
// The copy lives in the OS temp dir with its relative requires made absolute,
// so it shares the real modules' singletons (db pool, auth role cache) and
// nothing transient is ever written inside a directory other suites census.
const abs = (p) => p.split(path.sep).join('/');
function absolutizeRequires(src) {
  return src
    .replace(/require\('\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVICES)}/${p}')`)
    .replace(/require\('\.\.\/([^']+)'\)/g, (_m, p) => `require('${abs(SERVER)}/${p}')`);
}
let mutantPaths = [];
// writeMutant hands back the PATH (a child process loads it there); mutatePairs
// loads it in this worker.
function mutatePairs(pairs) {
  return require(writeMutant(pairs));
}
function writeMutant(pairs) {
  const eol = SOURCE.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
  let out = SOURCE;
  for (const [find, replace] of pairs) {
    const f = String(find).replace(/\r?\n/g, eol);
    if (out.indexOf(f) === -1) {
      throw new Error('MUTATION ANCHOR NOT FOUND. Anchor:\n' + JSON.stringify(f.slice(0, 240)));
    }
    // AN ANCHOR THAT MATCHES TWICE REMOVES TWO GUARDS. The mutant then proves
    // "one of these is load-bearing" while the test's name claims a specific
    // one — and the guard it names can be deleted alone with the suite green.
    // So every anchor must name exactly one site.
    if (out.indexOf(f, out.indexOf(f) + 1) !== -1) {
      throw new Error('MUTATION ANCHOR AMBIGUOUS (matches more than once). Anchor:\n' + JSON.stringify(f.slice(0, 240)));
    }
    const next = out.split(f).join(String(replace).replace(/\r?\n/g, eol));
    if (next === out) throw new Error('MUTATION CHANGED NO BYTES: ' + f.slice(0, 80));
    out = next;
  }
  const p = path.join(os.tmpdir(), '_p86_stmutant_' + process.pid + '_' +
    Math.random().toString(36).slice(2, 10) + '.js');
  fs.writeFileSync(p, absolutizeRequires(out), 'utf8');
  mutantPaths.push(p);
  return p;
}
const mutate = (find, replace) => mutatePairs([[find, replace]]);

afterEach(async () => {
  await flush();
  const db = require('../server/db');
  db.pool.query = eng.pool.query;
  db.pool.connect = eng.pool.connect;
  for (const p of mutantPaths) {
    try { delete require.cache[require.resolve(p)]; } catch (e) { /* not loaded */ }
    try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
  }
  mutantPaths = [];
});

const REAL_MOD = () => require('../server/services/payload-dispatcher');
const JOHN = { userId: 10, organizationId: 1 };
const CODY = { userId: 11, organizationId: 1 };
const LENA = { userId: 12, organizationId: 1 };
const clone = (x) => JSON.parse(JSON.stringify(x));

// Emit-time validation exactly as execEmitPayloadFile runs it, then the apply
// transaction exactly as both approval doors run it.
async function drive(mod, targets, ctx, opts) {
  const ts = clone(targets);
  for (let i = 0; i < ts.length; i++) {
    try { mod.validateTarget(clone(ts[i]), i); }
    catch (e) { return { stage: 'emit', message: e.message, detail: e.detail || {}, err: e }; }
  }
  try {
    const res = await mod.applyPayload({ id: 'pl_test', targets: ts },
      { userId: ctx.userId, organizationId: ctx.organizationId, dryRun: !!(opts && opts.dryRun) });
    return { stage: 'applied', res };
  } catch (e) {
    return { stage: 'apply', message: e.message, detail: e.detail || {}, err: e };
  }
}

const ticket = (fields, extra) => Object.assign(
  { entity_type: 'service_ticket', ops: { op: 'create', fields } }, extra || {});
const update = (id, ops) => ({ entity_type: 'service_ticket', entity_id: id, ops: Object.assign({ op: 'update' }, ops) });
const tickets = () => eng.all('SELECT * FROM service_tickets ORDER BY id');
const newTickets = () => eng.all("SELECT * FROM service_tickets WHERE id NOT IN ('st_open','st_closed','st_lead','st_foreign')");
const one = (sql, ...a) => eng.all(sql, ...a)[0];
// What a caller can observe of a refusal and branch on — EVERYTHING the apply
// route returns to the client, detail.received and detail.expected included.
// `received` may echo the caller's own input back, and that echo is the one
// thing allowed to differ between two answers that must otherwise be the same
// answer. So it is normalized ONLY when it is exactly the raw id this call sent
// (`sent`): a received that is anything else — the canonical job a number
// resolved to, a hidden ticket's parent — is left as it is, and tells the two
// answers apart the way it would tell the caller.
const SENT = '<the id this call sent>';
const answer = (r, sent) => {
  const d = r.detail || {};
  if (sent === undefined) throw new Error('answer(r, sent): name the raw id this call sent');
  return { stage: r.stage, message: r.message, code: d.code, field_path: d.field_path, retryable: d.retryable,
    expected: d.expected, received: d.received === String(sent) ? SENT : d.received };
};

// The value the dispatcher BOUND for one column of the last INSERT or UPDATE on
// `table` since log index `t0` — the parameter itself, not what sqlite made of
// it. The test schema carries no column defaults, so a stored row cannot tell
// "bound 'normal'" from "omitted and defaulted"; Postgres would, and would
// refuse an explicit NULL into a NOT NULL column that sqlite accepts.
function boundValue(t0, table, col) {
  for (let i = eng.log.length - 1; i >= t0; i--) {
    const e = eng.log[i];
    if (!e.ok) continue;
    const ins = new RegExp('^INSERT INTO ' + table + ' \\(([^)]*)\\) VALUES \\(([^)]*)\\)').exec(e.sql);
    if (ins) {
      const cols = ins[1].split(',').map((s) => s.trim());
      const idx = cols.indexOf(col);
      if (idx === -1) return { present: false };
      const ph = /^\$(\d+)$/.exec(ins[2].split(',')[idx].trim());
      return { present: true, value: e.params[Number(ph[1]) - 1] };
    }
    const upd = new RegExp('^UPDATE ' + table + ' SET (.*) WHERE ').exec(e.sql);
    if (upd) {
      const m = new RegExp('(?:^|, )' + col + ' = \\$(\\d+)').exec(upd[1]);
      if (!m) return { present: false };
      return { present: true, value: e.params[Number(m[1]) - 1] };
    }
  }
  throw new Error('no INSERT or UPDATE on ' + table + ' ran since log index ' + t0);
}

/* ═══════════════════════════════════════════════════════════════════════════
 * THE HARNESS, FIRST. If mutate() cannot mutate, everything below is decoration.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the mutation harness is not the thing being fooled', () => {
  test('a missing anchor THROWS', () => {
    expect(() => mutate('no such text anywhere in the dispatcher', 'x')).toThrow(/MUTATION ANCHOR NOT FOUND/);
  });
  test('an anchor that matches more than one site THROWS', () => {
    // The two refused-by-name checks (top-level keys and fields) are the same
    // line of code — the exact shape that once let one mutant remove both.
    const twice = '    if (SERVICE_TICKET_REFUSED_FIELDS[k] || /_at$/.test(k)) {';
    expect(SOURCE.split(twice).length - 1).toBe(2);           // the premise: it really is two sites
    expect(() => mutate(twice, '    if (false) {')).toThrow(/MUTATION ANCHOR AMBIGUOUS/);
  });
  test('an identical replacement THROWS', () => {
    const a = 'const SERVICE_TICKET_TASK_ADDS_CAP = 25;';
    expect(() => mutate(a, a)).toThrow(/MUTATION CHANGED NO BYTES/);
  });
  test('a multi-line anchor written with LF matches the CRLF file and the mutant behaves differently', async () => {
    const mut = mutate(
      'const SERVICE_TICKET_TASK_KEYS = new Set([\'title\', \'notes\', \'priority\', \'due_date\']);\n' +
      '// Keys on a task_adds entry',
      'const SERVICE_TICKET_TASK_KEYS = new Set([\'title\']);\n// Keys on a task_adds entry');
    const t = [ticket({ title: 'T', job_id: 'j1' }, { ops: { fields: { title: 'T', job_id: 'j1' }, task_adds: [{ title: 'a', notes: 'n' }] } })];
    expect((await drive(REAL_MOD(), t, JOHN)).stage).toBe('applied');
    seedInto(eng);
    expect((await drive(mut, t, JOHN)).detail.code).toBe('unknown_field');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CREATE — on a job, on a lead, by job number, and as a bundle with a new lead
 * ══════════════════════════════════════════════════════════════════════════*/
describe('create', () => {
  test('on a job: the row, the event, the changeset and the receipt', async () => {
    const r = await drive(REAL_MOD(), [ticket({
      title: 'Leak under sink', job_id: 'j1', scope_proposed: 'Replace trap and supply lines',
      priority: 'High', site_contact_phone: '813-555-0199', scheduled_for: '2026-09-15',
    })], JOHN);
    expect(r.stage).toBe('applied');
    const rows = newTickets();
    expect(rows).toHaveLength(1);
    const row = rows[0];
    expect([row.organization_id, row.job_id, row.lead_id, row.created_by, row.title, row.priority, row.scheduled_for])
      .toEqual([1, 'j1', null, 10, 'Leak under sink', 'high', '2026-09-15']);
    expect(row.status).toBeNull();          // never written — the column default owns it in Postgres

    const evs = eng.all('SELECT * FROM service_ticket_events WHERE ticket_id = ?', row.id);
    expect(evs.map((e) => [e.kind, e.actor_kind, e.actor_user_id, e.organization_id]))
      .toEqual([['created', 'agent', 10, 1]]);
    expect(evs[0].detail.parent).toBe('job');

    const tgt = r.res.affected_targets[0];
    expect([tgt.entity_type, tgt.entity_id, tgt.op, tgt.created, tgt.job_id]).toEqual(['service_ticket', row.id, 'create', true, 'j1']);
    expect(r.res.apply_summary).toBe('Created service ticket "Leak under sink"');
    expect(isRenderableChangeset(r.res.apply_changeset)).toBe(true);
    expect(r.res.apply_changeset[0].entity_type).toBe('service_ticket');
    expect(r.res.apply_changeset[0].before).toBeNull();
    expect(r.res.apply_changeset[0].after.title).toBe('Leak under sink');
  });

  test('on a lead, by a LEADS_EDIT-only approver', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'Roof survey', lead_id: 'l1' })], LENA);
    expect(r.stage).toBe('applied');
    const row = newTickets()[0];
    expect([row.lead_id, row.job_id, row.created_by]).toEqual(['l1', null, 12]);
    expect(one('SELECT detail FROM service_ticket_events WHERE ticket_id = ?', row.id).detail.parent).toBe('lead');
  });

  test('a job NUMBER resolves to the job', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'By number', job_id: 'RV2000' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].job_id).toBe('j1');
  });

  test('MUTANT: without resolveJobTarget, a job number is refused as a job that does not exist', async () => {
    const mut = mutate(
      "  if (kind === 'job') id = await resolveJobTarget(dbClient, id, orgId);",
      '  // MUTANT: no job-number resolution');
    const r = await drive(mut, [ticket({ title: 'By number', job_id: 'RV2000' })], JOHN);
    expect(r.stage).toBe('apply');
    expect(r.detail.code).toBe('parent_not_found');
  });

  test('a $new_lead and a ticket on it, with a task, in ONE payload', async () => {
    const bundle = [
      { entity_type: 'lead', entity_id: '$new_lead', ops: { op: 'create', fields: { title: 'Brand new lead' } } },
      { entity_type: 'service_ticket', entity_id: '$new_ticket',
        ops: { fields: { title: 'Walk the site', lead_id: '$new_lead' }, task_adds: [{ title: 'Photos of the roof' }] } },
    ];
    // The dry run the Scribe loop takes first must succeed too, and leave nothing.
    const dry = await drive(REAL_MOD(), bundle, JOHN, { dryRun: true });
    expect(dry.stage).toBe('applied');
    expect(eng.count("SELECT 1 FROM leads WHERE title = 'Brand new lead'")).toBe(0);
    expect(newTickets()).toHaveLength(0);

    const r = await drive(REAL_MOD(), bundle, JOHN);
    expect(r.stage).toBe('applied');
    const lead = one("SELECT id FROM leads WHERE title = 'Brand new lead'");
    const row = newTickets()[0];
    expect(row.lead_id).toBe(lead.id);
    expect(r.res.ref_resolutions.$new_ticket).toBe(row.id);
    const task = one('SELECT * FROM tasks WHERE service_ticket_id = ?', row.id);
    expect([task.entity_type, task.entity_id]).toEqual(['lead', lead.id]);
  });

  test('TWO ENGINES — MUTANT: prove the new parent on the module pool and the bundle is refused', async () => {
    // The pool is a different connection. It cannot see a lead this transaction
    // has not committed, so a pool-side existence probe refuses the most
    // natural bundle there is — with a sentence that reads like a tenant refusal.
    require('../server/db').pool.query = engB.pool.query;
    const bundle = [
      { entity_type: 'lead', entity_id: '$new_lead', ops: { op: 'create', fields: { title: 'Brand new lead' } } },
      { entity_type: 'service_ticket', ops: { fields: { title: 'Walk the site', lead_id: '$new_lead' } } },
    ];
    const mut = mutate(
      "    : await dbClient.query('SELECT id FROM leads WHERE id = $1 LIMIT 1', [id]);",
      "    : await pool.query('SELECT id FROM leads WHERE id = $1 LIMIT 1', [id]);");
    const bad = await drive(mut, bundle, JOHN);
    expect(bad.stage).toBe('apply');
    expect(bad.detail.code).toBe('parent_not_found');

    seedInto(eng); seedInto(engB);
    const good = await drive(REAL_MOD(), bundle, JOHN);
    expect(good.stage).toBe('applied');
  });

  test('a scope that starts with "$" is text, not an undeclared ref', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'Allowance', job_id: 'j1', scope_proposed: '$1,500 allowance for drywall' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].scope_proposed).toBe('$1,500 allowance for drywall');
  });

  test('MUTANT: resolve refs across every string and that scope is refused as an unresolved ref', async () => {
    const mut = mutate(
      "  for (const k of ['job_id', 'lead_id']) {\n" +
      '    if (isRef(fields[k])) fields[k] = resolveRef(fields[k], refTable);\n' +
      '  }',
      '  resolveRefsInOps(ops, refTable);');
    const r = await drive(mut, [ticket({ title: 'Allowance', job_id: 'j1', scope_proposed: '$1,500 allowance for drywall' })], JOHN);
    expect(r.stage).toBe('apply');
    expect(r.message).toMatch(/Unresolved ref/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * TENANCY — a foreign parent reads exactly like an absent one
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a parent in another tenant is refused with the SAME answer as a parent that does not exist', () => {
  test('foreign job, absent job, foreign job number: one sentence, one code, no write', async () => {
    const foreign = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j9' })], JOHN);
    const absent = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j_nope' })], JOHN);
    const foreignNum = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'RV9000' })], JOHN);
    for (const r of [foreign, absent, foreignNum]) {
      expect(r.stage).toBe('apply');
      expect(r.detail.code).toBe('parent_not_found');
      expect(r.detail.retryable).toBe(false);
    }
    expect(foreign.message).toBe(absent.message);
    expect(foreignNum.message).toBe(absent.message);
    const foreignLead = await drive(REAL_MOD(), [ticket({ title: 'x', lead_id: 'l9' })], JOHN);
    const absentLead = await drive(REAL_MOD(), [ticket({ title: 'x', lead_id: 'l_nope' })], JOHN);
    expect(foreignLead.message).toBe(absentLead.message);
    expect(foreignLead.detail.code).toBe('parent_not_found');
    expect(newTickets()).toHaveLength(0);
  });

  test('MUTANT: without the tenant check, org 1 files a ticket on org 2\'s job', async () => {
    const mut = mutate(
      '  try {\n    await assertTargetOrg(dbClient, kind, id, orgId);\n  } catch (e) {\n    throw refusal();\n  }',
      '  // MUTANT: no tenant check');
    const r = await drive(mut, [ticket({ title: 'cross-tenant', job_id: 'j9' })], JOHN);
    expect(r.stage).toBe('applied');
    const row = newTickets()[0];
    expect([row.organization_id, row.job_id]).toEqual([1, 'j9']);   // the cross-tenant link, live
  });

  test('MUTANT: without the existence probe, a ticket is filed on a job that does not exist', async () => {
    const mut = mutate('  if (!probe.rowCount) throw refusal();', '  // MUTANT: no existence probe');
    const r = await drive(mut, [ticket({ title: 'ghost parent', job_id: 'j_nope' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].job_id).toBe('j_nope');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CAPABILITY — precise, per parent, on the transaction
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the approver must be able to edit the ticket\'s PARENT', () => {
  test('LEADS_EDIT alone cannot create a ticket on a job', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' })], LENA);
    expect(r.stage).toBe('apply');
    expect(r.detail.code).toBe('missing_capability');
    expect(r.detail.retryable).toBe(false);
    expect(r.message).toMatch(/requires JOBS_EDIT_ANY or JOBS_EDIT_OWN/);
    expect(newTickets()).toHaveLength(0);
  });

  test('the NARROW tier: JOBS_EDIT_OWN writes on an owned job, not on someone else\'s, not on a view grant', async () => {
    // Not-yours answers EXACTLY what nothing-there answers. Anything else lets a
    // crew lead learn which job ids (and job numbers) exist by trying them.
    const absent = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j_nope' })], CODY);
    expect([absent.stage, absent.detail.code]).toEqual(['apply', 'parent_not_found']);
    const notMine = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' })], CODY);
    expect(notMine.stage).toBe('apply');
    expect(answer(notMine, 'j1')).toEqual(answer(absent, 'j_nope'));
    const viewGrant = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j3' })], CODY);
    expect(answer(viewGrant, 'j3')).toEqual(answer(absent, 'j_nope'));
    const byNumber = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'RV2000' })], CODY);
    const absentNumber = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'RV9999' })], CODY);
    expect(answer(byNumber, 'RV2000')).toEqual(answer(absent, 'j_nope'));
    expect(answer(byNumber, 'RV2000')).toEqual(answer(absentNumber, 'RV9999'));
    expect(newTickets()).toHaveLength(0);

    const mine = await drive(REAL_MOD(), [ticket({ title: 'mine', job_id: 'j2' })], CODY);
    expect(mine.stage).toBe('applied');
    eng.db.exec("UPDATE job_access SET access_level = 'edit' WHERE job_id = 'j3' AND user_id = 11");
    const editGrant = await drive(REAL_MOD(), [ticket({ title: 'granted', job_id: 'j3' })], CODY);
    expect(editGrant.stage).toBe('applied');
  });

  test('update: the parent is the LOADED ticket\'s, so LEADS_EDIT cannot edit a job\'s ticket', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', { fields: { title: 'hijack' } })], LENA);
    expect(r.stage).toBe('apply');
    expect(r.detail.code).toBe('missing_capability');
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
  });

  test('MUTANT: ignore the verdict and a crew lead writes on a job he was never given', async () => {
    const mut = mutate('  if (verdict && verdict.ok === true) return;', '  if (true) return;');
    const r = await drive(mut, [ticket({ title: 'not his', job_id: 'j1' })], CODY);
    expect(r.stage).toBe('applied');
  });

  test('MUTANT: ask for READ instead of WRITE and a view grant becomes an edit grant', async () => {
    const mut = mutate(
      "    parent,\n    mode: 'write',\n    orgId,\n  });",
      "    parent,\n    mode: 'read',\n    orgId,\n  });");
    const r = await drive(mut, [ticket({ title: 'view grant', job_id: 'j3' })], CODY);
    expect(r.stage).toBe('applied');
  });

  test('MUTANT: drop the update-side check and LEADS_EDIT rewrites a job\'s ticket', async () => {
    const mut = mutate(
      "    await assertTicketParentWritable(dbClient, actor, parent, orgId, 'edit',\n      () => ticketNotFound(target.entity_id));",
      '    // MUTANT: no update capability check');
    const r = await drive(mut, [update('st_open', { fields: { title: 'hijack' } })], LENA);
    expect(r.stage).toBe('applied');
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('hijack');
  });

  test('MUTANT: give not_assigned its own answer again and a job that exists reads differently from one that does not', async () => {
    const mut = mutate("  if (reason === 'not_assigned') throw notFound();\n", '');
    const absent = await drive(mut, [ticket({ title: 'x', job_id: 'j_nope' })], CODY);
    const notMine = await drive(mut, [ticket({ title: 'x', job_id: 'j1' })], CODY);
    expect(answer(notMine, 'j1')).not.toEqual(answer(absent, 'j_nope'));      // the oracle, back
    expect(notMine.detail.code).toBe('missing_capability');
    const absentTicket = await drive(mut, [update('st_nope', { fields: { title: 'x' } })], CODY);
    const notMineTicket = await drive(mut, [update('st_open', { fields: { title: 'x' } })], CODY);
    expect(answer(notMineTicket, 'st_open')).not.toEqual(answer(absentTicket, 'st_nope'));
  });

  test('MUTANT: hand the create site the TICKET not-found answer and a not-yours job stops matching an absent one', async () => {
    // The create site must throw the PARENT refusal for the deciding kind — the
    // one proveTicketParentInOrg throws — not merely "some" not-found.
    const mut = mutate(
      "      () => ticketParentNotFound(deciding.kind, fields[`${deciding.kind}_id`]));",
      "      () => ticketNotFound(fields[`${deciding.kind}_id`]));");
    const absent = await drive(mut, [ticket({ title: 'x', job_id: 'j_nope' })], CODY);
    const notMine = await drive(mut, [ticket({ title: 'x', job_id: 'j1' })], CODY);
    expect(notMine.detail.code).toBe('not_found');
    expect(answer(notMine, 'j1')).not.toEqual(answer(absent, 'j_nope'));
  });

  test('MUTANT: echo the CANONICAL job into `received` and a not-yours job number stops matching an absent one', async () => {
    // The apply route hands detail.received to the client. A job number the
    // approver may not touch must not come back as the id it resolved to.
    const real = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'RV2000' })], CODY);
    expect(real.detail.received).toBe('RV2000');
    const mut = mutate(
      "      () => ticketParentNotFound(deciding.kind, fields[`${deciding.kind}_id`]));",
      "      () => ticketParentNotFound(deciding.kind, parent[`${deciding.kind}_id`]));");
    const absent = await drive(mut, [ticket({ title: 'x', job_id: 'RV9999' })], CODY);
    const byNumber = await drive(mut, [ticket({ title: 'x', job_id: 'RV2000' })], CODY);
    expect([byNumber.stage, byNumber.detail.code, byNumber.detail.received]).toEqual(['apply', 'parent_not_found', 'j1']);
    expect(answer(byNumber, 'RV2000')).not.toEqual(answer(absent, 'RV9999'));
    // The helper this replaced compared everything BUT received and expected,
    // and was fooled by exactly this mutant.
    const legacy = (a) => { const o = Object.assign({}, a); delete o.received; delete o.expected; return o; };
    expect(legacy(answer(byNumber, 'RV2000'))).toEqual(legacy(answer(absent, 'RV9999')));
  });

  test('MUTANT: echo a hidden ticket\'s PARENT into `received` and a not-yours ticket stops matching an absent one', async () => {
    const real = await drive(REAL_MOD(), [update('st_open', { fields: { title: 'x' } })], CODY);
    expect(real.detail.received).toBe('st_open');
    const mut = mutate(
      '      () => ticketNotFound(target.entity_id));',
      '      () => ticketNotFound(before.job_id));');
    const absent = await drive(mut, [update('st_nope', { fields: { title: 'x' } })], CODY);
    const hidden = await drive(mut, [update('st_open', { fields: { title: 'x' } })], CODY);
    expect([hidden.stage, hidden.detail.code, hidden.detail.received]).toEqual(['apply', 'not_found', 'j1']);
    expect(answer(hidden, 'st_open')).not.toEqual(answer(absent, 'st_nope'));
    const legacy = (a) => { const o = Object.assign({}, a); delete o.received; delete o.expected; return o; };
    expect(legacy(answer(hidden, 'st_open'))).toEqual(legacy(answer(absent, 'st_nope')));
  });

  test('TWO PARENTS: a bogus second parent cannot tell a job the approver may not touch from a job that is nothing', async () => {
    // [a job CODY may not write on, a job that is nothing to him] — by id, by
    // number, a view grant, another tenant's job and job number.
    const PAIRS = [['j1', 'j_nope'], ['RV2000', 'RV9999'], ['j3', 'j_nope'], ['j9', 'j_nope'], ['RV9000', 'RV9999']];
    for (const lead of ['l_nope', 'l9', 'l1']) {
      for (const [hidden, nothing] of PAIRS) {
        const a = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: hidden, lead_id: lead })], CODY);
        const b = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: nothing, lead_id: lead })], CODY);
        expect([hidden, lead, a.stage, a.detail.code, a.detail.field_path])
          .toEqual([hidden, lead, 'apply', 'parent_not_found', 'service_ticket.ops.fields.job_id']);
        expect([hidden, nothing, lead, answer(a, hidden)]).toEqual([hidden, nothing, lead, answer(b, nothing)]);
      }
    }
    expect(newTickets()).toHaveLength(0);

    // The second parent is still PROVED — on a job he may write on — and it
    // answers as the lead, foreign and absent alike.
    const bogusLead = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j2', lead_id: 'l_nope' })], CODY);
    const foreignLead = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j2', lead_id: 'l9' })], CODY);
    expect([bogusLead.stage, bogusLead.detail.code, bogusLead.detail.field_path])
      .toEqual(['apply', 'parent_not_found', 'service_ticket.ops.fields.lead_id']);
    expect(answer(foreignLead, 'l9')).toEqual(answer(bogusLead, 'l_nope'));
    expect(newTickets()).toHaveLength(0);
    const both = await drive(REAL_MOD(), [ticket({ title: 'both', job_id: 'RV2001', lead_id: 'l1' })], CODY);
    expect(both.stage).toBe('applied');
    expect([newTickets()[0].job_id, newTickets()[0].lead_id]).toEqual(['j2', 'l1']);
  });

  test('MUTANT: prove both parents before the capability (the old order) and the bogus lead answers for the job', async () => {
    const mut = mutate(
      '    const deciding = ticketAccess.parentOf(fields);\n' +
      '    parent = { job_id: null, lead_id: null };\n' +
      '    if (deciding.kind) {\n' +
      '      parent[`${deciding.kind}_id`] =\n' +
      '        await proveTicketParentInOrg(dbClient, deciding.kind, fields[`${deciding.kind}_id`], orgId);\n' +
      '    }',
      '    const jobId = ticketValuePresent(fields.job_id)\n' +
      "      ? await proveTicketParentInOrg(dbClient, 'job', fields.job_id, orgId) : null;\n" +
      '    const leadId = ticketValuePresent(fields.lead_id)\n' +
      "      ? await proveTicketParentInOrg(dbClient, 'lead', fields.lead_id, orgId) : null;\n" +
      '    parent = { job_id: jobId, lead_id: leadId };\n' +
      '    const deciding = ticketAccess.parentOf(parent);');
    for (const [hidden, nothing] of [['j1', 'j_nope'], ['RV2000', 'RV9999']]) {
      const a = await drive(mut, [ticket({ title: 'x', job_id: hidden, lead_id: 'l_nope' })], CODY);
      const b = await drive(mut, [ticket({ title: 'x', job_id: nothing, lead_id: 'l_nope' })], CODY);
      expect(a.detail.field_path).toBe('service_ticket.ops.fields.lead_id');   // "no such lead": so the job exists
      expect(b.detail.field_path).toBe('service_ticket.ops.fields.job_id');
      expect(answer(a, hidden)).not.toEqual(answer(b, nothing));
    }
  });

  test('MUTANT: take the second parent on trust and org 1 files a ticket linked to org 2\'s lead', async () => {
    const mut = mutate(
      "    if (deciding.kind === 'job' && ticketValuePresent(fields.lead_id)) {\n" +
      "      parent.lead_id = await proveTicketParentInOrg(dbClient, 'lead', fields.lead_id, orgId);\n" +
      '    }',
      "    if (deciding.kind === 'job' && ticketValuePresent(fields.lead_id)) parent.lead_id = String(fields.lead_id);");
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j2', lead_id: 'l9' })], CODY);
    expect(r.stage).toBe('applied');
    expect([newTickets()[0].job_id, newTickets()[0].lead_id]).toEqual(['j2', 'l9']);
  });

  test('the NARROW tier on UPDATE: a ticket on a job not his reads as no ticket, and nothing is written', async () => {
    eng.db.exec("INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority) VALUES ('st_cody', 1, 'Cody ticket', 'j2', NULL, 'open', 'normal')");
    const payload = (id) => [update(id, { fields: { title: 'crew rename' }, task_adds: [{ title: 'planted' }] })];
    const absent = await drive(REAL_MOD(), payload('st_nope'), CODY);
    expect([absent.stage, absent.detail.code]).toEqual(['apply', 'not_found']);
    const notMine = await drive(REAL_MOD(), payload('st_open'), CODY);
    expect(answer(notMine, 'st_open')).toEqual(answer(absent, 'st_nope'));
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
    expect(eng.count('SELECT 1 FROM service_ticket_events')).toBe(0);

    // Positive control: the same crew lead, the same payload, a job he owns.
    const mine = await drive(REAL_MOD(), payload('st_cody'), CODY);
    expect(mine.stage).toBe('applied');
    expect(one("SELECT title FROM service_tickets WHERE id='st_cody'").title).toBe('crew rename');
    expect(eng.count("SELECT 1 FROM tasks WHERE service_ticket_id = 'st_cody'")).toBe(1);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE ticket_id = 'st_cody'")).toBe(2);
  });

  test('MUTANT: drop the update-side check and the crew lead rewrites a ticket on a job he was never given', async () => {
    const mut = mutate(
      "    await assertTicketParentWritable(dbClient, actor, parent, orgId, 'edit',\n      () => ticketNotFound(target.entity_id));",
      '    // MUTANT: no update capability check');
    const r = await drive(mut, [update('st_open', { fields: { title: 'crew rename' }, task_adds: [{ title: 'planted' }] })], CODY);
    expect(r.stage).toBe('applied');
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('crew rename');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(1);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE APPLY ROUTE'S COARSE GATE (payload-routes.js)
 * ══════════════════════════════════════════════════════════════════════════*/
describe('PAYLOAD_APPLY_CAP.service_ticket — the coarse half at the route', () => {
  const routes = () => require('../server/routes/payload-routes').internals;
  const user = (id, role) => ({ id, role, organization_id: 1 });
  const payload = { user_id: 13, targets: [ticket({ title: 'x', job_id: 'j1' })] };

  test('a role with no ticket-write capability at all is refused before any transaction', async () => {
    const denial = await routes().denyPayloadApply(user(13, 'viewer'), payload);
    expect(denial).toMatch(/service_ticket/);
  });

  test('coarse means necessary, not sufficient: LEADS_EDIT passes the route, and the dispatcher refuses the JOB ticket', async () => {
    expect(await routes().denyPayloadApply(user(12, 'leads_only'), payload)).toBeNull();
    const r = await drive(REAL_MOD(), payload.targets, LENA);
    expect(r.detail.code).toBe('missing_capability');
  });

  test('the entry is exactly the access module\'s coarse write set', () => {
    expect(routes().PAYLOAD_APPLY_CAP.service_ticket)
      .toEqual(require('../server/services/service-ticket-access').coarseCaps('write'));
  });

  test('MUTANT: remove the entry and the gate fails OPEN for a view-only role', async () => {
    const map = routes().PAYLOAD_APPLY_CAP;
    const saved = map.service_ticket;
    delete map.service_ticket;
    try {
      expect(await routes().denyPayloadApply(user(13, 'viewer'), payload)).toBeNull();
    } finally {
      map.service_ticket = saved;
    }
    expect(await routes().denyPayloadApply(user(13, 'viewer'), payload)).toMatch(/service_ticket/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * ASSIGNEES — in this organization, or refused
 * ══════════════════════════════════════════════════════════════════════════*/
describe('an assignee from another organization is refused', () => {
  test('on the ticket — the ONE assignee a work order has', async () => {
    const onTicket = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', assignee_user_id: 20 })], JOHN);
    expect([onTicket.stage, onTicket.detail.code, onTicket.detail.retryable]).toEqual(['apply', 'assignee_not_in_org', false]);
    expect(newTickets()).toHaveLength(0);
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);

    const inOrg = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', assignee_user_id: 11 })], JOHN);
    expect(inOrg.stage).toBe('applied');
    expect(newTickets()[0].assignee_user_id).toBe(11);
  });

  test('a child task has no assignee to be in or out of the org — the key is refused outright (1.35)', async () => {
    // Before 1.35 this asked whether user 20 was in the org. The question does
    // not arise any more: a BUILDING is never assigned to one person, in this
    // org or any other, so the key is refused before the org is ever consulted.
    for (const uid of [20, 11]) {
      const r = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' }, {
        ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'a', assignee_user_id: uid }] } })], JOHN);
      expect([r.stage, r.detail.code, r.detail.retryable, r.detail.field_path])
        .toEqual(['emit', 'building_not_assignable', false, 'service_ticket.ops.task_adds[0].assignee_user_id']);
      // The SAME sentence the two REST doors and the task link say.
      expect(r.message).toContain('A building on a work order is never assigned to one person.');
      expect(r.message).toContain("Set the work order's Assigned to instead");
      expect(r.message).toContain('Nothing was saved.');
      expect(newTickets()).toHaveLength(0);
      expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
    }
  });

  test('on UPDATE: a foreign assignee refuses the whole edit, non-retryably, with no timeline row', async () => {
    const t = [update('st_open', { fields: { title: 'renamed with a rival on it', assignee_user_id: 20 } })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code, r.detail.retryable, r.detail.field_path])
      .toEqual(['apply', 'assignee_not_in_org', false, 'service_ticket.ops.fields.assignee_user_id']);
    expect(one("SELECT title, assignee_user_id FROM service_tickets WHERE id='st_open'"))
      .toEqual({ title: 'Leak at unit 4', assignee_user_id: null });
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'field_changed'")).toBe(0);

    const mut = mutate(
      '  if (!r.rowCount) {\n    throw ticketRefusal(`${where} is not a user in this organization.',
      '  if (false) {\n    throw ticketRefusal(`${where} is not a user in this organization.');
    const m = await drive(mut, t, JOHN);
    expect(m.stage).toBe('applied');
    expect(one("SELECT assignee_user_id FROM service_tickets WHERE id='st_open'").assignee_user_id).toBe(20);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'field_changed'")).toBe(1);
  });

  test('MUTANT: without the in-org check, another tenant\'s user is put on the ticket', async () => {
    const mut = mutate(
      '  if (!r.rowCount) {\n    throw ticketRefusal(`${where} is not a user in this organization.',
      '  if (false) {\n    throw ticketRefusal(`${where} is not a user in this organization.');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1', assignee_user_id: 20 })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].assignee_user_id).toBe(20);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE GRAMMAR — refused by name, refused non-retryably, never silently dropped
 * ══════════════════════════════════════════════════════════════════════════*/
describe('what the model may not write', () => {
  test('status and scope_approved are refused BY NAME and NON-retryably, at emit', async () => {
    for (const [k, v] of [['status', 'closed'], ['scope_approved', 'signed']]) {
      const onUpdate = await drive(REAL_MOD(), [update('st_open', { fields: { [k]: v } })], JOHN);
      expect([onUpdate.stage, onUpdate.detail.code, onUpdate.detail.retryable]).toEqual(['emit', 'blocked_field', false]);
      expect(onUpdate.message).toContain(`fields.${k} is not writable from a payload`);
      const onCreate = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', [k]: v })], JOHN);
      expect(onCreate.detail.code).toBe('blocked_field');
    }
    const topLevel = await drive(REAL_MOD(), [{ entity_type: 'service_ticket', entity_id: 'st_open', ops: { op: 'update', status: 'closed' } }], JOHN);
    expect([topLevel.detail.code, topLevel.detail.retryable]).toEqual(['blocked_field', false]);
    for (const k of ['organization_id', 'created_by', 'ticket_number', 'checklist', 'guest_log', 'closed_at']) {
      const r = await drive(REAL_MOD(), [update('st_open', { fields: { [k]: 'x' } })], JOHN);
      expect([k, r.detail.code, r.detail.retryable]).toEqual([k, 'blocked_field', false]);
    }
    expect(one("SELECT status FROM service_tickets WHERE id='st_open'").status).toBe('open');
  });

  test('MUTANT: lose the by-name refusal and status becomes a RETRYABLE typo — the laundering prompt', async () => {
    // The Scribe loop stops only on retryable:false. Downgraded to an unknown
    // field, "close the ticket" gets "fix it and re-emit", and the cheapest fix
    // is to drop the status and emit the rest as if the ask had been met.
    //
    // TWO SITES, TWO MUTANTS. The check is the same line in the top-level key
    // loop and in the fields loop, so each anchor carries the line above it —
    // a bare anchor would remove both and prove neither on its own.
    const inFields = mutate(
      '    // than an "unknown field" that invites a spelling variant.\n    if (SERVICE_TICKET_REFUSED_FIELDS[k] || /_at$/.test(k)) {',
      '    // than an "unknown field" that invites a spelling variant.\n    if (false) {');
    const r = await drive(inFields, [update('st_open', { fields: { status: 'closed' } })], JOHN);
    expect(r.stage).toBe('emit');
    expect(r.detail.code).toBe('unknown_field');
    expect(r.detail.retryable).not.toBe(false);
    // The top-level site is untouched in this mutant, and still refuses by name.
    const topStill = await drive(inFields, [{ entity_type: 'service_ticket', entity_id: 'st_open', ops: { op: 'update', status: 'closed' } }], JOHN);
    expect([topStill.detail.code, topStill.detail.retryable]).toEqual(['blocked_field', false]);
  });

  test('MUTANT: lose the TOP-LEVEL by-name refusal and ops.status becomes a retryable typo', async () => {
    const topLevel = mutate(
      '    if (schema.allowedTopKeys.has(k)) continue;\n    if (SERVICE_TICKET_REFUSED_FIELDS[k] || /_at$/.test(k)) {',
      '    if (schema.allowedTopKeys.has(k)) continue;\n    if (false) {');
    const r = await drive(topLevel, [{ entity_type: 'service_ticket', entity_id: 'st_open', ops: { op: 'update', status: 'closed' } }], JOHN);
    expect([r.stage, r.detail.code]).toEqual(['emit', 'unknown_field']);
    expect(r.detail.retryable).not.toBe(false);
    // The fields site is untouched in this mutant, and still refuses by name.
    const fieldsStill = await drive(topLevel, [update('st_open', { fields: { status: 'closed' } })], JOHN);
    expect([fieldsStill.detail.code, fieldsStill.detail.retryable]).toEqual(['blocked_field', false]);
  });

  test('an unknown field is refused with the expected set, and never silently dropped', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', description: 'the scope' })], JOHN);
    expect([r.stage, r.detail.code]).toEqual(['emit', 'unknown_field']);
    expect(r.detail.expected).toEqual(expect.arrayContaining(['scope_proposed', 'title', 'job_id']));
    const top = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, tasks: [] } })], JOHN);
    expect([top.detail.code, top.detail.expected]).toEqual(['unknown_field', ['op', 'fields', 'task_adds']]);
    const taskKey = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' }, {
      ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'a', status: 'done' }] } })], JOHN);
    expect([taskKey.detail.code, taskKey.detail.received]).toEqual(['unknown_field', ['status']]);
  });

  test('MUTANT: without the allow-list refusal, {description} is dropped and the ticket still "Created"', async () => {
    const mut = mutate('    if (!SERVICE_TICKET_FIELDS.has(k)) {', '    if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1', description: 'the scope' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].scope_proposed).toBeNull();     // the scope the model wrote went nowhere
  });

  test('MUTANT: without the task-key refusal, a child task\'s status is dropped in silence', async () => {
    // The anchor carries the ticket's own key set: a bare `if (stray.length) {`
    // is also a substring of another dispatcher's stray-key check.
    const mut = mutate(
      '      const stray = Object.keys(t).filter((key) => !SERVICE_TICKET_TASK_KEYS.has(key));\n      if (stray.length) {',
      '      const stray = Object.keys(t).filter((key) => !SERVICE_TICKET_TASK_KEYS.has(key));\n      if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1' }, {
      ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'a', status: 'done' }] } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one('SELECT status FROM tasks').status).toBeNull();
  });

  test('priority goes through the normalizer and refuses what it would have to GUESS', async () => {
    const bad = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', priority: 'critical' })], JOHN);
    expect([bad.stage, bad.detail.code]).toEqual(['emit', 'invalid_enum']);
    const mut = mutate(
      "    if (typeof v !== 'string' || v.trim().toLowerCase() !== normalized) {",
      '    if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1', priority: 'critical' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].priority).toBe('normal');       // asked "critical", stored "normal"
  });

  test('priority null or "" is NORMAL — the value BOUND is \'normal\', on create and on update, never an explicit NULL', async () => {
    // service_tickets.priority is NOT NULL DEFAULT 'normal' in Postgres, and an
    // explicit NULL is not the default: it is a failed statement. The test
    // schema has no default and no NOT NULL, so the stored row alone cannot
    // show this — the bound parameter can.
    for (const v of [null, '']) {
      seedInto(eng);
      const t0 = eng.log.length;
      const c = await drive(REAL_MOD(), [ticket({ title: 'no priority', job_id: 'j1', priority: v })], JOHN);
      expect([JSON.stringify(v), c.stage]).toEqual([JSON.stringify(v), 'applied']);
      expect([JSON.stringify(v), boundValue(t0, 'service_tickets', 'priority')]).toEqual([JSON.stringify(v), { present: true, value: 'normal' }]);
      expect(newTickets()[0].priority).toBe('normal');

      eng.db.exec("UPDATE service_tickets SET priority = 'high' WHERE id = 'st_open'");
      const t1 = eng.log.length;
      const u = await drive(REAL_MOD(), [update('st_open', { fields: { priority: v } })], JOHN);
      expect(u.stage).toBe('applied');
      expect(boundValue(t1, 'service_tickets', 'priority')).toEqual({ present: true, value: 'normal' });
      expect(one("SELECT priority FROM service_tickets WHERE id='st_open'").priority).toBe('normal');
    }
    // Blank is not a licence to guess: an unknown word is still refused.
    const bad = await drive(REAL_MOD(), [update('st_open', { fields: { priority: 'critical' } })], JOHN);
    expect([bad.stage, bad.detail.code]).toEqual(['emit', 'invalid_enum']);
  });

  test('MUTANT: drop the priority arm of ticketColumnValue and a null priority is BOUND as NULL', async () => {
    const mut = mutate("  if (k === 'priority' && (v === null || v === '')) return 'normal';\n", '');
    const t0 = eng.log.length;
    const c = await drive(mut, [ticket({ title: 'no priority', job_id: 'j1', priority: null })], JOHN);
    expect(c.stage).toBe('applied');                        // sqlite takes it; Postgres would not
    expect(boundValue(t0, 'service_tickets', 'priority')).toEqual({ present: true, value: null });
    const t1 = eng.log.length;
    await drive(mut, [update('st_open', { fields: { priority: null } })], JOHN);
    expect(boundValue(t1, 'service_tickets', 'priority')).toEqual({ present: true, value: null });
  });

  test('MUTANT: validate "" as a priority word and a blank priority is refused as an invalid enum', async () => {
    const mut = mutate(
      "    // 'normal' for both — never an explicit NULL into a NOT NULL column.\n    if (v === '') return;\n",
      "    // 'normal' for both — never an explicit NULL into a NOT NULL column.\n");
    const r = await drive(mut, [ticket({ title: 'no priority', job_id: 'j1', priority: '' })], JOHN);
    expect([r.stage, r.detail.code, r.detail.field_path]).toEqual(['emit', 'invalid_enum', 'service_ticket.ops.fields.priority']);
    expect(newTickets()).toHaveLength(0);
  });

  test('scheduled_for and due_date must be real calendar days', async () => {
    const bad = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', due_date: '2026-02-31' })], JOHN);
    expect([bad.stage, bad.detail.code]).toEqual(['emit', 'wrong_type']);
    const iso = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', scheduled_for: '2026-09-15T09:00:00Z' })], JOHN);
    expect(iso.detail.code).toBe('wrong_type');
    const mut = mutate('    if (!isCalendarDay(v)) {', '    if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1', due_date: '2026-02-31' })], JOHN);
    expect(r.stage).toBe('applied');
    expect(newTickets()[0].due_date).toBe('2026-02-31');   // a day that does not exist, stored
  });

  test('create needs a title and a parent', async () => {
    const noParent = await drive(REAL_MOD(), [ticket({ title: 'x' })], JOHN);
    expect([noParent.stage, noParent.detail.code]).toEqual(['emit', 'missing_field']);
    const noTitle = await drive(REAL_MOD(), [ticket({ job_id: 'j1' })], JOHN);
    expect(noTitle.detail.field_path).toBe('service_ticket.ops.fields.title');
    const mut = mutate('    if (!hasJob && !hasLead) {', '    if (false) {');
    const r = await drive(mut, [ticket({ title: 'x' })], JOHN);
    // Past the grammar, the access rule still refuses — but as a PERMISSION
    // problem, which is the wrong thing to tell a model that forgot a field.
    expect(r.stage).toBe('apply');
    expect(r.detail.code).toBe('missing_capability');
  });

  test('null/"" PARITY WITH REST: the unused parent may be null or "", and a blank date, coordinate or assignee is stored NULL', async () => {
    // The parent a create does not use.
    for (const other of [null, '']) {
      seedInto(eng);
      const onJob = await drive(REAL_MOD(), [ticket({ title: 'on the job', job_id: 'j1', lead_id: other })], JOHN);
      expect([JSON.stringify(other), onJob.stage]).toEqual([JSON.stringify(other), 'applied']);
      expect([newTickets()[0].job_id, newTickets()[0].lead_id]).toEqual(['j1', null]);
      seedInto(eng);
      const onLead = await drive(REAL_MOD(), [ticket({ title: 'on the lead', lead_id: 'l1', job_id: other })], LENA);
      expect(onLead.stage).toBe('applied');
      expect([newTickets()[0].job_id, newTickets()[0].lead_id]).toEqual([null, 'l1']);
    }
    // Still one REAL parent required.
    for (const [j, l] of [[null, null], ['', ''], [null, '']]) {
      const none = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: j, lead_id: l })], JOHN);
      expect([none.stage, none.detail.code]).toEqual(['emit', 'missing_field']);
    }

    // '' on create: accepted, stored NULL.
    seedInto(eng);
    const BLANK = { scheduled_for: '', due_date: '', lat: '', lng: '', assignee_user_id: '' };
    const created = await drive(REAL_MOD(), [ticket(Object.assign({ title: 'blanks', job_id: 'j1' }, BLANK))], JOHN);
    expect(created.stage).toBe('applied');
    const row = newTickets()[0];
    expect([row.scheduled_for, row.due_date, row.lat, row.lng, row.assignee_user_id]).toEqual([null, null, null, null, null]);

    // '' on update: CLEARS a value that was there.
    const set = await drive(REAL_MOD(), [update('st_open', { fields: { scheduled_for: '2026-09-15', due_date: '2026-09-20', lat: 27.95, lng: -82.46, assignee_user_id: 11 } })], JOHN);
    expect(set.stage).toBe('applied');
    const cleared = await drive(REAL_MOD(), [update('st_open', { fields: BLANK })], JOHN);
    expect(cleared.stage).toBe('applied');
    expect(one("SELECT scheduled_for, due_date, lat, lng, assignee_user_id FROM service_tickets WHERE id='st_open'"))
      .toEqual({ scheduled_for: null, due_date: null, lat: null, lng: null, assignee_user_id: null });

    // A title is still never blank or null.
    const blankTitle = await drive(REAL_MOD(), [ticket({ title: '', job_id: 'j1' })], JOHN);
    expect([blankTitle.stage, blankTitle.detail.code]).toEqual(['emit', 'missing_field']);
    for (const v of [null, '']) {
      const u = await drive(REAL_MOD(), [update('st_open', { fields: { title: v } })], JOHN);
      expect([JSON.stringify(v), u.stage, u.detail.code]).toEqual([JSON.stringify(v), 'emit', 'missing_field']);
    }
  });

  test('MUTANT: validate the unused parent and {job_id, lead_id: null} is refused', async () => {
    const mut = mutate(
      "    if (op === 'create' && (k === 'job_id' || k === 'lead_id') && (fields[k] === null || fields[k] === '')) {\n      continue;\n    }",
      '');
    for (const other of [null, '']) {
      const r = await drive(mut, [ticket({ title: 'on the job', job_id: 'j1', lead_id: other })], JOHN);
      expect(r.stage).toBe('emit');
    }
    expect(newTickets()).toHaveLength(0);
  });

  test('MUTANT: validate "" as a value and a blank date is refused as a malformed day', async () => {
    const mut = mutate("    if (fields[k] === '' && SERVICE_TICKET_BLANK_IS_NULL.has(k)) continue;\n", '');
    for (const k of ['scheduled_for', 'due_date', 'lat', 'lng', 'assignee_user_id']) {
      const r = await drive(mut, [update('st_open', { fields: { [k]: '' } })], JOHN);
      expect([k, r.stage, r.detail.code]).toEqual([k, 'emit', 'wrong_type']);
    }
  });

  test('MUTANT: store "" as-is and a blank coordinate becomes 0 — a pin in the Gulf of Guinea', async () => {
    const mut = mutate("  if (v === '' && SERVICE_TICKET_BLANK_IS_NULL.has(k)) return null;\n", '');
    const r = await drive(mut, [update('st_open', { fields: { lat: '', lng: '' } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT lat, lng FROM service_tickets WHERE id='st_open'")).toEqual({ lat: 0, lng: 0 });
  });

  test('MUTANT: prove a "" assignee and clearing the assignee is refused as a user not in the org', async () => {
    const mut = mutate('  if (ticketValuePresent(fields.assignee_user_id)) {', '  if (fields.assignee_user_id != null) {');
    const r = await drive(mut, [update('st_open', { fields: { assignee_user_id: '' } })], JOHN);
    expect([r.stage, r.detail.code]).toEqual(['apply', 'assignee_not_in_org']);
  });

  test('task_adds is capped at 25', async () => {
    const many = Array.from({ length: 26 }, (_, i) => ({ title: 'task ' + i }));
    const t = [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: many } })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code, r.detail.retryable]).toEqual(['emit', 'too_many', false]);
    const mut = mutate('    if (ops.task_adds.length > SERVICE_TICKET_TASK_ADDS_CAP) {', '    if (false) {');
    expect((await drive(mut, t, JOHN)).stage).toBe('applied');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(26);
  });

  test('condition is refused, and without the refusal if_exists silently SKIPS a real ticket', async () => {
    const t = [Object.assign(update('st_open', { fields: { title: 'renamed' } }), { condition: 'if_exists' })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code, r.detail.retryable]).toEqual(['emit', 'unknown_field', false]);
    const mut = mutate('      if (target.condition != null) {', '      if (false) {');
    const m = await drive(mut, t, JOHN);
    expect(m.stage).toBe('applied');
    expect(m.res.apply_summary).toMatch(/Skipped service_ticket st_open/);   // a raw id, and nothing written
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
  });

  test('a move side cannot be a service ticket — and re-emitting cannot fix that', async () => {
    const t = [{ op: 'move', source: update('st_open', { fields: { title: 'a' } }), dest: update('st_lead', { fields: { title: 'b' } }) }];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code]).toEqual(['emit', 'unknown_field']);
    expect(r.detail.retryable).toBe(false);
    const mut = mutate(
      '          throw ticketRefusal(\n            `move.${side} cannot be a service_ticket target.',
      '          throw new PayloadValidationError(\n            `move.${side} cannot be a service_ticket target.');
    const m = await drive(mut, t, JOHN);
    expect(m.detail.code).toBe('unknown_field');
    expect(m.detail.retryable).not.toBe(false);                // a "fix it and re-emit" prompt for a thing no emit fixes
  });

  test('op:"delete" is refused at emit, non-retryably — a ticket is never deleted from a payload', async () => {
    const t = [update('st_open', { op: 'delete' })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code, r.detail.retryable]).toEqual(['emit', 'invalid_enum', false]);
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
    const mut = mutate(
      "      { code: 'invalid_enum', field_path: 'service_ticket.ops.op', expected: ['create', 'update'], received: op,\n        retryable: false });",
      "      { code: 'invalid_enum', field_path: 'service_ticket.ops.op', expected: ['create', 'update'], received: op });");
    const m = await drive(mut, t, JOHN);
    expect([m.stage, m.detail.code]).toEqual(['emit', 'invalid_enum']);
    expect(m.detail.retryable).not.toBe(false);
  });

  test('a child task\'s title and notes are refused over the tasks REST door\'s bounds, never cut', async () => {
    const internals = REAL_MOD().internals;
    expect([internals.TASKS_REST_TITLE_CAP, internals.TASKS_REST_NOTES_CAP]).toEqual([500, 5000]);
    const withTask = (task) => [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [task] } })];
    const longTitle = withTask({ title: 'T'.repeat(501) });
    const longNotes = withTask({ title: 'ok', notes: 'N'.repeat(5001) });

    const t = await drive(REAL_MOD(), longTitle, JOHN);
    expect([t.stage, t.detail.code, t.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.task_adds[0].title']);
    const n = await drive(REAL_MOD(), longNotes, JOHN);
    expect([n.stage, n.detail.code, n.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.task_adds[0].notes']);
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);

    // At the bound exactly, accepted — and stored whole.
    const edge = await drive(REAL_MOD(), withTask({ title: 'T'.repeat(500), notes: 'N'.repeat(5000) }), JOHN);
    expect(edge.stage).toBe('applied');
    expect(one('SELECT length(title) AS t, length(notes) AS n FROM tasks')).toEqual({ t: 500, n: 5000 });
  });

  test('a child task title is measured TRIMMED: 500 chars inside whitespace applies, stored as exactly 500', async () => {
    const padded = '  ' + 'T'.repeat(500) + '  ';
    expect(padded.length).toBe(504);                         // the premise: over the cap raw, at it trimmed
    const t = [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: padded }] } })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect(r.stage).toBe('applied');
    expect(one('SELECT length(title) AS t, title FROM tasks')).toEqual({ t: 500, title: 'T'.repeat(500) });

    seedInto(eng);
    const mut = mutate('      if (t.title.trim().length > TASKS_REST_TITLE_CAP) {', '      if (t.title.length > TASKS_REST_TITLE_CAP) {');
    const m = await drive(mut, t, JOHN);
    expect([m.stage, m.detail.code, m.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.task_adds[0].title']);
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
  });

  test('a child task due_date "" is NO due date: accepted, and no due_date column is written', async () => {
    const t = [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' },
      task_adds: [{ title: 'blank due', due_date: '' }, { title: 'real due', due_date: '2026-09-20' }] } })];
    const t0 = eng.log.length;
    const r = await drive(REAL_MOD(), t, JOHN);
    expect(r.stage).toBe('applied');
    // Two task INSERTs ran; boundValue reads the LAST, so read the first by
    // scoping the log to the statements before the second.
    const inserts = eng.log.map((e, i) => [e, i]).filter(([e, i]) => i >= t0 && e.ok && /^INSERT INTO tasks \(/.test(e.sql));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][0].sql).not.toMatch(/due_date/);
    expect(boundValue(t0, 'tasks', 'due_date')).toEqual({ present: true, value: '2026-09-20' });
    expect(eng.all('SELECT title, due_date FROM tasks ORDER BY title'))
      .toEqual([{ title: 'blank due', due_date: null }, { title: 'real due', due_date: '2026-09-20' }]);
    expect(r.res.apply_changeset.find((c) => c.entity_type === 'task' && c.after.title === 'blank due').after.due_date).toBeNull();
  });

  test('MUTANT: validate a task\'s "" due_date as a day and it is refused as malformed', async () => {
    const mut = mutate(
      "      if (t.due_date != null && t.due_date !== '') validateServiceTicketFieldValue('due_date', t.due_date, `${where}.due_date`);",
      "      if (t.due_date != null) validateServiceTicketFieldValue('due_date', t.due_date, `${where}.due_date`);");
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'a', due_date: '' }] } })], JOHN);
    expect([r.stage, r.detail.code, r.detail.field_path]).toEqual(['emit', 'wrong_type', 'service_ticket.ops.task_adds[0].due_date']);
  });

  test('MUTANT: write a task\'s "" due_date and a blank is BOUND into a DATE column', async () => {
    const mut = mutate(
      "    if (t.due_date != null && t.due_date !== '') { cols.push('due_date');",
      "    if (t.due_date != null) { cols.push('due_date');");
    const t0 = eng.log.length;
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'a', due_date: '' }] } })], JOHN);
    expect(r.stage).toBe('applied');                         // sqlite takes ''; a Postgres DATE refuses it
    expect(boundValue(t0, 'tasks', 'due_date')).toEqual({ present: true, value: '' });
  });

  test('MUTANT: without the task title bound, a 501-char title is written', async () => {
    const mut = mutate('      if (t.title.trim().length > TASKS_REST_TITLE_CAP) {', '      if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'T'.repeat(501) }] } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one('SELECT length(title) AS t FROM tasks').t).toBe(501);
  });

  test('MUTANT: without the task notes bound, 5001 chars of notes are written', async () => {
    const mut = mutate("      if (typeof t.notes === 'string' && t.notes.length > TASKS_REST_NOTES_CAP) {", '      if (false) {');
    const r = await drive(mut, [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' }, task_adds: [{ title: 'ok', notes: 'N'.repeat(5001) }] } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one('SELECT length(notes) AS n FROM tasks').n).toBe(5001);
  });

  // ── a child task's priority '' is the COLUMN DEFAULT, as the tasks REST door reads it ──
  const blankPriorityTask = () => [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' },
    task_adds: [{ title: 'blank priority', priority: '' }] } })];

  test('a child task priority "" is the column default: accepted, and no priority column is written', async () => {
    const t0 = eng.log.length;
    const r = await drive(REAL_MOD(), blankPriorityTask(), JOHN);
    expect(r.stage).toBe('applied');
    // tasks.priority is NOT NULL DEFAULT 'normal' in Postgres. Leaving the
    // column out IS storing the default; binding '' would store '' (or trip a
    // CHECK), and the test schema carries no default, so the bound statement is
    // what shows it.
    expect(boundValue(t0, 'tasks', 'priority')).toEqual({ present: false });
    expect(eng.all('SELECT title, priority FROM tasks')).toEqual([{ title: 'blank priority', priority: null }]);
    const ev = eng.all("SELECT detail FROM service_ticket_events WHERE kind = 'task_added'");
    expect(ev.map((e) => e.detail.fields)).toEqual([['title']]);
    // A real word is still written, and an unknown one still refused.
    seedInto(eng);
    const t1 = eng.log.length;
    const high = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' },
      task_adds: [{ title: 'high', priority: 'high' }] } })], JOHN);
    expect(high.stage).toBe('applied');
    expect(boundValue(t1, 'tasks', 'priority')).toEqual({ present: true, value: 'high' });
    const bad = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1' }, { ops: { fields: { title: 'x', job_id: 'j1' },
      task_adds: [{ title: 'bad', priority: 'critical' }] } })], JOHN);
    expect([bad.stage, bad.detail.code, bad.detail.field_path]).toEqual(['emit', 'invalid_enum', 'service_ticket.ops.task_adds[0].priority']);
  });

  test('MUTANT: validate a task\'s "" priority as a word and it is refused as an invalid enum', async () => {
    const mut = mutate(
      "      if (t.priority != null && t.priority !== '' && !TASK_PRIORITIES.has(t.priority)) {",
      '      if (t.priority != null && !TASK_PRIORITIES.has(t.priority)) {');
    const r = await drive(mut, blankPriorityTask(), JOHN);
    expect([r.stage, r.detail.code, r.detail.field_path]).toEqual(['emit', 'invalid_enum', 'service_ticket.ops.task_adds[0].priority']);
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
    expect(newTickets()).toHaveLength(0);
  });

  test('MUTANT: write a task\'s "" priority and a blank is BOUND over the column default', async () => {
    const mut = mutate(
      "    if (t.priority != null && t.priority !== '') { cols.push('priority');",
      "    if (t.priority != null) { cols.push('priority');");
    const t0 = eng.log.length;
    const r = await drive(mut, blankPriorityTask(), JOHN);
    expect(r.stage).toBe('applied');                         // sqlite takes ''; Postgres stores '' or trips the CHECK
    expect(boundValue(t0, 'tasks', 'priority')).toEqual({ present: true, value: '' });
  });

  // ── the TICKET's own title cap: 300 chars, measured trimmed, refused not cut ──
  test('a ticket title over 300 chars is refused at emit on create AND update, and nothing is written', async () => {
    expect(SOURCE).toMatch(/const SERVICE_TICKET_TITLE_CAP = 300;/);  // the bound the tests below are written against
    const long = 'T'.repeat(301);
    const c = await drive(REAL_MOD(), [ticket({ title: long, job_id: 'j1' })], JOHN);
    expect([c.stage, c.detail.code, c.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.fields.title']);
    expect(newTickets()).toHaveLength(0);

    const t0 = eng.log.length;
    const u = await drive(REAL_MOD(), [update('st_open', { fields: { title: long } })], JOHN);
    expect([u.stage, u.detail.code, u.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.fields.title']);
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
    expect(eng.count('SELECT 1 FROM service_ticket_events')).toBe(0);
    expect(eng.log.slice(t0).filter((e) => /^(INSERT|UPDATE)\b/.test(e.sql))).toHaveLength(0);
  });

  test('a ticket title is measured TRIMMED: 300 chars inside whitespace applies and stores exactly 300, on create and update', async () => {
    const padded = '  ' + 'T'.repeat(300) + '  ';
    expect(padded.length).toBe(304);                         // the premise: over the cap raw, at it trimmed
    const c = await drive(REAL_MOD(), [ticket({ title: padded, job_id: 'j1' })], JOHN);
    expect(c.stage).toBe('applied');
    expect(newTickets().map((t) => t.title)).toEqual(['T'.repeat(300)]);

    const u = await drive(REAL_MOD(), [update('st_open', { fields: { title: padded } })], JOHN);
    expect(u.stage).toBe('applied');
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('T'.repeat(300));
  });

  test('MUTANT: without the ticket title cap, a 301-char title is written on create and update', async () => {
    const mut = mutate('      if (v.trim().length > SERVICE_TICKET_TITLE_CAP) {', '      if (false) {');
    const long = 'T'.repeat(301);
    const c = await drive(mut, [ticket({ title: long, job_id: 'j1' })], JOHN);
    expect(c.stage).toBe('applied');
    expect(newTickets().map((t) => t.title.length)).toEqual([301]);
    const u = await drive(mut, [update('st_open', { fields: { title: long } })], JOHN);
    expect(u.stage).toBe('applied');
    expect(one("SELECT length(title) AS n FROM service_tickets WHERE id='st_open'").n).toBe(301);
  });

  test('MUTANT: measure the ticket title RAW and 300 chars inside whitespace are refused', async () => {
    const mut = mutate('      if (v.trim().length > SERVICE_TICKET_TITLE_CAP) {', '      if (v.length > SERVICE_TICKET_TITLE_CAP) {');
    const padded = '  ' + 'T'.repeat(300) + '  ';
    const c = await drive(mut, [ticket({ title: padded, job_id: 'j1' })], JOHN);
    expect([c.stage, c.detail.code, c.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.fields.title']);
    expect(newTickets()).toHaveLength(0);
    const u = await drive(mut, [update('st_open', { fields: { title: padded } })], JOHN);
    expect([u.stage, u.detail.code, u.detail.field_path]).toEqual(['emit', 'too_long', 'service_ticket.ops.fields.title']);
    expect(one("SELECT title FROM service_tickets WHERE id='st_open'").title).toBe('Leak at unit 4');
  });

  test('a create with a concrete entity_id is refused — it is an update that forgot op:"update"', async () => {
    const t = [{ entity_type: 'service_ticket', entity_id: 'st_open', ops: { fields: { title: 'Leak at unit 4 (revised)', job_id: 'j1' } } }];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.field_path]).toEqual(['emit', 'entity_id']);
    const mut = mutate("  if (op === 'create' && hasId && !isRef(entityId)) {", '  if (false) {');
    expect((await drive(mut, t, JOHN)).stage).toBe('applied');
    expect(newTickets()).toHaveLength(1);                   // a DUPLICATE work order, not an edit
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * UPDATE — the ticket's own state
 * ══════════════════════════════════════════════════════════════════════════*/
describe('update', () => {
  test('writes the named fields, logs names, diffs before/after', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', { fields: { scope_proposed: 'New scope: replace the flashing', site_contact_name: 'Dana' } })], JOHN);
    expect(r.stage).toBe('applied');
    const row = one("SELECT * FROM service_tickets WHERE id='st_open'");
    expect([row.scope_proposed, row.site_contact_name]).toEqual(['New scope: replace the flashing', 'Dana']);
    const cs = r.res.apply_changeset[0];
    expect([cs.entity_type, cs.id, cs.before.scope_proposed, cs.after.scope_proposed])
      .toEqual(['service_ticket', 'st_open', 'Old scope text', 'New scope: replace the flashing']);
    expect(r.res.apply_summary).toBe('Updated service ticket "Leak at unit 4"');
    const ev = one("SELECT * FROM service_ticket_events WHERE ticket_id='st_open'");
    expect([ev.kind, ev.actor_kind, ev.detail]).toEqual(['field_changed', 'agent', { fields: ['scope_proposed', 'site_contact_name'] }]);
  });

  test('a CLOSED ticket is refused, non-retryably, and nothing changes', async () => {
    const r = await drive(REAL_MOD(), [update('st_closed', { fields: { title: 'reopen by stealth' } })], JOHN);
    expect([r.stage, r.detail.code, r.detail.retryable]).toEqual(['apply', 'ticket_terminal', false]);
    expect(one("SELECT title FROM service_tickets WHERE id='st_closed'").title).toBe('Finished gutters');
    expect(eng.count('SELECT 1 FROM service_ticket_events')).toBe(0);
  });

  test('MUTANT: without the terminal check, a closed work order is rewritten', async () => {
    const mut = mutate('    if (ticketRules.isTerminal(before.status)) {', '    if (false) {');
    const r = await drive(mut, [update('st_closed', { fields: { title: 'reopen by stealth' } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT title FROM service_tickets WHERE id='st_closed'").title).toBe('reopen by stealth');
  });

  test('MUTANT: without the non-retryable marker, the closed-ticket refusal invites a re-emit', async () => {
    const mut = mutate(
      '  return new PayloadValidationError(message, Object.assign({ retryable: false }, detail));',
      '  return new PayloadValidationError(message, Object.assign({}, detail));');
    const r = await drive(mut, [update('st_closed', { fields: { title: 'x' } })], JOHN);
    expect(r.detail.code).toBe('ticket_terminal');
    expect(r.detail.retryable).toBeUndefined();
  });

  test('re-parenting is refused non-retryably, for job_id and lead_id alike', async () => {
    for (const f of [{ job_id: 'j2' }, { lead_id: 'l1' }]) {
      const r = await drive(REAL_MOD(), [update('st_open', { fields: f })], JOHN);
      expect([r.stage, r.detail.code, r.detail.retryable]).toEqual(['emit', 'reparent_refused', false]);
    }
    expect(one("SELECT job_id FROM service_tickets WHERE id='st_open'").job_id).toBe('j1');
  });

  test('MUTANT: without the re-parent refusal, the job_id is dropped and the update still reports success', async () => {
    const mut = mutate("    if (op === 'update' && (k === 'job_id' || k === 'lead_id')) {", '    if (false) {');
    const r = await drive(mut, [update('st_open', { fields: { job_id: 'j2', title: 'moved?' } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT job_id, title FROM service_tickets WHERE id='st_open'")).toEqual({ job_id: 'j1', title: 'moved?' });
  });

  test('another tenant\'s ticket reads exactly like one that does not exist', async () => {
    const foreign = await drive(REAL_MOD(), [update('st_foreign', { fields: { title: 'x' } })], JOHN);
    const absent = await drive(REAL_MOD(), [update('st_nope', { fields: { title: 'x' } })], JOHN);
    expect([foreign.detail.code, foreign.detail.retryable]).toEqual(['not_found', false]);
    expect(foreign.message).toBe(absent.message);
    expect(one("SELECT title FROM service_tickets WHERE id='st_foreign'").title).toBe('Rival ticket');
  });

  test('MUTANT: drop the tenant predicate from the load and org 1 files tasks under org 2\'s work order', async () => {
    const mut = mutate(
      " FROM service_tickets WHERE id = $1 AND organization_id = $2' +",
      " FROM service_tickets WHERE id = $1 AND $2 IS NOT NULL' +");
    const r = await drive(mut, [update('st_foreign', { task_adds: [{ title: 'planted' }] })], JOHN);
    expect(r.stage).toBe('applied');
    const planted = one("SELECT * FROM tasks WHERE title = 'planted'");
    expect([planted.service_ticket_id, planted.organization_id, planted.entity_id]).toEqual(['st_foreign', 1, 'j9']);
  });

  test('the UPDATE carries its own predicate and its own zero-row refusal — both halves, removed in turn', async () => {
    // With only the load predicate gone, the UPDATE's own tenant predicate
    // matches nothing and the zero-row check refuses the write out loud.
    const loadOnly = mutate(
      " FROM service_tickets WHERE id = $1 AND organization_id = $2' +",
      " FROM service_tickets WHERE id = $1 AND $2 IS NOT NULL' +");
    const loud = await drive(loadOnly, [update('st_foreign', { fields: { title: 'x' } })], JOHN);
    expect(loud.stage).toBe('apply');
    expect(loud.message).toMatch(/matched no row/);
    // Remove the zero-row check as well and the same write REPORTS SUCCESS
    // having written nothing — the receipt lies.
    const quiet = mutatePairs([
      [" FROM service_tickets WHERE id = $1 AND organization_id = $2' +",
        " FROM service_tickets WHERE id = $1 AND $2 IS NOT NULL' +"],
      ["      if (!upd.rowCount) throw new Error('service_ticket update matched no row. Nothing was saved.');",
        '      // MUTANT: no zero-row check'],
    ]);
    const lie = await drive(quiet, [update('st_foreign', { fields: { title: 'x' } })], JOHN);
    expect(lie.stage).toBe('applied');
    expect(lie.res.apply_summary).toMatch(/^Updated service ticket/);
    expect(one("SELECT title FROM service_tickets WHERE id='st_foreign'").title).toBe('Rival ticket');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * CHILD TASKS — under the ticket AND on its parent
 * ══════════════════════════════════════════════════════════════════════════*/
describe('task_adds', () => {
  test('each task carries the ticket id AND the ticket\'s parent entity, scope org, stamped org and creator', async () => {
    const r = await drive(REAL_MOD(), [ticket({ title: 'Punch list', job_id: 'j1' }, {
      ops: { fields: { title: 'Punch list', job_id: 'j1' },
        task_adds: [{ title: 'Caulk tub', due_date: '2026-09-20', priority: 'high' }, { title: 'Touch-up paint', notes: 'two coats' }] } })], JOHN);
    expect(r.stage).toBe('applied');
    const id = newTickets()[0].id;
    const tasks = eng.all('SELECT * FROM tasks ORDER BY title');
    // assignee_user_id is NULL on BOTH, always (1.35): a building is never
    // assigned, so the column is not even in the INSERT.
    expect(tasks.map((t) => [t.title, t.entity_type, t.entity_id, t.service_ticket_id, t.scope, t.organization_id, t.created_by, t.assignee_user_id]))
      .toEqual([
        ['Caulk tub', 'job', 'j1', id, 'org', 1, 10, null],
        ['Touch-up paint', 'job', 'j1', id, 'org', 1, 10, null],
      ]);
    expect(tasks.find((t) => t.title === 'Caulk tub').due_date).toBe('2026-09-20');

    // The receipt: one ticket line, children counted — never listed by raw id.
    expect(r.res.apply_summary).toBe('Created service ticket "Punch list" with 2 tasks');
    // Both client refresh doors see the children.
    expect(r.res.affected_targets.map((t) => t.entity_type)).toEqual(['service_ticket', 'task', 'task']);
    expect(r.res.apply_changeset.map((c) => c.entity_type)).toEqual(['service_ticket', 'task', 'task']);
    expect(isRenderableChangeset(r.res.apply_changeset)).toBe(true);
    expect(eng.all("SELECT kind FROM service_ticket_events WHERE ticket_id = ? ORDER BY kind", id).map((e) => e.kind))
      .toEqual(['created', 'task_added', 'task_added']);
  });

  test('on a lead-parented ticket the tasks hang on the lead', async () => {
    const r = await drive(REAL_MOD(), [update('st_lead', { task_adds: [{ title: 'Measure' }] })], LENA);
    expect(r.stage).toBe('applied');
    const t = one('SELECT * FROM tasks');
    expect([t.entity_type, t.entity_id, t.service_ticket_id]).toEqual(['lead', 'l1', 'st_lead']);
    expect(r.res.apply_summary).toBe('Updated service ticket "Survey the roof" and added 1 task');
  });

  test('MUTANT: stamp entity_type service_ticket and the task vanishes from its job', async () => {
    const mut = mutate(
      "    const vals = [taskId, orgId, userId, 'org', t.title.trim(), parentType, parentId, ticketId];",
      "    const vals = [taskId, orgId, userId, 'org', t.title.trim(), 'service_ticket', ticketId, ticketId];");
    await drive(mut, [update('st_open', { task_adds: [{ title: 'Orphan' }] })], JOHN);
    expect(eng.count("SELECT 1 FROM tasks WHERE entity_type = 'job' AND entity_id = 'j1'")).toBe(0);
    seedInto(eng);
    await drive(REAL_MOD(), [update('st_open', { task_adds: [{ title: 'Orphan' }] })], JOHN);
    expect(eng.count("SELECT 1 FROM tasks WHERE entity_type = 'job' AND entity_id = 'j1'")).toBe(1);
  });

  test('MUTANT: drop the child push and the inline Approve door never refreshes the task surfaces', async () => {
    const mut = mutate(
      '  if (result && Array.isArray(result.child_targets)) {\n' +
      '    for (const child of result.child_targets) results.push(child);\n' +
      '  }',
      '  // MUTANT: children not surfaced');
    const r = await drive(mut, [update('st_open', { task_adds: [{ title: 'a' }] })], JOHN);
    expect(r.res.affected_targets.map((t) => t.entity_type)).toEqual(['service_ticket']);
  });

  test('MUTANT: drop the rolled_up filter and the push-notification text prints raw task ids', async () => {
    const mut = mutate('    .filter((t) => !(t && t.rolled_up))\n', '');
    const r = await drive(mut, [update('st_open', { task_adds: [{ title: 'a' }] })], JOHN);
    expect(r.res.apply_summary).toMatch(/; task task_\S+ \(create\)/);
  });

  /* ── 1.35: 86 CANNOT ASSIGN A BUILDING EITHER ───────────────────────────
   *
   * The owner: "i dont want assignments to individual buildings like that,
   * whoever is assigned to the ticket, task or work order is evenly
   * responsible." The REST doors refuse it; so must the door the Scribe
   * writes through, or the rule has a back entrance with a model behind it.
   */
  test('the refusal is BY NAME, never the unknown-key answer — the model must not try a spelling variant', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', { task_adds: [{ title: 'a', assignee_user_id: 11 }] })], JOHN);
    expect(r.detail.code).toBe('building_not_assignable');
    expect(r.detail.code).not.toBe('unknown_field');
    expect(r.message).not.toMatch(/unknown key/i);
    // A key that really IS a typo still gets the unknown-key answer, so the
    // two are told apart rather than merged.
    const typo = await drive(REAL_MOD(), [update('st_open', { task_adds: [{ title: 'a', assinee: 11 }] })], JOHN);
    expect(typo.detail.code).toBe('unknown_field');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
  });

  test('the whole payload is refused: a good task beside a bad one writes nothing', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', {
      task_adds: [{ title: 'fine' }, { title: 'bad', assignee_user_id: 11 }] })], JOHN);
    expect(r.detail.field_path).toBe('service_ticket.ops.task_adds[1].assignee_user_id');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
    expect(eng.count("SELECT 1 FROM service_ticket_events WHERE kind = 'task_added'")).toBe(0);
  });

  test('MUTANT: put the key back in the read set and 86 mints an assigned building', async () => {
    const mut = mutatePairs([
      ["const SERVICE_TICKET_TASK_KEYS = new Set(['title', 'notes', 'priority', 'due_date']);",
        "const SERVICE_TICKET_TASK_KEYS = new Set(['title', 'notes', 'priority', 'due_date', 'assignee_user_id']);"],
      ['const SERVICE_TICKET_TASK_REFUSED_KEYS = {\n  assignee_user_id: subtaskDoor.MSG.notAssignable,\n};',
        'const SERVICE_TICKET_TASK_REFUSED_KEYS = {};'],
      ["    if (t.due_date != null && t.due_date !== '') { cols.push('due_date'); vals.push(String(t.due_date).trim()); names.push('due_date'); }",
        "    if (t.due_date != null && t.due_date !== '') { cols.push('due_date'); vals.push(String(t.due_date).trim()); names.push('due_date'); }\n" +
        "    if (t.assignee_user_id != null) { cols.push('assignee_user_id'); vals.push(Number(t.assignee_user_id)); names.push('assignee_user_id'); }"],
    ]);
    const r = await drive(mut, [update('st_open', { task_adds: [{ title: 'Touch-up paint', assignee_user_id: 11 }] })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one('SELECT assignee_user_id FROM tasks').assignee_user_id).toBe(11);
    // The shipped dispatcher refuses the same payload and writes no row.
    seedInto(eng);
    expect((await drive(REAL_MOD(), [update('st_open', { task_adds: [{ title: 'Touch-up paint', assignee_user_id: 11 }] })], JOHN)).detail.code)
      .toBe('building_not_assignable');
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
  });

  test('a task payload cannot mint a building at all: fields.service_ticket_id is refused by name', async () => {
    // dispatchTask always stamps an assignee_user_id, so a task target that
    // could carry a service_ticket_id would be a second way to make an
    // assigned building. The key is not in TASK_FIELDS and is refused by name.
    for (const kind of ['task', 'todo']) {
      const r = await drive(REAL_MOD(), [{ entity_type: kind, ops: { op: 'create',
        fields: { title: 'Bldg 4', service_ticket_id: 'st_open' } } }], JOHN);
      expect([r.stage, r.detail.code, r.detail.retryable])
        .toEqual(['emit', 'building_not_assignable', false]);
      expect(r.detail.field_path).toBe(kind + '.ops.fields.service_ticket_id');
      expect(r.message).toContain('service_ticket.ops.task_adds');
    }
    expect(eng.count('SELECT 1 FROM tasks')).toBe(0);
  });

  test('CONTROL: an ordinary task target is still created, assigned, exactly as before', async () => {
    const r = await drive(REAL_MOD(), [{ entity_type: 'task', ops: { op: 'create',
      fields: { title: 'Order the trim', assignee_user_id: 11 } } }], JOHN);
    expect(r.stage).toBe('applied');
    const t = one('SELECT * FROM tasks');
    expect([t.title, t.assignee_user_id, t.service_ticket_id]).toEqual(['Order the trim', 11, null]);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WHAT A DRY RUN LEAVES, WHAT THE LOG HOLDS, WHAT THE LOCK SCREEN SAYS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('dry run, event detail, summary', () => {
  const RICH = [ticket({ title: 'Water damage', job_id: 'j1', scope_proposed: 'SECRET-SCOPE tear out drywall',
    internal_notes: 'SECRET-NOTE owner is litigious', site_contact_phone: '813-555-0142',
    street_address: '12 Hidden Lane', access_notes: 'SECRET-GATE 4417' }, {
    ops: { fields: { title: 'Water damage', job_id: 'j1', scope_proposed: 'SECRET-SCOPE tear out drywall',
      internal_notes: 'SECRET-NOTE owner is litigious', site_contact_phone: '813-555-0142',
      street_address: '12 Hidden Lane', access_notes: 'SECRET-GATE 4417' },
    task_adds: [{ title: 'Moisture readings', notes: 'SECRET-TASKNOTE bring the meter' }] } })];
  const VALUES = ['SECRET-SCOPE', 'SECRET-NOTE', '813-555-0142', 'Hidden Lane', 'SECRET-GATE', 'SECRET-TASKNOTE'];

  test('a dry run writes NOTHING and still returns the renderable diff', async () => {
    const before = ['service_tickets', 'service_ticket_events', 'tasks'].map((t) => eng.count('SELECT 1 FROM ' + t));
    const r = await drive(REAL_MOD(), RICH, JOHN, { dryRun: true });
    expect(r.stage).toBe('applied');
    expect(r.res.dry_run).toBe(true);
    expect(isRenderableChangeset(r.res.apply_changeset)).toBe(true);
    expect(['service_tickets', 'service_ticket_events', 'tasks'].map((t) => eng.count('SELECT 1 FROM ' + t))).toEqual(before);
  });

  test('TWO ENGINES — MUTANT: log the event on the module pool and a preview leaves a timeline row behind', async () => {
    require('../server/db').pool.query = engB.pool.query;
    const mut = mutate(
      'async function insertTicketEvent(dbClient, orgId, ticketId, kind, actorUserId, detail) {\n  await dbClient.query(',
      'async function insertTicketEvent(dbClient, orgId, ticketId, kind, actorUserId, detail) {\n  await pool.query(');
    const r = await drive(mut, RICH, JOHN, { dryRun: true });
    expect(r.stage).toBe('applied');
    expect(engB.count("SELECT 1 FROM service_ticket_events WHERE kind = 'created'")).toBe(1);   // an event for a ticket that was never saved

    seedInto(eng); seedInto(engB);
    await drive(REAL_MOD(), RICH, JOHN, { dryRun: true });
    expect(engB.count('SELECT 1 FROM service_ticket_events')).toBe(0);
    expect(eng.count('SELECT 1 FROM service_ticket_events')).toBe(0);
  });

  test('every event detail holds field NAMES, never a value that was typed into the ticket', async () => {
    await drive(REAL_MOD(), RICH, JOHN);
    await drive(REAL_MOD(), [update('st_open', { fields: { internal_notes: 'SECRET-NOTE again', site_contact_phone: '813-555-0142' } })], JOHN);
    const details = eng.all('SELECT detail FROM service_ticket_events').map((e) => JSON.stringify(e.detail));
    expect(details.length).toBe(3);
    for (const d of details) for (const v of VALUES) expect(d).not.toContain(v);
    const created = eng.all("SELECT detail FROM service_ticket_events WHERE kind = 'created'")[0].detail;
    expect(created.fields).toEqual(['access_notes', 'internal_notes', 'site_contact_phone', 'street_address', 'scope_proposed', 'title'].sort());
  });

  test('MUTANT: put values in the detail and the log test goes red', async () => {
    const mut = mutate(
      "      { parent: parent.job_id ? 'job' : 'lead', fields: written.slice().sort() });",
      "      { parent: parent.job_id ? 'job' : 'lead', fields: written.slice().sort(), values: fields });");
    await drive(mut, RICH, JOHN);
    const d = JSON.stringify(eng.all("SELECT detail FROM service_ticket_events WHERE kind = 'created'")[0].detail);
    expect(VALUES.some((v) => d.indexOf(v) !== -1)).toBe(true);
  });

  test('the summary is the title and the task count — no scope, notes, phone or address', async () => {
    const r = await drive(REAL_MOD(), RICH, JOHN);
    expect(r.res.apply_summary).toBe('Created service ticket "Water damage" with 1 task');
    for (const t of r.res.affected_targets) {
      for (const v of VALUES) expect(JSON.stringify(t.summary || '')).not.toContain(v);
    }
  });

  test('the UPDATE summary is the title and nothing typed into the edit', async () => {
    const t = [update('st_open', { fields: { scope_proposed: 'SECRET-SCOPE tear out drywall',
      internal_notes: 'SECRET-NOTE owner is litigious', site_contact_phone: '813-555-0142' } })];
    const r = await drive(REAL_MOD(), t, JOHN);
    expect(r.stage).toBe('applied');
    expect(r.res.apply_summary).toBe('Updated service ticket "Leak at unit 4"');

    seedInto(eng);
    const mut = mutate(
      '      : `Updated service ticket "${title}"` + (n ? ` and added ${tasksBit}` : \'\'),',
      '      : `Updated service ticket "${title}" (${after.site_contact_phone})` + (n ? ` and added ${tasksBit}` : \'\'),');
    const m = await drive(mut, t, JOHN);
    expect(m.res.apply_summary).not.toBe('Updated service ticket "Leak at unit 4"');
    expect(m.res.apply_summary).toContain('813-555-0142');
  });

  test('MUTANT: add the scope to the summary and the lock-screen test goes red', async () => {
    const mut = mutate(
      '      ? `Created service ticket "${title}"` + (n ? ` with ${tasksBit}` : \'\')',
      '      ? `Created service ticket "${title}" — ${after.scope_proposed}` + (n ? ` with ${tasksBit}` : \'\')');
    const r = await drive(mut, RICH, JOHN);
    expect(r.res.apply_summary).toContain('SECRET-SCOPE');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * DATE COLUMNS IN THE CHANGESET — a calendar day, in any server zone
 * ══════════════════════════════════════════════════════════════════════════*/
describe('changeset snapshots carry DATE columns as calendar days', () => {
  // node-pg parses a DATE (oid 1082) into a Date at LOCAL midnight — the
  // postgres-date parser is `new Date(year, month, day)`. The sqlite engine
  // hands back text, so on its own it cannot show the bug. The child's client
  // does what node-pg does to the two DATE columns these snapshots read, so the
  // dispatcher sees the object it sees in production.
  //
  // ── WHY A CHILD PROCESS, IN TOKYO ─────────────────────────────────────────
  // These tests used to run in the jest worker, whose zone is the host's and is
  // fixed at start (jest hands the test a sandboxed process.env; assigning TZ
  // there changes nothing). Local midnight at or WEST of Greenwich is on the
  // same UTC day, so a formatter that read the getUTC* getters produced the
  // right day on this Eastern machine and on a UTC CI box alike — the positive
  // tests were green for a wrong formatter everywhere they were ever run. EAST
  // of Greenwich local midnight is the PREVIOUS UTC day, and only there does
  // that formatter show itself. So every drive below runs in a child node
  // started with TZ set: Asia/Tokyo (+9, no DST) to catch it, Pacific/Honolulu
  // (-10, no DST) to show the real formatter is right west of UTC too — and
  // that a west zone alone cannot see the getUTC* mutant. Each child reports
  // the zone it resolved and what a local-midnight Date does there, so a
  // platform that ignored TZ fails the premise out loud instead of passing.
  const { execFileSync } = require('child_process');
  const T = [ticket({ title: 'Dated', job_id: 'j1' }, {
    ops: { fields: { title: 'Dated', job_id: 'j1', scheduled_for: '2026-09-15', due_date: '2026-09-18' },
      task_adds: [{ title: 'Dated task', due_date: '2026-09-20' }] } })];
  const U = [update('st_open', { fields: { due_date: '2026-09-25' } })];
  const MARK = '@@P86_DATES@@';

  // Runs in the CHILD: its own engine and seed, the node-pg-shaped client, the
  // create T and then — with st_open due 2026-09-18 — the update U, through
  // validateTarget and applyPayload exactly as drive() runs them.
  function dateChild() {
    const input = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    const probe = new Date(2026, 8, 15);
    const out = {
      zone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      premise: { localDay: probe.getDate(), utcDay: probe.getUTCDate() },
    };
    const finish = (o) => { process.stdout.write('\n' + input.mark + JSON.stringify(o)); };   // no force-exit: the child holds no handle and ends on its own
    (async () => {
      process.env.JWT_SECRET = input.jwt;
      const { createPgSqlite } = require(input.paths.pgSqlite);
      const { sqliteSchema } = require(input.paths.dbSchema);
      const e = createPgSqlite(sqliteSchema(input.tables), { jsonColumns: ['detail', 'capabilities'] });
      e.db.function('hashtext', (s) => { let h = 0; const t = String(s); for (let i = 0; i < t.length; i++) h = (h * 31 + t.charCodeAt(i)) | 0; return h; });
      e.db.function('pg_advisory_xact_lock', (_k) => 1);   // arity is read from the JS signature
      e.db.exec(input.seed);
      const pgDay = (v) => {
        const m = typeof v === 'string' && /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
        return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : v;
      };
      const shaped = (q) => async (sql, params) => {
        const r = await q(sql, params);
        for (const row of r.rows || []) {
          for (const k of ['scheduled_for', 'due_date']) if (k in row) row[k] = pgDay(row[k]);
        }
        return r;
      };
      const db = require(input.paths.db);
      db.pool.query = shaped(e.pool.query);
      db.pool.connect = async () => {
        const c = await e.pool.connect();
        return { query: shaped(c.query), release: () => c.release() };
      };
      const auth = require(input.paths.auth);
      auth.setRolePool(e.pool);
      await auth.refreshRoleCache();
      const mod = require(input.dispatcher);
      const ctx = { userId: 10, organizationId: 1 };
      const apply = async (targets) => {
        targets.forEach((t, i) => mod.validateTarget(JSON.parse(JSON.stringify(t)), i));
        const res = await mod.applyPayload({ id: 'pl_tz', targets: JSON.parse(JSON.stringify(targets)) }, ctx);
        return JSON.parse(JSON.stringify(res.apply_changeset));
      };
      out.create = await apply(input.create);
      e.db.exec("UPDATE service_tickets SET due_date = '2026-09-18' WHERE id = 'st_open'");
      const d = (await db.pool.query("SELECT due_date FROM service_tickets WHERE id = 'st_open'")).rows[0].due_date;
      out.premise.rawIsDate = Object.prototype.toString.call(d) === '[object Date]';
      out.premise.rawSerialized = JSON.parse(JSON.stringify({ d })).d;
      out.update = await apply(input.update);
      finish(out);
    })().catch((err) => finish(Object.assign(out, { error: String((err && err.stack) || err) })));
  }

  function datesInZone(tz, dispatcherPath) {
    const stdout = execFileSync(process.execPath, ['-e', '(' + dateChild.toString() + ')()'], {
      input: JSON.stringify({
        mark: MARK, jwt: process.env.JWT_SECRET, tables: TABLES, seed: seedSql(),
        dispatcher: dispatcherPath, create: T, update: U,
        paths: {
          pgSqlite: path.join(__dirname, 'helpers', 'pg-sqlite'),
          dbSchema: path.join(__dirname, 'helpers', 'db-schema'),
          db: path.join(SERVER, 'db'),
          auth: path.join(SERVER, 'auth'),
        },
      }),
      env: Object.assign({}, process.env, { TZ: tz }),
      encoding: 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 90000,
    });
    const at = stdout.lastIndexOf(MARK);
    if (at === -1) throw new Error('date child in ' + tz + ' printed no result:\n' + stdout.slice(-2000));
    const out = JSON.parse(stdout.slice(at + MARK.length));
    if (out.error) throw new Error('date child in ' + tz + ' failed:\n' + out.error);
    return out;
  }
  const realRuns = {};
  const realIn = (tz) => (realRuns[tz] = realRuns[tz] || datesInZone(tz, REAL));
  const SLOW = 180000;

  test('the premise, per zone: the child resolved it, a node-pg DATE is a Date there, and serialized it is NOT the day', () => {
    const tokyo = realIn('Asia/Tokyo');
    expect(tokyo.zone).toBe('Asia/Tokyo');
    // East of Greenwich: local midnight of the 15th is the 14th in UTC.
    expect(tokyo.premise).toEqual({ localDay: 15, utcDay: 14, rawIsDate: true, rawSerialized: '2026-09-17T15:00:00.000Z' });
    const hnl = realIn('Pacific/Honolulu');
    expect(hnl.zone).toBe('Pacific/Honolulu');
    // West of it: the same UTC day — the zone where a getUTC* formatter hides.
    expect(hnl.premise).toEqual({ localDay: 15, utcDay: 15, rawIsDate: true, rawSerialized: '2026-09-18T10:00:00.000Z' });
  }, SLOW);

  test('create and update: ticket and task snapshots are days, east AND west of Greenwich', () => {
    for (const tz of ['Asia/Tokyo', 'Pacific/Honolulu']) {
      const out = realIn(tz);
      expect([tz, out.create[0].entity_type, out.create[0].after.scheduled_for, out.create[0].after.due_date])
        .toEqual([tz, 'service_ticket', '2026-09-15', '2026-09-18']);
      expect([tz, out.create[1].entity_type, out.create[1].after.due_date]).toEqual([tz, 'task', '2026-09-20']);
      expect([tz, out.update[0].before.due_date, out.update[0].after.due_date]).toEqual([tz, '2026-09-18', '2026-09-25']);
    }
  }, SLOW);

  test('MUTANT: format with the getUTC* getters and Tokyo shows the day BEFORE — Honolulu cannot see it', () => {
    const p = writeMutant([[
      "      row[c] = String(v.getFullYear()).padStart(4, '0') + '-' +\n" +
      "        String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');",
      "      row[c] = String(v.getUTCFullYear()).padStart(4, '0') + '-' +\n" +
      "        String(v.getUTCMonth() + 1).padStart(2, '0') + '-' + String(v.getUTCDate()).padStart(2, '0');",
    ]]);
    const tokyo = datesInZone('Asia/Tokyo', p);
    expect([tokyo.create[0].after.scheduled_for, tokyo.create[0].after.due_date, tokyo.create[1].after.due_date])
      .toEqual(['2026-09-14', '2026-09-17', '2026-09-19']);
    expect([tokyo.update[0].before.due_date, tokyo.update[0].after.due_date]).toEqual(['2026-09-17', '2026-09-24']);
    // The same mutant, west of Greenwich, is indistinguishable from the fix —
    // which is the whole reason the zone is forced.
    const hnl = datesInZone('Pacific/Honolulu', p);
    expect([hnl.create[0].after.scheduled_for, hnl.create[1].after.due_date, hnl.update[0].before.due_date])
      .toEqual(['2026-09-15', '2026-09-20', '2026-09-18']);
  }, SLOW);

  test('MUTANT: return the ticket row unformatted and the diff shows an instant', () => {
    const p = writeMutant([[
      '  return calendarDaysOf(r.rows[0] || null, TICKET_DATE_COLS);',
      '  return r.rows[0] || null;']]);
    const out = datesInZone('Asia/Tokyo', p);
    expect([out.create[0].after.scheduled_for, out.update[0].before.due_date])
      .toEqual(['2026-09-14T15:00:00.000Z', '2026-09-17T15:00:00.000Z']);
    expect(out.create[1].after.due_date).toBe('2026-09-20');      // the task site is separate, and still right
  }, SLOW);

  test('MUTANT: take the task snapshot unformatted and the task diff shows an instant', () => {
    const p = writeMutant([[
      '      [taskId, orgId])).rows[0] || null, TASK_DATE_COLS);',
      '      [taskId, orgId])).rows[0] || null, []);']]);
    const out = datesInZone('Asia/Tokyo', p);
    expect(out.create[1].after.due_date).toBe('2026-09-19T15:00:00.000Z');
    expect(out.create[0].after.scheduled_for).toBe('2026-09-15');
  }, SLOW);
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE DISPATCHER, DRIVEN DIRECTLY — it must not trust that validateTarget ran
 * ══════════════════════════════════════════════════════════════════════════*/
describe('dispatchServiceTicket on its own', () => {
  async function direct(mod, target, ctx) {
    const client = await eng.pool.connect();
    const t0 = eng.log.length;
    try {
      const res = await mod.internals.dispatchServiceTicket(client, clone(target), Object.create(null), ctx);
      return { stage: 'applied', res, statements: eng.log.length - t0 };
    } catch (e) {
      return { stage: 'apply', message: e.message, detail: e.detail || {}, statements: eng.log.length - t0 };
    }
  }

  test('no org or no user: refused before a single statement runs', async () => {
    for (const ctx of [{ userId: 10, organizationId: null }, { userId: null, organizationId: 1 }, null]) {
      const r = await direct(REAL_MOD(), ticket({ title: 'x', job_id: 'j1' }), ctx);
      expect([r.stage, r.detail.code, r.detail.retryable, r.statements]).toEqual(['apply', 'no_context', false, 0]);
    }
  });

  test('MUTANT: without the context refusal, the org-less write reaches the database', async () => {
    const mut = mutate('  if (!orgId || !userId) {\n    throw ticketRefusal(', '  if (false) {\n    throw ticketRefusal(');
    const r = await direct(mut, ticket({ title: 'x', job_id: 'j1' }), { userId: 10, organizationId: null });
    expect(r.statements).toBeGreaterThan(0);
  });

  test('the grammar is re-checked: status on a direct create is refused, not dropped', async () => {
    const t = ticket({ title: 'x', job_id: 'j1', status: 'closed' });
    const r = await direct(REAL_MOD(), t, JOHN);
    expect([r.stage, r.detail.code]).toEqual(['apply', 'blocked_field']);
    const mut = mutate(
      '  validateServiceTicketOps(ops);\n  checkServiceTicketAddress(target.entity_id, ops, \'entity_id\');',
      '  // MUTANT: trust validateTarget');
    const m = await direct(mut, t, JOHN);
    expect(m.stage).toBe('applied');                        // created, with the status silently ignored
  });
});

describe('materials — a takeoff 86 can draft, with no price on it', () => {
  test('a list is stored as the normalized JSON the work order renders', async () => {
    const t0 = eng.log.length;
    const r = await drive(REAL_MOD(), [ticket({
      title: 'Stair repairs', job_id: 'j1',
      materials: [{ description: '2x12 PT stringer', qty: 6, unit: 'ea' }, { description: 'Tread screws' }],
    })], JOHN);
    expect(r.stage).toBe('applied');
    const bound = boundValue(t0, 'service_tickets', 'materials');
    expect(bound.present).toBe(true);
    expect(JSON.parse(bound.value)).toEqual([
      { description: '2x12 PT stringer', qty: '6', unit: 'ea' },
      { description: 'Tread screws', qty: '', unit: '' },
    ]);
  });

  test('a price key is refused BY NAME at emit, and nothing is written', async () => {
    const r = await drive(REAL_MOD(), [ticket({
      title: 'Stair repairs', job_id: 'j1',
      materials: [{ description: '2x12 PT stringer', qty: 6, unit: 'ea', unit_cost: 41.5 }],
    })], JOHN);
    expect([r.stage, r.detail.code, r.detail.received]).toEqual(['emit', 'unknown_field', ['unit_cost']]);
    expect(r.message).toMatch(/no prices or costs/);
    expect(newTickets()).toHaveLength(0);
  });

  test('not an array, a nameless line, and an empty list that clears', async () => {
    const notArr = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', materials: '6 stringers' })], JOHN);
    expect([notArr.stage, notArr.detail.code]).toEqual(['emit', 'wrong_type']);
    const nameless = await drive(REAL_MOD(), [ticket({ title: 'x', job_id: 'j1', materials: [{ qty: 2 }] })], JOHN);
    expect([nameless.stage, nameless.detail.code]).toEqual(['emit', 'missing_field']);
    const t0 = eng.log.length;
    const cleared = await drive(REAL_MOD(), [update('st_open', { fields: { materials: [] } })], JOHN);
    expect(cleared.stage).toBe('applied');
    expect(boundValue(t0, 'service_tickets', 'materials')).toEqual({ present: true, value: null });
  });

  test('MUTANT: without the key check, unit_cost reaches apply and is silently dropped', async () => {
    const mut = mutate(
      '        if (!SERVICE_TICKET_MATERIAL_KEYS.has(key)) {',
      '        if (false) {');
    const t0 = eng.log.length;
    const r = await drive(mut, [ticket({
      title: 'Stair repairs', job_id: 'j1',
      materials: [{ description: 'stringer', qty: 6, unit_cost: 41.5 }],
    })], JOHN);
    expect(r.stage).toBe('applied');     // "created" — while the price it was handed vanished
    expect(JSON.parse(boundValue(t0, 'service_tickets', 'materials').value)[0]).not.toHaveProperty('unit_cost');
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1.29 — 86 FOLLOWS THE PUNCH-LIST RULES
 * An approved work order's punch list is the record of what was approved, so
 * 86 cannot add buildings to it; a building added to a work order that is
 * awaiting approval sends it back to In progress, the same recount every other
 * door runs; and a new assignee is told, after COMMIT only.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('1.29 — task_adds follow the work order', () => {
  function seedWorkOrders() {
    eng.db.exec(`
      INSERT INTO service_tickets (id, organization_id, title, job_id, lead_id, status, priority, approval_notified_at) VALUES
        ('st_approved', 1, 'Approved list', 'j1', NULL, 'approved', 'normal', NULL),
        ('st_waiting',  1, 'Awaiting approval', 'j1', NULL, 'work_complete', 'normal', '2026-09-15 08:00:00');
      INSERT INTO tasks (id, organization_id, title, status, scope, service_ticket_id, entity_type, entity_id) VALUES
        ('tw1', 1, 'Bldg 1', 'done', 'org', 'st_waiting', 'job', 'j1'),
        ('ta1', 1, 'Bldg 7', 'done', 'org', 'st_approved', 'job', 'j1');
    `);
  }
  const eventsOf = (id) => eng.all('SELECT kind, actor_kind, actor_user_id, detail FROM service_ticket_events WHERE ticket_id = ? ORDER BY rowid', id);

  test('task_adds on an APPROVED ticket are refused non-retryably, before any write', async () => {
    seedWorkOrders();
    const t0 = eng.log.length;
    const r = await drive(REAL_MOD(), [update('st_approved', { task_adds: [{ title: 'Bldg 8' }] })], JOHN);
    expect(r.stage).toBe('apply');
    expect(r.message).toBe('This service ticket is approved. Its punch list is changed in the app after it is reopened. Nothing was saved.');
    expect([r.detail.code, r.detail.field_path, r.detail.received, r.detail.retryable])
      .toEqual(['ticket_approved', 'task_adds', 'approved', false]);
    expect(eng.all("SELECT id FROM tasks WHERE service_ticket_id = 'st_approved'")).toEqual([{ id: 'ta1' }]);
    expect(eventsOf('st_approved')).toEqual([]);
    expect(eng.log.slice(t0).filter((e) => /^(INSERT|UPDATE)\b/.test(e.sql))).toHaveLength(0);
  });

  test('a fields-only edit of an approved ticket is not a punch-list change and still applies', async () => {
    seedWorkOrders();
    const r = await drive(REAL_MOD(), [update('st_approved', { fields: { priority: 'high' } })], JOHN);
    expect(r.stage).toBe('applied');
  });

  test('MUTANT: without the refusal, 86 adds a building to an approved work order', async () => {
    seedWorkOrders();
    const mut = mutate('    if (taskAdds.length && !ticketRules.subtaskStructureWritable(before.status).ok) {', '    if (false) {');
    const r = await drive(mut, [update('st_approved', { task_adds: [{ title: 'Bldg 8' }] })], JOHN);
    expect(r.stage).toBe('applied');
    expect(eng.all("SELECT title FROM tasks WHERE service_ticket_id = 'st_approved' ORDER BY title").map((t) => t.title)).toEqual(['Bldg 7', 'Bldg 8']);
  });

  test('a building added to a work order awaiting approval sends it back to In progress, on the timeline as 86', async () => {
    seedWorkOrders();
    const r = await drive(REAL_MOD(), [update('st_waiting', { task_adds: [{ title: 'Bldg 2' }] })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT status, completed_at FROM service_tickets WHERE id = 'st_waiting'")).toEqual({ status: 'in_progress', completed_at: null });
    const ev = eventsOf('st_waiting');
    expect(ev.map((e) => [e.kind, e.actor_kind, e.actor_user_id])).toEqual([['task_added', 'agent', 10], ['status_changed', 'agent', 10]]);
    expect(ev[1].detail).toEqual({ from: 'work_complete', to: 'in_progress', reason: 'subtask_added' });
    // The diff card shows the move it is about to make.
    const card = r.res.apply_changeset.find((c) => c.entity_type === 'service_ticket');
    expect([card.before.status, card.after.status]).toEqual(['work_complete', 'in_progress']);
  });

  test('a dry run of the same payload leaves the work order awaiting approval', async () => {
    seedWorkOrders();
    const r = await drive(REAL_MOD(), [update('st_waiting', { task_adds: [{ title: 'Bldg 2' }] })], JOHN, { dryRun: true });
    expect(r.stage).toBe('applied');
    expect(one("SELECT status FROM service_tickets WHERE id = 'st_waiting'").status).toBe('work_complete');
    expect(eventsOf('st_waiting')).toEqual([]);
  });

  test('task_adds on an open ticket move nothing and write no status row', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', { task_adds: [{ title: 'Caulk tub' }] })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT status FROM service_tickets WHERE id = 'st_open'").status).toBe('open');
    expect(eventsOf('st_open').map((e) => e.kind)).toEqual(['task_added']);
  });

  test('MUTANT: without the recount, the work order stays awaiting approval with an open building on it', async () => {
    seedWorkOrders();
    const mut = mutate("    await workOrder.recountTicket(dbClient, before, { kind: 'agent', userId }, 'subtask_added');\n", '');
    const r = await drive(mut, [update('st_waiting', { task_adds: [{ title: 'Bldg 2' }] })], JOHN);
    expect(r.stage).toBe('applied');
    expect(one("SELECT status FROM service_tickets WHERE id = 'st_waiting'").status).toBe('work_complete');
  });
});

describe('1.29 — the assignment notice rides ctx.afterCommit', () => {
  let calls;
  let spy;
  beforeEach(() => {
    calls = [];
    spy = jest.spyOn(require('../server/services/work-order-notices'), 'notifyAssigned')
      .mockImplementation(async (_db, opts) => { calls.push(opts); return { sent: 1 }; });
  });
  afterEach(() => { spy.mockRestore(); });

  test('a new assignee on update is told once, after COMMIT, with the snapshot and the approver as the assigner', async () => {
    const r = await drive(REAL_MOD(), [update('st_open', { fields: { assignee_user_id: 11 } })], JOHN);
    expect(r.stage).toBe('applied');
    expect(calls).toHaveLength(1);
    expect([calls[0].ticket.id, calls[0].ticket.assignee_user_id, calls[0].assigneeUserId, calls[0].previousAssigneeUserId])
      .toEqual(['st_open', 11, 11, null]);
    expect(calls[0].actor).toEqual({ kind: 'user', userId: 10, label: null });
  });

  test('a create with an assignee is told too; a dry run, an unchanged assignee and a later refusal are not', async () => {
    await drive(REAL_MOD(), [ticket({ title: 'Gutters', job_id: 'j1', assignee_user_id: 11 })], JOHN);
    expect(calls.map((c) => [c.assigneeUserId, c.previousAssigneeUserId])).toEqual([[11, null]]);
    calls.length = 0;

    await drive(REAL_MOD(), [update('st_open', { fields: { assignee_user_id: 11 } })], JOHN, { dryRun: true });
    expect(calls).toEqual([]);

    eng.db.exec("UPDATE service_tickets SET assignee_user_id = 11 WHERE id = 'st_open'");
    await drive(REAL_MOD(), [update('st_open', { fields: { assignee_user_id: 11, priority: 'high' } })], JOHN);
    expect(calls).toEqual([]);

    eng.db.exec("UPDATE service_tickets SET assignee_user_id = NULL WHERE id = 'st_open'");
    const refused = await drive(REAL_MOD(), [
      update('st_open', { fields: { assignee_user_id: 11 } }),
      update('st_closed', { fields: { priority: 'high' } }),
    ], JOHN);
    expect(refused.stage).toBe('apply');
    expect(calls).toEqual([]);
  });

  test('MUTANT: drop the changed-assignee test and an unchanged assignee is told again on every edit', async () => {
    eng.db.exec("UPDATE service_tickets SET assignee_user_id = 11 WHERE id = 'st_open'");
    const mut = mutate('  if (assigneeAfter && assigneeAfter !== assigneeBefore && ctx && Array.isArray(ctx.afterCommit)) {',
      '  if (assigneeAfter && ctx && Array.isArray(ctx.afterCommit)) {');
    await drive(mut, [update('st_open', { fields: { priority: 'high' } })], JOHN);
    expect(calls).toHaveLength(1);
  });
});
