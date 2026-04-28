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
  var _estimateId = null;
  var _messages = [];           // {role, content, ...}
  var _streaming = false;
  var _includePhotos = true;    // default-on with toggle, per the user
  var _abortController = null;

  // Preset prompts surfaced as quick-tap buttons. Picked specifically for
  // construction estimating workflow — feel free to add more.
  var PRESETS = [
    { label: 'Draft scope from photos', prompt: 'Look at the photos attached and draft a tight, bulleted scope of work for this estimate. Focus on the work AGX would actually be doing.' },
    { label: "What am I missing?",      prompt: 'Review the estimate as it stands. What line items, prep work, or costs am I likely missing? Be specific to the trade and scope.' },
    { label: 'Site assessment',         prompt: 'Based on the photos and what you know about this property, what site conditions should I factor into pricing — stories, access difficulty, distance, weather/scheduling risks, code concerns?' },
    { label: 'Material suggestions',    prompt: 'For this scope, what materials and quantities would you recommend? Use cost-side prices; the markup is applied separately.' }
  ];

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
        '<div style="font-size:14px;font-weight:700;color:#fff;flex:1;text-align:right;">&#x2728; AI Assistant</div>' +
        '<button id="ai-clear" title="Clear conversation" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:6px 10px;font-size:11px;cursor:pointer;">Clear</button>' +
      '</div>' +
      // Notice strip
      '<div style="padding:8px 14px;background:rgba(79,140,255,0.08);border-bottom:1px solid var(--border,#333);font-size:11px;color:var(--text-dim,#aaa);">' +
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

    // Render preset buttons
    var presetWrap = panel.querySelector('#ai-presets');
    PRESETS.forEach(function(p) {
      var btn = document.createElement('button');
      btn.className = 'small ghost';
      btn.textContent = p.label;
      btn.style.cssText = 'font-size:11px;padding:5px 9px;border-radius:14px;';
      btn.onclick = function() {
        if (_streaming) return;
        var ta = panel.querySelector('#ai-input');
        ta.value = p.prompt;
        ta.focus();
      };
      presetWrap.appendChild(btn);
    });

    // Esc-to-close while focus is in the panel
    panel.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') close();
    });

    return panel;
  }

  function open(estimateId) {
    if (!estimateId) {
      alert('Save the estimate first to enable the AI assistant.');
      return;
    }
    var panel = ensurePanel();
    if (_estimateId !== estimateId) {
      _estimateId = estimateId;
      _messages = [];
      // Refresh conversation when switching estimates so we don't show
      // stale context from a previous estimate
      loadHistory();
    }
    panel.style.transform = 'translateX(0)';
    // Push the page content left so the panel doesn't cover the editor.
    // CSS class on body handles the layout; transition is smooth.
    document.body.classList.add('agx-ai-open');
    _open = true;
    setTimeout(function() {
      var inp = document.getElementById('ai-input');
      if (inp) inp.focus();
    }, 240);
    updatePhotoCount();
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
    if (!_estimateId || !window.agxApi) return;
    var box = document.getElementById('ai-messages');
    if (box) box.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;">Loading…</div>';
    fetch('/api/ai/estimates/' + encodeURIComponent(_estimateId) + '/messages', {
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
    if (!_estimateId) return;
    if (!confirm('Clear this conversation? Your messages on this estimate will be deleted.')) return;
    fetch('/api/ai/estimates/' + encodeURIComponent(_estimateId) + '/messages', {
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
      box.innerHTML =
        '<div style="color:var(--text-dim,#888);font-size:12px;padding:20px 0;text-align:center;line-height:1.6;">' +
          'Pick a preset below or ask anything about the estimate.<br>' +
          '<span style="font-size:11px;opacity:0.7;">I can see your line items, scope, client, and photos.</span>' +
        '</div>';
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
    if (!_estimateId) { alert('No estimate is open.'); return; }
    input.value = '';
    // Reset auto-grow height after clearing the value, so the textarea
    // collapses back to one row on submit instead of staying tall.
    input.style.height = 'auto';
    sendMessage(text);
  }

  function sendMessage(text) {
    var photoCount = countCurrentPhotos();
    _messages.push({
      role: 'user', content: text,
      photos_included: _includePhotos ? photoCount : 0
    });
    renderMessages();
    streamFromEndpoint(
      '/api/ai/estimates/' + encodeURIComponent(_estimateId) + '/chat',
      { message: text, includePhotos: _includePhotos }
    );
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
        } else if (payload.awaiting_approval) {
          pendingAssistantContent = payload.pending_assistant_content;
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

  function continueAfterProposals(pendingContent, responses) {
    streamFromEndpoint(
      '/api/ai/estimates/' + encodeURIComponent(_estimateId) + '/chat/continue',
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
    if (!el || !_estimateId || !window.agxApi) { if (el) el.textContent = ''; return; }
    window.agxApi.attachments.list('estimate', _estimateId).then(function(res) {
      var n = (res.attachments || []).length;
      // Add lead photos if estimate is linked to a lead
      var est = (window.appData && window.appData.estimates || []).find(function(e) { return e.id === _estimateId; });
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

  window.agxAI = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function() { return _open; }
  };
})();
