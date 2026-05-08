// P86 Auth Client — handles login, session, and API token
(function() {
  'use strict';

  var currentUser = null;
  var token = null;
  var isOffline = false;
  // Set of capability keys for the current user's role. Loaded from
  // /api/roles after login so capability-gated UI elements can check
  // visibility synchronously via hasCapability().
  var capabilities = new Set();

  function init() {
    var stored = localStorage.getItem('agx-auth-token');
    if (stored) {
      token = stored;
      checkSession();
    } else {
      showLogin();
    }

    document.getElementById('login-btn').addEventListener('click', doLogin);
    document.getElementById('login-password').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') doLogin();
    });
    document.getElementById('login-email').addEventListener('keydown', function(e) {
      if (e.key === 'Enter') document.getElementById('login-password').focus();
    });
    document.getElementById('login-offline').addEventListener('click', function(e) {
      e.preventDefault();
      goOffline();
    });
    document.getElementById('logout-btn').addEventListener('click', doLogout);
  }

  function showLogin() {
    document.getElementById('login-screen').style.display = 'flex';
    document.getElementById('app-container').style.display = 'none';
    document.getElementById('login-email').focus();
  }

  function showApp() {
    document.getElementById('login-screen').style.display = 'none';
    document.getElementById('app-container').style.display = '';
    updateUserMenu();
    // Try to restore the user's last position first — refresh-to-home
    // was disorienting when you'd just opened a job or estimate. The
    // restorer (in app.js) returns false if the saved tab is no longer
    // accessible (lost permission, deleted entity, etc.); fall back to
    // the role-based landing in that case.
    // URL takes priority over localStorage nav-state — if the user
    // deep-linked or hit Back from a previous session, honor the URL.
    // The router's own boot will replay it; we only need to make sure
    // we don't ALSO call switchTab() here and stomp on it.
    var urlHasRoute = !!(window.agxRouter && window.agxRouter.route().top);
    var restored = false;
    if (!urlHasRoute && typeof window.agxNavRestore === 'function') {
      try { restored = window.agxNavRestore(); }
      catch (e) { console.warn('[nav] restore failed:', e); }
    }
    if (!urlHasRoute && !restored && typeof window.switchTab === 'function') {
      try { window.switchTab(getLandingTab()); }
      catch (e) { console.warn('Initial tab switch failed:', e); }
    }
  }

  // Pick the user's default tab. Built-in roles get their familiar landing
  // (admin -> Admin, corporate -> Insights, pm -> WIP, field_crew ->
  // Estimates). Custom roles fall back to the first tab their capabilities
  // unlock — so a "no-jobs" role still gets a sensible landing.
  function getLandingTab() {
    if (isOffline) return 'wip';
    if (!currentUser) return 'wip';
    var byRole = {
      admin: 'admin',
      corporate: 'insights',
      pm: 'wip',
      field_crew: 'estimates'
    };
    if (byRole[currentUser.role]) return byRole[currentUser.role];
    if (hasCapability('ADMIN_METRICS') || hasCapability('USERS_MANAGE') || hasCapability('ROLES_MANAGE')) return 'admin';
    if (hasCapability('JOBS_VIEW_ALL') || hasCapability('JOBS_VIEW_ASSIGNED') || hasCapability('JOBS_EDIT_ANY') || hasCapability('JOBS_EDIT_OWN')) return 'wip';
    if (hasCapability('INSIGHTS_VIEW')) return 'insights';
    if (hasCapability('ESTIMATES_VIEW')) return 'estimates';
    return 'wip';
  }

  // First letter of the first word + first letter of the last word
  // of a person's name, uppercased. Single-word names → first two
  // letters. Falls back to '?' on empty input.
  function computeInitials(name) {
    var s = String(name || '').trim();
    if (!s) return '?';
    var parts = s.split(/\s+/);
    if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }

  function updateUserMenu() {
    // Hidden span / role-pill kept around for downstream code that
    // still reads them; they live in the DOM with [hidden] but
    // textContent updates so any consumer query still works.
    var nameEl = document.getElementById('user-name');
    var roleEl = document.getElementById('user-role-badge');
    var avatar = document.getElementById('user-avatar');
    var avatarName = document.getElementById('avatar-menu-name');
    var avatarRole = document.getElementById('avatar-menu-role');

    var name, role, roleLabel;
    if (isOffline) {
      name = 'Offline Mode';
      role = 'local';
      roleLabel = 'LOCAL';
    } else if (currentUser) {
      name = currentUser.name;
      role = currentUser.role;
      roleLabel = (role || '').toUpperCase();
    } else {
      name = '';
      role = '';
      roleLabel = '';
    }

    if (nameEl) nameEl.textContent = name;
    if (roleEl) roleEl.textContent = role;
    if (avatar) {
      avatar.textContent = computeInitials(name);
      avatar.setAttribute('title', name + (roleLabel ? ' · ' + roleLabel : ''));
    }
    if (avatarName) avatarName.textContent = name || '—';
    if (avatarRole) avatarRole.textContent = roleLabel || '—';
    applyRoleVisibility();
  }

  // Show/hide elements based on current role and capabilities.
  // - [data-admin-only] toggles on admin role (offline counts as admin).
  // - [data-cap="KEY"] toggles on the corresponding capability. Multiple
  //   capabilities (any-of) can be supplied space-separated: data-cap="A B".
  function applyRoleVisibility() {
    var isAdmin = isOffline || (currentUser && currentUser.role === 'admin');
    document.querySelectorAll('[data-admin-only]').forEach(function(el) {
      el.style.display = isAdmin ? '' : 'none';
    });
    document.querySelectorAll('[data-cap]').forEach(function(el) {
      var keys = (el.getAttribute('data-cap') || '').split(/\s+/).filter(Boolean);
      var allowed = keys.some(function(k) { return hasCapability(k); });
      el.style.display = allowed ? '' : 'none';
    });
  }

  function hasCapability(key) {
    if (isOffline) return true; // offline mode = full access locally
    return capabilities.has(key);
  }

  // Pulls the current user's role and capabilities from /api/roles.
  // Falls back to an empty cap set on failure (UI hides everything
  // capability-gated) — defensive but won't crash the app.
  function loadCapabilities() {
    if (!currentUser || !window.agxApi) {
      capabilities = new Set();
      applyRoleVisibility();
      return Promise.resolve();
    }
    return window.agxApi.roles.list().then(function(res) {
      var role = (res.roles || []).find(function(r) { return r.name === currentUser.role; });
      var caps = (role && Array.isArray(role.capabilities)) ? role.capabilities : [];
      capabilities = new Set(caps);
      applyRoleVisibility();
    }).catch(function() {
      capabilities = new Set();
      applyRoleVisibility();
    });
  }

  function showError(msg) {
    var el = document.getElementById('login-error');
    el.textContent = msg;
    el.style.display = 'block';
  }

  function hideError() {
    document.getElementById('login-error').style.display = 'none';
  }

  function doLogin() {
    hideError();
    var email = document.getElementById('login-email').value.trim();
    var password = document.getElementById('login-password').value;
    if (!email || !password) { showError('Enter email and password'); return; }

    var btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Signing in...';

    fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: email, password: password })
    })
    .then(function(r) { return r.json().then(function(d) { return { ok: r.ok, data: d }; }); })
    .then(function(res) {
      btn.disabled = false;
      btn.textContent = 'Sign In';
      if (!res.ok) { showError(res.data.error || 'Login failed'); return; }
      token = res.data.token;
      currentUser = res.data.user;
      isOffline = false;
      localStorage.setItem('agx-auth-token', token);
      // Sub-portal users (role='sub') don't get the PM app shell —
      // hard-redirect them to the portal page. The token cookie is
      // already set by the server so /portal will load authenticated.
      if (currentUser && currentUser.role === 'sub') {
        window.location.href = '/portal';
        return;
      }
      // Load capabilities BEFORE rendering the app so visibility (data-cap,
      // landing tab) is correct on first paint.
      loadCapabilities().then(function() { showApp(); });
      // Pull fresh data from the server now that we're authenticated.
      if (window.agxData) window.agxData.reloadFromServer();
      // Pre-load the users cache for admins so the PM dropdown is ready.
      // Load the users cache for everyone (admins get the rendered table from
      // refreshUsers; non-admins just need the cache populated so PM-by-id
      // lookups in the Job Information panel resolve names correctly).
      if (window.agxAdmin) {
        if (currentUser.role === 'admin') window.agxAdmin.refreshUsers();
        else if (window.agxAdmin.loadUsersCache) window.agxAdmin.loadUsersCache();
      }
    })
    .catch(function() {
      btn.disabled = false;
      btn.textContent = 'Sign In';
      showError('Cannot connect to server. Use "Continue Offline" for local mode.');
    });
  }

  function checkSession() {
    fetch('/api/auth/me', {
      headers: { 'Authorization': 'Bearer ' + token }
    })
    .then(function(r) {
      if (!r.ok) throw new Error('expired');
      return r.json();
    })
    .then(function(data) {
      currentUser = data.user;
      // Sub-portal users land on /portal — never the PM app shell —
      // even if their token cookie is still valid. checkSession runs
      // on every reload of the main app, so this is the catch-all.
      if (currentUser && currentUser.role === 'sub') {
        window.location.href = '/portal';
        return;
      }
      // Stash server-side feature flags on the global user object so
      // any module can read them via agxAuth.getUser().feature_flags.
      // Phase 1b uses agent_mode_ag to switch AG chat to the
      // Sessions-backed v2 endpoint.
      if (currentUser && data.feature_flags) {
        currentUser.feature_flags = data.feature_flags;
      }
      isOffline = false;
      loadCapabilities().then(function() { showApp(); });
      if (window.agxData) window.agxData.reloadFromServer();
      // Load the users cache for everyone (admins get the rendered table from
      // refreshUsers; non-admins just need the cache populated so PM-by-id
      // lookups in the Job Information panel resolve names correctly).
      if (window.agxAdmin) {
        if (currentUser.role === 'admin') window.agxAdmin.refreshUsers();
        else if (window.agxAdmin.loadUsersCache) window.agxAdmin.loadUsersCache();
      }
    })
    .catch(function() {
      localStorage.removeItem('agx-auth-token');
      token = null;
      showLogin();
    });
  }

  function doLogout() {
    fetch('/api/auth/logout', { method: 'POST' }).catch(function() {});
    localStorage.removeItem('agx-auth-token');
    token = null;
    currentUser = null;
    isOffline = false;
    document.getElementById('login-email').value = '';
    document.getElementById('login-password').value = '';
    showLogin();
  }

  function goOffline() {
    isOffline = true;
    currentUser = { name: 'Local User', role: 'admin', id: 0 };
    token = null;
    showApp();
  }

  // Expose for other modules
  window.agxAuth = {
    getUser: function() { return currentUser; },
    getToken: function() { return token; },
    isOffline: function() { return isOffline; },
    isAdmin: function() { return currentUser && currentUser.role === 'admin'; },
    canEdit: function() { return currentUser && (currentUser.role === 'admin' || currentUser.role === 'pm'); },
    isReadOnly: function() { return currentUser && currentUser.role === 'corporate'; },
    hasCapability: hasCapability,
    getCapabilities: function() { return Array.from(capabilities); },
    reloadCapabilities: loadCapabilities
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
