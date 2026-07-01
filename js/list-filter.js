// Reusable filter drawer for list pages (Cost Inbox first, then Jobs/Leads/
// Estimates). Config-driven: a page hands in a field spec + current values and
// gets a right-side drawer that matches the AppSpace/BT filter panel. The page
// owns the actual row filtering — this component only collects the values.
//
//   window.p86FilterDrawer.open({
//     title: 'Filter',
//     fields: [ {key,label,type,options?,placeholder?}, ... ],
//     values: { ...current },
//     onApply: function(values){ ... },
//     onClear: function(){ ... }         // optional
//   })
//
// Field types:
//   chips     — multi-select pills (options:[{v,label}]); value = [v,...]
//   text      — free text; value = string
//   select    — single dropdown (options:[{v,label}]); value = v
//   daterange — preset dropdown + custom from/to; value = {preset,from,to}
//   numrange  — preset dropdown + custom min/max;   value = {preset,min,max}
//
// window.p86FilterDrawer.countActive(fields, values) → how many fields are set
// (for the "Filter (N)" badge). window.p86FilterDrawer.emptyValues(fields) →
// a cleared value object.
'use strict';
(function () {
  if (window.p86FilterDrawer) return;

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  var DATE_PRESETS = [
    { v: 'all', label: 'All dates' },
    { v: 'this_month', label: 'This month' },
    { v: 'last_month', label: 'Last month' },
    { v: 'last_30', label: 'Last 30 days' },
    { v: 'this_year', label: 'This year' },
    { v: 'custom', label: 'Custom range…' }
  ];
  var NUM_PRESETS = [
    { v: 'all', label: '— ALL —' },
    { v: 'lt100', label: 'Under $100' },
    { v: '100_500', label: '$100 – $500' },
    { v: '500_1000', label: '$500 – $1,000' },
    { v: 'gt1000', label: 'Over $1,000' },
    { v: 'custom', label: 'Custom range…' }
  ];

  function isSet(f, v) {
    if (v == null) return false;
    if (f.type === 'chips') return Array.isArray(v) && v.length > 0;
    if (f.type === 'text') return String(v).trim() !== '';
    if (f.type === 'select') return String(v) !== '';
    if (f.type === 'daterange') return v && v.preset && v.preset !== 'all';
    if (f.type === 'numrange') return v && v.preset && v.preset !== 'all';
    return false;
  }
  function countActive(fields, values) {
    values = values || {};
    return (fields || []).reduce(function (n, f) { return n + (isSet(f, values[f.key]) ? 1 : 0); }, 0);
  }
  function emptyValues(fields) {
    var out = {};
    (fields || []).forEach(function (f) {
      if (f.type === 'chips') out[f.key] = [];
      else if (f.type === 'daterange') out[f.key] = { preset: 'all', from: '', to: '' };
      else if (f.type === 'numrange') out[f.key] = { preset: 'all', min: '', max: '' };
      else out[f.key] = '';
    });
    return out;
  }

  function fieldHtml(f, v) {
    var body;
    if (f.type === 'chips') {
      var sel = Array.isArray(v) ? v : [];
      body = '<div class="pf-chips" data-key="' + esc(f.key) + '">' + (f.options || []).map(function (o) {
        var on = sel.indexOf(o.v) >= 0;
        return '<button type="button" class="pf-chip' + (on ? ' on' : '') + '" data-v="' + esc(o.v) + '">' + esc(o.label) + '</button>';
      }).join('') + '</div>';
    } else if (f.type === 'text') {
      body = '<input type="text" class="pf-input" data-key="' + esc(f.key) + '" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(v || '') + '" />';
    } else if (f.type === 'select') {
      body = '<select class="pf-input" data-key="' + esc(f.key) + '">' +
        (f.options || []).map(function (o) { return '<option value="' + esc(o.v) + '"' + (String(v) === String(o.v) ? ' selected' : '') + '>' + esc(o.label) + '</option>'; }).join('') +
        '</select>';
    } else if (f.type === 'daterange') {
      v = v || { preset: 'all' };
      body = '<select class="pf-input pf-preset" data-key="' + esc(f.key) + '" data-kind="date">' +
        DATE_PRESETS.map(function (o) { return '<option value="' + o.v + '"' + (v.preset === o.v ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>' +
        '<div class="pf-custom" data-key="' + esc(f.key) + '" style="' + (v.preset === 'custom' ? '' : 'display:none;') + '">' +
          '<input type="date" class="pf-input pf-from" value="' + esc(v.from || '') + '" /> <span class="pf-dash">→</span> <input type="date" class="pf-input pf-to" value="' + esc(v.to || '') + '" />' +
        '</div>';
    } else if (f.type === 'numrange') {
      v = v || { preset: 'all' };
      body = '<select class="pf-input pf-preset" data-key="' + esc(f.key) + '" data-kind="num">' +
        NUM_PRESETS.map(function (o) { return '<option value="' + o.v + '"' + (v.preset === o.v ? ' selected' : '') + '>' + o.label + '</option>'; }).join('') + '</select>' +
        '<div class="pf-custom" data-key="' + esc(f.key) + '" style="' + (v.preset === 'custom' ? '' : 'display:none;') + '">' +
          '<input type="number" step="0.01" min="0" class="pf-input pf-min" placeholder="Min $" value="' + esc(v.min || '') + '" /> <span class="pf-dash">→</span> <input type="number" step="0.01" min="0" class="pf-input pf-max" placeholder="Max $" value="' + esc(v.max || '') + '" />' +
        '</div>';
    } else { body = ''; }
    return '<div class="pf-field"><label class="pf-label">' + esc(f.label) + '</label>' + body + '</div>';
  }

  // Read the drawer DOM back into a values object.
  function collect(root, fields) {
    var out = {};
    fields.forEach(function (f) {
      if (f.type === 'chips') {
        var wrap = root.querySelector('.pf-chips[data-key="' + f.key + '"]');
        out[f.key] = wrap ? [].map.call(wrap.querySelectorAll('.pf-chip.on'), function (b) { return b.getAttribute('data-v'); }) : [];
      } else if (f.type === 'text' || f.type === 'select') {
        var el = root.querySelector('[data-key="' + f.key + '"]');
        out[f.key] = el ? el.value : '';
      } else if (f.type === 'daterange') {
        var ps = root.querySelector('.pf-preset[data-key="' + f.key + '"]');
        var cst = root.querySelector('.pf-custom[data-key="' + f.key + '"]');
        out[f.key] = { preset: ps ? ps.value : 'all', from: cst ? (cst.querySelector('.pf-from') || {}).value || '' : '', to: cst ? (cst.querySelector('.pf-to') || {}).value || '' : '' };
      } else if (f.type === 'numrange') {
        var ps2 = root.querySelector('.pf-preset[data-key="' + f.key + '"]');
        var cst2 = root.querySelector('.pf-custom[data-key="' + f.key + '"]');
        out[f.key] = { preset: ps2 ? ps2.value : 'all', min: cst2 ? (cst2.querySelector('.pf-min') || {}).value || '' : '', max: cst2 ? (cst2.querySelector('.pf-max') || {}).value || '' : '' };
      }
    });
    return out;
  }

  function open(cfg) {
    cfg = cfg || {};
    var fields = cfg.fields || [];
    var values = cfg.values || emptyValues(fields);

    var wrap = document.createElement('div');
    wrap.className = 'pf-overlay';
    wrap.innerHTML =
      '<div class="pf-drawer" role="dialog" aria-label="Filter">' +
        '<div class="pf-head"><span class="pf-title">' + esc(cfg.title || 'Filter') + '</span><button type="button" class="pf-x" aria-label="Close">&times;</button></div>' +
        '<div class="pf-body">' + fields.map(function (f) { return fieldHtml(f, values[f.key]); }).join('') + '</div>' +
        '<div class="pf-foot"><button type="button" class="pf-btn" id="pfClear">Clear all</button><button type="button" class="pf-btn pf-btn-primary" id="pfApply">Apply filter</button></div>' +
      '</div>';
    document.body.appendChild(wrap);
    requestAnimationFrame(function () { wrap.classList.add('pf-in'); });

    function close() { wrap.classList.remove('pf-in'); setTimeout(function () { wrap.remove(); }, 180); document.removeEventListener('keydown', onKey); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    wrap.addEventListener('click', function (e) { if (e.target === wrap) close(); });
    wrap.querySelector('.pf-x').addEventListener('click', close);

    // chip toggles
    wrap.querySelectorAll('.pf-chip').forEach(function (b) {
      b.addEventListener('click', function () { b.classList.toggle('on'); });
    });
    // preset → show/hide custom row
    wrap.querySelectorAll('.pf-preset').forEach(function (ps) {
      ps.addEventListener('change', function () {
        var cst = wrap.querySelector('.pf-custom[data-key="' + ps.getAttribute('data-key') + '"]');
        if (cst) cst.style.display = (ps.value === 'custom') ? '' : 'none';
      });
    });

    wrap.querySelector('#pfClear').addEventListener('click', function () {
      if (typeof cfg.onClear === 'function') cfg.onClear();
      close();
    });
    wrap.querySelector('#pfApply').addEventListener('click', function () {
      var v = collect(wrap, fields);
      if (typeof cfg.onApply === 'function') cfg.onApply(v);
      close();
    });
  }

  // Resolve a daterange value to {from,to} ISO dates (YYYY-MM-DD) or null bounds.
  function resolveDateRange(v) {
    if (!v || !v.preset || v.preset === 'all') return { from: null, to: null };
    var now = new Date();
    var y = now.getFullYear(), m = now.getMonth();
    function iso(d) { return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
    if (v.preset === 'this_month') return { from: iso(new Date(y, m, 1)), to: iso(new Date(y, m + 1, 0)) };
    if (v.preset === 'last_month') return { from: iso(new Date(y, m - 1, 1)), to: iso(new Date(y, m, 0)) };
    if (v.preset === 'last_30') { var d = new Date(now); d.setDate(d.getDate() - 30); return { from: iso(d), to: iso(now) }; }
    if (v.preset === 'this_year') return { from: y + '-01-01', to: y + '-12-31' };
    if (v.preset === 'custom') return { from: v.from || null, to: v.to || null };
    return { from: null, to: null };
  }
  // Resolve a numrange value to {min,max} numbers or null bounds.
  function resolveNumRange(v) {
    if (!v || !v.preset || v.preset === 'all') return { min: null, max: null };
    if (v.preset === 'lt100') return { min: null, max: 100 };
    if (v.preset === '100_500') return { min: 100, max: 500 };
    if (v.preset === '500_1000') return { min: 500, max: 1000 };
    if (v.preset === 'gt1000') return { min: 1000, max: null };
    if (v.preset === 'custom') return { min: v.min !== '' ? Number(v.min) : null, max: v.max !== '' ? Number(v.max) : null };
    return { min: null, max: null };
  }

  window.p86FilterDrawer = { open: open, countActive: countActive, emptyValues: emptyValues, resolveDateRange: resolveDateRange, resolveNumRange: resolveNumRange };
})();
