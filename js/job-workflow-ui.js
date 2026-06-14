// Wave 3 — RFI / submittal / transmittal UI for the job detail.
//
// Renders into #job-workflow-content. The shipped backend lives at:
//   GET    /api/jobs/:jobId/workflow-items?type=rfi&status=open
//   POST   /api/jobs/:jobId/workflow-items
//   GET    /api/workflow-items/:id
//   PUT    /api/workflow-items/:id
//   POST   /api/workflow-items/:id/archive
//
// Shape: type strip (RFI / Submittal / Transmittal — sticky) → status
// filter pill bar → item list. Click a row to expand into edit panel
// in-place. "+ New" button per type opens a create modal.
//
// Design intent: this is a working scaffold, not a polished editor.
// Polish comes after the workflow is actually used in the field.
//
// Surface:
//   window.p86JobWorkflowUI.mount(jobId)  — paint the workflow pane
//                                            for the given job. Caller
//                                            (jobs.js sub-tab dispatch)
//                                            calls this on tab activation.

(function() {
  'use strict';

  var STATE = {
    jobId: null,
    activeType: 'rfi',
    items: [],
    expandedId: null,
    focusId: null
  };

  // Cross-job deep-link focus. The Jobs-hub RFI/Submittal/Transmittal
  // lists call setFocus({jobId,type,itemId}) immediately before navigating
  // to the parent job, so clicking a specific submittal opens the
  // Submittals tab with that item expanded — instead of landing on the
  // default (empty) RFI tab. Consumed once by the next matching mount().
  var PENDING_FOCUS = null;

  var TYPE_LABELS = {
    rfi:         { plural: 'RFIs', singular: 'RFI', icon: '❓' },
    submittal:   { plural: 'Submittals', singular: 'Submittal', icon: '📋' },
    transmittal: { plural: 'Transmittals', singular: 'Transmittal', icon: '📤' }
  };

  // Color-coded badges per status. Open states amber, closed/done states
  // green, rejected/revise states red.
  var STATUS_STYLE = {
    open:             { bg: 'rgba(251,191,36,0.18)', fg: '#fbbf24', label: 'Open' },
    answered:         { bg: 'rgba(34,211,238,0.18)', fg: '#22d3ee', label: 'Answered' },
    closed:           { bg: 'rgba(52,211,153,0.18)', fg: '#34d399', label: 'Closed' },
    submitted:        { bg: 'rgba(251,191,36,0.18)', fg: '#fbbf24', label: 'Submitted' },
    approved:         { bg: 'rgba(52,211,153,0.18)', fg: '#34d399', label: 'Approved' },
    revise_resubmit:  { bg: 'rgba(248,113,113,0.18)', fg: '#f87171', label: 'Revise & Resubmit' },
    rejected:         { bg: 'rgba(248,113,113,0.18)', fg: '#f87171', label: 'Rejected' },
    pending:          { bg: 'rgba(251,191,36,0.18)', fg: '#fbbf24', label: 'Pending' },
    sent:             { bg: 'rgba(34,211,238,0.18)', fg: '#22d3ee', label: 'Sent' },
    received:         { bg: 'rgba(52,211,153,0.18)', fg: '#34d399', label: 'Received' }
  };

  // Type-specific status options for the create/edit form.
  var STATUS_OPTIONS = {
    rfi:         ['open', 'answered', 'closed'],
    submittal:   ['submitted', 'approved', 'revise_resubmit', 'rejected', 'closed'],
    transmittal: ['pending', 'sent', 'received']
  };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  }
  function isOverdue(due, status) {
    if (!due) return false;
    if (status === 'closed' || status === 'approved' || status === 'received') return false;
    return new Date(due) < new Date(new Date().toDateString());
  }

  function mount(jobId) {
    STATE.jobId = jobId;
    // Apply a pending cross-job focus (set by the Jobs-hub list right
    // before navigating here) so we open the requested type + item.
    if (PENDING_FOCUS && String(PENDING_FOCUS.jobId) === String(jobId)) {
      if (PENDING_FOCUS.type && TYPE_LABELS[PENDING_FOCUS.type]) STATE.activeType = PENDING_FOCUS.type;
      STATE.focusId = PENDING_FOCUS.itemId != null ? PENDING_FOCUS.itemId : null;
    }
    PENDING_FOCUS = null;
    var host = document.getElementById('job-workflow-content');
    if (!host) return;
    host.innerHTML = '<div style="padding:24px;color:var(--text-dim,#888);">Loading workflow…</div>';
    loadItems();
  }

  // Stash a target the next matching mount() should open. Called by the
  // Jobs-hub RFI/Submittal/Transmittal lists. itemId is optional (just
  // switches the type when omitted).
  function setFocus(focus) {
    PENDING_FOCUS = (focus && focus.jobId) ? focus : null;
  }

  function loadItems() {
    if (!STATE.jobId) return;
    window.p86Api.get('/api/jobs/' + encodeURIComponent(STATE.jobId) + '/workflow-items?type=' + STATE.activeType)
      .then(function(resp) {
        STATE.items = (resp && resp.items) || [];
        // Resolve a pending cross-job focus to the actual loaded item so
        // the row auto-expands (uses the raw id so the === comparison in
        // paint() holds regardless of number/string typing).
        if (STATE.focusId != null) {
          var match = STATE.items.filter(function(it) { return String(it.id) === String(STATE.focusId); })[0];
          STATE.expandedId = match ? match.id : null;
          STATE.focusId = null;
        }
        paint();
      })
      .catch(function(err) {
        var host = document.getElementById('job-workflow-content');
        if (host) host.innerHTML = '<div style="padding:24px;color:#f87171;">Failed to load: ' + esc(err && err.message || err) + '</div>';
      });
  }

  function paint() {
    var host = document.getElementById('job-workflow-content');
    if (!host) return;

    var html = '';

    // Type strip — RFI / Submittal / Transmittal pills at the top.
    html += '<div style="display:flex;align-items:center;gap:8px;padding:8px 0 14px;flex-wrap:wrap;">';
    Object.keys(TYPE_LABELS).forEach(function(t) {
      var meta = TYPE_LABELS[t];
      var active = STATE.activeType === t;
      html += '<button data-workflow-type="' + t + '" style="' +
        'background:' + (active ? '#4f8cff' : 'transparent') + ';' +
        'color:' + (active ? '#fff' : 'var(--text-dim,#aaa)') + ';' +
        'border:1px solid ' + (active ? '#4f8cff' : 'var(--border,#2e3346)') + ';' +
        'padding:7px 16px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;">' +
        meta.icon + ' ' + esc(meta.plural) +
        '</button>';
    });
    html += '<button data-workflow-new style="margin-left:auto;background:#34d399;color:#0f0f1e;border:none;padding:8px 16px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">+ New ' + esc(TYPE_LABELS[STATE.activeType].singular) + '</button>';
    html += '</div>';

    // Item list.
    if (!STATE.items.length) {
      html += '<div style="padding:32px;text-align:center;color:var(--text-dim,#888);background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:8px;">';
      html += '<div style="font-size:32px;margin-bottom:8px;">' + TYPE_LABELS[STATE.activeType].icon + '</div>';
      html += '<div style="font-size:13px;font-weight:600;margin-bottom:4px;">No ' + esc(TYPE_LABELS[STATE.activeType].plural) + ' yet</div>';
      html += '<div style="font-size:11px;">Click + New ' + esc(TYPE_LABELS[STATE.activeType].singular) + ' to create the first one.</div>';
      html += '</div>';
    } else {
      html += '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:8px;overflow:hidden;">';
      STATE.items.forEach(function(item, i) {
        var ss = STATUS_STYLE[item.status] || { bg: 'rgba(106,112,144,0.2)', fg: '#6a7090', label: item.status };
        var overdue = isOverdue(item.due_date, item.status);
        // Row grid: desktop 4-col (number · subject · due · status).
        // Phone (<640px) reflows via the .wf-row-grid class so the
        // subject + meta stay readable instead of truncating.
        html += '<div data-workflow-row="' + esc(item.id) + '" class="wf-row" style="' +
          'padding:12px 14px;' +
          'border-bottom:' + (i < STATE.items.length - 1 ? '1px solid var(--ng-border2,#2e3346)' : '0') + ';' +
          'cursor:pointer;' +
          (STATE.expandedId === item.id ? 'background:rgba(79,140,255,0.06);' : '') + '">';
        html += '<div class="wf-row-grid" style="display:grid;grid-template-columns:60px 1fr 130px 110px;gap:12px;align-items:center;">';
        html += '<div class="wf-row-num" style="font-size:11px;font-weight:700;color:var(--text-dim,#888);font-family:\'Courier New\',monospace;">' + esc(item.number || '') + '</div>';
        html += '<div class="wf-row-body"><div style="font-size:13px;font-weight:600;color:var(--text,#fff);">' + esc(item.subject) + '</div>';
        if (item.body) {
          html += '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:600px;">' + esc(item.body.slice(0, 120)) + '</div>';
        }
        if (item.type === 'submittal' && item.metadata && item.metadata.submitted_to) {
          html += '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">Submitted to: <strong style="color:var(--text,#cfd3e2);">' + esc(item.metadata.submitted_to) + '</strong></div>';
        }
        html += '</div>';
        html += '<div class="wf-row-due" style="font-size:11px;color:' + (overdue ? '#f87171' : 'var(--text-dim,#aaa)') + ';">';
        if (item.due_date) html += (overdue ? '⚠ Overdue: ' : 'Due ') + esc(fmtDate(item.due_date));
        html += '</div>';
        html += '<div class="wf-row-status"><span style="display:inline-block;background:' + ss.bg + ';color:' + ss.fg + ';padding:3px 10px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;">' + esc(ss.label) + '</span></div>';
        html += '</div></div>';

        // Inline edit panel when expanded.
        if (STATE.expandedId === item.id) {
          html += renderEditPanel(item);
        }
      });
      html += '</div>';
    }

    host.innerHTML = html;
    wireEvents(host);

    // Bring an auto-expanded (deep-linked) row into view.
    if (STATE.expandedId != null) {
      var rows = host.querySelectorAll('[data-workflow-row]');
      for (var k = 0; k < rows.length; k++) {
        if (rows[k].getAttribute('data-workflow-row') === String(STATE.expandedId)) {
          try { rows[k].scrollIntoView({ block: 'center', behavior: 'smooth' }); } catch (e) {}
          break;
        }
      }
    }
  }

  function renderEditPanel(item) {
    var statusOpts = STATUS_OPTIONS[item.type] || [];
    var meta = item.metadata || {};
    var typeLabel = TYPE_LABELS[item.type] || { singular: item.type };
    var html = '<div data-workflow-edit="' + esc(item.id) + '" style="padding:16px 14px;background:rgba(79,140,255,0.03);border-top:1px solid var(--ng-border2,#2e3346);">';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:10px;">';
    // Subject
    html += '<div style="grid-column:1/-1;"><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Subject</label>';
    html += '<input type="text" data-edit-field="subject" value="' + esc(item.subject) + '" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
    html += '</div>';
    // Status
    html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Status</label>';
    html += '<select data-edit-field="status" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
    statusOpts.forEach(function(s) {
      var sl = STATUS_STYLE[s] || { label: s };
      html += '<option value="' + esc(s) + '"' + (item.status === s ? ' selected' : '') + '>' + esc(sl.label) + '</option>';
    });
    html += '</select></div>';
    // Due date
    html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Due Date</label>';
    html += '<input type="date" data-edit-field="due_date" value="' + esc((item.due_date || '').slice(0, 10)) + '" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
    html += '</div>';
    // Body
    html += '<div style="grid-column:1/-1;"><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Description</label>';
    html += '<textarea data-edit-field="body" rows="3" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;resize:vertical;">' + esc(item.body || '') + '</textarea>';
    html += '</div>';
    // Type-specific metadata
    if (item.type === 'rfi') {
      html += '<div style="grid-column:1/-1;"><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Response (when answered)</label>';
      html += '<textarea data-edit-meta="response" rows="2" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;resize:vertical;">' + esc(meta.response || '') + '</textarea>';
      html += '</div>';
    } else if (item.type === 'submittal') {
      html += '<div style="grid-column:1/-1;"><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Submitted To</label>';
      html += '<input type="text" data-edit-meta="submitted_to" value="' + esc(meta.submitted_to || '') + '" placeholder="e.g. Architect / Engineer of Record / GC" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
      html += '</div>';
      html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Category</label>';
      html += '<input type="text" data-edit-meta="category" value="' + esc(meta.category || '') + '" placeholder="e.g. Mechanical, Electrical" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
      html += '</div>';
      html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Spec Section</label>';
      html += '<input type="text" data-edit-meta="spec_section" value="' + esc(meta.spec_section || '') + '" placeholder="e.g. 07 54 23" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
      html += '</div>';
    } else if (item.type === 'transmittal') {
      html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Recipient Name</label>';
      html += '<input type="text" data-edit-meta="recipient_name" value="' + esc(meta.recipient_name || '') + '" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
      html += '</div>';
      html += '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Method</label>';
      html += '<select data-edit-meta="method" style="width:100%;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:7px 10px;border-radius:6px;font-size:13px;">';
      ['email', 'hand-delivered', 'courier', 'mail', 'upload'].forEach(function(m) {
        html += '<option value="' + m + '"' + (meta.method === m ? ' selected' : '') + '>' + m + '</option>';
      });
      html += '</select></div>';
    }
    html += '</div>';
    html += '<div style="display:flex;gap:8px;justify-content:flex-end;">';
    html += '<button data-workflow-cancel style="background:transparent;border:1px solid var(--border,#2e3346);color:var(--text-dim,#888);padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>';
    html += '<button data-workflow-archive="' + esc(item.id) + '" style="background:transparent;border:1px solid rgba(248,113,113,0.4);color:#f87171;padding:7px 14px;border-radius:6px;font-size:12px;cursor:pointer;">Archive</button>';
    html += '<button data-workflow-save="' + esc(item.id) + '" style="background:#4f8cff;border:none;color:#fff;padding:7px 14px;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;">Save</button>';
    html += '</div></div>';
    return html;
  }

  function wireEvents(host) {
    host.querySelectorAll('[data-workflow-type]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        STATE.activeType = btn.getAttribute('data-workflow-type');
        STATE.expandedId = null;
        loadItems();
      });
    });
    var newBtn = host.querySelector('[data-workflow-new]');
    if (newBtn) newBtn.addEventListener('click', openCreateModal);

    host.querySelectorAll('[data-workflow-row]').forEach(function(row) {
      row.addEventListener('click', function(e) {
        if (e.target.closest('[data-workflow-edit]')) return;
        var id = row.getAttribute('data-workflow-row');
        STATE.expandedId = STATE.expandedId === id ? null : id;
        paint();
      });
    });
    host.querySelectorAll('[data-workflow-cancel]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        STATE.expandedId = null;
        paint();
      });
    });
    host.querySelectorAll('[data-workflow-save]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-workflow-save');
        saveItem(id, btn.closest('[data-workflow-edit]'));
      });
    });
    host.querySelectorAll('[data-workflow-archive]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var id = btn.getAttribute('data-workflow-archive');
        if (!confirm('Archive this item? It will hide from lists but stay in the audit trail.')) return;
        window.p86Api.post('/api/workflow-items/' + encodeURIComponent(id) + '/archive', {})
          .then(function() { STATE.expandedId = null; loadItems(); })
          .catch(function(err) { alert('Archive failed: ' + (err && err.message || err)); });
      });
    });
  }

  function saveItem(id, editPanel) {
    if (!editPanel) return;
    var payload = {};
    var meta = {};
    editPanel.querySelectorAll('[data-edit-field]').forEach(function(input) {
      var key = input.getAttribute('data-edit-field');
      var val = input.value;
      payload[key] = val === '' ? null : val;
    });
    editPanel.querySelectorAll('[data-edit-meta]').forEach(function(input) {
      var key = input.getAttribute('data-edit-meta');
      meta[key] = input.value;
    });
    if (Object.keys(meta).length) payload.metadata = meta;
    window.p86Api.put('/api/workflow-items/' + encodeURIComponent(id), payload)
      .then(function() { STATE.expandedId = null; loadItems(); })
      .catch(function(err) { alert('Save failed: ' + (err && err.message || err)); });
  }

  function openCreateModal() {
    var type = STATE.activeType;
    var meta = TYPE_LABELS[type];
    var prior = document.getElementById('workflowCreateModal');
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = 'workflowCreateModal';
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:9999;display:flex;align-items:center;justify-content:center;padding:20px;';
    var statusOpts = STATUS_OPTIONS[type];
    modal.innerHTML =
      '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#2e3346);border-radius:10px;max-width:540px;width:100%;padding:18px 22px;">' +
        '<div style="font-size:14px;font-weight:700;color:var(--text,#fff);margin-bottom:14px;">' + meta.icon + ' New ' + esc(meta.singular) + '</div>' +
        '<label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Subject *</label>' +
        '<input type="text" id="workflowCreateSubject" autofocus style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:12px;">' +
        '<label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Description</label>' +
        '<textarea id="workflowCreateBody" rows="3" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:12px;resize:vertical;"></textarea>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;margin-bottom:18px;">' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Due Date</label>' +
          '<input type="date" id="workflowCreateDue" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;"></div>' +
          '<div><label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Status</label>' +
          '<select id="workflowCreateStatus" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;">' +
          statusOpts.map(function(s) { var sl = STATUS_STYLE[s] || {}; return '<option value="' + s + '">' + esc(sl.label || s) + '</option>'; }).join('') +
          '</select></div>' +
        '</div>' +
        (type === 'submittal'
          ? '<label style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:3px;">Submitted To</label>' +
            '<input type="text" id="workflowCreateSubmittedTo" placeholder="e.g. Architect / Engineer of Record / GC" style="width:100%;background:rgba(0,0,0,0.3);border:1px solid var(--border,#2e3346);color:var(--text,#fff);padding:8px 10px;border-radius:6px;font-size:13px;margin-bottom:18px;">'
          : '') +
        '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
          '<button id="workflowCreateCancel" style="background:transparent;border:1px solid var(--border,#2e3346);color:var(--text-dim,#888);padding:8px 16px;border-radius:6px;font-size:12px;cursor:pointer;">Cancel</button>' +
          '<button id="workflowCreateSubmit" style="background:#34d399;color:#0f0f1e;border:none;padding:8px 18px;border-radius:6px;font-size:12px;font-weight:700;cursor:pointer;">Create</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    function close() { modal.remove(); }
    document.getElementById('workflowCreateCancel').addEventListener('click', close);
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    document.getElementById('workflowCreateSubmit').addEventListener('click', function() {
      var subject = document.getElementById('workflowCreateSubject').value.trim();
      if (!subject) { alert('Subject is required.'); return; }
      var payload = {
        type: type,
        subject: subject,
        body: document.getElementById('workflowCreateBody').value || null,
        due_date: document.getElementById('workflowCreateDue').value || null,
        status: document.getElementById('workflowCreateStatus').value
      };
      if (type === 'submittal') {
        var stTo = (document.getElementById('workflowCreateSubmittedTo') || {}).value;
        if (stTo && stTo.trim()) payload.metadata = { submitted_to: stTo.trim() };
      }
      window.p86Api.post('/api/jobs/' + encodeURIComponent(STATE.jobId) + '/workflow-items', payload)
        .then(function() { close(); loadItems(); })
        .catch(function(err) { alert('Create failed: ' + (err && err.message || err)); });
    });
  }

  window.p86JobWorkflowUI = { mount: mount, setFocus: setFocus };
})();
