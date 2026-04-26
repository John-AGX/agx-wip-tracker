// AGX API client — thin fetch wrapper with JWT auth, used by data-layer code.
// Depends on window.agxAuth from js/auth.js for the token.
(function() {
  'use strict';

  function getToken() {
    return (window.agxAuth && window.agxAuth.getToken()) || localStorage.getItem('agx-auth-token');
  }

  function isOffline() {
    return window.agxAuth && window.agxAuth.isOffline();
  }

  function buildHeaders(extra) {
    var headers = { 'Content-Type': 'application/json' };
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    if (extra) for (var k in extra) headers[k] = extra[k];
    return headers;
  }

  function handleResponse(r) {
    if (r.status === 401) {
      // Token expired or invalid — bounce to login
      localStorage.removeItem('agx-auth-token');
      if (typeof location !== 'undefined') location.reload();
      throw new Error('Session expired');
    }
    return r.json().then(function(data) {
      if (!r.ok) {
        var err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.status = r.status;
        err.data = data;
        throw err;
      }
      return data;
    });
  }

  function get(path) {
    return fetch(path, { headers: buildHeaders(), credentials: 'same-origin' }).then(handleResponse);
  }

  function put(path, body) {
    return fetch(path, {
      method: 'PUT',
      headers: buildHeaders(),
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(handleResponse);
  }

  function post(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: buildHeaders(),
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(handleResponse);
  }

  function del(path) {
    return fetch(path, {
      method: 'DELETE',
      headers: buildHeaders(),
      credentials: 'same-origin'
    }).then(handleResponse);
  }

  // Domain-specific helpers built on top of the verbs above.
  var jobs = {
    list: function() { return get('/api/jobs'); },
    bulkSave: function(appData) { return put('/api/jobs/bulk/save', { appData: appData }); },
    remove: function(id) { return del('/api/jobs/' + encodeURIComponent(id)); },
    reassignOwner: function(id, ownerId) {
      return put('/api/jobs/' + encodeURIComponent(id) + '/owner', { ownerId: ownerId });
    },
    listAccess: function(id) { return get('/api/jobs/' + encodeURIComponent(id) + '/access'); },
    grantAccess: function(id, userId, accessLevel) {
      return post('/api/jobs/' + encodeURIComponent(id) + '/access', { userId: userId, accessLevel: accessLevel });
    },
    revokeAccess: function(id, userId) {
      return del('/api/jobs/' + encodeURIComponent(id) + '/access/' + encodeURIComponent(userId));
    }
  };

  var estimates = {
    list: function() { return get('/api/estimates'); },
    bulkSave: function(payload) { return put('/api/estimates/bulk/save', payload); },
    remove: function(id) { return del('/api/estimates/' + encodeURIComponent(id)); }
  };

  var users = {
    list: function() { return get('/api/auth/users'); },
    create: function(payload) { return post('/api/auth/register', payload); },
    update: function(id, payload) { return put('/api/auth/users/' + encodeURIComponent(id), payload); },
    resetPassword: function(id, newPassword) {
      return put('/api/auth/users/' + encodeURIComponent(id) + '/password', { newPassword: newPassword });
    },
    remove: function(id) { return del('/api/auth/users/' + encodeURIComponent(id)); }
  };

  window.agxApi = {
    get: get, put: put, post: post, del: del,
    jobs: jobs, estimates: estimates, users: users,
    isOffline: isOffline,
    isAuthenticated: function() { return !!getToken() && !isOffline(); }
  };
})();
