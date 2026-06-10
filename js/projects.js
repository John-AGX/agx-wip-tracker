// Projects — CompanyCam-style first-class entity for site photos +
// walkthroughs. A project buckets photos, descriptions, markups,
// tags, before/after pairs, and (eventually) reports around one
// physical site. Links to a lead, a job, and a client.
//
// Phase 1.5: full UI upgrade — date-grouped photo feed, tag editor +
// filter chips, activity timeline, grid/map view toggle, before/after
// pair creation with slider. AI auto-tagging deferred to later phase.
//
// Mount points:
//   window.renderProjectsInto(hostEl)
//   window.renderLinkedProjectsPanel(host, { kind, id })
//   window.openProject(projectId)
//
// Companion modules:
//   js/projects-map.js   → map view (Leaflet)
//   js/projects-pairs.js → before/after slider widget
(function() {
  'use strict';

  // ──────────────────────────────────────────────────────────────────
  // Small utilities
  // ──────────────────────────────────────────────────────────────────
  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }
  function fmtDate(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleDateString(); } catch (e) { return ''; }
  }
  function fmtRelative(s) {
    if (!s) return '';
    var d = new Date(s);
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }
  // "Today" / "Yesterday" / explicit date — used to group the photo feed.
  function dateGroupLabel(s) {
    if (!s) return 'Undated';
    var d = new Date(s);
    var now = new Date();
    var midnightToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    var midnightDate = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
    var diffDays = Math.round((midnightToday - midnightDate) / 86400000);
    if (diffDays === 0) return 'Today';
    if (diffDays === 1) return 'Yesterday';
    if (diffDays > 0 && diffDays < 7) return d.toLocaleDateString(undefined, { weekday: 'long' });
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: now.getFullYear() === d.getFullYear() ? undefined : 'numeric' });
  }
  function fmtTime(s) {
    if (!s) return '';
    try {
      return new Date(s).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return ''; }
  }
  // Deterministic hue from a string — used to color tag chips
  // consistently across renders.
  function hueFor(str) {
    var s = String(str || '');
    var h = 0;
    for (var i = 0; i < s.length; i++) {
      h = ((h << 5) - h) + s.charCodeAt(i);
      h |= 0;
    }
    return Math.abs(h) % 360;
  }
  function initialsOf(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    var parts = s.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  // Voice helper — delegates to the shared js/voice-input.js module
  // so the walkthrough upload modal + 86 chat composer use ONE
  // implementation. Was previously duplicated here; that drift was
  // the root cause of the "double-speak on mobile" complaint.
  // Returns a teardown function so the caller can stop dictation
  // when the modal closes. Silently no-ops on unsupported browsers.
  function wireVoiceInput(textareaEl, micBtnEl) {
    if (!window.p86VoiceInput || typeof window.p86VoiceInput.wire !== 'function') {
      // Defensive — module load failed somehow. Hide the mic button
      // so the user doesn't tap a dead control.
      if (micBtnEl) micBtnEl.style.display = 'none';
      return function () {};
    }
    return window.p86VoiceInput.wire(textareaEl, micBtnEl, {
      silenceTimeoutMs: 5000   // 5s for walkthrough narration (vs 3s for chat)
    });
  }

  function api() { return window.p86Api && window.p86Api.projects; }
  function currentUser() {
    return (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
  }

  // Refresh leads / jobs / clients into window.appData so the project
  // link dropdowns + the inheritance code (createForEntity, editLinks
  // Use-linked-entity checkbox) read the CURRENT entity addresses, not
  // a snapshot from when the page first loaded.
  //
  // Previously this only fetched when the cache was empty. That made
  // the page snappy but caused a stale-data bug: edit a lead's address
  // in the Leads tab, then come back to Projects and link a project
  // to that lead — inheritance pulled the PRE-edit address from the
  // stale cache, leaving the project pointing at the old address.
  //
  // The lists are small (single-tenant org-sized) so always-refresh
  // is cheap. Failures swallow silently — the dropdowns just render
  // whatever's in the existing cache.
  function ensureEntityCaches() {
    var promises = [];
    window.appData = window.appData || {};

    if (window.p86Api && window.p86Api.leads) {
      promises.push(window.p86Api.leads.list().then(function(r) {
        var rows = (r && r.leads) || [];
        if (rows.length || !window.appData.leads) window.appData.leads = rows;
      }).catch(function() {}));
    }
    if (window.p86Api && window.p86Api.clients) {
      promises.push(window.p86Api.clients.list().then(function(r) {
        var rows = (r && r.clients) || [];
        if (rows.length || !window.appData.clients) window.appData.clients = rows;
      }).catch(function() {}));
    }
    if (window.p86Api && window.p86Api.jobs) {
      promises.push(window.p86Api.jobs.list().then(function(r) {
        var rows = (r && r.jobs) || [];
        if (rows.length || !window.appData.jobs) window.appData.jobs = rows;
      }).catch(function() {}));
    }

    return Promise.all(promises);
  }

  // ──────────────────────────────────────────────────────────────────
  // State
  // ──────────────────────────────────────────────────────────────────
  var _listState = {
    filter: 'all',
    q: '',
    // (project-level `tag` filter removed — projects don't carry
    // their own tags any more. Use the photo-tag chip strip inside
    // a project for tag-based drill-in.)
    view: 'grid',          // 'grid' | 'map'
    projects: [],
    loading: false,
    error: null,
    host: null
  };
  var _detailState = {
    projectId: null,
    project: null,
    pairs: [],
    activity: [],
    photos: []             // hydrated by the attachments fetch
  };
  var _linkedPanels = [];  // [{ host, ctx }]

  // ──────────────────────────────────────────────────────────────────
  // Overlay history stack — wires Android (and browser) Back button
  // to close the topmost project overlay instead of navigating away.
  //
  // When an overlay opens, push a state entry + register its close fn.
  // popstate (fired by Android back, browser back, or programmatic
  // history.back()) pops the close fn and runs it. Close buttons in
  // each overlay route through closeTop() so the history stack stays
  // balanced with the visible overlays.
  // ──────────────────────────────────────────────────────────────────
  var _overlayStack = [];

  function pushOverlay(closeFn) {
    try {
      history.pushState({ p86OverlayDepth: _overlayStack.length + 1 }, '');
    } catch (e) { /* defensive — pushState can throw in restricted iframes */ }
    _overlayStack.push(closeFn);
  }
  function closeTopOverlay() {
    if (!_overlayStack.length) return;
    // Trigger popstate so the back button + the X button both go
    // through the same close pipeline. popstate handler pops + runs.
    try { history.back(); } catch (e) {
      var fn = _overlayStack.pop();
      try { fn(); } catch (_) {}
    }
  }
  function clearOverlayStack() {
    // Drop our entries from the stack WITHOUT navigating back. Used
    // when the user navigates away via a non-back action (tab switch,
    // logout, etc.). Doesn't actually pop history entries — those
    // become inert because the closes are gone.
    _overlayStack = [];
  }

  window.addEventListener('popstate', function() {
    if (!_overlayStack.length) return;
    var fn = _overlayStack.pop();
    try { fn(); } catch (e) { /* defensive */ }
  });
  // Cache last-known tag suggestions so the editor autocomplete renders
  // immediately on focus (a stale list is better than an empty list).
  var _tagSuggestCache = [];
  // Weather cache — keyed by project id. Populated lazily by the
  // list / detail painters. TTL is short-lived: refresh on each
  // open of the projects view; the server caches at the NWS layer
  // for an hour so repeat hits are cheap.
  var _weatherCache = {};

  // Pick a small emoji + label from one of the day-forecast entries
  // the NWS route returns. Keep this conservative — NWS includes
  // generic strings like "Partly Cloudy", "Showers Likely", etc.
  function weatherEmoji(day) {
    if (!day) return null;
    var sf = String(day.shortForecast || '').toLowerCase();
    if (!sf) return null;
    if (sf.indexOf('thunder') !== -1) return '⛈';
    if (sf.indexOf('snow') !== -1) return '❄️';
    if (sf.indexOf('rain') !== -1 || sf.indexOf('shower') !== -1) return '🌧';
    if (sf.indexOf('fog') !== -1 || sf.indexOf('mist') !== -1 || sf.indexOf('haze') !== -1) return '🌫';
    if (sf.indexOf('cloud') !== -1 && sf.indexOf('partly') !== -1) return '⛅';
    if (sf.indexOf('cloud') !== -1 || sf.indexOf('overcast') !== -1) return '☁️';
    if (sf.indexOf('clear') !== -1 || sf.indexOf('sunny') !== -1) return '☀️';
    if (sf.indexOf('wind') !== -1) return '💨';
    return '🌡';
  }

  // Find today's daytime entry. NWS returns alternating day/night
  // periods; day.isDaytime distinguishes them. Falls back to the
  // first period if labels are missing.
  function todayForecast(weather) {
    if (!weather || weather.status !== 'ok' || !Array.isArray(weather.days) || !weather.days.length) return null;
    var today = weather.days.find(function(d) { return d.isDaytime; });
    return today || weather.days[0];
  }

  // Walkthrough state — sticky tags persist between photo uploads
  // until the user clears them. Module-level (not in _detailState)
  // so they survive a project detail close/reopen within the same
  // page lifetime. Cleared on full page reload.
  var _walkthroughTags = [];
  // "Quick Save" bypass flag — when set within a single batch, the
  // remaining files in the same uploadFiles() call skip the preview
  // modal and POST directly with whatever's already in the form.
  // Reset on every new batch.
  var _quickSaveThisBatch = false;

  // ──────────────────────────────────────────────────────────────────
  // Top-level list view
  // ──────────────────────────────────────────────────────────────────
  function renderProjectsInto(host) {
    if (!host) return;
    _listState.host = host;
    // Restore last-used view from sessionStorage so refresh sticks.
    try {
      var stored = sessionStorage.getItem('p86-projects-view');
      if (stored === 'map' || stored === 'grid') _listState.view = stored;
    } catch (e) {}
    paintList();
    fetchAll().then(paintList).catch(function(e) {
      _listState.error = e.message || 'Failed to load projects';
      paintList();
    });
    // Warm leads/jobs/clients caches in the background so the
    // Create-Project / Edit-Links / Pair Picker modals have populated
    // dropdowns by the time the user clicks. No-op when the caches
    // are already loaded.
    ensureEntityCaches();
  }
  window.renderProjectsInto = renderProjectsInto;

  function fetchAll() {
    if (!api()) return Promise.reject(new Error('API not available'));
    _listState.loading = true;
    var opts = {};
    if (_listState.filter === 'archived') opts.status = 'archived';
    else opts.status = 'active';
    if (_listState.q) opts.q = _listState.q;
    return api().list(opts).then(function(r) {
      _listState.projects = (r && r.projects) || [];
      _listState.error = null;
      _listState.loading = false;
    });
  }

  function paintList() {
    var host = _listState.host;
    if (!host) return;
    var me = currentUser();
    var myId = me ? me.id : null;
    var projects = _listState.projects.slice();

    if (_listState.filter === 'mine' && myId != null) {
      projects = projects.filter(function(p) { return Number(p.created_by) === Number(myId); });
    } else if (_listState.filter === 'linked-lead') {
      projects = projects.filter(function(p) { return !!p.lead_id; });
    } else if (_listState.filter === 'linked-job') {
      projects = projects.filter(function(p) { return !!p.job_id; });
    }

    var chips = [
      { id: 'all',          label: 'All' },
      { id: 'mine',         label: 'Mine' },
      { id: 'linked-lead',  label: 'Linked to Lead' },
      { id: 'linked-job',   label: 'Linked to Job' },
      { id: 'archived',     label: 'Archived' }
    ];

    // (Project-level tag chip strip removed — projects don't carry
    // their own tags. Photo tags live inside each project's detail
    // view via #projTagChipStrip.)

    var html =
      '<div class="p86-projects-root">' +
        '<div class="p86-projects-header">' +
          '<div class="p86-projects-header-text">' +
            '<h2>Projects</h2>' +
            '<div class="p86-projects-subtitle">Photo + walkthrough buckets for sites. Link to a lead during sales; the job inherits once sold.</div>' +
          '</div>' +
          '<div class="p86-projects-header-actions">' +
            '<input id="projSearch" type="search" placeholder="Search projects…" value="' + escapeAttr(_listState.q) + '" class="p86-projects-search" />' +
            '<button class="primary p86-projects-new-btn" onclick="window.p86Projects.openCreate()">&#x2795; New Project</button>' +
          '</div>' +
        '</div>' +

        '<div class="p86-projects-toolbar">' +
          '<div class="p86-projects-view-toggle">' +
            '<button class="' + (_listState.view === 'grid' ? 'active' : '') + '" onclick="window.p86Projects.setView(\'grid\')">&#x25A6; Grid</button>' +
            '<button class="' + (_listState.view === 'list' ? 'active' : '') + '" onclick="window.p86Projects.setView(\'list\')">&#x2261; List</button>' +
            '<button class="' + (_listState.view === 'map' ? 'active' : '') + '" onclick="window.p86Projects.setView(\'map\')">&#x1F5FA; Map</button>' +
          '</div>' +
          '<div class="p86-projects-filter-chips">' +
            chips.map(function(c) {
              var active = c.id === _listState.filter;
              return '<button class="p86-chip' + (active ? ' active' : '') + '" onclick="window.p86Projects.setFilter(\'' + c.id + '\')">' +
                escapeHTML(c.label) +
              '</button>';
            }).join('') +
          '</div>' +
        '</div>' +

        (_listState.loading
          ? '<div class="p86-projects-empty">Loading…</div>'
          : _listState.error
            ? '<div class="p86-projects-error">' + escapeHTML(_listState.error) + '</div>'
            : projects.length === 0
              ? '<div class="p86-projects-empty">No projects yet. Hit <strong>+ New Project</strong> to create one — or open a lead and create one from there.</div>'
              : _listState.view === 'map'
                ? '<div id="p86ProjMapHost" class="p86-projects-map-host"></div>' +
                  (function() {
                    var unmapped = projects.filter(function(p) {
                      var lat = Number(p.geocode_lat), lng = Number(p.geocode_lng);
                      // Finite, in real-world range, and not 0,0 "null island".
                      var valid = Number.isFinite(lat) && Number.isFinite(lng) &&
                        !(lat === 0 && lng === 0) && lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
                      return !valid;
                    });
                    if (!unmapped.length) return '';
                    return '<div class="p86-projects-unmapped"><strong>Unmapped (' + unmapped.length + ')</strong> · ' +
                      unmapped.map(function(p) {
                        return '<a href="#" onclick="window.openProject(\'' + escapeAttr(p.id) + '\'); return false;">' + escapeHTML(p.name) + '</a>';
                      }).join(' · ') +
                    '</div>';
                  })()
                : _listState.view === 'list'
                  ? renderProjectList(projects)
                  : renderProjectGrid(projects)) +
      '</div>';

    host.innerHTML = html;

    // Search debounce.
    var s = host.querySelector('#projSearch');
    if (s) {
      var t;
      s.addEventListener('input', function(e) {
        clearTimeout(t);
        var v = e.target.value;
        t = setTimeout(function() {
          _listState.q = v;
          fetchAll().then(paintList).catch(function(err) {
            _listState.error = err.message || 'Failed to load';
            paintList();
          });
        }, 250);
      });
    }

    // Batch-fetch weather for any addressed projects we haven't
    // cached yet. The chip renders empty until the response lands;
    // a second paintList() fills the chips. Skipped on the map view
    // since the sidebar already shows addresses + status pins.
    if (_listState.view === 'grid' && window.p86Api && window.p86Api.weather && window.p86Api.weather.projects) {
      var needsWeather = projects
        .filter(function(p) { return p.address_text && !_weatherCache[p.id]; })
        .map(function(p) { return p.id; });
      if (needsWeather.length) {
        window.p86Api.weather.projects(needsWeather).then(function(r) {
          var w = (r && r.weather) || {};
          var changed = false;
          Object.keys(w).forEach(function(id) {
            if (w[id] && w[id].status === 'ok') { _weatherCache[id] = w[id]; changed = true; }
          });
          if (changed && _listState.host) paintList();
        }).catch(function() {});
      }
    }

    // Mount the map after the host element is in the DOM.
    if (_listState.view === 'map' && projects.length) {
      var mapHost = host.querySelector('#p86ProjMapHost');
      if (mapHost && window.p86ProjectsMap && typeof window.p86ProjectsMap.render === 'function') {
        window.p86ProjectsMap.render(mapHost, projects, {
          onPin: function(projectId) { openProject(projectId); }
        });
      } else if (mapHost) {
        mapHost.innerHTML = '<div class="p86-projects-empty">Map module not loaded.</div>';
      }
    }
  }

  function renderProjectGrid(projects) {
    return '<div class="p86-projects-grid">' +
      projects.map(projectCardHTML).join('') +
    '</div>';
  }

  // List view — same row style as the Map view's sidebar, lifted out
  // so users can browse by row without needing the map. Click any row
  // to open the project. The visual language matches CompanyCam's
  // project list: thumb + status dot + name + address + photo count.
  function renderProjectList(projects) {
    return '<div class="p86-projects-list">' +
      projects.map(projectListRowHTML).join('') +
    '</div>';
  }

  function projectListRowHTML(p) {
    var coverUrl = p.cover_thumb_url || p.cover_web_url || '';
    var thumb = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-projects-list-thumb" />'
      : '<div class="p86-projects-list-thumb p86-projects-list-thumb-empty">📁</div>';
    // Status dot mirrors the Map view's coloring rules so users can
    // scan-by-color across views (green: active <7d, yellow: stale,
    // black: archived).
    var dot = '🟢';
    if (p.archived_at) dot = '⚫';
    else {
      var updated = p.updated_at ? new Date(p.updated_at).getTime() : 0;
      if (((Date.now() - updated) / 86400000) > 7) dot = '🟡';
    }
    return '<div class="p86-projects-list-row" onclick="window.openProject(\'' + escapeAttr(p.id) + '\')" title="Open project">' +
      thumb +
      '<div class="p86-projects-list-body">' +
        '<div class="p86-projects-list-name">' + dot + ' ' + escapeHTML(p.name || 'Untitled') + '</div>' +
        (p.address_text ? '<div class="p86-projects-list-addr">' + escapeHTML(p.address_text) + '</div>' : '') +
        '<div class="p86-projects-list-meta">📷 ' + Number(p.photo_count || 0) + ' · ' + escapeHTML(fmtRelative(p.updated_at)) + '</div>' +
      '</div>' +
    '</div>';
  }

  function projectCardHTML(p) {
    var coverUrl = p.cover_thumb_url || p.cover_web_url || '';
    var visual = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-proj-card-cover" />'
      : '<div class="p86-proj-card-cover p86-proj-card-cover-empty">&#x1F4F8;</div>';

    var badges = [];
    if (p.lead_title)   badges.push({ k: 'Lead',    v: p.lead_title });
    if (p.job_name)     badges.push({ k: 'Job',     v: p.job_name });
    if (p.client_name)  badges.push({ k: 'Client',  v: p.client_name });

    var tags = (p.tags || []).slice(0, 3);
    var extraTags = Math.max(0, (p.tags || []).length - tags.length);

    // Optional weather chip on the card. Renders only when weather
    // data has been fetched for this project (lazy populated by
    // paintList after the project list lands).
    var wx = _weatherCache[p.id];
    var wxToday = wx ? todayForecast(wx) : null;
    var wxChip = wxToday
      ? '<span class="p86-proj-card-wx" title="' + escapeAttr(wxToday.shortForecast || '') + '">' + weatherEmoji(wxToday) + ' ' + escapeHTML(String(wxToday.temperature || '')) + '°</span>'
      : '';

    return '<div class="p86-proj-card" onclick="window.openProject(\'' + escapeAttr(p.id) + '\')">' +
      visual +
      '<div class="p86-proj-card-body">' +
        '<div class="p86-proj-card-name">' + escapeHTML(p.name) + '</div>' +
        '<div class="p86-proj-card-stats">' +
          '<span>&#x1F4F7; ' + Number(p.photo_count || 0) + '</span>' +
          (Number(p.pair_count || 0) ? '<span>&#x1F500; ' + Number(p.pair_count) + '</span>' : '') +
          (wxChip ? wxChip : '') +
          '<span class="p86-proj-card-updated">' + escapeHTML(fmtRelative(p.updated_at)) + '</span>' +
        '</div>' +
        (tags.length
          ? '<div class="p86-proj-card-tags">' +
              tags.map(function(t) {
                return '<span class="p86-chip-tag-mini" style="--h:' + hueFor(t) + ';">#' + escapeHTML(t) + '</span>';
              }).join('') +
              (extraTags ? '<span class="p86-chip-tag-mini p86-chip-tag-more">+' + extraTags + '</span>' : '') +
            '</div>'
          : '') +
        (badges.length
          ? '<div class="p86-proj-card-badges">' +
              badges.map(function(b) {
                return '<span class="p86-proj-card-badge"><span class="p86-proj-card-badge-k">' + escapeHTML(b.k) + ':</span> ' + escapeHTML(b.v) + '</span>';
              }).join('') +
            '</div>'
          : '') +
      '</div>' +
    '</div>';
  }

  function setFilter(id) {
    _listState.filter = id;
    if (id === 'archived' || _listState.projects.length === 0) {
      fetchAll().then(paintList);
    } else {
      paintList();
    }
  }
  function setView(view) {
    var allowed = ['grid', 'list', 'map'];
    _listState.view = (allowed.indexOf(view) >= 0) ? view : 'grid';
    try { sessionStorage.setItem('p86-projects-view', _listState.view); } catch (e) {}
    paintList();
  }
  // (setTagFilter removed — project-level tag filter is gone.)

  // ──────────────────────────────────────────────────────────────────
  // Create-Project modal — replaces window.prompt
  // ──────────────────────────────────────────────────────────────────
  function openCreate(prefill, options) {
    prefill = prefill || {};
    options = options || {};
    var prior = document.getElementById('projCreateModal');
    if (prior) prior.remove();

    // Phase 1.7b — single "Link to…" picker replaces the three
    // separate Lead / Job / Client dropdowns. Picking an entity
    // auto-fills name + address from that entity, so the create
    // path mirrors the Edit Links path. The user can still type
    // over the values before hitting Create.
    var pendingLink = {
      lead_id: prefill.lead_id || null,
      job_id: prefill.job_id || null,
      client_id: prefill.client_id || null
    };
    // Kick off caches in the background so the entity picker has
    // fresh data the moment the user clicks "Link to…".
    ensureEntityCaches();

    var modal = document.createElement('div');
    modal.id = 'projCreateModal';
    modal.className = 'modal active p86-proj-create-modal';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">' +
          '<span>New Project</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-proj-create-body">' +
          '<label class="p86-field">' +
            '<span>Name *</span>' +
            '<input id="pcName" type="text" value="' + escapeAttr(prefill.name || '') + '" placeholder="e.g. Indigo West Roof Inspection" autofocus />' +
          '</label>' +
          '<label class="p86-field">' +
            '<span>Site address</span>' +
            '<textarea id="pcAddress" rows="2" placeholder="Street, City, State ZIP — powers map view, weather, and reports">' + escapeHTML(prefill.address_text || '') + '</textarea>' +
          '</label>' +
          '<label class="p86-field">' +
            '<span>Description</span>' +
            '<textarea id="pcDesc" rows="3" placeholder="Scope / context (optional)">' + escapeHTML(prefill.description || '') + '</textarea>' +
          '</label>' +
          '<div class="p86-field">' +
            '<span>Link to</span>' +
            '<div id="pcLinkChips" class="p86-proj-link-chips"></div>' +
            '<button type="button" id="pcLinkBtn" class="ee-btn secondary p86-proj-link-btn">&#x1F517; Link to lead, job, or client…</button>' +
          '</div>' +
          // (Tags field removed — projects don't carry their own
          // tags. Use photo tags inside the project for taxonomy.)
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          '<button class="primary" id="pcCreate">Create</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });

    // (Tag editor for the create modal removed alongside the field
    // above — projects don't carry their own tags.)

    // Paint the current link chips below the Link button. Click a chip
    // to remove that linkage.
    function paintLinkChips() {
      var host = modal.querySelector('#pcLinkChips');
      if (!host) return;
      var chips = [];
      if (pendingLink.lead_id) {
        var l = ((window.appData && window.appData.leads) || []).find(function(x) { return String(x.id) === String(pendingLink.lead_id); });
        chips.push({ k: 'Lead', label: (l && l.title) || pendingLink.lead_id, kind: 'lead' });
      }
      if (pendingLink.job_id) {
        var j = ((window.appData && window.appData.jobs) || []).find(function(x) { return String(x.id) === String(pendingLink.job_id); });
        chips.push({ k: 'Job', label: (j && (j.title || j.name)) || pendingLink.job_id, kind: 'job' });
      }
      if (pendingLink.client_id) {
        var c = ((window.appData && window.appData.clients) || []).find(function(x) { return String(x.id) === String(pendingLink.client_id); });
        chips.push({ k: 'Client', label: (c && c.name) || pendingLink.client_id, kind: 'client' });
      }
      if (!chips.length) {
        host.innerHTML = '<div class="p86-proj-empty-line">Not linked yet.</div>';
        return;
      }
      host.innerHTML = chips.map(function(ch) {
        return '<span class="p86-proj-link-chip" data-unlink="' + ch.kind + '">' +
          '<strong>' + escapeHTML(ch.k) + ':</strong> ' + escapeHTML(ch.label) +
          ' <button type="button" title="Unlink" data-unlink="' + ch.kind + '">&times;</button>' +
        '</span>';
      }).join('');
      host.querySelectorAll('[data-unlink]').forEach(function(el) {
        if (el.tagName !== 'BUTTON') return;
        el.addEventListener('click', function() {
          var kind = el.getAttribute('data-unlink');
          if (kind === 'lead')   pendingLink.lead_id = null;
          if (kind === 'job')    pendingLink.job_id = null;
          if (kind === 'client') pendingLink.client_id = null;
          paintLinkChips();
        });
      });
    }

    modal.querySelector('#pcLinkBtn').addEventListener('click', function() {
      openLinkPicker(function(picked) {
        if (!picked) return;
        // Apply the picked linkage + auto-fill name + address.
        if (picked.kind === 'lead')   pendingLink.lead_id = picked.id;
        if (picked.kind === 'job')    pendingLink.job_id = picked.id;
        if (picked.kind === 'client') pendingLink.client_id = picked.id;

        // If a lead carries a client_id, link the client too — same
        // posture as the Edit Links inherit behavior.
        if (picked.kind === 'lead' && picked.client_id) {
          pendingLink.client_id = picked.client_id;
        }

        // Auto-fill name + address from the picked entity if those
        // fields are still empty. If the user already typed values,
        // leave them — explicit input wins.
        var nameEl = modal.querySelector('#pcName');
        var addrEl = modal.querySelector('#pcAddress');
        if (nameEl && !nameEl.value && picked.name) nameEl.value = picked.name;
        if (addrEl && !addrEl.value && picked.address) addrEl.value = picked.address;
        paintLinkChips();
      });
    });

    paintLinkChips();

    modal.querySelector('#pcCreate').addEventListener('click', function() {
      var name = (modal.querySelector('#pcName').value || '').trim();
      if (!name) {
        modal.querySelector('#pcName').focus();
        return;
      }
      var body = {
        name: name,
        address_text: (modal.querySelector('#pcAddress').value || '').trim() || null,
        description: (modal.querySelector('#pcDesc').value || '').trim() || null,
        lead_id: pendingLink.lead_id || null,
        job_id: pendingLink.job_id || null,
        client_id: pendingLink.client_id || null
      };
      if (!api()) { alert('API not available'); return; }
      api().create(body).then(function(r) {
        var p = r && r.project;
        modal.remove();
        if (_listState.host) fetchAll().then(paintList);
        refreshLinkedPanels();
        if (p && p.id) {
          openProject(p.id);
          // Optional follow-up hook — used by the "New Report" summary
          // flow so the chosen template auto-creates a report inside
          // the brand-new project once openProject finishes painting.
          if (typeof options.afterCreate === 'function') {
            options.afterCreate(p.id);
          }
        }
      }).catch(function(err) {
        alert('Create failed: ' + (err.message || err));
      });
    });
  }

  // Unified entity picker — searchable list of leads + jobs + clients.
  // Called from the New Project modal (and could be reused by the
  // Edit Links modal). cb(picked) where picked = { kind, id, name, address, client_id? }
  function openLinkPicker(cb) {
    var prior = document.getElementById('projLinkPicker');
    if (prior) prior.remove();

    // Pull caches; ensureEntityCaches has already fired from openCreate
    // so the data should be warm. Use whatever's cached + refresh in
    // the background.
    var leadList = (window.appData && window.appData.leads) || [];
    var jobList = (window.appData && window.appData.jobs) || [];
    var clientList = (window.appData && window.appData.clients) || [];

    var state = { kind: 'lead', q: '' };

    var modal = document.createElement('div');
    modal.id = 'projLinkPicker';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:680px;">' +
        '<div class="modal-header">' +
          '<span>Link to lead, job, or client</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-proj-create-body" style="padding-top:0;">' +
          '<div style="display:flex;gap:6px;margin-bottom:10px;border-bottom:1px solid var(--border, #333);">' +
            '<button class="p86-link-picker-tab active" data-kind="lead">Leads</button>' +
            '<button class="p86-link-picker-tab" data-kind="job">Jobs</button>' +
            '<button class="p86-link-picker-tab" data-kind="client">Clients</button>' +
          '</div>' +
          '<input id="lpSearch" type="search" placeholder="Search…" class="p86-link-picker-search" autofocus />' +
          '<div id="lpResults" class="p86-link-picker-results"></div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) { if (e.target === modal) close(null); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { close(null); });
    });

    function close(picked) {
      modal.remove();
      cb(picked);
    }

    function paint() {
      modal.querySelectorAll('.p86-link-picker-tab').forEach(function(btn) {
        btn.classList.toggle('active', btn.getAttribute('data-kind') === state.kind);
      });
      var results = modal.querySelector('#lpResults');
      var q = state.q.trim().toLowerCase();
      var rows;
      if (state.kind === 'lead') {
        rows = leadList.filter(function(l) {
          if (!q) return true;
          return ((l.title || '') + ' ' + (l.street_address || '') + ' ' + (l.city || '')).toLowerCase().indexOf(q) !== -1;
        }).slice(0, 100);
        results.innerHTML = rows.length
          ? rows.map(function(l) {
              var addr = composeLeadAddress(l);
              return linkPickerRowHTML('lead', l.id, l.title || ('Lead ' + l.id), addr, '');
            }).join('')
          : '<div class="p86-proj-empty-line">No leads match.</div>';
      } else if (state.kind === 'job') {
        rows = jobList.filter(function(j) {
          if (!q) return true;
          var label = (j.title || j.name || '') + ' ' + (j.jobNumber || '');
          return label.toLowerCase().indexOf(q) !== -1;
        }).slice(0, 100);
        results.innerHTML = rows.length
          ? rows.map(function(j) {
              var label = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id);
              return linkPickerRowHTML('job', j.id, label, composeJobAddress(j), '');
            }).join('')
          : '<div class="p86-proj-empty-line">No jobs match.</div>';
      } else {
        rows = clientList.filter(function(c) {
          if (!q) return true;
          return ((c.name || '') + ' ' + (c.company_name || '') + ' ' + (c.community_name || '')).toLowerCase().indexOf(q) !== -1;
        }).slice(0, 100);
        results.innerHTML = rows.length
          ? rows.map(function(c) {
              return linkPickerRowHTML('client', c.id, c.name || ('Client ' + c.id), composeClientAddress(c), c.company_name || c.community_name || '');
            }).join('')
          : '<div class="p86-proj-empty-line">No clients match.</div>';
      }
      results.querySelectorAll('[data-pick]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var kind = btn.getAttribute('data-pick-kind');
          var id = btn.getAttribute('data-pick');
          var picked = { kind: kind, id: id };
          if (kind === 'lead') {
            var lead = leadList.find(function(x) { return String(x.id) === String(id); });
            if (lead) {
              picked.name = lead.title || '';
              picked.address = composeLeadAddress(lead);
              picked.client_id = lead.client_id || null;
            }
          } else if (kind === 'job') {
            var job = jobList.find(function(x) { return String(x.id) === String(id); });
            if (job) {
              picked.name = job.title || job.name || '';
              picked.address = composeJobAddress(job);
            }
          } else if (kind === 'client') {
            var client = clientList.find(function(x) { return String(x.id) === String(id); });
            if (client) {
              picked.name = client.name || '';
              picked.address = composeClientAddress(client);
            }
          }
          close(picked);
        });
      });
    }

    modal.querySelectorAll('.p86-link-picker-tab').forEach(function(btn) {
      btn.addEventListener('click', function() {
        state.kind = btn.getAttribute('data-kind');
        paint();
      });
    });
    var searchEl = modal.querySelector('#lpSearch');
    var t;
    searchEl.addEventListener('input', function(e) {
      clearTimeout(t);
      t = setTimeout(function() {
        state.q = e.target.value;
        paint();
      }, 100);
    });

    paint();

    // Refresh caches in the background; re-paint when fresh data lands.
    ensureEntityCaches().then(function() {
      if (!document.body.contains(modal)) return;
      leadList = (window.appData && window.appData.leads) || [];
      jobList = (window.appData && window.appData.jobs) || [];
      clientList = (window.appData && window.appData.clients) || [];
      paint();
    });
  }

  function linkPickerRowHTML(kind, id, label, address, sublabel) {
    return '<button class="p86-link-picker-row" data-pick="' + escapeAttr(id) + '" data-pick-kind="' + kind + '" type="button">' +
      '<div class="p86-link-picker-row-main">' +
        '<div class="p86-link-picker-row-label">' + escapeHTML(label) + '</div>' +
        (sublabel ? '<div class="p86-link-picker-row-sub">' + escapeHTML(sublabel) + '</div>' : '') +
        (address ? '<div class="p86-link-picker-row-addr">' + escapeHTML(address) + '</div>' : '') +
      '</div>' +
      '<span class="p86-link-picker-row-arrow">&rsaquo;</span>' +
    '</button>';
  }

  // Backwards-compat — older call sites use createPrompt / createForEntity.
  function createPrompt(prefill) { openCreate(prefill); return Promise.resolve(null); }
  function createForEntity(kind, id) {
    var inherited = inheritFromEntity(kind, id);
    var prefill = {};
    if (inherited.name)    prefill.name = inherited.name;
    if (inherited.address) prefill.address_text = inherited.address;
    if (kind === 'lead')   {
      prefill.lead_id = id;
      if (inherited.client_id) prefill.client_id = inherited.client_id;
    }
    if (kind === 'job')    prefill.job_id = id;
    if (kind === 'client') prefill.client_id = id;
    openCreate(prefill);
  }

  // Compose an address string from a lead row (street + city + state + zip).
  // Skips blank pieces cleanly so we don't end up with double commas.
  function composeLeadAddress(l) {
    if (!l) return '';
    var parts = [];
    if (l.street_address) parts.push(String(l.street_address).trim());
    var cityStateZip = [];
    if (l.city) cityStateZip.push(String(l.city).trim());
    if (l.state) cityStateZip.push(String(l.state).trim());
    if (l.zip) cityStateZip.push(String(l.zip).trim());
    if (cityStateZip.length) parts.push(cityStateZip.join(', '));
    return parts.filter(Boolean).join(', ');
  }
  // Job: data.address > data.buildings[0].address (same priority as the
  // weather route uses) so we don't surprise the user with a different
  // address than what the schedule/weather already know about.
  function composeJobAddress(j) {
    if (!j) return '';
    var d = j.data || j;
    if (d.address && String(d.address).trim()) return String(d.address).trim();
    var bldgs = Array.isArray(d.buildings) ? d.buildings : [];
    for (var i = 0; i < bldgs.length; i++) {
      if (bldgs[i] && bldgs[i].address && String(bldgs[i].address).trim()) {
        return String(bldgs[i].address).trim();
      }
    }
    return '';
  }
  // Client: property_address > mailing address composed from columns.
  function composeClientAddress(c) {
    if (!c) return '';
    if (c.property_address && String(c.property_address).trim()) {
      return String(c.property_address).trim();
    }
    var parts = [];
    if (c.address) parts.push(String(c.address).trim());
    var rest = [];
    if (c.city) rest.push(String(c.city).trim());
    if (c.state) rest.push(String(c.state).trim());
    if (c.zip) rest.push(String(c.zip).trim());
    if (rest.length) parts.push(rest.join(', '));
    return parts.filter(Boolean).join(', ');
  }

  // Return { name, address, client_id? } inherited from a lead/job/client.
  // Used at project creation AND on link change so the project tracks
  // the entity it's tied to.
  function inheritFromEntity(kind, id) {
    if (kind === 'lead') {
      var l = ((window.appData && window.appData.leads) || []).find(function(x) { return String(x.id) === String(id); });
      if (!l) return {};
      return {
        name: l.title || '',
        address: composeLeadAddress(l),
        client_id: l.client_id || null
      };
    }
    if (kind === 'job') {
      var j = ((window.appData && window.appData.jobs) || []).find(function(x) { return String(x.id) === String(id); });
      if (!j) return {};
      var d = j.data || j;
      return {
        name: d.title || d.name || '',
        address: composeJobAddress(j)
      };
    }
    if (kind === 'client') {
      var c = ((window.appData && window.appData.clients) || []).find(function(x) { return String(x.id) === String(id); });
      if (!c) return {};
      return {
        name: c.name || '',
        address: composeClientAddress(c)
      };
    }
    return {};
  }

  // ──────────────────────────────────────────────────────────────────
  // Tag editor (reusable — works for create modal and detail header).
  //   opts.getTags() → string[]
  //   opts.setTags(string[]) → void  (parent persists)
  // ──────────────────────────────────────────────────────────────────
  function mountTagEditor(host, opts) {
    if (!host) return;
    function paint() {
      var tags = opts.getTags();
      host.innerHTML =
        '<div class="p86-tag-editor-chips">' +
          tags.map(function(t, i) {
            return '<span class="p86-chip-tag" style="--h:' + hueFor(t) + ';">' +
              '#' + escapeHTML(t) +
              '<button type="button" class="p86-tag-remove" data-idx="' + i + '">&times;</button>' +
            '</span>';
          }).join('') +
        '</div>' +
        '<div class="p86-tag-editor-input-wrap">' +
          '<input type="text" class="p86-tag-editor-input" placeholder="+ Add tag…" />' +
          '<div class="p86-tag-suggest" style="display:none;"></div>' +
        '</div>';

      host.querySelectorAll('.p86-tag-remove').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var idx = Number(btn.getAttribute('data-idx'));
          var next = opts.getTags().slice();
          next.splice(idx, 1);
          opts.setTags(next);
          paint();
        });
      });

      var input = host.querySelector('.p86-tag-editor-input');
      var suggestEl = host.querySelector('.p86-tag-suggest');

      function commit(value) {
        var clean = String(value || '').trim().toLowerCase().slice(0, 32);
        if (!clean) return;
        var current = opts.getTags();
        if (current.indexOf(clean) !== -1) return;
        if (current.length >= 20) {
          alert('Up to 20 tags per project.');
          return;
        }
        opts.setTags(current.concat([clean]));
        paint();
        // Keep focus in the input so users can add multiple in a row.
        var newInput = host.querySelector('.p86-tag-editor-input');
        if (newInput) newInput.focus();
      }

      function renderSuggest(list) {
        var current = opts.getTags();
        var typed = String(input.value || '').trim().toLowerCase().slice(0, 32);
        // Suggestions from the catalog, minus anything already on
        // this entity. orgTags.suggest returns them in use_count DESC
        // order — most-used first — so the visible list IS the
        // favorites list.
        var filtered = (list || []).filter(function(t) {
          return current.indexOf(t) === -1;
        }).slice(0, 8);
        // "Create" entry — only when the user has typed something
        // that isn't already on this entity AND isn't already an
        // exact-match suggestion AND looks like a valid tag. Gives
        // the user a single-click way to mint a brand-new tag
        // without having to know about the Enter/comma shortcut.
        var canCreate = !!typed
          && current.indexOf(typed) === -1
          && filtered.indexOf(typed) === -1;
        if (!filtered.length && !canCreate) {
          suggestEl.style.display = 'none';
          return;
        }
        var html = '';
        if (canCreate) {
          html += '<div class="p86-tag-suggest-create-row">' +
            '<button type="button" class="p86-tag-suggest-create" data-create="' + escapeAttr(typed) + '">' +
              '<span class="p86-tag-suggest-create-plus">&#x2295;</span>' +
              '<span>Create <strong>#' + escapeHTML(typed) + '</strong></span>' +
            '</button>' +
          '</div>';
        }
        if (filtered.length) {
          // Only show the "Favorites" / "Top tags" header when the
          // input is empty (focus dropdown). When the user is
          // typing, the same list is filtered matches, not favorites
          // — labeling it "Favorites" would be misleading.
          if (!typed) {
            html += '<div class="p86-tag-suggest-header">Favorites &middot; tap to add</div>';
          }
          html += '<div class="p86-tag-suggest-rows">' +
            filtered.map(function(t) {
              return '<button type="button" class="p86-tag-suggest-row" data-tag="' + escapeAttr(t) + '" style="--h:' + hueFor(t) + ';">#' + escapeHTML(t) + '</button>';
            }).join('') +
          '</div>';
        }
        suggestEl.innerHTML = html;
        suggestEl.style.display = 'block';
        // Wire both the existing-tag rows and the new Create row to
        // the same commit path. mousedown (not click) so the input
        // doesn't lose focus before the handler fires.
        suggestEl.querySelectorAll('.p86-tag-suggest-row').forEach(function(b) {
          b.addEventListener('mousedown', function(e) {
            e.preventDefault();
            commit(b.getAttribute('data-tag'));
            input.value = '';
            suggestEl.style.display = 'none';
          });
        });
        var createBtn = suggestEl.querySelector('.p86-tag-suggest-create');
        if (createBtn) createBtn.addEventListener('mousedown', function(e) {
          e.preventDefault();
          commit(createBtn.getAttribute('data-create'));
          input.value = '';
          suggestEl.style.display = 'none';
        });
      }

      // The editor can be pointed at any suggest source — project
      // tags, attachment tags, etc. Default (Phase 1.7): the org-wide
      // tag catalog, so tags shared across projects show up first.
      // Falls back to the older project-tag suggest if the org
      // catalog endpoint isn't available (during deploy rollover).
      var suggestFn = opts.suggestFn || function(q) {
        if (window.p86Api && window.p86Api.orgTags && window.p86Api.orgTags.suggest) {
          return window.p86Api.orgTags.suggest(q);
        }
        if (window.p86Api && window.p86Api.projects && window.p86Api.projects.suggestTags) {
          return window.p86Api.projects.suggestTags(q);
        }
        return Promise.resolve({ tags: [] });
      };

      // Cache the most recently fetched suggestion list so the
      // dropdown can re-render the "Create '<typed>'" row instantly
      // on every keystroke while the actual catalog query stays
      // debounced. Without the cache the Create row would lag the
      // input by 150ms — feels broken.
      var fetchTimer;
      var lastSuggestList = [];
      input.addEventListener('input', function(e) {
        // Re-render synchronously with the cached list so the Create
        // row updates immediately.
        renderSuggest(lastSuggestList);
        clearTimeout(fetchTimer);
        var q = e.target.value;
        fetchTimer = setTimeout(function() {
          suggestFn(q).then(function(r) {
            lastSuggestList = (r && r.tags) || [];
            renderSuggest(lastSuggestList);
          }).catch(function() {});
        }, 150);
      });
      input.addEventListener('focus', function() {
        suggestFn('').then(function(r) {
          lastSuggestList = (r && r.tags) || [];
          renderSuggest(lastSuggestList);
        }).catch(function() {});
      });
      input.addEventListener('blur', function() {
        // Delay hiding so mousedown on a suggestion can fire first.
        setTimeout(function() { suggestEl.style.display = 'none'; }, 150);
      });
      input.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ',') {
          e.preventDefault();
          commit(input.value);
          input.value = '';
          suggestEl.style.display = 'none';
        } else if (e.key === 'Backspace' && !input.value) {
          var current = opts.getTags();
          if (current.length) {
            var next = current.slice(0, -1);
            opts.setTags(next);
            paint();
          }
        }
      });
    }
    paint();
  }

  // ──────────────────────────────────────────────────────────────────
  // Detail overlay
  // ──────────────────────────────────────────────────────────────────
  function openProject(projectId) {
    _detailState.projectId = projectId;
    _detailState.project = null;
    _detailState.pairs = [];
    _detailState.activity = [];
    _detailState.photos = [];
    var overlay = ensureDetailOverlay();
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    // Register close handler so Android back / browser back closes
    // this overlay instead of navigating away from the page.
    pushOverlay(closeDetailImpl);
    paintDetailLoading();
    if (!api()) {
      paintDetailError('API not available');
      return;
    }
    var reportsPromise = (window.p86Api && window.p86Api.reports)
      ? window.p86Api.reports.list('project', projectId).catch(function() { return { reports: [] }; })
      : Promise.resolve({ reports: [] });
    Promise.all([
      api().get(projectId),
      api().pairs.list(projectId).catch(function() { return { pairs: [] }; }),
      api().activity(projectId, { limit: 50 }).catch(function() { return { activity: [] }; }),
      window.p86Api.attachments.list('project', projectId).catch(function() { return { attachments: [] }; }),
      reportsPromise
    ]).then(function(results) {
      _detailState.project = results[0] && results[0].project;
      _detailState.pairs = (results[1] && results[1].pairs) || [];
      _detailState.activity = (results[2] && results[2].activity) || [];
      _detailState.photos = (results[3] && results[3].attachments) || [];
      _detailState.reports = (results[4] && results[4].reports) || [];
      _detailState.reportsCount = _detailState.reports.length;
      _detailState.activeTab = _detailState.activeTab || 'photos';
      paintDetail();
    }).catch(function(e) {
      paintDetailError(e.message || 'Failed to load project');
    });
  }
  window.openProject = openProject;

  // Public close — routed through the overlay stack so Android back +
  // X-button + backdrop-click all flow through the same code path.
  // Distinguish "I'm closing because the user pressed back (popstate
  // already fired)" from "I'm closing because the user clicked X
  // (need to fire history.back())" using _overlayStack membership.
  function closeDetail() {
    // If our close is the top of the overlay stack, popstate is the
    // natural exit — calling closeTopOverlay() runs history.back()
    // which fires popstate which removes the DOM.
    var hasOurClose = _overlayStack.indexOf(closeDetailImpl) !== -1;
    if (hasOurClose) {
      closeTopOverlay();
    } else {
      closeDetailImpl();
    }
  }
  // DOM-side close. Idempotent — running it twice is a no-op.
  function closeDetailImpl() {
    if (!_detailState.projectId) return;
    _detailState.projectId = null;
    _detailState.project = null;
    var overlay = document.getElementById('projDetailOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
    if (_listState.host) fetchAll().then(paintList);
    refreshLinkedPanels();
  }
  window.closeProjectDetail = closeDetail;

  function ensureDetailOverlay() {
    var el = document.getElementById('projDetailOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'projDetailOverlay';
    el.className = 'p86-proj-detail-overlay';
    el.innerHTML = '<div id="projDetailHost" class="p86-proj-detail-host"></div>';
    el.addEventListener('click', function(e) {
      if (e.target === el) closeDetail();
    });
    document.body.appendChild(el);
    return el;
  }

  function paintDetailLoading() {
    var host = document.getElementById('projDetailHost');
    if (!host) return;
    host.innerHTML =
      '<div class="p86-proj-detail-header">' +
        '<div style="color:var(--text-dim,#888);">Loading project…</div>' +
        '<button class="ee-btn secondary" onclick="window.closeProjectDetail()">&times; Close</button>' +
      '</div>';
  }

  function paintDetailError(msg) {
    var host = document.getElementById('projDetailHost');
    if (!host) return;
    host.innerHTML =
      '<div class="p86-proj-detail-header">' +
        '<div style="color:#f87171;">' + escapeHTML(msg) + '</div>' +
        '<button class="ee-btn secondary" onclick="window.closeProjectDetail()">&times; Close</button>' +
      '</div>';
  }

  function paintDetail() {
    var host = document.getElementById('projDetailHost');
    var p = _detailState.project;
    if (!host || !p) return;

    // Reset per-paint UI state.
    _detailState.photoFilter = _detailState.photoFilter || { tag: '', uploader: '', start: '', end: '' };
    _detailState.selection = _detailState.selection || new Set();

    var coverUrl = p.cover_thumb_url || p.cover_web_url || '';
    var coverThumb = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-proj-header-cover-img" />'
      : '<div class="p86-proj-header-cover-empty">&#x1F4F8;</div>';

    var linkBadges = [];
    if (p.lead_id)    linkBadges.push({ k: 'Lead',   v: p.lead_title || p.lead_id });
    if (p.job_id)     linkBadges.push({ k: 'Job',    v: p.job_name || p.job_id });
    if (p.client_id)  linkBadges.push({ k: 'Client', v: p.client_name || p.client_id });

    var addr = (p.address_text || '').trim();

    // CompanyCam-style compact header: small square cover thumb +
    // name + address + link badges on the right; action row above.
    host.innerHTML =
      // Top breadcrumb + action row
      '<div class="p86-proj-detail-breadcrumb">' +
        '<button class="p86-proj-back-btn" onclick="window.closeProjectDetail()">&lsaquo; Projects</button>' +
        '<div class="p86-proj-detail-toolbar">' +
          (p.archived_at
            ? '<button class="ee-btn secondary" onclick="window.p86Projects.unarchive()">&#x21BA; Unarchive</button>'
            : '<button class="ee-btn secondary" onclick="window.p86Projects.archive()" title="Archive project">&#x1F5C4; Archive</button>') +
          '<button class="ee-btn secondary" onclick="window.p86Projects.editLinks()">Edit links</button>' +
          '<button class="p86-proj-icon-btn" onclick="window.closeProjectDetail()" title="Close">&times;</button>' +
        '</div>' +
      '</div>' +

      // Compact header: cover thumb · title + address · linkages.
      // (Project-level tag editor removed — projects don't carry
      // their own tags any more. Description covers that role; photo
      // tags inside the project handle taxonomy / drill-in.)
      '<div class="p86-proj-header-row">' +
        '<div class="p86-proj-header-cover">' + coverThumb + '</div>' +
        '<div class="p86-proj-header-info">' +
          '<input id="projNameInput" value="' + escapeAttr(p.name) + '" class="p86-proj-header-name" placeholder="Project name" />' +
          '<input id="projAddrInput" value="' + escapeAttr(p.address_text || '') + '" placeholder="Site address" class="p86-proj-header-addr" />' +
        '</div>' +
        '<div class="p86-proj-header-side">' +
          (linkBadges.length
            ? linkBadges.map(function(b) {
                return '<div class="p86-proj-link-row"><span class="p86-proj-link-k">' + escapeHTML(b.k) + ':</span> ' + escapeHTML(b.v) + '</div>';
              }).join('')
            : '<div class="p86-proj-empty-line">Not linked yet.</div>') +
          '<div id="projDetailWeather" class="p86-proj-detail-weather"></div>' +
          '<div class="p86-proj-header-meta">Updated ' + escapeHTML(fmtRelative(p.updated_at)) +
            (p.created_by_name ? ' &middot; ' + escapeHTML(p.created_by_name) : '') +
          '</div>' +
        '</div>' +
      '</div>' +

      // Tab strip. Photos | Reports | Files — all active. Counts are
      // recomputed each paintDetail() to reflect the current data.
      (function() {
        var imageCount = _detailState.photos.filter(function(a) { return a.mime_type && /^image\//.test(a.mime_type); }).length;
        var fileCount = _detailState.photos.length - imageCount;
        var reportCount = _detailState.reportsCount || 0;
        var active = _detailState.activeTab || 'photos';
        return '<div class="p86-proj-tabs">' +
          '<button class="p86-proj-tab' + (active === 'photos' ? ' active' : '') + '" onclick="window.p86Projects.switchTab(\'photos\')">Photos <span class="p86-proj-tab-count">(' + imageCount + ')</span></button>' +
          '<button class="p86-proj-tab' + (active === 'reports' ? ' active' : '') + '" onclick="window.p86Projects.switchTab(\'reports\')">Reports <span class="p86-proj-tab-count">(' + reportCount + ')</span></button>' +
          '<button class="p86-proj-tab' + (active === 'files' ? ' active' : '') + '" onclick="window.p86Projects.switchTab(\'files\')">Files <span class="p86-proj-tab-count">(' + fileCount + ')</span></button>' +
          '<button class="p86-proj-tab' + (active === 'tasks' ? ' active' : '') + '" onclick="window.p86Projects.switchTab(\'tasks\')">Tasks</button>' +
        '</div>';
      })() +

      // Tab content host — only one of photos/reports/files renders
      // at a time. We always inject all three blocks and toggle CSS
      // visibility via the active state so switching tabs doesn't
      // re-fetch attachments.
      '<div id="projTabContent">' +

      // ===== PHOTOS TAB =====
      '<div id="projTabPhotos" class="p86-proj-tab-pane"' + ((_detailState.activeTab || 'photos') === 'photos' ? '' : ' style="display:none;"') + '>' +

      // Filter toolbar — date range + uploader + view + upload.
      // The date range is collapsed behind a single "Date" pill with
      // preset shortcuts (Today / Last 7 / Last 30 / Custom). Custom
      // reveals the two date inputs inline. The presets cover ~95%
      // of real usage so the toolbar isn't dominated by two empty
      // mm/dd/yyyy boxes.
      '<div class="p86-proj-filter-toolbar">' +
        '<div class="p86-proj-filter-group">' +
          dateFilterPillHTML(_detailState.photoFilter) +
          '<select id="projFilterUploader" class="p86-proj-filter-select" title="Uploader">' +
            '<option value="">Users ▾</option>' +
            buildUploaderOptions() +
          '</select>' +
        '</div>' +
        '<div class="p86-proj-filter-actions">' +
          // Tile-size picker — three-button toggle (compact / normal /
          // spacious) sets a data-size attribute on #projPhotoFeed
          // which CSS variant rules read to switch the grid's
          // minmax floor. Choice is per-user (localStorage), not
          // per-project, since it's a UI preference. Active button
          // is restored on paint() from the saved value.
          (function() {
            var current = _photoTileSize();
            var btn = function(size, label, title) {
              return '<button type="button" class="p86-tile-size-btn' + (current === size ? ' active' : '') + '"' +
                ' data-tile-size="' + size + '" title="' + escapeAttr(title) + '">' + label + '</button>';
            };
            return '<div class="p86-tile-size-picker" role="group" aria-label="Tile size">' +
              btn('compact',  '&#x2630;', 'Compact tiles')  +
              btn('normal',   '&#x25A6;', 'Normal tiles')   +
              btn('spacious', '&#x25A3;', 'Spacious tiles') +
            '</div>';
          })() +
          '<button class="primary" onclick="document.getElementById(\'projPhotoFileInput\').click();">&#x2795; Upload Photos</button>' +
          '<input type="file" id="projPhotoFileInput" multiple accept="image/*,application/pdf" capture="environment" style="display:none;" />' +
        '</div>' +
      '</div>' +

      // Tag filter chip strip
      '<div id="projTagChipStrip" class="p86-proj-tag-strip"></div>' +

      // Walkthrough sticky tags — persists between photo uploads
      // (Phase 1.7). Shows only when at least one sticky tag is set.
      '<div id="projWalkthroughTagStrip" class="p86-walkthrough-strip" style="display:none;"></div>' +

      // Photo feed (date-grouped grid; rendered by paintPhotoFeed)
      '<div id="projPhotoFeed" class="p86-proj-photo-feed"></div>' +

      '</div>' + // end #projTabPhotos

      // ===== REPORTS TAB =====
      '<div id="projTabReports" class="p86-proj-tab-pane"' + (_detailState.activeTab === 'reports' ? '' : ' style="display:none;"') + '>' +
        '<div id="projReportsHost"><div class="p86-proj-empty-line">Loading reports…</div></div>' +
      '</div>' +

      // ===== FILES TAB =====
      '<div id="projTabFiles" class="p86-proj-tab-pane"' + (_detailState.activeTab === 'files' ? '' : ' style="display:none;"') + '>' +
        '<div id="projFilesHost"></div>' +
      '</div>' +

      // ===== TASKS TAB =====
      '<div id="projTabTasks" class="p86-proj-tab-pane"' + (_detailState.activeTab === 'tasks' ? '' : ' style="display:none;"') + '>' +
        '<div id="projTasksHost"></div>' +
      '</div>' +

      '</div>' + // end #projTabContent

      // Secondary zone: description + map + activity. Tucked under
      // the photos because the photos are the point of the page;
      // these are reference material.
      '<details class="p86-proj-secondary" open>' +
        '<summary class="p86-proj-activity-summary">' +
          '<span>Project details</span>' +
          '<span class="p86-proj-activity-chevron">&#x25BE;</span>' +
        '</summary>' +
        '<div class="p86-proj-secondary-grid">' +
          '<fieldset class="p86-proj-fieldset">' +
            '<legend>Description</legend>' +
            '<textarea id="projDescInput" rows="4" placeholder="Optional notes about the project / walkthrough scope." class="p86-proj-textarea">' + escapeHTML(p.description || '') + '</textarea>' +
          '</fieldset>' +
          '<fieldset class="p86-proj-fieldset" style="padding:0;overflow:hidden;">' +
            '<legend style="margin-left:8px;">Map</legend>' +
            (addr
              ? '<iframe class="p86-proj-detail-map-frame" src="https://www.google.com/maps?q=' + encodeURIComponent(addr) + '&output=embed&z=16" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>'
              : '<div class="p86-proj-detail-map-empty">Add an address to drop a pin here.</div>') +
          '</fieldset>' +
        '</div>' +
      '</details>' +

      '<details class="p86-proj-activity-details">' +
        '<summary class="p86-proj-activity-summary">' +
          '<span>&#x1F4DC; Activity <span class="p86-proj-legend-count">(' + (_detailState.activity.length) + ')</span></span>' +
          '<span class="p86-proj-activity-chevron">&#x25BE;</span>' +
        '</summary>' +
        '<div id="projActivityHost" class="p86-proj-activity-body"></div>' +
      '</details>';

    // Wire blur-save for name / address / description.
    var nameEl = host.querySelector('#projNameInput');
    var addrEl = host.querySelector('#projAddrInput');
    var descEl = host.querySelector('#projDescInput');
    if (nameEl) nameEl.addEventListener('blur', function() { _fieldBlur('name', nameEl.value); });
    if (addrEl) addrEl.addEventListener('blur', function() { _fieldBlur('address_text', addrEl.value); });
    if (descEl) descEl.addEventListener('blur', function() { _fieldBlur('description', descEl.value); });

    // Wire filter inputs.
    var startEl = host.querySelector('#projFilterStart');
    var endEl = host.querySelector('#projFilterEnd');
    var uploaderEl = host.querySelector('#projFilterUploader');
    if (uploaderEl) uploaderEl.value = _detailState.photoFilter.uploader || '';
    if (startEl) startEl.addEventListener('change', function() {
      _detailState.photoFilter.start = startEl.value;
      _detailState.photoFilter.datePreset = 'custom';
      paintPhotoFeed(); paintTagChipStrip(); _refreshDateFilterLabel();
    });
    if (endEl) endEl.addEventListener('change', function() {
      _detailState.photoFilter.end = endEl.value;
      _detailState.photoFilter.datePreset = 'custom';
      paintPhotoFeed(); paintTagChipStrip(); _refreshDateFilterLabel();
    });
    if (uploaderEl) uploaderEl.addEventListener('change', function() { _detailState.photoFilter.uploader = uploaderEl.value; paintPhotoFeed(); paintTagChipStrip(); });

    // Date-filter pill: trigger toggles the menu open/closed; menu
    // closes when the user clicks outside. Preset buttons set the
    // filter range and close the menu (except "Custom" which reveals
    // the inline mm/dd/yyyy inputs).
    var datePill = host.querySelector('#projFilterDate');
    var dateTrigger = host.querySelector('#projFilterDateTrigger');
    var dateMenu = host.querySelector('#projFilterDateMenu');
    if (dateTrigger && dateMenu) {
      dateTrigger.addEventListener('click', function(e) {
        e.stopPropagation();
        var open = dateMenu.style.display !== 'none';
        dateMenu.style.display = open ? 'none' : 'block';
      });
      // Outside-click closes the menu. Bound to document but ignores
      // clicks that landed inside the pill.
      document.addEventListener('click', function onAwayDate(e) {
        if (!datePill.isConnected) {
          document.removeEventListener('click', onAwayDate);
          return;
        }
        if (datePill.contains(e.target)) return;
        dateMenu.style.display = 'none';
      });
      // Preset buttons.
      dateMenu.querySelectorAll('[data-date-preset]').forEach(function(btn) {
        btn.addEventListener('click', function(e) {
          e.stopPropagation();
          var preset = btn.getAttribute('data-date-preset');
          _detailState.photoFilter.datePreset = preset;
          var range = _applyDatePreset(preset);
          if (range) {
            _detailState.photoFilter.start = range.start;
            _detailState.photoFilter.end = range.end;
          }
          // Update active-button state without a full re-paint.
          dateMenu.querySelectorAll('[data-date-preset]').forEach(function(b) {
            b.classList.toggle('active', b === btn);
          });
          // Show/hide the inline custom inputs.
          var customRow = dateMenu.querySelector('.p86-proj-filter-date-custom');
          if (customRow) customRow.style.display = (preset === 'custom') ? '' : 'none';
          // Refresh the date inputs' values to match the preset.
          if (startEl) startEl.value = _detailState.photoFilter.start || '';
          if (endEl)   endEl.value   = _detailState.photoFilter.end   || '';
          _refreshDateFilterLabel();
          paintPhotoFeed();
          paintTagChipStrip();
          // Close the menu unless they picked Custom (they're likely
          // about to type a date).
          if (preset !== 'custom') dateMenu.style.display = 'none';
        });
      });
    }

    // Tile-size picker click handler. Delegated so the three
    // buttons share one listener; reads the data-tile-size attribute
    // off the clicked button. _setPhotoTileSize handles localStorage
    // + active-state sync + applying the data attribute to the feed.
    var tilePicker = host.querySelector('.p86-tile-size-picker');
    if (tilePicker) {
      tilePicker.addEventListener('click', function(e) {
        var btn = e.target.closest('[data-tile-size]');
        if (!btn) return;
        _setPhotoTileSize(btn.getAttribute('data-tile-size'));
      });
    }

    // Wire upload input. Walkthrough-loop heuristic mirrors the
    // photos-tab handler: single image file from a touch device =
    // camera capture, so keep the camera open after each save.
    var fileInput = host.querySelector('#projPhotoFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files.length) {
          var f = e.target.files[0];
          var isImage = f && f.type && /^image\//.test(f.type);
          var oneFile = e.target.files.length === 1;
          var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
          if (oneFile && isImage && touch) _walkthroughKeepOpen = true;
          uploadFiles(e.target.files);
        }
        fileInput.value = '';
      });
    }
    // Drag-drop on the feed.
    var feedHost = host.querySelector('#projPhotoFeed');
    if (feedHost) {
      feedHost.addEventListener('dragover', function(e) {
        e.preventDefault();
        feedHost.classList.add('p86-proj-drop-active');
      });
      feedHost.addEventListener('dragleave', function() {
        feedHost.classList.remove('p86-proj-drop-active');
      });
      feedHost.addEventListener('drop', function(e) {
        e.preventDefault();
        feedHost.classList.remove('p86-proj-drop-active');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          uploadFiles(e.dataTransfer.files);
        }
      });
    }

    // (Project-level tag editor wiring removed alongside its markup
    // and the create-modal field above.)

    paintTagChipStrip();
    paintWalkthroughTagStrip();
    paintPhotoFeed();
    paintActivityFeed();
    paintProjectWeather();

    // Gate the Description fieldset. The textarea already autosaves
    // on blur via _fieldBlur('description', ...) — the gate just
    // adds a pencil so a stray tap in the secondary "Project details"
    // panel can't trigger that autosave commit. Map fieldset has no
    // editable inputs so it doesn't need a gate.
    if (window.p86EditGate) {
      var descFieldset = host.querySelector('#projDescInput');
      descFieldset = descFieldset && descFieldset.closest('fieldset');
      if (descFieldset) window.p86EditGate.attachSection(descFieldset, { startUnlocked: false });
    }

    // Paint the current tab's body. Photos tab is wired by paintPhotoFeed
    // above; reports + files paint on demand to avoid round-trips before
    // the user actually clicks the tab.
    var activeTab = _detailState.activeTab || 'photos';
    if (activeTab === 'reports') paintReportsTab();
    else if (activeTab === 'files') paintFilesTab();
  }

  // Tab switcher — toggles visibility of the three tab panes and
  // paints the chosen one on demand. activeTab persists in
  // _detailState across paintDetail() calls within a single open.
  function switchTab(name) {
    if (!['photos', 'reports', 'files', 'tasks'].includes(name)) return;
    _detailState.activeTab = name;
    // Toggle pane visibility without a full re-render.
    var panes = { photos: 'projTabPhotos', reports: 'projTabReports', files: 'projTabFiles', tasks: 'projTabTasks' };
    Object.keys(panes).forEach(function(k) {
      var el = document.getElementById(panes[k]);
      if (el) el.style.display = (k === name) ? '' : 'none';
    });
    // Refresh the tab strip's active state.
    document.querySelectorAll('.p86-proj-tab').forEach(function(btn) {
      btn.classList.remove('active');
    });
    var tabs = document.querySelectorAll('.p86-proj-tab');
    tabs.forEach(function(btn) {
      var label = btn.textContent.trim().toLowerCase();
      if (label.indexOf(name) === 0) btn.classList.add('active');
    });
    if (name === 'reports') paintReportsTab();
    else if (name === 'files') paintFilesTab();
    else if (name === 'tasks') paintTasksTab();
  }

  // ──────────────────────────────────────────────────────────────────
  // Tasks tab — embeds the shared Tasks panel (js/tasks.js) filtered to
  // this project via tasks.entity_type='project'. The panel owns its own
  // "+ Add" quick-add (pre-linked to this project) and list rendering.
  // ──────────────────────────────────────────────────────────────────
  function paintTasksTab() {
    var host = document.getElementById('projTasksHost');
    if (!host) return;
    var p = _detailState.project;
    if (!p) return;
    if (!window.p86Tasks || typeof window.p86Tasks.mountEntityPanel !== 'function') {
      host.innerHTML = '<div class="p86-proj-empty-line">Tasks module not loaded.</div>';
      return;
    }
    var label = p.name || p.title || ('Project ' + p.id);
    window.p86Tasks.mountEntityPanel(host, 'project', p.id, label);
  }

  // ──────────────────────────────────────────────────────────────────
  // Reports tab — list + create + delete. Each row links to a
  // dedicated report editor (a modal overlay; print-to-PDF via
  // browser print). The full editor surface is render-on-demand
  // through openReportEditor().
  // ──────────────────────────────────────────────────────────────────
  function paintReportsTab() {
    var host = document.getElementById('projReportsHost');
    if (!host) return;
    var p = _detailState.project;
    if (!p) return;
    if (!window.p86Api || !window.p86Api.reports) {
      host.innerHTML = '<div class="p86-proj-empty-line">Reports API not loaded.</div>';
      return;
    }
    host.innerHTML = '<div class="p86-proj-empty-line">Loading reports…</div>';
    window.p86Api.reports.list('project', p.id).then(function(r) {
      _detailState.reports = (r && r.reports) || [];
      _detailState.reportsCount = _detailState.reports.length;
      paintReportsList();
      // Refresh the tab strip count.
      var reportsBtn = Array.from(document.querySelectorAll('.p86-proj-tab')).find(function(b) {
        return b.textContent.trim().toLowerCase().indexOf('reports') === 0;
      });
      if (reportsBtn) {
        var count = reportsBtn.querySelector('.p86-proj-tab-count');
        if (count) count.textContent = '(' + _detailState.reportsCount + ')';
      }
    }).catch(function(e) {
      host.innerHTML = '<div class="p86-proj-error" style="padding:14px;color:#f87171;">Failed to load reports: ' + escapeHTML(e.message || e) + '</div>';
    });
  }

  function paintReportsList() {
    var host = document.getElementById('projReportsHost');
    if (!host) return;
    var reports = _detailState.reports || [];
    // Long-card list — replaces the prior .p86-proj-reports-grid. Each
    // row is a full-width card with a thumbnail (first photo of the
    // first section that has one), title (bold), date, ⋯ menu. Click
    // the row body to open the editor; click the menu for delete.
    var html =
      '<div class="p86-proj-reports-toolbar">' +
        '<input type="search" class="p86-proj-reports-search" placeholder="Find a report…" id="projReportsSearch" />' +
        '<button class="primary" onclick="window.p86Projects.createReport()">' +
          '<span class="p86-proj-reports-plus">&#x2295;</span> Create Report' +
        '</button>' +
      '</div>';
    if (!reports.length) {
      html += '<div class="p86-proj-empty-line" style="padding:30px;text-align:center;border:1px dashed var(--border, #333);border-radius:10px;margin-top:8px;">No reports yet. Hit <strong>Create Report</strong> to draft one.</div>';
    } else {
      html += '<div class="p86-proj-reports-list" id="projReportsListBody">' +
        reports.map(function(r) {
          // Thumbnail — server doesn't (yet) return a cover image
          // per report, so fall back to the empty placeholder. When
          // the future "cover photo" field lands this swaps in the
          // actual image URL with no other changes.
          var thumbHTML = r.cover_thumb_url
            ? '<img class="p86-proj-report-row-thumb-img" src="' + escapeAttr(r.cover_thumb_url) + '" alt="" />'
            : '<div class="p86-proj-report-row-thumb-empty">&#x1F5BC;</div>';
          var date = '';
          if (r.updated_at) {
            var d = new Date(r.updated_at);
            if (!isNaN(d.getTime())) {
              date = d.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
            }
          }
          return '<div class="p86-proj-report-row" data-report-id="' + escapeAttr(r.id) + '" onclick="window.p86Projects.openReport(\'' + escapeAttr(r.id) + '\')">' +
            '<div class="p86-proj-report-row-thumb">' + thumbHTML + '</div>' +
            '<div class="p86-proj-report-row-body">' +
              '<div class="p86-proj-report-row-title">' + escapeHTML(r.title || 'Untitled report') + '</div>' +
              '<div class="p86-proj-report-row-date">' + escapeHTML(date) + '</div>' +
            '</div>' +
            '<button class="p86-proj-report-row-menu" title="Delete" onclick="event.stopPropagation(); window.p86Projects.deleteReport(\'' + escapeAttr(r.id) + '\')">&hellip;</button>' +
          '</div>';
        }).join('') +
      '</div>';
    }
    host.innerHTML = html;

    // Find-a-report filter — client-side on the title, hides
    // non-matching rows without re-fetching. Debounced to 120ms
    // so each keystroke doesn't thrash the DOM.
    var search = host.querySelector('#projReportsSearch');
    if (search) {
      var t;
      search.addEventListener('input', function() {
        clearTimeout(t);
        t = setTimeout(function() {
          var q = String(search.value || '').toLowerCase().trim();
          var list = host.querySelector('#projReportsListBody');
          if (!list) return;
          list.querySelectorAll('.p86-proj-report-row').forEach(function(row) {
            var title = (row.querySelector('.p86-proj-report-row-title') || {}).textContent || '';
            row.style.display = (!q || title.toLowerCase().indexOf(q) >= 0) ? '' : 'none';
          });
        }, 120);
      });
    }
  }

  function createReport() {
    var p = _detailState.project;
    if (!p) return;
    // Wave B: show the template picker modal instead of a plain
    // prompt. User picks a template tile → we seed sections + cover
    // defaults from the template's recipe, then open the editor.
    openTemplatePicker(function(templateId) {
      if (!templateId) return;
      createReportFor(p, templateId);
    });
  }

  // Build + POST a report under the given project using the chosen
  // template. Pulled out of createReport so the summary "New Report"
  // flow (where the project is brand-new, not pre-loaded into
  // _detailState) can call it directly with a fetched project record.
  function createReportFor(project, templateId) {
    if (!project || !templateId) return;
    var tpl = (window.p86ReportTemplates && window.p86ReportTemplates.get)
      ? window.p86ReportTemplates.get(templateId)
      : { label: 'Untitled', seed_sections: [], cover_defaults: function() { return {}; } };
    var me = currentUser();
    var seeds = (tpl.seed_sections || []).map(function(s, i) {
      return {
        id: 'sec_' + Date.now() + '_' + i,
        label: s.label || 'Section',
        layout: s.layout || 'photo-grid',
        photoSize: s.photoSize || 'small',
        descSide:  s.descSide  || 'right',
        descSides: {},
        photo_ids: [],
        captions: {},
        text_body: '',
        attachment_ids: []
      };
    });
    var cover = Object.assign({ enabled: false }, tpl.cover_defaults(project, me) || {});
    var body = {
      title: tpl.label + ' — ' + (project.name || 'Project'),
      template_type: templateId,
      sections: seeds,
      cover_page: cover
    };
    return window.p86Api.reports.create('project', project.id, body).then(function(r) {
      var newR = r && r.report;
      // Only update the in-memory detail-state cache if we're sitting
      // ON this project's detail page; otherwise the summary flow has
      // already navigated into it via openProject, which will refetch.
      if (_detailState.project && String(_detailState.project.id) === String(project.id)) {
        _detailState.reports = (_detailState.reports || []).concat([{
          id: newR.id,
          title: newR.title,
          summary: newR.summary,
          template_type: newR.template_type,
          section_count: (newR.sections || []).length,
          photo_count: 0,
          updated_at: new Date().toISOString()
        }]);
        paintReportsList();
      }
      openReportEditor(newR.id);
    }).catch(function(e) {
      alert('Create failed: ' + (e.message || e));
    });
  }

  // Summary-page "New Report" entrypoint. Flow:
  //   1. Template picker — user picks Walkthrough / Daily Log / etc.
  //   2. New-Project create modal pre-filled with template name + today.
  //      Modal still has the Link-to picker so the user can attach the
  //      report's project to a lead / job / client at create time.
  //   3. On project create → openProject paints the detail view AND
  //      afterCreate fires createReportFor → openReportEditor lands
  //      the user inside the brand-new report ready to take photos.
  function openCreateReport() {
    openTemplatePicker(function(templateId) {
      if (!templateId) return;
      var tpl = (window.p86ReportTemplates && window.p86ReportTemplates.get)
        ? window.p86ReportTemplates.get(templateId)
        : { label: 'Report' };
      var today = new Date().toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
      openCreate(
        { name: tpl.label + ' — ' + today },
        {
          afterCreate: function(projectId) {
            // openProject is async; wait for _detailState.project to
            // be populated before we POST the report. Polling beats
            // refactoring openProject to return a promise here.
            var tries = 0;
            (function waitForProject() {
              if (_detailState.project && String(_detailState.project.id) === String(projectId)) {
                createReportFor(_detailState.project, templateId);
              } else if (tries++ < 60) {
                setTimeout(waitForProject, 100);
              }
            })();
          }
        }
      );
    });
  }

  // Template picker modal — grid of 8 tiles (icon + label + blurb).
  // Click a tile to commit the choice; the modal closes and the
  // create flow continues. Cancel = no-op.
  // Visual style picker — opens a gallery modal with each registered
  // style pack as a card (label + description + mini preview swatch).
  // Clicking a card invokes the callback with the pack id and closes
  // the modal. Active card pulses the accent border so the user sees
  // which pack is current at-a-glance.
  function openStyleGallery(state, onPick) {
    var prior = document.getElementById('projStyleGallery');
    if (prior) prior.remove();
    var packs = (window.p86ReportStylePacks && window.p86ReportStylePacks.list)
      ? window.p86ReportStylePacks.list()
      : [];
    var currentId = (state && state.stylePack) || 'clean';
    var modal = document.createElement('div');
    modal.id = 'projStyleGallery';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:760px;">' +
        '<div class="modal-header">' +
          '<span>Choose a report style</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-report-style-gallery">' +
          packs.map(function(pk) {
            var active = (pk.id === currentId) ? ' active' : '';
            var preview = (window.p86ReportStylePacks && window.p86ReportStylePacks.previewHTML)
              ? window.p86ReportStylePacks.previewHTML(pk)
              : '';
            return '<button type="button" class="p86-report-style-card' + active + '" data-pack-id="' + escapeAttr(pk.id) + '">' +
              '<div class="p86-report-style-card-preview">' + preview + '</div>' +
              '<div class="p86-report-style-card-label">' + escapeHTML(pk.label) + '</div>' +
              '<div class="p86-report-style-card-desc">' + escapeHTML(pk.description || '') + '</div>' +
            '</button>';
          }).join('') +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    function close() { modal.remove(); }
    modal.addEventListener('click', function(e) { if (e.target === modal) close(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) { b.addEventListener('click', close); });
    modal.querySelectorAll('[data-pack-id]').forEach(function(card) {
      card.addEventListener('click', function() {
        var id = card.getAttribute('data-pack-id');
        if (typeof onPick === 'function') onPick(id);
        close();
      });
    });
  }

  function openTemplatePicker(cb) {
    var existing = document.getElementById('projTemplatePicker');
    if (existing) existing.remove();
    var templates = (window.p86ReportTemplates && window.p86ReportTemplates.list)
      ? window.p86ReportTemplates.list()
      : [{ id: 'walkthrough', label: 'Photo Walkthrough', icon: 'photos', description: '' }];
    var modal = document.createElement('div');
    modal.id = 'projTemplatePicker';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content p86-tplpicker-modal">' +
        '<div class="modal-header">' +
          '<span>Choose a report template</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-tplpicker-grid">' +
          templates.map(function(t) {
            return '<button type="button" class="p86-tplpicker-tile" data-tpl-id="' + escapeAttr(t.id) + '">' +
              '<div class="p86-tplpicker-tile-icon" data-p86-icon="' + escapeAttr(t.icon || 'edit') + '"></div>' +
              '<div class="p86-tplpicker-tile-label">' + escapeHTML(t.label) + '</div>' +
              '<div class="p86-tplpicker-tile-desc">' + escapeHTML(t.description || '') + '</div>' +
            '</button>';
          }).join('') +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    // Decorate any data-p86-icon attributes (the agx-icons helper
    // walks the subtree and inlines SVGs).
    if (window.p86IconDecorate) window.p86IconDecorate(modal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });
    modal.querySelectorAll('[data-tpl-id]').forEach(function(tile) {
      tile.addEventListener('click', function() {
        var id = tile.getAttribute('data-tpl-id');
        modal.remove();
        cb(id);
      });
    });
  }

  function deleteReport(reportId) {
    if (!window.confirm('Delete this report? This cannot be undone.')) return;
    var p = _detailState.project;
    window.p86Api.reports.remove('project', p.id, reportId).then(function() {
      _detailState.reports = (_detailState.reports || []).filter(function(r) { return r.id !== reportId; });
      _detailState.reportsCount = _detailState.reports.length;
      paintReportsList();
    }).catch(function(e) { alert('Delete failed: ' + (e.message || e)); });
  }

  function openReport(reportId) { openReportEditor(reportId); }

  // Report editor — full-screen overlay. Sections + photo picker +
  // print-to-PDF button. Lightweight: pull all project photos, drag
  // (well, click) them into sections.
  function openReportEditor(reportId) {
    var p = _detailState.project;
    if (!p) return;
    var prior = document.getElementById('projReportEditor');
    if (prior) prior.remove();

    var overlay = document.createElement('div');
    overlay.id = 'projReportEditor';
    overlay.className = 'p86-report-overlay';
    overlay.innerHTML =
      '<div class="p86-report-host">' +
        '<div class="p86-report-loading">Loading report…</div>' +
      '</div>';
    document.body.appendChild(overlay);
    document.body.style.overflow = 'hidden';

    window.p86Api.reports.get('project', p.id, reportId).then(function(r) {
      var report = r && r.report;
      if (!report) {
        overlay.querySelector('.p86-report-host').innerHTML = '<div class="p86-report-loading">Report not found.</div>';
        return;
      }
      paintReportEditor(overlay, report);
    }).catch(function(e) {
      overlay.querySelector('.p86-report-host').innerHTML = '<div class="p86-report-loading" style="color:#f87171;">Failed to load: ' + escapeHTML(e.message || e) + '</div>';
    });
  }

  function paintReportEditor(overlay, report) {
    var p = _detailState.project;
    var allPhotos = (_detailState.photos || []).filter(function(a) { return a.mime_type && /^image\//.test(a.mime_type); });
    var me = currentUser();
    // Track sections as mutable state. sections_raw is what we PATCH
    // back; sections is the hydrated render. We mirror updates to
    // both so the editor stays consistent during the modal session.
    var state = {
      report: report,
      sections: (report.sections_raw || []).map(function(s) {
        return {
          id: s.id,
          label: s.label || '',
          // Wave B3 — layout + text_body + attachment_ids hydrate
          // onto the in-memory section so the editor can render the
          // right body. Older reports default to photo-grid.
          layout: s.layout || 'photo-grid',
          // Presentation knobs — photoSize controls grid columns
          // (S=3 M=2 L=1 per row) or stack-mode photo max-width
          // (S=65% M=80% L=100%). descSide is the SECTION DEFAULT
          // side; descSides[pid] overrides per-photo so users can
          // stagger left/right within a section.
          photoSize: s.photoSize || 'small',
          descSide:  s.descSide  || 'right',
          descSides: (s.descSides && typeof s.descSides === 'object') ? Object.assign({}, s.descSides) : {},
          photo_ids: (s.photo_ids || []).slice(),
          captions: Object.assign({}, s.captions || {}),
          text_body: s.text_body || '',
          attachment_ids: Array.isArray(s.attachment_ids) ? s.attachment_ids.slice() : []
        };
      }),
      // Cover page state — defaults compose from project + current
      // user + today's date. Stored fields override the defaults.
      cover: Object.assign({
        enabled: false,
        company_name: '',
        pm_name: (me && me.name) || '',
        date: new Date().toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }),
        address: (p && p.address_text) || '',
        subtitle: ''
      }, report.cover_page || {}),
      // Visual style pack — orthogonal to template_type. 'clean' is
      // the original look (no overrides). Other packs each define
      // typography + chrome scoped via data-style-pack on the host.
      stylePack: report.style_pack || 'clean'
    };

    // Idempotent DOM-side close — safe to run from popstate OR from
    // a button click. We mark the overlay with a closed flag so the
    // second call is a no-op.
    function closeImpl() {
      if (overlay._p86Closed) return;
      overlay._p86Closed = true;
      overlay.remove();
      document.body.style.overflow = '';
      paintReportsTab();
    }
    function close() {
      // If our close is on the overlay stack, route through Back
      // so the history entry pops; popstate runs closeImpl. Else
      // call closeImpl directly.
      var hasOurClose = _overlayStack.indexOf(closeImpl) !== -1;
      if (hasOurClose) closeTopOverlay();
      else closeImpl();
    }

    // Register with the overlay stack so Android back closes the
    // report editor instead of navigating away.
    pushOverlay(closeImpl);

    function save() {
      var body = {
        title: state.report.title,
        summary: state.report.summary || '',
        sections: state.sections,
        cover_page: state.cover,
        style_pack: state.stylePack || 'clean'
      };
      return window.p86Api.reports.update('project', p.id, state.report.id, body);
    }

    // Debounced autosave — called from every input handler so the
    // user no longer has to remember to press Save. 600ms idle is
    // long enough that a fast typer doesn't trigger a request per
    // keystroke, short enough that the indicator feels live. The
    // existing #rptSave button doubles as the status indicator
    // (Saving… → Saved → Save) so we don't add new chrome. Timer
    // lives at the paintReportEditor scope so it survives paint()
    // re-renders.
    var _autoSaveTimer = null;
    function debouncedSave() {
      if (_autoSaveTimer) clearTimeout(_autoSaveTimer);
      _autoSaveTimer = setTimeout(function() {
        _autoSaveTimer = null;
        var btn = overlay.querySelector('#rptSave');
        if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
        save().then(function() {
          if (btn) {
            btn.textContent = 'Saved';
            setTimeout(function() {
              // Only restore if another save hasn't taken over.
              if (btn.textContent === 'Saved') {
                btn.disabled = false;
                btn.textContent = 'Save';
              }
            }, 1200);
          }
          // Sync section counts back to the list — same logic as the
          // explicit Save click so the reports list reflects the new
          // title / counts immediately when the editor closes.
          var listItem = (_detailState.reports || []).find(function(r) { return r.id === state.report.id; });
          if (listItem) {
            listItem.title = state.report.title;
            listItem.section_count = state.sections.length;
            listItem.photo_count = state.sections.reduce(function(n, s) { return n + s.photo_ids.length; }, 0);
            listItem.updated_at = new Date().toISOString();
          }
        }).catch(function(e) {
          if (btn) { btn.disabled = false; btn.textContent = 'Save'; }
          // Don't alert — autosave failures shouldn't interrupt
          // typing. Log for diagnostics; the explicit Save click
          // still surfaces failures via its own alert.
          console.warn('Report autosave failed:', e && e.message ? e.message : e);
        });
      }, 600);
    }

    function printReport() {
      // The print view uses CSS @media print; we open a print dialog
      // after triggering a "report-print" mode class so the chrome
      // hides and the photo blocks expand to full-bleed.
      overlay.classList.add('p86-report-printing');
      save().then(function() {
        setTimeout(function() {
          window.print();
          setTimeout(function() { overlay.classList.remove('p86-report-printing'); }, 300);
        }, 200);
      }).catch(function() {
        overlay.classList.remove('p86-report-printing');
        window.print(); // print anyway with the unsaved state
      });
    }

    // Preview overlay — paper-styled full-screen modal that renders
    // EXACTLY what the printed PDF would look like with the current
    // style pack applied. Reuses renderPrintCoverHTML for the cover
    // and renders sections in read-only form (no toggle buttons, no
    // remove ×, no editable inputs — just photos, captions as text,
    // and metadata). Top bar has a "Print / Save PDF" so users can
    // commit directly from the preview without going back to the
    // editor.
    function openReportPreview() {
      var prior = document.getElementById('projReportPreview');
      if (prior) prior.remove();

      var preview = document.createElement('div');
      preview.id = 'projReportPreview';
      preview.className = 'p86-report-preview-overlay';

      // Read-only section render — strips the editor chrome but keeps
      // the photo grid / stack / before-after / text / file-list body
      // layouts intact. For photo cards we drop the drag handle, the
      // remove ×, the side-swap button, the annotate ✏ — readers
      // shouldn't see any of those affordances.
      function previewSectionHTML(section) {
        var layout = section.layout || 'photo-grid';
        var label = section.label || '';
        var bodyHTML = '';
        if (layout === 'text-block') {
          bodyHTML = '<div class="p86-report-preview-text">' + escapeHTML(section.text_body || '') + '</div>';
        } else if (layout === 'attachment-list') {
          var ids = Array.isArray(section.attachment_ids) ? section.attachment_ids : [];
          var allFiles = (_detailState.photos || []).filter(function(a) { return a && a.mime_type && a.mime_type.indexOf('image/') !== 0; });
          bodyHTML = '<div class="p86-report-preview-files">' +
            ids.map(function(aid) {
              var att = allFiles.find(function(a) { return a.id === aid; });
              if (!att) return '';
              var ext = (att.filename || '').split('.').pop().toUpperCase();
              return '<div class="p86-report-preview-file-row">' +
                '<span class="p86-report-preview-file-ext">' + escapeHTML(ext) + '</span>' +
                '<span class="p86-report-preview-file-name">' + escapeHTML(att.filename || '') + '</span>' +
              '</div>';
            }).join('') +
          '</div>';
        } else {
          // photo-grid / single-photo / before-after — same render but
          // without the edit chrome.
          var size = section.photoSize || 'small';
          var photoIds = section.photo_ids || [];
          if (!photoIds.length) {
            bodyHTML = '<div class="p86-report-preview-empty">No photos in this section.</div>';
          } else {
            var photoCardsHTML = photoIds.map(function(pid) {
              var att = allPhotos.find(function(a) { return a.id === pid; });
              if (!att) return '';
              var caption = section.captions[pid] || '';
              var photoSide = (typeof descSideFor === 'function') ? descSideFor(section, pid) : 'right';
              var sideClass = attHasSideContent(att) ? ' has-sidedesc' + (photoSide === 'left' ? ' desc-left' : '') : '';
              var imgSrc = att.web_url || att.thumb_url;
              return '<div class="p86-report-preview-photo' + sideClass + '">' +
                '<div class="p86-report-preview-photo-img-wrap">' +
                  '<img src="' + escapeAttr(imgSrc) + '" alt="" />' +
                  // Inline annotation canvas (drawn after DOM mounts)
                  (Array.isArray(att.annotations) && att.annotations.length
                    ? '<canvas class="p86-report-preview-photo-anno" data-anno-photo="' + escapeAttr(pid) + '"></canvas>'
                    : '') +
                '</div>' +
                (caption ? '<div class="p86-report-preview-photo-cap">' + escapeHTML(caption) + '</div>' : '') +
                photoSideColumnHTML(att) +
              '</div>';
            }).join('');
            var sectionCls = (layout === 'single-photo')
              ? 'p86-report-preview-section-stack size-' + escapeAttr(size)
              : 'p86-report-preview-section-grid size-' + escapeAttr(size);
            bodyHTML = '<div class="' + sectionCls + '">' + photoCardsHTML + '</div>';
          }
        }
        return '<section class="p86-report-preview-section">' +
          (label ? '<h2 class="p86-report-preview-section-label">' + escapeHTML(label) + '</h2>' : '') +
          bodyHTML +
        '</section>';
      }

      // Build the overlay's full HTML — top bar + paper. The paper
      // gets the data-style-pack attribute so the existing style-pack
      // CSS scoped via that selector applies inside the preview too.
      preview.innerHTML =
        '<div class="p86-report-preview-bar">' +
          '<button type="button" class="p86-report-preview-close" data-preview-close>&#x2190; Back to editor</button>' +
          '<div class="p86-report-preview-bar-title">Preview</div>' +
          '<button type="button" class="p86-report-preview-print">&#x1F5A8; Print / Save PDF</button>' +
        '</div>' +
        '<div class="p86-report-preview-paper" data-style-pack="' + escapeAttr(state.stylePack || 'clean') + '">' +
          (state.cover.enabled ? renderPrintCoverHTML() : '') +
          (state.report.summary ? '<div class="p86-report-preview-summary">' + escapeHTML(state.report.summary) + '</div>' : '') +
          state.sections.map(previewSectionHTML).join('') +
        '</div>';

      document.body.appendChild(preview);

      // Paint annotation strokes on each photo (same coord-space
      // trick the project feed + report editor use — canvas internal
      // dims = web variant, CSS scales the canvas to the img).
      preview.querySelectorAll('[data-anno-photo]').forEach(function(canvas) {
        var pid = canvas.getAttribute('data-anno-photo');
        var att = allPhotos.find(function(a) { return a.id === pid; });
        if (!att || !window.p86AnnotationRender) return;
        var dims = (typeof window.p86AnnotationRender.webVariantDims === 'function')
          ? window.p86AnnotationRender.webVariantDims(att.width, att.height)
          : null;
        if (!dims) return;
        canvas.width = dims.w;
        canvas.height = dims.h;
        try { window.p86AnnotationRender.renderAll(canvas.getContext('2d'), att.annotations); }
        catch (e) { /* defensive */ }
      });

      function close() { preview.remove(); }
      preview.querySelectorAll('[data-preview-close]').forEach(function(b) {
        b.addEventListener('click', close);
      });
      preview.querySelector('.p86-report-preview-print').addEventListener('click', function() {
        // Use the same path as the editor's Print button so the
        // saved-state guarantee + the printing CSS class both fire.
        close();
        printReport();
      });
      // Esc closes the preview — matches the markup viewer + photo
      // viewer escape behavior.
      function onKey(e) {
        if (e.key === 'Escape') {
          close();
          document.removeEventListener('keydown', onKey);
        }
      }
      document.addEventListener('keydown', onKey);
    }

    // Wave B4 helpers — cover-page polymorphism. The active template
    // (looked up from state.report.template_type) decides which
    // fields the cover fieldset surfaces and which fields the print
    // render shows. Defined inside paintReportEditor's closure so
    // they see `state` directly.
    function currentTemplate() {
      var id = (state.report && state.report.template_type) || 'walkthrough';
      if (window.p86ReportTemplates && window.p86ReportTemplates.get) {
        return window.p86ReportTemplates.get(id);
      }
      // Fallback when the registry script failed to load — preserve
      // the legacy 5-field walkthrough shape so the editor still
      // works in a broken state.
      return {
        id: 'walkthrough',
        label: 'Photo Walkthrough',
        cover_schema: ['company_name', 'subtitle', 'pm_name', 'date', 'address']
      };
    }
    function currentCoverSchema() {
      var tpl = currentTemplate();
      return Array.isArray(tpl.cover_schema) ? tpl.cover_schema : [];
    }
    function cvFieldId(key) {
      // Stable id prefix for cover inputs. Used by both the field
      // render below and the bind-event loop in paint().
      return 'cv_' + key;
    }
    function coverFieldMeta(key) {
      if (window.p86ReportTemplates && window.p86ReportTemplates.coverFieldMeta) {
        return window.p86ReportTemplates.coverFieldMeta(key);
      }
      return { label: key, type: 'text', placeholder: '' };
    }
    function renderCoverFieldsHTML() {
      var schema = currentCoverSchema();
      if (!schema.length) return '';
      return '<div class="p86-report-cover-grid">' +
        schema.map(function(key) {
          var meta = coverFieldMeta(key);
          var val = state.cover[key] != null ? String(state.cover[key]) : '';
          var input;
          if (meta.type === 'textarea') {
            input = '<textarea id="' + cvFieldId(key) + '" rows="2" placeholder="' + escapeAttr(meta.placeholder || '') + '">' + escapeHTML(val) + '</textarea>';
          } else {
            input = '<input id="' + cvFieldId(key) + '" type="text" value="' + escapeAttr(val) + '" placeholder="' + escapeAttr(meta.placeholder || '') + '" />';
          }
          return '<label class="p86-field"><span>' + escapeHTML(meta.label || key) + '</span>' + input + '</label>';
        }).join('') +
      '</div>';
    }
    function renderPrintCoverHTML() {
      var tpl = currentTemplate();
      var schema = currentCoverSchema();
      var rows = schema.map(function(key) {
        var v = state.cover[key];
        if (!v) return '';
        var meta = coverFieldMeta(key);
        // Title row gets special treatment — render larger and
        // centered. The "company_name", "subtitle", "address" keys
        // also get their own positions; everything else falls into
        // the meta key-value list.
        if (key === 'company_name' || key === 'subtitle' || key === 'address') return '';
        return '<div><span class="k">' + escapeHTML(meta.label) + '</span><span class="v">' + escapeHTML(String(v)) + '</span></div>';
      }).filter(Boolean).join('');
      return '<div class="p86-report-cover-rendered print-only">' +
        '<div class="p86-report-cover-company">' + escapeHTML(state.cover.company_name || 'AGX Central Florida') + '</div>' +
        (state.cover.subtitle ? '<div class="p86-report-cover-subtitle">' + escapeHTML(state.cover.subtitle) + '</div>' : '') +
        '<h1 class="p86-report-cover-title">' + escapeHTML(state.report.title || tpl.label || 'Project Report') + '</h1>' +
        (state.cover.address ? '<div class="p86-report-cover-addr">' + escapeHTML(state.cover.address) + '</div>' : '') +
        (rows ? '<div class="p86-report-cover-meta">' + rows + '</div>' : '') +
      '</div>';
    }

    function paint() {
      var host = overlay.querySelector('.p86-report-host');
      var emptyStateHTML = state.sections.length ? '' :
        '<div class="p86-report-empty">' +
          '<div class="p86-report-empty-title">Add your first section</div>' +
          '<div class="p86-report-empty-hint">Sections let you group photos by topic — pick presets below or build your own.</div>' +
          '<div class="p86-report-empty-presets">' +
            '<button class="ee-btn secondary" data-preset="bda">&#x1F4F8; Before / During / After</button>' +
            '<button class="ee-btn secondary" data-preset="walkthrough">&#x1F50D; Walkthrough (Exterior / Roof / Interior)</button>' +
            '<button class="ee-btn secondary" data-preset="damage">&#x26A0; Damage Assessment</button>' +
            '<button class="primary" data-preset="custom">&#x2795; Custom Section</button>' +
          '</div>' +
        '</div>';

      // Apply the visual style pack at the host level so all the
      // scoped CSS rules in css/report-style-packs.css can find their
      // theme via [data-style-pack="…"]. Editor view + the @media
      // print rendering both pick up the same attribute, so PDFs
      // come out matching what the user sees in the editor.
      host.setAttribute('data-style-pack', state.stylePack || 'clean');
      // Cover-enabled flag — surfaces state.cover.enabled into CSS so
      // the @media print rule can hide the editor's plain title input
      // (the styled cover already shows the title in big display
      // type — letting both render duplicates the headline on the
      // printed page).
      host.setAttribute('data-cover-enabled', state.cover.enabled ? 'true' : 'false');

      host.innerHTML =
        '<div class="p86-report-topbar">' +
          '<input id="rptTitle" class="p86-report-title-input" value="' + escapeAttr(state.report.title || '') + '" placeholder="Report title" />' +
          '<div class="p86-report-topbar-actions">' +
            '<button class="ee-btn secondary" id="rptDesign" title="Choose a visual style for this report">&#x1F3A8; Design</button>' +
            '<button class="ee-btn secondary" id="rptPreview" title="See what this report will look like when printed">&#x1F441;&#xFE0F; Preview</button>' +
            '<button class="ee-btn secondary" id="rptPrint">&#x1F5A8; Print / Save PDF</button>' +
            '<button class="ee-btn secondary" id="rptAddSection">&#x2795; Section</button>' +
            '<button class="ee-btn secondary" id="rptSave">Save</button>' +
            '<button class="p86-modal-close" id="rptClose">&times;</button>' +
          '</div>' +
        '</div>' +

        // Wave B4: cover-page fieldset is now dynamic. The set of
        // fields rendered comes from the active template's
        // cover_schema, looked up via window.p86ReportTemplates.
        // Each schema field's label / placeholder / input type comes
        // from p86ReportTemplates.coverFieldMeta. The print-only
        // rendered cover below mirrors the schema so what the user
        // edits matches what prints.
        '<fieldset class="p86-report-cover-fieldset">' +
          '<legend>' +
            '<label class="p86-report-cover-toggle" data-edit-gate-passthrough>' +
              '<input type="checkbox" id="rptCoverEnabled"' + (state.cover.enabled ? ' checked' : '') + ' />' +
              '<span>&#x1F4D1; Include cover page</span>' +
            '</label>' +
          '</legend>' +
          (state.cover.enabled ? renderCoverFieldsHTML() : '') +
        '</fieldset>' +

        // Print-only cover page render. Always in the DOM (so
        // @media print pulls it onto the first page) but hidden
        // in the editor view via the .print-only class.
        (state.cover.enabled ? renderPrintCoverHTML() : '') +

        '<textarea id="rptSummary" class="p86-report-summary" rows="2" placeholder="Optional summary at the top of the report">' + escapeHTML(state.report.summary || '') + '</textarea>' +
        '<div class="p86-report-sections">' +
          // Interleave "+ insert section here" rows BETWEEN every
          // pair of sections + above the first + below the last so
          // users can drop a new section at any precise position
          // without scrolling to the topbar's "+ Section" button.
          // Skipped entirely when there are no sections yet — the
          // empty-state preset buttons handle that case.
          (state.sections.length
            ? (insertRowHTML(0) +
               state.sections.map(function(s, i) {
                 return sectionHTML(s) + insertRowHTML(i + 1);
               }).join(''))
            : '') +
          emptyStateHTML +
        '</div>';

      // Title + summary autosave — input writes to state and
      // schedules a debounced PATCH. The Save button still works
      // as a "save now" flush but is no longer required.
      host.querySelector('#rptTitle').addEventListener('input', function(e) {
        state.report.title = e.target.value;
        debouncedSave();
      });
      host.querySelector('#rptSummary').addEventListener('input', function(e) {
        state.report.summary = e.target.value;
        debouncedSave();
      });

      // Cover page wiring — toggle triggers a paint() to show/hide
      // the inputs AND schedules an autosave so the enabled flag
      // persists without a manual Save click.
      var coverToggle = host.querySelector('#rptCoverEnabled');
      if (coverToggle) coverToggle.addEventListener('change', function() {
        state.cover.enabled = coverToggle.checked;
        debouncedSave();
        paint(); // re-paint to show/hide the inputs
      });
      // Schema-driven cover wiring (Wave B4). Walk the active
      // template's cover_schema and bind every rendered input to
      // its key on state.cover.
      currentCoverSchema().forEach(function(key) {
        var el = host.querySelector('#' + cvFieldId(key));
        if (!el) return;
        el.addEventListener('input', function(e) {
          state.cover[key] = e.target.value;
          debouncedSave();
        });
      });

      // Gate the cover fieldset. Cover inputs now autosave on input
      // (via debouncedSave above) so a stray tap could mutate the
      // company name / PM / date before the user notices. The pencil
      // in the legend locks the section by default; tap to arm.
      // The "Include cover page" checkbox is marked passthrough in
      // the markup so it stays togglable even when the section is
      // locked — flipping cover on/off isn't an accidental-edit
      // risk and was always meant to be a one-tap action.
      if (window.p86EditGate) {
        var coverFs = host.querySelector('.p86-report-cover-fieldset');
        if (coverFs) window.p86EditGate.attachSection(coverFs, { startUnlocked: false });
      }

      host.querySelector('#rptClose').addEventListener('click', close);
      host.querySelector('#rptSave').addEventListener('click', function() {
        var btn = host.querySelector('#rptSave');
        btn.disabled = true; btn.textContent = 'Saving…';
        save().then(function() {
          btn.textContent = 'Saved';
          setTimeout(function() { btn.disabled = false; btn.textContent = 'Save'; }, 800);
          // Sync section counts back to the list.
          var listItem = (_detailState.reports || []).find(function(r) { return r.id === state.report.id; });
          if (listItem) {
            listItem.title = state.report.title;
            listItem.section_count = state.sections.length;
            listItem.photo_count = state.sections.reduce(function(n, s) { return n + s.photo_ids.length; }, 0);
            listItem.updated_at = new Date().toISOString();
          }
        }).catch(function(e) {
          btn.disabled = false; btn.textContent = 'Save';
          alert('Save failed: ' + (e.message || e));
        });
      });
      host.querySelector('#rptPrint').addEventListener('click', printReport);
      host.querySelector('#rptAddSection').addEventListener('click', function() { addCustomSection(); });
      // Design button — opens the visual style-pack gallery. Picking
      // a card mutates state.stylePack, swaps the data attribute,
      // and debounce-saves. No paint() re-run needed; the CSS
      // overrides take effect from the attribute change alone.
      host.querySelector('#rptDesign').addEventListener('click', function() {
        openStyleGallery(state, function(nextId) {
          state.stylePack = nextId;
          host.setAttribute('data-style-pack', nextId);
          debouncedSave();
        });
      });
      // Preview button — opens a paper-styled overlay showing exactly
      // what the printed PDF will look like with the current style
      // pack applied. No editor chrome. Print/Save PDF can be
      // triggered from inside the overlay so users can review then
      // commit without going back to the editor.
      host.querySelector('#rptPreview').addEventListener('click', function() {
        openReportPreview(state);
      });

      // Inter-section "+" insert buttons. Delegated to host so a
      // single listener handles every row (and survives paint()
      // re-renders since paint reuses the host element). Click opens
      // a small popover with the 5 section-type choices.
      host.addEventListener('click', function(e) {
        var btn = e.target.closest('.p86-report-insert-btn');
        if (!btn || !host.contains(btn)) return;
        e.stopPropagation();
        var row = btn.closest('.p86-report-insert-row');
        if (!row) return;
        var idx = parseInt(row.getAttribute('data-insert-at'), 10);
        if (isNaN(idx)) return;
        openInsertMenu(btn, idx);
      });

      // Empty-state preset buttons.
      host.querySelectorAll('[data-preset]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var preset = btn.getAttribute('data-preset');
          if (preset === 'bda') {
            seedSections(['Before', 'During', 'After']);
          } else if (preset === 'walkthrough') {
            seedSections(['Exterior', 'Roof', 'Interior']);
          } else if (preset === 'damage') {
            seedSections(['Overview', 'Damage Detail', 'Recommended Repairs']);
          } else if (preset === 'custom') {
            addCustomSection();
          }
        });
      });

      // Wire section interactions.
      state.sections.forEach(function(section, sIdx) {
        var sectionEl = host.querySelector('[data-sec="' + section.id + '"]');
        if (!sectionEl) return;
        var labelEl = sectionEl.querySelector('.p86-report-section-label');
        if (labelEl) labelEl.addEventListener('input', function(e) {
          state.sections[sIdx].label = e.target.value;
        });
        // Section toggle buttons — two groups (layout / photoSize).
        // Each click is mutually exclusive within its group. The
        // layout group preserves the old content-loss confirm. The
        // per-photo descSide swap button is handled separately below.
        sectionEl.querySelectorAll('.p86-report-section-iconbtn').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var group = btn.getAttribute('data-toggle');
            var value = btn.getAttribute('data-value');
            if (!group || !value) return;

            if (group === 'layout') {
              var prevLayout = state.sections[sIdx].layout || 'photo-grid';
              if (prevLayout === value) return;
              var hasPhotos = (state.sections[sIdx].photo_ids || []).length > 0;
              var hasText = !!(state.sections[sIdx].text_body || '').trim();
              var hasAttachments = (state.sections[sIdx].attachment_ids || []).length > 0;
              var losingContent =
                (prevLayout !== 'text-block' && prevLayout !== 'attachment-list' && (value === 'text-block' || value === 'attachment-list') && hasPhotos) ||
                (prevLayout === 'text-block' && value !== 'text-block' && hasText) ||
                (prevLayout === 'attachment-list' && value !== 'attachment-list' && hasAttachments);
              if (losingContent && !window.confirm('Switching layouts will clear the current ' + (prevLayout === 'text-block' ? 'text' : (prevLayout === 'attachment-list' ? 'file list' : 'photos')) + ' in this section. Continue?')) {
                return;
              }
              state.sections[sIdx].layout = value;
              // before-after caps to 2 photos.
              if (value === 'before-after' && (state.sections[sIdx].photo_ids || []).length > 2) {
                state.sections[sIdx].photo_ids = state.sections[sIdx].photo_ids.slice(0, 2);
              }
            } else if (group === 'photoSize') {
              state.sections[sIdx].photoSize = value;
            } else {
              return;
            }
            paint();
            debouncedSave();
          });
        });

        // Per-photo "swap side" button — flips just THIS photo's
        // description side between left/right. Stored on
        // section.descSides[pid] so each photo carries its own
        // preference, allowing users to stagger.
        sectionEl.querySelectorAll('[data-side-swap]').forEach(function(btn) {
          btn.addEventListener('click', function(e) {
            e.stopPropagation();
            var newSide = btn.getAttribute('data-side-swap');
            var card = btn.closest('[data-photo-id]');
            if (!card) return;
            var pid = card.getAttribute('data-photo-id');
            if (!pid) return;
            if (!state.sections[sIdx].descSides || typeof state.sections[sIdx].descSides !== 'object') {
              state.sections[sIdx].descSides = {};
            }
            state.sections[sIdx].descSides[pid] = (newSide === 'left') ? 'left' : 'right';
            paint();
            debouncedSave();
          });
        });
        var addBtn = sectionEl.querySelector('.p86-report-section-add');
        if (addBtn) addBtn.addEventListener('click', function() {
          var layout = state.sections[sIdx].layout || 'photo-grid';
          if (layout === 'attachment-list') openAttachmentPicker(sIdx);
          else openPhotoPicker(sIdx);
        });

        // Photo-map header actions — only render when layout is
        // photo-map (see sectionHTML mapBtns block). Both update
        // state.sections[sIdx].photo_ids and fire a paint + autosave.
        var autoBtn = sectionEl.querySelector('.p86-report-section-autopin');
        if (autoBtn) autoBtn.addEventListener('click', function() {
          // Scope: photos attached to THIS project that have GPS
          // coords. _detailState.photos is the project's full photo
          // list; filter to images with lat/lng AND not already in
          // the section.
          var existing = new Set((state.sections[sIdx].photo_ids || []).map(String));
          var candidates = (_detailState.photos || []).filter(function(p) {
            if (!p || existing.has(String(p.id))) return false;
            if (!(p.mime_type && /^image\//i.test(p.mime_type))) return false;
            return hasValidGeo(p);
          });
          if (!candidates.length) {
            // Distinguish "everything's already pinned" from "no
            // geotagged photos exist" so the user knows what to do.
            var totalWithCoords = (_detailState.photos || []).filter(function(p) {
              return p && p.mime_type && /^image\//i.test(p.mime_type)
                && hasValidGeo(p);
            }).length;
            if (totalWithCoords === 0) {
              window.alert('No project photos have location data yet. Photos uploaded with the geolocation permission granted, or that have GPS in their EXIF, will appear here.');
            } else {
              window.alert('All ' + totalWithCoords + ' photo' + (totalWithCoords === 1 ? '' : 's') + ' with location data are already pinned.');
            }
            return;
          }
          // Soft confirm for large fills so the user doesn't
          // accidentally drop 100 pins on a section.
          if (candidates.length > 20) {
            if (!window.confirm('Add ' + candidates.length + ' photos to this map section?')) return;
          }
          var ids = state.sections[sIdx].photo_ids || [];
          candidates.forEach(function(p) { ids.push(p.id); });
          state.sections[sIdx].photo_ids = ids;
          paint();
          debouncedSave();
        });

        var unpinBtn = sectionEl.querySelector('.p86-report-section-unpin');
        if (unpinBtn) unpinBtn.addEventListener('click', function() {
          var count = (state.sections[sIdx].photo_ids || []).length;
          if (!count) return;
          if (!window.confirm('Remove all ' + count + ' photo' + (count === 1 ? '' : 's') + ' from this map section? (Photos themselves are not deleted.)')) return;
          state.sections[sIdx].photo_ids = [];
          state.sections[sIdx].captions = {};
          paint();
          debouncedSave();
        });

        // Pin-style dropdown — changes section.pin_style and forces
        // a paint so the markers re-render in the chosen style.
        var styleSel = sectionEl.querySelector('.p86-report-section-pinstyle');
        if (styleSel) styleSel.addEventListener('change', function() {
          var v = styleSel.value;
          var ALLOWED = ['tag', 'numbered', 'lettered', 'photo', 'dot'];
          state.sections[sIdx].pin_style = ALLOWED.indexOf(v) >= 0 ? v : 'tag';
          paint();
          debouncedSave();
        });

        // Map-toolbar Fit-all button — sits inside the map host as a
        // small chrome strip. Re-fits the map bounds around all pins
        // so the user can recover after panning/zooming.
        var fitBtn = sectionEl.querySelector('.p86-report-section-map-fit');
        if (fitBtn) fitBtn.addEventListener('click', function() {
          var fitMapEl = sectionEl.querySelector('[data-photo-map="1"]');
          if (!fitMapEl || !fitMapEl._p86RefitFn) return;
          fitMapEl._p86RefitFn();
        });

        // InfoWindow "Remove" button dispatches p86-photomap-remove
        // from the map host. Catch it here and drop the photo from
        // section.photo_ids. paint() refreshes the map (no pin) and
        // updates the count in the toolbar.
        sectionEl.addEventListener('p86-photomap-remove', function(ev) {
          var pid = ev && ev.detail && ev.detail.photoId;
          if (!pid) return;
          state.sections[sIdx].photo_ids = (state.sections[sIdx].photo_ids || []).filter(function(x) { return x !== pid; });
          if (state.sections[sIdx].captions) delete state.sections[sIdx].captions[pid];
          paint();
          debouncedSave();
        });

        var rmSectionBtn = sectionEl.querySelector('.p86-report-section-remove');
        if (rmSectionBtn) rmSectionBtn.addEventListener('click', function() {
          if (!window.confirm('Remove this section? (Underlying photos / files are not deleted.)')) return;
          state.sections.splice(sIdx, 1);
          paint();
          debouncedSave();
        });
        sectionEl.querySelectorAll('[data-rm-photo]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var pid = btn.getAttribute('data-rm-photo');
            state.sections[sIdx].photo_ids = state.sections[sIdx].photo_ids.filter(function(x) { return x !== pid; });
            delete state.sections[sIdx].captions[pid];
            paint();
            debouncedSave();
          });
        });
        sectionEl.querySelectorAll('[data-caption-input]').forEach(function(input) {
          input.addEventListener('input', function(e) {
            var pid = input.getAttribute('data-caption-input');
            state.sections[sIdx].captions[pid] = e.target.value;
            debouncedSave();
          });
        });

        // Paint annotation strokes onto any canvas we emitted next to
        // a photo. Same coord-space trick as the project-feed tiles:
        // the canvas's internal bitmap matches the WEB variant
        // (1600px max edge, see attachment-routes.js sharp pipeline);
        // CSS scales it to overlay the thumb img with object-fit:
        // cover. Skips photos without annotations entirely.
        sectionEl.querySelectorAll('[data-anno-photo]').forEach(function(canvas) {
          var pid = canvas.getAttribute('data-anno-photo');
          var att = allPhotos.find(function(a) { return a.id === pid; });
          if (!att || !window.p86AnnotationRender) return;
          var dims = webVariantDims(att.width, att.height);
          if (!dims) return;
          canvas.width = dims.w;
          canvas.height = dims.h;
          try { window.p86AnnotationRender.renderAll(canvas.getContext('2d'), att.annotations); }
          catch (e) { /* defensive — bad stroke shouldn't kill the section */ }
        });

        // Click the photo image → open the full photo viewer panel.
        // Sends ONLY this section's photo set so prev/next paginates
        // within the section (not the whole project library). Mutations
        // the user makes in the viewer — annotations, description,
        // tags — happen on the same att objects allPhotos points at,
        // so repainting on viewer close picks them up automatically.
        sectionEl.querySelectorAll('[data-open-photo]').forEach(function(img) {
          img.addEventListener('click', function(e) {
            e.preventDefault();
            var pid = img.getAttribute('data-open-photo');
            var ids = state.sections[sIdx].photo_ids;
            var atts = ids.map(function(id) {
              return allPhotos.find(function(a) { return a.id === id; });
            }).filter(Boolean);
            var startIdx = Math.max(0, atts.findIndex(function(a) { return a.id === pid; }));
            if (window.p86Attachments && typeof window.p86Attachments.openLightbox === 'function') {
              window.p86Attachments.openLightbox(atts, startIdx, {
                onClose: function() {
                  // Description / annotations may have changed in the
                  // viewer — repaint so the side-description column +
                  // any future tile overlays reflect the new state.
                  paint();
                }
              });
            }
          });
        });

        // Drag-and-drop reorder within the section. HTML5 DnD is dead
        // simple for this: dragstart stashes the source id; dragover on
        // a sibling card visually marks it as the target; drop swaps
        // them in photo_ids and repaints. Works for both photo-grid
        // and single-photo layouts (both use draggable cards).
        var dragSrcId = null;
        sectionEl.querySelectorAll('[data-photo-id][draggable="true"]').forEach(function(card) {
          card.addEventListener('dragstart', function(e) {
            dragSrcId = card.getAttribute('data-photo-id');
            card.classList.add('p86-report-photo-dragging');
            try { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', dragSrcId); } catch (_) {}
          });
          card.addEventListener('dragend', function() {
            card.classList.remove('p86-report-photo-dragging');
            sectionEl.querySelectorAll('.p86-report-photo-dragover').forEach(function(el) {
              el.classList.remove('p86-report-photo-dragover');
            });
            dragSrcId = null;
          });
          card.addEventListener('dragover', function(e) {
            // Allow drop AND give a visible insert target.
            e.preventDefault();
            try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
            if (card.getAttribute('data-photo-id') !== dragSrcId) {
              card.classList.add('p86-report-photo-dragover');
            }
          });
          card.addEventListener('dragleave', function() {
            card.classList.remove('p86-report-photo-dragover');
          });
          card.addEventListener('drop', function(e) {
            e.preventDefault();
            card.classList.remove('p86-report-photo-dragover');
            var targetId = card.getAttribute('data-photo-id');
            if (!dragSrcId || dragSrcId === targetId) return;
            var ids = state.sections[sIdx].photo_ids;
            var fromIdx = ids.indexOf(dragSrcId);
            var toIdx = ids.indexOf(targetId);
            if (fromIdx < 0 || toIdx < 0) return;
            ids.splice(fromIdx, 1);
            ids.splice(toIdx, 0, dragSrcId);
            paint();
            debouncedSave();
          });
        });
        // Text-block layout: textarea writes back into state.text_body.
        var textInput = sectionEl.querySelector('.p86-report-section-text-input');
        if (textInput) textInput.addEventListener('input', function(e) {
          state.sections[sIdx].text_body = e.target.value;
          debouncedSave();
        });
        // Attachment-list layout: per-row remove button.
        sectionEl.querySelectorAll('[data-rm-att]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var aid = btn.getAttribute('data-rm-att');
            state.sections[sIdx].attachment_ids = (state.sections[sIdx].attachment_ids || []).filter(function(x) { return x !== aid; });
            paint();
            debouncedSave();
          });
        });
      });

      // Photo-map section mounts. Find every freshly-painted
      // .p86-report-section-map element and boot a Google Map into
      // it with markers for the picked photos.
      //
      // Idempotency: paint() fires on every keystroke in any input,
      // so we don't want to rebuild Google Maps unless the photo
      // selection (or any photo's lat/lng) actually changed. We
      // fingerprint the photo IDs + their coords into a string and
      // stash it on mapEl.dataset.mapFingerprint. If it matches on
      // the next paint, skip the rebuild entirely.
      host.querySelectorAll('[data-photo-map="1"]').forEach(function(mapEl) {
        if (!window.p86Maps || !window.p86Maps.ready) return;
        var ids = [];
        try { ids = JSON.parse(mapEl.getAttribute('data-photo-ids') || '[]'); } catch (e) {}
        var pickedPhotos = ids.map(function(pid) {
          return (_detailState.photos || []).find(function(a) { return a.id === pid; });
        }).filter(Boolean);
        if (!pickedPhotos.length) return;
        // Fingerprint = ids + coords; if any photo's coords get
        // backfilled later (server-side EXIF extraction completes
        // after the upload returns), the fingerprint changes and
        // we re-render to pick up the new pin.
        var fingerprint = pickedPhotos.map(function(p) {
          return p.id + ':' + Number(p.lat).toFixed(6) + ',' + Number(p.lng).toFixed(6);
        }).join('|');
        if (mapEl.dataset.mapFingerprint === fingerprint) return;  // unchanged → skip
        mapEl.dataset.mapFingerprint = fingerprint;
        // Clear any prior mount (Google Maps doesn't leak listeners
        // when its host node gets emptied — pin markers GC with the
        // old Map instance).
        mapEl.innerHTML = '';
        window.p86Maps.ready().then(function(maps) {
          // Bail if user navigated away mid-load.
          if (!mapEl.isConnected) return;
          // Re-check the fingerprint — paint() may have fired again
          // while we were awaiting the SDK; the most-recent paint's
          // fingerprint is the one that wins.
          if (mapEl.dataset.mapFingerprint !== fingerprint) return;
          // Defer one animation frame so the section's flex layout
          // has time to compute. Without this, Google Maps reads
          // mapEl.offsetWidth/Height at construction time, sees 0×0
          // (the parent .p86-report-section-map-wrap is still
          // settling), and renders a blank map that never recovers
          // unless we manually trigger a resize. With the rAF, the
          // layout is committed before construction.
          return new Promise(function(resolve) {
            requestAnimationFrame(function() { resolve(maps); });
          });
        }).then(function(maps) {
          if (!maps || !mapEl.isConnected) return;
          if (mapEl.dataset.mapFingerprint !== fingerprint) return;
          // No bail-on-tiny-size check anymore. Google Maps actually
          // handles 0×0 mounts fine as long as we trigger resize
          // when the host grows. The previous bail was preventing
          // mount entirely if the parent flex layout hadn't
          // committed yet — and since paint() only fires on user
          // input, the map would stay blank until the user typed.
          // Instead we mount immediately and use ResizeObserver
          // (below) to trigger Google's resize event when the host
          // dimensions change.
          var first = pickedPhotos[0];
          var center = { lat: Number(first.lat), lng: Number(first.lng) };
          var map = new maps.Map(mapEl, {
            center: center,
            zoom: 16,
            mapTypeControl: false,
            streetViewControl: false,
            fullscreenControl: true,
            mapTypeId: maps.MapTypeId.HYBRID,  // satellite + roads — best for site walkthrough context
            gestureHandling: 'cooperative'
          });
          var bounds = new maps.LatLngBounds();
          // Single InfoWindow reused across markers — opening a
          // second pin closes the first naturally. Holds thumbnail
          // + caption + Open + Remove buttons. The Remove button
          // dispatches a custom event on mapEl that the section's
          // handler-attaching code (in paint()) listens for, so we
          // don't have to capture sIdx in this closure.
          var infoWin = new maps.InfoWindow();
          // Pin style for this section. Read off the closest section
          // wrap element so the choice persists across paint()s
          // without us threading it through every closure.
          var sectionWrap = mapEl.closest('.p86-report-section');
          var sectionId = sectionWrap ? sectionWrap.getAttribute('data-sec') : null;
          var sectionRow = sectionId ? state.sections.find(function(s) { return s.id === sectionId; }) : null;
          var pinStyle = (sectionRow && sectionRow.pin_style) || 'tag';
          pickedPhotos.forEach(function(photo, pinIdx) {
            var pos = { lat: Number(photo.lat), lng: Number(photo.lng) };
            var markerSpec = buildPinMarker(maps, photo, pinIdx, pinStyle);
            var marker = new maps.Marker({
              position: pos,
              map: map,
              icon: markerSpec.icon,
              title: photo.caption || photo.filename || 'Photo',
              label: markerSpec.label || undefined
            });
            bounds.extend(pos);
            marker.addListener('click', function() {
              var thumb = photo.thumb_url || photo.web_url || '';
              var cap = photo.caption || photo.filename || 'Photo';
              var safeCap = String(cap).replace(/</g, '&lt;').replace(/>/g, '&gt;');
              // Use onclick on the buttons since InfoWindow content
              // is created in a sub-DOM; pointing at IDs is simpler
              // than wrangling event delegation across the boundary.
              var html =
                '<div style="min-width:200px;max-width:260px;font-family:system-ui,sans-serif;">' +
                  (thumb ? '<img src="' + thumb + '" style="width:100%;max-height:140px;object-fit:cover;border-radius:4px;display:block;margin-bottom:8px;" alt="" />' : '') +
                  '<div style="font-size:12px;font-weight:600;color:#111;margin-bottom:8px;word-break:break-word;">' + safeCap + '</div>' +
                  '<div style="display:flex;gap:6px;">' +
                    '<button id="p86InfoOpen" style="flex:1;font-size:12px;padding:6px 8px;border-radius:4px;border:1px solid #ccc;background:#fff;color:#111;font-weight:600;cursor:pointer;">Open</button>' +
                    '<button id="p86InfoRemove" style="flex:1;font-size:12px;padding:6px 8px;border-radius:4px;border:1px solid #ddd;background:#fff;color:#dc2626;font-weight:600;cursor:pointer;">Remove</button>' +
                  '</div>' +
                '</div>';
              infoWin.setContent(html);
              infoWin.open(map, marker);
              // Defer button wiring to next tick so the InfoWindow
              // DOM is in place. Both buttons close the window after
              // firing.
              setTimeout(function() {
                var openBtn = document.getElementById('p86InfoOpen');
                var rmBtn = document.getElementById('p86InfoRemove');
                if (openBtn) openBtn.addEventListener('click', function() {
                  infoWin.close();
                  if (window.p86Attachments && window.p86Attachments.openLightbox) {
                    var idx = pickedPhotos.findIndex(function(p) { return p.id === photo.id; });
                    window.p86Attachments.openLightbox(pickedPhotos, Math.max(0, idx), { parentLabel: 'Report map', parentSubtitle: '' });
                  } else if (photo.original_url) {
                    window.open(photo.original_url, '_blank', 'noopener');
                  }
                });
                if (rmBtn) rmBtn.addEventListener('click', function() {
                  infoWin.close();
                  // Bubble a custom event to the section handler.
                  // detail.photoId carries which photo to drop.
                  mapEl.dispatchEvent(new CustomEvent('p86-photomap-remove', {
                    detail: { photoId: photo.id },
                    bubbles: true
                  }));
                });
              }, 0);
            });
          });
          if (pickedPhotos.length > 1) map.fitBounds(bounds, 48);
          // Stash a re-fit closure so the Fit-all toolbar button
          // can call it (the button handler in paint() runs in a
          // different scope and doesn't have access to `map` or
          // `bounds` directly).
          mapEl._p86RefitFn = function() {
            if (pickedPhotos.length > 1) map.fitBounds(bounds, 48);
            else if (pickedPhotos.length === 1) {
              map.panTo({ lat: Number(pickedPhotos[0].lat), lng: Number(pickedPhotos[0].lng) });
              map.setZoom(16);
            }
          };
          // Belt-and-braces: trigger a resize after a tick in case
          // the parent layout grew (e.g. flex layout finished
          // calculating). resize causes Google Maps to re-read the
          // host's dimensions and re-tile if needed. Re-fit after
          // resize so the viewport still frames the pins. Also
          // re-applies zoom 16 on single-pin maps so they don't
          // get stuck at whatever level the previous paint left.
          setTimeout(function() {
            if (!mapEl.isConnected) return;
            maps.event.trigger(map, 'resize');
            if (pickedPhotos.length > 1) map.fitBounds(bounds, 48);
            else if (pickedPhotos.length === 1) {
              map.setCenter({ lat: Number(pickedPhotos[0].lat), lng: Number(pickedPhotos[0].lng) });
              map.setZoom(16);
            }
          }, 200);

          // ResizeObserver — the real fix for cases where the host
          // mounts at 0×0 (modal animations, lazy CSS, parent flex
          // still computing). Whenever the host dimensions change,
          // fire Google Maps' resize event so the map re-tiles into
          // the new viewport. Also re-fits the bounds so pins stay
          // framed. The observer is stored on mapEl so subsequent
          // re-mounts can disconnect it before creating a new one.
          try {
            if (mapEl._p86ResizeObs) {
              try { mapEl._p86ResizeObs.disconnect(); } catch (e2) {}
            }
            if (typeof ResizeObserver !== 'undefined') {
              var lastW = 0, lastH = 0;
              var obs = new ResizeObserver(function(entries) {
                var rect = entries[0] && entries[0].contentRect;
                if (!rect) return;
                var w = Math.round(rect.width);
                var h = Math.round(rect.height);
                if (w === lastW && h === lastH) return;
                lastW = w; lastH = h;
                if (w < 10 || h < 10) return;
                maps.event.trigger(map, 'resize');
                if (pickedPhotos.length > 1) map.fitBounds(bounds, 48);
                else if (pickedPhotos.length === 1) {
                  map.setCenter({ lat: Number(pickedPhotos[0].lat), lng: Number(pickedPhotos[0].lng) });
                  map.setZoom(16);
                }
              });
              obs.observe(mapEl);
              mapEl._p86ResizeObs = obs;
            }
          } catch (e3) { /* ResizeObserver not available — fall back to the setTimeout above */ }

          // Print-path img injection. The body's synchronous attempt
          // at building the Static Maps URL fails on the very first
          // render of a saved report because window.p86Maps.getKey()
          // returns null before ready() resolves at least once. By
          // the time we get HERE, the key IS cached (ready() just
          // resolved). Build the URL now and inject the <img> next
          // to the interactive map so the print preview always has
          // a fallback image, regardless of paint() timing.
          try {
            var url = buildStaticMapsUrl(pickedPhotos, pinStyle);
            if (url) {
              var wrap = mapEl.parentElement;
              if (wrap) {
                var existing = wrap.querySelector('.p86-report-section-map-print');
                if (existing) {
                  if (existing.getAttribute('src') !== url) existing.setAttribute('src', url);
                } else {
                  var img = document.createElement('img');
                  img.className = 'p86-report-section-map-print';
                  img.alt = 'Photo locations';
                  img.src = url;
                  mapEl.insertAdjacentElement('afterend', img);
                }
              }
            }
          } catch (e) { /* print-path img is best-effort */ }
        }).catch(function(err) {
          mapEl.innerHTML = '<div class="p86-projects-empty">Map unavailable: ' + (err && err.message || 'unknown') + '</div>';
        });
      });
    }

    // Attachment picker for attachment-list sections. Lists every
    // non-image file already on the project (PDFs, Excel, Word,
    // drawings). Multi-select; commit on close.
    function openAttachmentPicker(targetSectionIdx) {
      var modal = document.createElement('div');
      modal.className = 'modal active';
      modal.id = 'projReportAttachmentPicker';
      var allFiles = (_detailState.photos || []).filter(function(a) {
        return a && a.mime_type && a.mime_type.indexOf('image/') !== 0;
      });
      var already = new Set(state.sections[targetSectionIdx].attachment_ids || []);
      var pending = new Set();

      function commitAndClose() {
        var ids = state.sections[targetSectionIdx].attachment_ids || [];
        allFiles.forEach(function(a) {
          if (pending.has(a.id) && ids.indexOf(a.id) === -1) ids.push(a.id);
        });
        state.sections[targetSectionIdx].attachment_ids = ids;
        modal.remove();
        paint();
        debouncedSave();
      }

      function rowsHTML() {
        if (!allFiles.length) {
          return '<div class="p86-proj-empty-line">No files in this project yet. Upload some via the Files tab first.</div>';
        }
        return allFiles.map(function(a) {
          var isAlready = already.has(a.id);
          var isPending = pending.has(a.id);
          var ext = (a.filename || '').split('.').pop().toUpperCase();
          return '<button type="button" class="p86-report-file-pick' + (isAlready ? ' added' : (isPending ? ' pending' : '')) + '" data-pick="' + escapeAttr(a.id) + '"' + (isAlready ? ' disabled' : '') + '>' +
            '<div class="p86-report-file-ext">' + escapeHTML(ext.slice(0, 4)) + '</div>' +
            '<div class="p86-report-file-meta">' +
              '<div class="p86-report-file-name">' + escapeHTML(a.filename || '(untitled)') + '</div>' +
              '<div class="p86-report-file-size">' + (a.size_bytes ? Math.round(a.size_bytes / 1024) + ' KB' : '') + (isAlready ? ' · already in this section' : (isPending ? ' · picked' : '')) + '</div>' +
            '</div>' +
          '</button>';
        }).join('');
      }

      modal.innerHTML =
        '<div class="modal-content" style="max-width:680px;">' +
          '<div class="modal-header">' +
            '<span>Attach files to "' + escapeHTML(state.sections[targetSectionIdx].label || 'section') + '"</span>' +
            '<button class="p86-modal-close" data-close>&times;</button>' +
          '</div>' +
          '<div class="p86-report-file-picker-body">' + rowsHTML() + '</div>' +
          '<div class="modal-footer">' +
            '<button class="ee-btn secondary" data-close>Cancel</button>' +
            '<button class="primary" data-add>Add selected</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
      modal.querySelectorAll('[data-close]').forEach(function(b) {
        b.addEventListener('click', function() { modal.remove(); });
      });
      function repaint() {
        modal.querySelector('.p86-report-file-picker-body').innerHTML = rowsHTML();
        wirePicks();
      }
      function wirePicks() {
        modal.querySelectorAll('[data-pick]').forEach(function(btn) {
          btn.addEventListener('click', function() {
            var id = btn.getAttribute('data-pick');
            if (pending.has(id)) pending.delete(id); else pending.add(id);
            repaint();
          });
        });
      }
      wirePicks();
      modal.querySelector('[data-add]').addEventListener('click', commitAndClose);
    }

    // Factory for fresh section objects. Used by seedSections,
    // addCustomSection, AND the new inter-section insert popover.
    // Single source of truth for the field shape so adding a new
    // section field anywhere only requires one edit here.
    function _makeSection(label, layout) {
      return {
        id: 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        label: label || '',
        layout: layout || 'photo-grid',
        photoSize: 'small',
        descSide:  'right',
        descSides: {},
        photo_ids: [],
        captions: {},
        text_body: '',
        attachment_ids: []
      };
    }
    function seedSections(labels) {
      labels.forEach(function(label) {
        state.sections.push(_makeSection(label, 'photo-grid'));
      });
      paint();
    }

    function addCustomSection() {
      var label = window.prompt('Section name:', '');
      if (!label) return;
      seedSections([label]);
    }

    // Insert a section at the given index with the given layout type.
    // Used by the inter-section "+" popover. before-after's
    // before/after image picker is configured via the layout id
    // alone; everything else just gets a blank shell the user fills
    // in. Pre-named so the user doesn't have to type a name first
    // (they can rename in-place via the section header input).
    function insertSectionAt(index, layout) {
      var defaultLabel = ({
        'photo-grid': 'New Section',
        'single-photo': 'New Stack',
        'before-after': 'Before / After',
        'text-block': 'Notes',
        'attachment-list': 'Attachments'
      })[layout] || 'New Section';
      var sec = _makeSection(defaultLabel, layout);
      var i = Math.max(0, Math.min(index, state.sections.length));
      state.sections.splice(i, 0, sec);
      paint();
      debouncedSave();
    }

    // Wave B3 — section schema now carries a `layout` field. Five
    // options: photo-grid (default — what we always rendered),
    // single-photo (one large photo per row, full width),
    // before-after (two photos side-by-side), text-block (narrative
    // only, no photos), attachment-list (download rows for PDFs).
    // sectionHTML dispatches on layout; each layout has its own
    // body renderer. The shared header carries a dropdown so the
    // user can switch any section after creation.
    // Layout-type buttons (replaces the old <select>). Each entry
    // pairs a layout id with the glyph + short label shown on the
    // icon button. Mutually exclusive — clicking one swaps the
    // section's layout (with the same content-loss confirm the
    // dropdown's change handler used).
    var LAYOUT_BUTTONS = [
      { id: 'photo-grid',      glyph: '⊞', label: 'Grid'  },  // ⊞
      { id: 'single-photo',    glyph: '☰', label: 'Stack' },  // ☰
      { id: 'before-after',    glyph: '⇆', label: 'B/A'   },  // ⇆
      { id: 'text-block',      glyph: '¶', label: 'Text'  },  // ¶
      { id: 'attachment-list', glyph: '\u{1F4CE}', label: 'Files' }, // 📎
      { id: 'photo-map',       glyph: '\u{1F5FA}', label: 'Map'  }  // 🗺
    ];
    // Photos-per-page mapping. Small = 4/page (2x2 grid), Medium =
    // 3/page (1x3 row), Large = 2/page (1x2 row of big photos). Used
    // by the page-break injection in the body templates so the print
    // PDF splits at every Nth photo, and by the section-header size
    // toggle to label each button with its photos-per-page count.
    var PER_PAGE = { small: 4, medium: 3, large: 2 };
    // Tiny inline SVGs depicting the grid shape each size produces.
    // currentColor inheritance lets the toggle's active state recolor
    // them via the existing .p86-report-section-iconbtn rules.
    function sizeGlyphSVG(rows, cols) {
      var W = 16, H = 12, gap = 1.4;
      var cellW = (W - gap * (cols + 1)) / cols;
      var cellH = (H - gap * (rows + 1)) / rows;
      var rects = '';
      for (var r = 0; r < rows; r++) {
        for (var c = 0; c < cols; c++) {
          var x = gap + c * (cellW + gap);
          var y = gap + r * (cellH + gap);
          rects += '<rect x="' + x.toFixed(2) + '" y="' + y.toFixed(2) +
            '" width="' + cellW.toFixed(2) + '" height="' + cellH.toFixed(2) +
            '" rx="0.6" fill="currentColor" />';
        }
      }
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" width="16" height="12" aria-hidden="true">' + rects + '</svg>';
    }
    var SIZE_BUTTONS = [
      // Small = 4/page rendered as a 2x2 grid icon
      { id: 'small',  glyph: sizeGlyphSVG(2, 2), title: '4 photos per page (2 × 2)' },
      // Medium = 3/page as a 1x3 row icon
      { id: 'medium', glyph: sizeGlyphSVG(1, 3), title: '3 photos per page (row)' },
      // Large = 2/page as a 1x2 row icon
      { id: 'large',  glyph: sizeGlyphSVG(1, 2), title: '2 photos per page (large)' }
    ];
    function isPhotoLayout(layout) {
      return layout === 'photo-grid' || layout === 'single-photo'
          || layout === 'before-after' || layout === 'photo-map';
    }
    // Per-photo descSide lookup. section.descSides is a map keyed by
    // photo id; missing entries fall back to the section default
    // (section.descSide) and ultimately to 'right'. Users can stagger
    // photos by flipping individual ones from a tiny swap button on
    // each card.
    function descSideFor(section, pid) {
      var m = section.descSides;
      if (m && (m[pid] === 'left' || m[pid] === 'right')) return m[pid];
      return (section.descSide === 'left') ? 'left' : 'right';
    }

    function toggleGroupHTML(name, buttons, activeId) {
      return '<div class="p86-report-section-toggles" data-toggle-group="' + name + '">' +
        buttons.map(function(b) {
          var active = (b.id === activeId) ? ' active' : '';
          var inner = '';
          if (b.glyph) inner += '<span class="p86-report-section-iconbtn-glyph">' + b.glyph + '</span>';
          if (b.label) inner += '<span class="p86-report-section-iconbtn-label">' + escapeHTML(b.label) + '</span>';
          // Tooltip: prefer explicit b.title (for icon-only buttons
          // where label is intentionally empty), else fall back to
          // the visible label, else the id as a last resort.
          var tip = b.title || b.label || b.id;
          return '<button type="button" class="p86-report-section-iconbtn' + active + '" data-toggle="' + name + '" data-value="' + escapeAttr(b.id) + '" title="' + escapeAttr(tip) + '">' +
            inner +
          '</button>';
        }).join('') +
      '</div>';
    }

    // CompanyCam-style "insert section here" affordance. Renders a
    // horizontal line + circular "+" button at every gap between
    // sections (and above the first, below the last). Click "+"
    // opens a popover with the 5 section types — pick one, the new
    // section drops in at this index.
    function insertRowHTML(atIndex) {
      return '<div class="p86-report-insert-row" data-insert-at="' + atIndex + '">' +
        '<div class="p86-report-insert-line"></div>' +
        '<button type="button" class="p86-report-insert-btn" title="Insert section here">+</button>' +
        '<div class="p86-report-insert-line"></div>' +
      '</div>';
    }

    // Popover for the "+" button. Positioned absolute next to the
    // clicked button. Click a layout option → insertSectionAt fires
    // → re-paint shows the new section in place. Click outside or
    // press Esc to dismiss without inserting.
    function openInsertMenu(anchorBtn, atIndex) {
      var prior = document.getElementById('p86ReportInsertMenu');
      if (prior) prior.remove();
      var menu = document.createElement('div');
      menu.id = 'p86ReportInsertMenu';
      menu.className = 'p86-report-insert-menu';
      menu.innerHTML = LAYOUT_BUTTONS.map(function(b) {
        return '<button type="button" data-insert-layout="' + escapeAttr(b.id) + '">' +
          '<span class="p86-report-insert-menu-glyph">' + b.glyph + '</span>' +
          '<span>' + escapeHTML(b.label) + '</span>' +
        '</button>';
      }).join('');
      document.body.appendChild(menu);
      // Position the menu just below the + button, anchored to its
      // left edge but clamped to viewport.
      var rect = anchorBtn.getBoundingClientRect();
      menu.style.top = (rect.bottom + window.scrollY + 6) + 'px';
      menu.style.left = Math.max(8, Math.min(rect.left + window.scrollX, window.innerWidth - menu.offsetWidth - 8)) + 'px';

      function close() {
        if (menu.parentNode) menu.parentNode.removeChild(menu);
        document.removeEventListener('mousedown', onAway, true);
        document.removeEventListener('keydown', onKey);
      }
      function onAway(e) {
        if (menu.contains(e.target)) return;
        close();
      }
      function onKey(e) {
        if (e.key === 'Escape') close();
      }
      setTimeout(function() {
        document.addEventListener('mousedown', onAway, true);
        document.addEventListener('keydown', onKey);
      }, 0);

      menu.querySelectorAll('[data-insert-layout]').forEach(function(btn) {
        btn.addEventListener('click', function() {
          var layout = btn.getAttribute('data-insert-layout');
          close();
          insertSectionAt(atIndex, layout);
        });
      });
    }

    function sectionHTML(section) {
      var layout = section.layout || 'photo-grid';
      var photoSize = section.photoSize || 'small';

      var layoutToggles = toggleGroupHTML('layout', LAYOUT_BUTTONS, layout);
      var sizeToggles = isPhotoLayout(layout)
        ? toggleGroupHTML('photoSize', SIZE_BUTTONS, photoSize)
        : '';
      // descSide moved to per-photo (a small swap button on each
      // photo card) so users can stagger left/right within a section.
      // The section header no longer carries that toggle.

      var addBtn = '';
      if (isPhotoLayout(layout)) {
        var addLabel = layout === 'before-after' ? '+ Pick 2 photos' : '+ Add photos';
        addBtn = '<button class="ee-btn secondary p86-report-section-add">' + addLabel + '</button>';
      } else if (layout === 'attachment-list') {
        addBtn = '<button class="ee-btn secondary p86-report-section-add">+ Attach files</button>';
      }

      // Photo-map gets two extra header buttons: Auto-pin all (one-
      // shot fill with every project photo that has GPS, skipping
      // already-picked) and Unpin all (clears section.photo_ids).
      // Auto-pin is always available so the user can refresh after
      // taking new geotagged photos. Unpin only renders when the
      // section has any picks.
      //
      // Pin-style picker lives next to them — a select with five
      // visual treatments (tag / numbered / lettered / photo / dot).
      // Default 'tag' matches the existing color+glyph behavior so
      // existing reports look unchanged after this commit.
      var mapBtns = '';
      if (layout === 'photo-map') {
        var pickCount = Array.isArray(section.photo_ids) ? section.photo_ids.length : 0;
        var pinStyle = section.pin_style || 'tag';
        var pinStyleSelect =
          '<select class="p86-report-section-pinstyle" title="Pin style — how each photo appears on the map">' +
            '<option value="tag"' + (pinStyle === 'tag' ? ' selected' : '') + '>📍 Tag colors</option>' +
            '<option value="numbered"' + (pinStyle === 'numbered' ? ' selected' : '') + '>📍 Numbered</option>' +
            '<option value="lettered"' + (pinStyle === 'lettered' ? ' selected' : '') + '>📍 Lettered</option>' +
            '<option value="photo"' + (pinStyle === 'photo' ? ' selected' : '') + '>📍 Photo thumb</option>' +
            '<option value="dot"' + (pinStyle === 'dot' ? ' selected' : '') + '>📍 Plain dot</option>' +
          '</select>';
        mapBtns =
          '<button class="ee-btn secondary p86-report-section-autopin" title="Add every project photo that has GPS data">&#x1F4CD; Auto-pin all</button>' +
          (pickCount
            ? '<button class="ee-btn secondary p86-report-section-unpin" title="Remove all photos from this map section">Unpin all</button>'
            : '') +
          pinStyleSelect;
      }

      var body;
      if (layout === 'text-block') body = sectionTextBlockBodyHTML(section);
      else if (layout === 'attachment-list') body = sectionAttachmentListBodyHTML(section);
      else if (layout === 'single-photo') body = sectionSinglePhotoBodyHTML(section);
      else if (layout === 'before-after') body = sectionBeforeAfterBodyHTML(section);
      else if (layout === 'photo-map') body = sectionPhotoMapBodyHTML(section);
      else body = sectionPhotoGridBodyHTML(section);

      return '<div class="p86-report-section layout-' + escapeAttr(layout) + '" data-sec="' + escapeAttr(section.id) + '">' +
        '<div class="p86-report-section-header">' +
          '<input class="p86-report-section-label" value="' + escapeAttr(section.label) + '" placeholder="Section name" />' +
          '<div class="p86-report-section-actions">' +
            layoutToggles +
            sizeToggles +
            addBtn +
            mapBtns +
            '<button class="ee-btn secondary p86-report-section-remove">Remove</button>' +
          '</div>' +
        '</div>' +
        body +
      '</div>';
    }

    // Renders the photo's OWN description (att.caption) + tags into
    // a side column. Only emitted when at least one of the two has
    // content, so plain photos keep the compact stacked layout. The
    // bottom-of-card caption input is the report-section figure
    // reference and stays where it is. The report layout uses NEUTRAL
    // tag chips (no hue color) so reports print clean — colored chips
    // stay in the project feed / photo viewer / filter strips.
    function photoSideColumnHTML(att, currentSide) {
      if (!att) return '';
      var hasDesc = !!att.caption;
      var hasTags = Array.isArray(att.tags) && att.tags.length > 0;
      var hasUploader = !!att.uploaded_by_name;
      var hasUploadedAt = !!att.uploaded_at;
      // The side column is shown when at least one piece of metadata
      // is available — never blocks plain photos from rendering
      // compact.
      if (!hasDesc && !hasTags && !hasUploader && !hasUploadedAt) return '';
      var html = '<div class="p86-report-photo-sidedesc">';
      // Side-swap button — top of the column, always visible (no
      // hover gate so mobile users can find it). Click flips THIS
      // photo's descSide between left/right.
      var swapBtn = '';
      if (typeof currentSide === 'string') {
        var nextSide = (currentSide === 'left') ? 'right' : 'left';
        var glyph = (currentSide === 'left') ? '&#x25B6;' : '&#x25C0;';
        swapBtn = '<button type="button" class="p86-report-photo-sideswap" data-side-swap="' + nextSide + '" title="Move description to the other side">' + glyph + '</button>';
      }
      // Put the swap button in a small row at the top of the side
      // column. If there's no metadata above, the row stands alone;
      // if there's a description, the row sits flush to the right
      // of the first line.
      if (swapBtn) html += '<div class="p86-report-photo-sidedesc-tools">' + swapBtn + '</div>';
      if (hasDesc) html += '<div class="p86-report-photo-sidedesc-text">' + escapeHTML(att.caption) + '</div>';
      // CompanyCam-style metadata list — each item is an icon + the
      // value, stacked vertically. Icons are Heroicons-style filled
      // SVGs (currentColor) so they pick up the side-column text color
      // and render crisp at any zoom. Tag icon is the classic diagonal
      // price-tag shape.
      var ICON_USER     = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M12 12a5 5 0 1 0 0-10 5 5 0 0 0 0 10Zm0 2c-4.418 0-8 2.91-8 6.5V22h16v-1.5c0-3.59-3.582-6.5-8-6.5Z"/></svg>';
      var ICON_CALENDAR = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 2a1 1 0 0 1 1 1v1h8V3a1 1 0 1 1 2 0v1h1a3 3 0 0 1 3 3v12a3 3 0 0 1-3 3H5a3 3 0 0 1-3-3V7a3 3 0 0 1 3-3h1V3a1 1 0 0 1 1-1Zm14 7H3v10a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V9Z"/></svg>';
      var ICON_TAG      = '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M5.5 3A2.5 2.5 0 0 0 3 5.5v5.379a2.5 2.5 0 0 0 .732 1.768l8.121 8.121a2.5 2.5 0 0 0 3.536 0l5.379-5.379a2.5 2.5 0 0 0 0-3.536L12.647 3.732A2.5 2.5 0 0 0 10.879 3H5.5Zm2 5a1.5 1.5 0 1 0 0-3 1.5 1.5 0 0 0 0 3Z" clip-rule="evenodd"/></svg>';
      var metaItems = [];
      if (hasUploader) {
        metaItems.push({ icon: ICON_USER, text: att.uploaded_by_name });
      }
      if (hasUploadedAt) {
        var d = new Date(att.uploaded_at);
        var when = '';
        if (!isNaN(d.getTime())) {
          try {
            when = d.toLocaleString(undefined, {
              year: 'numeric', month: 'long', day: 'numeric',
              hour: 'numeric', minute: '2-digit'
            });
          } catch (e) {
            when = d.toLocaleString();
          }
        }
        if (when) metaItems.push({ icon: ICON_CALENDAR, text: when });
      }
      if (hasTags) {
        att.tags.forEach(function(t) {
          metaItems.push({ icon: ICON_TAG, text: t });
        });
      }
      if (metaItems.length) {
        html += '<div class="p86-report-photo-sidetags">' +
          metaItems.map(function(m) {
            return '<span class="p86-report-photo-sidetag">' +
              '<span class="p86-report-photo-sidetag-icon" aria-hidden="true">' + m.icon + '</span>' +
              '<span class="p86-report-photo-sidetag-text">' + escapeHTML(m.text) + '</span>' +
            '</span>';
          }).join('') +
        '</div>';
      }
      html += '</div>';
      return html;
    }
    // Per-photo "swap side" button — appears on the photo when a
    // side description/tags exist. Click flips THIS photo's descSide
    // between left/right so users can stagger placement.
    function photoSideSwapHTML(currentSide) {
      var nextSide = (currentSide === 'left') ? 'right' : 'left';
      var glyph = (currentSide === 'left') ? '&#x25B6;' : '&#x25C0;'; // ▶ / ◀
      return '<button type="button" class="p86-report-photo-sideswap" data-side-swap="' + nextSide + '" title="Move description to the other side">' + glyph + '</button>';
    }
    // Does this attachment carry anything that would render in the
    // side column? Used to apply the .has-sidedesc grid class only
    // when something is actually there. Includes uploader name and
    // upload date now (CompanyCam-style metadata list), so virtually
    // every photo gets the side column — that's the intended look.
    function attHasSideContent(att) {
      if (!att) return false;
      if (att.caption) return true;
      if (Array.isArray(att.tags) && att.tags.length) return true;
      if (att.uploaded_by_name) return true;
      if (att.uploaded_at) return true;
      return false;
    }
    // Tile-level affordances: drag handle (top-left, hover-only) +
    // existing remove button. The whole card is draggable so users
    // can grab anywhere; the handle is a visual cue.
    function photoDragHandleHTML() {
      return '<span class="p86-report-photo-drag" title="Drag to reorder">&#x2630;</span>';
    }

    // Inline canvas overlay for the photo — emitted only when the
    // attachment carries annotation strokes. Same trick used by the
    // photo tiles in the project feed: the canvas's internal bitmap
    // matches the WEB-variant pixel coords (the coord space the
    // strokes live in), then CSS scales it to overlay the thumb img.
    // Painted in wireSectionAnnotationCanvases() once the DOM is up.
    function photoAnnotationCanvasHTML(att, pid) {
      if (!att || !Array.isArray(att.annotations) || !att.annotations.length) return '';
      return '<canvas class="p86-report-photo-anno" data-anno-photo="' + escapeAttr(pid) + '"></canvas>';
    }

    function sectionPhotoGridBodyHTML(section) {
      var size = section.photoSize || 'small';
      var perPage = PER_PAGE[size] || 4;
      var photoCount = section.photo_ids.length;
      return '<div class="p86-report-section-photos size-' + escapeAttr(size) + '">' +
        (photoCount === 0
          ? '<div class="p86-proj-empty-line" style="grid-column:1/-1;">No photos in this section yet.</div>'
          : section.photo_ids.map(function(pid, idx) {
              var att = allPhotos.find(function(a) { return a.id === pid; });
              if (!att) return '<div class="p86-report-photo p86-report-photo-missing">(photo deleted)</div>';
              var caption = section.captions[pid] || '';
              var hasSide = attHasSideContent(att);
              var photoSide = descSideFor(section, pid);
              var sideClasses = '';
              if (hasSide) sideClasses += ' has-sidedesc';
              if (hasSide && photoSide === 'left') sideClasses += ' desc-left';
              // Drag handle + remove X live INSIDE the mainstack so
              // they anchor to the image corners — not the outer card.
              // The per-photo side-swap button only appears when a
              // side column is actually rendered.
              var cardHTML = '<div class="p86-report-photo' + sideClasses +
                  '" draggable="true" data-photo-id="' + escapeAttr(pid) + '" data-photo-idx="' + idx + '">' +
                '<div class="p86-report-photo-mainstack">' +
                  photoDragHandleHTML() +
                  '<img src="' + escapeAttr(att.thumb_url || att.web_url) + '" alt="" data-open-photo="' + escapeAttr(pid) + '" />' +
                  photoAnnotationCanvasHTML(att, pid) +
                  '<button type="button" class="p86-report-photo-remove" data-rm-photo="' + escapeAttr(pid) + '" title="Remove from section">&times;</button>' +
                  '<input class="p86-report-photo-caption" value="' + escapeAttr(caption) + '" data-caption-input="' + escapeAttr(pid) + '" placeholder="Caption (optional)" />' +
                '</div>' +
                photoSideColumnHTML(att, hasSide ? photoSide : null) +
              '</div>';
              // Inject a page-break separator after every Nth photo
              // (skip the last position — no trailing break needed).
              // grid-column:1/-1 in CSS makes the separator span all
              // columns, splitting the grid into per-page rows.
              if ((idx + 1) % perPage === 0 && idx < photoCount - 1) {
                var pageNum = Math.floor((idx + 1) / perPage) + 1;
                cardHTML += '<div class="p86-report-page-break" data-label="Page ' + pageNum + '"></div>';
              }
              return cardHTML;
            }).join('')) +
      '</div>';
    }

    function sectionSinglePhotoBodyHTML(section) {
      // One photo per row. Reuses the caption input pattern so the
      // existing wiring keeps working. photoSize controls each
      // card's max-width so the section can leave room for
      // descriptions or pack photos tighter.
      var size = section.photoSize || 'small';
      var perPage = PER_PAGE[size] || 4;
      var photoCount = section.photo_ids.length;
      return '<div class="p86-report-section-singles">' +
        (photoCount === 0
          ? '<div class="p86-proj-empty-line">No photos yet — tap "+ Add photos".</div>'
          : section.photo_ids.map(function(pid, idx) {
              var att = allPhotos.find(function(a) { return a.id === pid; });
              if (!att) return '<div class="p86-report-photo-single p86-report-photo-missing">(photo deleted)</div>';
              var caption = section.captions[pid] || '';
              var hasSide = attHasSideContent(att);
              var photoSide = descSideFor(section, pid);
              var sideClasses = '';
              if (hasSide) sideClasses += ' has-sidedesc';
              if (hasSide && photoSide === 'left') sideClasses += ' desc-left';
              var cardHTML = '<div class="p86-report-photo-single size-' + escapeAttr(size) + sideClasses +
                  '" draggable="true" data-photo-id="' + escapeAttr(pid) + '" data-photo-idx="' + idx + '">' +
                '<div class="p86-report-photo-mainstack">' +
                  photoDragHandleHTML() +
                  '<img src="' + escapeAttr(att.web_url || att.thumb_url) + '" alt="" data-open-photo="' + escapeAttr(pid) + '" />' +
                  photoAnnotationCanvasHTML(att, pid) +
                  '<button type="button" class="p86-report-photo-remove" data-rm-photo="' + escapeAttr(pid) + '" title="Remove">&times;</button>' +
                  '<input class="p86-report-photo-caption" value="' + escapeAttr(caption) + '" data-caption-input="' + escapeAttr(pid) + '" placeholder="Caption (optional)" />' +
                '</div>' +
                photoSideColumnHTML(att, hasSide ? photoSide : null) +
              '</div>';
              // Page-break separator every Nth photo — same logic as
              // the grid layout but rendered inline in the flex column.
              if ((idx + 1) % perPage === 0 && idx < photoCount - 1) {
                var pageNum = Math.floor((idx + 1) / perPage) + 1;
                cardHTML += '<div class="p86-report-page-break" data-label="Page ' + pageNum + '"></div>';
              }
              return cardHTML;
            }).join('')) +
      '</div>';
    }

    function sectionBeforeAfterBodyHTML(section) {
      // Pair display: two photos side-by-side. The picker enforces
      // a max of 2 picks; the first picked is "Before", the second
      // is "After". Caption inputs sit under each photo for label
      // overrides ("Before — Apr 2024").
      var pair = section.photo_ids.slice(0, 2);
      var slot = function(pid, fallbackLabel) {
        if (!pid) {
          return '<div class="p86-report-photo-pair-empty">' + escapeHTMLLocal(fallbackLabel) + '<br/><span>No photo selected</span></div>';
        }
        var att = allPhotos.find(function(a) { return a.id === pid; });
        if (!att) return '<div class="p86-report-photo-pair p86-report-photo-missing">(photo deleted)</div>';
        var caption = section.captions[pid] || fallbackLabel;
        return '<div class="p86-report-photo-pair">' +
          '<img src="' + escapeAttr(att.web_url || att.thumb_url) + '" alt="" />' +
          '<input class="p86-report-photo-caption" value="' + escapeAttr(caption) + '" data-caption-input="' + escapeAttr(pid) + '" placeholder="' + escapeAttr(fallbackLabel) + '" />' +
          '<button type="button" class="p86-report-photo-remove" data-rm-photo="' + escapeAttr(pid) + '" title="Remove">&times;</button>' +
        '</div>';
      };
      return '<div class="p86-report-section-pair">' +
        slot(pair[0], 'Before') +
        slot(pair[1], 'After') +
      '</div>';
    }

    function sectionTextBlockBodyHTML(section) {
      var body = section.text_body || '';
      return '<div class="p86-report-section-text">' +
        '<textarea class="p86-report-section-text-input" rows="6" placeholder="Type your narrative here…">' + escapeHTML(body) + '</textarea>' +
      '</div>';
    }

    // Photo Map layout — picks the same way photo-grid does (photo_ids
    // array on the section), but renders selected photos as pins on a
    // Google Map instead of a tile grid. Only photos with lat/lng
    // appear as pins; the rest get a small "no location" footer.
    // Each pin uses the tag-icon registry from js/tag-icons.js.
    //
    // Two map elements get rendered for every photo-map section:
    //   - Interactive Google Maps div (.p86-report-section-map) —
    //     shown on screen, hidden on print
    //   - Print-only <img> with a Google Static Maps URL — hidden on
    //     screen, shown on print. Paper reports get a real snapshot
    //     of the map instead of a blank rectangle
    //
    // Pickers: the section header's standard "+ Add photos" button
    // (rendered by sectionHTML's addBtn branch) is the canonical
    // entry point. isPhotoLayout('photo-map') is true so the wiring
    // at paint() lines ~2565 binds it to openPhotoPicker(sIdx)
    // automatically. We don't render a duplicate picker here.
    // Pin renderer for photo-map markers. Returns { icon, label }
    // shaped for google.maps.Marker. The `icon` field carries the
    // SVG data URL + anchor + scaledSize; the `label` field (when
    // returned non-null) draws crisp text on top using Google's
    // built-in label rendering — cheaper than embedding text in
    // SVG and avoids font-loading quirks.
    //
    //   tag      — colored circle + glyph from tag-icons.js
    //   numbered — circle with the 1-based index, palette = accent
    //   lettered — circle with A, B, ... (Z → AA → BB, etc.)
    //   photo    — round thumbnail of the actual photo (uses
    //              attachment.thumb_url; falls back to a tag pin if
    //              the photo has no thumb yet)
    //   dot      — plain colored circle, no glyph
    //
    // The function uses the lettering helper for the lettered style
    // so we can serialize index → A, B, ... Z, AA, BB, etc.
    // Build the Static Maps API URL for a photo-map section's print
    // fallback. The Static Maps API only supports a small subset of
    // what the JS API can show — single-digit/letter labels per
    // marker, hex color, no thumbnails. So:
    //   tag / dot:   color from tag-icons → 0xRRGGBB
    //   numbered:    1-9 use Static labels; 10+ fall back to colored
    //                dots (Static can't render multi-char labels)
    //   lettered:    A-Z labels; AA+ fall back to colored dots
    //   photo:       no thumb support → colored dots
    // Returns '' (empty string) when no key is cached or no photos
    // have coords; callers should skip injecting the <img> in that
    // case.
    function buildStaticMapsUrl(pickedPhotos, pinStyle) {
      if (!pickedPhotos || !pickedPhotos.length) return '';
      var key = (window.p86Maps && window.p86Maps.getKey && window.p86Maps.getKey()) || '';
      if (!key) return '';
      var markerStrs = pickedPhotos.slice(0, 60).map(function(p, idx) {
        var color = '0xef4444';
        var label = '';
        if (pinStyle === 'numbered') {
          var n = idx + 1;
          if (n <= 9) { label = String(n); color = '0x4f8cff'; }
          else        { color = '0x4f8cff'; }
        } else if (pinStyle === 'lettered') {
          var letters = indexToLetters(idx);
          if (letters.length === 1) { label = letters; color = '0x22d3ee'; }
          else                       { color = '0x22d3ee'; }
        } else if (pinStyle === 'dot' || pinStyle === 'photo') {
          var tagIcon = window.p86TagIcons ? window.p86TagIcons.forPhoto(p) : null;
          color = (tagIcon && tagIcon.bg) ? tagIcon.bg.replace('#', '0x') : '0x6b7280';
        } else {
          // tag (default)
          var ti = window.p86TagIcons ? window.p86TagIcons.forPhoto(p) : null;
          color = (ti && ti.bg) ? ti.bg.replace('#', '0x') : '0xef4444';
        }
        var parts = ['color:' + color];
        if (label) parts.push('label:' + label);
        return 'markers=' + parts.join('%7C') + '%7C' + Number(p.lat) + ',' + Number(p.lng);
      });
      return 'https://maps.googleapis.com/maps/api/staticmap'
        + '?size=640x360&maptype=hybrid&scale=2'
        + '&' + markerStrs.join('&')
        + '&key=' + encodeURIComponent(key);
    }

    function indexToLetters(n) {
      // 0→A, 1→B, ..., 25→Z, 26→AA, 27→BB, etc.
      var letters = '';
      n = Math.max(0, n);
      while (true) {
        letters = String.fromCharCode(65 + (n % 26)) + letters;
        if (n < 26) break;
        n = Math.floor(n / 26) - 1;
      }
      return letters;
    }
    function buildPinMarker(maps, photo, pinIdx, pinStyle) {
      // Standard 28px circle + drop shadow, varied per style.
      var bg, fg, glyph;
      if (pinStyle === 'numbered') {
        bg = '#4f8cff'; fg = '#fff'; glyph = String(pinIdx + 1);
      } else if (pinStyle === 'lettered') {
        bg = '#22d3ee'; fg = '#0a0a0a'; glyph = indexToLetters(pinIdx);
      } else if (pinStyle === 'dot') {
        var icon = window.p86TagIcons ? window.p86TagIcons.forPhoto(photo) : null;
        bg = (icon && icon.bg) || '#6b7280'; fg = '#fff'; glyph = '';
      } else if (pinStyle === 'photo') {
        // Photo-thumb pins: a circular clipped img. We can't put an
        // <img> inside an SVG data URL reliably across all map
        // renderers, so we use an SVG <image href="…"> referencing
        // the photo's thumb_url. Browsers + Google Maps handle it.
        var thumb = photo.thumb_url || photo.web_url || '';
        if (thumb) {
          var svg = '<svg xmlns="http://www.w3.org/2000/svg" width="36" height="36" viewBox="0 0 36 36">' +
            '<defs>' +
              '<clipPath id="pclip"><circle cx="18" cy="18" r="15"/></clipPath>' +
              '<filter id="psh" x="-20%" y="-20%" width="140%" height="140%">' +
                '<feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.5"/>' +
              '</filter>' +
            '</defs>' +
            '<circle cx="18" cy="18" r="17" fill="white" filter="url(#psh)"/>' +
            '<image href="' + thumb + '" x="3" y="3" width="30" height="30" clip-path="url(#pclip)" preserveAspectRatio="xMidYMid slice"/>' +
            '<circle cx="18" cy="18" r="15" fill="none" stroke="white" stroke-width="2"/>' +
          '</svg>';
          return {
            icon: {
              url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
              anchor: new maps.Point(18, 36),
              scaledSize: new maps.Size(36, 36)
            },
            label: null
          };
        }
        // Fallback to tag style when the photo has no thumbnail.
        pinStyle = 'tag';
      }
      if (pinStyle === 'tag' || !bg) {
        var tagIcon = window.p86TagIcons ? window.p86TagIcons.forPhoto(photo) : { bg: '#6b7280', fg: '#fff', glyph: '●' };
        bg = tagIcon.bg; fg = tagIcon.fg; glyph = tagIcon.glyph;
      }
      // Standard circle SVG used by all glyph-based styles. Glyph
      // text rendered server-side in the SVG for tag/dot (single
      // char) and via maps.Label for numbered/lettered (clean text
      // without font baking).
      var hasInlineGlyph = (pinStyle === 'tag' || pinStyle === 'dot') && glyph;
      var glyphMarkup = hasInlineGlyph
        ? '<text x="14" y="18" text-anchor="middle" font-size="13" font-family="Arial,sans-serif" font-weight="bold" fill="' + fg + '">' + glyph + '</text>'
        : '';
      var pinSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 28 28">' +
        '<defs><filter id="ms"><feDropShadow dx="0" dy="1" stdDeviation="1.5" flood-opacity="0.5"/></filter></defs>' +
        '<circle cx="14" cy="14" r="11" fill="' + bg + '" stroke="white" stroke-width="2.5" filter="url(#ms)"/>' +
        glyphMarkup +
      '</svg>';
      var label = null;
      if (!hasInlineGlyph && glyph) {
        // Numbered / lettered get a Google Maps label — clean type,
        // automatic centering, fewer font headaches than SVG <text>.
        label = {
          text: String(glyph),
          color: fg,
          fontSize: glyph.length >= 3 ? '10px' : '12px',
          fontWeight: '700'
        };
      }
      return {
        icon: {
          url: 'data:image/svg+xml;utf8,' + encodeURIComponent(pinSvg),
          anchor: new maps.Point(14, 28),
          scaledSize: new maps.Size(28, 28)
        },
        label: label
      };
    }

    // A photo has a usable map pin only if its coords are finite, within
    // real-world range, AND not the 0,0 "null island". Without the range +
    // null-island guard a single bad/missing geotag (which Number.isFinite
    // accepts because isFinite(0) === true) drags fitBounds out to a
    // world-view over the ocean and the whole HYBRID map reads as blank.
    function hasValidGeo(p) {
      if (!p) return false;
      var lat = Number(p.lat), lng = Number(p.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
      if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return false;
      if (lat === 0 && lng === 0) return false;
      return true;
    }

    function sectionPhotoMapBodyHTML(section) {
      var ids = Array.isArray(section.photo_ids) ? section.photo_ids : [];
      var picked = ids.map(function(pid) {
        return allPhotos.find(function(a) { return a.id === pid; });
      }).filter(Boolean);
      var withCoords = picked.filter(function(p) {
        return hasValidGeo(p);
      });
      var withoutCoords = picked.filter(function(p) {
        return !hasValidGeo(p);
      });

      var emptyHelp = picked.length === 0
        ? '<div class="p86-report-section-empty">Use <strong>+ Add photos</strong> in the section header to pick photos. Those with GPS data plot as pins on the map.</div>'
        : (withCoords.length === 0
          ? '<div class="p86-report-section-empty">None of the picked photos have location data. Photos taken with location services on get GPS tags automatically.</div>'
          : '');

      var mapId = 'reportMap_' + section.id;
      var coordIds = withCoords.map(function(p){return p.id;});
      var mapBody = withCoords.length
        ? '<div class="p86-report-section-map" id="' + escapeAttr(mapId) + '" data-photo-map="1" data-photo-ids="' + escapeAttr(JSON.stringify(coordIds)) + '"></div>'
        : '';

      // Print fallback — Static Maps URL with one marker per photo,
      // styled per section.pin_style (see buildStaticMapsUrl).
      // URL length caps at ~8KB so we cap at 60 pins (Google's own
      // soft limit). On the very first paint of a saved report the
      // URL is empty (key not yet cached); the photo-map mount loop
      // re-injects it post-mount.
      var pinStyleBody = section.pin_style || 'tag';
      var staticUrl = buildStaticMapsUrl(withCoords, pinStyleBody);
      var staticImg = staticUrl
        ? '<img class="p86-report-section-map-print" alt="Photo locations" src="' + escapeAttr(staticUrl) + '" />'
        : '';

      // Footer lines under the map: photos without GPS coords, plus
      // a heads-up if we'd hit the Static Maps 60-pin URL-length cap
      // on print. Both are advisory — the live interactive map shows
      // every pin regardless of count.
      var truncatedOnPrint = withCoords.length > 60;
      var unmappedNote = withoutCoords.length
        ? '<div class="p86-report-section-map-unmapped">' +
            '<strong>' + withoutCoords.length + '</strong> picked photo' + (withoutCoords.length === 1 ? '' : 's') + ' without location data.' +
          '</div>'
        : '';
      var truncNote = truncatedOnPrint
        ? '<div class="p86-report-section-map-unmapped">' +
            'Print snapshot shows the first <strong>60</strong> pins (' + (withCoords.length - 60) + ' more on the live map).' +
          '</div>'
        : '';
      var unmapped = unmappedNote + truncNote;

      // Chrome strip above the map — pin count + Fit-all button.
      // Hidden on print via the existing photo-map @media print
      // rules (only the static <img> shows on paper). Only renders
      // when we actually have a map to operate on.
      var toolbar = withCoords.length
        ? '<div class="p86-report-section-map-toolbar">' +
            '<span class="p86-report-section-map-count">' +
              withCoords.length + ' pin' + (withCoords.length === 1 ? '' : 's') +
            '</span>' +
            '<button type="button" class="p86-report-section-map-fit" title="Re-fit the map around all pins">&#x26F6; Fit all</button>' +
          '</div>'
        : '';

      return '<div class="p86-report-section-map-wrap">' +
        emptyHelp +
        toolbar +
        mapBody +
        staticImg +
        unmapped +
      '</div>';
    }

    function sectionAttachmentListBodyHTML(section) {
      var ids = Array.isArray(section.attachment_ids) ? section.attachment_ids : [];
      var allFiles = (_detailState.photos || []).filter(function(a) { return a.mime_type && a.mime_type.indexOf('image/') !== 0; });
      var rowsHTML = ids.length === 0
        ? '<div class="p86-proj-empty-line">No files attached. Tap "+ Attach files" to choose from the project Files tab.</div>'
        : ids.map(function(aid) {
            var att = allFiles.find(function(a) { return a.id === aid; });
            if (!att) return '<div class="p86-report-file-row p86-report-photo-missing" data-rm-att="' + escapeAttr(aid) + '">(file removed)<button type="button">&times;</button></div>';
            var ext = (att.filename || '').split('.').pop().toUpperCase();
            return '<div class="p86-report-file-row">' +
              '<div class="p86-report-file-ext">' + escapeHTML(ext.slice(0, 4)) + '</div>' +
              '<div class="p86-report-file-meta">' +
                '<div class="p86-report-file-name">' + escapeHTML(att.filename || '(untitled)') + '</div>' +
                '<div class="p86-report-file-size">' + (att.size_bytes ? Math.round(att.size_bytes / 1024) + ' KB' : '') + '</div>' +
              '</div>' +
              '<button type="button" class="p86-report-photo-remove" data-rm-att="' + escapeAttr(aid) + '" title="Remove">&times;</button>' +
            '</div>';
          }).join('');
      return '<div class="p86-report-section-files">' + rowsHTML + '</div>';
    }

    function openPhotoPicker(targetSectionIdx) {
      // Photo picker uses LOCAL selection state — picks accumulate
      // without repainting the editor underneath. Commit + close
      // happens only when the user clicks "Add N photos" or "Done".
      // Previously the picker called paint() on every click which
      // rebuilt the editor and made the picker feel like it was
      // closing / dancing around.
      var modal = document.createElement('div');
      modal.className = 'modal active';
      modal.id = 'projReportPhotoPicker';
      var alreadyInSection = new Set(state.sections[targetSectionIdx].photo_ids);
      // Pending picks the user has made in THIS picker session — not
      // yet pushed to state.sections. Commit on close.
      var pendingPicks = new Set();

      function commitAndClose() {
        // Push pending picks into the section in display order.
        allPhotos.forEach(function(att) {
          if (!pendingPicks.has(att.id)) return;
          if (state.sections[targetSectionIdx].photo_ids.indexOf(att.id) === -1) {
            state.sections[targetSectionIdx].photo_ids.push(att.id);
          }
        });
        // Wave B3: before-after sections only render the first 2
        // photos. Cap here so the picker enforces the constraint
        // visibly rather than silently dropping extras at render.
        var layout = state.sections[targetSectionIdx].layout || 'photo-grid';
        if (layout === 'before-after') {
          state.sections[targetSectionIdx].photo_ids = state.sections[targetSectionIdx].photo_ids.slice(0, 2);
        }
        modal.remove();
        paint(); // single repaint of the editor at close time
        debouncedSave();
      }

      function cancelAndClose() {
        modal.remove();
      }

      function repaintPicker() {
        var grid = modal.querySelector('.p86-report-picker-grid');
        if (grid) grid.innerHTML = renderPickerGridHTML();
        wireTiles();
        updateFooter();
      }

      function renderPickerGridHTML() {
        return allPhotos.map(function(att) {
          var isAlready = alreadyInSection.has(att.id);
          var isPending = pendingPicks.has(att.id);
          var stateClass = isAlready ? ' p86-report-picker-tile-added' : (isPending ? ' p86-report-picker-tile-pending' : '');
          var badge = isAlready ? '<span class="p86-report-picker-added-badge">Added</span>'
                    : isPending ? '<span class="p86-report-picker-added-badge p86-report-picker-pending-badge">&#x2713; Picked</span>'
                    : '';
          return '<button class="p86-report-picker-tile' + stateClass + '" data-pick="' + escapeAttr(att.id) + '"' + (isAlready ? ' disabled' : '') + ' type="button">' +
            '<img src="' + escapeAttr(att.thumb_url || att.web_url) + '" alt="" />' +
            badge +
          '</button>';
        }).join('');
      }

      function wireTiles() {
        modal.querySelectorAll('[data-pick]').forEach(function(btn) {
          btn.onclick = function() {
            var pid = btn.getAttribute('data-pick');
            if (pendingPicks.has(pid)) pendingPicks.delete(pid);
            else pendingPicks.add(pid);
            repaintPicker();
          };
        });
      }

      function updateFooter() {
        var addBtn = modal.querySelector('#rptPickerAdd');
        if (addBtn) {
          addBtn.textContent = pendingPicks.size
            ? 'Add ' + pendingPicks.size + ' photo' + (pendingPicks.size === 1 ? '' : 's')
            : 'Done';
          addBtn.disabled = false;
        }
      }

      modal.innerHTML =
        '<div class="modal-content" style="max-width:760px;">' +
          '<div class="modal-header">' +
            '<span>Add photos to "' + escapeHTML(state.sections[targetSectionIdx].label || 'section') + '"</span>' +
            '<button class="p86-modal-close" data-close>&times;</button>' +
          '</div>' +
          '<div class="p86-proj-create-body">' +
            (allPhotos.length === 0
              ? '<div class="p86-proj-empty-line">No photos in this project yet. Upload some first.</div>'
              : '<div class="p86-report-picker-hint">Click tiles to add them. Repeat to remove. Click <strong>Add N photos</strong> when you\'re done.</div>' +
                '<div class="p86-report-picker-grid">' + renderPickerGridHTML() + '</div>') +
          '</div>' +
          '<div class="modal-footer">' +
            '<button class="ee-btn secondary" data-cancel>Cancel</button>' +
            '<button class="primary" id="rptPickerAdd">Done</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      modal.addEventListener('click', function(e) { if (e.target === modal) cancelAndClose(); });
      modal.querySelectorAll('[data-close], [data-cancel]').forEach(function(b) {
        b.addEventListener('click', function() { cancelAndClose(); });
      });
      var addBtn = modal.querySelector('#rptPickerAdd');
      if (addBtn) addBtn.addEventListener('click', commitAndClose);
      wireTiles();
      updateFooter();
    }

    paint();
  }

  // ──────────────────────────────────────────────────────────────────
  // Files tab — non-image attachments (PDFs, docs, etc.)
  // ──────────────────────────────────────────────────────────────────
  function paintFilesTab() {
    var host = document.getElementById('projFilesHost');
    if (!host) return;
    var files = (_detailState.photos || []).filter(function(a) { return !(a.mime_type && /^image\//.test(a.mime_type)); });
    if (!files.length) {
      host.innerHTML = '<div class="p86-proj-empty-line" style="padding:30px;text-align:center;border:1px dashed var(--border, #333);border-radius:10px;">No documents yet. Upload PDFs / Word / Excel via the Photos tab and they\'ll appear here.</div>';
      return;
    }
    files.sort(function(a, b) {
      return new Date(b.uploaded_at).getTime() - new Date(a.uploaded_at).getTime();
    });
    host.innerHTML = '<div class="p86-proj-files-list">' +
      files.map(function(f) {
        var ext = (f.filename || '').split('.').pop().slice(0, 4).toUpperCase() || 'DOC';
        return '<a class="p86-proj-file-row" href="' + escapeAttr(f.original_url) + '" download="' + escapeAttr(f.filename) + '" target="_blank" rel="noopener">' +
          '<div class="p86-proj-file-ext">' + escapeHTML(ext) + '</div>' +
          '<div class="p86-proj-file-meta">' +
            '<div class="p86-proj-file-name">' + escapeHTML(f.filename) + '</div>' +
            '<div class="p86-proj-file-sub">' + fmtFileSize(f.size_bytes) +
              (f.uploaded_by_name ? ' &middot; ' + escapeHTML(f.uploaded_by_name) : '') +
              ' &middot; ' + escapeHTML(fmtRelative(f.uploaded_at)) +
            '</div>' +
          '</div>' +
          '<span class="p86-proj-file-arrow">&#x2B07;</span>' +
        '</a>';
      }).join('') +
    '</div>';
  }

  function fmtFileSize(bytes) {
    var n = Number(bytes);
    if (!isFinite(n) || !n) return '';
    if (n < 1024) return n + ' B';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
    return (n / 1024 / 1024).toFixed(1) + ' MB';
  }

  // Render today's forecast in the detail header. Uses the cached
  // weather row from _weatherCache; fetches on demand if absent.
  function paintProjectWeather() {
    var host = document.getElementById('projDetailWeather');
    if (!host || !_detailState.project) return;
    var p = _detailState.project;
    if (!(p.address_text || '').trim()) {
      host.innerHTML = '';
      return;
    }
    var cached = _weatherCache[p.id];
    if (cached && cached.status === 'ok') {
      host.innerHTML = renderProjectWeatherHTML(cached);
      return;
    }
    host.innerHTML = '<div class="p86-proj-detail-weather-loading">Loading weather…</div>';
    if (!window.p86Api || !window.p86Api.weather || !window.p86Api.weather.projects) return;
    window.p86Api.weather.projects([p.id]).then(function(r) {
      var w = r && r.weather && r.weather[p.id];
      if (w && w.status === 'ok') {
        _weatherCache[p.id] = w;
        host.innerHTML = renderProjectWeatherHTML(w);
      } else {
        host.innerHTML = '<div class="p86-proj-detail-weather-loading">Weather unavailable.</div>';
      }
    }).catch(function() {
      host.innerHTML = '';
    });
  }

  function renderProjectWeatherHTML(w) {
    // Show today + the next two days in a compact 3-cell strip.
    var days = (w && Array.isArray(w.days)) ? w.days.filter(function(d) { return d.isDaytime; }).slice(0, 3) : [];
    if (!days.length) return '';
    var html = '<div class="p86-proj-detail-weather-grid">';
    days.forEach(function(d, i) {
      var emoji = weatherEmoji(d);
      var label = i === 0 ? 'Today' : (d.name || '');
      html += '<div class="p86-proj-detail-weather-cell" title="' + escapeAttr(d.shortForecast || '') + '">' +
        '<div class="p86-proj-detail-weather-emoji">' + emoji + '</div>' +
        '<div class="p86-proj-detail-weather-temp">' + escapeHTML(String(d.temperature || '')) + '°</div>' +
        '<div class="p86-proj-detail-weather-label">' + escapeHTML(label) + '</div>' +
      '</div>';
    });
    html += '</div>';
    return html;
  }

  // Build the <option> entries for the uploader filter dropdown.
  // Pulls distinct uploader names from the loaded photos.
  function buildUploaderOptions() {
    var byId = {};
    _detailState.photos.forEach(function(a) {
      if (a.uploaded_by != null && a.uploaded_by_name) {
        byId[a.uploaded_by] = a.uploaded_by_name;
      }
    });
    return Object.keys(byId).map(function(id) {
      return '<option value="' + escapeAttr(id) + '">' + escapeHTML(byId[id]) + '</option>';
    }).join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Date filter pill — collapses the two mm/dd/yyyy date inputs
  // behind a dropdown with preset shortcuts. Today / Last 7 / Last
  // 30 cover the common cases; "Custom" reveals the two date inputs
  // inline so power users can still set arbitrary ranges. The label
  // on the pill summarizes whatever's currently active so the user
  // sees the range without opening the menu.
  // ──────────────────────────────────────────────────────────────────
  // Returns YYYY-MM-DD in LOCAL time for a Date object — matches the
  // format <input type="date"> serializes, so the existing photo
  // filter math (which compares date prefixes) keeps working.
  function _ymdLocal(d) {
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }
  function _datePresetLabel(filter) {
    var preset = filter && filter.datePreset;
    if (preset === 'today') return 'Today';
    if (preset === 'last7') return 'Last 7 days';
    if (preset === 'last30') return 'Last 30 days';
    if (preset === 'custom' && (filter.start || filter.end)) {
      // Format both ends as M/D (year only if it differs from current).
      var fmt = function(s) {
        if (!s) return '…';
        var parts = s.split('-');
        if (parts.length !== 3) return s;
        return Number(parts[1]) + '/' + Number(parts[2]);
      };
      return fmt(filter.start) + ' – ' + fmt(filter.end);
    }
    return 'Any date';
  }
  function dateFilterPillHTML(filter) {
    filter = filter || {};
    var preset = filter.datePreset || (filter.start || filter.end ? 'custom' : 'any');
    var label = _datePresetLabel(filter);
    var showCustom = (preset === 'custom');
    function optBtn(id, text) {
      var active = (id === preset) ? ' active' : '';
      return '<button type="button" class="p86-proj-filter-date-opt' + active + '" data-date-preset="' + id + '">' + text + '</button>';
    }
    return '<div class="p86-proj-filter-date-pill" id="projFilterDate">' +
      '<button type="button" class="p86-proj-filter-date-trigger" id="projFilterDateTrigger" title="Filter by upload date">' +
        '<span class="p86-proj-filter-date-icon">&#x1F4C5;</span>' +
        '<span class="p86-proj-filter-date-label">' + escapeHTML(label) + '</span>' +
        '<span class="p86-proj-filter-date-caret">&#x25BE;</span>' +
      '</button>' +
      '<div class="p86-proj-filter-date-menu" id="projFilterDateMenu" style="display:none;">' +
        optBtn('any',    'Any date') +
        optBtn('today',  'Today') +
        optBtn('last7',  'Last 7 days') +
        optBtn('last30', 'Last 30 days') +
        optBtn('custom', 'Custom…') +
        '<div class="p86-proj-filter-date-custom"' + (showCustom ? '' : ' style="display:none;"') + '>' +
          '<input type="date" id="projFilterStart" value="' + escapeAttr(filter.start || '') + '" class="p86-proj-filter-date" title="Start date" />' +
          '<input type="date" id="projFilterEnd" value="' + escapeAttr(filter.end || '') + '" class="p86-proj-filter-date" title="End date" />' +
        '</div>' +
      '</div>' +
    '</div>';
  }
  // Sync the visible label on the pill trigger to whatever's currently
  // in the filter state. Cheaper than re-running paintHost() just to
  // update one span.
  function _refreshDateFilterLabel() {
    var labelEl = document.querySelector('#projFilterDateTrigger .p86-proj-filter-date-label');
    if (labelEl) labelEl.textContent = _datePresetLabel(_detailState.photoFilter);
  }
  // Map a preset id to an {start, end} YYYY-MM-DD pair (or nulls for
  // "any" / "custom" — custom carries over whatever the user typed).
  function _applyDatePreset(presetId) {
    var today = new Date();
    var todayStr = _ymdLocal(today);
    if (presetId === 'today') {
      return { start: todayStr, end: todayStr };
    }
    if (presetId === 'last7') {
      var s7 = new Date(today); s7.setDate(s7.getDate() - 6);
      return { start: _ymdLocal(s7), end: todayStr };
    }
    if (presetId === 'last30') {
      var s30 = new Date(today); s30.setDate(s30.getDate() - 29);
      return { start: _ymdLocal(s30), end: todayStr };
    }
    if (presetId === 'any') {
      return { start: '', end: '' };
    }
    // 'custom' — keep whatever's currently set
    return null;
  }

  // Per-photo tag chip strip — collects distinct tags across the
  // currently-filtered photo set, plus an "Untagged" pseudo-chip.
  // Click a chip to filter to that tag; click again to clear.
  function paintTagChipStrip() {
    var host = document.getElementById('projTagChipStrip');
    if (!host) return;
    var f = _detailState.photoFilter;
    var tagCounts = {};
    var untaggedCount = 0;
    _detailState.photos.forEach(function(a) {
      if (!photoMatchesNonTagFilters(a)) return;
      var ts = Array.isArray(a.tags) ? a.tags : [];
      if (!ts.length) { untaggedCount++; return; }
      ts.forEach(function(t) { tagCounts[t] = (tagCounts[t] || 0) + 1; });
    });
    var names = Object.keys(tagCounts).sort();
    if (!names.length && !untaggedCount) {
      host.innerHTML = '';
      host.style.display = 'none';
      return;
    }
    host.style.display = '';

    var html = '';
    // "Untagged" pseudo-chip on the left.
    if (untaggedCount) {
      var unActive = f.tag === '__untagged__';
      html += '<button class="p86-chip-photo-tag' + (unActive ? ' active' : '') + '" data-mk-tag="__untagged__">' +
        '&#x1F3F7; Untagged <span class="p86-chip-count">' + untaggedCount + '</span>' +
      '</button>';
    }
    names.forEach(function(t) {
      var active = f.tag === t;
      html += '<button class="p86-chip-photo-tag' + (active ? ' active' : '') + '" data-mk-tag="' + escapeAttr(t) + '" style="--h:' + hueFor(t) + ';">' +
        '#' + escapeHTML(t) + ' <span class="p86-chip-count">' + tagCounts[t] + '</span>' +
      '</button>';
    });
    host.innerHTML = html;
    host.querySelectorAll('[data-mk-tag]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tag = btn.getAttribute('data-mk-tag');
        _detailState.photoFilter.tag = (_detailState.photoFilter.tag === tag) ? '' : tag;
        paintPhotoFeed();
        paintTagChipStrip();
      });
    });
  }

  // Apply non-tag filters (date range, uploader) to a photo.
  function photoMatchesNonTagFilters(a) {
    var f = _detailState.photoFilter;
    if (f.start) {
      var s = new Date(f.start + 'T00:00:00').getTime();
      if (new Date(a.uploaded_at).getTime() < s) return false;
    }
    if (f.end) {
      var e = new Date(f.end + 'T23:59:59').getTime();
      if (new Date(a.uploaded_at).getTime() > e) return false;
    }
    if (f.uploader) {
      if (String(a.uploaded_by) !== String(f.uploader)) return false;
    }
    return true;
  }
  function photoMatchesAllFilters(a) {
    if (!photoMatchesNonTagFilters(a)) return false;
    var f = _detailState.photoFilter;
    if (f.tag === '__untagged__') {
      return !Array.isArray(a.tags) || a.tags.length === 0;
    }
    if (f.tag) {
      return Array.isArray(a.tags) && a.tags.indexOf(f.tag) !== -1;
    }
    return true;
  }

  // Per-user tile-size preference for the project photo feed. Three
  // values: 'compact' (140px floor), 'normal' (170px, default),
  // 'spacious' (220px floor). Persisted in localStorage so the choice
  // survives reloads and applies across every project the user opens.
  // CSS variants live alongside .p86-proj-feed-grid in styles.css.
  var _TILE_SIZE_KEY = 'p86-proj-tile-size';
  var _TILE_SIZES = { compact: 1, normal: 1, spacious: 1 };
  function _photoTileSize() {
    try {
      var v = localStorage.getItem(_TILE_SIZE_KEY);
      if (v && _TILE_SIZES[v]) return v;
    } catch (e) { /* localStorage blocked — fall through to default */ }
    return 'normal';
  }
  function _setPhotoTileSize(size) {
    if (!_TILE_SIZES[size]) return;
    try { localStorage.setItem(_TILE_SIZE_KEY, size); } catch (e) { /* ignore */ }
    var feed = document.getElementById('projPhotoFeed');
    if (feed) feed.setAttribute('data-tile-size', size);
    // Update the picker's active state in-place — no full paintDetail.
    var picker = document.querySelector('.p86-tile-size-picker');
    if (picker) {
      picker.querySelectorAll('.p86-tile-size-btn').forEach(function(b) {
        b.classList.toggle('active', b.getAttribute('data-tile-size') === size);
      });
    }
  }

  function paintPhotoFeed() {
    var host = document.getElementById('projPhotoFeed');
    if (!host) return;
    // Apply the saved tile-size to the feed every render — the host
    // div is recreated on each paintDetail() so the attribute would
    // otherwise reset to default after a tab switch.
    host.setAttribute('data-tile-size', _photoTileSize());
    var photos = _detailState.photos.slice();
    var pairs = _detailState.pairs.slice();

    // Apply filters BEFORE the pair exclusion so a paired-photo
    // doesn't show through when its tags don't match the filter.
    photos = photos.filter(photoMatchesAllFilters);

    var pairedIds = new Set();
    pairs.forEach(function(pair) {
      pairedIds.add(pair.before_attachment_id);
      pairedIds.add(pair.after_attachment_id);
    });
    var standalonePhotos = photos.filter(function(a) { return !pairedIds.has(a.id); });

    // Pairs: include only if BOTH underlying photos survived the
    // filter — otherwise the pair would dangle.
    var visiblePhotoIds = new Set(photos.map(function(a) { return a.id; }));
    var visiblePairs = pairs.filter(function(pp) {
      return visiblePhotoIds.has(pp.before_attachment_id) && visiblePhotoIds.has(pp.after_attachment_id);
    });

    var items = [];
    standalonePhotos.forEach(function(a) {
      items.push({ kind: 'photo', sortKey: a.uploaded_at, data: a });
    });
    visiblePairs.forEach(function(pp) {
      items.push({ kind: 'pair', sortKey: pp.created_at, data: pp });
    });
    items.sort(function(x, y) {
      return (new Date(y.sortKey).getTime() || 0) - (new Date(x.sortKey).getTime() || 0);
    });

    if (!items.length) {
      var emptyMsg = (_detailState.photoFilter.tag || _detailState.photoFilter.uploader || _detailState.photoFilter.start || _detailState.photoFilter.end)
        ? 'No photos match the current filter. Clear filters to see all photos.'
        : 'No photos yet. Drop files here or use the Upload Photos button.';
      host.innerHTML = '<div class="p86-proj-empty-line">' + escapeHTML(emptyMsg) + '</div>';
      paintBulkActionBar();
      return;
    }

    var groups = [];
    var byLabel = {};
    items.forEach(function(it) {
      var label = dateGroupLabel(it.sortKey);
      if (!byLabel[label]) {
        byLabel[label] = { label: label, key: it.sortKey, items: [] };
        groups.push(byLabel[label]);
      }
      byLabel[label].items.push(it);
    });

    host.innerHTML = '';
    groups.forEach(function(g) {
      var groupBlock = document.createElement('div');
      groupBlock.className = 'p86-proj-feed-group';

      // Date header with a "select all in group" checkbox.
      var dateHeader = document.createElement('div');
      dateHeader.className = 'p86-proj-feed-date-header';
      var photoIdsInGroup = g.items.filter(function(it) { return it.kind === 'photo'; }).map(function(it) { return it.data.id; });
      var allSelected = photoIdsInGroup.length > 0 && photoIdsInGroup.every(function(id) { return _detailState.selection.has(id); });
      dateHeader.innerHTML =
        (photoIdsInGroup.length
          ? '<label class="p86-proj-feed-date-checkbox" title="Select all in group"><input type="checkbox" ' + (allSelected ? 'checked' : '') + ' /></label>'
          : '') +
        '<span>' + escapeHTML(g.label) + '</span>';
      var groupCheckbox = dateHeader.querySelector('input');
      if (groupCheckbox) {
        groupCheckbox.addEventListener('change', function() {
          if (groupCheckbox.checked) {
            photoIdsInGroup.forEach(function(id) { _detailState.selection.add(id); });
          } else {
            photoIdsInGroup.forEach(function(id) { _detailState.selection.delete(id); });
          }
          paintPhotoFeed();
        });
      }
      groupBlock.appendChild(dateHeader);

      var grid = document.createElement('div');
      grid.className = 'p86-proj-feed-grid';
      g.items.forEach(function(it) {
        if (it.kind === 'photo') {
          grid.appendChild(buildPhotoTile(it.data));
        } else if (it.kind === 'pair' && window.p86ProjectsPairs) {
          var pairTile = window.p86ProjectsPairs.renderTile(it.data, {
            onDelete: function(pair) { deletePair(pair.id); }
          });
          grid.appendChild(pairTile);
        }
      });
      groupBlock.appendChild(grid);
      host.appendChild(groupBlock);
    });

    paintBulkActionBar();
  }

  // Returns the dimensions of the WEB variant for an attachment, given
  // its ORIGINAL dimensions (att.width / att.height). Mirrors the
  // sharp pipeline in attachment-routes.js: resize(1600, 1600, { fit:
  // 'inside', withoutEnlargement: true }) — i.e. longest edge maxes
  // at 1600, aspect ratio preserved, never upscaled. Strokes drawn in
  // the markup viewer live in THIS coord space; using the original
  // dimensions would offset/scale them incorrectly.
  function webVariantDims(origW, origH) {
    var w = Number(origW) || 0;
    var h = Number(origH) || 0;
    if (!w || !h) return null;
    var max = Math.max(w, h);
    if (max <= 1600) return { w: w, h: h };
    var s = 1600 / max;
    return { w: Math.round(w * s), h: Math.round(h * s) };
  }

  function buildPhotoTile(att) {
    var tile = document.createElement('div');
    tile.className = 'p86-proj-photo-tile';
    if (_detailState.selection.has(att.id)) tile.classList.add('selected');
    tile.setAttribute('data-attachment-id', att.id);

    var isImg = att.mime_type && /^image\//.test(att.mime_type) && att.thumb_url;
    var visual;
    if (isImg) {
      visual = '<img src="' + escapeAttr(att.thumb_url) + '" alt="" class="p86-proj-photo-tile-img" />';
    } else {
      var ext = (att.filename || '').split('.').pop().slice(0, 4).toUpperCase() || 'DOC';
      visual = '<div class="p86-proj-photo-tile-doc">' + escapeHTML(ext) + '</div>';
    }

    var uploaderInitials = att.uploaded_by_name ? initialsOf(att.uploaded_by_name) : '';
    var time = fmtTime(att.uploaded_at);
    var tagCount = Array.isArray(att.tags) ? att.tags.length : 0;
    var hasCaption = !!att.caption;
    var annotationCount = Array.isArray(att.annotations) ? att.annotations.length : 0;

    // CompanyCam-style tile: checkbox top-left, ✏️ + ⋮ top-right,
    // uploader initials bottom-left, tag/caption/annotation badges
    // bottom-right. Time + uploader name renders below the tile.
    // Annotation strokes (if any) render onto a canvas that sits over
    // the image — same shared renderer the lightbox uses, so what you
    // saw in the markup viewer is exactly what you see on the tile.
    var annoCanvasHTML = (isImg && annotationCount)
      ? '<canvas class="p86-proj-photo-tile-anno"></canvas>'
      : '';
    tile.innerHTML =
      '<div class="p86-proj-photo-tile-visual">' +
        visual +
        annoCanvasHTML +
        '<label class="p86-proj-photo-tile-checkbox" onclick="event.stopPropagation();">' +
          '<input type="checkbox"' + (_detailState.selection.has(att.id) ? ' checked' : '') + ' />' +
        '</label>' +
        '<button type="button" class="p86-proj-photo-tile-annotate" title="Annotate">&#x270E;</button>' +
        '<button type="button" class="p86-proj-photo-tile-menu" title="More">&#x22EE;</button>' +
        (uploaderInitials
          ? '<span class="p86-proj-photo-tile-uploader" title="' + escapeAttr(att.uploaded_by_name || '') + '">' + escapeHTML(uploaderInitials) + '</span>'
          : '') +
        '<div class="p86-proj-photo-tile-badges">' +
          (hasCaption ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr(att.caption) + '">&#x1F4DD;</span>' : '') +
          (annotationCount ? '<span class="p86-proj-photo-tile-badge" title="' + annotationCount + ' annotation' + (annotationCount === 1 ? '' : 's') + '">&#x1F58D;' + (annotationCount > 1 ? ' ' + annotationCount : '') + '</span>' : '') +
          (tagCount ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr((att.tags || []).join(', ')) + '">&#x1F3F7;' + (tagCount > 1 ? ' ' + tagCount : '') + '</span>' : '') +
        '</div>' +
      '</div>' +
      '<div class="p86-proj-photo-tile-footer">' +
        '<span class="p86-proj-photo-tile-time">' + escapeHTML(time) + '</span>' +
        (att.uploaded_by_name ? '<span class="p86-proj-photo-tile-uploader-name">' + escapeHTML(att.uploaded_by_name) + '</span>' : '') +
      '</div>';

    var checkbox = tile.querySelector('.p86-proj-photo-tile-checkbox input');
    if (checkbox) {
      checkbox.addEventListener('change', function() {
        if (checkbox.checked) _detailState.selection.add(att.id);
        else _detailState.selection.delete(att.id);
        tile.classList.toggle('selected', checkbox.checked);
        paintBulkActionBar();
        // Re-paint date headers' "select all" state — cheap enough.
        paintPhotoFeed();
      });
    }
    tile.querySelector('.p86-proj-photo-tile-visual').addEventListener('click', function(e) {
      if (e.target.closest('.p86-proj-photo-tile-menu')) return;
      if (e.target.closest('.p86-proj-photo-tile-annotate')) return;
      if (e.target.closest('.p86-proj-photo-tile-checkbox')) return;
      openPhotoInLightbox(att);
    });
    tile.querySelector('.p86-proj-photo-tile-menu').addEventListener('click', function(e) {
      e.stopPropagation();
      // Anchor the menu on the ⋮ button itself, not the whole tile.
      // Passing the tile made the menu drop below the entire image
      // instead of right under the button.
      openPhotoMenu(att, e.currentTarget);
    });
    var annoBtn = tile.querySelector('.p86-proj-photo-tile-annotate');
    if (annoBtn) {
      annoBtn.addEventListener('click', function(e) {
        e.stopPropagation();
        openAnnotator(att);
      });
    }

    // Paint annotation strokes onto the overlay canvas. CRITICAL:
    // strokes are drawn in the markup viewer against the WEB variant
    // (1600px max edge, see attachment-routes.js sharp pipeline) — NOT
    // the original full-resolution image. So canvas internal dims
    // need to match the web variant's dimensions; using att.width /
    // att.height (which are the ORIGINAL dims for a phone photo, e.g.
    // 4032×3024) would shrink the strokes into the top-left ~40% of
    // the canvas. CSS then scales the canvas via object-fit:cover so
    // it overlays the thumb pixel-for-pixel.
    var annoCanvas = tile.querySelector('.p86-proj-photo-tile-anno');
    if (annoCanvas && annotationCount && window.p86AnnotationRender) {
      var dims = webVariantDims(att.width, att.height);
      if (dims) {
        annoCanvas.width = dims.w;
        annoCanvas.height = dims.h;
        var ctx = annoCanvas.getContext('2d');
        try { window.p86AnnotationRender.renderAll(ctx, att.annotations); }
        catch (e) { /* defensive — bad stroke shouldn't kill the tile */ }
      }
    }

    return tile;
  }

  // Floating action bar — appears at the bottom of the detail overlay
  // when one or more photos are checked. Bulk Tag / Pair / Delete /
  // Clear.
  function paintBulkActionBar() {
    var existing = document.getElementById('projBulkBar');
    if (!_detailState.selection || !_detailState.selection.size) {
      if (existing) existing.remove();
      return;
    }
    if (!existing) {
      existing = document.createElement('div');
      existing.id = 'projBulkBar';
      existing.className = 'p86-proj-bulk-bar';
      document.body.appendChild(existing);
    }
    var n = _detailState.selection.size;
    var ids = Array.from(_detailState.selection);
    // Pair is only valid for exactly 2 image photos.
    var pairable = false;
    if (n === 2) {
      var pickedTwo = _detailState.photos.filter(function(a) { return _detailState.selection.has(a.id); });
      pairable = pickedTwo.length === 2 && pickedTwo.every(function(a) { return a.mime_type && /^image\//.test(a.mime_type); });
    }
    existing.innerHTML =
      '<span class="p86-proj-bulk-count">' + n + ' selected</span>' +
      '<button class="p86-proj-bulk-btn" data-act="tag">&#x1F3F7; Tag</button>' +
      (pairable ? '<button class="p86-proj-bulk-btn" data-act="pair">&#x1F500; Create Pair</button>' : '') +
      '<button class="p86-proj-bulk-btn danger" data-act="delete">&#x1F5D1; Delete</button>' +
      '<button class="p86-proj-bulk-btn p86-proj-bulk-clear" data-act="clear">&times;</button>';
    existing.querySelectorAll('[data-act]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var act = btn.getAttribute('data-act');
        if (act === 'clear') {
          _detailState.selection.clear();
          paintPhotoFeed();
        } else if (act === 'tag') {
          openBulkTagModal(ids);
        } else if (act === 'pair') {
          if (ids.length !== 2) return;
          // First selected = before; second = after (by selection order
          // is approximate; users can fine-tune in the picker if needed).
          var picked = _detailState.photos.filter(function(a) { return _detailState.selection.has(a.id); });
          // Sort by uploaded_at so "before" = earlier photo.
          picked.sort(function(x, y) { return new Date(x.uploaded_at).getTime() - new Date(y.uploaded_at).getTime(); });
          api().pairs.create(_detailState.project.id, {
            before_attachment_id: picked[0].id,
            after_attachment_id: picked[1].id,
            label: null
          }).then(function(r) {
            _detailState.pairs.unshift(r.pair);
            _detailState.selection.clear();
            paintPhotoFeed();
            paintActivityFeed();
          }).catch(function(e) { alert('Pair create failed: ' + (e.message || e)); });
        } else if (act === 'delete') {
          if (!window.confirm('Delete ' + n + ' photo' + (n === 1 ? '' : 's') + '? This cannot be undone.')) return;
          Promise.all(ids.map(function(id) {
            return window.p86Api.attachments.remove(id).catch(function() { return null; });
          })).then(function() {
            _detailState.photos = _detailState.photos.filter(function(a) { return !_detailState.selection.has(a.id); });
            _detailState.selection.clear();
            // Re-fetch pairs in case any of the deleted photos were paired.
            return api().pairs.list(_detailState.project.id);
          }).then(function(r) {
            _detailState.pairs = (r && r.pairs) || [];
            paintPhotoFeed();
            paintTagChipStrip();
          });
        }
      });
    });
  }

  // Bulk tag modal — pick tags to ADD or REMOVE across all selected
  // photos. Uses the existing tag editor pattern plus a small
  // "remove" pill list driven by tags currently present on any of
  // the selected photos.
  function openBulkTagModal(ids) {
    var prior = document.getElementById('projBulkTagModal');
    if (prior) prior.remove();

    var picked = _detailState.photos.filter(function(a) { return ids.indexOf(a.id) !== -1; });
    var existingTagCounts = {};
    picked.forEach(function(a) {
      (a.tags || []).forEach(function(t) { existingTagCounts[t] = (existingTagCounts[t] || 0) + 1; });
    });

    var modal = document.createElement('div');
    modal.id = 'projBulkTagModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header"><span>Tag ' + ids.length + ' photo' + (ids.length === 1 ? '' : 's') + '</span><button class="p86-modal-close" data-close>&times;</button></div>' +
        '<div class="p86-proj-create-body">' +
          '<div class="p86-field">' +
            '<span>Add tags</span>' +
            '<div id="btAddEditor" class="p86-tag-editor"></div>' +
          '</div>' +
          (Object.keys(existingTagCounts).length
            ? '<div class="p86-field">' +
                '<span>Remove tags (click to mark)</span>' +
                '<div id="btRemoveChips" class="p86-tag-editor-chips">' +
                  Object.keys(existingTagCounts).sort().map(function(t) {
                    return '<button class="p86-chip-tag" data-mk-remove="' + escapeAttr(t) + '" style="--h:' + hueFor(t) + ';">' +
                      '#' + escapeHTML(t) + ' <span class="p86-chip-count">' + existingTagCounts[t] + '/' + ids.length + '</span>' +
                    '</button>';
                  }).join('') +
                '</div>' +
              '</div>'
            : '') +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          '<button class="primary" id="btApply">Apply</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });

    var pendingAdd = [];
    mountTagEditor(modal.querySelector('#btAddEditor'), {
      getTags: function() { return pendingAdd; },
      setTags: function(next) { pendingAdd = next.slice(); }
    });

    var pendingRemove = new Set();
    modal.querySelectorAll('[data-mk-remove]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var t = btn.getAttribute('data-mk-remove');
        if (pendingRemove.has(t)) {
          pendingRemove.delete(t);
          btn.classList.remove('p86-chip-remove-active');
        } else {
          pendingRemove.add(t);
          btn.classList.add('p86-chip-remove-active');
        }
      });
    });

    modal.querySelector('#btApply').addEventListener('click', function() {
      if (!pendingAdd.length && !pendingRemove.size) {
        modal.remove();
        return;
      }
      window.p86Api.attachments.bulkTag({
        ids: ids,
        add: pendingAdd,
        remove: Array.from(pendingRemove)
      }).then(function() {
        // Apply locally for instant feedback (avoid waiting for a
        // re-fetch round-trip).
        _detailState.photos.forEach(function(a) {
          if (ids.indexOf(a.id) === -1) return;
          var s = new Set(Array.isArray(a.tags) ? a.tags : []);
          pendingAdd.forEach(function(t) { s.add(t); });
          pendingRemove.forEach(function(t) { s.delete(t); });
          a.tags = Array.from(s);
        });
        modal.remove();
        _detailState.selection.clear();
        paintPhotoFeed();
        paintTagChipStrip();
        // Activity feed will refresh on next detail open; quietly refetch in background.
        api().activity(_detailState.project.id, { limit: 50 }).then(function(r) {
          _detailState.activity = (r && r.activity) || [];
          paintActivityFeed();
        }).catch(function() {});
      }).catch(function(e) {
        alert('Bulk tag failed: ' + (e.message || e));
      });
    });
  }

  function openPhotoInLightbox(att) {
    // Use the existing global lightbox. Pass the full photo list so
    // swipe nav works. Wave A added a third arg for the side panel's
    // parent-header band — supply the project's name + address so the
    // viewer can render "Saddlebrook Resort / 5700 …" like the
    // CompanyCam screenshot the spec was modeled on.
    if (window.p86Attachments && typeof window.p86Attachments.openLightbox === 'function') {
      var idx = _detailState.photos.findIndex(function(x) { return x.id === att.id; });
      var p = _detailState.project || {};
      window.p86Attachments.openLightbox(_detailState.photos, Math.max(0, idx), {
        parentLabel: p.name || '',
        parentSubtitle: p.address_text || ''
      });
    }
  }

  function openPhotoMenu(att, anchor) {
    var prior = document.getElementById('p86-photo-menu');
    if (prior) prior.remove();
    var menu = document.createElement('div');
    menu.id = 'p86-photo-menu';
    menu.className = 'p86-proj-photo-menu';
    menu.innerHTML =
      '<button data-act="caption">Edit caption</button>' +
      '<button data-act="tags">Edit tags…</button>' +
      '<button data-act="cover">Set as cover</button>' +
      '<button data-act="pair">Pair with…</button>' +
      '<button data-act="annotate">Annotate</button>' +
      '<button data-act="delete" class="danger">Delete</button>';
    document.body.appendChild(menu);

    var rect = anchor.getBoundingClientRect();
    menu.style.top = (rect.bottom + window.scrollY) + 'px';
    menu.style.left = Math.max(8, rect.right - menu.offsetWidth + window.scrollX) + 'px';

    function close() { menu.remove(); document.removeEventListener('click', onOutside); }
    function onOutside(e) { if (!menu.contains(e.target)) close(); }
    setTimeout(function() { document.addEventListener('click', onOutside); }, 0);

    menu.querySelectorAll('button').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var act = btn.getAttribute('data-act');
        close();
        if (act === 'caption') editCaption(att);
        else if (act === 'tags') editPhotoTags(att);
        else if (act === 'cover') setCover(att);
        else if (act === 'pair') openPairPicker(att);
        else if (act === 'annotate') openAnnotator(att);
        else if (act === 'delete') deletePhoto(att);
      });
    });
  }

  // Per-photo tag editor — single-photo variant of the bulk modal.
  // Edits the att.tags array in place + persists via the attachments
  // PATCH route (which already supports the tags field).
  function editPhotoTags(att) {
    var prior = document.getElementById('projPhotoTagModal');
    if (prior) prior.remove();

    var modal = document.createElement('div');
    modal.id = 'projPhotoTagModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:460px;">' +
        '<div class="modal-header"><span>Photo tags</span><button class="p86-modal-close" data-close>&times;</button></div>' +
        '<div class="p86-proj-create-body">' +
          '<div class="p86-field">' +
            '<span>Tags on this photo</span>' +
            '<div id="ptTagsEditor" class="p86-tag-editor"></div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Done</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });

    var current = Array.isArray(att.tags) ? att.tags.slice() : [];
    mountTagEditor(modal.querySelector('#ptTagsEditor'), {
      getTags: function() { return current; },
      setTags: function(next) {
        current = next.slice();
        att.tags = current;
        // Persist on each tag change (debounced via async resolution).
        window.p86Api.attachments.update(att.id, { tags: current }).then(function() {
          paintPhotoFeed();
          paintTagChipStrip();
        }).catch(function(e) {
          alert('Tag save failed: ' + (e.message || e));
        });
      },
      // Scope autocomplete to this entity's existing tags so users see
      // the project's vocabulary instead of the org-wide firehose.
      suggestFn: function(q) {
        if (!window.p86Api || !window.p86Api.attachments || !window.p86Api.attachments.tagsSuggest) {
          return Promise.resolve({ tags: [] });
        }
        return window.p86Api.attachments.tagsSuggest({
          entity_type: 'project', entity_id: _detailState.project.id, q: q
        });
      }
    });
  }

  function editCaption(att) {
    var v = window.prompt('Caption for this photo', att.caption || '');
    if (v == null) return;
    window.p86Api.attachments.update(att.id, { caption: v }).then(function() {
      att.caption = v;
      paintPhotoFeed();
    }).catch(function(e) { alert('Save failed: ' + (e.message || e)); });
  }
  function setCover(att) {
    api().update(_detailState.project.id, { cover_attachment_id: att.id }).then(function(r) {
      _detailState.project = r && r.project || _detailState.project;
      paintDetail();
    }).catch(function(e) { alert('Set cover failed: ' + (e.message || e)); });
  }
  function deletePhoto(att) {
    if (!window.confirm('Delete this photo? This cannot be undone.')) return;
    window.p86Api.attachments.remove(att.id).then(function() {
      _detailState.photos = _detailState.photos.filter(function(x) { return x.id !== att.id; });
      paintPhotoFeed();
      // Refresh pairs in case this photo was paired.
      api().pairs.list(_detailState.project.id).then(function(r) {
        _detailState.pairs = (r && r.pairs) || [];
        paintPhotoFeed();
      }).catch(function() {});
    }).catch(function(e) { alert('Delete failed: ' + (e.message || e)); });
  }
  function openAnnotator(att) {
    if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
      alert('Annotator not loaded.');
      return;
    }
    // Coordinate the back-button stack with the markup viewer so the
    // user only goes ONE level up on save/cancel — not "back out of
    // the whole project". We push a close fn into OUR overlay stack
    // (which also pushes a history entry), and ask the markup viewer
    // to skip its own pushState. When the viewer calls onRequestClose,
    // we run closeTopOverlay() which fires history.back() → popstate
    // → pops our entry → calls the close fn → removes the viewer.
    var registered = true;
    pushOverlay(function() {
      registered = false;
      if (window.p86Markup && typeof window.p86Markup.close === 'function') {
        window.p86Markup.close();
      }
    });
    window.p86Markup.open({
      attachment: att,
      hostManagedHistory: true,
      onRequestClose: function() {
        if (registered) {
          closeTopOverlay();
        }
      },
      onDone: function(result) {
        // Phase 1.7 — annotator now PATCHes annotations onto the
        // original attachment. Refresh photos so the in-memory
        // copy + tile badge reflect the new count.
        if (result && Array.isArray(result.annotations)) {
          att.annotations = result.annotations;
          paintPhotoFeed();
        }
        refreshDetailPhotos();
      }
    });
  }

  function refreshDetailPhotos() {
    if (!_detailState.projectId) return;
    window.p86Api.attachments.list('project', _detailState.projectId).then(function(r) {
      _detailState.photos = (r && r.attachments) || [];
      paintPhotoFeed();
    }).catch(function() {});
  }

  // ──────────────────────────────────────────────────────────────────
  // Pair picker — opens a modal listing all other project photos and
  // lets the user pick the "after" photo to pair with the source.
  // ──────────────────────────────────────────────────────────────────
  function openPairPicker(beforeAtt) {
    var prior = document.getElementById('projPairPicker');
    if (prior) prior.remove();

    var candidates = _detailState.photos.filter(function(a) {
      if (a.id === beforeAtt.id) return false;
      // Only image attachments can pair.
      if (!a.mime_type || !/^image\//.test(a.mime_type)) return false;
      return true;
    });

    var modal = document.createElement('div');
    modal.id = 'projPairPicker';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:720px;">' +
        '<div class="modal-header">' +
          '<span>Pair with… &nbsp;<small style="font-weight:400;color:var(--text-dim,#888);">Pick the AFTER photo</small></span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-pair-picker-before">' +
          '<img src="' + escapeAttr(beforeAtt.thumb_url || beforeAtt.web_url || '') + '" alt="" />' +
          '<div><strong>BEFORE</strong><div style="font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(beforeAtt.filename || '') + '</div></div>' +
        '</div>' +
        '<label class="p86-field" style="margin:10px 0;">' +
          '<span>Label (optional)</span>' +
          '<input id="ppLabel" type="text" placeholder="e.g. Northwest fascia" />' +
        '</label>' +
        '<div class="p86-pair-picker-grid">' +
          (candidates.length
            ? candidates.map(function(a) {
                return '<button class="p86-pair-picker-tile" data-id="' + escapeAttr(a.id) + '">' +
                  '<img src="' + escapeAttr(a.thumb_url || '') + '" alt="" />' +
                  '<div class="p86-pair-picker-tile-meta">' +
                    fmtTime(a.uploaded_at) + ' · ' + fmtRelative(a.uploaded_at) +
                  '</div>' +
                '</button>';
              }).join('')
            : '<div class="p86-proj-empty-line" style="grid-column:1/-1;">No other photos in this project to pair with. Upload another photo first.</div>') +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
        '</div>' +
      '</div>';

    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });
    modal.querySelectorAll('.p86-pair-picker-tile').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var afterId = btn.getAttribute('data-id');
        var label = (modal.querySelector('#ppLabel').value || '').trim();
        api().pairs.create(_detailState.project.id, {
          before_attachment_id: beforeAtt.id,
          after_attachment_id: afterId,
          label: label || null
        }).then(function(r) {
          _detailState.pairs.unshift(r.pair);
          modal.remove();
          paintPhotoFeed();
          paintActivityFeed();
        }).catch(function(e) {
          alert('Pair creation failed: ' + (e.message || e));
        });
      });
    });
  }

  function deletePair(pairId) {
    api().pairs.remove(_detailState.project.id, pairId).then(function() {
      _detailState.pairs = _detailState.pairs.filter(function(pp) { return pp.id !== pairId; });
      paintPhotoFeed();
      paintActivityFeed();
    }).catch(function(e) {
      alert('Delete pair failed: ' + (e.message || e));
    });
  }

  // Lightweight uploader — just the drop zone + upload button. Photos
  // refresh after upload. The big grid render is handled by our custom
  // feed above.
  function mountUploader() {
    var host = document.getElementById('projPhotoUploadHost');
    if (!host) return;
    host.innerHTML =
      '<div class="p86-proj-upload-row">' +
        '<button class="primary" onclick="document.getElementById(\'projPhotoFileInput\').click();">&#x2795; Upload photos</button>' +
        '<input type="file" id="projPhotoFileInput" multiple accept="image/*,application/pdf" capture="environment" style="display:none;" />' +
        '<span class="p86-proj-upload-hint">or drag &amp; drop photos onto this area.</span>' +
      '</div>';
    var fileInput = host.querySelector('#projPhotoFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files.length) {
          // Walkthrough loop heuristic: if a SINGLE image file was
          // returned (the OS camera always returns exactly one) on a
          // touch-capable device, treat this as a walkthrough capture
          // so the camera re-opens after the user saves. Multi-file
          // returns or non-image files are clearly the gallery picker
          // — don't engage the loop in that case.
          var f = e.target.files[0];
          var isImage = f && f.type && /^image\//.test(f.type);
          var oneFile = e.target.files.length === 1;
          var touch = ('ontouchstart' in window) || (navigator.maxTouchPoints > 0);
          if (oneFile && isImage && touch) {
            _walkthroughKeepOpen = true;
          }
          uploadFiles(e.target.files);
        }
        fileInput.value = '';
      });
    }
    // Drag-drop on the entire fieldset.
    var fieldset = host.closest('fieldset');
    if (fieldset) {
      fieldset.addEventListener('dragover', function(e) {
        e.preventDefault();
        fieldset.classList.add('p86-proj-drop-active');
      });
      fieldset.addEventListener('dragleave', function() {
        fieldset.classList.remove('p86-proj-drop-active');
      });
      fieldset.addEventListener('drop', function(e) {
        e.preventDefault();
        fieldset.classList.remove('p86-proj-drop-active');
        if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files.length) {
          uploadFiles(e.dataTransfer.files);
        }
      });
    }
  }

  // Walkthrough upload — every file goes through a preview modal
  // (Phase 1.7) where the user can dictate a caption, confirm/edit
  // sticky tags, and annotate before saving. "Quick Save" inside any
  // preview bypasses the modal for the REST of THIS batch so heavy
  // walkthroughs don't drag.
  //
  // Walkthrough mode (PWA / mobile): once the user takes the first
  // photo with the device camera, _walkthroughKeepOpen stays true so
  // the camera re-opens after each save until they explicitly tap
  // "Done" inside the preview modal. This matches the CompanyCam
  // capture loop where you tap once and snap a dozen photos.
  function uploadFiles(files) {
    var pid = _detailState.projectId;
    if (!pid) return;
    _quickSaveThisBatch = false;
    var fileList = Array.from(files);
    var chain = Promise.resolve();
    fileList.forEach(function(f) {
      chain = chain.then(function() {
        return previewAndUpload(f, pid).catch(function(err) {
          if (err && err.message === 'cancelled') return; // user cancelled — skip
          alert('Upload failed for "' + f.name + '": ' + (err && (err.message || err)));
        });
      });
    });
    chain.then(function() {
      _quickSaveThisBatch = false;
      // Re-fetch photos + activity to surface new uploads.
      Promise.all([
        window.p86Api.attachments.list('project', pid).catch(function() { return { attachments: [] }; }),
        api().activity(pid, { limit: 50 }).catch(function() { return { activity: [] }; })
      ]).then(function(rs) {
        _detailState.photos = (rs[0] && rs[0].attachments) || [];
        _detailState.activity = (rs[1] && rs[1].activity) || [];
        paintPhotoFeed();
        paintActivityFeed();
        paintTagChipStrip();
      });
      // Walkthrough loop — after the chain finishes, if the user
      // is still in walkthrough mode (i.e. they didn't tap Done),
      // re-open the camera so they can keep snapping. setTimeout
      // gives the modal-close transition a beat before the camera
      // pops up — feels less jarring on iOS.
      if (_walkthroughKeepOpen) {
        setTimeout(function() {
          var inp = document.getElementById('projPhotoFileInput');
          if (inp) inp.click();
        }, 220);
      }
    });
  }
  // Walkthrough-mode flag — set true once the user takes their first
  // mobile camera photo (input.capture="environment"); cleared when
  // they tap Done inside the preview modal.
  var _walkthroughKeepOpen = false;

  // Per-file preview + upload. Resolves when the file lands on the
  // server (or is cancelled). Rejects only on real failure — cancel
  // resolves with rejection of new Error('cancelled') that the
  // batch-runner ignores.
  function previewAndUpload(file, projectId) {
    if (_quickSaveThisBatch) {
      return doUpload(file, projectId, {
        caption: null,
        tags: _walkthroughTags.slice(),
        annotations: []
      });
    }
    return new Promise(function(resolve, reject) {
      openUploadPreview(file, projectId, function(action, payload) {
        if (action === 'cancel') return reject(new Error('cancelled'));
        if (action === 'quick') {
          _quickSaveThisBatch = true;
          // Honor whatever the preview gave us — caption / tags /
          // annotations the user already typed should still land
          // even though they hit Quick Save instead of Save. Falls
          // back to walkthrough sticky tags when the preview
          // returned nothing (e.g. very early Quick Save click).
          var qp = payload || {};
          return doUpload(file, projectId, {
            caption: qp.caption || null,
            tags: (qp.tags && qp.tags.length) ? qp.tags : _walkthroughTags.slice(),
            annotations: qp.annotations || []
          }).then(resolve, reject);
        }
        // 'save' — payload has caption, tags, annotations
        doUpload(file, projectId, payload).then(resolve, reject);
      });
    });
  }

  // Actual upload — sends file + caption + tags + annotations in one
  // FormData POST. The server route accepts those extras and inlines
  // them on INSERT (no follow-up PATCH needed).
  function doUpload(file, projectId, payload) {
    payload = payload || {};
    var extra = {};
    if (payload.caption) extra.caption = payload.caption;
    if (payload.tags && payload.tags.length) extra.tags = JSON.stringify(payload.tags);
    if (payload.annotations && payload.annotations.length) extra.annotations = JSON.stringify(payload.annotations);
    return window.p86Api.attachments.upload('project', projectId, file, extra);
  }

  // Open the preview modal for one file. cb(action, payload) where
  // action ∈ {'save', 'quick', 'cancel'} and payload ∈ {caption, tags, annotations}.
  function openUploadPreview(file, projectId, cb) {
    var prior = document.getElementById('projUploadPreview');
    if (prior) prior.remove();

    var blobUrl = URL.createObjectURL(file);
    var isImage = file.type && /^image\//.test(file.type);

    // Per-file pending state — tags pre-seeded from sticky walkthrough
    // tags so the user doesn't retype them; annotations start empty
    // (set by the Annotate button below).
    var pendingTags = _walkthroughTags.slice();
    var pendingAnnotations = [];

    var modal = document.createElement('div');
    modal.id = 'projUploadPreview';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:580px;">' +
        '<div class="modal-header">' +
          '<span>Upload preview — ' + escapeHTML(file.name) + '</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-proj-create-body">' +
          (isImage
            ? '<img src="' + escapeAttr(blobUrl) + '" alt="" class="p86-upload-preview-img" />'
            : '<div class="p86-upload-preview-doc">' + escapeHTML((file.name.split(".").pop() || "FILE").toUpperCase()) + '</div>') +
          '<div class="p86-field">' +
            '<span>Caption</span>' +
            '<div class="p86-caption-row">' +
              '<textarea id="upPrevCaption" rows="2" placeholder="Optional. Use 🎤 to dictate."></textarea>' +
              '<button type="button" id="upPrevMic" class="p86-mic-btn" title="Dictate (voice → text)">' +
                (typeof window.p86Icon === 'function' ? window.p86Icon('composer-mic') : '&#x1F3A4;') +
              '</button>' +
            '</div>' +
          '</div>' +
          '<div class="p86-field">' +
            '<span>Tags <small style="color:var(--text-dim,#888);font-weight:400;text-transform:none;letter-spacing:0;">(sticky — applies to next photo too)</small></span>' +
            '<div id="upPrevTagsEditor" class="p86-tag-editor"></div>' +
          '</div>' +
          '<div class="p86-field">' +
            '<button type="button" class="ee-btn secondary" id="upPrevAnnotate">&#x270E; Annotate before saving</button>' +
            '<span id="upPrevAnnoCount" style="font-size:11px;color:var(--text-dim,#888);margin-left:8px;"></span>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          // "Done" appears only in walkthrough mode — saves the
          // current photo AND exits the capture loop so the camera
          // doesn't pop back up after this save.
          '<button class="ee-btn secondary" id="upPrevDone" style="display:none;" title="Save this photo and stop the walkthrough capture loop">&#x2714;&#xFE0F; Done</button>' +
          '<button class="ee-btn secondary" id="upPrevQuick" title="Skip preview for the rest of this batch">&#x26A1; Quick Save</button>' +
          '<button class="primary" id="upPrevSave">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    var stopVoice = wireVoiceInput(modal.querySelector('#upPrevCaption'), modal.querySelector('#upPrevMic'));

    mountTagEditor(modal.querySelector('#upPrevTagsEditor'), {
      getTags: function() { return pendingTags; },
      setTags: function(next) { pendingTags = next.slice(); },
      suggestFn: function(q) {
        // Prefer the org-level catalog for autocomplete; fallback to
        // attachment-scoped suggestions for cross-project consistency.
        if (window.p86Api && window.p86Api.orgTags && window.p86Api.orgTags.suggest) {
          return window.p86Api.orgTags.suggest(q);
        }
        return Promise.resolve({ tags: [] });
      }
    });

    function close(action, payload) {
      try { stopVoice(); } catch (e) {}
      try { URL.revokeObjectURL(blobUrl); } catch (e) {}
      modal.remove();
      cb(action, payload);
    }

    modal.addEventListener('click', function(e) { if (e.target === modal) close('cancel'); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { close('cancel'); });
    });

    modal.querySelector('#upPrevAnnotate').addEventListener('click', function() {
      // Open the markup viewer with the blob URL as the image source.
      // No attachment id yet — the viewer's PATCH path handles that
      // gracefully and hands the strokes back via onDone().
      if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
        alert('Annotator not loaded.');
        return;
      }
      window.p86Markup.open({
        attachment: {
          id: null,
          original_url: blobUrl,
          web_url: blobUrl,
          filename: file.name,
          entity_type: 'project',
          entity_id: projectId,
          annotations: pendingAnnotations
        },
        saveTarget: { entityType: 'project', entityId: projectId },
        onDone: function(result) {
          if (result && Array.isArray(result.annotations)) {
            pendingAnnotations = result.annotations;
            var countEl = modal.querySelector('#upPrevAnnoCount');
            if (countEl) {
              countEl.textContent = pendingAnnotations.length
                ? pendingAnnotations.length + ' annotation' + (pendingAnnotations.length === 1 ? '' : 's') + ' ready'
                : '';
            }
          }
        }
      });
    });

    modal.querySelector('#upPrevSave').addEventListener('click', function() {
      var caption = (modal.querySelector('#upPrevCaption').value || '').trim();
      // Sticky-tag update: remember whatever's in the editor as the
      // new default for subsequent photos in this session.
      _walkthroughTags = pendingTags.slice();
      paintWalkthroughTagStrip();
      close('save', {
        caption: caption || null,
        tags: pendingTags.slice(),
        annotations: pendingAnnotations.slice()
      });
    });

    // Done button — visible only when walkthrough capture is active.
    // Saves THIS photo AND clears the keep-camera-open flag so the
    // chain doesn't re-trigger the file input after this save.
    var doneBtn = modal.querySelector('#upPrevDone');
    if (doneBtn) {
      if (_walkthroughKeepOpen) doneBtn.style.display = '';
      doneBtn.addEventListener('click', function() {
        var caption = (modal.querySelector('#upPrevCaption').value || '').trim();
        _walkthroughTags = pendingTags.slice();
        paintWalkthroughTagStrip();
        _walkthroughKeepOpen = false;
        close('save', {
          caption: caption || null,
          tags: pendingTags.slice(),
          annotations: pendingAnnotations.slice()
        });
      });
    }

    modal.querySelector('#upPrevQuick').addEventListener('click', function() {
      // Don't update _walkthroughTags here — quick save uses whatever's
      // already sticky from prior previews. If the user wanted these
      // tags to stick they'd use Save.
      // But DO forward the tags / caption / annotations the user
      // already typed in this preview — previewAndUpload picks them
      // up so a typed-tag-then-Quick-Save doesn't silently lose
      // the just-entered values. (The earlier "no payload" path
      // dropped them entirely.)
      var caption = (modal.querySelector('#upPrevCaption').value || '').trim();
      close('quick', {
        caption: caption || null,
        tags: pendingTags.slice(),
        annotations: pendingAnnotations.slice()
      });
    });
  }

  // Re-paint the sticky-tag strip above the upload area whenever
  // _walkthroughTags changes. Lives in the upload row so it's
  // discoverable next to the Upload Photos button.
  function paintWalkthroughTagStrip() {
    var host = document.getElementById('projWalkthroughTagStrip');
    if (!host) return;
    if (!_walkthroughTags.length) {
      host.innerHTML = '';
      host.style.display = 'none';
      return;
    }
    host.style.display = '';
    host.innerHTML =
      '<span class="p86-walkthrough-label">Sticky tags:</span>' +
      _walkthroughTags.map(function(t) {
        return '<button class="p86-chip-tag" data-mk-remove-walkthrough="' + escapeAttr(t) + '" style="--h:' + hueFor(t) + ';" title="Click to remove">' +
          '#' + escapeHTML(t) + ' &times;' +
        '</button>';
      }).join('') +
      '<button class="p86-chip" id="projWalkthroughClear" title="Clear all sticky tags">Clear</button>';
    host.querySelectorAll('[data-mk-remove-walkthrough]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var tag = btn.getAttribute('data-mk-remove-walkthrough');
        _walkthroughTags = _walkthroughTags.filter(function(t) { return t !== tag; });
        paintWalkthroughTagStrip();
      });
    });
    var clearBtn = host.querySelector('#projWalkthroughClear');
    if (clearBtn) clearBtn.addEventListener('click', function() {
      _walkthroughTags = [];
      paintWalkthroughTagStrip();
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Activity feed
  // ──────────────────────────────────────────────────────────────────
  function activityRow(a) {
    var icon = '&#x2728;'; // sparkles default
    var verb = a.kind;
    var detail = '';
    var d = a.detail || {};
    if (a.kind === 'created')           { icon = '&#x1F195;'; verb = 'created the project'; }
    else if (a.kind === 'photo_added')  { icon = '&#x1F4F7;'; verb = 'added a photo'; detail = d.filename || ''; }
    else if (a.kind === 'photo_removed'){ icon = '&#x1F5D1;'; verb = 'removed a photo'; detail = d.filename || ''; }
    else if (a.kind === 'caption_edited'){ icon = '&#x270F;'; verb = 'edited a caption'; detail = d.filename || ''; }
    else if (a.kind === 'tags_changed') {
      icon = '&#x1F3F7;';
      var parts = [];
      if (d.added && d.added.length) parts.push('added ' + d.added.map(function(t) { return '#' + t; }).join(', '));
      if (d.removed && d.removed.length) parts.push('removed ' + d.removed.map(function(t) { return '#' + t; }).join(', '));
      verb = parts.join(' / ') || 'updated tags';
    }
    else if (a.kind === 'cover_set')     { icon = '&#x1F3DE;'; verb = 'set a new cover photo'; }
    else if (a.kind === 'link_changed')  { icon = '&#x1F517;'; verb = 'changed project links'; }
    else if (a.kind === 'status_changed'){ icon = (d.after === 'archived' ? '&#x1F5C4;' : '&#x21BA;'); verb = (d.after === 'archived' ? 'archived' : 'unarchived') + ' the project'; }
    else if (a.kind === 'renamed')       { icon = '&#x270F;'; verb = 'renamed the project'; }
    else if (a.kind === 'description_edited'){ icon = '&#x270F;'; verb = 'edited the description'; }
    else if (a.kind === 'address_edited'){ icon = '&#x1F4CD;'; verb = 'edited the address'; }
    else if (a.kind === 'pair_created')  { icon = '&#x1F500;'; verb = 'created a before/after pair'; detail = d.label || ''; }
    else if (a.kind === 'pair_deleted')  { icon = '&#x1F5D1;'; verb = 'deleted a before/after pair'; }

    return '<div class="p86-proj-activity-row">' +
      '<span class="p86-proj-activity-icon">' + icon + '</span>' +
      '<span class="p86-proj-activity-actor">' + escapeHTML(a.actor_name || 'Someone') + '</span>' +
      '<span class="p86-proj-activity-verb">' + verb + '</span>' +
      (detail ? '<span class="p86-proj-activity-detail">' + escapeHTML(detail) + '</span>' : '') +
      '<span class="p86-proj-activity-time">' + escapeHTML(fmtRelative(a.created_at)) + '</span>' +
    '</div>';
  }

  function paintActivityFeed() {
    var host = document.getElementById('projActivityHost');
    if (!host) return;
    if (!_detailState.activity.length) {
      host.innerHTML = '<div class="p86-proj-empty-line">No activity yet.</div>';
      return;
    }
    host.innerHTML = _detailState.activity.map(activityRow).join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Field blur-save (name / address / description)
  // ──────────────────────────────────────────────────────────────────
  function _fieldBlur(field, value) {
    var p = _detailState.project;
    if (!p || !api()) return;
    var prior = p[field];
    var clean = (value == null) ? '' : String(value);
    if (String(prior == null ? '' : prior) === clean) return;
    p[field] = clean;
    var patch = {};
    patch[field] = clean;
    api().update(p.id, patch).catch(function(e) {
      p[field] = prior;
      // Roll back any side effects we did optimistically below.
      if (field === 'address_text') refreshInlineMap();
      syncListProjectFromDetail();
      alert('Save failed for ' + field + ': ' + (e.message || e));
    });
    // Side effect: the inline Google Maps iframe was rendered once at
    // paintDetail time with the address that was there then. If the
    // user edits the address, the input updates but the iframe stays
    // stuck on the old map — making it look like the project has the
    // wrong address. Swap the src so the pin tracks the typed value.
    if (field === 'address_text') refreshInlineMap();
    // Push the change into the list cache + re-paint the list/map
    // view behind the overlay. The user sees fresh data the moment
    // they close the detail — no need to wait for a server roundtrip
    // race.
    syncListProjectFromDetail();
  }

  // Mirror the current _detailState.project values onto the row in
  // _listState.projects so the list/map view doesn't go stale while
  // the detail is open. Re-paints the list (still rendered behind
  // the overlay) so on close the user sees fresh data without a
  // fetchAll() roundtrip.
  function syncListProjectFromDetail() {
    var p = _detailState.project;
    if (!p || !_listState.host) return;
    var idx = _listState.projects.findIndex(function(x) { return String(x.id) === String(p.id); });
    if (idx === -1) return;
    var prior = _listState.projects[idx];
    // Merge — keep computed fields (cover_thumb_url, photo_count,
    // lead_title, etc.) from the list row, override with anything
    // that's been edited in the detail.
    _listState.projects[idx] = Object.assign({}, prior, p);
    try { paintList(); } catch (e) { /* defensive */ }
  }

  function refreshInlineMap() {
    var p = _detailState.project;
    if (!p) return;
    var frame = document.querySelector('.p86-proj-detail-map-frame');
    var emptyEl = document.querySelector('.p86-proj-detail-map-empty');
    var addr = (p.address_text || '').trim();
    if (!frame && !emptyEl) return;
    if (addr) {
      if (frame) {
        frame.src = 'https://www.google.com/maps?q=' + encodeURIComponent(addr) + '&output=embed&z=16';
      } else if (emptyEl) {
        // Empty stub was rendered — swap it for a live iframe.
        var iframe = document.createElement('iframe');
        iframe.className = 'p86-proj-detail-map-frame';
        iframe.loading = 'lazy';
        iframe.setAttribute('referrerpolicy', 'no-referrer-when-downgrade');
        iframe.src = 'https://www.google.com/maps?q=' + encodeURIComponent(addr) + '&output=embed&z=16';
        emptyEl.parentNode.replaceChild(iframe, emptyEl);
      }
    } else if (frame) {
      // Address was cleared — swap iframe back to the "add an address" stub.
      var stub = document.createElement('div');
      stub.className = 'p86-proj-detail-map-empty';
      stub.textContent = 'Add an address to drop a pin here.';
      frame.parentNode.replaceChild(stub, frame);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Link / archive / unarchive
  // ──────────────────────────────────────────────────────────────────
  function editLinks() {
    var p = _detailState.project;
    if (!p || !api()) return;
    var prior = document.getElementById('projLinksModal');
    if (prior) prior.remove();

    // Same chip-and-picker UI as the New Project modal. Stage the
    // current linkage in pendingLink; let the user remove / replace
    // via the unified entity picker.
    var pendingLink = {
      lead_id: p.lead_id || null,
      job_id: p.job_id || null,
      client_id: p.client_id || null
    };
    // Track the most-recently-changed linkage so the inherit step
    // pulls name + address from the entity the user actually just
    // picked (job-priority is still applied as a fallback below).
    var lastChanged = null;

    // Warm caches so the picker has fresh data.
    ensureEntityCaches();

    var modal = document.createElement('div');
    modal.id = 'projLinksModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header">' +
          '<span>Edit project links</span>' +
          '<button class="p86-modal-close" data-close>&times;</button>' +
        '</div>' +
        '<div class="p86-proj-create-body">' +
          '<div class="p86-field">' +
            '<span>Linked to</span>' +
            '<div id="elLinkChips" class="p86-proj-link-chips"></div>' +
            '<button type="button" id="elLinkBtn" class="ee-btn secondary p86-proj-link-btn">&#x1F517; Link to lead, job, or client…</button>' +
          '</div>' +
          '<label class="p86-field" style="flex-direction:row;align-items:center;gap:8px;margin-top:6px;">' +
            '<input type="checkbox" id="plInherit" checked style="margin:0;" />' +
            '<span style="text-transform:none;letter-spacing:0;font-weight:500;font-size:12px;color:var(--text,#fff);">Use linked entity\'s title and address (overwrites current values)</span>' +
          '</label>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          '<button class="primary" id="plSave">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });

    function paintLinkChips() {
      var host = modal.querySelector('#elLinkChips');
      if (!host) return;
      var chips = [];
      if (pendingLink.lead_id) {
        var l = ((window.appData && window.appData.leads) || []).find(function(x) { return String(x.id) === String(pendingLink.lead_id); });
        chips.push({ k: 'Lead', label: (l && l.title) || pendingLink.lead_id, kind: 'lead' });
      }
      if (pendingLink.job_id) {
        var j = ((window.appData && window.appData.jobs) || []).find(function(x) { return String(x.id) === String(pendingLink.job_id); });
        chips.push({ k: 'Job', label: (j && (j.title || j.name)) || pendingLink.job_id, kind: 'job' });
      }
      if (pendingLink.client_id) {
        var c = ((window.appData && window.appData.clients) || []).find(function(x) { return String(x.id) === String(pendingLink.client_id); });
        chips.push({ k: 'Client', label: (c && c.name) || pendingLink.client_id, kind: 'client' });
      }
      if (!chips.length) {
        host.innerHTML = '<div class="p86-proj-empty-line">Not linked yet.</div>';
        return;
      }
      host.innerHTML = chips.map(function(ch) {
        return '<span class="p86-proj-link-chip" data-unlink="' + ch.kind + '">' +
          '<strong>' + escapeHTML(ch.k) + ':</strong> ' + escapeHTML(ch.label) +
          ' <button type="button" title="Unlink" data-unlink="' + ch.kind + '">&times;</button>' +
        '</span>';
      }).join('');
      host.querySelectorAll('[data-unlink]').forEach(function(el) {
        if (el.tagName !== 'BUTTON') return;
        el.addEventListener('click', function() {
          var kind = el.getAttribute('data-unlink');
          if (kind === 'lead')   pendingLink.lead_id = null;
          if (kind === 'job')    pendingLink.job_id = null;
          if (kind === 'client') pendingLink.client_id = null;
          paintLinkChips();
        });
      });
    }

    modal.querySelector('#elLinkBtn').addEventListener('click', function() {
      openLinkPicker(function(picked) {
        if (!picked) return;
        if (picked.kind === 'lead')   { pendingLink.lead_id = picked.id;   lastChanged = 'lead'; }
        if (picked.kind === 'job')    { pendingLink.job_id = picked.id;    lastChanged = 'job'; }
        if (picked.kind === 'client') { pendingLink.client_id = picked.id; lastChanged = 'client'; }
        if (picked.kind === 'lead' && picked.client_id) {
          pendingLink.client_id = picked.client_id;
        }
        paintLinkChips();
      });
    });

    paintLinkChips();

    modal.querySelector('#plSave').addEventListener('click', function() {
      var doInherit = modal.querySelector('#plInherit').checked;
      var saveBtn = modal.querySelector('#plSave');
      saveBtn.disabled = true;
      var origLabel = saveBtn.textContent;
      saveBtn.textContent = doInherit ? 'Loading latest…' : 'Saving…';

      // Always re-fetch the entity caches before reading for
      // inheritance so we don't write a stale address to the project.
      var ensure = doInherit ? ensureEntityCaches() : Promise.resolve();

      ensure.then(function() {
        var patch = {
          lead_id: pendingLink.lead_id || null,
          job_id: pendingLink.job_id || null,
          client_id: pendingLink.client_id || null
        };

        if (doInherit) {
          // Priority: whatever the user JUST picked > job > lead > client.
          var src = null;
          var order = lastChanged
            ? [lastChanged].concat(['job', 'lead', 'client'].filter(function(k) { return k !== lastChanged; }))
            : ['job', 'lead', 'client'];
          for (var i = 0; i < order.length && !src; i++) {
            var k = order[i];
            var id = pendingLink[k + '_id'];
            if (id) src = inheritFromEntity(k, id);
          }
          if (src) {
            if (src.name)    patch.name = src.name;
            if (src.address) patch.address_text = src.address;
          }
        }

        saveBtn.textContent = 'Saving…';
        return api().update(p.id, patch);
      }).then(function(r) {
        _detailState.project = r && r.project;
        modal.remove();
        paintDetail();
        syncListProjectFromDetail();
        refreshLinkedPanels();
      }).catch(function(e) {
        saveBtn.disabled = false;
        saveBtn.textContent = origLabel;
        alert('Save failed: ' + (e.message || e));
      });
    });
  }

  function archive() {
    var p = _detailState.project;
    if (!p || !api()) return;
    if (!window.confirm('Archive this project? Its photos stay attached; archived projects hide from the default list.')) return;
    api().update(p.id, { status: 'archived' }).then(closeDetail).catch(function(e) {
      alert('Archive failed: ' + (e.message || e));
    });
  }
  function unarchive() {
    var p = _detailState.project;
    if (!p || !api()) return;
    api().update(p.id, { status: 'active' }).then(function(r) {
      _detailState.project = r && r.project;
      paintDetail();
      syncListProjectFromDetail();
    }).catch(function(e) { alert('Unarchive failed: ' + (e.message || e)); });
  }

  // ──────────────────────────────────────────────────────────────────
  // Linked-Projects panel (embedded in lead / job / client editors)
  // ──────────────────────────────────────────────────────────────────
  function renderLinkedProjectsPanel(host, ctx) {
    if (!host || !ctx || !ctx.kind || !ctx.id) return;
    _linkedPanels = _linkedPanels.filter(function(p) { return p.host !== host; });
    _linkedPanels.push({ host: host, ctx: ctx });

    host.innerHTML = '<div class="p86-proj-empty-line">Loading projects…</div>';
    if (!api()) {
      host.innerHTML = '<div class="p86-proj-empty-line">Projects API not loaded.</div>';
      return;
    }
    var opts = { status: 'active' };
    if (ctx.kind === 'lead')   opts.lead_id = ctx.id;
    if (ctx.kind === 'job')    opts.job_id = ctx.id;
    if (ctx.kind === 'client') opts.client_id = ctx.id;

    api().list(opts).then(function(r) {
      var rows = (r && r.projects) || [];
      var newBtn = '<button class="ee-btn secondary p86-proj-linked-newbtn" onclick="window.p86Projects.createForEntity(\'' + escapeAttr(ctx.kind) + '\', \'' + escapeAttr(ctx.id) + '\')">&#x2795; New Project</button>';
      if (!rows.length) {
        host.innerHTML =
          '<div class="p86-proj-empty-line">No projects linked yet.</div>' +
          newBtn;
        return;
      }
      host.innerHTML = rows.map(function(p) {
        var coverUrl = p.cover_thumb_url || '';
        var thumb = coverUrl
          ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-proj-linked-thumb" />'
          : '<div class="p86-proj-linked-thumb p86-proj-linked-thumb-empty">&#x1F4F8;</div>';
        return '<div class="p86-proj-linked-row" onclick="window.openProject(\'' + escapeAttr(p.id) + '\')">' +
          thumb +
          '<div class="p86-proj-linked-row-body">' +
            '<div class="p86-proj-linked-name">' + escapeHTML(p.name) + '</div>' +
            '<div class="p86-proj-linked-meta">' + Number(p.photo_count || 0) + ' photo' + (p.photo_count === 1 ? '' : 's') +
              (Number(p.pair_count || 0) ? ' · ' + Number(p.pair_count) + ' pair' + (p.pair_count === 1 ? '' : 's') : '') +
              ' · ' + escapeHTML(fmtRelative(p.updated_at)) +
            '</div>' +
          '</div>' +
        '</div>';
      }).join('') + newBtn;
    }).catch(function(e) {
      host.innerHTML = '<div style="font-size:12px;color:#f87171;padding:6px 0;">Failed to load: ' + escapeHTML(e.message || e) + '</div>';
    });
  }
  window.renderLinkedProjectsPanel = renderLinkedProjectsPanel;

  function refreshLinkedPanels() {
    _linkedPanels.forEach(function(panel) {
      try { renderLinkedProjectsPanel(panel.host, panel.ctx); } catch (e) {}
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Public surface
  // ──────────────────────────────────────────────────────────────────
  window.p86Projects = {
    setFilter: setFilter,
    setView: setView,
    openCreate: openCreate,
    // Exposed for cross-module reuse — the new attachments.js photo
    // viewer side panel uses this to render the tag chip editor with
    // the same org-tag autocomplete + chip styling as the per-photo
    // tag modal.
    mountTagEditor: mountTagEditor,
    createPrompt: createPrompt,     // legacy alias
    createForEntity: createForEntity,
    archive: archive,
    unarchive: unarchive,
    editLinks: editLinks,
    switchTab: switchTab,
    createReport: createReport,
    openCreateReport: openCreateReport,
    openReport: openReport,
    deleteReport: deleteReport,
    _fieldBlur: _fieldBlur,
    // Shared back-button stack — other modules (markup-viewer, etc.)
    // hook into this so a single popstate consumes a single entry.
    pushOverlay: pushOverlay,
    closeTopOverlay: closeTopOverlay
  };
})();
