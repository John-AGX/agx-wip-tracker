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
  function openEntity(kind, id) {
    if (kind === 'lead') {
      if (typeof window.openEditLeadModal === 'function') { window.openEditLeadModal(id); return; }
    } else if (kind === 'job') {
      if (typeof window.editJob === 'function') { window.editJob(id); return; }
    }
    // Last resort — no-op rather than throwing.
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

  // Lead pipeline status → chip color. Jobs get a neutral slate chip with
  // their raw (capped) status label. Returns '' when there is no status.
  var LEAD_STATUS_COLORS = {
    'new': '#3b82f6', 'in_progress': '#06b6d4', 'sent': '#a855f7',
    'sold': '#22c55e', 'lost': '#ef4444', 'no_opportunity': '#64748b'
  };
  function statusChip(kind, status) {
    if (!status) return '';
    var s = String(status).slice(0, 24);
    var color = (kind === 'lead') ? (LEAD_STATUS_COLORS[s] || '#64748b') : '#64748b';
    var label = s.replace(/_/g, ' ');
    return '<span style="display:inline-block;font-size:9px;font-weight:700;letter-spacing:0.3px;' +
      'color:#fff;background:' + color + ';border-radius:4px;padding:1px 6px;text-transform:capitalize;flex-shrink:0;">' +
      escapeHTML(label) + '</span>';
  }
  function openBtn(kind, id, label) {
    return '<a href="#" style="display:inline-block;font-size:12px;color:#fff;background:#0a66c2;' +
      'text-decoration:none;font-weight:600;border-radius:6px;padding:5px 12px;margin-top:8px;" ' +
      'onclick="event.preventDefault();window.__p86EntitiesMapOpen&&window.__p86EntitiesMapOpen(\'' +
        escapeAttr(kind) + '\',\'' + escapeAttr(id) + '\');">' + (label || 'Open') + ' &rarr;</a>';
  }

  // Info window for a SINGLE entity.
  function infoContentHTML(item) {
    return '<div style="min-width:200px;max-width:280px;font-family:system-ui,sans-serif;">' +
      '<div style="display:flex;align-items:center;gap:6px;margin-bottom:6px;">' +
        kindTag(item.kind) + statusChip(item.kind, item.status) +
      '</div>' +
      '<div style="font-size:14px;font-weight:600;color:#111;line-height:1.3;">' + escapeHTML(item.title || '(untitled)') + '</div>' +
      openBtn(item.kind, item.id, 'Open') +
    '</div>';
  }

  // Info window for a GROUP of co-located entities — one row per item.
  function groupContentHTML(members) {
    var rows = members.map(function (m) {
      return '<div style="display:flex;align-items:center;gap:8px;padding:8px 0;border-top:1px solid #eee;">' +
        kindTag(m.kind) +
        '<span style="flex:1;font-size:13px;color:#111;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          escapeHTML(m.title || '(untitled)') + '</span>' +
        statusChip(m.kind, m.status) +
        '<a href="#" style="font-size:12px;color:#0a66c2;text-decoration:none;font-weight:600;flex-shrink:0;" ' +
          'onclick="event.preventDefault();window.__p86EntitiesMapOpen&&window.__p86EntitiesMapOpen(\'' +
            escapeAttr(m.kind) + '\',\'' + escapeAttr(m.id) + '\');">Open &rarr;</a>' +
      '</div>';
    }).join('');
    return '<div style="min-width:240px;max-width:320px;font-family:system-ui,sans-serif;">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#4f46e5;margin-bottom:2px;">' +
        members.length + ' items at this property</div>' +
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
      mount(maps, host, normalizeData(data));
    }).catch(function (err) {
      host.innerHTML = emptyHTML('Map unavailable: ' + (err && err.message || 'unknown error'));
    });
  }

  // Fallback: build {leads, jobs} from the already-loaded window.appData
  // when the endpoint is unreachable. Reads the same geocode_lat/lng the
  // server reads. Only used if /api/map/entities fails.
  function assembleFromAppData() {
    var d = window.appData || {};
    var leads = (d.leads || []).map(function (l) {
      return { id: l.id, title: l.title || 'Untitled lead',
        lat: l.geocode_lat, lng: l.geocode_lng, kind: 'lead', status: l.status || '' };
    });
    var jobs = (d.jobs || []).map(function (j) {
      var num = j.jobNumber || j.job_number || '';
      var name = j.title || j.name || 'Untitled job';
      var jstatus = (j.data && typeof j.data.status === 'string') ? j.data.status : (j.status || '');
      return { id: j.id, title: num ? (num + ' — ' + name) : name,
        lat: j.geocode_lat, lng: j.geocode_lng, kind: 'job', jobNumber: num, status: jstatus };
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
          kind: kind, jobNumber: it.jobNumber || '', status: it.status || '' };
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

  function mount(maps, host, data) {
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

    var map = new maps.Map(canvas, {
      center: { lat: allItems[0].lat, lng: allItems[0].lng },
      zoom: 11,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
      mapTypeId: maps.MapTypeId.ROADMAP
    });

    var infoWindow = new maps.InfoWindow();
    var shown = { lead: true, job: true };
    var markers = [];
    var didFit = false;

    // (Re)build all markers from the currently-visible item set, grouping
    // co-located items into a single count-badged pin. Called on first
    // render and whenever a filter chip toggles.
    function rebuild() {
      // Clear prior markers off the map.
      markers.forEach(function (m) { m.setMap(null); });
      markers = [];

      var visible = allItems.filter(function (it) { return shown[it.kind]; });
      var groups = groupByLocation(visible);
      var bounds = new maps.LatLngBounds();

      groups.forEach(function (g) {
        var pos = { lat: g.lat, lng: g.lng };
        var marker;
        if (g.members.length === 1) {
          var item = g.members[0];
          marker = new maps.Marker({ position: pos, title: item.title || '', icon: iconForItem(maps, item), map: map });
          marker.addListener('click', (function (it) {
            return function () { infoWindow.setContent(infoContentHTML(it)); infoWindow.open(map, marker); };
          })(item));
        } else {
          marker = new maps.Marker({
            position: pos,
            title: g.members.length + ' items at this property',
            icon: groupPinIcon(maps, g.members.length),
            map: map
          });
          marker.addListener('click', (function (members) {
            return function () { infoWindow.setContent(groupContentHTML(members)); infoWindow.open(map, marker); };
          })(g.members));
        }
        markers.push(marker);
        bounds.extend(pos);
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
        var youIcon = {
          url: 'data:image/svg+xml;utf8,' + encodeURIComponent(
            '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
            '<circle cx="11" cy="11" r="7" fill="#1a73e8" stroke="#fff" stroke-width="3"/>' +
            '<circle cx="11" cy="11" r="10" fill="#1a73e8" fill-opacity="0.18"/></svg>'),
          anchor: new maps.Point(11, 11),
          scaledSize: new maps.Size(22, 22)
        };
        youMarker = new maps.Marker({
          position: youPos, map: map, icon: youIcon,
          title: 'You are here', zIndex: 9999
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

  window.p86EntitiesMap = { render: render };
})();
