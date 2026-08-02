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
      '.p86-ecard{position:relative;background:var(--surface,#1b1f2b);border:1px solid var(--border,#2a2a32);' +
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
      '.p86-ecard-ico:hover{background:var(--surface2,#202027);color:var(--text,#e9ecf5);}' +
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
      // Compact stat tiles — exact-dollar values made the old 14px/6x9 tiles
      // bulky; tightened per John ("smaller, more compact").
      '.p86-ecard-stats{display:flex;gap:6px;margin-top:8px;}' +
      '.p86-ecard-stat{flex:1;min-width:0;background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:7px;padding:4px 7px;}' +
      '.p86-ecard-stat-lbl{font-size:8.5px;color:var(--text-dim,#7f8699);text-transform:uppercase;letter-spacing:.4px;}' +
      '.p86-ecard-stat-val{font-size:11.5px;font-weight:600;color:var(--text,#e9ecf5);' +
        'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-stat-val.pos{color:var(--green,#34d399);}' +
      '.p86-ecard-stat-val.neg{color:var(--red,#f87171);}' +
      // Inline fact row (value · date · place). Replaces the boxed stat tiles
      // on cards that want the facts to read as one line instead of three
      // separate panels — the tiles cost a lot of vertical space in a sidebar
      // and the task list below is what actually earns that space.
      '.p86-ecard-facts{display:flex;align-items:center;flex-wrap:wrap;gap:4px 12px;margin-top:7px;}' +
      '.p86-ecard-fact{display:inline-flex;align-items:center;gap:5px;font-size:12.5px;' +
        'color:var(--text-dim,#9aa0b4);min-width:0;}' +
      '.p86-ecard-fact i{font-size:13px;flex:0 0 auto;opacity:.85;}' +
      '.p86-ecard-fact span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}' +
      '.p86-ecard-fact.money{color:var(--green,#34d399);font-weight:650;font-size:13.5px;}' +
      // Follow-up rows. The whole point of the card: what is owed on this
      // entity and when. Overdue is the one thing allowed to shout.
      '.p86-ecard-tasks{margin-top:9px;padding-top:8px;border-top:1px solid var(--border,#2a2f3e);' +
        'display:flex;flex-direction:column;gap:5px;}' +
      '.p86-ecard-task{display:flex;align-items:center;gap:7px;font-size:12.5px;min-width:0;}' +
      '.p86-ecard-task-dot{width:6px;height:6px;border-radius:50%;flex:0 0 auto;' +
        'background:var(--text-dim,#7f8699);}' +
      '.p86-ecard-task-dot.soon{background:var(--amber,#f59e0b);}' +
      '.p86-ecard-task-dot.overdue{background:var(--red,#f87171);}' +
      '.p86-ecard-task-t{flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;' +
        'white-space:nowrap;color:var(--text,#e9ecf5);}' +
      '.p86-ecard-task-due{flex:0 0 auto;font-size:11.5px;color:var(--text-dim,#7f8699);}' +
      '.p86-ecard-task-due.overdue{color:var(--red,#f87171);font-weight:600;}' +
      '.p86-ecard-task-more{font-size:11.5px;color:var(--text-dim,#7f8699);padding-left:13px;}' +
      // The empty state is an invitation, not silence. A card with nothing
      // owed used to render no follow-up section at all, which reads as
      // "this feature isn\'t here" rather than "nothing due" — and gives you
      // nowhere to add the first one.
      '.p86-ecard-addtask{display:inline-flex;align-items:center;gap:5px;background:transparent;' +
        'border:0;padding:0;margin:0;font:inherit;font-size:11.5px;color:var(--text-dim,#7f8699);' +
        'cursor:pointer;text-align:left;}' +
      '.p86-ecard-addtask:hover{color:var(--accent,#4f8cff);}' +
      '.p86-ecard-actions{display:flex;gap:8px;margin-top:11px;}' +
      '.p86-ecard-btn{display:inline-flex;align-items:center;justify-content:center;gap:5px;' +
        'background:var(--card-bg,#12151f);color:var(--text-dim,#9aa0b4);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:8px;padding:7px 12px;font-size:12px;font-weight:500;cursor:pointer;font-family:inherit;' +
        'transition:background .12s,border-color .12s;}' +
      '.p86-ecard-btn:hover{background:var(--surface2,#202027);}' +
      '.p86-ecard-btn.primary{flex:1;background:rgba(79,140,255,0.16);color:#9cc0ff;border-color:rgba(79,140,255,0.45);}' +
      '.p86-ecard-btn.primary:hover{background:rgba(79,140,255,0.24);}' +
      '.p86-ecard-btn i{font-size:13px;}' +
      /* Compact (subnav): keep the full card chrome (bg + border + left
         accent) so it reads as the Pulse card; render() drops the icon row
         and action buttons. Slightly tighter body padding. */
      '.p86-ecard.compact{background:var(--surface2,#202027);}' +
      '.p86-ecard.compact .p86-ecard-body{padding:11px 13px 12px 16px;}' +
      // Compact: ring sits TOP-RIGHT of the header so the title runs full-width.
      '.p86-ecard.compact .p86-ecard-head{align-items:flex-start;}' +
      '.p86-ecard.compact .p86-ecard-headring{flex:0 0 auto;margin:-2px -2px 0 8px;}' +
      '.p86-ecard.compact .p86-ecard-headring svg{width:42px;height:42px;display:block;}' +
      '.p86-ecard.compact .p86-ecard-title{white-space:normal;overflow:visible;text-overflow:clip;}';
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
    var map = { info: 'ti-info-circle', msg: 'ti-message', maps: 'ti-map-pin', file: 'ti-file-text', edit: 'ti-edit', addtask: 'ti-plus' };
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

    var hasRing = vm.ring && vm.ring.pct != null;
    // Compact cards put the ring top-right of the header (full-width title);
    // full cards keep it inline (see main below) and show the icon row.
    var headRing = (compact && hasRing)
      ? '<span class="p86-ecard-headring">' + ringSVG(vm.ring.pct, accent) + '</span>'
      : '';
    var head =
      '<div class="p86-ecard-head">' +
        '<span class="p86-ecard-statuswrap">' + kindChip + statusPill + '</span>' +
        // headRing is already gated on (compact && hasRing), so this reads:
        // a compact card WITH a ring shows the ring; anything else shows the
        // icon row. Previously a compact ringless card showed neither, which
        // is why the sidebar cards had no info/mail/map icons.
        (headRing || iconRow(vm.icons, baseData)) +
      '</div>';

    var titleRow =
      '<div class="p86-ecard-titlerow">' +
        ((vm.number && String(vm.number).length <= 12) ? '<span class="p86-ecard-num">' + esc(vm.number) + '</span>' : '') +
        '<span class="p86-ecard-title">' + esc(vm.title || '(untitled)') + '</span>' +
      '</div>' +
      (vm.subtitle ? '<div class="p86-ecard-sub">' + esc(vm.subtitle) + '</div>' : '') +
      (vm.address ? '<div class="p86-ecard-addr"><i class="ti ti-map-pin" aria-hidden="true"></i><span>' + esc(vm.address) + '</span></div>' : '');

    var ringInMain = hasRing && !compact;
    var main = ringInMain
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

    // Inline fact row — vm.facts:[{icon,text,tone}]. An alternative to
    // vm.stats, not a replacement: existing callers keep their tiles.
    var facts = '';
    if (vm.facts && vm.facts.length) {
      facts = '<div class="p86-ecard-facts">';
      for (var f = 0; f < vm.facts.length; f++) {
        var ft = vm.facts[f];
        if (!ft || !ft.text) continue;
        facts += '<span class="p86-ecard-fact' + (ft.tone === 'money' ? ' money' : '') + '">' +
          (ft.icon ? '<i class="ti ti-' + esc(ft.icon) + '" aria-hidden="true"></i>' : '') +
          '<span>' + esc(ft.text) + '</span></span>';
      }
      facts += '</div>';
    }

    // Follow-up rows — vm.tasks:[{title,due,tone}] plus vm.tasksMore.
    // Rendered only when there is something owed, so a clean entity doesn't
    // grow an empty section and a divider for nothing.
    // vm.canAddTask renders the add affordance — and, when there is nothing
    // owed, renders the section anyway so the empty state is reachable
    // instead of invisible.
    var addBtn = vm.canAddTask
      ? '<button type="button" class="p86-ecard-addtask" data-act="addtask"' + dataAttrs(baseData) +
          '><i class="ti ti-plus" aria-hidden="true"></i>Add follow-up</button>'
      : '';

    var tasks = '';
    if (!(vm.tasks && vm.tasks.length) && addBtn) {
      tasks = '<div class="p86-ecard-tasks">' + addBtn + '</div>';
    } else if (vm.tasks && vm.tasks.length) {
      tasks = '<div class="p86-ecard-tasks">';
      for (var t = 0; t < vm.tasks.length; t++) {
        var tk = vm.tasks[t];
        if (!tk || !tk.title) continue;
        var ttone = tk.tone === 'overdue' ? ' overdue' : tk.tone === 'soon' ? ' soon' : '';
        tasks += '<div class="p86-ecard-task">' +
          '<span class="p86-ecard-task-dot' + ttone + '"></span>' +
          '<span class="p86-ecard-task-t">' + esc(tk.title) + '</span>' +
          (tk.due ? '<span class="p86-ecard-task-due' + (tk.tone === 'overdue' ? ' overdue' : '') + '">' +
            esc(tk.due) + '</span>' : '') +
          '</div>';
      }
      if (vm.tasksMore > 0) {
        tasks += '<div class="p86-ecard-task-more">+' + vm.tasksMore + ' more</div>';
      }
      if (addBtn) tasks += addBtn;
      tasks += '</div>';
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
      '<div class="p86-ecard-body">' + head + main + facts + stats + tasks + actions + '</div></div>';
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

  // Map-pin color for an entity (via window.p86MapPins) — used as the card
  // accent so the card's left bar + ring match the entity's map pin. Leads →
  // blue; jobs → reno/wo/service/slate by number/type. Null if unavailable.
  function pinColor(entity, kind) {
    try {
      if (window.p86MapPins && window.p86MapPins.typeForEntity && window.p86MapPins.getConfig) {
        var t = window.p86MapPins.typeForEntity(entity, kind);
        var cfg = window.p86MapPins.getConfig();
        if (cfg && cfg[t] && cfg[t].color) return cfg[t].color;
      }
    } catch (e) {}
    return null;
  }

  // ── follow-up rows ──────────────────────────────────────────────────
  // Turn a tasks.due_date into the chip the card shows.
  //
  // TIMEZONE: due_date is a DATE column and arrives as 'YYYY-MM-DD'.
  // `new Date('2026-08-14')` parses that as UTC midnight, which in Florida
  // (UTC-4) is 8pm on the 13th — so a task due TODAY renders "Overdue" and
  // a red dot, every afternoon, for everyone. Parse the parts and build a
  // LOCAL date instead; compare date-only, never with a time component.
  function parseDueLocal(s) {
    if (!s) return null;
    var m = String(s).slice(0, 10).match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return null;
    return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }

  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  var MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

  /**
   * 'YYYY-MM-DD' → 'Aug 14'. For dates that are just a date (a job start,
   * a scheduled day) rather than a countdown — dueChip's Today/Overdue
   * vocabulary would be wrong for those. Same local-date parse, same
   * reason: never let a bare date shift a day by being read as UTC.
   */
  function shortDate(s) {
    var d = parseDueLocal(s);
    if (!d) return '';
    return MON[d.getMonth()] + ' ' + d.getDate();
  }

  function dueChip(dueDate) {
    var d = parseDueLocal(dueDate);
    if (!d) return { due: '', tone: '' };
    var now = new Date();
    var today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    var days = Math.round((d - today) / 86400000);
    if (days < 0) return { due: 'Overdue', tone: 'overdue' };
    if (days === 0) return { due: 'Today', tone: 'soon' };
    if (days === 1) return { due: 'Tomorrow', tone: 'soon' };
    if (days <= 6) return { due: DOW[d.getDay()], tone: 'soon' };
    return { due: MON[d.getMonth()] + ' ' + d.getDate(), tone: '' };
  }

  /**
   * Fetch the open org Tasks linked to one entity and shape them for the
   * card. Soonest due first, undated last (an undated task is a someday,
   * and it should never outrank something with a real deadline).
   *
   * Fully defensive: any failure calls back with an empty list, because a
   * task lookup must never be able to stop the card from rendering.
   */
  function loadTasks(entityType, entityId, max, cb) {
    max = max || 2;
    var done = function (list, more) { try { cb({ tasks: list, more: more }); } catch (e) {} };
    if (!entityType || !entityId || !window.p86Api || !window.p86Api.tasks) return done([], 0);
    var p;
    try {
      p = window.p86Api.tasks.list({
        entity_type: entityType, entity_id: String(entityId), exclude_done: 1, limit: 25
      });
    } catch (e) { return done([], 0); }
    if (!p || !p.then) return done([], 0);
    p.then(function (res) {
      var rows = (res && (res.tasks || res.rows || res)) || [];
      if (!Array.isArray(rows)) rows = [];
      rows.sort(function (a, b) {
        var da = parseDueLocal(a && a.due_date), db = parseDueLocal(b && b.due_date);
        if (da && db) return da - db;
        if (da) return -1;
        if (db) return 1;
        return 0;
      });
      var shown = rows.slice(0, max).map(function (r) {
        var c = dueChip(r && r.due_date);
        return { title: (r && r.title) || '', due: c.due, tone: c.tone };
      }).filter(function (r) { return r.title; });
      done(shown, Math.max(0, rows.length - shown.length));
    }).catch(function () { done([], 0); });
  }

  window.p86EntityCard = {
    render: render,
    injectStyle: injectStyle,
    dueChip: dueChip,
    shortDate: shortDate,
    loadTasks: loadTasks,
    jobStatusColor: jobStatusColor,
    leadStatusColor: leadStatusColor,
    estimateStatusColor: estimateStatusColor,
    pinColor: pinColor,
    _esc: esc
  };
})();
