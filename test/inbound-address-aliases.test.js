// ASSIGNABLE PROJECT 86 ADDRESSES — the properties, executed.
//
// THE FAILURE CLASS THIS FILE IS BUILT AGAINST
// An email address is a thing OTHER PEOPLE WROTE DOWN. When one stops
// resolving, `storeInboundMessage` returns { ignored: true } with an HTTP 2xx,
// the Cloudflare Worker treats 2xx as "consume the message", and the sender
// gets NO BOUNCE while we get NO ROW. The mail is destroyed and the only trace
// is one console line. So "the old address still delivers" cannot be asserted
// from a source read — a wrong answer here is invisible from inside the product
// and stays invisible until a client says they never heard back.
//
// Everything below therefore runs the REAL SQL the routes emit against a real
// SQL engine (node:sqlite via test/helpers/pg-sqlite), on a schema DERIVED from
// server/db.js rather than typed here, and asks what actually came back. The
// admin door is driven over the wire through the real express router behind
// real requireAuth, because "refused before anything was written" and "the
// tenant guard runs before the uniqueness probe" are both orderings, and an
// ordering is not observable from a grep.
//
// PROPERTIES, not examples. Each `it` below names one.

const express = require('express');
const http = require('http');
const schema = require('./helpers/db-schema');
const { createPgSqlite } = require('./helpers/pg-sqlite');

// Swapped per test, and the mock forwards to whatever it is AT CALL TIME —
// the routes destructure `pool` at module load, so a pool captured at first
// require would leave the route writing to a database these assertions never
// read.
let mockEngine = null;

jest.mock('../server/db', () => ({
  pool: {
    query: (sql, params) => mockEngine.pool.query(sql, params),
    connect: async () => (await mockEngine.pool.connect()),
  },
  getOrgById: async (id) => mockEngine.all('SELECT * FROM organizations WHERE id = ?', id)[0] || null,
}));
jest.mock('../server/email', () => ({ sendEmail: async () => ({}), isEnabled: () => false, sendForEvent: async () => ({}) }));

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const authRoutes = require('../server/routes/auth-routes');
const inbox = require('../server/routes/email-inbox-routes');
const addr = require('../server/services/inbound-address');

setRolePool(require('../server/db').pool);

const TABLES = [
  'organizations', 'users', 'user_email_aliases', 'inbound_emails',
  'admin_audit_log', 'roles',
];
const PK = {
  organizations: 'id', users: 'id', inbound_emails: 'id',
  admin_audit_log: 'id', roles: 'name',
  // The never-reissue guarantee IS this primary key, so the fixture must carry
  // it or the property under test is not being tested.
  user_email_aliases: 'local_part',
};

const DOMAIN = addr.inboundDomain();

// ORG A is AGX exactly as production has it. ORG B is the second tenant: its
// ids are in the 900000000 band so a row that leaked from it is unmistakable
// rather than merely surprising, matching the two-org fixture's convention.
function seed() {
  const e = createPgSqlite(schema.sqliteSchema(TABLES, { pk: PK }), { jsonColumns: ['detail', 'capabilities', 'notification_prefs'] });
  // sqliteSchema derives COLUMNS, not indexes. The ingest INSERT carries
  // `ON CONFLICT (user_id, resend_email_id)`, which needs the real unique
  // (uq_inbound_emails_user_dedupe in db.js) to exist or the statement will not
  // prepare — and a delivery that cannot be stored is not a delivery.
  e.db.exec('CREATE UNIQUE INDEX uq_inbound_emails_user_dedupe ON inbound_emails (user_id, resend_email_id) WHERE resend_email_id IS NOT NULL;');
  e.db.exec(
    "INSERT INTO organizations (id, slug, name) VALUES (1, 'agx', 'AGX Central Florida');" +
    "INSERT INTO organizations (id, slug, name) VALUES (900000002, 'beta', 'Beta Restoration');" +
    "INSERT INTO users (id, email, name, role, organization_id, active, inbound_email_key) VALUES" +
    "  (10, 'john@agxco.com',  'John',  'admin', 1, 1, 'john-46bbee')," +
    "  (11, 'pat@agxco.com',   'Pat',   'pm',    1, 1, NULL)," +
    "  (900000010, 'bea@beta.test', 'Bea', 'admin', 900000002, 1, 'bea-ff0011');"
  );
  // The backfill db.js runs, so the fixture starts where a migrated database
  // starts: every existing key already an alias.
  e.db.exec(
    "INSERT INTO user_email_aliases (local_part, user_id, original_user_id, organization_id, source)" +
    "  SELECT LOWER(inbound_email_key), id, id, organization_id, 'minted' FROM users WHERE inbound_email_key IS NOT NULL;"
  );
  for (const r of addr.RESERVED_LOCAL_PARTS) {
    e.db.prepare("INSERT INTO user_email_aliases (local_part, user_id, source) VALUES (?, NULL, 'reserved')").run(r);
  }
  return e;
}

let server, baseUrl, warnSpy, logSpy;

beforeAll(async () => {
  mockEngine = seed();
  await refreshRoleCache();
  const app = express();
  app.use(express.json());
  app.use('/api/auth', authRoutes);
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => { baseUrl = 'http://127.0.0.1:' + server.address().port; done(); });
  });
});
afterAll((done) => { server.close(() => done()); });

beforeEach(async () => {
  mockEngine = seed();
  mockEngine.db.exec("INSERT INTO roles (name, capabilities) VALUES ('admin','[\"USERS_MANAGE\"]'),('pm','[]'),('system_admin','[\"USERS_MANAGE\",\"SYSTEM_ADMIN\"]')");
  await refreshRoleCache();
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { warnSpy.mockRestore(); logSpy.mockRestore(); });

const ADMIN_A = { id: 10, email: 'john@agxco.com', role: 'admin', name: 'John', organization_id: 1 };
const ADMIN_B = { id: 900000010, email: 'bea@beta.test', role: 'admin', name: 'Bea', organization_id: 900000002 };
const PM_A = { id: 11, email: 'pat@agxco.com', role: 'pm', name: 'Pat', organization_id: 1 };

async function setAddress(actor, targetId, local) {
  const res = await fetch(baseUrl + '/api/auth/users/' + targetId, {
    method: 'PUT',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(actor) },
    body: JSON.stringify({ inbound_local_part: local }),
  });
  let json = null; try { json = await res.json(); } catch (_) {}
  return { status: res.status, body: json };
}

// Deliver a message to `address` and report what the ingest path decided.
async function deliverTo(address) {
  return inbox.storeInboundMessage({
    envelopeRecipients: [address],
    headerRecipients: [address],
    fromRaw: 'Client <client@example.com>',
    subjectRaw: 'Roof estimate',
    text: 'body',
    dedupeKey: 'k-' + Math.random(),
  });
}
const keyOf = (id) => mockEngine.all('SELECT inbound_email_key FROM users WHERE id = ?', id)[0].inbound_email_key;

// ── The address shape ──────────────────────────────────────────────────────
describe('the address is built in one place', () => {
  it('composes <local>.<orgslug> and never lets the caller supply the slug', async () => {
    const r = await setAddress(ADMIN_A, 10, 'john');
    expect(r.status).toBe(200);
    expect(keyOf(10)).toBe('john.agx');
    expect(addr.formatAddress('john.agx')).toBe('john.agx@' + DOMAIN);
  });

  it('never splits an incoming address back into a name and an org', () => {
    // mary.jane composes to mary.jane.agx. Any parser that cut at the last dot
    // would decide the org was "agx" and the user was "mary.jane" here, and
    // would be wrong the moment a slug contains no dot but a name does. The
    // matcher returns ONE opaque string.
    expect(addr.localPartFromAddress('mary.jane.agx@' + DOMAIN)).toBe('mary.jane.agx');
    expect(addr.localPartFromAddress('MARY.JANE.AGX+tag@' + DOMAIN)).toBe('mary.jane.agx');
    expect(addr.localPartFromAddress('someone@example.com')).toBeNull();
  });
});

// ── Tenancy ────────────────────────────────────────────────────────────────
describe('two organizations may both hold "john"', () => {
  it('both succeed, and the stored strings differ by the slug alone', async () => {
    expect((await setAddress(ADMIN_A, 10, 'john')).status).toBe(200);
    expect((await setAddress(ADMIN_B, 900000010, 'john')).status).toBe(200);
    expect(keyOf(10)).toBe('john.agx');
    expect(keyOf(900000010)).toBe('john.beta');
  });

  it('neither admin can discover that the other did it', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    // Org B asks for the same name and is told nothing about org A. It is not
    // refused at all — the namespaces are disjoint — so there is no timing or
    // wording difference to read.
    const b = await setAddress(ADMIN_B, 900000010, 'john');
    expect(b.status).toBe(200);
    // And the staff directory never shows the other tenant's row.
    const list = await fetch(baseUrl + '/api/auth/users', {
      headers: { authorization: 'Bearer ' + signToken(ADMIN_B) } });
    const users = (await list.json()).users.map((u) => u.email);
    expect(users).toContain('bea@beta.test');
    expect(users).not.toContain('john@agxco.com');
  });

  it('a local part is unique within its org', async () => {
    expect((await setAddress(ADMIN_A, 10, 'john')).status).toBe(200);
    const clash = await setAddress(ADMIN_A, 11, 'john');
    expect(clash.status).toBe(409);
    expect(clash.body.error).toBe(addr.TAKEN_MESSAGE);
    // The refusal names nobody and no company.
    expect(clash.body.error).not.toMatch(/john@agxco|John|agx/i);
    expect(keyOf(11)).toBeNull();
  });
});

// ── The alias rule ─────────────────────────────────────────────────────────
describe('every address a user has ever held still delivers to that user', () => {
  it('the auto-minted hash keeps delivering after a nicer primary is set', async () => {
    expect(await deliverTo('john-46bbee@' + DOMAIN)).toMatchObject({ ok: true });
    await setAddress(ADMIN_A, 10, 'john');
    expect(keyOf(10)).toBe('john.agx');
    // The NEW one delivers…
    expect(await deliverTo('john.agx@' + DOMAIN)).toMatchObject({ ok: true });
    // …and so does the old one, which is the whole point: it is written down
    // in a client's address book and on an Outlook redirect rule.
    expect(await deliverTo('john-46bbee@' + DOMAIN)).toMatchObject({ ok: true });
    const owners = mockEngine.all("SELECT user_id FROM inbound_emails").map((r) => r.user_id);
    expect(owners).toEqual([10, 10, 10]);
  });

  it('a third address does not retire the second', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    await setAddress(ADMIN_A, 10, 'jt');
    for (const a of ['john-46bbee', 'john.agx', 'jt.agx']) {
      expect(await deliverTo(a + '@' + DOMAIN)).toMatchObject({ ok: true });
    }
    expect(mockEngine.all('SELECT COUNT(*) AS n FROM inbound_emails WHERE user_id = 10')[0].n).toBe(3);
  });

  it('survives an org rename: the new slug works and every prior address still does', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    // The rename. There is no slug-rename door in the product today (PUT
    // /api/admin/organizations/:id does not accept slug), so this performs the
    // write that door WOULD perform, and re-points the primary the way it
    // would have to. The property is asserted against the alias table, so it
    // holds for whatever shape that door eventually takes.
    mockEngine.db.exec("UPDATE organizations SET slug = 'agxfl' WHERE id = 1");
    const r = await setAddress(ADMIN_A, 10, 'john');
    expect(r.status).toBe(200);
    expect(keyOf(10)).toBe('john.agxfl');
    for (const a of ['john-46bbee', 'john.agx', 'john.agxfl']) {
      expect(await deliverTo(a + '@' + DOMAIN)).toMatchObject({ ok: true });
    }
  });

  it('an alias is never reissued — not to a colleague, not to another org', async () => {
    await setAddress(ADMIN_A, 10, 'john');           // john.agx is now John's
    await setAddress(ADMIN_A, 10, 'jt');             // …and john.agx is an alias
    // A colleague in the same org cannot take the retired string.
    const colleague = await setAddress(ADMIN_A, 11, 'john');
    expect(colleague.status).toBe(409);
    // Nor can a stranger in another org, even after that org takes the slug
    // the address was minted under. Reissuing here would deliver John's mail
    // to somebody in a different company.
    mockEngine.db.exec("UPDATE organizations SET slug = 'agx' WHERE id = 900000002");
    const stranger = await setAddress(ADMIN_B, 900000010, 'john');
    expect(stranger.status).toBe(409);
    expect(await deliverTo('john.agx@' + DOMAIN)).toMatchObject({ ok: true });
    expect(mockEngine.all('SELECT user_id FROM inbound_emails')[0].user_id).toBe(10);
  });

  it('a deleted user burns the string rather than releasing it', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    // ON DELETE SET NULL: the row survives with a NULL owner. (The fixture has
    // no FK actions — sqliteSchema drops them — so this performs the effect the
    // production constraint has, and asserts what delivery does with it.)
    mockEngine.db.exec('UPDATE user_email_aliases SET user_id = NULL WHERE user_id = 10');
    mockEngine.db.exec('DELETE FROM users WHERE id = 10');
    const out = await deliverTo('john.agx@' + DOMAIN);
    expect(out.ok).toBeUndefined();
    expect(out.reason).toBe('address belonged to a deleted user');
    // And it is still claimed, so nobody can be handed it.
    const held = await setAddress(ADMIN_B, 900000010, 'bea');
    expect(held.status).toBe(200);          // control: the door works
    mockEngine.db.exec("UPDATE organizations SET slug = 'agx' WHERE id = 900000002");
    expect((await setAddress(ADMIN_B, 900000010, 'john')).status).toBe(409);
  });
});

// ── Failing visibly ────────────────────────────────────────────────────────
describe('mail to an address nobody holds fails visibly', () => {
  it('names which kind of dead the address is, rather than one label for four', async () => {
    expect((await deliverTo('nobody.agx@' + DOMAIN)).reason).toBe('no matching dropbox');
    expect((await deliverTo('postmaster@' + DOMAIN)).reason).toBe('address is reserved');
    mockEngine.db.exec('UPDATE users SET active = 0 WHERE id = 10');
    expect((await deliverTo('john-46bbee@' + DOMAIN)).reason).toBe('address belongs to a deactivated user');
    // Every one of them is written where an operator can find it. This is the
    // ONLY trace any of these leaves: the sender is never told.
    expect(warnSpy.mock.calls.map((c) => String(c[0])).join('\n'))
      .toMatch(/no matching dropbox[\s\S]*address is reserved[\s\S]*deactivated/);
  });

  it('never stores mail for an address that is not ours', async () => {
    expect((await deliverTo('john-46bbee@elsewhere.test')).reason).toBe('no matching dropbox');
    expect(mockEngine.all('SELECT COUNT(*) AS n FROM inbound_emails')[0].n).toBe(0);
  });
});

// ── Validation, with a reason on screen ────────────────────────────────────
describe('an invalid local part is refused with a reason a person can act on', () => {
  const cases = [
    ['mary.jane', 400, /dot/i],
    ['a+b',       400, /plus sign/i],
    ['j',         400, /at least 2/i],
    ['-john',     400, /start or end with a hyphen/i],
    ['john-',     400, /start or end with a hyphen/i],
    ['jo--hn',    400, /two hyphens in a row/i],
    ['John Doe',  400, /lowercase letters, numbers and hyphens/i],
    ['jоhn',      400, /lowercase letters, numbers and hyphens/i],   // Cyrillic о
    ['',          400, /Enter a name/i],
    ['x'.repeat(70), 400, /Too long/i],
  ];
  it.each(cases)('%s is refused (%i) and says why', async (local, status, msg) => {
    const r = await setAddress(ADMIN_A, 10, local);
    expect(r.status).toBe(status);
    expect(r.body.error).toMatch(msg);
    // Refused means NOTHING was written — not a repaired value, not a partial.
    expect(keyOf(10)).toBe('john-46bbee');
  });

  it('the too-long refusal names the real number, which depends on the org slug', async () => {
    const a = await setAddress(ADMIN_A, 10, 'x'.repeat(70));
    expect(a.body.error).toMatch(/"agx" leaves room for 32/);
    // A long affiliate slug (the invite path derives one from the company
    // name and caps nothing) leaves genuinely less room, and says so.
    mockEngine.db.exec("UPDATE organizations SET slug = 'superior-exterior-restoration-fl' WHERE id = 1");
    const b = await setAddress(ADMIN_A, 10, 'x'.repeat(70));
    expect(b.body.error).toMatch(/leaves room for 31/);
  });

  it('normalises case server-side rather than trusting the client', async () => {
    // The UNIQUE on users.inbound_email_key is case-SENSITIVE and the delivery
    // match was case-INSENSITIVE, so "John" and "john" would have been two
    // permitted rows satisfying one delivery, resolved by an unordered LIMIT 1.
    expect((await setAddress(ADMIN_A, 10, '  JOHN  ')).status).toBe(200);
    expect(keyOf(10)).toBe('john.agx');
  });

  it('refuses when the target has no organization to build a slug from', async () => {
    mockEngine.db.exec('UPDATE users SET organization_id = NULL WHERE id = 11');
    // The caller is org-less too, so no adoption can supply a slug either.
    const orgless = { id: 11, email: 'pat@agxco.com', role: 'admin', name: 'Pat', organization_id: null };
    const r = await setAddress(orgless, 11, 'pat');
    expect(r.status).toBe(400);
    expect(r.body.error).toMatch(/not attached to an organization/i);
  });
});

describe('reserved names', () => {
  it('are refused as WHOLE addresses', () => {
    for (const name of ['postmaster', 'abuse', 'notifications']) {
      expect(addr.RESERVED_LOCAL_PARTS.has(name)).toBe(true);
      expect(mockEngine.all('SELECT user_id, source FROM user_email_aliases WHERE local_part = ?', name)[0])
        .toMatchObject({ user_id: null, source: 'reserved' });
    }
  });

  it('but an org MAY hold admin.<slug>, because the slug names the tenant', async () => {
    // admin@ is the platform's. admin.agx@ asserts "the admin of AGX", which is
    // true, and the slug half is appended server-side so it cannot be forged.
    const r = await setAddress(ADMIN_A, 10, 'admin');
    expect(r.status).toBe(200);
    expect(keyOf(10)).toBe('admin.agx');
    expect(await deliverTo('admin.agx@' + DOMAIN)).toMatchObject({ ok: true });
    // …and the bare reserved name is untouched by that.
    expect((await deliverTo('admin@' + DOMAIN)).reason).toBe('address is reserved');
  });
});

// ── Authorization ──────────────────────────────────────────────────────────
describe('who may do it', () => {
  it('an org admin cannot edit another org\'s user', async () => {
    const r = await setAddress(ADMIN_B, 10, 'stolen');
    expect(r.status).toBe(404);              // same answer a missing user gets
    expect(keyOf(10)).toBe('john-46bbee');
  });

  it('an org admin cannot PROBE another org through the uniqueness check', async () => {
    // The tenant guard runs BEFORE the name is validated or looked up. If the
    // probe ran first, a 409-vs-404 difference would tell org B which strings
    // exist in org A, reachable by guessing a SERIAL id.
    await setAddress(ADMIN_A, 10, 'john');
    const taken = await setAddress(ADMIN_B, 10, 'john');   // a name that IS taken
    const free  = await setAddress(ADMIN_B, 10, 'zqxjw');  // a name that is not
    expect(taken.status).toBe(404);
    expect(free.status).toBe(404);
    expect(taken.body).toEqual(free.body);
    // And no statement carrying the probed name ever reached the database.
    expect(mockEngine.all("SELECT COUNT(*) AS n FROM user_email_aliases WHERE local_part LIKE '%zqxjw%'")[0].n).toBe(0);
  });

  it('ignores an org slug supplied in the body', async () => {
    // The slug is appended by the SERVER from the target user's resolved
    // organization. If it could be read from the body, an org-A admin could
    // mint into org B's namespace without ever touching an org-B row — the
    // whole tenancy property would be decided by the attacker's own input.
    const res = await fetch(baseUrl + '/api/auth/users/10', {
      method: 'PUT',
      headers: { 'content-type': 'application/json', authorization: 'Bearer ' + signToken(ADMIN_A) },
      body: JSON.stringify({ inbound_local_part: 'john', org_slug: 'beta', slug: 'beta', organization_id: 900000002 }),
    });
    expect(res.status).toBe(200);
    expect(keyOf(10)).toBe('john.agx');
    expect(mockEngine.all("SELECT COUNT(*) AS n FROM user_email_aliases WHERE local_part LIKE '%beta%'")[0].n).toBe(0);
  });

  it('a non-admin cannot change an address', async () => {
    const r = await setAddress(PM_A, 10, 'hijack');
    expect(r.status).toBe(403);
    expect(keyOf(10)).toBe('john-46bbee');
  });

  it('an admin ROLE without the USERS_MANAGE capability is refused', async () => {
    // The gate is the capability, not the role name.
    mockEngine.db.exec("UPDATE roles SET capabilities = '[]' WHERE name = 'admin'");
    await refreshRoleCache();
    const r = await setAddress(ADMIN_A, 10, 'john');
    expect(r.status).toBe(403);
    expect(r.body.error).toMatch(/do not have permission/i);
    expect(keyOf(10)).toBe('john-46bbee');
  });
});

// ── The new user, and the record ───────────────────────────────────────────
describe('a brand-new user still gets a working address automatically', () => {
  it('the mint runs and the minted address delivers immediately', async () => {
    expect(keyOf(11)).toBeNull();
    const app = express();
    app.use(express.json());
    app.use('/api/email-inbox', inbox);
    const srv = http.createServer(app);
    await new Promise((d) => srv.listen(0, '127.0.0.1', d));
    const url = 'http://127.0.0.1:' + srv.address().port + '/api/email-inbox/my-address';
    const res = await fetch(url, { headers: { authorization: 'Bearer ' + signToken(PM_A) } });
    const body = await res.json();
    srv.close();

    expect(res.status).toBe(200);
    // The mint keeps the HASH deliberately: it is collision-free, needs no org
    // slug (an org-less user has none), and being ugly is what prompts anyone
    // to go set a nice one.
    expect(body.address).toMatch(/^pat-[0-9a-f]{6}@/);
    expect(keyOf(11)).toMatch(/^pat-[0-9a-f]{6}$/);
    // It is in the alias table, so it actually receives mail. A mint that
    // wrote only the column would have produced an address that looks assigned
    // and silently receives nothing.
    expect(await deliverTo(body.address)).toMatchObject({ ok: true });
  });

  it('my-address shows the owner their old addresses, and nobody else\'s', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    const app = express();
    app.use(express.json());
    app.use('/api/email-inbox', inbox);
    const srv = http.createServer(app);
    await new Promise((d) => srv.listen(0, '127.0.0.1', d));
    const res = await fetch('http://127.0.0.1:' + srv.address().port + '/api/email-inbox/my-address',
      { headers: { authorization: 'Bearer ' + signToken(ADMIN_A) } });
    const body = await res.json();
    srv.close();
    expect(body.address).toBe('john.agx@' + DOMAIN);
    expect(body.aliases.map((a) => a.address)).toEqual(['john-46bbee@' + DOMAIN]);
    expect(JSON.stringify(body)).not.toMatch(/bea-ff0011/);
  });
});

describe('the audit row', () => {
  it('records the old primary and the new one', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    const rows = mockEngine.all("SELECT * FROM admin_audit_log WHERE action = 'user.email_key_change'");
    expect(rows).toHaveLength(1);
    const d = typeof rows[0].detail === 'string' ? JSON.parse(rows[0].detail) : rows[0].detail;
    expect(d.primary_before).toBe('john-46bbee');
    expect(d.primary_after).toBe('john.agx');
    expect(rows[0].tier).toBe('A');            // from TIER_A_ACTIONS, by action
    expect(rows[0].outcome).toBe('ok');
    expect(rows[0].organization_id).toBe(1);
    expect(rows[0].scope).toBe('org');          // so the org's own feed can read it
  });

  it('records the refusals too, so an enumeration attempt is visible', async () => {
    await setAddress(ADMIN_A, 10, 'john');
    await setAddress(ADMIN_A, 11, 'john');       // taken
    await setAddress(ADMIN_A, 11, 'mary.jane');  // invalid
    // Not entitled has to be an admin ROLE that lacks the capability: a plain
    // pm never reaches the handler at all (requireRole stops them at the
    // middleware), so that refusal is the route's, not this door's.
    mockEngine.db.exec("UPDATE roles SET capabilities = '[]' WHERE name = 'admin'");
    await refreshRoleCache();
    await setAddress(ADMIN_A, 11, 'nope');       // not entitled
    const denied = mockEngine.all(
      "SELECT reason FROM admin_audit_log WHERE action = 'user.email_key_change' AND outcome = 'denied'"
    ).map((r) => r.reason).sort();
    expect(denied).toEqual(['dot', 'not_entitled', 'taken']);
  });

  it('is tier A by ACTION, so a future call site cannot log it as tier B', async () => {
    // The call site above passes tier 'A' explicitly, which would keep this
    // green even if the action were not registered. Tier is meant to be a
    // property of the ACTION so it cannot drift between two places that emit
    // the same name — so emit it with NO tier and see what the table gets.
    await require('../server/audit').auditLog(
      { actorUserId: 10, actorLabel: 'john@agxco.com', orgId: 1 },
      { action: 'user.email_key_change', targetType: 'user', targetId: '10' }
    );
    const rows = mockEngine.all("SELECT tier FROM admin_audit_log WHERE action = 'user.email_key_change'");
    expect(rows).toHaveLength(1);
    expect(rows[0].tier).toBe('A');
  });

  it('is visible to the org that made the change', () => {
    const list = require('fs').readFileSync(require.resolve('../server/routes/org-audit-routes'), 'utf8');
    // A tier-A row the tenant cannot read is a trail that only the platform
    // owner has. ORG_VISIBLE_ACTIONS is closed by design, so this must be named.
    expect(list).toMatch(/'user\.email_key_change'/);
  });
});
