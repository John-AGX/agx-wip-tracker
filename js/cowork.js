/* ────────────────────────────────────────────────────────────────────────
 * cowork.js — Surface A: the Cowork page. The Live Writer's HOME.
 *
 * The docked strip (surface B) is a NOTIFICATION: singleton, destructive,
 * auto-dismissing, one write, no action. That is right for a notification
 * and wrong for a home. This page is the home because it is the only
 * surface with state that outlives a single write, and the only one where
 * you can act on what you are looking at:
 *
 *   · HISTORY   a ledger of what the coworker did, not just the newest row
 *   · LIFECYCLE drafts are visible here; the strip only ever showed applies
 *   · ACTION    the diff and the Approve button in ONE place
 *   · NO TIMER  it is a page; leaving it is the dismissal
 *
 * A is a place you GO. B is what tells you to go there. This page never
 * auto-navigates — stealing nav mid-task is exactly what a "coworker"
 * surface must not do.
 *
 * It owns no diffing. p86LiveWriter.diff() / .rows() are THE differ and THE
 * row model; this file is a chrome over them. If this file ever grows its
 * own line comparison, the one-engine design has failed.
 *
 * MONEY BOUNDARY: signed cost IMPACT only, per group, straight off the
 * engine. Never a grand estimate total — that would contradict the one
 * totals engine. There is deliberately no code path here that sums line
 * costs, so a competing total cannot be computed by accident.
 *
 * A DRAFT IS NOT A DOCUMENT. draft_changeset comes from a dry run that was
 * rolled back: its line ids were minted at dispatch and will never exist,
 * its `before` is stale, and a second pending draft on the same estimate
 * isn't in it. So a proposed write renders as OPS ("proposes to…"), and
 * only a committed apply_changeset is rendered as a document.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86Cowork) return;

  var LEDGER_PAGE = 25;
  var _rows = [];              // ledger rows (list shape)
  var _byId = Object.create(null);
  var _selectedId = null;
  var _pinned = false;         // true once the user picks a row by hand
  var _unread = 0;             // writes that landed while pinned elsewhere
  var _loading = false;
  var _exhausted = false;
  var _mobileView = 'doc';     // 'doc' | 'ledger' (segmented switch, mobile only)

  function isMobile() {
    try { return window.matchMedia('(max-width:768px) and (pointer:coarse)').matches; }
    catch (_) { return false; }
  }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function LW() { return window.p86LiveWriter || null; }
  function usd(n) {
    var lw = LW();
    if (lw && lw._usd) return lw._usd(n);
    return (n == null || !isFinite(n)) ? '—' : ('$' + Number(n).toFixed(2));
  }
  function relTime(iso) { var lw = LW(); return (lw && lw._relTime) ? lw._relTime(iso) : ''; }
  function agentLabel(k) { var lw = LW(); return (lw && lw._agentLabel) ? lw._agentLabel(k) : (k || 'Scribe'); }
  function authHeaders() {
    try { var t = localStorage.getItem('p86-auth-token'); return t ? { Authorization: 'Bearer ' + t } : {}; }
    catch (_) { return {}; }
  }
  function isActive() {
    var el = document.getElementById('cowork');
    return !!(el && el.classList.contains('active'));
  }

  // Five real states. Every one is a column value, not a mood — and each has
  // a defined rendering, including the ones that used to render as silence.
  var STATE_META = {
    ready:    { key: 'proposed', label: 'Proposed', tone: 'warn' },
    applying: { key: 'applying', label: 'Applying…', tone: 'info' },
    applied:  { key: 'applied',  label: 'Applied',  tone: 'ok' },
    failed:   { key: 'failed',   label: 'Failed',   tone: 'bad' },
    rejected: { key: 'rejected', label: 'Dismissed', tone: 'mute' }
  };
  function stateOf(row) { return STATE_META[row && row.status] || { key: 'unknown', label: String((row && row.status) || '—'), tone: 'mute' }; }

  // ── styles ───────────────────────────────────────────────────────────────
  function ensureStyle() {
    // The document + ops markup below reuses the engine's .p86lw-* / .p86lp-*
    // classes. Those live in the engine's style block, which is only injected
    // when the strip or the pane first renders — so a Cowork page opened
    // before any notification has fired would paint them unstyled.
    try { if (LW() && LW().ensureStyle) LW().ensureStyle(); } catch (_) {}
    if (document.getElementById('p86cw-style')) return;
    var css = [
      '#coworkHost{display:grid;grid-template-columns:minmax(0,1fr) 420px;gap:14px;align-items:start;}',
      '#cw-left{display:grid;grid-template-columns:236px minmax(0,1fr);gap:12px;align-items:start;min-width:0;}',
      // .p86-ai-docked is height:100%!important, so in a height:auto grid cell
      // it collapses to zero. The explicit height is mandatory, not styling.
      '#cw-chat{height:calc(100vh - 190px);min-height:520px;}',
      '.cw-panel{background:var(--card,#16161c);border:1px solid var(--border,rgba(255,255,255,0.10));border-radius:14px;overflow:hidden;}',
      '.cw-phead{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));',
      'font-size:11px;font-weight:700;letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim,#9a9aa2);}',
      '.cw-pbody{max-height:calc(100vh - 250px);overflow-y:auto;}',
      // ledger rail
      '.cw-lrow{display:block;width:100%;text-align:left;background:none;border:none;border-bottom:1px solid var(--border,rgba(255,255,255,0.06));',
      'padding:9px 12px;cursor:pointer;color:inherit;font:inherit;}',
      '.cw-lrow:hover{background:rgba(127,127,140,0.10);}',
      '.cw-lrow.sel{background:rgba(55,138,221,0.14);box-shadow:inset 2px 0 0 #378add;}',
      '.cw-lttl{font-size:12px;font-weight:600;line-height:1.3;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '.cw-lmeta{display:flex;align-items:center;gap:6px;margin-top:3px;font-size:10px;color:var(--text-dim,#9a9aa2);}',
      '.cw-pill{font-size:9px;font-weight:700;padding:1px 6px;border-radius:9px;letter-spacing:.02em;flex:none;}',
      '.cw-pill.ok{background:rgba(29,158,117,.18);color:#1d9e75;}',
      '.cw-pill.warn{background:rgba(217,138,31,.18);color:#d98a1f;}',
      '.cw-pill.info{background:rgba(55,138,221,.18);color:#5aa6ea;}',
      '.cw-pill.bad{background:rgba(226,75,74,.18);color:#e24b4a;}',
      '.cw-pill.mute{background:rgba(127,127,140,.16);color:#9a9aa2;}',
      '.cw-money{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:600;font-size:10px;}',
      '.cw-money.pos{color:#1d9e75;} .cw-money.neg{color:#e24b4a;}',
      '.cw-more{width:100%;background:none;border:none;border-top:1px solid var(--border,rgba(255,255,255,0.08));',
      'color:var(--text-dim,#9a9aa2);font-size:11px;padding:9px;cursor:pointer;}',
      '.cw-more:hover{color:var(--text,#e7e7ea);}',
      // document column
      '.cw-dhead{display:flex;align-items:flex-start;gap:11px;padding:14px 16px;border-bottom:1px solid var(--border,rgba(255,255,255,0.08));}',
      '.cw-av{width:30px;height:30px;border-radius:50%;background:#378add;color:#fff;font-size:13px;font-weight:600;',
      'display:flex;align-items:center;justify-content:center;flex:none;}',
      '.cw-dttl{font-size:15px;font-weight:600;line-height:1.25;}',
      '.cw-dsub{font-size:11px;color:var(--text-dim,#9a9aa2);margin-top:2px;display:flex;align-items:center;gap:7px;flex-wrap:wrap;}',
      '.cw-dbody{padding:6px 8px 12px;max-height:calc(100vh - 300px);overflow-y:auto;}',
      '.cw-note{padding:14px 16px;font-size:12.5px;line-height:1.6;color:var(--text-dim,#9a9aa2);}',
      '.cw-err{padding:12px 16px;margin:10px 12px;border-radius:10px;background:rgba(226,75,74,0.12);color:#f0a9a8;',
      'font-size:12px;line-height:1.55;}',
      '.cw-actions{display:flex;align-items:center;gap:8px;padding:12px 16px;border-top:1px solid var(--border,rgba(255,255,255,0.08));flex-wrap:wrap;}',
      '.cw-btn{border-radius:8px;padding:6px 14px;font-size:12px;font-weight:600;cursor:pointer;border:1px solid transparent;}',
      '.cw-btn.pri{background:#1d9e75;color:#fff;} .cw-btn.pri:hover{filter:brightness(1.08);}',
      '.cw-btn.gho{background:none;border-color:var(--border,rgba(255,255,255,0.18));color:var(--text-dim,#c9c9d2);}',
      '.cw-btn.gho:hover{color:var(--text,#fff);}',
      '.cw-btn[disabled]{opacity:.55;cursor:default;}',
      '.cw-impact{margin-left:auto;font-variant-numeric:tabular-nums;font-weight:700;font-size:12px;}',
      '.cw-impact.pos{color:#1d9e75;} .cw-impact.neg{color:#e24b4a;}',
      '.cw-unread{background:#d98a1f;color:#2a1a03;font-size:9px;font-weight:800;padding:1px 6px;border-radius:9px;margin-left:auto;}',
      '.cw-seg{display:none;gap:4px;grid-column:1/-1;}',
      '.cw-seg button{flex:1;border:1px solid var(--border,rgba(255,255,255,0.14));background:none;color:var(--text-dim,#9a9aa2);',
      'border-radius:8px;padding:7px;font-size:12px;font-weight:600;cursor:pointer;}',
      '.cw-seg button.on{background:rgba(55,138,221,.16);color:#5aa6ea;border-color:rgba(55,138,221,.4);}',
      // While the chat is docked HERE, the panel's own Pending-approvals strip
      // must not render: it would put a SECOND live Approve button for the
      // same payload on the same screen, and approving in one leaves the
      // other clickable until its 15s poll. Scoped to the ANCESTOR, not to a
      // body class — the panel can be yanked back out to the drawer at any
      // moment by the header Ask-86 button, and a body class would leave the
      // approvals strip hidden in the drawer where it is the only control.
      // !important beats the inline display the panel sets on it.
      '#cw-chat #ai-pending-approvals{display:none !important;}',
      // Placeholder for exactly that yank: the singleton panel left for the
      // drawer and this column is now empty. :has() drives it so it is always
      // correct without polling; browsers without :has() simply never show it.
      '.cw-chat-empty{display:none;}',
      '@supports selector(:has(*)){#cw-chat:not(:has(.p86-ai-docked)) .cw-chat-empty{',
      'display:flex;flex-direction:column;align-items:flex-start;gap:9px;padding:16px;}}',
      // light mode
      'body.light-mode .cw-panel{background:#fff;border-color:rgba(0,0,0,0.10);}',
      'body.light-mode .cw-phead,body.light-mode .cw-dhead,body.light-mode .cw-actions{border-color:rgba(0,0,0,0.08);}',
      'body.light-mode .cw-lrow{border-bottom-color:rgba(0,0,0,0.06);}',
      'body.light-mode .cw-lrow:hover{background:rgba(0,0,0,0.04);}',
      'body.light-mode .cw-lrow.sel{background:rgba(55,138,221,0.10);}',
      'body.light-mode .cw-lmeta,body.light-mode .cw-dsub,body.light-mode .cw-note,body.light-mode .cw-more{color:#6b6b76;}',
      'body.light-mode .cw-err{background:rgba(226,75,74,0.10);color:#a33;}',
      'body.light-mode .cw-pill.ok{color:#0f6e56;} body.light-mode .cw-pill.warn{color:#8a5c0d;}',
      'body.light-mode .cw-pill.info{color:#1e6fb8;} body.light-mode .cw-pill.bad{color:#a33;}',
      'body.light-mode .cw-btn.gho{border-color:rgba(0,0,0,0.18);color:#44444a;}',
      // mobile — one column, no dock, segmented switch instead of a squeeze
      '@media (max-width:1180px){#coworkHost{grid-template-columns:minmax(0,1fr);} #cw-chat{display:none;}}',
      '@media (max-width:768px) and (pointer:coarse){',
      '#coworkHost{grid-template-columns:minmax(0,1fr);gap:10px;}',
      '#cw-left{grid-template-columns:minmax(0,1fr);gap:10px;}',
      '#cw-chat{display:none;}',
      '.cw-seg{display:flex;}',
      'body.cw-m-doc #cw-ledger-rail{display:none;} body.cw-m-ledger #cw-doc{display:none;}',
      // body reserves bottom-nav space, but that reservation does not
      // propagate into a nested scroll container.
      '.cw-pbody,.cw-dbody{max-height:none;overflow:visible;}',
      '#coworkHost{padding-bottom:calc(64px + env(safe-area-inset-bottom,0px));}}'
    ].join('');
    var st = document.createElement('style');
    st.id = 'p86cw-style';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── shell ────────────────────────────────────────────────────────────────
  function ensureShell() {
    ensureStyle();
    var host = document.getElementById('coworkHost');
    if (!host) return null;
    if (document.getElementById('cw-doc')) return host;
    host.innerHTML =
      '<div id="cw-left">' +
        // The switch sits OUTSIDE the rail on purpose: on mobile the rail is
        // one of the two things it toggles, so a switch inside it would
        // disappear along with it and strand the user on the Write view.
        '<div class="cw-seg">' +
          '<button data-cwseg="doc" class="on">Write</button>' +
          '<button data-cwseg="ledger">History</button>' +
        '</div>' +
        '<div class="cw-panel" id="cw-ledger-rail">' +
          '<div class="cw-phead">Writes<span id="cw-unread"></span></div>' +
          '<div class="cw-pbody" id="cw-ledger-body"></div>' +
        '</div>' +
        '<div class="cw-panel" id="cw-doc"></div>' +
      '</div>' +
      '<div id="cw-chat"><div class="cw-chat-empty cw-panel" style="width:100%;">' +
        '<div style="font-size:12.5px;line-height:1.55;color:var(--text-dim,#9a9aa2);">' +
        'The chat moved to the side drawer. There is only ever one — opening it from the ' +
        'header takes it out of this column.</div>' +
        '<button class="cw-btn gho" data-cwredock="1">Bring it back here</button>' +
      '</div></div>';
    // Delegated — the rail body is rebuilt on every ledger refresh.
    host.addEventListener('click', function (e) {
      var seg = e.target.closest && e.target.closest('[data-cwseg]');
      if (seg) { setMobileView(seg.getAttribute('data-cwseg')); return; }
      var row = e.target.closest && e.target.closest('[data-cwrow]');
      if (row) { selectRow(row.getAttribute('data-cwrow'), true); return; }
      var more = e.target.closest && e.target.closest('[data-cwmore]');
      if (more) { loadLedger({ append: true }); return; }
      var redock = e.target.closest && e.target.closest('[data-cwredock]');
      if (redock) { ensureDock(); return; }
    });
    setMobileView(_mobileView);
    return host;
  }

  function setMobileView(v) {
    _mobileView = (v === 'ledger') ? 'ledger' : 'doc';
    document.body.classList.toggle('cw-m-doc', _mobileView === 'doc');
    document.body.classList.toggle('cw-m-ledger', _mobileView === 'ledger');
    var host = document.getElementById('coworkHost');
    if (!host) return;
    host.querySelectorAll('[data-cwseg]').forEach(function (b) {
      b.classList.toggle('on', b.getAttribute('data-cwseg') === _mobileView);
    });
  }

  // ── the chat, MOVED (never duplicated) ───────────────────────────────────
  // dockInto reparents the SINGLETON #p86-ai-panel. Two consequences are real
  // and are stated in the UI rather than hidden:
  //   · dockInto opens against the global ask86 thread, so entering Cowork
  //     switches away from an entity-bound conversation;
  //   · undock() aborts an in-flight stream, so leaving mid-answer stops the
  //     visible stream (the server turn still completes and the panel's
  //     resume path recovers it).
  // No hostAgentKey: Cowork is where you talk to YOUR coworker, so the normal
  // routing decides the agent. Passing one would pin it and defeat that.
  function ensureDock() {
    if (isMobile()) return;   // the panel is already a full-screen drawer here
    var chatHost = document.getElementById('cw-chat');
    if (!chatHost || !(window.p86AI && typeof window.p86AI.dockInto === 'function')) return;
    var panel = document.getElementById('p86-ai-panel');
    if (panel && panel.parentNode === chatHost) return;   // idempotent
    try {
      window.p86AI.dockInto(chatHost, { currentContext: coworkContext() });
    } catch (e) { console.warn('[cowork] dock failed', e); }
  }
  // Nothing to tear down beyond the undock app.js already performs — the
  // approvals-strip suppression is scoped to #cw-chat as an ancestor, so it
  // stops applying the instant the panel leaves this column.
  function onLeave() {}

  function coworkContext() {
    return {
      entity_type: 'cowork', entity_label: 'Cowork',
      open_data_summary: 'The user is on the Cowork page — the live view of what you write. ' +
        'Drafts you hand to the Scribe appear there with their diff and an Approve button. ' +
        'Describe changes plainly; the page shows the work.'
    };
  }

  // ── ledger ───────────────────────────────────────────────────────────────
  async function fetchLedger(before) {
    var url = '/api/payloads/?limit=' + LEDGER_PAGE + '&order=activity' +
              (before ? ('&before=' + encodeURIComponent(before)) : '');
    var r = await fetch(url, { credentials: 'include', headers: authHeaders() });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    var j = await r.json();
    return j.payloads || j.rows || [];
  }

  async function loadLedger(opts) {
    opts = opts || {};
    if (_loading) return;
    _loading = true;
    var body = document.getElementById('cw-ledger-body');
    if (body && !_rows.length) body.innerHTML = '<div class="cw-note">Loading…</div>';
    try {
      var cursor = null;
      if (opts.append && _rows.length) cursor = _rows[_rows.length - 1].activity_at || _rows[_rows.length - 1].created_at;
      var page = await fetchLedger(cursor);
      if (opts.append) {
        if (!page.length) _exhausted = true;
        page.forEach(function (p) { if (!_byId[p.id]) { _rows.push(p); _byId[p.id] = p; } });
      } else {
        _rows = page; _byId = Object.create(null);
        page.forEach(function (p) { _byId[p.id] = p; });
        _exhausted = page.length < LEDGER_PAGE;
      }
      renderRail();
      // FIRST entry only: show the most recent write rather than a blank
      // page. Gated on there being no selection at all, not merely on
      // "unpinned" — a refresh triggered by a live write races the
      // broadcast handler's own selectRow, and without this guard the two
      // fight over the document column.
      if (!opts.append && !_selectedId && _rows.length) selectRow(_rows[0].id, false);
      else if (!_rows.length) renderEmptyDoc();
    } catch (e) {
      if (body) body.innerHTML = '<div class="cw-note">Couldn\'t load the writes ledger — ' + esc(e && e.message || 'network error') + '.</div>';
      console.warn('[cowork] ledger load failed', e);
    } finally { _loading = false; }
  }

  function renderRail() {
    var body = document.getElementById('cw-ledger-body');
    if (!body) return;
    if (!_rows.length) {
      body.innerHTML = '<div class="cw-note">Nothing written yet. When 86 or the Scribe changes something, it lands here.</div>';
      return;
    }
    var html = '';
    _rows.forEach(function (p) {
      var st = stateOf(p);
      html += '<button class="cw-lrow' + (p.id === _selectedId ? ' sel' : '') + '" data-cwrow="' + esc(p.id) + '">' +
        '<div class="cw-lttl">' + esc(p.title || p.summary || 'a change') + '</div>' +
        '<div class="cw-lmeta">' +
          '<span class="cw-pill ' + st.tone + '">' + esc(st.label) + '</span>' +
          '<span>' + esc(agentLabel(p.emitting_agent_key)) + '</span>' +
          '<span>' + esc(relTime(p.activity_at || p.applied_at || p.created_at)) + '</span>' +
        '</div>' +
      '</button>';
    });
    if (!_exhausted) html += '<button class="cw-more" data-cwmore="1">Load older…</button>';
    body.innerHTML = html;
    var u = document.getElementById('cw-unread');
    if (u) u.innerHTML = _unread ? ('<span class="cw-unread">' + _unread + ' new</span>') : '';
  }

  // ── document column ──────────────────────────────────────────────────────
  function renderEmptyDoc() {
    var doc = document.getElementById('cw-doc');
    if (doc) doc.innerHTML = '<div class="cw-note">Pick a write from the list to see exactly what changed.</div>';
  }

  async function selectRow(id, byHand) {
    if (!id) return;
    _selectedId = id;
    if (byHand) { _pinned = true; _unread = 0; if (isMobile()) setMobileView('doc'); }
    renderRail();
    var doc = document.getElementById('cw-doc');
    if (doc) doc.innerHTML = '<div class="cw-note">Loading the change…</div>';
    var lw = LW();
    if (!lw || !lw.fetchPayload) { if (doc) doc.innerHTML = '<div class="cw-note">Live Writer engine not loaded.</div>'; return; }
    try {
      var row = await lw.fetchPayload(id);
      if (_selectedId !== id) return;   // a newer selection won the race
      renderDoc(row);
    } catch (e) {
      if (doc) doc.innerHTML = '<div class="cw-err">Couldn\'t load this write: ' + esc(e && e.message || 'network error') + '</div>';
    }
  }

  function opsHtml(groups) {
    var ICON = { add: '+', edit: '~', delete: '−' };
    var html = '';
    groups.forEach(function (g) {
      if (groups.length > 1) html += '<div class="p86lw-grpname">' + esc(g.name) + '</div>';
      html += '<div class="p86lw-grp">';
      g.ops.forEach(function (o) {
        html += '<div class="p86lw-op p86lw-' + o.kind + ' p86lw-shown">' +
          '<span class="p86lw-i">' + ICON[o.kind] + '</span>' +
          '<span class="p86lw-lbl"><div class="l1">' + esc(o.label) + '</div>' +
          (o.detail ? '<div class="l2">' + esc(o.detail) + '</div>' : '') + '</span>' +
          (o.amount != null ? '<span class="p86lw-amt">' + usd(o.amount) + '</span>' : '') +
          '</div>';
      });
      html += '</div>';
    });
    return html;
  }

  // The COMMITTED estimate, rendered as a document. Reached only from an
  // applied row with a real apply_changeset — never from a draft.
  function documentHtml(entryCs) {
    var lw = LW();
    var model = lw.rows(entryCs);
    var html = '';
    model.rows.forEach(function (r) {
      if (r.kind === 'section') { html += '<div class="p86lp-sec">' + esc(r.label) + '</div>'; return; }
      var cls = (r.kind === 'add') ? 'add' : (r.kind === 'edit' ? 'edit' : '');
      var tag = (r.kind === 'add') ? '<span class="p86lp-tag tadd">new</span>'
              : (r.kind === 'edit' ? '<span class="p86lp-tag tedit">edited</span>' : '');
      var uc = (r.unitCost == null) ? '' : usd(r.unitCost);
      if (r.unitCostWas != null) uc = '<span class="p86lp-was">' + usd(r.unitCostWas) + '</span>' + usd(r.unitCost);
      html += '<div class="p86lp-row ' + cls + '">' +
        '<span class="r-d">' + esc(r.line.description || '') + tag + '</span>' +
        '<span>' + (r.line.qty == null || r.line.qty === '' ? '' : esc(r.line.qty)) + '</span>' +
        '<span>' + esc(r.line.unit || '') + '</span>' +
        '<span>' + uc + '</span>' +
        '<span>' + (r.cost != null ? usd(r.cost) : '') + '</span>' +
        '</div>';
    });
    if (model.deletes.length) {
      html += '<div class="p86lp-sec">Removed</div>';
      model.deletes.forEach(function (d) {
        html += '<div class="p86lp-del"><span style="font-weight:700">−</span>' +
          '<span class="r-d">' + esc(d.line.description || 'line') + '</span>' +
          '<span style="margin-left:auto;font-variant-numeric:tabular-nums">' +
          (d.cost != null ? usd(d.cost) : '') + '</span></div>';
      });
    }
    return html;
  }

  function renderDoc(row) {
    var doc = document.getElementById('cw-doc');
    var lw = LW();
    if (!doc || !lw) return;
    var st = stateOf(row);
    var who = agentLabel(row.emitting_agent_key);

    // Which changeset is TRUE for this state? apply_changeset is what the
    // dispatcher committed; draft_changeset is a rolled-back simulation.
    var committed = Array.isArray(row.apply_changeset) ? row.apply_changeset : null;
    var draft = Array.isArray(row.draft_changeset) ? row.draft_changeset : null;
    var isApplied = row.status === 'applied' && committed && committed.length;
    // An applied row NEVER falls back to the draft. The bookkeeping UPDATE
    // has a failure path that stamps status='applied' without the changeset,
    // and a not-applied row never gets one at all — so a fallback would show
    // a rolled-back simulation under an "Applied" header, which is the exact
    // class of lie this page exists to end.
    var appliedNoDiff = row.status === 'applied' && !isApplied;
    var cs = isApplied ? committed : (row.status === 'applied' ? [] : (draft || []));
    var groups = lw.diff(cs);
    var impact = groups.reduce(function (s, g) { return s + (g.impact || 0); }, 0);

    var when = row.applied_at || row.draft_changeset_at || row.created_at;
    var head =
      '<div class="cw-dhead">' +
        '<span class="cw-av">' + esc(who.charAt(0)) + '</span>' +
        '<div style="min-width:0;flex:1;">' +
          '<div class="cw-dttl">' + esc(row.title || row.summary || 'a change') + '</div>' +
          '<div class="cw-dsub">' +
            '<span class="cw-pill ' + st.tone + '">' + esc(st.label) + '</span>' +
            '<span>' + esc(who) + '</span>' +
            '<span>' + esc(relTime(when)) + '</span>' +
            (row.status === 'ready' ? '<span>proposed — nothing has changed yet</span>' : '') +
          '</div>' +
        '</div>' +
      '</div>';

    var bodyHtml = '';
    if (row.status === 'failed') {
      bodyHtml = '<div class="cw-err"><strong>This write failed and nothing was changed.</strong><br>' +
        esc(row.apply_error || 'The dispatcher rejected it; no reason was recorded.') + '</div>';
      if (groups.length) bodyHtml += '<div class="cw-note" style="padding-bottom:4px;">What it would have done:</div>' +
        '<div class="cw-dbody">' + opsHtml(groups) + '</div>';
    } else if (row.status === 'applying') {
      bodyHtml = '<div class="cw-note">This write is being applied right now. The result — applied or failed — ' +
        'lands here within a few seconds. If it is still here in five minutes the apply was abandoned ' +
        '(a deploy mid-flight will do it) and the claim releases itself so it can be approved again.</div>';
      if (groups.length) bodyHtml += '<div class="cw-dbody">' + opsHtml(groups) + '</div>';
    } else if (!groups.length) {
      // Two different silences, and they deserve different words.
      // (a) The entity type records no snapshot — schedule / system /
      //     assembly / deal_memory have no table in the dispatcher's map, so
      //     there is genuinely no before/after to show.
      // (b) The row says applied but carries no committed changeset.
      // Either way: say so. Rendering nothing reads as "it didn't happen".
      // THREE different silences, and they are three different claims. Saying
      // the wrong one is the same defect as showing the wrong diff.
      var why;
      if (appliedNoDiff && draft) {
        why = 'This write applied, but the server didn\'t record a before/after for it, so what you\'d ' +
              'see here would be the Scribe\'s draft — a simulation that was rolled back, not what ' +
              'actually landed. It isn\'t shown for that reason.';
      } else if (cs.length) {
        why = 'The server did record a before/after for this write, but nothing in it comes out as a ' +
              'change this view can list. Only what it says it did is shown.';
      } else {
        why = 'This kind of write doesn\'t record a before/after diff yet, so there is nothing to show ' +
              'line by line — only what it says it did.';
      }
      bodyHtml = '<div class="cw-note">' +
        esc(row.apply_summary || row.summary || 'No line-level detail was recorded for this write.') +
        '<br><br>' + why + '</div>';
    } else if (isApplied && cs.length === 1 && cs[0].entity_type === 'estimate' &&
               cs[0].after && cs[0].after.data && Array.isArray(cs[0].after.data.lines) && cs[0].after.data.lines.length) {
      // The document highlights the rows that moved — but ops WITHOUT a
      // lineId have no row to highlight, so in the document they are
      // invisible. Seen live: a scope write rendered the whole estimate with
      // nothing marked, i.e. "here is the estimate, good luck spotting it".
      // State those ops above the document; the document is the context.
      var offRow = groups.map(function (g) {
        return { name: g.name, ops: g.ops.filter(function (o) { return !o.lineId; }) };
      }).filter(function (g) { return g.ops.length; });
      bodyHtml = (offRow.length
          ? '<div class="cw-note" style="padding-bottom:2px;">What changed:</div>' +
            '<div class="cw-dbody" style="max-height:none;">' + opsHtml(offRow) + '</div>'
          : '') +
        '<div class="cw-dbody">' + documentHtml(cs[0]) + '</div>';
    } else {
      var lead = (row.status === 'ready')
        ? '<div class="cw-note" style="padding-bottom:2px;">Proposes to:</div>' : '';
      bodyHtml = lead + '<div class="cw-dbody">' + opsHtml(groups) + '</div>';
    }

    var actions = '';
    var impHtml = impact
      ? '<span class="cw-impact ' + (impact > 0 ? 'pos' : 'neg') + '">' +
        (impact > 0 ? '+' : '−') + usd(Math.abs(impact)) + ' cost impact</span>' : '';
    if (row.status === 'ready') {
      actions = '<div class="cw-actions">' +
        '<button class="cw-btn pri" data-cwapprove="' + esc(row.id) + '">Approve &amp; apply</button>' +
        '<button class="cw-btn gho" data-cwreject="' + esc(row.id) + '">Reject</button>' +
        '<span id="cw-actmsg" style="font-size:11px;color:var(--text-dim,#9a9aa2);"></span>' + impHtml + '</div>';
    } else if (impHtml) {
      actions = '<div class="cw-actions">' + impHtml + '</div>';
    }

    doc.innerHTML = head + bodyHtml + actions;
    wireActions(doc, row);
  }

  function wireActions(doc, row) {
    var ap = doc.querySelector('[data-cwapprove]');
    var rj = doc.querySelector('[data-cwreject]');
    var msg = doc.querySelector('#cw-actmsg');
    function say(t) { if (msg) msg.textContent = t || ''; }

    if (ap) ap.addEventListener('click', async function () {
      ap.disabled = true; if (rj) rj.disabled = true; say('Applying…');
      try {
        var r = await fetch('/api/payloads/' + encodeURIComponent(row.id) + '/apply', {
          method: 'POST', credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders())
        });
        var body = await r.json().catch(function () { return {}; });
        if (!r.ok) {
          // 409 is NOT always "already used": an abandoned claim reads the
          // same way from here, and it self-heals after five minutes.
          var m = r.status === 410 ? 'This draft expired.'
                : r.status === 409 ? (body.error || 'Someone (or something) is already applying this.')
                : r.status === 403 ? (body.error || 'You don\'t have permission to apply this.')
                : (body.error || ('Apply failed — HTTP ' + r.status));
          say(m); ap.disabled = false; if (rj) rj.disabled = false;
          return;
        }
        say('Applied.');
        document.dispatchEvent(new CustomEvent('p86:payload-applied', { detail: {
          payload_id: row.id,
          apply_summary: body.apply_summary,
          affected_targets: body.affected_targets || [],
          apply_changeset: body.apply_changeset || [],
          title: row.title || '',
          emitting_agent_key: row.emitting_agent_key || ''
        } }));
        // Keep the chat's copy of this card honest — it renders the SAME
        // payload and would otherwise keep a live Approve button until its
        // next 15s poll.
        try { if (window.PayloadArtifact) window.PayloadArtifact.updateStatus(row.id, 'applied', body.apply_summary); } catch (_) {}
        await refreshAndReselect(row.id);
      } catch (e) {
        say('Apply failed: ' + (e && e.message || 'network error'));
        ap.disabled = false; if (rj) rj.disabled = false;
      }
    });

    if (rj) rj.addEventListener('click', async function () {
      // Never window.confirm — it is a silent no-op in the installed PWA.
      var ok = true;
      try {
        if (window.p86Confirm) ok = await window.p86Confirm('Reject this draft? It will be marked dismissed and nothing will change.');
      } catch (_) { ok = true; }
      if (!ok) return;
      rj.disabled = true; if (ap) ap.disabled = true; say('Rejecting…');
      try {
        var r = await fetch('/api/payloads/' + encodeURIComponent(row.id) + '/reject', {
          method: 'POST', credentials: 'include',
          headers: Object.assign({ 'Content-Type': 'application/json' }, authHeaders())
        });
        if (!r.ok) throw new Error('HTTP ' + r.status);
        say('Dismissed.');
        try { if (window.PayloadArtifact) window.PayloadArtifact.updateStatus(row.id, 'rejected'); } catch (_) {}
        await refreshAndReselect(row.id);
      } catch (e) {
        say('Reject failed: ' + (e && e.message || 'network error'));
        rj.disabled = false; if (ap) ap.disabled = false;
      }
    });
  }

  async function refreshAndReselect(id) {
    await loadLedger({});
    await selectRow(id, true);
  }

  // ── surface A registration ───────────────────────────────────────────────
  // While Cowork is the active tab it CLAIMS every write — the strip and the
  // document pane stay silent, so one write is never reported twice.
  //
  // But it does NOT hijack the reading position. If the user has picked a row
  // by hand, a new write raises an unread marker in the rail and leaves the
  // document alone. That is the same clobber this page exists to fix; it
  // would be absurd to reproduce it here.
  function registerSurface() {
    var lw = LW();
    if (!lw || !lw.registerSurface) return;
    lw.registerSurface({
      name: 'cowork',
      order: 20,
      exclusive: true,
      claims: function () { return isActive(); },
      render: function (entry) {
        loadLedger({});
        var id = entry.meta.payloadId;
        if (!id) return;
        if (_pinned && _selectedId && _selectedId !== id) { _unread++; renderRail(); return; }
        selectRow(id, false);
      }
    });
  }

  // ── page entry / exit ────────────────────────────────────────────────────
  function renderCowork() {
    if (!ensureShell()) return;
    registerSurface();
    ensureDock();
    loadLedger({});
  }

  window.p86Cowork = {
    render: renderCowork,
    /* Deep link from the notification's "Open in Cowork" button. */
    open: function (payloadId) {
      try { if (window.switchTab) window.switchTab('cowork'); } catch (_) {}
      setTimeout(function () {
        if (!ensureShell()) return;
        registerSurface(); ensureDock();
        loadLedger({}).then(function () { if (payloadId) selectRow(payloadId, true); });
      }, 0);
    },
    /* app.js calls this when leaving the tab, after undocking the panel. */
    onLeave: onLeave,
    _isActive: isActive
  };
})();
