// Promise confirm. Native confirm() returns undefined inside an installed PWA,
// so every `if (!confirm(x)) return` guard silently did nothing there: the
// dialog never appeared and the action never ran. Uses the in-app overlay when
// present, native only as a fallback.
function p86Ask(message, opts) {
  opts = opts || {};
  if (typeof window.p86Confirm === 'function') {
    return window.p86Confirm({
      title: opts.title || 'Confirm', message: message,
      confirmLabel: opts.confirmLabel || 'Confirm', confirmText: opts.confirmLabel || 'Confirm',
      cancelLabel: 'Cancel', cancelText: 'Cancel',
      danger: opts.danger !== false, destructive: opts.danger !== false
    });
  }
  return Promise.resolve(window.confirm(message));
}
// Project 86 QuickBooks weekly Detailed Job Costs importer.
//
// Drops a QB "Project costs detail" xlsx into Project 86, parses
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
  //
  // Credits — vendor refunds, bill credits, reversals — are negative, and
  // QB's amount format ("#,##0.00 ;[Red](#,##0.00)") renders them in
  // ACCOUNTING PARENTHESES, not with a leading minus. We read the sheet
  // with SheetJS `raw:false`, so what arrives here is that formatted text:
  // "(1,234.56)". parseFloat of that is NaN, and the old isFinite guard
  // turned NaN into 0 — so every credit silently became zero and job costs
  // imported HIGH. On the 07.30.26 export that was 164 credit lines worth
  // -$548,611.24, inflating the total from $2,351,823.05 to $2,900,434.29.
  // Unwrap the parens (and the trailing-minus form some exports use)
  // before parsing so credits keep their sign.
  function toNumber(v) {
    if (v == null || v === '') return 0;
    if (typeof v === 'number') return v;
    var s = String(v).replace(/[$,\s]/g, '').replace(/−/g, '-'); // U+2212 → ASCII minus
    var paren = /^\(.*\)$/.test(s);
    if (paren) s = s.slice(1, -1);
    if (/^[\d.]+-$/.test(s)) s = '-' + s.slice(0, -1); // "1234.56-" trailing-minus exports
    var n = parseFloat(s);
    if (!isFinite(n)) return 0;
    return paren ? -Math.abs(n) : n;
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

  // A row whose column A is a subtotal ("Total for <project>") or the
  // grand total ("Total"). These repeat money already carried by the
  // detail lines above them, so they must never become cost lines.
  // Kept separate from the detail test because the real discriminator is
  // positional: a detail line has the project in col B with col A EMPTY,
  // a total row is the reverse.
  function isTotalRow(colA) {
    return /^total for/i.test(colA) || /^total$/i.test(colA);
  }

  // Pure row-walk over a sheet-as-array-of-arrays. Split out of
  // parseQBCosts so tests can drive it with a literal fixture instead of
  // a real workbook.
  function parseAoa(aoa, sheetLabel) {
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
      throw new Error('Could not find a Vendor / Amount header row in "' + sheetLabel + '"');
    }
    var col = buildColumnMap(aoa[headerRowIdx]);
    if (col.vendor == null || col.amount == null) {
      throw new Error('Missing required columns in "' + sheetLabel + '" (need Vendor + Amount)');
    }

    var jobs = [];
    var current = null;

    for (var i = headerRowIdx + 1; i < aoa.length; i++) {
      var detailRow = aoa[i] || [];
      var colA = (detailRow[0] == null ? '' : String(detailRow[0])).trim();

      if (colA) {
        if (isTotalRow(colA)) {
          if (current) {
            current.reportedTotal = toNumber(detailRow[col.amount]);
            // Flag rather than infer from a non-zero total: a project
            // whose costs legitimately net to $0.00 still printed a
            // subtotal, and it still deserves to be reconciled.
            current.hasReportedTotal = true;
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
            reportedTotal: 0,
            hasReportedTotal: false
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

  // ─── Reconciliation gate ─────────────────────────────────────────
  // QuickBooks prints its own answer on every project — the "Total for
  // <project>" row we already capture as reportedTotal. Until now we
  // parsed it and threw it away, which is exactly how the credits bug
  // stayed invisible: every credit read as zero, every project total
  // came in high, and nothing ever asked QB whether it agreed. It
  // didn't — by $548,611.24.
  //
  // So ask. Any project whose summed detail lines disagree with its own
  // printed subtotal is a parser defect by definition, and the import is
  // blocked until a human looks. This catches the NEXT format surprise
  // (a new currency form, a shifted column, a rounding change) without
  // anyone having to suspect it first.
  //
  // Tolerance is one cent per project — QB subtotals are exact, not
  // rounded, so anything above a float-noise epsilon is a real defect.
  // Deliberately NOT a percentage: a 0.5% tolerance on this export would
  // have swallowed $14k.
  var RECONCILE_TOLERANCE = 0.01;

  function reconcile(jobs) {
    var drifted = [];
    (jobs || []).forEach(function(j) {
      // A project with no printed subtotal can't be checked — QB omits
      // the row for single-line projects in some exports. Not a defect,
      // but count it so the preview can say how much went unverified
      // rather than implying everything tied out.
      if (!j.hasReportedTotal) return;
      var delta = j.computedTotal - j.reportedTotal;
      if (Math.abs(delta) > RECONCILE_TOLERANCE) {
        drifted.push({
          code: j.code,
          name: j.name,
          computed: j.computedTotal,
          reported: j.reportedTotal,
          delta: delta
        });
      }
    });
    var checked = (jobs || []).filter(function(j) { return j.hasReportedTotal; }).length;
    return {
      ok: drifted.length === 0,
      drifted: drifted,
      checked: checked,
      unverified: (jobs || []).length - checked,
      // Signed sum of every drift — the single number that would have
      // read -548,611.24 on the 07.30.26 export before the credits fix.
      totalDelta: drifted.reduce(function(s, d) { return s + d.delta; }, 0)
    };
  }

  function parseQBCosts(arrayBuffer) {
    var XLSX = window.XLSX;
    var data = new Uint8Array(arrayBuffer);
    var wb = XLSX.read(data, { type: 'array' });
    var picked = pickDetailSheet(wb, XLSX);
    return parseAoa(picked.aoa, picked.name);
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
    var totalUnmatched = m.unmatched.reduce(function(s, p) { return s + p.computedTotal; }, 0);

    var html = '';
    html += '<div style="margin-bottom:16px;font-size:12px;color:var(--text-dim,#888);">' +
      'File: <strong style="color:var(--text,#fff);">' + escapeHTML(_lastParse.fileName) + '</strong>' +
      ' &middot; Report date: <strong style="color:var(--text,#fff);">' + escapeHTML(_lastParse.reportDate) + '</strong>' +
      '</div>';

    html += '<div style="display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin-bottom:16px;">' +
      statBlock('Matched jobs', m.matched.length, '#34d399') +
      statBlock('Total $', fmtMoney(totalMatched), '#34d399') +
      statBlock('Unmatched', m.unmatched.length + (m.unmatched.length ? ' · ' + fmtMoney(totalUnmatched) : ''), m.unmatched.length ? '#fbbf24' : 'var(--text-dim,#888)') +
    '</div>';

    // Reconciliation against QB's own printed subtotals. This outranks
    // everything else in the dialog: an unmatched job loses costs, but a
    // drifted job imports WRONG costs under a confident-looking total.
    var rec = reconcile(_lastParse.jobs);
    if (!rec.ok) {
      html += '<div style="background:rgba(248,113,113,0.10);border:1px solid rgba(248,113,113,0.55);border-radius:8px;padding:12px 14px;margin-bottom:16px;">' +
        '<div style="display:flex;gap:10px;align-items:flex-start;">' +
          '<span style="font-size:18px;line-height:1;">&#9940;</span>' +
          '<div style="font-size:12px;color:var(--text,#fff);line-height:1.5;">' +
            '<strong style="color:#f87171;">Import blocked &mdash; ' + rec.drifted.length + ' project' + (rec.drifted.length === 1 ? '' : 's') +
            ' disagree with QuickBooks’ own subtotal by ' + fmtMoney(Math.abs(rec.totalDelta)) + '.</strong><br>' +
            'For each project below, the lines we parsed don’t add up to the &ldquo;Total for&hellip;&rdquo; figure QuickBooks printed. ' +
            'That means <em>we</em> read the file wrong &mdash; not that your books are wrong. Importing would write costs that don’t match QuickBooks. ' +
            'Send this file over and it gets fixed in the parser.' +
          '</div>' +
        '</div>';
      html += '<table style="width:100%;border-collapse:collapse;font-size:12px;margin-top:10px;">' +
        '<thead><tr>' +
          '<th style="text-align:left;padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);">Code</th>' +
          '<th style="text-align:right;padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);">We parsed</th>' +
          '<th style="text-align:right;padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);">QB says</th>' +
          '<th style="text-align:right;padding:6px 8px;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;color:var(--text-dim,#888);">Off by</th>' +
        '</tr></thead><tbody>';
      rec.drifted.slice(0, 25).forEach(function(d) {
        html += '<tr style="border-top:1px solid rgba(248,113,113,0.25);">' +
          '<td style="padding:6px 8px;font-family:\'SF Mono\',monospace;color:#f87171;">' + escapeHTML(d.code || '(none)') + '</td>' +
          '<td style="text-align:right;padding:6px 8px;font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);">' + fmtMoney(d.computed) + '</td>' +
          '<td style="text-align:right;padding:6px 8px;font-family:\'SF Mono\',monospace;color:var(--text,#fff);">' + fmtMoney(d.reported) + '</td>' +
          '<td style="text-align:right;padding:6px 8px;font-family:\'SF Mono\',monospace;color:#f87171;font-weight:600;">' + fmtMoney(d.delta) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
      if (rec.drifted.length > 25) {
        html += '<div style="font-size:11px;color:var(--text-dim,#888);padding:6px 8px;">' +
          '&hellip; and ' + (rec.drifted.length - 25) + ' more.</div>';
      }
      html += '</div>';
    } else {
      html += '<div style="display:flex;gap:8px;align-items:center;background:rgba(52,211,153,0.08);border:1px solid rgba(52,211,153,0.35);border-radius:8px;padding:9px 12px;margin-bottom:16px;font-size:12px;color:var(--text,#fff);">' +
        '<span style="font-size:14px;line-height:1;">&#10003;</span>' +
        '<span>Reconciled to the penny against QuickBooks’ own subtotals &mdash; <strong>' + rec.checked + '</strong> project' + (rec.checked === 1 ? '' : 's') + ' checked' +
        (rec.unverified ? ', <strong>' + rec.unverified + '</strong> had no printed subtotal to check against' : '') +
        '.</span>' +
      '</div>';
    }

    // Flag mismatches LOUDLY. A QB project whose code doesn't match a P86 job
    // number silently imports nothing — that's how 20% of a real export can
    // vanish unnoticed. Surface the count + $ + the usual cause so the user can
    // fix the code in QuickBooks (or stub it) instead of losing the costs.
    if (m.unmatched.length) {
      html += '<div style="display:flex;gap:10px;align-items:flex-start;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.4);border-radius:8px;padding:12px 14px;margin-bottom:16px;">' +
        '<span style="font-size:18px;line-height:1;">&#9888;&#xFE0F;</span>' +
        '<div style="font-size:12px;color:var(--text,#fff);line-height:1.5;">' +
          '<strong>' + m.unmatched.length + ' project' + (m.unmatched.length === 1 ? '' : 's') + ' (' + fmtMoney(totalUnmatched) + ') won’t import.</strong> ' +
          'Their QuickBooks code doesn’t match a Project&nbsp;86 job number — usually a QB auto-number (e.g. <code>437775</code>) or a customer name instead of your <code>S####</code> / <code>RV####</code> code. ' +
          'Fix the project name in QuickBooks to lead with the job number, or create a stub below. They’re listed under <em>Unmatched</em>.' +
        '</div>' +
      '</div>';
    }

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
        html += '<tr style="border-top:1px solid var(--border,#2a2a32);">' +
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
        '⚠ Unmatched &mdash; no matching job yet:' +
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
        html += '<tr style="border-top:1px solid var(--border,#2a2a32);">' +
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
        'Stub jobs are created with just the QB code + name so the import can link costs. Fill in the rest from the Jobs list afterward.' +
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
      // A failed reconciliation is a hard stop, not a warning. Blocking a
      // good import is an annoyance someone can report; importing money
      // that doesn't match QuickBooks is silent and compounds.
      confirmBtn.disabled = !m.matched.length || !rec.ok;
      confirmBtn.textContent = !rec.ok
        ? 'Blocked — doesn’t match QuickBooks'
        : (m.matched.length
            ? 'Import to ' + m.matched.length + ' job' + (m.matched.length === 1 ? '' : 's')
            : 'Nothing to import');
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
      var allWs = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
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
    var totalStyle = { bold: true, bg: '#1a1a20', color: '#4f8cff', align: 'right' };
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
  async function commitQBCostsImport() {
    if (!_lastParse) return;

    // The real gate. renderPreview() disables the Confirm button on a
    // failed reconciliation, but a disabled button is decoration — this
    // is a global, reachable from the console, a stale DOM, or any future
    // caller. The check that protects the money lives at the write.
    var rec = reconcile(_lastParse.jobs);
    if (!rec.ok) {
      var blockedMsg = rec.drifted.length + ' project' + (rec.drifted.length === 1 ? '' : 's') +
        ' don’t match the subtotals QuickBooks printed (off by ' + fmtMoney(Math.abs(rec.totalDelta)) +
        ' in total). The file was read incorrectly, so these costs would import wrong. Nothing was written.';
      // p86Alert is referenced around the app but never actually defined,
      // so those call sites fall through to native alert() — which is a
      // no-op inside the installed PWA. Route through p86Ask instead: it
      // uses the in-app overlay that does render there.
      if (typeof window.p86Alert === 'function') {
        window.p86Alert({ title: 'Import blocked', message: blockedMsg });
      } else {
        await p86Ask(blockedMsg, { title: 'Import blocked', confirmLabel: 'OK' });
      }
      return;
    }

    var m = matchJobs(_lastParse.jobs);
    if (!m.matched.length) return;

    // Confirm overwrite if any job already has a sheet for this date.
    var overwriteCount = m.matched.filter(function(x) {
      return sheetExistsForJob(x.job.id, _lastParse.reportDate);
    }).length;
    if (overwriteCount > 0) {
      var msg = overwriteCount + ' job' + (overwriteCount === 1 ? '' : 's') +
        ' already have a "QB Costs ' + _lastParse.reportDate + '" sheet. Overwrite?';
      if (!(await p86Ask(msg))) return;
    }

    var allWs;
    try {
      allWs = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
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

    localStorage.setItem('p86-workspaces', JSON.stringify(allWs));
    if (typeof saveData === 'function') saveData();

    // ── Phase 2: Server persistence ─────────────────────────────
    // Workspace sheets are now a *view* of the data; the source of
    // truth lives in Postgres so re-imports across devices stay
    // idempotent. Fire-and-forget — if the server is offline the
    // workspace sheets still render fine from localStorage.
    if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
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
              (res.body.skipped || 0) + ' skipped' +
              (res.body.cleaned ? ', ' + res.body.cleaned + ' stale $0 credit row(s) retired' : ''));
            // Refresh the in-memory cache from the server so the QB view,
            // cost buckets, and job rollups reflect this import WITHOUT a
            // full reload. appData.qbCostLines is otherwise a boot-only
            // snapshot — the root cause of "the costs didn't import" when
            // they were in fact in the DB (RV2013). A batch touches many
            // jobs, so refresh the whole list.
            if (window.p86Api && p86Api.qbCosts && typeof p86Api.qbCosts.list === 'function') {
              p86Api.qbCosts.list().then(function(all) {
                if (all && Array.isArray(all.lines)) window.appData.qbCostLines = all.lines;
                if (typeof renderJobsMain === 'function') renderJobsMain();
                // Repaint the QB view if it's currently open on a job.
                if (typeof window.renderJobQBCosts === 'function' &&
                    window.qbCostsView && window.qbCostsView.currentJobId &&
                    window.qbCostsView.currentJobId()) {
                  window.renderJobQBCosts(window.qbCostsView.currentJobId());
                }
              }).catch(function() {});
            }
          }
        }).catch(function(err) {
          console.warn('[qb-costs] server import error:', err && err.message);
        });
    }

    // If the workspace for the currently-open job got updated, the
    // user will see the new sheet on next open. Re-rendering the Jobs
    // list refreshes any rollup display.
    if (typeof closeModal === 'function') closeModal('qbCostsImportModal');
    if (typeof renderJobsMain === 'function') renderJobsMain();

    var totalImported = m.matched.reduce(function(s, x) { return s + x.parsed.computedTotal; }, 0);
    var skippedTotal = m.unmatched.reduce(function(s, p) { return s + p.computedTotal; }, 0);
    var doneMsg = 'Imported ' + m.matched.length + ' job' + (m.matched.length === 1 ? '' : 's') +
      ' — ' + fmtMoney(totalImported) + ' total.';
    // Never report a silent partial success — call out skipped $ explicitly.
    if (m.unmatched.length) {
      doneMsg += '\n\n⚠️ Skipped ' + m.unmatched.length + ' unmatched project' +
        (m.unmatched.length === 1 ? '' : 's') + ' (' + fmtMoney(skippedTotal) +
        ') — their QB code didn’t match a job number. Fix the code in QuickBooks or create a stub, then re-import.';
    }
    alert(doneMsg);

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

  if (typeof window !== 'undefined') {
    window.handleQBCostsFile = handleQBCostsFile;
    window.commitQBCostsImport = commitQBCostsImport;
    window.qbCostsCreateStub = qbCostsCreateStub;
  }

  // Test seam. This file is a browser script, not a module, so the pure
  // parsing helpers are re-exported when loaded under Node (jest) to keep
  // the money math covered. Guarded so the browser path is untouched.
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      toNumber: toNumber,
      isTotalRow: isTotalRow,
      parseAoa: parseAoa,
      reconcile: reconcile,
      RECONCILE_TOLERANCE: RECONCILE_TOLERANCE
    };
  }
})();
