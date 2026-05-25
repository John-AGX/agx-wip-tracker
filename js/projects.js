// Projects — CompanyCam-style first-class entity for site photos +
// walkthroughs. A project buckets photos, descriptions, markups, and
// (eventually) reports around one physical site. Links to a lead
// (during sales), a job (once sold), and a client (the buyer).
//
// This module owns two views:
//   1. List   — grid of project cards (cover photo + name + links +
//                photo count + filter chips).
//   2. Detail — hero photo + name + description + linkage strip +
//                photo grid (reuses window.p86Attachments).
//
// Mount points:
//   window.renderProjectsInto(hostEl)       — top-level list inside
//                                              My Files → Projects.
//   window.renderLinkedProjectsPanel(host, ctx)
//                                            — compact list of projects
//                                              linked to a given entity
//                                              (lead/job/estimate). Used
//                                              by the lead/job/estimate
//                                              editors. ctx shape:
//                                              { kind: 'lead'|'job'|'client',
//                                                id: '<entity id>' }.
//   window.openProject(projectId)            — open the detail view in
//                                              a full-screen overlay.
(function() {
  'use strict';

  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escapeAttr(s) {
    return String(s == null ? '' : s).replace(/"/g, '&quot;').replace(/&/g, '&amp;');
  }
  function fmtDate(s) {
    if (!s) return '';
    try { return new Date(s).toLocaleDateString(); } catch (e) { return ''; }
  }
  function fmtRelative(s) {
    if (!s) return '';
    var d = new Date(s);
    var diff = (Date.now() - d.getTime()) / 1000;
    if (diff < 60) return 'just now';
    if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
    if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
    if (diff < 86400 * 30) return Math.floor(diff / 86400) + 'd ago';
    return d.toLocaleDateString();
  }

  // List state — survives across re-renders within the page lifetime.
  // Resets on next mount.
  var _listState = {
    filter: 'all',        // 'all' | 'mine' | 'linked-lead' | 'linked-job' | 'archived'
    q: '',
    projects: [],
    loading: false,
    error: null,
    host: null            // most-recent host element for re-renders
  };

  // Detail overlay state.
  var _detailState = {
    projectId: null,
    project: null
  };

  function api() { return window.p86Api && window.p86Api.projects; }

  // ──────────────────────────────────────────────────────────────────
  // Top-level list view (mounts into the My Files Projects pane).
  // ──────────────────────────────────────────────────────────────────
  function renderProjectsInto(host) {
    if (!host) return;
    _listState.host = host;
    paintList();
    fetchAll().then(paintList).catch(function(e) {
      _listState.error = e.message || 'Failed to load projects';
      paintList();
    });
  }
  window.renderProjectsInto = renderProjectsInto;

  function fetchAll() {
    if (!api()) return Promise.reject(new Error('API not available'));
    _listState.loading = true;
    var opts = {};
    if (_listState.filter === 'archived') opts.status = 'archived';
    else opts.status = 'active';
    if (_listState.q) opts.q = _listState.q;
    return api().list(opts).then(function(r) {
      _listState.projects = (r && r.projects) || [];
      _listState.error = null;
      _listState.loading = false;
    });
  }

  function paintList() {
    var host = _listState.host;
    if (!host) return;

    var me = (window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser()) || null;
    var myId = me ? me.id : null;
    var projects = _listState.projects.slice();

    // Client-side filter chips. Server already filters by status; this
    // is the "mine" / "linked-lead" / "linked-job" refinement.
    if (_listState.filter === 'mine' && myId != null) {
      projects = projects.filter(function(p) { return Number(p.created_by) === Number(myId); });
    } else if (_listState.filter === 'linked-lead') {
      projects = projects.filter(function(p) { return !!p.lead_id; });
    } else if (_listState.filter === 'linked-job') {
      projects = projects.filter(function(p) { return !!p.job_id; });
    }

    var chips = [
      { id: 'all',          label: 'All' },
      { id: 'mine',         label: 'Mine' },
      { id: 'linked-lead',  label: 'Linked to Lead' },
      { id: 'linked-job',   label: 'Linked to Job' },
      { id: 'archived',     label: 'Archived' }
    ];

    var html =
      '<div>' +
        // Header — title + actions
        '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:10px;flex-wrap:wrap;">' +
          '<div>' +
            '<h2 style="margin:0;font-size:18px;font-weight:600;color:var(--text,#fff);">Projects</h2>' +
            '<div style="font-size:12px;color:var(--text-dim,#888);margin-top:2px;">' +
              'Photo + walkthrough buckets for sites. Link to a lead during sales; the job inherits once sold.' +
            '</div>' +
          '</div>' +
          '<div style="display:flex;gap:6px;align-items:center;">' +
            '<input id="projSearch" type="search" placeholder="Search projects…" value="' + escapeAttr(_listState.q) + '" ' +
              'style="padding:6px 10px;font-size:12px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);width:180px;" />' +
            '<button class="primary" onclick="window.p86Projects.createPrompt()" ' +
              'style="font-size:13px;padding:7px 14px;">&#x2795; New Project</button>' +
          '</div>' +
        '</div>' +

        // Filter chips
        '<div style="display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px;">' +
          chips.map(function(c) {
            var active = c.id === _listState.filter;
            return '<button onclick="window.p86Projects.setFilter(\'' + c.id + '\')" ' +
              'style="font-size:11px;padding:4px 10px;border-radius:14px;border:1px solid ' +
              (active ? 'var(--accent,#22d3ee)' : 'var(--border,#333)') + ';' +
              'background:' + (active ? 'rgba(34,211,238,0.10)' : 'transparent') + ';' +
              'color:' + (active ? 'var(--accent,#22d3ee)' : 'var(--text-dim,#aaa)') + ';' +
              'cursor:pointer;font-weight:' + (active ? '600' : '400') + ';">' +
              escapeHTML(c.label) +
            '</button>';
          }).join('') +
        '</div>' +

        // Loading / error / empty / grid
        (_listState.loading
          ? '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);font-size:13px;">Loading…</div>'
          : _listState.error
            ? '<div style="padding:14px;background:rgba(248,113,113,0.1);border:1px solid rgba(248,113,113,0.3);border-radius:8px;color:#f87171;font-size:13px;">' + escapeHTML(_listState.error) + '</div>'
            : projects.length === 0
              ? '<div style="padding:36px;text-align:center;color:var(--text-dim,#888);font-size:13px;border:1px dashed var(--border,#333);border-radius:10px;">' +
                  'No projects yet. Hit <strong>+ New Project</strong> to create one — or open a lead and create one from there.' +
                '</div>'
              : renderProjectGrid(projects)) +
      '</div>';

    host.innerHTML = html;

    // Wire search input — debounced re-fetch.
    var s = host.querySelector('#projSearch');
    if (s) {
      var t;
      s.addEventListener('input', function(e) {
        clearTimeout(t);
        var v = e.target.value;
        t = setTimeout(function() {
          _listState.q = v;
          fetchAll().then(paintList).catch(function(err) {
            _listState.error = err.message || 'Failed to load';
            paintList();
          });
        }, 250);
      });
    }
  }

  function renderProjectGrid(projects) {
    return '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px;">' +
      projects.map(projectCardHTML).join('') +
    '</div>';
  }

  function projectCardHTML(p) {
    var coverUrl = p.cover_thumb_url || p.cover_web_url || '';
    var visual = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" style="width:100%;height:140px;object-fit:cover;display:block;background:#1a1a2e;" />'
      : '<div style="height:140px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);color:var(--accent,#22d3ee);font-size:32px;">&#x1F4F8;</div>';

    var badges = [];
    if (p.lead_title)   badges.push('Lead: ' + p.lead_title);
    if (p.job_name)     badges.push('Job: ' + p.job_name);
    if (p.client_name)  badges.push('Client: ' + p.client_name);
    var badgesHtml = badges.length
      ? '<div style="display:flex;flex-wrap:wrap;gap:4px;margin-top:6px;">' +
          badges.map(function(b) {
            return '<span style="font-size:9.5px;padding:2px 6px;border:1px solid var(--border,#333);border-radius:8px;color:var(--text-dim,#aaa);">' + escapeHTML(b) + '</span>';
          }).join('') +
        '</div>'
      : '';

    return '<div onclick="window.openProject(\'' + escapeAttr(p.id) + '\')" ' +
      'style="border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;background:var(--card-bg,#0f0f1e);cursor:pointer;transition:border-color 0.12s,transform 0.12s;display:flex;flex-direction:column;" ' +
      'onmouseover="this.style.borderColor=\'rgba(79,140,255,0.5)\';" onmouseout="this.style.borderColor=\'var(--border,#333)\';">' +
      visual +
      '<div style="padding:8px 10px;flex:1;">' +
        '<div style="font-size:13px;font-weight:600;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(p.name) + '</div>' +
        '<div style="display:flex;justify-content:space-between;align-items:baseline;gap:6px;margin-top:3px;font-size:10.5px;color:var(--text-dim,#888);">' +
          '<span>&#x1F4F7; ' + Number(p.photo_count || 0) + ' photo' + (p.photo_count === 1 ? '' : 's') + '</span>' +
          '<span>' + escapeHTML(fmtRelative(p.updated_at)) + '</span>' +
        '</div>' +
        badgesHtml +
      '</div>' +
    '</div>';
  }

  function setFilter(id) {
    _listState.filter = id;
    // 'archived' needs a server refetch; the rest are pure client-side.
    if (id === 'archived' || _listState.projects.length === 0) {
      fetchAll().then(paintList);
    } else {
      paintList();
    }
  }

  function createPrompt(prefill) {
    prefill = prefill || {};
    var name = window.prompt('Project name', prefill.name || '');
    if (name == null) return Promise.resolve(null);
    name = String(name).trim();
    if (!name) return Promise.resolve(null);
    if (!api()) return Promise.reject(new Error('API not available'));
    var body = { name: name };
    if (prefill.lead_id)    body.lead_id = prefill.lead_id;
    if (prefill.job_id)     body.job_id = prefill.job_id;
    if (prefill.client_id)  body.client_id = prefill.client_id;
    if (prefill.address_text) body.address_text = prefill.address_text;
    return api().create(body).then(function(r) {
      var p = r && r.project;
      // Refresh whatever list is visible — list view + any open
      // Linked-Projects panels.
      if (_listState.host) fetchAll().then(paintList);
      _linkedPanels.forEach(function(panel) { try { renderLinkedProjectsPanel(panel.host, panel.ctx); } catch(e) {} });
      // Open the new project immediately so the user can start adding
      // photos / description.
      if (p && p.id) openProject(p.id);
      return p;
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Detail view — full-screen overlay over the current page.
  // ──────────────────────────────────────────────────────────────────
  function openProject(projectId) {
    _detailState.projectId = projectId;
    _detailState.project = null;
    var overlay = ensureDetailOverlay();
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';
    paintDetailLoading();
    if (!api()) {
      paintDetailError('API not available');
      return;
    }
    api().get(projectId).then(function(r) {
      _detailState.project = r && r.project;
      paintDetail();
    }).catch(function(e) {
      paintDetailError(e.message || 'Failed to load project');
    });
  }
  window.openProject = openProject;

  function closeDetail() {
    _detailState.projectId = null;
    _detailState.project = null;
    var overlay = document.getElementById('projDetailOverlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
    // Re-fetch list so cover photo / photo count refresh after any
    // upload / markup that happened inside detail.
    if (_listState.host) fetchAll().then(paintList);
    _linkedPanels.forEach(function(panel) { try { renderLinkedProjectsPanel(panel.host, panel.ctx); } catch(e) {} });
  }
  window.closeProjectDetail = closeDetail;

  function ensureDetailOverlay() {
    var el = document.getElementById('projDetailOverlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'projDetailOverlay';
    el.style.cssText = 'position:fixed;inset:0;z-index:9000;background:rgba(0,0,0,0.85);display:none;align-items:stretch;justify-content:center;padding:0;';
    el.innerHTML = '<div id="projDetailHost" style="background:var(--bg,#0a0a14);width:min(1100px,100%);max-height:100vh;overflow-y:auto;border-left:1px solid var(--border,#333);border-right:1px solid var(--border,#333);padding:18px 22px;"></div>';
    // Click backdrop to close (but not when clicking inside the
    // content panel).
    el.addEventListener('click', function(e) {
      if (e.target === el) closeDetail();
    });
    document.body.appendChild(el);
    return el;
  }

  function paintDetailLoading() {
    var host = document.getElementById('projDetailHost');
    if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
        '<div style="font-size:14px;color:var(--text-dim,#888);">Loading project…</div>' +
        '<button class="ee-btn secondary" onclick="window.closeProjectDetail()" style="font-size:12px;">&times; Close</button>' +
      '</div>';
  }

  function paintDetailError(msg) {
    var host = document.getElementById('projDetailHost');
    if (!host) return;
    host.innerHTML =
      '<div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:14px;">' +
        '<div style="font-size:14px;color:#f87171;">' + escapeHTML(msg) + '</div>' +
        '<button class="ee-btn secondary" onclick="window.closeProjectDetail()" style="font-size:12px;">&times; Close</button>' +
      '</div>';
  }

  function paintDetail() {
    var host = document.getElementById('projDetailHost');
    var p = _detailState.project;
    if (!host || !p) return;

    var coverUrl = p.cover_web_url || p.cover_thumb_url || '';
    var hero = coverUrl
      ? '<img src="' + escapeAttr(coverUrl) + '" alt="" style="width:100%;height:200px;object-fit:cover;display:block;border-radius:10px;background:#1a1a2e;" />'
      : '<div style="height:200px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);color:var(--accent,#22d3ee);font-size:54px;border-radius:10px;">&#x1F4F8;</div>';

    var linkBadges = [];
    if (p.lead_id)     linkBadges.push({ k: 'Lead',    v: p.lead_title || p.lead_id,        href: null });
    if (p.job_id)      linkBadges.push({ k: 'Job',     v: p.job_name || p.job_id,           href: null });
    if (p.client_id)   linkBadges.push({ k: 'Client',  v: p.client_name || p.client_id,     href: null });

    var html =
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:10px;margin-bottom:12px;">' +
        '<div style="min-width:0;">' +
          '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;margin-bottom:3px;">Project</div>' +
          '<input id="projNameInput" value="' + escapeAttr(p.name) + '" ' +
            'style="font-size:20px;font-weight:700;color:var(--text,#fff);background:transparent;border:1px solid transparent;padding:2px 4px;width:100%;max-width:600px;border-radius:4px;" ' +
            'onfocus="this.style.borderColor=\'var(--border,#333)\';" ' +
            'onblur="window.p86Projects._fieldBlur(\'name\', this.value); this.style.borderColor=\'transparent\';" />' +
          '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:4px;">' +
            'Updated ' + escapeHTML(fmtRelative(p.updated_at)) +
            (p.created_by_name ? ' &middot; created by ' + escapeHTML(p.created_by_name) : '') +
          '</div>' +
        '</div>' +
        '<div style="display:flex;gap:6px;align-items:center;flex-shrink:0;">' +
          (p.archived_at
            ? '<button class="ee-btn secondary" onclick="window.p86Projects.unarchive()" style="font-size:12px;">&#x21BA; Unarchive</button>'
            : '<button class="ee-btn secondary" onclick="window.p86Projects.archive()" style="font-size:12px;">&#x1F5C4; Archive</button>') +
          '<button class="ee-btn secondary" onclick="window.closeProjectDetail()" style="font-size:12px;">&times; Close</button>' +
        '</div>' +
      '</div>' +

      // Hero + linkage strip
      '<div style="display:grid;grid-template-columns:minmax(0,2fr) minmax(0,1fr);gap:14px;margin-bottom:14px;">' +
        '<div>' + hero + '</div>' +
        '<div style="display:flex;flex-direction:column;gap:8px;">' +
          '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;">' +
            '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">Linked to</legend>' +
            (linkBadges.length
              ? linkBadges.map(function(b) {
                  return '<div style="font-size:12px;padding:3px 0;color:var(--text,#fff);">' +
                    '<span style="color:var(--text-dim,#888);font-size:10.5px;text-transform:uppercase;letter-spacing:0.4px;margin-right:5px;">' + escapeHTML(b.k) + ':</span>' +
                    escapeHTML(b.v) +
                  '</div>';
                }).join('')
              : '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:3px 0;">Not linked yet. Use the editor below to attach this project to a lead, job, or client.</div>'
            ) +
            '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap;">' +
              '<button class="ee-btn secondary" onclick="window.p86Projects.editLinks()" style="font-size:11px;padding:4px 8px;">Edit links</button>' +
            '</div>' +
          '</fieldset>' +
          '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;">' +
            '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">Address</legend>' +
            '<input id="projAddrInput" value="' + escapeAttr(p.address_text || '') + '" placeholder="Site address" ' +
              'style="width:100%;padding:5px 7px;font-size:12px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);" ' +
              'onblur="window.p86Projects._fieldBlur(\'address_text\', this.value);" />' +
          '</fieldset>' +
        '</div>' +
      '</div>' +

      // Description
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;margin-bottom:14px;">' +
        '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">Description</legend>' +
        '<textarea id="projDescInput" rows="3" placeholder="Optional notes about the project / walkthrough scope." ' +
          'style="width:100%;padding:6px 8px;font-size:12px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);resize:vertical;font-family:inherit;" ' +
          'onblur="window.p86Projects._fieldBlur(\'description\', this.value);">' + escapeHTML(p.description || '') + '</textarea>' +
      '</fieldset>' +

      // Photos
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:6px 10px 8px;margin-bottom:14px;">' +
        '<legend style="font-size:10px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.6px;padding:0 5px;">' +
          '&#x1F4F7; Photos (' + Number(p.photo_count || 0) + ')' +
        '</legend>' +
        '<div id="projPhotosHost" style="min-height:60px;"></div>' +
      '</fieldset>';

    host.innerHTML = html;

    // Mount the standard attachments widget into the photos fieldset.
    // entity_type='project' is wired up server-side; the widget handles
    // upload, drag-drop, lightbox, captions out of the box.
    var photosHost = host.querySelector('#projPhotosHost');
    if (photosHost && window.p86Attachments && typeof window.p86Attachments.mount === 'function') {
      window.p86Attachments.mount(photosHost, {
        entityType: 'project',
        entityId: p.id,
        canEdit: true,
        onChange: function() {
          // Re-fetch the project so photo_count + cover refresh.
          if (!api()) return;
          api().get(p.id).then(function(r) {
            _detailState.project = r && r.project;
            // Don't full repaint — just update the legend counter so
            // we don't tear down the attachments widget mid-render.
            var legend = host.querySelector('fieldset:last-of-type legend');
            if (legend && _detailState.project) {
              legend.innerHTML = '&#x1F4F7; Photos (' + Number(_detailState.project.photo_count || 0) + ')';
            }
          }).catch(function() {});
        }
      });
    } else if (photosHost) {
      photosHost.innerHTML = '<div style="padding:14px;color:var(--text-dim,#888);font-size:12px;">Photos widget not loaded.</div>';
    }
  }

  // Blur-save a single field. Mirrors the lead-editor pattern:
  // optimistic local update + server PATCH. Errors revert + alert.
  function _fieldBlur(field, value) {
    var p = _detailState.project;
    if (!p || !api()) return;
    var prior = p[field];
    var clean = (value == null) ? '' : String(value);
    // No-op when nothing changed.
    if (String(prior == null ? '' : prior) === clean) return;
    p[field] = clean;
    var patch = {};
    patch[field] = clean;
    api().update(p.id, patch).catch(function(e) {
      p[field] = prior;
      alert('Save failed for ' + field + ': ' + (e.message || e));
    });
  }

  function editLinks() {
    var p = _detailState.project;
    if (!p || !api()) return;
    // Lightweight modal: three dropdowns (lead/job/client) populated
    // from window.appData. Each can be set to '' to clear.
    var prior = document.getElementById('projLinksModal');
    if (prior) prior.remove();
    var leads = (window.appData && window.appData.leads) || [];
    var jobs = (window.appData && window.appData.jobs) || [];
    var clients = (window.appData && window.appData.clients) || [];

    function options(list, current, labelFn) {
      var opts = '<option value="">— None —</option>';
      list.forEach(function(item) {
        opts += '<option value="' + escapeAttr(item.id) + '"' + (String(item.id) === String(current || '') ? ' selected' : '') + '>' +
          escapeHTML(labelFn(item)) +
        '</option>';
      });
      return opts;
    }

    var modal = document.createElement('div');
    modal.id = 'projLinksModal';
    modal.className = 'modal active';
    modal.innerHTML =
      '<div class="modal-content" style="max-width:520px;">' +
        '<div class="modal-header">Edit project links</div>' +
        '<div style="display:flex;flex-direction:column;gap:10px;">' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Lead</label>' +
            '<select id="plLead" style="width:100%;padding:7px 10px;font-size:13px;">' +
              options(leads, p.lead_id, function(l) { return l.title || ('Lead ' + l.id); }) +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Job</label>' +
            '<select id="plJob" style="width:100%;padding:7px 10px;font-size:13px;">' +
              options(jobs, p.job_id, function(j) {
                var n = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id);
                return n;
              }) +
            '</select>' +
          '</div>' +
          '<div>' +
            '<label style="font-size:11px;color:var(--text-dim,#aaa);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;display:block;margin-bottom:4px;">Client</label>' +
            '<select id="plClient" style="width:100%;padding:7px 10px;font-size:13px;">' +
              options(clients, p.client_id, function(c) { return c.name || ('Client ' + c.id); }) +
            '</select>' +
          '</div>' +
        '</div>' +
        '<div style="display:flex;justify-content:flex-end;gap:8px;margin-top:14px;">' +
          '<button class="ee-btn secondary" data-close>Cancel</button>' +
          '<button class="primary" id="plSave">Save</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.addEventListener('click', function(e) { if (e.target === modal) modal.remove(); });
    modal.querySelectorAll('[data-close]').forEach(function(b) {
      b.addEventListener('click', function() { modal.remove(); });
    });
    modal.querySelector('#plSave').addEventListener('click', function() {
      var patch = {
        lead_id:   modal.querySelector('#plLead').value || null,
        job_id:    modal.querySelector('#plJob').value || null,
        client_id: modal.querySelector('#plClient').value || null
      };
      api().update(p.id, patch).then(function(r) {
        _detailState.project = r && r.project;
        modal.remove();
        paintDetail();
        _linkedPanels.forEach(function(panel) { try { renderLinkedProjectsPanel(panel.host, panel.ctx); } catch(e) {} });
      }).catch(function(e) {
        alert('Save failed: ' + (e.message || e));
      });
    });
  }

  function archive() {
    var p = _detailState.project;
    if (!p || !api()) return;
    if (!window.confirm('Archive this project? Its photos stay attached; archived projects hide from the default list.')) return;
    api().update(p.id, { status: 'archived' }).then(function() {
      closeDetail();
    }).catch(function(e) { alert('Archive failed: ' + (e.message || e)); });
  }

  function unarchive() {
    var p = _detailState.project;
    if (!p || !api()) return;
    api().update(p.id, { status: 'active' }).then(function(r) {
      _detailState.project = r && r.project;
      paintDetail();
    }).catch(function(e) { alert('Unarchive failed: ' + (e.message || e)); });
  }

  // ──────────────────────────────────────────────────────────────────
  // Linked-Projects panel — embedded inside lead / job / client
  // editors. Lists projects whose lead_id / job_id / client_id matches
  // the host entity. Includes a "+ New Project" button that pre-links
  // to the host entity.
  // ──────────────────────────────────────────────────────────────────
  var _linkedPanels = []; // registry so we can re-render after changes
  function renderLinkedProjectsPanel(host, ctx) {
    if (!host || !ctx || !ctx.kind || !ctx.id) return;
    // De-dup the registry — overwrite any prior entry for this host.
    _linkedPanels = _linkedPanels.filter(function(p) { return p.host !== host; });
    _linkedPanels.push({ host: host, ctx: ctx });

    host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">Loading projects…</div>';
    if (!api()) {
      host.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">Projects API not loaded.</div>';
      return;
    }
    var opts = { status: 'active' };
    if (ctx.kind === 'lead')   opts.lead_id = ctx.id;
    if (ctx.kind === 'job')    opts.job_id = ctx.id;
    if (ctx.kind === 'client') opts.client_id = ctx.id;

    api().list(opts).then(function(r) {
      var rows = (r && r.projects) || [];
      var newBtn = '<button class="ee-btn secondary" onclick="window.p86Projects.createForEntity(\'' + escapeAttr(ctx.kind) + '\', \'' + escapeAttr(ctx.id) + '\')" ' +
        'style="font-size:11px;padding:4px 8px;width:100%;margin-top:6px;">&#x2795; New Project</button>';
      if (!rows.length) {
        host.innerHTML =
          '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">No projects linked yet.</div>' +
          newBtn;
        return;
      }
      host.innerHTML = rows.map(function(p) {
        var coverUrl = p.cover_thumb_url || '';
        var thumb = coverUrl
          ? '<img src="' + escapeAttr(coverUrl) + '" alt="" style="width:44px;height:44px;object-fit:cover;border-radius:4px;flex-shrink:0;background:#1a1a2e;" />'
          : '<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;background:rgba(34,211,238,0.06);color:var(--accent,#22d3ee);font-size:18px;border-radius:4px;flex-shrink:0;">&#x1F4F8;</div>';
        return '<div onclick="window.openProject(\'' + escapeAttr(p.id) + '\')" ' +
          'style="display:flex;gap:8px;align-items:center;padding:6px;border:1px solid var(--border,#333);border-radius:6px;margin-bottom:5px;cursor:pointer;background:rgba(255,255,255,0.02);transition:border-color 0.12s;" ' +
          'onmouseover="this.style.borderColor=\'rgba(79,140,255,0.5)\';" onmouseout="this.style.borderColor=\'var(--border,#333)\';">' +
          thumb +
          '<div style="min-width:0;flex:1;">' +
            '<div style="font-size:12px;font-weight:600;color:var(--text,#fff);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(p.name) + '</div>' +
            '<div style="font-size:10.5px;color:var(--text-dim,#888);">' + Number(p.photo_count || 0) + ' photo' + (p.photo_count === 1 ? '' : 's') + ' &middot; ' + escapeHTML(fmtRelative(p.updated_at)) + '</div>' +
          '</div>' +
        '</div>';
      }).join('') + newBtn;
    }).catch(function(e) {
      host.innerHTML = '<div style="font-size:12px;color:#f87171;padding:6px 0;">Failed to load: ' + escapeHTML(e.message || e) + '</div>';
    });
  }
  window.renderLinkedProjectsPanel = renderLinkedProjectsPanel;

  function createForEntity(kind, id) {
    var prefill = {};
    // Best-effort default name from the host entity's title.
    if (kind === 'lead') {
      var l = ((window.appData && window.appData.leads) || []).find(function(x) { return String(x.id) === String(id); });
      if (l) { prefill.name = l.title || ''; prefill.lead_id = id; if (l.client_id) prefill.client_id = l.client_id; }
      else prefill.lead_id = id;
    } else if (kind === 'job') {
      var j = ((window.appData && window.appData.jobs) || []).find(function(x) { return String(x.id) === String(id); });
      if (j) { prefill.name = j.title || j.name || ''; prefill.job_id = id; }
      else prefill.job_id = id;
    } else if (kind === 'client') {
      var c = ((window.appData && window.appData.clients) || []).find(function(x) { return String(x.id) === String(id); });
      if (c) { prefill.name = c.name || ''; prefill.client_id = id; }
      else prefill.client_id = id;
    }
    return createPrompt(prefill);
  }

  window.p86Projects = {
    setFilter: setFilter,
    createPrompt: createPrompt,
    createForEntity: createForEntity,
    archive: archive,
    unarchive: unarchive,
    editLinks: editLinks,
    _fieldBlur: _fieldBlur
  };
})();
