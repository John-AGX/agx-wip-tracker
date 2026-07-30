/* ────────────────────────────────────────────────────────────────────────
 * market-pnl.js — per-market P&L rollup (multi-market M3).
 *
 * "Market is a DIMENSION, not a view filter" is only true once you can
 * see a P&L per market. This is that surface: one read-only aggregation
 * of the numbers the rest of the app already computes, grouped by market.
 *
 * ⚠ AGGREGATION ONLY. Every dollar here comes from getJobWIP(), which is
 * the single source of truth for job money (js/jobs.js). This file does
 * not re-derive earned revenue, percent complete, or margin — it sums
 * them. If a number looks wrong here, it is wrong on the job too, and
 * that is where it must be fixed. Re-deriving it here would create the
 * "two models" split that already cost this codebase a week on phase
 * allocation.
 *
 * RECONCILIATION IS THE CONTRACT: Σ(market rows) + unassigned == the org
 * total, over the same job set the Jobs list shows by default
 * (everything except Archived). The table prints the total row so that
 * invariant is visible, not assumed.
 *
 * ⚠ KNOWN UPSTREAM BUG surfaced (NOT fixed) here — see flagZeroEarned():
 * a job whose scopes carry percentages but $0 of allocated contract
 * rolls up revenue-weighted to 0% / $0 earned. That is UNALLOCATED
 * CONTRACT — a data problem on the job, not a formula problem. Summing
 * it into a market inherits the zero, so we COUNT and LABEL those jobs
 * instead of quietly absorbing them. Do not "fix" this by changing the
 * weighted-average math; that would paper over the data across every job.
 * ──────────────────────────────────────────────────────────────────────── */
(function () {
  'use strict';
  if (window.p86MarketPnl) return;

  var UNASSIGNED = '__unassigned__';

  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function money(v) {
    var n = num(v);
    return (n < 0 ? '-' : '') + '$' + Math.abs(Math.round(n)).toLocaleString();
  }
  // Compact form for the wide comparison table, where six money columns
  // at full width would force a horizontal scroll on any laptop.
  function moneyShort(v) {
    var n = num(v), a = Math.abs(n), s = n < 0 ? '-' : '';
    if (a >= 1e6) return s + '$' + (a / 1e6).toFixed(a >= 1e7 ? 1 : 2) + 'M';
    if (a >= 1e3) return s + '$' + Math.round(a / 1e3) + 'k';
    return s + '$' + Math.round(a).toLocaleString();
  }
  function pct(v) { return num(v).toFixed(1) + '%'; }

  // The job set the P&L covers. Archived jobs are excluded, which is
  // exactly what getFilteredJobs() does with no status filter — so the
  // market rows reconcile against what the Jobs list shows rather than
  // against a set the user can't see anywhere.
  function pnlJobs() {
    var jobs = (window.appData && window.appData.jobs) || [];
    return jobs.filter(function (j) { return j && j.status !== 'Archived'; });
  }

  function leadsList() {
    // Leads live in the leads module's own cache, not appData — appData
    // .leads is the legacy/offline copy. Prefer the live cache.
    if (window.p86Leads && typeof window.p86Leads.getCached === 'function') {
      var c = window.p86Leads.getCached();
      if (c && c.length) return c;
    }
    return (window.appData && window.appData.leads) || [];
  }

  function emptyRow(key, market) {
    return {
      key: key,
      market: market || null,
      name: market ? market.name : 'Unassigned',
      code: market ? (market.code || '') : '',
      color: market ? (market.color || '#8b90a5') : '#6b7280',
      jobCount: 0,
      contract: 0,        // total income = contract + approved COs
      earned: 0,          // revenue earned to date
      cost: 0,            // actual cost to date
      backlog: 0,         // contract not yet earned
      wip: 0,             // earned − invoiced (over/(under) billing)
      leads: 0,
      leadsWon: 0,
      estimates: 0,
      zeroEarned: 0       // jobs with contract + progress but $0 earned
    };
  }

  function addJob(row, w, job) {
    row.jobCount++;
    row.contract += num(w.totalIncome);
    row.earned += num(w.revenueEarned);
    row.cost += num(w.actualCosts);
    row.backlog += num(w.backlog);
    row.wip += num(w.unbilled);
    if (flagZeroEarned(w, job)) row.zeroEarned++;
  }

  // A job that HAS a contract and HAS reported progress but rolls up to
  // $0 earned. The live example is "Solace Chimney Cap Replacement"
  // (j1783288956188): its scopes read 75% / 0% and the building card
  // shows 37.5%, but no contract dollars were ever allocated to those
  // scopes, so the revenue-WEIGHTED job percent divides into zero weight
  // and collapses to 0. The contract is real and counts toward the
  // market; the earned revenue is genuinely unknown until the contract is
  // allocated. Counting these is the honest answer — silently summing a
  // zero would understate every market that holds one.
  function flagZeroEarned(w, job) {
    if (num(w.totalIncome) <= 0) return false;      // nothing to earn against
    if (num(w.revenueEarned) > 0) return false;     // earning fine
    if (num(w.actualCosts) > 0) return true;        // spending with $0 earned
    var hasScopes = ((window.appData && window.appData.phases) || [])
      .some(function (p) { return p && p.jobId === job.id && num(p.pctComplete) > 0; });
    return hasScopes;
  }

  /* ── The rollup ────────────────────────────────────────────────────
   * Returns { rows, total, unassigned, coverage } where `rows` is one
   * entry per ACTIVE market (including markets with no work — a $0
   * Denver row is information, not noise) plus an Unassigned row when
   * anything failed to resolve.
   * ─────────────────────────────────────────────────────────────── */
  function compute() {
    var M = window.p86Markets;
    var mk = (M && M.active && M.active()) || [];
    var byKey = {};
    var order = [];

    mk.forEach(function (m) {
      var k = String(m.id);
      byKey[k] = emptyRow(k, m);
      order.push(k);
    });
    byKey[UNASSIGNED] = emptyRow(UNASSIGNED, null);

    function bucketFor(rec) {
      var m = (M && M.resolve) ? M.resolve(rec) : null;
      var k = m ? String(m.id) : UNASSIGNED;
      // A record pointing at a DEACTIVATED market resolves to a market
      // that isn't in `order` — give it a row rather than dropping it,
      // or the totals stop reconciling the moment a market is retired.
      if (!byKey[k]) { byKey[k] = emptyRow(k, m); order.push(k); }
      return byKey[k];
    }

    var total = emptyRow('__total__', null);
    total.name = 'All markets';

    var wipFn = window.getJobWIP;
    pnlJobs().forEach(function (j) {
      var w = {};
      // One job that throws must not take the whole rollup down — it
      // just contributes nothing, and the job count still reflects it.
      try { w = (typeof wipFn === 'function' ? wipFn(j.id) : {}) || {}; } catch (e) { w = {}; }
      addJob(bucketFor(j), w, j);
      addJob(total, w, j);
    });

    leadsList().forEach(function (l) {
      var r = bucketFor(l);
      r.leads++; total.leads++;
      // "Won" = the lead reached sold. Conversion is measured against
      // every lead in the market, not just closed ones, so the number
      // can't be inflated by leaving losses open.
      if (l && l.status === 'sold') { r.leadsWon++; total.leadsWon++; }
    });

    ((window.appData && window.appData.estimates) || []).forEach(function (e) {
      bucketFor(e).estimates++; total.estimates++;
    });

    var rows = order.map(function (k) { return byKey[k]; });
    var unassigned = byKey[UNASSIGNED];

    return { rows: rows, unassigned: unassigned, total: total };
  }

  function marginPct(r) { return r.earned > 0 ? ((r.earned - r.cost) / r.earned * 100) : 0; }
  function convPct(r) { return r.leads > 0 ? (r.leadsWon / r.leads * 100) : 0; }
  function marginColor(m) { return m >= 30 ? '#34d399' : m >= 15 ? '#fbbf24' : m > 0 ? '#f59e0b' : '#f87171'; }

  /* ── Rendering ─────────────────────────────────────────────────── */

  function dot(color) {
    return '<span class="p86-mkt-dot" style="background:' + esc(color) + ';"></span>';
  }

  function rowHTML(r, isTotal) {
    var m = marginPct(r);
    var cls = isTotal ? ' class="p86-mktpnl-total"' : '';
    var label = isTotal
      ? '<strong>' + esc(r.name) + '</strong>'
      : dot(r.color) + esc(r.name) + (r.code ? '<span class="p86-mktpnl-code">' + esc(r.code) + '</span>' : '');
    // A market with no work still prints its row, dimmed — "Denver: $0"
    // is the answer to "how is Denver doing", not an empty cell.
    var dim = (!isTotal && !r.jobCount && !r.leads) ? ' p86-mktpnl-quiet' : '';
    return '<tr' + (cls || (dim ? ' class="' + dim.trim() + '"' : '')) + '>' +
      '<td class="p86-mktpnl-name">' + label + '</td>' +
      '<td class="num">' + r.jobCount + '</td>' +
      '<td class="num">' + moneyShort(r.contract) + '</td>' +
      '<td class="num">' + moneyShort(r.earned) + '</td>' +
      '<td class="num">' + moneyShort(r.cost) + '</td>' +
      '<td class="num" style="color:' + marginColor(m) + ';font-weight:600;">' + pct(m) + '</td>' +
      '<td class="num">' + moneyShort(r.backlog) + '</td>' +
      '<td class="num" title="Earned minus invoiced. Positive = under-billed (work done, not yet billed).">' + moneyShort(r.wip) + '</td>' +
      '<td class="num" title="' + r.leadsWon + ' sold of ' + r.leads + ' leads">' +
        (r.leads ? pct(convPct(r)) + '<span class="p86-mktpnl-sub">' + r.leadsWon + '/' + r.leads + '</span>' : '<span class="p86-mktpnl-sub">—</span>') +
      '</td>' +
    '</tr>';
  }

  var HEAD =
    '<tr>' +
      '<th>Market</th>' +
      '<th class="num" title="Jobs excluding Archived">Jobs</th>' +
      '<th class="num" title="Contract + approved change orders">Contract</th>' +
      '<th class="num" title="Revenue earned to date">Earned</th>' +
      '<th class="num" title="Actual cost to date">Cost</th>' +
      '<th class="num" title="(Earned − Cost) ÷ Earned">Margin</th>' +
      '<th class="num" title="Contract not yet earned">Backlog</th>' +
      '<th class="num" title="Earned − invoiced">WIP</th>' +
      '<th class="num" title="Leads sold ÷ leads">Lead conv.</th>' +
    '</tr>';

  // Single-market view: the same figures for the one selected market,
  // as tiles rather than a comparison table. Deliberately the SAME
  // numbers as that market's row under All markets — if these two ever
  // disagree, the rollup is broken.
  function singleHTML(r) {
    var m = marginPct(r);
    var tiles = [
      { label: 'Contract', value: money(r.contract), color: 'var(--accent,#4f8cff)' },
      { label: 'Earned', value: money(r.earned), color: '#34d399' },
      { label: 'Actual cost', value: money(r.cost), color: '#f87171' },
      { label: 'Margin', value: pct(m), color: marginColor(m) },
      { label: 'Backlog', value: money(r.backlog), color: '#fbbf24' },
      { label: 'WIP', value: money(r.wip), color: 'var(--text,#fff)' },
      { label: 'Lead conv.', value: r.leads ? pct(convPct(r)) : '—', color: '#22d3ee' }
    ];
    return '<div class="p86-mktpnl-head">' +
        dot(r.color) + '<strong>' + esc(r.name) + '</strong>' +
        (r.code ? '<span class="p86-mktpnl-code">' + esc(r.code) + '</span>' : '') +
        '<span class="p86-mktpnl-sub">' + r.jobCount + ' job' + (r.jobCount === 1 ? '' : 's') +
          ' · ' + r.leads + ' lead' + (r.leads === 1 ? '' : 's') +
          ' · ' + r.estimates + ' estimate' + (r.estimates === 1 ? '' : 's') + '</span>' +
      '</div>' +
      '<div class="p86-mktpnl-tiles">' +
        tiles.map(function (t) {
          return '<div class="p86-mktpnl-tile">' +
            '<div class="p86-mktpnl-tile-label">' + esc(t.label) + '</div>' +
            '<div class="p86-mktpnl-tile-value" style="color:' + t.color + ';">' + t.value + '</div>' +
          '</div>';
        }).join('') +
      '</div>';
  }

  // The unallocated-contract warning. Reports the upstream bug where it
  // is visible; does not adjust a single number to hide it.
  function warnHTML(n) {
    if (!n) return '';
    return '<div class="p86-mktpnl-warn">' +
      '<strong>' + n + ' job' + (n === 1 ? '' : 's') + '</strong> ' +
      (n === 1 ? 'has' : 'have') + ' a contract and reported progress but roll up to <strong>$0 earned</strong> — ' +
      'their contract was never allocated across scopes, so the revenue-weighted percent has nothing to weight. ' +
      'Contract and cost above are correct; earned revenue and margin are understated by that amount. ' +
      'Fix by allocating the contract on the job, not here.' +
    '</div>';
  }

  function renderInto(host) {
    if (!host) return;
    var M = window.p86Markets;
    // Nothing to compare in a single-market org — and the switcher is
    // hidden there too, so the whole section stays out of the way.
    if (!M || !M.hasMulti || !M.hasMulti()) { host.innerHTML = ''; host.hidden = true; return; }
    host.hidden = false;

    var data = compute();
    var selId = M.selectedId && M.selectedId();

    // Section label is emitted HERE, not in the Summary markup, so the
    // whole block (label included) disappears on a single-market org
    // rather than leaving a heading over nothing.
    var label = '<div class="p86-cmd-sectlabel">' +
      (selId ? 'Market P&amp;L' : 'Markets — P&amp;L comparison') + '</div>';

    if (selId) {
      var mine = data.rows.filter(function (r) { return r.key === String(selId); })[0];
      if (!mine) { mine = emptyRow(String(selId), M.byId(selId)); }
      host.innerHTML = label + singleHTML(mine) + warnHTML(mine.zeroEarned);
      return;
    }

    // All markets — the comparison table + the reconciling total row.
    var body = data.rows.map(function (r) { return rowHTML(r, false); }).join('');
    // Only show Unassigned when something actually landed there; an
    // always-visible empty row implies a problem that doesn't exist.
    if (data.unassigned.jobCount || data.unassigned.leads || data.unassigned.estimates) {
      body += rowHTML(data.unassigned, false);
    }
    host.innerHTML = label +
      '<div class="p86-mktpnl-scroll">' +
        '<table class="p86-mktpnl-table">' +
          '<thead>' + HEAD + '</thead>' +
          '<tbody>' + body + '</tbody>' +
          '<tfoot>' + rowHTML(data.total, true) + '</tfoot>' +
        '</table>' +
      '</div>' +
      warnHTML(data.total.zeroEarned);
  }

  function render() {
    var host = document.getElementById('summary-market-pnl');
    if (host) renderInto(host);
  }

  window.p86MarketPnl = { compute: compute, render: render, renderInto: renderInto };
  // Named global so js/markets.js can repaint just this block on a market
  // switch instead of re-running the whole Summary dashboard.
  window.p86MarketPnlRender = render;
})();
