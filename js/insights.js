// AGX Insights dashboard — read-only roll-up of closed-week snapshots.
//
// Source of truth: each job stores `weeklySnapshots[]` (an array of {weekOf,
// closedAt, job: {pctComplete, totalIncome, ..., backlog}, ...}). These get
// captured by the Close Week button on the job detail view, and live inside
// the job blob so they sync to the server with everything else.
//
// What this module renders into #insights-dashboard:
//   1. Date selector (which closed week to view as "current")
//   2. KPI cards: Backlog, Revenue Earned, Profit, Margin % — each with
//      week-over-week delta vs the closed week immediately preceding the
//      selected one.
//   3. Per-job ticker table: every job that has a snapshot in the selected
//      week, with delta indicators per column.
//   4. Historical list: every closed week in the last 90 days summarized.
(function() {
  'use strict';

  function fmtCurrency(v) {
    if (v == null || isNaN(v)) return '$0';
    var abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(v).toLocaleString();
  }
  function fmtPct(v, digits) {
    if (v == null || isNaN(v)) return '0%';
    return v.toFixed(digits == null ? 1 : digits) + '%';
  }
  function fmtSignedCurrency(v) {
    var prefix = v > 0 ? '+' : '';
    return prefix + fmtCurrency(v);
  }
  function fmtSignedPct(v, digits) {
    var prefix = v > 0 ? '+' : '';
    return prefix + (v == null || isNaN(v) ? '0' : v.toFixed(digits == null ? 1 : digits)) + '%';
  }
  function deltaClass(v) {
    if (v == null || isNaN(v) || Math.abs(v) < 0.01) return 'delta-flat';
    return v > 0 ? 'delta-up' : 'delta-down';
  }
  function deltaArrow(v) {
    if (v == null || isNaN(v) || Math.abs(v) < 0.01) return '–';
    return v > 0 ? '↑' : '↓';
  }

  // Given an array of jobs, produce a sorted unique list of all weekOf dates
  // present across their snapshots. Newest first.
  function getAllWeekOfDates(jobs) {
    var set = {};
    (jobs || []).forEach(function(j) {
      (j.weeklySnapshots || []).forEach(function(s) {
        if (s.weekOf) set[s.weekOf] = true;
      });
    });
    return Object.keys(set).sort().reverse();
  }

  // Returns each job's snapshot for the given weekOf, or null if none.
  function snapshotsForWeek(jobs, weekOf) {
    return (jobs || []).map(function(j) {
      var snap = (j.weeklySnapshots || []).find(function(s) { return s.weekOf === weekOf; });
      return snap ? Object.assign({}, snap, { _job: j }) : null;
    }).filter(Boolean);
  }

  // Sum a metric across all jobs' snapshots for a given week. Missing jobs
  // contribute 0. Returns aggregate { backlog, revEarned, grossProfit, marginPct }.
  function aggregateForWeek(jobs, weekOf) {
    var snaps = snapshotsForWeek(jobs, weekOf);
    var sum = { backlog: 0, revEarned: 0, grossProfit: 0, totalIncome: 0, actualCosts: 0 };
    snaps.forEach(function(s) {
      var j = s.job || {};
      sum.backlog += j.backlog || 0;
      sum.revEarned += j.revEarned || 0;
      sum.grossProfit += j.grossProfit || 0;
      sum.totalIncome += j.totalIncome || 0;
      sum.actualCosts += j.actualCosts || 0;
    });
    sum.marginPct = sum.revEarned > 0 ? (sum.grossProfit / sum.revEarned) * 100 : 0;
    return sum;
  }

  // Filter a sorted-desc weekOf array to only those within the last `days` days
  function recentWeeks(weeks, days) {
    var cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - days);
    var cutoffStr = cutoff.toISOString().slice(0, 10);
    return weeks.filter(function(w) { return w >= cutoffStr; });
  }

  // ── Rendering ──────────────────────────────────────────────────────────

  function kpiCard(label, value, deltaValue, deltaLabel) {
    var dCls = deltaClass(deltaValue);
    var arrow = deltaArrow(deltaValue);
    return '<div style="flex:1 1 180px;min-width:180px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;padding:14px 16px;">' +
      '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">' + label + '</div>' +
      '<div style="font-size:22px;font-weight:600;color:var(--text,#fff);">' + value + '</div>' +
      '<div style="font-size:12px;margin-top:4px;" class="' + dCls + '">' + arrow + ' ' + (deltaLabel || '') + '</div>' +
    '</div>';
  }

  function tickerRow(s, prevSnap) {
    var j = s._job;
    var cur = s.job || {};
    var prev = prevSnap ? (prevSnap.job || {}) : null;
    var pctDelta = prev ? (cur.pctComplete - prev.pctComplete) : null;
    var costDelta = prev ? (cur.actualCosts - prev.actualCosts) : null;
    var revDelta = prev ? (cur.revEarned - prev.revEarned) : null;
    var marginCur = cur.revEarned > 0 ? (cur.grossProfit / cur.revEarned) * 100 : 0;
    var marginPrev = (prev && prev.revEarned > 0) ? (prev.grossProfit / prev.revEarned) * 100 : null;
    var marginDelta = (marginPrev != null) ? (marginCur - marginPrev) : null;

    function cell(value, delta, type) {
      var deltaText = '';
      if (delta != null) {
        var dStr;
        if (type === 'pct') dStr = fmtSignedPct(delta);
        else if (type === 'pp') dStr = fmtSignedPct(delta, 1) + ' pp';
        else dStr = fmtSignedCurrency(delta);
        deltaText = '<div class="' + deltaClass(delta) + '" style="font-size:10px;margin-top:2px;">' + deltaArrow(delta) + ' ' + dStr + '</div>';
      }
      return '<td style="padding:8px 10px;text-align:right;">' +
             '<div>' + value + '</div>' + deltaText + '</td>';
    }

    return '<tr style="border-bottom:1px solid var(--border,#333);">' +
      '<td style="padding:8px 10px;color:var(--text,#fff);">' +
        '<div style="font-weight:600;font-size:13px;">' + escapeHTML(j.title || j.id) + '</div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);">' + escapeHTML(j.jobNumber || '') +
        (j.client ? ' · ' + escapeHTML(j.client) : '') + '</div>' +
      '</td>' +
      cell(fmtPct(cur.pctComplete), pctDelta, 'pct') +
      cell(fmtCurrency(cur.totalIncome), null) +
      cell(fmtCurrency(cur.revEarned), revDelta) +
      cell(fmtCurrency(cur.actualCosts), costDelta) +
      cell(fmtPct(marginCur), marginDelta, 'pp') +
    '</tr>';
  }

  function historyRow(weekOf, agg) {
    return '<tr style="border-bottom:1px solid var(--border,#333);">' +
      '<td style="padding:6px 10px;color:var(--text,#fff);font-size:12px;">' + weekOf + '</td>' +
      '<td style="padding:6px 10px;text-align:right;font-size:12px;">' + fmtCurrency(agg.backlog) + '</td>' +
      '<td style="padding:6px 10px;text-align:right;font-size:12px;">' + fmtCurrency(agg.revEarned) + '</td>' +
      '<td style="padding:6px 10px;text-align:right;font-size:12px;">' + fmtCurrency(agg.grossProfit) + '</td>' +
      '<td style="padding:6px 10px;text-align:right;font-size:12px;">' + fmtPct(agg.marginPct) + '</td>' +
    '</tr>';
  }

  function renderEmpty(message) {
    document.getElementById('insights-dashboard').innerHTML =
      '<div style="text-align:center;padding:60px 20px;color:var(--text-dim,#888);">' +
        '<div style="font-size:14px;margin-bottom:8px;">' + escapeHTML(message) + '</div>' +
        '<div style="font-size:12px;">Open a job and click <strong>&#x1F4C5; Close Week</strong> on the WIP tab to capture a snapshot. ' +
        'After two closed weeks exist you\'ll see week-over-week deltas here.</div>' +
      '</div>';
  }

  function renderInsightsDashboard() {
    var dash = document.getElementById('insights-dashboard');
    if (!dash) return;
    var allJobs = (window.appData && appData.jobs) || [];
    // Only Live jobs appear on Insights — Draft jobs are still being prepped
    // and shouldn't pollute the dashboard. Admins toggle status from the
    // Admin → Metrics sub-tab.
    var jobs = allJobs.filter(function(j) { return j.liveStatus === 'live'; });
    var draftCount = allJobs.length - jobs.length;
    if (!allJobs.length) {
      renderEmpty('No jobs yet.');
      return;
    }
    if (!jobs.length) {
      renderEmpty('No Live jobs yet — go to Admin → Metrics and click Go Live on any job whose data is verified.');
      return;
    }
    var allWeeks = getAllWeekOfDates(jobs);
    if (!allWeeks.length) {
      renderEmpty('Live jobs found, but no closed weeks yet.');
      return;
    }

    // Selected week defaults to most recent. If a previous render stored a
    // selection on window._insightsSelectedWeek, honor it as long as it's still
    // a valid date in the list.
    var selectedWeek = window._insightsSelectedWeek;
    if (!selectedWeek || allWeeks.indexOf(selectedWeek) === -1) selectedWeek = allWeeks[0];
    var selectedIdx = allWeeks.indexOf(selectedWeek);
    var prevWeek = allWeeks[selectedIdx + 1] || null;

    var aggCur = aggregateForWeek(jobs, selectedWeek);
    var aggPrev = prevWeek ? aggregateForWeek(jobs, prevWeek) : null;

    function delta(field) {
      if (!aggPrev) return null;
      return aggCur[field] - aggPrev[field];
    }
    function deltaPct(field) {
      if (!aggPrev || !aggPrev[field]) return null;
      return ((aggCur[field] - aggPrev[field]) / Math.abs(aggPrev[field])) * 100;
    }

    // --- Week selector ---
    var weekOpts = allWeeks.map(function(w) {
      return '<option value="' + w + '"' + (w === selectedWeek ? ' selected' : '') + '>' + w + '</option>';
    }).join('');
    var headerHtml =
      '<div style="display:flex;align-items:center;gap:14px;margin-bottom:18px;flex-wrap:wrap;">' +
        '<div>' +
          '<label style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;display:block;margin-bottom:4px;">Week of</label>' +
          '<select id="insights-week-select" onchange="setInsightsWeek(this.value)" style="padding:8px 12px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:6px;font-size:13px;">' +
            weekOpts +
          '</select>' +
        '</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#888);align-self:flex-end;padding-bottom:8px;">' +
          (prevWeek ? 'Compared to week of <strong>' + prevWeek + '</strong>' : 'No prior closed week to compare') +
        '</div>' +
      '</div>';

    // --- KPI cards ---
    var kpiHtml = '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:24px;">' +
      kpiCard('Backlog', fmtCurrency(aggCur.backlog),
              delta('backlog'),
              aggPrev ? fmtSignedCurrency(delta('backlog')) + ' (' + fmtSignedPct(deltaPct('backlog')) + ')' : 'no prior week') +
      kpiCard('Revenue Earned', fmtCurrency(aggCur.revEarned),
              delta('revEarned'),
              aggPrev ? fmtSignedCurrency(delta('revEarned')) + ' (' + fmtSignedPct(deltaPct('revEarned')) + ')' : 'no prior week') +
      kpiCard('Profit', fmtCurrency(aggCur.grossProfit),
              delta('grossProfit'),
              aggPrev ? fmtSignedCurrency(delta('grossProfit')) + ' (' + fmtSignedPct(deltaPct('grossProfit')) + ')' : 'no prior week') +
      kpiCard('Margin', fmtPct(aggCur.marginPct),
              aggPrev ? (aggCur.marginPct - aggPrev.marginPct) : null,
              aggPrev ? fmtSignedPct(aggCur.marginPct - aggPrev.marginPct, 1) + ' pp' : 'no prior week') +
    '</div>';

    // --- Per-job ticker ---
    var snapsCur = snapshotsForWeek(jobs, selectedWeek);
    var snapsPrev = prevWeek ? snapshotsForWeek(jobs, prevWeek) : [];
    var prevByJob = {};
    snapsPrev.forEach(function(s) { prevByJob[s._job.id] = s; });

    var tickerRows = snapsCur
      .sort(function(a, b) { return (b.job.totalIncome || 0) - (a.job.totalIncome || 0); })
      .map(function(s) { return tickerRow(s, prevByJob[s._job.id]); })
      .join('');
    var tickerHtml =
      '<div style="margin-bottom:24px;">' +
        '<h3 style="margin:0 0 10px;font-size:14px;color:var(--text,#fff);">Jobs — ' + selectedWeek + '</h3>' +
        '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;">' +
          '<table style="width:100%;border-collapse:collapse;">' +
            '<thead><tr style="background:rgba(255,255,255,0.02);">' +
              '<th style="padding:10px;text-align:left;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Job</th>' +
              '<th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">% Complete</th>' +
              '<th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Contract + CO</th>' +
              '<th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Revenue Earned</th>' +
              '<th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Costs</th>' +
              '<th style="padding:10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Margin</th>' +
            '</tr></thead>' +
            '<tbody>' + (tickerRows || '<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-dim,#888);">No jobs had a snapshot in this week.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';

    // --- Historical (last 90 days) ---
    var histWeeks = recentWeeks(allWeeks, 90);
    var histRows = histWeeks.map(function(w) {
      return historyRow(w, aggregateForWeek(jobs, w));
    }).join('');
    var histHtml =
      '<div>' +
        '<h3 style="margin:0 0 10px;font-size:14px;color:var(--text,#fff);">History (last 90 days)</h3>' +
        '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;">' +
          '<table style="width:100%;border-collapse:collapse;">' +
            '<thead><tr style="background:rgba(255,255,255,0.02);">' +
              '<th style="padding:8px 10px;text-align:left;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Week of</th>' +
              '<th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Backlog</th>' +
              '<th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Revenue Earned</th>' +
              '<th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Profit</th>' +
              '<th style="padding:8px 10px;text-align:right;font-size:10px;text-transform:uppercase;color:var(--text-dim,#888);letter-spacing:0.5px;">Margin</th>' +
            '</tr></thead>' +
            '<tbody>' + (histRows || '<tr><td colspan="5" style="padding:20px;text-align:center;color:var(--text-dim,#888);">No closed weeks in the last 90 days.</td></tr>') + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>';

    dash.innerHTML = headerHtml + kpiHtml + tickerHtml + histHtml;
  }

  function setInsightsWeek(w) {
    window._insightsSelectedWeek = w;
    renderInsightsDashboard();
  }

  // Inject delta color rules once (the rest of the styling is inline so it
  // doesn't fight existing theme variables in styles.css).
  (function injectStyles() {
    if (document.getElementById('insights-styles')) return;
    var s = document.createElement('style');
    s.id = 'insights-styles';
    s.textContent =
      '.delta-up { color: #34d399; }' +
      '.delta-down { color: #e74c3c; }' +
      '.delta-flat { color: var(--text-dim, #888); }';
    document.head.appendChild(s);
  })();

  window.renderInsightsDashboard = renderInsightsDashboard;
  window.setInsightsWeek = setInsightsWeek;
})();
