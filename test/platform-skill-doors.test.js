/* ──────────────────────────────────────────────────────────────────────────
 * A GLOBAL STORE MUST NOT BE ADDRESSABLE BY A CALLER-SUPPLIED KEY UNDER A
 * CAPABILITY EVERY TENANT HOLDS — third instance, and the first destructive one.
 *
 * `roles` was the first. `app_settings` was the second, closed by classifying
 * the key space. This is the third, and it is different in kind: the same
 * global rows, reached by doors the classifier never sees, running DELETEs.
 *
 * WHAT WAS OPEN, verified live over HTTP before the fix:
 *   POST /api/admin/agents/skills/:idx/unsync-from-anthropic  ROLES_MANAGE
 *     org-A admin -> 200 {"agent_rows_detached":3}, the Anthropic skill
 *     DELETED account-wide, and app_settings('agent_skills') — the platform
 *     playbook — rewritten by an org admin. No undo: beta.skills.delete
 *     refuses while versions exist, so the retire path enumerates and removes
 *     every version first, and nothing puts them back.
 *   POST /api/admin/agents/skills/:idx/sync-to-anthropic      ROLES_MANAGE
 *   POST /api/admin/agents/skills/sync-all-to-anthropic       ROLES_MANAGE
 *   POST/DELETE /api/admin/agents/:agentKey/native-skills     ROLES_MANAGE
 *   DELETE /api/admin/organizations/:id/skill-packs/:packId   ROLES_MANAGE
 *     assertOrgScope refused another org's PACK and then pruned the GLOBAL
 *     playbook by NAME — and org_skill_packs is UNIQUE(organization_id,name),
 *     which constrains names inside a tenant and not across them.
 *
 * AND TWO THAT NOTHING HAD LOOKED AT, because a raw NUL byte at line 4013 of
 * admin-agents-routes.js made ripgrep abandon the file mid-scan (see
 * test/no-nul-bytes.test.js). Everything below that line was invisible to
 * every directory-recursive search this wave ran:
 *   DELETE /api/admin/agents/managed/:agentKey                ROLES_MANAGE
 *     `DELETE FROM managed_agent_registry WHERE agent_key = $1` — the table's
 *     PRIMARY KEY was migrated to (agent_key, organization_id); this statement
 *     was not, so tidying your own stale row unregistered every tenant's.
 *   POST /api/admin/agents/managed/sync-all                   ROLES_MANAGE
 *     `req.body.organization_id || req.organization.id` — believe the body,
 *     read another tenant's identity, push it to their Anthropic agents.
 *
 * WHY THE FIX IS A GATE AND NOT A WHERE CLAUSE, for the skill doors.
 * managed_agent_skills is PRIMARY KEY (agent_key, skill_id) and app_settings
 * is PRIMARY KEY (key). NEITHER HAS AN organization_id. There is no tenant
 * dimension to scope by, so "scope the DELETE" is not an available fix — it
 * would need a schema change, which is another workflow's file. What IS
 * available is the tier, and this repo had already decided it: every route in
 * admin-anthropic-routes.js is requireSystemAdmin, and /skills/versions*,
 * /evals*, /training-data and /training-export in this very file are too,
 * with the reason written down ("account-level IP, same tier as the other
 * cross-org Anthropic resources"). The classification agreed —
 * app-settings-keys.js calls `agent_skills` 'platform', SYSTEM_ADMIN both
 * ways. Three handlers simply never asked it: they reach the classified row
 * with a direct pool.query from a different router.
 * managed_agent_registry DOES have an organization_id, so that one gets the
 * WHERE clause instead. The shape of the fix follows the schema, not a mood.
 *
 * THE OTHER DIRECTION, WHICH IS HALF OF WHY THIS FILE IS LONG. This wave has
 * revived several dead features because somebody tightened without checking
 * the far side. So an org admin's own surface is pinned as still working:
 * create / list / edit / delete their own org_skill_packs end to end, read
 * which skills their agent runs, sync their OWN org. If a future tightening
 * takes those, this file goes red.
 *
 * REAL ENGINE, NOT A SCRIPT OF ANSWERS. Every claim here is about how many
 * rows a statement reached, so the statements run on node:sqlite via
 * test/helpers/pg-sqlite.js and the survivors are counted afterwards. A fake
 * pool would be answering with whatever its filter callback said, which is
 * the one thing that must not be mocked when the finding IS the WHERE clause.
 * Only the outbound Anthropic calls are stubbed, and they record what they
 * were asked to destroy.
 * ────────────────────────────────────────────────────────────────────────── */

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-platform-skill-doors-suite-0123456789abcd';
process.env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || 'sk-ant-test-key-not-used';

const express = require('express');
const http = require('http');
const path = require('path');
const { createPgSqlite } = require('./helpers/pg-sqlite');

// ── schema ────────────────────────────────────────────────────────────────
// Only the columns these routes touch, with the KEYS that matter to the
// findings: managed_agent_registry composite (agent_key, organization_id),
// managed_agent_skills (agent_key, skill_id) with NO org column, app_settings
// keyed by `key` alone. The absent column is the finding, so it is absent here.
const SCHEMA = `
  CREATE TABLE roles (name TEXT PRIMARY KEY, capabilities TEXT);
  CREATE TABLE organizations (
    id INTEGER PRIMARY KEY, slug TEXT, name TEXT, description TEXT,
    identity_body TEXT, archived_at TEXT
  );
  CREATE TABLE users (id INTEGER PRIMARY KEY, organization_id INTEGER);
  CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT, updated_at TEXT);
  CREATE TABLE agent_skills_versions (
    id INTEGER PRIMARY KEY AUTOINCREMENT, saved_by INTEGER, value TEXT,
    comment TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE managed_agent_skills (
    agent_key TEXT NOT NULL, skill_id TEXT NOT NULL,
    position INTEGER DEFAULT 0, enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (agent_key, skill_id)
  );
  CREATE TABLE managed_agent_registry (
    agent_key TEXT NOT NULL, organization_id INTEGER NOT NULL,
    anthropic_agent_id TEXT, model TEXT, tool_count INTEGER, skill_count INTEGER,
    system_hash TEXT, updated_at TEXT,
    PRIMARY KEY (agent_key, organization_id)
  );
  CREATE TABLE org_skill_packs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, organization_id INTEGER NOT NULL,
    name TEXT NOT NULL, body TEXT, description TEXT, agents TEXT,
    category TEXT, triggers TEXT, anthropic_skill_id TEXT,
    archived_at TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE admin_audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    actor_user_id INTEGER, actor_email TEXT, actor_role TEXT, action TEXT,
    target_type TEXT, target_id TEXT, organization_id INTEGER, actor_org_id INTEGER,
    detail TEXT, ip TEXT
  );
`;

let engine = createPgSqlite(SCHEMA);

// ── outbound Anthropic, recorded ──────────────────────────────────────────
// Every upstream side effect lands in `upstream` so a test can say "the
// account was not touched" as a fact rather than an inference.
const upstream = [];

// NOTHING IN THIS SUITE TALKS TO ANTHROPIC. Without this the routes construct
// a real client and the first `beta.skills.list` sits in the SDK's retry loop
// against a bad key — which is what a 300-second "hang" turns out to be. The
// stub answers instantly and records nothing, because the destructive calls
// are recorded one layer up in the service mock below.
jest.mock('@anthropic-ai/sdk', () => {
  class FakeAnthropic {
    constructor() {
      this.beta = {
        skills: {
          list: async () => ({ data: [] }),
          create: async () => ({ id: 'sk_created', display_title: 'x' }),
          delete: async () => ({ ok: true }),
          versions: { list: async () => ({ data: [] }), delete: async () => ({}) }
        },
        agents: {
          retrieve: async (id) => ({ id, archived_at: null, model: 'claude-opus-4' }),
          create: async () => ({ id: 'agent_new' }),
          update: async () => ({ id: 'agent_updated' })
        }
      };
    }
  }
  return { Anthropic: FakeAnthropic, default: FakeAnthropic, toFile: async (b, n) => ({ b, n }) };
});

jest.mock('../server/services/anthropic-skills', () => {
  const actual = jest.requireActual('../server/services/anthropic-skills');
  return Object.assign({}, actual, {
    deleteSkillDeep: async (anthropic, id) => {
      require('./platform-skill-doors.test.js.upstream').push('DELETE ' + id);
      return { ok: true, versions_deleted: 2 };
    },
    pushPackToAnthropic: async (anthropic, pack) => {
      const u = require('./platform-skill-doors.test.js.upstream');
      const prior = pack.anthropic_skill_id || null;
      const id = 'sk_new_' + Math.random().toString(36).slice(2, 8);
      u.push('CREATE ' + id + ' (' + (pack.name || '?') + ')');
      if (prior) u.push('DELETE ' + prior);
      return { id, display_title: pack.name, hash: 'h_' + id, replaced: prior,
               repointed: 0, oldDeleted: !!prior, oldDeleteError: null };
    }
  });
});

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => require('./platform-skill-doors.test.js.engine')().pool.query(sql, params),
    connect: async () => ({
      query: async (sql, params) => require('./platform-skill-doors.test.js.engine')().pool.query(sql, params),
      release: () => {}
    })
  },
  getOrgById: async (id) => {
    const rows = require('./platform-skill-doors.test.js.engine')()
      .all('SELECT * FROM organizations WHERE id = ?', id);
    return rows[0] || null;
  },
  listOrganizations: async () =>
    require('./platform-skill-doors.test.js.engine')().all('SELECT * FROM organizations')
}));

// jest.mock factories cannot close over later-declared bindings, so the two
// live values are reached through tiny resolver modules registered below.
jest.mock('./platform-skill-doors.test.js.upstream', () => [], { virtual: true });
jest.mock('./platform-skill-doors.test.js.engine', () => () => globalThis.__P86_ENGINE__, { virtual: true });

const upstreamLog = require('./platform-skill-doors.test.js.upstream');
globalThis.__P86_ENGINE__ = engine;

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

// ── actors ────────────────────────────────────────────────────────────────
// Capability-COMPLETE for their tenant. Nothing refused below can be blamed
// on a missing capability — every refusal has to be the boundary under test.
const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW',
  'ESTIMATES_EDIT', 'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE',
  'INSIGHTS_VIEW', 'ADMIN_METRICS'
];
const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
const OWNER       = { id: 1,  email: 'owner@p86.test', role: 'system_admin', name: 'Owner', organization_id: 1 };

const PLATFORM_SKILL_ID = 'sk_real_123';

function seed() {
  globalThis.__P86_ENGINE__ = engine = createPgSqlite(SCHEMA);
  const db = engine.db;
  const ins = (sql, ...a) => db.prepare(sql).run(...a);

  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)',
    'system_admin', JSON.stringify(ADMIN_CAPS.concat(['SYSTEM_ADMIN'])));
  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)',
    'admin', JSON.stringify(ADMIN_CAPS));
  ins('INSERT INTO roles (name, capabilities) VALUES (?, ?)',
    'pm', JSON.stringify(['JOBS_VIEW_ALL', 'ESTIMATES_VIEW']));

  ins('INSERT INTO organizations (id, slug, name, description, identity_body) VALUES (?,?,?,?,?)',
    1, 'agx', 'AGX Central Florida', 'Org A description', 'A identity');
  ins('INSERT INTO organizations (id, slug, name, description, identity_body) VALUES (?,?,?,?,?)',
    2, 'other', 'Other Tenant', 'Org B description', 'B identity');

  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 10, 1);
  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 77, 2);
  ins('INSERT INTO users (id, organization_id) VALUES (?,?)', 1, 1);

  // The platform playbook: two packs, the first mirrored upstream.
  ins('INSERT INTO app_settings (key, value, updated_at) VALUES (?,?,?)',
    'agent_skills', JSON.stringify({
      skills: [
        { id: 'p1', name: 'estimating', body: 'platform doctrine', anthropic_skill_id: PLATFORM_SKILL_ID },
        { id: 'p2', name: 'scheduling', body: 'more doctrine', anthropic_skill_id: 'sk_real_456' }
      ]
    }), 't');

  // Three agents across the platform run the mirrored skill. THREE — the
  // number the live run reported as agent_rows_detached.
  ['job', 'assistant', 'scribe'].forEach((k, i) =>
    ins('INSERT INTO managed_agent_skills (agent_key, skill_id, position, enabled) VALUES (?,?,?,1)',
      k, PLATFORM_SKILL_ID, i));

  // One registry row per tenant for the same agent_key — the composite PK.
  ins('INSERT INTO managed_agent_registry (agent_key, organization_id, anthropic_agent_id, model) VALUES (?,?,?,?)',
    'job', 1, 'agent_org_a', 'claude-opus-4');
  ins('INSERT INTO managed_agent_registry (agent_key, organization_id, anthropic_agent_id, model) VALUES (?,?,?,?)',
    'job', 2, 'agent_org_b', 'claude-opus-4');

  upstreamLog.length = 0;
}

let server, baseUrl;

function req(method, urlPath, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + urlPath);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: Object.assign(
        { Authorization: 'Bearer ' + signToken(user) },
        payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}
      )
    }, (resp) => {
      let raw = '';
      resp.on('data', (c) => { raw += c; });
      resp.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON */ }
        resolve({ status: resp.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

// State readers — plain SQL, so an assertion is about the database and not
// about anything the route chose to report.
const playbook = () =>
  (engine.all("SELECT value FROM app_settings WHERE key = 'agent_skills'")[0] || {}).value || {};
const playbookNames = () => (playbook().skills || []).map((s) => s.name);
const attachedCount = (skillId) =>
  engine.all('SELECT * FROM managed_agent_skills WHERE skill_id = ?', skillId).length;
const registryRows = (agentKey) =>
  engine.all('SELECT * FROM managed_agent_registry WHERE agent_key = ?', agentKey);
const auditRows = (action) =>
  engine.all('SELECT * FROM admin_audit_log WHERE action = ?', action);

beforeAll(async () => {
  seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  // admin-agents-routes arms a boot setTimeout + a 15-minute setInterval for
  // the reference-link refresh sweep at MODULE SCOPE, and deliberately keeps
  // no handle ("process exit cleans up"). In a jest worker there is no process
  // exit, so the sweep fires against a torn-down environment. Fake timers
  // during the require swallow both; dropping back to real timers discards
  // them. Nothing under test uses a timer.
  jest.useFakeTimers();
  const agentsRouter = require('../server/routes/admin-agents-routes');
  const orgsRouter = require('../server/routes/admin-organizations-routes');
  jest.useRealTimers();
  app.use('/api/admin/agents', agentsRouter);
  app.use('/api/admin/organizations', orgsRouter);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(async () => {
  seed();
  await refreshRoleCache();
});

// ═══════════════════════════════════════════════════════════════════════════
// M1 — the highest one. An org admin deleted an Anthropic skill account-wide.
// ═══════════════════════════════════════════════════════════════════════════
describe('unsync-from-anthropic: an org admin cannot destroy an account-wide skill', () => {
  const DOOR = '/api/admin/agents/skills/0/unsync-from-anthropic';

  test('org-A admin is refused, and the refusal is total', async () => {
    const r = await req('POST', DOOR, ORG_A_ADMIN, { confirm: 'estimating' });
    expect(r.status).toBe(403);
    // Not merely "no 200": nothing upstream, nothing detached, nothing rewritten.
    expect(upstreamLog).toEqual([]);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(3);
    expect(playbookNames()).toEqual(['estimating', 'scheduling']);
    expect(playbook().skills[0].anthropic_skill_id).toBe(PLATFORM_SKILL_ID);
  });

  test('org-B admin, the other tenant, is refused identically', async () => {
    const r = await req('POST', DOOR, ORG_B_ADMIN, { confirm: 'estimating' });
    expect(r.status).toBe(403);
    expect(upstreamLog).toEqual([]);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(3);
  });

  test('the refusal happens before the row is even read', async () => {
    await req('POST', DOOR, ORG_A_ADMIN, { confirm: 'estimating' });
    const touched = engine.log.filter((e) => /app_settings|managed_agent_skills/.test(e.sql));
    expect(touched).toEqual([]);
  });

  // The platform owner keeps the capability — a boundary, not an outage.
  test('the platform owner can still unsync, with the confirmation', async () => {
    const r = await req('POST', DOOR, OWNER, { confirm: 'estimating' });
    expect(r.status).toBe(200);
    expect(r.body.agent_rows_detached).toBe(3);
    expect(upstreamLog).toContain('DELETE ' + PLATFORM_SKILL_ID);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(0);
    expect(playbook().skills[0].anthropic_skill_id).toBeUndefined();
  });
});

// A destructive platform operation deserves more than a gate: privilege
// answers "may you", the confirmation answers "did you mean to".
describe('unsync-from-anthropic: the irreversible delete needs a typed confirmation', () => {
  const DOOR = '/api/admin/agents/skills/0/unsync-from-anthropic';

  test('the platform owner with no confirmation is refused, and nothing moves', async () => {
    const r = await req('POST', DOOR, OWNER, {});
    expect(r.status).toBe(400);
    expect(r.body.required_confirmation).toBe('name');
    expect(upstreamLog).toEqual([]);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(3);
  });

  test('a WRONG confirmation is refused — it is a match, not a checkbox', async () => {
    for (const wrong of ['Estimating', 'estimating ', 'scheduling', '', 'yes', true, 1]) {
      seed();
      const r = await req('POST', DOOR, OWNER, { confirm: wrong });
      expect({ wrong, status: r.status }).toEqual({ wrong, status: 400 });
      expect(upstreamLog).toEqual([]);
    }
  });

  test('the refusal leaves the row byte-identical — no half-done detach', async () => {
    const before = JSON.stringify(playbook());
    const beforeAttached = attachedCount(PLATFORM_SKILL_ID);
    await req('POST', DOOR, OWNER, { confirm: 'nope' });
    expect(JSON.stringify(playbook())).toBe(before);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(beforeAttached);
  });
});

// Broad authority is only safe if it is recorded. The direct SYSTEM_ADMIN
// delete door in admin-anthropic-routes.js already wrote this row; the doors
// in admin-agents-routes.js destroyed the same upstream skills silently.
describe('every upstream skill delete now leaves an audit row', () => {
  test('unsync writes anthropic.skill_delete naming the skill and the door', async () => {
    await req('POST', '/api/admin/agents/skills/0/unsync-from-anthropic', OWNER, { confirm: 'estimating' });
    const rows = auditRows('anthropic.skill_delete');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe(PLATFORM_SKILL_ID);
    expect(rows[0].actor_email).toBe(OWNER.email);
    expect(rows[0].detail.via).toBe('agents/skills/:idx/unsync-from-anthropic');
  });

  test('a re-sync that REPLACES an upstream skill is audited under the same action', async () => {
    // This is the point the previous pass missed: sync is not "push existing
    // content". pushPackToAnthropic creates, re-points, then deletes the prior
    // skill. One audit row per destroyed skill, whichever door destroyed it.
    await req('POST', '/api/admin/agents/skills/0/sync-to-anthropic', OWNER, {});
    const rows = auditRows('anthropic.skill_delete');
    expect(rows.length).toBe(1);
    expect(rows[0].target_id).toBe(PLATFORM_SKILL_ID);
    expect(upstreamLog).toContain('DELETE ' + PLATFORM_SKILL_ID);
  });

  test('a refused call writes no audit row — the log records acts, not attempts', async () => {
    await req('POST', '/api/admin/agents/skills/0/unsync-from-anthropic', ORG_A_ADMIN, { confirm: 'estimating' });
    expect(auditRows('anthropic.skill_delete')).toEqual([]);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M2 + sync-all — the same row, the same account, the same answer.
// ═══════════════════════════════════════════════════════════════════════════
describe('the sync doors write the platform playbook, so they are the owner\'s too', () => {
  test('sync-to-anthropic refuses an org admin and leaves the row untouched', async () => {
    const before = JSON.stringify(playbook());
    const r = await req('POST', '/api/admin/agents/skills/0/sync-to-anthropic', ORG_A_ADMIN, {});
    expect(r.status).toBe(403);
    expect(JSON.stringify(playbook())).toBe(before);
    expect(upstreamLog).toEqual([]);
  });

  test('sync-all-to-anthropic refuses an org admin', async () => {
    const before = JSON.stringify(playbook());
    const r = await req('POST', '/api/admin/agents/skills/sync-all-to-anthropic', ORG_A_ADMIN, {});
    expect(r.status).toBe(403);
    expect(JSON.stringify(playbook())).toBe(before);
    expect(upstreamLog).toEqual([]);
  });

  test('sync-all IS destructive, which is why it moved with the others', async () => {
    // The carve-out that left this door open reasoned it "only pushes existing
    // content". Run it as the owner and watch it delete two upstream skills.
    const r = await req('POST', '/api/admin/agents/skills/sync-all-to-anthropic', OWNER, {});
    expect(r.status).toBe(200);
    expect(upstreamLog.filter((u) => u.startsWith('DELETE'))).toEqual([
      'DELETE ' + PLATFORM_SKILL_ID, 'DELETE sk_real_456'
    ]);
    expect(auditRows('anthropic.skill_delete').length).toBe(2);
  });

  test('the owner can still sync one pack — the capability survives the gate', async () => {
    const r = await req('POST', '/api/admin/agents/skills/0/sync-to-anthropic', OWNER, {});
    expect(r.status).toBe(200);
    expect(r.body.anthropic_skill_id).toMatch(/^sk_new_/);
    expect(playbook().skills[0].anthropic_skill_id).toBe(r.body.anthropic_skill_id);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// Below the NUL byte — doors no scan in this wave could see.
// ═══════════════════════════════════════════════════════════════════════════
describe('native skill attachments are one list for the whole platform', () => {
  test('an org admin cannot detach a skill from the platform\'s agent', async () => {
    const r = await req('DELETE',
      '/api/admin/agents/job/native-skills/' + PLATFORM_SKILL_ID, ORG_A_ADMIN);
    expect(r.status).toBe(403);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(3);
  });

  test('an org admin cannot attach one either', async () => {
    const r = await req('POST', '/api/admin/agents/job/native-skills', ORG_A_ADMIN,
      { skill_id: 'sk_attacker_pack' });
    expect(r.status).toBe(403);
    expect(attachedCount('sk_attacker_pack')).toBe(0);
  });

  test('the owner still attaches and detaches', async () => {
    expect((await req('POST', '/api/admin/agents/job/native-skills', OWNER,
      { skill_id: 'sk_owner_pack' })).status).toBe(200);
    expect(attachedCount('sk_owner_pack')).toBe(1);
    expect((await req('DELETE', '/api/admin/agents/job/native-skills/sk_owner_pack', OWNER)).status).toBe(200);
    expect(attachedCount('sk_owner_pack')).toBe(0);
  });

  test('READING the list stays open to an org admin — only changing it moved', async () => {
    const r = await req('GET', '/api/admin/agents/job/native-skills', ORG_A_ADMIN);
    expect(r.status).not.toBe(403);
  });
});

describe('deleting a managed-agent registry row reaches one tenant, not all', () => {
  test('org-A deleting its own row leaves org-B registered', async () => {
    expect(registryRows('job').length).toBe(2);
    const r = await req('DELETE', '/api/admin/agents/managed/job', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    const left = registryRows('job');
    expect(left.length).toBe(1);
    expect(left[0].organization_id).toBe(2);
    expect(left[0].anthropic_agent_id).toBe('agent_org_b');
  });

  test('and it returns ITS OWN agent id, not whichever row sorted first', async () => {
    const r = await req('DELETE', '/api/admin/agents/managed/job', ORG_B_ADMIN);
    expect(r.body.freed_anthropic_agent_id).toBe('agent_org_b');
    expect(registryRows('job').map((x) => x.organization_id)).toEqual([1]);
  });

  test('deleting an agent_key this tenant has no row for is a 404, not a hit on someone else', async () => {
    engine.db.prepare('DELETE FROM managed_agent_registry WHERE organization_id = 1').run();
    const r = await req('DELETE', '/api/admin/agents/managed/job', ORG_A_ADMIN);
    expect(r.status).toBe(404);
    expect(registryRows('job').length).toBe(1); // org-B's row survives
  });
});

describe('sync-all does not take an organization_id on the caller\'s word', () => {
  test('org-A asking for org-B is refused', async () => {
    const r = await req('POST', '/api/admin/agents/managed/sync-all', ORG_A_ADMIN,
      { organization_id: 2 });
    expect(r.status).toBe(403);
    // And it never read org-B's identity to push it anywhere.
    expect(engine.log.filter((e) => /FROM managed_agent_registry/.test(e.sql))).toEqual([]);
  });

  test('refused, not silently downgraded to their own org', async () => {
    // Downgrading would make a script aimed at the wrong tenant look like it
    // worked. A 403 is the only answer that tells the caller the truth.
    const r = await req('POST', '/api/admin/agents/managed/sync-all', ORG_A_ADMIN,
      { organization_id: 2 });
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/own organization/i);
  });

  test('asking for their OWN org by number is fine', async () => {
    const r = await req('POST', '/api/admin/agents/managed/sync-all', ORG_A_ADMIN,
      { organization_id: 1 });
    expect(r.status).not.toBe(403);
  });

  test('omitting it is fine and means "mine"', async () => {
    const r = await req('POST', '/api/admin/agents/managed/sync-all', ORG_A_ADMIN, {});
    expect(r.status).not.toBe(403);
  });

  test('the platform owner may still name a tenant', async () => {
    const r = await req('POST', '/api/admin/agents/managed/sync-all', OWNER,
      { organization_id: 2 });
    expect(r.status).not.toBe(403);
  });

  test('a non-numeric organization_id is a 400, not a coerced 0', async () => {
    const r = await req('POST', '/api/admin/agents/managed/sync-all', ORG_A_ADMIN,
      { organization_id: 'all' });
    expect(r.status).toBe(400);
  });
});

describe('anthropic-state answers about the caller\'s own agent', () => {
  test('org-A sees org-A\'s registered agent, never org-B\'s', async () => {
    // Before scoping this was `WHERE agent_key = $1` then rows[0] — whichever
    // tenant's row the planner returned first.
    engine.db.prepare('DELETE FROM managed_agent_registry WHERE organization_id = 1').run();
    const r = await req('GET', '/api/admin/agents/managed/job/anthropic-state', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.registered).toBe(false);
    expect(JSON.stringify(r.body)).not.toContain('agent_org_b');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// M3 — the prune keyed on a string the caller chooses.
// ═══════════════════════════════════════════════════════════════════════════
describe('deleting an org pack cannot prune a platform pack that shares its name', () => {
  function makeOrgPack(orgId, name, skillId) {
    const r = engine.db.prepare(
      'INSERT INTO org_skill_packs (organization_id, name, body, anthropic_skill_id) VALUES (?,?,?,?) RETURNING id'
    ).all(orgId, name, 'body', skillId || null);
    return r[0].id;
  }

  test('the collision is REFUSED — the platform entry survives', async () => {
    // org_skill_packs is UNIQUE(organization_id, name): nothing stops org-A
    // naming a pack after a platform one. This was the whole exploit.
    const packId = makeOrgPack(1, 'estimating', null);
    const r = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.agent_skills_entries_removed).toBe(0);
    expect(playbookNames()).toEqual(['estimating', 'scheduling']);
  });

  test('and the caller is TOLD, rather than silently skipped', async () => {
    const packId = makeOrgPack(1, 'estimating', null);
    const r = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    expect(r.body.agent_skills_prune_skipped).toMatch(/shares this pack's name/i);
  });

  test('the org pack itself IS deleted — the refusal is about the global row only', async () => {
    const packId = makeOrgPack(1, 'estimating', null);
    await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    const row = engine.all('SELECT archived_at FROM org_skill_packs WHERE id = ?', packId)[0];
    expect(row.archived_at).not.toBeNull();
  });

  test('a pack that shares the platform pack\'s ID does prune — id is provable, name is not', async () => {
    // The legitimate case the prune exists for: the same pack mirrored into
    // both stores, so the ids match and "these are the same pack" is a fact.
    const packId = makeOrgPack(1, 'anything at all', PLATFORM_SKILL_ID);
    const r = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    expect(r.body.agent_skills_entries_removed).toBe(1);
    expect(playbookNames()).toEqual(['scheduling']);
  });

  test('another org cannot delete org-A\'s pack at all — assertOrgScope still holds', async () => {
    const packId = makeOrgPack(1, 'estimating', null);
    const r = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_B_ADMIN);
    expect(r.status).toBe(403);
    expect(playbookNames()).toEqual(['estimating', 'scheduling']);
  });

  test('an unmirrored pack with no name collision says so plainly', async () => {
    const packId = makeOrgPack(1, 'a name nothing else uses', null);
    const r = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    expect(r.body.agent_skills_entries_removed).toBe(0);
    expect(r.body.agent_skills_prune_skipped).toMatch(/never mirrored/i);
    expect(playbookNames()).toEqual(['estimating', 'scheduling']);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// THE OTHER DIRECTION. An org admin's own surface, end to end.
// ═══════════════════════════════════════════════════════════════════════════
describe('an org admin still runs their own tenant\'s skill packs, start to finish', () => {
  test('create, list, rename, delete — all 2xx, all scoped to their org', async () => {
    const created = await req('POST', '/api/admin/organizations/1/skill-packs', ORG_A_ADMIN,
      { name: 'A tenant pack', body: 'our own doctrine', agents: ['job'] });
    expect(created.status).toBe(200);
    const packId = created.body.skill_pack && created.body.skill_pack.id;
    expect(packId).toBeTruthy();

    const list = await req('GET', '/api/admin/organizations/1/skill-packs', ORG_A_ADMIN);
    expect(list.status).toBe(200);
    expect(JSON.stringify(list.body)).toContain('A tenant pack');

    const del = await req('DELETE', '/api/admin/organizations/1/skill-packs/' + packId, ORG_A_ADMIN);
    expect(del.status).toBe(200);

    // Their whole round trip touched neither the platform playbook nor the
    // platform's agent attachments.
    expect(playbookNames()).toEqual(['estimating', 'scheduling']);
    expect(attachedCount(PLATFORM_SKILL_ID)).toBe(3);
  });

  test('org-B doing the same never appears in org-A\'s list', async () => {
    await req('POST', '/api/admin/organizations/2/skill-packs', ORG_B_ADMIN,
      { name: 'B tenant pack', body: 'theirs', agents: ['job'] });
    const list = await req('GET', '/api/admin/organizations/1/skill-packs', ORG_A_ADMIN);
    expect(JSON.stringify(list.body)).not.toContain('B tenant pack');
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// The shape of the whole surface, asserted from the source so a new door
// cannot quietly join the wrong tier.
// ═══════════════════════════════════════════════════════════════════════════
describe('the gate on every Anthropic-account-wide door, read off the source', () => {
  const fs = require('fs');
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'routes', 'admin-agents-routes.js'), 'utf8');

  // METHOD matters: /:agentKey/native-skills is a GET at ROLES_MANAGE and a
  // POST at SYSTEM_ADMIN, and reading the first match would have called the
  // write door open. That miss is the same shape as the finding.
  function gateFor(method, routePath) {
    const lines = src.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (!new RegExp('^router\\.' + method.toLowerCase() + '\\(').test(lines[i])) continue;
      const head = lines.slice(i, i + 6).join(' ').split('=>')[0];
      const m = head.match(/^router\.[a-z]+\(\s*'([^']*)'/);
      if (!m || m[1] !== routePath) continue;
      return /requireSystemAdmin/.test(head) ? 'SYSTEM_ADMIN'
        : (head.match(/requireCapability\('([^']+)'\)/) || [])[1] || 'NONE';
    }
    return 'ROUTE NOT FOUND';
  }

  test('every account-wide / platform-playbook door sits at SYSTEM_ADMIN', () => {
    expect({
      syncAll:   gateFor('post', '/skills/sync-all-to-anthropic'),
      syncOne:   gateFor('post', '/skills/:idx/sync-to-anthropic'),
      unsyncOne: gateFor('post', '/skills/:idx/unsync-from-anthropic'),
      attach:    gateFor('post', '/:agentKey/native-skills'),
      detach:    gateFor('delete', '/:agentKey/native-skills/:skillId')
    }).toEqual({
      syncAll: 'SYSTEM_ADMIN', syncOne: 'SYSTEM_ADMIN', unsyncOne: 'SYSTEM_ADMIN',
      attach: 'SYSTEM_ADMIN', detach: 'SYSTEM_ADMIN'
    });
  });

  test('the per-tenant doors stay at ROLES_MANAGE — this is a boundary, not a lockout', () => {
    expect({
      readAttachments: gateFor('get', '/:agentKey/native-skills'),
      syncOwnOrg:      gateFor('post', '/managed/sync-all'),
      deleteOwnRow:    gateFor('delete', '/managed/:agentKey'),
      state:           gateFor('get', '/managed/:agentKey/anthropic-state')
    }).toEqual({
      readAttachments: 'ROLES_MANAGE', syncOwnOrg: 'ROLES_MANAGE',
      deleteOwnRow: 'ROLES_MANAGE', state: 'ROLES_MANAGE'
    });
  });

  test('no route in this file addresses managed_agent_registry without an org id', () => {
    // The M5 shape: a statement against the composite-PK table that names only
    // agent_key. Any future one fails here.
    const bad = [];
    const re = /(FROM|INTO|UPDATE)\s+managed_agent_registry\b[\s\S]{0,240}?(?=;|`)/g;
    let m;
    while ((m = re.exec(src)) !== null) {
      const frag = m[0];
      if (!/WHERE/i.test(frag)) continue;
      if (/agent_key\s*=/.test(frag) && !/organization_id/.test(frag)) bad.push(frag.replace(/\s+/g, ' ').slice(0, 120));
    }
    expect(bad).toEqual([]);
  });
});
