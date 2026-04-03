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
    link.href = 'css/workspace-layout.css';
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
    var oldBtn = document.querySelector('.sub-tab-btn-job[data-subtab="job-workspace"]');
    if (oldBtn) oldBtn.remove();
    var oldPanel = document.getElementById('job-workspace');
    if (oldPanel) oldPanel.remove();
    var oldWs = document.getElementById('wsJobCostsWorkspace');
    if (oldWs) oldWs.remove();
    // Remove old v1 layout elements
    var oldStrip = document.getElementById('wip-dashboard-strip');
    if (oldStrip) oldStrip.remove();
    var oldCenter = document.getElementById('ws-center');
    if (oldCenter) oldCenter.remove();
    var oldAccordions = document.getElementById('ws-accordions');
    if (oldAccordions) oldAccordions.remove();
  }

  // ── Build enhanced header ─────────────────────────────────
  function buildHeader(detail, job) {
    var header = detail.querySelector('.job-detail-header');
    if (!header || header.querySelector('.jh-metrics')) return;

    // Extract key metric values from summary cards
    var summaryGrid = detail.querySelector('.summary-grid');
    var cards = summaryGrid ? summaryGrid.querySelectorAll('.summary-card') : [];
    var metricsMap = {};
    cards.forEach(function(card) {
      var lines = card.textContent.trim().split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      if (lines.length >= 2) metricsMap[lines[0].toUpperCase()] = lines[1];
    });

    // Build compact inline metrics
    var metricsDiv = document.createElement('div');
    metricsDiv.className = 'jh-metrics';

    var items = [
      { label: 'Contract', value: metricsMap['TOTAL INCOME'] || '', cls: 'jh-blue' },
      { label: 'Costs', value: metricsMap['ACTUAL COSTS'] || '', cls: 'jh-amber' },
      { label: 'Complete', value: metricsMap['% COMPLETE'] || '', cls: 'jh-cyan' },
      { label: 'Profit', value: metricsMap['GROSS PROFIT'] || '', cls: 'jh-green' },
      { label: 'Margin', value: metricsMap['MARGIN %'] || '', cls: 'jh-green' }
    ];

    var html = '';
    items.forEach(function(item) {
      if (item.value) {
        html += '<span class="jh-metric ' + item.cls + '">' +
          '<span class="jh-metric-label">' + item.label + '</span> ' +
          '<span class="jh-metric-value">' + item.value + '</span>' +
          '</span>';
      }
    });
    metricsDiv.innerHTML = html;
    header.appendChild(metricsDiv);
  }

  // ── Build the two-column layout ───────────────────────────
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

    // Metrics strip inside right column
    var summaryGrid = detail.querySelector('.summary-grid');
    var metricCards = summaryGrid ? summaryGrid.querySelectorAll('.summary-card') : [];
    var metricsHtml = '<div class="ws-right-metrics">';
    metricCards.forEach(function(card) {
      var lines = card.textContent.trim().split('\n').map(function(l) { return l.trim(); }).filter(Boolean);
      var label = lines[0] || '';
      var value = lines[1] || '';
      var cls = 'ds-default';
      var lbl = label.toUpperCase();
      if (lbl.includes('INCOME') || lbl.includes('REVENUE')) cls = 'ds-blue';
      else if (lbl.includes('COST')) cls = 'ds-amber';
      else if (lbl.includes('PROFIT')) cls = 'ds-green';
      else if (lbl.includes('MARGIN')) cls = 'ds-green';
      else if (lbl.includes('COMPLETE')) cls = 'ds-cyan';
      metricsHtml += '<div class="ds-metric-sm ' + cls + '">' +
        '<span class="ds-label-sm">' + label + '</span>' +
        '<span class="ds-value-sm">' + value + '</span>' +
        '</div>';
    });
    metricsHtml += '</div>';

    // Tab buttons
    var tabsHtml = '<div class="ws-right-tabs">';
    RIGHT_TABS.forEach(function(tab, i) {
      tabsHtml += '<button class="ws-right-tab' + (i === 0 ? ' active' : '') + '" data-panel="' + tab.id + '">' + tab.label + '</button>';
    });
    tabsHtml += '</div>';

    // Tab content area
    var contentHtml = '<div class="ws-right-content" id="wsRightContent"></div>';

    rightCol.innerHTML = metricsHtml + tabsHtml + contentHtml;

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
    var detail = document.getElementById('wip-job-detail-view');
    if (!detail || detail.style.display === 'none') return false;
    if (document.getElementById('ws-two-col')) return true;

    cleanup();
    injectWorkspaceCSS();

    // Build enhanced header with metrics
    buildHeader(detail);

    // Build two-column layout
    var layout = buildLayout(detail);

    // Hide old elements
    var summaryGrid = detail.querySelector('.summary-grid');
    if (summaryGrid) summaryGrid.style.display = 'none';
    var subTabs = detail.querySelector('.sub-tabs');
    if (subTabs) subTabs.style.display = 'none';
    var actionBtns = detail.querySelector('.action-buttons');
    if (actionBtns) actionBtns.style.display = 'none';
    detail.querySelectorAll('.sub-tab-content-job').forEach(function(p) { p.style.display = 'none'; });

    // Insert the layout
    var header = detail.querySelector('.job-detail-header');
    if (header && header.nextSibling) {
      detail.insertBefore(layout, header.nextSibling);
    } else {
      detail.appendChild(layout);
    }

    // Move panels into right content
    var rightContent = layout.querySelector('#wsRightContent');
    moveJobInfoToAccordion(detail, rightContent);
    populateRightPanels(detail, rightContent);
    wireTabSwitching(layout);

    detail.classList.add('ws-layout-applied');
    layoutApplied = true;
    return true;
  }

  // ── Workspace init ────────────────────────────────────────
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
        return;
      }

      if (!document.getElementById('ws-two-col')) {
        layoutApplied = false;
        currentJobId = null;
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
