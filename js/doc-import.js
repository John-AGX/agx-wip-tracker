/* ============================================================================
 * Bulk Document Import — window.p86DocImport
 * ----------------------------------------------------------------------------
 * Upload MANY PO / CO / Invoice documents (images or PDFs) at once. Each file
 * is queued and OCR'd one-by-one (/api/doc-import/ocr, Haiku vision) into a
 * structured header + line items, auto-matched to a job by the printed
 * job hint, shown in an editable review grid, then created in bulk against the
 * real PO / CO / Invoice routes. Every created record carries its line items,
 * so its total flows into the job metrics.
 *
 * Public API: window.p86DocImport.open('po' | 'co' | 'invoice')
 * ========================================================================== */
(function () {
  'use strict';

  var ENTITIES = {
    po:      { label: 'Purchase Order', plural: "PO's",      accept: 'image/*,application/pdf,.xlsx,.xls,.csv', icon: '📄' },
    co:      { label: 'Change Order',   plural: "CO's",      accept: 'image/*,application/pdf,.xlsx,.xls,.csv', icon: '📝' },
    invoice: { label: 'Invoice',        plural: 'Invoices',  accept: 'image/*,application/pdf,.xlsx,.xls,.csv', icon: '🧾' }
  };

  var state = null; // { entityType, items: [ ... ], processing }
  var _seq = 0;

  // ---- small utils -------------------------------------------------------
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmt(n) {
    n = Number(n || 0);
    return '$' + n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function num(v) { var n = Number(v); return Number.isFinite(n) ? n : 0; }
  function uid() { return 'di' + (++_seq) + '_' + (Date.now() % 100000); }

  // Read a File -> { base64: dataURL, mediaType }. The server strips the
  // data: prefix, so passing the whole data URL is fine.
  function readFile(file) {
    return new Promise(function (resolve, reject) {
      var fr = new FileReader();
      fr.onload = function () { resolve({ base64: String(fr.result || ''), mediaType: file.type || 'image/jpeg' }); };
      fr.onerror = function () { reject(new Error('read-failed')); };
      fr.readAsDataURL(file);
    });
  }

  // ---- Buildertrend spreadsheet (.xlsx) import ---------------------------
  // The BT "Purchase Orders" export is ONE ROW PER PO (header-level, lump-sum
  // Cost — no line items). Parse it client-side with SheetJS and turn each row
  // into the SAME review item the OCR path produces, so it flows through the
  // existing review grid + bulk create. SheetJS is lazy-loaded from the CDN
  // (same source js/job-costs-import.js uses).
  var _xlsxP = null;
  function ensureXLSX() {
    if (window.XLSX) return Promise.resolve(window.XLSX);
    if (_xlsxP) return _xlsxP;
    _xlsxP = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = 'https://cdn.sheetjs.com/xlsx-0.20.3/package/dist/xlsx.full.min.js';
      s.onload = function () { resolve(window.XLSX); };
      s.onerror = function () { reject(new Error('xlsx-load-failed')); };
      document.head.appendChild(s);
    });
    return _xlsxP;
  }
  function isSpreadsheet(f) {
    return /\.(xlsx|xls|csv)$/i.test(f.name || '') || /spreadsheet|excel|csv/.test(f.type || '');
  }
  // Excel serial (1900 system) -> YYYY-MM-DD; passes real date strings through.
  // Serial 25569 = 1970-01-01.
  function xlDate(v) {
    if (v == null || v === '') return null;
    var n = Number(v);
    if (isFinite(n) && n > 20000 && n < 90000) {
      var d = new Date(Math.round((n - 25569) * 86400000));
      return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10);
    }
    var d2 = new Date(v);
    return isNaN(d2.getTime()) ? null : d2.toISOString().slice(0, 10);
  }
  // BT PO Status -> P86 status (draft|issued|approved|work_complete|closed).
  function mapBtPoStatus(s) {
    s = String(s || '').toLowerCase();
    if (s.indexOf('draft') >= 0) return 'draft';
    if (s.indexOf('approv') >= 0) return 'approved';
    if (s.indexOf('complet') >= 0) return 'work_complete';
    if (s.indexOf('clos') >= 0) return 'closed';
    return 'issued'; // "Sent" and anything else
  }
  // Find the header row + map BT column labels -> indices (order-independent).
  function btColMap(aoa) {
    for (var r = 0; r < Math.min(aoa.length, 8); r++) {
      var row = (aoa[r] || []).map(function (x) { return String(x == null ? '' : x).trim().toLowerCase(); });
      if (row.indexOf('job') >= 0 && (row.indexOf('po #') >= 0 || row.indexOf('cost') >= 0)) {
        var map = {};
        row.forEach(function (h, i) { if (h) map[h] = i; });
        return { headerRow: r, map: map };
      }
    }
    return null;
  }
  function parseSpreadsheet(file) {
    ensureXLSX().then(function (XLSX) {
      return file.arrayBuffer().then(function (buf) {
        if (!state) return;
        var wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
        var sheet = wb.Sheets[wb.SheetNames[0]];
        var aoa = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '' });
        var hm = btColMap(aoa);
        if (!hm) throw new Error('not-a-bt-po-export');
        var m = hm.map;
        function cell(row, key) { var i = m[key]; return (i == null) ? '' : row[i]; }
        state.entityType = 'po'; // the BT Purchase Orders export is a PO import
        var added = 0;
        for (var r = hm.headerRow + 1; r < aoa.length; r++) {
          var row = aoa[r] || [];
          var job = String(cell(row, 'job') == null ? '' : cell(row, 'job')).trim();
          var poNo = String(cell(row, 'po #') == null ? '' : cell(row, 'po #')).trim();
          if (!job && !poNo) continue; // totals / footer row
          var cost = Number(cell(row, 'cost')) || 0;
          var title = String(cell(row, 'title') || '').trim();
          var vendor = String(cell(row, 'performed by') || '').trim();
          var costCode = String(cell(row, 'cost code') || '').trim();
          var extracted = {
            entity_type: 'po', job_hint: job, number: poNo, vendor: vendor,
            title: title || ('PO ' + poNo), date: xlDate(cell(row, 'created date')),
            status: mapBtPoStatus(cell(row, 'po status')), costCode: costCode,
            lines: [{ description: title || costCode || 'Purchase order', qty: 1, unit_cost: cost, amount: cost }],
            total: cost, lines_total: cost
          };
          state.items.push({ id: uid(), file: null, fileName: 'BT · PO ' + poNo + ' — ' + job, status: 'review', extracted: extracted, jobId: matchJob(job).jobId, error: null });
          added++;
        }
        if (!added) throw new Error('no-rows');
        render();
      });
    }).catch(function (err) {
      if (!state) return;
      var code = err && err.message;
      var msg = code === 'not-a-bt-po-export' ? 'That spreadsheet doesn\'t look like a Buildertrend Purchase Orders export.'
        : code === 'no-rows' ? 'No purchase-order rows found in that file.'
        : code === 'xlsx-load-failed' ? 'Could not load the spreadsheet reader (offline?).'
        : 'Could not read that spreadsheet.';
      state.items.push({ id: uid(), file: null, fileName: file.name || 'spreadsheet', status: 'error', extracted: null, jobId: '', error: msg });
      render();
    });
  }

  // ---- job auto-match ----------------------------------------------------
  // Build a lowercase searchable string per job (number + title + address).
  function jobHaystack(j) {
    return [j.jobNumber, j.title, j.client, j.address, j.geocode_address,
            j.street_address, j.city, j.state, j.zip].filter(Boolean).join(' ').toLowerCase();
  }
  function matchJob(hint) {
    var jobs = (window.appData && window.appData.jobs) || [];
    if (!hint || !jobs.length) return { jobId: '', confidence: 0 };
    var h = String(hint).toLowerCase().trim();
    var hCompact = h.replace(/\s+/g, '');
    var best = { jobId: '', confidence: 0 };
    jobs.forEach(function (j) {
      var num0 = String(j.jobNumber || '').toLowerCase().replace(/\s+/g, '');
      var conf = 0;
      // Strongest: the job number appears in the hint (or vice-versa).
      if (num0 && (hCompact.indexOf(num0) >= 0)) conf = Math.max(conf, 0.95);
      // Address / title tokens: how much of the hint the job's haystack covers.
      var hay = jobHaystack(j);
      if (hay) {
        // A distinctive chunk of the hint (e.g. a street address) inside the job.
        var streetNum = (h.match(/\b\d{2,6}\b/) || [])[0];
        if (streetNum && hay.indexOf(streetNum) >= 0) conf = Math.max(conf, 0.8);
        // Token overlap on words >= 4 chars.
        var toks = h.split(/[^a-z0-9]+/).filter(function (t) { return t.length >= 4; });
        if (toks.length) {
          var hits = toks.filter(function (t) { return hay.indexOf(t) >= 0; }).length;
          conf = Math.max(conf, Math.min(0.75, hits / toks.length));
        }
      }
      if (conf > best.confidence) best = { jobId: j.id, confidence: conf };
    });
    // Only claim a match above a floor; below it, leave unmatched for the user.
    return best.confidence >= 0.5 ? best : { jobId: '', confidence: best.confidence };
  }

  function jobLabel(jobId) {
    var j = ((window.appData && window.appData.jobs) || []).find(function (x) { return x.id === jobId; });
    if (!j) return '';
    return (j.jobNumber ? j.jobNumber + ' — ' : '') + (j.title || 'Untitled');
  }

  // ---- overlay lifecycle -------------------------------------------------
  function open(entityType) {
    if (!ENTITIES[entityType]) entityType = 'po';
    if (!window.p86Api || !window.p86Api.docImport) { alert('Import is unavailable — please reload.'); return; }
    state = { entityType: entityType, items: [], processing: false };
    var host = document.getElementById('p86-doc-import');
    if (host) host.remove();
    host = document.createElement('div');
    host.id = 'p86-doc-import';
    host.style.cssText = 'position:fixed;inset:0;z-index:100000;background:rgba(6,8,14,0.72);backdrop-filter:blur(3px);display:flex;align-items:flex-start;justify-content:center;overflow:auto;padding:24px 16px;';
    host.addEventListener('mousedown', function (e) { if (e.target === host) close(); });
    document.body.appendChild(host);
    render();
    document.addEventListener('keydown', onKey);
  }
  function close() {
    var host = document.getElementById('p86-doc-import');
    if (host) host.remove();
    document.removeEventListener('keydown', onKey);
    state = null;
  }
  function onKey(e) { if (e.key === 'Escape') close(); }
  window.addEventListener('beforeunload', function () { /* no-op guard hook */ });

  // ---- render ------------------------------------------------------------
  function render() {
    var host = document.getElementById('p86-doc-import');
    if (!host || !state) return;
    var ent = ENTITIES[state.entityType];
    var reviewable = state.items.filter(function (it) { return it.status === 'review'; });
    var matched = reviewable.filter(function (it) { return !!it.jobId; }).length;
    var grand = reviewable.reduce(function (s, it) { return s + recordTotal(it); }, 0);
    var doneCount = state.items.filter(function (it) { return it.status === 'done'; }).length;

    host.innerHTML =
      '<div style="width:100%;max-width:1080px;background:var(--card-bg,#141419);border:1px solid var(--border,#2a2a33);border-radius:14px;box-shadow:0 24px 64px rgba(0,0,0,0.5);overflow:hidden;">' +
        // Header
        '<div style="display:flex;align-items:center;gap:12px;padding:16px 20px;border-bottom:1px solid var(--border,#2a2a33);">' +
          '<div style="font-size:20px;">' + ent.icon + '</div>' +
          '<div style="flex:1;">' +
            '<div style="font-size:16px;font-weight:700;color:var(--text,#fff);">Import Documents</div>' +
            '<div style="font-size:12px;color:var(--text-dim,#8b8b96);">Upload PO / CO / Invoice files — I read each one, you review, then create them all.</div>' +
          '</div>' +
          segBtns() +
          '<button id="di-close" style="margin-left:8px;background:none;border:none;color:var(--text-dim,#8b8b96);font-size:22px;cursor:pointer;line-height:1;">×</button>' +
        '</div>' +
        // Body
        '<div style="padding:16px 20px;max-height:calc(100vh - 230px);overflow:auto;">' +
          dropZoneHTML() +
          (state.items.length ? '<div style="display:flex;flex-direction:column;gap:12px;margin-top:14px;">' +
            state.items.map(itemHTML).join('') + '</div>' : '') +
        '</div>' +
        // Footer
        '<div style="display:flex;align-items:center;gap:14px;padding:14px 20px;border-top:1px solid var(--border,#2a2a33);background:var(--overlay-light,rgba(255,255,255,0.02));">' +
          '<div style="font-size:12.5px;color:var(--text-dim,#8b8b96);flex:1;">' +
            (state.items.length
              ? (reviewable.length + ' ready · ' + matched + ' matched to a job · ' + fmt(grand) + (doneCount ? ' · ' + doneCount + ' created' : ''))
              : 'No files yet.') +
          '</div>' +
          '<button id="di-addmore" style="padding:8px 14px;border:1px solid var(--border,#333);background:transparent;color:var(--text,#fff);border-radius:8px;font-size:13px;cursor:pointer;">+ Add files</button>' +
          '<button id="di-create" ' + (matched ? '' : 'disabled') + ' style="padding:8px 18px;border:none;border-radius:8px;font-size:13px;font-weight:700;cursor:' + (matched ? 'pointer' : 'not-allowed') + ';color:#fff;background:' + (matched ? 'var(--accent,#4f8cff)' : '#3a3a44') + ';">Create ' + matched + ' ' + esc(ent.plural) + '</button>' +
        '</div>' +
      '</div>';

    // wire
    host.querySelector('#di-close').onclick = close;
    var fileInput = host.querySelector('#di-file');
    if (fileInput) fileInput.onchange = function (e) { addFiles(e.target.files); e.target.value = ''; };
    host.querySelector('#di-addmore').onclick = function () { if (fileInput) fileInput.click(); };
    var createBtn = host.querySelector('#di-create');
    if (createBtn && !createBtn.disabled) createBtn.onclick = createAll;
    wireItemHandlers(host);
    wireDropZone(host);
  }

  function segBtns() {
    return '<div style="display:flex;background:var(--bg,#0d0d12);border:1px solid var(--border,#2a2a33);border-radius:9px;overflow:hidden;">' +
      Object.keys(ENTITIES).map(function (k) {
        var on = state.entityType === k;
        return '<button data-di-ent="' + k + '" style="padding:7px 12px;border:none;background:' + (on ? 'var(--accent,#4f8cff)' : 'transparent') + ';color:' + (on ? '#fff' : 'var(--text-dim,#8b8b96)') + ';font-size:12px;font-weight:600;cursor:pointer;">' + esc(ENTITIES[k].plural) + '</button>';
      }).join('') + '</div>';
  }

  function dropZoneHTML() {
    var ent = ENTITIES[state.entityType];
    var empty = !state.items.length;
    return '<div id="di-drop" style="border:2px dashed var(--border,#3a3a44);border-radius:12px;padding:' + (empty ? '34px' : '16px') + ' 20px;text-align:center;cursor:pointer;transition:border-color .15s;">' +
      '<input id="di-file" type="file" accept="' + ent.accept + '" multiple style="display:none;">' +
      '<div style="font-size:' + (empty ? '30px' : '18px') + ';margin-bottom:6px;">⬆</div>' +
      '<div style="font-size:13.5px;color:var(--text,#fff);font-weight:600;">Drop ' + esc(ent.plural) + ' here, or click to choose files</div>' +
      '<div style="font-size:11.5px;color:var(--text-dim,#8b8b96);margin-top:3px;">Images, PDFs, or a Buildertrend .xlsx export · many at once</div>' +
    '</div>';
  }

  function statusPill(it) {
    var map = {
      queued:   ['Queued', '#8b8b96', 'rgba(148,163,184,0.12)'],
      scanning: ['Reading…', 'var(--accent,#4f8cff)', 'rgba(79,140,255,0.12)'],
      review:   ['AI-read · verify', '#f5b74e', 'rgba(245,183,78,0.14)'],
      creating: ['Creating…', 'var(--accent,#4f8cff)', 'rgba(79,140,255,0.12)'],
      done:     ['✓ Created', 'var(--green,#34d399)', 'rgba(52,211,153,0.14)'],
      error:    ['Error', '#f87171', 'rgba(248,113,113,0.14)']
    };
    var m = map[it.status] || map.queued;
    return '<span style="display:inline-block;padding:2px 9px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.3px;text-transform:uppercase;color:' + m[1] + ';background:' + m[2] + ';">' + m[0] + '</span>';
  }

  function recordTotal(it) {
    if (!it.extracted) return 0;
    return (it.extracted.lines || []).reduce(function (s, l) {
      var amt = (l.amount != null) ? num(l.amount) : num(l.qty || 1) * num(l.unit_cost);
      return s + amt;
    }, 0);
  }

  function itemHTML(it) {
    var e = it.extracted || {};
    var head =
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<div style="flex:1;min-width:0;font-size:12.5px;color:var(--text-dim,#8b8b96);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + esc(it.fileName) + '</div>' +
        statusPill(it) +
        '<button data-di-rm="' + it.id + '" title="Remove" style="background:none;border:none;color:var(--text-dim,#8b8b96);cursor:pointer;font-size:16px;line-height:1;">×</button>' +
      '</div>';

    if (it.status === 'queued' || it.status === 'scanning' || it.status === 'creating') {
      return card(head + (it.status === 'scanning' ? '<div style="font-size:12px;color:var(--text-dim,#8b8b96);margin-top:8px;">Reading the document…</div>' : ''));
    }
    if (it.status === 'error') {
      return card(head + '<div style="font-size:12px;color:#f87171;margin-top:8px;">' + esc(it.error || 'Could not read this file.') + ' <a data-di-retry="' + it.id + '" style="color:var(--accent,#4f8cff);cursor:pointer;">Retry</a></div>');
    }
    if (it.status === 'done') {
      return card(head + '<div style="font-size:12px;color:var(--green,#34d399);margin-top:8px;">Created ' + esc(it.createdNumber || '') + (it.jobId ? ' on ' + esc(jobLabel(it.jobId)) : '') + '.</div>');
    }

    // review — editable
    var jobs = ((window.appData && window.appData.jobs) || []).slice().sort(function (a, b) {
      return String(a.jobNumber || '').localeCompare(String(b.jobNumber || ''));
    });
    var jobSel = '<select data-di-f="jobId" data-di-id="' + it.id + '" style="' + fieldCss(!it.jobId) + 'min-width:220px;">' +
      '<option value="">— Select job —</option>' +
      jobs.map(function (j) { return '<option value="' + esc(j.id) + '"' + (j.id === it.jobId ? ' selected' : '') + '>' + esc(jobLabel(j.id)) + '</option>'; }).join('') +
    '</select>';

    var meta =
      '<div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px;align-items:center;">' +
        '<div style="font-size:10.5px;color:var(--text-dim,#8b8b96);text-transform:uppercase;letter-spacing:.4px;">Job</div>' + jobSel +
        field(it, 'number', e.number, ENTITIES[state.entityType].label.split(' ')[0] + ' #', 120) +
        field(it, 'vendor', e.vendor, 'Vendor', 160) +
        field(it, 'date', e.date, 'Date', 120) +
      '</div>' +
      (e.title ? '<div style="margin-top:8px;">' + field(it, 'title', e.title, 'Title / scope', 0, true) + '</div>' : '');

    // line table
    var lines = e.lines || [];
    var rows = lines.map(function (l, i) {
      return '<tr>' +
        '<td style="padding:3px 4px;"><input data-di-line="' + it.id + '" data-i="' + i + '" data-k="description" value="' + esc(l.description) + '" style="' + lineCss() + 'width:100%;"></td>' +
        '<td style="padding:3px 4px;width:70px;"><input data-di-line="' + it.id + '" data-i="' + i + '" data-k="qty" value="' + esc(l.qty != null ? l.qty : '') + '" style="' + lineCss() + 'width:100%;text-align:right;"></td>' +
        '<td style="padding:3px 4px;width:90px;"><input data-di-line="' + it.id + '" data-i="' + i + '" data-k="unit_cost" value="' + esc(l.unit_cost != null ? l.unit_cost : '') + '" style="' + lineCss() + 'width:100%;text-align:right;"></td>' +
        '<td style="padding:3px 4px;width:100px;text-align:right;font-family:monospace;font-size:12px;color:var(--text,#fff);">' + fmt((l.amount != null) ? l.amount : num(l.qty || 1) * num(l.unit_cost)) + '</td>' +
        '<td style="padding:3px 4px;width:24px;text-align:center;"><span data-di-lrm="' + it.id + '" data-i="' + i + '" style="cursor:pointer;color:var(--text-dim,#8b8b96);">×</span></td>' +
      '</tr>';
    }).join('');
    var total = recordTotal(it);
    var mismatch = (e.total != null && Math.abs(e.total - total) > 0.5);
    var table =
      '<div style="margin-top:10px;border:1px solid var(--border,#2a2a33);border-radius:8px;overflow:hidden;">' +
        '<table style="width:100%;border-collapse:collapse;font-size:12px;">' +
          '<thead><tr style="background:var(--overlay-light,rgba(255,255,255,0.02));color:var(--text-dim,#8b8b96);font-size:10px;text-transform:uppercase;letter-spacing:.4px;">' +
            '<th style="text-align:left;padding:5px 6px;">Description</th><th style="text-align:right;padding:5px 6px;">Qty</th><th style="text-align:right;padding:5px 6px;">Unit</th><th style="text-align:right;padding:5px 6px;">Amount</th><th></th>' +
          '</tr></thead><tbody>' + rows + '</tbody>' +
        '</table>' +
        '<div style="display:flex;align-items:center;gap:10px;padding:6px 8px;border-top:1px solid var(--border,#2a2a33);">' +
          '<a data-di-addline="' + it.id + '" style="font-size:11.5px;color:var(--accent,#4f8cff);cursor:pointer;">+ line</a>' +
          '<div style="flex:1;"></div>' +
          (mismatch ? '<span title="Line items don\'t sum to the printed total (' + fmt(e.total) + ')" style="font-size:10.5px;color:#f5b74e;">⚠ printed total ' + fmt(e.total) + '</span>' : '') +
          '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);">Total ' + fmt(total) + '</div>' +
        '</div>' +
      '</div>';

    return card(head + meta + table);
  }

  function card(inner) {
    return '<div style="border:1px solid var(--border,#2a2a33);border-radius:10px;padding:12px 14px;background:var(--bg,#0d0d12);">' + inner + '</div>';
  }
  function fieldCss(bad) {
    return 'background:var(--bg,#0d0d12);border:1px solid ' + (bad ? '#f5734e' : 'var(--border,#333)') + ';color:var(--text,#fff);border-radius:7px;padding:6px 8px;font-size:12.5px;';
  }
  function lineCss() { return 'background:transparent;border:1px solid var(--border,#2a2a33);color:var(--text,#fff);border-radius:5px;padding:4px 6px;font-size:12px;'; }
  function field(it, key, val, ph, w, wide) {
    return '<input data-di-f="' + key + '" data-di-id="' + it.id + '" value="' + esc(val == null ? '' : val) + '" placeholder="' + esc(ph) + '" style="' + fieldCss(false) + (wide ? 'width:100%;' : (w ? 'width:' + w + 'px;' : '')) + '">';
  }

  // ---- item handlers -----------------------------------------------------
  function findItem(id) { return state && state.items.find(function (it) { return it.id === id; }); }

  function wireItemHandlers(host) {
    host.querySelectorAll('[data-di-ent]').forEach(function (b) {
      b.onclick = function () {
        var k = b.getAttribute('data-di-ent');
        if (k === state.entityType) return;
        // Switching type re-reads nothing already OCR'd differently, so require
        // an empty queue to avoid mixing extraction shapes.
        if (state.items.length && !confirm('Switch to ' + ENTITIES[k].plural + '? This clears the current queue.')) return;
        state.entityType = k; state.items = []; render();
      };
    });
    host.querySelectorAll('[data-di-rm]').forEach(function (x) {
      x.onclick = function () { var id = x.getAttribute('data-di-rm'); state.items = state.items.filter(function (it) { return it.id !== id; }); render(); };
    });
    host.querySelectorAll('[data-di-retry]').forEach(function (a) {
      a.onclick = function () { var it = findItem(a.getAttribute('data-di-retry')); if (it) { it.status = 'queued'; it.error = null; render(); processQueue(); } };
    });
    host.querySelectorAll('[data-di-f]').forEach(function (inp) {
      inp.onchange = function () {
        var it = findItem(inp.getAttribute('data-di-id')); if (!it) return;
        var k = inp.getAttribute('data-di-f');
        if (k === 'jobId') { it.jobId = inp.value; render(); return; }
        it.extracted[k] = inp.value;
      };
    });
    host.querySelectorAll('[data-di-line]').forEach(function (inp) {
      inp.onchange = function () {
        var it = findItem(inp.getAttribute('data-di-line')); if (!it) return;
        var i = +inp.getAttribute('data-i'), k = inp.getAttribute('data-k');
        var l = it.extracted.lines[i]; if (!l) return;
        if (k === 'description') l.description = inp.value;
        else { l[k] = inp.value === '' ? null : num(inp.value); l.amount = num(l.qty || 1) * num(l.unit_cost); }
        render();
      };
    });
    host.querySelectorAll('[data-di-lrm]').forEach(function (x) {
      x.onclick = function () { var it = findItem(x.getAttribute('data-di-lrm')); if (!it) return; it.extracted.lines.splice(+x.getAttribute('data-i'), 1); render(); };
    });
    host.querySelectorAll('[data-di-addline]').forEach(function (a) {
      a.onclick = function () { var it = findItem(a.getAttribute('data-di-addline')); if (!it) return; it.extracted.lines.push({ description: '', qty: 1, unit_cost: 0, amount: 0 }); render(); };
    });
  }

  function wireDropZone(host) {
    var dz = host.querySelector('#di-drop'); if (!dz) return;
    dz.onclick = function () { var f = host.querySelector('#di-file'); if (f) f.click(); };
    ['dragenter', 'dragover'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--accent,#4f8cff)'; }); });
    ['dragleave', 'drop'].forEach(function (ev) { dz.addEventListener(ev, function (e) { e.preventDefault(); dz.style.borderColor = 'var(--border,#3a3a44)'; }); });
    dz.addEventListener('drop', function (e) { if (e.dataTransfer && e.dataTransfer.files) addFiles(e.dataTransfer.files); });
  }

  // ---- queue: add + OCR sequentially ------------------------------------
  function addFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    files.forEach(function (f) {
      if (isSpreadsheet(f)) { parseSpreadsheet(f); return; } // BT .xlsx → parse rows, no OCR
      if (!/^image\//.test(f.type) && f.type !== 'application/pdf') return;
      state.items.push({ id: uid(), file: f, fileName: f.name || 'document', status: 'queued', extracted: null, jobId: '', error: null });
    });
    render();
    processQueue();
  }

  function processQueue() {
    if (!state || state.processing) return;
    var next = state.items.find(function (it) { return it.status === 'queued'; });
    if (!next) return;
    state.processing = true;
    next.status = 'scanning'; render();
    readFile(next.file).then(function (r) {
      return window.p86Api.docImport.ocr(state.entityType, r.base64, r.mediaType);
    }).then(function (res) {
      if (res && res.ok && res.extracted) {
        next.extracted = res.extracted;
        var m = matchJob(res.extracted.job_hint);
        next.jobId = m.jobId;
        next.status = 'review';
      } else {
        next.status = 'error';
        next.error = (res && res.error === 'ocr-unavailable') ? 'OCR is not configured on the server.' : 'Could not read this document. Add it manually or retry.';
      }
    }).catch(function () {
      next.status = 'error'; next.error = 'Read/scan failed. Retry?';
    }).then(function () {
      state.processing = false; render();
      processQueue(); // continue with the next queued file
    });
  }

  // ---- bulk create -------------------------------------------------------
  // Map an extracted line to the entity's line shape.
  function toLine(l, entityType) {
    var amt = (l.amount != null) ? num(l.amount) : (l.qty != null && l.unit_cost != null ? num(l.qty) * num(l.unit_cost) : null);
    var q = (l.qty != null && num(l.qty) > 0) ? num(l.qty) : 1;
    var unit = (l.unit_cost != null) ? num(l.unit_cost) : (amt != null ? amt / q : 0);
    var desc = l.description || '(item)';
    if (entityType === 'invoice') return { description: desc, qty: q, unitPrice: unit, amount: (amt != null ? amt : q * unit) };
    return { description: desc, qty: q, unitCost: unit }; // po + co
  }

  function buildPayload(it) {
    var e = it.extracted, t = state.entityType;
    var lines = (e.lines || []).map(function (l) { return toLine(l, t); });
    if (t === 'po') {
      return { po_number: e.number || undefined, status: e.status || 'issued', title: e.title || ('Imported PO' + (e.vendor ? ' — ' + e.vendor : '')), vendorName: e.vendor || null, costCode: e.costCode || null, orderedDate: e.date || null, lines: lines };
    }
    if (t === 'co') {
      return { co_number: e.number || undefined, status: 'approved', title: e.title || 'Imported change order', vendorName: e.vendor || null, date: e.date || null, defaultMarkup: 0, lines: lines };
    }
    // invoice
    return { job_id: it.jobId, invoice_number: e.number || undefined, issue_date: e.date || null, due_date: e.due_date || null, notes: e.vendor ? ('Vendor: ' + e.vendor) : '', lines: lines };
  }

  function createOne(it) {
    var t = state.entityType, api = window.p86Api, payload = buildPayload(it);
    var p;
    if (t === 'po') p = api.purchaseOrders.create(it.jobId, payload);
    else if (t === 'co') p = api.changeOrders.create(it.jobId, payload);
    else p = api.invoices.create(payload);
    return p.then(function (res) {
      var rec = res && (res.purchase_order || res.change_order || res.invoice);
      it.status = 'done';
      it.createdNumber = rec && (rec.po_number || rec.co_number || rec.invoice_number) || '';
      // Push into the live caches so the job metrics reflect it without a reload.
      try {
        if (t === 'po' && rec) { window.appData.jobPurchaseOrders = (window.appData.jobPurchaseOrders || []).concat(rec); }
        if (t === 'co' && rec) { window.appData.jobChangeOrders = (window.appData.jobChangeOrders || []).concat(rec); }
        if (t === 'invoice' && rec) { window.appData.invoices = (window.appData.invoices || []).concat(rec); }
      } catch (_) {}
    }).catch(function (err) {
      it.status = 'error';
      it.error = 'Create failed: ' + (err && err.message ? err.message : 'server error');
    });
  }

  function createAll() {
    if (!state) return;
    var queue = state.items.filter(function (it) { return it.status === 'review' && it.jobId; });
    if (!queue.length) return;
    var i = 0;
    (function step() {
      if (i >= queue.length) {
        render();
        var ok = state.items.filter(function (it) { return it.status === 'done'; }).length;
        var fail = state.items.filter(function (it) { return it.status === 'error'; }).length;
        // Refresh whatever list/metrics are on screen.
        try { if (typeof window.renderJobsMain === 'function') window.renderJobsMain(); } catch (_) {}
        setTimeout(function () { alert('Created ' + ok + ' record' + (ok === 1 ? '' : 's') + (fail ? ' · ' + fail + ' failed (see the list).' : '.')); }, 60);
        return;
      }
      var it = queue[i++];
      it.status = 'creating'; render();
      createOne(it).then(function () { render(); step(); });
    })();
  }

  window.p86DocImport = { open: open };
})();
