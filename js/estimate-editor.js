// AGX Estimate Editor — Phase A.
//
// Full-page editor that replaces the modal. Sticky header with linked-lead
// + linked-client chips and a live totals strip. Body splits into three
// tabs: Line Items (the meat), Details (header info, addresses, manager,
// scope, default markup), Preview (placeholder until Phase C).
//
// Autosave on blur — every input commits straight to appData.estimates /
// appData.estimateLines and triggers saveData(). The list view re-renders
// on close so a user can pop in/out without losing context.
(function() {
  'use strict';

  var _currentId = null;
  var _saveTimer = null;
  // Save status tracker — drives the indicator + Save button in the
  // sticky header. 'idle' = nothing pending, 'pending' = local debounce
  // running, 'saving' = saveData has fired and the server push is in
  // flight, 'saved' = recently saved (hold for 2s), 'retrying' = push
  // failed once, app.js is auto-retrying with backoff, 'error' = retries
  // exhausted (visible until next save).
  var _saveState = 'idle';

  function setSaveState(state) {
    _saveState = state;
    renderSaveIndicator();
  }

  // Subscribe to the global push pipeline once. Translates
  // app.js push status events into the editor's local state so the
  // save indicator reflects the actual server result instead of an
  // optimistic 700ms timer.
  if (typeof window !== 'undefined' && window.agxPushStatus &&
      typeof window.agxPushStatus.subscribe === 'function') {
    window.agxPushStatus.subscribe(function(status, err) {
      if (status === 'saving')   setSaveState('saving');
      else if (status === 'saved') {
        setSaveState('saved');
        setTimeout(function() {
          if (_saveState === 'saved') setSaveState('idle');
        }, 2000);
      }
      else if (status === 'retrying') setSaveState('retrying');
      else if (status === 'failed')   setSaveState('error');
    });
  }

  function debouncedSave() {
    if (_saveTimer) clearTimeout(_saveTimer);
    setSaveState('pending');
    _saveTimer = setTimeout(function() {
      _saveTimer = null;
      runSaveNow();
    }, 400);
  }

  // Force an immediate save — used by closeEstimateEditor and the manual
  // Save button. The push pipeline (in app.js) handles its own retry
  // and emits status events the subscribe handler above translates
  // into editor state. Local writes are synchronous so we know that
  // succeeded; the server-side outcome is async.
  function runSaveNow() {
    if (typeof saveData !== 'function') { setSaveState('error'); return; }
    setSaveState('saving');
    try {
      saveData();
      // If we're offline (no api / unauth), saveData wrote locally and
      // returned without scheduling a push — flip to "saved" once.
      if (!window.agxApi || !window.agxApi.isAuthenticated()) {
        setTimeout(function() {
          if (_saveState === 'saving') setSaveState('saved');
          setTimeout(function() {
            if (_saveState === 'saved') setSaveState('idle');
          }, 2000);
        }, 200);
      }
      // Otherwise the push status subscription drives the indicator
      // forward as the real network call resolves.
    } catch (e) {
      console.warn('Manual save failed:', e);
      setSaveState('error');
    }
  }

  function renderSaveIndicator() {
    var el = document.getElementById('ee-save-indicator');
    if (!el) return;
    var dot, label, color;
    // CSS vars instead of hardcoded hex so the indicator picks up
    // light-mode-darker variants automatically (e.g. --yellow goes
    // #fbbf24 → #d97706 in light mode for legibility on white).
    switch (_saveState) {
      case 'pending':  dot = '●'; label = 'Unsaved'; color = 'var(--yellow,#fbbf24)'; break;
      case 'saving':   dot = '●'; label = 'Saving…'; color = 'var(--accent,#60a5fa)'; break;
      case 'saved':    dot = '✓'; label = 'Saved'; color = 'var(--green,#34d399)'; break;
      case 'retrying': dot = '⟳'; label = 'Retrying…'; color = 'var(--yellow,#fbbf24)'; break;
      case 'error':    dot = '!'; label = 'Save failed — will retry on next edit'; color = 'var(--red,#f87171)'; break;
      default:         dot = '○'; label = 'No changes'; color = 'var(--text-dim,#888)'; break;
    }
    el.style.color = color;
    el.innerHTML = '<span style="font-weight:700;margin-right:5px;">' + dot + '</span>' + label;
  }

  function getEstimate() {
    if (!_currentId || !window.appData) return null;
    return appData.estimates.find(function(e) { return e.id === _currentId; }) || null;
  }

  // Returns lines belonging to the estimate AND to the currently-active
  // alternate. Old estimates without an alternate id fall back to the
  // estimate's default alternate during ensureAlternates().
  function getLines() {
    if (!_currentId || !window.appData) return [];
    var est = getEstimate();
    var altId = est && est.activeAlternateId;
    return (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === _currentId && l.alternateId === altId;
    });
  }
  function getAllLinesForEstimate() {
    if (!_currentId || !window.appData) return [];
    return (appData.estimateLines || []).filter(function(l) { return l.estimateId === _currentId; });
  }
  function getActiveAlternate() {
    var est = getEstimate();
    if (!est || !est.alternates) return null;
    return est.alternates.find(function(a) { return a.id === est.activeAlternateId; }) || est.alternates[0] || null;
  }

  // Idempotent migration. Runs every time an estimate is opened so old
  // records (no alternates array, lines without alternateId, alternates
  // missing the `scope` field) get a clean default and behave the same as
  // fresh ones. Saves silently after backfill so the cleaned state
  // persists.
  function ensureAlternates(est) {
    if (!est) return;
    var changed = false;
    if (!est.alternates || !est.alternates.length) {
      est.alternates = [{ id: 'alt_default', name: 'Base', isDefault: true, scope: '' }];
      changed = true;
    }
    if (!est.activeAlternateId || !est.alternates.find(function(a) { return a.id === est.activeAlternateId; })) {
      est.activeAlternateId = est.alternates[0].id;
      changed = true;
    }
    // Backfill `scope` so the right-panel textarea has a target on every
    // alternate. The first alternate inherits the legacy estimate-level
    // scopeOfWork on first open so existing data isn't lost.
    var firstAlt = est.alternates[0];
    if (firstAlt && firstAlt.scope == null) {
      firstAlt.scope = est.scopeOfWork || '';
      changed = true;
    }
    est.alternates.forEach(function(a) {
      if (a.scope == null) { a.scope = ''; changed = true; }
    });
    var defaultId = est.alternates[0].id;
    (appData.estimateLines || []).forEach(function(l) {
      if (l.estimateId === est.id && !l.alternateId) {
        l.alternateId = defaultId;
        changed = true;
      }
    });
    if (changed) debouncedSave();
  }

  function fmtCurrency(v) {
    if (v == null || isNaN(v)) v = 0;
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v);
  }
  function num(v) { var n = parseFloat(v); return isNaN(n) ? 0 : n; }

  // ──────────────────────────────────────────────────────────────────
  // Open / close — swap visibility between the estimates list view and
  // the editor. We reuse the existing list view div and the editor view
  // div is what gets populated by this module.
  // ──────────────────────────────────────────────────────────────────

  function openEstimateEditor(estimateId) {
    // Block editor while the initial server fetch is in-flight — opens
    // during the gap could let the user type edits against stale cache
    // that get silently overwritten when the fetch resolves.
    if (typeof window.agxDataLoading === 'function' && window.agxDataLoading()) {
      alert('Still loading from server — try again in a moment.');
      return;
    }
    var est = (window.appData && appData.estimates || []).find(function(e) { return e.id === estimateId; });
    if (!est) { alert('Estimate not found.'); return; }
    _currentId = estimateId;
    // Idempotent: ensures the estimate has at least one alternate and that
    // every line is tagged with one. Old records get a "Base" alternate
    // and have their existing lines silently associated to it.
    ensureAlternates(est);

    var listView = document.getElementById('estimates-list-view');
    var editorView = document.getElementById('estimate-editor-view');
    if (listView) listView.style.display = 'none';
    if (editorView) editorView.style.display = '';
    // Hide the parent Leads/Estimates/Clients/Subs nav while in the
    // editor — the sticky header's Back button drives return. Restored
    // on closeEstimateEditor.
    var mainTabs = document.getElementById('estimates-main-tabs');
    if (mainTabs) mainTabs.style.display = 'none';

    // Title input — keystrokes update the estimate title live; debounced save
    var titleEl = document.getElementById('ee-title');
    if (titleEl) {
      titleEl.value = est.title || '';
      titleEl.oninput = function() {
        var e = getEstimate(); if (!e) return;
        e.title = titleEl.value;
        debouncedSave();
      };
    }

    renderHeaderChips();
    renderAlternateTabs();
    renderTotals();
    renderDetailsForm();
    renderLineItems();
    renderScopePanel();
    switchEstimateEditorTab('lines');
    // Reset save state to idle on every fresh editor open so we don't
    // carry "saved" / "error" indicators from a previous session.
    setSaveState('idle');
    // Persist nav state so a refresh lands back inside this estimate
    // editor rather than the estimates list.
    if (typeof window.agxNavSave === 'function') window.agxNavSave();
  }

  // Scope textarea — bound to the ACTIVE alternate's scope so Good /
  // Better / Best can each carry their own narrative. Falls back to
  // the legacy estimate.scopeOfWork only on first migration (handled
  // in ensureAlternates). Changes write straight through to the
  // alternate.
  //
  // Three host divs may exist depending on the user's path:
  //   #ee-scope-panel        — legacy id (now unused but tolerated)
  //   #ee-scope-panel-modal  — popup quick-access modal body
  //   #ee-scope-panel-page   — full-page Scope sub-tab body
  // Whichever is visible (or all of them) gets populated. Each
  // textarea writes back to the same alt.scope so they stay in sync.
  function renderScopePanel() {
    var hosts = ['ee-scope-panel', 'ee-scope-panel-modal', 'ee-scope-panel-page']
      .map(function(id) { return document.getElementById(id); })
      .filter(Boolean);
    if (!hosts.length) return;
    var est = getEstimate();
    var alt = getActiveAlternate();
    hosts.forEach(function(pane, i) {
      if (!est || !alt) { pane.innerHTML = ''; return; }
      var taId = 'ee-alt-scope-' + i;
      pane.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;">' +
          '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Scope of Work</div>' +
          '<div style="font-size:11px;color:#4f8cff;font-weight:600;">' + escapeHTML(alt.name || 'Alternate') + '</div>' +
        '</div>' +
        '<textarea id="' + taId + '" rows="18" placeholder="Bulleted scope, narrative, or whatever the proposal needs. This is per-alternate." ' +
          'style="width:100%;resize:vertical;font-family:inherit;font-size:13px;line-height:1.55;padding:12px 14px;background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;color:var(--text,#fff);">' +
          escapeHTML(alt.scope || '') +
        '</textarea>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:6px;">Saved per alternate. Used by the Preview tab and PDF/Buildertrend exports.</div>';
      var ta = document.getElementById(taId);
      if (ta) {
        ta.oninput = function() {
          var a = getActiveAlternate();
          if (!a) return;
          a.scope = ta.value;
          debouncedSave();
          // Mirror across the other open scope textareas so modal +
          // sub-tab stay in sync without a full re-render.
          hosts.forEach(function(otherPane, j) {
            if (j === i) return;
            var otherTa = otherPane.querySelector('textarea');
            if (otherTa && otherTa.value !== ta.value) otherTa.value = ta.value;
          });
        };
      }
    });
  }

  // Open / close the Scope of Work modal. Exposed on window so the
  // AI assistant (or any other code) can drive it programmatically.
  function openScopeModal() {
    var modal = document.getElementById('ee-scope-modal');
    if (!modal) return;
    renderScopePanel();
    modal.classList.add('active');
    // Focus the textarea on open so the user can start typing.
    var ta = modal.querySelector('textarea');
    if (ta) setTimeout(function() { ta.focus(); }, 0);
  }
  function closeScopeModal() {
    var modal = document.getElementById('ee-scope-modal');
    if (modal) modal.classList.remove('active');
  }
  window.openScopeModal = openScopeModal;
  window.closeScopeModal = closeScopeModal;

  function closeEstimateEditor() {
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    if (typeof saveData === 'function') saveData();
    // If a push is mid-flight (_saveState saving/retrying/pending),
    // we briefly hold the close so the request can complete. Without
    // this hold, a user who edits + immediately closes the editor
    // could lose the last server commit attempt because the page
    // tab might unload before the network call resolves.
    var pending = (_saveState === 'saving' || _saveState === 'retrying' || _saveState === 'pending');
    var inFlight = (window.agxPushStatus && typeof window.agxPushStatus.inFlight === 'function')
      ? window.agxPushStatus.inFlight()
      : Promise.resolve();
    var actuallyClose = function() {
      _currentId = null;
      _saveState = 'idle';
      var listView = document.getElementById('estimates-list-view');
      var editorView = document.getElementById('estimate-editor-view');
      if (editorView) editorView.style.display = 'none';
      if (listView) listView.style.display = '';
      // Restore the parent Leads/Estimates/Clients/Subs nav we hid on open.
      var mainTabs = document.getElementById('estimates-main-tabs');
      if (mainTabs) mainTabs.style.display = '';
      if (typeof renderEstimatesList === 'function') renderEstimatesList();
    };
    if (pending) {
      // Wait up to 3 seconds for the push to settle. Beyond that we
      // close anyway — the local save is already on disk, and the
      // retry pipeline keeps trying in the background.
      Promise.race([
        inFlight,
        new Promise(function(resolve) { setTimeout(resolve, 3000); })
      ]).finally(actuallyClose);
    } else {
      actuallyClose();
    }
  }

  function switchEstimateEditorTab(name) {
    document.querySelectorAll('[data-ee-tab]').forEach(function(btn) {
      btn.classList.toggle('active', btn.dataset.eeTab === name);
    });
    document.querySelectorAll('.ee-tab-content').forEach(function(el) {
      // Use the explicit token instead of '' so any stale inline display
      // value left over from CSS-rule confusion can't override us. Display
      // gets re-set below for the target pane.
      el.style.display = 'none';
    });
    var target = document.getElementById('ee-tab-' + name);
    if (target) target.style.display = 'block';

    // Per-tab on-show renderers. Wrapped in try/catch so a renderer
    // failure surfaces in the console instead of leaving the tab
    // visually swapped but content broken / empty.
    try {
      if (name === 'details') {
        // Re-render the form on every show so values reflect the latest
        // estimate state. The init-time render at openEstimateEditor was
        // a one-shot — without this, changes that originated outside the
        // form (e.g., via the AI assistant) wouldn't appear here.
        renderDetailsForm();
      } else if (name === 'scope') {
        // Re-render so the textarea reflects the active alternate's
        // current scope. Both the page tab + the modal share the same
        // populator — renderScopePanel walks all known hosts.
        renderScopePanel();
      } else if (name === 'preview' && typeof window.renderEstimatePreview === 'function') {
        // Preview tab is rendered on demand by js/estimate-preview.js
        // since pulling the template is async (one network round-trip
        // the first time).
        window.renderEstimatePreview();
      } else if (name === 'photos') {
        var mountEl = document.getElementById('ee-photos-mount');
        if (!mountEl) {
          console.warn('[estimate-editor] photos mount point missing');
        } else if (!_currentId) {
          mountEl.innerHTML = '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;font-style:italic;">No estimate loaded.</div>';
        } else if (window.agxAttachments && typeof window.agxAttachments.mount === 'function') {
          // If the estimate was created from a lead (has lead_id), surface
          // the lead's attachments alongside the estimate's own as a
          // read-only "From lead" section. Read-only is enforced in the
          // attachments widget — no upload/delete UI for the parent set.
          var est = getEstimate();
          var mountOpts = {
            entityType: 'estimate',
            entityId: _currentId,
            canEdit: true
          };
          if (est && est.lead_id) {
            mountOpts.parentEntity = {
              entityType: 'lead',
              entityId: est.lead_id,
              label: 'From lead'
            };
          }
          window.agxAttachments.mount(mountEl, mountOpts);
        } else {
          mountEl.innerHTML = '<div style="padding:18px;color:var(--yellow,#fbbf24);font-size:12px;">Attachments widget not loaded — refresh the page.</div>';
          console.warn('[estimate-editor] window.agxAttachments not available; can not mount photos tab');
        }
      }
    } catch (e) {
      console.warn('[estimate-editor] switchEstimateEditorTab(' + name + ') renderer threw:', e);
    }
  }

  // Expose the currently-open estimate for the preview module so it doesn't
  // have to crack open the IIFE's private state.
  window.getActiveEstimateForPreview = function() { return getEstimate(); };

  // ──────────────────────────────────────────────────────────────────
  // Header chips — linked lead and linked client surface here so users
  // can jump back to either with one click.
  // ──────────────────────────────────────────────────────────────────

  function renderHeaderChips() {
    var est = getEstimate();
    var chipsEl = document.getElementById('ee-linked-chips');
    if (!chipsEl) return;
    var html = '';

    if (est.client_id) {
      var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
      var c = clients.find(function(x) { return x.id === est.client_id; });
      if (c) {
        html += '<span style="display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:14px;background:rgba(79,140,255,0.12);color:#4f8cff;font-size:11px;font-weight:600;">' +
          '<span>&#x1F465;</span>' + escapeHTML(c.name) +
          (c.community_name && c.community_name !== c.name ? ' · ' + escapeHTML(c.community_name) : '') +
        '</span>';
      }
    }
    if (est.lead_id) {
      var leads = (window.agxLeads && window.agxLeads.getCached && window.agxLeads.getCached()) || [];
      var lead = leads.find(function(x) { return x.id === est.lead_id; });
      if (lead) {
        html += '<button class="ee-btn secondary" onclick="jumpToLeadFromEstimate(\'' + escapeHTML(lead.id) + '\')" style="display:inline-flex;align-items:center;gap:6px;">' +
          '<span>&#x1F4CB;</span>From lead: ' + escapeHTML(lead.title) + ' &rarr;' +
        '</button>';
      } else {
        // Lead isn't in the local cache yet (user opened the estimate
        // without first visiting the Leads tab). Render a clickable
        // placeholder, fetch the lead by id, and re-render once it
        // resolves so the title shows up.
        html += '<button class="ee-btn secondary" onclick="jumpToLeadFromEstimate(\'' + escapeHTML(est.lead_id) + '\')" style="display:inline-flex;align-items:center;gap:6px;background:rgba(251,191,36,0.10);color:var(--yellow,#fbbf24);">' +
          '<span>&#x1F4CB;</span>Linked to lead &rarr;' +
        '</button>';
        if (window.agxApi && window.agxApi.leads && typeof window.agxApi.leads.get === 'function') {
          window.agxApi.leads.get(est.lead_id).then(function(res) {
            if (res && res.lead) {
              // Push into the cache so subsequent renders are instant.
              if (window.agxLeads && typeof window.agxLeads.cacheLead === 'function') {
                window.agxLeads.cacheLead(res.lead);
              }
              renderHeaderChips();
            }
          }).catch(function() { /* lead deleted or no perms — leave placeholder */ });
        }
      }
    }
    chipsEl.innerHTML = html;
  }

  // Closes the editor, switches to the Leads sub-tab, then opens the
  // lead detail page. The sub-tab switch matters now that the lead
  // detail renders inline inside the Leads sub-tab — without it, the
  // detail view mounts but stays hidden because the sub-tab is on
  // Estimates.
  function jumpToLeadFromEstimate(leadId) {
    closeEstimateEditor();
    setTimeout(function() {
      if (typeof window.switchEstimatesSubTab === 'function') {
        window.switchEstimatesSubTab('leads');
      }
      if (typeof window.openEditLeadModal === 'function') {
        // A second tick lets the leads list render before the detail
        // view re-parents the form — avoids re-rendering races where
        // the leads cache reload kicks off concurrently.
        setTimeout(function() { window.openEditLeadModal(leadId); }, 50);
      }
    }, 80);
  }

  // ──────────────────────────────────────────────────────────────────
  // Alternates / tiers — Good / Better / Best style parallel line sets.
  // Tax / fees / round-up are estimate-wide; each alternate has its
  // own subtotal -> markup -> client total computed from its own lines.
  // ──────────────────────────────────────────────────────────────────

  function renderAlternateTabs() {
    var wrap = document.getElementById('ee-alternate-tabs');
    if (!wrap) return;
    var est = getEstimate();
    if (!est || !est.alternates) { wrap.innerHTML = ''; return; }
    var activeId = est.activeAlternateId;
    var html = '';
    est.alternates.forEach(function(a) {
      var isActive = (a.id === activeId);
      var excluded = !!a.excludeFromTotal;
      var lineCount = (appData.estimateLines || []).filter(function(l) {
        return l.estimateId === est.id && l.alternateId === a.id && l.section !== '__section_header__';
      }).length;
      var bg = excluded ? 'rgba(255,255,255,0.02)' : (isActive ? 'rgba(79,140,255,0.18)' : 'transparent');
      var border = excluded ? 'var(--border,#333)' : (isActive ? '#4f8cff' : 'var(--border,#333)');
      var color = excluded ? 'var(--text-dim,#666)' : (isActive ? '#fff' : 'var(--text-dim,#888)');
      var nameStyle = excluded ? 'text-decoration:line-through;opacity:0.7;' : '';
      // Group tab is a flex container with two zones:
      //   1. inclusion checkbox (toggle whether this group ships in the
      //      proposal + counts toward the total)
      //   2. clickable label (switch active group for editing)
      var checkboxTitle = excluded ? 'Excluded from proposal — click to include' : 'Included in proposal — click to exclude';
      html += '<div style="display:inline-flex;align-items:stretch;border:1px solid ' + border + ';border-radius:18px;background:' + bg + ';overflow:hidden;">' +
        '<label title="' + checkboxTitle + '" style="display:inline-flex;align-items:center;padding:0 8px;cursor:pointer;border-right:1px solid var(--border,#333);">' +
          '<input type="checkbox" ' + (excluded ? '' : 'checked') + ' ' +
            'onchange="toggleGroupInclude(\'' + escapeHTML(a.id) + '\', this.checked)" ' +
            'style="margin:0;cursor:pointer;accent-color:#4f8cff;" />' +
        '</label>' +
        '<button onclick="switchAlternate(\'' + escapeHTML(a.id) + '\')" ' +
          'style="padding:6px 14px;border:none;background:transparent;color:' + color + ';font-size:12px;font-weight:600;cursor:pointer;display:inline-flex;align-items:center;gap:6px;' + nameStyle + '">' +
          escapeHTML(a.name) +
          '<span style="font-size:10px;color:var(--text-dim,#888);font-weight:400;">' + lineCount + '</span>' +
        '</button>' +
      '</div>';
    });
    wrap.innerHTML = html;

    // Disable Delete when only one group exists — there's always at least
    // one group on an estimate.
    var deleteBtn = document.getElementById('ee-altDeleteBtn');
    if (deleteBtn) deleteBtn.disabled = (est.alternates.length <= 1);
  }

  function toggleGroupInclude(altId, included) {
    var est = getEstimate();
    if (!est || !est.alternates) return;
    var a = est.alternates.find(function(x) { return x.id === altId; });
    if (!a) return;
    a.excludeFromTotal = !included;
    debouncedSave();
    renderAlternateTabs();
    renderTotals();
    renderLineItems(); // active group's banner state may need refreshing
  }

  function switchAlternate(altId) {
    var est = getEstimate();
    if (!est || !est.alternates) return;
    if (!est.alternates.find(function(a) { return a.id === altId; })) return;
    est.activeAlternateId = altId;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
    renderScopePanel();
  }

  function addAlternateFromEditor() {
    var est = getEstimate();
    if (!est) return;
    if (!est.alternates) est.alternates = [];
    var name = prompt('Name for the new group (e.g., "Deck 1", "Roof", "Phase 2"):', suggestNextAlternateName(est));
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false, scope: '' };
    est.alternates.push(newAlt);
    est.activeAlternateId = newAlt.id;
    // Auto-seed the four standard subgroups under the new group so the
    // estimator can immediately drop line items into the right buckets.
    STANDARD_SECTIONS_PRESET.forEach(function(s, idx) {
      appData.estimateLines.push({
        id: 's' + Date.now() + '_' + idx,
        estimateId: est.id,
        alternateId: newAlt.id,
        section: '__section_header__',
        description: s.name,
        btCategory: s.btCategory,
        markup: s.markup
      });
    });
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
    renderScopePanel();
  }

  function suggestNextAlternateName(est) {
    // Group names default to numbered scopes — most estimates use Group 1
    // for the primary scope and add Group 2/3 for additional decks, phases,
    // optional adds, etc. The Good/Better/Best ladder is still available
    // by typing a custom name.
    var n = (est.alternates || []).length + 1;
    return 'Group ' + n;
  }

  function renameActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    var name = prompt('Rename group:', a.name);
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    a.name = name;
    debouncedSave();
    renderAlternateTabs();
  }

  function duplicateActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    var name = prompt('Name for the duplicated group:', suggestNextAlternateName(est));
    if (name == null) return;
    name = name.trim();
    if (!name) return;
    var srcAlt = getActiveAlternate();
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false, scope: (srcAlt && srcAlt.scope) || '' };
    est.alternates.push(newAlt);
    // Clone every line in the active alternate over to the new one. Section
    // headers are cloned too so the structure carries over intact.
    var sourceLines = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === a.id;
    });
    sourceLines.forEach(function(l, idx) {
      var copy = Object.assign({}, l);
      copy.id = (l.section === '__section_header__' ? 's' : 'l') + Date.now() + '_' + idx;
      copy.alternateId = newAlt.id;
      appData.estimateLines.push(copy);
    });
    est.activeAlternateId = newAlt.id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
  }

  function deleteActiveAlternate() {
    var est = getEstimate();
    var a = getActiveAlternate();
    if (!est || !a) return;
    if ((est.alternates || []).length <= 1) {
      alert('Cannot delete the last group — at least one is required.');
      return;
    }
    var lineCount = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === a.id;
    }).length;
    var msg = lineCount
      ? 'This will also remove ' + lineCount + ' line item' + (lineCount === 1 ? '' : 's') + ' / subgroup header' + (lineCount === 1 ? '' : 's') + '. This cannot be undone.'
      : 'This cannot be undone.';
    window.agxConfirm({
      title: 'Delete group "' + a.name + '"?',
      message: msg,
      confirmText: 'Delete',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
      // Remove the alternate's lines first, then the alternate itself
      appData.estimateLines = (appData.estimateLines || []).filter(function(l) {
        return !(l.estimateId === est.id && l.alternateId === a.id);
      });
      est.alternates = est.alternates.filter(function(x) { return x.id !== a.id; });
      est.activeAlternateId = est.alternates[0].id;
      debouncedSave();
      renderAlternateTabs();
      renderLineItems();
      renderTotals();
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Live totals strip — recomputes on every line change.
  // ──────────────────────────────────────────────────────────────────

  // Math pipeline (in order):
  //   subtotal           = Σ qty × unitCost
  //   markupAmount       = Σ ext × (line markup % or default)
  //   markedUp           = subtotal + markupAmount
  //   feeFlat            = est.feeFlat
  //   feePct             = markedUp × (est.feePct / 100)
  //   preTax             = markedUp + feeFlat + feePct
  //   taxAmount          = preTax × (est.taxPct / 100)
  //   beforeRound        = preTax + taxAmount
  //   total              = round up beforeRound to nearest est.roundTo
  // Walk back from a given line to find its enclosing section header and
  // return that section's markup. Per-line `markup` overrides the section.
  // For legacy estimates that still carry an estimate-wide `defaultMarkup`,
  // fall through to it so existing data keeps pricing the same until the
  // user assigns explicit section markups.
  // Returns the section header (line with section === '__section_header__')
  // that encloses the given line, or null if the line precedes any header.
  function sectionHeaderFor(line, allLines) {
    if (!allLines || !allLines.length) return null;
    var idx = allLines.indexOf(line);
    if (idx < 0) idx = allLines.length;
    for (var i = idx - 1; i >= 0; i--) {
      var L = allLines[i];
      if (L && L.section === '__section_header__') return L;
    }
    return null;
  }

  function effectiveMarkupForLine(line, allLines, est) {
    var section = sectionHeaderFor(line, allLines);
    // Override-on: per-line markup is ignored. In $ mode the line gets
    // 0% (section flat $ adds at section level); in % mode the section
    // value is forced.
    if (section && section.overrideLineMarkups) {
      if (section.markupMode === 'dollar') return 0;
      return sectionMarkupForLine(line, allLines, est);
    }
    // No override: per-line markup wins. If the line has none, fall back
    // to the section default — but only in % mode. In $ mode the section
    // doesn't supply a per-line default; lines without their own %
    // render at raw extension cost.
    if (line && line.markup !== '' && line.markup != null) return num(line.markup);
    if (section && section.markupMode === 'dollar') return 0;
    return sectionMarkupForLine(line, allLines, est);
  }
  // The section-derived percent markup for a line, ignoring any per-line
  // override. Used to populate the placeholder on the per-line markup
  // field so the user knows what they'd be overriding if they typed a
  // value. Dollar-mode sections still return their numeric value here
  // for the placeholder UI's sake — but math callers should branch on
  // section.markupMode and skip applying it as a percentage.
  function sectionMarkupForLine(line, allLines, est) {
    var section = sectionHeaderFor(line, allLines);
    if (section && section.markup !== '' && section.markup != null) return num(section.markup);
    if (est && est.defaultMarkup != null && est.defaultMarkup !== '') return num(est.defaultMarkup);
    return 0;
  }

  // Helper: marked-up subtotal for a single group (alternate). Used by the
  // active-group subtotal display and by the cross-group sum below.
  // Section dollar markups are added once per dollar-mode section header.
  function markedUpForGroup(est, alt) {
    if (!est || !alt) return { subtotal: 0, markedUp: 0 };
    var lines = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === alt.id;
    });
    var subtotal = 0, markedUp = 0;
    lines.forEach(function(l) {
      if (l.section === '__section_header__') {
        // Dollar-mode section adds its flat amount once to the marked-up total.
        if (l.markupMode === 'dollar' && l.markup !== '' && l.markup != null) {
          markedUp += num(l.markup);
        }
        return;
      }
      var ext = num(l.qty) * num(l.unitCost);
      subtotal += ext;
      var m = effectiveMarkupForLine(l, lines, est);
      markedUp += ext * (1 + m / 100);
    });
    return { subtotal: subtotal, markedUp: markedUp };
  }

  function computeTotals() {
    var est = getEstimate();
    if (!est) return {};
    // Sum across every INCLUDED group. The active group is just for editing
    // focus; the proposal total reflects the union of every group whose
    // toggle is on.
    var subtotal = 0;
    var markedUp = 0;
    var includedGroups = [];
    var excludedGroups = [];
    (est.alternates || []).forEach(function(alt) {
      var per = markedUpForGroup(est, alt);
      if (alt.excludeFromTotal) {
        excludedGroups.push({ alt: alt, subtotal: per.subtotal, markedUp: per.markedUp });
      } else {
        includedGroups.push({ alt: alt, subtotal: per.subtotal, markedUp: per.markedUp });
        subtotal += per.subtotal;
        markedUp += per.markedUp;
      }
    });
    var feeFlat = est ? num(est.feeFlat) : 0;
    var feePctAmount = markedUp * (est ? num(est.feePct) : 0) / 100;
    var preTax = markedUp + feeFlat + feePctAmount;
    var taxAmount = preTax * (est ? num(est.taxPct) : 0) / 100;
    var beforeRound = preTax + taxAmount;
    var roundTo = est ? num(est.roundTo) : 0;
    var total = beforeRound;
    var rounded = 0;
    if (roundTo > 0) {
      total = Math.ceil(beforeRound / roundTo) * roundTo;
      rounded = total - beforeRound;
    }
    var lineCount = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.section !== '__section_header__';
    }).length;
    var activeAlt = getActiveAlternate();
    var activePer = activeAlt ? markedUpForGroup(est, activeAlt) : { subtotal: 0, markedUp: 0 };
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      markedUp: markedUp,
      feeFlat: feeFlat,
      feePctAmount: feePctAmount,
      preTax: preTax,
      taxAmount: taxAmount,
      beforeRound: beforeRound,
      rounded: rounded,
      total: total,
      lineCount: lineCount,
      includedGroups: includedGroups,
      excludedGroups: excludedGroups,
      activeGroupSubtotal: activePer.markedUp,
      activeGroupExcluded: !!(activeAlt && activeAlt.excludeFromTotal)
    };
  }

  function renderTotals() {
    var t = computeTotals();
    var totalsEl = document.getElementById('ee-totals');
    if (!totalsEl) return;
    function chip(label, value, color, cls) {
      // Optional cls hoists color out of inline style and into a class
      // so light mode can flip green amounts to plain text.
      var clsAttr = cls ? ' class="' + cls + '"' : '';
      var colorStyle = cls ? '' : ('color:' + color + ';');
      return '<div style="background:rgba(255,255,255,0.03);border:1px solid var(--border,#333);border-radius:6px;padding:6px 12px;min-width:120px;">' +
        '<div style="font-size:9px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">' + label + '</div>' +
        '<div' + clsAttr + ' style="font-size:14px;font-weight:700;' + colorStyle + 'font-family:\'SF Mono\',\'Fira Code\',monospace;">' + value + '</div>' +
      '</div>';
    }
    var groupCountChip = (t.includedGroups && t.includedGroups.length > 1)
      ? chip('Active Group', fmtCurrency(t.activeGroupSubtotal) + (t.activeGroupExcluded ? ' (excluded)' : ''), t.activeGroupExcluded ? 'var(--text-dim,#888)' : 'var(--accent,#60a5fa)')
      : '';
    // Gross margin % — markup as a share of the proposal total, the
    // figure most estimators care about. Falls back to '—' when there's
    // no revenue yet so we don't divide by zero.
    var marginPct = (t.markedUp > 0)
      ? (((t.markedUp - t.subtotal) / t.markedUp) * 100)
      : null;
    var marginText = (marginPct == null) ? '—' : marginPct.toFixed(1) + '%';
    totalsEl.innerHTML =
      groupCountChip +
      chip('Subtotal', fmtCurrency(t.subtotal), 'var(--text,#fff)') +
      chip('Markup', fmtCurrency(t.markupAmount), 'var(--yellow,#fbbf24)') +
      chip('Tax + Fees', fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount), 'var(--accent,#60a5fa)') +
      chip('Proposal Total', fmtCurrency(t.total), null, 'ee-grand-total') +
      chip('Margin', marginText, 'var(--green,#34d399)') +
      chip('Lines', t.lineCount, 'var(--text-dim,#888)');
    // Also refresh the detailed breakdown card under the line items.
    renderPricingBreakdown();
  }

  // Detailed breakdown shown under the line items table. Hides components
  // that are zero so a simple estimate (no fees / no tax / no rounding)
  // doesn't render visual clutter.
  function renderPricingBreakdown() {
    var el = document.getElementById('ee-pricing-breakdown');
    if (!el) return;
    var t = computeTotals();
    function row(label, value, opts) {
      opts = opts || {};
      var color = opts.color || 'var(--text,#fff)';
      var weight = opts.bold ? 700 : 500;
      var size = opts.bold ? 14 : 12;
      var divider = opts.divider ? 'border-top:1px solid var(--border,#333);padding-top:8px;margin-top:8px;' : '';
      // Optional cls puts color on a class instead of inline so light
      // mode can override (used for the Proposal Total row).
      var valClsAttr = opts.cls ? ' class="' + opts.cls + '"' : '';
      var valColorStyle = opts.cls ? '' : ('color:' + color + ';');
      return '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;' + divider + '">' +
        '<span style="font-size:' + (opts.bold ? 12 : 11) + 'px;color:var(--text-dim,#888);' + (opts.bold ? 'text-transform:uppercase;letter-spacing:0.5px;font-weight:700;' : '') + '">' + label + '</span>' +
        '<span' + valClsAttr + ' style="font-family:\'SF Mono\',monospace;font-size:' + size + 'px;font-weight:' + weight + ';' + valColorStyle + '">' + fmtCurrency(value) + '</span>' +
      '</div>';
    }
    var html = '';
    // When there are multiple groups, show a per-group breakdown at the
    // top so the user can see which group contributes what.
    if ((t.includedGroups && t.includedGroups.length > 1) || (t.excludedGroups && t.excludedGroups.length)) {
      html += '<div style="font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;margin-bottom:6px;">Groups</div>';
      (t.includedGroups || []).forEach(function(g) {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;">' +
          '<span style="color:var(--text,#ddd);">' + escapeHTML(g.alt.name || '(unnamed)') + '</span>' +
          '<span style="font-family:\'SF Mono\',monospace;color:var(--text,#fff);">' + fmtCurrency(g.markedUp) + '</span>' +
        '</div>';
      });
      (t.excludedGroups || []).forEach(function(g) {
        html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:3px 0;font-size:12px;opacity:0.5;">' +
          '<span style="color:var(--text-dim,#888);text-decoration:line-through;">' + escapeHTML(g.alt.name || '(unnamed)') + '</span>' +
          '<span style="font-family:\'SF Mono\',monospace;color:var(--text-dim,#666);">' + fmtCurrency(g.markedUp) + ' (excluded)</span>' +
        '</div>';
      });
      html += '<div style="border-top:1px solid var(--border,#333);margin:8px 0;"></div>';
    }
    html += row('Subtotal (cost, all included groups)', t.subtotal);
    html += row('Markup', t.markupAmount, { color: 'var(--yellow,#fbbf24)' });
    html += row('Marked-Up Subtotal', t.markedUp, { divider: true });
    if (t.feeFlat) html += row('+ Flat Fee', t.feeFlat, { color: 'var(--accent,#60a5fa)' });
    if (t.feePctAmount) html += row('+ Percentage Fee', t.feePctAmount, { color: 'var(--accent,#60a5fa)' });
    if (t.feeFlat || t.feePctAmount) html += row('Pre-Tax Total', t.preTax, { divider: true });
    if (t.taxAmount) html += row('+ Tax', t.taxAmount, { color: 'var(--accent,#60a5fa)' });
    if (t.rounded) html += row('+ Round Up', t.rounded, { color: 'var(--text-dim,#888)' });
    html += row('Proposal Total', t.total, { bold: true, cls: 'ee-grand-total', divider: true });
    el.innerHTML = html;
  }

  // ──────────────────────────────────────────────────────────────────
  // Line items — sections + rows. A section header lives as a special
  // row in appData.estimateLines with section === '__section_header__'
  // (legacy convention from the existing modal). Order in the array IS
  // the display order; drag-reorder lands in Phase B.
  // ──────────────────────────────────────────────────────────────────

  function renderLineItems() {
    var container = document.getElementById('ee-lines-container');
    if (!container) return;
    var est = getEstimate();
    var lines = getLines();
    var activeAlt = getActiveAlternate();
    var bannerHtml = '';
    if (activeAlt && activeAlt.excludeFromTotal) {
      bannerHtml = '<div style="padding:10px 14px;background:rgba(251,191,36,0.10);border:1px solid rgba(251,191,36,0.35);border-radius:8px;margin-bottom:10px;font-size:12px;color:var(--yellow,#fbbf24);">' +
        '⚠ This group is <strong>excluded</strong> from the proposal total. Lines you edit here won\'t ship to the client. Toggle the group on in the strip above to include it.' +
      '</div>';
    }
    if (!lines.length) {
      container.innerHTML = bannerHtml + '<div style="padding:40px;text-align:center;color:var(--text-dim,#888);border:1px dashed var(--border,#333);border-radius:8px;">' +
        'No line items yet. Click <strong>+ Line Item</strong> or <strong>+ Subgroup</strong> to start.' +
      '</div>';
      return;
    }

    var html = bannerHtml + '<div class="ee-line-table" style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;">';

    // Group rendering: walk lines in order, render section headers + lines
    // + per-section subtotals. Markup is now per-section — every line
    // inherits its section header's markup unless the line overrides.
    var currentSection = null;
    var sectionStartIdx = null;
    function flushSectionSubtotal(endIdx) {
      if (currentSection == null) return;
      var header = lines[sectionStartIdx];
      var sum = 0;
      var marked = 0;
      for (var i = sectionStartIdx + 1; i < endIdx; i++) {
        var L = lines[i];
        if (!L || L.section === '__section_header__') continue;
        var ext = num(L.qty) * num(L.unitCost);
        sum += ext;
        var m = effectiveMarkupForLine(L, lines, est);
        marked += ext * (1 + m / 100);
      }
      // Dollar-mode section: tack on the flat $ once.
      if (header && header.markupMode === 'dollar' && header.markup !== '' && header.markup != null) {
        marked += num(header.markup);
      }
      html += renderSectionSubtotal(sum, marked);
    }

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (line.section === '__section_header__') {
        if (currentSection != null) flushSectionSubtotal(i);
        html += renderSectionHeaderRow(line);
        currentSection = line.description || 'Section';
        sectionStartIdx = i;
      } else {
        html += renderLineItemRow(line, lines, est);
      }
    }
    if (currentSection != null) flushSectionSubtotal(lines.length);

    html += '</div>';
    container.innerHTML = html;

    // Auto-size every description textarea to fit its current content.
    // The HTML strings can't compute scrollHeight (no DOM yet), so we
    // do it once after innerHTML is committed.
    container.querySelectorAll('textarea').forEach(function(ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    });
  }

  // (Column header row removed — the per-line inputs are self-labeled
  // and the row was visual noise + a sticky-pinning headache.)

  // Drag handle markup shared by section headers + line rows. The HTML5
  // drag-and-drop dance: dragstart records the dragged id, dragover preserves
  // the drop target highlight, drop reorders the array.
  function dragHandleHTML(id) {
    return '<div ' +
      'draggable="true" ' +
      'ondragstart="onLineDragStart(event, \'' + escapeHTML(id) + '\')" ' +
      'ondragend="onLineDragEnd(event)" ' +
      'style="flex:0 0 28px;text-align:center;cursor:grab;color:var(--text-dim,#888);font-size:14px;user-select:none;padding:6px 0;line-height:1;" ' +
      'title="Drag to reorder">&#x2630;</div>';
  }

  function renderSectionHeaderRow(line) {
    var idAttr = escapeHTML(line.id);
    var markupVal = (line.markup === '' || line.markup == null) ? '' : num(line.markup);
    var mode = (line.markupMode === 'dollar') ? 'dollar' : 'percent';
    var override = !!line.overrideLineMarkups;
    var isDollar = mode === 'dollar';
    var prefix = isDollar ? '$' : '';
    var suffix = isDollar ? '' : '%';
    return '<div data-section-id="' + idAttr + '" data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:center;flex-wrap:wrap;background:rgba(79,140,255,0.06);border-bottom:1px solid var(--border,#333);padding:6px 10px;gap:8px;">' +
      dragHandleHTML(line.id) +
      '<input type="text" value="' + escapeHTML(line.description || '') + '" placeholder="Section name" ' +
        'oninput="updateSectionName(\'' + idAttr + '\', this.value)" ' +
        'style="flex:1;min-width:140px;font-size:13px;font-weight:700;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 8px;color:#4f8cff;text-transform:uppercase;letter-spacing:0.5px;" ' +
        'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
      // Section markup pill — number input + $/% toggle + override checkbox.
      // Slider was removed; the number input alone is the source of truth.
      '<div style="display:inline-flex;align-items:center;gap:6px;background:rgba(0,0,0,0.18);padding:4px 10px;border-radius:14px;border:1px solid var(--border,#333);">' +
        '<span style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Markup</span>' +
        // $/% toggle — flips between percent (multiplier on each line) and
        // dollar (flat add at section subtotal). Click switches.
        '<button type="button" onclick="toggleSectionMarkupMode(\'' + idAttr + '\')" ' +
          'title="Switch between percentage and flat dollar markup" ' +
          'style="background:rgba(79,140,255,0.18);color:#4f8cff;border:1px solid rgba(79,140,255,0.35);border-radius:4px;width:24px;height:24px;font-size:12px;font-weight:700;cursor:pointer;line-height:1;">' +
          (isDollar ? '$' : '%') +
        '</button>' +
        (prefix ? '<span style="font-size:11px;color:var(--text-dim,#888);">' + prefix + '</span>' : '') +
        '<input type="number" min="0" step="0.5" placeholder="0" value="' + markupVal + '" ' +
          // onchange (not oninput) — updateSectionMarkup re-renders the
          // line items, which destroys this very input. With oninput,
          // every keystroke nuked the input mid-typing and characters
          // landed in unexpected positions / got dropped. onchange
          // fires on blur, after the user is done typing.
          'onchange="updateSectionMarkup(\'' + idAttr + '\', this.value)" ' +
          'style="width:64px;padding:2px 4px;font-size:12px;background:transparent;border:1px solid transparent;border-radius:4px;color:var(--text,#fff);text-align:right;font-family:\'SF Mono\',monospace;" ' +
          'onfocus="this.style.borderColor=\'var(--border,#333)\';" onblur="this.style.borderColor=\'transparent\';" />' +
        (suffix ? '<span style="font-size:11px;color:var(--text-dim,#888);">' + suffix + '</span>' : '') +
      '</div>' +
      // Override checkbox — when on, per-line markups are ignored.
      // In % mode the section's % is forced on every line; in $ mode
      // each line's % drops to 0 (the section flat $ is added at the
      // section subtotal regardless). Visible in both modes.
      '<label title="Override per-line markups (use the section value for every line below)" ' +
        'style="display:inline-flex;align-items:center;cursor:pointer;padding:0 4px;">' +
        '<input type="checkbox" ' + (override ? 'checked' : '') + ' ' +
          'onchange="toggleSectionOverride(\'' + idAttr + '\', this.checked)" ' +
          'style="cursor:pointer;width:14px;height:14px;" />' +
      '</label>' +
      '<button class="ee-btn primary" onclick="addEstimateLineFromEditor(\'' + idAttr + '\')" title="Add a line under this section">&#x2795; Line Item</button>' +
      '<button class="ee-btn ee-icon-btn ghost" onclick="deleteSectionFromEditor(\'' + idAttr + '\')" title="Remove section header (lines stay)">&#x1F5D1;</button>' +
    '</div>';
  }

  function renderLineItemRow(line, allLines, est) {
    var ext = num(line.qty) * num(line.unitCost);
    var section = sectionHeaderFor(line, allLines);
    var sectionDollarMode = !!(section && section.markupMode === 'dollar');
    var sectionOverride = !!(section && section.overrideLineMarkups);
    // Effective markup driving the per-line client price preview.
    // Dollar-mode section: lines render at raw extension (no %). The
    // section's flat $ shows up in the section subtotal row instead.
    // Override-on section: forced section %.
    // Otherwise: per-line override > section > est default.
    var effective = effectiveMarkupForLine(line, allLines, est);
    var clientPrice = ext * (1 + effective / 100);
    var inherited = sectionMarkupForLine(line, allLines, est);
    // Placeholder hint for the per-line markup field.
    // - Override on: line markup is ignored either way; show "(forced)"
    //   with the section's % (or 0 in $ mode).
    // - No override + $ mode: line markup is honored if entered, else 0.
    // - No override + % mode: line falls back to the section's %.
    var markupPlaceholder = sectionOverride
      ? (sectionDollarMode ? '0 (forced)' : inherited + ' (forced)')
      : (sectionDollarMode
          ? (line.markup === '' || line.markup == null ? '0' : '')
          : (line.markup === '' || line.markup == null ? inherited + ' (section)' : ''));
    var idAttr = escapeHTML(line.id);

    var input = function(field, value, opts) {
      opts = opts || {};
      var inputAttrs =
        ' value="' + escapeHTML(value == null ? '' : String(value)) + '"' +
        (opts.placeholder ? ' placeholder="' + escapeHTML(opts.placeholder) + '"' : '') +
        ' onchange="updateLineField(\'' + idAttr + '\', \'' + field + '\', this.value)"' +
        ' style="width:100%;padding:6px 8px;font-size:12px;background:transparent;border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);' +
        (opts.align ? 'text-align:' + opts.align + ';' : '') +
        (opts.mono ? 'font-family:\'SF Mono\',monospace;' : '') +
        '"';
      var typeAttr = opts.type ? 'type="' + opts.type + '"' : 'type="text"';
      return '<div style="flex:' + (opts.flex || '1') + ';padding:4px 6px;">' +
        '<input ' + typeAttr + inputAttrs + ' />' +
      '</div>';
    };

    // Description gets its own textarea variant so the cell auto-grows
    // when the user types a long description — single-line inputs were
    // truncating mid-text. Auto-grow on input via JS-set inline height.
    var descTextarea = function() {
      var v = line.description == null ? '' : String(line.description);
      return '<div style="flex:2 1 200px;padding:4px 6px;">' +
        '<textarea rows="1" ' +
          ' onchange="updateLineField(\'' + idAttr + '\', \'description\', this.value)"' +
          ' oninput="this.style.height=\'auto\';this.style.height=Math.min(this.scrollHeight,180)+\'px\';"' +
          ' style="width:100%;padding:6px 8px;font-size:12px;background:transparent;border:1px solid var(--border,#333);border-radius:4px;color:var(--text,#fff);resize:none;overflow:hidden;line-height:1.45;font-family:inherit;display:block;">' +
          escapeHTML(v) +
        '</textarea>' +
      '</div>';
    };
    var readOnly = function(value, flex, color, cls) {
      // Optional cls lets the caller move color out of inline style and
      // into a class — needed for the per-line client-price column so
      // light mode can flip the green to plain text via CSS.
      var clsAttr = cls ? ' class="' + cls + '"' : '';
      var colorStyle = cls ? '' : ('color:' + (color || 'var(--text-dim,#888)') + ';');
      return '<div' + clsAttr + ' style="flex:' + flex + ';padding:8px 10px;font-size:12px;text-align:right;' + colorStyle + 'font-family:\'SF Mono\',monospace;">' + value + '</div>';
    };

    // align-items:flex-start so the row keeps its natural height when
    // the description textarea grows; numeric / readonly cells stay
    // at the top instead of getting stretched vertically.
    return '<div data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:flex-start;border-bottom:1px solid var(--border,#333);">' +
      dragHandleHTML(line.id) +
      descTextarea() +
      input('qty', line.qty, { flex: '0 0 70px', type: 'number', align: 'right', mono: true }) +
      input('unit', line.unit, { flex: '0 0 70px' }) +
      input('unitCost', line.unitCost, { flex: '0 0 110px', type: 'number', align: 'right', mono: true }) +
      input('markup', line.markup, { flex: '0 0 90px', type: 'number', align: 'right', mono: true, placeholder: markupPlaceholder }) +
      readOnly(fmtCurrency(ext), '0 0 110px') +
      readOnly(fmtCurrency(clientPrice), '0 0 120px', null, 'ee-line-amount') +
      '<div style="flex:0 0 36px;text-align:center;padding-top:8px;">' +
        '<button class="ee-btn ee-icon-btn danger" onclick="deleteLineFromEditor(\'' + idAttr + '\')" title="Delete line">&#x1F5D1;</button>' +
      '</div>' +
    '</div>';
  }

  function renderSectionSubtotal(rawSum, markedUp) {
    return '<div style="display:flex;align-items:center;background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);padding:6px 10px;">' +
      '<div style="flex:0 0 28px;"></div>' + // matches the drag-handle column
      '<div style="flex:2 1 200px;font-size:11px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:600;padding-left:8px;">Section Subtotal</div>' +
      '<div style="flex:0 0 70px;"></div>' +
      '<div style="flex:0 0 70px;"></div>' +
      '<div style="flex:0 0 110px;"></div>' +
      '<div style="flex:0 0 90px;"></div>' +
      '<div style="flex:0 0 110px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12px;color:var(--text,#fff);padding:0 10px;">' + fmtCurrency(rawSum) + '</div>' +
      '<div class="ee-section-total" style="flex:0 0 120px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12px;font-weight:700;padding:0 10px;">' + fmtCurrency(markedUp) + '</div>' +
      '<div style="flex:0 0 36px;"></div>' +
    '</div>';
  }

  // Inline-edit handlers wired via onchange. Each writes back to the
  // estimateLines record, recomputes totals + re-renders so the section
  // subtotals + the totals strip update.
  function updateLineField(lineId, field, value) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    if (field === 'qty' || field === 'unitCost') line[field] = num(value);
    else if (field === 'markup') line.markup = (value === '' || value == null) ? '' : num(value);
    else line[field] = value;
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function updateSectionName(lineId, value) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    line.description = value;
    debouncedSave();
    // Don't re-render the whole thing on every keystroke — the input keeps
    // its value as-typed; subtotals don't depend on the section name.
  }

  // Section markup — applies to every line under the header. In
  // percent mode the value is the markup % multiplier; in dollar
  // mode it's a flat $ added at section subtotal. The override
  // checkbox decides whether per-line markups are honored or
  // forcibly replaced by the section value.
  function updateSectionMarkup(lineId, value) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    var raw = (value == null) ? '' : String(value).trim();
    line.markup = raw === '' ? '' : Number(raw);
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // Toggle the section markup mode between percent and dollar.
  // Percent (default) multiplies each line's extension; dollar adds
  // a single flat amount once at the section subtotal level. The
  // numeric `markup` value is preserved across the toggle so a 20%
  // section flipped to $ shows "$20" — the user can edit from there.
  function toggleSectionMarkupMode(lineId) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    line.markupMode = (line.markupMode === 'dollar') ? 'percent' : 'dollar';
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // Toggle the section's "override line markups" flag. When on,
  // every line under this section uses the section's % markup
  // regardless of any per-line override. Hidden in dollar mode where
  // line markups don't apply anyway.
  function toggleSectionOverride(lineId, checked) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) return;
    line.overrideLineMarkups = !!checked;
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // Optional sectionId — when provided, the new line is inserted just
  // before the next section header (i.e. at the end of that section's
  // group), so the standard-sections layout stays intact. Without it,
  // the line is appended to the end as before.
  function addEstimateLineFromEditor(sectionId) {
    var est = getEstimate();
    if (!est) return;
    var newLine = {
      id: 'l' + Date.now(),
      estimateId: est.id,
      alternateId: est.activeAlternateId,
      description: '',
      qty: 1,
      unit: '',
      unitCost: 0,
      markup: ''
    };
    if (sectionId) {
      var arr = appData.estimateLines;
      var startIdx = arr.findIndex(function(l) { return l.id === sectionId; });
      if (startIdx >= 0) {
        // Walk forward from the section header until we hit the next
        // header in the same alternate, or run out of lines.
        var insertAt = arr.length;
        for (var j = startIdx + 1; j < arr.length; j++) {
          var L = arr[j];
          if (L.estimateId !== est.id || L.alternateId !== est.activeAlternateId) continue;
          if (L.section === '__section_header__') { insertAt = j; break; }
        }
        // If we never found a next header, find the index after the last
        // line in this alternate so we don't sneak into another alternate.
        if (insertAt === arr.length) {
          for (var k = arr.length - 1; k > startIdx; k--) {
            var M = arr[k];
            if (M.estimateId === est.id && M.alternateId === est.activeAlternateId) {
              insertAt = k + 1; break;
            }
          }
        }
        arr.splice(insertAt, 0, newLine);
        debouncedSave();
        renderLineItems();
        renderTotals();
        return;
      }
    }
    appData.estimateLines.push(newLine);
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function addEstimateSectionFromEditor() {
    var est = getEstimate();
    if (!est) return;
    var name = prompt('Subgroup name:', '');
    if (name == null) return;
    var newHeader = {
      id: 's' + Date.now(),
      estimateId: est.id,
      alternateId: est.activeAlternateId,
      section: '__section_header__',
      description: name || 'Untitled Section'
    };
    appData.estimateLines.push(newHeader);
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  function deleteLineFromEditor(lineId) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    var preview = line && line.description ? line.description : 'this line';
    window.agxConfirm({
      title: 'Delete line item?',
      message: '"' + preview + '" will be removed from the active alternate. This cannot be undone.',
      confirmText: 'Delete',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
      appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== lineId; });
      debouncedSave();
      renderLineItems();
      renderTotals();
    });
  }

  function deleteSectionFromEditor(sectionId) {
    var section = (appData.estimateLines || []).find(function(l) { return l.id === sectionId; });
    var name = section && section.description ? section.description : 'this section';
    window.agxConfirm({
      title: 'Remove section header?',
      message: 'The header "' + name + '" will be removed. The line items underneath it stay where they are.',
      confirmText: 'Remove',
      destructive: true
    }).then(function(ok) {
      if (!ok) return;
      appData.estimateLines = (appData.estimateLines || []).filter(function(l) { return l.id !== sectionId; });
      debouncedSave();
      renderLineItems();
      renderTotals();
    });
  }

  // Standard cost-side sections used by the Buildertrend export pipeline.
  // Phase C will widen btCategory into a (parentGroup, subgroup) tuple for
  // BT's two-sheet import — keeping the simple keys here for now keeps
  // existing data forward-compatible.
  // Default markup per category mirrors AGX's typical pricing: materials
  // and subs run lean, direct labor carries the bulk of the margin, GC is
  // usually a flat percentage. Estimators can dial each section's slider
  // up or down per job in the editor.
  var STANDARD_SECTIONS_PRESET = [
    { name: 'Materials & Supplies Costs', btCategory: 'materials', markup: 0 },
    { name: 'Direct Labor',               btCategory: 'labor',     markup: 0 },
    { name: 'General Conditions',         btCategory: 'gc',        markup: 0 },
    { name: 'Subcontractors Costs',       btCategory: 'sub',       markup: 0 }
  ];

  function addStandardSectionsFromEditor() {
    var est = getEstimate();
    if (!est) return;
    var altId = est.activeAlternateId;
    var existing = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === altId && l.section === '__section_header__';
    });
    var existingCats = {};
    existing.forEach(function(s) { if (s.btCategory) existingCats[s.btCategory] = true; });
    var added = 0;
    STANDARD_SECTIONS_PRESET.forEach(function(s, idx) {
      if (existingCats[s.btCategory]) return; // already present in this alternate
      appData.estimateLines.push({
        id: 's' + Date.now() + '_' + idx,
        estimateId: est.id,
        alternateId: altId,
        section: '__section_header__',
        description: s.name,
        btCategory: s.btCategory,
        markup: s.markup
      });
      added++;
    });
    if (!added) {
      alert('All four standard subgroups are already present in this group.');
      return;
    }
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // ──────────────────────────────────────────────────────────────────
  // Drag-reorder — native HTML5 D&D. Each line / section row is a drop
  // target; the dragged item's id is stashed on dragstart and the row
  // gets a faint highlight on dragover. Drop reorders the
  // appData.estimateLines array in-place.
  // ──────────────────────────────────────────────────────────────────

  var _draggedLineId = null;

  function onLineDragStart(e, id) {
    _draggedLineId = id;
    try { e.dataTransfer.effectAllowed = 'move'; } catch (_) {}
    try { e.dataTransfer.setData('text/plain', id); } catch (_) {}
    // Fade the source row a touch so the user can see what they're moving
    var row = e.target.closest('[data-line-id]');
    if (row) row.style.opacity = '0.45';
  }

  function onLineDragOver(e) {
    if (!_draggedLineId) return;
    e.preventDefault();
    try { e.dataTransfer.dropEffect = 'move'; } catch (_) {}
    var row = e.currentTarget;
    if (row && row.style) row.style.background = 'rgba(79,140,255,0.10)';
  }

  function onLineDragLeave(e) {
    var row = e.currentTarget;
    if (!row || !row.style) return;
    // Restore the original background. Section headers + subtotals have
    // their own background; resetting to '' lets the inline style win
    // back from the row's original :style attribute when re-rendered.
    row.style.background = '';
  }

  function onLineDragEnd(e) {
    // Source row opacity restore — we re-render after a successful drop,
    // but if the drop didn't land on a target (cancelled drag) we need to
    // restore the visual state.
    var row = e.target.closest('[data-line-id]');
    if (row) row.style.opacity = '';
    _draggedLineId = null;
    // Clear any stuck drop-target highlight
    document.querySelectorAll('[data-line-id]').forEach(function(el) { el.style.background = ''; });
  }

  function onLineDrop(e, targetId) {
    e.preventDefault();
    if (!_draggedLineId || _draggedLineId === targetId) {
      _draggedLineId = null;
      renderLineItems();
      return;
    }
    var lines = appData.estimateLines;
    var fromIdx = lines.findIndex(function(l) { return l.id === _draggedLineId; });
    var toIdx = lines.findIndex(function(l) { return l.id === targetId; });
    if (fromIdx < 0 || toIdx < 0) {
      _draggedLineId = null;
      renderLineItems();
      return;
    }
    var moved = lines.splice(fromIdx, 1)[0];
    // If we removed an earlier item, the target index shifts left by 1
    if (fromIdx < toIdx) toIdx--;
    lines.splice(toIdx, 0, moved);
    _draggedLineId = null;
    debouncedSave();
    renderLineItems();
    renderTotals();
  }

  // ──────────────────────────────────────────────────────────────────
  // Details tab — header info, addresses, manager, scope, default markup.
  // Mirrors the old modal's fields, just laid out for the page width.
  // ──────────────────────────────────────────────────────────────────

  function renderDetailsForm() {
    var est = getEstimate();
    var formEl = document.getElementById('ee-details-form');
    if (!formEl || !est) return;

    function field(label, id, value, opts) {
      opts = opts || {};
      var input = '';
      if (opts.textarea) {
        input = '<textarea id="' + id + '" rows="' + (opts.rows || 4) + '" style="width:100%;padding:8px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);resize:vertical;">' + escapeHTML(value || '') + '</textarea>';
      } else if (opts.options && opts.options.length) {
        // Select with a fixed option list. The current value is always
        // included as a fallback option even if it's not in the list, so
        // pre-existing free-text values from before this dropdown
        // landed don't silently get dropped on first save.
        var seen = false;
        var optHtml = '<option value="">— Select —</option>';
        opts.options.forEach(function(o) {
          var v = (typeof o === 'string') ? o : o.value;
          var lbl = (typeof o === 'string') ? o : (o.label || o.value);
          var sel = (value === v) ? ' selected' : '';
          if (sel) seen = true;
          optHtml += '<option value="' + escapeHTML(v) + '"' + sel + '>' + escapeHTML(lbl) + '</option>';
        });
        if (value && !seen) {
          optHtml += '<option value="' + escapeHTML(value) + '" selected>' + escapeHTML(value) + ' (legacy)</option>';
        }
        input = '<select id="' + id + '" style="width:100%;">' + optHtml + '</select>';
      } else {
        input = '<input id="' + id + '" type="' + (opts.type || 'text') + '" value="' + escapeHTML(value == null ? '' : String(value)) + '"' +
                (opts.step ? ' step="' + opts.step + '"' : '') +
                (opts.placeholder ? ' placeholder="' + escapeHTML(opts.placeholder) + '"' : '') +
                ' style="width:100%;" />';
      }
      return '<div style="margin-bottom:12px;"><label style="display:block;">' + label + '</label>' + input + '</div>';
    }

    formEl.innerHTML =
      '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;max-width:900px;">' +
        '<div>' +
          '<div style="margin-bottom:12px;">' +
            '<label style="display:block;">Pick from Client Directory</label>' +
            '<select id="ee-clientPicker" onchange="onEstimateClientPicked(\'edit\')" style="width:100%;"></select>' +
          '</div>' +
          '<input type="hidden" id="editEst_clientId" value="' + escapeHTML(est.client_id || '') + '" />' +
          '<input type="hidden" id="editEst_leadId" value="' + escapeHTML(est.lead_id || '') + '" />' +
          field('Nickname (internal)', 'ee-nickName', est.nickName, { placeholder: 'Short label for internal lists' }) +
          field('Job Type', 'ee-jobType', est.jobType, { options: ['Renovation', 'Service & Repair', 'Work Order'] }) +
          field('Client Company Name', 'ee-client', est.client) +
          field('Community / Property Name', 'ee-community', est.community) +
          field('Property Address', 'ee-propertyAddr', est.propertyAddr) +
          field('Client Billing Address', 'ee-billingAddr', est.billingAddr) +
        '</div>' +
        '<div>' +
          field('Proposal Salutation (Dear ___,)', 'ee-salutation', est.salutation, { placeholder: 'Auto-filled from client; e.g. PAC Team' }) +
          field('Issue / Repair (proposal headline)', 'ee-issue', est.issue, { placeholder: 'e.g. Metal Stair Repairs' }) +
          field('Manager Name', 'ee-managerName', est.managerName) +
          field('Manager Email', 'ee-managerEmail', est.managerEmail, { type: 'email' }) +
          field('Manager Phone', 'ee-managerPhone', est.managerPhone, { type: 'tel' }) +
          '<div style="margin-bottom:12px;font-size:11px;color:var(--text-dim,#888);padding:8px 10px;background:rgba(79,140,255,0.06);border:1px solid var(--border,#333);border-radius:6px;line-height:1.5;">' +
            '<strong style="color:#4f8cff;">Scope of Work</strong> moved to the <strong>Line Items</strong> tab so each alternate carries its own. Find it in the right panel under the active alternate.' +
          '</div>' +
        '</div>' +
      '</div>' +
      // Pricing fieldset — tax + fees + round-up. Markup is per-section now;
      // set it on each section header inside the Line Items tab.
      '<fieldset style="border:1px solid var(--border,#333);border-radius:8px;padding:12px 14px;margin-top:18px;max-width:900px;">' +
        '<legend style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;padding:0 6px;">Pricing</legend>' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;">' +
          field('Tax %', 'ee-taxPct', est.taxPct, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Flat Fee ($)', 'ee-feeFlat', est.feeFlat, { type: 'number', step: '0.01', placeholder: '0' }) +
          field('Fee % of Marked-Up', 'ee-feePct', est.feePct, { type: 'number', step: '0.1', placeholder: '0' }) +
          field('Round Up to Nearest ($)', 'ee-roundTo', est.roundTo, { type: 'number', step: '1', placeholder: '0 = off' }) +
        '</div>' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:8px;">' +
          'Markup is per-section — set it on each section header in <strong>Line Items</strong>. Tax applies after fees. Round-up is the last step.' +
        '</div>' +
      '</fieldset>';

    // Wire each field's onchange to live-update the estimate record.
    var fieldMap = {
      'ee-nickName': 'nickName',
      'ee-jobType': 'jobType',
      'ee-client': 'client',
      'ee-community': 'community',
      'ee-propertyAddr': 'propertyAddr',
      'ee-billingAddr': 'billingAddr',
      'ee-salutation': 'salutation',
      'ee-issue': 'issue',
      'ee-managerName': 'managerName',
      'ee-managerEmail': 'managerEmail',
      'ee-managerPhone': 'managerPhone'
    };
    Object.keys(fieldMap).forEach(function(elId) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.onchange = function() {
        var e = getEstimate(); if (!e) return;
        e[fieldMap[elId]] = el.value;
        debouncedSave();
      };
    });
    // Pricing-affecting fields: changing any of these means the line table
    // (default-markup placeholder + computed columns) and the totals strip
    // both need to update.
    var pricingMap = {
      'ee-taxPct':        'taxPct',
      'ee-feeFlat':       'feeFlat',
      'ee-feePct':        'feePct',
      'ee-roundTo':       'roundTo'
    };
    Object.keys(pricingMap).forEach(function(elId) {
      var el = document.getElementById(elId);
      if (!el) return;
      el.onchange = function() {
        var e = getEstimate(); if (!e) return;
        e[pricingMap[elId]] = num(el.value);
        debouncedSave();
        renderLineItems();
        renderTotals();
      };
    });
    // Hidden client_id field — the picker writes into it. Mirror to the
    // estimate record on every change.
    var clientIdEl = document.getElementById('editEst_clientId');
    if (clientIdEl) {
      clientIdEl.addEventListener('change', function() {
        var e = getEstimate(); if (!e) return;
        e.client_id = clientIdEl.value || null;
        debouncedSave();
        renderHeaderChips();
      });
    }
    // Populate the client picker now that the hidden field is rendered
    if (typeof populateEstimateClientPicker === 'function') {
      populateEstimateClientPicker('ee-clientPicker', est.client_id || '');
    }
  }

  // Re-rendering helpers exposed so the client picker's auto-fill writes
  // through cleanly. populateEstimateClientPicker / onEstimateClientPicked
  // (in clients.js) target field ids prefixed with 'editEst_' / 'est' —
  // we need a hook here so the new editor field ids stay in sync.
  // Override onEstimateClientPicked when our form is open.
  var _origOnPicked = window.onEstimateClientPicked;
  window.onEstimateClientPicked = function(mode) {
    // If we're in the new editor, route through the editor's mapping.
    if (_currentId && document.getElementById('ee-clientPicker')) {
      var sel = document.getElementById('ee-clientPicker');
      var hidden = document.getElementById('editEst_clientId');
      if (hidden) hidden.value = sel.value || '';
      if (!sel.value) { renderHeaderChips(); return; }
      var clients = (window.agxClients && window.agxClients.getCached && window.agxClients.getCached()) || [];
      var c = clients.find(function(x) { return x.id === sel.value; });
      if (!c) return;
      var setIf = function(elId, v) {
        var el = document.getElementById(elId);
        if (el && v != null && v !== '') {
          el.value = v;
          el.dispatchEvent(new Event('change'));
        }
      };
      setIf('ee-client', c.company_name || c.name || '');
      setIf('ee-community', c.community_name || c.name || '');
      var pAddr = [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      var bAddr = [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
      setIf('ee-propertyAddr', pAddr);
      setIf('ee-billingAddr', bAddr);
      setIf('ee-managerName', c.community_manager || '');
      setIf('ee-managerEmail', c.cm_email || c.email || '');
      setIf('ee-managerPhone', c.cm_phone || c.phone || c.cell || '');
      // Snapshot the client's salutation onto the estimate so editing the
      // client later doesn't rewrite a sent proposal. Falls through to
      // first/last name -> contact name -> client name if salutation is blank.
      var salutationGuess = c.salutation
        || ((c.first_name || c.last_name) ? [c.first_name, c.last_name].filter(Boolean).join(' ') : '')
        || c.community_manager
        || c.name || '';
      setIf('ee-salutation', salutationGuess);
      // Update estimate.client_id directly + chips
      var e = getEstimate();
      if (e) { e.client_id = sel.value; debouncedSave(); }
      renderHeaderChips();
      return;
    }
    if (typeof _origOnPicked === 'function') return _origOnPicked(mode);
  };

  // ──────────────────────────────────────────────────────────────────
  // Replace the legacy editEstimate(id) entry point so clicking Edit on
  // the list opens the new full-page editor instead of the modal.
  // The modal markup stays in HTML for reference but is no longer opened.
  // ──────────────────────────────────────────────────────────────────

  var _origEditEstimate = window.editEstimate;
  window.editEstimate = function(estId) {
    openEstimateEditor(estId);
  };
  void _origEditEstimate; // kept for future fallback if we need it

  window.openEstimateEditor = openEstimateEditor;
  window.closeEstimateEditor = closeEstimateEditor;
  window.switchEstimateEditorTab = switchEstimateEditorTab;
  window.updateLineField = updateLineField;
  window.updateSectionMarkup = updateSectionMarkup;
  window.toggleSectionMarkupMode = toggleSectionMarkupMode;
  window.toggleSectionOverride = toggleSectionOverride;
  window.updateSectionName = updateSectionName;
  window.addEstimateLineFromEditor = addEstimateLineFromEditor;
  window.addEstimateSectionFromEditor = addEstimateSectionFromEditor;
  window.deleteLineFromEditor = deleteLineFromEditor;
  window.deleteSectionFromEditor = deleteSectionFromEditor;
  window.jumpToLeadFromEstimate = jumpToLeadFromEstimate;
  window.onLineDragStart = onLineDragStart;
  window.onLineDragOver = onLineDragOver;
  window.onLineDragLeave = onLineDragLeave;
  window.onLineDragEnd = onLineDragEnd;
  window.onLineDrop = onLineDrop;
  window.switchAlternate = switchAlternate;
  window.renderScopePanel = renderScopePanel;

  // Tiny shim so the sticky-header "Ask AI" button can find the active
  // estimate id without the AI panel having to read the editor's private
  // state. Just delegates to agxAI.open with the current id.
  // Manual save invoked by the sticky-header Save button + the save
  // indicator (clicking the chip also triggers an immediate save).
  window.saveEstimateNow = function() {
    if (!_currentId) return;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    runSaveNow();
  };

  window.openEstimateAI = function() {
    if (!_currentId) { alert('Open an estimate first.'); return; }
    if (window.agxAI && typeof window.agxAI.open === 'function') {
      window.agxAI.open(_currentId);
    } else {
      alert('AI panel not loaded yet — refresh the page.');
    }
  };

  // Delete from the editor sticky header. Closes the editor first so the
  // user lands back on the list, then runs the existing global delete
  // (which handles the server-side remove + local state cleanup).
  window.deleteEstimateFromEditor = function() {
    if (!_currentId) return;
    var id = _currentId;
    if (typeof window.deleteEstimate !== 'function') {
      alert('Delete not available — refresh the page.');
      return;
    }
    // The global deleteEstimate prompts via confirm() and only removes
    // on yes. Close the editor view AFTER the user confirms so a cancel
    // leaves them in place.
    var prevConfirm = window.confirm;
    var userSaidYes = false;
    window.confirm = function(msg) {
      var ok = prevConfirm.call(window, msg);
      userSaidYes = userSaidYes || ok;
      return ok;
    };
    try { window.deleteEstimate(id); } finally { window.confirm = prevConfirm; }
    if (userSaidYes) closeEstimateEditor();
  };

  // ──────────────────────────────────────────────────────────────────
  // Public write API for the AI panel. Each function applies a single
  // approved proposal, mutating appData + saving + re-rendering. All
  // operations target the currently-open estimate's active alternate.
  // Returns a short summary string the AI panel can echo back to the
  // server in the tool_result so Claude knows what landed.
  // ──────────────────────────────────────────────────────────────────
  function applyAddLineItem(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');

    var sectionId = null;
    if (input.section_name) {
      var needle = String(input.section_name).toLowerCase();
      var match = (appData.estimateLines || []).find(function(l) {
        return l.estimateId === est.id
          && l.alternateId === alt.id
          && l.section === '__section_header__'
          && (l.description || '').toLowerCase().indexOf(needle) >= 0;
      });
      if (match) sectionId = match.id;
    }

    var newLine = {
      id: 'l' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      estimateId: est.id,
      alternateId: alt.id,
      description: input.description || '',
      qty: num(input.qty),
      unit: input.unit || 'ea',
      unitCost: num(input.unit_cost),
      markup: (input.markup_pct == null || input.markup_pct === '') ? '' : num(input.markup_pct)
    };

    if (sectionId) {
      // Same insertion logic as addEstimateLineFromEditor: walk forward to
      // the next section header in the same alternate.
      var arr = appData.estimateLines;
      var startIdx = arr.findIndex(function(l) { return l.id === sectionId; });
      if (startIdx >= 0) {
        var insertAt = arr.length;
        for (var j = startIdx + 1; j < arr.length; j++) {
          var L = arr[j];
          if (L.estimateId !== est.id || L.alternateId !== alt.id) continue;
          if (L.section === '__section_header__') { insertAt = j; break; }
        }
        if (insertAt === arr.length) {
          for (var k = arr.length - 1; k > startIdx; k--) {
            var M = arr[k];
            if (M.estimateId === est.id && M.alternateId === alt.id) {
              insertAt = k + 1; break;
            }
          }
        }
        arr.splice(insertAt, 0, newLine);
      } else {
        arr.push(newLine);
      }
    } else {
      appData.estimateLines.push(newLine);
    }

    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Added line: "' + newLine.description + '" — qty ' + newLine.qty + ' ' + newLine.unit + ' @ $' + newLine.unitCost.toFixed(2);
  }

  function applyAddSection(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');
    var newHeader = {
      id: 's' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      estimateId: est.id,
      alternateId: alt.id,
      section: '__section_header__',
      description: input.name || 'Untitled Section'
    };
    if (input.bt_category) newHeader.btCategory = input.bt_category;
    if (input.markup_pct != null && input.markup_pct !== '') newHeader.markup = Number(input.markup_pct);
    appData.estimateLines.push(newHeader);
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Added section: "' + newHeader.description + '"' + (newHeader.markup != null ? ' (markup ' + newHeader.markup + '%)' : '');
  }

  function applyUpdateScope(input) {
    var alt = getActiveAlternate();
    if (!alt) throw new Error('No active alternate.');
    var mode = input.mode === 'append' ? 'append' : 'replace';
    var newScope;
    if (mode === 'append' && alt.scope) {
      newScope = alt.scope.replace(/\s+$/, '') + '\n\n' + (input.scope_text || '');
    } else {
      newScope = input.scope_text || '';
    }
    alt.scope = newScope;
    debouncedSave();
    renderScopePanel();
    return 'Updated scope on alternate "' + alt.name + '" (' + mode + ', ' + newScope.length + ' chars)';
  }

  // Delete a single line item by id. Refuses to delete section headers
  // here — those go through applyDeleteSection so the side-effects on
  // the lines beneath them are explicit.
  function applyDeleteLine(input) {
    var lineId = input.line_id;
    if (!lineId) throw new Error('line_id required');
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    if (!line) throw new Error('Line not found.');
    if (line.section === '__section_header__') throw new Error('Use propose_delete_section for section headers.');
    var name = line.description || lineId;
    appData.estimateLines = appData.estimateLines.filter(function(l) { return l.id !== lineId; });
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Deleted line: "' + name + '"';
  }

  // Update editable fields on an existing line. Only the keys present in
  // `input` are touched; everything else stays. `markup_pct` accepts null
  // to clear the per-line override (back to inheriting from the section).
  // `section_name` does a case-insensitive substring match against section
  // headers in the same alternate and re-positions the line under it.
  function applyUpdateLine(input) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === input.line_id; });
    if (!line) throw new Error('Line not found.');
    if (line.section === '__section_header__') throw new Error('Use propose_update_section to change section headers.');
    var changed = [];
    if (input.description != null) { line.description = String(input.description); changed.push('description'); }
    if (input.qty != null) { line.qty = Number(input.qty); changed.push('qty'); }
    if (input.unit != null) { line.unit = String(input.unit); changed.push('unit'); }
    if (input.unit_cost != null) { line.unitCost = Number(input.unit_cost); changed.push('unit_cost'); }
    if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) {
      if (input.markup_pct == null || input.markup_pct === '') { line.markup = ''; changed.push('cleared markup override'); }
      else { line.markup = Number(input.markup_pct); changed.push('markup'); }
    }
    // Section move: find the matching section header and re-splice the
    // line just before the next header (or end-of-alternate). Mirrors the
    // insertion logic addEstimateLineFromEditor uses.
    if (input.section_name) {
      var alt = getActiveAlternate();
      if (alt) {
        var needle = String(input.section_name).toLowerCase();
        var headers = (appData.estimateLines || []).filter(function(L) {
          return L.estimateId === line.estimateId && L.alternateId === line.alternateId && L.section === '__section_header__';
        });
        var match = headers.find(function(H) { return (H.description || '').toLowerCase().indexOf(needle) >= 0; });
        if (match) {
          appData.estimateLines = appData.estimateLines.filter(function(l) { return l.id !== line.id; });
          var arr = appData.estimateLines;
          var startIdx = arr.findIndex(function(l) { return l.id === match.id; });
          var insertAt = arr.length;
          for (var j = startIdx + 1; j < arr.length; j++) {
            var L2 = arr[j];
            if (L2.estimateId !== line.estimateId || L2.alternateId !== line.alternateId) continue;
            if (L2.section === '__section_header__') { insertAt = j; break; }
          }
          arr.splice(insertAt, 0, line);
          changed.push('moved to "' + match.description + '"');
        }
      }
    }
    if (!changed.length) return 'No fields changed on "' + (line.description || line.id) + '".';
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Updated "' + (line.description || line.id) + '": ' + changed.join(', ');
  }

  // Delete a section header. Lines under it remain in the array — they
  // simply fall under whichever section header now precedes them
  // (or become unsectioned if the deleted header was the first).
  function applyDeleteSection(input) {
    var section = (appData.estimateLines || []).find(function(l) { return l.id === input.section_id; });
    if (!section) throw new Error('Section not found.');
    if (section.section !== '__section_header__') throw new Error('That id is not a section header.');
    var name = section.description || input.section_id;
    appData.estimateLines = appData.estimateLines.filter(function(l) { return l.id !== input.section_id; });
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Removed section header: "' + name + '" (lines preserved).';
  }

  // Update fields on an existing section header. Same partial-update
  // semantics as applyUpdateLine — only specified keys get touched.
  function applyUpdateSection(input) {
    var section = (appData.estimateLines || []).find(function(l) { return l.id === input.section_id; });
    if (!section) throw new Error('Section not found.');
    if (section.section !== '__section_header__') throw new Error('That id is not a section header.');
    var changed = [];
    if (input.name != null) { section.description = String(input.name); changed.push('renamed to "' + section.description + '"'); }
    if (input.bt_category != null) { section.btCategory = String(input.bt_category); changed.push('BT category → ' + section.btCategory); }
    if (Object.prototype.hasOwnProperty.call(input, 'markup_pct')) {
      if (input.markup_pct == null || input.markup_pct === '') { section.markup = ''; changed.push('cleared section markup'); }
      else { section.markup = Number(input.markup_pct); changed.push('markup → ' + section.markup + '%'); }
    }
    if (!changed.length) return 'No fields changed on section "' + (section.description || input.section_id) + '".';
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Section: ' + changed.join(', ');
  }

  window.estimateEditorAPI = {
    isOpenFor: function(estimateId) { return _currentId === estimateId; },
    getOpenId: function() { return _currentId; },
    activeAlternateName: function() { var a = getActiveAlternate(); return a ? a.name : null; },
    // Returns the client_id of the client linked to the open estimate,
    // or null if the estimate is unlinked. Used by propose_add_client_note
    // so the AG applier can route the note write to the right client
    // without making the model carry the id.
    getLinkedClientId: function() {
      if (!_currentId || !window.appData) return null;
      var e = (appData.estimates || []).find(function(x) { return x.id === _currentId; });
      return e ? (e.client_id || null) : null;
    },
    applyAddLineItem: applyAddLineItem,
    applyAddSection: applyAddSection,
    applyUpdateScope: applyUpdateScope,
    applyDeleteLine: applyDeleteLine,
    applyUpdateLine: applyUpdateLine,
    applyDeleteSection: applyDeleteSection,
    applyUpdateSection: applyUpdateSection
  };
  window.addAlternateFromEditor = addAlternateFromEditor;
  window.renameActiveAlternate = renameActiveAlternate;
  window.duplicateActiveAlternate = duplicateActiveAlternate;
  window.deleteActiveAlternate = deleteActiveAlternate;
  window.toggleGroupInclude = toggleGroupInclude;
})();
