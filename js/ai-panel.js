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
      // Header
      '<div style="padding:14px 16px;border-bottom:1px solid var(--border,#333);background:linear-gradient(135deg,#0d1f12 0%,#14351d 100%);display:flex;align-items:center;gap:10px;">' +
        '<div style="font-size:14px;font-weight:700;color:#fff;flex:1;">&#x2728; AI Estimating Assistant</div>' +
        '<button id="ai-clear" title="Clear conversation" style="background:rgba(255,255,255,0.08);color:#ccc;border:1px solid rgba(255,255,255,0.15);border-radius:6px;padding:4px 8px;font-size:11px;cursor:pointer;">Clear</button>' +
        '<button id="ai-close" title="Close (Esc)" style="background:rgba(255,255,255,0.08);color:#fff;border:1px solid rgba(255,255,255,0.15);border-radius:6px;width:28px;height:28px;font-size:14px;cursor:pointer;">&times;</button>' +
      '</div>' +
      // Notice strip
      '<div style="padding:8px 14px;background:rgba(79,140,255,0.08);border-bottom:1px solid var(--border,#333);font-size:11px;color:var(--text-dim,#aaa);">' +
        'Read-only — I see your estimate and photos but cannot change anything. Apply suggestions by hand.' +
      '</div>' +
      // Messages scroll area
      '<div id="ai-messages" style="flex:1;overflow-y:auto;padding:14px 16px;display:flex;flex-direction:column;gap:10px;font-size:13px;color:var(--text,#e6e6e6);"></div>' +
      // Preset prompts
      '<div id="ai-presets" style="padding:8px 12px;border-top:1px solid var(--border,#333);display:flex;flex-wrap:wrap;gap:6px;background:rgba(255,255,255,0.02);"></div>' +
      // Input row
      '<div style="padding:10px 12px 12px;border-top:1px solid var(--border,#333);background:var(--card-bg,#0c0c14);">' +
        '<label style="display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:6px;cursor:pointer;">' +
          '<input id="ai-photos-toggle" type="checkbox" checked style="margin:0;" />' +
          '<span>Send photos with my message</span>' +
          '<span id="ai-photos-count" style="margin-left:auto;color:var(--text-dim,#888);"></span>' +
        '</label>' +
        '<div style="display:flex;gap:8px;align-items:flex-end;">' +
          '<textarea id="ai-input" rows="2" placeholder="Ask anything about this estimate…" style="flex:1;resize:none;background:transparent;border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;color:var(--text,#fff);font-size:13px;line-height:1.4;font-family:inherit;"></textarea>' +
          '<button id="ai-send" class="primary" style="padding:8px 14px;font-size:12px;">Send</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(panel);

    // Wire interactions
    panel.querySelector('#ai-close').onclick = close;
    panel.querySelector('#ai-clear').onclick = clearConversation;
    panel.querySelector('#ai-send').onclick = onSend;
    panel.querySelector('#ai-photos-toggle').onchange = function(e) { _includePhotos = !!e.target.checked; };
    var input = panel.querySelector('#ai-input');
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
    sendMessage(text);
  }

  function sendMessage(text) {
    var photoCount = countCurrentPhotos();
    // Optimistically push the user message into the visible list.
    _messages.push({
      role: 'user', content: text,
      photos_included: _includePhotos ? photoCount : 0
    });
    renderMessages();

    // Add a streaming placeholder under it
    var streamDiv = appendStreamingBubble();
    var contentEl = streamDiv && streamDiv.querySelector('[data-stream-content]');
    var assistantText = '';
    _streaming = true;
    setSendDisabled(true);

    _abortController = new AbortController();
    fetch('/api/ai/estimates/' + encodeURIComponent(_estimateId) + '/chat', {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ message: text, includePhotos: _includePhotos }),
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
          var box = document.getElementById('ai-messages');
          if (box) box.scrollTop = box.scrollHeight;
        } else if (payload.error) {
          if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">' + escapeHTMLLocal(payload.error) + '</span>';
        }
      });
    }).then(function() {
      // Drop the streaming placeholder and replace with a permanent bubble
      if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
      _messages.push({ role: 'assistant', content: assistantText || '(no response)' });
      renderMessages();
    }).catch(function(err) {
      if (err && err.name === 'AbortError') {
        if (streamDiv && streamDiv.parentNode) streamDiv.parentNode.removeChild(streamDiv);
      } else {
        if (contentEl) contentEl.innerHTML = '<span style="color:#f87171;">Error: ' + escapeHTMLLocal(err.message || 'unknown') + '</span>';
      }
    }).finally(function() {
      _streaming = false;
      setSendDisabled(false);
      _abortController = null;
    });
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

  // CSS for the cursor blink — appended once
  if (!document.getElementById('agx-ai-css')) {
    var style = document.createElement('style');
    style.id = 'agx-ai-css';
    style.textContent = '@keyframes agx-blink { from, to { opacity: 1; } 50% { opacity: 0; } } .ai-content p:first-child { margin-top: 0; } .ai-content p:last-child { margin-bottom: 0; }';
    document.head.appendChild(style);
  }

  window.agxAI = {
    open: open,
    close: close,
    toggle: toggle,
    isOpen: function() { return _open; }
  };
})();
