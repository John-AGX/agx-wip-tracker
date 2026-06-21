// Project 86 API client — thin fetch wrapper with JWT auth, used by data-layer code.
// Depends on window.p86Auth from js/auth.js for the token.
(function() {
  'use strict';

  function getToken() {
    return (window.p86Auth && window.p86Auth.getToken()) || localStorage.getItem('p86-auth-token');
  }

  function isOffline() {
    return window.p86Auth && window.p86Auth.isOffline();
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
      localStorage.removeItem('p86-auth-token');
      if (typeof location !== 'undefined') location.reload();
      throw new Error('Session expired');
    }
    // Parse via text so an empty / non-JSON body (server mid-restart during a
    // deploy, proxy error page, dropped connection) yields a readable error
    // instead of the raw "Unexpected end of JSON input" from r.json().
    return r.text().then(function(txt) {
      var data = null;
      if (txt && txt.length) {
        try { data = JSON.parse(txt); }
        catch (e) {
          var perr = new Error(r.ok ? 'Server returned an unreadable response — try again in a moment.'
                                    : ('HTTP ' + r.status));
          perr.status = r.status;
          throw perr;
        }
      }
      if (!r.ok) {
        var err = new Error((data && data.error) || ('HTTP ' + r.status));
        err.status = r.status;
        err.data = data;
        throw err;
      }
      if (data == null) {
        var eerr = new Error('Empty response from server — it may be restarting. Try again in a moment.');
        eerr.status = r.status;
        throw eerr;
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
    // Upload a single file. Auto-attaches the user's geolocation when
    // uploading an image and p86Geo is loaded (silent — no prompt if
    // permission was denied or never granted). Callers can override
    // by passing lat/lng directly in `extra`, or pass `extra.geo:false`
    // to skip auto-capture entirely (e.g. for bulk PDF uploads).
    upload: function(entityType, entityId, file, extra) {
      var path = '/api/attachments/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId);
      extra = extra || {};
      var skipGeo = extra.geo === false;
      var alreadyHasGeo = (extra.lat != null && extra.lng != null);
      var looksLikeImage = file && file.type && /^image\//i.test(file.type);
      if (skipGeo || alreadyHasGeo || !looksLikeImage || !window.p86Geo) {
        delete extra.geo;
        return uploadFile(path, file, extra);
      }
      // Best-effort geo capture. If it returns null (denied/timeout/
      // unsupported), we proceed without — the server-side EXIF
      // extractor still has a shot.
      return window.p86Geo.get(60000).then(function(g) {
        if (g) {
          extra.lat = g.lat;
          extra.lng = g.lng;
          if (g.accuracy != null) extra.geo_accuracy = g.accuracy;
        }
        delete extra.geo;
        return uploadFile(path, file, extra);
      });
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
    },
    // Tag suggestions scoped to one entity's attachments.
    // opts: { entity_type, entity_id, q? }
    tagsSuggest: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.entity_type) qs.push('entity_type=' + encodeURIComponent(opts.entity_type));
      if (opts.entity_id)   qs.push('entity_id=' + encodeURIComponent(opts.entity_id));
      if (opts.q)           qs.push('q=' + encodeURIComponent(opts.q));
      return get('/api/attachments/tags/suggest' + (qs.length ? '?' + qs.join('&') : ''));
    },
    // Bulk add/remove tags across many attachments. All ids must
    // share the same entity. payload = { ids:[], add:[], remove:[] }
    bulkTag: function(payload) {
      return post('/api/attachments/bulk-tag', payload);
    }
  };

  // Job-scoped Change Orders. Two URL families share the wrapper:
  //   listForJob(jobId)            → GET /api/jobs/:jobId/change-orders
  //   create(jobId, payload)        → POST /api/jobs/:jobId/change-orders
  //   get/update/remove/setStatus/linkNode → /api/change-orders/:id
  // The server-side router (server/routes/change-order-routes.js)
  // mounts both prefixes inside a single Express router at /api.
  var changeOrders = {
    listForJob: function(jobId) {
      return get('/api/jobs/' + encodeURIComponent(jobId) + '/change-orders');
    },
    create: function(jobId, payload) {
      return post('/api/jobs/' + encodeURIComponent(jobId) + '/change-orders', payload || {});
    },
    get: function(id) {
      return get('/api/change-orders/' + encodeURIComponent(id));
    },
    update: function(id, payload) {
      return put('/api/change-orders/' + encodeURIComponent(id), payload);
    },
    setStatus: function(id, status) {
      return post('/api/change-orders/' + encodeURIComponent(id) + '/status', { status: status });
    },
    linkNode: function(id, nodeId) {
      return post('/api/change-orders/' + encodeURIComponent(id) + '/link-node', { node_id: nodeId });
    },
    remove: function(id) {
      return del('/api/change-orders/' + encodeURIComponent(id));
    },
    // Cross-job org-wide list for the Jobs hub. opts: { status?:'open'|'all'|
    // 'draft'|'approved'|'applied', job?:jobId, limit? }. Default open.
    listAll: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.status) qs.push('status=' + encodeURIComponent(opts.status));
      if (opts.job) qs.push('job=' + encodeURIComponent(opts.job));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return get('/api/change-orders' + (qs.length ? '?' + qs.join('&') : ''));
    }
  };

  // Workflow items — RFIs / Submittals / Transmittals (job_workflow_items).
  // The Jobs hub uses listAll() (cross-job, org-wide) + create() (per-job);
  // the in-job UI uses listForJob(). See server/routes/job-workflow-routes.js.
  var workflowItems = {
    listAll: function(opts) {
      opts = opts || {};
      var qs = [];
      ['type', 'status', 'job', 'limit'].forEach(function(k) {
        if (opts[k] != null && opts[k] !== '') qs.push(k + '=' + encodeURIComponent(opts[k]));
      });
      return get('/api/workflow-items' + (qs.length ? '?' + qs.join('&') : ''));
    },
    listForJob: function(jobId, opts) {
      opts = opts || {};
      var qs = [];
      ['type', 'status'].forEach(function(k) { if (opts[k]) qs.push(k + '=' + encodeURIComponent(opts[k])); });
      return get('/api/jobs/' + encodeURIComponent(jobId) + '/workflow-items' + (qs.length ? '?' + qs.join('&') : ''));
    },
    create: function(jobId, payload) {
      return post('/api/jobs/' + encodeURIComponent(jobId) + '/workflow-items', payload || {});
    },
    update: function(id, payload) {
      return put('/api/workflow-items/' + encodeURIComponent(id), payload || {});
    }
  };

  // Purchase Orders — the AGX <-> sub scope-of-work contract. Mirrors
  // changeOrders + adds the per-org scope template. See
  // server/routes/purchase-order-routes.js.
  var purchaseOrders = {
    listForJob: function(jobId) {
      return get('/api/jobs/' + encodeURIComponent(jobId) + '/purchase-orders');
    },
    listAll: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.status) qs.push('status=' + encodeURIComponent(opts.status));
      if (opts.job) qs.push('job=' + encodeURIComponent(opts.job));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return get('/api/purchase-orders' + (qs.length ? '?' + qs.join('&') : ''));
    },
    get: function(id) { return get('/api/purchase-orders/' + encodeURIComponent(id)); },
    create: function(jobId, payload) {
      return post('/api/jobs/' + encodeURIComponent(jobId) + '/purchase-orders', payload || {});
    },
    update: function(id, payload) { return put('/api/purchase-orders/' + encodeURIComponent(id), payload || {}); },
    setStatus: function(id, status, acceptance) {
      return post('/api/purchase-orders/' + encodeURIComponent(id) + '/status', { status: status, acceptance: acceptance });
    },
    remove: function(id) { return del('/api/purchase-orders/' + encodeURIComponent(id)); },
    getScopeTemplate: function() { return get('/api/purchase-orders/scope-template'); },
    setScopeTemplate: function(template) { return put('/api/purchase-orders/scope-template', { template: template }); }
  };

  // Polymorphic reports (Phase 2) — projects (and future leads /
  // estimates) share the legacy job_reports table via entity_type +
  // entity_id columns. The legacy /api/jobs/:jobId/reports route
  // still owns 'job' rows with job-specific photo-source logic.
  var reports = {
    list: function(entityType, entityId) {
      return get('/api/reports/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId));
    },
    get: function(entityType, entityId, reportId) {
      return get('/api/reports/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/' + encodeURIComponent(reportId));
    },
    create: function(entityType, entityId, payload) {
      return post('/api/reports/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId), payload || {});
    },
    update: function(entityType, entityId, reportId, payload) {
      return patch('/api/reports/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/' + encodeURIComponent(reportId), payload);
    },
    remove: function(entityType, entityId, reportId) {
      return del('/api/reports/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/' + encodeURIComponent(reportId));
    }
  };

  // Org-level tag catalog (Phase 1.7). Curated master list of tag
  // names per organization — feeds autocomplete across all surfaces.
  var orgTags = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.q) qs.push('q=' + encodeURIComponent(opts.q));
      if (opts.include_archived) qs.push('include_archived=1');
      return get('/api/org-tags' + (qs.length ? '?' + qs.join('&') : ''));
    },
    suggest: function(q) {
      var qs = q ? '?q=' + encodeURIComponent(q) : '';
      return get('/api/org-tags/suggest' + qs);
    },
    create: function(payload) { return post('/api/org-tags', payload); },
    update: function(id, payload) { return patch('/api/org-tags/' + encodeURIComponent(id), payload); },
    merge: function(payload) { return post('/api/org-tags/merge', payload); }
  };

  // Org-level surface metadata (name, branding kit). branding() is the
  // all-users read powering the shop-drawing titleblock logo; manifest()
  // is the System Map summary feed.
  var org = {
    branding: function() { return get('/api/org/branding'); },
    manifest: function() { return get('/api/org/manifest'); }
  };

  // Per-org folder templates. Customizes the default folder set shown
  // for new leads / estimates / jobs / clients before any file exists.
  // list() returns { templates: { <type>: { effective, custom,
  // defaults, customized, updated_at } } }. save() upserts a custom
  // list; reset() drops the custom row → reverts to built-in defaults.
  var folderTemplates = {
    list: function() { return get('/api/folder-templates'); },
    save: function(entityType, folders) {
      return put('/api/folder-templates/' + encodeURIComponent(entityType), { folders: folders || [] });
    },
    reset: function(entityType) {
      return del('/api/folder-templates/' + encodeURIComponent(entityType));
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

  // Projects — CompanyCam-style first-class entity that buckets photos
  // + markups + reports around one walkthrough. See
  // server/routes/project-routes.js for the data shape.
  var projects = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.q) qs.push('q=' + encodeURIComponent(opts.q));
      if (opts.status) qs.push('status=' + encodeURIComponent(opts.status));
      if (opts.lead_id) qs.push('lead_id=' + encodeURIComponent(opts.lead_id));
      if (opts.job_id) qs.push('job_id=' + encodeURIComponent(opts.job_id));
      if (opts.client_id) qs.push('client_id=' + encodeURIComponent(opts.client_id));
      if (opts.tag) qs.push('tag=' + encodeURIComponent(opts.tag));
      if (opts.has_pair) qs.push('has_pair=1');
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return get('/api/projects' + (qs.length ? '?' + qs.join('&') : ''));
    },
    get: function(id) { return get('/api/projects/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/projects', payload); },
    update: function(id, payload) { return patch('/api/projects/' + encodeURIComponent(id), payload); },
    archive: function(id) { return del('/api/projects/' + encodeURIComponent(id)); },
    // Activity feed for the detail timeline.
    activity: function(id, opts) {
      opts = opts || {};
      var qs = [];
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      if (opts.before) qs.push('before=' + encodeURIComponent(opts.before));
      return get('/api/projects/' + encodeURIComponent(id) + '/activity' + (qs.length ? '?' + qs.join('&') : ''));
    },
    // Tag autocomplete source.
    suggestTags: function(q) {
      var qs = q ? '?q=' + encodeURIComponent(q) : '';
      return get('/api/projects/tags/suggest' + qs);
    },
    // Before/After pair sub-API.
    pairs: {
      list: function(projectId) {
        return get('/api/projects/' + encodeURIComponent(projectId) + '/pairs');
      },
      create: function(projectId, payload) {
        return post('/api/projects/' + encodeURIComponent(projectId) + '/pairs', payload);
      },
      remove: function(projectId, pairId) {
        return del('/api/projects/' + encodeURIComponent(projectId) + '/pairs/' + encodeURIComponent(pairId));
      }
    }
  };

  // Tasks — polymorphic to-do entity. See server/routes/tasks-routes.js.
  // list() filters mirror the GET query params exactly; create/update
  // accept the body fields the route's EDITABLE_FIELDS allowlist permits.
  var tasks = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.assignee) qs.push('assignee=' + encodeURIComponent(opts.assignee));
      if (opts.status) qs.push('status=' + encodeURIComponent(opts.status));
      if (opts.exclude_done) qs.push('exclude_done=1');
      if (opts.kind) qs.push('kind=' + encodeURIComponent(opts.kind));
      // entity_type can be sent alone (all tasks of a type, e.g. lead
      // follow-ups) or with entity_id (one entity's tasks).
      if (opts.entity_type) {
        qs.push('entity_type=' + encodeURIComponent(opts.entity_type));
        if (opts.entity_id) qs.push('entity_id=' + encodeURIComponent(opts.entity_id));
      }
      if (opts.due_before) qs.push('due_before=' + encodeURIComponent(opts.due_before));
      if (opts.due_after) qs.push('due_after=' + encodeURIComponent(opts.due_after));
      if (opts.q) qs.push('q=' + encodeURIComponent(opts.q));
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return get('/api/tasks' + (qs.length ? '?' + qs.join('&') : ''));
    },
    get: function(id) { return get('/api/tasks/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/tasks', payload); },
    update: function(id, payload) { return patch('/api/tasks/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/tasks/' + encodeURIComponent(id)); }
  };

  // My Notes — personal, private scratchpad. Mirrors the tasks/schedule
  // verb shape. Server scopes every call to (org, user); a second user
  // never sees another's notes. See server/routes/notes-routes.js.
  var notes = {
    list: function() { return get('/api/notes'); },
    create: function(payload) { return post('/api/notes', payload); },
    update: function(id, payload) { return patch('/api/notes/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/notes/' + encodeURIComponent(id)); }
  };

  // Combined map feed — org-scoped leads + jobs with plottable coords
  // for the Summary combined map. See server/routes/map-routes.js.
  var map = {
    entities: function() { return get('/api/map/entities'); }
  };

  // Personal calendar events — the per-user Assistant calendar. Every
  // call is owner + org scoped server-side. list({from,to}) windows to
  // a date range. See server/routes/calendar-routes.js.
  var calendar = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.from) qs.push('from=' + encodeURIComponent(opts.from));
      if (opts.to) qs.push('to=' + encodeURIComponent(opts.to));
      // Scope to one linked record's appointments (entity-page panel).
      if (opts.entity_type && opts.entity_id) {
        qs.push('entity_type=' + encodeURIComponent(opts.entity_type));
        qs.push('entity_id=' + encodeURIComponent(opts.entity_id));
      }
      return get('/api/calendar' + (qs.length ? '?' + qs.join('&') : ''));
    },
    create: function(payload) { return post('/api/calendar', payload); },
    update: function(id, payload) { return patch('/api/calendar/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/calendar/' + encodeURIComponent(id)); }
  };

  // Plans & Takeoffs — scale-drawing documents. list() is light (no
  // pages payload); get(id) returns the full per-page pages JSONB.
  var plans = {
    list: function(opts) {
      opts = opts || {};
      var qs = [];
      if (opts.q) qs.push('q=' + encodeURIComponent(opts.q));
      if (opts.status) qs.push('status=' + encodeURIComponent(opts.status));
      if (opts.entity_type && opts.entity_id) {
        qs.push('entity_type=' + encodeURIComponent(opts.entity_type));
        qs.push('entity_id=' + encodeURIComponent(opts.entity_id));
      }
      if (opts.limit) qs.push('limit=' + encodeURIComponent(opts.limit));
      return get('/api/plans' + (qs.length ? '?' + qs.join('&') : ''));
    },
    get: function(id) { return get('/api/plans/' + encodeURIComponent(id)); },
    create: function(payload) { return post('/api/plans', payload); },
    update: function(id, payload) { return patch('/api/plans/' + encodeURIComponent(id), payload); },
    remove: function(id) { return del('/api/plans/' + encodeURIComponent(id)); }
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
    },
    projects: function(projectIds) {
      var ids = (projectIds || []).filter(Boolean);
      if (!ids.length) return Promise.resolve({ weather: {} });
      var qs = 'ids=' + encodeURIComponent(ids.join(','));
      return get('/api/weather/projects?' + qs);
    },
    // Direct lat/lng forecast — used by the header weather chip
    // when the browser hands us geolocation coords. Skips the
    // job-geocode round-trip the .jobs() endpoint goes through.
    coords: function(lat, lng) {
      var qs = 'lat=' + encodeURIComponent(lat) + '&lng=' + encodeURIComponent(lng);
      return get('/api/weather/coords?' + qs);
    }
  };

  // Explorer-style folder tree for any entity bucket. See
  // server/routes/file-folders-routes.js. The legacy attachments.folder
  // string is dual-written server-side, so existing readers keep working.
  var fileFolders = {
    tree: function(entityType, entityId) {
      return get('/api/file-folders/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId));
    },
    create: function(entityType, entityId, payload) {
      return post('/api/file-folders/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId), payload || {});
    },
    update: function(entityType, entityId, folderId, payload) {
      return patch('/api/file-folders/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/' + encodeURIComponent(folderId), payload || {});
    },
    remove: function(entityType, entityId, folderId) {
      return del('/api/file-folders/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/' + encodeURIComponent(folderId));
    },
    moveFiles: function(entityType, entityId, ids, folderId) {
      return post('/api/file-folders/' + encodeURIComponent(entityType) + '/' + encodeURIComponent(entityId) + '/move-files', { ids: ids || [], folder_id: folderId || null });
    }
  };

  window.p86Api = {
    get: get, put: put, post: post, del: del, patch: patch,
    fileFolders: fileFolders,
    jobs: jobs, estimates: estimates, users: users, roles: roles, clients: clients, leads: leads, settings: settings, attachments: attachments, ai: ai, materials: materials, qbCosts: qbCosts, subs: subsApi, schedule: schedule, adminSms: adminSms, messages: messages, weather: weather, projects: projects, tasks: tasks, notes: notes, map: map, calendar: calendar, plans: plans, orgTags: orgTags, org: org, folderTemplates: folderTemplates, reports: reports, changeOrders: changeOrders, workflowItems: workflowItems, purchaseOrders: purchaseOrders,
    isOffline: isOffline,
    isAuthenticated: function() { return !!getToken() && !isOffline(); }
  };
})();
