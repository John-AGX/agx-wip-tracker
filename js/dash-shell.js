/* Project 86 — shared dashboard shell.
   ─────────────────────────────────────────────────────────────
   ONE renderer for both admin surfaces. Admin (org tier) and the
   Command Center (platform tier) are different security boundaries but
   the same shape: a KPI ribbon, an attention band, then grouped section
   cards whose sub-items expand ON THE PAGE instead of hiding in a
   dropdown.

     window.p86Dash.render(hostEl, spec)

   spec = {
     eyebrow, title, chip,
     kpis:  [{ label, value, tone }],            tone: ok|warn|bad
     attn:  [{ tone, text, note }],              tone: ''|w|d
     bands: [{ label, note, groups: [...] }]     label null = no band header
   }
   group = {
     key, title, count,
     pills: [{ label, value } | { gap: 'text' }],
     items: [{ label, open: fn }]                sub-tabs, rendered inline
   }

   WHY A SHELL AND NOT TWO PAGES: the two surfaces drift the moment they
   are written twice — one gets a new tile, the other doesn't, and the
   thing that was supposed to make admin legible becomes two dialects of
   it. Grouping is declared as data here; only the data differs.

   The shell does NOT own the sections themselves. Clicking a sub-item
   calls its open() — which for admin hands off to the existing
   switchAdminSubTab panes, and for the console to switchConsoleSubTab.
   Nothing is relocated; this is a landing layer over what already works. */
(function () {
  'use strict';
  if (window.p86Dash) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var STYLE_ID = 'p86-dash-style';
  function injectStyle() {
    if (document.getElementById(STYLE_ID)) return;
    var s = document.createElement('style');
    s.id = STYLE_ID;
    s.textContent = [
      '.p86dash{display:flex;flex-direction:column;gap:13px;}',
      '.p86dash-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;}',
      '.p86dash-eyebrow{font-size:9px;letter-spacing:1.2px;color:var(--text-dim,#7f8699);text-transform:uppercase;}',
      '.p86dash-title{margin:3px 0 0;font-size:19px;font-weight:650;letter-spacing:-.2px;color:var(--text,#e9ecf5);}',
      '.p86dash-chip{font-size:11px;color:var(--text-dim,#9aa0b4);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:999px;padding:4px 11px;white-space:nowrap;}',
      // Ribbon — auto-fit so it packs tight on a narrow pane and spreads wide.
      '.p86dash-ribbon{display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px;}',
      '.p86dash-kpi{background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);' +
        'border-radius:9px;padding:8px 10px;min-width:0;}',
      '.p86dash-kpi .l{font-size:8.5px;letter-spacing:.6px;text-transform:uppercase;color:var(--text-dim,#7f8699);' +
        'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.p86dash-kpi .v{font-size:17px;font-weight:650;margin-top:4px;line-height:1.1;' +
        'font-variant-numeric:tabular-nums;color:var(--text,#e9ecf5);}',
      '.p86dash-kpi .v.ok{color:var(--green,#34d399);}',
      '.p86dash-kpi .v.warn{color:var(--amber,#f59e0b);}',
      '.p86dash-kpi .v.bad{color:var(--red,#f87171);}',
      // Attention band — only rendered when there is something to say.
      '.p86dash-attn{display:flex;flex-direction:column;gap:5px;}',
      '.p86dash-ar{display:flex;align-items:center;gap:11px;font-size:12px;padding:7px 11px;border-radius:7px;' +
        'background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);' +
        'border-left:2px solid var(--text-dim,#7f8699);}',
      '.p86dash-ar.w{border-left-color:var(--amber,#f59e0b);}',
      '.p86dash-ar.d{border-left-color:var(--red,#f87171);}',
      '.p86dash-ar .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;' +
        'color:var(--text,#e9ecf5);}',
      '.p86dash-ar.w .t{color:#f4cf94;} .p86dash-ar.d .t{color:#f6b0b0;}',
      '.p86dash-ar .n{font-variant-numeric:tabular-nums;font-weight:650;font-size:11.5px;' +
        'color:var(--text-dim,#7f8699);flex:0 0 auto;}',
      // Band label — what marks the platform tier as a different thing.
      '.p86dash-band{display:flex;align-items:baseline;gap:9px;margin-top:4px;}',
      '.p86dash-band .bl{font-size:8.5px;letter-spacing:1.1px;text-transform:uppercase;font-weight:600;' +
        'color:var(--text-dim,#7f8699);}',
      '.p86dash-band .bn{font-size:10.5px;color:var(--text-dim,#7f8699);}',
      '.p86dash-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,190px),1fr));gap:10px;}',
      '.p86dash-card{background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);border-radius:11px;' +
        'padding:11px 12px;display:flex;flex-direction:column;gap:9px;cursor:pointer;font:inherit;' +
        'color:inherit;text-align:left;min-width:0;transition:border-color .12s;width:100%;}',
      '.p86dash-card:hover{border-color:#3c465c;}',
      '.p86dash-card.open{border-color:#3f6bb8;background:var(--surface2,#151d2c);}',
      '.p86dash-card:focus-visible{outline:2px solid var(--accent,#4f8cff);outline-offset:2px;}',
      '.p86dash-ct{display:flex;justify-content:space-between;align-items:baseline;gap:8px;' +
        'font-size:13.5px;font-weight:650;color:var(--text,#e9ecf5);}',
      '.p86dash-cn{font-size:10px;color:var(--text-dim,#7f8699);font-weight:500;font-variant-numeric:tabular-nums;}',
      '.p86dash-pills{display:flex;flex-wrap:wrap;gap:4px;}',
      '.p86dash-pl{font-size:10px;color:var(--text-dim,#9aa0b4);background:var(--surface2,#1a1f2b);' +
        'border:1px solid var(--border,#2a2f3e);border-radius:999px;padding:2.5px 7px;white-space:nowrap;}',
      '.p86dash-pl b{color:var(--text,#e9ecf5);font-variant-numeric:tabular-nums;font-weight:650;}',
      '.p86dash-pl.gap{color:#f4cf94;border-color:#5c4a22;background:rgba(245,158,11,.10);}',
      // Sub-tabs, revealed in place. This is the dropdown replacement.
      '.p86dash-subs{display:flex;flex-wrap:wrap;gap:5px;padding-top:9px;margin-top:1px;' +
        'border-top:1px solid var(--border,#2a2f3e);}',
      '.p86dash-sub{font:inherit;font-size:11.5px;color:var(--text-dim,#9aa0b4);background:transparent;' +
        'border:1px solid var(--border,#2a2f3e);border-radius:6px;padding:4px 10px;cursor:pointer;}',
      '.p86dash-sub:hover{color:var(--text,#e9ecf5);border-color:#3c465c;}',
      '.p86dash-sub:focus-visible{outline:2px solid var(--accent,#4f8cff);outline-offset:1px;}',
      '@media (max-width:700px){.p86dash-cards{grid-template-columns:1fr;}}',
      // Back bar — lives HERE, not in either consumer, because both Admin and
      // the Command Center render one and a landing page you cannot return to
      // is a one-way door. Owning it in the shell means the style exists
      // wherever the shell does, rather than depending on which module
      // happened to load first.
      '.p86adm-back{display:flex;align-items:center;gap:10px;margin:0 0 12px;}',
      '.p86adm-backbtn{font:inherit;font-size:12px;color:var(--text-dim,#9aa0b4);background:transparent;' +
        'border:1px solid var(--border,#2a2f3e);border-radius:7px;padding:5px 11px;cursor:pointer;' +
        'display:inline-flex;align-items:center;gap:6px;}',
      '.p86adm-backbtn:hover{color:var(--text,#e9ecf5);border-color:#3c465c;}',
      '.p86adm-backbtn:focus-visible{outline:2px solid var(--accent,#4f8cff);outline-offset:2px;}',
      '.p86adm-crumb{font-size:12px;color:var(--text-dim,#7f8699);}'
    ].join('');
    document.head.appendChild(s);
  }

  function kpiHTML(k) {
    return '<div class="p86dash-kpi"><div class="l">' + esc(k.label) + '</div>' +
      '<div class="v ' + esc(k.tone || '') + '">' + esc(k.value) + '</div></div>';
  }

  function attnHTML(a) {
    return '<div class="p86dash-ar ' + esc(a.tone || '') + '">' +
      '<span class="t">' + esc(a.text) + '</span>' +
      (a.note ? '<span class="n">' + esc(a.note) + '</span>' : '') + '</div>';
  }

  function cardHTML(g, openKey) {
    var isOpen = openKey === g.key;
    var pills = (g.pills || []).map(function (p) {
      return p.gap
        ? '<span class="p86dash-pl gap">' + esc(p.gap) + '</span>'
        : '<span class="p86dash-pl">' + esc(p.label) + ' <b>' + esc(p.value) + '</b></span>';
    }).join('');
    var subs = isOpen && g.items && g.items.length
      ? '<span class="p86dash-subs">' + g.items.map(function (it, i) {
          return '<button type="button" class="p86dash-sub" data-sub="' + i + '">' + esc(it.label) + '</button>';
        }).join('') + '</span>'
      : '';
    // The card is a <button> so it is keyboard-reachable; the sub-tabs are
    // nested buttons, which is invalid HTML inside a button — so the card is
    // a div with role=button instead. Keeps both clickable AND focusable.
    return '<div class="p86dash-card' + (isOpen ? ' open' : '') + '" role="button" tabindex="0" ' +
      'aria-expanded="' + (isOpen ? 'true' : 'false') + '" data-key="' + esc(g.key) + '">' +
      '<span class="p86dash-ct">' + esc(g.title) +
        '<span class="p86dash-cn">' + esc(g.count || '') + '</span></span>' +
      '<span class="p86dash-pills">' + pills + '</span>' + subs + '</div>';
  }

  /**
   * Paint the dashboard into hostEl. Idempotent — safe to call on every
   * navigation; it fully replaces the host's contents and rebinds.
   */
  function render(host, spec) {
    if (!host || !spec) return;
    injectStyle();
    var openKey = host.__p86DashOpen || null;

    // Only render a band if it actually has groups — a gated band with
    // nothing in it must leave no trace, not an empty heading that hints
    // at what the viewer cannot see.
    var bands = (spec.bands || []).filter(function (b) { return b.groups && b.groups.length; });

    var html =
      '<div class="p86dash">' +
        '<div class="p86dash-head"><div>' +
          '<div class="p86dash-eyebrow">' + esc(spec.eyebrow || '') + '</div>' +
          '<h2 class="p86dash-title">' + esc(spec.title || '') + '</h2>' +
        '</div>' + (spec.chip ? '<div class="p86dash-chip">' + esc(spec.chip) + '</div>' : '') + '</div>' +
        ((spec.kpis && spec.kpis.length)
          ? '<div class="p86dash-ribbon">' + spec.kpis.map(kpiHTML).join('') + '</div>' : '') +
        ((spec.attn && spec.attn.length)
          ? '<div class="p86dash-attn">' + spec.attn.map(attnHTML).join('') + '</div>' : '') +
        bands.map(function (b, bi) {
          return (b.label
              ? '<div class="p86dash-band"><span class="bl">' + esc(b.label) + '</span>' +
                (b.note ? '<span class="bn">' + esc(b.note) + '</span>' : '') + '</div>'
              : '') +
            '<div class="p86dash-cards" data-band="' + bi + '">' +
              b.groups.map(function (g) { return cardHTML(g, openKey); }).join('') +
            '</div>';
        }).join('') +
      '</div>';

    host.innerHTML = html;

    // Current render's state, hung on the host so the ONE bound handler
    // below always reads the latest. Flat key lookup so a click resolves
    // its group without re-walking the bands.
    var byKey = {};
    bands.forEach(function (b) { b.groups.forEach(function (g) { byKey[g.key] = g; }); });
    host.__p86DashState = { spec: spec, byKey: byKey };

    // Bind ONCE per host. render() is re-entrant — toggling a card calls
    // it again — so binding per render would stack a handler pair on every
    // click: two renders in, one click fires twice, and it compounds from
    // there. The flag is on the element, not a module variable, because a
    // page can host more than one dashboard.
    if (host.__p86DashBound) return;
    host.__p86DashBound = true;

    function toggle(key) {
      host.__p86DashOpen = (host.__p86DashOpen === key) ? null : key;
      var st = host.__p86DashState;
      render(host, st && st.spec);
    }

    host.addEventListener('click', function (e) {
      var st = host.__p86DashState; if (!st) return;
      var sub = e.target.closest ? e.target.closest('.p86dash-sub') : null;
      if (sub && host.contains(sub)) {
        e.preventDefault(); e.stopPropagation();
        var card = sub.closest('.p86dash-card');
        var g = card && st.byKey[card.getAttribute('data-key')];
        var it = g && g.items && g.items[Number(sub.getAttribute('data-sub'))];
        if (it && typeof it.open === 'function') { try { it.open(); } catch (err) {} }
        return;
      }
      var c = e.target.closest ? e.target.closest('.p86dash-card') : null;
      if (c && host.contains(c)) toggle(c.getAttribute('data-key'));
    });

    host.addEventListener('keydown', function (e) {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      var c = e.target.closest ? e.target.closest('.p86dash-card') : null;
      if (!c || !host.contains(c)) return;
      if (e.target.classList.contains('p86dash-sub')) return; // native button handles it
      e.preventDefault();
      toggle(c.getAttribute('data-key'));
    });
  }

  window.p86Dash = { render: render, injectStyle: injectStyle, _esc: esc };
})();
