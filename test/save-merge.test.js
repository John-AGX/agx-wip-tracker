// js/save-merge.js — the two decisions the save path is allowed to make, and
// every sentence it is allowed to say.
//
// These are pure-function tests on purpose. The two things they pin are the
// two things that cannot be checked by looking at a running app:
//   1. The hold DECISION, across every combination of state that can reach it
//      — including the ones the first draft of this design deadlocked on.
//   2. The banner COPY, which makes factual claims about where the user's bytes
//      are. A sentence that is false in a state it can be raised from is the
//      same class of defect as a silent drop; the only way to keep it true is
//      to be able to test it.

const M = require('../js/save-merge.js');

describe('shouldVetoHydrate — when a hydrate may not run', () => {
  test('a clean client never holds', () => {
    expect(M.shouldVetoHydrate({ dirtyJobIds: [], dirtyEstimateIds: [] }))
      .toMatchObject({ veto: false, reason: 'clean' });
  });

  test('holds for a dirty job', () => {
    expect(M.shouldVetoHydrate({ dirtyJobIds: ['j1'], dirtyEstimateIds: [] }))
      .toMatchObject({ veto: true, reason: 'unpushed-changes', jobs: ['j1'] });
  });

  test('holds for a dirty estimate too — both stores ride appData+saveData', () => {
    expect(M.shouldVetoHydrate({ dirtyJobIds: [], dirtyEstimateIds: ['e1'] }))
      .toMatchObject({ veto: true, estimates: ['e1'] });
  });

  test('a conflict reload is NEVER held', () => {
    // The row was refused by the server at this base. Holding to push it again
    // re-conflicts and re-holds, forever. The server's version has to land, and
    // handleSaveConflicts' before/after comparison is what reports the loss.
    expect(M.shouldVetoHydrate({ dirtyJobIds: ['j1'], fromConflict: true }))
      .toMatchObject({ veto: false, reason: 'conflict-reload' });
  });

  test('escalation changes the copy but never the decision', () => {
    // A bound that eventually lets the hydrate through would be a bound on how
    // long we are willing to refuse to destroy the edit. There isn't one.
    for (const n of [0, 3, 50, 5000]) {
      const r = M.shouldVetoHydrate({ dirtyJobIds: ['j1'], consecutiveVetoes: n });
      expect(r.veto).toBe(true);
    }
    expect(M.shouldVetoHydrate({ dirtyJobIds: ['j1'], consecutiveVetoes: 0 }).escalate).toBe(false);
    expect(M.shouldVetoHydrate({ dirtyJobIds: ['j1'], consecutiveVetoes: M.VETO_ESCALATE_AFTER }).escalate).toBe(true);
  });

  test('missing/garbage state degrades to "do not hold" rather than throwing', () => {
    // This runs inside loadData's .then. A throw here lands in the catch,
    // which reports a load failure that did not happen.
    expect(M.shouldVetoHydrate().veto).toBe(false);
    expect(M.shouldVetoHydrate({}).veto).toBe(false);
  });
});

describe('describeSaveState — every sentence is true in the state that raises it', () => {
  const state = (over) => Object.assign({ jobs: [], estimates: [], heldMs: 0 }, over);

  test('nothing unsaved, no failure => no banner at all', () => {
    expect(M.describeSaveState(state()).level).toBe('none');
    expect(M.describeSaveState(state({ reason: null, jobs: [] })).level).toBe('none');
  });

  test('a routine in-flight hydrate is silent for the first few seconds', () => {
    // Every p86Refresh sets the in-flight flag for a few hundred ms. A red
    // "not saving" banner during a normal agent write — healthy server, edit
    // about to be pushed — would be false several times a day.
    const s = state({ reason: 'hydrate-in-flight', jobs: ['Fairways'], heldMs: 300 });
    expect(M.describeSaveState(s).level).toBe('none');
    expect(M.describeSaveState({ ...s, heldMs: M.HYDRATE_QUIET_MS + 1 }).level).toBe('warn');
  });

  test('the offline banner counts entities and names the attempt', () => {
    const v = M.describeSaveState(state({
      reason: 'no-good-load', jobs: ['Fairways', 'Oak Bridge'], retryAttempt: 3
    }));
    expect(v.level).toBe('error');
    expect(v.detail).toContain('2 changes');
    expect(v.detail).toContain('attempt 3');
    expect(v.count).toBe(2);
  });

  test('one change is singular', () => {
    const v = M.describeSaveState(state({ reason: 'no-good-load', jobs: ['Fairways'] }));
    expect(v.detail).toContain('1 change ');
    expect(v.detail).not.toContain('1 changes');
  });

  test('after two minutes down it stops promising an imminent reconnect', () => {
    const long = M.describeSaveState(state({
      reason: 'no-good-load', jobs: ['Fairways'], heldMs: M.STILL_DOWN_MS
    }));
    expect(long.title).toMatch(/Still can't reach the server/);
    expect(long.detail).not.toMatch(/Reconnecting/);
    expect(long.detail).toMatch(/do not close this tab/);
  });

  test('NO state ever offers "Save them"', () => {
    // In the state where it reads most naturally — reconnected, changes still
    // local — the only way to honour it is to bypass the pushToServer guard,
    // i.e. perform the documented clobber with the version check off. A button
    // that cannot do what it says is the defect this file exists against.
    const reasons = [null, 'no-good-load', 'push-failed', 'unpushed-changes',
                     'hydrate-in-flight', 'partial', 'nonsense'];
    for (const reason of reasons) {
      for (const heldMs of [0, 5000, 200000]) {
        for (const quotaFailed of [false, true]) {
          const v = M.describeSaveState(state({ reason, heldMs, quotaFailed, jobs: ['A'] }));
          expect(v.actions).not.toContain('save-them');
          expect(v.actions).not.toContain('discard');
          expect(String(v.title) + String(v.detail)).not.toMatch(/Save them|Discard/i);
        }
      }
    }
  });

  test('an action is only offered where it can actually do something', () => {
    // "Try now" probes the server, so it belongs to the states where the server
    // is the problem. "Retry now" flushes a push, which is a no-op unless a
    // push is possible — so it must NOT be the offer while the server is down.
    const down = M.describeSaveState(state({ reason: 'no-good-load', jobs: ['A'] }));
    expect(down.actions).toContain('try-now');
    expect(down.actions).not.toContain('retry-now');

    const pushFailed = M.describeSaveState(state({ reason: 'push-failed', jobs: ['A'] }));
    expect(pushFailed.actions).toContain('retry-now');
  });

  test('"Show what\'s unsaved" is offered only when there IS something to show', () => {
    expect(M.describeSaveState(state({ reason: 'no-good-load', jobs: [] })).actions)
      .not.toContain('show-unsaved');
    expect(M.describeSaveState(state({ reason: 'no-good-load', jobs: ['A'] })).actions)
      .toContain('show-unsaved');
  });

  test('the quota state outranks everything — it is the only one where the cache is gone too', () => {
    const v = M.describeSaveState(state({ reason: 'hydrate-in-flight', quotaFailed: true, jobs: ['A'] }));
    expect(v.level).toBe('error');
    expect(v.title).toMatch(/Out of browser storage/);
  });

  test('the held-hydrate state does not claim anything was lost', () => {
    const v = M.describeSaveState(state({ reason: 'unpushed-changes', jobs: ['Fairways'] }));
    expect(v.level).toBe('warn');
    expect(v.detail).toMatch(/paused on your copy/);
    expect(String(v.title) + String(v.detail)).not.toMatch(/lost|failed|error/i);
  });

  test('the partial-conflict state does not read as success', () => {
    const v = M.describeSaveState(state({ reason: 'partial', jobs: ['Fairways'] }));
    expect(v.level).not.toBe('none');
    expect(v.title).toMatch(/rejected/);
  });

  test('an unknown reason paints nothing rather than guessing', () => {
    expect(M.describeSaveState(state({ reason: 'something-new', jobs: ['A'] })).level).toBe('none');
  });
});
