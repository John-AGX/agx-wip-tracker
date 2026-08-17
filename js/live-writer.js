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
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86LiveWriter) return;

  // The decision layer. Loaded as a plain script before this one in the app;
  // required directly under jest.
  var M = (typeof window !== 'undefined' && window.p86LiveWriterModel) || null;
  if (!M && typeof require === 'function') { try { M = require('./live-writer-model.js'); } catch (_) {} }
  if (!M) { console.warn('[live-writer] decision layer missing — engine not started'); return; }

  // Four owned regions. Per-region, not one global counter: a Cowork selection
  // must not supersede a strip stagger loop, and vice versa. The strip CARD and
  // the strip PILL share one owner on purpose — they are two renderings of one
  // claim, and a design that lets them be claimed separately is the original
  // defect wearing a different hat.
  var STRIP = M.makeOwner('strip');
  var PANE  = M.makeOwner('pane');
  var FLASH = M.makeOwner('editor-flash');

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
    var SKIP = { lines: 1 };
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
    var SKIP = { id: 1, created_at: 1, updated_at: 1, organization_id: 1, user_id: 1, data: 1, lines: 1 };
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
    // The "handed to the Scribe" placeholder is stale the moment a state
    // change lands, whoever reports it.
    //
    // This used to run BEFORE broadcast and unconditionally remove the strip
    // root — which destroyed the strip even for writes Cowork claimed (a
    // report landing somewhere else entirely), and produced a visible
    // remove-then-rebuild flash when the strip DID claim. Running it after,
    // and guarding it on the strip epoch, fixes both: if surface B repainted
    // the strip it already superseded the placeholder and this is a no-op; if
    // the write was reported elsewhere the strip has nothing left to say.
    clearComposing();
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
      // light mode
      'body.light-mode #p86-live-writer{color:#1a1a1f;}',
      'body.light-mode #p86-live-writer .p86lw-card,body.light-mode #p86-live-writer .p86lw-pill{background:#fff;border-color:rgba(0,0,0,0.10);box-shadow:0 12px 40px rgba(0,0,0,0.14);}',
      'body.light-mode .p86lw-head,body.light-mode .p86lw-foot{border-color:rgba(0,0,0,0.08);}',
      'body.light-mode .p86lw-sub,body.light-mode .p86lw-grpname,body.light-mode .p86lw-lbl .l2,body.light-mode .p86lw-foot{color:#6b6b76;}',
      'body.light-mode .p86lw-amt{color:#44444a;}',
      'body.light-mode .p86lw-delete .l1{color:#a33;}',
      'body.light-mode .p86lw-view{border-color:rgba(0,0,0,0.18);color:#44444a;}',
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

  var ICON = { add: '+', edit: '~', delete: '−' };

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
    if (!report || report.kind === 'silent') return null;   // claim nothing, disturb nothing
    // The pane belongs to this surface too, so a report that is NOT a pane
    // supersedes any pane still standing. Found by the interleaving property,
    // not by inspection: after applied-estimate → applied-lead, the estimate
    // DOCUMENT sat on screen under a pill describing a different write — the
    // exact inverse of F3, one region asserting an older report than another.
    if (report.kind !== 'pane') dismissPane();
    ensureRoot();
    var ep = STRIP.claim();                                  // AFTER the silent decision
    root.classList.remove('p86lw-collapsed');
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
          '<span class="p86lw-i">' + ICON[o.kind] + '</span>' +
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
    if (root) { root.remove(); root = null; }
    dismissPane();
  }

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
  var composingTimer = null, composingEpoch = 0;
  function startComposing(label, opts) {
    opts = opts || {};
    var viaScribe = opts.tool !== 'emit_payload_file';
    var report = M.describe({}, { composing: { label: label, viaScribe: viaScribe } });
    reportToStrip({ meta: {} }, report);
    var ep = STRIP.current();
    composingEpoch = ep;
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
   * showing. Under epochs this is the whole check: if any other report has
   * claimed the strip since, the placeholder is already gone and tearing the
   * root down here would destroy someone else's card. */
  function clearComposing() {
    if (!STRIP.holds(composingEpoch)) return;
    STRIP.claim();                    // supersede everything the placeholder scheduled
    composingTimer = null;
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
        inEditor: (entry.claimedBy || []).indexOf('editor-flash') >= 0
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
      var el = view.querySelector('[data-line-id="' + String(o.lineId).replace(/"/g, '\\"') + '"]');
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
      // Goes through the SAME boundary as every other report, which is what
      // makes it supersede the composing placeholder. It used to call
      // showNotice directly and never touch _composing, so 180 seconds after
      // this truthful amber notice rendered, the backstop replaced it with
      // "hasn't come back / Nothing has landed here in three minutes" — both
      // clauses false, about a write this very function had just reported.
      var entry = { meta: metaFromRow(row, state), groups: [], changeset: [] };
      reportToStrip(entry, M.describe(entry, {
        unreadable: { message: (err && err.message) || 'fetch failed', tries: MAX_DETAIL_RETRIES }
      }));
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
