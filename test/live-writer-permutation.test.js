/**
 * @jest-environment jsdom
 */
/* ────────────────────────────────────────────────────────────────────────
 * THE PROPERTY, not six defects.
 *
 * Round 1 shipped one lie. Round 2 fixed it with an invariant about call
 * sites ("every path that fills this card calls setPill") and six
 * one-per-defect tests. Round 2's reviewers then found the SAME lie in six
 * more places — every one of them a path that satisfied the invariant, or a
 * path that did not exist when the invariant was written.
 *
 * So this file does not test paths. It tests the claim:
 *
 *   AFTER ANY INTERLEAVING OF TWO WRITES, EVERY VISIBLE ELEMENT AGREES WITH
 *   THE NEWEST ONE.
 *
 * Six event kinds × six × nine inter-arrival offsets, plus the three-way
 * cases, generated from one loop. The offsets are not decorative: they
 * straddle every deadline in the engine (the 4.32s max stagger, the 14s
 * collapse, the pane's 22s dismiss, the 180s composing backstop), because a
 * permutation test with badly-chosen timings proves nothing at all. F1 is
 * only visible between 1s and 4.4s; F7 only past 180s.
 *
 * ROUND 4 — and the reason layer 3 exists. Layers 1 and 2 permute reports
 * that all reach the SAME surface, so "the newest report wins" is the only
 * thing they can see. S7 was measured live on the round-3 build in the one
 * direction they structurally cannot: the strip's pill asserted write one
 * while COWORK showed write two. Both surfaces were internally perfect. What
 * was missing was a statement about which write is current at all, so layer 3
 * permutes reports across DIFFERENT surfaces and asserts the general form —
 * after surface X claims write N, no region owned by any other surface may
 * still assert write N−1 as current.
 * ──────────────────────────────────────────────────────────────────────── */

jest.useFakeTimers();

const MODEL = require('../js/live-writer-model.js');

const GREEN = '#1d9e75';
const AMBER = '#d98a1f';
const RED = '#e24b4a';
const BLUE = '#378add';
const GREY = '#9a9aa5';

const COLLAPSE_MS = 14000;
const STAGGER_MS = 180;
const MAX_OPS = 24;

// The exact sentence supersedeStrip / stampDocStale write. Asserted on rather
// than snapshotted, so a copy edit is a one-line change here and nowhere else.
//
// ROUND 6 — there are TWO of them, and which one is correct is a fact about
// the superseding row, not about the region. A single constant here is exactly
// how "A newer write has landed since" came to sit under a pinned document
// about a rolled-back draft: the test asserted the false sentence.
const STALE_MARK = 'A newer write has landed since';
const STALE_ACTIVITY = 'There is newer activity since';
const staleMark = (landed) => (landed ? STALE_MARK : STALE_ACTIVITY);
/* Did the row this event carries actually change data? Read from the model, so
 * the test cannot drift from the engine's own answer. */
const landedBy = (ev) =>
  ev.kind === 'ingest' && MODEL.didWriteLand({ meta: ev.meta });

// ── colour comparison ───────────────────────────────────────────────────
// jsdom normalises style.background to rgb(); the markup writes hex.
const RGB = { '#1d9e75': 'rgb(29, 158, 117)', '#d98a1f': 'rgb(217, 138, 31)',
              '#e24b4a': 'rgb(226, 75, 74)', '#378add': 'rgb(55, 138, 221)',
              '#9a9aa5': 'rgb(154, 154, 165)' };
function sameColor(actual, expected) {
  if (!expected) return true;
  const a = String(actual || '').trim().toLowerCase();
  return a === expected.toLowerCase() || a === (RGB[expected] || '');
}

// ────────────────────────────────────────────────────────────────────────
// LAYER 1 — describe() is pure, so assert the BICONDITIONAL.
//
// Not "path X sets the pill" but "green if and only if this actually
// settled". Both directions matter: "never green" would be as dishonest as
// the bug. This single assertion IS R6/F5, and on HEAD's code it is
// unrepresentable — there was no describe() to ask.
// ────────────────────────────────────────────────────────────────────────
describe('layer 1 · the report cannot disagree with itself', () => {
  const STATES = ['proposed', 'applying', 'applied', 'failed', 'rejected'];
  const CHANGESETS = {
    none: [],
    estimate: [{
      entity_type: 'estimate', id: 'est_1',
      before: { id: 'est_1', title: 'B4', data: { lines: [] } },
      after: { id: 'est_1', title: 'B4', data: { lines: [{ id: 'l1', description: 'Framing', qty: 2, unitCost: 100 }] } }
    }],
    lead: [{
      entity_type: 'lead', id: 'lead_1',
      before: { id: 'lead_1', status: 'new' }, after: { id: 'lead_1', status: 'quoted' }
    }],
    unlistable: [{ entity_type: 'schedule', id: 's1', before: { id: 's1' }, after: { id: 's1' } }]
  };

  function entryFor(state, csKey) {
    const cs = CHANGESETS[csKey];
    const groups = cs.map((e) => {
      if (e.entity_type === 'estimate') {
        return { entity_type: 'estimate', name: 'B4', impact: 200, ops: [{ kind: 'add', label: 'Framing', amount: 200, lineId: 'l1' }] };
      }
      if (e.entity_type === 'lead') {
        return { entity_type: 'lead', name: 'Fairways', impact: 0, ops: [{ kind: 'edit', label: 'status', detail: 'new→quoted', amount: null }] };
      }
      return null;                       // 'unlistable' diffs to zero ops
    }).filter(Boolean);
    return {
      changeset: cs, groups,
      meta: {
        payloadId: 'p_' + state + '_' + csKey, state,
        isDraft: state !== 'applied', title: 'a write', summary: 'did a thing',
        emittingAgentKey: 'scribe', createdAt: new Date().toISOString(),
        applyError: state === 'failed' ? 'Unresolved ref' : null, neverDrafted: false
      }
    };
  }

  const CTXS = [{}, { inEditor: true }, { unreadable: { message: 'HTTP 500', tries: 3 } }];

  test('green ⟺ settles ⟺ a clean committed apply with something to show', () => {
    let checked = 0;
    STATES.forEach((state) => Object.keys(CHANGESETS).forEach((csKey) => CTXS.forEach((ctx) => {
      const r = MODEL.describe(entryFor(state, csKey), ctx);
      const listable = entryFor(state, csKey).groups.reduce((n, g) => n + g.ops.length, 0) > 0;
      // The biconditional, in both directions.
      expect(r.settles).toBe(
        state === 'applied' && listable && !r.degraded && !ctx.unreadable
      );
      expect(r.pillColor === GREEN).toBe(!!r.settles);
      expect((r.settleDot || null) === GREEN).toBe(!!r.settles);
      // A degraded report is never green and never red — it happened, we just
      // cannot read it, and both of those other colours would over-assert.
      if (r.degraded) expect(r.pillColor).toBe(AMBER);
      checked++;
    })));
    expect(checked).toBe(STATES.length * Object.keys(CHANGESETS).length * CTXS.length);
  });

  test('an APPLIED write with nothing listable is amber in BOTH slots — R6/F5', () => {
    // HEAD painted this one card three colours: header dot blue (chrome.dot
    // off the applied DEFAULT arm), pill GREEN (chrome.settle was truthy), and
    // the copy saying nobody could read the write. The pill is the part that
    // survives the collapse.
    const r = MODEL.describe(entryFor('applied', 'unlistable'), {});
    expect(r.kind).toBe('notice');
    expect(r.degraded).toBe(true);
    expect(r.dot).toBe(AMBER);
    expect(r.pillColor).toBe(AMBER);
    expect(r.pillColor).not.toBe(GREEN);
    expect(r.pillColor).not.toBe(BLUE);
  });

  test('a rejection claims nothing at all', () => {
    expect(MODEL.describe(entryFor('rejected', 'estimate'), {}).kind).toBe('silent');
  });

  /* REPORTABILITY IS NOT RENDERABILITY, and reading one off the other is the
   * shape of the round-5 defect. Both directions are asserted, because a
   * predicate that happens to agree with `kind` on the common rows is the
   * predicate that gets quietly replaced by `kind === "silent"` next round. */
  test('reportability is a property of the ROW, not of any rendering — and not of ctx', () => {
    const rejected = entryFor('rejected', 'estimate');

    // ← renderable, and still not news. The same rejected row comes back as a
    //   'notice' when its detail fetch failed, and as 'silent' otherwise: kind
    //   depends on ctx, and currency must not.
    expect(MODEL.describe(rejected, {}).kind).toBe('silent');
    expect(MODEL.describe(rejected, { unreadable: { message: 'HTTP 500', tries: 3 } }).kind).toBe('notice');
    expect(MODEL.supersedesOnScreen(rejected)).toBe(false);

    // → news, in every ctx the surfaces can put it in.
    const applied = entryFor('applied', 'estimate');
    [{}, { inEditor: true }, { unreadable: { message: 'HTTP 500', tries: 3 } }].forEach((ctx) => {
      expect(MODEL.describe(applied, ctx).kind).not.toBe('silent');
      expect(MODEL.supersedesOnScreen(applied)).toBe(true);
    });

    // The handoff placeholder is the other renderable-but-not-news row: a real
    // moment, drawn on the strip, about a write that has not landed.
    expect(MODEL.describe({}, { composing: { label: 'x' } }).kind).toBe('composing');
    expect(MODEL.supersedesOnScreen({ meta: {} })).toBe(false);

    // An unidentified row cannot be the subject of anything, so it is not news
    // either — that is what keeps subject() total: subject is always a real
    // payloadId or null.
    expect(MODEL.supersedesOnScreen({ meta: { state: 'applied' } })).toBe(false);
    expect(MODEL.supersedesOnScreen({ meta: { state: 'applied', payloadId: 'p1' } })).toBe(true);
    expect(MODEL.supersedesOnScreen({ meta: { state: 'proposed', payloadId: 'p1' } })).toBe(true);
    expect(MODEL.supersedesOnScreen({ meta: { state: 'failed', payloadId: 'p1' } })).toBe(true);
    expect(MODEL.supersedesOnScreen({ meta: { state: 'rejected', payloadId: 'p1' } })).toBe(false);
  });

  /* ROUND 6 — THE SECOND QUESTION, and the four rows on which it disagrees
   * with the first. Round 5 shipped one predicate and only ever asked it about
   * `rejected`, where both answers happen to be no. Asserted as a TABLE, in
   * both directions, so a future "these are the same thing really" collapse
   * has to delete a row rather than quietly widen a switch. */
  test('did a write LAND is a different question from does it SUPERSEDE', () => {
    const ROWS = [
      // state,        payloadId, supersedes, landed
      ['applied',      'p1',      true,       true],
      ['proposed',     'p1',      true,       false],   // a dry run, rolled back
      ['applying',     'p1',      true,       false],   // still in flight
      ['failed',       'p1',      true,       false],   // the apply blew up
      ['queued',       'p1',      true,       false],   // a state this file has never heard of
      ['rejected',     'p1',      false,      false],   // a dismissal
      ['applied',      null,      false,      false]    // nothing to be the subject of
    ];
    let diverged = 0;
    ROWS.forEach(([state, payloadId, supersedes, landed]) => {
      const entry = { meta: { state, payloadId } };
      expect([state, payloadId, 'supersedes', MODEL.supersedesOnScreen(entry)])
        .toEqual([state, payloadId, 'supersedes', supersedes]);
      expect([state, payloadId, 'landed', MODEL.didWriteLand(entry)])
        .toEqual([state, payloadId, 'landed', landed]);
      if (supersedes !== landed) diverged++;
    });
    // The whole point: they are not the same predicate wearing two names.
    expect(diverged).toBe(4);
    // A refusal is a failed row with nothing authored — same answers, and it
    // is one of the two forms measured live saying "a newer write has landed".
    const refusal = { meta: { state: 'failed', payloadId: 'p1', neverDrafted: true } };
    expect(MODEL.supersedesOnScreen(refusal)).toBe(true);
    expect(MODEL.didWriteLand(refusal)).toBe(false);
    // …and the sentence a superseded region shows follows question (b) alone.
    expect(MODEL.supersededLead(true)).toContain('landed');
    expect(MODEL.supersededLead(false)).not.toContain('A newer write has landed');
  });

  /* And the ledger asks it ITSELF. A caller that hands over a dismissed row
   * cannot talk the ledger into moving, however it phrases the participant
   * list — which is the difference between a rule and a convention. */
  test('the ledger consults the model before it reads a single claim', () => {
    const led = MODEL.makeWriteLedger();
    let superseded = 0;
    led.register({ name: 'r', owner: 'nobody', supersede: () => { superseded++; } });

    led.report({ meta: { payloadId: 'p1', state: 'applied' } }, ['someone']);
    expect(led.current()).toBe(1);
    expect(led.subject()).toBe('p1');
    expect(superseded).toBe(1);

    // Same call shape, same non-empty participant list, dismissed row.
    led.report({ meta: { payloadId: 'p2', state: 'rejected' } }, ['someone', 'and-another']);
    expect(led.current()).toBe(1);
    expect(led.subject()).toBe('p1');
    expect(superseded).toBe(1);

    // Real news nobody put on screen still moves nothing — the second gate,
    // which now lives here and nowhere else.
    led.report({ meta: { payloadId: 'p3', state: 'applied' } }, []);
    expect(led.current()).toBe(1);
    expect(led.subject()).toBe('p1');
  });

  test('the pane is still a settled apply, so its pill is green', () => {
    const r = MODEL.describe(entryFor('applied', 'estimate'), {});
    expect(r.kind).toBe('pane');
    expect(r.settles).toBe(true);
    expect(r.pillColor).toBe(GREEN);
  });

  test('surface C holding the editor steps the pane down to ops, same claim', () => {
    const pane = MODEL.describe(entryFor('applied', 'estimate'), {});
    const ops = MODEL.describe(entryFor('applied', 'estimate'), { inEditor: true });
    expect(ops.kind).toBe('ops');
    expect(ops.pillColor).toBe(pane.pillColor);
    expect(ops.settleVerb).toBe(pane.settleVerb);
  });
});

// ────────────────────────────────────────────────────────────────────────
// R5 — the pre-recorder predicate is a property of created_at, and it must
// reach every state whose displayed column is draft_changeset.
//
// A TABLE, asserting FACT CLASSES rather than wordings, so copy edits do not
// churn the test and a fact swapping arms cannot slip through.
// ────────────────────────────────────────────────────────────────────────
describe('R5 · why there is no diff — one predicate, every arm', () => {
  const BEFORE = '2026-06-19T14:02:00Z';                    // pre-recorder
  const AFTER = '2026-08-17T10:00:00Z';                     // post-recorder
  const STATES = ['proposed', 'applying', 'failed', 'rejected', 'applied'];

  const norm = (s) => String(s).replace(/[’']/g, "'");
  const mentions = (out, frag) => norm(out).indexOf(norm(frag)) >= 0;

  test('the 20-cell table', () => {
    let cells = 0;
    STATES.forEach((state) => [BEFORE, AFTER].forEach((createdAt) => [false, true].forEach((hasChangeset) => {
      const out = MODEL.noDiffExplanation({ state, createdAt, hasChangeset });
      const isDraft = state !== 'applied';
      const pre = MODEL.predatesDraftRecorder({ createdAt });

      expect(mentions(out, '16 Aug 2026')).toBe(isDraft && pre && !hasChangeset);
      expect(mentions(out, "can't tell")).toBe(isDraft && !pre && !hasChangeset);
      // Scope. DRAFT_RECORDER_SINCE governs draft_changeset ONLY — dating an
      // applied row's missing apply_changeset against it would be a brand-new
      // false claim, so the applied arm must never mention the recorder.
      if (!isDraft) expect(mentions(out, 'before the app started recording')).toBe(false);
      cells++;
    })));
    expect(cells).toBe(20);
  });

  test('THE production cell: a REJECTED pre-recorder row is told the truth', () => {
    // Ten rows in production, every one has_draft false and created before
    // the recorder. HEAD gated the provable sentence on status === 'ready',
    // so all ten were told "this view can't tell" about a fact created_at
    // proves — and it is the ONLY status the fix was ever applied to.
    const out = MODEL.noDiffExplanation({ state: 'rejected', createdAt: BEFORE, hasChangeset: false });
    expect(mentions(out, 'before the app started recording')).toBe(true);
    expect(mentions(out, "can't tell")).toBe(false);
    expect(mentions(out, 'rolled back')).toBe(true);
  });

  test('failed and applying pre-recorder rows get it too', () => {
    ['failed', 'applying'].forEach((state) => {
      expect(mentions(MODEL.noDiffExplanation({ state, createdAt: BEFORE, hasChangeset: false }),
        'before the app started recording')).toBe(true);
    });
  });

  test('a missing created_at falls to the honest branch, never the provable one', () => {
    const out = MODEL.noDiffExplanation({ state: 'proposed', createdAt: null, hasChangeset: false });
    expect(mentions(out, 'before the app started recording')).toBe(false);
    expect(mentions(out, "can't tell")).toBe(true);
  });

  test('BOTH files drive the same table', () => {
    // The strip's public entry point and Cowork's are the same function. If a
    // second copy is ever introduced this fails on the day it drifts.
    const viaStrip = MODEL.draftNoDiffWhy(BEFORE);
    const viaShared = MODEL.noDiffExplanation({ state: 'proposed', createdAt: BEFORE, hasChangeset: false });
    expect(viaStrip).toBe(viaShared);
  });
});

// ────────────────────────────────────────────────────────────────────────
// THE SHARED FIXTURES. Hoisted to module scope in round 4 because layer 3
// permutes the SAME alphabet of events across different surfaces, and an
// alphabet that exists twice is an alphabet that drifts.
// ────────────────────────────────────────────────────────────────────────
const L = (id, desc, qty, unitCost) => ({ id, description: desc, qty, unitCost, unit: 'ea' });

/* The alphabet — six real behaviours, each a fixture factory taking a
 * unique suffix so the engine's per-(payload,state) dedupe cannot swallow
 * the second event of a pair. */
const EVENTS = {
  // applied write with ops, NOT a single estimate → the op strip
  A: (n) => ({ kind: 'ingest', cs: [{
    entity_type: 'lead', id: 'lead_' + n,
    before: { id: 'lead_' + n, title: 'Fairways', status: 'new' },
    after: { id: 'lead_' + n, title: 'Fairways', status: 'quoted' }
  }], meta: { payloadId: 'A' + n, state: 'applied', title: 'Stamp the lead' } }),

  // a REFUSAL — failed with no payload ever authored
  R: (n) => ({ kind: 'ingest', cs: [], meta: {
    payloadId: 'R' + n, state: 'failed', title: 'Set the scope',
    applyError: 'The Scribe did not produce a valid payload. Nothing was written.',
    neverDrafted: true } }),

  // a failed APPLY — a real payload the dispatcher rejected
  X: (n) => ({ kind: 'ingest', cs: [], meta: {
    payloadId: 'X' + n, state: 'failed', title: 'Add framing',
    applyError: 'Unresolved ref $new_id:line_2' } }),

  // the handoff placeholder
  C: (n) => ({ kind: 'composing', label: 'drafting change ' + n }),

  // applied single-estimate write → the document pane
  P: (n) => ({ kind: 'ingest', cs: [{
    entity_type: 'estimate', id: 'est_' + n,
    before: { id: 'est_' + n, title: 'Fairways B4', data: { lines: [L('l1', 'Framing', 10, 100)] } },
    after: { id: 'est_' + n, title: 'Fairways B4', data: { lines: [L('l1', 'Framing', 12, 100), L('l2', 'Paint', 1, 10)] } }
  }], meta: { payloadId: 'P' + n, state: 'applied', title: 'Rework B4' } }),

  // DEGRADED — applied, and nothing this view can break down
  G: (n) => ({ kind: 'ingest', cs: [], meta: {
    payloadId: 'G' + n, state: 'applied', title: 'Reschedule crew',
    summary: 'Moved the crew to Tuesday' } })
};
const LETTERS = Object.keys(EVENTS);

/* Offsets straddling every deadline in the engine. */
const OFFSETS = [
  0,        // same tick
  200,      // one stagger step in
  3000,     // F1's window: mid-stagger for a many-op card
  4400,     // just past STAGGER_MS × MAX_OPS
  13900,    // just before the collapse
  14100,    // just after it
  22100,    // past the pane's COLLAPSE_MS + 8000
  179900,   // just before the composing backstop
  180100    // just after it
];

// The live engine and the live model, re-required by each boot(). Read through
// window rather than the top-level require so an engine that does not
// re-export it — HEAD's, for instance, when checking that this suite
// actually bites — can still be measured against the same decisions.
let LW;
let M;

function bootEngine() {
  jest.resetModules();
  delete window.p86LiveWriter;
  delete window.p86LiveWriterModel;
  document.body.innerHTML = '';
  // MANDATORY, not tidiness. Every boot installs a fresh POLL_MS interval
  // and an initPoll retry chain; without this, six hundred generated cases
  // accumulate six hundred live intervals and the last test spends its whole
  // budget draining them. It also keeps each case a genuinely clean room —
  // a property test that leaks state between cases proves nothing.
  jest.clearAllTimers();
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [] }) }));
  global.localStorage = { getItem: () => null, setItem: () => {} };
  require('../js/live-writer-model.js');
  require('../js/live-writer.js');
  LW = window.p86LiveWriter;
  M = (LW && LW.model) || window.p86LiveWriterModel;
  M.setDev(true);
  M.resetPaintLog();
  if (M.resetClaimLog) M.resetClaimLog();
}

function fire(ev) {
  if (ev.kind === 'composing') { LW.startComposing(ev.label, {}); return; }
  LW.ingest(ev.cs, ev.meta);
}

/* What describe() would say about this event — the expected claim. */
function expected(ev) {
  if (ev.kind === 'composing') {
    return M.describe({}, { composing: { label: ev.label, viaScribe: true } });
  }
  const groups = LW.diff(ev.cs);
  return M.describe({
    changeset: ev.cs, groups,
    meta: Object.assign({ isDraft: ev.meta.state !== 'applied' }, ev.meta)
  }, {});
}

/* Everything the user can currently see, in one object. */
function visibleClaim() {
  const root = document.getElementById('p86-live-writer');
  const pane = document.getElementById('p86-live-pane');
  return {
    stripPresent: !!root,
    collapsed: !!(root && root.className.indexOf('p86lw-collapsed') >= 0),
    pillText: root ? root.querySelector('.p86lw-pilltext').textContent : null,
    pillDot: root ? root.querySelector('.p86lw-pill .p86lw-dot').style.background : null,
    headVerb: root && root.querySelector('.p86lw-verb') ? root.querySelector('.p86lw-verb').textContent : null,
    headDot: root && root.querySelector('.p86lw-card .p86lw-head .p86lw-dot')
      ? root.querySelector('.p86lw-card .p86lw-head .p86lw-dot').style.background : null,
    subject: root && root.querySelector('.p86lw-card .p86lw-sub')
      ? root.querySelector('.p86lw-card .p86lw-sub').textContent : null,
    stale: !!(root && root.querySelector('.p86lw-stale')),
    bodyText: root ? root.textContent : null,
    panePresent: !!pane,
    paneVerb: pane && pane.querySelector('.p86lp-verb') ? pane.querySelector('.p86lp-verb').textContent : null,
    paneDot: pane && pane.querySelector('.p86lp-head .p86lw-dot')
      ? pane.querySelector('.p86lp-head .p86lw-dot').style.background : null
  };
}

/* THE assertion. Not a snapshot — a comparison against the report, so a
 * copy edit does not churn the test and a colour swap cannot slip through.
 *
 * `settled` says whether the newest event's own stagger has finished, which
 * is the only sanctioned way the visible claim may change after it lands. */
function agreesWith(v, r, settled, where) {
  // Assertions run inside hundreds of generated cases, so a bare failure
  // message ("expected true, got false") would not say WHICH interleaving
  // broke. jest's expect() takes no message argument, so the label is
  // attached by rethrowing.
  try {
    expect(v.stripPresent).toBe(true);

    // ── the pill: the claim that outlives everything else ──
    expect(v.pillText).toBe(r.pillText);
    expect(sameColor(v.pillDot, r.pillColor)).toBe(true);
    // F3: the neutral default must never be what a reported write leaves behind.
    expect(v.pillText).not.toBe('Live Writer');
    // …and nothing has superseded this surface, so no stamp either.
    expect(v.stale).toBe(false);

    // ── the card header ──
    if (r.kind === 'notice') {
      expect(v.headVerb).toBe(r.headline);
      expect(sameColor(v.headDot, r.dot)).toBe(true);
    } else if (r.kind === 'ops' || r.kind === 'pane') {
      expect(v.headVerb).toBe(settled && r.settles ? r.settleVerb : r.verb);
      expect(sameColor(v.headDot, settled && r.settles ? r.settleDot : r.dot)).toBe(true);
    }

    // ── the pane ──
    if (r.kind === 'pane') {
      expect(v.panePresent).toBe(true);
      if (settled) {
        expect(v.paneVerb).toBe(r.settleVerb);
        expect(sameColor(v.paneDot, r.settleDot)).toBe(true);
      }
    } else {
      // A pane left standing over a NON-pane report is the inverse of F3:
      // the detail of an older write under the claim of a newer one.
      expect(v.panePresent).toBe(false);
    }
  } catch (e) {
    e.message = '[' + where + '] ' + e.message +
      '\n  visible: ' + JSON.stringify(v) +
      '\n  expected report: ' + JSON.stringify({
        kind: r.kind, pillText: r.pillText, pillColor: r.pillColor,
        verb: r.verb, settleVerb: r.settleVerb, dot: r.dot, settles: r.settles
      });
    throw e;
  }
}

// ────────────────────────────────────────────────────────────────────────
// LAYER 2 — THE INTERLEAVING PROPERTY (one surface).
// ────────────────────────────────────────────────────────────────────────
describe('layer 2 · after any interleaving, everything agrees with the newest', () => {
  const boot = bootEngine;

  // ── P1 · NO ORPHAN ─────────────────────────────────────────────────────
  // After the second event, step the clock and assert the visible claim only
  // ever changes in ways describe(newest) predicts — its own settle, its own
  // collapse. Any other mutation is an async continuation writing to DOM it
  // no longer owns.
  //
  // This single property is F1, F2, R1, F7 and the pane's early dismiss.
  function runPair(a, b, offset) {
    boot();
    const evA = EVENTS[a](1);
    const evB = EVENTS[b](2);

    fire(evA);
    if (offset > 0) jest.advanceTimersByTime(offset);
    fire(evB);

    const r = expected(evB);
    const where = a + '→' + b + ' @' + offset + 'ms';

    // Immediately after the newest report: unsettled.
    agreesWith(visibleClaim(), r, false, where + ' t=0');

    // Past the newest card's OWN stagger (and everything the older one could
    // still have queued). 4.4s clears STAGGER_MS × MAX_OPS.
    jest.advanceTimersByTime(4400);
    agreesWith(visibleClaim(), r, true, where + ' t=4.4s');

    // Just short of the newest card's own collapse.
    jest.advanceTimersByTime(COLLAPSE_MS - 4400 - 100);
    const beforeCollapse = visibleClaim();
    agreesWith(beforeCollapse, r, true, where + ' t=13.9s');
    // 'composing' is the one kind that deliberately never collapses: it ends
    // when the draft lands or when its own backstop fires. 'pane' collapses
    // the strip on purpose — the pane holds the detail, the pill the claim.
    if (r.kind !== 'composing' && r.kind !== 'pane') {
      expect(beforeCollapse.collapsed).toBe(false);
    }

    // Through the collapse, the pane's dismiss, and well past the 180s
    // backstop. The PILL is what survives, and it must still be true.
    jest.advanceTimersByTime(200000);
    const late = visibleClaim();
    if (late.stripPresent) {
      try {
        expect(late.pillText).toBe(r.pillText);
        expect(sameColor(late.pillDot, r.pillColor)).toBe(true);
      } catch (e) { e.message = '[' + where + ' pill drifted after 200s] ' + e.message; throw e; }
    }
  }

  test('P1 · every ordered pair at every offset — the visible claim never drifts', () => {
    let cases = 0;
    LETTERS.forEach((a) => LETTERS.forEach((b) => OFFSETS.forEach((off) => {
      // Two composing cards in a row at offset 0 is not a real sequence (the
      // tool fires once per handoff) and the pair (C,C) at every other offset
      // is covered.
      runPair(a, b, off);
      cases++;
    })));
    expect(cases).toBe(LETTERS.length * LETTERS.length * OFFSETS.length);
  });

  // ── P2 · PILL COMPLETENESS ─────────────────────────────────────────────
  // F3 directly: a report delivered into the PANE used to leave the strip
  // region untouched, so a red "Scribe couldn't draft that" pill sat over a
  // successful estimate document for the rest of the session.
  test('P2 · a failure followed by a successful PANE leaves no red pill — F3', () => {
    boot();
    fire(EVENTS.R(1));
    expect(visibleClaim().pillDot).toBe(RGB[RED]);

    jest.advanceTimersByTime(1000);
    fire(EVENTS.P(2));
    const v = visibleClaim();
    expect(v.panePresent).toBe(true);
    expect(v.pillText).not.toContain("couldn't draft");
    expect(sameColor(v.pillDot, RED)).toBe(false);
    expect(sameColor(v.pillDot, GREEN)).toBe(true);
  });

  test('P2 · every non-silent report leaves a pill that is not the neutral default', () => {
    LETTERS.forEach((k) => {
      boot();
      fire(EVENTS[k](1));
      const v = visibleClaim();
      expect(v.pillText).not.toBe('Live Writer');
      expect(v.pillText).toBe(expected(EVENTS[k](1)).pillText);
    });
  });

  // ── P3 · NO SUPERSEDED PAINT ───────────────────────────────────────────
  // Every guarded paint is logged in dev mode. Two assertions: nothing that
  // lost its epoch may paint, and supersession must ACTUALLY happen across
  // the corpus — otherwise the guard is untested scaffolding.
  test('P3 · superseded continuations are caught, and none of them paints', () => {
    let blocked = 0, painted = 0;
    LETTERS.forEach((a) => LETTERS.forEach((b) => {
      boot();
      fire(EVENTS[a](1));
      jest.advanceTimersByTime(500);      // mid-stagger, mid-flight
      fire(EVENTS[b](2));
      jest.advanceTimersByTime(200000);
      M.paintLog().forEach((p) => {
        if (p.held) { painted++; expect(p.epoch).toBe(p.current); }
        else { blocked++; expect(p.epoch).toBeLessThan(p.current); }
      });
    }));
    expect(painted).toBeGreaterThan(0);
    // If this ever hits zero the interleaving stopped producing races and the
    // property above is no longer proving anything.
    expect(blocked).toBeGreaterThan(0);
  });

  // ── P4 · THE STRIP MAY LOSE A REPORT. COWORK MAY NOT. ──────────────────
  // This is what licenses "abandon silently" in §2: supersession is the
  // strip's correct semantics because it is a NOTIFICATION. The ledger is the
  // durable record, so every ingested payload must still reach a surface that
  // keeps it.
  test('P4 · a superseded strip report is still ingested and still broadcast', () => {
    boot();
    const seen = [];
    LW.registerSurface({
      name: 'ledger-probe', order: 5, exclusive: false,
      claims: () => true, render: (e) => { seen.push(e.meta.payloadId); }
    });
    LETTERS.filter((k) => k !== 'C').forEach((k, i) => {
      fire(EVENTS[k](100 + i));
      jest.advanceTimersByTime(50);       // deliberately inside every stagger
    });
    // Six writes land 50ms apart; the strip can only show the last. Every one
    // of them still reached a durable surface.
    expect(seen.length).toBe(LETTERS.length - 1);
  });

  // ── three-way ──────────────────────────────────────────────────────────
  test('P1 · all 216 ordered TRIPLES at a mid-stagger offset', () => {
    let cases = 0;
    LETTERS.forEach((a) => LETTERS.forEach((b) => LETTERS.forEach((c) => {
      boot();
      fire(EVENTS[a](1)); jest.advanceTimersByTime(500);
      fire(EVENTS[b](2)); jest.advanceTimersByTime(500);
      fire(EVENTS[c](3));
      const r = expected(EVENTS[c](3));
      const where = a + '→' + b + '→' + c;
      agreesWith(visibleClaim(), r, false, where + ' t=0');
      jest.advanceTimersByTime(4400);
      agreesWith(visibleClaim(), r, true, where + ' t=4.4s');
      cases++;
    })));
    expect(cases).toBe(216);
  });

  // ── the named escapes, as themselves ───────────────────────────────────
  test('F1 · a failure notice is not repainted to "wrote" on green by an orphan loop', () => {
    boot();
    // Many ops → a stagger long enough to outlive the notice that replaces it.
    const lines = [];
    for (let i = 0; i < MAX_OPS; i++) lines.push(L('l' + i, 'Line ' + i, 1, 10));
    LW.ingest([{ entity_type: 'estimate', id: 'est_f1',
      before: { id: 'est_f1', title: 'B4', data: { lines: [] } },
      after: { id: 'est_f1', title: 'B4', data: { lines } } }],
      { payloadId: 'f1a', state: 'applied', title: 'Big write' });

    jest.advanceTimersByTime(300);
    fire(EVENTS.R(9));                       // the refusal takes the card

    // t=1001ms on the live build: verb "couldn't draft that", dot red. Correct.
    jest.advanceTimersByTime(700);
    expect(visibleClaim().headVerb).toContain("couldn't draft");
    // t=3003ms on the live build: verb "wrote", dot rgb(29,158,117) — over a
    // body still reading "Nothing was written". That is the whole defect.
    jest.advanceTimersByTime(4000);
    const v = visibleClaim();
    expect(v.headVerb).toContain("couldn't draft");
    expect(v.headVerb).not.toBe('wrote');
    expect(sameColor(v.headDot, GREEN)).toBe(false);
    expect(sameColor(v.headDot, RED)).toBe(true);
    expect(v.bodyText).toContain('Nothing was written');
  });

  test('F2 · an orphan does not re-arm the collapse the composing card cleared', () => {
    boot();
    fire(EVENTS.A(1));
    jest.advanceTimersByTime(300);
    LW.startComposing('Set the scope on B4', {});
    // The applied write's stagger loop is still queued. On HEAD it settled the
    // in-flight blue dot to solid green at t≈3s and re-armed armCollapse, so
    // the drafting card collapsed at t≈17s.
    jest.advanceTimersByTime(3000);
    let v = visibleClaim();
    expect(sameColor(v.headDot, GREEN)).toBe(false);
    expect(v.pillText).toContain('drafting');
    jest.advanceTimersByTime(COLLAPSE_MS + 1000);
    v = visibleClaim();
    expect(v.collapsed).toBe(false);
    expect(v.pillText).toContain('drafting');
  });

  test('R1 · the 180s backstop cannot overwrite a truthful degraded notice', () => {
    boot();
    LW.startComposing('Set the scope on B4', {});
    // noticeUnreadable's path: the write reached 'applied', its detail could
    // not be read. HEAD never cleared _composing here, so three minutes later
    // the backstop replaced this with "hasn't come back / Nothing has landed
    // here in three minutes" — both clauses false.
    fire(EVENTS.G(5));
    expect(visibleClaim().bodyText).toContain("can't break down");
    jest.advanceTimersByTime(200000);
    const v = visibleClaim();
    expect(v.bodyText).not.toContain("hasn't come back");
    expect(v.bodyText).toContain("can't break down");
  });

  test('F7 · dismissing the drafting card by hand does not rebuild it 180s later', () => {
    boot();
    LW.startComposing('Set the scope on B4', {});
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
    LW.dismiss();
    expect(document.getElementById('p86-live-writer')).toBeNull();
    jest.advanceTimersByTime(200000);
    // HEAD: dismiss() cleared collapseTimer and removed the root but never
    // touched composingTimer, so the backstop called showNotice → ensureRoot
    // and rebuilt the card the user had explicitly closed.
    expect(document.getElementById('p86-live-writer')).toBeNull();
  });

  test('F8 · a write claimed by another surface does not flash the strip', () => {
    boot();
    // Surface A's shape: an exclusive higher-priority surface takes the write.
    LW.registerSurface({
      name: 'cowork', order: 20, exclusive: true, claims: () => true, render: () => {}
    });
    LW.startComposing('drafting', {});
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
    fire(EVENTS.A(7));
    // Reported elsewhere: the strip has nothing left to say, and the
    // placeholder is retired rather than left claiming "drafting".
    expect(document.getElementById('p86-live-writer')).toBeNull();
  });

  test('the composing backstop still fires when nothing supersedes it', async () => {
    boot();
    global.fetch.mockImplementation(() => Promise.reject(new Error('offline')));
    LW.startComposing('Something that never lands', {});
    await jest.advanceTimersByTimeAsync(190000);
    const v = visibleClaim();
    expect(v.bodyText).toContain("hasn't come back");
    expect(v.bodyText).toContain('could not be checked');
    // AMBER, not the failed-state red. Red means "it did not happen", and
    // this copy says in the same breath that it does not know.
    expect(sameColor(v.pillDot, AMBER)).toBe(true);
    expect(sameColor(v.pillDot, RED)).toBe(false);
  }, 20000);
});

// ────────────────────────────────────────────────────────────────────────
// LAYER 3 — THE CROSS-SURFACE PROPERTY. S7 is one instance of it.
//
// Layer 2 permutes reports that all arrive at the SAME surface, so the newest
// report always overwrites the previous one and "everything agrees with the
// newest" is nearly free. The direction it cannot see is the one that was
// measured live: surface X claims write N while surface Y is still showing
// write N−1 and has no idea anything happened.
//
// The general claim, of which S7 is a single point:
//
//   AFTER ANY INTERLEAVING IN WHICH SURFACE X REPORTS WRITE N AND SURFACE Y
//   PREVIOUSLY REPORTED WRITE N−1, NO VISIBLE ELEMENT OWNED BY Y ASSERTS N−1
//   AS CURRENT.
//
// "Asserts as current" is the load-bearing phrase and it is asserted on
// precisely, in both directions:
//
//   · the unanchored element (the pill — no record name, no timestamp) must
//     be back at the neutral default that claims nothing;
//   · the anchored element (the card, which names its record) must STILL BE
//     THERE, because the user may be reading it, and must carry the stamp.
//
// Testing only the first half would be passed by an implementation that
// deletes everything on every write, which is a different bug.
// ────────────────────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────────────────────
// THE MOUNTING DIMENSION — round 5.
//
// P8 ("a silent row moves no generation") already existed and already passed,
// and it was still wrong, because it was written with ONE surface mounted —
// the one that consults describe() and therefore declines the rows describe()
// calls silent. The measured defect needed a second surface mounted to appear
// at all. So a currency property asserted under one mounting is not asserted:
// the mounting is a free variable of the system and it belongs in the sweep.
//
// Three surface SHAPES, chosen because each one answers the fan-out's
// question differently, and the differences are exactly what round 4's rule
// ("explicit null = declined, anything else = claimed") was reading:
//
//   cowork    order 20, exclusive. claims on PAGE STATE, never on the row.
//             render() returns undefined on every branch. Registers a ledger
//             claimant. This is the real shape of js/cowork.js and the shape
//             that produced the defect.
//   decliner  order 15, exclusive. Looks at every row and puts none of them on
//             screen — an honest `return null`. The shape of surface B on a
//             silent row. It must not suppress the surfaces behind it.
//   stub      order 25, NON-exclusive. Implements claims/render and NOTHING
//             else: no ledger registration, no chrome, no decisions. It claims
//             every row and returns undefined. It is the minimum a surface can
//             be, and under round 4's rule it made every row — dismissals
//             included — look like a reported write.
const SURFACE_SHAPES = ['cowork', 'decliner', 'stub'];

/* All 8 subsets, for the properties that are about the LEDGER and need no
 * particular surface to be expressible. */
const ALL_MOUNTS = (function () {
  const out = [];
  for (let m = 0; m < 8; m++) {
    out.push(SURFACE_SHAPES.filter((_, i) => (m >> i) & 1));
  }
  return out;
})();

/* …and the 4 in which Cowork is present. The cross-surface properties (P5, P6)
 * are STATEMENTS ABOUT a second exclusive surface with a ledger claimant of its
 * own — "the strip must not assert a write Cowork took", "Cowork's document
 * must not assert a write the strip took". With no such surface mounted there
 * is no second region and the sentence has no subject, so those runs would be
 * vacuous rather than passing. Said plainly instead of quietly skipped: the
 * mount sets WITHOUT cowork are covered for every ledger-level property by the
 * ALL_MOUNTS battery below, which is where the round-5 defect lives. */
const COWORK_MOUNTS = ALL_MOUNTS.filter((s) => s.indexOf('cowork') >= 0);

const mountLabel = (s) => (s.length ? s.join('+') : 'strip only');

/* Mount a set of shapes onto the freshly-booted engine. Surface B mounts
 * itself, so "strip only" is the empty set. Returns a tally the caller can
 * assert against, because a mounting nobody exercised proves nothing. */
function mountSurfaces(mounts, cowork) {
  cowork = cowork || {};
  const tally = { stubRendered: 0, declinerLooked: 0, coworkRendered: 0 };
  if (mounts.indexOf('decliner') >= 0) {
    LW.registerSurface({
      name: 'decliner', order: 15, exclusive: true,
      claims: () => { tally.declinerLooked++; return true; },
      // The honest decline: it looked, and it put nothing on screen. It must
      // not stop the surfaces behind it from getting the row.
      render: () => null
    });
  }
  if (mounts.indexOf('cowork') >= 0) {
    LW.registerSurface({
      name: 'cowork', order: 20, exclusive: true,
      claims: () => (cowork.active ? !!cowork.active() : false),
      render: (entry) => {
        tally.coworkRendered++;
        // Pinned = the user picked a row, so a new write raises an unread
        // marker instead of repainting. The document goes on showing an older
        // write ON PURPOSE — which is exactly the case the stamp exists for.
        if (cowork.onRender) cowork.onRender(entry);
      }
    });
    if (cowork.onSupersede) {
      LW.writes.register({
        name: 'cowork-doc', owner: 'cowork',
        keeps: cowork.keeps,
        supersede: cowork.onSupersede
      });
    }
  }
  if (mounts.indexOf('stub') >= 0) {
    // claims + render and NOTHING else. No ledger claimant, no chrome, no
    // opinion about any row. Non-exclusive, so it never suppresses another
    // surface — it only ever ADDS itself to the participant list, which is
    // precisely how a row that is not news came to look like one.
    LW.registerSurface({
      name: 'stub', order: 25, exclusive: false,
      claims: () => true,
      render: () => { tally.stubRendered++; }
    });
  }
  return tally;
}

// Wrapped in a loop rather than indented one level deeper: the body below is
// unchanged layer-3 code and a whole-file reindent would bury the two real
// edits in six hundred lines of whitespace diff.
COWORK_MOUNTS.forEach(function (MOUNTS) {
describe('layer 3 · [' + mountLabel(MOUNTS) + '] cross-surface — nothing asserts a write another surface superseded', () => {
  // The stand-in for Cowork at ENGINE level. It has to do exactly two things a
  // second surface does: claim writes when it is the active page, and register
  // a region with the ledger. It deliberately paints nothing — the property
  // under test here is what the STRIP does when someone else reports, and that
  // must not depend on the other surface's chrome.
  let coworkActive = false;     // is Cowork the active page?
  let coworkPinned = false;     // is its document pinned to a row by hand?
  let coworkShowing = null;     // the write its document is displaying
  let coworkSuperseded = 0;

  function boot3(opts) {
    opts = opts || {};
    bootEngine();
    coworkActive = !!opts.active;
    coworkPinned = !!opts.pinned;
    coworkShowing = opts.showing || null;
    coworkSuperseded = 0;
    mountSurfaces(MOUNTS, {
      active: () => coworkActive,
      onRender: (entry) => { if (!coworkPinned) coworkShowing = entry.meta.payloadId; },
      keeps: (by, subject) =>
        !!by['cowork'] && coworkShowing != null && String(coworkShowing) === String(subject),
      onSupersede: () => { coworkSuperseded++; }
    });
  }

  /* Y = the strip. After X reported, what may the strip still say? */
  function stripAssertsNothingStale(rPrev, where, landed) {
    const v = visibleClaim();
    try {
      // 1 · the CURRENCY carrier is back to claiming nothing.
      if (v.stripPresent) {
        expect(v.pillText).toBe('Live Writer');
        expect(sameColor(v.pillDot, GREY)).toBe(true);
        expect(v.pillText).not.toBe(rPrev.pillText);
      }
      // 2 · a superseded document overlay does not linger under someone
      //     else's claim — the F3 inverse, now across surfaces.
      expect(v.panePresent).toBe(false);
      // 3 · CONTENT IS NOT YANKED. The handoff placeholder is the single
      //     documented exception (it holds no anchored content and a landing
      //     write is the evidence its own handoff came back); everything else
      //     keeps its card, keeps its record name, and gains the stamp.
      if (rPrev.kind === 'composing') {
        expect(v.stripPresent).toBe(false);
      } else {
        expect(v.stripPresent).toBe(true);
        expect(v.stale).toBe(true);
        // …and the stamp says what actually happened. A superseding row that
        // did NOT land must not be described as one that did.
        expect(v.bodyText).toContain(staleMark(landed));
        if (!landed) expect(v.bodyText).not.toContain(STALE_MARK);
        if (rPrev.name) expect(v.subject).toBe(rPrev.name);
      }
    } catch (e) {
      e.message = '[' + where + '] ' + e.message +
        '\n  visible: ' + JSON.stringify(v) +
        '\n  superseded report: ' + JSON.stringify({ kind: rPrev.kind, pillText: rPrev.pillText, name: rPrev.name });
      throw e;
    }
  }

  // A tighter offset set than layer 2's — the cross-surface property has no
  // 180s deadline of its own, and 3 offsets × 4 routings × 36 pairs is already
  // 432 booted engines.
  const X_OFFSETS = [0, 3000, 22100];

  test('P5 · strip claims N−1, COWORK claims N → the strip asserts nothing stale', () => {
    let cases = 0;
    LETTERS.forEach((a) => LETTERS.forEach((b) => X_OFFSETS.forEach((off) => {
      boot3({ active: false });
      const evA = EVENTS[a](1);
      fire(evA);
      const rPrev = expected(evA);
      if (off > 0) jest.advanceTimersByTime(off);

      coworkActive = true;                       // the user moved to Cowork
      const evB = EVENTS[b](2);
      if (evB.kind === 'composing') { cases++; return; }   // see P7
      fire(evB);

      const where = 'strip:' + a + ' → cowork:' + b + ' @' + off + 'ms';
      const landed = landedBy(evB);
      stripAssertsNothingStale(rPrev, where + ' t=0', landed);
      // And it stays stepped down. An orphan stagger loop from the old report
      // still holds the strip's REGION epoch and may finish painting its own
      // card — that is anchored content and allowed — but it must never put
      // the pill back.
      jest.advanceTimersByTime(200000);
      stripAssertsNothingStale(rPrev, where + ' t=200s', landed);
      cases++;
    })));
    expect(cases).toBe(LETTERS.length * LETTERS.length * X_OFFSETS.length);
  });

  test('P5 · the same property with THREE surfaces in play, all six orderings', () => {
    // strip → cowork → strip: the strip comes back, so it is allowed to
    // assert again — and must, or the fix has become "never claim anything".
    let cases = 0;
    LETTERS.forEach((a) => LETTERS.forEach((c) => {
      boot3({ active: false });
      fire(EVENTS[a](1));
      jest.advanceTimersByTime(500);
      coworkActive = true;
      fire(EVENTS.A(2));                          // cowork takes write two
      jest.advanceTimersByTime(500);
      coworkActive = false;
      const evC = EVENTS[c](3);
      if (evC.kind === 'composing') { cases++; return; }
      fire(evC);                                  // the strip takes write three
      const r = expected(evC);
      agreesWith(visibleClaim(), r, false, 'strip:' + a + ' → cowork → strip:' + c);
      cases++;
    }));
    expect(cases).toBe(LETTERS.length * LETTERS.length);
  });

  test('P6 · COWORK claims N−1, the strip claims N → Cowork\'s document is superseded', () => {
    // The mirror image, and the one that keeps this from being a rule about
    // the strip. Cowork is not privileged: a document showing write N−1 while
    // the strip reports write N is the same defect facing the other way.
    // 'C' is excluded from BOTH positions and the exclusion is the point, not
    // a convenience: a handoff placeholder is not a write. It claims no
    // generation (P7), so it must leave Cowork's document exactly as current
    // as it found it — and as the FIRST event it never reaches Cowork at all.
    const WRITES_ONLY = LETTERS.filter((k) => k !== 'C');
    let cases = 0;
    WRITES_ONLY.forEach((a) => WRITES_ONLY.forEach((b) => {
      boot3({ active: true });
      fire(EVENTS[a](1));                         // cowork claims it
      expect(coworkSuperseded).toBe(0);
      jest.advanceTimersByTime(500);
      coworkActive = false;                       // the user left the page
      fire(EVENTS[b](2));                         // the strip claims write two
      expect(coworkSuperseded).toBeGreaterThan(0);
      cases++;
    }));
    expect(cases).toBe(WRITES_ONLY.length * WRITES_ONLY.length);
  });

  test('P6 · an UNPINNED Cowork document follows the newest write and is never stamped', () => {
    // The other direction of the biconditional. A rule that supersedes
    // everything on every write would pass P5 and P6 and be useless: the
    // document that is genuinely showing the newest write must be left alone.
    LETTERS.filter((k) => k !== 'C').forEach((a) => LETTERS.filter((k) => k !== 'C').forEach((b) => {
      boot3({ active: true });
      fire(EVENTS[a](1));
      jest.advanceTimersByTime(500);
      fire(EVENTS[b](2));
      expect(coworkSuperseded).toBe(0);
    }));
  });

  test('P6 · a PINNED Cowork document keeps its row and IS stamped — the deliberate divergence', () => {
    // Pinning is a feature, not a bug: pick a row by hand and a new write must
    // not yank it away. So the document is not cleared and not demoted — it is
    // stamped, and that stamp is the whole difference between "showing an old
    // write on purpose" and "asserting an old write is the latest".
    boot3({ active: true });
    fire(EVENTS.A(1));
    expect(coworkShowing).toBe('A1');
    jest.advanceTimersByTime(500);

    coworkPinned = true;                          // the user picks this row
    fire(EVENTS.G(2));                            // a newer write lands on Cowork
    // The reading position survives…
    expect(coworkShowing).toBe('A1');
    // …and it is told it is no longer the latest.
    expect(coworkSuperseded).toBe(1);
  });

  test('P7 · the handoff placeholder claims no generation — an in-flight card supersedes nothing', () => {
    // startComposing reports to the strip but NOT to the ledger: no write has
    // landed, so nothing about which write is current has changed. If it did
    // claim a generation, asking 86 for a change would stamp a Cowork document
    // that is still perfectly current.
    boot3({ active: true });
    fire(EVENTS.A(1));
    expect(coworkSuperseded).toBe(0);
    LW.startComposing('drafting something', {});
    expect(coworkSuperseded).toBe(0);
    // …but a placeholder still on screen when a write lands elsewhere is
    // retired, because a landing write is the evidence its handoff came back.
    fire(EVENTS.G(2));
    expect(document.getElementById('p86-live-writer')).toBeNull();
  });

  test('P8 · a SILENT row reports nothing, so it demotes nothing', () => {
    // A rejection is not news, so the ledger must not move — no matter which
    // surfaces are mounted or which page the user is on. THE ROUND-5 DEFECT
    // IS THE `active: true` HALF OF THIS LOOP. Round 4's version of this test
    // ran only with Cowork inactive, which is the one configuration in which
    // the only mounted surface is the one that consults describe(); it passed
    // for the whole time the bug was live.
    [false, true].forEach((active) => {
      boot3({ active });
      fire(EVENTS.A(1));
      const before = {
        visible: JSON.stringify(visibleClaim()),
        gen: LW.writes.current(),
        subject: LW.writes.subject(),
        superseded: coworkSuperseded
      };
      const where = 'mounts=' + mountLabel(MOUNTS) + ' coworkActive=' + active;
      LW.ingest([], { payloadId: 'rej_' + active, state: 'rejected', title: 'Someone else\'s draft' });
      // NOTHING moved: not the pixels, not the generation, not the subject,
      // and nobody was told they had been superseded.
      expect([where, JSON.stringify(visibleClaim())]).toEqual([where, before.visible]);
      expect([where, LW.writes.current()]).toEqual([where, before.gen]);
      expect([where, LW.writes.subject()]).toEqual([where, before.subject]);
      expect([where, coworkSuperseded]).toEqual([where, before.superseded]);
    });
  });

  test('P8 · THE MEASURED CASE — a dismissal does not destroy an unrelated drafting card', () => {
    // Measured live on the deployed build, same session, same build: off
    // Cowork the card survived; on Cowork the whole strip was removed. The
    // difference was not the row — it was which surface happened to be
    // mounted, which is exactly what a currency rule must not depend on.
    [false, true].forEach((active) => {
      boot3({ active });
      LW.startComposing('drafting your change', {});
      const card = M.describe({}, { composing: { label: 'drafting your change', viaScribe: true } });
      const where = 'mounts=' + mountLabel(MOUNTS) + ' coworkActive=' + active;
      expect([where, visibleClaim().pillText]).toEqual([where, card.pillText]);

      LW.ingest([], { payloadId: 'rej_card', state: 'rejected', title: 'An unrelated dismissed draft' });

      expect([where, !!document.getElementById('p86-live-writer')]).toEqual([where, true]);
      expect([where, visibleClaim().pillText]).toEqual([where, card.pillText]);
      // A placeholder claims no generation (P7) and a dismissal is not news,
      // so nothing in this scenario has ever been reported.
      expect([where, LW.writes.current()]).toEqual([where, 0]);
      expect([where, LW.writes.subject()]).toEqual([where, null]);
    });
  });

  test('P9 · the ledger actually fires across the corpus — not untested scaffolding', () => {
    // P3's guard, one level up. If supersession never happens in these runs
    // the properties above are vacuously true.
    let supersessions = 0, keeps = 0, reports = 0;
    LETTERS.forEach((a) => LETTERS.forEach((b) => {
      boot3({ active: false });
      fire(EVENTS[a](1));
      jest.advanceTimersByTime(500);
      coworkActive = true;
      fire(EVENTS[b](2));
      jest.advanceTimersByTime(200000);
      M.claimLog().forEach((c) => {
        if (c.event === 'supersede') supersessions++;
        else if (c.event === 'keep') keeps++;
        else if (c.event === 'report') reports++;
      });
    }));
    expect(reports).toBeGreaterThan(0);
    expect(supersessions).toBeGreaterThan(0);
    expect(keeps).toBeGreaterThan(0);
  });
});
});

// ────────────────────────────────────────────────────────────────────────
// LAYER 3b — THE MOUNTING IS A FREE VARIABLE OF THE SYSTEM.
//
// Layer 3 needs Cowork present, because its properties are sentences about a
// second exclusive surface with a region of its own. The LEDGER-level
// properties need nothing of the sort, and they are the ones round 5 was
// about — so they run under all eight mountings, including the strip on its
// own and including a surface that is nothing but claims/render.
//
// The claim:
//
//   WHETHER A WRITE HAPPENED IS A PROPERTY OF THE ROW. THE SET OF MOUNTED
//   SURFACES, AND WHAT THEY RETURN, CANNOT CHANGE IT.
//
// Round 4 got the other half of this ("which write is current" is reported by
// the fan-out, not by a surface) and left this half with the surfaces: a row
// counted as a write iff some render() had not returned null. The one surface
// that consults describe() declined the silent rows, so the invariant held
// wherever that surface was alone — which is every configuration the tests
// booted, and not the one the user was looking at.
// ────────────────────────────────────────────────────────────────────────
describe('layer 3b · whether a write happened does not depend on what is mounted', () => {
  let tally = null;
  let coworkActive = false, coworkShowing = null, coworkSuperseded = 0;

  function bootM(mounts, opts) {
    opts = opts || {};
    bootEngine();
    coworkActive = !!opts.active;
    coworkShowing = null;
    coworkSuperseded = 0;
    tally = mountSurfaces(mounts, {
      active: () => coworkActive,
      onRender: (entry) => { coworkShowing = entry.meta.payloadId; },
      keeps: (by, subject) =>
        !!by['cowork'] && coworkShowing != null && String(coworkShowing) === String(subject),
      onSupersede: () => { coworkSuperseded++; }
    });
  }

  /* A dismissed draft: a real row, in a real state, that is not news. */
  const DISMISSED = (n) => ({
    kind: 'ingest', cs: [],
    meta: { payloadId: 'D' + n, state: 'rejected', title: 'a draft someone dismissed' }
  });

  const MOUNTINGS = [];
  ALL_MOUNTS.forEach((m) => { MOUNTINGS.push([m, false]); MOUNTINGS.push([m, true]); });
  const label = (m, a) => 'mounts=' + mountLabel(m) + ' coworkActive=' + a;

  test('P10 · subject() is ONLY ever the id of a row the model calls reportable', () => {
    // The second, worse form of the defect: subject() is documented as "the
    // payloadId of the newest REPORTED write" and it was measured holding
    // pl_1784314336678_l5rn453j — a REJECTION — while a pinned Cowork document
    // read "A newer write has landed since." That is the UI asserting
    // something happened that did not.
    let checked = 0, everSet = 0;
    MOUNTINGS.forEach(([mounts, active]) => LETTERS.forEach((a) => {
      bootM(mounts, { active });
      const other = (a === 'A') ? 'G' : 'A';
      const seq = [EVENTS[a](1), DISMISSED(2), EVENTS[other](3), DISMISSED(4)];
      const reportable = new Set();
      seq.forEach((ev) => {
        fire(ev);
        if (ev.kind === 'ingest' && M.supersedesOnScreen({ meta: ev.meta })) reportable.add(String(ev.meta.payloadId));
        const s = LW.writes.subject();
        const where = label(mounts, active) + ' seq=' + a;
        if (s != null) {
          everSet++;
          expect([where, 'subject=' + s, reportable.has(String(s))]).toEqual([where, 'subject=' + s, true]);
        }
        checked++;
      });
    }));
    expect(checked).toBe(MOUNTINGS.length * LETTERS.length * 4);
    expect(everSet).toBeGreaterThan(0);           // not vacuously true
  });

  test('P11 · a row the model does not call news moves NOTHING, under every mounting', () => {
    let moved = 0;
    MOUNTINGS.forEach(([mounts, active]) => {
      bootM(mounts, { active });
      fire(EVENTS.A(1));                          // real news first, so gen > 0
      const g0 = LW.writes.current(), s0 = LW.writes.subject(), c0 = coworkSuperseded;
      if (g0 > 0) moved++;
      const where = label(mounts, active);
      fire(DISMISSED(2));
      expect([where, LW.writes.current()]).toEqual([where, g0]);
      expect([where, LW.writes.subject()]).toEqual([where, s0]);
      expect([where, coworkSuperseded]).toEqual([where, c0]);
    });
    // …and the reportable row DID move it somewhere, or the assertions above
    // are about a ledger that never does anything.
    expect(moved).toBeGreaterThan(0);
  });

  test('P11 · the drafting card survives a dismissal under every mounting', () => {
    MOUNTINGS.forEach(([mounts, active]) => {
      bootM(mounts, { active });
      LW.startComposing('drafting your change', {});
      const card = M.describe({}, { composing: { label: 'drafting your change', viaScribe: true } });
      const where = label(mounts, active);
      expect([where, visibleClaim().pillText]).toEqual([where, card.pillText]);
      fire(DISMISSED(3));
      expect([where, !!document.getElementById('p86-live-writer')]).toEqual([where, true]);
      expect([where, visibleClaim().pillText]).toEqual([where, card.pillText]);
      expect([where, LW.writes.current()]).toEqual([where, 0]);
    });
  });

  test('P12 · the mountings are not vacuous — a surface really did draw the dismissed row', () => {
    // Without this, P10/P11 could pass because no surface ever touched the
    // dismissed row in any configuration, which is the state of affairs that
    // let P8 pass for a whole round.
    let drawn = 0;
    ALL_MOUNTS.forEach((mounts) => {
      const active = mounts.indexOf('cowork') >= 0;
      bootM(mounts, { active });
      fire(DISMISSED(1));
      const where = label(mounts, active);
      if (mounts.indexOf('stub') >= 0) {
        expect([where, tally.stubRendered > 0]).toEqual([where, true]);
        drawn++;
      }
      if (active) {
        expect([where, tally.coworkRendered > 0]).toEqual([where, true]);
        drawn++;
      }
    });
    expect(drawn).toBeGreaterThan(0);
  });

  test('P12 · a declining surface does not suppress the surfaces behind it', () => {
    // The decliner is exclusive and claims everything. If `return null` were
    // treated as a claim it would silently swallow every write in this suite
    // and every property above would be about an engine that reports nothing.
    bootM(['decliner'], { active: false });
    fire(EVENTS.A(1));
    expect(tally.declinerLooked).toBeGreaterThan(0);
    expect(document.getElementById('p86-live-writer')).not.toBeNull();   // B still got it
    expect(LW.writes.current()).toBe(1);
    expect(LW.writes.subject()).toBe('A1');
  });
});

// ────────────────────────────────────────────────────────────────────────
// LAYER 4 — the same property with BOTH REAL FILES, no stand-in.
//
// Layer 3's Cowork is a stand-in, and a stand-in can only prove things about
// the engine. This layer boots js/live-writer.js and js/cowork.js together
// and reproduces the S7 measurement exactly: strip shows write one, Cowork
// takes write two, and the pill is asked what it now says.
// ────────────────────────────────────────────────────────────────────────
describe('layer 4 · S7 as measured, with the real Cowork page', () => {
  let CW;
  const ROWS = {};          // every row the DETAIL endpoint can serve
  let LIST = [];            // …and the strictly smaller set the LEDGER lists

  /* LIST is separate from ROWS and that is load-bearing, not tidiness. The
   * engine's 5s sweep reads the same list endpoint Cowork's rail does, and
   * ingest dedupes on payloadId:state — so a row visible in the list is a row
   * the poller may ingest first, silently turning the test's own
   * LW.ingest(...) into a no-op that reports nothing. A write under test must
   * not be in the list. */

  function row(id, title) {
    return {
      id, status: 'applied', title, summary: title,
      apply_summary: title, emitting_agent_key: 'scribe',
      created_at: '2026-08-17T10:00:00Z', applied_at: '2026-08-17T10:00:00Z',
      activity_at: '2026-08-17T10:00:00Z',
      apply_changeset: [{
        entity_type: 'lead', id: 'lead_' + id,
        before: { id: 'lead_' + id, title: 'Fairways', status: 'new' },
        after: { id: 'lead_' + id, title: 'Fairways', status: 'quoted' }
      }],
      targets: [{ entity_type: 'lead', id: 'lead_' + id }]
    };
  }

  function bootBoth() {
    jest.resetModules();
    delete window.p86LiveWriter;
    delete window.p86LiveWriterModel;
    delete window.p86Cowork;
    document.body.innerHTML = '<div id="cowork" class="tab-content"><div id="coworkHost"></div></div>';
    jest.clearAllTimers();
    // URL-aware, because Cowork's ledger and the engine's detail fetch have
    // different shapes and a single canned body would exercise neither.
    global.fetch = jest.fn((url) => {
      const u = String(url);
      const m = u.match(/\/api\/payloads\/([^/?]+)$/);
      if (m && ROWS[m[1]]) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: ROWS[m[1]] }) });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: LIST.slice() }) });
    });
    global.localStorage = { getItem: () => null, setItem: () => {} };
    require('../js/live-writer-model.js');
    require('../js/live-writer.js');
    require('../js/cowork.js');
    LW = window.p86LiveWriter;
    CW = window.p86Cowork;
    M = LW.model;
    M.setDev(true);
    CW.render();                       // mounts the shell, registers surface A
  }

  const active = (on) => document.getElementById('cowork').classList[on ? 'add' : 'remove']('active');
  const pill = () => document.querySelector('#p86-live-writer .p86lw-pilltext');
  const pillDot = () => document.querySelector('#p86-live-writer .p86lw-pill .p86lw-dot');
  /* Cowork's document arrives through TWO awaits (the ledger page, then the
   * per-row detail) behind a setTimeout(0). Draining a fixed number of ticks
   * is the only honest way to reach the painted state under fake timers —
   * asserting before it lands would test the loading placeholder. */
  async function settle() {
    for (let i = 0; i < 8; i++) { await jest.advanceTimersByTimeAsync(1); }
  }

  test('the strip pill does not outlive a write Cowork claimed — S7', async () => {
    ROWS.w1 = row('w1', 'Set Base group scope on Uptown');
    ROWS.w2 = row('w2', 'Add Jason Mesick to BH — Promenade at Uptown');
    LIST = [];                      // both writes arrive by ingest, not by sweep
    bootBoth();

    // WRITE ONE, with Cowork inactive → the strip reports it.
    active(false);
    LW.ingest(ROWS.w1.apply_changeset, {
      payloadId: 'w1', state: 'applied', title: ROWS.w1.title, emittingAgentKey: 'scribe'
    });
    const r1 = LW.model.describe({
      changeset: ROWS.w1.apply_changeset, groups: LW.diff(ROWS.w1.apply_changeset),
      meta: { payloadId: 'w1', state: 'applied', title: ROWS.w1.title, emittingAgentKey: 'scribe' }
    }, {});
    expect(pill().textContent).toBe(r1.pillText);
    expect(pill().textContent).not.toBe('Live Writer');

    // WRITE TWO, with Cowork active → Cowork claims it and the strip is not
    // touched by anything. On the round-3 build this is where the pill went on
    // reading "Scribe wrote · 3 edited" for the rest of the session.
    active(true);
    LW.ingest(ROWS.w2.apply_changeset, {
      payloadId: 'w2', state: 'applied', title: ROWS.w2.title, emittingAgentKey: 'scribe'
    });

    expect(pill().textContent).toBe('Live Writer');
    expect(sameColor(pillDot().style.background, GREY)).toBe(true);
    // The card is still there, still about write one, and says so.
    const card = document.querySelector('#p86-live-writer .p86lw-card');
    expect(card).not.toBeNull();
    expect(card.textContent).toContain(STALE_MARK);
  });

  test('a PINNED Cowork document is stamped, never cleared, when a write lands elsewhere', async () => {
    ROWS.w1 = row('w1', 'Set Base group scope on Uptown');
    ROWS.w2 = row('w2', 'Add Jason Mesick to BH — Promenade at Uptown');
    // w1 IS listed — Cowork needs a rail row to pin to. w2 is not, or the 5s
    // sweep would ingest it first and the explicit ingest below would dedupe
    // to nothing, reporting no write and superseding no one.
    LIST = [ROWS.w1];
    bootBoth();
    active(true);
    await settle();

    // The user picks write one BY HAND — that is the pin.
    CW.open('w1');
    await settle();
    const doc = document.getElementById('cw-doc');
    expect(doc.textContent).toContain('Set Base group scope on Uptown');
    expect(doc.querySelector('.cw-stale')).toBeNull();

    // Write two lands. The pin must survive — that is the feature.
    LW.ingest(ROWS.w2.apply_changeset, {
      payloadId: 'w2', state: 'applied', title: ROWS.w2.title, emittingAgentKey: 'scribe'
    });
    await settle();

    expect(doc.textContent).toContain('Set Base group scope on Uptown');   // not yanked
    expect(doc.querySelector('.cw-stale')).not.toBeNull();                 // and not passed off as latest
    expect(doc.textContent).toContain(STALE_MARK);
  }, 20000);

  /* THE ROUND-5 MEASUREMENT, both halves, against the real js/cowork.js.
   *
   * Layer 3b proves it against surface SHAPES. This proves it against the
   * actual file whose `claims` never reads entry.meta.state and whose render()
   * returns undefined on every branch — the two facts round 4 had to trust and
   * which are no longer load-bearing. */
  test('CASE 1 / CASE 2 · a rejected row destroys no drafting card, ON or OFF Cowork', async () => {
    ROWS.rej = Object.assign(row('rej', 'A draft someone dismissed'),
      { status: 'rejected', apply_changeset: null, applied_at: null });
    LIST = [];
    for (const onCowork of [false, true]) {
      bootBoth();
      active(onCowork);
      await settle();

      LW.startComposing('drafting your change', {});
      const card = LW.model.describe({}, { composing: { label: 'drafting your change', viaScribe: true } });
      const where = onCowork ? 'CASE 2 (on Cowork)' : 'CASE 1 (off Cowork)';
      expect([where, pill().textContent]).toEqual([where, card.pillText]);

      // The measured event: an unrelated dismissed draft is ingested. Off
      // Cowork this always survived; on Cowork the whole strip was removed.
      LW.ingest([], {
        payloadId: 'pl_1784314336678_l5rn453j', state: 'rejected',
        title: 'A draft someone dismissed', emittingAgentKey: 'scribe'
      });
      await settle();

      expect([where, !!document.getElementById('p86-live-writer')]).toEqual([where, true]);
      expect([where, pill().textContent]).toEqual([where, card.pillText]);
      // …and the rejection never became the subject of anything.
      expect([where, LW.writes.current()]).toEqual([where, 0]);
      expect([where, LW.writes.subject()]).toEqual([where, null]);
    }
  }, 20000);

  test('a pinned document is never told a REJECTION superseded it', async () => {
    // The second, worse form: subject() held a rejected payload id while the
    // document read "A newer write has landed since. This is the one you
    // picked — it is not the latest." Nothing had landed.
    ROWS.w1 = row('w1', 'Set Base group scope on Uptown');
    LIST = [ROWS.w1];
    bootBoth();
    active(true);
    await settle();

    CW.open('w1');
    await settle();
    const doc = document.getElementById('cw-doc');
    expect(doc.textContent).toContain('Set Base group scope on Uptown');
    expect(doc.querySelector('.cw-stale')).toBeNull();

    LW.ingest([], {
      payloadId: 'pl_1784314336678_l5rn453j', state: 'rejected',
      title: 'A draft someone dismissed', emittingAgentKey: 'scribe'
    });
    await settle();

    expect(doc.querySelector('.cw-stale')).toBeNull();          // no false staleness
    expect(LW.writes.subject()).not.toBe('pl_1784314336678_l5rn453j');
    expect(LW.model.supersedesOnScreen({ meta: { payloadId: 'pl_1784314336678_l5rn453j', state: 'rejected' } })).toBe(false);
  }, 20000);

  /* ROUND 6, MEASURED — the same document, the same sentence, and the three
   * rows round 5's single predicate let through. Each of these was confirmed
   * live on 2fa18b79 against a real pinned Cowork document. */
  [
    ['a rolled-back DRAFT', { payloadId: 'pl_NINTH_proposed', state: 'proposed', isDraft: true,
                              title: 'A draft that was rolled back' }],
    ['a REFUSAL the Scribe never authored', { payloadId: 'pl_NINTH_refusal', state: 'failed',
                              neverDrafted: true, title: 'The Scribe never authored a payload',
                              applyError: 'The Scribe did not produce a usable change.' }],
    ['an APPLYING row still in flight', { payloadId: 'pl_NINTH_applying', state: 'applying',
                              title: 'Still committing' }]
  ].forEach(([label, meta]) => {
    test('a pinned document is not told ' + label + ' landed', async () => {
      ROWS.w1 = row('w1', 'Set Base group scope on Uptown');
      LIST = [ROWS.w1];
      bootBoth();
      active(true);
      await settle();

      CW.open('w1');
      await settle();
      const doc = document.getElementById('cw-doc');
      expect(doc.querySelector('.cw-stale')).toBeNull();

      LW.ingest([], Object.assign({ emittingAgentKey: 'scribe' }, meta));
      await settle();

      // It IS superseded — something newer happened and a pinned document must
      // not read as the latest. That half was never in question.
      const mark = doc.querySelector('.cw-stale');
      expect(mark).not.toBeNull();
      // …but nothing LANDED, so it must not say one did. This is the exact
      // sentence measured under a pinned document about a write that did not
      // happen.
      expect(mark.textContent).not.toContain(STALE_MARK);
      expect(mark.textContent).toContain(STALE_ACTIVITY);
      // And the ledger agrees: a moment, not a landing.
      expect(LW.writes.subject()).toBe(meta.payloadId);
      expect(LW.writes.landed()).toBeNull();
      expect(LW.writes.current()).toBe(0);
    }, 20000);
  });

  test('an unreadable APPLIED row reaches the ledger — the fourth form', async () => {
    /* MEASURED by 500-ing one real applied row's detail fetch: the strip read
     * "Scribe wrote something this view could not read" — truthful, a write
     * DID land — while gen stayed 0, subject() stayed null and the pinned
     * document went on reading as the latest. Two surfaces on one screen
     * disagreeing about whether a write landed, through the one report path
     * that skipped the fan-out. */
    ROWS.w1 = row('w1', 'Set Base group scope on Uptown');
    LIST = [ROWS.w1];
    bootBoth();
    active(true);
    await settle();
    CW.open('w1');
    await settle();
    const doc = document.getElementById('cw-doc');
    expect(doc.querySelector('.cw-stale')).toBeNull();

    // A second applied row whose DETAIL fetch is permanently broken.
    const broken = row('w2', 'A write nobody can read');
    global.fetch.mockImplementation((url) => {
      const u = String(url);
      if (/\/api\/payloads\/w2$/.test(u)) return Promise.resolve({ ok: false, status: 500 });
      const m = u.match(/\/api\/payloads\/([^/?]+)$/);
      if (m && ROWS[m[1]]) return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: ROWS[m[1]] }) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: LIST.slice() }) });
    });
    const warn = console.warn;
    console.warn = () => {};                 // the bounded retry warns once per attempt
    try { for (let i = 0; i < 3; i++) { await LW.ingestRow(broken); } }
    finally { console.warn = warn; }
    await settle();

    // The write landed and this view could not read it. Both facts, on every
    // surface, or the two disagree again.
    expect(LW.writes.landed()).toBe('w2');
    expect(LW.writes.subject()).toBe('w2');
    expect(LW.writes.current()).toBe(1);
    const mark = doc.querySelector('.cw-stale');
    expect(mark).not.toBeNull();
    expect(mark.textContent).toContain(STALE_MARK);
  }, 20000);

  test('surface C is not a claimant — a row flash survives any number of writes', () => {
    // C paints a row background for 1.8s and says nothing about which write is
    // latest. Making it a claimant would mean a second write cancelling the
    // highlight on the first write's rows, which is information loss for no
    // honesty gain.
    ROWS.w1 = row('w1', 'One');
    LIST = [];
    bootBoth();
    expect(LW.writes._claimants()).toEqual(expect.arrayContaining(['strip', 'pane', 'cowork-doc']));
    expect(LW.writes._claimants()).not.toContain('editor-flash');
  });
});

// ────────────────────────────────────────────────────────────────────────
// LAYER 5 — THE MATRIX.
//
// Six rounds, six fixes, six times the general form left standing. Each round
// enumerated the thing that had just bitten — call sites (2), async
// continuations (3), regions (4), mountings (5), the two questions one
// predicate was answering (6) — fixed exactly that, and verified against
// exactly that.
//
// Round 6 built a matrix over rows × mountings × paths and shipped it. An
// independent read then found the matrix a dimension and a half short of what
// it claimed. NONE of the shortfalls were behaviour defects — every triple
// probed outside the grid behaved correctly. They were places the grid could
// not look, which is a different and worse thing than a bug:
//
//   · the PATH axis was ['broadcast','unreadable','composing','backstop'] —
//     exactly the four routes that had already bitten — under a heading
//     claiming "every route by which anything can reach the strip or the
//     ledger". flashEditorRows(), Cowork's rail click, the strip's own deep
//     link and the two teardowns were all outside it.
//   · the MOUNTING axis was three engine-level stand-ins. The real surface C —
//     which registers at order 10, is NON-exclusive, joins claimedBy, and
//     paints rows the fan-out never draws — was not a dimension at all, so the
//     participant list ['editor-flash','cowork'] was unreachable.
//   · the ROW axis PAIRED each state with one changeset shape by hand, so
//     `estimate` existed only under `applied` and `unknown-state` only with a
//     lead changeset. `unknown-state` with an empty changeset — the exact arm
//     round 5's defect lived in — was not a cell.
//   · and the PAINT PROBE asked the fan-out whether a surface had painted.
//
// The last one is the one that decided whether any of the cells meant
// anything, so it is fixed first and it is described where it lives, below.
//
// WHAT THIS LAYER ASSERTS OVER, all four axes enumerated from source:
//
//   ROWS      STATE × CHANGESET SHAPE, crossed — states read off stateOf(),
//             metaFromRow() and the public API; shapes read off diffChangeset
//             and describe()'s arbitration.
//   MOUNTINGS every subset of four surface shapes, two of which are the REAL
//             js/cowork.js and the REAL surface C, × Cowork active × pinned.
//   PATHS     every route that puts something on screen about a write,
//             enumerated by grep WITH COUNTS.
//   PROBE     the DOM, and nothing that the fan-out produced.
//
// NINE invariants, not six: modelling the two browse paths and the two
// teardowns made three sentences assertable that previously had nowhere to
// live (I7 surface C's provenance, I8 a browsed row's honesty, I9 the
// placeholder's survival).
//
// Per-path and per-invariant coverage are stated as numbers at the bottom of
// this layer and asserted EXACTLY, so "we covered it" is arithmetic rather
// than felt — including the invariants that only fire in a fraction of cells,
// which are named with their fraction rather than folded into one headline
// count.
//
// THE ACCEPTANCE TEST THIS LAYER WAS BUILT AGAINST. A matrix is only worth the
// bypass it catches, so nine deliberate bypasses were injected one at a time,
// each one a plausible edit rather than a strawman, and each was confirmed to
// turn this test red:
//
//   a new unregistered container, skipping the seam        → I5 (elsewhere)
//   painting ONLY Cowork's document, never the strip       → I5 (cowork-doc)
//   surface C tinting a row nothing armed                  → I7
//   the rail click dropping its staleness stamp            → I8
//   the deep link painting the document itself             → I8
//   dismiss() reporting the teardown as a write            → I1
//   startComposing() claiming a write                      → I1
//   clearComposing() left as a no-op                       → I9
//   noticeUnreadable() painting the strip directly
//     (round 5's ninth defect, verbatim)                   → I5 (strip)
//
// The second of those is the one that mattered: re-run against round 6's
// evidence — the strip's text and an array the fan-out filled in — I5 does not
// fire on it at all.
// ────────────────────────────────────────────────────────────────────────

/* ── THE PAINT PROBE — the evidence, and why it is not the fan-out's ─────
 *
 * Round 6's probe was
 *
 *     stripText().indexOf(token) >= 0 || coworkSaw.indexOf(token) >= 0
 *
 * and `coworkSaw` was pushed BY THE FAN-OUT calling Cowork's render. Half the
 * evidence for "did anything paint this?" was manufactured by the mechanism
 * under test: a route that painted Cowork's document without going through the
 * seam left no trace in it, so the probe could only ever witness paints the
 * fan-out already knew about. Its own comment claimed "a path added next round
 * that skips the seam fails HERE", which was true only for a bypass that
 * happened to paint surface B. Structurally that is round 2's "every path that
 * fills this card calls setPill" — literally true, and blind to the thing it
 * exists to catch.
 *
 * This probe reads the DOM and nothing else. It does NOT enumerate containers:
 * it scans the whole <body>, so a route added next round that invents its own
 * region is seen without anyone remembering to add it here. The named regions
 * below exist only to make a failure legible; `elsewhere` is the bucket that
 * catches a container this file has never heard of.
 *
 * Two kinds of evidence, because surfaces leave two kinds of mark:
 *
 *   TEXT   the row's token — its own title — which reaches the strip through
 *          the op list's group name, a notice's record name, Cowork's rail and
 *          Cowork's document.
 *   CLASS  surface C paints no text whatsoever. It tints a row. So the flash
 *          class is looked for directly, or C would be invisible to a text
 *          probe and its whole path would read as "painted nothing".
 *
 * The one thing that makes this work: NOTHING THE HARNESS ITSELF WRITES
 * CONTAINS A TOKEN. The estimate-editor scaffold is built from fixed line
 * descriptions and Cowork's shell is empty markup, so any token anywhere in
 * the document was put there by a surface. */
const MX_FLASH_SEL = '.p86lw-flash-add, .p86lw-flash-edit';
const MX_REGIONS = [
  ['strip', 'p86-live-writer'],
  ['pane', 'p86-live-pane'],
  ['cowork-doc', 'cw-doc'],
  ['cowork-rail', 'cw-ledger-body']
];
function paintRegions(token) {
  const hit = [];
  let known = false;
  MX_REGIONS.forEach(([name, id]) => {
    const el = document.getElementById(id);
    if (el && el.textContent.indexOf(token) >= 0) { hit.push(name); known = true; }
  });
  const body = document.body ? document.body.textContent : '';
  // The whole point of the probe. A paint into a container nobody enumerated
  // still counts, and says so by name.
  if (!known && body.indexOf(token) >= 0) hit.push('elsewhere');
  if (document.querySelector(MX_FLASH_SEL)) hit.push('flash');
  return hit;
}

/* ── the ROW dimension: STATE × CHANGESET SHAPE, CROSSED ────────────────
 *
 * Round 6 wrote fifteen rows out by hand and, in doing so, PAIRED each state
 * with one changeset shape: `estimate` appeared only under `applied`,
 * `unlistable` only under `applied`, `unknown-state` only with a lead
 * changeset. So `unknown-state` with an empty changeset — describe()'s silent
 * arm, which is exactly where round 5's defect lived — was not a cell, and
 * neither were the other seventeen combinations. A hand-written list is a set
 * discovered by measurement wearing a table's clothes. The two axes cross.
 *
 * STATES, read off the code: stateOf() maps five statuses onto five states and
 * returns null for anything else; metaFromRow() adds neverDrafted; and the
 * public API can produce two more that no poller ever will — a row with no
 * payloadId, and a state this codebase has never heard of.
 *
 * `supersedes` and `landed` are the ANSWERS, written down by hand from what is
 * true of the STATE — never read from the model, or this table would agree
 * with any implementation including the broken one. Writing them once per
 * state rather than once per row is itself an assertion, and the one the
 * crossing exists to make: THE CHANGESET SHAPE CANNOT CHANGE WHETHER A WRITE
 * LANDED. Round 6's table could not state that, because it never had one state
 * under two shapes. */
const MX_STATES = [
  // key             state        never  anon   supersedes  landed  viaPoller
  ['applied',       'applied',    false, false, true,       true,   true],
  ['applying',      'applying',   false, false, true,       false,  true],
  ['proposed',      'proposed',   false, false, true,       false,  true],
  ['failed',        'failed',     false, false, true,       false,  true],
  ['refusal',       'failed',     true,  false, true,       false,  true],
  ['rejected',      'rejected',   false, false, false,      false,  true],
  ['unknown-state', 'queued',     false, false, true,       false,  false],
  ['unidentified',  'applied',    false, true,  false,      false,  false]
].map(([key, state, never, anon, supersedes, landed, viaPoller]) => ({
  key: key, state: state, neverDrafted: never, anonymous: anon,
  supersedes: supersedes, landed: landed,
  // Can a real /api/payloads row carry this state? Two cannot: stateOf()
  // returns null for an unrecognised status (the row is dropped before any
  // fetch) and every list row has an id. They exist because the PUBLIC API can
  // produce them, and they are excluded BY NAME from the poller-fed paths.
  viaPoller: viaPoller
}));

/* CHANGESET SHAPES — the four the differ can be handed, read off
 * diffChangeset() and describe()'s pane/op arbitration. */
const MX_CS_KINDS = ['lead', 'estimate', 'unlistable', 'none'];

const ROW_KINDS = [];
MX_STATES.forEach((s) => MX_CS_KINDS.forEach((cs) => {
  const n = String(ROW_KINDS.length).padStart(2, '0');
  ROW_KINDS.push({
    key: s.key + '/' + cs,
    state: s.state, cs: cs,
    supersedes: s.supersedes, landed: s.landed,
    neverDrafted: s.neverDrafted, anonymous: s.anonymous, viaPoller: s.viaPoller,
    noRow: false,
    id: s.anonymous ? null : ('ID-' + n),
    /* A token unique to this row that appears wherever the row is DRAWN — it
     * is the entity's own title, so it reaches the strip through the op list's
     * group name, through a notice's record name, and through Cowork's rail
     * and document. FIXED WIDTH on purpose: the probe uses indexOf, and
     * 'TOKEN1' would match inside 'TOKEN12'. */
    token: 'TOKEN' + n
  });
}));
// The row-less paths carry nothing at all. It is a member of this dimension so
// the rectangle stays a rectangle and the masks exclude it BY NAME rather than
// by silence. Its token is one no surface can ever paint.
ROW_KINDS.push({
  key: 'no-row', state: null, cs: 'none', supersedes: false, landed: false,
  neverDrafted: false, anonymous: false, viaPoller: false, noRow: true,
  id: null, token: 'TOKEN-NEVER-DRAWN'
});

const MX_CS = {
  lead: (tok) => [{
    entity_type: 'lead', id: 'lead_' + tok,
    before: { id: 'lead_' + tok, title: tok, status: 'new' },
    after: { id: 'lead_' + tok, title: tok, status: 'quoted' }
  }],
  estimate: (tok) => [{
    entity_type: 'estimate', id: 'est_' + tok,
    before: { id: 'est_' + tok, title: tok, data: { lines: [L('l1', 'Framing', 10, 100)] } },
    after: { id: 'est_' + tok, title: tok, data: { lines: [L('l1', 'Framing', 12, 100), L('l2', 'Paint', 1, 10)] } }
  }],
  // A changeset that EXISTS and breaks into no listable ops — the applied-
  // degraded arm, which is a different fact from "no changeset at all".
  unlistable: (tok) => [{ entity_type: 'schedule', id: 'sch_' + tok, before: { id: 'sch_' + tok }, after: { id: 'sch_' + tok } }],
  none: () => []
};

const mxMeta = (k) => ({
  payloadId: k.anonymous ? null : k.id,
  state: k.state, title: k.token, summary: k.token,
  emittingAgentKey: 'scribe',
  isDraft: k.state !== 'applied',
  neverDrafted: k.neverDrafted,
  applyError: k.state === 'failed' ? 'Unresolved ref $new_id:line_2' : null,
  createdAt: '2026-08-17T10:00:00Z'
});

/* The list row noticeUnreadable is reached with. status, not state — this is
 * what /api/payloads/ actually serves — and no changeset, because the whole
 * premise of that path is that the detail could not be read. */
const MX_STATUS = { applied: 'applied', applying: 'applying', failed: 'failed', proposed: 'ready', rejected: 'rejected' };
const mxListRow = (k) => {
  const r = {
    id: k.id, status: MX_STATUS[k.state], title: k.token, summary: k.token,
    created_at: '2026-08-17T10:00:00Z', applied_at: '2026-08-17T10:00:00Z',
    activity_at: '2026-08-17T10:00:00Z'
  };
  if (k.neverDrafted) r.targets = [];      // the refusal's own evidence
  return r;
};

/* …and the DETAIL row GET /api/payloads/:id serves, which is what the real
 * js/cowork.js renders its document from. Separate from the list row because
 * the two really are different shapes — the list is lean and carries no
 * changeset, which is the whole reason noticeUnreadable exists — and because
 * a document painted from a row with no changeset would paint no token and
 * make the probe read "nothing was drawn". */
const mxDetailRow = (k) => {
  const r = Object.assign(mxListRow(k), {
    emitting_agent_key: 'scribe',
    apply_summary: k.token,
    targets: k.neverDrafted ? [] : [{ entity_type: 'lead', id: 'ent_' + k.token }]
  });
  const cs = MX_CS[k.cs](k.token);
  // An APPLIED row's document comes from apply_changeset; everything else's
  // from draft_changeset. cowork.js refuses to fall back between them, so
  // putting the changeset on the wrong column would silently paint the "no
  // before/after recorded" arm for every cell.
  if (k.state === 'applied') r.apply_changeset = cs;
  else r.draft_changeset = cs;
  return r;
};

/* ── the PATH dimension, ENUMERATED FROM SOURCE ─────────────────────────
 *
 * Round 6's axis was ['broadcast','unreadable','composing','backstop'] — the
 * four routes that had already bitten — under a heading claiming "every route
 * by which anything can reach the strip or the ledger". The narrower claim
 * those four CAN back is the one in js/live-writer.js's own header, and it is
 * true: grepped at HEAD,
 *
 *     reportToStrip(…)        3 call sites   live-writer.js 1219, 1237, 1389
 *     WRITES.report(…)        1 call site    live-writer.js 543
 *
 * and nothing else in either file reaches them. But that is a claim about two
 * FUNCTION NAMES, and the property the user cares about is about anything that
 * PUTS SOMETHING ON SCREEN ABOUT A WRITE. Grepping for that instead:
 *
 *     flashEditorRows(…)      1 definition   live-writer.js 1485
 *                             1 export       live-writer.js 1847
 *                             1 caller       estimate-editor.js 3619
 *     selectRow(…)            5 call sites   cowork.js 255 (rail click),
 *                                            344 (first ledger page),
 *                                            767 (after approve/reject),
 *                                            813 (from the fan-out),
 *                                            854 (the deep link)
 *     p86Cowork.open(…)       2 callers      live-writer.js 965 (the strip's
 *                                            own "Open in Cowork" button),
 *                                            agent-tasks.js 298
 *     dismiss / clearComposing
 *                             teardown; both exported, neither tells the ledger
 *
 * Folding the ones that are the same route counted twice, that is NINE routes,
 * and all nine are members of this axis. Each is DRIVEN — the cell performs
 * it — never merely asserted about.
 *
 * `userAsked` is the one distinction that cannot be read off the engine and
 * must not be: it says whether THE HARNESS just simulated a user action. A
 * document the user opened from the rail is not an announcement, and holding
 * it to "the fan-out must have seen this" would be asserting that browsing
 * history is a write. It is the test recording what it itself did, which is
 * exactly the kind of evidence the paint probe above is allowed to use — the
 * kind the fan-out did not produce. */
const MX_PATHS = [
  {
    key: 'broadcast', userAsked: false,
    rows: (k) => !k.noRow, mounts: () => true,
    why: 'ingest() → the fan-out seam. THE only caller of WRITES.report, reached from the ' +
         'p86:payload-applied event and from the 5s sweep. Surface B\'s own render() is a ' +
         'reportToStrip call site and lives inside this one.'
  },
  {
    key: 'unreadable', userAsked: false,
    rows: (k) => !k.noRow && k.viaPoller && k.cs === 'none', mounts: () => true,
    why: 'ingestRow\'s exhausted detail retry. Round 5 shipped it calling reportToStrip DIRECTLY, ' +
         'so it painted a surface without ever reaching the ledger; it is still a separate path ' +
         'precisely BECAUSE it used to be one. Reachable only for the five statuses stateOf() ' +
         'recognises — a row it does not is dropped before the fetch — and only with an empty ' +
         'changeset, since an unreadable detail is exactly the case where there is none to carry.'
  },
  {
    key: 'composing', userAsked: false,
    rows: (k) => k.noRow, mounts: () => true,
    why: 'the handoff placeholder, reported BEFORE any row exists. There is nothing to vary.'
  },
  {
    key: 'backstop', userAsked: false,
    rows: (k) => k.noRow, mounts: () => true,
    why: 'the 180s "nothing came back" notice. A statement that nothing came back is not a ' +
         'statement about a row.'
  },
  {
    key: 'flash', userAsked: false,
    rows: (k) => !k.noRow, mounts: () => true,
    why: 'surface C\'s ACTUAL paint. The broadcast only ARMS it; the paint fires later, from the ' +
         'estimate editor\'s post-hydrate refresh, through the exported flashEditorRows() — ' +
         'entirely outside the fan-out and callable from any other file. Every mounting is kept, ' +
         'including the ones with no editor: "it paints nothing when there is no editor" is the ' +
         'other half of the property and it is worth a cell.'
  },
  {
    key: 'cowork-select', userAsked: true,
    rows: (k) => !k.noRow && k.viaPoller,
    mounts: (mt) => mt.mounts.indexOf('cowork') >= 0 && mt.active,
    why: 'a rail click — cowork.js:255 → selectRow(id, true). It paints a document about a write ' +
         'with no fan-out involvement whatsoever. Rows: only the ones a real ledger row can carry. ' +
         'Mountings: only where Cowork exists AND is the page on screen, because a rail nobody can ' +
         'see is a rail nobody clicks.'
  },
  {
    key: 'cowork-open', userAsked: true,
    rows: (k) => !k.noRow && k.viaPoller,
    mounts: (mt) => mt.mounts.indexOf('cowork') >= 0 && mt.active,
    why: 'the strip\'s own deep link — live-writer.js:965 → p86Cowork.open(id) → cowork.js:854. ' +
         'Same masking as the rail click, and a separate path rather than a duplicate of it ' +
         'because it is a separate entry point that a change to open() alone can break.'
  },
  {
    key: 'dismiss', userAsked: false,
    rows: (k) => !k.noRow, mounts: () => true,
    why: 'the row is broadcast, then the user closes the card. dismiss() tears the strip down and ' +
         'tells the ledger nothing — which is CORRECT, and the property is that it stays that way: ' +
         'a pinned Cowork document must not lose its stamp because someone shut a card.'
  },
  {
    key: 'composing-then-row', userAsked: false,
    rows: (k) => !k.noRow, mounts: () => true,
    why: 'the placeholder is up and the row lands underneath it — clearComposing()\'s only real ' +
         'trigger, and the transition round 5\'s defect lived in: a dismissed draft destroying an ' +
         'unrelated drafting card.'
  }
];
const MX_PATH = {};
MX_PATHS.forEach((p) => { MX_PATH[p.key] = p; });

/* The handoff placeholder's own claim, taken from the model rather than
 * spelled out here, so a copy edit cannot silently make I9 unfalsifiable. */
const MX_COMPOSING = MODEL.describe({}, { composing: { label: 'drafting your change', viaScribe: true } });

/* ── COVERAGE, AS A NUMBER PER INVARIANT ────────────────────────────────
 *
 * Round 6's headline was "704 cells × six invariants". One of those six — the
 * one that checks THE SENTENCE THE USER ACTUALLY READS on the strip — fired in
 * 12 of 704 cells. 1.7%. Everything it said was true; what it implied was not.
 *
 * So every invariant reports the number of cells it actually fired in, and
 * those numbers are asserted EXACTLY. Two things follow. The claim in this
 * file is checkable rather than remembered. And an edit that makes an
 * invariant stop firing — the way a matrix quietly goes vacuous while staying
 * green — fails here instead of shrinking the claim in silence. */
const MX_COVERAGE = (s) => ({
  cells: s.cells,
  'I1·I2·I3 · the ledger arithmetic': s.i1,
  'I4  · claimant stamps carry the ledger fact': s.i4,
  'I4b · the sentence on the STRIP': s.stripStamped,
  'I5  · paint provenance, DOM evidence': s.i5,
  'I6  · a pinned document keeps its row': s.i6,
  'I7  · a flash means the fan-out armed C': s.i7,
  'I8  · a browsed row says it is not the latest': s.i8,
  'I9  · the drafting card survives iff nothing superseded it': s.i9,
  '— writes that really landed': s.moved,
  '— rows that superseded without landing': s.newsWithoutLanding,
  '— supersede events observed': s.stamped,
  '— cells where a surface really painted': s.painted,
  '— cells where the real Cowork document painted': s.coworkDoc,
  '— cells where an UNKNOWN container painted': s.elsewhere,
  '— pinned documents really stamped': s.pinnedStamped
});

/* MEASURED. Not aspirational, and not rounded up.
 *
 *   invariant                                        cells    of 14592
 *   I1·I2·I3  the ledger arithmetic                  14592     100 %
 *   I4        claimant stamps carry the ledger fact   9184    62.9 %
 *   I4b       the sentence on the STRIP               1104     7.6 %
 *   I5        paint provenance, DOM evidence          6600    45.2 %
 *   I6        a pinned document keeps its row         2176    14.9 %
 *   I7        a flash means the fan-out armed C         96     0.7 %
 *   I8        a browsed row says it is not latest     1536    10.5 %
 *   I9        the drafting card survives iff …        1600    11.0 %
 *
 * READ THAT HONESTLY. Five of these are minority invariants and two are
 * small, and the reasons are properties of the feature rather than gaps:
 *
 *   I4b fires only where the strip is HOLDING a card that somebody else's
 *       write supersedes — which needs Cowork to become the page AFTER the
 *       seed. That arrangement is now a mounting (activation: 'after-seed'),
 *       which took this from round 6's 12/704 (1.7%) to 1104/14592 (7.6%). It
 *       is still a minority and it will stay one: with Cowork off, the strip
 *       paints the write itself and is not stamped; with Cowork on from the
 *       start, the strip has no card to stamp.
 *   I6  fires only in the pinned × Cowork-on-screen mountings, by definition.
 *   I7  fires in 96 cells because there are exactly two rows a flash can be
 *       about (an APPLIED write to the estimate the editor has open, with and
 *       without a payloadId) × the 48 mountings that have an editor. 96 is the
 *       whole reachable set, not a sample of it.
 *   I8  fires only on the two browse paths, which is where browsing happens.
 *   I9  fires only where the placeholder is still what the strip shows when
 *       the row arrives — i.e. where some OTHER surface took the row. Where
 *       surface B renders it, the strip is legitimately repainted with the
 *       row's own card and there is no placeholder question to answer.
 *
 * The counts are asserted EXACTLY rather than as lower bounds. An edit that
 * makes an invariant stop firing — the way a matrix quietly goes vacuous while
 * staying green — fails here instead of shrinking the claim in silence. */
const MX_COVERAGE_EXPECTED = {
  cells: 14592,
  'I1·I2·I3 · the ledger arithmetic': 14592,
  'I4  · claimant stamps carry the ledger fact': 9184,
  'I4b · the sentence on the STRIP': 1104,
  'I5  · paint provenance, DOM evidence': 6600,
  'I6  · a pinned document keeps its row': 2176,
  'I7  · a flash means the fan-out armed C': 96,
  'I8  · a browsed row says it is not the latest': 1536,
  'I9  · the drafting card survives iff nothing superseded it': 1600,
  '— writes that really landed': 1632,
  '— rows that superseded without landing': 7552,
  '— supersede events observed': 9184,
  '— cells where a surface really painted': 8136,
  '— cells where the real Cowork document painted': 3328,
  // ZERO, and it must stay zero on a correct build: `elsewhere` is the probe's
  // catch-all for a token painted into a container this file has never heard
  // of. It is the counter that goes non-zero the day somebody adds a surface
  // and forgets the seam — and the one an injected bypass lights up.
  '— cells where an UNKNOWN container painted': 0,
  '— pinned documents really stamped': 1616
};

describe('layer 5 · THE MATRIX — every currency property, every row, every mounting, every path', () => {
  const SEED = 'A0';                      // a real applied write, fired first in every cell
  const SEED_TITLE = 'Stamp the lead';    // …and the text its document paints
  let seen, superseded;
  let hasCowork = false, hasEditor = false;
  // The fixture the URL-aware fetch below serves. LIST is what the LEDGER
  // lists; ROWS is what the DETAIL endpoint can serve; BROKEN is the set whose
  // detail 500s. They are three sets and not one because a row visible in the
  // list is a row the 5s sweep may ingest FIRST, silently turning the drive's
  // own ingest into a dedupe no-op that reports nothing.
  let MX_ROWS = {}, MX_LIST = [], MX_BROKEN = {};

  const mxSeedRow = () => ({
    id: SEED, status: 'applied', title: SEED_TITLE, summary: SEED_TITLE,
    apply_summary: SEED_TITLE, emitting_agent_key: 'scribe',
    created_at: '2026-08-17T10:00:00Z', applied_at: '2026-08-17T10:00:00Z',
    activity_at: '2026-08-17T10:00:00Z',
    targets: [{ entity_type: 'lead', id: 'lead_0' }],
    apply_changeset: EVENTS.A(0).cs
  });

  /* Cowork's document arrives through TWO awaits (the ledger page, then the
   * per-row detail) behind a setTimeout(0), so a cell that asserted
   * synchronously would be testing the loading placeholder. Draining ticks is
   * the only honest way to reach the painted state under fake timers. The
   * count is halved when no real surface is mounted, because the whole cost of
   * this matrix is this loop times nine thousand cells. */
  const settle = async () => {
    // ONE timer advance — Cowork's deep link is the only setTimeout in any of
    // these chains — then microtask ticks, which is where the awaits live.
    // advanceTimersByTimeAsync does both at once and is roughly forty times
    // dearer per call; at nine thousand cells that is the difference between a
    // suite and an overnight job.
    jest.advanceTimersByTime(1);
    // Enough ticks for the deepest await chain in play: the 180s backstop
    // awaits a sweep, which awaits a fetch, which awaits its .json(); Cowork's
    // document awaits a ledger page and then a per-row detail behind a
    // setTimeout(0). Too few and a cell asserts against a loading placeholder,
    // which passes every "nothing moved" invariant for the wrong reason.
    const n = hasCowork ? 16 : 10;
    for (let i = 0; i < n; i++) await Promise.resolve();
  };

  /* Boot one cell. Unlike round 5's, this mounts the REAL js/cowork.js and the
   * REAL surface C rather than engine-level stand-ins — a stand-in can only
   * prove things about the engine, and both of the surfaces that matter live
   * in files of their own.
   *
   * The OBSERVER surface is round 6's and it stays: order 99 (after every real
   * surface), non-exclusive, and it DECLINES every row, so it adds nothing to
   * claimedBy and suppresses nothing. It records the fan-out's participant
   * list, which is the CLAIM under test — never the evidence. The evidence is
   * paintRegions(), which reads the DOM. */
  async function bootMx(mt, k, path) {
    jest.resetModules();
    delete window.p86LiveWriter;
    delete window.p86LiveWriterModel;
    delete window.p86Cowork;
    delete window.p86EstimateEditorCurrentId;
    jest.clearAllTimers();

    hasCowork = mt.mounts.indexOf('cowork') >= 0;
    hasEditor = mt.mounts.indexOf('editor') >= 0;

    MX_ROWS = {}; MX_LIST = []; MX_BROKEN = {};
    MX_ROWS[SEED] = mxSeedRow();
    MX_LIST = [MX_ROWS[SEED]];
    if (!k.noRow && k.id) {
      MX_ROWS[k.id] = mxDetailRow(k);
      // k joins the LIST only where a rail row is the thing being clicked.
      if (path.userAsked) MX_LIST = MX_LIST.concat([MX_ROWS[k.id]]);
    }

    /* The scaffold, built BEFORE the engine so the strip's own append does not
     * land in markup that is about to be replaced. Not one character of it
     * contains a token — that is what makes the paint probe evidence. */
    document.body.innerHTML =
      (hasCowork
        ? '<div id="cowork" class="tab-content' + (mt.activation === 'always' ? ' active' : '') + '">' +
          '<div id="coworkHost"></div></div>'
        : '') +
      (hasEditor
        ? '<div id="estimate-editor-view">' +
          '<div data-line-id="l1">Framing</div><div data-line-id="l2">Paint</div></div>'
        : '');
    if (hasEditor) {
      const view = document.getElementById('estimate-editor-view');
      // jsdom does no layout, so offsetParent is null for everything. The
      // engine uses it as its "is the editor actually on screen" probe.
      Object.defineProperty(view, 'offsetParent', { get: () => document.body, configurable: true });
      // Open on the very estimate this row changes, when this row changes one.
      // For every other changeset shape the editor is open on something else,
      // which is the arm where C must decline and B must keep the pane.
      window.p86EstimateEditorCurrentId = () => (k.cs === 'estimate' ? 'est_' + k.token : 'est_elsewhere');
    }

    global.fetch = jest.fn((url) => {
      const u = String(url);
      const m = u.match(/\/api\/payloads\/([^/?]+)$/);
      if (m) {
        if (MX_BROKEN[m[1]]) return Promise.resolve({ ok: false, status: 500 });
        if (MX_ROWS[m[1]]) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ payload: MX_ROWS[m[1]] }) });
        }
        return Promise.resolve({ ok: false, status: 404 });
      }
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: MX_LIST.slice() }) });
    });
    global.localStorage = { getItem: () => null, setItem: () => {} };
    require('../js/live-writer-model.js');
    require('../js/live-writer.js');
    LW = window.p86LiveWriter;
    M = (LW && LW.model) || window.p86LiveWriterModel;
    M.setDev(true);
    M.resetPaintLog();
    if (M.resetClaimLog) M.resetClaimLog();

    seen = []; superseded = [];
    if (hasCowork) {
      require('../js/cowork.js');
      window.p86Cowork.render();          // mounts the shell, registers the surface + claimant
    }
    if (mt.mounts.indexOf('decliner') >= 0) {
      LW.registerSurface({
        name: 'decliner', order: 15, exclusive: true,
        claims: () => true, render: () => null      // the honest decline
      });
    }
    if (mt.mounts.indexOf('stub') >= 0) {
      LW.registerSurface({
        name: 'stub', order: 25, exclusive: false,
        claims: () => true, render: () => {}        // the minimum a surface can be
      });
    }
    LW.registerSurface({
      name: '__observer', order: 99, exclusive: false,
      claims: () => true,
      render: (entry) => {
        seen.push({ token: (entry.meta || {}).title, by: (entry.claimedBy || []).slice() });
        return null;                      // declines: adds nothing, suppresses nothing
      }
    });
    LW.writes.register({
      name: '__observer-claimant', owner: '__nobody',
      supersede: (ev) => { superseded.push(ev); }
    });

    // A real landed write first, so gen / subject / landed() are all non-null
    // before the row under test arrives. A matrix run against a virgin ledger
    // would let "moves nothing" pass by accident.
    fire(EVENTS.A(0));
    await settle();
    // …and NOW the user walks over to Cowork. This is the S7 arrangement: the
    // strip is holding write one when write two is taken by somebody else.
    if (hasCowork && mt.activation === 'after-seed') {
      document.getElementById('cowork').classList.add('active');
      await settle();
    }
    // The pin is the user picking a row BY HAND, which is what open() does.
    if (mt.pinned && hasCowork && mt.active) { window.p86Cowork.open(SEED); await settle(); }
    seen = []; superseded = [];
    return ledger();
  }

  const ledger = () => ({ gen: LW.writes.current(), subject: LW.writes.subject(), landed: LW.writes.landed() });
  const staleText = () => { const m = document.querySelector('.p86lw-stale'); return m ? m.textContent : ''; };

  /* Fire one row down one path. Returns nothing — everything the assertions
   * need is read back off the DOM and the engine, never returned by the
   * driver. */
  async function drive(pathKey, k) {
    const send = () => LW.ingest(MX_CS[k.cs](k.token), mxMeta(k));
    if (pathKey === 'broadcast') { send(); await settle(); return; }
    if (pathKey === 'unreadable') {
      MX_BROKEN[k.id] = true;             // this row's DETAIL is permanently broken
      for (let i = 0; i < 3; i++) { await LW.ingestRow(mxListRow(k)); }   // MAX_DETAIL_RETRIES
      await settle();
      return;
    }
    if (pathKey === 'composing') { LW.startComposing('drafting your change', {}); await settle(); return; }
    if (pathKey === 'backstop') {
      LW.startComposing('drafting your change', {});
      jest.advanceTimersByTime(180100);
      await settle();
      return;
    }
    if (pathKey === 'flash') {
      send(); await settle();
      // The editor's post-hydrate refresh. Driven with NO argument as well as
      // with one, because estimate-editor.js:3619 passes its _currentId and
      // the export takes it as optional — both are real call shapes.
      LW.flashEditorRows(k.cs === 'estimate' ? 'est_' + k.token : undefined);
      await settle();
      return;
    }
    if (pathKey === 'cowork-select') {
      // The RAIL CLICK, through the delegated handler cowork.js installs —
      // not selectRow(), which is private and reaching it directly would be
      // this test inventing an entry point the app does not have.
      const el = document.querySelector('[data-cwrow="' + k.id + '"]');
      // A missing rail row is a fixture failure, not a passing cell.
      expect([k.key, 'the rail has a row to click', !!el]).toEqual([k.key, 'the rail has a row to click', true]);
      el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
      await settle();
      return;
    }
    if (pathKey === 'cowork-open') { window.p86Cowork.open(k.id); await settle(); return; }
    if (pathKey === 'dismiss') { send(); await settle(); LW.dismiss(); await settle(); return; }
    // composing-then-row: the placeholder is up when the row lands under it.
    LW.startComposing('drafting your change', {});
    send();
    await settle();
  }

  /* THE INVARIANTS. Every one of them is a sentence that has been false on a
   * shipped build at some point in this arc — except I7 and I8, which are the
   * sentences the two newly-modelled kinds of path make assertable at all.
   *
   * Each one increments its own counter, and the counters are asserted against
   * exact numbers at the bottom. That is the honest form of "704 cells × six
   * invariants": an invariant that fires in 1.7% of cells covers 1.7% of
   * cells, and the file says which. */
  function assertCell(where, k, path, mt, before, stats) {
    const after = ledger();
    const rec = seen.filter((r) => r.token === k.token).pop();
    const witnessed = !!(rec && rec.by.length);
    const news = k.supersedes && witnessed;
    const landed = k.landed && witnessed;
    if (landed) stats.moved++;
    if (news && !landed) stats.newsWithoutLanding++;

    // I1 · gen moves IFF a write landed.
    stats.i1++;
    expect([where, 'gen', after.gen]).toEqual([where, 'gen', before.gen + (landed ? 1 : 0)]);

    // I2 · subject() is the row just reported, or unchanged. Never a dismissal
    //      and never an unidentified row — there is one assignment to it and it
    //      sits below the news gate.
    expect([where, 'subject', after.subject]).toEqual([where, 'subject', news ? k.id : before.subject]);

    // I3 · landed() names only a row that actually changed data. This is the
    //      field the word "landed" in every stamp refers to.
    expect([where, 'landed()', after.landed]).toEqual([where, 'landed()', landed ? k.id : before.landed]);

    // I4 · NO SURFACE ASSERTS CURRENCY FOR A WRITE THAT DID NOT HAPPEN.
    //      Every supersession carries the ledger's own fact. The claimant that
    //      records these is registered with an owner NO surface ever reports
    //      under, so it steps down on every reported row rather than only on
    //      the ones a mounted Cowork happened to decline — which is why this
    //      now fires on every news cell instead of a corner of them.
    superseded.forEach((ev, i) => {
      expect([where, 'supersede[' + i + '].landed', !!ev.landed])
        .toEqual([where, 'supersede[' + i + '].landed', !!k.landed]);
      stats.stamped++;
    });
    if (superseded.length) stats.i4++;

    // I4b · …AND THE SENTENCE THE USER ACTUALLY READS FOLLOWS IT. This is the
    //       narrowest invariant in the file — the strip is only STAMPED when
    //       another surface took the write out from under it — so it is
    //       counted separately rather than folded into I4's headline.
    const stale = staleText();
    if (stale) {
      stats.stripStamped++;
      expect([where, 'strip stamp says a write landed', stale.indexOf(STALE_MARK) >= 0])
        .toEqual([where, 'strip stamp says a write landed', !!landed]);
      // …and if it does say so, a write really did land AFTER the one the card
      // is about, which is the seed.
      if (stale.indexOf(STALE_MARK) >= 0) {
        expect([where, 'a newer write really landed', after.landed])
          .not.toEqual([where, 'a newer write really landed', SEED]);
      }
    }

    /* ── the paint, read off the DOM ────────────────────────────────────── */
    const regions = paintRegions(k.token);
    const painted = regions.length > 0;
    if (painted) stats.painted++;
    // Counted per REGION, off the DOM, so "the real Cowork column really drew
    // rows in this matrix" is a measurement rather than an assumption. Round 6
    // counted this by asking the fan-out.
    if (regions.indexOf('cowork-doc') >= 0) stats.coworkDoc++;
    if (regions.indexOf('elsewhere') >= 0) stats.elsewhere++;
    const flashed = regions.indexOf('flash') >= 0;

    // I5 · THE APP DOES NOT TELL YOU ABOUT A WRITE BEHIND THE LEDGER'S BACK.
    //      If something the user did not ask for is on screen about row k,
    //      then the fan-out saw k; and if k landed, the ledger names it.
    //
    //      Round 6 stated the first half and could not test it, because the
    //      only thing that could witness a paint outside surface B was an
    //      array the fan-out itself filled in. `regions` above is the DOM.
    //
    //      The `userAsked` gate is not a loophole, it is the actual rule: a
    //      document the user opened from the rail is history, not news, and
    //      the ledger is right not to have it. Those cells are held to I8
    //      instead, which is the harder half.
    if (painted && !path.userAsked) {
      stats.i5++;
      expect([where, 'the fan-out saw what a surface drew', { rec: !!rec, regions: regions }])
        .toEqual([where, 'the fan-out saw what a surface drew', { rec: true, regions: regions }]);
      if (k.landed) {
        expect([where, 'a drawn landed write is on the ledger', after.landed])
          .toEqual([where, 'a drawn landed write is on the ledger', k.id]);
      }
    }

    // I6 · PINNING STILL PINS. A pinned document keeps the row the user picked
    //      — stamped, never yanked. Asserted against the real Cowork column's
    //      own text rather than against a stand-in's variable. Skipped where
    //      the user's own click is what moved the document, which is not the
    //      pin failing but the pin being replaced.
    if (mt.pinned && hasCowork && mt.active && !path.userAsked) {
      const doc = document.getElementById('cw-doc');
      const kept = !!(doc && doc.textContent.indexOf(SEED_TITLE) >= 0);
      stats.i6++;
      expect([where, 'pinned doc kept its row', kept]).toEqual([where, 'pinned doc kept its row', true]);
      if (news) {
        const mark = doc.querySelector('.cw-stale');
        stats.pinnedStamped++;
        expect([where, 'pinned doc was stamped', !!mark]).toEqual([where, 'pinned doc was stamped', true]);
        expect([where, 'pinned doc stamp says a write landed', mark.textContent.indexOf(STALE_MARK) >= 0])
          .toEqual([where, 'pinned doc stamp says a write landed', !!landed]);
      }
    }

    // I7 · A ROW FLASH MEANS THE FAN-OUT ARMED SURFACE C. C paints no text, so
    //      no text probe can see it; it is the one surface whose entire output
    //      is a CSS class, and the one the matrix could not previously reach at
    //      all. _pendingFlash is only ever set inside the broadcast, so a tint
    //      on a row is a claim about provenance and this is the claim.
    if (flashed) {
      stats.i7++;
      expect([where, 'a flash means the fan-out armed C',
        { armed: !!(rec && rec.by.indexOf('editor-flash') >= 0), state: k.state, cs: k.cs }])
        .toEqual([where, 'a flash means the fan-out armed C',
          { armed: true, state: 'applied', cs: 'estimate' }]);
    }

    // I8 · A ROW THE USER OPENED BY HAND, THAT IS NOT THE LEDGER'S SUBJECT,
    //      SAYS SO. This is the whole honesty story for the two browse paths:
    //      Cowork may paint any write in history, and the moment it does it
    //      must consult the ledger rather than let the document read as the
    //      latest. The stamp's WORDING is asserted too — round 6's defect was
    //      a region choosing that sentence for itself.
    // I9 · THE HANDOFF PLACEHOLDER SURVIVES IFF NOTHING SUPERSEDED IT.
    //      Asserted only where surface B did NOT render the row, because when
    //      B renders it the strip is legitimately repainted with the row's own
    //      card and there is no placeholder question to answer. Where another
    //      surface took it, the placeholder is what the strip is still
    //      showing, and then there are exactly two ways to be wrong: destroy
    //      it for a row that is not news (round 5's measured defect — a
    //      dismissed draft killing an unrelated drafting card), or leave it
    //      standing after a write really landed, which is a false in-flight
    //      claim on screen. This is the one invariant clearComposing() is the
    //      whole subject of, and without it that path had no assertion of its
    //      own at all.
    if (path.key === 'composing-then-row' && !(rec && rec.by.indexOf('notification') >= 0)) {
      stats.i9++;
      const strip = document.getElementById('p86-live-writer');
      const drafting = !!(strip && strip.textContent.indexOf(MX_COMPOSING.pillText) >= 0);
      expect([where, 'the drafting card survives iff nothing superseded it', drafting])
        .toEqual([where, 'the drafting card survives iff nothing superseded it', !news]);
    }

    if (path.userAsked && painted) {
      const doc = document.getElementById('cw-doc');
      const showsK = !!(doc && doc.textContent.indexOf(k.token) >= 0);
      if (showsK) {
        stats.i8++;
        const mark = doc.querySelector('.cw-stale');
        expect([where, 'a browsed row that is not the subject says so', !!mark])
          .toEqual([where, 'a browsed row that is not the subject says so', true]);
        // The seed landed and it is not this row, so the ledger's answer to
        // "has a write landed since?" is yes, and the sentence must be the
        // landed one rather than the weaker "newer activity".
        expect([where, 'and says a write landed, because one did',
          mark.textContent.indexOf(STALE_MARK) >= 0])
          .toEqual([where, 'and says a write landed, because one did', true]);
      }
    }
  }

  /* ── the MOUNTING dimension ────────────────────────────────────────────
   *
   * FOUR surface shapes now, and two of them are the real files:
   *
   *   cowork    THE REAL js/cowork.js. Order 20, exclusive, claims on PAGE
   *             STATE and never on the row, render() returns undefined on
   *             every branch, registers a ledger claimant of its own. Round 5
   *             modelled this as an engine-level stand-in; the stand-in could
   *             only ever prove things about the engine, and the two paths
   *             added this round (a rail click, a deep link) live in the file,
   *             not in the engine.
   *   editor    THE REAL surface C. It is registered by js/live-writer.js
   *             unconditionally, so what is MOUNTED here is the thing that
   *             arms it: an #estimate-editor-view open on an estimate. C is
   *             order 10 and NON-exclusive, so with Cowork also mounted the
   *             participant list is ['editor-flash','cowork'] — a list round
   *             5's three shapes could not produce at all.
   *   decliner  order 15, exclusive, looks at every row and honestly returns
   *             null. It must not suppress the surfaces behind it.
   *   stub      order 25, NON-exclusive, claims everything and implements
   *             nothing else. The minimum a surface can be, and the shape that
   *             made every row — dismissals included — look like a write.
   *
   * 16 subsets × THREE Cowork activations × Cowork pinned = 96.
   *
   * The activation axis has three values and not two, and the third one is the
   * whole reason the S7 defect was ever visible:
   *
   *   never       Cowork is mounted but is not the page on screen. It declines
   *               every row and surface B keeps everything.
   *   always      Cowork is the page from the first write onward. It takes
   *               everything, including the seed — so the strip never paints a
   *               card at all and has nothing to be stamped.
   *   after-seed  THE MEASURED ARRANGEMENT. The strip reports write one; the
   *               user then moves to Cowork; write two arrives and Cowork
   *               takes it. That is the only shape in which the strip is
   *               holding a card that someone else's write can supersede, and
   *               therefore the only shape in which the SENTENCE THE USER
   *               READS on the strip exists to be checked.
   *
   * Round 6 had the two-value axis, which is why its strip-stamp invariant
   * fired in 12 of 704 cells: the arrangement it needed was not a mounting.
   *
   * The flags are inert in the 8 subsets with no Cowork mounted; those runs
   * are kept so the dimension is rectangular and the count is arithmetic
   * rather than a story. */
  const MX_SHAPES = ['cowork', 'decliner', 'stub', 'editor'];
  const MX_ACTIVATIONS = ['never', 'always', 'after-seed'];
  const MX_SUBSETS = [];
  for (let m = 0; m < (1 << MX_SHAPES.length); m++) {
    MX_SUBSETS.push(MX_SHAPES.filter((_, i) => (m >> i) & 1));
  }
  const MX_MOUNTINGS = [];
  MX_SUBSETS.forEach((m) => MX_ACTIVATIONS.forEach((act) => [false, true].forEach((pinned) => {
    MX_MOUNTINGS.push({ mounts: m, activation: act, active: act !== 'never', pinned: pinned });
  })));

  /* ── THE MASK. Every cell that is NOT asserted is excluded by a predicate
   * that carries a reason, and the reasons are the `why` strings on MX_PATHS
   * — there is no second list to drift from the first. */
  const CELLS = [];
  const PER_PATH = {};
  MX_PATHS.forEach((p) => {
    PER_PATH[p.key] = 0;
    ROW_KINDS.forEach((k) => {
      if (!p.rows(k)) return;
      MX_MOUNTINGS.forEach((mt) => {
        if (!p.mounts(mt)) return;
        CELLS.push({ path: p, k: k, mt: mt });
        PER_PATH[p.key]++;
      });
    });
  });

  test('the matrix is the size it says it is', () => {
    expect(ROW_KINDS.length).toBe(33);        // 8 states × 4 changeset shapes, + no-row
    expect(MX_MOUNTINGS.length).toBe(96);     // 16 subsets × 3 activations × pinned
    expect(MX_PATHS.length).toBe(9);          // enumerated from source, with counts
    // The full rectangle is 33 × 96 × 9 = 28512. It is not asserted, because
    // most of it is not reachable — a rail click on a row no rail can carry is
    // not a cell anyone skipped, it is not a thing. What IS asserted is the
    // per-path count, so the shape of the mask is visible rather than a single
    // subtraction that hides which path lost what.
    expect(PER_PATH).toEqual({
      'broadcast':          3072,   // 32 rows × 96 mountings
      'unreadable':          576,   //  6 rows × 96   (poller-reachable × empty changeset)
      'composing':            96,   //  1 row  × 96
      'backstop':             96,   //  1 row  × 96
      'flash':              3072,   // 32 rows × 96
      'cowork-select':       768,   // 24 rows × 32   (Cowork mounted AND on screen)
      'cowork-open':         768,   // 24 rows × 32
      'dismiss':            3072,   // 32 rows × 96
      'composing-then-row': 3072    // 32 rows × 96
    });
    expect(CELLS.length).toBe(14592);
    // Every path carries a reason for what it excludes. A silent exclusion is
    // the failure mode this list exists to prevent.
    MX_PATHS.forEach((p) => expect(p.why.length).toBeGreaterThan(60));
  });

  test('every cell holds every invariant', async () => {
    const stats = {
      cells: 0, moved: 0, newsWithoutLanding: 0, stamped: 0,
      painted: 0, coworkDoc: 0, elsewhere: 0, pinnedStamped: 0, stripStamped: 0,
      i1: 0, i4: 0, i5: 0, i6: 0, i7: 0, i8: 0, i9: 0
    };
    const warn = console.warn;
    console.warn = () => {};                 // the unreadable path warns 3× per cell
    try {
      for (let i = 0; i < CELLS.length; i++) {
        const cell = CELLS[i];
        const k = cell.k, mt = cell.mt, path = cell.path;
        const where = path.key + ' · ' + k.key + ' · [' + (mt.mounts.join('+') || 'strip only') + ']' +
                      ' active:' + mt.activation + (mt.pinned ? ' pinned' : '');
        const before = await bootMx(mt, k, path);
        expect([where, 'seed', before]).toEqual([where, 'seed', { gen: 1, subject: SEED, landed: SEED }]);
        await drive(path.key, k);
        assertCell(where, k, path, mt, before, stats);
        stats.cells++;
      }
    } finally { console.warn = warn; }

    expect(stats.cells).toBe(14592);

    /* ── COVERAGE, STATED AS NUMBERS RATHER THAN IMPLIED ─────────────────
     *
     * "9472 cells × eight invariants" would be false, and round 6's "704 cells
     * × six invariants" was: its strip-stamp invariant fired in 12 of 704
     * cells, 1.7%, while the sentence read as though every cell checked the
     * sentence the user sees. So every invariant's firing count is asserted
     * EXACTLY here. If a change makes one of them stop firing — the way a
     * matrix quietly goes vacuous — this test fails rather than staying green
     * with a smaller claim.
     *
     * These are also the non-vacuity checks. Every one was zero at some point
     * while this file was being written, and a matrix whose cells never do
     * anything is nine thousand green ticks over an engine that reports
     * nothing. */
    expect(MX_COVERAGE(stats)).toEqual(MX_COVERAGE_EXPECTED);
  }, 900000);

  test('the two row-less paths really put their card on screen', async () => {
    // I1–I8 say composing and backstop move nothing. That is satisfied by an
    // engine where startComposing does nothing at all, so say what they DO.
    const card = MODEL.describe({}, { composing: { label: 'drafting your change', viaScribe: true } });
    const noRow = ROW_KINDS[ROW_KINDS.length - 1];
    expect(noRow.key).toBe('no-row');
    for (let i = 0; i < MX_MOUNTINGS.length; i++) {
      const mt = MX_MOUNTINGS[i];
      const where = '[' + (mt.mounts.join('+') || 'strip only') + '] active:' + mt.activation;
      await bootMx(mt, noRow, MX_PATH.composing);
      LW.startComposing('drafting your change', {});
      expect([where, 'composing', visibleClaim().pillText]).toEqual([where, 'composing', card.pillText]);
      jest.advanceTimersByTime(180100);
      await settle();
      const strip = document.getElementById('p86-live-writer');
      expect([where, 'backstop', strip ? strip.textContent.indexOf('come back') >= 0 : false])
        .toEqual([where, 'backstop', true]);
    }
  }, 300000);
});
