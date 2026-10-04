// ============================================================
// Project 86 — Job sidebar: Files + Photos + Comments tabs
// ------------------------------------------------------------
// Three job sub-tabs that promote the job's attachments and its comment
// thread out of the Overview and into dedicated sidebar sections:
//
//   Photos (#job-photos)  → the photo-forward attachments manager
//                           (window.p86Attachments) — the same widget +
//                           canonical .p86-proj-photo-tile look the job
//                           Overview already uses, scoped to this job.
//   Files  (#job-files)   → the folder-tree file explorer
//                           (window.p86Explorer) scoped to this job.
//   Comments (#job-comments) → the job's conversation thread, rendered by
//                           window.p86Messaging.mountInline on `job:<id>`.
//
// THE COMMENTS TAB IS THE HOST mountInline WAS WRITTEN FOR. js/messaging.js
// has documented it since it shipped — "used by the job detail page's
// Comments slot" — and the slot was never built, so mountInline was exported
// and called from nowhere. The thread underneath it was always real: 86's
// add_photo_comment tool and the photo viewer both write into these threads,
// and a job: comment had no reading surface at all.
//
// All three renderers are looked up as window[fn](jobId) by all three job
// sub-tab dispatch maps: TAB_RENDERERS + activateTabFromOutside
// (js/workspace-layout.js) and _LATE_JOB_SUBTAB_RENDERERS (js/app.js).
// The panes are static <div class="sub-tab-content-job"> elements in
// index.html; populateRightPanels() relocates them into #wsRightContent
// and the router shows/hides them by inline display.
//
// Loaded AFTER api.js, attachments.js, file-explorer.js, messaging.js and jobs.js so
// p86Api / p86Attachments / p86Explorer / p86Messaging / appData are ready.
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
  // THE JOB'S TASKS, as a section. The panel itself is the shared one
  // (p86Tasks.mountEntityPanel) that the Overview dashboard and the client and
  // estimate pages already use — the same list, the same add button, the same
  // refresh registry. What is new is only that it has a section of its own, so
  // "what is outstanding on this job" is one tap from the sidebar instead of a
  // scroll down somebody else's dashboard.
  //
  // Remounted on every visit rather than cached: a task completed in the modal
  // (or by 86) has to be gone when the section is reopened.
  function renderJobTasks(jobId) {
    var host = document.getElementById('job-tasks');
    if (!host) return;
    if (!(window.p86Tasks && typeof window.p86Tasks.mountEntityPanel === 'function')) {
      host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);">Tasks module not loaded.</div>';
      return;
    }
    var id = jobId || (typeof appState !== 'undefined' ? appState.currentJobId : null);
    if (!id) { host.innerHTML = ''; return; }
    var job = (window.appData && (appData.jobs || []).find(function (j) { return j.id === id; })) || null;
    // The job's forward-facing name, the same one every other surface prints.
    var label = (window.p86JobLabel && job)
      ? window.p86JobLabel.fromJob(job, { fallback: 'Job ' + id })
      : ('Job ' + id);
    // mountEntityPanel assigns the host's innerHTML, so the previous visit's
    // rows go with it — a task completed in the modal is not still sitting
    // here when the section is reopened.
    window.p86Tasks.mountEntityPanel(host, 'job', id, label);
  }

  window.renderJobTasks = renderJobTasks;
  window.renderJobPhotos = renderJobPhotos;

  // ── Comments tab ───────────────────────────────────────────
  // mountInline WRITES display:flex ONTO ITS HOST, so the host cannot be the
  // pane. A job sub-tab is shown and hidden by display — style.display
  // 'block'/'none' in the workspace layout, the .active class in the legacy
  // strip — so an inline display:flex on #job-comments would beat
  // `.sub-tab-content-job { display: none }` and leave Comments painted on
  // top of whichever tab the user picked next, and the next activation would
  // overwrite flex with block and flatten the thread's column. The wrapper
  // takes the flex treatment; the pane keeps its own display.
  //
  // Thread key is `job:<id>`, one of the shapes isValidThreadKey admits.
  // The server proves the job is this caller's before it reads or writes the
  // thread (server/services/thread-org-scope.js); a refusal lands in the
  // thread list as mountInline's own "Could not load" line.
  function renderJobComments(jobId) {
    var pane = document.getElementById('job-comments');
    if (!pane) return;
    if (!jobId || !window.p86Messaging || typeof window.p86Messaging.mountInline !== 'function') {
      unavailable(pane, 'Comments');
      return;
    }
    var host = document.createElement('div');
    host.className = 'job-comments-host';
    // max-height is what makes the message list scroll instead of the page:
    // mountInline's list is flex:1 + overflow-y:auto, which only bites when
    // the column is bounded.
    host.style.cssText = 'min-height:380px;max-height:calc(100vh - 240px);'
      + 'border:1px solid var(--border,#2a2a3a);border-radius:10px;overflow:hidden;';
    pane.innerHTML = '';
    pane.appendChild(host);
    try {
      window.p86Messaging.mountInline(host, 'job:' + String(jobId), {
        title: 'Comments on this job',
        // Reading a thread marks it read, and the count beside Messages is
        // the same count — so posting has to refresh the badge or it keeps
        // claiming there is something unread here.
        onPosted: function () {
          try {
            if (window.p86Messaging && typeof window.p86Messaging.refreshNavBadge === 'function') {
              window.p86Messaging.refreshNavBadge();
            }
          } catch (e) { /* a badge is not worth an exception */ }
        }
      });
    } catch (e) {
      try { console.error('[job-media] renderJobComments failed:', e); } catch (_) {}
      unavailable(pane, 'Comments');
    }
  }
  window.renderJobComments = renderJobComments;
})();
