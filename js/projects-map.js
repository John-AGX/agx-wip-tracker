// Projects map view — real multi-pin Google Maps with photo layer.
//
// Architecture:
//   Left side: scrollable project list (same row style the standalone
//              List view uses, so users can scan the list while the
//              map sits next to it).
//   Right side: Google Map showing every project with coords as a
//               pin. Clicking a project row pans the map; clicking a
//               pin highlights its row.
//
// Photo pins layer:
//   When a photo layer is toggled on (default on for project detail
//   pages, off for the top-level Projects map to avoid pin overload),
//   every photo on the visible projects renders as a smaller marker
//   with a tag-driven icon (see js/tag-icons.js).
//
// Public surface (unchanged from prior iframe version):
//   window.p86ProjectsMap.render(hostEl, projects, opts)
//     opts.onPin(projectId)  — called when user clicks a project row
//                              or pin "Open" button
//     opts.photoLayer        — bool (default false on Projects list,
//                              true for project detail map)
//     opts.photos            — array of photo attachments to overlay
//                              (only used when photoLayer is true)
//
// Falls back to a clean empty state if window.p86Maps.ready() rejects
// (no key set, key not authorized for this referrer, network fail).

(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
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
  function statusEmoji(p) {
    if (p.archived_at) return '⚫';
    var updated = p.updated_at ? new Date(p.updated_at).getTime() : 0;
    var ageDays = (Date.now() - updated) / 86400000;
    if (ageDays <= 7) return '🟢';
    return '🟡';
  }
  // Recency-coded status color (archived=slate, fresh≤7d=green, else amber).
  // Used for the colored dot in list rows + info windows — cleaner than the
  // emoji and aligns with the app's chip palette.
  function statusColor(p) {
    if (p.archived_at) return '#64748b';
    var updated = p.updated_at ? new Date(p.updated_at).getTime() : 0;
    var ageDays = (Date.now() - updated) / 86400000;
    if (ageDays <= 7) return '#22c55e';
    return '#eab308';
  }

  // A project is "mapped" if it has either an explicit address_text
  // OR usable geocoded lat/lng coords. The latter is the only thing
  // Google Maps JS API can plot directly — we'd need a Geocoding call
  // to turn address strings into coords, and that's a separate API +
  // billing concern. So for now, only projects with coords go on the
  // map; the rest go in the "Unmapped" footer with a note that an
  // admin can add coords by saving an address.
  function projectCoords(p) {
    var lat = Number(p.geocode_lat);
    var lng = Number(p.geocode_lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
    // 0,0 is "Null Island" in the Atlantic — a project with a real address that
    // was never geocoded often stores 0/0. Never plot it; treat as unmapped.
    if (lat === 0 && lng === 0) return null;
    // Reject anything outside real-world lat/lng ranges (bad/garbage data).
    if (lat < -90 || lat > 90 || lng < -180 || lng > 180) return null;
    return { lat: lat, lng: lng };
  }

  // Adapter-aware row builder. opts carries getName/getAddress/getMeta so the
  // same pane renders projects (default), leads, or jobs.
  function listRowHTML(opts, p, active) {
    var coords = projectCoords(p);
    var thumb = '';
    if (opts.showThumb) {
      var coverUrl = p.cover_thumb_url || '';
      thumb = coverUrl
        ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-projects-map-list-thumb" />'
        : '<div class="p86-projects-map-list-thumb p86-projects-map-list-thumb-empty">📸</div>';
    }
    return '<div class="p86-projects-map-list-row' + (active ? ' active' : '') +
           (coords ? '' : ' p86-projects-map-list-row-unmapped') +
           '" data-id="' + escapeAttr(p.id) + '" title="Click to focus map · double-click to open">' +
      thumb +
      '<div class="p86-projects-map-list-body">' +
        '<div class="p86-projects-map-list-name">' +
          '<span class="p86-projects-map-list-dot" style="background:' + statusColor(p) + ';"></span>' +
          escapeHTML(opts.getName(p)) +
        '</div>' +
        '<div class="p86-projects-map-list-addr">' + escapeHTML(opts.getAddress(p) || '(no address)') + '</div>' +
        '<div class="p86-projects-map-list-meta">' + escapeHTML(opts.getMeta(p)) + '</div>' +
      '</div>' +
    '</div>';
  }

  function emptyHTML(reason) {
    return '<div class="p86-projects-empty">' + escapeHTML(reason) + '</div>';
  }

  function render(host, projects, opts) {
    if (!host) return null;
    opts = opts || {};
    projects = projects || [];
    // Entity adapters — defaults preserve the original projects behavior;
    // leads/jobs pass their own getName/getAddress/getMeta.
    opts.getName = opts.getName || function(p) { return p.name || 'Untitled'; };
    opts.getAddress = opts.getAddress || function(p) { return p.address_text || ''; };
    opts.getMeta = opts.getMeta || function(p) { return '📷 ' + Number(p.photo_count || 0) + ' · ' + fmtRelative(p.updated_at); };
    opts.showThumb = opts.showThumb !== false;
    opts.entityLabel = opts.entityLabel || 'projects';
    // Info-window "Open" anchors dispatch through this registry so leads/jobs
    // open their own detail instead of the hardcoded window.openProject.
    window.__p86MapOpen = function(id) {
      if (typeof opts.onPin === 'function') opts.onPin(id);
      else if (typeof window.openProject === 'function') window.openProject(id);
    };

    var mapped = projects.filter(projectCoords);
    var unmapped = projects.filter(function(p) { return !projectCoords(p); });

    // No rows with coords AND no photo layer fallback — pure empty.
    if (!mapped.length && !(opts.photoLayer && opts.photos && opts.photos.length)) {
      host.innerHTML = emptyHTML(
        'No ' + opts.entityLabel + ' with geocoded addresses yet. Save an address to plot it on the map.' +
        (unmapped.length ? ' (' + unmapped.length + ' without coords)' : '')
      );
      return null;
    }

    // Skeleton — fill in the list immediately so users see something
    // while the Maps script is still loading.
    var initial = mapped[0];
    host.innerHTML =
      '<div class="p86-projects-map-pane">' +
        '<div class="p86-projects-map-list" id="p86ProjMapList">' +
          mapped.map(function(p) { return listRowHTML(opts, p, initial && p.id === initial.id); }).join('') +
          (unmapped.length
            ? '<div class="p86-projects-map-unmapped-header">Unmapped (' + unmapped.length + ')</div>' +
              unmapped.map(function(p) {
                return '<div class="p86-projects-map-list-row p86-projects-map-list-row-unmapped" data-id="' + escapeAttr(p.id) + '">' +
                  '<div class="p86-projects-map-list-name">' + escapeHTML(opts.getName(p)) + '</div>' +
                  '<div class="p86-projects-map-list-addr">No coords</div>' +
                '</div>';
              }).join('')
            : '') +
        '</div>' +
        '<div class="p86-projects-map-frame-wrap" id="p86ProjMapFrame">' +
          '<div class="p86-projects-map-loading">Loading map…</div>' +
        '</div>' +
      '</div>';

    var listEl = host.querySelector('#p86ProjMapList');
    var mapHostEl = host.querySelector('#p86ProjMapFrame');
    if (!listEl || !mapHostEl) return null;

    // Boot Google Maps. If it fails (no key, network), we render the
    // list-only fallback in the right pane.
    if (!window.p86Maps) {
      mapHostEl.innerHTML = emptyHTML('Maps module not loaded.');
      return null;
    }
    window.p86Maps.ready().then(function(maps) {
      // Best-effort: warm the pin config (entity pins + photo-tag pins).
      // Deliberately NOT awaited — the map must mount on the SDK alone so a
      // slow or failed config fetch can never blank the map. Pins fall back
      // to built-in defaults until the config resolves.
      try {
        if (window.p86MapPins && window.p86MapPins.ensureConfig) window.p86MapPins.ensureConfig();
        if (opts.photoLayer && window.p86TagIcons && window.p86TagIcons.ensureConfig) window.p86TagIcons.ensureConfig();
      } catch (e) { /* non-fatal */ }
      mountMap(maps, mapHostEl, listEl, mapped, opts);
    }).catch(function(err) {
      mapHostEl.innerHTML = emptyHTML('Map unavailable: ' + (err && err.message || 'unknown error') +
        '\nList view still works — pick a project on the left.');
    });

    // List-row click handler — works even before the map loads. If
    // the map is ready, clicking pans/zooms. If not, just opens detail.
    var mapApi = null;
    function attachMapApi(api) { mapApi = api; }
    window.__p86ProjMapAttach = attachMapApi;

    function rowClicked(id, isDouble) {
      if (isDouble || !mapApi) {
        if (typeof opts.onPin === 'function') opts.onPin(id);
        else if (typeof window.openProject === 'function') window.openProject(id);
        return;
      }
      mapApi.focusProject(id);
      listEl.querySelectorAll('.p86-projects-map-list-row').forEach(function(row) {
        row.classList.toggle('active', row.getAttribute('data-id') === String(id));
      });
    }

    listEl.querySelectorAll('.p86-projects-map-list-row').forEach(function(row) {
      var id = row.getAttribute('data-id');
      row.addEventListener('click', function() { rowClicked(id, false); });
      row.addEventListener('dblclick', function() { rowClicked(id, true); });
    });

    return { rerender: function() { render(host, projects, opts); } };
  }

  // ── Actual Google Maps mount ────────────────────────────────────
  function mountMap(maps, hostEl, listEl, mapped, opts) {
    hostEl.innerHTML = '<div class="p86-google-map" id="p86GoogleMap"></div>';
    var mapEl = hostEl.querySelector('#p86GoogleMap');

    // Center on first project; zoom level 12 is "city-ish". We'll
    // call fitBounds after to actually tighten to the whole set.
    var first = mapped[0];
    var coords = projectCoords(first);
    var map = new maps.Map(mapEl, {
      center: coords,
      zoom: 12,
      mapTypeControl: true,
      streetViewControl: false,
      fullscreenControl: true,
      // Use the default vector renderer (faster panning + smoother
      // zoom than the legacy raster mode).
      mapTypeId: maps.MapTypeId.ROADMAP,
      gestureHandling: 'greedy'  // mobile: one-finger pan, no pinch-to-pan
    });

    // Project pins — one per mapped project. Click → highlight in
    // sidebar + open info window with name + address + Open button.
    var markersById = {};
    var infoWindow = new maps.InfoWindow();
    var bounds = new maps.LatLngBounds();
    mapped.forEach(function(p) {
      var c = projectCoords(p);
      if (!c) return;
      // Typed Project 86 pin — color + icon chosen by entity type
      // (lead / service / reno / work-order / job / project) via the
      // shared map-pins module. Falls back to the default Google pin if
      // that module isn't loaded.
      var markerOpts = { position: c, map: map, title: opts.getName(p) || 'Untitled' };
      if (window.p86MapPins && typeof window.p86MapPins.specForEntity === 'function') {
        var spec = window.p86MapPins.specForEntity(p, opts.entityLabel);
        if (spec && spec.url) {
          markerOpts.icon = {
            url: spec.url,
            anchor: new maps.Point(spec.ax, spec.ay),
            scaledSize: new maps.Size(spec.w, spec.h)
          };
        }
      }
      var marker = new maps.Marker(markerOpts);
      markersById[p.id] = marker;
      bounds.extend(c);
      marker.addListener('click', function() {
        infoWindow.setContent(infoContentHTML(opts, p));
        infoWindow.open(map, marker);
        listEl.querySelectorAll('.p86-projects-map-list-row').forEach(function(row) {
          row.classList.toggle('active', row.getAttribute('data-id') === String(p.id));
        });
        // Scroll the matching row into view if it's offscreen in the
        // narrow sidebar.
        var activeRow = listEl.querySelector('.p86-projects-map-list-row.active');
        if (activeRow && activeRow.scrollIntoView) {
          activeRow.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      });
    });

    // Photo pins layer — only on detail-mode maps where opts.photoLayer
    // is true AND we have photo data. Each photo with lat/lng gets a
    // smaller colored marker with the tag-driven icon.
    if (opts.photoLayer && Array.isArray(opts.photos)) {
      opts.photos.forEach(function(photo) {
        if (!photo || !Number.isFinite(Number(photo.lat)) || !Number.isFinite(Number(photo.lng))) return;
        var icon = (window.p86TagIcons && window.p86TagIcons.forPhoto)
          ? window.p86TagIcons.forPhoto(photo) : { bg: '#6b7280', fg: '#fff', glyph: '●' };
        var pinSvg = photoPinSvg(icon);
        var pos = { lat: Number(photo.lat), lng: Number(photo.lng) };
        var photoMarker = new maps.Marker({
          position: pos,
          map: map,
          icon: {
            url: 'data:image/svg+xml;utf8,' + encodeURIComponent(pinSvg),
            // SVG anchor — point of the pin is the bottom-middle.
            anchor: new maps.Point(11, 22),
            scaledSize: new maps.Size(22, 22)
          },
          zIndex: 1,
          title: (photo.caption || photo.filename || 'Photo')
        });
        bounds.extend(pos);
        photoMarker.addListener('click', function() {
          // Open the lightbox if available; else open the original.
          if (window.p86Attachments && typeof window.p86Attachments.openLightbox === 'function') {
            var photos = (opts.photos || []).filter(function(p) {
              return p.mime_type && /^image\//i.test(p.mime_type);
            });
            var idx = photos.findIndex(function(p) { return String(p.id) === String(photo.id); });
            window.p86Attachments.openLightbox(photos, Math.max(0, idx), {
              parentLabel: 'Map',
              parentSubtitle: ''
            });
          } else if (photo.original_url) {
            window.open(photo.original_url, '_blank', 'noopener');
          }
        });
      });
    }

    // Fit the map to show every marker. For a single project (no
    // bounds variance) leave the default zoom alone.
    if (Object.keys(markersById).length > 1 || (opts.photoLayer && opts.photos && opts.photos.length > 1)) {
      map.fitBounds(bounds, 64);  // 64px padding around the bbox
    }

    // Expose a small API back to the row-click handler.
    var api = {
      focusProject: function(id) {
        var m = markersById[id];
        if (!m) return;
        map.panTo(m.getPosition());
        if (map.getZoom() < 14) map.setZoom(15);
        maps.event.trigger(m, 'click');
      }
    };
    if (typeof window.__p86ProjMapAttach === 'function') {
      window.__p86ProjMapAttach(api);
    }
  }

  function infoContentHTML(opts, p) {
    // Plain HTML — Google Maps strips most styling but keeps inline
    // styles + img tags. Anchor dispatches through __p86MapOpen (set per
    // render) so each entity type opens its own detail view.
    var addr = opts.getAddress(p);
    var meta = (typeof opts.getMeta === 'function') ? opts.getMeta(p) : '';
    return '<div style="min-width:210px;max-width:280px;font-family:system-ui,sans-serif;">' +
      '<div style="display:flex;align-items:center;gap:7px;margin-bottom:3px;">' +
        '<span style="width:9px;height:9px;border-radius:50%;flex-shrink:0;background:' + statusColor(p) + ';"></span>' +
        '<span style="font-size:14px;font-weight:600;color:#111;line-height:1.3;">' + escapeHTML(opts.getName(p)) + '</span>' +
      '</div>' +
      (addr ? '<div style="font-size:11px;color:#555;margin-bottom:4px;">' + escapeHTML(addr) + '</div>' : '') +
      (meta ? '<div style="font-size:11px;color:#888;margin-bottom:6px;">' + escapeHTML(meta) + '</div>' : '') +
      '<a href="#" style="display:inline-block;font-size:12px;color:#fff;background:#0a66c2;text-decoration:none;font-weight:600;border-radius:6px;padding:5px 12px;margin-top:4px;" ' +
        'onclick="event.preventDefault();window.__p86MapOpen&&window.__p86MapOpen(\'' + escapeAttr(p.id) + '\');">Open &rarr;</a>' +
    '</div>';
  }

  // Compact SVG pin used for photo markers. ~22px square, glyph
  // centered, drop-shadow to lift it off the map tiles.
  function photoPinSvg(icon) {
    // Glyph (white P86 icon when the tag spec carries one, else the text
    // glyph) comes from the shared tag-icons helper so photo pins match
    // the rest of the app's markers.
    var glyph = (window.p86TagIcons && window.p86TagIcons.glyphMarkup)
      ? window.p86TagIcons.glyphMarkup(icon, 11, 11, 12)
      : '<text x="11" y="14.5" text-anchor="middle" font-size="10" font-family="Arial,sans-serif" font-weight="bold" fill="' + (icon.fg || '#fff') + '">' + escapeHTML(icon.glyph || '') + '</text>';
    return '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 22 22">' +
      '<defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%">' +
        '<feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.4"/>' +
      '</filter></defs>' +
      '<circle cx="11" cy="11" r="9" fill="' + icon.bg + '" stroke="white" stroke-width="2" filter="url(#s)"/>' +
      glyph +
    '</svg>';
  }

  window.p86ProjectsMap = {
    render: render
  };
})();
