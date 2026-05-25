// Projects map view — Google Maps iframe + clickable project list.
//
// The previous Leaflet/Carto/OSM combo kept missing tiles in the wild
// (rate limiting, CDN flakes, etc.) and left the user staring at a
// blank teal background. The lead editor's map widget uses Google
// Maps' no-API-key iframe embed and never fails — same approach here,
// scaled up to a list+map pattern so multiple projects fit.
//
// Layout:
//   ┌──────────────┬──────────────────────────────────┐
//   │ Project list │ Google Maps embed                │
//   │ (scrollable) │ (single iframe, swapped on click)│
//   │ click a row  │                                  │
//   │ → map jumps  │                                  │
//   └──────────────┴──────────────────────────────────┘
//
// Projects without addresses are listed under "Unmapped" at the
// bottom of the sidebar.
//
// Public surface (unchanged):
//   window.p86ProjectsMap.render(hostEl, projects, opts)
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

  // Status pin emoji — picked to match the list view's pin-color
  // convention so the visual language is consistent across views.
  function statusEmoji(p) {
    if (p.archived_at) return '⚫';
    var updated = p.updated_at ? new Date(p.updated_at).getTime() : 0;
    var ageDays = (Date.now() - updated) / 86400000;
    if (ageDays <= 7) return '🟢';
    return '🟡';
  }

  function hasAddress(p) {
    var a = (p.address_text || '').trim();
    return !!a;
  }

  function googleEmbedUrl(addressOrCoords) {
    // q= accepts a free-form address OR a "lat,lng" pair. z=16 is
    // street-level. output=embed strips chrome.
    return 'https://www.google.com/maps?q=' + encodeURIComponent(addressOrCoords) + '&output=embed&z=16';
  }

  function projectAddr(p) {
    // Prefer the address_text (what the user can edit) and fall back
    // to the geocoded coords as a "lat,lng" string when only those
    // exist. Geocoded coords work fine with Google's q= param.
    var addr = (p.address_text || '').trim();
    if (addr) return addr;
    if (Number.isFinite(Number(p.geocode_lat)) && Number.isFinite(Number(p.geocode_lng))) {
      return Number(p.geocode_lat) + ',' + Number(p.geocode_lng);
    }
    return '';
  }

  function render(host, projects, opts) {
    if (!host) return null;
    opts = opts || {};
    projects = projects || [];

    var mapped = projects.filter(function(p) { return projectAddr(p); });
    var unmapped = projects.filter(function(p) { return !projectAddr(p); });

    if (!mapped.length) {
      host.innerHTML =
        '<div class="p86-projects-empty">' +
          'No projects with addresses yet. Add a site address to a project to see it on the map.' +
          (unmapped.length ? '<br /><span style="font-size:11px;opacity:0.7;">' + unmapped.length + ' project(s) without addresses</span>' : '') +
        '</div>';
      return null;
    }

    var initial = mapped[0];
    host.innerHTML =
      '<div class="p86-projects-map-pane">' +
        '<div class="p86-projects-map-list" id="p86ProjMapList">' +
          mapped.map(function(p) {
            return listRowHTML(p, p.id === initial.id);
          }).join('') +
          (unmapped.length
            ? '<div class="p86-projects-map-unmapped-header">Unmapped (' + unmapped.length + ')</div>' +
              unmapped.map(function(p) {
                return '<div class="p86-projects-map-list-row p86-projects-map-list-row-unmapped" data-id="' + escapeAttr(p.id) + '">' +
                  '<div class="p86-projects-map-list-name">' + escapeHTML(p.name || 'Untitled') + '</div>' +
                  '<div class="p86-projects-map-list-addr">No address</div>' +
                '</div>';
              }).join('')
            : '') +
        '</div>' +
        '<div class="p86-projects-map-frame-wrap">' +
          '<iframe id="p86ProjMapFrame" class="p86-projects-map-frame" src="' + escapeAttr(googleEmbedUrl(projectAddr(initial))) + '" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>' +
        '</div>' +
      '</div>';

    var listEl = host.querySelector('#p86ProjMapList');
    var frameEl = host.querySelector('#p86ProjMapFrame');
    if (!listEl || !frameEl) return null;

    function focusProject(id) {
      var p = projects.find(function(x) { return String(x.id) === String(id); });
      if (!p) return;
      var addr = projectAddr(p);
      if (addr) {
        frameEl.src = googleEmbedUrl(addr);
      }
      listEl.querySelectorAll('.p86-projects-map-list-row').forEach(function(row) {
        row.classList.toggle('active', row.getAttribute('data-id') === String(id));
      });
    }

    listEl.querySelectorAll('.p86-projects-map-list-row').forEach(function(row) {
      row.addEventListener('click', function() {
        var id = row.getAttribute('data-id');
        if (row.classList.contains('p86-projects-map-list-row-unmapped')) {
          // Unmapped rows can't focus the map, so click → open detail.
          if (typeof opts.onPin === 'function') opts.onPin(id);
          else if (typeof window.openProject === 'function') window.openProject(id);
          return;
        }
        focusProject(id);
      });
      row.addEventListener('dblclick', function() {
        var id = row.getAttribute('data-id');
        if (typeof opts.onPin === 'function') opts.onPin(id);
        else if (typeof window.openProject === 'function') window.openProject(id);
      });
    });

    return { focus: focusProject };
  }

  function listRowHTML(p, active) {
    var coverUrl = p.cover_thumb_url || '';
    var thumb = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" class="p86-projects-map-list-thumb" />'
      : '<div class="p86-projects-map-list-thumb p86-projects-map-list-thumb-empty">📸</div>';
    return '<div class="p86-projects-map-list-row' + (active ? ' active' : '') + '" data-id="' + escapeAttr(p.id) + '" title="Click to focus map · double-click to open project">' +
      thumb +
      '<div class="p86-projects-map-list-body">' +
        '<div class="p86-projects-map-list-name">' +
          statusEmoji(p) + ' ' + escapeHTML(p.name || 'Untitled') +
        '</div>' +
        '<div class="p86-projects-map-list-addr">' + escapeHTML(p.address_text || '') + '</div>' +
        '<div class="p86-projects-map-list-meta">📷 ' + Number(p.photo_count || 0) +
          ' · ' + escapeHTML(fmtRelative(p.updated_at)) +
        '</div>' +
      '</div>' +
    '</div>';
  }

  window.p86ProjectsMap = {
    render: render
  };
})();
