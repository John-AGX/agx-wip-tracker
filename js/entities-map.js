// Combined entities map — Summary "Map" card (Phase 1 / Deliverable 2).
//
// Plots LEADS + JOBS together on one Google Map, with:
//   • Typed Project 86 teardrop pins (reuses js/map-pins.js — same
//     classifier + SVG builder the Projects / Leads / Jobs maps use, so
//     a reno job here looks identical to a reno job on the Jobs map).
//   • Marker clustering (Google MarkerClusterer, CDN) so a dense area
//     collapses to a count bubble instead of a pin pile.
//   • A "you are here" marker + Recenter button when the browser grants
//     geolocation (window.p86Geo). Degrades gracefully — denied / null
//     position simply omits the marker; the entity pins still render.
//   • Filter chips to toggle Leads vs Jobs.
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

  // MarkerClusterer CDN — the @googlemaps/markerclustererplus successor.
  // Exposes window.markerClusterer.MarkerClusterer. Loaded lazily on
  // first render so non-map pages don't pay for it.
  var CLUSTERER_SRC = 'https://unpkg.com/@googlemaps/markerclusterer@2.5.3/dist/index.min.js';
  var _clustererPromise = null;

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  // Load the clusterer once. ALWAYS resolves — a CDN failure resolves to
  // null so the map still renders pins (just un-clustered).
  function ensureClusterer() {
    if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
      return Promise.resolve(window.markerClusterer.MarkerClusterer);
    }
    if (_clustererPromise) return _clustererPromise;
    _clustererPromise = new Promise(function (resolve) {
      var existing = document.querySelector('script[data-p86-clusterer]');
      if (existing) {
        existing.addEventListener('load', function () {
          resolve((window.markerClusterer && window.markerClusterer.MarkerClusterer) || null);
        });
        existing.addEventListener('error', function () { resolve(null); });
        if (window.markerClusterer && window.markerClusterer.MarkerClusterer) {
          resolve(window.markerClusterer.MarkerClusterer);
        }
        return;
      }
      var s = document.createElement('script');
      s.src = CLUSTERER_SRC;
      s.async = true;
      s.setAttribute('data-p86-clusterer', '1');
      s.onload = function () {
        resolve((window.markerClusterer && window.markerClusterer.MarkerClusterer) || null);
      };
      s.onerror = function () { resolve(null); };
      document.head.appendChild(s);
    });
    return _clustererPromise;
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

  // Build the marker icon spec for an entity via the shared map-pins
  // module (falls back to the default Google pin if it isn't loaded).
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

  function infoContentHTML(item) {
    var kindLabel = item.kind === 'lead' ? 'Lead' : 'Job';
    return '<div style="min-width:180px;font-family:system-ui,sans-serif;">' +
      '<div style="font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:#0a66c2;margin-bottom:2px;">' + escapeHTML(kindLabel) + '</div>' +
      '<div style="font-size:13px;font-weight:600;color:#111;margin-bottom:6px;">' + escapeHTML(item.title || '(untitled)') + '</div>' +
      '<a href="#" style="font-size:12px;color:#0a66c2;text-decoration:none;font-weight:600;" ' +
        'onclick="event.preventDefault();window.__p86EntitiesMapOpen&&window.__p86EntitiesMapOpen(\'' +
          escapeAttr(item.kind) + '\',\'' + escapeAttr(item.id) + '\');">Open &rarr;</a>' +
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
        lat: l.geocode_lat, lng: l.geocode_lng, kind: 'lead' };
    });
    var jobs = (d.jobs || []).map(function (j) {
      var num = j.jobNumber || j.job_number || '';
      var name = j.title || j.name || 'Untitled job';
      return { id: j.id, title: num ? (num + ' — ' + name) : name,
        lat: j.geocode_lat, lng: j.geocode_lng, kind: 'job', jobNumber: num };
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
          kind: kind, jobNumber: it.jobNumber || '' };
      }).filter(Boolean);
    }
    return { leads: clean(data.leads, 'lead'), jobs: clean(data.jobs, 'job') };
  }

  function mount(maps, host, data) {
    var leads = data.leads, jobs = data.jobs;
    var total = leads.length + jobs.length;

    if (!total) {
      host.innerHTML = emptyHTML('No leads or jobs with mapped addresses yet. Save an address on a lead or job to plot it here.');
      return;
    }

    // Chrome: filter chips + map canvas + recenter button.
    host.innerHTML =
      '<div style="position:absolute;top:10px;left:10px;z-index:5;display:flex;gap:6px;">' +
        '<button type="button" data-emap-chip="lead" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #4f8cff;background:#4f8cff;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Leads ' + leads.length + '</button>' +
        '<button type="button" data-emap-chip="job" class="p86-emap-chip" ' +
          'style="font-size:11px;font-weight:600;padding:5px 10px;border-radius:14px;border:1px solid #94a3b8;background:#94a3b8;color:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,0.3);">Jobs ' + jobs.length + '</button>' +
      '</div>' +
      '<button type="button" data-emap-recenter ' +
        'style="position:absolute;bottom:24px;right:10px;z-index:5;display:none;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;border:1px solid var(--border,#333);background:#fff;color:#111;cursor:pointer;box-shadow:0 1px 4px rgba(0,0,0,0.3);">\u{1F4CD} You</button>' +
      '<div data-emap-canvas style="width:100%;height:100%;min-height:420px;"></div>';

    var canvas = host.querySelector('[data-emap-canvas]');
    var recenterBtn = host.querySelector('[data-emap-recenter]');

    // Wire the open-entity dispatcher (info-window anchors call it).
    window.__p86EntitiesMapOpen = openEntity;

    var map = new maps.Map(canvas, {
      center: { lat: leads[0] ? leads[0].lat : jobs[0].lat,
                lng: leads[0] ? leads[0].lng : jobs[0].lng },
      zoom: 11,
      mapTypeControl: false,
      streetViewControl: false,
      fullscreenControl: true,
      gestureHandling: 'greedy',
      mapTypeId: maps.MapTypeId.ROADMAP
    });

    var infoWindow = new maps.InfoWindow();
    var bounds = new maps.LatLngBounds();

    // Build markers per kind so the chips can show/hide whole sets.
    var markersByKind = { lead: [], job: [] };

    function buildMarker(item) {
      var pos = { lat: item.lat, lng: item.lng };
      var icon = iconForItem(maps, item);
      var marker = new maps.Marker({
        position: pos,
        title: item.title || '',
        icon: icon
      });
      marker.addListener('click', function () {
        infoWindow.setContent(infoContentHTML(item));
        infoWindow.open(map, marker);
      });
      bounds.extend(pos);
      return marker;
    }

    leads.forEach(function (it) { markersByKind.lead.push(buildMarker(it)); });
    jobs.forEach(function (it) { markersByKind.job.push(buildMarker(it)); });

    // Fit to all markers (the clusterer/visibility toggle works on top).
    if (total > 1) map.fitBounds(bounds, 48);
    else map.setZoom(14);

    // Cluster the entity pins. The clusterer manages add/remove from the
    // map, so we feed it the currently-visible set and rebuild on toggle.
    var clustererCtor = null;
    var clusterer = null;
    var shown = { lead: true, job: true };

    function visibleMarkers() {
      var out = [];
      if (shown.lead) out = out.concat(markersByKind.lead);
      if (shown.job) out = out.concat(markersByKind.job);
      return out;
    }

    function applyMarkers() {
      var vis = visibleMarkers();
      if (clusterer) {
        clusterer.clearMarkers();
        clusterer.addMarkers(vis);
      } else {
        // No clusterer (CDN failed) — set each marker's map directly.
        markersByKind.lead.forEach(function (m) { m.setMap(shown.lead ? map : null); });
        markersByKind.job.forEach(function (m) { m.setMap(shown.job ? map : null); });
      }
    }

    ensureClusterer().then(function (Ctor) {
      clustererCtor = Ctor;
      if (clustererCtor) {
        try {
          clusterer = new clustererCtor({ map: map, markers: visibleMarkers() });
        } catch (e) {
          clusterer = null;
          applyMarkers();
        }
      } else {
        applyMarkers();
      }
    });
    // Render pins immediately (un-clustered) so they show even before the
    // clusterer CDN resolves; the clusterer takes over once it loads.
    applyMarkers();

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
        applyMarkers();
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
