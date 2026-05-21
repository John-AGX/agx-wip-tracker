// PayloadDropbox — the universal "drop here to apply" gate, rendered
// as a Project 86 tank/turret. Mounted in the AI panel chrome above
// the input. Accepts in-app drag from chat artifacts / sidebar entries
// AND native OS file drops of .p86.json.
//
// Visual states (data-state attribute drives CSS):
//   idle      — turret elevated, calm dashed border
//   active    — payload mid-drag, turret pivots to acquire, border glows
//   applying  — barrel recoils, muzzle flash, shell ejects + flies
//                across the panel, explosion ring at impact
//   applied   — green tint + tiny celebratory bounce + apply_summary
//   failed    — red tint + droopy barrel + error message
//
// Preview mode (toggle button to the right): the same firing sequence,
// but the shell is a "recon round" — purple tint, no explosion. The
// diff modal opens on impact.
//
// API kept stable from C2:
//   window.PayloadDropbox.mount(container, opts) → element
//
// CustomEvents:
//   listens:  p86:payload-drag-start, p86:payload-drag-end
//   dispatches: p86:payload-applied { payload_id, apply_summary, affected_targets }

(function () {
  'use strict';

  // One-time style injection. All animation work happens in CSS so the
  // GPU does the heavy lifting; JS just toggles data-state.
  function injectStylesOnce() {
    if (document.getElementById('p86-tank-styles')) return;
    const css = `
      .p86-tank-host {
        position: relative;
        width: 100%;
        min-height: 32px;
        padding: 4px 10px;
        display: flex;
        align-items: center;
        gap: 10px;
        background: linear-gradient(180deg, rgba(255,255,255,0.015) 0%, rgba(255,255,255,0.04) 100%);
        border: 1px dashed rgba(255,255,255,0.18);
        border-radius: 6px;
        color: rgba(255,255,255,0.78);
        font-size: 11.5px;
        user-select: none;
        transition: border-color 0.18s, background 0.18s, transform 0.18s;
        overflow: hidden;
      }
      .p86-tank-host[data-state="active"] {
        border-color: rgba(79,140,255,0.70);
        background: linear-gradient(180deg, rgba(79,140,255,0.05) 0%, rgba(79,140,255,0.14) 100%);
        color: #cfdcff;
      }
      .p86-tank-host[data-state="active"][data-preview="1"] {
        border-color: rgba(155,89,242,0.70);
        background: linear-gradient(180deg, rgba(155,89,242,0.05) 0%, rgba(155,89,242,0.14) 100%);
        color: #d6b9ff;
      }
      .p86-tank-host[data-state="applying"] {
        border-color: rgba(255,200,80,0.65);
        background: linear-gradient(180deg, rgba(255,200,80,0.06) 0%, rgba(255,200,80,0.18) 100%);
        color: #ffe5a6;
      }
      .p86-tank-host[data-state="applied"] {
        border-color: rgba(46,204,113,0.65);
        background: linear-gradient(180deg, rgba(46,204,113,0.06) 0%, rgba(46,204,113,0.18) 100%);
        color: #7ee2a5;
        animation: p86-tank-bounce 0.5s ease-out;
      }
      .p86-tank-host[data-state="failed"] {
        border-color: rgba(231,76,60,0.65);
        background: linear-gradient(180deg, rgba(231,76,60,0.06) 0%, rgba(231,76,60,0.18) 100%);
        color: #ffb4ad;
      }

      .p86-tank-svg {
        flex-shrink: 0;
        width: 48px;
        height: 28px;
        overflow: visible;
      }
      .p86-tank-turret-group {
        transform-origin: 36px 26px;   /* turret pivot point */
        transition: transform 0.32s cubic-bezier(0.4, 0.0, 0.2, 1);
      }
      .p86-tank-host[data-state="idle"] .p86-tank-turret-group { transform: rotate(-30deg); }
      .p86-tank-host[data-state="active"] .p86-tank-turret-group { transform: rotate(-15deg); }
      .p86-tank-host[data-state="applying"] .p86-tank-turret-group {
        transform: rotate(-15deg);
        animation: p86-tank-recoil 0.45s ease-out;
      }
      .p86-tank-host[data-state="applied"] .p86-tank-turret-group { transform: rotate(-30deg); }
      .p86-tank-host[data-state="failed"] .p86-tank-turret-group {
        transform: rotate(20deg);  /* barrel droops */
      }

      .p86-tank-muzzle-flash {
        opacity: 0;
        transform-origin: 70px 26px;
        transform: scale(0);
      }
      .p86-tank-host[data-state="applying"] .p86-tank-muzzle-flash {
        animation: p86-muzzle-flash 0.35s ease-out;
      }

      .p86-tank-shell {
        position: absolute;
        left: 56px;  /* approximate barrel tip — adjusted for slim 48x28 tank */
        top: 50%;
        width: 8px;
        height: 3px;
        margin-top: -1px;
        background: linear-gradient(90deg, #ffcc66 0%, #ff8833 100%);
        border-radius: 2px;
        box-shadow: 0 0 5px rgba(255,200,80,0.8);
        opacity: 0;
        pointer-events: none;
      }
      .p86-tank-host[data-state="applying"] .p86-tank-shell {
        animation: p86-shell-fly 0.55s ease-out;
      }

      .p86-tank-explosion {
        position: absolute;
        right: 8px;
        top: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        border: 2px solid rgba(255,200,80,0.9);
        background: rgba(255,140,80,0.30);
        transform: translate(0, -50%) scale(0);
        opacity: 0;
        pointer-events: none;
      }
      .p86-tank-host[data-state="applying"]:not([data-preview="1"]) .p86-tank-explosion {
        animation: p86-boom 0.5s ease-out 0.45s;
      }

      .p86-tank-label-block {
        flex: 1;
        min-width: 0;
        line-height: 1.2;
        display: flex;
        align-items: baseline;
        gap: 8px;
        overflow: hidden;
      }
      .p86-tank-title {
        font-size: 10.5px;
        font-weight: 600;
        letter-spacing: 0.05em;
        text-transform: uppercase;
        opacity: 0.85;
        flex-shrink: 0;
      }
      .p86-tank-sub {
        font-size: 11px;
        opacity: 0.65;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
        min-width: 0;
      }

      .p86-tank-mode-toggle {
        flex-shrink: 0;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.14);
        color: #e6e6e6;
        border-radius: 4px;
        font-size: 9.5px;
        padding: 2px 7px;
        cursor: pointer;
        transition: background 0.12s, border-color 0.12s;
        letter-spacing: 0.04em;
      }
      .p86-tank-mode-toggle.is-on {
        background: rgba(155,89,242,0.20);
        border-color: rgba(155,89,242,0.55);
        color: #d6b9ff;
      }
      .p86-tank-dismiss {
        flex-shrink: 0;
        background: transparent;
        border: none;
        color: inherit;
        opacity: 0.55;
        cursor: pointer;
        font-size: 16px;
        line-height: 1;
        padding: 0 4px;
      }

      @keyframes p86-tank-recoil {
        0%   { transform: rotate(-15deg) translateX(0); }
        20%  { transform: rotate(-15deg) translateX(-6px); }
        100% { transform: rotate(-15deg) translateX(0); }
      }
      @keyframes p86-muzzle-flash {
        0%   { opacity: 0; transform: scale(0.2); }
        15%  { opacity: 1; transform: scale(1.6); }
        50%  { opacity: 0.4; transform: scale(2.4); }
        100% { opacity: 0; transform: scale(2.8); }
      }
      @keyframes p86-shell-fly {
        0%   { opacity: 0; transform: translate(0, 0) scale(0.8); }
        10%  { opacity: 1; transform: translate(8px, -2px) scale(1); }
        100% { opacity: 0; transform: translate(calc(100% + 600px), 6px) scale(1); }
      }
      @keyframes p86-boom {
        0%   { transform: translate(0, -50%) scale(0.2); opacity: 0; }
        20%  { transform: translate(0, -50%) scale(0.7); opacity: 1; }
        100% { transform: translate(0, -50%) scale(3.5); opacity: 0; }
      }
      @keyframes p86-tank-bounce {
        0%   { transform: translateY(0); }
        40%  { transform: translateY(-3px); }
        70%  { transform: translateY(1px); }
        100% { transform: translateY(0); }
      }
    `;
    const styleEl = document.createElement('style');
    styleEl.id = 'p86-tank-styles';
    styleEl.textContent = css;
    document.head.appendChild(styleEl);
  }

  function tankSvg() {
    // 72x44 viewport. Origin at top-left.
    // Tank body: 8,30 to 64,40 (long box). Front sloped at right.
    // Treads: ellipses below the body.
    // Turret group (rotatable): turret base circle + barrel rect anchored at pivot (36,26).
    // Muzzle flash: orange burst centered at barrel tip (70,26 BEFORE rotation; we'll rely on
    // the barrel being at -15deg so we just place the flash relative to the unrotated barrel
    // tip — close enough visually for the brief animation).
    return (
      '<svg class="p86-tank-svg" viewBox="0 0 84 44" xmlns="http://www.w3.org/2000/svg">' +
        // Tread shadow / ground
        '<ellipse cx="36" cy="42" rx="34" ry="2.5" fill="rgba(0,0,0,0.30)"/>' +
        // Tread
        '<rect x="6" y="32" width="60" height="8" rx="4" fill="#2c2f36" stroke="rgba(255,255,255,0.18)" stroke-width="0.8"/>' +
        // Tread wheels
        '<circle cx="12" cy="36" r="2.8" fill="#1a1c20"/>' +
        '<circle cx="22" cy="36" r="2.8" fill="#1a1c20"/>' +
        '<circle cx="32" cy="36" r="2.8" fill="#1a1c20"/>' +
        '<circle cx="42" cy="36" r="2.8" fill="#1a1c20"/>' +
        '<circle cx="52" cy="36" r="2.8" fill="#1a1c20"/>' +
        '<circle cx="62" cy="36" r="2.8" fill="#1a1c20"/>' +
        // Hull (slope on right side)
        '<path d="M 10 30 L 56 30 L 64 24 L 64 32 L 10 32 Z" fill="#3a4049" stroke="rgba(255,255,255,0.18)" stroke-width="0.8"/>' +
        // Turret group — rotates around (36, 26)
        '<g class="p86-tank-turret-group">' +
          // Turret base
          '<ellipse cx="36" cy="26" rx="10" ry="5" fill="#4a5159" stroke="rgba(255,255,255,0.20)" stroke-width="0.8"/>' +
          '<circle cx="36" cy="24" r="1.2" fill="rgba(255,200,80,0.6)"/>' +
          // Barrel — extends to the right from the turret center
          '<rect x="36" y="24.4" width="34" height="3.2" rx="1.2" fill="#2a2e34" stroke="rgba(255,255,255,0.20)" stroke-width="0.6"/>' +
          // Barrel tip / muzzle brake
          '<rect x="68" y="23.4" width="3" height="5.2" rx="0.4" fill="#1a1c20"/>' +
          // Muzzle flash (positioned at the barrel tip)
          '<g class="p86-tank-muzzle-flash">' +
            '<circle cx="72" cy="26" r="4" fill="#ffcc44" opacity="0.85"/>' +
            '<circle cx="72" cy="26" r="2" fill="#fff7d6"/>' +
          '</g>' +
        '</g>' +
        // Tank insignia / 86 stamp
        '<text x="22" y="33" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="5" font-weight="700" fill="rgba(255,255,255,0.50)">86</text>' +
      '</svg>'
    );
  }

  function setState(el, state, message) {
    const previewMode = el.dataset.preview === '1';
    el.dataset.state = state;
    const title = el.querySelector('.p86-tank-title');
    const sub   = el.querySelector('.p86-tank-sub');
    const dismiss = el.querySelector('.p86-tank-dismiss');

    function setText(stateTitle, stateSub) {
      if (title) title.textContent = stateTitle;
      if (sub) sub.textContent = stateSub;
    }

    if (state === 'idle') {
      setText(
        previewMode ? 'Recon — dry run' : 'Ready to drop',
        message || (previewMode
          ? 'Drag a payload here — diff only, no commit.'
          : 'Drag a .p86.json payload here to apply.')
      );
      if (dismiss) dismiss.style.display = 'none';
    } else if (state === 'active') {
      setText(
        previewMode ? 'Lock for preview' : 'Target acquired',
        message || (previewMode ? 'Drop to preview impact.' : 'Drop to fire.')
      );
      if (dismiss) dismiss.style.display = 'none';
    } else if (state === 'applying') {
      setText(
        previewMode ? 'Recon away…' : 'Firing…',
        message || (previewMode ? 'Computing dry-run diff.' : 'Applying payload to targets.')
      );
      if (dismiss) dismiss.style.display = 'none';
    } else if (state === 'applied') {
      setText('✓ Direct hit', message || 'Applied.');
      if (dismiss) dismiss.style.display = '';
    } else if (state === 'failed') {
      setText('✗ Target lost', message || 'Apply failed.');
      if (dismiss) dismiss.style.display = '';
    }
  }

  async function applyPayload(payloadId, host) {
    const previewMode = host.dataset.preview === '1';
    setState(host, 'applying');
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
          setState(host, 'failed', 'Apply dispatcher not yet implemented (501).');
        } else if (r.status === 410) {
          setState(host, 'failed', 'Payload expired.');
        } else if (r.status === 409) {
          setState(host, 'failed', 'Payload already used.');
        } else if (r.status === 404) {
          setState(host, 'failed', 'Payload not found.');
        } else if (r.status === 422) {
          setState(host, 'failed', body.error || 'Validation failed.');
        } else {
          setState(host, 'failed', body.error || ('HTTP ' + r.status));
        }
        scheduleReset(host, 8000);
        return;
      }
      if (previewMode) {
        showPreviewModal(body, payloadId);
        setState(host, 'applied', 'Preview rendered — payload still ready.');
        scheduleReset(host, 6000);
        return;
      }
      const summary = body.apply_summary || ('Applied ' + (body.affected_targets || []).length + ' target(s).');
      setState(host, 'applied', summary);
      document.dispatchEvent(new CustomEvent('p86:payload-applied', {
        detail: {
          payload_id: payloadId,
          apply_summary: body.apply_summary,
          affected_targets: body.affected_targets || [],
        }
      }));
      if (window.PayloadArtifact && typeof window.PayloadArtifact.updateStatus === 'function') {
        window.PayloadArtifact.updateStatus(payloadId, 'applied', body.apply_summary);
      }
      scheduleReset(host, 10000);
    } catch (err) {
      console.error('[payload-dropbox] apply failed:', err);
      setState(host, 'failed', err && err.message || 'Apply failed');
      scheduleReset(host, 8000);
    }
  }

  function scheduleReset(host, ms) {
    clearTimeout(host._resetTimer);
    host._resetTimer = setTimeout(() => { setState(host, 'idle'); }, ms);
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
    } catch (_) { /* fall through */ }
    return null;
  }

  function isP86PayloadDrag(ev) {
    if (!ev.dataTransfer) return false;
    const types = Array.from(ev.dataTransfer.types || []);
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
          const id = parsed && (parsed.id || (parsed.meta && parsed.meta.id));
          if (!id) return reject(new Error('No payload id in file. Re-download from the AI panel.'));
          resolve(id);
        } catch (err) {
          reject(new Error('File parse failed: ' + err.message));
        }
      };
      reader.onerror = () => reject(reader.error || new Error('File read failed'));
      reader.readAsText(file);
    });
  }

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
    heading.textContent = '🔍 Recon preview — no changes applied';
    modal.appendChild(heading);

    const title = document.createElement('div');
    title.style.cssText = 'font-size:14px;font-weight:600;color:#fff;margin-bottom:12px;';
    title.textContent = body.apply_summary || 'No changes';
    modal.appendChild(title);

    const list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const targets = body.affected_targets || [];
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
    if (!targets.length) {
      const empty = document.createElement('div');
      empty.style.cssText = 'color:rgba(255,255,255,0.45);font-size:12px;';
      empty.textContent = 'No affected targets returned.';
      list.appendChild(empty);
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
        'color:rgba(255,255,255,0.65);margin-top:4px;white-space:pre-wrap;';
      refTbl.textContent = Object.entries(body.ref_resolutions)
        .map(([k, v]) => k + ' → ' + v).join('\n');
      modal.appendChild(refTbl);
    }

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    const esc = (ev) => { if (ev.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc); } };
    document.addEventListener('keydown', esc);
  }

  function mount(container, opts) {
    if (!container) {
      console.warn('[payload-dropbox] mount: no container');
      return null;
    }
    injectStylesOnce();

    const el = document.createElement('div');
    el.id = (opts && opts.id) || 'p86-universal-dropbox';
    el.className = 'p86-tank-host';
    el.dataset.state = 'idle';
    el.dataset.preview = '0';

    el.innerHTML =
      tankSvg() +
      '<div class="p86-tank-label-block">' +
        '<div class="p86-tank-title">Ready to drop</div>' +
        '<div class="p86-tank-sub">Drag a .p86.json payload here to apply.</div>' +
      '</div>' +
      '<div class="p86-tank-shell"></div>' +
      '<div class="p86-tank-explosion"></div>' +
      '<button type="button" class="p86-tank-mode-toggle" title="Preview mode — dry-run, no changes">🔍 Preview</button>' +
      '<button type="button" class="p86-tank-dismiss" title="Dismiss" style="display:none;">&times;</button>';

    const toggleBtn = el.querySelector('.p86-tank-mode-toggle');
    if (toggleBtn) {
      toggleBtn.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const next = el.dataset.preview === '1' ? '0' : '1';
        el.dataset.preview = next;
        if (next === '1') {
          toggleBtn.classList.add('is-on');
          toggleBtn.textContent = '🔍 Recon ON';
        } else {
          toggleBtn.classList.remove('is-on');
          toggleBtn.textContent = '🔍 Preview';
        }
        setState(el, 'idle');
      });
    }
    el.querySelector('.p86-tank-dismiss').addEventListener('click', (ev) => {
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
      if (ev.target !== el) return;
      if (el.dataset.state === 'active') setState(el, 'idle');
    });
    el.addEventListener('drop', async (ev) => {
      ev.preventDefault();
      const idFromDrag = extractPayloadId(ev);
      if (idFromDrag) {
        await applyPayload(idFromDrag, el);
        return;
      }
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

    // Cross-component hooks — surface "Target acquired" when an
    // artifact starts dragging anywhere in the panel/sidebar.
    document.addEventListener('p86:payload-drag-start', () => {
      if (el.dataset.state === 'idle') setState(el, 'active');
    });
    document.addEventListener('p86:payload-drag-end', () => {
      if (el.dataset.state === 'active') setState(el, 'idle');
    });

    container.appendChild(el);
    setState(el, 'idle');
    return el;
  }

  window.PayloadDropbox = { mount: mount };
})();
