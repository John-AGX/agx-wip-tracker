// Project 86 Admin module — users management UI.
// Backed by /api/auth/users (list/create/update) and the password-reset endpoint.
(function() {
  'use strict';

  // Cache of last-fetched users so other code (e.g. PM dropdown in Add Job
  // modal) can read without re-fetching. Refreshed on every renderAdminUsers().
  var _users = [];

  function isAdmin() {
    return window.p86Auth && window.p86Auth.isAdmin();
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

    window.p86Api.users.list().then(function(res) {
      _users = res.users || [];
      if (!_users.length) {
        tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-dim,#888);padding:20px;">No users.</td></tr>';
        return;
      }
      var html = '';
      var me = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
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
    var phoneEl = document.getElementById('newUser_phone');
    var phone = phoneEl ? phoneEl.value.trim() : '';

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

    var payload = { name: name, email: email, password: password, role: role };
    if (phone) payload.phone_number = phone;
    window.p86Api.users.create(payload)
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
    var phoneEl = document.getElementById('editUser_phone');
    if (phoneEl) phoneEl.value = u.phone_number || '';
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
    var phoneEl = document.getElementById('editUser_phone');
    var phone = phoneEl ? phoneEl.value.trim() : '';

    btn.disabled = true;
    statusEl.style.color = 'var(--text-dim,#888)';
    statusEl.textContent = 'Saving…';

    // phone_number always sent (empty string clears the field, anything
    // else gets normalized server-side). Caller hasn't typed = stays empty
    // but the server treats present-empty as "clear" — that's the desired
    // behavior since the phone field on the form mirrors the user record.
    var updatePromise = window.p86Api.users.update(id, { name: name, role: role, active: active, phone_number: phone });
    var passwordPromise = newPassword
      ? window.p86Api.users.resetPassword(id, newPassword)
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
    if (!window.p86Api || !window.p86Api.isAuthenticated()) return Promise.resolve();
    return window.p86Api.users.list().then(function(res) {
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
  window.p86Admin = {
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

    var auth = window.p86Auth;
    if (!auth || auth.isOffline() || !window.p86Api || !window.p86Api.isAuthenticated()) {
      card.style.display = 'none';
      return;
    }

    _currentSharingJobId = jobId;
    listEl.innerHTML = '<div style="color:var(--text-dim,#888);">Loading…</div>';
    card.style.display = '';

    window.p86Api.jobs.listAccess(jobId).then(function(res) {
      _currentSharingShares = res.shares || [];
      var me = auth.getUser();
      var canManage = me && (me.role === 'admin' || me.id === res.owner_id);
      if (!canManage) {
        // Non-managers don't even see the card. Just re-hide and bail.
        card.style.display = 'none';
        return;
      }
      var users = (window.p86Admin && window.p86Admin.getCachedUsers && window.p86Admin.getCachedUsers()) || [];
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
    var users = (window.p86Admin && window.p86Admin.getCachedUsers && window.p86Admin.getCachedUsers()) || [];
    var alreadyShared = {};
    _currentSharingShares.forEach(function(s) { alreadyShared[s.user_id] = true; });
    var me = window.p86Auth && window.p86Auth.getUser();
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
    window.p86Api.jobs.grantAccess(_currentSharingJobId, userId, level)
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
          if (window.p86Data) window.p86Data.reloadFromServer();
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
    window.p86Api.jobs.revokeAccess(_currentSharingJobId, userId)
      .then(function() {
        renderJobSharing(_currentSharingJobId);
        if (window.p86Data) window.p86Data.reloadFromServer();
      })
      .catch(function(err) {
        alert('Revoke failed: ' + (err.message || 'unknown error'));
      });
  }

  function updateJobAccessLevel(userId, newLevel) {
    if (!_currentSharingJobId) return;
    window.p86Api.jobs.grantAccess(_currentSharingJobId, userId, newLevel)
      .then(function() {
        // Refresh in background; no UI change needed
        renderJobSharing(_currentSharingJobId);
        if (window.p86Data) window.p86Data.reloadFromServer();
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
      window.p86Api.jobs.list(),
      _users.length ? Promise.resolve({ users: _users }) : window.p86Api.users.list()
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
        window.p86Api.jobs.listAccess(j.id).then(function(res) {
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
    window.p86ConfirmTernary({
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
      window.p86Api.jobs.reassignOwner(jobId, parseInt(newOwnerId, 10), notifyOk)
        .then(function() {
          if (window.p86Data) window.p86Data.reloadFromServer();
          renderAdminJobs();
        })
        .catch(function(err) {
          window.p86Alert({ title: 'Reassign failed', message: err.message || 'unknown error' });
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
    if (!_users.length && window.p86Api) {
      window.p86Api.users.list().then(function(res) {
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
    window.p86Api.jobs.listAccess(jobId).then(function(res) {
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
    window.p86Api.jobs.grantAccess(_currentSharingJobId, userId, newLevel)
      .then(function() {
        refreshShareManager(_currentSharingJobId);
        if (window.p86Data) window.p86Data.reloadFromServer();
      })
      .catch(function(err) { alert('Update failed: ' + (err.message || '')); });
  }

  function revokeAdminJobAccess(userId) {
    if (!_currentSharingJobId) return;
    var u = _currentSharingShares.find(function(x) { return x.user_id === userId; });
    if (!confirm('Revoke ' + (u ? u.name : 'this user') + "'s access?")) return;
    window.p86Api.jobs.revokeAccess(_currentSharingJobId, userId)
      .then(function() {
        refreshShareManager(_currentSharingJobId);
        renderAdminJobs();
        if (window.p86Data) window.p86Data.reloadFromServer();
      })
      .catch(function(err) { alert('Revoke failed: ' + (err.message || '')); });
  }

  // Toggle between Users / Job Assignments / Metrics / Roles inside the
  // Admin tab. Renders the section's data on first reveal so we don't fire
  // API calls for tabs the admin never opens.
  // ==================== MATERIALS CATALOG ====================
  // Browse + edit Project 86's vendor purchase catalog. Backed by /api/materials,
  // populated by uploading vendor CSVs (Home Depot today; Lowe's / etc.
  // later via the same endpoint with a different vendor name).
  //
  // Catalog drives the AG `search_materials` tool — when the estimator is
  // proposing line items, it queries this list for real Project 86 descriptions
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
    if (!window.p86Api || !window.p86Api.materials) return;
    window.p86Api.materials.categories().then(function(res) {
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
    window.p86Api.materials.recategorize().then(function(res) {
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
    if (!window.p86Api) return;
    var listEl = document.getElementById('mat-list');
    if (listEl) listEl.innerHTML = '<div style="padding:20px;color:var(--text-dim,#888);text-align:center;">Loading…</div>';
    window.p86Api.materials.list({
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
    window.p86Api.materials.update(id, { is_hidden: !m.is_hidden }).then(loadMaterials);
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
            '<label class="p86-check-row">' +
              '<input type="checkbox" id="matEd_hidden" />' +
              '<span>Hide from AG suggestions <span class="p86-check-hint">(noise / one-off / wrong)</span></span>' +
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
    window.p86Api.materials.update(id, payload).then(function() {
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
        window.p86Api.materials.importBatch({
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
    else if (name === 'sms') renderAdminSms();
    // 'email-templates' moved into Templates → Email; if a saved nav state
    // points at the old top-level tab, reroute to templates.
    else if (name === 'email-templates') {
      _templatesActiveTab = 'email';
      try { sessionStorage.setItem('agx_templates_tab', 'email'); } catch (e) {}
      switchAdminSubTab('templates');
      return;
    }
    // Persist nav state so a refresh lands back on this admin sub-tab.
    if (typeof window.p86NavSave === 'function') window.p86NavSave();
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

    var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    var toEl = document.getElementById('email-test-to');
    if (me && me.email && toEl) toEl.value = me.email;

    document.getElementById('email-test-send').addEventListener('click', function() {
      var to = document.getElementById('email-test-to').value.trim();
      if (!to) { alert('Enter a recipient email.'); return; }
      var resultEl = document.getElementById('email-test-result');
      resultEl.innerHTML = '<span style="color:#60a5fa;">Sending…</span>';
      window.p86Api.post('/api/email/test', { to: to }).then(function(r) {
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
      window.p86Api.get('/api/email/events'),
      window.p86Api.get('/api/email/settings')
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
            '<label class="p86-switch" style="display:inline-flex;align-items:center;cursor:pointer;">' +
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
        var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
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
        window.p86Api.post('/api/email/templates/' + encodeURIComponent(key) + '/test', { to: to, as_test: false })
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

  // Project 86-styled two-card chooser. Returns a Promise resolving to
  // 'new' | 'existing' | null. Mirrors p86Confirm\'s overlay styling
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
  // alpha word + a 4-digit suffix (e.g. "p86-bird-7384"). Easier to
  // type than a random string for the user\'s first login; admin
  // tells them to change it after.
  function genTempPassword() {
    var words = ['bird', 'oak', 'pine', 'lark', 'wren', 'finch', 'sage', 'fern', 'dawn', 'mist'];
    var w = words[Math.floor(Math.random() * words.length)];
    var n = String(Math.floor(1000 + Math.random() * 9000));
    return 'p86-' + w + '-' + n;
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
      window.p86Api.users.resetPassword(target.id, tempPwd).then(function() {
        alert('✓ Sent to ' + target.email + '.\n\nTemp password: ' + tempPwd + '\n\nThe email contents use the password_reset template so the wording is accurate for an existing account.');
      }).catch(function(err) {
        alert('Send failed: ' + (err.message || 'unknown'));
      });
    };
    if (!_users || !_users.length) {
      window.p86Api.users.list().then(function(r) {
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
      window.p86Api.users.resetPassword(target.id, newPwd).then(function() {
        alert('✓ Reset and emailed to ' + target.email + '.\n\nNew password: ' + newPwd);
      }).catch(function(err) {
        alert('Reset failed: ' + (err.message || 'unknown'));
      });
    };
    // Ensure the user list is loaded.
    if (!_users || !_users.length) {
      window.p86Api.users.list().then(function(r) {
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
      window.p86Api.put('/api/email/settings', _emailSettings).then(function(r) {
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
    window.p86Api.get(url).then(function(r) {
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
    window.p86Api.get('/api/email/templates').then(function(r) {
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
    window.p86Api.get('/api/email/templates/' + encodeURIComponent(eventKey)).then(function(r) {
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
    window.p86Api.put('/api/email/templates/' + encodeURIComponent(_templateActiveKey), {
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
    var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    var defaultTo = me && me.email ? me.email : '';
    var to = prompt('Send test of "' + (_templateDetail && _templateDetail.event && _templateDetail.event.label || _templateActiveKey) + '" to:', defaultTo);
    if (!to) return;
    var status = document.getElementById('email-tpl-status');
    if (status) status.innerHTML = '<span style="color:#60a5fa;">Sending test to ' + escapeHTML(to) + '…</span>';
    window.p86Api.post('/api/email/templates/' + encodeURIComponent(_templateActiveKey) + '/test', { to: to }).then(function(r) {
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
    window.p86Api.del('/api/email/templates/' + encodeURIComponent(_templateActiveKey)).then(function() {
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
      window.p86Api.settings.get('proposal_template').catch(function() { return null; }),
      window.p86Api.settings.get('bt_export_mapping').catch(function() { return null; })
      // agent_skills loads independently from Admin → Agents → Skills now.
    ]).then(function(results) {
      _templateDraft = (results[0] && results[0].setting && results[0].setting.value) || {};
      _btMappingDraft = (results[1] && results[1].setting && results[1].setting.value) || { categories: {}, fallback: {} };
      // Phase D: mapping is just costCode per category. Pre-fill with
      // sensible defaults if the saved value is blank — covers both
      // brand-new installs AND legacy mappings whose costCode was
      // never set (it used to be '' by default in the seed).
      var BT_DEFAULTS = {
        materials: 'Materials & Supplies Costs',
        labor:     'Direct Labor',
        gc:        'General Conditions',
        sub:       'Subcontractors Costs'
      };
      if (!_btMappingDraft.categories) _btMappingDraft.categories = {};
      Object.keys(BT_DEFAULTS).forEach(function(k) {
        var c = _btMappingDraft.categories[k] || {};
        _btMappingDraft.categories[k] = { costCode: c.costCode || BT_DEFAULTS[k] };
      });
      var fb = _btMappingDraft.fallback || {};
      _btMappingDraft.fallback = { costCode: fb.costCode || 'General Conditions' };
      // Strip the old income block if present — Phase D drops it.
      if (_btMappingDraft.income) delete _btMappingDraft.income;
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
  // Renders the editable form for the bt_export_mapping setting. As of
  // the new BT proposal-import format (Phase D), the mapping is just
  // btCategory -> BT Cost Code (one string per category). The old
  // Parent Group / Subgroup / Cost Type fields and the auto-injected
  // Service & Repair Income line are gone — pure cost lines at real
  // markups now.
  var BT_CATEGORY_LABELS = {
    materials: 'Materials & Supplies',
    labor:     'Direct Labor',
    gc:        'General Conditions',
    sub:       'Subcontractors'
  };
  // BT cost code dropdown values (copy/pasted from Buildertrend's
  // Cost code picker so they match exactly).
  var BT_COST_CODE_OPTIONS = [
    'Buildertrend Flat Rate',
    'Direct Labor',
    'General Conditions',
    'Materials & Supplies Costs',
    'Renovation Income',
    'Residential Income',
    'Service & Repair Income',
    'Subcontractors Costs'
  ];

  function renderBTMappingHTML() {
    var bt = _btMappingDraft || {};
    var cats = bt.categories || {};
    var html = '';
    html += '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">';
    html += '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Buildertrend Export Mapping</legend>';
    html += '<p style="margin:0 0 10px 0;color:var(--text-dim,#888);font-size:12px;">' +
      'Drives the <strong>Export to Buildertrend</strong> xlsx. Each Project 86 cost category maps to one BT <strong>Cost Code</strong>. ' +
      'Section flat-$ markups, estimate fees, and tax are pro-rata distributed onto each line\'s markup so the export total matches the proposal exactly — no more auto-injected income line or -100% workaround.' +
      '</p>';

    function costCodeSelect(currentVal, dataAttrs) {
      var s = '<select ' + dataAttrs + ' style="width:100%;">';
      s += '<option value="">— Select —</option>';
      BT_COST_CODE_OPTIONS.forEach(function (opt) {
        var sel = (opt === currentVal) ? ' selected' : '';
        s += '<option value="' + escapeHTML(opt) + '"' + sel + '>' + escapeHTML(opt) + '</option>';
      });
      s += '</select>';
      return s;
    }

    // Per-category rows
    Object.keys(BT_CATEGORY_LABELS).forEach(function (key) {
      var c = cats[key] || {};
      html += '<div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:8px;">';
      html += '<div style="flex:0 0 200px;font-size:12px;font-weight:700;color:#4f8cff;">' +
        escapeHTML(BT_CATEGORY_LABELS[key]) +
        ' <span style="color:var(--text-dim,#888);font-weight:400;font-size:11px;">(' + key + ')</span></div>';
      html += '<div style="flex:1;">' +
        costCodeSelect(c.costCode || '', 'data-bt-cat="' + key + '" data-bt-field="costCode"') +
        '</div>';
      html += '</div>';
    });

    // Fallback bucket — lines with no tagged section header
    var fb = bt.fallback || {};
    html += '<div style="display:flex;align-items:center;gap:12px;border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:0;background:rgba(251,191,36,0.04);">';
    html += '<div style="flex:0 0 200px;font-size:12px;font-weight:700;color:#fbbf24;">Fallback <span style="color:var(--text-dim,#888);font-weight:400;font-size:11px;">(untagged lines)</span></div>';
    html += '<div style="flex:1;">' +
      costCodeSelect(fb.costCode || '', 'data-bt-fb-field="costCode"') +
      '</div>';
    html += '</div>';

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
  // assignment value stays 'cra'. 86's key is 'job' (matches its
  // entity_type) — assignments target the job-side analyst.
  // (Display rename: AG→47, Elle→86. Underlying agent_keys
  // ag / job / cra / staff stay the same to avoid a DB migration;
  // only the user-facing labels change. The 'intake' key was
  // retired — 86 owns lead-intake now; intake sessions still use
  // entity_type='intake' as a label, but agent_key='job'.)
  var AGENT_LABELS = {
    ag:  '47 (Estimator)',
    job: '86 (Lead Agent)',
    cra: 'HR (86\'s Assistant)'
  };

  function renderAgentSkillsHTML() {
    if (!_skillsDraft || !Array.isArray(_skillsDraft.skills)) _skillsDraft = { skills: [] };
    var html = '';
    html += '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-bottom:14px;">';
    html += '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Agent Skill Packs</legend>';
    html += '<p style="margin:0 0 10px 0;color:var(--text-dim,#888);font-size:12px;">' +
      'Reusable instruction blocks loaded into the in-app AI agents at chat time. Use these to teach Project 86-specific workflows, pricing rules, slotting preferences, and common-scope playbooks. ' +
      '<strong>Always-on</strong> skills get appended to the agent\'s system prompt on every turn (token cost: a few hundred each).' +
      '</p>';

    if (!_skillsDraft.skills.length) {
      html += '<div style="padding:14px;text-align:center;color:var(--text-dim,#888);border:1px dashed var(--border,#333);border-radius:6px;font-size:12px;">' +
        'No skill packs yet. Click <strong>+ Add Skill</strong> below to create one.' +
      '</div>';
    } else {
      _skillsDraft.skills.forEach(function(skill, idx) {
        var agents = Array.isArray(skill.agents) ? skill.agents : [];
        html += '<div data-skill-idx="' + idx + '" style="border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;margin-bottom:10px;background:rgba(255,255,255,0.015);opacity:0.92;">';
        // Anthropic-side sync badge / button. When the pack has a
        // mirrored skill, show the id + an Unsync option. Otherwise
        // show a Sync button. Idx is the pack's array position;
        // server treats it as the addressable handle.
        var syncBadge;
        if (skill.anthropic_skill_id) {
          syncBadge = '<span title="Mirrored to Anthropic native Skills (' + escapeAttr(skill.anthropic_skill_id) + ')" style="display:inline-flex;align-items:center;gap:4px;background:rgba(52,211,153,0.12);color:#34d399;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">&#x1F310; Synced</span>' +
            ' <button class="ee-btn ee-icon-btn ghost" onclick="unsyncSkillFromAnthropic(' + idx + ')" title="Delete the Anthropic-side mirror so the next sync uploads a fresh copy" style="font-size:11px;padding:2px 6px;">&#x21BA;</button>';
        } else {
          syncBadge = '<button class="ee-btn secondary" onclick="syncSkillToAnthropic(' + idx + ')" title="Mirror this pack to Anthropic native Skills" style="font-size:11px;padding:2px 8px;">&#x1F310; Mirror</button>';
        }
        html += '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
          '<input type="text" data-skill-name="' + idx + '" value="' + escapeHTML(skill.name || '') + '" placeholder="Skill name (e.g., Project 86 Estimating Playbook)" style="flex:1;font-weight:600;" />' +
          syncBadge +
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
        // "Replaces section" dropdown — when set, the pack body substitutes
        // for a named block in the agent's stable prefix instead of being
        // appended at the end. Options come from the agent(s) checked above.
        // Show only sections whose .agent matches at least one selected agent.
        var sectionOpts = '<option value="">(append at end — default)</option>';
        var seenIds = {};
        agents.forEach(function(a) {
          var list = _overridableSections[a] || [];
          list.forEach(function(s) {
            if (seenIds[s.id]) return;
            seenIds[s.id] = true;
            var sel = (skill.replaces_section === s.id) ? ' selected' : '';
            sectionOpts += '<option value="' + escapeAttr(s.id) + '"' + sel + '>' + escapeHTML(s.id) + ' — ' + escapeHTML(s.description) + '</option>';
          });
        });
        html += '<div style="margin-bottom:8px;font-size:11px;color:var(--text-dim,#aaa);">' +
          '<label style="display:block;margin-bottom:3px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;">Replaces section <span style="color:var(--text-dim,#666);">(optional — overrides a named block of the agent\'s stable prefix instead of appending)</span></label>' +
          '<select data-skill-replaces="' + idx + '" style="width:100%;font-size:12px;padding:5px 8px;font-family:\'SF Mono\',monospace;">' + sectionOpts + '</select>' +
        '</div>';

        // Category + Triggers row — categorize packs (purely metadata
        // for organization) and conditionally load via simple triggers.
        var catOpts = '<option value="">(uncategorized)</option>';
        var cats = ['identity', 'tone', 'slotting', 'pricing', 'tool-guidance', 'domain-knowledge', 'workflow', 'playbook', 'other'];
        cats.forEach(function(c) {
          catOpts += '<option value="' + c + '"' + (skill.category === c ? ' selected' : '') + '>' + c + '</option>';
        });
        var trigs = (skill.triggers && typeof skill.triggers === 'object') ? skill.triggers : {};
        html += '<div style="display:flex;gap:8px;margin-bottom:8px;font-size:11px;color:var(--text-dim,#aaa);">' +
          '<div style="flex:1;"><label style="display:block;margin-bottom:3px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;">Category</label>' +
            '<select data-skill-category="' + idx + '" style="width:100%;font-size:12px;padding:5px 8px;">' + catOpts + '</select></div>' +
          '<div style="width:140px;"><label style="display:block;margin-bottom:3px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;" title="Load only when the estimate has at least N groups. Saves tokens on simple turns.">Min groups</label>' +
            '<input type="number" min="0" max="20" data-skill-trig-min-groups="' + idx + '" value="' + (trigs.min_groups != null ? trigs.min_groups : '') + '" placeholder="—" style="width:100%;font-size:12px;padding:5px 8px;" /></div>' +
          '<div style="width:120px;align-self:end;display:flex;gap:8px;padding-bottom:6px;">' +
            '<label style="display:inline-flex;align-items:center;gap:4px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;cursor:pointer;" title="Load only when the estimate is linked to a lead.">' +
              '<input type="checkbox" data-skill-trig-has-lead="' + idx + '"' + (trigs.has_lead ? ' checked' : '') + ' style="margin:0;" /> has lead</label>' +
            '<label style="display:inline-flex;align-items:center;gap:4px;text-transform:none !important;letter-spacing:normal !important;font-weight:400 !important;cursor:pointer;" title="Load only when the estimate is linked to a client.">' +
              '<input type="checkbox" data-skill-trig-has-client="' + idx + '"' + (trigs.has_client ? ' checked' : '') + ' style="margin:0;" /> has client</label>' +
          '</div>' +
        '</div>';
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
      var replacesEl = document.querySelector('[data-skill-replaces="' + idx + '"]');
      if (nameEl) skill.name = nameEl.value;
      if (bodyEl) skill.body = bodyEl.value;
      if (alwaysOnEl) skill.alwaysOn = !!alwaysOnEl.checked;
      if (replacesEl) {
        // Empty option = append-at-end mode; clear the field.
        var v = replacesEl.value || '';
        if (v) skill.replaces_section = v;
        else delete skill.replaces_section;
      }
      var catEl = document.querySelector('[data-skill-category="' + idx + '"]');
      if (catEl) {
        var c = catEl.value || '';
        if (c) skill.category = c;
        else delete skill.category;
      }
      // Triggers — only persist non-empty values so packs without
      // triggers stay clean in the JSONB blob.
      var trig = {};
      var minGroupsEl = document.querySelector('[data-skill-trig-min-groups="' + idx + '"]');
      if (minGroupsEl && minGroupsEl.value !== '') {
        var n = Number(minGroupsEl.value);
        if (isFinite(n) && n >= 0) trig.min_groups = n;
      }
      var hasLeadEl = document.querySelector('[data-skill-trig-has-lead="' + idx + '"]');
      if (hasLeadEl && hasLeadEl.checked) trig.has_lead = true;
      var hasClientEl = document.querySelector('[data-skill-trig-has-client="' + idx + '"]');
      if (hasClientEl && hasClientEl.checked) trig.has_client = true;
      if (Object.keys(trig).length) skill.triggers = trig;
      else delete skill.triggers;
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
    if (!_btMappingDraft) _btMappingDraft = { categories: {}, fallback: {} };
    if (!_btMappingDraft.categories) _btMappingDraft.categories = {};
    if (!_btMappingDraft.fallback) _btMappingDraft.fallback = {};
    document.querySelectorAll('[data-bt-cat]').forEach(function (el) {
      var k = el.getAttribute('data-bt-cat');
      var f = el.getAttribute('data-bt-field');
      if (!_btMappingDraft.categories[k]) _btMappingDraft.categories[k] = {};
      _btMappingDraft.categories[k][f] = el.value;
    });
    document.querySelectorAll('[data-bt-fb-field]').forEach(function (el) {
      var f = el.getAttribute('data-bt-fb-field');
      _btMappingDraft.fallback[f] = el.value;
    });
    // The Phase-D form drops the Service & Repair Income block. Strip
    // any stale `income` field from the draft so the saved JSON matches
    // the new schema (no orphan keys lingering from the old shape).
    if (_btMappingDraft.income) delete _btMappingDraft.income;
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
      window.p86Api.settings.put('proposal_template', _templateDraft),
      window.p86Api.settings.put('bt_export_mapping', _btMappingDraft)
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
    return window.p86Api.roles.capabilities().then(function(res) {
      _capsMeta = res.capabilities || [];
      return _capsMeta;
    });
  }

  function loadRolesCache() {
    return window.p86Api.roles.list().then(function(res) {
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
      ? window.p86Api.roles.update(origName, { label: label, description: description, capabilities: caps })
      : window.p86Api.roles.create({ name: name, label: label, description: description, capabilities: caps });

    p.then(function() {
      statusEl.style.color = '#34d399';
      statusEl.textContent = 'Saved.';
      // Refresh the current user's capability set in case they edited their
      // own role (e.g. admin removed their own ROLES_MANAGE — server lock-in
      // is the next safety, but reflect the new state in the UI now).
      if (window.p86Auth && window.p86Auth.reloadCapabilities) window.p86Auth.reloadCapabilities();
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
    window.p86Api.roles.remove(name).then(function() {
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
    if (window.p86Api && window.p86Api.isAuthenticated && window.p86Api.isAuthenticated()) {
      window.p86Api.get('/api/auth/active-users').then(function(r) {
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
    window.p86Api.users.remove(userId)
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
  var _agentsView = 'metrics'; // 'metrics' | 'conversations' | 'evals' | 'skills' | 'preview'
  var _agentsConvKey = null;   // when drilled into one conversation
  var _agentsEvalId = null;    // when drilled into one eval's run history
  var _agentsEvalNew = false;  // when the new-eval fixture form is showing
  var _previewAgent = 'ag';    // last-used agent in the prompt preview view
  var _previewEntityId = '';   // last-used entity id (estimate / job)
  var _batchJobId = null;      // when drilled into a single batch's results

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
          '<button class="ws-right-tab' + (_agentsView === 'preview' ? ' active' : '') + '" onclick="switchAgentsView(\'preview\')">&#x1F50D; Prompt Preview</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'batch' ? ' active' : '') + '" onclick="switchAgentsView(\'batch\')">&#x1F4E6; Batch</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'anthropic' ? ' active' : '') + '" onclick="switchAgentsView(\'anthropic\')">&#x1F310; Anthropic</button>' +
          '<button class="ws-right-tab' + (_agentsView === 'references' ? ' active' : '') + '" onclick="switchAgentsView(\'references\')">&#x1F4D2; References</button>' +
        '</div>' +
        '<div style="flex:1;"></div>' +
        '<button class="ee-btn" onclick="openChiefOfStaff()" title="Open the Chief of Staff agent — observes 47 / 86 / HR / Intake, audits conversations, reviews skill packs" style="background:linear-gradient(135deg,#fbbf24,#f97316);color:#fff;border:none;font-weight:600;">&#x1F3A9; Ask Chief of Staff</button>' +
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
    else if (_agentsView === 'preview')              renderPromptPreview();
    else if (_agentsView === 'batch' && _batchJobId) renderBatchJobDetail(_batchJobId);
    else if (_agentsView === 'batch')                renderBatchJobsList();
    else if (_agentsView === 'anthropic')            renderAnthropicResources();
    else if (_agentsView === 'references')           renderReferenceLinksView();
    else if (_agentsConvKey)                         renderAgentsConversationDetail(_agentsConvKey);
    else                                             renderAgentsConversationList();
  }

  // ─────────── Reference Links view ───────────
  // Admin-managed list of SharePoint / OneDrive XLSX share URLs that
  // the agents see in their system prompt. Each row shows last-fetch
  // status + row count + lets the admin refresh / preview / edit /
  // delete. New rows kick off an immediate background fetch.
  function renderReferenceLinksView() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading reference links…</div>';
    window.p86Api.get('/api/admin/agents/reference-links').then(function(resp) {
      var links = (resp && resp.links) || [];
      var rows = links.map(function(l) {
        var statusBadge = '';
        if (l.last_fetch_status === 'ok') {
          statusBadge = '<span style="color:#34d399;">&#x2713; OK</span>';
        } else if (l.last_fetch_status === 'failed') {
          statusBadge = '<span style="color:#f87171;" title="' + escapeAttr(l.last_fetch_error || '') + '">&#x26A0; Failed</span>';
        } else {
          statusBadge = '<span style="color:var(--text-dim,#888);">never fetched</span>';
        }
        var when = l.last_fetched_at
          ? new Date(l.last_fetched_at).toLocaleString()
          : '—';
        var rowCount = l.last_fetched_row_count != null ? l.last_fetched_row_count : '—';
        var enabledChip = l.enabled
          ? '<span style="color:#34d399;font-size:11px;">enabled</span>'
          : '<span style="color:var(--text-dim,#888);font-size:11px;">disabled</span>';
        return '<tr>' +
          '<td style="padding:8px 10px;font-weight:600;">' + escapeHTML(l.title) +
            (l.description ? '<div style="font-size:11px;color:var(--text-dim,#888);font-weight:400;margin-top:2px;">' + escapeHTML(l.description) + '</div>' : '') +
          '</td>' +
          '<td style="padding:8px 10px;font-family:monospace;font-size:11px;color:var(--text-dim,#aaa);max-width:280px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="' + escapeAttr(l.url) + '">' +
            '<a href="' + escapeAttr(l.url) + '" target="_blank" rel="noopener">' + escapeHTML(l.url.slice(0, 60) + (l.url.length > 60 ? '…' : '')) + '</a>' +
          '</td>' +
          '<td style="padding:8px 10px;text-align:center;">' + enabledChip + '</td>' +
          '<td style="padding:8px 10px;text-align:center;">' + statusBadge + '</td>' +
          '<td style="padding:8px 10px;text-align:right;font-family:monospace;">' + rowCount + '</td>' +
          '<td style="padding:8px 10px;color:var(--text-dim,#888);font-size:11px;white-space:nowrap;">' + escapeHTML(when) + '</td>' +
          '<td style="padding:8px 10px;text-align:right;white-space:nowrap;">' +
            '<button class="ee-btn ghost" onclick="refreshReferenceLink(\'' + escapeAttr(l.id) + '\')" style="font-size:11px;padding:3px 8px;">&#x21BB; Refresh</button> ' +
            '<button class="ee-btn ghost" onclick="previewReferenceLink(\'' + escapeAttr(l.id) + '\')" style="font-size:11px;padding:3px 8px;">&#x1F441; Preview</button> ' +
            '<button class="ee-btn ghost" onclick="editReferenceLink(\'' + escapeAttr(l.id) + '\')" style="font-size:11px;padding:3px 8px;">&#x270F; Edit</button> ' +
            '<button class="ee-btn ghost" onclick="deleteReferenceLink(\'' + escapeAttr(l.id) + '\')" style="font-size:11px;padding:3px 8px;color:#f87171;">&#x1F5D1; Delete</button>' +
          '</td>' +
        '</tr>';
      }).join('');
      var empty = '<tr><td colspan="7" style="padding:30px;text-align:center;color:var(--text-dim,#888);font-style:italic;">' +
        'No reference links yet. Add a SharePoint share URL to make a live sheet (job numbers, WIP report, etc.) visible to every agent.' +
      '</td></tr>';
      host.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;">' +
          '<div>' +
            '<div style="font-size:13px;font-weight:600;color:var(--text);">Live reference sheets</div>' +
            '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">SharePoint / OneDrive share URLs (set to &ldquo;Anyone with the link &rarr; Can view&rdquo;). The server fetches each every 15 min and injects the parsed rows into every agent\'s system prompt.</div>' +
          '</div>' +
          '<button class="ee-btn primary" onclick="openReferenceLinkEditor()">&#x2795; Add link</button>' +
        '</div>' +
        '<div style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;">' +
          '<table style="width:100%;border-collapse:collapse;font-size:13px;">' +
            '<thead style="background:rgba(255,255,255,0.03);border-bottom:1px solid var(--border,#333);">' +
              '<tr>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">Title</th>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">URL</th>' +
                '<th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">Active</th>' +
                '<th style="padding:8px 10px;text-align:center;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">Status</th>' +
                '<th style="padding:8px 10px;text-align:right;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">Rows</th>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;color:var(--text-dim,#888);">Last fetched</th>' +
                '<th style="padding:8px 10px;text-align:right;"></th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + (rows || empty) + '</tbody>' +
          '</table>' +
        '</div>';
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#f87171;padding:20px 0;">Failed to load reference links: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function openReferenceLinkEditor(existing) {
    var prior = document.getElementById('refLinkEditorModal');
    if (prior) prior.remove();
    var modal = document.createElement('div');
    modal.id = 'refLinkEditorModal';
    modal.className = 'modal active';
    var l = existing || {};
    modal.innerHTML =
      '<div class="modal-content" style="max-width:560px;">' +
        '<div class="modal-header">' + (existing ? 'Edit reference link' : 'Add reference link') + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div><label style="font-size:11px;font-weight:600;color:var(--text-dim,#888);">Title</label>' +
            '<input type="text" id="refLink_title" value="' + escapeAttr(l.title || '') + '" placeholder="e.g., WIP Report" style="width:100%;padding:7px 10px;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;" /></div>' +
          '<div><label style="font-size:11px;font-weight:600;color:var(--text-dim,#888);">SharePoint / OneDrive share URL</label>' +
            '<input type="text" id="refLink_url" value="' + escapeAttr(l.url || '') + '" placeholder="https://tenant.sharepoint.com/:x:/g/personal/.../...?e=..." style="width:100%;padding:7px 10px;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;font-family:monospace;font-size:11px;" />' +
            '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:4px;line-height:1.4;">Set the share to &ldquo;Anyone with the link &rarr; Can view&rdquo; in SharePoint. The server appends &amp;download=1 to fetch the XLSX directly.</div></div>' +
          '<div><label style="font-size:11px;font-weight:600;color:var(--text-dim,#888);">Description (shown to agents)</label>' +
            '<textarea id="refLink_description" rows="2" placeholder="What\'s in this sheet? When should agents look here?" style="width:100%;padding:7px 10px;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;">' + escapeHTML(l.description || '') + '</textarea></div>' +
          '<div style="display:flex;gap:14px;">' +
            '<div style="flex:1;"><label style="font-size:11px;font-weight:600;color:var(--text-dim,#888);">Max rows</label>' +
              '<input type="number" id="refLink_maxRows" value="' + (l.max_rows || 200) + '" min="10" max="2000" style="width:100%;padding:7px 10px;background:var(--input-bg);color:var(--text);border:1px solid var(--border);border-radius:6px;" /></div>' +
            '<div style="flex:1;"><label class="p86-check-row" style="margin-top:18px;">' +
              '<input type="checkbox" id="refLink_enabled" ' + (l.enabled !== false ? 'checked' : '') + ' />' +
              '<span style="font-size:12px;">Active (visible to agents)</span></label></div>' +
          '</div>' +
        '</div>' +
        '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button class="ee-btn secondary" onclick="closeReferenceLinkEditor()">Cancel</button>' +
          '<button class="ee-btn primary" onclick="saveReferenceLink(' + (existing ? '\'' + escapeAttr(l.id) + '\'' : 'null') + ')">' + (existing ? 'Save' : 'Add') + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) closeReferenceLinkEditor(); });
  }
  function closeReferenceLinkEditor() {
    var m = document.getElementById('refLinkEditorModal');
    if (m) m.remove();
  }
  function saveReferenceLink(existingId) {
    var payload = {
      title: document.getElementById('refLink_title').value.trim(),
      url: document.getElementById('refLink_url').value.trim(),
      description: document.getElementById('refLink_description').value.trim(),
      enabled: document.getElementById('refLink_enabled').checked,
      maxRows: parseInt(document.getElementById('refLink_maxRows').value, 10) || 200
    };
    if (!payload.title || !payload.url) {
      alert('Title and URL are required.');
      return;
    }
    var p = existingId
      ? window.p86Api.put('/api/admin/agents/reference-links/' + encodeURIComponent(existingId), payload)
      : window.p86Api.post('/api/admin/agents/reference-links', payload);
    // p86Api doesn't have a generic patch helper, so fall back to fetch
    // for the update branch.
    if (existingId) {
      p = fetch('/api/admin/agents/reference-links/' + encodeURIComponent(existingId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) },
        body: JSON.stringify(payload)
      }).then(function(r) { return r.json(); });
    }
    p.then(function() {
      closeReferenceLinkEditor();
      renderReferenceLinksView();
    }).catch(function(err) {
      alert('Save failed: ' + (err.message || err));
    });
  }
  function editReferenceLink(id) {
    window.p86Api.get('/api/admin/agents/reference-links').then(function(resp) {
      var l = (resp.links || []).find(function(x) { return x.id === id; });
      if (l) openReferenceLinkEditor(l);
    });
  }
  function deleteReferenceLink(id) {
    if (!confirm('Delete this reference link? Agents will stop seeing this sheet on the next turn.')) return;
    window.p86Api.del('/api/admin/agents/reference-links/' + encodeURIComponent(id)).then(function() {
      renderReferenceLinksView();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || err));
    });
  }
  function refreshReferenceLink(id) {
    var btn = event && event.target;
    if (btn) { btn.disabled = true; btn.textContent = '…'; }
    window.p86Api.post('/api/admin/agents/reference-links/' + encodeURIComponent(id) + '/refresh', {}).then(function() {
      renderReferenceLinksView();
    }).catch(function(err) {
      alert('Refresh failed: ' + (err.message || err));
      renderReferenceLinksView();
    });
  }
  function previewReferenceLink(id) {
    window.p86Api.get('/api/admin/agents/reference-links/' + encodeURIComponent(id) + '/preview').then(function(resp) {
      var l = resp.link;
      var prior = document.getElementById('refLinkPreviewModal');
      if (prior) prior.remove();
      var modal = document.createElement('div');
      modal.id = 'refLinkPreviewModal';
      modal.className = 'modal active';
      modal.innerHTML =
        '<div class="modal-content" style="max-width:780px;max-height:80vh;display:flex;flex-direction:column;">' +
          '<div class="modal-header">Preview: ' + escapeHTML(l.title || '') + '</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:8px;">' +
            (l.last_fetched_at ? 'Last fetched ' + new Date(l.last_fetched_at).toLocaleString() : 'never fetched') +
            ' &middot; ' + (l.last_fetched_row_count != null ? l.last_fetched_row_count + ' rows' : '—') +
            ' &middot; status: ' + escapeHTML(l.last_fetch_status || '?') +
          '</div>' +
          '<pre style="flex:1;overflow:auto;font-family:\'SF Mono\',monospace;font-size:11px;line-height:1.5;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;padding:12px;white-space:pre-wrap;">' +
            escapeHTML(l.last_fetched_text || '(no parsed content yet — try Refresh)') +
          '</pre>' +
          '<div class="modal-footer" style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
            '<button class="ee-btn secondary" onclick="document.getElementById(\'refLinkPreviewModal\').remove();">Close</button>' +
          '</div>' +
        '</div>';
      document.body.appendChild(modal);
      modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    }).catch(function(err) {
      alert('Preview failed: ' + (err.message || err));
    });
  }

  // Loads the server's live agent runtime config (model + effort) and
  // renders it as a small badge above the tab bar. Lets the user verify
  // env-var flips (AI_MODEL, AI_EFFORT) without opening a chat — the
  // badge changes immediately on the next page render.
  function loadAgentsServerConfig() {
    var el = document.getElementById('agents-server-config');
    if (!el) return;
    window.p86Api.get('/api/admin/agents/config').then(function(cfg) {
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
    _agentsEvalNew = false;
    _batchJobId = null;
    renderAdminAgents();
  }

  // ─────────── Metrics view ───────────
  function renderAgentsMetrics() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading metrics…</div>';
    window.p86Api.get('/api/admin/agents/metrics?range=' + _agentsRange).then(function(resp) {
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
    window.p86Api.get('/api/admin/agents/conversations?range=' + _agentsRange + '&limit=100').then(function(resp) {
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
        var agentLabel = c.entity_type === 'estimate' ? '🎯 47'
                       : c.entity_type === 'job'      ? '📊 86'
                       : c.entity_type === 'client'   ? '🤝 HR'
                       : c.entity_type === 'intake'   ? '🧲 Intake'
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
    _agentsEvalId = null;
    _agentsEvalNew = false;
    renderAdminAgents();
  }

  // ─────────── Conversation detail view ───────────
  function renderAgentsConversationDetail(key) {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading messages…</div>';
    Promise.all([
      window.p86Api.get('/api/admin/agents/conversations/' + encodeURIComponent(key)),
      window.p86Api.get('/api/admin/agents/conversations/' + encodeURIComponent(key) + '/replays').catch(function() { return { replays: [] }; })
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
    window.p86Api.post('/api/admin/agents/conversations/' + encodeURIComponent(key) + '/replay', {
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
    _agentsEvalNew = false;
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
    // Cache breakdown — surface hit % so admins see whether the
    // ephemeral cache is paying off. Anthropic returns input_tokens
    // EXCLUSIVE of cache_read, so the full input footprint is
    // input_tokens + cache_read_input_tokens. Hit % = read / total input.
    if (m.cache_read_input_tokens || m.cache_creation_input_tokens) {
      var read = Number(m.cache_read_input_tokens || 0);
      var write = Number(m.cache_creation_input_tokens || 0);
      var fullInput = Number(m.input_tokens || 0) + read;
      var hitPct = fullInput > 0 ? Math.round((read / fullInput) * 100) : 0;
      meta.push('cache ' + hitPct + '% hit (' + tokFmt(read) + ' read' + (write ? ', ' + tokFmt(write) + ' written' : '') + ')');
    }
    if (m.tool_use_count)   meta.push(m.tool_use_count + ' tools');
    if (m.photos_included)  meta.push(m.photos_included + ' photos');
    // Loaded skill packs — surfaces conditional/triggered loading and
    // helps spot packs that never fire.
    if (Array.isArray(m.packs_loaded) && m.packs_loaded.length) {
      meta.push(m.packs_loaded.length + ' pack' + (m.packs_loaded.length === 1 ? '' : 's') + ': ' + m.packs_loaded.join(', '));
    }
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
    if (!window.p86AI || typeof window.p86AI.open !== 'function') {
      alert('AI panel not loaded — refresh the page.');
      return;
    }
    window.p86AI.open({ entityType: 'staff' });
  }

  // ─────────── Skills view (mounted on the Agents page) ───────────
  // Reuses the existing skill-pack renderer + draft state from the
  // Templates → Skills surface. The draft (_skillsDraft) is shared
  // between the two surfaces, and saving from either persists to the
  // same app_settings.agent_skills row. We sync inputs into the draft
  // before any view switch so unsaved edits don't get clobbered.
  // ─────────── Prompt Preview view ───────────
  // Shows the EXACT system prompt an agent (47 / 86 / HR / Chief of Staff)
  // would see right now if a chat turn fired against the supplied entity.
  // Three blocks: stable prefix (cached), dynamic context (refreshed each
  // turn), and skill packs (always-on packs that auto-append). Gives the
  // admin the visibility this used to require code-spelunking for.
  function renderPromptPreview() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML =
      '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Assemble the live system prompt an agent would see for a given entity. Lets you spot wasted tokens, confirm a skill pack is loading, and verify which tools the agent has access to in plan vs. build mode.' +
      '</p>' +
      '<div style="display:flex;gap:10px;align-items:end;margin-bottom:14px;flex-wrap:wrap;">' +
        '<div><label style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Agent</label>' +
          '<select id="preview-agent" style="font-size:13px;padding:6px 10px;min-width:160px;">' +
            '<option value="ag"' + (_previewAgent === 'ag' ? ' selected' : '') + '>47 (estimating)</option>' +
            '<option value="elle"' + (_previewAgent === 'elle' ? ' selected' : '') + '>86 (analyst)</option>' +
            '<option value="hr"' + (_previewAgent === 'hr' ? ' selected' : '') + '>HR (clients + user health)</option>' +
            '<option value="cos"' + (_previewAgent === 'cos' ? ' selected' : '') + '>Chief of Staff</option>' +
          '</select></div>' +
        '<div style="flex:1;min-width:240px;"><label id="preview-entity-label" style="display:block;font-size:11px;color:var(--text-dim,#888);margin-bottom:4px;">Entity (estimate / job)</label>' +
          '<select id="preview-entity-id" style="font-size:13px;padding:6px 10px;width:100%;">' +
            '<option value="">— Pick one —</option>' +
          '</select></div>' +
        '<button class="ee-btn primary" onclick="loadPromptPreview()">Assemble Prompt</button>' +
      '</div>' +
      '<div id="preview-result" style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Pick an agent + entity and click Assemble Prompt.</div>';

    // Wire the agent select so the entity dropdown re-populates with
    // estimates or jobs depending on the agent. HR + COS have no entity
    // (system-wide) so the dropdown disables itself.
    var agentSel = document.getElementById('preview-agent');
    var entitySel = document.getElementById('preview-entity-id');
    var entityLabel = document.getElementById('preview-entity-label');
    function populateEntityList(agent) {
      _previewAgent = agent;
      if (agent === 'hr' || agent === 'cos') {
        entitySel.innerHTML = '<option value="">(system-wide — no entity)</option>';
        entitySel.disabled = true;
        entityLabel.textContent = 'Entity (n/a — assembles system-wide prompt)';
        return;
      }
      entitySel.disabled = false;
      if (agent === 'ag') {
        entityLabel.textContent = 'Entity — recent estimates';
        if (window.p86Api && window.p86Api.estimates && typeof window.p86Api.estimates.list === 'function') {
          window.p86Api.estimates.list().then(function(resp) {
            var rows = (resp && resp.estimates) || [];
            rows.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
            rows = rows.slice(0, 80);
            entitySel.innerHTML = '<option value="">— Pick an estimate —</option>' +
              rows.map(function(e) {
                var label = (e.title || '(untitled)') + ' · ' + (e.id ? e.id.slice(-8) : '');
                return '<option value="' + escapeAttr(e.id) + '">' + escapeHTML(label) + '</option>';
              }).join('');
          }).catch(function() { entitySel.innerHTML = '<option value="">(failed to load estimates)</option>'; });
        }
      } else if (agent === 'elle') {
        entityLabel.textContent = 'Entity — recent jobs';
        if (window.p86Api && window.p86Api.jobs && typeof window.p86Api.jobs.list === 'function') {
          window.p86Api.jobs.list().then(function(resp) {
            var rows = (resp && resp.jobs) || [];
            rows.sort(function(a, b) { return (b.updated_at || '').localeCompare(a.updated_at || ''); });
            rows = rows.slice(0, 80);
            entitySel.innerHTML = '<option value="">— Pick a job —</option>' +
              rows.map(function(j) {
                var label = (j.title || j.id || '(untitled)') + ' · ' + (j.id || '').slice(-8);
                return '<option value="' + escapeAttr(j.id) + '">' + escapeHTML(label) + '</option>';
              }).join('');
          }).catch(function() { entitySel.innerHTML = '<option value="">(failed to load jobs)</option>'; });
        }
      }
    }
    if (agentSel) {
      agentSel.addEventListener('change', function() { populateEntityList(agentSel.value); });
      populateEntityList(_previewAgent);
    }
  }

  function loadPromptPreview() {
    var agent = document.getElementById('preview-agent').value;
    var entityId = document.getElementById('preview-entity-id').value;
    var resultHost = document.getElementById('preview-result');
    if (!agent) return;
    if ((agent === 'ag' || agent === 'elle') && !entityId) {
      resultHost.innerHTML = '<div style="color:#fbbf24;font-size:12px;">Pick an entity first.</div>';
      return;
    }
    _previewEntityId = entityId;
    resultHost.innerHTML = '<div style="color:var(--text-dim,#888);font-style:italic;font-size:12px;padding:14px 0;">Assembling…</div>';

    var qs = '?agent=' + encodeURIComponent(agent);
    if (agent === 'ag')   qs += '&estimate_id=' + encodeURIComponent(entityId);
    if (agent === 'elle') qs += '&job_id=' + encodeURIComponent(entityId);

    window.p86Api.get('/api/admin/agents/preview-prompt' + qs).then(function(data) {
      resultHost.innerHTML = renderPreviewPayload(data);
    }).catch(function(err) {
      resultHost.innerHTML = '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function renderPreviewPayload(d) {
    if (!d) return '<div style="color:#e74c3c;">Empty response.</div>';
    var phasePill = d.ai_phase
      ? '<span style="display:inline-block;padding:2px 8px;border-radius:10px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:0.5px;background:' +
          (d.ai_phase === 'plan' ? 'rgba(251,191,36,0.15);color:#fbbf24;' : 'rgba(52,211,153,0.15);color:#34d399;') +
        '">' + escapeHTML(d.ai_phase) + ' mode</span>'
      : '';
    var stableTokens = (d.stable_prefix && d.stable_prefix.tokens) || 0;
    var dynamicTokens = (d.dynamic_context && d.dynamic_context.tokens) || 0;
    var totalTokens = d.total_approx_tokens || (stableTokens + dynamicTokens);
    var cachedPct = totalTokens > 0 ? Math.round((stableTokens / totalTokens) * 100) : 0;

    var summary =
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;background:rgba(79,140,255,0.06);border:1px solid rgba(79,140,255,0.25);border-radius:8px;padding:12px 14px;">' +
        '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Agent</div>' +
          '<div style="font-size:14px;font-weight:600;color:var(--text,#fff);text-transform:capitalize;">' + escapeHTML(d.agent || '') + '</div></div>' +
        '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Entity</div>' +
          '<div style="font-size:13px;color:var(--text,#fff);">' + escapeHTML((d.entity && d.entity.label) || '—') + '</div></div>' +
        (d.ai_phase ? '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Phase</div><div>' + phasePill + '</div></div>' : '') +
        '<div style="margin-left:auto;text-align:right;"><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">~Tokens (cached / total)</div>' +
          '<div style="font-size:13px;color:var(--text,#fff);font-family:\'SF Mono\',monospace;">' +
          stableTokens.toLocaleString() + ' / ' + totalTokens.toLocaleString() + ' (' + cachedPct + '% cacheable)</div></div>' +
      '</div>';

    var toolsBlock =
      '<details open style="margin-bottom:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text,#fff);">' +
          '&#x1F527; Tools (' + (d.tool_count || 0) + ')' +
        '</summary>' +
        '<div style="margin-top:8px;font-size:11px;font-family:\'SF Mono\',monospace;color:var(--text-dim,#aaa);line-height:1.6;">' +
          (Array.isArray(d.tools) && d.tools.length
            ? d.tools.map(function(t) { return escapeHTML(t); }).join(', ')
            : '(no tools)') +
        '</div>' +
      '</details>';

    var packsBlock =
      '<details open style="margin-bottom:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text,#fff);">' +
          '&#x1F9E0; Active skill packs (' + ((d.skill_packs || []).length) + ')' +
        '</summary>' +
        '<div style="margin-top:8px;font-size:12px;color:var(--text-dim,#aaa);">' +
          (Array.isArray(d.skill_packs) && d.skill_packs.length
            ? d.skill_packs.map(function(p) { return '<div>• ' + escapeHTML(p.name) + ' <span style="color:var(--text-dim,#666);font-family:\'SF Mono\',monospace;">~' + p.tokens + ' tokens</span></div>'; }).join('')
            : '<i>(no packs loaded)</i>') +
        '</div>' +
      '</details>';

    var stableBlock =
      '<details style="margin-bottom:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text,#fff);">' +
          '&#x1F4C0; Stable prefix (cached, ~' + stableTokens.toLocaleString() + ' tokens)' +
        '</summary>' +
        '<pre style="margin-top:8px;font-size:11px;color:var(--text-dim,#aaa);white-space:pre-wrap;background:rgba(0,0,0,0.2);padding:10px;border-radius:4px;max-height:500px;overflow:auto;">' +
          escapeHTML((d.stable_prefix && d.stable_prefix.text) || '') +
        '</pre>' +
      '</details>';

    var dynamicBlock =
      '<details style="margin-bottom:10px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:10px 12px;">' +
        '<summary style="cursor:pointer;font-size:13px;font-weight:600;color:var(--text,#fff);">' +
          '&#x267B;&#xFE0F; Dynamic context (refreshed every turn, ~' + dynamicTokens.toLocaleString() + ' tokens)' +
        '</summary>' +
        '<pre style="margin-top:8px;font-size:11px;color:var(--text-dim,#aaa);white-space:pre-wrap;background:rgba(0,0,0,0.2);padding:10px;border-radius:4px;max-height:500px;overflow:auto;">' +
          escapeHTML((d.dynamic_context && d.dynamic_context.text) || '') +
        '</pre>' +
      '</details>';

    var cacheNote = '<div style="margin-top:6px;font-size:11px;color:var(--text-dim,#666);">' +
      '<strong>Cache strategy:</strong> ' + escapeHTML(d.cache_strategy || '') + '</div>';

    return summary + toolsBlock + packsBlock + stableBlock + dynamicBlock + cacheNote;
  }

  window.renderPromptPreview = renderPromptPreview;
  window.loadPromptPreview = loadPromptPreview;

  // ─────────── Skill-pack version history ───────────
  // Renders a simple list overlay inside the agents-content host. Each
  // row shows when the snapshot was taken, who saved it, an optional
  // comment, and a Restore button. Restore round-trips through the
  // server which itself snapshots the current value before applying —
  // every restore is itself reversible.
  function openSkillsVersionHistory() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML =
      '<div style="margin-bottom:10px;display:flex;align-items:center;gap:10px;">' +
        '<button class="ee-btn secondary" onclick="renderAgentsSkillsView()">&larr; Back to Skills</button>' +
        '<h3 style="margin:0;font-size:14px;font-weight:600;color:var(--text,#fff);">Skill-pack version history</h3>' +
      '</div>' +
      '<p style="margin:0 0 14px;color:var(--text-dim,#888);font-size:12px;">' +
        'Every save snapshots the prior agent_skills blob. Click Restore to roll back — that itself snapshots the current state first, so every restore is reversible.' +
      '</p>' +
      '<div id="skills-versions-list" style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';

    window.p86Api.get('/api/admin/agents/skills/versions').then(function(resp) {
      var rows = (resp && resp.versions) || [];
      var listHost = document.getElementById('skills-versions-list');
      if (!listHost) return;
      if (!rows.length) {
        listHost.innerHTML = '<div style="color:var(--text-dim,#888);font-style:italic;padding:14px 0;">No saved versions yet. Save a skill-pack edit and the prior state lands here.</div>';
        return;
      }
      var html = '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr>' +
          '<th>Saved at</th><th>Saved by</th><th>Comment</th><th style="text-align:right;">Packs</th><th></th>' +
        '</tr></thead><tbody>';
      rows.forEach(function(v) {
        var when = '';
        try { when = new Date(v.saved_at).toLocaleString(); } catch (e) {}
        var who = v.saved_by_name ? escapeHTML(v.saved_by_name) : '<span style="color:var(--text-dim,#666);font-style:italic;">unknown</span>';
        html += '<tr>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
          '<td>' + who + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + (v.comment ? escapeHTML(v.comment) : '<span style="color:var(--text-dim,#666);">—</span>') + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;">' + (v.skill_count || 0) + '</td>' +
          '<td style="text-align:right;">' +
            '<button class="ee-btn secondary" onclick="viewSkillsVersion(' + v.id + ')">View</button>' +
            ' <button class="ee-btn primary" onclick="restoreSkillsVersion(' + v.id + ')">Restore</button>' +
          '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      listHost.innerHTML = html;
    }).catch(function(err) {
      var listHost = document.getElementById('skills-versions-list');
      if (listHost) listHost.innerHTML = '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function viewSkillsVersion(id) {
    window.p86Api.get('/api/admin/agents/skills/versions/' + encodeURIComponent(id)).then(function(resp) {
      var v = resp && resp.version;
      if (!v) { alert('Version not found.'); return; }
      var pretty = '';
      try { pretty = JSON.stringify(v.value, null, 2); } catch (e) { pretty = String(v.value); }
      // Open in a new window so the user can compare side-by-side with
      // the live editor without leaving the admin tab.
      var w = window.open('', '_blank', 'width=800,height=900');
      if (!w) { alert('Popup blocked. Allow popups for this domain to view version contents.'); return; }
      w.document.write('<!doctype html><html><head><title>agent_skills version ' + id + '</title></head><body style="font-family:\'SF Mono\',Menlo,monospace;font-size:12px;background:#0f1117;color:#e4e6f0;padding:20px;"><h2>Version ' + id + '</h2><pre style="white-space:pre-wrap;">' + escapeHTML(pretty) + '</pre></body></html>');
      w.document.close();
    }).catch(function(err) { alert('Failed: ' + (err.message || 'unknown')); });
  }

  function restoreSkillsVersion(id) {
    if (!confirm('Restore version ' + id + '? Current state will be auto-snapshotted before applying.')) return;
    window.p86Api.post('/api/admin/agents/skills/versions/' + encodeURIComponent(id) + '/restore', {}).then(function() {
      alert('Restored. Reloading skills view.');
      switchAgentsView('skills');
    }).catch(function(err) { alert('Restore failed: ' + (err.message || 'unknown')); });
  }

  window.openSkillsVersionHistory = openSkillsVersionHistory;
  window.viewSkillsVersion = viewSkillsVersion;
  window.restoreSkillsVersion = restoreSkillsVersion;

  // ─────────── Batch audits view ───────────
  // Lists submitted Anthropic batches (currently 86 nightly audits)
  // with status pills + click-into-details. Auto-polls non-terminal
  // batches on every render so the UI walks itself forward.
  function renderBatchJobsList() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML =
      '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Anthropic Batch API jobs — proactive analyses that run async at half the synchronous cost. Currently supports 86 audits across every active job.' +
      '</p>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">' +
        '<button class="ee-btn primary" onclick="submitElleAuditBatch()" title="Build one 86 audit per active job and submit as a single Anthropic batch.">&#x1F50D; Run 86 audit on every active job</button>' +
        '<button class="ee-btn secondary" onclick="renderBatchJobsList()">&#x21BB; Refresh</button>' +
      '</div>' +
      '<div id="batch-jobs-list" style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>' +
      // Files API panel — sits below the batch list since both are
      // "infrastructure" admin actions that don't fit the conversation
      // log model.
      '<div style="margin-top:24px;padding:14px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:8px;">' +
        '<h3 style="margin:0 0 6px 0;font-size:13px;color:var(--text,#fff);">&#x1F4C2; Anthropic Files cache</h3>' +
        '<p style="margin:0 0 10px 0;color:var(--text-dim,#888);font-size:11px;">' +
          'When 47 references a photo across multiple chat turns, currently the photo gets base64-encoded into the request every turn. Uploading once to Anthropic\'s Files API lets future turns reference the photo by id (cheaper, faster). Stats below; click to upload recent images.' +
        '</p>' +
        '<div id="files-stats-host" style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>' +
        '<div style="margin-top:10px;">' +
          '<button class="ee-btn secondary" onclick="uploadRecentPhotos(25)">Upload last 25 not-yet-uploaded images</button>' +
        '</div>' +
        '<p style="margin:8px 0 0 0;color:var(--text-dim,#666);font-size:10px;">' +
          'Note: 47\'s chat path still uses base64 for now. Switching loadPhotoAsBlock to file_id references requires migrating chat from messages.stream() to beta.messages.stream() — that\'s a separate commit. The upload pipeline above sets up the cache in advance so the chat switch is a one-line change later.' +
        '</p>' +
      '</div>';

    window.p86Api.get('/api/admin/files/stats').then(function(s) {
      var host = document.getElementById('files-stats-host');
      if (!host) return;
      host.innerHTML =
        '<span style="font-family:\'SF Mono\',monospace;color:var(--text,#fff);">' +
          (s.uploaded || 0) + ' / ' + (s.total_images || 0) + ' images uploaded' +
          (s.not_uploaded ? ' · <span style="color:#fbbf24;">' + s.not_uploaded + ' pending</span>' : ' · <span style="color:#34d399;">all cached</span>') +
        '</span>';
    }).catch(function() { /* stats are decorative; failures fine */ });

    window.p86Api.get('/api/admin/batch/jobs').then(function(resp) {
      var rows = (resp && resp.jobs) || [];
      var listHost = document.getElementById('batch-jobs-list');
      if (!listHost) return;
      if (!rows.length) {
        listHost.innerHTML = '<div style="color:var(--text-dim,#888);font-style:italic;padding:14px 0;">No batches submitted yet. Click "Run 86 audit on every active job" to fire one.</div>';
        return;
      }
      var html = '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr>' +
          '<th>Submitted</th><th>By</th><th>Agent / Kind</th><th>Status</th><th style="text-align:right;">Jobs</th><th></th>' +
        '</tr></thead><tbody>';
      rows.forEach(function(b) {
        var when = '';
        try { when = new Date(b.submitted_at).toLocaleString(); } catch (e) {}
        var pill = batchStatusPill(b.status);
        html += '<tr style="cursor:pointer;" onclick="openBatchJobDetail(\'' + escapeAttr(b.id) + '\')">' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
          '<td>' + (b.submitted_by_name ? escapeHTML(b.submitted_by_name) : '<span style="color:var(--text-dim,#666);font-style:italic;">—</span>') + '</td>' +
          '<td><span style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(b.agent || '?') + ' / ' + escapeHTML(b.kind || '?') + '</span></td>' +
          '<td>' + pill + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;">' + (b.request_count || 0) + '</td>' +
          '<td><button class="ee-btn secondary" type="button" onclick="event.stopPropagation();openBatchJobDetail(\'' + escapeAttr(b.id) + '\')">View</button></td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      listHost.innerHTML = html;
    }).catch(function(err) {
      var listHost = document.getElementById('batch-jobs-list');
      if (listHost) listHost.innerHTML = '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function batchStatusPill(status) {
    var s = String(status || '').toLowerCase();
    var color, bg;
    if (s === 'ended')      { color = '#34d399'; bg = 'rgba(52,211,153,0.15)'; }
    else if (s === 'failed' || s === 'errored') { color = '#f87171'; bg = 'rgba(248,113,113,0.15)'; }
    else                    { color = '#fbbf24'; bg = 'rgba(251,191,36,0.15)'; }
    return '<span style="display:inline-block;padding:2px 8px;border-radius:10px;background:' + bg + ';color:' + color + ';font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">' + escapeHTML(s || 'unknown') + '</span>';
  }

  function submitElleAuditBatch() {
    if (!confirm('Submit a new 86 audit batch?\n\nBuilds one audit prompt per active job (excluding Archived/Completed) and submits as a single Anthropic Batch API job. Costs roughly half a synchronous 86 turn per job. Results land here when the batch finishes (typically minutes, up to 24h).')) return;
    var btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Submitting…'; }
    window.p86Api.post('/api/admin/batch/elle-audit', {}).then(function(resp) {
      alert('✓ Submitted batch ' + resp.batch_job_id + ' covering ' + resp.request_count + ' job' + (resp.request_count === 1 ? '' : 's') + (resp.skipped ? ' (' + resp.skipped + ' skipped on context-build error)' : '') + '. Refresh in a minute or two to see the status.');
      renderBatchJobsList();
    }).catch(function(err) {
      alert('Failed to submit batch: ' + (err.message || 'unknown'));
      if (btn && btn.tagName === 'BUTTON') { btn.disabled = false; btn.textContent = '🔍 Run 86 audit on every active job'; }
    });
  }

  function openBatchJobDetail(id) {
    _batchJobId = id;
    _agentsView = 'batch';
    renderAdminAgents();
  }

  function renderBatchJobDetail(id) {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML =
      '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;">' +
        '<button class="ee-btn secondary" onclick="closeBatchJobDetail()">&larr; Back to batches</button>' +
        '<div style="flex:1;font-size:13px;color:var(--text-dim,#888);">Loading batch ' + escapeHTML(id) + '…</div>' +
      '</div>' +
      '<div id="batch-detail-body" style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';
    window.p86Api.get('/api/admin/batch/jobs/' + encodeURIComponent(id)).then(function(resp) {
      var b = resp && resp.job;
      if (!b) { host.innerHTML = '<div style="color:#e74c3c;">Batch not found.</div>'; return; }
      var pill = batchStatusPill(b.status);
      var when = '';
      try { when = new Date(b.submitted_at).toLocaleString(); } catch (e) {}
      var done = b.completed_at ? (function() { try { return new Date(b.completed_at).toLocaleString(); } catch (e) { return ''; } })() : null;
      var summary =
        '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;background:rgba(79,140,255,0.06);border:1px solid rgba(79,140,255,0.25);border-radius:8px;padding:12px 14px;">' +
          '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Status</div><div>' + pill + '</div></div>' +
          '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Submitted</div><div style="font-size:13px;color:var(--text,#fff);">' + escapeHTML(when) + '</div></div>' +
          (done ? '<div><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Completed</div><div style="font-size:13px;color:var(--text,#fff);">' + escapeHTML(done) + '</div></div>' : '') +
          '<div style="margin-left:auto;text-align:right;"><div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Jobs in batch</div><div style="font-size:13px;color:var(--text,#fff);font-family:\'SF Mono\',monospace;">' + (b.request_count || 0) + '</div></div>' +
        '</div>';
      var resultsHtml = '';
      if (Array.isArray(b.results) && b.results.length) {
        resultsHtml = '<h3 style="font-size:13px;margin:14px 0 8px;color:var(--text,#fff);">Per-job results</h3>';
        b.results.forEach(function(r) {
          var status = r.result_type || 'unknown';
          var statusBg = status === 'succeeded' ? 'rgba(52,211,153,0.10)' : 'rgba(248,113,113,0.10)';
          var statusColor = status === 'succeeded' ? '#34d399' : '#f87171';
          resultsHtml += '<details style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-left:3px solid ' + statusColor + ';border-radius:6px;padding:10px 12px;margin-bottom:8px;">' +
            '<summary style="cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;">' +
              '<span style="font-weight:600;color:var(--text,#fff);">' + escapeHTML(r.job_title || r.custom_id) + '</span>' +
              '<span style="display:inline-block;padding:1px 6px;border-radius:8px;background:' + statusBg + ';color:' + statusColor + ';font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">' + escapeHTML(status) + '</span>' +
              (r.usage ? '<span style="margin-left:auto;font-family:\'SF Mono\',monospace;font-size:10px;color:var(--text-dim,#888);">' + (r.usage.input_tokens || 0) + ' in / ' + (r.usage.output_tokens || 0) + ' out</span>' : '') +
            '</summary>' +
            (r.error ? '<div style="color:#f87171;font-size:12px;margin-top:8px;">' + escapeHTML(r.error) + '</div>' : '') +
            (r.text ? '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text-dim,#ccc);margin:8px 0 0;font-family:inherit;">' + escapeHTML(r.text) + '</pre>' : '') +
          '</details>';
        });
      } else if (b.status === 'ended') {
        resultsHtml = '<div style="color:var(--text-dim,#888);font-style:italic;padding:14px 0;">Batch ended but no results were captured. Click Refresh to retry.</div>';
      } else {
        resultsHtml = '<div style="color:var(--text-dim,#888);font-style:italic;padding:14px 0;">Results land here when the batch ends. <button class="ee-btn secondary" onclick="refreshBatchJob(\'' + escapeAttr(b.id) + '\')">Refresh now</button></div>';
      }
      document.getElementById('batch-detail-body').innerHTML = summary + resultsHtml;
    }).catch(function(err) {
      var bodyEl = document.getElementById('batch-detail-body');
      if (bodyEl) bodyEl.innerHTML = '<div style="color:#e74c3c;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function closeBatchJobDetail() {
    _batchJobId = null;
    renderAdminAgents();
  }

  function refreshBatchJob(id) {
    window.p86Api.post('/api/admin/batch/jobs/' + encodeURIComponent(id) + '/refresh', {}).then(function() {
      renderBatchJobDetail(id);
    }).catch(function(err) {
      alert('Refresh failed: ' + (err.message || 'unknown'));
    });
  }

  window.renderBatchJobsList = renderBatchJobsList;
  window.renderBatchJobDetail = renderBatchJobDetail;
  window.submitElleAuditBatch = submitElleAuditBatch;
  window.openBatchJobDetail = openBatchJobDetail;
  window.closeBatchJobDetail = closeBatchJobDetail;
  window.refreshBatchJob = refreshBatchJob;

  // ─────────── Files API uploads ───────────
  // One-click upload of recent unattached images to Anthropic's
  // beta.files API. The chat path doesn't yet consume the cached
  // file_ids — that's a follow-up commit (see admin-files-routes.js
  // header). This call alone establishes the cache.
  function uploadRecentPhotos(limit) {
    var btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Uploading…'; }
    window.p86Api.post('/api/admin/files/upload-recent', { limit: limit || 25 }).then(function(resp) {
      var msg = '✓ Uploaded ' + resp.uploaded + ' / ' + resp.attempted + ' image' + (resp.attempted === 1 ? '' : 's');
      var failed = (resp.results || []).filter(function(r) { return !r.ok; });
      if (failed.length) {
        msg += '\n\n' + failed.length + ' failed:\n' + failed.slice(0, 5).map(function(r) { return '- ' + r.attachment_id + ': ' + r.error; }).join('\n');
      }
      alert(msg);
      renderBatchJobsList();
    }).catch(function(err) {
      alert('Upload failed: ' + (err.message || 'unknown'));
      if (btn && btn.tagName === 'BUTTON') { btn.disabled = false; btn.textContent = 'Upload last 25 not-yet-uploaded images'; }
    });
  }
  window.uploadRecentPhotos = uploadRecentPhotos;

  // ─────────── Anthropic resources viewer ───────────
  // Read-only browser for Skills / Files / Batches hosted on the
  // Anthropic side. Each panel hits a corresponding /api/admin/
  // anthropic/* endpoint that thinly wraps the SDK list methods.
  // Lets the admin see the source-of-truth state of every resource
  // we've created (and clean up orphans).
  function renderAnthropicResources() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML =
      '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Live read-only view of every resource hosted in your Anthropic account from this app — Managed Agents, Skills, Files, Batches. Source of truth: hits the Anthropic API directly each render. Console UI: <a href="https://console.anthropic.com/" target="_blank" style="color:#4f8cff;">console.anthropic.com</a> shows API keys + usage; this view shows the resource lists.' +
      '</p>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;">' +
        '<button class="ee-btn secondary" onclick="renderAnthropicResources()">&#x21BB; Refresh all</button>' +
      '</div>' +
      '<div id="managed-agents-panel" style="margin-bottom:14px;"></div>' +
      '<div id="anthropic-skills-panel" style="margin-bottom:14px;"></div>' +
      '<div id="anthropic-files-panel" style="margin-bottom:14px;"></div>' +
      '<div id="anthropic-batches-panel" style="margin-bottom:14px;"></div>';

    loadManagedAgents();
    loadAnthropicSkills();
    loadAnthropicFiles();
    loadAnthropicBatches();
  }

  function loadManagedAgents() {
    var host = document.getElementById('managed-agents-panel');
    if (!host) return;
    host.innerHTML = panelHeader('Managed Agents (Phase 1a)', '🤖') + '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';
    window.p86Api.get('/api/admin/agents/managed').then(function(resp) {
      var rows = (resp && resp.agents) || [];
      // Intake is no longer a separate managed agent — 86 owns the
      // lead-intake flow. Only four agents register on the Anthropic side.
      var labels = { ag: '47 (Estimator)', job: '86 (Lead Agent — incl. intake)', cra: 'HR (clients + user health)', staff: 'Chief of Staff' };
      var allKeys = ['ag', 'job', 'cra', 'staff'];
      var registered = {};
      rows.forEach(function(r) { registered[r.agent_key] = r; });

      var bootstrapBar =
        '<p style="margin:0 0 10px 0;font-size:12px;color:var(--text-dim,#888);">' +
          'One-time registration of each Project 86 agent as an Anthropic-side managed Agent. Bootstraps the migration from <code>messages.stream</code> to <code>beta.sessions.events.stream</code>. The chat path is still on <code>messages.stream</code> — registering here just creates the Agent records that the v2 chat endpoint will reference once it ships.' +
        '</p>' +
        '<div style="margin-bottom:10px;">' +
          '<button class="ee-btn primary" onclick="bootstrapManagedAgents(\'all\')" title="Register every Project 86 agent that isn\'t yet registered.">&#x1F680; Register all unregistered</button>' +
        '</div>';

      var rowsHtml = '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr><th>Project 86 Agent</th><th>Anthropic Agent ID</th><th>Model</th><th style="text-align:right;">Tools</th><th style="text-align:right;">Skills</th><th>Registered</th><th></th></tr></thead><tbody>';
      allKeys.forEach(function(k) {
        var r = registered[k];
        if (r) {
          var when = '';
          try { when = new Date(r.registered_at).toLocaleDateString(); } catch (e) {}
          rowsHtml += '<tr>' +
            '<td>' + escapeHTML(labels[k] || k) + '</td>' +
            '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(r.anthropic_agent_id) + '</td>' +
            '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(r.model || '') + '</td>' +
            '<td style="text-align:right;font-family:\'SF Mono\',monospace;">' + (r.tool_count || 0) + '</td>' +
            '<td style="text-align:right;font-family:\'SF Mono\',monospace;">' + (r.skill_count || 0) + '</td>' +
            '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
            '<td><span style="color:#34d399;font-size:11px;font-weight:600;">REGISTERED</span></td>' +
          '</tr>';
        } else {
          rowsHtml += '<tr style="opacity:0.7;">' +
            '<td>' + escapeHTML(labels[k] || k) + '</td>' +
            '<td colspan="5" style="font-style:italic;color:var(--text-dim,#888);font-size:11px;">not yet registered</td>' +
            '<td><button class="ee-btn secondary" onclick="bootstrapManagedAgents(\'' + escapeAttr(k) + '\')">Register</button></td>' +
          '</tr>';
        }
      });
      rowsHtml += '</tbody></table></div>';

      host.innerHTML = panelHeader('Managed Agents (Phase 1a — registration)', '🤖') + bootstrapBar + rowsHtml;
    }).catch(function(err) {
      host.innerHTML = panelHeader('Managed Agents', '🤖') +
        '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function bootstrapManagedAgents(key) {
    var label = (key === 'all') ? 'every unregistered Project 86 agent' : key;
    if (!confirm('Register ' + label + ' as Anthropic-side managed Agent(s)?\n\nIdempotent — agents already in the registry stay as-is. Each registration consumes a beta.agents.create call. The chat path is unaffected; this just creates the Agent records that a future v2 chat endpoint will reference.\n\nNeeds ANTHROPIC_API_KEY set on the server.')) return;
    window.p86Api.post('/api/admin/agents/managed/bootstrap?key=' + encodeURIComponent(key), {}).then(function(resp) {
      var summary = (resp && resp.summary) || [];
      var msg = summary.map(function(s) {
        if (s.ok) return '✓ ' + s.agent_key + ' → ' + s.anthropic_agent_id + ' (' + s.tool_count + ' tools, ' + s.skill_count + ' skills)';
        return '✗ ' + s.agent_key + ': ' + s.error;
      }).join('\n');
      alert(msg || 'No agents processed.');
      loadManagedAgents();
    }).catch(function(err) {
      alert('Bootstrap failed: ' + (err.message || 'unknown'));
    });
  }
  window.bootstrapManagedAgents = bootstrapManagedAgents;

  function panelHeader(label, icon) {
    return '<div style="display:flex;align-items:center;gap:8px;margin-bottom:8px;">' +
      '<span style="font-size:18px;">' + icon + '</span>' +
      '<h3 style="margin:0;font-size:14px;font-weight:600;color:var(--text,#fff);">' + escapeHTML(label) + '</h3>' +
      '</div>';
  }

  function loadAnthropicSkills() {
    var host = document.getElementById('anthropic-skills-panel');
    if (!host) return;
    host.innerHTML = panelHeader('Native Skills', '🧠') + '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';
    window.p86Api.get('/api/admin/anthropic/skills').then(function(resp) {
      var rows = (resp && resp.skills) || [];
      var note = resp && resp.note;
      if (!rows.length) {
        host.innerHTML = panelHeader('Native Skills', '🧠') +
          '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:10px 0;">' +
            (note ? escapeHTML(note) : 'No native Skills hosted yet.') +
            ' Project 86 hasn\'t migrated to the native-Skills primitive — see Native Skills migration plan in chat for details.' +
          '</div>';
        return;
      }
      var html = panelHeader('Native Skills (' + rows.length + ')', '🧠') +
        '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr><th>Id</th><th>Name</th><th>Description</th><th>Created</th></tr></thead><tbody>';
      rows.forEach(function(s) {
        var when = '';
        try { when = s.created_at ? new Date(s.created_at).toLocaleDateString() : ''; } catch (e) {}
        html += '<tr>' +
          '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(s.id || '') + '</td>' +
          '<td>' + escapeHTML(s.name || '') + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML((s.description || '').slice(0, 120)) + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = panelHeader('Native Skills', '🧠') +
        '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function loadAnthropicFiles() {
    var host = document.getElementById('anthropic-files-panel');
    if (!host) return;
    host.innerHTML = panelHeader('Files', '📂') + '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';
    window.p86Api.get('/api/admin/anthropic/files?limit=200').then(function(resp) {
      var rows = (resp && resp.files) || [];
      if (!rows.length) {
        host.innerHTML = panelHeader('Files', '📂') +
          '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:10px 0;">No files uploaded yet. Upload from Admin → Agents → 📦 Batch → Files cache panel.</div>';
        return;
      }
      var totalBytes = rows.reduce(function(s, f) { return s + (Number(f.size_bytes) || 0); }, 0);
      var totalMB = (totalBytes / 1048576).toFixed(2);
      var html = panelHeader('Files (' + rows.length + ' · ' + totalMB + ' MB)', '📂') +
        '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr><th>Id</th><th>Filename</th><th style="text-align:right;">Size</th><th>Type</th><th>Created</th></tr></thead><tbody>';
      rows.forEach(function(f) {
        var when = '';
        try { when = f.created_at ? new Date(f.created_at).toLocaleDateString() : ''; } catch (e) {}
        var sizeKB = f.size_bytes ? Math.round(Number(f.size_bytes) / 1024).toLocaleString() + ' KB' : '—';
        html += '<tr>' +
          '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(f.id || '') + '</td>' +
          '<td>' + escapeHTML(f.filename || '') + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + sizeKB + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(f.mime_type || f.type || '') + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = panelHeader('Files', '📂') +
        '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function loadAnthropicBatches() {
    var host = document.getElementById('anthropic-batches-panel');
    if (!host) return;
    host.innerHTML = panelHeader('Batches', '📦') + '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';
    window.p86Api.get('/api/admin/anthropic/batches?limit=100').then(function(resp) {
      var rows = (resp && resp.batches) || [];
      if (!rows.length) {
        host.innerHTML = panelHeader('Batches', '📦') +
          '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:10px 0;">No batches submitted yet.</div>';
        return;
      }
      var html = panelHeader('Batches (' + rows.length + ')', '📦') +
        '<p style="margin:0 0 8px 0;font-size:11px;color:var(--text-dim,#666);">Source-of-truth list from Anthropic. Our local <em>Batch</em> tab tracks the same batches with admin metadata; this list shows everything hosted by Anthropic regardless of local state.</p>' +
        '<div class="table-container"><table style="width:100%;font-size:12px;">' +
        '<thead><tr><th>Id</th><th>Status</th><th style="text-align:right;">Counts</th><th>Created</th><th>Ends</th></tr></thead><tbody>';
      rows.forEach(function(b) {
        var c = b.request_counts || {};
        var when = '';
        var ends = '';
        try { when = b.created_at ? new Date(b.created_at).toLocaleString() : ''; } catch (e) {}
        try { ends = b.ended_at ? new Date(b.ended_at).toLocaleString() : ''; } catch (e) {}
        var statusColor = b.processing_status === 'ended' ? '#34d399' : (b.processing_status === 'in_progress' ? '#fbbf24' : '#888');
        html += '<tr>' +
          '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(b.id || '') + '</td>' +
          '<td><span style="color:' + statusColor + ';font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">' + escapeHTML(b.processing_status || '') + '</span></td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' +
            (c.processing != null || c.succeeded != null || c.errored != null ? (c.processing || 0) + 'p / ' + (c.succeeded || 0) + 's / ' + (c.errored || 0) + 'e' : '—') +
          '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(when) + '</td>' +
          '<td style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(ends) + '</td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = panelHeader('Batches', '📦') +
        '<div style="color:#e74c3c;font-size:12px;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  window.renderAnthropicResources = renderAnthropicResources;

  // ─────────── Native Skills sync (homegrown → Anthropic) ───────────
  // Uploads each local pack as a SKILL.md to Anthropic's native
  // beta.skills API. Mirrors the body so it's visible on the
  // Anthropic side; runtime cutover (chat actually loading skills
  // on-demand) is a separate workstream and stays unchanged for now.
  function syncAllSkillsToAnthropic() {
    if (!confirm('Mirror every local pack to Anthropic Skills?\n\nUploads each pack as a SKILL.md via beta.skills.create. Already-mirrored packs are skipped. The chat path is unchanged — this just makes the packs visible in Anthropic\'s native Skills system.\n\nNeeds ANTHROPIC_API_KEY set on the server.')) return;
    var statusEl = document.getElementById('agents-skills-status');
    if (statusEl) { statusEl.textContent = 'Syncing all packs to Anthropic…'; statusEl.style.color = 'var(--text-dim,#888)'; }
    window.p86Api.post('/api/admin/agents/skills/sync-all-to-anthropic', {}).then(function(resp) {
      var msg = '✓ Synced ' + (resp.synced || 0) + ' new pack' + ((resp.synced || 0) === 1 ? '' : 's') + ' to Anthropic.';
      var failed = (resp.summary || []).filter(function(s) { return s.status === 'failed'; });
      if (failed.length) msg += '\n\n' + failed.length + ' failed:\n' + failed.map(function(f) { return '- ' + f.name + ': ' + f.error; }).join('\n');
      alert(msg);
      renderAgentsSkillsView();
    }).catch(function(err) {
      if (statusEl) { statusEl.textContent = 'Sync failed: ' + (err.message || ''); statusEl.style.color = '#f87171'; }
    });
  }

  function syncSkillToAnthropic(idx) {
    syncSkillsFromInputs(); // capture any in-flight edits before sync
    saveAgentsSkillsThen(function() {
      window.p86Api.post('/api/admin/agents/skills/' + encodeURIComponent(idx) + '/sync-to-anthropic', {}).then(function(resp) {
        alert('✓ Mirrored to Anthropic — skill_id ' + (resp.anthropic_skill_id || ''));
        renderAgentsSkillsView();
      }).catch(function(err) { alert('Sync failed: ' + (err.message || 'unknown')); });
    });
  }

  function unsyncSkillFromAnthropic(idx) {
    if (!confirm('Delete the Anthropic-side mirror for this pack?\n\nThe local pack stays. The next time you click Mirror, a fresh copy goes up — useful when the body has changed and you want to refresh the mirror.')) return;
    window.p86Api.post('/api/admin/agents/skills/' + encodeURIComponent(idx) + '/unsync-from-anthropic', {}).then(function(resp) {
      if (resp.delete_error) {
        alert('Local link cleared.\n\nNote: Anthropic-side delete also reported: ' + resp.delete_error);
      }
      renderAgentsSkillsView();
    }).catch(function(err) { alert('Unsync failed: ' + (err.message || 'unknown')); });
  }

  // Save the current Skills draft, then run a callback. The sync
  // endpoints read from the persisted row (not the in-memory draft),
  // so we must save first to avoid uploading a stale body.
  function saveAgentsSkillsThen(cb) {
    syncSkillsFromInputs();
    window.p86Api.settings.put('agent_skills', _skillsDraft).then(function() { if (cb) cb(); }).catch(function(err) {
      alert('Save before sync failed: ' + (err.message || 'unknown'));
    });
  }

  window.syncAllSkillsToAnthropic = syncAllSkillsToAnthropic;
  window.syncSkillToAnthropic = syncSkillToAnthropic;
  window.unsyncSkillFromAnthropic = unsyncSkillFromAnthropic;

  // ─────────── Run all evals (post-save verification) ───────────
  // Hits /api/admin/agents/skills/run-all-evals which runs every
  // defined eval against the current SAVED skill-pack config.
  // Sequential, ~10-30s per eval; UI shows a per-row pass/fail
  // summary as the response lands. If an eval fails, the admin can
  // restore an earlier version via History.
  function runAllEvals() {
    var host = document.getElementById('agents-skills-eval-results');
    if (!host) return;
    if (!confirm('Run every defined eval against the currently saved skill packs?\n\nEach eval makes a real Anthropic API call (no caching across evals). With 5 evals this typically costs $0.10-$0.50 and takes 30-90 seconds.')) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-style:italic;font-size:12px;padding:14px 0;">Running all evals (this may take a minute)…</div>';
    window.p86Api.post('/api/admin/agents/skills/run-all-evals', {}).then(function(resp) {
      var summary = (resp && resp.summary) || [];
      if (resp && resp.note) {
        host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:14px 0;">' + escapeHTML(resp.note) + '</div>';
        return;
      }
      if (!summary.length) {
        host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;padding:14px 0;">No evals configured.</div>';
        return;
      }
      var passCount = summary.filter(function(s) { return s.passed; }).length;
      var failCount = summary.length - passCount;
      var headerColor = failCount === 0 ? '#34d399' : '#f87171';
      var html =
        '<div style="display:flex;align-items:center;gap:10px;margin-bottom:10px;padding:10px 12px;background:rgba(' + (failCount === 0 ? '52,211,153' : '248,113,113') + ',0.08);border:1px solid rgba(' + (failCount === 0 ? '52,211,153' : '248,113,113') + ',0.25);border-radius:6px;">' +
          '<span style="font-size:18px;color:' + headerColor + ';">' + (failCount === 0 ? '✓' : '✗') + '</span>' +
          '<div style="font-size:13px;font-weight:600;color:var(--text,#fff);">' +
            passCount + ' / ' + summary.length + ' eval' + (summary.length === 1 ? '' : 's') + ' passed' +
            (failCount > 0 ? ' — review failures below; restore an earlier version via History if a recent edit caused the regression.' : '') +
          '</div>' +
        '</div>' +
        '<div class="table-container"><table style="width:100%;font-size:12px;">' +
          '<thead><tr><th>Eval</th><th>Result</th><th style="text-align:right;">Duration</th><th></th></tr></thead><tbody>';
      summary.forEach(function(s) {
        var pill = s.passed
          ? '<span style="display:inline-block;background:rgba(52,211,153,0.15);color:#34d399;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">PASS</span>'
          : '<span style="display:inline-block;background:rgba(248,113,113,0.15);color:#f87171;font-size:11px;padding:2px 8px;border-radius:10px;font-weight:600;">FAIL</span>';
        html += '<tr>' +
          '<td>' + escapeHTML(s.name || s.eval_id) + (s.error ? '<div style="font-size:11px;color:#f87171;margin-top:2px;">' + escapeHTML(s.error) + '</div>' : '') + '</td>' +
          '<td>' + pill + '</td>' +
          '<td style="text-align:right;font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + (s.duration_ms ? Math.round(s.duration_ms / 100) / 10 + 's' : '—') + '</td>' +
          '<td><button class="ee-btn secondary" onclick="openEvalDetail(\'' + escapeAttr(s.eval_id) + '\')">View</button></td>' +
        '</tr>';
      });
      html += '</tbody></table></div>';
      host.innerHTML = html;
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:14px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }
  window.runAllEvals = runAllEvals;

  // Cached per-agent overridable sections. Populated by
  // fetchOverridableSections() before the skills editor renders so the
  // "Replaces section" dropdown can show options + descriptions.
  // Keys are the canonical agent ids used everywhere in the system:
  // ag (estimate), job (Elle), cra (HR), staff (Chief of Staff).
  var _overridableSections = { ag: [], job: [], cra: [], staff: [] };

  function fetchOverridableSections() {
    var agentKeys = ['ag', 'job', 'cra', 'staff'];
    return Promise.all(agentKeys.map(function(a) {
      return window.p86Api.get('/api/admin/agents/sections?agent=' + a)
        .then(function(r) { _overridableSections[a] = (r && r.sections) || []; })
        .catch(function() { _overridableSections[a] = []; });
    }));
  }

  function renderAgentsSkillsView() {
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading skill packs…</div>';
    Promise.all([
      window.p86Api.settings.get('agent_skills'),
      fetchOverridableSections()
    ]).then(function(results) {
      var res = results[0];
      _skillsDraft = (res && res.setting && res.setting.value) || { skills: [] };
      if (!Array.isArray(_skillsDraft.skills)) _skillsDraft.skills = [];
      // Reuse the same body markup the Templates → Skills tab renders,
      // wrap with a save bar tailored for the agents page (lighter than
      // saveAdminTemplate's "save all settings" action).
      // Native Skills migration banner — packs sit in this homegrown
      // system today, but each one can be MIRRORED to Anthropic Skills
      // via the per-pack Sync button. Runtime cutover (model loading
      // skills on demand instead of always-on append) requires migrating
      // chat to beta.agents — that's a separate workstream.
      host.innerHTML =
        '<div style="margin:0 0 14px 0;padding:12px 14px;background:rgba(251,191,36,0.06);border:1px solid rgba(251,191,36,0.25);border-radius:8px;font-size:12px;line-height:1.5;color:var(--text-dim,#aaa);">' +
          '<div style="font-weight:600;color:#fbbf24;margin-bottom:4px;">&#x1F6A7; Native Skills migration in progress</div>' +
          'Packs below are Project 86\'s homegrown skill system — still <strong>active in production</strong>; 47 / 86 / HR load them every turn. ' +
          'Use <button class="ee-btn secondary" onclick="syncAllSkillsToAnthropic()" style="margin:0 4px;font-size:11px;padding:2px 8px;">&#x1F310; Sync all to Anthropic</button> to mirror them as native Skills. ' +
          'Mirrored skills appear in <a href="#" onclick="switchAgentsView(\'anthropic\');return false;" style="color:#4f8cff;">Anthropic &rarr; Skills</a>. ' +
          'Runtime cutover (model loading skills on-demand via beta.agents) is a separate workstream — until then this surface remains source-of-truth.' +
        '</div>' +
        '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;opacity:0.6;">' +
          'Reusable instruction blocks loaded into the in-app AI agents at chat time. The Chief of Staff can also propose skill-pack edits — those land here on approval. Edits made here are also visible from <a href="#" onclick="switchAdminSubTab(\'templates\');return false;" style="color:#4f8cff;">Templates &rarr; Skills</a>.' +
        '</p>' +
        '<div id="agents-skills-body">' + renderAgentSkillsHTML() + '</div>' +
        '<div style="display:flex;gap:8px;align-items:center;margin-top:14px;padding:10px 12px;background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;">' +
          '<span id="agents-skills-status" style="flex:1;font-size:12px;color:var(--text-dim,#888);"></span>' +
          '<button class="ee-btn secondary" onclick="openSkillsVersionHistory()">&#x23F1; History</button>' +
          '<button class="ee-btn secondary" onclick="runAllEvals()" title="Run every defined eval against the current saved skill packs. Use after Save to verify nothing regressed.">&#x1F9EA; Run all evals</button>' +
          '<button class="ee-btn secondary" onclick="renderAgentsSkillsView()">Discard changes</button>' +
          '<button class="ee-btn primary" onclick="saveAgentsSkills()">&#x1F4BE; Save skills</button>' +
        '</div>' +
        '<div id="agents-skills-eval-results" style="margin-top:12px;"></div>';
    }).catch(function(err) {
      host.innerHTML = '<div style="color:#e74c3c;font-size:12px;padding:20px 0;">Failed: ' + escapeHTML(err.message || 'unknown') + '</div>';
    });
  }

  function saveAgentsSkills() {
    syncSkillsFromInputs();
    var statusEl = document.getElementById('agents-skills-status');
    if (statusEl) { statusEl.textContent = 'Saving…'; statusEl.style.color = 'var(--text-dim,#888)'; }
    window.p86Api.settings.put('agent_skills', _skillsDraft).then(function() {
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
    window.p86Api.get('/api/admin/agents/evals').then(function(resp) {
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
    _agentsConvKey = null;
    _agentsEvalNew = false;
    renderAdminAgents();
  }

  function runEval(id) {
    var btn = document.activeElement;
    if (btn && btn.tagName === 'BUTTON') { btn.disabled = true; btn.textContent = 'Running…'; }
    window.p86Api.post('/api/admin/agents/evals/' + encodeURIComponent(id) + '/run', {}).then(function(resp) {
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
    window.p86Api.get('/api/admin/agents/evals/' + encodeURIComponent(id)).then(function(resp) {
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
    _agentsEvalNew = false;
    renderAdminAgents();
  }

  function deleteEval(id) {
    if (!confirm('Delete this eval fixture? Its run history will also be removed.')) return;
    window.p86Api.del('/api/admin/agents/evals/' + encodeURIComponent(id)).then(function() {
      _agentsEvalId = null;
      renderAdminAgents();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || 'unknown'));
    });
  }

  function openNewEvalModal() {
    _agentsEvalNew = true;
    _agentsConvKey = null;
    _agentsEvalId = null;
    var host = document.getElementById('agents-content');
    if (!host) return;
    host.innerHTML = '<div style="color:var(--text-dim,#888);font-size:12px;font-style:italic;padding:20px 0;">Loading recent estimates…</div>';
    window.p86Api.estimates.list().then(function(resp) {
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
    _agentsEvalNew = false;
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
    window.p86Api.post('/api/admin/agents/evals', {
      name: name,
      description: description || undefined,
      kind: 'estimate_draft',
      fixture: fixture,
      expected_signals: expected
    }).then(function() {
      _agentsEvalNew = false;
      renderAgentEvalsList();
    }).catch(function(err) {
      showErr('Save failed: ' + (err.message || 'unknown'));
      if (btn) { btn.disabled = false; btn.textContent = 'Save fixture'; }
    });
  }

  // Accessors used by the URL router to read which agents drill-down
  // (if any) is currently showing. Mirrors estimateEditorAPI.getOpenId
  // and p86Leads.getOpenId — captureRouteFromDOM uses these to decide
  // whether the path should include /conversations/:key, /evals/:id,
  // or /evals/new.
  window.adminAgentsAPI = {
    getView: function() { return _agentsView; },
    getOpenConvKey: function() { return _agentsConvKey; },
    getOpenEvalId: function() { return _agentsEvalId; },
    isNewEvalOpen: function() { return _agentsEvalNew; }
  };

  // ==================== SMS LOG ADMIN ====================
  // Read-only audit view for the SMS scheduling agent. Fetches the
  // last N inbound + outbound texts from /api/admin/sms/log and
  // renders them as a dense table — dir / who / body / intent / when.
  // Refresh button re-fetches; no auto-poll (admins typically open
  // this when debugging a worker complaint, not as a live dashboard).
  function renderAdminSms() {
    if (!isAdmin()) return;
    var pane = document.getElementById('admin-subtab-sms');
    if (!pane) return;
    pane.innerHTML =
      '<p style="margin:0 0 14px 0;color:var(--text-dim,#888);font-size:12px;">' +
        'Audit log of every text the SMS scheduling agent sent or received. Use this to debug intent matches, spot unknown senders (likely an employee whose phone isn\'t on file), and confirm replies went out.' +
      '</p>' +
      '<div style="display:flex;gap:8px;align-items:center;margin-bottom:12px;">' +
        '<button class="ee-btn secondary" onclick="renderAdminSms()">&#x21BB; Refresh</button>' +
        '<span style="font-size:11px;color:var(--text-dim,#888);">Newest first · last 100 events</span>' +
      '</div>' +
      '<div id="admin-sms-content" style="font-size:12px;color:var(--text-dim,#888);font-style:italic;">Loading…</div>';

    if (!window.p86Api || !window.p86Api.adminSms || typeof window.p86Api.adminSms.list !== 'function') {
      document.getElementById('admin-sms-content').innerHTML =
        '<div style="color:#e74c3c;">SMS API helper missing — refresh the page.</div>';
      return;
    }

    window.p86Api.adminSms.list(100).then(function(resp) {
      var entries = (resp && resp.entries) || [];
      var content = document.getElementById('admin-sms-content');
      if (!content) return;
      if (!entries.length) {
        content.innerHTML = '<div style="color:var(--text-dim,#888);font-style:italic;padding:14px 0;">No SMS traffic yet. Once a worker texts the Project 86 number, log entries appear here.</div>';
        return;
      }

      var rows = entries.map(renderSmsLogRow).join('');
      content.innerHTML =
        '<div class="table-container">' +
          '<table style="width:100%;font-size:12px;">' +
            '<thead><tr>' +
              '<th style="width:60px;">Dir</th>' +
              '<th style="width:140px;">From</th>' +
              '<th style="width:140px;">To</th>' +
              '<th style="width:140px;">User</th>' +
              '<th>Body</th>' +
              '<th style="width:100px;">Intent</th>' +
              '<th style="width:140px;text-align:right;">When</th>' +
            '</tr></thead>' +
            '<tbody>' + rows + '</tbody>' +
          '</table>' +
        '</div>';
    }).catch(function(err) {
      var content = document.getElementById('admin-sms-content');
      if (content) {
        content.innerHTML = '<div style="color:#e74c3c;">Failed to load: ' + escapeHTML(err.message || 'unknown') + '</div>';
      }
    });
  }

  function renderSmsLogRow(e) {
    var dirColor = e.direction === 'in' ? '#4f8cff' : '#a78bfa';
    var dirLabel = e.direction === 'in' ? '← IN' : 'OUT →';
    var when = '';
    try { when = new Date(e.created_at).toLocaleString(); } catch (ex) {}
    var user = e.user_name
      ? escapeHTML(e.user_name)
      : '<span style="color:var(--text-dim,#666);font-style:italic;">unknown</span>';
    var intent = e.intent
      ? '<span style="display:inline-block;background:rgba(79,140,255,0.12);color:#4f8cff;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;">' + escapeHTML(e.intent) + '</span>'
      : '';
    var body = '<pre style="white-space:pre-wrap;font-size:12px;color:var(--text,#ccc);margin:0;font-family:inherit;">' + escapeHTML(e.body || '') + '</pre>';
    if (e.error) {
      body += '<div style="color:#f87171;font-size:11px;margin-top:4px;">' + escapeHTML(e.error) + '</div>';
    }
    return '<tr>' +
      '<td><span style="color:' + dirColor + ';font-weight:600;font-family:\'SF Mono\',monospace;font-size:11px;">' + dirLabel + '</span></td>' +
      '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(e.from_number || '') + '</td>' +
      '<td style="font-family:\'SF Mono\',monospace;font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(e.to_number || '') + '</td>' +
      '<td>' + user + '</td>' +
      '<td>' + body + '</td>' +
      '<td>' + intent + '</td>' +
      '<td style="text-align:right;font-size:11px;color:var(--text-dim,#888);">' + escapeHTML(when) + '</td>' +
    '</tr>';
  }

  window.renderAdminSms = renderAdminSms;

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
  // Reference Links view — expose for both inline onclick handlers
  // and switchAgentsView dispatch.
  window.renderReferenceLinksView = renderReferenceLinksView;
  window.openReferenceLinkEditor = openReferenceLinkEditor;
  window.closeReferenceLinkEditor = closeReferenceLinkEditor;
  window.saveReferenceLink = saveReferenceLink;
  window.editReferenceLink = editReferenceLink;
  window.deleteReferenceLink = deleteReferenceLink;
  window.refreshReferenceLink = refreshReferenceLink;
  window.previewReferenceLink = previewReferenceLink;
})();
