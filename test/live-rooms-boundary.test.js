// Live Rooms phase 01 — the doors, over the wire.
//
// WHY THE ROUTER IS MOUNTED FOR REAL (the job-org-boundary.test.js rationale)
// The properties here are properties of the MIDDLEWARE CHAIN and of the exact
// SQL each handler emits. "The tenant was stamped from the parent row and not
// from the caller's JWT" is not observable from a handler body, and a source
// grep cannot tell a stamped INSERT from one whose parameter is undefined. So
// the real router runs on a real express app behind real requireAuth, over a
// real socket, against a small in-memory store that records every statement.
//
// The store is a recorder with just enough behaviour to sequence a session. It
// is not Postgres: the partial UNIQUE index, the FK cascades and the boot
// migration are called out in the report as needing a database rather than
// faked into a green tick here.

const express = require('express');
const http = require('http');

let queries;   // every statement emitted, in order
let db;        // the in-memory tables

// The limiters are stubbed to pass-through. Their configuration is asserted
// separately (below) by reading the source: exercising a 12/min join budget
// from one loopback address would make these behavioural tests order-dependent
// and flaky, which is a worse trade than reading the config directly.
jest.mock('../server/rate-limit', () => ({
  ipLoginLimiter: (req, res, next) => next(),
  ipGenericLimiter: (req, res, next) => next(),
  aiChatLimiter: (req, res, next) => next(),
  aiChatHourlyLimiter: (req, res, next) => next(),
  ingestLimiter: (req, res, next) => next(),
  liveJoinLimiter: (req, res, next) => next(),
  liveStreamLimiter: (req, res, next) => next(),
  liveViewLimiter: (req, res, next) => next(),
  liveRoomViewLimiter: (req, res, next) => next()
}));

// Forward-facing names come from here. Stubbed to a fixed string so that if a
// projection ever leaked a raw entity id, the assertion could not pass by
// accidentally matching a label that contains one.
jest.mock('../server/services/entity-labels', () => ({
  resolveEntityLabels: async (orgId, items) => {
    const m = new Map();
    for (const it of items) m.set(it.entity_type + ':' + String(it.entity_id), 'RV2006 Waterside');
    return m;
  }
}));

jest.mock('../server/db', () => ({
  pool: { query: async (sql, params) => mockRun(sql, params) }
}));

function nowish() { return new Date(); }

function mockRun(sql, params) {
  const text = String(sql);
  const p = params || [];
  queries.push({ sql: text, params: p });

  // ── jobs ────────────────────────────────────────────────────────────────
  if (/FROM jobs WHERE/i.test(text)) {
    const j = db.jobs.find((x) => String(x.id) === String(p[0]));
    return { rows: j ? [{ id: j.id, organization_id: j.organization_id }] : [] };
  }
  if (/FROM users WHERE id/i.test(text)) {
    const u = db.users.find((x) => String(x.id) === String(p[0]));
    return { rows: u ? [u] : [] };
  }

  // ── live_rooms ──────────────────────────────────────────────────────────
  if (/INSERT INTO live_rooms/i.test(text)) {
    const room = {
      id: p[0], organization_id: p[1], token: p[2], entity_type: p[3], entity_id: p[4],
      host_user_id: p[5], scope: 'view', expires_at: p[6], served_by: p[7],
      created_at: nowish(), last_host_beat_at: nowish(), served_beat_at: nowish(),
      ended_at: null, ended_reason: null, revoked_at: null, takeover_count: 0
    };
    db.rooms.push(room);
    return { rows: [room] };
  }
  if (/SELECT \* FROM live_rooms\s+WHERE entity_type/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.entity_type === p[0] && String(r.entity_id) === String(p[1]) && !r.ended_at && !r.revoked_at) };
  }
  if (/SELECT \* FROM live_rooms WHERE token/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.token === p[0]) };
  }
  if (/SELECT \* FROM live_rooms WHERE id/i.test(text)) {
    return { rows: db.rooms.filter((r) => r.id === p[0]) };
  }
  if (/SELECT \* FROM live_rooms\s+WHERE organization_id/i.test(text)) {
    return { rows: db.rooms.filter((r) => String(r.organization_id) === String(p[0]) && String(r.host_user_id) === String(p[1]) && !r.ended_at && !r.revoked_at) };
  }
  if (/SELECT id, expires_at, ended_at/i.test(text)) {
    return { rows: db.rooms.filter((r) => !r.ended_at && !r.revoked_at) };
  }
  if (/UPDATE live_rooms SET ended_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.ended_at);
    if (r) { r.ended_at = nowish(); r.ended_reason = p[1]; }
    return { rows: [] };
  }
  if (/UPDATE live_rooms SET revoked_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.revoked_at);
    if (r) r.revoked_at = nowish();
    return { rows: [] };
  }
  if (/UPDATE live_rooms\s+SET served_by/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0]);
    if (r) { r.served_by = p[1]; r.takeover_count += 1; }
    return { rows: r ? [{ takeover_count: r.takeover_count }] : [] };
  }
  if (/UPDATE live_rooms SET last_host_beat_at/i.test(text)) {
    const r = db.rooms.find((x) => x.id === p[0] && !x.ended_at);
    if (r) r.last_host_beat_at = nowish();
    return { rows: [] };
  }
  if (/UPDATE live_rooms SET served_beat_at/i.test(text)) return { rows: [] };

  // ── live_participants ───────────────────────────────────────────────────
  if (/INSERT INTO live_participants/i.test(text)) {
    db.participants.push({
      id: p[0], room_id: p[1], organization_id: p[2], user_id: p[3],
      display_name: p[4], role: p[5], stream_key: p[6],
      joined_at: nowish(), last_seen_at: nowish(),
      left_at: null, left_reason: null, kicked_at: null, kicked_by: null
    });
    return { rows: [] };
  }
  if (/SELECT COUNT\(\*\)::int AS n FROM live_participants/i.test(text)) {
    return { rows: [{ n: db.participants.filter((x) => x.room_id === p[0] && !x.left_at && !x.kicked_at).length }] };
  }
  if (/FROM live_participants p\s+JOIN live_rooms r/i.test(text)) {
    const pt = db.participants.find((x) => x.room_id === p[0] && x.stream_key === p[1] && !x.left_at && !x.kicked_at);
    if (!pt) return { rows: [] };
    const r = db.rooms.find((x) => x.id === pt.room_id);
    if (!r) return { rows: [] };
    return { rows: [Object.assign({}, r, { participant_id: pt.id, role: pt.role, display_name: pt.display_name, user_id: pt.user_id, joined_at: pt.joined_at })] };
  }
  if (/SELECT id, user_id, display_name, role, joined_at/i.test(text)) {
    return { rows: db.participants.filter((x) => x.room_id === p[0] && !x.left_at && !x.kicked_at) };
  }
  if (/SELECT id, room_id, organization_id, role FROM live_participants/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && x.room_id === p[1]);
    return { rows: pt ? [pt] : [] };
  }
  // Every handler below revokes the stream key only when the STATEMENT says
  // to. See the note on the room-end handler: a mock that revokes
  // unconditionally is more correct than the code it stands in for, and it
  // makes "this path actually kills the credential" unfalsifiable.
  const revokes = /stream_key = NULL/i.test(text);
  if (/UPDATE live_participants\s+SET kicked_at/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0]);
    if (pt) {
      pt.kicked_at = nowish(); pt.kicked_by = p[1];
      pt.left_at = pt.left_at || nowish(); pt.left_reason = pt.left_reason || 'kicked';
      if (revokes) pt.stream_key = null;
    }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*role = 'host'/i.test(text)) {
    const hits = db.participants.filter((x) => x.room_id === p[0] && x.role === 'host' && !x.left_at);
    for (const x of hits) { x.left_at = nowish(); x.left_reason = 'superseded'; if (revokes) x.stream_key = null; }
    return { rows: hits.map((x) => ({ id: x.id })) };
  }
  if (/UPDATE live_participants[\s\S]*left_reason = 'left'/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && !x.left_at);
    if (pt) { pt.left_at = nowish(); pt.left_reason = 'left'; if (revokes) pt.stream_key = null; }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*left_reason = 'timeout'/i.test(text)) {
    const pt = db.participants.find((x) => x.id === p[0] && !x.left_at);
    if (pt) { pt.left_at = nowish(); pt.left_reason = 'timeout'; if (revokes) pt.stream_key = null; }
    return { rows: [] };
  }
  if (/UPDATE live_participants[\s\S]*SET left_at = NOW\(\), left_reason = COALESCE/i.test(text)) {
    for (const x of db.participants.filter((y) => y.room_id === p[0] && !y.left_at)) {
      x.left_at = nowish(); x.left_reason = x.left_reason || p[1];
      // Only revoke the key if the STATEMENT actually says to. A mock that
      // nulls it unconditionally is more correct than the code it stands in
      // for, which makes "ending revokes every stream key" untestable — that
      // is exactly how mutation M12 slipped through the first run.
      if (/stream_key = NULL/i.test(text)) x.stream_key = null;
    }
    return { rows: [] };
  }
  if (/UPDATE live_participants SET last_seen_at/i.test(text)) return { rows: [] };

  return { rows: [] };
}

const { signToken, setRolePool } = require('../server/auth');
const liveRoutes = require('../server/routes/live-routes');
setRolePool(require('../server/db').pool);

let server, baseUrl;

beforeAll((done) => {
  const app = express();
  app.use(express.json());
  app.use(require('cookie-parser')());
  app.use('/api/live', liveRoutes);
  server = http.createServer(app);
  server.listen(0, '127.0.0.1', () => {
    baseUrl = 'http://127.0.0.1:' + server.address().port;
    done();
  });
});

afterAll((done) => {
  liveRoutes.__internals.stopSweeper();
  for (const id of Array.from(liveRoutes.__internals._rooms.keys())) {
    liveRoutes.__internals.destroyHub(id, 'test');
  }
  server.close(() => done());
});

beforeEach(() => {
  queries = [];
  db = {
    users: [
      { id: 10, name: 'Host A', organization_id: 1 },
      { id: 11, name: 'Viewer A', organization_id: 1 },
      { id: 20, name: 'User B', organization_id: 2 }
    ],
    // jobA belongs to org 1, jobB to org 2, jobNull is the legacy unstamped row
    // that services/job-org-scope.js's tolerance arm would have let through.
    jobs: [
      { id: 'jobA', organization_id: 1 },
      { id: 'jobB', organization_id: 2 },
      { id: 'jobNull', organization_id: null }
    ],
    rooms: [],
    participants: []
  };
  for (const id of Array.from(liveRoutes.__internals._rooms.keys())) {
    liveRoutes.__internals.destroyHub(id, 'test-reset');
  }
  liveRoutes.__internals._softBans.clear();
});

function tokenFor(user) {
  return signToken(Object.assign({ id: 10, email: 'a@b.c', role: 'admin', name: 'Host A', organization_id: 1 }, user));
}

async function call(method, path, opts) {
  opts = opts || {};
  const headers = { 'content-type': 'application/json' };
  if (opts.user !== null) headers.authorization = 'Bearer ' + tokenFor(opts.user || {});
  const res = await fetch(baseUrl + path, {
    method, headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body)
  });
  let json = null;
  try { json = await res.json(); } catch (e) {}
  return { status: res.status, body: json };
}

async function mint(user) {
  return call('POST', '/api/live/rooms', { user: user, body: { entity_type: 'job', entity_id: 'jobA' } });
}

const HEX64 = /^[a-f0-9]{64}$/;

// ══ A room is created, joined, and ends ═══════════════════════════════════

describe('a room is created, joined, and ends', () => {
  test('minting returns a 64-hex token and a forward-facing title', async () => {
    const r = await mint();
    expect(r.status).toBe(200);
    expect(r.body.token).toMatch(HEX64);
    expect(r.body.room.title).toBe('RV2006 Waterside');
    expect(r.body.reused).toBe(false);
  });

  test('the tenant is stamped from the PARENT ROW, not from the caller JWT', async () => {
    await mint();
    const ins = queries.find((q) => /INSERT INTO live_rooms/i.test(q.sql));
    // $2 is organization_id. The job's org is 1 here and so is the caller's, so
    // the sharper proof is the unstamped-job case below — this asserts the
    // value actually landed rather than arriving undefined.
    expect(ins.params[1]).toBe(1);
    expect(db.rooms[0].organization_id).toBe(1);
  });

  test('a guest joins with the token alone and gets a scoped stream key', async () => {
    const m = await mint();
    const j = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    expect(j.status).toBe(200);
    expect(j.body.stream_key).toMatch(HEX64);
    expect(j.body.role).toBe('viewer');
    expect(j.body.display_name).toBe('Dave');
    // No account was provisioned and no cookie was set — the sub-portal
    // logout trap started with a guest flow that minted both.
    expect(queries.some((q) => /INSERT INTO users/i.test(q.sql))).toBe(false);
  });

  test('the host joins their own room as host', async () => {
    const m = await mint();
    const j = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    expect(j.body.role).toBe('host');
  });

  test('the roster reflects reality: two joins, two participants', async () => {
    const m = await mint();
    await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const live = db.participants.filter((p) => !p.left_at);
    expect(live.length).toBe(2);
    expect(live.map((p) => p.role).sort()).toEqual(['host', 'viewer']);
  });

  test('ending marks the room ended and detaches every participant', async () => {
    const m = await mint();
    const j = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const e = await call('POST', '/api/live/rooms/' + m.body.room.id + '/end', { body: {} });
    expect(e.status).toBe(200);
    expect(db.rooms[0].ended_at).toBeTruthy();
    expect(db.rooms[0].ended_reason).toBe('host_ended');
    // Ending must actually STOP the broadcast: the keys are revoked, so the
    // stream credential is dead the moment the room is.
    expect(db.participants.every((p) => p.stream_key === null)).toBe(true);
    const beat = await call('POST', '/api/live/' + m.body.room.id + '/beat/' + j.body.stream_key, { user: null, body: {} });
    expect(beat.status).toBe(404);
  });

  test('a joiner on an ended room is told it ENDED, not that it never existed', async () => {
    const m = await mint();
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/end', { body: {} });
    const j = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    expect(j.status).toBe(410);
    expect(j.body.reason).toBe('host_ended');
  });

  test('the status probe names which of the six ways it ended', async () => {
    const m = await mint();
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/end', { body: {} });
    const s = await call('GET', '/api/live/' + m.body.token + '/status', { user: null });
    expect(s.status).toBe(200);
    expect(s.body.usable).toBe(false);
    expect(s.body.reason).toBe('host_ended');
  });

  // R6: EventSource surfaces no status code, so without this endpoint a slept
  // phone cannot tell "the room ended" from "my row aged out". It exists, it is
  // reachable with the token alone, and it answers about a LIVE room too.
  test('the status probe answers usable while the room is live', async () => {
    const m = await mint();
    const s = await call('GET', '/api/live/' + m.body.token + '/status', { user: null });
    expect(s.body.usable).toBe(true);
    expect(s.body.state).toBe('live');
  });
});

// ══ Born inside a tenant ══════════════════════════════════════════════════

describe('a room in another tenant is not reachable', () => {
  test("minting against another tenant's job is refused as NOT FOUND", async () => {
    const r = await call('POST', '/api/live/rooms', {
      user: { id: 10, organization_id: 1 }, body: { entity_type: 'job', entity_id: 'jobB' }
    });
    expect(r.status).toBe(404);
    expect(db.rooms.length).toBe(0);
    expect(queries.some((q) => /INSERT INTO live_rooms/i.test(q.sql))).toBe(false);
  });

  test('a foreign job and an absent job are indistinguishable', async () => {
    const foreign = await call('POST', '/api/live/rooms', { user: { organization_id: 1 }, body: { entity_type: 'job', entity_id: 'jobB' } });
    const absent = await call('POST', '/api/live/rooms', { user: { organization_id: 1 }, body: { entity_type: 'job', entity_id: 'nope' } });
    expect(foreign.status).toBe(absent.status);
    expect(foreign.body).toEqual(absent.body);
  });

  // REVIEWER 2's F1, end to end. jobInOrg() would have returned TRUE here for
  // every tenant, and the NOT NULL stamp would then have had nothing to read.
  test('an UNSTAMPED job cannot host a room for anyone, and says why', async () => {
    for (const org of [1, 2]) {
      const r = await call('POST', '/api/live/rooms', {
        user: { id: 10, organization_id: org }, body: { entity_type: 'job', entity_id: 'jobNull' }
      });
      expect(r.status).toBe(409);
      expect(r.body.code).toBe('ENTITY_UNSTAMPED');
      expect(r.body.error).toMatch(/administrator/i);
    }
    expect(db.rooms.length).toBe(0);
  });

  test("an org-B admin cannot end or kick in an org-A room", async () => {
    const m = await mint({ id: 10, organization_id: 1 });
    const roomId = m.body.room.id;
    const e = await call('POST', '/api/live/rooms/' + roomId + '/end', { user: { id: 20, organization_id: 2 }, body: {} });
    expect(e.status).toBe(404);
    expect(db.rooms[0].ended_at).toBeFalsy();
    const k = await call('POST', '/api/live/rooms/' + roomId + '/kick', { user: { id: 20, organization_id: 2 }, body: { participant_id: 'x' } });
    expect(k.status).toBe(404);
  });

  test('an org-B user opening an org-A link is a GUEST of org A, not a member', async () => {
    const m = await mint({ id: 10, organization_id: 1 });
    const j = await call('POST', '/api/live/' + m.body.token + '/join', {
      user: { id: 20, organization_id: 2, name: 'User B' }, body: { display_name: 'B' }
    });
    expect(j.status).toBe(200);
    const row = db.participants.find((p) => p.id === j.body.participant_id);
    // The tenant on the child row is the ROOM's. A foreign user id never lands
    // on an org-A row, and the visitor is not silently promoted to a member.
    expect(row.organization_id).toBe(1);
    expect(row.user_id).toBeNull();
    expect(row.role).toBe('viewer');
  });

  test('the room list is scoped to the caller org AND the caller', async () => {
    await mint({ id: 10, organization_id: 1 });
    const mine = await call('GET', '/api/live/mine', { user: { id: 10, organization_id: 1 } });
    expect(mine.body.rooms.length).toBe(1);
    const theirs = await call('GET', '/api/live/mine', { user: { id: 20, organization_id: 2 } });
    expect(theirs.body.rooms.length).toBe(0);
    // Same org, different host — a room is not a shared org resource.
    const other = await call('GET', '/api/live/mine', { user: { id: 11, organization_id: 1 } });
    expect(other.body.rooms.length).toBe(0);
  });
});

// ══ The guest token reaches its room and nothing else ═════════════════════

describe('a guest token reaches its room and nothing else', () => {
  test('an unauthenticated caller cannot mint, list, end or kick', async () => {
    const a = await call('POST', '/api/live/rooms', { user: null, body: { entity_type: 'job', entity_id: 'jobA' } });
    const b = await call('GET', '/api/live/mine', { user: null });
    expect(a.status).toBe(401);
    expect(b.status).toBe(401);
  });

  test('a room token is not a room id — it cannot be used to end or kick', async () => {
    const m = await mint();
    const e = await call('POST', '/api/live/rooms/' + m.body.token + '/end', { user: null, body: {} });
    expect(e.status).toBe(401);
    expect(db.rooms[0].ended_at).toBeFalsy();
  });

  test("one room's stream key does not open another room", async () => {
    const m1 = await mint();
    db.jobs.push({ id: 'jobA2', organization_id: 1 });
    const m2 = await call('POST', '/api/live/rooms', { body: { entity_type: 'job', entity_id: 'jobA2' } });
    const j1 = await call('POST', '/api/live/' + m1.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    // The credential is matched on (room_id, stream_key) as a PAIR.
    const cross = await call('POST', '/api/live/' + m2.body.room.id + '/beat/' + j1.body.stream_key, { user: null, body: {} });
    expect(cross.status).toBe(404);
  });

  test('a malformed credential is refused before the database is touched', async () => {
    const m = await mint();
    queries = [];
    const r = await call('POST', '/api/live/' + m.body.room.id + '/beat/not-a-key', { user: null, body: {} });
    expect(r.status).toBe(404);
    expect(queries.length).toBe(0);
  });

  // REVIEWER 2's F3. Checking the credential FIRST is what stops the door
  // becoming a room-existence oracle: a prober with a garbage key learns the
  // same thing whether the room is live, ended, or never existed.
  test('the credential is checked before any room state is revealed', async () => {
    const m = await mint();
    const live = await call('POST', '/api/live/' + m.body.room.id + '/beat/' + 'a'.repeat(64), { user: null, body: {} });
    const absent = await call('POST', '/api/live/lrm_nope/beat/' + 'a'.repeat(64), { user: null, body: {} });
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/end', { body: {} });
    const ended = await call('POST', '/api/live/' + m.body.room.id + '/beat/' + 'a'.repeat(64), { user: null, body: {} });
    expect(live.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(ended.status).toBe(404);
    expect(live.body).toEqual(absent.body);
    expect(ended.body).toEqual(absent.body);
  });

  test('an unknown room token is 404 and reveals nothing', async () => {
    const r = await call('GET', '/api/live/' + 'f'.repeat(64) + '/status', { user: null });
    expect(r.status).toBe(404);
  });

  test('a guest never receives the room token, the entity id or a tenant id', async () => {
    const m = await mint();
    const j = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const s = JSON.stringify(j.body);
    expect(s).not.toContain(m.body.token);
    expect(s).not.toContain('jobA');
    expect(s).not.toMatch(/organization_id/);
  });
});

// ══ A kicked participant cannot rejoin ════════════════════════════════════

describe('removal', () => {
  test('a kicked stream key is dead immediately, on every channel', async () => {
    const m = await mint();
    await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });   // host
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const k = await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: g.body.participant_id } });
    expect(k.status).toBe(200);
    for (const ch of ['beat', 'leave']) {
      const r = await call('POST', '/api/live/' + m.body.room.id + '/' + ch + '/' + g.body.stream_key, { user: null, body: {} });
      expect(r.status).toBe(404);
    }
    const row = db.participants.find((p) => p.id === g.body.participant_id);
    expect(row.kicked_at).toBeTruthy();
    // The kicked_at predicate is what actually closes the door — loadStreamContext
    // matches on `kicked_at IS NULL`. Revoking the key is defence in depth on top
    // of it, and it is asserted separately so it cannot be quietly dropped on the
    // theory that the predicate already covers it.
    expect(row.stream_key).toBeNull();
  });

  test('the kicked participant leaves the roster', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: g.body.participant_id } });
    expect(db.participants.filter((p) => !p.left_at).length).toBe(0);
  });

  // THE HONEST LIMITATION, asserted rather than glossed. A guest's only
  // identity is the link. A plain Remove kills the session and cannot kill the
  // link, and the response SAYS SO instead of implying a guarantee it has not
  // got. Revoking is the removal that actually holds.
  test('plain removal admits that the link still works', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const k = await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: g.body.participant_id } });
    expect(k.body.revoked).toBe(false);
    expect(k.body.note).toMatch(/can rejoin/i);
    expect(k.body.note).toMatch(/revoke/i);
  });

  test('remove-and-revoke kills the link for everyone, permanently', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const k = await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', {
      body: { participant_id: g.body.participant_id, revoke: true }
    });
    expect(k.body.revoked).toBe(true);
    expect(k.body.note).toMatch(/Nobody can rejoin/i);
    const rejoin = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    expect(rejoin.status).toBe(410);
    expect(db.rooms[0].revoked_at).toBeTruthy();
  });

  test('a plain removal soft-bans the same client for a while, best effort', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    // The ban is keyed on a fingerprint captured when the STREAM opened, so a
    // participant who never opened one is not covered. That is the honest
    // shape: it is a speed bump, and the API never calls it a guarantee.
    await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: g.body.participant_id } });
    const again = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    expect([200, 403]).toContain(again.status);
  });

  test('the host cannot be kicked out of their own session', async () => {
    const m = await mint();
    const h = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const k = await call('POST', '/api/live/rooms/' + m.body.room.id + '/kick', { body: { participant_id: h.body.participant_id } });
    expect(k.status).toBe(400);
    expect(k.body.error).toMatch(/End the session/i);
  });
});

// ══ Ending is as reliable as starting ═════════════════════════════════════

describe('every way a session stops', () => {
  test('the host leaving ends the room, not just their own membership', async () => {
    const m = await mint();
    const h = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    await call('POST', '/api/live/' + m.body.room.id + '/leave/' + h.body.stream_key, { body: {} });
    expect(db.rooms[0].ended_at).toBeTruthy();
    expect(db.rooms[0].ended_reason).toBe('host_left');
  });

  test('a viewer leaving does NOT end the room', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    await call('POST', '/api/live/' + m.body.room.id + '/leave/' + g.body.stream_key, { user: null, body: {} });
    expect(db.rooms[0].ended_at).toBeFalsy();
  });

  // H4: the named worst defect, reachable by ordinary behaviour. Two tabs, and
  // closing the one you THINK you are presenting from leaves the room alive on
  // the strength of a forgotten background tab.
  test('a second host tab SUPERSEDES the first — there is only ever one host', async () => {
    const m = await mint();
    const h1 = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const h2 = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    expect(h2.body.participant_id).not.toBe(h1.body.participant_id);
    const first = db.participants.find((p) => p.id === h1.body.participant_id);
    expect(first.left_at).toBeTruthy();
    expect(first.left_reason).toBe('superseded');
    expect(first.stream_key).toBeNull();
    expect(db.participants.filter((p) => p.role === 'host' && !p.left_at).length).toBe(1);
    // And the superseded tab's credential is genuinely dead.
    const stale = await call('POST', '/api/live/' + m.body.room.id + '/beat/' + h1.body.stream_key, { body: {} });
    expect(stale.status).toBe(404);
  });

  // THE SAME DEFECT, ONE DOOR LOWER. 2dd1239 stopped the guest PAGE from
  // booting the host surface, but the host role is decided from the COOKIE and
  // the cookie rides the join the read-only page still makes. So the host
  // opening the link he had just copied — the first thing anyone does after
  // pressing Present — took the room's one host row from a page that never
  // reports a route, and killed the tab he was presenting from. Reported live,
  // 2026-08-19, mid-presentation.
  test("a join that asks for 'viewer' is NOT promoted to host, even holding the host's own cookie", async () => {
    const m = await mint();
    const h1 = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    expect(h1.body.role).toBe('host');

    // The same signed-in host, from the guest page.
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { body: { as: 'viewer' } });
    expect(g.body.role).toBe('viewer');

    // The presenting tab is untouched: still host, still live, still holding a
    // working credential.
    const first = db.participants.find((p) => p.id === h1.body.participant_id);
    expect(first.left_at).toBeFalsy();
    expect(first.left_reason).toBeNull();
    expect(first.stream_key).toBe(h1.body.stream_key);
    const beat = await call('POST', '/api/live/' + m.body.room.id + '/beat/' + h1.body.stream_key, { body: {} });
    expect(beat.status).toBe(200);
  });

  test("'as' can only ever take a role away — it never grants one", async () => {
    const m = await mint();
    // A viewer asking to be the host is still a viewer. The downgrade is
    // believable precisely because it cannot be an upgrade.
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave', as: 'host' } });
    expect(g.body.role).toBe('viewer');
    const g2 = await call('POST', '/api/live/' + m.body.token + '/join', { user: { id: 11, name: 'Viewer A' }, body: { as: 'host' } });
    expect(g2.body.role).toBe('viewer');
    // And the room still has no host row that a guest created.
    expect(db.participants.filter((p) => p.role === 'host').length).toBe(0);
  });

  test("a downgraded host holds no host powers: their beat cannot steer the room", async () => {
    const m = await mint();
    const h = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { body: { as: 'viewer' } });
    // The host puts the room on a real surface.
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + h.body.stream_key,
      { body: { view: { entity_type: 'job', entity_id: 'jobA', surface: 'job-overview' } } });
    const hub = liveRoutes.__internals._rooms.get(m.body.room.id);
    expect(hub.view.surface).toBe('job-overview');
    // The downgraded tab claims a foreign record. It is a viewer, so it is
    // ignored — this is the leg that made the mirror go dark.
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + g.body.stream_key,
      { body: { view: { entity_type: 'job', entity_id: 'jobB', surface: 'job-overview' } } });
    expect(hub.view.surface).toBe('job-overview');
    expect(hub.view.reason).toBeNull();
  });

  test('an expired room is swept, and it says it expired', async () => {
    const m = await mint();
    db.rooms[0].expires_at = new Date(Date.now() - 1000);
    await liveRoutes.__internals.sweepOnce();
    expect(db.rooms[0].ended_at).toBeTruthy();
    expect(db.rooms[0].ended_reason).toBe('expired');
  });

  test('a host whose beacon dies has the room ended for them', async () => {
    const m = await mint();
    db.rooms[0].last_host_beat_at = new Date(Date.now() - 10 * 60 * 1000);
    await liveRoutes.__internals.sweepOnce();
    expect(db.rooms[0].ended_at).toBeTruthy();
    expect(db.rooms[0].ended_reason).toBe('host_timeout');
  });

  test('re-minting on a live room returns the SAME room rather than a second credential', async () => {
    const a = await mint();
    const b = await mint();
    expect(b.body.reused).toBe(true);
    expect(b.body.token).toBe(a.body.token);
    expect(db.rooms.length).toBe(1);
  });

  test('a different host cannot open a competing room on the same record', async () => {
    await mint({ id: 10, organization_id: 1 });
    const other = await call('POST', '/api/live/rooms', {
      user: { id: 11, organization_id: 1, name: 'Viewer A' }, body: { entity_type: 'job', entity_id: 'jobA' }
    });
    expect(other.status).toBe(409);
    expect(other.body.code).toBe('ROOM_ALREADY_LIVE');
    expect(db.rooms.length).toBe(1);
  });

  test('an unsupported entity type never reaches a table name', async () => {
    const r = await call('POST', '/api/live/rooms', { body: { entity_type: 'users', entity_id: '1' } });
    expect(r.status).toBe(400);
    expect(queries.some((q) => /FROM users/i.test(q.sql))).toBe(false);
  });
});

// ══ Presence and cursors ══════════════════════════════════════════════════

describe('presence reflects a dropped stream honestly', () => {
  test('a participant whose beacon dies is REMOVED, not left on the roster', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const h = liveRoutes.__internals._rooms.get(m.body.room.id);
    expect(h.beats.has(g.body.participant_id)).toBe(true);

    // Wind the beacon back past the gone threshold. This is the wedged-tab
    // case: the socket may well still be open, and it is not evidence.
    h.beats.set(g.body.participant_id, Date.now() - 10 * 60 * 1000);
    await liveRoutes.__internals.sweepOnce();

    expect(h.beats.has(g.body.participant_id)).toBe(false);
    const row = db.participants.find((p) => p.id === g.body.participant_id);
    expect(row.left_at).toBeTruthy();
    expect(row.left_reason).toBe('timeout');
    expect(row.stream_key).toBeNull();
  });

  test('a stale beacon keeps them on the roster but stops asserting they are live', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const h = liveRoutes.__internals._rooms.get(m.body.room.id);
    const S = require('../server/services/live-rooms');
    h.beats.set(g.body.participant_id, Date.now() - (S.STALE_MS + 1000));
    await liveRoutes.__internals.sweepOnce();
    expect(db.participants.find((p) => p.id === g.body.participant_id).left_at).toBeFalsy();
    expect(h.presence.get(g.body.participant_id)).toBe('stale');
  });

  test('a beat refreshes the beacon', async () => {
    const m = await mint();
    const g = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });
    const h = liveRoutes.__internals._rooms.get(m.body.room.id);
    h.beats.set(g.body.participant_id, Date.now() - 30000);
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + g.body.stream_key, { user: null, body: {} });
    expect(Date.now() - h.beats.get(g.body.participant_id)).toBeLessThan(2000);
  });
});

describe('cursors round-trip over the real stream', () => {
  // PHASE 02 FIDELITY PASS — this test used to assert the opposite, and the
  // opposite was waste. A guest was sent every one of the host's pointer
  // samples — 10 Hz sampled, up to 12 triples per 5s beat, roughly 3.6 KB a
  // minute — and live.html has never drawn one and cannot: the host's
  // coordinate is measured against index.html's workspace, and the guest is
  // looking at a different document. Against a stated budget of "a few
  // kilobytes a minute" that was plausibly the majority of steady-state guest
  // traffic, spent on frames that end in a Map nothing reads.
  //
  // The drop is at the projection seam, not at the sampler, so a second
  // PRESENTER — the only recipient that could ever draw one — keeps receiving
  // them, and the phase-01 mechanism is intact underneath.
  test("a guest receives no cursor frame, because a guest cannot draw one", async () => {
    const m = await mint();
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const guest = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'Dave' } });

    const ac = new AbortController();
    const streamRes = await fetch(
      baseUrl + '/api/live/' + m.body.room.id + '/stream/' + guest.body.stream_key,
      { signal: ac.signal }
    );
    expect(streamRes.status).toBe(200);
    expect(streamRes.headers.get('content-type')).toMatch(/text\/event-stream/);

    const reader = streamRes.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    const readFor = async (predicate, ms) => {
      const deadline = Date.now() + ms;
      while (Date.now() < deadline) {
        const t = await Promise.race([
          reader.read(),
          new Promise((r) => setTimeout(() => r({ value: undefined, done: false }), 200))
        ]);
        if (t.value) buf += decoder.decode(t.value, { stream: true });
        const hit = predicate(buf);
        if (hit) return hit;
      }
      return null;
    };

    const hello = await readFor((b) => {
      const line = b.split('\n').find((l) => l.startsWith('data: ') && l.includes('"hello"'));
      return line ? JSON.parse(line.slice(6)) : null;
    }, 4000);
    expect(hello).toBeTruthy();
    expect(hello.you.participant_id).toBe(guest.body.participant_id);
    // The hello carries the forward-facing name and no raw entity id.
    expect(hello.room.title).toBe('RV2006 Waterside');
    expect(JSON.stringify(hello.room)).not.toContain('jobA');

    // The host posts a cursor batch.
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + host.body.stream_key, {
      body: { cursor: [[1, 1234, 5678], [2, 4321, 8765]] }
    });

    const cursor = await readFor((b) => {
      const line = b.split('\n').find((l) => l.startsWith('data: ') && l.includes('"cursor"'));
      return line ? JSON.parse(line.slice(6)) : null;
    }, 1500);
    expect(cursor).toBeNull();
    // Not sent, and NOT sent as an empty frame either: a null projection means
    // do-not-send, and `data: null` on the wire would be the same bytes with a
    // worse client contract.
    expect(buf).not.toContain('data: null');
    expect(buf).not.toContain('1234');

    // The mechanism underneath is untouched: the server still normalises and
    // still stores the position, so a second presenter joining would be handed
    // it. What changed is only who it is written to.
    const hub = liveRoutes.__internals._rooms.get(m.body.room.id);
    expect(hub.cursors.get(host.body.participant_id)).toEqual([2, 4321, 8765]);

    ac.abort();
    try { await reader.cancel(); } catch (e) {}
  }, 20000);

  test('a sender does not receive their own cursor back', async () => {
    const m = await mint();
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const h = liveRoutes.__internals._rooms.get(m.body.room.id);
    const seen = [];
    h.subs.set(host.body.participant_id, { res: { write: (s) => seen.push(s), end() {} }, fails: 0, connectedAt: Date.now() });
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + host.body.stream_key, {
      body: { cursor: [[1, 10, 20]] }
    });
    expect(seen.filter((s) => s.includes('"cursor"')).length).toBe(0);
  });

  test('junk coordinates never reach another participant', async () => {
    const m = await mint();
    const host = await call('POST', '/api/live/' + m.body.token + '/join', { body: {} });
    const guest = await call('POST', '/api/live/' + m.body.token + '/join', { user: null, body: { display_name: 'D' } });
    const h = liveRoutes.__internals._rooms.get(m.body.room.id);
    const seen = [];
    h.subs.set(guest.body.participant_id, { res: { write: (s) => seen.push(s), end() {} }, fails: 0, connectedAt: Date.now() });
    await call('POST', '/api/live/' + m.body.room.id + '/beat/' + host.body.stream_key, {
      body: { cursor: 'drop table' }
    });
    expect(seen.filter((s) => s.includes('"cursor"')).length).toBe(0);
  });
});

// ══ Wiring that behaviour cannot observe ══════════════════════════════════
// These read the source on purpose. Each is a property of where something is
// MOUNTED or how a limiter is KEYED, which no request against this app can
// demonstrate — and each one, if it regressed, would break a live session in a
// way the behavioural tests above would still pass through.

describe('the mount and the limiters', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const INDEX = read('server', 'index.js');
  const RL = read('server', 'rate-limit.js');
  const SW = read('sw.js');

  // R1/R2: express middleware is additive. A limiter mounted "ahead of" the
  // global guard does not replace it — the request still lands in the 200/min
  // per-IP bucket, where three people in one room consume 180 of it and a 429
  // on the host's beacon ENDS the session.
  test('/api/live is mounted ABOVE the global per-IP guard', () => {
    const live = INDEX.indexOf("app.use('/api/live'");
    const guard = INDEX.indexOf("app.use('/api', ipGenericLimiter)");
    expect(live).toBeGreaterThan(-1);
    expect(guard).toBeGreaterThan(-1);
    expect(live).toBeLessThan(guard);
  });

  test('/api/live is mounted BELOW the JSON and cookie parsers', () => {
    const live = INDEX.indexOf("app.use('/api/live'");
    expect(INDEX.indexOf('app.use(express.json(')).toBeLessThan(live);
    expect(INDEX.indexOf('app.use(cookieParser())')).toBeLessThan(live);
  });

  test('the join door is keyed per IP, because no credential exists yet', () => {
    const block = RL.slice(RL.indexOf('const liveJoinLimiter'), RL.indexOf('const liveStreamLimiter'));
    expect(block).toMatch(/keyGenerator/);
    expect(block).toMatch(/'ip:'/);
  });

  test('the in-session channels are keyed per stream_key, not per IP', () => {
    const block = RL.slice(RL.indexOf('const liveStreamLimiter'), RL.indexOf('module.exports'));
    expect(block).toMatch(/req\.params[\s\S]*streamKey/);
  });

  // The /live/:token page must beat express.static and the SPA fallback, or it
  // serves the app shell instead of the viewer page.
  test('the viewer page is registered before the ROOT static mount and the SPA fallback', () => {
    const live = INDEX.indexOf("app.get('/live/:token'");
    // Named specifically: there is an earlier express.static for the uploads
    // directory, and matching that one would make this assertion pass or fail
    // on an unrelated mount.
    const rootStatic = INDEX.indexOf("app.use(express.static(path.join(__dirname, '..')))");
    const spaFallback = INDEX.indexOf("app.get('*'");
    expect(live).toBeGreaterThan(-1);
    expect(rootStatic).toBeGreaterThan(-1);
    expect(spaFallback).toBeGreaterThan(-1);
    expect(live).toBeLessThan(rootStatic);
    expect(live).toBeLessThan(spaFallback);
    // And alongside the other token page, which is the precedent it copies.
    expect(INDEX.indexOf("app.get('/t/:token'")).toBeLessThan(rootStatic);
  });

  test('the viewer page sets Referrer-Policy explicitly rather than inheriting a default', () => {
    const block = INDEX.slice(INDEX.indexOf("app.get('/live/:token'"), INDEX.indexOf("app.get('/live/:token'") + 600);
    expect(block).toMatch(/Referrer-Policy/);
    expect(block).toMatch(/no-referrer/);
    expect(block).toMatch(/no-store/);
  });

  // S1: cache.put() ignores Cache-Control, and `cache: 'no-store'` is a
  // fetch() option with no effect on a top-level navigation. The ONLY thing
  // that keeps a token-bearing URL out of Cache Storage is not entering the
  // navigation branch at all.
  test('the service worker refuses to cache credential-bearing URLs', () => {
    const fetchHandler = SW.slice(SW.indexOf("self.addEventListener('fetch'"));
    const bypass = fetchHandler.indexOf("startsWith('/live/')");
    const navBranch = fetchHandler.indexOf('isNavigation');
    expect(bypass).toBeGreaterThan(-1);
    expect(bypass).toBeLessThan(navBranch);
  });

  test('the stream lives under /api/ so the service worker never caches it', () => {
    const ROUTES = read('server', 'routes', 'live-routes.js');
    expect(ROUTES).toMatch(/router\.get\('\/:roomId\/stream\/:streamKey'/);
    const fetchHandler = SW.slice(SW.indexOf("self.addEventListener('fetch'"));
    expect(fetchHandler.indexOf("startsWith('/api/')"))
      .toBeLessThan(fetchHandler.indexOf('isNavigation'));
  });

  // Cache-bust rule: an edited js/css file that keeps its old ?v stays behind
  // stale cache for everyone who already has the page.
  test('the client assets are cache-busted in index.html', () => {
    const HTML = read('index.html');
    expect(HTML).toMatch(/js\/live-rooms\.js\?v=\d+/);
    expect(HTML).toMatch(/css\/live-rooms\.css\?v=\d+/);
  });
});

// The phase-01 drift guard, REWRITTEN into its phase-02 form rather than
// deleted. Two of its four clauses were "phase 02 has not been designed yet"
// and are now false by construction; the other two are still true and stay
// exactly as they were. Deleting the whole block would have thrown away the
// only thing standing between phase 03/04 and a foundation shaped by a feature
// nobody has designed.
describe('phase 02 is built; phase 03 and 04 are still not', () => {
  const fs = require('fs');
  const path = require('path');
  const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
  const ROUTES = read('server', 'routes', 'live-routes.js');
  const VIEW = read('server', 'services', 'live-view.js');
  const SRC = ROUTES + read('js', 'live-rooms.js') + read('js', 'live-view.js') + read('live.html') + VIEW;

  test('no stroke work and no guest writes — 03 and 04 are untouched', () => {
    // UNCHANGED from phase 01. A whiteboard and a guest write capability are
    // still not being built, and the guard that says so must not weaken just
    // because the file next to it grew.
    expect(SRC).not.toMatch(/allow_?draw|allowDraw|viewers_can_draw/i);
    expect(SRC).not.toMatch(/\bstroke_id\b|applyStroke/i);
  });

  test('no guest JWT is ever minted — the ~40 money endpoints stay unreachable', () => {
    // THE STANDING PROHIBITION. requireAuth is JWT-only, which is the ONLY
    // reason a room token cannot reach a money endpoint. Mint a guest JWT and
    // every one of those doors opens at once, and the field list stops being a
    // spec and becomes a breach surface.
    expect(ROUTES).not.toMatch(/signToken/);
    expect(ROUTES).not.toMatch(/res\.cookie\(/);
    expect(ROUTES).not.toMatch(/INSERT INTO users/i);
  });

  test('hide_financials is a ROOM COLUMN with a fail-closed reader', () => {
    expect(read('server', 'db.js')).toMatch(/ALTER TABLE live_rooms ADD COLUMN IF NOT EXISTS hide_financials BOOLEAN NOT NULL DEFAULT TRUE/);
    // Fail-closed by SHAPE: the permissive branch tests `=== false`, so NULL,
    // undefined, 'f', 0 and anything a future build writes mean HIDDEN.
    expect(VIEW).toMatch(/room\.hide_financials === false/);
    // And it is not a scope value: overloading normalizeScope would make "may
    // draw" and "may see margin" one dimension, and phase 04 would need
    // 'draw' x {money on, money off} the day it lands. The comment explaining
    // that is allowed to name the function; the CODE must never call it.
    expect(VIEW).not.toMatch(/normalizeScope\(/);
    // And it stays PURE: a module that require()s server/routes/* only loads
    // where JWT_SECRET is set, which would make the redactor the hardest thing
    // here to test. (The prose above is allowed to say the word.)
    expect(VIEW).not.toMatch(/^\s*(?:const|let|var|import)\b[^\n]*require\(/m);
  });

  test('the projection seam takes the SUB, not a participant id', () => {
    expect(ROUTES).toMatch(/function project\(event, sub\)/);
    // Every fan-out write still goes through it, and now carries the recipient
    // itself: redaction cannot be decided from an id without a query, and a
    // query inside emit() is a query storm across every open stream.
    // The fan-out and the backlog replay both project, and both now honour a
    // NULL projection as do-not-send rather than writing `data: null`.
    expect(ROUTES).toMatch(/const payload = project\(ev, sub\);\s*\n\s*if \(payload == null\) continue;/);
    expect(ROUTES).toMatch(/writeFrame\(sub, payload\)/);
    // hello goes through it TOO, so there is one seam and not two.
    expect(ROUTES).toMatch(/writeFrame\(sub, project\(\{[\s\S]*?\}, sub\)\)/);
    expect(ROUTES).toMatch(/for \(const ev of backlog\) \{[\s\S]{0,160}project\(ev, sub\)/);
    // And the ONE write that bypasses project() — the current-position replay
    // on join — carries the same rule inline, because a bypass is exactly where
    // a seam rule stops applying.
    expect(ROUTES).toMatch(/if \(ctx\.role === 'host'\) \{\s*\n\s*for \(const \[otherPid, s\] of h\.cursors\)/);
  });

  test('the off-room filter runs on the HOST BEAT, before the replay ring', () => {
    // emit() pushes onto h.ring BEFORE any projection, so filtering a foreign
    // entity id at the seam would already have written it into shared room
    // memory for every ?after= reconnect to replay.
    const beat = ROUTES.slice(ROUTES.indexOf("router.post('/:roomId/beat/:streamKey'"));
    const check = beat.indexOf('LV.hostViewEvent');
    const emitView = beat.indexOf("emit(ctx.room.id, 'view'");
    expect(check).toBeGreaterThan(-1);
    expect(emitView).toBeGreaterThan(-1);
    expect(check).toBeLessThan(emitView);
    // And it is host-only.
    expect(beat.slice(0, check)).toMatch(/ctx\.role === 'host'/);
  });

  test('the read proxy names its param :streamKey, or the limiter falls back to the IP', () => {
    // rate-limit.js reads req.params.streamKey and silently keys on 'ip:'
    // otherwise — which would put every guest behind one NAT in one bucket.
    expect(ROUTES).toMatch(/router\.get\('\/:roomId\/view\/:streamKey\/:surface'/);
    const RL = read('server', 'rate-limit.js');
    expect(RL).toMatch(/liveViewLimiter/);
    expect(RL).toMatch(/req\.params && req\.params\.streamKey/);
  });

  test('scope is a column with a fail-closed reader, so phase 04 is a value', () => {
    expect(read('server', 'db.js')).toMatch(/scope\s+TEXT NOT NULL DEFAULT 'view'/);
    expect(read('server', 'services', 'live-rooms.js')).toMatch(/function normalizeScope/);
  });
});
