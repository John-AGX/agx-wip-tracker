// Combined entities map — Summary "Map" card (Phase 1 / Deliverable 2).
//
// Plots LEADS + JOBS together on one Google Map, with:
//   • Typed Project 86 teardrop pins (reuses js/map-pins.js — same
//     classifier + SVG builder the Projects / Leads / Jobs maps use, so
//     a reno job here looks identical to a reno job on the Jobs map).
//   • PROPERTY GROUPING — AGX does repeat work at the same address, so a
//     lead + a job (or several) routinely share one set of coordinates.
//     Markers are grouped by exact coordinate (the server-side US Census
//     geocoder is deterministic: the same address → the same lat/lng), so
//     a property with 2+ items collapses to ONE pin carrying a count
//     badge. Clicking it opens a list of every item there, each routing
//     to its entity. A single-item location renders as its normal typed
//     pin. (Deliberately NOT proximity clustering — co-located items at
//     ONE property are grouped; nearby-but-different properties are not.)
//   • A "you are here" marker + Recenter button when the browser grants
//     geolocation (window.p86Geo). Degrades gracefully — denied / null
//     position simply omits the marker; the entity pins still render.
//   • Filter chips to toggle Leads vs Jobs (re-groups the visible set).
//   • Click a pin → opens that entity through the existing app router
//     (window.openEditLeadModal for leads, window.editJob for jobs —
//     the same handlers the standalone Leads / Jobs maps wire to onPin).
//
// This is a SELF-CONTAINED renderer (it does NOT call into
// p86ProjectsMap) so it can never regress the existing per-entity maps.
// It only borrows the shared, stateless helpers: window.p86Maps.ready(),
// window.p86MapPins.specForEntity(), and window.p86Geo.get().
//
// Public surface:
//   window.p86EntitiesMap.render(hostId, opts)
//     hostId — element id of the host container (e.g. 'summaryMapHost').
//     opts   — reserved; currently unused. Data is fetched from
//              GET /api/map/entities (org-scoped) unless opts.items is
//              passed ({leads, jobs}) for a caller-supplied dataset.

(function () {
  'use strict';

  if (window.p86EntitiesMap) return; // idempotent

  // Coordinate-grouping precision. 5 decimals ≈ 1.1m — finer than any
  // street address, so distinct addresses never collide, while the SAME
  // address (deterministic geocode) always lands in one group.
  var GROUP_DECIMALS = 5;

  // Vector "Map ID" (Google Cloud → Maps → Map Management, project86). A vector map
  // unlocks tilt + a cinematic camera and is REQUIRED for AdvancedMarkerElement pins.
  // Used ONLY by the org Job Map (opts.jobsSidebar); the Summary card stays raster.
  var P86_MAP_ID = '285034f23d385f2e9f756209';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // Same null-island / range guard the server + projects-map use.
  function usableCoords(lat, lng) {
    var a = Number(lat), o = Number(lng);
    if (!isFinite(a) || !isFinite(o)) return null;
    if (a === 0 && o === 0) return null;
    if (a < -90 || a > 90 || o < -180 || o > 180) return null;
    return { lat: a, lng: o };
  }

  // Open an entity through the existing app router — the same handlers
  // the standalone Leads / Jobs maps pass as onPin.
  // Org-map drill hook: when set (by a caller passing opts.onJob), a job pin's
  // Open action drills into that job instead of the default editJob.
  var _onJobHook = null;
  function openEntity(kind, id) {
    if (!id) return;
    // The client-dashboard map lives in a modal — close it so the opened
    // entity isn't hidden underneath. No-op on every other mount.
    if (typeof window.closeClientDashboard === 'function') window.closeClientDashboard();
    if (kind === 'lead') {
      // The lead detail view lives inside the estimates→leads tab, so from
      // any other page (Summary map, Leads Map, client dashboard) the open
      // is invisible unless we navigate there first — same steps the AI
      // panel's navigate tool uses.
      if (typeof window.openEditLeadModal === 'function') {
        if (typeof window.switchTab === 'function') window.switchTab('estimates');
        // switchTab re-runs the ACTIVE sub-tab's render — when that's already
        // 'leads' it just reloaded the leads cache, so switching again here
        // would wipe + refetch the same list a second time. Only switch
        // explicitly when some other sub-tab is active.
        var activeSub = document.querySelector('#estimates [data-estimates-subtab].active');
        var onLeads = !!(activeSub && activeSub.getAttribute('data-estimates-subtab') === 'leads');
        if (!onLeads && typeof window.switchEstimatesSubTab === 'function') window.switchEstimatesSubTab('leads');
        if (typeof window.markVirtualTabActive === 'function') window.markVirtualTabActive('leads');
        window.openEditLeadModal(id); return;
      }
    } else if (kind === 'job') {
      if (typeof _onJobHook === 'function') { _onJobHook(id); return; }
      if (typeof window.editJob === 'function') {
        if (typeof window.switchTab === 'function') window.switchTab('jobs');
        window.editJob(id); return;
      }
    }
    // Last resort — no-op rather than throwing.
  }

  // Handle to the CURRENT mount, so the public flyToJob(jobId) can drive the
  // live map + markers from outside (e.g. a jobs-list row). Reset each mount.
  var _active = null;

  // Shallow clone of an opts object with overrides (ES5-safe, no Object.assign
  // dependency). Used to re-render after the geocode warm-up without re-warming.
  function assignOpts(base, over) {
    var o = {}, k;
    for (k in base) { if (Object.prototype.hasOwnProperty.call(base, k)) o[k] = base[k]; }
    for (k in over) { if (Object.prototype.hasOwnProperty.call(over, k)) o[k] = over[k]; }
    return o;
  }

  // Inject the jobs-sidebar stylesheet once (the org Job Map only).
  function injectJobsSidebarStyle() {
    if (document.getElementById('emap-jobs-style')) return;
    var st = document.createElement('style');
    st.id = 'emap-jobs-style';
    st.textContent =
      '.emap-jobs-panel{position:absolute;top:0;right:0;bottom:0;width:300px;max-width:78%;z-index:6;display:flex;flex-direction:column;' +
        'background:rgba(17,20,28,0.94);border-left:1px solid rgba(255,255,255,0.10);box-shadow:-4px 0 18px rgba(0,0,0,0.35);' +
        'transition:transform .22s ease;font-family:system-ui,Segoe UI,sans-serif;}' +
      '.emap-jobs-panel.emap-collapsed{transform:translateX(100%);}' +
      '.emap-jobs-head{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(255,255,255,0.08);}' +
      '.emap-jobs-title{font-size:13px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#cbd5e1;}' +
      '.emap-jobs-title b{color:#4f8cff;}' +
      '.emap-jobs-collapse{background:transparent;border:1px solid rgba(255,255,255,0.15);color:#94a3b8;min-width:24px;height:24px;border-radius:6px;cursor:pointer;font-size:12px;line-height:1;}' +
      '.emap-jobs-collapse:hover{color:#fff;border-color:#4f8cff;}' +
      '.emap-jobs-search{margin:10px 12px;padding:7px 10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);border-radius:7px;color:#e2e8f0;font-size:13px;outline:none;}' +
      '.emap-jobs-search:focus{border-color:#4f8cff;}' +
      '.emap-jobs-search::placeholder{color:#64748b;}' +
      '.emap-jobs-list{flex:1;overflow-y:auto;padding:0 8px 12px;}' +
      '.emap-job-row{padding:9px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent;margin-bottom:2px;}' +
      '.emap-job-row:hover{background:rgba(255,255,255,0.05);}' +
      '.emap-job-row.sel{background:rgba(79,140,255,0.14);border-color:rgba(79,140,255,0.40);}' +
      '.emap-job-main{display:flex;align-items:center;gap:6px;justify-content:space-between;}' +
      '.emap-job-name{font-size:13px;font-weight:600;color:#e2e8f0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.emap-job-status{flex-shrink:0;font-size:9px;font-weight:700;text-transform:capitalize;color:#fff;background:#64748b;border-radius:4px;padding:1px 6px;}' +
      '.emap-job-addr{font-size:11px;color:#94a3b8;margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.emap-job-wip{display:none;margin-top:7px;width:100%;padding:5px;font-size:11px;font-weight:600;color:#fff;background:#0a66c2;border:none;border-radius:6px;cursor:pointer;}' +
      '.emap-job-row.sel .emap-job-wip{display:block;}' +
      '.emap-job-wip:hover{background:#0958a8;}' +
      '.emap-jobs-empty{padding:20px 10px;text-align:center;color:#64748b;font-size:12px;}' +
      '.emap-jobs-expand{position:absolute;top:10px;right:10px;z-index:6;font-size:11px;font-weight:600;padding:6px 11px;border-radius:6px;border:1px solid rgba(255,255,255,0.15);background:rgba(17,20,28,0.94);color:#cbd5e1;cursor:pointer;box-shadow:-2px 0 8px rgba(0,0,0,0.30);}' +
      '.emap-jobs-expand:hover{color:#fff;border-color:#4f8cff;}' +
      '.emap-geocode-note{position:absolute;bottom:24px;left:10px;z-index:6;font-size:11px;font-weight:600;padding:6px 12px;border-radius:14px;background:rgba(17,20,28,0.92);color:#cbd5e1;border:1px solid rgba(255,255,255,0.12);box-shadow:0 1px 6px rgba(0,0,0,0.30);}' +
      '@keyframes emap-pin-bounce{0%,100%{transform:translateY(0)}25%{transform:translateY(-13px)}50%{transform:translateY(0)}75%{transform:translateY(-6px)}}' +
      '.emap-pin-bounce{animation:emap-pin-bounce .7s ease-in-out 2;transform-origin:bottom center}' +
      '.emap-pop{position:absolute;}' +
      '.emap-pop::after{content:"";position:absolute;left:0;bottom:42px;transform:translateX(-50%);width:0;height:0;border-left:8px solid transparent;border-right:8px solid transparent;border-top:8px solid #11151f;}' +
      '.emap-pop-bubble{position:absolute;left:0;bottom:50px;transform:translateX(-50%);width:262px;max-width:78vw;max-height:320px;overflow-y:auto;overflow-x:hidden;background:#11151f;border:1px solid rgba(255,255,255,.12);border-radius:13px;box-shadow:0 10px 30px rgba(0,0,0,.55);}' +
      '.emap-pop-inner{position:relative;}' +
      '.emap-pop-x{position:absolute;top:7px;right:8px;z-index:3;background:rgba(8,11,17,.55);border:none;color:#aeb6c5;font-size:16px;line-height:1;cursor:pointer;width:22px;height:22px;border-radius:50%;padding:0;}' +
      '.emap-pop-x:hover{color:#fff;background:rgba(8,11,17,.85);}' +
      '.emap-jc-top{display:flex;gap:13px;align-items:center;}' +
      '.emap-jc-ring{flex-shrink:0;}' +
      '.emap-jc-meta{min-width:0;flex:1;}' +
      '.emap-jc-name{font-size:14px;font-weight:600;color:#f1f5f9;line-height:1.25;margin-bottom:5px;}' +
      '.emap-jc-statusrow{margin-bottom:8px;display:flex;align-items:center;gap:6px;}' +
      '.emap-jc-nums{display:flex;gap:16px;}' +
      '.emap-jc-lbl{display:block;font-size:10px;color:#7c8699;margin-bottom:1px;}' +
      '.emap-jc-val{font-size:13px;font-weight:600;color:#e2e8f0;}' +
      '.emap-pos{color:#34d399;}' +
      '.emap-neg{color:#f87171;}' +
      '.emap-jc-addr{font-size:11px;color:#8b94a6;margin-top:10px;line-height:1.4;}' +
      '.emap-jc-actions{display:flex;gap:7px;margin-top:12px;}' +
      '.emap-jc-btn{flex:1;background:#0a66c2;border:none;color:#fff;font-size:12px;font-weight:600;border-radius:7px;padding:7px;cursor:pointer;}' +
      '.emap-jc-btn:hover{background:#0958a8;}' +
      '.emap-jc-ghost{flex:0 0 auto;background:transparent;border:1px solid rgba(255,255,255,.16);color:#cbd5e1;padding:7px 12px;}' +
      '.emap-jc-ghost:hover{background:rgba(255,255,255,.06);}' +
      '.emap-grp-head{font-size:11px;font-weight:600;color:#8aa6ff;margin-bottom:2px;}' +
      '.emap-grp-addr{font-size:11px;color:#8b94a6;margin-bottom:10px;}' +
      '.emap-grp-list{display:flex;flex-direction:column;gap:7px;}' +
      '.emap-grp-row{display:flex;align-items:center;gap:8px;background:rgba(255,255,255,.04);border-radius:8px;padding:8px 10px;cursor:pointer;}' +
      '.emap-grp-row:hover{background:rgba(79,140,255,.12);}' +
      '.emap-grp-name{flex:1;font-size:12px;color:#dbe2ec;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.emap-kind{font-size:9px;font-weight:600;color:#bcd4f5;background:#16335c;border-radius:4px;padding:2px 6px;flex-shrink:0;}' +
      '.emap-kind-job{color:#cbd5e1;background:#3a4150;}' +
      '.emap-chev{color:#7c8699;font-size:15px;line-height:1;}';
    document.head.appendChild(st);
  }

  // Public: smoothly fly the live map to a job's pin (driven by the jobs list).
  function flyToJob(jobId) {
    if (!_active || !_active.jobIndex) return false;
    var e = _active.jobIndex[jobId];
    if (!e) return false;
    _active.flyTo(e.pos, e.marker, e.item);
    return true;
  }

  function emptyHTML(reason) {
    return '<div style="padding:28px 18px;text-align:center;color:var(--text-dim,#888);font-size:13px;line-height:1.5;">' +
      escapeHTML(reason) + '</div>';
  }

  // Build the marker icon spec for a SINGLE entity via the shared
  // map-pins module (falls back to the default Google pin if it isn't
  // loaded).
  function iconForItem(maps, item) {
    if (window.p86MapPins && typeof window.p86MapPins.specForEntity === 'function') {
      var spec = window.p86MapPins.specForEntity(item, item.kind === 'lead' ? 'lead' : 'job');
      if (spec && spec.url) {
        return {
          url: spec.url,
          anchor: new maps.Point(spec.ax, spec.ay),
          scaledSize: new maps.Size(spec.w, spec.h)
        };
      }
    }
    return undefined;
  }

  // A grouped "property" pin: an indigo teardrop with a white head
  // showing how many items share this address. Self-contained SVG (a
  // grouped pin is a new visual concept, kept out of the shared per-entity
  // pin builder so the other maps are untouched). Count text shrinks for
  // 2+ digits so it stays inside the head.
  function groupPinIcon(maps, count) {
    var label = count > 99 ? '99+' : String(count);
    var fs = label.length >= 3 ? 9 : (label.length === 2 ? 11 : 13);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
        '<path d="M15 1 C7.3 1 1 7.3 1 15 c0 10.2 14 26 14 26 s14-15.8 14-26 C29 7.3 22.7 1 15 1 z" ' +
          'fill="#4f46e5" stroke="#ffffff" stroke-width="1.5"/>' +
        '<circle cx="15" cy="15" r="9.5" fill="#ffffff"/>' +
        '<text x="15" y="15" text-anchor="middle" dominant-baseline="central" ' +
          'font-family="system-ui,Segoe UI,sans-serif" font-size="' + fs + '" font-weight="700" fill="#4f46e5">' +
          escapeHTML(label) + '</text>' +
      '</svg>';
    return {
      url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: new maps.Point(15, 42),
      scaledSize: new maps.Size(30, 42)
    };
  }

  // Teardrop pin with a short text glyph in the head — used by opts.extraPins
  // (dossier safety pins: property ⌂ / hospital H / fire FD). Plain-text
  // glyphs only (no emoji) so the SVG data URI renders identically everywhere.
  function glyphPinIcon(maps, glyph, color) {
    var label = String(glyph || '•').slice(0, 3);
    var fs = label.length >= 3 ? 8 : (label.length === 2 ? 10 : 13);
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="30" height="42" viewBox="0 0 30 42">' +
        '<path d="M15 1 C7.3 1 1 7.3 1 15 c0 10.2 14 26 14 26 s14-15.8 14-26 C29 7.3 22.7 1 15 1 z" ' +
          'fill="' + color + '" stroke="#ffffff" stroke-width="1.5"/>' +
        '<circle cx="15" cy="15" r="9.5" fill="#ffffff"/>' +
        '<text x="15" y="15" text-anchor="middle" dominant-baseline="central" ' +
          'font-family="system-ui,Segoe UI,sans-serif" font-size="' + fs + '" font-weight="700" fill="' + color + '">' +
          escapeHTML(label) + '</text>' +
      '</svg>';
    return {
      url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      anchor: new maps.Point(15, 42),
      scaledSize: new maps.Size(30, 42)
    };
  }

  function render(hostId, opts) {
    opts = opts || {};
    var host = (typeof hostId === 'string') ? document.getElementById(hostId) : hostId;
    if (!host) return;

    if (!window.p86Maps || typeof window.p86Maps.ready !== 'function') {
      host.innerHTML = emptyHTML('Map module not loaded.');
      return;
    }

    host.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100%;min-height:420px;color:var(--text-dim,#888);font-size:13px;">Loading map…</div>';

    // Data: prefer the caller-supplied dataset, else the org-scoped
    // endpoint, else (last resort) assemble from window.appData.
    var dataPromise;
    if (opts.items && (opts.items.leads || opts.items.jobs)) {
      dataPromise = Promise.resolve(opts.items);
    } else if (window.p86Api && window.p86Api.map && typeof window.p86Api.map.entities === 'function') {
      dataPromise = window.p86Api.map.entities().catch(function () { return assembleFromAppData(); });
    } else {
      dataPromise = Promise.resolve(assembleFromAppData());
    }

    // Boot the SDK + fetch data in parallel; warm the pin config too.
    try {
      if (window.p86MapPins && window.p86MapPins.ensureConfig) window.p86MapPins.ensureConfig();
    } catch (e) { /* non-fatal */ }

    Promise.all([
      window.p86Maps.ready(),
      dataPromise
    ]).then(function (results) {
      var maps = results[0];
      var data = results[1] || {};
      mount(maps, host, normalizeData(data), opts);
    }).catch(function (err) {
      host.innerHTML = emptyHTML('Map unavailable: ' + (err && err.message || 'unknown error'));
    });
  }

  // Fallback: build {leads, jobs} from the already-loaded window.appData
  // when the endpoint is unreachable. Reads the same geocode_lat/lng the
  // server reads. Only used if /api/map/entities fails.
  function assembleFromAppData() {
    var d = window.appData || {};
    var composeAddr = function (o) {
      return o.address_text || [o.street_address, o.city].filter(Boolean).join(', ') || o.geocode_address || '';
    };
    var leads = (d.leads || []).map(function (l) {
      return { id: l.id, title: l.title || 'Untitled lead',
        lat: l.geocode_lat, lng: l.geocode_lng, kind: 'lead', status: l.status || '', address: composeAddr(l) };
    });
    var jobs = (d.jobs || []).map(function (j) {
      var num = j.jobNumber || j.job_number || '';
      var name = j.title || j.name || 'Untitled job';
      var jd = j.data || j;
      var jstatus = (jd && typeof jd.status === 'string') ? jd.status : (j.status || '');
      var addr = j.geocode_address || (jd.geocode_address) ||
        (jd.address && String(jd.address).trim()) ||
        ((Array.isArray(jd.buildings) && jd.buildings[0] && jd.buildings[0].address) || '');
      return { id: j.id, title: num ? (num + ' — ' + name) : name,
        lat: j.geocode_lat, lng: j.geocode_lng, kind: 'job', jobNumber: num, status: jstatus, address: addr };
    });
    return { leads: leads, jobs: jobs };
  }

  // Drop unplottable rows up front so counts + chips reflect reality.
  function normalizeData(data) {
    function clean(arr, kind) {
      return (arr || []).map(function (it) {
        var c = usableCoords(it.lat, it.lng);
        if (!c) return null;
        return { id: it.id, title: it.title, lat: c.lat, lng: c.lng,
          kind: kind, jobNumber: it.jobNumber || '', status: it.status || '', address: it.address || '' };
      }).filter(Boolean);
    }
    return { leads: clean(data.leads, 'lead'), jobs: clean(data.jobs, 'job') };
  }

  // Group a flat item list by exact coordinate. Returns an array of
  // groups: { lat, lng, members[] } preserving first-seen order.
  function groupByLocation(items) {
    var byKey = {};
    var order = [];
    items.forEach(function (it) {
      var key = it.lat.toFixed(GROUP_DECIMALS) + ',' + it.lng.toFixed(GROUP_DECIMALS);
      if (!byKey[key]) { byKey[key] = { lat: it.lat, lng: it.lng, members: [] }; order.push(key); }
      byKey[key].members.push(it);
    });
    return order.map(function (k) { return byKey[k]; });
  }

  function mount(maps, host, data, opts) {
    opts = opts || {};
    _onJobHook = (typeof opts.onJob === 'function') ? opts.onJob : null; // org-map: pin → drill into Site Plan
    // Single-kind maps: opts.only filters to one entity kind — Job Map = 'job',
    // Leads Map = 'lead'. Unset keeps the original dual-kind behavior (Summary card).
    if (opts.only === 'job') data.leads = [];
    else if (opts.only === 'lead') data.jobs = [];
    var allItems = data.leads.concat(data.jobs);
    var total = allItems.length;

    // Extra non-entity pins (opts.extraPins: {lat,lng,glyph,color,title}) —
    // e.g. the client dossier's property/hospital/fire safety pins. Always
    // shown; not part of the lead/job filter chips. A map with ONLY extra
    // pins is valid (client property with no plotted leads/jobs yet).
    var extraPins = (Array.isArray(opts.extraPins) ? opts.extraPins : []).map(function (p) {
      var c = usableCoords(p.lat, p.lng);
      return c ? { lat: c.lat, lng: c.lng, glyph: p.glyph || '•', color: p.color || '#4f46e5', title: p.title || '' } : null;
    }).filter(Boolean);

    if (!total && !extraPins.length) {
      host.innerHTML = emptyHTML('No leads or jobs with mapped addresses yet. Save an address on a lead or job to plot it here.');
      return;
    }

    // The chips + canvas anchor to the host via position:absolute — make
    // sure the host is actually a positioned box.
    try { if (getComputedStyle(host).position === 'static') host.style.position = 'relative'; } catch (e) {}

    // Chrome: filter chips + map canvas + recenter button. Canvas fills
    // the relative host via absolute inset so it always has a definite
    // box for the Maps SDK to measure.
    host.innerHTML =
      (opts.only || !total ? '' :
        '<div style="position:absolute;top:10px;left:10px;z-index:5;display:flex;gap:6px;">' +
        '<button type="button" data-emap-chip="lead" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #4f8cff;background:#4f8cff;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Leads ' + data.leads.length + '</button>' +
        '<button type="button" data-emap-chip="job" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #94a3b8;background:#94a3b8;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Jobs ' + data.jobs.length + '</button>' +
        '</div>') +
      '<button type="button" data-emap-recenter ' +
        'style="position:absolute;bottom:24px;right:10px;z-index:5;display:none;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid var(--border,#333);background:#fff;color:#111;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.3);">\u{1F4CD} You</button>' +
      '<div data-emap-canvas style="position:absolute;inset:0;"></div>';

    var canvas = host.querySelector('[data-emap-canvas]');
    var recenterBtn = host.querySelector('[data-emap-recenter]');

    var first = allItems[0] || extraPins[0];
    var mapOpts = {
      center: { lat: first.lat, lng: first.lng },
      zoom: 11,
      mapTypeControl: !!opts.satellite,          // org map: let the user flip satellite/hybrid/road
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
      // org map → Google-Earth-style hybrid (imagery + labels); other mounts stay roadmap
      mapTypeId: opts.satellite ? maps.MapTypeId.HYBRID : maps.MapTypeId.ROADMAP
    };
    // Vector basemap + AdvancedMarkerElement pins — ONLY the org Job Map, and only when
    // the marker library exposes AdvancedMarkerElement. Falls back to raster + classic
    // markers (the current behavior) otherwise. The Summary card never opts in.
    var advOK = !!(opts.jobsSidebar && P86_MAP_ID && maps.marker && maps.marker.AdvancedMarkerElement);
    if (advOK) mapOpts.mapId = P86_MAP_ID;
    // The jobs sidebar covers the right edge — move the zoom + fullscreen controls
    // to the left so they stay reachable behind it.
    if (opts.jobsSidebar && maps.ControlPosition) {
      mapOpts.zoomControlOptions = { position: maps.ControlPosition.LEFT_BOTTOM };
      mapOpts.fullscreenControlOptions = { position: maps.ControlPosition.LEFT_TOP };
    }
    var map = new maps.Map(canvas, mapOpts);

    // ── 3D tilt + rotate nav cluster (vector Job Map only — raster can't tilt). A
    // compact dark control near the left edge: 3D toggle (top-down <-> 47.5deg tilt),
    // rotate +/-45deg, and a compass needle that points to map-north (click = reset
    // heading + flatten). Tilt/rotate already work via Ctrl-drag / two-finger
    // gestures on the vector map; this just surfaces them as discoverable buttons.
    if (advOK && maps.ControlPosition && map.controls) {
      (function () {
        if (!document.getElementById('p86-map-nav-css')) {
          var st = document.createElement('style'); st.id = 'p86-map-nav-css';
          st.textContent =
            '.p86-map-nav{display:flex;flex-direction:column;margin:10px;background:rgba(17,20,28,.92);border:1px solid rgba(255,255,255,.14);border-radius:10px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.45)}' +
            '.p86-map-nav button{width:38px;height:34px;border:none;background:transparent;color:#cdd3e0;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;line-height:1;transition:background .12s,color .12s}' +
            '.p86-map-nav button+button{border-top:1px solid rgba(255,255,255,.08)}' +
            '.p86-map-nav button:hover{background:rgba(255,255,255,.08);color:#fff}' +
            '.p86-map-nav button.on{background:rgba(79,140,255,.22);color:#7eb0ff}' +
            '.p86-map-nav-needle{display:inline-block;transition:transform .2s}';
          document.head.appendChild(st);
        }
        var wrap = document.createElement('div');
        wrap.className = 'p86-map-nav';
        wrap.innerHTML =
          '<button data-act="3d" title="Toggle 3D tilt">3D</button>' +
          '<button data-act="rotl" title="Rotate left">&#8634;</button>' +
          '<button data-act="rotr" title="Rotate right">&#8635;</button>' +
          '<button data-act="north" title="Reset to North (top-down)"><span class="p86-map-nav-needle">&#9650;</span></button>';
        var t3d = wrap.querySelector('[data-act="3d"]');
        var needle = wrap.querySelector('.p86-map-nav-needle');
        function curTilt() { return (map.getTilt && map.getTilt()) || 0; }
        function curHead() { return (map.getHeading && map.getHeading()) || 0; }
        function sync() {
          if (t3d) t3d.classList.toggle('on', curTilt() >= 10);
          if (needle) needle.style.transform = 'rotate(' + (-curHead()) + 'deg)';
        }
        wrap.addEventListener('click', function (e) {
          var b = e.target.closest && e.target.closest('button'); if (!b) return;
          var act = b.getAttribute('data-act');
          try {
            if (act === '3d') map.setTilt(curTilt() < 10 ? 47.5 : 0);
            else if (act === 'rotl') map.setHeading((curHead() - 45 + 360) % 360);
            else if (act === 'rotr') map.setHeading((curHead() + 45) % 360);
            else if (act === 'north') { map.setHeading(0); map.setTilt(0); }
          } catch (err) {}
          setTimeout(sync, 80);
        });
        map.addListener('tilt_changed', sync);
        map.addListener('heading_changed', sync);
        map.controls[maps.ControlPosition.LEFT_CENTER].push(wrap);
        setTimeout(sync, 0);
      })();
    }

    var infoWindow = new maps.InfoWindow();
    var shown = { lead: true, job: true };
    var markers = [];
    var didFit = false;
    var jobIndex = {}; // jobId → { pos, marker, item } for the sidebar fly-to

    // ── Marker abstraction: AdvancedMarkerElement on the vector Job Map, classic
    // maps.Marker everywhere else. One creation/teardown/anchor path for both. ──
    function pinImg(spec) {
      if (!spec || !spec.url) return null;
      var img = document.createElement('img');
      img.src = spec.url;
      img.style.width = (spec.w || 30) + 'px';
      img.style.height = (spec.h || 42) + 'px';
      img.style.display = 'block';
      img.draggable = false;
      return img;
    }
    // o: { content (HTMLEl, adv), icon (maps icon, classic), title, onClick, zIndex }
    function makeMarker(pos, o) {
      var mk;
      if (advOK) {
        mk = new maps.marker.AdvancedMarkerElement({
          position: pos, map: map, title: o.title || '',
          content: o.content || undefined, gmpClickable: !!o.onClick
        });
        if (o.zIndex != null) mk.zIndex = o.zIndex;
        mk.__adv = true;
      } else {
        mk = new maps.Marker({ position: pos, map: map, title: o.title || '', icon: o.icon });
        if (o.zIndex != null) mk.setZIndex(o.zIndex);
        mk.__adv = false;
      }
      // AdvancedMarkerElement deprecates 'click' in favor of 'gmp-click'; classic
      // maps.Marker still uses 'click'.
      if (o.onClick) mk.addListener(mk.__adv ? 'gmp-click' : 'click', o.onClick);
      return mk;
    }
    function removeMarker(m) { if (!m) return; if (m.__adv) { m.map = null; } else { m.setMap(null); } }
    function bounceMarker(m) {
      if (!m) return;
      if (m.__adv) {
        var el = m.content; if (!el) return;
        el.classList.add('emap-pin-bounce');
        setTimeout(function () { try { el.classList.remove('emap-pin-bounce'); } catch (e) {} }, 1400);
      } else if (m.setAnimation && maps.Animation) {
        try { m.setAnimation(maps.Animation.BOUNCE); } catch (e) {}
        setTimeout(function () { try { m.setAnimation(null); } catch (e) {} }, 1400);
      }
    }

    // Extra pins mount once, outside rebuild(), so the lead/job filter
    // chips can't clear them. Tooltip-only (no card popup).
    extraPins.forEach(function (p) {
      var icon = glyphPinIcon(maps, p.glyph, p.color);
      makeMarker({ lat: p.lat, lng: p.lng }, {
        title: p.title,
        icon: icon,
        content: advOK ? pinImg({ url: icon.url, w: 30, h: 42 }) : null,
        zIndex: 5
      });
    });

    // (Re)build all markers from the currently-visible item set, grouping
    // co-located items into a single count-badged pin. Called on first
    // render and whenever a filter chip toggles.
    function rebuild() {
      // Clear prior markers off the map.
      markers.forEach(removeMarker);
      markers = [];
      for (var jk in jobIndex) { if (Object.prototype.hasOwnProperty.call(jobIndex, jk)) delete jobIndex[jk]; }

      var visible = allItems.filter(function (it) { return shown[it.kind]; });
      var groups = groupByLocation(visible);
      var bounds = new maps.LatLngBounds();

      groups.forEach(function (g) {
        var pos = { lat: g.lat, lng: g.lng };
        var marker;
        if (g.members.length === 1) {
          var item = g.members[0];
          var sIcon = iconForItem(maps, item);
          marker = makeMarker(pos, {
            title: item.title || '',
            icon: sIcon,
            content: (advOK && sIcon) ? pinImg({ url: sIcon.url, w: sIcon.scaledSize.width, h: sIcon.scaledSize.height }) : null,
            onClick: (function (it) { return function () {
              // First click = open the card ONLY (no zoom). The old behavior
              // flew the camera way in before showing detail; zooming is now a
              // deliberate action via the card's 🔍 button. All mounts share the
              // same dark entity-card popup (the Summary map previously got the
              // legacy white info window).
              if (opts.jobsSidebar) selectRow(it.id);
              if (it.kind === 'job') showJobDetail(it.id); else showLeadDetail(it);
            }; })(item)
          });
        } else {
          var gIcon = groupPinIcon(maps, g.members.length);
          marker = makeMarker(pos, {
            title: g.members.length + ' items at this property',
            icon: gIcon,
            content: advOK ? pinImg({ url: gIcon.url, w: gIcon.scaledSize.width, h: gIcon.scaledSize.height }) : null,
            onClick: (function (members) { return function () {
              // Same contract as single pins: card first, zoom only via 🔍.
              showGroupDetail(members);
            }; })(g.members)
          });
        }
        markers.push(marker);
        bounds.extend(pos);
        // Index every JOB at this location → its (group) marker, for the sidebar.
        g.members.forEach(function (m) {
          jobIndex[m.id] = { pos: pos, marker: marker, item: m }; // index all kinds (single-kind maps hold only one)
        });
      });

      // Fit only on the first paint — re-fitting on every chip toggle is
      // jarring. After that, leave the user's pan/zoom alone. Extra pins
      // count toward the fit so safety pins are in view from the start.
      extraPins.forEach(function (p) { bounds.extend({ lat: p.lat, lng: p.lng }); });
      if (!didFit) {
        didFit = true;
        if (groups.length + extraPins.length > 1) map.fitBounds(bounds, 48);
        else map.setZoom(14);
      }
    }

    rebuild();

    // ── Org Job Map: fly-to + collapsible jobs sidebar + geocode warm-up ──
    // Expose the live mount so the public flyToJob(jobId) can drive it.
    _active = { map: map, infoWindow: infoWindow, jobIndex: jobIndex, flyTo: flyTo };

    // Fly the camera to a coordinate, bounce its pin, open its info window. On the
    // vector basemap this is a true cinematic arc — center + zoom + TILT interpolated
    // together via moveCamera. On raster it falls back to pan + a stepped zoom-in.
    function flyTo(pos, marker, item) {
      if (!map || !pos) return;
      if (!advOK || !map.moveCamera) {
        map.panTo(pos);
        var z = map.getZoom() || 11;
        if (z < 17) {
          var steps = []; [Math.max(z, 14), 16, 18].forEach(function (s) { if (steps.indexOf(s) < 0) steps.push(s); });
          var k = 0;
          (function step() {
            if (k >= steps.length) return;
            map.setZoom(steps[k++]);
            setTimeout(step, 200);
          })();
        }
      } else {
        var c = map.getCenter();
        var sLat = c ? c.lat() : pos.lat, sLng = c ? c.lng() : pos.lng;
        var sZoom = map.getZoom() || 11, eZoom = 18;
        var sTilt = (map.getTilt && map.getTilt()) || 0, eTilt = 55;
        var sHead = (map.getHeading && map.getHeading()) || 0;
        var t0 = null, DUR = 850;
        var frame = function (ts) {
          if (t0 == null) t0 = ts;
          var kk = Math.min(1, (ts - t0) / DUR);
          var ee = 1 - Math.pow(1 - kk, 3); // ease-out cubic
          try {
            map.moveCamera({
              center: { lat: sLat + (pos.lat - sLat) * ee, lng: sLng + (pos.lng - sLng) * ee },
              zoom: sZoom + (eZoom - sZoom) * ee,
              tilt: sTilt + (eTilt - sTilt) * ee,
              heading: sHead
            });
          } catch (err) { map.setCenter(pos); map.setZoom(eZoom); return; }
          if (kk < 1) requestAnimationFrame(frame);
        };
        if (typeof requestAnimationFrame === 'function') requestAnimationFrame(frame);
        else { try { map.moveCamera({ center: pos, zoom: eZoom, tilt: eTilt, heading: sHead }); } catch (e) {} }
      }
      bounceMarker(marker);
      // No info window here — the Job Map shows the detail in the docked panel
      // (the caller calls showJobDetail/showGroupDetail). flyTo is camera-only.
    }
    function flyToById(id) { var e = jobIndex[id]; if (e) flyTo(e.pos, e.marker, e.item); }

    // ── Docked detail panel (under the jobs list) — replaces the floating info
    // window, so there are no off-center popup scrollbars. Job → pulse card,
    // lead → compact card, shared address → property list. ──
    // Exact dollars on the map cards — no $9.3k rounding.
    function money(n) {
      n = Number(n) || 0;
      return (n < 0 ? '-' : '') + '$' + Math.abs(n).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    // ── On-map popup over the pin (the right sidebar stays the jobs list). A dark
    // bubble anchored above the marker via OverlayView — fixed width + vertical-only
    // scroll, so there are no off-center popup scrollbars. Reuses the shared
    // p86EntityCard markup + its data-act protocol. ──
    var _popup = null, _PopupClass = null;
    function ensurePopupClass() {
      if (_PopupClass || !maps.OverlayView) return _PopupClass;
      function Popup(latlng, contentEl) {
        this.position = latlng;
        var bubble = document.createElement('div'); bubble.className = 'emap-pop-bubble'; bubble.appendChild(contentEl);
        var container = document.createElement('div'); container.className = 'emap-pop'; container.appendChild(bubble);
        if (maps.OverlayView.preventMapHitsAndGesturesFrom) maps.OverlayView.preventMapHitsAndGesturesFrom(container);
        this.container = container;
      }
      Popup.prototype = Object.create(maps.OverlayView.prototype);
      Popup.prototype.onAdd = function () { var p = this.getPanes(); if (p) p.floatPane.appendChild(this.container); };
      Popup.prototype.onRemove = function () { if (this.container.parentNode) this.container.parentNode.removeChild(this.container); };
      Popup.prototype.draw = function () {
        var proj = this.getProjection(); if (!proj) return;
        var d = proj.fromLatLngToDivPixel(this.position); if (!d) return;
        this.container.style.left = d.x + 'px'; this.container.style.top = d.y + 'px';
        // Pan-into-view must wait for the FIRST real draw — before this the
        // container sits at the float-pane origin, which can measure as
        // "already visible" and make an earlier check a silent no-op.
        if (!this._panned) {
          this._panned = true;
          var self = this;
          setTimeout(function () { if (_popup === self) panPopupIntoView(); }, 80);
        }
      };
      _PopupClass = Popup; return _PopupClass;
    }
    function closePopup() { if (_popup) { try { _popup.setMap(null); } catch (e) {} _popup = null; } }
    // The legacy InfoWindow auto-panned the map so the bubble fit on screen;
    // the custom OverlayView doesn't, so a pin near the top of the viewport
    // opened a card with its head (title/status/zoom) clipped. Pan to fit.
    function panPopupIntoView(attempt) {
      if (!_popup || !_popup.container) return;
      attempt = attempt || 0;
      try {
        var bubble = _popup.container.querySelector('.emap-pop-bubble') || _popup.container;
        var br = bubble.getBoundingClientRect();
        // The OverlayView attaches + draws on the map's next render frame, so
        // the bubble can still be unmeasured here — retry until it has layout.
        if (!br.width) { if (attempt < 12) setTimeout(function () { panPopupIntoView(attempt + 1); }, 120); return; }
        var mr = map.getDiv().getBoundingClientRect();
        var pad = 10, dx = 0, dy = 0;
        if (br.right > mr.right - pad) dx = br.right - (mr.right - pad);
        if (br.left < mr.left + pad) dx = br.left - (mr.left + pad);
        if (br.top < mr.top + pad) dy = br.top - (mr.top + pad);
        if (dx || dy) map.panBy(dx, dy);
      } catch (e) {}
    }
    function popupAction(ev) {
      var t = ev.target, go = function (sel) { return t.closest ? t.closest(sel) : null; };
      if (go('.emap-pop-x')) { closePopup(); return; }
      var actEl = go('[data-act]');
      if (actEl) {
        var act = actEl.getAttribute('data-act');
        var card = go('.p86-ecard'); var kind = card ? card.getAttribute('data-kind') : '';
        var id = actEl.getAttribute('data-id');
        if (act === 'maps') { var la = actEl.getAttribute('data-lat'), ln = actEl.getAttribute('data-lng'); if (la && ln) window.open('https://www.google.com/maps/search/?api=1&query=' + la + ',' + ln, '_blank'); return; }
        // 🔍 — the deliberate zoom. Pin clicks no longer fly the camera in;
        // this button does (cinematic on the vector map, stepped on raster).
        if (act === 'zoom') { var zla = actEl.getAttribute('data-lat'), zln = actEl.getAttribute('data-lng'); if (zla && zln) flyTo({ lat: Number(zla), lng: Number(zln) }); return; }
        if (act === 'open' || act === 'info') { closePopup(); if (kind === 'job') { if (typeof _onJobHook === 'function') _onJobHook(id); else openEntity('job', id); } else { openEntity(kind || 'lead', id); } return; }
        if (act === 'msg') { if (window.p86Messaging && typeof window.p86Messaging.openInbox === 'function') window.p86Messaging.openInbox(); return; }
        return;
      }
      var grp = go('.emap-grp-row'); if (grp) { closePopup(); openEntity(grp.getAttribute('data-kind'), grp.getAttribute('data-id')); return; }
    }
    function openPopup(pos, html) {
      closePopup();
      if (!pos || !isFinite(Number(pos.lat)) || !isFinite(Number(pos.lng))) return;
      var content = document.createElement('div'); content.className = 'emap-pop-inner';
      content.innerHTML = '<button type="button" class="emap-pop-x" aria-label="Close">×</button>' + (html || '');
      content.addEventListener('click', popupAction);
      var P = ensurePopupClass();
      if (P) { _popup = new P(new maps.LatLng(Number(pos.lat), Number(pos.lng)), content); _popup.setMap(map); }
      else { infoWindow.setContent(content); infoWindow.setPosition(new maps.LatLng(Number(pos.lat), Number(pos.lng))); infoWindow.open(map); }
    }
    function selectRow(id) {
      var prev = host.querySelector('.emap-job-row.sel'); if (prev) prev.classList.remove('sel');
      var rows = host.querySelectorAll('.emap-job-row');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-job-id') === id) { rows[i].classList.add('sel'); rows[i].scrollIntoView({ block: 'nearest' }); break; }
      }
    }
    function showJobDetail(id) {
      var e = jobIndex[id], it = e ? e.item : null; if (!it) return;
      var w = (window.getJobWIP ? window.getJobWIP(id) : null) || {};
      var pct = Math.max(0, Math.min(100, Number(w.pctComplete) || 0));
      var contract = (w.totalIncome != null) ? w.totalIncome : (w.contractIncome || 0);
      var profit = (w.displayProfit != null) ? w.displayProfit : 0;
      if (!window.p86EntityCard) {
        openPopup(e.pos, '<div class="emap-jc"><div class="emap-jc-meta"><div class="emap-jc-name">' + escapeHTML(it.title || '(untitled)') + '</div></div></div>');
        return;
      }
      var jobObj = null, jl = (window.appData && window.appData.jobs) || [];
      for (var ji = 0; ji < jl.length; ji++) { if (jl[ji].id === id) { jobObj = jl[ji]; break; } }
      var statusCol = window.p86EntityCard.jobStatusColor(it.status);
      var accentCol = window.p86EntityCard.pinColor(jobObj || it, 'job') || statusCol;
      openPopup(e.pos, window.p86EntityCard.render({
        kind: 'job', accent: accentCol, status: { label: it.status || 'In Progress', color: statusCol },
        number: (jobObj && (jobObj.jobNumber || jobObj.job_number)) || '',
        title: it.title || '(untitled)',
        subtitle: (jobObj && (jobObj.client || jobObj.client_name)) || '',
        address: it.address || '',
        ring: { pct: pct },
        stats: [
          { label: 'Contract', value: money(contract) },
          { label: 'Profit', value: (profit < 0 ? '-' : '+') + money(Math.abs(profit)), tone: profit < 0 ? 'neg' : 'pos' }
        ],
        icons: [ { act: 'info', title: 'Open job' }, { act: 'maps', title: 'Maps' } ],
        actions: [ { label: 'Open WIP', act: 'open', primary: true, icon: 'arrow-right' }, { label: '🔍', act: 'zoom' }, { label: 'Maps', act: 'maps' } ],
        data: { id: id, lat: it.lat, lng: it.lng }
      }));
    }
    function showLeadDetail(it) {
      if (!it) return;
      if (!window.p86EntityCard) {
        openPopup({ lat: it.lat, lng: it.lng }, '<div class="emap-jc"><div class="emap-jc-name">' + escapeHTML(it.title || '(untitled)') + '</div></div>');
        return;
      }
      var statusCol = window.p86EntityCard.leadStatusColor(it.status);
      var accentCol = window.p86EntityCard.pinColor(it, 'lead') || '#4f8cff';
      // Value = highest attached-estimate clientPrice; age = days since created.
      var leadObj = null, ll = (window.appData && window.appData.leads) || [];
      for (var li = 0; li < ll.length; li++) { if (ll[li].id === it.id) { leadObj = ll[li]; break; } }
      var val = null;
      try {
        var ests = (window.appData && window.appData.estimates) || [];
        for (var ei = 0; ei < ests.length; ei++) {
          if (ests[ei] && ests[ei].lead_id === it.id && typeof window.computeEstimateTotals === 'function') {
            var p = (window.computeEstimateTotals(ests[ei]) || {}).clientPrice;
            if (p != null && !isNaN(p) && (val == null || p > val)) val = p;
          }
        }
      } catch (e) { /* estimates not loaded */ }
      var ageDays = (leadObj && leadObj.created_at) ? Math.max(0, Math.round((Date.now() - new Date(leadObj.created_at).getTime()) / 86400000)) : null;
      var leadStats = [ { label: 'Est. value', value: (val != null ? money(val) : '—') } ];
      if (ageDays != null) leadStats.push({ label: 'Age', value: ageDays + 'd' });
      openPopup({ lat: it.lat, lng: it.lng }, window.p86EntityCard.render({
        kind: 'lead', accent: accentCol, status: { label: it.status || 'Open', color: statusCol },
        title: it.title || '(untitled)',
        subtitle: it.client || (leadObj && (leadObj.client_name || leadObj.property_name)) || '',
        address: it.address || '',
        ring: (leadObj && Number(leadObj.confidence) > 0 ? { pct: Number(leadObj.confidence) } : undefined),
        stats: leadStats,
        icons: [ { act: 'info', title: 'Open lead' }, { act: 'maps', title: 'Maps' } ],
        actions: [ { label: 'Open lead', act: 'open', primary: true, icon: 'arrow-right' }, { label: '🔍', act: 'zoom' }, { label: 'Maps', act: 'maps' } ],
        data: { id: it.id, lat: it.lat, lng: it.lng }
      }));
    }
    function showGroupDetail(members) {
      var addr = ''; for (var i = 0; i < members.length; i++) { if (members[i].address) { addr = members[i].address; break; } }
      var rows = members.map(function (m) {
        return '<div class="emap-grp-row" data-kind="' + escapeAttr(m.kind) + '" data-id="' + escapeAttr(m.id) + '">' +
          '<span class="emap-kind ' + (m.kind === 'job' ? 'emap-kind-job' : '') + '">' + (m.kind === 'lead' ? 'Lead' : 'Job') + '</span>' +
          '<span class="emap-grp-name">' + escapeHTML(m.title || '(untitled)') + '</span>' +
          '<span class="emap-chev">›</span></div>';
      }).join('');
      var gp = members[0] ? { lat: members[0].lat, lng: members[0].lng } : null;
      var zoomBtn = gp
        ? '<button type="button" data-act="zoom" data-lat="' + gp.lat + '" data-lng="' + gp.lng + '" title="Zoom to property" ' +
            'style="background:none;border:1px solid rgba(255,255,255,.18);border-radius:7px;color:#aeb6c5;font-size:12px;padding:2px 7px;cursor:pointer;margin-left:8px;">🔍</button>'
        : '';
      openPopup(gp,
        '<div class="emap-grp"><div class="emap-grp-head">' + members.length + ' at this property' + zoomBtn + '</div>' +
          (addr ? '<div class="emap-grp-addr">' + escapeHTML(addr) + '</div>' : '') +
          '<div class="emap-grp-list">' + rows + '</div></div>'
      );
    }

    // The dark popup + entity-card styles were only injected with the jobs
    // sidebar; every mount uses the card popup now (Summary map included).
    injectJobsSidebarStyle();
    if (opts.jobsSidebar) buildJobsSidebar();
    if (opts.warmGeocode) warmGeocodeJobs();

    // Collapsible right-hand jobs list (mapped jobs). Click a row → fly to its
    // pin + select; "Open WIP" → the job's drill hook (Site Plan).
    function buildJobsSidebar() {
      injectJobsSidebarStyle();
      var isLead = (opts.only === 'lead');
      var headLabel = isLead ? 'Leads' : 'Jobs';
      var openLabel = isLead ? 'Open lead →' : 'Open WIP →';
      var rows = (isLead ? data.leads : data.jobs).slice().sort(function (a, b) {
        return String(a.title || '').localeCompare(String(b.title || ''));
      });
      var byId = {}; rows.forEach(function (r) { byId[r.id] = r; });
      var panel = document.createElement('div');
      panel.className = 'emap-jobs-panel';
      panel.innerHTML =
        '<div class="emap-jobs-head"><span class="emap-jobs-title">' + headLabel + ' <b>' + rows.length + '</b></span>' +
          '<button type="button" class="emap-jobs-collapse" title="Collapse">››</button></div>' +
        '<input type="text" class="emap-jobs-search" placeholder="Search ' + headLabel.toLowerCase() + '…">' +
        '<div class="emap-jobs-list"></div>';
      host.appendChild(panel);
      var expandTab = document.createElement('button');
      expandTab.type = 'button';
      expandTab.className = 'emap-jobs-expand';
      expandTab.innerHTML = '‹‹ ' + headLabel;
      expandTab.style.display = 'none';
      host.appendChild(expandTab);

      var listEl = panel.querySelector('.emap-jobs-list');
      function rowHTML(j) {
        return '<div class="emap-job-row" data-job-id="' + escapeAttr(j.id) + '">' +
          '<div class="emap-job-main"><span class="emap-job-name">' + escapeHTML(j.title || '(untitled)') + '</span>' +
            (j.status ? '<span class="emap-job-status">' + escapeHTML(String(j.status).replace(/_/g, ' ')) + '</span>' : '') + '</div>' +
          (j.address ? '<div class="emap-job-addr">' + escapeHTML(j.address) + '</div>' : '') +
          '<button type="button" class="emap-job-wip">' + openLabel + '</button>' +
        '</div>';
      }
      function paint(filter) {
        var f = String(filter || '').toLowerCase().trim();
        var shown = !f ? rows : rows.filter(function (j) {
          return ((j.title || '') + ' ' + (j.address || '')).toLowerCase().indexOf(f) >= 0;
        });
        listEl.innerHTML = shown.length ? shown.map(rowHTML).join('') : '<div class="emap-jobs-empty">No matching ' + headLabel.toLowerCase() + '</div>';
      }
      paint('');
      panel.querySelector('.emap-jobs-search').addEventListener('input', function () { paint(this.value); });
      panel.querySelector('.emap-jobs-collapse').addEventListener('click', function () {
        panel.classList.add('emap-collapsed'); expandTab.style.display = '';
      });
      expandTab.addEventListener('click', function () {
        panel.classList.remove('emap-collapsed'); expandTab.style.display = 'none';
      });
      listEl.addEventListener('click', function (ev) {
        var row = ev.target.closest ? ev.target.closest('.emap-job-row') : null;
        if (!row) return;
        var id = row.getAttribute('data-job-id');
        if (ev.target.closest('.emap-job-wip')) {
          if (isLead) openEntity('lead', id);
          else if (typeof _onJobHook === 'function') _onJobHook(id);
          else openEntity('job', id);
          return;
        }
        var prev = listEl.querySelector('.emap-job-row.sel'); if (prev) prev.classList.remove('sel');
        row.classList.add('sel');
        flyToById(id);
        if (isLead) { if (byId[id]) showLeadDetail(byId[id]); }
        else showJobDetail(id);
      });

      // Clicking empty map closes the on-map popup.
      if (map && map.addListener) map.addListener('click', closePopup);
    }

    // Phase 0 warm-up: geocode jobs that have no coordinates yet — the weather
    // lookup geocodes + persists server-side — throttled, then re-render ONCE so
    // their pins + rows appear. The re-render passes warmGeocode:false to avoid a
    // loop; jobs with no resolvable address simply stay unlisted.
    function warmGeocodeJobs() {
      var all = (window.appData && window.appData.jobs) || [];
      var mapped = {};
      data.jobs.forEach(function (j) { mapped[j.id] = 1; });
      var missing = all.filter(function (j) {
        return !mapped[j.id] && !usableCoords(j.geocode_lat, j.geocode_lng);
      }).map(function (j) { return j.id; });
      if (!missing.length || !(window.p86Api && p86Api.weather && typeof p86Api.weather.jobs === 'function')) return;
      var note = document.createElement('div');
      note.className = 'emap-geocode-note';
      note.textContent = 'Locating ' + missing.length + ' job' + (missing.length === 1 ? '' : 's') + '…';
      host.appendChild(note);
      var CHUNK = 6, i = 0;
      function next() {
        if (i >= missing.length) {
          try { note.remove(); } catch (e) {}
          closePopup();
          render(host, assignOpts(opts, { warmGeocode: false }));
          return;
        }
        var batch = missing.slice(i, i + CHUNK); i += CHUNK;
        note.textContent = 'Locating jobs… ' + Math.min(i, missing.length) + '/' + missing.length;
        p86Api.weather.jobs(batch).then(function () {}, function () {}).then(function () { setTimeout(next, 350); });
      }
      next();
    }

    // ── Filter chips ────────────────────────────────────────────────
    host.querySelectorAll('[data-emap-chip]').forEach(function (chip) {
      chip.addEventListener('click', function () {
        var kind = chip.getAttribute('data-emap-chip');
        shown[kind] = !shown[kind];
        var onColor = kind === 'lead' ? '#4f8cff' : '#94a3b8';
        if (shown[kind]) {
          chip.style.background = onColor; chip.style.color = '#fff'; chip.style.borderColor = onColor;
        } else {
          chip.style.background = 'transparent'; chip.style.color = onColor; chip.style.borderColor = onColor;
        }
        infoWindow.close();
        rebuild();
      });
    });

    // ── "You are here" — best-effort geolocation. Degrades gracefully:
    // denied / unsupported / null → no marker, no button, pins stay.
    if (window.p86Geo && typeof window.p86Geo.get === 'function') {
      var youMarker = null;
      var youPos = null;
      function placeYou(g) {
        if (!g || !isFinite(Number(g.lat)) || !isFinite(Number(g.lng))) return;
        youPos = { lat: Number(g.lat), lng: Number(g.lng) };
        var youUrl = 'data:image/svg+xml;utf8,' + encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
          '<circle cx="11" cy="11" r="7" fill="#1a73e8" stroke="#fff" stroke-width="3"/>' +
          '<circle cx="11" cy="11" r="10" fill="#1a73e8" fill-opacity="0.18"/></svg>');
        var youContent = null;
        if (advOK) {
          youContent = pinImg({ url: youUrl, w: 22, h: 22 });
          // AdvancedMarkerElement anchors content bottom-center; shift down so the dot
          // sits centered on the point (it's a position dot, not a pin).
          youContent.style.transform = 'translateY(50%)';
        }
        youMarker = makeMarker(youPos, {
          title: 'You are here',
          icon: { url: youUrl, anchor: new maps.Point(11, 11), scaledSize: new maps.Size(22, 22) },
          content: youContent,
          zIndex: 9999
        });
        if (recenterBtn) {
          recenterBtn.style.display = '';
          recenterBtn.addEventListener('click', function () {
            if (youPos) { map.panTo(youPos); if (map.getZoom() < 13) map.setZoom(14); }
          });
        }
      }
      window.p86Geo.get(120000).then(placeYou).catch(function () { /* silent */ });
    }
  }

  window.p86EntitiesMap = { render: render, flyToJob: flyToJob };
})();
