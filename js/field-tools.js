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

  // Track the host element so refresh + composer-close can re-render
  // into the same DOM slot whether we're on a standalone Tools tab or
  // embedded in the My Files page.
  var _currentHost = null;

  function loadList(hostOverride) {
    var host = hostOverride || _currentHost || document.getElementById('field-tools-view');
    if (!host) return;
    _currentHost = host;
    host.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);font-size:13px;">Loading tools…</div>';

    if (!window.p86Api || !window.p86Api.get) {
      host.innerHTML = '<div style="padding:20px;color:#e74c3c;">API not available.</div>';
      return;
    }

    window.p86Api.get('/api/field-tools').then(function(resp) {
      var rows = (resp && resp.tools) || [];

      var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
      var isAdmin = !!(me && ['admin', 'corporate', 'system_admin', 'owner'].indexOf(me.role) !== -1);

      var headerHtml =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:14px;flex-wrap:wrap;">' +
          '<div>' +
            '<h2 style="margin:0;font-size:18px;font-weight:600;">Field Tools</h2>' +
            '<div style="font-size:12px;color:var(--text-dim,#888);margin-top:2px;">' +
              'Self-contained utilities the team uses on phones. ⭐ = Project 86 system tool.' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:8px;">' +
            '<button type="button" class="ee-btn secondary" onclick="window.refreshFieldTools && window.refreshFieldTools()">↻ Refresh</button>' +
            (isAdmin ? '<button type="button" class="ee-btn secondary" onclick="window.openSystemToolPicker && window.openSystemToolPicker()">⭐ System tools</button>' : '') +
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

  // ─── Auto-instrument script ────────────────────────────────────
  // Injected into every field tool's iframe srcdoc before render.
  // Sniffs <input>/<select>/<textarea> values + any element tagged
  // with [data-ft-output] (or class/id matching result|output|total|
  // sum|cost|sqft|hours heuristic) and posts a snapshot to the
  // parent on every input/change event + after any button click.
  //
  // This makes printouts work zero-config for tools that don't
  // explicitly call postMessage. Tools that DO call postMessage
  // override the auto-snapshot (same message type, parent keeps the
  // most-recent payload). Marked with `_auto: true` so the Save
  // Printout dialog can drop the "no data captured" warning.
  var FT_AUTO_INSTRUMENT_SRC =
'(function(){' +
  'if(window.__p86FtAuto)return;window.__p86FtAuto=true;' +
  'function labelFor(el){' +
    'if(el.id){var lab=document.querySelector(\'label[for="\'+el.id+\'"]\');if(lab&&lab.textContent.trim())return lab.textContent.trim().replace(/[:*]\\s*$/,"");}' +
    'var p=el.closest&&el.closest("label");' +
    'if(p){var c=p.cloneNode(true);Array.prototype.forEach.call(c.querySelectorAll("input,select,textarea,button"),function(n){n.remove();});var t=c.textContent.trim().replace(/[:*]\\s*$/,"");if(t)return t;}' +
    'return el.name||el.id||el.placeholder||"field";' +
  '}' +
  'function readVal(el){' +
    'if(el.type==="checkbox")return el.checked;' +
    'if(el.type==="radio")return el.checked?el.value:null;' +
    'return el.value;' +
  '}' +
  'function snapshot(){' +
    'var inputs={},outputs={},seen={};' +
    'Array.prototype.forEach.call(document.querySelectorAll("input,select,textarea"),function(el){' +
      'if(el.type==="submit"||el.type==="button"||el.type==="reset"||el.type==="hidden")return;' +
      'if(el.type==="radio"&&!el.checked)return;' +
      'var k=labelFor(el),b=k,n=2;while(seen[k]){k=b+" ("+(n++)+")";}seen[k]=true;' +
      'var v=readVal(el);if(v==null||v==="")return;' +
      'inputs[k]=v;' +
    '});' +
    'Array.prototype.forEach.call(document.querySelectorAll("[data-ft-output]"),function(el){' +
      'var k=el.getAttribute("data-ft-output")||el.id||"output";' +
      'var v=(el.value!==undefined&&el.value!=="")?el.value:(el.textContent||"").trim();' +
      'if(v)outputs[k]=v;' +
    '});' +
    'if(Object.keys(outputs).length===0){' +
      'var rx=/result|output|total|sum|cost|gallons|hours|sqft|amount|estimate|labor|price/i;' +
      'Array.prototype.forEach.call(document.querySelectorAll("[id],[class]"),function(el){' +
        'var sig=(el.id||"")+" "+(el.className||"");if(!rx.test(sig))return;' +
        'var tag=el.tagName.toLowerCase();' +
        'if(["input","button","form","label","select","textarea","script","style","html","body"].indexOf(tag)!==-1)return;' +
        'if(el.children.length>3)return;' +
        'var v=(el.textContent||"").trim();' +
        'if(v&&v.length<200){var key=el.id||(el.className||"output").split(/\\s+/)[0];outputs[key]=v;}' +
      '});' +
    '}' +
    'return{inputs:inputs,outputs:outputs};' +
  '}' +
  'var lastSent=null;' +
  'function post(){' +
    'try{' +
      'var s=snapshot();var j=JSON.stringify(s);if(j===lastSent)return;lastSent=j;' +
      'window.parent.postMessage({type:"p86-field-tool-result",inputs:s.inputs,outputs:s.outputs,_auto:true},"*");' +
    '}catch(e){}' +
  '}' +
  'var t=null;function debounced(){if(t)clearTimeout(t);t=setTimeout(post,250);}' +
  'document.addEventListener("input",debounced,true);' +
  'document.addEventListener("change",debounced,true);' +
  'document.addEventListener("click",function(e){' +
    'if(e.target&&e.target.closest&&e.target.closest(\'button,[role="button"],input[type="button"],input[type="submit"]\')){setTimeout(post,120);}' +
  '},true);' +
  'if(document.readyState==="loading"){document.addEventListener("DOMContentLoaded",function(){setTimeout(post,80);});}' +
  'else{setTimeout(post,80);}' +
'})();';

  // Inject the auto-instrumenter into a tool's HTML body so even
  // tools that don't call postMessage explicitly can be captured.
  // Strategy: append a <script> tag right before </body> (case-
  // insensitive), or at the end of the document if no body tag.
  function instrumentHtml(html) {
    var script = '\n<script>/*p86-field-tool-auto*/' + FT_AUTO_INSTRUMENT_SRC + '</script>\n';
    if (/<\/body>/i.test(html)) {
      return html.replace(/<\/body>/i, script + '</body>');
    }
    return html + script;
  }

  // Render the selected tool in a full-screen iframe modal. Sandbox
  // attribute restricts the tool's JS — no top-frame access, no form
  // submit to parent origin, no popups. allow-scripts is the one
  // permission we grant so the calculator's JS can actually run.
  //
  // PRINTOUTS — postMessage contract for tool authors:
  //   Any tool can post back a snapshot of its current state at any
  //   moment by calling, from inside the iframe:
  //
  //     window.parent.postMessage({
  //       type: 'p86-field-tool-result',
  //       inputs:  { /* whatever the user typed/picked, key:value */ },
  //       outputs: { /* whatever the tool computed, key:value */ }
  //     }, '*');
  //
  //   The parent caches the LATEST payload per modal. When the user
  //   clicks "Save Printout" in the modal chrome, we POST that cached
  //   payload to /api/field-tools/runs along with the field_tool_id +
  //   any notes the user typed in the save dialog. Tools that don't
  //   opt in get auto-instrumented (see FT_AUTO_INSTRUMENT_SRC above)
  //   so most printouts work zero-config.
  //
  //   Tools should re-post on every meaningful state change (input
  //   blur, calculate-button click) — we only keep the most recent
  //   message, so stale posts are harmless.
  //
  //   Tools opting in can also mark their result elements with
  //   [data-ft-output="label"] to give the auto-instrumenter clean
  //   keys without needing a full postMessage block.
  window.openFieldTool = function(id) {
    if (!id) return;
    window.p86Api.get('/api/field-tools/' + encodeURIComponent(id)).then(function(resp) {
      if (!resp || !resp.tool) { alert('Tool not found.'); return; }
      var t = resp.tool;
      var modal = document.createElement('div');
      modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;flex-direction:column;z-index:9999;';
      modal.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;padding:10px 14px;background:#0a0a0a;border-bottom:1px solid #222;">' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(t.name) + '</div>' +
            (t.description ? '<div style="font-size:11px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(t.description) + '</div>' : '') +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            '<button type="button" class="ee-btn primary ft-save-printout" title="Save a printout of the current inputs + outputs">' +
              '<span style="font-size:13px;">💾</span> Save Printout' +
            '</button>' +
            '<button type="button" class="ee-btn secondary ft-close">Close</button>' +
          '</div>' +
        '</div>' +
        '<iframe sandbox="allow-scripts" style="flex:1;width:100%;border:0;background:#0f0f0f;"></iframe>';
      modal.classList.add('field-tool-modal');
      document.body.appendChild(modal);
      var iframe = modal.querySelector('iframe');
      // Inject the HTML via srcdoc — sandboxed iframe has no same-
      // origin context. srcdoc keeps it offline-safe (no network).
      // We also inject the auto-instrumenter so tools that haven't
      // wired postMessage still produce printout data automatically.
      iframe.srcdoc = instrumentHtml(t.html_body || '');

      // Cache the latest payload posted from inside the iframe so
      // Save Printout can snapshot it on click. We accept ANY
      // postMessage that comes through (sandboxed iframes can only
      // talk to their direct parent), filter by the agreed type, and
      // ignore everything else.
      //
      // explicitPayload wins over autoPayload — if the tool both
      // posts explicitly AND gets auto-instrumented, the explicit
      // post is the source of truth.
      var explicitPayload = null;
      var autoPayload = null;
      function onMessage(ev) {
        // Verify the source is OUR iframe before trusting the payload.
        // Other postMessage chatter (extensions, embedded iframes
        // elsewhere on the page) shouldn't be able to spoof results.
        if (ev.source !== iframe.contentWindow) return;
        var d = ev.data || {};
        if (d && d.type === 'p86-field-tool-result') {
          var p = {
            inputs: (d.inputs && typeof d.inputs === 'object') ? d.inputs : {},
            outputs: (d.outputs && typeof d.outputs === 'object') ? d.outputs : {}
          };
          if (d._auto) autoPayload = p;
          else explicitPayload = p;
        }
      }
      window.addEventListener('message', onMessage);
      function latestPayload() { return explicitPayload || autoPayload; }

      function closeModal() {
        window.removeEventListener('message', onMessage);
        modal.remove();
      }
      modal.querySelector('.ft-close').addEventListener('click', closeModal);

      modal.querySelector('.ft-save-printout').addEventListener('click', function() {
        openSavePrintoutDialog(t, latestPayload(), function() {
          // Successful save — leave the modal open so the user can
          // keep iterating; the receipt is reachable from My Files →
          // Printouts.
        });
      });
    }).catch(function(err) {
      alert('Failed to open tool: ' + (err && err.message || 'unknown'));
    });
  };

  // Save-printout dialog. Shows what was captured + a Notes field +
  // Save/Cancel. If nothing was captured we still let the user save
  // a notes-only record (handy as a quick "I used this tool here"
  // receipt even if the tool author hasn't wired postMessage).
  function openSavePrintoutDialog(tool, payload, onSaved) {
    var inputs = (payload && payload.inputs) || {};
    var outputs = (payload && payload.outputs) || {};
    var hasInputs = Object.keys(inputs).length > 0;
    var hasOutputs = Object.keys(outputs).length > 0;
    var hasAny = hasInputs || hasOutputs;

    var modal = document.createElement('div');
    modal.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.85);display:flex;align-items:center;justify-content:center;z-index:10000;padding:20px;';
    modal.innerHTML =
      '<div style="background:#141414;border:1px solid #222;border-radius:8px;padding:20px;width:560px;max-width:95vw;max-height:90vh;overflow:auto;display:flex;flex-direction:column;gap:12px;">' +
        '<h3 style="margin:0;font-size:16px;color:var(--text,#fff);">Save printout — ' + escapeHTML(tool.name) + '</h3>' +
        (hasAny
          ? '<div style="font-size:12px;color:var(--text-dim,#888);">These values will be saved to My Files → Printouts.</div>'
          : '<div style="font-size:12px;color:#f5a623;border:1px solid rgba(245,166,35,0.4);background:rgba(245,166,35,0.06);padding:8px;border-radius:4px;">' +
              'No data captured. This tool hasn\'t opted into the postMessage contract — you can still save a notes-only record.' +
            '</div>') +
        (hasInputs ? buildKVTable('Inputs', inputs) : '') +
        (hasOutputs ? buildKVTable('Outputs', outputs) : '') +
        '<label style="display:flex;flex-direction:column;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:1px;">Notes (optional)' +
          '<textarea id="ft-printout-notes" maxlength="2000" rows="3" placeholder="What was this for? Job name, address, anything to remember." style="padding:8px;border-radius:4px;border:1px solid #333;background:#0a0a0a;color:#e8e0d0;font-size:13px;resize:vertical;"></textarea>' +
        '</label>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;">' +
          '<button type="button" id="ft-printout-cancel" class="ee-btn secondary">Cancel</button>' +
          '<button type="button" id="ft-printout-save" class="ee-btn primary">Save printout</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    var cancel = function() { modal.remove(); };
    modal.querySelector('#ft-printout-cancel').onclick = cancel;
    modal.onclick = function(e) { if (e.target === modal) cancel(); };
    modal.querySelector('#ft-printout-save').onclick = function() {
      var notes = (modal.querySelector('#ft-printout-notes').value || '').trim();
      var btn = modal.querySelector('#ft-printout-save');
      btn.disabled = true;
      btn.textContent = 'Saving…';
      window.p86Api.post('/api/field-tools/runs', {
        field_tool_id: tool.id,
        inputs: inputs,
        outputs: outputs,
        notes: notes || null
      }).then(function(resp) {
        modal.remove();
        if (typeof onSaved === 'function') onSaved(resp && resp.run);
        // Light toast — keep parity with other inline save flows.
        if (window.p86Toast && typeof window.p86Toast.show === 'function') {
          window.p86Toast.show('Printout saved. Find it under My Files → Printouts.');
        }
      }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Save printout';
        alert('Save failed: ' + (err && err.message || 'unknown'));
      });
    };
  }

  // Renders a small two-col table of key:value pairs for the
  // confirmation dialog. Numbers/booleans render as-is; objects
  // collapse to JSON for safety.
  function buildKVTable(label, obj) {
    var rows = Object.keys(obj).map(function(k) {
      var v = obj[k];
      var disp;
      if (v == null) disp = '—';
      else if (typeof v === 'object') disp = JSON.stringify(v);
      else disp = String(v);
      return '<tr>' +
        '<td style="padding:4px 8px;color:var(--text-dim,#888);font-size:12px;border-bottom:1px solid #1f1f1f;white-space:nowrap;">' + escapeHTML(k) + '</td>' +
        '<td style="padding:4px 8px;color:var(--text,#e8e0d0);font-size:12px;border-bottom:1px solid #1f1f1f;">' + escapeHTML(disp) + '</td>' +
      '</tr>';
    }).join('');
    return '<div>' +
      '<div style="font-size:10px;text-transform:uppercase;letter-spacing:1px;color:#888;margin-bottom:4px;">' + escapeHTML(label) + '</div>' +
      '<table style="width:100%;border-collapse:collapse;background:#0a0a0a;border:1px solid #222;border-radius:4px;overflow:hidden;">' + rows + '</table>' +
    '</div>';
  }

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

  // Render the field tools grid into an arbitrary host element. Used
  // by my-files.js when the virtual "Tools" folder is active so the
  // grid embeds in the same right pane that normally shows files.
  window.renderFieldToolsInto = function(host) { loadList(host); };

  // Legacy stand-alone-tab entry point. Kept in case anything else
  // calls it directly; routes through the same loader.
  window.renderFieldToolsTab = function() {
    var host = document.getElementById('field-tools-view');
    if (host) loadList(host);
  };

})();
