// AGX Clients module — directory rendered on the Estimates tab.
//
// First pass: read-only list with parent/child grouping (HOA-style hierarchies
// where one property-management firm has many managed properties). Create /
// edit modal and the Buildertrend xlsx import land in the next commit.
(function() {
  'use strict';

  // Local cache of the last-fetched client list so the search box can filter
  // without re-fetching, and so other modules (estimates form dropdown later)
  // can read without an extra API call.
  var _clients = [];

  function escapeAttr(v) { return escapeHTML(v == null ? '' : String(v)); }

  // Toggle which Estimates sub-tab is visible. Renders the section's data
  // on first reveal so we don't fire API calls for tabs no one opens.
  function switchEstimatesSubTab(name) {
    document.querySelectorAll('[data-estimates-subtab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.estimatesSubtab === name);
    });
    document.querySelectorAll('.estimates-subtab-content').forEach(function(c) {
      c.style.display = 'none';
    });
    var target = document.getElementById('estimates-subtab-' + name);
    if (target) target.style.display = '';
    if (name === 'list' && typeof renderEstimatesList === 'function') renderEstimatesList();
    else if (name === 'clients') renderClientsList();
  }

  // Group clients by parent so the list renders top-level firms with their
  // managed sub-properties indented underneath. Orphans (clients with a
  // parent_client_id pointing nowhere) get bubbled up to top-level so they
  // remain visible even if data is inconsistent.
  function groupForRender(clients) {
    var byId = {};
    clients.forEach(function(c) { byId[c.id] = c; });
    var topLevel = [];
    var childrenOf = {};
    clients.forEach(function(c) {
      if (c.parent_client_id && byId[c.parent_client_id]) {
        if (!childrenOf[c.parent_client_id]) childrenOf[c.parent_client_id] = [];
        childrenOf[c.parent_client_id].push(c);
      } else {
        topLevel.push(c);
      }
    });
    // Stable alpha sort within each level
    topLevel.sort(byName);
    Object.keys(childrenOf).forEach(function(k) { childrenOf[k].sort(byName); });
    return { topLevel: topLevel, childrenOf: childrenOf };
  }
  function byName(a, b) {
    return (a.name || '').localeCompare(b.name || '');
  }

  function clientCardHTML(c, depth) {
    var indent = depth ? 'margin-left:' + (depth * 18) + 'px;' : '';
    var statusBadge = c.activation_status === 'inactive'
      ? '<span style="padding:2px 8px;border-radius:10px;background:rgba(248,113,113,0.12);color:#f87171;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;margin-left:8px;">Inactive</span>'
      : '';
    var locationBits = [c.city, c.state].filter(Boolean).join(', ');
    var contactLine = [c.first_name, c.last_name].filter(Boolean).join(' ');
    var contactBits = [contactLine, c.email, c.phone || c.cell].filter(Boolean).join(' · ');
    var company = c.company_name && c.company_name !== c.name
      ? '<span style="font-size:11px;color:var(--text-dim,#888);margin-left:8px;">' + escapeHTML(c.company_name) + '</span>'
      : '';
    return '<div class="card" style="padding:10px 14px;display:flex;justify-content:space-between;align-items:center;gap:10px;' + indent + '">' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<strong style="color:var(--text,#fff);font-size:13px;">' + escapeHTML(c.name) + '</strong>' +
          company +
          statusBadge +
        '</div>' +
        (contactBits || locationBits
          ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">' +
              [contactBits, locationBits].filter(Boolean).join(' · ') +
            '</div>'
          : '') +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button class="small secondary" onclick="openEditClientModal(\'' + escapeAttr(c.id) + '\')">Edit</button>' +
      '</div>' +
    '</div>';
  }

  function matchesSearch(c, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [
      c.name, c.company_name, c.community_name,
      c.first_name, c.last_name, c.email,
      c.city, c.state,
      c.phone, c.cell,
      c.community_manager, c.maintenance_manager,
      c.market
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  function renderClientsList() {
    var listEl = document.getElementById('clients-list');
    var summaryEl = document.getElementById('clients-summary');
    if (!listEl) return;
    var searchEl = document.getElementById('clients-search');
    var q = searchEl ? searchEl.value.trim() : '';

    if (!_clients.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading clients…</div>';
      window.agxApi.clients.list().then(function(res) {
        _clients = res.clients || [];
        renderClientsList();
      }).catch(function(err) {
        listEl.innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center;">Failed to load clients: ' + escapeHTML(err.message) + '</div>';
      });
      return;
    }

    var filtered = _clients.filter(function(c) { return matchesSearch(c, q); });
    if (summaryEl) {
      summaryEl.textContent = q
        ? 'Showing ' + filtered.length + ' of ' + _clients.length + ' clients'
        : _clients.length + ' clients in directory';
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">' +
        (q ? 'No clients match "' + escapeHTML(q) + '"' : 'No clients yet. Click + New Client to add one.') +
        '</div>';
      return;
    }

    // Render parent/child structure (top-level firms with their managed
    // sub-properties indented). When searching, flatten to a single list so
    // a hit doesn't disappear because its parent didn't match.
    var html = '';
    if (q) {
      filtered.forEach(function(c) { html += clientCardHTML(c, 0); });
    } else {
      var grouped = groupForRender(filtered);
      grouped.topLevel.forEach(function(parent) {
        html += clientCardHTML(parent, 0);
        var kids = grouped.childrenOf[parent.id] || [];
        kids.forEach(function(child) { html += clientCardHTML(child, 1); });
      });
    }
    listEl.innerHTML = html;
  }

  // Field list mirrors the server's EDITABLE_FIELDS in client-routes.js.
  // Used to clear the form on open and to read it back on submit.
  var EDITABLE_FIELDS = [
    'name', 'client_type', 'activation_status',
    'first_name', 'last_name', 'email',
    'phone', 'cell',
    'address', 'city', 'state', 'zip',
    'company_name', 'community_name', 'market',
    'property_address', 'property_phone', 'website',
    'gate_code', 'additional_pocs',
    'community_manager', 'cm_email', 'cm_phone',
    'maintenance_manager', 'mm_email', 'mm_phone',
    'notes'
  ];

  // Repopulate the parent dropdown from the cache. excludeId hides the
  // current client (so it can't pick itself) and any of its descendants
  // (so we don't create cycles). Descendant detection is a single BFS.
  function populateParentSelect(currentId, currentParentId) {
    var sel = document.getElementById('clientEditor_parent_client_id');
    if (!sel) return;
    var disallowed = {};
    if (currentId) {
      disallowed[currentId] = true;
      // Walk the children-of-children to also block descendants
      var queue = [currentId];
      while (queue.length) {
        var head = queue.shift();
        _clients.forEach(function(c) {
          if (c.parent_client_id === head && !disallowed[c.id]) {
            disallowed[c.id] = true;
            queue.push(c.id);
          }
        });
      }
    }
    var options = '<option value="">— None (top-level) —</option>';
    _clients
      .slice()
      .sort(byName)
      .forEach(function(c) {
        if (disallowed[c.id]) return;
        var sel = (c.id === currentParentId) ? ' selected' : '';
        options += '<option value="' + escapeAttr(c.id) + '"' + sel + '>' +
          escapeHTML(c.name) +
          (c.company_name && c.company_name !== c.name ? ' — ' + escapeHTML(c.company_name) : '') +
        '</option>';
      });
    sel.innerHTML = options;
  }

  function setEditorField(name, value) {
    var el = document.getElementById('clientEditor_' + name);
    if (el) el.value = (value == null ? '' : value);
  }
  function getEditorField(name) {
    var el = document.getElementById('clientEditor_' + name);
    return el ? el.value : '';
  }

  function clearEditor() {
    EDITABLE_FIELDS.forEach(function(f) { setEditorField(f, ''); });
    setEditorField('activation_status', 'active');
    document.getElementById('clientEditor_id').value = '';
    document.getElementById('clientEditor_status').textContent = '';
    document.getElementById('clientEditor_submitBtn').disabled = false;
    document.getElementById('clientEditor_deleteBtn').style.display = 'none';
  }

  // Make sure the cache is populated before opening the modal so the
  // parent dropdown isn't empty on first use.
  function ensureClientsCache() {
    if (_clients.length) return Promise.resolve(_clients);
    return window.agxApi.clients.list().then(function(res) {
      _clients = res.clients || [];
      return _clients;
    });
  }

  function openNewClientModal() {
    ensureClientsCache().then(function() {
      clearEditor();
      document.getElementById('clientEditor_title').textContent = 'New Client';
      populateParentSelect(null, null);
      openModal('clientEditorModal');
    });
  }

  function openEditClientModal(id) {
    ensureClientsCache().then(function() {
      var c = _clients.find(function(x) { return x.id === id; });
      if (!c) {
        alert('Client not found in cache. Try Refresh.');
        return;
      }
      clearEditor();
      document.getElementById('clientEditor_title').textContent = 'Edit Client: ' + c.name;
      document.getElementById('clientEditor_id').value = c.id;
      EDITABLE_FIELDS.forEach(function(f) { setEditorField(f, c[f]); });
      populateParentSelect(c.id, c.parent_client_id);
      document.getElementById('clientEditor_deleteBtn').style.display = '';
      openModal('clientEditorModal');
    });
  }

  function submitClientEditor() {
    var statusEl = document.getElementById('clientEditor_status');
    var btn = document.getElementById('clientEditor_submitBtn');
    var id = document.getElementById('clientEditor_id').value;
    var payload = {};
    EDITABLE_FIELDS.forEach(function(f) {
      var v = getEditorField(f);
      if (v !== '') payload[f] = v;
      // Always include name + activation_status even if empty so explicit
      // saves clear them server-side rather than treating them as no-op
      else if (f === 'name' || f === 'activation_status') payload[f] = v;
    });
    payload.parent_client_id = getEditorField('parent_client_id') || null;

    if (!payload.name) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Name is required.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    var p = id
      ? window.agxApi.clients.update(id, payload)
      : window.agxApi.clients.create(payload);

    p.then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      setTimeout(function() {
        closeModal('clientEditorModal');
        reloadClientsCache();
      }, 600);
    }).catch(function(err) {
      btn.disabled = false;
      statusEl.style.color = '#e74c3c';
      statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
  }

  function deleteClientFromEditor() {
    var id = document.getElementById('clientEditor_id').value;
    if (!id) return;
    var c = _clients.find(function(x) { return x.id === id; });
    var name = c ? c.name : 'this client';
    var children = _clients.filter(function(x) { return x.parent_client_id === id; });
    var msg = 'Delete "' + name + '"?';
    if (children.length) {
      msg += '\n\n' + children.length + ' sub-' + (children.length === 1 ? 'property' : 'properties') +
             ' will become top-level (parent link cleared).';
    }
    msg += '\n\nThis cannot be undone.';
    if (!confirm(msg)) return;
    window.agxApi.clients.remove(id).then(function() {
      closeModal('clientEditorModal');
      reloadClientsCache();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown error'));
    });
  }

  // Force-reload from server. Used by the Refresh button and after every
  // create/edit/delete/import operation that mutates the directory.
  function reloadClientsCache() {
    _clients = [];
    renderClientsList();
  }

  // ==================== BUILDERTREND IMPORT ====================
  // Maps the BT export column headers to our DB column names. The asterisks
  // in BT custom-field names get stripped before lookup, and the comparison
  // is case-insensitive — so "Cm Email*" or "CM EMAIL*" both work.
  var BT_HEADER_MAP = {
    'name': 'name',
    'activation status': 'activation_status',
    'phone': 'phone',
    'cell': 'cell',
    'address': 'address',
    'city': 'city',
    'state': 'state',
    'zip': 'zip',
    'email': 'email',
    'first name': 'first_name',
    'last name': 'last_name',
    'gate code/addtl notes': 'gate_code',
    'additional pocs': 'additional_pocs',
    'cm direct phone': 'cm_phone',
    'cm email': 'cm_email',
    'community manager/cam': 'community_manager',
    'community name': 'community_name',
    'company name': 'company_name',
    'maintenance manager': 'maintenance_manager',
    'market': 'market',
    'mm direct phone': 'mm_phone',
    'mm email': 'mm_email',
    'property address': 'property_address',
    'property phone': 'property_phone',
    'website': 'website'
    // Note: Jobs and Lead Opportunities are computed counts in BT — we skip them
  };

  function normalizeHeader(h) {
    return String(h || '').replace(/\*/g, '').trim().toLowerCase();
  }

  // Parse a Buildertrend Client Contacts xlsx file (browser-side via SheetJS)
  // and return a normalized array of {column_name: value} ready to POST. The
  // first sheet is used; the first non-empty header row is detected
  // automatically (BT puts a "Client Contacts (exported on …)" title row above
  // the actual headers).
  function parseBTWorkbook(arrayBuffer) {
    if (typeof window.XLSX === 'undefined') {
      throw new Error('XLSX library not loaded yet — try again in a moment.');
    }
    var wb = window.XLSX.read(arrayBuffer, { type: 'array' });
    var sheet = wb.Sheets[wb.SheetNames[0]];
    var aoa = window.XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });
    if (!aoa.length) return [];

    // Find the header row — the first row where 'Name' appears as a cell.
    var headerRowIdx = -1;
    for (var i = 0; i < Math.min(aoa.length, 10); i++) {
      var row = aoa[i] || [];
      for (var j = 0; j < row.length; j++) {
        if (normalizeHeader(row[j]) === 'name') { headerRowIdx = i; break; }
      }
      if (headerRowIdx !== -1) break;
    }
    if (headerRowIdx === -1) {
      throw new Error('Could not find a Name column in the spreadsheet.');
    }

    // Map column index -> our DB column name
    var headers = aoa[headerRowIdx];
    var colMap = {};
    headers.forEach(function(h, idx) {
      var key = BT_HEADER_MAP[normalizeHeader(h)];
      if (key) colMap[idx] = key;
    });

    var rows = [];
    for (var r = headerRowIdx + 1; r < aoa.length; r++) {
      var raw = aoa[r] || [];
      var obj = {};
      var hasContent = false;
      Object.keys(colMap).forEach(function(idx) {
        var v = raw[idx];
        if (v != null && String(v).trim() !== '') {
          obj[colMap[idx]] = String(v).trim();
          hasContent = true;
        }
      });
      if (hasContent) rows.push(obj);
    }
    return rows;
  }

  function handleClientsImportFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    // Reset the input so picking the same file twice still fires onchange
    evt.target.value = '';

    var reader = new FileReader();
    reader.onload = function(e) {
      var rows;
      try {
        rows = parseBTWorkbook(e.target.result);
      } catch (err) {
        alert('Could not parse file: ' + err.message);
        return;
      }
      if (!rows.length) {
        alert('No client rows found in that file. Is it the right export?');
        return;
      }
      if (!confirm('Found ' + rows.length + ' client rows. Import them now?\n\n' +
                   'Existing clients (matched by name, case-insensitive) will be updated. ' +
                   'New clients will be created. Parents are auto-created from Company Name when needed.')) {
        return;
      }
      window.agxApi.clients.importBatch(rows).then(function(res) {
        renderImportResult(res);
        reloadClientsCache();
      }).catch(function(err) {
        alert('Import failed: ' + (err.message || 'unknown error'));
      });
    };
    reader.onerror = function() { alert('Could not read the file.'); };
    reader.readAsArrayBuffer(file);
  }

  function renderImportResult(res) {
    var body = document.getElementById('clientImportResult_body');
    var lines = [
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
        statBlock('New clients', res.inserted || 0, '#34d399') +
        statBlock('Updated', res.updated || 0, '#4f8cff') +
        statBlock('Parent firms created', res.parentsCreated || 0, '#fbbf24') +
        statBlock('Total rows', res.total || 0, 'var(--text-dim,#888)') +
      '</div>'
    ];
    var errs = res.errors || [];
    if (errs.length) {
      lines.push('<div style="font-size:12px;color:#f87171;margin-bottom:6px;font-weight:600;">' +
        errs.length + ' row(s) had errors:</div>');
      lines.push('<div style="max-height:160px;overflow-y:auto;font-size:11px;font-family:monospace;background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:8px;">');
      errs.slice(0, 50).forEach(function(e) {
        lines.push('<div>Row ' + e.row + (e.name ? ' (' + escapeHTML(e.name) + ')' : '') + ': ' + escapeHTML(e.error) + '</div>');
      });
      if (errs.length > 50) lines.push('<div style="color:var(--text-dim,#888);">…and ' + (errs.length - 50) + ' more</div>');
      lines.push('</div>');
    } else {
      lines.push('<div style="font-size:12px;color:#34d399;">No errors.</div>');
    }
    body.innerHTML = lines.join('');
    openModal('clientImportResultModal');
  }

  function statBlock(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '</div>';
  }

  // Hook the Refresh button: clear cache then re-render so it actually
  // refetches instead of showing stale data.
  document.addEventListener('DOMContentLoaded', function() {
    var refreshBtn = document.querySelector('#estimates-subtab-clients .action-buttons button.secondary');
    // Refresh is wired via inline onclick=renderClientsList(); for full
    // refetch we expose reloadClientsCache too — both behaviors land in
    // the create/edit commit when the data starts mutating.
    void refreshBtn;
  });

  window.switchEstimatesSubTab = switchEstimatesSubTab;
  window.renderClientsList = renderClientsList;
  window.openNewClientModal = openNewClientModal;
  window.openEditClientModal = openEditClientModal;
  window.submitClientEditor = submitClientEditor;
  window.deleteClientFromEditor = deleteClientFromEditor;
  window.reloadClientsCache = reloadClientsCache;
  window.handleClientsImportFile = handleClientsImportFile;
  window.agxClients = {
    getCached: function() { return _clients.slice(); },
    reload: reloadClientsCache
  };
})();
