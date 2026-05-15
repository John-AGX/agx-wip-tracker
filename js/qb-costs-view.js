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

  // Per-tab UI state. Filters + selection + sort survive across
  // re-renders within a session. Selection is a Set keyed by line id;
  // we re-render through a Set so checkboxes stay sticky across
  // filter changes.
  var _state = {
    jobId: null,
    filterCategory: '',
    filterVendor: '',
    filterTxnType: '',
    filterStatus: '', // '', 'linked', 'unlinked', 'orphan'
    search: '',
    sortBy: 'date',  // 'date' | 'vendor' | 'account' | 'amount'
    sortDir: 'desc', // 'asc' | 'desc'
    selected: (typeof Set === 'function') ? new Set() : null,
    embedTarget: null,
    // Cached graph nodes for the current job. Populated lazily from
    // either the live engine, the server, or localStorage. Used by
    // the link picker so the user doesn\'t see "No nodes in this
    // job\'s graph yet." when the workspace hasn\'t been opened in
    // this browser tab.
    nodesCache: { jobId: null, nodes: [] }
  };

  function isSelected(id) {
    return _state.selected && _state.selected.has(id);
  }
  function toggleSelected(id) {
    if (!_state.selected) return;
    if (_state.selected.has(id)) _state.selected.delete(id);
    else _state.selected.add(id);
  }
  function clearSelection() {
    if (_state.selected) _state.selected.clear();
  }
  function selectionSize() {
    return (_state.selected && _state.selected.size) || 0;
  }

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
      var allWs = JSON.parse(localStorage.getItem('p86-workspaces') || '{}');
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
    // Warm the graph-node cache from the server so the link picker
    // has data even when the user hasn\'t opened the Workspace tab
    // in this session (the previous localStorage-only lookup was the
    // bug behind "no node exists on the graph to link to" on a job
    // that DID have wired nodes — see getNodesForJob comments).
    prefetchGraphNodes(jobId);

    var allLines = getLinesForJob(jobId);
    var nodes = getNodesForJob(jobId);
    var validNodeIds = nodes.reduce(function(s, n) { s[n.id] = true; return s; }, {});

    // Pre-compute aggregates: by category, by vendor, by txn type.
    // Used both for the summary row and for the filter-chip palettes.
    var byCat = {};
    var byVendor = {};
    var byTxnType = {};
    var totalAll = 0;
    var unlinked = 0;
    var orphan = 0;
    var mostRecent = '';
    allLines.forEach(function(l) {
      var cat = l.account || '(uncategorized)';
      byCat[cat] = (byCat[cat] || 0) + l.amount;
      var ven = l.vendor || '(no vendor)';
      byVendor[ven] = (byVendor[ven] || 0) + l.amount;
      var tt = l.txnType || '(no type)';
      byTxnType[tt] = (byTxnType[tt] || 0) + l.amount;
      totalAll += l.amount;
      if (!l.linkedNodeId) unlinked++;
      if (l.linkedNodeId && !validNodeIds[l.linkedNodeId]) orphan++;
      var rd = l.reportDate || '';
      if (rd > mostRecent) mostRecent = rd;
    });

    // Apply filters
    var lines = allLines.slice();
    if (_state.filterCategory) {
      lines = lines.filter(function(l) { return (l.account || '(uncategorized)') === _state.filterCategory; });
    }
    if (_state.filterVendor) {
      lines = lines.filter(function(l) { return (l.vendor || '(no vendor)') === _state.filterVendor; });
    }
    if (_state.filterTxnType) {
      lines = lines.filter(function(l) { return (l.txnType || '(no type)') === _state.filterTxnType; });
    }
    if (_state.filterStatus === 'linked') {
      lines = lines.filter(function(l) { return !!l.linkedNodeId && validNodeIds[l.linkedNodeId]; });
    } else if (_state.filterStatus === 'unlinked') {
      lines = lines.filter(function(l) { return !l.linkedNodeId; });
    } else if (_state.filterStatus === 'orphan') {
      lines = lines.filter(function(l) { return !!l.linkedNodeId && !validNodeIds[l.linkedNodeId]; });
    }
    if (_state.search) {
      var q = _state.search.toLowerCase();
      lines = lines.filter(function(l) {
        return (
          (l.vendor && l.vendor.toLowerCase().indexOf(q) !== -1) ||
          (l.memo && l.memo.toLowerCase().indexOf(q) !== -1) ||
          (l.account && l.account.toLowerCase().indexOf(q) !== -1) ||
          (l.klass && l.klass.toLowerCase().indexOf(q) !== -1) ||
          (l.num && l.num.toLowerCase().indexOf(q) !== -1)
        );
      });
    }
    // Sort by user-selected column. Date / vendor / account use string
    // compare; amount uses numeric. Direction toggles asc/desc.
    var dir = _state.sortDir === 'asc' ? 1 : -1;
    lines.sort(function(a, b) {
      var key = _state.sortBy;
      var av, bv;
      if (key === 'amount') {
        av = a.amount || 0; bv = b.amount || 0;
        return dir * (av - bv);
      }
      if (key === 'vendor')  { av = a.vendor || '';  bv = b.vendor || ''; }
      else if (key === 'account') { av = a.account || ''; bv = b.account || ''; }
      else { av = a.date || ''; bv = b.date || ''; }
      var primary = av.localeCompare(bv) * dir;
      if (primary !== 0) return primary;
      // Secondary stable sort by amount desc so equal-key rows have a
      // predictable order across renders.
      return (b.amount || 0) - (a.amount || 0);
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
      summaryHtml = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin-bottom:14px;">' +
        statCard('Total', fmtMoney(totalAll), '#34d399') +
        statCard('Lines', allLines.length, '#4f8cff') +
        statCard('Unlinked', unlinked, unlinked > 0 ? '#fbbf24' : '#34d399') +
        statCard('Vendors', Object.keys(byVendor).length, '#a78bfa') +
        // Surface orphans only when there are any — keeps the row
        // tight in the common (clean) case.
        (orphan > 0
          ? '<div style="background:var(--card-bg,#0f0f1e);border:1px solid rgba(248,113,113,0.4);border-radius:8px;padding:10px 12px;cursor:pointer;" ' +
            'onclick="window.qbCostsView.cleanOrphans()" title="Click to null out the broken links in one batch.">' +
            '<div style="font-size:10px;color:#f87171;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Orphan links</div>' +
            '<div style="font-size:16px;font-weight:700;color:#f87171;">' + orphan + ' &middot; clean &rarr;</div>' +
            '</div>'
          : '') +
      '</div>';

      // Group-link palettes: account + vendor + txn-type. Each chip
      // filters the table; ALSO (when a chip is the active filter)
      // a "Link all → node" button surfaces in the bulk bar so the
      // user can mass-assign the entire filter set in one click.
      function chipPalette(label, bucket, activeKey, setterName) {
        var keys = Object.keys(bucket).sort(function(a, b) { return bucket[b] - bucket[a]; });
        if (!keys.length) return '';
        var html = '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:8px 12px;margin-bottom:10px;">' +
          '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">' + label + ' (click to filter)</div>' +
          '<div style="display:flex;flex-wrap:wrap;gap:5px;">';
        keys.forEach(function(k) {
          var pct = totalAll > 0 ? Math.round(bucket[k] / totalAll * 100) : 0;
          var isActive = activeKey === k;
          // String arg passed via single-quoted JS literal inside the
          // double-quoted onclick attr. JSON.stringify gave us literal
          // double-quotes that terminated the attribute early — the
          // chip click did nothing.
          html += '<button class="ee-btn ' + (isActive ? '' : 'secondary') + '" ' +
            'onclick="window.qbCostsView.' + setterName + '(\'' + escapeAttr(k) + '\')" ' +
            'style="font-size:11px;padding:3px 9px;">' +
            escapeHTML(k) + ' &middot; ' + fmtMoney(bucket[k]) + ' (' + pct + '%)' +
          '</button>';
        });
        html += '</div></div>';
        return html;
      }
      summaryHtml += chipPalette('By Distribution Account', byCat, _state.filterCategory, 'filterByCategory');
      summaryHtml += chipPalette('By Vendor / Sub', byVendor, _state.filterVendor, 'filterByVendor');
      // Show txn-type only when there's variety — single-type is just clutter.
      if (Object.keys(byTxnType).length > 1) {
        summaryHtml += chipPalette('By Transaction Type', byTxnType, _state.filterTxnType, 'filterByTxnType');
      }
    }

    // ── Filter / search bar ─────────────────────────────────────
    var filterBarHtml = '';
    if (allLines.length) {
      var activeFilterChips = '';
      function chipReset(label, setter, val) {
        // Single-quoted JS literal inside double-quoted attr —
        // matches the chip palette pattern above.
        return '<button class="ee-btn secondary" style="font-size:11px;" ' +
          'onclick="window.qbCostsView.' + setter + '(\'' + escapeAttr(val || '') + '\')">&times; ' +
          escapeHTML(label) + '</button>';
      }
      if (_state.filterCategory) activeFilterChips += chipReset(_state.filterCategory, 'filterByCategory');
      if (_state.filterVendor)   activeFilterChips += chipReset(_state.filterVendor,   'filterByVendor');
      if (_state.filterTxnType)  activeFilterChips += chipReset(_state.filterTxnType,  'filterByTxnType');

      filterBarHtml = '<div class="action-buttons" style="margin-bottom:8px;flex-wrap:wrap;">' +
        '<select onchange="window.qbCostsView.setStatusFilter(this.value)" style="width:auto;min-width:140px;">' +
          '<option value="">All lines</option>' +
          '<option value="linked"' + (_state.filterStatus === 'linked' ? ' selected' : '') + '>Linked to node</option>' +
          '<option value="unlinked"' + (_state.filterStatus === 'unlinked' ? ' selected' : '') + '>Unlinked</option>' +
          (orphan > 0
            ? '<option value="orphan"' + (_state.filterStatus === 'orphan' ? ' selected' : '') + '>Orphan links (' + orphan + ')</option>'
            : '') +
        '</select>' +
        activeFilterChips +
        '<input type="text" placeholder="Search vendor, memo, account, num…" oninput="window.qbCostsView.setSearch(this.value)" value="' + escapeAttr(_state.search) + '" style="margin-left:auto;min-width:240px;" />' +
      '</div>' +
      '<p style="margin:6px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Showing ' + lines.length + ' of ' + allLines.length + ' lines &middot; ' + fmtMoney(filterTotal) + ' filtered total' +
      '</p>';
    }

    // ── Bulk action bar ─────────────────────────────────────────
    // Visible when any rows are selected, OR when a category/vendor
    // filter is active (so the user can mass-link the entire filter
    // set in one click — the "by category / by sub" UX the user
    // asked for).
    var selCount = selectionSize();
    var canGroupLink = !!(_state.filterCategory || _state.filterVendor);
    var bulkBarHtml = '';
    if (allLines.length && (selCount > 0 || canGroupLink)) {
      var selSum = lines.reduce(function(s, l) { return isSelected(l.id) ? s + l.amount : s; }, 0);
      var groupLabel = _state.filterCategory ? ('all in "' + _state.filterCategory + '"')
                     : _state.filterVendor ? ('all from "' + _state.filterVendor + '"')
                     : '';
      bulkBarHtml = '<div style="background:rgba(34,211,238,0.08);border:1px solid rgba(34,211,238,0.3);border-radius:8px;padding:8px 12px;margin-bottom:10px;display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
        (selCount > 0
          ? '<span style="font-size:12px;color:var(--text,#fff);font-weight:600;">' +
              selCount + ' selected &middot; ' + fmtMoney(selSum) +
            '</span>' +
            '<button class="ee-btn primary" style="font-size:11px;padding:4px 12px;" ' +
              'onclick="window.qbCostsView.openBulkLinkPicker()">' +
              '&#x1F517; Link selected to node' +
            '</button>' +
            '<button class="ee-btn secondary" style="font-size:11px;padding:4px 12px;" ' +
              'onclick="window.qbCostsView.bulkUnlink()">' +
              '&times; Unlink selected' +
            '</button>' +
            '<button class="ee-btn secondary" style="font-size:11px;padding:4px 10px;" ' +
              'onclick="window.qbCostsView.clearSelection()">Clear</button>'
          : '') +
        (canGroupLink && selCount === 0
          ? '<span style="font-size:12px;color:var(--text-dim,#aaa);">Group action: ' + lines.length + ' line' + (lines.length === 1 ? '' : 's') + ' &middot; ' + fmtMoney(filterTotal) + '</span>' +
            '<button class="ee-btn primary" style="font-size:11px;padding:4px 12px;" ' +
              'onclick="window.qbCostsView.openGroupLinkPicker()">' +
              '&#x1F517; Link ' + escapeHTML(groupLabel) + ' to node' +
            '</button>'
          : '') +
      '</div>';
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
      // Master checkbox state — checked when every visible row is
      // selected, indeterminate when only some are. Tri-state set on
      // the DOM after innerHTML below.
      var allVisibleSelected = lines.length > 0 && lines.every(function(l) { return isSelected(l.id); });
      var someVisibleSelected = lines.some(function(l) { return isSelected(l.id); }) && !allVisibleSelected;

      tableHtml = '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow-y:auto;overflow-x:auto;background:var(--card-bg,#0f0f1e);max-height:calc(100vh - 380px);min-height:200px;">' +
        '<table class="dense-table" style="width:100%;border-collapse:collapse;table-layout:auto;">' +
          '<thead style="background:var(--card-bg,#0f0f1e);border-bottom:1px solid var(--border,#333);position:sticky;top:0;z-index:1;">' +
            '<tr>' +
              '<th style="padding:6px 8px;width:28px;">' +
                '<input type="checkbox" id="qbcSelectAll" ' + (allVisibleSelected ? 'checked' : '') + ' ' +
                  'onchange="window.qbCostsView.selectAllVisible(this.checked)" ' +
                  'style="cursor:pointer;width:14px;height:14px;" />' +
              '</th>' +
              sortTh('Date', 'date') +
              sortTh('Vendor', 'vendor') +
              sortTh('Account', 'account') +
              th('Class') +
              th('Memo') +
              sortTh('Amount', 'amount', 'right') +
              th('Linked Node') +
            '</tr>' +
          '</thead><tbody>' +
            lines.map(function(l) { return renderRow(l, nodes, validNodeIds); }).join('') +
          '</tbody>' +
        '</table>' +
      '</div>';
    }

    panel.innerHTML = headerHtml + summaryHtml + filterBarHtml + bulkBarHtml + tableHtml;

    // Apply indeterminate state on master checkbox after render.
    var master = panel.querySelector('#qbcSelectAll');
    if (master && lines.length > 0) {
      master.indeterminate = lines.some(function(l) { return isSelected(l.id); }) &&
                             !lines.every(function(l) { return isSelected(l.id); });
    }
  }

  // Sortable column header. Clicking a sorted column toggles asc/desc;
  // clicking a different column switches sort to that column at desc.
  function sortTh(label, key, align) {
    var active = _state.sortBy === key;
    var arrow = active ? (_state.sortDir === 'asc' ? ' &uarr;' : ' &darr;') : '';
    return '<th style="padding:8px 10px;text-align:' + (align || 'left') + ';font-size:10px;color:' +
      (active ? 'var(--accent,#22d3ee)' : 'var(--text-dim,#888)') +
      ';text-transform:uppercase;letter-spacing:0.5px;font-weight:700;cursor:pointer;user-select:none;" ' +
      'onclick="window.qbCostsView.toggleSort(\'' + escapeAttr(key) + '\')">' + label + arrow + '</th>';
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

  function renderRow(l, nodes, validNodeIds) {
    var linkedNode = l.linkedNodeId ? nodes.find(function(n) { return n.id === l.linkedNodeId; }) : null;
    var isOrphan = !!l.linkedNodeId && validNodeIds && !validNodeIds[l.linkedNodeId];
    var statusCell;
    if (linkedNode) {
      statusCell =
        '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:rgba(52,211,153,0.12);color:#34d399;font-size:11px;font-weight:600;">' +
          '&#x2713; ' + escapeHTML(linkedNode.label || linkedNode.type) +
        '</span>' +
        ' <button class="ee-btn-icon ghost" style="font-size:10px;padding:2px 6px;margin-left:4px;" ' +
          'onclick="window.qbCostsView.unlinkLine(\'' + escapeAttr(l.id) + '\')" title="Unlink">&times;</button>';
    } else if (isOrphan) {
      // Linked to a node that no longer exists — surface as orphan
      // with a one-click "fix" that re-opens the picker.
      statusCell =
        '<span style="display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:10px;background:rgba(248,113,113,0.12);color:#f87171;font-size:11px;font-weight:600;" title="Linked node no longer exists in the graph">' +
          '&#x26A0; orphan' +
        '</span>' +
        ' <button class="ee-btn secondary" style="font-size:11px;padding:3px 10px;margin-left:4px;" ' +
          'onclick="window.qbCostsView.openLinkPicker(\'' + escapeAttr(l.id) + '\')">Re-assign &rarr;</button>';
    } else {
      statusCell =
        '<button class="ee-btn secondary" style="font-size:11px;padding:3px 10px;" ' +
          'onclick="window.qbCostsView.openLinkPicker(\'' + escapeAttr(l.id) + '\')">Assign &rarr;</button>';
    }

    var checked = isSelected(l.id);
    var rowBg = checked ? 'background:rgba(34,211,238,0.06);' : '';
    return '<tr style="border-bottom:1px solid var(--border,#333);' + rowBg + '">' +
      '<td style="padding:6px 8px;width:28px;">' +
        '<input type="checkbox" ' + (checked ? 'checked' : '') + ' ' +
          'data-qbc-select="' + escapeAttr(l.id) + '" ' +
          'onchange="window.qbCostsView.toggleSelect(\'' + escapeAttr(l.id) + '\')" ' +
          'style="cursor:pointer;width:14px;height:14px;" />' +
      '</td>' +
      td(fmtDate(l.date), { fontFamily: 'mono', size: 11, dim: true }) +
      td(l.vendor || '', { weight: 600 }) +
      td(l.account || '', { dim: true, size: 12 }) +
      td(l.klass || '', { dim: true, size: 12 }) +
      td(l.memo || '', { dim: true, size: 12, truncate: 60 }) +
      td(fmtMoney(l.amount), { mono: true, weight: 600, align: 'right', cls: 'qb-line-amount' }) +
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
    var clsAttr = opts.cls ? ' class="' + opts.cls + '"' : '';
    return '<td' + clsAttr + ' style="' + s + '">' + escapeHTML(text) + '</td>';
  }

  // Resolve graph nodes for a job using whichever source is freshest.
  // The link-picker was always reading 'p86-nodegraphs' from
  // localStorage, but the engine writes to 'agx-nodegraphs' (legacy
  // key never renamed) AND the authoritative copy lives in the
  // server's node_graphs table. On a fresh tab — or a different
  // browser / device — neither localStorage key is populated, so
  // the picker showed "No nodes in this job\'s graph yet." even
  // though the user had wired up nodes previously.
  //
  // Order of preference:
  //   1. Live engine (NG.nodes()) if it\'s loaded for THIS job —
  //      catches in-session edits before they\'ve been flushed.
  //   2. _state.nodesCache populated by prefetchGraphNodes() (server).
  //   3. localStorage under either the legacy 'agx-nodegraphs' key
  //      or the post-rebrand 'p86-nodegraphs' key.
  function getNodesForJob(jobId) {
    if (!jobId) return [];
    // 1. Live engine
    try {
      if (window.NG && typeof NG.job === 'function' && typeof NG.nodes === 'function') {
        if (NG.job() === jobId) {
          var liveNodes = NG.nodes();
          if (Array.isArray(liveNodes) && liveNodes.length) return liveNodes;
        }
      }
    } catch (e) { /* fall through */ }
    // 2. Server prefetch cache
    if (_state.nodesCache.jobId === jobId && Array.isArray(_state.nodesCache.nodes) && _state.nodesCache.nodes.length) {
      return _state.nodesCache.nodes;
    }
    // 3. localStorage — try both keys.
    var keys = ['agx-nodegraphs', 'p86-nodegraphs'];
    for (var k = 0; k < keys.length; k++) {
      try {
        var graphs = JSON.parse(localStorage.getItem(keys[k]) || '{}');
        var g = graphs[jobId];
        if (g && Array.isArray(g.nodes) && g.nodes.length) return g.nodes;
      } catch (e) { /* try next key */ }
    }
    return [];
  }

  // Pull the job\'s node graph from the server and stash it in
  // _state.nodesCache. Fire-and-forget; resolves silently. Called
  // when renderJobQBCosts mounts so the picker has nodes even if the
  // user never opened the Workspace tab in this session.
  function prefetchGraphNodes(jobId) {
    if (!jobId) return;
    if (_state.nodesCache.jobId === jobId && Array.isArray(_state.nodesCache.nodes) && _state.nodesCache.nodes.length) return;
    if (!window.p86Api || !window.p86Api.get) return;
    window.p86Api.get('/api/jobs/' + encodeURIComponent(jobId) + '/graph').then(function(resp) {
      var g = resp && resp.graph;
      var nodes = (g && Array.isArray(g.nodes)) ? g.nodes : [];
      _state.nodesCache = { jobId: jobId, nodes: nodes };
    }).catch(function() { /* best-effort */ });
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
  function filterByVendor(vendor) {
    _state.filterVendor = (_state.filterVendor === vendor) ? '' : vendor;
    reRender();
  }
  function filterByTxnType(tt) {
    _state.filterTxnType = (_state.filterTxnType === tt) ? '' : tt;
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
  function toggleSort(key) {
    if (_state.sortBy === key) {
      _state.sortDir = (_state.sortDir === 'asc') ? 'desc' : 'asc';
    } else {
      _state.sortBy = key;
      _state.sortDir = (key === 'amount' || key === 'date') ? 'desc' : 'asc';
    }
    reRender();
  }
  function toggleSelect(id) {
    toggleSelected(id);
    reRender();
  }
  function selectAllVisible(checked) {
    if (!_state.jobId) return;
    var allLines = getLinesForJob(_state.jobId);
    // Re-apply current filters so "select all" matches what the user
    // is actually seeing in the table.
    var visible = allLines.filter(function(l) {
      if (_state.filterCategory && (l.account || '(uncategorized)') !== _state.filterCategory) return false;
      if (_state.filterVendor && (l.vendor || '(no vendor)') !== _state.filterVendor) return false;
      if (_state.filterTxnType && (l.txnType || '(no type)') !== _state.filterTxnType) return false;
      var nodes = getNodesForJob(_state.jobId);
      var validNodeIds = nodes.reduce(function(s, n) { s[n.id] = true; return s; }, {});
      if (_state.filterStatus === 'linked')   return !!l.linkedNodeId && validNodeIds[l.linkedNodeId];
      if (_state.filterStatus === 'unlinked') return !l.linkedNodeId;
      if (_state.filterStatus === 'orphan')   return !!l.linkedNodeId && !validNodeIds[l.linkedNodeId];
      return true;
    });
    if (checked) {
      visible.forEach(function(l) { _state.selected && _state.selected.add(l.id); });
    } else {
      visible.forEach(function(l) { _state.selected && _state.selected.delete(l.id); });
    }
    reRender();
  }
  function clearSelectionPublic() {
    clearSelection();
    reRender();
  }

  // ── Link / unlink ────────────────────────────────────────────
  // In-house picker modal. Replaces the old browser-prompt flow:
  // grouped by node type, click-to-assign, live search. Closes on
  // backdrop click / Esc / Cancel. The chosen node id is patched on
  // the server (and on the local cache).
  // Shared node-picker modal. Used by single-line link, bulk-selected
  // link, and group-by-filter link. Differences are: (a) the summary
  // text shown above the search box, and (b) what happens when a
  // node row is clicked — passed in as `onPick(nodeId)`.
  function openNodePicker(headerText, summaryText, onPick) {
    if (!_state.jobId) return;
    var nodes = getNodesForJob(_state.jobId).filter(function(n) {
      return n.type !== 'note' && n.type !== 'wip';
    });
    if (!nodes.length) {
      // Cache miss — re-fetch from the server before giving up. The
      // user may have hit the picker before the panel\'s opening
      // prefetch resolved (or this is the first time the panel
      // opened in a tab that never loaded the Workspace).
      var jid = _state.jobId;
      if (window.p86Api && window.p86Api.get) {
        window.p86Api.get('/api/jobs/' + encodeURIComponent(jid) + '/graph').then(function(resp) {
          var g = resp && resp.graph;
          var serverNodes = (g && Array.isArray(g.nodes)) ? g.nodes : [];
          _state.nodesCache = { jobId: jid, nodes: serverNodes };
          if (serverNodes.length) {
            // Reopen the picker now that we have nodes.
            openNodePicker(headerText, summaryText, onPick);
          } else {
            alert('No nodes in this job\'s graph yet. Open the Workspace tab to build the graph first, then come back to assign.');
          }
        }).catch(function() {
          alert('No nodes in this job\'s graph yet. Open the Workspace tab to build the graph first, then come back to assign.');
        });
      } else {
        alert('No nodes in this job\'s graph yet. Open the Workspace tab to build the graph first, then come back to assign.');
      }
      return;
    }

    var TYPE_LABEL = {
      t1: 'Building (T1)', t2: 'Phase (T2)', sub: 'Subcontractor',
      co:  'Change Order', po:  'Purchase Order', inv: 'Invoice',
      labor:  'Labor', burden: 'Direct Burden', mat: 'Materials',
      gc: 'General Conditions', other:  'Other Cost', watch: 'Watch'
    };
    var TYPE_ORDER = ['sub', 't2', 't1', 'co', 'po', 'inv', 'labor', 'burden', 'mat', 'gc', 'other', 'watch'];

    var prior = document.getElementById('qbLinkPickerModal');
    if (prior) prior.remove();

    var modal = document.createElement('div');
    modal.id = 'qbLinkPickerModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">' + escapeHTML(headerText || 'Assign to a node') + '</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:10px;line-height:1.4;">' +
          escapeHTML(summaryText || '') +
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

      // Wire row clicks — onPick is the caller-supplied apply fn.
      listEl.querySelectorAll('.qb-link-pick-row').forEach(function(btn) {
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(79,140,255,0.12)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
        btn.addEventListener('click', function() {
          var nid = btn.getAttribute('data-node-id');
          if (!nid) return;
          closePicker();
          if (typeof onPick === 'function') onPick(nid);
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

    if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated() && lineId.indexOf('sheet:') !== 0) {
      window.p86Api.qbCosts.update(lineId, { linkedNodeId: nodeId }).catch(function(err) {
        console.warn('[qb-costs] link patch failed:', err && err.message);
      });
    }
    reRender();
  }

  // Single-line picker (orchestrates openNodePicker with line-specific
  // summary + the existing setLinkedNode applier).
  function openLinkPicker(lineId) {
    var line = (window.appData && Array.isArray(appData.qbCostLines))
      ? appData.qbCostLines.find(function(l) { return l.id === lineId; })
      : null;
    var summary = line
      ? (fmtMoney(line.amount) + ' · ' + (line.vendor || '(no vendor)') +
         (line.account ? ' · ' + line.account : '') +
         (line.memo ? ' — ' + String(line.memo).slice(0, 60) : ''))
      : 'this line';
    openNodePicker('Assign cost line to a node', summary, function(nodeId) {
      setLinkedNode(lineId, nodeId);
    });
  }

  // Bulk-selected: link every checkbox-selected line on this job.
  // Server-side bulk endpoint applies atomically.
  function openBulkLinkPicker() {
    var ids = _state.selected ? Array.from(_state.selected) : [];
    if (!ids.length) return;
    // Skip synthetic sheet-derived ids — server rejects them.
    var dbIds = ids.filter(function(id) { return id.indexOf('sheet:') !== 0; });
    if (!dbIds.length) {
      alert('Selected lines are sheet-derived (legacy) and can\'t be bulk-linked. Re-import from QB to upgrade them.');
      return;
    }
    var jobLines = (window.appData && Array.isArray(appData.qbCostLines))
      ? appData.qbCostLines.filter(function(l) { return _state.selected.has(l.id); })
      : [];
    var sumAmt = jobLines.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
    var summary = ids.length + ' line' + (ids.length === 1 ? '' : 's') + ' selected · ' + fmtMoney(sumAmt) + ' total';
    openNodePicker('Bulk-link selected lines', summary, function(nodeId) {
      applyBulkLink(dbIds, nodeId);
    });
  }

  // Group-by-filter: link every line currently visible under the
  // active category/vendor filter. Saves clicking each one.
  function openGroupLinkPicker() {
    if (!_state.jobId) return;
    var allLines = getLinesForJob(_state.jobId);
    var lines = allLines.filter(function(l) {
      if (_state.filterCategory && (l.account || '(uncategorized)') !== _state.filterCategory) return false;
      if (_state.filterVendor && (l.vendor || '(no vendor)') !== _state.filterVendor) return false;
      if (_state.filterTxnType && (l.txnType || '(no type)') !== _state.filterTxnType) return false;
      return true;
    });
    var dbIds = lines.map(function(l) { return l.id; }).filter(function(id) { return id.indexOf('sheet:') !== 0; });
    if (!dbIds.length) {
      alert('Nothing matches the current filter to link.');
      return;
    }
    var sumAmt = lines.reduce(function(s, l) { return s + Number(l.amount || 0); }, 0);
    var label = _state.filterCategory ? ('account "' + _state.filterCategory + '"')
              : _state.filterVendor ? ('vendor "' + _state.filterVendor + '"')
              : 'current filter';
    var summary = dbIds.length + ' line' + (dbIds.length === 1 ? '' : 's') + ' from ' + label + ' · ' + fmtMoney(sumAmt) + ' total';
    openNodePicker('Bulk-link by ' + (_state.filterCategory ? 'account' : 'vendor'), summary, function(nodeId) {
      applyBulkLink(dbIds, nodeId);
    });
  }

  // Bulk-unlink: clear linked_node_id on every selected line. Same
  // server endpoint as bulk-link, just with nodeId=null.
  function bulkUnlink() {
    var ids = _state.selected ? Array.from(_state.selected) : [];
    if (!ids.length) return;
    var dbIds = ids.filter(function(id) { return id.indexOf('sheet:') !== 0; });
    if (!dbIds.length) return;
    if (!confirm('Unlink ' + dbIds.length + ' selected line' + (dbIds.length === 1 ? '' : 's') + ' from their nodes?')) return;
    applyBulkLink(dbIds, null);
  }

  // Shared applier for bulk-link and bulk-unlink. Optimistic local
  // update first so the table reflects the change instantly; server
  // call follows and reconciles on failure (warns + reverts).
  function applyBulkLink(ids, nodeId) {
    var lines = (window.appData && window.appData.qbCostLines) || [];
    var idSet = {};
    ids.forEach(function(id) { idSet[id] = true; });
    // Snapshot prior values for rollback on failure.
    var prior = [];
    lines.forEach(function(l) {
      if (idSet[l.id]) {
        prior.push({ id: l.id, prev: l.linked_node_id });
        l.linked_node_id = nodeId;
      }
    });
    clearSelection();
    reRender();

    if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
      window.p86Api.qbCosts.bulkLink(ids, nodeId).then(function() {
        // Server confirms — local state already matches.
      }).catch(function(err) {
        console.warn('[qb-costs] bulk link failed, rolling back:', err && err.message);
        prior.forEach(function(p) {
          var l = lines.find(function(x) { return x.id === p.id; });
          if (l) l.linked_node_id = p.prev;
        });
        reRender();
        alert('Bulk link failed: ' + (err.message || 'server error'));
      });
    }
  }

  // Orphan cleanup: ask the server to null out every linked_node_id
  // on this job that points at a node not in the current graph.
  function cleanOrphans() {
    if (!_state.jobId) return;
    var nodes = getNodesForJob(_state.jobId);
    var validNodeIds = nodes.map(function(n) { return n.id; });
    if (!confirm('Clear linked_node_id on every line pointing at a deleted node? This is one-way (you\'ll need to reassign manually).')) return;
    if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
      window.p86Api.qbCosts.cleanupOrphans(_state.jobId, validNodeIds).then(function(res) {
        // Refresh from server so the local cache reflects the cleared links.
        return window.p86Api.qbCosts.list(_state.jobId).then(function(listRes) {
          if (window.appData && Array.isArray(window.appData.qbCostLines) && listRes && listRes.lines) {
            window.appData.qbCostLines = listRes.lines.map(function(l) { return l; });
          }
          reRender();
          alert('Cleared ' + (res && res.cleared || 0) + ' orphan link' + ((res && res.cleared) === 1 ? '' : 's') + '.');
        });
      }).catch(function(err) {
        alert('Orphan cleanup failed: ' + (err.message || 'server error'));
      });
    }
  }

  // ── Public API ───────────────────────────────────────────────
  window.renderJobQBCosts = renderJobQBCosts;
  window.qbCostsView = {
    filterByCategory: filterByCategory,
    filterByVendor: filterByVendor,
    filterByTxnType: filterByTxnType,
    setStatusFilter: setStatusFilter,
    setSearch: setSearch,
    toggleSort: toggleSort,
    toggleSelect: toggleSelect,
    selectAllVisible: selectAllVisible,
    clearSelection: clearSelectionPublic,
    openLinkPicker: openLinkPicker,
    openBulkLinkPicker: openBulkLinkPicker,
    openGroupLinkPicker: openGroupLinkPicker,
    bulkUnlink: bulkUnlink,
    cleanOrphans: cleanOrphans,
    unlinkLine: unlinkLine
  };
})();
