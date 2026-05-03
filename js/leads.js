// AGX Leads module — sales pipeline rendered on the Estimates tab.
//
// Phase 1: list + create/edit/delete with the General fields. Status pipeline
// is the spine: New -> In Progress -> Sent -> Sold | Lost | No Opportunity.
// Phase 2 will add the lead detail view with a Proposals (estimates) sub-tab.
(function() {
  'use strict';

  var _leads = [];

  // Status enum metadata. Drives the filter dropdown, the editor modal,
  // the list pill colors, and the status flow comments. Keep order in
  // sync with the index.html selects.
  var STATUSES = [
    { key: 'new',             label: 'New',             color: '#4f8cff', bg: 'rgba(79,140,255,0.12)' },
    { key: 'in_progress',     label: 'In Progress',     color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
    { key: 'sent',            label: 'Sent',            color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
    { key: 'sold',            label: 'Sold',            color: '#34d399', bg: 'rgba(52,211,153,0.15)' },
    { key: 'lost',            label: 'Lost',            color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    { key: 'no_opportunity',  label: 'No Opportunity',  color: '#8b90a5', bg: 'rgba(139,144,165,0.10)' }
  ];
  function statusMeta(key) { return STATUSES.find(function(s) { return s.key === key; }) || STATUSES[0]; }

  function escapeAttr(v) { return escapeHTML(v == null ? '' : String(v)); }
  function fmtCurrencyShort(n) {
    if (n == null || isNaN(n)) return '';
    n = Number(n);
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + Math.round(n).toLocaleString();
  }
  // AGX-side only uses the single estimated revenue figure (the min).
  // Kept the same function name and accepts (low, high) for back-compat
  // with existing call sites — the high arg is ignored.
  function fmtRevenueRange(low /*, high */) {
    if (low == null || low === '' || Number(low) === 0) return '';
    return fmtCurrencyShort(low);
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  // ──────────────────────────────────────────────────────────────────
  // List + filter
  // ──────────────────────────────────────────────────────────────────

  // BT-style column layout — sortable header, dense rows, status pill,
  // numeric columns right-aligned. Click anywhere on a row to open the
  // editor.
  var _leadsSort = { key: 'updated_at', dir: 'desc' };

  function leadRowHTML(l) {
    var sm = statusMeta(l.status);
    var statusPill =
      '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:' + sm.bg + ';color:' + sm.color +
      ';font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;white-space:nowrap;">' +
      escapeHTML(sm.label) + '</span>';

    var clientCell;
    if (l.client_name) {
      clientCell = '<div style="font-size:13px;color:var(--text,#e6e6e6);">' + escapeHTML(l.client_name) + '</div>';
      if (l.client_company && l.client_company !== l.client_name) {
        clientCell += '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:1px;">' + escapeHTML(l.client_company) + '</div>';
      }
    } else {
      clientCell = '<span style="color:var(--text-dim,#666);font-style:italic;font-size:12px;">no client</span>';
    }

    var revenue = fmtRevenueRange(l.estimated_revenue_low, l.estimated_revenue_high);
    var conf = (l.confidence != null && l.confidence > 0) ? l.confidence + '%' : '';
    var location = [l.city, l.state].filter(Boolean).join(', ');

    // Projected sale: show the date if set; flag as "overdue" in red
    // when the date has passed and the lead isn't terminal (sold/lost/no_opp).
    var projDateStr = l.projected_sale_date ? fmtDate(l.projected_sale_date) : '';
    var projColor = 'var(--text-dim,#aaa)';
    if (l.projected_sale_date) {
      var pd = new Date(l.projected_sale_date).getTime();
      var terminal = ['sold', 'lost', 'no_opportunity'].indexOf(l.status) !== -1;
      if (!terminal && !isNaN(pd) && pd < Date.now() - 86400000) projColor = '#f87171';
    }

    return '<tr class="leads-row" onclick="openEditLeadModal(\'' + escapeAttr(l.id) + '\')">' +
      '<td class="lead-title-cell">' +
        '<div style="font-weight:600;color:var(--text,#fff);font-size:13px;line-height:1.3;">' + escapeHTML(l.title) + '</div>' +
        (location ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">' + escapeHTML(location) + '</div>' : '') +
      '</td>' +
      '<td>' + clientCell + '</td>' +
      '<td>' + statusPill + '</td>' +
      '<td class="num" style="font-family:\'SF Mono\',monospace;color:#34d399;font-weight:600;font-size:13px;">' + escapeHTML(revenue) + '</td>' +
      '<td class="num" style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:12px;">' + escapeHTML(conf) + '</td>' +
      '<td style="font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(l.salesperson_name || '') + '</td>' +
      '<td style="font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(l.source || '') + '</td>' +
      '<td style="font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(l.project_type || '') + '</td>' +
      '<td style="font-size:11px;color:' + projColor + ';white-space:nowrap;">' + escapeHTML(projDateStr) + '</td>' +
      '<td style="font-size:11px;color:var(--text-dim,#888);white-space:nowrap;" title="created ' + escapeAttr(fmtDate(l.created_at)) + '">' + escapeHTML(fmtDate(l.updated_at || l.created_at)) + '</td>' +
    '</tr>';
  }

  // Stable sort by the configured column. Strings use locale compare,
  // numbers/dates fall back to numeric. Status sorts by pipeline order
  // (new → in_progress → sent → sold/lost/no_opportunity) instead of
  // alphabetically — way more useful for a sales view.
  function compareLeads(a, b, key, dir) {
    var av, bv;
    if (key === 'status') {
      var order = STATUSES.map(function(s) { return s.key; });
      av = order.indexOf(a.status); bv = order.indexOf(b.status);
    } else if (key === 'revenue') {
      av = Number(a.estimated_revenue_low || 0);
      bv = Number(b.estimated_revenue_low || 0);
    } else if (key === 'confidence') {
      av = Number(a.confidence || 0); bv = Number(b.confidence || 0);
    } else if (key === 'created_at' || key === 'updated_at') {
      av = a[key] ? new Date(a[key]).getTime() : 0;
      bv = b[key] ? new Date(b[key]).getTime() : 0;
    } else if (key === 'projected_sale_date') {
      // Dates with no value sort as "very far future" when ascending so
      // the unscheduled leads land at the end of the pipeline view.
      av = a.projected_sale_date ? new Date(a.projected_sale_date).getTime() : Infinity;
      bv = b.projected_sale_date ? new Date(b.projected_sale_date).getTime() : Infinity;
    } else if (key === 'client') {
      av = (a.client_name || '').toLowerCase(); bv = (b.client_name || '').toLowerCase();
    } else if (key === 'salesperson') {
      av = (a.salesperson_name || '').toLowerCase(); bv = (b.salesperson_name || '').toLowerCase();
    } else if (key === 'project_type') {
      av = (a.project_type || '').toLowerCase(); bv = (b.project_type || '').toLowerCase();
    } else if (key === 'source') {
      av = (a.source || '').toLowerCase(); bv = (b.source || '').toLowerCase();
    } else { // title
      av = (a.title || '').toLowerCase(); bv = (b.title || '').toLowerCase();
    }
    if (av < bv) return dir === 'desc' ? 1 : -1;
    if (av > bv) return dir === 'desc' ? -1 : 1;
    return 0;
  }

  function sortLeads(key) {
    if (_leadsSort.key === key) {
      _leadsSort.dir = _leadsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      _leadsSort.key = key;
      // Default direction: dates and numerics descend (newest/biggest
      // first); text columns ascend. Projected-sale-date is the
      // exception — ascending puts the next-up sales first.
      var descKeys = ['created_at', 'updated_at', 'revenue', 'confidence'];
      _leadsSort.dir = descKeys.indexOf(key) !== -1 ? 'desc' : 'asc';
    }
    renderLeadsList();
  }

  function leadsHeaderCell(label, key, opts) {
    opts = opts || {};
    var active = _leadsSort.key === key;
    var arrow = active ? (_leadsSort.dir === 'asc' ? ' &uarr;' : ' &darr;') : '';
    var color = active ? '#4f8cff' : 'var(--text-dim,#888)';
    var alignClass = opts.num ? ' class="num"' : '';
    return '<th' + alignClass + ' style="text-align:' + (opts.num ? 'right' : 'left') + ';" onclick="sortLeadsBy(\'' + key + '\')">' +
      '<span style="cursor:pointer;color:' + color + ';font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;user-select:none;">' +
      label + arrow +
      '</span>' +
    '</th>';
  }

  function matchesSearch(l, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [
      l.title, l.client_name, l.client_company,
      l.salesperson_name, l.source, l.project_type,
      l.property_name, l.market, l.city, l.state,
      l.notes
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderLeadsList() {
    var listEl = document.getElementById('leads-list');
    var summaryEl = document.getElementById('leads-summary');
    if (!listEl) return;
    var statusFilter = document.getElementById('leads-filter-status');
    var searchEl = document.getElementById('leads-search');
    var filterStatus = statusFilter ? statusFilter.value : '';
    var q = searchEl ? searchEl.value.trim() : '';

    if (!_leads.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading leads…</div>';
      if (!window.agxApi || !window.agxApi.isAuthenticated()) {
        listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Leads aren\'t available in offline mode.</div>';
        return;
      }
      window.agxApi.leads.list().then(function(res) {
        _leads = res.leads || [];
        renderLeadsList();
      }).catch(function(err) {
        listEl.innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center;">Failed to load leads: ' + escapeHTML(err.message) + '</div>';
      });
      return;
    }

    var filtered = _leads.filter(function(l) {
      if (filterStatus && l.status !== filterStatus) return false;
      return matchesSearch(l, q);
    });
    if (summaryEl) {
      var byStatus = {};
      _leads.forEach(function(l) { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
      var counts = STATUSES
        .filter(function(s) { return byStatus[s.key]; })
        .map(function(s) { return byStatus[s.key] + ' ' + s.label.toLowerCase(); })
        .join(' · ');
      var prefix = (filterStatus || q)
        ? 'Showing ' + filtered.length + ' of ' + _leads.length + ' leads'
        : _leads.length + ' leads';
      summaryEl.textContent = counts ? prefix + ' (' + counts + ')' : prefix;
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">' +
        ((filterStatus || q) ? 'No leads match.' : 'No leads yet. Click + New Lead to start tracking opportunities.') +
        '</div>';
      return;
    }

    var sorted = filtered.slice().sort(function(a, b) {
      return compareLeads(a, b, _leadsSort.key, _leadsSort.dir);
    });

    var headerRow =
      leadsHeaderCell('Title',         'title') +
      leadsHeaderCell('Client',        'client') +
      leadsHeaderCell('Status',        'status') +
      leadsHeaderCell('Revenue',       'revenue', { num: true }) +
      leadsHeaderCell('Conf',          'confidence', { num: true }) +
      leadsHeaderCell('Salesperson',   'salesperson') +
      leadsHeaderCell('Source',        'source') +
      leadsHeaderCell('Project Type',  'project_type') +
      leadsHeaderCell('Proj. Sale',    'projected_sale_date') +
      leadsHeaderCell('Updated',       'updated_at');

    listEl.innerHTML =
      '<div class="leads-table-wrap" style="border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;background:var(--card-bg,#0f0f1e);">' +
        '<table class="leads-table" style="width:100%;border-collapse:collapse;table-layout:auto;">' +
          '<thead style="background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);">' +
            '<tr>' + headerRow + '</tr>' +
          '</thead>' +
          '<tbody>' + sorted.map(leadRowHTML).join('') + '</tbody>' +
        '</table>' +
      '</div>';
  }

  function reloadLeadsCache() {
    _leads = [];
    renderLeadsList();
  }

  // ──────────────────────────────────────────────────────────────────
  // Editor modal
  // ──────────────────────────────────────────────────────────────────

  var EDITABLE_FIELDS = [
    'client_id', 'title',
    'street_address', 'city', 'state', 'zip',
    'status', 'confidence', 'projected_sale_date',
    'estimated_revenue_low', 'estimated_revenue_high',
    'source', 'project_type',
    'salesperson_id',
    'property_name', 'gate_code', 'market',
    'notes'
  ];

  function setField(name, value) {
    var el = document.getElementById('leadEditor_' + (name === 'title' ? 'title_field' : name));
    if (!el) return;
    el.value = (value == null ? '' : value);
    if (name === 'confidence') {
      var lbl = document.getElementById('leadEditor_confidenceLabel');
      if (lbl) lbl.textContent = '— ' + (el.value || '0') + '%';
    }
  }
  function getField(name) {
    var el = document.getElementById('leadEditor_' + (name === 'title' ? 'title_field' : name));
    return el ? el.value : '';
  }

  function clearEditor() {
    EDITABLE_FIELDS.forEach(function(f) { setField(f, ''); });
    setField('status', 'new');
    setField('confidence', 0);
    document.getElementById('leadEditor_id').value = '';
    document.getElementById('leadEditor_status_msg').textContent = '';
    document.getElementById('leadEditor_submitBtn').disabled = false;
    document.getElementById('leadEditor_deleteBtn').style.display = 'none';
    var chip = document.getElementById('leadEditor_linkedJob');
    if (chip) chip.style.display = 'none';
    var convertBtn = document.getElementById('leadEditor_convertJobBtn');
    if (convertBtn) convertBtn.style.display = 'none';
  }

  // Reuse the clients cache (loaded by clients.js) so we don't hit the API
  // again. Falls back to a fetch if the cache is empty (e.g. user opens
  // the Lead modal before they've ever opened the Clients tab).
  function populateClientSelect(currentClientId) {
    var sel = document.getElementById('leadEditor_client_id');
    if (!sel) return;
    var fillFrom = function(clients) {
      // Underlying <select> stays populated for back-compat. The
      // searchable picker widget reads .value off this same element.
      var html = '<option value="">— Select a client —</option>';
      clients.slice().sort(function(a, b) {
        return (a.name || '').localeCompare(b.name || '');
      }).forEach(function(c) {
        var selAttr = c.id === currentClientId ? ' selected' : '';
        html += '<option value="' + escapeAttr(c.id) + '"' + selAttr + '>' + escapeHTML(c.name || '(unnamed)') + '</option>';
      });
      sel.innerHTML = html;
      sel.value = currentClientId || '';

      // Mount the searchable picker. The original <select> has an
      // onchange="onLeadClientPicked()" attribute — re-fire that after
      // a click-pick so the lead-side prefill (address, etc.) still runs.
      if (window.agxClients && typeof window.agxClients.mountPicker === 'function') {
        var handle = window.agxClients.mountPicker(sel, function() {
          if (typeof onLeadClientPicked === 'function') onLeadClientPicked();
        });
        if (handle && handle.refreshLabel) handle.refreshLabel();
      }
    };
    var cached = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
    if (cached.length) {
      fillFrom(cached);
    } else if (window.agxApi && window.agxApi.isAuthenticated()) {
      window.agxApi.clients.list().then(function(res) {
        fillFrom(res.clients || []);
      }).catch(function() { fillFrom([]); });
    } else {
      fillFrom([]);
    }
  }

  // Salesperson dropdown reads from the same admin users cache the rest of
  // the app uses. We list active PMs and admins (people who'd realistically
  // own a sales opportunity).
  function populateSalespersonSelect(currentId) {
    var sel = document.getElementById('leadEditor_salesperson_id');
    if (!sel) return;
    var users = (window.agxAdmin && window.agxAdmin.getActivePMs && window.agxAdmin.getActivePMs()) || [];
    var html = '<option value="">— Unassigned —</option>';
    users.forEach(function(u) {
      var sel = (String(u.id) === String(currentId)) ? ' selected' : '';
      html += '<option value="' + u.id + '"' + sel + '>' + escapeHTML(u.name) +
        (u.role === 'admin' ? ' (admin)' : '') + '</option>';
    });
    sel.innerHTML = html;
    // If users haven't loaded yet, refresh and retry once.
    if (!users.length && window.agxAdmin && window.agxAdmin.loadUsersCache) {
      window.agxAdmin.loadUsersCache().then(function() { populateSalespersonSelect(currentId); });
    }
  }

  // When the client dropdown changes, copy the picked client's address into
  // the lead's project-address fields. User can edit afterward — this is a
  // pre-fill, not a binding.
  function onLeadClientPicked() {
    var sel = document.getElementById('leadEditor_client_id');
    if (!sel || !sel.value) return;
    var cached = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
    var c = cached.find(function(x) { return x.id === sel.value; });
    if (!c) return;
    // Only set fields the user hasn't already filled in
    function setIfEmpty(name, v) {
      var el = document.getElementById('leadEditor_' + name);
      if (el && !el.value && v) el.value = v;
    }
    setIfEmpty('street_address', c.property_address || c.address);
    setIfEmpty('city', c.city);
    setIfEmpty('state', c.state);
    setIfEmpty('zip', c.zip);
    setIfEmpty('property_name', c.community_name);
    setIfEmpty('market', c.market);
    setIfEmpty('gate_code', c.gate_code);
  }

  function openNewLeadModal() {
    clearEditor();
    document.getElementById('leadEditor_title').textContent = 'New Lead';
    populateClientSelect('');
    populateSalespersonSelect('');
    // Hide tabs in create mode — Proposals tab is meaningless until the
    // lead has an id. Reveal them on first save / re-open in edit mode.
    document.getElementById('leadEditor_tabs').style.display = 'none';
    var generalTab = document.getElementById('leadEditor_tab_general');
    var proposalsTab = document.getElementById('leadEditor_tab_proposals');
    if (generalTab) generalTab.style.display = '';
    if (proposalsTab) proposalsTab.style.display = 'none';
    var footer = document.querySelector('#leadEditorModal .modal-footer');
    if (footer) footer.style.display = '';
    // Show the BT-PDF drop zone and reset its status — only on create
    var pdfDrop = document.getElementById('leadEditor_pdfDrop');
    if (pdfDrop) {
      pdfDrop.style.display = '';
      var s = document.getElementById('leadEditor_pdfDropStatus');
      if (s) { s.style.display = 'none'; s.textContent = ''; s.style.color = ''; }
      wirePdfDropOnce();
    }
    openModal('leadEditorModal');
  }

  function openEditLeadModal(id) {
    var l = _leads.find(function(x) { return x.id === id; });
    if (!l) {
      // Fall back to fetching by id if not in cache (rare — list is fresh)
      window.agxApi.leads.get(id).then(function(res) {
        _leads.push(res.lead);
        openEditLeadModal(id);
      }).catch(function() { alert('Lead not found.'); });
      return;
    }
    clearEditor();
    document.getElementById('leadEditor_title').textContent = 'Edit Lead: ' + l.title;
    document.getElementById('leadEditor_id').value = l.id;
    EDITABLE_FIELDS.forEach(function(f) { setField(f, l[f]); });
    populateClientSelect(l.client_id || '');
    populateSalespersonSelect(l.salesperson_id || '');
    document.getElementById('leadEditor_deleteBtn').style.display = '';
    // Hide the BT-PDF drop zone in edit mode — extraction only makes
    // sense when creating a fresh lead.
    var pdfDrop = document.getElementById('leadEditor_pdfDrop');
    if (pdfDrop) pdfDrop.style.display = 'none';
    // Edit mode shows the General | Proposals tab nav. Default to General;
    // user clicks Proposals to see the linked estimates.
    document.getElementById('leadEditor_tabs').style.display = '';
    switchLeadEditorTab('general');
    renderLeadProposals(l.id);
    refreshLinkedJobChip(l);
    refreshConvertJobButton(l);
    openLeadDetailView();
    // Live-refresh the detail-view sticky header when the user edits
    // the title or flips the status select. Bound after the form
    // renders so the elements exist; idempotent because we replace
    // .onchange/.oninput rather than addEventListener.
    var titleField = document.getElementById('leadEditor_title_field');
    var statusField = document.getElementById('leadEditor_status');
    if (titleField) {
      titleField.oninput = function() {
        var t = document.getElementById('ld-title');
        if (t) t.textContent = titleField.value || 'Lead';
      };
    }
    if (statusField) {
      statusField.onchange = function() { refreshLeadDetailHeader(); };
    }
  }

  // Open the dedicated #lead-detail-view as a full-page surface
  // (mirrors the estimate editor pattern). Re-parents the form body
  // (#leadEditor_formBody) from inside the modal into the detail
  // view's body host so the same form fields are reused without
  // duplicating IDs. Hides the leads list + the parent
  // Leads/Estimates/Clients/Subs nav so the Back button is the only
  // return path.
  function openLeadDetailView() {
    var detailView = document.getElementById('lead-detail-view');
    var bodyHost = document.getElementById('lead-detail-body-host');
    var formBody = document.getElementById('leadEditor_formBody');
    var listView = document.getElementById('leads-list-view');
    var mainTabs = document.getElementById('estimates-main-tabs');
    if (!detailView || !bodyHost || !formBody) {
      // Build is missing the new markup — fall back to modal mode.
      openModal('leadEditorModal');
      return;
    }
    if (formBody.parentNode !== bodyHost) bodyHost.appendChild(formBody);
    detailView.style.display = '';
    if (listView) listView.style.display = 'none';
    if (mainTabs) mainTabs.style.display = 'none';
    // Refresh the sticky-header title + status pill from the loaded form.
    refreshLeadDetailHeader();
    // Scroll to top so the user lands at the form's start.
    window.scrollTo(0, 0);
  }

  // Update the sticky-header title + status pill + delete/convert
  // button visibility from current form state. Called on open and
  // whenever the status select changes.
  function refreshLeadDetailHeader() {
    var l = _leads.find(function(x) { return x.id === _currentEditingLeadId; });
    var titleEl = document.getElementById('ld-title');
    var pillEl = document.getElementById('ld-status-pill');
    var delBtn = document.getElementById('ld-delete-btn');
    var convertBtn = document.getElementById('ld-convert-btn');
    if (titleEl) titleEl.textContent = (l && l.title) || 'Lead';
    if (pillEl) {
      var statusVal = (document.getElementById('leadEditor_status') || {}).value || (l && l.status) || 'new';
      var sm = statusMeta(statusVal);
      pillEl.innerHTML =
        '<span style="display:inline-block;padding:3px 10px;border-radius:10px;background:' + sm.bg +
        ';color:' + sm.color + ';font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' +
        escapeHTML(sm.label) + '</span>';
    }
    // Delete + Convert buttons only meaningful in edit mode (we have an id).
    if (delBtn) delBtn.style.display = (l && l.id) ? '' : 'none';
    if (convertBtn && l) {
      var canEditJobs = window.agxAuth && (
        window.agxAuth.hasCapability('JOBS_EDIT_ANY') ||
        window.agxAuth.hasCapability('JOBS_EDIT_OWN')
      );
      convertBtn.style.display = (canEditJobs && !l.job_id) ? '' : 'none';
    }
  }
  window.refreshLeadDetailHeader = refreshLeadDetailHeader;

  // Reverse openLeadDetailView. Moves the form body back into the
  // modal so a subsequent "New Lead" click renders the same form as
  // a centered popup again.
  function closeLeadDetail() {
    var detailView = document.getElementById('lead-detail-view');
    var formBody = document.getElementById('leadEditor_formBody');
    var modalContent = document.querySelector('#leadEditorModal .modal-content');
    var modalFooter = document.getElementById('leadEditor_modalFooter');
    var listView = document.getElementById('leads-list-view');
    var mainTabs = document.getElementById('estimates-main-tabs');
    // Move the form body back into the modal, just before the footer.
    if (formBody && modalContent && modalFooter && formBody.parentNode !== modalContent) {
      modalContent.insertBefore(formBody, modalFooter);
    }
    if (detailView) detailView.style.display = 'none';
    if (listView) listView.style.display = '';
    if (mainTabs) mainTabs.style.display = '';
    _currentEditingLeadId = null;
    reloadLeadsCache();
  }
  window.closeLeadDetail = closeLeadDetail;

  // Single close-helper used by save / cancel / delete handlers. Picks
  // the right teardown based on which mode the lead editor is currently
  // displayed in (modal for create vs page for edit).
  function closeLeadEditorAny() {
    var detailView = document.getElementById('lead-detail-view');
    var inDetailMode = detailView && detailView.style.display !== 'none';
    if (inDetailMode) {
      closeLeadDetail();
    } else {
      if (typeof closeModal === 'function') closeModal('leadEditorModal');
    }
  }

  // Show the green "Sold — linked to a job" chip when the lead has a job_id.
  // Clicking the chip's button jumps to that job's WIP detail view.
  function refreshLinkedJobChip(l) {
    var chip = document.getElementById('leadEditor_linkedJob');
    var labelEl = document.getElementById('leadEditor_linkedJobLabel');
    if (!chip) return;
    if (!l || !l.job_id) {
      chip.style.display = 'none';
      return;
    }
    var jobs = (window.appData && appData.jobs) || [];
    var job = jobs.find(function(j) { return j.id === l.job_id; });
    if (labelEl) {
      labelEl.textContent = job
        ? ((job.jobNumber ? '[' + job.jobNumber + '] ' : '') + (job.title || job.id))
        : ('Job ' + l.job_id + ' (not in current view — admin may have removed it)');
    }
    chip.style.display = 'flex';
  }

  // Hide the convert button on already-converted leads (they have a job_id)
  // and on roles without job-edit capability. Keeping the button always
  // visible would tempt double-conversion of the same lead.
  function refreshConvertJobButton(l) {
    var btn = document.getElementById('leadEditor_convertJobBtn');
    if (!btn) return;
    var canEditJobs = window.agxAuth && (
      window.agxAuth.hasCapability('JOBS_EDIT_ANY') ||
      window.agxAuth.hasCapability('JOBS_EDIT_OWN')
    );
    btn.style.display = (canEditJobs && (!l || !l.job_id)) ? '' : 'none';
  }

  // Open the WIP job linked to the currently-editing lead.
  function openLinkedJobFromLead() {
    var leadId = _currentEditingLeadId;
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l || !l.job_id) return;
    closeLeadEditorAny();
    if (typeof window.switchTab === 'function') {
      window.switchTab('wip');
      // editJob is defined in wip.js; give the WIP render a tick before opening
      setTimeout(function() {
        if (typeof window.editJob === 'function') window.editJob(l.job_id);
      }, 200);
    }
  }

  // Convert the currently-editing lead into a new WIP job. Copies title,
  // client, project type, market, contract amount (from estimated revenue),
  // and assigns the salesperson as PM/owner. Sets lead.status = 'sold' and
  // lead.job_id = new job id so future opens of the lead show the chip.
  function convertLeadToJob() {
    var leadId = _currentEditingLeadId;
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l) return;
    if (l.job_id) {
      alert('This lead is already linked to a job. Use the Open Job button.');
      return;
    }
    if (!window.appData || !Array.isArray(window.appData.jobs)) {
      alert('App data not ready — try again in a moment.');
      return;
    }

    var clientCache = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
    var c = l.client_id ? clientCache.find(function(x) { return x.id === l.client_id; }) : null;
    var clientName = c ? (c.company_name || c.name) : '';

    var msg =
      'Create a new WIP job from this lead?\n\n' +
      'This will:\n' +
      '  • Add a job to WIP with the lead\'s title, client, and project info\n' +
      '  • Use Estimated Revenue (high) as the Contract Amount\n' +
      '  • Mark the lead as Sold and link the new job to it\n\n' +
      'You can edit the job number, costs, and other fields after.';
    if (!confirm(msg)) return;

    // Lead-to-job conversion: use the single estimated revenue value as
    // the starter contract amount (we no longer track a low/high range).
    var contractAmt = Number(l.estimated_revenue_low || 0);
    var me = window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser();
    var ownerId = l.salesperson_id || (me && me.id) || null;

    var jobId = 'j' + Date.now();
    var nowIso = new Date().toISOString();
    var newJob = {
      id: jobId,
      jobNumber: '',
      title: l.title,
      client: clientName,
      pm: '',
      owner_id: ownerId,
      jobType: l.project_type || '',
      workType: '',
      market: l.market || '',
      status: 'New',
      contractAmount: contractAmt,
      estimatedCosts: 0,
      targetMarginPct: 50,
      pctComplete: 0,
      invoicedToDate: 0,
      revisedCostChanges: 0,
      notes: l.notes || '',
      createdAt: nowIso,
      updatedAt: nowIso
    };
    window.appData.jobs.push(newJob);
    if (typeof saveData === 'function') saveData();

    // Update the lead record on the server: set job_id + flip status to sold.
    // Keep the local lead object in sync so the chip renders correctly when
    // the modal stays open.
    window.agxApi.leads.update(leadId, { job_id: jobId, status: 'sold' }).then(function() {
      l.job_id = jobId;
      l.status = 'sold';
      closeLeadEditorAny();
      reloadLeadsCache();
      // Hand off to WIP so the user sees the new job
      if (typeof window.switchTab === 'function') window.switchTab('wip');
      setTimeout(function() {
        if (typeof window.editJob === 'function') window.editJob(jobId);
      }, 250);
    }).catch(function(err) {
      alert('Job created, but linking it back to the lead failed: ' + err.message +
            '\n\nThe job is in WIP — you can re-link it manually if needed.');
      closeLeadEditorAny();
      reloadLeadsCache();
      if (typeof window.switchTab === 'function') window.switchTab('wip');
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Proposals tab — estimates linked to this lead
  // ──────────────────────────────────────────────────────────────────

  // Currently-open lead id, used by createEstimateFromLead so the prefill
  // can find its source data without re-reading from the form fields.
  var _currentEditingLeadId = null;

  function switchLeadEditorTab(name) {
    document.querySelectorAll('[data-leadeditor-tab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.leadeditorTab === name);
    });
    document.getElementById('leadEditor_tab_general').style.display = (name === 'general') ? '' : 'none';
    document.getElementById('leadEditor_tab_proposals').style.display = (name === 'proposals') ? '' : 'none';
    var photosTab = document.getElementById('leadEditor_tab_photos');
    if (photosTab) photosTab.style.display = (name === 'photos') ? '' : 'none';
    // The footer Save / Delete buttons only make sense on the General tab.
    // On the Proposals / Photos tabs they'd be confusing (those have their
    // own save / delete flows). Hide the footer when one of those is active.
    var footer = document.querySelector('#leadEditorModal .modal-footer');
    if (footer) footer.style.display = (name === 'general') ? '' : 'none';
    // Mount the photos widget on first switch — re-uses the same mount on
    // re-entry since agxAttachments handles its own state internally.
    if (name === 'photos' && _currentEditingLeadId) {
      var mountEl = document.getElementById('leadEditor_photosMount');
      if (mountEl && window.agxAttachments) {
        window.agxAttachments.mount(mountEl, {
          entityType: 'lead',
          entityId: _currentEditingLeadId,
          canEdit: true
        });
      }
    }
  }

  function renderLeadProposals(leadId) {
    _currentEditingLeadId = leadId;
    var listEl = document.getElementById('leadEditor_proposalsList');
    var countEl = document.getElementById('leadEditor_proposalsCount');
    if (!listEl) return;
    var estimates = (window.appData && appData.estimates) || [];
    var linked = estimates.filter(function(e) { return e.lead_id === leadId; });
    if (countEl) countEl.textContent = linked.length ? '(' + linked.length + ')' : '';
    if (!linked.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;border:1px dashed var(--border,#333);border-radius:8px;">' +
        'No estimates yet. Click <strong>+ New Estimate from Lead</strong> to draft the first estimate.' +
      '</div>';
      return;
    }
    listEl.innerHTML = linked.map(proposalRowHTML).join('');
  }

  function proposalRowHTML(est) {
    var allLines = ((window.appData && appData.estimateLines) || []).filter(function(l) { return l.estimateId === est.id; });
    var baseCost = 0;
    var markedUp = 0;
    allLines.forEach(function(l, idx) {
      if (l.section === '__section_header__') return;
      var ext = (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
      baseCost += ext;
      // Per-line markup, falling back to enclosing section header, then
      // legacy estimate.defaultMarkup
      var m = (l.markup === '' || l.markup == null) ? null : Number(l.markup);
      if (m == null) {
        for (var i = idx - 1; i >= 0; i--) {
          var L = allLines[i];
          if (L && L.section === '__section_header__') {
            if (L.markup !== '' && L.markup != null) m = Number(L.markup);
            break;
          }
        }
      }
      if (m == null && est.defaultMarkup != null && est.defaultMarkup !== '') m = Number(est.defaultMarkup);
      if (m == null) m = 0;
      markedUp += ext * (1 + m / 100);
    });
    var blendedMarkup = baseCost > 0 ? (markedUp / baseCost - 1) * 100 : 0;
    var clientPrice = markedUp;
    return '<div class="card" style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="font-weight:600;font-size:13px;color:var(--text,#fff);">' + escapeHTML(est.title || 'Untitled estimate') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">' +
          'Base ' + fmtCurrencyShort(baseCost) +
          ' · Markup ' + blendedMarkup.toFixed(1) + '%' +
          ' · Client ' + fmtCurrencyShort(clientPrice) +
          ' · ' + allLines.filter(function(l) { return l.section !== '__section_header__'; }).length + ' line' + (allLines.length === 1 ? '' : 's') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button class="ee-btn secondary" onclick="openEstimateFromLead(\'' + escapeAttr(est.id) + '\', false);">Edit</button>' +
        '<button class="ee-btn secondary" onclick="openEstimateFromLead(\'' + escapeAttr(est.id) + '\', true);">Preview</button>' +
      '</div>' +
    '</div>';
  }

  // Navigate from the lead-editor's Estimates tab into the actual
  // estimate editor (or preview). The estimate views live inside the
  // Estimates top-tab → Estimates sub-tab, so we have to:
  //   1. Close the lead modal,
  //   2. Switch the top tab to "estimates" (the user is currently on
  //      the Leads sub-tab so the Estimates tab content is hidden),
  //   3. Switch the Estimates page to its "list" sub-tab so
  //      #estimate-editor-view is in the visible flow,
  //   4. Open the editor or preview.
  // Earlier the navigation skipped steps 2-3, so editEstimate ran but
  // its target view stayed hidden behind the sub-tab gate — clicking
  // Edit looked like a no-op.
  function openEstimateFromLead(estimateId, asPreview) {
    closeLeadEditorAny();
    if (typeof window.switchTab === 'function') {
      try { window.switchTab('estimates'); } catch (e) { /* defensive */ }
    }
    if (typeof window.switchEstimatesSubTab === 'function') {
      try { window.switchEstimatesSubTab('list'); } catch (e) { /* defensive */ }
    }
    if (asPreview) {
      if (typeof window.previewEstimate === 'function') window.previewEstimate(estimateId);
    } else {
      if (typeof window.editEstimate === 'function') window.editEstimate(estimateId);
    }
  }
  window.openEstimateFromLead = openEstimateFromLead;

  // Show the "From lead" banner above the client picker on the New
  // Estimate modal. Hidden by default; opened only when the modal was
  // launched via createEstimateFromLead.
  function showLeadPrefillBanner(lead) {
    var banner = document.getElementById('estLeadPrefillBanner');
    var label = document.getElementById('estLeadPrefillLabel');
    if (!banner) return;
    if (label) label.textContent = lead && lead.title ? lead.title : 'lead';
    banner.style.display = 'flex';
  }
  function hideLeadPrefillBanner() {
    var banner = document.getElementById('estLeadPrefillBanner');
    if (banner) banner.style.display = 'none';
  }
  // Single source of truth for lead → estimate-form prefill. Used by
  // both the initial open path (createEstimateFromLead) and the
  // "Copy from lead" recovery button. Always re-resolves the client
  // from the live cache so a fix to the lead-client link, or a
  // late-arriving cache load, picks up on the second click.
  //
  // Falls back to the lead's OWN fields when no client record is
  // available — leads carry `client_company`, `client_name`, and
  // `property_name` even when they aren't yet linked to a client
  // directory entry. Earlier versions left those fields blank in
  // that case, which is the bug the user was seeing.
  function applyLeadPrefill(l) {
    if (!l) return;
    function set(id, v) {
      var el = document.getElementById(id);
      if (el && v != null) el.value = v;
    }
    // Resolve client fresh on every call. cache may have been empty
    // the first time, or the link may have been added since.
    var clientCache = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
    var c = l.client_id ? clientCache.find(function(x) { return x.id === l.client_id; }) : null;

    set('estTitle', l.title || '');
    set('estJobType', l.project_type || '');
    set('estLeadId', l.id);
    set('estClientId', l.client_id || '');

    // Client company — prefer linked client record, fall back to the
    // lead's own company-name fields. `client_company` is the typed
    // input; `client_name` is sometimes the contact name and sometimes
    // the company depending on lead source — try both.
    set('estClient',
      (c && (c.company_name || c.name)) ||
      l.client_company || l.client_name || '');
    // Community / property — prefer client.community_name, then the
    // lead's property_name (the explicit "which community" field).
    set('estCommunity',
      (c && (c.community_name || c.name)) ||
      l.property_name || '');

    if (c) {
      // Billing address is the management company's mailing address —
      // always pulled from the client record, never the lead.
      var bAddr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      set('estBillingAddr', bAddr);
      set('estManagerName', c.community_manager || '');
      set('estManagerEmail', c.cm_email || c.email || '');
      set('estManagerPhone', c.cm_phone || c.phone || c.cell || '');
      if (typeof window.populateEstimateClientPicker === 'function') {
        window.populateEstimateClientPicker('estClientPicker', c.id);
      } else {
        var picker = document.getElementById('estClientPicker');
        if (picker) picker.value = c.id;
      }
    }
    // No `else` branch: leads don't currently store manager email /
    // phone separately from a client record, so we leave those blank
    // for the user to fill rather than guessing.

    // Property (job-site) address: the lead is the authoritative source
    // because it points at a specific opportunity. Pull street+city+
    // state+zip from the lead first; only fall back to the client's
    // mailing address when the lead has nothing.
    var hasLeadAddrParts = l.street_address || l.city || l.state || l.zip;
    var pAddr;
    if (hasLeadAddrParts) {
      pAddr = [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', ');
    } else if (c) {
      pAddr = [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
    } else {
      pAddr = '';
    }
    if (pAddr) set('estPropertyAddr', pAddr);

    // Refresh the stash so the banner + button stay accurate even if
    // we reached this path via copyFromLeadAgain instead of the
    // initial open.
    window._estimateLeadPrefillSource = { lead: l, client: c || null };
  }

  // Re-run the lead prefill — callable from the Copy-from-lead button.
  // Reads the lead snapshot stashed by createEstimateFromLead and
  // re-resolves the client live so any cache fix takes effect.
  window.copyFromLeadAgain = function() {
    var src = window._estimateLeadPrefillSource;
    if (!src || !src.lead) {
      alert('No lead context available — open this estimate from a lead to copy.');
      return;
    }
    applyLeadPrefill(src.lead);
  };

  // Pre-fill the New Estimate form from the currently-editing lead, then
  // open it. The estimate save path (createNewEstimate) reads the hidden
  // estLeadId / estClientId fields to persist the link. Delegates to
  // the shared applyLeadPrefill helper so the initial open and the
  // "Copy from lead" button always behave identically.
  function createEstimateFromLead() {
    var leadId = _currentEditingLeadId;
    if (!leadId) { alert('Save the lead first.'); return; }
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l) { alert('Lead not found.'); return; }

    closeLeadEditorAny();
    if (typeof window.openNewEstimateForm !== 'function') {
      alert('Estimate form not available.');
      return;
    }
    window.openNewEstimateForm();
    applyLeadPrefill(l);
    showLeadPrefillBanner(l);
  }

  function submitLeadEditor() {
    var statusEl = document.getElementById('leadEditor_status_msg');
    var btn = document.getElementById('leadEditor_submitBtn');
    var id = document.getElementById('leadEditor_id').value;
    var payload = {};
    EDITABLE_FIELDS.forEach(function(f) {
      var v = getField(f);
      payload[f] = v === '' ? null : v;
    });
    payload.title = (payload.title || '').trim();

    if (!payload.title) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Title is required.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    var p = id
      ? window.agxApi.leads.update(id, payload)
      : window.agxApi.leads.create(payload);

    p.then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      setTimeout(function() {
        closeLeadEditorAny();
        reloadLeadsCache();
      }, 600);
    }).catch(function(err) {
      btn.disabled = false;
      statusEl.style.color = '#e74c3c';
      statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
  }

  function deleteLeadFromEditor() {
    var id = document.getElementById('leadEditor_id').value;
    if (!id) return;
    var l = _leads.find(function(x) { return x.id === id; });

    // Estimates created from this lead carry lead_id === id. They have no
    // standalone meaning once the lead is gone, so delete them as part of
    // the same action. Surface the count up front so the user can back out.
    var linkedEstimates = (window.appData && window.appData.estimates || [])
      .filter(function(e) { return e.lead_id === id; });

    var msg = 'Delete lead "' + (l ? l.title : id) + '"? This cannot be undone.';
    if (linkedEstimates.length) {
      msg += '\n\nThis will also delete ' + linkedEstimates.length + ' linked estimate' +
             (linkedEstimates.length === 1 ? '' : 's') + ':\n  - ' +
             linkedEstimates.map(function(e) { return e.title || '(untitled)'; }).join('\n  - ');
    }
    if (!confirm(msg)) return;

    // Delete the linked estimates in parallel first; if any fail, abort the
    // lead delete so the cache stays consistent. 404s are treated as success
    // since the row is already gone server-side.
    var estimatePromises = linkedEstimates.map(function(e) {
      return window.agxApi.estimates.remove(e.id).catch(function(err) {
        if (err && err.status === 404) return; // already gone, fine
        throw err;
      });
    });

    Promise.all(estimatePromises).then(function() {
      // Drop from local appData so the estimates list updates without a reload
      if (window.appData && linkedEstimates.length) {
        var deletedIds = {};
        linkedEstimates.forEach(function(e) { deletedIds[e.id] = true; });
        window.appData.estimates = window.appData.estimates.filter(function(e) { return !deletedIds[e.id]; });
        window.appData.estimateLines = (window.appData.estimateLines || []).filter(function(line) { return !deletedIds[line.estimateId]; });
        if (typeof saveData === 'function') saveData();
        if (typeof renderEstimatesList === 'function') renderEstimatesList();
      }
      return window.agxApi.leads.remove(id);
    }).then(function() {
      closeLeadEditorAny();
      reloadLeadsCache();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown error') +
            (linkedEstimates.length ? '\n\nSome linked estimates may have been deleted before the failure. Refresh to check.' : ''));
    });
  }

  // ==================== BT LEADS IMPORT ====================
  // Parses a Buildertrend Leads xlsx export (the "Leads (exported on ...)"
  // file from BT) and POSTs the normalized rows to /api/leads/import. The
  // BT export header is on row 2 (row 1 is the export-date title), so we
  // skip the first row when extracting cells.

  // BT lead status -> our status enum. Anything not listed maps to 'new'.
  var BT_STATUS_MAP = {
    'pending': 'in_progress',
    'open': 'new',
    'new': 'new',
    'sent': 'sent',
    'sold': 'sold',
    'lost': 'lost',
    'no opportunity': 'no_opportunity',
    'closed': 'no_opportunity'
  };

  function mapBTStatus(s) {
    if (!s) return 'new';
    var k = String(s).trim().toLowerCase();
    return BT_STATUS_MAP[k] || 'new';
  }

  // Parse a "$1,234.56" string into a Number, or null. Empty / non-numeric
  // values become null so the server treats the column as unset rather
  // than zero (zero would be a confusing "we estimated $0 revenue").
  function parseMoney(v) {
    if (v == null || v === '') return null;
    var s = String(v).replace(/[\$,\s]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function parseConfidence(v) {
    if (v == null || v === '') return null;
    var s = String(v).replace(/[%\s]/g, '');
    var n = parseInt(s, 10);
    return isNaN(n) ? null : Math.max(0, Math.min(100, n));
  }

  // BT writes dates as "M-D-YYYY" or "M/D/YYYY". Postgres accepts ISO so
  // normalize to YYYY-MM-DD. Return null if unparsable.
  function parseDate(v) {
    if (!v) return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (!m) return null;
    var mm = m[1].padStart(2, '0');
    var dd = m[2].padStart(2, '0');
    var yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
    return yyyy + '-' + mm + '-' + dd;
  }

  function parseBTLeadsWorkbook(arrayBuf) {
    if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
    var data = new Uint8Array(arrayBuf);
    var wb = XLSX.read(data, { type: 'array' });
    var sheet = wb.Sheets[wb.SheetNames[0]];
    var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (!aoa.length) return [];

    // Row 0 is the export title ("Leads (exported on ...)"); row 1 is the
    // header row with column names. Find the header row defensively in case
    // BT shifts the layout — we look for "Opportunity Title" within the
    // first three rows.
    var headerRowIdx = -1;
    for (var i = 0; i < Math.min(3, aoa.length); i++) {
      var rr = aoa[i] || [];
      for (var c = 0; c < rr.length; c++) {
        if (String(rr[c] || '').trim().toLowerCase() === 'opportunity title') {
          headerRowIdx = i;
          break;
        }
      }
      if (headerRowIdx >= 0) break;
    }
    if (headerRowIdx < 0) throw new Error('Could not find header row (no "Opportunity Title" column).');

    var headers = (aoa[headerRowIdx] || []).map(function(h) { return String(h || '').trim(); });
    var idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });

    function cell(row, name) {
      var i = idx[name];
      if (i == null) return '';
      var v = row[i];
      return v == null ? '' : String(v).trim();
    }

    var rows = [];
    for (var r = headerRowIdx + 1; r < aoa.length; r++) {
      var row = aoa[r];
      if (!row || !row.length) continue;
      var title = cell(row, 'Opportunity Title');
      if (!title) continue; // blank row
      // Address: prefer the Opportunity address columns; fall back to
      // Contact when Opp is blank (some BT rows fill only Contact).
      var street = cell(row, 'Street Address(Opp)') || cell(row, 'Street Address (Contact)');
      var city = cell(row, 'City(Opp)') || cell(row, 'City (Contact)');
      var state = cell(row, 'State(Opp)') || cell(row, 'State (Contact)');
      var zip = cell(row, 'Zip(Opp)') || cell(row, 'Zip (Contact)');

      rows.push({
        title: title,
        client_name: cell(row, 'Client Contact'), // resolved server-side
        status: mapBTStatus(cell(row, 'Lead Status')),
        confidence: parseConfidence(cell(row, 'Confidence')),
        estimated_revenue_low: parseMoney(cell(row, 'Estimated Revenue Min')),
        estimated_revenue_high: parseMoney(cell(row, 'Estimated Revenue Max')) || parseMoney(cell(row, 'Estimated Revenue')),
        projected_sale_date: parseDate(cell(row, 'Projected Sales Date')),
        source: cell(row, 'Source'),
        project_type: cell(row, 'Project Type'),
        street_address: street,
        city: city,
        state: state,
        zip: zip,
        gate_code: cell(row, 'Gate Code (if applicable)*') || cell(row, 'Gate Code'),
        market: cell(row, 'Market*') || cell(row, 'Market'),
        notes: cell(row, 'Notes')
      });
    }
    return rows;
  }

  function handleLeadsImportFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    evt.target.value = ''; // reset so re-picking the same file fires onchange

    var reader = new FileReader();
    reader.onload = function(e) {
      var rows;
      try {
        rows = parseBTLeadsWorkbook(e.target.result);
      } catch (err) {
        alert('Could not parse file: ' + err.message);
        return;
      }
      if (!rows.length) {
        alert('No lead rows found in that file. Is it the right export?');
        return;
      }
      if (!confirm('Found ' + rows.length + ' lead row(s). Import them now?\n\n' +
                   'Existing leads (matched by title, case-insensitive) will be skipped. ' +
                   'Clients are matched by name against the directory; unmatched leads import without a client link.')) {
        return;
      }
      window.agxApi.leads.importBatch(rows).then(function(res) {
        renderLeadsImportResult(res);
        reloadLeadsCache();
      }).catch(function(err) {
        alert('Import failed: ' + (err.message || 'unknown error'));
      });
    };
    reader.onerror = function() { alert('Could not read the file.'); };
    reader.readAsArrayBuffer(file);
  }

  // Reuses the same client-import result modal layout. We swap the title and
  // body in place so we don't have to copy a second modal into index.html.
  function renderLeadsImportResult(res) {
    var modal = document.getElementById('clientImportResultModal');
    var titleEl = document.getElementById('clientImportResult_title');
    var body = document.getElementById('clientImportResult_body');
    if (!modal || !body) {
      alert('Imported ' + (res.inserted || 0) + ' lead(s); skipped ' + (res.skipped || 0) + ' duplicate(s).');
      return;
    }
    if (titleEl) titleEl.textContent = 'Lead Import Result';
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
      statBlock('New leads', res.inserted || 0, '#34d399') +
      statBlock('Skipped (duplicate title)', res.skipped || 0, '#fbbf24') +
      statBlock('Errors', (res.errors || []).length, '#f87171') +
      statBlock('Total rows', res.total || 0, 'var(--text-dim,#888)') +
    '</div>';
    var errs = res.errors || [];
    if (errs.length) {
      html += '<div style="font-size:12px;color:#f87171;margin-bottom:6px;font-weight:600;">' + errs.length + ' row(s) had errors:</div>';
      html += '<div style="max-height:160px;overflow-y:auto;font-size:11px;font-family:monospace;background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:8px;">';
      errs.slice(0, 50).forEach(function(e) {
        html += '<div>Row ' + e.row + (e.title ? ' (' + escapeHTML(e.title) + ')' : '') + ': ' + escapeHTML(e.error) + '</div>';
      });
      if (errs.length > 50) html += '<div style="color:var(--text-dim,#888);">…and ' + (errs.length - 50) + ' more</div>';
      html += '</div>';
    }
    body.innerHTML = html;
    openModal('clientImportResultModal');
  }

  function statBlock(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '</div>';
  }

  // ──────────────────────────────────────────────────────────────────
  // Build-from-PDF drop flow on the New Lead modal. User drops a
  // Buildertrend "Lead Print" PDF; we render pages client-side via
  // PDF.js → POST images to /api/ai/extract-lead → prefill the form
  // fields with the structured response. User reviews and saves
  // normally (saves go through the existing submitLeadEditor flow).
  // ──────────────────────────────────────────────────────────────────
  var _pdfDropWired = false;

  function wirePdfDropOnce() {
    if (_pdfDropWired) return;
    var dropZone = document.getElementById('leadEditor_pdfDrop');
    var fileInput = document.getElementById('leadEditor_pdfFile');
    if (!dropZone || !fileInput) return;
    dropZone.onclick = function(e) {
      if (e.target !== fileInput) fileInput.click();
    };
    dropZone.ondragover = function(e) {
      e.preventDefault();
      dropZone.style.borderColor = '#8b5cf6';
      dropZone.style.background = 'rgba(139,92,246,0.12)';
    };
    dropZone.ondragleave = function() {
      dropZone.style.borderColor = '';
      dropZone.style.background = '';
    };
    dropZone.ondrop = function(e) {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.background = '';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handlePdfDrop(e.dataTransfer.files[0]);
      }
    };
    fileInput.onchange = function() {
      if (fileInput.files && fileInput.files[0]) handlePdfDrop(fileInput.files[0]);
      fileInput.value = '';
    };
    _pdfDropWired = true;
  }

  function setPdfStatus(message, color) {
    var s = document.getElementById('leadEditor_pdfDropStatus');
    if (!s) return;
    s.style.display = '';
    s.textContent = message;
    s.style.color = color || '#c4b5fd';
  }

  function handlePdfDrop(file) {
    if (!file) return;
    var name = (file.name || '').toLowerCase();
    if (file.type !== 'application/pdf' && !name.endsWith('.pdf')) {
      setPdfStatus('Not a PDF — drop a Buildertrend Lead Print.', '#f87171');
      return;
    }
    if (!window.pdfjsLib) {
      setPdfStatus('PDF library not loaded — refresh the page.', '#f87171');
      return;
    }

    setPdfStatus('Reading PDF…');
    var reader = new FileReader();
    reader.onload = function(e) {
      var typedArray = new Uint8Array(e.target.result);
      window.pdfjsLib.getDocument({ data: typedArray }).promise.then(function(pdf) {
        return renderPdfPagesToBase64(pdf);
      }).then(function(images) {
        setPdfStatus('Extracting fields with AI… (' + images.length + ' page' + (images.length === 1 ? '' : 's') + ')');
        return window.agxApi.ai.extractLead(images);
      }).then(function(res) {
        if (!res || !res.lead) throw new Error('Empty response from AI.');
        prefillFromExtractedLead(res.lead);
        setPdfStatus('✓ Fields prefilled from PDF — review and save below.', '#34d399');
      }).catch(function(err) {
        console.error('PDF extraction failed:', err);
        setPdfStatus('Extraction failed: ' + (err.message || err), '#f87171');
      });
    };
    reader.onerror = function() {
      setPdfStatus('Could not read the file.', '#f87171');
    };
    reader.readAsArrayBuffer(file);
  }

  // Render every page of the loaded PDF to a base64 JPEG. Capped at 6
  // since lead prints are usually 1-2 pages and we want to leave room
  // under Anthropic's per-request image limit.
  function renderPdfPagesToBase64(pdf) {
    var max = Math.min(pdf.numPages, 6);
    var chain = Promise.resolve();
    var images = [];
    for (var i = 1; i <= max; i++) {
      (function(pageNum) {
        chain = chain.then(function() {
          return pdf.getPage(pageNum).then(function(page) {
            var viewport = page.getViewport({ scale: 1.5 });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function() {
              var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
              images.push(dataUrl);
            });
          });
        });
      })(i);
    }
    return chain.then(function() { return images; });
  }

  // Take the AI's structured response and stuff each field into the
  // form. We map the response keys to the form-field IDs the existing
  // submitLeadEditor / save flow already uses, so the user can just
  // hit Save to commit.
  function prefillFromExtractedLead(lead) {
    if (!lead) return;
    if (lead.title) setField('title', lead.title);
    if (lead.status) setField('status', lead.status);
    // Estimated revenue: AGX-side only uses the min/low value — display
    // a single number on our forms. The schema asks for both, but we
    // ignore the high.
    if (lead.estimated_revenue_low) setField('estimated_revenue_low', lead.estimated_revenue_low);
    if (lead.confidence_pct != null) setField('confidence', lead.confidence_pct);
    if (lead.project_type) setField('project_type', lead.project_type);
    if (lead.market) setField('market', lead.market);
    if (lead.gate_code) setField('gate_code', lead.gate_code);
    if (lead.notes) setField('notes', lead.notes);
    if (lead.property_name) setField('property_name', lead.property_name);
    // Property/job-site address goes onto the lead's address fields
    if (lead.property_address) setField('street_address', lead.property_address);
    if (lead.property_city) setField('city', lead.property_city);
    if (lead.property_state) setField('state', lead.property_state);
    if (lead.property_zip) setField('zip', lead.property_zip);

    // Auto-link a client from the directory cache. Multi-tier match
    // because PAC's directory has dozens of children ("PAC - Solace
    // Timacuan", "PAC - Alyssa Barber", etc.) — a naive substring
    // search on the parent name "PAC" picked the first child it
    // found, which is wrong. Priority order:
    //   1. Exact full-name match ("PAC - Solace Timacuan")
    //   2. Property-side match — when the PDF gave both halves,
    //      look for a client whose community_name (or name suffix)
    //      matches the property side AND whose parent / company
    //      matches the company side
    //   3. Substring fallback ONLY if it produces a UNIQUE match.
    //      Multiple matches → leave unset; user picks manually.
    if (lead.client_company || lead.client_property) {
      var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
      var company = String(lead.client_company || '').trim();
      var property = String(lead.client_property || '').trim();
      var lowerCompany = company.toLowerCase();
      var lowerProperty = property.toLowerCase();
      var fullNeedle = (company && property)
        ? (company + ' - ' + property).toLowerCase()
        : (company || property).toLowerCase();

      // Tier 1 — exact full-name match. Catches the canonical
      // "PAC - Solace Timacuan" case directly.
      var match = clients.find(function(c) {
        return (c.name || '').toLowerCase() === fullNeedle;
      });

      // Tier 2 — property-name match within the right parent. Looks
      // at community_name AND the suffix after " - " in the client
      // name. Only fires when the AI extracted both halves.
      if (!match && property) {
        match = clients.find(function(c) {
          var cn = (c.community_name || '').toLowerCase();
          var nm = (c.name || '').toLowerCase();
          var dashIdx = nm.indexOf(' - ');
          var nameSuffix = dashIdx >= 0 ? nm.slice(dashIdx + 3) : '';
          var propMatches = (cn && cn === lowerProperty) || (nameSuffix && nameSuffix === lowerProperty);
          if (!propMatches) return false;
          if (!company) return true; // no parent to filter against
          var co = (c.company_name || '').toLowerCase();
          var nameStart = dashIdx >= 0 ? nm.slice(0, dashIdx) : nm;
          return co === lowerCompany || nameStart === lowerCompany ||
                 co.indexOf(lowerCompany) >= 0 || nameStart.indexOf(lowerCompany) >= 0;
        });
      }

      // Tier 3 — substring fallback. Require uniqueness so we don't
      // arbitrarily pick the first of N matches. This is the path
      // the old buggy code took without the uniqueness check.
      if (!match && fullNeedle && fullNeedle.length >= 3) {
        var hits = clients.filter(function(c) {
          var nm = (c.name || '').toLowerCase();
          var co = (c.company_name || '').toLowerCase();
          return nm.indexOf(fullNeedle) >= 0 || co.indexOf(fullNeedle) >= 0;
        });
        if (hits.length === 1) match = hits[0];
        // Multiple ambiguous hits → leave the picker empty so the
        // user resolves it. Logging the count helps debugging without
        // adding more UI noise.
        else if (hits.length > 1) {
          try { console.info('[leads] ambiguous client match for "' + fullNeedle + '" — ' + hits.length + ' candidates; leaving picker empty for user to choose'); } catch (e) {}
        }
      }

      if (match) {
        var sel = document.getElementById('leadEditor_client_id');
        if (sel) {
          sel.value = match.id;
          // Force a change event so the searchable picker widget refreshes
          // its trigger label and the existing onLeadClientPicked() handler
          // runs through to fill the address fields from the matched client.
          try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore old browsers */ }
        }
      }
    }
  }

  window.renderLeadsList = renderLeadsList;
  window.sortLeadsBy = sortLeads;
  window.reloadLeadsCache = reloadLeadsCache;
  window.openNewLeadModal = openNewLeadModal;
  window.openEditLeadModal = openEditLeadModal;
  window.submitLeadEditor = submitLeadEditor;
  window.deleteLeadFromEditor = deleteLeadFromEditor;
  window.onLeadClientPicked = onLeadClientPicked;
  window.switchLeadEditorTab = switchLeadEditorTab;
  window.createEstimateFromLead = createEstimateFromLead;
  window.convertLeadToJob = convertLeadToJob;
  window.openLinkedJobFromLead = openLinkedJobFromLead;
  window.handleLeadsImportFile = handleLeadsImportFile;
  window.agxLeads = {
    getCached: function() { return _leads.slice(); },
    reload: reloadLeadsCache,
    // Push a single fetched lead into the cache. Used by the estimate
    // editor's chip when it has to fetch by id (lead wasn't loaded
    // yet). Replaces an existing entry by id, or appends.
    cacheLead: function(lead) {
      if (!lead || !lead.id) return;
      var idx = _leads.findIndex(function(x) { return x.id === lead.id; });
      if (idx >= 0) _leads[idx] = lead;
      else _leads.push(lead);
    }
  };
})();
