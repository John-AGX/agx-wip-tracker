// THE ONE TICKET ACCESS RULE, EXECUTED AGAINST A REAL SQL ENGINE.
//
// The narrow tier (JOBS_VIEW_ASSIGNED / JOBS_EDIT_OWN) is the part that was
// never enforced, so it gets the most cases: owner, view grant, edit grant, no
// grant, another org's job, and every way a missing identity could fail open.
// Capabilities are injected so each case names exactly what the user holds.
'use strict';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const access = require('../server/services/service-ticket-access');

let eng;
const q = (sql, params) => eng.pool.query(sql, params);

function capsOf(list) {
  const set = new Set(list);
  return (user, cap) => set.has(cap);
}

beforeAll(() => {
  eng = createPgSqlite(sqliteSchema(['organizations', 'users', 'jobs', 'job_access']), { jsonColumns: ['data'] });
  eng.db.exec(`
    INSERT INTO organizations (id, name) VALUES (1,'AGX'),(2,'Rival');
    INSERT INTO users (id, name, email, role, organization_id) VALUES
      (10,'Owner','o@agx.test','pm',1),(11,'Viewer','v@agx.test','crew',1),
      (12,'Editor','e@agx.test','crew',1),(13,'Stranger','s@agx.test','crew',1);
    INSERT INTO jobs (id, owner_id, data, organization_id) VALUES
      ('j1', 10, '{}', 1), ('j9', 13, '{}', 2), ('jnull', 10, '{}', NULL);
    INSERT INTO job_access (job_id, user_id, access_level) VALUES
      ('j1', 11, 'view'), ('j1', 12, 'edit'), ('j9', 11, 'edit');
  `);
});
afterAll(() => { if (eng) eng.close(); });

const ask = (user, caps, parent, mode, orgId = 1) => access.mayAccessTicketParent({
  query: q, user, parent, mode, orgId, hasCapability: capsOf(caps),
});

describe('the wide tier', () => {
  test('JOBS_VIEW_ALL reads and JOBS_EDIT_ANY edits any job ticket, no lookup needed', async () => {
    expect(await ask({ id: 13 }, ['JOBS_VIEW_ALL'], { job_id: 'j1' }, 'read')).toEqual({ ok: true });
    expect(await ask({ id: 13 }, ['JOBS_EDIT_ANY'], { job_id: 'j1' }, 'write')).toEqual({ ok: true });
  });

  test('reading and writing are different capabilities', async () => {
    expect((await ask({ id: 13 }, ['JOBS_VIEW_ALL'], { job_id: 'j1' }, 'write')).ok).toBe(false);
    expect((await ask({ id: 13 }, ['JOBS_EDIT_ANY'], { job_id: 'j1' }, 'read')).ok).toBe(false);
  });
});

describe('the narrow tier — "the jobs I own or have been granted"', () => {
  test('the owner may read and edit', async () => {
    expect(await ask({ id: 10 }, ['JOBS_VIEW_ASSIGNED'], { job_id: 'j1' }, 'read')).toEqual({ ok: true });
    expect(await ask({ id: 10 }, ['JOBS_EDIT_OWN'], { job_id: 'j1' }, 'write')).toEqual({ ok: true });
  });

  test('a VIEW grant reads but does not edit', async () => {
    expect(await ask({ id: 11 }, ['JOBS_VIEW_ASSIGNED'], { job_id: 'j1' }, 'read')).toEqual({ ok: true });
    expect(await ask({ id: 11 }, ['JOBS_EDIT_OWN'], { job_id: 'j1' }, 'write')).toEqual({ ok: false, reason: 'not_assigned' });
  });

  test('an EDIT grant edits', async () => {
    expect(await ask({ id: 12 }, ['JOBS_EDIT_OWN'], { job_id: 'j1' }, 'write')).toEqual({ ok: true });
  });

  test('THE HOLE THIS CLOSES: the capability alone, on a job never granted, is refused', async () => {
    // Before this module, JOBS_VIEW_ASSIGNED on ANY job's ticket passed.
    expect(await ask({ id: 13 }, ['JOBS_VIEW_ASSIGNED'], { job_id: 'j1' }, 'read')).toEqual({ ok: false, reason: 'not_assigned' });
    expect(await ask({ id: 13 }, ['JOBS_EDIT_OWN'], { job_id: 'j1' }, 'write')).toEqual({ ok: false, reason: 'not_assigned' });
  });

  test('a grant on ANOTHER org\'s job does not reach through', async () => {
    // user 11 holds an edit grant on j9, which belongs to org 2.
    expect(await ask({ id: 11 }, ['JOBS_EDIT_OWN'], { job_id: 'j9' }, 'write', 1)).toEqual({ ok: false, reason: 'not_assigned' });
  });

  test('a legacy un-stamped job still resolves for its owner', async () => {
    expect(await ask({ id: 10 }, ['JOBS_VIEW_ASSIGNED'], { job_id: 'jnull' }, 'read')).toEqual({ ok: true });
  });

  test('every missing identity fails CLOSED, never open', async () => {
    const caps = ['JOBS_VIEW_ASSIGNED'];
    expect((await ask({}, caps, { job_id: 'j1' }, 'read')).ok).toBe(false);
    expect((await ask({ id: undefined }, caps, { job_id: 'j1' }, 'read')).ok).toBe(false);
    expect((await ask({ id: 10 }, caps, { job_id: 'j1' }, 'read', null)).ok).toBe(false);
    expect((await access.mayAccessTicketParent({ user: { id: 10 }, parent: { job_id: 'j1' }, mode: 'read', orgId: 1, hasCapability: capsOf(caps) })).ok).toBe(false);
    const throwing = { query: async () => { throw new Error('db down'); }, user: { id: 10 }, parent: { job_id: 'j1' }, mode: 'read', orgId: 1, hasCapability: capsOf(caps) };
    expect(await access.mayAccessTicketParent(throwing)).toEqual({ ok: false, reason: 'not_assigned' });
  });
});

describe('lead parents and the both-parents case', () => {
  test('a lead ticket is governed by LEADS_VIEW / LEADS_EDIT', async () => {
    expect(await ask({ id: 13 }, ['LEADS_VIEW'], { lead_id: 'l1' }, 'read')).toEqual({ ok: true });
    expect(await ask({ id: 13 }, ['LEADS_EDIT'], { lead_id: 'l1' }, 'write')).toEqual({ ok: true });
    expect((await ask({ id: 13 }, ['LEADS_VIEW'], { lead_id: 'l1' }, 'write')).ok).toBe(false);
  });

  test('a converted ticket carrying both is governed by the JOB', async () => {
    // Lead capability alone must not edit a ticket that now belongs to a job.
    expect((await ask({ id: 13 }, ['LEADS_EDIT'], { job_id: 'j1', lead_id: 'l1' }, 'write')).ok).toBe(false);
    expect(await ask({ id: 13 }, ['JOBS_EDIT_ANY'], { job_id: 'j1', lead_id: 'l1' }, 'write')).toEqual({ ok: true });
  });
});

describe('refusals that are not about the job', () => {
  test('bad mode, no user, no parent', async () => {
    expect(await ask({ id: 10 }, ['JOBS_VIEW_ALL'], { job_id: 'j1' }, 'delete')).toEqual({ ok: false, reason: 'bad_mode' });
    expect(await access.mayAccessTicketParent({ query: q, parent: { job_id: 'j1' }, mode: 'read', orgId: 1, hasCapability: capsOf(['JOBS_VIEW_ALL']) })).toEqual({ ok: false, reason: 'no_user' });
    expect(await ask({ id: 10 }, ['JOBS_VIEW_ALL'], {}, 'read')).toEqual({ ok: false, reason: 'no_parent' });
  });

  test('no capability at all', async () => {
    expect(await ask({ id: 10 }, [], { job_id: 'j1' }, 'read')).toEqual({ ok: false, reason: 'no_capability' });
  });
});

describe('coarse caps and list visibility', () => {
  test('coarse caps name every capability that could grant the mode', () => {
    expect(access.coarseCaps('read').sort()).toEqual(['JOBS_VIEW_ALL', 'JOBS_VIEW_ASSIGNED', 'LEADS_VIEW'].sort());
    expect(access.coarseCaps('write').sort()).toEqual(['JOBS_EDIT_ANY', 'JOBS_EDIT_OWN', 'LEADS_EDIT'].sort());
    expect(access.coarseCaps('nope')).toEqual([]);
  });

  test('list visibility: wide, assigned, lead-only, nothing', () => {
    expect(access.listVisibility({ id: 1 }, capsOf(['JOBS_VIEW_ALL', 'LEADS_VIEW']))).toEqual({ jobs: 'all', leads: true, userId: 1 });
    expect(access.listVisibility({ id: 1 }, capsOf(['JOBS_VIEW_ASSIGNED']))).toEqual({ jobs: 'assigned', leads: false, userId: 1 });
    expect(access.listVisibility({ id: 1 }, capsOf(['LEADS_VIEW']))).toEqual({ jobs: 'none', leads: true, userId: 1 });
    // Assigned tier with no identity is nothing, not everything.
    expect(access.listVisibility({}, capsOf(['JOBS_VIEW_ASSIGNED']))).toEqual({ jobs: 'none', leads: false, userId: null });
    expect(access.listVisibility(null, capsOf(['JOBS_VIEW_ALL']))).toEqual({ jobs: 'none', leads: false, userId: null });
  });
});

// ── WHEN ../auth CANNOT LOAD ─────────────────────────────────────────────
// The route files and the dispatcher load this module in environments with no
// JWT_SECRET, where requiring ../auth throws. loadHasCapability's catch is the
// only thing standing between that throw and a decision, and the old test here
// never reached it: it passed a user with no capabilities, which is refused
// whether auth loads or not, so a catch that answered "everyone may" would
// still have gone green.
//
// So the drive below is for a user who WOULD pass — proved first by the same
// call against an auth that loads and grants — and nothing is injected, so the
// module has to go and get auth itself. Each case loads a FRESH copy AND makes
// its calls inside jest.isolateModulesAsync: the module requires auth lazily,
// at CALL time, so a call made after the isolated registry is gone would fetch
// auth from the outer registry (a previous case's mock, or the real thing) and
// prove nothing about the mock under test.
const fs = require('fs');
const os = require('os');
const path = require('path');

const ACCESS_PATH = path.join(__dirname, '..', 'server', 'services', 'service-ticket-access.js');
const AUTH_PATH = path.join(__dirname, '..', 'server', 'auth.js');

async function withAccess(authFactory, modulePath, body) {
  await jest.isolateModulesAsync(async () => {
    jest.doMock('../server/auth', authFactory);
    await body(require(modulePath));
  });
}
// Counted, so a case can prove the require really reached THIS factory. A doMock
// that silently failed to intercept would load the real auth instead, and the
// mutant below would still see ok:true — for a reason that is not the catch.
let authThrows = 0;
const authThatThrows = () => { authThrows += 1; throw new Error('JWT_SECRET is required'); };
const authThatGrants = () => ({ hasCapability: () => true });
const WOULD_PASS = { query: q, user: { id: 13, role: 'admin' }, parent: { job_id: 'j1' }, mode: 'write', orgId: 1 };
const NONE = { jobs: 'none', leads: false, userId: null };

afterEach(() => { jest.dontMock('../server/auth'); });

describe('an auth module that will not load is a refusal, never a pass', () => {
  test('control: with an auth that loads and grants, the same call and the same user pass', async () => {
    await withAccess(authThatGrants, ACCESS_PATH, async (mod) => {
      expect(await mod.mayAccessTicketParent(WOULD_PASS)).toEqual({ ok: true });
      expect(mod.listVisibility(WOULD_PASS.user)).toEqual({ jobs: 'all', leads: true, userId: 13 });
    });
  });

  test('mayAccessTicketParent answers auth_unavailable', async () => {
    const before = authThrows;
    await withAccess(authThatThrows, ACCESS_PATH, async (mod) => {
      expect(await mod.mayAccessTicketParent(WOULD_PASS)).toEqual({ ok: false, reason: 'auth_unavailable' });
      expect(authThrows).toBeGreaterThan(before);
      expect(await mod.mayAccessTicketParent({ ...WOULD_PASS, mode: 'read', parent: { lead_id: 'l1' } }))
        .toEqual({ ok: false, reason: 'auth_unavailable' });
    });
  });

  test('listVisibility shows nothing', async () => {
    const before = authThrows;
    await withAccess(authThatThrows, ACCESS_PATH, async (mod) => {
      expect(mod.listVisibility(WOULD_PASS.user)).toEqual(NONE);
      expect(authThrows).toBeGreaterThan(before);
    });
  });

  test('an auth that loads without a hasCapability function is refused the same way', async () => {
    await withAccess(() => ({ hasCapability: 'not a function' }), ACCESS_PATH, async (mod) => {
      expect(await mod.mayAccessTicketParent(WOULD_PASS)).toEqual({ ok: false, reason: 'auth_unavailable' });
      expect(mod.listVisibility(WOULD_PASS.user)).toEqual(NONE);
    });
  });

  // THE MUTANT. A copy of the shipped module whose catch hands back a
  // permissive function, loaded against the same throwing auth. The copy goes
  // to the OS temp dir (never into server/, which other suites census), with
  // its ../auth require made absolute so the doMock above still intercepts it.
  test('mutant: a catch that returns a permissive function lets the would-be user through', async () => {
    const src = fs.readFileSync(ACCESS_PATH, 'utf8');
    const eol = src.indexOf('\r\n') !== -1 ? '\r\n' : '\n';
    const anchor = ['  } catch (e) {', '    return null;', '  }'].join(eol);
    expect(src.split(anchor).length - 1).toBe(1);
    const requireAnchor = "require('../auth')";
    expect(src.split(requireAnchor).length - 1).toBe(1);
    const mutated = src
      .split(anchor).join(['  } catch (e) {', '    return function () { return true; };', '  }'].join(eol))
      .split(requireAnchor).join('require(' + JSON.stringify(AUTH_PATH.split(path.sep).join('/')) + ')');
    expect(mutated).not.toBe(src);
    const p = path.join(os.tmpdir(), '_p86_st_access_mutant_' + process.pid + '_'
      + Math.random().toString(36).slice(2, 10) + '.js');
    fs.writeFileSync(p, mutated, 'utf8');
    try {
      await withAccess(authThatThrows, p, async (mod) => {
        let before = authThrows;
        expect(await mod.mayAccessTicketParent(WOULD_PASS)).toEqual({ ok: true });
        expect(authThrows).toBeGreaterThan(before);
        before = authThrows;
        expect(mod.listVisibility(WOULD_PASS.user)).toEqual({ jobs: 'all', leads: true, userId: 13 });
        expect(authThrows).toBeGreaterThan(before);
      });
    } finally {
      try { fs.unlinkSync(p); } catch (e) { /* already gone */ }
    }
  });
});
