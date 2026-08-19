// Live Rooms phase 01 — the state machines, tested where they live.
//
// WHY THESE ARE PURE, AND WHY THE CLIENT'S HALF IS REQUIRED FROM js/
// Two of the three properties this feature has to get right are decisions, not
// plumbing: "is this person still here" and "what does the list say when I
// cannot tell". Both are reachable only through a request in the naive design,
// which in this repo means a file that only loads where JWT_SECRET is set. So
// they live in server/services/live-rooms.js and in the exported core of
// js/live-rooms.js, and this file requires BOTH.
//
// js/live-rooms.js is required directly rather than having its logic mirrored
// here. A copy of the honesty rule in the test file would pass forever while
// the shipped one rotted; requiring the real module means these assertions are
// about the code the browser runs.

const S = require('../server/services/live-rooms');
const C = require('../js/live-rooms.js');

describe('presence comes from the beacon, and only from the beacon', () => {
  const t0 = 1_700_000_000_000;

  test('a fresh beat is live', () => {
    expect(S.presenceOf(t0, t0 + 1000)).toBe('live');
    expect(S.presenceOf(t0, t0 + S.STALE_MS - 1)).toBe('live');
  });

  test('four missed beats is stale, not gone — the roster still shows them, labelled', () => {
    expect(S.presenceOf(t0, t0 + S.STALE_MS)).toBe('stale');
    expect(S.presenceOf(t0, t0 + S.GONE_MS - 1)).toBe('stale');
  });

  test('past the gone threshold they leave the roster entirely', () => {
    expect(S.presenceOf(t0, t0 + S.GONE_MS)).toBe('gone');
  });

  // The regression this guards: a 30s `gone` threshold sits BELOW Chrome's
  // ~1/min background-timer throttle, so a backgrounded tab is declared gone,
  // its stream closed, and it rejoins seconds later as a NEW participant row —
  // forever. An hour in another tab mints on the order of a hundred rows and
  // flickers the roster for someone who never left.
  test('gone sits above the background-timer throttle floor', () => {
    expect(S.GONE_MS).toBeGreaterThan(60000);
  });

  // The other half: one dropped POST must not publicly label a truck phone
  // "not responding", or the host learns to ignore the one honest state here.
  test('stale is several missed beats, not one', () => {
    expect(S.STALE_MS).toBeGreaterThanOrEqual(S.BEAT_MS * 3);
  });

  test('a missing or unparseable beacon is gone, never assumed present', () => {
    expect(S.presenceOf(null, t0)).toBe('gone');
    expect(S.presenceOf(undefined, t0)).toBe('gone');
    expect(S.presenceOf('nonsense', t0)).toBe('gone');
  });
});

describe('room lifecycle — six ways to stop, one way to start', () => {
  const now = 1_700_000_000_000;
  const live = { created_at: new Date(now - 1000), expires_at: new Date(now + 3600_000), last_host_beat_at: new Date(now - 1000) };

  test('a healthy room is live', () => {
    expect(S.roomLifecycle(live, now)).toBe('live');
  });

  test('revoked, ended and expired each report themselves distinctly', () => {
    expect(S.roomLifecycle({ ...live, revoked_at: new Date(now) }, now)).toBe('revoked');
    expect(S.roomLifecycle({ ...live, ended_at: new Date(now) }, now)).toBe('ended');
    expect(S.roomLifecycle({ ...live, expires_at: new Date(now - 1) }, now)).toBe('expired');
  });

  test('a silent host first marks the room ending, then ends it', () => {
    expect(S.roomLifecycle({ ...live, last_host_beat_at: new Date(now - S.HOST_ENDING_MS) }, now)).toBe('ending');
    expect(S.roomLifecycle({ ...live, last_host_beat_at: new Date(now - S.HOST_ENDED_MS) }, now)).toBe('ended');
  });

  // Ending must be as reliable as starting: a room that keeps broadcasting
  // after you think it stopped is the worst defect this feature can have.
  test('an absent room is ended, never assumed live', () => {
    expect(S.roomLifecycle(null, now)).toBe('ended');
    expect(S.roomLifecycle(undefined, now)).toBe('ended');
  });

  test('ending is still usable — a tunnel is not a termination', () => {
    expect(S.roomIsUsable('live')).toBe(true);
    expect(S.roomIsUsable('ending')).toBe(true);
    expect(S.roomIsUsable('ended')).toBe(false);
    expect(S.roomIsUsable('revoked')).toBe(false);
    expect(S.roomIsUsable('expired')).toBe(false);
  });
});

describe('the mint predicate is strict equality, and it names its refusals', () => {
  // THE FINDING THIS FILE EXISTS FOR. services/job-org-scope.js carries
  // `OR organization_id IS NULL`, so jobInOrg() proves "in your org OR
  // unstamped". Minting through it would let ANY tenant open a room over ANY
  // unstamped job, and then live_rooms.organization_id NOT NULL has nothing to
  // stamp from.
  test('an unstamped parent is REFUSED, not silently adopted into the caller org', () => {
    const v = S.mintVerdict(7, { id: 'j1', organization_id: null });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('ENTITY_UNSTAMPED');
    expect(v.status).toBe(409);
    // Fail closed AND do not lock anyone out: the refusal names the action an
    // admin can actually take.
    expect(v.error).toMatch(/administrator/i);
  });

  test("another tenant's job is indistinguishable from one that does not exist", () => {
    const foreign = S.mintVerdict(7, { id: 'j1', organization_id: 9 });
    const absent = S.mintVerdict(7, null);
    expect(foreign.status).toBe(404);
    expect(absent.status).toBe(404);
    expect(foreign.error).toBe(absent.error);
    expect(foreign.code).toBe(absent.code);
  });

  test('a caller with no resolvable tenant is refused, retryably and by name', () => {
    const v = S.mintVerdict(null, { id: 'j1', organization_id: 7 });
    expect(v.ok).toBe(false);
    expect(v.code).toBe('ORG_UNRESOLVED');
  });

  test('a matching tenant mints, and the org comes from the PARENT ROW', () => {
    const v = S.mintVerdict(7, { id: 'j1', organization_id: 7 });
    expect(v.ok).toBe(true);
    expect(v.orgId).toBe(7);
  });

  test('the org id is compared as a string, so 7 and "7" are one tenant', () => {
    expect(S.mintVerdict('7', { id: 'j1', organization_id: 7 }).ok).toBe(true);
  });
});

describe('the entity whitelist never lets a caller name a table', () => {
  test('job is registered; nothing else is', () => {
    expect(S.roomEntity('job')).toBeTruthy();
    expect(S.roomEntity('job').table).toBe('jobs');
    expect(S.roomEntity('lead')).toBeNull();
    expect(S.roomEntity('users')).toBeNull();
  });

  test('prototype keys do not resolve to a table', () => {
    // The whole point of hasOwnProperty here: 'constructor' and 'toString' are
    // keys JavaScript supplies for free, and an `in`-based lookup would hand
    // one of them back as a descriptor.
    expect(S.roomEntity('constructor')).toBeNull();
    expect(S.roomEntity('toString')).toBeNull();
    expect(S.roomEntity('__proto__')).toBeNull();
  });

  test('non-strings are refused rather than coerced', () => {
    expect(S.roomEntity(null)).toBeNull();
    expect(S.roomEntity(undefined)).toBeNull();
    expect(S.roomEntity({})).toBeNull();
  });
});

describe('credential shape gates run before the database is touched', () => {
  const good = 'a'.repeat(64);
  test('64 lowercase hex characters, and nothing else', () => {
    expect(S.isRoomToken(good)).toBe(true);
    expect(S.isStreamKey(good)).toBe(true);
    expect(S.isRoomToken('A'.repeat(64))).toBe(false);   // uppercase
    expect(S.isRoomToken('a'.repeat(63))).toBe(false);
    expect(S.isRoomToken('a'.repeat(65))).toBe(false);
    expect(S.isRoomToken("' OR 1=1 --")).toBe(false);
    expect(S.isRoomToken(null)).toBe(false);
    expect(S.isRoomToken(good + '\n')).toBe(false);
  });

  // The design gated the token and left the stream key ungated — and the
  // stream key is the credential that authenticates every request AFTER the
  // first one.
  test('the stream key is gated too, not just the room token', () => {
    expect(S.isStreamKey('nope')).toBe(false);
    expect(S.isStreamKey(undefined)).toBe(false);
  });
});

describe('cursor frames are normalised, clamped, and never trusted', () => {
  test('a well-formed batch round-trips', () => {
    expect(S.normalizeCursorSamples([[1, 100, 200], [2, 300, 400]]))
      .toEqual([[1, 100, 200], [2, 300, 400]]);
  });

  test('coordinates are clamped into the shared 0..10000 space', () => {
    expect(S.normalizeCursorSamples([[1, -50, 99999]])).toEqual([[1, 0, S.CURSOR_MAX]]);
  });

  test('junk is dropped, not coerced, and never throws', () => {
    expect(S.normalizeCursorSamples('nope')).toEqual([]);
    expect(S.normalizeCursorSamples(null)).toEqual([]);
    expect(S.normalizeCursorSamples([[1, 'x', 2], [1, 2], null, 5, {}])).toEqual([]);
    expect(S.normalizeCursorSamples([[NaN, 1, 2]])).toEqual([]);
  });

  // Infinity is DROPPED rather than clamped to the top of the range. Clamping
  // would silently turn a garbage frame into a plausible cursor parked in the
  // bottom-right corner, which is a wrong answer wearing a right answer's
  // clothes. A frame we cannot read is not worth guessing at.
  test('a non-finite coordinate drops the frame instead of becoming a corner', () => {
    expect(S.normalizeCursorSamples([[1, Infinity, 2]])).toEqual([]);
    expect(S.normalizeCursorSamples([[1, 2, -Infinity]])).toEqual([]);
  });

  test('a flood is capped rather than fanned out', () => {
    const flood = Array.from({ length: 5000 }, (_, i) => [i, 1, 1]);
    expect(S.normalizeCursorSamples(flood).length).toBe(S.MAX_SAMPLES);
  });
});

describe('a guest-supplied display name cannot break the surface it lands on', () => {
  // Control characters collapse to a SPACE, not to nothing. Deleting them
  // would let a zero-width character forge a name: "Ad<ZWSP>min" would
  // render as "Admin" and sit in the roster impersonating someone else.
  // Collapsing to a space makes the tampering visible instead of invisible.
  test('control characters and line breaks become spaces, not deletions', () => {
    expect(S.normalizeDisplayName('Da\u0000ve\nSmith')).toBe('Da ve Smith');
    expect(S.normalizeDisplayName('Ad\u200bmin')).toBe('Ad min');
    expect(S.normalizeDisplayName('one\r\n\ttwo')).toBe('one two');
  });
  test('it is length-capped', () => {
    expect(S.normalizeDisplayName('x'.repeat(500)).length).toBeLessThanOrEqual(40);
  });
  test('empty falls back rather than rendering a blank row', () => {
    expect(S.normalizeDisplayName('', 'Guest')).toBe('Guest');
    expect(S.normalizeDisplayName('   ', 'Guest')).toBe('Guest');
    expect(S.normalizeDisplayName(null, 'Teammate')).toBe('Teammate');
  });
});

describe('projections are allow-lists, so a row spread cannot leak a tenant', () => {
  const now = Date.now();

  test('a participant projection carries no organization id and no stream key', () => {
    const row = {
      id: 'p1', room_id: 'r1', organization_id: 42, user_id: 9,
      display_name: 'Dave', role: 'viewer', stream_key: 'a'.repeat(64),
      joined_at: new Date(now), last_seen_at: now, kicked_by: 3
    };
    const out = S.publicParticipant(row, now);
    const json = JSON.stringify(out);
    expect(json).not.toMatch(/organization_id/);
    expect(json).not.toMatch(/a{64}/);
    expect(json).not.toMatch(/kicked_by/);
    expect(json).not.toMatch(/room_id/);
    expect(out.name).toBe('Dave');
    expect(out.guest).toBe(false);
  });

  test('a room projection carries no token, no entity id and no host user id', () => {
    const room = {
      id: 'r1', organization_id: 42, token: 'b'.repeat(64),
      entity_type: 'job', entity_id: 'JOB-123', host_user_id: 9,
      scope: 'view', created_at: new Date(now), expires_at: new Date(now + 1000)
    };
    const json = JSON.stringify(S.publicRoom(room, 'RV2006 Waterside', now));
    expect(json).not.toMatch(/b{64}/);
    expect(json).not.toMatch(/JOB-123/);
    expect(json).not.toMatch(/organization_id/);
    expect(json).not.toMatch(/host_user_id/);
    // The forward-facing name, never a raw id.
    expect(json).toMatch(/RV2006 Waterside/);
  });

  test('a user_id from another tenant is never what makes someone a non-guest', () => {
    expect(S.publicParticipant({ id: 'p', user_id: null, display_name: 'X', role: 'viewer' }, now).guest).toBe(true);
  });
});

describe('scope reads fail closed so phase 04 cannot widen an old build', () => {
  test('anything unrecognised narrows to view', () => {
    expect(S.normalizeScope('view')).toBe('view');
    expect(S.normalizeScope('draw')).toBe('view');
    expect(S.normalizeScope('admin')).toBe('view');
    expect(S.normalizeScope(null)).toBe('view');
    expect(S.normalizeScope(undefined)).toBe('view');
  });
});

// ══ THE CLIENT'S HALF ═════════════════════════════════════════════════════
// "Decide what a participant list shows when the stream is broken, BEFORE you
// build it." This is that decision, executable.

describe('the participant list never asserts a stale truth', () => {
  test('a fresh snapshot on a healthy stream is asserted plainly', () => {
    const st = C.rosterState({ attempts: 0, msSinceSnapshot: 2000 });
    expect(st.kind).toBe('asserted');
    expect(st.showRoster).toBe(true);
    expect(st.dim).toBe(false);
    expect(st.message).toBe('');
  });

  test('one reconnect attempt caveats the list — it does not hide it', () => {
    const st = C.rosterState({ attempts: 1, msSinceSnapshot: 2000 });
    expect(st.kind).toBe('caveated');
    expect(st.showRoster).toBe(true);
    expect(st.dim).toBe(true);
    expect(st.message).toMatch(/may be out of date/i);
  });

  // THE CORE PROPERTY. Not "dim the stale roster" — EMPTY it. A face that
  // cannot currently be verified must not be on screen, because the entire
  // safety story of a forwardable link is "anyone holding it shows up here".
  test('after three attempts the roster is EMPTIED and says it does not know', () => {
    const st = C.rosterState({ attempts: C.ATTEMPTS_BEFORE_UNKNOWN, msSinceSnapshot: 2000 });
    expect(st.kind).toBe('unknown');
    expect(st.showRoster).toBe(false);
    expect(st.message).toMatch(/can't tell who's watching/i);
    expect(C.visibleParticipants([{ id: 'p1', name: 'Dave', presence: 'live' }], st)).toEqual([]);
  });

  test('a long silence empties it too, even with no failed attempt recorded', () => {
    const st = C.rosterState({ attempts: 0, msSinceSnapshot: C.ROSTER_UNKNOWN_MS });
    expect(st.kind).toBe('unknown');
    expect(st.showRoster).toBe(false);
  });

  test('never having had a snapshot is unknown, not an empty asserted list', () => {
    const st = C.rosterState({ attempts: 0, msSinceSnapshot: null });
    expect(st.kind).toBe('unknown');
  });

  test('a terminal session shows no roster and names its reason', () => {
    const st = C.rosterState({ terminal: true, terminalReason: 'host_ended' });
    expect(st.kind).toBe('ended');
    expect(st.showRoster).toBe(false);
    expect(st.message).toMatch(/You ended this session/);
  });

  test('gone participants are filtered even from an asserted roster', () => {
    const st = C.rosterState({ attempts: 0, msSinceSnapshot: 1000 });
    const out = C.visibleParticipants([
      { id: 'a', presence: 'live' }, { id: 'b', presence: 'stale' }, { id: 'c', presence: 'gone' }
    ], st);
    expect(out.map((p) => p.id)).toEqual(['a', 'b']);
  });
});

describe('cursors obey the same honesty rule as the roster, one layer down', () => {
  const asserted = C.rosterState({ attempts: 0, msSinceSnapshot: 1000 });
  const caveated = C.rosterState({ attempts: 1, msSinceSnapshot: 1000 });
  const unknown = C.rosterState({ attempts: 5, msSinceSnapshot: 90000 });

  test('a live participant on an asserted stream draws', () => {
    expect(C.cursorVisible({ presence: 'live' }, asserted)).toBe(true);
  });

  // The defect this closes: a frozen named cursor still painted beside a list
  // reading "we can't tell who's watching".
  test('nothing draws while the stream is merely reconnecting', () => {
    expect(C.cursorVisible({ presence: 'live' }, caveated)).toBe(false);
    expect(C.cursorVisible({ presence: 'live' }, unknown)).toBe(false);
  });

  test('a stale participant does not keep a cursor on screen', () => {
    expect(C.cursorVisible({ presence: 'stale' }, asserted)).toBe(false);
    expect(C.cursorVisible({ presence: 'gone' }, asserted)).toBe(false);
  });

  test('an unknown participant never draws', () => {
    expect(C.cursorVisible(undefined, asserted)).toBe(false);
    expect(C.cursorVisible(null, asserted)).toBe(false);
  });
});

describe("the host can always tell whether they are broadcasting", () => {
  test('a recently confirmed session says LIVE and counts the watchers', () => {
    const v = C.hostStripState({ hosting: true, msSinceConfirm: 1000, watching: 3 });
    expect(v.kind).toBe('live');
    expect(v.detail).toBe('3 watching');
  });

  // The state a pretty pill is tempted to hide, and the reason this surface
  // is built honestly at all.
  test('an unconfirmed session says so, and says ending is not instant', () => {
    const v = C.hostStripState({ hosting: true, msSinceConfirm: C.CONFIRM_MS + 1 });
    expect(v.kind).toBe('unconfirmed');
    expect(v.label).toBe('LIVE?');
    expect(v.detail).toMatch(/may still be broadcasting/i);
  });

  test('never having heard from the server is unconfirmed, not live', () => {
    expect(C.hostStripState({ hosting: true, msSinceConfirm: null }).kind).toBe('unconfirmed');
  });

  test('a terminated session is sticky and names which of the six ways it ended', () => {
    expect(C.hostStripState({ hosting: true, terminal: true, terminalReason: 'expired' }).detail)
      .toMatch(/time limit/i);
    expect(C.hostStripState({ hosting: true, terminal: true, terminalReason: 'host_timeout' }).detail)
      .toMatch(/stopped responding/i);
    expect(C.hostStripState({ hosting: true, terminal: true, terminalReason: 'link_revoked' }).detail)
      .toMatch(/revoked/i);
  });

  test('every end reason has real copy — none falls through to a bare default', () => {
    for (const r of ['host_ended', 'host_left', 'host_timeout', 'expired',
                     'link_revoked', 'superseded', 'kicked', 'server_restart']) {
      expect(C.endReasonText(r)).not.toBe(C.endReasonText('__unmapped__'));
    }
  });
});

describe('one coordinate unit, stated once', () => {
  test('x and y are both normalised into the same 0..10000 range', () => {
    expect(C.toDocCoords(0, 0, 1000, 20000)).toEqual([0, 0]);
    expect(C.toDocCoords(1000, 20000, 1000, 20000)).toEqual([C.COORD_MAX, C.COORD_MAX]);
    expect(C.toDocCoords(500, 10000, 1000, 20000)).toEqual([5000, 5000]);
  });

  // The mixed-unit bug this rules out: "0..10000 for x, CSS px of scroll
  // position for y" breaks silently on any page taller than 10000px.
  test('a very tall document still normalises y into range', () => {
    const c = C.toDocCoords(10, 45000, 1200, 50000);
    expect(c[1]).toBeLessThanOrEqual(C.COORD_MAX);
    expect(c[1]).toBeGreaterThan(0);
  });

  test('out-of-range input is clamped, not wrapped', () => {
    expect(C.toDocCoords(-500, 99999, 1000, 1000)).toEqual([0, C.COORD_MAX]);
  });

  test('a zero-sized surface yields nothing rather than NaN', () => {
    expect(C.toDocCoords(10, 10, 0, 0)).toBeNull();
  });

  test('the round trip lands back where it started', () => {
    const c = C.toDocCoords(300, 6000, 1200, 24000);
    const back = C.fromDocCoords(c[0], c[1], 1200, 24000);
    expect(Math.round(back.left)).toBe(300);
    expect(Math.round(back.top)).toBe(6000);
  });

  test('the client and the server agree on the range', () => {
    expect(C.COORD_MAX).toBe(S.CURSOR_MAX);
  });
});

describe('reconnect backs off and is jittered', () => {
  test('it grows and then caps', () => {
    expect(C.backoffMs(1, 0.5)).toBe(1000);
    expect(C.backoffMs(2, 0.5)).toBe(2000);
    expect(C.backoffMs(99, 0.5)).toBe(15000);
  });

  test('jitter spreads a room that all lost the same proxy at once', () => {
    expect(C.backoffMs(3, 0)).not.toBe(C.backoffMs(3, 1));
  });
});
