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
      '.p86-task-checklist{margin-top:6px;display:flex;flex-direction:column;gap:5px;}' +
      '.p86-task-clrow{display:flex;align-items:center;gap:8px;}' +
      '.p86-task-clrow input[type=text]{flex:1 1 auto;}' +
      '.p86-task-clrow button.rm{border:none;background:transparent;color:#b91c1c;cursor:pointer;font-size:16px;line-height:1;}' +
      '.p86-task-panel{border:1px solid var(--border,#e5e7eb);border-radius:12px;padding:12px;margin-top:12px;}' +
      '.p86-task-panel-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;}' +
      '.p86-task-panel-head h4{margin:0;font-size:14px;}';
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
  function openQuickAdd(prefill, opts) {
    prefill = prefill || {};
    opts = opts || {};
    if (!api()) { toast('Not connected', 'error'); return; }
    ensureStyles();

    var linkLabel = prefill.entity_label || '';
    var hasLink = !!(prefill.entity_type && prefill.entity_id);
    var defAssignee = (prefill.assignee_user_id != null) ? prefill.assignee_user_id : currentUserId();

    loadUsers().then(function () {
      var html =
        '<div class="modal-content">' +
          '<div class="modal-header"><span>New to-do</span>' +
            '<button class="p86-modal-close" data-close>&times;</button></div>' +
          '<div style="padding:16px;">' +
            (hasLink
              ? '<div style="margin-bottom:10px;"><span class="p86-task-linkchip">Linked: ' + esc(linkLabel || (prefill.entity_type + ' ' + prefill.entity_id)) + '</span></div>'
              : '') +
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
            '<button class="primary" id="qaSave">Add task</button>' +
          '</div>' +
        '</div>';

      var h = buildModal('p86QuickAddModal', html);
      var titleEl = h.modal.querySelector('#qaTitle');
      if (titleEl) { titleEl.focus(); }

      function submit() {
        var title = (titleEl.value || '').trim();
        if (!title) { titleEl.focus(); return; }
        var payload = {
          title: title,
          kind: prefill.kind || 'todo',
          priority: h.modal.querySelector('#qaPriority').value || 'normal'
        };
        var due = h.modal.querySelector('#qaDue').value;
        if (due) payload.due_date = due;
        var asg = h.modal.querySelector('#qaAssignee').value;
        if (asg) payload.assignee_user_id = Number(asg);
        if (hasLink) { payload.entity_type = prefill.entity_type; payload.entity_id = String(prefill.entity_id); }

        var btn = h.modal.querySelector('#qaSave');
        btn.disabled = true; btn.textContent = 'Adding…';
        api().create(payload).then(function (res) {
          toast('Task added', 'success');
          h.close();
          if (typeof opts.onCreated === 'function') opts.onCreated(res && res.task);
          else refreshOpenSurfaces();
        }).catch(function (e) {
          btn.disabled = false; btn.textContent = 'Add task';
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

    h.modal.querySelector('#tdSave').addEventListener('click', function () {
      var title = (h.modal.querySelector('#tdTitle').value || '').trim();
      if (!title) { h.modal.querySelector('#tdTitle').focus(); return; }
      var asg = h.modal.querySelector('#tdAssignee').value;
      var payload = {
        title: title,
        notes: h.modal.querySelector('#tdNotes').value || '',
        status: h.modal.querySelector('#tdStatus').value,
        priority: h.modal.querySelector('#tdPriority').value,
        kind: h.modal.querySelector('#tdKind').value,
        due_date: h.modal.querySelector('#tdDue').value || null,
        assignee_user_id: asg ? Number(asg) : null,
        checklist: clState.filter(function (c) { return (c.text || '').trim(); })
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

  // ── Entity-page panel (Tasks panel embedded on a detail page) ──────
  // Renders a titled panel with a "+ Add" button (link prefilled) and a
  // list scoped to that entity. Returns { refresh }.
  function mountEntityPanel(container, entityType, entityId, entityLabel) {
    if (!container) return { refresh: function () {} };
    ensureStyles();
    container.innerHTML =
      '<div class="p86-task-panel">' +
        '<div class="p86-task-panel-head"><h4>Tasks</h4>' +
          '<button type="button" class="ee-btn secondary" data-add-task>+ Add</button></div>' +
        '<div data-task-list></div>' +
      '</div>';
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
    return mounted;
  }

  // ── My Tasks page ──────────────────────────────────────────────────
  var FILTERS = [
    { key: 'open',     label: 'All open',  build: function () { return { assignee: 'me', exclude_done: 1 }; } },
    { key: 'today',    label: 'Today',     build: function () { return { assignee: 'me', exclude_done: 1, due_before: todayISO() }; } },
    { key: 'upcoming', label: 'Upcoming',  build: function () { return { assignee: 'me', exclude_done: 1, due_after: shiftISO(1) }; } },
    { key: 'overdue',  label: 'Overdue',   build: function () { return { assignee: 'me', exclude_done: 1, due_before: shiftISO(-1) }; } },
    { key: 'done',     label: 'Done',      build: function () { return { assignee: 'me', status: 'done', limit: 100 }; } }
  ];
  var _activeFilter = 'open';
  var _myListCtl = null;

  function renderMyTasksTab() {
    var pane = document.getElementById('my-tasks');
    if (!pane) return;
    ensureStyles();
    pane.innerHTML =
      '<div class="p86-tasks-page">' +
        '<div class="p86-tasks-head"><h2>My Tasks</h2></div>' +
        '<div class="p86-tasks-quickbar">' +
          '<input id="myTaskQuick" type="text" placeholder="Add a task and press Enter…" />' +
          '<button class="primary" id="myTaskQuickBtn">Add</button>' +
        '</div>' +
        '<div class="p86-tasks-filters">' +
          FILTERS.map(function (f) {
            return '<button class="p86-tasks-filter' + (f.key === _activeFilter ? ' active' : '') + '" data-filter="' + f.key + '">' + esc(f.label) + '</button>';
          }).join('') +
        '</div>' +
        '<div id="myTaskList"></div>' +
      '</div>';

    var listHost = pane.querySelector('#myTaskList');
    function mountActive() {
      var f = FILTERS.filter(function (x) { return x.key === _activeFilter; })[0] || FILTERS[0];
      _myListCtl = mountList(listHost, f.build(), {
        emptyText: _activeFilter === 'done' ? 'Nothing completed yet.' : 'All clear — no tasks here.'
      });
    }
    mountActive();

    pane.querySelectorAll('[data-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        _activeFilter = btn.getAttribute('data-filter');
        pane.querySelectorAll('[data-filter]').forEach(function (b) { b.classList.toggle('active', b === btn); });
        mountActive();
      });
    });

    // Inline quick capture: Enter (or Add) creates an open todo for me.
    var quick = pane.querySelector('#myTaskQuick');
    function quickAdd() {
      var title = (quick.value || '').trim();
      if (!title || !api()) return;
      var btn = pane.querySelector('#myTaskQuickBtn');
      btn.disabled = true;
      var payload = { title: title, assignee_user_id: currentUserId() || undefined };
      api().create(payload).then(function () {
        quick.value = '';
        btn.disabled = false;
        quick.focus();
        if (_myListCtl) _myListCtl.refresh();
      }).catch(function (e) {
        btn.disabled = false;
        toast((e && e.message) || 'Could not add task', 'error');
      });
    }
    quick.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); quickAdd(); } });
    pane.querySelector('#myTaskQuickBtn').addEventListener('click', quickAdd);
  }

  // Refresh whatever task surfaces happen to be visible after a mutation.
  function refreshOpenSurfaces() {
    var pane = document.getElementById('my-tasks');
    if (pane && pane.classList.contains('active') && _myListCtl) {
      _myListCtl.refresh();
    }
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
