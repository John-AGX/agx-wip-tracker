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

  // Inject scoped CSS once. Without this, the global rules in
  // styles.css (`input, select, textarea { width: 100% }` and
  // `label { display:block; text-transform:uppercase; font-size:10px }`)
  // squash the checkbox + description into an unreadable layout.
  function ensureAccountStyles() {
    if (document.getElementById('p86-account-styles')) return;
    var style = document.createElement('style');
    style.id = 'p86-account-styles';
    style.textContent = [
      '#p86AccountModal .p86-pref-row {',
      '  display: flex;',
      '  align-items: flex-start;',
      '  gap: 10px;',
      '  cursor: pointer;',
      '  background: var(--card-bg, #0f0f1e);',
      '  border: 1px solid var(--border, #333);',
      '  border-radius: 6px;',
      '  padding: 10px 12px;',
      '  text-transform: none;',
      '  letter-spacing: normal;',
      '  font-size: 13px;',
      '  font-weight: normal;',
      '  margin-bottom: 0;',
      '  color: var(--text, #e4e6f0);',
      '}',
      '#p86AccountModal .p86-pref-row input[type="checkbox"] {',
      '  width: auto;',
      '  margin: 2px 0 0 0;',
      '  padding: 0;',
      '  flex: 0 0 auto;',
      '  background: transparent;',
      '  border: none;',
      '}',
      '#p86AccountModal .p86-pref-body { flex: 1 1 auto; min-width: 0; }',
      '#p86AccountModal .p86-pref-title {',
      '  font-weight: 600;',
      '  color: var(--text, #e4e6f0);',
      '  font-size: 13px;',
      '  text-transform: none;',
      '  letter-spacing: normal;',
      '}',
      '#p86AccountModal .p86-pref-desc {',
      '  font-size: 11px;',
      '  color: var(--text-dim, #888);',
      '  margin-top: 3px;',
      '  line-height: 1.4;',
      '  text-transform: none;',
      '  letter-spacing: normal;',
      '  font-weight: normal;',
      '}',
      '#p86AccountModal .p86-acct-card { display:flex; align-items:center; gap:14px; padding:6px 0 16px; border-bottom:1px solid var(--border,#333); margin-bottom:16px; }',
      '#p86AccountModal .p86-acct-avatar { width:48px; height:48px; border-radius:50%; background:var(--accent,#4f8cff); color:#fff; display:flex; align-items:center; justify-content:center; font-weight:600; font-size:18px; flex:0 0 auto; }',
      '#p86AccountModal .p86-acct-cardname { font-size:16px; font-weight:600; color:var(--text,#e4e6f0); }',
      '#p86AccountModal .p86-acct-cardtitle { font-size:12px; color:var(--text-dim,#aaa); margin-top:1px; }',
      '#p86AccountModal .p86-acct-cardemail { font-family:monospace; font-size:12px; color:var(--text-dim,#888); margin-top:2px; }',
      '#p86AccountModal .p86-acct-meta { display:flex; flex-wrap:wrap; gap:6px; margin-top:8px; }',
      '#p86AccountModal .p86-acct-rolebadge { font-size:10px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; background:rgba(79,140,255,0.16); color:#9cc0ff; border-radius:999px; padding:2px 9px; }',
      '#p86AccountModal .p86-acct-chip { font-size:11px; color:var(--text-dim,#888); background:var(--card-bg,#0f0f1e); border:1px solid var(--border,#333); border-radius:999px; padding:2px 9px; }',
      '#p86AccountModal .p86-acct-section { margin-bottom:18px; }',
      '#p86AccountModal .p86-acct-sectlabel { font-size:11px; font-weight:700; text-transform:uppercase; letter-spacing:0.5px; color:var(--text-dim,#aaa); margin-bottom:10px; }',
      '#p86AccountModal .p86-acct-grid { display:grid; grid-template-columns:1fr 1fr; gap:10px 12px; }',
      '#p86AccountModal .p86-acct-field { min-width:0; }',
      '#p86AccountModal .p86-acct-field label { display:block; font-size:10px; text-transform:uppercase; letter-spacing:0.4px; color:var(--text-dim,#888); margin-bottom:4px; font-weight:600; }',
      '#p86AccountModal .p86-acct-field input { width:100%; background:var(--input-bg,#0f0f1e); color:var(--text,#e4e6f0); border:1px solid var(--border,#333); border-radius:6px; padding:8px 10px; font-size:13px; box-sizing:border-box; }',
      '#p86AccountModal .p86-acct-actions { display:flex; align-items:center; gap:10px; margin-top:10px; }',
      '#p86AccountModal .p86-acct-status { font-size:11px; min-height:14px; }'
    ].join('\n');
    document.head.appendChild(style);
  }

  // Open the My Account modal. Pre-loads the user's current prefs from
  // /api/auth/users (already cached by admin module if available) and
  // saves on toggle.
  function initials(name) {
    var p = String(name || '').trim().split(/\s+/);
    return (((p[0] || '')[0] || '') + ((p[1] || '')[0] || '')).toUpperCase() || '?';
  }
  var ROLE_LABELS = { system_admin: 'System Admin', admin: 'Admin', corporate: 'Corporate', pm: 'Project Manager', field_crew: 'Field Crew', sub: 'Sub' };
  function roleLabel(role) { return ROLE_LABELS[role] || (role ? String(role) : 'User'); }
  function fmtMonthYear(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
  }
  function fmtAgo(iso) {
    var d = new Date(iso); if (isNaN(d.getTime())) return '';
    var s = Math.max(0, (Date.now() - d.getTime()) / 1000);
    if (s < 90) return 'just now';
    if (s < 3600) return Math.round(s / 60) + 'm ago';
    if (s < 86400) return Math.round(s / 3600) + 'h ago';
    if (s < 86400 * 7) return Math.round(s / 86400) + 'd ago';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }
  function setStatus(el, txt, color) { if (!el) return; el.textContent = txt; el.style.color = color || ''; }
  function acctField(id, label, val, type, ph) {
    return '<div class="p86-acct-field"><label>' + escapeHTML(label) + '</label>' +
      '<input id="' + id + '" type="' + (type || 'text') + '" value="' + escapeHTML(val || '').replace(/"/g, '&quot;') + '"' +
      (ph ? ' placeholder="' + escapeHTML(ph) + '"' : '') + ' autocomplete="off" /></div>';
  }

  function openMyAccount() {
    if (!window.p86Api || !window.p86Api.isAuthenticated || !window.p86Api.isAuthenticated()) {
      alert('Sign in to manage your account.');
      return;
    }
    var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    if (!me) {
      alert('Sign in to manage your account.');
      return;
    }

    var prior = document.getElementById('p86AccountModal');
    if (prior) prior.remove();
    ensureAccountStyles();
    var modal = document.createElement('div');
    modal.id = 'p86AccountModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">My Account</div>' +
        '<div class="p86-acct-card">' +
          '<div class="p86-acct-avatar" id="p86-acct-avatar">' + escapeHTML(initials(me.name)) + '</div>' +
          '<div style="min-width:0;flex:1;">' +
            '<div class="p86-acct-cardname" id="p86-acct-cardname">' + escapeHTML(me.name || '') + '</div>' +
            '<div class="p86-acct-cardtitle" id="p86-acct-cardtitle"></div>' +
            '<div class="p86-acct-cardemail" id="p86-acct-cardemail">' + escapeHTML(me.email || '') + '</div>' +
            '<div class="p86-acct-meta" id="p86-acct-meta"><span class="p86-acct-rolebadge">' + escapeHTML(roleLabel(me.role)) + '</span></div>' +
          '</div>' +
        '</div>' +
        '<div class="p86-acct-section">' +
          '<div class="p86-acct-sectlabel">Your info</div>' +
          '<div class="p86-acct-grid">' +
            acctField('p86-acct-name', 'Name', me.name) +
            acctField('p86-acct-email', 'Email', me.email, 'email') +
            acctField('p86-acct-phone', 'Phone', '', 'tel', '(555) 555-5555') +
            acctField('p86-acct-title', 'Title', '', 'text', 'e.g. Project Manager') +
          '</div>' +
          '<div class="p86-acct-actions"><button class="ee-btn primary" id="p86-acct-save">Save profile</button>' +
            '<span class="p86-acct-status" id="p86-acct-profstatus"></span></div>' +
        '</div>' +
        '<div class="p86-acct-section">' +
          '<div class="p86-acct-sectlabel">Change password</div>' +
          '<div class="p86-acct-grid">' +
            acctField('p86-acct-curpw', 'Current password', '', 'password') +
            acctField('p86-acct-newpw', 'New password', '', 'password', 'min 8 characters') +
            acctField('p86-acct-confpw', 'Confirm new', '', 'password') +
          '</div>' +
          '<div class="p86-acct-actions"><button class="ee-btn" id="p86-acct-pwsave">Update password</button>' +
            '<span class="p86-acct-status" id="p86-acct-pwstatus"></span></div>' +
        '</div>' +
        '<div class="p86-acct-section">' +
          '<div class="p86-acct-sectlabel">Email notifications</div>' +
          '<div id="p86-acct-prefs" style="display:flex;flex-direction:column;gap:14px;">' +
            '<div style="font-size:11px;color:var(--text-dim,#888);">Loading…</div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:18px;">' +
          '<button class="ee-btn" id="p86AccountClose">Close</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    document.getElementById('p86AccountClose').addEventListener('click', function() { modal.remove(); });
    document.getElementById('p86-acct-save').addEventListener('click', function() { saveProfile(me); });
    document.getElementById('p86-acct-pwsave').addEventListener('click', changePassword);

    // Load the full self row (phone / title / timezone / created / last-seen +
    // prefs) from the staff directory; match self by id or email.
    window.p86Api.users.list().then(function(res) {
      var users = (res && res.users) || [];
      var meRow = users.find(function(u) {
        return Number(u.id) === Number(me.id) ||
               (u.email && me.email && u.email.toLowerCase() === me.email.toLowerCase());
      }) || {};
      var phoneEl = document.getElementById('p86-acct-phone'); if (phoneEl) phoneEl.value = meRow.phone_number || '';
      var titleEl = document.getElementById('p86-acct-title'); if (titleEl) titleEl.value = meRow.title || '';
      var cardTitle = document.getElementById('p86-acct-cardtitle'); if (cardTitle) cardTitle.textContent = meRow.title || '';
      var meta = document.getElementById('p86-acct-meta');
      if (meta) {
        var chips = '<span class="p86-acct-rolebadge">' + escapeHTML(roleLabel(meRow.role || me.role)) + '</span>';
        if (meRow.created_at) chips += '<span class="p86-acct-chip">Member since ' + escapeHTML(fmtMonthYear(meRow.created_at)) + '</span>';
        if (meRow.last_seen_at) chips += '<span class="p86-acct-chip">Last seen ' + escapeHTML(fmtAgo(meRow.last_seen_at)) + '</span>';
        if (meRow.timezone) chips += '<span class="p86-acct-chip">' + escapeHTML(meRow.timezone) + '</span>';
        meta.innerHTML = chips;
      }
      paintPrefs((meRow && meRow.notification_prefs) || {});
    }).catch(function(err) {
      var pane = document.getElementById('p86-acct-prefs');
      if (pane) pane.innerHTML = '<div style="color:#f87171;font-size:12px;">Failed to load: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  function saveProfile(me) {
    var status = document.getElementById('p86-acct-profstatus');
    var name = (document.getElementById('p86-acct-name') || {}).value || '';
    var email = (document.getElementById('p86-acct-email') || {}).value || '';
    var phone = (document.getElementById('p86-acct-phone') || {}).value || '';
    var title = (document.getElementById('p86-acct-title') || {}).value || '';
    if (!name.trim()) { setStatus(status, '✗ Name is required', '#f87171'); return; }
    setStatus(status, 'Saving…', '#60a5fa');
    var identityChanged = name.trim() !== String(me.name || '') ||
      email.trim().toLowerCase() !== String(me.email || '').toLowerCase();
    fetch('/api/auth/me', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: name, email: email, phone_number: phone, title: title })
    }).then(function(r) {
      return r.json().then(function(b) { if (!r.ok) throw new Error(b.error || 'Save failed'); return b; });
    }).then(function() {
      var cn = document.getElementById('p86-acct-cardname'); if (cn) cn.textContent = name;
      var ce = document.getElementById('p86-acct-cardemail'); if (ce) ce.textContent = email;
      var ct = document.getElementById('p86-acct-cardtitle'); if (ct) ct.textContent = title;
      var av = document.getElementById('p86-acct-avatar'); if (av) av.textContent = initials(name);
      if (window.p86Auth && window.p86Auth.getUser) { var u = window.p86Auth.getUser(); if (u) { u.name = name.trim(); u.email = email.trim().toLowerCase(); } }
      if (identityChanged) {
        // Name/email drive the header avatar + every request's identity — reload
        // so everything picks up the (server-re-signed) session cleanly.
        setStatus(status, '✓ Saved — refreshing…', '#34d399');
        setTimeout(function() { window.location.reload(); }, 700);
      } else {
        setStatus(status, '✓ Saved', '#34d399');
        setTimeout(function() { setStatus(status, '', ''); }, 1800);
      }
    }).catch(function(err) {
      setStatus(status, '✗ ' + (err.message || 'Save failed'), '#f87171');
    });
  }

  function changePassword() {
    var status = document.getElementById('p86-acct-pwstatus');
    var cur = (document.getElementById('p86-acct-curpw') || {}).value || '';
    var nw = (document.getElementById('p86-acct-newpw') || {}).value || '';
    var conf = (document.getElementById('p86-acct-confpw') || {}).value || '';
    if (nw.length < 8) { setStatus(status, '✗ New password must be 8+ characters', '#f87171'); return; }
    if (nw !== conf) { setStatus(status, '✗ New passwords do not match', '#f87171'); return; }
    setStatus(status, 'Updating…', '#60a5fa');
    fetch('/api/auth/password', {
      method: 'PUT', credentials: 'include', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: cur, newPassword: nw })
    }).then(function(r) {
      return r.json().then(function(b) { if (!r.ok) throw new Error(b.error || 'Update failed'); return b; });
    }).then(function() {
      setStatus(status, '✓ Password updated', '#34d399');
      ['p86-acct-curpw', 'p86-acct-newpw', 'p86-acct-confpw'].forEach(function(id) { var e = document.getElementById(id); if (e) e.value = ''; });
    }).catch(function(err) {
      setStatus(status, '✗ ' + (err.message || 'Update failed'), '#f87171');
    });
  }

  function paintPrefs(prefs) {
    var pane = document.getElementById('p86-acct-prefs');
    if (!pane) return;
    var html = '';
    EVENT_DEFS.forEach(function(ev) {
      // Default ON (send). false in the prefs blob = explicitly muted.
      var on = prefs[ev.key] !== false;
      html += '<label class="p86-pref-row">' +
        '<input type="checkbox" data-pref-key="' + ev.key + '"' + (on ? ' checked' : '') + ' />' +
        '<div class="p86-pref-body">' +
          '<div class="p86-pref-title">' + escapeHTML(ev.label) + '</div>' +
          '<div class="p86-pref-desc">' + escapeHTML(ev.desc) + '</div>' +
        '</div>' +
      '</label>';
    });
    html += '<div id="p86-acct-status" style="font-size:11px;color:var(--text-dim,#888);min-height:16px;"></div>';
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
    var status = document.getElementById('p86-acct-status');
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
