// The rest of the `jobs` survey: reads and writes that leaked, and one that
// did nothing at all.
//
// These are the statements the earlier commits' scope calls left open. Three
// of them are agent-reachable, which is not a coincidence — the agent tool
// layer is newer than requireOrgId and does not sit behind it.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const AI = read('server', 'routes', 'ai-routes.js');
const MSG = read('server', 'routes', 'message-routes.js');
const TASKS = read('server', 'routes', 'tasks-routes.js');
const SUBS = read('server', 'routes', 'sub-routes.js');

function fnBody(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start === -1) throw new Error('no such function: ' + name);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  if (end === -1) throw new Error('unterminated function: ' + name);
  return rest.slice(0, end);
}

describe('the agent cannot link a job to a client across tenants', () => {
  const LINK = fnBody(AI, 'execLinkJobToClient');
  const BULK = fnBody(AI, 'execBulkLinkJobsToClients');

  test('single link: BOTH the client check and the job write are scoped', () => {
    // One call used to point an org-B job at an org-A client — divergence in
    // two tables at once, from a caller-supplied pair of ids.
    expect(LINK).toMatch(/FROM clients WHERE id = \$1 AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    expect(LINK).toMatch(/UPDATE jobs[\s\S]*AND \(organization_id = \$3 OR organization_id IS NULL\)/);
  });

  test('single link: no org means refuse, not proceed', () => {
    expect(LINK).toMatch(/if \(orgId == null\) throw/);
  });

  test('bulk link: validation and every write in the loop are scoped', () => {
    expect(BULK).toMatch(/if \(orgId == null\) throw/);
    expect(BULK).toMatch(/SELECT id FROM jobs WHERE id = ANY\(\$1::text\[\]\)[\s\S]{0,120}organization_id IS NULL/);
    expect(BULK).toMatch(/SELECT id, name FROM clients WHERE id = ANY\(\$1::text\[\]\)[\s\S]{0,120}organization_id IS NULL/);
    expect(BULK).toMatch(/UPDATE jobs[\s\S]*AND \(organization_id = \$3 OR organization_id IS NULL\)/);
  });

  test('both call sites hand over a server-resolved org', () => {
    // requireOrg is already on POST /86/chat/continue and it attaches
    // req.organization, so the value is server-derived and cannot be forged
    // through the tool input.
    expect(AI).toMatch(/execLinkJobToClient\(r\.input \|\| \{\}, req\.organization && req\.organization\.id\)/);
    expect(AI).toMatch(/execBulkLinkJobsToClients\(r\.input \|\| \{\}, req\.organization && req\.organization\.id\)/);
  });
});

describe('the client-delete cascade is bounded by tenant, not by string value', () => {
  test('both UPDATEs carry a tenant predicate', () => {
    // They matched on a VALUE, not an id: deleting an org-A client stripped
    // clientId from EVERY tenant's rows carrying it. The DELETE below them was
    // already scoped; these two were not. The blast radius was "however many
    // rows happen to hold the string", which is not a bound.
    const i = AI.indexOf("UPDATE estimates SET data = data - 'clientId'");
    expect(i).toBeGreaterThan(-1);
    const seg = AI.slice(i, AI.indexOf('DELETE FROM clients WHERE id = $1', i));
    const updates = seg.split(/UPDATE (estimates|jobs) SET data = data - 'clientId'/).filter((x) => /WHERE/.test(x));
    expect(updates.length).toBe(2);
    for (const u of updates) {
      expect(u).toMatch(/WHERE data->>'clientId' = \$1\s*\r?\n\s*AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    }
  });

  test('it refuses without an org rather than running unbounded', () => {
    const i = AI.indexOf("const _cdDelOrg = _cdRequireOrg('delete a client');");
    expect(i).toBeGreaterThan(-1);
    // _cdRequireOrg throws when there is no signed-in user context.
    expect(AI).toMatch(/const _cdRequireOrg = \(what\) => \{[\s\S]{0,200}throw new Error/);
  });
});

describe('the full-table job scan that fed nothing is gone', () => {
  test('no unbounded SELECT of every job blob remains on the agent path', () => {
    // `SELECT id, data FROM jobs` with no WHERE — every job blob in the
    // database, materialised into JS on every job-context build and discarded
    // by `void jobsRes`. Not a disclosure (nothing reached the model), just a
    // full-table JSONB read doing nothing. Deleted rather than predicated: a
    // query no one reads does not need one.
    expect(AI).not.toMatch(/SELECT id, data FROM jobs`\)/);
    expect(AI).not.toMatch(/void jobsRes/);
  });
});

describe('a guessed id no longer returns another tenant\'s label', () => {
  test('task entity labels are org-scoped on every branch', () => {
    const fn = fnBody(TASKS, 'resolveEntityLabel');
    expect(fn).toMatch(/const orgGuard = ' AND \(organization_id = \$2 OR organization_id IS NULL\)'/);
    for (const t of ['leads', 'clients', 'subs', 'estimates', 'jobs']) {
      const line = fn.split(/\r?\n/).find((l) => l.includes('FROM ' + t + ' WHERE id = $1'));
      expect({ table: t, guarded: !!line && /orgGuard/.test(line) })
        .toEqual({ table: t, guarded: true });
    }
    // projects has no tolerance arm and never had one — keep it strict.
    expect(fn).toMatch(/FROM projects WHERE id = \$1 AND organization_id = \$2/);
    expect(fn).toMatch(/if \(orgId == null\) return ''/);
  });

  test('the org is bound as a PARAMETER, not concatenated into the SQL', () => {
    const fn = fnBody(TASKS, 'resolveEntityLabel');
    expect(fn).not.toMatch(/organization_id = ' \+ Number\(orgId\)/);
    expect(fn).toMatch(/pool\.query\(sql, \[String\(id\), orgId\]\)/);
  });

  test('message thread labels are org-scoped, and every caller passes one', () => {
    const fn = fnBody(MSG, 'describeThread');
    expect(fn).toMatch(/FROM jobs WHERE id = \$1 AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    expect(fn).toMatch(/FROM leads WHERE id = \$1 AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    const calls = MSG.split(/(?<!function )describeThread\(/).slice(1);
    expect(calls.length).toBe(2);
    for (const c of calls) expect(c.slice(0, 120)).toMatch(/organization_id/);
  });

  test('the sub_assigned email cannot carry a foreign job number off-platform', () => {
    // This one leaves the product: it puts the job's number and title into an
    // email to an outside subcontractor.
    const fn = fnBody(SUBS, 'notifySubAssigned');
    expect(fn).toMatch(/orgId/);
    expect(fn).toMatch(/FROM jobs WHERE id = \$1 AND \(organization_id = \$2 OR organization_id IS NULL\)/);
    expect(SUBS).toMatch(/orgId: req\.user && req\.user\.organization_id/);
  });
});
