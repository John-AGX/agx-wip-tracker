// Subcontractor directory + per-job assignment UI.
//
// Phase B: directory sub-tab next to Clients on the Estimates page —
//          listing, filters, new/edit modal, drilldown.
// Phase D: one-time migration that rolls up legacy inline-per-job
//          appData.subs records into the directory + job_subs.
//          Always shows a dedupe preview before writing.
// Phase C (later): job-side searchable picker.

(function() {
  'use strict';

  function fmtMoney(n) {
    var v = Number(n || 0);
    var sign = v < 0 ? '-' : '';
    return sign + '$' + Math.abs(v).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
  }
  function fmtDate(d) {
    if (!d) return '';
    var s = String(d);
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
    return s;
  }
  function escapeHTML(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function escapeAttr(s) { return escapeHTML(s).replace(/"/g, '&quot;'); }

  // Filter state survives across re-renders within a session.
  var _state = { trade: '', status: 'active', search: '' };
  var _editingId = null;

  // ──────────────────────────────────────────────────────────────────
  // Directory render
  // ──────────────────────────────────────────────────────────────────

  function renderDirectory() {
    var listEl = document.getElementById('subs-list');
    var summaryEl = document.getElementById('subs-summary');
    var tradeFilterEl = document.getElementById('subs-filter-trade');
    if (!listEl) return;

    // Populate trade dropdown the first time (idempotent — only if empty)
    if (tradeFilterEl && tradeFilterEl.options.length <= 1) {
      var trades = (appData.knownTrades && appData.knownTrades.length) ? appData.knownTrades : [];
      trades.forEach(function(t) {
        if (t === 'Other') return; // skip the catch-all in filter
        var opt = document.createElement('option');
        opt.value = t; opt.textContent = t;
        tradeFilterEl.appendChild(opt);
      });
    }

    var all = appData.subsDirectory || [];
    if (!all.length) {
      // Surface migration banner if there are inline subs to migrate
      var inline = collectInlineSubs();
      var banner = document.getElementById('subs-migration-banner');
      var bannerText = document.getElementById('subs-migration-banner-text');
      if (banner && inline.length) {
        banner.style.display = 'flex';
        banner.style.alignItems = 'center';
        banner.style.gap = '12px';
        if (bannerText) bannerText.innerHTML = '<strong>' + inline.length + ' legacy sub record' + (inline.length === 1 ? '' : 's') + '</strong> from job-side entries — roll them up into the directory.';
      }
      listEl.innerHTML = '<div style="padding:30px;text-align:center;color:var(--text-dim,#888);background:var(--card-bg,#0f0f1e);border:1px dashed var(--border,#333);border-radius:10px;">' +
        '<div style="font-size:32px;margin-bottom:8px;">&#x1F477;</div>' +
        '<div style="font-weight:600;font-size:14px;margin-bottom:4px;">No subs in the directory yet</div>' +
        '<div style="font-size:12px;">Click <strong>+ New Sub</strong> to onboard one — or migrate your existing job-side sub entries.</div>' +
      '</div>';
      if (summaryEl) summaryEl.textContent = '';
      return;
    }

    // Hide migration banner if directory has data
    var banner2 = document.getElementById('subs-migration-banner');
    if (banner2) banner2.style.display = 'none';

    // Apply filters
    var filtered = all.slice();
    if (_state.trade) filtered = filtered.filter(function(s) { return (s.trade || '') === _state.trade; });
    if (_state.status) filtered = filtered.filter(function(s) { return (s.status || 'active') === _state.status; });
    if (_state.search) {
      var q = _state.search.toLowerCase();
      filtered = filtered.filter(function(s) {
        return (s.name && s.name.toLowerCase().indexOf(q) !== -1) ||
               (s.contact_name && s.contact_name.toLowerCase().indexOf(q) !== -1) ||
               (s.email && s.email.toLowerCase().indexOf(q) !== -1) ||
               (s.trade && s.trade.toLowerCase().indexOf(q) !== -1);
      });
    }

    if (summaryEl) {
      var totalContracted = filtered.reduce(function(s, sub) { return s + Number(sub.total_contracted || 0); }, 0);
      var totalActive = filtered.reduce(function(s, sub) { return s + Number(sub.active_job_count || 0); }, 0);
      summaryEl.textContent = filtered.length + ' sub' + (filtered.length === 1 ? '' : 's') +
        ' · ' + totalActive + ' active assignment' + (totalActive === 1 ? '' : 's') +
        ' · ' + fmtMoney(totalContracted) + ' total contracted';
    }

    if (!filtered.length) {
      listEl.innerHTML = '<div style="padding:20px;text-align:center;color:var(--text-dim,#888);">No subs match the current filter.</div>';
      return;
    }

    // Sort by total_contracted desc (most-active subs surface first)
    filtered.sort(function(a, b) { return Number(b.total_contracted || 0) - Number(a.total_contracted || 0); });

    listEl.innerHTML =
      '<div style="border:1px solid var(--border,#333);border-radius:10px;overflow:hidden;background:var(--card-bg,#0f0f1e);">' +
        '<table class="dense-table" style="width:100%;border-collapse:collapse;">' +
          '<thead style="background:rgba(255,255,255,0.02);border-bottom:1px solid var(--border,#333);">' +
            '<tr>' +
              th('Sub') + th('Trade') + th('Contact') +
              th('Active Jobs', 'right') + th('Total Contracted', 'right') +
              th('Compliance') + th('Status') + th('', 'right') +
            '</tr>' +
          '</thead><tbody>' +
            filtered.map(rowHTML).join('') +
          '</tbody>' +
        '</table>' +
      '</div>';
  }

  function th(label, align) {
    return '<th style="padding:8px 10px;text-align:' + (align || 'left') + ';font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;font-weight:700;">' + label + '</th>';
  }
  function td(content, opts) {
    opts = opts || {};
    var s = 'padding:6px 10px;font-size:' + (opts.size || 13) + 'px;';
    if (opts.weight) s += 'font-weight:' + opts.weight + ';';
    if (opts.color) s += 'color:' + opts.color + ';';
    else if (opts.dim) s += 'color:var(--text-dim,#aaa);';
    if (opts.align) s += 'text-align:' + opts.align + ';';
    if (opts.mono) s += "font-family:'SF Mono',Consolas,monospace;";
    return '<td style="' + s + '">' + content + '</td>';
  }

  function rowHTML(s) {
    // Compliance chips: W-9 + insurance expiry warnings
    var compliance = '';
    var today = new Date().toISOString().slice(0, 10);
    if (s.w9_on_file) {
      compliance += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(52,211,153,0.12);color:#34d399;margin-right:4px;">W-9</span>';
    } else {
      compliance += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(251,191,36,0.12);color:#fbbf24;margin-right:4px;">No W-9</span>';
    }
    if (s.insurance_expires) {
      var exp = String(s.insurance_expires).slice(0, 10);
      var color = exp < today ? '#f87171' : '#34d399';
      var label = exp < today ? 'Ins. EXPIRED' : 'Ins. ' + exp;
      compliance += '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(' + (exp < today ? '248,113,113' : '52,211,153') + ',0.12);color:' + color + ';">' + label + '</span>';
    }

    var statusChip = function(st) {
      var colors = { active: ['52,211,153', '#34d399'], paused: ['251,191,36', '#fbbf24'], closed: ['107,114,128', '#9ca3af'] };
      var c = colors[st] || colors.active;
      return '<span style="font-size:10px;padding:1px 8px;border-radius:8px;background:rgba(' + c[0] + ',0.12);color:' + c[1] + ';text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">' + (st || 'active') + '</span>';
    };

    return '<tr style="border-bottom:1px solid var(--border,#333);cursor:pointer;" onclick="window.agxSubs.openEdit(\'' + escapeAttr(s.id) + '\')">' +
      td('<strong>' + escapeHTML(s.name) + '</strong>' + (s.parent_sub_id ? ' <span style="font-size:10px;color:var(--text-dim,#888);">(child)</span>' : '')) +
      td(s.trade || '<span style="color:var(--text-dim,#666);">—</span>', { dim: !s.trade, size: 12 }) +
      td(
        (s.contact_name ? escapeHTML(s.contact_name) : '<span style="color:var(--text-dim,#666);">—</span>') +
          (s.phone || s.email ? '<div style="font-size:11px;color:var(--text-dim,#888);">' + escapeHTML([s.phone, s.email].filter(Boolean).join(' · ')) + '</div>' : ''),
        { size: 12 }
      ) +
      td(s.active_job_count || 0, { mono: true, align: 'right' }) +
      td(fmtMoney(s.total_contracted || 0), { mono: true, align: 'right', color: '#34d399' }) +
      td(compliance, { size: 11 }) +
      td(statusChip(s.status), { align: 'left' }) +
      td(
        '<button class="ee-btn-icon ghost" style="font-size:11px;padding:2px 8px;" onclick="event.stopPropagation();window.agxSubs.openEdit(\'' + escapeAttr(s.id) + '\')" title="Edit">&#x270F;</button>',
        { align: 'right' }
      ) +
    '</tr>';
  }

  // ──────────────────────────────────────────────────────────────────
  // New / edit modal
  // ──────────────────────────────────────────────────────────────────

  function openNew() {
    _editingId = null;
    showSubModal({ name: '', status: 'active' });
  }
  function openEdit(id) {
    var sub = (appData.subsDirectory || []).find(function(s) { return s.id === id; });
    if (!sub) return alert('Sub not found in directory.');
    _editingId = id;
    showSubModal(sub);
  }

  function showSubModal(sub) {
    var existing = document.getElementById('subDirModal');
    if (existing) existing.remove();
    var modal = document.createElement('div');
    modal.id = 'subDirModal';
    modal.className = 'modal active';
    modal.innerHTML = buildSubModalHTML(sub);
    document.body.appendChild(modal);

    modal.querySelector('[data-close]')?.addEventListener('click', function() { modal.remove(); });
    modal.querySelector('[data-save]')?.addEventListener('click', function() { saveFromModal(modal); });
    if (_editingId) {
      modal.querySelector('[data-delete]')?.addEventListener('click', function() { deleteFromModal(modal); });
    }
  }

  function buildSubModalHTML(sub) {
    var trades = (appData.knownTrades || []);
    var tradeOptions = '<option value="">— select trade —</option>' +
      trades.map(function(t) {
        return '<option value="' + escapeAttr(t) + '"' + (sub.trade === t ? ' selected' : '') + '>' + escapeHTML(t) + '</option>';
      }).join('');
    // If sub.trade is set but not in the curated list, surface as a custom option
    if (sub.trade && trades.indexOf(sub.trade) === -1) {
      tradeOptions += '<option value="' + escapeAttr(sub.trade) + '" selected>' + escapeHTML(sub.trade) + ' (custom)</option>';
    }

    var statusOptions = ['active', 'paused', 'closed'].map(function(st) {
      return '<option value="' + st + '"' + ((sub.status || 'active') === st ? ' selected' : '') + '>' + st + '</option>';
    }).join('');

    var input = function(id, label, value, opts) {
      opts = opts || {};
      var type = opts.type || 'text';
      return '<div style="margin-bottom:10px;">' +
        '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">' + escapeHTML(label) + '</label>' +
        '<input id="' + id + '" type="' + type + '" value="' + escapeAttr(value || '') + '" ' +
          (opts.placeholder ? 'placeholder="' + escapeAttr(opts.placeholder) + '" ' : '') +
          'style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;" />' +
      '</div>';
    };

    return '<div class="modal-content" style="max-width:560px;width:92vw;">' +
      '<div class="modal-header">' + (_editingId ? 'Edit Subcontractor' : 'New Subcontractor') + '</div>' +
      '<div style="padding:14px 18px;">' +
        input('subDir_name', 'Company name *', sub.name, { placeholder: 'e.g. Summit Sealants, Inc.' }) +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          '<div>' +
            '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">Trade</label>' +
            '<select id="subDir_trade" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;">' + tradeOptions + '</select>' +
          '</div>' +
          '<div>' +
            '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">Status</label>' +
            '<select id="subDir_status" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;">' + statusOptions + '</select>' +
          '</div>' +
        '</div>' +
        '<div id="subDir_customTradeWrap" style="margin-bottom:10px;display:none;">' +
          '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">Custom trade name</label>' +
          '<input id="subDir_customTrade" type="text" placeholder="Enter trade if Other" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;" />' +
        '</div>' +
        input('subDir_contactName', 'Contact name', sub.contact_name) +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;">' +
          input('subDir_phone', 'Phone', sub.phone, { type: 'tel' }) +
          input('subDir_email', 'Email', sub.email, { type: 'email' }) +
        '</div>' +
        input('subDir_license', 'License #', sub.license_no) +
        '<div style="display:grid;grid-template-columns:auto 1fr 1fr;gap:10px;align-items:center;margin-bottom:10px;">' +
          '<label style="display:flex;align-items:center;gap:6px;font-size:13px;color:var(--text,#e6e6e6);">' +
            '<input type="checkbox" id="subDir_w9" ' + (sub.w9_on_file ? 'checked' : '') + ' /> W-9 on file' +
          '</label>' +
          '<div>' +
            '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">W-9 expires</label>' +
            '<input id="subDir_w9expires" type="date" value="' + escapeAttr(fmtDate(sub.w9_expires)) + '" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;" />' +
          '</div>' +
          '<div>' +
            '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">Insurance expires</label>' +
            '<input id="subDir_insExpires" type="date" value="' + escapeAttr(fmtDate(sub.insurance_expires)) + '" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;" />' +
          '</div>' +
        '</div>' +
        '<div style="margin-bottom:10px;">' +
          '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;">Notes</label>' +
          '<textarea id="subDir_notes" rows="3" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;resize:vertical;">' + escapeHTML(sub.notes || '') + '</textarea>' +
        '</div>' +
      '</div>' +
      '<div class="action-buttons" style="margin:0;padding:12px 18px;border-top:1px solid var(--border,#333);">' +
        (_editingId ? '<button class="ee-btn danger" data-delete>Delete</button>' : '') +
        '<button class="ee-btn secondary" data-close style="margin-left:auto;">Cancel</button>' +
        '<button class="ee-btn primary" data-save>' + (_editingId ? 'Save' : 'Create Sub') + '</button>' +
      '</div>' +
    '</div>';
  }

  function saveFromModal(modal) {
    var trade = modal.querySelector('#subDir_trade').value;
    var customTrade = modal.querySelector('#subDir_customTrade').value;
    if (trade === 'Other' && customTrade.trim()) trade = customTrade.trim();
    var payload = {
      name: modal.querySelector('#subDir_name').value.trim(),
      trade: trade || null,
      contactName: modal.querySelector('#subDir_contactName').value.trim() || null,
      phone: modal.querySelector('#subDir_phone').value.trim() || null,
      email: modal.querySelector('#subDir_email').value.trim() || null,
      licenseNo: modal.querySelector('#subDir_license').value.trim() || null,
      w9OnFile: modal.querySelector('#subDir_w9').checked,
      w9Expires: modal.querySelector('#subDir_w9expires').value || null,
      insuranceExpires: modal.querySelector('#subDir_insExpires').value || null,
      status: modal.querySelector('#subDir_status').value || 'active',
      notes: modal.querySelector('#subDir_notes').value.trim() || null
    };
    if (!payload.name) {
      alert('Company name is required.');
      modal.querySelector('#subDir_name').focus();
      return;
    }

    var fn = _editingId
      ? window.agxApi.subs.update(_editingId, payload)
      : window.agxApi.subs.create(payload);
    fn.then(function() {
      modal.remove();
      return refresh();
    }).catch(function(err) {
      alert((_editingId ? 'Save' : 'Create') + ' failed: ' + (err.message || err));
    });
  }

  function deleteFromModal(modal) {
    if (!confirm('Delete this sub from the directory? Only allowed if it has no job assignments.')) return;
    window.agxApi.subs.remove(_editingId).then(function() {
      modal.remove();
      return refresh();
    }).catch(function(err) {
      alert('Delete failed: ' + (err.message || err));
    });
  }

  function refresh() {
    if (!window.agxApi || !window.agxApi.isAuthenticated()) {
      renderDirectory();
      return Promise.resolve();
    }
    return window.agxApi.subs.list().then(function(r) {
      appData.subsDirectory = r.subs || [];
      appData.knownTrades = r.trades || appData.knownTrades || [];
      renderDirectory();
    }).catch(function(err) {
      console.warn('[subs] refresh failed:', err && err.message);
      renderDirectory();
    });
  }

  function setFilter(key, val) {
    _state[key] = val || '';
    renderDirectory();
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase D: Migration
  // ──────────────────────────────────────────────────────────────────

  function collectInlineSubs() {
    if (!window.appData || !Array.isArray(appData.subs)) return [];
    var jobsById = {};
    (appData.jobs || []).forEach(function(j) { jobsById[j.id] = j; });
    return appData.subs
      .filter(function(s) { return s && s.name && s.name.trim(); })
      .map(function(s) {
        var job = jobsById[s.jobId] || {};
        return {
          jobId: s.jobId,
          jobNumber: job.jobNumber || null,
          jobTitle: job.title || null,
          name: s.name,
          trade: s.trade || null,
          level: s.level || 'job',
          buildingId: s.buildingId || (s.buildingIds && s.buildingIds[0]) || null,
          phaseId: s.phaseId || (s.phaseIds && s.phaseIds[0]) || null,
          contractAmt: Number(s.contractAmt || s.amount || 0),
          billedToDate: Number(s.billedToDate || 0),
          notes: s.notes || null
        };
      });
  }

  function startMigration() {
    if (!window.agxApi || !window.agxApi.isAuthenticated()) {
      alert('Sub migration requires server connection. Sign in and try again.');
      return;
    }
    var inline = collectInlineSubs();
    if (!inline.length) {
      alert('No inline sub records found to migrate.');
      return;
    }
    window.agxApi.subs.migratePreview(inline).then(function(res) {
      renderMigrationModal(res, inline);
    }).catch(function(err) {
      alert('Migration preview failed: ' + (err.message || err));
    });
  }

  function renderMigrationModal(preview, inlinePayload) {
    var existing = document.getElementById('subsMigrationModal');
    if (existing) existing.remove();

    var modal = document.createElement('div');
    modal.id = 'subsMigrationModal';
    modal.className = 'modal active';
    modal.innerHTML = buildMigrationModalHTML(preview);
    document.body.appendChild(modal);

    modal.querySelector('[data-close]')?.addEventListener('click', function() { modal.remove(); });
    modal.querySelector('[data-apply]')?.addEventListener('click', function() {
      var btn = modal.querySelector('[data-apply]');
      btn.disabled = true;
      btn.textContent = 'Migrating…';
      window.agxApi.subs.migrateApply(inlinePayload).then(function(res) {
        modal.remove();
        alert('Migration complete:\n\n' +
          '  • ' + (res.subsCreated || 0) + ' new sub' + (res.subsCreated === 1 ? '' : 's') + ' added to directory\n' +
          '  • ' + (res.subsReused || 0) + ' existing sub' + (res.subsReused === 1 ? '' : 's') + ' reused\n' +
          '  • ' + (res.assignmentsCreated || 0) + ' job assignment' + (res.assignmentsCreated === 1 ? '' : 's') + ' written\n' +
          (res.assignmentsSkipped > 0 ? '  • ' + res.assignmentsSkipped + ' skipped (missing job or duplicate)\n' : ''));
        refresh();
      }).catch(function(err) {
        btn.disabled = false;
        btn.textContent = 'Apply migration';
        alert('Migration failed: ' + (err.message || err));
      });
    });
  }

  function buildMigrationModalHTML(preview) {
    var newCount = preview.uniqueSubs - preview.existingMatches;
    var headStat = function(label, value, color) {
      return '<div style="background:var(--card-bg,#0f0f1e);border:1px solid var(--border,#333);border-radius:8px;padding:8px 12px;">' +
        '<div style="font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;margin-bottom:3px;">' + label + '</div>' +
        '<div style="font-size:18px;font-weight:700;color:' + color + ';">' + value + '</div>' +
      '</div>';
    };

    var rowsHTML = preview.preview.map(function(p) {
      var alreadyChip = p.existingSubId
        ? '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(79,140,255,0.15);color:#4f8cff;">already in directory</span>'
        : '<span style="font-size:10px;padding:1px 6px;border-radius:8px;background:rgba(52,211,153,0.15);color:#34d399;">will create</span>';
      var jobsList = (p.jobs || []).filter(Boolean).slice(0, 4).join(', ');
      if ((p.jobs || []).length > 4) jobsList += ', +' + ((p.jobs || []).length - 4) + ' more';
      return '<tr style="border-bottom:1px solid var(--border,#333);">' +
        '<td style="padding:6px 10px;font-weight:600;">' + escapeHTML(p.name) + '</td>' +
        '<td style="padding:6px 10px;">' + alreadyChip + '</td>' +
        '<td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;">' + p.recordCount + '</td>' +
        '<td style="padding:6px 10px;text-align:right;font-family:monospace;font-size:12px;color:#34d399;">' + fmtMoney(p.totalContractAmt) + '</td>' +
        '<td style="padding:6px 10px;font-size:12px;color:var(--text-dim,#aaa);">' + escapeHTML(jobsList) + '</td>' +
      '</tr>';
    }).join('');

    return '<div class="modal-content" style="max-width:780px;width:92vw;">' +
      '<div class="modal-header">Migrate Subcontractors to Directory</div>' +
      '<div style="padding:14px 18px;">' +
        '<p style="margin-bottom:12px;color:var(--text-dim,#aaa);font-size:13px;">' +
          'Preview before applying. Subs are deduped by name (case-insensitive). Each unique name becomes one directory record; ' +
          'every per-job inline entry becomes a job assignment under that record. Subs already in the directory are reused, not duplicated.' +
        '</p>' +
        '<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin-bottom:14px;">' +
          headStat('Inline records', preview.totalInline, '#4f8cff') +
          headStat('Unique subs', preview.uniqueSubs, '#a78bfa') +
          headStat('New to directory', newCount, '#34d399') +
          headStat('Reuse existing', preview.existingMatches, '#fbbf24') +
        '</div>' +
        '<div style="border:1px solid var(--border,#333);border-radius:8px;overflow:hidden;background:var(--card-bg,#0f0f1e);max-height:50vh;overflow-y:auto;">' +
          '<table style="width:100%;border-collapse:collapse;">' +
            '<thead style="background:rgba(255,255,255,0.02);position:sticky;top:0;z-index:1;">' +
              '<tr>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Sub Name</th>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Action</th>' +
                '<th style="padding:8px 10px;text-align:right;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Records</th>' +
                '<th style="padding:8px 10px;text-align:right;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Total $</th>' +
                '<th style="padding:8px 10px;text-align:left;font-size:10px;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.5px;">Jobs</th>' +
              '</tr>' +
            '</thead>' +
            '<tbody>' + rowsHTML + '</tbody>' +
          '</table>' +
        '</div>' +
      '</div>' +
      '<div class="action-buttons" style="margin:0;padding:12px 18px;border-top:1px solid var(--border,#333);">' +
        '<button class="ee-btn secondary" data-close style="margin-left:auto;">Cancel</button>' +
        '<button class="ee-btn primary" data-apply>Apply migration</button>' +
      '</div>' +
    '</div>';
  }

  // ──────────────────────────────────────────────────────────────────
  // Public API
  // ──────────────────────────────────────────────────────────────────
  window.agxSubs = {
    render: renderDirectory,
    refresh: refresh,
    openNew: openNew,
    openEdit: openEdit,
    setFilter: setFilter,
    startMigration: startMigration,
    collectInlineSubs: collectInlineSubs
  };
  window.renderSubsDirectory = renderDirectory;
})();
