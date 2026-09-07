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
      // The map image is BAKED at publish time and arrives as section.map_url.
      // This renderer never builds a Maps URL, because doing so would need the
      // API key — and handing a Maps key to an anonymous page is how a key
      // ends up being billed by strangers. No baked map degrades to the photo
      // grid rather than showing a broken image.
      var mapped = (section.photos || []).filter(function (p) { return p.lat != null && p.lng != null; });
      if (section.map_url) {
        body = '<div class="p86-report-preview-map">' +
          '<img src="' + escAttr(section.map_url) + '" alt="Photo locations" />' +
        '</div>';
      } else if (mapped.length) {
        body = '<div class="p86-report-preview-section-grid size-' + esc(size) + '">' +
          mapped.map(function (p) { return photoCardHTML(section, p); }).join('') +
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

  function coverHTML(doc) {
    var c = doc.cover_page || {};
    if (!c.enabled) return '';
    var rows = COVER_ROWS.map(function (pair) {
      var v = c[pair[0]];
      if (!v) return '';
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

  window.p86ReportDocument = { render: render, wire: wire, mount: mount };
})();
