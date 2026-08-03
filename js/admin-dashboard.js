/* Project 86 — Admin dashboard (landing).
   ─────────────────────────────────────────────────────────────
   Replaces "Admin opens on whichever sub-tab you last used" with a
   dashboard: a KPI ribbon, an attention band, and grouped section cards
   whose sub-tabs expand on the page. Eight admin destinations become
   four groups; the Command Center becomes a fifth, gated band.

   IT DELEGATES, IT DOES NOT REPLACE. Every sub-tab click hands off to the
   existing switchAdminSubTab() panes — nothing was relocated or rewritten.
   That keeps this safe to land on a live pilot: if the dashboard is wrong,
   the surfaces underneath it are untouched.

   PLATFORM BAND — the Command Center is embedded here as a band that only
   renders for system_admin, and it ROUTES to the existing /console rather
   than duplicating it. Two things matter about that gate:
     1. Hiding a card is NOT access control. The protection is that every
        console route is requireAuth + requireSystemAdmin server-side; a
        non-system-admin who somehow rendered these cards gets 403 from
        every endpoint behind them.
     2. An empty gated band renders NOTHING — no heading, no placeholder.
        A visible "Platform (no access)" would tell an org admin exactly
        what exists above them, which is a disclosure with no upside. */
(function () {
  'use strict';

  var HOST_ID = 'admin-dashboard-host';
  var _counts = null;      // last fetched, so a repaint isn't a refetch
  var _loading = false;

  function isSysAdmin() {
    try {
      return !!(window.p86Auth && typeof window.p86Auth.isSystemAdmin === 'function'
        && window.p86Auth.isSystemAdmin());
    } catch (e) { return false; }
  }

  function n(v) { return (v == null) ? '—' : String(v); }

  function goAdmin(sub) {
    return function () {
      if (typeof window.switchAdminSubTab === 'function') window.switchAdminSubTab(sub);
    };
  }
  function goConsole(view) {
    return function () {
      if (typeof window.switchTab === 'function') window.switchTab('console');
      if (typeof window.switchConsoleSubTab === 'function') window.switchConsoleSubTab(view);
    };
  }

  // ── live counts ─────────────────────────────────────────────────────
  // Each source is independent and failure-isolated: one dead endpoint
  // leaves its own tile as an em-dash rather than blanking the dashboard.
  function loadCounts(cb) {
    if (_loading) return;
    _loading = true;
    var out = { users: null, markets: null, marketsUnset: 0, tasks: null, leads: null };
    var pending = 3;
    function done() { if (--pending <= 0) { _loading = false; _counts = out; cb(out); } }

    try {
      window.p86Api.users.list()
        .then(function (r) { var a = (r && (r.users || r)) || []; out.users = Array.isArray(a) ? a.length : null; })
        .catch(function () {}).then(done);
    } catch (e) { done(); }

    try {
      window.p86Api.get('/api/markets')
        .then(function (r) {
          var a = (r && (r.markets || r)) || [];
          if (!Array.isArray(a)) return;
          out.markets = a.length;
          // "Configured" = has at least the paperwork that makes a market
          // operable. Counting the blanks is the whole point of surfacing
          // markets here: today every one of them is empty.
          out.marketsUnset = a.filter(function (m) {
            return !m.address && !m.license_no && m.sales_tax_rate == null && m.labor_rate_default == null;
          }).length;
        })
        .catch(function () {}).then(done);
    } catch (e) { done(); }

    try {
      window.p86Api.tasks.list({ exclude_done: 1, limit: 200 })
        .then(function (r) { var a = (r && (r.tasks || r)) || []; out.tasks = Array.isArray(a) ? a.length : null; })
        .catch(function () {}).then(done);
    } catch (e) { done(); }
  }

  // ── spec ────────────────────────────────────────────────────────────
  function buildSpec(c) {
    c = c || {};
    var sys = isSysAdmin();

    var kpis = [
      { label: 'Users',      value: n(c.users) },
      { label: 'Markets',    value: n(c.markets) },
      { label: 'Open tasks', value: n(c.tasks) },
      { label: 'Roles',      value: '—' },
      { label: 'Agents',     value: '3' },
      { label: 'Org',        value: 'AGX' }
    ];

    var attn = [];
    if (c.marketsUnset > 0) {
      attn.push({
        tone: 'w',
        text: 'Markets with no address, licence, tax rate or labour rate on file',
        note: c.marketsUnset + ' of ' + n(c.markets)
      });
    }
    if (c.tasks === 0) {
      attn.push({ tone: '', text: 'No open tasks — nothing is currently assigned or due', note: '0 open' });
    }

    var orgGroups = [
      { key: 'people', title: 'People', count: n(c.users) + ' users',
        pills: [{ label: 'Users', value: n(c.users) }],
        items: [
          { label: 'Users',      open: goAdmin('users') },
          { label: 'Roles',      open: goAdmin('roles') },
          { label: 'Compliance', open: goAdmin('compliance') }
        ] },
      { key: 'company', title: 'Company', count: n(c.markets) + ' markets',
        pills: (function () {
          var p = [{ label: 'Markets', value: n(c.markets) }];
          if (c.marketsUnset > 0) p.push({ gap: 'Market settings unset' });
          return p;
        })(),
        items: [
          { label: 'Organization', open: goAdmin('organization') }
        ] },
      { key: 'ai', title: 'AI', count: '3 agents',
        pills: [{ label: 'Agents', value: '3' }],
        items: [
          { label: 'Agents',  open: goAdmin('agents') },
          { label: 'Context', open: goAdmin('context') },
          { label: 'Usage',   open: goAdmin('metrics') }
        ] },
      { key: 'data', title: 'Data', count: 'pipelines',
        pills: [{ label: 'OCR', value: 'inbox' }],
        items: [
          { label: 'OCR Inbox', open: goAdmin('ocr-inbox') }
        ] }
    ];

    var bands = [{ label: null, groups: orgGroups }];

    if (sys) {
      bands.push({
        label: 'Platform · Command Center',
        note: 'system admin only',
        groups: [
          { key: 'health', title: 'Health', count: '4 views',
            pills: [{ label: 'Status', value: 'live' }],
            items: [
              { label: 'Overview',  open: goConsole('overview') },
              { label: 'Metrics',   open: goConsole('metrics') },
              { label: 'Forensics', open: goConsole('forensics') },
              { label: 'Audit',     open: goConsole('audit') }
            ] },
          { key: 'tenants', title: 'Tenants', count: 'orgs + plans',
            pills: [{ label: 'Orgs', value: '1' }],
            items: [{ label: 'Tenants', open: goConsole('tenants') }] },
          { key: 'services', title: 'Services', count: '3 vendors',
            pills: [{ label: 'Vendors', value: '3' }],
            items: [
              { label: 'Anthropic',  open: goConsole('anthropic') },
              { label: 'Email',      open: goConsole('email') },
              { label: 'BT mapping', open: goConsole('btmapping') }
            ] },
          { key: 'platform', title: 'Platform', count: '3 views',
            pills: [{ label: 'Docs', value: 'live' }],
            items: [
              { label: 'Docs',        open: goConsole('docs') },
              { label: 'Settings',    open: goConsole('settings') },
              { label: 'Danger Zone', open: goConsole('danger') }
            ] }
        ]
      });
    }

    return {
      eyebrow: 'ORGANIZATION',
      title: 'Admin',
      chip: n(c.markets) + ' markets · ' + n(c.users) + ' users',
      kpis: kpis,
      attn: attn,
      bands: bands
    };
  }

  function render() {
    var host = document.getElementById(HOST_ID);
    if (!host || !window.p86Dash) return;
    // Paint immediately from whatever is cached so the pane is never blank,
    // then repaint when counts land.
    window.p86Dash.render(host, buildSpec(_counts));
    if (!_counts) {
      loadCounts(function (c) {
        var h = document.getElementById(HOST_ID);
        if (h) window.p86Dash.render(h, buildSpec(c));
      });
    }
  }

  // ── back bar ────────────────────────────────────────────────────────
  // Landing on a dashboard and then drilling into a section is only half a
  // navigation model — without a way back you've replaced a dropdown with a
  // one-way door. Every admin sub-pane gets a "← Admin" bar; the dashboard
  // itself gets none (there is nothing above it).
  //
  // Injected rather than added to each pane's markup: there are eight panes
  // and more will arrive, and a bar that has to be pasted into each one is a
  // bar that will be missing from the ninth.
  var LABELS = {
    users: 'Users', roles: 'Roles', compliance: 'Compliance',
    organization: 'Organization', agents: 'Agents', context: 'Context',
    metrics: 'Usage', 'ocr-inbox': 'OCR Inbox'
  };

  function ensureBackBar(pane, name) {
    if (!pane) return;
    if (name === 'dashboard') return;           // nothing above the landing
    var BAR_ID = 'admin-backbar-' + name;
    if (document.getElementById(BAR_ID)) return; // already injected

    // Styles live in the shared shell so they exist wherever it does.
    if (window.p86Dash && window.p86Dash.injectStyle) window.p86Dash.injectStyle();
    var bar = document.createElement('div');
    bar.id = BAR_ID;
    bar.className = 'p86adm-back';
    bar.innerHTML =
      '<button type="button" class="p86adm-backbtn">' +
        '<span aria-hidden="true">&larr;</span> Admin</button>' +
      '<span class="p86adm-crumb">' + (LABELS[name] || name) + '</span>';
    bar.querySelector('.p86adm-backbtn').addEventListener('click', function () {
      if (typeof window.switchAdminSubTab === 'function') window.switchAdminSubTab('dashboard');
    });
    pane.insertBefore(bar, pane.firstChild);
  }

  window.renderAdminDashboard = render;
  window.p86AdminBackBar = ensureBackBar;
  window.p86AdminDashboard = { render: render, _spec: buildSpec };
})();
