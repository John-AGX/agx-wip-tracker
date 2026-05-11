// Project 86 — Job Reports module
//
// Drives the "Reports" sub-tab inside a job. Two view modes:
//   list view  — table of saved reports + "+ New Report" button
//   editor     — title / summary / sectioned photo grid with captions
//
// Photos come from the job's existing attachments (entity_type='job',
// entity_id=<jobId>). The picker lets the user multi-select images to
// drop into a section; captions are edited in place.
//
// Print is browser-native: clicking Print opens a printable view in
// a new tab (window.open) so the browser's Save-as-PDF gives a clean
// letter-page output. Print stylesheet hides chrome and lays photos
// in a 2-up grid with captions underneath.
//
// Exposes: window.renderJobReports(jobId)

(function() {
  'use strict';

  // ── Module state ──
  // Editing one report at a time per panel-open. Cached attachments
  // for the current job so the picker doesn't re-fetch on every open.
  var _state = {
    jobId: null,
    mode: 'list',            // 'list' | 'edit'
    editingReport: null,     // full report record while editing
    reports: [],
    attachments: null,       // null = not fetched yet
    attachmentsLoading: false,
    pickerSectionId: null,   // which section is choosing photos
    pickerSelected: {}       // map of attachment_id -> true while picker open
  };

  function _api() {
    return (window.p86Api && window.p86Api) || null;
  }
  function _newId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }
  function _esc(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }
  function _fmtDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
  }

  // ── Network helpers ──
  function _fetchReports(jobId) {
    return _api().get('/api/jobs/' + encodeURIComponent(jobId) + '/reports')
      .then(function(r) { return (r && r.reports) || []; });
  }
  function _fetchReport(jobId, reportId) {
    return _api().get('/api/jobs/' + encodeURIComponent(jobId) + '/reports/' + encodeURIComponent(reportId))
      .then(function(r) { return r && r.report; });
  }
  function _createReport(jobId, body) {
    return _api().post('/api/jobs/' + encodeURIComponent(jobId) + '/reports', body || {})
      .then(function(r) { return r && r.report; });
  }
  function _saveReport(jobId, reportId, body) {
    return _api().patch('/api/jobs/' + encodeURIComponent(jobId) + '/reports/' + encodeURIComponent(reportId), body);
  }
  function _deleteReport(jobId, reportId) {
    return _api().del('/api/jobs/' + encodeURIComponent(jobId) + '/reports/' + encodeURIComponent(reportId));
  }
  function _fetchAttachments(jobId) {
    return _api().get('/api/attachments/job/' + encodeURIComponent(jobId))
      .then(function(r) { return (r && r.attachments) || []; });
  }

  // ── Top-level entry ──
  // Called by workspace-layout.js TAB_RENDERERS when the user clicks
  // the Reports sub-tab. Re-renders from current state every time.
  function renderJobReports(jobId) {
    _state.jobId = jobId;
    _state.mode = 'list';
    _state.editingReport = null;
    _paint();
    _fetchReports(jobId).then(function(reports) {
      _state.reports = reports;
      _paint();
    }).catch(function(e) {
      console.error('[reports] fetchReports failed:', e);
      _paint();
    });
  }
  window.renderJobReports = renderJobReports;

  // ── Render dispatch ──
  function _paint() {
    var host = document.getElementById('job-reports-content');
    if (!host) return;
    if (_state.mode === 'edit') {
      host.innerHTML = _renderEditor();
      _wireEditor();
    } else {
      host.innerHTML = _renderList();
      _wireList();
    }
  }

  // ── List view ──
  function _renderList() {
    var rows = _state.reports.map(function(r) {
      return '<tr data-report-id="' + _esc(r.id) + '">' +
        '<td><strong>' + _esc(r.title || '(untitled)') + '</strong>' +
          (r.summary ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-top:2px;">' +
            _esc(r.summary.slice(0, 120)) + (r.summary.length > 120 ? '…' : '') + '</div>' : '') +
        '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums;">' + r.section_count + '</td>' +
        '<td style="text-align:right;font-variant-numeric:tabular-nums;">' + r.photo_count + '</td>' +
        '<td style="color:var(--text-dim,#888);font-size:12px;">' + _fmtDate(r.updated_at) + '</td>' +
        '<td style="text-align:right;white-space:nowrap;">' +
          '<button class="ee-btn small" data-action="open">Edit</button> ' +
          '<button class="ee-btn small" data-action="print">Print</button> ' +
          '<button class="ee-btn small danger" data-action="delete" title="Delete report">&#x1F5D1;</button>' +
        '</td>' +
      '</tr>';
    }).join('');
    var empty = !_state.reports.length
      ? '<div style="padding:20px;text-align:center;color:var(--text-dim,#888);font-size:13px;">' +
          'No reports yet. Click + New Report to create the first one — a photo-driven walkthrough for this job.' +
        '</div>'
      : '';
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">' +
        '<h3 style="margin:0;font-size:16px;">Reports</h3>' +
        '<span style="color:var(--text-dim,#888);font-size:12px;">' +
          _state.reports.length + ' report' + (_state.reports.length === 1 ? '' : 's') +
        '</span>' +
        '<div style="flex:1;"></div>' +
        '<button class="ee-btn primary" id="rpt-new-btn">&#x2795; New Report</button>' +
      '</div>' +
      '<div class="table-container">' +
        '<table class="dense-table">' +
          '<thead><tr>' +
            '<th>Title</th>' +
            '<th style="text-align:right;width:70px;">Sections</th>' +
            '<th style="text-align:right;width:70px;">Photos</th>' +
            '<th style="width:170px;">Updated</th>' +
            '<th style="width:170px;text-align:right;">Actions</th>' +
          '</tr></thead>' +
          '<tbody>' + rows + '</tbody>' +
        '</table>' +
        empty +
      '</div>';
  }
  function _wireList() {
    var newBtn = document.getElementById('rpt-new-btn');
    if (newBtn) newBtn.onclick = _onNewReport;
    document.querySelectorAll('#job-reports-content tbody tr').forEach(function(tr) {
      var rid = tr.getAttribute('data-report-id');
      var openBtn   = tr.querySelector('[data-action="open"]');
      var printBtn  = tr.querySelector('[data-action="print"]');
      var deleteBtn = tr.querySelector('[data-action="delete"]');
      if (openBtn)   openBtn.onclick   = function() { _openReport(rid); };
      if (printBtn)  printBtn.onclick  = function() { _printReport(rid); };
      if (deleteBtn) deleteBtn.onclick = function() {
        if (!confirm('Delete this report? This cannot be undone.')) return;
        _deleteReport(_state.jobId, rid).then(function() {
          _state.reports = _state.reports.filter(function(r) { return r.id !== rid; });
          _paint();
        }).catch(function(e) { alert('Delete failed: ' + (e.message || 'unknown')); });
      };
    });
  }

  function _onNewReport() {
    var title = prompt('Report title:', 'Job walkthrough — ' + new Date().toLocaleDateString());
    if (title == null) return;
    _createReport(_state.jobId, { title: title }).then(function(r) {
      // Reload the freshly-created (so we get hydrated sections) and
      // jump straight into the editor.
      return _fetchReport(_state.jobId, r.id);
    }).then(function(full) {
      _state.editingReport = full;
      _state.mode = 'edit';
      _paint();
      // Prime the attachments cache for the photo picker.
      _ensureAttachments();
    }).catch(function(e) { alert('Could not create report: ' + (e.message || 'unknown')); });
  }

  function _openReport(reportId) {
    _fetchReport(_state.jobId, reportId).then(function(full) {
      _state.editingReport = full;
      _state.mode = 'edit';
      _paint();
      _ensureAttachments();
    }).catch(function(e) { alert('Could not open report: ' + (e.message || 'unknown')); });
  }

  function _printReport(reportId) {
    // Open a fresh tab with the printable view. The print HTML is
    // built server-fetched-then-client-rendered so we don't need a
    // separate route.
    var w = window.open('', '_blank');
    if (!w) {
      alert('Pop-up blocked. Allow pop-ups for this site to print reports.');
      return;
    }
    w.document.write('<!DOCTYPE html><html><head><title>Loading report…</title></head><body style="font-family:system-ui;color:#666;padding:24px;">Loading…</body></html>');
    _fetchReport(_state.jobId, reportId).then(function(rpt) {
      // Pull job identity for the print header (job number, title).
      var job = null;
      try {
        job = (window.appData && window.appData.jobs || []).find(function(j) { return j.id === _state.jobId; });
      } catch (e) {}
      w.document.open();
      w.document.write(_renderPrintHTML(rpt, job));
      w.document.close();
      // Let images load before triggering print.
      w.addEventListener('load', function() {
        setTimeout(function() { w.focus(); w.print(); }, 250);
      });
    }).catch(function(e) {
      w.document.body.textContent = 'Failed to load report: ' + (e.message || 'unknown');
    });
  }

  // ── Editor view ──
  function _renderEditor() {
    var rpt = _state.editingReport;
    if (!rpt) return '<div style="padding:20px;">Loading…</div>';
    var sections = Array.isArray(rpt.sections) ? rpt.sections : [];
    var sectionsHtml = sections.map(function(s) { return _renderSectionEditor(s); }).join('');
    return '<div style="display:flex;align-items:center;gap:10px;margin-bottom:14px;flex-wrap:wrap;">' +
        '<button class="ee-btn secondary" id="rpt-back-btn">&larr; Back to list</button>' +
        '<input id="rpt-title" type="text" value="' + _esc(rpt.title || '') + '" placeholder="Report title" ' +
          'style="flex:1;min-width:240px;font-size:17px;font-weight:600;padding:6px 10px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);" />' +
        '<span id="rpt-save-state" style="font-size:11px;color:var(--text-dim,#888);min-width:80px;text-align:right;"></span>' +
        '<button class="ee-btn" id="rpt-save-btn">&#x1F4BE; Save</button>' +
        '<button class="ee-btn primary" id="rpt-print-btn">&#x1F5A8; Print</button>' +
      '</div>' +
      '<div class="card" style="margin-bottom:14px;padding:12px 14px;">' +
        '<label style="font-size:11px;font-weight:600;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Summary</label>' +
        '<textarea id="rpt-summary" rows="3" placeholder="One paragraph overview shown at the top of the printed report…" ' +
          'style="display:block;width:100%;margin-top:6px;padding:8px 10px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);font-family:inherit;font-size:13px;line-height:1.45;resize:vertical;">' +
          _esc(rpt.summary || '') +
        '</textarea>' +
      '</div>' +
      '<div id="rpt-sections">' + sectionsHtml + '</div>' +
      '<div style="margin-top:14px;display:flex;gap:8px;">' +
        '<button class="ee-btn" id="rpt-add-section-btn">&#x2795; Add section</button>' +
      '</div>';
  }

  function _renderSectionEditor(s) {
    var photos = Array.isArray(s.photos) ? s.photos : [];
    var photoGrid = photos.length
      ? '<div class="rpt-photo-grid">' +
          photos.map(function(p) { return _renderPhotoCard(s.id, p); }).join('') +
        '</div>'
      : '<div style="padding:18px;text-align:center;color:var(--text-dim,#888);font-size:12px;border:1px dashed var(--border,#333);border-radius:8px;">' +
          'No photos in this section yet. Click "Add photos" to pull from this job\'s attachments.' +
        '</div>';
    return '<div class="card rpt-section" data-section-id="' + _esc(s.id) + '" style="margin-bottom:14px;padding:12px 14px;">' +
      '<div style="display:flex;align-items:center;gap:8px;margin-bottom:10px;">' +
        '<input type="text" class="rpt-section-label" value="' + _esc(s.label || '') + '" placeholder="Section label (Before, During, After, etc.)" ' +
          'style="flex:1;min-width:200px;font-size:14px;font-weight:600;padding:5px 8px;background:transparent;border:1px solid var(--border,#333);border-radius:6px;color:var(--text,#fff);" />' +
        '<button class="ee-btn small" data-action="add-photos">&#x2795; Add photos</button>' +
        '<button class="ee-btn small danger" data-action="delete-section" title="Delete this section">&#x1F5D1;</button>' +
      '</div>' +
      photoGrid +
    '</div>';
  }

  function _renderPhotoCard(sectionId, photo) {
    var src = photo.thumb_url || photo.web_url || photo.original_url || '';
    return '<div class="rpt-photo-card" data-photo-id="' + _esc(photo.id) + '">' +
      '<div class="rpt-photo-image" style="background-image:url(' + JSON.stringify(src) + ');">' +
        '<button class="rpt-photo-remove" type="button" title="Remove from this section" data-action="remove-photo">&times;</button>' +
      '</div>' +
      '<textarea class="rpt-photo-caption" rows="2" placeholder="Caption…">' + _esc(photo.caption || '') + '</textarea>' +
    '</div>';
  }

  // ── Editor wiring ──
  function _wireEditor() {
    var backBtn  = document.getElementById('rpt-back-btn');
    var saveBtn  = document.getElementById('rpt-save-btn');
    var printBtn = document.getElementById('rpt-print-btn');
    var addBtn   = document.getElementById('rpt-add-section-btn');
    if (backBtn)  backBtn.onclick  = function() {
      if (_isDirty()) _saveNow().then(_backToList).catch(_backToList);
      else _backToList();
    };
    if (saveBtn)  saveBtn.onclick  = function() { _saveNow(true); };
    if (printBtn) printBtn.onclick = function() {
      var rid = _state.editingReport && _state.editingReport.id;
      if (rid) {
        // Save before print so the printed copy matches what's
        // visible on screen.
        if (_isDirty()) _saveNow().then(function() { _printReport(rid); });
        else _printReport(rid);
      }
    };
    if (addBtn) addBtn.onclick = function() {
      var rpt = _state.editingReport;
      rpt.sections.push({ id: _newId('sec'), label: 'New section', photos: [] });
      _paint();
    };

    // Section + photo controls.
    document.querySelectorAll('#job-reports-content .rpt-section').forEach(function(secEl) {
      var sid = secEl.getAttribute('data-section-id');
      var addPhotos    = secEl.querySelector('[data-action="add-photos"]');
      var deleteSec    = secEl.querySelector('[data-action="delete-section"]');
      var labelInput   = secEl.querySelector('.rpt-section-label');
      if (addPhotos)  addPhotos.onclick  = function() { _openPhotoPicker(sid); };
      if (deleteSec)  deleteSec.onclick  = function() {
        if (!confirm('Delete this section and its photo selections?')) return;
        _state.editingReport.sections = _state.editingReport.sections.filter(function(s) { return s.id !== sid; });
        _paint();
      };
      if (labelInput) labelInput.oninput = function() {
        var sec = _findSection(sid);
        if (sec) sec.label = labelInput.value;
      };
      secEl.querySelectorAll('.rpt-photo-card').forEach(function(card) {
        var pid = card.getAttribute('data-photo-id');
        var rm  = card.querySelector('[data-action="remove-photo"]');
        var cap = card.querySelector('.rpt-photo-caption');
        if (rm)  rm.onclick  = function() {
          var sec = _findSection(sid);
          if (!sec) return;
          sec.photos = (sec.photos || []).filter(function(p) { return p.id !== pid; });
          _paint();
        };
        if (cap) cap.oninput = function() {
          var sec = _findSection(sid);
          if (!sec) return;
          var ph = (sec.photos || []).find(function(p) { return p.id === pid; });
          if (ph) ph.caption = cap.value;
        };
      });
    });

    // Title + summary track local state immediately.
    var titleEl   = document.getElementById('rpt-title');
    var summaryEl = document.getElementById('rpt-summary');
    if (titleEl)   titleEl.oninput   = function() { _state.editingReport.title   = titleEl.value; };
    if (summaryEl) summaryEl.oninput = function() { _state.editingReport.summary = summaryEl.value; };
  }

  function _findSection(sid) {
    var sections = (_state.editingReport && _state.editingReport.sections) || [];
    return sections.find(function(s) { return s.id === sid; });
  }
  function _backToList() {
    _state.editingReport = null;
    _state.mode = 'list';
    // Re-fetch list so the counts / titles reflect saved edits.
    _fetchReports(_state.jobId).then(function(reports) {
      _state.reports = reports;
      _paint();
    });
  }
  function _isDirty() {
    // Cheap and simple — always allow save. The PATCH path is a no-op
    // when bodies match.
    return true;
  }

  // Build the PATCH body. sections_raw round-trips captions for
  // photos that don't have caption changes; we also pick up the
  // edits the user made in the photo grid.
  function _saveNow(showStatus) {
    var rpt = _state.editingReport;
    if (!rpt) return Promise.resolve();
    var statusEl = document.getElementById('rpt-save-state');
    if (statusEl) statusEl.textContent = 'Saving…';
    // Convert hydrated sections to wire shape (photo_ids + captions).
    var wire = (rpt.sections || []).map(function(s) {
      var photoIds = [];
      var captions = {};
      (s.photos || []).forEach(function(p) {
        photoIds.push(p.id);
        if (p.caption) captions[p.id] = p.caption;
      });
      return { id: s.id, label: s.label, photo_ids: photoIds, captions: captions };
    });
    return _saveReport(_state.jobId, rpt.id, {
      title: rpt.title,
      summary: rpt.summary,
      sections: wire
    }).then(function() {
      if (statusEl) {
        statusEl.textContent = 'Saved';
        clearTimeout(statusEl._timer);
        statusEl._timer = setTimeout(function() { statusEl.textContent = ''; }, 2000);
      }
    }).catch(function(e) {
      if (statusEl) statusEl.textContent = 'Save failed';
      alert('Save failed: ' + (e.message || 'unknown'));
    });
  }

  // ── Photo picker modal ──
  function _ensureAttachments() {
    if (_state.attachments || _state.attachmentsLoading) return;
    _state.attachmentsLoading = true;
    _fetchAttachments(_state.jobId).then(function(atts) {
      // Filter to image-mime types only.
      _state.attachments = (atts || []).filter(function(a) {
        return /^image\//i.test(a.mime_type || '');
      });
      _state.attachmentsLoading = false;
    }).catch(function(e) {
      console.error('[reports] fetchAttachments failed:', e);
      _state.attachments = [];
      _state.attachmentsLoading = false;
    });
  }

  function _openPhotoPicker(sectionId) {
    _state.pickerSectionId = sectionId;
    _state.pickerSelected  = {};
    _ensureAttachments();
    _renderPicker();
    // Re-render once attachments finish loading.
    var poll = setInterval(function() {
      if (_state.attachments !== null) {
        clearInterval(poll);
        _renderPicker();
      }
    }, 150);
  }

  function _renderPicker() {
    var existing = document.getElementById('rpt-picker-modal');
    if (existing) existing.remove();
    var atts = _state.attachments;
    var listHtml = '';
    if (atts === null) {
      listHtml = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">Loading photos…</div>';
    } else if (!atts.length) {
      listHtml = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">' +
        'No image attachments on this job yet. Upload photos via the Attachments area first.' +
      '</div>';
    } else {
      // Filter out photos already in the active section so the user
      // doesn't add duplicates.
      var sec = _findSection(_state.pickerSectionId);
      var already = {};
      ((sec && sec.photos) || []).forEach(function(p) { already[p.id] = true; });
      var pickable = atts.filter(function(a) { return !already[a.id]; });
      if (!pickable.length) {
        listHtml = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);">' +
          'Every image attachment on this job is already in this section. Add more photos to the job, or pick a different section.' +
        '</div>';
      } else {
        listHtml = '<div class="rpt-picker-grid">' +
          pickable.map(function(a) {
            var src = a.thumb_url || a.web_url || a.original_url || '';
            return '<label class="rpt-picker-card" data-att-id="' + _esc(a.id) + '">' +
              '<input type="checkbox" class="rpt-picker-checkbox" value="' + _esc(a.id) + '" />' +
              '<div class="rpt-picker-image" style="background-image:url(' + JSON.stringify(src) + ');"></div>' +
              '<div class="rpt-picker-filename">' + _esc(a.filename || '') + '</div>' +
            '</label>';
          }).join('') +
        '</div>';
      }
    }
    var modal = document.createElement('div');
    modal.id = 'rpt-picker-modal';
    modal.className = 'rpt-picker-modal';
    modal.innerHTML =
      '<div class="rpt-picker-content">' +
        '<div class="rpt-picker-header">' +
          '<h3 style="margin:0;font-size:15px;">Add photos to this section</h3>' +
          '<button class="ee-btn small" id="rpt-picker-close">&times;</button>' +
        '</div>' +
        '<div class="rpt-picker-body">' + listHtml + '</div>' +
        '<div class="rpt-picker-footer">' +
          '<span id="rpt-picker-selected-count" style="color:var(--text-dim,#888);font-size:12px;">0 selected</span>' +
          '<div style="flex:1;"></div>' +
          '<button class="ee-btn" id="rpt-picker-cancel">Cancel</button>' +
          '<button class="ee-btn primary" id="rpt-picker-add">Add selected</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modal);
    modal.querySelector('#rpt-picker-close').onclick = _closePicker;
    modal.querySelector('#rpt-picker-cancel').onclick = _closePicker;
    modal.querySelector('#rpt-picker-add').onclick = _commitPicker;
    var countEl = modal.querySelector('#rpt-picker-selected-count');
    function refreshCount() {
      var n = Object.keys(_state.pickerSelected).length;
      countEl.textContent = n + ' selected';
    }
    modal.querySelectorAll('.rpt-picker-checkbox').forEach(function(cb) {
      cb.onchange = function() {
        if (cb.checked) _state.pickerSelected[cb.value] = true;
        else delete _state.pickerSelected[cb.value];
        refreshCount();
      };
    });
    refreshCount();
  }

  function _closePicker() {
    var m = document.getElementById('rpt-picker-modal');
    if (m) m.remove();
    _state.pickerSectionId = null;
    _state.pickerSelected = {};
  }

  function _commitPicker() {
    var sec = _findSection(_state.pickerSectionId);
    if (!sec) return _closePicker();
    if (!Array.isArray(sec.photos)) sec.photos = [];
    var atts = _state.attachments || [];
    var attsById = new Map(atts.map(function(a) { return [a.id, a]; }));
    Object.keys(_state.pickerSelected).forEach(function(pid) {
      var a = attsById.get(pid);
      if (!a) return;
      sec.photos.push({
        id: a.id,
        filename: a.filename,
        mime_type: a.mime_type,
        thumb_url: a.thumb_url,
        web_url: a.web_url,
        original_url: a.original_url,
        caption: ''
      });
    });
    _closePicker();
    _paint();
  }

  // ── Print rendering (opens in a new tab) ──
  function _renderPrintHTML(rpt, job) {
    var sections = (rpt.sections || []).filter(function(s) {
      return (s.photos || []).length > 0;
    });
    var jobNumber = job && job.jobNumber ? job.jobNumber : '';
    var jobTitle  = job && job.title ? job.title : '';
    var dateStr   = new Date().toLocaleDateString();
    var summaryBlock = rpt.summary
      ? '<p class="rpt-print-summary">' + _esc(rpt.summary).replace(/\n/g, '<br/>') + '</p>'
      : '';
    var sectionsHTML = sections.map(function(s) {
      var photosHTML = (s.photos || []).map(function(p) {
        var src = p.web_url || p.original_url || p.thumb_url || '';
        return '<figure class="rpt-print-photo">' +
          '<img src="' + _esc(src) + '" alt="' + _esc(p.filename || '') + '" />' +
          (p.caption ? '<figcaption>' + _esc(p.caption) + '</figcaption>' : '') +
        '</figure>';
      }).join('');
      return '<section class="rpt-print-section">' +
        '<h2>' + _esc(s.label || 'Section') + '</h2>' +
        '<div class="rpt-print-photo-grid">' + photosHTML + '</div>' +
      '</section>';
    }).join('');
    var styles =
      '<style>' +
        '@page { size: letter; margin: 0.5in 0.5in 0.6in 0.5in; }' +
        '* { box-sizing: border-box; }' +
        'body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; color: #111; background: #fff; margin: 0; }' +
        '.rpt-print-header { display: flex; justify-content: space-between; align-items: flex-start; padding: 12px 0 12px 0; border-bottom: 2px solid #111; margin-bottom: 14px; }' +
        '.rpt-print-brand { font-weight: 800; font-size: 18px; letter-spacing: 0.5px; }' +
        '.rpt-print-brand-sub { font-size: 10px; color: #555; letter-spacing: 0.5px; text-transform: uppercase; margin-top: 2px; }' +
        '.rpt-print-meta { text-align: right; font-size: 11px; color: #333; line-height: 1.5; }' +
        '.rpt-print-meta strong { color: #111; }' +
        '.rpt-print-title { font-size: 22px; font-weight: 700; margin: 0 0 4px 0; }' +
        '.rpt-print-summary { font-size: 12px; color: #333; line-height: 1.5; margin: 6px 0 18px 0; padding: 10px 12px; background: #f4f6fa; border-left: 3px solid #4f8cff; border-radius: 2px; }' +
        '.rpt-print-section { page-break-inside: avoid; margin-bottom: 22px; }' +
        '.rpt-print-section h2 { font-size: 14px; text-transform: uppercase; letter-spacing: 1px; color: #4f8cff; border-bottom: 1px solid #d0d7e2; padding-bottom: 4px; margin: 0 0 10px 0; }' +
        '.rpt-print-photo-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 14px 12px; }' +
        '.rpt-print-photo { margin: 0; page-break-inside: avoid; }' +
        '.rpt-print-photo img { width: 100%; height: auto; border-radius: 4px; border: 1px solid #d0d7e2; display: block; }' +
        '.rpt-print-photo figcaption { font-size: 10px; line-height: 1.35; color: #333; margin-top: 4px; padding: 0 2px; }' +
        '.rpt-print-footer { margin-top: 30px; padding-top: 10px; border-top: 1px solid #d0d7e2; font-size: 9px; color: #888; text-align: center; }' +
      '</style>';
    return '<!DOCTYPE html><html><head><meta charset="utf-8" />' +
      '<title>' + _esc(rpt.title || 'Project 86 Report') + '</title>' + styles + '</head><body>' +
      '<div class="rpt-print-header">' +
        '<div>' +
          '<div class="rpt-print-brand">PROJECT 86</div>' +
          '<div class="rpt-print-brand-sub">Job Report</div>' +
        '</div>' +
        '<div class="rpt-print-meta">' +
          (jobNumber ? '<div><strong>Job #</strong> ' + _esc(jobNumber) + '</div>' : '') +
          (jobTitle  ? '<div><strong>Job</strong> '   + _esc(jobTitle)  + '</div>' : '') +
          '<div><strong>Generated</strong> ' + _esc(dateStr) + '</div>' +
        '</div>' +
      '</div>' +
      '<h1 class="rpt-print-title">' + _esc(rpt.title || 'Untitled report') + '</h1>' +
      summaryBlock +
      sectionsHTML +
      '<div class="rpt-print-footer">Project 86 &middot; agxco.com</div>' +
    '</body></html>';
  }
})();
