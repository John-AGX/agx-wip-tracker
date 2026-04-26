// AGX Auth Client — handles login, session, and API token
(function() {
  'use strict';

  var currentUser = null;
  var token = null;
  var isOffline = false;

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
  }

  function updateUserMenu() {
    var nameEl = document.getElementById('user-name');
    var roleEl = document.getElementById('user-role-badge');
    if (isOffline) {
      nameEl.textContent = 'Offline Mode';
      roleEl.textContent = 'local';
      roleEl.style.background = 'rgba(251,191,36,0.2)';
      roleEl.style.color = '#fbbf24';
    } else if (currentUser) {
      nameEl.textContent = currentUser.name;
      roleEl.textContent = currentUser.role;
      var colors = { admin: '#34d399', corporate: '#4f8cff', pm: '#fbbf24' };
      roleEl.style.color = colors[currentUser.role] || '#8b90a5';
      roleEl.style.background = 'rgba(255,255,255,0.1)';
    }
    applyRoleVisibility();
  }

  // Show/hide elements based on current role. Elements with [data-admin-only]
  // are visible only to admins (or to offline mode, which gets admin powers).
  function applyRoleVisibility() {
    var isAdmin = isOffline || (currentUser && currentUser.role === 'admin');
    document.querySelectorAll('[data-admin-only]').forEach(function(el) {
      el.style.display = isAdmin ? '' : 'none';
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
      showApp();
      // Pull fresh data from the server now that we're authenticated.
      if (window.agxData) window.agxData.reloadFromServer();
      // Pre-load the users cache for admins so the PM dropdown is ready.
      if (currentUser.role === 'admin' && window.agxAdmin) window.agxAdmin.refreshUsers();
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
      isOffline = false;
      showApp();
      if (window.agxData) window.agxData.reloadFromServer();
      if (currentUser.role === 'admin' && window.agxAdmin) window.agxAdmin.refreshUsers();
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
    isReadOnly: function() { return currentUser && currentUser.role === 'corporate'; }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
