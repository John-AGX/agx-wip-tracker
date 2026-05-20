// PayloadArtifact — renders a .p86.json file icon in the chat that the
// user can preview, download, or drag into the universal dropbox.
//
// Mounted inside the AI panel's message bubbles. One artifact per
// emitted payload row. The artifact carries the payload_id + file
// metadata; on dragstart it advertises BOTH MIME types so it works
// for in-app drag (dropbox reads x-p86-payload-id) AND OS-style drag
// (file content as application/vnd.p86.payload+json, downloadable as
// a real file via the GET /api/payloads/:id/file endpoint).
//
// Wired in by ai-panel.js when an emit_payload_file tool_applied SSE
// event arrives. Also rendered from the sidebar Payloads list when
// the user jumps to the original message via "view in chat".
//
// Public API (window.PayloadArtifact):
//   render(payload, container) → returns the rendered DOM node
//   updateStatus(payloadId, status, apply_summary?) → flips badge
//
// Cross-component signals dispatched on document:
//   'p86:payload-drag-start' { payload_id, filename, targets }
//   'p86:payload-drag-end'
//
// C2 scope: render + drag + preview toggle. Apply/Pin/Reject buttons
// are wired but POST to endpoints that may 501 until later commits.

(function () {
  'use strict';

  // Card styling shared across instances — keep visual cohesion with
  // existing approval cards in ai-panel.js. Dark theme aware (uses
  // CSS var --surface where the panel sets it).
  const CARD_CSS = {
    container:
      'border:1px solid rgba(255,255,255,0.10);background:rgba(255,255,255,0.03);' +
      'border-radius:10px;padding:12px 14px;margin:8px 0;font-size:12.5px;' +
      'color:#e6e6e6;display:flex;flex-direction:column;gap:8px;cursor:grab;' +
      'transition:background 0.15s, border-color 0.15s;user-select:none;',
    containerApplied:
      'border-color:rgba(46,204,113,0.45);background:rgba(46,204,113,0.06);',
    containerRejected:
      'border-color:rgba(231,76,60,0.35);background:rgba(231,76,60,0.05);opacity:0.7;',
    containerFailed:
      'border-color:rgba(231,76,60,0.45);background:rgba(231,76,60,0.08);',
    iconRow:
      'display:flex;align-items:center;gap:10px;',
    icon:
      'font-size:22px;line-height:1;flex-shrink:0;',
    titleBlock:
      'flex:1;min-width:0;',
    filename:
      'font-family:ui-monospace,Menlo,Consolas,monospace;font-size:11.5px;' +
      'color:rgba(255,255,255,0.92);word-break:break-all;line-height:1.3;',
    meta:
      'font-size:11px;color:rgba(255,255,255,0.55);margin-top:2px;',
    title:
      'font-size:13px;font-weight:600;color:#fff;margin-bottom:1px;',
    badge:
      'display:inline-block;padding:2px 7px;border-radius:10px;font-size:10.5px;' +
      'font-weight:600;letter-spacing:0.3px;text-transform:uppercase;',
    badgeReady:    'background:rgba(79,140,255,0.18);color:#9bbcff;',
    badgeApplied:  'background:rgba(46,204,113,0.22);color:#7ee2a5;',
    badgeRejected: 'background:rgba(231,76,60,0.20);color:#f0a59e;',
    badgeExpired:  'background:rgba(255,255,255,0.10);color:rgba(255,255,255,0.55);',
    badgeFailed:   'background:rgba(231,76,60,0.30);color:#ffb4ad;',
    rationale:
      'font-size:11.5px;color:rgba(255,255,255,0.62);line-height:1.4;' +
      'border-left:2px solid rgba(255,255,255,0.10);padding-left:8px;margin-top:2px;',
    actionsRow:
      'display:flex;gap:6px;flex-wrap:wrap;',
    btn:
      'background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.12);' +
      'color:#e6e6e6;border-radius:6px;padding:5px 10px;font-size:11.5px;' +
      'cursor:pointer;transition:background 0.12s, border-color 0.12s;',
    btnHover:
      'background:rgba(255,255,255,0.10);border-color:rgba(255,255,255,0.20);',
    preview:
      'background:rgba(0,0,0,0.25);border:1px solid rgba(255,255,255,0.05);' +
      'border-radius:6px;padding:10px 12px;font-family:ui-monospace,Menlo,' +
      'Consolas,monospace;font-size:11px;color:rgba(255,255,255,0.78);' +
      'line-height:1.55;max-height:280px;overflow:auto;white-space:pre-wrap;',
  };

  function statusBadge(status) {
    const tag = document.createElement('span');
    tag.style.cssText = CARD_CSS.badge + ' ' + (
      status === 'applied'  ? CARD_CSS.badgeApplied  :
      status === 'rejected' ? CARD_CSS.badgeRejected :
      status === 'expired'  ? CARD_CSS.badgeExpired  :
      status === 'failed'   ? CARD_CSS.badgeFailed   :
                              CARD_CSS.badgeReady
    );
    tag.textContent = status || 'ready';
    return tag;
  }

  function btn(label, onClick, opts = {}) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = label;
    b.style.cssText = CARD_CSS.btn;
    b.onmouseenter = () => { b.style.cssText = CARD_CSS.btn + CARD_CSS.btnHover; };
    b.onmouseleave = () => { b.style.cssText = CARD_CSS.btn; };
    b.onclick = (ev) => { ev.stopPropagation(); onClick(ev); };
    if (opts.title) b.title = opts.title;
    return b;
  }

  function formatSize(content) {
    try {
      const bytes = new Blob([JSON.stringify(content || {})]).size;
      if (bytes < 1024) return bytes + 'B';
      if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + 'KB';
      return (bytes / 1024 / 1024).toFixed(2) + 'MB';
    } catch (_) { return '?'; }
  }

  function countTargets(targets) {
    if (!Array.isArray(targets)) return 0;
    return targets.length;
  }

  function summarizeOps(targets) {
    if (!Array.isArray(targets)) return '';
    const lines = [];
    targets.forEach((t, i) => {
      const head =
        '#' + (i + 1) + ' ' +
        (t.entity_type || '?') +
        (t.entity_id ? (' ' + t.entity_id) : ' (new)') +
        (t.entity_display ? '\n    ' + t.entity_display : '');
      const opKeys = t.ops && typeof t.ops === 'object' ? Object.keys(t.ops) : [];
      const opSummary = opKeys.length
        ? opKeys.map((k) => '    • ' + k).join('\n')
        : '    (no ops)';
      lines.push(head + '\n' + opSummary);
    });
    return lines.join('\n\n');
  }

  function statusCardCss(status) {
    if (status === 'applied')  return CARD_CSS.container + CARD_CSS.containerApplied;
    if (status === 'rejected') return CARD_CSS.container + CARD_CSS.containerRejected;
    if (status === 'failed')   return CARD_CSS.container + CARD_CSS.containerFailed;
    return CARD_CSS.container;
  }

  function render(payload, container) {
    if (!payload || !payload.id) {
      console.warn('[payload-artifact] render: missing payload.id', payload);
      return null;
    }
    const card = document.createElement('div');
    card.className = 'p86-payload-artifact';
    card.dataset.payloadId = payload.id;
    card.dataset.status = payload.status || 'ready';
    card.style.cssText = statusCardCss(payload.status);
    card.draggable = (payload.status || 'ready') === 'ready';

    // Drag plumbing — advertise both MIME types so dropbox + OS drag work.
    card.addEventListener('dragstart', (ev) => {
      if (card.dataset.status !== 'ready') {
        ev.preventDefault();
        return;
      }
      try {
        const dragMeta = {
          payload_id: payload.id,
          filename: payload.filename,
          targets: payload.targets,
        };
        ev.dataTransfer.setData('application/x-p86-payload-id', payload.id);
        ev.dataTransfer.setData('application/x-p86-payload', JSON.stringify(dragMeta));
        // Also expose the full file content as a draggable OS-style file.
        // The dropbox prefers x-p86-payload-id when both are present; OS
        // drag-out into Finder/Explorer would use the JSON serialization.
        ev.dataTransfer.setData(
          'application/vnd.p86.payload+json',
          JSON.stringify(payload.file_content || {})
        );
        ev.dataTransfer.effectAllowed = 'copy';
        card.style.opacity = '0.6';
        document.dispatchEvent(new CustomEvent('p86:payload-drag-start', { detail: dragMeta }));
      } catch (err) {
        console.error('[payload-artifact] dragstart failed:', err);
      }
    });
    card.addEventListener('dragend', () => {
      card.style.opacity = '1';
      document.dispatchEvent(new CustomEvent('p86:payload-drag-end'));
    });

    // Top row: icon + filename/title + status badge
    const iconRow = document.createElement('div');
    iconRow.style.cssText = CARD_CSS.iconRow;

    const icon = document.createElement('div');
    icon.style.cssText = CARD_CSS.icon;
    icon.textContent = '📄'; // 📄
    iconRow.appendChild(icon);

    const titleBlock = document.createElement('div');
    titleBlock.style.cssText = CARD_CSS.titleBlock;
    if (payload.title) {
      const t = document.createElement('div');
      t.style.cssText = CARD_CSS.title;
      t.textContent = payload.title;
      titleBlock.appendChild(t);
    }
    const fname = document.createElement('div');
    fname.style.cssText = CARD_CSS.filename;
    fname.textContent = payload.filename || ('payload-' + payload.id + '.p86.json');
    titleBlock.appendChild(fname);
    const meta = document.createElement('div');
    meta.style.cssText = CARD_CSS.meta;
    const targetCount = countTargets(payload.targets);
    meta.textContent =
      targetCount + ' target' + (targetCount === 1 ? '' : 's') +
      ' · ' + formatSize(payload.file_content) +
      (payload.source ? ' · ' + payload.source : '');
    titleBlock.appendChild(meta);
    iconRow.appendChild(titleBlock);

    iconRow.appendChild(statusBadge(payload.status || 'ready'));

    card.appendChild(iconRow);

    // Summary line (one-liner from the bundle)
    if (payload.summary) {
      const s = document.createElement('div');
      s.style.cssText = 'font-size:12px;color:rgba(255,255,255,0.78);';
      s.textContent = payload.summary;
      card.appendChild(s);
    }

    // Rationale (small, italic-ish quote block)
    if (payload.rationale) {
      const r = document.createElement('div');
      r.style.cssText = CARD_CSS.rationale;
      r.textContent = 'Rationale: ' + payload.rationale;
      card.appendChild(r);
    }

    // Apply summary on applied rows
    if (payload.status === 'applied' && payload.apply_summary) {
      const a = document.createElement('div');
      a.style.cssText = CARD_CSS.rationale;
      a.textContent = '✓ ' + payload.apply_summary;
      card.appendChild(a);
    }
    if (payload.status === 'failed' && payload.apply_error) {
      const e = document.createElement('div');
      e.style.cssText = CARD_CSS.rationale;
      e.style.borderLeftColor = 'rgba(231,76,60,0.7)';
      e.style.color = 'rgba(255,180,173,0.85)';
      e.textContent = '✗ ' + payload.apply_error;
      card.appendChild(e);
    }

    // Expandable preview block
    const preview = document.createElement('pre');
    preview.style.cssText = CARD_CSS.preview;
    preview.style.display = 'none';
    preview.textContent = summarizeOps(payload.targets);
    card.appendChild(preview);

    // Action row
    const actions = document.createElement('div');
    actions.style.cssText = CARD_CSS.actionsRow;

    actions.appendChild(btn('⏷ Preview', () => {
      preview.style.display = preview.style.display === 'none' ? 'block' : 'none';
    }, { title: 'Show targets and ops' }));

    actions.appendChild(btn('↓ Download', () => {
      const url = '/api/payloads/' + encodeURIComponent(payload.id) + '/file';
      const a = document.createElement('a');
      a.href = url;
      a.download = payload.filename || ('payload-' + payload.id + '.p86.json');
      document.body.appendChild(a);
      a.click();
      a.remove();
    }, { title: 'Download .p86.json' }));

    // Pin-as-Recipe is wired in C11. Show the button now so the UX is
    // discoverable; clicks just toast for now.
    actions.appendChild(btn('📌 Pin as Recipe', () => {
      window.alert('Pin as Recipe lands in C11.');
    }, { title: 'Save this payload as a reusable recipe (C11)' }));

    // Reject is wired now — POST /api/payloads/:id/reject is live.
    if ((payload.status || 'ready') === 'ready') {
      actions.appendChild(btn('Reject', async () => {
        if (!window.confirm('Reject this payload? It will be marked dismissed.')) return;
        try {
          const r = await fetch('/api/payloads/' + encodeURIComponent(payload.id) + '/reject', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/json' },
          });
          if (!r.ok) throw new Error('Reject failed: HTTP ' + r.status);
          updateStatus(payload.id, 'rejected');
        } catch (err) {
          console.error('[payload-artifact] reject:', err);
          window.alert('Reject failed: ' + (err && err.message || err));
        }
      }, { title: 'Dismiss this payload' }));
    }

    card.appendChild(actions);

    if (container && typeof container.appendChild === 'function') {
      container.appendChild(card);
    }
    return card;
  }

  function updateStatus(payloadId, status, applySummary) {
    const cards = document.querySelectorAll(
      '.p86-payload-artifact[data-payload-id="' + payloadId + '"]'
    );
    cards.forEach((card) => {
      card.dataset.status = status;
      card.draggable = status === 'ready';
      card.style.cssText = statusCardCss(status);
      // Update the badge in place (last child of iconRow).
      const iconRow = card.firstChild;
      if (iconRow && iconRow.lastChild && iconRow.lastChild.classList && iconRow.lastChild.classList.length === 0) {
        // Re-render badge by replacing the last child of iconRow.
        const newBadge = statusBadge(status);
        iconRow.replaceChild(newBadge, iconRow.lastChild);
      }
      // Append apply_summary if newly applied.
      if (status === 'applied' && applySummary) {
        const existing = card.querySelector('.p86-apply-summary');
        if (!existing) {
          const a = document.createElement('div');
          a.className = 'p86-apply-summary';
          a.style.cssText = CARD_CSS.rationale;
          a.textContent = '✓ ' + applySummary;
          card.appendChild(a);
        }
      }
    });
  }

  window.PayloadArtifact = { render: render, updateStatus: updateStatus };
})();
