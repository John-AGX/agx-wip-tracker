// The sheet editor's autosave says what is actually true.
//
// Two silent-loss paths on the single-user drawing surface, both in the
// settled-save handling:
//
//   1. `S._dirty = false; setHint('Saved.')` ran SYNCHRONOUSLY, before the
//      PATCH left the browser. The user was told the drawing was safe at the
//      moment the request was being refused — and anything drawn during the
//      round trip was folded into a "saved" state the server never received.
//
//   2. The rejection handler re-marked dirty and stopped. Nothing re-armed
//      the autosave timer, so nothing retried until the user's next mutation.
//      close() then fired one more doomed save fire-and-forget and set
//      S = null on the next line, which discarded the payload and left the
//      promise handlers looking at a dead session. A dropped connection ate
//      the session with a "Saved." on screen.
//
// saveOutcome() is the whole decision, extracted pure so it can be driven
// here without a browser. The loop below is the same shape saveSilent() uses.

'use strict';

const H = require('./helpers/sheet-doc-harness');

const { saveOutcome, AUTOSAVE_MS } = H.SE._save;

// Mirror of saveSilent()'s use of the decision table, with a fake clock.
function makeEditor(transport) {
  const ed = {
    gen: 0, dirty: false, fails: 0, inFlight: false, timer: null,
    hint: '', hints: [], saves: [], doc: { entities: [] }
  };
  const setHint = (h) => { ed.hint = h; ed.hints.push(h); };
  const arm = (ms) => { ed.timer = ms; };

  ed.draw = function (id) {                    // one user mutation
    ed.doc.entities.push({ id });
    ed.dirty = true; ed.gen++; arm(AUTOSAVE_MS);
  };
  ed.tick = function () {                      // the autosave timer fires
    if (!ed.dirty || ed.inFlight) return null;
    ed.timer = null; ed.inFlight = true;
    const flightGen = ed.gen;
    const payload = JSON.parse(JSON.stringify(ed.doc));
    setHint('Saving…');
    return function settle() {
      const ok = transport(payload);
      if (ok) ed.saves.push(payload);
      const r = saveOutcome(ok, { gen: ed.gen, flightGen, fails: ed.fails });
      ed.inFlight = false; ed.dirty = r.dirty; ed.fails = r.fails;
      setHint(r.hint);
      if (r.rearmMs != null) arm(r.rearmMs);
      return r;
    };
  };
  return ed;
}

describe('autosave — the single-user happy path is unchanged', () => {

  test('idle debounce is still 2.5s', () => {
    expect(AUTOSAVE_MS).toBe(2500);
  });

  test('draw, idle, save: dirty clears, "Saved.", nothing rescheduled', () => {
    const ed = makeEditor(() => true);
    ed.draw('E1');
    expect(ed.timer).toBe(2500);
    expect(ed.dirty).toBe(true);
    const settle = ed.tick();
    expect(ed.hint).toBe('Saving…');
    const r = settle();
    expect(r).toEqual({ dirty: false, fails: 0, hint: 'Saved.', rearmMs: null });
    expect(ed.dirty).toBe(false);
    expect(ed.hint).toBe('Saved.');
    expect(ed.timer).toBeNull();
    expect(ed.saves).toHaveLength(1);
    expect(ed.saves[0].entities.map((e) => e.id)).toEqual(['E1']);
  });

  test('a whole quiet session is exactly one save per idle period', () => {
    const ed = makeEditor(() => true);
    for (let i = 0; i < 5; i++) { ed.draw('E' + i); ed.tick()(); }
    expect(ed.saves).toHaveLength(5);
    expect(ed.hints.filter((h) => h === 'Saved.')).toHaveLength(5);
    expect(ed.hints.some((h) => /Not saved/.test(h))).toBe(false);
  });
});

describe('autosave — it does not claim a save it has not got', () => {

  test('"Saved." is never reported while the request is still in flight', () => {
    const ed = makeEditor(() => true);
    ed.draw('E1');
    const settle = ed.tick();
    expect(ed.hint).toBe('Saving…');       // not "Saved."
    expect(ed.dirty).toBe(true);           // still unsaved, and still says so
    settle();
    expect(ed.hint).toBe('Saved.');
  });

  test('a stroke drawn DURING the round trip is not folded into "Saved."', () => {
    const ed = makeEditor(() => true);
    ed.draw('E1');
    const settle = ed.tick();
    ed.draw('E2');                          // lands while the PATCH is in flight
    const r = settle();
    expect(r.dirty).toBe(true);             // the document is still ahead of the server
    expect(r.hint).toBe('Saved — newer edits still pending…');
    expect(r.rearmMs).toBe(400);            // and a save for E2 is scheduled
    expect(ed.saves[0].entities.map((e) => e.id)).toEqual(['E1']);
    ed.tick()();
    expect(ed.dirty).toBe(false);
    expect(ed.saves[1].entities.map((e) => e.id)).toEqual(['E1', 'E2']);
  });
});

describe('autosave — a failure retries, and is visible', () => {

  test('a failed save keeps the document dirty and schedules a retry', () => {
    const ed = makeEditor(() => false);
    ed.draw('E1');
    const r = ed.tick()();
    expect(r.dirty).toBe(true);
    expect(r.hint).toBe('Not saved — retrying…');
    expect(r.rearmMs).toBe(1200);           // the re-arm that used to be missing
    expect(ed.timer).toBe(1200);
    expect(ed.saves).toHaveLength(0);
  });

  test('backoff grows and is capped, and the message escalates honestly', () => {
    const seen = [];
    let fails = 0;
    for (let i = 0; i < 8; i++) {
      const r = saveOutcome(false, { gen: 1, flightGen: 1, fails });
      fails = r.fails;
      seen.push([r.rearmMs, r.hint]);
    }
    expect(seen.map((s) => s[0])).toEqual([1200, 2400, 4800, 9600, 19200, 30000, 30000, 30000]);
    expect(seen[0][1]).toBe('Not saved — retrying…');
    expect(seen[1][1]).toBe('Not saved — retrying (attempt 2)…');
    expect(seen[3][1]).toMatch(/^NOT SAVED after 4 attempts/);
    // and it never tells the user the work is gone — it is still in the tab
    expect(seen[7][1]).toMatch(/keep this tab open/i);
  });

  test('an outage that recovers loses nothing and clears cleanly', () => {
    let up = false;
    const ed = makeEditor(() => up);
    ed.draw('E1'); ed.draw('E2');
    ed.tick()();                             // fail 1
    ed.tick()();                             // fail 2
    expect(ed.fails).toBe(2);
    expect(ed.dirty).toBe(true);
    ed.draw('E3');                           // user keeps drawing through the outage
    up = true;
    const r = ed.tick()();
    expect(r).toEqual({ dirty: false, fails: 0, hint: 'Saved.', rearmMs: null });
    expect(ed.saves).toHaveLength(1);
    expect(ed.saves[0].entities.map((e) => e.id)).toEqual(['E1', 'E2', 'E3']);
    expect(ed.timer).toBeNull();
  });

  test('the failure sequence never once says "Saved."', () => {
    const ed = makeEditor(() => false);
    ed.draw('E1');
    for (let i = 0; i < 4; i++) ed.tick()();
    expect(ed.hints.filter((h) => h === 'Saved.')).toHaveLength(0);
    expect(ed.dirty).toBe(true);
  });
});

describe('autosave — the old behaviour, pinned so it cannot come back', () => {

  test('clearing dirty on a gen mismatch is exactly the dropped-stroke bug', () => {
    // gen !== flightGen means the user drew while the save was in flight.
    // Reporting {dirty:false} here is what silently dropped that stroke.
    const r = saveOutcome(true, { gen: 9, flightGen: 7, fails: 0 });
    expect(r.dirty).toBe(true);
    expect(r.rearmMs).not.toBeNull();
  });

  test('a rejection always reschedules — the missing re-arm was the whole bug', () => {
    for (let fails = 0; fails < 10; fails++) {
      const r = saveOutcome(false, { gen: 1, flightGen: 1, fails });
      expect(r.rearmMs).toBeGreaterThan(0);
      expect(r.dirty).toBe(true);
    }
  });
});
