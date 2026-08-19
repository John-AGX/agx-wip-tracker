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
// Recorded rather than discovered: the page DOES link css/styles.css for
// content styling, which ships class names for surfaces a guest cannot reach.
// That is a leak of feature names, not of data, and it is the same exposure
// index.html already has to any unauthenticated visitor.

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

  function factsHtml(facts) {
    var out = '';
    for (var i = 0; i < (facts || []).length; i++) {
      var f = facts[i];
      if (f.value == null || f.value === '') continue;
      out += '<div class="lv-fact"><dt>' + esc(f.label) + '</dt><dd>' + esc(f.value) + '</dd></div>';
    }
    return out ? '<dl class="lv-facts">' + out + '</dl>' : '';
  }

  function overviewHtml(v) {
    var pct = (typeof v.progress === 'object' && v.progress && typeof v.progress.pct === 'number')
      ? v.progress.pct : null;
    var html = '';
    html += '<div class="lv-tiles">';
    for (var i = 0; i < (v.tiles || []).length; i++) {
      var t = v.tiles[i];
      html += '<div class="lv-tile"><div class="lv-tile-k">' + esc(t.label) + '</div>' +
              '<div class="lv-tile-v">' + cellHtml(t.cell, t.unit) + '</div></div>';
    }
    html += '</div>';
    if (pct != null) {
      html += '<div class="lv-progress"><div class="lv-progress-k">Complete</div>' +
              '<div class="lv-progress-bar"><span style="width:' + Math.max(0, Math.min(100, pct)) + '%"></span></div>' +
              '<div class="lv-progress-v">' + esc(pct.toFixed(1)) + '%</div></div>';
    }
    html += factsHtml(v.facts);
    return html;
  }

  function wipHtml(v) {
    var html = '';
    if (typeof v.pctComplete === 'number') {
      html += '<div class="lv-progress"><div class="lv-progress-k">Complete</div>' +
              '<div class="lv-progress-bar"><span style="width:' + Math.max(0, Math.min(100, v.pctComplete)) + '%"></span></div>' +
              '<div class="lv-progress-v">' + esc(v.pctComplete.toFixed(1)) + '%</div></div>';
    }
    for (var i = 0; i < (v.sections || []).length; i++) {
      var s = v.sections[i];
      // Wide content scrolls INSIDE ITSELF. A guest shell whose body scrolls
      // sideways on a phone is unusable in a truck, which is the stated case.
      html += '<div class="lv-sec"><h3>' + esc(s.heading) + '</h3><div class="lv-scroll"><table class="lv-table"><tbody>';
      for (var j = 0; j < (s.rows || []).length; j++) {
        var r = s.rows[j];
        html += '<tr><th scope="row">' + esc(r.label) + '</th><td>' + cellHtml(r.cell, r.unit) + '</td></tr>';
      }
      html += '</tbody></table></div></div>';
    }
    return html;
  }

  function coHtml(v) {
    if (!v.count) return '<p class="lv-empty">No change orders on this job.</p>';
    var html = '<div class="lv-scroll"><table class="lv-table lv-co"><thead><tr>' +
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
    return html + '</tbody></table></div>';
  }

  var RENDERERS = {
    'job-overview': overviewHtml,
    'job-wip-report': wipHtml,
    'job-changeorders': coHtml
  };

  // The renderer is an allow-list too. A surface the server invented and this
  // build does not know how to draw says so, rather than painting a blank card
  // that looks like an empty job.
  function render(el, doc) {
    if (!el) return;
    if (!doc || !doc.surface || !Object.prototype.hasOwnProperty.call(RENDERERS, doc.surface)) {
      el.innerHTML = '<p class="lv-empty">This screen is not available in the viewer.</p>';
      return;
    }
    var html = '';
    if (doc.title) html += '<h2 class="lv-title">' + esc(doc.title) + '</h2>';
    html += RENDERERS[doc.surface](doc);
    el.innerHTML = html;
  }

  window.p86LiveView = {
    core: Core,
    render: render,
    cellText: cellText,
    mirrorState: mirrorState,
    expiryText: expiryText,
    stampText: stampText,
    reasonText: reasonText
  };
})();
