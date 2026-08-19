// ============================================================
// Project 86 — Job sidebar: Files + Photos tabs
// ------------------------------------------------------------
// Two job sub-tabs that promote the job's attachments out of the
// Overview and into dedicated sidebar sections:
//
//   Photos (#job-photos)  → the photo-forward attachments manager
//                           (window.p86Attachments) — the same widget +
//                           canonical .p86-proj-photo-tile look the job
//                           Overview already uses, scoped to this job.
//   Files  (#job-files)   → the folder-tree file explorer
//                           (window.p86Explorer) scoped to this job.
//
// Both renderers are looked up as window[fn](jobId) by all three job
// sub-tab dispatch maps: TAB_RENDERERS + activateTabFromOutside
// (js/workspace-layout.js) and _LATE_JOB_SUBTAB_RENDERERS (js/app.js).
// The panes are static <div class="sub-tab-content-job"> elements in
// index.html; populateRightPanels() relocates them into #wsRightContent
// and the router shows/hides them by inline display.
//
// Loaded AFTER api.js, attachments.js, file-explorer.js and jobs.js so
// p86Api / p86Attachments / p86Explorer / appData are all available.
// ============================================================
(function () {
  'use strict';

  // Editable unless the job carries an explicit _canEdit:false gate — mirrors
  // the Overview file mount (js/jobs.js). Fail OPEN to true (the server still
  // enforces write capability); the gate only tames the client affordances.
  function canEditJob(jobId) {
    try {
      var jobs = (window.appData && window.appData.jobs) || [];
      var job = jobs.find(function (j) { return j && j.id === jobId; });
      if (job && job._canEdit === false) return false;
    } catch (e) { /* fail open */ }
    return true;
  }

  function unavailable(pane, what) {
    pane.innerHTML =
      '<div style="padding:24px;color:var(--text-dim,#888);font-size:13px;">' +
      what + ' couldn\'t load — try refreshing the page.' +
      '</div>';
  }

  // ── Files tab ──────────────────────────────────────────────
  function renderJobFiles(jobId) {
    var pane = document.getElementById('job-files');
    if (!pane) return;
    if (!jobId) { pane.innerHTML = ''; return; }
    if (!window.p86Explorer || typeof window.p86Explorer.mount !== 'function') {
      unavailable(pane, 'The file explorer');
      return;
    }
    pane.innerHTML = '';
    try {
      window.p86Explorer.mount(pane, {
        entityType: 'job',
        entityId: String(jobId),
        canEdit: canEditJob(jobId),
        embedded: true,
        height: 680
      });
    } catch (e) {
      try { console.error('[job-media] renderJobFiles failed:', e); } catch (_) {}
      unavailable(pane, 'The file explorer');
    }
  }
  window.renderJobFiles = renderJobFiles;

  // ── Photos tab ─────────────────────────────────────────────
  function renderJobPhotos(jobId) {
    var pane = document.getElementById('job-photos');
    if (!pane) return;
    if (!jobId) { pane.innerHTML = ''; return; }
    if (!window.p86Attachments || typeof window.p86Attachments.mount !== 'function') {
      unavailable(pane, 'Photos');
      return;
    }
    pane.innerHTML = '';
    try {
      window.p86Attachments.mount(pane, {
        entityType: 'job',
        entityId: String(jobId),
        canEdit: canEditJob(jobId)
      });
    } catch (e) {
      try { console.error('[job-media] renderJobPhotos failed:', e); } catch (_) {}
      unavailable(pane, 'Photos');
    }
  }
  window.renderJobPhotos = renderJobPhotos;
})();
