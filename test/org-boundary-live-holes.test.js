// Four cross-tenant paths that no amount of stamping or arm-dropping closes.
//
// The endgame's whole shape is "stamp every row, then remove the tolerance".
// That shape has a blind spot: a door with NO PREDICATE AT ALL. Stamping every
// row in the database and dropping all 295 arms would not have moved any of
// the four below, because none of them has a predicate to tighten. They are
// gated on no count, they cost a middleware and a SELECT, and three of them
// are reachable today by any org admin.
//
//   1. ai_replays / ai_messages — the replay pair carried ROLES_MANAGE and
//      nothing else, while its two immediate siblings carry requireOrg PLUS an
//      explicit users-in-org check with a comment naming the audit finding.
//   2. attachment_folder_grants — written from a body-supplied sub_id with no
//      sub-org check anywhere in the file, producing a durable read channel.
//   3. ai_evals / ai_eval_runs / agent_skills_versions — no organization_id
//      and none can be invented, behind a capability every org admin holds.
//   4. schedule_entries — `OR s.job_id IS NULL`, an arm that names neither the
//      caller nor the caller's org, so draining the column to zero leaves it
//      wide open.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const AGENTS = read('server', 'routes', 'admin-agents-routes.js');
const PO = read('server', 'routes', 'purchase-order-routes.js');
const SCHED = read('server', 'routes', 'schedule-routes.js');
const CLASSIFY = require('../server/services/org-table-classification');

// Every middleware named on one route mount line.
function mountLine(src, verb, routePath) {
  const needle = "router." + verb + "('" + routePath + "'";
  const i = src.indexOf(needle);
  if (i === -1) throw new Error('no mount: ' + verb + ' ' + routePath);
  const rest = src.slice(i);
  return rest.slice(0, rest.indexOf('=> {') + 4);
}

describe('1. the replay pair reads another tenant\'s conversation verbatim', () => {
  test('both doors now carry requireOrg, like their two siblings', () => {
    for (const [verb, p] of [['get', '/conversations/:key/replays'], ['post', '/conversations/:key/replay']]) {
      const line = mountLine(AGENTS, verb, p);
      expect({ p, org: /requireOrg/.test(line) }).toEqual({ p, org: true });
    }
  });

  test('both doors prove the conversation\'s USER is in the caller\'s org', () => {
    // The key is entity_type|entity_id|user_id and users.id is SERIAL, so the
    // key is trivially forgeable. The replay handler split it off the URL and
    // ran a bare `WHERE entity_type=$1 AND estimate_id=$2 AND user_id=$3`.
    expect(AGENTS).toMatch(/async function assertConversationOwnerInOrg/);
    expect(AGENTS).toMatch(/SELECT 1 FROM users WHERE id = \$1 AND organization_id = \$2/);
    const calls = (AGENTS.match(/await assertConversationOwnerInOrg\(req, res, /g) || []).length;
    expect(calls).toBe(2);
  });

  test('the guard runs BEFORE the messages are read', () => {
    const seg = AGENTS.slice(AGENTS.indexOf("router.post('/conversations/:key/replay'"));
    const head = seg.slice(0, seg.indexOf('SELECT role, content, model FROM ai_messages'));
    expect(head).toMatch(/assertConversationOwnerInOrg/);
  });

  test('it refuses with 404, not 403 — the response must not confirm existence', () => {
    const fn = AGENTS.slice(AGENTS.indexOf('async function assertConversationOwnerInOrg'));
    const body = fn.slice(0, fn.indexOf('\n}'));
    expect(body).toMatch(/status\(404\)/);
    expect(body).not.toMatch(/status\(403\)/);
  });

  test('this class is invisible to the rest of the endgame, and the code says so', () => {
    expect(AGENTS).toMatch(/there is no predicate here to tighten and no column to stamp/i);
  });
});

describe('2. a body-supplied sub_id bought a durable read channel', () => {
  test('purchase-order-routes now proves the sub is in the tenant', () => {
    // Before: ZERO occurrences of subInOrg / parentSubInOrgSql in the whole
    // file, while it wrote attachment_folder_grants keyed on req.body.sub_id.
    expect(PO).toMatch(/require\('\.\.\/services\/sub-org-scope'\)/);
    expect(PO).toMatch(/await subInOrg\(pool, subId, orgId\)/);
  });

  test('it fails CLOSED — no org, or a foreign sub, grants nothing', () => {
    const fn = PO.slice(PO.indexOf('async function syncSubAccessForPO'));
    const head = fn.slice(0, fn.indexOf('INSERT INTO job_subs'));
    expect(head).toMatch(/if \(orgId == null \|\| !\(await subInOrg/);
    expect(head).toMatch(/return;/);
  });

  test('the refusal is logged — a skipped grant and a foreign grant look identical outside', () => {
    expect(PO).toMatch(/\[po sub-access\] refused:/);
  });

  test('the caller\'s org actually reaches the function', () => {
    expect((PO.match(/syncSubAccessForPO\(rows\[0\], req\.user\.id, req\.user\.organization_id\)/g) || []).length).toBe(2);
    expect(PO).not.toMatch(/syncSubAccessForPO\(rows\[0\], req\.user\.id\);/);
  });

  test('the file records why STAMPING could not have caught this', () => {
    // The job_subs INSERT already reads organization_id off the PARENT JOB, so
    // a forged assignment lands stamped with the victim's org and is
    // indistinguishable from their own data — stamping REMOVED the tell.
    expect(PO).toMatch(/Stamping the[\s\S]{0,30}row REMOVED the orphaned-NULL tell/);
  });
});

describe('3. tables with no tenant sat behind a capability every org admin holds', () => {
  const PLATFORM_ROUTES = [
    ['get', '/skills/versions'], ['get', '/skills/versions/:id'],
    ['post', '/skills/versions/:id/restore'],
    ['get', '/evals'], ['get', '/evals/:id'], ['post', '/evals'],
    ['put', '/evals/:id'], ['delete', '/evals/:id'], ['post', '/evals/:id/run'],
  ];

  test('every one is SYSTEM_ADMIN now, and none is ROLES_MANAGE', () => {
    for (const [verb, p] of PLATFORM_ROUTES) {
      const line = mountLine(AGENTS, verb, p);
      expect({ p, sys: /requireSystemAdmin/.test(line), roles: /ROLES_MANAGE/.test(line) })
        .toEqual({ p, sys: true, roles: false });
    }
  });

  test('the classification records WHY each has no tenant, not just that it does not', () => {
    for (const t of ['ai_evals', 'ai_eval_runs', 'agent_skills_versions']) {
      expect(CLASSIFY.classify(t)).toBe('platform');
    }
    // The load-bearing sentence: a child cannot carry a tenant its parent does
    // not have. agent_skills_versions snapshots app_settings, which is
    // `key TEXT PRIMARY KEY` with no tenant — so adding a column would invent
    // one rather than record one.
    expect(CLASSIFY.PLATFORM.agent_skills_versions).toMatch(/app_settings/);
    expect(AGENTS).toMatch(/A CHILD CANNOT CARRY A TENANT[\s\S]{0,20}ITS PARENT DOES NOT HAVE/);
  });

  test('the fix is the capability, not a column — and the code says which', () => {
    expect(AGENTS).toMatch(/The defect is the[\s\S]{0,20}CAPABILITY, not the missing column/);
  });
});

describe('4. an arm that stamping can never drain', () => {
  test('the schedule list read no longer carries the unconditional open arm', () => {
    // `OR s.job_id IS NULL` names neither the caller nor the caller's org, so
    // EVERY standalone entry in EVERY tenant passed for everybody. Draining
    // organization_id to zero leaves it exactly as open, because it keys on
    // job_id. org-access.js fixed this shape on the PUT/DELETE gate; the LIST
    // READ was never converted.
    expect(SCHED).not.toMatch(/OR s\.job_id IS NULL\)/);
    expect(SCHED).toMatch(/s\.job_id IS NOT NULL AND \(j\.organization_id/);
    expect(SCHED).toMatch(/s\.job_id IS NULL AND \(s\.organization_id/);
  });

  test('the two arms are DISJOINT on s.job_id, so the LEFT JOIN cannot re-open it', () => {
    // A job-less entry makes j.organization_id NULL; without disjointness a
    // tolerance arm on the job would pass it unconditionally all over again.
    const seg = SCHED.slice(SCHED.indexOf("router.get('/',"));
    const w = seg.slice(seg.indexOf('where.push('), seg.indexOf('const sql ='));
    expect(w).toMatch(/s\.job_id IS NOT NULL/);
    expect(w).toMatch(/s\.job_id IS NULL/);
  });

  test('job-linked entries scope through the JOB\'S COLUMN, not the owner', () => {
    // services/job-org-scope.js declares the column canonical. This converges
    // the read onto it, and drops the owner join that disagreed.
    const seg = SCHED.slice(SCHED.indexOf("router.get('/',"));
    const sql = seg.slice(seg.indexOf('const sql ='), seg.indexOf('ORDER BY s.start_date'));
    expect(sql).toMatch(/LEFT JOIN users uc ON uc\.id = s\.created_by/);
    expect(sql).not.toMatch(/LEFT JOIN users u ON u\.id = j\.owner_id/);
  });

  test('it hides nothing at AGX, and the reason is written down', () => {
    // The only rows removed are standalone entries stamped to ANOTHER tenant
    // or created by another tenant's user — an empty set while AGX is the only
    // organization. A NULL-org standalone entry created by a NULL-org user
    // still passes both tolerance arms.
    expect(SCHED).toMatch(/WHAT THIS HIDES TODAY: nothing/);
    expect(SCHED).toMatch(/still passes both tolerance/);
  });
});

describe('the safety property still holds for this commit', () => {
  test('no tolerance arm was removed from any direct-column table', () => {
    // The one arm rewritten (schedule) was a job_id arm, not an
    // organization_id arm, and it was replaced by a STRICTLY MORE TOLERANT
    // chain on organization_id: own stamp OR creator's org, each with its own
    // IS NULL.
    expect((SCHED.match(/organization_id IS NULL/g) || []).length).toBeGreaterThanOrEqual(4);
  });

  test('no NOT NULL constraint was added', () => {
    expect(read('server', 'db.js')).not.toMatch(/SET NOT NULL/);
  });
});
