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
//     a Reports section (S2). Reports run off a registry — WIP Schedule, Job
//     P&L, Job Cost Detail, Committed Costs, AR/Billing — each filterable +
//     group-able, with CSV + styled Excel export (server buildWorkbook).
(function () {
  'use strict';

  var esc = window.escapeHTML || function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  function num(v) { v = Number(v); return isFinite(v) ? v : 0; }
  function hasMulti() { return !!(window.p86Markets && window.p86Markets.hasMulti && window.p86Markets.hasMulti()); }

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
  function marketName(j) { return (window.p86Markets ? window.p86Markets.nameFor(j) : (j.market || '')) || ''; }

  // ── Live WIP row for a job (the base every report/KPI reads) ─────────
  function wipRow(j) {
    var w = {};
    try { w = (typeof getJobWIP === 'function') ? getJobWIP(j.id) : {}; } catch (e) { w = {}; }
    var contract = num(w.contractIncome);
    var co = num(w.coIncome);
    var total = num(w.totalIncome) || (contract + co);
    var earned = num(w.revenueEarned);
    var billed = num(w.invoiced);
    var cost = num(w.actualCosts);
    return {
      id: j.id,
      jobNumber: j.jobNumber || '',
      title: j.title || 'Untitled',
      market: marketName(j),
      jobType: jobTypeLabel(j),
      status: j.status || '',
      pct: num(w.pctComplete),
      contract: contract,
      co: co,
      total: total,
      cost: cost,
      earned: earned,
      billed: billed,
      unbilled: num(w.unbilled),
      overUnder: billed - earned,     // billings in excess of earned (>0 = overbilled)
      backlog: num(w.backlog),
      budget: num(w.revisedEstCosts || w.estimatedCosts),
      profit: earned - cost,
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
  function sumFields(rows, keys) {
    var t = {};
    keys.forEach(function (k) { t[k] = 0; });
    rows.forEach(function (r) { keys.forEach(function (k) { t[k] += num(r[k]); }); });
    return t;
  }
  // Dashboard KPI aggregate (built on wip rows).
  function kpiAgg(rows) {
    var s = sumFields(rows, ['total', 'earned', 'cost', 'backlog']);
    s.count = rows.length;
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
    var html = header(jobs.length) + toolbar();
    html += (_view === 'reports') ? reportsBody(jobs) : dashboardBody(jobs.map(wipRow));
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
      (_view === 'reports' ? '<button type="button" class="ins-btn" onclick="insightsExportCsv()">CSV</button><button type="button" class="ins-btn" onclick="insightsExportXlsx()">Excel</button><button type="button" class="ins-btn" onclick="insightsExportPdf()">PDF</button>' : '');
    return '<div class="ins-toolbar">' +
      '<div class="ins-tabs">' + tab('dashboard', 'Dashboard') + tab('reports', 'Reports') + '</div>' +
      '<div class="ins-tools">' + right + '</div></div>';
  }

  function emptyCard(msg) {
    return '<div class="card ins-block" style="text-align:center;color:var(--text-dim,#888);padding:30px;">' + esc(msg) + '</div>';
  }

  // ── Render: Dashboard view ───────────────────────────────────────────
  function dashboardBody(rows) {
    var a = kpiAgg(rows);
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
      var s = kpiAgg(g.rows);
      h += '<tr><td class="l">' + esc(g.key) + '</td><td class="r">' + s.count + '</td><td class="r">' + fmtMoney(s.total) + '</td><td class="r">' + fmtMoney(s.earned) + '</td><td class="r">' + fmtMoney(s.cost) + '</td><td class="r">' + fmtMoney(s.profit) + '</td><td class="r">' + fmtPct(s.margin) + '</td></tr>';
    });
    var a = kpiAgg(rows);
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

  // ── Report registry ──────────────────────────────────────────────────
  // Each report: columns [{k,label,t,multiOnly?}] where t ∈
  // text|money|moneyParen|pct|pct0; rows(jobs) → display rows (with market/
  // jobType/status for group-by); total(rows) → correctly-weighted totals.
  // Text columns MUST lead (subtotal label spans them).
  function costBucketsFor(jobId) {
    var b = { materials: 0, labor: 0, subs: 0, equipment: 0, gc: 0, other: 0 };
    try {
      if (window.p86CostBuckets) {
        var roll = p86CostBuckets.getJobCostBuckets(jobId);
        (roll.buckets || []).forEach(function (bk) { if (b[bk.code] != null) b[bk.code] = num(bk.total); });
      }
    } catch (e) { /* leave zeros */ }
    return b;
  }
  function committedFor(jobId) {
    var committed = 0, billed = 0;
    try {
      (window.jobSubsFromPOs ? jobSubsFromPOs(jobId) : []).forEach(function (s) { committed += num(s.contractAmt); billed += num(s.billedToDate); });
    } catch (e) { /* none */ }
    return { committed: committed, billed: billed };
  }

  var REPORTS = {
    wip: {
      name: 'WIP Schedule',
      columns: [
        { k: 'jobNumber', label: 'Job #', t: 'text' }, { k: 'title', label: 'Job', t: 'text' },
        { k: 'market', label: 'Market', t: 'text', multiOnly: true }, { k: 'jobType', label: 'Type', t: 'text' },
        { k: 'contract', label: 'Contract', t: 'money' }, { k: 'co', label: 'COs', t: 'money' },
        { k: 'total', label: 'Total', t: 'money' }, { k: 'cost', label: 'Cost to Date', t: 'money' },
        { k: 'pct', label: '%', t: 'pct0' }, { k: 'earned', label: 'Earned', t: 'money' },
        { k: 'billed', label: 'Billed', t: 'money' }, { k: 'overUnder', label: 'Over/(Under)', t: 'moneyParen' },
        { k: 'backlog', label: 'Backlog', t: 'money' }
      ],
      rows: function (jobs) { return jobs.map(wipRow); },
      total: function (rows) { var t = sumFields(rows, ['contract', 'co', 'total', 'cost', 'earned', 'billed', 'backlog']); t.pct = t.total > 0 ? (t.earned / t.total * 100) : 0; t.overUnder = t.billed - t.earned; return t; }
    },
    pnl: {
      name: 'Job P&L',
      columns: [
        { k: 'jobNumber', label: 'Job #', t: 'text' }, { k: 'title', label: 'Job', t: 'text' },
        { k: 'market', label: 'Market', t: 'text', multiOnly: true }, { k: 'jobType', label: 'Type', t: 'text' },
        { k: 'total', label: 'Revenue', t: 'money' }, { k: 'earned', label: 'Earned', t: 'money' },
        { k: 'cost', label: 'Cost', t: 'money' }, { k: 'profit', label: 'Gross Profit', t: 'moneyParen' },
        { k: 'margin', label: 'Margin', t: 'pct' }
      ],
      rows: function (jobs) { return jobs.map(wipRow); },
      total: function (rows) { var t = sumFields(rows, ['total', 'earned', 'cost']); t.profit = t.earned - t.cost; t.margin = t.earned > 0 ? (t.profit / t.earned * 100) : 0; return t; }
    },
    cost: {
      name: 'Job Cost Detail',
      columns: [
        { k: 'jobNumber', label: 'Job #', t: 'text' }, { k: 'title', label: 'Job', t: 'text' },
        { k: 'materials', label: 'Materials', t: 'money' }, { k: 'labor', label: 'Labor', t: 'money' },
        { k: 'subs', label: 'Subs', t: 'money' }, { k: 'equipment', label: 'Equip', t: 'money' },
        { k: 'gc', label: 'GC', t: 'money' }, { k: 'other', label: 'Other', t: 'money' },
        { k: 'cost', label: 'Total Cost', t: 'money' }, { k: 'budget', label: 'Budget', t: 'money' },
        { k: 'variance', label: 'Variance', t: 'moneyParen' }
      ],
      rows: function (jobs) {
        return jobs.map(function (j) {
          var w = wipRow(j); var b = costBucketsFor(j.id);
          return {
            id: j.id, jobNumber: w.jobNumber, title: w.title, market: w.market, jobType: w.jobType, status: w.status,
            materials: b.materials, labor: b.labor, subs: b.subs, equipment: b.equipment, gc: b.gc, other: b.other,
            cost: w.cost, budget: w.budget, variance: w.budget - w.cost
          };
        });
      },
      total: function (rows) { var t = sumFields(rows, ['materials', 'labor', 'subs', 'equipment', 'gc', 'other', 'cost', 'budget']); t.variance = t.budget - t.cost; return t; }
    },
    committed: {
      name: 'Committed Costs',
      columns: [
        { k: 'jobNumber', label: 'Job #', t: 'text' }, { k: 'title', label: 'Job', t: 'text' },
        { k: 'market', label: 'Market', t: 'text', multiOnly: true },
        { k: 'committed', label: 'Committed (PO)', t: 'money' }, { k: 'billed', label: 'Billed', t: 'money' },
        { k: 'remaining', label: 'Remaining', t: 'money' }, { k: 'pctBilled', label: '% Billed', t: 'pct0' }
      ],
      rows: function (jobs) {
        return jobs.map(function (j) {
          var c = committedFor(j.id);
          return {
            id: j.id, jobNumber: j.jobNumber || '', title: j.title || 'Untitled', market: marketName(j), jobType: jobTypeLabel(j), status: j.status || '',
            committed: c.committed, billed: c.billed, remaining: c.committed - c.billed, pctBilled: c.committed > 0 ? (c.billed / c.committed * 100) : 0
          };
        });
      },
      total: function (rows) { var t = sumFields(rows, ['committed', 'billed']); t.remaining = t.committed - t.billed; t.pctBilled = t.committed > 0 ? (t.billed / t.committed * 100) : 0; return t; }
    },
    ar: {
      name: 'AR / Billing',
      columns: [
        { k: 'jobNumber', label: 'Job #', t: 'text' }, { k: 'title', label: 'Job', t: 'text' },
        { k: 'market', label: 'Market', t: 'text', multiOnly: true },
        { k: 'total', label: 'Contract', t: 'money' }, { k: 'earned', label: 'Earned Rev', t: 'money' },
        { k: 'billed', label: 'Billed', t: 'money' }, { k: 'unbilled', label: 'Unbilled', t: 'money' },
        { k: 'overUnder', label: 'Over/(Under)', t: 'moneyParen' }
      ],
      rows: function (jobs) { return jobs.map(wipRow); },
      total: function (rows) { var t = sumFields(rows, ['total', 'earned', 'billed', 'unbilled']); t.overUnder = t.billed - t.earned; return t; }
    }
  };
  var REPORT_ORDER = ['wip', 'pnl', 'cost', 'committed', 'ar'];

  // ── Render: Reports view ─────────────────────────────────────────────
  function reportCols(report) { var multi = hasMulti(); return report.columns.filter(function (c) { return !c.multiOnly || multi; }); }
  function labelColCount(cols) { var n = 0; for (var i = 0; i < cols.length; i++) { if (cols[i].t === 'text') n++; else break; } return n; }
  function cellCls(t) { return t === 'text' ? 'l' : 'r'; }
  function fmtCellVal(v, t) {
    if (t === 'money') return fmtMoney(v);
    if (t === 'moneyParen') { var n = num(v); return (n < 0 ? '(' : '') + fmtMoney(Math.abs(n)) + (n < 0 ? ')' : ''); }
    if (t === 'pct') return fmtPct(num(v));
    if (t === 'pct0') return fmtPct(num(v), 0);
    return esc(v == null ? '' : v);
  }

  function reportsBody(jobs) {
    var picker = REPORT_ORDER.map(function (id) {
      var on = _report === id;
      return '<button type="button" class="ins-rpick' + (on ? ' on' : '') + '" onclick="insightsSetReport(\'' + id + '\')">' + esc(REPORTS[id].name) + '</button>';
    }).join('');
    var report = REPORTS[_report] || REPORTS.wip;
    var rows = report.rows(jobs);
    return '<div class="ins-rpicker">' + picker + '</div>' + renderReport(report, rows);
  }

  function renderReport(report, rows) {
    var cols = reportCols(report);
    var lc = labelColCount(cols);
    var head = cols.map(function (c) { return '<th class="' + cellCls(c.t) + '">' + esc(c.label) + '</th>'; }).join('');
    function dataTr(r) {
      return '<tr>' + cols.map(function (c) {
        var v = r[c.k]; var st = (c.t === 'moneyParen' && num(v) < 0) ? ' style="color:#fbbf24;"' : '';
        return '<td class="' + cellCls(c.t) + '"' + st + '>' + fmtCellVal(v, c.t) + '</td>';
      }).join('') + '</tr>';
    }
    function totTr(label, list, cls) {
      var t = report.total(list); var cells = '';
      cols.forEach(function (c, i) {
        if (i < lc) { if (i === 0) cells += '<td class="l" colspan="' + lc + '">' + esc(label) + '</td>'; return; }
        var v = t[c.k]; var st = (c.t === 'moneyParen' && num(v) < 0) ? ' style="color:#fbbf24;"' : '';
        cells += '<td class="r"' + st + '>' + fmtCellVal(v, c.t) + '</td>';
      });
      return '<tr class="' + cls + '">' + cells + '</tr>';
    }
    var h = '<div class="card ins-block"><div class="ins-block-h">' + esc(report.name) + ' <span class="ins-sub">' + rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' &middot; live</span></div>' +
      '<div class="ins-tblwrap"><table class="ins-tbl ins-wip"><thead><tr>' + head + '</tr></thead><tbody>';
    if (!rows.length) {
      h += '<tr><td colspan="' + cols.length + '" style="text-align:center;padding:24px;color:var(--text-dim,#888);">No jobs match the current filters.</td></tr>';
    } else if (_groupBy !== 'none') {
      groupRows(rows).forEach(function (g) {
        h += '<tr class="ins-grp"><td class="l" colspan="' + cols.length + '">' + esc(groupLabel() + ': ' + g.key) + ' <span class="ins-sub">(' + g.rows.length + ')</span></td></tr>';
        g.rows.forEach(function (r) { h += dataTr(r); });
        h += totTr('Subtotal', g.rows, 'ins-sub-tot');
      });
    } else {
      rows.forEach(function (r) { h += dataTr(r); });
    }
    h += '</tbody>';
    if (rows.length) h += '<tfoot>' + totTr('Company total', rows, 'ins-tot') + '</tfoot>';
    h += '</table></div></div>';
    return h;
  }

  // ── Exports (CSV + server-side styled Excel) ─────────────────────────
  function dateStamp() { var d = new Date(); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); }
  function slug(s) { return String(s).replace(/[^\w]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase(); }
  function csvCell(v) { v = v == null ? '' : String(v); if (/[",\r\n]/.test(v)) v = '"' + v.replace(/"/g, '""') + '"'; return v; }
  function csvVal(v, t) {
    if (t === 'money' || t === 'moneyParen') return Math.round(num(v));
    if (t === 'pct') return num(v).toFixed(1);
    if (t === 'pct0') return num(v).toFixed(0);
    return v == null ? '' : String(v);
  }
  function exportReportCsv() {
    var report = REPORTS[_report] || REPORTS.wip;
    var cols = report.columns; // include every column (market too) in the file
    var rows = report.rows(filteredJobs());
    var lines = [cols.map(function (c) { return c.label; }).map(csvCell).join(',')];
    rows.forEach(function (r) { lines.push(cols.map(function (c) { return csvVal(r[c.k], c.t); }).map(csvCell).join(',')); });
    var t = report.total(rows);
    lines.push(cols.map(function (c, i) { return i === 0 ? 'TOTAL' : (c.t === 'text' ? '' : csvVal(t[c.k], c.t)); }).map(csvCell).join(','));
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = slug(report.name) + '-' + dateStamp() + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 100);
    if (typeof window.p86Toast === 'function') window.p86Toast(report.name + ' exported (CSV)', 'success');
  }

  function colLetter(n) { var s = ''; n++; while (n > 0) { var m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; }
  function xlCell(v, t) {
    if (t === 'money' || t === 'moneyParen') return { raw: num(v), fmt: 'currency', decimals: 0, style: { align: 'right' } };
    if (t === 'pct') return { raw: num(v) / 100, fmt: 'percent', decimals: 1, style: { align: 'right' } };
    if (t === 'pct0') return { raw: num(v) / 100, fmt: 'percent', decimals: 0, style: { align: 'right' } };
    return { raw: (v == null ? '' : String(v)), style: { align: 'left' } };
  }
  function exportReportXlsx() {
    var report = REPORTS[_report] || REPORTS.wip;
    var cols = report.columns;
    var rows = report.rows(filteredJobs());
    var cells = {};
    // Row 1 title, row 2 header, rows 3.. data, then a bold TOTAL row.
    cells['A1'] = { raw: report.name + ' — ' + dateStamp(), style: { bold: true, fontSize: 22, color: '#1f2a44' } };
    cols.forEach(function (c, ci) {
      cells[colLetter(ci) + '2'] = { raw: c.label, style: { bold: true, bg: '#1f2a44', color: '#ffffff', align: (c.t === 'text' ? 'left' : 'right') } };
    });
    var rr = 3;
    rows.forEach(function (row) { cols.forEach(function (c, ci) { cells[colLetter(ci) + rr] = xlCell(row[c.k], c.t); }); rr++; });
    var t = report.total(rows);
    cols.forEach(function (c, ci) {
      var ref = colLetter(ci) + rr, cell;
      if (ci === 0) cell = { raw: 'TOTAL', style: { align: 'left' } };
      else if (c.t === 'text') cell = { raw: '', style: {} };
      else cell = xlCell(t[c.k], c.t);
      cell.style = Object.assign({}, cell.style, { bold: true, borders: { top: { style: 'thin', color: '#888888' } } });
      cells[ref] = cell;
    });
    var lastDataRow = rows.length ? (2 + rows.length) : 2; // 1-based; header is row 2
    var colWidths = {}; cols.forEach(function (c, ci) { colWidths[ci] = c.k === 'title' ? 240 : (c.t === 'text' ? 90 : 105); });
    var sheet = {
      name: report.name.slice(0, 31), cells: cells, colWidths: colWidths,
      frozen: 'row',
      autoFilter: { r1: 1, c1: 0, r2: lastDataRow - 1, c2: cols.length - 1 } // 0-based, header row .. last data row
    };
    var payload = { filename: slug(report.name) + '-' + dateStamp() + '.xlsx', sheets: [sheet] };
    var headers = { 'Content-Type': 'application/json' };
    var token = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) || localStorage.getItem('p86-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (typeof window.p86Toast === 'function') window.p86Toast('Building Excel…', 'success');
    fetch('/api/workspace/export-xlsx', { method: 'POST', credentials: 'same-origin', headers: headers, body: JSON.stringify(payload) })
      .then(function (res) { if (!res.ok) throw new Error('HTTP ' + res.status); return res.blob(); })
      .then(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = payload.filename;
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 2000);
        if (typeof window.p86Toast === 'function') window.p86Toast(report.name + ' exported (Excel)', 'success');
      })
      .catch(function (e) { console.error('[insights] xlsx export failed', e); if (typeof window.p86Toast === 'function') window.p86Toast('Excel export failed', 'error'); });
  }

  // Branded, paginated print → PDF (clone of the pay-app print builder).
  function exportReportPdf() {
    var report = REPORTS[_report] || REPORTS.wip;
    var cols = reportCols(report);
    var rows = report.rows(filteredJobs());
    var lc = labelColCount(cols);
    var logo = location.origin + '/images/logo-color.png';
    var sel = (window.p86Markets && window.p86Markets.selected) ? window.p86Markets.selected() : null;
    var scope = sel ? (sel.name + ' market') : 'All markets';
    var thead = cols.map(function (c) { return '<th class="' + (c.t === 'text' ? 'l' : 'n') + '">' + esc(c.label) + '</th>'; }).join('');
    function pcell(v, t) {
      if (t === 'text') return '<td class="l">' + esc(v == null ? '' : v) + '</td>';
      var neg = (t === 'moneyParen' && num(v) < 0);
      return '<td class="n' + (neg ? ' neg' : '') + '">' + fmtCellVal(v, t) + '</td>';
    }
    function prow(r) { return '<tr>' + cols.map(function (c) { return pcell(r[c.k], c.t); }).join('') + '</tr>'; }
    function ptot(label, list, cls) {
      var t = report.total(list), cells = '';
      cols.forEach(function (c, i) {
        if (i < lc) { if (i === 0) cells += '<td class="l" colspan="' + lc + '"><b>' + esc(label) + '</b></td>'; return; }
        var v = t[c.k], neg = (c.t === 'moneyParen' && num(v) < 0);
        cells += '<td class="n' + (neg ? ' neg' : '') + '"><b>' + fmtCellVal(v, c.t) + '</b></td>';
      });
      return '<tr class="' + cls + '">' + cells + '</tr>';
    }
    var body = '';
    if (rows.length && _groupBy !== 'none') {
      groupRows(rows).forEach(function (g) {
        body += '<tr class="grp"><td colspan="' + cols.length + '">' + esc(groupLabel() + ': ' + g.key) + '</td></tr>';
        g.rows.forEach(function (r) { body += prow(r); });
        body += ptot('Subtotal', g.rows, 'sub');
      });
    } else {
      rows.forEach(function (r) { body += prow(r); });
    }
    var doc = '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(report.name) + ' — Project 86</title><style>' +
      '*{box-sizing:border-box}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:24px;font-size:11px}' +
      '.page{max-width:1100px;margin:0 auto}' +
      '.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1B3A5C;padding-bottom:10px;margin-bottom:6px}' +
      '.hd img{height:42px}.hd .t{text-align:right}.doctitle{font-size:18px;font-weight:bold;color:#1B3A5C}.docsub{font-size:10.5px;color:#666;letter-spacing:.3px}' +
      '.meta{font-size:10px;color:#666;margin-bottom:12px}' +
      'table{width:100%;border-collapse:collapse}' +
      'th{background:#1B3A5C;color:#fff;padding:6px;font-size:9px;text-transform:uppercase;letter-spacing:.3px;border:1px solid #16304d}' +
      'th.l,td.l{text-align:left}th.n,td.n{text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap}' +
      'td{padding:4px 6px;border:1px solid #d5dbe3}tr:nth-child(even) td{background:#f6f8fb}td.neg{color:#b45309}' +
      'tr.grp td{background:#e9eef5;font-weight:bold;color:#1B3A5C}tr.sub td{background:#f0f4fa;font-weight:bold}' +
      'tr.tot td{background:#dbe6f4;font-weight:bold;border-top:2px solid #1B3A5C}' +
      '.bar{position:fixed;top:10px;right:10px}.bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#1B8541;color:#fff;cursor:pointer;font-weight:bold}' +
      '@media print{.bar{display:none}body{padding:0}th,tr.grp td,tr.sub td,tr.tot td,tr:nth-child(even) td{-webkit-print-color-adjust:exact;print-color-adjust:exact}}' +
      '</style></head><body>' +
      '<div class="bar"><button onclick="window.print()">Print / Save PDF</button></div>' +
      '<div class="page">' +
        '<div class="hd"><img src="' + esc(logo) + '" onerror="this.style.display=\'none\'"/>' +
          '<div class="t"><div class="doctitle">' + esc(report.name) + '</div><div class="docsub">Company WIP Insights &middot; Project 86</div></div></div>' +
        '<div class="meta">' + esc(scope) + ' &middot; ' + rows.length + ' job' + (rows.length === 1 ? '' : 's') + ' &middot; generated ' + esc(dateStamp()) + '</div>' +
        '<table><thead><tr>' + thead + '</tr></thead><tbody>' + body + '</tbody>' +
        (rows.length ? '<tfoot>' + ptot('Company total', rows, 'tot') + '</tfoot>' : '') +
        '</table>' +
      '</div></body></html>';
    var w = window.open('', '_blank');
    if (!w) { if (typeof window.p86Toast === 'function') window.p86Toast('Allow pop-ups to open the printable PDF', 'error'); return; }
    w.document.open(); w.document.write(doc); w.document.close();
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
  window.insightsExportCsv = exportReportCsv;
  window.insightsExportXlsx = exportReportXlsx;
  window.insightsExportPdf = exportReportPdf;
  window.renderInsightsDashboard = renderInsightsDashboard;
})();
