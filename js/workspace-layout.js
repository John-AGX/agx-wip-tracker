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

  // ── Tab definitions for right panel ───────────────────────
  const RIGHT_TABS = [
    { id: 'job-overview',     label: 'Overview' },
    { id: 'job-wip',          label: 'WIP' },
    { id: 'job-costs',        label: 'Costs' },
    { id: 'job-changeorders', label: 'CO\'s' },
    { id: 'job-subs',         label: 'Subs' },
    { id: 'job-weekly',       label: 'Accruals' }
  ];

  // ── CSS injection ─────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ws-layout-v2-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-layout-v2-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace-layout.css?v=19';
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

    // Remove any stale metrics strip
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

    var metricsData = [
      { label: "Total Income", value: extractVal(allText, "Total Income") },
      { label: "Est. Costs", value: extractVal(allText, "Total Est. Costs (Revised)") },
      { label: "Actual Costs", value: extractVal(allText, "Actual Costs (from tracker)") },
      { label: "Remaining", value: extractVal(allText, "Remaining Est. Costs") },
      { label: "% Complete", value: extractVal(allText, "% Complete") },
      { label: "Revenue Earned", value: revVal },
      { label: "Invoiced", value: extractVal(allText, "Invoiced to Date") },
      { label: "Unbilled", value: extractVal(allText, "Unbilled (Revenue - Invoiced)") },
      { label: "Backlog", value: extractVal(allText, "Backlog (Income - Revenue)") },
      { label: "Change Orders", value: extractVal(allText, "+ Change Orders") },
      { label: "Gross Profit", value: extractVal(allText, "Revised Gross Profit") },
      { label: "Margin %", value: extractVal(allText, "Revised Margin %") },
      { label: "As-Sold Margin", value: extractVal(allText, "As Sold Margin %") }
    ];

    // ---- Job info bar (own row below header-top) ----
    var name = job ? (job.jobNumber || "") + " \u2014 " + (job.name || "") : "Job Detail";
    if (headerContent) {
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

      // Insert after header-top, before nav.tabs
      var navEl = headerContent.querySelector("nav.tabs");
      if (navEl) headerContent.insertBefore(jobInfo, navEl);
      else headerContent.appendChild(jobInfo);
    }

    // ---- Metrics strip ----
    var strip = document.createElement("div");
    strip.className = "jh-metrics-strip";
    metricsData.forEach(function(m) {
      var card = document.createElement("div");
      card.className = "jh-strip-card";
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

    // ---- Tab + metrics row ----
    if (nav && headerContent) {
      var tabRow = document.createElement("div");
      tabRow.id = "jh-tab-metrics-row";
      tabRow.className = "jh-tab-metrics-row";
      nav.parentNode.insertBefore(tabRow, nav);
      nav.style.flex = "0 0 auto";
      tabRow.appendChild(nav);
      tabRow.appendChild(strip);
    }

    // Hide original job-detail-header in page content
    var origHeader = detail.querySelector(".job-detail-header");
    if (origHeader) origHeader.style.display = "none";
  }

  /** Refresh the sticky header metrics strip with current WIP data */
  function refreshHeaderMetrics() {
    var strip = document.querySelector('.jh-metrics-strip');
    if (!strip || !currentJobId) return;
    if (typeof getJobWIP !== 'function' || typeof formatCurrency !== 'function') return;
    var w = getJobWIP(currentJobId);
    var map = {
      'Total Income': formatCurrency(w.totalIncome),
      'Est. Costs': formatCurrency(w.revisedEstCosts),
      'Actual Costs': formatCurrency(w.actualCosts),
      'Remaining': formatCurrency(w.remainingCosts),
      '% Complete': w.pctComplete.toFixed(1) + '%',
      'Revenue Earned': formatCurrency(w.revenueEarned),
      'Invoiced': formatCurrency(w.invoiced),
      'Unbilled': formatCurrency(w.unbilled),
      'Backlog': formatCurrency(w.backlog),
      'Change Orders': formatCurrency(w.coIncome),
      'Gross Profit': formatCurrency(w.revisedProfit),
      'Margin %': w.revisedMargin.toFixed(1) + '%',
      'As-Sold Margin': w.asSoldMargin.toFixed(1) + '%'
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

  function buildLayout(detail) {
    var container = document.createElement('div');
    container.id = 'ws-two-col';
    container.className = 'ws-two-col';

    // ─── LEFT COLUMN: Workspace ─────
    var leftCol = document.createElement('div');
    leftCol.className = 'ws-col-left';
    leftCol.innerHTML =
      '<div class="ws-left-header">' +
        '<img src="images/logo-color.png" alt="AGX" class="ws-left-logo" />' +
        '<span class="ws-left-sub">Workspace \u00b7 Formulas \u00b7 Cell\u2192Job Linking</span>' +
      '</div>' +
      '<div id="wsWorkspaceContainer" tabindex="0"></div>';

    // ─── RIGHT COLUMN: Metrics + Tabs ─────
    var rightCol = document.createElement('div');
    rightCol.className = 'ws-col-right';

    // Tab buttons (metrics strip now lives in header)
    var tabsHtml = '<div class="ws-right-tabs">';
    RIGHT_TABS.forEach(function(tab, i) {
      tabsHtml += '<button class="ws-right-tab' + (i === 0 ? ' active' : '') + '" data-panel="' + tab.id + '">' + tab.label + '</button>';
    });
    tabsHtml += '</div>';

    // Tab content area
    var contentHtml = '<div class="ws-right-content" id="wsRightContent"></div>';

    rightCol.innerHTML = tabsHtml + contentHtml;

    container.appendChild(leftCol);
    
    var resizer = document.createElement('div');
    resizer.className = 'ws-resizer';
    container.appendChild(resizer);
    container.appendChild(rightCol);

    return container;
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
      allPanels.forEach(function(p) { p.style.display = 'none'; });
      var activeTab = document.querySelector('.ws-right-tab.active');
      var activeId = activeTab ? activeTab.getAttribute('data-panel') : 'job-wip';
      var target = document.getElementById(activeId);
      if (target) target.style.display = 'block';
      wireTabSwitching();
    }
    tryMove();
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
        var allPanels = Array.from(rc.children);
        allPanels.forEach(function(p) { p.style.display = 'none'; });
        var target = document.getElementById(targetId);
        if (target) target.style.display = 'block';
        // Call render function for the tab content
        var jobId = (typeof appState !== 'undefined') ? appState.currentJobId : null;
        if (!jobId) return;
        var renderers = {
          'job-overview': 'renderJobOverview',
          'job-costs': 'renderJobCosts',
          'job-subs': 'renderJobSubs',
          'job-weekly': 'renderJobWeekly',
          'job-changeorders': 'renderChangeOrders',
          'job-wip': 'renderWipTab'
        };
        var fn = renderers[targetId];
        if (fn && typeof window[fn] === 'function') window[fn](jobId);
      };
    });
  }

  function moveJobInfoToAccordion(detail, rightContent) {
    var jobInfo = detail.querySelector('#job-info-card');
    if (!jobInfo) return;

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
