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
  function fmtRevenueRange(low, high) {
    if (low == null && high == null) return '';
    if (low != null && high != null && Number(low) !== Number(high)) {
      return fmtCurrencyShort(low) + '–' + fmtCurrencyShort(high);
    }
    return fmtCurrencyShort(low != null ? low : high);
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

  function leadCardHTML(l) {
    var sm = statusMeta(l.status);
    var statusPill =
      '<span style="padding:2px 10px;border-radius:10px;background:' + sm.bg + ';color:' + sm.color +
      ';font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' +
      escapeHTML(sm.label) + '</span>';
    var clientLine = l.client_name
      ? escapeHTML(l.client_name) + (l.client_company && l.client_company !== l.client_name ? ' · ' + escapeHTML(l.client_company) : '')
      : '<span style="color:var(--text-dim,#888);font-style:italic;">No client linked</span>';
    var revenue = fmtRevenueRange(l.estimated_revenue_low, l.estimated_revenue_high);
    var meta = [];
    if (l.salesperson_name) meta.push(escapeHTML(l.salesperson_name));
    if (l.projected_sale_date) meta.push('Target ' + fmtDate(l.projected_sale_date));
    if (l.confidence != null && l.confidence > 0) meta.push(l.confidence + '% conf');
    if (revenue) meta.push(revenue);
    return '<div class="card" style="padding:12px 16px;cursor:pointer;display:flex;justify-content:space-between;align-items:center;gap:14px;" onclick="openEditLeadModal(\'' + escapeAttr(l.id) + '\')">' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:3px;">' +
          '<strong style="color:var(--text,#fff);font-size:14px;">' + escapeHTML(l.title) + '</strong>' +
          statusPill +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#888);">' + clientLine + '</div>' +
        (meta.length ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">' + meta.join(' · ') + '</div>' : '') +
      '</div>' +
      '<div style="font-size:10px;color:var(--text-dim,#666);text-align:right;flex-shrink:0;">' + fmtDate(l.created_at) + '</div>' +
    '</div>';
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
    listEl.innerHTML = filtered.map(leadCardHTML).join('');
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
  }

  // Reuse the clients cache (loaded by clients.js) so we don't hit the API
  // again. Falls back to a fetch if the cache is empty (e.g. user opens
  // the Lead modal before they've ever opened the Clients tab).
  function populateClientSelect(currentClientId) {
    var sel = document.getElementById('leadEditor_client_id');
    if (!sel) return;
    var fillFrom = function(clients) {
      var html = '<option value="">— Select a client —</option>';
      clients.slice().sort(function(a, b) {
        return (a.name || '').localeCompare(b.name || '');
      }).forEach(function(c) {
        var selAttr = c.id === currentClientId ? ' selected' : '';
        var label = c.name;
        if (c.community_name && c.community_name !== c.name) {
          label = c.community_name + ' — ' + c.name;
        } else if (c.company_name && c.company_name !== c.name) {
          label += ' (' + c.company_name + ')';
        }
        html += '<option value="' + escapeAttr(c.id) + '"' + selAttr + '>' + escapeHTML(label) + '</option>';
      });
      sel.innerHTML = html;
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
    // Edit mode shows the General | Proposals tab nav. Default to General;
    // user clicks Proposals to see the linked estimates.
    document.getElementById('leadEditor_tabs').style.display = '';
    switchLeadEditorTab('general');
    renderLeadProposals(l.id);
    openModal('leadEditorModal');
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
    // The footer Save / Delete buttons only make sense on the General tab.
    // On the Proposals tab they'd be confusing (the estimates have their
    // own save flow). Hide them when Proposals is active.
    var footer = document.querySelector('#leadEditorModal .modal-footer');
    if (footer) footer.style.display = (name === 'proposals') ? 'none' : '';
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
        'No estimates yet. Click <strong>+ New Estimate from Lead</strong> to draft the first proposal.' +
      '</div>';
      return;
    }
    listEl.innerHTML = linked.map(proposalRowHTML).join('');
  }

  function proposalRowHTML(est) {
    var lines = ((window.appData && appData.estimateLines) || []).filter(function(l) { return l.estimateId === est.id; });
    var baseCost = lines.reduce(function(s, l) { return s + (Number(l.qty) || 0) * (Number(l.unitCost) || 0); }, 0);
    var clientPrice = baseCost * (1 + (Number(est.defaultMarkup) || 0) / 100);
    return '<div class="card" style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="font-weight:600;font-size:13px;color:var(--text,#fff);">' + escapeHTML(est.title || 'Untitled estimate') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">' +
          'Base ' + fmtCurrencyShort(baseCost) +
          ' · Markup ' + (Number(est.defaultMarkup) || 0) + '%' +
          ' · Client ' + fmtCurrencyShort(clientPrice) +
          ' · ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button class="small secondary" onclick="closeModal(\'leadEditorModal\');editEstimate(\'' + escapeAttr(est.id) + '\');">Edit</button>' +
        '<button class="small secondary" onclick="closeModal(\'leadEditorModal\');previewEstimate(\'' + escapeAttr(est.id) + '\');">Preview</button>' +
      '</div>' +
    '</div>';
  }

  // Pre-fill the New Estimate form from the currently-editing lead, then
  // open it. The estimate save path (createNewEstimate) reads the hidden
  // estLeadId / estClientId fields to persist the link.
  function createEstimateFromLead() {
    var leadId = _currentEditingLeadId;
    if (!leadId) { alert('Save the lead first.'); return; }
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l) { alert('Lead not found.'); return; }
    // Resolve the linked client (if any) so we can pull manager / address fields
    var clientCache = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
    var c = l.client_id ? clientCache.find(function(x) { return x.id === l.client_id; }) : null;

    closeModal('leadEditorModal');
    if (typeof window.openNewEstimateForm !== 'function') {
      alert('Estimate form not available.');
      return;
    }
    window.openNewEstimateForm();

    function set(id, v) {
      var el = document.getElementById(id);
      if (el && v != null) el.value = v;
    }
    set('estTitle', l.title || '');
    set('estJobType', l.project_type || '');
    set('estLeadId', l.id);
    set('estClientId', l.client_id || '');
    if (c) {
      set('estClient', c.company_name || c.name || '');
      set('estCommunity', c.community_name || c.name || '');
      var pAddr = [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      var bAddr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      set('estPropertyAddr', pAddr);
      set('estBillingAddr', bAddr);
      set('estManagerName', c.community_manager || '');
      set('estManagerEmail', c.cm_email || c.email || '');
      set('estManagerPhone', c.cm_phone || c.phone || c.cell || '');
      // Reflect the picked client in the dropdown so it shows the right name
      var picker = document.getElementById('estClientPicker');
      if (picker) picker.value = c.id;
    }
    // Lead's project address overrides the client mailing address for the
    // property field if the lead has its own street_address.
    if (l.street_address) {
      var leadAddr = [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', ');
      set('estPropertyAddr', leadAddr);
    }
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
        closeModal('leadEditorModal');
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
    if (!confirm('Delete lead "' + (l ? l.title : id) + '"? This cannot be undone.')) return;
    window.agxApi.leads.remove(id).then(function() {
      closeModal('leadEditorModal');
      reloadLeadsCache();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown error'));
    });
  }

  window.renderLeadsList = renderLeadsList;
  window.reloadLeadsCache = reloadLeadsCache;
  window.openNewLeadModal = openNewLeadModal;
  window.openEditLeadModal = openEditLeadModal;
  window.submitLeadEditor = submitLeadEditor;
  window.deleteLeadFromEditor = deleteLeadFromEditor;
  window.onLeadClientPicked = onLeadClientPicked;
  window.switchLeadEditorTab = switchLeadEditorTab;
  window.createEstimateFromLead = createEstimateFromLead;
  window.agxLeads = {
    getCached: function() { return _leads.slice(); },
    reload: reloadLeadsCache
  };
})();
