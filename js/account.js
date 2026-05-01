// My Account modal — currently houses notification preferences only.
// Mounted from the "Account" button in the header (index.html).
//
// Notification prefs are an opt-OUT model: a missing key (or true)
// means "send me this", false means "mute". The server-side senders
// (server/email-templates.js callers in routes) check
// users.notification_prefs[event_key] === false to suppress.
//
// Event keys today (mirror server/email-templates.js exports + their
// route call-sites):
//   schedule_assignment    — added to a schedule entry's crew
//   job_assignment         — assigned a job as PM
//   password_reset         — admin reset your password
//   new_user_invite        — initial invite (can't really mute the
//                            first one — included for completeness)

(function() {
  'use strict';

  // Shape: {
  //   schedule_assignment: bool, job_assignment: bool,
  //   password_reset: bool, new_user_invite: bool
  // }
  // false = muted; missing or true = send.
  var EVENT_DEFS = [
    {
      key: 'schedule_assignment',
      label: 'Schedule assignments',
      desc: 'When someone adds you to a production day on the Schedule page.'
    },
    {
      key: 'job_assignment',
      label: 'Job assignments',
      desc: 'When you\'re assigned (or reassigned) as the PM on a job.'
    },
    {
      key: 'password_reset',
      label: 'Password resets',
      desc: 'When an admin resets your password. Recommended to leave on.',
      lockedOn: false // recommend on but allow opt-out
    }
  ];

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  // Open the My Account modal. Pre-loads the user's current prefs from
  // /api/auth/users (already cached by admin module if available) and
  // saves on toggle.
  function openMyAccount() {
    if (!window.agxApi || !window.agxApi.isAuthenticated || !window.agxApi.isAuthenticated()) {
      alert('Sign in to manage your account.');
      return;
    }
    var me = (window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser()) || null;
    if (!me) {
      alert('Sign in to manage your account.');
      return;
    }

    var prior = document.getElementById('agxAccountModal');
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = 'agxAccountModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header">My Account</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;font-size:13px;color:var(--text-dim,#aaa);margin-bottom:14px;">' +
          '<div><strong style="color:var(--text);">' + escapeHTML(me.name || '') + '</strong></div>' +
          '<div style="font-family:monospace;font-size:12px;">' + escapeHTML(me.email || '') + '</div>' +
        '</div>' +
        '<div style="border-top:1px solid var(--border,#333);padding-top:14px;">' +
          '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#aaa);margin-bottom:10px;">Email notifications</div>' +
          '<div id="agx-acct-prefs" style="display:flex;flex-direction:column;gap:14px;">' +
            '<div style="font-size:11px;color:var(--text-dim,#888);">Loading…</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">' +
          '<button class="ee-btn" id="agxAccountClose">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) {
      if (e.target === modal) modal.remove();
    });
    document.getElementById('agxAccountClose').addEventListener('click', function() { modal.remove(); });

    // Load prefs from the server. We use the /users list because it's
    // already authoritatively populated by admin.js, but we filter to
    // self by email match.
    window.agxApi.users.list().then(function(res) {
      var users = (res && res.users) || [];
      var meRow = users.find(function(u) {
        return Number(u.id) === Number(me.id) ||
               (u.email && me.email && u.email.toLowerCase() === me.email.toLowerCase());
      });
      var prefs = (meRow && meRow.notification_prefs) || {};
      paintPrefs(prefs);
    }).catch(function(err) {
      var pane = document.getElementById('agx-acct-prefs');
      if (pane) pane.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  function paintPrefs(prefs) {
    var pane = document.getElementById('agx-acct-prefs');
    if (!pane) return;
    var html = '';
    EVENT_DEFS.forEach(function(ev) {
      // Default ON (send). false in the prefs blob = explicitly muted.
      var on = prefs[ev.key] !== false;
      html += '<label style="display:flex;align-items:flex-start;gap:8px;cursor:pointer;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
        '<input type="checkbox" data-pref-key="' + ev.key + '"' + (on ? ' checked' : '') + ' style="margin-top:2px;flex-shrink:0;" />' +
        '<div style="flex:1;">' +
          '<div style="font-weight:600;color:var(--text,#e4e6f0);font-size:13px;">' + escapeHTML(ev.label) + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:3px;line-height:1.4;">' + escapeHTML(ev.desc) + '</div>' +
        '</div>' +
      '</label>';
    });
    html += '<div id="agx-acct-status" style="font-size:11px;color:var(--text-dim,#888);min-height:16px;"></div>';
    pane.innerHTML = html;

    // Wire change handlers — autosave to server on every toggle so
    // the user doesn't need a Save button.
    pane.querySelectorAll('input[data-pref-key]').forEach(function(input) {
      input.addEventListener('change', function() {
        var key = input.getAttribute('data-pref-key');
        prefs[key] = !!input.checked; // explicit value — easier to debug than "delete on true"
        savePrefs(prefs);
      });
    });
  }

  function savePrefs(prefs) {
    var status = document.getElementById('agx-acct-status');
    if (status) {
      status.textContent = 'Saving…';
      status.style.color = '#60a5fa';
    }
    fetch('/api/auth/me/notification-prefs', {
      method: 'PUT',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prefs: prefs })
    }).then(function(r) {
      return r.json().then(function(b) {
        if (!r.ok) throw new Error(b.error || 'Save failed');
        return b;
      });
    }).then(function() {
      if (status) {
        status.textContent = '✓ Saved';
        status.style.color = '#34d399';
        setTimeout(function() {
          if (status) status.textContent = '';
        }, 1500);
      }
    }).catch(function(err) {
      if (status) {
        status.textContent = '✗ ' + (err.message || 'Save failed');
        status.style.color = '#f87171';
      }
    });
  }

  // Wire the header button.
  document.addEventListener('DOMContentLoaded', function() {
    var btn = document.getElementById('account-btn');
    if (btn) btn.addEventListener('click', openMyAccount);
  });

  window.openMyAccount = openMyAccount;
})();
