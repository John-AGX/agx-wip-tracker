// Project 86 Leads module — sales pipeline rendered on the Estimates tab.
//
// Phase 1: list + create/edit/delete with the General fields. Status pipeline
// is the spine: New -> In Progress -> Sent -> Sold | Lost | No Opportunity.
// Phase 2 will add the lead detail view with a Proposals (estimates) sub-tab.
(function() {
  'use strict';

  var _leads = [];
  // In-flight leads.list() promise while a (re)load is loading. Lets
  // openEditLeadModal join a fetch that just wiped the cache instead of
  // racing it with an extra get-by-id round trip.
  var _leadsFetchInflight = null;
  // True once a leads.list() fetch has completed successfully. Distinguishes
  // "not fetched yet" (→ load) from "fetched, org genuinely has zero leads"
  // (→ empty state) so renderLeadsList doesn't refetch forever on an empty
  // response. Cleared by reloadLeadsCache so a refresh actually re-fetches.
  var _leadsLoaded = false;
  // Shared filter drawer + saved views (mirrors Cost Inbox).
  var _leadsDrawer = null;      // active filter values, or null
  var _leadsViews = [];         // this user's saved Leads views
  var _leadsActiveViewId = null;
  var _leadsViewsLoaded = false;

  // Status enum metadata. Drives the filter dropdown, the editor modal,
  // the list pill colors, and the status flow comments. Keep order in
  // sync with the index.html selects.
  var STATUSES = [
    { key: 'new',             label: 'New',             color: '#4f8cff', bg: 'rgba(79,140,255,0.12)' },
    { key: 'in_progress',     label: 'In Progress',     color: '#fbbf24', bg: 'rgba(251,191,36,0.12)' },
    { key: 'sent',            label: 'Sent',            color: '#60a5fa', bg: 'rgba(96,165,250,0.12)' },
    { key: 'sold',            label: 'Sold',            color: '#34d399', bg: 'rgba(52,211,153,0.15)' },
    { key: 'lost',            label: 'Lost',            color: '#f87171', bg: 'rgba(248,113,113,0.12)' },
    { key: 'no_opportunity',  label: 'No Opportunity',  color: '#8b90a5', bg: 'rgba(139,144,165,0.10)' }
  ];
  function statusMeta(key) { return STATUSES.find(function(s) { return s.key === key; }) || STATUSES[0]; }

  function escapeAttr(v) { return escapeHTML(v == null ? '' : String(v)); }
  function fmtCurrencyShort(n) {
    if (n == null || isNaN(n)) return '';
    n = Number(n);
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(2) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'k';
    return '$' + Math.round(n).toLocaleString();
  }
  // Full precision currency — no thousands/millions rounding.
  // $234,567.89 not $234k. Used by the leads Revenue column.
  function fmtCurrencyFull(n) {
    if (n == null || isNaN(n)) return '';
    n = Number(n);
    return '$' + n.toLocaleString('en-US', {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
    });
  }
  // Find the revenue figure for a lead based on its attached estimates.
  // - No estimates attached  → null (renders as blank)
  // - One estimate attached  → that estimate's clientPrice
  // - Multiple attached      → the HIGHEST clientPrice across them
  // Reads from the global appData.estimates / appData.estimateLines and
  // computes via computeEstimateTotals (in estimates.js). Skipped
  // safely if the estimate data hasn't loaded yet (returns null).
  function revenueFromAttachedEstimates(leadId) {
    if (!leadId) return null;
    if (typeof window.appData === 'undefined') return null;
    if (!Array.isArray(window.appData.estimates)) return null;
    if (typeof window.computeEstimateTotals !== 'function') return null;
    var attached = window.appData.estimates.filter(function(e) {
      return e && e.lead_id === leadId;
    });
    if (!attached.length) return null;
    var maxPrice = null;
    attached.forEach(function(e) {
      try {
        var t = window.computeEstimateTotals(e);
        var p = t && t.clientPrice;
        if (p != null && !isNaN(p) && (maxPrice == null || p > maxPrice)) maxPrice = p;
      } catch (err) { /* skip */ }
    });
    return maxPrice;
  }
  // Project 86-side only uses the single estimated revenue figure (the min).
  // Kept the same function name and accepts (low, high) for back-compat
  // with existing call sites — the high arg is ignored.
  function fmtRevenueRange(low /*, high */) {
    if (low == null || low === '' || Number(low) === 0) return '';
    return fmtCurrencyShort(low);
  }
  function fmtDate(s) {
    if (!s) return '';
    var d = new Date(s);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  // ──────────────────────────────────────────────────────────────────
  // List + filter
  // ──────────────────────────────────────────────────────────────────

  // BT-style column layout — sortable header, dense rows, status pill,
  // numeric columns right-aligned. Click anywhere on a row to open the
  // editor.
  var _leadsSort = { key: 'updated_at', dir: 'desc' };
  var _leadsView = 'list';   // 'list' | 'map' — toggled by the toolbar 🗺 button
  var _leadsSelected = new Set(); // lead ids ticked for bulk delete (survives re-render)

  // Bulk delete is a destructive edit — only surface the checkboxes to users who
  // can actually delete leads. The server re-enforces LEADS_EDIT regardless.
  function canBulkEditLeads() {
    try { return !!(window.p86Auth && window.p86Auth.hasCapability && window.p86Auth.hasCapability('LEADS_EDIT')); }
    catch (e) { return false; }
  }

  function _syncLeadsMapToggleBtn() {
    var b = document.getElementById('leads-map-toggle');
    if (b) {
      b.style.background = (_leadsView === 'map') ? 'rgba(79,140,255,0.18)' : '';
      b.style.borderColor = (_leadsView === 'map') ? '#4f8cff' : '';
      b.style.color = (_leadsView === 'map') ? '#93c5fd' : '';
    }
  }
  function toggleLeadsMapView() {
    _leadsView = (_leadsView === 'map') ? 'list' : 'map';
    _syncLeadsMapToggleBtn();
    renderLeadsList();
  }
  window.toggleLeadsMapView = toggleLeadsMapView;

  // Deterministic view setter (vs the flip-flop toggle above). The sidebar
  // Leads dropdown wires "Leads List" → setLeadsView('list') and "Leads
  // Map" → setLeadsView('map') so each child lands on a known view instead
  // of toggling whatever was last shown. No-op re-render is cheap; we always
  // re-render so a child click from another tab paints the right view.
  function setLeadsView(v) {
    _leadsView = (v === 'map' || v === 'activities') ? v : 'list';
    _syncLeadsMapToggleBtn();
    renderLeadsList();
  }
  window.setLeadsView = setLeadsView;

  // ── Column catalog (add/remove which fields show; all available for export) ──
  // Comprehensive BT-style field set. DEFAULT_COLS is the "standard" visible set;
  // the Views ▾ → Columns chooser toggles any of these on/off, and Export writes
  // every column regardless of what's visible.
  var LEAD_COLS = [
    { key: 'title', label: 'Title', sort: true },
    { key: 'client', label: 'Client', sort: true },
    { key: 'status', label: 'Status', sort: true },
    { key: 'confidence', label: 'Conf', sort: true, num: true },
    { key: 'revenue', label: 'Est. Revenue', sort: true, num: true },
    { key: 'est_rev_low', label: 'Rev Low', sort: true, num: true },
    { key: 'est_rev_high', label: 'Rev High', sort: true, num: true },
    { key: 'salesperson', label: 'Salesperson', sort: true },
    { key: 'source', label: 'Source', sort: true },
    { key: 'project_type', label: 'Project Type', sort: true },
    { key: 'market', label: 'Market', sort: true },
    { key: 'property_name', label: 'Property / Community', sort: true },
    { key: 'street_address', label: 'Street', sort: true },
    { key: 'city', label: 'City', sort: true },
    { key: 'state', label: 'State', sort: true },
    { key: 'zip', label: 'Zip', sort: true },
    { key: 'gate_code', label: 'Gate Code', sort: false },
    { key: 'projected_sale_date', label: 'Proj. Sale', sort: true },
    { key: 'next_followup_at', label: 'Next F/U', sort: true },
    { key: 'status_changed_at', label: 'In Stage', sort: true, num: true },
    { key: 'converted_at', label: 'Converted', sort: true },
    { key: 'lost_at', label: 'Lost', sort: true },
    { key: 'lost_reason', label: 'Lost Reason', sort: true },
    { key: 'notes', label: 'Notes', sort: false },
    { key: 'created_at', label: 'Created', sort: true },
    { key: 'updated_at', label: 'Updated', sort: true },
    { key: 'id', label: 'Lead ID', sort: false }
  ];
  var LEADS_DEFAULT_COLS = ['title', 'client', 'status', 'revenue', 'confidence', 'salesperson', 'project_type', 'projected_sale_date', 'next_followup_at', 'status_changed_at', 'updated_at'];
  var _leadCols = null;   // visible column keys; null → LEADS_DEFAULT_COLS
  function leadAllColKeys() { return LEAD_COLS.map(function (c) { return c.key; }); }
  function leadVisibleCols() { var keys = _leadCols || LEADS_DEFAULT_COLS; return LEAD_COLS.filter(function (c) { return keys.indexOf(c.key) >= 0; }); }
  function persistLeadCols() { try { localStorage.setItem('p86-leads-cols', JSON.stringify(_leadCols || LEADS_DEFAULT_COLS)); } catch (e) {} }
  function restoreLeadCols() { try { var s = JSON.parse(localStorage.getItem('p86-leads-cols') || 'null'); if (Array.isArray(s) && s.length) _leadCols = s; } catch (e) {} }
  var _isTerminalLead = function (l) { return ['sold', 'lost', 'no_opportunity'].indexOf(l.status) !== -1; };
  var _overdueDate = function (val, active) { if (!val) return false; var t = new Date(val).getTime(); return active && !isNaN(t) && t < Date.now() - 86400000; };

  // Render one <td data-col> for a lead + column key. Used by both the list
  // (visible subset) and consistent across the app.
  function leadCellFor(l, key) {
    switch (key) {
      case 'title': {
        var loc = [l.city, l.state].filter(Boolean).join(', ');
        var suffix = loc ? '<span style="font-size:11px;color:var(--text-dim,#888);font-weight:normal;margin-left:6px;">' + escapeHTML(loc) + '</span>' : '';
        return '<td data-col="title" class="lead-title-cell" title="' + escapeAttr(l.title) + (loc ? ' · ' + loc : '') + '"><strong>' + escapeHTML(l.title || '') + '</strong>' + suffix + '</td>';
      }
      case 'client': return '<td data-col="client">' + (l.client_name ? escapeHTML(l.client_name) : '<span style="color:var(--text-dim,#666);font-style:italic;">no client</span>') + '</td>';
      case 'status': return '<td data-col="status"><span class="badge lead-' + (l.status || 'new') + '">' + escapeHTML(statusMeta(l.status).label) + '</span></td>';
      case 'confidence': { var c = (l.confidence != null && l.confidence > 0) ? Number(l.confidence) : 0; var col = c >= 75 ? '#34d399' : c >= 50 ? '#fbbf24' : 'var(--text-dim,#aaa)'; return '<td data-col="confidence" class="num" style="text-align:right;">' + (c > 0 ? '<span style="color:' + col + ';font-weight:600;">' + c + '%</span>' : '') + '</td>'; }
      case 'revenue': { var r = revenueFromAttachedEstimates(l.id); return '<td data-col="revenue" class="num" style="color:#34d399;font-weight:600;">' + escapeHTML(r != null ? fmtCurrencyFull(r) : '') + '</td>'; }
      case 'est_rev_low': return '<td data-col="est_rev_low" class="num">' + escapeHTML(l.estimated_revenue_low != null ? fmtCurrencyFull(l.estimated_revenue_low) : '') + '</td>';
      case 'est_rev_high': return '<td data-col="est_rev_high" class="num">' + escapeHTML(l.estimated_revenue_high != null ? fmtCurrencyFull(l.estimated_revenue_high) : '') + '</td>';
      case 'salesperson': return '<td data-col="salesperson">' + escapeHTML(l.salesperson_name || '') + '</td>';
      case 'source': return '<td data-col="source">' + escapeHTML(l.source || '') + '</td>';
      case 'project_type': return '<td data-col="project_type">' + escapeHTML(l.project_type || '') + '</td>';
      case 'market': return '<td data-col="market">' + escapeHTML(l.market || '') + '</td>';
      case 'property_name': return '<td data-col="property_name">' + escapeHTML(l.property_name || '') + '</td>';
      case 'street_address': return '<td data-col="street_address">' + escapeHTML(l.street_address || '') + '</td>';
      case 'city': return '<td data-col="city">' + escapeHTML(l.city || '') + '</td>';
      case 'state': return '<td data-col="state">' + escapeHTML(l.state || '') + '</td>';
      case 'zip': return '<td data-col="zip">' + escapeHTML(l.zip || '') + '</td>';
      case 'gate_code': return '<td data-col="gate_code">' + escapeHTML(l.gate_code || '') + '</td>';
      case 'projected_sale_date': { var od = _overdueDate(l.projected_sale_date, !_isTerminalLead(l)); return '<td data-col="projected_sale_date"' + (od ? ' style="color:#f87171;"' : '') + '>' + escapeHTML(l.projected_sale_date ? fmtDate(l.projected_sale_date) : '') + '</td>'; }
      case 'next_followup_at': { var od2 = _overdueDate(l.next_followup_at, !_isTerminalLead(l)); return '<td data-col="next_followup_at"' + (od2 ? ' style="color:#f87171;font-weight:600;"' : '') + '>' + escapeHTML(l.next_followup_at ? fmtDate(l.next_followup_at) : '') + '</td>'; }
      case 'status_changed_at': { var sd = ''; if (l.status_changed_at) { var sc = new Date(l.status_changed_at).getTime(); if (!isNaN(sc)) sd = Math.max(0, Math.floor((Date.now() - sc) / 86400000)) + 'd'; } return '<td data-col="status_changed_at" class="num" title="Days in the current stage">' + escapeHTML(sd) + '</td>'; }
      case 'converted_at': return '<td data-col="converted_at">' + escapeHTML(l.converted_at ? fmtDate(l.converted_at) : '') + '</td>';
      case 'lost_at': return '<td data-col="lost_at">' + escapeHTML(l.lost_at ? fmtDate(l.lost_at) : '') + '</td>';
      case 'lost_reason': return '<td data-col="lost_reason">' + escapeHTML(l.lost_reason || '') + '</td>';
      case 'notes': return '<td data-col="notes" title="' + escapeAttr(l.notes || '') + '">' + escapeHTML((l.notes || '').slice(0, 60)) + '</td>';
      case 'created_at': return '<td data-col="created_at">' + escapeHTML(l.created_at ? fmtDate(l.created_at) : '') + '</td>';
      case 'updated_at': return '<td data-col="updated_at" title="created ' + escapeAttr(fmtDate(l.created_at)) + '">' + escapeHTML(fmtDate(l.updated_at || l.created_at)) + '</td>';
      case 'id': return '<td data-col="id" style="font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(l.id || '') + '</td>';
      default: return '<td data-col="' + escapeAttr(key) + '">' + escapeHTML(l[key] != null ? String(l[key]) : '') + '</td>';
    }
  }

  function leadRowHTML(l) {
    // Status: use the global .badge + per-status color class instead of
    // an inline-styled span. Shape inherits from the .badge rule in
    // styles.css — same character as the Jobs list, with lead-specific
    // colors for the 6-stage pipeline.
    var selCell = canBulkEditLeads()
      ? '<td class="lead-check-cell" style="width:34px;text-align:center;" onclick="event.stopPropagation();">' +
          '<input type="checkbox" class="lead-check" data-id="' + escapeAttr(l.id) + '"' + (_leadsSelected.has(l.id) ? ' checked' : '') +
          ' onclick="event.stopPropagation();window.p86LeadsSelect(\'' + escapeAttr(l.id) + '\',this.checked);"></td>'
      : '';
    return '<tr class="leads-row" onclick="openEditLeadModal(\'' + escapeAttr(l.id) + '\')">' +
      selCell +
      leadVisibleCols().map(function (c) { return leadCellFor(l, c.key); }).join('') +
    '</tr>';
  }

  // Stable sort by the configured column. Strings use locale compare,
  // numbers/dates fall back to numeric. Status sorts by pipeline order
  // (new → in_progress → sent → sold/lost/no_opportunity) instead of
  // alphabetically — way more useful for a sales view.
  function compareLeads(a, b, key, dir) {
    var av, bv;
    if (key === 'status') {
      var order = STATUSES.map(function(s) { return s.key; });
      av = order.indexOf(a.status); bv = order.indexOf(b.status);
    } else if (key === 'revenue') {
      // Sort by the same value the column displays — the highest
      // clientPrice across attached estimates. Leads with no
      // estimate attached sort as 0 (i.e., to the bottom on desc).
      av = Number(revenueFromAttachedEstimates(a.id) || 0);
      bv = Number(revenueFromAttachedEstimates(b.id) || 0);
    } else if (key === 'confidence') {
      av = Number(a.confidence || 0); bv = Number(b.confidence || 0);
    } else if (key === 'created_at' || key === 'updated_at') {
      av = a[key] ? new Date(a[key]).getTime() : 0;
      bv = b[key] ? new Date(b[key]).getTime() : 0;
    } else if (key === 'projected_sale_date') {
      // Dates with no value sort as "very far future" when ascending so
      // the unscheduled leads land at the end of the pipeline view.
      av = a.projected_sale_date ? new Date(a.projected_sale_date).getTime() : Infinity;
      bv = b.projected_sale_date ? new Date(b.projected_sale_date).getTime() : Infinity;
    } else if (key === 'next_followup_at') {
      // No follow-up scheduled sorts last on ascending (soonest-first).
      av = a.next_followup_at ? new Date(a.next_followup_at).getTime() : Infinity;
      bv = b.next_followup_at ? new Date(b.next_followup_at).getTime() : Infinity;
    } else if (key === 'status_changed_at') {
      // Oldest status change first on ascending = longest time-in-stage.
      av = a.status_changed_at ? new Date(a.status_changed_at).getTime() : Infinity;
      bv = b.status_changed_at ? new Date(b.status_changed_at).getTime() : Infinity;
    } else if (key === 'client') {
      av = (a.client_name || '').toLowerCase(); bv = (b.client_name || '').toLowerCase();
    } else if (key === 'salesperson') {
      av = (a.salesperson_name || '').toLowerCase(); bv = (b.salesperson_name || '').toLowerCase();
    } else if (key === 'project_type') {
      av = (a.project_type || '').toLowerCase(); bv = (b.project_type || '').toLowerCase();
    } else if (key === 'source') {
      av = (a.source || '').toLowerCase(); bv = (b.source || '').toLowerCase();
    } else if (key === 'est_rev_low' || key === 'est_rev_high') {
      av = Number(a[key] || 0); bv = Number(b[key] || 0);
    } else {
      // Generic: string (or ISO-date string, which sorts chronologically) on l[key].
      av = String(a[key] != null ? a[key] : '').toLowerCase();
      bv = String(b[key] != null ? b[key] : '').toLowerCase();
    }
    if (av < bv) return dir === 'desc' ? 1 : -1;
    if (av > bv) return dir === 'desc' ? -1 : 1;
    return 0;
  }

  function sortLeads(key) {
    if (_leadsSort.key === key) {
      _leadsSort.dir = _leadsSort.dir === 'asc' ? 'desc' : 'asc';
    } else {
      _leadsSort.key = key;
      // Default direction: dates and numerics descend (newest/biggest
      // first); text columns ascend. Projected-sale-date is the
      // exception — ascending puts the next-up sales first.
      var descKeys = ['created_at', 'updated_at', 'revenue', 'confidence'];
      _leadsSort.dir = descKeys.indexOf(key) !== -1 ? 'desc' : 'asc';
    }
    renderLeadsList();
  }

  // Mirrors the Jobs-list header pattern: a sortable th picks up its
  // chevron + accent color from the global `th.sortable.sort-asc/desc`
  // CSS rules (see styles.css ~line 2119). No inline color/arrow here.
  function leadsHeaderCell(label, key, opts) {
    opts = opts || {};
    var active = _leadsSort.key === key;
    var classes = 'sortable';
    if (active) classes += (_leadsSort.dir === 'asc' ? ' sort-asc' : ' sort-desc');
    if (opts.num) classes += ' num';
    var alignAttr = opts.num ? ' style="text-align:right;"' : '';
    return '<th class="' + classes + '" data-col="' + key + '" data-sort="' + key + '"' + alignAttr +
      ' onclick="sortLeadsBy(\'' + key + '\')">' + label + '</th>';
  }

  function matchesSearch(l, q) {
    if (!q) return true;
    q = q.toLowerCase();
    var hay = [
      l.title, l.client_name, l.client_company,
      l.salesperson_name, l.source, l.project_type,
      l.property_name, l.market, l.city, l.state,
      l.notes
    ].filter(Boolean).join(' ').toLowerCase();
    return hay.indexOf(q) !== -1;
  }

  // ── Filter drawer + saved views ────────────────────────────────────
  function leadsDistinct(field) {
    var seen = {}, out = [];
    _leads.forEach(function(l) { var v = l[field]; if (v == null || v === '') return; v = String(v); if (seen[v]) return; seen[v] = true; out.push(v); });
    out.sort(function(a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return out;
  }
  function leadsFilterFields() {
    var pms = (window.p86Admin && window.p86Admin.getActivePMs && window.p86Admin.getActivePMs()) || [];
    var spOpts = [{ v: '', label: 'Anyone' }].concat(pms.map(function(u) { return { v: String(u.id), label: u.name }; }));
    var srcOpts = leadsDistinct('source').map(function(s) { return { v: s, label: s }; });
    var mktOpts = leadsDistinct('market').map(function(s) { return { v: s, label: s }; });
    return [
      { key: 'status', label: 'Status', type: 'chips', options: STATUSES.map(function(s) { return { v: s.key, label: s.label }; }) },
      { key: 'salesperson_id', label: 'Salesperson', type: 'select', options: spOpts },
      { key: 'source', label: 'Source', type: 'select', options: [{ v: '', label: 'Any' }].concat(srcOpts) },
      { key: 'project_type', label: 'Project Type', type: 'chips', options: [{ v: 'Renovation', label: 'Renovation' }, { v: 'Service & Repair', label: 'Service & Repair' }, { v: 'Work Order', label: 'Work Order' }] },
      { key: 'market', label: 'Market', type: 'select', options: [{ v: '', label: 'Any' }].concat(mktOpts) },
      { key: 'lost_reason', label: 'Lost Reason', type: 'chips', options: [{ v: 'budget', label: 'Budget' }, { v: 'timeline', label: 'Timeline' }, { v: 'competitor', label: 'Competitor' }, { v: 'no_response', label: 'No response' }, { v: 'not_qualified', label: 'Not qualified' }, { v: 'scope', label: 'Scope' }, { v: 'other', label: 'Other' }] },
      { key: 'confidence', label: 'Confidence %', type: 'numrange' },
      { key: 'revenue', label: 'Est. Revenue', type: 'numrange' },
      { key: 'projected_sale_date', label: 'Projected Sale', type: 'daterange' },
      { key: 'next_followup_at', label: 'Next Follow-up', type: 'daterange' },
      { key: 'created_at', label: 'Created', type: 'daterange' }
    ];
  }
  function leadDateInRange(val, range) {
    if (!range || (!range.from && !range.to)) return true;
    if (!val) return false;
    var d = String(val).slice(0, 10);
    if (range.from && d < range.from) return false;
    if (range.to && d > range.to) return false;
    return true;
  }
  function matchesLeadDrawer(l, d) {
    if (!d) return true;
    var FD = window.p86FilterDrawer; if (!FD) return true;
    if (d.status && d.status.length && d.status.indexOf(l.status) < 0) return false;
    if (d.salesperson_id && String(l.salesperson_id) !== String(d.salesperson_id)) return false;
    if (d.source && String(l.source || '') !== String(d.source)) return false;
    if (d.project_type && d.project_type.length && d.project_type.indexOf(l.project_type) < 0) return false;
    if (d.market && String(l.market || '') !== String(d.market)) return false;
    if (d.lost_reason && d.lost_reason.length && d.lost_reason.indexOf(l.lost_reason) < 0) return false;
    var cr = FD.resolveNumRange(d.confidence);
    if (cr.min != null || cr.max != null) { var c = Number(l.confidence || 0); if (cr.min != null && c < cr.min) return false; if (cr.max != null && c > cr.max) return false; }
    var rr = FD.resolveNumRange(d.revenue);
    if (rr.min != null || rr.max != null) { var rev = Number(revenueFromAttachedEstimates(l.id) || l.estimated_revenue_low || 0); if (rr.min != null && rev < rr.min) return false; if (rr.max != null && rev > rr.max) return false; }
    if (!leadDateInRange(l.projected_sale_date, FD.resolveDateRange(d.projected_sale_date))) return false;
    if (!leadDateInRange(l.next_followup_at, FD.resolveDateRange(d.next_followup_at))) return false;
    if (!leadDateInRange(l.created_at, FD.resolveDateRange(d.created_at))) return false;
    return true;
  }
  function updateLeadsFilterBtn() {
    var btn = document.getElementById('leads-filter-btn');
    if (!btn) return;
    var FD = window.p86FilterDrawer;
    var n = (_leadsDrawer && FD) ? FD.countActive(leadsFilterFields(), _leadsDrawer) : 0;
    btn.innerHTML = (window.p86Icon ? window.p86Icon('funnel') : 'Filter') + (n ? ' <strong>(' + n + ')</strong>' : '');
    btn.classList.toggle('pf-on', n > 0);
  }
  function updateLeadsViewsBtn() {
    var btn = document.getElementById('leads-views-btn');
    if (!btn) return;
    var v = _leadsViews.find(function(x) { return x.id === _leadsActiveViewId; });
    btn.innerHTML = (v ? escapeHTML(v.name) : 'Views') + ' ▾';
  }
  window.leadsOpenFilter = function() {
    var FD = window.p86FilterDrawer; if (!FD) return;
    var fields = leadsFilterFields();
    FD.open({
      title: 'Filter Leads', fields: fields,
      values: _leadsDrawer || FD.emptyValues(fields),
      onApply: function(v) { _leadsDrawer = v; _leadsActiveViewId = null; updateLeadsFilterBtn(); updateLeadsViewsBtn(); renderLeadsList(); },
      onClear: function() { _leadsDrawer = null; _leadsActiveViewId = null; updateLeadsFilterBtn(); updateLeadsViewsBtn(); renderLeadsList(); }
    });
  };
  function leadsLoadViews() {
    if (!(window.p86Api && window.p86Api.listViews)) return Promise.resolve();
    return window.p86Api.listViews.list('leads').then(function(r) {
      _leadsViews = (r && r.views) || [];
      var def = _leadsViews.find(function(v) { return v.is_default; });
      if (def && !_leadsDrawer && !_leadsActiveViewId) applyLeadsView(def);
      updateLeadsViewsBtn();
    }).catch(function() { _leadsViews = []; });
  }
  function applyLeadsView(v) {
    _leadsActiveViewId = v.id;
    var cfg = v.config || {};
    _leadsDrawer = (cfg.filters && Object.keys(cfg.filters).length) ? cfg.filters : null;
    _leadCols = (Array.isArray(cfg.columns) && cfg.columns.length) ? cfg.columns.slice() : null;
    persistLeadCols();
    updateLeadsFilterBtn(); updateLeadsViewsBtn(); renderLeadsList();
  }
  window.leadsOpenViews = function(anchor) {
    var existing = document.getElementById('leads-views-pop');
    if (existing) { existing.remove(); return; }
    var pop = document.createElement('div');
    pop.id = 'leads-views-pop';
    pop.style.cssText = 'position:fixed;z-index:100000;min-width:244px;background:var(--card-bg,#161a2b);border:1px solid var(--border,#333);border-radius:8px;padding:6px;box-shadow:0 8px 24px rgba(0,0,0,.45);font-size:13px;';
    var rows = _leadsViews.length ? _leadsViews.map(function(v) {
      return '<div data-view="' + escapeAttr(v.id) + '" style="display:flex;align-items:center;gap:6px;padding:4px 6px;border-radius:6px;">' +
        '<span class="lv-apply" style="flex:1;cursor:pointer;">' + escapeHTML(v.name) + (v.is_default ? ' <span style="color:var(--text-dim,#888);font-size:10px;">(default)</span>' : '') + '</span>' +
        '<a href="#" data-def="' + escapeAttr(v.id) + '" title="Set as default" style="text-decoration:none;">★</a>' +
        '<a href="#" data-del="' + escapeAttr(v.id) + '" title="Delete" style="text-decoration:none;color:#f87171;">✕</a>' +
      '</div>';
    }).join('') : '<div style="padding:6px 8px;color:var(--text-dim,#888);">No saved views yet.</div>';
    var curCols = _leadCols || LEADS_DEFAULT_COLS;
    var colsHtml = '<div style="border-top:1px solid var(--border,#333);margin-top:6px;padding-top:6px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;"><strong style="font-size:11px;text-transform:uppercase;letter-spacing:.03em;color:var(--text-dim,#888);">Columns shown</strong>' +
      '<span><a href="#" id="lc-all" style="font-size:11px;text-decoration:none;">All</a> · <a href="#" id="lc-reset" style="font-size:11px;text-decoration:none;">Reset</a></span></div>' +
      '<div style="max-height:230px;overflow:auto;display:grid;grid-template-columns:1fr 1fr;gap:1px 10px;">' +
        LEAD_COLS.map(function(c) { return '<label style="display:flex;align-items:center;gap:5px;font-size:12px;cursor:pointer;white-space:nowrap;padding:1px 0;"><input type="checkbox" class="lc-box" data-key="' + escapeAttr(c.key) + '"' + (curCols.indexOf(c.key) >= 0 ? ' checked' : '') + '>' + escapeHTML(c.label) + '</label>'; }).join('') +
      '</div></div>';
    pop.innerHTML = rows + colsHtml + '<div style="border-top:1px solid var(--border,#333);margin-top:6px;padding-top:6px;"><button type="button" class="ee-btn" id="leads-save-view" style="width:100%;">＋ Save current view (filters + columns)…</button></div>';
    document.body.appendChild(pop);
    var r = anchor.getBoundingClientRect();
    pop.style.top = (r.bottom + 4) + 'px';
    pop.style.left = Math.max(8, Math.min(r.right - 244, window.innerWidth - 252)) + 'px';
    function close() { pop.remove(); document.removeEventListener('mousedown', onOut, true); }
    function onOut(e) { if (!pop.contains(e.target) && e.target !== anchor) close(); }
    setTimeout(function() { document.addEventListener('mousedown', onOut, true); }, 0);
    pop.querySelectorAll('.lv-apply').forEach(function(sp) {
      sp.addEventListener('click', function() { var id = sp.parentNode.getAttribute('data-view'); var v = _leadsViews.find(function(x) { return x.id === id; }); if (v) { close(); applyLeadsView(v); } });
    });
    pop.querySelectorAll('[data-def]').forEach(function(a) { a.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); window.p86Api.listViews.update(a.getAttribute('data-def'), { is_default: true }).then(leadsLoadViews).then(function() { close(); if (window.p86Toast) window.p86Toast('Default view set', 'success'); }); }); });
    pop.querySelectorAll('[data-del]').forEach(function(a) { a.addEventListener('click', function(e) { e.preventDefault(); e.stopPropagation(); if (!confirm('Delete this saved view?')) return; var id = a.getAttribute('data-del'); window.p86Api.listViews.remove(id).then(function() { if (_leadsActiveViewId === id) _leadsActiveViewId = null; return leadsLoadViews(); }).then(close); }); });
    // Column chooser: toggle visible columns (never allow zero).
    pop.querySelectorAll('.lc-box').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var set = []; pop.querySelectorAll('.lc-box').forEach(function(x) { if (x.checked) set.push(x.getAttribute('data-key')); });
        if (!set.length) { cb.checked = true; return; }
        _leadCols = set; _leadsActiveViewId = null; persistLeadCols(); updateLeadsViewsBtn(); renderLeadsList();
      });
    });
    var lcAll = pop.querySelector('#lc-all');
    if (lcAll) lcAll.addEventListener('click', function(e) { e.preventDefault(); _leadCols = leadAllColKeys(); _leadsActiveViewId = null; persistLeadCols(); updateLeadsViewsBtn(); renderLeadsList(); pop.querySelectorAll('.lc-box').forEach(function(x) { x.checked = true; }); });
    var lcReset = pop.querySelector('#lc-reset');
    if (lcReset) lcReset.addEventListener('click', function(e) { e.preventDefault(); _leadCols = LEADS_DEFAULT_COLS.slice(); _leadsActiveViewId = null; persistLeadCols(); updateLeadsViewsBtn(); renderLeadsList(); pop.querySelectorAll('.lc-box').forEach(function(x) { x.checked = LEADS_DEFAULT_COLS.indexOf(x.getAttribute('data-key')) >= 0; }); });
    var sv = pop.querySelector('#leads-save-view');
    if (sv) sv.addEventListener('click', function() {
      var name = prompt('Name this view:'); if (name == null) return; name = String(name).trim(); if (!name) return;
      window.p86Api.listViews.create({ page: 'leads', name: name, config: { filters: _leadsDrawer || {}, columns: _leadCols || LEADS_DEFAULT_COLS }, is_default: false })
        .then(function(res) { _leadsActiveViewId = (res && res.view && res.view.id) || null; return leadsLoadViews(); })
        .then(function() { close(); if (window.p86Toast) window.p86Toast('View saved', 'success'); })
        .catch(function() { if (window.p86Toast) window.p86Toast('Could not save view', 'error'); });
    });
  };

  // ── Export to Excel (ALL fields, current filtered set) ──────────────
  var _leadsFiltered = [];   // last rendered filtered set (drives export)
  function leadRawVal(l, key) {
    switch (key) {
      case 'title': return l.title || '';
      case 'client': return l.client_name || '';
      case 'status': return statusMeta(l.status).label;
      case 'confidence': return l.confidence != null ? Number(l.confidence) : '';
      case 'revenue': { var r = revenueFromAttachedEstimates(l.id); return r != null ? Number(r) : ''; }
      case 'est_rev_low': return l.estimated_revenue_low != null ? Number(l.estimated_revenue_low) : '';
      case 'est_rev_high': return l.estimated_revenue_high != null ? Number(l.estimated_revenue_high) : '';
      case 'salesperson': return l.salesperson_name || '';
      case 'status_changed_at': { if (!l.status_changed_at) return ''; var sc = new Date(l.status_changed_at).getTime(); return isNaN(sc) ? '' : Math.max(0, Math.floor((Date.now() - sc) / 86400000)); }
      case 'projected_sale_date': case 'next_followup_at': case 'converted_at': case 'lost_at': case 'created_at': case 'updated_at': return l[key] ? String(l[key]).slice(0, 10) : '';
      default: return l[key] != null ? String(l[key]) : '';
    }
  }
  function ensureXLSX() {
    return new Promise(function(resolve, reject) {
      if (typeof XLSX !== 'undefined') return resolve(window.XLSX);
      var existing = document.getElementById('p86-xlsx-cdn');
      if (existing) { existing.addEventListener('load', function() { resolve(window.XLSX); }); existing.addEventListener('error', function() { reject(new Error('lib')); }); return; }
      var s = document.createElement('script');
      s.id = 'p86-xlsx-cdn';
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = function() { resolve(window.XLSX); };
      s.onerror = function() { reject(new Error('Could not load the Excel library.')); };
      document.head.appendChild(s);
    });
  }
  window.leadsExportExcel = function(rowsArg) {
    var rows = (rowsArg && rowsArg.length) ? rowsArg : ((_leadsFiltered && _leadsFiltered.length) ? _leadsFiltered : _leads);
    if (!rows.length) { if (window.p86Toast) window.p86Toast('No leads to export.', 'error'); return; }
    var btn = document.getElementById('leads-export-btn');
    if (btn) { btn.disabled = true; }
    ensureXLSX().then(function(XLSX) {
      // Export EVERY field (full BT-style record), not just the visible columns.
      var header = LEAD_COLS.map(function(c) { return c.label; });
      var aoa = [header];
      rows.forEach(function(l) { aoa.push(LEAD_COLS.map(function(c) { return leadRawVal(l, c.key); })); });
      var ws = XLSX.utils.aoa_to_sheet(aoa);
      ws['!cols'] = LEAD_COLS.map(function(c) { return { wch: c.key === 'title' || c.key === 'notes' || c.key === 'property_name' ? 30 : c.key === 'id' ? 24 : 15 }; });
      var wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Leads');
      XLSX.writeFile(wb, 'Leads_' + new Date().toISOString().slice(0, 10) + '.xlsx');
      if (btn) btn.disabled = false;
      if (window.p86Toast) window.p86Toast('Exported ' + rows.length + ' lead' + (rows.length === 1 ? '' : 's') + '.', 'success');
    }).catch(function(e) {
      if (btn) btn.disabled = false;
      if (window.p86Toast) window.p86Toast('Export failed: ' + (e && e.message || 'error'), 'error');
    });
  };

  function renderLeadsList() {
    var listEl = document.getElementById('leads-list');
    var summaryEl = document.getElementById('leads-summary');
    if (!listEl) return;
    if (!_leadsViewsLoaded) { _leadsViewsLoaded = true; restoreLeadCols(); leadsLoadViews(); }
    updateLeadsFilterBtn(); updateLeadsViewsBtn();
    var statusFilter = document.getElementById('leads-filter-status');
    var searchEl = document.getElementById('leads-search');
    var filterStatus = statusFilter ? statusFilter.value : '';
    var q = searchEl ? searchEl.value.trim() : '';

    if (!_leads.length) {
      // Already fetched and the org genuinely has zero leads (e.g. right
      // after a clean-slate reset) — render a real empty state. Refetching
      // here would loop forever: the empty response leaves _leads.length 0,
      // re-entering this branch. reloadLeadsCache() clears _leadsLoaded so a
      // manual refresh still re-fetches.
      if (_leadsLoaded) {
        listEl.innerHTML = '<div style="padding:32px 20px;color:var(--text-dim,#888);text-align:center;">No leads yet. Create a lead to get started.</div>';
        if (summaryEl) summaryEl.textContent = '0 leads';
        _leadsFiltered = [];
        return;
      }
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading leads…</div>';
      if (!window.p86Api || !window.p86Api.isAuthenticated()) {
        listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Leads aren\'t available in offline mode.</div>';
        return;
      }
      // A list fetch is already running (e.g. a map-card open joined it) —
      // wait for its .then to re-render rather than stacking another GET.
      if (_leadsFetchInflight) return;
      var p = window.p86Api.leads.list().then(function(res) {
        if (_leadsFetchInflight === p) _leadsFetchInflight = null;
        _leadsLoaded = true;
        _leads = res.leads || [];
        renderLeadsList();
      }).catch(function(err) {
        if (_leadsFetchInflight === p) _leadsFetchInflight = null;
        listEl.innerHTML = '<div style="padding:20px;color:#e74c3c;text-align:center;">Failed to load leads: ' + escapeHTML(err.message) + '</div>';
      });
      _leadsFetchInflight = p;
      return;
    }

    var filtered = _leads.filter(function(l) {
      if (filterStatus && l.status !== filterStatus) return false;
      if (_leadsDrawer && !matchesLeadDrawer(l, _leadsDrawer)) return false;
      return matchesSearch(l, q);
    });
    _leadsFiltered = filtered;   // drives Export to Excel
    if (summaryEl) {
      var byStatus = {};
      _leads.forEach(function(l) { byStatus[l.status] = (byStatus[l.status] || 0) + 1; });
      var counts = STATUSES
        .filter(function(s) { return byStatus[s.key]; })
        .map(function(s) { return byStatus[s.key] + ' ' + s.label.toLowerCase(); })
        .join(' · ');
      var prefix = (filterStatus || q)
        ? 'Showing ' + filtered.length + ' of ' + _leads.length + ' leads'
        : _leads.length + ' leads';
      summaryEl.textContent = counts ? prefix + ' (' + counts + ')' : prefix;
    }

    // Activities view — pipeline kanban board (drag a card to change a
    // lead's stage) with each card surfacing its open follow-up tasks.
    // Search applies; the status filter does NOT (the board shows every
    // stage as its own column). See renderLeadsActivities().
    if (_leadsView === 'activities') {
      renderLeadsActivities(listEl, _leads.filter(function(l) { return matchesSearch(l, q); }));
      return;
    }

    // Map view — same split list+map pane the Projects page uses, fed by
    // the filtered leads (status filter + search still apply). Pins come
    // from geocode_lat/lng (populated server-side from the address fields).
    if (_leadsView === 'map') {
      listEl.innerHTML = '<div id="p86LeadsMapHost" class="p86-projects-map-host"></div>';
      var mapHost = document.getElementById('p86LeadsMapHost');
      if (mapHost && window.p86ProjectsMap && typeof window.p86ProjectsMap.render === 'function') {
        window.p86ProjectsMap.render(mapHost, filtered, {
          entityLabel: 'leads',
          showThumb: false,
          getName: function(l) { return l.title || 'Untitled lead'; },
          getAddress: function(l) {
            return [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', ');
          },
          getMeta: function(l) {
            return statusMeta(l.status).label + (l.client_name ? ' · ' + l.client_name : '');
          },
          onPin: function(id) {
            if (typeof window.openEditLeadModal === 'function') window.openEditLeadModal(id);
          }
        });
      } else if (mapHost) {
        mapHost.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Map module not loaded.</div>';
      }
      return;
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">' +
        ((filterStatus || q) ? 'No leads match.' : 'No leads yet. Click + New Lead to start tracking opportunities.') +
        '</div>';
      return;
    }

    var sorted = filtered.slice().sort(function(a, b) {
      return compareLeads(a, b, _leadsSort.key, _leadsSort.dir);
    });

    var headerRow =
      (canBulkEditLeads()
        ? '<th class="lead-check-cell" style="width:34px;text-align:center;"><input type="checkbox" id="leads-check-all" title="Select all shown" onclick="window.p86LeadsSelectAll(this.checked)"></th>'
        : '') +
      leadVisibleCols().map(function (c) { return leadsHeaderCell(c.label, c.key, { num: c.num }); }).join('');

    // Outer wrapper drops the heavy inline border / bg / radius — the
    // global `.leads-table` + `table` + `th` rules already carry the
    // Jobs-list look. `.p86-tbl-scroll` is the standard container the
    // p86Tables enhancement module hangs its bounded-scroll logic on.
    listEl.innerHTML =
      '<div id="leads-bulkbar" style="display:none;"></div>' +
      '<div class="p86-tbl-scroll">' +
        '<table id="leads-table" class="leads-table">' +
          '<thead><tr>' + headerRow + '</tr></thead>' +
          '<tbody>' + sorted.map(leadRowHTML).join('') + '</tbody>' +
        '</table>' +
      '</div>';

    // Reorderable / resizable / freezable columns + internal scroll.
    if (window.p86Tables) window.p86Tables.enhance('leads');
    updateLeadsBulkBar();
    syncLeadsSelectAll();
  }

  // ── Bulk delete ───────────────────────────────────────────────────
  // Multi-select purge for the leads list (backs the "replace all leads"
  // workflow). Selection is by id in _leadsSelected and survives re-render;
  // the bar updates in place (no table rebuild) as boxes are ticked.
  function updateLeadsBulkBar() {
    var bar = document.getElementById('leads-bulkbar');
    if (!bar || !window.p86BulkRibbon) return;
    var n = _leadsSelected.size;
    if (!n) { window.p86BulkRibbon.hide(bar); return; }
    var pms = (window.p86Admin && window.p86Admin.getActivePMs && window.p86Admin.getActivePMs()) || [];
    var lostReasons = [['budget', 'Budget'], ['timeline', 'Timeline'], ['competitor', 'Competitor'], ['no_response', 'No response'], ['not_qualified', 'Not qualified'], ['scope', 'Scope'], ['other', 'Other']];
    window.p86BulkRibbon.render(bar, {
      count: n,
      onClear: function() { window.p86LeadsClearSelection(); },
      actions: [
        { icon: 'exports', title: 'Export selected to Excel', onClick: function() { window.p86LeadsExportSelected(); } },
        { icon: 'bookmark', title: 'Set status', menu: STATUSES.map(function(s) { return { label: s.label, onClick: function() { window.p86LeadsBulkStatus(s.key); } }; }) },
        { icon: 'users', title: 'Assign to', menu: [{ label: '— Unassign —', onClick: function() { window.p86LeadsBulkAssign('__none__'); } }].concat(pms.map(function(u) { return { label: u.name, onClick: function() { window.p86LeadsBulkAssign(String(u.id)); } }; })) },
        { icon: 'schedule', title: 'Set follow-up date', date: true, onPick: function(d) { window.p86LeadsBulkFollowup(d); } },
        { icon: 'x-circle', title: 'Mark lost', menu: lostReasons.map(function(r) { return { label: r[1], onClick: function() { window.p86LeadsBulkLost(r[0]); } }; }) },
        { icon: 'delete', title: 'Delete ' + n, danger: true, onClick: function() { window.p86LeadsDeleteSelected(); } }
      ]
    });
  }

  // In-app confirm — native confirm() silently returns false inside an
  // installed (standalone) PWA, so bulk actions gated on it would no-op there.
  // p86Confirm is a DOM overlay that works everywhere.
  function bulkConfirm(opts) {
    return (typeof window.p86Confirm === 'function')
      ? window.p86Confirm(opts)
      : Promise.resolve(window.confirm(opts.message || 'Are you sure?'));
  }
  // Apply a field update to every selected lead (server auto-stamps status
  // transitions). Reloads the list after. Used by the bulk-action bar.
  function leadsBulkApply(body, label) {
    var ids = Array.from(_leadsSelected);
    if (!ids.length) return;
    if (!(window.p86Api && window.p86Api.leads && window.p86Api.leads.update)) { if (window.p86Toast) window.p86Toast('Bulk edit is not available (refresh the app).', 'error'); return; }
    var proms = ids.map(function(id) { return window.p86Api.leads.update(id, body).then(function() { return true; }).catch(function() { return false; }); });
    Promise.all(proms).then(function(res) {
      var ok = res.filter(Boolean).length, fail = res.length - ok;
      if (window.p86Toast) window.p86Toast(label + ': ' + ok + ' updated' + (fail ? (', ' + fail + ' failed') : '') + '.', fail ? 'error' : 'success');
      _leadsSelected.clear();
      reloadLeadsCache();
    });
  }
  window.p86LeadsBulkStatus = function(v) { if (!v) return; var term = ['sold', 'lost', 'no_opportunity'].indexOf(v) >= 0; if (!term) { leadsBulkApply({ status: v }, 'Status updated'); return; } bulkConfirm({ title: 'Set status', message: 'Set ' + _leadsSelected.size + ' lead(s) to "' + v + '"?', confirmLabel: 'Set status' }).then(function(ok) { if (!ok) return; leadsBulkApply({ status: v }, 'Status updated'); }); };
  window.p86LeadsBulkAssign = function(v) { if (v === '') return; leadsBulkApply({ salesperson_id: v === '__none__' ? null : v }, 'Reassigned'); };
  window.p86LeadsBulkFollowup = function(d) { if (!d) return; leadsBulkApply({ next_followup_at: d }, 'Follow-up set'); };
  window.p86LeadsBulkLost = function(reason) { if (!reason) return; bulkConfirm({ title: 'Mark lost', message: 'Mark ' + _leadsSelected.size + ' lead(s) as Lost?', confirmLabel: 'Mark lost', danger: true }).then(function(ok) { if (!ok) return; leadsBulkApply({ status: 'lost', lost_reason: reason }, 'Marked lost'); }); };
  window.p86LeadsExportSelected = function() { var sel = _leads.filter(function(l) { return _leadsSelected.has(l.id); }); if (!sel.length) { if (window.p86Toast) window.p86Toast('Nothing selected.', 'error'); return; } window.leadsExportExcel(sel); };

  function syncLeadsSelectAll() {
    var all = document.getElementById('leads-check-all');
    if (!all) return;
    var boxes = document.querySelectorAll('#leads-table .lead-check');
    var checked = 0;
    boxes.forEach(function (b) { if (b.checked) checked++; });
    all.checked = boxes.length > 0 && checked === boxes.length;
    all.indeterminate = checked > 0 && checked < boxes.length;
  }

  function p86LeadsSelect(id, checked) {
    if (checked) _leadsSelected.add(id); else _leadsSelected.delete(id);
    updateLeadsBulkBar();
    syncLeadsSelectAll();
  }
  function p86LeadsSelectAll(checked) {
    document.querySelectorAll('#leads-table .lead-check').forEach(function (b) {
      b.checked = checked;
      var id = b.getAttribute('data-id');
      if (checked) _leadsSelected.add(id); else _leadsSelected.delete(id);
    });
    updateLeadsBulkBar();
  }
  function p86LeadsClearSelection() {
    _leadsSelected.clear();
    document.querySelectorAll('#leads-table .lead-check').forEach(function (b) { b.checked = false; });
    syncLeadsSelectAll();
    updateLeadsBulkBar();
  }
  function p86LeadsDeleteSelected() {
    var ids = Array.from(_leadsSelected);
    if (!ids.length) return;
    if (!window.p86Api || !window.p86Api.leads || !window.p86Api.leads.bulkDelete) { if (window.p86Toast) window.p86Toast('Bulk delete is not available (refresh the app).', 'error'); return; }
    bulkConfirm({
      title: 'Delete leads',
      message: 'Delete ' + ids.length + ' lead' + (ids.length > 1 ? 's' : '') + '? This cannot be undone. Linked estimates will be orphaned; converted jobs are NOT deleted.',
      confirmLabel: 'Delete',
      danger: true
    }).then(function(ok) {
      if (!ok) return;
      window.p86Api.leads.bulkDelete(ids).then(function (res) {
        _leadsSelected.clear();
        var n = (res && typeof res.deleted === 'number') ? res.deleted : ids.length;
        if (typeof window.p86Toast === 'function') { try { window.p86Toast('Deleted ' + n + ' lead' + (n === 1 ? '' : 's') + '.'); } catch (e) {} }
        reloadLeadsCache();
      }).catch(function (err) {
        if (window.p86Toast) window.p86Toast('Bulk delete failed: ' + ((err && err.message) || 'unknown error'), 'error');
      });
    });
  }
  window.p86LeadsSelect = p86LeadsSelect;
  window.p86LeadsSelectAll = p86LeadsSelectAll;
  window.p86LeadsClearSelection = p86LeadsClearSelection;
  window.p86LeadsDeleteSelected = p86LeadsDeleteSelected;

  // Capabilities load ASYNC (/api/roles) — on a slow network the list can render
  // BEFORE they land, so canBulkEditLeads() reads false and the bulk-select column
  // is missing; a later manual Refresh then popped it in against a layout captured
  // without it ("checkboxes come back in incorrectly"). When caps settle
  // (p86:caps-ready from auth.js), re-render IF the mounted table's column state
  // disagrees with the now-known capability.
  window.addEventListener('p86:caps-ready', function () {
    try {
      var table = document.getElementById('leads-table');
      if (!table) return; // leads list not on screen — next render is correct anyway
      var hasCheckCol = !!table.querySelector('thead th.lead-check-cell');
      if (hasCheckCol !== canBulkEditLeads()) renderLeadsList();
    } catch (e) { /* never break on a visibility refresh */ }
  });

  // ── Activities: pipeline board + follow-ups ───────────────────────
  // Open follow-up tasks linked to leads (entity_type='lead'), fetched
  // once and cached. Each board card surfaces its lead's open tasks.
  var _leadTasks = [];
  var _leadTasksLoaded = false;
  var _lastLeadCardDragEnd = 0;

  function loadLeadTasks(cb) {
    if (!window.p86Api || !window.p86Api.tasks || !window.p86Api.isAuthenticated()) {
      _leadTasksLoaded = true; cb && cb(); return;
    }
    window.p86Api.tasks.list({ entity_type: 'lead', exclude_done: 1, limit: 200 })
      .then(function(res) {
        _leadTasks = (res && res.tasks) || (Array.isArray(res) ? res : []);
        _leadTasksLoaded = true; cb && cb();
      })
      .catch(function() { _leadTasksLoaded = true; cb && cb(); });
  }
  function tasksForLead(leadId) {
    return _leadTasks.filter(function(t) { return String(t.entity_id) === String(leadId); });
  }
  function currentLeadSearch() {
    var s = document.getElementById('leads-search');
    return s ? s.value.trim() : '';
  }
  function reRenderActivities() {
    if (_leadsView !== 'activities') return;
    var host = document.getElementById('leads-list');
    if (host) renderLeadsActivities(host, _leads.filter(function(l) { return matchesSearch(l, currentLeadSearch()); }));
  }

  function leadCardHTML(l) {
    var rev = revenueFromAttachedEstimates(l.id);
    var revStr = rev != null ? fmtCurrencyShort(rev) : '';
    var loc = [l.city, l.state].filter(Boolean).join(', ');
    var proj = l.projected_sale_date ? fmtDate(l.projected_sale_date) : '';
    var tks = tasksForLead(l.id);
    var fuHTML = '';
    if (tks.length) {
      fuHTML = '<div class="lead-card-fu">' + tks.slice(0, 3).map(function(t) {
        var due = t.due_date ? fmtDate(t.due_date) : '';
        var overdue = t.due_date && new Date(t.due_date).getTime() < (Date.now() - 86400000);
        return '<div class="lead-card-fu-item' + (overdue ? ' overdue' : '') + '">' +
          '<span class="lead-card-fu-dot"></span>' +
          '<span class="lead-card-fu-txt">' + escapeHTML(t.title || 'Follow-up') + '</span>' +
          (due ? '<span class="lead-card-fu-due">' + escapeHTML(due) + '</span>' : '') +
        '</div>';
      }).join('') +
      (tks.length > 3 ? '<div class="lead-card-fu-more">+' + (tks.length - 3) + ' more</div>' : '') +
      '</div>';
    }
    return '<div class="lead-card" draggable="true" data-lead-id="' + escapeAttr(l.id) + '">' +
      '<div class="lead-card-title">' + escapeHTML(l.title || 'Untitled lead') + '</div>' +
      (l.client_name ? '<div class="lead-card-client">' + escapeHTML(l.client_name) + '</div>' : '') +
      '<div class="lead-card-meta">' +
        (revStr ? '<span class="lead-card-rev">' + escapeHTML(revStr) + '</span>' : '') +
        (proj ? '<span class="lead-card-proj">📅 ' + escapeHTML(proj) + '</span>' : '') +
        (loc ? '<span class="lead-card-loc">' + escapeHTML(loc) + '</span>' : '') +
      '</div>' +
      fuHTML +
    '</div>';
  }

  function renderLeadsActivities(host, leads) {
    if (!host) return;
    // Lazy-load follow-ups once, then re-render with them in place.
    if (!_leadTasksLoaded) {
      host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading pipeline…</div>';
      loadLeadTasks(function() { if (_leadsView === 'activities') renderLeadsActivities(host, leads); });
      return;
    }
    var openFollowups = _leadTasks.length;
    var colsHTML = STATUSES.map(function(s) {
      var inStage = leads.filter(function(l) { return (l.status || 'new') === s.key; });
      var cards = inStage.length
        ? inStage.map(leadCardHTML).join('')
        : '<div class="lead-board-empty">No leads</div>';
      return '<div class="lead-board-col" data-stage="' + s.key + '">' +
          '<div class="lead-board-col-head" style="border-top-color:' + s.color + ';">' +
            '<span class="lead-board-col-title">' + escapeHTML(s.label) + '</span>' +
            '<span class="lead-board-col-count">' + inStage.length + '</span>' +
          '</div>' +
          '<div class="lead-board-col-body" data-stage="' + s.key + '">' + cards + '</div>' +
        '</div>';
    }).join('');
    host.innerHTML =
      '<div class="lead-board-meta">' + leads.length + ' lead' + (leads.length === 1 ? '' : 's') +
        ' · ' + openFollowups + ' open follow-up' + (openFollowups === 1 ? '' : 's') +
        ' <span class="lead-board-hint">— drag a card to change its stage</span></div>' +
      '<div class="lead-board">' + colsHTML + '</div>';
    wireLeadBoardDnD(host);
  }

  function wireLeadBoardDnD(host) {
    var dragId = null;
    host.querySelectorAll('.lead-card').forEach(function(card) {
      card.addEventListener('dragstart', function(e) {
        dragId = card.getAttribute('data-lead-id');
        card.classList.add('dragging');
        try { e.dataTransfer.setData('text/plain', dragId); e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
      });
      card.addEventListener('dragend', function() {
        card.classList.remove('dragging');
        _lastLeadCardDragEnd = Date.now();
        dragId = null;
        host.querySelectorAll('.lead-board-col-body.drop-hover').forEach(function(b) { b.classList.remove('drop-hover'); });
      });
      // Click opens the lead — but suppress the click that fires right
      // after a drag (some browsers emit one).
      card.addEventListener('click', function() {
        if (Date.now() - _lastLeadCardDragEnd < 250) return;
        var id = card.getAttribute('data-lead-id');
        if (id && typeof window.openEditLeadModal === 'function') window.openEditLeadModal(id);
      });
    });
    host.querySelectorAll('.lead-board-col-body').forEach(function(body) {
      body.addEventListener('dragover', function(e) { e.preventDefault(); try { e.dataTransfer.dropEffect = 'move'; } catch (_) {} body.classList.add('drop-hover'); });
      body.addEventListener('dragleave', function() { body.classList.remove('drop-hover'); });
      body.addEventListener('drop', function(e) {
        e.preventDefault();
        body.classList.remove('drop-hover');
        var id = dragId || (e.dataTransfer && e.dataTransfer.getData('text/plain'));
        var stage = body.getAttribute('data-stage');
        if (id && stage) updateLeadStatus(id, stage);
      });
    });
  }

  function updateLeadStatus(leadId, newStatus) {
    var lead = _leads.find(function(l) { return String(l.id) === String(leadId); });
    if (!lead || (lead.status || 'new') === newStatus) return;
    var prev = lead.status;
    lead.status = newStatus;        // optimistic paint
    reRenderActivities();
    if (!window.p86Api || !window.p86Api.leads) return;
    window.p86Api.leads.update(leadId, { status: newStatus }).catch(function() {
      lead.status = prev;           // revert on failure
      reRenderActivities();
      alert('Could not update the lead stage. Please try again.');
    });
  }

  function reloadLeadsCache() {
    _leads = [];
    _leadsLoaded = false;   // force a re-fetch (not the loaded-but-empty state)
    _leadTasks = [];
    _leadTasksLoaded = false;
    renderLeadsList();
  }

  // ──────────────────────────────────────────────────────────────────
  // Editor modal
  // ──────────────────────────────────────────────────────────────────

  var EDITABLE_FIELDS = [
    'client_id', 'title',
    'street_address', 'city', 'state', 'zip',
    'status', 'confidence', 'projected_sale_date',
    'estimated_revenue_low', 'estimated_revenue_high',
    'source', 'project_type',
    'salesperson_id',
    'property_name', 'gate_code', 'market',
    'next_followup_at', 'lost_reason',
    'notes'
  ];

  function setField(name, value) {
    var el = document.getElementById('leadEditor_' + (name === 'title' ? 'title_field' : name));
    if (!el) return;
    el.value = (value == null ? '' : value);
    if (name === 'confidence') {
      var lbl = document.getElementById('leadEditor_confidenceLabel');
      if (lbl) lbl.textContent = '— ' + (el.value || '0') + '%';
    }
  }
  function getField(name) {
    var el = document.getElementById('leadEditor_' + (name === 'title' ? 'title_field' : name));
    return el ? el.value : '';
  }

  function clearEditor() {
    _pickedGeo = null; // drop any address picked in a prior editor session
    EDITABLE_FIELDS.forEach(function(f) { setField(f, ''); });
    setField('status', 'new');
    setField('confidence', 0);
    document.getElementById('leadEditor_id').value = '';
    document.getElementById('leadEditor_status_msg').textContent = '';
    document.getElementById('leadEditor_submitBtn').disabled = false;
    document.getElementById('leadEditor_deleteBtn').style.display = 'none';
    var chip = document.getElementById('leadEditor_linkedJob');
    if (chip) chip.style.display = 'none';
    var convertBtn = document.getElementById('leadEditor_convertJobBtn');
    if (convertBtn) convertBtn.style.display = 'none';
  }

  // Reuse the clients cache (loaded by clients.js) so we don't hit the API
  // again. Falls back to a fetch if the cache is empty (e.g. user opens
  // the Lead modal before they've ever opened the Clients tab).
  function populateClientSelect(currentClientId) {
    var sel = document.getElementById('leadEditor_client_id');
    if (!sel) return;
    var fillFrom = function(clients) {
      // Underlying <select> stays populated for back-compat. The
      // searchable picker widget reads .value off this same element.
      var html = '<option value="">— Select a client —</option>';
      clients.slice().sort(function(a, b) {
        return (a.name || '').localeCompare(b.name || '');
      }).forEach(function(c) {
        var selAttr = c.id === currentClientId ? ' selected' : '';
        html += '<option value="' + escapeAttr(c.id) + '"' + selAttr + '>' + escapeHTML(c.name || '(unnamed)') + '</option>';
      });
      sel.innerHTML = html;
      sel.value = currentClientId || '';

      // Mount the searchable picker. The original <select> has an
      // onchange="onLeadClientPicked()" attribute — re-fire that after
      // a click-pick so the lead-side prefill (address, etc.) still runs.
      if (window.p86Clients && typeof window.p86Clients.mountPicker === 'function') {
        var handle = window.p86Clients.mountPicker(sel, function() {
          if (typeof onLeadClientPicked === 'function') onLeadClientPicked();
        });
        if (handle && handle.refreshLabel) handle.refreshLabel();
      }
    };
    var cached = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    if (cached.length) {
      fillFrom(cached);
    } else if (window.p86Clients && typeof window.p86Clients.ensureLoaded === 'function') {
      // Use the canonical loader so the cache gets populated for
      // downstream consumers (onLeadClientPicked reads getCached()
      // to copy the picked client's address into the lead's address
      // fields — without populating the cache here that autofill
      // silently fails on the first open).
      window.p86Clients.ensureLoaded().then(fillFrom).catch(function() { fillFrom([]); });
    } else if (window.p86Api && window.p86Api.isAuthenticated()) {
      window.p86Api.clients.list().then(function(res) {
        fillFrom(res.clients || []);
      }).catch(function() { fillFrom([]); });
    } else {
      fillFrom([]);
    }
  }

  // Salesperson dropdown reads from the same admin users cache the rest of
  // the app uses. We list active PMs and admins (people who'd realistically
  // own a sales opportunity).
  function populateSalespersonSelect(currentId) {
    var sel = document.getElementById('leadEditor_salesperson_id');
    if (!sel) return;
    var users = (window.p86Admin && window.p86Admin.getActivePMs && window.p86Admin.getActivePMs()) || [];
    var html = '<option value="">— Unassigned —</option>';
    users.forEach(function(u) {
      var sel = (String(u.id) === String(currentId)) ? ' selected' : '';
      html += '<option value="' + u.id + '"' + sel + '>' + escapeHTML(u.name) +
        (u.role === 'admin' ? ' (admin)' : '') + '</option>';
    });
    sel.innerHTML = html;
    // If users haven't loaded yet, refresh and retry once.
    if (!users.length && window.p86Admin && window.p86Admin.loadUsersCache) {
      window.p86Admin.loadUsersCache().then(function() { populateSalespersonSelect(currentId); });
    }
  }

  // When the client dropdown changes, copy the picked client's address into
  // the lead's project-address fields. User can edit afterward — this is a
  // pre-fill, not a binding.
  //
  // If the clients cache hasn't populated yet (race: user picked a client
  // before populateClientSelect's API call completed and stashed results),
  // lazy-load via ensureLoaded and retry. Without this fallback the autofill
  // silently no-ops on the first pick of a fresh session.
  function _applyClientAutofill(c) {
    if (!c) return;
    function setIfEmpty(name, v) {
      var el = document.getElementById('leadEditor_' + name);
      if (el && !el.value && v) el.value = v;
    }
    setIfEmpty('street_address', c.property_address || c.address);
    setIfEmpty('city', c.city);
    setIfEmpty('state', c.state);
    setIfEmpty('zip', c.zip);
    setIfEmpty('property_name', c.community_name);
    setIfEmpty('market', c.market);
    setIfEmpty('gate_code', c.gate_code);
    // Refresh map + weather since the address fields just changed.
    if (typeof renderLeadMap === 'function') {
      var addr = _composeLeadAddress();
      renderLeadMap(addr);
      renderLeadWeather(addr);
    }
  }

  function onLeadClientPicked() {
    var sel = document.getElementById('leadEditor_client_id');
    if (!sel || !sel.value) return;
    var pickedId = sel.value;
    var cached = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    var c = cached.find(function(x) { return x.id === pickedId; });
    if (c) {
      _applyClientAutofill(c);
      return;
    }
    // Cache empty — lazy-load and retry once.
    if (window.p86Clients && typeof window.p86Clients.ensureLoaded === 'function') {
      window.p86Clients.ensureLoaded().then(function(list) {
        var c2 = (list || []).find(function(x) { return x.id === pickedId; });
        if (c2) _applyClientAutofill(c2);
      }).catch(function() { /* silent — autofill is best-effort */ });
    }
  }

  function openNewLeadModal() {
    clearEditor();
    document.getElementById('leadEditor_title').textContent = 'New Lead';
    populateClientSelect('');
    populateSalespersonSelect('');
    // Hide tabs in create mode — Proposals tab is meaningless until the
    // lead has an id. Reveal them on first save / re-open in edit mode.
    document.getElementById('leadEditor_tabs').style.display = 'none';
    var generalTab = document.getElementById('leadEditor_tab_general');
    var proposalsTab = document.getElementById('leadEditor_tab_proposals');
    if (generalTab) generalTab.style.display = '';
    if (proposalsTab) proposalsTab.style.display = 'none';
    var footer = document.querySelector('#leadEditorModal .modal-footer');
    if (footer) footer.style.display = '';
    // Show the BT-PDF drop zone and reset its status — only on create
    var pdfDrop = document.getElementById('leadEditor_pdfDrop');
    if (pdfDrop) {
      pdfDrop.style.display = '';
      var s = document.getElementById('leadEditor_pdfDropStatus');
      if (s) { s.style.display = 'none'; s.textContent = ''; s.style.color = ''; }
      wirePdfDropOnce();
    }
    openModal('leadEditorModal');
    // Create mode — all section gates open so the user can fill in a
    // brand-new lead without tapping 5 pencils first. The pencils are
    // still attached so a sloppy first-pass can be re-locked afterward.
    applyLeadFieldsetGates(true);
  }

  // Last-resort open: the lead isn't in the cache and no list fetch is in
  // flight — fetch just this lead, seed the cache, and re-enter the open.
  function fetchLeadThenOpen(id) {
    window.p86Api.leads.get(id).then(function(res) {
      _leads.push(res.lead);
      openEditLeadModal(id);
    }).catch(function() { alert('Lead not found.'); });
  }

  function openEditLeadModal(id) {
    var l = _leads.find(function(x) { return x.id === id; });
    if (!l) {
      // Not in cache. A tab-open reload may have just wiped it (opening a
      // lead from a map card navigates to the Leads tab, which re-fetches
      // the list) — join that fetch rather than firing a get-by-id too.
      if (_leadsFetchInflight) {
        _leadsFetchInflight.then(function() {
          if (_leads.some(function(x) { return x.id === id; })) openEditLeadModal(id);
          else fetchLeadThenOpen(id);
        });
        return;
      }
      fetchLeadThenOpen(id);
      return;
    }
    clearEditor();
    document.getElementById('leadEditor_title').textContent = 'Edit Lead: ' + l.title;
    document.getElementById('leadEditor_id').value = l.id;
    EDITABLE_FIELDS.forEach(function(f) { setField(f, l[f]); });
    populateClientSelect(l.client_id || '');
    populateSalespersonSelect(l.salesperson_id || '');
    document.getElementById('leadEditor_deleteBtn').style.display = '';
    // Hide the BT-PDF drop zone in edit mode — extraction only makes
    // sense when creating a fresh lead.
    var pdfDrop = document.getElementById('leadEditor_pdfDrop');
    if (pdfDrop) pdfDrop.style.display = 'none';
    // Edit mode shows the General | Proposals tab nav. Default to General;
    // user clicks Proposals to see the linked estimates.
    document.getElementById('leadEditor_tabs').style.display = '';
    switchLeadEditorTab('general');
    renderLeadProposals(l.id);
    refreshLinkedJobChip(l);
    refreshConvertJobButton(l);
    // Right-panel context: map, attachments, weather. Loads once on
    // open + debounced re-fetch when the user edits the address fields.
    renderLeadEditorRightPanels(l);
    wireLeadAddressWatchers();
    // Auto-save on field blur. Each editable field gets a change
    // listener that fires submitLeadEditorSilent() with a small debounce
    // so rapid tab-throughs coalesce into one server hit.
    wireLeadBlurSave();
    openLeadDetailView();
    // Edit mode — sections render locked so a stray scroll-tap can't
    // mutate a contract amount or an address. User taps the per-
    // section pencil to arm a fieldset for editing; Save commits the
    // whole form regardless of which sections are armed.
    applyLeadFieldsetGates(false);
    // Live-refresh the detail-view sticky header when the user edits
    // the title or flips the status select. Bound after the form
    // renders so the elements exist; idempotent because we replace
    // .onchange/.oninput rather than addEventListener.
    var titleField = document.getElementById('leadEditor_title_field');
    var statusField = document.getElementById('leadEditor_status');
    if (titleField) {
      titleField.oninput = function() {
        var t = document.getElementById('ld-title');
        if (t) t.textContent = titleField.value || 'Lead';
      };
    }
    if (statusField) {
      statusField.onchange = function() { refreshLeadDetailHeader(); };
    }
  }

  // ── Right-panel context (map / photos / weather) ─────────────
  //
  // Three contextual panels sit alongside the form. Each is wired to
  // the lead's current state:
  //   • Map     — Google Maps iframe centered on Street + City + State.
  //   • Photos  — list of attachments scoped to lead_id via the
  //               existing /api/attachments/lead/:id endpoint.
  //   • Weather — 7-day NWS forecast at the resolved address (via
  //               the by-address weather endpoint we added).
  //
  // On open: paint all three immediately from the lead's current
  // field state. On address edit: debounced re-fetch of map + weather
  // (attachments don't depend on address).

  function _composeLeadAddress() {
    var street = (document.getElementById('leadEditor_street_address') || {}).value || '';
    var city   = (document.getElementById('leadEditor_city') || {}).value || '';
    var state  = (document.getElementById('leadEditor_state') || {}).value || '';
    var zip    = (document.getElementById('leadEditor_zip') || {}).value || '';
    var parts = [];
    if (street.trim()) parts.push(street.trim());
    var cityState = [city.trim(), state.trim()].filter(Boolean).join(', ');
    if (cityState) parts.push(cityState);
    if (zip.trim()) parts.push(zip.trim());
    return parts.join(', ');
  }

  function renderLeadMap(address) {
    var host = document.getElementById('leadEditor_mapHost');
    if (!host) return;
    if (!address) {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:14px;text-align:center;">Fill in the Project Address to see a map.</div>';
      return;
    }
    // Google Maps iframe — free, no API key, handles geocoding visually.
    // Using the "search" output mode so the address is rendered as a
    // pin with the location name in the corner. q= is URL-encoded.
    var url = 'https://www.google.com/maps?q=' + encodeURIComponent(address) + '&output=embed&z=16';
    // The embed isn't clickable-to-open, so pin a small "Open in Google
    // Maps" chip that launches the real Maps app/site for this address.
    var openChip = (window.p86MapLink && window.p86MapLink.linkHTML)
      ? window.p86MapLink.linkHTML('Open in Google Maps ↗', address,
          { noIcon: true, style: 'font-size:11px;font-weight:600;color:#0a66c2;text-decoration:none;' })
      : '';
    host.innerHTML =
      '<div style="position:relative;width:100%;height:100%;">' +
        '<iframe src="' + url + '" style="border:0;width:100%;height:100%;display:block;" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>' +
        (openChip ? '<div style="position:absolute;bottom:8px;right:8px;background:rgba(255,255,255,0.94);border-radius:6px;padding:4px 9px;box-shadow:0 1px 5px rgba(0,0,0,0.3);">' + openChip + '</div>' : '') +
      '</div>';
  }

  function renderLeadWeather(address) {
    var host = document.getElementById('leadEditor_weatherHost');
    if (!host) return;
    if (!address) {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:10px 0;">Fill in the Project Address to see the forecast.</div>';
      return;
    }
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:10px 0;">Loading forecast…</div>';
    var token = String(Date.now()) + '-' + Math.random().toString(36).slice(2, 6);
    host.setAttribute('data-weather-token', token);
    window.p86Api.get('/api/weather/by-address?address=' + encodeURIComponent(address)).then(function(r) {
      // Drop the response if a newer fetch is in flight (user typed more
      // address chars while this was loading) — we don't want a stale
      // result to overwrite the fresh one.
      if (host.getAttribute('data-weather-token') !== token) return;
      paintLeadWeatherBody(host, r);
    }).catch(function(err) {
      if (host.getAttribute('data-weather-token') !== token) return;
      host.innerHTML = '<div style="color:#f87171;font-size:12px;padding:10px 0;">Weather unavailable: ' + escapeHTML(err && err.message || 'unknown') + '</div>';
    });
  }

  function paintLeadWeatherBody(host, w) {
    if (!w || w.status === 'no_address') {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:10px 0;">Add an address to see the forecast.</div>';
      return;
    }
    if (w.status === 'failed') {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:10px 0;">Could not match this address.</div>';
      return;
    }
    if (w.status === 'out_of_range') {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:10px 0;">Address is outside NWS coverage.</div>';
      return;
    }
    if (w.status !== 'ok' || !Array.isArray(w.days) || !w.days.length) {
      host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:10px 0;">No forecast data.</div>';
      return;
    }
    // Compact 7-card forecast strip. Each card: emoji weather glyph,
    // day-of-week / date, high/low, precip %. Emoji is picked from
    // the NWS summary text + precipPct via _weatherEmojiFor() so the
    // glyph reads naturally without needing a custom icon font.
    var cards = w.days.slice(0, 7).map(function(d) {
      var date = d.date ? new Date(d.date) : null;
      var dow = date ? ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][date.getDay()] : '';
      var mmdd = date ? ((date.getMonth() + 1) + '/' + date.getDate()) : '';
      var hi = (d.tempHigh != null) ? d.tempHigh + '°' : '—';
      var lo = (d.tempLow != null) ? d.tempLow + '°' : '';
      var precip = d.precipPct ? d.precipPct + '%' : '';
      var border = d.risk === 'high' ? '#f87171' : (d.risk === 'med' ? '#fbbf24' : 'rgba(255,255,255,0.08)');
      var emoji = _weatherEmojiFor(d);
      return '<div title="' + escapeAttr(d.summary || '') + '" style="flex:1 1 60px;min-width:60px;padding:8px 4px 6px;background:rgba(255,255,255,0.02);border:1px solid var(--border,#333);border-top:2px solid ' + border + ';border-radius:6px;text-align:center;font-size:11px;">' +
        '<div style="color:var(--text-dim,#aaa);font-size:10px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">' + escapeHTML(dow) + '</div>' +
        '<div style="font-size:20px;line-height:1.2;margin:2px 0;">' + emoji + '</div>' +
        '<div style="color:var(--text,#fff);font-weight:600;">' + escapeHTML(hi) + '</div>' +
        (lo ? '<div style="color:var(--text-dim,#888);font-size:10px;">' + escapeHTML(lo) + '</div>' : '') +
        (precip ? '<div style="color:#60a5fa;font-size:10px;margin-top:3px;">\u{1F4A7} ' + escapeHTML(precip) + '</div>' : '') +
        '<div style="color:var(--text-dim,#666);font-size:9px;margin-top:3px;">' + escapeHTML(mmdd) + '</div>' +
      '</div>';
    }).join('');
    host.innerHTML = '<div style="display:flex;gap:4px;flex-wrap:wrap;">' + cards + '</div>';
  }

  // Map an NWS daily-summary + precip% to a Unicode emoji.
  // NWS summary phrasing is mostly canonical: "Sunny", "Mostly Sunny",
  // "Partly Cloudy", "Cloudy", "Showers", "Thunderstorms", "Snow", etc.
  // We pattern-match a few keywords and fall back to a sun/cloud icon
  // based on cloud-cover phrasing.
  function _weatherEmojiFor(d) {
    var s = String((d && d.summary) || '').toLowerCase();
    var precip = Number((d && d.precipPct) || 0);
    // Severe / precip-heavy first so "thunderstorm" wins over generic "cloudy"
    if (s.indexOf('thunder') !== -1 || s.indexOf('t-storm') !== -1) return '⛈';  // ⛈
    if (s.indexOf('snow') !== -1 || s.indexOf('flurries') !== -1 || s.indexOf('blizzard') !== -1) return '❄';  // ❄
    if (s.indexOf('sleet') !== -1 || s.indexOf('freezing') !== -1 || s.indexOf('ice') !== -1) return '\u{1F328}';  // 🌨
    if (s.indexOf('heavy rain') !== -1 || s.indexOf('downpour') !== -1) return '\u{1F327}';  // 🌧
    if (s.indexOf('shower') !== -1) return '\u{1F326}';  // 🌦
    if (s.indexOf('rain') !== -1 || s.indexOf('drizzle') !== -1) return '\u{1F327}';  // 🌧
    if (s.indexOf('fog') !== -1 || s.indexOf('haze') !== -1 || s.indexOf('mist') !== -1) return '\u{1F32B}';  // 🌫
    if (s.indexOf('wind') !== -1 || s.indexOf('breezy') !== -1) return '\u{1F32C}';  // 🌬
    // Cloud cover spectrum. NWS uses: Sunny, Mostly Sunny, Partly Sunny / Partly Cloudy, Mostly Cloudy, Cloudy.
    if (s.indexOf('sunny') !== -1 && s.indexOf('mostly') === -1 && s.indexOf('partly') === -1) return '☀';  // ☀
    if (s.indexOf('clear') !== -1) return '☀';  // ☀
    if (s.indexOf('mostly sunny') !== -1) return '\u{1F324}';  // 🌤
    if (s.indexOf('partly sunny') !== -1 || s.indexOf('partly cloudy') !== -1) return '⛅';  // ⛅
    if (s.indexOf('mostly cloudy') !== -1) return '\u{1F325}';  // 🌥
    if (s.indexOf('cloudy') !== -1 || s.indexOf('overcast') !== -1) return '☁';  // ☁
    // Precip-pct fallback when summary text doesn't match any keyword.
    if (precip >= 60) return '\u{1F327}';  // 🌧
    if (precip >= 30) return '\u{1F326}';  // 🌦
    if (precip >= 10) return '⛅';  // ⛅
    return '\u{1F324}';  // 🌤 default mild
  }

  function renderLeadAttachments(leadId) {
    var host = document.getElementById('leadEditor_attachmentsHost');
    if (!host) return;
    if (!leadId) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:10px 0;">Save the lead first to attach files.</div>';
      return;
    }
    host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:10px 0;">Loading attachments…</div>';
    window.p86Api.get('/api/attachments/lead/' + encodeURIComponent(leadId)).then(function(r) {
      var items = (r && r.attachments) || [];
      var rows = items.map(function(a) {
        var thumb = a.is_image
          ? '<img src="/api/attachments/raw/' + encodeURIComponent(a.id) + '?thumb=1" style="width:48px;height:48px;object-fit:cover;border-radius:4px;border:1px solid var(--border,#333);" alt="" loading="lazy" />'
          : '<div style="width:48px;height:48px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-radius:4px;display:flex;align-items:center;justify-content:center;color:var(--text-dim,#888);font-size:18px;">' + (a.mime_type && a.mime_type.indexOf('pdf') >= 0 ? '\u{1F4C4}' : '\u{1F4CE}') + '</div>';
        return '<a href="/api/attachments/raw/' + encodeURIComponent(a.id) + '" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;padding:6px;border-radius:6px;text-decoration:none;color:var(--text,#fff);transition:background 0.12s;" onmouseover="this.style.background=\'rgba(255,255,255,0.04)\'" onmouseout="this.style.background=\'transparent\'">' +
          thumb +
          '<div style="flex:1;min-width:0;overflow:hidden;">' +
            '<div style="font-size:12px;color:var(--text,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHTML(a.caption || a.original_filename || 'Attachment') + '</div>' +
            '<div style="font-size:10px;color:var(--text-dim,#888);">' + escapeHTML(a.original_filename || '') + (a.size_bytes ? ' · ' + Math.round(a.size_bytes/1024) + ' KB' : '') + '</div>' +
          '</div>' +
        '</a>';
      }).join('');
      var dropZone = '<div id="leadEditor_attachmentDrop" style="margin-top:10px;border:2px dashed var(--border,#333);border-radius:6px;padding:10px;text-align:center;font-size:11px;color:var(--text-dim,#888);cursor:pointer;transition:border-color 0.15s,background 0.15s;" onclick="document.getElementById(\'leadEditor_attachmentFileInput\').click()">' +
        '\u{1F4CE} Drop a file here, or <span style="color:#4f8cff;">click to pick</span>' +
        '<input id="leadEditor_attachmentFileInput" type="file" style="display:none;" onchange="uploadLeadAttachment(this.files[0])" />' +
      '</div>';
      host.innerHTML = (rows || '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">No attachments yet.</div>') + dropZone;
      wireLeadAttachmentDrop();
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#f87171;font-size:12px;padding:10px 0;">Failed to load attachments: ' + escapeHTML(err && err.message || 'unknown') + '</div>';
    });
  }

  function wireLeadAttachmentDrop() {
    var dz = document.getElementById('leadEditor_attachmentDrop');
    if (!dz) return;
    dz.ondragover = function(e) { e.preventDefault(); dz.style.borderColor = '#4f8cff'; dz.style.background = 'rgba(79,140,255,0.06)'; };
    dz.ondragleave = function() { dz.style.borderColor = 'var(--border,#333)'; dz.style.background = 'transparent'; };
    dz.ondrop = function(e) {
      e.preventDefault();
      dz.style.borderColor = 'var(--border,#333)';
      dz.style.background = 'transparent';
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) window.uploadLeadAttachment(f);
    };
  }

  window.uploadLeadAttachment = function(file) {
    if (!file) return;
    var leadId = (document.getElementById('leadEditor_id') || {}).value;
    if (!leadId) { alert('Save the lead first before uploading files.'); return; }
    var fd = new FormData();
    fd.append('file', file);
    var dz = document.getElementById('leadEditor_attachmentDrop');
    if (dz) dz.textContent = 'Uploading ' + file.name + '…';
    var tok = window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken();
    fetch('/api/attachments/lead/' + encodeURIComponent(leadId), {
      method: 'POST',
      headers: tok ? { Authorization: 'Bearer ' + tok } : {},
      body: fd
    }).then(function(r) {
      if (!r.ok) return r.text().then(function(t) { throw new Error('HTTP ' + r.status + ': ' + t.slice(0, 200)); });
      return r.json();
    }).then(function() {
      renderLeadAttachments(leadId);
    }).catch(function(err) {
      alert('Upload failed: ' + (err.message || 'unknown'));
      renderLeadAttachments(leadId);
    });
  };

  function renderLeadEditorRightPanels(lead) {
    var addr = _composeLeadAddress();
    var leadId = lead && lead.id;
    // Order matches the DOM: Map -> Estimates -> Projects -> Photos -> Weather.
    renderLeadMap(addr);
    renderLeadEstimatesCompact(leadId);
    renderLeadProjects(leadId);
    renderLeadTasks(leadId, lead);
    renderLeadAttachments(leadId);
    renderLeadWeather(addr);
    renderLeadCapturedCosts(leadId);
  }

  // Pre-sale captured costs (field receipts) for this lead — read-only rollup
  // via the Cost Inbox. Appended to the right-panel column; carried to the job
  // (still pre-sale) on conversion.
  function renderLeadCapturedCosts(leadId) {
    var anchor = document.getElementById('leadEditor_tasksHost');
    var container = anchor && anchor.parentNode;
    if (!container || !window.p86CostInbox || !window.p86CostInbox.mountRollup) return;
    var card = document.getElementById('leadEditor_capturedCostsCard');
    if (!leadId) { if (card) card.remove(); return; }
    if (!card) {
      card = document.createElement('div');
      card.id = 'leadEditor_capturedCostsCard';
      card.style.cssText = 'border:1px solid var(--border,#2e3346);border-radius:8px;padding:8px 10px;margin:0 0 10px 0;';
      card.innerHTML = '<div id="leadEditor_capturedCostsInner"></div>';
      container.appendChild(card);
    }
    window.p86CostInbox.mountRollup(document.getElementById('leadEditor_capturedCostsInner'), { entityType: 'lead', entityId: leadId, compact: true });
  }

  // Tasks panel — defers to window.p86Tasks.mountEntityPanel
  // (from js/tasks.js). Shows nothing actionable until the lead is
  // saved (no id to link tasks against).
  function renderLeadTasks(leadId, lead) {
    var host = document.getElementById('leadEditor_tasksHost');
    if (!host) return;
    if (!leadId) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">Save the lead first to add tasks.</div>';
      return;
    }
    if (window.p86Tasks && typeof window.p86Tasks.mountEntityPanel === 'function') {
      var label = (lead && (lead.title || lead.name)) || ('Lead #' + leadId);
      window.p86Tasks.mountEntityPanel(host, 'lead', leadId, label);
    } else {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">Tasks module not loaded.</div>';
    }
  }

  // Linked Projects panel — defers to window.renderLinkedProjectsPanel
  // (from js/projects.js). Shows nothing if the lead hasn't been
  // saved yet (no id to link against).
  function renderLeadProjects(leadId) {
    var host = document.getElementById('leadEditor_projectsHost');
    if (!host) return;
    if (!leadId) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">Save the lead first to attach a project.</div>';
      return;
    }
    if (typeof window.renderLinkedProjectsPanel === 'function') {
      window.renderLinkedProjectsPanel(host, { kind: 'lead', id: leadId });
    } else {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">Projects module not loaded.</div>';
    }
  }

  // ── Blur-save (auto-save on field exit) ──────────────────────
  //
  // Per-field auto-save. When an input/select/textarea in the left
  // column loses focus or commits a change, we send ONLY that field's
  // new value to the server, not the whole form.
  //
  // Sending the whole form was a footgun: if any unrelated field was
  // temporarily empty (async re-render mid-blur, race against a
  // populate*Select that's still loading, etc.) the silent save
  // would write nulls and overwrite good server data. Per-field
  // updates eliminate that — a save only touches the field the user
  // actually edited.
  //
  // Each pending field has its own 300ms debounce timer keyed by
  // field name. Saves serialize globally via _blurSaveInFlight so
  // we don't pile up concurrent PUTs. We also snapshot each field's
  // value at focus time and skip the save if the blur value matches
  // (no actual change → no network call).

  // DOM element id → leads-record field name. Most are 1:1 with the
  // id suffix; title is special (id is leadEditor_title_field).
  function _fieldNameForEl(el) {
    if (!el || !el.id || el.id.indexOf('leadEditor_') !== 0) return null;
    var suffix = el.id.slice('leadEditor_'.length);
    if (suffix === 'title_field') return 'title';
    if (suffix === 'id') return null;
    if (suffix === 'confidenceLabel') return null;
    // Only fields in EDITABLE_FIELDS are persistable.
    return EDITABLE_FIELDS.indexOf(suffix) >= 0 ? suffix : null;
  }

  // Per-field debounce timer + in-flight serialization.
  var _blurSaveTimers = {};
  var _blurSaveInFlight = false;
  var _blurSavePending = []; // { name, value } items queued behind an in-flight save
  var _focusSnapshots = {};  // field name → value captured at focus time

  function _scheduleFieldSave(name, value) {
    if (_blurSaveTimers[name]) clearTimeout(_blurSaveTimers[name]);
    _blurSaveTimers[name] = setTimeout(function() {
      delete _blurSaveTimers[name];
      _saveFieldNow(name, value);
    }, 300);
  }

  function _saveFieldNow(name, rawValue) {
    var id = (document.getElementById('leadEditor_id') || {}).value;
    if (!id) return; // new-lead path uses explicit Save button
    if (!name) return;
    if (name === 'title' && !String(rawValue || '').trim()) return; // never save empty title
    if (_blurSaveInFlight) {
      // Queue this one — replace any prior pending for the same field
      // so we don't double-send stale values.
      _blurSavePending = _blurSavePending.filter(function(p) { return p.name !== name; });
      _blurSavePending.push({ name: name, value: rawValue });
      return;
    }
    var payload = {};
    payload[name] = rawValue === '' ? null : rawValue;
    var statusEl = document.getElementById('ld-status-msg');
    if (statusEl) { statusEl.style.color = 'var(--text-dim,#888)'; statusEl.textContent = 'Saving…'; }
    _blurSaveInFlight = true;
    window.p86Api.leads.update(id, payload).then(function() {
      _blurSaveInFlight = false;
      if (statusEl) {
        statusEl.style.color = '#34d399';
        statusEl.textContent = '✓ Saved ' + name.replace(/_/g, ' ');
        setTimeout(function() {
          if (statusEl.textContent.indexOf('✓ Saved') === 0) statusEl.textContent = '';
        }, 1800);
      }
      // Keep local cache fresh so the leads list reflects edits without a reload.
      var idx = _leads.findIndex(function(x) { return x.id === id; });
      if (idx >= 0) _leads[idx] = Object.assign({}, _leads[idx], payload);
      // Refresh focus snapshot for this field so the next blur compares
      // against the actually-saved value, not the old one.
      _focusSnapshots[name] = rawValue;
      // Drain queued saves (one at a time).
      if (_blurSavePending.length) {
        var next = _blurSavePending.shift();
        _saveFieldNow(next.name, next.value);
      }
    }).catch(function(err) {
      _blurSaveInFlight = false;
      if (statusEl) { statusEl.style.color = '#f87171'; statusEl.textContent = 'Save failed: ' + (err.message || 'unknown'); }
      // Drop queued saves on failure — user needs to see the error.
      _blurSavePending = [];
    });
  }

  function wireLeadBlurSave() {
    var formBody = document.getElementById('leadEditor_formBody');
    if (!formBody) return;
    // Scope to the editable left column (right column is display-only).
    var scope = formBody.querySelector('.lead-editor-left') || formBody;
    var inputs = scope.querySelectorAll('input, select, textarea');
    inputs.forEach(function(el) {
      if (el.dataset.blurSaveBound === '1') return;
      el.dataset.blurSaveBound = '1';
      var name = _fieldNameForEl(el);
      if (!name) return;
      // Snapshot the value at focus so we can diff at blur. Without
      // this, we'd save unchanged fields too which is wasteful AND
      // racy (a field could be momentarily empty during a re-render).
      el.addEventListener('focus', function() {
        _focusSnapshots[name] = el.value;
      });
      function handler() {
        // Only save if the value actually changed since focus. If the
        // field was just rendered (no focus event fired), the snapshot
        // is missing — fall back to comparing against the leads cache.
        var current = el.value;
        var snap = _focusSnapshots[name];
        if (snap == null) {
          // No snapshot — compare against cached lead. Skip if it
          // matches; saves go through only for genuine edits.
          var id = (document.getElementById('leadEditor_id') || {}).value;
          var cachedLead = id ? _leads.find(function(x) { return x.id === id; }) : null;
          var cachedVal = cachedLead ? (cachedLead[name] == null ? '' : String(cachedLead[name])) : '';
          if (String(current) === cachedVal) return;
        } else if (String(current) === String(snap)) {
          return;
        }
        _scheduleFieldSave(name, current);
      }
      el.addEventListener('change', handler);
      el.addEventListener('blur', handler);
    });
  }

  // Debounced rebuild of map + weather when the address fields change.
  // Bound once per editor open; subsequent calls are no-ops (we check
  // the data-watcher-bound flag).
  var _addressRebuildTimer = null;
  var _pickedGeo = null, _leadAcHandle = null; // Places-picked coords for the save payload
  function wireLeadAddressWatchers() {
    ['leadEditor_street_address', 'leadEditor_city', 'leadEditor_state', 'leadEditor_zip'].forEach(function(id) {
      var el = document.getElementById(id);
      if (!el || el.dataset.watcherBound) return;
      el.dataset.watcherBound = '1';
      el.addEventListener('input', function() {
        if (_addressRebuildTimer) clearTimeout(_addressRebuildTimer);
        _addressRebuildTimer = setTimeout(function() {
          var addr = _composeLeadAddress();
          renderLeadMap(addr);
          renderLeadWeather(addr);
        }, 700);
      });
    });
    wireLeadAddressAutocomplete();
  }

  // Google Places autocomplete on the Project Address fieldset — a "Search
  // address" box that fills street/city/state/zip and captures the exact
  // lat/lng, so the lead saves with real coords (map + Site Plan satellite
  // render immediately, no separate geocode). Mounted once per editor DOM.
  function wireLeadAddressAutocomplete() {
    if (!window.p86AddressAutocomplete) return;
    var street = document.getElementById('leadEditor_street_address');
    if (!street || typeof street.closest !== 'function') return;
    var fs = street.closest('fieldset');
    if (!fs || fs.querySelector('.p86-addr-ac-row')) return; // mount once
    var row = document.createElement('div');
    row.className = 'p86-addr-ac-row';
    var lbl = document.createElement('label');
    lbl.textContent = 'Search address';
    row.appendChild(lbl);
    var legend = fs.querySelector('legend');
    if (legend && legend.nextSibling) fs.insertBefore(row, legend.nextSibling);
    else fs.insertBefore(row, fs.firstChild);
    _leadAcHandle = window.p86AddressAutocomplete.attach({
      mount: row,
      placeholder: 'Start typing an address…',
      onPlace: function (r) {
        function set(id, v) { var el = document.getElementById(id); if (el && v) el.value = v; }
        set('leadEditor_street_address', r.components.street_address || r.formatted);
        set('leadEditor_city', r.components.city);
        set('leadEditor_state', r.components.state);
        set('leadEditor_zip', r.components.zip);
        _pickedGeo = (r.lat != null && r.lng != null) ? { lat: r.lat, lng: r.lng } : null;
        ['leadEditor_street_address', 'leadEditor_city', 'leadEditor_state', 'leadEditor_zip'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) { try { el.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {} }
        });
      }
    });
  }

  // Wire the edit-gate pencil into editable fieldsets on the LEFT
  // column only — Lead / Address / Sales Pipeline / Site Details /
  // Notes. The RIGHT column's fieldsets (Map / Photos & Files /
  // 7-day Forecast) are display-only or have their own dedicated
  // affordances (the file drop zone, the forecast cards), so they
  // shouldn't get a pencil. We scope by container: only fieldsets
  // INSIDE .lead-editor-left receive the gate. The right column's
  // fieldsets are not direct descendants of .lead-editor-left so
  // they're naturally excluded.
  function applyLeadFieldsetGates(unlocked) {
    if (!window.p86EditGate) return;
    var formBody = document.getElementById('leadEditor_formBody');
    if (!formBody) return;
    // Scope to the left column only. Falls back to the old broad
    // selector if the split-pane layout isn't mounted (e.g., legacy
    // modal-only render path) so we don't lose gates entirely.
    var scope = formBody.querySelector('.lead-editor-left') || formBody;
    var fieldsets = scope.querySelectorAll('fieldset');
    for (var i = 0; i < fieldsets.length; i++) {
      window.p86EditGate.attachSection(fieldsets[i], { startUnlocked: !!unlocked });
    }
  }

  // Open the dedicated #lead-detail-view as a full-page surface
  // (mirrors the estimate editor pattern). Re-parents the form body
  // (#leadEditor_formBody) from inside the modal into the detail
  // view's body host so the same form fields are reused without
  // duplicating IDs. Hides the leads list + the parent
  // Leads/Estimates/Clients/Subs nav so the Back button is the only
  // return path.
  function openLeadDetailView() {
    var detailView = document.getElementById('lead-detail-view');
    var bodyHost = document.getElementById('lead-detail-body-host');
    var formBody = document.getElementById('leadEditor_formBody');
    var listView = document.getElementById('leads-list-view');
    if (!detailView || !bodyHost || !formBody) {
      // Build is missing the new markup — fall back to modal mode.
      openModal('leadEditorModal');
      return;
    }
    if (formBody.parentNode !== bodyHost) bodyHost.appendChild(formBody);
    detailView.style.display = '';
    if (listView) listView.style.display = 'none';
    // The legacy #estimates-main-tabs sub-tab row is permanently
    // hidden via inline display:none in index.html (Leads + Estimates
    // are top-level tabs now; Clients + Subs live in the Directory
    // dropdown). Don't toggle it here.
    // Refresh the sticky-header title + status pill from the loaded form.
    refreshLeadDetailHeader();
    mountLeadSidebarCard();
    // Scroll to top so the user lands at the form's start.
    window.scrollTo(0, 0);
  }

  // Update the sticky-header title + status pill + delete/convert
  // button visibility from current form state. Called on open and
  // whenever the status select changes.
  function refreshLeadDetailHeader() {
    var l = _leads.find(function(x) { return x.id === _currentEditingLeadId; });
    var titleEl = document.getElementById('ld-title');
    var pillEl = document.getElementById('ld-status-pill');
    var delBtn = document.getElementById('ld-delete-btn');
    var convertBtn = document.getElementById('ld-convert-btn');
    if (titleEl) titleEl.textContent = (l && l.title) || 'Lead';
    if (pillEl) {
      var statusVal = (document.getElementById('leadEditor_status') || {}).value || (l && l.status) || 'new';
      var sm = statusMeta(statusVal);
      pillEl.innerHTML =
        '<span style="display:inline-block;padding:3px 10px;border-radius:10px;background:' + sm.bg +
        ';color:' + sm.color + ';font-size:11px;text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' +
        escapeHTML(sm.label) + '</span>';
    }
    // Delete + Convert buttons only meaningful in edit mode (we have an id).
    if (delBtn) delBtn.style.display = (l && l.id) ? '' : 'none';
    if (convertBtn && l) {
      var canEditJobs = window.p86Auth && (
        window.p86Auth.hasCapability('JOBS_EDIT_ANY') ||
        window.p86Auth.hasCapability('JOBS_EDIT_OWN')
      );
      convertBtn.style.display = (canEditJobs && !l.job_id) ? '' : 'none';
    }
  }
  window.refreshLeadDetailHeader = refreshLeadDetailHeader;

  // Mount the shared Pulse card into the sidebar for a lead. Accent + ring
  // color = the lead's MAP PIN color; the ring shows confidence %; status pill
  // keeps the pipeline status color; stats = Est. value (highest attached
  // estimate) + Age. Exposed as window.p86MountLeadCard so the estimate editor
  // can show the PARENT LEAD's card instead of its own.
  function mountLeadCard(l) {
    if (!window.p86EntitySubnav || !window.p86EntityCard || !l) return;
    function sm(n) { n = Number(n) || 0; var a = Math.abs(n); if (a >= 1e6) return '$' + (a / 1e6).toFixed(1).replace(/\.0$/, '') + 'M'; if (a >= 1e3) return '$' + Math.round(a / 1e3) + 'k'; return '$' + Math.round(a); }
    var accent = window.p86EntityCard.pinColor(l, 'lead') || '#4f8cff';
    var statusCol = window.p86EntityCard.leadStatusColor(l.status);
    var rev = revenueFromAttachedEstimates(l.id);
    var ageDays = l.created_at ? Math.max(0, Math.round((Date.now() - new Date(l.created_at).getTime()) / 86400000)) : null;
    var conf = Number(l.confidence) || 0;
    var stats = [{ label: 'Est. value', value: (rev != null ? sm(rev) : '—') }];
    if (ageDays != null) stats.push({ label: 'Age', value: ageDays + 'd' });
    var meta = (typeof statusMeta === 'function') ? statusMeta(l.status) : null;
    window.p86EntitySubnav.mount('lead', {
      kind: 'lead', accent: accent,
      status: { label: (meta && meta.label) || l.status || 'Open', color: statusCol },
      title: l.title || 'Lead',
      subtitle: l.client_name || l.property_name || '',
      address: [l.street_address, l.city].filter(Boolean).join(', '),
      ring: (conf > 0 ? { pct: conf } : undefined),
      stats: stats
    });
  }
  window.p86MountLeadCard = mountLeadCard;

  // Back-compat shim — openLeadDetailView calls this (no arg). Resolves the
  // current lead, then delegates to the shared mounter.
  function mountLeadSidebarCard() {
    var l = _leads.find(function(x) { return x.id === _currentEditingLeadId; });
    if (!l) { if (window.p86EntitySubnav) window.p86EntitySubnav.unmount('lead'); return; }
    mountLeadCard(l);
  }

  // Reverse openLeadDetailView. Moves the form body back into the
  // modal so a subsequent "New Lead" click renders the same form as
  // a centered popup again.
  function closeLeadDetail() {
    var detailView = document.getElementById('lead-detail-view');
    var formBody = document.getElementById('leadEditor_formBody');
    var modalContent = document.querySelector('#leadEditorModal .modal-content');
    var modalFooter = document.getElementById('leadEditor_modalFooter');
    var listView = document.getElementById('leads-list-view');
    // Move the form body back into the modal, just before the footer.
    if (formBody && modalContent && modalFooter && formBody.parentNode !== modalContent) {
      modalContent.insertBefore(formBody, modalFooter);
    }
    if (detailView) detailView.style.display = 'none';
    if (listView) listView.style.display = '';
    // (no #estimates-main-tabs restore — see openLeadDetailView comment)
    if (window.p86EntitySubnav) window.p86EntitySubnav.clearAll();
    _currentEditingLeadId = null;
    reloadLeadsCache();
  }
  window.closeLeadDetail = closeLeadDetail;

  // Single close-helper used by save / cancel / delete handlers. Picks
  // the right teardown based on which mode the lead editor is currently
  // displayed in (modal for create vs page for edit).
  function closeLeadEditorAny() {
    var detailView = document.getElementById('lead-detail-view');
    var inDetailMode = detailView && detailView.style.display !== 'none';
    if (inDetailMode) {
      closeLeadDetail();
    } else {
      if (typeof closeModal === 'function') closeModal('leadEditorModal');
    }
  }

  // Show the green "Sold — linked to a job" chip when the lead has a job_id.
  // Clicking the chip's button jumps to that job's detail view.
  function refreshLinkedJobChip(l) {
    var chip = document.getElementById('leadEditor_linkedJob');
    var labelEl = document.getElementById('leadEditor_linkedJobLabel');
    if (!chip) return;
    if (!l || !l.job_id) {
      chip.style.display = 'none';
      return;
    }
    var jobs = (window.appData && appData.jobs) || [];
    var job = jobs.find(function(j) { return j.id === l.job_id; });
    if (labelEl) {
      labelEl.textContent = job
        ? ((job.jobNumber ? '[' + job.jobNumber + '] ' : '') + (job.title || job.id))
        : ('Job ' + l.job_id + ' (not in current view — admin may have removed it)');
    }
    chip.style.display = 'flex';
  }

  // Hide the convert button on already-converted leads (they have a job_id)
  // and on roles without job-edit capability. Keeping the button always
  // visible would tempt double-conversion of the same lead.
  function refreshConvertJobButton(l) {
    var btn = document.getElementById('leadEditor_convertJobBtn');
    if (!btn) return;
    var canEditJobs = window.p86Auth && (
      window.p86Auth.hasCapability('JOBS_EDIT_ANY') ||
      window.p86Auth.hasCapability('JOBS_EDIT_OWN')
    );
    btn.style.display = (canEditJobs && (!l || !l.job_id)) ? '' : 'none';
  }

  // Open the job linked to the currently-editing lead.
  function openLinkedJobFromLead() {
    var leadId = _currentEditingLeadId;
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l || !l.job_id) return;
    closeLeadEditorAny();
    // Canonical router open — stamps /jobs/:id in the URL + history + title
    // and runs the data-aware switchTab→editJob sequence atomically (same
    // path as the jobs-hub row click). The old manual switchTab +
    // setTimeout(editJob) combo raced the nav-state sync and left the URL /
    // title / underlying view stuck on Leads while the job page was showing.
    if (window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate({ top: 'jobs', jobId: l.job_id });
      return;
    }
    // Fallback only if the router isn't present.
    if (typeof window.switchTab === 'function') {
      window.switchTab('jobs');
      // editJob is defined in jobs.js; give the Jobs render a tick before opening
      setTimeout(function() {
        if (typeof window.editJob === 'function') window.editJob(l.job_id);
      }, 200);
    }
  }

  // The lead's estimates, most-recent-edit first (string compare on ISO
  // dates works without parsing). Used by the conversion flow to pick which
  // estimate's bid + workspace carry into the job.
  function _estimatesForLead(leadId) {
    var ests = (window.appData && Array.isArray(window.appData.estimates))
      ? window.appData.estimates.filter(function(e) { return e.lead_id === leadId; })
      : [];
    ests.sort(function(a, b) {
      var av = a.updated_at || a.updatedAt || '';
      var bv = b.updated_at || b.updatedAt || '';
      return String(bv).localeCompare(String(av));
    });
    return ests;
  }

  // Proposal total (the bid) for an estimate, via the shared estimates-list
  // math. Returns 0 if the helper isn't loaded or the estimate has no lines.
  function _estimateProposalTotal(est) {
    try {
      return (est && window.computeEstimateTotals)
        ? (window.computeEstimateTotals(est).proposalTotal || 0) : 0;
    } catch (e) { return 0; }
  }

  // Modal picker for when a lead has >1 estimate. Resolves to the chosen
  // estimate, or null if the user cancels. Each row shows the estimate's
  // proposal total so the user picks by the bid that will seed the contract.
  function _pickEstimate(ests) {
    return new Promise(function(resolve) {
      function esc(s) {
        return String(s == null ? '' : s).replace(/[&<>"]/g, function(ch) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch];
        });
      }
      var ov = document.createElement('div');
      ov.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:99990;display:flex;align-items:center;justify-content:center;padding:20px;';
      var rowsHtml = ests.map(function(e, i) {
        var t = _estimateProposalTotal(e);
        var nm = e.name || e.title || ('Estimate ' + String(e.id).slice(0, 8));
        var when = String(e.updated_at || e.updatedAt || '').slice(0, 10);
        return '<button data-pick="' + i + '" style="display:block;width:100%;text-align:left;margin:6px 0;padding:12px 14px;border:1px solid var(--border,#333);border-radius:8px;background:var(--bg,#0a0a14);color:var(--text,#fff);cursor:pointer;">' +
          '<div style="font-weight:600;">' + esc(nm) + '</div>' +
          '<div style="font-size:12px;color:var(--text-muted,#9aa);margin-top:3px;">$' +
            t.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) +
            (when ? ' · updated ' + when : '') + '</div>' +
          '</button>';
      }).join('');
      var card = document.createElement('div');
      card.style.cssText = 'background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:12px;max-width:520px;width:100%;max-height:80vh;overflow:auto;padding:18px;';
      card.innerHTML =
        '<div style="font-size:15px;font-weight:700;margin-bottom:4px;">Which estimate becomes the job?</div>' +
        '<div style="font-size:12px;color:var(--text-muted,#9aa);margin-bottom:10px;">Its proposal total seeds the job\'s Contract Amount, and its workspace carries over.</div>' +
        rowsHtml +
        '<button data-pick="cancel" style="margin-top:10px;padding:8px 14px;border:1px solid var(--border,#333);border-radius:8px;background:transparent;color:var(--text-muted,#9aa);cursor:pointer;">Cancel</button>';
      ov.appendChild(card);
      ov.addEventListener('click', function(ev) {
        var b = ev.target.closest && ev.target.closest('[data-pick]');
        if (!b && ev.target !== ov) return;  // click inside card, not on a button/backdrop
        var v = b ? b.getAttribute('data-pick') : 'cancel';
        if (ov.parentNode) ov.parentNode.removeChild(ov);
        if (v === 'cancel' || v == null) return resolve(null);
        resolve(ests[Number(v)] || null);
      });
      document.body.appendChild(ov);
    });
  }

  // Fetch a specific estimate's workbook, strip embedded views (the new job
  // auto-injects its own), and stamp each remaining grid sheet with
  // sourceEstimateId/Name so the job-side tab strip shows the "📋 From
  // estimate" chip. Returns { workbook, estimate } on hit, null on miss.
  async function _inheritWorkbookFromEstimate(est) {
    try {
      if (!est || !est.id) return null;
      var resp = await fetch(
        '/api/estimates/' + encodeURIComponent(est.id) + '/workbook',
        { credentials: 'include' }
      );
      if (!resp.ok) return null;
      var json = await resp.json();
      var wb = json && json.workbook;
      if (!wb || !Array.isArray(wb.sheets) || !wb.sheets.length) return null;
      var realSheets = wb.sheets.filter(function(s) {
        return !s.pinned && (!s.kind || s.kind === 'grid');
      });
      if (!realSheets.length) return null;
      var stamped = JSON.parse(JSON.stringify(wb));
      var estName = est.name || est.title || ('Estimate ' + String(est.id).slice(0, 8));
      stamped.sheets = (stamped.sheets || [])
        .filter(function(s) { return !s.pinned && (!s.kind || s.kind === 'grid'); })
        .map(function(s) {
          s.sourceEstimateId = est.id;
          s.sourceEstimateName = estName;
          return s;
        });
      if (!stamped.sheets.find(function(s) { return s.id === stamped.activeSheetId; })) {
        stamped.activeSheetId = stamped.sheets[0] ? stamped.sheets[0].id : null;
      }
      return { workbook: stamped, estimate: est };
    } catch (e) {
      console.warn('[lead-convert] workbook fetch failed for estimate', est && est.id, e && e.message);
      return null;
    }
  }

  // Convert the currently-editing lead into a new job. The chosen estimate's
  // PROPOSAL TOTAL becomes the job's Contract Amount (the real bid), and that
  // estimate's workspace carries over. The whole thing is committed in one
  // atomic server call (POST /api/jobs/convert) that also sets lead.job_id +
  // status='sold' and estimate.data.job_id — so a failure can't leave an
  // orphan job. With >1 estimate the user picks which one.
  async function convertLeadToJob() {
    var leadId = _currentEditingLeadId;
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l) return;
    if (l.job_id) {
      alert('This lead is already linked to a job. Use the Open Job button.');
      return;
    }

    var clientCache = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    var c = l.client_id ? clientCache.find(function(x) { return x.id === l.client_id; }) : null;
    var clientName = c ? (c.company_name || c.name) : '';

    // Choose the estimate whose bid + workspace seed the job.
    var ests = _estimatesForLead(leadId);
    var chosen = null;
    if (ests.length === 1) chosen = ests[0];
    else if (ests.length > 1) {
      chosen = await _pickEstimate(ests);
      if (chosen === null) return;  // user cancelled the picker
    }

    // Contract Amount = chosen estimate's proposal total (the bid). Falls back
    // to the lead's estimated revenue when there's no estimate to base it on.
    var contractAmt = chosen ? _estimateProposalTotal(chosen) : 0;
    if (!contractAmt) contractAmt = Number(l.estimated_revenue_low || 0);

    function money(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    var estLabel = chosen ? (chosen.name || chosen.title || ('Estimate ' + String(chosen.id).slice(0, 8))) : null;
    // Job title = client short name + the proposal (estimate) name it came from.
    var shortName = c ? (c.short_name || c.company_name || c.name || '') : '';
    var proposalName = chosen ? (chosen.name || chosen.title || '') : (l.title || '');
    var suggestedTitle = ((shortName ? shortName + ' ' : '') + proposalName).trim() || (l.title || 'New Job');
    // Require a job number (S#### Service / RV#### Renovation) + confirm the title.
    var _sub = 'New job from this lead. ' +
      (chosen ? ('Contract $' + money(contractAmt) + ' from ' + estLabel + '. ') : ('Contract $' + money(contractAmt) + '. ')) +
      'Marks the lead Sold + links them.';
    var fin = (window.p86JobFinalize && window.p86JobFinalize.open)
      ? await window.p86JobFinalize.open({ title: suggestedTitle, subtitle: _sub })
      : { jobNumber: (prompt('Job number (S#### or RV####):', '') || '').trim().toUpperCase(), title: suggestedTitle };
    if (!fin || !fin.jobNumber) return;  // cancelled / no number

    var me = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
    var ownerId = l.salesperson_id || (me && me.id) || null;
    var jobId = 'j' + Date.now();
    var nowIso = new Date().toISOString();
    var newJob = {
      id: jobId,
      jobNumber: fin.jobNumber,
      title: fin.title || suggestedTitle,
      client: clientName,
      // Carry the client link + address from the lead so the job isn't a shell —
      // Link Client shows "Linked" and the map/weather have an address.
      clientId: l.client_id || null,
      street_address: l.street_address || '',
      city: l.city || '',
      state: l.state || '',
      zip: l.zip || '',
      address: [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', '),
      pm: '',
      owner_id: ownerId,
      jobType: l.project_type || '',
      workType: '',
      market: l.market || '',
      status: 'New',
      contractAmount: contractAmt,
      // Estimate is the source of truth for estimated costs (its base cost).
      estimatedCosts: (chosen && window.computeEstimateTotals ? (window.computeEstimateTotals(chosen).baseCost || 0) : 0),
      targetMarginPct: 50,
      pctComplete: 0,
      invoicedToDate: 0,
      revisedCostChanges: 0,
      notes: l.notes || '',
      // Provenance mirrored in the blob too (server also sets the columns).
      lead_id: l.id || null,
      estimate_id: chosen ? chosen.id : null,
      createdAt: nowIso,
      updatedAt: nowIso
    };

    if (chosen) {
      var inherited = await _inheritWorkbookFromEstimate(chosen);
      if (inherited && inherited.workbook) {
        newJob.workbook = inherited.workbook;
        console.log('[lead-convert] inherited workbook from estimate', chosen.id,
          '—', inherited.workbook.sheets.length, 'sheet(s)');
      }
    }

    // Atomic server-side conversion (job + lead link + estimate link in one tx).
    try {
      var res = await window.p86Api.jobs.convert({
        job: newJob,
        lead_id: l.id,
        estimate_id: chosen ? chosen.id : null
      });
      var newId = (res && (res.job_id || res.id)) || jobId;
      newJob.id = newId;
      // Keep local caches consistent so the immediate editJob() opens cleanly.
      if (window.appData && Array.isArray(window.appData.jobs)) window.appData.jobs.push(newJob);
      l.job_id = newId;
      l.status = 'sold';
      // Mirror the server-side lock + sold-stamp on the local estimate so the
      // editor shows it read-only immediately (no reload needed).
      if (chosen) { chosen.job_id = newId; chosen.is_locked = true; chosen.status = 'sold'; }
      closeLeadEditorAny();
      reloadLeadsCache();
      // Canonical router open (see openLinkedJobFromLead) — the manual
      // switchTab + setTimeout(editJob) combo left the URL on /leads while
      // the new job's page was on screen.
      if (window.p86Router && typeof window.p86Router.navigate === 'function') {
        window.p86Router.navigate({ top: 'jobs', jobId: newId });
      } else {
        if (typeof window.switchTab === 'function') window.switchTab('jobs');
        setTimeout(function() {
          if (typeof window.editJob === 'function') window.editJob(newId);
        }, 250);
      }
    } catch (err) {
      var m = (err && err.message) || '';
      if (/already linked/i.test(m)) {
        alert('This lead is already linked to a job.');
        reloadLeadsCache();
      } else {
        alert('Could not create the job: ' + (m || 'unknown error') + '\n\nNothing was changed — try again.');
      }
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Proposals tab — estimates linked to this lead
  // ──────────────────────────────────────────────────────────────────

  // Currently-open lead id, used by createEstimateFromLead so the prefill
  // can find its source data without re-reading from the form fields.
  var _currentEditingLeadId = null;

  function switchLeadEditorTab(name) {
    document.querySelectorAll('[data-leadeditor-tab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.leadeditorTab === name);
    });
    document.getElementById('leadEditor_tab_general').style.display = (name === 'general') ? '' : 'none';
    document.getElementById('leadEditor_tab_proposals').style.display = (name === 'proposals') ? '' : 'none';
    var photosTab = document.getElementById('leadEditor_tab_photos');
    if (photosTab) photosTab.style.display = (name === 'photos') ? '' : 'none';
    // The footer Save / Delete buttons only make sense on the General tab.
    // On the Proposals / Photos tabs they'd be confusing (those have their
    // own save / delete flows). Hide the footer when one of those is active.
    var footer = document.querySelector('#leadEditorModal .modal-footer');
    if (footer) footer.style.display = (name === 'general') ? '' : 'none';
    // Mount the photos widget on first switch — re-uses the same mount on
    // re-entry since p86Attachments handles its own state internally.
    if (name === 'photos' && _currentEditingLeadId) {
      var mountEl = document.getElementById('leadEditor_photosMount');
      if (mountEl && window.p86Explorer) {
        // Explorer-style files (folders, drag-drop, etc.). Embedded height
        // so it fits inside the lead editor tab.
        window.p86Explorer.mount(mountEl, {
          entityType: 'lead',
          entityId: _currentEditingLeadId,
          canEdit: true,
          embedded: true
        });
      } else if (mountEl && window.p86Attachments) {
        window.p86Attachments.mount(mountEl, {
          entityType: 'lead',
          entityId: _currentEditingLeadId,
          canEdit: true
        });
      }
    }
  }

  function renderLeadProposals(leadId) {
    _currentEditingLeadId = leadId;
    var listEl = document.getElementById('leadEditor_proposalsList');
    var countEl = document.getElementById('leadEditor_proposalsCount');
    if (!listEl) return;
    var estimates = (window.appData && appData.estimates) || [];
    var linked = estimates.filter(function(e) { return e.lead_id === leadId; });
    if (countEl) countEl.textContent = linked.length ? '(' + linked.length + ')' : '';
    if (!linked.length) {
      listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;border:1px dashed var(--border,#333);border-radius:8px;">' +
        'No estimates yet. Click <strong>+ New Estimate from Lead</strong> to draft the first estimate.' +
      '</div>';
      return;
    }
    listEl.innerHTML = linked.map(proposalRowHTML).join('');
  }

  // Shared cost / margin math. Returns { baseCost, clientPrice, margin, lineCount }
  // where margin is the BLENDED markup % across all lines. Reused by:
  //   - proposalRowHTML (full Estimates tab inside the lead editor)
  //   - _compactEstimateRowHTML (right-column compact list)
  // The lookback through section-header markup + estimate.defaultMarkup
  // fallback mirrors how the estimate editor itself computes blended
  // markup so this view stays consistent with the editor's reality.
  function _computeEstimateCostMargin(est) {
    // Delegate to the canonical computeEstimateTotals in estimates.js
    // so the lead-side row matches the estimate-editor totals exactly
    // (alternates inclusion + target-margin override + fees + tax +
    // rounding). The old standalone math here didn't honor any of
    // that, so the right-rail card on the lead drifted from what the
    // user saw inside the estimate.
    if (typeof window.computeEstimateTotals === 'function') {
      var t = window.computeEstimateTotals(est);
      return {
        baseCost: t.baseCost,
        clientPrice: t.clientPrice,     // proposal total (incl. fees + tax + round)
        // The label on the panel says "Markup" — match the editor's
        // blended markup % rather than the gross-margin %.
        margin: t.blendedMarkup,
        lineCount: t.lineCount
      };
    }
    // Defensive fallback for the unlikely case estimates.js failed to
    // load (e.g. CSP block) — uses a stripped-down line walk.
    var lines = ((window.appData && appData.estimateLines) || []).filter(function(l) { return l.estimateId === est.id; });
    var baseCost = 0, markedUp = 0;
    lines.forEach(function(l) {
      if (l.section === '__section_header__') return;
      var ext = (Number(l.qty) || 0) * (Number(l.unitCost) || 0);
      baseCost += ext;
      var m = (l.markup === '' || l.markup == null) ? null : Number(l.markup);
      if (m == null && est.defaultMarkup != null && est.defaultMarkup !== '') m = Number(est.defaultMarkup);
      if (m == null) m = 0;
      markedUp += ext * (1 + m / 100);
    });
    return {
      baseCost: baseCost,
      clientPrice: markedUp,
      margin: baseCost > 0 ? (markedUp / baseCost - 1) * 100 : 0,
      lineCount: lines.filter(function(l) { return l.section !== '__section_header__'; }).length
    };
  }

  function proposalRowHTML(est) {
    var calc = _computeEstimateCostMargin(est);
    return '<div class="card" style="padding:12px 14px;display:flex;justify-content:space-between;align-items:center;gap:12px;">' +
      '<div style="min-width:0;flex:1;">' +
        '<div style="font-weight:600;font-size:13px;color:var(--text,#fff);">' + escapeHTML(est.title || 'Untitled estimate') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;">' +
          'Base ' + fmtCurrencyShort(calc.baseCost) +
          ' · Markup ' + calc.margin.toFixed(1) + '%' +
          ' · Client ' + fmtCurrencyShort(calc.clientPrice) +
          ' · ' + calc.lineCount + ' line' + (calc.lineCount === 1 ? '' : 's') +
        '</div>' +
      '</div>' +
      '<div style="display:flex;gap:6px;flex-shrink:0;">' +
        '<button class="ee-btn secondary" onclick="openEstimateFromLead(\'' + escapeAttr(est.id) + '\', false);">Edit</button>' +
        '<button class="ee-btn secondary" onclick="openEstimateFromLead(\'' + escapeAttr(est.id) + '\', true);">Preview</button>' +
      '</div>' +
    '</div>';
  }

  // Compact-row version used in the right-column Estimates panel. Same
  // calc as proposalRowHTML but flatter layout: title + date on one
  // line, cost/price/margin on a second compact line. Click anywhere
  // on the row opens the estimate (no separate Edit/Preview buttons —
  // the full tab still has those).
  function _compactEstimateRowHTML(est) {
    var calc = _computeEstimateCostMargin(est);
    var created = est.created_at ? new Date(est.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : '';
    return '<div onclick="openEstimateFromLead(\'' + escapeAttr(est.id) + '\', false);" ' +
      'style="cursor:pointer;padding:8px 10px;border:1px solid var(--border,#333);border-radius:6px;margin-bottom:6px;background:rgba(255,255,255,0.02);transition:border-color 0.12s, background 0.12s;" ' +
      'onmouseover="this.style.borderColor=\'rgba(79,140,255,0.5)\';this.style.background=\'rgba(79,140,255,0.04)\';" ' +
      'onmouseout="this.style.borderColor=\'var(--border,#333)\';this.style.background=\'rgba(255,255,255,0.02)\';">' +
      '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;">' +
        '<div style="font-weight:600;font-size:12.5px;color:var(--text,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1;min-width:0;">' + escapeHTML(est.title || '(untitled)') + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);white-space:nowrap;">' + escapeHTML(created) + '</div>' +
      '</div>' +
      '<div style="display:flex;gap:10px;margin-top:4px;font-size:10.5px;color:var(--text-dim,#aaa);">' +
        '<span>Cost <strong style="color:var(--text,#fff);">' + fmtCurrencyShort(calc.baseCost) + '</strong></span>' +
        '<span>Price <strong style="color:#34d399;">' + fmtCurrencyShort(calc.clientPrice) + '</strong></span>' +
        '<span>Margin <strong style="color:#4f8cff;">' + calc.margin.toFixed(1) + '%</strong></span>' +
      '</div>' +
    '</div>';
  }

  // Compact list for the right-column Estimates panel. Sorted newest
  // first by created_at; ties break on est.id so the sort is stable.
  function renderLeadEstimatesCompact(leadId) {
    var host = document.getElementById('leadEditor_estimatesHost');
    if (!host) return;
    if (!leadId) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">Save the lead first to draft estimates.</div>';
      return;
    }
    var estimates = (window.appData && appData.estimates) || [];
    var linked = estimates.filter(function(e) { return e.lead_id === leadId; });
    if (!linked.length) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:8px 0;">No estimates yet. Use the Estimates tab to draft one.</div>';
      return;
    }
    linked.sort(function(a, b) {
      var ta = a.created_at ? new Date(a.created_at).getTime() : 0;
      var tb = b.created_at ? new Date(b.created_at).getTime() : 0;
      if (tb !== ta) return tb - ta;  // newest first
      return String(b.id || '').localeCompare(String(a.id || ''));  // stable tiebreak
    });
    host.innerHTML = linked.map(_compactEstimateRowHTML).join('');
  }

  // Navigate from the lead-editor's Estimates tab into the actual
  // estimate editor (or preview). The estimate views live inside the
  // Estimates top-tab → Estimates sub-tab, so we have to:
  //   1. Close the lead modal,
  //   2. Switch the top tab to "estimates" (the user is currently on
  //      the Leads sub-tab so the Estimates tab content is hidden),
  //   3. Switch the Estimates page to its "list" sub-tab so
  //      #estimate-editor-view is in the visible flow,
  //   4. Open the editor or preview.
  // Earlier the navigation skipped steps 2-3, so editEstimate ran but
  // its target view stayed hidden behind the sub-tab gate — clicking
  // Edit looked like a no-op.
  function openEstimateFromLead(estimateId, asPreview) {
    // Capture the originating lead id BEFORE closeLeadEditorAny clears
    // the module's _currentEditingLeadId — the editor uses it to wire
    // up a "Back to lead" return path on close.
    var leadId = _currentEditingLeadId;
    closeLeadEditorAny();
    if (typeof window.switchTab === 'function') {
      try { window.switchTab('estimates'); } catch (e) { /* defensive */ }
    }
    if (typeof window.switchEstimatesSubTab === 'function') {
      try { window.switchEstimatesSubTab('list'); } catch (e) { /* defensive */ }
    }
    if (leadId && window.estimateEditorAPI &&
        typeof window.estimateEditorAPI.setReturnToLead === 'function') {
      window.estimateEditorAPI.setReturnToLead(leadId);
    }
    if (asPreview) {
      if (typeof window.previewEstimate === 'function') window.previewEstimate(estimateId);
    } else {
      if (typeof window.editEstimate === 'function') window.editEstimate(estimateId);
    }
  }
  window.openEstimateFromLead = openEstimateFromLead;

  // Show the "From lead" banner above the client picker on the New
  // Estimate modal. Hidden by default; opened only when the modal was
  // launched via createEstimateFromLead.
  function showLeadPrefillBanner(lead) {
    var banner = document.getElementById('estLeadPrefillBanner');
    var label = document.getElementById('estLeadPrefillLabel');
    if (!banner) return;
    if (label) label.textContent = lead && lead.title ? lead.title : 'lead';
    banner.style.display = 'flex';
  }
  function hideLeadPrefillBanner() {
    var banner = document.getElementById('estLeadPrefillBanner');
    if (banner) banner.style.display = 'none';
  }
  // Single source of truth for lead → estimate-form prefill. Used by
  // both the initial open path (createEstimateFromLead) and the
  // "Copy from lead" recovery button. Always re-resolves the client
  // from the live cache so a fix to the lead-client link, or a
  // late-arriving cache load, picks up on the second click.
  //
  // Falls back to the lead's OWN fields when no client record is
  // available — leads carry `client_company`, `client_name`, and
  // `property_name` even when they aren't yet linked to a client
  // directory entry. Earlier versions left those fields blank in
  // that case, which is the bug the user was seeing.
  function applyLeadPrefill(l) {
    if (!l) return;
    function set(id, v) {
      var el = document.getElementById(id);
      if (el && v != null) el.value = v;
    }
    // Resolve client fresh on every call. cache may have been empty
    // the first time, or the link may have been added since.
    var clientCache = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    var c = l.client_id ? clientCache.find(function(x) { return x.id === l.client_id; }) : null;

    set('estTitle', l.title || '');
    set('estJobType', l.project_type || '');
    set('estLeadId', l.id);
    set('estClientId', l.client_id || '');

    // Client company — prefer linked client record, fall back to the
    // lead's own company-name fields. `client_company` is the typed
    // input; `client_name` is sometimes the contact name and sometimes
    // the company depending on lead source — try both.
    set('estClient',
      (c && (c.company_name || c.name)) ||
      l.client_company || l.client_name || '');
    // Community / property — prefer client.community_name, then the
    // lead's property_name (the explicit "which community" field).
    set('estCommunity',
      (c && (c.community_name || c.name)) ||
      l.property_name || '');

    if (c) {
      // Billing address is the management company's mailing address —
      // always pulled from the client record, never the lead.
      var bAddr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      set('estBillingAddr', bAddr);
      set('estManagerName', c.community_manager || '');
      set('estManagerEmail', c.cm_email || c.email || '');
      set('estManagerPhone', c.cm_phone || c.phone || c.cell || '');
      if (typeof window.populateEstimateClientPicker === 'function') {
        window.populateEstimateClientPicker('estClientPicker', c.id);
      } else {
        var picker = document.getElementById('estClientPicker');
        if (picker) picker.value = c.id;
      }
    }
    // No `else` branch: leads don't currently store manager email /
    // phone separately from a client record, so we leave those blank
    // for the user to fill rather than guessing.

    // Property (job-site) address: the lead is the authoritative source
    // because it points at a specific opportunity. Pull street+city+
    // state+zip from the lead first; only fall back to the client's
    // mailing address when the lead has nothing.
    var hasLeadAddrParts = l.street_address || l.city || l.state || l.zip;
    var pAddr;
    if (hasLeadAddrParts) {
      pAddr = [l.street_address, l.city, l.state, l.zip].filter(Boolean).join(', ');
    } else if (c) {
      pAddr = [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
    } else {
      pAddr = '';
    }
    if (pAddr) set('estPropertyAddr', pAddr);

    // Refresh the stash so the banner + button stay accurate even if
    // we reached this path via copyFromLeadAgain instead of the
    // initial open.
    window._estimateLeadPrefillSource = { lead: l, client: c || null };
  }

  // Re-run the lead prefill — callable from the Copy-from-lead button.
  // Reads the lead snapshot stashed by createEstimateFromLead and
  // re-resolves the client live so any cache fix takes effect.
  window.copyFromLeadAgain = function() {
    var src = window._estimateLeadPrefillSource;
    if (!src || !src.lead) {
      alert('No lead context available — open this estimate from a lead to copy.');
      return;
    }
    applyLeadPrefill(src.lead);
  };

  // Pre-fill the New Estimate form from the currently-editing lead, then
  // open it. The estimate save path (createNewEstimate) reads the hidden
  // estLeadId / estClientId fields to persist the link. Delegates to
  // the shared applyLeadPrefill helper so the initial open and the
  // "Copy from lead" button always behave identically.
  function createEstimateFromLead() {
    var leadId = _currentEditingLeadId;
    if (!leadId) { alert('Save the lead first.'); return; }
    var l = _leads.find(function(x) { return x.id === leadId; });
    if (!l) { alert('Lead not found.'); return; }

    closeLeadEditorAny();
    if (typeof window.openNewEstimateForm !== 'function') {
      alert('Estimate form not available.');
      return;
    }
    window.openNewEstimateForm();
    applyLeadPrefill(l);
    showLeadPrefillBanner(l);
  }

  function submitLeadEditor() {
    var statusEl = document.getElementById('leadEditor_status_msg');
    var btn = document.getElementById('leadEditor_submitBtn');
    var id = document.getElementById('leadEditor_id').value;
    var payload = {};
    EDITABLE_FIELDS.forEach(function(f) {
      var v = getField(f);
      payload[f] = v === '' ? null : v;
    });
    payload.title = (payload.title || '').trim();

    // A Places-picked address carries exact coords — save them so the lead map
    // + Site Plan satellite render immediately (the server skips re-geocoding).
    if (_pickedGeo && _pickedGeo.lat != null && _pickedGeo.lng != null) {
      payload.geocode_lat = _pickedGeo.lat;
      payload.geocode_lng = _pickedGeo.lng;
    }

    if (!payload.title) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Title is required.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    var p = id
      ? window.p86Api.leads.update(id, payload)
      : window.p86Api.leads.create(payload);

    p.then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      setTimeout(function() {
        closeLeadEditorAny();
        reloadLeadsCache();
      }, 600);
    }).catch(function(err) {
      btn.disabled = false;
      statusEl.style.color = '#e74c3c';
      statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
  }

  function deleteLeadFromEditor() {
    var id = document.getElementById('leadEditor_id').value;
    if (!id) return;
    var l = _leads.find(function(x) { return x.id === id; });

    // Estimates created from this lead carry lead_id === id. They have no
    // standalone meaning once the lead is gone, so delete them as part of
    // the same action. Surface the count up front so the user can back out.
    var linkedEstimates = (window.appData && window.appData.estimates || [])
      .filter(function(e) { return e.lead_id === id; });

    var msg = 'Delete lead "' + (l ? l.title : id) + '"? This cannot be undone.';
    if (linkedEstimates.length) {
      msg += '\n\nThis will also delete ' + linkedEstimates.length + ' linked estimate' +
             (linkedEstimates.length === 1 ? '' : 's') + ':\n  - ' +
             linkedEstimates.map(function(e) { return e.title || '(untitled)'; }).join('\n  - ');
    }
    if (!confirm(msg)) return;

    // Delete the linked estimates in parallel first; if any fail, abort the
    // lead delete so the cache stays consistent. 404s are treated as success
    // since the row is already gone server-side.
    var estimatePromises = linkedEstimates.map(function(e) {
      return window.p86Api.estimates.remove(e.id).catch(function(err) {
        if (err && err.status === 404) return; // already gone, fine
        throw err;
      });
    });

    Promise.all(estimatePromises).then(function() {
      // Drop from local appData so the estimates list updates without a reload
      if (window.appData && linkedEstimates.length) {
        var deletedIds = {};
        linkedEstimates.forEach(function(e) { deletedIds[e.id] = true; });
        window.appData.estimates = window.appData.estimates.filter(function(e) { return !deletedIds[e.id]; });
        window.appData.estimateLines = (window.appData.estimateLines || []).filter(function(line) { return !deletedIds[line.estimateId]; });
        if (typeof saveData === 'function') saveData();
        if (typeof renderEstimatesList === 'function') renderEstimatesList();
      }
      return window.p86Api.leads.remove(id);
    }).then(function() {
      closeLeadEditorAny();
      reloadLeadsCache();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown error') +
            (linkedEstimates.length ? '\n\nSome linked estimates may have been deleted before the failure. Refresh to check.' : ''));
    });
  }

  // ==================== BT LEADS IMPORT ====================
  // Parses a Buildertrend Leads xlsx export (the "Leads (exported on ...)"
  // file from BT) and POSTs the normalized rows to /api/leads/import. The
  // BT export header is on row 2 (row 1 is the export-date title), so we
  // skip the first row when extracting cells.

  // BT lead status -> our status enum. Anything not listed maps to 'new'.
  var BT_STATUS_MAP = {
    'pending': 'in_progress',
    'open': 'new',
    'new': 'new',
    'sent': 'sent',
    'sold': 'sold',
    'lost': 'lost',
    'no opportunity': 'no_opportunity',
    'closed': 'no_opportunity'
  };

  function mapBTStatus(s) {
    if (!s) return 'new';
    var k = String(s).trim().toLowerCase();
    return BT_STATUS_MAP[k] || 'new';
  }

  // Parse a "$1,234.56" string into a Number, or null. Empty / non-numeric
  // values become null so the server treats the column as unset rather
  // than zero (zero would be a confusing "we estimated $0 revenue").
  function parseMoney(v) {
    if (v == null || v === '') return null;
    var s = String(v).replace(/[\$,\s]/g, '');
    if (!s) return null;
    var n = parseFloat(s);
    return isNaN(n) ? null : n;
  }

  function parseConfidence(v) {
    if (v == null || v === '') return null;
    var s = String(v).replace(/[%\s]/g, '');
    var n = parseInt(s, 10);
    return isNaN(n) ? null : Math.max(0, Math.min(100, n));
  }

  // BT writes dates as "M-D-YYYY" or "M/D/YYYY". Postgres accepts ISO so
  // normalize to YYYY-MM-DD. Return null if unparsable.
  function parseDate(v) {
    if (!v) return null;
    var s = String(v).trim();
    var m = s.match(/^(\d{1,2})[-/](\d{1,2})[-/](\d{2,4})$/);
    if (!m) return null;
    var mm = m[1].padStart(2, '0');
    var dd = m[2].padStart(2, '0');
    var yyyy = m[3].length === 2 ? '20' + m[3] : m[3];
    return yyyy + '-' + mm + '-' + dd;
  }

  function parseBTLeadsWorkbook(arrayBuf) {
    if (typeof XLSX === 'undefined') throw new Error('XLSX library not loaded');
    var data = new Uint8Array(arrayBuf);
    var wb = XLSX.read(data, { type: 'array' });
    var sheet = wb.Sheets[wb.SheetNames[0]];
    var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
    if (!aoa.length) return [];

    // Row 0 is the export title ("Leads (exported on ...)"); row 1 is the
    // header row with column names. Find the header row defensively in case
    // BT shifts the layout — we look for "Opportunity Title" within the
    // first three rows.
    var headerRowIdx = -1;
    for (var i = 0; i < Math.min(3, aoa.length); i++) {
      var rr = aoa[i] || [];
      for (var c = 0; c < rr.length; c++) {
        if (String(rr[c] || '').trim().toLowerCase() === 'opportunity title') {
          headerRowIdx = i;
          break;
        }
      }
      if (headerRowIdx >= 0) break;
    }
    if (headerRowIdx < 0) throw new Error('Could not find header row (no "Opportunity Title" column).');

    var headers = (aoa[headerRowIdx] || []).map(function(h) { return String(h || '').trim(); });
    var idx = {};
    headers.forEach(function(h, i) { idx[h] = i; });

    function cell(row, name) {
      var i = idx[name];
      if (i == null) return '';
      var v = row[i];
      return v == null ? '' : String(v).trim();
    }

    var rows = [];
    for (var r = headerRowIdx + 1; r < aoa.length; r++) {
      var row = aoa[r];
      if (!row || !row.length) continue;
      var title = cell(row, 'Opportunity Title');
      if (!title) continue; // blank row
      // Address: prefer the Opportunity address columns; fall back to
      // Contact when Opp is blank (some BT rows fill only Contact).
      var street = cell(row, 'Street Address(Opp)') || cell(row, 'Street Address (Contact)');
      var city = cell(row, 'City(Opp)') || cell(row, 'City (Contact)');
      var state = cell(row, 'State(Opp)') || cell(row, 'State (Contact)');
      var zip = cell(row, 'Zip(Opp)') || cell(row, 'Zip (Contact)');

      rows.push({
        title: title,
        client_name: cell(row, 'Client Contact'), // resolved server-side
        status: mapBTStatus(cell(row, 'Lead Status')),
        confidence: parseConfidence(cell(row, 'Confidence')),
        estimated_revenue_low: parseMoney(cell(row, 'Estimated Revenue Min')),
        estimated_revenue_high: parseMoney(cell(row, 'Estimated Revenue Max')) || parseMoney(cell(row, 'Estimated Revenue')),
        projected_sale_date: parseDate(cell(row, 'Projected Sales Date')),
        source: cell(row, 'Source'),
        project_type: cell(row, 'Project Type'),
        street_address: street,
        city: city,
        state: state,
        zip: zip,
        gate_code: cell(row, 'Gate Code (if applicable)*') || cell(row, 'Gate Code'),
        market: cell(row, 'Market*') || cell(row, 'Market'),
        notes: cell(row, 'Notes')
      });
    }
    return rows;
  }

  function handleLeadsImportFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    evt.target.value = ''; // reset so re-picking the same file fires onchange

    var reader = new FileReader();
    reader.onload = function(e) {
      var rows;
      try {
        rows = parseBTLeadsWorkbook(e.target.result);
      } catch (err) {
        alert('Could not parse file: ' + err.message);
        return;
      }
      if (!rows.length) {
        alert('No lead rows found in that file. Is it the right export?');
        return;
      }
      if (!confirm('Found ' + rows.length + ' lead row(s). Import them now?\n\n' +
                   'Existing leads (matched by title, case-insensitive) will be skipped. ' +
                   'Clients are matched by name against the directory; unmatched leads import without a client link.')) {
        return;
      }
      window.p86Api.leads.importBatch(rows).then(function(res) {
        renderLeadsImportResult(res);
        reloadLeadsCache();
      }).catch(function(err) {
        alert('Import failed: ' + (err.message || 'unknown error'));
      });
    };
    reader.onerror = function() { alert('Could not read the file.'); };
    reader.readAsArrayBuffer(file);
  }

  // Reuses the same client-import result modal layout. We swap the title and
  // body in place so we don't have to copy a second modal into index.html.
  function renderLeadsImportResult(res) {
    var modal = document.getElementById('clientImportResultModal');
    var titleEl = document.getElementById('clientImportResult_title');
    var body = document.getElementById('clientImportResult_body');
    if (!modal || !body) {
      alert('Imported ' + (res.inserted || 0) + ' lead(s); skipped ' + (res.skipped || 0) + ' duplicate(s).');
      return;
    }
    if (titleEl) titleEl.textContent = 'Lead Import Result';
    var html = '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
      statBlock('New leads', res.inserted || 0, '#34d399') +
      statBlock('Skipped (duplicate title)', res.skipped || 0, '#fbbf24') +
      statBlock('Errors', (res.errors || []).length, '#f87171') +
      statBlock('Total rows', res.total || 0, 'var(--text-dim,#888)') +
    '</div>';
    var errs = res.errors || [];
    if (errs.length) {
      html += '<div style="font-size:12px;color:#f87171;margin-bottom:6px;font-weight:600;">' + errs.length + ' row(s) had errors:</div>';
      html += '<div style="max-height:160px;overflow-y:auto;font-size:11px;font-family:monospace;background:rgba(248,113,113,0.05);border:1px solid rgba(248,113,113,0.2);border-radius:6px;padding:8px;">';
      errs.slice(0, 50).forEach(function(e) {
        html += '<div>Row ' + e.row + (e.title ? ' (' + escapeHTML(e.title) + ')' : '') + ': ' + escapeHTML(e.error) + '</div>';
      });
      if (errs.length > 50) html += '<div style="color:var(--text-dim,#888);">…and ' + (errs.length - 50) + ' more</div>';
      html += '</div>';
    }
    body.innerHTML = html;
    openModal('clientImportResultModal');
  }

  function statBlock(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '</div>';
  }

  // ──────────────────────────────────────────────────────────────────
  // Build-from-PDF drop flow on the New Lead modal. User drops a
  // Buildertrend "Lead Print" PDF; we render pages client-side via
  // PDF.js → POST images to /api/ai/extract-lead → prefill the form
  // fields with the structured response. User reviews and saves
  // normally (saves go through the existing submitLeadEditor flow).
  // ──────────────────────────────────────────────────────────────────
  var _pdfDropWired = false;

  function wirePdfDropOnce() {
    if (_pdfDropWired) return;
    var dropZone = document.getElementById('leadEditor_pdfDrop');
    var fileInput = document.getElementById('leadEditor_pdfFile');
    if (!dropZone || !fileInput) return;
    dropZone.onclick = function(e) {
      if (e.target !== fileInput) fileInput.click();
    };
    dropZone.ondragover = function(e) {
      e.preventDefault();
      dropZone.style.borderColor = '#8b5cf6';
      dropZone.style.background = 'rgba(139,92,246,0.12)';
    };
    dropZone.ondragleave = function() {
      dropZone.style.borderColor = '';
      dropZone.style.background = '';
    };
    dropZone.ondrop = function(e) {
      e.preventDefault();
      dropZone.style.borderColor = '';
      dropZone.style.background = '';
      if (e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]) {
        handlePdfDrop(e.dataTransfer.files[0]);
      }
    };
    fileInput.onchange = function() {
      if (fileInput.files && fileInput.files[0]) handlePdfDrop(fileInput.files[0]);
      fileInput.value = '';
    };
    _pdfDropWired = true;
  }

  function setPdfStatus(message, color) {
    var s = document.getElementById('leadEditor_pdfDropStatus');
    if (!s) return;
    s.style.display = '';
    s.textContent = message;
    s.style.color = color || '#c4b5fd';
  }

  function handlePdfDrop(file) {
    if (!file) return;
    var name = (file.name || '').toLowerCase();
    if (file.type !== 'application/pdf' && !name.endsWith('.pdf')) {
      setPdfStatus('Not a PDF — drop a Buildertrend Lead Print.', '#f87171');
      return;
    }
    if (!window.pdfjsLib) {
      setPdfStatus('PDF library not loaded — refresh the page.', '#f87171');
      return;
    }

    setPdfStatus('Reading PDF…');
    var reader = new FileReader();
    reader.onload = function(e) {
      var typedArray = new Uint8Array(e.target.result);
      window.pdfjsLib.getDocument({ data: typedArray }).promise.then(function(pdf) {
        return renderPdfPagesToBase64(pdf);
      }).then(function(images) {
        setPdfStatus('Extracting fields with AI… (' + images.length + ' page' + (images.length === 1 ? '' : 's') + ')');
        return window.p86Api.ai.extractLead(images);
      }).then(function(res) {
        if (!res || !res.lead) throw new Error('Empty response from AI.');
        prefillFromExtractedLead(res.lead);
        setPdfStatus('✓ Fields prefilled from PDF — review and save below.', '#34d399');
      }).catch(function(err) {
        console.error('PDF extraction failed:', err);
        setPdfStatus('Extraction failed: ' + (err.message || err), '#f87171');
      });
    };
    reader.onerror = function() {
      setPdfStatus('Could not read the file.', '#f87171');
    };
    reader.readAsArrayBuffer(file);
  }

  // Render every page of the loaded PDF to a base64 JPEG. Capped at 6
  // since lead prints are usually 1-2 pages and we want to leave room
  // under Anthropic's per-request image limit.
  function renderPdfPagesToBase64(pdf) {
    var max = Math.min(pdf.numPages, 6);
    var chain = Promise.resolve();
    var images = [];
    for (var i = 1; i <= max; i++) {
      (function(pageNum) {
        chain = chain.then(function() {
          return pdf.getPage(pageNum).then(function(page) {
            var viewport = page.getViewport({ scale: 1.5 });
            var canvas = document.createElement('canvas');
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            return page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport }).promise.then(function() {
              var dataUrl = canvas.toDataURL('image/jpeg', 0.82);
              images.push(dataUrl);
            });
          });
        });
      })(i);
    }
    return chain.then(function() { return images; });
  }

  // Take the AI's structured response and stuff each field into the
  // form. We map the response keys to the form-field IDs the existing
  // submitLeadEditor / save flow already uses, so the user can just
  // hit Save to commit.
  function prefillFromExtractedLead(lead) {
    if (!lead) return;
    if (lead.title) setField('title', lead.title);
    if (lead.status) setField('status', lead.status);
    // Estimated revenue: Project 86-side only uses the min/low value — display
    // a single number on our forms. The schema asks for both, but we
    // ignore the high.
    if (lead.estimated_revenue_low) setField('estimated_revenue_low', lead.estimated_revenue_low);
    if (lead.confidence_pct != null) setField('confidence', lead.confidence_pct);
    if (lead.project_type) setField('project_type', lead.project_type);
    if (lead.market) setField('market', lead.market);
    if (lead.gate_code) setField('gate_code', lead.gate_code);
    if (lead.notes) setField('notes', lead.notes);
    if (lead.property_name) setField('property_name', lead.property_name);
    // Property/job-site address goes onto the lead's address fields
    if (lead.property_address) setField('street_address', lead.property_address);
    if (lead.property_city) setField('city', lead.property_city);
    if (lead.property_state) setField('state', lead.property_state);
    if (lead.property_zip) setField('zip', lead.property_zip);

    // Auto-link a client from the directory cache. Multi-tier match
    // because PAC's directory has dozens of children ("PAC - Solace
    // Timacuan", "PAC - Alyssa Barber", etc.) — a naive substring
    // search on the parent name "PAC" picked the first child it
    // found, which is wrong. Priority order:
    //   1. Exact full-name match ("PAC - Solace Timacuan")
    //   2. Property-side match — when the PDF gave both halves,
    //      look for a client whose community_name (or name suffix)
    //      matches the property side AND whose parent / company
    //      matches the company side
    //   3. Substring fallback ONLY if it produces a UNIQUE match.
    //      Multiple matches → leave unset; user picks manually.
    if (lead.client_company || lead.client_property) {
      var clients = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
      var company = String(lead.client_company || '').trim();
      var property = String(lead.client_property || '').trim();
      var lowerCompany = company.toLowerCase();
      var lowerProperty = property.toLowerCase();
      var fullNeedle = (company && property)
        ? (company + ' - ' + property).toLowerCase()
        : (company || property).toLowerCase();

      // Tier 1 — exact full-name match. Catches the canonical
      // "PAC - Solace Timacuan" case directly.
      var match = clients.find(function(c) {
        return (c.name || '').toLowerCase() === fullNeedle;
      });

      // Tier 2 — property-name match within the right parent. Looks
      // at community_name AND the suffix after " - " in the client
      // name. Only fires when the AI extracted both halves.
      if (!match && property) {
        match = clients.find(function(c) {
          var cn = (c.community_name || '').toLowerCase();
          var nm = (c.name || '').toLowerCase();
          var dashIdx = nm.indexOf(' - ');
          var nameSuffix = dashIdx >= 0 ? nm.slice(dashIdx + 3) : '';
          var propMatches = (cn && cn === lowerProperty) || (nameSuffix && nameSuffix === lowerProperty);
          if (!propMatches) return false;
          if (!company) return true; // no parent to filter against
          var co = (c.company_name || '').toLowerCase();
          var nameStart = dashIdx >= 0 ? nm.slice(0, dashIdx) : nm;
          return co === lowerCompany || nameStart === lowerCompany ||
                 co.indexOf(lowerCompany) >= 0 || nameStart.indexOf(lowerCompany) >= 0;
        });
      }

      // Tier 3 — substring fallback. Require uniqueness so we don't
      // arbitrarily pick the first of N matches. This is the path
      // the old buggy code took without the uniqueness check.
      if (!match && fullNeedle && fullNeedle.length >= 3) {
        var hits = clients.filter(function(c) {
          var nm = (c.name || '').toLowerCase();
          var co = (c.company_name || '').toLowerCase();
          return nm.indexOf(fullNeedle) >= 0 || co.indexOf(fullNeedle) >= 0;
        });
        if (hits.length === 1) match = hits[0];
        // Multiple ambiguous hits → leave the picker empty so the
        // user resolves it. Logging the count helps debugging without
        // adding more UI noise.
        else if (hits.length > 1) {
          try { console.info('[leads] ambiguous client match for "' + fullNeedle + '" — ' + hits.length + ' candidates; leaving picker empty for user to choose'); } catch (e) {}
        }
      }

      if (match) {
        var sel = document.getElementById('leadEditor_client_id');
        if (sel) {
          sel.value = match.id;
          // Force a change event so the searchable picker widget refreshes
          // its trigger label and the existing onLeadClientPicked() handler
          // runs through to fill the address fields from the matched client.
          try { sel.dispatchEvent(new Event('change', { bubbles: true })); } catch (e) { /* ignore old browsers */ }
        }
      }
    }
  }

  window.renderLeadsList = renderLeadsList;
  window.sortLeadsBy = sortLeads;
  window.reloadLeadsCache = reloadLeadsCache;
  // Hook used by the Lead Intake AI panel to refresh the list after
  // propose_create_lead lands. Just calls reloadLeadsCache, which
  // re-fetches from the server and re-renders.
  window.refreshLeadsAfterAI = function() {
    try { reloadLeadsCache(); } catch (e) { /* defensive */ }
  };
  window.openNewLeadModal = openNewLeadModal;
  window.openEditLeadModal = openEditLeadModal;
  window.submitLeadEditor = submitLeadEditor;
  window.deleteLeadFromEditor = deleteLeadFromEditor;
  window.onLeadClientPicked = onLeadClientPicked;
  window.switchLeadEditorTab = switchLeadEditorTab;
  window.createEstimateFromLead = createEstimateFromLead;
  window.convertLeadToJob = convertLeadToJob;
  window.openLinkedJobFromLead = openLinkedJobFromLead;
  // Reused by the estimate-side "Create Job" (estimate-editor.js) so both
  // entry points snapshot an estimate's workspace the same way.
  window.p86InheritWorkbookFromEstimate = _inheritWorkbookFromEstimate;
  window.handleLeadsImportFile = handleLeadsImportFile;
  window.p86Leads = {
    getCached: function() { return _leads.slice(); },
    getOpenId: function() { return _currentEditingLeadId; },
    reload: reloadLeadsCache,
    // Push a single fetched lead into the cache. Used by the estimate
    // editor's chip when it has to fetch by id (lead wasn't loaded
    // yet). Replaces an existing entry by id, or appends.
    cacheLead: function(lead) {
      if (!lead || !lead.id) return;
      var idx = _leads.findIndex(function(x) { return x.id === lead.id; });
      if (idx >= 0) _leads[idx] = lead;
      else _leads.push(lead);
    }
  };
})();
