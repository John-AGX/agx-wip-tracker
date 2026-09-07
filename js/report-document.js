// THE report document renderer.
//
// One renderer for the report preview, the printed page, and the public share
// portal. Commit 2db05200 collapsed the first two (the preview built its own
// HTML while printing rendered the editor's DOM, which is why printed page
// breaks never matched the preview); this file finishes the job by making that
// one renderer reachable from a page that is not the app.
//
// ── THE RULE THIS FILE HAS TO SATISFY ───────────────────────────────────
// The guest surfaces in this repo COPY the app's markup, classes and tokens
// and NEVER link the app's code — because every real renderer in the SPA takes
// an id and reaches for app state itself, so loading one onto a guest page
// drags the whole app in behind it.
//
// This file is the exception that earns its place by being PURE:
//
//   * it declares exactly ONE global, window.p86ReportDocument
//   * it reads NOTHING ambient — no appData, no p86Api, no _detailState, no
//     p86Maps, no localStorage, no fetch, no document.querySelector on app
//     nodes. Every input arrives in the `doc` argument.
//   * it emits no editor affordances: no inputs, no drag handles, no remove
//     buttons, no side-swap control. A guest cannot be given a control that
//     posts nowhere.
//
// test/report-document-render.test.js runs this file in a bare sandbox and
// asserts those properties, so the guarantee is enforced rather than promised.
// If you add an ambient read here, that test fails — fix the code, not the test.
//
// The `doc` shape is produced by server/services/report-document.js
// (buildDocument). The editor produces the same shape from its live state, so
// there is exactly one document contract.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  // Attribute escaping must handle & FIRST, or the & in a just-inserted &quot;
  // is re-escaped to &amp;quot; and every quote double-escapes. That exact bug
  // corrupted a JSON blob in a data- attribute here once already.
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  function fmtDate(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    try {
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
        ' · ' + d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
    } catch (e) { return d.toISOString().slice(0, 16).replace('T', ' '); }
  }

  // Which side the description column sits on for one photo.
  function descSideFor(section, pid) {
    var per = section && section.descSides;
    if (per && (per[pid] === 'left' || per[pid] === 'right')) return per[pid];
    return (section && section.descSide === 'left') ? 'left' : 'right';
  }

  function hasSideContent(photo) {
    return !!(photo && (photo.caption || photo.shot_at || photo.uploaded_by_name));
  }

  // The metadata column beside a photo. Deliberately NOT the editor's version:
  // that one also emits a side-swap button, and a guest must never be handed a
  // control that posts nowhere.
  function sideColumnHTML(photo) {
    if (!hasSideContent(photo)) return '';
    var when = fmtDate(photo.shot_at);
    // The uploader is rendered only when the DOCUMENT carries one. The editor
    // includes it; the published snapshot omits it, because who on the crew
    // took a photo is internal. Same renderer, different data — the decision
    // lives in the document, not in a flag threaded through here.
    var who = photo.uploaded_by_name || '';
    var meta = [who, when].filter(Boolean);
    return '<div class="p86-report-photo-sidedesc">' +
      (photo.caption ? '<div class="p86-report-photo-sidedesc-text">' + esc(photo.caption) + '</div>' : '') +
      (meta.length ? '<div class="p86-report-photo-meta">' + meta.map(function (m) {
        return '<div class="p86-report-photo-meta-row"><span class="p86-report-photo-meta-val">' + esc(m) + '</span></div>';
      }).join('') + '</div>' : '') +
    '</div>';
  }

  // ── Pin de-overlap ────────────────────────────────────────────────────
  // Crews shoot several things standing in one spot, so photos share a
  // coordinate constantly — a whole elevation gets shot from one position and
  // every frame carries the same GPS fix. Stacked pins mean only the TOP one
  // is ever clickable, so the rest of the photos are unreachable on the map
  // even though they are all drawn.
  //
  // Identical points are fanned into a small ring (~5m) so each photo can be
  // opened. The cos(lat) term keeps the ring round rather than an ellipse: a
  // degree of longitude shortens towards the poles, so the same delta is a
  // smaller distance east-west than north-south.
  //
  // Exported because THREE maps need it and they must not drift: this Leaflet
  // map, and the two Google maps in js/projects.js (the project detail map and
  // the report editor's map section). It is pure — no DOM, no map library — so
  // it works in the vm sandbox the server PDF loads this file into.
  var FAN_RADIUS_DEG = 0.000045;   // ~5m at the equator

  function fanOutPins(points) {
    var list = Array.isArray(points) ? points : [];
    var byPoint = {};
    list.forEach(function (p) {
      var k = Number(p.lat).toFixed(6) + ',' + Number(p.lng).toFixed(6);
      (byPoint[k] = byPoint[k] || []).push(p);
    });
    var out = [];
    Object.keys(byPoint).forEach(function (k) {
      var group = byPoint[k];
      group.forEach(function (p, i) {
        var lat = Number(p.lat), lng = Number(p.lng);
        if (group.length > 1) {
          var a = (2 * Math.PI * i) / group.length;
          lat += FAN_RADIUS_DEG * Math.cos(a);
          lng += FAN_RADIUS_DEG * Math.sin(a) / Math.cos(lat * Math.PI / 180);
        }
        out.push({ point: p, lat: lat, lng: lng, fanned: group.length > 1 });
      });
    });
    return out;
  }

  function numHTML(photo) {
    if (!photo || !photo.num) return '';
    // A span, not a button: in the editor the badge navigates to the map pin,
    // but there is nothing to navigate to here — and a global print rule hides
    // every <button>, which is how these numbers silently vanished from the
    // printed page once before.
    return '<span class="p86-report-photo-num">' + esc(String(photo.num)) + '</span>';
  }

  function photoCardHTML(section, photo) {
    var side = descSideFor(section, photo.id);
    var sideCls = hasSideContent(photo) ? (' has-sidedesc' + (side === 'left' ? ' desc-left' : '')) : '';
    var src = photo.web_url || photo.thumb_url || '';
    var anno = (Array.isArray(photo.annotations) && photo.annotations.length)
      ? '<canvas class="p86-report-preview-photo-anno" data-anno-photo="' + escAttr(photo.id) + '"></canvas>'
      : '';
    return '<div class="p86-report-preview-photo' + sideCls + '">' +
      '<div class="p86-report-preview-photo-img-wrap">' +
        numHTML(photo) +
        '<img src="' + escAttr(src) + '" alt="" loading="lazy" />' +
        anno +
      '</div>' +
      sideColumnHTML(photo) +
    '</div>';
  }

  function sectionHTML(section) {
    var layout = section.layout || 'photo-grid';
    var size = section.photoSize || 'small';
    var body = '';

    if (layout === 'text-block') {
      body = '<div class="p86-report-preview-text">' + esc(section.text_body || '') + '</div>';

    } else if (layout === 'attachment-list') {
      var files = Array.isArray(section.files) ? section.files : [];
      body = files.length
        ? '<div class="p86-report-preview-files">' + files.map(function (f) {
            var ext = String(f.filename || '').split('.').pop().toUpperCase();
            return '<div class="p86-report-preview-file-row">' +
              '<span class="p86-report-preview-file-ext">' + esc(ext) + '</span>' +
              '<span class="p86-report-preview-file-name">' + esc(f.filename || '') + '</span>' +
            '</div>';
          }).join('') + '</div>'
        : '<div class="p86-report-preview-empty">No files in this section.</div>';

    } else if (layout === 'photo-map') {
      // BOTH, deliberately layered:
      //
      //   1. an interactive map, upgraded in by wire() when Leaflet is present
      //   2. the BAKED static image underneath it as the fallback — shown when
      //      Leaflet is unavailable, and the thing that prints
      //   3. the photo grid if there is no baked image either
      //
      // The pin DATA is not embedded in an attribute; wire() reads it from the
      // document it is already given. That avoids serialising JSON into markup,
      // which is exactly where a double-escaping bug corrupted this feature
      // once before.
      //
      // This renderer still never builds a Maps URL. Interactive tiles need no
      // key at all, and the static image is baked server-side — because a URL
      // that carries an API key must never reach a stranger's browser.
      var mapped = (section.photos || []).filter(function (p) { return p.lat != null && p.lng != null; });
      if (mapped.length) {
        // THREE layers, so there is no arrangement that yields an empty box:
        //   .p86-report-map-live     — added by wire() when Leaflet is present
        //   .p86-report-map-static   — the server-baked image (also what prints)
        //   .p86-report-map-fallback — the photo grid, when there is neither
        // CSS hides the lower layers once a higher one exists.
        body =
          '<div class="p86-report-map-wrap' + (section.map_url ? ' has-static' : '') +
            '" data-map-section="' + escAttr(section.id || '') + '">' +
            (section.map_url
              ? '<img class="p86-report-map-static" src="' + escAttr(section.map_url) + '" alt="Photo locations" />'
              : '') +
            '<div class="p86-report-map-fallback p86-report-preview-section-grid size-' + esc(size) + '">' +
              mapped.map(function (p) { return photoCardHTML(section, p); }).join('') +
            '</div>' +
          '</div>';
      } else if (section.map_url) {
        body = '<div class="p86-report-preview-map">' +
          '<img src="' + escAttr(section.map_url) + '" alt="Photo locations" />' +
        '</div>';
      } else {
        body = '<div class="p86-report-preview-empty">No located photos in this section.</div>';
      }



    } else {
      var photos = Array.isArray(section.photos) ? section.photos : [];
      if (!photos.length) {
        body = '<div class="p86-report-preview-empty">No photos in this section.</div>';
      } else {
        var cls = (layout === 'single-photo')
          ? 'p86-report-preview-section-stack size-' + esc(size)
          : 'p86-report-preview-section-grid size-' + esc(size);
        body = '<div class="' + cls + '">' +
          photos.map(function (p) { return photoCardHTML(section, p); }).join('') +
        '</div>';
      }
    }

    return '<section class="p86-report-preview-section" data-section-id="' + escAttr(section.id || '') + '">' +
      (section.label ? '<h2 class="p86-report-preview-section-label">' + esc(section.label) + '</h2>' : '') +
      body +
    '</section>';
  }

  // Cover page. Keys are rendered in a fixed order rather than by iterating the
  // object, so a key the server adds later cannot appear on a client's cover
  // without someone deciding where it goes.
  var COVER_ROWS = [
    ['walkthrough_date', 'Walkthrough date'], ['walkthrough_with', 'Walked with'],
    ['date', 'Date'], ['pm_name', 'Prepared by'],
    ['crew', 'Crew'], ['weather', 'Weather'], ['hours_on_site', 'Hours on site'],
    ['week_ending', 'Week ending'], ['project_phase', 'Phase'], ['schedule_status', 'Schedule'],
    ['stamped_by', 'Stamped by'], ['license_number', 'License #'], ['signed_date', 'Signed'],
    ['submittal_number', 'Submittal #'], ['spec_section', 'Spec section'],
    ['supplier', 'Supplier'], ['approval_block', 'Approval'],
    ['survey_date', 'Survey date'], ['surveyed_by', 'Surveyed by'], ['building', 'Building'],
    ['co_number', 'CO #'], ['co_amount', 'Amount'], ['requested_by', 'Requested by']
  ];

  // A template-specific date SUPERSEDES the generic one. A punch list carries a
  // walkthrough date, a survey carries a survey date, a weekly report carries a
  // week ending — and the cover was printing both, so a walkthrough read
  // "WALKTHROUGH DATE Aug 25 · DATE Aug 25". The generic field still exists and
  // is still stored; it just stops being drawn when a more specific one says
  // the same thing better.
  var SPECIFIC_DATE_KEYS = ['walkthrough_date', 'survey_date', 'week_ending', 'signed_date'];

  function coverHTML(doc) {
    var c = doc.cover_page || {};
    if (!c.enabled) return '';
    var hasSpecificDate = SPECIFIC_DATE_KEYS.some(function (k) { return !!c[k]; });
    var rows = COVER_ROWS.map(function (pair) {
      var v = c[pair[0]];
      if (!v) return '';
      if (pair[0] === 'date' && hasSpecificDate) return '';
      return '<div><span class="k">' + esc(pair[1]) + '</span>' +
             '<span class="v">' + esc(v) + '</span></div>';
    }).filter(Boolean).join('');
    var company = c.company_name || doc.org_name || '';
    return '<div class="p86-report-cover-rendered print-only">' +
      (company ? '<div class="p86-report-cover-company">' + esc(company) + '</div>' : '') +
      (c.subtitle ? '<div class="p86-report-cover-subtitle">' + esc(c.subtitle) + '</div>' : '') +
      '<h1 class="p86-report-cover-title">' + esc(doc.title || 'Project Report') + '</h1>' +
      (c.address || doc.project_address
        ? '<div class="p86-report-cover-addr">' + esc(c.address || doc.project_address) + '</div>' : '') +
      (rows ? '<div class="p86-report-cover-meta">' + rows + '</div>' : '') +
    '</div>';
  }

  function render(doc) {
    doc = doc || {};
    var sections = Array.isArray(doc.sections) ? doc.sections : [];
    return '<div class="p86-report-preview-paper" data-style-pack="' + escAttr(doc.style_pack || 'clean') + '">' +
      coverHTML(doc) +
      (doc.summary ? '<div class="p86-report-preview-summary">' + esc(doc.summary) + '</div>' : '') +
      sections.map(sectionHTML).join('') +
    '</div>';
  }

  // Post-mount work that needs real elements: paint each annotation overlay on
  // a canvas sized from the IMAGE THAT LOADED, and hide a location map that
  // failed to load rather than leaving a broken-image icon on a client's page.
  //
  // Annotation strokes are stored in the coordinate space of the web variant,
  // so the canvas must match that image's intrinsic size — sizing it from the
  // displayed box puts every stroke in the wrong place.
  function wire(container, doc) {
    if (!container) return;
    var byId = {};
    (((doc || {}).sections) || []).forEach(function (s) {
      (s.photos || []).forEach(function (p) { byId[p.id] = p; });
    });

    Array.prototype.forEach.call(container.querySelectorAll('[data-anno-photo]'), function (canvas) {
      var photo = byId[canvas.getAttribute('data-anno-photo')];
      if (!photo || !photo.annotations || !photo.annotations.length) return;
      var img = canvas.parentElement && canvas.parentElement.querySelector('img');
      if (!img) return;
      function paint() {
        var w = img.naturalWidth, h = img.naturalHeight;
        if (!w || !h) return;
        canvas.width = w; canvas.height = h;
        // The stroke renderer is optional: without it the photo still shows,
        // just unannotated. A guest page that cannot draw a line must not fail
        // to deliver the report.
        if (window.p86AnnotationRender && window.p86AnnotationRender.renderAll) {
          try { window.p86AnnotationRender.renderAll(canvas.getContext('2d'), photo.annotations); }
          catch (e) { /* one bad stroke must not kill the page */ }
        }
      }
      if (img.complete && img.naturalWidth) paint();
      else img.addEventListener('load', paint, { once: true });
    });

    // Upgrade each photo-map section to an interactive map — ONLY if Leaflet is
    // actually present. Same optional-capability pattern as the annotation
    // renderer above: absent, the baked static image underneath simply stays,
    // and the section still delivers its information. A guest page that cannot
    // load a map library must not lose the report.
    if (window.L && window.L.map) {
      Array.prototype.forEach.call(container.querySelectorAll('[data-map-section]'), function (host) {
        var sid = host.getAttribute('data-map-section');
        var section = (((doc || {}).sections) || []).find(function (s) { return String(s.id || '') === sid; });
        if (!section) return;
        var pins = (section.photos || []).filter(function (p) { return p.lat != null && p.lng != null; });
        if (!pins.length) return;

        var live = document.createElement('div');
        live.className = 'p86-report-map-live';
        host.appendChild(live);

        try {
          var map = window.L.map(live, { scrollWheelZoom: true, attributionControl: true });
          window.L.tileLayer(
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
            { maxZoom: 21, maxNativeZoom: 19,
              attribution: 'Imagery &copy; Esri, Maxar, Earthstar Geographics' }
          ).addTo(map);

          var bounds = [];
          fanOutPins(pins).forEach(function (fanned) {
            var p = fanned.point, lat = fanned.lat, lng = fanned.lng;
            bounds.push([lat, lng]);
            var marker = window.L.marker([lat, lng], {
              icon: window.L.divIcon({
                className: '',
                html: '<div class="p86-report-map-pin">' + esc(String(p.num || '')) + '</div>',
                iconSize: [26, 26], iconAnchor: [13, 13]
              })
            }).addTo(map);
            var thumb = p.thumb_url || p.web_url || '';
            marker.bindPopup(
              '<div class="p86-report-map-pop">' +
                (thumb ? '<img src="' + escAttr(thumb) + '" alt="" />' : '') +
                (p.num ? '<div class="p86-report-map-pop-n">Photo ' + esc(String(p.num)) + '</div>' : '') +
                (p.caption ? '<div class="p86-report-map-pop-cap">' + esc(p.caption) + '</div>' : '') +
              '</div>', { minWidth: 200 });
          });

          if (bounds.length > 1) map.fitBounds(bounds, { padding: [36, 36] });
          else map.setView(bounds[0], 18);

          // The interactive map replaced the static one on screen. The static
          // image stays in the DOM and comes back for print, where a live map
          // would print whatever the reader happened to pan to.
          host.classList.add('has-live-map');
        } catch (e) {
          // Any failure leaves the baked image visible rather than an empty box.
          if (live.parentNode) live.parentNode.removeChild(live);
        }
      });
    }

    Array.prototype.forEach.call(container.querySelectorAll('.p86-report-preview-map img'), function (img) {
      img.addEventListener('error', function () {
        var wrap = img.parentElement;
        if (wrap) wrap.innerHTML = '<div class="p86-report-map-unavailable">Location map unavailable.</div>';
      }, { once: true });
    });
  }

  function mount(container, doc) {
    if (!container) return null;
    container.innerHTML = render(doc);
    wire(container, doc);
    return container;
  }

  window.p86ReportDocument = { render: render, wire: wire, mount: mount, fanOutPins: fanOutPins };
})();
