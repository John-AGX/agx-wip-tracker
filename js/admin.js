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

  // Local escape helper — null-safe wrapper around the global escapeHTML.
  // Used for inline-string attribute interpolation (onclick handlers,
  // data-* attrs, value attrs) where a null/undefined would otherwise
  // serialize as the literal string "null" / "undefined".
  function escapeAttr(v) {
    return escapeHTML(v == null ? '' : String(v));
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
          ? '<button class="ee-btn ghost" disabled title="You cannot delete your own account" style="margin-left:4px;">Delete</button>'
          : '<button class="ee-btn danger" onclick="deleteAdminUser(' + u.id + ')" style="margin-left:4px;">Delete</button>';
        html += '<tr>' +
          '<td>' + escapeHTML(u.name || '') + '</td>' +
          '<td>' + escapeHTML(u.email || '') + '</td>' +
          '<td>' + roleBadge(u.role) + '</td>' +
          '<td style="text-align:center;">' + activeBadge + '</td>' +
          '<td>' + fmtDate(u.created_at) + '</td>' +
          '<td style="text-align:center;white-space:nowrap;">' +
            '<button class="ee-btn secondary" onclick="openEditUserModal(' + u.id + ')">Edit</button>' +
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
    // Three-way confirm: send-with-email / send-silently / abort.
    // Native confirm() can only do binary; the in-house ternary
    // dialog gives the admin a real "reassign without spam" path.
    window.agxConfirmTernary({
      title: 'Reassign job',
      message: 'Email the new owner about this assignment?',
      primaryLabel: 'Send email',
      secondaryLabel: 'Reassign silently',
      cancelLabel: 'Cancel'
    }).then(function(action) {
      if (!action) {
        // Cancel — undo the dropdown change in the UI.
        renderAdminJobs();
        return;
      }
      var notifyOk = (action === 'primary');
      window.agxApi.jobs.reassignOwner(jobId, parseInt(newOwnerId, 10), notifyOk)
        .then(function() {
          if (window.agxData) window.agxData.reloadFromServer();
          renderAdminJobs();
        })
        .catch(function(err) {
          window.agxAlert({ title: 'Reassign failed', message: err.message || 'unknown error' });
          renderAdminJobs();
        });
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
  // ==================== MATERIALS CATALOG ====================
  // Browse + edit AGX's vendor purchase catalog. Backed by /api/materials,
  // populated by uploading vendor CSVs (Home Depot today; Lowe's / etc.
  // later via the same endpoint with a different vendor name).
  //
  // Catalog drives the AG `search_materials` tool — when the estimator is
  // proposing line items, it queries this list for real AGX descriptions
  // and prices instead of guessing. Admins can fix descriptions, change
  // subgroup assignments, or hide noise rows.
  var _materialsCache = [];
  var _materialsCategories = []; // [{name, n}, ...]
  var _materialsFilters = { q: '', subgroup: '', category: '', show_hidden: false };
  var _materialsTotal = 0;

  function renderAdminMaterials() {
    if (!isAdmin()) return;
    var pane = document.getElementById('admin-subtab-materials');
    if (!pane) return;
    // Initial chrome: upload + filter row + status line + table mount.
    // Renders once per admin tab visit; loadMaterials repaints the table.
    pane.innerHTML =
      '<div class="action-buttons" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
        '<button class="ee-btn primary" onclick="document.getElementById(\'mat-upload-input\').click()">' +
          '&#x1F4E5; Import vendor CSV' +
        '</button>' +
        '<input type="file" id="mat-upload-input" accept=".csv" style="display:none;" onchange="handleMaterialsImportFile(event)" />' +
        '<button class="ee-btn secondary" onclick="reloadMaterials()">Refresh</button>' +
        '<button class="ee-btn ghost" onclick="recategorizeMaterials()" title="Re-run category mapping across all non-curated rows. Useful after schema upgrade.">&#x1F501; Recategorize</button>' +
        '<select id="mat-filter-category" onchange="onMaterialsFilterChange()" style="margin-left:auto;min-width:170px;">' +
          '<option value="">All categories</option>' +
        '</select>' +
        '<select id="mat-filter-subgroup" onchange="onMaterialsFilterChange()" style="min-width:130px;">' +
          '<option value="">All subgroups</option>' +
          '<option value="materials">Materials</option>' +
          '<option value="labor">Labor</option>' +
          '<option value="gc">GC</option>' +
          '<option value="sub">Subs</option>' +
        '</select>' +
        '<label style="display:inline-flex;align-items:center;gap:6px;font-size:11px;color:var(--text-dim,#aaa);text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;cursor:pointer;">' +
          '<input id="mat-filter-hidden" type="checkbox" onchange="onMaterialsFilterChange()" style="margin:0;" /> show hidden' +
        '</label>' +
        '<input type="text" id="mat-search" oninput="onMaterialsFilterChange()" placeholder="Search descriptions, SKU…" style="min-width:240px;" />' +
      '</div>' +
      '<p id="mat-summary" style="margin:12px 0;color:var(--text-dim,#888);font-size:12px;">Loading…</p>' +
      '<div id="mat-import-status" style="display:none;margin-bottom:12px;padding:10px 12px;border-radius:6px;font-size:12px;"></div>' +
      '<div id="mat-list"></div>';
    loadMaterialCategories();
    loadMaterials();
  }

  function loadMaterialCategories() {
    if (!window.agxApi || !window.agxApi.materials) return;
    window.agxApi.materials.categories().then(function(res) {
      _materialsCategories = res.categories || [];
      var sel = document.getElementById('mat-filter-category');
      if (!sel) return;
      var current = _materialsFilters.category || '';
      var html = '<option value="">All categories</option>';
      _materialsCategories.forEach(function(c) {
        if (c.n === 0) return; // skip canonical-but-empty buckets
        var selAttr = c.name === current ? ' selected' : '';
        html += '<option value="' + escapeHTML(c.name) + '"' + selAttr + '>' + escapeHTML(c.name) + ' (' + c.n + ')</option>';
      });
      sel.innerHTML = html;
    }).catch(function() { /* leave default */ });
  }

  function recategorizeMaterials() {
    if (!confirm('Re-run category mapping across all materials that haven\'t been manually edited? Curated rows are preserved.')) return;
    window.agxApi.materials.recategorize().then(function(res) {
      var statusEl = document.getElementById('mat-import-status');
      if (statusEl) {
        statusEl.style.display = 'block';
        statusEl.style.background = 'rgba(52,211,153,0.10)';
        statusEl.style.border = '1px solid rgba(52,211,153,0.35)';
        statusEl.style.color = '#34d399';
        statusEl.innerHTML = '✓ Recategorized ' + res.touched + ' rows across ' + res.distinct_categories + ' categories.';
      }
      loadMaterialCategories();
      loadMaterials();
    }).catch(function(err) {
      alert('Recategorize failed: ' + (err.message || err));
    });
  }

  function loadMaterials() {
    if (!window.agxApi) return;
    var listEl = document.getElementById('mat-list');
    if (listEl) listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading…</div>';
    window.agxApi.materials.list({
      q: _materialsFilters.q,
      subgroup: _materialsFilters.subgroup,
      category: _materialsFilters.category,
      show_hidden: _materialsFilters.show_hidden ? '1' : '',
      limit: 500
    }).then(function(res) {
      _materialsCache = res.materials || [];
      _materialsTotal = res.totalInDb || 0;
      renderMaterialsTable();
    }).catch(function(err) {
      if (listEl) listEl.innerHTML = '<div style="padding:20px;color:#f87171;text-align:center;">Failed to load: ' + escapeHTML(err.message || '') + '</div>';
    });
  }

  function reloadMaterials() {
    _materialsFilters.q = '';
    var qInput = document.getElementById('mat-search');
    if (qInput) qInput.value = '';
    loadMaterials();
  }

  function onMaterialsFilterChange() {
    var qInput = document.getElementById('mat-search');
    var sgInput = document.getElementById('mat-filter-subgroup');
    var catInput = document.getElementById('mat-filter-category');
    var hidInput = document.getElementById('mat-filter-hidden');
    _materialsFilters.q = qInput ? qInput.value.trim() : '';
    _materialsFilters.subgroup = sgInput ? sgInput.value : '';
    _materialsFilters.category = catInput ? catInput.value : '';
    _materialsFilters.show_hidden = hidInput ? !!hidInput.checked : false;
    // Tiny debounce so each keystroke doesn't fire a request.
    clearTimeout(window._matFilterTimer);
    window._matFilterTimer = setTimeout(loadMaterials, 200);
  }

  function fmtMoney(n) {
    if (n == null || n === '') return '—';
    var v = Number(n);
    if (isNaN(v)) return '—';
    return '$' + v.toFixed(2);
  }
  function fmtDate(d) {
    if (!d) return '—';
    return String(d).slice(0, 10);
  }

  function renderMaterialsTable() {
    var listEl = document.getElementById('mat-list');
    var summaryEl = document.getElementById('mat-summary');
    if (!listEl) return;
    var rows = _materialsCache;
    if (summaryEl) {
      var bits = [_materialsTotal + ' total in catalog'];
      if (rows.length !== _materialsTotal) bits.unshift('Showing ' + rows.length);
      summaryEl.textContent = bits.join(' · ');
    }
    if (!rows.length) {
      var hint = _materialsTotal === 0
        ? 'Catalog is empty. Click <strong>📥 Import vendor CSV</strong> to load your purchase history.'
        : 'No materials match the current filters.';
      listEl.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);border:1px dashed var(--border,#333);border-radius:8px;">' + hint + '</div>';
      return;
    }
    var html =
      '<table class="dense-table">' +
        '<thead><tr>' +
          '<th>Description</th>' +
          '<th style="width:160px;">Category</th>' +
          '<th style="width:90px;">Subgroup</th>' +
          '<th style="width:60px;">Unit</th>' +
          '<th class="num" style="width:90px;">Last $</th>' +
          '<th class="num" style="width:90px;">Avg $</th>' +
          '<th class="num" style="width:60px;">Buys</th>' +
          '<th style="width:90px;">Last seen</th>' +
          '<th style="width:120px;text-align:right;">Actions</th>' +
        '</tr></thead>' +
        '<tbody>';
    rows.forEach(function(m) {
      var subgroupBadge = m.agx_subgroup
        ? '<span style="padding:1px 7px;border-radius:9px;background:rgba(79,140,255,0.12);color:#4f8cff;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">' + escapeHTML(m.agx_subgroup) + '</span>'
        : '<span style="color:var(--text-dim,#666);font-style:italic;font-size:11px;">unmapped</span>';
      var categoryBadge = m.category
        ? '<span style="padding:1px 8px;border-radius:9px;background:rgba(251,191,36,0.10);color:#fbbf24;font-size:11px;font-weight:500;">' + escapeHTML(m.category) + '</span>'
        : '<span style="color:var(--text-dim,#666);font-style:italic;font-size:11px;">none</span>';
      var hiddenBadge = m.is_hidden
        ? '<span style="padding:1px 7px;border-radius:9px;background:rgba(248,113,113,0.10);color:#f87171;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;margin-left:6px;">Hidden</span>'
        : '';
      var manualBadge = m.manual_override
        ? '<span title="Description manually edited — protected from re-import" style="padding:1px 7px;border-radius:9px;background:rgba(52,211,153,0.10);color:#34d399;font-size:10px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;margin-left:6px;">Edited</span>'
        : '';
      var skuLine = m.sku
        ? '<div style="font-size:10px;color:var(--text-dim,#888);font-family:\'SF Mono\',monospace;margin-top:2px;">SKU ' + escapeHTML(m.sku) + (m.hd_class ? ' · ' + escapeHTML(m.hd_class) + (m.hd_subclass ? ' / ' + escapeHTML(m.hd_subclass) : '') : '') + '</div>'
        : '';
      html += '<tr data-mat-id="' + m.id + '" style="' + (m.is_hidden ? 'opacity:0.55;' : '') + '">' +
        '<td>' +
          '<div style="font-size:13px;color:var(--text,#fff);">' + escapeHTML(m.description || m.raw_description || '') + manualBadge + hiddenBadge + '</div>' +
          skuLine +
        '</td>' +
        '<td>' + categoryBadge + '</td>' +
        '<td>' + subgroupBadge + '</td>' +
        '<td style="font-family:\'SF Mono\',monospace;font-size:12px;">' + escapeHTML(m.unit || 'ea') + '</td>' +
        '<td class="num" style="font-family:\'SF Mono\',monospace;color:#34d399;">' + fmtMoney(m.last_unit_price) + '</td>' +
        '<td class="num" style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);">' + fmtMoney(m.avg_unit_price) + '</td>' +
        '<td class="num" style="font-family:\'SF Mono\',monospace;">' + (m.purchase_count || 0) + '</td>' +
        '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + fmtDate(m.last_seen) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="ee-btn ee-icon-btn secondary" onclick="openMaterialEditor(' + m.id + ')" title="Edit">&#x270F;&#xFE0F;</button>' +
          '<button class="ee-btn ee-icon-btn ghost" onclick="toggleMaterialHidden(' + m.id + ')" title="' + (m.is_hidden ? 'Unhide' : 'Hide') + '">' + (m.is_hidden ? '&#x1F441;' : '&#x1F441;&#xFE0F;') + '</button>' +
        '</td>' +
      '</tr>';
    });
    html += '</tbody></table>';
    listEl.innerHTML = html;
  }

  function toggleMaterialHidden(id) {
    var m = _materialsCache.find(function(x) { return x.id === id; });
    if (!m) return;
    window.agxApi.materials.update(id, { is_hidden: !m.is_hidden }).then(loadMaterials);
  }

  // Inline editor — modal with description, subgroup, unit, hidden, notes.
  function openMaterialEditor(id) {
    var m = _materialsCache.find(function(x) { return x.id === id; });
    if (!m) return;
    var modal = document.getElementById('matEditorModal') || createMaterialEditorModal();
    // Repopulate category dropdown each open so newly-observed
    // categories from a recent import show up.
    var catSel = document.getElementById('matEd_category');
    if (catSel) {
      var opts = '<option value="">— None —</option>';
      _materialsCategories.forEach(function(c) { opts += '<option value="' + escapeHTML(c.name) + '">' + escapeHTML(c.name) + '</option>'; });
      // If the row's current category isn't in the list yet, append it
      if (m.category && !_materialsCategories.some(function(c) { return c.name === m.category; })) {
        opts += '<option value="' + escapeHTML(m.category) + '">' + escapeHTML(m.category) + ' (custom)</option>';
      }
      catSel.innerHTML = opts;
      catSel.value = m.category || '';
    }
    document.getElementById('matEd_id').value = m.id;
    document.getElementById('matEd_raw').textContent = m.raw_description || '';
    document.getElementById('matEd_description').value = m.description || '';
    document.getElementById('matEd_subgroup').value = m.agx_subgroup || 'materials';
    document.getElementById('matEd_unit').value = m.unit || 'ea';
    document.getElementById('matEd_hidden').checked = !!m.is_hidden;
    document.getElementById('matEd_notes').value = m.notes || '';
    document.getElementById('matEd_status').textContent = '';
    openModal('matEditorModal');
  }

  function createMaterialEditorModal() {
    var modal = document.createElement('div');
    modal.id = 'matEditorModal';
    modal.className = 'modal';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">Edit Material</div>' +
        '<div style="padding:18px 22px;">' +
          '<input type="hidden" id="matEd_id" />' +
          '<div style="margin-bottom:12px;font-size:11px;color:var(--text-dim,#888);">Vendor description (read-only): <span id="matEd_raw" style="color:var(--text,#ccc);font-family:\'SF Mono\',monospace;font-size:12px;"></span></div>' +
          '<div class="form-group">' +
            '<label>Display description (used by AG)</label>' +
            '<input type="text" id="matEd_description" style="width:100%;" />' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Category</label>' +
            '<select id="matEd_category"></select>' +
          '</div>' +
          '<div style="display:grid;grid-template-columns:2fr 1fr;gap:12px;">' +
            '<div class="form-group">' +
              '<label>Subgroup</label>' +
              '<select id="matEd_subgroup">' +
                '<option value="materials">Materials</option>' +
                '<option value="labor">Labor</option>' +
                '<option value="gc">GC</option>' +
                '<option value="sub">Subs</option>' +
              '</select>' +
            '</div>' +
            '<div class="form-group">' +
              '<label>Unit</label>' +
              '<input type="text" id="matEd_unit" placeholder="ea, qt, lb, lf…" />' +
            '</div>' +
          '</div>' +
          '<div class="form-group">' +
            '<label class="agx-check-row">' +
              '<input type="checkbox" id="matEd_hidden" />' +
              '<span>Hide from AG suggestions <span class="agx-check-hint">(noise / one-off / wrong)</span></span>' +
            '</label>' +
          '</div>' +
          '<div class="form-group">' +
            '<label>Notes</label>' +
            '<textarea id="matEd_notes" rows="2" style="width:100%;resize:vertical;" placeholder="Optional — usage tips, alternates, supplier details…"></textarea>' +
          '</div>' +
          '<p id="matEd_status" style="margin-top:6px;font-size:12px;"></p>' +
        '</div>' +
        '<div class="modal-footer">' +
          '<button class="ee-btn secondary" onclick="closeModal(\'matEditorModal\')">Cancel</button>' +
          '<button class="ee-btn primary" onclick="saveMaterialEditor()">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    return modal;
  }

  function saveMaterialEditor() {
    var id = document.getElementById('matEd_id').value;
    var payload = {
      description: document.getElementById('matEd_description').value.trim(),
      agx_subgroup: document.getElementById('matEd_subgroup').value,
      category: document.getElementById('matEd_category').value || null,
      unit: document.getElementById('matEd_unit').value.trim(),
      is_hidden: document.getElementById('matEd_hidden').checked,
      notes: document.getElementById('matEd_notes').value.trim() || null
    };
    var statusEl = document.getElementById('matEd_status');
    statusEl.style.color = 'var(--text-dim,#aaa)';
    statusEl.textContent = 'Saving…';
    window.agxApi.materials.update(id, payload).then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      setTimeout(function() {
        closeModal('matEditorModal');
        loadMaterials();
      }, 400);
    }).catch(function(err) {
      statusEl.style.color = '#f87171';
      statusEl.textContent = 'Failed: ' + (err.message || err);
    });
  }

  // ─── CSV import ────────────────────────────────────────────────
  // Parse browser-side via SheetJS (already loaded by proposal.js for
  // the BT export), then POST the row array to the import endpoint.
  // Keeping the parse on the client means the server doesn't need a
  // CSV dependency and we can show a preview / row count before upload.
  function handleMaterialsImportFile(event) {
    var file = event && event.target && event.target.files && event.target.files[0];
    event.target.value = ''; // allow re-selecting the same file
    if (!file) return;
    if (typeof XLSX === 'undefined') {
      alert('Spreadsheet library still loading. Try again in a moment.');
      return;
    }
    var statusEl = document.getElementById('mat-import-status');
    if (statusEl) {
      statusEl.style.display = 'block';
      statusEl.style.background = 'rgba(79,140,255,0.08)';
      statusEl.style.border = '1px solid rgba(79,140,255,0.25)';
      statusEl.style.color = 'var(--text,#ddd)';
      statusEl.innerHTML = '⏳ Parsing <strong>' + escapeHTML(file.name) + '</strong>…';
    }
    var reader = new FileReader();
    reader.onload = function(e) {
      try {
        var text = e.target.result;
        // HD's CSV has 5 metadata rows + a blank row before the header
        // (Date, Store Number, ...). SheetJS header detection won't find
        // it automatically, so we strip the prelude here.
        var headerIdx = text.indexOf('Date,Store Number,');
        if (headerIdx >= 0) text = text.slice(headerIdx);
        var wb = XLSX.read(text, { type: 'string' });
        var ws = wb.Sheets[wb.SheetNames[0]];
        // raw: false keeps every column as a string. Without this, SheetJS
        // auto-detects ISO dates ("2026-04-29") and converts them to JS
        // Date objects, which then fail the server-side YYYY-MM-DD parse.
        // Numeric columns also stay as strings, so the server's str()
        // coercion has nothing to do.
        var rows = XLSX.utils.sheet_to_json(ws, { defval: '', raw: false });
        if (!rows.length) {
          throw new Error('No data rows in CSV');
        }
        if (statusEl) statusEl.innerHTML = '⏳ Uploading <strong>' + rows.length + '</strong> rows…';
        // Detect vendor — for now Home Depot is the only format. Future:
        // dropdown on the import button.
        var vendor = 'home_depot';
        window.agxApi.materials.importBatch({
          vendor: vendor,
          source_file: file.name,
          rows: rows
        }).then(function(res) {
          if (statusEl) {
            statusEl.style.background = 'rgba(52,211,153,0.10)';
            statusEl.style.border = '1px solid rgba(52,211,153,0.35)';
            statusEl.style.color = '#34d399';
            statusEl.innerHTML =
              '✓ Imported. ' +
              '<strong>' + res.unique_materials + '</strong> unique materials processed · ' +
              '<strong>' + res.inserted + '</strong> new · ' +
              '<strong>' + res.updated + '</strong> updated · ' +
              (res.protected_admin_edits ? '<strong>' + res.protected_admin_edits + '</strong> admin-edited (description preserved) · ' : '') +
              '<strong>' + res.skipped + '</strong> skipped (fees/blank).';
          }
          loadMaterials();
        }).catch(function(err) {
          if (statusEl) {
            statusEl.style.background = 'rgba(248,113,113,0.10)';
            statusEl.style.border = '1px solid rgba(248,113,113,0.35)';
            statusEl.style.color = '#f87171';
            statusEl.innerHTML = '✗ Import failed: ' + escapeHTML(err.message || '');
          }
        });
      } catch (err) {
        if (statusEl) {
          statusEl.style.background = 'rgba(248,113,113,0.10)';
          statusEl.style.border = '1px solid rgba(248,113,113,0.35)';
          statusEl.style.color = '#f87171';
          statusEl.innerHTML = '✗ Parse failed: ' + escapeHTML(err.message || '');
        }
      }
    };
    reader.onerror = function() {
      if (statusEl) {
        statusEl.style.background = 'rgba(248,113,113,0.10)';
        statusEl.style.color = '#f87171';
        statusEl.innerHTML = '✗ Could not read the file.';
      }
    };
    reader.readAsText(file);
  }

  window.renderAdminMaterials = renderAdminMaterials;
  window.reloadMaterials = reloadMaterials;
  window.onMaterialsFilterChange = onMaterialsFilterChange;
  window.openMaterialEditor = openMaterialEditor;
  window.saveMaterialEditor = saveMaterialEditor;
  window.toggleMaterialHidden = toggleMaterialHidden;
  window.handleMaterialsImportFile = handleMaterialsImportFile;
  window.recategorizeMaterials = recategorizeMaterials;

  function switchAdminSubTab(name) {
    document.querySelectorAll('[data-admin-subtab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.adminSubtab === name);
    });
    document.querySelectorAll('.admin-subtab-content').forEach(function(c) {
      c.style.display = 'none';
    });
    var target = document.getElementById('admin-subtab-' + name);
    // Use explicit 'block' instead of '' — the latter only clears the
    // inline display attr, which doesn't always win against the
    // markup's initial style="display:none;" depending on browser
    // state. Setting block guarantees the pane shows.
    if (target) target.style.display = 'block';
    if (name === 'users') renderAdminUsers();
    else if (name === 'jobs') renderAdminJobs();
    else if (name === 'metrics') renderAdminMetrics();
    else if (name === 'roles') renderAdminRoles();
    else if (name === 'templates') renderAdminTemplates();
    else if (name === 'materials') renderAdminMaterials();
    else if (name === 'email') renderAdminEmail();
    else if (name === 'agents') renderAdminAgents();
    // 'email-templates' moved into Templates → Email; if a saved nav state
    // points at the old top-level tab, reroute to templates.
    else if (name === 'email-templates') {
      _templatesActiveTab = 'email';
      try { sessionStorage.setItem('agx_templates_tab', 'email'); } catch (e) {}
      switchAdminSubTab('templates');
      return;
    }
    // Persist nav state so a refresh lands back on this admin sub-tab.
    if (typeof window.agxNavSave === 'function') window.agxNavSave();
  }

  // ==================== EMAIL ADMIN ====================
  // Sectioned admin surface for the notifications feature:
  //   1. Provider status banner (configured? dry-run?)
  //   2. Events & triggers table (per-event toggle + per-event BCC)
  //   3. Global defaults (global BCC, digest mode, quiet hours)
  //   4. Send test message
  //   5. Recent send log
  //
  // The events table + global defaults read/write app_settings('email')
  // via /api/email/settings; toggles are saved as the user clicks.
  // Templates live in a separate sub-tab — see renderAdminEmailTemplates.
  var _emailSettings = null;   // last-loaded settings blob (mutated as user edits)
  var _emailEvents = [];       // EVENTS catalog merged with current settings

  function renderAdminEmail() {
    if (!isAdmin()) return;
    var pane = document.getElementById('admin-subtab-email');
    if (!pane) return;
    pane.innerHTML =
      '<div style="display:flex;flex-direction:column;gap:18px;">' +
        // Provider status banner.
        '<div id="email-config-status" class="card" style="padding:14px 16px;font-size:13px;color:var(--text-dim,#888);">' +
          'Loading provider status…' +
        '</div>' +
        // Events & triggers table.
        '<div class="card" style="padding:16px;">' +
          '<div style="display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:8px;gap:10px;">' +
            '<div>' +
              '<h3 style="margin:0 0 4px 0;">Events &amp; triggers</h3>' +
              '<p style="margin:0;color:var(--text-dim,#888);font-size:12px;">Toggle an event to enable/disable that notification across the app. ' +
                'Add comma-separated BCC addresses to copy admins on a given event.</p>' +
            '</div>' +
            '<button class="ee-btn secondary" id="email-events-refresh" style="white-space:nowrap;">&#x21BB; Refresh</button>' +
          '</div>' +
          '<div id="email-events-tbl" style="font-size:13px;color:var(--text-dim,#888);">Loading…</div>' +
        '</div>' +
        // Global defaults card.
        '<div class="card" style="padding:16px;">' +
          '<h3 style="margin:0 0 4px 0;">Global defaults</h3>' +
          '<p style="margin:0 0 12px 0;color:var(--text-dim,#888);font-size:12px;">Applied to every outbound notification.</p>' +
          '<div id="email-globals" style="display:flex;flex-direction:column;gap:14px;font-size:13px;">Loading…</div>' +
        '</div>' +
        // Send test message card.
        '<div class="card" style="padding:16px;">' +
          '<h3 style="margin:0 0 4px 0;">Send a test email</h3>' +
          '<p style="margin:0 0 12px 0;color:var(--text-dim,#888);font-size:12px;">Fires a hardcoded test message — useful for verifying provider config + DNS.</p>' +
          '<div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;">' +
            '<input type="email" id="email-test-to" placeholder="recipient@example.com" ' +
              'style="flex:1;min-width:240px;background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;font-size:13px;" />' +
            '<button class="ee-btn primary" id="email-test-send">&#x1F4E7; Send test</button>' +
          '</div>' +
          '<div id="email-test-result" style="margin-top:10px;font-size:12px;"></div>' +
        '</div>' +
        // Recent log card.
        '<div class="card" style="padding:16px;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
            '<h3 style="margin:0;">Recent send log</h3>' +
            '<div style="display:flex;gap:6px;align-items:center;">' +
              '<select id="email-log-status-filter" style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:4px 8px;font-size:12px;">' +
                '<option value="">All statuses</option>' +
                '<option value="sent">Sent</option>' +
                '<option value="failed">Failed</option>' +
                '<option value="dry-run">Dry-run</option>' +
                '<option value="unconfigured">Unconfigured</option>' +
              '</select>' +
              '<button class="ee-btn secondary" id="email-log-refresh">&#x21BB; Refresh</button>' +
            '</div>' +
          '</div>' +
          '<div id="email-log-tbl" style="font-size:12px;color:var(--text-dim,#888);">Loading…</div>' +
        '</div>' +
      '</div>';

    var me = (window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser()) || null;
    var toEl = document.getElementById('email-test-to');
    if (me && me.email && toEl) toEl.value = me.email;

    document.getElementById('email-test-send').addEventListener('click', function() {
      var to = document.getElementById('email-test-to').value.trim();
      if (!to) { alert('Enter a recipient email.'); return; }
      var resultEl = document.getElementById('email-test-result');
      resultEl.innerHTML = '<span style="color:#60a5fa;">Sending…</span>';
      window.agxApi.post('/api/email/test', { to: to }).then(function(r) {
        if (r.ok) {
          resultEl.innerHTML =
            '<span style="color:#34d399;">&#x2713; Sent</span>' +
            (r.providerId ? ' &middot; provider id: <code>' + escapeHTML(r.providerId) + '</code>' : '') +
            (r.dryRun ? ' &middot; <strong>DRY RUN</strong> — no email actually delivered' : '');
        } else {
          resultEl.innerHTML =
            '<span style="color:#f87171;">&#x2716; Failed:</span> ' + escapeHTML(r.error || 'unknown error') +
            (r.configured ? '' : '<br/><span style="color:#fbbf24;">RESEND_API_KEY or EMAIL_FROM not set in environment.</span>');
        }
        loadEmailLog();
      }).catch(function(err) {
        resultEl.innerHTML = '<span style="color:#f87171;">&#x2716; Request failed:</span> ' + escapeHTML(err.message || String(err));
      });
    });
    document.getElementById('email-log-refresh').addEventListener('click', loadEmailLog);
    document.getElementById('email-log-status-filter').addEventListener('change', loadEmailLog);
    document.getElementById('email-events-refresh').addEventListener('click', loadEmailEventsAndSettings);

    loadEmailEventsAndSettings();
    loadEmailLog();
  }

  // Load the events catalog + settings together, then render the
  // events table and the globals card. Saving any control on the page
  // mutates _emailSettings in-place and re-PUTs to /api/email/settings.
  function loadEmailEventsAndSettings() {
    var evtBox = document.getElementById('email-events-tbl');
    var globBox = document.getElementById('email-globals');
    if (!evtBox || !globBox) return;
    Promise.all([
      window.agxApi.get('/api/email/events'),
      window.agxApi.get('/api/email/settings')
    ]).then(function(results) {
      _emailEvents = (results[0] && results[0].events) || [];
      _emailSettings = (results[1] && results[1].settings) || {
        events: {}, globalBcc: '', digestMode: false,
        quietHours: { enabled: false, start: '21:00', end: '07:00' }
      };
      renderProviderStatus(results[1] && results[1].configured, results[1] && results[1].dryRunMode);
      renderEmailEventsTable();
      renderEmailGlobals();
    }).catch(function(err) {
      evtBox.innerHTML = '<div style="padding:14px;color:#f87171;">Failed to load: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  function renderProviderStatus(configured, dryRun) {
    var el = document.getElementById('email-config-status');
    if (!el) return;
    if (!configured) {
      el.innerHTML = '<span style="color:#fbbf24;font-weight:600;">&#9888; Email not configured.</span> ' +
        'Set <code>RESEND_API_KEY</code> and <code>EMAIL_FROM</code> in Railway environment variables. ' +
        'No emails will send until both are present.';
    } else if (dryRun) {
      el.innerHTML = '<span style="color:#fbbf24;font-weight:600;">DRY-RUN mode active</span> &mdash; ' +
        'emails are logged but not actually delivered. Unset <code>EMAIL_DRY_RUN</code> to enable real sends.';
    } else {
      el.innerHTML = '<span style="color:#34d399;font-weight:600;">&#x2713; Configured</span> &mdash; provider: Resend. ' +
        'Outbound emails will be sent and logged.';
    }
  }

  function renderEmailEventsTable() {
    var box = document.getElementById('email-events-tbl');
    if (!box) return;
    if (!_emailEvents.length) {
      box.innerHTML = '<div style="padding:14px;color:var(--text-dim,#888);">No events defined.</div>';
      return;
    }
    // Group events by category so the table reads as a structured menu
    // rather than a flat dump.
    var byCat = {};
    _emailEvents.forEach(function(e) {
      var cat = e.category || 'Other';
      if (!byCat[cat]) byCat[cat] = [];
      byCat[cat].push(e);
    });
    var cats = Object.keys(byCat).sort();
    var html = '<table class="dense-table" style="width:100%;border-collapse:collapse;font-size:13px;">' +
      '<thead style="border-bottom:1px solid var(--border,#333);">' +
        '<tr>' +
          '<th style="text-align:left;padding:8px;">Event</th>' +
          '<th style="text-align:left;padding:8px;">Audience</th>' +
          '<th style="text-align:center;padding:8px;width:90px;">Enabled</th>' +
          '<th style="text-align:left;padding:8px;width:240px;">Per-event BCC (comma-sep.)</th>' +
          '<th style="text-align:center;padding:8px;width:80px;">Wired</th>' +
          '<th style="text-align:center;padding:8px;width:120px;">Send sample</th>' +
        '</tr>' +
      '</thead><tbody>';
    cats.forEach(function(cat) {
      html += '<tr><td colspan="6" style="padding:10px 8px 4px 8px;color:var(--text-dim,#aaa);font-size:11px;text-transform:uppercase;letter-spacing:0.6px;">' + escapeHTML(cat) + '</td></tr>';
      byCat[cat].forEach(function(e) {
        var bccVal = Array.isArray(e.bcc) ? e.bcc.join(', ') : '';
        html += '<tr style="border-bottom:1px solid var(--border,#2a2a3a);">' +
          '<td style="padding:8px;vertical-align:top;">' +
            '<div style="font-weight:600;color:var(--text);">' + escapeHTML(e.label) + '</div>' +
            '<div style="color:var(--text-dim,#888);font-size:11px;margin-top:2px;">' + escapeHTML(e.description || '') + '</div>' +
          '</td>' +
          '<td style="padding:8px;vertical-align:top;color:var(--text-dim,#aaa);">' + escapeHTML(e.audience || '') + '</td>' +
          '<td style="padding:8px;vertical-align:top;text-align:center;">' +
            '<label class="agx-switch" style="display:inline-flex;align-items:center;cursor:pointer;">' +
              '<input type="checkbox" data-email-event-toggle="' + escapeHTML(e.key) + '" ' + (e.enabled ? 'checked' : '') + ' style="cursor:pointer;width:18px;height:18px;" />' +
            '</label>' +
          '</td>' +
          '<td style="padding:8px;vertical-align:top;">' +
            '<input type="text" data-email-event-bcc="' + escapeHTML(e.key) + '" value="' + escapeHTML(bccVal).replace(/"/g, '&quot;') + '" placeholder="ops@example.com" ' +
              'style="width:100%;background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:5px 8px;font-size:12px;" />' +
          '</td>' +
          '<td style="padding:8px;vertical-align:top;text-align:center;">' +
            (e.wired ?
              '<span style="color:#34d399;font-size:11px;">&#x2713; Active</span>' :
              '<span style="color:#fbbf24;font-size:11px;" title="Trigger not yet wired in code; toggle is for forward-compat.">Pending</span>') +
          '</td>' +
          '<td style="padding:8px;vertical-align:top;text-align:center;">' +
            (function() {
              // Button label depends on event type — the click handler
              // routes user_invite to the Add User flow and password_reset
              // to the existing reset action; everything else falls back
              // to a sample-data preview send.
              if (e.key === 'user_invite') {
                return '<button class="ee-btn primary" data-email-event-send="' + escapeHTML(e.key) + '" data-email-event-label="' + escapeHTML(e.label).replace(/"/g, '&quot;') + '" style="font-size:11px;padding:4px 10px;" title="Open the Add User modal — creates a real user and fires the welcome email with their actual password.">&#x1F464; Invite user</button>';
              }
              if (e.key === 'password_reset') {
                return '<button class="ee-btn primary" data-email-event-send="' + escapeHTML(e.key) + '" data-email-event-label="' + escapeHTML(e.label).replace(/"/g, '&quot;') + '" style="font-size:11px;padding:4px 10px;" title="Pick an existing user and reset their password — the system emails the new password automatically.">&#x1F511; Reset password</button>';
              }
              return '<button class="ee-btn ghost" data-email-event-send="' + escapeHTML(e.key) + '" data-email-event-label="' + escapeHTML(e.label).replace(/"/g, '&quot;') + '" style="font-size:11px;padding:4px 10px;" title="No one-click real workflow for this event on this admin page — it normally fires from a real action elsewhere. Click to render the template with placeholder data and send a preview.">&#x1F4E4; Send sample</button>';
            })() +
          '</td>' +
        '</tr>';
      });
    });
    html += '</tbody></table>';
    box.innerHTML = html;
    // Wire toggle/bcc handlers — saves on change.
    box.querySelectorAll('[data-email-event-toggle]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var key = cb.dataset.emailEventToggle;
        if (!_emailSettings.events) _emailSettings.events = {};
        if (!_emailSettings.events[key]) _emailSettings.events[key] = { enabled: false, bcc: [] };
        _emailSettings.events[key].enabled = cb.checked;
        // Mirror into _emailEvents so a re-render keeps state.
        var evt = _emailEvents.find(function(x) { return x.key === key; });
        if (evt) evt.enabled = cb.checked;
        saveEmailSettings();
      });
    });
    box.querySelectorAll('[data-email-event-bcc]').forEach(function(inp) {
      inp.addEventListener('change', function() {
        var key = inp.dataset.emailEventBcc;
        var list = inp.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
        if (!_emailSettings.events) _emailSettings.events = {};
        if (!_emailSettings.events[key]) _emailSettings.events[key] = { enabled: false, bcc: [] };
        _emailSettings.events[key].bcc = list;
        var evt = _emailEvents.find(function(x) { return x.key === key; });
        if (evt) evt.bcc = list;
        saveEmailSettings();
      });
    });
    // Per-event Send buttons. The action depends on the event key —
    // some have a real workflow that should fire (creating a user,
    // resetting a password) and others only support a sample-preview
    // send because they don\'t correspond to a single re-runnable
    // action (e.g. cert_expiring fires per cert from a cron job).
    box.querySelectorAll('[data-email-event-send]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = btn.dataset.emailEventSend;
        var label = btn.dataset.emailEventLabel || key;
        if (key === 'user_invite') {
          fireInviteWithChoice();
          return;
        }
        if (key === 'password_reset') {
          fireRealPasswordReset();
          return;
        }
        // Fallback: render-with-sample-data preview send. as_test:false
        // strips the "[TEST]" subject prefix so the result looks like
        // a real send — useful for demoing template designs.
        var me = (window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser()) || null;
        var defaultTo = (me && me.email) || '';
        var to = window.prompt('Send sample "' + label + '" to:\n\n' +
          '(This event doesn\'t have a one-click real workflow on this admin page — it normally fires from a real action elsewhere in the app. ' +
          'The send below renders the template with placeholder data.)', defaultTo);
        if (!to) return;
        to = to.trim();
        if (!to) return;
        btn.disabled = true;
        var oldText = btn.innerHTML;
        btn.innerHTML = 'Sending…';
        window.agxApi.post('/api/email/templates/' + encodeURIComponent(key) + '/test', { to: to, as_test: false })
          .then(function(resp) {
            btn.innerHTML = oldText;
            btn.disabled = false;
            if (resp && resp.ok) {
              var msg = resp.dryRun ? '✓ Dry-run logged (no real send).' : '✓ Sample sent to ' + to + '.';
              alert(msg);
            } else {
              alert('Send failed: ' + ((resp && resp.error) || 'unknown'));
            }
          })
          .catch(function(err) {
            btn.innerHTML = oldText;
            btn.disabled = false;
            alert('Send failed: ' + (err.message || 'unknown'));
          });
      });
    });
  }

  // The Invite-user button opens a 2-way choice: brand-new user (the
  // existing Add User modal flow) OR existing user (re-send a working
  // credential by resetting their password). The existing-user path is
  // functionally a password reset — we can\'t recover the original
  // plaintext password to re-send, so the only way to give them a
  // working login is to set a new one. The email uses the password
  // reset template (accurate wording) rather than user_invite (which
  // says "just created an account").
  function fireInviteWithChoice() {
    chooseInviteRecipient().then(function(choice) {
      if (choice === 'new') {
        if (typeof window.openNewUserModal === 'function') {
          window.openNewUserModal();
        } else {
          alert('Add User modal not loaded. Switch to Admin → Users and click + New User.');
        }
      } else if (choice === 'existing') {
        // Same picker + reset path as the password_reset button, but
        // auto-generates the temp password so the admin gets a one-step
        // "resend a working login" action. The user receives the
        // password_reset template (which has accurate wording for an
        // already-existing account).
        fireExistingUserResend();
      }
      // null → user dismissed; no-op
    });
  }

  // AGX-styled two-card chooser. Returns a Promise resolving to
  // 'new' | 'existing' | null. Mirrors agxConfirm\'s overlay styling
  // (modal, blur backdrop, escape-to-cancel) but renders two large
  // action cards instead of an OK/Cancel pair, since both options are
  // affirmative actions and the user picks WHICH, not whether.
  function chooseInviteRecipient() {
    return new Promise(function(resolve) {
      var overlay = document.createElement('div');
      overlay.style.cssText = 'position:fixed;inset:0;background:rgba(0,0,0,0.65);z-index:10000;display:flex;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(2px);';

      var box = document.createElement('div');
      box.style.cssText = 'background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:12px;padding:22px 24px;max-width:560px;width:100%;box-sizing:border-box;box-shadow:0 16px 48px rgba(0,0,0,0.6);';
      // Common card style — flex column with align-items:stretch so
      // each child fills the card\'s cross axis (otherwise inline spans
      // size to content-width and the description text bleeds out of
      // the card on long lines). min-width:0 + box-sizing:border-box
      // keep the card honoring its grid track width.
      var cardBase = 'display:flex;flex-direction:column;align-items:stretch;gap:6px;text-align:left;border-radius:8px;padding:14px;color:var(--text,#fff);font-family:inherit;cursor:pointer;transition:background 0.12s, border-color 0.12s, transform 0.06s;width:100%;min-width:0;box-sizing:border-box;';
      // display:block forces the span to behave as a block-level
      // element so its width is the parent card width and the text
      // wraps inside instead of growing to max-content.
      var descStyle = 'display:block;font-size:11px;color:var(--text-dim,#aaa);font-weight:400;line-height:1.4;overflow-wrap:break-word;word-break:normal;';
      box.innerHTML =
        '<div style="font-size:16px;font-weight:700;color:var(--text,#fff);margin-bottom:4px;">Send invite to</div>' +
        '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:16px;">Pick whether this is a brand-new account or a reissue for someone already in the system.</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:14px;">' +
          // New user card
          '<button data-choose="new" type="button" ' +
            'style="' + cardBase + 'background:rgba(79,140,255,0.08);border:1px solid rgba(79,140,255,0.35);" ' +
            'onmouseenter="this.style.background=\'rgba(79,140,255,0.16)\';this.style.borderColor=\'rgba(79,140,255,0.6)\';" ' +
            'onmouseleave="this.style.background=\'rgba(79,140,255,0.08)\';this.style.borderColor=\'rgba(79,140,255,0.35)\';">' +
            '<span style="font-size:24px;line-height:1;">&#x1F464;</span>' +
            '<span style="font-size:14px;font-weight:600;">New user</span>' +
            '<span style="' + descStyle + '">Opens the Add User modal. Creates the account and emails the welcome with their password.</span>' +
          '</button>' +
          // Existing user card
          '<button data-choose="existing" type="button" ' +
            'style="' + cardBase + 'background:rgba(167,139,250,0.08);border:1px solid rgba(167,139,250,0.35);" ' +
            'onmouseenter="this.style.background=\'rgba(167,139,250,0.16)\';this.style.borderColor=\'rgba(167,139,250,0.6)\';" ' +
            'onmouseleave="this.style.background=\'rgba(167,139,250,0.08)\';this.style.borderColor=\'rgba(167,139,250,0.35)\';">' +
            '<span style="font-size:24px;line-height:1;">&#x1F511;</span>' +
            '<span style="font-size:14px;font-weight:600;">Existing user</span>' +
            '<span style="' + descStyle + '">Resets their password and emails them a working credential. Uses the password-reset template.</span>' +
          '</button>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;">' +
          '<button data-choose-cancel type="button" class="secondary small" style="padding:7px 14px;">Cancel</button>' +
        '</div>';

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      function cleanup(answer) {
        document.removeEventListener('keydown', onKey);
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
        resolve(answer);
      }
      function onKey(e) {
        if (e.key === 'Escape') cleanup(null);
      }
      box.querySelectorAll('[data-choose]').forEach(function(btn) {
        btn.onclick = function() { cleanup(btn.getAttribute('data-choose')); };
      });
      box.querySelector('[data-choose-cancel]').onclick = function() { cleanup(null); };
      overlay.addEventListener('click', function(e) {
        if (e.target === overlay) cleanup(null);
      });
      document.addEventListener('keydown', onKey);

      // Focus the New-user card so keyboard users land on a sensible
      // default; Tab moves to Existing, Esc cancels.
      setTimeout(function() {
        var btn = box.querySelector('[data-choose="new"]');
        if (btn) btn.focus();
      }, 0);
    });
  }

  // Generates a memorable but unguessable temp password — one short
  // alpha word + a 4-digit suffix (e.g. "agx-bird-7384"). Easier to
  // type than a random string for the user\'s first login; admin
  // tells them to change it after.
  function genTempPassword() {
    var words = ['bird', 'oak', 'pine', 'lark', 'wren', 'finch', 'sage', 'fern', 'dawn', 'mist'];
    var w = words[Math.floor(Math.random() * words.length)];
    var n = String(Math.floor(1000 + Math.random() * 9000));
    return 'agx-' + w + '-' + n;
  }

  function fireExistingUserResend() {
    var go = function() {
      if (!_users || !_users.length) {
        alert('User list not loaded yet — open Admin → Users once, then come back.');
        return;
      }
      var emailQuery = window.prompt('Resend login to which existing user? Enter their email (or part of it):');
      if (!emailQuery) return;
      var query = emailQuery.trim().toLowerCase();
      if (!query) return;
      var matches = _users.filter(function(u) {
        return (u.email || '').toLowerCase().indexOf(query) >= 0
            || (u.name || '').toLowerCase().indexOf(query) >= 0;
      });
      if (!matches.length) {
        alert('No user matched "' + emailQuery + '".');
        return;
      }
      var target;
      if (matches.length === 1) {
        target = matches[0];
      } else {
        var pickEmail = window.prompt('Multiple matches — pick by full email:\n' +
          matches.map(function(u) { return '  ' + u.email + ' (' + (u.name || '') + ')'; }).join('\n'));
        if (!pickEmail) return;
        target = matches.find(function(u) { return u.email && u.email.toLowerCase() === pickEmail.trim().toLowerCase(); });
        if (!target) {
          alert('No exact email match. Aborting.');
          return;
        }
      }
      var tempPwd = genTempPassword();
      var ok = window.confirm('Resend login to ' + target.email + '?\n\n' +
        'A new temporary password will be generated and emailed to them:\n  ' + tempPwd + '\n\n' +
        '(They\'ll be told to change it after first login.)\n\nProceed?');
      if (!ok) return;
      window.agxApi.users.resetPassword(target.id, tempPwd).then(function() {
        alert('✓ Sent to ' + target.email + '.\n\nTemp password: ' + tempPwd + '\n\nThe email contents use the password_reset template so the wording is accurate for an existing account.');
      }).catch(function(err) {
        alert('Send failed: ' + (err.message || 'unknown'));
      });
    };
    if (!_users || !_users.length) {
      window.agxApi.users.list().then(function(r) {
        _users = (r && r.users) || [];
        go();
      }).catch(function(err) {
        alert('Could not load users: ' + (err.message || 'unknown'));
      });
    } else {
      go();
    }
  }

  // Fires a real password reset against an existing user. Walks the
  // admin through: pick user (by email match) → set new password →
  // server hashes + saves + emails the user the new password (the
  // existing PUT /api/auth/users/:id/password flow). Uses the cached
  // _users list populated by renderAdminUsers — refreshes if empty.
  function fireRealPasswordReset() {
    var go = function() {
      if (!_users || !_users.length) {
        alert('User list not loaded yet — open Admin → Users once, then come back.');
        return;
      }
      var emailQuery = window.prompt('Reset whose password? Enter their email (or part of it):');
      if (!emailQuery) return;
      var query = emailQuery.trim().toLowerCase();
      if (!query) return;
      var matches = _users.filter(function(u) {
        return (u.email || '').toLowerCase().indexOf(query) >= 0
            || (u.name || '').toLowerCase().indexOf(query) >= 0;
      });
      if (!matches.length) {
        alert('No user matched "' + emailQuery + '".');
        return;
      }
      var target;
      if (matches.length === 1) {
        target = matches[0];
      } else {
        var pick = window.prompt('Multiple matches — pick by full email:\n' +
          matches.map(function(u) { return '  ' + u.email + ' (' + (u.name || '') + ')'; }).join('\n'));
        if (!pick) return;
        target = matches.find(function(u) { return u.email && u.email.toLowerCase() === pick.trim().toLowerCase(); });
        if (!target) {
          alert('No exact email match. Aborting.');
          return;
        }
      }
      var newPwd = window.prompt('New password for ' + target.email + ':\n\n' +
        '(They\'ll receive an email with this password and a note to change it after login.)');
      if (!newPwd) return;
      newPwd = newPwd.trim();
      if (newPwd.length < 4) {
        alert('Password must be at least 4 characters.');
        return;
      }
      window.agxApi.users.resetPassword(target.id, newPwd).then(function() {
        alert('✓ Reset and emailed to ' + target.email + '.\n\nNew password: ' + newPwd);
      }).catch(function(err) {
        alert('Reset failed: ' + (err.message || 'unknown'));
      });
    };
    // Ensure the user list is loaded.
    if (!_users || !_users.length) {
      window.agxApi.users.list().then(function(r) {
        _users = (r && r.users) || [];
        go();
      }).catch(function(err) {
        alert('Could not load users: ' + (err.message || 'unknown'));
      });
    } else {
      go();
    }
  }

  function renderEmailGlobals() {
    var box = document.getElementById('email-globals');
    if (!box) return;
    var s = _emailSettings || {};
    var qh = s.quietHours || { enabled: false, start: '21:00', end: '07:00' };
    box.innerHTML =
      // Global BCC.
      '<div style="display:flex;flex-direction:column;gap:4px;">' +
        '<label style="font-weight:600;color:var(--text);">Global BCC</label>' +
        '<div style="color:var(--text-dim,#888);font-size:11px;">Always BCC these addresses on every outbound email. Comma-separated.</div>' +
        '<input type="text" id="email-global-bcc" value="' + escapeHTML(s.globalBcc || '').replace(/"/g, '&quot;') + '" placeholder="ops@agxco.com, owner@agxco.com" ' +
          'style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:7px 10px;font-size:13px;" />' +
      '</div>' +
      // Digest mode (placeholder — pending implementation in E3).
      '<div style="display:flex;align-items:center;gap:10px;">' +
        '<input type="checkbox" id="email-digest-mode" ' + (s.digestMode ? 'checked' : '') + ' style="width:18px;height:18px;cursor:pointer;" />' +
        '<label for="email-digest-mode" style="cursor:pointer;">' +
          '<span style="font-weight:600;color:var(--text);">Digest mode</span> ' +
          '<span style="color:var(--text-dim,#888);font-size:11px;margin-left:6px;">Coalesce non-urgent notifications into a daily summary (pending wiring).</span>' +
        '</label>' +
      '</div>' +
      // Quiet hours.
      '<div style="display:flex;flex-direction:column;gap:6px;">' +
        '<div style="display:flex;align-items:center;gap:10px;">' +
          '<input type="checkbox" id="email-quiet-enabled" ' + (qh.enabled ? 'checked' : '') + ' style="width:18px;height:18px;cursor:pointer;" />' +
          '<label for="email-quiet-enabled" style="cursor:pointer;font-weight:600;color:var(--text);">Quiet hours</label>' +
          '<span style="color:var(--text-dim,#888);font-size:11px;">Hold non-urgent emails during this window (pending wiring).</span>' +
        '</div>' +
        '<div style="display:flex;align-items:center;gap:10px;padding-left:28px;">' +
          '<label style="color:var(--text-dim,#aaa);font-size:12px;">Start</label>' +
          '<input type="time" id="email-quiet-start" value="' + escapeHTML(qh.start || '21:00') + '" style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:5px 8px;font-size:12px;" />' +
          '<label style="color:var(--text-dim,#aaa);font-size:12px;">End</label>' +
          '<input type="time" id="email-quiet-end" value="' + escapeHTML(qh.end || '07:00') + '" style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:5px 8px;font-size:12px;" />' +
        '</div>' +
      '</div>' +
      '<div id="email-globals-status" style="font-size:12px;color:var(--text-dim,#888);"></div>';

    function syncAndSave() {
      _emailSettings.globalBcc = document.getElementById('email-global-bcc').value;
      _emailSettings.digestMode = document.getElementById('email-digest-mode').checked;
      _emailSettings.quietHours = {
        enabled: document.getElementById('email-quiet-enabled').checked,
        start: document.getElementById('email-quiet-start').value || '21:00',
        end: document.getElementById('email-quiet-end').value || '07:00'
      };
      saveEmailSettings();
    }
    ['email-global-bcc', 'email-digest-mode', 'email-quiet-enabled', 'email-quiet-start', 'email-quiet-end'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('change', syncAndSave);
    });
  }

  // Coalesce rapid changes into a single PUT so the user can flip
  // multiple toggles without hammering the API.
  var _emailSaveTimer = null;
  function saveEmailSettings() {
    var statusEl = document.getElementById('email-globals-status');
    if (statusEl) statusEl.textContent = 'Saving…';
    if (_emailSaveTimer) clearTimeout(_emailSaveTimer);
    _emailSaveTimer = setTimeout(function() {
      window.agxApi.put('/api/email/settings', _emailSettings).then(function(r) {
        if (statusEl) {
          statusEl.innerHTML = '<span style="color:#34d399;">&#x2713; Saved ' + new Date().toLocaleTimeString() + '</span>';
          setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 3000);
        }
      }).catch(function(err) {
        if (statusEl) statusEl.innerHTML = '<span style="color:#f87171;">Save failed: ' + escapeHTML(err.message || '') + '</span>';
      });
    }, 250);
  }

  function loadEmailLog() {
    var tbl = document.getElementById('email-log-tbl');
    if (!tbl) return;
    var statusFilter = (document.getElementById('email-log-status-filter') || {}).value || '';
    var url = '/api/email/log' + (statusFilter ? '?status=' + encodeURIComponent(statusFilter) : '');
    window.agxApi.get(url).then(function(r) {
      var rows = r.rows || [];
      if (!rows.length) {
        tbl.innerHTML = '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);">No emails sent yet.</div>';
        return;
      }
      var html = '<table class="dense-table" style="width:100%;border-collapse:collapse;font-size:12px;">' +
        '<thead style="border-bottom:1px solid var(--border,#333);">' +
          '<tr>' +
            '<th style="text-align:left;padding:6px 8px;">Sent</th>' +
            '<th style="text-align:left;padding:6px 8px;">To</th>' +
            '<th style="text-align:left;padding:6px 8px;">Subject</th>' +
            '<th style="text-align:left;padding:6px 8px;">Tag</th>' +
            '<th style="text-align:left;padding:6px 8px;">Status</th>' +
            '<th style="text-align:left;padding:6px 8px;">Note</th>' +
          '</tr>' +
        '</thead><tbody>';
      rows.forEach(function(row) {
        var statusColor = row.status === 'sent' ? '#34d399' :
                         (row.status === 'failed' ? '#f87171' :
                         (row.status === 'dry-run' ? '#fbbf24' : '#9ca3af'));
        html += '<tr style="border-bottom:1px solid var(--border,#2a2a3a);">' +
          '<td style="padding:6px 8px;font-family:monospace;color:var(--text-dim,#aaa);font-size:11px;">' + new Date(row.sent_at).toLocaleString() + '</td>' +
          '<td style="padding:6px 8px;">' + escapeHTML(row.to_address) + '</td>' +
          '<td style="padding:6px 8px;">' + escapeHTML(row.subject || '') + '</td>' +
          '<td style="padding:6px 8px;color:var(--text-dim,#888);">' + escapeHTML(row.tag || '') + '</td>' +
          '<td style="padding:6px 8px;color:' + statusColor + ';font-weight:600;">' + escapeHTML(row.status) + '</td>' +
          '<td style="padding:6px 8px;color:var(--text-dim,#888);font-size:11px;">' + escapeHTML(row.error || row.provider_id || '') + '</td>' +
        '</tr>';
      });
      html += '</tbody></table>';
      tbl.innerHTML = html;
    }).catch(function(err) {
      tbl.innerHTML = '<div style="padding:14px;color:#f87171;">Failed to load: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  // ==================== EMAIL TEMPLATES ====================
  // List view (left) + editor pane (right). Each event has a baked-in
  // default template; the editor saves a DB override that supersedes
  // the default at render time. {{path.to.var}} is HTML-escaped at
  // render — variables are listed in EVENTS[].variables.
  var _templatesList = [];          // [{ key, label, category, wired, hasOverride, updatedAt }]
  var _templateActiveKey = null;     // key of currently-edited template
  var _templateDetail = null;        // last-loaded detail blob

  function renderAdminEmailTemplates() {
    if (!isAdmin()) return;
    var pane = document.getElementById('admin-subtab-email-templates');
    if (!pane) return;
    pane.innerHTML =
      '<div style="display:flex;gap:16px;align-items:flex-start;min-height:600px;">' +
        // Left rail: list of templates.
        '<div class="card" style="flex:0 0 320px;padding:14px;align-self:stretch;">' +
          '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">' +
            '<h3 style="margin:0;">Templates</h3>' +
            '<button class="ee-btn secondary" id="email-templates-refresh" style="padding:4px 10px;font-size:11px;">&#x21BB;</button>' +
          '</div>' +
          '<div id="email-templates-list" style="font-size:13px;color:var(--text-dim,#888);">Loading…</div>' +
        '</div>' +
        // Right pane: editor (or empty state).
        '<div id="email-template-editor" class="card" style="flex:1;padding:18px;align-self:stretch;min-width:0;">' +
          '<div style="color:var(--text-dim,#888);text-align:center;padding:60px 20px;">' +
            '<div style="font-size:32px;margin-bottom:8px;">&#x1F4E7;</div>' +
            'Select a template on the left to edit.' +
          '</div>' +
        '</div>' +
      '</div>';

    document.getElementById('email-templates-refresh').addEventListener('click', loadTemplatesList);
    loadTemplatesList();
  }

  function loadTemplatesList() {
    var box = document.getElementById('email-templates-list');
    if (!box) return;
    window.agxApi.get('/api/email/templates').then(function(r) {
      _templatesList = r.templates || [];
      renderTemplatesList();
      // Auto-select previously active key, or the first wired template.
      if (_templateActiveKey && _templatesList.find(function(t) { return t.key === _templateActiveKey; })) {
        loadTemplateDetail(_templateActiveKey);
      } else {
        var first = _templatesList.find(function(t) { return t.wired; });
        if (first) loadTemplateDetail(first.key);
      }
    }).catch(function(err) {
      box.innerHTML = '<div style="padding:10px;color:#f87171;">Failed to load: ' + escapeHTML(err.message || '') + '</div>';
    });
  }

  function renderTemplatesList() {
    var box = document.getElementById('email-templates-list');
    if (!box) return;
    if (!_templatesList.length) {
      box.innerHTML = '<div style="padding:10px;color:var(--text-dim,#888);">No templates.</div>';
      return;
    }
    var byCat = {};
    _templatesList.forEach(function(t) {
      var c = t.category || 'Other';
      if (!byCat[c]) byCat[c] = [];
      byCat[c].push(t);
    });
    var html = '';
    Object.keys(byCat).sort().forEach(function(cat) {
      html += '<div style="margin-top:10px;color:var(--text-dim,#aaa);font-size:10px;text-transform:uppercase;letter-spacing:0.6px;padding:0 4px;">' + escapeHTML(cat) + '</div>';
      byCat[cat].forEach(function(t) {
        var active = t.key === _templateActiveKey;
        html += '<div data-template-key="' + escapeHTML(t.key) + '" class="email-tpl-row" ' +
          'style="display:flex;align-items:center;justify-content:space-between;padding:8px 10px;border-radius:6px;cursor:pointer;margin-top:2px;' +
          (active ? 'background:rgba(79,140,255,0.18);border:1px solid rgba(79,140,255,0.4);' : 'border:1px solid transparent;') +
          '">' +
            '<div style="min-width:0;flex:1;">' +
              '<div style="color:var(--text);font-size:13px;' + (active ? 'font-weight:600;' : '') + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + escapeHTML(t.label) + '</div>' +
              '<div style="color:var(--text-dim,#888);font-size:10px;margin-top:1px;">' +
                (t.hasOverride && t.updatedAt
                  ? '<span style="color:#34d399;">Saved ' + escapeHTML(new Date(t.updatedAt).toLocaleDateString()) + '</span>'
                  : '<span>Factory default</span>') +
                (t.wired ? '' : ' &middot; <span style="color:#fbbf24;">trigger pending</span>') +
              '</div>' +
            '</div>' +
          '</div>';
      });
    });
    box.innerHTML = html;
    box.querySelectorAll('[data-template-key]').forEach(function(row) {
      row.addEventListener('click', function() {
        loadTemplateDetail(row.dataset.templateKey);
      });
    });
  }

  function loadTemplateDetail(eventKey) {
    _templateActiveKey = eventKey;
    renderTemplatesList(); // re-highlight active row
    var ed = document.getElementById('email-template-editor');
    if (!ed) return;
    ed.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">Loading template…</div>';
    window.agxApi.get('/api/email/templates/' + encodeURIComponent(eventKey)).then(function(r) {
      _templateDetail = r;
      renderTemplateEditor();
    }).catch(function(err) {
      ed.innerHTML = '<div style="padding:30px;color:#f87171;">Failed to load: ' + escapeHTML(err.message || '') + '</div>';
    });
  }

  function renderTemplateEditor() {
    var ed = document.getElementById('email-template-editor');
    if (!ed || !_templateDetail) return;
    var d = _templateDetail;
    var ev = d.event || {};
    var override = d.override || null;
    var preview = d.preview || { subject: '', html: '', text: '' };
    var defaultSource = d.defaultSource || null;
    // Editor shows the SOURCE — either the admin's saved override (with
    // their {{var}} placeholders) or the baked-in default source. The
    // preview pane below renders sample data through whichever is
    // currently loaded so the admin can see the result.
    var subjectVal = override
      ? (override.subject || '')
      : (defaultSource && defaultSource.subject) || '';
    var bodyVal = override
      ? (override.html_body || '')
      : (defaultSource && defaultSource.html_body) || '';
    var vars = ev.variables || [];
    var sample = d.sampleParams || {};

    var lastSavedLabel;
    if (override && override.updated_at) {
      var dt = new Date(override.updated_at);
      lastSavedLabel = '<span style="color:#34d399;">Last saved ' + escapeHTML(dt.toLocaleString()) + '</span>';
    } else {
      lastSavedLabel = '<span style="color:var(--text-dim,#888);">Not yet customized — editing factory default</span>';
    }
    ed.innerHTML =
      '<div style="display:flex;align-items:flex-start;justify-content:space-between;gap:14px;margin-bottom:12px;flex-wrap:wrap;">' +
        '<div style="min-width:0;flex:1;">' +
          '<h3 style="margin:0 0 4px 0;">' + escapeHTML(ev.label || ev.key || '') + '</h3>' +
          '<div style="color:var(--text-dim,#888);font-size:12px;">' + escapeHTML(ev.description || '') + '</div>' +
          '<div style="color:var(--text-dim,#aaa);font-size:11px;margin-top:6px;">' +
            '<strong>Audience:</strong> ' + escapeHTML(ev.audience || '—') + ' &middot; ' +
            '<strong>Trigger:</strong> ' + (ev.wired ? '<span style="color:#34d399;">Active</span>' : '<span style="color:#fbbf24;">Pending</span>') + ' &middot; ' +
            lastSavedLabel +
          '</div>' +
        '</div>' +
      '</div>' +
      // Variables hint chips.
      '<div style="margin-bottom:10px;">' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Available variables (click to insert):</div>' +
        '<div id="email-tpl-vars" style="display:flex;flex-wrap:wrap;gap:5px;">' +
          vars.map(function(v) {
            return '<button type="button" data-tpl-var="' + escapeHTML(v) + '" class="ee-btn secondary" ' +
              'style="padding:3px 8px;font-size:11px;font-family:monospace;">{{' + escapeHTML(v) + '}}</button>';
          }).join('') +
        '</div>' +
      '</div>' +
      // Subject + body editors.
      '<div style="display:flex;flex-direction:column;gap:10px;">' +
        '<label style="font-size:12px;color:var(--text-dim,#aaa);">Subject</label>' +
        '<input type="text" id="email-tpl-subject" value="' + escapeHTML(subjectVal).replace(/"/g, '&quot;') + '" ' +
          'style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;font-size:13px;" />' +
        '<label style="font-size:12px;color:var(--text-dim,#aaa);">HTML body</label>' +
        '<textarea id="email-tpl-body" spellcheck="false" ' +
          'style="background:var(--input-bg,#0f0f1e);color:var(--text);border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;font-size:12px;font-family:Menlo,Consolas,monospace;min-height:240px;resize:vertical;">' +
          escapeHTML(bodyVal) +
        '</textarea>' +
      '</div>' +
      // Action buttons.
      '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:12px;align-items:center;">' +
        '<button class="ee-btn primary" id="email-tpl-save">&#x1F4BE; Save template</button>' +
        '<button class="ee-btn secondary" id="email-tpl-preview">&#x1F441; Refresh preview</button>' +
        '<button class="ee-btn secondary" id="email-tpl-test">&#x1F4E7; Send test</button>' +
        (override ?
          '<button class="ee-btn danger" id="email-tpl-reset" style="margin-left:auto;" title="Discard your saved template and re-load the factory default into the editor.">&#x21BA; Reset to factory default</button>' :
          '') +
      '</div>' +
      '<div id="email-tpl-status" style="margin-top:8px;font-size:12px;min-height:16px;"></div>' +
      // Live preview pane — re-renders as the admin types the source.
      '<div style="margin-top:14px;border:1px solid var(--border,#2a2a3a);border-radius:8px;overflow:hidden;">' +
        '<div style="background:rgba(255,255,255,0.04);padding:8px 12px;border-bottom:1px solid var(--border,#2a2a3a);font-size:11px;color:var(--text-dim,#aaa);display:flex;justify-content:space-between;align-items:center;gap:8px;">' +
          '<span><strong>Live preview</strong> &middot; updates as you type, rendered with sample data</span>' +
          '<span style="font-family:monospace;font-size:10px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">sampleParams: ' + escapeHTML(JSON.stringify(sample).slice(0, 120)) + (JSON.stringify(sample).length > 120 ? '…' : '') + '</span>' +
        '</div>' +
        '<div style="padding:10px 14px;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#2a2a3a);font-size:12px;">' +
          '<strong>Subject:</strong> <span id="email-tpl-preview-subject">' + escapeHTML(preview.subject || '') + '</span>' +
        '</div>' +
        '<iframe id="email-tpl-preview-frame" style="width:100%;height:420px;border:0;background:#fff;"></iframe>' +
      '</div>';

    // Variable insertion buttons.
    ed.querySelectorAll('[data-tpl-var]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        insertAtCursor(document.getElementById('email-tpl-body'), '{{' + btn.dataset.tplVar + '}}');
      });
    });
    document.getElementById('email-tpl-save').addEventListener('click', saveTemplate);
    document.getElementById('email-tpl-preview').addEventListener('click', refreshTemplatePreview);
    document.getElementById('email-tpl-test').addEventListener('click', sendTemplateTest);
    var resetBtn = document.getElementById('email-tpl-reset');
    if (resetBtn) resetBtn.addEventListener('click', resetTemplate);
    // Live preview as the admin types — debounced so we don't re-render
    // the iframe on every keystroke. Uses the enriched sample params
    // shipped by the detail endpoint, so client-side interpolation
    // produces the same output as a server-side render.
    var subjectInput = document.getElementById('email-tpl-subject');
    var bodyInput = document.getElementById('email-tpl-body');
    if (subjectInput) subjectInput.addEventListener('input', scheduleLivePreview);
    if (bodyInput) bodyInput.addEventListener('input', scheduleLivePreview);
    // Render the current preview into the iframe (initial render, server-side).
    setIframeContent('email-tpl-preview-frame', preview.html || '');
  }

  function insertAtCursor(textarea, text) {
    if (!textarea) return;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var v = textarea.value;
    textarea.value = v.slice(0, start) + text + v.slice(end);
    textarea.focus();
    textarea.selectionStart = textarea.selectionEnd = start + text.length;
  }

  function setIframeContent(id, html) {
    var f = document.getElementById(id);
    if (!f) return;
    var doc = f.contentDocument || (f.contentWindow && f.contentWindow.document);
    if (!doc) return;
    doc.open();
    doc.write(html || '<div style="font-family:Arial;color:#888;padding:20px;">(empty)</div>');
    doc.close();
  }

  function saveTemplate() {
    if (!_templateActiveKey) return;
    var subject = document.getElementById('email-tpl-subject').value;
    var html_body = document.getElementById('email-tpl-body').value;
    var status = document.getElementById('email-tpl-status');
    if (status) status.innerHTML = '<span style="color:#60a5fa;">Saving…</span>';
    window.agxApi.put('/api/email/templates/' + encodeURIComponent(_templateActiveKey), {
      subject: subject, html_body: html_body
    }).then(function() {
      if (status) status.innerHTML = '<span style="color:#34d399;">&#x2713; Saved.</span>';
      // Reload to reflect hasOverride + refreshed preview.
      loadTemplatesList();
      loadTemplateDetail(_templateActiveKey);
    }).catch(function(err) {
      if (status) status.innerHTML = '<span style="color:#f87171;">Save failed: ' + escapeHTML(err.message || '') + '</span>';
    });
  }

  function refreshTemplatePreview() {
    // Save first (so the preview reflects what's in the editor) then
    // reload detail.
    saveTemplate();
  }

  // ── Live preview (client-side render) ──────────────────────────
  // Mirrors the server's interpolate(): {{path}} HTML-escapes, {{{path}}}
  // is raw. Resolves dotted paths against the enriched sample params
  // shipped from the detail endpoint.
  function tplResolvePath(path, obj) {
    return path.split('.').reduce(function(o, k) {
      return (o && o[k] != null) ? o[k] : null;
    }, obj);
  }
  function tplEscapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function tplInterpolate(str, params) {
    if (typeof str !== 'string') return '';
    return str
      .replace(/\{\{\{\s*([^}]+?)\s*\}\}\}/g, function(_, p) {
        var v = tplResolvePath(p, params);
        return v == null ? '' : String(v);
      })
      .replace(/\{\{\s*([^}]+?)\s*\}\}/g, function(_, p) {
        var v = tplResolvePath(p, params);
        return v == null ? '' : tplEscapeHtml(String(v));
      });
  }

  var _livePreviewTimer = null;
  function scheduleLivePreview() {
    if (_livePreviewTimer) clearTimeout(_livePreviewTimer);
    _livePreviewTimer = setTimeout(runLivePreview, 200);
  }
  function runLivePreview() {
    if (!_templateDetail) return;
    var params = _templateDetail.enrichedSampleParams || _templateDetail.sampleParams || {};
    var subjectEl = document.getElementById('email-tpl-subject');
    var bodyEl = document.getElementById('email-tpl-body');
    var subjPreview = document.getElementById('email-tpl-preview-subject');
    if (subjPreview && subjectEl) subjPreview.textContent = tplInterpolate(subjectEl.value || '', params);
    if (bodyEl) setIframeContent('email-tpl-preview-frame', tplInterpolate(bodyEl.value || '', params));
  }

  // Drop the baked-in template SOURCE (with {{var}} placeholders) into
  // the editor so the admin can tweak the entire template — header,
  // footer, signature, links, everything — without losing the variable
  // bindings. Doesn't save until they click Save override.
  function loadDefaultIntoEditor() {
    if (!_templateDetail) return;
    var src = _templateDetail.defaultSource;
    if (!src) {
      var statusEl0 = document.getElementById('email-tpl-status');
      if (statusEl0) statusEl0.innerHTML = '<span style="color:#fbbf24;">No default source available for this template.</span>';
      return;
    }
    if (!confirm('Load the default template source into the editor?\n\nThis replaces whatever is in the Subject + HTML body fields with the baked-in source (including {{variable}} placeholders). Nothing is saved until you click Save override.')) return;
    var subjectEl = document.getElementById('email-tpl-subject');
    var bodyEl = document.getElementById('email-tpl-body');
    if (subjectEl) subjectEl.value = src.subject || '';
    if (bodyEl) bodyEl.value = src.html_body || '';
    var statusEl = document.getElementById('email-tpl-status');
    if (statusEl) statusEl.innerHTML = '<span style="color:#34d399;">&#x2713; Default loaded — edit freely, then click Save.</span>';
  }

  function sendTemplateTest() {
    if (!_templateActiveKey) return;
    var me = (window.agxAuth && window.agxAuth.getUser && window.agxAuth.getUser()) || null;
    var defaultTo = me && me.email ? me.email : '';
    var to = prompt('Send test of "' + (_templateDetail && _templateDetail.event && _templateDetail.event.label || _templateActiveKey) + '" to:', defaultTo);
    if (!to) return;
    var status = document.getElementById('email-tpl-status');
    if (status) status.innerHTML = '<span style="color:#60a5fa;">Sending test to ' + escapeHTML(to) + '…</span>';
    window.agxApi.post('/api/email/templates/' + encodeURIComponent(_templateActiveKey) + '/test', { to: to }).then(function(r) {
      if (status) {
        if (r.ok) {
          status.innerHTML = '<span style="color:#34d399;">&#x2713; Sent</span>' +
            (r.dryRun ? ' &middot; <strong>DRY RUN</strong>' : '') +
            (r.providerId ? ' &middot; <code>' + escapeHTML(r.providerId) + '</code>' : '');
        } else {
          status.innerHTML = '<span style="color:#f87171;">Failed: ' + escapeHTML(r.error || 'unknown error') + '</span>';
        }
      }
    }).catch(function(err) {
      if (status) status.innerHTML = '<span style="color:#f87171;">Request failed: ' + escapeHTML(err.message || '') + '</span>';
    });
  }

  function resetTemplate() {
    if (!_templateActiveKey) return;
    if (!confirm('Revert this template to the baked-in default? Your override will be discarded.')) return;
    var status = document.getElementById('email-tpl-status');
    if (status) status.innerHTML = '<span style="color:#60a5fa;">Reverting…</span>';
    window.agxApi.del('/api/email/templates/' + encodeURIComponent(_templateActiveKey)).then(function() {
      if (status) status.innerHTML = '<span style="color:#34d399;">&#x2713; Reverted to default.</span>';
      loadTemplatesList();
      loadTemplateDetail(_templateActiveKey);
    }).catch(function(err) {
      if (status) status.innerHTML = '<span style="color:#f87171;">Revert failed: ' + escapeHTML(err.message || '') + '</span>';
    });
  }

  // ==================== PROPOSAL TEMPLATES + BT MAPPING ====================
  // Two editable records keyed in app_settings:
  //   - 'proposal_template' (header / intro / about / exclusions / signature)
  //   - 'bt_export_mapping' (btCategory -> BT Parent Group/Subgroup/Cost Type
  //     and the Service & Repair Income line config)
  // Loaded together so a single Save commits both side by side.
  var _templateDraft = null;
  var _btMappingDraft = null;

  var _skillsDraft = { skills: [] };

  function renderAdminTemplates() {
    if (!isAdmin()) return;
    var pane = document.getElementById('admin-subtab-templates');
    if (!pane) return;
    pane.innerHTML = '<div style="padding:15px;color:var(--text-dim,#888);">Loading…</div>';
    Promise.all([
      window.agxApi.settings.get('proposal_template').catch(function() { return null; }),
      window.agxApi.settings.get('bt_export_mapping').catch(function() { return null; })
      // agent_skills loads independently from Admin → Agents → Skills now.
    ]).then(function(results) {
      _templateDraft = (results[0] && results[0].setting && results[0].setting.value) || {};
      _btMappingDraft = (results[1] && results[1].setting && results[1].setting.value) || { categories: {}, fallback: {}, income: {} };
      // Make sure all four built-in categories exist in the draft so the
      // form renders all rows even if a saved mapping was missing one.
      ['materials', 'labor', 'gc', 'sub'].forEach(function(k) {
        if (!_btMappingDraft.categories) _btMappingDraft.categories = {};
        if (!_btMappingDraft.categories[k]) _btMappingDraft.categories[k] = { parentGroup: '', parentDesc: '', subgroup: '', subgroupDesc: '', costCode: '', costType: '' };
      });
      if (!_btMappingDraft.fallback) _btMappingDraft.fallback = { parentGroup: '', parentDesc: '', subgroup: '', subgroupDesc: '', costCode: '', costType: '' };
      if (!_btMappingDraft.income) _btMappingDraft.income = { title: '', parentGroup: '', parentDesc: '', subgroup: '', subgroupDesc: '', costCode: '', costType: '' };
      renderTemplatesForm();
    }).catch(function(err) {
      pane.innerHTML = '<div style="padding:15px;color:#f87171;">Failed to load template: ' + escapeHTML(err.message || '') + '</div>';
    });
  }

  // Active sub-tab inside Admin -> Templates. Persisted in sessionStorage
  // so refreshes / cross-tab navigation don't bounce the admin back to
  // the first tab. Default 'proposal' since that's the most-edited
  // section.
  var _templatesActiveTab = (function() {
    try {
      var saved = sessionStorage.getItem('agx_templates_tab') || 'proposal';
      // 'skills' migrated out to Admin → Agents — fall back to proposal
      // for any session-cached state still pointing at the old tab.
      if (saved === 'skills') saved = 'proposal';
      return saved;
    } catch (e) { return 'proposal'; }
  })();

  // Skills moved to its own home on Admin → Agents → Skills (the AI
  // agents page owns skill packs now). Email Templates moved IN here
  // since they share the "edit a template the system uses" mental
  // model with Proposal + BT Export.
  var TEMPLATES_TABS = [
    { key: 'proposal', label: '📄 Proposal',  desc: 'Header, letter body, exclusions, signature.' },
    { key: 'bt',       label: '📊 BT Export', desc: 'Buildertrend cost-category mapping.' },
    { key: 'email',    label: '📧 Email',     desc: 'Per-event email subject + HTML body templates.' }
  ];

  function switchTemplatesTab(key) {
    if (!TEMPLATES_TABS.some(function(t) { return t.key === key; })) return;
    // Sync inputs from the currently-active tab into the in-memory draft
    // before swapping content, so the user's unsaved edits survive the
    // tab change.
    syncTopLevelDraftFromInputs();
    syncBTMappingFromInputs();
    syncSkillsFromInputs();
    _templatesActiveTab = key;
    try { sessionStorage.setItem('agx_templates_tab', key); } catch (e) { /* ignore */ }
    renderTemplatesForm();
  }
  window.switchTemplatesTab = switchTemplatesTab;

  function renderProposalTemplateHTML() {
    var t = _templateDraft || {};
    var exclusions = Array.isArray(t.exclusions) ? t.exclusions : [];
    var exclusionsHTML = exclusions.map(function(item, idx) {
      return '<div class="excl-row" style="display:flex;gap:8px;align-items:flex-start;margin-bottom:8px;">' +
        '<span style="flex:0 0 28px;text-align:right;color:var(--text-dim,#888);font-size:12px;padding-top:8px;font-family:\'SF Mono\',monospace;">' + (idx + 1) + '.</span>' +
        '<textarea data-excl-idx="' + idx + '" rows="3" style="flex:1;resize:vertical;font-size:12px;">' + escapeHTML(item) + '</textarea>' +
        '<div style="display:flex;flex-direction:column;gap:4px;">' +
          '<button class="ghost small" onclick="moveExclusion(' + idx + ', -1)" ' + (idx === 0 ? 'disabled' : '') + ' title="Move up">&#x25B2;</button>' +
          '<button class="ghost small" onclick="moveExclusion(' + idx + ', 1)" ' + (idx === exclusions.length - 1 ? 'disabled' : '') + ' title="Move down">&#x25BC;</button>' +
          '<button class="ghost small" onclick="deleteExclusion(' + idx + ')" title="Remove" style="color:#f87171;">&#x1F5D1;</button>' +
        '</div>' +
      '</div>';
    }).join('');
    return (
      '<p style="margin:0 0 16px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'These fields are shared across every proposal preview / PDF export. Use the placeholders ' +
        '<code>{salutation}</code> <code>{issue}</code> <code>{community}</code> <code>{date}</code> <code>{total}</code> ' +
        'in the Intro Template — they get filled in from the active estimate at preview time.' +
      '</p>' +
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Header</legend>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;">Company Header Line</label>' +
          '<input id="tpl-company_header" type="text" value="' + escapeHTML(t.company_header || '') + '" style="width:100%;" placeholder="Address &middot; City &middot; Phone" />' +
        '</div>' +
      '</fieldset>' +
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Letter Body</legend>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;">Intro Template</label>' +
          '<textarea id="tpl-intro_template" rows="3" style="width:100%;resize:vertical;">' + escapeHTML(t.intro_template || '') + '</textarea>' +
        '</div>' +
        '<div>' +
          '<label style="display:block;">About Paragraph</label>' +
          '<textarea id="tpl-about_paragraph" rows="6" style="width:100%;resize:vertical;">' + escapeHTML(t.about_paragraph || '') + '</textarea>' +
        '</div>' +
      '</fieldset>' +
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Assumptions, Clarifications and Exclusions</legend>' +
        '<div id="tpl-exclusions-list">' + exclusionsHTML + '</div>' +
        '<button class="secondary small" onclick="addExclusion()" style="margin-top:6px;">&#x2795; Add Exclusion</button>' +
      '</fieldset>' +
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Signature</legend>' +
        '<div>' +
          '<label style="display:block;">Signature Lead-In</label>' +
          '<textarea id="tpl-signature_text" rows="2" style="width:100%;resize:vertical;">' + escapeHTML(t.signature_text || '') + '</textarea>' +
        '</div>' +
      '</fieldset>'
    );
  }

  function renderTemplatesForm() {
    var pane = document.getElementById('admin-subtab-templates');
    if (!pane) return;
    if (!TEMPLATES_TABS.some(function(t) { return t.key === _templatesActiveTab; })) {
      _templatesActiveTab = 'proposal';
    }
    var activeTab = TEMPLATES_TABS.find(function(t) { return t.key === _templatesActiveTab; });

    // Tab strip — pill-style buttons matching the rest of the app, with
    // the active tab highlighted in accent blue.
    var tabsHTML = '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:14px;border-bottom:1px solid var(--border,#333);padding-bottom:10px;">';
    TEMPLATES_TABS.forEach(function(tab) {
      var isActive = (tab.key === _templatesActiveTab);
      var bg = isActive ? 'rgba(79,140,255,0.18)' : 'transparent';
      var border = isActive ? '#4f8cff' : 'var(--border,#333)';
      var color = isActive ? '#fff' : 'var(--text-dim,#888)';
      tabsHTML += '<button onclick="switchTemplatesTab(\'' + tab.key + '\')" ' +
        'style="padding:6px 14px;border:1px solid ' + border + ';border-radius:18px;background:' + bg + ';color:' + color + ';font-size:12px;font-weight:600;cursor:pointer;">' +
        tab.label +
      '</button>';
    });
    tabsHTML += '</div>';

    var contentHTML = '';
    if (_templatesActiveTab === 'proposal') {
      contentHTML = renderProposalTemplateHTML();
    } else if (_templatesActiveTab === 'bt') {
      contentHTML = renderBTMappingHTML();
    } else if (_templatesActiveTab === 'email') {
      // Placeholder — renderAdminEmailTemplates writes into
      // #admin-subtab-email-templates after innerHTML is assigned below.
      contentHTML = '<div id="admin-subtab-email-templates"></div>';
    }

    var tabHint = activeTab && activeTab.desc
      ? '<p style="margin:0 0 12px 0;color:var(--text-dim,#888);font-size:12px;">' + activeTab.desc + '</p>'
      : '';

    // Save All footer applies to proposal + bt — email templates have
    // their own per-template save flow inside renderAdminEmailTemplates,
    // so hide the global footer when the email tab is active.
    var showSaveAllFooter = (_templatesActiveTab !== 'email');
    pane.innerHTML =
      tabsHTML +
      tabHint +
      '<div id="tpl-tab-content">' + contentHTML + '</div>' +
      (showSaveAllFooter
        ? '<div class="action-buttons" style="margin-top:14px;border-top:1px solid var(--border,#333);padding-top:14px;">' +
            '<button class="primary" onclick="saveAdminTemplate()">&#x1F4BE; Save All</button>' +
            '<button class="secondary" onclick="renderAdminTemplates()">Discard Changes</button>' +
            '<span id="tpl-status" style="margin-left:14px;color:var(--text-dim,#888);font-size:12px;align-self:center;"></span>' +
          '</div>'
        : '');

    // Email tab body is rendered into the placeholder div by the
    // existing renderAdminEmailTemplates function (it targets
    // #admin-subtab-email-templates). Just call it after innerHTML
    // is set so the element exists.
    if (_templatesActiveTab === 'email') {
      renderAdminEmailTemplates();
    }

    // Wire textarea blur to sync edits into the in-memory draft so reordering
    // (which re-renders the list) doesn't clobber unsaved text.
    // Only relevant on the proposal tab — querySelectorAll on missing
    // elements is a safe no-op on the other tabs.
    pane.querySelectorAll('[data-excl-idx]').forEach(function(ta) {
      ta.addEventListener('input', function() {
        var idx = parseInt(ta.getAttribute('data-excl-idx'), 10);
        if (Array.isArray(_templateDraft.exclusions)) {
          _templateDraft.exclusions[idx] = ta.value;
        }
      });
    });
  }

  function syncTopLevelDraftFromInputs() {
    if (!_templateDraft) _templateDraft = {};
    ['company_header', 'intro_template', 'about_paragraph', 'signature_text'].forEach(function(k) {
      var el = document.getElementById('tpl-' + k);
      if (el) _templateDraft[k] = el.value;
    });
    syncBTMappingFromInputs();
  }

  // ==================== BT MAPPING (sub-section of Templates tab) ====================
  // Renders the editable form for the bt_export_mapping setting. Each
  // built-in btCategory (materials/labor/gc/sub) gets a row; the fallback
  // bucket (no-category lines) and the Service & Repair Income line each
  // get their own block.
  var BT_CATEGORY_LABELS = {
    materials: 'Materials & Supplies',
    labor:     'Direct Labor',
    gc:        'General Conditions',
    sub:       'Subcontractors'
  };
  var BT_FIELD_KEYS = ['parentGroup', 'parentDesc', 'subgroup', 'subgroupDesc', 'costCode', 'costType'];
  var BT_FIELD_LABELS = {
    parentGroup:  'Parent Group',
    parentDesc:   'Parent Group Desc',
    subgroup:     'Subgroup',
    subgroupDesc: 'Subgroup Desc',
    costCode:     'Cost Code',
    costType:     'Cost Type'
  };

  function renderBTMappingHTML() {
    var bt = _btMappingDraft || {};
    var cats = bt.categories || {};
    var html = '';
    html += '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">';
    html += '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Buildertrend Export Mapping</legend>';
    html += '<p style="margin:0 0 10px 0;color:var(--text-dim,#888);font-size:12px;">' +
      'Drives the <strong>Export to Buildertrend</strong> xlsx. Each built-in cost category maps to a BT Parent Group / Subgroup / Cost Type. ' +
      '<strong>Cost Type</strong> must match BT\'s vocabulary (Material, Labor, Subcontractor, Other, Equipment).' +
      '</p>';

    // Per-category rows
    Object.keys(BT_CATEGORY_LABELS).forEach(function(key) {
      var c = cats[key] || {};
      html += '<div style="border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:10px;">';
      html += '<div style="font-size:12px;font-weight:700;color:#4f8cff;margin-bottom:8px;">' + escapeHTML(BT_CATEGORY_LABELS[key]) + ' <span style="color:var(--text-dim,#888);font-weight:400;font-size:11px;">(btCategory: ' + key + ')</span></div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">';
      BT_FIELD_KEYS.forEach(function(fk) {
        html += '<div><label style="display:block;font-size:11px;">' + BT_FIELD_LABELS[fk] + '</label>' +
          '<input type="text" data-bt-cat="' + key + '" data-bt-field="' + fk + '" value="' + escapeHTML(c[fk] || '') + '" style="width:100%;" /></div>';
      });
      html += '</div></div>';
    });

    // Fallback bucket
    var fb = bt.fallback || {};
    html += '<div style="border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:10px;">';
    html += '<div style="font-size:12px;font-weight:700;color:#fbbf24;margin-bottom:8px;">Fallback (lines with no tagged section)</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">';
    BT_FIELD_KEYS.forEach(function(fk) {
      html += '<div><label style="display:block;font-size:11px;">' + BT_FIELD_LABELS[fk] + '</label>' +
        '<input type="text" data-bt-fb-field="' + fk + '" value="' + escapeHTML(fb[fk] || '') + '" style="width:100%;" /></div>';
    });
    html += '</div></div>';

    // Income line
    var inc = bt.income || {};
    html += '<div style="border:1px solid #34d399;border-radius:6px;padding:10px 12px;background:rgba(52,211,153,0.05);">';
    html += '<div style="font-size:12px;font-weight:700;color:#34d399;margin-bottom:8px;">&#x1F4B0; Service &amp; Repair Income (auto-injected first row)</div>';
    html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">';
    html += '<div style="grid-column:1 / -1;"><label style="display:block;font-size:11px;">Title</label>' +
      '<input type="text" data-bt-inc-field="title" value="' + escapeHTML(inc.title || '') + '" style="width:100%;" /></div>';
    BT_FIELD_KEYS.forEach(function(fk) {
      html += '<div><label style="display:block;font-size:11px;">' + BT_FIELD_LABELS[fk] + '</label>' +
        '<input type="text" data-bt-inc-field="' + fk + '" value="' + escapeHTML(inc[fk] || '') + '" style="width:100%;" /></div>';
    });
    html += '</div></div>';

    html += '</fieldset>';
    return html;
  }

  // ==================== AGENT SKILLS (sub-section of Templates tab) ====================
  // Admin-editable prompt extensions loaded into the in-app AI agents
  // (AG = estimating, CRA = customer relations) at chat time. Each skill
  // has a name, free-form body, agents it applies to, and an alwaysOn
  // flag. v1 only honors alwaysOn = true — when on, the skill is appended
  // to that agent's system prompt on every turn.
  // Note: agentKey 'cra' kept for backward compat with skill packs that
  // already reference it. Display label is HR; the underlying agent
  // assignment value stays 'cra'. Elle's key is 'job' (matches her
  // entity_type) — assignments target the job-side WIP analyst.
  var AGENT_LABELS = {
    ag:  '📐 AG (Estimator)',
    job: '📊 Elle (WIP Analyst)',
    cra: '🤝 HR (Customer Relations)'
  };

  function renderAgentSkillsHTML() {
    if (!_skillsDraft || !Array.isArray(_skillsDraft.skills)) _skillsDraft = { skills: [] };
    var html = '';
    html += '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">';
    html += '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Agent Skill Packs</legend>';
    html += '<p style="margin:0 0 10px 0;color:var(--text-dim,#888);font-size:12px;">' +
      'Reusable instruction blocks loaded into the in-app AI agents at chat time. Use these to teach AGX-specific workflows, pricing rules, slotting preferences, and common-scope playbooks. ' +
      '<strong>Always-on</strong> skills get appended to the agent\'s system prompt on every turn (token cost: a few hundred each).' +
      '</p>';

    if (!_skillsDraft.skills.length) {
      html += '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);border:1px dashed var(--border,#333);border-radius:6px;font-size:12px;">' +
        'No skill packs yet. Click <strong>+ Add Skill</strong> below to create one.' +
      '</div>';
    } else {
      _skillsDraft.skills.forEach(function(skill, idx) {
        var agents = Array.isArray(skill.agents) ? skill.agents : [];
        html += '<div data-skill-idx="' + idx + '" style="border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:10px;">';
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<input type="text" data-skill-name="' + idx + '" value="' + escapeHTML(skill.name || '') + '" placeholder="Skill name (e.g., AGX Estimating Playbook)" style="flex:1;font-weight:600;" />' +
          '<label style="display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--text-dim,#aaa);text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;cursor:pointer;">' +
            '<input type="checkbox" data-skill-alwayson="' + idx + '" ' + (skill.alwaysOn === false ? '' : 'checked') + ' style="margin:0;" /> always on' +
          '</label>' +
          '<button class="ee-btn ee-icon-btn danger" onclick="deleteSkill(' + idx + ')" title="Remove skill">&#x1F5D1;</button>' +
        '</div>';
        // Agent checkboxes — which agents load this skill
        html += '<div style="display:flex;gap:14px;margin-bottom:8px;font-size:11px;color:var(--text-dim,#aaa);">';
        Object.keys(AGENT_LABELS).forEach(function(key) {
          var checked = agents.indexOf(key) >= 0 ? 'checked' : '';
          html += '<label style="display:inline-flex;align-items:center;gap:4px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;cursor:pointer;">' +
            '<input type="checkbox" data-skill-agent="' + idx + '" data-agent-key="' + key + '" ' + checked + ' style="margin:0;" /> ' + AGENT_LABELS[key] +
          '</label>';
        });
        html += '</div>';
        html += '<textarea data-skill-body="' + idx + '" rows="8" style="width:100%;resize:vertical;font-family:\'SF Mono\',monospace;font-size:12px;line-height:1.5;" placeholder="Free-form prompt text. Markdown ok. Refer to subgroups, tools, common scopes, pricing rules.">' + escapeHTML(skill.body || '') + '</textarea>';
        html += '</div>';
      });
    }

    html += '<button class="ee-btn secondary" onclick="addSkill()">&#x2795; Add Skill</button>';
    html += '</fieldset>';
    return html;
  }

  function syncSkillsFromInputs() {
    if (!_skillsDraft || !Array.isArray(_skillsDraft.skills)) _skillsDraft = { skills: [] };
    _skillsDraft.skills.forEach(function(skill, idx) {
      var nameEl = document.querySelector('[data-skill-name="' + idx + '"]');
      var bodyEl = document.querySelector('[data-skill-body="' + idx + '"]');
      var alwaysOnEl = document.querySelector('[data-skill-alwayson="' + idx + '"]');
      if (nameEl) skill.name = nameEl.value;
      if (bodyEl) skill.body = bodyEl.value;
      if (alwaysOnEl) skill.alwaysOn = !!alwaysOnEl.checked;
      var agents = [];
      document.querySelectorAll('[data-skill-agent="' + idx + '"]').forEach(function(el) {
        if (el.checked) agents.push(el.getAttribute('data-agent-key'));
      });
      skill.agents = agents;
    });
  }

  function addSkill() {
    syncTopLevelDraftFromInputs();
    syncBTMappingFromInputs();
    syncSkillsFromInputs();
    if (!_skillsDraft || !Array.isArray(_skillsDraft.skills)) _skillsDraft = { skills: [] };
    _skillsDraft.skills.push({
      id: 'sk_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      name: '',
      agents: ['ag'],
      alwaysOn: true,
      body: ''
    });
    renderTemplatesForm();
  }

  function deleteSkill(idx) {
    if (!_skillsDraft || !Array.isArray(_skillsDraft.skills)) return;
    var skill = _skillsDraft.skills[idx];
    if (!skill) return;
    if (!confirm('Remove skill pack "' + (skill.name || '(unnamed)') + '"?')) return;
    syncTopLevelDraftFromInputs();
    syncBTMappingFromInputs();
    syncSkillsFromInputs();
    _skillsDraft.skills.splice(idx, 1);
    renderTemplatesForm();
  }

  window.addSkill = addSkill;
  window.deleteSkill = deleteSkill;

  function syncBTMappingFromInputs() {
    if (!_btMappingDraft) _btMappingDraft = { categories: {}, fallback: {}, income: {} };
    if (!_btMappingDraft.categories) _btMappingDraft.categories = {};
    if (!_btMappingDraft.fallback) _btMappingDraft.fallback = {};
    if (!_btMappingDraft.income) _btMappingDraft.income = {};
    document.querySelectorAll('[data-bt-cat]').forEach(function(el) {
      var k = el.getAttribute('data-bt-cat');
      var f = el.getAttribute('data-bt-field');
      if (!_btMappingDraft.categories[k]) _btMappingDraft.categories[k] = {};
      _btMappingDraft.categories[k][f] = el.value;
    });
    document.querySelectorAll('[data-bt-fb-field]').forEach(function(el) {
      var f = el.getAttribute('data-bt-fb-field');
      _btMappingDraft.fallback[f] = el.value;
    });
    document.querySelectorAll('[data-bt-inc-field]').forEach(function(el) {
      var f = el.getAttribute('data-bt-inc-field');
      _btMappingDraft.income[f] = el.value;
    });
  }

  function addExclusion() {
    if (!_templateDraft) _templateDraft = {};
    if (!Array.isArray(_templateDraft.exclusions)) _templateDraft.exclusions = [];
    syncTopLevelDraftFromInputs();
    _templateDraft.exclusions.push('');
    renderTemplatesForm();
    // Focus the new textarea so the admin can type into it immediately
    var rows = document.querySelectorAll('[data-excl-idx]');
    if (rows.length) rows[rows.length - 1].focus();
  }

  function deleteExclusion(idx) {
    if (!_templateDraft || !Array.isArray(_templateDraft.exclusions)) return;
    if (!confirm('Remove exclusion ' + (idx + 1) + '?')) return;
    syncTopLevelDraftFromInputs();
    _templateDraft.exclusions.splice(idx, 1);
    renderTemplatesForm();
  }

  function moveExclusion(idx, delta) {
    if (!_templateDraft || !Array.isArray(_templateDraft.exclusions)) return;
    var to = idx + delta;
    if (to < 0 || to >= _templateDraft.exclusions.length) return;
    syncTopLevelDraftFromInputs();
    var arr = _templateDraft.exclusions;
    var moved = arr.splice(idx, 1)[0];
    arr.splice(to, 0, moved);
    renderTemplatesForm();
  }

  function saveAdminTemplate() {
    syncTopLevelDraftFromInputs();
    syncBTMappingFromInputs();
    // agent_skills moved to Admin → Agents → Skills (saved there via
    // saveAgentsSkills); not touched by this Save All anymore.
    var statusEl = document.getElementById('tpl-status');
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--text-dim,#888)'; }
    Promise.all([
      window.agxApi.settings.put('proposal_template', _templateDraft),
      window.agxApi.settings.put('bt_export_mapping', _btMappingDraft)
    ]).then(function() {
      if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = '#34d399'; }
      // Bust the cached copies on the consumer modules so the next preview /
      // export render pulls the freshly-saved settings.
      if (typeof window.invalidateProposalTemplateCache === 'function') {
        window.invalidateProposalTemplateCache();
      }
      if (typeof window.invalidateBTMappingCache === 'function') {
        window.invalidateBTMappingCache();
      }
      setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2400);
    }).catch(function(err) {
      if (statusEl) { statusEl.textContent = 'Save failed: ' + (err.message || ''); statusEl.style.color = '#f87171'; }
    });
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
          ? '<button class="ee-btn ghost" disabled title="Built-in roles cannot be deleted">Delete</button>'
          : '<button class="ee-btn danger" onclick="deleteAdminRole(\'' + escapeHTML(r.name) + '\')">Delete</button>';
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
            '<button class="ee-btn secondary" onclick="openEditRoleModal(\'' + escapeHTML(r.name) + '\')">Edit</button>' +
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
      metricCard('Active Users', activeUsers, users.length + ' total') +
      metricCard('Online Now', '<span id="admin-metric-online-count" style="color:var(--text-dim,#888);">…</span>',
                 '<span id="admin-metric-online-asof"></span>');

    // Async fetch — doesn't block the rest of the metrics rendering.
    // 5-min threshold matches the API default. Self-clears the
    // placeholder if the request fails (e.g. offline mode) so the card
    // doesn't get stuck on "…".
    if (window.agxApi && window.agxApi.isAuthenticated && window.agxApi.isAuthenticated()) {
      window.agxApi.get('/api/auth/active-users').then(function(r) {
        var countEl = document.getElementById('admin-metric-online-count');
        var asOfEl = document.getElementById('admin-metric-online-asof');
        if (countEl) {
          countEl.textContent = r.activeCount;
          countEl.style.color = 'var(--text,#fff)';
        }
        if (asOfEl) {
          var t = new Date(r.asOf);
          var hh = t.getHours();
          var mm = String(t.getMinutes()).padStart(2, '0');
          var ampm = hh >= 12 ? 'PM' : 'AM';
          var hh12 = hh % 12; if (hh12 === 0) hh12 = 12;
          asOfEl.textContent = 'as of ' + hh12 + ':' + mm + ' ' + ampm +
            ' · last ' + r.thresholdMinutes + ' min';
        }
      }).catch(function() {
        var countEl = document.getElementById('admin-metric-online-count');
        if (countEl) countEl.textContent = '—';
      });
    } else {
      var countEl = document.getElementById('admin-metric-online-count');
      if (countEl) countEl.textContent = '—';
    }

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
  window.renderAdminTemplates = renderAdminTemplates;
  window.renderAdminEmail = renderAdminEmail;
  window.renderAdminEmailTemplates = renderAdminEmailTemplates;
  window.saveAdminTemplate = saveAdminTemplate;
  window.addExclusion = addExclusion;
  window.deleteExclusion = deleteExclusion;
  window.moveExclusion = moveExclusion;

  // ==================== ADMIN AGENTS ====================
  // Observability surface for the in-app AI agents (AG, WIP, CRA).
  // Three sub-views:
  //   1. Metrics — last 7d / 30d aggregate per agent (turns, tokens,
  //      cost, tool uses, model mix).
  //   2. Conversations — recent threads list with drill-down into the
  //      full message log of any one.
  //   3. Skills (link out to the existing Templates → Skills tab —
  //      that admin surface stays where it is).

  var _agentsRange = '7d';
  var _agentsView = 'metrics'; // 'metrics' | 'conversations' | 'evals' | 'skills'
  var _agentsConvKey = null;   // when drilled into one conversation
  var _agentsEvalId = null;    // when drilled into one eval's run history

  function renderAdminAgents() {
    var pane = document.getElementById('admin-subtab-agents');
    if (!pane) return;
    // Range selector + refresh button hide on the Skills view since neither
    // applies to skill-pack editing.
    var showRange = _agentsView !== 'skills';
    pane.innerHTML =
      '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Observability and configuration for the three in-app AI agents — usage, cost, conversations, and the skill packs they load each turn.' +
      '</p>' +
      '<div id="agents-server-config" style="margin-bottom:10px;font-size:11px;color:var(--text-dim,#666);font-family:\'SF Mono\',monospace;">Loading server config…</div>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap;">' +
        '<div class="ws-right-tabs" style="margin:0;">' +
          '<button class="ws-right-tab' + (_agentsView === 'metrics' ? ' active' : '') + '" onclick="switchAgentsView(\'metrics\')">&#x1F4CA; Metrics</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'conversations' ? ' active' : '') + '" onclick="switchAgentsView(\'conversations\')">&#x1F4AC; Conversations</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'evals' ? ' active' : '') + '" onclick="switchAgentsView(\'evals\')">&#x1F9EA; Evals</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'skills' ? ' active' : '') + '" onclick="switchAgentsView(\'skills\')">&#x1F9E0; Skills</button>' +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<button class="ee-btn" onclick="openChiefOfStaff()" title="Open the Chief of Staff agent — observes AG / Elle / HR, audits conversations, reviews skill packs" style="background:linear-gradient(135deg,#fbbf24,#f97316);color:#fff;border:none;font-weight:600;">&#x1F3A9; Ask Chief of Staff</button>' +
        (showRange
          ? ('<label style="font-size:11px;color:var(--text-dim,#888);">Window</label>' +
             '<select id="agents-range-select" onchange="setAgentsRange(this.value)" style="font-size:12px;padding:4px 8px;">' +
               '<option value="7d"' + (_agentsRange === '7d' ? ' selected' : '') + '>Last 7 days</option>' +
               '<option value="30d"' + (_agentsRange === '30d' ? ' selected' : '') + '>Last 30 days</option>' +
             '</select>' +
             '<button class="ee-btn ghost" onclick="renderAdminAgents()" title="Refresh">&#x21BB;</button>')
          : '') +
      '</div>' +
      '<div id="agents-content"></div>';
    loadAgentsServerConfig();
    if (_agentsView === 'metrics')                   renderAgentsMetrics();
    else if (_agentsView === 'evals' && _agentsEvalId) renderAgentEvalDetail(_agentsEvalId);
    else if (_agentsView === 'evals')                renderAgentEvalsList();
    else if (_agentsView === 'skills')               renderAgentsSkillsView();
    else if (_agentsConvKey)                         renderAgentsConversationDetail(_agentsConvKey);
    else                                             renderAgentsConversationList();
  }

  // Loads the server's live agent runtime config (model + effort) and
  // renders it as a small badge above the tab bar. Lets the user verify
  // env-var flips (AI_MODEL, AI_EFFORT) without opening a chat — the
  // badge changes immediately on the next page render.
  function loadAgentsServerConfig() {
    var el = document.getElementById('agents-server-config');
    if (!el) return;
    window.agxApi.get('/api/admin/agents/config').then(function(cfg) {
      if (!cfg) { el.style.display = 'none'; return; }
      var modelLabel = cfg.model || '(none)';
      var effortLabel = cfg.effort ? ' · effort=' + cfg.effort : '';
      // Subtle green accent when running on Opus (xhigh effort surfaces
      // it explicitly so an env flip is visually obvious).
      var isOpus = (cfg.model || '').indexOf('opus') >= 0;
      var color = isOpus ? '#a78bfa' : 'var(--text-dim,#888)';
      el.innerHTML = '<span style="color:var(--text-dim,#666);">Server config:</span> ' +
        '<span style="color:' + color + ';font-weight:600;">' + escapeHTML(modelLabel) + '</span>' +
        '<span style="color:var(--text-dim,#888);">' + escapeHTML(effortLabel) + '</span>';
    }).catch(function(err) {
      el.innerHTML = '<span style="color:#f87171;">config load failed: ' + escapeHTML(err.message || 'unknown') + '</span>';
    });
  }

  function setAgentsRange(r) {
    _agentsRange = (r === '30d') ? '30d' : '7d';
    renderAdminAgents();
  }
  function switchAgentsView(v) {
    // Sync any in-flight skill edits before swapping away so the user
    // doesn't lose changes by clicking another tab.
    syncAgentsSkillsIfActive();
    _agentsView = v;
    _agentsConvKey = null;
    _agentsEvalId = null;
    renderAdminAgents();
  }

  // ─────────── Metrics view ───────────
  function renderAgentsMetrics() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading metrics…</div>';
    window.agxApi.get('/api/admin/agents/metrics?range=' + _agentsRange).then(function(resp) {
      var agents = (resp && resp.agents) || [];
      if (!agents.length) {
        host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">No data.</div>';
        return;
      }
      host.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:14px;">' +
        agents.map(renderAgentMetricsCard).join('') +
      '</div>';
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function renderAgentMetricsCard(a) {
    var totalCost = (a.models || []).reduce(function(s, m) { return s + (m.cost_usd || 0); }, 0);
    var modelMix = (a.models || []).map(function(m) {
      return '<div style="display:flex;justify-content:space-between;font-size:11px;color:var(--text-dim,#aaa);font-family:\'SF Mono\',monospace;">' +
        '<span>' + escapeHTML(m.model) + '</span>' +
        '<span>' + m.turns + ' turns</span>' +
      '</div>';
    }).join('');
    if (!modelMix) modelMix = '<div style="font-size:11px;color:var(--text-dim,#666);font-style:italic;">No assistant turns yet</div>';
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:8px;padding:14px;">' +
      '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);margin-bottom:10px;">' + escapeHTML(a.label) + '</div>' +
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px 16px;font-size:12px;color:var(--text-dim,#aaa);">' +
        statRow('Turns', a.turns) +
        statRow('Conversations', a.conversations) +
        statRow('Unique users', a.unique_users) +
        statRow('Tool uses', a.tool_uses) +
        statRow('Photos', a.photos_attached) +
        statRow('Tokens in / out', tokFmt(a.input_tokens) + ' / ' + tokFmt(a.output_tokens)) +
        statRow('Est. cost', '$' + (totalCost || 0).toFixed(2)) +
      '</div>' +
      '<div style="margin-top:10px;border-top:1px solid var(--border,#333);padding-top:8px;">' + modelMix + '</div>' +
    '</div>';
  }

  function statRow(k, v) {
    return '<div><div style="font-size:10px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#666);">' + escapeHTML(k) + '</div>' +
      '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(String(v == null ? '—' : v)) + '</div></div>';
  }
  function tokFmt(n) {
    n = Number(n) || 0;
    if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
    if (n >= 1_000)     return (n / 1_000).toFixed(1) + 'K';
    return String(n);
  }

  // ─────────── Conversations list view ───────────
  function renderAgentsConversationList() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading conversations…</div>';
    window.agxApi.get('/api/admin/agents/conversations?range=' + _agentsRange + '&limit=100').then(function(resp) {
      var rows = (resp && resp.conversations) || [];
      if (!rows.length) {
        host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">No conversations in this window.</div>';
        return;
      }
      var html = '<div class="table-container"><table>' +
        '<thead><tr>' +
          '<th>Agent</th>' +
          '<th>Entity</th>' +
          '<th>User</th>' +
          '<th style="text-align:right;">Turns</th>' +
          '<th style="text-align:right;">Tool uses</th>' +
          '<th style="text-align:right;">Tokens</th>' +
          '<th style="text-align:right;">Est. cost</th>' +
          '<th>Last activity</th>' +
          '<th>Models</th>' +
        '</tr></thead><tbody>';
      rows.forEach(function(c) {
        var agentLabel = c.entity_type === 'estimate' ? '📐 AG'
                       : c.entity_type === 'job'      ? '📊 Elle'
                       : c.entity_type === 'client'   ? '🤝 HR'
                       : c.entity_type;
        var when = '';
        try { when = new Date(c.last_at).toLocaleString(); } catch (e) {}
        var totalTok = (Number(c.input_tokens) || 0) + (Number(c.output_tokens) || 0);
        html += '<tr style="cursor:pointer;" onclick="openAgentConversation(\'' + escapeAttr(c.key) + '\')">' +
          '<td>' + escapeHTML(agentLabel) + '</td>' +
          '<td>' + escapeHTML(c.entity_title || c.entity_id || '') + '</td>' +
          '<td>' + escapeHTML(c.user_email || c.user_name || ('user ' + c.user_id)) + '</td>' +
          '<td style="text-align:right;">' + c.turns + '</td>' +
          '<td style="text-align:right;">' + c.tool_uses + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;font-size:11px;">' + tokFmt(totalTok) + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;font-size:11px;">' + (c.cost_usd != null ? '$' + c.cost_usd.toFixed(2) : '—') + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);font-family:\'SF Mono\',monospace;">' + escapeHTML((c.models || []).join(', ')) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function openAgentConversation(key) {
    _agentsConvKey = key;
    renderAdminAgents();
  }

  // ─────────── Conversation detail view ───────────
  function renderAgentsConversationDetail(key) {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading messages…</div>';
    Promise.all([
      window.agxApi.get('/api/admin/agents/conversations/' + encodeURIComponent(key)),
      window.agxApi.get('/api/admin/agents/conversations/' + encodeURIComponent(key) + '/replays').catch(function() { return { replays: [] }; })
    ]).then(function(results) {
      var c = results[0];
      var replays = (results[1] && results[1].replays) || [];
      var header = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">' +
          '<button class="ee-btn secondary" onclick="closeAgentConversation()">&larr; Back to list</button>' +
          '<div style="flex:1;">' +
            '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(c.entity_title || c.entity_id || '') + '</div>' +
            '<div style="font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(c.entity_type) + ' &middot; ' + escapeHTML(c.user_email || ('user ' + c.user_id)) + ' &middot; ' + (c.messages || []).length + ' messages</div>' +
          '</div>' +
          '<button class="ee-btn" onclick="openReplayDialog(\'' + escapeAttr(key) + '\')" style="background:linear-gradient(135deg,#8b5cf6,#4f8cff);color:#fff;border:none;font-weight:600;">&#x1F501; Replay last turn</button>' +
        '</div>';
      var msgs = (c.messages || []).map(renderAgentMessage).join('');
      if (!msgs) msgs = '<div style="color:var(--text-dim,#888);font-style:italic;">No messages.</div>';
      var replaysHtml = '';
      if (replays.length) {
        replaysHtml = '<div style="margin-top:18px;border-top:1px solid var(--border,#333);padding-top:14px;">' +
          '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin-bottom:8px;">Replays (' + replays.length + ')</div>' +
          '<div style="display:flex;flex-direction:column;gap:8px;">' +
          replays.map(renderReplayRow).join('') +
          '</div></div>';
      }
      host.innerHTML = header + '<div style="display:flex;flex-direction:column;gap:10px;">' + msgs + '</div>' + replaysHtml;
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function renderReplayRow(r) {
    var when = '';
    try { when = new Date(r.run_at).toLocaleString(); } catch (e) {}
    var paramBits = [];
    if (r.model_override)  paramBits.push('model=' + r.model_override);
    if (r.effort_override) paramBits.push('effort=' + r.effort_override);
    if (r.system_prefix)   paramBits.push('+system_prefix');
    if (!paramBits.length) paramBits.push('default params');
    var toolPreview = (r.tool_calls && r.tool_calls.length)
      ? r.tool_calls.map(function(t) { return t.name; }).join(', ')
      : '(no tool calls)';
    return '<details style="background:rgba(139,92,246,0.04);border:1px solid rgba(139,92,246,0.25);border-radius:6px;padding:8px 10px;">' +
      '<summary style="cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;flex-wrap:wrap;">' +
        '<span style="display:inline-block;background:rgba(139,92,246,0.18);color:#a78bfa;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;">REPLAY</span>' +
        '<span style="color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</span>' +
        '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + escapeHTML(paramBits.join(' · ')) + '</span>' +
        '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + (r.duration_ms ? Math.round(r.duration_ms / 100) / 10 + 's' : '—') + '</span>' +
        '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + (r.input_tokens || 0) + ' in / ' + (r.output_tokens || 0) + ' out</span>' +
      '</summary>' +
      (r.error
        ? '<div style="color:#f87171;font-size:12px;margin-top:8px;">' + escapeHTML(r.error) + '</div>'
        : '<div style="margin-top:8px;">' +
            '<div style="font-size:10px;text-transform:uppercase;color:var(--text-dim,#666);">Tool calls</div>' +
            '<div style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);margin-top:2px;">' + escapeHTML(toolPreview) + '</div>' +
            (r.response_text ? '<div style="margin-top:8px;"><div style="font-size:10px;text-transform:uppercase;color:var(--text-dim,#666);">Response text</div><pre style="font-size:12px;color:var(--text-dim,#ccc);background:rgba(0,0,0,0.15);padding:8px;border-radius:4px;margin:4px 0 0;max-height:300px;overflow:auto;white-space:pre-wrap;">' + escapeHTML(r.response_text) + '</pre></div>' : '') +
          '</div>'
      ) +
    '</details>';
  }

  function openReplayDialog(key) {
    var modelChoice = prompt(
      'Replay this conversation with which model?\n\n' +
      'Available:\n' +
      '  claude-opus-4-7   (most capable, $5/$25 per 1M)\n' +
      '  claude-opus-4-6\n' +
      '  claude-sonnet-4-6 (default)\n' +
      '  claude-haiku-4-5  (cheapest)\n\n' +
      'Leave blank to use the env default.',
      'claude-opus-4-7'
    );
    if (modelChoice === null) return;
    var effortChoice = prompt('Thinking effort? (low / medium / high / xhigh / max — Opus 4.7 + Sonnet 4.6 only). Leave blank for none.', 'xhigh');
    if (effortChoice === null) return;
    var systemPrefix = prompt('Optional extra system-prompt prefix (e.g., a draft skill pack to test). Leave blank to skip.', '');
    if (systemPrefix === null) return;

    var hostNotice = document.getElementById('agents-content');
    if (hostNotice) {
      var notice = document.createElement('div');
      notice.style.cssText = 'margin-bottom:10px;padding:10px;background:rgba(139,92,246,0.08);border:1px solid rgba(139,92,246,0.25);border-radius:6px;font-size:12px;color:#c4b5fd;';
      notice.textContent = '🔁 Running replay… (model: ' + (modelChoice || 'default') + (effortChoice ? ', effort: ' + effortChoice : '') + ')';
      hostNotice.insertBefore(notice, hostNotice.firstChild);
    }
    window.agxApi.post('/api/admin/agents/conversations/' + encodeURIComponent(key) + '/replay', {
      model_override: modelChoice.trim() || undefined,
      effort_override: effortChoice.trim() || undefined,
      system_prefix: systemPrefix.trim() || undefined
    }).then(function(resp) {
      alert('✓ Replay complete\n\nModel: ' + (resp.model || '—') + '\nDuration: ' + (resp.duration_ms ? Math.round(resp.duration_ms / 100) / 10 + 's' : '—') + '\nTool calls: ' + (resp.tool_calls ? resp.tool_calls.length : 0) + '\nTokens in/out: ' + (resp.input_tokens || 0) + ' / ' + (resp.output_tokens || 0));
      renderAgentsConversationDetail(key);
    }).catch(function(err) {
      alert('Replay failed: ' + (err.message || 'unknown'));
      renderAgentsConversationDetail(key);
    });
  }

  function closeAgentConversation() {
    _agentsConvKey = null;
    renderAdminAgents();
  }

  function renderAgentMessage(m) {
    var roleColor = m.role === 'user' ? '#4f8cff' : (m.role === 'assistant' ? '#a78bfa' : '#888');
    var when = '';
    try { when = new Date(m.created_at).toLocaleString(); } catch (e) {}
    var meta = [];
    if (m.model)            meta.push(m.model);
    if (m.input_tokens)     meta.push('in ' + tokFmt(m.input_tokens));
    if (m.output_tokens)    meta.push('out ' + tokFmt(m.output_tokens));
    if (m.tool_use_count)   meta.push(m.tool_use_count + ' tools');
    if (m.photos_included)  meta.push(m.photos_included + ' photos');
    var content = m.content || '';
    // Detect the JSON-array form used by tool-use turns. Render those
    // as an indented block so the structure is visible.
    var displayContent;
    if (content && content.charAt(0) === '[') {
      try {
        var parsed = JSON.parse(content);
        displayContent = '<pre style="white-space:pre-wrap;font-size:11px;color:var(--text-dim,#aaa);background:rgba(0,0,0,0.2);padding:8px;border-radius:4px;margin:0;font-family:\'SF Mono\',monospace;">' + escapeHTML(JSON.stringify(parsed, null, 2)) + '</pre>';
      } catch (e) {
        displayContent = '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text,#ccc);margin:0;">' + escapeHTML(content) + '</pre>';
      }
    } else {
      displayContent = '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text,#ccc);margin:0;font-family:inherit;">' + escapeHTML(content) + '</pre>';
    }
    return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-left:3px solid ' + roleColor + ';border-radius:6px;padding:10px 12px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px;font-size:11px;">' +
        '<span style="font-weight:600;color:' + roleColor + ';text-transform:uppercase;letter-spacing:0.5px;">' + escapeHTML(m.role) + '</span>' +
        '<span style="color:var(--text-dim,#888);font-family:\'SF Mono\',monospace;">' + escapeHTML(meta.join(' &middot; ')) + '</span>' +
      '</div>' +
      displayContent +
      '<div style="margin-top:6px;font-size:10px;color:var(--text-dim,#666);">' + escapeHTML(when) + '</div>' +
    '</div>';
  }

  function openChiefOfStaff() {
    if (!window.agxAI || typeof window.agxAI.open !== 'function') {
      alert('AI panel not loaded — refresh the page.');
      return;
    }
    window.agxAI.open({ entityType: 'staff' });
  }

  // ─────────── Skills view (mounted on the Agents page) ───────────
  // Reuses the existing skill-pack renderer + draft state from the
  // Templates → Skills surface. The draft (_skillsDraft) is shared
  // between the two surfaces, and saving from either persists to the
  // same app_settings.agent_skills row. We sync inputs into the draft
  // before any view switch so unsaved edits don't get clobbered.
  function renderAgentsSkillsView() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading skill packs…</div>';
    window.agxApi.settings.get('agent_skills').then(function(res) {
      _skillsDraft = (res && res.setting && res.setting.value) || { skills: [] };
      if (!Array.isArray(_skillsDraft.skills)) _skillsDraft.skills = [];
      // Reuse the same body markup the Templates → Skills tab renders,
      // wrap with a save bar tailored for the agents page (lighter than
      // saveAdminTemplate's "save all settings" action).
      host.innerHTML =
        '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
          'Reusable instruction blocks loaded into the in-app AI agents at chat time. The Chief of Staff can also propose skill-pack edits — those land here on approval. Edits made here are also visible from <a href="#" onclick="switchAdminSubTab(\'templates\');return false;" style="color:#4f8cff;">Templates &rarr; Skills</a>.' +
        '</p>' +
        '<div id="agents-skills-body">' + renderAgentSkillsHTML() + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:14px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;">' +
          '<span id="agents-skills-status" style="flex:1;font-size:12px;color:var(--text-dim,#888);"></span>' +
          '<button class="ee-btn secondary" onclick="renderAgentsSkillsView()">Discard changes</button>' +
          '<button class="ee-btn primary" onclick="saveAgentsSkills()">&#x1F4BE; Save skills</button>' +
        '</div>';
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function saveAgentsSkills() {
    syncSkillsFromInputs();
    var statusEl = document.getElementById('agents-skills-status');
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--text-dim,#888)'; }
    window.agxApi.settings.put('agent_skills', _skillsDraft).then(function() {
      if (statusEl) { statusEl.textContent = 'Saved.'; statusEl.style.color = '#34d399'; }
      setTimeout(function() { if (statusEl) statusEl.textContent = ''; }, 2400);
    }).catch(function(err) {
      if (statusEl) { statusEl.textContent = 'Save failed: ' + (err.message || ''); statusEl.style.color = '#f87171'; }
    });
  }

  // When swapping away from the Skills view (within the Agents page),
  // sync any in-flight input edits into _skillsDraft so they survive
  // until either save or discard. switchAgentsView calls this.
  function syncAgentsSkillsIfActive() {
    if (_agentsView === 'skills' && _skillsDraft && Array.isArray(_skillsDraft.skills)) {
      try { syncSkillsFromInputs(); } catch (e) { /* ignore — inputs may not be in DOM yet */ }
    }
  }

  // ─────────── Evals view ───────────
  function renderAgentEvalsList() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading evals…</div>';
    window.agxApi.get('/api/admin/agents/evals').then(function(resp) {
      var rows = (resp && resp.evals) || [];
      var btn = '<button class="ee-btn primary" onclick="openNewEvalModal()" style="margin-bottom:14px;">+ Add fixture</button>';
      var help = '<p style="margin:0 0 10px;font-size:12px;color:var(--text-dim,#888);">' +
        'Curated fixtures replayed against AG to catch regressions. Each fixture references an existing estimate id; the runner rebuilds AG\'s normal context, sends a known prompt, and scores the response against expected_signals.' +
        '</p>';
      if (!rows.length) {
        host.innerHTML = btn + help + '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">No fixtures yet. Add one to start tracking AG quality across changes.</div>';
        return;
      }
      var html = btn + help + '<div class="table-container"><table>' +
        '<thead><tr><th>Name</th><th>Kind</th><th>Runs</th><th>Last result</th><th>Last run</th><th></th></tr></thead><tbody>';
      rows.forEach(function(e) {
        var lr = e.latest_run || {};
        var pill = '—';
        if (lr.run_at) {
          pill = lr.passed
            ? '<span style="display:inline-block;background:rgba(52,211,153,0.15);color:#34d399;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">PASS</span>'
            : '<span style="display:inline-block;background:rgba(248,113,113,0.15);color:#f87171;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">FAIL</span>';
        }
        var when = '';
        try { if (lr.run_at) when = new Date(lr.run_at).toLocaleString(); } catch (ex) {}
        html += '<tr style="cursor:pointer;" onclick="openEvalDetail(\'' + escapeAttr(e.id) + '\')">' +
          '<td>' + escapeHTML(e.name) + (e.description ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">' + escapeHTML(e.description) + '</div>' : '') + '</td>' +
          '<td>' + escapeHTML(e.kind) + '</td>' +
          '<td>' + (e.run_count || 0) + '</td>' +
          '<td>' + pill + (lr.duration_ms ? ' <span style="color:var(--text-dim,#888);font-size:11px;">(' + Math.round(lr.duration_ms / 100) / 10 + 's)</span>' : '') + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
          '<td><button class="ee-btn primary" type="button" onclick="event.stopPropagation();runEval(\'' + escapeAttr(e.id) + '\')">&#x25B6; Run</button></td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function openEvalDetail(id) {
    _agentsEvalId = id;
    renderAdminAgents();
  }

  function runEval(id) {
    var btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Running…'; }
    window.agxApi.post('/api/admin/agents/evals/' + encodeURIComponent(id) + '/run', {}).then(function(resp) {
      var ok = resp && resp.passed;
      alert((ok ? '✓ PASSED' : '✗ FAILED') + '\n\nModel: ' + (resp.model || '—') + (resp.effort ? ' · effort=' + resp.effort : '') + '\nDuration: ' + (resp.duration_ms ? Math.round(resp.duration_ms / 100) / 10 + 's' : '—') + '\nTool calls: ' + (resp.tool_calls ? resp.tool_calls.length : 0) + '\nTokens in/out: ' + (resp.input_tokens || 0) + ' / ' + (resp.output_tokens || 0));
      if (_agentsEvalId === id) renderAgentEvalDetail(id);
      else renderAgentEvalsList();
    }).catch(function(err) {
      alert('Run failed: ' + (err.message || 'unknown'));
      if (_agentsEvalId === id) renderAgentEvalDetail(id);
      else renderAgentEvalsList();
    });
  }

  function renderAgentEvalDetail(id) {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading eval…</div>';
    window.agxApi.get('/api/admin/agents/evals/' + encodeURIComponent(id)).then(function(resp) {
      var ev = resp && resp.eval;
      var runs = (resp && resp.runs) || [];
      if (!ev) {
        host.innerHTML = '<div style="color:#e74c3c;">Eval not found.</div>';
        return;
      }
      var fixturePretty = '';
      try { fixturePretty = JSON.stringify(ev.fixture, null, 2); } catch (e) { fixturePretty = String(ev.fixture); }
      var signalsPretty = '';
      try { signalsPretty = JSON.stringify(ev.expected_signals, null, 2); } catch (e) { signalsPretty = String(ev.expected_signals); }
      var html = '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
          '<button class="ee-btn secondary" onclick="closeEvalDetail()">&larr; Back to evals</button>' +
          '<div style="flex:1;font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(ev.name) + '</div>' +
          '<button class="ee-btn primary" onclick="runEval(\'' + escapeAttr(ev.id) + '\')">&#x25B6; Run now</button>' +
          '<button class="ee-btn danger" onclick="deleteEval(\'' + escapeAttr(ev.id) + '\')">&#x1F5D1; Delete</button>' +
        '</div>';
      if (ev.description) html += '<div style="font-size:12px;color:var(--text-dim,#aaa);margin-bottom:14px;">' + escapeHTML(ev.description) + '</div>';
      html += '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:18px;">' +
          '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin-bottom:6px;">Fixture</div>' +
            '<pre style="background:rgba(0,0,0,0.2);padding:10px;border-radius:6px;font-size:11px;color:var(--text-dim,#aaa);max-height:300px;overflow:auto;margin:0;">' + escapeHTML(fixturePretty) + '</pre>' +
          '</div>' +
          '<div><div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin-bottom:6px;">Expected signals</div>' +
            '<pre style="background:rgba(0,0,0,0.2);padding:10px;border-radius:6px;font-size:11px;color:var(--text-dim,#aaa);max-height:300px;overflow:auto;margin:0;">' + escapeHTML(signalsPretty) + '</pre>' +
          '</div>' +
        '</div>';
      html += '<div style="font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);margin-bottom:6px;">Run history (' + runs.length + ')</div>';
      if (!runs.length) {
        html += '<div style="color:var(--text-dim,#888);font-style:italic;font-size:12px;padding:10px 0;">No runs yet — click "Run now".</div>';
      } else {
        html += '<div style="display:flex;flex-direction:column;gap:8px;">';
        runs.forEach(function(r) {
          var when = '';
          try { when = new Date(r.run_at).toLocaleString(); } catch (e) {}
          var pill = r.passed
            ? '<span style="display:inline-block;background:rgba(52,211,153,0.15);color:#34d399;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">PASS</span>'
            : '<span style="display:inline-block;background:rgba(248,113,113,0.15);color:#f87171;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">FAIL</span>';
          var scorePretty = '';
          try { scorePretty = JSON.stringify(r.score, null, 2); } catch (e) {}
          html += '<details style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:8px 10px;">' +
              '<summary style="cursor:pointer;display:flex;align-items:center;gap:8px;font-size:12px;">' +
                pill +
                '<span style="color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</span>' +
                '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + escapeHTML(r.model || '') + (r.effort ? ' · ' + escapeHTML(r.effort) : '') + '</span>' +
                '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + (r.duration_ms ? Math.round(r.duration_ms / 100) / 10 + 's' : '—') + '</span>' +
                '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);font-size:11px;">' + (r.input_tokens || 0) + ' in / ' + (r.output_tokens || 0) + ' out</span>' +
              '</summary>' +
              (r.error
                ? '<div style="color:#f87171;font-size:12px;margin-top:8px;">' + escapeHTML(r.error) + '</div>'
                : '<div style="margin-top:8px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
                    '<div><div style="font-size:10px;text-transform:uppercase;color:var(--text-dim,#666);">Score</div>' +
                      '<pre style="font-size:11px;color:var(--text-dim,#aaa);background:rgba(0,0,0,0.15);padding:8px;border-radius:4px;margin:4px 0 0;max-height:200px;overflow:auto;">' + escapeHTML(scorePretty) + '</pre></div>' +
                    '<div><div style="font-size:10px;text-transform:uppercase;color:var(--text-dim,#666);">Tool calls (' + ((r.tool_calls || []).length) + ')</div>' +
                      '<pre style="font-size:11px;color:var(--text-dim,#aaa);background:rgba(0,0,0,0.15);padding:8px;border-radius:4px;margin:4px 0 0;max-height:200px;overflow:auto;">' + escapeHTML((r.tool_calls || []).map(function(t) { return t.name + '(' + JSON.stringify(t.input).slice(0, 80) + ')'; }).join('\n')) + '</pre></div>' +
                  '</div>' +
                  (r.response_text ? '<div style="margin-top:10px;"><div style="font-size:10px;text-transform:uppercase;color:var(--text-dim,#666);">Response text</div><pre style="font-size:12px;color:var(--text-dim,#ccc);background:rgba(0,0,0,0.15);padding:8px;border-radius:4px;margin:4px 0 0;max-height:300px;overflow:auto;white-space:pre-wrap;">' + escapeHTML(r.response_text) + '</pre></div>' : '')
              ) +
            '</details>';
        });
        html += '</div>';
      }
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function closeEvalDetail() {
    _agentsEvalId = null;
    renderAdminAgents();
  }

  function deleteEval(id) {
    if (!confirm('Delete this eval fixture? Its run history will also be removed.')) return;
    window.agxApi.del('/api/admin/agents/evals/' + encodeURIComponent(id)).then(function() {
      _agentsEvalId = null;
      renderAdminAgents();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown'));
    });
  }

  function openNewEvalModal() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading recent estimates…</div>';
    window.agxApi.estimates.list().then(function(resp) {
      var estimates = (resp && resp.estimates) || [];
      // Sort newest-first; cap at 200 so the dropdown stays usable.
      estimates.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
      estimates = estimates.slice(0, 200);
      var options = '<option value="">— Pick an estimate —</option>' +
        estimates.map(function(e) {
          var when = '';
          try { when = new Date(e.updated_at).toLocaleDateString(); } catch (ex) {}
          var label = (e.title || '(untitled)') + (when ? ' · ' + when : '') + ' · ' + e.id.slice(-8);
          return '<option value="' + escapeAttr(e.id) + '">' + escapeHTML(label) + '</option>';
        }).join('');
      host.innerHTML =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
          '<button class="ee-btn secondary" onclick="cancelNewEval()">&larr; Back to evals</button>' +
          '<div style="flex:1;font-size:14px;font-weight:600;color:var(--text,#fff);">New eval fixture</div>' +
        '</div>' +
        '<p style="margin:0 0 14px 0;font-size:12px;color:var(--text-dim,#888);">' +
          'Replays a known estimate through AG with a fixed prompt and scores the response. Pick an estimate you trust as ground truth — the runner rebuilds AG\'s normal context (photos, attachments, linked-lead notes, client notes, skill packs) just like a real chat session.' +
        '</p>' +
        '<div style="display:flex;flex-direction:column;gap:14px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:8px;padding:16px;">' +
          fieldset('Identity',
            '<div><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Fixture name *</label>' +
              '<input id="evalNew_name" type="text" placeholder="e.g., Wimbledon Greens deck rebuild — line-item draft" style="width:100%;" /></div>' +
            '<div style="margin-top:10px;"><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Description (optional)</label>' +
              '<textarea id="evalNew_description" rows="2" style="resize:vertical;width:100%;" placeholder="What this fixture is testing"></textarea></div>'
          ) +
          fieldset('Source estimate',
            '<div><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Pick estimate * <span style="color:var(--text-dim,#888);font-weight:400;">(' + estimates.length + ' shown, newest first)</span></label>' +
              '<select id="evalNew_estimateId" style="width:100%;font-family:inherit;">' + options + '</select></div>' +
            '<div style="margin-top:10px;"><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">User prompt *</label>' +
              '<textarea id="evalNew_userPrompt" rows="2" style="resize:vertical;width:100%;font-family:inherit;">Build my line items</textarea></div>'
          ) +
          fieldset('Expected signals (all optional — leave blank to skip a check)',
            '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
              '<div><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Min line items</label>' +
                '<input id="evalNew_minLines" type="number" min="0" max="200" placeholder="e.g., 8" /></div>' +
              '<div><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Max line items</label>' +
                '<input id="evalNew_maxLines" type="number" min="0" max="200" placeholder="e.g., 25" /></div>' +
            '</div>' +
            '<div style="margin-top:10px;"><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Must-mention keywords <span style="color:var(--text-dim,#888);font-weight:400;">(comma-separated)</span></label>' +
              '<input id="evalNew_keywords" type="text" placeholder="e.g., pickets, demo, fasteners" style="width:100%;" /></div>' +
            '<div style="margin-top:10px;"><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Must-have sections <span style="color:var(--text-dim,#888);font-weight:400;">(comma-separated)</span></label>' +
              '<input id="evalNew_sections" type="text" placeholder="e.g., Materials &amp; Supplies, Direct Labor" style="width:100%;" /></div>'
          ) +
          '<div id="evalNew_error" style="color:#e74c3c;font-size:12px;display:none;"></div>' +
          '<div style="display:flex;gap:8px;justify-content:flex-end;">' +
            '<button class="ee-btn secondary" onclick="cancelNewEval()">Cancel</button>' +
            '<button class="ee-btn primary" id="evalNew_submitBtn" onclick="submitNewEval()">Save fixture</button>' +
          '</div>' +
        '</div>';

      // Pre-fill estimate dropdown if the user is currently inside the
      // estimate editor — quick-snapshot path.
      try {
        if (window.estimateEditorAPI && typeof window.estimateEditorAPI.getOpenId === 'function') {
          var openId = window.estimateEditorAPI.getOpenId();
          if (openId) {
            var sel = document.getElementById('evalNew_estimateId');
            if (sel) sel.value = openId;
          }
        }
      } catch (e) { /* ignore */ }
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Could not load estimates: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function fieldset(legend, body) {
    return '<fieldset style="border:1px solid var(--border,#333);border-radius:6px;padding:10px 14px;margin:0;">' +
      '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">' + escapeHTML(legend) + '</legend>' +
      body +
      '</fieldset>';
  }

  function cancelNewEval() {
    renderAgentEvalsList();
  }

  function submitNewEval() {
    var name = (document.getElementById('evalNew_name').value || '').trim();
    var description = (document.getElementById('evalNew_description').value || '').trim();
    var estimateId = (document.getElementById('evalNew_estimateId').value || '').trim();
    var userPrompt = (document.getElementById('evalNew_userPrompt').value || '').trim();
    var minLines = (document.getElementById('evalNew_minLines').value || '').trim();
    var maxLines = (document.getElementById('evalNew_maxLines').value || '').trim();
    var keywordsStr = (document.getElementById('evalNew_keywords').value || '').trim();
    var sectionsStr = (document.getElementById('evalNew_sections').value || '').trim();
    var errEl = document.getElementById('evalNew_error');
    function showErr(msg) { errEl.textContent = msg; errEl.style.display = 'block'; }

    if (!name)         return showErr('Fixture name is required.');
    if (!estimateId)   return showErr('Pick an estimate from the dropdown.');
    if (!userPrompt)   return showErr('User prompt is required.');

    var fixture = { estimate_id: estimateId, user_prompt: userPrompt };
    var expected = {};
    if (minLines && Number(minLines) >= 0) expected.min_line_items = Number(minLines);
    if (maxLines && Number(maxLines) >= 0) expected.max_line_items = Number(maxLines);
    if (keywordsStr) expected.must_mention = keywordsStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    if (sectionsStr) expected.must_have_section = sectionsStr.split(',').map(function(s) { return s.trim(); }).filter(Boolean);

    var btn = document.getElementById('evalNew_submitBtn');
    if (btn) { btn.disabled = true; btn.textContent = 'Saving…'; }
    window.agxApi.post('/api/admin/agents/evals', {
      name: name,
      description: description || undefined,
      kind: 'estimate_draft',
      fixture: fixture,
      expected_signals: expected
    }).then(function() {
      renderAgentEvalsList();
    }).catch(function(err) {
      showErr('Save failed: ' + (err.message || 'unknown'));
      if (btn) { btn.disabled = false; btn.textContent = 'Save fixture'; }
    });
  }

  window.renderAdminAgents = renderAdminAgents;
  window.setAgentsRange = setAgentsRange;
  window.switchAgentsView = switchAgentsView;
  window.openAgentConversation = openAgentConversation;
  window.closeAgentConversation = closeAgentConversation;
  window.openReplayDialog = openReplayDialog;
  window.openChiefOfStaff = openChiefOfStaff;
  window.renderAgentsSkillsView = renderAgentsSkillsView;
  window.saveAgentsSkills = saveAgentsSkills;
  window.openEvalDetail = openEvalDetail;
  window.closeEvalDetail = closeEvalDetail;
  window.runEval = runEval;
  window.deleteEval = deleteEval;
  window.openNewEvalModal = openNewEvalModal;
  window.cancelNewEval = cancelNewEval;
  window.submitNewEval = submitNewEval;
})();
