// QB Costs (Detailed) sub-tab — Phase 2.
//
// Renders the imported QuickBooks job-cost lines (server-persisted in
// qb_cost_lines, hydrated to appData.qbCostLines on load) for a single
// job. Summary cards across the top, filterable table below.
//
// Linkage to the node graph: each line has an optional linked_node_id
// (set by the user via the picker, or by the AI in Phase 3). The
// "Linked Node" column shows the connection or surfaces an "Assign"
// button when missing — that's how QB spend gets reconciled against
// the cost-flow tree.

(function() {
  'use strict';

  function fmtMoney(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtDate(d) {
    if (!d) return '';
    if (d instanceof Date) return d.toISOString().slice(0, 10);
    var s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }
  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  // Per-tab UI state. Filters survive across re-renders within a session.
  var _state = {
    jobId: null,
    filterCategory: '',
    filterStatus: '', // '', 'linked', 'unlinked'
    search: ''
  };

  // Pull lines from appData (DB-hydrated) and from the legacy workspace
  // sheets (pre-Phase-2 data sitting in localStorage). Server data wins
  // when both exist for the same job — but we don't yet auto-migrate
  // sheet-only data, so display falls back to it.
  function getLinesForJob(jobId) {
    var lines = (window.appData && window.appData.qbCostLines) || [];
    var matched = lines.filter(function(l) { return l.job_id === jobId || l.jobId === jobId; });
    if (matched.length) return matched.map(normalizeServerLine);
    // Fallback: parse the workspace sheets (same logic the AI panel uses).
    return getLinesFromWorkspaceSheets(jobId);
  }

  function normalizeServerLine(l) {
    return {
      id: l.id,
      jobId: l.job_id || l.jobId,
      vendor: l.vendor || '',
      date: l.txn_date || l.date || '',
      txnType: l.txn_type || l.txnType || '',
      num: l.num || '',
      account: l.account || '',
      accountType: l.account_type || l.accountType || '',
      klass: l.klass || '',
      memo: l.memo || '',
      amount: Number(l.amount || 0),
      linkedNodeId: l.linked_node_id || l.linkedNodeId || null,
      reportDate: l.report_date || l.reportDate || null,
      sourceFile: l.source_file || l.sourceFile || null
    };
  }

  function getLinesFromWorkspaceSheets(jobId) {
    try {
      var allWs = JSON.parse(localStorage.getItem('agx-workspaces') || '{}');
      var wb = allWs[jobId];
      if (!wb || !Array.isArray(wb.sheets)) return [];
      var qbSheets = wb.sheets.filter(function(s) { return /^QB Costs /.test(s.name || ''); });
      if (!qbSheets.length) return [];
      var out = [];
      qbSheets.forEach(function(s) {
        var cells = s.cells || {};
        var headerCells = {};
        Object.keys(cells).forEach(function(k) {
          var m = k.match(/^(\d+),(\d+)$/);
          if (!m) return;
          var r = parseInt(m[1], 10), c = parseInt(m[2], 10);
          if (r === 3) headerCells[c] = String(cells[k].value || '').trim();
        });
        var col = {};
        Object.keys(headerCells).forEach(function(c) {
          var name = headerCells[c].toLowerCase();
          if (name === 'vendor') col.vendor = +c;
          else if (name === 'date') col.date = +c;
          else if (name === 'amount') col.amount = +c;
          else if (name === 'account') col.account = +c;
          else if (name === 'class') col.klass = +c;
          else if (name === 'memo') col.memo = +c;
          else if (name === 'transaction type') col.txnType = +c;
          else if (name === 'num') col.num = +c;
        });
        var dateMatch = (s.name || '').match(/QB Costs (\d{4}-\d{2}-\d{2})/);
        var sheetDate = dateMatch ? dateMatch[1] : null;
        var rows = {};
        Object.keys(cells).forEach(function(k) {
          var m = k.match(/^(\d+),(\d+)$/);
          if (!m) return;
          var r = parseInt(m[1], 10);
          if (r >= 4) rows[r] = true;
        });
        Object.keys(rows).forEach(function(r) {
          var ri = parseInt(r, 10);
          var cellAt = function(c) { var v = cells[ri + ',' + c]; return v ? v.value : null; };
          var amt = col.amount != null ? Number(cellAt(col.amount)) : 0;
          if (!isFinite(amt) || amt === 0) return;
          var labelCell = col.amount != null ? cells[ri + ',' + (col.amount - 1)] : null;
          if (labelCell && /^TOTAL$/i.test(String(labelCell.value || '').trim())) return;
          out.push({
            id: 'sheet:' + s.id + ':' + ri,  // synthetic id (sheet-scoped)
            jobId: jobId,
            vendor: col.vendor != null ? String(cellAt(col.vendor) || '') : '',
            date: col.date != null ? String(cellAt(col.date) || '') : '',
            txnType: col.txnType != null ? String(cellAt(col.txnType) || '') : '',
            num: col.num != null ? String(cellAt(col.num) || '') : '',
            account: col.account != null ? String(cellAt(col.account) || '') : '',
            accountType: '',
            klass: col.klass != null ? String(cellAt(col.klass) || '') : '',
            memo: col.memo != null ? String(cellAt(col.memo) || '') : '',
            amount: amt,
            linkedNodeId: null,
            reportDate: sheetDate
          });
        });
      });
      return out;
    } catch (e) {
      return [];
    }
  }

  // Build the panel DOM the first time we render this job. Idempotent —
  // nukes any prior content so re-rendering on tab switch is clean.
  //
  // If `customTarget` is supplied, render an embedded panel into it
  // (used by the workspace's "Detailed Costs" sheet) and skip the
  // right-pane sub-tab plumbing entirely.
  function ensurePanel(jobId, customTarget) {
    if (customTarget) {
      // Workspace embed mode — host a per-target child div so we don't
      // overwrite anything else the caller put in the container, and so
      // re-renders are scoped to a stable element. Class +
      // sub-tab-content-job mirror the right-pane host so any utility
      // CSS scoped to that selector applies here too. Inline styles
      // mirror .ws-right-content (12px padding, surface bg, scroll).
      var embed = customTarget.querySelector(':scope > .qb-costs-embed');
      if (!embed) {
        embed = document.createElement('div');
        embed.className = 'qb-costs-embed sub-tab-content-job';
        embed.style.display = 'block';
        embed.style.padding = '12px';
        embed.style.height = '100%';
        embed.style.overflowY = 'auto';
        embed.style.boxSizing = 'border-box';
        embed.style.background = 'var(--surface, #1a1d27)';
        customTarget.innerHTML = '';
        customTarget.appendChild(embed);
      }
      return embed;
    }

    var panel = document.getElementById('job-qb-costs');
    if (!panel) {
      var rc = document.getElementById('wsRightContent');
      if (!rc) return null;
      panel = document.createElement('div');
      panel.id = 'job-qb-costs';
      panel.className = 'sub-tab-content-job';
      rc.appendChild(panel);
    }
    // The tab switcher hides all panels then shows the active one
    // BEFORE the renderer creates this panel for the first time —
    // so the show-step misses us. Ensure visibility here, and hide
    // any other sub-tab-content-job siblings so only ours shows.
    var rcEl = document.getElementById('wsRightContent');
    if (rcEl) {
      Array.prototype.forEach.call(rcEl.children, function(c) {
        if (c.classList.contains('ws-job-info-details')) return;
        c.style.display = c === panel ? 'block' : 'none';
      });
    } else {
      panel.style.display = 'block';
    }
    return panel;
  }

  function renderJobQBCosts(jobId, customTarget) {
    var panel = ensurePanel(jobId, customTarget);
    if (!panel) return;
    _state.jobId = jobId;
    // Track the latest embed target so filter/search/link callbacks
    // can re-render into the same place rather than the right pane.
    _state.embedTarget = customTarget || null;

    var allLines = getLinesForJob(jobId);
    var byCat = {};
    var totalAll = 0;
    var unlinked = 0;
    var mostRecent = '';
    allLines.forEach(function(l) {
      var key = l.account || '(uncategorized)';
      byCat[key] = (byCat[key] || 0) + l.amount;
      totalAll += l.amount;
      if (!l.linkedNodeId) unlinked++;
      var rd = l.reportDate || '';
      if (rd > mostRecent) mostRecent = rd;
    });

    // Apply filters
    var lines = allLines.slice();
    if (_state.filterCategory) {
      lines = lines.filter(function(l) { return (l.account || '(uncategorized)') === _state.filterCategory; });
    }
    if (_state.filterStatus === 'linked') {
      lines = lines.filter(function(l) { return !!l.linkedNodeId; });
    } else if (_state.filterStatus === 'unlinked') {
      lines = lines.filter(function(l) { return !l.linkedNodeId; });
    }
    if (_state.search) {
      var q = _state.search.toLowerCase();
      lines = lines.filter(function(l) {
        return (
          (l.vendor && l.vendor.toLowerCase().indexOf(q) !== -1) ||
          (l.memo && l.memo.toLowerCase().indexOf(q) !== -1) ||
          (l.account && l.account.toLowerCase().indexOf(q) !== -1) ||
          (l.klass && l.klass.toLowerCase().indexOf(q) !== -1)
        );
      });
    }
    // Sort by date desc, amount desc
    lines.sort(function(a, b) {
      if (a.date !== b.date) return (b.date || '').localeCompare(a.date || '');
      return b.amount - a.amount;
    });

    var filterTotal = lines.reduce(function(s, l) { return s + l.amount; }, 0);

    // ── Header strip ────────────────────────────────────────────
    var headerHtml = '<div class="action-buttons" style="align-items:center;">' +
      '<div style="display:flex;flex-direction:column;gap:2px;">' +
        '<strong style="font-size:14px;">QuickBooks Detailed Costs</strong>' +
        '<span style="font-size:11px;color:var(--text-dim,#888);">' +
          (allLines.length ? allLines.length + ' line' + (allLines.length === 1 ? '' : 's') : 'No data imported yet') +
          (mostRecent ? ' &middot; latest report: <strong>' + escapeHTML(mostRecent) + '</strong>' : '') +
        '</span>' +
      '</div>' +
      '<button class="success" style="margin-left:auto;" onclick="(function(){var b=document.getElementById(\'qbCostsImportBtn\');if(b)b.click();})()">&#x1F4E5; Re-import</button>' +
    '</div>';

    // ── Summary cards ───────────────────────────────────────────
    var summaryHtml = '';
    if (allLines.length) {
      summaryHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:10px;margin-bottom:14px;">' +
        statCard('Total', fmtMoney(totalAll), '#34d399') +
        statCard('Lines', allLines.length, '#4f8cff') +
        statCard('Unlinked', unlinked, unlinked > 0 ? '#fbbf24' : '#34d399') +
        statCard('Categories', Object.keys(byCat).length, '#a78bfa') +
      '</div>';

      // By-category breakdown — clickable for filtering
      var sortedCats = Object.keys(byCat).sort(function(a, b) { return byCat[b] - byCat[a]; });
      summaryHtml += '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:10px 14px;margin-bottom:14px;">' +
        '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:8px;">By Distribution Account (click to filter)</div>' +
        '<div style="display:flex;flex-wrap:wrap;gap:6px;">';
      sortedCats.forEach(function(cat) {
        var pct = totalAll > 0 ? Math.round(byCat[cat] / totalAll * 100) : 0;
        var isActive = _state.filterCategory === cat;
        summaryHtml += '<button class="ee-btn ' + (isActive ? '' : 'secondary') + '" ' +
          'onclick="window.qbCostsView.filterByCategory(\'' + escapeAttr(cat) + '\')" ' +
          'style="font-size:11px;padding:4px 10px;">' +
          escapeHTML(cat) + ' &middot; ' + fmtMoney(byCat[cat]) + ' (' + pct + '%)' +
        '</button>';
      });
      summaryHtml += '</div></div>';
    }

    // ── Filter / search bar ─────────────────────────────────────
    var filterBarHtml = '';
    if (allLines.length) {
      filterBarHtml = '<div class="action-buttons" style="margin-bottom:8px;">' +
        '<select onchange="window.qbCostsView.setStatusFilter(this.value)" style="width:auto;min-width:140px;">' +
          '<option value="">All lines</option>' +
          '<option value="linked"' + (_state.filterStatus === 'linked' ? ' selected' : '') + '>Linked to node</option>' +
          '<option value="unlinked"' + (_state.filterStatus === 'unlinked' ? ' selected' : '') + '>Unlinked</option>' +
        '</select>' +
        (_state.filterCategory
          ? '<button class="ee-btn secondary" style="font-size:11px;" onclick="window.qbCostsView.filterByCategory(\'\')">&times; ' + escapeHTML(_state.filterCategory) + '</button>'
          : '') +
        '<input type="text" placeholder="Search vendor, memo, account…" oninput="window.qbCostsView.setSearch(this.value)" value="' + escapeAttr(_state.search) + '" style="margin-left:auto;min-width:240px;" />' +
      '</div>' +
      '<p style="margin:6px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Showing ' + lines.length + ' of ' + allLines.length + ' lines &middot; ' + fmtMoney(filterTotal) + ' filtered total' +
      '</p>';
    }

    // ── Lines table ─────────────────────────────────────────────
    var tableHtml = '';
    if (!allLines.length) {
      tableHtml = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);background:var(--card-bg,#0f0f1e);border:1px dashed var(--border,#333);border-radius:10px;font-size:13px;">' +
        '<div style="margin-bottom:8px;font-size:24px;">&#x1F4CB;</div>' +
        '<div style="font-weight:600;margin-bottom:4px;">No QB cost data for this job yet</div>' +
        '<div style="font-size:12px;">Import the weekly Detailed Job Cost xlsx from the WIP page to populate.</div>' +
      '</div>';
    } else if (!lines.length) {
      tableHtml = '<div style="padding:20px;text-align:center;color:var(--text-dim,#888);background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;">' +
        'No lines match the current filter.' +
      '</div>';
    } else {
      var nodes = getNodesForJob(jobId);
      // Self-contained scroll container — bounded by viewport so the
      // user can flip through hundreds of QB lines without scrolling
      // the whole page. Sticky header keeps column labels visible
      // while scrolling.
      tableHtml = '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-y:auto;overflow-x:auto;background:var(--card-bg,#0f0f1e);max-height:calc(100vh - 360px);min-height:200px;">' +
        '<table class="dense-table" style="width:100%;border-collapse:collapse;table-layout:auto;">' +
          '<thead style="background:var(--card-bg,#0f0f1e);border-bottom:1px solid var(--border,#333);position:sticky;top:0;z-index:1;">' +
            '<tr>' +
              th('Date') + th('Vendor') + th('Account') + th('Class') + th('Memo') +
              th('Amount', 'right') + th('Linked Node') +
            '</tr>' +
          '</thead><tbody>' +
            lines.map(function(l) { return renderRow(l, nodes); }).join('') +
          '</tbody>' +
        '</table>' +
      '</div>';
    }

    panel.innerHTML = headerHtml + summaryHtml + filterBarHtml + tableHtml;
  }

  function statCard(label, value, color) {
    return '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:10px 12px;">' +
      '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + escapeHTML(label) + '</div>' +
      '<div style="font-size:16px;font-weight:700;color:' + color + ';">' + escapeHTML(String(value)) + '</div>' +
    '</div>';
  }

  function th(label, align) {
    return '<th style="padding:8px 10px;text-align:' + (align || 'left') + ';font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' + label + '</th>';
  }

  function renderRow(l, nodes) {
    var linkedNode = l.linkedNodeId ? nodes.find(function(n) { return n.id === l.linkedNodeId; }) : null;
    var statusCell = linkedNode
      ? '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:rgba(52,211,153,0.12);color:#34d399;font-size:11px;font-weight:600;">' +
          '&#x2713; ' + escapeHTML(linkedNode.label || linkedNode.type) +
        '</span>' +
        ' <button class="ee-btn-icon ghost" style="font-size:10px;padding:2px 6px;margin-left:4px;" ' +
          'onclick="window.qbCostsView.unlinkLine(\'' + escapeAttr(l.id) + '\')" title="Unlink">&times;</button>'
      : '<button class="ee-btn secondary" style="font-size:11px;padding:3px 10px;" ' +
          'onclick="window.qbCostsView.openLinkPicker(\'' + escapeAttr(l.id) + '\')">Assign &rarr;</button>';

    return '<tr style="border-bottom:1px solid var(--border,#333);">' +
      td(fmtDate(l.date), { fontFamily: 'mono', size: 11, dim: true }) +
      td(l.vendor || '', { weight: 600 }) +
      td(l.account || '', { dim: true, size: 12 }) +
      td(l.klass || '', { dim: true, size: 12 }) +
      td(l.memo || '', { dim: true, size: 12, truncate: 60 }) +
      td(fmtMoney(l.amount), { mono: true, weight: 600, align: 'right', color: '#34d399' }) +
      '<td style="padding:6px 10px;">' + statusCell + '</td>' +
    '</tr>';
  }

  function td(content, opts) {
    opts = opts || {};
    var s = 'padding:6px 10px;font-size:' + (opts.size || 13) + 'px;';
    if (opts.weight) s += 'font-weight:' + opts.weight + ';';
    if (opts.color) s += 'color:' + opts.color + ';';
    else if (opts.dim) s += 'color:var(--text-dim,#aaa);';
    if (opts.align) s += 'text-align:' + opts.align + ';';
    if (opts.mono || opts.fontFamily === 'mono') s += "font-family:'SF Mono',Consolas,monospace;";
    var text = content == null ? '' : String(content);
    if (opts.truncate && text.length > opts.truncate) {
      text = text.slice(0, opts.truncate) + '…';
    }
    return '<td style="' + s + '">' + escapeHTML(text) + '</td>';
  }

  function getNodesForJob(jobId) {
    try {
      var graphs = JSON.parse(localStorage.getItem('agx-nodegraphs') || '{}');
      var g = graphs[jobId];
      return (g && Array.isArray(g.nodes)) ? g.nodes : [];
    } catch (e) {
      return [];
    }
  }

  // ── Filter handlers ──────────────────────────────────────────
  // _state.embedTarget remembers the last container we rendered into
  // (workspace embed). Falling through to the right-pane path on a
  // re-render would erase the workspace UI, so we feed the same target
  // back through every re-render.
  function reRender() {
    if (_state.jobId) renderJobQBCosts(_state.jobId, _state.embedTarget || null);
  }
  function filterByCategory(cat) {
    _state.filterCategory = (_state.filterCategory === cat) ? '' : cat;
    reRender();
  }
  function setStatusFilter(v) {
    _state.filterStatus = v || '';
    reRender();
  }
  function setSearch(v) {
    _state.search = v || '';
    reRender();
  }

  // ── Link / unlink ────────────────────────────────────────────
  // In-house picker modal. Replaces the old browser-prompt flow:
  // grouped by node type, click-to-assign, live search. Closes on
  // backdrop click / Esc / Cancel. The chosen node id is patched on
  // the server (and on the local cache).
  function openLinkPicker(lineId) {
    if (!_state.jobId) return;
    var nodes = getNodesForJob(_state.jobId).filter(function(n) {
      return n.type !== 'note' && n.type !== 'wip';
    });
    if (!nodes.length) {
      alert('No nodes in this job\'s graph yet. Open the Workspace tab to build the graph first, then come back to assign.');
      return;
    }

    // Look up the line so the modal header shows what's being assigned.
    var line = (window.appData && Array.isArray(appData.qbCostLines))
      ? appData.qbCostLines.find(function(l) { return l.id === lineId; })
      : null;
    var lineSummary = line
      ? (fmtMoney(line.amount) + ' · ' + (line.vendor || '(no vendor)') +
         (line.account ? ' · ' + line.account : '') +
         (line.memo ? ' — ' + String(line.memo).slice(0, 60) : ''))
      : 'this line';

    // Type → friendly label mapping for headers
    var TYPE_LABEL = {
      t1: 'Building (T1)',
      t2: 'Phase (T2)',
      sub: 'Subcontractor',
      co:  'Change Order',
      po:  'Purchase Order',
      inv: 'Invoice',
      labor:  'Labor',
      burden: 'Direct Burden',
      mat:    'Materials',
      gc:     'General Conditions',
      other:  'Other Cost',
      watch:  'Watch'
    };
    // Stable sort order — phases & buildings near the top, individual
    // cost-bucket types after, sub at the very top since most QB lines
    // are subcontractor charges.
    var TYPE_ORDER = ['sub', 't2', 't1', 'co', 'po', 'inv', 'labor', 'burden', 'mat', 'gc', 'other', 'watch'];

    // Strip any prior instance — re-opening shouldn't stack modals.
    var prior = document.getElementById('qbLinkPickerModal');
    if (prior) prior.remove();

    var modal = document.createElement('div');
    modal.id = 'qbLinkPickerModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">Assign cost line to a node</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:10px;line-height:1.4;">' +
          escapeHTML(lineSummary) +
        '</div>' +
        '<input type="text" id="qbLinkPickerSearch" placeholder="Search nodes…" autocomplete="off" ' +
          'style="width:100%;margin-bottom:10px;padding:8px 10px;font-size:13px;" />' +
        '<div id="qbLinkPickerList" style="max-height:50vh;overflow-y:auto;border:1px solid var(--border,#2e3346);border-radius:6px;background:var(--card-bg,#0f0f1e);"></div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button class="ee-btn secondary" id="qbLinkPickerCancel">Cancel</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    var listEl = modal.querySelector('#qbLinkPickerList');
    var searchEl = modal.querySelector('#qbLinkPickerSearch');

    function paintList() {
      var q = (searchEl.value || '').trim().toLowerCase();
      var matched = nodes.filter(function(n) {
        if (!q) return true;
        var label = (n.label || n.type || '').toLowerCase();
        var type = (n.type || '').toLowerCase();
        return label.indexOf(q) !== -1 || type.indexOf(q) !== -1;
      });

      // Group by type, then sort within each group by label
      var byType = {};
      matched.forEach(function(n) {
        var k = n.type || 'other';
        if (!byType[k]) byType[k] = [];
        byType[k].push(n);
      });

      var html = '';
      var typesPresent = TYPE_ORDER.filter(function(t) { return byType[t]; })
        .concat(Object.keys(byType).filter(function(t) { return TYPE_ORDER.indexOf(t) === -1; }));

      if (!typesPresent.length) {
        html = '<div style="padding:18px;text-align:center;color:var(--text-dim,#888);font-size:12px;">No nodes match.</div>';
      } else {
        typesPresent.forEach(function(t) {
          var group = byType[t].slice().sort(function(a, b) {
            return (a.label || '').localeCompare(b.label || '');
          });
          html += '<div style="padding:6px 10px;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);background:rgba(255,255,255,0.03);border-bottom:1px solid var(--border,#2e3346);">' +
            (TYPE_LABEL[t] || t) + ' &middot; ' + group.length +
          '</div>';
          group.forEach(function(n) {
            html += '<button class="qb-link-pick-row" data-node-id="' + escapeAttr(n.id) + '" ' +
              'style="display:block;width:100%;text-align:left;padding:8px 12px;background:transparent;border:none;border-bottom:1px solid var(--border,#2e3346);color:var(--text,#e4e6f0);font-size:13px;cursor:pointer;">' +
              '<span style="font-weight:600;">' + escapeHTML(n.label || n.type) + '</span>' +
              '<span style="margin-left:8px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(n.type || '') + '</span>' +
            '</button>';
          });
        });
      }
      listEl.innerHTML = html;

      // Wire row clicks
      listEl.querySelectorAll('.qb-link-pick-row').forEach(function(btn) {
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(79,140,255,0.12)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
        btn.addEventListener('click', function() {
          var nid = btn.getAttribute('data-node-id');
          if (!nid) return;
          closePicker();
          setLinkedNode(lineId, nid);
        });
      });
    }

    function closePicker() {
      document.removeEventListener('keydown', onKey);
      modal.remove();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closePicker(); }
    }

    modal.addEventListener('click', function(e) {
      if (e.target === modal) closePicker();
    });
    modal.querySelector('#qbLinkPickerCancel').addEventListener('click', closePicker);
    searchEl.addEventListener('input', paintList);
    document.addEventListener('keydown', onKey);

    paintList();
    setTimeout(function() { searchEl.focus(); }, 0);
  }

  function unlinkLine(lineId) {
    setLinkedNode(lineId, null);
  }

  function setLinkedNode(lineId, nodeId) {
    // Optimistic local update
    var lines = (window.appData && window.appData.qbCostLines) || [];
    var line = lines.find(function(l) { return l.id === lineId; });
    if (line) line.linked_node_id = nodeId;

    if (window.agxApi && window.agxApi.isAuthenticated && window.agxApi.isAuthenticated() && lineId.indexOf('sheet:') !== 0) {
      window.agxApi.qbCosts.update(lineId, { linkedNodeId: nodeId }).catch(function(err) {
        console.warn('[qb-costs] link patch failed:', err && err.message);
      });
    }
    reRender();
  }

  // ── Public API ───────────────────────────────────────────────
  window.renderJobQBCosts = renderJobQBCosts;
  window.qbCostsView = {
    filterByCategory: filterByCategory,
    setStatusFilter: setStatusFilter,
    setSearch: setSearch,
    openLinkPicker: openLinkPicker,
    unlinkLine: unlinkLine
  };
})();
