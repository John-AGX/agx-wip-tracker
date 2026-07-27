/* ────────────────────────────────────────────────────────────────────────
 * live-writer.js — the "Scribe live writer" surface (Slice 1).
 *
 * Watches for p86:payload-applied and renders what the Scribe just wrote as
 * an animated, color-coded diff in a docked strip — add (green), edit
 * (amber, before→after), delete (red, struck). This is the "coworker shows
 * its work" surface: 86 keeps talking in the chat while this narrates the
 * write landing.
 *
 * Slice 1 fires on APPLY (post-commit) and reveals the diff line-by-line for
 * the live feel. The diff is derived from the dispatcher's apply_changeset
 * ({entity_type, id, before, after} full-row snapshots) — for estimates we
 * diff before.data.lines vs after.data.lines to get precise per-line deltas.
 * Nothing here writes; it only visualizes what the server already committed.
 *
 * Promotes later into the center pane (A) / in-editor highlight (C) — same
 * event, richer host. See docs / project_86_scribe_rework memory.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86LiveWriter) return;

  var COLLAPSE_MS = 14000;  // auto-collapse to a pill after this idle
  var STAGGER_MS = 180;     // per-op reveal delay for the "writing" feel
  var MAX_OPS = 24;         // cap rendered rows (rest summarized)
  var POLL_MS = 5000;       // how often to sweep for server-side/pre-approved applies
  var _shown = Object.create(null);  // payload_id → true, so we render each apply once
  var _baselineTs = 0;      // ignore applies that predate page load

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

  // ── diff one changeset entry into a list of ops ──────────────────────────
  // Returns { entity_type, name, ops:[{kind:'add'|'edit'|'delete', label, detail, amount}], impact }
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
        ops.push({ kind: 'delete', label: l.description || 'line', detail: lineMeta(l), amount: c });
      }
    });
    // adds — new in after
    al.forEach(function (l) {
      if (isHeaderLine(l)) return;
      if (!bById[l.id]) {
        var c = lineCost(l);
        if (c != null) impact += c;
        ops.push({ kind: 'add', label: l.description || 'line', detail: lineMeta(l), amount: c });
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
      ops.push({ kind: 'edit', label: l.description || b.description || 'line', detail: changes.join(' · '), amount: ac });
    });

    return { entity_type: 'estimate', name: name, ops: ops, impact: impact };
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

  // generic scalar-field diff for non-estimate entities
  function diffFields(et, name, before, after) {
    var ops = [];
    var SKIP = { id: 1, created_at: 1, updated_at: 1, organization_id: 1, user_id: 1, data: 1, lines: 1 };
    var b = before || {}, a = after || {};
    if (!before && after) { ops.push({ kind: 'add', label: 'created', detail: name, amount: null }); }
    else if (before && !after) { ops.push({ kind: 'delete', label: 'deleted', detail: name, amount: null }); }
    else {
      Object.keys(a).forEach(function (k) {
        if (SKIP[k]) return;
        var bv = b[k], av = a[k];
        if (av && typeof av === 'object') return; // skip nested
        if (String(bv == null ? '' : bv) === String(av == null ? '' : av)) return;
        ops.push({
          kind: 'edit', label: k.replace(/_/g, ' '),
          detail: (bv == null || bv === '' ? '∅' : String(bv).slice(0, 40)) + '→' + (av == null || av === '' ? '∅' : String(av).slice(0, 40)),
          amount: null
        });
      });
    }
    return { entity_type: et, name: name, ops: ops, impact: 0 };
  }

  // ── DOM ──────────────────────────────────────────────────────────────────
  var root = null, body = null, collapseTimer = null;

  function ensureStyle() {
    if (document.getElementById('p86lw-style')) return;
    var css = [
      '#p86-live-writer{position:fixed;right:16px;bottom:16px;width:390px;max-width:calc(100vw - 32px);',
      'z-index:99998;font-family:inherit;color:#e7e7ea;pointer-events:none;}',
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
      '.p86lw-del{background:rgba(226,75,74,0.13);} .p86lw-del .p86lw-i{color:#e24b4a;}',
      '.p86lw-lbl{flex:1;min-width:0;}',
      '.p86lw-lbl .l1{font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.p86lw-del .l1{text-decoration:line-through;color:#e88;}',
      '.p86lw-lbl .l2{font-size:11px;color:#9a9aa5;margin-top:1px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.p86lw-amt{flex:none;font-variant-numeric:tabular-nums;font-size:11px;color:#c9c9d2;padding-left:4px;}',
      '.p86lw-foot{display:flex;align-items:center;gap:8px;padding:9px 13px;border-top:1px solid rgba(255,255,255,0.08);font-size:11px;color:#9a9aa5;}',
      '.p86lw-imp{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;}',
      '.p86lw-imp.pos{color:#1d9e75;} .p86lw-imp.neg{color:#e24b4a;}',
      '.p86lw-view{background:none;border:1px solid rgba(255,255,255,0.16);color:#c9c9d2;border-radius:7px;',
      'padding:3px 9px;font-size:11px;cursor:pointer;}',
      '.p86lw-view:hover{border-color:rgba(255,255,255,0.4);color:#fff;}',
      // light mode
      'body.light-mode #p86-live-writer{color:#1a1a1f;}',
      'body.light-mode #p86-live-writer .p86lw-card,body.light-mode #p86-live-writer .p86lw-pill{background:#fff;border-color:rgba(0,0,0,0.10);box-shadow:0 12px 40px rgba(0,0,0,0.14);}',
      'body.light-mode .p86lw-head,body.light-mode .p86lw-foot{border-color:rgba(0,0,0,0.08);}',
      'body.light-mode .p86lw-sub,body.light-mode .p86lw-grpname,body.light-mode .p86lw-lbl .l2,body.light-mode .p86lw-foot{color:#6b6b76;}',
      'body.light-mode .p86lw-amt{color:#44444a;}',
      'body.light-mode .p86lw-del .l1{color:#a33;}',
      'body.light-mode .p86lw-view{border-color:rgba(0,0,0,0.18);color:#44444a;}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'p86lw-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  function ensureRoot() {
    ensureStyle();
    if (root && document.body.contains(root)) return;
    root = document.createElement('div');
    root.id = 'p86-live-writer';
    root.innerHTML =
      '<div class="p86lw-full"><div class="p86lw-card"></div></div>' +
      '<div class="p86lw-pill"><span class="p86lw-dot" style="animation:none;background:#1d9e75"></span>' +
      '<span class="p86lw-pilltext">Scribe wrote</span></div>';
    document.body.appendChild(root);
    root.querySelector('.p86lw-pill').addEventListener('click', function () {
      root.classList.remove('p86lw-collapsed');
      armCollapse();
    });
  }

  function armCollapse() {
    if (collapseTimer) clearTimeout(collapseTimer);
    collapseTimer = setTimeout(function () {
      if (root) root.classList.add('p86lw-collapsed');
    }, COLLAPSE_MS);
  }

  var ICON = { add: '+', edit: '~', delete: '−' };

  // Render a set of diffed groups. `writing` shows the pulsing "writing" head
  // briefly, then settles to the ✓ "wrote" state.
  function show(groups, meta) {
    ensureRoot();
    var totalOps = groups.reduce(function (n, g) { return n + g.ops.length; }, 0);
    if (!totalOps) return; // nothing meaningful to show
    root.classList.remove('p86lw-collapsed');

    var netImpact = groups.reduce(function (s, g) { return s + (g.impact || 0); }, 0);
    var counts = { add: 0, edit: 0, delete: 0 };
    groups.forEach(function (g) { g.ops.forEach(function (o) { counts[o.kind]++; }); });

    var card = root.querySelector('.p86lw-card');
    var name = (groups.length === 1) ? groups[0].name : (groups.length + ' records');
    var openBtn = (groups.length === 1 && groups[0].entity_type === 'estimate' && meta && meta.estimateId)
      ? '<button class="p86lw-view" data-open="' + esc(meta.estimateId) + '">Open</button>' : '';

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

    var summ = [];
    if (counts.add) summ.push('+' + counts.add + ' added');
    if (counts.edit) summ.push(counts.edit + ' edited');
    if (counts.delete) summ.push('−' + counts.delete + ' removed');

    var impHtml = '';
    if (netImpact) {
      impHtml = '<span class="p86lw-imp ' + (netImpact > 0 ? 'pos' : 'neg') + '">' +
        (netImpact > 0 ? '+' : '−') + usd(Math.abs(netImpact)) + '</span>';
    }

    card.innerHTML =
      '<div class="p86lw-head">' +
        '<span class="p86lw-av">S</span>' +
        '<div><div class="p86lw-ttl">Scribe <span class="p86lw-verb">is writing</span></div>' +
        '<div class="p86lw-sub">' + esc(name) + '</div></div>' +
        '<span class="p86lw-dot" title="writing"></span>' +
        '<button class="p86lw-x" title="Dismiss">×</button>' +
      '</div>' +
      '<div class="p86lw-body">' + rows + '</div>' +
      '<div class="p86lw-foot">' + esc(summ.join(' · ')) + openBtn + impHtml + '</div>';

    card.querySelector('.p86lw-x').addEventListener('click', dismiss);
    var ob = card.querySelector('.p86lw-view[data-open]');
    if (ob) ob.addEventListener('click', function () {
      var id = ob.getAttribute('data-open');
      try {
        if (window.openEstimate) window.openEstimate(id);
        else if (window.router && window.router.navigate) window.router.navigate('estimate/' + id);
      } catch (e) { console.warn('[live-writer] open failed', e); }
    });

    requestAnimationFrame(function () { card.classList.add('p86lw-in'); });

    // staggered reveal → the "writing" feel, then settle to "wrote ✓"
    var opEls = card.querySelectorAll('.p86lw-op');
    var i = 0;
    (function reveal() {
      if (i < opEls.length) {
        opEls[i].classList.add('p86lw-shown');
        i++;
        setTimeout(reveal, STAGGER_MS);
      } else {
        var verb = card.querySelector('.p86lw-verb');
        var dot = card.querySelector('.p86lw-head .p86lw-dot');
        if (verb) verb.textContent = 'wrote';
        if (dot) { dot.style.animation = 'none'; dot.style.background = '#1d9e75'; }
        armCollapse();
      }
    })();

    // keep a short pill label reflecting the last write
    var pill = root.querySelector('.p86lw-pilltext');
    if (pill) pill.textContent = 'Scribe wrote · ' + summ.join(', ');
  }

  function dismiss() {
    if (collapseTimer) clearTimeout(collapseTimer);
    if (root) { root.remove(); root = null; }
  }

  // ── event wiring ─────────────────────────────────────────────────────────
  // Render a changeset array; returns true if anything was shown. Dedupes by
  // payload id so the client event and the poller can't double-render one apply.
  function renderChangeset(cs, payloadId) {
    if (payloadId && _shown[payloadId]) return false;
    if (!Array.isArray(cs) || !cs.length) return false;
    var groups = cs.map(diffEntry).filter(function (g) { return g && g.ops && g.ops.length; });
    if (!groups.length) return false;
    if (payloadId) _shown[payloadId] = true;
    var meta = {};
    if (groups.length === 1 && cs.length === 1 && cs[0].entity_type === 'estimate') meta.estimateId = cs[0].id;
    show(groups, meta);
    return true;
  }

  // Client-initiated applies (Approve click / low-risk auto-apply) arrive here.
  function onApplied(ev) {
    try {
      var d = ev && ev.detail;
      if (!d) return;
      renderChangeset(d.apply_changeset, d.payload_id);
    } catch (e) {
      console.warn('[live-writer] render failed:', e);
    }
  }
  document.addEventListener('p86:payload-applied', onApplied);

  // ── poller ────────────────────────────────────────────────────────────────
  // Server-side / pre-approved applies (86 "just does it") never fire the client
  // event above, so sweep the payloads feed for freshly-applied rows and surface
  // them too — this is what makes the coworker's autonomous writes VISIBLE.
  function authHeaders() {
    try { var t = localStorage.getItem('p86-auth-token'); return t ? { Authorization: 'Bearer ' + t } : {}; }
    catch (_) { return {}; }
  }
  async function pollApplies() {
    if (document.hidden) return;
    try {
      var r = await fetch('/api/payloads/?limit=8', { credentials: 'include', headers: authHeaders() });
      if (!r.ok) return;
      var j = await r.json();
      var rows = j.payloads || j.rows || j || [];
      var fresh = rows.filter(function (p) {
        return p && p.status === 'applied' && p.applied_at &&
               Date.parse(p.applied_at) > _baselineTs && !_shown[p.id];
      }).sort(function (a, b) { return Date.parse(a.applied_at) - Date.parse(b.applied_at); });
      for (var i = 0; i < fresh.length; i++) {
        var p = fresh[i];
        var ts = Date.parse(p.applied_at);
        if (ts > _baselineTs) _baselineTs = ts;
        _shown[p.id] = true; // claim it up-front so a slow detail fetch can't double-fire
        try {
          var dr = await fetch('/api/payloads/' + encodeURIComponent(p.id), { credentials: 'include', headers: authHeaders() });
          if (!dr.ok) continue;
          var det = await dr.json();
          // GET /:id nests the row under .payload (res.json({ payload: row }))
          var cs = (det && det.payload) ? det.payload.apply_changeset : (det && det.apply_changeset);
          delete _shown[p.id];            // let renderChangeset re-claim + actually render
          renderChangeset(cs, p.id);
        } catch (_) {}
      }
    } catch (_) {}
  }
  // Establish a baseline (applies before now = history, don't replay) then start
  // sweeping. Retry until an authenticated fetch succeeds so we never replay old
  // applies as if they were live.
  var _pollStarted = false;
  async function initPoll() {
    if (_pollStarted) return;
    try {
      var r = await fetch('/api/payloads/?limit=8', { credentials: 'include', headers: authHeaders() });
      if (!r.ok) { setTimeout(initPoll, 6000); return; }
      var j = await r.json();
      var rows = j.payloads || j.rows || j || [];
      rows.forEach(function (p) {
        if (p.applied_at) { var ts = Date.parse(p.applied_at); if (ts > _baselineTs) _baselineTs = ts; }
        if (p.status !== 'ready') _shown[p.id] = true; // terminal already — never a "live" write
      });
      _pollStarted = true;
      setInterval(pollApplies, POLL_MS);
    } catch (_) { setTimeout(initPoll, 6000); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initPoll);
  else initPoll();

  // ── public API (also handy for manual verification) ──────────────────────
  window.p86LiveWriter = {
    /* Render straight from an apply_changeset array (bypasses the event). */
    render: function (changeset, meta) {
      var groups = (changeset || []).map(diffEntry).filter(function (g) { return g && g.ops && g.ops.length; });
      if (groups.length) show(groups, meta || {});
    },
    dismiss: dismiss,
    _diffEntry: diffEntry
  };
})();
