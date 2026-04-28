// AI estimating-assistant panel — slide-in right rail attached to the
// estimate editor. Read-only Q&A: it knows the estimate's full context
// (server-side) but cannot modify the estimate. Per-user chat history.
//
// Wire-up:
//   - Estimate editor calls window.agxAI.toggle() / .open(estimateId)
//   - On open, we GET /api/ai/estimates/:id/messages to load history
//   - User submits → POST /api/ai/estimates/:id/chat (SSE), we stream the
//     assistant's reply into a live message bubble
(function() {
  'use strict';

  var _open = false;
  // Generalized entity binding — the panel works against estimates today
  // and jobs as of Phase 2B. _entityType decides which API base path the
  // chat hits ('estimate' → /api/ai/estimates/:id, 'job' → /api/ai/jobs/:id)
  // and which features are available (estimate has photos + write tools,
  // job is read-only / no photos for now).
  var _entityType = 'estimate';
  var _entityId = null;
  var _estimateId = null; // legacy alias kept so existing call sites keep working
  var _messages = [];           // {role, content, ...}
  var _streaming = false;
  var _includePhotos = true;    // default-on with toggle, per the user
  var _abortController = null;

  function apiBase() {
    if (_entityType === 'job') return '/api/ai/jobs/' + encodeURIComponent(_entityId);
    if (_entityType === 'client') return '/api/ai/clients';
    return '/api/ai/estimates/' + encodeURIComponent(_entityId);
  }
  function isEstimateMode() { return _entityType === 'estimate'; }
  function isJobMode() { return _entityType === 'job'; }
  function isClientMode() { return _entityType === 'client'; }

  // Preset prompts surfaced as quick-tap buttons. Different presets per
  // entity — estimates focus on scope/materials, jobs on margin/billing.
  var ESTIMATE_PRESETS = [
    { label: 'Draft scope from photos', prompt: 'Look at the photos attached and draft a tight, bulleted scope of work for this estimate. Focus on the work AGX would actually be doing.' },
    { label: "What am I missing?",      prompt: 'Review the estimate as it stands. What line items, prep work, or costs am I likely missing? Be specific to the trade and scope.' },
    { label: 'Site assessment',         prompt: 'Based on the photos and what you know about this property, what site conditions should I factor into pricing — stories, access difficulty, distance, weather/scheduling risks, code concerns?' },
    { label: 'Build my line items',     prompt: 'Propose the cost-side line items I should add for this scope. Use realistic AGX prices for Central Florida and slot each one under the right standard section. Make multiple parallel proposals so I can approve them in batch.' }
  ];
  var JOB_PRESETS = [
    { label: 'Health check',          prompt: 'Run a quick WIP health check on this job. Margin trend, cost-to-complete sanity, any red flags I should look at first.' },
    { label: 'Am I underbilled?',     prompt: 'Compare revenue earned vs. invoiced to date. Am I behind on billing? If so, by how much, and what should I send next?' },
    { label: 'Missing change orders?', prompt: 'Look at the cost lines vs. the original estimated costs. Anything that looks like out-of-scope work that should have been captured as a change order?' },
    { label: 'Margin drift',          prompt: 'Compare as-sold margin, revised margin, and JTD margin. Is the job drifting? What\'s driving the change?' }
  ];
  var CLIENT_PRESETS = [
    { label: 'Find duplicates',         prompt: 'Scan the directory for likely duplicate clients (typo variants, abbreviations vs full names, same CAM/email on different rows). List them and propose merges where you are confident.' },
    { label: 'Organize flat clients',   prompt: 'Look at the unparented entries. For each one, suggest the parent management company they belong under (existing parent if a match, otherwise propose a split into parent + property).' },
    { label: 'Add a property',          prompt: 'Walk me through adding a new property. Ask which parent management company first, then collect the property name, address, and on-site CAM contact.' },
    { label: 'Audit incomplete records', prompt: 'Show me clients missing key fields (no CAM contact, no property address, or no parent linkage). Group by what is missing so I can fill them in efficiently.' }
  ];
  function getActivePresets() {
    if (isJobMode()) return JOB_PRESETS;
    if (isClientMode()) return CLIENT_PRESETS;
    return ESTIMATE_PRESETS;
  }

  function escapeHTMLLocal(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Lightweight markdown — bold, italic, inline code, lists, paragraphs.
  // Safer than pulling in marked.js for this scale; trades feature breadth
  // for zero dependencies.
  function renderMarkdown(text) {
    if (!text) return '';
    var html = escapeHTMLLocal(text);
    // Code blocks (triple backtick)
    html = html.replace(/```([\s\S]*?)```/g, function(_, code) {
      return '<pre style="background:rgba(255,255,255,0.06);padding:8px 10px;border-radius:6px;overflow-x:auto;font-size:11px;font-family:SF Mono,Consolas,monospace;margin:6px 0;">' + code.trim() + '</pre>';
    });
    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-family:SF Mono,Consolas,monospace;font-size:0.9em;">$1</code>');
    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    // Italic
    html = html.replace(/\*([^*\n]+)\*/g, '<em>$1</em>');
    // Bulleted lists — group consecutive lines starting with - or *
    var lines = html.split('\n');
    var out = [];
    var inList = false;
    lines.forEach(function(line) {
      var bulletMatch = line.match(/^\s*[-*]\s+(.+)$/);
      var numberedMatch = line.match(/^\s*(\d+)\.\s+(.+)$/);
      if (bulletMatch) {
        if (!inList) { out.push('<ul style="margin:6px 0;padding-left:20px;">'); inList = 'ul'; }
        out.push('<li>' + bulletMatch[1] + '</li>');
      } else if (numberedMatch) {
        if (!inList) { out.push('<ol style="margin:6px 0;padding-left:22px;">'); inList = 'ol'; }
        out.push('<li>' + numberedMatch[2] + '</li>');
      } else {
        if (inList) { out.push(inList === 'ul' ? '</ul>' : '</ol>'); inList = false; }
        if (line.trim()) out.push('<p style="margin:4px 0;">' + line + '</p>');
      }
    });
    if (inList) out.push(inList === 'ul' ? '</ul>' : '</ol>');
    return out.join('');
  }

  // ──────────────────────────────────────────────────────────────────
  // Panel DOM lazy-init. We create the side rail once on first open and
  // toggle visibility from there.
  // ──────────────────────────────────────────────────────────────────

  function ensurePanel() {
    var panel = document.getElementById('agx-ai-panel');
    if (panel) return panel;
    panel = document.createElement('div');
    panel.id = 'agx-ai-panel';
    panel.style.cssText = 'position:fixed;top:0;right:0;bottom:0;width:420px;max-width:90vw;background:var(--surface,#0f0f1e);border-left:1px solid var(--border,#333);box-shadow:-4px 0 22px rgba(0,0,0,0.6);z-index:80;display:flex;flex-direction:column;transform:translateX(100%);transition:transform 0.22s ease;';
    panel.innerHTML =
      // Header — close button is the most prominent control on the left
      // (mirrors a typical drawer/sidebar UX) so it's never missed.
      '<div style="padding:12px 14px;border-bottom:1px solid var(--border,#333);background:linear-gradient(135deg,#0d1f12 0%,#14351d 100%);display:flex;align-items:center;gap:10px;">' +
        '<button id="ai-close" title="Close (Esc)" style="background:rgba(255,255,255,0.12);color:#fff;border:1px solid rgba(255,255,255,0.2);border-radius:6px;padding:6px 12px;font-size:12px;font-weight:600;cursor:pointer;display:flex;align-items:center;gap:6px;">&rarr; Close</button>' +
        '<div class="agx-ai-title" style="font-size:14px;font-weight:700;color:#fff;flex:1;text-align:right;">&#x2728; AI Assistant</div>' +
        '<button id="ai-clear" title="Clear conversation" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;">Clear</button>' +
      '</div>' +
      // Notice strip
      '<div id="ai-notice" style="padding:8px 14px;background:rgba(79,140,255,0.08);border-bottom:1px solid var(--border,#333);font-size:11px;color:var(--text-dim,#aaa);">' +
        'Read-only — I see your estimate and photos but cannot change anything. Apply suggestions by hand.' +
      '</div>' +
      // Messages scroll area
      '<div id="ai-messages" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text,#e6e6e6);"></div>' +
      // Preset prompts
      '<div id="ai-presets" style="padding:8px 12px;border-top:1px solid var(--border,#333);display:flex;flex-wrap:wrap;gap:6px;background:rgba(255,255,255,0.02);"></div>' +
      // Input row. The inner spans use !important text-transform overrides
      // because the global stylesheet applies uppercase + letter-spacing to
      // every <label>, which made this strip look shouty.
      '<div style="padding:10px 12px 12px;border-top:1px solid var(--border,#333);background:var(--card-bg,#0c0c14);">' +
        '<div style="display:flex;align-items:center;gap:6px;font-size:11px;margin-bottom:8px;">' +
          '<label style="display:flex;align-items:center;gap:6px;cursor:pointer;color:var(--text-dim,#aaa);text-transform:none !important;letter-spacing:normal !important;font-size:11px !important;font-weight:400 !important;margin:0;flex:1;min-width:0;">' +
            '<input id="ai-photos-toggle" type="checkbox" checked style="margin:0;flex:0 0 auto;" />' +
            '<span style="text-transform:none;">Send photos with my message</span>' +
          '</label>' +
          '<span id="ai-photos-count" style="color:var(--text-dim,#888);text-transform:none;letter-spacing:normal;flex:0 0 auto;"></span>' +
        '</div>' +
        '<div style="display:flex;gap:8px;align-items:flex-end;">' +
          '<textarea id="ai-input" rows="1" placeholder="Ask anything about this estimate…" style="flex:1;resize:none;overflow-y:auto;min-height:36px;max-height:200px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;color:var(--text,#fff);font-size:13px;line-height:1.4;font-family:inherit;box-sizing:border-box;"></textarea>' +
          '<button id="ai-send" class="primary" style="padding:0 16px;font-size:12px;height:36px;flex:0 0 auto;">Send</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    // Wire interactions
    panel.querySelector('#ai-close').onclick = close;
    panel.querySelector('#ai-clear').onclick = clearConversation;
    panel.querySelector('#ai-send').onclick = onSend;
    panel.querySelector('#ai-photos-toggle').onchange = function(e) { _includePhotos = !!e.target.checked; };
    var input = panel.querySelector('#ai-input');
    // Auto-grow: textarea expands as the user types, capped at max-height
    // (set in the inline style above). Reset to scrollHeight on each input.
    function autoGrow() {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 200) + 'px';
    }
    input.addEventListener('input', autoGrow);
    input.addEventListener('keydown', function(e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        onSend();
      }
    });

    // Initial preset render — refreshed on every open() to switch
    // between estimate and job preset sets when the entity changes.
    renderPresets();

    // Esc-to-close while focus is in the panel
    panel.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });

    return panel;
  }

  // open() accepts either:
  //   open(estimateId)                       — legacy: opens for an estimate
  //   open({ entityType, entityId })         — explicit polymorphic form
  function open(arg) {
    var entityType, entityId;
    if (typeof arg === 'string') {
      entityType = 'estimate';
      entityId = arg;
    } else if (arg && typeof arg === 'object') {
      entityType = arg.entityType || 'estimate';
      entityId = arg.entityId;
    }
    // Client mode is global to the user — no entity ID needed (the
    // directory IS the context). Other modes still require an entity.
    var requiresEntity = entityType !== 'client';
    if (requiresEntity && !entityId) {
      alert('Save the ' + (entityType || 'record') + ' first to enable the AI assistant.');
      return;
    }
    if (!requiresEntity) entityId = '__global__';
    var panel = ensurePanel();
    if (_entityId !== entityId || _entityType !== entityType) {
      _entityType = entityType;
      _entityId = entityId;
      _estimateId = entityType === 'estimate' ? entityId : null;
      _messages = [];
      loadHistory();
    }
    panel.style.transform = 'translateX(0)';
    document.body.classList.add('agx-ai-open');
    _open = true;
    // Photos toggle and proposal cards only make sense on the estimate
    // side. Hide / disable them when running against a job.
    refreshModeSpecificUI();
    setTimeout(function() {
      var inp = document.getElementById('ai-input');
      if (inp) inp.focus();
    }, 240);
    updatePhotoCount();
  }

  function refreshModeSpecificUI() {
    var photoRow = document.querySelector('#agx-ai-panel #ai-photos-toggle');
    if (photoRow) {
      var rowEl = photoRow.closest('div');
      if (rowEl) rowEl.style.display = isEstimateMode() ? '' : 'none';
    }
    var headerEl = document.querySelector('#agx-ai-panel .agx-ai-title');
    if (headerEl) {
      if (isJobMode()) headerEl.textContent = '📊 WIP Assistant';
      else if (isClientMode()) headerEl.textContent = '👥 Client Directory';
      else headerEl.textContent = '✨ AI Assistant';
    }
    var noticeEl = document.querySelector('#agx-ai-panel #ai-notice');
    if (noticeEl) {
      if (isJobMode()) noticeEl.textContent = 'Read-only — I can see this job\'s WIP/financial state but cannot change anything.';
      else if (isClientMode()) noticeEl.textContent = 'I can edit the client directory. Simple changes (new property under known parent, typo fixes) apply automatically; merges, splits, deletes, and new parent companies require your approval.';
      else noticeEl.textContent = 'Read-only — I see your estimate and photos but cannot change anything. Apply suggestions by hand.';
    }
    var inputEl = document.getElementById('ai-input');
    if (inputEl) {
      if (isClientMode()) inputEl.placeholder = 'Ask about your client directory or describe a change…';
      else if (isJobMode()) inputEl.placeholder = 'Ask anything about this job…';
      else inputEl.placeholder = 'Ask anything about this estimate…';
    }
    renderPresets();
  }

  function renderPresets() {
    var presetWrap = document.getElementById('ai-presets');
    if (!presetWrap) return;
    presetWrap.innerHTML = '';
    getActivePresets().forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'ee-btn ghost';
      btn.textContent = p.label;
      btn.onclick = function() {
        if (_streaming) return;
        var ta = document.getElementById('ai-input');
        if (ta) { ta.value = p.prompt; ta.focus(); }
      };
      presetWrap.appendChild(btn);
    });
  }

  function close() {
    var panel = document.getElementById('agx-ai-panel');
    if (panel) panel.style.transform = 'translateX(100%)';
    document.body.classList.remove('agx-ai-open');
    _open = false;
    if (_abortController) {
      try { _abortController.abort(); } catch (e) { /* ignore */ }
      _abortController = null;
    }
  }

  function toggle(estimateId) {
    if (_open) close();
    else open(estimateId);
  }

  // ──────────────────────────────────────────────────────────────────
  // Conversation rendering
  // ──────────────────────────────────────────────────────────────────

  function loadHistory() {
    if (!_entityId || !window.agxApi) return;
    var box = document.getElementById('ai-messages');
    if (box) box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;">Loading…</div>';
    fetch(apiBase() + '/messages', {
      headers: authHeaders()
    }).then(function(r) { return r.json(); }).then(function(res) {
      _messages = res.messages || [];
      renderMessages();
    }).catch(function() {
      _messages = [];
      renderMessages();
    });
  }

  function clearConversation() {
    if (!_entityId) return;
    if (!confirm('Clear this conversation? Your messages on this ' + _entityType + ' will be deleted.')) return;
    fetch(apiBase() + '/messages', {
      method: 'DELETE',
      headers: authHeaders()
    }).then(function() {
      _messages = [];
      renderMessages();
    }).catch(function(err) {
      alert('Clear failed: ' + (err.message || err));
    });
  }

  function renderMessages() {
    var box = document.getElementById('ai-messages');
    if (!box) return;
    if (!_messages.length) {
      var hint;
      if (isJobMode()) hint = 'Pick a preset below or ask anything about the job.<br><span style="font-size:11px;opacity:0.7;">I can see contract, costs, change orders, % complete, billing posture.</span>';
      else if (isClientMode()) hint = 'Pick a preset below or describe what you need.<br><span style="font-size:11px;opacity:0.7;">I can see your full directory and can add properties, link parents, fix typos, and propose merges/splits.</span>';
      else hint = 'Pick a preset below or ask anything about the estimate.<br><span style="font-size:11px;opacity:0.7;">I can see line items, scope, client, photos &mdash; and I can propose edits.</span>';
      box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:20px 0;text-align:center;line-height:1.6;">' + hint + '</div>';
      return;
    }
    var html = '';
    _messages.forEach(function(m) {
      html += renderBubble(m);
    });
    box.innerHTML = html;
    box.scrollTop = box.scrollHeight;
  }

  function renderBubble(m) {
    var isUser = m.role === 'user';
    var bg = isUser ? 'rgba(79,140,255,0.12)' : 'rgba(255,255,255,0.04)';
    var border = isUser ? '#4f8cff' : 'var(--border,#333)';
    var labelColor = isUser ? '#4f8cff' : '#34d399';
    var label = isUser ? 'You' : 'Claude';
    var photoNote = (isUser && m.photos_included) ? ' <span style="color:var(--text-dim,#888);font-weight:400;">(' + m.photos_included + ' photo' + (m.photos_included === 1 ? '' : 's') + ' attached)</span>' : '';
    return '<div style="background:' + bg + ';border-left:3px solid ' + border + ';border-radius:6px;padding:8px 10px;">' +
      '<div style="font-size:10px;font-weight:700;color:' + labelColor + ';text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">' + label + photoNote + '</div>' +
      '<div class="ai-content" style="font-size:13px;line-height:1.5;">' + (isUser ? '<p style="margin:0;white-space:pre-wrap;">' + escapeHTMLLocal(m.content) + '</p>' : renderMarkdown(m.content)) + '</div>' +
    '</div>';
  }

  function appendStreamingBubble() {
    var box = document.getElementById('ai-messages');
    if (!box) return null;
    var div = document.createElement('div');
    div.className = 'ai-streaming';
    div.style.cssText = 'background:rgba(255,255,255,0.04);border-left:3px solid #34d399;border-radius:6px;padding:8px 10px;';
    div.innerHTML =
      '<div style="font-size:10px;font-weight:700;color:#34d399;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:4px;">Claude</div>' +
      '<div class="ai-content" data-stream-content style="font-size:13px;line-height:1.5;"><span style="color:var(--text-dim,#888);font-style:italic;">Thinking…</span></div>';
    box.appendChild(div);
    box.scrollTop = box.scrollHeight;
    return div;
  }

  // ──────────────────────────────────────────────────────────────────
  // Send / stream
  // ──────────────────────────────────────────────────────────────────

  function authHeaders() {
    var headers = { 'Content-Type': 'application/json' };
    var token = (window.agxAuth && window.agxAuth.getToken && window.agxAuth.getToken()) || localStorage.getItem('agx-auth-token');
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return headers;
  }

  function onSend() {
    if (_streaming) return;
    var input = document.getElementById('ai-input');
    var text = (input && input.value || '').trim();
    if (!text) return;
    if (!_entityId) { alert('No ' + _entityType + ' is open.'); return; }
    input.value = '';
    // Reset auto-grow height after clearing the value, so the textarea
    // collapses back to one row on submit instead of staying tall.
    input.style.height = 'auto';
    sendMessage(text);
  }

  function sendMessage(text) {
    var photoCount = countCurrentPhotos();
    var inlineImageCount = _pendingImages && _pendingImages.images ? _pendingImages.images.length : 0;
    _messages.push({
      role: 'user', content: text,
      photos_included: (_includePhotos ? photoCount : 0) + inlineImageCount
    });
    renderMessages();
    var body = isEstimateMode()
      ? { message: text, includePhotos: _includePhotos }
      : { message: text };
    // Attach any one-shot inline images (e.g., rendered PDF pages from
    // the viewer's Ask AI handoff). They only ride on this single call,
    // not subsequent turns.
    if (_pendingImages && _pendingImages.images && _pendingImages.images.length) {
      body.additional_images = _pendingImages.images;
      _pendingImages = null;
    }
    streamFromEndpoint(apiBase() + '/chat', body);
  }

  // Shared streaming runner — used by sendMessage (initial turn) and by
  // continueAfterProposals (tool-use continuation). Handles all SSE event
  // shapes: text deltas, tool_use proposals, awaiting_approval, errors,
  // and end-of-turn.
  function streamFromEndpoint(endpoint, body) {
    var streamDiv = appendStreamingBubble();
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    var assistantText = '';
    var pendingToolUses = [];     // tool_use blocks captured this turn
    var pendingAssistantContent = null; // full content array for echo-back
    _streaming = true;
    setSendDisabled(true);

    _abortController = new AbortController();
    return fetch(endpoint, {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify(body),
      signal: _abortController.signal
    }).then(function(r) {
      if (!r.ok) {
        return r.json().then(function(err) { throw new Error(err.error || 'HTTP ' + r.status); });
      }
      return readSSEStream(r, function(payload) {
        if (payload.delta) {
          assistantText += payload.delta;
          if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText) +
            '<span style="display:inline-block;width:7px;height:13px;background:#34d399;margin-left:2px;animation:agx-blink 0.9s step-end infinite;"></span>';
          scrollToBottom();
        } else if (payload.tool_use) {
          pendingToolUses.push(payload.tool_use);
        } else if (payload.tool_applied) {
          // Server-side auto-tier tool already executed. Show an inline
          // confirmation chip in the streaming bubble.
          appendToolChip(streamDiv, '✓', payload.tool_applied.summary || (payload.tool_applied.name + ' applied'), '#34d399');
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
          scrollToBottom();
        } else if (payload.tool_failed) {
          appendToolChip(streamDiv, '✗', payload.tool_failed.error || (payload.tool_failed.name + ' failed'), '#f87171');
          scrollToBottom();
        } else if (payload.tool_rejected) {
          appendToolChip(streamDiv, '⊘', (payload.tool_rejected.name || 'tool') + ' rejected', '#a3a3a3');
          scrollToBottom();
        } else if (payload.awaiting_approval) {
          pendingAssistantContent = payload.pending_assistant_content;
        } else if (payload.done) {
          if (isClientMode() && typeof window.refreshClientsAfterAI === 'function') {
            window.refreshClientsAfterAI();
          }
        } else if (payload.error) {
          if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">' + escapeHTMLLocal(payload.error) + '</span>';
        }
      });
    }).then(function() {
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;

      if (pendingToolUses.length && pendingAssistantContent) {
        // Tool-use turn — render approval cards inline. The streamDiv
        // stays as the assistant bubble; cards get appended below the
        // text. No history persistence on this turn — the conversation
        // gets persisted only after the final text response of the
        // multi-step exchange.
        finalizeProposalBubble(streamDiv, assistantText, pendingToolUses, pendingAssistantContent);
      } else {
        // Plain text response — drop the streaming placeholder and add
        // a permanent bubble (history already persisted server-side).
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
        _messages.push({ role: 'assistant', content: assistantText || '(no response)' });
        renderMessages();
      }
    }).catch(function(err) {
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;
      if (err && err.name === 'AbortError') {
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
      } else {
        if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">Error: ' + escapeHTMLLocal(err.message || 'unknown') + '</span>';
      }
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Approval cards — for each tool_use block from Claude, render a card
  // with Approve / Reject. When all are answered, continue the
  // conversation with /chat/continue passing the assembled tool_results.
  // ──────────────────────────────────────────────────────────────────
  function finalizeProposalBubble(streamDiv, assistantText, toolUses, pendingContent) {
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    if (contentEl) contentEl.innerHTML = renderMarkdown(assistantText || '');

    var propContainer = document.createElement('div');
    propContainer.style.cssText = 'margin-top:10px;display:flex;flex-direction:column;gap:6px;';
    streamDiv.appendChild(propContainer);

    var responses = [];
    var totalCount = toolUses.length;
    var bulkButtons = null;

    function answer(idx, approved, card) {
      var tu = toolUses[idx];
      var summary = '';
      if (approved) {
        try {
          summary = applyTool(tu);
        } catch (e) {
          alert('Could not apply: ' + (e.message || e));
          return;
        }
      }
      responses.push({ tool_use_id: tu.id, approved: approved, applied_summary: summary });
      markCardDone(card, approved, summary);

      // Refresh bulk-action button count
      if (bulkButtons) {
        var remaining = totalCount - responses.length;
        if (remaining <= 0) bulkButtons.remove();
        else bulkButtons.querySelector('[data-bulk-info]').textContent = remaining + ' remaining';
      }

      if (responses.length === totalCount) {
        continueAfterProposals(pendingContent, responses);
      }
    }

    // Bulk-action bar when there are 2+ proposals
    if (totalCount >= 2) {
      bulkButtons = document.createElement('div');
      bulkButtons.style.cssText = 'display:flex;align-items:center;gap:8px;padding:6px 10px;background:rgba(79,140,255,0.05);border:1px solid rgba(79,140,255,0.2);border-radius:6px;font-size:11px;color:var(--text-dim,#aaa);';
      bulkButtons.innerHTML =
        '<span data-bulk-info>' + totalCount + ' proposals</span>' +
        '<button data-bulk-approve class="success small" style="padding:4px 10px;font-size:11px;margin-left:auto;">&check; Approve all</button>' +
        '<button data-bulk-reject class="ghost small" style="padding:4px 10px;font-size:11px;">&times; Reject all</button>';
      propContainer.appendChild(bulkButtons);
      bulkButtons.querySelector('[data-bulk-approve]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, true, card);
        });
      };
      bulkButtons.querySelector('[data-bulk-reject]').onclick = function() {
        cards.forEach(function(card, i) {
          if (!isCardAnswered(card)) answer(i, false, card);
        });
      };
    }

    var cards = [];
    toolUses.forEach(function(tu, i) {
      var card = renderProposalCard(tu);
      card.querySelector('[data-card-approve]').onclick = function() { answer(i, true, card); };
      card.querySelector('[data-card-reject]').onclick = function() { answer(i, false, card); };
      propContainer.appendChild(card);
      cards.push(card);
    });
    scrollToBottom();
  }

  function applyTool(tu) {
    if (isClientMode()) {
      // Server applies client tools on /chat/continue. Just signal approval.
      return '';
    }
    if (!window.estimateEditorAPI) {
      throw new Error('Estimate editor not loaded — refresh the page.');
    }
    if (!window.estimateEditorAPI.isOpenFor(_estimateId)) {
      throw new Error('Open the estimate in the editor before approving changes.');
    }
    switch (tu.name) {
      case 'propose_add_line_item': return window.estimateEditorAPI.applyAddLineItem(tu.input);
      case 'propose_add_section':   return window.estimateEditorAPI.applyAddSection(tu.input);
      case 'propose_update_scope':  return window.estimateEditorAPI.applyUpdateScope(tu.input);
      default: throw new Error('Unknown tool: ' + tu.name);
    }
  }

  // Inline confirmation chip — used when a server-side auto-tier tool
  // applies during the stream, so the user sees what happened without
  // needing an approval card.
  function appendToolChip(streamDiv, glyph, text, color) {
    if (!streamDiv) return;
    var chip = document.createElement('div');
    chip.style.cssText = 'display:flex;align-items:center;gap:8px;margin-top:6px;padding:5px 9px;background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-left:3px solid ' + color + ';border-radius:4px;font-size:11px;color:var(--text-dim,#aaa);';
    chip.innerHTML = '<span style="color:' + color + ';font-weight:700;">' + glyph + '</span><span style="flex:1;">' + escapeHTMLLocal(text) + '</span>';
    streamDiv.appendChild(chip);
  }

  function continueAfterProposals(pendingContent, responses) {
    streamFromEndpoint(
      apiBase() + '/chat/continue',
      { pending_assistant_content: pendingContent, tool_results: responses }
    );
  }

  // Card rendering — one per tool_use block, formatted by tool type.
  function renderProposalCard(tu) {
    var card = document.createElement('div');
    card.style.cssText = 'background:rgba(255,255,255,0.04);border:1px solid var(--border,#333);border-left:3px solid #4f8cff;border-radius:6px;padding:10px 12px;';

    var heading = '';
    var detail = '';
    var input = tu.input || {};

    if (tu.name === 'propose_add_line_item') {
      heading = '&#x2795; Add line item';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.description || '') + '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;font-family:\'SF Mono\',monospace;">' +
          'qty ' + escapeHTMLLocal(String(input.qty)) + ' ' + escapeHTMLLocal(input.unit || 'ea') +
          ' @ $' + Number(input.unit_cost || 0).toFixed(2) +
          (input.markup_pct != null ? ' &middot; markup ' + input.markup_pct + '%' : '') +
        '</div>' +
        (input.section_name ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">section: ' + escapeHTMLLocal(input.section_name) + '</div>' : '');
    } else if (tu.name === 'propose_add_section') {
      heading = '&#x2795; Add section';
      detail =
        '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.bt_category ? '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:3px;">BT category: ' + escapeHTMLLocal(input.bt_category) + '</div>' : '');
    } else if (tu.name === 'propose_update_scope') {
      heading = '&#x270F; Update scope (' + (input.mode || 'replace') + ')';
      var preview = (input.scope_text || '').slice(0, 280);
      if ((input.scope_text || '').length > 280) preview += '…';
      detail = '<pre style="white-space:pre-wrap;font-family:inherit;font-size:12px;margin:4px 0 0;color:var(--text,#ccc);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;max-height:160px;overflow-y:auto;">' + escapeHTMLLocal(preview) + '</pre>';
    } else if (tu.name === 'create_parent_company') {
      heading = '&#x1F3E2; New parent company';
      detail = '<div style="font-size:13px;color:var(--text,#fff);font-weight:600;">' + escapeHTMLLocal(input.name || '') + '</div>' +
        (input.notes ? '<div style="font-size:11px;color:var(--text-dim,#aaa);margin-top:3px;">' + escapeHTMLLocal(input.notes) + '</div>' : '');
    } else if (tu.name === 'rename_client') {
      heading = '&#x270F; Rename client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">→ <strong>' + escapeHTMLLocal(input.new_name || '') + '</strong></div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else if (tu.name === 'change_property_parent') {
      heading = '&#x21B7; Change parent';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">' +
        (input.new_parent_client_id ? 'New parent id: <code>' + escapeHTMLLocal(input.new_parent_client_id) + '</code>' : 'Detach (no parent)') +
        '</div><div style="font-size:10px;color:var(--text-dim,#888);margin-top:2px;font-family:monospace;">property: ' + escapeHTMLLocal(input.property_client_id || '') + '</div>';
    } else if (tu.name === 'merge_clients') {
      heading = '&#x1F500; Merge duplicates';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Keep <code>' + escapeHTMLLocal(input.keep_client_id || '') + '</code></div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Fold in <code>' + escapeHTMLLocal(input.merge_from_client_id || '') + '</code></div>';
    } else if (tu.name === 'split_client_into_parent_and_property') {
      heading = '&#x2702; Split client';
      detail = '<div style="font-size:12px;color:var(--text,#ccc);">Parent: <strong>' + escapeHTMLLocal(input.new_parent_name || '') + '</strong>' +
        (input.existing_parent_id ? ' <span style="color:var(--text-dim,#888);">(reuse existing)</span>' : '') + '</div>' +
        '<div style="font-size:12px;color:var(--text,#ccc);">Property: <strong>' + escapeHTMLLocal(input.new_property_name || '') + '</strong></div>';
    } else if (tu.name === 'delete_client') {
      heading = '&#x1F5D1; Delete client';
      detail = '<div style="font-size:12px;color:#f87171;font-family:monospace;">id: ' + escapeHTMLLocal(input.client_id || '') + '</div>';
    } else {
      heading = '? Unknown tool: ' + tu.name;
      detail = '<pre style="font-size:11px;">' + escapeHTMLLocal(JSON.stringify(input, null, 2)) + '</pre>';
    }

    var rationale = input.rationale
      ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:6px;font-style:italic;border-top:1px dashed var(--border,#333);padding-top:6px;">' + escapeHTMLLocal(input.rationale) + '</div>'
      : '';

    card.innerHTML =
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
        '<div style="font-size:11px;font-weight:700;color:#4f8cff;flex:1;text-transform:none;letter-spacing:normal;">' + heading + '</div>' +
        '<div data-card-status style="font-size:10px;font-weight:600;"></div>' +
      '</div>' +
      detail + rationale +
      '<div data-card-actions style="display:flex;gap:6px;margin-top:8px;">' +
        '<button data-card-approve class="success small" style="padding:4px 12px;font-size:11px;">&check; Approve</button>' +
        '<button data-card-reject class="ghost small" style="padding:4px 12px;font-size:11px;">&times; Reject</button>' +
      '</div>';

    return card;
  }

  function markCardDone(card, approved, summary) {
    var status = card.querySelector('[data-card-status]');
    var actions = card.querySelector('[data-card-actions]');
    if (actions) actions.remove();
    if (status) {
      status.style.color = approved ? '#34d399' : '#f87171';
      status.textContent = approved ? '✓ Applied' : '✗ Rejected';
    }
    card.style.opacity = approved ? '1' : '0.55';
    card.style.borderLeftColor = approved ? '#34d399' : '#f87171';
  }

  function isCardAnswered(card) {
    return !card.querySelector('[data-card-actions]');
  }

  function scrollToBottom() {
    var box = document.getElementById('ai-messages');
    if (box) box.scrollTop = box.scrollHeight;
  }

  // Read SSE chunks from a fetch response. Delegates to onChunk for each
  // `data: ...\n\n` payload until `[DONE]`. SSE in JS without EventSource
  // is just newline-delimited parsing.
  function readSSEStream(response, onChunk) {
    var reader = response.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    function pump() {
      return reader.read().then(function(result) {
        if (result.done) return;
        buffer += decoder.decode(result.value, { stream: true });
        var parts = buffer.split('\n\n');
        buffer = parts.pop(); // last is incomplete
        parts.forEach(function(part) {
          var line = part.replace(/^data: /, '').trim();
          if (!line || line === '[DONE]') return;
          try {
            var payload = JSON.parse(line);
            onChunk(payload);
          } catch (e) { /* ignore malformed chunk */ }
        });
        return pump();
      });
    }
    return pump();
  }

  function setSendDisabled(disabled) {
    var btn = document.getElementById('ai-send');
    if (btn) btn.disabled = disabled;
    var input = document.getElementById('ai-input');
    if (input) input.disabled = disabled;
  }

  function countCurrentPhotos() {
    // Best effort — we don't track photo state here, but we can read it
    // off the editor's currently-open list. The server is authoritative.
    if (!_estimateId) return 0;
    return 0; // placeholder; the count chip is informational only
  }

  function updatePhotoCount() {
    var el = document.getElementById('ai-photos-count');
    if (!el || !window.agxApi) return;
    if (!isEstimateMode() || !_entityId) { el.textContent = ''; return; }
    window.agxApi.attachments.list('estimate', _entityId).then(function(res) {
      var n = (res.attachments || []).length;
      // Add lead photos if estimate is linked to a lead
      var est = (window.appData && window.appData.estimates || []).find(function(e) { return e.id === _entityId; });
      if (est && est.lead_id) {
        return window.agxApi.attachments.list('lead', est.lead_id).then(function(r2) {
          n += (r2.attachments || []).length;
          el.textContent = n + ' photo' + (n === 1 ? '' : 's') + ' available';
        });
      }
      el.textContent = n + ' photo' + (n === 1 ? '' : 's') + ' available';
    }).catch(function() { if (el) el.textContent = ''; });
  }

  // CSS for the cursor blink + body shift — appended once
  if (!document.getElementById('agx-ai-css')) {
    var style = document.createElement('style');
    style.id = 'agx-ai-css';
    style.textContent =
      '@keyframes agx-blink { from, to { opacity: 1; } 50% { opacity: 0; } } ' +
      '.ai-content p:first-child { margin-top: 0; } ' +
      '.ai-content p:last-child { margin-bottom: 0; } ' +
      // When the panel is open, push the entire page over so the editor
      // stays fully visible. Sticky elements (page nav, editor header)
      // respect this since they sit in the document flow. The fixed
      // panel itself stays at right:0 since fixed-position elements
      // ignore body padding.
      'body.agx-ai-open { padding-right: 420px; transition: padding-right 0.22s ease; } ' +
      // On narrow screens fall back to the overlay behavior — no point
      // shoving a tablet's content into a 200px column.
      '@media (max-width: 1100px) { body.agx-ai-open { padding-right: 0; } }';
    document.head.appendChild(style);
  }

  // One-shot inline images attached to the next message. Set by
  // openWithImages(); cleared after the next sendMessage so the images
  // don't ride along on every subsequent turn.
  var _pendingImages = null;

  // Open the panel for an entity AND attach a one-shot batch of images
  // (e.g., rendered PDF pages from the viewer) to the next outgoing
  // message. Used by the PDF viewer's "Ask AI" button.
  function openWithImages(opts) {
    opts = opts || {};
    if (!opts.entityType || !opts.entityId) {
      alert('Open an estimate or lead first.');
      return;
    }
    if (Array.isArray(opts.images) && opts.images.length) {
      _pendingImages = {
        images: opts.images.slice(0, 12), // hard cap matches Anthropic per-request limit
        note: opts.imagesNote || null
      };
    }
    open({ entityType: opts.entityType, entityId: opts.entityId });
    if (opts.prefill) {
      setTimeout(function() {
        var input = document.getElementById('ai-input');
        if (input) {
          input.value = opts.prefill;
          // Trigger auto-grow by dispatching an input event
          input.dispatchEvent(new Event('input'));
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }
      }, 260);
    }
  }

  window.agxAI = {
    open: open,
    openWithImages: openWithImages,
    close: close,
    toggle: toggle,
    isOpen: function() { return _open; }
  };

  // Sticky-header shim mirroring openEstimateAI() — finds the active job id
  // from the workspace state and opens the panel against it. Lives here so
  // wip.js doesn't need to know about agxAI's internals.
  window.openJobAI = function() {
    var jobId = (window.appState && window.appState.currentJobId) || null;
    if (!jobId) { alert('Open a job first.'); return; }
    open({ entityType: 'job', entityId: jobId });
  };

  // Client-directory entry point. No entity ID — the directory IS the
  // context. Pages that want a refresh after the assistant changes things
  // can register window.refreshClientsAfterAI.
  window.openClientAI = function() {
    open({ entityType: 'client' });
  };
})();
