// Project 86 API client — thin fetch wrapper with JWT auth, used by data-layer code.
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

  function patch(path, body) {
    return fetch(path, {
      method: 'PATCH',
      headers: buildHeaders(),
      credentials: 'same-origin',
      body: JSON.stringify(body || {})
    }).then(handleResponse);
  }

  // Domain-specific helpers built on top of the verbs above.
  var jobs = {
    list: function() { return get('/api/jobs'); },
    bulkSave: function(appData) { return put('/api/jobs/bulk/save', { appData: appData }); },
    remove: function(id) { return del('/api/jobs/' + encodeURIComponent(id)); },
    reassignOwner: function(id, ownerId, notify) {
      // notify=true asks the server to email the new owner via the
      // standard job-assignment template. Defaults false so older
      // call sites that don't pass it stay silent.
      return put('/api/jobs/' + encodeURIComponent(id) + '/owner',
        { ownerId: ownerId, notify: !!notify });
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

  var adminSms = {
    // Recent SMS log entries (newest first). Read-only audit view.
    list: function(limit) {
      var l = limit ? '?limit=' + encodeURIComponent(limit) : '';
      return get('/api/admin/sms/log' + l);
    }
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
    importBatch: function(rows) { return post('/api/clients/import', { rows: rows }); },
    addNote: function(id, body, sourceAgent) {
      return post('/api/clients/' + encodeURIComponent(id) + '/notes', {
        body: body,
        source_agent: sourceAgent || null
      });
    },
    deleteNote: function(id, noteId) {
      return del('/api/clients/' + encodeURIComponent(id) + '/notes/' + encodeURIComponent(noteId));
    }
  };

  var settings = {
    get: function(key) { return get('/api/settings/' + encodeURIComponent(key)); },
    put: function(key, value) { return put('/api/settings/' + encodeURIComponent(key), { value: value }); }
  };

  // Multipart upload — bypasses the JSON-only `post` helper since we need
  // a FormData body. Auth header still gets attached. `extra` is an
  // optional plain-object map of extra form fields appended alongside
  // the file (e.g. markup_of, include_in_proposal).
  function uploadFile(path, file, extra) {
    var fd = new FormData();
    fd.append('file', file);
    if (extra && typeof extra === 'object') {
      Object.keys(extra).forEach(function(k) {
        var v = extra[k];
        if (v == null) return;
        fd.append(k, typeof v === 'boolean' ? String(v) : v);
      });
    }
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

  // Team messaging — per-entity comment threads.
  // Thread keys: 'job:<id>' / 'lead:<id>' / 'estimate:<id>' / 'dm:<a>:<b>'.
  var messages = {
    recent: function() { return get('/api/messages/recent'); },
    thread: function(key) { return get('/api/messages/' + encodeURIComponent(key)); },
    post: function(key, body) { return post('/api/messages/' + encodeURIComponent(key), { body: body }); },
    markRead: function(key) { return post('/api/messages/' + encodeURIComponent(key) + '/read', {}); },
    remove: function(id) { return del('/api/messages/' + encodeURIComponent(id)); }
  };

  var attachments = {
    list: function(entityType, entityId) {
      return get('/api/attachments/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId));
    },
    upload: function(entityType, entityId, file, extra) {
      return uploadFile('/api/attachments/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId), file, extra);
    },
    update: function(id, payload) { return put('/api/attachments/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/attachments/' + encodeURIComponent(id)); },
    // Cross-entity move. payload = { entity_type, entity_id, folder? }.
    move: function(id, payload) { return post('/api/attachments/' + encodeURIComponent(id) + '/move', payload); },
    // Cross-entity duplicate. Same payload shape as move; bytes are
    // copied server-side so source + copy are independent on delete.
    copy: function(id, payload) { return post('/api/attachments/' + encodeURIComponent(id) + '/copy', payload); },
    // Cross-entity most-recent uploads — drives the "Recent Files"
    // summary widget. limit defaults to 10 server-side; cap at 24.
    recent: function(limit) {
      var q = limit ? '?limit=' + encodeURIComponent(limit) : '';
      return get('/api/attachments/recent' + q);
    }
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

  var materials = {
    list: function(params) {
      var qs = '';
      if (params) {
        var parts = [];
        Object.keys(params).forEach(function(k) {
          if (params[k] != null && params[k] !== '') {
            parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(params[k]));
          }
        });
        if (parts.length) qs = '?' + parts.join('&');
      }
      return get('/api/materials' + qs);
    },
    update: function(id, payload) { return put('/api/materials/' + encodeURIComponent(id), payload); },
    importBatch: function(payload) { return post('/api/materials/import', payload); },
    categories: function() { return get('/api/materials/meta/categories'); },
    recategorize: function() { return post('/api/materials/recategorize', {}); }
  };

  // QuickBooks cost lines — DB-backed Phase 2.
  var qbCosts = {
    list: function(jobId) {
      return get('/api/qb-costs' + (jobId ? '?jobId=' + encodeURIComponent(jobId) : ''));
    },
    importBatch: function(payload) { return post('/api/qb-costs/import', payload); },
    // Single-line link patch. Server route is PATCH /api/qb-costs/:id;
    // this used to call put() which silently 404'd, so per-line link
    // updates only landed in the optimistic local cache and got lost
    // on the next reload. Now goes through patch() correctly.
    update: function(id, payload) { return patch('/api/qb-costs/' + encodeURIComponent(id), payload); },
    // Atomic bulk link. ids = array of qb_cost_lines.id; nodeId can
    // be null to clear the link.
    bulkLink: function(ids, nodeId) { return post('/api/qb-costs/bulk-link', { ids: ids, linkedNodeId: nodeId || null }); },
    // Null out linked_node_id for any line on this job that points
    // at a node not in the current valid set. Driven from the QB
    // Costs view "Clean orphans" button.
    cleanupOrphans: function(jobId, validNodeIds) {
      return post('/api/qb-costs/cleanup-orphans', { jobId: jobId, validNodeIds: validNodeIds || [] });
    },
    remove: function(id) { return del('/api/qb-costs/' + encodeURIComponent(id)); }
  };

  // Subcontractor directory + per-job assignment.
  var subsApi = {
    list: function() { return get('/api/subs'); },
    get: function(id) { return get('/api/subs/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/subs', payload); },
    update: function(id, payload) { return put('/api/subs/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/subs/' + encodeURIComponent(id)); },
    listForJob: function(jobId) { return get('/api/subs/jobs/' + encodeURIComponent(jobId)); },
    listJobsForSub: function(subId) { return get('/api/subs/' + encodeURIComponent(subId) + '/jobs'); },
    assignToJob: function(jobId, payload) { return post('/api/subs/jobs/' + encodeURIComponent(jobId), payload); },
    updateAssignment: function(jobId, assignmentId, payload) {
      // PATCH — use raw fetch since our helpers don't expose patch
      return fetch('/api/subs/jobs/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(assignmentId), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      }).then(function(r) { return r.json().then(function(b) { if (!r.ok) throw new Error(b.error || 'request failed'); return b; }); });
    },
    unassign: function(jobId, assignmentId) {
      return del('/api/subs/jobs/' + encodeURIComponent(jobId) + '/' + encodeURIComponent(assignmentId));
    },
    migratePreview: function(inlineSubs) { return post('/api/subs/migrate-preview', { inlineSubs: inlineSubs }); },
    migrateApply: function(inlineSubs) { return post('/api/subs/migrate-apply', { inlineSubs: inlineSubs }); },
    // Phase 1B — per-sub certificates (GL, WC, W-9, Bank).
    certs: {
      list: function(subId) {
        return get('/api/subs/' + encodeURIComponent(subId) + '/certificates');
      },
      upsert: function(subId, payload) {
        return post('/api/subs/' + encodeURIComponent(subId) + '/certificates', payload);
      },
      patch: function(subId, certType, payload) {
        return fetch('/api/subs/' + encodeURIComponent(subId) + '/certificates/' + encodeURIComponent(certType), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'include',
          body: JSON.stringify(payload)
        }).then(function(r) { return r.json().then(function(b) { if (!r.ok) throw new Error(b.error || 'request failed'); return b; }); });
      },
      remove: function(subId, certType) {
        return del('/api/subs/' + encodeURIComponent(subId) + '/certificates/' + encodeURIComponent(certType));
      }
    },
    // Phase 4: per-folder access grants. A grant lets one sub see
    // attachments stored under a specific (entity_type, entity_id,
    // folder) combo. PM-only writes; reads scoped by sub_id.
    grants: {
      list: function(subId) {
        return get('/api/subs/' + encodeURIComponent(subId) + '/attachment-grants');
      },
      create: function(subId, payload) {
        return post('/api/subs/' + encodeURIComponent(subId) + '/attachment-grants', payload);
      },
      remove: function(subId, grantId) {
        return del('/api/subs/' + encodeURIComponent(subId) + '/attachment-grants/' + encodeURIComponent(grantId));
      },
      sharedAttachments: function(subId) {
        return get('/api/subs/' + encodeURIComponent(subId) + '/shared-attachments');
      }
    },
    // Phase 5: portal invites. PMs generate magic-link invites that
    // create a role='sub' user on first click. Listing surfaces
    // outstanding (un-used, un-expired) invites for an audit view.
    invites: {
      list: function(subId) {
        return get('/api/subs/' + encodeURIComponent(subId) + '/invites');
      },
      create: function(subId, payload) {
        return post('/api/subs/' + encodeURIComponent(subId) + '/invite', payload || {});
      },
      remove: function(subId, inviteId) {
        return del('/api/subs/' + encodeURIComponent(subId) + '/invites/' + encodeURIComponent(inviteId));
      }
    }
  };

  // Production-scheduling calendar (Phase 2).
  // Persists schedule_entries server-side so the Friday meeting's
  // plan is the same on every device.
  var schedule = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.from) qs.push('from=' + encodeURIComponent(opts.from));
      if (opts.to) qs.push('to=' + encodeURIComponent(opts.to));
      if (opts.jobId) qs.push('jobId=' + encodeURIComponent(opts.jobId));
      return get('/api/schedule' + (qs.length ? '?' + qs.join('&') : ''));
    },
    create: function(payload) { return post('/api/schedule', payload); },
    update: function(id, payload) {
      // PATCH — same pattern as subsApi.updateAssignment since our
      // helpers don't expose patch directly.
      return fetch('/api/schedule/' + encodeURIComponent(id), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(payload)
      }).then(function(r) {
        return r.json().then(function(b) {
          if (!r.ok) throw new Error(b.error || 'request failed');
          return b;
        });
      });
    },
    remove: function(id) { return del('/api/schedule/' + encodeURIComponent(id)); }
  };

  // Per-job weather lookup for the schedule. Server geocodes the job's
  // address (cached on the row), pulls the NWS 7-day forecast (cached
  // in-memory by rounded coords), classifies risk, and returns one
  // entry per job keyed by id. Pass ids as an array; an empty list
  // resolves to {}.
  var weather = {
    jobs: function(jobIds) {
      var ids = (jobIds || []).filter(Boolean);
      if (!ids.length) return Promise.resolve({ weather: {} });
      var qs = 'ids=' + encodeURIComponent(ids.join(','));
      return get('/api/weather/jobs?' + qs);
    }
  };

  window.agxApi = {
    get: get, put: put, post: post, del: del,
    jobs: jobs, estimates: estimates, users: users, roles: roles, clients: clients, leads: leads, settings: settings, attachments: attachments, ai: ai, materials: materials, qbCosts: qbCosts, subs: subsApi, schedule: schedule, adminSms: adminSms, messages: messages, weather: weather,
    isOffline: isOffline,
    isAuthenticated: function() { return !!getToken() && !isOffline(); }
  };
})();
