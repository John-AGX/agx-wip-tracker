// R1 — the write paths that were still landing NULL, and the gate that closes
// the one with no request to hang requireOrgId off.
//
// Every HTTP write door can use requireOrgId. The agent path cannot: there is
// no req. So it resolved the tenant per-tool, inline, as
//
//     let orgId = null;
//     try { orgId = await resolveOrgIdFromCtx(ctx); } catch (_) {}
//     if (orgId) { where.push('(organization_id = $n OR organization_id IS NULL)'); }
//
// Both halves of that are defects, and they compound:
//
//   * the bare catch collapses "I could not look this up" into "this user has
//     no org" — the exact collapse auth.js:resolveOrgId exists to prevent, and
//     its comment says why: only one of those is the caller's fault; and
//   * the FALSE branch of the `if` emits NO PREDICATE AT ALL. Not a degraded
//     read. The full cross-tenant table.
//
// So one pool blip on read_leads returned every tenant's entire pipeline —
// names, addresses, revenue ranges — to the model, with no error anywhere.
//
// These are properties of specific statements and specific branches, asserted
// against the real source, the same way test/org-divergence-count.test.js does.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const AI = read('server', 'routes', 'ai-routes.js');
const AUTH_ROUTES = read('server', 'routes', 'auth-routes.js');
const DISPATCH = read('server', 'services', 'payload-dispatcher.js');
const AGENTS = read('server', 'routes', 'admin-agents-routes.js');
const DB = read('server', 'db.js');

// The source of one top-level function, CRLF-tolerant.
function fnBody(src, sig) {
  const start = src.indexOf(sig);
  if (start === -1) throw new Error('no such function: ' + sig);
  const rest = src.slice(start);
  const end = rest.search(/\r?\n\}\r?\n/);
  if (end === -1) throw new Error('unterminated: ' + sig);
  return rest.slice(0, end);
}

describe('requireTurnOrg — three outcomes, not two', () => {
  const BODY = AI.slice(AI.indexOf('async function requireTurnOrg()'),
                        AI.indexOf('function turnOrgRefusal'));

  test('a lookup failure is distinguishable from a genuinely org-less user', () => {
    expect(BODY).toMatch(/ORG_LOOKUP_FAILED/);
    expect(BODY).toMatch(/ORG_UNRESOLVED/);
    // and the two come from DIFFERENT branches, keyed on whether the lookup
    // itself threw — not on whether the value happened to be null.
    expect(BODY).toMatch(/if \(_capUserError\)/);
  });

  test('resolveCapUser records the error instead of swallowing it into null', () => {
    const rc = fnBody(AI, 'async function resolveCapUser()');
    expect(rc).toMatch(/catch \(e\) \{ _capUserError = e;/);
    expect(rc).not.toMatch(/catch \(_\) \{ _capUser = null; \}/);
  });

  test('the authoritative org outranks the user lookup', () => {
    // agent_jobs.organization_id is NOT NULL and was stamped at ENQUEUE by a
    // request that had already passed requireOrgId. It is strictly better
    // evidence than re-deriving from the user, which can fail and — after an
    // adoption — can produce a different tenant than the one the user asked
    // under.
    expect(BODY.indexOf('authoritativeOrgId')).toBeLessThan(BODY.indexOf('resolveCapUser()'));
    expect(DB).toMatch(/organization_id INTEGER NOT NULL[\s\S]{0,200}agent_jobs|agent_jobs[\s\S]{0,900}organization_id INTEGER NOT NULL/);
  });

  test('the org is never read from tool input — that would be forgeable', () => {
    expect(BODY).not.toMatch(/tu\.input|input\./);
  });

  test('it resolves ONCE per turn and memoizes', () => {
    expect(BODY).toMatch(/if \(_turnOrg !== undefined\) return _turnOrg;/);
  });
});

describe('the refusal is visible and countable', () => {
  const REFUSAL = fnBody(AI, 'function turnOrgRefusal(');

  test('it emits one log line with a stable prefix', () => {
    // This line is the only evidence available that the gate ever fires, which
    // is the only evidence that the write paths are actually closed.
    expect(REFUSAL).toMatch(/\[org\] agent tool refused — /);
    expect(REFUSAL).toMatch(/user=/);
    expect(REFUSAL).toMatch(/tool=/);
  });

  test('it comes back as tool-result text the model relays to the user', () => {
    // A silently refused agent write looks to a user exactly like an agent
    // that chose not to write. This repo already has a recorded incident of 86
    // narrating queued writes that produced zero payloads.
    expect(REFUSAL).toMatch(/tier: 'auto', error:/);
    expect(REFUSAL).toMatch(/Nothing was read or written|NOTHING was read or written/);
  });

  test('the retryable case says so, and names no permission problem', () => {
    const retry = REFUSAL.slice(REFUSAL.indexOf("ORG_LOOKUP_FAILED'"), REFUSAL.indexOf('return { tier: \'auto\', error:\n      \'This account'));
    expect(retry).toMatch(/temporary/);
  });

  test('the permanent case names an action an admin can actually take', () => {
    expect(REFUSAL).toMatch(/Admin → Users/);
  });
});

describe('the gate runs before everything it protects', () => {
  test('before the capability gate and before any executor branch', () => {
    const seg = AI.slice(AI.indexOf('const capUser = await resolveCapUser();'));
    const head = seg.slice(0, seg.indexOf('const capDenial'));
    expect(head).toMatch(/const turnOrg = await requireTurnOrg\(\);/);
    expect(head).toMatch(/if \(!turnOrg\.ok\) return turnOrgRefusal\(turnOrg, tu\.name\);/);
  });

  test('ctx.orgId is the gate\'s answer, so it can never be null downstream', () => {
    const seg = AI.slice(AI.indexOf('const turnOrg = await requireTurnOrg();'));
    const ctx = seg.slice(0, seg.indexOf('const capDenial'));
    expect(ctx).toMatch(/orgId: turnOrg\.orgId,/);
    // The old shape defaulted to null and let every downstream site decide.
    expect(ctx).not.toMatch(/orgId: \(capUser && capUser\.organization_id\) \|\| null/);
  });
});

describe('the conditional org arms are gone — the false branch WAS the leak', () => {
  test('no read handler in ai-routes still gates its org predicate on an if', () => {
    for (const v of ['_cdOrgId', '_matOrgId', '_mphOrgId', 'leadOrgId']) {
      expect({ v, conditional: new RegExp('if \\(' + v + '\\) \\{ where\\.push').test(AI) })
        .toEqual({ v, conditional: false });
      // …and the arm is still there, just unconditional.
      expect(AI).toMatch(new RegExp('where\\.push\\([^;]*organization_id[^;]*\\); [a-z]+\\.push\\(' + v + '\\)'));
    }
  });

  test('the silent catches that fed them are gone', () => {
    // `try { x = await resolveOrgIdFromCtx(ctx) } catch (_) {}` then `if (x)`
    // meant a DB blip produced an unscoped query with no error anywhere.
    for (const v of ['_matOrgId', '_mphOrgId', 'leadOrgId']) {
      expect({ v, silent: new RegExp('try \\{ ' + v + ' = await resolveOrgIdFromCtx').test(AI) })
        .toEqual({ v, silent: false });
    }
  });

  test('the staff directory no longer answers an org-less caller with everyone', () => {
    const seg = AUTH_ROUTES.slice(AUTH_ROUTES.indexOf("router.get('/users', requireAuth"));
    const head = seg.slice(0, seg.indexOf('const { rows }'));
    expect(head).not.toMatch(/if \(orgId\) \{ params\.push/);
    expect(head).toMatch(/await resolveOrgId\(req\)/);
    // Refuses with requireOrgId's own two codes, so the client ladder that
    // already tells 409 from 503 handles both without a new branch.
    expect(head).toMatch(/code: ORG_LOOKUP_FAILED/);
    expect(head).toMatch(/code: ORG_UNRESOLVED/);
    expect(head).toMatch(/status\(503\)/);
    expect(head).toMatch(/status\(409\)/);
  });

  test('the shared-catalog arms are MARKED so a tenancy sweep cannot eat them', () => {
    // read_materials and read_purchase_history use the byte-identical
    // `(organization_id = $n OR organization_id IS NULL)` idiom that read_users
    // and read_leads use — but there it means "the platform catalog row every
    // tenant prices from", not "an un-stamped tenant row". A mechanical
    // conversion cannot tell them apart, and removing one is silent: 86 replies
    // "no material matches" and prices from nothing.
    const mat = AI.slice(AI.indexOf("case 'read_materials'"), AI.indexOf("case 'read_purchase_history'"));
    expect(mat).toMatch(/ORG-SHARED-CATALOG \(not tolerance\)/);
    const mph = AI.slice(AI.indexOf("case 'read_purchase_history'"));
    expect(mph.slice(0, 2000)).toMatch(/ORG-SHARED-CATALOG \(not tolerance\)/);
    // …and the tenancy ones carry the OTHER token, the one org-access.js tells
    // people to grep for.
    const users = AI.slice(AI.indexOf("case 'read_users'"), AI.indexOf("case 'read_users'") + 2500);
    expect(users).toMatch(/OR-IS-NULL \(org tolerance\)/);
  });
});

describe('the payload dispatcher refuses rather than writing unscoped', () => {
  test('schedule_ops refuses without a resolved org instead of dropping the predicate', () => {
    const seg = DISPATCH.slice(DISPATCH.indexOf('const schedOrgId ='));
    const head = seg.slice(0, seg.indexOf('const created = []'));
    expect(head).toMatch(/throw new Error\('schedule_ops requires a resolved organization/);
    expect(DISPATCH).not.toMatch(/if \(schedOrgId\) \{ params\.push/);
    expect(DISPATCH).not.toMatch(/if \(schedOrgId\) \{ delParams\.push/);
  });

  test('field_tools: the is_system guard no longer rides on the org `if`', () => {
    // This is the sharpest one. The false branch dropped the tenant predicate
    // AND `AND is_system = false` with it, because both were welded to the
    // same conditional — so an org-less apply could edit or DELETE a BUILT-IN
    // tool, the exact thing the comment above it says the guard prevents.
    expect(DISPATCH).not.toMatch(/if \(ftOrgId\) \{ vals\.push/);
    expect(DISPATCH).not.toMatch(/if \(ftDelOrgId\) \{ ftDelParams\.push/);
    expect(DISPATCH).toMatch(/field_tool_ops edit requires a resolved organization/);
    expect(DISPATCH).toMatch(/field_tool_ops delete requires a resolved organization/);
    // The guard survives unconditionally.
    expect((DISPATCH.match(/AND is_system = false/g) || []).length).toBeGreaterThanOrEqual(2);
  });

  test('a write arm failing open is worse than a read arm, and the code says why', () => {
    expect(DISPATCH).toMatch(/A write arm that silently widens is worse than a[\s\S]{0,20}read arm/);
  });
});

describe('no agent-path INSERT lands NULL any more', () => {
  const stmts = (src, table) => {
    const out = [];
    const re = new RegExp('INSERT INTO ' + table + '[\\s\\S]{0,600}?VALUES', 'g');
    let m; while ((m = re.exec(src))) out.push(m[0]);
    return out;
  };

  test('every ai_messages INSERT names organization_id', () => {
    const s = stmts(AI, 'ai_messages');
    expect(s.length).toBeGreaterThanOrEqual(7);
    for (const q of s) {
      expect({ q: q.slice(0, 70).replace(/\s+/g, ' '), named: q.indexOf('organization_id') !== -1 })
        .toEqual({ q: q.slice(0, 70).replace(/\s+/g, ' '), named: true });
    }
  });

  test('every attachments INSERT in ai-routes names organization_id', () => {
    const s = stmts(AI, 'attachments');
    expect(s.length).toBeGreaterThanOrEqual(2);
    for (const q of s) expect(q).toMatch(/organization_id/);
  });

  test('the photo attach DERIVES the org from the parent, and never guesses', () => {
    // An attachment's tenant is its parent entity's tenant — entity_type and
    // entity_id are NOT NULL on every row and that is rung 1 of
    // attachmentInOrg's ladder. So no caller has to pass it, and an
    // unresolvable parent leaves NULL and is COUNTED rather than being stamped
    // with a tenant nothing evidenced.
    const fn = fnBody(AI, 'async function attachBase64PhotosToEntity(');
    expect(fn).toMatch(/ENTITY_TABLES\[entityType\]/);
    expect(fn).toMatch(/SELECT organization_id FROM ' \+ parentTable/);
    expect(fn).toMatch(/deliberately NOT a guess/);
  });

  test('the background job thread post uses the job row it already loaded', () => {
    const fn = fnBody(AI, 'async function postAgentJobToThread(');
    expect(fn).toMatch(/organization_id\)/);
    expect(fn).toMatch(/job\.organization_id/);
  });

  test('the background callback is handed the authoritative org, not left to re-derive', () => {
    expect(AI).toMatch(/makeBackgroundJobCallback\(job\.user_id, pauseRef, job\.organization_id\)/);
    expect(AI).toMatch(/function makeBackgroundJobCallback\(userId, pauseRef, orgId\)/);
    expect(AI).toMatch(/make86OnCustomToolUse\(userId, null, undefined, null, orgId\)/);
    // The old form threw the value away one line after using it.
    expect(AI).not.toMatch(/make86OnCustomToolUse\(userId, null\);/);
  });

  test('managed_agent_registry: the reregister row names its tenant and its real key', () => {
    // Two fatal defects, so the route 500'd rather than leaked — but the shape
    // is identical: a write that does not name its tenant. organization_id is
    // half the composite PRIMARY KEY, hence implicitly NOT NULL (23502), and
    // ON CONFLICT (agent_key) matched no unique constraint (42P10).
    expect(AGENTS).not.toMatch(/ON CONFLICT \(agent_key\) DO UPDATE/);
    expect(AGENTS).toMatch(/ON CONFLICT \(agent_key, organization_id\) DO UPDATE/);
    const seg = AGENTS.slice(AGENTS.indexOf("router.post('/managed/reregister'"));
    expect(seg.slice(0, 200)).toMatch(/requireOrgId/);
    expect(seg).toMatch(/\[key, req\.orgId, created\.id, model/);
  });
});

describe('what this commit deliberately does NOT do', () => {
  test('no tolerance arm was dropped', () => {
    // Every arm this commit touched became UNCONDITIONAL — which can only ever
    // ADD a predicate to a query that had none. Not one `OR ... IS NULL` was
    // removed, so no row that is visible today becomes invisible.
    const raw = (AI.match(/organization_id IS NULL/g) || []).length;
    expect(raw).toBeGreaterThan(30);
  });

  test('no NOT NULL constraint was added anywhere', () => {
    expect(DB).not.toMatch(/SET NOT NULL/);
  });
});
