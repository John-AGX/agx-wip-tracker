// ============================================================
// Project 86 — Workspace Layout Restructure v2 (Step 2)
// Two-column layout:
//   LEFT:  Workspace grid (portrait, always visible)
//   RIGHT: Compact metrics strip + horizontal tab navigation
// Job name + key costs in the main header bar
// Replaces workspace-inject.js — load AFTER app.js + jobs.js + workspace.js
// ============================================================

(function () {
  'use strict';

  let layoutApplied = false;
  let currentJobId = null;
  let _ngComputing = false;

  // ── Tab definitions ──────────────────────────────────────
  // Overview is the landing tab (first). Workspace is no longer one of
  // the tabs — it lives as a prominent action button in the tabs-actions
  // slot to the right of the strip (see buildLayout). Each tab carries
  // a Phosphor icon via `icon` so the strip is icon-led; the auto-
  // decorator prepends the SVG via data-p86-icon.
  // Costs tab retired — the five cost-category boxes were duplicated by
  // the node graph (set_node_value writes mat/labor/gc/sub/burden) and
  // the hours/rate trio is now derived from QuickBooks costs through
  // the hourly-burden node, not entered here. Detailed + WIP + the
  // graph itself cover everything that tab used to display.
  // NOTE for future audits: the `job-qb-costs` tab below (label
  // "Detailed") is a SEPARATE QuickBooks cost-line viewer, NOT a
  // re-introduction of the retired Costs tab. They share "cost" in
  // the name but have nothing to do with each other.
  const RIGHT_TABS = [
    { id: 'job-overview',      label: 'Overview',  icon: 'insights' },
    { id: 'job-wip-report',    label: 'WIP Report', icon: 'wip' },
    { id: 'job-qb-costs',      label: 'Detailed',  icon: 'daily-logs' },
    { id: 'job-changeorders',  label: 'CO\'s',     icon: 'links' },
    { id: 'job-purchaseorders',label: 'PO\'s',     icon: 'materials' },
    { id: 'job-invoices',      label: 'Invoices',  icon: 'exports' },
    { id: 'job-subs',          label: 'Subs',      icon: 'subs' },
    { id: 'job-reports',       label: 'Reports',   icon: 'photos' }
  ];

  // Workspace toggle state. Tracked at module scope so the toggle can
  // remember which tab was active before workspace mode opened, and
  // restore that tab when the user clicks the Workspace button again
  // to back out.
  var _savedActiveTabId = null;
  var _inWorkspaceMode = false;

  // ── Contextual sidebar state ──────────────────────────────
  // While a job is open, the job's RIGHT_TABS strip is relocated out of
  // the page body and into the left sidebar (#app-sidebar), the main nav
  // (.app-nav) is hidden, and a Back-to-Jobs control + job identity block
  // sit above the tabs. On mobile (<=768px) the sidebar is display:none,
  // so the tabs stay in the page where the single-column layout shows
  // them. A matchMedia listener keeps the tabs on the right side of the
  // breakpoint as the viewport resizes.
  var _jobSubnavMql = null;
  var _jobSubnavMqlHandler = null;

  // ── CSS injection ─────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ws-layout-v2-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-layout-v2-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace-layout.css?v=60';
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

  // Rescue relocated sub-tab panels + job-info-card out of a two-column
  // wrapper and back into the job detail view BEFORE that wrapper is
  // destroyed. populateRightPanels() moves every .sub-tab-content-job and
  // #job-info-card into #wsRightContent (inside #ws-two-col); if the
  // wrapper is removed with the panes still inside, every subtab body
  // (incl. #job-workflow-content) vanishes and the job detail renders
  // blank. Both teardown paths — cleanup() and the observer's
  // stale-ws-two-col removal — call this so panes are never lost.
  function rescuePanels(twoCol, detail) {
    if (!twoCol || !detail) return;
    twoCol.querySelectorAll('.sub-tab-content-job').forEach(function(p) {
      p.style.display = '';
      detail.appendChild(p);
    });
    var jobInfoCard = twoCol.querySelector('#job-info-card');
    if (jobInfoCard) {
      jobInfoCard.style.display = '';
      jobInfoCard.style.border = '';
      jobInfoCard.style.boxShadow = '';
      jobInfoCard.classList.remove('ws-accordion-content');
      detail.appendChild(jobInfoCard);
    }
    var accordion = twoCol.querySelector('.ws-job-info-details');
    if (accordion) accordion.remove();
  }

  // ── Cleanup old injections ────────────────────────────────
  function cleanup() {
    // Restore the main sidebar nav and tear down the job-context subnav
    // before anything else removes the relocated tabs strip.
    unmountJobSubnav();

    // Remove job info bar
    var jobInfo = document.querySelector(".jh-job-info");
    if (jobInfo) jobInfo.remove();

    // Remove any stale jh-tab-metrics-row wrapper and restore nav
    // back into header-content. New layout doesn't create the
    // wrapper but tolerate one in case a previous render is still
    // in the DOM after a redeploy / cache miss. Re-anchor nav
    // BEFORE the user-menu to preserve the brand → tabs → user
    // order in the slim single-row layout.
    var tabRow = document.getElementById("jh-tab-metrics-row");
    if (tabRow) {
      var nav = tabRow.querySelector("nav.tabs");
      var headerContent = document.querySelector(".header-content");
      var userMenu = document.querySelector("#user-menu");
      if (nav && headerContent) {
        if (userMenu) headerContent.insertBefore(nav, userMenu);
        else headerContent.appendChild(nav);
        nav.style.flex = "";
      }
      tabRow.remove();
    }

    // Remove any stale metrics strip (now lives detached at the top of the
    // detail view, not inside the header)
    var strip = document.querySelector(".jh-metrics-strip");
    if (strip) strip.remove();

    // Un-hide original job detail header and elements
    var detail = document.getElementById("jobs-job-detail-view");
    if (detail) {
      var origHeader = detail.querySelector(".job-detail-header");
      if (origHeader) origHeader.style.display = "";
    }
    ['.action-buttons', '.sub-tabs', '#job-info-card', '.job-totals-strip'].forEach(function(sel) { var el = document.querySelector(sel); if (el) el.style.display = ''; });

    // Remove any orphaned floating workspace panels — when the panel
    // was moved to .ng-canvas (graph mode) and the user navigated away
    // before detach ran, removing ws-two-col below leaves the panel
    // alive inside the graph canvas. Next applyLayout would then build
    // a SECOND panel with the same id, and both would render side by
    // side. Wipe every #wsFloatingPanel before the rebuild.
    document.querySelectorAll('#wsFloatingPanel').forEach(function(p) {
      p.remove();
    });
    // Same for any minimized icon clones that may have been promoted
    // out of the panel.
    var staleMinIcons = document.querySelectorAll('#wsMinimizedIcon');
    if (staleMinIcons.length > 1) {
      // Keep only the first; remove the rest
      Array.prototype.slice.call(staleMinIcons, 1).forEach(function(el) { el.remove(); });
    }
    // Reset the in-memory init flag so the next attachWorkspaceToGraph
    // re-wires drag/resize/buttons against the fresh panel instance.
    if (typeof _floatingState !== 'undefined') {
      _floatingState.inited = false;
      _floatingState.maximized = false;
      _floatingState.savedRect = null;
    }

    // Move sub-tab content panels back to detail before destroying two-col
    var twoCol = document.getElementById("ws-two-col");
    rescuePanels(twoCol, detail);
    if (twoCol) twoCol.remove();
  }

  function buildHeader(detail, job) {
    var siteHeader = document.querySelector("header");
    if (!siteHeader || document.querySelector(".jh-metrics-strip")) return;
    var headerContent = siteHeader.querySelector(".header-content");
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

    // Simplified 7-card set — mirrors the job-overview financial chips
    // (Total Income, Actual Costs, Accrued, % Complete, Revenue Earned,
    // Gross Profit, Margin %). The older 12-metric strip (Contract / Est
    // Costs / Remaining / Invoiced / COs / Backlog) was retired in favor
    // of this leaner row; the detailed numbers still live on the WIP
    // Report + Detailed tabs. A `sub` field renders a small caption line
    // under the value (e.g. the contract+CO income breakdown). Initial
    // values are placeholders — refreshHeaderMetrics() repaints real
    // numbers from getJobWIP() as soon as renderJobDetail runs.
    var metricsData = [
      { label: "Total Income", value: extractVal(allText, "Total Income"), sub: true },
      { label: "Actual Costs", value: extractVal(allText, "Actual Costs (from tracker)") },
      { label: "Accrued Costs", value: "--", sub: true },
      { label: "% Complete", value: extractVal(allText, "% Complete") },
      { label: "Revenue Earned", value: revVal },
      { label: "Gross Profit", value: extractVal(allText, "Revised Gross Profit") },
      { label: "Margin %", value: extractVal(allText, "Revised Margin %") }
    ];

    // ---- Job info inserted into the slim header, between the tabs
    // and the user menu. The legacy `.header-right` column (a stacked
    // right side of a two-row header) was removed when the header
    // collapsed to one line, so we anchor on `#user-menu` instead.
    var name = job ? (job.jobNumber || "") + " \u2014 " + (job.name || "") : "Job Detail";
    var userMenu = siteHeader.querySelector("#user-menu");
    if (headerContent && userMenu) {
      var jobInfo = document.createElement("div");
      jobInfo.className = "jh-job-info";

      var backBtn = document.createElement("button");
      backBtn.className = "jh-back-btn";
      backBtn.textContent = "\u2190 Back to Jobs";
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

      headerContent.insertBefore(jobInfo, userMenu);
    }

    // Map each metric label to a tone hint so the card can color-code itself.
    // Income-side = blue, cost-side = red, gain-side (revenue/profit/margin)
    // = green, backlog/throughput = amber, neutral counters = gray.
    // Tones chosen to match the job-overview chips exactly: income green,
    // costs/accrued yellow, revenue earned blue, % complete + margin
    // plain. Gross Profit stays neutral here and gets a +/- green/red
    // value color applied inline by refreshHeaderMetrics (mirrors the
    // old in-content card behavior).
    var METRIC_TONE = {
      'Total Income': 'income',
      'Actual Costs': 'cost',
      'Accrued Costs': 'amber',
      '% Complete': 'neutral',
      'Revenue Earned': 'gain',
      'Gross Profit': 'neutral',
      'Margin %': 'neutral'
    };

    // ---- Metrics strip ----
    // The strip now renders the same flat ".p86-totals-chip" cards used by
    // the job-overview financial totals, instead of the old glowing
    // node-graph-style tiles, so the pinned top strip matches the clean
    // chip aesthetic the rest of the job page uses. The semantic tone
    // (income/cost/gain/...) maps onto the chip's color modifier so income
    // reads green, costs read yellow, gains read blue, neutral stays white —
    // mirroring the overview totals' color coding.
    var TONE_TO_CHIP = {
      income: 'accent',   // green — money in
      gain:   'info',     // blue  — revenue earned / profit / margin
      cost:   'warn',     // yellow — money out
      amber:  'warn',     // yellow — accrued
      neutral: ''         // plain white value
    };
    var strip = document.createElement("div");
    strip.className = "jh-metrics-strip";
    metricsData.forEach(function(m) {
      var card = document.createElement("div");
      var tone = METRIC_TONE[m.label] || 'neutral';
      var mod = TONE_TO_CHIP[tone] || '';
      card.className = "p86-totals-chip" + (mod ? " " + mod : "");
      card.setAttribute('data-tone', tone);
      var lbl = document.createElement("div");
      lbl.className = "p86-totals-chip-label";
      lbl.textContent = m.label;
      var val = document.createElement("div");
      val.className = "p86-totals-chip-value";
      val.textContent = m.value;
      card.appendChild(lbl);
      card.appendChild(val);
      // Optional caption line under the value (income breakdown / accrued
      // note). refreshHeaderMetrics fills it by matching the chip label.
      if (m.sub) {
        var subEl = document.createElement("div");
        subEl.className = "job-totals-chip-sub";
        subEl.textContent = "";
        card.appendChild(subEl);
      }
      strip.appendChild(card);
    });

    // (Old layout used to wrap nav in a `#jh-tab-metrics-row` div for
    // a side-by-side tabs+strip layout. The strip moved out of the
    // header months ago, and the new slim header puts nav inline
    // with the logo + user menu, so the wrapper is no longer needed.
    // cleanup() still tolerates an old wrapper in case a stale row
    // is in the DOM from an interrupted render.)

    // ---- Metrics strip ----
    // Inserted as a sibling of <main> inside .container so it sits
    // directly between the header and the scrollable main area.
    // Putting it INSIDE main (the previous setup) meant the strip
    // had to fight main's 30px padding via negative margins, which
    // never quite went flush against the header. As a sibling of
    // main it's a regular block element in the column flex —
    // header → strip → main — and naturally hugs the header's
    // bottom edge with no margin tricks.
    strip.id = "jh-strip-detached";
    // Insert the strip as main's previous sibling inside whatever column
    // wraps it: .app-content-col when the left sidebar shell is present,
    // or #app-container directly on the legacy (sidebar-less) layout.
    // Either way the strip sits between the header and the scrollable
    // main area and hugs the header's bottom edge with no margin tricks.
    var mainEl = document.querySelector('#app-container main');
    if (mainEl && mainEl.parentNode) {
      mainEl.parentNode.insertBefore(strip, mainEl);
    } else {
      // Fallback to the legacy in-detail placement if the new
      // siblings can't be located (e.g., page structure changed).
      detail.insertBefore(strip, detail.firstChild);
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
    // Ensure node graph values are current before reading them.
    // Skip if pushToJob itself triggered us (avoid infinite recursion).
    if (!_ngComputing && typeof ensureNGComputed === 'function') {
      _ngComputing = true;
      try { ensureNGComputed(currentJobId); } finally { _ngComputing = false; }
    }
    var w = getJobWIP(currentJobId);
    var accrued = (typeof getJobAccruedCosts === 'function') ? getJobAccruedCosts(currentJobId) : 0;
    // 7-card simplified set — must mirror buildHeader's metricsData labels.
    var map = {
      'Total Income': formatCurrency(w.totalIncome),
      'Actual Costs': formatCurrency(w.actualCosts),
      'Accrued Costs': formatCurrency(accrued),
      '% Complete': w.pctComplete.toFixed(1) + '%',
      'Revenue Earned': formatCurrency(w.revenueEarned),
      // JTD profit (revenueEarned − actualCosts) so the tile matches
      // the GROSS PROFIT watch node in the graph.
      'Gross Profit': formatCurrency(w.jtdProfit),
      'Margin %': w.jtdMargin.toFixed(1) + '%'
    };
    // Sub-line captions keyed by label.
    var subMap = {
      'Total Income': (w.coIncome > 0)
        ? 'Contract: ' + formatCurrency(w.contractIncome) + ' + CO: ' + formatCurrency(w.coIncome)
        : '',
      'Accrued Costs': (accrued > 0) ? 'Earned but unbilled' : ''
    };
    strip.querySelectorAll('.p86-totals-chip').forEach(function (card) {
      var lbl = card.querySelector('.p86-totals-chip-label');
      var val = card.querySelector('.p86-totals-chip-value');
      if (!lbl || !val) return;
      var key = lbl.textContent;
      if (map[key] !== undefined) val.textContent = map[key];
      // Gross Profit takes a +/- tone color.
      if (key === 'Gross Profit') {
        val.style.color = (w.jtdProfit >= 0) ? 'var(--green)' : 'var(--red)';
      }
      // Populate sub-line caption when present.
      if (subMap[key] !== undefined) {
        var sub = card.querySelector('.job-totals-chip-sub');
        if (sub) sub.textContent = subMap[key];
      }
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
  // Exposed so switchTab() can force a teardown when navigating away from Jobs
  // (Insights / Estimates / Admin). Without this the sticky job-metrics
  // header lingers until the polling loop notices the detail view is hidden.
  window.workspaceLayoutCleanup = cleanup;

  // ── Contextual sidebar: swap job subtabs into #app-sidebar ──
  // Below the mobile breakpoint the desktop sidebar is hidden, so the
  // tabs must remain in the page column. Above it, they move into the
  // sidebar. Single source of truth for the breakpoint test.
  function jobSubnavIsMobile() {
    return !!(window.matchMedia && window.matchMedia('(max-width: 768px)').matches);
  }

  // Build (once) the job-context wrapper that holds the Back-to-Jobs
  // control + job identity block. The .ws-right-tabs strip is appended
  // into it by placeJobSubnav(); it is NOT rebuilt here.
  function buildJobSubnavShell(job) {
    var jobnav = document.getElementById('app-jobnav');
    if (!jobnav) {
      jobnav = document.createElement('div');
      jobnav.id = 'app-jobnav';
      jobnav.className = 'app-jobnav';

      var back = document.createElement('button');
      back.type = 'button';
      back.className = 'app-jobnav-back';
      back.title = 'Back to all jobs';
      back.innerHTML =
        '<span class="app-jobnav-back-arrow" aria-hidden="true">←</span>' +
        '<span class="app-nav-label">All Jobs</span>';
      back.addEventListener('click', function () {
        if (typeof backToJobsMain === 'function') backToJobsMain();
        else if (typeof window.backToJobsMain === 'function') window.backToJobsMain();
      });
      jobnav.appendChild(back);

      var info = document.createElement('div');
      info.className = 'app-jobnav-jobinfo';
      info.innerHTML =
        '<div class="app-jobnav-title"></div>' +
        '<div class="app-jobnav-status"></div>';
      jobnav.appendChild(info);

      // Uppercase section header above the relocated tabs strip, mirroring
      // the main nav's .app-nav-group-label so the contextual sidebar reads
      // as a sibling of the primary nav rather than a different widget.
      var sectionLabel = document.createElement('div');
      sectionLabel.className = 'app-jobnav-section-label';
      sectionLabel.textContent = 'Sections';
      jobnav.appendChild(sectionLabel);

      // Attach the freshly-built shell into the sidebar immediately.
      // placeJobSubnav() locates it via getElementById, so a detached
      // element would be invisible to it — the desktop branch would bail
      // at `if (!jobnav) return` and the subtabs would stay stranded in
      // the page column. Insert it in the .app-nav slot (so the job
      // context reads near the top, with Recents and the account footer
      // below it) rather than appending to the very end of the sidebar.
      // placeJobSubnav() then decides whether it is shown for the viewport.
      var sb = document.getElementById('app-sidebar');
      if (sb) {
        var sbNav = sb.querySelector('.app-nav');
        // .app-nav may be nested inside a scroll wrapper rather than being a
        // direct child of #app-sidebar — insert relative to its REAL parent
        // so insertBefore() doesn't throw "reference node is not a child of
        // this node" (which froze the whole job layout).
        if (sbNav && sbNav.parentNode) sbNav.parentNode.insertBefore(jobnav, sbNav);
        else sb.appendChild(jobnav);
      }
    }
    // (Re)populate identity from the current job.
    if (job) {
      var num = job.jobNumber || '';
      var nm = job.title || job.name || '';
      var titleEl = jobnav.querySelector('.app-jobnav-title');
      var statusEl = jobnav.querySelector('.app-jobnav-status');
      if (titleEl) titleEl.textContent = num + (num && nm ? ' — ' : '') + nm;
      if (statusEl) statusEl.textContent = job.status || 'In Progress';
    }
    return jobnav;
  }

  // Put the .ws-right-tabs strip in the correct place for the current
  // viewport: inside the sidebar jobnav (desktop) or back in the page
  // column (mobile / no sidebar). Reparenting preserves the click
  // handlers wireTabSwitching() bound to each tab node.
  function placeJobSubnav() {
    var sidebar = document.getElementById('app-sidebar');
    var appNav = sidebar ? sidebar.querySelector('.app-nav') : null;
    var tabs = document.querySelector('.ws-right-tabs');
    var jobnav = document.getElementById('app-jobnav');
    var home = document.querySelector('#ws-two-col .ws-col-right');
    if (!tabs) return;

    var mobile = jobSubnavIsMobile() || !sidebar;
    if (mobile) {
      // Tabs live in the page column; main nav is restored; jobnav hidden.
      if (home && tabs.parentNode !== home) home.insertBefore(tabs, home.firstChild);
      if (appNav) appNav.style.display = '';
      if (jobnav) jobnav.style.display = 'none';
      return;
    }
    // Desktop: relocate tabs into the sidebar jobnav; hide main nav.
    if (!jobnav) return;
    // Insert jobnav just before .app-nav using .app-nav's ACTUAL parent — it
    // may live inside a scroll wrapper, not directly under #app-sidebar, so
    // sidebar.insertBefore(jobnav, appNav) would throw.
    var navParent = (appNav && appNav.parentNode) ? appNav.parentNode : sidebar;
    if (jobnav.parentNode !== navParent) {
      if (appNav && appNav.parentNode) navParent.insertBefore(jobnav, appNav);
      else navParent.appendChild(jobnav);
    }
    if (tabs.parentNode !== jobnav) jobnav.appendChild(tabs);
    jobnav.style.display = '';
    if (appNav) appNav.style.display = 'none';
  }

  function mountJobSubnav(job) {
    buildJobSubnavShell(job);
    placeJobSubnav();
    // Follow the tabs across the breakpoint as the viewport resizes.
    if (window.matchMedia && !_jobSubnavMql) {
      _jobSubnavMql = window.matchMedia('(max-width: 768px)');
      _jobSubnavMqlHandler = function () { placeJobSubnav(); };
      if (_jobSubnavMql.addEventListener) _jobSubnavMql.addEventListener('change', _jobSubnavMqlHandler);
      else if (_jobSubnavMql.addListener) _jobSubnavMql.addListener(_jobSubnavMqlHandler);
    }
  }

  function unmountJobSubnav() {
    if (_jobSubnavMql && _jobSubnavMqlHandler) {
      if (_jobSubnavMql.removeEventListener) _jobSubnavMql.removeEventListener('change', _jobSubnavMqlHandler);
      else if (_jobSubnavMql.removeListener) _jobSubnavMql.removeListener(_jobSubnavMqlHandler);
    }
    _jobSubnavMql = null;
    _jobSubnavMqlHandler = null;
    // Restore the main nav, then drop the job subnav wrapper. The
    // .ws-right-tabs node inside it (if relocated) dies with the wrapper;
    // it is rebuilt by buildLayout on the next applyLayout.
    var sidebar = document.getElementById('app-sidebar');
    var appNav = sidebar ? sidebar.querySelector('.app-nav') : null;
    if (appNav) appNav.style.display = '';
    var jobnav = document.getElementById('app-jobnav');
    if (jobnav) jobnav.remove();
  }

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
      tabsHtml += '<button class="ws-right-tab' + (i === 0 ? ' active' : '') + '" data-panel="' + tab.id + '"' + (tab.icon ? ' data-p86-icon="' + tab.icon + '"' : '') + '>' + tab.label + '</button>';
    });
    // Workspace is a prominent icon-only action button (not a tab).
    // Clicking it toggles the node-graph canvas + floating workspace
    // panel; clicking it again restores whichever tab was active before.
    // Global Ask 86 badge embeds right next to it via the slot mount.
    tabsHtml += '<div class="ws-right-tabs-actions">' +
      '<span class="p86-ask86-mount"></span>' +
      '<button class="ws-workspace-toggle" id="wsWorkspaceToggle" type="button" data-p86-icon="graph" title="Open the node-graph workspace — click again to return to this tab" aria-label="Workspace"></button>' +
    '</div>';
    tabsHtml += '</div>';

    var contentHtml = '<div class="ws-right-content" id="wsRightContent"></div>';
    mainCol.innerHTML = tabsHtml + contentHtml;
    container.appendChild(mainCol);

    // Belt-and-suspenders: even with cleanup() evicting orphans, a
    // prior panel sitting in .ng-canvas (graph mode left over from a
    // previous job) would clash with the one we're about to create.
    // Same id == drag handlers wired to the WRONG element. Remove any
    // straggler before constructing the new panel.
    document.querySelectorAll('#wsFloatingPanel').forEach(function(p) {
      p.remove();
    });
    if (typeof _floatingState !== 'undefined') {
      _floatingState.inited = false;
      _floatingState.maximized = false;
      _floatingState.savedRect = null;
    }
    var fp = document.createElement('div');
    fp.id = 'wsFloatingPanel';
    fp.className = 'ws-floating-panel';
    fp.style.display = 'none';
    // Header: AGX logo + title. The min/max/focus controls were
    // promoted to the graph topbar (Focus / Fullscreen / Minimize) so
    // they can act as graph-wide commands. The header stays clean —
    // just identifies the panel and gives the user a drag handle.
    fp.innerHTML =
      '<div class="ws-floating-header" id="wsFloatingHeader">' +
        '<span class="ws-floating-titlewrap">' +
          '<img src="images/project-86-icon.svg" alt="Project 86" class="ws-floating-logo ws-logo-color" />' +
          '<img src="images/project-86-icon.svg" alt="Project 86" class="ws-floating-logo ws-logo-white" />' +
          '<span class="ws-floating-title">Workspace</span>' +
        '</span>' +
        '<div class="ws-floating-actions">' +
          // Quick Access Toolbar — Import / Clear / Save promoted out
          // of the ribbon's File group so the ribbon's right edge
          // stays clear. Size matches the Minimize button. The
          // file-input that backs Import is a hidden sibling so
          // wsImportXlsxBtn's click can still trigger it.
          '<button class="ws-floating-btn" id="wsImportXlsxBtnHeader" title="Import .xlsx as new sheets">&#x1F4E5;</button>' +
          '<input type="file" id="wsImportXlsxInputHeader" accept=".xlsx,.xls,.csv" style="display:none;" />' +
          '<button class="ws-floating-btn" id="wsClearBtnHeader" title="Clear workspace">&#x1F5D1;</button>' +
          '<button class="ws-floating-btn" id="wsSaveBtnHeader" title="Save workspace (Ctrl+S)">&#x1F4BE;</button>' +
          '<button class="ws-floating-btn" id="wsFloatingMinBtn" title="Minimize to folder icon">&#x2013;</button>' +
        '</div>' +
      '</div>' +
      '<div class="ws-floating-body">' +
        '<div id="wsWorkspaceContainer" tabindex="0"></div>' +
        '<svg class="ws-floating-mini-graphic" viewBox="0 0 120 90" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
          // outer frame
          '<rect x="1" y="1" width="118" height="88" rx="5" ry="5" fill="#1a1d27" stroke="#3a4058" stroke-width="1.5"/>' +
          // top-left corner cell + column header strip
          '<rect x="1" y="1" width="14" height="14" fill="#2d3348"/>' +
          '<rect x="15" y="1" width="103" height="14" fill="#2d3348"/>' +
          // row-number strip
          '<rect x="1" y="15" width="14" height="73" fill="#242836"/>' +
          // column dividers
          '<line x1="40" y1="1" x2="40" y2="89" stroke="#3a4058" stroke-width="0.5"/>' +
          '<line x1="65" y1="1" x2="65" y2="89" stroke="#3a4058" stroke-width="0.5"/>' +
          '<line x1="90" y1="1" x2="90" y2="89" stroke="#3a4058" stroke-width="0.5"/>' +
          // row dividers
          '<line x1="1" y1="33" x2="119" y2="33" stroke="#3a4058" stroke-width="0.5"/>' +
          '<line x1="1" y1="51" x2="119" y2="51" stroke="#3a4058" stroke-width="0.5"/>' +
          '<line x1="1" y1="69" x2="119" y2="69" stroke="#3a4058" stroke-width="0.5"/>' +
          // column header dashes (mock A/B/C/D labels)
          '<rect x="22" y="6" width="10" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="48" y="6" width="10" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="73" y="6" width="10" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="98" y="6" width="10" height="3" fill="#8b90a5" rx="1"/>' +
          // row number dashes (mock 1/2/3/4)
          '<rect x="5" y="22" width="6" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="5" y="40" width="6" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="5" y="58" width="6" height="3" fill="#8b90a5" rx="1"/>' +
          '<rect x="5" y="76" width="6" height="3" fill="#8b90a5" rx="1"/>' +
          // colored data cells diagonally — suggests entered data
          '<rect x="18" y="20" width="20" height="9" fill="#4f8cff" opacity="0.75" rx="1"/>' +
          '<rect x="43" y="38" width="20" height="9" fill="#34d399" opacity="0.75" rx="1"/>' +
          '<rect x="68" y="56" width="20" height="9" fill="#fbbf24" opacity="0.75" rx="1"/>' +
          '<rect x="93" y="74" width="20" height="9" fill="#a78bfa" opacity="0.75" rx="1"/>' +
        '</svg>' +
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
    // While minimized, the whole panel is a drag handle (the header
    // shrinks and the body is just an emoji). Otherwise drag is from
    // the header only.
    function dragMouseDown(e) {
      if (e.target.closest('.ws-floating-btn')) return;
      // If minimized but click is on the actions area, ignore.
      var rect = panel.getBoundingClientRect();
      dragging = {
        startMouseX: e.clientX,
        startMouseY: e.clientY,
        startLeft: parseInt(panel.style.left, 10) || 0,
        startTop: parseInt(panel.style.top, 10) || 0,
        zoom: currentZoom(),
        moved: false
      };
      document.body.style.userSelect = 'none';
      e.preventDefault();
      e.stopPropagation();
    }
    header.addEventListener('mousedown', dragMouseDown);
    // The folder-state body should also act as a drag handle so the
    // node can be repositioned without an explicit header grab.
    panel.addEventListener('mousedown', function(e) {
      if (!panel.classList.contains('ws-floating-folder')) return;
      // Header already wired above; don't double-bind.
      if (e.target.closest('.ws-floating-header')) return;
      dragMouseDown(e);
    });
    document.addEventListener('mousemove', function(e) {
      if (!dragging) return;
      var dx = (e.clientX - dragging.startMouseX) / dragging.zoom;
      var dy = (e.clientY - dragging.startMouseY) / dragging.zoom;
      if (Math.abs(dx) + Math.abs(dy) > 3) dragging.moved = true;
      panel.style.left = (dragging.startLeft + dx) + 'px';
      panel.style.top = (dragging.startTop + dy) + 'px';
    });
    document.addEventListener('mouseup', function() {
      if (dragging) {
        var isFolder = panel.classList.contains('ws-floating-folder');
        // Only persist dataset.graphX/Y for the EXPANDED panel — that
        // value is what attachWorkspaceToGraph reads on re-attach.
        // The minimized icon has its own saved position.
        if (inGraphMode() && !isFolder) {
          var nx = parseInt(panel.style.left, 10) || 0;
          var ny = parseInt(panel.style.top, 10) || 0;
          panel.dataset.graphX = nx;
          panel.dataset.graphY = ny;
          // Persist immediately so a tab/window close doesn't lose
          // the position.
          saveWorkspaceState({ x: nx, y: ny });
        }
        if (isFolder) {
          try {
            localStorage.setItem('p86-ws-min-pos', JSON.stringify({
              x: parseInt(panel.style.left, 10) || 0,
              y: parseInt(panel.style.top, 10) || 0
            }));
          } catch (e) {}
        }
        if (dragging.moved) _floatingState.suppressRestoreClick = true;
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
          var nw = parseInt(panel.style.width, 10) || 0;
          var nh = parseInt(panel.style.height, 10) || 0;
          panel.dataset.graphW = nw;
          panel.dataset.graphH = nh;
          saveWorkspaceState({ w: nw, h: nh });
        }
        resizing = null;
        document.body.style.userSelect = '';
      }
    });

    // ── Event isolation ──
    // Wheel events on the panel must NOT bubble to the graph (which
    // would zoom the whole canvas). Mousedowns inside the panel body
    // must NOT bubble either — otherwise the graph treats them as
    // pan/select. Header gets its own mousedown (drag) handler with
    // its own stopPropagation, so we only block here for non-header.
    panel.addEventListener('wheel', function(e) { e.stopPropagation(); }, { capture: false });
    panel.addEventListener('mousedown', function(e) {
      // Don't swallow header drag — its handler runs first via direct
      // listener and already calls stopPropagation. Same for resize.
      if (e.target.closest('.ws-floating-header, .ws-floating-resize')) return;
      e.stopPropagation();
    });

    if (minBtn) minBtn.addEventListener('click', function(e) {
      e.stopPropagation();
      minimizeWorkspace();
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

  // Per-job persistence of the workspace's graph-mode rect + folder
  // (minimized) flag. dataset.* lives only on the DOM and disappears
  // on full reload; localStorage survives.
  function workspaceStateKey() {
    var jid = (window.appState && appState.currentJobId) || null;
    return jid ? 'p86-ws-graphstate:' + jid : null;
  }
  function loadWorkspaceState() {
    var key = workspaceStateKey();
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  }
  function saveWorkspaceState(patch) {
    var key = workspaceStateKey();
    if (!key) return;
    try {
      var cur = loadWorkspaceState() || {};
      Object.keys(patch).forEach(function(k) { cur[k] = patch[k]; });
      localStorage.setItem(key, JSON.stringify(cur));
    } catch (e) {}
  }

  function attachWorkspaceToGraph() {
    var panel = document.getElementById('wsFloatingPanel');
    var canvas = document.querySelector('#nodeGraphTab .ng-canvas');
    if (!panel || !canvas) return;
    initFloatingPanel(); // safe to call repeatedly
    // Wipe ALL mode classes before reapplying — otherwise leftover
    // ws-floating-folder (header hidden → drag handle gone) or
    // ws-floating-maximized (resize disabled) from a previous job
    // or session leaves the panel in a stuck state where the user
    // can't drag it.
    panel.classList.remove(
      'ws-floating-tab-mode',
      'ws-floating-folder',
      'ws-floating-maximized'
    );
    // Reset any in-memory state the prior job might have left.
    _floatingState.maximized = false;
    panel.classList.add('ws-floating-graph-mode');
    // Prefer localStorage (survives reloads), then dataset (survives
    // sub-tab switches within a session), then defaults.
    var saved = loadWorkspaceState() || {};
    var x = saved.x != null
      ? saved.x
      : (panel.dataset.graphX != null ? parseFloat(panel.dataset.graphX) : 100);
    var y = saved.y != null
      ? saved.y
      : (panel.dataset.graphY != null ? parseFloat(panel.dataset.graphY) : 100);
    var w = saved.w != null
      ? saved.w
      : (panel.dataset.graphW != null ? parseFloat(panel.dataset.graphW) : 720);
    var h = saved.h != null
      ? saved.h
      : (panel.dataset.graphH != null ? parseFloat(panel.dataset.graphH) : 480);
    panel.style.position = 'absolute';
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    canvas.appendChild(panel);
    panel.style.display = 'flex';
    // Mirror dataset for in-session sub-tab switching.
    panel.dataset.graphX = x;
    panel.dataset.graphY = y;
    panel.dataset.graphW = w;
    panel.dataset.graphH = h;
    wireGraphToolbarWorkspaceButtons();
    // If the user had it minimized last time, re-minimize on attach.
    if (saved.minimized) {
      // Defer so the layout settles before adding the folder class.
      setTimeout(function() { minimizeWorkspace(); }, 0);
    }
  }
  function detachWorkspaceFromGraph() {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel) return;
    if (panel.classList.contains('ws-floating-graph-mode')) {
      var x = parseInt(panel.style.left, 10) || 100;
      var y = parseInt(panel.style.top, 10) || 100;
      var w = parseInt(panel.style.width, 10) || 720;
      var h = parseInt(panel.style.height, 10) || 480;
      panel.dataset.graphX = x;
      panel.dataset.graphY = y;
      panel.dataset.graphW = w;
      panel.dataset.graphH = h;
      // Persist to localStorage too, so a full reload restores
      // the user's last position. Don't clobber the minimized
      // flag here — that's tracked separately.
      saveWorkspaceState({ x: x, y: y, w: w, h: h });
    }
    var twoCol = document.getElementById('ws-two-col');
    if (twoCol) twoCol.appendChild(panel);
    panel.classList.remove('ws-floating-graph-mode', 'ws-floating-folder', 'ws-floating-maximized');
    panel.classList.add('ws-floating-tab-mode');
    panel.style.position = '';
    panel.style.display = 'none';
    _floatingState.maximized = false;
  }

  // Watch the node graph tab for class changes — when it loses .active
  // (close/back button clicked), detach the workspace panel, restore
  // the AGX nav header if it was hidden, and switch back to whichever
  // sub-tab the user was on before they opened the workspace.
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
        // Bring the header back so other tabs aren't missing it.
        if (document.body.classList.contains('ng-graph-fullscreen')) {
          document.body.classList.remove('ng-graph-fullscreen');
          var maxBtn = document.getElementById('ngFullscreenGraphBtn');
          if (maxBtn) {
            maxBtn.innerHTML = '\u{1F5D6} Maximize';
            maxBtn.title = 'Hide the AGX nav header to give the graph the entire viewport (toggle)';
          }
        }
        // Restore the sub-tab the user was on before opening workspace.
        // The graph's own close/back button is the trigger; we hook it
        // via this MutationObserver so any path that clears .active
        // (button click, programmatic close, etc.) lands in the right
        // place. _inWorkspaceMode gates the restore so unrelated graph
        // tab toggles elsewhere don't reshuffle sub-tabs.
        if (_inWorkspaceMode) {
          var restoreId = _savedActiveTabId || 'job-overview';
          _savedActiveTabId = null;
          // activateTab also flips _inWorkspaceMode back to false and
          // syncs the button's .active class (defensive — even though
          // the open button no longer toggles itself, any future
          // .active drift gets cleared).
          activateTabFromOutside(restoreId);
        }
      }
    });
    obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  // Re-entry helper used by watchGraphTabClose. wireTabSwitching
  // closes over the per-job tab list and exposes activateTab only
  // inside that scope, so we re-resolve the active tab + renderer here
  // and call them directly. Keeps the public surface narrow.
  function activateTabFromOutside(targetId) {
    _inWorkspaceMode = false;
    var rc = document.getElementById('wsRightContent');
    if (!rc) return;
    var tabs = document.querySelectorAll('.ws-right-tab[data-panel]');
    tabs.forEach(function(t) {
      t.classList.toggle('active', t.getAttribute('data-panel') === targetId);
    });
    var allPanels = Array.from(rc.children);
    allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
    var target = document.getElementById(targetId);
    if (target) target.style.display = 'block';
    var jobId = (typeof appState !== 'undefined') ? appState.currentJobId : null;
    if (!jobId) return;
    var renderers = {
      'job-overview': 'renderJobOverview',
      'job-qb-costs': 'renderJobQBCosts',
      'job-subs': 'renderJobSubs',
      'job-changeorders': 'renderChangeOrders',
      'job-purchaseorders': 'renderPurchaseOrders',
      'job-invoices': 'renderInvoices',
      'job-wip-report': 'renderWipTab',
      'job-reports': 'renderJobReports'
    };
    safeRenderTabContent(targetId, target, jobId, renderers[targetId]);
  }

  // Shared helper for both tab-activation paths in this module. Replaces
  // the pre-fix pattern `if (fn && typeof window[fn] === 'function')
  // window[fn](jobId);` which silently no-op'd in two failure modes:
  //   1. Module not loaded → window[fn] is undefined → click does
  //      nothing, panel shows stale/empty content, no error visible.
  //   2. Renderer throws mid-execution → exception bubbles to the
  //      console (maybe) but the user sees a blank panel + no clue.
  // Audit findings W3 + W7c (memoized-inventing-mountain.md).
  function safeRenderTabContent(targetId, target, jobId, fn) {
    if (!fn) return;
    if (typeof window[fn] !== 'function') {
      try {
        console.warn('[workspace-layout] missing renderer:', fn, 'for tab', targetId);
      } catch (_) {}
      if (target) {
        target.innerHTML =
          '<div style="padding:24px;color:var(--text-dim,#888);font-size:13px;">' +
          '<strong>This view didn\'t load.</strong><br>' +
          'The component for this tab (<code>' + escapeAttrText(fn) + '</code>) wasn\'t found. ' +
          'Try refreshing the page.' +
          '</div>';
      }
      return;
    }
    try {
      window[fn](jobId);
    } catch (e) {
      try {
        console.error('[workspace-layout] renderer threw:', fn, e);
      } catch (_) {}
      if (target) {
        target.innerHTML =
          '<div style="padding:24px;color:#f87171;font-size:13px;">' +
          '<strong>This view crashed while loading.</strong><br>' +
          'Tab: <code>' + escapeAttrText(targetId) + '</code> · Renderer: <code>' + escapeAttrText(fn) + '</code><br>' +
          '<span style="opacity:0.75;">' + escapeAttrText(e && e.message || String(e)) + '</span>' +
          '</div>';
      }
    }
  }
  // Tiny HTML-attr escape for the safeRenderTabContent error blocks.
  // We can't import a shared helper from here without restructuring;
  // the inputs are short internal strings.
  function escapeAttrText(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── Workspace state controls (driven by graph toolbar buttons) ──

  // Fullscreen toggle — fills the visible canvas at zoom 1.0 so
  // content reads at "real" size regardless of where the user was
  // zoomed before. Restore returns the panel rect *and* the pan/zoom
  // back to whatever they were on the way in. Self-contained so the
  // result doesn't depend on whether Focus was clicked first.
  function toggleFullscreenWorkspace() {
    var panel = document.getElementById('wsFloatingPanel');
    var area = document.querySelector('#nodeGraphTab .ng-canvas-area');
    if (!panel || !area || !panel.classList.contains('ws-floating-graph-mode')) return;
    if (_floatingState.maximized) {
      // Restore previous panel rect + pan/zoom
      if (_floatingState.savedRect) {
        panel.style.left = _floatingState.savedRect.left + 'px';
        panel.style.top = _floatingState.savedRect.top + 'px';
        panel.style.width = _floatingState.savedRect.width + 'px';
        panel.style.height = _floatingState.savedRect.height + 'px';
        panel.dataset.graphX = _floatingState.savedRect.left;
        panel.dataset.graphY = _floatingState.savedRect.top;
        panel.dataset.graphW = _floatingState.savedRect.width;
        panel.dataset.graphH = _floatingState.savedRect.height;
      }
      if (_floatingState.savedView && typeof NG !== 'undefined' && NG.zm && NG.pan) {
        NG.zm(_floatingState.savedView.zoom);
        NG.pan(_floatingState.savedView.panX, _floatingState.savedView.panY);
        if (typeof window.ngApplyTx === 'function') window.ngApplyTx();
        if (typeof window.ngRender === 'function') window.ngRender();
      }
      _floatingState.maximized = false;
      panel.classList.remove('ws-floating-maximized');
      // If the user was minimized when they hit Fullscreen, return
      // to that state on toggle off — not the un-minimized baseline.
      if (_floatingState.preFullscreenMinimized) {
        _floatingState.preFullscreenMinimized = false;
        // Re-minimize after the rect has settled.
        setTimeout(function() { minimizeWorkspace(); }, 0);
      }
    } else {
      // Track whether the user was minimized so toggle-off can
      // re-minimize. Capture before un-minimizing.
      _floatingState.preFullscreenMinimized = panel.classList.contains('ws-floating-folder');
      if (_floatingState.preFullscreenMinimized) restoreFromMinimized();
      // Save current panel rect + view state
      _floatingState.savedRect = {
        left: parseFloat(panel.style.left) || 0,
        top: parseFloat(panel.style.top) || 0,
        width: parseFloat(panel.style.width) || 720,
        height: parseFloat(panel.style.height) || 480
      };
      if (typeof NG !== 'undefined' && NG.zm && NG.pan) {
        var curP = NG.pan();
        _floatingState.savedView = { zoom: NG.zm() || 1, panX: curP.x, panY: curP.y };
        // Reset to a known baseline: zoom 1.0, pan to origin, then
        // expand the panel to the viewport-sized rect at (8,8).
        NG.zm(1.0);
        NG.pan(0, 0);
        if (typeof window.ngApplyTx === 'function') window.ngApplyTx();
      }
      var ar = area.getBoundingClientRect();
      panel.style.left = '8px';
      panel.style.top = '8px';
      panel.style.width = (ar.width - 16) + 'px';
      panel.style.height = (ar.height - 16) + 'px';
      _floatingState.maximized = true;
      panel.classList.add('ws-floating-maximized');
      if (typeof window.ngRender === 'function') window.ngRender();
    }
  }

  // Minimize → folder icon. Stows the panel as a small AGX-logo
  // file-folder watch in the corner of the canvas. Click the icon to
  // restore. The full panel state (size, position) is preserved.
  function minimizeWorkspace() {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel || !panel.classList.contains('ws-floating-graph-mode')) return;
    if (panel.classList.contains('ws-floating-folder')) return; // already minimized
    if (_floatingState.maximized) toggleFullscreenWorkspace(); // restore from full first
    _floatingState.preMinRect = {
      left: parseFloat(panel.style.left) || 0,
      top: parseFloat(panel.style.top) || 0,
      width: parseFloat(panel.style.width) || 720,
      height: parseFloat(panel.style.height) || 480
    };
    panel.classList.add('ws-floating-folder');
    panel.style.width = '320px';
    panel.style.height = '240px';
    // Restore the user's last minimized position if we have one;
    // otherwise leave the panel where it is so the minimized icon
    // appears near where the expanded panel was.
    var savedMin = null;
    try {
      var raw = localStorage.getItem('p86-ws-min-pos');
      if (raw) savedMin = JSON.parse(raw);
    } catch (e) {}
    if (savedMin && isFinite(savedMin.x) && isFinite(savedMin.y)) {
      panel.style.left = savedMin.x + 'px';
      panel.style.top = savedMin.y + 'px';
    }
    // Remember "minimized" so reopening the Workspace tab next time
    // (or a full page reload) restores into the folder state.
    saveWorkspaceState({ minimized: true });
  }
  function restoreFromMinimized() {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel || !panel.classList.contains('ws-floating-folder')) return;
    // Capture where the minimized icon currently is, then expand the
    // panel centered on that spot so it feels like the icon inflated
    // in place. Width/height come from preMinRect so the user's last
    // sizing is preserved.
    var miniLeft = parseFloat(panel.style.left) || 0;
    var miniTop = parseFloat(panel.style.top) || 0;
    var miniW = parseFloat(panel.style.width) || 320;
    var miniH = parseFloat(panel.style.height) || 240;
    var miniCx = miniLeft + miniW / 2;
    var miniCy = miniTop + miniH / 2;
    panel.classList.remove('ws-floating-folder');
    var w = (_floatingState.preMinRect && _floatingState.preMinRect.width) || 720;
    var h = (_floatingState.preMinRect && _floatingState.preMinRect.height) || 480;
    var newLeft = Math.round(miniCx - w / 2);
    var newTop = Math.round(miniCy - h / 2);
    panel.style.left = newLeft + 'px';
    panel.style.top = newTop + 'px';
    panel.style.width = w + 'px';
    panel.style.height = h + 'px';
    panel.dataset.graphX = newLeft;
    panel.dataset.graphY = newTop;
    panel.dataset.graphW = w;
    panel.dataset.graphH = h;
    // Persist the un-minimized state + the new rect so the next
    // tab open / reload comes back here.
    saveWorkspaceState({ minimized: false, x: newLeft, y: newTop, w: w, h: h });
  }
  // Wire the graph toolbar buttons. Called by attachWorkspaceToGraph
  // after the toolbar DOM exists. Idempotent: only binds once.
  var _toolbarWired = false;
  function wireGraphToolbarWorkspaceButtons() {
    if (_toolbarWired) return;
    var fsBtn = document.getElementById('ngWsFullscreenBtn');
    var maxBtn = document.getElementById('ngFullscreenGraphBtn');
    var auditBtn = document.getElementById('ngAuditBtn');
    if (fsBtn) fsBtn.addEventListener('click', toggleFullscreenWorkspace);
    // Toggle the AGX nav header. body class drives the CSS in
    // nodegraph.css (header { display: none } + #nodeGraphTab top: 0).
    // Button label flips between Maximize and Restore so the user
    // sees current state.
    if (maxBtn) maxBtn.addEventListener('click', function() {
      var on = document.body.classList.toggle('ng-graph-fullscreen');
      maxBtn.innerHTML = on ? '\u{1F5D7} Restore' : '\u{1F5D6} Maximize';
      maxBtn.title = on
        ? 'Restore the AGX nav header (toggle)'
        : 'Hide the AGX nav header to give the graph the entire viewport (toggle)';
    });
    // Audit — opens the connectivity+completeness modal scoped to
    // the current job. The badge count refreshes on every render
    // via refreshAuditBadge() below.
    if (auditBtn) auditBtn.addEventListener('click', function() {
      var jid = (window.appState && appState.currentJobId) || null;
      if (!jid) return alert('Open a job first.');
      if (window.p86JobAudit) window.p86JobAudit.open(jid);
    });
    // Ask 86 — opens the GLOBAL 86 surface (same one the floating
    // badge mounts in index.html: p86AI.open({entityType:'ask86'})).
    // This used to call openJobAI() which scopes to the current job;
    // the user wants the unified global 86 here so the chat session
    // is the same one as the rest of the app (sidebar / cross-session
    // memory / talk-through). The page-context block 86 receives on
    // each turn already names the active job, so 86 still knows what
    // graph you\'re looking at — without forking into a job-pinned
    // session.
    var askAIBtn = document.getElementById('ngAskAIBtn');
    if (askAIBtn) askAIBtn.addEventListener('click', function() {
      if (window.p86AI && typeof window.p86AI.open === 'function') {
        window.p86AI.open({ entityType: 'ask86' });
      } else if (typeof window.openJobAI === 'function') {
        // Fallback only — older bundle without p86AI.open exposed.
        window.openJobAI();
      }
    });
    _toolbarWired = true;
  }

  // Refresh the audit-button badge with the count of high+med
  // findings. Called on graph render so the count stays in sync as
  // the user wires/unwires nodes or edits %complete. Idempotent.
  function refreshAuditBadge() {
    var btn = document.getElementById('ngAuditBtn');
    var badge = document.getElementById('ngAuditBadge');
    if (!btn || !badge) return;
    var jid = (window.appState && appState.currentJobId) || null;
    if (!jid || !window.p86JobAudit) {
      badge.style.display = 'none';
      return;
    }
    try {
      var count = window.p86JobAudit.findingCount(jid, ['high', 'med']);
      if (count > 0) {
        badge.textContent = count;
        badge.style.display = 'inline-block';
      } else {
        badge.style.display = 'none';
      }
    } catch (e) { badge.style.display = 'none'; }
  }
  // Expose so nodegraph/ui.js's render() can call us after each
  // graph state change.
  window._wsRefreshAuditBadge = refreshAuditBadge;
  // Click the minimized folder icon to restore. Bound globally on the
  // panel since the folder takes over the panel's DOM.
  document.addEventListener('click', function(e) {
    var panel = document.getElementById('wsFloatingPanel');
    if (!panel || !panel.classList.contains('ws-floating-folder')) return;
    if (_floatingState.suppressRestoreClick) {
      _floatingState.suppressRestoreClick = false;
      return;
    }
    if (panel.contains(e.target)) {
      restoreFromMinimized();
    }
  });

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
      var activeId = activeTab ? activeTab.getAttribute('data-panel') : 'job-wip-report';
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
    // CRITICAL: scope to tabs that opt in via data-panel. Without
    // this filter, the loop also overwrote the .onclick property of
    // the estimate editor's tabs (Lines/Details/Scope/Attachments/
    // Preview), which share the .ws-right-tab class but use
    // data-ee-tab + their own inline onclick="switchEstimateEditorTab(
    // '...')". The generic handler below reads data-panel — that
    // attribute is null on estimate tabs, so the active class moved
    // but the pane never swapped. Estimate tabs now keep their
    // inline handler unmolested.
    var tabs = document.querySelectorAll('.ws-right-tab[data-panel]');
    var rc = document.getElementById('wsRightContent');
    if (!rc) return;

    // Tab→renderer registry. Used by both the per-tab click handler and
    // the workspace-toggle's restore path.
    var TAB_RENDERERS = {
      'job-overview': 'renderJobOverview',
      'job-qb-costs': 'renderJobQBCosts',
      'job-subs': 'renderJobSubs',
      'job-changeorders': 'renderChangeOrders',
      'job-purchaseorders': 'renderPurchaseOrders',
      'job-invoices': 'renderInvoices',
      'job-wip-report': 'renderWipTab',
      'job-reports': 'renderJobReports'
    };

    function activateTab(targetId) {
      var jobId = (typeof appState !== 'undefined') ? appState.currentJobId : null;
      tabs.forEach(function(t) {
        t.classList.toggle('active', t.getAttribute('data-panel') === targetId);
      });
      // If we're returning from workspace mode, tear down graph + panel.
      if (_inWorkspaceMode) {
        var graphTab = document.getElementById('nodeGraphTab');
        if (graphTab && graphTab.classList.contains('active')) {
          detachWorkspaceFromGraph();
          graphTab.classList.remove('active');
          if (typeof NG !== 'undefined' && NG.saveGraph) NG.saveGraph();
        }
        _inWorkspaceMode = false;
        var toggleBtn = document.getElementById('wsWorkspaceToggle');
        if (toggleBtn) toggleBtn.classList.remove('active');
      }
      // Defensive minimize for the floating workspace panel: if a
      // user opened the floating workspace and the _inWorkspaceMode
      // teardown above didn't catch it (edge case where the panel
      // lingered in ws-floating-graph-mode), collapse it into the
      // folder icon so it doesn't obscure the tab content below.
      // Audit finding W7b (memoized-inventing-mountain.md).
      var floatingPanel = document.getElementById('wsFloatingPanel');
      if (floatingPanel
          && floatingPanel.classList.contains('ws-floating-graph-mode')
          && !floatingPanel.classList.contains('ws-floating-folder')) {
        try { minimizeWorkspace(); } catch (_) { /* don't let UX polish crash tab switching */ }
      }
      var allPanels = Array.from(rc.children);
      allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
      var target = document.getElementById(targetId);
      if (target) target.style.display = 'block';
      if (!jobId) return;
      safeRenderTabContent(targetId, target, jobId, TAB_RENDERERS[targetId]);
    }

    tabs.forEach(function(tab) {
      tab.onclick = function() { activateTab(this.getAttribute('data-panel')); };
    });

    // Workspace open — single-shot. Click opens the node-graph canvas
    // and the floating workspace panel; from there the user backs out
    // via the workspace's own close button. We remember the previously
    // active tab so watchGraphTabClose() can restore it when the graph
    // tab loses its .active class. No toggle, no .active state on the
    // button itself.
    var openBtn = document.getElementById('wsWorkspaceToggle');
    if (openBtn) {
      openBtn.onclick = function() {
        var jobId = (typeof appState !== 'undefined') ? appState.currentJobId : null;
        // Remember which tab is currently active so the workspace's
        // close/back button restores it when the user exits.
        var activeTab = document.querySelector('.ws-right-tab[data-panel].active');
        _savedActiveTabId = activeTab ? activeTab.getAttribute('data-panel') : 'job-overview';
        _inWorkspaceMode = true;
        // Clear any tab's active class while in workspace mode.
        tabs.forEach(function(t) { t.classList.remove('active'); });
        // Hide all panels; the graph canvas will mount on top.
        var allPanels = Array.from(rc.children);
        allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
        ensureWorkspaceCanvas(rc);
        var canvas = document.getElementById('job-workspace');
        if (canvas) canvas.style.display = 'block';
        if (jobId && typeof window.openNodeGraph === 'function') {
          window.openNodeGraph(jobId);
          setTimeout(function() {
            watchGraphTabClose();
            attachWorkspaceToGraph();
          }, 50);
        }
      };
    }
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
    var detail = document.getElementById("jobs-job-detail-view");
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

    // Build the contextual job layout. Wrapped so a throw in ANY step can
    // never leave _applyingLayout stuck true — that previously froze the
    // whole job layout permanently (no subtab nav, metrics stuck on "--"),
    // because the observer early-returns while _applyingLayout is true.
    var _step = 'start';
    try {
      _step = 'buildHeader';
      buildHeader(detail, job);

      // Insert two-col layout after the (now hidden) job-detail-header
      _step = 'buildLayout';
      var layout = buildLayout(detail);
      var anchor = detail.querySelector(".job-detail-header");
      if (anchor && anchor.nextSibling) {
        detail.insertBefore(layout, anchor.nextSibling);
      } else {
        detail.appendChild(layout);
      }
      // Hide old summary grid and original elements
      _step = 'hideChrome';
      var summaryGrid = detail.querySelector(".summary-grid");
      ['.action-buttons', '.sub-tabs', '#job-info-card', '.job-totals-strip'].forEach(function(sel) { var el = detail.querySelector(sel); if (el) el.style.display = 'none'; });
      if (summaryGrid) summaryGrid.style.display = "none";
      _step = 'populateRightPanels'; populateRightPanels(detail);
      _step = 'wireResizer'; wireResizer();
      _step = 'wireTabSwitching'; wireTabSwitching();
      _step = 'moveJobInfoToAccordion'; moveJobInfoToAccordion(detail, document.getElementById('wsRightContent'));
      // Relocate the job subtabs into the left sidebar (desktop) and swap
      // the main nav out for a Back-to-Jobs + job-context view. Done AFTER
      // wireTabSwitching so the tabs keep their click handlers when moved.
      _step = 'mountJobSubnav'; mountJobSubnav(job);
      layoutApplied = true;
    } catch (e) {
      try { window.__p86LayoutErr = _step + ': ' + ((e && e.message) || e); } catch (_) {}
      if (window.console && console.warn) console.warn('[applyLayout] failed at ' + _step + ':', e);
      // Revert the half-built two-column layout to the static subtab view so
      // the job stays navigable, then mark applied so the observer doesn't
      // spin re-applying (which would infinite-loop via the body observer).
      try { cleanup(); } catch (_) {}
      layoutApplied = true;
    } finally {
      _applyingLayout = false;
    }
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
        // Phase 0: explicit entity type — see workspace-inject.js
        initWorkspace('wsWorkspaceContainer', 'job', jobId);
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
        var detail = document.getElementById('jobs-job-detail-view');
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
          // Remove any stale ws-two-col left from a previous session.
          // CRITICAL: rescue its panels first. A desynced layoutApplied
          // flag can make the CURRENT wrapper (with the live sub-tab
          // panels + #job-info-card still inside) look "stale"; removing
          // it blind destroys every subtab body and the detail renders
          // blank. rescuePanels() moves them back to detail so the
          // applyLayout() below can re-home them into the fresh wrapper.
          var stale = document.getElementById('ws-two-col');
          if (stale) { rescuePanels(stale, detail); stale.remove(); }
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
