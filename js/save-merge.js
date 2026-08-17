/* ──────────────────────────────────────────────────────────────────────────
 * js/save-merge.js — the pure half of the job/estimate save path.
 *
 * WHY THIS FILE EXISTS AT ALL
 * js/app.js is one ~4000-line IIFE with no exports, so every decision the
 * persistence layer makes has historically been untestable — which is how
 * "the app renders a job it did not create" survived. Everything here is a
 * PURE FUNCTION of explicit arguments: no `window`, no DOM, no `appData`, no
 * network. app.js supplies the state and obeys the answer; test/ supplies the
 * state and asserts the answer.
 *
 * THE DEFECT THIS PATH ADDRESSES
 * appData+saveData (jobs + estimates ONLY — everything else is direct REST)
 * pushes on a 600ms debounce, gated on `_serverLoadOk && !_serverLoadInFlight`.
 * When that gate was shut the push was not queued, not retried, and not
 * announced; then the next hydrate replaced memory AND overwrote the
 * localStorage cache that was the edit's only remaining copy. A 502 during a
 * Railway deploy latched the gate shut for the whole session.
 *
 * THE RULE THIS FILE ENCODES
 *   A hydrate may not run while this client holds a change it has not pushed.
 *   Push first. If the push cannot happen, hold the hydrate and say so.
 * Holding a hydrate costs a stale screen. Running it costs the edit. The
 * deadlock the reviewers found in the first draft of this rule came from
 * ALSO skipping `_serverLoadOk = true` inside the held block — so the session
 * could never become pushable again and the only exit was "Discard". app.js
 * therefore sets `_serverLoadOk` on ANY GET that resolved, BEFORE consulting
 * shouldVetoHydrate(), and the held branch pushes directly instead of
 * re-firing a refresh (p86Refresh('job') resolves to loadData — that is a
 * loop, not a handoff).
 * ────────────────────────────────────────────────────────────────────────── */
(function (root, factory) {
  var api = factory();
  /* eslint-disable no-undef */
  if (typeof module === 'object' && module && module.exports) module.exports = api;
  if (root) root.p86SaveMerge = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  /* ── shouldVetoHydrate ───────────────────────────────────────────────────
   * Called by app.js AFTER the GET resolved and AFTER `_serverLoadOk = true`.
   *
   * Keyed on the DIRTY SET, not on a counter of blocked saveData() calls.
   * That distinction is the whole safety argument:
   *   - saveData() is called on VIEW as well as on edit (prepJobForView and
   *     renderJobDetail write derived pctComplete/recalcSubCosts; app.js's own
   *     migrateBudgetFields fires during the boot window with no auth guard).
   *     A counter incremented at the guard would be pinned high by merely
   *     opening a job, and would then freeze a healthy app on stale cache
   *     forever. A dirty SET recomputed at hydrate time is immune: a derived
   *     recompute that lands on the same values is not dirty.
   *   - It self-clears. A successful push advances the baselines, the set
   *     empties, and the next hydrate proceeds with no bookkeeping to reset.
   *   - It has real content, so "Show what's unsaved" can name rows.
   *
   * fromConflict is the one hard override. A row the SERVER rejected cannot be
   * saved by holding the hydrate — the server has already refused this base.
   * Holding it would re-push, re-conflict, and re-hold. The conflict reload
   * must land; app.js's handleSaveConflicts then compares before/after and
   * says out loud whether anything was really lost. */
  var VETO_ESCALATE_AFTER = 3;
  function shouldVetoHydrate(state) {
    state = state || {};
    var jobs = state.dirtyJobIds || [];
    var ests = state.dirtyEstimateIds || [];
    if (state.fromConflict) {
      return { veto: false, reason: 'conflict-reload', escalate: false, jobs: jobs, estimates: ests };
    }
    if (!jobs.length && !ests.length) {
      return { veto: false, reason: 'clean', escalate: false, jobs: [], estimates: [] };
    }
    return {
      veto: true,
      reason: 'unpushed-changes',
      // Escalation changes the BANNER COPY, never the timer and never the
      // decision. A bound that eventually lets the hydrate through would be a
      // bound on how long we refuse to destroy the edit.
      escalate: (state.consecutiveVetoes || 0) >= VETO_ESCALATE_AFTER,
      jobs: jobs,
      estimates: ests
    };
  }

  /* ── describeSaveState ───────────────────────────────────────────────────
   * THE banner copy, in one pure function, so every string can be tested
   * against the state that raises it.
   *
   * The standard this is written to: silence is the defect, and so is a
   * sentence that is false in a state it can be reached from. Two rules fall
   * straight out of that and both cost real functionality on purpose:
   *
   *   - NO "Save them" ACTION, EVER. In the state where it is most tempting
   *     (reconnected, changes still local) the only way to honour it would be
   *     to bypass the pushToServer guard, which is a full bulk replace from a
   *     possibly-stale cache with the version check disabled. A button that
   *     cannot do what it says is the same defect as a silent drop.
   *   - NO "Discard". It burns a job number permanently (saveJob claims the
   *     number atomically before the object exists) and it is never NEEDED,
   *     because the hydrate is held rather than run.
   *
   * `heldMs` is why 'hydrate-in-flight' does not paint immediately: every
   * p86Refresh sets the in-flight flag for a few hundred milliseconds, and a
   * red "not saving" banner during a routine agent write — on a healthy
   * server, for an edit that is about to be pushed — would be false several
   * times a day. Counts are ENTITY counts taken from the dirty id arrays, not
   * a count of blocked calls: one job edit fires many saveData()s. */
  var HYDRATE_QUIET_MS = 4000;
  var STILL_DOWN_MS = 120000;

  function describeSaveState(s) {
    s = s || {};
    var jobs = s.jobs || [], ests = s.estimates || [];
    var n = jobs.length + ests.length;
    var held = s.heldMs || 0;
    var show = n ? ['show-unsaved'] : [];

    /* ── nothing unsaved ⇒ nothing to say, in EVERY state ──────────────────
     * This function used to be reachable at n === 0 and it produced
     * sentences with a zero in them:
     *   "Not saving to the server — 0 changes on this device only."
     *   "Couldn't save 0 changes"
     * The first fired on every Railway swap with the app open and nothing
     * unsaved — the common case, roughly twenty pushes in a day — as a RED
     * error banner. That is not cosmetic. A red banner that appears on every
     * deploy with a nonsense count is exactly how a user learns to ignore the
     * banner, and the deleted-by-someone-else state depends on him reading it.
     *
     * The count is the whole subject of every string below: each one is a
     * claim about rows that are on this device and not on the server. With no
     * such rows there is no claim to make. The server being unreachable is
     * real, but it is not the user's problem until it is holding something of
     * his — the recovery loop is already running either way, and it announces
     * itself the moment there is a first unsaved row. */
    if (!n) return mk('none', '', '', [], 0);

    if (s.quotaFailed) {
      return mk('error', 'Out of browser storage — changes are not being saved anywhere.',
        'This device cannot cache your work and the server has not taken it. Copy anything unsaved now.',
        show.concat(['try-now']), n);
    }
    // The "was deleted by someone else" state is real now, and it is backed by
    // machinery rather than by hope: PUT /api/jobs/bulk/save refuses to INSERT a
    // row for which the client supplied a base version (a base means "I loaded
    // this and expect it to exist"), and reports it as conflict reason
    // 'deleted'. `s.deleted` is that id list, carried through the 'partial'
    // status. This branch therefore asserts only what the server actually said.
    switch (s.reason) {
      case 'no-good-load':
        if (held >= STILL_DOWN_MS) {
          return mk('error', "Still can't reach the server",
            plural(n) + ' held on this device. Keep working — but do not close this tab or clear site data until this clears.',
            show.concat(['try-now']), n);
        }
        return mk('error', 'Not saving to the server',
          plural(n) + ' on this device only. Reconnecting…' + attempt(s),
          show.concat(['try-now']), n);

      case 'push-failed':
        return mk('error', "Couldn't save " + plural(n).toLowerCase().replace(/^(\d+ )/, '$1'),
          'They are held on this device and the screen is paused on your copy until they save.',
          show.concat(['retry-now']), n);

      case 'unpushed-changes':
        // The held-hydrate state. This is the one the veto creates, and it is
        // deliberately not red: nothing is lost, the screen is just behind.
        return mk(s.escalate ? 'error' : 'warn',
          s.escalate ? 'Still holding ' + plural(n).toLowerCase() : plural(n) + ' not on the server yet',
          'The screen is paused on your copy so a refresh cannot overwrite ' +
          (n === 1 ? 'it' : 'them') + '. Saving…',
          show.concat(['retry-now']), n);

      case 'hydrate-in-flight':
        if (held < HYDRATE_QUIET_MS) return mk('none', '', '', [], n);
        return mk('warn', 'Waiting on a refresh to finish',
          plural(n) + ' queued behind it. Nothing is lost.', show, n);

      case 'partial':
        if (s.deleted && s.deleted.length) {
          // Deliberately NOT reassuring. Every other state in this file is
          // recoverable by waiting; this one is not, and the copy has to stop
          // the user rather than soothe them.
          return mk('error', 'Deleted by someone else',
            (s.deleted.length === 1 ? 'A record' : s.deleted.length + ' records') +
            ' you were editing had already been deleted. Your change to ' +
            (s.deleted.length === 1 ? 'it was' : 'them was') +
            ' not saved and nothing was re-created.', show, n);
        }
        // Covers BOTH non-deleted refusals — a row that moved on, and a row
        // whose version this device could not prove. "Another session changed
        // it" is only true of the first, so the copy says what is true of both:
        // the server would not take the write without risking newer work.
        return mk('warn', 'Some changes were rejected',
          'The server would not take ' + (n === 1 ? 'a record' : 'records') +
          ' you were editing without overwriting newer work. The current version is being loaded.',
          show, n);

      default:
        return mk('none', '', '', [], n);
    }
  }
  function attempt(s) {
    if (!s.retryAttempt) return '';
    return ' (attempt ' + s.retryAttempt + ')';
  }
  function plural(n) {
    return n + ' change' + (n === 1 ? '' : 's');
  }
  function mk(level, title, detail, actions, count) {
    return { level: level, title: title, detail: detail, actions: actions, count: count };
  }

  return {
    shouldVetoHydrate: shouldVetoHydrate,
    describeSaveState: describeSaveState,
    VETO_ESCALATE_AFTER: VETO_ESCALATE_AFTER,
    HYDRATE_QUIET_MS: HYDRATE_QUIET_MS,
    STILL_DOWN_MS: STILL_DOWN_MS
  };
});
