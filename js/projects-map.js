// Projects map view — Leaflet + OpenStreetMap.
//
// CompanyCam's "Project Map" view shows every project pinned on a map
// with the pin color reflecting status (active recent / active stale /
// archived). Clicking a pin previews the project; clicking the preview
// opens the detail overlay.
//
// We use Leaflet because we want multiple markers with colored pins
// and popups, which the Google Maps iframe (used elsewhere in the app
// for single-address embeds) doesn't support without an API key.
// Leaflet ships ~40kb gzipped and loads from a CDN — see index.html.
//
// Public surface:
//   window.p86ProjectsMap.render(hostEl, projects, opts)
//     - hostEl: DOM element to mount into
//     - projects: array of project rows (must have geocode_lat/lng)
//     - opts.onPin(projectId): click handler for pin / preview "Open"
//
// Returns the Leaflet map instance (caller can keep it for invalidate
// on container resize). If Leaflet isn't loaded yet, renders a graceful
// placeholder and bails — caller polls and retries.
(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  // Status → pin color. Active + recent (≤7d) = green; active + stale = yellow;
  // archived = gray. CompanyCam's convention; readable at a glance.
  function pinColor(project) {
    if (project.archived_at) return '#6b7280';     // gray
    var updated = project.updated_at ? new Date(project.updated_at).getTime() : 0;
    var ageDays = (Date.now() - updated) / 86400000;
    if (ageDays <= 7) return '#34d399';            // green
    return '#fbbf24';                              // yellow
  }

  // Build a small SVG pin matching the color. Returns a Leaflet
  // DivIcon spec so we don't need to ship raster pin images.
  function buildPinIcon(L, color) {
    var svg =
      '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="32" viewBox="0 0 24 32">' +
        '<path d="M12 0C5.4 0 0 5.4 0 12c0 9 12 20 12 20s12-11 12-20C24 5.4 18.6 0 12 0z" fill="' + color + '" stroke="#0a0a14" stroke-width="1.5"/>' +
        '<circle cx="12" cy="12" r="4" fill="#0a0a14"/>' +
      '</svg>';
    return L.divIcon({
      className: 'p86-proj-pin',
      html: svg,
      iconSize: [24, 32],
      iconAnchor: [12, 32],
      popupAnchor: [0, -28]
    });
  }

  function popupHTML(p) {
    var coverUrl = p.cover_thumb_url || '';
    var visual = coverUrl
      ? '<img src="' + escapeHTML(coverUrl) + '" alt="" style="width:100%;height:80px;object-fit:cover;display:block;border-radius:4px;margin-bottom:6px;background:#1a1a2e;" />'
      : '<div style="height:80px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);color:#22d3ee;font-size:22px;border-radius:4px;margin-bottom:6px;">&#x1F4F8;</div>';
    var counts = '&#x1F4F7; ' + (p.photo_count || 0) +
      ' &middot; &#x1F4DD; ' + (p.pair_count || 0);
    return '<div style="min-width:180px;color:#fff;">' +
      visual +
      '<div style="font-size:13px;font-weight:600;margin-bottom:2px;">' + escapeHTML(p.name || '(Untitled)') + '</div>' +
      '<div style="font-size:10.5px;color:#aaa;margin-bottom:6px;">' + counts + '</div>' +
      '<button onclick="window.p86ProjectsMap._openFromPopup(\'' + escapeHTML(p.id) + '\')" ' +
        'style="font-size:11px;padding:5px 10px;background:#4f8cff;color:#fff;border:none;border-radius:4px;cursor:pointer;width:100%;">Open project</button>' +
    '</div>';
  }

  var _lastOpts = null;
  function _openFromPopup(projectId) {
    if (_lastOpts && typeof _lastOpts.onPin === 'function') {
      _lastOpts.onPin(projectId);
    } else if (typeof window.openProject === 'function') {
      window.openProject(projectId);
    }
  }

  function render(host, projects, opts) {
    if (!host) return null;
    opts = opts || {};
    _lastOpts = opts;

    var L = window.L;
    if (!L) {
      host.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);font-size:12px;">Loading map library…</div>';
      // Retry once the CDN script lands. Polls every 250ms for up to 5s.
      var tries = 0;
      var timer = setInterval(function() {
        tries++;
        if (window.L) {
          clearInterval(timer);
          render(host, projects, opts);
        } else if (tries >= 20) {
          clearInterval(timer);
          host.innerHTML = '<div style="padding:30px;text-align:center;color:#f87171;font-size:12px;">Map library failed to load. Check the network tab for blocked CDN requests.</div>';
        }
      }, 250);
      return null;
    }

    // Mappable subset: only projects with valid lat/lng.
    var pinnable = (projects || []).filter(function(p) {
      var lat = Number(p.geocode_lat), lng = Number(p.geocode_lng);
      return Number.isFinite(lat) && Number.isFinite(lng);
    });

    // Need a clean container for Leaflet (it stamps internal DOM into it).
    host.innerHTML = '';
    var mapEl = document.createElement('div');
    mapEl.style.cssText = 'width:100%;height:100%;min-height:400px;border-radius:8px;overflow:hidden;background:#0a0a14;';
    host.appendChild(mapEl);

    // Initial view: fit to all pins or default to continental US.
    var map = L.map(mapEl, { zoomControl: true, attributionControl: true });
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; OSM'
    }).addTo(map);

    if (!pinnable.length) {
      // Center on Central Florida (AGX home turf) at a wide zoom so the
      // user can see "nothing here yet" rather than a useless ocean.
      map.setView([28.5, -81.5], 7);
    } else {
      var bounds = L.latLngBounds([]);
      pinnable.forEach(function(p) {
        var lat = Number(p.geocode_lat), lng = Number(p.geocode_lng);
        bounds.extend([lat, lng]);
        var marker = L.marker([lat, lng], { icon: buildPinIcon(L, pinColor(p)) }).addTo(map);
        marker.bindPopup(popupHTML(p), { closeButton: true, maxWidth: 220 });
      });
      if (pinnable.length === 1) {
        // Single pin — center + reasonable zoom; fitBounds on one point
        // zooms in too far.
        var only = pinnable[0];
        map.setView([Number(only.geocode_lat), Number(only.geocode_lng)], 14);
      } else {
        map.fitBounds(bounds, { padding: [30, 30] });
      }
    }

    // Tile renderer races with the container's final height in some
    // layouts (modal fade-in, tab switch). One invalidate after a
    // requestAnimationFrame settles it without measurable lag.
    requestAnimationFrame(function() { map.invalidateSize(); });

    return map;
  }

  window.p86ProjectsMap = {
    render: render,
    _openFromPopup: _openFromPopup,
    _pinColor: pinColor          // exposed for legend rendering
  };
})();
