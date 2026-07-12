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

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function money(n) { return (n == null || isNaN(n)) ? '—' : '$' + Number(n).toFixed(2); }
  function num(v) { var n = parseFloat(v); return isFinite(n) ? n : 0; }

  // ── List view ───────────────────────────────────────────────────────
  function renderList() {
    var host = document.getElementById('assemblies-list');
    if (!host) return;
    host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading assemblies…</div>';
    window.p86Api.assemblies.list().then(function (res) {
      _list = res.assemblies || [];
      paintList();
    }).catch(function (err) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center;">Failed to load: ' + esc(err.message) + '</div>';
    });
  }

  function paintList() {
    var host = document.getElementById('assemblies-list');
    if (!host) return;
    var q = (document.getElementById('assemblies-search') || { value: '' }).value.trim().toLowerCase();
    var rows = _list.filter(function (a) {
      if (!q) return true;
      return ((a.name || '') + ' ' + (a.code || '') + ' ' + (a.trade || '')).toLowerCase().indexOf(q) !== -1;
    });
    var summary = document.getElementById('assemblies-summary');
    if (summary) summary.textContent = rows.length + ' of ' + _list.length + ' assemblies';
    if (!rows.length) {
      host.innerHTML = '<div style="padding:28px;color:var(--text-dim,#888);text-align:center;">' +
        (_list.length ? 'No matches.' : 'No assemblies yet. Build your first recipe — it becomes insertable on any estimate via the Materials drawer\'s 🧩 Assemblies tab.') + '</div>';
      return;
    }
    var html = '<table class="dense-table"><thead><tr>' +
      '<th style="text-align:left;">Assembly</th>' +
      '<th style="text-align:left;width:110px;">Trade</th>' +
      '<th style="text-align:right;width:130px;">Cost / unit</th>' +
      '<th style="text-align:right;width:70px;">Items</th>' +
      '<th style="text-align:left;width:80px;">Source</th>' +
      '<th style="width:90px;"></th>' +
    '</tr></thead><tbody>' +
    rows.map(function (a) {
      var warn = a.incomplete ? ' <span title="Some items have no price yet" style="color:#fbbf24;">⚠</span>' : '';
      return '<tr style="cursor:pointer;" onclick="p86Assemblies.openEditor(' + a.id + ')">' +
        '<td><strong style="color:var(--text,#fff);">' + esc(a.name) + '</strong>' +
          (a.code ? ' <span style="font-family:monospace;font-size:10px;color:var(--text-dim,#888);">' + esc(a.code) + '</span>' : '') +
          (a.description ? '<div style="font-size:11px;color:var(--text-dim,#8a93a6);">' + esc(String(a.description).slice(0, 90)) + '</div>' : '') +
        '</td>' +
        '<td>' + esc(a.trade || '—') + '</td>' +
        '<td style="text-align:right;font-family:monospace;color:#4fd1c5;">' + money(a.unit_cost) + ' / ' + esc(a.unit || 'EA') + warn + '</td>' +
        '<td style="text-align:right;font-family:monospace;">' + (a.item_count || 0) + '</td>' +
        '<td><span style="padding:1px 7px;border-radius:9px;font-size:10px;text-transform:uppercase;background:rgba(79,140,255,0.12);color:#4f8cff;">' + esc(a.source || 'manual') + '</span></td>' +
        '<td style="text-align:right;">' +
          '<button class="ee-btn ee-icon-btn ghost" onclick="event.stopPropagation();p86Assemblies.remove(' + a.id + ')" title="Delete">&#x1F5D1;</button>' +
        '</td></tr>';
    }).join('') + '</tbody></table>';
    host.innerHTML = html;
  }

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
      _editing = {
        header: { id: null, name: '', code: '', trade: '', unit: 'SF', description: '', source: 'manual' },
        items: [], unitCost: 0
      };
      paintEditor();
      return;
    }
    window.p86Api.assemblies.get(id).then(function (res) {
      _editing = {
        header: res.assembly,
        items: (res.items || []).map(function (it) { return Object.assign({}, it); }),
        unitCost: res.assembly.unit_cost
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
        '<div style="padding:16px 20px;display:grid;grid-template-columns:2fr 1fr 1fr 90px;gap:10px;">' +
          fld('Name *', 'asmEd_name', h.name) +
          fld('Code', 'asmEd_code', h.code) +
          fld('Trade', 'asmEd_trade', h.trade) +
          fld('Unit', 'asmEd_unit', h.unit || 'SF') +
        '</div>' +
        '<div style="padding:0 20px 12px;">' + fld('Description', 'asmEd_desc', h.description) + '</div>' +
        '<div style="padding:0 20px 8px;font-size:11px;color:var(--text-dim,#8a93a6);">Every quantity below is <b>per 1 ' + esc(h.unit || 'unit') + '</b> of installed work. Material rows with a blank unit cost pull the LIVE catalog price.</div>' +
        '<div style="padding:0 20px 14px;" id="asmEd_items">' + itemsTableHtml() + '</div>' +
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
        '<td><input data-f="qty_per_unit" data-i="' + i + '" value="' + esc(it.qty_per_unit != null ? it.qty_per_unit : 1) + '" inputmode="decimal" style="width:100%;text-align:right;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:6px;padding:5px;color:var(--text,#fff);font-family:monospace;" /></td>' +
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
    if (el) el.textContent = money(previewCost()) + ' / ' + ((unitEl && unitEl.value) || _editing.header.unit || 'EA');
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
      code: (document.getElementById('asmEd_code') || {}).value || '',
      trade: (document.getElementById('asmEd_trade') || {}).value || '',
      unit: (document.getElementById('asmEd_unit') || {}).value || 'EA',
      description: (document.getElementById('asmEd_desc') || {}).value || ''
    };
    if (!h.name.trim()) { alert('Name is required.'); return; }
    var items = _editing.items.map(function (it) {
      return {
        kind: it.kind, material_id: it.material_id, child_assembly_id: it.child_assembly_id,
        description: it.description, qty_per_unit: num(it.qty_per_unit) || 1,
        unit: it.unit, unit_cost: (it.unit_cost === '' || it.unit_cost == null) ? null : num(it.unit_cost),
        cost_code: it.cost_code, waste_pct: num(it.waste_pct) || 0
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
      alert('Save failed: ' + (err.message || 'unknown'));
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
    save: save,
    remove: remove
  };
})();
