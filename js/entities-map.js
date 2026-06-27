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
    if (kind === 'lead') {
      if (typeof window.openEditLeadModal === 'function') { window.openEditLeadModal(id); return; }
    } else if (kind === 'job') {
      if (typeof _onJobHook === 'function') { _onJobHook(id); return; }
      if (typeof window.editJob === 'function') { window.editJob(id); return; }
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
      '.emap-pin-bounce{animation:emap-pin-bounce .7s ease-in-out 2;transform-origin:bottom center}';
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

  // Small kind tag (matches the filter-chip colors).
  function kindTag(kind) {
    var c = kind === 'lead' ? '#4f8cff' : '#94a3b8';
    var label = kind === 'lead' ? 'LEAD' : 'JOB';
    return '<span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.4px;' +
      'color:#fff;background:' + c + ';border-radius:4px;padding:1px 5px;flex-shrink:0;">' + label + '</span>';
  }

  // Status chip — lead-pipeline colors come from the SHARED encoding
  // (js/map-pins.js → p86MapStatus) so a status reads identically here and on
  // the per-entity maps. Jobs get a neutral slate chip with their raw label.
  function statusChip(kind, status) {
    if (!status) return '';
    var color = '#64748b', label = String(status).slice(0, 24).replace(/_/g, ' ');
    if (kind === 'lead' && window.p86MapStatus && window.p86MapStatus.pipeline) {
      var pl = window.p86MapStatus.pipeline(status);
      if (pl) { color = pl.color; label = pl.label; }
    }
    return '<span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.3px;' +
      'color:#fff;background:' + color + ';border-radius:4px;padding:1px 6px;text-transform:capitalize;flex-shrink:0;">' +
      escapeHTML(label) + '</span>';
  }
  // Compact "Open" pill used in BOTH the single window and the group rows so
  // the affordance reads consistently. inline=true drops the top margin for
  // use inside a flex row.
  function openBtn(kind, id, label, inline) {
    return '<a href="#" style="display:inline-block;font-size:11px;color:#fff;background:#0a66c2;' +
      'text-decoration:none;font-weight:600;border-radius:6px;padding:4px 10px;flex-shrink:0;' +
      (inline ? '' : 'margin-top:8px;') + '" ' +
      'onclick="event.preventDefault();window.__p86EntitiesMapOpen&&window.__p86EntitiesMapOpen(\'' +
        escapeAttr(kind) + '\',\'' + escapeAttr(id) + '\');">' + (label || 'Open') + ' &rarr;</a>';
  }

  // Info window for a SINGLE entity.
  function infoContentHTML(item) {
    var addr = item.address || '';
    return '<div style="min-width:200px;max-width:280px;font-family:system-ui,sans-serif;">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
        kindTag(item.kind) + statusChip(item.kind, item.status) +
      '</div>' +
      '<div style="font-size:14px;font-weight:600;color:#111;line-height:1.3;">' + escapeHTML(item.title || '(untitled)') + '</div>' +
      (addr ? '<div style="font-size:11px;color:#555;margin-top:3px;">' + escapeHTML(addr) + '</div>' : '') +
      openBtn(item.kind, item.id, 'Open', false) +
      mapsLinkRow(item) +
    '</div>';
  }

  // "Open in Google Maps" row for an info window. Prefers the pin's exact
  // coords (always present) and falls back to the entity address label.
  function mapsLinkRow(item) {
    if (!item || !window.p86MapLink || !window.p86MapLink.linkHTML) return '';
    var link = window.p86MapLink.linkHTML('Open in Google Maps', item.address || '',
      { lat: Number(item.lat), lng: Number(item.lng),
        style: 'display:inline-block;margin-top:6px;font-size:12px;color:#0a66c2;text-decoration:none;font-weight:600;' });
    return link ? '<div>' + link + '</div>' : '';
  }

  // Info window for a GROUP of co-located entities — one row per item. The
  // shared property address (first member with one) heads the list.
  function groupContentHTML(members) {
    var addr = '';
    for (var i = 0; i < members.length; i++) { if (members[i].address) { addr = members[i].address; break; } }
    var rows = members.map(function (m) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #eee;">' +
        kindTag(m.kind) +
        '<span style="flex:1;font-size:13px;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          escapeHTML(m.title || '(untitled)') + '</span>' +
        statusChip(m.kind, m.status) +
        openBtn(m.kind, m.id, 'Open', true) +
      '</div>';
    }).join('');
    return '<div style="min-width:240px;max-width:320px;font-family:system-ui,sans-serif;">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#4f46e5;margin-bottom:2px;">' +
        members.length + ' items at this property</div>' +
      (addr ? '<div style="font-size:11px;color:#555;margin-bottom:4px;">' + escapeHTML(addr) + '</div>' : '') +
      // One "Open in Google Maps" link for the shared coordinate (grouped
      // pins are all at the same lat/lng), so rows stay clean.
      (members[0] ? mapsLinkRow(members[0]) : '') +
      rows +
    '</div>';
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
    var allItems = data.leads.concat(data.jobs);
    var total = allItems.length;

    if (!total) {
      host.innerHTML = emptyHTML('No leads or jobs with mapped addresses yet. Save an address on a lead or job to plot it here.');
      return;
    }

    // Chrome: filter chips + map canvas + recenter button. Canvas fills
    // the relative host via absolute inset so it always has a definite
    // box for the Maps SDK to measure.
    host.innerHTML =
      '<div style="position:absolute;top:10px;left:10px;z-index:5;display:flex;gap:6px;">' +
        '<button type="button" data-emap-chip="lead" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #4f8cff;background:#4f8cff;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Leads ' + data.leads.length + '</button>' +
        '<button type="button" data-emap-chip="job" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #94a3b8;background:#94a3b8;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Jobs ' + data.jobs.length + '</button>' +
      '</div>' +
      '<button type="button" data-emap-recenter ' +
        'style="position:absolute;bottom:24px;right:10px;z-index:5;display:none;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid var(--border,#333);background:#fff;color:#111;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.3);">\u{1F4CD} You</button>' +
      '<div data-emap-canvas style="position:absolute;inset:0;"></div>';

    var canvas = host.querySelector('[data-emap-canvas]');
    var recenterBtn = host.querySelector('[data-emap-recenter]');

    // Wire the open-entity dispatcher (info-window anchors call it).
    window.__p86EntitiesMapOpen = openEntity;

    var mapOpts = {
      center: { lat: allItems[0].lat, lng: allItems[0].lng },
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
      if (o.onClick) mk.addListener('click', o.onClick);
      return mk;
    }
    function removeMarker(m) { if (!m) return; if (m.__adv) { m.map = null; } else { m.setMap(null); } }
    function openInfo(content, m) {
      infoWindow.setContent(content);
      if (m && m.__adv) infoWindow.open({ anchor: m, map: map });
      else infoWindow.open(map, m);
    }
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
            onClick: (function (it) { return function () { openInfo(infoContentHTML(it), marker); }; })(item)
          });
        } else {
          var gIcon = groupPinIcon(maps, g.members.length);
          marker = makeMarker(pos, {
            title: g.members.length + ' items at this property',
            icon: gIcon,
            content: advOK ? pinImg({ url: gIcon.url, w: gIcon.scaledSize.width, h: gIcon.scaledSize.height }) : null,
            onClick: (function (members) { return function () { openInfo(groupContentHTML(members), marker); }; })(g.members)
          });
        }
        markers.push(marker);
        bounds.extend(pos);
        // Index every JOB at this location → its (group) marker, for the sidebar.
        g.members.forEach(function (m) {
          if (m.kind === 'job') jobIndex[m.id] = { pos: pos, marker: marker, item: m };
        });
      });

      // Fit only on the first paint — re-fitting on every chip toggle is
      // jarring. After that, leave the user's pan/zoom alone.
      if (!didFit) {
        didFit = true;
        if (groups.length > 1) map.fitBounds(bounds, 48);
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
      if (item) openInfo(infoContentHTML(item), marker);
    }
    function flyToById(id) { var e = jobIndex[id]; if (e) flyTo(e.pos, e.marker, e.item); }

    if (opts.jobsSidebar) buildJobsSidebar();
    if (opts.warmGeocode) warmGeocodeJobs();

    // Collapsible right-hand jobs list (mapped jobs). Click a row → fly to its
    // pin + select; "Open WIP" → the job's drill hook (Site Plan).
    function buildJobsSidebar() {
      injectJobsSidebarStyle();
      var jobs = data.jobs.slice().sort(function (a, b) {
        return String(a.title || '').localeCompare(String(b.title || ''));
      });
      var panel = document.createElement('div');
      panel.className = 'emap-jobs-panel';
      panel.innerHTML =
        '<div class="emap-jobs-head"><span class="emap-jobs-title">Jobs <b>' + jobs.length + '</b></span>' +
          '<button type="button" class="emap-jobs-collapse" title="Collapse">››</button></div>' +
        '<input type="text" class="emap-jobs-search" placeholder="Search jobs…">' +
        '<div class="emap-jobs-list"></div>';
      host.appendChild(panel);
      var expandTab = document.createElement('button');
      expandTab.type = 'button';
      expandTab.className = 'emap-jobs-expand';
      expandTab.innerHTML = '‹‹ Jobs';
      expandTab.style.display = 'none';
      host.appendChild(expandTab);

      var listEl = panel.querySelector('.emap-jobs-list');
      function rowHTML(j) {
        return '<div class="emap-job-row" data-job-id="' + escapeAttr(j.id) + '">' +
          '<div class="emap-job-main"><span class="emap-job-name">' + escapeHTML(j.title || '(untitled)') + '</span>' +
            (j.status ? '<span class="emap-job-status">' + escapeHTML(String(j.status).replace(/_/g, ' ')) + '</span>' : '') + '</div>' +
          (j.address ? '<div class="emap-job-addr">' + escapeHTML(j.address) + '</div>' : '') +
          '<button type="button" class="emap-job-wip">Open WIP →</button>' +
        '</div>';
      }
      function paint(filter) {
        var f = String(filter || '').toLowerCase().trim();
        var shown = !f ? jobs : jobs.filter(function (j) {
          return ((j.title || '') + ' ' + (j.address || '')).toLowerCase().indexOf(f) >= 0;
        });
        listEl.innerHTML = shown.length ? shown.map(rowHTML).join('') : '<div class="emap-jobs-empty">No matching jobs</div>';
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
          if (typeof _onJobHook === 'function') _onJobHook(id); else openEntity('job', id);
          return;
        }
        var prev = listEl.querySelector('.emap-job-row.sel'); if (prev) prev.classList.remove('sel');
        row.classList.add('sel');
        flyToById(id);
      });
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
