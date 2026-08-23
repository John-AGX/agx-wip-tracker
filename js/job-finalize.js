// Shared "Finalize Job" modal — collects the REQUIRED job number and the title
// before a job is created from a lead or an estimate. The title is pre-filled
// "{client short name} {proposal name}" and is editable; the job number is
// required + format-validated. Self-contained (inline themed styles) so
// leads.js / estimate-editor.js can both call it.
//
// The prefixes and their labels come from the ORG REGISTRY
// (branding.job_types — Admin → Organization → Job Numbering), not from a
// hardcoded S/RV pair. That is why adding a type (M, Mid-Tier Service) shows up
// here with no edit: the hint line, the suggestion chips and the error text are
// all generated from whatever types the org actually numbers under.
//
//   window.p86JobFinalize.open({ title, subtitle })
//     -> Promise<{ jobNumber, title } | null>   (null = cancelled)
//   window.p86JobFinalize.normalizeNumber(str)  -> 'S0000' | 'RV0000' | null
(function () {
  'use strict';

  // Valid = a 1–4 letter prefix (S, RV, WO, or a custom org prefix) + digits.
  // Returns the normalized (upper-prefix) value or null. Widened from the old
  // S/RV-only rule now that the org registry defines the prefixes.
  function normalizeNumber(v) {
    var m = String(v == null ? '' : v).trim().match(/^([A-Za-z]{1,4})\s*(\d{1,6})$/);
    if (!m) return null;
    return m[1].toUpperCase() + m[2];
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // ── Org job-numbering registry ────────────────────────────────────────
  // The source of truth is branding.job_types [{key,label,prefix,pad,next}]
  // (Admin → Organization). Cached here; the server is authoritative on the
  // ACTUAL claim (atomic + collision-safe). All of this degrades gracefully to
  // derive-from-max when the registry / endpoint isn't available.
  var _registry = null, _regLoaded = false, _regPromise = null;

  // The product defaults. GET /api/org/branding serves them as
  // `job_types_default` (straight out of server/services/job-types.js), so
  // this literal is a LAST RESORT only — first paint, offline, failed fetch.
  // It is the ONE copy left in the browser: everything that used to keep its
  // own (js/admin.js's first-time seed, the hint line, the suggestion chips)
  // now reads defaults() instead. Keep it complete; the two copies this
  // replaced had both silently dropped Work Order.
  var _defaults = [
    { key: 'service', label: 'Service', prefix: 'S', pad: 4 },
    { key: 'mid_tier_service', label: 'Mid-Tier Service', prefix: 'M', pad: 4 },
    { key: 'renovation', label: 'Renovation', prefix: 'RV', pad: 4 },
    { key: 'work_order', label: 'Work Order', prefix: 'WO', pad: 4 }
  ];
  function defaults() { return _defaults.slice(); }

  function loadRegistry(force) {
    if (_regLoaded && !force) return Promise.resolve(_registry);
    if (_regPromise && !force) return _regPromise;
    if (!(window.p86Api && window.p86Api.org && window.p86Api.org.branding)) { _regLoaded = true; _registry = []; return Promise.resolve(_registry); }
    _regPromise = window.p86Api.org.branding().then(function (r) {
      _registry = (r && r.branding && Array.isArray(r.branding.job_types)) ? r.branding.job_types : [];
      if (r && Array.isArray(r.job_types_default) && r.job_types_default.length) _defaults = r.job_types_default;
      _regLoaded = true; return _registry;
    }).catch(function () { _regLoaded = true; _registry = []; return _registry; });
    return _regPromise;
  }
  function getTypes() { return _registry || []; }
  // What a picker or a label lookup should treat as "the types this org has".
  // The org registry when we have it, the product defaults until we do — so a
  // cold cache degrades to the shipped set instead of to nothing.
  function effectiveTypes() { var t = getTypes(); return (t && t.length) ? t : _defaults; }
  function typeForLabel(label) { label = String(label || '').toLowerCase(); return getTypes().find(function (t) { return String(t.label || '').toLowerCase() === label; }) || null; }
  function pad(n, width) { var s = String(Math.max(1, parseInt(n, 10) || 1)); width = Math.max(1, Math.min(8, parseInt(width, 10) || 4)); while (s.length < width) s = '0' + s; return s; }
  function maxExistingFor(prefix) {
    var re = new RegExp('^' + String(prefix || '') + '(\\d+)$', 'i');
    var jobs = (window.appData && window.appData.jobs) || [];
    var max = 0;
    for (var i = 0; i < jobs.length; i++) {
      var m = String((jobs[i] && jobs[i].jobNumber) || '').trim().match(re);
      if (m) { var n = parseInt(m[1], 10); if (isFinite(n) && n > max) max = n; }
    }
    return max;
  }
  // Non-consuming preview of the next number for a registry type (registry
  // counter, floored above the highest existing number so it never collides).
  function previewFor(t) {
    if (!t) return null;
    var n = Math.max(parseInt(t.next, 10) || 1, maxExistingFor(t.prefix) + 1);
    return String(t.prefix) + pad(n, t.pad);
  }
  // Suggestion for a prefix: registry-aware when the prefix maps to a type,
  // else the old derive-from-max (null when there's no prior job).
  function nextNumber(prefix) {
    prefix = String(prefix || '').toUpperCase();
    var t = getTypes().find(function (x) { return String(x.prefix || '').toUpperCase() === prefix; });
    if (t) return previewFor(t);
    var maxE = maxExistingFor(prefix);
    if (!maxE) return null;
    return prefix + pad(maxE + 1, 4);
  }
  // Atomically CLAIM the next number for a type (bumps the server counter).
  // Falls back to the non-consuming preview if the endpoint isn't reachable.
  function claimFor(t) {
    if (!t) return Promise.resolve(null);
    if (window.p86Api && window.p86Api.org && window.p86Api.org.nextJobNumber) {
      return window.p86Api.org.nextJobNumber({ key: t.key, prefix: t.prefix })
        .then(function (r) { return (r && r.jobNumber) || previewFor(t); })
        .catch(function () { return previewFor(t); });
    }
    return Promise.resolve(previewFor(t));
  }
  function claimForLabel(label) { var t = typeForLabel(label); return t ? claimFor(t) : Promise.resolve(null); }
  // Every registry prefix, for callers that need to know which shapes this org
  // numbers under (the QB import's unmatched-project diagnosis reads this so a
  // type with NO jobs yet is still a known prefix).
  function prefixes() {
    return getTypes().map(function (t) { return String(t.prefix || '').toUpperCase(); }).filter(Boolean);
  }
  /* ── Reading a job number back to its type ─────────────────────────────
   * A job number is IDENTITY: S2287, RV2044, M0001. These two answer "what
   * type is this?" for every display surface, off the SAME registry the
   * numbers are minted from — replacing the hand-written startsWith() chains
   * that js/jobs.js and js/insights.js each kept their own copy of.
   *
   * No longest-prefix-first ordering hazard here, because the prefix isn't
   * probed a letter at a time: the whole leading letter RUN is extracted and
   * looked up exactly. 'RV2044' yields 'RV', never 'R'; 'M0001' yields 'M',
   * never a partial match against 'Mid-Tier'. That also means a custom org
   * prefix that starts with another one (S and SV) resolves correctly, which
   * an ordered chain cannot promise.
   *
   * READING a number is NOT the same question as "what types does this org
   * offer?", and they must not share an answer. The offer is the org's
   * registry: an org that stopped doing work orders should not be handed Work
   * Order in a picker. The reading is about a job that ALREADY EXISTS — its
   * number was minted under some prefix, and that prefix means what it meant,
   * whether or not the org still numbers under it today.
   *
   * Answering the reading question with effectiveTypes() (registry, or the
   * product defaults only while the registry is EMPTY) made a non-empty
   * registry that omits a default type render nothing: measured, with a
   * registry of [S, M, RV], labelForNumber('WO0007') returned '' where the
   * hardcoded chain this replaced always returned 'Work Order'. A job that
   * exists then displayed with no type at all — and since js/leads.js and
   * js/estimate-editor.js now DERIVE a converted job's jobType from its
   * number, such a job would also be born with none.
   *
   * So the lookup is: the org registry first (a renamed type wins over the
   * shipped one), then the product defaults (a prefix this product ships
   * always means something), then unknown. Unknown stays '' — a prefix
   * neither the org nor the product knows is not a type, and inventing a
   * label from the letters would put it in type filters and reports as though
   * somebody had chosen it.
   * ─────────────────────────────────────────────────────────────────────*/
  function typeForPrefix(prefix) {
    var p = String(prefix == null ? '' : prefix).toUpperCase();
    if (!p) return null;
    var hit = function (list) {
      return (list || []).filter(function (x) { return String(x.prefix || '').toUpperCase() === p; })[0] || null;
    };
    return hit(getTypes()) || hit(_defaults);
  }
  function prefixForNumber(jobNumber) {
    var m = String(jobNumber == null ? '' : jobNumber).trim().toUpperCase().match(/^([A-Z]{1,4})\s*\d/);
    if (!m) return '';
    var t = typeForPrefix(m[1]);
    return t ? String(t.prefix).toUpperCase() : '';
  }
  function labelForPrefix(prefix) {
    var t = typeForPrefix(prefix);
    return t ? String(t.label || String(prefix).toUpperCase()) : '';
  }
  function labelForNumber(jobNumber) { return labelForPrefix(prefixForNumber(jobNumber)); }

  /* ── The job-type picker ───────────────────────────────────────────────
   * THE INVARIANT: a picker must never be able to change a value the user
   * did not touch. A <select> that does not contain the record's current
   * value silently resolves to its FIRST option, and the next save writes
   * that — turning "I edited the title" into "I reclassified this job".
   *
   * So the option list is registry-first and then ALWAYS unions in whatever
   * the record actually holds, whether or not this org still numbers under
   * it. This is the same shape js/markets.js:names(current) uses, and for
   * the same reason. It has to hold for ANY unrecognized value, not for a
   * named list of them: jobs converted from a lead carry the LEAD vocabulary
   * ('Service & Repair'), which is not a job type and never will be.
   *
   * A job with NO type gets a real empty option FIRST, so the pre-selected
   * option is a no-op rather than the alphabetically luckiest type.
   * ─────────────────────────────────────────────────────────────────────*/
  function typeLabels(current) {
    var out = effectiveTypes().map(function (t) { return String(t.label || t.prefix || ''); }).filter(Boolean);
    var cur = (current == null) ? '' : String(current);
    if (cur && out.indexOf(cur) === -1) out.unshift(cur);
    return out;
  }
  // <option> markup for a job-type <select>, with `selected` on the current
  // value. Use this rather than building options from typeLabels() by hand —
  // the empty "not set" option carries value="" and cannot be expressed as a
  // label string.
  function typeOptionsHTML(current) {
    var cur = (current == null) ? '' : String(current);
    var html = cur ? '' : '<option value="" selected>&mdash; Not set &mdash;</option>';
    return html + typeLabels(cur).map(function (label) {
      return '<option value="' + esc(label) + '"' + (label === cur ? ' selected' : '') + '>' + esc(label) + '</option>';
    }).join('');
  }
  // Rebuild a standing filter <select> from the registry, keeping its leading
  // "all" option and the user's current selection. Same drift problem as the
  // picker, without the data risk — this one only filters a list.
  function setupTypeFilter(selectId) {
    var sel = document.getElementById(selectId);
    if (!sel) return;
    loadRegistry().then(function (types) {
      if (!types || !types.length) return;
      var cur = sel.value;
      var head = sel.options.length && !sel.options[0].value ? sel.options[0].outerHTML : '<option value="">All Types</option>';
      sel.innerHTML = head + typeLabels(cur).map(function (label) {
        return '<option value="' + esc(label) + '">' + esc(label) + '</option>';
      }).join('');
      sel.value = cur;
    });
  }

  // "S#### (Service), M#### (Mid-Tier Service), RV#### (Renovation)" — built
  // from the registry so a new type never needs this string edited. Falls back
  // to the product defaults before the registry has loaded.
  function typeHint() {
    var types = effectiveTypes();
    return types.slice(0, 6).map(function (t) {
      return String(t.prefix) + new Array(Math.max(1, Math.min(8, parseInt(t.pad, 10) || 4)) + 1).join('#') +
        ' (' + String(t.label || t.prefix) + ')';
    });
  }

  // Wire a create form (a job-type <select> + a job-number <input>): populate
  // the type options from the registry and auto-fill the number preview when a
  // type is picked. Editing the number clears the auto-flag so saveJob knows to
  // use the typed override instead of claiming.
  function setupCreateModal(typeSelId, numInputId) {
    var sel = document.getElementById(typeSelId), num = document.getElementById(numInputId);
    if (!sel || !num) return;
    num.setAttribute('data-autofilled', '0');
    if (!num._jnWired) { num._jnWired = true; num.addEventListener('input', function () { num.setAttribute('data-autofilled', '0'); }); }
    loadRegistry().then(function (types) {
      if (types && types.length) {
        var cur = sel.value;
        sel.innerHTML = '<option value="">-- Select Type --</option>' + types.map(function (t) { return '<option value="' + esc(t.label) + '">' + esc(t.label) + '</option>'; }).join('');
        if (cur) sel.value = cur;
      }
      sel.onchange = function () {
        var t = typeForLabel(sel.value);
        if (t) { num.value = previewFor(t); num.setAttribute('data-autofilled', '1'); }
      };
    });
  }

  function open(opts) {
    opts = opts || {};
    return new Promise(function (resolve) {
      var modal = document.createElement('div');
      modal.className = 'p86-jobfin-modal';
      modal.style.cssText = 'position:fixed;inset:0;z-index:9200;background:rgba(0,0,0,.6);display:flex;align-items:flex-start;justify-content:center;padding:40px 16px;overflow-y:auto;';
      var card = 'background:var(--surface,#17171c);border:1px solid var(--border,#2a2a32);border-radius:14px;width:100%;max-width:440px;box-shadow:0 20px 60px rgba(0,0,0,.5);';
      var lbl = 'font-size:12px;font-weight:600;color:var(--text-dim,#b4b4bf);display:block;margin-bottom:5px;';
      var inp = 'appearance:none;width:100%;box-sizing:border-box;background:var(--input-bg,#101014);border:1px solid var(--border,#2a2a32);color:var(--text,#eef0f6);border-radius:8px;padding:9px 10px;font-size:14px;';
      var btn = 'appearance:none;border:1px solid var(--border,#2a2a32);background:var(--surface,#17171c);color:var(--text,#eef0f6);border-radius:8px;padding:8px 14px;font-size:13px;font-weight:600;cursor:pointer;';
      var btnPri = 'appearance:none;border:1px solid var(--accent,#4f8cff);background:var(--accent,#4f8cff);color:#fff;border-radius:8px;padding:8px 14px;font-size:13px;font-weight:700;cursor:pointer;';
      var chip = 'appearance:none;border:1px solid var(--border,#2a2a32);background:transparent;color:var(--accent,#4f8cff);border-radius:999px;padding:2px 9px;font-size:11px;font-weight:700;cursor:pointer;font-family:inherit;';
      var _prefixes = effectiveTypes().map(function (t) { return String(t.prefix || '').toUpperCase(); }).filter(Boolean);
      var sugg = _prefixes.map(nextNumber).filter(Boolean);
      var _hints = typeHint();
      var _hintHTML = _hints.map(function (h) {
        var i = h.indexOf(' (');
        return '<strong>' + esc(h.slice(0, i)) + '</strong>' + esc(h.slice(i));
      }).join(', ');
      modal.innerHTML =
        '<div style="' + card + '">' +
          '<div style="padding:16px;">' +
            '<div style="font-size:16px;font-weight:700;color:var(--text,#eef0f6);margin-bottom:' + (opts.subtitle ? '4px' : '14px') + ';">Finalize Job</div>' +
            (opts.subtitle ? '<div style="font-size:12px;color:var(--text-dim,#b4b4bf);margin-bottom:14px;line-height:1.5;">' + esc(opts.subtitle) + '</div>' : '') +
            '<div style="margin-bottom:14px;">' +
              '<label style="' + lbl + '">Job Number <span style="color:#f0a020;">*</span></label>' +
              '<input id="p86jfNum" style="' + inp + '" placeholder="' + esc((sugg[0] || _prefixes[0] + '0000')) + '" autocomplete="off" />' +
              '<div style="font-size:11px;color:var(--text-dim,#b4b4bf);margin-top:5px;">Required &mdash; ' + _hintHTML + '. Editable.</div>' +
              (sugg.length
                ? '<div style="display:flex;gap:6px;align-items:center;margin-top:7px;flex-wrap:wrap;">' +
                    '<span style="font-size:11px;color:var(--text-dim,#b4b4bf);">Next available:</span>' +
                    sugg.map(function (s) {
                      return '<button type="button" data-jfsugg="' + esc(s) + '" style="' + chip + '">' + esc(s) + '</button>';
                    }).join('') +
                  '</div>'
                : '') +
              '<div id="p86jfErr" style="font-size:11px;color:#ff6b6b;margin-top:5px;display:none;">Enter a valid job number: ' + esc(_hints.join(', ')) + '.</div>' +
            '</div>' +
            '<div style="margin-bottom:18px;">' +
              '<label style="' + lbl + '">Job Title</label>' +
              '<input id="p86jfTitle" style="' + inp + '" placeholder="Client — proposal name" autocomplete="off" />' +
            '</div>' +
            '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
              '<button id="p86jfCancel" style="' + btn + '">Cancel</button>' +
              '<button id="p86jfOk" style="' + btnPri + '">Create Job</button>' +
            '</div>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);

      var numEl = modal.querySelector('#p86jfNum');
      var titleEl = modal.querySelector('#p86jfTitle');
      var errEl = modal.querySelector('#p86jfErr');
      titleEl.value = opts.title || '';
      setTimeout(function () { numEl.focus(); }, 30);

      var done = false;
      function close(result) { if (done) return; done = true; modal.remove(); resolve(result || null); }
      function submit() {
        var n = normalizeNumber(numEl.value);
        if (!n) { errEl.style.display = ''; numEl.style.borderColor = '#ff6b6b'; numEl.focus(); return; }
        close({ jobNumber: n, title: (titleEl.value || '').trim() });
      }
      numEl.addEventListener('input', function () { errEl.style.display = 'none'; numEl.style.borderColor = ''; });
      // Suggestion chips fill the field rather than submitting — the number is
      // still the user's call, they just don't have to go look it up.
      Array.prototype.forEach.call(modal.querySelectorAll('[data-jfsugg]'), function (b) {
        b.addEventListener('click', function () {
          numEl.value = b.getAttribute('data-jfsugg');
          errEl.style.display = 'none'; numEl.style.borderColor = '';
          numEl.focus();
        });
      });
      numEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      titleEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
      modal.querySelector('#p86jfOk').addEventListener('click', submit);
      modal.querySelector('#p86jfCancel').addEventListener('click', function () { close(null); });
      modal.addEventListener('click', function (e) { if (e.target === modal) close(null); });
    });
  }

  var API = {
    open: open, normalizeNumber: normalizeNumber, nextNumber: nextNumber,
    loadRegistry: loadRegistry, getTypes: getTypes, previewFor: previewFor,
    claimForLabel: claimForLabel, setupCreateModal: setupCreateModal,
    prefixes: prefixes, typeHint: typeHint,
    // One source for "what job types are there?" in the browser.
    defaults: defaults, effectiveTypes: effectiveTypes,
    typeForPrefix: typeForPrefix,
    prefixForNumber: prefixForNumber, labelForPrefix: labelForPrefix,
    labelForNumber: labelForNumber,
    typeLabels: typeLabels, typeOptionsHTML: typeOptionsHTML,
    setupTypeFilter: setupTypeFilter
  };
  if (typeof window !== 'undefined') {
    window.p86JobFinalize = API;
    // Shorthand for the render functions that build pickers by string concat,
    // mirroring window.p86MarketNames (js/markets.js:239).
    window.p86JobTypeOptions = typeOptionsHTML;
    // Warm the registry cache so create/convert modals have it ready.
    try { loadRegistry(); } catch (e) {}
  }
  // Test seam. This is a browser script, not a module; re-exported under Node
  // (jest) so the picker invariant — an unrecognized job type survives a
  // round-trip through a real <select> — can be driven directly.
  if (typeof module !== 'undefined' && module.exports) module.exports = API;
})();
