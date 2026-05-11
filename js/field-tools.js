// Field Tools — UI for the "Tools" tab. Lists every saved field tool
// (calculators, lookups, forms), renders the selected one in a
// sandboxed iframe modal, and supports add/edit/delete via a small
// composer dialog.
//
// 86 can create field tools via propose_create_field_tool (approval-
// tier); this UI is the surface where the team uses them in the
// field.
(function() {
  'use strict';

  function escapeHTML(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function fmtSize(bytes) {
    if (bytes == null) return '';
    var n = Number(bytes);
    if (!isFinite(n)) return '';
    return Math.ceil(n / 1024) + ' KB';
  }

  function fmtDate(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleDateString(); } catch (e) { return ''; }
  }

  function renderEmpty(host) {
    host.innerHTML =
      '<div style="padding:18px;border:1px dashed #2a2a2a;border-radius:8px;text-align:center;color:var(--text-dim,#888);">' +
        '<div style="font-size:14px;margin-bottom:6px;">No field tools yet.</div>' +
        '<div style="font-size:12px;color:#666;margin-bottom:14px;">' +
          'Ask 86 to spin one up (e.g. "save a pressure-wash labor calculator") or paste HTML directly below.' +
        '</div>' +
        '<button type="button" class="ee-btn primary" onclick="window.openFieldToolComposer && window.openFieldToolComposer()">+ Add tool</button>' +
      '</div>';
  }

  function loadList() {
    var host = document.getElementById('field-tools-view');
    if (!host) return;
    host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);font-size:13px;">Loading tools…</div>';

    if (!window.p86Api || !window.p86Api.get) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;">API not available.</div>';
      return;
    }

    window.p86Api.get('/api/field-tools').then(function(resp) {
      var rows = (resp && resp.tools) || [];

      var headerHtml =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px;">' +
          '<div>' +
            '<h2 style="margin:0;font-size:18px;font-weight:600;">Field Tools</h2>' +
            '<div style="font-size:12px;color:var(--text-dim,#888);margin-top:2px;">' +
              'Self-contained utilities the team uses on phones. 86 can spin them up on demand.' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button type="button" class="ee-btn secondary" onclick="window.refreshFieldTools && window.refreshFieldTools()">↻ Refresh</button>' +
            '<button type="button" class="ee-btn primary" onclick="window.openFieldToolComposer && window.openFieldToolComposer()">+ Add tool</button>' +
          '</div>' +
        '</div>';

      if (!rows.length) {
        host.innerHTML = headerHtml;
        renderEmpty(host.querySelector('#field-tools-empty') || (function() {
          var d = document.createElement('div'); d.id = 'field-tools-empty'; host.appendChild(d); return d;
        })());
        return;
      }

      var gridHtml = '<div id="field-tools-grid" style="display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:12px;">';
      rows.forEach(function(t) {
        var cat = t.category ? '<span style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#f5a623;border:1px solid rgba(245,166,35,0.4);padding:2px 6px;border-radius:3px;">' + escapeHTML(t.category) + '</span>' : '';
        var desc = t.description ? '<div style="font-size:12px;color:var(--text-dim,#888);margin-top:6px;line-height:1.4;">' + escapeHTML(t.description) + '</div>' : '';
        gridHtml +=
          '<div style="background:#141414;border:1px solid #222;border-radius:6px;padding:14px;display:flex;flex-direction:column;gap:8px;">' +
            '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:8px;">' +
              '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(t.name) + '</div>' +
              cat +
            '</div>' +
            desc +
            '<div style="font-size:10px;color:#555;margin-top:auto;">' +
              fmtSize(t.html_size) + ' · updated ' + escapeHTML(fmtDate(t.updated_at)) +
            '</div>' +
            '<div style="display:flex;gap:6px;margin-top:6px;">' +
              '<button type="button" class="ee-btn primary" style="flex:1;" onclick="window.openFieldTool && window.openFieldTool(\'' + escapeAttr(t.id) + '\')">Open</button>' +
              '<button type="button" class="ee-btn secondary" onclick="window.editFieldTool && window.editFieldTool(\'' + escapeAttr(t.id) + '\')" title="Edit">✎</button>' +
              '<button type="button" class="ee-btn secondary" onclick="window.deleteFieldTool && window.deleteFieldTool(\'' + escapeAttr(t.id) + '\', \'' + escapeAttr(t.name) + '\')" title="Delete">×</button>' +
            '</div>' +
          '</div>';
      });
      gridHtml += '</div>';

      host.innerHTML = headerHtml + gridHtml;
    }).catch(function(err) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;">Failed to load: ' + escapeHTML(err && err.message || 'unknown') + '</div>';
    });
  }

  // Render the selected tool in a full-screen iframe modal. Sandbox
  // attribute restricts the tool's JS — no top-frame access, no form
  // submit to parent origin, no popups. allow-scripts is the one
  // permission we grant so the calculator's JS can actually run.
  window.openFieldTool = function(id) {
    if (!id) return;
    window.p86Api.get('/api/field-tools/' + encodeURIComponent(id)).then(function(resp) {
      if (!resp || !resp.tool) { alert('Tool not found.'); return; }
      var t = resp.tool;
      var modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;z-index:9999;';
      modal.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#0a0a0a;border-bottom:1px solid #222;">' +
          '<div>' +
            '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(t.name) + '</div>' +
            (t.description ? '<div style="font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(t.description) + '</div>' : '') +
          '</div>' +
          '<button type="button" class="ee-btn secondary" onclick="this.closest(\'.field-tool-modal\').remove()">Close</button>' +
        '</div>' +
        '<iframe sandbox="allow-scripts" style="flex:1;width:100%;border:0;background:#0f0f0f;"></iframe>';
      modal.classList.add('field-tool-modal');
      document.body.appendChild(modal);
      var iframe = modal.querySelector('iframe');
      // Inject the HTML via srcdoc — sandboxed iframe has no same-
      // origin context. srcdoc keeps it offline-safe (no network).
      iframe.srcdoc = t.html_body || '';
    }).catch(function(err) {
      alert('Failed to open tool: ' + (err && err.message || 'unknown'));
    });
  };

  // Composer modal — used for both "Add" (no id) and "Edit" (id passed).
  window.openFieldToolComposer = function(existingId) {
    var existing = null;
    var promise = existingId
      ? window.p86Api.get('/api/field-tools/' + encodeURIComponent(existingId)).then(function(r) { existing = r && r.tool; })
      : Promise.resolve();
    promise.then(function() {
      var modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:9999;padding:20px;';
      var t = existing || {};
      var title = existingId ? 'Edit field tool' : '+ Add field tool';
      modal.innerHTML =
        '<div style="background:#141414;border:1px solid #222;border-radius:8px;padding:20px;width:760px;max-width:95vw;max-height:90vh;display:flex;flex-direction:column;gap:10px;">' +
          '<h3 style="margin:0;font-size:16px;color:var(--text,#fff);">' + escapeHTML(title) + '</h3>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:1px;">Name' +
            '<input type="text" id="ft-name" maxlength="200" value="' + escapeAttr(t.name) + '" style="padding:8px;border-radius:4px;border:1px solid #333;background:#0a0a0a;color:#e8e0d0;font-size:13px;">' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:1px;">Description' +
            '<input type="text" id="ft-desc" maxlength="500" value="' + escapeAttr(t.description) + '" placeholder="One-line summary (optional)" style="padding:8px;border-radius:4px;border:1px solid #333;background:#0a0a0a;color:#e8e0d0;font-size:13px;">' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:1px;">Category' +
            '<select id="ft-cat" style="padding:8px;border-radius:4px;border:1px solid #333;background:#0a0a0a;color:#e8e0d0;font-size:13px;">' +
              '<option value="">— none —</option>' +
              ['calculator', 'lookup', 'form', 'other'].map(function(c) {
                var sel = (t.category === c) ? ' selected' : '';
                return '<option value="' + c + '"' + sel + '>' + c + '</option>';
              }).join('') +
            '</select>' +
          '</label>' +
          '<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:1px;flex:1;min-height:0;">HTML body (full document)' +
            '<textarea id="ft-html" style="flex:1;min-height:300px;padding:10px;border-radius:4px;border:1px solid #333;background:#0a0a0a;color:#e8e0d0;font-size:11px;font-family:\'SF Mono\',ui-monospace,monospace;resize:vertical;" placeholder="<!DOCTYPE html>&#10;<html>&#10;<head><style>...</style></head>&#10;<body>&#10;<script>...</script>&#10;</body>&#10;</html>">' + escapeHTML(t.html_body || '') + '</textarea>' +
          '</label>' +
          '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
            '<button type="button" id="ft-cancel" class="ee-btn secondary">Cancel</button>' +
            '<button type="button" id="ft-save" class="ee-btn primary">' + (existingId ? 'Save changes' : 'Create') + '</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      var cancel = function() { modal.remove(); };
      modal.querySelector('#ft-cancel').onclick = cancel;
      modal.onclick = function(e) { if (e.target === modal) cancel(); };
      modal.querySelector('#ft-save').onclick = function() {
        var name = (modal.querySelector('#ft-name').value || '').trim();
        var desc = (modal.querySelector('#ft-desc').value || '').trim();
        var cat = (modal.querySelector('#ft-cat').value || '').trim() || null;
        var html = (modal.querySelector('#ft-html').value || '').trim();
        if (!name) { alert('Name is required.'); return; }
        if (!html) { alert('HTML body is required.'); return; }
        var payload = { name: name, description: desc || null, category: cat, html_body: html };
        var req = existingId
          ? window.p86Api.put('/api/field-tools/' + encodeURIComponent(existingId), payload)
          : window.p86Api.post('/api/field-tools', payload);
        var btn = modal.querySelector('#ft-save');
        btn.disabled = true;
        btn.textContent = 'Saving…';
        req.then(function() {
          cancel();
          loadList();
        }).catch(function(err) {
          btn.disabled = false;
          btn.textContent = existingId ? 'Save changes' : 'Create';
          alert('Save failed: ' + (err && err.message || 'unknown'));
        });
      };
    });
  };

  window.editFieldTool = function(id) {
    if (!id) return;
    window.openFieldToolComposer(id);
  };

  window.deleteFieldTool = function(id, name) {
    if (!id) return;
    if (!confirm('Delete field tool "' + name + '"?\n\nThis is irreversible.')) return;
    window.p86Api.del('/api/field-tools/' + encodeURIComponent(id)).then(function() {
      loadList();
    }).catch(function(err) {
      alert('Delete failed: ' + (err && err.message || 'unknown'));
    });
  };

  window.refreshFieldTools = function() { loadList(); };

  // Expose a one-call entry point for the tab switcher. Mirrors the
  // pattern other tabs use (renderJobsList, renderClientsTab, etc.).
  window.renderFieldToolsTab = function() { loadList(); };

})();
