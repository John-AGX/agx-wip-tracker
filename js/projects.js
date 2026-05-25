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

  function api() { return window.p86Api && window.p86Api.projects; }
  function currentUser() {
    return (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
  }

  // Pull leads / jobs / clients caches into shape for the link
  // dropdowns. If the user landed on Projects directly (e.g. via
  // /files) without visiting the Leads or Clients tabs first,
  // window.appData.{leads,clients} can be empty. Mirror what the
  // estimate editor does: prefer the dedicated p86Leads / p86Clients
  // caches; fall back to a one-shot API fetch; populate appData so
  // the rest of the app benefits too.
  function ensureEntityCaches() {
    var promises = [];

    // Leads — p86Leads.getCached() if populated, else fetch.
    var leadsCached = (window.p86Leads && window.p86Leads.getCached && window.p86Leads.getCached()) || [];
    if (!leadsCached.length && window.p86Api && window.p86Api.leads) {
      promises.push(window.p86Api.leads.list().then(function(r) {
        var rows = (r && r.leads) || [];
        window.appData = window.appData || {};
        window.appData.leads = rows;
        // Mirror back into p86Leads if it exposes a cache hook.
        if (window.p86Leads && typeof window.p86Leads.reload === 'function') {
          // Don't block on reload — populating appData is enough for
          // our dropdowns; p86Leads will refresh itself when the
          // Leads tab activates.
        }
      }).catch(function() { /* swallow — render with empty list */ }));
    } else {
      window.appData = window.appData || {};
      window.appData.leads = leadsCached.length ? leadsCached : (window.appData.leads || []);
    }

    // Clients — p86Clients.ensureLoaded() is the canonical pattern.
    if (window.p86Clients && typeof window.p86Clients.ensureLoaded === 'function') {
      promises.push(window.p86Clients.ensureLoaded().then(function(rows) {
        window.appData = window.appData || {};
        window.appData.clients = rows || [];
      }).catch(function() {}));
    } else if (window.p86Api && window.p86Api.clients) {
      promises.push(window.p86Api.clients.list().then(function(r) {
        var rows = (r && r.clients) || [];
        window.appData = window.appData || {};
        window.appData.clients = rows;
      }).catch(function() {}));
    }

    // Jobs — fetch via p86Api if appData.jobs is empty. Most users
    // have visited Jobs at least once so this is usually a no-op.
    var jobsCached = (window.appData && window.appData.jobs) || [];
    if (!jobsCached.length && window.p86Api && window.p86Api.jobs) {
      promises.push(window.p86Api.jobs.list().then(function(r) {
        var rows = (r && r.jobs) || [];
        window.appData = window.appData || {};
        window.appData.jobs = rows;
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
    tag: '',
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
  // Cache last-known tag suggestions so the editor autocomplete renders
  // immediately on focus (a stale list is better than an empty list).
  var _tagSuggestCache = [];

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
    if (_listState.tag) opts.tag = _listState.tag;
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

    // Surface tag chips from the loaded projects so users can drill in
    // without leaving the list view.
    var tagsInList = {};
    _listState.projects.forEach(function(p) {
      (p.tags || []).forEach(function(t) {
        tagsInList[t] = (tagsInList[t] || 0) + 1;
      });
    });
    var tagChips = Object.keys(tagsInList).sort().slice(0, 30);

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

        (tagChips.length
          ? '<div class="p86-projects-tag-row">' +
              (_listState.tag
                ? '<button class="p86-chip active p86-chip-tag" style="--h:' + hueFor(_listState.tag) + ';" onclick="window.p86Projects.setTagFilter(\'\')">#' + escapeHTML(_listState.tag) + ' &times;</button>'
                : tagChips.map(function(t) {
                    return '<button class="p86-chip p86-chip-tag" style="--h:' + hueFor(t) + ';" onclick="window.p86Projects.setTagFilter(\'' + escapeAttr(t) + '\')">#' + escapeHTML(t) + ' <span class="p86-chip-count">' + tagsInList[t] + '</span></button>';
                  }).join('')
              ) +
            '</div>'
          : '') +

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

    return '<div class="p86-proj-card" onclick="window.openProject(\'' + escapeAttr(p.id) + '\')">' +
      visual +
      '<div class="p86-proj-card-body">' +
        '<div class="p86-proj-card-name">' + escapeHTML(p.name) + '</div>' +
        '<div class="p86-proj-card-stats">' +
          '<span>&#x1F4F7; ' + Number(p.photo_count || 0) + '</span>' +
          (Number(p.pair_count || 0) ? '<span>&#x1F500; ' + Number(p.pair_count) + '</span>' : '') +
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
  function setTagFilter(tag) {
    _listState.tag = String(tag || '');
    fetchAll().then(paintList);
  }

  // ──────────────────────────────────────────────────────────────────
  // Create-Project modal — replaces window.prompt
  // ──────────────────────────────────────────────────────────────────
  function openCreate(prefill) {
    prefill = prefill || {};
    var prior = document.getElementById('projCreateModal');
    if (prior) prior.remove();

    // Kick off caches in the background. The modal renders immediately
    // with whatever's cached today, then we re-paint the dropdowns
    // once fresh data lands. Users can pick "None" or start typing
    // the name without waiting.
    var initialLeads = (window.appData && window.appData.leads) || [];
    var initialJobs = (window.appData && window.appData.jobs) || [];
    var initialClients = (window.appData && window.appData.clients) || [];
    var leads = initialLeads;
    var jobs = initialJobs;
    var clients = initialClients;

    function options(list, currentId, labelFn) {
      var opts = '<option value="">— None —</option>';
      list.forEach(function(item) {
        opts += '<option value="' + escapeAttr(item.id) + '"' + (String(item.id) === String(currentId || '') ? ' selected' : '') + '>' +
          escapeHTML(labelFn(item)) +
        '</option>';
      });
      return opts;
    }

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
            '<span>Address</span>' +
            '<input id="pcAddress" type="text" value="' + escapeAttr(prefill.address_text || '') + '" placeholder="Site address (powers map view + weather)" />' +
          '</label>' +
          '<label class="p86-field">' +
            '<span>Description</span>' +
            '<textarea id="pcDesc" rows="3" placeholder="Scope / context (optional)">' + escapeHTML(prefill.description || '') + '</textarea>' +
          '</label>' +
          '<div class="p86-field-row">' +
            '<label class="p86-field">' +
              '<span>Link to Lead</span>' +
              '<select id="pcLead">' + options(leads, prefill.lead_id, function(l) { return l.title || ('Lead ' + l.id); }) + '</select>' +
            '</label>' +
            '<label class="p86-field">' +
              '<span>Link to Job</span>' +
              '<select id="pcJob">' + options(jobs, prefill.job_id, function(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); }) + '</select>' +
            '</label>' +
            '<label class="p86-field">' +
              '<span>Link to Client</span>' +
              '<select id="pcClient">' + options(clients, prefill.client_id, function(c) { return c.name || ('Client ' + c.id); }) + '</select>' +
            '</label>' +
          '</div>' +
          '<div class="p86-field">' +
            '<span>Tags</span>' +
            '<div id="pcTagsEditor" class="p86-tag-editor"></div>' +
          '</div>' +
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

    // Background-load fresh caches and re-populate the dropdowns
    // when they arrive. The modal stays interactive throughout.
    ensureEntityCaches().then(function() {
      if (!document.body.contains(modal)) return; // user closed before fetch landed
      var leadsNow = (window.appData && window.appData.leads) || [];
      var jobsNow = (window.appData && window.appData.jobs) || [];
      var clientsNow = (window.appData && window.appData.clients) || [];
      var leadSel = modal.querySelector('#pcLead');
      var jobSel = modal.querySelector('#pcJob');
      var clientSel = modal.querySelector('#pcClient');
      if (leadSel && leadsNow.length !== leads.length) {
        leadSel.innerHTML = options(leadsNow, prefill.lead_id, function(l) { return l.title || ('Lead ' + l.id); });
      }
      if (jobSel && jobsNow.length !== jobs.length) {
        jobSel.innerHTML = options(jobsNow, prefill.job_id, function(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); });
      }
      if (clientSel && clientsNow.length !== clients.length) {
        clientSel.innerHTML = options(clientsNow, prefill.client_id, function(c) { return c.name || ('Client ' + c.id); });
      }
    });

    // Inline tag editor (in-memory; submits with the form).
    var tagsHostEl = modal.querySelector('#pcTagsEditor');
    var pendingTags = (prefill.tags || []).slice();
    mountTagEditor(tagsHostEl, {
      getTags: function() { return pendingTags; },
      setTags: function(next) { pendingTags = next.slice(); }
    });

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
        lead_id: modal.querySelector('#pcLead').value || null,
        job_id: modal.querySelector('#pcJob').value || null,
        client_id: modal.querySelector('#pcClient').value || null,
        tags: pendingTags
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
        if (!list || !list.length) {
          suggestEl.style.display = 'none';
          return;
        }
        var current = opts.getTags();
        var filtered = list.filter(function(t) { return current.indexOf(t) === -1; }).slice(0, 8);
        if (!filtered.length) {
          suggestEl.style.display = 'none';
          return;
        }
        suggestEl.innerHTML = filtered.map(function(t) {
          return '<button type="button" class="p86-tag-suggest-row" data-tag="' + escapeAttr(t) + '" style="--h:' + hueFor(t) + ';">#' + escapeHTML(t) + '</button>';
        }).join('');
        suggestEl.style.display = 'block';
        suggestEl.querySelectorAll('.p86-tag-suggest-row').forEach(function(b) {
          b.addEventListener('mousedown', function(e) {
            // mousedown (not click) so the input doesn't lose focus first
            e.preventDefault();
            commit(b.getAttribute('data-tag'));
            suggestEl.style.display = 'none';
          });
        });
      }

      // The editor can be pointed at any suggest source — project
      // tags, attachment tags, etc. Default is the project-tag suggest.
      var suggestFn = opts.suggestFn || function(q) {
        if (!window.p86Api || !window.p86Api.projects || !window.p86Api.projects.suggestTags) {
          return Promise.resolve({ tags: [] });
        }
        return window.p86Api.projects.suggestTags(q);
      };

      var fetchTimer;
      input.addEventListener('input', function(e) {
        clearTimeout(fetchTimer);
        var q = e.target.value;
        fetchTimer = setTimeout(function() {
          suggestFn(q).then(function(r) {
            renderSuggest((r && r.tags) || []);
          }).catch(function() {});
        }, 150);
      });
      input.addEventListener('focus', function() {
        suggestFn('').then(function(r) {
          renderSuggest((r && r.tags) || []);
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
    paintDetailLoading();
    if (!api()) {
      paintDetailError('API not available');
      return;
    }
    Promise.all([
      api().get(projectId),
      api().pairs.list(projectId).catch(function() { return { pairs: [] }; }),
      api().activity(projectId, { limit: 50 }).catch(function() { return { activity: [] }; }),
      window.p86Api.attachments.list('project', projectId).catch(function() { return { attachments: [] }; })
    ]).then(function(results) {
      _detailState.project = results[0] && results[0].project;
      _detailState.pairs = (results[1] && results[1].pairs) || [];
      _detailState.activity = (results[2] && results[2].activity) || [];
      _detailState.photos = (results[3] && results[3].attachments) || [];
      paintDetail();
    }).catch(function(e) {
      paintDetailError(e.message || 'Failed to load project');
    });
  }
  window.openProject = openProject;

  function closeDetail() {
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

      // Compact header: cover thumb · title + address + tag chips · linkages
      '<div class="p86-proj-header-row">' +
        '<div class="p86-proj-header-cover">' + coverThumb + '</div>' +
        '<div class="p86-proj-header-info">' +
          '<input id="projNameInput" value="' + escapeAttr(p.name) + '" class="p86-proj-header-name" placeholder="Project name" />' +
          '<input id="projAddrInput" value="' + escapeAttr(p.address_text || '') + '" placeholder="Site address" class="p86-proj-header-addr" />' +
          '<div id="projDetailTagsEditor" class="p86-tag-editor p86-tag-editor-header"></div>' +
        '</div>' +
        '<div class="p86-proj-header-side">' +
          (linkBadges.length
            ? linkBadges.map(function(b) {
                return '<div class="p86-proj-link-row"><span class="p86-proj-link-k">' + escapeHTML(b.k) + ':</span> ' + escapeHTML(b.v) + '</div>';
              }).join('')
            : '<div class="p86-proj-empty-line">Not linked yet.</div>') +
          '<div class="p86-proj-header-meta">Updated ' + escapeHTML(fmtRelative(p.updated_at)) +
            (p.created_by_name ? ' &middot; ' + escapeHTML(p.created_by_name) : '') +
          '</div>' +
        '</div>' +
      '</div>' +

      // Tab strip (Photos + future) — for now Photos is the only
      // active tab; Reports + Files are placeholders for the
      // polymorphic refactor in P2.
      '<div class="p86-proj-tabs">' +
        '<button class="p86-proj-tab active">Photos <span class="p86-proj-tab-count">(' + _detailState.photos.length + ')</span></button>' +
        '<button class="p86-proj-tab disabled" title="Coming in Phase 2">Reports <span class="p86-proj-tab-count">(0)</span></button>' +
        '<button class="p86-proj-tab disabled" title="Coming soon">Files <span class="p86-proj-tab-count">(0)</span></button>' +
      '</div>' +

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
          '<button class="primary" onclick="document.getElementById(\'projPhotoFileInput\').click();">&#x2795; Upload Photos</button>' +
          '<input type="file" id="projPhotoFileInput" multiple accept="image/*,application/pdf" style="display:none;" />' +
        '</div>' +
      '</div>' +

      // Tag filter chip strip
      '<div id="projTagChipStrip" class="p86-proj-tag-strip"></div>' +

      // Photo feed (date-grouped grid; rendered by paintPhotoFeed)
      '<div id="projPhotoFeed" class="p86-proj-photo-feed"></div>' +

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

    // Project-level tag editor in the header row
    var tagsHostEl = host.querySelector('#projDetailTagsEditor');
    if (tagsHostEl) {
      mountTagEditor(tagsHostEl, {
        getTags: function() { return (_detailState.project.tags || []).slice(); },
        setTags: function(next) {
          _detailState.project.tags = next.slice();
          api().update(_detailState.project.id, { tags: next }).catch(function(e) {
            alert('Tag save failed: ' + (e.message || e));
          });
        }
      });
    }

    paintTagChipStrip();
    paintPhotoFeed();
    paintActivityFeed();
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

  function paintPhotoFeed() {
    var host = document.getElementById('projPhotoFeed');
    if (!host) return;
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

    // CompanyCam-style tile: checkbox top-left, ⋮ menu top-right,
    // uploader initials bottom-left, tag/caption indicator bottom-right.
    // Time + uploader name renders below the tile.
    tile.innerHTML =
      '<div class="p86-proj-photo-tile-visual">' +
        visual +
        '<label class="p86-proj-photo-tile-checkbox" onclick="event.stopPropagation();">' +
          '<input type="checkbox"' + (_detailState.selection.has(att.id) ? ' checked' : '') + ' />' +
        '</label>' +
        '<button type="button" class="p86-proj-photo-tile-menu" title="More">&#x22EE;</button>' +
        (uploaderInitials
          ? '<span class="p86-proj-photo-tile-uploader" title="' + escapeAttr(att.uploaded_by_name || '') + '">' + escapeHTML(uploaderInitials) + '</span>'
          : '') +
        '<div class="p86-proj-photo-tile-badges">' +
          (hasCaption ? '<span class="p86-proj-photo-tile-badge" title="' + escapeAttr(att.caption) + '">&#x1F4DD;</span>' : '') +
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
      if (e.target.closest('.p86-proj-photo-tile-checkbox')) return;
      openPhotoInLightbox(att);
    });
    tile.querySelector('.p86-proj-photo-tile-menu').addEventListener('click', function(e) {
      e.stopPropagation();
      openPhotoMenu(att, tile);
    });

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
    // swipe nav works.
    if (window.p86Attachments && typeof window.p86Attachments.openLightbox === 'function') {
      var idx = _detailState.photos.findIndex(function(x) { return x.id === att.id; });
      window.p86Attachments.openLightbox(_detailState.photos, Math.max(0, idx));
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
    if (window.p86Markup && typeof window.p86Markup.open === 'function') {
      window.p86Markup.open({
        attachment: att,
        onDone: function() {
          // Refresh — the annotator uploaded a new markup attachment.
          refreshDetailPhotos();
        }
      });
    } else {
      alert('Annotator not loaded.');
    }
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
        '<input type="file" id="projPhotoFileInput" multiple accept="image/*,application/pdf" style="display:none;" />' +
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

  function uploadFiles(files) {
    var pid = _detailState.projectId;
    if (!pid) return;
    var chain = Promise.resolve();
    Array.from(files).forEach(function(f) {
      chain = chain.then(function() {
        return window.p86Api.attachments.upload('project', pid, f).catch(function(err) {
          alert('Upload failed for "' + f.name + '": ' + (err.message || err));
        });
      });
    });
    chain.then(function() {
      // Re-fetch photos + activity to surface new uploads.
      Promise.all([
        window.p86Api.attachments.list('project', pid).catch(function() { return { attachments: [] }; }),
        api().activity(pid, { limit: 50 }).catch(function() { return { activity: [] }; })
      ]).then(function(rs) {
        _detailState.photos = (rs[0] && rs[0].attachments) || [];
        _detailState.activity = (rs[1] && rs[1].activity) || [];
        paintPhotoFeed();
        paintActivityFeed();
      });
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
      alert('Save failed for ' + field + ': ' + (e.message || e));
    });
    // Side effect: the inline Google Maps iframe was rendered once at
    // paintDetail time with the address that was there then. If the
    // user edits the address, the input updates but the iframe stays
    // stuck on the old map — making it look like the project has the
    // wrong address. Swap the src so the pin tracks the typed value.
    if (field === 'address_text') refreshInlineMap();
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
    var leads = (window.appData && window.appData.leads) || [];
    var jobs = (window.appData && window.appData.jobs) || [];
    var clients = (window.appData && window.appData.clients) || [];

    function options(list, current, labelFn) {
      var opts = '<option value="">— None —</option>';
      list.forEach(function(item) {
        opts += '<option value="' + escapeAttr(item.id) + '"' + (String(item.id) === String(current || '') ? ' selected' : '') + '>' +
          escapeHTML(labelFn(item)) +
        '</option>';
      });
      return opts;
    }

    var modal = document.createElement('div');
    modal.id = 'projLinksModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header"><span>Edit project links</span><button class="p86-modal-close" data-close>&times;</button></div>' +
        '<label class="p86-field"><span>Lead</span><select id="plLead">' + options(leads, p.lead_id, function(l) { return l.title || ('Lead ' + l.id); }) + '</select></label>' +
        '<label class="p86-field"><span>Job</span><select id="plJob">' + options(jobs, p.job_id, function(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); }) + '</select></label>' +
        '<label class="p86-field"><span>Client</span><select id="plClient">' + options(clients, p.client_id, function(c) { return c.name || ('Client ' + c.id); }) + '</select></label>' +
        '<label class="p86-field" style="flex-direction:row;align-items:center;gap:8px;margin-top:6px;">' +
          '<input type="checkbox" id="plInherit" checked style="margin:0;" />' +
          '<span style="text-transform:none;letter-spacing:0;font-weight:500;font-size:12px;color:var(--text,#fff);">Use linked entity\'s title and address (overwrites current values)</span>' +
        '</label>' +
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

    // Refresh dropdowns once cached lists land. If the user opened
    // Projects directly via /files, leads + clients weren't loaded.
    ensureEntityCaches().then(function() {
      if (!document.body.contains(modal)) return;
      var leadsNow = (window.appData && window.appData.leads) || [];
      var jobsNow = (window.appData && window.appData.jobs) || [];
      var clientsNow = (window.appData && window.appData.clients) || [];
      var leadSel = modal.querySelector('#plLead');
      var jobSel = modal.querySelector('#plJob');
      var clientSel = modal.querySelector('#plClient');
      if (leadSel && leadsNow.length !== leads.length) {
        leadSel.innerHTML = options(leadsNow, p.lead_id, function(l) { return l.title || ('Lead ' + l.id); });
      }
      if (jobSel && jobsNow.length !== jobs.length) {
        jobSel.innerHTML = options(jobsNow, p.job_id, function(j) { return (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id); });
      }
      if (clientSel && clientsNow.length !== clients.length) {
        clientSel.innerHTML = options(clientsNow, p.client_id, function(c) { return c.name || ('Client ' + c.id); });
      }
    });

    modal.querySelector('#plSave').addEventListener('click', function() {
      var newLeadId = modal.querySelector('#plLead').value || null;
      var newJobId = modal.querySelector('#plJob').value || null;
      var newClientId = modal.querySelector('#plClient').value || null;
      var doInherit = modal.querySelector('#plInherit').checked;
      var patch = {
        lead_id: newLeadId,
        job_id: newJobId,
        client_id: newClientId
      };

      // Explicit inheritance — only applies when the checkbox is on.
      // Picks the most-specific entity that has data: job > lead >
      // client. Always overwrites name + address if the checkbox is
      // checked, so the user has predictable control. Uncheck to
      // keep the project's current name/address regardless of links.
      if (doInherit) {
        var src = null;
        if (newJobId)        src = inheritFromEntity('job', newJobId);
        else if (newLeadId)  src = inheritFromEntity('lead', newLeadId);
        else if (newClientId) src = inheritFromEntity('client', newClientId);

        if (src) {
          if (src.name)    patch.name = src.name;
          if (src.address) patch.address_text = src.address;
          // Auto-fill client linkage when a lead carries one and the
          // user didn't explicitly pick a client.
          if (src.client_id && !newClientId) patch.client_id = src.client_id;
        }
      }

      api().update(p.id, patch).then(function(r) {
        _detailState.project = r && r.project;
        modal.remove();
        paintDetail();   // full repaint pulls in the new map iframe src
        refreshLinkedPanels();
      }).catch(function(e) { alert('Save failed: ' + (e.message || e)); });
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
    setTagFilter: setTagFilter,
    openCreate: openCreate,
    createPrompt: createPrompt,     // legacy alias
    createForEntity: createForEntity,
    archive: archive,
    unarchive: unarchive,
    editLinks: editLinks,
    _fieldBlur: _fieldBlur
  };
})();
