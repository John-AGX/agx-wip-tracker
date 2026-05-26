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

  // Web Speech API helper — wires a mic button to a textarea so the
  // user can dictate captions. Lifted from ai-panel.js's setupVoiceInput
  // and trimmed for the upload-preview use case (no send-on-submit
  // coupling needed). Silently no-ops on browsers without
  // SpeechRecognition (Firefox without flags).
  //
  // Returns a teardown function so the caller can stop dictation
  // when the modal closes.
  function wireVoiceInput(textareaEl, micBtnEl) {
    if (!textareaEl || !micBtnEl) return function() {};
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) {
      micBtnEl.style.display = 'none';
      return function() {};
    }
    var recognition = null;
    var listening = false;
    var silenceTimer = null;
    var lastResultTs = 0;
    var SILENCE_TIMEOUT_MS = 5000; // 5s for walkthrough narration

    function setListening(v) {
      listening = v;
      micBtnEl.style.background = v ? 'rgba(248,113,113,0.18)' : 'transparent';
      micBtnEl.style.color = v ? '#f87171' : 'var(--text-dim, #888)';
      micBtnEl.title = v ? 'Stop dictation' : 'Dictate (voice → text)';
    }

    function stop() {
      if (silenceTimer) { clearInterval(silenceTimer); silenceTimer = null; }
      if (recognition) {
        try { recognition.stop(); } catch (e) {}
        recognition = null;
      }
      setListening(false);
    }

    function start() {
      try {
        recognition = new SR();
        recognition.continuous = true;
        recognition.interimResults = true;
        recognition.lang = navigator.language || 'en-US';
        var baseValue = '';
        recognition.onstart = function() {
          baseValue = textareaEl.value || '';
          if (baseValue && !/\s$/.test(baseValue)) baseValue += ' ';
          setListening(true);
          lastResultTs = Date.now();
          if (silenceTimer) clearInterval(silenceTimer);
          silenceTimer = setInterval(function() {
            if (!listening) return;
            if (Date.now() - lastResultTs > SILENCE_TIMEOUT_MS) stop();
          }, 500);
        };
        recognition.onresult = function(e) {
          lastResultTs = Date.now();
          var allFinal = '', allInterim = '';
          for (var i = 0; i < e.results.length; i++) {
            var t = e.results[i][0].transcript;
            if (e.results[i].isFinal) allFinal += t;
            else allInterim += t;
          }
          textareaEl.value = baseValue + allFinal + allInterim;
        };
        recognition.onerror = function(ev) {
          stop();
          if (ev && ev.error === 'not-allowed') {
            alert('Microphone access denied. Allow it in your browser settings to dictate.');
          }
        };
        recognition.onend = function() { stop(); };
        recognition.start();
      } catch (e) {
        alert('Could not start dictation: ' + (e.message || e));
        stop();
      }
    }

    micBtnEl.onclick = function(e) {
      e.preventDefault();
      if (listening) stop();
      else start();
    };

    return stop;
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
                      return !(Number.isFinite(Number(p.geocode_lat)) && Number.isFinite(Number(p.geocode_lng)));
                    });
                    if (!unmapped.length) return '';
                    return '<div class="p86-projects-unmapped"><strong>Unmapped (' + unmapped.length + ')</strong> · ' +
                      unmapped.map(function(p) {
                        return '<a href="#" onclick="window.openProject(\'' + escapeAttr(p.id) + '\'); return false;">' + escapeHTML(p.name) + '</a>';
                      }).join(' · ') +
                    '</div>';
                  })()
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
    _listState.view = view === 'map' ? 'map' : 'grid';
    try { sessionStorage.setItem('p86-projects-view', _listState.view); } catch (e) {}
    paintList();
  }
  // (setTagFilter removed — project-level tag filter is gone.)

  // ──────────────────────────────────────────────────────────────────
  // Create-Project modal — replaces window.prompt
  // ──────────────────────────────────────────────────────────────────
  function openCreate(prefill) {
    prefill = prefill || {};
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
        if (p && p.id) openProject(p.id);
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
        '</div>';
      })() +

      // Tab content host — only one of photos/reports/files renders
      // at a time. We always inject all three blocks and toggle CSS
      // visibility via the active state so switching tabs doesn't
      // re-fetch attachments.
      '<div id="projTabContent">' +

      // ===== PHOTOS TAB =====
      '<div id="projTabPhotos" class="p86-proj-tab-pane"' + ((_detailState.activeTab || 'photos') === 'photos' ? '' : ' style="display:none;"') + '>' +

      // Filter toolbar — date range + uploader + view + upload
      '<div class="p86-proj-filter-toolbar">' +
        '<div class="p86-proj-filter-group">' +
          '<input type="date" id="projFilterStart" value="' + escapeAttr(_detailState.photoFilter.start || '') + '" class="p86-proj-filter-date" title="Start date" />' +
          '<input type="date" id="projFilterEnd" value="' + escapeAttr(_detailState.photoFilter.end || '') + '" class="p86-proj-filter-date" title="End date" />' +
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
    if (startEl) startEl.addEventListener('change', function() { _detailState.photoFilter.start = startEl.value; paintPhotoFeed(); paintTagChipStrip(); });
    if (endEl) endEl.addEventListener('change', function() { _detailState.photoFilter.end = endEl.value; paintPhotoFeed(); paintTagChipStrip(); });
    if (uploaderEl) uploaderEl.addEventListener('change', function() { _detailState.photoFilter.uploader = uploaderEl.value; paintPhotoFeed(); paintTagChipStrip(); });

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

    // Wire upload input.
    var fileInput = host.querySelector('#projPhotoFileInput');
    if (fileInput) {
      fileInput.addEventListener('change', function(e) {
        if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
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
    if (!['photos', 'reports', 'files'].includes(name)) return;
    _detailState.activeTab = name;
    // Toggle pane visibility without a full re-render.
    var panes = { photos: 'projTabPhotos', reports: 'projTabReports', files: 'projTabFiles' };
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
      var tpl = (window.p86ReportTemplates && window.p86ReportTemplates.get)
        ? window.p86ReportTemplates.get(templateId)
        : { label: 'Untitled', seed_sections: [], cover_defaults: function() { return {}; } };
      var me = currentUser();
      var seeds = (tpl.seed_sections || []).map(function(s, i) {
        return {
          id: 'sec_' + Date.now() + '_' + i,
          label: s.label || 'Section',
          layout: s.layout || 'photo-grid',
          photo_ids: [],
          captions: {},
          text_body: '',
          attachment_ids: []
        };
      });
      var cover = Object.assign({ enabled: false }, tpl.cover_defaults(p, me) || {});
      var body = {
        title: tpl.label + ' — ' + (p.name || 'Project'),
        template_type: templateId,
        sections: seeds,
        cover_page: cover
      };
      window.p86Api.reports.create('project', p.id, body).then(function(r) {
        var newR = r && r.report;
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
        openReportEditor(newR.id);
      }).catch(function(e) {
        alert('Create failed: ' + (e.message || e));
      });
    });
  }

  // Template picker modal — grid of 8 tiles (icon + label + blurb).
  // Click a tile to commit the choice; the modal closes and the
  // create flow continues. Cancel = no-op.
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
      }, report.cover_page || {})
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
        cover_page: state.cover
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

      host.innerHTML =
        '<div class="p86-report-topbar">' +
          '<input id="rptTitle" class="p86-report-title-input" value="' + escapeAttr(state.report.title || '') + '" placeholder="Report title" />' +
          '<div class="p86-report-topbar-actions">' +
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
          state.sections.map(sectionHTML).join('') +
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
        // Layout switcher — confirm before clearing if the section
        // has content the new layout can't represent (e.g. switching
        // a photo-grid with 5 photos to text-block).
        var layoutSel = sectionEl.querySelector('.p86-report-section-layout');
        if (layoutSel) layoutSel.addEventListener('change', function(e) {
          var prevLayout = state.sections[sIdx].layout || 'photo-grid';
          var nextLayout = e.target.value;
          if (prevLayout === nextLayout) return;
          // Detect "would lose content" cases. Switching INTO text-block
          // or attachment-list from a photo layout loses photos; vice
          // versa loses the text body. Bail with a confirm.
          var hasPhotos = (state.sections[sIdx].photo_ids || []).length > 0;
          var hasText = !!(state.sections[sIdx].text_body || '').trim();
          var hasAttachments = (state.sections[sIdx].attachment_ids || []).length > 0;
          var losingContent =
            (prevLayout !== 'text-block' && prevLayout !== 'attachment-list' && (nextLayout === 'text-block' || nextLayout === 'attachment-list') && hasPhotos) ||
            (prevLayout === 'text-block' && nextLayout !== 'text-block' && hasText) ||
            (prevLayout === 'attachment-list' && nextLayout !== 'attachment-list' && hasAttachments);
          if (losingContent && !window.confirm('Switching layouts will clear the current ' + (prevLayout === 'text-block' ? 'text' : (prevLayout === 'attachment-list' ? 'file list' : 'photos')) + ' in this section. Continue?')) {
            // Revert the dropdown.
            e.target.value = prevLayout;
            return;
          }
          state.sections[sIdx].layout = nextLayout;
          // before-after caps to 2 photos.
          if (nextLayout === 'before-after' && (state.sections[sIdx].photo_ids || []).length > 2) {
            state.sections[sIdx].photo_ids = state.sections[sIdx].photo_ids.slice(0, 2);
          }
          paint();
          debouncedSave();
        });
        var addBtn = sectionEl.querySelector('.p86-report-section-add');
        if (addBtn) addBtn.addEventListener('click', function() {
          var layout = state.sections[sIdx].layout || 'photo-grid';
          if (layout === 'attachment-list') openAttachmentPicker(sIdx);
          else openPhotoPicker(sIdx);
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

    function seedSections(labels) {
      labels.forEach(function(label) {
        state.sections.push({
          id: 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          label: label,
          layout: 'photo-grid',
          photo_ids: [],
          captions: {},
          text_body: '',
          attachment_ids: []
        });
      });
      paint();
    }

    function addCustomSection() {
      var label = window.prompt('Section name:', '');
      if (!label) return;
      seedSections([label]);
    }

    // Wave B3 — section schema now carries a `layout` field. Five
    // options: photo-grid (default — what we always rendered),
    // single-photo (one large photo per row, full width),
    // before-after (two photos side-by-side), text-block (narrative
    // only, no photos), attachment-list (download rows for PDFs).
    // sectionHTML dispatches on layout; each layout has its own
    // body renderer. The shared header carries a dropdown so the
    // user can switch any section after creation.
    var LAYOUT_OPTIONS = [
      { id: 'photo-grid',      label: 'Photo grid' },
      { id: 'single-photo',    label: 'One photo per row' },
      { id: 'before-after',    label: 'Before / After' },
      { id: 'text-block',      label: 'Text only' },
      { id: 'attachment-list', label: 'File attachments' }
    ];

    function sectionHTML(section) {
      var layout = section.layout || 'photo-grid';
      var layoutSelect = '<select class="p86-report-section-layout" title="Section layout">' +
        LAYOUT_OPTIONS.map(function(o) {
          return '<option value="' + escapeAttr(o.id) + '"' + (o.id === layout ? ' selected' : '') + '>' + escapeHTML(o.label) + '</option>';
        }).join('') +
      '</select>';

      var addBtn = '';
      if (layout === 'photo-grid' || layout === 'single-photo' || layout === 'before-after') {
        var addLabel = layout === 'before-after' ? '+ Pick 2 photos' : '+ Add photos';
        addBtn = '<button class="ee-btn secondary p86-report-section-add">' + addLabel + '</button>';
      } else if (layout === 'attachment-list') {
        addBtn = '<button class="ee-btn secondary p86-report-section-add">+ Attach files</button>';
      }

      var body;
      if (layout === 'text-block') body = sectionTextBlockBodyHTML(section);
      else if (layout === 'attachment-list') body = sectionAttachmentListBodyHTML(section);
      else if (layout === 'single-photo') body = sectionSinglePhotoBodyHTML(section);
      else if (layout === 'before-after') body = sectionBeforeAfterBodyHTML(section);
      else body = sectionPhotoGridBodyHTML(section);

      return '<div class="p86-report-section layout-' + escapeAttr(layout) + '" data-sec="' + escapeAttr(section.id) + '">' +
        '<div class="p86-report-section-header">' +
          '<input class="p86-report-section-label" value="' + escapeAttr(section.label) + '" placeholder="Section name" />' +
          '<div class="p86-report-section-actions">' +
            layoutSelect +
            addBtn +
            '<button class="ee-btn secondary p86-report-section-remove">Remove</button>' +
          '</div>' +
        '</div>' +
        body +
      '</div>';
    }

    // Renders the photo's OWN description (att.caption) as a side
    // panel next to the image. The bottom-of-card input remains for
    // the report-section caption (figure-reference style). Only shown
    // when the photo actually has a description, so plain photos stay
    // compact.
    function photoSideDescHTML(att) {
      if (!att || !att.caption) return '';
      return '<div class="p86-report-photo-sidedesc" title="Photo description (from the viewer panel)">' +
        escapeHTML(att.caption) +
      '</div>';
    }
    // Tile-level affordances: drag handle (top-left, hover-only) +
    // existing remove button. The whole card is draggable so users
    // can grab anywhere; the handle is a visual cue.
    function photoDragHandleHTML() {
      return '<span class="p86-report-photo-drag" title="Drag to reorder">&#x2630;</span>';
    }

    function sectionPhotoGridBodyHTML(section) {
      return '<div class="p86-report-section-photos">' +
        (section.photo_ids.length === 0
          ? '<div class="p86-proj-empty-line" style="grid-column:1/-1;">No photos in this section yet.</div>'
          : section.photo_ids.map(function(pid, idx) {
              var att = allPhotos.find(function(a) { return a.id === pid; });
              if (!att) return '<div class="p86-report-photo p86-report-photo-missing">(photo deleted)</div>';
              var caption = section.captions[pid] || '';
              var hasDesc = !!(att.caption);
              return '<div class="p86-report-photo' + (hasDesc ? ' has-sidedesc' : '') +
                  '" draggable="true" data-photo-id="' + escapeAttr(pid) + '" data-photo-idx="' + idx + '">' +
                photoDragHandleHTML() +
                '<div class="p86-report-photo-mainstack">' +
                  '<img src="' + escapeAttr(att.thumb_url || att.web_url) + '" alt="" data-open-photo="' + escapeAttr(pid) + '" />' +
                  '<input class="p86-report-photo-caption" value="' + escapeAttr(caption) + '" data-caption-input="' + escapeAttr(pid) + '" placeholder="Caption (optional)" />' +
                '</div>' +
                photoSideDescHTML(att) +
                '<button type="button" class="p86-report-photo-remove" data-rm-photo="' + escapeAttr(pid) + '" title="Remove from section">&times;</button>' +
              '</div>';
            }).join('')) +
      '</div>';
    }

    function sectionSinglePhotoBodyHTML(section) {
      // One photo per row, full width. Reuses the caption input
      // pattern so the existing wiring keeps working.
      return '<div class="p86-report-section-singles">' +
        (section.photo_ids.length === 0
          ? '<div class="p86-proj-empty-line">No photos yet — tap "+ Add photos".</div>'
          : section.photo_ids.map(function(pid, idx) {
              var att = allPhotos.find(function(a) { return a.id === pid; });
              if (!att) return '<div class="p86-report-photo-single p86-report-photo-missing">(photo deleted)</div>';
              var caption = section.captions[pid] || '';
              var hasDesc = !!(att.caption);
              return '<div class="p86-report-photo-single' + (hasDesc ? ' has-sidedesc' : '') +
                  '" draggable="true" data-photo-id="' + escapeAttr(pid) + '" data-photo-idx="' + idx + '">' +
                photoDragHandleHTML() +
                '<div class="p86-report-photo-mainstack">' +
                  '<img src="' + escapeAttr(att.web_url || att.thumb_url) + '" alt="" data-open-photo="' + escapeAttr(pid) + '" />' +
                  '<input class="p86-report-photo-caption" value="' + escapeAttr(caption) + '" data-caption-input="' + escapeAttr(pid) + '" placeholder="Caption (optional)" />' +
                '</div>' +
                photoSideDescHTML(att) +
                '<button type="button" class="p86-report-photo-remove" data-rm-photo="' + escapeAttr(pid) + '" title="Remove">&times;</button>' +
              '</div>';
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
      openPhotoMenu(att, tile);
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
        if (e.target.files && e.target.files.length) uploadFiles(e.target.files);
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
    });
  }

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
              '<button type="button" id="upPrevMic" class="p86-mic-btn" title="Dictate (voice → text)">&#x1F3A4;</button>' +
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
    openReport: openReport,
    deleteReport: deleteReport,
    _fieldBlur: _fieldBlur,
    // Shared back-button stack — other modules (markup-viewer, etc.)
    // hook into this so a single popstate consumes a single entry.
    pushOverlay: pushOverlay,
    closeTopOverlay: closeTopOverlay
  };
})();
