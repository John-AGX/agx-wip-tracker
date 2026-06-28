/* Project 86 — shared entity card (job / lead / estimate).
   ─────────────────────────────────────────────────────────────
   One reusable "Pulse" card used in any sidebar / detail panel.
   Callers resolve their own data (WIP %, contract/profit, lead
   value, estimate total …) and pass a plain view-model; the card
   has NO external data dependencies, so it renders identically in
   the job-map sidebar, the contextual job subnav, a harness, etc.

     window.p86EntityCard.render(vm, opts) -> HTML string

   vm = {
     kind:      'job' | 'lead' | 'estimate',   // drives kind chip + defaults
     accent:    '#34d399',                      // left-bar + ring color (status color)
     status:    { label:'Open', color:'#34d399' },
     number:    'S2142' | null,                 // mono chip before the title
     title:     'Amara Stair Repairs & Paint',
     subtitle:  'PAC · Metrowest Apartments' | '',
     address:   '6168 Raleigh Street, Orlando FL' | '',
     ring:      { pct: 62 } | null,             // WIP ring (jobs)
     stats:     [ {label:'Contract', value:'$128k'},
                  {label:'Profit',   value:'+$31k', tone:'pos'} ],  // tone: pos|neg|default
     icons:     [ {act:'info', title:'Details'}, {act:'msg'}, {act:'maps'} ],
     actions:   [ {label:'Open WIP', act:'open', primary:true, icon:'arrow-right'},
                  {label:'Maps',     act:'maps'} ],
     data:      { id:'…', lat:28.5, lng:-81.4 }  // mirrored onto buttons as data-*
   }
   opts = { compact:false }  // compact (subnav): drops the icon row + action buttons

   Buttons/icons carry data-act (+ data-id/data-lat/data-lng), so the
   host panel wires clicks with one delegated listener — the card
   stays presentation-only. */
(function () {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  var STYLE_ID = 'p86-ecard-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var css =
      '.p86-ecard{position:relative;background:var(--surface,#1b1f2b);border:1px solid var(--border,#2e3346);' +
        'border-radius:12px;overflow:hidden;}' +
      '.p86-ecard-accent{position:absolute;left:0;top:10px;bottom:10px;width:4px;border-radius:0 4px 4px 0;}' +
      '.p86-ecard-body{padding:11px 13px 12px 17px;}' +
      '.p86-ecard-head{display:flex;align-items:center;justify-content:space-between;gap:8px;}' +
      '.p86-ecard-statuswrap{display:inline-flex;align-items:center;gap:7px;min-width:0;}' +
      '.p86-ecard-kind{font-family:var(--font-mono,ui-monospace,monospace);font-size:9.5px;letter-spacing:.5px;' +
        'color:var(--text-dim,#9aa0b4);background:var(--card-bg,#262c3a);border-radius:4px;padding:1px 5px;}' +
      '.p86-ecard-status{display:inline-flex;align-items:center;gap:6px;border-radius:999px;padding:3px 10px;' +
        'font-size:11px;font-weight:500;white-space:nowrap;}' +
      '.p86-ecard-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;}' +
      '.p86-ecard-icons{display:flex;gap:2px;flex:0 0 auto;}' +
      '.p86-ecard-ico{display:inline-flex;align-items:center;justify-content:center;width:26px;height:26px;' +
        'border:none;background:transparent;color:var(--text-dim,#8b91a7);border-radius:7px;cursor:pointer;' +
        'font-size:16px;transition:background .12s,color .12s;}' +
      '.p86-ecard-ico:hover{background:var(--surface2,#242836);color:var(--text,#e9ecf5);}' +
      '.p86-ecard-main{display:flex;gap:11px;align-items:center;}' +
      '.p86-ecard-main.no-ring{display:block;}' +
      '.p86-ecard-ring{flex:0 0 auto;}' +
      '.p86-ecard-meta{min-width:0;flex:1;}' +
      '.p86-ecard-titlerow{display:flex;align-items:baseline;gap:6px;}' +
      '.p86-ecard-num{font-family:var(--font-mono,ui-monospace,monospace);font-size:11px;color:var(--text,#c7cde0);' +
        'background:var(--card-bg,#262c3a);border-radius:5px;padding:1px 6px;flex:0 0 auto;}' +
      '.p86-ecard-title{font-size:14px;font-weight:500;color:var(--text,#e9ecf5);line-height:1.2;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-sub{font-size:12px;color:var(--text-dim,#9aa0b4);margin-top:3px;' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-addr{display:flex;align-items:center;gap:5px;font-size:11.5px;color:var(--text-dim,#7f8699);margin-top:4px;}' +
      '.p86-ecard-addr i{font-size:13px;flex:0 0 auto;}' +
      '.p86-ecard-addr span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-stats{display:flex;gap:8px;margin-top:11px;}' +
      '.p86-ecard-stat{flex:1;min-width:0;background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:8px;padding:6px 9px;}' +
      '.p86-ecard-stat-lbl{font-size:10px;color:var(--text-dim,#7f8699);text-transform:uppercase;letter-spacing:.4px;}' +
      '.p86-ecard-stat-val{font-size:14px;font-weight:500;color:var(--text,#e9ecf5);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-stat-val.pos{color:var(--green,#34d399);}' +
      '.p86-ecard-stat-val.neg{color:var(--red,#f87171);}' +
      '.p86-ecard-actions{display:flex;gap:8px;margin-top:11px;}' +
      '.p86-ecard-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;' +
        'background:var(--card-bg,#12151f);color:var(--text-dim,#9aa0b4);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:8px;padding:7px 12px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;' +
        'transition:background .12s,border-color .12s;}' +
      '.p86-ecard-btn:hover{background:var(--surface2,#242836);}' +
      '.p86-ecard-btn.primary{flex:1;background:rgba(79,140,255,0.16);color:#9cc0ff;border-color:rgba(79,140,255,0.45);}' +
      '.p86-ecard-btn.primary:hover{background:rgba(79,140,255,0.24);}' +
      '.p86-ecard-btn i{font-size:13px;}' +
      /* Compact (subnav): keep the full card chrome (bg + border + left
         accent) so it reads as the Pulse card; render() drops the icon row
         and action buttons. Slightly tighter body padding. */
      '.p86-ecard.compact{background:var(--surface2,#242836);}' +
      '.p86-ecard.compact .p86-ecard-body{padding:11px 13px 12px 16px;}';
    var el = document.createElement('style');
    el.id = STYLE_ID;
    el.textContent = css;
    (document.head || document.documentElement).appendChild(el);
  }

  function ringSVG(pct, color) {
    pct = Math.max(0, Math.min(100, Number(pct) || 0));
    var r = 19, circ = 2 * Math.PI * r, off = circ * (1 - pct / 100);
    return '<svg class="p86-ecard-ring" width="50" height="50" viewBox="0 0 50 50" aria-hidden="true">' +
      '<circle cx="25" cy="25" r="' + r + '" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="6"/>' +
      '<circle cx="25" cy="25" r="' + r + '" fill="none" stroke="' + (color || '#4f8cff') + '" stroke-width="6" ' +
        'stroke-linecap="round" stroke-dasharray="' + circ.toFixed(1) + '" stroke-dashoffset="' + off.toFixed(1) + '" ' +
        'transform="rotate(-90 25 25)"/>' +
      '<text x="25" y="29" text-anchor="middle" font-size="12" font-weight="600" fill="var(--text,#e9ecf5)">' +
        Math.round(pct) + '%</text>' +
    '</svg>';
  }

  function dataAttrs(d) {
    if (!d) return '';
    var out = '';
    for (var k in d) { if (d.hasOwnProperty(k) && d[k] != null) out += ' data-' + k + '="' + esc(d[k]) + '"'; }
    return out;
  }

  function iconRow(icons, baseData) {
    if (!icons || !icons.length) return '';
    var map = { info: 'ti-info-circle', msg: 'ti-message', maps: 'ti-map-pin', file: 'ti-file-text', edit: 'ti-edit' };
    var html = '<span class="p86-ecard-icons">';
    for (var i = 0; i < icons.length; i++) {
      var ic = icons[i];
      html += '<button type="button" class="p86-ecard-ico" data-act="' + esc(ic.act) + '"' + dataAttrs(baseData) +
        (ic.title ? ' title="' + esc(ic.title) + '" aria-label="' + esc(ic.title) + '"' : ' aria-label="' + esc(ic.act) + '"') +
        '><i class="ti ' + (map[ic.act] || 'ti-dots') + '" aria-hidden="true"></i></button>';
    }
    return html + '</span>';
  }

  function render(vm, opts) {
    injectStyle();
    vm = vm || {};
    opts = opts || {};
    var compact = !!opts.compact;
    var status = vm.status || {};
    var accent = vm.accent || status.color || 'var(--accent,#4f8cff)';
    var baseData = vm.data || {};

    var statusPill = status.label
      ? '<span class="p86-ecard-status" style="background:' + colorTint(status.color) + ';color:' + (status.color || 'var(--text,#e9ecf5)') + ';">' +
          '<span class="p86-ecard-dot" style="background:' + (status.color || '#4f8cff') + ';"></span>' + esc(status.label) + '</span>'
      : '';
    var kindChip = vm.kind && vm.kind !== 'job' ? '<span class="p86-ecard-kind">' + esc(String(vm.kind).toUpperCase()) + '</span>' : '';

    var head =
      '<div class="p86-ecard-head">' +
        '<span class="p86-ecard-statuswrap">' + kindChip + statusPill + '</span>' +
        (compact ? '' : iconRow(vm.icons, baseData)) +
      '</div>';

    var titleRow =
      '<div class="p86-ecard-titlerow">' +
        ((vm.number && String(vm.number).length <= 12) ? '<span class="p86-ecard-num">' + esc(vm.number) + '</span>' : '') +
        '<span class="p86-ecard-title">' + esc(vm.title || '(untitled)') + '</span>' +
      '</div>' +
      (vm.subtitle ? '<div class="p86-ecard-sub">' + esc(vm.subtitle) + '</div>' : '') +
      (vm.address ? '<div class="p86-ecard-addr"><i class="ti ti-map-pin" aria-hidden="true"></i><span>' + esc(vm.address) + '</span></div>' : '');

    var hasRing = vm.ring && vm.ring.pct != null;
    var main = hasRing
      ? '<div class="p86-ecard-main"><div>' + ringSVG(vm.ring.pct, accent) + '</div>' +
          '<div class="p86-ecard-meta">' + titleRow + '</div></div>'
      : '<div class="p86-ecard-main no-ring"><div class="p86-ecard-meta">' + titleRow + '</div></div>';

    var stats = '';
    if (vm.stats && vm.stats.length) {
      stats = '<div class="p86-ecard-stats">';
      for (var i = 0; i < vm.stats.length; i++) {
        var s = vm.stats[i];
        var tone = s.tone === 'pos' ? ' pos' : s.tone === 'neg' ? ' neg' : '';
        stats += '<div class="p86-ecard-stat"><div class="p86-ecard-stat-lbl">' + esc(s.label) + '</div>' +
          '<div class="p86-ecard-stat-val' + tone + '">' + esc(s.value) + '</div></div>';
      }
      stats += '</div>';
    }

    var actions = '';
    if (!compact && vm.actions && vm.actions.length) {
      actions = '<div class="p86-ecard-actions">';
      for (var a = 0; a < vm.actions.length; a++) {
        var act = vm.actions[a];
        actions += '<button type="button" class="p86-ecard-btn' + (act.primary ? ' primary' : '') + '" ' +
          'data-act="' + esc(act.act) + '"' + dataAttrs(baseData) + '>' + esc(act.label) +
          (act.icon ? ' <i class="ti ti-' + esc(act.icon) + '" aria-hidden="true"></i>' : '') + '</button>';
      }
      actions += '</div>';
    }

    return '<div class="p86-ecard' + (compact ? ' compact' : '') + '" data-kind="' + esc(vm.kind || '') + '">' +
      '<div class="p86-ecard-accent" style="background:' + accent + ';"></div>' +
      '<div class="p86-ecard-body">' + head + main + stats + actions + '</div></div>';
  }

  // status hex -> low-alpha tint for the pill background (works on dark + light).
  function colorTint(hex) {
    if (!hex || hex.charAt(0) !== '#') return 'var(--surface2,rgba(255,255,255,0.08))';
    var h = hex.slice(1);
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.slice(0, 2), 16), g = parseInt(h.slice(2, 4), 16), b = parseInt(h.slice(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',0.15)';
  }

  // Status -> color helpers so every caller maps consistently.
  function jobStatusColor(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'on hold' || s === 'on_hold') return '#fbbf24';
    if (s === 'completed' || s === 'complete') return '#38bdf8';
    if (s === 'archived' || s === 'closed') return '#8b90a5';
    return '#34d399'; // open / in progress / new
  }
  function leadStatusColor(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'won' || s === 'sold') return '#34d399';
    if (s === 'lost' || s === 'closed' || s === 'archived') return '#8b90a5';
    if (s === 'new') return '#38bdf8';
    return '#4f8cff'; // working / quoted
  }
  function estimateStatusColor(status) {
    var s = String(status || '').toLowerCase();
    if (s === 'accepted' || s === 'approved' || s === 'won') return '#34d399';
    if (s === 'sent' || s === 'submitted' || s === 'pending') return '#fbbf24';
    if (s === 'lost' || s === 'rejected') return '#f87171';
    return '#8b90a5'; // draft
  }

  window.p86EntityCard = {
    render: render,
    injectStyle: injectStyle,
    jobStatusColor: jobStatusColor,
    leadStatusColor: leadStatusColor,
    estimateStatusColor: estimateStatusColor,
    _esc: esc
  };
})();
