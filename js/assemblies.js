// Assemblies — costed recipes for estimating. List + recipe editor,
// mounted as an Estimates sub-tab (Directory → Assemblies), mirroring the
// Clients/Subs pattern. An assembly prices ONE OUTPUT UNIT of installed
// work as a bill of items: catalog materials (live-priced), manual
// labor/sub/gc rates, and nested sub-assemblies. The Materials Drawer's
// Assemblies mode inserts these into estimates.
(function () {
  'use strict';

  var KINDS = [
    { v: 'material', label: 'Material' },
    { v: 'labor',    label: 'Labor' },
    { v: 'sub',      label: 'Sub' },
    { v: 'gc',       label: 'GC' },
    { v: 'assembly', label: 'Sub-assembly' }
  ];
  var KIND_DEFAULT_CODE = { material: 'materials', labor: 'labor', sub: 'sub', gc: 'gc' };

  var _list = [];          // last-fetched assemblies (list shape w/ unit_cost)
  var _editing = null;     // { header, items } while the editor overlay is open
  var _matTimer = null;    // material-search debounce
  var _taxonomy = null;    // { trades:[{code,name}], systems:[{trade_code,code,name,default_unit}] }
  var _collapsed = {};     // trade code → collapsed in the tree

  function up(s) { return String(s == null ? '' : s).trim().toUpperCase(); }

  // Client mirror of the server's normalizeCode (TRADE-SYSTEM-VARIANT).
  function clientCode(t, s, v) {
    var vv = up(v).replace(/[^A-Z0-9/]/g, '').slice(0, 10);
    return [up(t).replace(/[^A-Z0-9]/g, ''), up(s).replace(/[^A-Z0-9]/g, ''), vv].filter(Boolean).join('-');
  }

  // Load the code registry once (cached). Refreshed on tab re-render.
  function ensureTaxonomy() {
    if (_taxonomy) return Promise.resolve(_taxonomy);
    if (!window.p86Api || !window.p86Api.assemblyTaxonomy) { _taxonomy = { trades: [], systems: [], variants: [] }; return Promise.resolve(_taxonomy); }
    return window.p86Api.assemblyTaxonomy.list().then(function (res) {
      _taxonomy = { trades: res.trades || [], systems: res.systems || [], variants: res.variants || [] };
      return _taxonomy;
    }).catch(function () { _taxonomy = { trades: [], systems: [], variants: [] }; return _taxonomy; });
  }
  function tradeName(code) { var t = ((_taxonomy && _taxonomy.trades) || []).find(function (x) { return up(x.code) === up(code); }); return t ? t.name : (code || 'Unclassified'); }
  function systemName(trade, code) { if (!code) return null; var s = ((_taxonomy && _taxonomy.systems) || []).find(function (x) { return up(x.trade_code) === up(trade) && up(x.code) === up(code); }); return s ? s.name : code; }

  // Dropdown option builders. Preserve an unlisted current value so editing a
  // legacy/free-text row doesn't silently drop its trade/system.
  function tradeOptions(selected) {
    var trades = (_taxonomy && _taxonomy.trades) || [];
    var opts = '<option value="">— trade —</option>';
    var found = trades.some(function (t) { return up(t.code) === up(selected); });
    if (selected && !found) opts += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (unlisted)</option>';
    trades.forEach(function (t) { opts += '<option value="' + esc(t.code) + '"' + (up(selected) === up(t.code) ? ' selected' : '') + '>' + esc(t.name) + ' (' + esc(t.code) + ')</option>'; });
    return opts;
  }
  function systemOptions(trade, selected) {
    var systems = ((_taxonomy && _taxonomy.systems) || []).filter(function (s) { return up(s.trade_code) === up(trade); });
    var opts = '<option value="">— system —</option>';
    var found = systems.some(function (s) { return up(s.code) === up(selected); });
    if (selected && !found) opts += '<option value="' + esc(selected) + '" selected>' + esc(selected) + ' (unlisted)</option>';
    systems.forEach(function (s) { opts += '<option value="' + esc(s.code) + '"' + (up(selected) === up(s.code) ? ' selected' : '') + '>' + esc(s.name) + ' (' + esc(s.code) + ')</option>'; });
    return opts;
  }
  function selWrap(label, id, inner) {
    return '<label style="display:flex;flex-direction:column;gap:4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8a93a6);">' + esc(label) +
      '<select id="' + id + '" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:7px 9px;color:var(--text,#fff);font-size:13px;">' + inner + '</select></label>';
  }
  // Cataloged variants for a trade+system — datalist <option>s (pick or type).
  function variantOptions(trade, system) {
    var vs = ((_taxonomy && _taxonomy.variants) || []).filter(function (v) { return up(v.trade_code) === up(trade) && up(v.system_code) === up(system); });
    return vs.map(function (v) { return '<option value="' + esc(v.code) + '">' + esc(v.name) + (v.note ? ' — ' + esc(v.note) : '') + '</option>'; }).join('');
  }
  // Variant field = free-text input backed by a datalist of cataloged variants.
  function variantField(trade, system, val) {
    return '<label style="display:flex;flex-direction:column;gap:4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8a93a6);">Variant' +
      '<input id="asmEd_variant" list="asmEd_variantlist" autocomplete="off" placeholder="pick or type" value="' + esc(val || '') + '" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:7px 9px;color:var(--text,#fff);font-size:13px;" />' +
      '<datalist id="asmEd_variantlist">' + variantOptions(trade, system) + '</datalist></label>';
  }

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  // PWA-safe notice — native alert() silently no-ops in the installed app.
  function notify(msg) {
    if (window.p86Confirm) { try { window.p86Confirm({ title: 'Assemblies', message: msg, confirmText: 'OK' }); return; } catch (e) {} }
    alert(msg);
  }
  function money(n) { return (n == null || isNaN(n)) ? '—' : '$' + Number(n).toFixed(2); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // ── List view ───────────────────────────────────────────────────────
  // The list can render into more than one host (the classic Estimates →
  // Assemblies pane and the new Assembly Studio pane). renderList(prefix)
  // sets the active host prefix; the three ids are `${prefix}-list`,
  // `${prefix}-search`, `${prefix}-summary`. Default 'assemblies' keeps the
  // original estimates host working unchanged. Only one surface is visible
  // at a time, so a shared module-level prefix is safe.
  var _hostPrefix = 'assemblies';
  var _filterFn = null;   // when set, paintList shows only matching rows (e.g. parametric)
  // A recipe is "parametric" if it declares params or carries any qty_formula
  // (the exact pair the /:id/explode parametric-insert path keys on — see
  // assembly-routes.js GET '/'). Used by the Assembly Studio → Parametric tab.
  function isParametric(a) { return !!((a.params && a.params.length) || a.has_formulas); }
  function renderList(prefix, opts) {
    if (prefix) _hostPrefix = String(prefix);
    // Reset the view filter only on a deliberate view switch (a prefix or
    // opts were passed). A bare renderList() — the post-save/delete refresh —
    // preserves whatever filter the current view set (e.g. Parametric).
    if (prefix || opts) _filterFn = (opts && opts.parametricOnly) ? isParametric : null;
    var host = document.getElementById(_hostPrefix + '-list');
    if (!host) return;
    host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading assemblies…</div>';
    Promise.all([window.p86Api.assemblies.list(), ensureTaxonomy()]).then(function (r) {
      _list = (r[0] && r[0].assemblies) || [];
      paintList();
    }).catch(function (err) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center;">Failed to load: ' + esc(err.message) + '</div>';
    });
  }

  function emptyMsg() {
    return '<div style="padding:28px;color:var(--text-dim,#888);text-align:center;">' +
      (_list.length ? 'No matches.' : 'No assemblies yet. Build your first recipe — it becomes insertable on any estimate via the Materials drawer\'s 🧩 Assemblies tab.') + '</div>';
  }

  // Rows for a set of assemblies (shared by search-flat + tree sub-groups).
  function assemblyRows(rows) {
    return rows.map(function (a) {
      var warn = a.incomplete ? ' <span title="Some items have no price yet" style="color:#fbbf24;">⚠</span>' : '';
      return '<tr style="cursor:pointer;" onclick="p86Assemblies.openEditor(' + a.id + ')">' +
        '<td><strong style="color:var(--text,#fff);">' + esc(a.name) + '</strong>' +
          (a.code ? ' <span style="font-family:monospace;font-size:10px;color:var(--text-dim,#888);">' + esc(a.code) + '</span>' : ' <span style="font-size:10px;color:#fbbf24;">unclassified</span>') +
          (a.description ? '<div style="font-size:11px;color:var(--text-dim,#8a93a6);">' + esc(String(a.description).slice(0, 90)) + '</div>' : '') +
        '</td>' +
        '<td style="text-align:right;font-family:monospace;color:#4fd1c5;">' + money(a.unit_cost) + ' / ' + esc(a.unit || 'EA') + warn + '</td>' +
        '<td style="text-align:right;font-family:monospace;">' + (a.item_count || 0) + '</td>' +
        '<td><span style="padding:1px 7px;border-radius:9px;font-size:10px;text-transform:uppercase;background:rgba(79,140,255,0.12);color:#4f8cff;">' + esc(a.source || 'manual') + '</span></td>' +
        '<td style="text-align:right;">' +
          '<button class="ee-btn ee-icon-btn ghost" onclick="event.stopPropagation();p86Assemblies.remove(' + a.id + ')" title="Delete">&#x1F5D1;</button>' +
        '</td></tr>';
    }).join('');
  }
  function assemblyTable(rows, showHead) {
    var head = showHead ? '<thead><tr>' +
      '<th style="text-align:left;">Assembly</th>' +
      '<th style="text-align:right;width:130px;">Cost / unit</th>' +
      '<th style="text-align:right;width:60px;">Items</th>' +
      '<th style="text-align:left;width:80px;">Source</th>' +
      '<th style="width:50px;"></th></tr></thead>' : '';
    return '<table class="dense-table" style="width:100%;">' + head + '<tbody>' + assemblyRows(rows) + '</tbody></table>';
  }

  function paintList() {
    var host = document.getElementById(_hostPrefix + '-list');
    if (!host) return;
    var q = (document.getElementById(_hostPrefix + '-search') || { value: '' }).value.trim().toLowerCase();
    var summary = document.getElementById(_hostPrefix + '-summary');
    // Apply any active view filter (e.g. Parametric) BEFORE search/tree so
    // both the summary count and the grouping reflect the visible subset.
    var list = _filterFn ? _list.filter(_filterFn) : _list;
    var noun = _filterFn ? 'parametric assemblies' : 'assemblies';

    // Search → flat filtered table (search shouldn't fight the tree).
    if (q) {
      var rows = list.filter(function (a) {
        return ((a.name || '') + ' ' + (a.code || '') + ' ' + (a.trade || '') + ' ' + (a.system || '') + ' ' + (a.variant || '')).toLowerCase().indexOf(q) !== -1;
      });
      if (summary) summary.textContent = rows.length + ' of ' + list.length + ' ' + noun;
      host.innerHTML = rows.length ? assemblyTable(rows, true) : emptyMsg();
      return;
    }
    if (summary) summary.textContent = list.length + ' ' + noun;
    if (!list.length) {
      host.innerHTML = _filterFn
        ? '<div style="padding:28px;color:var(--text-dim,#888);text-align:center;">No parametric recipes yet. Add parameters or a quantity formula to an assembly and it appears here — then it drives quantities from geometry on the plan.</div>'
        : emptyMsg();
      return;
    }

    // Tree: Trade → System.
    var byTrade = {};
    list.forEach(function (a) {
      var tc = up(a.trade) || '(UNCLASSIFIED)';
      (byTrade[tc] = byTrade[tc] || []).push(a);
    });
    var tradeCodes = Object.keys(byTrade).sort(function (x, y) { return tradeName(x).localeCompare(tradeName(y)); });
    var html = '';
    tradeCodes.forEach(function (tc) {
      var group = byTrade[tc];
      var collapsed = !!_collapsed[tc];
      html += '<div style="margin-bottom:6px;">' +
        '<div onclick="p86Assemblies.toggleGroup(\'' + esc(tc) + '\')" style="cursor:pointer;display:flex;align-items:center;gap:8px;padding:8px 10px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#2a2f3a);border-radius:8px;">' +
          '<span style="width:12px;color:var(--text-dim,#8a93a6);">' + (collapsed ? '▸' : '▾') + '</span>' +
          '<strong style="color:var(--text,#fff);">' + esc(tradeName(tc)) + '</strong>' +
          (tc !== '(UNCLASSIFIED)' ? ' <span style="font-family:monospace;font-size:10px;color:var(--text-dim,#888);">' + esc(tc) + '</span>' : '') +
          '<span style="margin-left:auto;font-size:11px;color:var(--text-dim,#8a93a6);">' + group.length + '</span>' +
        '</div>';
      if (!collapsed) {
        var bySys = {};
        group.forEach(function (a) { var sc = up(a.system) || ''; (bySys[sc] = bySys[sc] || []).push(a); });
        var sysCodes = Object.keys(bySys).sort();
        html += '<div style="padding:2px 0 4px 14px;">';
        sysCodes.forEach(function (sc) {
          var sysRows = bySys[sc].slice().sort(function (x, y) { return (x.name || '').localeCompare(y.name || ''); });
          var sname = sc ? systemName(tc, sc) : 'General';
          html += '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8a93a6);padding:6px 4px 2px;">' + esc(sname) + (sc ? ' · ' + esc(sc) : '') + '</div>' + assemblyTable(sysRows, false);
        });
        html += '</div>';
      }
      html += '</div>';
    });
    host.innerHTML = html;
  }

  function toggleGroup(tc) { _collapsed[tc] = !_collapsed[tc]; paintList(); }

  // ── Editor overlay ─────────────────────────────────────────────────
  function ensureOverlay() {
    var el = document.getElementById('assemblyEditorOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'assemblyEditorOverlay';
    el.style.cssText = 'display:none;position:fixed;inset:0;z-index:1200;background:rgba(8,10,16,0.72);overflow:auto;padding:4vh 16px;';
    el.addEventListener('mousedown', function (ev) { if (ev.target === el) closeEditor(); });
    document.body.appendChild(el);
    return el;
  }

  function openEditor(id) {
    var overlay = ensureOverlay();
    overlay.style.display = 'block';
    overlay.innerHTML = '<div style="max-width:940px;margin:0 auto;background:var(--card-bg,#141419);border:1px solid var(--border,#2a2f3a);border-radius:12px;padding:24px;color:var(--text-dim,#8a93a6);">Loading…</div>';
    if (id == null) {
      ensureTaxonomy().then(function () {
        _editing = {
          header: { id: null, name: '', code: '', trade: '', system: '', variant: '', unit: 'SF', description: '', source: 'manual', params: null },
          items: [], unitCost: 0, previewScope: {}
        };
        paintEditor();
      });
      return;
    }
    Promise.all([window.p86Api.assemblies.get(id), ensureTaxonomy()]).then(function (r) {
      var res = r[0];
      _editing = {
        header: res.assembly,
        items: (res.items || []).map(function (it) { return Object.assign({}, it); }),
        unitCost: res.assembly.unit_cost,
        previewScope: {}
      };
      paintEditor();
    }).catch(function (err) {
      overlay.innerHTML = '<div style="max-width:940px;margin:0 auto;background:var(--card-bg,#141419);border-radius:12px;padding:24px;color:#f87171;">Failed: ' + esc(err.message) + '</div>';
    });
  }

  function closeEditor() {
    var overlay = document.getElementById('assemblyEditorOverlay');
    if (overlay) overlay.style.display = 'none';
    _editing = null;
  }

  // Client-side cost preview — leaf items only (nested child assemblies
  // show their SERVER-resolved cost from the list cache so the preview
  // stays honest without re-resolving the whole graph here).
  function previewCost() {
    if (!_editing) return 0;
    var total = 0;
    _editing.items.forEach(function (it) {
      var mult = num(it.qty_per_unit) * (1 + num(it.waste_pct) / 100);
      if (it.kind === 'assembly') {
        var child = _list.find(function (a) { return a.id === Number(it.child_assembly_id); });
        total += (child ? num(child.unit_cost) : 0) * mult;
      } else {
        var uc = (it.unit_cost != null && it.unit_cost !== '') ? num(it.unit_cost) : num(it.live_unit_cost);
        total += uc * mult;
      }
    });
    return Math.round(total * 100) / 100;
  }

  function paintEditor() {
    var overlay = ensureOverlay();
    var h = _editing.header;
    var isNew = h.id == null;
    var html =
      '<div style="max-width:940px;margin:0 auto;background:var(--card-bg,#141419);border:1px solid var(--border,#2a2f3a);border-radius:12px;overflow:hidden;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border,#2a2f3a);">' +
          '<div style="font-size:16px;font-weight:700;color:#fff;">&#x1F9E9; ' + (isNew ? 'New Assembly' : 'Edit Assembly') + '</div>' +
          '<div style="display:flex;gap:8px;align-items:center;">' +
            '<span style="font-family:monospace;font-size:14px;color:#4fd1c5;" id="asmEd_cost">' + money(previewCost()) + ' / ' + esc(h.unit || 'EA') + '</span>' +
            '<button class="ee-btn secondary" onclick="p86Assemblies.save()">Save</button>' +
            '<button class="ee-btn ghost" onclick="p86Assemblies.closeEditor()">✕</button>' +
          '</div>' +
        '</div>' +
        '<div style="padding:16px 20px 4px;display:grid;grid-template-columns:2fr 1fr 1fr 1fr 80px;gap:10px;">' +
          fld('Name *', 'asmEd_name', h.name) +
          selWrap('Trade', 'asmEd_trade', tradeOptions(h.trade)) +
          selWrap('System', 'asmEd_system', systemOptions(h.trade, h.system)) +
          variantField(h.trade, h.system, h.variant) +
          fld('Unit', 'asmEd_unit', h.unit || 'SF') +
        '</div>' +
        '<div style="padding:0 20px 10px;font-size:11px;color:var(--text-dim,#8a93a6);">Code: <span id="asmEd_codePreview" style="font-family:monospace;color:#4fd1c5;font-size:13px;">' + (esc(clientCode(h.trade, h.system, h.variant)) || '—') + '</span> <span style="opacity:.7;">· auto-derived from Trade · System · Variant (kept unique)</span></div>' +
        '<div style="padding:0 20px 12px;">' + fld('Description', 'asmEd_desc', h.description) + '</div>' +
        '<div style="padding:0 20px 12px;" id="asmEd_params">' + paramsHtml() + '</div>' +
        '<div style="padding:0 20px 8px;font-size:11px;color:var(--text-dim,#8a93a6);">Every quantity below is <b>per 1 <span id="asmEd_unitLabel">' + esc(h.unit || 'unit') + '</span></b> of installed work — or start it with <b style="color:#fbbf24;">=</b> for a formula that computes the TOTAL from the dimensions (e.g. <span style="font-family:monospace;">=ceil(Q/8)+1</span>; Q = the takeoff qty). Material rows with a blank unit cost pull the LIVE catalog price.</div>' +
        '<div style="padding:0 20px 14px;" id="asmEd_items">' + itemsTableHtml() + '</div>' +
        '<div style="padding:0 20px 12px;" id="asmEd_preview">' + previewBarHtml() + '</div>' +
        '<div style="padding:0 20px 20px;display:flex;gap:8px;flex-wrap:wrap;">' +
          '<button class="ee-btn ghost" onclick="p86Assemblies.addItem(\'material\')">+ Material</button>' +
          '<button class="ee-btn ghost" onclick="p86Assemblies.addItem(\'labor\')">+ Labor</button>' +
          '<button class="ee-btn ghost" onclick="p86Assemblies.addItem(\'sub\')">+ Sub</button>' +
          '<button class="ee-btn ghost" onclick="p86Assemblies.addItem(\'gc\')">+ GC</button>' +
          '<button class="ee-btn ghost" onclick="p86Assemblies.addItem(\'assembly\')">+ Sub-assembly</button>' +
        '</div>' +
      '</div>';
    overlay.innerHTML = html;
    wireItemRows();
    wireHeaderFields();
    wireParams();
    wirePreviewBar();
  }

  // ── Parametric layer (S0) ──────────────────────────────────────────
  // Declared geometry params — [{key,label,unit,default}]. Q is reserved
  // (always the takeoff qty in the output unit).
  function headerParams() {
    var p = _editing && _editing.header && _editing.header.params;
    return Array.isArray(p) ? p : [];
  }
  function paramKeys() { return ['Q'].concat(headerParams().map(function (d) { return d.key; })); }

  function paramsHtml() {
    var ps = headerParams();
    var chips = ps.map(function (d, i) {
      return '<span style="display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.35);border-radius:14px;padding:3px 10px;font-size:11.5px;color:#fbbf24;">' +
        '<b style="font-family:monospace;">' + esc(d.key) + '</b> ' + esc(d.label || d.key) +
        (d.unit ? ' <span style="opacity:.7;">(' + esc(d.unit) + ')</span>' : '') +
        ' <span style="opacity:.7;">= ' + esc(String(d.default)) + '</span>' +
        '<span data-param-x="' + i + '" style="cursor:pointer;opacity:.7;">✕</span>' +
      '</span>';
    }).join(' ');
    return '<div style="border:1px dashed rgba(251,191,36,0.35);border-radius:8px;padding:9px 12px;">' +
      '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
        '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#fbbf24;">Parameters</span>' +
        (chips || '<span style="font-size:11px;color:var(--text-dim,#8a93a6);">None — add dimensions (height, spacing…) that quantity formulas can use. Q (takeoff qty) is always available.</span>') +
        '<button class="ee-btn ghost" data-param-add style="margin-left:auto;font-size:11px;padding:3px 9px;">+ Parameter</button>' +
      '</div>' +
      '<div data-param-form style="display:none;gap:6px;align-items:flex-end;margin-top:8px;flex-wrap:wrap;">' +
        miniFld('Key (e.g. H)', 'asmEd_pkey', '', '70px') +
        miniFld('Label', 'asmEd_plabel', '', '150px') +
        miniFld('Unit', 'asmEd_punit', '', '60px') +
        miniFld('Default', 'asmEd_pdefault', '', '70px') +
        '<button class="ee-btn secondary" data-param-go style="font-size:11px;padding:5px 12px;">Add</button>' +
      '</div>' +
    '</div>';
  }
  function miniFld(label, id, val, w) {
    return '<label style="display:flex;flex-direction:column;gap:3px;font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8a93a6);">' + esc(label) +
      '<input id="' + id + '" value="' + esc(val || '') + '" style="width:' + w + ';background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px 7px;color:var(--text,#fff);font-size:12px;" /></label>';
  }
  function wireParams() {
    var box = document.getElementById('asmEd_params');
    if (!box) return;
    var addBtn = box.querySelector('[data-param-add]');
    if (addBtn) addBtn.addEventListener('click', function () {
      var f = box.querySelector('[data-param-form]');
      if (f) { f.style.display = f.style.display === 'none' ? 'flex' : 'none'; var k = box.querySelector('#asmEd_pkey'); if (k) k.focus(); }
    });
    var goBtn = box.querySelector('[data-param-go]');
    if (goBtn) goBtn.addEventListener('click', function () {
      var key = ((box.querySelector('#asmEd_pkey') || {}).value || '').trim();
      if (!/^[A-Za-z][A-Za-z0-9_]{0,15}$/.test(key)) { notify('Parameter key: letters/digits/underscore, starting with a letter (e.g. H, S, coats).'); return; }
      if (key.toUpperCase() === 'Q') { notify('Q is reserved — it is always the takeoff quantity.'); return; }
      var ps = headerParams();
      if (ps.some(function (d) { return d.key.toUpperCase() === key.toUpperCase(); })) { notify('Parameter "' + key + '" already exists.'); return; }
      if (ps.length >= 12) { notify('At most 12 parameters per assembly.'); return; }
      ps = ps.concat([{
        key: key,
        label: ((box.querySelector('#asmEd_plabel') || {}).value || key).trim().slice(0, 40) || key,
        unit: ((box.querySelector('#asmEd_punit') || {}).value || '').trim().slice(0, 10),
        default: num((box.querySelector('#asmEd_pdefault') || {}).value) || 0
      }]);
      _editing.header.params = ps;
      repaintParams();
    });
    box.querySelectorAll('[data-param-x]').forEach(function (x) {
      x.addEventListener('click', function () {
        var i = Number(x.dataset.paramX);
        var ps = headerParams().slice();
        var removed = ps.splice(i, 1)[0];
        // Refuse if any formula still references the param — a silent removal
        // would turn those rows into save-time validation errors. FAIL CLOSED:
        // an unparseable formula (idents() can't see into it) or a missing
        // engine also blocks the removal.
        if (!window.p86Formula) { notify('Formula engine not loaded — refresh the page before editing parameters.'); return; }
        var used = _editing.items.some(function (it) {
          if (!it.qty_formula) return false;
          var ids = window.p86Formula.idents(it.qty_formula);
          if (!ids.length && window.p86Formula.validate(it.qty_formula, paramKeys())) return true;   // unparseable — can't prove it's unused
          return ids.some(function (k) { return k.toUpperCase() === removed.key.toUpperCase(); });
        });
        if (used) { notify('"' + removed.key + '" is used by a quantity formula (or a formula couldn\'t be checked) — update those rows first.'); return; }
        _editing.header.params = ps.length ? ps : null;
        repaintParams();
      });
    });
  }
  function repaintParams() {
    var box = document.getElementById('asmEd_params');
    if (box) { box.innerHTML = paramsHtml(); wireParams(); }
    // Re-render items too: a just-declared param clears any stale red
    // "unknown parameter" styling on formula cells (not mid-typing here).
    repaintItems();
    repaintPreviewBar();
  }

  // Live parametric preview — client-side mirror of the server's explode
  // (leaf items + one level of sub-assembly cost from the list cache),
  // using the SAME p86Formula engine, at typed sample values.
  function previewBarHtml() {
    var hasFormulas = _editing.items.some(function (it) { return it.qty_formula; });
    if (!hasFormulas && !headerParams().length) return '';
    var scope = previewScope();
    var r = computeParametric(scope);
    var inputs = Object.keys(scope).map(function (k) {
      var d = headerParams().find(function (x) { return x.key === k; });
      return '<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim,#8a93a6);">' +
        '<b style="font-family:monospace;color:#fbbf24;">' + esc(k) + '</b>' + (d && d.unit ? ' <span style="opacity:.7;">' + esc(d.unit) + '</span>' : (k === 'Q' ? ' <span style="opacity:.7;">' + esc(_editing.header.unit || 'unit') + '</span>' : '')) +
        '<input data-prevp="' + esc(k) + '" value="' + esc(String(scope[k])) + '" inputmode="decimal" style="width:62px;text-align:right;background:rgba(255,255,255,0.05);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:4px 6px;color:var(--text,#fff);font-family:monospace;font-size:12px;" />' +
      '</label>';
    }).join('');
    var errHtml = '<div data-prev-errors style="' + (r.errors.length ? 'margin-top:6px;' : '') + 'font-size:11px;color:#f87171;">' + r.errors.map(function (e2) { return '⚠ ' + esc(e2); }).join('<br>') + '</div>';
    return '<div style="border:1px solid rgba(251,191,36,0.35);border-radius:8px;padding:9px 12px;background:rgba(251,191,36,0.04);">' +
      '<div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;">' +
        '<span style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:#fbbf24;" title="Exact totals at these sample dimensions — nested sub-assemblies price at their per-unit cost">Parametric preview</span>' +
        inputs +
        '<span data-prev-total style="margin-left:auto;font-family:monospace;font-size:14px;font-weight:700;color:#4fd1c5;">' + money(r.total) + (r.incomplete ? ' <span title="Some items have no price yet" style="color:#fbbf24;font-size:11px;">⚠</span>' : '') + '</span>' +
      '</div>' + errHtml +
    '</div>';
  }
  function previewScope() {
    var scope = { Q: 100 };
    headerParams().forEach(function (d) { scope[d.key] = d.default; });
    var saved = (_editing && _editing.previewScope) || {};
    Object.keys(saved).forEach(function (k) { if (scope[k] !== undefined && isFinite(Number(saved[k]))) scope[k] = Number(saved[k]); });
    return scope;
  }
  function computeParametric(scope) {
    var total = 0, incomplete = false, errors = [];
    _editing.items.forEach(function (it) {
      var qty;
      if (it.qty_formula) {
        if (!window.p86Formula) { errors.push('Formula engine not loaded'); return; }
        var r = window.p86Formula.evaluate(it.qty_formula, scope);
        if (!r.ok) { errors.push((it.description || it.kind) + ': ' + r.error); return; }
        qty = Math.max(0, r.value);
      } else {
        qty = num(it.qty_per_unit) * scope.Q;
      }
      qty *= (1 + num(it.waste_pct) / 100);
      var uc;
      if (it.kind === 'assembly') {
        var child = _list.find(function (a) { return a.id === Number(it.child_assembly_id); });
        uc = child ? num(child.unit_cost) : null;
      } else {
        uc = (it.unit_cost != null && it.unit_cost !== '') ? num(it.unit_cost)
          : (it.live_unit_cost != null ? num(it.live_unit_cost) : null);
      }
      if (uc == null) { incomplete = true; return; }
      total += qty * uc;
    });
    return { total: Math.round(total * 100) / 100, incomplete: incomplete, errors: errors };
  }
  function wirePreviewBar() {
    var box = document.getElementById('asmEd_preview');
    if (!box) return;
    box.querySelectorAll('[data-prevp]').forEach(function (inp) {
      // 'input' + targeted total/error update — a full repaint on 'change'
      // would eat focus while tabbing between the sample inputs.
      inp.addEventListener('input', function () {
        _editing.previewScope[inp.dataset.prevp] = inp.value;
        var r = computeParametric(previewScope());
        var tot = box.querySelector('[data-prev-total]');
        if (tot) tot.innerHTML = money(r.total) + (r.incomplete ? ' <span title="Some items have no price yet" style="color:#fbbf24;font-size:11px;">⚠</span>' : '');
        var errBox = box.querySelector('[data-prev-errors]');
        if (errBox) {
          errBox.style.marginTop = r.errors.length ? '6px' : '0';
          errBox.innerHTML = r.errors.map(function (e2) { return '⚠ ' + esc(e2); }).join('<br>');
        }
      });
    });
  }
  function repaintPreviewBar() {
    var box = document.getElementById('asmEd_preview');
    if (box) { box.innerHTML = previewBarHtml(); wirePreviewBar(); }
  }

  // Trade/System/Variant → live code preview + system-list refresh + unit prefill.
  function wireHeaderFields() {
    var overlay = ensureOverlay();
    var tradeEl = overlay.querySelector('#asmEd_trade');
    var sysEl = overlay.querySelector('#asmEd_system');
    var varEl = overlay.querySelector('#asmEd_variant');
    var unitEl = overlay.querySelector('#asmEd_unit');
    function recompute() {
      var prev = overlay.querySelector('#asmEd_codePreview');
      if (prev) prev.textContent = clientCode(tradeEl && tradeEl.value, sysEl && sysEl.value, varEl && varEl.value) || '—';
    }
    function rebuildVariantList() {
      var dl = overlay.querySelector('#asmEd_variantlist');
      if (dl) dl.innerHTML = variantOptions(tradeEl && tradeEl.value, sysEl && sysEl.value);
    }
    // Unit drives the "per 1 <unit>" helper + the parametric preview's Q label
    // (both read _editing.header.unit / the rendered span). Without this sync
    // they stay frozen at the paint-time unit until save — the header $/unit
    // reads the live DOM, so they visibly disagree. Keep all three in step.
    function syncUnit() {
      var u = (unitEl && unitEl.value) || '';
      _editing.header.unit = u;
      var lbl = overlay.querySelector('#asmEd_unitLabel');
      if (lbl) lbl.textContent = u || 'unit';
      refreshCostPreview();
      repaintPreviewBar();
    }
    if (unitEl) unitEl.addEventListener('input', syncUnit);
    if (tradeEl) tradeEl.addEventListener('change', function () {
      _editing.header.trade = tradeEl.value;
      _editing.header.system = '';
      if (sysEl) sysEl.innerHTML = systemOptions(tradeEl.value, '');  // stable element, fresh options
      rebuildVariantList();
      recompute();
    });
    if (sysEl) sysEl.addEventListener('change', function () {
      _editing.header.system = sysEl.value;
      var s = ((_taxonomy && _taxonomy.systems) || []).find(function (x) { return up(x.trade_code) === up(tradeEl && tradeEl.value) && up(x.code) === up(sysEl.value); });
      if (s && s.default_unit && unitEl && (!unitEl.value.trim() || unitEl.value === 'SF')) { unitEl.value = s.default_unit; syncUnit(); }
      rebuildVariantList();
      recompute();
    });
    if (varEl) varEl.addEventListener('input', function () { _editing.header.variant = varEl.value; recompute(); });
  }

  function fld(label, id, val) {
    return '<label style="display:flex;flex-direction:column;gap:4px;font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8a93a6);">' + esc(label) +
      '<input id="' + id + '" value="' + esc(val || '') + '" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:7px 9px;color:var(--text,#fff);font-size:13px;" /></label>';
  }

  function itemsTableHtml() {
    if (!_editing.items.length) {
      return '<div style="padding:16px;border:1px dashed var(--border,#2a2f3a);border-radius:8px;color:var(--text-dim,#8a93a6);font-size:12px;">No items yet — add materials, labor, or nested sub-assemblies below.</div>';
    }
    return '<table class="dense-table" style="width:100%;"><thead><tr>' +
      '<th style="text-align:left;width:92px;">Kind</th>' +
      '<th style="text-align:left;">Item</th>' +
      '<th style="text-align:right;width:90px;">Qty / unit</th>' +
      '<th style="text-align:left;width:60px;">Unit</th>' +
      '<th style="text-align:right;width:95px;">Unit cost</th>' +
      '<th style="text-align:right;width:70px;">Waste %</th>' +
      '<th style="width:40px;"></th>' +
    '</tr></thead><tbody>' +
    _editing.items.map(function (it, i) {
      var itemCell;
      if (it.kind === 'assembly') {
        var opts = _list.filter(function (a) { return a.id !== _editing.header.id; })
          .map(function (a) {
            return '<option value="' + a.id + '"' + (Number(it.child_assembly_id) === a.id ? ' selected' : '') + '>' +
              esc(a.name) + ' (' + money(a.unit_cost) + '/' + esc(a.unit) + ')</option>';
          }).join('');
        itemCell = '<select data-f="child_assembly_id" data-i="' + i + '" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);">' +
          '<option value="">— pick assembly —</option>' + opts + '</select>';
      } else if (it.kind === 'material') {
        itemCell = '<div style="position:relative;">' +
          '<input data-f="description" data-i="' + i + '" data-matsearch="1" placeholder="Search catalog…" value="' + esc(it.description || it.material_description || '') + '" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid ' + (it.material_id ? 'rgba(79,209,197,.4)' : 'var(--border,#2a2f3a)') + ';border-radius:6px;padding:5px 7px;color:var(--text,#fff);" />' +
          (it.material_id ? '<span title="Linked to catalog — live-priced" style="position:absolute;right:6px;top:5px;font-size:10px;color:#4fd1c5;">&#x1F517;</span>' : '') +
          '<div class="asm-mat-results" data-mati="' + i + '" style="display:none;position:absolute;left:0;right:0;top:100%;z-index:10;background:#1b1f2a;border:1px solid var(--border,#2a2f3a);border-radius:6px;max-height:180px;overflow:auto;"></div>' +
        '</div>';
      } else {
        itemCell = '<input data-f="description" data-i="' + i + '" placeholder="' + esc(it.kind) + ' description…" value="' + esc(it.description || '') + '" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px 7px;color:var(--text,#fff);" />';
      }
      var costPlaceholder = it.kind === 'material' && it.live_unit_cost != null ? ('live ' + Number(it.live_unit_cost).toFixed(2)) : '';
      return '<tr>' +
        '<td><select data-f="kind" data-i="' + i + '" style="background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);">' +
          KINDS.map(function (k) { return '<option value="' + k.v + '"' + (it.kind === k.v ? ' selected' : '') + '>' + k.label + '</option>'; }).join('') +
        '</select></td>' +
        '<td>' + itemCell + '</td>' +
        '<td><input data-f="qty_per_unit" data-i="' + i + '" value="' + esc(it.qty_formula ? ('=' + it.qty_formula) : (it.qty_per_unit != null ? it.qty_per_unit : 1)) + '" title="' + (it.qty_formula ? 'Formula — computes the TOTAL from the parameters at insert time' : 'Per 1 output unit; start with = for a formula') + '" style="width:100%;text-align:right;background:rgba(255,255,255,0.04);border:1px solid ' + (it.qty_formula ? 'rgba(251,191,36,0.55)' : 'var(--border,#2a2f3a)') + ';border-radius:6px;padding:5px;color:' + (it.qty_formula ? '#fbbf24' : 'var(--text,#fff)') + ';font-family:monospace;" /></td>' +
        '<td><input data-f="unit" data-i="' + i + '" value="' + esc(it.unit || '') + '" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);" /></td>' +
        '<td><input data-f="unit_cost" data-i="' + i + '" value="' + esc(it.unit_cost != null && it.unit_cost !== '' ? it.unit_cost : '') + '" placeholder="' + esc(costPlaceholder) + '" inputmode="decimal" style="width:100%;text-align:right;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);font-family:monospace;" /></td>' +
        '<td><input data-f="waste_pct" data-i="' + i + '" value="' + esc(it.waste_pct || 0) + '" inputmode="decimal" style="width:100%;text-align:right;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);font-family:monospace;" /></td>' +
        '<td style="text-align:center;"><button class="ee-btn ee-icon-btn ghost" onclick="p86Assemblies.removeItem(' + i + ')" title="Remove">✕</button></td>' +
      '</tr>';
    }).join('') + '</tbody></table>';
  }

  function wireItemRows() {
    var overlay = ensureOverlay();
    overlay.querySelectorAll('[data-f]').forEach(function (el) {
      var evt = el.tagName === 'SELECT' ? 'change' : 'input';
      el.addEventListener(evt, function () {
        var i = Number(el.dataset.i);
        var f = el.dataset.f;
        var it = _editing.items[i];
        if (!it) return;
        if (f === 'qty_per_unit') {
          // "=..." = a quantity FORMULA (total from params); plain number =
          // the per-unit qty. Style inline — no repaint mid-typing (focus).
          var v = String(el.value).trim();
          if (v.charAt(0) === '=') {
            it.qty_formula = v.slice(1).trim();
            el.style.borderColor = 'rgba(251,191,36,0.55)'; el.style.color = '#fbbf24';
            if (window.p86Formula && it.qty_formula) {
              var ferr = window.p86Formula.validate(it.qty_formula, paramKeys());
              el.title = ferr ? ('⚠ ' + ferr) : 'Formula — computes the TOTAL from the parameters at insert time';
              el.style.borderColor = ferr ? 'rgba(248,113,113,0.7)' : 'rgba(251,191,36,0.55)';
            }
          } else {
            // Deleting just the "=" of a formula must not let parseFloat
            // mangle the leftover text into a bogus per-unit qty — restore
            // the formula unless the field now holds a real number.
            if (it.qty_formula && !isFinite(parseFloat(v))) {
              el.value = '=' + it.qty_formula;
              refreshCostPreview();
              return;
            }
            it.qty_formula = null;
            it.qty_per_unit = v;
            el.style.borderColor = ''; el.style.color = ''; el.title = 'Per 1 output unit; start with = for a formula';
          }
          refreshCostPreview();
          repaintPreviewBar();
          return;
        }
        it[f] = el.value;
        if (f === 'kind') {
          // Kind flip resets the cross-kind references + default cost code.
          it.material_id = null; it.child_assembly_id = null;
          it.cost_code = KIND_DEFAULT_CODE[el.value] || 'materials';
          repaintItems();
        }
        if (f === 'description' && it.kind === 'material' && el.dataset.matsearch) {
          it.material_id = null; // typing breaks the catalog link until a pick
          matSearch(el, i);
        }
        refreshCostPreview();
        // Unit cost / unit / waste / kind all move the parametric total — the
        // preview bar is a separate DOM subtree, so re-rendering it here can't
        // steal focus from the row being edited. (The qty/formula branch above
        // already repaints; this covers every other field.)
        repaintPreviewBar();
      });
    });
  }

  function repaintItems() {
    var box = document.getElementById('asmEd_items');
    if (box) { box.innerHTML = itemsTableHtml(); wireItemRows(); }
    refreshCostPreview();
  }

  function refreshCostPreview() {
    var el = document.getElementById('asmEd_cost');
    var unitEl = document.getElementById('asmEd_unit');
    if (!el) return;
    // Formula rows contribute their per-unit APPROXIMATION here — flag it so
    // the header $/unit isn't read as the parametric price.
    var hasF = _editing.items.some(function (it) { return it.qty_formula; });
    el.textContent = money(previewCost()) + ' / ' + ((unitEl && unitEl.value) || _editing.header.unit || 'EA') + (hasF ? ' ·ƒ' : '');
    el.title = hasF ? 'Linear approximation — formula rows price exactly in the Parametric preview below and at insert time' : '';
  }

  // Inline catalog search under a material row — pick links material_id
  // so the row live-prices from the catalog.
  function matSearch(inputEl, i) {
    if (_matTimer) clearTimeout(_matTimer);
    var box = inputEl.parentElement.querySelector('.asm-mat-results');
    _matTimer = setTimeout(function () {
      var q = inputEl.value.trim();
      if (q.length < 2) { if (box) box.style.display = 'none'; return; }
      window.p86Api.materials.list({ q: q, limit: 8 }).then(function (res) {
        var mats = res.materials || [];
        if (!box) return;
        if (!mats.length) { box.style.display = 'none'; return; }
        box.innerHTML = mats.map(function (m) {
          return '<div data-pick="' + m.id + '" style="padding:6px 9px;cursor:pointer;font-size:12px;border-bottom:1px solid rgba(255,255,255,0.05);">' +
            esc(m.description) + ' <span style="color:#4fd1c5;font-family:monospace;">' + money(m.last_unit_price) + '/' + esc(m.unit || 'ea') + '</span></div>';
        }).join('');
        box.style.display = 'block';
        box.querySelectorAll('[data-pick]').forEach(function (row) {
          row.addEventListener('mousedown', function (ev) {
            ev.preventDefault();
            var m = mats.find(function (x) { return x.id === Number(row.dataset.pick); });
            var it = _editing.items[i];
            it.material_id = m.id;
            it.description = m.description;
            it.unit = it.unit || m.unit || 'ea';
            it.live_unit_cost = m.last_unit_price;
            box.style.display = 'none';
            repaintItems();
          });
        });
      });
    }, 220);
  }

  function addItem(kind) {
    if (!_editing) return;
    _editing.items.push({
      kind: kind, material_id: null, child_assembly_id: null, description: '',
      qty_per_unit: 1, unit: kind === 'labor' ? 'HR' : '', unit_cost: '',
      cost_code: KIND_DEFAULT_CODE[kind] || 'materials', waste_pct: 0
    });
    repaintItems();
  }

  function removeItem(i) {
    if (!_editing) return;
    _editing.items.splice(i, 1);
    repaintItems();
  }

  function save() {
    if (!_editing) return;
    var h = {
      name: (document.getElementById('asmEd_name') || {}).value || '',
      trade: (document.getElementById('asmEd_trade') || {}).value || '',
      system: (document.getElementById('asmEd_system') || {}).value || '',
      variant: (document.getElementById('asmEd_variant') || {}).value || '',
      unit: (document.getElementById('asmEd_unit') || {}).value || 'EA',
      description: (document.getElementById('asmEd_desc') || {}).value || ''
    };
    if (!h.name.trim()) { notify('Name is required.'); return; }
    h.params = headerParams().length ? headerParams() : null;
    var items = _editing.items.map(function (it) {
      return {
        kind: it.kind, material_id: it.material_id, child_assembly_id: it.child_assembly_id,
        description: it.description, qty_per_unit: num(it.qty_per_unit) || 1,
        unit: it.unit, unit_cost: (it.unit_cost === '' || it.unit_cost == null) ? null : num(it.unit_cost),
        cost_code: it.cost_code, waste_pct: num(it.waste_pct) || 0,
        qty_formula: (it.qty_formula && String(it.qty_formula).trim()) ? String(it.qty_formula).trim() : null
      };
    });
    var p = _editing.header.id == null
      ? window.p86Api.assemblies.create(Object.assign({}, h, { items: items }))
      : window.p86Api.assemblies.update(_editing.header.id, h).then(function () {
          return window.p86Api.assemblies.saveItems(_editing.header.id, items);
        });
    p.then(function (res) {
      if (res && res.error) throw new Error(res.error);
      closeEditor();
      renderList();
      if (window.MaterialsDrawer && window.MaterialsDrawer.refresh) window.MaterialsDrawer.refresh();
    }).catch(function (err) {
      notify('Save failed: ' + (err.message || 'unknown'));
    });
  }

  function remove(id) {
    var a = _list.find(function (x) { return x.id === id; });
    var doDelete = function () {
      window.p86Api.assemblies.remove(id).then(function (res) {
        if (res && res.error) { alert(res.error); return; }
        renderList();
      }).catch(function (err) { alert('Delete failed: ' + (err.message || (err.error || 'unknown'))); });
    };
    if (window.p86Confirm) {
      window.p86Confirm('Delete assembly "' + ((a && a.name) || id) + '"? Estimates already built from it keep their lines.', doDelete);
    } else if (confirm('Delete this assembly?')) {
      doDelete();
    }
  }

  window.p86Assemblies = {
    renderList: renderList,
    paintList: paintList,
    openEditor: openEditor,
    closeEditor: closeEditor,
    addItem: addItem,
    removeItem: removeItem,
    toggleGroup: toggleGroup,
    save: save,
    remove: remove
  };
})();
