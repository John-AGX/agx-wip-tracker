// Project 86 — Tasks / To-Do UI.
//
// Two-speed UX synthesized from the cross-platform survey:
//   • Todoist-fast single-line quick-capture (openQuickAdd) — the header
//     "+" New To-Do item and the My Tasks page inline bar both use it.
//   • A fuller editor (openDetail) with status / priority / due / assignee
//     / kind / checklist subtasks when more than a title is needed.
//
// Reusable surfaces:
//   window.p86Tasks.openQuickAdd(prefill)              — quick-capture modal
//   window.p86Tasks.openDetail(id)                     — full editor modal
//   window.p86Tasks.mountList(container, filter, opts) — list renderer
//   window.p86Tasks.mountEntityPanel(container, type, id, label)
//                                                      — entity-page panel
//   window.p86Tasks.renderMyTasksTab()                 — My Tasks page
//
// Backed by window.p86Api.tasks (js/api.js) → /api/tasks
// (server/routes/tasks-routes.js). Org-scoped, requireAuth-only.

(function () {
  'use strict';

  // ── Small utilities ────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) { return esc(s); }

  // Promise-returning confirm. Native confirm() silently returns undefined in
  // the installed PWA, which turns every `if (!confirm(x)) return` guard into
  // a no-op. Always resolves to a real boolean.
  function askConfirm(message, opts) {
    opts = opts || {};
    if (typeof window.p86Confirm === 'function') {
      return window.p86Confirm({
        title: opts.title || 'Confirm', message: message,
        confirmText: opts.confirmLabel || 'Confirm', confirmLabel: opts.confirmLabel || 'Confirm',
        cancelText: 'Cancel', cancelLabel: 'Cancel',
        destructive: opts.danger !== false, danger: opts.danger !== false
      }).then(function (v) { return !!v; });
    }
    return Promise.resolve(!!window.confirm(message));
  }

  function api() { return window.p86Api && window.p86Api.tasks; }
  function authed() {
    return window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated();
  }
  function currentUserId() {
    var u = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
    return u ? u.id : null;
  }
  function toast(msg, kind) {
    if (window.p86Toast && window.p86Toast.show) window.p86Toast.show(msg, kind);
    else if (kind === 'error') console.error('[tasks]', msg);
  }

  var PRIORITIES = [
    { v: 'urgent', label: 'Urgent', color: '#dc2626' },
    { v: 'high',   label: 'High',   color: '#ea580c' },
    { v: 'normal', label: 'Normal', color: '#64748b' },
    { v: 'low',    label: 'Low',    color: '#94a3b8' }
  ];
  function priorityMeta(p) {
    for (var i = 0; i < PRIORITIES.length; i++) if (PRIORITIES[i].v === p) return PRIORITIES[i];
    return PRIORITIES[2];
  }
  var KINDS = [
    { v: 'todo', label: 'To-Do' },
    { v: 'punch', label: 'Punch item' },
    { v: 'follow_up', label: 'Follow-up' }
  ];
  var STATUSES = [
    { v: 'open', label: 'Open' },
    { v: 'in_progress', label: 'In progress' },
    { v: 'blocked', label: 'Blocked' },
    { v: 'done', label: 'Done' }
  ];

  // ── Date helpers (local-day, no timezone surprises) ────────────────
  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function isoDay(d) { return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()); }
  function todayISO() { return isoDay(new Date()); }
  function shiftISO(days) { var d = new Date(); d.setDate(d.getDate() + days); return isoDay(d); }
  // Short human date for grid columns: "Jul 28" (adds year when not current).
  function shortDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var sameYear = d.getFullYear() === new Date().getFullYear();
    var o = sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
    try { return d.toLocaleDateString(undefined, o); } catch (e) { return isoDay(d); }
  }
  // "John Thilking" -> "John T." for the compact Assignee column.
  function shortName(nm) {
    var p = String(nm || '').trim().split(/\s+/);
    if (p.length < 2) return p[0] || '';
    return p[0] + ' ' + p[p.length - 1].charAt(0).toUpperCase() + '.';
  }

  // Render a due-date chip: relative wording + an overdue/soon class.
  function dueChip(due, isDone) {
    if (!due) return '';
    var dueStr = String(due).slice(0, 10);
    var today = todayISO();
    var cls = 'p86-task-due';
    var label = dueStr;
    if (!isDone) {
      if (dueStr < today) { cls += ' overdue'; }
      else if (dueStr === today) { cls += ' today'; }
    }
    // Friendly wording for near dates.
    if (dueStr === today) label = 'Today';
    else if (dueStr === shiftISO(1)) label = 'Tomorrow';
    else if (dueStr === shiftISO(-1)) label = 'Yesterday';
    else {
      var d = new Date(dueStr + 'T00:00:00');
      if (!isNaN(d)) {
        var sameYear = d.getFullYear() === new Date().getFullYear();
        var opts = sameYear ? { month: 'short', day: 'numeric' } : { month: 'short', day: 'numeric', year: 'numeric' };
        try { label = d.toLocaleDateString(undefined, opts); } catch (e) { label = dueStr; }
      }
    }
    return '<span class="' + cls + '">' + esc(label) + '</span>';
  }

  // ── Org-user cache (assignee picker source) ────────────────────────
  var _users = null;
  var _usersPromise = null;
  function loadUsers() {
    if (_users) return Promise.resolve(_users);
    if (_usersPromise) return _usersPromise;
    if (!window.p86Api || !window.p86Api.users || !authed()) return Promise.resolve([]);
    _usersPromise = window.p86Api.users.list().then(function (res) {
      _users = (res && res.users) || [];
      // Stash on appData for parity with other modules.
      window.appData = window.appData || {};
      if (!window.appData.users || !window.appData.users.length) window.appData.users = _users;
      return _users;
    }).catch(function () { _users = []; return _users; });
    return _usersPromise;
  }
  function userName(id) {
    if (id == null) return '';
    var list = _users || (window.appData && window.appData.users) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name || list[i].email || ('User ' + id);
    return 'User ' + id;
  }
  // Build a <select> of org users. selectedId may be null (Unassigned).
  function assigneeSelectHTML(id, selectedId) {
    var list = _users || (window.appData && window.appData.users) || [];
    var opts = ['<option value="">Unassigned</option>'];
    list.forEach(function (u) {
      var sel = (String(u.id) === String(selectedId)) ? ' selected' : '';
      opts.push('<option value="' + escAttr(u.id) + '"' + sel + '>' + esc(u.name || u.email || ('User ' + u.id)) + '</option>');
    });
    return '<select id="' + id + '" class="p86-task-select">' + opts.join('') + '</select>';
  }
  function initialsOf(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // ── One-time CSS injection (keeps the module self-contained) ───────
  function ensureStyles() {
    if (document.getElementById('p86-tasks-styles')) return;
    var css =
      '.p86-task-modal .modal-content{max-width:520px;}' +
      '.p86-task-row-fields{display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center;}' +
      '.p86-task-select,.p86-task-modal input[type=date],.p86-task-modal input[type=text],.p86-task-modal textarea{font:inherit;padding:6px 8px;border:1px solid var(--border,#d4d4d8);border-radius:8px;background:var(--surface,#fff);color:inherit;}' +
      '.p86-task-modal textarea{width:100%;resize:vertical;}' +
      '.p86-task-modal .p86-field{display:flex;flex-direction:column;gap:4px;margin-bottom:10px;}' +
      '.p86-task-modal .p86-field>span{font-size:12px;font-weight:600;color:var(--muted,#71717a);}' +
      '.p86-task-linkchip{display:inline-flex;align-items:center;gap:6px;font-size:12px;padding:3px 8px;border-radius:999px;background:var(--chip-bg,#f1f5f9);color:var(--muted,#475569);}' +
      '.p86-task-linkpick{display:flex;gap:8px;}' +
      '.p86-task-linkpick select{flex:1 1 0;min-width:0;}' +
      // List
      '.p86-task-list{display:flex;flex-direction:column;gap:1px;}' +
      // Grouped sections — Overdue / Today / Upcoming / No due date / Completed.
      '.p86-task-group{margin-bottom:20px;}' +
      '.p86-task-group:last-child{margin-bottom:0;}' +
      '.p86-task-grouphead{display:flex;align-items:center;gap:8px;padding:0 12px 7px;margin-bottom:3px;border-bottom:1px solid var(--border,#e5e7eb);}' +
      '.p86-task-grouplabel{font-size:11px;font-weight:700;letter-spacing:.055em;text-transform:uppercase;color:var(--muted,#94a3b8);}' +
      '.p86-task-grouplabel.is-overdue{color:#f87171;}' +
      '.p86-task-grouplabel.is-today{color:#fbbf24;}' +
      '.p86-task-groupcount{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:18px;padding:0 6px;border-radius:999px;background:rgba(148,163,184,.16);color:var(--muted,#94a3b8);font-size:11px;font-weight:600;}' +
      '.p86-task-grouplabel.is-overdue + .p86-task-groupcount{background:rgba(239,68,68,.16);color:#f87171;}' +
      'body.light-mode .p86-task-grouplabel.is-overdue{color:#b91c1c;}' +
      'body.light-mode .p86-task-grouplabel.is-today{color:#92400e;}' +
      'body.light-mode .p86-task-groupcount{background:#f1f5f9;color:#475569;}' +
      'body.light-mode .p86-task-grouplabel.is-overdue + .p86-task-groupcount{background:#fee2e2;color:#b91c1c;}' +
      '.p86-task-item{display:flex;align-items:flex-start;gap:12px;padding:11px 12px;border-radius:9px;border:1px solid transparent;cursor:default;transition:background .12s;}' +
      '.p86-task-item:hover{background:var(--hover,var(--surface2,#202027));}' +
      '.p86-task-check{flex:0 0 auto;width:19px;height:19px;margin-top:1px;border-radius:999px;border:1.5px solid var(--border-strong,#8b93a7);background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;color:#fff;transition:border-color .12s,background .12s;}' +
      '.p86-task-check:hover{border-color:var(--accent,#4f8cff);}' +
      '.p86-task-check.done{background:#16a34a;border-color:#16a34a;}' +
      '.p86-task-check.done::after{content:"";width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);margin-top:-2px;}' +
      '.p86-task-pdot{flex:0 0 auto;width:7px;height:7px;border-radius:999px;margin-top:7px;}' +
      '.p86-task-main{flex:1 1 auto;min-width:0;}' +
      '.p86-task-title{font-size:14px;font-weight:500;line-height:1.4;word-break:break-word;cursor:pointer;}' +
      '.p86-task-item.is-done .p86-task-title{text-decoration:line-through;color:var(--muted,#9ca3af);font-weight:400;}' +
      '.p86-task-meta{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin-top:6px;font-size:11px;color:var(--muted,#71717a);}' +
      // Unified pill system — one height/radius across date + link chips; semantic
      // due states. Base rules are tuned for the DARK app (translucent so they sit
      // on the surface); body.light-mode twins restore the light palette.
      '.p86-task-due,.p86-task-link{display:inline-flex;align-items:center;height:19px;padding:0 8px;border-radius:6px;font-size:11px;font-weight:500;white-space:nowrap;}' +
      '.p86-task-due{background:rgba(148,163,184,.16);color:var(--muted,#9aa4b2);}' +
      '.p86-task-due.today{background:rgba(245,158,11,.16);color:#fbbf24;font-weight:600;}' +
      '.p86-task-due.overdue{background:rgba(239,68,68,.15);color:#f87171;font-weight:600;}' +
      '.p86-task-link{background:rgba(79,140,255,.14);color:#8fb4ff;}' +
      '.p86-task-avatar{flex:0 0 auto;display:inline-flex;align-items:center;justify-content:center;width:19px;height:19px;border-radius:999px;background:rgba(79,140,255,.2);color:#a9c4ff;font-size:9px;font-weight:700;}' +
      'body.light-mode .p86-task-due{background:#f1f5f9;color:#475569;}' +
      'body.light-mode .p86-task-due.today{background:#fef3c7;color:#92400e;}' +
      'body.light-mode .p86-task-due.overdue{background:#fee2e2;color:#b91c1c;}' +
      'body.light-mode .p86-task-link{background:#eef2ff;color:#4338ca;}' +
      'body.light-mode .p86-task-avatar{background:#e0e7ff;color:#3730a3;}' +
      '.p86-task-empty{padding:32px 8px;text-align:center;color:var(--muted,#9ca3af);font-size:13px;}' +
      // ── Grid view (grouped columnar) — Buildertrend-style columns + our sections.
      // Reuses .p86-task-check / .p86-task-avatar / .p86-task-due / .p86-task-link.
      '.p86-taskgrid-wrap{overflow-x:auto;border-top:1px solid var(--border,#2a2a32);}' +
      '.p86-taskgrid{min-width:780px;}' +
      '.p86-tg-head,.p86-tg-row{display:flex;align-items:center;min-width:0;}' +
      '.p86-tg-c{padding:0 10px;min-width:0;display:flex;align-items:center;gap:7px;}' +
      '.p86-tg-check{width:42px;flex:0 0 auto;justify-content:center;padding:0;}' +
      '.p86-tg-check .p86-task-check{margin-top:0;}' +
      '.p86-tg-task{flex:1 1 auto;min-width:200px;}' +
      '.p86-tg-due{width:120px;flex:0 0 auto;}' +
      '.p86-tg-prio{width:112px;flex:0 0 auto;}' +
      '.p86-tg-who{width:142px;flex:0 0 auto;}' +
      '.p86-tg-job{width:152px;flex:0 0 auto;overflow:hidden;}' +
      '.p86-tg-job .p86-task-link{display:inline-block;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;line-height:19px;}' +
      '.p86-tg-made{width:98px;flex:0 0 auto;}' +
      '.p86-tg-head{height:34px;background:rgba(255,255,255,.025);border-bottom:1px solid var(--border,#2a2a32);font-size:11px;font-weight:600;letter-spacing:.03em;text-transform:uppercase;color:var(--text-dim,#b4b4bf);}' +
      '.p86-tg-group{display:flex;align-items:center;gap:8px;padding:7px 14px 6px;background:rgba(148,163,184,.05);border-bottom:1px solid var(--border,#e5e7eb);}' +
      '.p86-tg-glabel{font-size:11px;font-weight:700;letter-spacing:.055em;text-transform:uppercase;color:var(--muted,#94a3b8);}' +
      '.p86-tg-glabel.is-overdue{color:#f87171;}.p86-tg-glabel.is-today{color:#fbbf24;}' +
      '.p86-tg-gcount{display:inline-flex;align-items:center;justify-content:center;min-width:19px;height:18px;padding:0 6px;border-radius:999px;background:rgba(148,163,184,.16);color:var(--muted,#94a3b8);font-size:11px;font-weight:600;font-variant-numeric:tabular-nums;}' +
      '.p86-tg-glabel.is-overdue + .p86-tg-gcount{background:rgba(239,68,68,.16);color:#f87171;}' +
      '.p86-tg-glabel.is-today + .p86-tg-gcount{background:rgba(245,158,11,.16);color:#fbbf24;}' +
      '.p86-tg-row{height:38px;border-bottom:1px solid var(--border,#e5e7eb);cursor:pointer;transition:background .1s;}' +
      '.p86-taskgrid .p86-tg-row:last-child{border-bottom:none;}' +
      '.p86-tg-row:hover{background:rgba(79,140,255,.06);}' +
      '.p86-tg-title{font-size:13px;font-weight:500;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;cursor:pointer;}' +
      '.p86-tg-row.is-done .p86-tg-title{color:var(--muted,#9ca3af);text-decoration:line-through;font-weight:400;}' +
      '.p86-tg-prio-tag{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted,#8b93a3);white-space:nowrap;}' +
      '.p86-tg-prio-dot{width:8px;height:8px;border-radius:50%;flex:0 0 auto;}' +
      '.p86-tg-who-nm{font-size:12px;color:var(--muted,#8b93a3);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}' +
      '.p86-tg-made-txt{font-size:11.5px;color:var(--muted,#8b93a3);font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.p86-tg-dash{color:var(--muted,#6b7280);opacity:.55;}' +
      '.p86-tg-cam{font-size:11px;color:var(--muted,#6b7280);white-space:nowrap;}' +
      // Inline add-task row (bottom of the grid)
      '.p86-tg-addrow{display:flex;align-items:center;gap:9px;height:38px;padding:0 12px;cursor:text;}' +
      '.p86-tg-addplus{color:var(--muted,#6b7280);font-size:14px;flex:0 0 auto;}' +
      '.p86-tg-addinput{flex:1 1 auto;font:inherit;font-size:13px;background:transparent;border:none;outline:none;color:inherit;padding:0;}' +
      '.p86-tg-addinput::placeholder{color:var(--muted,#6b7280);}' +
      '.p86-tg-addrow:focus-within{background:var(--hover,var(--surface2,#1a1f29));}' +
      '.p86-tg-emptyrow{padding:22px 14px;text-align:center;color:var(--muted,#8b93a3);font-size:13px;border-bottom:1px solid var(--border,#e5e7eb);}' +
      // ── Filter chip bar (Buildertrend-style) ──
      '.p86-fbar{display:flex;align-items:center;gap:7px;flex-wrap:wrap;margin-bottom:14px;}' +
      '.p86-fand{font-size:10.5px;font-weight:700;letter-spacing:.06em;color:var(--muted,#64748b);text-transform:uppercase;}' +
      '.p86-fchip{display:inline-flex;align-items:center;gap:5px;height:30px;padding:0 4px 0 11px;border:1px solid var(--accent-line,rgba(79,140,255,.4));background:rgba(79,140,255,.1);border-radius:9px;}' +
      '.p86-fchip-k{font-size:12px;color:var(--muted,#8b93a3);}' +
      '.p86-fchip-sel{font:inherit;font-size:12.5px;font-weight:600;color:var(--accent,#4f8cff);background:transparent;border:none;outline:none;cursor:pointer;padding:0 2px;max-width:150px;}' +
      '.p86-fchip-sel option{color:var(--text,#1b1e26);background:var(--surface,#14181f);font-weight:400;}' +
      '.p86-fchip-x{border:none;background:transparent;color:var(--muted,#8b93a3);font-size:16px;line-height:1;cursor:pointer;padding:0 5px;border-radius:5px;}' +
      '.p86-fchip-x:hover{color:var(--accent,#4f8cff);background:rgba(79,140,255,.14);}' +
      '.p86-fbar-add{font:inherit;font-size:12.5px;font-weight:500;height:30px;padding:0 12px;border:1px dashed var(--border-strong,#3a4150);background:transparent;color:var(--muted,#8b93a3);border-radius:9px;cursor:pointer;transition:color .12s,border-color .12s;}' +
      '.p86-fbar-add:hover{color:var(--accent,#4f8cff);border-color:var(--accent-line,rgba(79,140,255,.5));}' +
      '.p86-fbar-clear{font:inherit;font-size:12.5px;background:none;border:none;color:var(--muted,#8b93a3);cursor:pointer;text-decoration:underline;text-underline-offset:2px;padding:0 4px;}' +
      '.p86-fbar-clear:hover{color:var(--text,#e7eaf0);}' +
      '.p86-fbar-spacer{flex:1 1 auto;}' +
      '.p86-fbar-count{font-size:12px;color:var(--muted,#8b93a3);font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      // My Tasks page
      '.p86-tasks-page{padding:22px 24px 40px;max-width:none;margin:0;}' +
      '.p86-tasks-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:18px;flex-wrap:wrap;}' +
      '.p86-tasks-head h2{margin:0;font-size:19px;font-weight:650;letter-spacing:-.01em;}' +
      '.p86-tasks-newbtn{font:inherit;font-size:13px;font-weight:600;color:#fff;background:var(--accent,#4f8cff);border:none;border-radius:8px;padding:7px 14px;cursor:pointer;transition:filter .12s;}' +
      '.p86-tasks-newbtn:hover{filter:brightness(1.08);}' +
      '.p86-tasks-headtools{display:flex;align-items:center;gap:8px;}' +
      '.p86-tasks-iconbtn{width:34px;height:34px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:transparent;color:var(--muted,#8b93a3);font-size:16px;line-height:1;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:color .12s,border-color .12s,background .12s;}' +
      '.p86-tasks-iconbtn:hover{color:var(--text,#e7eaf0);border-color:var(--accent-line,rgba(79,140,255,.4));}' +
      '.p86-tasks-iconbtn.is-on{color:var(--accent,#4f8cff);border-color:var(--accent-line,rgba(79,140,255,.5));background:rgba(79,140,255,.1);}' +
      '.p86-compact .p86-tg-row{height:31px;}' +
      '.p86-compact .p86-tg-head{height:30px;}' +
      '.p86-compact .p86-tg-title{font-size:12.5px;}' +
      '.p86-compact .p86-tg-group{padding:5px 14px 4px;}' +
      '.p86-compact .p86-tg-addrow{height:31px;}' +
      '.p86-tasks-quickbar{display:flex;gap:8px;margin-bottom:16px;}' +
      '.p86-tasks-quickbar input{flex:1 1 auto;font:inherit;font-size:14px;padding:10px 14px;border:1px solid var(--border,#d4d4d8);border-radius:10px;background:var(--surface,#fff);color:inherit;transition:border-color .12s,box-shadow .12s;}' +
      '.p86-tasks-quickbar input:focus{outline:none;border-color:var(--accent,#4f8cff);box-shadow:0 0 0 3px rgba(79,140,255,.15);}' +
      '.p86-tasks-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:10px;}' +
      '.p86-tasks-filter{font:inherit;font-size:12.5px;font-weight:500;padding:5px 12px;border-radius:999px;border:1px solid var(--border,#e5e7eb);background:transparent;color:var(--muted,#64748b);cursor:pointer;transition:color .12s,border-color .12s,background .12s;}' +
      '.p86-tasks-filter:hover{color:var(--accent,#4f8cff);border-color:rgba(79,140,255,.4);}' +
      '.p86-tasks-filter.active{background:rgba(79,140,255,.14);color:var(--accent,#4f8cff);border-color:rgba(79,140,255,.45);font-weight:600;}' +
      // 3-tier tabs + per-tab toolbar
      '.p86-tabs{display:flex;gap:2px;border-bottom:1px solid var(--border,#e5e7eb);margin-bottom:18px;}' +
      '.p86-tab{font:inherit;font-size:13px;font-weight:600;padding:9px 15px;border:none;background:transparent;color:var(--muted,#64748b);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;transition:color .12s;}' +
      '.p86-tab:hover{color:var(--accent,#4f8cff);}' +
      '.p86-tab.active{color:var(--accent,#4f8cff);border-bottom-color:var(--accent,#4f8cff);}' +
      '.p86-tasks-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;}' +
      '.p86-tasks-userfilter{display:flex;align-items:center;gap:7px;font-size:11px;font-weight:600;letter-spacing:.04em;text-transform:uppercase;color:var(--muted,#64748b);}' +
      '.p86-tasks-userfilter select{font:inherit;font-size:12.5px;font-weight:400;text-transform:none;letter-spacing:0;padding:6px 10px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--surface,#fff);color:inherit;cursor:pointer;}' +
      '.p86-tasks-hint{font-size:12px;color:var(--muted,#9ca3af);margin:2px 0 10px;}' +
      // Reminders
      '.p86-rem-quickbar{display:flex;gap:8px;margin-bottom:12px;flex-wrap:wrap;}' +
      '.p86-rem-quickbar input[type=text]{flex:1 1 180px;font:inherit;padding:9px 12px;border:1px solid var(--border,#d4d4d8);border-radius:10px;background:var(--surface,#fff);color:inherit;}' +
      '.p86-rem-quickbar input[type=datetime-local]{font:inherit;padding:8px 10px;border:1px solid var(--border,#d4d4d8);border-radius:10px;background:var(--surface,#fff);color:inherit;}' +
      '.p86-rem-when{padding:1px 7px;border-radius:999px;background:#f3e8ff;color:#7e22ce;font-weight:600;}' +
      '.p86-rem-notes{font-size:12px;color:var(--muted,#71717a);margin-top:3px;}' +
      '.p86-rem-del{margin-left:8px;border:none;background:transparent;color:var(--muted,#9ca3af);font-size:20px;line-height:1;cursor:pointer;padding:0 4px;align-self:center;}' +
      '.p86-rem-del:hover{color:#b91c1c;}' +
      '.p86-task-checklist{margin-top:6px;display:flex;flex-direction:column;gap:5px;}' +
      '.p86-task-clrow{display:flex;align-items:center;gap:8px;}' +
      '.p86-task-clrow input[type=text]{flex:1 1 auto;}' +
      '.p86-task-clrow button.rm{border:none;background:transparent;color:#b91c1c;cursor:pointer;font-size:16px;line-height:1;}' +
      '.p86-task-panel{border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px;margin-top:12px;}' +
      '.p86-task-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}' +
      '.p86-task-panel-head h4{margin:0;font-size:14px;}' +
      // Appointments subsection (entity-page calendar events)
      '.p86-appt-list{display:flex;flex-direction:column;gap:2px;}' +
      '.p86-appt-row{display:flex;align-items:flex-start;gap:10px;width:100%;text-align:left;padding:9px 8px;border-radius:8px;border:1px solid transparent;background:transparent;color:inherit;font:inherit;cursor:pointer;}' +
      '.p86-appt-row:hover{background:var(--hover,var(--surface2,#202027));}' +
      '.p86-appt-dot{flex:0 0 auto;width:7px;height:7px;border-radius:999px;margin-top:7px;background:#22d3ee;}' +
      '.p86-appt-row.tentative .p86-appt-dot{background:#f59e0b;}' +
      '.p86-appt-row.canceled .p86-appt-dot{background:#9ca3af;}' +
      '.p86-appt-main{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}' +
      '.p86-appt-title{font-size:14px;line-height:1.35;word-break:break-word;}' +
      '.p86-appt-row.canceled .p86-appt-title{text-decoration:line-through;color:var(--muted,#9ca3af);}' +
      '.p86-appt-when{font-size:11.5px;color:var(--muted,#71717a);}' +
      '.p86-appt-loc{margin-left:4px;}' +
      '.p86-appt-empty{padding:18px 8px;text-align:center;color:var(--muted,#9ca3af);font-size:13px;}';
    var st = document.createElement('style');
    st.id = 'p86-tasks-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── Modal scaffold ─────────────────────────────────────────────────
  function buildModal(id, innerHTML) {
    var prior = document.getElementById(id);
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = id;
    modal.className = 'modal active p86-task-modal';
    modal.innerHTML = innerHTML;
    document.body.appendChild(modal);
    function close() { modal.remove(); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    modal.addEventListener('click', function (e) { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', close);
    });
    return { modal: modal, close: close };
  }

  // ── Quick-add (Todoist-style single-line capture) ──────────────────
  // prefill: { title?, entity_type?, entity_id?, entity_label?, kind?,
  //            assignee_user_id?, due_date?, priority? }
  // opts:    { onCreated(task) }
  // Manual entity-link picker source for the quick-add (reminder) modal —
  // the same four types the calendar links to. Cached per type per page so
  // toggling the type select is instant after the first load. Labels mirror
  // server entity-labels.js ([jobNumber] title / lead title / name).
  var _entOptCache = {};
  function loadEntOptions(type) {
    if (_entOptCache[type]) return Promise.resolve(_entOptCache[type]);
    var a = window.p86Api;
    if (!a) return Promise.resolve([]);
    var p;
    if (type === 'client')       p = a.clients.list().then(function (r) { return (r && r.clients) || []; });
    else if (type === 'job')     p = a.jobs.list().then(function (r) { return (r && r.jobs) || []; });
    else if (type === 'lead')    p = a.leads.list().then(function (r) { return (r && r.leads) || []; });
    else if (type === 'project') p = a.projects.list().then(function (r) { return (r && r.projects) || []; });
    else return Promise.resolve([]);
    return p.then(function (l) { _entOptCache[type] = l; return l; }).catch(function () { return []; });
  }
  function entOptLabel(type, it) {
    if (type === 'job') return window.p86JobLabel.fromJob(it, { fallback: 'Job' });
    if (type === 'lead') return it.title || '(untitled lead)';
    return it.name || it.title || '(unnamed)';
  }

  function openQuickAdd(prefill, opts) {
    prefill = prefill || {};
    opts = opts || {};
    if (!api()) { toast('Not connected', 'error'); return; }
    ensureStyles();

    // Scope-aware noun: 'org' → assignable Task, else personal To-do.
    var noun = (prefill.scope === 'org') ? 'task' : 'to-do';
    var linkLabel = prefill.entity_label || '';
    var hasLink = !!(prefill.entity_type && prefill.entity_id);
    var defAssignee = (prefill.assignee_user_id != null) ? prefill.assignee_user_id : currentUserId();

    loadUsers().then(function () {
      var html =
        '<div class="modal-content">' +
          '<div class="modal-header"><span>New ' + noun + '</span>' +
            '<button class="p86-modal-close" data-close>&times;</button></div>' +
          '<div style="padding:16px;">' +
            (hasLink
              ? '<div style="margin-bottom:10px;"><span class="p86-task-linkchip">Linked: ' + esc(linkLabel || (window.entityDisplayName && window.entityDisplayName(prefill.entity_type, prefill.entity_id)) || prefill.entity_type) + '</span></div>'
              : '<div class="p86-field"><span>Link to <span style="font-weight:400;color:var(--muted,#9ca3af);">(optional — client, job, lead, or project)</span></span>' +
                  '<div class="p86-task-linkpick">' +
                    '<select id="qaLinkType" class="p86-task-select">' +
                      '<option value="">— None —</option>' +
                      '<option value="client">Client</option>' +
                      '<option value="job">Job</option>' +
                      '<option value="lead">Lead</option>' +
                      '<option value="project">Project</option>' +
                    '</select>' +
                    '<select id="qaLinkId" class="p86-task-select" style="display:none;"></select>' +
                  '</div>' +
                '</div>') +
            '<input id="qaTitle" type="text" style="width:100%;font-size:15px;padding:9px 11px;" ' +
              'placeholder="What needs doing?" value="' + escAttr(prefill.title || '') + '" />' +
            '<div class="p86-task-row-fields">' +
              '<label style="display:flex;align-items:center;gap:4px;font-size:12px;color:var(--muted,#71717a);">Due ' +
                '<input id="qaDue" type="date" value="' + escAttr((prefill.due_date || '').slice(0, 10)) + '" /></label>' +
              '<select id="qaPriority" class="p86-task-select">' +
                PRIORITIES.map(function (p) {
                  return '<option value="' + p.v + '"' + (p.v === (prefill.priority || 'normal') ? ' selected' : '') + '>' + esc(p.label) + '</option>';
                }).join('') +
              '</select>' +
              assigneeSelectHTML('qaAssignee', defAssignee) +
            '</div>' +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="ee-btn secondary" data-close>Cancel</button>' +
            '<button class="primary" id="qaSave">Add ' + noun + '</button>' +
          '</div>' +
        '</div>';

      var h = buildModal('p86QuickAddModal', html);
      var titleEl = h.modal.querySelector('#qaTitle');
      if (titleEl) { titleEl.focus(); }

      // Wire the optional link picker (only present when not prefilled).
      var linkTypeEl = h.modal.querySelector('#qaLinkType');
      var linkIdEl = h.modal.querySelector('#qaLinkId');
      if (linkTypeEl && linkIdEl) {
        linkTypeEl.addEventListener('change', function () {
          var type = linkTypeEl.value;
          if (!type) { linkIdEl.style.display = 'none'; linkIdEl.innerHTML = ''; return; }
          linkIdEl.style.display = '';
          linkIdEl.innerHTML = '<option value="">Loading…</option>';
          loadEntOptions(type).then(function (items) {
            var opts = ['<option value="">— Select a ' + esc(type) + ' —</option>'];
            items.forEach(function (it) {
              opts.push('<option value="' + escAttr(String(it.id)) + '">' + esc(entOptLabel(type, it)) + '</option>');
            });
            linkIdEl.innerHTML = opts.join('');
          }).catch(function () {
            linkIdEl.innerHTML = '<option value="">(could not load ' + esc(type) + 's)</option>';
          });
        });
      }

      function submit() {
        var title = (titleEl.value || '').trim();
        if (!title) { titleEl.focus(); return; }
        var payload = {
          title: title,
          kind: prefill.kind || 'todo',
          priority: h.modal.querySelector('#qaPriority').value || 'normal'
        };
        if (prefill.scope) payload.scope = prefill.scope;
        var due = h.modal.querySelector('#qaDue').value;
        if (due) payload.due_date = due;
        var asg = h.modal.querySelector('#qaAssignee').value;
        if (asg) payload.assignee_user_id = Number(asg);
        if (hasLink) {
          payload.entity_type = prefill.entity_type; payload.entity_id = String(prefill.entity_id);
        } else if (linkTypeEl && linkIdEl) {
          var lt = linkTypeEl.value || '';
          var li = linkIdEl.value || '';
          if (lt && li) { payload.entity_type = lt; payload.entity_id = li; }
        }

        var btn = h.modal.querySelector('#qaSave');
        btn.disabled = true; btn.textContent = 'Adding…';
        api().create(payload).then(function (res) {
          toast('Task added', 'success');
          h.close();
          if (typeof opts.onCreated === 'function') opts.onCreated(res && res.task);
          else refreshOpenSurfaces();
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = 'Add ' + noun;
          toast((e && e.message) || 'Could not add task', 'error');
        });
      }

      h.modal.querySelector('#qaSave').addEventListener('click', submit);
      titleEl.addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); submit(); }
      });
    });
  }

  // ── Full editor ────────────────────────────────────────────────────
  function openDetail(id) {
    if (!api()) { toast('Not connected', 'error'); return; }
    ensureStyles();
    Promise.all([loadUsers(), api().get(id)]).then(function (out) {
      var task = out[1] && out[1].task;
      if (!task) { toast('Task not found', 'error'); return; }
      renderEditor(task);
    }).catch(function (e) { toast((e && e.message) || 'Could not load task', 'error'); });
  }

  function renderEditor(task) {
    var checklist = Array.isArray(task.checklist) ? task.checklist : [];
    function _lbl(arr, v) { for (var i = 0; i < arr.length; i++) { if (arr[i].v === v) return arr[i].label; } return v || ''; }
    var _clDone = checklist.filter(function (c) { return c && c.done; }).length;
    var _linkChip = task.entity_type ? esc(task.linked_label || (window.entityDisplayName && window.entityDisplayName(task.entity_type, task.entity_id)) || task.entity_type) : '';
    var _stat = String(task.status || '');
    var _statColor = _stat === 'done' ? 'var(--green,#22c55e)' : _stat === 'blocked' ? 'var(--red,#ef4444)' : 'var(--accent,#4f8cff)';
    var html =
      '<div class="modal-content">' +
        '<div class="modal-header p86-td-hd">' +
          '<span class="p86-td-hd-ttl">Task</span>' +
          '<span style="display:flex;gap:6px;align-items:center;">' +
            '<button class="ee-btn secondary" id="tdShareBtn" title="Send this task to an outside worker by email">&#x1F517; Share</button>' +
            '<button class="ee-btn secondary" id="tdEditBtn" title="Edit this task">&#x1F512; Edit</button>' +
            '<button class="p86-modal-close" data-close>&times;</button>' +
          '</span>' +
        '</div>' +
        '<div style="max-height:74vh;overflow:auto;">' +

          '<div id="tdView" style="padding:16px 18px;display:flex;flex-direction:column;gap:14px;">' +
            '<div>' +
              '<div style="font-size:17px;font-weight:600;line-height:1.35;color:var(--text,#e9ecf5);">' + esc(task.title || 'Untitled task') + '</div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">' +
                '<span style="font-size:12px;padding:3px 9px;border-radius:20px;background:color-mix(in srgb,' + _statColor + ' 18%,transparent);color:' + _statColor + ';">' + esc(_lbl(STATUSES, task.status)) + '</span>' +
                '<span style="font-size:12px;padding:3px 9px;border-radius:20px;background:var(--card-bg,#141a26);color:var(--text-dim,#9aa);border:1px solid var(--border,#333);">' + esc(_lbl(PRIORITIES, task.priority)) + '</span>' +
                '<span style="font-size:12px;padding:3px 9px;border-radius:20px;background:var(--card-bg,#141a26);color:var(--text-dim,#9aa);border:1px solid var(--border,#333);">' + esc(_lbl(KINDS, task.kind)) + '</span>' +
                (_linkChip ? '<span style="font-size:12px;padding:3px 9px;border-radius:20px;background:var(--card-bg,#141a26);color:var(--text-dim,#9aa);border:1px solid var(--border,#333);">&#x1F517; ' + _linkChip + '</span>' : '') +
              '</div>' +
              '<div style="display:flex;flex-wrap:wrap;gap:14px;margin-top:9px;font-size:12px;color:var(--text-dim,#888);">' +
                '<span>&#x1F4C5; ' + (task.due_date ? esc((task.due_date || '').slice(0, 10)) : 'No due date') + '</span>' +
                '<span>&#x1F464; ' + esc(task.assignee_name || 'Unassigned') + '</span>' +
                (task.created_at ? '<span>&#x1F552; Created ' + esc(String(task.created_at).slice(0, 10)) + '</span>' : '') +
              '</div>' +
            '</div>' +

            '<div id="tdSharePanel" style="display:none;background:var(--card-bg,#141a26);border:1px solid var(--border,#333);border-radius:12px;padding:12px 14px;">' +
              '<div style="font-size:13px;font-weight:600;margin-bottom:8px;color:var(--text,#e9ecf5);">&#x1F517; Send this task to an outside worker</div>' +
              '<div style="font-size:12px;color:var(--text-dim,#888);margin-bottom:8px;">They get an email link — no login. They can check items, add photos, and mark it done. The link expires on completion or after the days below.</div>' +
              '<label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:3px;">Subcontractor</label>' +
              '<select id="tdShareSub" class="p86-task-select" style="width:100%;margin-bottom:8px;"></select>' +
              '<label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:3px;">Their email</label>' +
              '<input id="tdShareEmail" type="email" placeholder="worker@email.com" style="width:100%;margin-bottom:8px;" />' +
              '<div style="display:flex;gap:8px;align-items:center;margin-bottom:10px;"><label style="font-size:12px;color:var(--text-dim,#888);">Expires in</label><input id="tdShareDays" type="number" min="1" max="90" value="14" style="width:64px;" /><span style="font-size:12px;color:var(--text-dim,#888);">days</span></div>' +
              '<button class="primary" id="tdShareSend" style="width:100%;">Send link</button>' +
              '<div id="tdShareResult" style="margin-top:8px;font-size:12.5px;"></div>' +
              '<div id="tdShareList" style="margin-top:12px;"></div>' +
            '</div>' +

            (task.notes ? '<div><div style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-dim,#888);margin-bottom:5px;">Notes</div><div style="font-size:14px;line-height:1.6;color:var(--text,#cfd6e4);white-space:pre-wrap;">' + esc(task.notes) + '</div></div>' : '') +

            '<div style="background:var(--card-bg,#141a26);border:1px solid var(--border,#333);border-radius:12px;padding:12px 14px;">' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;font-size:13px;font-weight:600;color:var(--text,#e9ecf5);"><span>&#x2611;&#xFE0F; Punch list</span><span id="tdPunchCount" style="font-weight:400;color:var(--text-dim,#888);">' + _clDone + ' of ' + checklist.length + ' done</span></div>' +
              '<div style="height:4px;border-radius:4px;background:var(--border,#333);overflow:hidden;margin-bottom:10px;"><i id="tdPunchBar" style="display:block;height:100%;background:var(--accent,#4f8cff);width:' + (checklist.length ? Math.round(_clDone / checklist.length * 100) : 0) + '%;"></i></div>' +
              '<div id="tdViewChecklist" style="display:flex;flex-direction:column;gap:7px;font-size:13.5px;"></div>' +
              (checklist.length ? '' : '<div style="font-size:12.5px;color:var(--text-dim,#888);">No punch items yet. Tap Edit to add some.</div>') +
            '</div>' +

            '<div style="background:var(--card-bg,#141a26);border:1px solid var(--border,#333);border-radius:12px;overflow:hidden;">' +
              '<div id="tdMiniMap" style="height:220px;background:#0c1017;display:none;"></div>' +
              '<div style="padding:11px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<div style="min-width:0;">' +
                  '<div style="font-size:13px;color:var(--text,#e9ecf5);"><span style="color:var(--accent,#4f8cff);">&#x1F4CD;</span> <span id="tdViewLocLine">Location</span></div>' +
                  '<div id="tdViewDir" style="font-size:12px;color:var(--text-dim,#888);margin-top:2px;' + (task.directions ? '' : 'display:none;') + '">' + esc(task.directions || '') + '</div>' +
                '</div>' +
                '<a id="tdViewDirBtn" class="ee-btn secondary" target="_blank" rel="noopener" style="flex:none;display:none;">&#x27A4; Directions</a>' +
              '</div>' +
            '</div>' +

            '<div>' +
              '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px;">' +
                '<span style="font-size:11px;letter-spacing:.04em;text-transform:uppercase;color:var(--text-dim,#888);">Photos</span>' +
                '<span style="display:flex;gap:6px;">' +
                  '<button class="ee-btn secondary" id="tdViewTake" style="font-size:11px;">&#x1F4F7; Take</button>' +
                  '<button class="ee-btn secondary" id="tdViewUpload" style="font-size:11px;">&#x1F5BC;&#xFE0F; Upload</button>' +
                '</span>' +
              '</div>' +
              '<div id="tdViewPhotos" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(104px,1fr));gap:8px;"></div>' +
            '</div>' +
          '</div>' +

          '<div id="tdEdit" style="display:none;padding:16px 18px;">' +
          '<label class="p86-field"><span>Title</span>' +
            '<input id="tdTitle" type="text" value="' + escAttr(task.title || '') + '" /></label>' +
          '<label class="p86-field"><span>Notes</span>' +
            '<textarea id="tdNotes" rows="3" placeholder="Details (optional)">' + esc(task.notes || '') + '</textarea></label>' +
          '<div class="p86-task-row-fields">' +
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;">Status' +
              '<select id="tdStatus" class="p86-task-select">' + STATUSES.map(function (s) {
                return '<option value="' + s.v + '"' + (s.v === task.status ? ' selected' : '') + '>' + esc(s.label) + '</option>';
              }).join('') + '</select></label>' +
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;">Priority' +
              '<select id="tdPriority" class="p86-task-select">' + PRIORITIES.map(function (p) {
                return '<option value="' + p.v + '"' + (p.v === task.priority ? ' selected' : '') + '>' + esc(p.label) + '</option>';
              }).join('') + '</select></label>' +
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;">Kind' +
              '<select id="tdKind" class="p86-task-select">' + KINDS.map(function (k) {
                return '<option value="' + k.v + '"' + (k.v === task.kind ? ' selected' : '') + '>' + esc(k.label) + '</option>';
              }).join('') + '</select></label>' +
          '</div>' +
          '<div class="p86-task-row-fields">' +
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;">Due' +
              '<input id="tdDue" type="date" value="' + escAttr((task.due_date || '').slice(0, 10)) + '" /></label>' +
            '<label style="display:flex;flex-direction:column;gap:3px;font-size:12px;">Assignee' +
              assigneeSelectHTML('tdAssignee', task.assignee_user_id) + '</label>' +
          '</div>' +
          (task.entity_type ? '<div style="margin-top:10px;"><span class="p86-task-linkchip">Linked: ' + esc(task.linked_label || (window.entityDisplayName && window.entityDisplayName(task.entity_type, task.entity_id)) || task.entity_type) + '</span></div>' : '') +
          // Location — search an address (same Places autocomplete as the rest of
          // the app, fills the pin), geotag from the device, or type/pick coords.
          '<div class="p86-field" style="margin-top:12px;"><span>Location</span>' +
            '<div id="tdAddrSearch" style="margin:2px 0 8px;"></div>' +
            '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
              '<input id="tdLat" type="number" step="0.000001" placeholder="Latitude" style="flex:1;min-width:120px;" value="' + escAttr(task.lat != null ? task.lat : '') + '" />' +
              '<input id="tdLng" type="number" step="0.000001" placeholder="Longitude" style="flex:1;min-width:120px;" value="' + escAttr(task.lng != null ? task.lng : '') + '" />' +
            '</div>' +
            '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-top:6px;">' +
              '<button type="button" id="tdGeoMe" class="ee-btn secondary">Use my location</button>' +
              '<button type="button" id="tdGeoPick" class="ee-btn secondary">Pick on map</button>' +
              '<a id="tdGeoLink" target="_blank" rel="noopener" style="font-size:12px;color:#4f8cff;text-decoration:none;">Open in Maps &#8599;</a>' +
              '<button type="button" id="tdGeoClear" class="ee-btn secondary" style="font-size:11px;">Clear pin</button>' +
              '<span id="tdGeoAcc" style="font-size:11px;color:var(--text-dim,#888);"></span>' +
            '</div>' +
            '<div id="tdGeoDefault" style="font-size:11px;color:var(--text-dim,#888);margin-top:6px;line-height:1.5;"></div>' +
          '</div>' +
          '<label class="p86-field" style="margin-top:10px;"><span>Directions / access notes</span>' +
            '<textarea id="tdDirections" rows="2" placeholder="Gate code, where to park, which unit…">' + esc(task.directions || '') + '</textarea></label>' +
          '<div class="p86-field" style="margin-top:10px;"><span>Photos</span>' +
            '<div id="tdPhotos" class="p86-task-photos" style="display:flex;gap:6px;flex-wrap:wrap;"></div>' +
            '<input id="tdPhotoInput" type="file" accept="image/*" capture="environment" multiple style="display:none;" />' +
            '<button type="button" id="tdAddPhoto" class="ee-btn secondary" style="align-self:flex-start;margin-top:6px;">+ Add photo</button>' +
          '</div>' +
          '<div class="p86-field" style="margin-top:12px;"><span>Checklist</span>' +
            '<div id="tdChecklist" class="p86-task-checklist"></div>' +
            '<button type="button" id="tdAddCl" class="ee-btn secondary" style="align-self:flex-start;margin-top:4px;">+ Add item</button>' +
          '</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" id="tdFooter" style="display:none;justify-content:space-between;">' +
          '<button class="ee-btn secondary" id="tdDelete" style="color:#b91c1c;">Delete</button>' +
          '<span><button class="ee-btn secondary" id="tdCancelEdit">Cancel</button> ' +
          '<button class="primary" id="tdSave">Save</button></span>' +
        '</div>' +
      '</div>';

    var h = buildModal('p86TaskDetailModal', html);

    // Checklist editor state
    var clState = checklist.map(function (c) { return { text: c.text || '', done: !!c.done }; });
    function paintChecklist() {
      var host = h.modal.querySelector('#tdChecklist');
      host.innerHTML = clState.map(function (c, i) {
        return '<div class="p86-task-clrow">' +
          '<input type="checkbox" data-cl-done="' + i + '"' + (c.done ? ' checked' : '') + ' />' +
          '<input type="text" data-cl-text="' + i + '" value="' + escAttr(c.text) + '" placeholder="Subtask" />' +
          '<button type="button" class="rm" data-cl-rm="' + i + '" title="Remove">&times;</button>' +
        '</div>';
      }).join('');
      host.querySelectorAll('[data-cl-done]').forEach(function (el) {
        el.addEventListener('change', function () { clState[+el.getAttribute('data-cl-done')].done = el.checked; });
      });
      host.querySelectorAll('[data-cl-text]').forEach(function (el) {
        el.addEventListener('input', function () { clState[+el.getAttribute('data-cl-text')].text = el.value; });
      });
      host.querySelectorAll('[data-cl-rm]').forEach(function (el) {
        el.addEventListener('click', function () { clState.splice(+el.getAttribute('data-cl-rm'), 1); paintChecklist(); });
      });
    }
    paintChecklist();
    h.modal.querySelector('#tdAddCl').addEventListener('click', function () {
      clState.push({ text: '', done: false }); paintChecklist();
      var inputs = h.modal.querySelectorAll('[data-cl-text]');
      if (inputs.length) inputs[inputs.length - 1].focus();
    });

    // ── Geo pin: device location, manual edit, map picker, maps link ──
    // A task linked to a job DEFAULTS to that job's location; a task-specific
    // pin (lat/lng) overrides it. The default is derived at display time and is
    // never written onto the task — clearing the pin reverts to the default.
    var _geoAcc = (task.geo_accuracy != null) ? Number(task.geo_accuracy) : null;
    var _linkedJob = (task.entity_type === 'job' && window.appData && window.appData.jobs)
      ? window.appData.jobs.find(function (j) { return String(j.id) === String(task.entity_id); }) : null;
    function _jobCoords(j) {
      if (!j) return null;
      var la = Number(j.geocode_lat != null ? j.geocode_lat : j.lat);
      var ln = Number(j.geocode_lng != null ? j.geocode_lng : j.lng);
      return (window.p86MapLink && window.p86MapLink.isUsableCoord(la, ln)) ? { lat: la, lng: ln } : null;
    }
    function _jobAddress(j) {
      if (!j) return '';
      if (j.address) return j.address;
      return (window.p86Address && window.p86Address.get) ? window.p86Address.format(window.p86Address.get(j)) : '';
    }
    var _jobDef = _linkedJob ? { coords: _jobCoords(_linkedJob), address: _jobAddress(_linkedJob) } : null;
    function syncGeoLink() {
      var lat = parseFloat(h.modal.querySelector('#tdLat').value);
      var lng = parseFloat(h.modal.querySelector('#tdLng').value);
      var link = h.modal.querySelector('#tdGeoLink'), accEl = h.modal.querySelector('#tdGeoAcc');
      var note = h.modal.querySelector('#tdGeoDefault');
      var hasPin = isFinite(lat) && isFinite(lng);
      // The "Open in Maps" link routes to the OWN pin, else the job default.
      var eff = hasPin ? { lat: lat, lng: lng } : (_jobDef && _jobDef.coords ? _jobDef.coords : null);
      var effAddr = hasPin ? '' : (_jobDef ? _jobDef.address : '');
      var href = window.p86MapLink ? window.p86MapLink.url({ lat: eff && eff.lat, lng: eff && eff.lng, address: effAddr }) : '';
      link.style.display = href ? '' : 'none';
      if (href) link.href = href;
      accEl.textContent = (hasPin && _geoAcc) ? ('±' + Math.round(_geoAcc) + 'm') : '';
      if (note) {
        if (hasPin) {
          note.innerHTML = _jobDef ? 'Custom pin set — overrides the job’s location. “Clear pin” reverts to the job default.' : '';
          note.style.display = _jobDef ? '' : 'none';
        } else if (_jobDef && (_jobDef.coords || _jobDef.address)) {
          note.innerHTML = 'Defaults to the job’s location' + (_jobDef.address ? ': <b style="color:var(--text,#e9ecf5);">' + esc(_jobDef.address) + '</b>' : '') + '. Use “Pick on map” to set a specific spot.';
          note.style.display = '';
        } else {
          note.style.display = 'none';
        }
      }
    }
    syncGeoLink();
    h.modal.querySelector('#tdLat').addEventListener('input', function () { _geoAcc = null; syncGeoLink(); });
    h.modal.querySelector('#tdLng').addEventListener('input', function () { _geoAcc = null; syncGeoLink(); });
    h.modal.querySelector('#tdGeoClear').addEventListener('click', function () {
      h.modal.querySelector('#tdLat').value = ''; h.modal.querySelector('#tdLng').value = ''; _geoAcc = null; syncGeoLink();
    });
    var _pickBtn = h.modal.querySelector('#tdGeoPick');
    if (_pickBtn) _pickBtn.addEventListener('click', function () {
      if (!window.p86MapPicker) { toast('Map picker unavailable', 'error'); return; }
      var lat = parseFloat(h.modal.querySelector('#tdLat').value);
      var lng = parseFloat(h.modal.querySelector('#tdLng').value);
      var hasPin = isFinite(lat) && isFinite(lng);
      window.p86MapPicker.open({
        title: 'Set task location',
        lat: hasPin ? lat : undefined,
        lng: hasPin ? lng : undefined,
        fallbackLat: (_jobDef && _jobDef.coords) ? _jobDef.coords.lat : undefined,
        fallbackLng: (_jobDef && _jobDef.coords) ? _jobDef.coords.lng : undefined,
        address: (!hasPin && (!_jobDef || !_jobDef.coords) && _jobDef) ? _jobDef.address : undefined
      }).then(function (res) {
        if (!res) return;
        h.modal.querySelector('#tdLat').value = Number(res.lat).toFixed(6);
        h.modal.querySelector('#tdLng').value = Number(res.lng).toFixed(6);
        _geoAcc = null; syncGeoLink();
      });
    });
    h.modal.querySelector('#tdGeoMe').addEventListener('click', function () {
      var b = this, t0 = b.textContent; b.disabled = true; b.textContent = 'Locating…';
      var done = function () { b.disabled = false; b.textContent = t0; };
      var apply = function (lat, lng, acc) {
        h.modal.querySelector('#tdLat').value = Number(lat).toFixed(6);
        h.modal.querySelector('#tdLng').value = Number(lng).toFixed(6);
        _geoAcc = (acc != null) ? acc : null; syncGeoLink();
      };
      if (window.p86Geo && window.p86Geo.get) {
        window.p86Geo.get(60000).then(function (g) {
          done(); if (g) apply(g.lat, g.lng, g.accuracy); else toast('Location unavailable', 'error');
        }).catch(function () { done(); toast('Location unavailable', 'error'); });
      } else if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          function (p) { done(); apply(p.coords.latitude, p.coords.longitude, p.coords.accuracy); },
          function () { done(); toast('Location unavailable', 'error'); },
          { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
      } else { done(); toast('Geolocation not supported', 'error'); }
    });

    // ── Photos (attachments on entity_type='task'). Upload auto-geotags images;
    // the first geotagged photo seeds the task pin when none is set yet. ──
    // Photo geo-pins on the mini-map: every task photo carrying a GPS fix
    // (device or EXIF) drops a small circular thumbnail pin at where it was
    // shot; clicking it shows a thumbnail + "Expand & annotate" that opens the
    // shared photo viewer (annotate / tag / fullscreen) on that photo, and the
    // viewer's onClose refreshes tiles + pins. The task's own location stays a
    // standard marker so the two read as distinct.
    var _tdMap = null, _tdMaps = null, _tdPhotoMarkers = [], _tdInfoWin = null;
    var _photoImgs = null, _taskMarker = null, _taskCenter = null, _mapBuilding = false;

    function hasValidGeoTask(p) {
      if (!p) return false;
      var la = Number(p.lat), ln = Number(p.lng);
      if (!isFinite(la) || !isFinite(ln)) return false;
      if (la < -90 || la > 90 || ln < -180 || ln > 180) return false;
      if (la === 0 && ln === 0) return false;
      return true;
    }
    function isImageAtt(a) { return !!(a && (/^image\//.test(a.mime_type || '') || a.thumb_url || a.web_url)); }
    // Circular clipped-thumbnail marker icon (mirrors the proven projects.js
    // 'photo' pin: an SVG <image href=thumb_url> — Google Maps renders it fine
    // for same-origin storage URLs).
    function photoThumbIcon(maps, photo) {
      var thumb = photo.thumb_url || photo.web_url || '';
      if (!thumb) return undefined;
      var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">' +
        '<defs><clipPath id="tdpc"><circle cx="18" cy="18" r="15"/></clipPath>' +
        '<filter id="tdsh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.5"/></filter></defs>' +
        '<circle cx="18" cy="18" r="17" fill="#fff" filter="url(#tdsh)"/>' +
        '<image href="' + thumb + '" x="3" y="3" width="30" height="30" clip-path="url(#tdpc)" preserveAspectRatio="xMidYMid slice"/>' +
        '<circle cx="18" cy="18" r="15" fill="none" stroke="#2f6df6" stroke-width="2"/>' +
      '</svg>';
      return { url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg), anchor: new maps.Point(18, 36), scaledSize: new maps.Size(36, 36) };
    }
    // Open the shared viewer positioned on `photo`; onClose refreshes the task
    // tiles + pins (tags/annotations/deletes done in the viewer flow back).
    function openPhotoViewer(photo) {
      var list = Array.isArray(_photoImgs) ? _photoImgs : [];
      if (window.p86Attachments && window.p86Attachments.openLightbox) {
        var idx = list.findIndex(function (p) { return p.id === photo.id; });
        window.p86Attachments.openLightbox(list, Math.max(0, idx), { parentLabel: (task.title || 'Task'), parentSubtitle: '', onClose: function () { loadTaskPhotos(); } });
      } else if (photo.original_url || photo.web_url) {
        window.open(photo.original_url || photo.web_url, '_blank', 'noopener');
      }
    }
    // Strip Google's InfoWindow chrome for our photo tiles so the tile sits
    // flush (reads like the projects photo thumbnail, not a card in a padded
    // white bubble). Scoped via :has() so only OUR pin tiles are affected.
    function ensurePinIwCss() {
      if (document.getElementById('tdPinIwCss')) return;
      var st = document.createElement('style');
      st.id = 'tdPinIwCss';
      st.textContent =
        '.gm-style-iw-c:has(#tdPinTile){padding:0!important;border-radius:9px!important;overflow:hidden!important;box-shadow:0 3px 12px rgba(0,0,0,.45)!important;}' +
        '.gm-style-iw-c:has(#tdPinTile) .gm-style-iw-d{overflow:hidden!important;padding:0!important;max-height:none!important;}' +
        // Google's context drops the tile's aspect-ratio; pin it back to the
        // projects thumbnail's 4:3 so the preview matches the grid tile.
        '.gm-style-iw-c:has(#tdPinTile) .p86-proj-photo-tile-visual{aspect-ratio:auto!important;height:132px!important;}' +
        // Collapse Google's header row (holds the X) so no white strip sits
        // above the image; the X is floated back over the top-right corner.
        '.gm-style-iw-c:has(#tdPinTile) .gm-style-iw-chr{height:0!important;min-height:0!important;max-height:0!important;padding:0!important;overflow:visible!important;}' +
        '.gm-style-iw-c:has(#tdPinTile) .gm-style-iw-chr button{position:absolute!important;top:4px!important;right:4px!important;width:24px!important;height:24px!important;min-width:0!important;min-height:0!important;padding:0!important;margin:0!important;background:rgba(255,255,255,.92)!important;border-radius:6px!important;box-shadow:0 1px 3px rgba(0,0,0,.4)!important;opacity:1!important;z-index:3;}';
      document.head.appendChild(st);
    }
    // Match the projects photo thumbnail exactly: the shared .p86-proj-photo-tile
    // (4:3 rounded image + small footer). The whole tile is the click target and
    // opens the shared viewer — same "Click to open" affordance as the grid.
    function openPhotoInfo(marker, photo) {
      if (!_tdInfoWin) return;
      ensurePinIwCss();
      var thumb = photo.thumb_url || photo.web_url || '';
      var cap = photo.caption || photo.filename || 'Photo';
      var safeCap = String(cap).replace(/</g, '&lt;').replace(/>/g, '&gt;');
      var html =
        '<div class="p86-proj-photo-tile" id="tdPinTile" style="width:180px;cursor:pointer;" title="Click to open">' +
          '<div class="p86-proj-photo-tile-visual">' +
            (thumb ? '<img class="p86-proj-photo-tile-img" src="' + thumb + '" alt="" />' : '') +
          '</div>' +
          '<div class="p86-proj-photo-tile-footer">' +
            '<span style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + safeCap + '</span>' +
          '</div>' +
        '</div>';
      _tdInfoWin.setContent(html);
      _tdInfoWin.open(_tdMap, marker);
      setTimeout(function () {
        var t = document.getElementById('tdPinTile');
        if (t) t.addEventListener('click', function () { _tdInfoWin.close(); openPhotoViewer(photo); });
      }, 0);
    }
    function refreshMarkers() {
      if (!_tdMap || !_tdMaps) return;
      var maps = _tdMaps;
      if (!_tdInfoWin) _tdInfoWin = new maps.InfoWindow({ maxWidth: 210 });
      if (_taskCenter && !_taskMarker) {
        _taskMarker = new maps.Marker({ position: _taskCenter, map: _tdMap, title: 'Task location', zIndex: 999 });
      }
      _tdPhotoMarkers.forEach(function (m) { try { m.setMap(null); } catch (e) {} });
      _tdPhotoMarkers = [];
      var geo = Array.isArray(_photoImgs) ? _photoImgs.filter(hasValidGeoTask) : [];
      var bounds = new maps.LatLngBounds();
      if (_taskCenter) bounds.extend(_taskCenter);
      geo.forEach(function (photo) {
        var pos = { lat: Number(photo.lat), lng: Number(photo.lng) };
        var marker = new maps.Marker({ position: pos, map: _tdMap, icon: photoThumbIcon(maps, photo), title: photo.caption || photo.filename || 'Photo' });
        bounds.extend(pos);
        marker.addListener('click', function () { openPhotoInfo(marker, photo); });
        _tdPhotoMarkers.push(marker);
      });
      var ptCount = (_taskCenter ? 1 : 0) + geo.length;
      if (ptCount > 1) {
        _tdMap.fitBounds(bounds, 36);
        maps.event.addListenerOnce(_tdMap, 'idle', function () { if (_tdMap.getZoom() > 18) _tdMap.setZoom(18); });
      } else if (ptCount === 1) {
        var only = _taskCenter || { lat: Number(geo[0].lat), lng: Number(geo[0].lng) };
        _tdMap.setCenter(only); _tdMap.setZoom(17);
      }
    }
    // Build the mini-map once (centered on the task pin, else the first
    // geotagged photo) then (re)draw markers. Called from both paintViewLoc
    // (when the pin is known) and loadTaskPhotos (when photos arrive); it is
    // idempotent and safe to call in either order.
    function drawTaskMap() {
      if (!window.p86Maps || typeof window.p86Maps.ready !== 'function') return;
      var geo = Array.isArray(_photoImgs) ? _photoImgs.filter(hasValidGeoTask) : [];
      var center = _taskCenter || (geo.length ? { lat: Number(geo[0].lat), lng: Number(geo[0].lng) } : null);
      if (!center) return;
      var mapEl = h.modal.querySelector('#tdMiniMap'); if (!mapEl) return;
      if (_tdMap) { refreshMarkers(); return; }
      if (_mapBuilding) return;
      _mapBuilding = true;
      mapEl.style.display = 'block';
      window.p86Maps.ready().then(function (maps) {
        _tdMaps = maps;
        _tdMap = new maps.Map(mapEl, { center: center, zoom: 17, mapTypeId: maps.MapTypeId.HYBRID, disableDefaultUI: true, gestureHandling: 'cooperative' });
        _mapBuilding = false;
        setTimeout(function () { try { maps.event.trigger(_tdMap, 'resize'); } catch (e) {} refreshMarkers(); }, 90);
      }).catch(function () { _mapBuilding = false; mapEl.style.display = 'none'; });
    }
    function loadTaskPhotos() {
      var host = h.modal.querySelector('#tdPhotos');
      var vhost = h.modal.querySelector('#tdViewPhotos');
      if (!window.p86Api || !p86Api.attachments) { if (host) host.innerHTML = ''; if (vhost) vhost.innerHTML = ''; return; }
      p86Api.attachments.list('task', task.id).then(function (resp) {
        var atts = (resp && resp.attachments) || [];
        var imgs = atts.filter(isImageAtt);
        _photoImgs = imgs;
        var empty = '<span style="font-size:12px;color:var(--text-dim,#888);">No photos yet.</span>';
        // Tiles open the shared in-app viewer (annotate/tag/fullscreen), not a
        // raw new tab. A small blue dot marks photos that also appear on the map.
        function tile(a, i, big) {
          var u = a.thumb_url || a.web_url || '';
          var box = big ? 'aspect-ratio:1;border-radius:10px;' : 'width:54px;height:54px;border-radius:6px;';
          return '<div class="td-photo-tile" data-pi="' + i + '" role="button" tabindex="0" title="' + escAttr(a.filename || '') + '" ' +
            'style="position:relative;display:block;' + box + 'overflow:hidden;border:1px solid var(--border,#333);background:#0f1420;cursor:pointer;">' +
            (u ? '<img src="' + escAttr(u) + '" alt="" style="width:100%;height:100%;object-fit:cover;pointer-events:none;" />' : '') +
            (hasValidGeoTask(a) ? '<span title="On the map" style="position:absolute;right:3px;bottom:3px;width:' + (big ? 13 : 10) + 'px;height:' + (big ? 13 : 10) + 'px;border-radius:50%;background:rgba(47,109,246,.95);border:1.5px solid #fff;box-shadow:0 0 2px rgba(0,0,0,.5);"></span>' : '') +
            '</div>';
        }
        function wireTiles(hostEl) {
          if (!hostEl) return;
          hostEl.querySelectorAll('[data-pi]').forEach(function (el) {
            function open() { var p = imgs[+el.getAttribute('data-pi')]; if (p) openPhotoViewer(p); }
            el.addEventListener('click', open);
            el.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
          });
        }
        if (host) { host.innerHTML = imgs.length ? imgs.map(function (a, i) { return tile(a, i, false); }).join('') : empty; wireTiles(host); }
        if (vhost) { vhost.innerHTML = imgs.length ? imgs.map(function (a, i) { return tile(a, i, true); }).join('') : ('<span style="grid-column:1/-1;font-size:12px;color:var(--text-dim,#888);">No photos yet.</span>'); wireTiles(vhost); }
        drawTaskMap();
      }).catch(function () { if (host) host.innerHTML = ''; if (vhost) vhost.innerHTML = ''; });
    }
    loadTaskPhotos();
    h.modal.querySelector('#tdAddPhoto').addEventListener('click', function () { h.modal.querySelector('#tdPhotoInput').click(); });
    h.modal.querySelector('#tdPhotoInput').addEventListener('change', function () {
      var files = Array.prototype.slice.call(this.files || []); if (!files.length) return;
      var input = this, btn = h.modal.querySelector('#tdAddPhoto'), t0 = btn.textContent;
      btn.disabled = true; btn.textContent = 'Uploading…';
      var seq = Promise.resolve();
      files.forEach(function (f) {
        seq = seq.then(function () {
          return p86Api.attachments.upload('task', task.id, f).then(function (r) {
            var att = (r && (r.attachment || r)) || {};
            var latEl = h.modal.querySelector('#tdLat'), lngEl = h.modal.querySelector('#tdLng');
            if ((!latEl.value || !lngEl.value) && att.lat != null && att.lng != null) {
              latEl.value = Number(att.lat).toFixed(6); lngEl.value = Number(att.lng).toFixed(6);
              if (att.geo_accuracy != null) _geoAcc = Number(att.geo_accuracy);
              syncGeoLink();
            }
          });
        });
      });
      seq.then(function () { btn.disabled = false; btn.textContent = t0; input.value = ''; loadTaskPhotos(); toast('Photo added', 'success'); })
         .catch(function (e) { btn.disabled = false; btn.textContent = t0; input.value = ''; loadTaskPhotos(); toast((e && e.message) || 'Upload failed', 'error'); });
    });

    h.modal.querySelector('#tdSave').addEventListener('click', function () {
      var title = (h.modal.querySelector('#tdTitle').value || '').trim();
      if (!title) { h.modal.querySelector('#tdTitle').focus(); return; }
      var asg = h.modal.querySelector('#tdAssignee').value;
      var _lat = parseFloat(h.modal.querySelector('#tdLat').value);
      var _lng = parseFloat(h.modal.querySelector('#tdLng').value);
      var _hasPin = isFinite(_lat) && isFinite(_lng);
      var payload = {
        title: title,
        notes: h.modal.querySelector('#tdNotes').value || '',
        status: h.modal.querySelector('#tdStatus').value,
        priority: h.modal.querySelector('#tdPriority').value,
        kind: h.modal.querySelector('#tdKind').value,
        due_date: h.modal.querySelector('#tdDue').value || null,
        assignee_user_id: asg ? Number(asg) : null,
        checklist: clState.filter(function (c) { return (c.text || '').trim(); }),
        directions: h.modal.querySelector('#tdDirections').value || null,
        lat: _hasPin ? _lat : null,
        lng: _hasPin ? _lng : null,
        geo_accuracy: _hasPin ? (_geoAcc || null) : null
      };
      var btn = h.modal.querySelector('#tdSave');
      btn.disabled = true; btn.textContent = 'Saving…';
      api().update(task.id, payload).then(function () {
        toast('Saved', 'success');
        h.close();
        refreshOpenSurfaces();
      }).catch(function (e) {
        btn.disabled = false; btn.textContent = 'Save';
        toast((e && e.message) || 'Could not save', 'error');
      });
    });

    h.modal.querySelector('#tdDelete').addEventListener('click', function () {
      // Native confirm() returns undefined inside the installed PWA, so
      // `if (!window.confirm(...)) return` was always true there and Delete
      // silently did nothing. p86Confirm returns a PROMISE — which is truthy,
      // so it must be awaited, never tested directly, or the opposite bug
      // appears and the task is deleted without asking.
      askConfirm('Delete this task? It will be archived.').then(function (ok) {
        if (!ok) return;
        api().remove(task.id).then(function () {
          toast('Task deleted', 'success');
          h.close();
          refreshOpenSurfaces();
        }).catch(function (e) { toast((e && e.message) || 'Could not delete', 'error'); });
      });
    });

    // ── View ⇄ Edit gate + read-only dashboard wiring ──────────────────
    function _showEdit(on) {
      h.modal.querySelector('#tdView').style.display = on ? 'none' : '';
      h.modal.querySelector('#tdEdit').style.display = on ? '' : 'none';
      h.modal.querySelector('#tdFooter').style.display = on ? 'flex' : 'none';
      h.modal.querySelector('#tdEditBtn').style.display = on ? 'none' : '';
    }
    // Address search on the location picker — same Places autocomplete as the
    // rest of the app. Attached lazily on first Edit (so it mounts visible, not
    // inside the hidden edit panel); a pick fills the task's lat/lng pin.
    var _addrAttached = false;
    function attachAddrSearch() {
      if (_addrAttached || !window.p86AddressAutocomplete || !window.p86AddressAutocomplete.attach) return;
      var mount = h.modal.querySelector('#tdAddrSearch'); if (!mount) return;
      _addrAttached = true;
      try {
        window.p86AddressAutocomplete.attach({
          mount: mount, placeholder: 'Search an address…',
          onPlace: function (r) {
            if (r && r.lat != null && r.lng != null) {
              h.modal.querySelector('#tdLat').value = Number(r.lat).toFixed(6);
              h.modal.querySelector('#tdLng').value = Number(r.lng).toFixed(6);
              _geoAcc = null; syncGeoLink();
              toast('Pin set from the address', 'success');
            }
          }
        });
      } catch (e) {}
    }
    h.modal.querySelector('#tdEditBtn').addEventListener('click', function () { _showEdit(true); attachAddrSearch(); });
    var _cancelEdit = h.modal.querySelector('#tdCancelEdit');
    if (_cancelEdit) _cancelEdit.addEventListener('click', function () { _showEdit(false); });

    function _refreshPunchProgress() {
      var total = clState.length, done = clState.filter(function (c) { return c.done; }).length;
      var cnt = h.modal.querySelector('#tdPunchCount'), bar = h.modal.querySelector('#tdPunchBar');
      if (cnt) cnt.textContent = done + ' of ' + total + ' done';
      if (bar) bar.style.width = (total ? Math.round(done / total * 100) : 0) + '%';
    }
    // Read-only punch list: tap a box to toggle + persist, no unlock needed.
    function paintViewChecklist() {
      var host = h.modal.querySelector('#tdViewChecklist'); if (!host) return;
      host.innerHTML = clState.map(function (c, i) {
        return '<label style="display:flex;gap:9px;align-items:flex-start;cursor:pointer;color:' + (c.done ? 'var(--text-dim,#888)' : 'var(--text,#e9ecf5)') + ';">' +
          '<input type="checkbox" data-vcl="' + i + '"' + (c.done ? ' checked' : '') + ' style="margin-top:2px;width:16px;height:16px;flex:none;" />' +
          '<span style="' + (c.done ? 'text-decoration:line-through;' : '') + '">' + esc(c.text || '') + '</span></label>';
      }).join('');
      host.querySelectorAll('[data-vcl]').forEach(function (el) {
        el.addEventListener('change', function () {
          clState[+el.getAttribute('data-vcl')].done = el.checked;
          try { paintChecklist(); } catch (e) {}
          _refreshPunchProgress();
          paintViewChecklist();
          api().update(task.id, { checklist: clState.filter(function (c) { return (c.text || '').trim(); }) })
            .then(function () { refreshOpenSurfaces(); })
            .catch(function () { toast('Could not save', 'error'); });
        });
      });
    }
    paintViewChecklist();

    // Read-only location line + Directions link (own pin, else the job default).
    (function paintViewLoc() {
      var lat = parseFloat(task.lat), lng = parseFloat(task.lng);
      var hasPin = isFinite(lat) && isFinite(lng);
      var eff = hasPin ? { lat: lat, lng: lng } : (_jobDef && _jobDef.coords ? _jobDef.coords : null);
      var effAddr = hasPin ? '' : (_jobDef ? _jobDef.address : '');
      var line = h.modal.querySelector('#tdViewLocLine'), btn = h.modal.querySelector('#tdViewDirBtn');
      var label = effAddr || (eff ? (Number(eff.lat).toFixed(5) + ', ' + Number(eff.lng).toFixed(5)) : '');
      if (line) line.textContent = label || 'No location set';
      var href = (eff && window.p86MapLink) ? window.p86MapLink.url({ lat: eff.lat, lng: eff.lng, address: effAddr }) : '';
      if (btn) { if (href) { btn.href = href; btn.style.display = ''; } else { btn.style.display = 'none'; } }
      // Immersive mini-map (interactive HYBRID/satellite). The task's own
      // location is a standard marker; every geotagged task photo adds a
      // circular thumbnail pin (drawn once the photos load). drawTaskMap()
      // builds the map once and is safe to call from here + loadTaskPhotos,
      // in either order.
      _taskCenter = eff ? { lat: Number(eff.lat), lng: Number(eff.lng) } : null;
      drawTaskMap();
    })();

    // Take / Upload in the view reuse the edit form's file input; tiles open the image.
    var _vt = h.modal.querySelector('#tdViewTake'), _vu = h.modal.querySelector('#tdViewUpload');
    var _photoInp = h.modal.querySelector('#tdPhotoInput');
    if (_vt && _photoInp) _vt.addEventListener('click', function () { _photoInp.click(); });
    if (_vu && _photoInp) _vu.addEventListener('click', function () { _photoInp.click(); });

    // ── Share: send this task to an outside worker by email ──
    var _shareLoaded = false;
    var shareBtn = h.modal.querySelector('#tdShareBtn');
    if (shareBtn) shareBtn.addEventListener('click', function () {
      var panel = h.modal.querySelector('#tdSharePanel'); if (!panel) return;
      var open = (panel.style.display === 'none' || !panel.style.display);
      panel.style.display = open ? '' : 'none';
      if (open && !_shareLoaded) { _shareLoaded = true; populateShareSubs(); loadShares(); }
    });
    function populateShareSubs() {
      var sel = h.modal.querySelector('#tdShareSub'); if (!sel) return;
      var subs = (window.appData && appData.subsDirectory) || [];
      var opts = '<option value="">— Pick a sub (or just type an email) —</option>';
      subs.slice().sort(function (a, b) { return String(a.name || '').localeCompare(String(b.name || '')); }).forEach(function (s) {
        opts += '<option value="' + escAttr(s.id) + '" data-email="' + escAttr(s.email || '') + '">' + esc(s.name || '(unnamed)') + (s.email ? '' : ' — no email') + '</option>';
      });
      sel.innerHTML = opts;
      sel.addEventListener('change', function () {
        var o = sel.options[sel.selectedIndex], em = o && o.getAttribute('data-email');
        if (em) h.modal.querySelector('#tdShareEmail').value = em;
      });
    }
    function loadShares() {
      var host = h.modal.querySelector('#tdShareList'); if (!host) return;
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);">Loading links…</div>';
      api().shares(task.id).then(function (r) {
        var rows = (r && r.shares) || [];
        if (!rows.length) { host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);">No links sent yet.</div>'; return; }
        host.innerHTML = '<div style="font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--text-dim,#888);margin-bottom:4px;">Sent links</div>' + rows.map(function (s) {
          var color = s.state === 'completed' ? 'var(--green,#22c55e)' : (s.state === 'revoked' || s.state === 'expired') ? 'var(--text-dim,#888)' : 'var(--accent,#4f8cff)';
          var canRevoke = (s.state === 'sent' || s.state === 'opened');
          return '<div style="display:flex;justify-content:space-between;align-items:center;gap:8px;padding:6px 0;border-top:1px solid var(--border,#333);font-size:12.5px;">' +
            '<span style="min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(s.recipient_name || s.recipient_email) + ' <span style="color:' + color + ';">&middot; ' + esc(s.state) + '</span></span>' +
            (canRevoke ? '<button class="ee-btn secondary" data-revoke="' + escAttr(s.id) + '" style="font-size:11px;flex:none;">Revoke</button>' : '') +
          '</div>';
        }).join('');
        host.querySelectorAll('[data-revoke]').forEach(function (el) {
          el.addEventListener('click', function () {
            el.disabled = true;
            api().revokeShare(task.id, el.getAttribute('data-revoke')).then(function () { toast('Link revoked'); loadShares(); }).catch(function () { el.disabled = false; toast('Could not revoke', 'error'); });
          });
        });
      }).catch(function () { host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);">Could not load links.</div>'; });
    }
    var shareSend = h.modal.querySelector('#tdShareSend');
    if (shareSend) shareSend.addEventListener('click', function () {
      var sub = h.modal.querySelector('#tdShareSub').value || null;
      var email = (h.modal.querySelector('#tdShareEmail').value || '').trim();
      var days = Number(h.modal.querySelector('#tdShareDays').value) || 14;
      if (!email || email.indexOf('@') < 0) { toast('Enter a valid email', 'error'); return; }
      shareSend.disabled = true; shareSend.textContent = 'Sending…';
      api().share(task.id, { sub_id: sub, email: email, days: days }).then(function (r) {
        shareSend.disabled = false; shareSend.textContent = 'Send link';
        var res = h.modal.querySelector('#tdShareResult'), sent = r && r.email_sent;
        res.innerHTML = (sent ? '<span style="color:var(--green,#22c55e);">Sent to ' + esc(email) + '.</span> ' : '<span style="color:var(--orange,#e0a458);">Link created (email is off — copy it):</span> ') +
          (r && r.link ? '<a href="' + escAttr(r.link) + '" target="_blank" rel="noopener" style="color:var(--accent,#4f8cff);word-break:break-all;">' + esc(r.link) + '</a>' : '');
        toast(sent ? 'Link sent' : 'Link created', 'success');
        loadShares();
      }).catch(function (e) { shareSend.disabled = false; shareSend.textContent = 'Send link'; toast((e && e.message) || 'Could not send', 'error'); });
    });
  }

  // ── List renderer ──────────────────────────────────────────────────
  // container: DOM node. filter: object → p86Api.tasks.list. opts:
  //   { emptyText, onChange() }  — returns { refresh }.
  function mountList(container, filter, opts) {
    if (!container) return { refresh: function () {} };
    opts = opts || {};
    ensureStyles();
    filter = filter || {};

    // Bucket a task for the grouped view — mirrors dueChip's overdue/today logic.
    function taskBucket(t) {
      if (t.status === 'done') return 'done';
      var d = (t.due_date || '').slice(0, 10);
      if (!d) return 'nodate';
      var today = todayISO();
      if (d < today) return 'overdue';
      if (d === today) return 'today';
      return 'upcoming';
    }
    var GROUP_ORDER = [
      ['overdue', 'Overdue'], ['today', 'Today'], ['upcoming', 'Upcoming'],
      ['nodate', 'No due date'], ['done', 'Completed']
    ];

    function inlineAddHTML() {
      return '<div class="p86-tg-addrow"><span class="p86-tg-addplus">＋</span>' +
        '<input class="p86-tg-addinput" type="text" placeholder="Add a task and press Enter…" aria-label="Add a task" /></div>';
    }
    function wireInlineAdd() {
      var ai = container.querySelector('.p86-tg-addinput');
      if (!ai || !opts.onAdd) return;
      ai.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();
        var v = (ai.value || '').trim();
        if (!v) return;
        ai.disabled = true;
        opts.onAdd(v, function (ok) { ai.disabled = false; if (ok) ai.value = ''; });
      });
    }

    function paint(tasks) {
      tasks = tasks || [];
      // Client-side Priority filter (the chip bar's "+ Filter → Priority").
      if (opts.priorityFilter) {
        tasks = tasks.filter(function (t) { return t.priority === opts.priorityFilter; });
      }
      if (typeof opts.onCount === 'function') opts.onCount(tasks.length);
      if (!tasks.length) {
        if (opts.onAdd) {
          container.innerHTML = '<div class="p86-taskgrid-wrap"><div class="p86-taskgrid">' + gridHeadHTML() +
            '<div class="p86-tg-emptyrow">' + esc(opts.emptyText || 'No tasks here.') + '</div>' +
            inlineAddHTML() + '</div></div>';
          wireInlineAdd();
        } else {
          container.innerHTML = '<div class="p86-task-empty">' + esc(opts.emptyText || 'No tasks here.') + '</div>';
        }
        return;
      }
      if (opts.grouped) {
        // Grid view — Buildertrend-style columns fused with our grouped sections.
        // Buckets render only when non-empty, so a narrow filter collapses to a
        // single section header. Flat (entity-page widgets) keeps one plain list.
        var groups = { overdue: [], today: [], upcoming: [], nodate: [], done: [] };
        tasks.forEach(function (t) { groups[taskBucket(t)].push(t); });
        var body = '';
        GROUP_ORDER.forEach(function (g) {
          var arr = groups[g[0]];
          if (!arr.length) return;
          body += '<div class="p86-tg-group">' +
              '<span class="p86-tg-glabel is-' + g[0] + '">' + esc(g[1]) + '</span>' +
              '<span class="p86-tg-gcount is-' + g[0] + '">' + arr.length + '</span>' +
            '</div>' + arr.map(gridRowHTML).join('');
        });
        if (opts.onAdd) body += inlineAddHTML();
        container.innerHTML =
          '<div class="p86-taskgrid-wrap"><div class="p86-taskgrid">' + gridHeadHTML() + body + '</div></div>';
      } else {
        container.innerHTML = '<div class="p86-task-list">' + tasks.map(rowHTML).join('') + '</div>';
      }
      wireRows(container, tasks);
      wireInlineAdd();
    }

    function rowHTML(t) {
      var done = t.status === 'done';
      var pm = priorityMeta(t.priority);
      var meta = [];
      var dc = dueChip(t.due_date, done);
      if (dc) meta.push(dc);
      if (t.kind && t.kind !== 'todo') meta.push('<span>' + esc((KINDS.filter(function (k) { return k.v === t.kind; })[0] || {}).label || t.kind) + '</span>');
      if (t.assignee_user_id) {
        var nm = t.assignee_name || userName(t.assignee_user_id);
        meta.push('<span class="p86-task-avatar" title="' + escAttr(nm) + '">' + esc(initialsOf(nm)) + '</span>');
      }
      if (t.linked_label || (t.entity_type && t.entity_id)) {
        meta.push('<span class="p86-task-link">' + esc(t.linked_label || (t.entity_type)) + '</span>');
      }
      if (t.photo_count) meta.push('<span title="Photos">📷 ' + t.photo_count + '</span>');
      if (t.status && t.status !== 'open' && t.status !== 'done') {
        meta.push('<span>' + esc((STATUSES.filter(function (s) { return s.v === t.status; })[0] || {}).label || t.status) + '</span>');
      }
      return '<div class="p86-task-item' + (done ? ' is-done' : '') + '" data-task-id="' + escAttr(t.id) + '">' +
        '<button class="p86-task-check' + (done ? ' done' : '') + '" data-toggle title="' + (done ? 'Mark not done' : 'Mark done') + '"></button>' +
        '<span class="p86-task-pdot" style="background:' + pm.color + ';" title="' + escAttr(pm.label) + ' priority"></span>' +
        '<div class="p86-task-main">' +
          '<div class="p86-task-title" data-open>' + esc(t.title) + '</div>' +
          (meta.length ? '<div class="p86-task-meta">' + meta.join('') + '</div>' : '') +
        '</div>' +
      '</div>';
    }

    // Grid row (columnar view) — same task, laid out as Buildertrend-style cells.
    // Carries data-task-id + [data-toggle] + [data-open] so wireRows binds it.
    function gridRowHTML(t) {
      var done = t.status === 'done';
      var pm = priorityMeta(t.priority);
      var dc = dueChip(t.due_date, done);
      var whoCell = '<span class="p86-tg-dash">—</span>';
      if (t.assignee_user_id) {
        var nm = t.assignee_name || userName(t.assignee_user_id);
        whoCell = '<span class="p86-task-avatar" title="' + escAttr(nm) + '">' + esc(initialsOf(nm)) + '</span>' +
                  '<span class="p86-tg-who-nm">' + esc(shortName(nm)) + '</span>';
      }
      var jobCell = '<span class="p86-tg-dash">—</span>';
      if (t.linked_label || (t.entity_type && t.entity_id)) {
        var jl = t.linked_label ||
          (window.entityDisplayName ? window.entityDisplayName(t.entity_type, t.entity_id) : t.entity_type);
        jobCell = '<span class="p86-task-link" title="' + escAttr(jl) + '">' + esc(jl) + '</span>';
      }
      var cam = t.photo_count ? '<span class="p86-tg-cam" title="Photos">📷 ' + t.photo_count + '</span>' : '';
      return '<div class="p86-tg-row' + (done ? ' is-done' : '') + '" data-task-id="' + escAttr(t.id) + '">' +
          '<div class="p86-tg-c p86-tg-check"><button class="p86-task-check' + (done ? ' done' : '') + '" data-toggle title="' + (done ? 'Mark not done' : 'Mark done') + '"></button></div>' +
          '<div class="p86-tg-c p86-tg-task"><span class="p86-tg-title" data-open>' + esc(t.title) + '</span>' + cam + '</div>' +
          '<div class="p86-tg-c p86-tg-due">' + (dc || '<span class="p86-tg-dash">—</span>') + '</div>' +
          '<div class="p86-tg-c p86-tg-prio"><span class="p86-tg-prio-tag"><span class="p86-tg-prio-dot" style="background:' + pm.color + ';"></span>' + esc(pm.label) + '</span></div>' +
          '<div class="p86-tg-c p86-tg-who">' + whoCell + '</div>' +
          '<div class="p86-tg-c p86-tg-job">' + jobCell + '</div>' +
          '<div class="p86-tg-c p86-tg-made">' + (t.created_at ? '<span class="p86-tg-made-txt">' + esc(shortDate(t.created_at)) + '</span>' : '<span class="p86-tg-dash">—</span>') + '</div>' +
        '</div>';
    }
    function gridHeadHTML() {
      return '<div class="p86-tg-head">' +
          '<div class="p86-tg-c p86-tg-check"></div>' +
          '<div class="p86-tg-c p86-tg-task">Task</div>' +
          '<div class="p86-tg-c p86-tg-due">Due</div>' +
          '<div class="p86-tg-c p86-tg-prio">Priority</div>' +
          '<div class="p86-tg-c p86-tg-who">Assignee</div>' +
          '<div class="p86-tg-c p86-tg-job">Job</div>' +
          '<div class="p86-tg-c p86-tg-made">Created</div>' +
        '</div>';
    }

    function wireRows(root, tasks) {
      var byId = {};
      tasks.forEach(function (t) { byId[t.id] = t; });
      root.querySelectorAll('.p86-task-item, .p86-tg-row').forEach(function (row) {
        var id = row.getAttribute('data-task-id');
        var toggle = row.querySelector('[data-toggle]');
        var open = row.querySelector('[data-open]');
        if (toggle) toggle.addEventListener('click', function (e) {
          e.stopPropagation();
          var t = byId[id];
          var next = (t && t.status === 'done') ? 'open' : 'done';
          toggle.disabled = true;
          api().update(id, { status: next }).then(function () {
            refresh();
            if (typeof opts.onChange === 'function') opts.onChange();
          }).catch(function (err) {
            toggle.disabled = false;
            toast((err && err.message) || 'Could not update', 'error');
          });
        });
        if (open) open.addEventListener('click', function () { openDetail(id); });
      });
    }

    function refresh() {
      if (!api()) { container.innerHTML = '<div class="p86-task-empty">Not connected.</div>'; return Promise.resolve(); }
      container.innerHTML = '<div class="p86-task-empty">Loading…</div>';
      return loadUsers().then(function () {
        return api().list(filter);
      }).then(function (res) {
        paint((res && res.tasks) || []);
      }).catch(function (e) {
        container.innerHTML = '<div class="p86-task-empty">' + esc((e && e.message) || 'Could not load tasks.') + '</div>';
      });
    }

    refresh();
    return { refresh: refresh };
  }

  // ── Appointments subsection (entity-page calendar events) ──────────
  // The per-user personal calendar (window.p86Api.calendar) is owner +
  // org scoped server-side. We list only the events LINKED to this
  // entity, so a client/job page shows "my appointments about this
  // record." Calendar sharing / attendees aren't built yet, so this is
  // intentionally a personal view (the viewer's own linked events).
  function calApi() { return window.p86Api && window.p86Api.calendar; }
  function scheduleEditor() {
    return (window.p86Schedule && window.p86Schedule.openEventEditor) || null;
  }
  // "Mon, Jun 23 · 9:00 AM" / "Mon, Jun 23 · All day".
  function apptWhen(ev) {
    if (!ev || !ev.starts_at) return '';
    var d = new Date(ev.starts_at);
    if (isNaN(d.getTime())) return '';
    var opts = { weekday: 'short', month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    var dateStr;
    try { dateStr = d.toLocaleDateString(undefined, opts); } catch (e) { dateStr = isoDay(d); }
    if (ev.all_day) return dateStr + ' · All day';
    var timeStr = '';
    try { timeStr = d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' }); } catch (e) {}
    return dateStr + (timeStr ? ' · ' + timeStr : '');
  }
  function mountApptList(host, entityType, entityId) {
    if (!host) return { refresh: function () {} };
    function refresh() {
      var api = calApi();
      if (!api || !authed()) {
        host.innerHTML = '<div class="p86-appt-empty">Sign in to see appointments.</div>';
        return;
      }
      host.innerHTML = '<div class="p86-appt-empty">Loading…</div>';
      api.list({ entity_type: entityType, entity_id: String(entityId) }).then(function (res) {
        var events = (res && res.events) || [];
        if (!events.length) {
          host.innerHTML = '<div class="p86-appt-empty">No appointments for this ' + esc(entityType) + ' yet.</div>';
          return;
        }
        host.innerHTML = '<div class="p86-appt-list">' + events.map(function (ev) {
          var sCls = ev.status === 'canceled' ? ' canceled' : (ev.status === 'tentative' ? ' tentative' : '');
          var loc = ev.location ? '<span class="p86-appt-loc">· ' + esc(ev.location) + '</span>' : '';
          return '<button type="button" class="p86-appt-row' + sCls + '" data-ev-id="' + escAttr(ev.id) + '">' +
              '<span class="p86-appt-dot"></span>' +
              '<span class="p86-appt-main">' +
                '<span class="p86-appt-title">' + esc(ev.title || '(untitled event)') + '</span>' +
                '<span class="p86-appt-when">' + esc(apptWhen(ev)) + loc + '</span>' +
              '</span>' +
            '</button>';
        }).join('') + '</div>';
        var openEd = scheduleEditor();
        host.querySelectorAll('[data-ev-id]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            if (!openEd) return;
            var id = btn.getAttribute('data-ev-id');
            var ev = events.filter(function (x) { return String(x.id) === String(id); })[0];
            if (ev) openEd(ev, null, { onSaved: refresh });
          });
        });
      }).catch(function () {
        host.innerHTML = '<div class="p86-appt-empty">Could not load appointments.</div>';
      });
    }
    refresh();
    return { refresh: refresh };
  }

  // Calendar events can only link to these types (server LINK_TYPES in
  // calendar-routes.js). The Appointments subsection only renders for
  // them; estimate/sub pages keep just the Tasks panel so a "+ Add"
  // can't silently create an unlinked event that never shows here.
  var CAL_LINK_TYPES = ['client', 'job', 'lead', 'project'];

  // ── Entity-page panel (Tasks + Appointments embedded on a detail page)
  // Renders Tasks (scoped to the entity) and — for calendar-linkable
  // types — Appointments (the viewer's own calendar events linked to the
  // entity). Each has a "+ Add" that prefills the link. Returns { refresh }.
  function mountEntityPanel(container, entityType, entityId, entityLabel) {
    if (!container) return { refresh: function () {} };
    ensureStyles();
    var showAppts = CAL_LINK_TYPES.indexOf(entityType) >= 0;
    var canAddAppt = showAppts && !!scheduleEditor();
    container.innerHTML =
      '<div class="p86-task-panel">' +
        '<div class="p86-task-panel-head"><h4>Tasks</h4>' +
          '<button type="button" class="ee-btn secondary" data-add-task>+ Add</button></div>' +
        '<div data-task-list></div>' +
      '</div>' +
      (showAppts
        ? '<div class="p86-task-panel p86-appt-panel">' +
            '<div class="p86-task-panel-head"><h4>Appointments</h4>' +
              (canAddAppt ? '<button type="button" class="ee-btn secondary" data-add-appt>+ Add</button>' : '') +
            '</div>' +
            '<div data-appt-list></div>' +
          '</div>'
        : '');

    var listHost = container.querySelector('[data-task-list]');
    var mounted = mountList(listHost, { entity_type: entityType, entity_id: String(entityId) }, {
      emptyText: 'No tasks yet for this ' + entityType + '.'
    });
    container.querySelector('[data-add-task]').addEventListener('click', function () {
      openQuickAdd(
        { entity_type: entityType, entity_id: String(entityId), entity_label: entityLabel },
        { onCreated: function () { mounted.refresh(); } }
      );
    });

    var appts = { refresh: function () {} };
    if (showAppts) {
      appts = mountApptList(container.querySelector('[data-appt-list]'), entityType, entityId);
      var addAppt = container.querySelector('[data-add-appt]');
      if (addAppt) {
        addAppt.addEventListener('click', function () {
          var openEd = scheduleEditor();
          if (!openEd) return;
          openEd(null, null, {
            prefillEntity: { type: entityType, id: String(entityId), label: entityLabel },
            onSaved: function () { appts.refresh(); }
          });
        });
      }
    }

    var ctl = { refresh: function () { mounted.refresh(); appts.refresh(); } };
    registerTaskSurface(container, ctl);
    return ctl;
  }

  // ── Tasks & Reminders page (3-tier model) ──────────────────────────
  // Three tabs:
  //   • Team Tasks  — org-wide, assignable, filterable by user + date.
  //   • My To-Dos   — private personal items (scope='personal'), just mine.
  //   • Reminders   — timed nudges on their own list (lower tier; emailed).
  // Date-window filters reused across the task tabs (no assignee baked in —
  // the Team tab layers a user filter on top; To-Dos are all mine already).
  var TASK_FILTERS = [
    { key: 'open',     label: 'All open',  build: function () { return { exclude_done: 1 }; } },
    { key: 'today',    label: 'Today',     build: function () { return { exclude_done: 1, due_before: todayISO() }; } },
    { key: 'upcoming', label: 'Upcoming',  build: function () { return { exclude_done: 1, due_after: shiftISO(1) }; } },
    { key: 'overdue',  label: 'Overdue',   build: function () { return { exclude_done: 1, due_before: shiftISO(-1) }; } },
    { key: 'done',     label: 'Done',      build: function () { return { status: 'done', limit: 100 }; } }
  ];
  var _activeTab = 'team';     // team | todos | reminders
  var _teamFilter = 'open';
  var _teamUser = '';          // '' = everyone | 'me' | 'unassigned' | <id>
  var _teamPriority = '';      // '' = any | urgent | high | normal | low (client-side)
  var _todoPriority = '';
  var _compact = false;        // header density toggle
  var _todoFilter = 'open';
  var _remStatus = 'pending';  // pending | all
  var _ctl = { team: null, todos: null, reminders: null };

  function filterBtns(filters, activeKey, dataAttr) {
    return filters.map(function (f) {
      return '<button class="p86-tasks-filter' + (f.key === activeKey ? ' active' : '') +
        '" ' + dataAttr + '="' + f.key + '">' + esc(f.label) + '</button>';
    }).join('');
  }

  // ── Buildertrend-style filter chip bar ─────────────────────────────
  // Styled native <select>s (robust — no custom dropdown / outside-click /
  // positioning). `s` holds the live values; the caller wires it. Value
  // changes just remount the list; structural changes (add/remove a chip,
  // clear all) re-render the bar and remount.
  function fbarOpts(list, val) {
    return list.map(function (o) {
      return '<option value="' + escAttr(o.v) + '"' + (o.v === val ? ' selected' : '') + '>' + esc(o.label) + '</option>';
    }).join('');
  }
  function chipBarHtml(s) {
    var statusOpts = TASK_FILTERS.map(function (f) { return { v: f.key, label: f.label }; });
    var chips = '<span class="p86-fchip"><span class="p86-fchip-k">Status</span>' +
      '<select class="p86-fchip-sel" data-fc="status">' + fbarOpts(statusOpts, s.status) + '</select></span>';
    if (s.hasAssignee) {
      var aOpts = [{ v: '', label: 'Everyone' }, { v: 'me', label: 'Me' }, { v: 'unassigned', label: 'Unassigned' }]
        .concat((s.users || []).map(function (u) { return { v: String(u.id), label: (u.name || u.email || ('User ' + u.id)) }; }));
      chips += '<span class="p86-fand">and</span>' +
        '<span class="p86-fchip"><span class="p86-fchip-k">Assignee</span>' +
        '<select class="p86-fchip-sel" data-fc="assignee">' + fbarOpts(aOpts, s.assignee) + '</select></span>';
    }
    if (s.priority) {
      var pOpts = PRIORITIES.map(function (p) { return { v: p.v, label: p.label }; });
      chips += '<span class="p86-fand">and</span>' +
        '<span class="p86-fchip"><span class="p86-fchip-k">Priority</span>' +
        '<select class="p86-fchip-sel" data-fc="priority">' + fbarOpts(pOpts, s.priority) + '</select>' +
        '<button class="p86-fchip-x" data-fc="priority-x" title="Remove filter" aria-label="Remove priority filter">×</button></span>';
    }
    var isDefault = s.status === 'open' && (!s.hasAssignee || !s.assignee) && !s.priority;
    return '<div class="p86-fbar">' + chips +
        (!s.priority ? '<button class="p86-fbar-add" data-fadd>＋ Filter</button>' : '') +
        (isDefault ? '' : '<button class="p86-fbar-clear" data-fclear>Clear all</button>') +
        '<span class="p86-fbar-spacer"></span>' +
        '<span class="p86-fbar-count" data-fcount></span>' +
      '</div>';
  }
  function wireChipBar(barHost, s, sync, remount, rerender) {
    barHost.querySelectorAll('.p86-fchip-sel').forEach(function (sel) {
      sel.addEventListener('change', function () { s[sel.getAttribute('data-fc')] = sel.value; sync(); remount(); });
    });
    var addBtn = barHost.querySelector('[data-fadd]');
    if (addBtn) addBtn.addEventListener('click', function () { s.priority = 'high'; sync(); rerender(); remount(); });
    var px = barHost.querySelector('[data-fc="priority-x"]');
    if (px) px.addEventListener('click', function () { s.priority = ''; sync(); rerender(); remount(); });
    var clr = barHost.querySelector('[data-fclear]');
    if (clr) clr.addEventListener('click', function () { s.status = 'open'; s.assignee = ''; s.priority = ''; sync(); rerender(); remount(); });
  }
  function setChipCount(barHost, n) {
    var el = barHost && barHost.querySelector('[data-fcount]');
    if (el) el.textContent = n + (n === 1 ? ' task' : ' tasks');
  }

  function renderMyTasksTab() {
    var pane = document.getElementById('my-tasks');
    if (!pane) return;
    ensureStyles();
    pane.innerHTML =
      '<div class="p86-tasks-page">' +
        '<div class="p86-tasks-head"><h2>Tasks &amp; Reminders</h2>' +
          '<div class="p86-tasks-headtools">' +
            '<button class="p86-tasks-iconbtn" id="p86TaskRefresh" type="button" title="Refresh">&#8635;</button>' +
            '<button class="p86-tasks-iconbtn" id="p86TaskDensity" type="button" title="Compact rows">&#9776;</button>' +
            '<button class="p86-tasks-newbtn" id="p86TaskNew" type="button">＋ Task</button>' +
          '</div>' +
        '</div>' +
        '<div class="p86-tabs" role="tablist">' +
          '<button class="p86-tab" data-tab="team">Team Tasks</button>' +
          '<button class="p86-tab" data-tab="todos">My To-Dos</button>' +
          '<button class="p86-tab" data-tab="reminders">Reminders</button>' +
          '<button class="p86-tab" data-tab="punch">Punch list</button>' +
        '</div>' +
        '<div id="p86TabBody"></div>' +
      '</div>';

    var newBtn = pane.querySelector('#p86TaskNew');
    if (newBtn) newBtn.addEventListener('click', function () {
      var ai = pane.querySelector('.p86-tg-addinput');
      if (ai) { ai.focus(); ai.scrollIntoView({ block: 'nearest' }); }
    });
    var refreshBtn = pane.querySelector('#p86TaskRefresh');
    if (refreshBtn) refreshBtn.addEventListener('click', function () { selectTab(_activeTab); });
    var densityBtn = pane.querySelector('#p86TaskDensity');
    if (_compact) { pane.classList.add('p86-compact'); if (densityBtn) densityBtn.classList.add('is-on'); }
    if (densityBtn) densityBtn.addEventListener('click', function () {
      _compact = !_compact;
      pane.classList.toggle('p86-compact', _compact);
      densityBtn.classList.toggle('is-on', _compact);
    });

    function selectTab(tab) {
      _activeTab = tab;
      pane.querySelectorAll('[data-tab]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      var body = pane.querySelector('#p86TabBody');
      if (tab === 'team') renderTeam(body);
      else if (tab === 'todos') renderTodos(body);
      else if (tab === 'punch') renderTeam(body, 'punch');
      else renderReminders(body);
    }
    pane.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
    });
    selectTab(_activeTab);
  }

  // ── Tab 1: Team Tasks (org-wide, assignable, user-filterable) ──────
  function renderTeam(body, kind) {
    body.innerHTML = '<div id="teamBar"></div><div id="teamList"></div>';
    var barHost = body.querySelector('#teamBar');
    var listHost = body.querySelector('#teamList');
    var s = { status: _teamFilter, assignee: _teamUser, priority: _teamPriority, hasAssignee: true, users: [] };
    function sync() { _teamFilter = s.status; _teamUser = s.assignee; _teamPriority = s.priority; }
    function mountTeam() {
      var f = (TASK_FILTERS.filter(function (x) { return x.key === s.status; })[0] || TASK_FILTERS[0]).build();
      f.scope = 'org';
      if (kind) f.kind = kind;
      if (s.assignee) f.assignee = s.assignee;
      _ctl.team = mountList(listHost, f, {
        grouped: true,
        priorityFilter: s.priority,
        emptyText: s.status === 'done' ? 'No completed items.' : (kind === 'punch' ? 'No punch-list items yet.' : 'No team tasks here.'),
        onCount: function (n) { setChipCount(barHost, n); },
        onAdd: function (title, done) {
          if (!api()) { done(false); return; }
          // Org task assigned to me by default; reassign in the detail editor.
          // On the Punch list tab, new rows are created as kind:'punch'.
          api().create({ title: title, assignee_user_id: currentUserId() || undefined, kind: kind || undefined }).then(function () {
            done(true);
            if (_ctl.team && _ctl.team.refresh) _ctl.team.refresh().then(function () {
              var ni = listHost.querySelector('.p86-tg-addinput'); if (ni) ni.focus();
            });
          }).catch(function (e) { done(false); toast((e && e.message) || 'Could not add task', 'error'); });
        }
      });
    }
    function renderBar() { barHost.innerHTML = chipBarHtml(s); wireChipBar(barHost, s, sync, mountTeam, renderBar); }
    renderBar();
    mountTeam();
    loadUsers().then(function () {
      s.users = _users || (window.appData && window.appData.users) || [];
      renderBar();   // repopulate the Assignee chip's options
    });
  }

  // ── Tab 2: My To-Dos (private personal — scope='personal') ─────────
  function renderTodos(body) {
    body.innerHTML =
      '<div id="todoBar"></div>' +
      '<div class="p86-tasks-hint">Private to you — no one else in the org sees these.</div>' +
      '<div id="todoList"></div>';
    var barHost = body.querySelector('#todoBar');
    var listHost = body.querySelector('#todoList');
    var s = { status: _todoFilter, assignee: '', priority: _todoPriority, hasAssignee: false, users: [] };
    function sync() { _todoFilter = s.status; _todoPriority = s.priority; }
    function mountTodos() {
      var f = (TASK_FILTERS.filter(function (x) { return x.key === s.status; })[0] || TASK_FILTERS[0]).build();
      f.scope = 'personal';
      _ctl.todos = mountList(listHost, f, {
        grouped: true,
        priorityFilter: s.priority,
        emptyText: s.status === 'done' ? 'Nothing completed yet.' : 'No to-dos — you\'re all caught up.',
        onCount: function (n) { setChipCount(barHost, n); },
        onAdd: function (title, done) {
          if (!api()) { done(false); return; }
          // scope:'personal' → server stamps owner = me; never assignable/visible to others.
          api().create({ title: title, scope: 'personal' }).then(function () {
            done(true);
            if (_ctl.todos && _ctl.todos.refresh) _ctl.todos.refresh().then(function () {
              var ni = listHost.querySelector('.p86-tg-addinput'); if (ni) ni.focus();
            });
          }).catch(function (e) { done(false); toast((e && e.message) || 'Could not add to-do', 'error'); });
        }
      });
    }
    function renderBar() { barHost.innerHTML = chipBarHtml(s); wireChipBar(barHost, s, sync, mountTodos, renderBar); }
    renderBar();
    mountTodos();
  }

  // ── Tab 3: Reminders (timed nudges on their own list) ──────────────
  function remApi() { return window.p86Api && window.p86Api.reminders; }
  function remWhen(ts) {
    if (!ts) return '';
    var d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    var opts = { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    try { return d.toLocaleString(undefined, opts); } catch (e) { return String(ts); }
  }
  // datetime-local value (local wall-clock, no offset) for the picker default.
  function isoLocalInput(d) {
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
      'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }

  function renderReminders(body) {
    body.innerHTML =
      '<div class="p86-rem-quickbar">' +
        '<input id="remTitle" type="text" placeholder="Remind me to…" />' +
        '<input id="remWhen" type="datetime-local" />' +
        '<button class="primary" id="remAddBtn">Set</button>' +
      '</div>' +
      '<div class="p86-tasks-filters">' +
        '<button class="p86-tasks-filter' + (_remStatus === 'pending' ? ' active' : '') + '" data-rs="pending">Pending</button>' +
        '<button class="p86-tasks-filter' + (_remStatus === 'all' ? ' active' : '') + '" data-rs="all">All</button>' +
      '</div>' +
      '<div id="remList"></div>';

    var ctl = mountReminders(body.querySelector('#remList'));
    _ctl.reminders = ctl;

    body.querySelectorAll('[data-rs]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _remStatus = btn.getAttribute('data-rs');
        body.querySelectorAll('[data-rs]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        ctl.refresh();
      });
    });

    var t = body.querySelector('#remTitle');
    var w = body.querySelector('#remWhen');
    var b = body.querySelector('#remAddBtn');
    // Default the picker to the next round hour.
    (function () { var d = new Date(); d.setHours(d.getHours() + 1, 0, 0, 0); w.value = isoLocalInput(d); })();
    function add() {
      var title = (t.value || '').trim();
      var when = w.value;
      if (!title) { toast('Give the reminder a title', 'error'); return; }
      if (!when) { toast('Pick a date & time', 'error'); return; }
      if (!remApi()) return;
      b.disabled = true;
      // new Date(local-string) is interpreted in the browser's zone; toISOString
      // stamps the correct UTC instant for the server.
      var iso = new Date(when).toISOString();
      remApi().create({ title: title, remind_at: iso }).then(function () {
        t.value = ''; b.disabled = false; t.focus();
        ctl.refresh();
      }).catch(function (e) { b.disabled = false; toast((e && e.message) || 'Could not set reminder', 'error'); });
    }
    t.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    b.addEventListener('click', add);
  }

  function mountReminders(host) {
    if (!host) return { refresh: function () {} };
    function paint(rems) {
      if (!rems || !rems.length) {
        host.innerHTML = '<div class="p86-task-empty">' +
          (_remStatus === 'pending' ? 'No pending reminders.' : 'No reminders yet.') + '</div>';
        return;
      }
      host.innerHTML = '<div class="p86-task-list">' + rems.map(remRow).join('') + '</div>';
      wire(rems);
    }
    function remRow(r) {
      var done = r.status === 'done' || r.status === 'dismissed';
      var meta = ['<span class="p86-rem-when">' + esc(remWhen(r.remind_at)) + '</span>'];
      if (r.source && r.source !== 'user') meta.push('<span class="p86-task-link">' + esc(r.source) + '</span>');
      if (r.status && r.status !== 'pending') meta.push('<span>' + esc(r.status) + '</span>');
      return '<div class="p86-task-item' + (done ? ' is-done' : '') + '" data-rem-id="' + escAttr(r.id) + '">' +
        '<button class="p86-task-check' + (done ? ' done' : '') + '" data-rdone title="' + (done ? 'Reopen' : 'Mark done') + '"></button>' +
        '<span class="p86-task-pdot" style="background:#a855f7;" title="Reminder"></span>' +
        '<div class="p86-task-main">' +
          '<div class="p86-task-title">' + esc(r.title || '(untitled)') + '</div>' +
          '<div class="p86-task-meta">' + meta.join('') + '</div>' +
          (r.notes ? '<div class="p86-rem-notes">' + esc(r.notes) + '</div>' : '') +
        '</div>' +
        '<button class="p86-rem-del" data-rdel title="Delete">&times;</button>' +
      '</div>';
    }
    function wire(rems) {
      var byId = {}; rems.forEach(function (r) { byId[r.id] = r; });
      host.querySelectorAll('.p86-task-item').forEach(function (row) {
        var id = row.getAttribute('data-rem-id');
        var doneBtn = row.querySelector('[data-rdone]');
        var delBtn = row.querySelector('[data-rdel]');
        if (doneBtn) doneBtn.addEventListener('click', function () {
          var r = byId[id];
          var next = (r && (r.status === 'done' || r.status === 'dismissed')) ? 'pending' : 'done';
          doneBtn.disabled = true;
          remApi().update(id, { status: next }).then(refresh).catch(function (e) {
            doneBtn.disabled = false; toast((e && e.message) || 'Could not update', 'error');
          });
        });
        if (delBtn) delBtn.addEventListener('click', function () {
          delBtn.disabled = true;
          remApi().remove(id).then(refresh).catch(function (e) {
            delBtn.disabled = false; toast((e && e.message) || 'Could not delete', 'error');
          });
        });
      });
    }
    function refresh() {
      if (!remApi()) { host.innerHTML = '<div class="p86-task-empty">Not connected.</div>'; return Promise.resolve(); }
      host.innerHTML = '<div class="p86-task-empty">Loading…</div>';
      return remApi().list(_remStatus === 'all' ? { status: 'all' } : {}).then(function (res) {
        paint((res && res.reminders) || []);
      }).catch(function (e) {
        host.innerHTML = '<div class="p86-task-empty">' + esc((e && e.message) || 'Could not load reminders.') + '</div>';
      });
    }
    refresh();
    return { refresh: refresh };
  }

  // ── every live task surface, not just the My Tasks page ─────────────
  // The old refreshOpenSurfaces returned immediately unless #my-tasks was the
  // active pane, so editing, deleting or ticking a punch-list item from the
  // task modal left the embedded panel on the job / lead / client / estimate /
  // project page behind it showing the old title, status and progress. The
  // row's own done-toggle self-refreshed, so one control on a row updated live
  // and the modal one row over did not.
  var _surfaces = [];
  function registerTaskSurface(host, ctl) {
    _surfaces = _surfaces.filter(function (s) {
      return s.host !== host && s.host && document.body.contains(s.host);
    });
    _surfaces.push({ host: host, ctl: ctl });
  }

  // Coalesced: a punch-list tick fires this on EVERY checkbox change, and each
  // refresh blanks the panel to "Loading…" before re-listing. Without the
  // window, ticking through a list would blank-and-repaint once per keystroke.
  var _refreshTimer = null;
  function refreshOpenSurfaces() {
    if (_refreshTimer) return;
    _refreshTimer = setTimeout(function () {
      _refreshTimer = null;
      var pane = document.getElementById('my-tasks');
      if (pane && pane.classList.contains('active')) {
        var ctl = _ctl[_activeTab];
        if (ctl && ctl.refresh) { try { ctl.refresh(); } catch (e) {} }
      }
      _surfaces = _surfaces.filter(function (s) { return s.host && document.body.contains(s.host); });
      _surfaces.forEach(function (s) {
        try { if (s.ctl && s.ctl.refresh) s.ctl.refresh(); } catch (e) {}
      });
    }, 250);
  }

  // ── Exports ────────────────────────────────────────────────────────
  window.p86Tasks = {
    openQuickAdd: openQuickAdd,
    openDetail: openDetail,
    mountList: mountList,
    mountEntityPanel: mountEntityPanel,
    renderMyTasksTab: renderMyTasksTab,
    // The refresh registry's task/todo/reminder/calendar surface. Repaints the
    // My Tasks page AND every mounted entity panel, coalesced.
    refresh: refreshOpenSurfaces,
    _loadUsers: loadUsers
  };
  // Convenience global for the page-switch dispatcher.
  window.renderMyTasksTab = renderMyTasksTab;
})();
