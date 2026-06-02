// Plans & Takeoffs — the dedicated surface for scale-drawing documents.
//
// A plan is a Bluebeam-style scale drawing: a blank gridded canvas you
// calibrate and measure on (linear ft / sq ft / counts / angles). The
// measurement data (per-page calibration + strokes) lives in the plan
// row's `pages` JSONB; the markup viewer (js/markup-viewer.js) is the
// editor, and window.p86Markup.summarize() gives the headline totals.
//
// v1 scope: blank-canvas plans (create / open / save / list / delete),
// standalone (no entity link yet). Photo & PDF takeoffs are reachable
// in-place today — the ✏️ annotate button on a photo and the 📐 Measure
// button on a PDF document row both open the same calibrate+measure
// toolset. Surfacing photo/PDF takeoffs as first-class plan documents
// here, plus linking a plan to a job/lead/estimate, are fast-follows.
//
// Renders into the #plans tab pane via window.renderPlansTab(), invoked
// by switchTab('plans') in app.js.

(function () {
  'use strict';

  // Default blank-canvas dimensions + grid (px). The user calibrates the
  // real-world scale inside the viewer with the 📐 Calibrate tool.
  var DEFAULT_W = 1600, DEFAULT_H = 1200, DEFAULT_GRID = 40;

  function api() { return window.p86Api; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function toast(msg) {
    if (window.p86Toast) { try { window.p86Toast(msg); return; } catch (e) { /* fall through */ } }
    console.log('[plans]', msg);
  }

  // ── List view ───────────────────────────────────────────────────
  function renderPlansTab() {
    var pane = document.getElementById('plans');
    if (!pane) return;
    pane.innerHTML =
      '<div style="max-width:1100px;margin:0 auto;padding:8px 4px 40px;">' +
        '<div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">' +
          '<h2 style="margin:0;font-size:20px;font-weight:700;flex:1;">📐 Plans &amp; Takeoffs</h2>' +
          '<button class="primary" id="p86-plans-new" style="padding:8px 16px;border-radius:8px;font-weight:600;cursor:pointer;">➕ New Plan</button>' +
        '</div>' +
        '<div style="font-size:12.5px;color:var(--text-dim,#9aa);margin-bottom:18px;line-height:1.5;">' +
          'Draw a site plan to scale on a blank gridded canvas — calibrate against a known dimension, then take off linear feet, square feet, counts, and angles. ' +
          'To measure on a <strong>photo</strong> or <strong>PDF</strong>, open it from Files and use the ✏️ annotate / 📐 Measure button.' +
        '</div>' +
        '<div id="p86-plans-list">Loading…</div>' +
      '</div>';

    var newBtn = pane.querySelector('#p86-plans-new');
    if (newBtn) newBtn.onclick = openCreate;
    loadList();
  }

  function loadList() {
    var host = document.getElementById('p86-plans-list');
    if (!host) return;
    if (!api() || !api().plans) { host.innerHTML = emptyState('Plans API not available — refresh the page.'); return; }
    api().plans.list({ limit: 200 })
      .then(function (resp) {
        var plans = (resp && resp.plans) || [];
        if (!plans.length) {
          host.innerHTML = emptyState('No plans yet. Click <strong>New Plan</strong> to start a scaled drawing.');
          return;
        }
        host.innerHTML =
          '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:14px;">' +
          plans.map(planCard).join('') +
          '</div>';
        host.querySelectorAll('[data-plan-open]').forEach(function (el) {
          el.onclick = function () { openPlan(el.getAttribute('data-plan-open')); };
        });
        host.querySelectorAll('[data-plan-del]').forEach(function (el) {
          el.onclick = function (e) {
            e.stopPropagation();
            deletePlan(el.getAttribute('data-plan-del'));
          };
        });
      })
      .catch(function (err) {
        host.innerHTML = emptyState('Failed to load plans: ' + esc(err && err.message ? err.message : 'error'));
      });
  }

  function emptyState(html) {
    return '<div style="border:1px dashed var(--border,#333);border-radius:12px;padding:40px 20px;text-align:center;color:var(--text-dim,#9aa);font-size:13px;">' + html + '</div>';
  }

  function planCard(p) {
    var t = p.totals || {};
    var bits = [];
    if (t.lf) bits.push((Math.round(t.lf * 100) / 100) + ' ft');
    if (t.sf) bits.push((Math.round(t.sf * 100) / 100) + ' ft²');
    if (t.count) bits.push(t.count + ' count');
    var totalsLine = bits.length ? bits.join(' · ') : 'No measurements yet';
    var kindBadge = { blank: 'Blank canvas', sheet: 'Shop drawing', photo: 'Photo', pdf: 'PDF' }[p.base_kind] || p.base_kind;
    var when = p.updated_at ? new Date(p.updated_at).toLocaleDateString() : '';
    return '<div data-plan-open="' + esc(p.id) + '" style="border:1px solid var(--border,#333);border-radius:12px;overflow:hidden;cursor:pointer;background:rgba(255,255,255,0.02);transition:border-color 0.15s;" ' +
      'onmouseenter="this.style.borderColor=\'#4f8cff\'" onmouseleave="this.style.borderColor=\'\'">' +
      '<div style="height:120px;background:repeating-linear-gradient(0deg,#0f1117,#0f1117 19px,rgba(255,255,255,0.06) 20px),repeating-linear-gradient(90deg,transparent,transparent 19px,rgba(255,255,255,0.06) 20px);display:flex;align-items:center;justify-content:center;font-size:30px;">📐</div>' +
      '<div style="padding:10px 12px;">' +
        '<div style="font-weight:600;font-size:13.5px;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(p.name) + '</div>' +
        '<div style="font-size:11px;color:#86efac;margin-top:3px;">' + esc(totalsLine) + '</div>' +
        '<div style="font-size:10.5px;color:var(--text-dim,#888);margin-top:4px;display:flex;justify-content:space-between;">' +
          '<span>' + esc(kindBadge) + (when ? ' · ' + esc(when) : '') + '</span>' +
          '<button data-plan-del="' + esc(p.id) + '" title="Archive plan" style="background:transparent;border:0;color:#f87171;cursor:pointer;font-size:12px;padding:0 2px;">🗑</button>' +
        '</div>' +
      '</div>' +
    '</div>';
  }

  // ── Create ──────────────────────────────────────────────────────
  // v1: blank canvas. (Photo/PDF takeoffs use the in-place launchers.)
  // Styled modal for the name — matches the rest of the app (the
  // codebase moved off native window.prompt for this kind of input).
  function openCreate() {
    if (!api() || !api().plans) { toast('Plans API not available.'); return; }
    var overlay = document.createElement('div');
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10600;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);';
    var box = document.createElement('div');
    box.style.cssText = 'background:#0f0f1e;border:1px solid #353545;border-radius:12px;padding:20px 22px;max-width:420px;width:100%;box-shadow:0 16px 48px rgba(0,0,0,0.6);color:#e6e6e6;';
    box.innerHTML =
      '<div style="font-size:15px;font-weight:700;color:#fff;margin-bottom:4px;">📐 New Plan</div>' +
      '<div style="font-size:12px;color:#9aa;margin-bottom:12px;">Name it, then pick how you want to draw.</div>' +
      '<input id="p86-plan-name" type="text" autocomplete="off" value="Untitled plan" ' +
        'style="width:100%;box-sizing:border-box;background:#1a1a2e;color:#fff;border:1px solid #444;border-radius:6px;padding:10px 12px;font-size:14px;font-weight:600;outline:none;margin-bottom:14px;" />' +
      '<div style="display:flex;flex-direction:column;gap:8px;">' +
        '<button id="p86-plan-sheet" style="text-align:left;padding:12px 14px;background:rgba(79,140,255,0.10);color:#fff;border:1px solid rgba(79,140,255,0.4);border-radius:8px;cursor:pointer;">' +
          '<div style="font-weight:700;font-size:13.5px;">📐 Shop drawing (sheet)</div>' +
          '<div style="font-size:11px;color:#9aa;margin-top:2px;">CAD-style sheet: titleblock, plan + elevation views, ortho snapping, dimensions, layers.</div>' +
        '</button>' +
        '<button id="p86-plan-blank" style="text-align:left;padding:12px 14px;background:rgba(255,255,255,0.04);color:#fff;border:1px solid #444;border-radius:8px;cursor:pointer;">' +
          '<div style="font-weight:700;font-size:13.5px;">✏️ Blank takeoff canvas</div>' +
          '<div style="font-size:11px;color:#9aa;margin-top:2px;">Freeform gridded canvas — calibrate + take off LF / SF / counts.</div>' +
        '</button>' +
      '</div>' +
      '<div style="display:flex;justify-content:flex-end;margin-top:14px;">' +
        '<button id="p86-plan-cancel" style="padding:8px 16px;background:rgba(255,255,255,0.06);color:#ddd;border:1px solid #444;border-radius:6px;cursor:pointer;font-weight:600;">Cancel</button>' +
      '</div>';
    overlay.appendChild(box);
    document.body.appendChild(overlay);
    var input = box.querySelector('#p86-plan-name');
    function close() { if (overlay.parentNode) overlay.parentNode.removeChild(overlay); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      else if (e.key === 'Enter' && document.activeElement === input) { e.preventDefault(); commit('sheet'); }
    }
    function commit(kind) {
      var name = (input.value || '').trim() || 'Untitled plan';
      var payload = (kind === 'sheet')
        ? { name: name, base_kind: 'sheet', pages: [], totals: {} }
        : { name: name, base_kind: 'blank', width: DEFAULT_W, height: DEFAULT_H, grid_spacing: DEFAULT_GRID, pages: [], totals: {} };
      close();
      api().plans.create(payload).then(function (resp) {
        var plan = resp && resp.plan;
        if (!plan) { toast('Could not create plan.'); return; }
        openInViewer(plan);
      }).catch(function (err) {
        toast('Create failed: ' + (err && err.message ? err.message : 'error'));
      });
    }
    box.querySelector('#p86-plan-cancel').onclick = close;
    box.querySelector('#p86-plan-sheet').onclick = function () { commit('sheet'); };
    box.querySelector('#p86-plan-blank').onclick = function () { commit('blank'); };
    overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey, true);
    setTimeout(function () { input.focus(); input.select(); }, 0);
  }

  // ── Open / edit ─────────────────────────────────────────────────
  function openPlan(id) {
    if (!api() || !api().plans) return;
    api().plans.get(id).then(function (resp) {
      var plan = resp && resp.plan;
      if (!plan) { toast('Plan not found.'); return; }
      openInViewer(plan);
    }).catch(function (err) {
      toast('Open failed: ' + (err && err.message ? err.message : 'error'));
    });
  }

  // Open the markup viewer on a plan. Blank plans pass opts.blank (no
  // image); the plan's `pages` array is the viewer's annotations payload
  // (flat: calibration metas + page-tagged strokes). id:null routes Save
  // through onDone (no attachment PATCH), so the plan owns its data.
  function openInViewer(plan) {
    // Shop-drawing sheets open in the dedicated CAD-style editor; markup
    // plans (blank/photo/pdf) open in the markup/takeoff viewer.
    if (plan.base_kind === 'sheet') {
      if (!window.p86SheetEditor || typeof window.p86SheetEditor.open !== 'function') {
        toast('Sheet editor not loaded — refresh the page.');
        return;
      }
      window.p86SheetEditor.open({
        plan: plan,
        onSave: function (doc, totals) {
          api().plans.update(plan.id, { pages: [doc], totals: totals || {} })
            .then(function () { loadList(); })
            .catch(function (err) { toast('Save failed: ' + (err && err.message ? err.message : 'error')); });
        }
      });
      return;
    }
    if (!window.p86Markup || typeof window.p86Markup.open !== 'function') {
      toast('Markup viewer not loaded — refresh the page.');
      return;
    }
    var annotations = Array.isArray(plan.pages) ? plan.pages : [];
    var opts = {
      attachment: {
        id: null,
        filename: plan.name || 'Plan',
        entity_type: plan.entity_type || 'plan',
        entity_id: plan.entity_id || plan.id,
        annotations: annotations
      },
      onDone: function (result) {
        var anns = (result && Array.isArray(result.annotations)) ? result.annotations : [];
        var totals = (window.p86Markup && window.p86Markup.summarize)
          ? window.p86Markup.summarize(anns)
          : {};
        api().plans.update(plan.id, { pages: anns, totals: totals })
          .then(function () { loadList(); })
          .catch(function (err) { toast('Save failed: ' + (err && err.message ? err.message : 'error')); });
      }
    };
    if (plan.base_kind === 'blank' || !plan.base_attachment_id) {
      opts.blank = {
        w: plan.width || DEFAULT_W,
        h: plan.height || DEFAULT_H,
        gridPx: plan.grid_spacing || DEFAULT_GRID
      };
    }
    window.p86Markup.open(opts);
  }

  // ── Archive ─────────────────────────────────────────────────────
  function deletePlan(id) {
    if (!window.confirm('Archive this plan? It will be hidden from the list.')) return;
    api().plans.remove(id)
      .then(function () { loadList(); })
      .catch(function (err) { toast('Archive failed: ' + (err && err.message ? err.message : 'error')); });
  }

  window.renderPlansTab = renderPlansTab;
  window.p86Plans = { render: renderPlansTab, openCreate: openCreate, openPlan: openPlan };
})();
