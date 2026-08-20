// Live Rooms phase 02 — the guest renderer.
//
// This is NOT a redactor. The redactor is server-side, in
// server/services/live-view.js, and the promise it keeps is that a hidden
// number never reaches these bytes at all. What lives here is a TYPED RENDERER
// with no numeric fallback path — which is the client-side half of the same
// idea, stated as a property of the code rather than as a rule to remember:
//
//   a money slot arrives as { m: <number> } or as { r: true }, and there is no
//   third branch. There is no `|| 0` in this file. So the failure mode of a
//   missing figure is a dash, never "$0.00" — js/app.js:56 is
//   `format(val || 0)`, which is exactly how a job sold at zero gets rendered
//   confidently in the same style as a real one.
//
// js/jobs.js:3410 already prints "—" rather than "0.0%" in one place, because
// "0.0%" would read as a job sold at zero margin rather than one not yet
// priced. That comment is this file's whole specification, generalised.
//
// ══ WHAT THIS FILE DOES NOT LOAD ══════════════════════════════════════════
// index.html carries 124 <script src> tags; index.html + js/** + nodegraph/**
// is about 7.9 MB unbundled with no code splitting. But SIZE IS THE SECOND
// PROBLEM. The first is js/app.js loadData(): eight ORG-WIDE GETs in one
// Promise.all — every job, every estimate, every QB cost line, the whole sub
// directory, every PO, CO, bill and AR invoice. A guest shell that boots the
// SPA is a guest shell that downloads the company. That is not a redaction
// problem; it is the app's normal startup.
//
// So the guest page loads THIS file and nothing else of the app's JS. Named
// consequences, each closing a real hole:
//   • js/api.js's 401 -> localStorage.removeItem -> location.reload() never
//     runs, so there is no reload loop (the sub-portal scar).
//   • loadFromLocalStorage / writeToLocalStorage never run, so no org money is
//     written to a guest's disk and nothing survives the session.
//   • hasCapability does not exist on the page, so js/auth.js's offline-admin
//     grant is unreachable.
//
// ══ AND WHAT IT DOES COPY ═════════════════════════════════════════════════
// The first build drew bespoke markup, and the result was correct and looked
// like a different, thinner product. The rule now is:
//
//     THE GUEST PAGE COPIES THE APP'S MARKUP, CLASSES AND TOKENS.
//     IT NEVER LINKS THE APP'S CODE.
//
// So the renderers below emit the app's own class names — .card, .p86-totals-
// strip / .p86-totals-chip, the app's table chrome — against css/live-surface.
// css, which scripts/build-live-surface-css.js extracts from css/styles.css.
// Same chips, same tokens, same type; none of the 253 top-level functions in
// js/jobs.js, none of its write paths, and no appData.
//
// Copying is what makes fidelity possible here: the reusable unit in this
// codebase is markup + class, not function. Every real renderer takes a jobId
// and reaches for appData itself, so there is no component to call with a
// projected document — and two of them would actively misbehave if there were:
// js/jobs.js coTotal recomputes CO money from c.lines (which the projection
// deliberately never ships) and would print $0.00 on every row, and
// js/insights.js num() returns 0 for anything non-numeric, so its <tfoot>
// would print a confident "$0" company total. Reuse would have reached the
// exact failure this file exists to prevent.
//
// Corrected, because the note that used to sit here read as licence: the page
// does NOT link css/styles.css, and must not. See css/live-view.css for why —
// 92 KB gzipped of desktop-workspace rules, including bare `button`, `input`,
// `table`, `th` and `td` selectors, against a 28 KB guest shell.

(function () {
  'use strict';

  // ══ PURE CORE ═══════════════════════════════════════════════════════════
  // No DOM, no network. Exported for the test suite so the tests exercise the
  // code that actually ships.

  var FRESH_MS = 35000;      // same clock as the phase-01 roster, deliberately
  var UNKNOWN_MS = 60000;
  var ATTEMPTS_BEFORE_UNKNOWN = 3;

  // A money cell has exactly two shapes and this function has exactly two
  // branches. Anything else is a dash, because "I do not have this" and "this
  // is zero" are materially different things.
  function cellText(cell, unit) {
    if (!cell || typeof cell !== 'object') return '—';
    if (cell.r === true) return '—';
    if (typeof cell.m !== 'number' || !isFinite(cell.m)) return '—';
    if (unit === '%') return cell.m.toFixed(1) + '%';
    try {
      return cell.m.toLocaleString('en-US', {
        style: 'currency', currency: 'USD',
        minimumFractionDigits: 2, maximumFractionDigits: 2
      });
    } catch (e) {
      return '$' + cell.m.toFixed(2);
    }
  }

  function isRedacted(cell) { return !!(cell && cell.r === true); }

  // A PERCENTAGE THAT IS NOT A MONEY CELL — % complete, % used. Same discipline
  // and for the same reason: null means "there is no denominator", which is a
  // different fact from 0%, and js/insights.js fmtPct(null) returning '0%' is
  // precisely the confident-zero this whole design is built against. There is
  // no fallback branch here either.
  function pctText(n) {
    if (typeof n !== 'number' || !isFinite(n)) return '—';
    return (Math.round(n * 10) / 10) + '%';
  }

  function reasonText(reason, hostName) {
    var who = hostName || 'The host';
    switch (reason) {
      case 'off_room': return who + ' is on a different record — not shared.';
      case 'not_shared': return who + " is on a screen that isn't shared.";
      case 'away': return who + ' stepped away from this job.';
      default: return who + ' is on a screen that isn\'t shared.';
    }
  }

  // THE MIRROR'S HONESTY RULE, one layer over the roster's.
  //
  // Phase 01: "if I cannot verify who is watching, I must not draw their
  // faces." Here: IF I CANNOT VERIFY WHAT HE IS LOOKING AT, I MUST NOT CLAIM
  // TO BE FOLLOWING IT.
  //
  // Note what `broken` does NOT do: it does not blank the document. Those
  // numbers were real when they were fetched, and blanking them is its own
  // lie. What is withdrawn is the CLAIM — the surface gets stamped with when it
  // was fetched and the Following indicator goes off.
  //
  // multiInstance is its own terminal-ish branch and it is the most important
  // one here. On cursors, a wrong replica is a MISSING cursor. On a mirror, a
  // wrong replica is a guest confidently watching the wrong page while the bar
  // says Live. The host's strip already warns; the guest's warning is the one
  // that matters, because the guest is the one being misled.
  function mirrorState(s) {
    s = s || {};
    var who = s.hostName || 'the host';
    if (s.terminal) return { kind: 'ended', claim: '', note: '', showBack: false, stamp: false };

    if (s.multiInstance) {
      return {
        kind: 'broken', claim: 'Not following',
        note: "This session keeps moving between servers — we can't tell what " + who + ' is looking at.',
        showBack: false, stamp: true
      };
    }

    var since = (s.msSinceFrame == null) ? Infinity : s.msSinceFrame;
    var attempts = s.attempts || 0;

    if (attempts >= ATTEMPTS_BEFORE_UNKNOWN || since >= UNKNOWN_MS) {
      return {
        kind: 'broken', claim: 'Disconnected',
        note: "Disconnected — we can't tell what " + who + ' is looking at.',
        showBack: false, stamp: true
      };
    }
    if (attempts > 0 || since >= FRESH_MS) {
      return {
        kind: 'unconfirmed', claim: 'Reconnecting',
        note: 'Reconnecting — this may not be what ' + who + ' is looking at.',
        showBack: false, stamp: true
      };
    }

    var hostSurface = s.hostSurface || null;
    if (!hostSurface) {
      return {
        kind: 'not_shared', claim: 'Not following',
        note: reasonText(s.hostReason, s.hostName ? (s.hostName.charAt(0).toUpperCase() + s.hostName.slice(1)) : null),
        showBack: false, stamp: false
      };
    }
    if (s.following && s.mySurface === hostSurface) {
      return { kind: 'following', claim: 'Following ' + who, note: '', showBack: false, stamp: false };
    }
    // An informed choice, not a mystery button: it says WHERE it will take you.
    return {
      kind: 'unfollowed', claim: 'Not following', note: '',
      showBack: true,
      backLabel: 'Back to ' + who + (s.hostSurfaceLabel ? ' — ' + s.hostSurfaceLabel : ''),
      stamp: false
    };
  }

  // "exactly when the link stops working" — a clock time AND a countdown. A
  // countdown alone is not a time anyone can plan around, and a clock time
  // alone makes you do arithmetic in a meeting.
  function expiryText(expiresAt, now) {
    var t = Date.parse(expiresAt);
    if (!isFinite(t)) return '';
    var d = new Date(t);
    var clock;
    try { clock = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { clock = d.toISOString().slice(11, 16); }
    var left = t - (now || Date.now());
    if (left <= 0) return 'The link has stopped working.';
    var mins = Math.floor(left / 60000);
    var h = Math.floor(mins / 60), m = mins % 60;
    var rel = h > 0 ? (h + 'h ' + m + 'm') : (m + 'm');
    return 'Link stops working at ' + clock + ' (in ' + rel + ')';
  }

  function stampText(at) {
    var t = Date.parse(at);
    if (!isFinite(t)) return '';
    try { return 'as of ' + new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
    catch (e) { return 'as of ' + new Date(t).toISOString().slice(11, 16); }
  }

  var Core = {
    FRESH_MS: FRESH_MS,
    UNKNOWN_MS: UNKNOWN_MS,
    cellText: cellText,
    pctText: pctText,
    isRedacted: isRedacted,
    reasonText: reasonText,
    mirrorState: mirrorState,
    expiryText: expiryText,
    stampText: stampText
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined') return;   // Node: the pure core only.

  // ══ RENDERER ════════════════════════════════════════════════════════════

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A money slot, rendered. `is-redacted` is a STYLE hook, never a mechanism —
  // there is nothing under it to reveal, which is the difference between this
  // and a blur someone can peel off in dev tools.
  function cellHtml(cell, unit) {
    var txt = cellText(cell, unit);
    return '<span class="lv-money' + (isRedacted(cell) ? ' is-redacted' : '') + '">' + esc(txt) + '</span>';
  }

  // A percentage slot, rendered. Distinct class from .lv-money so a dash here
  // and a dash there are styled by what they MEAN.
  function pctHtml(n) {
    var known = (typeof n === 'number' && isFinite(n));
    return '<span class="lv-pct' + (known ? '' : ' is-unknown') + '">' + esc(pctText(n)) + '</span>';
  }

  // A meter. Width comes from the RATIO, never from a figure — there is no
  // figure here to come from, which is the point. Over-budget is its own state
  // because "97% used" and "162% used" are the two things a superintendent is
  // actually looking for.
  function meterHtml(pct) {
    if (typeof pct !== 'number' || !isFinite(pct)) return '';
    var w = Math.max(0, Math.min(100, pct));
    var tone = pct > 100 ? ' is-over' : (pct > 85 ? ' is-near' : '');
    return '<span class="lv-meter' + tone + '"><span style="width:' + w + '%"></span></span>';
  }

  // ── The app's chip ribbon ────────────────────────────────────────────────
  // index.html:1061-1093, class for class. `tone` arrives as DATA on the
  // document — accent / warn / info — and is validated against a fixed list
  // here, so a colour is never picked from the sign of a value the guest does
  // not have. renderJobDetail sets .style.color from the sign of the figure in
  // five places; transcribing that would have made colour a channel.
  var CHIP_TONES = { accent: 1, warn: 1, info: 1, dim: 1 };
  function chipsHtml(chips) {
    if (!chips || !chips.length) return '';
    var html = '<div class="p86-totals-strip job-totals-strip">';
    for (var i = 0; i < chips.length; i++) {
      var c = chips[i];
      var tone = (c.tone && CHIP_TONES[c.tone] === 1) ? (' ' + c.tone) : '';
      var value = (typeof c.pct === 'number' || c.cell == null)
        ? pctHtml(c.pct) : cellHtml(c.cell, c.unit);
      html += '<div class="p86-totals-chip' + tone + '">' +
              '<div class="p86-totals-chip-label">' + esc(c.label) + '</div>' +
              '<div class="p86-totals-chip-value">' + value + '</div>' +
              (typeof c.pct === 'number'
                ? '<div class="job-totals-chip-sub">' + meterHtml(c.pct) + '</div>' : '') +
              '</div>';
    }
    return html + '</div>';
  }

  // ── Surface 1: the job information card ─────────────────────────────────
  // index.html:1005 #job-info-card, minus its two write affordances (the Edit
  // button in the markup, and the second one renderJobDetail injects into
  // job-info-address at runtime along with a Google Maps deep link — an
  // outbound URL carrying the address, on a page whose premise is "talks to
  // exactly six endpoints").
  //
  // EVERY SLOT IS WRITTEN ON EVERY PAINT. The app's markup hard-codes "$0.00"
  // as the default text of its value cells; a filler that SKIPS a missing field
  // leaves a confident $0.00 in the DOM — the exact failure the money-cell
  // design exists to prevent, walking back in through markup reuse. Nothing
  // below is conditional on a value being present.
  function overviewHtml(v) {
    var html = '<div class="card lv-jobcard p86-surface">';
    html += '<div class="lv-jobcard-head">' +
            '<div class="lv-jobcard-id">' +
              '<div class="lv-eyebrow">Job Information</div>' +
              '<div class="lv-jobname">' + esc(v.title || '—') + '</div>' +
              '<div class="lv-jobaddr">' + esc(v.address || '—') + '</div>' +
            '</div>' +
            '<span class="lv-statuspill">' + esc(v.status || '—') + '</span>' +
            '</div>';

    html += '<div class="lv-tiles">';
    for (var i = 0; i < (v.tiles || []).length; i++) {
      var t = v.tiles[i];
      html += '<div class="lv-tile' + (t.tone === 'accent' ? ' is-accent' : '') + '">' +
              '<div class="lv-tile-k">' + esc(t.label) + '</div>' +
              '<div class="lv-tile-v">' + cellHtml(t.cell, t.unit) + '</div></div>';
    }
    html += '</div>';

    html += '<div class="lv-meta">';
    for (var j = 0; j < (v.facts || []).length; j++) {
      var f = v.facts[j];
      html += '<div class="lv-meta-cell"><div class="lv-meta-k">' + esc(f.label) + '</div>' +
              '<div class="lv-meta-v">' + esc(f.value == null || f.value === '' ? '—' : f.value) + '</div></div>';
    }
    html += '</div></div>';

    html += chipsHtml(v.chips);
    return html;
  }

  // ── Surface 2: the WIP report ───────────────────────────────────────────
  // index.html:1121-1226, same five groups in the same order with the same row
  // labels, which is what makes "look at As Sold Gross Profit" land on both
  // screens without a coordinate. Two columns on a wide screen, one on a phone
  // — fidelity of LOOK is not fidelity of LAYOUT, and the app's grid here is a
  // desktop `1fr 1fr` at 12px. The breakpoint lives in css/live-view.css.
  var SEC_TONES = { accent: 1, good: 1, warn: 1, orange: 1 };
  function wipHtml(v) {
    var html = chipsHtml(v.chips);
    html += '<div class="card p86-surface"><h3 class="lv-cardtitle">WIP Report Calculations</h3>';
    html += '<div class="lv-wipgrid">';
    for (var i = 0; i < (v.sections || []).length; i++) {
      var s = v.sections[i];
      var tone = (s.tone && SEC_TONES[s.tone] === 1) ? (' is-' + s.tone) : '';
      html += '<section class="lv-wipsec"><h4 class="lv-wiph' + tone + '">' + esc(s.heading) + '</h4>';
      for (var j = 0; j < (s.rows || []).length; j++) {
        var r = s.rows[j];
        var value = (typeof r.pct === 'number' || r.cell == null) ? pctHtml(r.pct) : cellHtml(r.cell, r.unit);
        html += '<div class="lv-wiprow' + (r.strong ? ' is-strong' : '') + '">' +
                '<span class="lv-wipk">' + esc(r.label) + '</span>' +
                '<span class="lv-wipv">' + value + '</span></div>';
      }
      html += '</section>';
    }
    return html + '</div></div>';
  }

  // ── Surface 3: the job cost summary ─────────────────────────────────────
  // The table the study drew: cost code, budget, committed, actual, variance,
  // % used with a meter. Hand-built on purpose. js/insights.js renderReport is
  // the nearest real component and it is disqualified three ways: its rows are
  // one-per-JOB company-wide (first two columns are other jobs' numbers and
  // titles), its <tfoot> sums cells through a num() that returns 0 for
  // anything non-numeric — a confident "$0" company total in the slot a total
  // belongs — and its cell colour is picked from num(v) < 0. What is worth
  // borrowing from it is the idea it already ships: money is a TYPE on the
  // column, not a guess about the value. That idea is the server's.
  function costHtml(v) {
    var cols = v.columns || [];
    if (!v.rows || !v.rows.length) return '<p class="lv-empty">No cost codes on this job yet.</p>';
    var html = '<div class="card p86-surface"><h3 class="lv-cardtitle">Job Cost Summary</h3>';
    html += '<div class="table-container"><table class="lv-cost"><thead><tr>';
    for (var c = 0; c < cols.length; c++) {
      html += '<th' + (c === 0 ? '' : ' class="lv-num"') + '>' + esc(cols[c]) + '</th>';
    }
    html += '</tr></thead><tbody>';
    for (var i = 0; i < v.rows.length; i++) html += costRow(v.rows[i], false);
    html += '</tbody>';
    // The total is the SERVER's, summed from real figures before redaction.
    // Nothing on this page adds a column of cells up.
    if (v.total) html += '<tfoot>' + costRow(v.total, true) + '</tfoot>';
    return html + '</table></div></div>';
  }

  function costRow(r, isTotal) {
    return '<tr' + (isTotal ? ' class="is-total"' : '') + '>' +
      '<th scope="row">' + esc(r.label || '—') + '</th>' +
      '<td class="lv-num">' + cellHtml(r.budget) + '</td>' +
      '<td class="lv-num">' + cellHtml(r.committed) + '</td>' +
      '<td class="lv-num">' + cellHtml(r.actual) + '</td>' +
      '<td class="lv-num">' + cellHtml(r.variance) + '</td>' +
      '<td class="lv-num lv-usedcell">' + meterHtml(r.pctUsed) + pctHtml(r.pctUsed) + '</td>' +
      '</tr>';
  }

  // ── Surface 4: change orders ────────────────────────────────────────────
  function coHtml(v) {
    if (!v.count) return '<div class="card p86-surface"><p class="lv-empty">No change orders on this job.</p></div>';
    var html = '<div class="card p86-surface"><h3 class="lv-cardtitle">Change Orders</h3>';
    html += '<div class="table-container"><table class="lv-co"><thead><tr>' +
            '<th>CO</th><th>Status</th><th>Scope</th><th class="lv-num">Income</th><th class="lv-num">Cost</th>' +
            '</tr></thead><tbody>';
    for (var i = 0; i < v.rows.length; i++) {
      var r = v.rows[i];
      html += '<tr>' +
        '<td>' + esc(r.number || '—') + '</td>' +
        '<td><span class="lv-chip">' + esc(r.status || '—') + '</span>' +
          (r.approved ? '<span class="lv-sub">' + esc(r.approved) + '</span>' : '') + '</td>' +
        '<td class="lv-prose">' + esc(r.description || '') + '</td>' +
        '<td class="lv-num">' + cellHtml(r.income) + '</td>' +
        '<td class="lv-num">' + cellHtml(r.costs) + '</td>' +
        '</tr>';
    }
    return html + '</tbody></table></div></div>';
  }

  var RENDERERS = {
    'job-overview': overviewHtml,
    'job-wip-report': wipHtml,
    'job-cost-summary': costHtml,
    'job-changeorders': coHtml
  };

  // The renderer is an allow-list too. A surface the server invented and this
  // build does not know how to draw says so, rather than painting a blank card
  // that looks like an empty job.
  function render(el, doc) {
    if (!el) return;
    if (!doc || !doc.surface || !Object.prototype.hasOwnProperty.call(RENDERERS, doc.surface)) {
      el.innerHTML = '<div class="card"><p class="lv-empty">This screen is not available in the viewer.</p></div>';
      return;
    }
    // The compact job header the app puts above its sub-tabs, so every surface
    // says which job it is rather than only the first one.
    var html = doc.title ? '<div class="lv-jobhead">' + esc(doc.title) + '</div>' : '';
    el.innerHTML = html + RENDERERS[doc.surface](doc);
  }

  window.p86LiveView = {
    core: Core,
    render: render,
    cellText: cellText,
    pctText: pctText,
    mirrorState: mirrorState,
    expiryText: expiryText,
    stampText: stampText,
    reasonText: reasonText
  };
})();
