// Project 86 messaging UI.
//
// Two surfaces:
//   1. window.p86Messaging.openInbox() — modal showing recent threads
//      (left column) and the selected thread + compose (right column).
//   2. window.p86Messaging.mountInline(containerEl, threadKey, opts)
//      — embeds a thread + compose into any container (used by the
//      job detail page's Comments slot, future per-lead/estimate
//      surfaces, etc.). Options:
//        { title, autofocus, onPosted }
//
// Both surfaces talk to /api/messages via p86Api.messages.*.
// Polling is intentionally not built in — the user re-opens or clicks
// the thread to refresh; a background-fetch tick can land in v2.

(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  function timeAgo(ts) {
    var t = ts ? new Date(ts).getTime() : NaN;
    if (!isFinite(t)) return '';
    var diff = Math.max(0, Date.now() - t);
    if (diff < 60 * 1000) return 'just now';
    if (diff < 60 * 60 * 1000) return Math.floor(diff / (60 * 1000)) + 'm ago';
    if (diff < 24 * 60 * 60 * 1000) return Math.floor(diff / (60 * 60 * 1000)) + 'h ago';
    if (diff < 7 * 24 * 60 * 60 * 1000) return Math.floor(diff / (24 * 60 * 60 * 1000)) + 'd ago';
    return new Date(ts).toLocaleDateString();
  }

  function currentUserId() {
    var u = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    return u ? u.id : null;
  }

  // ──────────────────────────────────────────────────────────────────
  // Inbox modal — left list of threads, right pane shows the selected
  // thread + compose. Updates the summary unread badge after read /
  // post by re-firing renderSummaryDashboard if present.
  // ──────────────────────────────────────────────────────────────────
  function openInbox() {
    var prior = document.getElementById('messagingInboxModal');
    if (prior) prior.remove();

    var modal = document.createElement('div');
    modal.id = 'messagingInboxModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:920px;width:96vw;height:80vh;max-height:720px;display:flex;flex-direction:column;padding:0;">' +
        '<div style="padding:12px 18px;border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:10px;">' +
          '<strong style="font-size:15px;flex:1;">Inbox</strong>' +
          '<button type="button" data-close style="background:transparent;border:none;color:var(--text-dim,#888);font-size:20px;cursor:pointer;padding:0 4px;">&times;</button>' +
        '</div>' +
        '<div style="flex:1;display:grid;grid-template-columns:280px minmax(0,1fr);overflow:hidden;">' +
          '<div id="msgInboxList" style="border-right:1px solid var(--border,#333);overflow-y:auto;background:var(--card-bg,#0f0f1e);">' +
            '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;text-align:center;">Loading threads&hellip;</div>' +
          '</div>' +
          '<div id="msgInboxThread" style="overflow:hidden;display:flex;flex-direction:column;">' +
            '<div style="padding:32px;color:var(--text-dim,#888);font-size:12px;text-align:center;">Pick a thread to view it.</div>' +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);

    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });

    var listEl = modal.querySelector('#msgInboxList');
    var threadEl = modal.querySelector('#msgInboxThread');

    loadInboxList(listEl, threadEl);
  }

  function loadInboxList(listEl, threadEl) {
    if (!window.p86Api || !window.p86Api.messages) {
      listEl.innerHTML = '<div style="padding:18px;color:#f87171;font-size:12px;">Messaging API not available.</div>';
      return;
    }
    window.p86Api.messages.recent().then(function(res) {
      var threads = (res && res.threads) || [];
      if (!threads.length) {
        listEl.innerHTML =
          '<div style="padding:24px 16px;color:var(--text-dim,#888);font-size:12px;text-align:center;line-height:1.5;">' +
            '<div style="font-size:28px;margin-bottom:6px;">&#x1F4ED;</div>' +
            '<div>No conversations yet.</div>' +
            '<div style="margin-top:6px;">Open a job, lead, or estimate to start a thread.</div>' +
          '</div>';
        return;
      }
      var html = '';
      threads.forEach(function(t) {
        var unread = Number(t.unread_count || 0);
        var preview = (t.last_body || '').replace(/\s+/g, ' ').slice(0, 70);
        var who = t.last_user_name || 'Someone';
        html += '<button class="msg-thread-row" data-key="' + escapeAttr(t.thread_key) + '" data-label="' + escapeAttr(t.label || '') + '" ' +
          'style="display:block;width:100%;text-align:left;padding:10px 14px;background:transparent;border:none;border-bottom:1px solid var(--border,#222);color:var(--text,#fff);cursor:pointer;">' +
          '<div style="display:flex;align-items:center;gap:6px;margin-bottom:2px;">' +
            '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--accent,#22d3ee);">' + escapeHTML(t.kind || 'thread') + '</span>' +
            (unread ? '<span style="margin-left:auto;background:#f87171;color:#fff;font-size:10px;font-weight:700;padding:1px 7px;border-radius:10px;line-height:1.4;">' + unread + '</span>'
                    : '<span style="margin-left:auto;font-size:10px;color:var(--text-dim,#888);">' + escapeHTML(timeAgo(t.last_created_at)) + '</span>') +
          '</div>' +
          '<div style="font-size:12px;font-weight:600;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(t.label || t.thread_key) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">' +
            escapeHTML(who) + ': ' + escapeHTML(preview) +
          '</div>' +
        '</button>';
      });
      listEl.innerHTML = html;
      listEl.querySelectorAll('.msg-thread-row').forEach(function(btn) {
        btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(34,211,238,0.06)'; });
        btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
        btn.addEventListener('click', function() {
          var key = btn.getAttribute('data-key');
          var label = btn.getAttribute('data-label');
          listEl.querySelectorAll('.msg-thread-row').forEach(function(b) { b.style.background = 'transparent'; });
          btn.style.background = 'rgba(34,211,238,0.10)';
          renderThreadIntoPanel(threadEl, key, { title: label, autofocus: true, onPosted: function() {
            // refresh list to update unread + last message
            loadInboxList(listEl, threadEl);
            // bump the summary badge if we're on summary
            if (typeof window.refreshSummaryUnreadBadge === 'function') {
              window.refreshSummaryUnreadBadge();
            }
          } });
        });
      });
    }).catch(function(err) {
      listEl.innerHTML = '<div style="padding:18px;color:#f87171;font-size:12px;">Could not load: ' + escapeHTML(err.message || '') + '</div>';
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Thread renderer — used both inside the inbox modal (right pane)
  // and embedded inline via mountInline.
  // ──────────────────────────────────────────────────────────────────
  function renderThreadIntoPanel(panelEl, threadKey, opts) {
    opts = opts || {};
    panelEl.innerHTML =
      '<div style="padding:10px 14px;border-bottom:1px solid var(--border,#333);font-size:13px;font-weight:600;color:var(--text,#fff);display:flex;align-items:center;gap:8px;">' +
        '<span style="font-size:9px;font-weight:700;text-transform:uppercase;letter-spacing:0.4px;color:var(--accent,#22d3ee);background:rgba(34,211,238,0.10);padding:2px 6px;border-radius:4px;">Thread</span>' +
        '<span data-thread-title style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(opts.title || threadKey) + '</span>' +
      '</div>' +
      '<div data-thread-list style="flex:1;overflow-y:auto;padding:12px 14px;background:var(--card-bg,#0f0f1e);">' +
        '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:20px;">Loading&hellip;</div>' +
      '</div>' +
      '<div style="border-top:1px solid var(--border,#333);padding:10px;display:flex;gap:8px;background:var(--surface,#1a1d27);">' +
        '<textarea data-thread-input rows="2" placeholder="Write a message&hellip;" style="flex:1;padding:8px 10px;font-size:13px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);resize:none;font-family:inherit;"></textarea>' +
        '<button data-thread-send class="primary" style="padding:6px 14px;font-size:13px;align-self:stretch;">Send</button>' +
      '</div>';

    var listEl = panelEl.querySelector('[data-thread-list]');
    var inputEl = panelEl.querySelector('[data-thread-input]');
    var sendBtn = panelEl.querySelector('[data-thread-send]');

    function loadAndPaint() {
      window.p86Api.messages.thread(threadKey).then(function(res) {
        var msgs = (res && res.messages) || [];
        if (!msgs.length) {
          listEl.innerHTML = '<div style="text-align:center;color:var(--text-dim,#888);font-size:12px;padding:30px 12px;font-style:italic;">No messages yet. Start the thread.</div>';
        } else {
          var me = currentUserId();
          var html = '';
          msgs.forEach(function(m) {
            var mine = m.user_id === me;
            var name = m.user_name || m.user_email || 'User';
            html += '<div style="display:flex;flex-direction:column;align-items:' + (mine ? 'flex-end' : 'flex-start') + ';margin-bottom:10px;">' +
              '<div style="font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">' +
                escapeHTML(mine ? 'You' : name) + ' &middot; ' + escapeHTML(timeAgo(m.created_at)) +
              '</div>' +
              '<div style="max-width:80%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.45;color:var(--text,#fff);background:' + (mine ? 'rgba(34,211,238,0.16)' : 'rgba(255,255,255,0.05)') + ';white-space:pre-wrap;word-break:break-word;">' +
                escapeHTML(m.body) +
              '</div>' +
            '</div>';
          });
          listEl.innerHTML = html;
          listEl.scrollTop = listEl.scrollHeight;
        }
        // mark thread as read on every paint
        window.p86Api.messages.markRead(threadKey).catch(function() {});
      }).catch(function(err) {
        listEl.innerHTML = '<div style="padding:14px;color:#f87171;font-size:12px;">Could not load: ' + escapeHTML(err.message || '') + '</div>';
      });
    }

    function send() {
      var body = (inputEl.value || '').trim();
      if (!body) return;
      sendBtn.disabled = true;
      var prevText = sendBtn.textContent;
      sendBtn.textContent = 'Sending&hellip;';
      window.p86Api.messages.post(threadKey, body).then(function() {
        inputEl.value = '';
        loadAndPaint();
        if (typeof opts.onPosted === 'function') opts.onPosted();
      }).catch(function(err) {
        alert('Send failed: ' + (err.message || ''));
      }).finally(function() {
        sendBtn.disabled = false;
        sendBtn.textContent = prevText;
      });
    }

    sendBtn.addEventListener('click', send);
    inputEl.addEventListener('keydown', function(e) {
      // Ctrl/Cmd+Enter sends; plain Enter inserts a newline (multi-line ok).
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
        e.preventDefault();
        send();
      }
    });

    if (opts.autofocus) setTimeout(function() { inputEl.focus(); }, 50);
    loadAndPaint();
  }

  // Embed a thread inline into a host element. Caller controls the
  // surrounding chrome; we just render the thread + compose box.
  function mountInline(host, threadKey, opts) {
    if (!host) return;
    opts = opts || {};
    host.innerHTML = '';
    host.style.display = 'flex';
    host.style.flexDirection = 'column';
    if (!host.style.minHeight) host.style.minHeight = '320px';
    renderThreadIntoPanel(host, threadKey, opts);
  }

  // Just-the-unread-count fetch — used by the Summary inbox card so
  // the badge doesn't require a full thread list load.
  function getTotalUnread() {
    if (!window.p86Api || !window.p86Api.messages) return Promise.resolve(0);
    return window.p86Api.messages.recent()
      .then(function(res) { return Number((res && res.total_unread) || 0); })
      .catch(function() { return 0; });
  }

  window.p86Messaging = {
    openInbox: openInbox,
    mountInline: mountInline,
    getTotalUnread: getTotalUnread
  };
})();
