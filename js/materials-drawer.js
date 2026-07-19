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
//     targetApi().applyAddLineItem (same code path
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
  var _mode = 'materials';    // 'materials' | 'assemblies' — assemblies = costed recipes
  var _lastAssemblies = [];   // assemblies-mode result cache
  var _stack = [];            // Scope Builder: [{a, qty, open, flat}] — assemblies staged for insert
  var _asmInsertMode = 'rollup'; // 'rollup' (A1 line + breakdown) | 'exploded'
  var _stackSaving = false;   // save-stack-as-assembly mini-form open
  var _favoritesOnly = false; // Phase 2 — Favorites filter chip toggle
  var _multiSelect = false;   // Phase 3 — multi-select mode toggle
  var _selectedIds = new Set(); // Phase 3 — material ids checked for bulk-add
  var _confirming = false;    // Phase 3 — true while the confirm grid is showing

  // ── Insert target ──────────────────────────────────────────────────
  // The drawer inserts catalog + assembly lines into whichever editor is
  // "active". The estimate editor is the default target; the Change Order
  // editor registers window.p86ActiveLineTarget while it's open so this
  // SAME drawer (catalog + 🧩 assemblies + explode) drives a CO's lines.
  // Both expose the same contract: getOpenId, activeAlternateName,
  // applyAddLineItem, applyBulkAddLineItems. Bracket notation on the
  // estimate global here so the file-wide targetApi() →
  // targetApi() rename doesn't make this line recurse.
  function targetApi() {
    return window.p86ActiveLineTarget || window['estimateEditorAPI'] || null;
  }

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

  // Assembly rollup inserts split into one line per cost bucket, in this
  // order, with these description suffixes.
  var BUCKET_ORDER = ['materials', 'labor', 'gc', 'sub'];
  var BUCKET_SUFFIX = { materials: 'Materials', labor: 'Labor', gc: 'GC', sub: 'Subs' };

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
    if (!window.appData || !targetApi()) return null;
    var openId = targetApi().getOpenId &&
      targetApi().getOpenId();
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
          '<div class="md-header-actions">' +
            '<button class="md-multi-toggle" data-md-multi aria-pressed="false" title="Toggle multi-select for bulk-add">&#x2713; Multi-select</button>' +
            '<button class="md-close" data-md-close aria-label="Close">&#x2715;</button>' +
          '</div>' +
        '</header>' +
        '<div class="md-search-row">' +
          '<input class="md-search" type="text" placeholder="Search description, SKU, or category…" autocomplete="off" />' +
        '</div>' +
        '<div class="md-chips" role="tablist"></div>' +
        '<div class="md-results" role="list"></div>' +
        '<div class="md-tray" data-md-tray hidden></div>' +
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
    // Multi-select toggle (Phase 3). Flipping it on shows checkboxes
    // on every row + reveals the bottom tray; flipping off clears
    // selection.
    var multiBtn = root.querySelector('[data-md-multi]');
    multiBtn.addEventListener('click', function() {
      _multiSelect = !_multiSelect;
      if (!_multiSelect) {
        _selectedIds.clear();
        _confirming = false;
      }
      multiBtn.setAttribute('aria-pressed', _multiSelect ? 'true' : 'false');
      multiBtn.classList.toggle('active', _multiSelect);
      renderResults();
      renderTray();
    });
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
        refreshTargetHint();
        renderTray();
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

    // Assemblies mode — costed recipes that explode into estimate lines.
    // A mode switch, not another filter: while active the subgroup +
    // favorites chips (materials-only concepts) dim out.
    var asmChip = document.createElement('button');
    asmChip.className = 'md-chip md-chip-asm';
    asmChip.innerHTML = '&#x1F9E9; Assemblies';
    asmChip.title = 'Costed recipes — insert a whole scope of work at once';
    asmChip.addEventListener('click', function() {
      _mode = _mode === 'assemblies' ? 'materials' : 'assemblies';
      asmChip.classList.toggle('active', _mode === 'assemblies');
      chips.querySelectorAll('.md-chip[data-subgroup], .md-chip-fav').forEach(function(c) {
        c.style.opacity = _mode === 'assemblies' ? '0.35' : '';
        c.style.pointerEvents = _mode === 'assemblies' ? 'none' : '';
      });
      var mb = root.querySelector('[data-md-multi]');
      if (mb) mb.style.display = _mode === 'assemblies' ? 'none' : '';
      _expandedRowId = null;
      var input = root.querySelector('.md-search');
      if (input) input.placeholder = _mode === 'assemblies'
        ? 'Search assemblies by name, code, or trade…'
        : 'Search description, SKU, or category…';
      runSearch();
      refreshTargetHint();
      renderTray();
    });
    chips.appendChild(asmChip);

    _drawerEl = root;
    return root;
  }

  function refreshTargetHint() {
    if (!_drawerEl) return;
    var hint = _drawerEl.querySelector('[data-md-target-hint]');
    if (!hint) return;
    var groupName = targetApi() &&
                    targetApi().activeAlternateName &&
                    targetApi().activeAlternateName();
    if (!groupName) {
      hint.textContent = 'Adding to: — (no estimate open)';
      return;
    }
    if (_mode === 'assemblies') {
      hint.textContent = 'Adding to: ' + groupName + ' — exploded across sections by cost code';
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
    renderTray();
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

  // Clear the drawer's transient staging/selection state (mode, the
  // staged assembly Scope Builder stack, multi-select). The drawer is a
  // page-lifetime singleton shared across targets, so a scope staged for
  // one target (e.g. a Change Order) must not survive to the next target
  // (an estimate) where "Insert stack" would drop the wrong lines. The CO
  // editor calls this when it claims AND releases the drawer, covering
  // both handoff directions without changing the estimate's own behavior.
  function resetSession() {
    _mode = 'materials';
    _stack = [];
    if (_selectedIds && _selectedIds.clear) _selectedIds.clear();
    _multiSelect = false;
    _confirming = false;
    _stackSaving = false;
    _expandedRowId = null;
    if (_isOpen && _drawerEl) {
      var mc = _drawerEl.querySelector('[data-md-multi]');
      if (mc) { mc.setAttribute('aria-pressed', 'false'); mc.classList.remove('active'); }
      refreshTargetHint();
      renderTray();
      renderResults();
    }
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

    if (_mode === 'assemblies') {
      fetch('/api/assemblies' + (q ? '?q=' + encodeURIComponent(q) : ''), { credentials: 'include' })
        .then(function(r) {
          if (!r.ok) throw new Error('Assembly search failed (' + r.status + ')');
          return r.json();
        })
        .then(function(payload) {
          _lastAssemblies = Array.isArray(payload.assemblies) ? payload.assemblies : [];
          renderAssemblyResults();
        })
        .catch(function(err) {
          resultsEl.innerHTML = '<div class="md-empty md-error">' + escapeHTML(err.message) + '</div>';
        });
      return;
    }

    // Phase 4 — empty-search default state shows what the PM has
    // recently put on an estimate (via the drawer or any other path
    // that stamps sourceMaterialId). Bypasses GET /api/materials when
    // the user hasn't typed anything AND isn't filtering favorites;
    // server falls back to its own purchase_count DESC ordering if
    // the per-user recent list is empty.
    var url;
    var isRecentDefault = !q && !_favoritesOnly && _activeSubgroup === 'materials';
    if (isRecentDefault) {
      url = '/api/materials/recent?limit=25';
    } else {
      url = '/api/materials?limit=50';
      if (q) url += '&q=' + encodeURIComponent(q);
      if (_activeSubgroup) url += '&subgroup=' + encodeURIComponent(_activeSubgroup);
      if (_favoritesOnly) url += '&favorites_only=1';
    }

    var fetchOpts = { credentials: 'include' };
    fetch(url, fetchOpts)
      .then(function(r) {
        if (!r.ok) throw new Error('Search failed (' + r.status + ')');
        return r.json();
      })
      .then(function(payload) {
        _lastResults = Array.isArray(payload.materials) ? payload.materials : [];
        // If the recent-list came back empty, fall back to the
        // popular-most list so the drawer never opens to an empty
        // state. Common on the FIRST drawer open for a user (no
        // drawer-sourced lines yet).
        if (isRecentDefault && _lastResults.length === 0) {
          fetch('/api/materials?limit=50&subgroup=materials', fetchOpts)
            .then(function(r2) { return r2.ok ? r2.json() : { materials: [] }; })
            .then(function(p2) {
              _lastResults = Array.isArray(p2.materials) ? p2.materials : [];
              renderResults();
            });
          return;
        }
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
      // Phase 3 — checkbox visible only in multi-select mode. The
      // single-add "+ Add" button hides while multi-select is on so
      // the user has one clear way to act on a row.
      var checked = _selectedIds.has(m.id);
      var checkboxHtml = _multiSelect
        ? '<label class="md-check"><input type="checkbox" data-check="' + m.id + '"' +
            (checked ? ' checked' : '') + ' /></label>'
        : '';
      var addBtnHtml = _multiSelect
        ? ''
        : '<button class="md-add-btn" data-add="' + m.id + '">' + (expanded ? 'Cancel' : '+ Add') + '</button>';
      return '<div class="md-row' + (expanded ? ' expanded' : '') +
          (checked ? ' selected' : '') + '" data-mid="' + m.id + '">' +
        (checkboxHtml ? '<div class="md-row-check">' + checkboxHtml + '</div>' : '') +
        '<div class="md-row-body">' +
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
            addBtnHtml +
          '</div>' +
          addFormHtml +
        '</div>' +
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
    // Wire multi-select checkboxes — Phase 3.
    el.querySelectorAll('[data-check]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var mid = Number(cb.dataset.check);
        if (cb.checked) _selectedIds.add(mid);
        else _selectedIds.delete(mid);
        // Toggle the .selected class on the parent row without a full
        // re-render so the user doesn't lose scroll position.
        var row = cb.closest('.md-row');
        if (row) row.classList.toggle('selected', cb.checked);
        renderTray();
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

  // ──────────────────────────────────────────────────────────────────
  // Assemblies mode — costed recipes. A row shows name/trade/unit cost
  // per output unit; "+ Insert" expands a takeoff-qty form with an
  // Exploded-lines (default) vs Single-line choice. Exploded = one
  // estimate line per leaf item, routed to the Materials/Labor/GC/Subs
  // section by cost code, each stamped sourceAssemblyId (+
  // sourceMaterialId when the item is a catalog row).
  // ──────────────────────────────────────────────────────────────────
  function renderAssemblyResults() {
    if (!_drawerEl) return;
    var el = _drawerEl.querySelector('.md-results');
    if (!_lastAssemblies.length) {
      el.innerHTML = '<div class="md-empty">No assemblies yet. Build recipes on the Assemblies page (Directory &rarr; Assemblies), then insert them here.</div>';
      return;
    }
    var html = _lastAssemblies.map(function(a) {
      var stacked = _stack.some(function(s) { return s.a.id === a.id; });
      var costTxt = a.incomplete
        ? fmtMoney(a.unit_cost) + '+ <span title="Some items have no price yet">⚠</span>'
        : fmtMoney(a.unit_cost);
      var srcBadge = a.source && a.source !== 'manual'
        ? '<span class="md-sku">' + escapeHTML(a.source) + '</span>' : '';
      return '<div class="md-row' + (stacked ? ' selected' : '') + '" data-aid="' + a.id + '">' +
        '<div class="md-row-body">' +
          '<div class="md-row-main">' +
            '<div class="md-row-desc">&#x1F9E9; ' + escapeHTML(a.name) +
              (a.code ? '<span class="md-sku">' + escapeHTML(a.code) + '</span>' : '') + srcBadge +
            '</div>' +
            '<div class="md-row-meta">' +
              costTxt + ' / ' + escapeHTML(a.unit || 'EA') +
              ' · ' + (a.item_count || 0) + ' item(s)' +
              (a.trade ? ' · ' + escapeHTML(a.trade) : '') +
            '</div>' +
          '</div>' +
          '<div class="md-row-actions">' +
            (stacked
              ? '<button class="md-add-btn" data-asm-unstack="' + a.id + '" style="opacity:.75;">✓ Stacked</button>'
              : '<button class="md-add-btn" data-asm-stack="' + a.id + '">+ Stack</button>') +
          '</div>' +
        '</div>' +
      '</div>';
    }).join('');
    el.innerHTML = html;
    el.querySelectorAll('[data-asm-stack]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var a = _lastAssemblies.find(function(x) { return x.id === Number(btn.dataset.asmStack); });
        if (!a) return;
        _stack.push({ a: a, qty: '', open: false, flat: null });
        renderAssemblyResults();
        renderTray();
        setTimeout(function() {
          var last = _drawerEl.querySelectorAll('.md-stack-qty');
          if (last.length) last[last.length - 1].focus();
        }, 10);
      });
    });
    el.querySelectorAll('[data-asm-unstack]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        _stack = _stack.filter(function(s) { return s.a.id !== Number(btn.dataset.asmUnstack); });
        renderAssemblyResults();
        renderTray();
      });
    });
  }

  // ── Scope Builder stack — stage assemblies with takeoff quantities,
  // then commit the whole scope in one action (A1 rollup lines by
  // default), or save the stack itself as a NEW composite assembly
  // whose items are the stacked recipes as nested sub-assemblies.
  function stackTotal() {
    var t = 0;
    _stack.forEach(function(s) {
      var q = parseFloat(s.qty);
      if (!isFinite(q) || q <= 0) return;
      // Parametric assemblies: use the server-computed total for the typed
      // dimensions when we have it (formulas are non-linear — q × unit_cost
      // would misprice ceil()/step rows); the linear estimate is the interim.
      if (isParametric(s.a) && s.paramTotal != null) t += Number(s.paramTotal) || 0;
      else t += q * (Number(s.a.unit_cost) || 0);
    });
    return t;
  }

  // An assembly routes through the parametric path when it declares params
  // OR carries any quantity formula (formula-only recipes still need the
  // server explode — q × per-unit would misprice their step functions).
  function isParametric(a) {
    return !!(a && ((Array.isArray(a.params) && a.params.length) || a.has_formulas));
  }

  // PWA-safe notice — native alert() silently no-ops in the installed app.
  function mdNotify(msg) {
    if (window.p86Confirm) { try { window.p86Confirm({ title: 'Assemblies', message: msg, confirmText: 'OK' }); return; } catch (e) {} }
    alert(msg);
  }

  // Debounced parametric repricing for one stacked row — POSTs the typed
  // Q + params to /explode and caches the priced total on the row. The
  // timer AND a generation token live on the row: another row's typing
  // must not cancel this one, and a stale response must not land after
  // the inputs changed again.
  function repriceParametric(s, tray) {
    if (!isParametric(s.a)) return;
    s._priceGen = (s._priceGen || 0) + 1;
    var gen = s._priceGen;
    if (s._priceTimer) clearTimeout(s._priceTimer);
    var q = parseFloat(s.qty);
    if (!isFinite(q) || q <= 0) { s.paramTotal = null; s.paramErrors = null; return; }
    s._priceTimer = setTimeout(function() {
      var params = { Q: q };
      Object.keys(s.params || {}).forEach(function(k) {
        var v = parseFloat(s.params[k]);
        if (isFinite(v)) params[k] = v;          // blank/junk → server falls back to the default
      });
      fetch('/api/assemblies/' + encodeURIComponent(s.a.id) + '/explode', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ params: params })
      }).then(function(r) { return r.ok ? r.json() : null; })
        .then(function(d) {
          if (!d || !d.ok || gen !== s._priceGen) return;   // superseded — drop
          s.paramTotal = d.total;
          var issues = (d.errors || []).concat((d.warnings || []).map(function(w) { return { item: '', error: w }; }));
          s.paramErrors = issues.length ? issues : null;
          var totEl = tray && tray.querySelector('span[style*="font-weight:700"]');
          if (totEl) totEl.textContent = fmtMoney(stackTotal());
          var extEl = tray && tray.querySelector('[data-stack-ext="' + s.a.id + '"]');
          if (extEl) extEl.textContent = fmtMoney(d.total);
        }).catch(function() {});
    }, 300);
  }

  function renderAsmStackTray(tray) {
    if (!_stack.length) { tray.hidden = true; tray.innerHTML = ''; return; }
    tray.hidden = false;
    var groupName = targetApi() &&
                    targetApi().activeAlternateName &&
                    targetApi().activeAlternateName();
    var rows = _stack.map(function(s, i) {
      var q = parseFloat(s.qty);
      var ext = (isFinite(q) && q > 0) ? fmtMoney(q * (Number(s.a.unit_cost) || 0)) : '—';
      var prev = '';
      if (s.open) {
        prev = '<div style="padding:2px 8px 6px 26px;font-size:10px;color:var(--text-dim,#8a93a6);">' +
          (s.flat === null ? 'Loading components…'
            : (s.flat.length ? '↳ ' + s.flat.map(function(f) { return escapeHTML((f.description || '').slice(0, 32)); }).join(' · ') : '(no components)')) +
        '</div>';
      }
      // Parametric assemblies expose their declared dimension knobs inline;
      // the ext total then comes from the server explode (debounced).
      var paramRow = '';
      if (isParametric(s.a)) {
        if (s.paramTotal != null) ext = fmtMoney(s.paramTotal);
        paramRow = '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;padding:0 8px 5px 26px;">' +
          (Array.isArray(s.a.params) ? s.a.params : []).map(function(d) {
            var v = (s.params && s.params[d.key] != null) ? s.params[d.key] : d.default;
            return '<label title="' + escapeHTML(d.label || d.key) + '" style="display:flex;align-items:center;gap:3px;font-size:10px;color:#fbbf24;">' +
              '<b style="font-family:monospace;">' + escapeHTML(d.key) + '</b>' + (d.unit ? '<span style="opacity:.7;">' + escapeHTML(d.unit) + '</span>' : '') +
              '<input data-stack-param="' + i + ':' + escapeHTML(d.key) + '" value="' + escapeHTML(String(v)) + '" inputmode="decimal" ' +
                'style="width:46px;text-align:right;background:rgba(251,191,36,0.08);border:1px solid rgba(251,191,36,0.35);border-radius:5px;padding:2px 4px;color:inherit;font-family:monospace;font-size:10.5px;" />' +
            '</label>';
          }).join('') +
          (s.paramErrors ? '<span style="font-size:10px;color:#f87171;" title="' + escapeHTML(s.paramErrors.map(function(e2){ return e2.item + ': ' + e2.error; }).join('\n')) + '">⚠ formula error</span>' : '') +
        '</div>';
      }
      return '<div style="display:flex;align-items:center;gap:8px;padding:5px 8px;">' +
          '<span data-stack-prev="' + i + '" style="cursor:pointer;color:#4fd1c5;font-size:10px;display:inline-block;transition:transform .12s;' + (s.open ? 'transform:rotate(90deg);' : '') + '">▶</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11.5px;font-weight:600;">🧩 ' + escapeHTML(s.a.name) + (isParametric(s.a) ? ' <span title="Parametric — quantities computed from formulas at the typed dimensions" style="color:#fbbf24;font-size:10px;">ƒ</span>' : '') + '</span>' +
          '<input class="md-stack-qty" data-stack-qty="' + i + '" value="' + escapeHTML(String(s.qty)) + '" placeholder="qty" inputmode="decimal" ' +
            'style="width:58px;text-align:right;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:3px 6px;color:inherit;font-family:monospace;font-size:11.5px;" />' +
          '<span style="font-size:10px;color:var(--text-dim,#8a93a6);flex:0 0 24px;">' + escapeHTML(s.a.unit || 'EA') + '</span>' +
          '<span data-stack-ext="' + s.a.id + '" style="font-family:monospace;font-size:11.5px;color:#4fd1c5;flex:0 0 70px;text-align:right;">' + ext + '</span>' +
          '<span data-stack-x="' + i + '" style="cursor:pointer;color:var(--text-dim,#8a93a6);padding:0 2px;">✕</span>' +
        '</div>' + paramRow + prev;
    }).join('');

    var saveForm = '';
    if (_stackSaving) {
      var paramNote = _stack.some(function(s) { return isParametric(s.a); })
        ? '<div style="padding:4px 8px 0;font-size:10px;color:#fbbf24;">⚠ Typed dimensions don\'t carry into a composite — parametric children nest at their per-unit quantities.</div>' : '';
      saveForm = paramNote +
        '<div style="display:flex;gap:6px;align-items:center;padding:6px 8px;border-top:1px solid rgba(255,255,255,0.1);">' +
          '<input data-stacksave-name placeholder="New assembly name…" style="flex:1;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 7px;color:inherit;font-size:11.5px;" />' +
          '<input data-stacksave-unit value="EA" title="Output unit — quantities above are per 1 of this" style="width:44px;text-align:center;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px;color:inherit;font-size:11.5px;" />' +
          '<button class="md-tray-add" data-stacksave-go>Save</button>' +
        '</div>';
    }

    tray.innerHTML =
      '<div style="width:100%;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:4px 8px 2px;">' +
          '<span style="font-size:10px;letter-spacing:.05em;text-transform:uppercase;color:var(--text-dim,#8a93a6);">Scope stack · ' + _stack.length + '</span>' +
          '<span style="font-family:monospace;font-size:12px;font-weight:700;color:#4fd1c5;">' + fmtMoney(stackTotal()) + '</span>' +
        '</div>' +
        rows +
        '<div style="display:flex;gap:6px;align-items:center;padding:7px 8px 4px;border-top:1px solid rgba(255,255,255,0.1);flex-wrap:wrap;">' +
          '<select data-stack-mode style="background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px;color:inherit;font-size:10.5px;">' +
            '<option value="rollup"' + (_asmInsertMode === 'rollup' ? ' selected' : '') + '>Assembly lines (drill-down)</option>' +
            '<option value="exploded"' + (_asmInsertMode === 'exploded' ? ' selected' : '') + '>Exploded lines</option>' +
          '</select>' +
          '<button class="md-tray-add" data-stack-insert' + (groupName ? '' : ' disabled') + '>Insert stack &rarr;</button>' +
          '<button class="md-tray-clear" data-stack-save>💾 Save as assembly</button>' +
          '<button class="md-tray-clear" data-stack-clear>Clear</button>' +
        '</div>' +
        saveForm +
      '</div>';

    tray.querySelectorAll('[data-stack-qty]').forEach(function(inp) {
      inp.addEventListener('input', function() {
        var s = _stack[Number(inp.dataset.stackQty)];
        s.qty = inp.value;
        // Update totals without full re-render (keeps focus).
        var totEl = tray.querySelector('span[style*="font-weight:700"]');
        if (totEl) totEl.textContent = fmtMoney(stackTotal());
        repriceParametric(s, tray);
      });
      inp.addEventListener('change', function() { renderAsmStackTray(tray); });
    });
    tray.querySelectorAll('[data-stack-param]').forEach(function(inp) {
      inp.addEventListener('input', function() {
        var parts = String(inp.dataset.stackParam).split(':');
        var s = _stack[Number(parts[0])];
        if (!s) return;
        if (!s.params) s.params = {};
        // A cleared field means "back to the default" — storing '' would
        // coerce to 0 downstream and zero-price the dimension.
        if (String(inp.value).trim() === '') delete s.params[parts[1]];
        else s.params[parts[1]] = inp.value;
        repriceParametric(s, tray);
      });
    });
    tray.querySelectorAll('[data-stack-x]').forEach(function(x) {
      x.addEventListener('click', function() {
        _stack.splice(Number(x.dataset.stackX), 1);
        renderAssemblyResults();
        renderTray();
      });
    });
    tray.querySelectorAll('[data-stack-prev]').forEach(function(p) {
      p.addEventListener('click', function() {
        var s = _stack[Number(p.dataset.stackPrev)];
        s.open = !s.open;
        if (s.open && s.flat === null) {
          fetch('/api/assemblies/' + encodeURIComponent(s.a.id), { credentials: 'include' })
            .then(function(r) { return r.ok ? r.json() : { flat: [] }; })
            .then(function(d) { s.flat = d.flat || []; renderTray(); });
        }
        renderTray();
      });
    });
    var modeSel = tray.querySelector('[data-stack-mode]');
    if (modeSel) modeSel.addEventListener('change', function() { _asmInsertMode = modeSel.value; });
    var insBtn = tray.querySelector('[data-stack-insert]');
    if (insBtn) insBtn.addEventListener('click', insertStack);
    var saveBtn = tray.querySelector('[data-stack-save]');
    if (saveBtn) saveBtn.addEventListener('click', function() {
      _stackSaving = !_stackSaving;
      renderTray();
      if (_stackSaving) setTimeout(function() {
        var n = tray.querySelector('[data-stacksave-name]');
        if (n) n.focus();
      }, 10);
    });
    var clearBtn = tray.querySelector('[data-stack-clear]');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      _stack = []; _stackSaving = false;
      renderAssemblyResults();
      renderTray();
    });
    var saveGo = tray.querySelector('[data-stacksave-go]');
    if (saveGo) saveGo.addEventListener('click', function() { saveStackAsAssembly(tray); });
  }

  // Commit every stacked assembly at once. Default = A1 rollup lines
  // (one line each + component breakdown); 'exploded' = raw lines.
  function insertStack() {
    if (!targetApi() || typeof targetApi().applyBulkAddLineItems !== 'function') {
      alert('Estimate editor isn\'t available — open an estimate first.');
      return;
    }
    var ready = _stack.filter(function(s) { var q = parseFloat(s.qty); return isFinite(q) && q > 0; });
    if (!ready.length) { alert('Give each stacked assembly a takeoff qty first.'); return; }
    Promise.all(ready.map(function(s) {
      // Parametric assemblies insert from the server explode — FINAL
      // quantities computed from the typed dimensions, never q × per-unit.
      if (isParametric(s.a)) {
        var params = { Q: parseFloat(s.qty) };
        Object.keys(s.params || {}).forEach(function(k) {
          var pv = parseFloat(s.params[k]);
          if (isFinite(pv)) params[k] = pv;
        });
        return fetch('/api/assemblies/' + encodeURIComponent(s.a.id) + '/explode', {
          method: 'POST', credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ params: params })
        }).then(function(r) { if (!r.ok) throw new Error(s.a.name + ': explode failed'); return r.json(); })
          .then(function(d) {
            if (d.errors && d.errors.length) {
              throw new Error(s.a.name + ' has formula errors: ' + d.errors.map(function(e2) { return e2.item + ' — ' + e2.error; }).join('; '));
            }
            return { s: s, p: d, params: d.params_used || params };
          });
      }
      return fetch('/api/assemblies/' + encodeURIComponent(s.a.id), { credentials: 'include' })
        .then(function(r) { if (!r.ok) throw new Error(s.a.name + ': load failed'); return r.json(); })
        .then(function(d) { return { s: s, d: d }; });
    })).then(function(loaded) {
      var specs = [];
      loaded.forEach(function(x) {
        var q = parseFloat(x.s.qty);
        // ── Parametric branch: rows already carry final quantities ──
        if (x.p) {
          var prows = Array.isArray(x.p.rows) ? x.p.rows : [];
          if (_asmInsertMode === 'exploded') {
            prows.forEach(function(f) {
              if (!(f.qty > 0)) return;
              specs.push({
                description: f.description, qty: Math.round(f.qty * 100) / 100, unit: f.unit || 'EA',
                unit_cost: f.unit_cost != null ? f.unit_cost : 0,
                section_name: SUBGROUP_TO_SECTION[f.cost_code] || 'Materials & Supplies',
                source_material_id: f.material_id || undefined,
                source_assembly_id: x.s.a.id,
                assembly_params: x.params
              });
            });
          } else {
            BUCKET_ORDER.forEach(function(code) {
              var rows = prows.filter(function(f) { return (f.cost_code || 'materials') === code; });
              if (!rows.length) return;
              var bucketTotal = rows.reduce(function(sum, f) { return sum + (f.qty || 0) * (f.unit_cost || 0); }, 0);
              specs.push({
                description: x.s.a.name + ' — ' + BUCKET_SUFFIX[code],
                qty: q, unit: x.s.a.unit || 'EA',
                unit_cost: Math.round((bucketTotal / q) * 1e6) / 1e6,   // 6dp — 4dp drifts the ext at large Q
                section_name: SUBGROUP_TO_SECTION[code] || 'Materials & Supplies',
                source_assembly_id: x.s.a.id,
                assembly_breakdown: rows,
                assembly_bucket: code,
                assembly_params: x.params
              });
            });
          }
          return;
        }
        var flat = Array.isArray(x.d.flat) ? x.d.flat : [];
        if (_asmInsertMode === 'exploded' && flat.length) {
          flat.forEach(function(f) {
            var lq = Math.round(q * (f.qty_per_unit || 0) * 100) / 100;
            if (lq <= 0) return;
            specs.push({
              description: f.description, qty: lq, unit: f.unit || 'EA',
              unit_cost: f.unit_cost != null ? f.unit_cost : 0,
              section_name: SUBGROUP_TO_SECTION[f.cost_code] || 'Materials & Supplies',
              source_material_id: f.material_id || undefined,
              source_assembly_id: x.s.a.id
            });
          });
        } else if (flat.length) {
          // Split rollup: ONE line per cost bucket (materials/labor/gc/
          // sub), each routed to its matching section and carrying only
          // its slice of the breakdown — the estimate's section structure
          // shows the cost mix instead of one blob line. Waste is already
          // folded into each flat row's qty_per_unit.
          BUCKET_ORDER.forEach(function(code) {
            var rows = flat.filter(function(f) { return (f.cost_code || 'materials') === code; });
            if (!rows.length) return;
            var per = rows.reduce(function(s, f) { return s + (f.qty_per_unit || 0) * (f.unit_cost || 0); }, 0);
            specs.push({
              description: x.s.a.name + ' — ' + BUCKET_SUFFIX[code],
              qty: q, unit: x.s.a.unit || 'EA',
              unit_cost: Math.round(per * 10000) / 10000,
              section_name: SUBGROUP_TO_SECTION[code] || 'Materials & Supplies',
              source_assembly_id: x.s.a.id,
              assembly_breakdown: rows,
              assembly_bucket: code
            });
          });
        } else {
          // Empty recipe — nothing to split, land a single plain line.
          specs.push({
            description: x.s.a.name, qty: q, unit: x.s.a.unit || 'EA',
            unit_cost: (x.d.assembly && x.d.assembly.unit_cost) || x.s.a.unit_cost || 0,
            section_name: SUBGROUP_TO_SECTION[dominantCode(flat)] || 'Materials & Supplies',
            source_assembly_id: x.s.a.id
          });
        }
      });
      targetApi().applyBulkAddLineItems(specs);
      _stack = []; _stackSaving = false;
      renderAssemblyResults();
      renderTray();
    }).catch(function(e) { mdNotify('Insert failed: ' + (e.message || 'unknown')); });
  }

  // The composition flow: the stack becomes a NEW assembly whose items
  // are the stacked recipes as nested sub-assemblies (qty_per_unit =
  // each takeoff qty per 1 output unit of the new assembly).
  function saveStackAsAssembly(tray) {
    var name = (tray.querySelector('[data-stacksave-name]') || {}).value || '';
    var unit = (tray.querySelector('[data-stacksave-unit]') || {}).value || 'EA';
    if (!name.trim()) { alert('Name the new assembly first.'); return; }
    var items = _stack.map(function(s) {
      var q = parseFloat(s.qty);
      return {
        kind: 'assembly', child_assembly_id: s.a.id,
        qty_per_unit: (isFinite(q) && q > 0) ? q : 1,
        unit: s.a.unit || 'EA'
      };
    });
    fetch('/api/assemblies', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name.trim(), unit: unit.trim() || 'EA', source: 'manual',
        description: 'Composite — built from the Scope Builder stack', items: items })
    }).then(function(r) { return r.json(); })
      .then(function(res) {
        if (res.error) throw new Error(res.error);
        _stack = []; _stackSaving = false;
        runSearch();
        renderTray();
        if (window.p86Assemblies && window.p86Assemblies.renderList) {
          try { window.p86Assemblies.renderList(); } catch (e) {}
        }
      })
      .catch(function(e) { alert('Save failed: ' + (e.message || 'unknown')); });
  }

  // Which cost code carries the most $ in a flattened recipe — used to
  // pick the section for single-line inserts.
  function dominantCode(flat) {
    var by = {};
    (flat || []).forEach(function(f) {
      var ext = (f.qty_per_unit || 0) * (f.unit_cost || 0);
      by[f.cost_code || 'materials'] = (by[f.cost_code || 'materials'] || 0) + ext;
    });
    var best = 'materials', max = -1;
    Object.keys(by).forEach(function(k) { if (by[k] > max) { max = by[k]; best = k; } });
    return best;
  }

  function renderAddForm(m) {
    var sectionLabel = SUBGROUP_TO_SECTION[m.agx_subgroup || _activeSubgroup] ||
                       SUBGROUP_TO_SECTION[_activeSubgroup];
    return '<form class="md-form" data-form-mid="' + m.id + '">' +
      '<div class="md-form-grid">' +
        '<label><span>Qty</span><input class="md-form-qty" type="text" inputmode="decimal" required autofocus /></label>' +
        '<label><span>Unit</span><input class="md-form-unit" type="text" value="' + escapeHTML(m.unit || 'ea') + '" /></label>' +
        '<label><span>Unit cost</span><input class="md-form-price" type="text" inputmode="decimal" value="' +
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
    if (!targetApi() || typeof targetApi().applyAddLineItem !== 'function') {
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
      var result = targetApi().applyAddLineItem({
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
  // Bulk-add tray (Phase 3). Sticky strip above the footer that shows
  // selection count + the active target + an "Add all" button. Hidden
  // when multi-select is off OR no items are selected. The confirm
  // step opens a per-row qty grid in place of the search results so
  // the user can tweak qty before committing.
  // ──────────────────────────────────────────────────────────────────
  function renderTray() {
    if (!_drawerEl) return;
    var tray = _drawerEl.querySelector('[data-md-tray]');
    if (!tray) return;
    // Assemblies mode — the tray is the Scope Builder stack.
    if (_mode === 'assemblies') { renderAsmStackTray(tray); return; }
    if (!_multiSelect || _selectedIds.size === 0) {
      tray.hidden = true;
      tray.innerHTML = '';
      return;
    }
    tray.hidden = false;
    var groupName = targetApi() &&
                    targetApi().activeAlternateName &&
                    targetApi().activeAlternateName();
    var sectionLabel = SUBGROUP_TO_SECTION[_activeSubgroup] || 'Materials & Supplies';
    tray.innerHTML =
      '<div class="md-tray-info">' +
        '<strong>' + _selectedIds.size + '</strong> selected' +
        (groupName ? ' · ' + escapeHTML(groupName) + ' → ' + escapeHTML(sectionLabel) : ' · (no estimate open)') +
      '</div>' +
      '<div class="md-tray-actions">' +
        '<button class="md-tray-clear" data-tray-clear>Clear</button>' +
        '<button class="md-tray-add" data-tray-add' + (groupName ? '' : ' disabled') + '>Add all &rarr;</button>' +
      '</div>';
    var clearBtn = tray.querySelector('[data-tray-clear]');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      _selectedIds.clear();
      _confirming = false;
      renderResults();
      renderTray();
    });
    var addBtn = tray.querySelector('[data-tray-add]');
    if (addBtn) addBtn.addEventListener('click', openConfirmGrid);
  }

  // Confirmation step — replace the search results with a stripped-
  // down grid of just the selected items so the user can set qty per
  // row before commit. Per spec: descriptions/prices are read-only at
  // this stage; qty is required (defaults blank, must be filled).
  function openConfirmGrid() {
    _confirming = true;
    var resultsEl = _drawerEl.querySelector('.md-results');
    var selected = _lastResults.filter(function(m) { return _selectedIds.has(m.id); });
    // The user may have selected rows that scrolled out of the
    // current search result set if they filtered/searched between
    // selections. For Phase 3 MVP we only confirm what's currently
    // in _lastResults; out-of-frame selections are dropped quietly
    // (rare in practice — the typical bulk flow selects 3-10 visible
    // rows). A future enhancement could cache full row data per id.
    var html = '<div class="md-confirm">' +
      '<div class="md-confirm-head">Set qty for each line, then Add all. Unit + price come from the catalog row; edit them in the estimate after if needed.</div>' +
      selected.map(function(m) {
        return '<div class="md-confirm-row" data-confirm-mid="' + m.id + '">' +
          '<div class="md-confirm-desc">' + escapeHTML(m.description || '(no description)') +
            '<span class="md-confirm-meta">' +
              (m.unit || 'ea') + ' · ' + fmtMoney(m.last_unit_price) +
            '</span>' +
          '</div>' +
          '<input class="md-confirm-qty" type="text" inputmode="decimal" placeholder="qty" />' +
        '</div>';
      }).join('') +
      '<div class="md-confirm-actions">' +
        '<button class="md-confirm-cancel" data-confirm-cancel>&larr; Back</button>' +
        '<button class="md-confirm-submit" data-confirm-submit>Add ' + selected.length + ' line(s)</button>' +
      '</div>' +
    '</div>';
    resultsEl.innerHTML = html;
    resultsEl.querySelector('[data-confirm-cancel]').addEventListener('click', function() {
      _confirming = false;
      renderResults();
    });
    resultsEl.querySelector('[data-confirm-submit]').addEventListener('click', submitBulkAdd);
    var firstQty = resultsEl.querySelector('.md-confirm-qty');
    if (firstQty) firstQty.focus();
  }

  function submitBulkAdd() {
    if (!targetApi() || typeof targetApi().applyBulkAddLineItems !== 'function') {
      alert('Estimate editor isn\'t available — open an estimate first.');
      return;
    }
    var rows = Array.from(_drawerEl.querySelectorAll('.md-confirm-row'));
    var sectionName = SUBGROUP_TO_SECTION[_activeSubgroup] || 'Materials & Supplies';
    var lines = [];
    var missingQty = 0;
    rows.forEach(function(row) {
      var mid = Number(row.dataset.confirmMid);
      var material = _lastResults.find(function(x) { return x.id === mid; });
      if (!material) return;
      var qtyEl = row.querySelector('.md-confirm-qty');
      var qty = parseFloat(qtyEl.value);
      if (!isFinite(qty) || qty <= 0) {
        missingQty++;
        qtyEl.classList.add('md-error');
        return;
      }
      qtyEl.classList.remove('md-error');
      lines.push({
        description: material.description,
        qty: qty,
        unit: material.unit || 'ea',
        unit_cost: material.last_unit_price != null ? Number(material.last_unit_price) : 0,
        section_name: sectionName,
        source_material_id: material.id
      });
    });
    if (missingQty > 0) {
      alert(missingQty + ' line(s) need a qty before adding.');
      return;
    }
    try {
      targetApi().applyBulkAddLineItems(lines);
      _selectedIds.clear();
      _confirming = false;
      _multiSelect = false;
      var multiBtn = _drawerEl.querySelector('[data-md-multi]');
      if (multiBtn) {
        multiBtn.setAttribute('aria-pressed', 'false');
        multiBtn.classList.remove('active');
      }
      renderResults();
      renderTray();
    } catch (e) {
      alert('Bulk add failed: ' + (e.message || 'unknown'));
    }
  }

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
    reset:  resetSession,
    refresh: function() {
      refreshTargetHint();
      if (_isOpen) {
        if (_mode === 'assemblies') renderAssemblyResults();
        else renderResults();
      }
    }
  };
})();
