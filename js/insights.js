// AGX Insights dashboard — single source of truth.
//
// Replaces both an earlier minimal version of this file and a legacy copy
// of renderInsightsDashboard() that lived in js/wip.js. Pulls Live-only
// jobs from window.appData, merges each job's dailySnapshots[] (new) with
// any legacy weeklySnapshots[] (daily wins on overlapping dates), and
// renders:
//   1. Six KPI summary cards (totals across Live jobs)
//   2. Combined Revenue vs Costs bar chart by snapshot date
//   3. Per-job performance cards with progress bars and sparkline trend
//   4. Heat map of revenue-earned deltas (jobs x snapshot dates)
//   5. Combined backlog burn-down vs revenue line chart
(function() {
  'use strict';

  // ── Formatters ────────────────────────────────────────────────────────
  function fmtCurrency(v) {
    if (v == null || isNaN(v)) return '$0';
    var abs = Math.abs(v);
    if (abs >= 1e6) return '$' + (v / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return '$' + (v / 1e3).toFixed(1) + 'k';
    return '$' + Math.round(v).toLocaleString();
  }
  function fmtBigCurrency(v) {
    if (v == null || isNaN(v)) return '$0';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(v);
  }
  function fmtPct(v, digits) {
    if (v == null || isNaN(v)) return '0%';
    return v.toFixed(digits == null ? 1 : digits) + '%';
  }

  // ── Snapshot helpers ──────────────────────────────────────────────────
  // For a job, return the merged snapshot list (daily preferred, weekly as
  // fallback for legacy data), each tagged with a `dateKey` (YYYY-MM-DD).
  function jobSnapshots(j) {
    var out = [];
    var seen = {};
    (j.dailySnapshots || []).forEach(function(s) {
      var key = s.dateKey || s.weekOf;
      if (!key) return;
      seen[key] = true;
      out.push(Object.assign({}, s, { dateKey: key }));
    });
    (j.weeklySnapshots || []).forEach(function(s) {
      var key = s.weekOf;
      if (!key || seen[key]) return;
      out.push(Object.assign({}, s, { dateKey: key }));
    });
    return out;
  }

  // Sorted unique list of all dateKey values across all jobs' snapshots.
  // Ascending (oldest first) for chart x-axis ordering.
  function getAllDates(jobs) {
    var set = {};
    (jobs || []).forEach(function(j) {
      jobSnapshots(j).forEach(function(s) {
        if (s.dateKey) set[s.dateKey] = true;
      });
    });
    return Object.keys(set).sort();
  }

  // Sparkline as inline SVG. Pure dependency-free polyline normalized to
  // the viewBox, with a small dot at the latest point.
  function sparklineSVG(values, color, opts) {
    opts = opts || {};
    var width = opts.width || 110;
    var height = opts.height || 22;
    if (!values || values.length < 2) return '';
    var min = Math.min.apply(null, values);
    var max = Math.max.apply(null, values);
    var range = (max - min) || 1;
    var pad = 2;
    var n = values.length;
    var pts = values.map(function(v, i) {
      var x = pad + (i / (n - 1)) * (width - pad * 2);
      var y = pad + (height - pad * 2) - ((v - min) / range) * (height - pad * 2);
      return x.toFixed(1) + ',' + y.toFixed(1);
    }).join(' ');
    var last = values[values.length - 1];
    var lastX = pad + (width - pad * 2);
    var lastY = pad + (height - pad * 2) - ((last - min) / range) * (height - pad * 2);
    return '<svg width="' + width + '" height="' + height + '" style="display:block;margin-top:4px;overflow:visible;" aria-hidden="true">' +
      '<polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="1.4" stroke-linejoin="round" stroke-linecap="round" opacity="0.85" />' +
      '<circle cx="' + lastX.toFixed(1) + '" cy="' + lastY.toFixed(1) + '" r="1.8" fill="' + color + '" />' +
      '</svg>';
  }

  function metricSeries(job, fieldExtractor, limit) {
    var snaps = jobSnapshots(job).sort(function(a, b) { return a.dateKey < b.dateKey ? -1 : 1; });
    if (limit && snaps.length > limit) snaps = snaps.slice(-limit);
    return snaps.map(fieldExtractor);
  }

  // ── Empty-state rendering ─────────────────────────────────────────────
  function renderEmpty(message) {
    document.getElementById('insights-dashboard').innerHTML =
      '<div style="text-align:center;padding:60px 20px;color:var(--text-dim,#888);">' +
        '<div style="font-size:14px;margin-bottom:8px;">' + escapeHTML(message) + '</div>' +
        '<div style="font-size:12px;">Snapshots are captured automatically at 3 AM EST for Live jobs. ' +
        'Mark jobs Live in <strong>Admin → Metrics</strong>, or use <strong>Capture Now</strong> to trigger one immediately.</div>' +
      '</div>';
  }

  // ── Main render ───────────────────────────────────────────────────────
  function renderInsightsDashboard() {
    var dash = document.getElementById('insights-dashboard');
    if (!dash) return;
    var allJobs = (window.appData && appData.jobs) || [];
    var jobs = allJobs.filter(function(j) { return j.liveStatus === 'live' && j.status !== 'Archived'; });
    if (!allJobs.length) return renderEmpty('No jobs yet.');
    if (!jobs.length) return renderEmpty('No Live jobs yet — go to Admin → Metrics and click Go Live on any job whose data is verified.');

    var allDates = getAllDates(jobs);
    var jobsWithSnaps = jobs.filter(function(j) { return jobSnapshots(j).length > 0; });

    // ── Live totals (current state, not snapshot-derived) ─────
    var totalIncome = 0, totalRevEarned = 0, totalActualCosts = 0, totalBacklog = 0, totalAccrued = 0;
    jobs.forEach(function(j) {
      if (typeof getJobWIP !== 'function') return;
      try {
        var w = getJobWIP(j.id);
        totalIncome += w.totalIncome || 0;
        totalRevEarned += w.revenueEarned || 0;
        totalActualCosts += w.actualCosts || 0;
        totalBacklog += w.backlog || 0;
        if (typeof getJobAccruedCosts === 'function') totalAccrued += getJobAccruedCosts(j.id) || 0;
      } catch (e) { /* skip uncomputable jobs */ }
    });
    var totalProfit = totalRevEarned - totalActualCosts;
    var avgPct = totalIncome > 0 ? (totalRevEarned / totalIncome * 100) : 0;

    var html = '';

    // Header
    html += '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;flex-wrap:wrap;gap:8px;">' +
      '<h2 style="font-size:18px;margin:0;color:var(--text,#fff);">Company WIP Insights</h2>' +
      '<span style="font-size:12px;color:var(--text-dim,#888);">' +
        jobs.length + ' Live jobs &middot; ' + jobsWithSnaps.length + ' with snapshots &middot; ' + allDates.length + ' day' + (allDates.length === 1 ? '' : 's') + ' tracked' +
      '</span></div>';

    // KPI cards
    var kpis = [
      { label: 'Total Pipeline', value: fmtBigCurrency(totalIncome), color: 'var(--accent, #4f8cff)' },
      { label: 'Rev Earned', value: fmtBigCurrency(totalRevEarned), color: 'var(--green, #34d399)' },
      { label: 'Actual Costs', value: fmtBigCurrency(totalActualCosts), color: 'var(--red, #f87171)' },
      { label: 'Gross Profit', value: fmtBigCurrency(totalProfit), color: totalProfit >= 0 ? 'var(--green, #34d399)' : 'var(--red, #f87171)' },
      { label: 'Backlog', value: fmtBigCurrency(totalBacklog), color: 'var(--yellow, #fbbf24)' },
      { label: 'Avg % Complete', value: fmtPct(avgPct), color: 'var(--accent, #4f8cff)' }
    ];
    html += '<div style="display:flex;gap:10px;margin-bottom:16px;flex-wrap:wrap;">';
    kpis.forEach(function(k) {
      html += '<div class="card" style="flex:1;min-width:130px;padding:12px 14px;text-align:center;">' +
        '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + k.label + '</div>' +
        '<div style="font-size:20px;font-weight:700;color:' + k.color + ';">' + k.value + '</div></div>';
    });
    html += '</div>';

    if (allDates.length === 0) {
      html += '<div class="card" style="padding:30px;text-align:center;color:var(--text-dim,#888);">' +
        'No snapshots yet for any Live job. The 3 AM EST scheduler will capture today\'s data automatically — ' +
        'or run Capture Now in Admin → Metrics.</div>';
      dash.innerHTML = html;
      return;
    }

    // Combined Revenue vs Costs bar chart
    html += '<div class="card" style="padding:14px;margin-bottom:14px;">' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-dim,#888);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">All Live Jobs — Revenue vs Costs by Day</div>' +
      '<canvas id="insights-wf-chart" width="800" height="200" style="width:100%;height:200px;"></canvas>' +
    '</div>';

    // Per-job performance cards (with progress bar + sparkline)
    html += '<div class="card" style="padding:14px;margin-bottom:14px;">' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-dim,#888);margin-bottom:8px;text-transform:uppercase;letter-spacing:0.5px;">Job Performance</div>' +
      '<div style="display:flex;gap:10px;overflow-x:auto;padding-bottom:6px;">';
    jobs.forEach(function(j) {
      var w;
      try { w = getJobWIP(j.id); } catch (e) { w = { totalIncome: 0, revenueEarned: 0, actualCosts: 0, pctComplete: 0 }; }
      var profit = (w.revenueEarned || 0) - (w.actualCosts || 0);
      var margin = w.revenueEarned > 0 ? (profit / w.revenueEarned * 100) : 0;
      var snapCount = jobSnapshots(j).length;
      var borderColor = margin >= 15 ? '#34d399' : margin >= 0 ? '#fbbf24' : '#f87171';
      var revSeries = metricSeries(j, function(x) { return (x.job||{}).revEarned || 0; }, 14);
      var sparkColor = margin >= 0 ? '#34d399' : '#f87171';
      html += '<div style="flex:0 0 auto;min-width:200px;padding:10px 12px;border-radius:8px;background:var(--surface2,rgba(255,255,255,0.04));border-left:3px solid ' + borderColor + ';">' +
        '<div style="font-size:11px;font-weight:600;margin-bottom:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--text,#fff);" title="' + escapeHTML(j.title || '') + '">' +
          escapeHTML((j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || 'Untitled')) +
        '</div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;"><span>Income</span><b style="color:var(--text,#fff);">' + fmtCurrency(w.totalIncome) + '</b></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;"><span>Rev Earned</span><b style="color:#34d399;">' + fmtCurrency(w.revenueEarned) + '</b></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;"><span>Margin</span><b style="color:' + borderColor + ';">' + fmtPct(margin) + '</b></div>' +
        '<div style="margin-top:6px;height:4px;border-radius:2px;background:var(--border,#333);overflow:hidden;">' +
          '<div style="height:100%;width:' + Math.min(w.pctComplete || 0, 100) + '%;background:' + borderColor + ';border-radius:2px;"></div>' +
        '</div>' +
        '<div style="font-size:9px;color:var(--text-dim,#888);text-align:right;margin-top:2px;">' + fmtPct(w.pctComplete || 0) + ' &middot; ' + snapCount + ' snap' + (snapCount === 1 ? '' : 's') + '</div>' +
        sparklineSVG(revSeries, sparkColor, { width: 176, height: 22 }) +
      '</div>';
    });
    html += '</div></div>';

    // Heat map: jobs x dates, cell value = rev earned delta
    if (jobsWithSnaps.length > 0) {
      html += '<div class="card" style="padding:14px;margin-bottom:14px;">' +
        '<div style="font-size:11px;font-weight:600;color:var(--text-dim,#888);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Daily Revenue Earned — All Live Jobs Heat Map</div>' +
        '<div style="overflow-x:auto;"><table style="border-collapse:collapse;font-size:10px;width:100%;">';
      html += '<thead><tr><th style="padding:4px 6px;text-align:left;border-bottom:1px solid var(--border,#333);color:var(--text-dim,#888);">Job</th>';
      allDates.forEach(function(d) {
        html += '<th style="padding:4px 4px;text-align:center;border-bottom:1px solid var(--border,#333);color:var(--text-dim,#888);min-width:50px;">' + d.substring(5) + '</th>';
      });
      html += '</tr></thead><tbody>';
      jobsWithSnaps.forEach(function(j) {
        html += '<tr>' +
          '<td style="padding:3px 6px;border-bottom:1px solid var(--border,#333);white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis;color:var(--text,#fff);">' +
            escapeHTML((j.jobNumber ? j.jobNumber + ' ' : '') + (j.title || '')) +
          '</td>';
        var prevRev = 0;
        var snaps = jobSnapshots(j);
        var byDate = {};
        snaps.forEach(function(s) { byDate[s.dateKey] = s; });
        allDates.forEach(function(d) {
          var snap = byDate[d];
          var rev = snap ? (snap.job ? snap.job.revEarned || 0 : 0) : prevRev;
          var delta = rev - prevRev;
          if (snap) prevRev = rev;
          var bg, fg;
          if (!snap) { bg = 'transparent'; fg = 'var(--text-dim,#888)'; }
          else if (delta > 10000) { bg = 'rgba(52,211,153,0.3)'; fg = '#34d399'; }
          else if (delta > 1000) { bg = 'rgba(52,211,153,0.15)'; fg = '#34d399'; }
          else if (delta > 0) { bg = 'rgba(251,191,36,0.15)'; fg = '#f59e0b'; }
          else { bg = 'rgba(139,144,165,0.08)'; fg = 'var(--text-dim,#888)'; }
          var cellText = snap
            ? (delta >= 1000 ? '+$' + (delta / 1000).toFixed(0) + 'k' : delta > 0 ? '+$' + delta.toFixed(0) : '—')
            : '—';
          html += '<td style="padding:3px 4px;text-align:center;border-bottom:1px solid var(--border,#333);background:' + bg + ';color:' + fg + ';font-weight:' + (delta > 0 ? '600' : '400') + ';">' + cellText + '</td>';
        });
        html += '</tr>';
      });
      html += '</tbody></table></div></div>';
    }

    // Backlog burn-down chart
    html += '<div class="card" style="padding:14px;">' +
      '<div style="font-size:11px;font-weight:600;color:var(--text-dim,#888);margin-bottom:6px;text-transform:uppercase;letter-spacing:0.5px;">Combined Backlog Burn-Down</div>' +
      '<canvas id="insights-bd-chart" width="800" height="160" style="width:100%;height:160px;"></canvas>' +
    '</div>';

    dash.innerHTML = html;

    // ── Draw canvases (defer so layout settles first) ─────────
    setTimeout(function() {
      drawRevCostBars(jobsWithSnaps, allDates);
      drawBacklogBurnDown(jobsWithSnaps, allDates);
    }, 50);
  }

  function drawRevCostBars(jobsWithSnaps, allDates) {
    var canvas = document.getElementById('insights-wf-chart');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    var W = canvas.width = canvas.offsetWidth * 2;
    var H = canvas.height = 400;
    ctx.scale(2, 2);
    var w = W / 2, h = H / 2;
    var pad = { t: 20, r: 14, b: 28, l: 60 };
    var cw = w - pad.l - pad.r, ch = h - pad.t - pad.b;

    var agg = {};
    allDates.forEach(function(d) { agg[d] = { rev: 0, cost: 0 }; });
    jobsWithSnaps.forEach(function(j) {
      jobSnapshots(j).forEach(function(s) {
        if (agg[s.dateKey]) {
          agg[s.dateKey].rev += (s.job && s.job.revEarned) || 0;
          agg[s.dateKey].cost += (s.job && s.job.actualCosts) || 0;
        }
      });
    });

    var maxVal = 0;
    allDates.forEach(function(d) { maxVal = Math.max(maxVal, agg[d].rev, agg[d].cost); });
    if (maxVal === 0) maxVal = 1;
    var barW = Math.min(28, (cw / Math.max(allDates.length, 1) - 6) / 2);
    if (barW < 4) barW = 4;

    var dimColor = (getComputedStyle(document.body).getPropertyValue('--text-dim') || '').trim() || '#8b90a5';
    ctx.fillStyle = dimColor;
    ctx.font = '9px system-ui';
    ctx.textAlign = 'right';
    for (var gi = 0; gi <= 4; gi++) {
      var gy = pad.t + ch - (ch * gi / 4);
      var gv = maxVal * gi / 4;
      ctx.fillText(gv >= 1e6 ? '$' + (gv / 1e6).toFixed(1) + 'M' : gv >= 1e3 ? '$' + (gv / 1e3).toFixed(0) + 'k' : '$' + gv.toFixed(0), pad.l - 6, gy + 3);
      ctx.strokeStyle = 'rgba(140,145,165,0.15)';
      ctx.beginPath(); ctx.moveTo(pad.l, gy); ctx.lineTo(pad.l + cw, gy); ctx.stroke();
    }
    allDates.forEach(function(d, i) {
      var x = pad.l + (i + 0.5) * (cw / Math.max(allDates.length, 1));
      var a = agg[d];
      ctx.fillStyle = 'rgba(79,140,255,0.7)';
      ctx.fillRect(x - barW - 1, pad.t + ch - (a.rev / maxVal) * ch, barW, (a.rev / maxVal) * ch);
      ctx.fillStyle = 'rgba(248,113,113,0.7)';
      ctx.fillRect(x + 1, pad.t + ch - (a.cost / maxVal) * ch, barW, (a.cost / maxVal) * ch);
      ctx.fillStyle = dimColor;
      ctx.font = '8px system-ui'; ctx.textAlign = 'center';
      ctx.fillText(d.substring(5), x, h - pad.b + 12);
    });
    ctx.font = '9px system-ui'; ctx.textAlign = 'left';
    ctx.fillStyle = 'rgba(79,140,255,0.9)'; ctx.fillRect(pad.l, 4, 8, 8);
    ctx.fillText('Rev Earned', pad.l + 12, 12);
    ctx.fillStyle = 'rgba(248,113,113,0.9)'; ctx.fillRect(pad.l + 80, 4, 8, 8);
    ctx.fillText('Actual Costs', pad.l + 92, 12);
  }

  function drawBacklogBurnDown(jobsWithSnaps, allDates) {
    var canvas = document.getElementById('insights-bd-chart');
    if (!canvas) return;
    var bCtx = canvas.getContext('2d');
    var bW = canvas.width = canvas.offsetWidth * 2;
    var bH = canvas.height = 320;
    bCtx.scale(2, 2);
    var bw = bW / 2, bh = bH / 2;
    var bp = { t: 16, r: 14, b: 28, l: 60 };
    var bcw = bw - bp.l - bp.r, bch = bh - bp.t - bp.b;

    var agg = {};
    allDates.forEach(function(d) { agg[d] = { backlog: 0, rev: 0 }; });
    jobsWithSnaps.forEach(function(j) {
      jobSnapshots(j).forEach(function(s) {
        if (agg[s.dateKey]) {
          agg[s.dateKey].backlog += (s.job && s.job.backlog) || 0;
          agg[s.dateKey].rev += (s.job && s.job.revEarned) || 0;
        }
      });
    });

    var maxBd = 0;
    allDates.forEach(function(d) { maxBd = Math.max(maxBd, agg[d].backlog, agg[d].rev); });
    if (maxBd === 0) maxBd = 1;

    var dimColor = (getComputedStyle(document.body).getPropertyValue('--text-dim') || '').trim() || '#8b90a5';
    bCtx.fillStyle = dimColor;
    bCtx.font = '9px system-ui'; bCtx.textAlign = 'right';
    for (var bi = 0; bi <= 4; bi++) {
      var by = bp.t + bch - (bch * bi / 4);
      var bv = maxBd * bi / 4;
      bCtx.fillText(bv >= 1e6 ? '$' + (bv / 1e6).toFixed(1) + 'M' : bv >= 1e3 ? '$' + (bv / 1e3).toFixed(0) + 'k' : '$' + bv.toFixed(0), bp.l - 6, by + 3);
      bCtx.strokeStyle = 'rgba(140,145,165,0.15)';
      bCtx.beginPath(); bCtx.moveTo(bp.l, by); bCtx.lineTo(bp.l + bcw, by); bCtx.stroke();
    }

    // Backlog area
    bCtx.beginPath(); bCtx.strokeStyle = '#fbbf24'; bCtx.lineWidth = 2;
    allDates.forEach(function(d, i) {
      var bx = bp.l + (i + 0.5) * (bcw / Math.max(allDates.length, 1));
      var byy = bp.t + bch - (agg[d].backlog / maxBd) * bch;
      if (i === 0) bCtx.moveTo(bx, byy); else bCtx.lineTo(bx, byy);
    });
    bCtx.stroke();
    bCtx.beginPath();
    allDates.forEach(function(d, i) {
      var bx = bp.l + (i + 0.5) * (bcw / Math.max(allDates.length, 1));
      var byy = bp.t + bch - (agg[d].backlog / maxBd) * bch;
      if (i === 0) bCtx.moveTo(bx, byy); else bCtx.lineTo(bx, byy);
    });
    var lastX = bp.l + (allDates.length - 0.5) * (bcw / Math.max(allDates.length, 1));
    bCtx.lineTo(lastX, bp.t + bch);
    bCtx.lineTo(bp.l + 0.5 * (bcw / Math.max(allDates.length, 1)), bp.t + bch);
    bCtx.closePath(); bCtx.fillStyle = 'rgba(251,191,36,0.1)'; bCtx.fill();

    // Revenue earned line
    bCtx.beginPath(); bCtx.strokeStyle = '#34d399'; bCtx.lineWidth = 2;
    allDates.forEach(function(d, i) {
      var bx = bp.l + (i + 0.5) * (bcw / Math.max(allDates.length, 1));
      var byy = bp.t + bch - (agg[d].rev / maxBd) * bch;
      if (i === 0) bCtx.moveTo(bx, byy); else bCtx.lineTo(bx, byy);
    });
    bCtx.stroke();

    // Date labels + dots
    allDates.forEach(function(d, i) {
      var bx = bp.l + (i + 0.5) * (bcw / Math.max(allDates.length, 1));
      bCtx.fillStyle = '#fbbf24';
      bCtx.beginPath(); bCtx.arc(bx, bp.t + bch - (agg[d].backlog / maxBd) * bch, 2.5, 0, Math.PI * 2); bCtx.fill();
      bCtx.fillStyle = '#34d399';
      bCtx.beginPath(); bCtx.arc(bx, bp.t + bch - (agg[d].rev / maxBd) * bch, 2.5, 0, Math.PI * 2); bCtx.fill();
      bCtx.fillStyle = dimColor;
      bCtx.font = '8px system-ui'; bCtx.textAlign = 'center';
      bCtx.fillText(d.substring(5), bx, bh - bp.b + 12);
    });

    // Legend
    bCtx.font = '9px system-ui'; bCtx.textAlign = 'left';
    bCtx.strokeStyle = '#fbbf24'; bCtx.lineWidth = 2;
    bCtx.beginPath(); bCtx.moveTo(bp.l, 4); bCtx.lineTo(bp.l + 16, 4); bCtx.stroke();
    bCtx.fillStyle = '#fbbf24'; bCtx.fillText('Backlog', bp.l + 20, 8);
    bCtx.strokeStyle = '#34d399';
    bCtx.beginPath(); bCtx.moveTo(bp.l + 70, 4); bCtx.lineTo(bp.l + 86, 4); bCtx.stroke();
    bCtx.fillStyle = '#34d399'; bCtx.fillText('Rev Earned', bp.l + 90, 8);
  }

  window.renderInsightsDashboard = renderInsightsDashboard;
})();
