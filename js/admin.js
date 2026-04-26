// AGX Admin module — users management UI.
// Backed by /api/auth/users (list/create/update) and the password-reset endpoint.
(function() {
  'use strict';

  // Cache of last-fetched users so other code (e.g. PM dropdown in Add Job
  // modal) can read without re-fetching. Refreshed on every renderAdminUsers().
  var _users = [];

  function isAdmin() {
    return window.agxAuth && window.agxAuth.isAdmin();
  }

  function fmtDate(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleDateString();
  }

  function roleBadge(role) {
    var colors = { admin: '#34d399', corporate: '#4f8cff', pm: '#fbbf24' };
    var color = colors[role] || '#8b90a5';
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:rgba(255,255,255,0.08);color:' + color +
           ';font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">' + role + '</span>';
  }

  function renderAdminUsers() {
    if (!isAdmin()) return;
    var tbody = document.getElementById('admin-users-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">Loading…</td></tr>';

    window.agxApi.users.list().then(function(res) {
      _users = res.users || [];
      if (!_users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">No users.</td></tr>';
        return;
      }
      var html = '';
      var me = window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser();
      var myId = me ? me.id : null;
      _users.forEach(function(u) {
        var activeBadge = u.active
          ? '<span style="color:#34d399;">&#x2713;</span>'
          : '<span style="color:#e74c3c;">&#x2717;</span>';
        var deleteBtn = (u.id === myId)
          ? '<button disabled title="You cannot delete your own account" style="font-size:11px;padding:4px 10px;opacity:0.4;cursor:not-allowed;margin-left:4px;">Delete</button>'
          : '<button onclick="deleteAdminUser(' + u.id + ')" style="font-size:11px;padding:4px 10px;background:#e74c3c;color:#fff;border:none;border-radius:4px;margin-left:4px;cursor:pointer;">Delete</button>';
        html += '<tr>' +
          '<td>' + escapeHTML(u.name || '') + '</td>' +
          '<td>' + escapeHTML(u.email || '') + '</td>' +
          '<td>' + roleBadge(u.role) + '</td>' +
          '<td style="text-align:center;">' + activeBadge + '</td>' +
          '<td>' + fmtDate(u.created_at) + '</td>' +
          '<td style="text-align:center;white-space:nowrap;">' +
            '<button onclick="openEditUserModal(' + u.id + ')" style="font-size:11px;padding:4px 10px;">Edit</button>' +
            deleteBtn +
          '</td>' +
        '</tr>';
      });
      tbody.innerHTML = html;
    }).catch(function(err) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e74c3c;padding:20px;">Failed to load users: ' + escapeHTML(err.message) + '</td></tr>';
    });
  }

  function openNewUserModal() {
    document.getElementById('newUser_name').value = '';
    document.getElementById('newUser_email').value = '';
    document.getElementById('newUser_password').value = '';
    document.getElementById('newUser_role').value = 'pm';
    document.getElementById('newUser_status').textContent = '';
    document.getElementById('newUser_submitBtn').disabled = false;
    openModal('newUserModal');
  }

  function submitNewUser() {
    var statusEl = document.getElementById('newUser_status');
    var btn = document.getElementById('newUser_submitBtn');
    var name = document.getElementById('newUser_name').value.trim();
    var email = document.getElementById('newUser_email').value.trim();
    var password = document.getElementById('newUser_password').value;
    var role = document.getElementById('newUser_role').value;

    if (!name || !email || !password) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Name, email, and password are all required.';
      return;
    }
    if (password.length < 4) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Password must be at least 4 characters.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Creating…';

    window.agxApi.users.create({ name: name, email: email, password: password, role: role })
      .then(function() {
        statusEl.style.color = '#34d399';
        statusEl.textContent = 'Created. Tell ' + name + ' their password (' + password + ') out-of-band.';
        setTimeout(function() {
          closeModal('newUserModal');
          renderAdminUsers();
        }, 1200);
      })
      .catch(function(err) {
        btn.disabled = false;
        statusEl.style.color = '#e74c3c';
        statusEl.textContent = 'Create failed: ' + (err.message || 'unknown error');
      });
  }

  function openEditUserModal(userId) {
    var u = _users.find(function(x) { return x.id === userId; });
    if (!u) {
      alert('User not found in cache. Click Refresh and try again.');
      return;
    }
    document.getElementById('editUser_id').value = u.id;
    document.getElementById('editUser_email').value = u.email;
    document.getElementById('editUser_name').value = u.name || '';
    document.getElementById('editUser_role').value = u.role || 'pm';
    document.getElementById('editUser_active').checked = !!u.active;
    document.getElementById('editUser_newPassword').value = '';
    document.getElementById('editUser_status').textContent = '';
    document.getElementById('editUser_submitBtn').disabled = false;
    openModal('editUserModal');
  }

  function submitEditUser() {
    var statusEl = document.getElementById('editUser_status');
    var btn = document.getElementById('editUser_submitBtn');
    var id = document.getElementById('editUser_id').value;
    var name = document.getElementById('editUser_name').value.trim();
    var role = document.getElementById('editUser_role').value;
    var active = document.getElementById('editUser_active').checked;
    var newPassword = document.getElementById('editUser_newPassword').value;

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    var updatePromise = window.agxApi.users.update(id, { name: name, role: role, active: active });
    var passwordPromise = newPassword
      ? window.agxApi.users.resetPassword(id, newPassword)
      : Promise.resolve();

    Promise.all([updatePromise, passwordPromise])
      .then(function() {
        statusEl.style.color = '#34d399';
        statusEl.textContent = newPassword
          ? 'Saved. New password: ' + newPassword + ' (tell the user)'
          : 'Saved.';
        setTimeout(function() {
          closeModal('editUserModal');
          renderAdminUsers();
        }, 1200);
      })
      .catch(function(err) {
        btn.disabled = false;
        statusEl.style.color = '#e74c3c';
        statusEl.textContent = 'Save failed: ' + (err.message || 'unknown error');
      });
  }

  // Expose helpers for other modules. The PM dropdown in the Add Job modal
  // will read getActivePMs() to populate options.
  window.agxAdmin = {
    getCachedUsers: function() { return _users.slice(); },
    getActivePMs: function() {
      return _users.filter(function(u) {
        return u.active && (u.role === 'pm' || u.role === 'admin');
      });
    },
    refreshUsers: renderAdminUsers
  };

  // ==================== JOB SHARING ====================
  // Per-job access management (visible to admin or job owner). Backed by
  // /api/jobs/:id/access endpoints. The current job's access state is
  // re-fetched from the server on each render to avoid stale UI after grants.
  var _currentSharingJobId = null;
  var _currentSharingShares = [];

  function renderJobSharing(jobId) {
    var card = document.getElementById('job-sharing-card');
    var listEl = document.getElementById('job-sharing-list');
    if (!card || !listEl) return;

    var auth = window.agxAuth;
    if (!auth || auth.isOffline() || !window.agxApi || !window.agxApi.isAuthenticated()) {
      card.style.display = 'none';
      return;
    }

    _currentSharingJobId = jobId;
    listEl.innerHTML = '<div style="color:var(--text-dim,#888);">Loading…</div>';
    card.style.display = '';

    window.agxApi.jobs.listAccess(jobId).then(function(res) {
      _currentSharingShares = res.shares || [];
      var me = auth.getUser();
      var canManage = me && (me.role === 'admin' || me.id === res.owner_id);
      if (!canManage) {
        // Non-managers don't even see the card. Just re-hide and bail.
        card.style.display = 'none';
        return;
      }
      var users = (window.agxAdmin && window.agxAdmin.getCachedUsers && window.agxAdmin.getCachedUsers()) || [];
      var ownerName = '';
      var owner = users.find(function(u) { return u.id === res.owner_id; });
      if (owner) ownerName = owner.name + ' (' + owner.email + ')';
      else ownerName = 'User #' + res.owner_id;

      var html = '<div style="margin-bottom:10px;padding:8px 10px;background:rgba(255,255,255,0.04);border-radius:6px;">' +
                 '<strong>Owner:</strong> ' + escapeHTML(ownerName) +
                 ' <span style="font-size:10px;color:var(--text-dim,#888);margin-left:6px;">always has full edit rights</span>' +
                 '</div>';
      if (!_currentSharingShares.length) {
        html += '<div style="color:var(--text-dim,#888);font-size:12px;padding:8px 0;">No additional users granted access. Click "+ Grant Access" to share this job.</div>';
      } else {
        html += '<table style="width:100%;border-collapse:collapse;">';
        html += '<thead><tr><th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Name</th>' +
                '<th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Role</th>' +
                '<th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Access</th>' +
                '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border,#333);"></th></tr></thead><tbody>';
        _currentSharingShares.forEach(function(s) {
          html += '<tr>' +
            '<td style="padding:6px 8px;">' + escapeHTML(s.name || '') + '</td>' +
            '<td style="padding:6px 8px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(s.role || '') + '</td>' +
            '<td style="padding:6px 8px;">' +
              '<select onchange="updateJobAccessLevel(' + s.user_id + ', this.value)" style="font-size:11px;padding:2px 4px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:4px;">' +
                '<option value="edit"' + (s.access_level === 'edit' ? ' selected' : '') + '>edit</option>' +
                '<option value="view"' + (s.access_level === 'view' ? ' selected' : '') + '>view</option>' +
              '</select>' +
            '</td>' +
            '<td style="padding:6px 8px;text-align:right;">' +
              '<button onclick="revokeJobAccess(' + s.user_id + ')" style="font-size:10px;padding:2px 8px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;">Revoke</button>' +
            '</td>' +
          '</tr>';
        });
        html += '</tbody></table>';
      }
      listEl.innerHTML = html;
    }).catch(function(err) {
      listEl.innerHTML = '<div style="color:#e74c3c;">Failed to load access list: ' + escapeHTML(err.message) + '</div>';
    });
  }

  function openGrantAccessModal() {
    if (!_currentSharingJobId) return;
    var sel = document.getElementById('grantAccess_userSelect');
    var users = (window.agxAdmin && window.agxAdmin.getCachedUsers && window.agxAdmin.getCachedUsers()) || [];
    var alreadyShared = {};
    _currentSharingShares.forEach(function(s) { alreadyShared[s.user_id] = true; });
    var me = window.agxAuth && window.agxAuth.getUser();
    var html = '<option value="">-- Select user --</option>';
    users.forEach(function(u) {
      if (!u.active) return;
      if (alreadyShared[u.id]) return;            // already has access
      if (me && u.id === me.id) return;            // skip self
      html += '<option value="' + u.id + '">' + escapeHTML(u.name) + ' (' + escapeHTML(u.email) + ')' +
              (u.role !== 'pm' ? ' [' + u.role + ']' : '') + '</option>';
    });
    sel.innerHTML = html;
    document.getElementById('grantAccess_level').value = 'edit';
    document.getElementById('grantAccess_status').textContent = '';
    document.getElementById('grantAccess_submitBtn').disabled = false;
    openModal('grantAccessModal');
  }

  function submitGrantAccess() {
    var statusEl = document.getElementById('grantAccess_status');
    var btn = document.getElementById('grantAccess_submitBtn');
    var userId = parseInt(document.getElementById('grantAccess_userSelect').value, 10);
    var level = document.getElementById('grantAccess_level').value;
    if (!userId) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Pick a user.';
      return;
    }
    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Granting…';
    window.agxApi.jobs.grantAccess(_currentSharingJobId, userId, level)
      .then(function() {
        statusEl.style.color = '#34d399';
        statusEl.textContent = 'Granted.';
        setTimeout(function() {
          closeModal('grantAccessModal');
          renderJobSharing(_currentSharingJobId);
          // Pull fresh job list so this user's _canEdit reflects the new grant on next reload
          if (window.agxData) window.agxData.reloadFromServer();
        }, 800);
      })
      .catch(function(err) {
        btn.disabled = false;
        statusEl.style.color = '#e74c3c';
        statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
      });
  }

  function revokeJobAccess(userId) {
    if (!_currentSharingJobId) return;
    var u = _currentSharingShares.find(function(x) { return x.user_id === userId; });
    var name = u ? u.name : 'this user';
    if (!confirm('Revoke ' + name + "'s access to this job?")) return;
    window.agxApi.jobs.revokeAccess(_currentSharingJobId, userId)
      .then(function() {
        renderJobSharing(_currentSharingJobId);
        if (window.agxData) window.agxData.reloadFromServer();
      })
      .catch(function(err) {
        alert('Revoke failed: ' + (err.message || 'unknown error'));
      });
  }

  function updateJobAccessLevel(userId, newLevel) {
    if (!_currentSharingJobId) return;
    window.agxApi.jobs.grantAccess(_currentSharingJobId, userId, newLevel)
      .then(function() {
        // Refresh in background; no UI change needed
        renderJobSharing(_currentSharingJobId);
        if (window.agxData) window.agxData.reloadFromServer();
      })
      .catch(function(err) {
        alert('Update failed: ' + (err.message || 'unknown error'));
      });
  }

  function deleteAdminUser(userId) {
    var u = _users.find(function(x) { return x.id === userId; });
    if (!u) return;
    var msg = 'Delete user "' + u.name + '" (' + u.email + ')? This cannot be undone.\n\n' +
              'If they own any jobs, the delete will fail and you should deactivate them ' +
              '(uncheck Active in Edit) instead, or reassign their jobs first.';
    if (!confirm(msg)) return;
    window.agxApi.users.remove(userId)
      .then(function() {
        renderAdminUsers();
      })
      .catch(function(err) {
        alert('Delete failed: ' + (err.message || 'unknown error'));
      });
  }

  window.renderAdminUsers = renderAdminUsers;
  window.openNewUserModal = openNewUserModal;
  window.submitNewUser = submitNewUser;
  window.openEditUserModal = openEditUserModal;
  window.submitEditUser = submitEditUser;
  window.deleteAdminUser = deleteAdminUser;
  window.renderJobSharing = renderJobSharing;
  window.openGrantAccessModal = openGrantAccessModal;
  window.submitGrantAccess = submitGrantAccess;
  window.revokeJobAccess = revokeJobAccess;
  window.updateJobAccessLevel = updateJobAccessLevel;
})();
