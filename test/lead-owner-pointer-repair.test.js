// R4, the half that could be done without a database: converge the two
// tenancy pointers — and discover that one of them does not exist.
//
// server/org-access.js declared its scoping source of truth to be
// `owner_id -> users.organization_id`. services/job-org-scope.js declares, in
// writing, "The COLUMN is canonical (see the N1 commit)". Two files naming two
// different sources of truth for the same fact is not a documentation problem:
// it is a row two tenants can read through two code paths, invisible to every
// NULL check and to any future NOT NULL, because both pointers are populated
// and simply disagree.
//
// THE DISCOVERY. `leads` HAS NO owner_id COLUMN. server/db.js declares
// client_id, salesperson_id, job_id and created_by, and no ALTER adds one. So
// every `JOIN users u ON u.id = l.owner_id` in this repo raised 42703 on every
// call — and every one of them sat behind safeCount, `.catch(() => ({rows:[]}))`
// or a fail-closed catch, so nine broken queries rendered as clean zeros:
//
//   * org-access.js's lead entity check DENIED every lead, always.
//   * The Command Center's lead histogram, leads-this-week tile and four photo
//     tiles reported 0 since the day they were written.
//   * The weekly SALES DIGEST threw on its first query every Monday and was
//     skipped — it has never sent, to anyone, while PM and Ops went out fine.
//
// Repairing them can only WIDEN what a tenant sees (stamping widens; tightening
// hides), which is the safe direction — but widening is still a behaviour
// change, and one of them is new outbound email.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const DB = read('server', 'db.js');
const ACCESS = read('server', 'org-access.js');
const MANIFEST = read('server', 'routes', 'org-manifest-routes.js');
const DIGEST = read('server', 'weekly-digest-cron.js');
const JOBSCOPE = read('server', 'services', 'job-org-scope.js');

// Comments explaining the bug are expected everywhere in this wave; executable
// SQL is what must be clean. Strip line comments before asserting on SQL.
const code = (src) => src.split(/\r?\n/)
  .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
  .join('\n');

describe('leads.owner_id never existed', () => {
  test('the DDL declares no owner_id, and no ALTER adds one', () => {
    const create = DB.slice(DB.indexOf('CREATE TABLE IF NOT EXISTS leads'));
    const decl = create.slice(0, create.indexOf(');'));
    expect(decl).toMatch(/salesperson_id/);
    expect(decl).toMatch(/created_by/);
    expect(decl).not.toMatch(/owner_id/);
    expect(DB).not.toMatch(/ALTER TABLE leads\s+ADD COLUMN IF NOT EXISTS owner_id/);
    // It DOES have the column the repair uses.
    expect(DB).toMatch(/ALTER TABLE leads\s+ADD COLUMN IF NOT EXISTS organization_id/);
  });

  test('no executable statement in the repo joins on it any more', () => {
    // Comments explaining the bug are fine and expected; SQL is not.
    for (const [name, src] of [['org-access', ACCESS], ['manifest', MANIFEST], ['digest', DIGEST]]) {
      const sqlish = src.split(/\r?\n/).filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
      expect({ name, joined: /l\.owner_id/.test(sqlish) }).toEqual({ name, joined: false });
    }
  });
});

describe('org-access.js converges onto the entity\'s own column', () => {
  test('all four owner-join cases now read the column', () => {
    const fn = ACCESS.slice(ACCESS.indexOf('async function assertEntityInOrg'));
    const body = fn.slice(0, fn.indexOf("case 'project'"));
    expect(body).not.toMatch(/JOIN users u ON u\.id = [jle]\.owner_id/);
    expect(body).toMatch(/FROM jobs j\s*\n?\s*WHERE j\.id = \$1 AND \(j\.organization_id = \$2/);
    expect(body).toMatch(/FROM estimates e\s*\n?\s*WHERE e\.id = \$1 AND \(e\.organization_id = \$2/);
    expect(body).toMatch(/FROM leads l\s*\n?\s*WHERE l\.id = \$1 AND \(l\.organization_id = \$2/);
    // change_order goes through the PARENT JOB'S column, not the owner.
    expect(body).toMatch(/JOIN jobs j ON j\.id = co\.job_id[\s\S]{0,120}j\.organization_id = \$2/);
  });

  test('the tolerance arm survives on every one — the POINTER changed, not the tolerance', () => {
    const fn = ACCESS.slice(ACCESS.indexOf('async function assertEntityInOrg'));
    const body = fn.slice(0, fn.indexOf('  try {'));
    expect((body.match(/organization_id IS NULL\) LIMIT 1/g) || []).length).toBeGreaterThanOrEqual(5);
  });

  test('the header no longer contradicts job-org-scope.js', () => {
    expect(JOBSCOPE).toMatch(/The COLUMN is canonical/);
    expect(ACCESS).toMatch(/THE POINTER: THE ENTITY'S OWN COLUMN/);
    expect(ACCESS).not.toMatch(/Scoping source of truth = the OWNER user's org/);
  });

  test('it still fails closed on an error, which is what hid this for so long', () => {
    const fn = ACCESS.slice(ACCESS.indexOf('async function assertEntityInOrg'));
    expect(fn).toMatch(/return false; \/\/ fail-closed/);
  });
});

describe('the Command Center counts were SQL errors rendered as zeros', () => {
  test('every manifest count scopes on a column, not an owner join', () => {
    expect(code(MANIFEST)).not.toMatch(/JOIN users u ON u\.id = [jle]\.owner_id/);
    expect(code(MANIFEST)).not.toMatch(/u\.organization_id/);
  });

  test('the job-scoped children scope through the PARENT JOB\'s column', () => {
    expect(MANIFEST).toMatch(/FROM job_change_orders co[\s\S]{0,200}JOIN jobs j ON j\.id = co\.job_id[\s\S]{0,120}j\.organization_id = \$1/);
    expect(MANIFEST).toMatch(/FROM schedule_entries s[\s\S]{0,200}JOIN jobs j ON j\.id = s\.job_id[\s\S]{0,120}j\.organization_id = \$1/);
  });

  test('next-job-number now takes its MAX over the un-reduced set', () => {
    // The sharpest consequence on this surface. A job whose OWNER had a NULL
    // org was excluded from MAX(jobNumber), so the counter could hand out a
    // number that is already in use — and db.js's own boot backfill CREATES
    // exactly that shape (it skips jobs whose owner has no org, then stamps
    // the column from the sole org anyway).
    const seg = MANIFEST.slice(MANIFEST.indexOf("router.post('/next-job-number'"));
    const q = seg.slice(seg.indexOf('SELECT MAX('), seg.indexOf('const maxExisting'));
    expect(q).toMatch(/FROM jobs j/);
    expect(q).toMatch(/WHERE j\.organization_id = \$1/);
    expect(q).not.toMatch(/owner_id/);
  });

  test('the header records that this changes visible numbers, and upward', () => {
    expect(MANIFEST).toMatch(/EVERY LEAD COUNT WAS A SQL ERROR RENDERED AS ZERO/);
    expect(MANIFEST).toMatch(/only ever WIDENS/);
  });

  test('the swallowing wrappers are still there — they are not the bug', () => {
    // safeCount and the .catch()s are correct: one broken table must not 500
    // the whole manifest. The bug was a query that could not succeed, not the
    // fact that failures are tolerated.
    expect(MANIFEST).toMatch(/async function safeCount/);
    expect(MANIFEST).toMatch(/\.catch\(\(\) => \(\{ rows: \[\] \}\)\)/);
  });
});

describe('the weekly sales digest has never sent, and now will', () => {
  test('its lead queries no longer reference a column that does not exist', () => {
    const fn = code(DIGEST).slice(code(DIGEST).indexOf('async function assembleSalesDigest'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).not.toMatch(/owner_id/);
    expect(body).toMatch(/FROM leads l " \+\s*\n\s*" WHERE l\.organization_id = \$1/);
    expect(body).toMatch(/FROM estimates e " \+\s*\n\s*" WHERE e\.organization_id = \$1/);
  });

  test('the per-role catch that hid it is still there — and still correct', () => {
    // One failing digest must not stop the other two. That is why the failure
    // was a single warn line for months.
    expect(DIGEST).toMatch(/catch \(e\) \{ console\.warn\('\[weekly-digest\]\[sales\]/);
    expect(DIGEST).toMatch(/catch \(e\) \{ console\.warn\('\[weekly-digest\]\[pm\]/);
  });

  test('the file says out loud that this starts new outbound mail', () => {
    // A tenant-boundary pass must not quietly begin emailing people. This is
    // the feature working as designed, but it is not a silent cleanup.
    expect(DIGEST).toMatch(/BEHAVIOUR CHANGE/);
    expect(DIGEST).toMatch(/HAS NEVER SENT/);
    expect(DIGEST).toMatch(/it ships announced/);
  });

  test('the PM and Ops digests converge too, so all three agree on the pointer', () => {
    expect(code(DIGEST)).not.toMatch(/JOIN users u ON u\.id = j\.owner_id/);
    expect(code(DIGEST)).not.toMatch(/u\.organization_id/);
  });
});

describe('the direction of every change here is WIDENING', () => {
  test('no tolerance arm was removed and no constraint added', () => {
    expect((ACCESS.match(/organization_id IS NULL/g) || []).length).toBeGreaterThanOrEqual(5);
    expect(DB).not.toMatch(/SET NOT NULL/);
  });

  test('an OWNERLESS row is now reachable rather than silently dropped', () => {
    // estimates.owner_id is NULLABLE, and jobs can point at a deleted user, so
    // the old INNER JOIN dropped those rows from every owner-scoped surface.
    // The column-scoped form returns them to the tenant the column names.
    expect(ACCESS).toMatch(/OWNERLESS row/);
  });
});
