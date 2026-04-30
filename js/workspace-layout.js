// ============================================================
// AGX WIP Tracker — Layout Restructure v2 (Step 2)
// Two-column layout:
//   LEFT:  Workspace grid (portrait, always visible)
//   RIGHT: Compact metrics strip + horizontal tab navigation
// Job name + key costs in the main header bar
// Replaces workspace-inject.js — load AFTER app.js + wip.js + workspace.js
// ============================================================

(function () {
  'use strict';

  let layoutApplied = false;
  let currentJobId = null;
  let _ngComputing = false;

  // ── Tab definitions ──────────────────────────────────────
  // Overview is the landing tab (first). The new "Workspace" tab swaps
  // in a node-graph-style canvas with the spreadsheet rendered as a
  // floating, draggable, resizable panel on top.
  const RIGHT_TABS = [
    { id: 'job-overview',      label: 'Overview' },
    { id: 'job-workspace',     label: '\u{1F4CA} Workspace' },
    { id: 'job-wip',           label: 'WIP' },
    { id: 'job-costs',         label: 'Costs' },
    { id: 'job-changeorders',  label: 'CO\'s' },
    { id: 'job-purchaseorders',label: 'PO\'s' },
    { id: 'job-invoices',      label: 'Invoices' },
    { id: 'job-subs',          label: 'Subs' }
  ];

  // ── CSS injection ─────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ws-layout-v2-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-layout-v2-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace-layout.css?v=28';
    document.head.appendChild(link);
  }

  function injectWorkspaceCSS() {
    if (document.getElementById('ws-grid-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-grid-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace.css?v=20';
    document.head.appendChild(link);
  }

  // ── Cleanup old injections ────────────────────────────────
  function cleanup() {
    // Remove job info bar
    var jobInfo = document.querySelector(".jh-job-info");
    if (jobInfo) jobInfo.remove();

    // Remove tab-metrics row and restore nav.tabs to header-content
    var tabRow = document.getElementById("jh-tab-metrics-row");
    if (tabRow) {
      var nav = tabRow.querySelector("nav.tabs");
      var headerContent = document.querySelector(".header-content");
      if (nav && headerContent) {
        headerContent.appendChild(nav);
        nav.style.flex = "";
      }
      tabRow.remove();
    }

    // Remove any stale metrics strip (now lives detached at the top of the
    // detail view, not inside the header)
    var strip = document.querySelector(".jh-metrics-strip");
    if (strip) strip.remove();

    // Un-hide original job detail header and elements
    var detail = document.getElementById("wip-job-detail-view");
    if (detail) {
      var origHeader = detail.querySelector(".job-detail-header");
      if (origHeader) origHeader.style.display = "";
    }
    ['.action-buttons', '.sub-tabs', '#job-info-card'].forEach(function(sel) { var el = document.querySelector(sel); if (el) el.style.display = ''; });

    // Move sub-tab content panels back to detail before destroying two-col
    var twoCol = document.getElementById("ws-two-col");
    if (twoCol && detail) {
      // Rescue sub-tab panels
      var panels = twoCol.querySelectorAll('.sub-tab-content-job');
      panels.forEach(function(p) {
        p.style.display = '';
        detail.appendChild(p);
      });
      // Rescue job-info-card (moved into a <details> accordion)
      var jobInfoCard = twoCol.querySelector('#job-info-card');
      if (jobInfoCard) {
        jobInfoCard.style.display = '';
        jobInfoCard.style.border = '';
        jobInfoCard.style.boxShadow = '';
        jobInfoCard.classList.remove('ws-accordion-content');
        detail.appendChild(jobInfoCard);
      }
      // Remove the accordion wrapper
      var accordion = twoCol.querySelector('.ws-job-info-details');
      if (accordion) accordion.remove();
    }
    if (twoCol) twoCol.remove();
  }

  function buildHeader(detail, job) {
    var siteHeader = document.querySelector("header");
    if (!siteHeader || document.querySelector(".jh-metrics-strip")) return;
    var headerContent = siteHeader.querySelector(".header-content");
    var subtitle = headerContent ? headerContent.querySelector(".header-subtitle") : null;
    var nav = headerContent ? headerContent.querySelector("nav.tabs") : null;

    // ---- Extract metrics from WIP Calculations card ----
    var wipCalcs = null;
    var cards = detail.querySelectorAll(".card");
    cards.forEach(function(c) {
      var h = c.querySelector("h2, h3, h4");
      if (h && h.textContent.trim() === "WIP Calculations") wipCalcs = c;
    });
    var allText = wipCalcs ? wipCalcs.textContent.replace(/\s+/g, " ").trim() : "";

    function extractVal(text, label) {
      var idx = text.indexOf(label);
      if (idx === -1) return "--";
      var after = text.substring(idx + label.length).trim();
      var match = after.match(/^[\$\d,\.%\-]+/);
      return match ? match[0] : "--";
    }
    // Revenue Earned has parenthetical label
    var revVal = "--";
    var revIdx = allText.indexOf("Revenue Earned");
    if (revIdx > -1) {
      var revMatch = allText.substring(revIdx).match(/\$[\d,\.]+/);
      if (revMatch) revVal = revMatch[0];
    }

    // Order: Contract -> cost progression -> work-in-progress -> billing -> profit -> backlog
    var metricsData = [
      { label: "Contract Amount", value: extractVal(allText, "Total Income") },
      { label: "Est. Costs (Rev.)", value: extractVal(allText, "Total Est. Costs (Revised)") },
      { label: "Actual Costs", value: extractVal(allText, "Actual Costs (from tracker)") },
      { label: "Accrued Costs", value: "--" },
      { label: "Remaining Costs", value: extractVal(allText, "Remaining Est. Costs") },
      { label: "% Complete", value: extractVal(allText, "% Complete") },
      { label: "Revenue Earned", value: revVal },
      { label: "Invoiced", value: extractVal(allText, "Invoiced to Date") },
      { label: "Change Orders", value: extractVal(allText, "+ Change Orders") },
      { label: "Gross Profit", value: extractVal(allText, "Revised Gross Profit") },
      { label: "Margin JTD", value: extractVal(allText, "Revised Margin %") },
      { label: "Backlog", value: extractVal(allText, "Backlog (Income - Revenue)") }
    ];

    // ---- Job info (appended into header-right, below subtitle) ----
    var name = job ? (job.jobNumber || "") + " \u2014 " + (job.name || "") : "Job Detail";
    var headerRight = siteHeader.querySelector(".header-right");
    if (headerRight) {
      var jobInfo = document.createElement("div");
      jobInfo.className = "jh-job-info";

      var backBtn = document.createElement("button");
      backBtn.className = "jh-back-btn";
      backBtn.textContent = "\u2190 Back to WIP";
      backBtn.addEventListener("click", function() {
        var backLink = detail.querySelector("a[href], button");
        if (backLink) backLink.click();
      });
      jobInfo.appendChild(backBtn);

      var jobTitle = document.createElement("span");
      jobTitle.className = "jh-job-title";
      jobTitle.textContent = name;
      jobInfo.appendChild(jobTitle);

      var statusBadge = document.createElement("span");
      statusBadge.className = "jh-status-badge";
      statusBadge.textContent = job && job.status ? job.status : "In Progress";
      jobInfo.appendChild(statusBadge);

      headerRight.appendChild(jobInfo);
    }

    // Map each metric label to a tone hint so the card can color-code itself.
    // Income-side = blue, cost-side = red, gain-side (revenue/profit/margin)
    // = green, backlog/throughput = amber, neutral counters = gray.
    var METRIC_TONE = {
      'Contract Amount': 'income',
      'Est. Costs (Rev.)': 'cost',
      'Actual Costs': 'cost',
      'Accrued Costs': 'amber',
      'Remaining Costs': 'cost',
      '% Complete': 'neutral',
      'Revenue Earned': 'gain',
      'Invoiced': 'income',
      'Change Orders': 'income',
      'Gross Profit': 'gain',
      'Margin JTD': 'gain',
      'Backlog': 'neutral'
    };

    // ---- Metrics strip ----
    var strip = document.createElement("div");
    strip.className = "jh-metrics-strip";
    metricsData.forEach(function(m) {
      var card = document.createElement("div");
      card.className = "jh-strip-card";
      var tone = METRIC_TONE[m.label] || 'neutral';
      card.setAttribute('data-tone', tone);
      var lbl = document.createElement("div");
      lbl.className = "jh-strip-label";
      lbl.textContent = m.label;
      var val = document.createElement("div");
      val.className = "jh-strip-value";
      val.textContent = m.value;
      card.appendChild(lbl);
      card.appendChild(val);
      strip.appendChild(card);
    });

    // ---- Tab row (nav only — strip moved out of the sticky header) ----
    if (nav && headerContent) {
      var tabRow = document.createElement("div");
      tabRow.id = "jh-tab-metrics-row";
      tabRow.className = "jh-tab-metrics-row";
      nav.parentNode.insertBefore(tabRow, nav);
      nav.style.flex = "0 0 auto";
      tabRow.appendChild(nav);
    }

    // ---- Metrics strip ----
    // Lives in the detail view directly above the workspace grid so it spans
    // the full content width with no competition from the nav. Inserted at
    // the top of #wip-job-detail-view; cleanup removes it on tear-down.
    strip.id = "jh-strip-detached";
    detail.insertBefore(strip, detail.firstChild);

    // Hide original job-detail-header in page content
    var origHeader = detail.querySelector(".job-detail-header");
    if (origHeader) origHeader.style.display = "none";
  }

  /** Refresh the sticky header metrics strip with current WIP data */
  function refreshHeaderMetrics() {
    var strip = document.querySelector('.jh-metrics-strip');
    if (!strip || !currentJobId) return;
    if (typeof getJobWIP !== 'function' || typeof formatCurrency !== 'function') return;
    // Ensure node graph values are current before reading them.
    // Skip if pushToJob itself triggered us (avoid infinite recursion).
    if (!_ngComputing && typeof ensureNGComputed === 'function') {
      _ngComputing = true;
      try { ensureNGComputed(currentJobId); } finally { _ngComputing = false; }
    }
    var w = getJobWIP(currentJobId);
    var accrued = (typeof getJobAccruedCosts === 'function') ? getJobAccruedCosts(currentJobId) : 0;
    var map = {
      'Contract Amount': formatCurrency(w.totalIncome),
      'Est. Costs (Rev.)': formatCurrency(w.revisedEstCosts),
      'Actual Costs': formatCurrency(w.actualCosts),
      'Accrued Costs': formatCurrency(accrued),
      'Remaining Costs': formatCurrency(w.remainingCosts),
      '% Complete': w.pctComplete.toFixed(1) + '%',
      'Revenue Earned': formatCurrency(w.revenueEarned),
      'Invoiced': formatCurrency(w.invoiced),
      'Change Orders': formatCurrency(w.coIncome),
      'Gross Profit': formatCurrency(w.revisedProfit),
      'Margin JTD': w.jtdMargin.toFixed(1) + '%',
      'Backlog': formatCurrency(w.backlog)
    };
    strip.querySelectorAll('.jh-strip-card').forEach(function (card) {
      var lbl = card.querySelector('.jh-strip-label');
      var val = card.querySelector('.jh-strip-value');
      if (lbl && val && map[lbl.textContent]) val.textContent = map[lbl.textContent];
    });
    // Also update job title + status in job bar
    if (typeof appData !== 'undefined') {
      var job = appData.jobs.find(function (j) { return j.id === currentJobId; });
      if (job) {
        var titleEl = document.querySelector('.jh-job-title');
        if (titleEl) titleEl.textContent = (job.jobNumber || '') + ' \u2014 ' + (job.title || '');
        var statusEl = document.querySelector('.jh-status-badge');
        if (statusEl) statusEl.textContent = job.status || 'In Progress';
      }
    }
  }
  window.refreshHeaderMetrics = refreshHeaderMetrics;
  // Exposed so switchTab() can force a teardown when navigating away from WIP
  // (Insights / Estimates / Admin). Without this the sticky job-metrics
  // header lingers until the polling loop notices the detail view is hidden.
  window.workspaceLayoutCleanup = cleanup;

  function buildLayout(detail) {
    var container = document.createElement('div');
    container.id = 'ws-two-col';
    container.className = 'ws-two-col ws-single-col';

    // Single full-width column. Tabs strip + content. Overview is the
    // landing tab. The "Workspace" tab swaps in a node-graph-style
    // canvas with the spreadsheet rendered as a floating panel on top.
    var mainCol = document.createElement('div');
    mainCol.className = 'ws-col-right';

    var tabsHtml = '<div class="ws-right-tabs">';
    RIGHT_TABS.forEach(function(tab, i) {
      tabsHtml += '<button class="ws-right-tab' + (i === 0 ? ' active' : '') + '" data-panel="' + tab.id + '">' + tab.label + '</button>';
    });
    tabsHtml += '<div class="ws-right-tabs-actions">' +
      '<button class="ee-btn" onclick="openJobAI()" title="WIP / financial AI assistant" style="background:linear-gradient(135deg,#8b5cf6,#4f8cff);color:#fff;border-color:transparent;">✨ Ask AI</button>' +
    '</div>';
    tabsHtml += '</div>';

    var contentHtml = '<div class="ws-right-content" id="wsRightContent"></div>';
    mainCol.innerHTML = tabsHtml + contentHtml;
    container.appendChild(mainCol);

    var fp = document.createElement('div');
    fp.id = 'wsFloatingPanel';
    fp.className = 'ws-floating-panel';
    fp.style.display = 'none';
    fp.innerHTML =
      '<div class="ws-floating-header" id="wsFloatingHeader">' +
        '<span class="ws-floating-title">\u{1F4CA} Workspace</span>' +
        '<div class="ws-floating-actions">' +
          '<button class="ws-floating-btn" id="wsFloatingFocusBtn" title="Focus this workspace (zoom 100% + center)" style="display:none;">\u{1F3AF}</button>' +
          '<button class="ws-floating-btn" id="wsFloatingMinBtn" title="Minimize">—</button>' +
          '<button class="ws-floating-btn" id="wsFloatingMaxBtn" title="Maximize / restore">⛶</button>' +
        '</div>' +
      '</div>' +
      '<div class="ws-floating-body">' +
        '<div id="wsWorkspaceContainer" tabindex="0"></div>' +
      '</div>' +
      '<div class="ws-floating-resize" id="wsFloatingResize"></div>';
    container.appendChild(fp);

    return container;
  }

  var _floatingState = { inited: false, minimized: false, maximized: false, savedRect: null };
  function initFloatingPanel() {
    if (_floatingState.inited) return;
    var panel = document.getElementById('wsFloatingPanel');
    var header = document.getElementById('wsFloatingHeader');
    var resize = document.getElementById('wsFloatingResize');
    var minBtn = document.getElementById('wsFloatingMinBtn');
    var maxBtn = document.getElementById('wsFloatingMaxBtn');
    if (!panel || !header) return;

    function setInitialRect() {
      var canvas = document.getElementById('wsCanvas');
      if (!canvas) return;
      var r = canvas.getBoundingClientRect();
      panel.style.left = (r.left + 24) + 'px';
      panel.style.top = (r.top + 24) + 'px';
      panel.style.width = Math.max(780, Math.min(r.width - 48, 1280)) + 'px';
      panel.style.height = Math.max(520, Math.min(r.height - 48, 760)) + 'px';
    }
    setInitialRect();

    // In graph mode the panel lives inside the transformed .ng-canvas
    // element. Pan/zoom multiply the visual deltas, so we have to
    // divide by zoom to get correct movement in graph coordinates.
    function inGraphMode() { return panel.classList.contains('ws-floating-graph-mode'); }
    function currentZoom() {
      if (inGraphMode() && typeof NG !== 'undefined' && NG.zm) return NG.zm() || 1;
      return 1;
    }

    var dragging = null;
    header.addEventListener('mousedown', function(e) {
      if (e.target.closest('.ws-floating-btn')) return;
      var rect = panel.getBoundingClientRect();
      dragging = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startLeft: parseInt(panel.style.left, 10) || 0,
        startTop: parseInt(panel.style.top, 10) || 0,
        zoom: currentZoom()
      };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var dx = (e.clientX - dragging.startMouseX) / dragging.zoom;
      var dy = (e.clientY - dragging.startMouseY) / dragging.zoom;
      panel.style.left = (dragging.startLeft + dx) + 'px';
      panel.style.top = (dragging.startTop + dy) + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (dragging) {
        // Persist graph-mode position so it survives detach/reattach
        if (inGraphMode()) {
          panel.dataset.graphX = parseInt(panel.style.left, 10) || 0;
          panel.dataset.graphY = parseInt(panel.style.top, 10) || 0;
        }
        dragging = null;
        document.body.style.userSelect = '';
      }
    });

    var resizing = null;
    resize.addEventListener('mousedown', function(e) {
      var rect = panel.getBoundingClientRect();
      resizing = {
        startX: e.clientX,
        startY: e.clientY,
        startW: parseInt(panel.style.width, 10) || rect.width,
        startH: parseInt(panel.style.height, 10) || rect.height,
        zoom: currentZoom()
      };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    });
    document.addEventListener('mousemove', function(e) {
      if (!resizing) return;
      var dx = (e.clientX - resizing.startX) / resizing.zoom;
      var dy = (e.clientY - resizing.startY) / resizing.zoom;
      panel.style.width = Math.max(420, resizing.startW + dx) + 'px';
      panel.style.height = Math.max(280, resizing.startH + dy) + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (resizing) {
        if (inGraphMode()) {
          panel.dataset.graphW = parseInt(panel.style.width, 10) || 0;
          panel.dataset.graphH = parseInt(panel.style.height, 10) || 0;
        }
        resizing = null;
        document.body.style.userSelect = '';
      }
    });

    // Focus Workspace — visible only in graph mode. Sets zoom to 1.0
    // and pans the graph so the workspace center sits at the viewport
    // center. Lets the user pop into edit-readable scale anytime.
    var focusBtn = document.getElementById('wsFloatingFocusBtn');
    if (focusBtn) {
      focusBtn.addEventListener('click', function() {
        if (typeof NG === 'undefined' || !NG.zm || !NG.pan) return;
        var canvas = document.querySelector('#nodeGraphTab .ng-canvas');
        var area = document.querySelector('#nodeGraphTab .ng-canvas-area');
        if (!canvas || !area) return;
        var x = parseFloat(panel.style.left) || 0;
        var y = parseFloat(panel.style.top) || 0;
        var w = parseFloat(panel.style.width) || 720;
        var h = parseFloat(panel.style.height) || 480;
        var ar = area.getBoundingClientRect();
        // After applyTx: viewport_x = (graph_x + panX) * zoom
        // Want workspace center (x + w/2, y + h/2) at viewport center.
        NG.zm(1.0);
        var newPanX = (ar.width / 2) / 1.0 - (x + w / 2);
        var newPanY = (ar.height / 2) / 1.0 - (y + h / 2);
        NG.pan(newPanX, newPanY);
        // Trigger re-render via the existing applyTx + render functions
        if (typeof window.ngApplyTx === 'function') window.ngApplyTx();
        if (typeof window.ngRender === 'function') window.ngRender();
      });
    }

    minBtn.addEventListener('click', function() {
      _floatingState.minimized = !_floatingState.minimized;
      panel.classList.toggle('ws-floating-minimized', _floatingState.minimized);
    });
    maxBtn.addEventListener('click', function() {
      var canvas = document.getElementById('wsCanvas');
      if (!canvas) return;
      if (_floatingState.maximized) {
        if (_floatingState.savedRect) {
          panel.style.left = _floatingState.savedRect.left + 'px';
          panel.style.top = _floatingState.savedRect.top + 'px';
          panel.style.width = _floatingState.savedRect.width + 'px';
          panel.style.height = _floatingState.savedRect.height + 'px';
        }
        _floatingState.maximized = false;
      } else {
        var rect = panel.getBoundingClientRect();
        _floatingState.savedRect = { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        var c = canvas.getBoundingClientRect();
        panel.style.left = (c.left + 8) + 'px';
        panel.style.top = (c.top + 8) + 'px';
        panel.style.width = (c.width - 16) + 'px';
        panel.style.height = (c.height - 16) + 'px';
        _floatingState.maximized = true;
      }
    });
    _floatingState.inited = true;
  }

  function showFloatingWorkspace() {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel) return;
    panel.style.display = 'flex';
    initFloatingPanel();
  }
  function hideFloatingWorkspace() {
    var panel = document.getElementById('wsFloatingPanel');
    if (panel) panel.style.display = 'none';
  }

  // ── Graph integration: workspace as a pseudo-node ──────────
  // Attach the floating panel to the node-graph's transformed .ng-canvas
  // element. The panel lives in graph coordinate space — pan/zoom of
  // the graph affects it, drag moves it relative to graph coords.
  function attachWorkspaceToGraph() {
    var panel = document.getElementById('wsFloatingPanel');
    var canvas = document.querySelector('#nodeGraphTab .ng-canvas');
    if (!panel || !canvas) return;
    initFloatingPanel(); // safe to call repeatedly
    panel.classList.remove('ws-floating-tab-mode');
    panel.classList.add('ws-floating-graph-mode');
    // Restore previously-saved graph-mode position+size, or seed defaults
    var x = panel.dataset.graphX != null ? parseFloat(panel.dataset.graphX) : 100;
    var y = panel.dataset.graphY != null ? parseFloat(panel.dataset.graphY) : 100;
    var w = panel.dataset.graphW != null ? parseFloat(panel.dataset.graphW) : 720;
    var h = panel.dataset.graphH != null ? parseFloat(panel.dataset.graphH) : 480;
    panel.style.position = 'absolute';
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    canvas.appendChild(panel);
    panel.style.display = 'flex';
    var focusBtn = document.getElementById('wsFloatingFocusBtn');
    if (focusBtn) focusBtn.style.display = '';
  }
  function detachWorkspaceFromGraph() {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel) return;
    if (panel.classList.contains('ws-floating-graph-mode')) {
      panel.dataset.graphX = parseInt(panel.style.left, 10) || 100;
      panel.dataset.graphY = parseInt(panel.style.top, 10) || 100;
      panel.dataset.graphW = parseInt(panel.style.width, 10) || 720;
      panel.dataset.graphH = parseInt(panel.style.height, 10) || 480;
    }
    var twoCol = document.getElementById('ws-two-col');
    if (twoCol) twoCol.appendChild(panel);
    panel.classList.remove('ws-floating-graph-mode');
    panel.classList.add('ws-floating-tab-mode');
    panel.style.position = '';
    panel.style.display = 'none';
    var focusBtn = document.getElementById('wsFloatingFocusBtn');
    if (focusBtn) focusBtn.style.display = 'none';
  }
  // Watch the node graph tab for class changes — when it loses .active
  // (close button clicked), make sure the workspace panel detaches.
  function watchGraphTabClose() {
    var tab = document.getElementById('nodeGraphTab');
    if (!tab || tab._wsLayoutWatched) return;
    tab._wsLayoutWatched = true;
    var obs = new MutationObserver(function() {
      if (!tab.classList.contains('active')) {
        var panel = document.getElementById('wsFloatingPanel');
        if (panel && panel.classList.contains('ws-floating-graph-mode')) {
          detachWorkspaceFromGraph();
        }
      }
    });
    obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Move panels into right content area ───────────────────
  function populateRightPanels(detail) {
    var rc = document.getElementById('wsRightContent');
    if (!rc) return;
    var attempts = 0;
    var maxAttempts = 20;
    function tryMove() {
      var panels = detail.querySelectorAll('.sub-tab-content-job');
      var extraPanels = detail.querySelectorAll('.ws-right-panel');
      var total = panels.length + extraPanels.length;
      if (total === 0 && attempts < maxAttempts) {
        attempts++;
        setTimeout(tryMove, 150);
        return;
      }
      panels.forEach(function(p) { rc.appendChild(p); });
      extraPanels.forEach(function(p) { rc.appendChild(p); });
      var allPanels = Array.from(rc.children);
      allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
      var activeTab = document.querySelector('.ws-right-tab.active');
      var activeId = activeTab ? activeTab.getAttribute('data-panel') : 'job-wip';
      var target = document.getElementById(activeId);
      if (target) target.style.display = 'block';
      wireTabSwitching();
    }
    tryMove();
  }

  // Make sure a 'job-workspace' content panel exists. It's the canvas
  // backdrop (dotted-grid pattern, node-graph aesthetic) over which the
  // floating workspace panel hovers. Created lazily the first time the
  // Workspace tab is activated.
  function ensureWorkspaceCanvas(rc) {
    var canvas = document.getElementById('job-workspace');
    if (canvas) return canvas;
    canvas = document.createElement('div');
    canvas.id = 'job-workspace';
    canvas.className = 'sub-tab-content-job ws-workspace-canvas';
    canvas.innerHTML = '<div id="wsCanvas" class="ws-canvas-backdrop"></div>';
    rc.appendChild(canvas);
    return canvas;
  }

  function wireTabSwitching() {
    var tabs = document.querySelectorAll('.ws-right-tab');
    var rc = document.getElementById('wsRightContent');
    if (!rc) return;
    tabs.forEach(function(tab) {
      tab.onclick = function() {
        tabs.forEach(function(t) { t.classList.remove('active'); });
        this.classList.add('active');
        var targetId = this.getAttribute('data-panel');
        var jobId = (typeof appState !== 'undefined') ? appState.currentJobId : null;

        // Workspace tab opens the node graph and injects the floating
        // workspace panel into the graph's transformed canvas, so the
        // workspace lives in graph coordinate space (pan/zoom with the
        // graph, drag like a node). Every other tab tears that down.
        if (targetId === 'job-workspace') {
          // Hide right-content panels — graph is full-screen modal
          var allPanels = Array.from(rc.children);
          allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
          if (jobId && typeof window.openNodeGraph === 'function') {
            window.openNodeGraph(jobId);
            // Defer the attach until the graph DOM is ready
            setTimeout(function() {
              watchGraphTabClose();
              attachWorkspaceToGraph();
            }, 50);
          }
          return;
        }

        // Leaving Workspace tab: detach panel, close graph if open
        var graphTab = document.getElementById('nodeGraphTab');
        if (graphTab && graphTab.classList.contains('active')) {
          detachWorkspaceFromGraph();
          graphTab.classList.remove('active');
          if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        }

        var allPanels = Array.from(rc.children);
        allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
        var target = document.getElementById(targetId);
        if (target) target.style.display = 'block';

        if (!jobId) return;
        var renderers = {
          'job-overview': 'renderJobOverview',
          'job-costs': 'renderJobCosts',
          'job-subs': 'renderJobSubs',
          'job-changeorders': 'renderChangeOrders',
          'job-purchaseorders': 'renderPurchaseOrders',
          'job-invoices': 'renderInvoices',
          'job-wip': 'renderWipTab'
        };
        var fn = renderers[targetId];
        if (fn && typeof window[fn] === 'function') window[fn](jobId);
      };
    });
  }

  function moveJobInfoToAccordion(detail, rightContent) {
    if (!rightContent) return;
    // Search document-wide in case the card isn't inside detail
    var jobInfo = document.getElementById('job-info-card');
    if (!jobInfo) return;
    // Don't move if already in an accordion
    if (jobInfo.closest('.ws-job-info-details')) return;

    // Clear the display:none that applyLayout set
    jobInfo.style.display = '';

    // Make it collapsible at the top of the right content
    var wrapper = document.createElement('details');
    wrapper.className = 'ws-job-info-details';
    var summary = document.createElement('summary');
    summary.textContent = 'Job Information';
    summary.className = 'ws-job-info-summary';
    wrapper.appendChild(summary);

    jobInfo.classList.add('ws-accordion-content');
    jobInfo.style.border = 'none';
    jobInfo.style.boxShadow = 'none';
    wrapper.appendChild(jobInfo);

    rightContent.insertBefore(wrapper, rightContent.firstChild);
  }

  // ── Main layout application ───────────────────────────────
  var _applyingLayout = false;

  function wireResizer() {
    var resizer = document.querySelector('.ws-resizer');
    var container = document.querySelector('.ws-two-col');
    var leftCol = document.querySelector('.ws-col-left');
    var rightCol = document.querySelector('.ws-col-right');
    if (!resizer || !container || !leftCol || !rightCol) return;
    var startX, startLeftW, startRightW;
    var minLeft = 300, minRight = 280;
    function onMouseDown(e) {
      e.preventDefault();
      startX = e.clientX;
      startLeftW = leftCol.offsetWidth;
      startRightW = rightCol.offsetWidth;
      document.addEventListener('mousemove', onMouseMove);
      document.addEventListener('mouseup', onMouseUp);
      resizer.classList.add('ws-resizer-active');
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }
    function onMouseMove(e) {
      var dx = e.clientX - startX;
      var newLeft = startLeftW + dx;
      var containerW = container.offsetWidth - resizer.offsetWidth;
      var newRight = containerW - newLeft;
      if (newLeft < minLeft || newRight < minRight) return;
      leftCol.style.flex = '0 0 ' + newLeft + 'px';
      rightCol.style.flex = '1 1 0';
      rightCol.style.width = '';
    }
    function onMouseUp() {
      document.removeEventListener('mousemove', onMouseMove);
      document.removeEventListener('mouseup', onMouseUp);
      resizer.classList.remove('ws-resizer-active');
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
    resizer.addEventListener('mousedown', onMouseDown);
  }

  function applyLayout() {
    var detail = document.getElementById("wip-job-detail-view");
    if (!detail || detail.style.display === "none") return;
    if (_applyingLayout) return;
    _applyingLayout = true;

    // Already applied?
    if (document.getElementById("ws-two-col")) { _applyingLayout = false; return; }

    // Clean stale header elements from prior render
    var staleInfo = document.querySelector(".jh-job-info");
    if (staleInfo) staleInfo.remove();
    var staleRow = document.getElementById("jh-tab-metrics-row");
    if (staleRow) {
      var nav = staleRow.querySelector("nav.tabs");
      var hc = document.querySelector(".header-content");
      if (nav && hc) { hc.appendChild(nav); nav.style.flex = ""; }
      staleRow.remove();
    }
    var staleStrip = document.querySelector(".jh-metrics-strip");
    if (staleStrip) staleStrip.remove();

    // Determine job from app data
    var job = null;
    if (typeof window.appState !== "undefined" && window.appState.currentJob) {
      job = window.appState.currentJob;
    } else {
      var h = detail.querySelector(".job-detail-title, .job-detail-header h2, .job-detail-header h1");
      if (h) {
        var parts = h.textContent.split("\u2014");
        job = { jobNumber: (parts[0]||"").trim(), name: (parts[1]||"").trim(), status: "In Progress" };
      }
      // Try to get status from badge
      var badge = detail.querySelector(".status-badge, .badge, [class*=\"status\"]");
      if (badge && job) job.status = badge.textContent.trim();
    }

    buildHeader(detail, job);

    // Insert two-col layout after the (now hidden) job-detail-header
    var layout = buildLayout(detail);
        // Insert two-col after the job-detail-header
        var anchor = detail.querySelector(".job-detail-header");
        if (anchor && anchor.nextSibling) {
          detail.insertBefore(layout, anchor.nextSibling);
        } else {
          detail.appendChild(layout);
        }
        // Hide old summary grid and original elements
        var summaryGrid = detail.querySelector(".summary-grid");
      ['.action-buttons', '.sub-tabs', '#job-info-card'].forEach(function(sel) { var el = detail.querySelector(sel); if (el) el.style.display = 'none'; });
        if (summaryGrid) summaryGrid.style.display = "none";
        populateRightPanels(detail);
      wireResizer();
    wireTabSwitching();
    moveJobInfoToAccordion(detail, document.getElementById('wsRightContent'));
      layoutApplied = true;
      _applyingLayout = false;
  }

  function tryInitWorkspace() {
    var container = document.getElementById('wsWorkspaceContainer');
    if (!container) return;

    var jobId = (typeof appState !== 'undefined' && appState.currentJobId)
      ? appState.currentJobId : null;
    if (!jobId) return;

    if (jobId !== currentJobId) {
      currentJobId = jobId;
      if (typeof initWorkspace === 'function') {
        initWorkspace('wsWorkspaceContainer', jobId);
      }
    }
  }

  // ── Observer ──────────────────────────────────────────────
  let _observerBusy = false;

  function observe() {
    injectCSS();
    injectWorkspaceCSS();

    var observer = new MutationObserver(function() {
      if (_observerBusy) return;
      _observerBusy = true;

      try {
        var detail = document.getElementById('wip-job-detail-view');
        var detailVisible = detail && detail.style.display !== 'none';

        if (!detailVisible) {
          // Job closed — clean up everything
          if (layoutApplied) {
            cleanup();
            layoutApplied = false;
            currentJobId = null;
          }
          return;
        }

        // Job detail is visible — ensure layout is applied
        if (!layoutApplied) {
          // Remove any stale ws-two-col left from a previous session
          var stale = document.getElementById('ws-two-col');
          if (stale) stale.remove();
          applyLayout();
        }

        tryInitWorkspace();
      } finally {
        _observerBusy = false;
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });
    applyLayout();
    tryInitWorkspace();
  }

  // ── Init ──────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }

})();
