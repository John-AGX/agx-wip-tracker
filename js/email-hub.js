// Email Hub (H1) — the in-app inbox surface for the Email Dropbox.
//
// Renders into the #email-hub tab-content pane (registered in app.js's
// switchTab dispatch as renderEmailHubTab). A two-column inbox: thread
// list on the left, the full conversation on the right. Reads the
// personal dropbox via /api/email-inbox/threads (+ /threads/:id) — all
// owner-scoped server-side, so this UI never has to think about
// permissions. "Ask the assistant" hands a thread to the assistant
// chat pre-seeded (p86AI.open + prefill) so she reads it with her
// read_email_inbox tool and can summarize / draft / schedule from it.
//
// H2 (entity context) adds .entity_type/.entity_id/.entity_label to the
// thread rows; this file renders an entity chip when present and is a
// graceful no-op when absent, so H1 ships before H2 lands.
(function () {
  'use strict';

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtAgo(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return 'just now';
    if (s < 3600) return Math.floor(s / 60) + 'm ago';
    if (s < 86400) return Math.floor(s / 3600) + 'h ago';
    if (s < 604800) return Math.floor(s / 86400) + 'd ago';
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }
  function fmtWhen(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function ico(name, fallback) {
    return (window.p86Icon && window.p86Icon(name, { class: 'ehub-ico' })) || (fallback || '');
  }
  function api(path) {
    return fetch(path, { credentials: 'include' }).then(function (r) {
      return r.json().then(function (b) { if (!r.ok) throw new Error(b.error || ('HTTP ' + r.status)); return b; });
    });
  }

  var _state = { threads: [], activeThreadId: null, q: '' };

  function ensureStyles() {
    if (document.getElementById('p86-ehub-styles')) return;
    var st = document.createElement('style');
    st.id = 'p86-ehub-styles';
    st.textContent = [
      '.ehub{display:flex;flex-direction:column;height:100%;min-height:0;}',
      '.ehub-head{display:flex;align-items:center;gap:12px;padding:14px 16px 12px;flex-wrap:wrap;}',
      '.ehub-head h2{margin:0;font-size:19px;font-weight:700;}',
      '.ehub-sub{font-size:12px;color:var(--text-dim,#8b90a5);margin-left:2px;}',
      '.ehub-search{flex:1;min-width:180px;max-width:360px;margin-left:auto;}',
      '.ehub-search input{width:100%;box-sizing:border-box;padding:7px 11px;border-radius:8px;border:1px solid var(--border,#2a2a32);background:var(--input-bg,#101014);color:var(--text,#e4e6f0);font-size:13px;}',
      '.ehub-body{display:flex;flex:1;min-height:0;border-top:1px solid var(--border,#2a2a32);}',
      '.ehub-list{width:340px;flex:0 0 340px;overflow-y:auto;border-right:1px solid var(--border,#2a2a32);}',
      '.ehub-pane{flex:1;min-width:0;overflow-y:auto;padding:0;}',
      '.ehub-row{padding:11px 14px;border-bottom:1px solid var(--border,#23232b);cursor:pointer;display:flex;flex-direction:column;gap:3px;}',
      '.ehub-row:hover{background:var(--row-hover,#232329);}',
      '.ehub-row.active{background:var(--row-hover,#232329);box-shadow:inset 3px 0 0 var(--accent,#107C41);}',
      '.ehub-row-top{display:flex;align-items:baseline;gap:8px;}',
      '.ehub-row-from{font-weight:600;font-size:13px;color:var(--text,#e4e6f0);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-row-when{font-size:11px;color:var(--text-dim,#8b90a5);white-space:nowrap;}',
      '.ehub-row-subj{font-size:12.5px;color:var(--text,#d0d0d8);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-row-prev{font-size:11.5px;color:var(--text-dim,#8b90a5);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}',
      '.ehub-chip{display:inline-flex;align-items:center;gap:4px;font-size:10.5px;font-weight:600;padding:1px 7px;border-radius:10px;background:var(--surface2,#202027);border:1px solid var(--border,#2a2a32);color:var(--text-dim,#b4b4bf);cursor:pointer;}',
      '.ehub-chip:not(.ehub-chip-static):hover{color:var(--text,#e4e6f0);border-color:var(--accent,#107C41);}',
      '.ehub-chip-static{cursor:default;}',
      '.ehub-count{font-size:10px;font-weight:700;background:var(--surface2,#202027);border-radius:9px;padding:0 6px;color:var(--text-dim,#b4b4bf);}',
      '.ehub-row-chips{display:flex;flex-wrap:wrap;gap:5px;align-items:center;}',
      '.ehub-dot{width:7px;height:7px;border-radius:50%;background:var(--accent,#107C41);flex:0 0 auto;}',
      '.ehub-badge{font-size:10px;font-weight:700;padding:1px 7px;border-radius:9px;letter-spacing:.2px;}',
      '.ehub-badge-reply{background:rgba(16,124,65,.16);color:var(--accent,#5ddb7e);border:1px solid rgba(16,124,65,.4);}',
      '.ehub-badge-high{background:rgba(248,113,113,.14);color:#f87171;border:1px solid rgba(248,113,113,.4);}',
      '.ehub-row-triage{color:var(--text,#d0d0d8);font-style:italic;}',
      '.ehub-empty{padding:40px 24px;text-align:center;color:var(--text-dim,#8b90a5);font-size:13px;line-height:1.6;}',
      '.ehub-thead{position:sticky;top:0;background:var(--bg,#101014);padding:16px 20px 12px;border-bottom:1px solid var(--border,#2a2a32);z-index:1;}',
      '.ehub-thead h3{margin:0 0 6px;font-size:16px;font-weight:700;}',
      '.ehub-thead-meta{display:flex;align-items:center;gap:10px;flex-wrap:wrap;}',
      '.ehub-msg{padding:16px 20px;border-bottom:1px solid var(--border,#23232b);}',
      '.ehub-msg-hd{display:flex;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap;}',
      '.ehub-msg-from{font-weight:600;font-size:13px;}',
      '.ehub-msg-when{font-size:11px;color:var(--text-dim,#8b90a5);margin-left:auto;}',
      '.ehub-msg-fwd{font-size:10.5px;color:var(--text-dim,#8b90a5);background:var(--surface2,#202027);border-radius:8px;padding:1px 7px;}',
      '.ehub-msg-body{font-size:13px;line-height:1.55;white-space:pre-wrap;word-break:break-word;color:var(--text,#e4e6f0);}',
      // My own captured reply — a subtle "sent" treatment so both sides of
      // the conversation read at a glance.
      '.ehub-msg-mine{background:rgba(16,124,65,0.06);border-left:2px solid var(--accent,#107C41);}',
      '.ehub-msg-mine .ehub-msg-from{color:var(--accent,#5ddb7e);}',
      '.ehub-ask{padding:8px 15px;font-size:13px;font-weight:600;border-radius:8px;border:1px solid var(--accent,#107C41);background:rgba(16,124,65,0.14);color:var(--accent,#5ddb7e);cursor:pointer;display:inline-flex;align-items:center;gap:6px;}',
      '.ehub-ask:hover{background:rgba(16,124,65,0.24);}',
      '.ehub-ico{width:15px;height:15px;vertical-align:-2px;}',
      '@media (max-width:760px){',
      '.ehub-list{width:100%;flex-basis:100%;}',
      '.ehub-body.show-thread .ehub-list{display:none;}',
      '.ehub-body:not(.show-thread) .ehub-pane{display:none;}',
      '.ehub-back{display:inline-flex;}',
      '}',
      '.ehub-back{display:none;align-items:center;gap:5px;font-size:12px;color:var(--text-dim,#8b90a5);background:none;border:none;cursor:pointer;padding:0 0 8px;}',
    ].join('\n');
    document.head.appendChild(st);
  }

  // Types the hub can actually navigate to (has a real opener). A chip
  // for anything else renders as a static context label, not a
  // dead-looking clickable.
  function isNavigable(kind) {
    return kind === 'client' || kind === 'lead';
  }

  function renderEmailHubTab() {
    var pane = document.getElementById('email-hub');
    if (!pane) return;
    // Fresh view on every tab open: renderEmailHubTab rebuilds the DOM
    // (empty search box, placeholder pane), so reset the module state
    // too — otherwise a stale query would silently filter the list and a
    // stale activeThreadId would highlight a row with no open thread.
    _state.q = '';
    _state.activeThreadId = null;
    ensureStyles();
    pane.innerHTML =
      '<div class="ehub">' +
        '<div class="ehub-head">' +
          '<h2>Email</h2>' +
          '<span class="ehub-sub" id="ehubSub"></span>' +
          '<div class="ehub-search"><input type="text" id="ehubSearch" placeholder="Search sender, subject, body…" spellcheck="false"></div>' +
        '</div>' +
        '<div class="ehub-body" id="ehubBody">' +
          '<div class="ehub-list" id="ehubList"><div class="ehub-empty">Loading…</div></div>' +
          '<div class="ehub-pane" id="ehubPane"><div class="ehub-empty">Pick a conversation to read it here.</div></div>' +
        '</div>' +
      '</div>';

    var searchEl = pane.querySelector('#ehubSearch');
    var t = null;
    if (searchEl) searchEl.addEventListener('input', function () {
      clearTimeout(t);
      t = setTimeout(function () { _state.q = searchEl.value.trim(); loadThreads(); }, 280);
    });
    loadThreads();
    // Catch-up triage sweep: any emails whose background triage was lost
    // to a restart get processed now; refresh the list once done so the
    // needs-reply badges appear. Best-effort, fire-and-forget.
    if (!_state.sweptOnce) {
      _state.sweptOnce = true;
      fetch('/api/email-inbox/triage-pending', { method: 'POST', credentials: 'include' })
        .then(function (r) { return r.json(); })
        .then(function (res) { if (res && res.triaged > 0) loadThreads(); })
        .catch(function () {});
    }
  }

  function loadThreads() {
    var listEl = document.getElementById('ehubList');
    if (!listEl) return;
    var url = '/api/email-inbox/threads?limit=50' + (_state.q ? '&q=' + encodeURIComponent(_state.q) : '');
    api(url).then(function (res) {
      _state.threads = (res && res.threads) || [];
      paintList();
    }).catch(function (e) {
      listEl.innerHTML = '<div class="ehub-empty">Could not load email.<br><span style="font-size:11.5px;">' + esc(e.message || '') + '</span></div>';
    });
  }

  function paintList() {
    var listEl = document.getElementById('ehubList');
    var subEl = document.getElementById('ehubSub');
    if (!listEl) return;
    if (subEl) subEl.textContent = _state.threads.length
      ? (_state.threads.length + (_state.threads.length === 1 ? ' conversation' : ' conversations'))
      : '';
    if (!_state.threads.length) {
      listEl.innerHTML = _state.q
        ? '<div class="ehub-empty">No conversations match &ldquo;' + esc(_state.q) + '&rdquo;.</div>'
        : '<div class="ehub-empty">Your email dropbox is empty.<br><br>Set up forwarding from <strong>My Account &rarr; Email Dropbox</strong> — redirect a copy of your inbox to your private address and it lands here.</div>';
      return;
    }
    listEl.innerHTML = _state.threads.map(function (th) {
      var nav = th.entity_label && isNavigable(th.entity_type);
      var chip = th.entity_label
        ? '<span class="ehub-chip' + (nav ? '' : ' ehub-chip-static') + '"' +
            (nav ? ' data-entity-type="' + esc(th.entity_type) + '" data-entity-id="' + esc(th.entity_id) + '"' : '') +
            '>' + ico('clients', '') + esc(th.entity_label) + '</span>'
        : '';
      // H3 triage chips: "needs reply" + an urgency dot for high. needs_reply
      // now reflects the newest INBOUND message (server-side), so a captured
      // reply of mine can't hide a client who is genuinely waiting.
      var tri = '';
      if (th.needs_reply) tri += '<span class="ehub-badge ehub-badge-reply">needs reply</span>';
      if (th.triage_urgency === 'high') tri += '<span class="ehub-badge ehub-badge-high">high</span>';
      var chips = chip + tri;
      return '<div class="ehub-row' + (th.thread_id === _state.activeThreadId ? ' active' : '') + '" data-thread="' + esc(th.thread_id) + '">' +
        '<div class="ehub-row-top">' +
          (th.needs_reply ? '<span class="ehub-dot" title="Needs a reply"></span>' : '') +
          '<span class="ehub-row-from">' + (th.last_direction === 'outbound'
            ? ('You' + (th.entity_label ? ' → ' + esc(th.entity_label) : ''))
            : esc(th.last_from || 'unknown')) + '</span>' +
          (th.message_count > 1 ? '<span class="ehub-count">' + th.message_count + '</span>' : '') +
          '<span class="ehub-row-when">' + esc(fmtAgo(th.last_received_at)) + '</span>' +
        '</div>' +
        '<div class="ehub-row-subj">' + esc(th.subject || '(no subject)') + '</div>' +
        (chips ? '<div class="ehub-row-chips">' + chips + '</div>' : '') +
        (th.triage_summary
          ? '<div class="ehub-row-prev ehub-row-triage">' + esc(th.triage_summary) + '</div>'
          : (th.preview ? '<div class="ehub-row-prev">' + esc(String(th.preview).replace(/\s+/g, ' ').trim()) + '</div>' : '')) +
      '</div>';
    }).join('');

    listEl.querySelectorAll('.ehub-row').forEach(function (row) {
      row.addEventListener('click', function (e) {
        // Only a NAVIGABLE chip handles its own click; a static chip
        // falls through so the row opens the thread.
        if (e.target.closest('.ehub-chip:not(.ehub-chip-static)')) return;
        openThread(row.getAttribute('data-thread'));
      });
    });
    // Only navigable chips (client/lead) get a click handler; static
    // chips (e.g. sub) are labels and let the row's own click open the
    // thread instead of swallowing it.
    listEl.querySelectorAll('.ehub-chip:not(.ehub-chip-static)').forEach(function (chip) {
      chip.addEventListener('click', function (e) {
        e.stopPropagation();
        openEntity(chip.getAttribute('data-entity-type'), chip.getAttribute('data-entity-id'));
      });
    });
  }

  function openThread(threadId) {
    _state.activeThreadId = threadId;
    paintList();
    var pane = document.getElementById('ehubPane');
    var body = document.getElementById('ehubBody');
    if (body) body.classList.add('show-thread');
    if (!pane) return;
    pane.innerHTML = '<div class="ehub-empty">Loading conversation…</div>';
    api('/api/email-inbox/threads/' + encodeURIComponent(threadId)).then(function (res) {
      var msgs = (res && res.messages) || [];
      if (!msgs.length) { pane.innerHTML = '<div class="ehub-empty">This conversation is empty.</div>'; return; }
      var subject = msgs[msgs.length - 1].subject || '(no subject)';
      var head =
        '<div class="ehub-thead">' +
          '<button class="ehub-back" data-back>' + ico('align-left', '&#8592;') + ' Inbox</button>' +
          '<h3>' + esc(subject) + '</h3>' +
          '<div class="ehub-thead-meta">' +
            '<span class="ehub-sub">' + msgs.length + (msgs.length === 1 ? ' message' : ' messages') + '</span>' +
            '<button class="ehub-ask" data-ask>' + ico('sparkle', '') + ' Ask the assistant about this</button>' +
          '</div>' +
        '</div>';
      var bodyHtml = msgs.map(function (m) {
        // Outbound = my own reply, captured via BCC → show it as "You".
        var isMine = m.direction === 'outbound';
        var who = isMine
          ? 'You' + (m.entity_label ? ' <span class="ehub-msg-fwd">to ' + esc(m.entity_label) + '</span>' : '')
          : (m.orig_from_email
              ? esc(m.from_email || 'unknown') + ' <span class="ehub-msg-fwd">originally from ' + esc(m.orig_from_email) + '</span>'
              : esc((m.from_name ? m.from_name + ' ' : '') + '<' + (m.from_email || 'unknown') + '>'));
        return '<div class="ehub-msg' + (isMine ? ' ehub-msg-mine' : '') + '">' +
          '<div class="ehub-msg-hd">' +
            '<span class="ehub-msg-from">' + who + '</span>' +
            (!isMine && m.is_forward_wrapper ? '<span class="ehub-msg-fwd">forwarded copy</span>' : '') +
            '<span class="ehub-msg-when">' + esc(fmtWhen(m.received_at)) + '</span>' +
          '</div>' +
          '<div class="ehub-msg-body">' + esc(m.body_text || '(no text body)') + '</div>' +
        '</div>';
      }).join('');
      pane.innerHTML = head + bodyHtml;
      var backBtn = pane.querySelector('[data-back]');
      if (backBtn) backBtn.addEventListener('click', function () { if (body) body.classList.remove('show-thread'); });
      var askBtn = pane.querySelector('[data-ask]');
      if (askBtn) askBtn.addEventListener('click', function () { handToAssistant(threadId, subject); });
    }).catch(function (e) {
      pane.innerHTML = '<div class="ehub-empty">Could not load that conversation.<br>' + esc(e.message || '') + '</div>';
    });
  }

  // Route an entity chip to that record's detail view via the app's
  // real openers. Clients use the global dashboard opener; sub/lead fall
  // through gracefully (the chip stays a context label rather than
  // throwing). p86EntityCard has no imperative show() — it only renders
  // markup for a caller-owned popover — so we navigate instead.
  function openEntity(kind, id) {
    if (!id) return;
    if (kind === 'client' && typeof window.openClientDashboard === 'function') {
      window.openClientDashboard(id);
    } else if (kind === 'lead' && typeof window.openEditLeadModal === 'function') {
      if (typeof window.switchTab === 'function') window.switchTab('estimates');
      window.openEditLeadModal(id);
    }
    // Sub / unknown: no dedicated opener today — the chip is informational.
  }

  // Open the assistant chat pre-seeded to read this thread. She has the
  // read_email_inbox tool, so naming the thread id lets her pull the
  // full conversation and summarize / draft / schedule from it.
  function handToAssistant(threadId, subject) {
    var prompt = 'Read my email thread [' + threadId + '] ("' + subject + '") and give me a short summary — what it\'s asking, anything time-sensitive, and whether it needs a reply. If there\'s a date or a commitment, offer to add a reminder or calendar event.';
    if (!(window.p86AI && window.p86AI.open)) {
      alert('Open the assistant (Ask 86) and ask about thread ' + threadId + '.');
      return;
    }
    // ask86 mode is entity-free (same as the header "Ask 86" button); no
    // images, so open + prefill the input rather than openWithImages.
    window.p86AI.open({ entityType: 'ask86' });
    setTimeout(function () {
      var input = document.getElementById('ai-input');
      if (input) { input.value = prompt; input.dispatchEvent(new Event('input')); input.focus(); input.setSelectionRange(input.value.length, input.value.length); }
    }, 300);
  }

  window.renderEmailHubTab = renderEmailHubTab;
  window.p86EmailHub = { render: renderEmailHubTab, open: renderEmailHubTab };
})();
