// Materials Consolidation — review panel (Assembly Studio "Consolidate" view).
// =====================================================================
// Groups the raw HD-purchase catalog's "likes" (the same real product wearing
// many descriptions) into one canonical "part" with a buy-count-weighted
// blended price. Reads GET /api/materials/consolidation-candidates (heuristic,
// read-only) and lets an estimator ratify each group: rename, fix the unit,
// drop mis-grouped SKUs, then one-click Create part -> POST /api/materials/
// consolidate (money-safe: mints a researched material, no purchase row).
//
// Mounted by assembly-studio.js loadView('consolidate'); window.p86Consolidate.
(function () {
  'use strict';

  var _hostId = null;
  var _data = null;         // candidates[] from server
  var _edits = {};          // key -> { name, unit, price, priceTouched, excluded:Set }
  var _filter = 'high';     // 'all' | 'high' | 'medium'
  var _loading = false;
  var _busy = {};           // key -> true while its Create is in-flight
  var _done = {};           // key -> {id, name} once created (this session)

  function esc(v) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(v == null ? '' : String(v));
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function toast(msg, kind) { if (typeof window.p86Toast === 'function') window.p86Toast(msg, kind || 'info'); }
  function money(n) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function canEdit() {
    return !window.p86Auth || typeof window.p86Auth.hasCapability !== 'function' ||
      window.p86Auth.hasCapability('ESTIMATES_EDIT');
  }

  // Stable edit-state for a card; seeded from the server suggestion on first touch.
  function editOf(g) {
    var e = _edits[g.key];
    if (!e) {
      e = _edits[g.key] = {
        name: g.suggestedName || '',
        unit: g.suggestedUnit || 'ea',
        price: (g.blendedPrice != null ? g.blendedPrice : ''),
        priceTouched: false,
        excluded: {}
      };
    }
    return e;
  }
  function includedMembers(g, e) {
    return (g.members || []).filter(function (m) { return !e.excluded[m.id]; });
  }
  // Client mirror of the server's buy-count-weighted blend, over INCLUDED members.
  function recomputeBlend(g, e) {
    var wsum = 0, psum = 0;
    includedMembers(g, e).forEach(function (m) {
      var price = Number(m.avg_unit_price != null ? m.avg_unit_price : m.last_unit_price);
      var w = Math.max(Number(m.purchase_count) || 0, 1);
      if (isFinite(price) && price >= 0) { wsum += w; psum += price * w; }
    });
    return wsum > 0 ? Math.round(psum / wsum * 100) / 100 : null;
  }

  function render(hostId) {
    _hostId = hostId || _hostId || 'asmstudio-section-consolidate';
    var host = document.getElementById(_hostId);
    if (!host) return;
    host.innerHTML =
      '<div class="p86-cons">' +
        '<div style="display:flex;align-items:flex-start;gap:16px;flex-wrap:wrap;margin-bottom:14px;">' +
          '<div style="flex:1;min-width:260px;font-size:13px;color:var(--text-dim,#8a93a6);line-height:1.5;max-width:680px;">' +
            'Your purchase catalog holds the same real product under many Home Depot descriptions. ' +
            'Consolidate the <strong style="color:var(--text,#fff);">likes</strong> into one canonical ' +
            '<strong style="color:var(--text,#fff);">part</strong> with a blended price built from what you\'ve ' +
            'actually paid. Review a group, drop anything mis-matched, then create the part.' +
          '</div>' +
          '<button id="p86cons-refresh" class="ghost" data-p86-icon="refresh" style="white-space:nowrap;align-self:flex-start;">Rescan</button>' +
        '</div>' +
        '<div id="p86cons-strip" class="p86-cons-strip"></div>' +
        '<div class="p86-cons-seg" id="p86cons-seg"></div>' +
        '<div id="p86cons-list" style="margin-top:12px;"></div>' +
      '</div>' +
      styleBlock();
    var rb = document.getElementById('p86cons-refresh');
    if (rb) rb.onclick = function () { load(true); };
    if (_data && !_loading) { paintStrip(); paintSeg(); paintList(); }
    else load(false);
  }

  function load(force) {
    if (_loading) return;
    _loading = true;
    if (force) { _data = null; _edits = {}; }
    var list = document.getElementById('p86cons-list');
    if (list) list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#8a93a6);font-size:13px;">Scanning the catalog for likes…</div>';
    window.p86Api.get('/api/materials/consolidation-candidates')
      .then(function (resp) {
        _loading = false;
        _data = resp || { candidates: [] };
        paintStrip(); paintSeg(); paintList();
      })
      .catch(function (err) {
        _loading = false;
        if (list) list.innerHTML = '<div style="padding:40px;text-align:center;color:var(--red,#e5484d);font-size:13px;">Could not load candidates: ' + esc(err && err.message || 'error') + '</div>';
      });
  }

  function counts() {
    var c = (_data && _data.candidates) || [];
    return {
      all: c.length,
      high: c.filter(function (g) { return g.confidence === 'high'; }).length,
      medium: c.filter(function (g) { return g.confidence === 'medium'; }).length
    };
  }

  function paintStrip() {
    var el = document.getElementById('p86cons-strip'); if (!el) return;
    var c = (_data && _data.candidates) || [];
    var n = counts();
    var skus = c.reduce(function (s, g) { return s + (g.members ? g.members.length : 0); }, 0);
    var buys = c.reduce(function (s, g) { return s + (g.totalBuys || 0); }, 0);
    function stat(label, val) {
      return '<div class="p86-cons-stat"><div class="p86-cons-stat-v">' + esc(val) + '</div><div class="p86-cons-stat-l">' + esc(label) + '</div></div>';
    }
    el.innerHTML =
      stat('Scanned', (_data && _data.scanned != null ? _data.scanned.toLocaleString() : '—')) +
      stat('Groups', n.all) +
      stat('High-confidence', n.high) +
      stat('SKUs coverable', skus) +
      stat('Purchases behind them', buys.toLocaleString());
  }

  function paintSeg() {
    var el = document.getElementById('p86cons-seg'); if (!el) return;
    var n = counts();
    var tabs = [['high', 'High-confidence (' + n.high + ')'], ['all', 'All (' + n.all + ')'], ['medium', 'Everything else (' + n.medium + ')']];
    el.innerHTML = tabs.map(function (t) {
      return '<button class="p86-cons-segbtn' + (_filter === t[0] ? ' active' : '') + '" data-f="' + t[0] + '">' + esc(t[1]) + '</button>';
    }).join('');
    Array.prototype.forEach.call(el.querySelectorAll('.p86-cons-segbtn'), function (b) {
      b.onclick = function () { _filter = b.getAttribute('data-f'); paintSeg(); paintList(); };
    });
  }

  function visibleGroups() {
    var c = (_data && _data.candidates) || [];
    if (_filter === 'all') return c;
    return c.filter(function (g) { return g.confidence === _filter; });
  }

  function paintList() {
    var host = document.getElementById('p86cons-list'); if (!host) return;
    var groups = visibleGroups();
    if (!groups.length) {
      host.innerHTML = '<div style="padding:40px;text-align:center;color:var(--text-dim,#8a93a6);font-size:13px;">No groups in this view. ' +
        (_filter !== 'all' ? 'Try <strong>All</strong>.' : 'Nothing to consolidate right now.') + '</div>';
      return;
    }
    host.innerHTML = groups.map(cardHtml).join('');
    // Wire per-card handlers (event delegation kept simple: bind after paint).
    groups.forEach(function (g) { wireCard(g); });
  }

  function confBadge(conf) {
    if (conf === 'high') return '<span class="p86-cons-badge hi">HIGH</span>';
    return '<span class="p86-cons-badge med">REVIEW</span>';
  }

  function cardHtml(g) {
    var e = editOf(g);
    var created = _done[g.key];
    var incl = includedMembers(g, e);
    var blend = e.priceTouched ? e.price : recomputeBlend(g, e);
    var memberRows = (g.members || []).map(function (m) {
      var off = !!e.excluded[m.id];
      var price = (m.avg_unit_price != null ? m.avg_unit_price : m.last_unit_price);
      return '<div class="p86-cons-mem' + (off ? ' off' : '') + '" data-mid="' + esc(m.id) + '">' +
          '<button class="p86-cons-memtog" title="' + (off ? 'Add back to this part' : 'Drop from this part') + '">' + (off ? '＋' : '✕') + '</button>' +
          '<div class="p86-cons-memdesc">' + esc(m.description || m.raw_description || ('#' + m.id)) + '</div>' +
          '<div class="p86-cons-memprice">' + money(price) + '</div>' +
          '<div class="p86-cons-membuys">×' + (Number(m.purchase_count) || 0) + '</div>' +
        '</div>';
    }).join('');

    return '<div class="p86-cons-card' + (created ? ' created' : '') + '" data-key="' + esc(g.key) + '">' +
        '<div class="p86-cons-head">' +
          confBadge(g.confidence) +
          '<input class="p86-cons-name" value="' + esc(e.name) + '" placeholder="Part name" ' + (created ? 'disabled' : '') + ' />' +
          (g.category ? '<span class="p86-cons-cat">' + esc(g.category) + '</span>' : '') +
          '<div class="p86-cons-hero">' + (blend != null ? money(blend) : '—') + '<span class="p86-cons-hero-u">/' + esc(e.unit || 'ea') + '</span></div>' +
        '</div>' +
        '<div class="p86-cons-sub">' + incl.length + ' of ' + (g.members || []).length + ' SKUs · ' +
          (g.totalBuys || 0) + ' purchases · blended from what you\'ve paid</div>' +
        '<div class="p86-cons-mems">' + memberRows + '</div>' +
        '<div class="p86-cons-foot">' +
          (created
            ? '<span class="p86-cons-okmsg" data-p86-icon="check">Created “' + esc(created.name) + '” — members hidden</span>'
            : ('<label class="p86-cons-fl">Unit <input class="p86-cons-unit" value="' + esc(e.unit || 'ea') + '" /></label>' +
               '<label class="p86-cons-fl">Price <input class="p86-cons-price" type="number" step="0.01" value="' + (blend != null ? esc(blend) : '') + '" /></label>' +
               '<span style="flex:1;"></span>' +
               (canEdit()
                 ? '<button class="p86-cons-create"' + (_busy[g.key] ? ' disabled' : '') + '>' + (_busy[g.key] ? 'Creating…' : 'Create part') + '</button>'
                 : '<span style="font-size:12px;color:var(--text-dim,#8a93a6);">View-only</span>'))) +
        '</div>' +
      '</div>';
  }

  function wireCard(g) {
    var card = document.querySelector('.p86-cons-card[data-key="' + cssEsc(g.key) + '"]');
    if (!card) return;
    var e = editOf(g);
    var nameEl = card.querySelector('.p86-cons-name');
    var unitEl = card.querySelector('.p86-cons-unit');
    var priceEl = card.querySelector('.p86-cons-price');
    if (nameEl) nameEl.oninput = function () { e.name = nameEl.value; };
    if (unitEl) unitEl.oninput = function () { e.unit = unitEl.value; syncHero(g); };
    if (priceEl) priceEl.oninput = function () { e.price = priceEl.value; e.priceTouched = true; syncHero(g); };
    Array.prototype.forEach.call(card.querySelectorAll('.p86-cons-mem'), function (row) {
      var tog = row.querySelector('.p86-cons-memtog');
      if (!tog) return;
      tog.onclick = function () {
        var mid = row.getAttribute('data-mid');
        if (e.excluded[mid]) delete e.excluded[mid]; else e.excluded[mid] = true;
        // Re-blend (unless the user hand-set a price) and repaint just this card.
        if (!e.priceTouched) { var b = recomputeBlend(g, e); e.price = (b != null ? b : ''); }
        repaintCard(g);
      };
    });
    var createBtn = card.querySelector('.p86-cons-create');
    if (createBtn) createBtn.onclick = function () { doCreate(g); };
  }

  function syncHero(g) {
    var e = editOf(g);
    var card = document.querySelector('.p86-cons-card[data-key="' + cssEsc(g.key) + '"]');
    if (!card) return;
    var hero = card.querySelector('.p86-cons-hero');
    var blend = e.priceTouched ? Number(e.price) : recomputeBlend(g, e);
    if (hero) hero.innerHTML = (blend != null && isFinite(blend) ? money(blend) : '—') + '<span class="p86-cons-hero-u">/' + esc(e.unit || 'ea') + '</span>';
  }

  function repaintCard(g) {
    var card = document.querySelector('.p86-cons-card[data-key="' + cssEsc(g.key) + '"]');
    if (!card) return;
    var wrap = document.createElement('div');
    wrap.innerHTML = cardHtml(g);
    var fresh = wrap.firstChild;
    card.parentNode.replaceChild(fresh, card);
    wireCard(g);
  }

  function cssEsc(s) {
    if (window.CSS && CSS.escape) return CSS.escape(s);
    return String(s).replace(/["\\]/g, '\\$&');
  }

  function doCreate(g) {
    var e = editOf(g);
    var incl = includedMembers(g, e);
    var name = (e.name || '').trim();
    if (!name) { toast('Give the part a name first.', 'error'); return; }
    if (incl.length < 1) { toast('Keep at least one SKU in the part.', 'error'); return; }
    var price = e.priceTouched ? Number(e.price) : recomputeBlend(g, e);
    var body = {
      name: name,
      unit: (e.unit || 'ea').trim() || 'ea',
      category: g.category || null,
      blendedPrice: (price != null && isFinite(price)) ? price : null,
      memberIds: incl.map(function (m) { return m.id; }),
      sourceKey: g.key
    };
    var go = (typeof window.p86Confirm === 'function')
      ? window.p86Confirm({
          title: 'Create standard part?',
          message: 'Create “' + name + '” at ' + money(body.blendedPrice) + '/' + body.unit + ' and fold ' +
            incl.length + ' catalog SKU' + (incl.length === 1 ? '' : 's') + ' into it. ' +
            'The originals are hidden (not deleted) and no purchase history changes.',
          confirmText: 'Create part',
          cancelText: 'Cancel'
        })
      : Promise.resolve(window.confirm('Create part "' + name + '"?'));
    Promise.resolve(go).then(function (ok) {
      if (!ok) return;
      _busy[g.key] = true; repaintCard(g);
      window.p86Api.post('/api/materials/consolidate', body)
        .then(function (resp) {
          _busy[g.key] = false;
          _done[g.key] = { id: resp && resp.material && resp.material.id, name: name };
          toast('Created “' + name + '”' + (resp && resp.repointed ? (' · re-pointed ' + resp.repointed + ' recipe line' + (resp.repointed === 1 ? '' : 's')) : ''), 'success');
          repaintCard(g);
        })
        .catch(function (err) {
          _busy[g.key] = false; repaintCard(g);
          toast('Create failed: ' + (err && err.message || 'error'), 'error');
        });
    });
  }

  function styleBlock() {
    return '<style>' +
      '.p86-cons-strip{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;}' +
      '.p86-cons-stat{flex:1;min-width:120px;background:var(--card-bg,rgba(255,255,255,0.03));border:1px solid var(--border,#2a2f3a);border-radius:10px;padding:12px 14px;}' +
      '.p86-cons-stat-v{font-size:20px;font-weight:700;color:var(--text,#fff);font-variant-numeric:tabular-nums;}' +
      '.p86-cons-stat-l{font-size:11px;color:var(--text-dim,#8a93a6);margin-top:2px;text-transform:uppercase;letter-spacing:.04em;}' +
      '.p86-cons-seg{display:inline-flex;gap:2px;background:var(--card-bg,rgba(255,255,255,0.03));border:1px solid var(--border,#2a2f3a);border-radius:9px;padding:3px;}' +
      '.p86-cons-segbtn{background:transparent;border:0;color:var(--text-dim,#8a93a6);font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:7px;cursor:pointer;}' +
      '.p86-cons-segbtn.active{background:var(--accent,#4a7dff);color:#fff;}' +
      '.p86-cons-card{background:var(--card-bg,rgba(255,255,255,0.03));border:1px solid var(--border,#2a2f3a);border-radius:12px;padding:14px 16px;margin-bottom:12px;}' +
      '.p86-cons-card.created{opacity:.62;}' +
      '.p86-cons-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}' +
      '.p86-cons-badge{font-size:10px;font-weight:800;letter-spacing:.06em;padding:3px 7px;border-radius:5px;}' +
      '.p86-cons-badge.hi{background:rgba(46,160,67,0.18);color:var(--green,#3fb950);}' +
      '.p86-cons-badge.med{background:rgba(210,153,34,0.16);color:var(--orange,#d29922);}' +
      '.p86-cons-name{flex:1;min-width:160px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:8px;padding:7px 10px;color:var(--text,#fff);font-size:14px;font-weight:600;}' +
      '.p86-cons-name:disabled{opacity:.7;}' +
      '.p86-cons-cat{font-size:11px;color:var(--text-dim,#8a93a6);background:rgba(255,255,255,0.05);border-radius:5px;padding:3px 7px;}' +
      '.p86-cons-hero{font-size:20px;font-weight:700;color:var(--green,#3fb950);font-variant-numeric:tabular-nums;white-space:nowrap;}' +
      '.p86-cons-hero-u{font-size:12px;color:var(--text-dim,#8a93a6);font-weight:500;margin-left:2px;}' +
      '.p86-cons-sub{font-size:12px;color:var(--text-dim,#8a93a6);margin:8px 0 10px;}' +
      '.p86-cons-mems{display:flex;flex-direction:column;gap:4px;}' +
      '.p86-cons-mem{display:flex;align-items:center;gap:10px;padding:5px 8px;border-radius:7px;background:rgba(255,255,255,0.02);}' +
      '.p86-cons-mem.off{opacity:.4;}' +
      '.p86-cons-mem.off .p86-cons-memdesc{text-decoration:line-through;}' +
      '.p86-cons-memtog{width:22px;height:22px;flex:none;border:1px solid var(--border,#2a2f3a);background:transparent;color:var(--text-dim,#8a93a6);border-radius:6px;cursor:pointer;font-size:12px;line-height:1;}' +
      '.p86-cons-memtog:hover{color:var(--text,#fff);border-color:var(--text-dim,#8a93a6);}' +
      '.p86-cons-memdesc{flex:1;font-size:13px;color:var(--text,#fff);}' +
      '.p86-cons-memprice{font-size:13px;color:var(--text-dim,#8a93a6);font-variant-numeric:tabular-nums;min-width:64px;text-align:right;}' +
      '.p86-cons-membuys{font-size:12px;color:var(--text-dim,#8a93a6);min-width:36px;text-align:right;}' +
      '.p86-cons-foot{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-top:12px;padding-top:12px;border-top:1px solid var(--border,#2a2f3a);}' +
      '.p86-cons-fl{font-size:12px;color:var(--text-dim,#8a93a6);display:inline-flex;align-items:center;gap:6px;}' +
      '.p86-cons-fl input{width:72px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#2a2f3a);border-radius:7px;padding:6px 8px;color:var(--text,#fff);font-size:13px;}' +
      '.p86-cons-fl input.p86-cons-unit{width:56px;}' +
      '.p86-cons-create{background:var(--accent,#4a7dff);border:0;color:#fff;font-size:13px;font-weight:600;padding:8px 16px;border-radius:8px;cursor:pointer;}' +
      '.p86-cons-create:disabled{opacity:.6;cursor:default;}' +
      '.p86-cons-okmsg{font-size:13px;color:var(--green,#3fb950);font-weight:600;}' +
      '</style>';
  }

  window.p86Consolidate = { render: render, reload: function () { load(true); } };
})();
