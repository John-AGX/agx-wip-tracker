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
    { id: 'job-wip',          label: 'WIP' },
    { id: 'job-costs',        label: 'Costs' },
    { id: 'job-overview',     label: 'Overview' },
    { id: 'job-changeorders', label: 'CO\'s' },
    { id: 'job-buildings',    label: 'Buildings' },
    { id: 'job-phases',       label: 'Phases' },
    { id: 'job-subs',         label: 'Subs' },
    { id: 'job-labor',        label: 'Labor' },
    { id: 'job-weekly',       label: 'Accruals' }
  ];

  // ── CSS injection ─────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ws-layout-v2-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-layout-v2-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace-layout.css?v=6';
    document.head.appendChild(link);
  }

  function injectWorkspaceCSS() {
    if (document.querySelector('link[href*="workspace.css"]')) return;
    var link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/workspace.css';
    document.head.appendChild(link);
  }

  // ── Cleanup old injections ────────────────────────────────
  function cleanup() {
    // Remove job bar from header
    var jobBar = document.getElementById("jh-job-bar");
    if (jobBar) jobBar.remove();

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

    // Un-hide original job detail header
    var detail = document.getElementById("wip-job-detail-view");
    if (detail) {
      var origHeader = detail.querySelector(".job-detail-header");
      if (origHeader) origHeader.style.display = "";
    }

    // Remove two-col layout
    var twoCol = document.getElementById("ws-two-col");
    if (twoCol) {
      var detail2 = document.getElementById("wip-job-detail-view");
      if (detail2) { while (twoCol.firstChild) detail2.appendChild(twoCol.firstChild); }
      twoCol.remove();
    }
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

    // ---- Job info bar ----
    var jobBar = document.createElement("div");
    jobBar.id = "jh-job-bar";
    jobBar.className = "jh-job-bar";
    var backBtn = document.createElement("button");
    backBtn.className = "jh-back-btn";
    backBtn.textContent = "\u2190 Back to WIP";
    backBtn.addEventListener("click", function() {
      var backLink = detail.querySelector("a[href], button");
      if (backLink) backLink.click();
    });
    jobBar.appendChild(backBtn);

    var jobTitle = document.createElement("span");
    jobTitle.className = "jh-job-title";
    var name = job ? (job.jobNumber || "") + " \u2014 " + (job.name || "") : "Job Detail";
    jobTitle.textContent = name;
    jobBar.appendChild(jobTitle);

    var statusBadge = document.createElement("span");
    statusBadge.className = "jh-status-badge";
    statusBadge.textContent = job && job.status ? job.status : "In Progress";
    jobBar.appendChild(statusBadge);

    if (subtitle) { subtitle.after(jobBar); }
    else if (headerContent) { headerContent.appendChild(jobBar); }

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

  function buildLayout(detail) {
    var container = document.createElement('div');
    container.id = 'ws-two-col';
    container.className = 'ws-two-col';

    // ─── LEFT COLUMN: Workspace ─────
    var leftCol = document.createElement('div');
    leftCol.className = 'ws-col-left';
    leftCol.innerHTML =
      '<div class="ws-left-header">' +
        '<span class="ws-left-title">Workspace</span>' +
        '<span class="ws-left-sub">Formulas \u00b7 Cell\u2192Job Linking</span>' +
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
    container.appendChild(rightCol);

    return container;
  }

  // ── Move panels into right content area ───────────────────
  function populateRightPanels(detail, rightContent) {
    RIGHT_TABS.forEach(function(tab) {
      var panel = detail.querySelector('#' + tab.id);
      if (!panel) return;

      // Remove workspace injection from job-costs if present
      if (tab.id === 'job-costs') {
        var ws = panel.querySelector('#wsJobCostsWorkspace');
        if (ws) ws.remove();
      }

      panel.style.display = 'none';
      panel.classList.remove('sub-tab-content-job');
      panel.classList.add('ws-right-panel');
      rightContent.appendChild(panel);
    });

    // Show first panel
    var firstPanel = rightContent.querySelector('.ws-right-panel');
    if (firstPanel) firstPanel.style.display = 'block';
  }

  // ── Wire tab switching ────────────────────────────────────
  function wireTabSwitching(container) {
    var tabBtns = container.querySelectorAll('.ws-right-tab');
    var rightContent = container.querySelector('#wsRightContent');

    tabBtns.forEach(function(btn) {
      btn.addEventListener('click', function() {
        // Deactivate all
        tabBtns.forEach(function(b) { b.classList.remove('active'); });
        rightContent.querySelectorAll('.ws-right-panel').forEach(function(p) { p.style.display = 'none'; });

        // Activate clicked
        btn.classList.add('active');
        var panelId = btn.dataset.panel;
        var panel = rightContent.querySelector('#' + panelId);
        if (panel) panel.style.display = 'block';
      });
    });
  }

  // ── Also add Job Information as first panel if desired ─────
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
  function applyLayout() {
    var detail = document.getElementById("wip-job-detail-view");
    if (!detail || detail.style.display === "none") return;

    // Already applied?
    if (document.getElementById("ws-two-col")) return;

    // Clean stale elements from prior render
    var staleBar = document.getElementById("jh-job-bar");
    if (staleBar) staleBar.remove();
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
      var h = detail.querySelector(".job-detail-header h2, .job-detail-header h1");
      if (h) {
        var parts = h.textContent.split("\u2014");
        job = { jobNumber: (parts[0]||"").trim(), name: (parts[1]||"").trim(), status: "In Progress" };
      }
      // Try to get status from badge
      var badge = detail.querySelector(".status-badge, .badge");
      if (badge && job) job.status = badge.textContent.trim();
    }

    buildHeader(detail, job);

    // Insert two-col layout after the (now hidden) job-detail-header
    var anchor = detail.querySelector(".job-detail-header");
    buildLayout(detail, anchor);
    populateRightPanels(detail);
    wireTabSwitching();
    moveJobInfoToAccordion();
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
  function observe() {
    injectCSS();

    var observer = new MutationObserver(function() {
      var detail = document.getElementById('wip-job-detail-view');
      if (!detail || detail.style.display === 'none') {
        if (layoutApplied) {
          layoutApplied = false;
          currentJobId = null;
        }
        // Remove metrics strip from site header when job is closed
        var staleStrip = document.querySelector('header .jh-metrics-strip');
        if (staleStrip) staleStrip.remove();
        return;
      }

      if (!document.getElementById('ws-two-col')) {
        layoutApplied = false;
        currentJobId = null;
        // Also remove stale metrics strip so buildHeader re-creates it
        var oldStrip = document.querySelector('.jh-metrics-strip');
        if (oldStrip) oldStrip.remove();
        applyLayout();
      }

      tryInitWorkspace();
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
