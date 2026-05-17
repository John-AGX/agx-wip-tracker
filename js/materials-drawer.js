// Materials Catalog Drawer (Phase 1) — click-driven search + single-add
// for estimate line items. Spec lives in
// /mnt/session/outputs/materials-catalog-drawer-spec.md.
//
// Phase 1 scope:
//   - Right-side drawer (480px desktop, full-width on mobile in Phase 4)
//   - Search input (debounced) + subgroup filter chips
//   - Result rows with description, unit, last price, last-seen, count
//   - "Already on estimate" indicator (computed client-side from
//     appData.estimateLines)
//   - Inline single-add form per row → calls
//     window.estimateEditorAPI.applyAddLineItem (same code path
//     86 hits via propose_add_line_item)
//
// Phases 2-4 layer on favorites, recently-used, bulk, polish.

(function() {
  'use strict';

  var DRAWER_ID = 'materials-drawer-root';
  var TOGGLE_KEY = 'p86-materials-drawer-open';
  var SEARCH_DEBOUNCE_MS = 250;

  var _drawerEl = null;
  var _isOpen = false;
  var _searchTimer = null;
  var _lastResults = [];
  var _expandedRowId = null; // material_id of the row whose inline-add form is open
  var _activeSubgroup = 'materials'; // default filter chip
  var _favoritesOnly = false; // Phase 2 — Favorites filter chip toggle

  // Subgroup chips — the catalog's agx_subgroup column holds these
  // values. Defaults to 'materials' since that's 95%+ of catalog rows
  // and matches the spec's "drawer's job is to expose what AGX has
  // bought, primarily materials."
  var SUBGROUPS = [
    { value: 'materials', label: 'Materials' },
    { value: 'labor',     label: 'Labor' },
    { value: 'gc',        label: 'GC' },
    { value: 'sub',       label: 'Subs' }
  ];

  // Subgroup → section_name string the existing applyAddLineItem
  // expects. Matches the four standard subgroups the editor seeds
  // on every new group (see STANDARD_SECTIONS_PRESET in
  // estimate-editor.js).
  var SUBGROUP_TO_SECTION = {
    materials: 'Materials & Supplies',
    labor:     'Direct Labor',
    gc:        'General Conditions',
    sub:       'Subcontractors'
  };

  function fmtMoney(n) {
    if (n == null || isNaN(n)) return '—';
    return '$' + Number(n).toFixed(2);
  }

  function fmtDate(s) {
    if (!s) return 'never';
    return String(s).slice(0, 10);
  }

  function escapeHTML(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ──────────────────────────────────────────────────────────────────
  // "Already on estimate" computation. Client-side only — the open
  // estimate's lines live in window.appData.estimateLines, so we
  // don't need a server round-trip. Returns null when no match, or
  // { groupName, sectionName, qty } when this material is already on
  // the estimate. Match key: sourceMaterialId (preferred) or
  // normalized description.
  // ──────────────────────────────────────────────────────────────────
  function findOnEstimate(material) {
    if (!window.appData || !window.estimateEditorAPI) return null;
    var openId = window.estimateEditorAPI.getOpenId &&
      window.estimateEditorAPI.getOpenId();
    if (!openId) return null;
    var lines = (window.appData.estimateLines || []).filter(function(l) {
      return l.estimateId === openId && l.section !== '__section_header__';
    });
    var matKey = material.id;
    var descKey = String(material.description || '').toLowerCase().replace(/\s+/g, ' ').trim();
    var qty = 0;
    var groupName = null;
    var sectionName = null;
    for (var i = 0; i < lines.length; i++) {
      var L = lines[i];
      var hit = (L.sourceMaterialId && L.sourceMaterialId === matKey) ||
                (String(L.description || '').toLowerCase().replace(/\s+/g, ' ').trim() === descKey);
      if (!hit) continue;
      qty += Number(L.qty || 0);
      if (!groupName) {
        var est = (window.appData.estimates || []).find(function(e) { return e.id === openId; });
        if (est && Array.isArray(est.alternates)) {
          var alt = est.alternates.find(function(a) { return a.id === L.alternateId; });
          if (alt) groupName = alt.name;
        }
      }
      if (!sectionName) {
        // Walk back to the nearest preceding section header in the same group.
        var idx = (window.appData.estimateLines || []).indexOf(L);
        for (var j = idx - 1; j >= 0; j--) {
          var P = window.appData.estimateLines[j];
          if (P.estimateId === openId && P.alternateId === L.alternateId &&
              P.section === '__section_header__') {
            sectionName = P.description; break;
          }
        }
      }
    }
    return qty > 0 ? { groupName: groupName, sectionName: sectionName, qty: qty } : null;
  }

  // ──────────────────────────────────────────────────────────────────
  // Drawer chrome — built once, reused on every open. Toggle visibility
  // via the .open class.
  // ──────────────────────────────────────────────────────────────────
  function ensureDrawer() {
    if (_drawerEl) return _drawerEl;
    var root = document.getElementById(DRAWER_ID);
    if (!root) {
      root = document.createElement('div');
      root.id = DRAWER_ID;
      document.body.appendChild(root);
    }
    root.innerHTML =
      '<div class="md-backdrop" data-md-close></div>' +
      '<aside class="md-panel" role="dialog" aria-label="Materials Catalog">' +
        '<header class="md-header">' +
          '<div class="md-title">&#x1F9F1; Materials Catalog</div>' +
          '<button class="md-close" data-md-close aria-label="Close">&#x2715;</button>' +
        '</header>' +
        '<div class="md-search-row">' +
          '<input class="md-search" type="text" placeholder="Search description, SKU, or category…" autocomplete="off" />' +
        '</div>' +
        '<div class="md-chips" role="tablist"></div>' +
        '<div class="md-results" role="list"></div>' +
        '<footer class="md-footer">' +
          '<span class="md-footer-hint" data-md-target-hint>Adding to: —</span>' +
        '</footer>' +
      '</aside>';

    // Wire interactions.
    root.querySelectorAll('[data-md-close]').forEach(function(el) {
      el.addEventListener('click', closeDrawer);
    });
    var searchInput = root.querySelector('.md-search');
    searchInput.addEventListener('input', onSearchInput);
    // Chip strip — subgroup filters + a Favorites toggle (Phase 2).
    var chips = root.querySelector('.md-chips');
    SUBGROUPS.forEach(function(g) {
      var btn = document.createElement('button');
      btn.className = 'md-chip' + (g.value === _activeSubgroup ? ' active' : '');
      btn.textContent = g.label;
      btn.dataset.subgroup = g.value;
      btn.addEventListener('click', function() {
        _activeSubgroup = g.value;
        chips.querySelectorAll('.md-chip[data-subgroup]').forEach(function(c) {
          c.classList.toggle('active', c.dataset.subgroup === _activeSubgroup);
        });
        _expandedRowId = null;
        runSearch();
      });
      chips.appendChild(btn);
    });
    // Spacer + Favorites toggle (sits right of the subgroup chips so
    // the user reads it as a separate axis from the subgroup filter).
    var favChip = document.createElement('button');
    favChip.className = 'md-chip md-chip-fav' + (_favoritesOnly ? ' active' : '');
    favChip.innerHTML = '&#x2605; Favorites';
    favChip.dataset.fav = '1';
    favChip.title = 'Show only materials you\'ve starred';
    favChip.addEventListener('click', function() {
      _favoritesOnly = !_favoritesOnly;
      favChip.classList.toggle('active', _favoritesOnly);
      _expandedRowId = null;
      runSearch();
    });
    chips.appendChild(favChip);

    _drawerEl = root;
    return root;
  }

  function refreshTargetHint() {
    if (!_drawerEl) return;
    var hint = _drawerEl.querySelector('[data-md-target-hint]');
    if (!hint) return;
    var groupName = window.estimateEditorAPI &&
                    window.estimateEditorAPI.activeAlternateName &&
                    window.estimateEditorAPI.activeAlternateName();
    if (!groupName) {
      hint.textContent = 'Adding to: — (no estimate open)';
      return;
    }
    var sectionLabel = SUBGROUP_TO_SECTION[_activeSubgroup] || 'Materials & Supplies';
    hint.textContent = 'Adding to: ' + groupName + ' → ' + sectionLabel;
  }

  function openDrawer() {
    ensureDrawer();
    _drawerEl.classList.add('open');
    _isOpen = true;
    try { localStorage.setItem(TOGGLE_KEY, '1'); } catch (e) {}
    refreshTargetHint();
    // First-open search — empty query, fetches top results in the
    // active subgroup so the user sees something useful immediately.
    runSearch();
    // Focus the search input after the slide-in animation settles.
    setTimeout(function() {
      var input = _drawerEl.querySelector('.md-search');
      if (input) input.focus();
    }, 50);
  }

  function closeDrawer() {
    if (!_drawerEl) return;
    _drawerEl.classList.remove('open');
    _isOpen = false;
    try { localStorage.setItem(TOGGLE_KEY, '0'); } catch (e) {}
    _expandedRowId = null;
  }

  function toggleDrawer() {
    if (_isOpen) closeDrawer(); else openDrawer();
  }

  // ──────────────────────────────────────────────────────────────────
  // Search — debounced GET /api/materials?q&subgroup&limit. We reuse
  // the existing endpoint (same query shape as read_materials).
  // ──────────────────────────────────────────────────────────────────
  function onSearchInput() {
    if (_searchTimer) clearTimeout(_searchTimer);
    _searchTimer = setTimeout(runSearch, SEARCH_DEBOUNCE_MS);
  }

  function runSearch() {
    if (!_drawerEl) return;
    var resultsEl = _drawerEl.querySelector('.md-results');
    var q = (_drawerEl.querySelector('.md-search').value || '').trim();
    resultsEl.innerHTML = '<div class="md-empty">Loading…</div>';

    var url = '/api/materials?limit=50';
    if (q) url += '&q=' + encodeURIComponent(q);
    if (_activeSubgroup) url += '&subgroup=' + encodeURIComponent(_activeSubgroup);
    if (_favoritesOnly) url += '&favorites_only=1';

    var fetchOpts = { credentials: 'include' };
    fetch(url, fetchOpts)
      .then(function(r) {
        if (!r.ok) throw new Error('Search failed (' + r.status + ')');
        return r.json();
      })
      .then(function(payload) {
        _lastResults = Array.isArray(payload.materials) ? payload.materials : [];
        renderResults();
      })
      .catch(function(err) {
        resultsEl.innerHTML = '<div class="md-empty md-error">' + escapeHTML(err.message) + '</div>';
      });
  }

  function renderResults() {
    if (!_drawerEl) return;
    var el = _drawerEl.querySelector('.md-results');
    if (!_lastResults.length) {
      el.innerHTML = '<div class="md-empty">No catalog matches. Try a broader term — new SKUs land automatically when receipts get ingested.</div>';
      return;
    }
    var html = _lastResults.map(function(m) {
      var on = findOnEstimate(m);
      var onBadge = on
        ? '<span class="md-on-badge" title="Already on ' + escapeHTML((on.groupName || '?') + ' → ' + (on.sectionName || '?') + ', qty ' + on.qty) + '">On estimate</span>'
        : '';
      var expanded = _expandedRowId === m.id;
      var addFormHtml = expanded ? renderAddForm(m) : '';
      // Phase 2 — star icon. Filled when this row is favorited for
      // the current user; click toggles via POST/DELETE. The is_favorited
      // field is set by the server's LEFT JOIN against
      // user_material_favorites; we mirror the value here so the UI
      // doesn't need to re-fetch after toggling.
      var fav = !!m.is_favorited;
      var starHtml = '<button class="md-star' + (fav ? ' active' : '') +
        '" data-star="' + m.id + '" title="' +
        (fav ? 'Unstar' : 'Star — keep this SKU pinned in your Favorites') +
        '" aria-pressed="' + (fav ? 'true' : 'false') + '">' +
        (fav ? '&#x2605;' : '&#x2606;') +
        '</button>';
      return '<div class="md-row' + (expanded ? ' expanded' : '') + '" data-mid="' + m.id + '">' +
        '<div class="md-row-main">' +
          '<div class="md-row-desc">' + escapeHTML(m.description || '(no description)') +
            (m.sku ? '<span class="md-sku">SKU ' + escapeHTML(m.sku) + '</span>' : '') +
          '</div>' +
          '<div class="md-row-meta">' +
            (m.unit ? escapeHTML(m.unit) + ' · ' : '') +
            'last ' + fmtMoney(m.last_unit_price) +
            ' · avg ' + fmtMoney(m.avg_unit_price) +
            ' · ' + fmtDate(m.last_seen) +
            ' · ' + (m.purchase_count || 0) + 'x' +
            (m.category ? ' · ' + escapeHTML(m.category) : '') +
          '</div>' +
        '</div>' +
        '<div class="md-row-actions">' +
          starHtml +
          onBadge +
          '<button class="md-add-btn" data-add="' + m.id + '">' + (expanded ? 'Cancel' : '+ Add') + '</button>' +
        '</div>' +
        addFormHtml +
      '</div>';
    }).join('');
    el.innerHTML = html;
    // Wire add-button clicks.
    el.querySelectorAll('[data-add]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var mid = Number(btn.dataset.add);
        if (_expandedRowId === mid) {
          _expandedRowId = null;
        } else {
          _expandedRowId = mid;
        }
        renderResults();
        // Focus the qty input after re-render.
        if (_expandedRowId === mid) {
          setTimeout(function() {
            var qty = el.querySelector('.md-row.expanded .md-form-qty');
            if (qty) qty.focus();
          }, 10);
        }
      });
    });
    // Wire star clicks — Phase 2 favorites toggle.
    el.querySelectorAll('[data-star]').forEach(function(btn) {
      btn.addEventListener('click', function(ev) {
        ev.stopPropagation();
        var mid = Number(btn.dataset.star);
        var material = _lastResults.find(function(x) { return x.id === mid; });
        if (!material) return;
        toggleFavorite(material, btn);
      });
    });
    // Wire form submits inside any expanded row.
    el.querySelectorAll('.md-form').forEach(function(form) {
      form.addEventListener('submit', function(ev) {
        ev.preventDefault();
        var mid = Number(form.dataset.formMid);
        var material = _lastResults.find(function(x) { return x.id === mid; });
        if (!material) return;
        submitAdd(material, form);
      });
    });
  }

  function renderAddForm(m) {
    var sectionLabel = SUBGROUP_TO_SECTION[m.agx_subgroup || _activeSubgroup] ||
                       SUBGROUP_TO_SECTION[_activeSubgroup];
    return '<form class="md-form" data-form-mid="' + m.id + '">' +
      '<div class="md-form-grid">' +
        '<label><span>Qty</span><input class="md-form-qty" type="number" step="any" required autofocus /></label>' +
        '<label><span>Unit</span><input class="md-form-unit" type="text" value="' + escapeHTML(m.unit || 'ea') + '" /></label>' +
        '<label><span>Unit cost</span><input class="md-form-price" type="number" step="0.01" value="' +
          (m.last_unit_price != null ? Number(m.last_unit_price).toFixed(2) : '') + '" /></label>' +
      '</div>' +
      '<div class="md-form-grid">' +
        '<label class="md-form-section"><span>Subgroup</span>' +
          '<select class="md-form-section-select">' +
            Object.keys(SUBGROUP_TO_SECTION).map(function(k) {
              var name = SUBGROUP_TO_SECTION[k];
              var isDefault = (m.agx_subgroup === k) || (!m.agx_subgroup && k === _activeSubgroup);
              return '<option value="' + escapeHTML(name) + '"' + (isDefault ? ' selected' : '') + '>' + escapeHTML(name) + '</option>';
            }).join('') +
          '</select>' +
        '</label>' +
      '</div>' +
      '<div class="md-form-actions">' +
        '<button type="submit" class="md-form-submit">Add to estimate</button>' +
        '<span class="md-form-hint">' + escapeHTML(sectionLabel) + ' on the active group</span>' +
      '</div>' +
    '</form>';
  }

  function submitAdd(material, form) {
    if (!window.estimateEditorAPI || typeof window.estimateEditorAPI.applyAddLineItem !== 'function') {
      alert('Estimate editor isn\'t available — open an estimate first.');
      return;
    }
    var qty = parseFloat(form.querySelector('.md-form-qty').value);
    if (!isFinite(qty) || qty <= 0) {
      form.querySelector('.md-form-qty').focus();
      return;
    }
    var unit = (form.querySelector('.md-form-unit').value || material.unit || 'ea').trim();
    var unitCost = parseFloat(form.querySelector('.md-form-price').value);
    if (!isFinite(unitCost)) unitCost = 0;
    var sectionName = form.querySelector('.md-form-section-select').value;

    try {
      var result = window.estimateEditorAPI.applyAddLineItem({
        description: material.description,
        qty: qty,
        unit: unit,
        unit_cost: unitCost,
        section_name: sectionName,
        // Phase 2 will surface this through bulk-save so favorites /
        // recently-used can correlate. Today the JSONB blob just
        // passes it through transparently.
        source_material_id: material.id
      });
      // Toast-ish confirmation in the row footer.
      var hint = form.querySelector('.md-form-hint');
      if (hint) {
        hint.textContent = '✓ Added — ' + (result || '');
        hint.style.color = 'var(--accent-success, #4ade80)';
      }
      // Refresh results so the "on estimate" badge updates immediately.
      _expandedRowId = null;
      setTimeout(renderResults, 400);
    } catch (e) {
      var hint2 = form.querySelector('.md-form-hint');
      if (hint2) {
        hint2.textContent = 'Failed: ' + (e.message || 'unknown');
        hint2.style.color = 'var(--accent-danger, #f87171)';
      }
    }
  }

  // applyAddLineItem accepts source_material_id as of Phase 2 — the
  // editor stamps newLine.sourceMaterialId so favorites / recently-
  // used / "already on estimate" can correlate without falling back
  // to fuzzy description matching.

  // ──────────────────────────────────────────────────────────────────
  // Favorites toggle (Phase 2). Optimistic update: flip the row's
  // is_favorited and re-render immediately, then hit the server. On
  // failure, revert and surface a console warn (not fatal — the next
  // search round-trip will reconcile state).
  // ──────────────────────────────────────────────────────────────────
  function toggleFavorite(material, btn) {
    var wasFav = !!material.is_favorited;
    var nextFav = !wasFav;
    material.is_favorited = nextFav;
    btn.classList.toggle('active', nextFav);
    btn.innerHTML = nextFav ? '★' : '☆';
    btn.setAttribute('aria-pressed', nextFav ? 'true' : 'false');
    btn.title = nextFav ? 'Unstar' : 'Star — keep this SKU pinned in your Favorites';

    var url = '/api/materials/' + encodeURIComponent(material.id) + '/favorite';
    var method = nextFav ? 'POST' : 'DELETE';
    fetch(url, { method: method, credentials: 'include' })
      .then(function(r) {
        if (!r.ok) throw new Error('Favorite toggle failed (' + r.status + ')');
        return r.json();
      })
      .catch(function(err) {
        // Revert the optimistic update.
        material.is_favorited = wasFav;
        btn.classList.toggle('active', wasFav);
        btn.innerHTML = wasFav ? '★' : '☆';
        btn.setAttribute('aria-pressed', wasFav ? 'true' : 'false');
        console.warn('[MaterialsDrawer] favorite toggle failed:', err.message);
      });
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API + boot.
  // ──────────────────────────────────────────────────────────────────
  window.MaterialsDrawer = {
    open:   openDrawer,
    close:  closeDrawer,
    toggle: toggleDrawer,
    refresh: function() {
      refreshTargetHint();
      if (_isOpen) renderResults();
    }
  };
})();
