// A global store must not be addressable by a caller-supplied key under a
// capability every tenant holds.
//
// WHAT WAS OPEN
// `app_settings` is GLOBAL — `key TEXT PRIMARY KEY`, no organization_id, one
// row per key for the whole platform. settings-routes.js addressed it by a
// caller-supplied key with NO allowlist:
//
//   GET  /api/settings/:key   requireCapability('ESTIMATES_VIEW')  -> every PM
//   PUT  /api/settings/:key   requireCapability('ROLES_MANAGE')    -> every org admin
//
// so the KEY SPACE was the attack surface, not any individual handler. Verified
// live over HTTP before the fix, and pinned red-then-green below:
//
//   GET  /api/settings/vapid_keys    plain PM, either tenant -> 200, the
//        platform's VAPID PRIVATE KEY in cleartext. push.js generates and
//        persists that pair here whenever the env vars are unset.
//   GET  /api/settings/agent_skills  plain PM, other tenant -> 200, the whole
//        platform agent-playbook blob.
//   PUT  /api/settings/agent_skills  org-A admin -> 200. The route's own
//        preserveSkillIds re-attached the real anthropic_skill_id, so the
//        injected body would ride the next managed/sync-all UPSTREAM.
//   PUT  /api/settings/vapid_keys    org-A admin -> 200, keypair replaced.
//   PUT  /api/settings/brand_new_key org-A admin -> 200, arbitrary global key.
//
// THE LAST ONE IS NOT COSMETIC, WHICH IS WHY THE ALLOWLIST IS CLOSED
// db.js guards one-shot data migrations with SENTINEL rows in this table, each
// running only while its key is ABSENT. An open PUT lets any org admin
// pre-create a sentinel and suppress a migration for the whole platform,
// silently and permanently. A denylist of "the scary keys" would not have
// caught that; only enumerating what IS addressable does.
//
// THE OTHER DIRECTION, WHICH IS HALF OF WHY THIS FILE IS LONG
// This wave has revived three dead features because somebody tightened without
// checking the far side. So every legitimate caller is pinned as still-working
// too: the estimate preview still reads the proposal template, the BT exporter
// still reads its cost-code map, and Admin -> Templates still saves both in one
// go as an ORG ADMIN. If a future tightening takes those, this file goes red.
//
// AND: NO EXISTENCE ORACLE. A key that is unknown, secret, internal, owned by
// another door, or merely above the caller's tier must answer EXACTLY like an
// absent key — same status, same body. Asserted by comparing responses to each
// other rather than to a hardcoded literal, so the property survives a reword.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-app-settings-key-space-suite-0123456789';

const express = require('express');
const http = require('http');

let tables;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  },
  getOrgById: async (id) => ({ id, name: 'Org ' + id })
}));

// A table-backed fake, not a script of canned answers. Half the properties
// under test are about what the row CONTAINS after a write (did the platform
// playbook actually get replaced; did the keypair actually survive), and those
// are only meaningful against real mutable state.
function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: tables.roles };

  if (/^SELECT key, value, updated_at FROM app_settings WHERE key = \$1/.test(text)) {
    const hit = tables.app_settings.find((r) => r.key === p[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (/^SELECT value FROM app_settings WHERE key = 'agent_skills'/.test(text)) {
    const hit = tables.app_settings.find((r) => r.key === 'agent_skills');
    return { rows: hit ? [{ value: hit.value }] : [] };
  }
  if (/^INSERT INTO app_settings/.test(text)) {
    const key = p[0];
    const value = JSON.parse(p[1]);
    const hit = tables.app_settings.find((r) => r.key === key);
    if (hit) hit.value = value;
    else tables.app_settings.push({ key, value, updated_at: new Date().toISOString() });
    return { rows: [], rowCount: 1 };
  }
  if (/^INSERT INTO agent_skills_versions/.test(text)) return { rows: [], rowCount: 1 };
  if (/^DELETE FROM managed_agent_skills WHERE skill_id = \$1/.test(text)) {
    const before = tables.managed_agent_skills.length;
    tables.managed_agent_skills = tables.managed_agent_skills.filter((r) => r.skill_id !== p[0]);
    return { rows: [], rowCount: before - tables.managed_agent_skills.length };
  }
  if (/^UPDATE org_skill_packs/.test(text)) return { rows: [], rowCount: 0 };

  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');
const keySpace = require('../server/services/app-settings-keys');

setRolePool(pool);

let server, baseUrl;

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW',
  'ESTIMATES_EDIT', 'LEADS_VIEW', 'LEADS_EDIT', 'USERS_MANAGE', 'ROLES_MANAGE',
  'INSIGHTS_VIEW', 'ADMIN_METRICS'
];

// Capability-COMPLETE for their tenant. Nothing refused below may be explained
// by a missing capability — every refusal has to be the key-space classifier.
const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
const ORG_A_PM    = { id: 11, email: 'pm-a@a.test',    role: 'pm',    name: 'A PM',    organization_id: 1 };
const ORG_B_PM    = { id: 78, email: 'pm-b@b.test',    role: 'pm',    name: 'B PM',    organization_id: 2 };
const OWNER       = { id: 1,  email: 'owner@p86.test', role: 'system_admin', name: 'Owner', organization_id: 1 };

const VAPID_PRIVATE = 'PRIVATE-KEY-MATERIAL-DO-NOT-SERVE';

function freshTables() {
  return {
    roles: [
      { name: 'system_admin', capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN']) },
      { name: 'admin', capabilities: ADMIN_CAPS.slice() },
      // A plain PM holds ESTIMATES_VIEW — that is exactly why the old read gate
      // was every PM in every tenant.
      { name: 'pm', capabilities: ['JOBS_VIEW_ALL', 'ESTIMATES_VIEW', 'LEADS_VIEW', 'LEADS_EDIT'] }
    ],
    app_settings: [
      { key: 'proposal_template', value: { company_header: 'AGX', exclusions: [] }, updated_at: 't' },
      { key: 'bt_export_mapping', value: { categories: { labor: { costCode: 'Direct Labor' } } }, updated_at: 't' },
      { key: 'agent_skills', value: { skills: [{ id: 'p1', name: 'Estimating', body: 'real doctrine', anthropic_skill_id: 'sk_real_1' }] }, updated_at: 't' },
      { key: 'vapid_keys', value: { publicKey: 'PUB', privateKey: VAPID_PRIVATE }, updated_at: 't' },
      { key: 'email', value: { globalBcc: 'ops@agxco.com', events: {} }, updated_at: 't' },
      { key: 'reminders_log', value: { fires: {} }, updated_at: 't' },
      { key: 'estimates_updated_at_reset_v1', value: { ran_at: 'x' }, updated_at: 't' }
    ],
    managed_agent_skills: [
      { agent_key: 'job', skill_id: 'sk_real_1', position: 0, enabled: true }
    ]
  };
}

function req(method, path, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
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
        try { json = JSON.parse(raw); } catch (e) { /* non-JSON body */ }
        resolve({ status: resp.statusCode, body: json, raw });
      });
    });
    r.on('error', reject);
    if (payload) r.write(payload);
    r.end();
  });
}

beforeAll(async () => {
  tables = freshTables();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/settings', require('../server/routes/settings-routes'));
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
  tables = freshTables();
  await refreshRoleCache();
});

// ── The classification itself ───────────────────────────────────────────────
// Pure module, no express and no DB — this is the fix, and the route is only
// its consequence.
describe('the key space is an allowlist, and it is closed', () => {
  test('a key nobody declared is internal, and internal is unreachable', () => {
    expect(keySpace.classOf('brand_new_key')).toBe('internal');
    expect(keySpace.readCapabilityFor('brand_new_key')).toBeNull();
    expect(keySpace.writeCapabilityFor('brand_new_key')).toBeNull();
  });

  test('db.js migration sentinels cannot be pre-created to suppress a migration', () => {
    // Both real sentinel names, plus the shape a future one would take. Each
    // runs only while its key is ABSENT, so an open PUT was a permanent,
    // silent, platform-wide migration kill switch.
    ['estimates_updated_at_reset_v1', 'ai_sessions_machine_label_null_v1', 'some_future_reset_v3']
      .forEach((k) => expect(keySpace.writeCapabilityFor(k)).toBeNull());
  });

  test('the VAPID keypair is never served and never written, at any privilege', () => {
    expect(keySpace.classOf('vapid_keys')).toBe('secret');
    expect(keySpace.readCapabilityFor('vapid_keys')).toBeNull();
    expect(keySpace.writeCapabilityFor('vapid_keys')).toBeNull();
    // The second denylist exists so that a future edit to the class table — a
    // typo, a merge, a well-meant "let the owner look at it" — cannot put
    // credential material back on the wire. Assert it independently.
    expect(keySpace.NEVER_SERVED.has('vapid_keys')).toBe(true);
  });

  test('cron ledgers are internal — writing one suppresses a platform-wide job', () => {
    ['reminders_log', 'cert_expiry_log', 'weekly_digest_log', 'ai_spend_alert_log']
      .forEach((k) => {
        expect(keySpace.classOf(k)).toBe('internal');
        expect(keySpace.writeCapabilityFor(k)).toBeNull();
      });
  });

  test("the email blob belongs to its own door, so this route is not a way around that door's BCC gate", () => {
    expect(keySpace.classOf('email')).toBe('own_door');
    expect(keySpace.readCapabilityFor('email')).toBeNull();
    expect(keySpace.writeCapabilityFor('email')).toBeNull();
  });

  test('the platform playbook is SYSTEM_ADMIN; the shared boilerplate is not', () => {
    expect(keySpace.readCapabilityFor('agent_skills')).toBe('SYSTEM_ADMIN');
    expect(keySpace.writeCapabilityFor('agent_skills')).toBe('SYSTEM_ADMIN');
    expect(keySpace.readCapabilityFor('proposal_template')).toBe('ESTIMATES_VIEW');
    expect(keySpace.writeCapabilityFor('proposal_template')).toBe('ROLES_MANAGE');
  });
});

// ── Reads ───────────────────────────────────────────────────────────────────
describe('a plain PM cannot read a platform key or a secret', () => {
  test('the VAPID private key is not served to a PM in either tenant', async () => {
    for (const pm of [ORG_A_PM, ORG_B_PM]) {
      const r = await req('GET', '/api/settings/vapid_keys', pm);
      expect(r.status).toBe(404);
      // Not just "refused" — the material must not appear anywhere in the
      // response, including an error path that helpfully echoes the key.
      expect(r.raw).not.toContain(VAPID_PRIVATE);
    }
  });

  test('the VAPID private key is not served to an org admin, or to the platform owner', async () => {
    // "Who may call it" and "should this endpoint ever serve this value" are
    // separate questions. This is the second one, and the answer does not
    // improve with privilege.
    for (const u of [ORG_A_ADMIN, OWNER]) {
      const r = await req('GET', '/api/settings/vapid_keys', u);
      expect(r.status).toBe(404);
      expect(r.raw).not.toContain(VAPID_PRIVATE);
    }
  });

  test('the platform agent playbook is not served to a PM in the other tenant', async () => {
    const r = await req('GET', '/api/settings/agent_skills', ORG_B_PM);
    expect(r.status).toBe(404);
    expect(r.raw).not.toContain('real doctrine');
  });

  test('the platform agent playbook is not served to an org admin either', async () => {
    // ROLES_MANAGE is held by EVERY tenant's admin, which is precisely the
    // "capability every tenant holds" the standard names.
    const r = await req('GET', '/api/settings/agent_skills', ORG_A_ADMIN);
    expect(r.status).toBe(404);
  });

  test('the platform owner still reads it — the gate was raised, not welded', async () => {
    const r = await req('GET', '/api/settings/agent_skills', OWNER);
    expect(r.status).toBe(200);
    expect(r.body.setting.value.skills[0].name).toBe('Estimating');
  });

  test('cron ledgers and migration sentinels are not readable by anyone', async () => {
    for (const key of ['reminders_log', 'estimates_updated_at_reset_v1', 'email']) {
      for (const u of [ORG_A_PM, ORG_A_ADMIN, OWNER]) {
        expect((await req('GET', '/api/settings/' + key, u)).status).toBe(404);
      }
    }
  });
});

// ── Writes ──────────────────────────────────────────────────────────────────
describe('an org admin cannot write a platform key or a secret', () => {
  test('the agent playbook survives an org admin overwrite', async () => {
    const r = await req('PUT', '/api/settings/agent_skills', ORG_A_ADMIN, {
      value: { skills: [{ name: 'attacker pack', body: 'exfiltrate everything' }] }
    });
    expect(r.status).toBe(404);
    // The finding was not the status code, it was where the bytes ended up:
    // preserveSkillIds re-attached the real anthropic_skill_id to whatever was
    // posted, so the injected body would have ridden the next sync-all
    // upstream wearing the identity of a real Anthropic skill.
    const row = tables.app_settings.find((s) => s.key === 'agent_skills');
    expect(row.value.skills[0].name).toBe('Estimating');
    expect(row.value.skills[0].anthropic_skill_id).toBe('sk_real_1');
  });

  test('dropping a pack does not detach it from the platform agents for everyone', async () => {
    // The second arm: `DELETE FROM managed_agent_skills WHERE skill_id = $1`
    // is unscoped and that table has no org column, so an org admin saving a
    // shorter array detached the skill from the platform's agents in every
    // tenant, no sync required.
    const r = await req('PUT', '/api/settings/agent_skills', ORG_A_ADMIN, { value: { skills: [] } });
    expect(r.status).toBe(404);
    expect(tables.managed_agent_skills).toHaveLength(1);
  });

  test('the platform owner may still retire a pack — the retire path still works', async () => {
    const r = await req('PUT', '/api/settings/agent_skills', OWNER, { value: { skills: [] } });
    expect(r.status).toBe(200);
    expect(tables.managed_agent_skills).toHaveLength(0);
  });

  test('the platform push keypair survives an org admin overwrite', async () => {
    const r = await req('PUT', '/api/settings/vapid_keys', ORG_A_ADMIN, {
      value: { publicKey: 'ATTACKER_PUB', privateKey: 'ATTACKER_PRIV' }
    });
    expect(r.status).toBe(404);
    const row = tables.app_settings.find((s) => s.key === 'vapid_keys');
    expect(row.value.privateKey).toBe(VAPID_PRIVATE);
  });

  test('an arbitrary new global key cannot be created', async () => {
    const before = tables.app_settings.length;
    const r = await req('PUT', '/api/settings/brand_new_key', ORG_A_ADMIN, { value: { x: 1 } });
    expect(r.status).toBe(404);
    expect(tables.app_settings).toHaveLength(before);
  });

  test('a migration sentinel cannot be pre-created over HTTP', async () => {
    const r = await req('PUT', '/api/settings/ai_sessions_machine_label_null_v1', ORG_A_ADMIN, { value: {} });
    expect(r.status).toBe(404);
    expect(tables.app_settings.find((s) => s.key === 'ai_sessions_machine_label_null_v1')).toBeUndefined();
  });

  test('the global email blob cannot be clobbered through the generic route', async () => {
    const r = await req('PUT', '/api/settings/email', ORG_A_ADMIN, {
      value: { globalBcc: 'exfil@attacker.example', events: {} }
    });
    expect(r.status).toBe(404);
    const row = tables.app_settings.find((s) => s.key === 'email');
    expect(row.value.globalBcc).toBe('ops@agxco.com');
  });
});

// ── No existence oracle ─────────────────────────────────────────────────────
describe('an unauthorised key answers exactly like an absent one', () => {
  test('present-but-forbidden is indistinguishable from never-existed', async () => {
    const absent    = await req('GET', '/api/settings/no_such_key_at_all', ORG_A_PM);
    const secret    = await req('GET', '/api/settings/vapid_keys', ORG_A_PM);
    const platform  = await req('GET', '/api/settings/agent_skills', ORG_A_PM);
    const internal  = await req('GET', '/api/settings/reminders_log', ORG_A_PM);
    const ownDoor   = await req('GET', '/api/settings/email', ORG_A_PM);
    // Compared to each other, not to a literal, so a reworded message keeps
    // the property instead of breaking the test that guards it.
    for (const r of [secret, platform, internal, ownDoor]) {
      expect(r.status).toBe(absent.status);
      expect(r.raw).toBe(absent.raw);
    }
  });

  test('a forbidden PUT does not leak that the key is real by asking for a value', async () => {
    // The old handler validated `value` before anything else, so a bodyless
    // PUT to a real key answered 400 "value is required" while a bogus key
    // answered the same — but a WELL-FORMED PUT separated them by 200 vs 200.
    // Post-fix both shapes must be the absent-key answer for a non-holder.
    const bogusNoBody = await req('PUT', '/api/settings/no_such_key_at_all', ORG_A_ADMIN, {});
    const realNoBody  = await req('PUT', '/api/settings/vapid_keys', ORG_A_ADMIN, {});
    const realWithBody = await req('PUT', '/api/settings/vapid_keys', ORG_A_ADMIN, { value: { a: 1 } });
    expect(realNoBody.raw).toBe(bogusNoBody.raw);
    expect(realWithBody.raw).toBe(bogusNoBody.raw);
    expect(realNoBody.status).toBe(404);
  });
});

// ── The other direction: what must keep working ─────────────────────────────
describe('the admin UIs still work end to end for the keys they legitimately own', () => {
  test('the estimate preview reads the proposal template as a plain PM', async () => {
    // js/estimate-preview.js loads this on render. ESTIMATES_VIEW is the gate
    // and a PM holds it — unchanged on purpose.
    const r = await req('GET', '/api/settings/proposal_template', ORG_A_PM);
    expect(r.status).toBe(200);
    expect(r.body.setting.value.company_header).toBe('AGX');
  });

  test('the BT exporter reads its cost-code map as a plain PM', async () => {
    const r = await req('GET', '/api/settings/bt_export_mapping', ORG_A_PM);
    expect(r.status).toBe(200);
    expect(r.body.setting.value.categories.labor.costCode).toBe('Direct Labor');
  });

  test("Admin -> Templates 'Save All' still commits both keys as an ORG ADMIN", async () => {
    // js/admin.js saveAdminTemplate() PUTs both in one Promise.all. Either one
    // 403ing would break the whole save, in EITHER tenant.
    for (const who of [ORG_A_ADMIN, ORG_B_ADMIN]) {
      const a = await req('PUT', '/api/settings/proposal_template', who, {
        value: { company_header: 'edited by ' + who.email, exclusions: ['x'] }
      });
      const b = await req('PUT', '/api/settings/bt_export_mapping', who, {
        value: { categories: { labor: { costCode: 'Direct Labor' } }, fallback: { costCode: 'GC' } }
      });
      expect([a.status, b.status]).toEqual([200, 200]);
    }
    expect(tables.app_settings.find((s) => s.key === 'proposal_template').value.company_header)
      .toBe('edited by admin-b@b.test');
  });

  test('a signed-out caller gets 401, not the key-space answer', async () => {
    // requireAuth still runs first. Losing it to the classifier would turn
    // every unauthenticated probe into a uniform 404 and hide a real 401.
    const r = await new Promise((resolve, reject) => {
      const u = new URL(baseUrl + '/api/settings/proposal_template');
      http.request({ hostname: u.hostname, port: u.port, path: u.pathname, method: 'GET' }, (resp) => {
        resp.resume();
        resp.on('end', () => resolve({ status: resp.statusCode }));
      }).on('error', reject).end();
    });
    expect(r.status).toBe(401);
  });
});
