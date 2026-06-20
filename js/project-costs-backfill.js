// Project Costs bulk backfill (one-shot historical import).
//
// Reads a QuickBooks "Project Costs" workbook with TWO tabs —
//   • Project Profitability  (one row per project: Project | Customer |
//     Income | Costs | Profit | Margin)  → CREATES the jobs
//   • Project costs detail   (per-line: Vendor | Date | Account | Class |
//     Memo | Amount, grouped under each job header)  → ATTACHES the costs
// — and posts both to /api/project-costs-backfill. The server creates
// jobs (matched/created by jobNumber) and upserts cost lines idempotently.
//
// Flow: pick file → parse both tabs → POST dryRun (preview) → user
// approves → POST commit. Distinct from the weekly QB importer
// (job-costs-import.js), which only attaches costs to existing jobs.
(function () {
  'use strict';

  var _lastPayload = null; // { jobs, costsByCode, reportDate, sourceFile }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function fmtMoney(n) {
    var v = Number(n) || 0, sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function toNumber(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    var n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }
  function extractCode(header) {
    var s = (header || '').toString().trim();
    var m = s.match(/^(\S+)\s+(.+)$/);
    return m ? { code: m[1].toUpperCase(), name: m[2].trim() } : { code: s.toUpperCase(), name: s };
  }
  function parseReportDateFromFilename(fileName) {
    var m = (fileName || '').match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) return (parseInt(m[3], 10) + 2000) + '-' + m[1] + '-' + m[2];
    var d = new Date(), pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function ensureXLSX() {
    return new Promise(function (resolve, reject) {
      if (typeof window.XLSX !== 'undefined') return resolve(window.XLSX);
      var existing = document.querySelector('script[data-xlsx-loader="1"]');
      if (existing) {
        existing.addEventListener('load', function () { resolve(window.XLSX); });
        existing.addEventListener('error', function () { reject(new Error('Failed to load XLSX library')); });
        return;
      }
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.dataset.xlsxLoader = '1';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('Failed to load XLSX library')); };
      document.head.appendChild(s);
    });
  }

  // Find the row index whose cells satisfy `pred(lowercasedCells)`.
  function findHeaderRow(aoa, pred, scanRows) {
    for (var r = 0; r < Math.min(scanRows || 12, aoa.length); r++) {
      var cells = (aoa[r] || []).map(function (v) { return (v == null ? '' : String(v)).trim().toLowerCase(); });
      if (pred(cells)) return r;
    }
    return -1;
  }
  function sheetAoa(XLSX, sheet) {
    return XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
  }

  // ── Profitability tab → job specs ────────────────────────────────
  function parseProfitability(wb, XLSX) {
    var best = null, bestAoa = null, bestScore = -1;
    wb.SheetNames.forEach(function (name) {
      var aoa = sheetAoa(XLSX, wb.Sheets[name]);
      var score = 0;
      for (var r = 0; r < Math.min(10, aoa.length); r++) {
        (aoa[r] || []).forEach(function (c) {
          var v = (c == null ? '' : String(c)).trim().toLowerCase();
          if (v.indexOf('project') === 0) score += 2;
          if (v.indexOf('income') !== -1) score += 2;
          if (v.indexOf('cost') !== -1) score += 1;
          if (v.indexOf('profit') !== -1) score += 1;
          if (v === 'vendor' || v === 'amount') score -= 5; // that's the detail tab
        });
      }
      if (score > bestScore) { bestScore = score; best = name; bestAoa = aoa; }
    });
    if (!best || bestScore <= 0) return []; // no profitability tab — costs-only file
    var aoa = bestAoa;
    var hi = findHeaderRow(aoa, function (cells) {
      return cells.some(function (c) { return c.indexOf('project') === 0; }) &&
        cells.some(function (c) { return c.indexOf('income') !== -1 || c.indexOf('cost') !== -1; });
    });
    if (hi === -1) return [];
    var col = {};
    (aoa[hi] || []).forEach(function (c, idx) {
      var v = (c == null ? '' : String(c)).trim().toLowerCase();
      if (!v) return;
      if (v.indexOf('project') === 0 && col.project == null) col.project = idx;
      else if (v.indexOf('customer') !== -1) col.customer = idx;
      else if (v.indexOf('income') !== -1) col.income = idx;
      else if (v.indexOf('profit') !== -1 && v.indexOf('margin') !== -1) col.margin = idx;
      else if (v.indexOf('profit') !== -1) col.profit = idx;
      else if (v.indexOf('cost') !== -1) col.costs = idx;
    });
    if (col.project == null) return [];
    var out = [];
    for (var r = hi + 1; r < aoa.length; r++) {
      var row = aoa[r] || [];
      var proj = (row[col.project] == null ? '' : String(row[col.project])).trim();
      if (!proj || /^(total|grand)/i.test(proj)) continue;
      var parsed = extractCode(proj);
      out.push({
        code: parsed.code, name: parsed.name,
        customer: col.customer != null ? (row[col.customer] || '').toString().trim() : '',
        income: col.income != null ? toNumber(row[col.income]) : 0,
        costs: col.costs != null ? toNumber(row[col.costs]) : 0,
        profit: col.profit != null ? toNumber(row[col.profit]) : 0
      });
    }
    return out;
  }

  // ── Cost Detail tab → { CODE: [lines] } ──────────────────────────
  function parseCostDetail(wb, XLSX) {
    var best = null, bestAoa = null, bestScore = -1;
    var want = ['vendor', 'amount', 'memo', 'memo/description', 'distribution account'];
    wb.SheetNames.forEach(function (name) {
      var aoa = sheetAoa(XLSX, wb.Sheets[name]);
      var score = 0;
      for (var r = 0; r < Math.min(12, aoa.length); r++)
        (aoa[r] || []).forEach(function (c) {
          if (want.indexOf((c == null ? '' : String(c)).trim().toLowerCase()) !== -1) score++;
        });
      if (score > bestScore) { bestScore = score; best = name; bestAoa = aoa; }
    });
    if (!best) throw new Error('No cost-detail tab found (need Vendor + Amount headers).');
    var aoa = bestAoa;
    var hi = findHeaderRow(aoa, function (cells) {
      return cells.indexOf('vendor') !== -1 && cells.indexOf('amount') !== -1;
    });
    if (hi === -1) throw new Error('Could not find a Vendor / Amount header in "' + best + '".');
    var col = {};
    (aoa[hi] || []).forEach(function (c, idx) {
      var v = (c == null ? '' : String(c)).trim().toLowerCase();
      if (v === 'vendor') col.vendor = idx;
      else if (v === 'date') col.date = idx;
      else if (v === 'transaction type') col.txnType = idx;
      else if (v === 'num') col.num = idx;
      else if (v === 'distribution account') col.account = idx;
      else if (v === 'distribution account type') col.accountType = idx;
      else if (v === 'class') col.klass = idx;
      else if (v === 'memo' || v === 'memo/description' || v === 'memo / description') col.memo = idx;
      else if (v === 'amount') col.amount = idx;
    });
    if (col.vendor == null || col.amount == null) throw new Error('Cost-detail tab missing Vendor or Amount column.');

    var byCode = {}, names = {}, curCode = null;
    for (var i = hi + 1; i < aoa.length; i++) {
      var row = aoa[i] || [];
      var colA = (row[0] == null ? '' : String(row[0])).trim();
      if (colA) {
        if (/^total for /i.test(colA)) { curCode = null; continue; }
        var p = extractCode(colA);
        curCode = p.code; names[curCode] = p.name;
        if (!byCode[curCode]) byCode[curCode] = [];
      } else if (curCode) {
        var has = false;
        for (var k = 1; k < row.length; k++) { if (row[k] != null && String(row[k]).trim() !== '') { has = true; break; } }
        if (!has) continue;
        byCode[curCode].push({
          vendor: col.vendor != null ? (row[col.vendor] || '').toString().trim() : '',
          date: col.date != null ? (row[col.date] || '').toString().trim() : '',
          txnType: col.txnType != null ? (row[col.txnType] || '').toString().trim() : '',
          num: col.num != null ? (row[col.num] || '').toString().trim() : '',
          account: col.account != null ? (row[col.account] || '').toString().trim() : '',
          accountType: col.accountType != null ? (row[col.accountType] || '').toString().trim() : '',
          klass: col.klass != null ? (row[col.klass] || '').toString().trim() : '',
          memo: col.memo != null ? (row[col.memo] || '').toString().trim() : '',
          amount: col.amount != null ? toNumber(row[col.amount]) : 0
        });
      }
    }
    return { byCode: byCode, names: names };
  }

  function buildPayload(arrayBuffer, fileName) {
    var XLSX = window.XLSX;
    var wb = XLSX.read(new Uint8Array(arrayBuffer), { type: 'array' });
    var profits = parseProfitability(wb, XLSX);
    var detail = parseCostDetail(wb, XLSX);

    // Union: every profitability row is a job; any cost code without a
    // profitability row still becomes a job (so no costs are orphaned).
    var jobs = [], seen = {};
    profits.forEach(function (j) { if (j.code && !seen[j.code]) { seen[j.code] = 1; jobs.push(j); } });
    Object.keys(detail.byCode).forEach(function (code) {
      if (!seen[code]) {
        seen[code] = 1;
        var sum = detail.byCode[code].reduce(function (s, l) { return s + (l.amount || 0); }, 0);
        jobs.push({ code: code, name: detail.names[code] || code, customer: '', income: 0, costs: sum, profit: 0 });
      }
    });
    return { jobs: jobs, costsByCode: detail.byCode, reportDate: parseReportDateFromFilename(fileName), sourceFile: fileName };
  }

  function postBackfill(payload, dryRun) {
    var token = null;
    try { token = localStorage.getItem('p86-auth-token'); } catch (e) {}
    var headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch('/api/project-costs-backfill', {
      method: 'POST', headers: headers, credentials: 'include',
      body: JSON.stringify({
        dryRun: !!dryRun,
        reportDate: payload.reportDate,
        sourceFile: payload.sourceFile,
        defaultStatus: 'Closed',
        jobs: payload.jobs,
        costsByCode: payload.costsByCode
      })
    }).then(function (r) { return r.json().then(function (j) { return { ok: r.ok, body: j }; }); });
  }

  function statBlock(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div></div>';
  }

  function renderPreview(stats) {
    var body = document.getElementById('pcbf_body');
    if (!body) return;
    var html = '';
    html += '<div style="margin-bottom:14px;font-size:12px;color:var(--text-dim,#888);">File: <strong style="color:var(--text,#fff);">' +
      escapeHTML(_lastPayload.sourceFile) + '</strong> &middot; Report date: <strong style="color:var(--text,#fff);">' +
      escapeHTML(_lastPayload.reportDate) + '</strong> &middot; <em>Preview only — nothing saved yet.</em></div>';
    html += '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">' +
      statBlock('Jobs to create', stats.jobsCreated, '#34d399') +
      statBlock('Already exist', stats.jobsMatched, stats.jobsMatched ? '#fbbf24' : 'var(--text-dim,#888)') +
      statBlock('Cost lines', (stats.linesInserted + stats.linesUpdated), '#4f8cff') +
      statBlock('Total cost', fmtMoney(stats.totalCost), '#34d399') + '</div>';
    html += '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:12px;">' +
      'Total income across jobs: <strong style="color:var(--text,#fff);">' + fmtMoney(stats.totalIncome) + '</strong>' +
      ' &middot; new lines: ' + stats.linesInserted + ', updated: ' + stats.linesUpdated +
      (stats.jobsWithNoCosts ? ' &middot; <span style="color:#fbbf24;">' + stats.jobsWithNoCosts + ' job(s) have income but no cost lines</span>' : '') +
      '</div>';
    if (stats.sample && stats.sample.length) {
      html += '<div style="font-weight:600;margin-bottom:6px;color:var(--text,#fff);font-size:13px;">Sample (first ' + stats.sample.length + '):</div>';
      html += '<div style="border:1px solid var(--border,#333);border-radius:6px;overflow:hidden;"><table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<thead style="background:rgba(255,255,255,0.03);"><tr>' +
        ['Job #', 'Title', 'Customer', 'Lines', 'Income', 'Cost'].map(function (h, i) {
          return '<th style="text-align:' + (i >= 3 ? 'right' : 'left') + ';padding:7px 9px;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;">' + h + '</th>';
        }).join('') + '</tr></thead><tbody>';
      stats.sample.forEach(function (s) {
        html += '<tr style="border-top:1px solid var(--border,#2e3346);">' +
          '<td style="padding:7px 9px;font-family:monospace;color:' + (s.created ? '#34d399' : '#fbbf24') + ';">' + escapeHTML(s.code) + '</td>' +
          '<td style="padding:7px 9px;color:var(--text,#fff);">' + escapeHTML(s.name || '') + '</td>' +
          '<td style="padding:7px 9px;color:var(--text-dim,#aaa);">' + escapeHTML(s.customer || '') + '</td>' +
          '<td style="text-align:right;padding:7px 9px;font-family:monospace;color:var(--text-dim,#aaa);">' + s.lines + '</td>' +
          '<td style="text-align:right;padding:7px 9px;font-family:monospace;color:var(--text-dim,#aaa);">' + fmtMoney(s.income) + '</td>' +
          '<td style="text-align:right;padding:7px 9px;font-family:monospace;color:#34d399;">' + fmtMoney(s.cost) + '</td></tr>';
      });
      html += '</tbody></table></div>';
    }
    body.innerHTML = html;
    var btn = document.getElementById('pcbf_confirmBtn');
    if (btn) {
      btn.disabled = !(stats.jobsCreated || stats.jobsMatched);
      btn.textContent = 'Backfill ' + (stats.jobsCreated + stats.jobsMatched) + ' job' + ((stats.jobsCreated + stats.jobsMatched) === 1 ? '' : 's');
    }
  }

  function openModal(id) {
    if (typeof window.openModal === 'function') window.openModal(id);
    else { var m = document.getElementById(id); if (m) m.classList.add('active'); }
  }

  function handleProjectCostsBackfillFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    evt.target.value = '';
    ensureXLSX().then(function () {
      var reader = new FileReader();
      reader.onload = function (e) {
        try {
          _lastPayload = buildPayload(e.target.result, file.name);
        } catch (err) {
          alert('Could not parse file: ' + (err.message || 'unknown error'));
          return;
        }
        if (!_lastPayload.jobs.length) { alert('No projects found in that file. Is it the QB Project Costs export?'); return; }
        var b = document.getElementById('pcbf_body');
        if (b) b.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">Analyzing ' + _lastPayload.jobs.length + ' projects…</div>';
        openModal('projectCostsBackfillModal');
        postBackfill(_lastPayload, true).then(function (res) {
          if (!res.ok) { if (b) b.innerHTML = '<div style="padding:24px;color:#f87171;">Preview failed: ' + escapeHTML((res.body && res.body.error) || 'server error') + '</div>'; return; }
          renderPreview(res.body);
        }).catch(function (err) {
          if (b) b.innerHTML = '<div style="padding:24px;color:#f87171;">Preview error: ' + escapeHTML(err && err.message) + '</div>';
        });
      };
      reader.onerror = function () { alert('Could not read the file.'); };
      reader.readAsArrayBuffer(file);
    }).catch(function (err) { alert('Could not load XLSX library: ' + (err.message || 'unknown error')); });
  }

  function commitProjectCostsBackfill() {
    if (!_lastPayload) return;
    var btn = document.getElementById('pcbf_confirmBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Backfilling…'; }
    postBackfill(_lastPayload, false).then(function (res) {
      if (!res.ok) { alert('Backfill failed: ' + ((res.body && res.body.error) || 'server error')); if (btn) { btn.disabled = false; btn.textContent = 'Retry'; } return; }
      var s = res.body;
      if (typeof closeModal === 'function') closeModal('projectCostsBackfillModal');
      alert('Backfill complete — ' + s.jobsCreated + ' jobs created' + (s.jobsMatched ? ', ' + s.jobsMatched + ' matched' : '') +
        ', ' + (s.linesInserted + s.linesUpdated) + ' cost lines (' + fmtMoney(s.totalCost) + ').\n\nReload the Jobs list to see them.');
      _lastPayload = null;
      if (typeof renderJobsMain === 'function') renderJobsMain();
    }).catch(function (err) {
      alert('Backfill error: ' + (err && err.message)); if (btn) { btn.disabled = false; btn.textContent = 'Retry'; }
    });
  }

  window.handleProjectCostsBackfillFile = handleProjectCostsBackfillFile;
  window.commitProjectCostsBackfill = commitProjectCostsBackfill;
})();
