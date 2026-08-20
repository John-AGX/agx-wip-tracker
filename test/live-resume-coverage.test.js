// Resume has to PROVE coverage, on both sides of the wire.
//
// The bug, which has been in shipped phase-01/02 code since the ring landed:
//
//   server  if (after >= lowest - 1) { resumed = true; backlog = … }
//           only ever looked DOWNWARD. It never asked whether this hub had
//           emitted that many events at all.
//   client  lastSeq only ever RISES (a lower-seq frame is ignored) and is
//           reset in exactly one place, _join().
//
// Hubs restart at seq 0 constantly — destroyHub() deletes the object, a
// takeover makes a new one, and every deploy is a new process. So a plain
// reconnect after a takeover sends a stale-high `after`, sails past
// `lowest - 1`, and is told resumed:true with a backlog that filters to
// EMPTY. The client keeps its stale state because it was told it resumed,
// and receives nothing to replace it.
//
// It has never been visible because the 15s full presence snapshot repairs
// the roster. Cursors have no such snapshot, and neither would anything else
// added to this lane later.
//
// Both halves are asserted here because either alone leaves a hole: the
// server can be right and a client that ignores it still paints stale state,
// and a client cannot detect a hub that restarted ABOVE its position.

'use strict';

const S = require('../server/services/live-rooms');
const C = require('../js/live-rooms.js');

const ring = (from, to) => {
  const out = [];
  for (let s = from; s <= to; s++) out.push({ seq: s, type: 'presence' });
  return out;
};

describe('server — a resume is only claimed when the ring can prove it', () => {

  test('a genuine resume replays exactly what was missed', () => {
    const d = S.resumeDecision(57, ring(40, 60), 60);
    expect(d.resumed).toBe(true);
    expect(d.backlog.map((e) => e.seq)).toEqual([58, 59, 60]);
    expect(d.reason).toBeNull();
  });

  test('a resume with genuinely nothing missed is still a resume', () => {
    // Empty backlog is NOT the bug signal — "you are up to date" is a real
    // answer and must stay distinguishable from "I cannot cover you".
    const d = S.resumeDecision(60, ring(40, 60), 60);
    expect(d.resumed).toBe(true);
    expect(d.backlog).toEqual([]);
    expect(d.reason).toBeNull();
  });

  test('a client ahead of the hub is a RESET, and says why', () => {
    // The takeover case. Client saw seq 57 on the old hub; this hub has
    // emitted 3 events, and its ring starts at 1 — so `after >= lowest - 1`
    // passes and the old rule replied resumed:true with an empty backlog.
    const d = S.resumeDecision(57, ring(1, 3), 3);
    expect(d.resumed).toBe(false);
    expect(d.reason).toBe('hub_restarted');
    expect(d.backlog).toEqual([]);
  });

  test('the exact shape of the old bug: same input, two different answers', () => {
    const after = 57, r = ring(1, 3), hubSeq = 3;
    const legacy = (after >= r[0].seq - 1);          // the shipped condition
    expect(legacy).toBe(true);                       // it said "resumed"
    expect(r.filter((e) => e.seq > after)).toEqual([]);   // …and sent nothing
    expect(S.resumeDecision(after, r, hubSeq).resumed).toBe(false);
  });

  test('a gap the ring has already evicted is a reset', () => {
    const d = S.resumeDecision(5, ring(40, 60), 60);
    expect(d.resumed).toBe(false);
    expect(d.reason).toBe('gap');
  });

  test('an empty ring cannot cover anyone', () => {
    expect(S.resumeDecision(7, [], 7)).toMatchObject({ resumed: false, reason: 'no_ring' });
  });

  test('a first connection is not a failed resume', () => {
    expect(S.resumeDecision(0, ring(1, 3), 3).reason).toBe('fresh');
    expect(S.resumeDecision(NaN, ring(1, 3), 3).reason).toBe('fresh');
    expect(S.resumeDecision(-1, ring(1, 3), 3).reason).toBe('fresh');
  });

  test('a boundary resume — exactly one below the oldest retained — still covers', () => {
    const d = S.resumeDecision(39, ring(40, 60), 60);
    expect(d.resumed).toBe(true);
    expect(d.backlog).toHaveLength(21);
  });
});

describe('client — a hello from a restarted hub is a reset whatever the flag says', () => {

  test('a hello below our position is a reset even when it claims resumed', () => {
    expect(C.resumeVerdict(3, 57, true)).toBe('reset');
  });

  test('a normal resume is honoured', () => {
    expect(C.resumeVerdict(60, 57, true)).toBe('resumed');
    expect(C.resumeVerdict(57, 57, true)).toBe('resumed');
  });

  test('resumed:false is always a reset', () => {
    expect(C.resumeVerdict(60, 57, false)).toBe('reset');
    expect(C.resumeVerdict(0, 0, false)).toBe('reset');
  });

  test('a first hello (no prior position) is a reset, not a resume', () => {
    expect(C.resumeVerdict(0, 0, false)).toBe('reset');
    expect(C.resumeVerdict(12, undefined, false)).toBe('reset');
  });

  test('a hello with no seq falls back to the server flag', () => {
    expect(C.resumeVerdict(undefined, 57, true)).toBe('resumed');
    expect(C.resumeVerdict(null, 57, false)).toBe('reset');
  });

  test('the client does not depend on the server having been fixed', () => {
    // Belt and braces, deliberately. A server that still answers resumed:true
    // after a takeover cannot make this client keep stale cursors.
    expect(C.resumeVerdict(1, 999, true)).toBe('reset');
  });
});
