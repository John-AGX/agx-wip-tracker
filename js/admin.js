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
    document.getElementById('newUser_status').textContent = '';
    document.getElementById('newUser_submitBtn').disabled = false;
    // Refresh role options each time so newly created custom roles show up
    // and the dropdown reflects any capability tweaks the admin made since.
    var sel = document.getElementById('newUser_role');
    Promise.resolve(loadRolesCache()).then(function() {
      populateRoleSelect(sel, 'pm');
    });
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
    document.getElementById('editUser_active').checked = !!u.active;
    document.getElementById('editUser_newPassword').value = '';
    document.getElementById('editUser_status').textContent = '';
    document.getElementById('editUser_submitBtn').disabled = false;
    // Populate the role dropdown dynamically so custom roles + field_crew
    // show up alongside the built-ins.
    Promise.resolve(loadRolesCache()).then(function() {
      populateRoleSelect(document.getElementById('editUser_role'), u.role || 'pm');
    });
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

  // Cache-only fetch — populates _users without trying to render the admin
  // UI. Used on login for all authenticated users so PM-by-owner_id lookups
  // (e.g. the Job Information PM field) can resolve user names everywhere.
  function loadUsersCache() {
    if (!window.agxApi || !window.agxApi.isAuthenticated()) return Promise.resolve();
    return window.agxApi.users.list().then(function(res) {
      _users = res.users || [];
      // Re-render views that depend on user names so PM-by-owner_id lookups
      // resolve once the cache lands. Each renderer is a no-op if its DOM
      // target isn't visible.
      if (typeof renderWIPMain === 'function') renderWIPMain();
      if (typeof renderInsightsDashboard === 'function') renderInsightsDashboard();
      return _users;
    }).catch(function() { return []; });
  }

  function findUserById(id) {
    if (id == null) return null;
    return _users.find(function(u) { return u.id === id; }) || null;
  }

  // Expose helpers for other modules. The PM dropdown in the Add Job modal
  // and the Job Information PM field both read from this cache.
  window.agxAdmin = {
    getCachedUsers: function() { return _users.slice(); },
    findUserById: findUserById,
    getActivePMs: function() {
      return _users.filter(function(u) {
        return u.active && (u.role === 'pm' || u.role === 'admin');
      });
    },
    refreshUsers: renderAdminUsers,
    loadUsersCache: loadUsersCache
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
          // Caller (per-job detail vs admin-tab share manager) sets a custom
          // refresh target. Default is to re-render the per-job sharing card.
          if (typeof window._grantAccessRefreshTarget === 'function') {
            window._grantAccessRefreshTarget();
            window._grantAccessRefreshTarget = null;
          } else {
            renderJobSharing(_currentSharingJobId);
          }
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

  // ==================== JOB ASSIGNMENTS (admin-side) ====================
  // Centralized job ownership + sharing management. Pulls the full job list
  // from the API and renders a table with an inline owner dropdown and a
  // "Manage Sharing" action that opens a modal listing the per-job shares.
  var _jobsCache = [];

  function renderAdminJobs() {
    if (!isAdmin()) return;
    var tbody = document.getElementById('admin-jobs-tbody');
    if (!tbody) return;
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">Loading…</td></tr>';

    Promise.all([
      window.agxApi.jobs.list(),
      _users.length ? Promise.resolve({ users: _users }) : window.agxApi.users.list()
    ]).then(function(results) {
      _jobsCache = results[0].jobs || [];
      _users = results[1].users || _users;
      if (!_jobsCache.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">No jobs.</td></tr>';
        return;
      }
      var assignableUsers = _users.filter(function(u) {
        return u.active && (u.role === 'pm' || u.role === 'admin');
      });
      var html = '';
      _jobsCache.forEach(function(j) {
        var ownerOpts = '<option value="">-- Unassigned --</option>';
        assignableUsers.forEach(function(u) {
          ownerOpts += '<option value="' + u.id + '"' + (j.owner_id === u.id ? ' selected' : '') + '>' +
                       escapeHTML(u.name) + (u.role === 'admin' ? ' (admin)' : '') + '</option>';
        });
        var label = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.id);
        html += '<tr>' +
          '<td><strong>' + escapeHTML(label) + '</strong></td>' +
          '<td>' + escapeHTML(j.client || '—') + '</td>' +
          '<td><span class="badge">' + escapeHTML(j.status || '—') + '</span></td>' +
          '<td>' +
            '<select onchange="reassignJobOwner(\'' + escapeHTML(j.id) + '\', this.value)" ' +
              'style="font-size:12px;padding:4px 8px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:4px;min-width:180px;">' +
              ownerOpts +
            '</select>' +
          '</td>' +
          '<td style="text-align:center;" id="admin-shares-cell-' + escapeHTML(j.id) + '">' +
            '<span style="color:var(--text-dim,#888);font-size:11px;">…</span>' +
          '</td>' +
          '<td style="text-align:center;">' +
            '<button onclick="openJobShareManager(\'' + escapeHTML(j.id) + '\')" style="font-size:11px;padding:4px 10px;">Manage Sharing</button>' +
          '</td>' +
        '</tr>';
      });
      tbody.innerHTML = html;
      // Asynchronously fill in the share counts. One call per job — small
      // dataset for now, fine. Can be batched into a single endpoint later
      // if the job count grows large.
      _jobsCache.forEach(function(j) {
        window.agxApi.jobs.listAccess(j.id).then(function(res) {
          var cell = document.getElementById('admin-shares-cell-' + j.id);
          if (!cell) return;
          var n = (res.shares || []).length;
          cell.innerHTML = n
            ? '<span style="background:rgba(79,140,255,0.15);color:#4f8cff;padding:2px 8px;border-radius:10px;font-size:11px;">' + n + '</span>'
            : '<span style="color:var(--text-dim,#888);font-size:11px;">—</span>';
        }).catch(function() { /* ignore per-job failures */ });
      });
    }).catch(function(err) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#e74c3c;padding:20px;">Failed: ' + escapeHTML(err.message) + '</td></tr>';
    });
  }

  function reassignJobOwner(jobId, newOwnerId) {
    if (!newOwnerId) return; // ignore the "-- Unassigned --" placeholder
    window.agxApi.jobs.reassignOwner(jobId, parseInt(newOwnerId, 10))
      .then(function() {
        // Pull fresh job state so _canEdit recalculates for everyone, and
        // refresh the assignments table to show the new owner.
        if (window.agxData) window.agxData.reloadFromServer();
        renderAdminJobs();
      })
      .catch(function(err) {
        alert('Reassign failed: ' + (err.message || 'unknown error'));
        renderAdminJobs(); // revert the dropdown
      });
  }

  function openJobShareManager(jobId) {
    // Look up the job in the admin cache first (admins coming in from the
    // Job Assignments table); fall back to appData.jobs (non-admin owners
    // clicking the Sharing button on their own job overview). Either way
    // we just need a label for the modal header.
    var job = _jobsCache.find(function(j) { return j.id === jobId; });
    if (!job && window.appData && window.appData.jobs) {
      job = window.appData.jobs.find(function(j) { return j.id === jobId; });
    }
    if (!job) {
      alert('Could not find that job.');
      return;
    }
    _currentSharingJobId = jobId; // reuse the per-job sharing flow's state
    var label = (job.jobNumber ? '[' + job.jobNumber + '] ' : '') + (job.title || jobId);
    document.getElementById('manageSharing_jobLabel').textContent = label;
    // Ensure the users cache exists so the owner display + grant dropdown work.
    if (!_users.length && window.agxApi) {
      window.agxApi.users.list().then(function(res) {
        _users = res.users || [];
        refreshShareManager(jobId);
      }).catch(function() {
        refreshShareManager(jobId);
      });
    } else {
      refreshShareManager(jobId);
    }
    openModal('manageJobSharingModal');
  }

  function refreshShareManager(jobId) {
    var listEl = document.getElementById('manageSharing_list');
    var ownerEl = document.getElementById('manageSharing_ownerLine');
    listEl.innerHTML = '<div style="color:var(--text-dim,#888);">Loading…</div>';
    window.agxApi.jobs.listAccess(jobId).then(function(res) {
      _currentSharingShares = res.shares || [];
      var owner = _users.find(function(u) { return u.id === res.owner_id; });
      ownerEl.innerHTML = '<strong>Owner:</strong> ' +
        escapeHTML(owner ? (owner.name + ' · ' + owner.email) : ('User #' + res.owner_id)) +
        ' <span style="font-size:10px;color:var(--text-dim,#888);margin-left:6px;">always full edit</span>';
      if (!_currentSharingShares.length) {
        listEl.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:8px 0;">No additional users have access yet.</div>';
        return;
      }
      var html = '<table style="width:100%;border-collapse:collapse;">';
      html += '<thead><tr>' +
        '<th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Name</th>' +
        '<th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Role</th>' +
        '<th style="text-align:left;font-size:11px;color:var(--text-dim,#888);padding:4px 8px;border-bottom:1px solid var(--border,#333);">Access</th>' +
        '<th style="text-align:right;padding:4px 8px;border-bottom:1px solid var(--border,#333);"></th>' +
      '</tr></thead><tbody>';
      _currentSharingShares.forEach(function(s) {
        html += '<tr>' +
          '<td style="padding:6px 8px;">' + escapeHTML(s.name || '') + '</td>' +
          '<td style="padding:6px 8px;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(s.role || '') + '</td>' +
          '<td style="padding:6px 8px;">' +
            '<select onchange="updateAdminJobAccessLevel(' + s.user_id + ', this.value)" style="font-size:11px;padding:2px 4px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);border:1px solid var(--border,#333);border-radius:4px;">' +
              '<option value="edit"' + (s.access_level === 'edit' ? ' selected' : '') + '>edit</option>' +
              '<option value="view"' + (s.access_level === 'view' ? ' selected' : '') + '>view</option>' +
            '</select>' +
          '</td>' +
          '<td style="padding:6px 8px;text-align:right;">' +
            '<button onclick="revokeAdminJobAccess(' + s.user_id + ')" style="font-size:10px;padding:2px 8px;background:#e74c3c;color:#fff;border:none;border-radius:4px;cursor:pointer;">Revoke</button>' +
          '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
      listEl.innerHTML = html;
    }).catch(function(err) {
      listEl.innerHTML = '<div style="color:#e74c3c;">Failed to load: ' + escapeHTML(err.message) + '</div>';
    });
  }

  // Reuses the existing grant-access modal — it picks up _currentSharingJobId.
  function openGrantAccessFromAdmin() {
    openGrantAccessModal();
    // After grantAccessModal closes successfully it auto-refreshes via
    // renderJobSharing(); we want refreshShareManager() instead. Patch the
    // submit path by stashing the original target so it knows where to go.
    window._grantAccessRefreshTarget = function() {
      refreshShareManager(_currentSharingJobId);
      renderAdminJobs();
    };
  }

  function updateAdminJobAccessLevel(userId, newLevel) {
    if (!_currentSharingJobId) return;
    window.agxApi.jobs.grantAccess(_currentSharingJobId, userId, newLevel)
      .then(function() {
        refreshShareManager(_currentSharingJobId);
        if (window.agxData) window.agxData.reloadFromServer();
      })
      .catch(function(err) { alert('Update failed: ' + (err.message || '')); });
  }

  function revokeAdminJobAccess(userId) {
    if (!_currentSharingJobId) return;
    var u = _currentSharingShares.find(function(x) { return x.user_id === userId; });
    if (!confirm('Revoke ' + (u ? u.name : 'this user') + "'s access?")) return;
    window.agxApi.jobs.revokeAccess(_currentSharingJobId, userId)
      .then(function() {
        refreshShareManager(_currentSharingJobId);
        renderAdminJobs();
        if (window.agxData) window.agxData.reloadFromServer();
      })
      .catch(function(err) { alert('Revoke failed: ' + (err.message || '')); });
  }

  // Toggle between Users / Job Assignments / Metrics / Roles inside the
  // Admin tab. Renders the section's data on first reveal so we don't fire
  // API calls for tabs the admin never opens.
  function switchAdminSubTab(name) {
    document.querySelectorAll('[data-admin-subtab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.adminSubtab === name);
    });
    document.querySelectorAll('.admin-subtab-content').forEach(function(c) {
      c.style.display = 'none';
    });
    var target = document.getElementById('admin-subtab-' + name);
    if (target) target.style.display = '';
    if (name === 'users') renderAdminUsers();
    else if (name === 'jobs') renderAdminJobs();
    else if (name === 'metrics') renderAdminMetrics();
    else if (name === 'roles') renderAdminRoles();
  }

  // ==================== ROLES ====================
  // Role list, create, edit (capabilities), delete. Backed by /api/roles.
  // Capability metadata (group + label) comes from /api/roles/capabilities
  // and is cached after first fetch since it's a static enum on the server.
  var _rolesCache = [];
  var _capsMeta = null;

  function loadCapsMeta() {
    if (_capsMeta) return Promise.resolve(_capsMeta);
    return window.agxApi.roles.capabilities().then(function(res) {
      _capsMeta = res.capabilities || [];
      return _capsMeta;
    });
  }

  function loadRolesCache() {
    return window.agxApi.roles.list().then(function(res) {
      _rolesCache = res.roles || [];
      return _rolesCache;
    });
  }

  // Render a Set of capability keys grouped by their meta group, with each
  // capability as a labeled checkbox. Styling comes from .cap-row + .cap-text
  // + .cap-key in styles.css (overrides the global label uppercase/tiny rule).
  function renderCapabilityCheckboxes(containerEl, currentCaps) {
    var grouped = {};
    _capsMeta.forEach(function(c) {
      if (!grouped[c.group]) grouped[c.group] = [];
      grouped[c.group].push(c);
    });
    var html = '';
    Object.keys(grouped).forEach(function(g) {
      html += '<div class="cap-group-title">' + escapeHTML(g) + '</div>';
      grouped[g].forEach(function(c) {
        var checked = currentCaps.has(c.key) ? ' checked' : '';
        html += '<label class="cap-row">' +
          '<input type="checkbox" class="roleEditor_capChk" value="' + c.key + '"' + checked + ' />' +
          '<span class="cap-text">' + escapeHTML(c.label) +
            '<span class="cap-key">' + escapeHTML(c.key) + '</span>' +
          '</span>' +
        '</label>';
      });
    });
    containerEl.innerHTML = html;
  }

  function renderAdminRoles() {
    if (!isAdmin()) return;
    var listEl = document.getElementById('admin-roles-list');
    if (!listEl) return;
    listEl.innerHTML = '<div style="padding:15px;color:var(--text-dim,#888);">Loading…</div>';
    Promise.all([loadCapsMeta(), loadRolesCache()]).then(function() {
      if (!_rolesCache.length) {
        listEl.innerHTML = '<div style="padding:15px;color:var(--text-dim,#888);">No roles yet.</div>';
        return;
      }
      var html = '';
      _rolesCache.forEach(function(r) {
        var capCount = (r.capabilities || []).length;
        var builtinBadge = r.builtin
          ? '<span style="padding:2px 8px;border-radius:10px;background:rgba(79,140,255,0.15);color:#4f8cff;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;font-weight:600;">Built-in</span>'
          : '';
        var deleteBtn = r.builtin
          ? '<button class="small" disabled title="Built-in roles cannot be deleted">Delete</button>'
          : '<button class="small danger" onclick="deleteAdminRole(\'' + escapeHTML(r.name) + '\')">Delete</button>';
        html += '<div class="card" style="padding:12px 16px;display:flex;justify-content:space-between;align-items:center;gap:14px;">' +
          '<div style="min-width:0;flex:1;">' +
            '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:2px;">' +
              '<strong style="color:var(--text,#fff);font-size:14px;">' + escapeHTML(r.label) + '</strong>' +
              '<code style="font-size:11px;color:var(--text-dim,#888);background:rgba(255,255,255,0.04);padding:1px 6px;border-radius:3px;">' + escapeHTML(r.name) + '</code>' +
              builtinBadge +
            '</div>' +
            (r.description ? '<div style="font-size:12px;color:var(--text-dim,#888);">' + escapeHTML(r.description) + '</div>' : '') +
            '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px;">' + capCount + ' capabilit' + (capCount === 1 ? 'y' : 'ies') + '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;flex-shrink:0;">' +
            '<button class="small secondary" onclick="openEditRoleModal(\'' + escapeHTML(r.name) + '\')">Edit</button>' +
            deleteBtn +
          '</div>' +
        '</div>';
      });
      listEl.innerHTML = html;
    }).catch(function(err) {
      listEl.innerHTML = '<div style="padding:15px;color:#e74c3c;">Failed to load roles: ' + escapeHTML(err.message) + '</div>';
    });
  }

  function openNewRoleModal() {
    Promise.all([loadCapsMeta(), loadRolesCache()]).then(function() {
      document.getElementById('roleEditor_title').textContent = 'New Role';
      document.getElementById('roleEditor_origName').value = '';
      document.getElementById('roleEditor_name').value = '';
      document.getElementById('roleEditor_name').readOnly = false;
      document.getElementById('roleEditor_label').value = '';
      document.getElementById('roleEditor_description').value = '';
      renderCapabilityCheckboxes(document.getElementById('roleEditor_caps'), new Set());
      document.getElementById('roleEditor_status').textContent = '';
      document.getElementById('roleEditor_submitBtn').disabled = false;
      openModal('roleEditorModal');
    });
  }

  function openEditRoleModal(name) {
    Promise.all([loadCapsMeta(), loadRolesCache()]).then(function() {
      var role = _rolesCache.find(function(r) { return r.name === name; });
      if (!role) { alert('Role not found.'); return; }
      document.getElementById('roleEditor_title').textContent = 'Edit Role: ' + role.label;
      document.getElementById('roleEditor_origName').value = role.name;
      document.getElementById('roleEditor_name').value = role.name;
      document.getElementById('roleEditor_name').readOnly = true; // can't rename
      document.getElementById('roleEditor_label').value = role.label || '';
      document.getElementById('roleEditor_description').value = role.description || '';
      renderCapabilityCheckboxes(document.getElementById('roleEditor_caps'), new Set(role.capabilities || []));
      document.getElementById('roleEditor_status').textContent = '';
      document.getElementById('roleEditor_submitBtn').disabled = false;
      openModal('roleEditorModal');
    });
  }

  function submitRoleEditor() {
    var statusEl = document.getElementById('roleEditor_status');
    var btn = document.getElementById('roleEditor_submitBtn');
    var origName = document.getElementById('roleEditor_origName').value;
    var name = document.getElementById('roleEditor_name').value.trim();
    var label = document.getElementById('roleEditor_label').value.trim();
    var description = document.getElementById('roleEditor_description').value.trim();
    var caps = Array.from(document.querySelectorAll('.roleEditor_capChk:checked')).map(function(el) { return el.value; });

    if (!name || !label) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Name and display label are required.';
      return;
    }
    if (!origName && !/^[a-z0-9_]+$/.test(name)) {
      statusEl.style.color = '#fbbf24';
      statusEl.textContent = 'Name must be lowercase letters, digits, and underscores.';
      return;
    }

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    var p = origName
      ? window.agxApi.roles.update(origName, { label: label, description: description, capabilities: caps })
      : window.agxApi.roles.create({ name: name, label: label, description: description, capabilities: caps });

    p.then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      // Refresh the current user's capability set in case they edited their
      // own role (e.g. admin removed their own ROLES_MANAGE — server lock-in
      // is the next safety, but reflect the new state in the UI now).
      if (window.agxAuth && window.agxAuth.reloadCapabilities) window.agxAuth.reloadCapabilities();
      setTimeout(function() {
        closeModal('roleEditorModal');
        renderAdminRoles();
      }, 700);
    }).catch(function(err) {
      btn.disabled = false;
      statusEl.style.color = '#e74c3c';
      statusEl.textContent = 'Failed: ' + (err.message || 'unknown error');
    });
  }

  function deleteAdminRole(name) {
    var role = _rolesCache.find(function(r) { return r.name === name; });
    if (!role) return;
    if (!confirm('Delete role "' + role.label + '"? Will fail if any user is still assigned to it.')) return;
    window.agxApi.roles.remove(name).then(function() {
      renderAdminRoles();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown error'));
    });
  }

  // Populate any role <select> with options from the cache. Used by both
  // the New User and Edit User modals so they pick up custom roles.
  function populateRoleSelect(selectEl, currentValue) {
    if (!_rolesCache.length) return loadRolesCache().then(function() { populateRoleSelect(selectEl, currentValue); });
    var html = '';
    _rolesCache.forEach(function(r) {
      var sel = (r.name === currentValue) ? ' selected' : '';
      html += '<option value="' + escapeHTML(r.name) + '"' + sel + '>' +
        escapeHTML(r.label) + (r.description ? ' &mdash; ' + escapeHTML(r.description) : '') +
      '</option>';
    });
    selectEl.innerHTML = html;
  }

  // ==================== METRICS + GO LIVE ====================
  // Renders site-wide totals plus a per-job table where the admin can toggle
  // each job between Draft and Live. Only Live jobs are eligible for the
  // Insights dashboard tickers (insights.js filters on j.liveStatus).
  function renderAdminMetrics() {
    if (!isAdmin()) return;
    var cardsEl = document.getElementById('admin-metrics-cards');
    var tbody = document.getElementById('admin-metrics-jobs-tbody');
    if (!cardsEl || !tbody) return;

    var jobs = (window.appData && window.appData.jobs) || [];
    var users = (_users.length ? _users : []);

    // ── Site metric cards ─────────────────────────────────
    var liveCount = jobs.filter(function(j) { return j.liveStatus === 'live'; }).length;
    var draftCount = jobs.length - liveCount;
    var totalContract = jobs.reduce(function(s, j) { return s + (j.contractAmount || 0); }, 0);
    var totalRev = 0;
    var totalProfit = 0;
    jobs.forEach(function(j) {
      if (typeof getJobWIP === 'function') {
        try {
          var w = getJobWIP(j.id);
          totalRev += w.revenueEarned || 0;
          totalProfit += w.revisedProfit || 0;
        } catch (e) { /* skip jobs that can't be computed */ }
      }
    });
    var activeUsers = users.filter(function(u) { return u.active; }).length;

    function metricCard(label, value, sub) {
      return '<div style="flex:1 1 160px;min-width:160px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:10px;padding:14px 16px;">' +
        '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:6px;">' + label + '</div>' +
        '<div style="font-size:20px;font-weight:600;color:var(--text,#fff);">' + value + '</div>' +
        (sub ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px;">' + sub + '</div>' : '') +
      '</div>';
    }

    cardsEl.innerHTML =
      metricCard('Jobs', jobs.length, liveCount + ' live · ' + draftCount + ' draft') +
      metricCard('Contract Value', formatCurrency(totalContract), 'across all jobs') +
      metricCard('Revenue Earned', formatCurrency(totalRev), 'live state') +
      metricCard('Gross Profit', formatCurrency(totalProfit), 'live state') +
      metricCard('Active Users', activeUsers, users.length + ' total');

    // ── Job status table ──────────────────────────────────
    if (!jobs.length) {
      tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">No jobs.</td></tr>';
      return;
    }
    var html = '';
    jobs.forEach(function(j) {
      var owner = users.find(function(u) { return u.id === j.owner_id; });
      var ownerName = owner ? owner.name : '—';
      var label = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.id);
      var isLive = j.liveStatus === 'live';
      var statusBadge = isLive
        ? '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:rgba(52,211,153,0.15);color:#34d399;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Live</span>'
        : '<span style="display:inline-block;padding:2px 10px;border-radius:10px;background:rgba(251,191,36,0.15);color:#fbbf24;font-size:11px;text-transform:uppercase;letter-spacing:0.5px;">Draft</span>';
      var actionBtn = isLive
        ? '<button onclick="captureNowForJob(\'' + escapeHTML(j.id) + '\')" style="font-size:11px;padding:4px 10px;background:rgba(79,140,255,0.15);color:#4f8cff;border:1px solid rgba(79,140,255,0.3);border-radius:5px;cursor:pointer;margin-right:6px;">Capture Now</button>' +
          '<button onclick="toggleJobLiveStatus(\'' + escapeHTML(j.id) + '\', false)" style="font-size:11px;padding:4px 12px;background:rgba(251,191,36,0.15);color:#fbbf24;border:1px solid rgba(251,191,36,0.3);border-radius:5px;cursor:pointer;">Revert to Draft</button>'
        : '<button onclick="toggleJobLiveStatus(\'' + escapeHTML(j.id) + '\', true)" style="font-size:11px;padding:4px 12px;background:#34d399;color:#0a0a0f;border:none;border-radius:5px;cursor:pointer;font-weight:600;">Go Live</button>';

      html += '<tr>' +
        '<td><strong>' + escapeHTML(label) + '</strong>' +
          (j.client ? '<div style="font-size:10px;color:var(--text-dim,#888);">' + escapeHTML(j.client) + '</div>' : '') +
        '</td>' +
        '<td>' + escapeHTML(ownerName) + '</td>' +
        '<td style="text-align:right;">' + formatCurrency(j.contractAmount || 0) + '</td>' +
        '<td style="text-align:right;">' + (j.pctComplete || 0).toFixed(1) + '%</td>' +
        '<td style="text-align:center;">' + statusBadge + '</td>' +
        '<td style="text-align:center;">' + actionBtn + '</td>' +
      '</tr>';
    });
    tbody.innerHTML = html;
  }

  // Toggle a job's liveStatus between 'live' and 'draft'. Pure client-side
  // mutation — saveData() already syncs to the server via bulk save.
  // Going Live also captures an immediate baseline snapshot so the job has
  // day-one history on Insights without waiting for the next 3 AM tick.
  function toggleJobLiveStatus(jobId, goLive) {
    var jobs = (window.appData && window.appData.jobs) || [];
    var job = jobs.find(function(j) { return j.id === jobId; });
    if (!job) return;
    if (goLive && !confirm('Mark "' + (job.title || job.id) + '" as Live?\n\nIt will start showing on the Insights dashboard.')) return;
    job.liveStatus = goLive ? 'live' : 'draft';
    job.updatedAt = new Date().toISOString();
    if (goLive && typeof captureDailySnapshot === 'function') {
      captureDailySnapshot(jobId, true); // force=true since we just flipped to live
    }
    if (typeof saveData === 'function') saveData();
    renderAdminMetrics();
  }

  // Manual override: capture today's snapshot immediately for a single job,
  // overwriting whatever was there from the 3 AM auto-capture (or creating
  // it if missing). Useful after a big mid-day data update.
  function captureNowForJob(jobId) {
    if (typeof captureDailySnapshot !== 'function') {
      alert('Snapshot helper not loaded.');
      return;
    }
    var ok = captureDailySnapshot(jobId, true);
    if (ok) {
      if (typeof saveData === 'function') saveData();
      renderAdminMetrics();
    } else {
      alert('Could not capture snapshot for that job.');
    }
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
  window.renderAdminJobs = renderAdminJobs;
  window.reassignJobOwner = reassignJobOwner;
  window.openJobShareManager = openJobShareManager;
  window.openGrantAccessFromAdmin = openGrantAccessFromAdmin;
  window.updateAdminJobAccessLevel = updateAdminJobAccessLevel;
  window.revokeAdminJobAccess = revokeAdminJobAccess;
  window.switchAdminSubTab = switchAdminSubTab;
  window.renderAdminMetrics = renderAdminMetrics;
  window.toggleJobLiveStatus = toggleJobLiveStatus;
  window.captureNowForJob = captureNowForJob;
  window.renderAdminRoles = renderAdminRoles;
  window.openNewRoleModal = openNewRoleModal;
  window.openEditRoleModal = openEditRoleModal;
  window.submitRoleEditor = submitRoleEditor;
  window.deleteAdminRole = deleteAdminRole;
})();
