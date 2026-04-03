// ============================================================
// AGX WIP Tracker — Workspace Injector v2
// Injects the spreadsheet grid INTO the Job Costs tab,
// between the description and cost input fields.
// Does NOT create a separate sub-tab or competing handlers.
// Load AFTER app.js + wip.js + workspace.js
// ============================================================

(function () {
  'use strict';

  let wsStylesLoaded = false;
  let currentJobId = null;

  /** Inject workspace CSS if not already present */
  function loadWorkspaceStyles() {
    if (wsStylesLoaded) return;
    if (document.querySelector('link[href*="workspace.css"]')) {
      wsStylesLoaded = true;
      return;
    }
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = 'css/workspace.css';
    document.head.appendChild(link);
    wsStylesLoaded = true;
  }

  /** Remove the old separate Workspace sub-tab if it exists */
  function removeOldWorkspaceTab() {
    const oldBtn = document.querySelector('.sub-tab-btn-job[data-subtab="job-workspace"]');
    if (oldBtn) oldBtn.remove();
    const oldPanel = document.getElementById('job-workspace');
    if (oldPanel) oldPanel.remove();
  }

  /** Build the workspace section element */
  function buildWorkspaceSection() {
    const section = document.createElement('div');
    section.id = 'wsJobCostsWorkspace';
    section.style.cssText = 'margin: 16px 0; border-top: 1px solid var(--border,#2e3346); padding-top: 12px;';

    section.innerHTML =
      '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">' +
        '<h4 style="margin:0;color:var(--text,#e4e6f0);font-size:14px;">' +
          'Workspace ' +
          '<span style="font-size:11px;color:var(--text-dim,#8b90a5);font-weight:400;margin-left:6px;">' +
            'Formulas \u00b7 Cell\u2192Job linking' +
          '</span>' +
        '</h4>' +
        '<span style="font-size:11px;color:var(--text-dim,#8b90a5);cursor:help;" ' +
          'title="Enter: edit | Tab: move right | Arrow keys: navigate | =SUM() =AVERAGE() =IF() | Paste from Excel">' +
          '\u24d8 Shortcuts</span>' +
      '</div>' +
      '<div id="wsWorkspaceContainer" tabindex="0"></div>';

    return section;
  }

  /** Inject workspace into the Job Costs card */
  function injectIntoJobCosts() {
    const jobCosts = document.getElementById('job-costs');
    if (!jobCosts) return false;

    // Already injected?
    if (document.getElementById('wsJobCostsWorkspace')) return true;

    const card = jobCosts.querySelector('.card');
    if (!card) return false;

    // Card children:
    // [0] H3 "Job-Level Costs"
    // [1] P description
    // [2] DIV form inputs
    // [3] DIV save button
    // [4] DIV totals
    // We insert the workspace between [1] and [2]
    const formInputs = card.children[2];
    if (!formInputs) return false;

    const wsSection = buildWorkspaceSection();
    card.insertBefore(wsSection, formInputs);

    return true;
  }

  /** Initialize workspace for the current job when Job Costs is visible */
  function tryInitWorkspace() {
    const jobCosts = document.getElementById('job-costs');
    if (!jobCosts || jobCosts.style.display === 'none') return;

    const container = document.getElementById('wsWorkspaceContainer');
    if (!container) return;

    const jobId = (typeof appState !== 'undefined' && appState.currentJobId)
      ? appState.currentJobId : null;

    if (!jobId) return;

    // Only re-init when the job changes
    if (jobId !== currentJobId) {
      currentJobId = jobId;
      if (typeof initWorkspace === 'function') {
        initWorkspace('wsWorkspaceContainer', jobId);
      }
    }
  }

  /** Main observer — watches for the job-costs panel to appear */
  function observe() {
    loadWorkspaceStyles();
    removeOldWorkspaceTab();

    const observer = new MutationObserver(function () {
      // Clean up old separate tab if it reappears (e.g. DOM rebuild)
      removeOldWorkspaceTab();

      const jobCosts = document.getElementById('job-costs');
      if (!jobCosts) return;

      // Inject if not yet present
      if (!document.getElementById('wsJobCostsWorkspace')) {
        injectIntoJobCosts();
      }

      // Init workspace when Job Costs tab is visible
      if (jobCosts.style.display !== 'none') {
        tryInitWorkspace();
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    // Also try immediately
    injectIntoJobCosts();
    tryInitWorkspace();
  }

  // ── Init on DOM ready ──
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', observe);
  } else {
    observe();
  }

})();
