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
  // Workspace tabs grouped Outlook-ribbon style. Each tab gets an icon
  // (emoji for color-without-SVG-overhead) + a section label so the
  // strip reads as "Job · Money · Changes · Resources" rather than a
  // flat row of pills. The accent color drives the icon hover/active
  // treatment in injectCSS below.
  const RIGHT_TABS = [
    { id: 'job-overview',       label: 'Overview',  icon: '\u{1F3E0}', accent: '#4f8cff', section: 'Job' },        // house
    { id: 'job-workspace',      label: 'Workspace', icon: '\u{1F4CA}', accent: '#a78bfa', section: 'Job' },        // chart
    { id: 'job-wip',            label: 'WIP',       icon: '\u{1F4B5}', accent: '#34d399', section: 'Money' },      // dollar bills
    { id: 'job-costs',          label: 'Costs',     icon: '\u{1F4B0}', accent: '#22c55e', section: 'Money' },      // money bag
    { id: 'job-qb-costs',       label: 'Detailed',  icon: '\u{1F4D1}', accent: '#16a34a', section: 'Money' },      // bookmark tabs
    { id: 'job-changeorders',   label: 'CO\'s',     icon: '\u{1F504}', accent: '#fb923c', section: 'Changes' },    // refresh/sync
    { id: 'job-purchaseorders', label: 'PO\'s',     icon: '\u{1F6D2}', accent: '#f97316', section: 'Changes' },    // shopping cart
    { id: 'job-invoices',       label: 'Invoices',  icon: '\u{1F9FE}', accent: '#fbbf24', section: 'Changes' },    // receipt
    { id: 'job-subs',           label: 'Subs',      icon: '\u{1F477}', accent: '#f87171', section: 'Resources' }   // construction worker
  ];

  // ── CSS injection ─────────────────────────────────────────
  function injectCSS() {
    if (document.getElementById('ws-layout-v2-css')) return;
    var link = document.createElement('link');
    link.id = 'ws-layout-v2-css';
    link.rel = 'stylesheet';
    link.href = 'css/workspace-layout.css?v=30';
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
    var detail = document.getElementById("wip-job-detail-view");
    if (detail) {
      var origHeader = detail.querySelector(".job-detail-header");
      if (origHeader) origHeader.style.display = "";
    }
    ['.action-buttons', '.sub-tabs', '#job-info-card'].forEach(function(sel) { var el = document.querySelector(sel); if (el) el.style.display = ''; });

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

      headerContent.insertBefore(jobInfo, userMenu);
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
    var appContainer = document.getElementById('app-container');
    var mainEl = appContainer ? appContainer.querySelector('main') : null;
    if (appContainer && mainEl) {
      appContainer.insertBefore(strip, mainEl);
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
      // JTD profit (revenueEarned − actualCosts) so the tile matches
      // the GROSS PROFIT watch node in the graph. The "as-sold +
      // revised plan" profit was confusing here — the WIP page's
      // dedicated Margin section is the right home for that metric.
      'Gross Profit': formatCurrency(w.jtdProfit),
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

    // Outlook-ribbon-style tab strip — grouped sections with vertical
    // dividers + a small section label underneath each group. Each tab
    // is a vertical button: colored icon on top, label below. Active
    // state shows a colored bottom underline (matches the Outlook
    // selected-tab cue).
    //
    // Sections render in the order they first appear in RIGHT_TABS.
    // We don\'t hard-code the section list so reordering / adding tabs
    // is just a metadata edit.
    var tabsByGroup = [];
    var seenSections = {};
    RIGHT_TABS.forEach(function(tab, i) {
      var sec = tab.section || 'Other';
      if (!seenSections[sec]) {
        seenSections[sec] = tabsByGroup.length;
        tabsByGroup.push({ name: sec, tabs: [] });
      }
      tabsByGroup[seenSections[sec]].tabs.push({ tab: tab, idx: i });
    });

    var tabsHtml = '<div class="ws-right-tabs ws-ribbon">';
    tabsByGroup.forEach(function(group, gi) {
      tabsHtml += '<div class="ws-ribbon-group">';
      tabsHtml += '<div class="ws-ribbon-group-buttons">';
      group.tabs.forEach(function(entry) {
        var t = entry.tab;
        var isActive = entry.idx === 0;
        // accent color drives both the icon background-bubble and
        // the active-state underline
        var accent = t.accent || '#888';
        // Keep .ws-right-tab on the element so wireTabSwitching\'s
        // existing selector (.ws-right-tab) still hooks the click +
        // active-class toggle. .ws-ribbon-tab carries the new ribbon
        // styling.
        tabsHtml += '<button class="ws-right-tab ws-ribbon-tab' + (isActive ? ' active' : '') + '" ' +
          'data-panel="' + t.id + '" data-accent="' + accent + '" ' +
          'style="--tab-accent:' + accent + ';">' +
          '<span class="ws-ribbon-icon">' + (t.icon || '') + '</span>' +
          '<span class="ws-ribbon-label">' + t.label + '</span>' +
        '</button>';
      });
      tabsHtml += '</div>';
      tabsHtml += '<div class="ws-ribbon-group-name">' + group.name + '</div>';
      tabsHtml += '</div>';
      // Vertical separator between groups (skip after the last group;
      // the AI section adds its own).
      if (gi < tabsByGroup.length - 1) {
        tabsHtml += '<div class="ws-ribbon-sep"></div>';
      }
    });
    // AI group on the far right — Ask Elle in the same ribbon shape
    // with its own section label.
    tabsHtml += '<div class="ws-ribbon-sep"></div>';
    tabsHtml += '<div class="ws-ribbon-group ws-ribbon-group-ai">' +
      '<div class="ws-ribbon-group-buttons">' +
        '<button class="ws-ribbon-tab ws-ribbon-tab-ai" onclick="openJobAI()" title="Ask Elle, AGX\'s WIP analyst" style="--tab-accent:#a78bfa;">' +
          '<span class="ws-ribbon-icon">✨</span>' +
          '<span class="ws-ribbon-label">Ask Elle</span>' +
        '</button>' +
      '</div>' +
      '<div class="ws-ribbon-group-name">AI</div>' +
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
          '<img src="images/logo-color.png" alt="AGX" class="ws-floating-logo ws-logo-color" />' +
          '<img src="images/logo-white.png" alt="AGX" class="ws-floating-logo ws-logo-white" />' +
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
            localStorage.setItem('agx-ws-min-pos', JSON.stringify({
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
    return jid ? 'agx-ws-graphstate:' + jid : null;
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
  // (close button clicked), make sure the workspace panel detaches
  // and the AGX nav header is restored if the user had hidden it.
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
      }
    });
    obs.observe(tab, { attributes: true, attributeFilter: ['class'] });
  }

  // ── Workspace state controls (driven by graph toolbar buttons) ──

  // Focus Workspace — set zoom to 1.0 and pan so the workspace center
  // is at the viewport center. Solves the "too small at low zoom" UX.
  function focusOnWorkspace() {
    if (typeof NG === 'undefined' || !NG.zm || !NG.pan) return;
    var panel = document.getElementById('wsFloatingPanel');
    var area = document.querySelector('#nodeGraphTab .ng-canvas-area');
    if (!panel || !area || !panel.classList.contains('ws-floating-graph-mode')) return;
    if (panel.classList.contains('ws-floating-folder')) restoreFromMinimized(); // unminimize first
    var x = parseFloat(panel.style.left) || 0;
    var y = parseFloat(panel.style.top) || 0;
    var w = parseFloat(panel.style.width) || 720;
    var h = parseFloat(panel.style.height) || 480;
    var ar = area.getBoundingClientRect();
    NG.zm(1.0);
    NG.pan(ar.width / 2 - (x + w / 2), ar.height / 2 - (y + h / 2));
    if (typeof window.ngApplyTx === 'function') window.ngApplyTx();
    if (typeof window.ngRender === 'function') window.ngRender();
  }

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
      var raw = localStorage.getItem('agx-ws-min-pos');
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
    var focusBtn = document.getElementById('ngWsFocusBtn');
    var fsBtn = document.getElementById('ngWsFullscreenBtn');
    var maxBtn = document.getElementById('ngFullscreenGraphBtn');
    var auditBtn = document.getElementById('ngAuditBtn');
    if (focusBtn) focusBtn.addEventListener('click', focusOnWorkspace);
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
      if (window.agxJobAudit) window.agxJobAudit.open(jid);
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
    if (!jid || !window.agxJobAudit) {
      badge.style.display = 'none';
      return;
    }
    try {
      var count = window.agxJobAudit.findingCount(jid, ['high', 'med']);
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
          var allPanels = Array.from(rc.children);
          allPanels.forEach(function(p) { if (!p.classList.contains('ws-job-info-details')) p.style.display = 'none'; });
          if (jobId && typeof window.openNodeGraph === 'function') {
            window.openNodeGraph(jobId);
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
          'job-qb-costs': 'renderJobQBCosts',
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
