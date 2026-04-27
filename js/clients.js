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

  // Placeholders — modal lives in the next commit. Keep callable so the
  // buttons don't throw when clicked early.
  function openNewClientModal() {
    alert('Client create form coming in the next commit. The directory is read-only for now.');
  }
  function openEditClientModal(id) {
    alert('Client edit coming in the next commit. (id: ' + id + ')');
  }

  // Force-reload from server. Used by the Refresh button and after future
  // create/edit/import operations.
  function reloadClientsCache() {
    _clients = [];
    renderClientsList();
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
  window.reloadClientsCache = reloadClientsCache;
  window.agxClients = {
    getCached: function() { return _clients.slice(); },
    reload: reloadClientsCache
  };
})();
