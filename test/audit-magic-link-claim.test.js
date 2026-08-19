// The magic-link claim mints a login, and until now said nothing about it.
//
// GET /api/sub-portal/accept is unauthenticated BY CONSTRUCTION — the token IS
// the credential, and the route's own header says a leaked link is the same as
// a leaked password, mitigated only by a one-time `used_at` flag. From that
// call a `users` row appears with role='sub', an auth cookie is signed, and the
// holder lands in the portal reading every folder that sub was granted.
//
// So it is exactly the shape that has to leave a record, and exactly the shape
// that cannot be wired through the ordinary req.user path: there is no
// req.user, and there never will be. Logging one anyway would write
// actor_user_id NULL on every row — coverage-shaped, and useless. The actor
// here is TYPED as 'invite' and named from the invite row the handler just
// read, which is evidence rather than a guess.
//
// The REFUSALS are the more useful half. A replayed link — already used, or
// expired — is what a leaked invite looks like from the server side. Without a
// row, a replay is invisible.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-magic-link-claim-audit-suite-0123456789';

const express = require('express');
const http = require('http');

let mockTables;
let mockAudit;
let mockBreakAudit = false;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => ({
      query: async (sql, params) => mockRunQuery(sql, params),
      release: () => {}
    })
  }
}));
jest.mock('../server/email', () => ({
  sendEmail: async () => ({ ok: true }), isEnabled: () => false, sendForEvent: async () => ({})
}));
jest.mock('../server/storage', () => ({ storage: { put: async () => 'u', getBuffer: async () => Buffer.from(''), delete: async () => {} } }));
jest.mock('../server/services/entity-labels', () => ({ resolveEntityLabels: async () => ({}) }));

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (/^INSERT INTO admin_audit_log/i.test(text)) {
    if (mockBreakAudit) throw new Error("pool exhausted");
    const cols = text.match(/\(([^)]*)\)\s*VALUES/i)[1].split(',').map((c) => c.trim().replace(/::\w+$/, ''));
    const row = {};
    cols.forEach((c, i) => { row[c] = p[i]; });
    if (typeof row.detail === 'string') { try { row.detail = JSON.parse(row.detail); } catch (e) { /* raw */ } }
    mockAudit.push(row);
    return { rows: [], rowCount: 1 };
  }
  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: [] };
  if (text.includes('FROM sub_invites i')) {
    const hit = mockTables.sub_invites.find((i) => i.token === p[0]);
    return { rows: hit ? [hit] : [] };
  }
  if (text.includes('FROM users WHERE email = $1 AND sub_id = $2')) {
    const hit = mockTables.users.find((u) => u.email === p[0] && u.sub_id === p[1]);
    return { rows: hit ? [hit] : [] };
  }
  if (/^INSERT INTO users/i.test(text)) {
    const u = { id: 900 + mockTables.users.length, email: p[0], password_hash: p[1], name: p[2],
      role: 'sub', sub_id: p[3], active: true, organization_id: p[4] };
    mockTables.users.push(u);
    return { rows: [u], rowCount: 1 };
  }
  if (/^UPDATE users SET active/i.test(text)) return { rows: [], rowCount: 1 };
  if (/^UPDATE sub_invites SET used_at/i.test(text)) return { rows: [], rowCount: 1 };
  return { rows: [], rowCount: 0 };
}

const { setRolePool } = require('../server/auth');
const { pool } = require('../server/db');
setRolePool(pool);

let server, baseUrl, logSpy;

function fresh() {
  return {
    users: [],
    sub_invites: [
      { id: 'si_live', sub_id: 'sub_A', email: 'alpha@a.test', token: 'tok-live',
        sub_name: 'Alpha Drywall', sub_org_id: 1, inviter_org_id: 1,
        used_at: null, used_user_id: null, created_by: 10,
        expires_at: new Date(Date.now() + 864e5).toISOString() },
      { id: 'si_used', sub_id: 'sub_A', email: 'alpha@a.test', token: 'tok-used',
        sub_name: 'Alpha Drywall', sub_org_id: 1, inviter_org_id: 1,
        used_at: new Date().toISOString(), used_user_id: 55, created_by: 10,
        expires_at: new Date(Date.now() + 864e5).toISOString() },
      { id: 'si_old', sub_id: 'sub_A', email: 'alpha@a.test', token: 'tok-expired',
        sub_name: 'Alpha Drywall', sub_org_id: 1, inviter_org_id: 1,
        used_at: null, used_user_id: null, created_by: 10,
        expires_at: new Date(Date.now() - 864e5).toISOString() }
    ]
  };
}

beforeAll(async () => {
  mockTables = fresh(); mockAudit = [];
  const app = express();
  app.use(express.json());
  app.use('/api', require('../server/routes/sub-portal-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => done()); });
beforeEach(() => {
  mockTables = fresh(); mockAudit = []; mockBreakAudit = false;
  require('../server/audit')._resetCoalescer();
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { logSpy.mockRestore(); });

function accept(token) {
  return fetch(baseUrl + '/api/sub-portal/accept?token=' + encodeURIComponent(token), {
    redirect: 'manual', headers: { 'user-agent': 'P86Test/1.0' }
  });
}

describe('a claim that mints a login leaves a row naming who claimed it', () => {
  test('a good claim records the invite identity, the org, and that a user was CREATED', async () => {
    const r = await accept('tok-live');
    expect([302, 200]).toContain(r.status);
    expect(mockAudit.length).toBe(1);
    const row = mockAudit[0];
    expect(row.action).toBe('auth.magic_link_claim');
    expect(row.outcome).toBe('ok');
    // TYPED, not NULL. There is no req.user here and never will be, so the
    // absence of a user id is explained rather than left ambiguous.
    expect(row.actor_kind).toBe('invite');
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_email).toBe('alpha@a.test');
    expect(row.organization_id).toBe(1);
    expect(row.scope).toBe('org');
    expect(row.target_id).toBe('si_live');
    expect(row.detail.created).toBe(true);
    expect(row.detail.org_stamped).toBe(true);
    // "from where" still comes off the real request.
    expect(row.user_agent).toContain('P86Test');
  });

  test('THE TOKEN IS NEVER STORED — it is a live credential, and this table is read all day', async () => {
    await accept('tok-live');
    expect(JSON.stringify(mockAudit)).not.toContain('tok-live');
  });

  test('a REPLAYED link is recorded — that is what a leaked invite looks like', async () => {
    const r = await accept('tok-used');
    expect(r.status).toBe(410);
    expect(mockAudit.length).toBe(1);
    expect(mockAudit[0].outcome).toBe('denied');
    expect(mockAudit[0].reason).toBe('already_used');
    // Still names the invite and the tenant, so a replay is attributable to a
    // specific leaked link rather than "somebody, somewhere".
    expect(mockAudit[0].target_id).toBe('si_used');
    expect(mockAudit[0].organization_id).toBe(1);
  });

  test('an EXPIRED link is recorded too', async () => {
    const r = await accept('tok-expired');
    expect(r.status).toBe(410);
    expect(mockAudit[0].reason).toBe('token_expired');
  });

  test('an UNKNOWN token is recorded as anonymous, with the string hashed and not kept', async () => {
    // Not known to be ours at all. Nothing about it is an identity, and the
    // string a stranger supplied must not land on an evidence row — but the
    // sha8 still makes a run of guesses countable.
    const r = await accept('AKIA-not-a-real-token-guess');
    expect(r.status).toBe(404);
    expect(mockAudit.length).toBe(1);
    expect(mockAudit[0].actor_kind).toBe('anonymous');
    expect(mockAudit[0].reason).toBe('no_such_token');
    expect(JSON.stringify(mockAudit)).not.toContain('AKIA-not-a-real-token-guess');
    expect(mockAudit[0].detail.link_sha8).toMatch(/^[0-9a-f]{8}$/);
  });

  test('FAIL LOUD: the claim still works when the trail is down, and screams', async () => {
    // Fail-loud, not fail-closed. A sub standing on a jobsite must not be
    // locked out of the portal because an insert failed — that is an
    // availability attack on anyone who can pressure the pool. The stdout
    // mirror is the second copy, and it is why tolerating this is not the
    // same as ignoring it.
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockBreakAudit = true;
    const r = await accept('tok-live');
    mockBreakAudit = false;
    expect([302, 200]).toContain(r.status);
    // The user really was minted — the operation completed.
    expect(mockTables.users.length).toBe(1);
    const yells = spy.mock.calls.filter((c) => String(c[0]).indexOf('[AUDIT-FAIL]') === 0);
    expect(yells.length).toBe(1);
    const payload = JSON.parse(yells[0][1]);
    expect(payload.action).toBe('auth.magic_link_claim');
    expect(payload.actor_email).toBe('alpha@a.test');
    spy.mockRestore();
  });
});
