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

  var roles = {
    list: function() { return get('/api/roles'); },
    capabilities: function() { return get('/api/roles/capabilities'); },
    create: function(payload) { return post('/api/roles', payload); },
    update: function(name, payload) { return put('/api/roles/' + encodeURIComponent(name), payload); },
    remove: function(name) { return del('/api/roles/' + encodeURIComponent(name)); }
  };

  var clients = {
    list: function() { return get('/api/clients'); },
    get: function(id) { return get('/api/clients/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/clients', payload); },
    update: function(id, payload) { return put('/api/clients/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/clients/' + encodeURIComponent(id)); },
    importBatch: function(rows) { return post('/api/clients/import', { rows: rows }); }
  };

  var settings = {
    get: function(key) { return get('/api/settings/' + encodeURIComponent(key)); },
    put: function(key, value) { return put('/api/settings/' + encodeURIComponent(key), { value: value }); }
  };

  // Multipart upload — bypasses the JSON-only `post` helper since we need
  // a FormData body. Auth header still gets attached.
  function uploadFile(path, file) {
    var fd = new FormData();
    fd.append('file', file);
    var headers = {};
    var token = getToken();
    if (token) headers['Authorization'] = 'Bearer ' + token;
    return fetch(path, {
      method: 'POST',
      headers: headers,
      credentials: 'same-origin',
      body: fd
    }).then(handleResponse);
  }

  var ai = {
    extractLead: function(images) { return post('/api/ai/extract-lead', { images: images }); }
  };

  var attachments = {
    list: function(entityType, entityId) {
      return get('/api/attachments/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId));
    },
    upload: function(entityType, entityId, file) {
      return uploadFile('/api/attachments/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId), file);
    },
    update: function(id, payload) { return put('/api/attachments/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/attachments/' + encodeURIComponent(id)); }
  };

  var leads = {
    list: function(query) {
      var qs = '';
      if (query) {
        var parts = [];
        Object.keys(query).forEach(function(k) {
          if (query[k] != null && query[k] !== '') {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(query[k]));
          }
        });
        if (parts.length) qs = '?' + parts.join('&');
      }
      return get('/api/leads' + qs);
    },
    get: function(id) { return get('/api/leads/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/leads', payload); },
    update: function(id, payload) { return put('/api/leads/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/leads/' + encodeURIComponent(id)); },
    importBatch: function(rows) { return post('/api/leads/import', { rows: rows }); }
  };

  window.agxApi = {
    get: get, put: put, post: post, del: del,
    jobs: jobs, estimates: estimates, users: users, roles: roles, clients: clients, leads: leads, settings: settings, attachments: attachments, ai: ai,
    isOffline: isOffline,
    isAuthenticated: function() { return !!getToken() && !isOffline(); }
  };
})();
