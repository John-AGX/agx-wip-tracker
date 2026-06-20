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
          '<button type="button" data-new-msg class="primary" style="padding:5px 12px;font-size:12px;font-weight:600;">&#x270E; New message</button>' +
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
    var newBtn = modal.querySelector('[data-new-msg]');
    if (newBtn) newBtn.addEventListener('click', function() { startNewMessage(listEl, threadEl); });

    loadInboxList(listEl, threadEl);
  }

  // ──────────────────────────────────────────────────────────────────
  // Direct-message helpers — start a DM with another org user. The
  // canonical thread key is dm:<lowId>:<highId> (sorted) so both
  // participants resolve to the SAME thread regardless of who opens it.
  // ──────────────────────────────────────────────────────────────────
  function sortedDmKey(otherId) {
    var me = Number(currentUserId());
    var other = Number(otherId);
    if (!me || !other || me === other) return null;
    var lo = Math.min(me, other), hi = Math.max(me, other);
    return 'dm:' + lo + ':' + hi;
  }

  // Org-user cache for the recipient picker. Reuses the same endpoint
  // the tasks assignee picker uses; cached for the session.
  var _msgUsers = null, _msgUsersPromise = null;
  function loadOrgUsers() {
    if (_msgUsers) return Promise.resolve(_msgUsers);
    if (_msgUsersPromise) return _msgUsersPromise;
    if (!window.p86Api || !window.p86Api.users) return Promise.resolve([]);
    _msgUsersPromise = window.p86Api.users.list().then(function(res) {
      _msgUsers = (res && res.users) || [];
      return _msgUsers;
    }).catch(function() { _msgUsers = []; return _msgUsers; });
    return _msgUsersPromise;
  }

  // Open the DM thread with `otherId` in the given thread panel, and
  // refresh the surrounding inbox list. Used by both surfaces.
  function startDm(otherId, otherName, listEl, threadEl, onThreadOpen) {
    var key = sortedDmKey(otherId);
    if (!key) return;
    renderThreadIntoPanel(threadEl, key, {
      title: otherName || 'Direct message',
      autofocus: true,
      onPosted: function() {
        if (listEl) loadInboxList(listEl, threadEl, onThreadOpen);
        refreshNavMessagesBadge();
        if (typeof window.refreshSummaryUnreadBadge === 'function') window.refreshSummaryUnreadBadge();
      }
    });
    if (typeof onThreadOpen === 'function') onThreadOpen();
  }

  // Recipient picker → start a DM. Lists org users (minus self),
  // type-to-filter, click to open the conversation.
  function startNewMessage(listEl, threadEl, onThreadOpen) {
    var prior = document.getElementById('msgRecipientModal');
    if (prior) prior.remove();
    var me = Number(currentUserId());

    var modal = document.createElement('div');
    modal.id = 'msgRecipientModal';
    modal.className = 'modal active';
    modal.style.zIndex = '10050';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:420px;width:92vw;max-height:70vh;display:flex;flex-direction:column;padding:0;">' +
        '<div style="padding:12px 16px;border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:10px;">' +
          '<strong style="font-size:14px;flex:1;">New message</strong>' +
          '<button type="button" data-close style="background:transparent;border:none;color:var(--text-dim,#888);font-size:20px;cursor:pointer;padding:0 4px;">&times;</button>' +
        '</div>' +
        '<div style="padding:10px 14px;border-bottom:1px solid var(--border,#222);">' +
          '<input type="text" data-recip-search placeholder="Search teammates&hellip;" style="width:100%;padding:8px 10px;font-size:13px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);" />' +
        '</div>' +
        '<div data-recip-list style="flex:1;overflow-y:auto;background:var(--card-bg,#0f0f1e);">' +
          '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;text-align:center;">Loading teammates&hellip;</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) { b.addEventListener('click', function() { modal.remove(); }); });

    var searchEl = modal.querySelector('[data-recip-search]');
    var recipListEl = modal.querySelector('[data-recip-list]');

    loadOrgUsers().then(function(users) {
      var people = (users || []).filter(function(u) { return Number(u.id) !== me && u.role !== 'sub'; });
      function paint(filter) {
        var f = (filter || '').trim().toLowerCase();
        var rows = people.filter(function(u) {
          if (!f) return true;
          return String(u.name || '').toLowerCase().indexOf(f) !== -1 ||
                 String(u.email || '').toLowerCase().indexOf(f) !== -1;
        });
        if (!rows.length) {
          recipListEl.innerHTML = '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;text-align:center;">' +
            (people.length ? 'No matches.' : 'No teammates to message yet.') + '</div>';
          return;
        }
        var html = '';
        rows.forEach(function(u) {
          var nm = u.name || u.email || ('User ' + u.id);
          html += '<button class="msg-recip-row" data-uid="' + escapeAttr(u.id) + '" data-uname="' + escapeAttr(nm) + '" ' +
            'style="display:flex;align-items:center;gap:10px;width:100%;text-align:left;padding:10px 14px;background:transparent;border:none;border-bottom:1px solid var(--border,#222);color:var(--text,#fff);cursor:pointer;">' +
            '<span style="width:28px;height:28px;border-radius:50%;background:rgba(34,211,238,0.18);color:var(--accent,#22d3ee);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + escapeHTML(initials(nm)) + '</span>' +
            '<span style="overflow:hidden;"><span style="display:block;font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(nm) + '</span>' +
            (u.email ? '<span style="display:block;font-size:11px;color:var(--text-dim,#888);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(u.email) + '</span>' : '') + '</span>' +
          '</button>';
        });
        recipListEl.innerHTML = html;
        recipListEl.querySelectorAll('.msg-recip-row').forEach(function(btn) {
          btn.addEventListener('mouseenter', function() { btn.style.background = 'rgba(34,211,238,0.06)'; });
          btn.addEventListener('mouseleave', function() { btn.style.background = 'transparent'; });
          btn.addEventListener('click', function() {
            var uid = btn.getAttribute('data-uid');
            var uname = btn.getAttribute('data-uname');
            modal.remove();
            startDm(uid, uname, listEl, threadEl, onThreadOpen);
          });
        });
      }
      paint('');
      searchEl.addEventListener('input', function() { paint(searchEl.value); });
      setTimeout(function() { searchEl.focus(); }, 50);
    });
  }

  function initials(name) {
    var parts = String(name || '').trim().split(/\s+/).filter(Boolean);
    if (!parts.length) return '?';
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function loadInboxList(listEl, threadEl, onThreadOpen) {
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
            loadInboxList(listEl, threadEl, onThreadOpen);
            // bump the badges (summary card + sidebar nav)
            if (typeof window.refreshSummaryUnreadBadge === 'function') {
              window.refreshSummaryUnreadBadge();
            }
            refreshNavMessagesBadge();
          } });
          // Opening a thread also clears its unread once painted; keep the
          // sidebar badge honest.
          refreshNavMessagesBadge();
          if (typeof onThreadOpen === 'function') onThreadOpen();
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

  // ──────────────────────────────────────────────────────────────────
  // One-time styles for the full-page Messages surface (#messages tab).
  // Self-contained so the module owns its own look; responsive so the
  // two-column inbox collapses to a single column on phones.
  // ──────────────────────────────────────────────────────────────────
  function ensurePageStyles() {
    if (document.getElementById('p86-messaging-styles')) return;
    var css =
      '#messages .msg-page{display:flex;flex-direction:column;height:calc(100vh - 130px);min-height:420px;}' +
      '#messages .msg-page-head{display:flex;align-items:center;gap:10px;padding:0 4px 12px;}' +
      '#messages .msg-page-head h2{margin:0;font-size:19px;flex:1;}' +
      '#messages .msg-page-body{flex:1;display:grid;grid-template-columns:300px minmax(0,1fr);gap:0;border:1px solid var(--border,#2a2a3a);border-radius:10px;overflow:hidden;background:var(--card-bg,#0f0f1e);}' +
      '#messages .msg-page-list{border-right:1px solid var(--border,#2a2a3a);overflow-y:auto;}' +
      '#messages .msg-page-thread{overflow:hidden;display:flex;flex-direction:column;}' +
      '#messages .msg-page-back{display:none;}' +
      '@media (max-width:640px){' +
        '#messages .msg-page{height:calc(100vh - 150px);}' +
        '#messages .msg-page-body{grid-template-columns:minmax(0,1fr);}' +
        '#messages .msg-page-body.show-thread .msg-page-list{display:none;}' +
        '#messages .msg-page-body:not(.show-thread) .msg-page-thread{display:none;}' +
        '#messages .msg-page-back{display:inline-flex;align-items:center;gap:4px;background:transparent;border:none;color:var(--accent,#22d3ee);font-size:13px;cursor:pointer;padding:6px 4px;}' +
      '}';
    var st = document.createElement('style');
    st.id = 'p86-messaging-styles';
    st.textContent = css;
    document.head.appendChild(st);
  }

  // Full-page inbox — rendered into the #messages tab-content pane.
  // Same two-column model as the modal, but persistent and responsive.
  function renderMessagesTab() {
    var pane = document.getElementById('messages');
    if (!pane) return;
    ensurePageStyles();
    pane.innerHTML =
      '<div class="msg-page">' +
        '<div class="msg-page-head">' +
          '<button type="button" class="msg-page-back" data-page-back>&#8592; Inbox</button>' +
          '<h2>Messages</h2>' +
          '<button type="button" data-new-msg class="primary" style="padding:7px 14px;font-size:13px;font-weight:600;">&#x270E; New message</button>' +
        '</div>' +
        '<div class="msg-page-body">' +
          '<div class="msg-page-list" id="msgPageList">' +
            '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;text-align:center;">Loading threads&hellip;</div>' +
          '</div>' +
          '<div class="msg-page-thread" id="msgPageThread">' +
            '<div style="padding:32px;color:var(--text-dim,#888);font-size:12px;text-align:center;">Pick a conversation, or start a new message.</div>' +
          '</div>' +
        '</div>' +
      '</div>';

    var bodyEl = pane.querySelector('.msg-page-body');
    var listEl = pane.querySelector('#msgPageList');
    var threadEl = pane.querySelector('#msgPageThread');
    var newBtn = pane.querySelector('[data-new-msg]');
    var backBtn = pane.querySelector('[data-page-back]');

    // On mobile the list and thread share the viewport — opening a
    // thread swaps to the thread view; Back returns to the list.
    function showThreadMobile() { if (bodyEl) bodyEl.classList.add('show-thread'); }
    if (backBtn) backBtn.addEventListener('click', function() { if (bodyEl) bodyEl.classList.remove('show-thread'); });

    if (newBtn) newBtn.addEventListener('click', function() {
      startNewMessage(listEl, threadEl, showThreadMobile);
    });

    // loadInboxList wires row clicks to renderThreadIntoPanel(threadEl,…);
    // the onThreadOpen callback flips the mobile view on selection.
    loadInboxList(listEl, threadEl, showThreadMobile);
    refreshNavMessagesBadge();
  }

  // Update the sidebar "Messages" nav badge with the unread total.
  // Defensive: no-ops if the nav button isn't present.
  function refreshNavMessagesBadge() {
    getTotalUnread().then(function(n) {
      var badge = document.getElementById('navMessagesBadge');
      if (!badge) return;
      if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = '';
      } else {
        badge.textContent = '';
        badge.style.display = 'none';
      }
    }).catch(function() {});
  }

  window.p86Messaging = {
    openInbox: openInbox,
    mountInline: mountInline,
    getTotalUnread: getTotalUnread,
    renderMessagesTab: renderMessagesTab,
    refreshNavBadge: refreshNavMessagesBadge,
    startNewMessage: startNewMessage
  };
  window.renderMessagesTab = renderMessagesTab;

  // Keep the nav badge fresh: on auth-ready and on a light interval.
  document.addEventListener('p86:auth-ready', function() { refreshNavMessagesBadge(); });
  if (!window._p86MsgBadgeTimer) {
    window._p86MsgBadgeTimer = setInterval(function() {
      if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
        refreshNavMessagesBadge();
      }
    }, 90 * 1000);
  }
})();
