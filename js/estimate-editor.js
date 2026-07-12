// Project 86 Estimate Editor — Phase A.
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
  var _estimateLocked = false;  // sold estimate, locked on lead→job convert (read-only)
  var _saveTimer = null;
  // When the editor was opened from inside a lead detail (via
  // openEstimateFromLead), this holds the lead id so close → "Back"
  // returns the user to the lead instead of dumping them at the
  // estimates list. Cleared on close.
  var _returnToLeadId = null;
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
  if (typeof window !== 'undefined' && window.p86PushStatus &&
      typeof window.p86PushStatus.subscribe === 'function') {
    window.p86PushStatus.subscribe(function(status, err) {
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
    if (_estimateLocked) return;  // sold/locked estimate — read-only, no saves
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
      if (!window.p86Api || !window.p86Api.isAuthenticated()) {
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

  // Locked (sold) estimates are read-only — toggle the .ee-locked class (CSS
  // disables the inputs) and show a banner with an admin "Unlock" button.
  function applyEstimateLockState(est, editorView) {
    editorView = editorView || document.getElementById('estimate-editor-view');
    if (!editorView) return;
    var locked = !!(est && est.is_locked);
    editorView.classList.toggle('ee-locked', locked);
    var banner = document.getElementById('ee-lock-banner');
    if (!locked) { if (banner) banner.remove(); return; }
    if (!banner) {
      banner = document.createElement('div');
      banner.id = 'ee-lock-banner';
      banner.className = 'ee-lock-banner';
      editorView.insertBefore(banner, editorView.firstChild);
    }
    banner.innerHTML =
      '<span><strong>🔒 Sold — locked.</strong> Won and converted to a job, so this estimate is read-only.</span>' +
      '<button type="button" id="ee-unlock-btn" class="ee-btn small">Unlock to edit</button>';
    var btn = document.getElementById('ee-unlock-btn');
    if (btn && est) btn.onclick = function () { unlockEstimate(est.id); };
  }

  // Admin override — clear the lock so a sold estimate can be corrected.
  function unlockEstimate(id) {
    if (!id || !window.p86Api) return;
    var btn = document.getElementById('ee-unlock-btn');
    // C2: the old native window.confirm() SILENTLY NO-OPS in the installed PWA
    // (see reference_pwa_native_dialogs) — first click did nothing, so it felt
    // like it needed two clicks. Use the PWA-safe p86Confirm modal, and disable
    // the button on confirm so a fast double-click can't fire two PUTs.
    var doUnlock = function () {
      if (btn) { btn.disabled = true; btn.textContent = 'Unlocking…'; }
      window.p86Api.put('/api/estimates/' + encodeURIComponent(id) + '/lock', { locked: false })
        .then(function () {
          var e = getEstimate(); if (e) e.is_locked = false;
          _estimateLocked = false;
          applyEstimateLockState(getEstimate());
        })
        .catch(function (err) {
          if (btn) { btn.disabled = false; btn.textContent = 'Unlock to edit'; }
          alert('Unlock failed: ' + (err && err.message || ''));
        });
    };
    var msg = 'Unlock this sold estimate for editing? It becomes editable again until re-locked.';
    if (typeof window.p86Confirm === 'function') {
      window.p86Confirm({ title: 'Unlock estimate', message: msg, confirmText: 'Unlock' })
        .then(function (ok) { if (ok) doUnlock(); });
    } else if (window.confirm(msg)) {
      doUnlock();
    }
  }

  // The estimate editor shows its PARENT LEAD's card in the sidebar — there is
  // no dedicated estimate card. estimate.lead_id → lead → p86MountLeadCard.
  // No linked lead → no card. Leads live in the p86Leads cache (NOT
  // appData.leads — the old lookup there never matched, so the card never
  // mounted); when the editor is opened straight from the Estimates list the
  // cache may be cold, so fall back to fetching the lead by id (same pattern
  // renderHeaderChips used). The card doubles as the jump-to-lead affordance
  // now that the header "From lead" chip is gone — click opens the lead.
  function mountEstimateSidebarCard(est) {
    if (!window.p86EntitySubnav) return;
    var leadId = est && est.lead_id;
    if (!leadId) { window.p86EntitySubnav.clearAll(); return; }
    var estId = est.id;
    function mountFor(lead) {
      if (!lead || typeof window.p86MountLeadCard !== 'function') { window.p86EntitySubnav.clearAll(); return; }
      window.p86MountLeadCard(lead);
      var wrap = document.getElementById('app-leadnav');
      if (wrap) {
        wrap.style.cursor = 'pointer';
        wrap.title = 'Open lead: ' + (lead.title || '');
        wrap.onclick = function () { jumpToLeadFromEstimate(lead.id); };
      }
    }
    var leads = (window.p86Leads && window.p86Leads.getCached && window.p86Leads.getCached()) || [];
    var lead = leads.find(function (x) { return x.id === leadId; });
    if (lead) { mountFor(lead); return; }
    if (window.p86Api && window.p86Api.leads && typeof window.p86Api.leads.get === 'function') {
      window.p86Api.leads.get(leadId).then(function (res) {
        // Only mount if this estimate is still the open one.
        if (res && res.lead && _currentId === estId) {
          if (window.p86Leads && typeof window.p86Leads.cacheLead === 'function') window.p86Leads.cacheLead(res.lead);
          mountFor(res.lead);
        }
      }).catch(function () { /* lead deleted or no perms — no card */ });
    }
  }

  function openEstimateEditor(estimateId) {
    // Block editor while the initial server fetch is in-flight — opens
    // during the gap could let the user type edits against stale cache
    // that get silently overwritten when the fetch resolves.
    if (typeof window.p86DataLoading === 'function' && window.p86DataLoading()) {
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
    _estimateLocked = !!(est && est.is_locked);
    applyEstimateLockState(est, editorView);
    // The legacy Leads/Estimates/Clients/Subs sub-tab row
    // (#estimates-main-tabs) is permanently hidden now that Leads +
    // Estimates are top-level header tabs and Clients + Subs sit in
    // the Directory dropdown. The DOM nodes still exist (DIVs below
    // toggle via switchEstimatesSubTab) but the visual nav row never
    // shows — see the inline display:none on the wrapper in
    // index.html. Don't re-toggle it here.

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
    if (typeof window.p86NavSave === 'function') window.p86NavSave();
    mountEstimateSidebarCard(est);
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
    var rts = [];
    hosts.forEach(function(pane, i) {
      if (!est || !alt) { pane.innerHTML = ''; return; }
      pane.innerHTML =
        '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;gap:8px;">' +
          '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Scope of Work</div>' +
          '<div style="font-size:11px;color:#4f8cff;font-weight:600;">' + escapeHTML(alt.name || 'Alternate') + '</div>' +
        '</div>' +
        '<div class="ee-scope-rt" id="ee-scope-host-' + i + '"></div>' +
        '<div style="font-size:10px;color:var(--text-dim,#888);margin-top:6px;">Saved per alternate. Rich text — used by the Preview tab and PDF/Buildertrend exports.</div>';
      var host = pane.querySelector('#ee-scope-host-' + i);
      if (host && window.p86RichText && window.p86RichText.mount) {
        // Capture `alt` in the closure (NOT getActiveAlternate() at fire time) so a
        // debounced change landing AFTER an alternate switch still writes to the
        // right alternate. onChange mirrors into the other open scope editors.
        rts[i] = window.p86RichText.mount(host, {
          value: alt.scope || '',
          placeholder: 'Bulleted scope, narrative, or whatever the proposal needs. This is per-alternate.',
          minHeight: 340,
          onChange: function(html) {
            alt.scope = html;
            debouncedSave();
            rts.forEach(function(other, j) { if (j !== i && other) other.setHTML(html); });
          }
        });
      } else if (host) {
        // Fallback: plain textarea if the rich-text module didn't load.
        var ta = document.createElement('textarea');
        ta.rows = 18;
        ta.placeholder = 'Bulleted scope, narrative, or whatever the proposal needs. This is per-alternate.';
        ta.style.cssText = 'width:100%;resize:vertical;font-family:inherit;font-size:13px;line-height:1.55;padding:12px 14px;background:var(--card-bg,#141419);border:1px solid var(--border,#333);border-radius:8px;color:var(--text,#fff);';
        ta.value = (window.p86RichText && window.p86RichText.toPlainText) ? window.p86RichText.toPlainText(alt.scope || '') : (alt.scope || '');
        host.appendChild(ta);
        ta.oninput = function() { alt.scope = ta.value; debouncedSave(); };
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
    var inFlight = (window.p86PushStatus && typeof window.p86PushStatus.inFlight === 'function')
      ? window.p86PushStatus.inFlight()
      : Promise.resolve();
    var actuallyClose = function() {
      _currentId = null;
      _saveState = 'idle';
      if (window.p86EntitySubnav) window.p86EntitySubnav.clearAll();
      var listView = document.getElementById('estimates-list-view');
      var editorView = document.getElementById('estimate-editor-view');
      if (editorView) editorView.style.display = 'none';
      if (listView) listView.style.display = '';
      // (no #estimates-main-tabs restore — see open-handler comment)
      if (typeof renderEstimatesList === 'function') renderEstimatesList();

      // If the editor was opened from a lead (openEstimateFromLead set
      // _returnToLeadId before opening), bounce the user back into that
      // lead so the "Back" path matches their entry path.
      if (_returnToLeadId) {
        var lid = _returnToLeadId;
        _returnToLeadId = null;
        if (typeof window.switchEstimatesSubTab === 'function') {
          try { window.switchEstimatesSubTab('leads'); } catch (e) { /* defensive */ }
        }
        if (typeof window.openEditLeadModal === 'function') {
          try { window.openEditLeadModal(lid); } catch (e) { /* defensive */ }
        }
      }
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
      } else if (name === 'workspace') {
        // Phase 0 — estimate-side workspace. Mount the shared
        // workspace engine (js/workspace.js) into the tab's content
        // host. initWorkspace is async — the shell renders
        // immediately, the workbook fetches in the background, then
        // the grid re-renders when load resolves. We re-init every
        // time the tab is shown so switching between estimates picks
        // up the new entityId without a stale workbook lingering.
        var wsMount = document.getElementById('ee-tab-workspace');
        if (!wsMount) {
          console.warn('[estimate-editor] workspace mount point missing');
        } else if (!_currentId) {
          wsMount.innerHTML = '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;font-style:italic;">No estimate loaded.</div>';
        } else if (typeof window.initWorkspace === 'function') {
          // Container needs an id the workspace engine can query —
          // re-use the tab content div itself by giving it a stable
          // child container. Reset the children first so a previous
          // estimate's workspace DOM doesn't leak into this one.
          wsMount.innerHTML = '<div id="ee-workspace-host" style="height:100%;min-height:600px;"></div>';
          window.initWorkspace('ee-workspace-host', 'estimate', _currentId);
        } else {
          wsMount.innerHTML = '<div style="padding:18px;color:var(--yellow,#fbbf24);font-size:12px;">Workspace engine not loaded — refresh the page.</div>';
          console.warn('[estimate-editor] window.initWorkspace not available; can not mount workspace tab');
        }
      } else if (name === 'photos') {
        var mountEl = document.getElementById('ee-photos-mount');
        if (!mountEl) {
          console.warn('[estimate-editor] photos mount point missing');
        } else if (!_currentId) {
          mountEl.innerHTML = '<div style="padding:18px;color:var(--text-dim,#888);font-size:12px;font-style:italic;">No estimate loaded.</div>';
        } else if (window.p86Explorer && typeof window.p86Explorer.mount === 'function') {
          // Full Explorer for the estimate's own files. If the estimate was
          // created from a lead (has lead_id), the lead's files appear as a
          // read-only "From lead" pinned pseudo-folder (parentEntity) so
          // they can feed proposal building without being editable here.
          var est = getEstimate();
          var mountOpts = {
            entityType: 'estimate',
            entityId: _currentId,
            canEdit: true,
            embedded: true
          };
          if (est && est.lead_id) {
            mountOpts.parentEntity = {
              entityType: 'lead',
              entityId: est.lead_id,
              label: 'From lead'
            };
          }
          window.p86Explorer.mount(mountEl, mountOpts);
        } else if (window.p86Attachments && typeof window.p86Attachments.mount === 'function') {
          // Fallback: the legacy attachments widget with the same read-only
          // parent inheritance, in case the Explorer module failed to load.
          var estA = getEstimate();
          var mountOptsA = {
            entityType: 'estimate',
            entityId: _currentId,
            canEdit: true
          };
          if (estA && estA.lead_id) {
            mountOptsA.parentEntity = {
              entityType: 'lead',
              entityId: estA.lead_id,
              label: 'From lead'
            };
          }
          window.p86Attachments.mount(mountEl, mountOptsA);
        } else {
          mountEl.innerHTML = '<div style="padding:18px;color:var(--yellow,#fbbf24);font-size:12px;">File browser not loaded — refresh the page.</div>';
          console.warn('[estimate-editor] neither p86Explorer nor p86Attachments available; can not mount photos tab');
        }

        // ── Linked Projects panel ──
        // Estimates inherit project context from their parent lead.
        // If the estimate has a lead_id, show projects linked to that
        // lead; otherwise show a stub explaining why the panel is
        // empty.
        var projMount = document.getElementById('ee-projects-mount');
        if (projMount && typeof window.renderLinkedProjectsPanel === 'function') {
          var est2 = getEstimate();
          if (est2 && est2.lead_id) {
            window.renderLinkedProjectsPanel(projMount, { kind: 'lead', id: est2.lead_id });
          } else if (est2 && est2.client_id) {
            window.renderLinkedProjectsPanel(projMount, { kind: 'client', id: est2.client_id });
          } else {
            projMount.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">Link this estimate to a lead or client to surface projects.</div>';
          }
        }

        // ── Tasks panel ──
        // Unlike projects (inherited from the parent lead/client), tasks
        // link directly to this estimate via tasks.entity_type='estimate'.
        var taskMount = document.getElementById('ee-tasks-mount');
        if (taskMount && window.p86Tasks && typeof window.p86Tasks.mountEntityPanel === 'function') {
          var est3 = getEstimate();
          if (est3 && est3.id) {
            var estLabel = (est3.title || est3.name) || ('Estimate ' + est3.id);
            window.p86Tasks.mountEntityPanel(taskMount, 'estimate', est3.id, estLabel);
          } else {
            taskMount.innerHTML = '<div style="font-size:12px;color:var(--text-dim,#888);font-style:italic;padding:6px 0;">Save the estimate first to add tasks.</div>';
          }
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

  // ──────────────────────────────────────────────────────────────────
  // AG phase (Plan vs Build). A per-estimate flag that gates whether
  // AG can propose line-item / section edits. Plan mode = AG asks
  // questions and discusses scope; Build mode = AG proposes freely.
  //
  // Stored on the estimate's JSONB blob as `aiPhase` ('plan' | 'build').
  // Defaults to 'build' for back-compat with existing estimates.
  //
  // Server reads the same field on every chat turn and filters tools +
  // injects mode-specific instructions. The toggle pill itself lives in
  // the AI panel header (rendered by ai-panel.js) — these helpers stay
  // here because the editor owns the estimate state.
  // ──────────────────────────────────────────────────────────────────
  // Three-way mode (since the Plan/Build → Plan/Edit/Auto rename):
  //   plan  — read-only: 86 can discuss but propose_* tools are filtered
  //           off server-side.
  //   edit  — approval cards for every propose_* (legacy 'build' value
  //           is auto-coerced to 'edit' for back-compat).
  //   auto  — same server-side tools as edit, but the client auto-clicks
  //           Approve for whitelisted estimate-line tools so simple
  //           "build the lines" workflows skip the per-card friction.
  function getEstimateAIPhase() {
    var est = getEstimate();
    if (!est) return 'edit';
    if (est.aiPhase === 'plan') return 'plan';
    if (est.aiPhase === 'auto') return 'auto';
    // Legacy 'build' rows + any unrecognized value coerce to 'edit'.
    return 'edit';
  }

  function setEstimateAIPhase(phase) {
    var est = getEstimate();
    if (!est) return;
    var nextPhase =
      phase === 'plan' ? 'plan' :
      phase === 'auto' ? 'auto' : 'edit';
    if (est.aiPhase === nextPhase) return;
    est.aiPhase = nextPhase;
    debouncedSave();
    // Tell the AI panel to re-render its pill + notice + header.
    if (window.p86AI && typeof window.p86AI.refreshPhaseChip === 'function') {
      try { window.p86AI.refreshPhaseChip(); } catch (e) { /* ignore */ }
    }
  }

  function renderHeaderChips() {
    var est = getEstimate();
    var chipsEl = document.getElementById('ee-linked-chips');
    if (!chipsEl) return;
    var html = '';

    // Proposal approval workflow — status pill + Send / Record-approval actions.
    html += proposalActionsHtml(est);

    // The client chip + "From lead" chip are gone — that context now lives on
    // the parent LEAD's card in the sidebar (mountEstimateSidebarCard), which
    // is also the click-through to the lead. Only the job ACTIONS remain here.

    // Create Job (or Open Job) from this estimate — the estimate-side entry
    // point for lead/estimate -> job conversion. Flips to "Open job" once the
    // estimate is linked. Gated to job-editors; the server also enforces it.
    if (est.job_id) {
      html += '<button class="ee-btn secondary" onclick="openJobFromEstimate(\'' + escapeHTML(est.job_id) + '\')" style="display:inline-flex;align-items:center;gap:6px;background:rgba(52,211,153,0.12);color:var(--green,#34d399);">' +
        '<span>&#x1F3D7;&#xFE0F;</span>Open job &rarr;' +
      '</button>';
      // Push this estimate's current totals + workspace to the linked job so the
      // estimate stays the live source of truth (re-run after editing the bid).
      html += '<button class="ee-btn secondary" data-cap="JOBS_EDIT_ANY JOBS_EDIT_OWN" onclick="syncEstimateToJob()" title="Update the linked job\'s Contract + Estimated Costs + workspace from this estimate" style="display:inline-flex;align-items:center;gap:6px;background:rgba(79,140,255,0.12);color:#4f8cff;">' +
        '<span>&#x21BB;</span>Sync costs &rarr; job' +
      '</button>';
    } else {
      var _appr = (est.approval_status === 'approved');
      html += '<button class="ee-btn ' + (_appr ? 'primary' : 'secondary') + '" data-cap="JOBS_EDIT_ANY JOBS_EDIT_OWN" onclick="convertEstimateToJob()" title="' + (_appr ? 'Create the job from this approved &amp; signed estimate' : 'Create a job from this estimate') + '" style="display:inline-flex;align-items:center;gap:6px;' + (_appr ? 'background:#34d399;border-color:#34d399;color:#04210f;' : '') + '">' +
        '<span>&#x1F3D7;&#xFE0F;</span>' + (_appr ? 'Create Job from approved' : 'Create Job') +
      '</button>';
    }
    chipsEl.innerHTML = html;
  }

  // ── Proposal approval workflow (status pill + Send / Approve / Decline) ──────
  function proposalActionsHtml(est) {
    if (!est) return '';
    var st = est.approval_status || (est.sent_at ? 'sent' : 'draft');
    var lbl, col;
    if (st === 'approved') { lbl = '✓ Approved' + (est.approved_by ? ' · ' + escapeHTML(est.approved_by) : ''); col = '#34d399'; }
    else if (st === 'declined') { lbl = 'Declined'; col = '#f87171'; }
    else if (st === 'sent') { lbl = 'Sent' + (est.sent_to ? ' · ' + escapeHTML(est.sent_to) : ''); col = '#fbbf24'; }
    else { lbl = 'Draft'; col = 'var(--text-dim,#8b90a5)'; }
    var h = '<span class="ee-prop-pill" title="Proposal status" style="display:inline-flex;align-items:center;gap:5px;font-size:11px;font-weight:700;padding:4px 10px;border-radius:999px;background:rgba(255,255,255,0.05);color:' + col + ';border:1px solid ' + col + '44;">' + lbl + '</span>';
    if (est.job_id) return h;   // already converted — proposal actions no longer apply
    h += '<button class="ee-btn secondary" onclick="openProposalSend(\'' + escapeHTML(est.id) + '\')" title="Print or email this proposal to any recipient" style="display:inline-flex;align-items:center;gap:6px;"><span>📤</span>Send</button>';
    if (st !== 'approved') {
      h += '<button class="ee-btn secondary" onclick="openProposalApprove(\'' + escapeHTML(est.id) + '\')" title="Record that the proposal was approved / signed" style="display:inline-flex;align-items:center;gap:6px;"><span>✍️</span>Record approval</button>';
    }
    if (st === 'sent') {
      h += '<button class="ee-btn secondary" onclick="proposalDecline(\'' + escapeHTML(est.id) + '\')" title="Record that the client declined" style="font-size:11px;opacity:.85;">Declined?</button>';
    }
    return h;
  }

  function _propToast(msg, kind) { if (typeof window.p86Toast === 'function') window.p86Toast(msg, kind || 'info'); }
  function _findEst(id) { return (window.appData && appData.estimates || []).find(function(e){ return e.id === id; }); }
  function _defaultRecipient(est) { return (est && (est.managerEmail || est.cm_email || est.email)) || ''; }
  function _refreshEstList() { if (typeof window.renderEstimatesList === 'function') { try { window.renderEstimatesList(); } catch (e) {} } }

  // Send / print the proposal to ANY recipient. Records recipient + method. Three
  // paths: Print/PDF (record only), Email (system/Resend branded summary), and —
  // when the user has connected their Microsoft 365 mailbox — "Send from my
  // Outlook", which sends from the user's OWN mailbox (Graph Mail.Send) so replies
  // land in their inbox + it shows in Sent. Outlook is the DEFAULT when connected
  // (John's real workflow: email the proposal, get a signed scan / "approved" reply
  // back, then Record approval + attach the signed doc to the lead).
  async function openProposalSend(estId) {
    var est = _findEst(estId); if (!est) return;
    var outlookOn = false, outlookEmail = '';
    try {
      if (window.p86Api && window.p86Api.outlook && window.p86Api.outlook.status) {
        var _st = await window.p86Api.outlook.status();
        outlookOn = !!(_st && _st.connected);
        outlookEmail = (_st && _st.email) || '';
      }
    } catch (e) {}

    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483200;background:rgba(6,9,17,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
    var outlookOpt = outlookOn
      ? '<label style="flex:1 1 100%;display:flex;align-items:center;gap:6px;font-size:13px;border:1px solid #34d39955;border-radius:8px;padding:8px 10px;cursor:pointer;background:rgba(52,211,153,0.06);"><input type="radio" name="propMethod" value="outlook" checked> <span>Send from my Outlook' + (outlookEmail ? ' <span style="color:var(--text-dim,#888);font-size:11px;">(' + escapeHTML(outlookEmail) + ')</span>' : '') + '</span></label>'
      : '';
    back.innerHTML =
      '<div class="modal-content" style="width:min(460px,96vw);">' +
        '<div class="p86-dialog-title">Send proposal</div>' +
        '<label style="display:block;font-size:12px;margin:10px 0 4px;">Recipient email (any address)</label>' +
        '<input class="p86-dialog-input" id="propSendTo" type="email" placeholder="name@company.com" value="' + escapeHTML(_defaultRecipient(est)) + '" />' +
        '<label style="display:block;font-size:12px;margin:12px 0 4px;">How</label>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          outlookOpt +
          '<label style="flex:1;display:flex;align-items:center;gap:6px;font-size:13px;border:1px solid var(--border,#333);border-radius:8px;padding:8px 10px;cursor:pointer;"><input type="radio" name="propMethod" value="print"' + (outlookOn ? '' : ' checked') + '> Print / PDF</label>' +
          '<label style="flex:1;display:flex;align-items:center;gap:6px;font-size:13px;border:1px solid var(--border,#333);border-radius:8px;padding:8px 10px;cursor:pointer;"><input type="radio" name="propMethod" value="email"> Email (system)</label>' +
        '</div>' +
        (outlookOn ? '' : '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:8px;">Connect Outlook in My Account to send proposals from your own mailbox.</div>') +
        '<div class="p86-dialog-actions" style="margin-top:16px;">' +
          '<button class="p86-dialog-btn" data-cancel>Cancel</button>' +
          '<button class="p86-dialog-btn p86-dialog-btn-primary" data-send>Send</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('[data-cancel]').addEventListener('click', close);

    // Record the send server-side (approval_status→sent, sent_to/method/at). The
    // print/email path may pass html for the Resend fallback; outlook never does.
    function recordSend(payload) {
      return window.p86Api.estimates.send(estId, payload).then(function (r) {
        est.approval_status = (r && r.approval_status) || est.approval_status || 'sent';
        est.sent_to = payload.to || est.sent_to; est.sent_method = payload.method;
        if (r && 'sent_at' in r) est.sent_at = r.sent_at;
        if (r && 'sent_count' in r) est.sent_count = r.sent_count;
        close(); renderHeaderChips(); _refreshEstList();
        return r;
      });
    }

    back.querySelector('[data-send]').addEventListener('click', function () {
      var to = (back.querySelector('#propSendTo').value || '').trim();
      var method = (back.querySelector('input[name="propMethod"]:checked') || {}).value || 'print';
      if ((method === 'email' || method === 'outlook') && !/.+@.+\..+/.test(to)) { _propToast('Enter a valid recipient email.', 'error'); return; }
      var btn = back.querySelector('[data-send]'); btn.disabled = true; btn.textContent = 'Sending…';

      if (method === 'outlook') {
        // Send through the user's own Microsoft 365 mailbox, THEN record it
        // (method='outlook' → server records but does NOT also Resend).
        var subject = 'Proposal: ' + (est.title || est.name || 'AGX');
        window.p86Api.outlook.sendMail({ to: to, subject: subject, body: buildProposalEmailText(est) })
          .then(function () { return recordSend({ to: to, method: 'outlook' }); })
          .then(function () { _propToast('Proposal sent from your Outlook to ' + to, 'success'); })
          .catch(function (e) {
            btn.disabled = false; btn.textContent = 'Send';
            var m = (e && e.message) || 'Could not send from Outlook.';
            if (/not_connected|reauth/i.test(m)) m = 'Outlook needs reconnecting (My Account → Outlook).';
            _propToast(m, 'error');
          });
        return;
      }

      var payload = { to: to, method: method };
      if (method === 'email') { payload.subject = 'Proposal: ' + (est.title || est.name || 'AGX'); payload.html = buildProposalEmailHtml(est); }
      recordSend(payload).then(function (r) {
        if (method === 'print') { setTimeout(function () { try { window.print(); } catch (e) {} }, 80); _propToast('Recorded — opening the print dialog…', 'success'); }
        else if (r && r.emailed) _propToast('Proposal emailed to ' + to, 'success');
        else _propToast('Recorded. Email not sent' + (r && r.emailError ? ' (' + r.emailError + ')' : '') + '.', 'error');
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'Send'; _propToast((e && e.message) || 'Could not send.', 'error'); });
    });
    setTimeout(function () { var i = back.querySelector('#propSendTo'); if (i) i.focus(); }, 0);
  }
  window.openProposalSend = openProposalSend;

  // A compact branded proposal email body (Slice 1). The full line-item proposal
  // PDF + hosted signing page come in later slices.
  function buildProposalEmailHtml(est) {
    var totals = (window.computeEstimateTotals ? window.computeEstimateTotals(est) : {}) || {};
    var total = (totals.proposalTotal != null) ? totals.proposalTotal : 0;
    var money = function (n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var esc = escapeHTML, addr = est.propertyAddr || est.address || '';
    return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:640px;margin:0 auto;color:#1a1a1a;">' +
      '<div style="background:#0f172a;color:#fff;padding:18px 22px;border-radius:10px 10px 0 0;"><div style="font-size:20px;font-weight:800;letter-spacing:1px;">AGX</div><div style="font-size:11px;opacity:.8;letter-spacing:2px;">AG EXTERIORS</div></div>' +
      '<div style="border:1px solid #e5e7eb;border-top:0;border-radius:0 0 10px 10px;padding:22px;">' +
        '<h2 style="margin:0 0 4px;font-size:18px;">' + esc(est.title || est.issue || 'Proposal') + '</h2>' +
        (est.client ? '<div style="color:#555;">' + esc(est.client) + '</div>' : '') +
        (addr ? '<div style="color:#555;font-size:13px;">' + esc(addr) + '</div>' : '') +
        '<div style="margin:18px 0;padding:14px 16px;background:#f1f5f9;border-radius:8px;display:flex;justify-content:space-between;align-items:center;">' +
          '<span style="font-weight:700;color:#334155;">Proposal total</span>' +
          '<span style="font-weight:800;font-size:20px;color:#0f172a;">' + money(total) + '</span>' +
        '</div>' +
        (function () {
          var _a = (typeof getActiveAlternate === 'function') ? getActiveAlternate() : null;
          var _s = (_a && _a.scope) || est.scopeOfWork || '';
          var _h = window.p86RichText ? window.p86RichText.toDisplayHTML(_s) : (_s ? '<div style="white-space:pre-wrap;">' + esc(_s) + '</div>' : '');
          return _h ? '<div style="font-size:13px;line-height:1.6;">' + _h + '</div>' : '';
        })() +
        '<p style="font-size:13px;color:#555;margin-top:18px;">Please reply to this email to approve, or reach out with any questions. Thank you for the opportunity.</p>' +
      '</div></div>';
  }

  // Plain-text proposal summary for the Outlook send path (Graph sendMail uses
  // contentType:'Text'). Mirrors buildProposalEmailHtml's content without markup.
  function buildProposalEmailText(est) {
    var totals = (window.computeEstimateTotals ? window.computeEstimateTotals(est) : {}) || {};
    var total = (totals.proposalTotal != null) ? totals.proposalTotal : 0;
    var money = function (n) { return '$' + Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
    var addr = est.propertyAddr || est.address || '';
    var lines = ['Hi,', '', 'Please find our proposal summary below.', '', (est.title || est.issue || 'Proposal')];
    if (est.client) lines.push(est.client);
    if (addr) lines.push(addr);
    lines.push('', 'Proposal total: ' + money(total));
    var _sa = (typeof getActiveAlternate === 'function') ? getActiveAlternate() : null;
    var _sv = (_sa && _sa.scope) || est.scopeOfWork || '';
    var _st = window.p86RichText ? window.p86RichText.toPlainText(_sv) : _sv;
    if (_st) { lines.push('', _st.slice(0, 1500)); }
    lines.push('', 'Reply to this email to approve, or let me know if you have any questions.', '', 'Thank you,', 'AGX');
    return lines.join('\n');
  }

  // Upload a signed proposal / contract as proof of approval. Files to the parent
  // LEAD when present (so it shows on the lead AND, via inheritance, on the
  // estimate); else to the estimate. Uploads at ROOT first (reliable), then best-
  // effort moves it into the target folder — the Explorer reads folder_id, and
  // upload only sets the legacy folder STRING, so a move is what actually files it.
  function _attachSignedDoc(est, file) {
    var et = est.lead_id ? 'lead' : 'estimate';
    var eid = est.lead_id || est.id;
    var folderName = est.lead_id ? 'Proposals' : 'Contract';
    var caption = ('Signed proposal — ' + (est.title || est.name || '')).slice(0, 160);
    var api = window.p86Api;
    return api.attachments.upload(et, eid, file, { geo: false, caption: caption }).then(function (up) {
      var result = { et: et, eid: eid, attachment: up && up.attachment };
      var attId = up && up.attachment && up.attachment.id;
      if (!attId || !api.fileFolders) return result;
      // tree() seeds the default buckets, so the target folder exists to file into.
      return api.fileFolders.tree(et, eid).then(function (tr) {
        var folders = (tr && tr.folders) || [];
        var match = folders.find(function (f) { return String(f.name || '').toLowerCase() === folderName.toLowerCase(); });
        if (match && match.id) return match.id;
        return api.fileFolders.create(et, eid, { name: folderName }).then(function (cr) { return cr && cr.folder && cr.folder.id; });
      }).then(function (fid) {
        if (!fid) return result;
        return api.fileFolders.moveFiles(et, eid, [attId], fid).then(function () { return result; });
      }).catch(function () { return result; });  // filed-at-root is an acceptable fallback
    });
  }

  // Record a manual / e-sign approval. Captures approver name + method (+ an
  // optional signed doc → filed to the lead) → flips the estimate to Approved;
  // the linked lead then shows the "create job" flag.
  function openProposalApprove(estId) {
    var est = _findEst(estId); if (!est) return;
    var back = document.createElement('div');
    back.style.cssText = 'position:fixed;inset:0;z-index:2147483200;background:rgba(6,9,17,.6);display:flex;align-items:center;justify-content:center;padding:16px;';
    back.innerHTML =
      '<div class="modal-content" style="width:min(460px,96vw);">' +
        '<div class="p86-dialog-title">Record proposal approval</div>' +
        '<div class="p86-dialog-message">Marks this proposal approved &amp; signed. The linked lead flags it as ready to create a job.</div>' +
        '<label style="display:block;font-size:12px;margin:10px 0 4px;">Approved by (client name)</label>' +
        '<input class="p86-dialog-input" id="propApprBy" type="text" placeholder="e.g. Jane Smith, Property Manager" />' +
        '<label style="display:block;font-size:12px;margin:12px 0 4px;">Method</label>' +
        '<select class="p86-dialog-input" id="propApprMethod"><option value="signed_doc">Signed document</option><option value="in_person">In person</option><option value="phone">Phone</option><option value="email">Email</option></select>' +
        '<label style="display:block;font-size:12px;margin:12px 0 4px;">Signed document / contract <span style="color:var(--text-dim,#888);font-weight:400;">(optional — proof of approval)</span></label>' +
        '<input id="propApprFile" type="file" accept="application/pdf,image/*" class="p86-dialog-input" style="padding:7px 9px;" />' +
        '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:6px;">Files to the ' + (est.lead_id ? 'lead’s Proposals folder' : 'estimate’s Contract folder') + ' as proof of approval.</div>' +
        '<div class="p86-dialog-actions" style="margin-top:16px;">' +
          '<button class="p86-dialog-btn" data-cancel>Cancel</button>' +
          '<button class="p86-dialog-btn p86-dialog-btn-primary" data-approve>Mark approved</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);
    function close() { if (back.parentNode) back.parentNode.removeChild(back); }
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    back.querySelector('[data-cancel]').addEventListener('click', close);
    back.querySelector('[data-approve]').addEventListener('click', function () {
      var by = (back.querySelector('#propApprBy').value || '').trim();
      var method = back.querySelector('#propApprMethod').value || 'signed_doc';
      var fileInput = back.querySelector('#propApprFile');
      var file = (fileInput && fileInput.files && fileInput.files[0]) || null;
      var btn = back.querySelector('[data-approve]'); btn.disabled = true; btn.textContent = 'Saving…';
      window.p86Api.estimates.approve(estId, { approved_by: by, method: method }).then(function (r) {
        est.approval_status = 'approved'; est.approved_by = by || (r && r.approved_by) || null; est.approval_method = method;
        if (r && 'approved_at' in r) est.approved_at = r.approved_at;
        if (!file) {
          close(); renderHeaderChips(); _refreshEstList();
          _propToast('Proposal approved — create the job when ready.', 'success');
          return;
        }
        // Approval is the critical write; the signed-doc attach is best-effort so a
        // flaky upload never blocks (or reverts) the recorded approval.
        btn.textContent = 'Attaching…';
        _attachSignedDoc(est, file).then(function (info) {
          close(); renderHeaderChips(); _refreshEstList();
          _propToast('Approved — signed doc filed to the ' + (info && info.et === 'lead' ? 'lead' : 'estimate') + '.', 'success');
        }).catch(function () {
          close(); renderHeaderChips(); _refreshEstList();
          _propToast('Approved. The signed file didn’t attach — add it in Files.', 'error');
        });
      }).catch(function (e) { btn.disabled = false; btn.textContent = 'Mark approved'; _propToast((e && e.message) || 'Could not save.', 'error'); });
    });
    setTimeout(function () { var i = back.querySelector('#propApprBy'); if (i) i.focus(); }, 0);
  }
  window.openProposalApprove = openProposalApprove;

  function proposalDecline(estId) {
    var est = _findEst(estId); if (!est) return;
    var ask = (typeof window.p86Prompt === 'function')
      ? window.p86Prompt({ title: 'Mark proposal declined', message: 'Optional reason', placeholder: 'e.g. went with another bid' })
      : Promise.resolve(prompt('Reason (optional):', ''));
    ask.then(function (reason) {
      if (reason === null) return;
      window.p86Api.estimates.decline(estId, reason || '').then(function (r) {
        est.approval_status = 'declined'; est.decline_reason = reason || '';
        if (r && 'declined_at' in r) est.declined_at = r.declined_at;
        renderHeaderChips(); _refreshEstList(); _propToast('Marked declined.', 'success');
      }).catch(function (e) { _propToast((e && e.message) || 'Could not update.', 'error'); });
    });
  }
  window.proposalDecline = proposalDecline;

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

  // Estimate-side "Create Job": build a job from THIS estimate — contract =
  // its proposal total, its workspace carries over — and commit it (plus the
  // lead/estimate links) via the shared atomic POST /api/jobs/convert. Mirrors
  // the lead-side convertLeadToJob; either entry point produces a linked job.
  async function convertEstimateToJob() {
    var est = getEstimate();
    if (!est) return;
    if (est.job_id) { alert('This estimate is already linked to a job. Use the Open job button.'); return; }

    // Double-submit guard (D4): a second click — or a click while the finalize
    // modal is open — must not mint a second job. Shared flag with the lead-side
    // convertLeadToJob; the finally clears it on every exit path.
    if (window._p86ConvertingJob) return;
    window._p86ConvertingJob = true;
    try {

    // Soft approval gate — if the proposal isn't marked approved/signed yet, confirm
    // before creating the job (surface, don't hard-block; migration + edge cases stay open).
    if (est.approval_status !== 'approved') {
      var _apMsg = 'This proposal isn’t marked approved/signed yet. Create the job anyway?';
      var _apOk = (typeof window.p86Confirm === 'function')
        ? await window.p86Confirm({ title: 'Not approved yet', message: _apMsg, confirmText: 'Create job anyway' })
        : confirm(_apMsg);
      if (!_apOk) return;
    }

    // Flush pending edits so the total + workbook we snapshot are current.
    try { if (typeof window.saveEstimateNow === 'function') await window.saveEstimateNow(); } catch (e) {}

    var totals = (window.computeEstimateTotals ? window.computeEstimateTotals(est) : null);
    var contractAmt = (totals && totals.proposalTotal) || 0;

    var clientName = '';
    var clientCache = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
    if (est.client_id) { var c = clientCache.find(function(x) { return x.id === est.client_id; }); if (c) clientName = c.company_name || c.name || ''; }
    if (!clientName) clientName = est.client_name || est.client || '';

    // Resolve the linked lead (so it also flips to sold + links).
    var leadId = est.lead_id || null;
    var lead = null;
    if (leadId) {
      var leads = (window.p86Leads && window.p86Leads.getCached && window.p86Leads.getCached()) || [];
      lead = leads.find(function(x) { return x.id === leadId; }) || null;
    }
    if (lead && lead.job_id) {
      if (confirm('The lead this estimate belongs to is already linked to a job. Open that job instead?')) openJobFromEstimate(lead.job_id);
      return;
    }

    function money(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
    // Job title = client short name + the proposal (estimate) name.
    var proposalName = est.name || est.title || '';
    var shortName = (c && c.short_name) ? c.short_name : (clientName || '');
    // Dedup the client name so "Client - Project" estimates don't yield
    // "Client Client - Project" (D3). Shared helper defined in leads.js.
    var suggestedTitle = (window.p86ComposeJobTitle
      ? window.p86ComposeJobTitle(shortName, proposalName)
      : ((shortName ? shortName + ' ' : '') + proposalName)).trim() || 'New Job';
    var _sub = 'New job from this estimate. Contract $' + money(contractAmt) + '.' + (leadId ? ' Marks the linked lead Sold.' : '');
    var fin = (window.p86JobFinalize && window.p86JobFinalize.open)
      ? await window.p86JobFinalize.open({ title: suggestedTitle, subtitle: _sub })
      : { jobNumber: (prompt('Job number (S#### or RV####):', '') || '').trim().toUpperCase(), title: suggestedTitle };
    if (!fin || !fin.jobNumber) return;

    // Guard against a duplicate job record for the same number (the RV2012
    // migration created one via "Add Job" and a second via this flow). Warn
    // before minting another job with a number that already exists.
    var _dupJob = (appData.jobs || []).find(function(j) {
      return j && String(j.jobNumber || '').trim().toUpperCase() === String(fin.jobNumber).trim().toUpperCase();
    });
    if (_dupJob) {
      var _proceed = (typeof window.p86Confirm === 'function')
        ? await window.p86Confirm({ title: 'Job number already exists', message: 'A job "' + fin.jobNumber + '" already exists. Creating another makes a duplicate record. Continue anyway?', confirmText: 'Create duplicate', destructive: true })
        : confirm('A job "' + fin.jobNumber + '" already exists. Create another?');
      if (!_proceed) return;
    }

    var me = window.p86Auth && window.p86Auth.getUser && window.p86Auth.getUser();
    var ownerId = (lead && lead.salesperson_id) || (me && me.id) || null;
    var jobId = 'j' + Date.now();
    var nowIso = new Date().toISOString();
    var newJob = {
      id: jobId, jobNumber: fin.jobNumber, title: fin.title || suggestedTitle,
      client: clientName, pm: '', owner_id: ownerId,
      // Carry the client link + address (from the estimate / its lead) so the
      // job isn't a shell — Link Client shows "Linked" and map/weather have an address.
      clientId: est.client_id || (lead && lead.client_id) || null,
      // Address: prefer the lead's, else fall back to the estimate's own
      // structured property address so an estimate-only → job still carries it.
      street_address: (lead && lead.street_address) || est.street_address || '',
      city: (lead && lead.city) || est.city || '',
      state: (lead && lead.state) || est.state || '',
      zip: (lead && lead.zip) || est.zip || '',
      address: [ (lead && lead.street_address) || est.street_address, (lead && lead.city) || est.city, (lead && lead.state) || est.state, (lead && lead.zip) || est.zip ].filter(Boolean).join(', '),
      jobType: (lead && lead.project_type) || est.jobType || '', workType: '',
      market: (lead && lead.market) || est.market || '', status: 'New',
      // Estimate is the source of truth for estimated costs (its base cost).
      contractAmount: contractAmt, estimatedCosts: (totals && typeof totals.baseCost === 'number' ? totals.baseCost : 0), targetMarginPct: 50,
      pctComplete: 0, invoicedToDate: 0, revisedCostChanges: 0,
      notes: (lead && lead.notes) || '',
      lead_id: leadId || null, estimate_id: est.id || null,
      createdAt: nowIso, updatedAt: nowIso
    };

    // Snapshot this estimate's workbook (reuse the lead-side helper).
    try {
      if (typeof window.p86InheritWorkbookFromEstimate === 'function') {
        var inh = await window.p86InheritWorkbookFromEstimate(est);
        if (inh && inh.workbook) newJob.workbook = inh.workbook;
      }
    } catch (e) {}

    try {
      var res = await window.p86Api.jobs.convert({ job: newJob, lead_id: leadId, estimate_id: est.id });
      var newId = (res && (res.job_id || res.id)) || jobId;
      newJob.id = newId;
      // Keep local caches consistent so the immediate open finds the job — without
      // this the Site Plan showed "No job loaded" / "Locating the job address…" and
      // you had to refresh (the lead-side convert already does this push).
      if (window.appData && Array.isArray(window.appData.jobs) && !window.appData.jobs.some(function(j){ return j.id === newId; })) {
        window.appData.jobs.push(newJob);
      }
      est.job_id = newId;
      if (lead) { lead.job_id = newId; lead.status = 'sold'; }
      if (typeof renderHeaderChips === 'function') renderHeaderChips();
      openJobFromEstimate(newId);
    } catch (err) {
      var m = (err && err.message) || '';
      if (/already linked/i.test(m)) alert('That lead is already linked to a job.');
      else alert('Could not create the job: ' + (m || 'unknown error') + '\n\nNothing was changed — try again.');
    }
    } finally { window._p86ConvertingJob = false; }
  }

  function openJobFromEstimate(jobId) {
    closeEstimateEditor();
    // Canonical router open (mirrors the lead-side convert). The manual
    // switchTab + setTimeout(editJob) combo could open the job page before the
    // route settled; use the router when present, fall back otherwise.
    if (window.p86Router && typeof window.p86Router.navigate === 'function') {
      window.p86Router.navigate({ top: 'jobs', jobId: jobId });
      return;
    }
    setTimeout(function() {
      if (typeof window.switchTab === 'function') window.switchTab('jobs');
      setTimeout(function() { if (typeof window.editJob === 'function') window.editJob(jobId); }, 200);
    }, 80);
  }
  window.convertEstimateToJob = convertEstimateToJob;
  window.openJobFromEstimate = openJobFromEstimate;

  // Re-push this (job-linked) estimate's totals + workspace to its job. Keeps
  // the estimate as the live source of truth for the job's estimated costs:
  // contract = proposal total, estimatedCosts = base cost, plus the workspace.
  async function syncEstimateToJob() {
    var est = getEstimate();
    if (!est || !est.job_id) return;
    try { if (typeof window.saveEstimateNow === 'function') await window.saveEstimateNow(); } catch (e) {}
    var t = (window.computeEstimateTotals ? window.computeEstimateTotals(est) : {}) || {};
    var contractAmount = (typeof t.proposalTotal === 'number') ? t.proposalTotal : undefined;
    var estimatedCosts = (typeof t.baseCost === 'number') ? t.baseCost : undefined;
    var workbook = null;
    try {
      if (typeof window.p86InheritWorkbookFromEstimate === 'function') {
        var inh = await window.p86InheritWorkbookFromEstimate(est);
        if (inh && inh.workbook) workbook = inh.workbook;
      }
    } catch (e) {}
    try {
      await window.p86Api.jobs.linkEstimate(est.job_id, { estimate_id: est.id, contractAmount: contractAmount, estimatedCosts: estimatedCosts, workbook: workbook });
      // CRITICAL: mirror the new values onto the LOCAL job. The server route
      // persists them, but if appData.jobs stays stale (a) Job Details / WIP /
      // Jobs List keep showing old numbers, and (b) the next saveData() re-uploads
      // the stale local job and CLOBBERS the server's fresh values — the "✓ Saved
      // but nothing updated, even after reload" bug (RV2007).
      var job = (window.appData && appData.jobs || []).find(function (j) { return j.id === est.job_id; });
      if (job) {
        if (contractAmount != null) job.contractAmount = contractAmount;
        if (estimatedCosts != null) job.estimatedCosts = estimatedCosts;
        if (workbook) job.workbook = workbook;
        job.estimate_id = est.id;
        if (typeof window.saveData === 'function') { try { window.saveData(); } catch (e) {} }
      }
      // Refresh any open job surfaces so the fresh contract/cost show without a reload.
      if (typeof window.renderJobsList === 'function') { try { window.renderJobsList(); } catch (e) {} }
      if (typeof window.p86JobsHubRefresh === 'function') { try { window.p86JobsHubRefresh(); } catch (e) {} }
      if (typeof window.p86RerenderJobCards === 'function') { try { window.p86RerenderJobCards(); } catch (e) {} }
      function money(n) { return Number(n || 0).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
      if (typeof window.p86Toast === 'function') window.p86Toast('Synced to job — contract $' + money(contractAmount) + ' · est. cost $' + money(estimatedCosts) + '.');
      else alert('Synced to the job.');
    } catch (err) {
      alert('Sync failed: ' + ((err && err.message) || 'unknown error'));
    }
  }
  window.syncEstimateToJob = syncEstimateToJob;

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
    window.p86Confirm({
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
  // Pricing helpers — delegated to window.p86Pricing (js/pricing-pipeline.js)
  // so the math used by the editor, the proposal preview, and the
  // change-order editor all comes from a single module. Local thin
  // wrappers preserve the names the rest of this file already calls.
  // See js/pricing-pipeline.js for the full markup/fee/tax pipeline doc.
  var _P = window.p86Pricing;
  function sectionHeaderFor(line, allLines)     { return _P.sectionHeaderFor(line, allLines); }
  function sectionMarkupForLine(line, allLines, est) { return _P.sectionMarkupForLine(line, allLines, est); }
  function effectiveMarkupForLine(line, allLines, est) { return _P.effectiveMarkupForLine(line, allLines, est); }
  function targetMarginActive(est)              { return _P.targetMarginActive(est); }
  function applyTargetMargin(subtotal, est)     { return _P.applyTargetMargin(subtotal, est); }

  // Marked-up subtotal for a single alternate (group). The estimate
  // model still owns the alternate concept — COs are flat — so we
  // build the per-alternate line slice here, then hand it off to the
  // shared computeForLines helper.
  function markedUpForGroup(est, alt) {
    if (!est || !alt) return { subtotal: 0, markedUp: 0 };
    var lines = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === alt.id;
    });
    return _P.computeForLines(est, lines);
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
    var targetMode = targetMarginActive(est);
    (est.alternates || []).forEach(function(alt) {
      var per = markedUpForGroup(est, alt);
      // While target-margin is locked, every included group's markedUp
      // gets rebuilt off subtotal so the per-group breakdown sums to
      // the override total. Excluded groups keep their natural markup.
      if (targetMode && !alt.excludeFromTotal) {
        per = { subtotal: per.subtotal, markedUp: applyTargetMargin(per.subtotal, est) };
      }
      if (alt.excludeFromTotal) {
        excludedGroups.push({ alt: alt, subtotal: per.subtotal, markedUp: per.markedUp });
      } else {
        includedGroups.push({ alt: alt, subtotal: per.subtotal, markedUp: per.markedUp });
        subtotal += per.subtotal;
        markedUp += per.markedUp;
      }
    });
    // Fees + tax + round → shared p86Pricing.applyFeesAndTax
    var fees = _P.applyFeesAndTax(markedUp, est);
    var lineCount = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.section !== '__section_header__';
    }).length;
    var activeAlt = getActiveAlternate();
    var activePer = activeAlt ? markedUpForGroup(est, activeAlt) : { subtotal: 0, markedUp: 0 };
    if (targetMode && activeAlt && !activeAlt.excludeFromTotal) {
      activePer = { subtotal: activePer.subtotal, markedUp: applyTargetMargin(activePer.subtotal, est) };
    }
    return {
      subtotal: subtotal,
      markupAmount: markedUp - subtotal,
      markedUp: markedUp,
      feeFlat: fees.feeFlat,
      feePctAmount: fees.feePctAmount,
      preTax: fees.preTax,
      taxAmount: fees.taxAmount,
      beforeRound: fees.beforeRound,
      rounded: fees.rounded,
      total: fees.total,
      lineCount: lineCount,
      includedGroups: includedGroups,
      excludedGroups: excludedGroups,
      activeGroupSubtotal: activePer.markedUp,
      activeGroupExcluded: !!(activeAlt && activeAlt.excludeFromTotal),
      targetMarginLocked: targetMode,
      targetMargin: num(est.targetMargin)
    };
  }

  function renderTotals() {
    var t = computeTotals();
    var totalsEl = document.getElementById('ee-totals');
    if (!totalsEl) return;
    // Shared chip classes (.p86-totals-chip) — same look the CO editor
    // uses. `modifier` is one of '' | 'accent' | 'warn' | 'info' |
    // 'dim' and controls the value color. The label is always uppercase
    // muted; the value is bold and color-shifted by modifier.
    function chip(label, value, modifier) {
      var cls = 'p86-totals-chip' + (modifier ? ' ' + modifier : '');
      return '<div class="' + cls + '">' +
        '<div class="p86-totals-chip-label">' + label + '</div>' +
        '<div class="p86-totals-chip-value">' + value + '</div>' +
      '</div>';
    }
    var groupCountChip = (t.includedGroups && t.includedGroups.length > 1)
      ? chip('Active Group', fmtCurrency(t.activeGroupSubtotal) + (t.activeGroupExcluded ? ' (excluded)' : ''), t.activeGroupExcluded ? 'dim' : 'info')
      : '';
    // Gross margin % — markup as a share of the proposal total, the
    // figure most estimators care about. Falls back to '—' when there's
    // no revenue yet so we don't divide by zero.
    var marginPct = (t.markedUp > 0)
      ? (((t.markedUp - t.subtotal) / t.markedUp) * 100)
      : null;
    // The Margin chip is interactive: lock icon toggles between
    // "computed from line markups" (open lock, read-only) and "target
    // locked" (closed gold lock, editable input that back-calculates
    // markup to hit the target). When locked, the input is typeable
    // and bound to est.targetMargin via debounced save.
    var marginChipHTML = renderMarginChip(t, marginPct);
    totalsEl.innerHTML =
      groupCountChip +
      chip('Subtotal', fmtCurrency(t.subtotal)) +
      chip('Markup', fmtCurrency(t.markupAmount), 'warn') +
      chip('Tax + Fees', fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount), 'info') +
      chip('Proposal Total', fmtCurrency(t.total), 'accent') +
      marginChipHTML +
      chip('Lines', t.lineCount, 'dim');
    wireMarginChip();
    // Also refresh the detailed breakdown card under the line items.
    renderPricingBreakdown();
    // Keep the mobile docked grand-total bar in sync (no-op on desktop).
    updateMobileTotalBar();
  }

  // The Margin chip — uses the global edit-gate pencil pattern (same
  // affordance as project/lead/job fieldsets). Two visual states
  // driven by whether a target margin is set:
  //
  //   No target set (default): chip is GREEN, shows computed margin
  //     from line markups. Input is read-only until pencil tap.
  //   Target set:              chip is GOLD, shows the user's target
  //     %. Input is read-only until pencil tap. Total back-computed.
  //
  // Pencil acts as a UX guard only — taps unlock the input for typing,
  // taps again re-lock it. Clearing the input (or typing 0) drops back
  // to the computed-margin state. So users "play with the %" until
  // they're happy, then the pencil lock makes it stick.
  function renderMarginChip(t, computedMarginPct) {
    var hasTarget = !!t.targetMarginLocked; // == targetMargin > 0 from computeTotals
    var displayPct = hasTarget
      ? Number(t.targetMargin || 0).toFixed(1)
      : (computedMarginPct == null ? '' : computedMarginPct.toFixed(1));
    var accent = hasTarget ? '#fbbf24' : 'var(--green,#34d399)';
    var ringRGBA = hasTarget ? 'rgba(251,191,36,0.4)' : 'rgba(52,211,153,0.35)';
    var label = hasTarget ? 'Target Margin' : 'Margin';
    var placeholder = (displayPct === '') ? '—' : '';
    var pencilIcon = (typeof window.p86Icon === 'function') ? window.p86Icon('edit') : '&#x270E;';
    // Wraps the shared .p86-totals-chip chassis so the margin chip lines
    // up with the others, then overrides the value row with an inline
    // editable input + % suffix (the pencil unlocks it).
    return '<div id="ee-margin-chip" class="p86-totals-chip" data-edit-gate="locked" data-has-target="' + (hasTarget ? '1' : '0') + '">' +
      '<div class="p86-totals-chip-label" style="display:flex;align-items:center;justify-content:space-between;gap:6px;margin-bottom:4px;">' +
        '<span>' + label + '</span>' +
        '<button type="button" id="ee-margin-pencil" class="edit-gate-toggle" ' +
          'aria-pressed="false" title="Edit target margin" ' +
          'style="background:transparent;border:0;cursor:pointer;padding:0;line-height:1;display:inline-flex;align-items:center;color:var(--text-dim,#b4b4bf);">' +
          pencilIcon +
        '</button>' +
      '</div>' +
      '<div class="p86-totals-chip-value" style="display:flex;align-items:baseline;gap:2px;color:' + accent + ';">' +
        // displayPct is always a numeric string (or empty) — no need to
        // escape; it can never contain HTML special chars. The input
        // starts readonly; the pencil toggles it on demand.
        '<input id="ee-margin-input" type="text" inputmode="decimal" value="' + displayPct + '" placeholder="' + placeholder + '" readonly' +
          ' style="width:54px;background:transparent;border:1px solid transparent;color:inherit;font-size:14px;font-weight:700;border-radius:4px;padding:0 4px;outline:none;text-align:right;font-family:inherit;" />' +
        '<span>%</span>' +
      '</div>' +
      // Inline scoped style for the unlocked state — gives the input a
      // soft outline ring + matching caret so it visually signals "this
      // is editable now."
      '<style>' +
        '#ee-margin-chip[data-edit-gate="unlocked"] #ee-margin-input { ' +
          'background:var(--overlay-light, rgba(255,255,255,0.03)); ' +
          'border-color:' + ringRGBA + '; ' +
          'caret-color:' + accent + '; ' +
        '}' +
        '#ee-margin-chip[data-edit-gate="unlocked"] #ee-margin-pencil { color:' + accent + '; }' +
      '</style>' +
    '</div>';
  }

  function wireMarginChip() {
    var chip = document.getElementById('ee-margin-chip');
    var pencil = document.getElementById('ee-margin-pencil');
    var input = document.getElementById('ee-margin-input');
    if (!chip || !pencil || !input) return;

    function setUnlocked(unlocked) {
      chip.setAttribute('data-edit-gate', unlocked ? 'unlocked' : 'locked');
      pencil.setAttribute('aria-pressed', unlocked ? 'true' : 'false');
      pencil.title = unlocked ? 'Lock target margin' : 'Edit target margin';
      input.readOnly = !unlocked;
      if (unlocked) {
        // Focus + select-all on the next tick so the user can start
        // typing immediately. Mobile keyboards open on focus.
        setTimeout(function() {
          try { input.focus(); input.select(); } catch (e) {}
        }, 0);
      }
    }

    pencil.onclick = function(e) {
      e.preventDefault();
      e.stopPropagation();
      var isLocked = chip.getAttribute('data-edit-gate') !== 'unlocked';
      if (isLocked) {
        // Unlocking — just flip the state, no re-render needed (it
        // would destroy the focus we're about to grab).
        setUnlocked(true);
      } else {
        // Locking — re-render the chip so the green/gold accent
        // reflects whether the user actually entered a target.
        renderTotals();
      }
    };

    // Input handler — fires while typing (only meaningful when
    // unlocked since readOnly is set otherwise). Updates est.targetMargin
    // and live-updates the proposal total without re-rendering the
    // chip (which would steal focus from the input mid-type).
    input.oninput = function() {
      var est = getEstimate();
      if (!est) return;
      var raw = input.value.trim();
      var v = parseFloat(raw);
      if (!isFinite(v) || raw === '') v = 0;
      if (v < 0) v = 0;
      if (v > 99) v = 99;
      est.targetMargin = v;
      // Keep legacy flag in sync so older code paths that still read
      // it don't drift; targetMarginActive() ignores it now.
      est.targetMarginLocked = v > 0;
      renderTotalsExceptMargin();
      debouncedSave();
    };

    // No auto-lock on blur. The pencil is the SOLE lock/unlock
    // toggle (matches the rest of the edit-gate pattern). Blurring
    // the input — including by clicking the pencil to lock — would
    // otherwise re-render the chip mid-click and leave the user's
    // tap landing on a destroyed element. Re-render to refresh the
    // green/gold accent happens on pencil click, not on blur.
  }

  // Partial refresh that updates every chip EXCEPT the margin input
  // (so the input doesn't lose focus while the user is typing). Used
  // by the margin-input handler to live-update the proposal total.
  function renderTotalsExceptMargin() {
    var totalsEl = document.getElementById('ee-totals');
    if (!totalsEl) return;
    var t = computeTotals();
    // Update each non-margin chip by querying the DOM. The Margin chip
    // is rebuilt on lock toggle / blur; mid-input we only update what
    // the user can see CHANGE because of their typing.
    var chips = totalsEl.children;
    // Order matters; matches renderTotals layout: [groupCount?] subtotal,
    // markup, tax+fees, total, margin, lines.
    var i = 0;
    var hasGroupCount = (t.includedGroups && t.includedGroups.length > 1);
    if (hasGroupCount) i++;
    // i=subtotal, i+1=markup, i+2=tax+fees, i+3=total, i+4=margin, i+5=lines
    function setChipValue(idx, value, cls) {
      var c = chips[idx];
      if (!c) return;
      var v = c.children[1] || c.querySelector('div:nth-child(2)');
      if (v) v.textContent = value;
      if (cls) v.className = cls;
    }
    setChipValue(i + 1, fmtCurrency(t.markupAmount));
    setChipValue(i + 2, fmtCurrency(t.feeFlat + t.feePctAmount + t.taxAmount));
    setChipValue(i + 3, fmtCurrency(t.total));
    // Skip i+4 (margin chip — user is typing in its input).
    renderPricingBreakdown();
    updateMobileTotalBar();
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
    // When target-margin is locked, the Markup row is BACK-CALCULATED
    // to hit the target — not summed from line markups. Surface that
    // so the user sees why the markup number is what it is.
    if (t.targetMarginLocked) {
      var pct = Number(t.targetMargin || 0).toFixed(1);
      html += '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:11px;color:#fbbf24;">' +
        '<span>&#x1F512; Target margin locked &middot; <strong>' + pct + '%</strong></span>' +
        '<span style="font-family:\'SF Mono\',monospace;">markup back-computed</span>' +
      '</div>';
    }
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

  // ── A1: assembly rollup lines — breakdown strip + actions ─────────
  // A line inserted from an assembly carries sourceAssemblyId + an
  // assemblyBreakdown snapshot (the recipe's flat leaf rows per 1 output
  // unit). The strip below the row toggles a read-only component view;
  // the parent line is the only thing the totals engine sees.
  var _asmOpen = {}; // lineId → bool, survives re-renders within a session

  var ASM_CODE_SECTION = {
    materials: 'Materials & Supplies Costs',
    labor: 'Direct Labor',
    gc: 'General Conditions',
    sub: 'Subcontractors Costs'
  };

  function renderAsmBreakdownStrip(line) {
    var open = !!_asmOpen[line.id];
    var n = line.assemblyBreakdown.length;
    // Footer of the fused .ee-asm-unit card (the wrapper carries the blue
    // edge + tint) — reads as a caption of the line above, not a sibling row.
    var html =
      '<div class="ee-asm-strip" data-edit-gate-passthrough onclick="eeToggleAsmBreakdown(\'' + line.id + '\')" ' +
        'style="display:flex;align-items:center;gap:7px;padding:2px 10px 4px 40px;font-size:10px;cursor:pointer;color:#7eb0ff;border-top:1px dashed rgba(79,140,255,0.25);">' +
        '<span style="display:inline-block;transition:transform .12s;font-size:8px;' + (open ? 'transform:rotate(90deg);' : '') + '">▶</span>' +
        '<span style="font-weight:700;letter-spacing:.04em;">🧩 ASSEMBLY</span>' +
        '<span style="color:var(--text-dim,#8a93a6);">' + n + ' component' + (n === 1 ? '' : 's') + ' inside this price — click to inspect</span>' +
      '</div>';
    if (!open) return html;
    var q = num(line.qty);
    line.assemblyBreakdown.forEach(function (b) {
      var bq = Math.round(q * num(b.qty_per_unit) * 100) / 100;
      var uc = b.unit_cost != null ? num(b.unit_cost) : 0;
      html +=
        '<div data-edit-gate-passthrough style="display:flex;align-items:center;gap:8px;padding:2px 10px 2px 52px;font-size:10.5px;font-style:italic;color:var(--text-dim,#8a93a6);opacity:.85;">' +
          '<span style="color:#4f8cff;flex:0 0 auto;">↳</span>' +
          '<span style="flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(b.description || '(item)') +
            '<span style="font-size:8px;font-style:normal;padding:1px 5px;border-radius:7px;margin-left:6px;background:' + (b.cost_code === 'labor' ? 'rgba(242,165,92,0.13);color:#f2a55c' : 'rgba(79,209,197,0.13);color:#4fd1c5') + ';">' + escapeHTML(b.cost_code || '') + '</span>' +
          '</span>' +
          '<span style="font-family:monospace;font-style:normal;flex:0 0 auto;">' + bq + ' ' + escapeHTML(b.unit || '') + '</span>' +
          '<span style="font-family:monospace;font-style:normal;flex:0 0 84px;text-align:right;">@ $' + uc.toFixed(2) + '</span>' +
          '<span style="font-family:monospace;font-style:normal;flex:0 0 84px;text-align:right;">$' + (bq * uc).toFixed(2) + '</span>' +
        '</div>';
    });
    html +=
      '<div data-edit-gate-passthrough style="display:flex;gap:16px;padding:4px 10px 6px 52px;font-size:10px;">' +
        '<span onclick="eeAsmRefresh(\'' + line.id + '\')" style="color:#4f8cff;cursor:pointer;">⟳ Refresh price from recipe</span>' +
        '<span onclick="eeAsmExplode(\'' + line.id + '\')" style="color:#4f8cff;cursor:pointer;">⇣ Explode to editable lines</span>' +
        '<span onclick="if(window.p86Assemblies)p86Assemblies.openEditor(' + num(line.sourceAssemblyId) + ')" style="color:#4f8cff;cursor:pointer;">✎ Open assembly</span>' +
      '</div>';
    return html;
  }

  window.eeToggleAsmBreakdown = function (lineId) {
    _asmOpen[lineId] = !_asmOpen[lineId];
    renderLineItems();
  };

  // Re-pull the recipe: new resolved unit cost + fresh component snapshot
  // (material rows reprice from the live catalog).
  window.eeAsmRefresh = function (lineId) {
    var line = eeFindLine(lineId);
    if (!line || !line.sourceAssemblyId) return;
    fetch('/api/assemblies/' + encodeURIComponent(line.sourceAssemblyId), { credentials: 'include' })
      .then(function (r) {
        if (!r.ok) throw new Error(r.status === 404 ? 'That assembly no longer exists.' : 'Could not load recipe (' + r.status + ')');
        return r.json();
      })
      .then(function (det) {
        line.unitCost = num(det.assembly && det.assembly.unit_cost);
        line.assemblyBreakdown = Array.isArray(det.flat) ? det.flat : line.assemblyBreakdown;
        debouncedSave();
        renderLineItems();
        renderTotals();
      })
      .catch(function (e) { alert('Refresh failed: ' + (e.message || 'unknown')); });
  };

  // Convert the rollup line into raw editable lines (one per component,
  // routed to the matching cost-code section). One-way — the rollup line
  // is replaced.
  window.eeAsmExplode = function (lineId) {
    var line = eeFindLine(lineId);
    if (!line || !Array.isArray(line.assemblyBreakdown)) return;
    var doIt = function () {
      var q = num(line.qty);
      var specs = line.assemblyBreakdown.map(function (b) {
        return {
          description: b.description,
          qty: Math.round(q * num(b.qty_per_unit) * 100) / 100,
          unit: b.unit || 'EA',
          unit_cost: b.unit_cost != null ? num(b.unit_cost) : 0,
          section_name: ASM_CODE_SECTION[b.cost_code] || 'Materials & Supplies Costs',
          source_material_id: b.material_id || undefined,
          source_assembly_id: line.sourceAssemblyId
        };
      }).filter(function (s) { return s.qty > 0; });
      var idx = appData.estimateLines.indexOf(line);
      if (idx >= 0) appData.estimateLines.splice(idx, 1);
      delete _asmOpen[lineId];
      applyBulkAddLineItems(specs);
    };
    if (window.p86Confirm) window.p86Confirm('Explode "' + (line.description || 'assembly') + '" into ' + line.assemblyBreakdown.length + ' editable lines? The single rollup line is replaced.', doIt);
    else if (confirm('Explode into editable lines?')) doIt();
  };

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

    // Column headers at the top of the table — matches the CO editor's
    // line table look (uppercase muted labels, sticky alignment).
    // .ee-line-tbl is the class that drives the cleaner row styling;
    // the existing inline styles still apply per-row for backwards-
    // compat. The header row sits OUTSIDE the row flex so the drag
    // handle column doesn't get a header label (the rows still align
    // because both use the same flex widths via the helper functions).
    // Header columns must mirror the DATA row's cells one-for-one — same
    // count, same order, same flex widths — or the labels drift and sit
    // over the wrong column (the "Description overlaps Unit Cost" bug).
    // The row is: handle · desc · Qty · Unit · Unit Cost · Markup % · Ext ·
    // Marked-Up · delete. min-width:0 lets a <80px basis win over the
    // .ee-th-num class's min-width:80px.
    var headerHTML =
      '<div class="ee-line-tbl-head">' +
        '<div class="ee-th-handle"></div>' +
        '<div class="ee-th-desc">Description</div>' +
        '<div class="ee-th-num" style="flex:0 0 70px;min-width:0;">Qty</div>' +
        '<div class="ee-th-num" style="flex:0 0 70px;min-width:0;">Unit</div>' +
        '<div class="ee-th-num" style="flex:0 0 110px;min-width:0;">Unit Cost</div>' +
        '<div class="ee-th-num" style="flex:0 0 90px;min-width:0;">Markup %</div>' +
        '<div class="ee-th-num" style="flex:0 0 110px;min-width:0;">Ext.</div>' +
        '<div class="ee-th-num" style="flex:0 0 120px;min-width:0;">Marked-Up</div>' +
        '<div class="ee-th-del" style="flex:0 0 36px;"></div>' +
      '</div>';
    var html = bannerHtml + '<div class="ee-line-tbl-scroll"><div class="ee-line-table ee-line-tbl" style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;">' + headerHTML;

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
        // A1 — assembly rollup lines render FUSED with their breakdown
        // strip inside one bordered card, so the informational component
        // rows can never be mistaken for sibling line items (John deleted
        // real lines thinking they were breakdown rows).
        var isAsmLine = line.sourceAssemblyId && Array.isArray(line.assemblyBreakdown) && line.assemblyBreakdown.length;
        if (isAsmLine) {
          html += '<div class="ee-asm-unit" style="border:1px solid rgba(79,140,255,0.4);border-left:3px solid #4f8cff;border-radius:8px;margin:5px 6px;overflow:hidden;background:rgba(79,140,255,0.05);">' +
            renderLineItemRow(line, lines, est) +
            renderAsmBreakdownStrip(line) +
          '</div>';
        } else {
          html += renderLineItemRow(line, lines, est);
        }
      }
    }
    if (currentSection != null) flushSectionSubtotal(lines.length);

    html += '</div></div>';
    container.innerHTML = html;

    // Auto-size every description textarea to fit its current content.
    // The HTML strings can't compute scrollHeight (no DOM yet), so we
    // do it once after innerHTML is committed.
    container.querySelectorAll('textarea').forEach(function(ta) {
      ta.style.height = 'auto';
      ta.style.height = Math.min(ta.scrollHeight, 180) + 'px';
    });

    // Arm the accidental-edit gate. attachRowContainer is idempotent —
    // it tracks the container via WeakSet and binds at most one
    // delegated click handler regardless of how many times the
    // estimate re-renders. Tap a row to unlock its inputs; tap
    // elsewhere to re-lock everything. Section header rows are not
    // gated (they carry inline action buttons that complicate the
    // tap-to-arm gesture); only line rows carry data-row-edit-gate.
    if (window.p86EditGate) {
      window.p86EditGate.attachRowContainer(container, '[data-row-edit-gate]');
    }
    // Phase 2 mobile: tap a line card → open the edit sheet (instead of
    // the inline edit-gate). Idempotent; no-op on desktop.
    eeArmMobileLineTap(container);
  }

  // ──────────────────────────────────────────────────────────────────
  // Mobile line editing (Phase 2). On a phone the line "cards" are read
  // mostly; tapping one opens a bottom-sheet editor with big keypad
  // fields + live Extension / Client-price math, and a docked grand-total
  // bar keeps the proposal number in view. Both are mobile-only (<=760px);
  // desktop keeps the inline edit-gate table untouched. Mirrors how
  // Buildertrend / CoConstruct / ServiceTitan handle line items on phones.
  // ──────────────────────────────────────────────────────────────────
  function eeLineIsMobile() {
    // Touch-gated: the tap-to-open bottom-sheet line editor is for real
    // phones. A narrow mouse desktop still gets the card LAYOUT (CSS @760,
    // width-only) but keeps inline table editing, not the bottom sheet.
    return !!(window.matchMedia && window.matchMedia('(max-width: 760px) and (pointer: coarse)').matches);
  }
  function eeFindLine(id) {
    var lines = getLines() || [];
    for (var i = 0; i < lines.length; i++) if (String(lines[i].id) === String(id)) return lines[i];
    return null;
  }
  function eeInheritedMarkup(line) {
    // Effective markup when this line's own markup is blank (section value).
    var clone = {}; for (var k in line) clone[k] = line[k]; clone.markup = '';
    return effectiveMarkupForLine(clone, getLines(), getEstimate());
  }
  function eeLineMath(line) {
    var ext = num(line.qty) * num(line.unitCost);
    var m = effectiveMarkupForLine(line, getLines(), getEstimate());
    return { ext: ext, client: ext * (1 + m / 100), markupEff: m };
  }

  // Capture-phase tap handler so a card tap pre-empts the inline edit
  // gate on mobile. Delete / drag (data-edit-gate-passthrough) keep their
  // own behavior; desktop returns early.
  function eeArmMobileLineTap(container) {
    if (!container || container._eeTapArmed) return;
    container._eeTapArmed = true;
    container.addEventListener('click', function (e) {
      if (!eeLineIsMobile()) return;
      if (e.target.closest('[data-edit-gate-passthrough]')) return;
      var row = e.target.closest('[data-row-edit-gate]');
      if (!row) return;
      e.preventDefault();
      e.stopPropagation();
      openEeLineSheet(row.getAttribute('data-line-id'));
    }, true);
  }

  function closeEeLineSheet() {
    var bd = document.getElementById('ee-line-sheet-backdrop');
    if (bd) bd.remove();
    document.body.style.overflow = '';
  }

  function openEeLineSheet(id) {
    var line = eeFindLine(id);
    if (!line) return;
    closeEeLineSheet();
    var lines = getLines() || [];
    var sectionName = '';
    for (var i = 0; i < lines.length; i++) {
      if (lines[i].section === '__section_header__') sectionName = lines[i].description || '';
      if (String(lines[i].id) === String(id)) break;
    }
    var math = eeLineMath(line);
    var bd = document.createElement('div');
    bd.id = 'ee-line-sheet-backdrop';
    bd.className = 'ee-line-sheet-backdrop';
    bd.innerHTML =
      '<div class="ee-line-sheet" role="dialog" aria-label="Edit line item">' +
        '<div class="ee-line-sheet-grip"></div>' +
        '<div class="ee-line-sheet-head">' +
          '<div class="ee-line-sheet-section">' + escapeHTML(sectionName || 'Line item') + '</div>' +
          '<button type="button" class="ee-line-sheet-done" data-x>Done</button>' +
        '</div>' +
        '<label class="ee-sheet-field"><span>Description</span>' +
          '<textarea data-f="description" rows="2">' + escapeHTML(line.description || '') + '</textarea></label>' +
        '<div class="ee-sheet-row3">' +
          '<label class="ee-sheet-field"><span>Qty</span>' +
            '<input data-f="qty" type="text" inputmode="decimal" value="' + escapeHTML(line.qty == null ? '' : String(line.qty)) + '" /></label>' +
          '<label class="ee-sheet-field"><span>Unit</span>' +
            '<input data-f="unit" type="text" value="' + escapeHTML(line.unit || '') + '" /></label>' +
          '<label class="ee-sheet-field"><span>Unit Cost</span>' +
            '<input data-f="unitCost" type="text" inputmode="decimal" value="' + escapeHTML(line.unitCost == null ? '' : String(line.unitCost)) + '" /></label>' +
        '</div>' +
        '<label class="ee-sheet-field"><span>Markup %</span>' +
          '<input data-f="markup" type="text" inputmode="decimal" value="' + escapeHTML(line.markup == null ? '' : String(line.markup)) + '" placeholder="blank = section (' + escapeHTML(String(Math.round(eeInheritedMarkup(line) * 10) / 10)) + '%)" /></label>' +
        '<div class="ee-sheet-readouts">' +
          '<div><span>Extension</span><strong data-ro="ext">' + fmtCurrency(math.ext) + '</strong></div>' +
          '<div class="accent"><span>Client price</span><strong data-ro="client">' + fmtCurrency(math.client) + '</strong></div>' +
        '</div>' +
        '<div class="ee-sheet-actions">' +
          '<button type="button" class="ee-sheet-del" data-del>\u{1F5D1} Delete line</button>' +
          '<button type="button" class="ee-sheet-save primary" data-x>Done</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(bd);
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(function () { bd.classList.add('show'); });

    var sheet = bd.querySelector('.ee-line-sheet');
    function recompute() {
      var q = num(sheet.querySelector('[data-f="qty"]').value);
      var uc = num(sheet.querySelector('[data-f="unitCost"]').value);
      var mkRaw = sheet.querySelector('[data-f="markup"]').value;
      var ext = q * uc;
      var mk = (mkRaw === '' || mkRaw == null) ? eeInheritedMarkup(eeFindLine(id) || line) : num(mkRaw);
      sheet.querySelector('[data-ro="ext"]').textContent = fmtCurrency(ext);
      sheet.querySelector('[data-ro="client"]').textContent = fmtCurrency(ext * (1 + mk / 100));
    }
    sheet.querySelectorAll('input,textarea').forEach(function (el) {
      var f = el.getAttribute('data-f');
      el.addEventListener('input', recompute);
      el.addEventListener('change', function () { updateLineField(id, f, el.value); });
    });
    bd.querySelectorAll('[data-x]').forEach(function (b) { b.addEventListener('click', closeEeLineSheet); });
    bd.addEventListener('click', function (e) { if (e.target === bd) closeEeLineSheet(); });
    var del = bd.querySelector('[data-del]');
    if (del) del.addEventListener('click', function () { closeEeLineSheet(); deleteLineFromEditor(id); });
  }
  window.openEeLineSheet = openEeLineSheet;

  // Docked grand-total bar (mobile + Line Items tab). Mounted once on
  // <body>, positioned just above the mobile bottom-nav (measured at
  // runtime — the nav height isn't a CSS var). Refreshed by renderTotals.
  function eeEnsureTotalBar() {
    var bar = document.getElementById('ee-mobile-totalbar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ee-mobile-totalbar';
      bar.className = 'ee-mobile-totalbar';
      bar.innerHTML =
        '<div class="ee-mtb-left"><span class="ee-mtb-sub" data-sub></span></div>' +
        '<div class="ee-mtb-right"><span class="ee-mtb-label">Proposal total</span>' +
          '<span class="ee-mtb-total" data-total></span></div>';
      document.body.appendChild(bar);
    }
    var nav = document.querySelector('.p86-mobile-nav');
    var navH = (nav && nav.offsetParent !== null) ? nav.offsetHeight : 0;
    bar.style.bottom = navH + 'px';
    return bar;
  }
  function updateMobileTotalBar() {
    var bar = eeEnsureTotalBar();
    var linesTab = document.getElementById('ee-tab-lines');
    var onLines = !!(linesTab && linesTab.offsetParent !== null);
    if (!(eeLineIsMobile() && onLines)) { bar.classList.remove('show'); return; }
    var t = computeTotals();
    bar.querySelector('[data-total]').textContent = fmtCurrency(t.total);
    bar.querySelector('[data-sub]').textContent = 'Cost ' + fmtCurrency(t.subtotal) + ' · Markup ' + fmtCurrency(t.markupAmount);
    bar.classList.add('show');
  }

  // (Column header row removed — the per-line inputs are self-labeled
  // and the row was visual noise + a sticky-pinning headache.)

  // Drag handle markup shared by section headers + line rows. The HTML5
  // drag-and-drop dance: dragstart records the dragged id, dragover preserves
  // the drop target highlight, drop reorders the array.
  // data-edit-gate-passthrough keeps the handle clickable even when the
  // surrounding row is locked by the edit gate — reordering shouldn't
  // require unlocking a row first.
  function dragHandleHTML(id) {
    return '<div ' +
      'draggable="true" ' +
      'data-edit-gate-passthrough ' +
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
    // Section header row — yellow/amber accent (matches the CO editor's
    // section row) so subgroups stand out clearly from line items. Soft
    // amber tint background instead of the old blue so it doesn't fight
    // with the per-line blue focus rings.
    return '<div data-section-id="' + idAttr + '" data-line-id="' + idAttr + '" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:center;flex-wrap:wrap;background:rgba(251,191,36,0.05);border-top:1px solid rgba(251,191,36,0.15);border-bottom:1px solid rgba(251,191,36,0.15);padding:6px 10px;gap:8px;">' +
      dragHandleHTML(line.id) +
      '<input type="text" value="' + escapeHTML(line.description || '') + '" placeholder="Section name" ' +
        'oninput="updateSectionName(\'' + idAttr + '\', this.value)" ' +
        'style="flex:1;min-width:140px;font-size:13px;font-weight:700;background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 8px;color:#fbbf24;text-transform:uppercase;letter-spacing:0.5px;" ' +
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
        '<input type="text" inputmode="decimal" placeholder="0" value="' + markupVal + '" ' +
          // type="text" inputmode="decimal" instead of type="number":
          // the native number input has UX problems (wheel-scroll
          // silently changes the value, mobile Safari cursor jump on
          // reformat, step validation rejects partial decimals).
          // inputmode="decimal" still gives mobile users the numeric
          // keypad. JS parsing in updateSectionMarkup handles the
          // string-shaped value.
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
      // Numeric fields render as type="text" with inputmode="decimal"
      // instead of type="number". The native number input has
      // documented UX problems: wheel-scroll silently changes the
      // value mid-edit, mobile Safari jumps the cursor when reformatting,
      // step validation rejects partial decimals like "12.", and
      // some browsers strip leading zeros. type="text" + inputmode
      // gives the mobile numeric keypad without any of those quirks;
      // updateLineField (which fires onchange) parses via num() so the
      // string-shaped value is converted correctly.
      var typeAttr;
      if (opts.type === 'number') {
        typeAttr = 'type="text" inputmode="decimal"';
      } else {
        typeAttr = opts.type ? 'type="' + opts.type + '"' : 'type="text"';
      }
      return '<div data-cell="' + field + '" data-label="' + escapeHTML(opts.label || field) + '" ' +
          'style="flex:' + (opts.flex || '1') + ';padding:4px 6px;">' +
        '<input ' + typeAttr + inputAttrs + ' />' +
      '</div>';
    };

    // Description gets its own textarea variant so the cell auto-grows
    // when the user types a long description — single-line inputs were
    // truncating mid-text. Auto-grow on input via JS-set inline height.
    var descTextarea = function() {
      var v = line.description == null ? '' : String(line.description);
      return '<div data-cell="description" style="flex:2 1 200px;padding:4px 6px;">' +
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
    // data-row-edit-gate + data-editing="false" arms the row for the
    // accidental-edit gate: inputs render flat / non-interactive until
    // the user taps the row, which sets data-editing="true" and
    // restores the input chrome. Delete + drag handle stay clickable
    // via data-edit-gate-passthrough.
    return '<div data-line-id="' + idAttr + '" ' +
        'data-row-edit-gate data-editing="false" ' +
        'ondragover="onLineDragOver(event)" ondragleave="onLineDragLeave(event)" ' +
        'ondrop="onLineDrop(event, \'' + idAttr + '\')" ' +
        'style="display:flex;align-items:flex-start;border-bottom:1px solid var(--border,#333);">' +
      dragHandleHTML(line.id) +
      descTextarea() +
      input('qty', line.qty, { flex: '0 0 70px', type: 'number', align: 'right', mono: true, label: 'Qty' }) +
      input('unit', line.unit, { flex: '0 0 70px', label: 'Unit' }) +
      input('unitCost', line.unitCost, { flex: '0 0 110px', type: 'number', align: 'right', mono: true, label: 'Unit Cost' }) +
      input('markup', line.markup, { flex: '0 0 90px', type: 'number', align: 'right', mono: true, placeholder: markupPlaceholder, label: 'Markup %' }) +
      readOnly(fmtCurrency(ext), '0 0 110px', null, 'ee-line-ext') +
      readOnly(fmtCurrency(clientPrice), '0 0 120px', null, 'ee-line-amount') +
      '<div data-cell="delete" data-edit-gate-passthrough style="flex:0 0 36px;text-align:center;padding-top:8px;">' +
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
    // Native prompt() silently no-ops inside the installed PWA (it froze the
    // "+ Section › Custom" flow). Route through the in-app p86Prompt modal.
    var ask = (typeof window.p86Prompt === 'function')
      ? window.p86Prompt({ title: 'New section', message: 'Name this section (subgroup).', placeholder: 'e.g. Sitework', defaultValue: '' })
      : Promise.resolve(prompt('Subgroup name:', ''));
    ask.then(function(name) {
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
    });
  }

  function deleteLineFromEditor(lineId) {
    var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
    var preview = line && line.description ? line.description : 'this line';
    window.p86Confirm({
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
    window.p86Confirm({
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

  // Insert a single standard subgroup by btCategory id. Used by the new
  // "+ Section" dropdown — picks one from the preset list instead of
  // adding all four at once. Returns true if added, false if a section
  // with that btCategory already exists in the active alternate.
  function addStandardSectionByCategory(btCategory) {
    var est = getEstimate();
    if (!est) return false;
    var preset = STANDARD_SECTIONS_PRESET.find(function(p) { return p.btCategory === btCategory; });
    if (!preset) return false;
    var altId = est.activeAlternateId;
    var dupe = (appData.estimateLines || []).find(function(l) {
      return l.estimateId === est.id && l.alternateId === altId &&
             l.section === '__section_header__' && l.btCategory === btCategory;
    });
    if (dupe) {
      alert('"' + preset.name + '" is already in this group.');
      return false;
    }
    appData.estimateLines.push({
      id: 's' + Date.now(),
      estimateId: est.id,
      alternateId: altId,
      section: '__section_header__',
      description: preset.name,
      btCategory: preset.btCategory,
      markup: preset.markup
    });
    debouncedSave();
    renderLineItems();
    renderTotals();
    return true;
  }
  window.addStandardSectionByCategory = addStandardSectionByCategory;

  // Toggle the "+ Section" dropdown menu. Built lazily on first open so
  // the preset list reflects current STANDARD_SECTIONS_PRESET state and
  // existing-section dedup is computed against the active alternate.
  function toggleAddSectionMenu() {
    var menu = document.getElementById('ee-add-section-menu');
    if (!menu) return;
    if (!menu.hasAttribute('hidden')) {
      menu.setAttribute('hidden', '');
      return;
    }
    var est = getEstimate();
    var altId = est && est.activeAlternateId;
    var existingCats = {};
    (appData.estimateLines || []).forEach(function(l) {
      if (l.estimateId === est.id && l.alternateId === altId &&
          l.section === '__section_header__' && l.btCategory) {
        existingCats[l.btCategory] = true;
      }
    });
    var items = STANDARD_SECTIONS_PRESET.map(function(p) {
      var disabled = !!existingCats[p.btCategory];
      var note = disabled ? '<small>already in this group</small>' : '';
      return '<button type="button" data-bt="' + p.btCategory + '"' + (disabled ? ' disabled' : '') + '>' +
        '<strong>' + p.name + '</strong>' + note +
      '</button>';
    }).join('');
    menu.innerHTML = items +
      '<div class="ee-add-section-menu-divider"></div>' +
      '<button type="button" data-bt="__custom__"><strong>Custom section…</strong><small>name it yourself</small></button>';
    menu.removeAttribute('hidden');

    function close() {
      menu.setAttribute('hidden', '');
      document.removeEventListener('click', onOutside, true);
    }
    function onOutside(e) {
      var btn = document.getElementById('ee-add-section-btn');
      if (!menu.contains(e.target) && !(btn && btn.contains(e.target))) close();
    }
    // Defer so the current click that opened the menu doesn't immediately close it.
    setTimeout(function() { document.addEventListener('click', onOutside, true); }, 0);

    menu.querySelectorAll('[data-bt]').forEach(function(btn) {
      btn.addEventListener('click', function(e) {
        e.stopPropagation();
        var cat = btn.getAttribute('data-bt');
        close();
        if (cat === '__custom__') {
          // Reuse the existing custom-section flow (prompts for name).
          addEstimateSectionFromEditor();
        } else {
          addStandardSectionByCategory(cat);
        }
      });
    });
  }
  window.toggleAddSectionMenu = toggleAddSectionMenu;

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
        input = '<textarea id="' + id + '" rows="' + (opts.rows || 4) + '" style="width:100%;padding:8px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#141419);color:var(--text,#fff);resize:vertical;">' + escapeHTML(value || '') + '</textarea>';
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
          // Title at the top of the Details form — same value the
          // sticky header carries (#ee-title), kept in sync below.
          field('Title', 'ee-titleDetails', est.title, { placeholder: 'e.g. Windermere Park Equipment — Replace Benches' }) +
          '<div style="margin-bottom:12px;">' +
            '<label style="display:block;">Pick from Client Directory</label>' +
            '<select id="ee-clientPicker" onchange="onEstimateClientPicked(\'edit\')" style="width:100%;"></select>' +
          '</div>' +
          '<input type="hidden" id="editEst_clientId" value="' + escapeHTML(est.client_id || '') + '" />' +
          '<input type="hidden" id="editEst_leadId" value="' + escapeHTML(est.lead_id || '') + '" />' +
          field('Client Short Name', 'ee-nickName', est.nickName, { placeholder: 'e.g. PAC, Sterling, Greystar — auto-filled from client directory' }) +
          field('Job Type', 'ee-jobType', est.jobType, { options: ['Renovation', 'Service & Repair', 'Work Order'] }) +
          field('Client Company Name', 'ee-client', est.client) +
          field('Community / Property Name', 'ee-community', est.community) +
          // Structured address — property maps to the canonical filterable
          // fields (street_address/city/state/zip, same as leads/jobs so
          // convert inherits + lists filter). Billing keeps its own set.
          (window.p86Address
            ? '<div style="margin-bottom:12px;"><label style="display:block;">Property Address</label>' + window.p86Address.fieldsHtml(est, { id: 'ee-propAddr' }) + '</div>'
            : field('Property Address', 'ee-propertyAddr', est.propertyAddr)) +
          (window.p86Address
            ? '<div style="margin-bottom:12px;"><label style="display:block;">Client Billing Address</label>' + window.p86Address.fieldsHtml({ street_address: est.billing_street_address, city: est.billing_city, state: est.billing_state, zip: est.billing_zip, address: est.billingAddr }, { id: 'ee-billAddr' }) + '</div>'
            : field('Client Billing Address', 'ee-billingAddr', est.billingAddr)) +
        '</div>' +
        '<div>' +
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

    // Title — keystroke-live so it matches the sticky header input
    // behavior, and bidirectionally synced with #ee-title so editing
    // either field keeps the other current.
    var titleDetailsEl = document.getElementById('ee-titleDetails');
    if (titleDetailsEl) {
      titleDetailsEl.oninput = function() {
        var e = getEstimate(); if (!e) return;
        e.title = titleDetailsEl.value;
        var hdrTitle = document.getElementById('ee-title');
        if (hdrTitle && hdrTitle.value !== titleDetailsEl.value) {
          hdrTitle.value = titleDetailsEl.value;
        }
        debouncedSave();
      };
    }
    // Mirror the sticky-header title input into the details field when
    // the user types up there — keeps both views consistent. Append
    // rather than replace any prior handler set by openEditor().
    var hdrTitleEl = document.getElementById('ee-title');
    if (hdrTitleEl) {
      var prevHandler = hdrTitleEl.oninput;
      hdrTitleEl.oninput = function() {
        if (typeof prevHandler === 'function') prevHandler.apply(this, arguments);
        var detailsEl = document.getElementById('ee-titleDetails');
        if (detailsEl && detailsEl.value !== hdrTitleEl.value) {
          detailsEl.value = hdrTitleEl.value;
        }
      };
    }

    // Wire each field's onchange to live-update the estimate record.
    var fieldMap = {
      'ee-nickName': 'nickName',
      'ee-jobType': 'jobType',
      'ee-client': 'client',
      'ee-community': 'community',
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
    // Structured address wiring — collect the 4 sub-inputs on change and
    // persist to both the canonical filterable fields (street_address/city/
    // state/zip) and the formatted string the preview reads. Autocomplete
    // fills all four (+ lat/lng onto the estimate for the property address).
    if (window.p86Address) {
      var _propRoot = document.getElementById('ee-propAddr');
      var _billRoot = document.getElementById('ee-billAddr');
      var _saveProp = function() {
        var e = getEstimate(); if (!e) return;
        var c = window.p86Address.collect(_propRoot); if (!c) return;
        e.street_address = c.street; e.city = c.city; e.state = c.state; e.zip = c.zip;
        e.address = c.formatted; e.propertyAddr = c.formatted;
        debouncedSave();
      };
      var _saveBill = function() {
        var e = getEstimate(); if (!e) return;
        var c = window.p86Address.collect(_billRoot); if (!c) return;
        e.billing_street_address = c.street; e.billing_city = c.city; e.billing_state = c.state; e.billing_zip = c.zip;
        e.billingAddr = c.formatted;
        debouncedSave();
      };
      if (_propRoot) {
        _propRoot.querySelectorAll('[data-addr]').forEach(function(inp) { inp.addEventListener('change', _saveProp); });
        window.p86Address.wire(_propRoot, est, _saveProp);
      }
      if (_billRoot) {
        _billRoot.querySelectorAll('[data-addr]').forEach(function(inp) { inp.addEventListener('change', _saveBill); });
        window.p86Address.wire(_billRoot, null, _saveBill);
      }
    }

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
    // Retroactive auto-fill — if this estimate has a client_id set but
    // the derived fields (company / community / addresses / manager)
    // are empty, run the client snapshot now. Covers two cases:
    //   1. Estimates created by 86 via emit_payload_file BEFORE the
    //      server-side snapshot landed — they have client_id but no
    //      filled fields.
    //   2. Any estimate where the user wants to re-pull current
    //      client data (rare; manual edits override).
    // Only fires when ALL client-derived fields are empty so we don't
    // clobber user edits.
    if (est.client_id && !est.client && !est.community && !est.propertyAddr &&
        !est.managerName && !est.managerEmail && !est.managerPhone) {
      // Defer so populateEstimateClientPicker has time to set
      // sel.value before we trigger the change. setTimeout 0 +
      // dispatchEvent('change') is enough.
      setTimeout(function() {
        var sel = document.getElementById('ee-clientPicker');
        if (sel && sel.value === est.client_id &&
            typeof window.onEstimateClientPicked === 'function') {
          window.onEstimateClientPicked('edit');
        }
      }, 0);
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
      var clients = (window.p86Clients && window.p86Clients.getCached && window.p86Clients.getCached()) || [];
      var c = clients.find(function(x) { return x.id === sel.value; });
      if (!c) return;
      var setIf = function(elId, v) {
        var el = document.getElementById(elId);
        if (el && v != null && v !== '') {
          el.value = v;
          el.dispatchEvent(new Event('change'));
        }
      };
      setIf('ee-nickName', c.short_name || '');
      setIf('ee-client', c.company_name || c.name || '');
      setIf('ee-community', c.community_name || c.name || '');
      // Fill the structured address sub-inputs (property = the canonical
      // filterable set); dispatch change so the collect-on-change persists.
      // Fall back to the legacy single fields if the structured block isn't
      // rendered (p86Address unavailable).
      var _fillAddr = function(rootId, street) {
        var root = document.getElementById(rootId); if (!root) return false;
        var parts = { street: street || '', city: c.city || '', state: c.state || '', zip: c.zip || '' };
        Object.keys(parts).forEach(function(k) {
          var el = root.querySelector('[data-addr="' + k + '"]');
          if (el && parts[k]) { el.value = parts[k]; el.dispatchEvent(new Event('change', { bubbles: true })); }
        });
        return true;
      };
      if (!_fillAddr('ee-propAddr', c.property_address || c.address)) {
        setIf('ee-propertyAddr', [c.property_address || c.address, c.city, c.state, c.zip].filter(Boolean).join(', '));
      }
      if (!_fillAddr('ee-billAddr', c.address)) {
        setIf('ee-billingAddr', [c.address, c.city, c.state, c.zip].filter(Boolean).join(', '));
      }
      setIf('ee-managerName', c.community_manager || '');
      setIf('ee-managerEmail', c.cm_email || c.email || '');
      setIf('ee-managerPhone', c.cm_phone || c.phone || c.cell || '');
      // Proposal Salutation field was retired 2026-05-24 — no longer
      // shown in the form and no auto-snapshot. Existing data on the
      // estimate row is left untouched; estimate-preview.js still
      // tolerates it being undefined.
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
  // state. Just delegates to p86AI.open with the current id.
  // Manual save invoked by the sticky-header Save button + the save
  // indicator (clicking the chip also triggers an immediate save).
  window.saveEstimateNow = function() {
    if (!_currentId) return;
    if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
    runSaveNow();
  };

  window.openEstimateAI = function() {
    if (!_currentId) { alert('Open an estimate first.'); return; }
    if (window.p86AI && typeof window.p86AI.open === 'function') {
      window.p86AI.open(_currentId);
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
    // Materials Catalog Drawer (Phase 2) — when the line came from a
    // catalog row, stamp the source material id so favorites /
    // recently-used / "already on estimate" can correlate later
    // without falling back to fuzzy description matching.
    if (input.source_material_id != null) {
      newLine.sourceMaterialId = input.source_material_id;
    }
    // Assemblies — lines exploded from a costed recipe carry the recipe
    // id so estimated-vs-actual can roll up per assembly later.
    if (input.source_assembly_id != null) {
      newLine.sourceAssemblyId = input.source_assembly_id;
    }
    // A1 rollup lines additionally carry the component snapshot (flat
    // leaf rows per 1 output unit) for the read-only breakdown strip.
    if (Array.isArray(input.assembly_breakdown) && input.assembly_breakdown.length) {
      newLine.assemblyBreakdown = input.assembly_breakdown;
    }

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

    // _silent skips the save + re-render so a bulk caller can fire
    // N line inserts in a tight loop and finalize once at the end.
    // The Materials Catalog Drawer's bulk-add path passes this flag
    // and calls debouncedSave + renderLineItems once after the loop.
    if (!input || !input._silent) {
      debouncedSave();
      renderLineItems();
      renderTotals();
    }
    return 'Added line: "' + newLine.description + '" — qty ' + newLine.qty + ' ' + newLine.unit + ' @ $' + newLine.unitCost.toFixed(2);
  }

  // Materials Catalog Drawer phase 3 — bulk add. Loops applyAddLineItem
  // with _silent:true so we don't re-render or save N times, then
  // finalizes with a single save + render. Returns the list of
  // summary strings for the caller to surface in the UI.
  function applyBulkAddLineItems(lines) {
    if (!Array.isArray(lines) || !lines.length) return [];
    var summaries = [];
    var errors = [];
    lines.forEach(function(spec) {
      try {
        summaries.push(applyAddLineItem(Object.assign({ _silent: true }, spec || {})));
      } catch (e) {
        errors.push((spec && spec.description) || 'unknown' + ': ' + (e.message || 'failed'));
      }
    });
    // Single save + render after the whole batch lands.
    debouncedSave();
    renderLineItems();
    renderTotals();
    if (errors.length) {
      summaries.push('— ' + errors.length + ' failed: ' + errors.join('; '));
    }
    return summaries;
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

  // ──── Group / alternate appliers ────────────────────────────────────
  // Resolve a group identifier (id OR case-insensitive name substring)
  // against the currently-open estimate. Returns the alternate object
  // or null. Used by every group-management applier.
  function resolveGroup(input_id) {
    var est = getEstimate();
    if (!est || !Array.isArray(est.alternates)) return null;
    var raw = String(input_id || '').trim();
    if (!raw) return null;
    var byId = est.alternates.find(function(a) { return a.id === raw; });
    if (byId) return byId;
    var needle = raw.toLowerCase();
    var byNameExact = est.alternates.find(function(a) { return (a.name || '').toLowerCase() === needle; });
    if (byNameExact) return byNameExact;
    return est.alternates.find(function(a) { return (a.name || '').toLowerCase().indexOf(needle) >= 0; }) || null;
  }

  function applySwitchActiveGroup(input) {
    var alt = resolveGroup(input.group_id);
    if (!alt) throw new Error('Group not found: "' + input.group_id + '". Use propose_add_group to create it first.');
    if (typeof switchAlternate === 'function') switchAlternate(alt.id);
    return 'Active group → "' + alt.name + '"';
  }

  function applyAddGroup(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    if (!Array.isArray(est.alternates)) est.alternates = [];
    var name = String(input.name || '').trim();
    if (!name) throw new Error('Group name is required.');
    if (est.alternates.some(function(a) { return (a.name || '').toLowerCase() === name.toLowerCase(); })) {
      throw new Error('A group named "' + name + '" already exists.');
    }
    var copyFromActive = !!input.copy_from_active;
    var sourceAlt = copyFromActive ? getActiveAlternate() : null;
    var newAlt = { id: 'alt_' + Date.now(), name: name, isDefault: false, scope: (sourceAlt && sourceAlt.scope) || '' };
    est.alternates.push(newAlt);
    if (copyFromActive && sourceAlt) {
      var sourceLines = (appData.estimateLines || []).filter(function(l) {
        return l.estimateId === est.id && l.alternateId === sourceAlt.id;
      });
      sourceLines.forEach(function(l, idx) {
        var copy = Object.assign({}, l);
        copy.id = (l.section === '__section_header__' ? 's' : 'l') + Date.now() + '_' + idx;
        copy.alternateId = newAlt.id;
        appData.estimateLines.push(copy);
      });
    } else {
      // Empty group — seed the four standard subgroups so the next
      // propose_add_line_item has somewhere to slot.
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
    }
    est.activeAlternateId = newAlt.id;
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
    renderScopePanel();
    return 'Created group "' + name + '" (' + (copyFromActive ? 'cloned from active' : 'seeded with 4 standard subgroups') + ') and switched focus to it.';
  }

  function applyRenameGroup(input) {
    var alt = resolveGroup(input.group_id);
    if (!alt) throw new Error('Group not found: "' + input.group_id + '".');
    var newName = String(input.new_name || '').trim();
    if (!newName) throw new Error('new_name is required.');
    var prev = alt.name;
    alt.name = newName;
    debouncedSave();
    renderAlternateTabs();
    return 'Renamed group "' + prev + '" → "' + newName + '"';
  }

  function applyDeleteGroup(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = resolveGroup(input.group_id);
    if (!alt) throw new Error('Group not found: "' + input.group_id + '".');
    if ((est.alternates || []).length <= 1) {
      throw new Error('Cannot delete the only group on an estimate. Estimates require at least one group.');
    }
    var name = alt.name;
    var lineCount = (appData.estimateLines || []).filter(function(l) {
      return l.estimateId === est.id && l.alternateId === alt.id;
    }).length;
    appData.estimateLines = (appData.estimateLines || []).filter(function(l) {
      return !(l.estimateId === est.id && l.alternateId === alt.id);
    });
    est.alternates = est.alternates.filter(function(a) { return a.id !== alt.id; });
    if (est.activeAlternateId === alt.id) {
      est.activeAlternateId = est.alternates[0].id;
    }
    debouncedSave();
    renderAlternateTabs();
    renderLineItems();
    renderTotals();
    renderScopePanel();
    return 'Deleted group "' + name + '" and ' + lineCount + ' line' + (lineCount === 1 ? '' : 's') + ' under it.';
  }

  function applyToggleGroupInclude(input) {
    var alt = resolveGroup(input.group_id);
    if (!alt) throw new Error('Group not found: "' + input.group_id + '".');
    var included = !!input.included;
    alt.excludeFromTotal = !included;
    debouncedSave();
    renderAlternateTabs();
    renderTotals();
    renderLineItems();
    return 'Group "' + alt.name + '" ' + (included ? 'included in' : 'excluded from') + ' grand total.';
  }

  // ──── Linking + estimate-metadata appliers ───────────────────────────
  function applyLinkToClient(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var clientId = String(input.client_id || '').trim();
    if (!clientId) throw new Error('client_id is required.');
    var client = (appData.clients || []).find(function(c) { return c.id === clientId; });
    if (!client) throw new Error('Client not found in cache: ' + clientId + '. Reload the client list and try again.');
    est.client_id = clientId;
    debouncedSave();
    renderDetailsForm();
    renderLineItems();
    return 'Linked estimate to client "' + (client.name || clientId) + '".';
  }

  function applyLinkToLead(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var leadId = String(input.lead_id || '').trim();
    if (!leadId) throw new Error('lead_id is required.');
    est.lead_id = leadId;
    debouncedSave();
    renderDetailsForm();
    renderLineItems();
    return 'Linked estimate to lead ' + leadId + '.';
  }

  function applyUpdateEstimateField(input) {
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var field = String(input.field || '').trim();
    var value = input.value;
    var fieldMap = {
      title: 'title',
      salutation: 'salutation',
      markup_default: 'markupDefault',
      bt_export_status: 'btExportStatus',
      notes: 'notes'
    };
    var key = fieldMap[field];
    if (!key) throw new Error('Unsupported field: ' + field);
    var prev = est[key];
    if (field === 'markup_default') {
      var n = Number(value);
      if (!isFinite(n) || n < 0) throw new Error('markup_default must be a non-negative number.');
      est[key] = n;
    } else {
      est[key] = (value == null) ? '' : String(value);
    }
    debouncedSave();
    renderDetailsForm();
    renderLineItems();
    renderTotals();
    return 'Estimate ' + field + ': ' + (prev == null ? '(empty)' : prev) + ' → ' + est[key];
  }

  // ──── Bulk line operations ───────────────────────────────────────────
  function applyBulkUpdateLines(input) {
    var ids = Array.isArray(input.line_ids) ? input.line_ids : [];
    if (!ids.length) throw new Error('line_ids is required and must not be empty.');
    var changes = input.changes || {};
    var est = getEstimate();
    if (!est) throw new Error('No estimate open.');
    var alt = getActiveAlternate();

    // Resolve target section once if section_name is in changes — same
    // substring rule as applyAddLineItem so behavior is consistent.
    var targetSectionId = null;
    if (changes.section_name) {
      var needle = String(changes.section_name).toLowerCase();
      var match = (appData.estimateLines || []).find(function(l) {
        return l.estimateId === est.id
          && (alt ? l.alternateId === alt.id : true)
          && l.section === '__section_header__'
          && (l.description || '').toLowerCase().indexOf(needle) >= 0;
      });
      if (!match) throw new Error('Section "' + changes.section_name + '" not found on the active group.');
      targetSectionId = match.id;
    }

    var updated = 0;
    ids.forEach(function(lineId) {
      var line = (appData.estimateLines || []).find(function(l) { return l.id === lineId; });
      if (!line || line.section === '__section_header__') return;
      if (changes.description != null)             line.description = String(changes.description);
      if (changes.qty != null)                     line.qty         = Number(changes.qty);
      if (changes.unit != null)                    line.unit        = String(changes.unit);
      if (changes.unit_cost != null)               line.unitCost    = Number(changes.unit_cost);
      if (changes.markup_pct != null)              line.markup      = Number(changes.markup_pct);
      // section_name move = re-anchor under the resolved section header
      // by reordering the array so the line ends up just after the
      // target header (or before the next header). Same insertion
      // logic as applyAddLineItem.
      if (targetSectionId) {
        var arr = appData.estimateLines;
        var fromIdx = arr.findIndex(function(l) { return l.id === lineId; });
        if (fromIdx >= 0) {
          var moved = arr.splice(fromIdx, 1)[0];
          var headIdx = arr.findIndex(function(l) { return l.id === targetSectionId; });
          var insertAt = arr.length;
          for (var j = headIdx + 1; j < arr.length; j++) {
            if (arr[j].section === '__section_header__') { insertAt = j; break; }
          }
          arr.splice(insertAt, 0, moved);
        }
      }
      updated++;
    });
    if (!updated) throw new Error('No matching lines found for ids: ' + ids.join(', '));
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Updated ' + updated + ' line' + (updated === 1 ? '' : 's') + '.';
  }

  function applyBulkDeleteLines(input) {
    var ids = Array.isArray(input.line_ids) ? input.line_ids : [];
    if (!ids.length) throw new Error('line_ids is required and must not be empty.');
    var idSet = {};
    ids.forEach(function(id) { idSet[id] = true; });
    var before = (appData.estimateLines || []).length;
    appData.estimateLines = (appData.estimateLines || []).filter(function(l) {
      return !(idSet[l.id] && l.section !== '__section_header__');
    });
    var removed = before - appData.estimateLines.length;
    if (!removed) throw new Error('No matching lines found for ids: ' + ids.join(', '));
    debouncedSave();
    renderLineItems();
    renderTotals();
    return 'Deleted ' + removed + ' line' + (removed === 1 ? '' : 's') + '.';
  }

  window.estimateEditorAPI = {
    isOpenFor: function(estimateId) { return _currentId === estimateId; },
    getOpenId: function() { return _currentId; },
    // Called by openEstimateFromLead so close → "Back" lands on the
    // lead the user came from instead of the estimates list.
    setReturnToLead: function(leadId) { _returnToLeadId = leadId || null; },
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
    // AG phase — read by the AI panel to render its mode chip in
    // sync with the editor's pill.
    getAIPhase: getEstimateAIPhase,
    applyAddLineItem: applyAddLineItem,
    applyBulkAddLineItems: applyBulkAddLineItems,
    applyAddSection: applyAddSection,
    applyUpdateScope: applyUpdateScope,
    applyDeleteLine: applyDeleteLine,
    applyUpdateLine: applyUpdateLine,
    applyDeleteSection: applyDeleteSection,
    applyUpdateSection: applyUpdateSection,
    // Group / alternate management
    applySwitchActiveGroup: applySwitchActiveGroup,
    applyAddGroup: applyAddGroup,
    applyRenameGroup: applyRenameGroup,
    applyDeleteGroup: applyDeleteGroup,
    applyToggleGroupInclude: applyToggleGroupInclude,
    // Linking + estimate metadata
    applyLinkToClient: applyLinkToClient,
    applyLinkToLead: applyLinkToLead,
    applyUpdateEstimateField: applyUpdateEstimateField,
    // Bulk line operations
    applyBulkUpdateLines: applyBulkUpdateLines,
    applyBulkDeleteLines: applyBulkDeleteLines
  };
  window.addAlternateFromEditor = addAlternateFromEditor;
  window.renameActiveAlternate = renameActiveAlternate;
  window.duplicateActiveAlternate = duplicateActiveAlternate;
  window.deleteActiveAlternate = deleteActiveAlternate;
  window.toggleGroupInclude = toggleGroupInclude;
  window.setEstimateAIPhase = setEstimateAIPhase;
})();
