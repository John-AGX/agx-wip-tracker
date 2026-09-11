// attach_files: the destination is a tenancy decision, and a short write is a refusal.
//
// WHAT THIS FILE EXISTS FOR
// `link_ops.attach_files` rewrites an attachment row's entity_type/entity_id.
// That pair is the ANCHOR attachment-org-scope.js resolves tenancy on — it
// anchors there precisely because both columns are NOT NULL on every row while
// organization_id is nullable and was historically unwritten. The reasoning is
// sound for a column nobody rewrites. This op rewrites it. So attach_files was
// never "a link": it is a tenancy transfer, and it shipped with no
// authorization step on the destination.
//
// The guard that stood in its place read
//
//     if (ORG_SCOPED_TABLE[et]) await assertTargetOrg(...)
//
// ORG_SCOPED_TABLE is {client, estimate, job, lead}. ATTACH_ENTITY_TYPES also
// accepts sub, user, org and project. For those four the `if` skipped the check
// entirely — a guard whose own condition records that half the accepted types
// could not be answered. Driven on unpatched code, an org-A payload re-pointed
// an org-A file onto an org-B project, and attachmentInOrg then agreed the file
// had changed tenants: org B gained the bytes, the caption and DELETE; org A
// lost all three.
//
// TWO THINGS THIS FILE PINS THAT ARE EASY TO GET WRONG
//
//   • The assertion is the VERDICT, not the column. `attachments.organization_id`
//     does not change in the broken case OR the fixed one — the whole defect is
//     that the parent anchor moved and the stamp did not. A test written against
//     the stamp passes on unpatched code.
//
//   • The refusals must cover project / sub / user / org SEPARATELY. A test that
//     only exercises `job` passes while the four unguarded arms stay open,
//     because `job` is the one type the old guard did answer for.
//
// AND ONE THAT IS THE WHOLE RISK OF THE CHANGE: over-refusal. Re-pointing rows
// is what this op is FOR. The legitimate in-org attach lives in this same file
// so it cannot regress unnoticed.

'use strict';

// Must precede the requires: the lazy `require('./attachment-org-scope')` inside
// the attach_files arm pulls user-org-scope -> ../auth, which refuses a secret
// under 32 chars and throws outright on a missing one. The dispatcher itself
// still loads without one, which is why that require is lazy and why the other
// 18 suites that require this module are unaffected.
process.env.JWT_SECRET = process.env.JWT_SECRET || 'attach-files-target-scope-test-secret-key-0123456789';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const { internals } = require('../server/services/payload-dispatcher');
const { attachmentInOrg } = require('../server/services/attachment-org-scope');

const { dispatchSystem } = internals;

const TABLES = ['organizations', 'users', 'attachments', 'projects', 'jobs', 'clients', 'subs', 'leads', 'estimates'];
const ORG_A = 1;
const ORG_B = 2;

let eng;

function seed() {
  if (eng) eng.close();
  eng = createPgSqlite(sqliteSchema(TABLES), { jsonColumns: ['data'] });
  const db = eng.db;

  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG_A, 'Alpha', 'alpha');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORG_B, 'Bravo', 'bravo');
  db.prepare('INSERT INTO users (id,email,name,role,active,organization_id) VALUES (?,?,?,?,?,?)')
    .run(11, 'a@a.a', 'A', 'admin', 1, ORG_A);
  db.prepare('INSERT INTO users (id,email,name,role,active,organization_id) VALUES (?,?,?,?,?,?)')
    .run(12, 'b@b.b', 'B', 'admin', 1, ORG_B);

  // One target of every accepted shape, on both sides of the boundary.
  db.prepare('INSERT INTO projects (id,organization_id,name) VALUES (?,?,?)').run('p1', ORG_A, 'A proj');
  db.prepare('INSERT INTO projects (id,organization_id,name) VALUES (?,?,?)').run('pB', ORG_B, 'B proj');
  db.prepare('INSERT INTO jobs (id,organization_id,data) VALUES (?,?,?)').run('jA', ORG_A, '{}');
  db.prepare('INSERT INTO jobs (id,organization_id,data) VALUES (?,?,?)').run('jB', ORG_B, '{}');
  db.prepare('INSERT INTO clients (id,organization_id,name) VALUES (?,?,?)').run('cA', ORG_A, 'Client A');
  db.prepare('INSERT INTO clients (id,organization_id,name) VALUES (?,?,?)').run('cB', ORG_B, 'Client B');
  db.prepare('INSERT INTO leads (id,organization_id) VALUES (?,?)').run('lB', ORG_B);
  db.prepare('INSERT INTO estimates (id,organization_id) VALUES (?,?)').run('eB', ORG_B);
  db.prepare('INSERT INTO subs (id,organization_id,name) VALUES (?,?,?)').run('sA', ORG_A, 'Sub A');
  db.prepare('INSERT INTO subs (id,organization_id,name) VALUES (?,?,?)').run('sB', ORG_B, 'Sub B');

  for (const id of ['a1', 'a2', 'a3']) {
    db.prepare('INSERT INTO attachments (id,entity_type,entity_id,filename,organization_id,uploaded_by) VALUES (?,?,?,?,?,?)')
      .run(id, 'project', 'p1', id + '.jpg', ORG_A, 11);
  }
  return eng;
}

function att(id) {
  return eng.all('SELECT id, entity_type, entity_id, organization_id, uploaded_by FROM attachments WHERE id = ?', id)[0];
}

// The frame applyPayload actually runs a target in — BEGIN, dispatch, COMMIT,
// ROLLBACK on throw. Driving the arm bare would let a partial write survive a
// refusal and the rollback assertion below would be measuring nothing.
async function applyInTxn(linkOps, ctx) {
  await eng.pool.query('BEGIN');
  try {
    const r = await dispatchSystem(eng.pool, { entity_type: 'system', ops: { link_ops: linkOps } }, {}, ctx);
    await eng.pool.query('COMMIT');
    return { ok: true, result: r };
  } catch (err) {
    await eng.pool.query('ROLLBACK');
    return { ok: false, error: err.message };
  }
}

const attachTo = (type, id, ids) => ([{
  op: 'attach_files',
  attachment_ids: ids || ['a1'],
  target_entity_type: type,
  target_entity_id: id,
}]);

beforeEach(() => { seed(); });
afterAll(() => { if (eng) eng.close(); });

// ── The boundary ──────────────────────────────────────────────────────────
describe('attach_files refuses a destination outside the caller org', () => {
  // project / sub / user / org are the four that had NO check at all. job,
  // lead, client, estimate were covered by assertTargetOrg and must stay
  // covered — the replacement has to be at least as strong, not merely
  // different.
  // `wasGuarded` records which of the eight the OLD guard could answer for. It
  // is not decoration: if every row asserted the NEW message, reverting the
  // change would redden all eight — four of them only because the wording
  // moved, not because the boundary broke — and the suite would look like it
  // covered arms it does not. The four that were open assert the new refusal by
  // name; the four that were already closed assert only that they are STILL
  // closed, which is the property that must not regress.
  const FOREIGN = [
    ['project', 'pB', false],
    ['sub', 'sB', false],
    ['user', '12', false],
    ['org', String(ORG_B), false],
    ['job', 'jB', true],
    ['lead', 'lB', true],
    ['client', 'cB', true],
    ['estimate', 'eB', true],
  ];

  test.each(FOREIGN)('org A cannot re-point its own file onto org B %s', async (type, id, wasGuarded) => {
    const before = att('a1');
    expect(await attachmentInOrg(eng.pool, before, ORG_A)).toBe(true);
    expect(await attachmentInOrg(eng.pool, before, ORG_B)).toBe(false);

    const out = await applyInTxn(attachTo(type, id), { organizationId: ORG_A });

    expect(out.ok).toBe(false);
    if (!wasGuarded) expect(out.error).toContain('is not available to attach to');

    // The verdict, not the column: organization_id is identical either way.
    const after = att('a1');
    expect(after.entity_type).toBe('project');
    expect(after.entity_id).toBe('p1');
    expect(await attachmentInOrg(eng.pool, after, ORG_A)).toBe(true);
    expect(await attachmentInOrg(eng.pool, after, ORG_B)).toBe(false);
  });

  test('the same four destinations in the caller org are allowed', async () => {
    for (const [type, id] of [['project', 'p1'], ['sub', 'sA'], ['user', '11'], ['org', String(ORG_A)]]) {
      seed();
      const out = await applyInTxn(attachTo(type, id), { organizationId: ORG_A });
      expect([type, out.ok]).toEqual([type, true]);
      expect(att('a1').entity_id).toBe(id);
    }
  });

  test('a destination that does not exist is refused, and no UPDATE reaches the database', async () => {
    const base = eng.log.length;
    const out = await applyInTxn(attachTo('project', 'p-does-not-exist'), { organizationId: ORG_A });

    expect(out.ok).toBe(false);
    expect(out.error).toContain('project p-does-not-exist is not available to attach to');
    expect(att('a1').entity_id).toBe('p1');

    // Stronger than "no rows changed": the write never ran.
    const ran = eng.log.slice(base).map((e) => e.sql);
    expect(ran.some((s) => /^UPDATE attachments/i.test(s))).toBe(false);
  });
});

// ── Completeness ──────────────────────────────────────────────────────────
describe('attach_files stops reporting success for rows it did not touch', () => {
  test('ghost ids refuse, and the message names every one of them', async () => {
    const out = await applyInTxn(attachTo('job', 'jA', ['nope-1', 'nope-2']), { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("'nope-1'");
    expect(out.error).toContain("'nope-2'");
    expect(out.error).toMatch(/Nothing was saved/);
  });

  test('a partial refuses AND rolls the matched row back', async () => {
    const out = await applyInTxn(attachTo('job', 'jA', ['a1', 'ghost-9']), { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("'ghost-9'");
    // Asserting on the returned count alone would be satisfied by a console.warn.
    expect(att('a1').entity_type).toBe('project');
    expect(att('a1').entity_id).toBe('p1');
  });

  test('a null / empty id is named rather than silently dropped from the list', async () => {
    const out = await applyInTxn(attachTo('job', 'jA', ['a1', null, '']), { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('(empty)');
    expect(out.error).toContain('2 of 3');
    expect(att('a1').entity_id).toBe('p1');
  });

  test("another org's attachment id refuses by name instead of quietly shrinking the write", async () => {
    eng.db.prepare('INSERT INTO attachments (id,entity_type,entity_id,filename,organization_id,uploaded_by) VALUES (?,?,?,?,?,?)')
      .run('bee1', 'project', 'pB', 'bee1.jpg', ORG_B, 12);
    const out = await applyInTxn(attachTo('job', 'jA', ['a1', 'bee1']), { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(out.error).toContain("'bee1'");
    expect(att('bee1').entity_id).toBe('pB');
    expect(att('a1').entity_id).toBe('p1');
  });
});

// ── The legitimate use, which is the whole point of the op ────────────────
describe('the legitimate attach is unchanged', () => {
  test('three in-org files onto an in-org job still succeed, with the same result shape', async () => {
    const base = eng.log.length;
    const out = await applyInTxn(attachTo('job', 'jA', ['a1', 'a2', 'a3']), { organizationId: ORG_A });

    expect(out.ok).toBe(true);
    expect(out.result.updated).toEqual([{
      kind: 'attach_files', count: 3, target_entity_type: 'job', target_entity_id: 'jA',
    }]);
    expect(out.result.summary).toBe('System: ~1 updated');
    for (const id of ['a1', 'a2', 'a3']) {
      expect([id, att(id).entity_type, att(id).entity_id]).toEqual([id, 'job', 'jA']);
    }
    // and it really did go through the database
    expect(eng.log.slice(base).some((e) => /^UPDATE attachments/i.test(e.sql) && e.ok && e.rowCount === 3)).toBe(true);
  });

  test('a $ref target created earlier in the same payload survives the predicate', async () => {
    // resolveRef concretises the ref before the guard sees it, and the row is
    // visible inside the open transaction. If this ever refuses, the predicate
    // needs the isRef early-return assertTargetOrg carries.
    eng.db.prepare('INSERT INTO projects (id,organization_id,name) VALUES (?,?,?)').run('p_new', ORG_A, 'made this payload');
    await eng.pool.query('BEGIN');
    const r = await dispatchSystem(
      eng.pool,
      { entity_type: 'system', ops: { link_ops: attachTo('project', '$new_project') } },
      { $new_project: 'p_new' },
      { organizationId: ORG_A });
    await eng.pool.query('COMMIT');
    expect(r.updated[0]).toMatchObject({ count: 1, target_entity_id: 'p_new' });
    expect(att('a1').entity_id).toBe('p_new');
  });

  test('a legacy un-stamped in-org target is still tolerated', async () => {
    // Same OR-IS-NULL tolerance every org predicate in this repo carries.
    // Withdrawing it here would be its own reviewed change.
    eng.db.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run('p_legacy', 'no org stamp');
    const out = await applyInTxn(attachTo('project', 'p_legacy'), { organizationId: ORG_A });
    expect(out.ok).toBe(true);
    expect(att('a1').entity_id).toBe('p_legacy');
  });
});

// ── The context with no tenant at all ─────────────────────────────────────
describe('a payload carrying no organization', () => {
  test('cannot re-point onto a stamped target of any org', async () => {
    for (const [type, id] of [['project', 'p1'], ['project', 'pB'], ['job', 'jA'], ['org', String(ORG_A)]]) {
      seed();
      const out = await applyInTxn(attachTo(type, id), { userId: 99 });
      expect([type, id, out.ok]).toEqual([type, id, false]);
      expect(att('a1').entity_id).toBe('p1');
    }
  });
});

// ── link_job_to_client ────────────────────────────────────────────────────
describe('link_job_to_client checks the client it is about to write', () => {
  test('a client id with no row behind it is refused and the blob is untouched', async () => {
    const out = await applyInTxn([{ op: 'link_job_to_client', job_id: 'jA', client_id: 'cGHOST' }], { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(out.error).toContain('client cGHOST not found');
    const data = eng.all('SELECT data FROM jobs WHERE id = ?', 'jA')[0].data;
    expect(data.client_id).toBeUndefined();
  });

  test('a real in-org client still links', async () => {
    const out = await applyInTxn([{ op: 'link_job_to_client', job_id: 'jA', client_id: 'cA' }], { organizationId: ORG_A });
    expect(out.ok).toBe(true);
    expect(out.result.updated).toEqual([{ kind: 'job_client_link', job_id: 'jA', client_id: 'cA' }]);
    expect(eng.all('SELECT data FROM jobs WHERE id = ?', 'jA')[0].data.client_id).toBe('cA');
  });

  test("another org's client is still refused", async () => {
    const out = await applyInTxn([{ op: 'link_job_to_client', job_id: 'jA', client_id: 'cB' }], { organizationId: ORG_A });
    expect(out.ok).toBe(false);
    expect(eng.all('SELECT data FROM jobs WHERE id = ?', 'jA')[0].data.client_id).toBeUndefined();
  });
});
