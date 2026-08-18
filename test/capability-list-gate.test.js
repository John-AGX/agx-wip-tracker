// hasCapability() and the space-separated list.
//
// WHAT THIS FILE EXISTS FOR
// Two files document the list form as the house convention ("Returning a
// space-separated list is the convention used in report-routes /
// qb-cost-routes"), and attachment-routes.js hand-rolled
// requireDynamicCapability to implement it BECAUSE hasCapability did not.
// hasCapability did an exact `caps.has(capKey)`, so every call site written in
// the documented style asked for a key no role can hold —
// "JOBS_EDIT_ANY JOBS_EDIT_OWN" — and answered 403 to everyone, including a
// capability-complete system admin.
//
// cc60e4c fixed requireCapability and stopped there. This is the other half.
//
// THE ORDER, WHICH IS THE WHOLE RISK.
// The dead gate was holding a tenancy hole shut. Six attachment doors resolve
// their capability through readCapForEntity/writeCapForEntity, which return the
// list form for job/sub/task; every one of them was ALSO missing a tenancy
// predicate. Repairing the gate first would have flipped six 403s to allowed
// while they were still unscoped — three of them on entity types with no
// tenant scoping at all. So b3257ae landed the predicates and left the gate
// broken, and this commit repairs the gate. The tests here assert the split;
// the cross-tenant tests in attachment-keyed-tenant-scope.test.js assert that
// the split did not open the boundary, and they were green before this change.
//
// AND: THE ADMINISH SHORT-CIRCUIT MASKING A BROKEN LOOKUP.
// Five more sites pass 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN' and each sits
// behind `role === 'admin' || role === 'system_admin'`, so nobody noticed the
// lookup underneath never worked. That pattern — a short-circuit that hides a
// dead check — is the thing to grep for, not just this one function.

const { setRolePool, refreshRoleCache, hasCapability, requireCapability } = require('../server/auth');

// `mock`-prefixed so jest's out-of-scope guard allows the factory to close
// over it.
let mockRoleRows;
jest.mock('../server/db', () => ({
  pool: { query: async () => ({ rows: mockRoleRows }) }
}));

setRolePool(require('../server/db').pool);

beforeAll(async () => {
  mockRoleRows = [
    { name: 'admin',        capabilities: ['USERS_MANAGE', 'ESTIMATES_EDIT'] },
    { name: 'pm',           capabilities: ['JOBS_EDIT_OWN'] },
    { name: 'system_admin', capabilities: ['USERS_MANAGE', 'ROLES_MANAGE', 'SYSTEM_ADMIN', 'JOBS_EDIT_ANY'] },
    { name: 'viewer',       capabilities: [] },
    // A custom role: holds USERS_MANAGE but is NOT named like a built-in, so
    // the adminish short-circuit in the five email/tag/template files does not
    // fire for it and the list lookup is the only thing standing between this
    // role and the feature it was granted.
    { name: 'office_lead',  capabilities: ['USERS_MANAGE'] }
  ];
  await refreshRoleCache();
});

const PM = { id: 1, role: 'pm' };
const ADMIN = { id: 2, role: 'admin' };
const SYSADMIN = { id: 3, role: 'system_admin' };
const VIEWER = { id: 4, role: 'viewer' };
const OFFICE_LEAD = { id: 5, role: 'office_lead' };

describe('a single capability key still behaves exactly as before', () => {
  test('held', () => expect(hasCapability(PM, 'JOBS_EDIT_OWN')).toBe(true));
  test('not held', () => expect(hasCapability(PM, 'JOBS_EDIT_ANY')).toBe(false));
  test('unknown role', () => expect(hasCapability({ role: 'nope' }, 'JOBS_EDIT_OWN')).toBe(false));
  test('no user, no role', () => {
    expect(hasCapability(null, 'JOBS_EDIT_OWN')).toBe(false);
    expect(hasCapability({}, 'JOBS_EDIT_OWN')).toBe(false);
  });
});

describe('a space-separated list means ANY, never AND', () => {
  test('the exact string was never a key any role could hold', () => {
    // The defect, stated directly: this is what the old code asked for.
    const caps = mockRoleRows.flatMap((r) => r.capabilities);
    expect(caps).not.toContain('JOBS_EDIT_ANY JOBS_EDIT_OWN');
  });

  test('holding ONE member is enough', () => {
    expect(hasCapability(PM, 'JOBS_EDIT_ANY JOBS_EDIT_OWN')).toBe(true);
    expect(hasCapability(SYSADMIN, 'JOBS_EDIT_ANY JOBS_EDIT_OWN')).toBe(true);
  });

  test('holding NONE is still refused', () => {
    expect(hasCapability(VIEWER, 'JOBS_EDIT_ANY JOBS_EDIT_OWN')).toBe(false);
  });

  test('it is not AND — a caller holding only the second member passes', () => {
    // If this read as AND, the pm above would fail and every single-cap gate in
    // the repo would silently tighten the day a second name was added to one.
    expect(hasCapability(PM, 'ROLES_MANAGE JOBS_EDIT_OWN')).toBe(true);
  });

  test('the real attachment cap strings resolve for the roles that should have them', () => {
    const { entityAccess } = require('../server/routes/attachment-routes');
    const jobWrite = entityAccess.writeCapForEntity('job');
    const jobRead = entityAccess.readCapForEntity('job');
    expect(jobWrite).toContain(' ');                       // still the list form
    expect(hasCapability(SYSADMIN, jobWrite)).toBe(true);  // was false: the outage
    expect(hasCapability(PM, jobWrite)).toBe(true);
    expect(hasCapability(SYSADMIN, jobRead)).toBe(true);
    expect(hasCapability(VIEWER, jobWrite)).toBe(false);   // and it still refuses
  });

  test('the five adminish-short-circuit sites now work for a CUSTOM role', () => {
    // office_lead holds USERS_MANAGE but is not named 'admin' or 'system_admin',
    // so the short-circuit in email-folders / email-labels / email-snippets /
    // folder-templates / org-tags does not fire and this lookup is the gate.
    expect(hasCapability(OFFICE_LEAD, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN')).toBe(true);
    expect(hasCapability(PM, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN')).toBe(false);
  });

  test('SYSTEM_ADMIN is not smuggled in by being one name in a list', () => {
    // The list widens the ANSWER, not the CAPABILITY. An admin who does not
    // hold SYSTEM_ADMIN still does not hold it, which is what user-org-scope's
    // cross-tenant crossing and requireAuth's act-as both key on.
    expect(hasCapability(ADMIN, 'SYSTEM_ADMIN')).toBe(false);
    expect(hasCapability(ADMIN, 'USERS_MANAGE SYSTEM_ADMIN')).toBe(true);   // via USERS_MANAGE
    expect(hasCapability(ADMIN, 'ROLES_MANAGE SYSTEM_ADMIN')).toBe(false);  // holds neither
  });
});

describe('an empty gate is a CLOSED gate', () => {
  test('empty string, whitespace, null and undefined all refuse', () => {
    expect(hasCapability(SYSADMIN, '')).toBe(false);
    expect(hasCapability(SYSADMIN, '   ')).toBe(false);
    expect(hasCapability(SYSADMIN, null)).toBe(false);
    expect(hasCapability(SYSADMIN, undefined)).toBe(false);
  });

  test('a missing capability name never reads as "no capability required"', () => {
    // The failure mode this guards: a typo'd or unset constant resolving to
    // undefined and quietly opening a route to everyone.
    expect(hasCapability(VIEWER, undefined)).toBe(false);
  });
});

describe('hasCapability and requireCapability now agree', () => {
  function run(user, cap) {
    let status = 200;
    const res = { status: (s) => { status = s; return res; }, json: () => res };
    let nexted = false;
    requireCapability(cap)({ user }, res, () => { nexted = true; });
    return nexted ? 200 : status;
  }

  test('the same list, the same verdict, through both entry points', () => {
    const cases = [
      [PM, 'JOBS_EDIT_ANY JOBS_EDIT_OWN'],
      [VIEWER, 'JOBS_EDIT_ANY JOBS_EDIT_OWN'],
      [OFFICE_LEAD, 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN'],
      [SYSADMIN, 'SYSTEM_ADMIN'],
      [ADMIN, 'SYSTEM_ADMIN'],
      [VIEWER, '']
    ];
    for (const [user, cap] of cases) {
      expect(run(user, cap) === 200).toBe(hasCapability(user, cap));
    }
  });
});
