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
    containerActivePreview:
      'border-color:rgba(155,89,242,0.65);background:rgba(155,89,242,0.10);' +
      'color:#d6b9ff;',
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
    modeToggle:
      'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.14);' +
      'color:#e6e6e6;border-radius:5px;font-size:10.5px;padding:3px 7px;cursor:pointer;' +
      'transition:background 0.12s, border-color 0.12s;flex-shrink:0;',
    modeToggleActive:
      'background:rgba(155,89,242,0.20);border-color:rgba(155,89,242,0.55);color:#d6b9ff;',
  };

  function setState(el, state, message) {
    const previewMode = el.dataset.previewMode === '1';
    const base = STYLES.container;
    let extra = '';
    if (state === 'active') {
      extra = previewMode ? STYLES.containerActivePreview : STYLES.containerActive;
    } else if (state === 'applying') extra = STYLES.containerApplying;
    else if (state === 'applied')    extra = STYLES.containerApplied;
    else if (state === 'failed')     extra = STYLES.containerFailed;
    el.style.cssText = base + extra;
    const labelEl = el.querySelector('.p86-dropbox-label');
    const iconEl  = el.querySelector('.p86-dropbox-icon');
    const dismissEl = el.querySelector('.p86-dropbox-dismiss');
    if (state === 'idle') {
      iconEl.textContent = '📦';
      labelEl.textContent = message || (previewMode
        ? 'Drop a payload to preview (dry run — no changes)'
        : 'Drop a payload here to apply');
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'active') {
      iconEl.textContent = previewMode ? '🔍' : '📦';
      labelEl.textContent = message || (previewMode ? 'Drop to preview' : 'Drop to apply');
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'applying') {
      iconEl.textContent = '⏳';
      labelEl.textContent = message || (previewMode ? 'Previewing…' : 'Applying payload…');
      if (dismissEl) dismissEl.style.display = 'none';
    } else if (state === 'applied') {
      iconEl.textContent = '✓';
      labelEl.textContent = message || (previewMode ? 'Preview ready' : 'Applied');
      if (dismissEl) dismissEl.style.display = '';
    } else if (state === 'failed') {
      iconEl.textContent = '✗';
      labelEl.textContent = message || 'Apply failed';
      if (dismissEl) dismissEl.style.display = '';
    }
    el.dataset.state = state;
  }

  async function applyPayload(payloadId, dropbox) {
    const previewMode = dropbox.dataset.previewMode === '1';
    setState(dropbox, 'applying');
    try {
      const url = '/api/payloads/' + encodeURIComponent(payloadId) + '/apply' +
                  (previewMode ? '?dry_run=true' : '');
      const r = await fetch(url, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
      });
      const body = await r.json().catch(() => ({}));
      if (!r.ok) {
        if (r.status === 501) {
          setState(dropbox, 'failed', 'Apply dispatcher not yet implemented (501).');
        } else if (r.status === 410) {
          setState(dropbox, 'failed', 'Payload expired — request a fresh one.');
        } else if (r.status === 409) {
          setState(dropbox, 'failed', 'Payload already used.');
        } else if (r.status === 404) {
          setState(dropbox, 'failed', 'Payload not found.');
        } else if (r.status === 422) {
          setState(dropbox, 'failed', body.error || 'Validation failed');
        } else {
          setState(dropbox, 'failed', body.error || ('Apply failed: HTTP ' + r.status));
        }
        scheduleReset(dropbox, 8000);
        return;
      }
      if (previewMode) {
        // Show the diff in a modal instead of touching anything.
        showPreviewModal(body, payloadId);
        setState(dropbox, 'applied', 'Preview rendered — payload still ready');
        scheduleReset(dropbox, 6000);
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

  // ───────────────────────────────────────────────────────────────
  // Preview modal — renders the dry-run diff returned by
  // /apply?dry_run=true. Shows per-target summary + change list +
  // ref resolutions (when $new_id refs were used).
  // ───────────────────────────────────────────────────────────────
  function showPreviewModal(body, payloadId) {
    const overlay = document.createElement('div');
    overlay.style.cssText =
      'position:fixed;inset:0;background:rgba(0,0,0,0.55);z-index:9999;' +
      'display:flex;align-items:center;justify-content:center;padding:24px;';
    overlay.addEventListener('click', (ev) => { if (ev.target === overlay) overlay.remove(); });

    const modal = document.createElement('div');
    modal.style.cssText =
      'background:var(--surface,#0f0f1e);border:1px solid rgba(155,89,242,0.35);' +
      'border-radius:12px;max-width:640px;width:100%;max-height:80vh;overflow:auto;' +
      'padding:18px 20px;color:#e6e6e6;font-size:13px;line-height:1.5;';

    const closeBtn = document.createElement('button');
    closeBtn.textContent = '×';
    closeBtn.style.cssText =
      'float:right;background:transparent;border:none;color:rgba(255,255,255,0.6);' +
      'font-size:22px;line-height:1;cursor:pointer;padding:0 4px;';
    closeBtn.onclick = () => overlay.remove();
    modal.appendChild(closeBtn);

    const heading = document.createElement('div');
    heading.style.cssText =
      'font-size:11px;text-transform:uppercase;letter-spacing:0.06em;' +
      'color:#d6b9ff;margin-bottom:4px;';
    heading.textContent = '🔍 Dry-run preview';
    modal.appendChild(heading);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:600;color:#fff;margin-bottom:12px;';
    title.textContent = body.apply_summary || 'No changes';
    modal.appendChild(title);

    const note = document.createElement('div');
    note.style.cssText =
      'background:rgba(155,89,242,0.10);border:1px solid rgba(155,89,242,0.25);' +
      'border-radius:6px;padding:8px 10px;font-size:11.5px;color:#d6b9ff;margin-bottom:14px;';
    note.textContent = 'No changes were applied. The payload is still ready — drag again with Preview off to commit.';
    modal.appendChild(note);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const targets = body.affected_targets || [];
    if (!targets.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:rgba(255,255,255,0.45);font-size:12px;';
      empty.textContent = 'No affected targets returned.';
      list.appendChild(empty);
    } else {
      targets.forEach((t, i) => {
        const row = document.createElement('div');
        row.style.cssText =
          'border:1px solid rgba(255,255,255,0.08);border-radius:8px;padding:10px 12px;' +
          'background:rgba(255,255,255,0.02);';
        const head = document.createElement('div');
        head.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.85);font-weight:600;';
        head.textContent = '#' + (i + 1) + '  ' + (t.entity_type || '?') +
                          (t.entity_id ? '  ' + t.entity_id : '');
        row.appendChild(head);
        if (t.summary) {
          const s = document.createElement('div');
          s.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.72);margin-top:4px;';
          s.textContent = t.summary;
          row.appendChild(s);
        }
        if (Array.isArray(t.changes) && t.changes.length) {
          const c = document.createElement('ul');
          c.style.cssText =
            'margin:6px 0 0 0;padding-left:18px;font-size:11.5px;color:rgba(255,255,255,0.60);';
          t.changes.forEach((ch) => {
            const li = document.createElement('li');
            li.textContent = ch;
            c.appendChild(li);
          });
          row.appendChild(c);
        }
        list.appendChild(row);
      });
    }
    modal.appendChild(list);

    if (body.ref_resolutions && Object.keys(body.ref_resolutions).length) {
      const refHead = document.createElement('div');
      refHead.style.cssText =
        'margin-top:14px;font-size:11px;text-transform:uppercase;' +
        'letter-spacing:0.06em;color:rgba(255,255,255,0.40);';
      refHead.textContent = 'Ref resolutions';
      modal.appendChild(refHead);
      const refTbl = document.createElement('div');
      refTbl.style.cssText =
        'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11px;' +
        'color:rgba(255,255,255,0.65);margin-top:4px;';
      refTbl.textContent = Object.entries(body.ref_resolutions)
        .map(([k, v]) => k + ' → ' + v).join('\n');
      refTbl.style.whiteSpace = 'pre-wrap';
      modal.appendChild(refTbl);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const esc = (ev) => { if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
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
      '<button type="button" class="p86-dropbox-preview-toggle" style="' + STYLES.modeToggle + '" ' +
        'title="Toggle preview mode (dry-run — show diff without applying)">🔍 Preview</button>' +
      '<button type="button" class="p86-dropbox-dismiss" style="' + STYLES.dismissBtn + ';display:none;" title="Dismiss">&times;</button>';

    // Preview-mode toggle — drops while ON trigger ?dry_run=true and
    // surface a diff modal. Mode persists across drops until clicked off.
    el.dataset.previewMode = '0';
    const toggleBtn = el.querySelector('.p86-dropbox-preview-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const next = el.dataset.previewMode === '1' ? '0' : '1';
        el.dataset.previewMode = next;
        if (next === '1') {
          toggleBtn.style.cssText = STYLES.modeToggle + STYLES.modeToggleActive;
          toggleBtn.textContent = '🔍 Preview ON';
        } else {
          toggleBtn.style.cssText = STYLES.modeToggle;
          toggleBtn.textContent = '🔍 Preview';
        }
        setState(el, 'idle');
      });
    }

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
