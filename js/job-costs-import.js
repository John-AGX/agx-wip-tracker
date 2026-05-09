// Project 86 QuickBooks weekly Detailed Job Costs importer.
//
// Drops a QB "Project costs detail" xlsx into the WIP tracker, parses
// the per-job cost lines, and writes a dated `QB Costs YYYY-MM-DD`
// sheet to each matched job's workspace. Unmatched job codes can be
// turned into stub jobs from the preview dialog. Re-importing the
// same week overwrites the existing dated sheet (with a confirmation).
//
// Source format (confirmed with sample 2026-03-20):
//   - Single sheet "Sheet1"
//   - Rows 1-3: title block (col A only)
//   - Row 5: headers in cols B-H: Vendor, Date, Distribution account,
//     Distribution account type, Class, Memo/Description, Amount
//   - Job header row: col A = "S2009 Solace CO 3 & 4" (code + name)
//   - Detail rows: cols B-H, col A blank, outline-grouped under header
//   - Total row: col A = "Total for [Job Name]"
(function() {
  'use strict';

  // Last successful parse, parked here so commitQBCostsImport (wired
  // to the modal's Confirm button) can read it without re-parsing.
  var _lastParse = null; // { jobs: [...], reportDate, fileName }

  function escapeHTML(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtMoney(n) {
    var v = Number(n) || 0;
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString(undefined, {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }

  // SheetJS loads lazily via proposal.js when the user opens the
  // estimates page. On a fresh boot they may have never opened it, so
  // we bring the script in on demand here.
  function ensureXLSX() {
    return new Promise(function(resolve, reject) {
      if (typeof window.XLSX !== 'undefined') return resolve(window.XLSX);
      var existing = document.querySelector('script[data-xlsx-loader="1"]');
      if (existing) {
        existing.addEventListener('load', function() { resolve(window.XLSX); });
        existing.addEventListener('error', function() { reject(new Error('Failed to load XLSX library')); });
        return;
      }
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.dataset.xlsxLoader = '1';
      s.onload = function() { resolve(window.XLSX); };
      s.onerror = function() { reject(new Error('Failed to load XLSX library')); };
      document.head.appendChild(s);
    });
  }

  // Parse the report date out of the filename if it follows the AGX
  // naming convention (MM.DD.YY - Detailed Job Costs.xlsx). Fall back
  // to today otherwise — the user can rename to fix.
  function parseReportDateFromFilename(fileName) {
    var m = (fileName || '').match(/(\d{2})\.(\d{2})\.(\d{2})/);
    if (m) {
      var yy = parseInt(m[3], 10);
      var year = yy + 2000; // QB exports use 2-digit years; assume 21st century
      return year + '-' + m[1] + '-' + m[2];
    }
    var d = new Date();
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Strip $ , and whitespace, return numeric. QB sometimes emits
  // numbers as strings ("$1,234.56") because of formatting.
  function toNumber(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    var n = parseFloat(String(v).replace(/[$,\s]/g, ''));
    return isFinite(n) ? n : 0;
  }

  // Extract job code from a header like "RV2001 Waterside I Milestone
  // Restoration" or "437775 Solace Exterior Paint & Repairs". Code is
  // the leading whitespace-delimited token. QB uses both lettered
  // (S2009, RV2001) and all-numeric (437775) prefixes depending on
  // when the project was created, so allow either.
  function extractCode(header) {
    var s = (header || '').toString().trim();
    var m = s.match(/^(\S+)\s+(.+)$/);
    if (m) return { code: m[1].toUpperCase(), name: m[2].trim() };
    return { code: '', name: s };
  }

  // Build a column-index map from the header row. QB has shipped two
  // layouts so far:
  //   v1 (03.20 export): Vendor | Date | Distribution account |
  //                      Distribution account type | Class |
  //                      Memo/Description | Amount   (cols B-H)
  //   v2 (04.24 export): Vendor | Transaction type | Date | Num |
  //                      Distribution account | Class |
  //                      Memo/Description | Amount   (cols B-I)
  // Locate each field by header name so we don't break next time the
  // layout shifts.
  function buildColumnMap(headerRow) {
    var map = {};
    (headerRow || []).forEach(function(cell, idx) {
      var name = (cell == null ? '' : String(cell)).trim().toLowerCase();
      if (!name) return;
      if (name === 'vendor')                         map.vendor = idx;
      else if (name === 'date')                      map.date = idx;
      else if (name === 'transaction type')          map.txnType = idx;
      else if (name === 'num')                       map.num = idx;
      else if (name === 'distribution account')      map.account = idx;
      else if (name === 'distribution account type') map.accountType = idx;
      else if (name === 'class')                     map.klass = idx;
      else if (name === 'memo' ||
               name === 'memo/description' ||
               name === 'memo / description')        map.memo = idx;
      else if (name === 'amount')                    map.amount = idx;
    });
    return map;
  }

  // Pick the sheet that actually holds the per-job detail rows. A
  // workbook with both a "Project Profitability Summary" and a
  // "Project Cost Details" tab will have wb.SheetNames[0] = the
  // summary, which has only one row per job and breaks the line-row
  // loop. We score each sheet on how many of the expected detail
  // headers it carries, prefer the one with the most.
  function pickDetailSheet(wb, XLSX) {
    var best = null, bestScore = -1, bestAoa = null;
    var expected = ['vendor', 'amount', 'memo', 'memo/description', 'distribution account'];
    wb.SheetNames.forEach(function(name) {
      var sheet = wb.Sheets[name];
      if (!sheet) return;
      var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: false, defval: '' });
      // Score the first 10 rows (the header is usually row 5 but
      // exports occasionally float).
      var score = 0;
      for (var r = 0; r < Math.min(10, aoa.length); r++) {
        var row = aoa[r] || [];
        for (var c = 0; c < row.length; c++) {
          var v = (row[c] || '').toString().trim().toLowerCase();
          if (expected.indexOf(v) !== -1) score++;
        }
      }
      if (score > bestScore) {
        bestScore = score;
        best = name;
        bestAoa = aoa;
      }
    });
    if (!best) throw new Error('Workbook has no sheets');
    return { name: best, aoa: bestAoa };
  }

  function parseQBCosts(arrayBuffer) {
    var XLSX = window.XLSX;
    var data = new Uint8Array(arrayBuffer);
    var wb = XLSX.read(data, { type: 'array' });
    var picked = pickDetailSheet(wb, XLSX);
    var aoa = picked.aoa;

    // Find the header row by looking for "Vendor" + "Amount" in the
    // first 12 rows. Earlier exports had it at row 5 (index 4), but
    // QB nudges this around so we scan rather than hard-code.
    var headerRowIdx = -1;
    for (var r = 0; r < Math.min(12, aoa.length); r++) {
      var row = aoa[r] || [];
      var cells = row.map(function(v) { return (v == null ? '' : String(v)).trim().toLowerCase(); });
      if (cells.indexOf('vendor') !== -1 && cells.indexOf('amount') !== -1) {
        headerRowIdx = r;
        break;
      }
    }
    if (headerRowIdx === -1) {
      throw new Error('Could not find a Vendor / Amount header row in "' + picked.name + '"');
    }
    var col = buildColumnMap(aoa[headerRowIdx]);
    if (col.vendor == null || col.amount == null) {
      throw new Error('Missing required columns in "' + picked.name + '" (need Vendor + Amount)');
    }

    var jobs = [];
    var current = null;

    for (var i = headerRowIdx + 1; i < aoa.length; i++) {
      var detailRow = aoa[i] || [];
      var colA = (detailRow[0] == null ? '' : String(detailRow[0])).trim();

      if (colA) {
        if (/^Total for /i.test(colA)) {
          if (current) {
            current.reportedTotal = toNumber(detailRow[col.amount]);
            jobs.push(current);
            current = null;
          }
        } else {
          if (current) jobs.push(current);
          var parsed = extractCode(colA);
          current = {
            rawHeader: colA,
            code: parsed.code,
            name: parsed.name,
            lines: [],
            reportedTotal: 0
          };
        }
      } else if (current) {
        // Detail row — skip blank separators where every column is
        // empty.
        var hasContent = false;
        for (var k = 1; k < detailRow.length; k++) {
          if (detailRow[k] != null && String(detailRow[k]).trim() !== '') { hasContent = true; break; }
        }
        if (hasContent) {
          current.lines.push({
            vendor: col.vendor != null ? (detailRow[col.vendor] || '').toString().trim() : '',
            date: col.date != null ? (detailRow[col.date] || '').toString().trim() : '',
            txnType: col.txnType != null ? (detailRow[col.txnType] || '').toString().trim() : '',
            num: col.num != null ? (detailRow[col.num] || '').toString().trim() : '',
            account: col.account != null ? (detailRow[col.account] || '').toString().trim() : '',
            accountType: col.accountType != null ? (detailRow[col.accountType] || '').toString().trim() : '',
            klass: col.klass != null ? (detailRow[col.klass] || '').toString().trim() : '',
            memo: col.memo != null ? (detailRow[col.memo] || '').toString().trim() : '',
            amount: col.amount != null ? toNumber(detailRow[col.amount]) : 0
          });
        }
      }
    }
    if (current) jobs.push(current);

    jobs.forEach(function(j) {
      j.computedTotal = j.lines.reduce(function(s, l) { return s + l.amount; }, 0);
    });

    return jobs;
  }

  // ─── Match parsed jobs against appData.jobs by jobNumber ─────────
  function matchJobs(parsed) {
    var jobs = (window.appData && window.appData.jobs) || [];
    var byNumber = {};
    jobs.forEach(function(j) {
      var num = (j.jobNumber || '').toUpperCase().trim();
      if (num) byNumber[num] = j;
    });
    var matched = [];
    var unmatched = [];
    parsed.forEach(function(p) {
      var hit = p.code ? byNumber[p.code] : null;
      if (hit) matched.push({ parsed: p, job: hit });
      else unmatched.push(p);
    });
    return { matched: matched, unmatched: unmatched };
  }

  // ─── Preview dialog ──────────────────────────────────────────────
  function renderPreview() {
    var body = document.getElementById('qbCostsImport_body');
    if (!body || !_lastParse) return;
    var m = matchJobs(_lastParse.jobs);
    var totalMatched = m.matched.reduce(function(s, x) { return s + x.parsed.computedTotal; }, 0);

    var html = '';
    html += '<div style="margin-bottom:16px;font-size:12px;color:var(--text-dim,#888);">' +
      'File: <strong style="color:var(--text,#fff);">' + escapeHTML(_lastParse.fileName) + '</strong>' +
      ' &middot; Report date: <strong style="color:var(--text,#fff);">' + escapeHTML(_lastParse.reportDate) + '</strong>' +
      '</div>';

    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">' +
      statBlock('Matched jobs', m.matched.length, '#34d399') +
      statBlock('Total $', fmtMoney(totalMatched), '#34d399') +
      statBlock('Unmatched', m.unmatched.length, m.unmatched.length ? '#fbbf24' : 'var(--text-dim,#888)') +
    '</div>';

    if (m.matched.length) {
      html += '<div style="font-weight:600;margin-bottom:6px;color:var(--text,#fff);font-size:13px;">' +
        '✅ Matched &mdash; will get a "QB Costs ' + escapeHTML(_lastParse.reportDate) + '" sheet:' +
        '</div>';
      html += '<div style="border:1px solid var(--border,#333);border-radius:6px;overflow:hidden;margin-bottom:14px;">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<thead style="background:rgba(255,255,255,0.03);">' +
        '<tr>' +
          '<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Job #</th>' +
          '<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Job Title</th>' +
          '<th style="text-align:right;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Lines</th>' +
          '<th style="text-align:right;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Total</th>' +
        '</tr></thead><tbody>';
      m.matched.forEach(function(x) {
        var existing = sheetExistsForJob(x.job.id, _lastParse.reportDate);
        html += '<tr style="border-top:1px solid var(--border,#2e3346);">' +
          '<td style="padding:8px 10px;font-family:\'SF Mono\',monospace;color:#4f8cff;">' + escapeHTML(x.job.jobNumber || '') + '</td>' +
          '<td style="padding:8px 10px;color:var(--text,#fff);">' + escapeHTML(x.job.title || x.parsed.name) +
            (existing ? ' <span style="color:#fbbf24;font-size:11px;margin-left:6px;" title="A sheet for this date already exists and will be overwritten">⚠ will overwrite</span>' : '') +
          '</td>' +
          '<td style="text-align:right;padding:8px 10px;color:var(--text-dim,#aaa);font-family:\'SF Mono\',monospace;">' + x.parsed.lines.length + '</td>' +
          '<td style="text-align:right;padding:8px 10px;font-family:\'SF Mono\',monospace;color:#34d399;font-weight:600;">' + fmtMoney(x.parsed.computedTotal) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
    }

    if (m.unmatched.length) {
      html += '<div style="font-weight:600;margin-bottom:6px;color:var(--text,#fff);font-size:13px;">' +
        '⚠ Unmatched &mdash; not in WIP tracker yet:' +
        '</div>';
      html += '<div style="border:1px solid var(--border,#333);border-radius:6px;overflow:hidden;margin-bottom:8px;">';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;">';
      html += '<thead style="background:rgba(251,191,36,0.05);">' +
        '<tr>' +
          '<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Code</th>' +
          '<th style="text-align:left;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Name (from QB)</th>' +
          '<th style="text-align:right;padding:8px 10px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;font-size:10px;letter-spacing:0.4px;">Total</th>' +
          '<th style="padding:8px 10px;"></th>' +
        '</tr></thead><tbody>';
      m.unmatched.forEach(function(p, idx) {
        html += '<tr style="border-top:1px solid var(--border,#2e3346);">' +
          '<td style="padding:8px 10px;font-family:\'SF Mono\',monospace;color:#fbbf24;">' + escapeHTML(p.code || '(none)') + '</td>' +
          '<td style="padding:8px 10px;color:var(--text,#fff);">' + escapeHTML(p.name) + '</td>' +
          '<td style="text-align:right;padding:8px 10px;font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);">' + fmtMoney(p.computedTotal) + '</td>' +
          '<td style="text-align:right;padding:6px 10px;">' +
            '<button class="ee-btn primary" style="padding:4px 10px;font-size:11px;" onclick="qbCostsCreateStub(' + idx + ')"' +
              (p.code ? '' : ' disabled title="No job code parsed; cannot create a stub job"') +
            '>+ Create stub job</button>' +
          '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      html += '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:6px;">' +
        'Stub jobs are created with just the QB code + name so the import can link costs. Fill in the rest from the WIP list afterward.' +
        '</div>';
    }

    if (!m.matched.length && !m.unmatched.length) {
      html += '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">' +
        'No jobs found in the file. Is this the right export?' +
        '</div>';
    }

    body.innerHTML = html;

    // Disable the Confirm button if nothing to import.
    var confirmBtn = document.getElementById('qbCostsImport_confirmBtn');
    if (confirmBtn) {
      confirmBtn.disabled = !m.matched.length;
      confirmBtn.textContent = m.matched.length
        ? 'Import to ' + m.matched.length + ' job' + (m.matched.length === 1 ? '' : 's')
        : 'Nothing to import';
    }
  }

  function statBlock(label, value, color) {
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + '</div>' +
      '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div>' +
    '</div>';
  }

  // Quick check: does this job already have a sheet named for this
  // report date? Used to badge the row "will overwrite" in the
  // preview, and to decide whether to confirm before commit.
  function sheetExistsForJob(jobId, reportDate) {
    try {
      var allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
      var ws = allWs[jobId];
      if (!ws || !ws.sheets) return false;
      var name = 'QB Costs ' + reportDate;
      return ws.sheets.some(function(s) { return s.name === name; });
    } catch (e) { return false; }
  }

  // ─── Stub job creation from preview ──────────────────────────────
  function qbCostsCreateStub(unmatchedIdx) {
    if (!_lastParse) return;
    var m = matchJobs(_lastParse.jobs);
    var p = m.unmatched[unmatchedIdx];
    if (!p || !p.code) return;
    if (!window.appData) { alert('App data not initialized.'); return; }

    var stub = {
      id: 'j' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      jobNumber: p.code,
      title: p.name || p.code,
      client: '',
      pm: '',
      owner_id: null,
      jobType: '',
      workType: '',
      market: '',
      status: 'In Progress',
      contractAmount: 0,
      estimatedCosts: 0,
      targetMarginPct: 50,
      notes: 'Stub created from QB Costs import on ' + new Date().toISOString().slice(0, 10) + '. Fill in the remaining details.',
      pctComplete: 0,
      invoicedToDate: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    window.appData.jobs.push(stub);
    if (typeof saveData === 'function') saveData();
    renderPreview(); // re-render so the row jumps to the matched table
  }

  // ─── Build a new sheet from parsed cost rows ─────────────────────
  function colLetter(c) {
    // 0-indexed → A, B, ... Z, AA, AB
    var letters = '';
    var n = c;
    while (true) {
      letters = String.fromCharCode(65 + (n % 26)) + letters;
      n = Math.floor(n / 26) - 1;
      if (n < 0) break;
    }
    return letters;
  }

  function setCell(cells, r, c, val, opts) {
    opts = opts || {};
    cells[colLetter(c) + (r + 1)] = {
      raw: val == null ? '' : String(val),
      value: val == null ? '' : val,
      fmt: opts.fmt || null,
      style: opts.style || {}
    };
  }

  function buildCostSheet(name, parsedJob) {
    var cells = {};
    var headerStyle = { bold: true, bg: '#1f2937', color: '#ffffff', align: 'center' };
    var totalStyle = { bold: true, bg: '#1e2130', color: '#4f8cff', align: 'right' };
    var titleStyle = { bold: true };

    setCell(cells, 0, 0, 'QB Costs — ' + parsedJob.rawHeader, { style: titleStyle });
    setCell(cells, 1, 0, 'Imported ' + new Date().toLocaleString());

    // Decide which columns are worth rendering based on whether any
    // line in this job actually carries a value for them. Keeps narrow
    // jobs narrow while still picking up Transaction type / Num when
    // QB sends them.
    function anyNonEmpty(field) {
      return parsedJob.lines.some(function(l) {
        return l[field] != null && String(l[field]).trim() !== '';
      });
    }
    var schema = [
      { key: 'vendor',      label: 'Vendor',           width: 200 },
      { key: 'txnType',     label: 'Transaction Type', width: 130, optional: true },
      { key: 'date',        label: 'Date',             width: 90 },
      { key: 'num',         label: 'Num',              width: 90,  optional: true },
      { key: 'account',     label: 'Account',          width: 200 },
      { key: 'accountType', label: 'Account Type',     width: 140, optional: true },
      { key: 'klass',       label: 'Class',            width: 130 },
      { key: 'memo',        label: 'Memo',             width: 320 },
      { key: 'amount',      label: 'Amount',           width: 120, fmt: 'currency' }
    ].filter(function(s) { return !s.optional || anyNonEmpty(s.key); });

    var hdrRow = 3;
    var colWidths = {};
    schema.forEach(function(s, i) {
      setCell(cells, hdrRow, i, s.label, { style: headerStyle });
      colWidths[i] = s.width;
    });

    parsedJob.lines.forEach(function(l, idx) {
      var r = hdrRow + 1 + idx;
      schema.forEach(function(s, i) {
        var val = l[s.key];
        if (s.fmt === 'currency') setCell(cells, r, i, val == null ? 0 : val, { fmt: 'currency' });
        else setCell(cells, r, i, val == null ? '' : val);
      });
    });

    var amountCol = schema.length - 1; // Amount is always last
    var totalRow = hdrRow + 1 + parsedJob.lines.length + 1;
    setCell(cells, totalRow, amountCol - 1, 'TOTAL', { style: totalStyle });
    setCell(cells, totalRow, amountCol, parsedJob.computedTotal, { fmt: 'currency', style: totalStyle });

    return {
      id: 's_qb_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6),
      name: name,
      rows: Math.max(100, totalRow + 5),
      cols: Math.max(26, schema.length),
      cells: cells,
      colWidths: colWidths,
      rowHeights: {},
      links: {},
      merges: [],
      tables: []
    };
  }

  // ─── Commit: write sheets to each matched job's workspace ────────
  function commitQBCostsImport() {
    if (!_lastParse) return;
    var m = matchJobs(_lastParse.jobs);
    if (!m.matched.length) return;

    // Confirm overwrite if any job already has a sheet for this date.
    var overwriteCount = m.matched.filter(function(x) {
      return sheetExistsForJob(x.job.id, _lastParse.reportDate);
    }).length;
    if (overwriteCount > 0) {
      var msg = overwriteCount + ' job' + (overwriteCount === 1 ? '' : 's') +
        ' already have a "QB Costs ' + _lastParse.reportDate + '" sheet. Overwrite?';
      if (!confirm(msg)) return;
    }

    var allWs;
    try {
      allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
    } catch (e) {
      allWs = {};
    }

    var sheetName = 'QB Costs ' + _lastParse.reportDate;
    m.matched.forEach(function(x) {
      var ws = allWs[x.job.id];
      if (!ws || typeof ws !== 'object') ws = { version: 2, activeSheetId: null, sheets: [] };
      if (!Array.isArray(ws.sheets)) ws.sheets = [];

      var newSheet = buildCostSheet(sheetName, x.parsed);
      var existingIdx = ws.sheets.findIndex(function(s) { return s.name === sheetName; });
      if (existingIdx >= 0) {
        // Preserve the existing sheet's id so anything referencing it
        // by id (links, etc.) still resolves after overwrite.
        newSheet.id = ws.sheets[existingIdx].id;
        ws.sheets[existingIdx] = newSheet;
      } else {
        ws.sheets.push(newSheet);
      }
      ws.activeSheetId = newSheet.id;
      ws.version = 2;
      allWs[x.job.id] = ws;

      // Job-level rollup so the Overview can show a QB cost figure
      // without forcing the user into the workspace.
      x.job.qbCostsAsOf = _lastParse.reportDate;
      x.job.qbCostsTotal = x.parsed.computedTotal;
      x.job.qbCostsLines = x.parsed.lines.length;
      x.job.updatedAt = new Date().toISOString();
    });

    localStorage.setItem('agx-workspaces', JSON.stringify(allWs));
    if (typeof saveData === 'function') saveData();

    // ── Phase 2: Server persistence ─────────────────────────────
    // Workspace sheets are now a *view* of the data; the source of
    // truth lives in Postgres so re-imports across devices stay
    // idempotent. Fire-and-forget — if the server is offline the
    // workspace sheets still render fine from localStorage.
    if (window.agxApi && window.agxApi.isAuthenticated && window.agxApi.isAuthenticated()) {
      var payload = {
        reportDate: _lastParse.reportDate,
        sourceFile: _lastParse.fileName || null,
        jobs: m.matched.map(function(x) {
          return {
            jobId: x.job.id,
            lines: x.parsed.lines.map(function(l) {
              return {
                vendor: l.vendor || '',
                date: l.date || '',
                txnType: l.txnType || '',
                num: l.num || '',
                account: l.account || '',
                accountType: l.accountType || '',
                klass: l.klass || '',
                memo: l.memo || '',
                amount: l.amount || 0
              };
            })
          };
        })
      };
      fetch('/api/qb-costs/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      }).then(function(r) { return r.json().then(function(j) { return { ok: r.ok, body: j }; }); })
        .then(function(res) {
          if (!res.ok) {
            console.warn('[qb-costs] server import failed:', res.body && res.body.error);
          } else {
            console.log('[qb-costs] server upsert: +' + (res.body.inserted || 0) +
              ' new, ' + (res.body.updated || 0) + ' updated, ' +
              (res.body.skipped || 0) + ' skipped');
          }
        }).catch(function(err) {
          console.warn('[qb-costs] server import error:', err && err.message);
        });
    }

    // If the workspace for the currently-open job got updated, the
    // user will see the new sheet on next open. Re-rendering the WIP
    // list refreshes any rollup display.
    if (typeof closeModal === 'function') closeModal('qbCostsImportModal');
    if (typeof renderWIPMain === 'function') renderWIPMain();

    var totalImported = m.matched.reduce(function(s, x) { return s + x.parsed.computedTotal; }, 0);
    alert('Imported ' + m.matched.length + ' job' + (m.matched.length === 1 ? '' : 's') +
      ' — ' + fmtMoney(totalImported) + ' total.');

    _lastParse = null;
  }

  // ─── File picker entry point ─────────────────────────────────────
  function handleQBCostsFile(evt) {
    var file = evt.target.files && evt.target.files[0];
    if (!file) return;
    evt.target.value = ''; // allow re-picking the same file

    ensureXLSX().then(function() {
      var reader = new FileReader();
      reader.onload = function(e) {
        var jobs;
        try {
          jobs = parseQBCosts(e.target.result);
        } catch (err) {
          alert('Could not parse file: ' + (err.message || 'unknown error'));
          return;
        }
        if (!jobs.length) {
          alert('No jobs found in that file. Is it the right export?');
          return;
        }
        _lastParse = {
          jobs: jobs,
          reportDate: parseReportDateFromFilename(file.name),
          fileName: file.name
        };
        renderPreview();
        if (typeof openModal === 'function') openModal('qbCostsImportModal');
        else document.getElementById('qbCostsImportModal').classList.add('active');
      };
      reader.onerror = function() { alert('Could not read the file.'); };
      reader.readAsArrayBuffer(file);
    }).catch(function(err) {
      alert('Could not load XLSX library: ' + (err.message || 'unknown error'));
    });
  }

  window.handleQBCostsFile = handleQBCostsFile;
  window.commitQBCostsImport = commitQBCostsImport;
  window.qbCostsCreateStub = qbCostsCreateStub;
})();
