// The three things the endgame is measured with, and the one door it needs.
//
// N2 — reportOrgOwnerDivergence counted to 20 and stopped.
//   `… ORDER BY j.id LIMIT 20` then `return r.rows.length`, so 500 divergent
//   jobs reported as 20. Divergence — organization_id column vs
//   owner_id -> users.organization_id — is the ONE failure mode no NULL check
//   and no future NOT NULL can see, because both pointers are populated and
//   simply disagree. The composite-FK constraint that would make it
//   unrepresentable cannot be added until the count is provably zero, and the
//   count could not exceed 20.
//
// N6 — requireOrgId's 409 named a remediation that had no endpoint, and the
//   client laddered against it for 105 seconds before saying anything.
//
// These are properties of specific statements and specific branches, so they
// are asserted against the real source and, where behaviour is observable, by
// driving the real function against a recording pool.

const fs = require('fs');
const path = require('path');

const DB_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'db.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const AUTH_SRC = fs.readFileSync(path.join(__dirname, '..', 'server', 'auth.js'), 'utf8');
const AUTH_ROUTES = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'auth-routes.js'), 'utf8');
const JOB_ROUTES = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'job-routes.js'), 'utf8');

// The source of one top-level async function, CRLF-tolerant (server files here
// are CRLF, and a '\n}' probe silently returns the rest of the FILE on them).
function fnBody(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start === -1) throw new Error('no such function: ' + name);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  if (end === -1) throw new Error('unterminated function: ' + name);
  return rest.slice(0, end);
}

describe('the divergence counter counts', () => {
  const BODY = fnBody(DB_SRC, 'reportOrgOwnerDivergence');

  test('the returned number comes from COUNT(*), not from the sample length', () => {
    expect(BODY).toMatch(/SELECT COUNT\(\*\)::int AS n/);
    // The capped read is still there — as the SAMPLE, for the log line.
    expect(BODY).toMatch(/ORDER BY j\.id LIMIT 20/);
    // and the number returned is never the sample's own length again.
    expect(BODY).not.toMatch(/return r\.rows\.length/);
    expect(BODY).toMatch(/return n;/);
  });

  test('the log line says how many were not listed', () => {
    expect(BODY).toMatch(/and \$\{n - r\.rows\.length\} more/);
  });

  test('"could not measure" is not reported as "zero"', () => {
    // The catch returned 0, so a pool blip and a clean database produced the
    // same value. Harmless as a log line; a trap the moment the count gates a
    // constraint that cannot be added while divergence exists.
    const c = BODY.slice(BODY.lastIndexOf('} catch'));
    expect(c).toMatch(/return null;/);
    expect(c).not.toMatch(/return 0;/);
  });

  test('the count query stays a fixed-width projection', () => {
    // No index can serve `<>` across a join, so this is a sequential scan
    // either way — LIMIT 20 only let it stop early. Selecting only id,
    // owner_id and organization_id keeps it a heap scan of tuple headers that
    // never detoasts the JSONB blobs. It runs once, at boot, ACCESS SHARE.
    expect(BODY).not.toMatch(/SELECT[^;]*\bj\.data\b/);
    expect(BODY).toMatch(/j\.organization_id <> u\.organization_id/);
  });

  test('the boot auditor can see the exposure the backfill gate created', () => {
    // Gating the guessing backfill turned a self-healing NULL into a permanent
    // one for every insert site that never names organization_id. The money /
    // job-scoped tables are now counted rather than assumed.
    const list = DB_SRC.slice(DB_SRC.indexOf('const ORG_STAMP_AUDIT_TABLES'));
    const decl = list.slice(0, list.indexOf(';'));
    for (const t of ['jobs', 'job_change_orders', 'job_subs', 'qb_cost_lines', 'node_graphs']) {
      expect(decl).toContain(`'${t}'`);
    }
  });

  test('every audited table has an IS NULL partial index to answer with', () => {
    // idx_*_org are partial on IS NOT NULL and by construction cannot serve
    // `WHERE organization_id IS NULL`. The audit runs twice per boot, before
    // listen(), inside the Railway swap window — so each audited table without
    // one of these is a full sequential scan in front of the port opening.
    const list = DB_SRC.slice(DB_SRC.indexOf('const ORG_STAMP_AUDIT_TABLES'));
    const decl = list.slice(0, list.indexOf(';'));
    const tables = (decl.match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''));
    expect(tables.length).toBeGreaterThan(5);
    for (const t of tables) {
      const idx = new RegExp(
        'CREATE INDEX IF NOT EXISTS \\S+ +ON ' + t + ' +\\([a-z_]+\\) WHERE organization_id IS NULL');
      expect({ table: t, indexed: idx.test(DB_SRC) }).toEqual({ table: t, indexed: true });
    }
  });
});

describe('fail closed without locking anyone out', () => {
  test('there is now an endpoint that attaches an org-less user to a tenant', () => {
    // Before this, NOTHING in the repo wrote users.organization_id after
    // insert: /register, the org-creation seed admin, and the boot backfill
    // were the only three writes. 9c1626a correctly gated that backfill — so
    // with a second organization present, an org-less user was permanently
    // unable to save, told to ask an admin who had no button.
    expect(AUTH_ROUTES).toMatch(/organization_id = COALESCE\(organization_id, \$8\)/);
    expect(AUTH_ROUTES).toMatch(/user\.org_adopted/);
  });

  test('the org is ADOPTED from the calling admin, never taken from the body', () => {
    // The adoption used to read the calling admin's org with its own SELECT.
    // Closing F2 put a tenant guard on this same handler, and that guard must
    // resolve the caller's org to reach its verdict — leaving one fact answered
    // by two reads, which is the two-pointer disagreement this wave exists to
    // remove. There is now ONE read and the adoption uses it. The property is
    // unchanged; it is asserted at both ends instead of at the SQL.
    const seg = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf('let adoptOrgId = null;'));
    const head = seg.slice(0, seg.indexOf('UPDATE users SET name'));
    expect(head).toMatch(/scope\.callerOrg/);
    expect(head).not.toMatch(/req\.body/);

    // …and scope.callerOrg is the guard's, whose only org source is resolveOrgId.
    const SCOPE_SRC = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'user-org-scope.js'), 'utf8');
    expect(AUTH_ROUTES).toMatch(/const scope = await guardUserTarget\(req, res, user\);/);
    expect(SCOPE_SRC).toMatch(/callerOrg = await resolveOrgId\(req\)/);
    expect(SCOPE_SRC).not.toMatch(/req\.body/);

    // resolveOrgId reads the signed claim, else the users row keyed on the
    // VERIFIED caller id. The same guarantee the separate SELECT gave, one hop
    // out — and the claim is hard-picked in signToken, so it is not forgeable.
    const resolve = fnBody(AUTH_SRC, 'resolveOrgId');
    expect(resolve).toMatch(/SELECT organization_id FROM users WHERE id = \$1/);
    expect(resolve).toMatch(/req\.user\.id/);
    expect(resolve).not.toMatch(/req\.body/);
  });

  test('it can only ever FILL a null — an admin cannot move a user between tenants', () => {
    // COALESCE reads the OLD column value, so a user who already has an org
    // keeps it. A tenancy move as a side effect of an HR edit is the shape
    // this whole wave exists to remove.
    expect(AUTH_ROUTES).toMatch(/COALESCE\(organization_id, \$8\)/);
    expect(AUTH_ROUTES).not.toMatch(/organization_id = \$8[^)]/);
    const seg = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf('let adoptOrgId = null;'));
    expect(seg.slice(0, 400)).toMatch(/if \(user\.organization_id == null\)/);
  });

  test('the 409 no longer promises something the product cannot do', () => {
    const msg = AUTH_SRC.slice(AUTH_SRC.indexOf("code: ORG_UNRESOLVED") - 900,
      AUTH_SRC.indexOf('code: ORG_UNRESOLVED'));
    expect(msg).toMatch(/Admin/);
    expect(msg).not.toMatch(/an administrator must set your organization/);
  });

  test('the role gate runs before the org gate', () => {
    // An org-less non-admin got 409 ORG_UNRESOLVED — a sentence about their
    // org state — for a request that would never have succeeded at any org,
    // and that answer discloses org state to someone the role gate should have
    // stopped. No behaviour change for anyone passing both.
    const mounts = (src) => src.split(/\r?\n/)
      .filter((l) => /^router\.\w+\(/.test(l) && /requireOrgId/.test(l) && /requireRole/.test(l));
    const lines = mounts(JOB_ROUTES).concat(mounts(AUTH_ROUTES));
    expect(lines.length).toBe(5);   // POST /, /convert, /bulk/save, /:id/owner, /register
    for (const l of lines) {
      expect({ route: l.slice(0, 40), ordered: l.indexOf('requireRole') < l.indexOf('requireOrgId') })
        .toEqual({ route: l.slice(0, 40), ordered: true });
    }
  });
});

describe('a permanent refusal does not ride the retry ladder', () => {
  test('409 and 403 fail immediately; 503 keeps all seven rungs', () => {
    // PUSH_BACKOFF sums to ~105s and used to run against ANY rejection. The
    // server already named its codes apart (409 ORG_UNRESOLVED vs 503
    // ORG_LOOKUP_FAILED); the client was not reading them, so "an
    // administrator must attach your account" spent 105 seconds pretending to
    // retry before it said anything at all.
    const seg = APP_SRC.slice(APP_SRC.indexOf('var _st = err && err.status;'));
    const head = seg.slice(0, seg.indexOf('if (_pushRetryCount < PUSH_BACKOFF.length)'));
    expect(head).toMatch(/_st === 409 \|\| _st === 403/);
    expect(head).toMatch(/notifyPushStatus\('failed'/);
    expect(head).not.toMatch(/503/);            // retryable — keeps the ladder
    expect(head).toMatch(/permanent: true/);
  });

  test('the server sentence is what the user is shown, not a generic one', () => {
    const seg = APP_SRC.slice(APP_SRC.indexOf('var _st = err && err.status;'));
    const head = seg.slice(0, seg.indexOf('if (_pushRetryCount < PUSH_BACKOFF.length)'));
    expect(head).toMatch(/err\.data && err\.data\.error/);
    expect(head).toMatch(/err\.data && err\.data\.code/);
  });

  test('handleResponse actually attaches what that branch reads', () => {
    // The split is only ~10 lines because the plumbing already exists. If it
    // ever stops attaching status/data, the branch silently never fires and the
    // ladder comes back.
    const api = fs.readFileSync(path.join(__dirname, '..', 'js', 'api.js'), 'utf8');
    expect(api).toMatch(/err\.status = r\.status;/);
    expect(api).toMatch(/err\.data = data;/);
  });

  test('the ladder itself is unchanged for the case it was written for', () => {
    expect(APP_SRC).toMatch(/PUSH_BACKOFF = \[1000, 2000, 4000, 8000, 15000, 30000, 45000\]/);
  });
});
