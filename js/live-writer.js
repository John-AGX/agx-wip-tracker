/* ────────────────────────────────────────────────────────────────────────
 * live-writer.js — the ONE Live Writer engine.
 *
 * Watches for writes the coworker makes and turns them into an animated,
 * color-coded diff — add (green), edit (amber, before→after), delete (red,
 * struck). This is the "coworker shows its work" surface: 86 keeps talking
 * in the chat while this narrates the write.
 *
 * ONE ENGINE, THREE SURFACES. This module owns ingest + dedupe + diffing +
 * the row model, and BROADCASTS to registered surfaces:
 *   A · Cowork      the center page (js/cowork.js) — the home surface
 *   B · strip/pane  the docked notification, defined here — the fallback
 *   C · in-editor   the estimate editor's own row flash
 * A and B are mutually exclusive (both are "where the write is reported").
 * C is non-exclusive (the editor can be open while Cowork is not active).
 * If a surface ever needs its own differ, this design has failed — consume
 * p86LiveWriter.diff() / .rows() and the per-op `lineId` instead.
 *
 * THE CHANGESET IS TWO DIFFERENT THINGS, and the difference is the whole
 * honesty of this feature:
 *   draft_changeset  = the Scribe's DRY RUN. A simulation that was rolled
 *                      back. Its line ids were minted at dispatch and will
 *                      never exist; its `before` is stale the moment it is
 *                      taken; a second pending draft on the same estimate
 *                      isn't in it. Rendered as OPS ("proposes"), never as
 *                      a document.
 *   apply_changeset  = what the dispatcher COMMITTED. The record. This one
 *                      may be rendered as a document.
 * A surface that renders a simulation as a document is lying, and it is the
 * same defect class this feature exists to fix.
 *
 * Five real states, each backed by a column, none of them a spinner that
 * never resolves: proposed (status='ready') · applying · applied · failed
 * (carries apply_error) · rejected.
 *
 * Nothing here writes anything except through the SAME apply/reject
 * endpoints the chat approval card uses.
 *
 * TWO LAYERS, and the split is load-bearing. js/live-writer-model.js DECIDES
 * (pure: entry → the complete claim, every word and every colour). This file
 * DRAWS. A chrome in here cannot disagree with the pill, because a chrome
 * cannot reach the pill; and it cannot decide to stay silent, because silence
 * is a `kind` the model returns. That boundary is the round-3 fix: the old
 * invariant ("every path that fills this card calls setPill") was a statement
 * about leaves, and a new leaf silently opts out of a call it does not make.
 *
 * OWNERSHIP. The strip, the pane, the editor flash and Cowork's document
 * column are shared mutable DOM that several independent async continuations
 * write to. Each is an OWNER with a generation counter: whoever takes over a
 * region claims a new epoch before its first write, and every timer, frame and
 * awaited continuation it schedules captures that epoch and no-ops once it has
 * been superseded — checked at every tick, because the reveal loops reschedule
 * themselves. Inside this file a bare setTimeout / requestAnimationFrame that
 * touches DOM is a defect; use OWNER.after / OWNER.frame. The two legitimate
 * exceptions are both non-DOM: initPoll's retry and the poll interval.
 *
 * CURRENCY is a second, higher question, and ownership could not answer it.
 * An epoch is per-REGION; a write is GLOBAL. Measured live: the strip's pill
 * asserted write one while Cowork showed write two — no region was broken,
 * nothing had written to the strip, so it went on faithfully asserting a write
 * that was no longer the news. broadcast() now reports every write to a WRITE
 * LEDGER with the participant list it already builds, and the ledger supersedes
 * every claimant not displaying that write. Reported by the FAN-OUT, never by
 * a surface: a surface cannot skip a call it does not make. Surface C is
 * deliberately not a claimant — it tints a row and says nothing about which
 * write is latest.
 *
 * WHETHER a write happened is a separate question from WHICH one is current,
 * and round 4 only moved the second. broadcast() fired the ledger whenever the
 * participant list was non-empty, and a surface joined that list by not
 * returning null — so "a rejection is not news" held only while the sole
 * mounted surface was the one that consults describe(). On Cowork (claims =
 * isActive(), render returns undefined) a rejected row moved the generation
 * and destroyed an unrelated drafting card. broadcast() now hands the ENTRY to
 * the ledger, which asks the model before it reads a single claim. A surface's
 * return value means "I am displaying this row" and nothing more.
 *
 * ROUND 6 closes the seam in both directions.
 *
 *   INWARD  the ledger asks TWO questions instead of one (supersedesOnScreen,
 *           didWriteLand). Round 5's single predicate answered "is this a
 *           moment?" and was read as "did a write land?", so a rolled-back
 *           draft, a refusal and an in-flight row each became subject() and
 *           captioned a pinned document "A newer write has landed since".
 *   OUTWARD noticeUnreadable() called reportToStrip() directly and therefore
 *           never reached WRITES.report at all — the one path that skipped the
 *           fan-out, and so the one write that landed and went unreported. It
 *           goes through broadcast() now.
 *
 * THE REPORT PATHS, enumerated, because "there is exactly one" is the kind of
 * claim round 2 made about setPill:
 *
 *   1 broadcast()          the fan-out seam. The ONLY caller of WRITES.report.
 *                          Reached from ingest() and from noticeUnreadable().
 *   2 startComposing()     → reportToStrip. No row exists yet, so it reports
 *                          no write and must move nothing (P7).
 *   3 the 180s backstop    → reportToStrip. Same: a statement that nothing
 *                          came back is not a write.
 *   4 surface B's render() → reportToStrip, from inside (1).
 *
 * Nothing else in this file or in cowork.js reaches reportToStrip or the
 * ledger. (2) and (3) are the only paths that paint the strip from outside the
 * fan-out, and both are about a write that has not landed.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86LiveWriter) return;

  // The decision layer. Loaded as a plain script before this one in the app;
  // required directly under jest.
  var M = (typeof window !== 'undefined' && window.p86LiveWriterModel) || null;
  if (!M && typeof require === 'function') { try { M = require('./live-writer-model.js'); } catch (_) {} }
  if (!M) { console.warn('[live-writer] decision layer missing — engine not started'); return; }

  /* A lookup table with NO prototype — see live-writer-model.js's bare() for
   * the full reasoning. Short version: `{ lines: 1 }` inherits every key on
   * Object.prototype, so TABLE['constructor'] is truthy for a key nobody
   * declared. Every table below is indexed by a string this file did not
   * choose — a server record's field names, an op kind — so every one of them
   * is built here. Deliberately a local four-liner rather than an import: the
   * tables are evaluated at module scope and a load-order regression that made
   * a shared helper undefined would empty them silently. */
  function bare(src) {
    var t = Object.create(null);
    Object.keys(src || {}).forEach(function (k) { t[k] = src[k]; });
    return t;
  }

  // Four owned regions. Per-region, not one global counter: a Cowork selection
  // must not supersede a strip stagger loop, and vice versa. The strip CARD and
  // the strip PILL share one owner on purpose — they are two renderings of one
  // claim, and a design that lets them be claimed separately is the original
  // defect wearing a different hat.
  var STRIP = M.makeOwner('strip');
  var PANE  = M.makeOwner('pane');
  var FLASH = M.makeOwner('editor-flash');

  /* The epoch ABOVE the region. The owners above answer "am I still painting
   * this region?"; they cannot answer "is the write I am asserting still the
   * current one?", because a region is only superseded by a write that lands
   * IN it and a write is global. broadcast() reports every write to this
   * ledger and it supersedes every claimant not displaying it — see
   * makeWriteLedger in the model for the three remedies. Owned by the engine
   * and exported, so Cowork registers against the SAME ledger. */
  var WRITES = M.makeWriteLedger();

  var COLLAPSE_MS = 14000;  // auto-collapse the notification to a pill
  var STAGGER_MS = 180;     // per-op reveal delay for the "writing" feel
  var MAX_OPS = 24;         // cap rendered rows in the strip (rest summarized)
  var MAX_REVEALS = 40;     // cap ANIMATED rows; the rest paint instantly
  var POLL_MS = 5000;       // how often to sweep for server-side applies

  // Dedupe key is payloadId + ':' + state, NOT payloadId — a payload
  // legitimately passes through proposed → applying → applied and each
  // transition is a new fact worth showing. Keyed per-state, the client
  // event and the poller still can't double-render the SAME transition.
  var _seen = Object.create(null);
  var _appliedBaselineTs = 0;   // newest applied_at at page load
  var _draftBaselineTs = 0;     // page-load stamp for the DRAFT arm

  // Rows whose DETAIL fetch failed, keyed the same way as _seen. A row in here
  // is deliberately NOT seen (it must come back) and is re-offered by the sweep
  // regardless of the baselines. Bounded — see ingestRow.
  var _detailRetry = Object.create(null);
  var MAX_DETAIL_RETRIES = 3;

  // First time each 'ready' row was SEEN by a sweep, and how long a draft with
  // no recorded diff is given before we report it as having none.
  //
  // The window is real, not paranoia: driveScribeWrite INSERTS the payload row
  // (execEmitPayloadFile, step 1) and only then dry-runs it; persistDraftChangeset
  // runs after that resolves. So a row legitimately sits at status='ready' with
  // draft_changeset NULL for seconds. Reporting "no before/after was recorded"
  // into that gap would be false — and worse, the report marks the row seen for
  // this state, so the diff that lands a moment later would never be shown.
  //
  // Keyed on the CLIENT's first sighting rather than created_at: it only has to
  // be monotonic within the session, so a skewed client clock can't make a draft
  // permanently unreportable.
  var _draftFirstSeen = Object.create(null);
  var DRAFT_SETTLE_MS = 20000;   // ~4 sweeps; the composing backstop is at 180s

  // DRAFT_RECORDER_SINCE and the copy that reasons about it live in the model
  // — five render sites across two files share ONE predicate now, because
  // gating it inside a per-status arm is what told production's ten rejected
  // pre-recorder rows "this view can't tell" about a fact created_at proves.

  // _draftBaselineTs is its own clock on purpose. _appliedBaselineTs is
  // derived from applied_at and advances on every apply; comparing a draft's
  // created_at against it is a category error — one auto-applied calendar
  // create would push the baseline past every draft made before it and
  // blind the draft arm permanently.

  // ── tiny helpers ────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function num(v) {
    if (v === '' || v == null) return null;
    var n = Number(v);
    return isFinite(n) ? n : null;
  }
  function usd(n) {
    if (n == null || !isFinite(n)) return '—';
    return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function isHeaderLine(l) {
    if (!l) return true;
    if (l.section === '__section_header__') return true;
    if (typeof l.id === 'string' && /^s\d/.test(l.id)) return true;
    return false;
  }
  function lineCost(l) {
    var q = num(l && l.qty), c = num(l && l.unitCost);
    if (q == null || c == null) return null;
    var base = q * c;
    var m = num(l && l.markup);
    if (m != null && m !== 0) base = base * (1 + m / 100);
    return base;
  }
  function getLines(snap) {
    if (!snap) return [];
    if (snap.data && Array.isArray(snap.data.lines)) return snap.data.lines;
    if (Array.isArray(snap.lines)) return snap.lines;
    return [];
  }
  function entityName(et, id, before, after) {
    var s = after || before || {};
    if (et === 'estimate') return s.title || s.name || 'estimate';
    if (s.title) return s.title;
    if (s.name) return s.name;
    try {
      if (window.entityDisplayName) {
        var d = window.entityDisplayName(et, id);
        if (d) return d;
      }
    } catch (_) {}
    // never surface a raw system id — fall back to the type
    if (window.p86LooksLikeSystemId && window.p86LooksLikeSystemId(id)) return et;
    return id || et || 'record';
  }
  function relTime(iso) {
    if (!iso) return '';
    var t = Date.parse(iso);
    if (!isFinite(t)) return '';
    var s = Math.max(0, Math.round((Date.now() - t) / 1000));
    if (s < 45) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    return Math.round(s / 86400) + 'd ago';
  }
  var agentLabel = M.agentLabel;

  // ── diff one changeset entry into a list of ops ──────────────────────────
  // Returns { entity_type, name, ops:[{kind, label, detail, amount, lineId}], impact }
  function diffEntry(entry) {
    var et = entry && entry.entity_type;
    var before = entry && entry.before;
    var after = entry && entry.after;
    var name = entityName(et, entry && entry.id, before, after);

    if (et === 'estimate') return diffEstimate(name, before, after);
    return diffFields(et, name, before, after);
  }

  function diffEstimate(name, before, after) {
    var bl = getLines(before), al = getLines(after);
    var bById = {}, aById = {};
    bl.forEach(function (l) { if (l && l.id != null) bById[l.id] = l; });
    al.forEach(function (l) { if (l && l.id != null) aById[l.id] = l; });
    var ops = [], impact = 0;

    // deletes — in before, gone from after
    bl.forEach(function (l) {
      if (isHeaderLine(l)) return;
      if (!aById[l.id]) {
        var c = lineCost(l);
        if (c != null) impact -= c;
        ops.push({ kind: 'delete', label: l.description || 'line', detail: lineMeta(l), amount: c, lineId: l.id });
      }
    });
    // adds — new in after
    al.forEach(function (l) {
      if (isHeaderLine(l)) return;
      if (!bById[l.id]) {
        var c = lineCost(l);
        if (c != null) impact += c;
        ops.push({ kind: 'add', label: l.description || 'line', detail: lineMeta(l), amount: c, lineId: l.id });
      }
    });
    // edits — present in both, some field changed
    al.forEach(function (l) {
      if (isHeaderLine(l)) return;
      var b = bById[l.id];
      if (!b) return;
      var changes = lineFieldChanges(b, l);
      if (!changes.length) return;
      var bc = lineCost(b), ac = lineCost(l);
      if (bc != null && ac != null) impact += (ac - bc);
      ops.push({ kind: 'edit', label: l.description || b.description || 'line', detail: changes.join(' · '), amount: ac, lineId: l.id });
    });

    // Scalar fields too — NOT just lines. diffEstimate used to diff only
    // line items, so an estimate-scoped field change produced zero ops and
    // renderDiff's `.filter(g => g.ops.length)` dropped the group entirely:
    // the write rendered as NOTHING, leaving the agent-authored title as the
    // only thing on screen.
    //
    // Live 2026-08-09: Scribe, lacking a convert tool, wrote a payload titled
    // "Convert Estimate … to Job" whose only op was {status:'sold'}. Invisible
    // here, so the title was the whole story — and the title was wrong.
    // A card must describe its OPS, never just its title.
    ops = scalarFieldOps(before, after).concat(dataFieldOps(before, after)).concat(ops);

    return { entity_type: 'estimate', name: name, ops: ops, impact: impact };
  }

  // Changes that live INSIDE `data` but are not line items — scope text on a
  // group, an alternate's name, a settings flag.
  //
  // Found live 2026-08-16 on a real applied write: the Scribe set the Base
  // group's scope-of-work, the dispatcher recorded a perfectly good
  // apply_changeset, and every surface rendered NOTHING — because
  // scalarFieldOps skips `data` wholesale (it's nested) and no line moved.
  // The page then told the user "this write type doesn't record a diff",
  // which was simply untrue: it recorded one, we just couldn't read it.
  //
  // Two levels deep and no further, `lines` excluded (diffEstimate owns
  // those), values truncated. No amounts — a scope edit is not money, and
  // inventing one here would put a second number next to the impact delta.
  function dataFieldOps(before, after) {
    var bd = before && before.data, ad = after && after.data;
    if (!bd || !ad || typeof bd !== 'object' || typeof ad !== 'object') return [];
    var out = [];
    var SKIP = bare({ lines: 1 });
    function short(v) {
      if (v == null || v === '') return '∅';
      var s = String(v).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
      return s.length > 48 ? (s.slice(0, 48) + '…') : (s || '∅');
    }
    function cmp(label, bv, av) {
      if (out.length >= 12) return;
      if (String(bv == null ? '' : bv) === String(av == null ? '' : av)) return;
      out.push({ kind: 'edit', label: label, detail: short(bv) + ' → ' + short(av), amount: null });
    }
    Object.keys(ad).forEach(function (k) {
      if (SKIP[k] || out.length >= 12) return;
      var bv = bd[k], av = ad[k];
      if (av && typeof av === 'object') {
        if (!Array.isArray(av)) return;                 // deeper objects: not walked
        var bArr = Array.isArray(bv) ? bv : [];
        var bById = Object.create(null);
        bArr.forEach(function (x, i) { if (x && x.id != null) bById[x.id] = x; else bById['#' + i] = x; });
        av.forEach(function (item, i) {
          if (!item || typeof item !== 'object' || out.length >= 12) return;
          var prev = (item.id != null ? bById[item.id] : bById['#' + i]) || {};
          var who = item.name || item.title || item.id || (k + ' ' + (i + 1));
          Object.keys(item).forEach(function (f) {
            if (f === 'id' || SKIP[f]) return;
            var iv = item[f];
            if (iv && typeof iv === 'object') return;    // arrays/objects inside items: not walked
            cmp(who + ' · ' + f.replace(/_/g, ' '), prev[f], iv);
          });
        });
        return;
      }
      cmp(k.replace(/_/g, ' '), bv, av);
    });
    return out;
  }

  function lineMeta(l) {
    var q = num(l.qty), c = num(l.unitCost);
    if (q == null && c == null) return '';
    return (q == null ? '' : (q + (l.unit ? ' ' + l.unit : ''))) +
           (c == null ? '' : ' @ ' + usd(c));
  }
  function lineFieldChanges(b, a) {
    var out = [];
    var fields = [
      ['qty', 'qty'], ['unit', 'unit'], ['unitCost', 'unit $'],
      ['markup', 'markup'], ['description', 'desc']
    ];
    fields.forEach(function (f) {
      var key = f[0], label = f[1];
      var bv = b[key], av = a[key];
      var bn = num(bv), an = num(av);
      var same = (bn != null && an != null) ? (bn === an) : (String(bv == null ? '' : bv) === String(av == null ? '' : av));
      if (same) return;
      var fb = (key === 'unitCost') ? usd(bn) : (bv == null || bv === '' ? '∅' : bv);
      var fa = (key === 'unitCost') ? usd(an) : (av == null || av === '' ? '∅' : av);
      out.push(label + ' ' + fb + '→' + fa);
    });
    return out;
  }

  // Scalar (non-nested) field changes between two snapshots. Extracted so
  // BOTH diffFields and diffEstimate use it — a status/title move has to be
  // visible on every entity type, not only the ones without a bespoke differ.
  function scalarFieldOps(before, after) {
    var SKIP = bare({ id: 1, created_at: 1, updated_at: 1, organization_id: 1, user_id: 1, data: 1, lines: 1 });
    if (!before || !after) return [];   // create/delete framed by the caller
    var out = [];
    Object.keys(after).forEach(function (k) {
      if (SKIP[k]) return;
      var bv = before[k], av = after[k];
      if (av && typeof av === 'object') return; // skip nested
      if (String(bv == null ? '' : bv) === String(av == null ? '' : av)) return;
      out.push({
        kind: 'edit', label: k.replace(/_/g, ' '),
        detail: (bv == null || bv === '' ? '∅' : String(bv).slice(0, 40)) + '→' + (av == null || av === '' ? '∅' : String(av).slice(0, 40)),
        amount: null
      });
    });
    return out;
  }

  // generic scalar-field diff for non-estimate entities
  function diffFields(et, name, before, after) {
    var ops = [];
    if (!before && after) { ops.push({ kind: 'add', label: 'created', detail: name, amount: null }); }
    else if (before && !after) { ops.push({ kind: 'delete', label: 'deleted', detail: name, amount: null }); }
    else { ops = scalarFieldOps(before, after); }
    return { entity_type: et, name: name, ops: ops, impact: 0 };
  }

  // Diff a whole changeset array into groups. PUBLIC (p86LiveWriter.diff) —
  // this is THE differ; every surface consumes its output.
  function diffChangeset(cs) {
    if (!Array.isArray(cs)) return [];
    return cs.map(diffEntry).filter(function (g) { return g && g.ops && g.ops.length; });
  }

  // ── the ONE row model for a rendered estimate ────────────────────────────
  // Extracted out of showEstimatePane, which used to compute isAdd / isEdit /
  // changes / the unit-cost cell WHILE emitting HTML — so a second, larger
  // chrome (the Cowork document column) could not exist without a second
  // copy of that logic. Now the pane and Cowork are two chromes over one
  // model. PUBLIC as p86LiveWriter.rows().
  function buildEstimateRows(entry) {
    var before = entry && entry.before, after = entry && entry.after;
    var bl = getLines(before), al = getLines(after);
    var bById = Object.create(null);
    bl.forEach(function (l) { if (l && l.id != null) bById[l.id] = l; });
    var aIds = Object.create(null);
    al.forEach(function (l) { if (l && l.id != null) aIds[l.id] = true; });

    var rows = [];
    al.forEach(function (l) {
      if (isHeaderLine(l)) { rows.push({ kind: 'section', label: l.description || '', line: l }); return; }
      var b = bById[l.id];
      var isAdd = !b;
      var changes = b ? lineFieldChanges(b, l) : [];
      var isEdit = !isAdd && changes.length > 0;
      rows.push({
        kind: isAdd ? 'add' : (isEdit ? 'edit' : 'same'),
        line: l, before: b || null, changes: changes,
        lineId: l.id, cost: lineCost(l),
        unitCost: num(l.unitCost),
        unitCostWas: (isEdit && b && num(b.unitCost) !== num(l.unitCost)) ? num(b.unitCost) : null
      });
    });
    var dels = bl.filter(function (l) { return l && !isHeaderLine(l) && l.id != null && !aIds[l.id]; })
      .map(function (l) { return { kind: 'delete', line: l, lineId: l.id, cost: lineCost(l) }; });

    return { name: entityName('estimate', entry && entry.id, before, after), rows: rows, deletes: dels };
  }

  // ── ingest + broadcast (the fan-out seam) ────────────────────────────────
  // The old renderChangeset conflated "payload ingested" with "payload
  // rendered by the ONE chosen host": it set _shown[payloadId] and every
  // later consumer was refused at the gate, which is why the poller had to
  // do a claim/release dance and why a second surface could not coexist with
  // the first. Ingest dedupes; broadcast fans out. They are separate now.
  var _surfaces = [];

  /* registerSurface({ name, order, exclusive, claims(entry), render(entry) }) */
  function registerSurface(spec) {
    if (!spec || typeof spec.render !== 'function') return function () {};
    var s = {
      name: spec.name || ('surface' + _surfaces.length),
      order: typeof spec.order === 'number' ? spec.order : 50,
      exclusive: spec.exclusive !== false,
      claims: typeof spec.claims === 'function' ? spec.claims : function () { return true; },
      render: spec.render
    };
    _surfaces = _surfaces.filter(function (x) { return x.name !== s.name; }).concat([s]);
    _surfaces.sort(function (a, b) { return a.order - b.order; });
    return function unregister() {
      _surfaces = _surfaces.filter(function (x) { return x !== s; });
    };
  }

  // entry.claimedBy is filled IN ORDER as surfaces render, so a later surface
  // can see what an earlier one already did. That is how B knows to step down
  // from the document pane to the compact strip when C has the editor: the
  // registry order (C=10, A=20, B=90) is the whole coordination mechanism, and
  // no surface needs to reach into another's DOM to find out.
  //
  // KNOWN OPEN — claim ≠ paint. `reported` is set when render() merely does
  // not throw, so a surface can claim a write and never actually put it on
  // screen: C arms _pendingFlash and paints only from the editor's
  // post-hydrate refresh, which may never run; A claims on isActive() alone
  // without checking the row is findable. In both cases B has already stepped
  // down and nobody reports the write.
  //
  // NOT fixed here on purpose. The honest fix is not "render() returns a
  // boolean" — C physically cannot answer synchronously, by design — it is a
  // deadline: arm, and if the paint has not happened in N seconds, hand the
  // entry back to B. That is a new behaviour with its own failure mode
  // (double-reporting a write the user did see) and it does not belong bolted
  // onto an honesty fix. Severity is also a tier below D1-D4: this degrades to
  // a MISSED notification, not to a FALSE one — nothing on screen says
  // something untrue.
  function broadcast(entry) {
    var reported = false;
    entry.claimedBy = [];
    for (var i = 0; i < _surfaces.length; i++) {
      var s = _surfaces[i];
      if (s.exclusive && reported) continue;
      var ok = false;
      try { ok = !!s.claims(entry); } catch (e) { ok = false; }
      if (!ok) continue;
      // A surface that returns an explicit null DECLINED — it looked and had
      // nothing to put on screen. Anything else (including undefined, which is
      // what A and C return) is a claim, exactly as before. This is the
      // smallest honest step on the claim≠paint gap: surface B now reports its
      // own silence instead of being credited with a paint it never made.
      try {
        var out = s.render(entry);
        if (out === null) continue;
        entry.claimedBy.push(s.name);
        if (s.exclusive) reported = true;
      }
      catch (e) { console.warn('[live-writer] surface "' + s.name + '" failed:', e); }
    }
    /* THE CROSS-SURFACE BOUNDARY. Every write that reached a surface claims a
     * global generation HERE, in the fan-out, using the participant list the
     * fan-out already built — never in a surface's own render(). A surface
     * cannot skip a call it does not make, which is the same structural
     * property that stopped a chrome from skipping setPill, applied one level
     * up: this is precisely where round 3's model could not see, because a
     * per-region epoch is only ever claimed by the region's own writer.
     *
     * ROUND 5. The ENTRY is handed over, not a subject id and not a verdict.
     * What a surface returns says who is DISPLAYING the row — the only half a
     * surface can honestly answer — and says nothing about whether the row is
     * news. That is the model's call and the ledger asks it directly, before
     * it reads a claim. The `if (entry.claimedBy.length)` test that used to
     * gate this line is GONE, not moved alongside: the same rule lives inside
     * report(), and one invariant with two mechanisms is how round 3 became
     * necessary. Round 4's version of this comment claimed an empty claimedBy
     * was what stopped a rejection demoting a drafting card. It was true of
     * surface B alone; with Cowork mounted, claimedBy was ['cowork']. */
    WRITES.report(entry, entry.claimedBy);
    return reported;
  }

  /* ingest(changeset, meta) → the broadcast entry, or null when deduped.
   * meta: { payloadId, state, title, summary, emittingAgentKey, createdAt,
   *         appliedAt, applyError, isDraft } */
  function ingest(cs, meta) {
    meta = meta || {};
    var state = meta.state || 'applied';
    var key = (meta.payloadId || ('anon' + Date.now())) + ':' + state;
    if (meta.payloadId && _seen[key]) return null;
    if (meta.payloadId) _seen[key] = true;

    var groups = diffChangeset(cs);
    var first = (Array.isArray(cs) && cs.length === 1) ? cs[0] : null;
    var entry = {
      changeset: Array.isArray(cs) ? cs : [],
      groups: groups,
      meta: {
        payloadId: meta.payloadId || null,
        state: state,
        // isDraft marks a changeset that came from a ROLLED-BACK dry run.
        // Surfaces must render it as ops, never as a document.
        isDraft: state === 'proposed' || !!meta.isDraft,
        title: meta.title || '',
        summary: meta.summary || '',
        emittingAgentKey: meta.emittingAgentKey || '',
        createdAt: meta.createdAt || null,
        appliedAt: meta.appliedAt || null,
        applyError: meta.applyError || null,
        // A 'failed' row with no targets is a recorded REFUSAL — the Scribe
        // never authored a payload — not an apply that blew up. The two get
        // different words because they send the user to different places.
        neverDrafted: !!meta.neverDrafted,
        entityType: first ? first.entity_type : (groups.length === 1 ? groups[0].entity_type : null),
        entityId: first ? first.id : null,
        estimateId: (first && first.entity_type === 'estimate') ? first.id : null
      },
      // lazily-built row model — only the surfaces that need it pay for it
      rows: function () { return first ? buildEstimateRows(first) : null; }
    };
    broadcast(entry);
    /* clearComposing() used to be called here — "the handed-to-the-Scribe
     * placeholder is stale the moment a state change lands, whoever reports
     * it". That is a WRITE-LEVEL supersession hand-rolled at the ingest level,
     * and it is now exactly what the ledger does: broadcast reports the write,
     * the strip is not displaying it, and the strip's remedy for a placeholder
     * is to clear. Deleted rather than kept alongside — two mechanisms for one
     * invariant is how round 3 became necessary.
     *
     * A REJECTED row must therefore not destroy a drafting card it has nothing
     * to do with, and the reason it does not is that the MODEL does not call it
     * news — supersedesOnScreen(entry) is false, so report() returns before it
     * looks at who drew it. Round 4 wrote this same sentence with "nobody reports it"
     * as the reason, which was only true of surface B: Cowork claims on
     * isActive() and returns undefined, so it reported the rejection, moved the
     * generation, and cleared the card. Never re-state the reason as a fact
     * about which surfaces are mounted. */
    return entry;   // nobody may have claimed it; it is still a valid entry
  }

  // ── DOM (surface B — the notification) ───────────────────────────────────
  var root = null, collapseTimer = null;
  var PILL_NEUTRAL = M.PILL_NEUTRAL;   // the pill's "claims nothing" colour

  function ensureStyle() {
    if (document.getElementById('p86lw-style')) return;
    var css = [
      // z-index: 940 / 930 sits ABOVE the Site Plan job page (500) and the AI
      // drawer (200) and BELOW .modal (1000) and p86Confirm (1100). The old
      // 99998/99997 painted the diff on top of any open modal.
      // right tracks the OPEN chat drawer (--p86-ai-w, published live by
      // ai-panel) instead of a bare 16px. Seen live: with the drawer open the
      // strip's 390px sat entirely inside its footprint, so the write
      // notification painted on top of the conversation that produced it.
      // body.p86-ai-open's padding-right can't help — this is a fixed child
      // of body, so body padding never moves it. min() keeps a very wide
      // drawer from pushing the strip off the left edge.
      '#p86-live-writer{position:fixed;right:calc(16px + min(var(--p86-ai-w, 0px), 55vw));bottom:16px;',
      'width:390px;max-width:calc(100vw - 32px - min(var(--p86-ai-w, 0px), 55vw));',
      'transition:right .22s ease;',
      'z-index:940;font-family:inherit;color:#e7e7ea;pointer-events:none;}',
      '#p86-live-writer .p86lw-card{pointer-events:auto;background:#16161c;border:1px solid rgba(255,255,255,0.10);',
      'border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,0.45);overflow:hidden;',
      'transform:translateY(8px);opacity:0;transition:transform .22s ease,opacity .22s ease;}',
      '#p86-live-writer .p86lw-card.p86lw-in{transform:translateY(0);opacity:1;}',
      '#p86-live-writer.p86lw-collapsed .p86lw-full{display:none;}',
      '#p86-live-writer .p86lw-pill{display:none;pointer-events:auto;cursor:pointer;align-items:center;gap:8px;',
      'background:#16161c;border:1px solid rgba(255,255,255,0.10);border-radius:999px;padding:8px 14px;',
      'box-shadow:0 8px 28px rgba(0,0,0,0.4);font-size:12px;}',
      '#p86-live-writer.p86lw-collapsed .p86lw-pill{display:inline-flex;}',
      '#p86-live-writer.p86lw-collapsed .p86lw-card{display:none;}',
      '.p86lw-head{display:flex;align-items:center;gap:9px;padding:11px 13px;border-bottom:1px solid rgba(255,255,255,0.08);}',
      '.p86lw-av{width:24px;height:24px;border-radius:50%;background:#378add;color:#fff;font-size:11px;font-weight:600;',
      'display:flex;align-items:center;justify-content:center;flex:none;}',
      '.p86lw-ttl{font-size:13px;font-weight:600;line-height:1.2;}',
      '.p86lw-sub{font-size:11px;color:#9a9aa5;line-height:1.2;margin-top:1px;}',
      '.p86lw-dot{width:8px;height:8px;border-radius:50%;background:#378add;animation:p86lwp 1s ease-in-out infinite;flex:none;}',
      '@keyframes p86lwp{0%,100%{opacity:.35}50%{opacity:1}}',
      '.p86lw-x{margin-left:auto;background:none;border:none;color:#9a9aa5;cursor:pointer;font-size:16px;line-height:1;padding:2px 4px;}',
      '.p86lw-x:hover{color:#e7e7ea;}',
      '.p86lw-body{max-height:46vh;overflow-y:auto;padding:6px 8px;}',
      '.p86lw-grp{margin:4px 0 8px;}',
      '.p86lw-grpname{font-size:11px;color:#9a9aa5;padding:4px 6px 5px;display:flex;align-items:center;gap:6px;}',
      '.p86lw-op{display:flex;align-items:flex-start;gap:8px;padding:7px 8px;border-radius:9px;margin:3px 0;font-size:12px;',
      'opacity:0;transform:translateX(-6px);transition:opacity .2s ease,transform .2s ease;}',
      '.p86lw-op.p86lw-shown{opacity:1;transform:none;}',
      '.p86lw-op .p86lw-i{width:16px;text-align:center;flex:none;font-weight:700;font-size:12px;line-height:1.5;}',
      '.p86lw-add{background:rgba(29,158,117,0.13);} .p86lw-add .p86lw-i{color:#1d9e75;}',
      '.p86lw-edit{background:rgba(186,117,23,0.14);} .p86lw-edit .p86lw-i{color:#d98a1f;}',
      // `.p86lw-delete`, not `.p86lw-del`. The op row's class is built as
      // 'p86lw-' + op.kind and the kind is the word "delete" — so these four
      // rules have never matched anything since S1, and a removed line has
      // been rendering in the strip (and in Cowork's op list, which uses the
      // same markup) with no red fill, no red glyph and no strikethrough:
      // visually identical to an unchanged row. It matters more now that the
      // strip is the ONLY place deletes are reported while the editor holds
      // the document.
      '.p86lw-delete{background:rgba(226,75,74,0.13);} .p86lw-delete .p86lw-i{color:#e24b4a;}',
      '.p86lw-lbl{flex:1;min-width:0;}',
      '.p86lw-lbl .l1{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.p86lw-delete .l1{text-decoration:line-through;color:#e88;}',
      '.p86lw-lbl .l2{font-size:11px;color:#9a9aa5;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.p86lw-amt{flex:none;font-variant-numeric:tabular-nums;font-size:11px;color:#c9c9d2;padding-left:4px;}',
      '.p86lw-foot{display:flex;align-items:center;gap:8px;padding:9px 13px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#9a9aa5;}',
      '.p86lw-imp{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;}',
      '.p86lw-imp.pos{color:#1d9e75;} .p86lw-imp.neg{color:#e24b4a;}',
      '.p86lw-view{background:none;border:1px solid rgba(255,255,255,0.16);color:#c9c9d2;border-radius:7px;',
      'padding:3px 9px;font-size:11px;cursor:pointer;}',
      '.p86lw-view:hover{border-color:rgba(255,255,255,0.4);color:#fff;}',
      '.p86lw-err{padding:11px 13px;font-size:12px;line-height:1.5;color:#f0a9a8;}',
      /* The supersession stamp. Deliberately quiet — it is not an error and
       * not an outcome; it says only that this anchored card has stopped
       * being the news, which is the one thing the pill can no longer say
       * because the pill has reverted to claiming nothing. */
      '.p86lw-stale{padding:7px 13px;border-top:1px solid rgba(255,255,255,0.08);',
      'font-size:11px;line-height:1.45;color:#9a9aa5;font-style:italic;}',
      // light mode
      'body.light-mode #p86-live-writer{color:#1a1a1f;}',
      'body.light-mode #p86-live-writer .p86lw-card,body.light-mode #p86-live-writer .p86lw-pill{background:#fff;border-color:rgba(0,0,0,0.10);box-shadow:0 12px 40px rgba(0,0,0,0.14);}',
      'body.light-mode .p86lw-head,body.light-mode .p86lw-foot{border-color:rgba(0,0,0,0.08);}',
      'body.light-mode .p86lw-sub,body.light-mode .p86lw-grpname,body.light-mode .p86lw-lbl .l2,body.light-mode .p86lw-foot{color:#6b6b76;}',
      'body.light-mode .p86lw-amt{color:#44444a;}',
      'body.light-mode .p86lw-delete .l1{color:#a33;}',
      'body.light-mode .p86lw-view{border-color:rgba(0,0,0,0.18);color:#44444a;}',
      'body.light-mode .p86lw-stale{border-color:rgba(0,0,0,0.08);color:#6b6b76;}',
      // Light twins for the op fills: the dark rgba washes read as muddy
      // smears on white, and the +/~/− glyph colors lose contrast.
      'body.light-mode .p86lw-add{background:rgba(29,158,117,0.10);} body.light-mode .p86lw-add .p86lw-i{color:#0f6e56;}',
      'body.light-mode .p86lw-edit{background:rgba(186,117,23,0.12);} body.light-mode .p86lw-edit .p86lw-i{color:#8a5c0d;}',
      'body.light-mode .p86lw-delete{background:rgba(226,75,74,0.10);} body.light-mode .p86lw-delete .p86lw-i{color:#a33;}',
      'body.light-mode .p86lw-err{color:#a33;}',
      // ── the estimate "document" pane (applied writes only) ──
      // left tracks the user-resizable sidebar instead of a magic 300px.
      // Anchored left, so the drawer only has to shrink it, not move it.
      '#p86-live-pane{position:fixed;left:calc(var(--p86-sidebar-w, 290px) + 10px);bottom:24px;width:560px;',
      'max-width:calc(100vw - var(--p86-sidebar-w, 290px) - 30px - min(var(--p86-ai-w, 0px), 55vw));',
      'max-height:82vh;z-index:930;font-family:inherit;color:#e7e7ea;pointer-events:none;}',
      '#p86-live-pane .p86lp-card{pointer-events:auto;display:flex;flex-direction:column;max-height:82vh;',
      'background:#16161c;border:1px solid rgba(255,255,255,0.10);border-radius:16px;',
      'box-shadow:0 18px 60px rgba(0,0,0,0.5);overflow:hidden;transform:translateY(10px);opacity:0;',
      'transition:transform .24s ease,opacity .24s ease;}',
      '#p86-live-pane .p86lp-card.in{transform:none;opacity:1;}',
      '.p86lp-head{display:flex;align-items:center;gap:10px;padding:13px 15px;border-bottom:1px solid rgba(255,255,255,0.08);flex:none;}',
      '.p86lp-av{width:26px;height:26px;border-radius:50%;background:#378add;color:#fff;font-size:12px;font-weight:600;',
      'display:flex;align-items:center;justify-content:center;flex:none;}',
      '.p86lp-ttl{font-size:14px;font-weight:600;line-height:1.2;} .p86lp-sub{font-size:11px;color:#9a9aa5;margin-top:1px;}',
      '.p86lp-x{margin-left:auto;background:none;border:none;color:#9a9aa5;cursor:pointer;font-size:17px;line-height:1;padding:2px 5px;}',
      '.p86lp-x:hover{color:#e7e7ea;}',
      '.p86lp-body{overflow-y:auto;padding:6px 4px 10px;}',
      '.p86lp-sec{font-size:11px;font-weight:500;color:#9a9aa5;padding:9px 14px 5px;}',
      '.p86lp-row{display:grid;grid-template-columns:1fr 44px 30px 74px 84px;align-items:center;gap:6px;',
      'padding:7px 12px;font-size:12px;border-radius:8px;color:#c9c9d2;margin:2px 8px;}',
      '.p86lp-row .r-d{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0;}',
      '.p86lp-row span:not(.r-d){text-align:right;font-variant-numeric:tabular-nums;}',
      '.p86lp-row.add{background:rgba(29,158,117,0.14);color:#d6f5e9;}',
      '.p86lp-row.edit{background:rgba(186,117,23,0.15);}',
      '.p86lp-del{display:flex;align-items:center;gap:7px;padding:6px 12px;margin:2px 8px;border-radius:8px;',
      'background:rgba(226,75,74,0.13);color:#e88;font-size:12px;}',
      '.p86lp-del .r-d{text-decoration:line-through;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.p86lp-card .chg{opacity:0;transform:translateX(-7px);transition:opacity .25s ease,transform .25s ease;}',
      '.p86lp-card .chg.on{opacity:1;transform:none;}',
      '.p86lp-tag{font-size:9px;font-weight:600;padding:1px 6px;border-radius:9px;margin-left:7px;}',
      '.p86lp-tag.tadd{background:#1d9e75;color:#04241a;} .p86lp-tag.tedit{background:#d98a1f;color:#3a2405;}',
      '.p86lp-was{color:#9a9aa5;text-decoration:line-through;margin-right:5px;}',
      '.p86lp-foot{display:flex;align-items:center;gap:10px;padding:10px 15px;border-top:1px solid rgba(255,255,255,0.08);',
      'font-size:11px;color:#9a9aa5;flex:none;}',
      'body.light-mode #p86-live-pane{color:#1a1a1f;}',
      'body.light-mode #p86-live-pane .p86lp-card{background:#fff;border-color:rgba(0,0,0,0.10);box-shadow:0 18px 60px rgba(0,0,0,0.16);}',
      'body.light-mode .p86lp-head,body.light-mode .p86lp-foot{border-color:rgba(0,0,0,0.08);}',
      'body.light-mode .p86lp-sub,body.light-mode .p86lp-sec,body.light-mode .p86lp-foot{color:#6b6b76;}',
      'body.light-mode .p86lp-row{color:#33333a;} body.light-mode .p86lp-row.add{color:#0f6e56;}',
      // #e88 struck text on white is unreadable; so is the "was" grey.
      'body.light-mode .p86lp-del{background:rgba(226,75,74,0.10);color:#a33;}',
      'body.light-mode .p86lp-was{color:#77777f;}',
      'body.light-mode .p86lp-tag.tadd{background:#0f6e56;color:#eafaf4;}',
      'body.light-mode .p86lp-tag.tedit{background:#8a5c0d;color:#fff6e6;}',
      // ── surface C: the in-editor row flash ──
      // NOT background. An estimate row's own cells set inline backgrounds
      // (the drag-over highlight sets row.style.background directly), and
      // inline beats all CSS — a background animation would be silently
      // cancelled on exactly the row someone is interacting with.
      //
      // Nor an INSET shadow, which was the first attempt: an inset shadow
      // paints on the row's own background layer, and every cell in the row
      // is an opaque child stacked above it, so the wash showed only in the
      // gaps. This rings the row from OUTSIDE the border box — nothing the
      // editor renders inside the row can occlude it — and outline-offset
      // pulls a second line just inside the edge. Both properties are
      // unclaimed by the editor.
      '@keyframes p86lwFlashAdd{',
      '0%{box-shadow:0 0 0 2px #1d9e75,0 0 14px 2px rgba(29,158,117,.55);outline-color:rgba(29,158,117,.85);}',
      '70%{box-shadow:0 0 0 2px #1d9e75,0 0 14px 2px rgba(29,158,117,.35);outline-color:rgba(29,158,117,.6);}',
      '100%{box-shadow:0 0 0 0 rgba(29,158,117,0),0 0 0 0 rgba(29,158,117,0);outline-color:transparent;}}',
      '@keyframes p86lwFlashEdit{',
      '0%{box-shadow:0 0 0 2px #d98a1f,0 0 14px 2px rgba(217,138,31,.55);outline-color:rgba(217,138,31,.85);}',
      '70%{box-shadow:0 0 0 2px #d98a1f,0 0 14px 2px rgba(217,138,31,.35);outline-color:rgba(217,138,31,.6);}',
      '100%{box-shadow:0 0 0 0 rgba(217,138,31,0),0 0 0 0 rgba(217,138,31,0);outline-color:transparent;}}',
      // position:relative so the ring paints above the NEXT row rather than
      // being clipped under it, and a z-index that stays well below the
      // notification band.
      '.p86lw-flash-add,.p86lw-flash-edit{position:relative;z-index:2;border-radius:4px;',
      'outline:2px solid transparent;outline-offset:-2px;}',
      '.p86lw-flash-add{animation:p86lwFlashAdd 1.6s ease-out 1;}',
      '.p86lw-flash-edit{animation:p86lwFlashEdit 1.6s ease-out 1;}',
      // The dark-mode greens/ambers wash out on white; the light twins are
      // the same hues at the contrast the rest of light mode uses.
      'body.light-mode .p86lw-flash-add{animation-name:p86lwFlashAddL;}',
      'body.light-mode .p86lw-flash-edit{animation-name:p86lwFlashEditL;}',
      '@keyframes p86lwFlashAddL{',
      '0%{box-shadow:0 0 0 2px #0f6e56,0 0 14px 2px rgba(15,110,86,.35);outline-color:rgba(15,110,86,.8);}',
      '70%{box-shadow:0 0 0 2px #0f6e56,0 0 14px 2px rgba(15,110,86,.22);outline-color:rgba(15,110,86,.55);}',
      '100%{box-shadow:0 0 0 0 rgba(15,110,86,0),0 0 0 0 rgba(15,110,86,0);outline-color:transparent;}}',
      '@keyframes p86lwFlashEditL{',
      '0%{box-shadow:0 0 0 2px #8a5c0d,0 0 14px 2px rgba(138,92,13,.35);outline-color:rgba(138,92,13,.8);}',
      '70%{box-shadow:0 0 0 2px #8a5c0d,0 0 14px 2px rgba(138,92,13,.22);outline-color:rgba(138,92,13,.55);}',
      '100%{box-shadow:0 0 0 0 rgba(138,92,13,0),0 0 0 0 rgba(138,92,13,0);outline-color:transparent;}}',
      // Someone who has asked the OS not to animate still needs to see WHICH
      // rows moved — so the ring holds still instead of disappearing.
      '@media (prefers-reduced-motion:reduce){',
      '.p86lw-flash-add{animation:none;box-shadow:0 0 0 2px #1d9e75;}',
      '.p86lw-flash-edit{animation:none;box-shadow:0 0 0 2px #d98a1f;}}',
      // ── mobile ──
      // The strip had NO mobile rule and buried the 5-slot bottom nav; the
      // pane's rule already existed at 900px so it is AMENDED here, not
      // supplemented, or it keeps winning at the width that matters.
      '@media (max-width:900px){#p86-live-pane{left:8px;right:8px;bottom:8px;width:auto;max-width:none;}}',
      '@media (max-width:768px) and (pointer:coarse){',
      '#p86-live-writer{right:8px;left:8px;width:auto;bottom:calc(78px + env(safe-area-inset-bottom,0px));}',
      '#p86-live-pane{bottom:calc(78px + env(safe-area-inset-bottom,0px));max-height:60vh;}',
      '#p86-live-pane .p86lp-card{max-height:60vh;}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'p86lw-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* Build the strip root if it is missing. Deliberately does NOT claim an
   * epoch: callers claim immediately afterwards, and a rebuilt root is
   * superseded by that claim anyway. */
  function ensureRoot() {
    ensureStyle();
    if (root && document.body.contains(root)) return;
    root = document.createElement('div');
    root.id = 'p86-live-writer';
    // The pill's DEFAULT is a label, not a claim, and its dot is neutral grey.
    // It used to be hardcoded "Scribe wrote" on a success-green dot: after the
    // 14s auto-collapse, a refusal card reading "The Scribe did not produce a
    // valid payload. Nothing was written" became a green pill asserting the
    // opposite. This markup is now only what shows before the first report —
    // reportToStrip sets the pill BEFORE it picks a chrome, so no chrome can
    // skip it — and it must claim nothing.
    root.innerHTML =
      '<div class="p86lw-full"><div class="p86lw-card"></div></div>' +
      '<div class="p86lw-pill"><span class="p86lw-dot" style="animation:none;background:' + PILL_NEUTRAL + '"></span>' +
      '<span class="p86lw-pilltext">Live Writer</span></div>';
    document.body.appendChild(root);
    root.querySelector('.p86lw-pill').addEventListener('click', function () {
      // Uncollapsing re-arms under the CURRENT epoch, not the one that was
      // live when this handler was attached: the user is re-opening whatever
      // the strip says now.
      root.classList.remove('p86lw-collapsed');
      armCollapse(STRIP.current());
    });
  }

  /* A COLLAPSED pill is a claim, and it is the claim most people actually read
   * — the card is gone 14 seconds after it appears, the pill can sit there for
   * the rest of the session. So the pill carries the state: text AND colour.
   *
   * Takes the whole report, not a text/colour pair. The colour is decided in
   * ONE place (the model's finish()), which is what stops a card from wearing
   * a blue header dot over a green pill. */
  function setPill(ep, report) {
    if (!root || !STRIP.guard(ep, 'pill')) return;
    var t = root.querySelector('.p86lw-pilltext');
    if (t) t.textContent = (report && report.pillText) || 'Live Writer';
    // Scoped to the PILL. A bare '.p86lw-dot' matches the CARD's header dot
    // first (the card is the earlier sibling), so an unscoped write would
    // recolour the wrong element and leave the pill exactly as green as it was.
    var d = root.querySelector('.p86lw-pill .p86lw-dot');
    if (d) d.style.background = (report && report.pillColor) || PILL_NEUTRAL;
  }

  /* ── the strip's remedy when a write it is NOT showing claims the floor ──
   *
   * S7, measured live: pill "Scribe wrote · 3 edited" (write one) sitting at
   * 1514,836 in full health while Cowork's document showed write two. No
   * region was broken; the strip simply had no way to learn that its write had
   * stopped being the news.
   *
   * The two halves of this region are treated differently because they carry
   * different things, and the split IS the answer to "clear, or keep the
   * content and drop the claim?":
   *
   *   THE PILL is currency with no content. It has no record name and no
   *   timestamp — a bare "Scribe wrote · 3 edited" — which is precisely why it
   *   reads as the latest thing that happened. There is nothing in it to
   *   preserve, so it REVERTS to the neutral default ensureRoot builds. That
   *   default is reused, never re-derived: two neutrals is how two greens
   *   started.
   *
   *   THE CARD is anchored content — it names the record it is about — and the
   *   user may be halfway through reading it. Yanking it would be the same
   *   clobber this whole feature exists to stop, so it is KEPT and STAMPED.
   *   Its own header dot keeps its own colour on purpose: that write's outcome
   *   has not changed and recolouring it would erase a true fact. What changed
   *   is that it is no longer current, and that is exactly what the stamp says.
   *
   *   THE HANDOFF PLACEHOLDER is the exception, and it is the one case that
   *   clears. It holds no anchored content ("Handed to the Scribe — drafting")
   *   and a newer row is the evidence that the handoff came back, so stamping
   *   it would leave a false in-flight claim on screen. This is
   *   clearComposing(), which used to live in ingest() one level too low.
   *
   * ROUND 6 — WHAT THE STAMP SAYS. It read "A newer write has landed since",
   * hard-coded, on a region that steps down for every row the ledger calls a
   * moment — including drafts, refusals and in-flight rows, none of which
   * landed. The sentence now comes from the model (supersededLead) given the
   * ledger's own `landed` fact, so this region cannot make a claim about
   * question (b) using a mechanism that only answers question (a).
   *
   * _stripSuperseded records WHICH sentence is up, not just "stamped", so a
   * draft followed by a real apply UPGRADES the wording. It never downgrades:
   * once a write has landed behind this card, that stays true.
   */
  var _stripReport = null;        // what the strip is currently asserting
  var _stripSuperseded = null;    // null | 'activity' | 'landed'

  /* THE PANE'S CURRENCY, written once.
   *
   * The pane is current only while the strip's own report IS that pane report.
   * Two genuinely different events can falsify that — this surface reporting
   * something else, and another surface reporting a write — so it is CHECKED
   * at both. That is one invariant with two triggers, not two mechanisms: the
   * predicate and the remedy each exist exactly once, and neither caller gets
   * to decide anything.
   *
   * The property test found the need for the second trigger immediately: on
   * P→C the estimate document sat under a "Handed to the Scribe — drafting"
   * card, because a placeholder deliberately claims no write generation (no
   * write has landed) and so never reaches the ledger. */
  function paneIsCurrent(by) {
    if (by && !by['notification']) return false;
    return !!_stripReport && _stripReport.kind === 'pane';
  }

  function supersedeStrip(ev) {
    if (!root) return;
    if (_stripReport && _stripReport.kind === 'composing') { clearComposing(); return; }
    var kind = (ev && ev.landed) ? 'landed' : 'activity';
    // Already stepped down, and not an upgrade from "something happened" to
    // "a write landed" → nothing left to do.
    if (_stripSuperseded === kind || _stripSuperseded === 'landed') return;
    var upgrade = _stripSuperseded === 'activity';
    _stripSuperseded = kind;
    var t = root.querySelector('.p86lw-pilltext');
    if (t) t.textContent = 'Live Writer';
    var d = root.querySelector('.p86lw-pill .p86lw-dot');
    if (d) { d.style.animation = 'none'; d.style.background = PILL_NEUTRAL; }
    var card = root.querySelector('.p86lw-card');
    if (!card || !card.firstChild) return;
    var text = M.supersededLead(kind === 'landed') + ' This is the earlier one.';
    var mark = card.querySelector('.p86lw-stale');
    if (mark) { if (upgrade) mark.textContent = text; return; }
    // insertAdjacentHTML, never `innerHTML +=` — the latter reparses every
    // child and would orphan the listeners renderOps/renderNotice attached.
    card.insertAdjacentHTML('beforeend', '<div class="p86lw-stale">' + esc(text) + '</div>');
  }

  /* Collapsing is itself a claim — the pill it collapses to is the thing the
   * user reads for the rest of the session — so it carries an epoch like any
   * other paint. There is no separate cancellation mechanism: a newer claim
   * invalidates this timer by definition. */
  function armCollapse(ep) {
    if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; }
    collapseTimer = STRIP.after(ep, COLLAPSE_MS, function () {
      if (root) root.classList.add('p86lw-collapsed');
    });
  }

  var ICON = bare({ add: '+', edit: '~', delete: '−' });

  // Per-state chrome and the "why is there no diff" copy both live in the
  // model now — the first because `settle:'wrote'` hanging off the applied
  // default arm was the exact wire a green pill leaked down onto a degraded
  // write, the second because gating the pre-recorder predicate inside one
  // status arm is what produced R5.
  var draftNoDiffWhy = M.draftNoDiffWhy;

  function openInCoworkBtn(meta) {
    if (!meta || !meta.payloadId) return '';
    return '<button class="p86lw-view" data-cowork="' + esc(meta.payloadId) + '">Open in Cowork</button>';
  }
  function wireCoworkBtn(card) {
    var ob = card.querySelector('.p86lw-view[data-cowork]');
    if (!ob) return;
    ob.addEventListener('click', function () {
      var id = ob.getAttribute('data-cowork');
      try {
        if (window.p86Cowork && window.p86Cowork.open) window.p86Cowork.open(id);
        else if (window.switchTab) window.switchTab('cowork');
      } catch (e) { console.warn('[live-writer] open in Cowork failed', e); }
    });
  }

  /* ── THE reporting boundary ────────────────────────────────────────────
   *
   * Surface B reports a write HERE and nowhere else. Three properties make a
   * silent-pill bypass structurally impossible rather than conventionally
   * forbidden:
   *
   *   1. setPill is called by this wrapper, BEFORE a chrome is chosen. A new
   *      chrome cannot skip a call it does not make. (Round 2's invariant —
   *      "every path that fills this card calls setPill" — was literally true
   *      and still let six paths lie, because it was a rule about leaves.)
   *   2. Renderers receive the CARD element, not the root. .p86lw-pilltext is
   *      not reachable from inside a chrome. Physical, not documentary.
   *   3. Renderers have no decision-making early-returns. "Nothing to show" is
   *      decided by the model (kind 'silent'), never discovered by a renderer.
   *      A renderer that cannot decide cannot disagree with the pill.
   *
   * Returns the report it painted, or null when it claimed nothing. */
  function reportToStrip(entry, report) {
    /* B did not put this row on screen, and says so. That is ALL this line
     * means now. It used to double as the guard on the write ledger — a
     * rejection moved no generation because THIS surface declined it — and
     * that is exactly the guard round 5 retired: it spoke for every surface
     * while living inside one. Whether the row is news is decided by
     * supersedesOnScreen() inside the ledger, and whether a write landed by
     * didWriteLand(); this is a statement about surface B and nothing else. */
    if (!report || report.kind === 'silent') return null;   // paint nothing, claim nothing
    /* `if (report.kind !== 'pane') dismissPane();` used to sit here as its own
     * inline rule, and it only ever covered the half of the problem this
     * surface can see: a pane left standing while COWORK reported the next
     * write was never touched by it. It is now one call to paneIsCurrent()
     * below — the same predicate the ledger asks — so the cross-surface half
     * is covered by construction rather than by remembering. */
    ensureRoot();
    var ep = STRIP.claim();                                  // AFTER the silent decision
    root.classList.remove('p86lw-collapsed');
    // What the strip asserts, recorded BEFORE any chrome runs, for the same
    // reason setPill is called before one: the ledger asks this question, and
    // a chrome must not be able to answer it differently.
    _stripReport = report;
    _stripSuperseded = null;
    if (!paneIsCurrent()) dismissPane();                     // the same predicate, from inside
    setPill(ep, report);                                     // ALWAYS, and first
    var card = root.querySelector('.p86lw-card');
    if (report.kind === 'composing') { renderComposing(ep, card, report); return report; }
    if (report.kind === 'notice') { renderNotice(ep, card, entry, report); return report; }
    // 'ops' and 'pane' share the op list. The pane case renders it too — as
    // truthful content behind the pill, so re-opening the collapsed strip
    // shows this write rather than the previous one — then collapses, because
    // the pane is where the detail lives and the pill is where the claim does.
    renderOps(ep, card, entry, report);
    if (report.kind === 'pane') {
      root.classList.add('p86lw-collapsed');
      showEstimatePane(entry, report);
    }
    return report;
  }

  // Render a set of diffed groups into the compact strip.
  function renderOps(ep, card, entry, report) {
    var groups = entry.groups || [];
    var meta = entry.meta || {};
    var netImpact = report.impact || 0;
    var totalOps = report.totalOps || 0;
    var name = report.name;

    var rows = '';
    var shownOps = 0;
    for (var gi = 0; gi < groups.length; gi++) {
      var g = groups[gi];
      if (groups.length > 1) rows += '<div class="p86lw-grpname">' + esc(g.name) + '</div>';
      rows += '<div class="p86lw-grp">';
      for (var oi = 0; oi < g.ops.length && shownOps < MAX_OPS; oi++, shownOps++) {
        var o = g.ops[oi];
        rows += '<div class="p86lw-op p86lw-' + o.kind + '" data-idx="' + shownOps + '">' +
          '<span class="p86lw-i">' + (ICON[o.kind] || '') + '</span>' +
          '<span class="p86lw-lbl"><div class="l1">' + esc(o.label) + '</div>' +
          (o.detail ? '<div class="l2">' + esc(o.detail) + '</div>' : '') + '</span>' +
          (o.amount != null ? '<span class="p86lw-amt">' + usd(o.amount) + '</span>' : '') +
          '</div>';
      }
      rows += '</div>';
    }
    if (totalOps > MAX_OPS) rows += '<div class="p86lw-grpname">+' + (totalOps - MAX_OPS) + ' more…</div>';

    var summ = report.summary || [];

    var impHtml = '';
    if (netImpact) {
      impHtml = '<span class="p86lw-imp ' + (netImpact > 0 ? 'pos' : 'neg') + '">' +
        (netImpact > 0 ? '+' : '−') + usd(Math.abs(netImpact)) + '</span>';
    }

    card.innerHTML =
      '<div class="p86lw-head">' +
        '<span class="p86lw-av">' + esc(report.who.charAt(0)) + '</span>' +
        '<div><div class="p86lw-ttl">' + esc(report.who) + ' <span class="p86lw-verb">' + esc(report.verb) + '</span></div>' +
        '<div class="p86lw-sub">' + esc(name) + '</div></div>' +
        '<span class="p86lw-dot" style="background:' + report.dot + (report.pulse ? '' : ';animation:none') + '"></span>' +
        '<button class="p86lw-x" title="Dismiss">×</button>' +
      '</div>' +
      '<div class="p86lw-body">' + rows + '</div>' +
      '<div class="p86lw-foot">' + esc(summ.join(' · ')) + openInCoworkBtn(meta) + impHtml + '</div>';

    card.querySelector('.p86lw-x').addEventListener('click', dismiss);
    wireCoworkBtn(card);

    STRIP.frame(ep, function () { card.classList.add('p86lw-in'); });

    // Staggered reveal → the "writing" feel, then settle. Capped: past
    // MAX_REVEALS the remaining rows paint at once instead of animating for
    // longer than the card's own lifetime.
    //
    // THE ORPHAN. This loop used to capture `card` — the PERSISTENT
    // .p86lw-card element, which every other chrome overwrites via innerHTML
    // rather than replacing — and nothing cancelled it. So after a failure
    // notice took the card, this loop kept ticking against the same node for
    // up to ops × 180ms and then repainted .p86lw-verb to "wrote" on a green
    // dot, over a body that still read "Nothing was written". Same mechanism
    // re-armed the collapse that startComposing had deliberately cleared.
    //
    // The guard is the FIRST line of each tick, not a wrapper around the first
    // call, because the loop reschedules itself.
    var opEls = card.querySelectorAll('.p86lw-op');
    var i = 0;
    (function reveal() {
      if (!STRIP.guard(ep, 'reveal')) return;
      if (i >= MAX_REVEALS) {
        for (var k = i; k < opEls.length; k++) opEls[k].classList.add('p86lw-shown');
        i = opEls.length;
      }
      if (i < opEls.length) {
        opEls[i].classList.add('p86lw-shown');
        i++;
        STRIP.after(ep, STAGGER_MS, reveal);
      } else {
        if (report.settles) {
          var verb = card.querySelector('.p86lw-verb');
          if (verb) verb.textContent = report.settleVerb;
          var dot = card.querySelector('.p86lw-head .p86lw-dot');
          if (dot) { dot.style.animation = 'none'; dot.style.background = report.settleDot; }
        }
        armCollapse(ep);
      }
    })();
  }

  // A write that FAILED, a refusal, or a real write this view cannot break
  // down. All are real outcomes that used to render as silence — and the
  // colour they wear is the model's call, not this function's: an APPLIED
  // write nobody could read is amber, exactly like an unreadable detail fetch,
  // because a green pill would read at a glance as "nothing to see here".
  function renderNotice(ep, card, entry, report) {
    var meta = (entry && entry.meta) || {};
    card.innerHTML =
      '<div class="p86lw-head"><span class="p86lw-av">' + esc(report.who.charAt(0)) + '</span>' +
      '<div><div class="p86lw-ttl">' + esc(report.who) + ' <span class="p86lw-verb">' + esc(report.headline) + '</span></div>' +
      '<div class="p86lw-sub">' + esc(report.name || '') + '</div></div>' +
      '<span class="p86lw-dot" style="background:' + report.dot + ';animation:none"></span>' +
      '<button class="p86lw-x" title="Dismiss">×</button></div>' +
      '<div class="p86lw-err">' + esc(report.bodyText) + '</div>' +
      '<div class="p86lw-foot">' + openInCoworkBtn(meta) + '</div>';
    card.querySelector('.p86lw-x').addEventListener('click', dismiss);
    wireCoworkBtn(card);
    STRIP.frame(ep, function () { card.classList.add('p86lw-in'); });
    armCollapse(ep);
  }

  /* The handoff placeholder's chrome. Deliberately arms NO collapse timer:
   * this card ends when the draft lands (or when its own backstop fires), not
   * on someone else's clock — and any collapse timer armed by the PREVIOUS
   * card was invalidated by reportToStrip's claim before this ran, so there is
   * no second cancellation mechanism to keep in step with the first. */
  function renderComposing(ep, card, report) {
    card.innerHTML =
      '<div class="p86lw-head"><span class="p86lw-av">' + esc(report.avatar) + '</span>' +
      '<div><div class="p86lw-ttl">' +
      (report.viaScribe ? 'Handed to the Scribe <span style="color:' + M.BLUE + '">— drafting</span>'
                        : '86 <span style="color:' + M.BLUE + '">is writing the change</span>') +
      '</div><div class="p86lw-sub">' + esc(report.label) + '</div></div>' +
      '<span class="p86lw-dot"></span><button class="p86lw-x" title="Dismiss">×</button></div>' +
      '<div class="p86lw-body" style="padding:12px 12px 14px;color:#9a9aa5;font-size:12px;line-height:1.5;">' +
      esc(report.bodyText) + '</div>';
    card.querySelector('.p86lw-x').addEventListener('click', dismiss);
    STRIP.frame(ep, function () { card.classList.add('p86lw-in'); });
  }

  function dismiss() {
    // Claiming is the cancellation. It invalidates the collapse timer, any
    // in-flight reveal loop AND the composing backstop in one move — which is
    // why dismissing the "Handed to the Scribe" card by hand no longer has it
    // rebuild itself three minutes later to announce that nothing arrived.
    STRIP.claim();
    collapseTimer = null;
    composingTimer = null;
    _stripReport = null;
    _stripSuperseded = null;
    if (root) { root.remove(); root = null; }
    dismissPane();
  }

  /* ── the two claimants surface B owns ───────────────────────────────────
   *
   * The STRIP is kept current by any report from this surface: reportToStrip
   * has just repainted it, so the default owner rule is exactly right.
   *
   * The PANE is not, and it is the reason `keeps` exists. This surface can
   * report a write WITHOUT putting it in the pane — every 'ops' report does —
   * so ownership alone would leave a superseded document standing. Its
   * currency is paneIsCurrent(), the same predicate reportToStrip asks. */
  WRITES.register({ name: 'strip', owner: 'notification', supersede: supersedeStrip });
  WRITES.register({
    name: 'pane', owner: 'notification',
    keeps: paneIsCurrent,
    supersede: function () { dismissPane(); }
  });

  // ── the handoff placeholder ──────────────────────────────────────────────
  // Fires on the existing tool_started SSE event. That IS a real moment —
  // 86 handing the write off — so the card says exactly that and nothing
  // more. It does NOT claim the Scribe is "composing", because on the
  // scribe_write path the tool returns in milliseconds and the Scribe does
  // not even start for a moment yet; and on 86's own emit_payload_file there
  // is no Scribe and no handoff at all.
  //
  // The timer is a FAILURE BACKSTOP, not the thing that ends the card: the
  // draft usually lands after the old 45s window, which is why the card used
  // to delete itself just before the change existed.
  //
  // _composing WAS a boolean, and that is precisely why it produced two
  // defects. Five entry points can take the strip and only one of them
  // remembered to clear the flag, so noticeUnreadable's truthful amber notice
  // ("wrote something this view could not read") was overwritten 180s later by
  // "hasn't come back / Nothing has landed here in three minutes" — both
  // clauses false, about a write the code had already reported. As an EPOCH,
  // anything that repaints or destroys the strip supersedes the backstop
  // automatically, including paths nobody has written yet.
  // composingEpoch is gone: "is the placeholder still what the strip shows?"
  // is now asked of _stripReport, which the ledger has to know anyway. Two
  // variables tracking one fact is two variables that can disagree.
  var composingTimer = null;
  function startComposing(label, opts) {
    opts = opts || {};
    var viaScribe = opts.tool !== 'emit_payload_file';
    var report = M.describe({}, { composing: { label: label, viaScribe: viaScribe } });
    // Deliberately does NOT claim a write generation: the placeholder is about
    // a write that has not landed, so nothing about which write is current has
    // changed. Only broadcast() — a write that actually reached a surface —
    // moves the ledger.
    reportToStrip({ meta: {} }, report);
    var ep = STRIP.current();
    composingTimer = setTimeout(async function () {
      // Superseded: something else has taken the strip — a result landed, the
      // user dismissed the card, a newer draft started. There is no longer a
      // placeholder to back up, so this says nothing at all. (The 5s sweep
      // keeps running regardless, so nothing is lost by not sweeping here.)
      if (!STRIP.guard(ep, 'composing-backstop')) return;
      // Before concluding that nothing landed, LOOK. The sweep is the only
      // path that ever sees a background draft and it does not run while the
      // tab is hidden — so "no draft has landed" can easily mean "nobody
      // checked". If the sweep finds the row, ingest() reports it, which
      // claims the strip, and the re-check below silences this branch.
      var swept = false;
      try { swept = await pollApplies(true); } catch (_) { swept = false; }
      if (!STRIP.guard(ep, 'composing-backstop-post')) return;
      composingTimer = null;
      var entry = { meta: { state: 'failed', emittingAgentKey: viaScribe ? 'scribe' : 'job', title: label || '' } };
      reportToStrip(entry, M.describe(entry, { backstop: { viaScribe: viaScribe, label: label, swept: swept } }));
    }, 180000);
  }
  /* Retire the placeholder — but ONLY if it is still what the strip is
   * showing, which is now asked of _stripReport rather than of a private
   * composingEpoch. Same question, one fewer thing tracking the answer: the
   * ledger has to know what the strip asserts anyway, so a second variable
   * saying the same thing is a second variable to get out of step.
   *
   * This IS the strip's supersede remedy for the placeholder case;
   * supersedeStrip() calls it rather than re-implementing it. */
  function clearComposing() {
    if (!_stripReport || _stripReport.kind !== 'composing') return;
    STRIP.claim();                    // supersede everything the placeholder scheduled
    composingTimer = null;
    _stripReport = null;
    _stripSuperseded = null;
    if (root) { root.remove(); root = null; }
  }

  // ── the estimate "document" pane (surface B, applied writes only) ────────
  // Renders the whole estimate read-only from the COMMITTED after-snapshot
  // and highlights the changed rows in place. Never used for a draft: a
  // dry-run `after` is a document that has never existed.
  var paneRoot = null, paneTimer = null;
  function ensurePane() {
    ensureStyle();
    if (paneRoot && document.body.contains(paneRoot)) return;
    paneRoot = document.createElement('div');
    paneRoot.id = 'p86-live-pane';
    paneRoot.innerHTML = '<div class="p86lp-card"></div>';
    document.body.appendChild(paneRoot);
  }
  function dismissPane() {
    PANE.claim();
    paneTimer = null;
    if (paneRoot) { paneRoot.remove(); paneRoot = null; }
  }
  /* Called ONLY from reportToStrip, never from the surface directly. That is
   * the F3 fix and it is structural rather than a missing call: the pane used
   * to be routed to INSTEAD of the strip, so it touched neither the pill nor
   * the card nor the collapse timer — and a successful pane could paint
   * bottom-left while a stale failure card and a red pill sat bottom-right,
   * for the rest of the session. A report is now delivered in one place; the
   * pane is a chrome that place chooses, not a way around it. */
  function showEstimatePane(entry, report) {
    ensurePane();
    var ep = PANE.claim();
    var cs0 = entry.changeset[0];
    var model = buildEstimateRows(cs0);
    var diff = entry.groups[0] || { ops: [], impact: 0 };
    var meta = entry.meta;

    var rows = '';
    model.rows.forEach(function (r) {
      if (r.kind === 'section') { rows += '<div class="p86lp-sec">' + esc(r.label) + '</div>'; return; }
      var cls = (r.kind === 'add') ? 'add' : (r.kind === 'edit' ? 'edit' : '');
      var chg = (r.kind === 'add' || r.kind === 'edit') ? ' chg' : '';
      var tag = (r.kind === 'add') ? '<span class="p86lp-tag tadd">new</span>'
              : (r.kind === 'edit' ? '<span class="p86lp-tag tedit">edited</span>' : '');
      var ucCell = (r.unitCost == null) ? '' : usd(r.unitCost);
      if (r.unitCostWas != null) {
        ucCell = '<span class="p86lp-was">' + usd(r.unitCostWas) + '</span>' + usd(r.unitCost);
      }
      rows += '<div class="p86lp-row ' + cls + chg + '">' +
        '<span class="r-d">' + esc(r.line.description || '') + tag + '</span>' +
        '<span>' + (r.line.qty == null || r.line.qty === '' ? '' : esc(r.line.qty)) + '</span>' +
        '<span>' + esc(r.line.unit || '') + '</span>' +
        '<span>' + ucCell + '</span>' +
        '<span>' + (r.cost != null ? usd(r.cost) : '') + '</span>' +
        '</div>';
    });
    if (model.deletes.length) {
      rows += '<div class="p86lp-sec">Removed</div>';
      model.deletes.forEach(function (d) {
        rows += '<div class="p86lp-del chg"><span style="font-weight:700">−</span>' +
          '<span class="r-d">' + esc(d.line.description || 'line') + '</span>' +
          '<span style="margin-left:auto;font-variant-numeric:tabular-nums">' +
          (d.cost != null ? usd(d.cost) : '') + '</span></div>';
      });
    }

    var nAdd = 0, nEdit = 0;
    model.rows.forEach(function (r) { if (r.kind === 'add') nAdd++; else if (r.kind === 'edit') nEdit++; });
    var summ = [];
    if (nAdd) summ.push('+' + nAdd + ' added');
    if (nEdit) summ.push(nEdit + ' edited');
    if (model.deletes.length) summ.push('−' + model.deletes.length + ' removed');
    var imp = diff.impact || 0;
    var impHtml = imp ? '<span style="margin-left:auto;font-weight:600;color:' +
      (imp > 0 ? '#1d9e75' : '#e24b4a') + '">' + (imp > 0 ? '+' : '−') + usd(Math.abs(imp)) + '</span>' : '';

    var who = agentLabel(meta.emittingAgentKey);
    var card = paneRoot.querySelector('.p86lp-card');
    card.innerHTML =
      '<div class="p86lp-head"><span class="p86lp-av">' + esc(who.charAt(0)) + '</span>' +
      '<div><div class="p86lp-ttl">' + esc(who) + ' <span class="p86lp-verb">is writing</span></div>' +
      '<div class="p86lp-sub">' + esc(model.name) + '</div></div>' +
      '<span class="p86lw-dot" style="margin-left:4px"></span>' +
      '<button class="p86lp-x" title="Dismiss">×</button></div>' +
      '<div class="p86lp-body">' + rows + '</div>' +
      '<div class="p86lp-foot">' + esc(summ.join(' · ')) + ' ' + openInCoworkBtn(meta) + impHtml + '</div>';

    card.querySelector('.p86lp-x').addEventListener('click', dismissPane);
    wireCoworkBtn(card);

    PANE.frame(ep, function () { card.classList.add('in'); });
    // Same orphan shape as the strip's, and until now benign only by luck:
    // two pane renders without an intervening dismissPane reuse the same
    // .p86lp-card node, so render #1's loop finished into render #2's header
    // and — the real damage — set paneTimer from its OWN completion, dismissing
    // the newer pane early.
    var chgEls = card.querySelectorAll('.chg');
    var i = 0;
    (function reveal() {
      if (!PANE.guard(ep, 'pane-reveal')) return;
      if (i >= MAX_REVEALS) {
        for (var k = i; k < chgEls.length; k++) chgEls[k].classList.add('on');
        i = chgEls.length;
      }
      if (i < chgEls.length) { chgEls[i].classList.add('on'); i++; PANE.after(ep, STAGGER_MS, reveal); }
      else {
        if (report && report.settles) {
          var v = card.querySelector('.p86lp-verb'); if (v) v.textContent = report.settleVerb;
          var d = card.querySelector('.p86lp-head .p86lw-dot');
          if (d) { d.style.animation = 'none'; d.style.background = report.settleDot; }
        }
        paneTimer = PANE.after(ep, COLLAPSE_MS + 8000, dismissPane);
      }
    })();
  }

  // ── surface B registration (the fallback notification) ───────────────────
  registerSurface({
    name: 'notification',
    order: 90,
    exclusive: true,
    claims: function () { return true; },
    /* One line, on purpose. Every decision this used to make — rejected is not
     * news, a refusal is not a failed apply, which silence is which, whether
     * the document pane or the op strip renders it — is now in the model, and
     * every paint goes through the one boundary that always sets the pill.
     *
     * The pane's arbitration still lives in describe(): only a COMMITTED
     * single-estimate write earns it, and only when surface C has not already
     * claimed the editor. Standing on the very estimate that changed, the pane
     * would be a 560px read-only copy painted on top of the real one while the
     * real one animates the same change underneath — two documents, one of
     * them fake, one covering the other. The strip stays as the ticket naming
     * the agent, the cost impact, and the DELETED lines, which C cannot show
     * because their rows are gone. */
    render: function (entry) {
      return reportToStrip(entry, M.describe(entry, {
        inEditor: (entry.claimedBy || []).indexOf('editor-flash') >= 0,
        // The detail fetch gave up on this row. Carried ON THE ENTRY rather
        // than passed at one call site, so noticeUnreadable can go through
        // broadcast() like everything else instead of around it — see the
        // round-6 note there. `undefined` reads as "readable", which is what
        // every other row is.
        unreadable: entry.unreadable || null
      }));
    }
  });

  // ── surface C: in-editor row flash ───────────────────────────────────────
  // NOT driven by the broadcast. The estimate editor deliberately does not
  // repaint on p86:payload-applied — it sets a latch and waits for app.js's
  // post-hydrate fan-out. At broadcast time the DOM is still the PRE-write
  // DOM: an added line has no [data-line-id] row at all, an edited row still
  // shows the old values, and the imminent re-render would destroy anything
  // we painted. So C is armed by the broadcast and FIRES from the editor's
  // post-hydrate refresh, against the repainted rows.
  var _pendingFlash = null;

  /* The estimate the editor has open RIGHT NOW, or null when it is closed or
   * hidden. Both the claim and the paint go through this — nothing else in
   * this file is allowed to guess at the editor's state. */
  function openEditorEstimateId() {
    var view = document.getElementById('estimate-editor-view');
    if (!view || view.offsetParent === null) return null;
    try {
      return (window.p86EstimateEditorCurrentId && window.p86EstimateEditorCurrentId()) || null;
    } catch (_) { return null; }
  }

  /* Which changeset entry (if any) is the estimate on screen?
   *
   * Deliberately NOT meta.entityId: that is only populated when the changeset
   * has exactly ONE entry (ingest, `first`). A write that touches the open
   * estimate AND something else — the common "update the estimate and stamp
   * the lead" shape — has meta.entityId === null, so the old claim silently
   * refused the very case where the user is most obviously watching. */
  function editorTargetEntry(entry) {
    var open = openEditorEstimateId();
    if (!open) return null;
    var cs = (entry && entry.changeset) || [];
    for (var i = 0; i < cs.length; i++) {
      var e = cs[i];
      if (e && e.entity_type === 'estimate' && e.id != null && String(e.id) === String(open)) return e;
    }
    return null;
  }

  registerSurface({
    name: 'editor-flash',
    order: 10,
    exclusive: false,
    claims: function (entry) {
      var m = entry.meta;
      if (m.state !== 'applied' || m.isDraft) return false;
      return !!editorTargetEntry(entry);
    },
    render: function (entry) {
      var cs = editorTargetEntry(entry);
      if (!cs) return;
      // diffEntry is THE differ — the same function every other surface goes
      // through. It is re-run for this ONE entry rather than indexed out of
      // entry.groups because diffChangeset FILTERS empty groups, so group i
      // and changeset i are not the same record.
      var ops = diffEntry(cs).ops.filter(function (o) {
        // A delete has no row left to paint. It is reported by the strip
        // (which steps down to the op list precisely because C took the
        // document), so it is left out of the count here rather than
        // silently dropped inside the paint loop.
        return o.lineId && o.kind !== 'delete';
      });
      if (!ops.length) return;
      // Two writes can land between one hydrate — merge instead of letting
      // the second silently discard the first's rows.
      var same = _pendingFlash && String(_pendingFlash.estimateId) === String(cs.id) &&
                 (Date.now() - _pendingFlash.at) < 60000;
      if (same) {
        var byKey = Object.create(null);
        _pendingFlash.ops.concat(ops).forEach(function (o) { byKey[o.kind + ':' + o.lineId] = o; });
        _pendingFlash.ops = Object.keys(byKey).map(function (k) { return byKey[k]; });
        _pendingFlash.at = Date.now();
      } else {
        // A DIFFERENT estimate's flash replaces this one: claim, so any
        // stagger loop still running for the old one stops scheduling.
        FLASH.claim();
        _pendingFlash = { estimateId: cs.id, ops: ops, at: Date.now() };
      }
    }
  });

  /* Called by the estimate editor AFTER it has repainted from fresh server
   * rows. Paints only — it never re-renders, so it cannot race the hydrate
   * or clobber an unsaved local edit. */
  function flashEditorRows(estimateId) {
    var p = _pendingFlash;
    if (!p) return 0;
    if (estimateId && p.estimateId && String(estimateId) !== String(p.estimateId)) return 0;
    if (Date.now() - p.at > 60000) { _pendingFlash = null; return 0; }
    _pendingFlash = null;
    // Scoped to the editor. A bare document.querySelector would happily match
    // a [data-line-id] row in some other mounted surface and flash a row the
    // user is not looking at.
    var view = document.getElementById('estimate-editor-view');
    if (!view) return 0;
    var ep = FLASH.claim();
    var painted = 0, i = 0;
    function paint(o) {
      // The row's DOM address is the ENCODED id (js/dom-ref.js), not the
      // stored bytes — the raw value could carry a quote, or a CR the HTML
      // parser would have rewritten on the way in, and the flash would land
      // on nothing.
      var _enc = window.p86DomRef ? window.p86DomRef.enc(o.lineId) : String(o.lineId).replace(/"/g, '\\"');
      var el = view.querySelector('[data-line-id="' + _enc + '"]');
      if (!el) return;
      var cls = 'p86lw-flash-' + (o.kind === 'add' ? 'add' : 'edit');
      el.classList.remove(cls);
      void el.offsetWidth;              // restart the keyframe
      el.classList.add(cls);
      setTimeout(function () { el.classList.remove(cls); }, 1800);
      if (painted === 0) { try { el.scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (_) {} }
      painted++;
    }
    (function step() {
      // Two checks, and they catch different things. The EPOCH catches
      // supersession — a newer flash took the region. The IDENTITY check
      // catches the editor closing or swapping estimates, which no claim
      // anywhere would signal, so folding it into the owner would lose it.
      if (!FLASH.guard(ep, 'flash')) return;
      // Past MAX_REVEALS the rest paint at once. A 400-line rewrite staggered
      // at 180ms would animate for 72 seconds — long after the user has moved
      // on, and long enough that the editor may have re-rendered underneath.
      if (i >= MAX_REVEALS) { while (i < p.ops.length) paint(p.ops[i++]); return; }
      if (i >= p.ops.length) return;
      if (String(openEditorEstimateId()) !== String(p.estimateId)) return;
      paint(p.ops[i++]);
      FLASH.after(ep, STAGGER_MS, step);
    })();
    return p.ops.length;
  }

  // ── event wiring ─────────────────────────────────────────────────────────
  // Client-initiated applies (Approve click / low-risk auto-apply).
  function onApplied(ev) {
    try {
      var d = ev && ev.detail;
      if (!d) return;
      ingest(d.apply_changeset, {
        payloadId: d.payload_id,
        state: 'applied',
        title: d.title || '',
        summary: d.apply_summary || '',
        emittingAgentKey: d.emitting_agent_key || '',
        appliedAt: new Date().toISOString()
      });
    } catch (e) {
      console.warn('[live-writer] render failed:', e);
    }
  }
  document.addEventListener('p86:payload-applied', onApplied);

  // ── poller ────────────────────────────────────────────────────────────────
  // Server-side / pre-approved applies AND background Scribe drafts never fire
  // a client event, so sweep the payloads feed. This is what makes the
  // coworker's autonomous work visible at all.
  function authHeaders() {
    try { var t = localStorage.getItem('p86-auth-token'); return t ? { Authorization: 'Bearer ' + t } : {}; }
    catch (_) { return {}; }
  }
  async function fetchJson(url) {
    var r = await fetch(url, { credentials: 'include', headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status + ' ' + url);
    return r.json();
  }
  async function fetchPayload(id) {
    var det = await fetchJson('/api/payloads/' + encodeURIComponent(id));
    // GET /:id nests the row under .payload (res.json({ payload: row })).
    // The v2 poller read det.apply_changeset directly and therefore rendered
    // nothing, ever. Keep the .payload hop.
    return (det && det.payload) || det || null;
  }
  function stateOf(row) {
    switch (row && row.status) {
      case 'ready': return 'proposed';
      case 'applying': return 'applying';
      case 'applied': return 'applied';
      case 'failed': return 'failed';
      case 'rejected': return 'rejected';
      default: return null;
    }
  }
  function metaFromRow(row, state) {
    return {
      payloadId: row.id,
      state: state,
      title: row.title || '',
      summary: row.apply_summary || row.summary || '',
      emittingAgentKey: row.emitting_agent_key || '',
      createdAt: row.created_at || null,
      appliedAt: row.applied_at || null,
      applyError: row.apply_error || null,
      isDraft: state !== 'applied',
      // A failed row with NO targets never became a payload at all — it is a
      // recorded REFUSAL (the Scribe could not author the change), not an
      // apply that blew up. Only the detail fetch carries targets; the lean
      // list row does not, and `undefined` correctly reads as "don't know".
      neverDrafted: Array.isArray(row.targets) ? row.targets.length === 0 : false
    };
  }

  // A write we can see the existence of but not the content of. The list row
  // is thin, but it is not nothing: it proves the write reached this state.
  // Say only that, and say plainly that the rest is unknown — never fall back
  // to the cheerful branch just because the detail fetch is the thing that
  // broke.
  function noticeUnreadable(row, state, err) {
    try {
      /* ROUND 6 — THE FOURTH FORM, AND IT POINTS THE OTHER WAY.
       *
       * This used to call reportToStrip() DIRECTLY, so it reached surface B's
       * chrome without passing through broadcast(), and WRITES.report() was
       * therefore never called for it. Measured live by 500-ing one real
       * applied row's detail fetch: the strip said "Scribe wrote something
       * this view could not read" — truthful, a write DID land — while the
       * ledger stayed at gen 0 / subject null and a pinned Cowork document
       * went on reading as the latest. Two surfaces on one screen disagreeing
       * about whether a write landed: S7, round 4's own defect, reopened
       * through the one report path that skipped the seam.
       *
       * broadcast()'s comment says "a surface cannot skip a call it does not
       * make". This function did not make it. So it makes it now: the
       * unreadable fact rides on the ENTRY rather than being handed to
       * describe() at one call site, and this goes through the fan-out like
       * every other row. Cowork gets first refusal (it re-fetches the detail
       * itself, which is the honest thing to offer), surface B paints the same
       * amber notice it painted before when Cowork is not up, and the ledger
       * hears about it either way.
       *
       * ingest() is deliberately NOT the entry point: ingestRow marked this
       * key seen before calling here, so ingest() would dedupe it to null and
       * the write would go unreported — which is the defect, restored. */
      var entry = {
        meta: metaFromRow(row, state), groups: [], changeset: [],
        rows: function () { return null; },
        unreadable: { message: (err && err.message) || 'fetch failed', tries: MAX_DETAIL_RETRIES }
      };
      broadcast(entry);
    } catch (e) { console.warn('[live-writer] unreadable notice failed', e); }
  }

  // Ingest one list row: fetch its detail, pick the RIGHT changeset column
  // for its state, and hand it to the engine.
  async function ingestRow(row) {
    var state = stateOf(row);
    if (!state) return null;
    var key = row.id + ':' + state;
    if (_seen[key]) return null;
    var det;
    try { det = await fetchPayload(row.id); }
    catch (e) {
      // Do NOT mark it seen — an unreadable detail must be retried on the
      // next sweep, or one 500 makes that write permanently invisible.
      //
      // BOUNDED, because "retry forever" would hammer a permanently-500ing
      // row every 5s for the life of the tab and never tell anyone. Three
      // sweeps (~15s); after that stop asking and SAY SO, using the only
      // facts the lean list row actually proves — that the write reached this
      // state, and that its detail could not be read. The alternative is the
      // write silently vanishing, which is the defect class this whole
      // surface exists to end.
      _detailRetry[key] = (_detailRetry[key] || 0) + 1;
      console.warn('[live-writer] payload detail fetch failed for', row.id,
        '(attempt ' + _detailRetry[key] + ' of ' + MAX_DETAIL_RETRIES + ')', e && e.message);
      if (_detailRetry[key] >= MAX_DETAIL_RETRIES) {
        delete _detailRetry[key];
        _seen[key] = true;
        noticeUnreadable(row, state, e);
      }
      return null;
    }
    delete _detailRetry[key];
    if (!det) return null;
    var realState = stateOf(det) || state;
    // apply_changeset = committed. draft_changeset = simulation.
    //
    // An APPLIED row shows ONLY the committed column, with no fallback to the
    // draft. That fallback looks harmless and is the whole bug back again:
    // the bookkeeping UPDATE has a failure path that stamps
    // status='applied' WITHOUT apply_changeset, so falling back would paint
    // the rolled-back simulation under an "Applied" header. Better to say
    // "no diff was recorded" than to show a plausible wrong one.
    var cs = (realState === 'applied')
      ? (det.apply_changeset || [])
      : (det.draft_changeset || []);
    var meta = metaFromRow(det, realState);
    meta.isDraft = realState !== 'applied';
    var entry = ingest(cs, meta);

    // Server-side / approve-in-chat applies never fire the client apply
    // event, so re-emit it — ai-panel's listener fans out to the entity
    // caches so the affected list + detail repaint LIVE. Applied rows only,
    // and exactly once: a draft has changed nothing, so re-hydrating the app
    // for it would be a lie in a different register.
    if (realState === 'applied' && Array.isArray(det.apply_changeset) && det.apply_changeset.length) {
      try {
        document.dispatchEvent(new CustomEvent('p86:payload-applied', { detail: {
          payload_id: det.id,
          title: det.title || '',
          emitting_agent_key: det.emitting_agent_key || '',
          apply_summary: det.apply_summary || '',
          affected_targets: det.apply_changeset.map(function (e) { return { entity_type: e.entity_type, entity_id: e.id }; }),
          apply_changeset: det.apply_changeset
        } }));
      } catch (_) {}
    }
    return entry;
  }

  /* One sweep. Returns TRUE only if the feed was actually read — the composing
   * card's backstop needs to distinguish "checked, not there" from "couldn't
   * check", and a swallowed catch cannot tell it apart. `force` runs the sweep
   * even in a hidden tab, which is exactly the case that backstop is for. */
  var _pollInFlight = null;
  async function pollApplies(force) {
    if (document.hidden && !force) return false;
    // NOT an epoch problem, and deliberately not solved with one: the 5s
    // interval, the composing backstop's forced sweep and _pollOnce can all
    // start a sweep, and three overlapping `for … await ingestRow` loops
    // interleave their baseline arithmetic arbitrarily. One sweep at a time;
    // a caller that arrives mid-sweep joins the one already running.
    if (_pollInFlight) return _pollInFlight;
    _pollInFlight = pollOnce();
    try { return await _pollInFlight; } finally { _pollInFlight = null; }
  }
  async function pollOnce() {
    try {
      var j = await fetchJson('/api/payloads/?limit=12&order=activity');
      var rows = j.payloads || j.rows || j || [];
      var fresh = rows.filter(function (p) {
        if (!p || !p.id) return false;
        var st = stateOf(p);
        if (!st) return false;
        var key = p.id + ':' + st;
        if (_seen[key]) return false;
        // A row whose DETAIL fetch failed is re-offered regardless of either
        // baseline. Holding the baseline back (below) is not enough on its
        // own: rows are swept oldest-first, so a NEWER sibling in the same
        // batch would advance the baseline past the failed row and the
        // strictly-greater compare would hide it from every later sweep —
        // exactly the "one 500 makes that write permanently invisible"
        // outcome the retry was written to prevent.
        if (_detailRetry[key]) return true;
        if (st === 'applied' || st === 'failed') {
          var at = Date.parse(p.applied_at || p.activity_at || p.created_at || '');
          return isFinite(at) && at > _appliedBaselineTs;
        }
        if (st === 'proposed') {
          // Its OWN clock. See _draftBaselineTs.
          //
          // has_draft/has_diff is no longer a REQUIREMENT, only a fast path.
          // Requiring it meant a draft that landed with no recordable
          // changeset was never ingested at all: clearComposing() never ran
          // and the handoff card timed out claiming the draft never arrived.
          // A draft that exists is news whether or not its diff is
          // renderable — there is a truthful rendering for the diff-less
          // case now (draftNoDiffWhy).
          var ct = Date.parse(p.created_at || '');
          if (!(isFinite(ct) && ct > _draftBaselineTs)) return false;
          if (p.has_draft || p.has_diff) return true;
          // ...but a draft with NO diff yet is only news once the recorder
          // has had its chance. The row is inserted before the dry run even
          // starts, so "no before/after was recorded" is momentarily true of
          // every draft — and reporting it marks the row seen for this state,
          // which would bury the diff that lands a second later.
          var first = _draftFirstSeen[p.id] || (_draftFirstSeen[p.id] = Date.now());
          return (Date.now() - first) >= DRAFT_SETTLE_MS;
        }
        return false;   // 'applying' is transient; the next sweep sees its outcome
      }).sort(function (a, b) {
        return Date.parse(a.activity_at || a.created_at || 0) - Date.parse(b.activity_at || b.created_at || 0);
      });
      for (var i = 0; i < fresh.length; i++) {
        var p = fresh[i];
        await ingestRow(p);
        // Advance the baseline only AFTER the row is accounted for. It used to
        // advance FIRST, which quietly defeated the retry above: the row's
        // applied_at then EQUALLED the baseline, and the filter is strictly
        // greater, so a single transient 500 on /api/payloads/:id hid that
        // write until a page reload — and the poller is the only path that
        // ever sees a server-side apply.
        if (_detailRetry[p.id + ':' + stateOf(p)]) continue;
        var ts = Date.parse(p.applied_at || '');
        if (isFinite(ts) && ts > _appliedBaselineTs) _appliedBaselineTs = ts;
      }
      return true;
    } catch (e) {
      // Loud enough to debug, quiet enough not to spam a 5s loop.
      if (!pollApplies._warned) { pollApplies._warned = true; console.warn('[live-writer] poll failed:', e && e.message); }
      return false;
    }
  }

  // Establish baselines (everything already on screen at load = history, do
  // not replay it) then start sweeping. Retry until an authenticated fetch
  // succeeds so we never replay old writes as if they were live.
  var _pollStarted = false;
  async function initPoll() {
    if (_pollStarted) return;
    try {
      var j = await fetchJson('/api/payloads/?limit=20&order=activity');
      var rows = j.payloads || j.rows || j || [];
      _draftBaselineTs = Date.now();
      rows.forEach(function (p) {
        if (p.applied_at) { var ts = Date.parse(p.applied_at); if (ts > _appliedBaselineTs) _appliedBaselineTs = ts; }
        // Mark TERMINAL states seen only. An 'applying' row is mid-commit —
        // stamping it here would blind us to its outcome; a 'ready' row is a
        // live draft the user may still act on.
        var st = stateOf(p);
        if (st === 'applied' || st === 'rejected' || st === 'failed') _seen[p.id + ':' + st] = true;
      });
      _pollStarted = true;
      // Wrapped, not passed bare: pollApplies' first argument is `force`, and
      // a timer implementation that hands its callback anything truthy would
      // start sweeping a hidden tab every 5 seconds.
      setInterval(function () { pollApplies(); }, POLL_MS);
    } catch (_) { setTimeout(initPoll, 6000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPoll);
  else initPoll();

  // ── public API ───────────────────────────────────────────────────────────
  window.p86LiveWriter = {
    /* Render straight from a changeset array (bypasses the event). */
    render: function (changeset, meta) { return !!ingest(changeset, meta || { state: 'applied' }); },
    /* THE differ. changeset[] → groups[] with per-op lineId. */
    diff: diffChangeset,
    /* THE estimate row model. one changeset entry → {name, rows[], deletes[]}. */
    rows: buildEstimateRows,
    /* Fan-out registration for surfaces A and C. */
    registerSurface: registerSurface,
    /* Install the shared diff/row CSS. Surfaces that render engine markup
     * without going through the strip or the pane must call this, or their
     * op rows and estimate rows land unstyled. */
    ensureStyle: ensureStyle,
    /* Ingest a fetched payload row (Cowork rehydrate / manual verification). */
    ingest: ingest,
    ingestRow: ingestRow,
    fetchPayload: fetchPayload,
    /* Shared copy: why a draft has no before/after. ONE wording, so Cowork and
     * the strip cannot drift into telling the user two different stories about
     * the same row. */
    draftNoDiffWhy: draftNoDiffWhy,
    /* THE decision layer, re-exported so surface A reaches the same predicate
     * and the same sentences rather than re-deriving them. Cowork calling
     * anything else here is how R5 grew a copy in the first place. */
    model: M,
    /* THE write ledger — one instance, owned here, shared. Cowork registers
     * its document against THIS object; a second ledger would be two answers
     * to "which write is current", which is the defect wearing a new hat. */
    writes: WRITES,
    /* Fired by the estimate editor's post-hydrate refresh (surface C). */
    flashEditorRows: flashEditorRows,
    /* The handoff placeholder. */
    startComposing: startComposing,
    clearComposing: clearComposing,
    dismiss: dismiss,
    _diffEntry: diffEntry,
    _metaFromRow: metaFromRow,
    /* One sweep, on demand. The interval owns the live loop; this is the seam
     * the composing backstop and the tests drive. */
    _pollOnce: pollApplies,
    _usd: usd,
    _relTime: relTime,
    _agentLabel: agentLabel
  };
})();
