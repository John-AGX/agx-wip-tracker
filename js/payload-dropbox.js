// PayloadDropbox — the universal "drop here to apply" slot mounted in
// the AI panel chrome. Accepts in-app drag from chat artifacts /
// sidebar entries AND native OS file drops of .p86.json. POSTs to
// /api/payloads/:id/apply.
//
// One instance per AI panel. Persistent — always visible while the
// panel is open. Doesn't need to live on a surface page because the
// payload row carries its own targets; the server routes by what's
// inside the file, not where it was dropped.
//
// Public API (window.PayloadDropbox):
//   mount(container, opts={}) → renders into container
//
// CustomEvents this listens to on document:
//   'p86:payload-drag-start' { payload_id, filename, targets } → highlight
//   'p86:payload-drag-end'  → un-highlight
//
// CustomEvents this dispatches on document:
//   'p86:payload-applied' { payload_id, apply_summary, affected_targets }
//     → surfaces / sidebar listen to refetch themselves
//
// C2 scope: full drop + apply flow; the apply endpoint returns 501
// until C3, but the dropbox surfaces the error gracefully so we can
// land the visual loop now.

(function () {
  'use strict';

  const STYLES = {
    container:
      'border:1.5px dashed rgba(255,255,255,0.18);background:rgba(255,255,255,0.02);' +
      'border-radius:10px;padding:11px 14px;display:flex;align-items:center;gap:10px;' +
      'font-size:12.5px;color:rgba(255,255,255,0.75);transition:all 0.15s;cursor:default;' +
      'user-select:none;',
    containerActive:
      'border-color:rgba(79,140,255,0.65);background:rgba(79,140,255,0.10);' +
      'color:#cfdcff;',
    containerApplying:
      'border-color:rgba(255,255,255,0.30);background:rgba(255,255,255,0.05);' +
      'color:rgba(255,255,255,0.85);',
    containerApplied:
      'border-color:rgba(46,204,113,0.55);background:rgba(46,204,113,0.10);' +
      'color:#7ee2a5;',
    containerFailed:
      'border-color:rgba(231,76,60,0.55);background:rgba(231,76,60,0.10);' +
      'color:#ffb4ad;',
    icon: 'font-size:18px;line-height:1;flex-shrink:0;',
    label: 'flex:1;min-width:0;',
    dismissBtn:
      'background:transparent;border:none;color:inherit;opacity:0.55;cursor:pointer;' +
      'font-size:14px;line-height:1;padding:0 2px;',
  };

  function setState(el, state, message) {
    const base = STYLES.container;
    let extra = '';
    if (state === 'active')   extra = STYLES.containerActive;
    if (state === 'applying') extra = STYLES.containerApplying;
    if (state === 'applied')  extra = STYLES.containerApplied;
    if (state === 'failed')   extra = STYLES.containerFailed;
    el.style.cssText = base + extra;
    const labelEl = el.querySelector('.p86-dropbox-label');
    const iconEl  = el.querySelector('.p86-dropbox-icon');
    const dismissEl = el.querySelector('.p86-dropbox-dismiss');
    if (state === 'idle') {
      iconEl.textContent = '📦';
      labelEl.textContent = message || 'Drop a payload here to apply';
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'active') {
      iconEl.textContent = '📦';
      labelEl.textContent = message || 'Drop to apply';
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'applying') {
      iconEl.textContent = '⏳';
      labelEl.textContent = message || 'Applying payload…';
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'applied') {
      iconEl.textContent = '✓';
      labelEl.textContent = message || 'Applied';
      if (dismissEl) dismissEl.style.display = '';
    } else if (state === 'failed') {
      iconEl.textContent = '✗';
      labelEl.textContent = message || 'Apply failed';
      if (dismissEl) dismissEl.style.display = '';
    }
    el.dataset.state = state;
  }

  async function applyPayload(payloadId, dropbox) {
    setState(dropbox, 'applying');
    try {
      const r = await fetch(
        '/api/payloads/' + encodeURIComponent(payloadId) + '/apply',
        { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json' } }
      );
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        // 501 is the C2 placeholder while the apply dispatcher is being
        // built in C3+. Show a calm message instead of a scary error.
        if (r.status === 501) {
          setState(dropbox, 'failed', 'Apply dispatcher not yet implemented (501).');
        } else if (r.status === 410) {
          setState(dropbox, 'failed', 'Payload expired — request a fresh one.');
        } else if (r.status === 409) {
          setState(dropbox, 'failed', 'Payload already used.');
        } else if (r.status === 404) {
          setState(dropbox, 'failed', 'Payload not found.');
        } else {
          setState(dropbox, 'failed', body.error || ('Apply failed: HTTP ' + r.status));
        }
        scheduleReset(dropbox, 8000);
        return;
      }
      const summary = body.apply_summary || ('Applied ' + (body.affected_targets || []).length + ' target(s).');
      setState(dropbox, 'applied', summary);
      // Notify any open surfaces so they refetch.
      document.dispatchEvent(new CustomEvent('p86:payload-applied', {
        detail: {
          payload_id: payloadId,
          apply_summary: body.apply_summary,
          affected_targets: body.affected_targets || [],
        }
      }));
      // Update the artifact card too (if visible in chat).
      if (window.PayloadArtifact && typeof window.PayloadArtifact.updateStatus === 'function') {
        window.PayloadArtifact.updateStatus(payloadId, 'applied', body.apply_summary);
      }
      scheduleReset(dropbox, 10000);
    } catch (err) {
      console.error('[payload-dropbox] apply failed:', err);
      setState(dropbox, 'failed', err && err.message || 'Apply failed');
      scheduleReset(dropbox, 8000);
    }
  }

  function scheduleReset(dropbox, ms) {
    clearTimeout(dropbox._resetTimer);
    dropbox._resetTimer = setTimeout(() => { setState(dropbox, 'idle'); }, ms);
  }

  function extractPayloadId(ev) {
    try {
      const idFromDirectType = ev.dataTransfer.getData('application/x-p86-payload-id');
      if (idFromDirectType) return idFromDirectType;
      const metaJson = ev.dataTransfer.getData('application/x-p86-payload');
      if (metaJson) {
        const meta = JSON.parse(metaJson);
        if (meta && meta.payload_id) return meta.payload_id;
      }
      // OS file drop: parse the file content for an id.
      if (ev.dataTransfer.files && ev.dataTransfer.files.length) {
        return null; // handled separately in drop()
      }
    } catch (_) { /* fall through */ }
    return null;
  }

  function isP86PayloadDrag(ev) {
    if (!ev.dataTransfer) return false;
    const types = Array.from(ev.dataTransfer.types || []);
    // types is unreliable on dragover for file drags; treat any drag
    // carrying a known type OR a file as a candidate. We re-check
    // strictly on drop.
    return types.indexOf('application/x-p86-payload-id') !== -1 ||
           types.indexOf('application/x-p86-payload') !== -1 ||
           types.indexOf('application/vnd.p86.payload+json') !== -1 ||
           types.indexOf('Files') !== -1;
  }

  function readFileAsP86(file) {
    return new Promise((resolve, reject) => {
      if (!/\.p86\.json$|\.json$/i.test(file.name || '')) {
        return reject(new Error('Not a .p86.json file: ' + file.name));
      }
      const reader = new FileReader();
      reader.onload = () => {
        try {
          const parsed = JSON.parse(reader.result);
          // Look for an id at the top level (server-emitted files
          // include id in file_content; we accept both shapes).
          const id = parsed && (parsed.id || (parsed.meta && parsed.meta.id));
          if (!id) return reject(new Error('No payload id found in file. ' +
            'Re-download from the AI panel or sidebar.'));
          resolve(id);
        } catch (err) {
          reject(new Error('File parse failed: ' + err.message));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.readAsText(file);
    });
  }

  function mount(container, opts) {
    if (!container) {
      console.warn('[payload-dropbox] mount: no container');
      return null;
    }
    const el = document.createElement('div');
    el.id = (opts && opts.id) || 'p86-universal-dropbox';
    el.className = 'p86-payload-dropbox';
    el.dataset.state = 'idle';
    el.style.cssText = STYLES.container;
    el.innerHTML =
      '<div class="p86-dropbox-icon" style="' + STYLES.icon + '">📦</div>' +
      '<div class="p86-dropbox-label" style="' + STYLES.label + '">Drop a payload here to apply</div>' +
      '<button type="button" class="p86-dropbox-dismiss" style="' + STYLES.dismissBtn + ';display:none;" title="Dismiss">&times;</button>';

    el.querySelector('.p86-dropbox-dismiss').addEventListener('click', (ev) => {
      ev.stopPropagation();
      setState(el, 'idle');
    });

    el.addEventListener('dragenter', (ev) => {
      if (!isP86PayloadDrag(ev)) return;
      ev.preventDefault();
      if (el.dataset.state === 'idle' || el.dataset.state === 'active') {
        setState(el, 'active');
      }
    });
    el.addEventListener('dragover', (ev) => {
      if (!isP86PayloadDrag(ev)) return;
      ev.preventDefault();
      try { ev.dataTransfer.dropEffect = 'copy'; } catch (_) {}
    });
    el.addEventListener('dragleave', (ev) => {
      // dragleave fires on child enter too — only reset if we leave
      // the dropbox entirely.
      if (ev.target !== el) return;
      if (el.dataset.state === 'active') setState(el, 'idle');
    });
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      // First try the fast path: an in-app drag with payload_id.
      const idFromDrag = extractPayloadId(ev);
      if (idFromDrag) {
        await applyPayload(idFromDrag, el);
        return;
      }
      // OS file drop: parse the file content for a payload id.
      const files = (ev.dataTransfer && ev.dataTransfer.files) || [];
      if (!files.length) {
        setState(el, 'failed', 'No payload identified in the drop.');
        scheduleReset(el, 4000);
        return;
      }
      try {
        const id = await readFileAsP86(files[0]);
        await applyPayload(id, el);
      } catch (err) {
        setState(el, 'failed', err.message || 'Drop failed');
        scheduleReset(el, 6000);
      }
    });

    // Cross-component hooks — show the active state when an artifact
    // starts dragging so the user sees a clear target.
    const onDragStart = (ev) => {
      if (el.dataset.state === 'idle') setState(el, 'active', 'Drop here to apply');
    };
    const onDragEnd = () => {
      if (el.dataset.state === 'active') setState(el, 'idle');
    };
    document.addEventListener('p86:payload-drag-start', onDragStart);
    document.addEventListener('p86:payload-drag-end', onDragEnd);

    container.appendChild(el);
    return el;
  }

  window.PayloadDropbox = { mount: mount };
})();
