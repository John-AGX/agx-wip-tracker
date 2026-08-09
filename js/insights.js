// Project 86 Insights — LIVE company WIP dashboard + Reports.
//
// Reworked 2026-08-09 (John "make Insights live, filterable, with reports"):
// dropped the client-snapshot model entirely. Insights is now 100% LIVE
// current-state computed from appData.jobs via getJobWIP() — no dailySnapshots
// / weeklySnapshots reads, no `liveStatus === 'live'` gate, no 3 AM capture.
// Every active (non-Archived) job counts. The page is:
//   • scoped by the global market switcher (window.p86MarketFilter)
//   • filterable via the shared p86FilterDrawer (market / job type / status /
//     city / state / contract$ / margin%) with a Group-by (market/type/status)
//   • two views: a live Dashboard (KPI ribbon + breakdown + per-job strip) and
//     a Reports section whose first report is the WIP Schedule (CSV export;
//     Excel/PDF + the other reports land in later slices).
(function () {
  'use strict';

  var esc = window.escapeHTML || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }

  // ── Formatters ───────────────────────────────────────────────────────
  function fmtCurrency(v) {
    if (v == null || isNaN(v)) return '$0';
    var abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(v).toLocaleString();
  }
  function fmtBig(v) {
    if (v == null || isNaN(v)) return '$0';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
  }
  function fmtMoney(v) {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num(v));
  }
  function fmtPct(v, d) { if (v == null || isNaN(v)) return '0%'; return v.toFixed(d == null ? 1 : d) + '%'; }

  // ── Module state ─────────────────────────────────────────────────────
  var _view = 'dashboard';   // 'dashboard' | 'reports'
  var _report = 'wip';       // active report id (reports view)
  var _drawer = null;        // filter drawer values (null = no filter)
  var _groupBy = 'none';     // none | market | jobType | status

  // ── Job selection (the ONE live source) ──────────────────────────────
  // Market-scoped (honors the global switcher) + non-archived. Everything
  // — KPIs, breakdowns, reports — reads from here.
  function baseJobs() {
    var all = (window.appData && appData.jobs) || [];
    var scoped = window.p86MarketFilter ? window.p86MarketFilter(all) : all;
    return (scoped || []).filter(function (j) { return j && j.status !== 'Archived'; });
  }
  function filteredJobs() {
    var jobs = baseJobs();
    if (_drawer) jobs = jobs.filter(function (j) { return insMatch(j, _drawer); });
    return jobs;
  }

  function jobTypeLabel(j) {
    if (j.jobType) return j.jobType;
    // Legacy fallback from the job-number prefix (mirrors js/jobs.js).
    var n = String(j.jobNumber || '').toUpperCase();
    if (/^RV/.test(n)) return 'Renovation';
    if (/^WO/.test(n)) return 'Work Order';
    if (/^S/.test(n)) return 'Service';
    return '';
  }

  // ── Live WIP row for a job (report + KPI source) ─────────────────────
  function wipRow(j) {
    var w = {};
    try { w = (typeof getJobWIP === 'function') ? getJobWIP(j.id) : {}; } catch (e) { w = {}; }
    var contract = num(w.contractIncome);
    var co = num(w.coIncome);
    var total = num(w.totalIncome) || (contract + co);
    var earned = num(w.revenueEarned);
    var billed = num(w.invoiced);
    return {
      id: j.id,
      jobNumber: j.jobNumber || '',
      title: j.title || 'Untitled',
      market: (window.p86Markets ? window.p86Markets.nameFor(j) : (j.market || '')) || '',
      jobType: jobTypeLabel(j),
      status: j.status || '',
      pct: num(w.pctComplete),
      contract: contract,
      co: co,
      total: total,
      cost: num(w.actualCosts),
      earned: earned,
      billed: billed,
      overUnder: billed - earned,     // billings in excess of earned (>0 = overbilled)
      backlog: num(w.backlog),
      margin: num(w.displayMargin)
    };
  }

  // ── Filter drawer spec + predicate (mirrors the Jobs list) ───────────
  function distinctVals(jobs, accessor) {
    var seen = {}, out = [];
    jobs.forEach(function (j) { var v = accessor(j); if (v == null || v === '') return; v = String(v); if (!seen[v]) { seen[v] = true; out.push(v); } });
    out.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return out;
  }
  function jobAddr(j) { return window.p86Address ? window.p86Address.get(j) : { city: j.city || '', state: j.state || '', zip: j.zip || '' }; }
  function marketName(j) { return (window.p86Markets ? window.p86Markets.nameFor(j) : (j.market || '')) || ''; }
  function insFilterFields() {
    var jobs = baseJobs();
    var opt = function (arr) { return arr.map(function (s) { return { v: s, label: s }; }); };
    return [
      { key: 'status',  label: 'Status',     type: 'chips',    options: opt(distinctVals(jobs, function (j) { return j.status; })) },
      { key: 'jobType', label: 'Job Type',   type: 'select',   options: [{ v: '', label: 'Any' }].concat(opt(distinctVals(jobs, function (j) { return jobTypeLabel(j); }))) },
      { key: 'market',  label: 'Market',     type: 'select',   options: [{ v: '', label: 'Any' }].concat(opt(distinctVals(jobs, marketName))) },
      { key: 'city',    label: 'City',       type: 'select',   options: [{ v: '', label: 'Any' }].concat(opt(distinctVals(jobs, function (j) { return jobAddr(j).city; }))) },
      { key: 'state',   label: 'State',      type: 'select',   options: [{ v: '', label: 'Any' }].concat(opt(distinctVals(jobs, function (j) { return jobAddr(j).state; }))) },
      { key: 'contract', label: 'Contract $', type: 'numrange' },
      { key: 'pct',     label: '% Complete', type: 'numrange' },
      { key: 'margin',  label: 'Margin %',   type: 'numrange' }
    ];
  }
  function insMatch(j, d) {
    if (!d) return true;
    var FD = window.p86FilterDrawer; if (!FD) return true;
    if (d.status && d.status.length && d.status.indexOf(j.status) < 0) return false;
    if (d.jobType && String(jobTypeLabel(j)) !== String(d.jobType)) return false;
    if (d.market && String(marketName(j)) !== String(d.market)) return false;
    if (d.city || d.state) {
      var a = jobAddr(j);
      if (d.city && String(a.city || '') !== String(d.city)) return false;
      if (d.state && String(a.state || '') !== String(d.state)) return false;
    }
    var w = null;
    var cr = FD.resolveNumRange(d.contract);
    if (cr.min != null || cr.max != null) { w = w || wipRow(j); if (cr.min != null && w.total < cr.min) return false; if (cr.max != null && w.total > cr.max) return false; }
    var pr = FD.resolveNumRange(d.pct);
    if (pr.min != null || pr.max != null) { w = w || wipRow(j); if (pr.min != null && w.pct < pr.min) return false; if (pr.max != null && w.pct > pr.max) return false; }
    var mr = FD.resolveNumRange(d.margin);
    if (mr.min != null || mr.max != null) { w = w || wipRow(j); if (mr.min != null && w.margin < mr.min) return false; if (mr.max != null && w.margin > mr.max) return false; }
    return true;
  }

  // ── Aggregation + grouping ───────────────────────────────────────────
  function groupKeyOf(row) {
    if (_groupBy === 'market') return row.market || 'Unassigned';
    if (_groupBy === 'jobType') return row.jobType || 'Unspecified';
    if (_groupBy === 'status') return row.status || 'No status';
    return '';
  }
  function groupLabel() { return { market: 'Market', jobType: 'Job Type', status: 'Status' }[_groupBy] || 'Group'; }
  function groupRows(rows) {
    var map = {}, order = [];
    rows.forEach(function (r) { var k = groupKeyOf(r); if (!map[k]) { map[k] = []; order.push(k); } map[k].push(r); });
    order.sort(function (a, b) { return a.toLowerCase().localeCompare(b.toLowerCase()); });
    return order.map(function (k) { return { key: k, rows: map[k] }; });
  }
  function sumRows(list) {
    var s = { count: list.length, contract: 0, co: 0, total: 0, cost: 0, earned: 0, billed: 0, backlog: 0 };
    list.forEach(function (r) { s.contract += r.contract; s.co += r.co; s.total += r.total; s.cost += r.cost; s.earned += r.earned; s.billed += r.billed; s.backlog += r.backlog; });
    s.overUnder = s.billed - s.earned;
    s.profit = s.earned - s.cost;
    s.margin = s.earned > 0 ? (s.profit / s.earned * 100) : 0;
    s.avgPct = s.total > 0 ? (s.earned / s.total * 100) : 0;
    return s;
  }

  // ── Render: shell ────────────────────────────────────────────────────
  function renderInsightsDashboard() {
    var dash = document.getElementById('insights-dashboard');
    if (!dash) return;
    ensureStyle();

    var allCount = ((window.appData && appData.jobs) || []).length;
    if (!allCount) { dash.innerHTML = header(0) + emptyCard('No jobs yet.'); return; }

    var jobs = filteredJobs();
    var rows = jobs.map(wipRow);

    var html = header(jobs.length) + toolbar();
    html += (_view === 'reports') ? reportsBody(rows) : dashboardBody(rows);
    dash.innerHTML = html;
  }

  function header(count) {
    return '<div class="ins-head">' +
      '<h2 class="ins-title">Company WIP Insights</h2>' +
      '<div class="ins-head-r">' +
        '<span class="ins-count">' + count + ' active job' + (count === 1 ? '' : 's') + ' &middot; live</span>' +
        '<span class="p86-ask86-mount"></span>' +
      '</div></div>';
  }

  function toolbar() {
    var FD = window.p86FilterDrawer;
    var n = (_drawer && FD) ? FD.countActive(insFilterFields(), _drawer) : 0;
    var tab = function (id, label) {
      return '<button type="button" class="ins-tab' + (_view === id ? ' on' : '') + '" onclick="insightsSetView(\'' + id + '\')">' + label + '</button>';
    };
    var grpOpts = [['none', 'No grouping'], ['market', 'By market'], ['jobType', 'By job type'], ['status', 'By status']]
      .map(function (o) { return '<option value="' + o[0] + '"' + (_groupBy === o[0] ? ' selected' : '') + '>' + o[1] + '</option>'; }).join('');
    var right =
      '<label class="ins-group"><span>Group</span><select onchange="insightsSetGroup(this.value)">' + grpOpts + '</select></label>' +
      '<button type="button" class="ins-btn' + (n ? ' on' : '') + '" onclick="insightsOpenFilter()">' + (window.p86Icon ? window.p86Icon('funnel') : 'Filter') + (n ? ' <strong>(' + n + ')</strong>' : '') + '</button>' +
      (n ? '<button type="button" class="ins-btn" onclick="insightsClearFilter()">Clear</button>' : '') +
      (_view === 'reports' && _report === 'wip' ? '<button type="button" class="ins-btn" onclick="insightsExportCsv()">Export CSV</button>' : '');
    return '<div class="ins-toolbar">' +
      '<div class="ins-tabs">' + tab('dashboard', 'Dashboard') + tab('reports', 'Reports') + '</div>' +
      '<div class="ins-tools">' + right + '</div></div>';
  }

  function emptyCard(msg) {
    return '<div class="card ins-block" style="text-align:center;color:var(--text-dim,#888);padding:30px;">' + esc(msg) + '</div>';
  }

  // ── Render: Dashboard view ───────────────────────────────────────────
  function dashboardBody(rows) {
    var a = sumRows(rows);
    var kpis = [
      ['Total Pipeline', fmtBig(a.total), 'var(--accent,#4f8cff)'],
      ['Rev Earned', fmtBig(a.earned), 'var(--green,#34d399)'],
      ['Actual Costs', fmtBig(a.cost), 'var(--red,#f87171)'],
      ['Gross Profit', fmtBig(a.profit), a.profit >= 0 ? 'var(--green,#34d399)' : 'var(--red,#f87171)'],
      ['Backlog', fmtBig(a.backlog), 'var(--yellow,#fbbf24)'],
      ['Avg % Complete', fmtPct(a.avgPct), 'var(--accent,#4f8cff)']
    ];
    var html = '<div class="ins-kpis">';
    kpis.forEach(function (k) {
      html += '<div class="card ins-kpi"><div class="ins-kpi-l">' + k[0] + '</div><div class="ins-kpi-v" style="color:' + k[2] + ';">' + k[1] + '</div></div>';
    });
    html += '</div>';
    if (!rows.length) return html + emptyCard('No jobs match the current filters.');
    if (_groupBy !== 'none') html += groupBreakdown(rows);
    html += perfStrip(rows);
    return html;
  }

  function groupBreakdown(rows) {
    var label = groupLabel();
    var h = '<div class="card ins-block"><div class="ins-block-h">' + label + ' breakdown</div>' +
      '<div class="ins-tblwrap"><table class="ins-tbl"><thead><tr>' +
      '<th class="l">' + label + '</th><th class="r">Jobs</th><th class="r">Contract</th><th class="r">Earned</th><th class="r">Cost</th><th class="r">Profit</th><th class="r">Margin</th>' +
      '</tr></thead><tbody>';
    groupRows(rows).forEach(function (g) {
      var s = sumRows(g.rows);
      h += '<tr><td class="l">' + esc(g.key) + '</td><td class="r">' + s.count + '</td><td class="r">' + fmtMoney(s.total) + '</td><td class="r">' + fmtMoney(s.earned) + '</td><td class="r">' + fmtMoney(s.cost) + '</td><td class="r">' + fmtMoney(s.profit) + '</td><td class="r">' + fmtPct(s.margin) + '</td></tr>';
    });
    var a = sumRows(rows);
    h += '</tbody><tfoot><tr class="ins-tot"><td class="l">Total</td><td class="r">' + a.count + '</td><td class="r">' + fmtMoney(a.total) + '</td><td class="r">' + fmtMoney(a.earned) + '</td><td class="r">' + fmtMoney(a.cost) + '</td><td class="r">' + fmtMoney(a.profit) + '</td><td class="r">' + fmtPct(a.margin) + '</td></tr></tfoot></table></div></div>';
    return h;
  }

  function perfStrip(rows) {
    var sorted = rows.slice().sort(function (a, b) { return b.total - a.total; });
    var h = '<div class="card ins-block"><div class="ins-block-h">Job performance &middot; live</div><div class="ins-perf">';
    sorted.forEach(function (r) {
      var bc = r.margin >= 15 ? '#34d399' : r.margin >= 0 ? '#fbbf24' : '#f87171';
      h += '<div class="ins-perf-row" style="border-left:3px solid ' + bc + ';">' +
        '<div class="ins-perf-t" title="' + esc(r.title) + '">' + esc((r.jobNumber ? r.jobNumber + ' — ' : '') + r.title) + '</div>' +
        '<div class="ins-perf-m"><span>Income</span><b>' + fmtCurrency(r.total) + '</b></div>' +
        '<div class="ins-perf-m"><span>Earned</span><b style="color:#34d399;">' + fmtCurrency(r.earned) + '</b></div>' +
        '<div class="ins-perf-m"><span>Margin</span><b style="color:' + bc + ';">' + fmtPct(r.margin) + '</b></div>' +
        '<div class="ins-perf-bar"><div style="width:' + Math.min(Math.max(r.pct, 0), 100) + '%;background:' + bc + ';"></div></div>' +
        '<div class="ins-perf-p">' + fmtPct(r.pct, 0) + '</div>' +
      '</div>';
    });
    h += '</div></div>';
    return h;
  }

  // ── Render: Reports view ─────────────────────────────────────────────
  function reportsBody(rows) {
    var defs = [['wip', 'WIP Schedule', true], ['cost', 'Job Cost Detail', false], ['pnl', 'Job P&L', false], ['committed', 'Committed Costs', false], ['ar', 'AR / Billing', false]];
    var picker = defs.map(function (o) {
      var on = _report === o[0], soon = !o[2];
      return '<button type="button" class="ins-rpick' + (on ? ' on' : '') + (soon ? ' soon' : '') + '"' +
        (soon ? ' disabled title="Coming next"' : ' onclick="insightsSetReport(\'' + o[0] + '\')"') + '>' +
        esc(o[1]) + (soon ? ' <span class="ins-soon">soon</span>' : '') + '</button>';
    }).join('');
    var h = '<div class="ins-rpicker">' + picker + '</div>';
    h += (_report === 'wip') ? wipReport(rows) : emptyCard('This report is coming next.');
    return h;
  }

  function wipRowHtml(r, multi) {
    var ou = r.overUnder;
    var ouTxt = (ou < 0 ? '(' : '') + fmtMoney(Math.abs(ou)) + (ou < 0 ? ')' : '');
    return '<tr>' +
      '<td class="l">' + esc(r.jobNumber) + '</td>' +
      '<td class="l" title="' + esc(r.title) + '">' + esc(r.title) + '</td>' +
      (multi ? '<td class="l">' + esc(r.market) + '</td>' : '') +
      '<td class="l">' + esc(r.jobType) + '</td>' +
      '<td class="r">' + fmtMoney(r.contract) + '</td>' +
      '<td class="r">' + fmtMoney(r.co) + '</td>' +
      '<td class="r">' + fmtMoney(r.total) + '</td>' +
      '<td class="r">' + fmtMoney(r.cost) + '</td>' +
      '<td class="r">' + fmtPct(r.pct, 0) + '</td>' +
      '<td class="r">' + fmtMoney(r.earned) + '</td>' +
      '<td class="r">' + fmtMoney(r.billed) + '</td>' +
      '<td class="r"' + (ou < 0 ? ' style="color:#fbbf24;"' : '') + '>' + ouTxt + '</td>' +
      '<td class="r">' + fmtMoney(r.backlog) + '</td>' +
    '</tr>';
  }
  function wipTotRow(label, list, multi, labelCols, cls) {
    var s = sumRows(list);
    var ou = s.overUnder;
    var ouTxt = (ou < 0 ? '(' : '') + fmtMoney(Math.abs(ou)) + (ou < 0 ? ')' : '');
    return '<tr class="' + cls + '"><td class="l" colspan="' + labelCols + '">' + esc(label) + '</td>' +
      '<td class="r">' + fmtMoney(s.contract) + '</td>' +
      '<td class="r">' + fmtMoney(s.co) + '</td>' +
      '<td class="r">' + fmtMoney(s.total) + '</td>' +
      '<td class="r">' + fmtMoney(s.cost) + '</td>' +
      '<td class="r">' + fmtPct(s.avgPct, 0) + '</td>' +
      '<td class="r">' + fmtMoney(s.earned) + '</td>' +
      '<td class="r">' + fmtMoney(s.billed) + '</td>' +
      '<td class="r"' + (ou < 0 ? ' style="color:#fbbf24;"' : '') + '>' + ouTxt + '</td>' +
      '<td class="r">' + fmtMoney(s.backlog) + '</td></tr>';
  }
  function wipReport(rows) {
    var multi = !!(window.p86Markets && window.p86Markets.hasMulti && window.p86Markets.hasMulti());
    var labelCols = multi ? 4 : 3;
    var totalCols = labelCols + 9;
    var head = '<th class="l">Job #</th><th class="l">Job</th>' + (multi ? '<th class="l">Market</th>' : '') + '<th class="l">Type</th>' +
      '<th class="r">Contract</th><th class="r">COs</th><th class="r">Total</th><th class="r">Cost to Date</th><th class="r">%</th><th class="r">Earned</th><th class="r">Billed</th><th class="r">Over/(Under)</th><th class="r">Backlog</th>';
    var h = '<div class="card ins-block"><div class="ins-block-h">WIP Schedule <span class="ins-sub">' + rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' &middot; live</span></div>' +
      '<div class="ins-tblwrap"><table class="ins-tbl ins-wip"><thead><tr>' + head + '</tr></thead><tbody>';
    if (!rows.length) {
      h += '<tr><td colspan="' + totalCols + '" style="text-align:center;padding:24px;color:var(--text-dim,#888);">No jobs match the current filters.</td></tr>';
    } else if (_groupBy !== 'none') {
      groupRows(rows).forEach(function (g) {
        h += '<tr class="ins-grp"><td class="l" colspan="' + totalCols + '">' + esc(groupLabel() + ': ' + g.key) + ' <span class="ins-sub">(' + g.rows.length + ')</span></td></tr>';
        g.rows.forEach(function (r) { h += wipRowHtml(r, multi); });
        h += wipTotRow('Subtotal', g.rows, multi, labelCols, 'ins-sub-tot');
      });
    } else {
      rows.forEach(function (r) { h += wipRowHtml(r, multi); });
    }
    h += '</tbody>';
    if (rows.length) h += '<tfoot>' + wipTotRow('Company total', rows, multi, labelCols, 'ins-tot') + '</tfoot>';
    h += '</table></div></div>';
    return h;
  }

  // ── CSV export (WIP Schedule) ────────────────────────────────────────
  function csvCell(v) { v = v == null ? '' : String(v); if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"'; return v; }
  function dateStamp() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function exportWipCsv() {
    var rows = filteredJobs().map(wipRow);
    var head = ['Job #', 'Job', 'Market', 'Type', 'Contract', 'Approved COs', 'Total Contract', 'Cost to Date', '% Complete', 'Earned Revenue', 'Billed', 'Over/(Under) Billing', 'Backlog'];
    var lines = [head.map(csvCell).join(',')];
    rows.forEach(function (r) {
      lines.push([r.jobNumber, r.title, r.market, r.jobType,
        Math.round(r.contract), Math.round(r.co), Math.round(r.total), Math.round(r.cost),
        r.pct.toFixed(1), Math.round(r.earned), Math.round(r.billed), Math.round(r.overUnder), Math.round(r.backlog)
      ].map(csvCell).join(','));
    });
    var s = sumRows(rows);
    lines.push(['TOTAL', '', '', '', Math.round(s.contract), Math.round(s.co), Math.round(s.total), Math.round(s.cost), s.avgPct.toFixed(1), Math.round(s.earned), Math.round(s.billed), Math.round(s.overUnder), Math.round(s.backlog)].map(csvCell).join(','));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'wip-schedule-' + dateStamp() + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    if (typeof window.p86Toast === 'function') window.p86Toast('WIP schedule exported', 'success');
  }

  // ── Filter drawer open ───────────────────────────────────────────────
  function openInsFilter() {
    var FD = window.p86FilterDrawer; if (!FD) return;
    var fields = insFilterFields();
    FD.open({
      title: 'Filter Insights', fields: fields,
      values: _drawer || FD.emptyValues(fields),
      onApply: function (v) { _drawer = v; renderInsightsDashboard(); },
      onClear: function () { _drawer = null; renderInsightsDashboard(); }
    });
  }

  // ── One-time CSS ─────────────────────────────────────────────────────
  function ensureStyle() {
    if (document.getElementById('ins-styles')) return;
    var css =
      '.ins-head{display:flex;justify-content:space-between;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:12px}' +
      '.ins-title{font-size:18px;margin:0;color:var(--text,#fff)}' +
      '.ins-head-r{display:flex;align-items:center;gap:12px}' +
      '.ins-count{font-size:12px;color:var(--text-dim,#888)}' +
      '.ins-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}' +
      '.ins-tabs{display:inline-flex;background:var(--surface2,rgba(255,255,255,.05));border-radius:8px;padding:3px;gap:2px}' +
      '.ins-tab{border:0;background:transparent;color:var(--text-dim,#888);font:inherit;font-size:13px;font-weight:600;padding:6px 14px;border-radius:6px;cursor:pointer}' +
      '.ins-tab.on{background:var(--accent,#4f8cff);color:#fff}' +
      '.ins-tools{display:flex;align-items:center;gap:8px;flex-wrap:wrap}' +
      '.ins-group{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--text-dim,#888)}' +
      '.ins-group select{font:inherit;font-size:12px;padding:5px 8px;border-radius:6px;background:var(--input-bg,var(--surface2,#1a1f33));color:var(--text,#fff);border:1px solid var(--border,#333)}' +
      '.ins-btn{display:inline-flex;align-items:center;gap:5px;font:inherit;font-size:12px;padding:6px 12px;border-radius:6px;background:var(--surface2,rgba(255,255,255,.05));color:var(--text,#ddd);border:1px solid var(--border,#333);cursor:pointer}' +
      '.ins-btn.on{border-color:var(--accent,#4f8cff);color:var(--accent,#4f8cff)}' +
      '.ins-btn svg{width:14px;height:14px}' +
      '.ins-kpis{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px}' +
      '.ins-kpi{flex:1;min-width:130px;padding:12px 14px;text-align:center}' +
      '.ins-kpi-l{font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:.5px;margin-bottom:4px}' +
      '.ins-kpi-v{font-size:20px;font-weight:700}' +
      '.ins-block{padding:14px;margin-bottom:14px}' +
      '.ins-block-h{font-size:11px;font-weight:600;color:var(--text-dim,#888);margin-bottom:8px;text-transform:uppercase;letter-spacing:.5px}' +
      '.ins-sub{font-size:10px;color:var(--text-dim,#888);text-transform:none;font-weight:400}' +
      '.ins-tblwrap{overflow-x:auto}' +
      '.ins-tbl{width:100%;border-collapse:collapse;font-size:12px}' +
      '.ins-tbl th{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border,#333);color:var(--text-dim,#888);font-weight:600;white-space:nowrap}' +
      '.ins-tbl td{padding:5px 8px;border-bottom:1px solid var(--border,#222);color:var(--text,#eee)}' +
      '.ins-tbl th.r,.ins-tbl td.r{text-align:right;white-space:nowrap}' +
      '.ins-tbl th.l,.ins-tbl td.l{text-align:left}' +
      '.ins-tbl tbody tr:hover td{background:var(--surface2,rgba(255,255,255,.03))}' +
      '.ins-wip td.l{max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ins-grp td{background:var(--surface2,rgba(255,255,255,.06));font-weight:700;color:var(--text,#fff)}' +
      '.ins-sub-tot td{font-weight:600;border-top:1px solid var(--border,#333)}' +
      '.ins-tot td{font-weight:700;color:var(--text,#fff);border-top:2px solid var(--border,#444);background:var(--surface2,rgba(255,255,255,.04))}' +
      '.ins-rpicker{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px}' +
      '.ins-rpick{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;background:var(--surface2,rgba(255,255,255,.05));color:var(--text-dim,#888);border:1px solid var(--border,#333);cursor:pointer}' +
      '.ins-rpick.on{background:var(--accent,#4f8cff);color:#fff;border-color:var(--accent,#4f8cff)}' +
      '.ins-rpick.soon{opacity:.5;cursor:not-allowed}' +
      '.ins-soon{font-size:9px;text-transform:uppercase;opacity:.8}' +
      '.ins-perf{display:flex;flex-direction:column;gap:6px}' +
      '.ins-perf-row{display:grid;grid-template-columns:2fr 1fr 1fr 1fr 120px 44px;gap:10px;align-items:center;padding:8px 10px;border-radius:8px;background:var(--surface2,rgba(255,255,255,.03))}' +
      '.ins-perf-t{font-size:12px;font-weight:600;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
      '.ins-perf-m{display:flex;flex-direction:column;font-size:10px;color:var(--text-dim,#888)}' +
      '.ins-perf-m b{font-size:12px;color:var(--text,#fff)}' +
      '.ins-perf-bar{height:6px;border-radius:3px;background:var(--border,#333);overflow:hidden}' +
      '.ins-perf-bar>div{height:100%;border-radius:3px}' +
      '.ins-perf-p{font-size:11px;color:var(--text-dim,#888);text-align:right}' +
      '@media(max-width:760px){.ins-perf-row{grid-template-columns:1fr 1fr 1fr}.ins-perf-t{grid-column:1/-1}.ins-perf-bar,.ins-perf-p{grid-column:1/-1}}';
    var st = document.createElement('style');
    st.id = 'ins-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // ── Exports (inline handlers + external callers) ─────────────────────
  window.insightsSetView = function (v) { _view = v; renderInsightsDashboard(); };
  window.insightsSetReport = function (v) { _report = v; renderInsightsDashboard(); };
  window.insightsSetGroup = function (v) { _groupBy = v; renderInsightsDashboard(); };
  window.insightsOpenFilter = openInsFilter;
  window.insightsClearFilter = function () { _drawer = null; renderInsightsDashboard(); };
  window.insightsExportCsv = exportWipCsv;
  window.renderInsightsDashboard = renderInsightsDashboard;
})();
