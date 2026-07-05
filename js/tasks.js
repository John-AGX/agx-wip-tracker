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
      '.p86-task-list{display:flex;flex-direction:column;gap:2px;}' +
      '.p86-task-item{display:flex;align-items:flex-start;gap:10px;padding:9px 8px;border-radius:8px;border:1px solid transparent;cursor:default;}' +
      '.p86-task-item:hover{background:var(--hover,#f8fafc);}' +
      '.p86-task-check{flex:0 0 auto;width:20px;height:20px;margin-top:1px;border-radius:999px;border:1.6px solid var(--border-strong,#cbd5e1);background:transparent;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;padding:0;color:#fff;transition:background .12s;}' +
      '.p86-task-check.done{background:#16a34a;border-color:#16a34a;}' +
      '.p86-task-check.done::after{content:"";width:5px;height:9px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg);margin-top:-2px;}' +
      '.p86-task-pdot{flex:0 0 auto;width:7px;height:7px;border-radius:999px;margin-top:7px;}' +
      '.p86-task-main{flex:1 1 auto;min-width:0;}' +
      '.p86-task-title{font-size:14px;line-height:1.35;word-break:break-word;cursor:pointer;}' +
      '.p86-task-item.is-done .p86-task-title{text-decoration:line-through;color:var(--muted,#9ca3af);}' +
      '.p86-task-meta{display:flex;flex-wrap:wrap;gap:8px;align-items:center;margin-top:3px;font-size:11.5px;color:var(--muted,#71717a);}' +
      '.p86-task-due{padding:1px 7px;border-radius:999px;background:var(--chip-bg,#f1f5f9);}' +
      '.p86-task-due.today{background:#fef3c7;color:#92400e;}' +
      '.p86-task-due.overdue{background:#fee2e2;color:#b91c1c;font-weight:600;}' +
      '.p86-task-avatar{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;background:#e0e7ff;color:#3730a3;font-size:9px;font-weight:700;}' +
      '.p86-task-link{padding:1px 7px;border-radius:999px;background:var(--chip-bg,#eef2ff);color:#4338ca;}' +
      '.p86-task-empty{padding:24px 8px;text-align:center;color:var(--muted,#9ca3af);font-size:13px;}' +
      // My Tasks page
      '.p86-tasks-page{padding:20px 16px;max-width:860px;margin:0 auto;}' +
      '.p86-tasks-head{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:14px;flex-wrap:wrap;}' +
      '.p86-tasks-head h2{margin:0;font-size:20px;}' +
      '.p86-tasks-quickbar{display:flex;gap:8px;margin-bottom:12px;}' +
      '.p86-tasks-quickbar input{flex:1 1 auto;font:inherit;padding:9px 12px;border:1px solid var(--border,#d4d4d8);border-radius:10px;background:var(--surface,#fff);color:inherit;}' +
      '.p86-tasks-filters{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px;}' +
      '.p86-tasks-filter{font:inherit;font-size:12.5px;padding:5px 11px;border-radius:999px;border:1px solid var(--border,#e5e7eb);background:var(--surface,#fff);color:var(--muted,#475569);cursor:pointer;}' +
      '.p86-tasks-filter.active{background:#111827;color:#fff;border-color:#111827;}' +
      // 3-tier tabs + per-tab toolbar
      '.p86-tabs{display:flex;gap:4px;border-bottom:1px solid var(--border,#e5e7eb);margin-bottom:14px;}' +
      '.p86-tab{font:inherit;font-size:13.5px;font-weight:600;padding:8px 14px;border:none;background:transparent;color:var(--muted,#64748b);cursor:pointer;border-bottom:2px solid transparent;margin-bottom:-1px;}' +
      '.p86-tab.active{color:var(--accent,#111827);border-bottom-color:var(--accent,#111827);}' +
      '.p86-tasks-toolbar{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:8px;}' +
      '.p86-tasks-userfilter{display:flex;align-items:center;gap:6px;font-size:12px;color:var(--muted,#64748b);}' +
      '.p86-tasks-userfilter select{font:inherit;padding:5px 8px;border:1px solid var(--border,#e5e7eb);border-radius:8px;background:var(--surface,#fff);color:inherit;}' +
      '.p86-tasks-hint{font-size:12px;color:var(--muted,#9ca3af);margin:2px 0 8px;}' +
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
      '.p86-appt-row:hover{background:var(--hover,#f8fafc);}' +
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
    if (type === 'job') { var n = it.jobNumber ? '[' + it.jobNumber + '] ' : ''; return n + (it.title || it.name || 'Job'); }
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
              ? '<div style="margin-bottom:10px;"><span class="p86-task-linkchip">Linked: ' + esc(linkLabel || (prefill.entity_type + ' ' + prefill.entity_id)) + '</span></div>'
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
    var html =
      '<div class="modal-content">' +
        '<div class="modal-header"><span>Edit task</span>' +
          '<button class="p86-modal-close" data-close>&times;</button></div>' +
        '<div style="padding:16px;max-height:70vh;overflow:auto;">' +
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
          (task.entity_type ? '<div style="margin-top:10px;"><span class="p86-task-linkchip">Linked: ' + esc(task.linked_label || (task.entity_type + ' ' + task.entity_id)) + '</span></div>' : '') +
          // Location pin — geotag from the device, or type/clear coords manually.
          '<div class="p86-field" style="margin-top:12px;"><span>Location pin</span>' +
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
        '<div class="modal-footer" style="justify-content:space-between;">' +
          '<button class="ee-btn secondary" id="tdDelete" style="color:#b91c1c;">Delete</button>' +
          '<span><button class="ee-btn secondary" data-close>Cancel</button> ' +
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
    function loadTaskPhotos() {
      var host = h.modal.querySelector('#tdPhotos'); if (!host) return;
      if (!window.p86Api || !p86Api.attachments) { host.innerHTML = ''; return; }
      p86Api.attachments.list('task', task.id).then(function (resp) {
        var atts = (resp && resp.attachments) || [];
        if (!atts.length) { host.innerHTML = '<span style="font-size:12px;color:var(--text-dim,#888);">No photos yet.</span>'; return; }
        host.innerHTML = atts.map(function (a) {
          var u = a.thumb_url || a.web_url || '';
          return '<a href="' + escAttr(a.web_url || u) + '" target="_blank" rel="noopener" title="' + escAttr(a.filename || '') + '" ' +
            'style="display:block;width:54px;height:54px;border-radius:6px;overflow:hidden;border:1px solid var(--border,#333);background:#0f1420;">' +
            (u ? '<img src="' + escAttr(u) + '" alt="" style="width:100%;height:100%;object-fit:cover;" />' : '') + '</a>';
        }).join('');
      }).catch(function () { host.innerHTML = ''; });
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
      if (!window.confirm('Delete this task? It will be archived.')) return;
      api().remove(task.id).then(function () {
        toast('Task deleted', 'success');
        h.close();
        refreshOpenSurfaces();
      }).catch(function (e) { toast((e && e.message) || 'Could not delete', 'error'); });
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

    function paint(tasks) {
      if (!tasks || !tasks.length) {
        container.innerHTML = '<div class="p86-task-empty">' + esc(opts.emptyText || 'No tasks here.') + '</div>';
        return;
      }
      container.innerHTML = '<div class="p86-task-list">' + tasks.map(rowHTML).join('') + '</div>';
      wireRows(container, tasks);
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

    function wireRows(root, tasks) {
      var byId = {};
      tasks.forEach(function (t) { byId[t.id] = t; });
      root.querySelectorAll('.p86-task-item').forEach(function (row) {
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

    return { refresh: function () { mounted.refresh(); appts.refresh(); } };
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
  var _todoFilter = 'open';
  var _remStatus = 'pending';  // pending | all
  var _ctl = { team: null, todos: null, reminders: null };

  function filterBtns(filters, activeKey, dataAttr) {
    return filters.map(function (f) {
      return '<button class="p86-tasks-filter' + (f.key === activeKey ? ' active' : '') +
        '" ' + dataAttr + '="' + f.key + '">' + esc(f.label) + '</button>';
    }).join('');
  }

  function renderMyTasksTab() {
    var pane = document.getElementById('my-tasks');
    if (!pane) return;
    ensureStyles();
    pane.innerHTML =
      '<div class="p86-tasks-page">' +
        '<div class="p86-tasks-head"><h2>Tasks &amp; Reminders</h2></div>' +
        '<div class="p86-tabs" role="tablist">' +
          '<button class="p86-tab" data-tab="team">Team Tasks</button>' +
          '<button class="p86-tab" data-tab="todos">My To-Dos</button>' +
          '<button class="p86-tab" data-tab="reminders">Reminders</button>' +
        '</div>' +
        '<div id="p86TabBody"></div>' +
      '</div>';

    function selectTab(tab) {
      _activeTab = tab;
      pane.querySelectorAll('[data-tab]').forEach(function (b) {
        b.classList.toggle('active', b.getAttribute('data-tab') === tab);
      });
      var body = pane.querySelector('#p86TabBody');
      if (tab === 'team') renderTeam(body);
      else if (tab === 'todos') renderTodos(body);
      else renderReminders(body);
    }
    pane.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { selectTab(b.getAttribute('data-tab')); });
    });
    selectTab(_activeTab);
  }

  // ── Tab 1: Team Tasks (org-wide, assignable, user-filterable) ──────
  function renderTeam(body) {
    body.innerHTML =
      '<div class="p86-tasks-quickbar">' +
        '<input id="teamQuick" type="text" placeholder="Add a team task and press Enter…" />' +
        '<button class="primary" id="teamQuickBtn">Add</button>' +
      '</div>' +
      '<div class="p86-tasks-toolbar">' +
        '<div class="p86-tasks-filters">' + filterBtns(TASK_FILTERS, _teamFilter, 'data-tf') + '</div>' +
        '<label class="p86-tasks-userfilter">Who <select id="teamUser"></select></label>' +
      '</div>' +
      '<div id="teamList"></div>';

    var sel = body.querySelector('#teamUser');
    function buildUserOptions() {
      var list = _users || (window.appData && window.appData.users) || [];
      var o = ['<option value="">Everyone</option>',
        '<option value="me">Assigned to me</option>',
        '<option value="unassigned">Unassigned</option>'];
      list.forEach(function (u) {
        o.push('<option value="' + escAttr(u.id) + '">' + esc(u.name || u.email || ('User ' + u.id)) + '</option>');
      });
      sel.innerHTML = o.join('');
      sel.value = _teamUser;
    }
    function mountTeam() {
      var f = (TASK_FILTERS.filter(function (x) { return x.key === _teamFilter; })[0] || TASK_FILTERS[0]).build();
      f.scope = 'org';
      if (_teamUser) f.assignee = _teamUser;
      _ctl.team = mountList(body.querySelector('#teamList'), f, {
        emptyText: _teamFilter === 'done' ? 'No completed team tasks.' : 'No team tasks here.'
      });
    }
    loadUsers().then(buildUserOptions);
    mountTeam();

    body.querySelectorAll('[data-tf]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _teamFilter = btn.getAttribute('data-tf');
        body.querySelectorAll('[data-tf]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        mountTeam();
      });
    });
    sel.addEventListener('change', function () { _teamUser = sel.value; mountTeam(); });

    var quick = body.querySelector('#teamQuick');
    var qbtn = body.querySelector('#teamQuickBtn');
    function add() {
      var title = (quick.value || '').trim();
      if (!title || !api()) return;
      qbtn.disabled = true;
      // Org task assigned to me by default; reassign in the detail editor.
      api().create({ title: title, assignee_user_id: currentUserId() || undefined }).then(function () {
        quick.value = ''; qbtn.disabled = false; quick.focus();
        if (_ctl.team) _ctl.team.refresh();
      }).catch(function (e) { qbtn.disabled = false; toast((e && e.message) || 'Could not add task', 'error'); });
    }
    quick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    qbtn.addEventListener('click', add);
  }

  // ── Tab 2: My To-Dos (private personal — scope='personal') ─────────
  function renderTodos(body) {
    body.innerHTML =
      '<div class="p86-tasks-quickbar">' +
        '<input id="todoQuick" type="text" placeholder="Add a private to-do and press Enter…" />' +
        '<button class="primary" id="todoQuickBtn">Add</button>' +
      '</div>' +
      '<div class="p86-tasks-filters">' + filterBtns(TASK_FILTERS, _todoFilter, 'data-df') + '</div>' +
      '<div class="p86-tasks-hint">Private to you — no one else in the org sees these.</div>' +
      '<div id="todoList"></div>';

    function mountTodos() {
      var f = (TASK_FILTERS.filter(function (x) { return x.key === _todoFilter; })[0] || TASK_FILTERS[0]).build();
      f.scope = 'personal';
      _ctl.todos = mountList(body.querySelector('#todoList'), f, {
        emptyText: _todoFilter === 'done' ? 'Nothing completed yet.' : 'No to-dos — you\'re all caught up.'
      });
    }
    mountTodos();
    body.querySelectorAll('[data-df]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _todoFilter = btn.getAttribute('data-df');
        body.querySelectorAll('[data-df]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        mountTodos();
      });
    });
    var quick = body.querySelector('#todoQuick');
    var qbtn = body.querySelector('#todoQuickBtn');
    function add() {
      var title = (quick.value || '').trim();
      if (!title || !api()) return;
      qbtn.disabled = true;
      // scope:'personal' → server stamps owner = me; never assignable/visible to others.
      api().create({ title: title, scope: 'personal' }).then(function () {
        quick.value = ''; qbtn.disabled = false; quick.focus();
        if (_ctl.todos) _ctl.todos.refresh();
      }).catch(function (e) { qbtn.disabled = false; toast((e && e.message) || 'Could not add to-do', 'error'); });
    }
    quick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); add(); } });
    qbtn.addEventListener('click', add);
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

  // Refresh whatever surface is visible on the active tab after a mutation.
  function refreshOpenSurfaces() {
    var pane = document.getElementById('my-tasks');
    if (!pane || !pane.classList.contains('active')) return;
    var ctl = _ctl[_activeTab];
    if (ctl && ctl.refresh) ctl.refresh();
  }

  // ── Exports ────────────────────────────────────────────────────────
  window.p86Tasks = {
    openQuickAdd: openQuickAdd,
    openDetail: openDetail,
    mountList: mountList,
    mountEntityPanel: mountEntityPanel,
    renderMyTasksTab: renderMyTasksTab,
    _loadUsers: loadUsers
  };
  // Convenience global for the page-switch dispatcher.
  window.renderMyTasksTab = renderMyTasksTab;
})();
