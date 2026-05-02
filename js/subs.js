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

    // Activation status segmented control — three buttons, click sets
    // the hidden #subDir_status input + visually swaps the active fill
    // to the clicked one. Save reads the hidden input on submit.
    modal.querySelectorAll('[data-status-btn]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var v = btn.getAttribute('data-status-btn');
        var hidden = modal.querySelector('#subDir_status');
        if (hidden) hidden.value = v;
        modal.querySelectorAll('[data-status-btn]').forEach(function(b) {
          var on = b === btn;
          b.style.background = on ? '#1B8541' : 'transparent';
          b.style.color = on ? '#fff' : 'var(--text-dim,#aaa)';
          b.style.borderColor = on ? 'transparent' : 'var(--border,#333)';
        });
      });
    });

    // Tabbed lower section — Additional info / Notifications / Job access.
    // The active tab gets the green underline + bright text; siblings
    // dim down. Hidden panes get display:none so their inputs don't
    // submit values from un-shown tabs (defensive — Phase 1A only writes
    // from Additional info, but the structure is ready for 1B/1C panes).
    modal.querySelectorAll('[data-sub-tab]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = btn.getAttribute('data-sub-tab');
        modal.querySelectorAll('[data-sub-tab]').forEach(function(b) {
          var on = b === btn;
          b.style.borderBottomColor = on ? '#1B8541' : 'transparent';
          b.style.color = on ? '#1B8541' : 'var(--text-dim,#aaa)';
        });
        modal.querySelectorAll('[data-sub-tab-pane]').forEach(function(pane) {
          pane.style.display = (pane.getAttribute('data-sub-tab-pane') === name) ? '' : 'none';
        });
      });
    });

    // "Hold payments" pref shadows the hidden #subDir_paymentHold so save
    // sees the latest checkbox state. Mirroring keeps the JSONB
    // preferences blob and the dedicated payment_hold column in sync.
    var holdCb = modal.querySelector('[data-pref="hold_payments"]');
    var holdHidden = modal.querySelector('#subDir_paymentHold');
    if (holdCb && holdHidden) {
      holdCb.addEventListener('change', function() {
        holdHidden.value = holdCb.checked ? '1' : '0';
      });
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Modal layout — Buildertrend-style sub/vendor record (Phase 1A).
  //
  // Header:        Company name + close
  // Sub-header:    Activation status row (Active / Paused / Closed)
  // Body:          Contact information (always visible) + tabbed lower
  //                section.
  // Tabs:          Additional information | Notifications | Job access
  //
  // Phase 1A delivers Contact info + Additional info (Preferences,
  // Notes, Default payment email). Certificates / Notifications matrix
  // / Job access are stubbed with "Phase 1B/1C" placeholders so the
  // visual layout matches the user's reference screenshots while the
  // backing systems land in follow-up commits.
  //
  // Skipped per request: Accounting + Trade agreement tabs.
  // ──────────────────────────────────────────────────────────────────
  function buildSubModalHTML(sub) {
    var trades = (appData.knownTrades || []);
    var tradeOptions = '<option value="">— select trade —</option>' +
      trades.map(function(t) {
        return '<option value="' + escapeAttr(t) + '"' + (sub.trade === t ? ' selected' : '') + '>' + escapeHTML(t) + '</option>';
      }).join('');
    if (sub.trade && trades.indexOf(sub.trade) === -1) {
      tradeOptions += '<option value="' + escapeAttr(sub.trade) + '" selected>' + escapeHTML(sub.trade) + ' (custom)</option>';
    }

    // Resolve preferences JSONB into individual checkbox states. Default
    // everything off so a brand-new sub doesn't auto-grant permissions.
    var prefs = sub.preferences || {};
    var prefRow = function(key, label) {
      var checked = prefs[key] ? 'checked' : '';
      return '<label class="agx-check-row" style="display:flex;align-items:center;gap:8px;font-size:13px;color:var(--text,#e6e6e6);padding:6px 0;">' +
        '<input type="checkbox" data-pref="' + key + '" ' + checked + ' style="margin:0;width:auto;flex:0 0 auto;" /> ' +
        escapeHTML(label) +
      '</label>';
    };

    // Single field renderer (label + input). Used heavily in the contact-
    // info grid below; lets the whole grid stay in markup-string form
    // rather than DOM building.
    var input = function(id, label, value, opts) {
      opts = opts || {};
      var type = opts.type || 'text';
      return '<div>' +
        '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">' + escapeHTML(label) + '</label>' +
        '<input id="' + id + '" type="' + type + '" value="' + escapeAttr(value || '') + '" ' +
          (opts.placeholder ? 'placeholder="' + escapeAttr(opts.placeholder) + '" ' : '') +
          'style="width:100%;padding:6px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;line-height:1.35;" />' +
      '</div>';
    };

    // Activation status segmented control. Three buttons: Active /
    // Paused / Closed. The active one gets the primary fill so it reads
    // as a state, not just a select.
    var statusBtn = function(value, label) {
      var isActive = (sub.status || 'active') === value;
      return '<button type="button" data-status-btn="' + value + '" ' +
        'class="' + (isActive ? 'sub-status-on' : 'sub-status-off') + '" ' +
        'style="padding:5px 14px;font-size:12px;font-weight:600;border-radius:6px;border:1px solid ' +
        (isActive ? 'transparent' : 'var(--border,#333)') + ';' +
        'background:' + (isActive ? '#1B8541' : 'transparent') + ';' +
        'color:' + (isActive ? '#fff' : 'var(--text-dim,#aaa)') + ';' +
        'cursor:pointer;">' + escapeHTML(label) + '</button>';
    };

    return '<div class="modal-content" style="max-width:920px;width:96vw;max-height:92vh;overflow-y:auto;padding:0;">' +
      // ── Header ───────────────────────────────────────────────────
      '<div style="padding:14px 22px;border-bottom:1px solid var(--border,#333);display:flex;align-items:center;gap:10px;">' +
        '<div style="font-size:18px;font-weight:700;color:var(--text,#fff);flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' +
          escapeHTML(sub.name || (_editingId ? 'Edit Subcontractor' : 'New Subcontractor')) +
        '</div>' +
        '<button type="button" data-close style="background:transparent;border:none;color:var(--text-dim,#888);font-size:22px;cursor:pointer;padding:0 4px;line-height:1;">&times;</button>' +
      '</div>' +
      // ── Activation status row ────────────────────────────────────
      '<div style="padding:10px 22px;border-bottom:1px solid var(--border,#333);background:rgba(79,140,255,0.04);display:flex;align-items:center;gap:10px;">' +
        '<span style="font-size:12px;color:var(--text-dim,#aaa);font-weight:600;">Activation status:</span>' +
        '<div style="display:flex;gap:4px;">' +
          statusBtn('active', 'Active') +
          statusBtn('paused', 'Paused') +
          statusBtn('closed', 'Closed') +
        '</div>' +
      '</div>' +
      // ── Contact information ──────────────────────────────────────
      '<div style="padding:18px 22px;border-bottom:1px solid var(--border,#333);">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:12px;">Contact information</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px 18px;">' +
          input('subDir_name', 'Company name *', sub.name, { placeholder: 'e.g. Summit Sealants, Inc.' }) +
          // Trade dropdown — uses the curated list with selected sticky
          '<div>' +
            '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Division / Trade</label>' +
            '<select id="subDir_trade" style="width:100%;padding:6px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;line-height:1.35;">' + tradeOptions + '</select>' +
          '</div>' +
          input('subDir_primaryFirst', 'Primary contact (first)', sub.primary_contact_first || '') +
          input('subDir_primaryLast',  'Primary contact (last)',  sub.primary_contact_last  || '') +
          input('subDir_businessPhone', 'Business phone', sub.business_phone || sub.phone || '', { type: 'tel' }) +
          input('subDir_fax', 'Fax', sub.fax || '', { type: 'tel' }) +
          input('subDir_cellPhone', 'Cell phone', sub.cell_phone || '', { type: 'tel' }) +
          input('subDir_email', 'Email', sub.email || '', { type: 'email' }) +
          input('subDir_streetAddress', 'Street address', sub.street_address || '') +
          input('subDir_city', 'City', sub.city || '') +
        '</div>' +
        // State + Zip (smaller side-by-side row)
        '<div style="display:grid;grid-template-columns:1fr 1fr 2fr;gap:14px 18px;margin-top:14px;">' +
          input('subDir_state', 'State', sub.state || '', { placeholder: 'FL' }) +
          input('subDir_zip', 'Zip', sub.zip || '') +
          input('subDir_license', 'License #', sub.license_no || '') +
        '</div>' +
      '</div>' +
      // ── Tab nav ──────────────────────────────────────────────────
      '<div style="border-bottom:1px solid var(--border,#333);padding:0 22px;display:flex;gap:4px;">' +
        '<button type="button" data-sub-tab="additional" class="sub-tab-btn sub-tab-active" style="padding:10px 14px;background:transparent;border:none;border-bottom:2px solid #1B8541;color:#1B8541;font-size:13px;font-weight:600;cursor:pointer;">Additional information</button>' +
        '<button type="button" data-sub-tab="notifications" class="sub-tab-btn" style="padding:10px 14px;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text-dim,#aaa);font-size:13px;font-weight:600;cursor:pointer;">Notifications</button>' +
        '<button type="button" data-sub-tab="jobs" class="sub-tab-btn" style="padding:10px 14px;background:transparent;border:none;border-bottom:2px solid transparent;color:var(--text-dim,#aaa);font-size:13px;font-weight:600;cursor:pointer;">Job access</button>' +
      '</div>' +
      // ── Tab: Additional information ──────────────────────────────
      '<div data-sub-tab-pane="additional" style="padding:18px 22px;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:8px;">Preferences</div>' +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:0 24px;margin-bottom:14px;">' +
          prefRow('view_client_info',     'View client information') +
          prefRow('auto_permit_new_jobs', 'Automatically permit access to new jobs') +
          prefRow('share_documents',      'Share documents with client') +
          prefRow('assign_rfis',          'Assign RFIs to other subs/vendors') +
          prefRow('hold_payments',        'Hold payments to the sub/vendor') +
        '</div>' +
        // Notes
        '<div style="margin-bottom:14px;">' +
          '<label style="display:block;font-size:11px;color:var(--text-dim,#aaa);margin-bottom:3px;text-transform:uppercase;letter-spacing:0.4px;font-weight:600;">Notes</label>' +
          '<textarea id="subDir_notes" rows="3" style="width:100%;padding:7px 10px;border:1px solid var(--border,#333);border-radius:6px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:13px;resize:vertical;">' + escapeHTML(sub.notes || '') + '</textarea>' +
        '</div>' +
        // Default payment email
        '<div style="margin-bottom:14px;">' +
          input('subDir_paymentEmail', 'Default payment email address', sub.payment_email || '', { type: 'email', placeholder: 'payments@example.com' }) +
        '</div>' +
        // ── Certificates section (Phase 1B stub — visual layout only)
        '<div style="margin-top:22px;padding-top:16px;border-top:1px dashed var(--border,#333);">' +
          '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:6px;">Certificates</div>' +
          '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:10px;font-style:italic;">' +
            'PDF upload + expiration tracking + reminder schedule lands in Phase 1B. Layout shown for reference.' +
          '</div>' +
          ['General liability certificate', "Worker's comp certificate", 'W-9', 'Bank Information'].map(function(certLabel) {
            return '<div style="display:grid;grid-template-columns:2fr 1fr 1fr 1fr;gap:10px;align-items:end;padding:8px 0;border-top:1px solid var(--border,#333);opacity:0.55;">' +
              '<div>' +
                '<div style="font-size:12px;font-weight:600;color:var(--text,#e6e6e6);margin-bottom:4px;">' + escapeHTML(certLabel) + '</div>' +
                '<button type="button" disabled style="padding:5px 12px;font-size:11px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text-dim,#888);">⬆ Upload</button>' +
              '</div>' +
              '<div>' +
                '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Expiration date</label>' +
                '<input type="date" disabled style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text-dim,#666);font-size:12px;" />' +
              '</div>' +
              '<div>' +
                '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Reminder (days)</label>' +
                '<input type="number" disabled value="30" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text-dim,#666);font-size:12px;" />' +
              '</div>' +
              '<div>' +
                '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Reminder limit</label>' +
                '<input type="number" disabled value="5" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text-dim,#666);font-size:12px;" />' +
              '</div>' +
            '</div>';
          }).join('') +
        '</div>' +
      '</div>' +
      // ── Tab: Notifications (Phase 1C stub) ───────────────────────
      '<div data-sub-tab-pane="notifications" style="padding:24px 22px;display:none;">' +
        '<div style="text-align:center;padding:40px 20px;color:var(--text-dim,#888);font-size:13px;">' +
          '<div style="font-size:24px;margin-bottom:8px;">&#x1F4EC;</div>' +
          '<div style="font-weight:600;color:var(--text,#fff);margin-bottom:4px;">Per-sub notification matrix</div>' +
          '<div>Email / Text / Push toggles for Project management, Messaging, Financial, and Administrative events. Lands in Phase 1C.</div>' +
        '</div>' +
      '</div>' +
      // ── Tab: Job access (Phase 1C stub) ──────────────────────────
      '<div data-sub-tab-pane="jobs" style="padding:24px 22px;display:none;">' +
        '<div style="text-align:center;padding:40px 20px;color:var(--text-dim,#888);font-size:13px;">' +
          '<div style="font-size:24px;margin-bottom:8px;">&#x1F4CB;</div>' +
          '<div style="font-weight:600;color:var(--text,#fff);margin-bottom:4px;">Per-sub job access list</div>' +
          '<div>Toggle this sub on/off for each open job. Backed by the existing job_subs table — UI lands in Phase 1C.</div>' +
        '</div>' +
      '</div>' +
      // ── Footer ───────────────────────────────────────────────────
      '<div style="padding:12px 22px;border-top:1px solid var(--border,#333);display:flex;align-items:center;gap:8px;">' +
        (_editingId ? '<button class="ee-btn danger" data-delete style="padding:6px 14px;">Delete</button>' : '') +
        '<button class="ee-btn secondary" data-close style="margin-left:auto;padding:6px 14px;">Cancel</button>' +
        '<button class="ee-btn primary" data-save style="padding:6px 18px;">' + (_editingId ? 'Save' : 'Create Sub') + '</button>' +
      '</div>' +

      // Hidden carriers — w9_on_file + expiration dates kept in the
      // payload until Phase 1B replaces them with the cert-table flow.
      '<input type="hidden" id="subDir_status" value="' + escapeAttr(sub.status || 'active') + '" />' +
      '<input type="hidden" id="subDir_w9" value="' + (sub.w9_on_file ? '1' : '0') + '" />' +
      '<input type="hidden" id="subDir_w9expires" value="' + escapeAttr(fmtDate(sub.w9_expires)) + '" />' +
      '<input type="hidden" id="subDir_insExpires" value="' + escapeAttr(fmtDate(sub.insurance_expires)) + '" />' +
      '<input type="hidden" id="subDir_paymentHold" value="' + (prefs.hold_payments ? '1' : '0') + '" />' +
    '</div>';
  }

  function saveFromModal(modal) {
    var get = function(id) {
      var el = modal.querySelector('#' + id);
      return el ? (el.value || '') : '';
    };
    var trim = function(v) { return (v || '').trim() || null; };

    // Trade — the curated dropdown is the only path now (the legacy
    // "custom trade" override field was dropped in the layout rewrite;
    // adding a freeform trade can be done by editing the curated list
    // server-side).
    var trade = get('subDir_trade') || null;

    // Build the preferences JSONB from the checkboxes inside the
    // Additional info tab. Each one is keyed by `data-pref="<key>"`.
    var prefs = {};
    modal.querySelectorAll('[data-pref]').forEach(function(cb) {
      prefs[cb.getAttribute('data-pref')] = !!cb.checked;
    });

    // primary_contact_first/last form the new authoritative contact
    // name fields. We also write the joined value to legacy contact_name
    // for older callers (estimate editor read paths, exports) until
    // those are migrated to read first/last directly.
    var pcFirst = trim(get('subDir_primaryFirst'));
    var pcLast  = trim(get('subDir_primaryLast'));
    var combined = [pcFirst, pcLast].filter(Boolean).join(' ');

    var payload = {
      name: trim(get('subDir_name')),
      trade: trade,
      // Contact info — new fields
      primaryContactFirst: pcFirst,
      primaryContactLast:  pcLast,
      contactName: combined || null,
      businessPhone: trim(get('subDir_businessPhone')),
      cellPhone:     trim(get('subDir_cellPhone')),
      fax:           trim(get('subDir_fax')),
      // Legacy phone column gets the business phone so the directory
      // list view (which still reads sub.phone) stays populated.
      phone: trim(get('subDir_businessPhone')) || trim(get('subDir_cellPhone')),
      email: trim(get('subDir_email')),
      streetAddress: trim(get('subDir_streetAddress')),
      city:  trim(get('subDir_city')),
      state: trim(get('subDir_state')),
      zip:   trim(get('subDir_zip')),
      licenseNo: trim(get('subDir_license')),
      // Additional info
      paymentEmail: trim(get('subDir_paymentEmail')),
      paymentHold:  get('subDir_paymentHold') === '1',
      preferences:  prefs,
      notes: trim(get('subDir_notes')),
      // Carry-over fields (Phase 1B replaces these with the certificates
      // sub-table; for now they ride along on the directory record).
      w9OnFile: get('subDir_w9') === '1',
      w9Expires: get('subDir_w9expires') || null,
      insuranceExpires: get('subDir_insExpires') || null,
      status: get('subDir_status') || 'active'
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
