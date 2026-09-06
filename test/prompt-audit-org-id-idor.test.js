// GET /api/admin/agents/managed/prompt-audit?org_id=<anyone> — AN ID IN THE
// QUERY STRING IS NOT AN AUTHORISATION.
//
// ── HOW THIS WAS FOUND, WHICH IS THE POINT ───────────────────────────────
// Not by reading the route. By DRIVING it: REGISTER 2
// (test/tenant-register2-http.test.js) walks `router.stack` over every mount in
// server/index.js and pushes all 137 param-less GETs through the two-org
// oracle. This route came back carrying the victim organisation's marker on the
// very first run, at HEAD, with nothing planted.
//
// Six rounds of static scanning had not found it. The route reads
// `req.query.org_id`, and a scanner looking for a missing `organization_id`
// predicate sees a statement that binds one — `SELECT * FROM organizations
// WHERE id = $1` is perfectly scoped. It is scoped TO A VALUE THE CALLER CHOSE.
//
// ── WHAT IT HANDED OVER ──────────────────────────────────────────────────
// The gate is `requireCapability('ROLES_MANAGE')`, which BOTH seeded admin
// roles hold — so any affiliate admin, naming any organisation id, received:
//
//   * that tenant's `managed_agent_registry` row, INCLUDING
//     `anthropic_agent_id` — the handle the sibling DELETE on this router acts
//     on;
//   * its composed agent system prompt, which embeds the org's own name and
//     its skill packs;
//   * its `agent_reference_links` titles.
//
// Same species as the entity_title defect `3e2c70a2` closed one route over: the
// capability proves the caller may see A console and says nothing about WHOSE.
//
// ── THE SHAPE OF THE PROOF ───────────────────────────────────────────────
// ONE CALLER RECORD. Only the CAPABILITY varies between the two halves, and
// only the ORG ID varies within each — so a pass cannot come from "another
// user's data is not yours", which is a proposition nobody doubted.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const express = require('express');
const http = require('http');
const TWO = require('./helpers/two-org');
const { ORG_A, ORG_B, MARK } = TWO;
const { overlay: BASE_OVERLAY, ID } = require('./helpers/tenant-overlay');

const OVERLAY = Object.assign({}, BASE_OVERLAY, {
  roles: BASE_OVERLAY.roles.concat([{
    name: 'system_admin', label: 'System Admin',
    capabilities: JSON.stringify(['ROLES_MANAGE', 'SYSTEM_ADMIN', 'ADMIN_METRICS']),
  }]),
});

const freshTwo = () => TWO.buildEngine({ overlay: OVERLAY });

globalThis.__P86_PA_ACTIVE__ = freshTwo();
globalThis.__P86_PA_POOL__ = {
  query: (...a) => globalThis.__P86_PA_ACTIVE__.pool.query(...a),
  connect: (...a) => globalThis.__P86_PA_ACTIVE__.pool.connect(...a),
};
jest.mock('../server/db', () => ({ pool: globalThis.__P86_PA_POOL__ }));
jest.mock('@anthropic-ai/sdk', () => {
  function FakeAnthropic() { return { messages: {}, beta: {} }; }
  FakeAnthropic.toFile = async () => ({});
  return Object.assign(FakeAnthropic, { toFile: FakeAnthropic.toFile, default: FakeAnthropic });
});

jest.useFakeTimers();
const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const adminAgents = require('../server/routes/admin-agents-routes');
jest.useRealTimers();

const CALLER = { id: ID('users', 'A'), email: 'a@a.a', name: 'A Admin' };
let server, baseUrl;

beforeAll(async () => {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/api/admin/agents', adminAgents);
  setRolePool(globalThis.__P86_PA_POOL__);
  await refreshRoleCache();
  await new Promise((r) => { server = http.createServer(app); server.listen(0, '127.0.0.1', r); });
  baseUrl = 'http://127.0.0.1:' + server.address().port;
});

afterAll((done) => {
  if (!server) return done();
  if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  server.close(() => done());
});

async function audit(role, query) {
  const prev = globalThis.__P86_PA_ACTIVE__;
  globalThis.__P86_PA_ACTIVE__ = freshTwo();
  try {
    const res = await fetch(baseUrl + '/api/admin/agents/managed/prompt-audit' + query, {
      headers: {
        authorization: 'Bearer ' + signToken(Object.assign({}, CALLER, { role, organization_id: ORG_A })),
        connection: 'close',
      },
    });
    return { status: res.status, body: await res.text() };
  } finally { globalThis.__P86_PA_ACTIVE__ = prev; }
}

describe('prompt-audit — org_id is a request, not a permission', () => {
  test('an ORG ADMIN naming ANOTHER tenant is REFUSED, and told which rule refused them', async () => {
    // The assertion that is red against the code as it stood: 200, with the
    // victim's marker in the body.
    const r = await audit('admin', '?org_id=' + ORG_B);
    expect(r.status).toBe(403);
    expect(r.body).not.toContain(MARK);
    expect(r.body).toMatch(/System Admin/i);
    // A refusal that does not say what to do instead is a dead end.
    expect(r.body).toMatch(/omit org_id/i);
  });

  test('an ORG ADMIN naming a foreign tenant leaks NO number in the poison band either', async () => {
    const r = await audit('admin', '?org_id=' + ORG_B);
    expect(TWO.scanAnswer(r.body).poisoned).toEqual([]);
  });

  test('ANTI-LOBOTOMY — the same admin still audits their OWN agent, with no parameter', async () => {
    // A refusal test whose sibling does not prove the route still works is
    // satisfied by a route that refuses everybody. The console's normal call
    // passes no org_id at all.
    const r = await audit('admin', '');
    expect(r.status).toBe(200);
    expect(r.body).toContain('"organization_id":' + ORG_A);
  });

  test('ANTI-LOBOTOMY — naming their OWN org explicitly is still allowed', async () => {
    // The admin console builds this URL with an explicit org_id. Refusing the
    // caller's own tenant would break the panel while looking like security.
    const r = await audit('admin', '?org_id=' + ORG_A);
    expect(r.status).toBe(200);
    expect(r.body).toContain('"organization_id":' + ORG_A);
  });

  test('a SYSTEM ADMIN keeps the cross-tenant parameter — the platform-owner operation is intact', async () => {
    // Same caller record, one capability different. This is the arm that makes
    // the fix a BOUNDARY rather than a removal: the platform owner is who the
    // parameter was written for.
    const r = await audit('system_admin', '?org_id=' + ORG_B);
    expect(r.status).toBe(200);
    expect(r.body).toContain('"organization_id":' + ORG_B);
  });

  test('the RESIDUAL is unchanged and still visible: managed_agent_skills has no tenant column', async () => {
    // NOT closed by this commit, and it must not look closed. collectSkillsFor
    // reads `managed_agent_skills WHERE agent_key = $1` and that table carries
    // no organization_id at all (this router says so itself at :3657), so the
    // skill ids attached to one tenant's agent still list every tenant's. That
    // is a MIGRATION, it is graduation item 15, and this assertion is what
    // stops it being quietly forgotten — or quietly fixed without the ledger
    // being updated.
    const r = await audit('admin', '');
    expect(r.status).toBe(200);
    expect(r.body).toContain(MARK);
    expect(r.body).toMatch(/skill_ids/);
  });
});
