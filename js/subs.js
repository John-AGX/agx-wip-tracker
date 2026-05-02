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
    // Toggles the `active` class so the unified .sub-modal-tab.active
    // CSS rule (in styles.css) handles the green text + glowing
    // underline. Hidden panes get display:none so their inputs don't
    // submit values from un-shown tabs (defensive — the cert
    // auto-saves and notif-prefs hidden carrier all live in
    // Additional info, but keeping panes truly hidden is the safer
    // posture).
    modal.querySelectorAll('[data-sub-tab]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var name = btn.getAttribute('data-sub-tab');
        modal.querySelectorAll('[data-sub-tab]').forEach(function(b) {
          b.classList.toggle('active', b === btn);
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

    // Certificates pane — only mount if we have a saved sub to attach
    // PDFs to. New subs see the "save first" message; once they save
    // and re-open the modal, the cert rows render.
    var certsMount = modal.querySelector('#subDir_certsMount');
    if (certsMount && _editingId) {
      mountCertificates(certsMount, _editingId);
    }

    // Notifications matrix — wire master/cell toggles and per-change
    // serialization to the hidden #subDir_notifPrefs input. Wired
    // unconditionally (works for new + edit); saveFromModal sends the
    // prefs JSON to the server with the rest of the payload.
    wireNotifMatrix(modal);

    // Job access — same gating as Certificates: needs a saved sub id
    // before we can list assignments / toggle them.
    var jobAccessMount = modal.querySelector('#subDir_jobAccessMount');
    if (jobAccessMount && _editingId) {
      mountJobAccess(jobAccessMount, _editingId);
    }
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 1B: Certificates (GL / WC / W-9 / Bank info)
  // ──────────────────────────────────────────────────────────────────

  // Cert types — order drives row order in the modal.
  var CERT_TYPES = [
    { key: 'gl',   label: 'General liability certificate' },
    { key: 'wc',   label: "Worker's comp certificate" },
    { key: 'w9',   label: 'W-9' },
    { key: 'bank', label: 'Bank Information' }
  ];

  function mountCertificates(mountEl, subId) {
    mountEl.innerHTML = '<div style="padding:12px;color:var(--text-dim,#888);font-size:12px;">Loading certificates…</div>';
    if (!window.agxApi || !window.agxApi.subs || !window.agxApi.subs.certs) {
      mountEl.innerHTML = '<div style="padding:12px;color:#f87171;font-size:12px;">Cert API not available — refresh the page.</div>';
      return;
    }
    window.agxApi.subs.certs.list(subId).then(function(res) {
      var byType = {};
      (res.certificates || []).forEach(function(c) { byType[c.cert_type] = c; });
      mountEl.innerHTML = CERT_TYPES.map(function(t) {
        return certRowHTML(t, byType[t.key]);
      }).join('');
      wireCertRows(mountEl, subId);
    }).catch(function(err) {
      mountEl.innerHTML = '<div style="padding:12px;color:#f87171;font-size:12px;">Failed to load certs: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  // One row's HTML. cert may be undefined for an empty slot.
  function certRowHTML(type, cert) {
    var hasFile = !!(cert && cert.attachment_id);
    var fileLabel = hasFile
      ? (cert.attachment_filename || 'cert.pdf')
      : '';
    var fileLink = hasFile && cert.attachment_url
      ? '<a href="' + escapeAttr(cert.attachment_url) + '" target="_blank" style="font-size:11px;color:#4f8cff;text-decoration:none;">📎 ' + escapeHTML(fileLabel) + '</a>'
      : (hasFile ? '<span style="font-size:11px;color:#4f8cff;">📎 ' + escapeHTML(fileLabel) + '</span>' : '<span style="font-size:11px;color:var(--text-dim,#888);">No file uploaded</span>');
    var expVal = cert && cert.expiration_date ? String(cert.expiration_date).slice(0, 10) : '';
    var rDays  = cert && cert.reminder_days != null ? cert.reminder_days : 30;
    var rDir   = cert && cert.reminder_direction ? cert.reminder_direction : 'before';
    var rLimit = cert && cert.reminder_limit != null ? cert.reminder_limit : 5;
    var dirOptions =
      '<option value="before"' + (rDir === 'before' ? ' selected' : '') + '>before</option>' +
      '<option value="after"'  + (rDir === 'after'  ? ' selected' : '') + '>after</option>';
    return '<div data-cert-row="' + type.key + '" style="display:grid;grid-template-columns:2.2fr 1fr 1.1fr 1fr 1fr auto;gap:10px;align-items:end;padding:10px 0;border-top:1px solid var(--border,#333);">' +
      // Col 1: type label + upload + filename
      '<div style="min-width:0;">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text,#e6e6e6);margin-bottom:4px;">' + escapeHTML(type.label) + '</div>' +
        '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">' +
          '<button type="button" data-cert-upload="' + type.key + '" style="padding:5px 12px;font-size:11px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);cursor:pointer;">⬆ ' + (hasFile ? 'Replace' : 'Upload') + '</button>' +
          '<input type="file" data-cert-file="' + type.key + '" accept="application/pdf,image/*" style="display:none;" />' +
          '<span data-cert-status="' + type.key + '" style="font-size:11px;min-width:0;overflow:hidden;text-overflow:ellipsis;">' + fileLink + '</span>' +
        '</div>' +
      '</div>' +
      // Col 2: expiration date
      '<div>' +
        '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Expiration date</label>' +
        '<input type="date" data-cert-field="expiration_date" data-cert-key="' + type.key + '" value="' + escapeAttr(expVal) + '" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:12px;" />' +
      '</div>' +
      // Col 3: reminder days
      '<div>' +
        '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Reminder (days)</label>' +
        '<input type="number" min="0" data-cert-field="reminder_days" data-cert-key="' + type.key + '" value="' + escapeAttr(String(rDays)) + '" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:12px;" />' +
      '</div>' +
      // Col 4: direction
      '<div>' +
        '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Direction</label>' +
        '<select data-cert-field="reminder_direction" data-cert-key="' + type.key + '" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:12px;">' + dirOptions + '</select>' +
      '</div>' +
      // Col 5: reminder limit
      '<div>' +
        '<label style="display:block;font-size:10px;color:var(--text-dim,#888);margin-bottom:2px;">Reminder limit</label>' +
        '<input type="number" min="0" data-cert-field="reminder_limit" data-cert-key="' + type.key + '" value="' + escapeAttr(String(rLimit)) + '" style="width:100%;padding:5px 8px;border:1px solid var(--border,#333);border-radius:5px;background:var(--card-bg,#0f0f1e);color:var(--text,#fff);font-size:12px;" />' +
      '</div>' +
      // Col 6: × remove (only when a file is uploaded)
      '<div style="align-self:end;padding-bottom:5px;">' +
        (hasFile
          ? '<button type="button" data-cert-remove="' + type.key + '" title="Remove this certificate" style="padding:5px 9px;font-size:13px;border:1px solid var(--border,#333);border-radius:5px;background:transparent;color:#f87171;cursor:pointer;">&times;</button>'
          : '<span></span>') +
      '</div>' +
    '</div>';
  }

  // Wire all the cert-row interactions: Upload / Replace, Remove, and
  // debounced auto-save on date / reminder field changes.
  function wireCertRows(rootEl, subId) {
    // Upload + Replace — clicking the button triggers the matching
    // hidden file input. The file picker change handler does the
    // attachment upload + cert upsert in one flow.
    rootEl.querySelectorAll('[data-cert-upload]').forEach(function(btn) {
      var key = btn.getAttribute('data-cert-upload');
      var fileInput = rootEl.querySelector('[data-cert-file="' + key + '"]');
      if (!fileInput) return;
      btn.addEventListener('click', function() {
        fileInput.value = '';
        fileInput.click();
      });
      fileInput.addEventListener('change', function(e) {
        if (!e.target.files || !e.target.files[0]) return;
        uploadCert(rootEl, subId, key, e.target.files[0]);
      });
    });

    // Remove — DELETE the cert row + its attachment, then re-mount the
    // section so the row resets to its empty state.
    rootEl.querySelectorAll('[data-cert-remove]').forEach(function(btn) {
      btn.addEventListener('click', function() {
        var key = btn.getAttribute('data-cert-remove');
        if (!confirm('Remove this certificate?')) return;
        window.agxApi.subs.certs.remove(subId, key).then(function() {
          mountCertificates(rootEl, subId);
        }).catch(function(err) {
          alert('Remove failed: ' + (err.message || String(err)));
        });
      });
    });

    // Field changes — date / reminder fields. Debounced PATCH so the
    // user can edit smoothly. We send only the field that changed
    // (PATCH route accepts partial updates). If the cert doesn't yet
    // exist on the server (file uploaded but row never created — edge
    // case), the PATCH 404s and we fall back to a full upsert.
    var debouncers = {};
    rootEl.querySelectorAll('[data-cert-field]').forEach(function(el) {
      el.addEventListener('change', function() {
        var key = el.getAttribute('data-cert-key');
        var field = el.getAttribute('data-cert-field');
        var val = el.value;
        var coerced = (field === 'reminder_days' || field === 'reminder_limit')
          ? (val === '' ? null : Number(val))
          : (val === '' ? null : val);
        clearTimeout(debouncers[key + '|' + field]);
        debouncers[key + '|' + field] = setTimeout(function() {
          var payload = {};
          payload[field] = coerced;
          window.agxApi.subs.certs.patch(subId, key, payload).catch(function(err) {
            // Fallback: upsert with all fields if PATCH says the row
            // doesn't exist yet.
            if (err && /not found/i.test(err.message || '')) {
              var row = rootEl.querySelector('[data-cert-row="' + key + '"]');
              if (!row) return;
              var full = { cert_type: key };
              row.querySelectorAll('[data-cert-field]').forEach(function(inp) {
                var f = inp.getAttribute('data-cert-field');
                var v = inp.value;
                full[f] = (f === 'reminder_days' || f === 'reminder_limit')
                  ? (v === '' ? null : Number(v))
                  : (v === '' ? null : v);
              });
              window.agxApi.subs.certs.upsert(subId, full).catch(function(e2) {
                console.warn('Cert upsert fallback failed:', e2.message);
              });
            } else {
              console.warn('Cert PATCH failed:', err.message);
            }
          });
        }, 400);
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 1C: Notifications matrix
  // ──────────────────────────────────────────────────────────────────

  // Event categories (rows) and channels (cols). Order drives visual
  // order. Keys are persisted to the JSONB column so the row labels
  // can be renamed without losing user prefs.
  var NOTIF_CATEGORIES = [
    { key: 'pm',             label: 'Project management' },
    { key: 'messaging',      label: 'Messaging' },
    { key: 'financial',      label: 'Financial' },
    { key: 'administrative', label: 'Administrative' }
  ];
  var NOTIF_CHANNELS = [
    { key: 'email', label: 'Email',  glyph: '&#x2709;' },
    { key: 'text',  label: 'Text',   glyph: '&#x1F4AC;' },
    { key: 'push',  label: 'Push',   glyph: '&#x1F4F1;' }
  ];

  function getNotifPref(prefs, catKey, chKey) {
    if (!prefs || !prefs[catKey]) return false;
    return !!prefs[catKey][chKey];
  }

  function renderNotifMatrix(prefs) {
    // Header row — channel labels.
    var header = '<div style="display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:8px;align-items:center;padding-bottom:8px;border-bottom:1px solid var(--border,#333);">' +
      '<div></div>' +
      NOTIF_CHANNELS.map(function(ch) {
        return '<div style="font-size:11px;font-weight:700;color:var(--text-dim,#aaa);text-align:center;">' + ch.glyph + ' ' + escapeHTML(ch.label) + '</div>';
      }).join('') +
      '</div>';
    // Master "All notifications" row — bulk toggle per column.
    var masterRow = '<div style="display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:8px;align-items:center;padding:10px 0;border-bottom:1px solid var(--border,#333);">' +
      '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);">All notifications</div>' +
      NOTIF_CHANNELS.map(function(ch) {
        // Master is computed: checked if EVERY category is on for this channel.
        var allOn = NOTIF_CATEGORIES.every(function(c) { return getNotifPref(prefs, c.key, ch.key); });
        return '<div style="text-align:center;"><input type="checkbox" data-notif-master="' + ch.key + '" ' + (allOn ? 'checked' : '') + ' style="margin:0;width:18px;height:18px;cursor:pointer;" /></div>';
      }).join('') +
      '</div>';
    // One row per category, columns = channels.
    var catRows = NOTIF_CATEGORIES.map(function(cat) {
      return '<div style="display:grid;grid-template-columns:1.6fr 1fr 1fr 1fr;gap:8px;align-items:center;padding:8px 0;border-bottom:1px solid var(--border,#333);">' +
        '<div style="font-size:12px;font-weight:600;color:var(--text-dim,#bbb);text-transform:uppercase;letter-spacing:0.4px;">' + escapeHTML(cat.label) + '</div>' +
        NOTIF_CHANNELS.map(function(ch) {
          var on = getNotifPref(prefs, cat.key, ch.key);
          return '<div style="text-align:center;"><input type="checkbox" data-notif-cell data-notif-cat="' + cat.key + '" data-notif-ch="' + ch.key + '" ' + (on ? 'checked' : '') + ' style="margin:0;width:18px;height:18px;cursor:pointer;" /></div>';
        }).join('') +
      '</div>';
    }).join('');
    return header + masterRow + catRows;
  }

  // Wire the matrix's cell + master toggles. Master rows bulk-set every
  // category cell in their column; cell changes recompute the master
  // for that column. After every change we serialize the matrix back
  // to the hidden #subDir_notifPrefs input so saveFromModal picks up
  // the latest state.
  function wireNotifMatrix(modal) {
    function readMatrix() {
      var prefs = {};
      modal.querySelectorAll('[data-notif-cell]').forEach(function(cb) {
        var c = cb.getAttribute('data-notif-cat');
        var h = cb.getAttribute('data-notif-ch');
        if (!prefs[c]) prefs[c] = {};
        prefs[c][h] = !!cb.checked;
      });
      return prefs;
    }
    function syncMaster(chKey) {
      var allOn = true;
      modal.querySelectorAll('[data-notif-cell][data-notif-ch="' + chKey + '"]').forEach(function(cb) {
        if (!cb.checked) allOn = false;
      });
      var master = modal.querySelector('[data-notif-master="' + chKey + '"]');
      if (master) master.checked = allOn;
    }
    function persist() {
      var hidden = modal.querySelector('#subDir_notifPrefs');
      if (hidden) hidden.value = JSON.stringify(readMatrix());
    }
    modal.querySelectorAll('[data-notif-cell]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        syncMaster(cb.getAttribute('data-notif-ch'));
        persist();
      });
    });
    modal.querySelectorAll('[data-notif-master]').forEach(function(cb) {
      cb.addEventListener('change', function() {
        var ch = cb.getAttribute('data-notif-master');
        var on = cb.checked;
        modal.querySelectorAll('[data-notif-cell][data-notif-ch="' + ch + '"]').forEach(function(cell) {
          cell.checked = on;
        });
        persist();
      });
    });
  }

  // ──────────────────────────────────────────────────────────────────
  // Phase 1C: Job access
  // ──────────────────────────────────────────────────────────────────

  // Mount the job-access pane. Loads all jobs + this sub's current
  // assignments, renders one row per job with a checkbox prechecked
  // when assigned. Toggling fires an immediate POST/DELETE — no Save
  // round-trip, since access changes are sensitive enough to want
  // confirmation by checkbox state right away.
  function mountJobAccess(mountEl, subId) {
    mountEl.innerHTML = '<div style="padding:8px;color:var(--text-dim,#888);font-size:12px;">Loading…</div>';
    var jobs = (window.appData && window.appData.jobs) || [];
    if (!window.agxApi || !window.agxApi.subs || !window.agxApi.subs.listJobsForSub) {
      mountEl.innerHTML = '<div style="padding:8px;color:#f87171;font-size:12px;">Job access API not available — refresh.</div>';
      return;
    }
    window.agxApi.subs.listJobsForSub(subId).then(function(res) {
      var assignments = res.assignments || [];
      // Map job_id → assignment_id so the toggle handler can DELETE
      // by assignment id when the user unchecks. A sub can have
      // multiple assignment rows on the same job (level=building or
      // level=phase) — we treat any presence as "has access" and
      // remove only the job-level rows on uncheck (so building/phase
      // overrides don't get clobbered by a top-level toggle).
      var assignedByJob = {};
      assignments.forEach(function(a) {
        if (!assignedByJob[a.job_id]) assignedByJob[a.job_id] = [];
        assignedByJob[a.job_id].push(a);
      });
      // Open jobs first; closed jobs collapse into a footer hint so
      // the list isn't dominated by archived work.
      var openJobs = jobs.filter(function(j) {
        var s = (j.status || '').toLowerCase();
        return s !== 'closed' && s !== 'archived';
      });
      if (!openJobs.length) {
        mountEl.innerHTML = '<div style="padding:8px;color:var(--text-dim,#888);font-size:12px;font-style:italic;">No open jobs in the system. Create a job first, then come back to grant access.</div>';
        return;
      }
      // Header
      var header = '<div style="display:grid;grid-template-columns:auto 2.5fr 1fr 1.2fr;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--border,#333);font-size:11px;font-weight:700;color:var(--text-dim,#888);text-transform:uppercase;letter-spacing:0.4px;">' +
        '<div></div>' +
        '<div>Job name</div>' +
        '<div>Status</div>' +
        '<div>Date opened</div>' +
      '</div>';
      var rows = openJobs.map(function(j) {
        var hasAccess = !!assignedByJob[j.id];
        var dateOpened = j.dateAdded || j.created_at || '';
        var displayName = (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || j.name || j.id);
        return '<div style="display:grid;grid-template-columns:auto 2.5fr 1fr 1.2fr;gap:10px;align-items:center;padding:8px 4px;border-bottom:1px solid var(--border,#333);">' +
          '<div style="text-align:center;">' +
            '<input type="checkbox" data-job-access="' + escapeAttr(j.id) + '" ' + (hasAccess ? 'checked' : '') + ' style="margin:0;width:16px;height:16px;cursor:pointer;" />' +
          '</div>' +
          '<div style="font-size:13px;color:var(--text,#fff);min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + escapeHTML(displayName) + '</div>' +
          '<div><span style="font-size:10px;background:rgba(52,211,153,0.15);color:#34d399;padding:2px 8px;border-radius:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.3px;">' + escapeHTML(j.status || 'open') + '</span></div>' +
          '<div style="font-size:11px;color:var(--text-dim,#aaa);">' + escapeHTML(dateOpened) + '</div>' +
        '</div>';
      }).join('');
      mountEl.innerHTML = header + rows;
      // Wire toggle handlers.
      mountEl.querySelectorAll('[data-job-access]').forEach(function(cb) {
        cb.addEventListener('change', function() {
          var jobId = cb.getAttribute('data-job-access');
          if (cb.checked) {
            // Grant — assign at job level.
            window.agxApi.subs.assignToJob(jobId, { sub_id: subId, level: 'job' })
              .catch(function(err) {
                cb.checked = false; // revert
                alert('Failed to grant access: ' + (err.message || String(err)));
              });
          } else {
            // Revoke — delete the job-level assignment row(s) for this sub on this job.
            var rows = (assignedByJob[jobId] || []).filter(function(a) { return a.level === 'job'; });
            if (!rows.length) {
              alert('No job-level assignment to remove. This sub may have building/phase-level access — manage from the job page.');
              cb.checked = true;
              return;
            }
            Promise.all(rows.map(function(a) {
              return window.agxApi.subs.unassign(jobId, a.assignment_id);
            })).then(function() {
              delete assignedByJob[jobId];
            }).catch(function(err) {
              cb.checked = true; // revert
              alert('Failed to revoke access: ' + (err.message || String(err)));
            });
          }
        });
      });
    }).catch(function(err) {
      mountEl.innerHTML = '<div style="padding:8px;color:#f87171;font-size:12px;">Failed to load jobs: ' + escapeHTML(err.message || String(err)) + '</div>';
    });
  }

  // Upload a cert file: POST attachment with entity_type='sub', then
  // upsert the cert row pointing at the new attachment id. Re-renders
  // the cert section on success so the filename + remove button
  // appear immediately.
  function uploadCert(rootEl, subId, certKey, file) {
    var statusSpan = rootEl.querySelector('[data-cert-status="' + certKey + '"]');
    if (statusSpan) statusSpan.innerHTML = '<span style="font-size:11px;color:var(--text-dim,#888);">Uploading…</span>';
    window.agxApi.attachments.upload('sub', subId, file).then(function(res) {
      var att = res.attachment || res;
      // Pull current row's date/reminder values into the upsert so a
      // user who already set those fields before uploading doesn't
      // lose them.
      var row = rootEl.querySelector('[data-cert-row="' + certKey + '"]');
      var payload = { cert_type: certKey, attachment_id: att.id };
      if (row) {
        row.querySelectorAll('[data-cert-field]').forEach(function(inp) {
          var f = inp.getAttribute('data-cert-field');
          var v = inp.value;
          payload[f] = (f === 'reminder_days' || f === 'reminder_limit')
            ? (v === '' ? null : Number(v))
            : (v === '' ? null : v);
        });
      }
      return window.agxApi.subs.certs.upsert(subId, payload);
    }).then(function() {
      mountCertificates(rootEl, subId);
    }).catch(function(err) {
      if (statusSpan) statusSpan.innerHTML = '<span style="font-size:11px;color:#f87171;">Upload failed: ' + escapeHTML(err.message || String(err)) + '</span>';
    });
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
      // Class-based active state so the unified CSS in styles.css /
      // workspace-layout.css drives the green text + glowing underline
      // ("horns" look). Inline styles only carry layout primitives;
      // color and underline live in CSS.
      '<div class="sub-modal-tabs" style="border-bottom:1px solid var(--border,#333);padding:0 22px;display:flex;gap:4px;">' +
        '<button type="button" data-sub-tab="additional"    class="sub-modal-tab active">Additional information</button>' +
        '<button type="button" data-sub-tab="notifications" class="sub-modal-tab">Notifications</button>' +
        '<button type="button" data-sub-tab="jobs"          class="sub-modal-tab">Job access</button>' +
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
        // ── Certificates section ─────────────────────────────────
        // PDF upload + expiration tracking + reminder schedule. Each
        // cert type (GL / WC / W-9 / Bank) is its own row; all four
        // rows render even when no cert is uploaded yet, so the Upload
        // button is always there to start fresh. Once a cert exists,
        // the row shows the filename + a × remove button. Date and
        // reminder fields auto-save on change (debounced 400ms).
        // Disabled until the sub is saved (no id to attach to yet).
        '<div style="margin-top:22px;padding-top:16px;border-top:1px dashed var(--border,#333);">' +
          '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:10px;">Certificates</div>' +
          (!_editingId
            ? '<div style="font-size:11px;color:var(--text-dim,#888);margin-bottom:10px;font-style:italic;">Save the sub first, then upload certificate PDFs here.</div>'
            : '<div id="subDir_certsMount" style="display:flex;flex-direction:column;gap:0;"></div>') +
        '</div>' +
      '</div>' +
      // ── Tab: Notifications ───────────────────────────────────────
      // Per-sub notification matrix. Rows are event categories
      // (PM / Messaging / Financial / Administrative); columns are
      // delivery channels (Email / Text / Push). Plus a master "All
      // notifications" row that bulk-toggles every category in a
      // column at once. State writes to the hidden #subDir_notifPrefs
      // input as JSON so saveFromModal can pass it through to the
      // notification_prefs JSONB column on subs.
      '<div data-sub-tab-pane="notifications" style="padding:18px 22px;display:none;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:12px;">Notifications</div>' +
        renderNotifMatrix(sub.notification_prefs || {}) +
        '<input type="hidden" id="subDir_notifPrefs" value="' + escapeAttr(JSON.stringify(sub.notification_prefs || {})) + '" />' +
      '</div>' +
      // ── Tab: Job access ──────────────────────────────────────────
      // Lists all open jobs with a checkbox per row. Checking creates
      // a job_subs assignment (POST), unchecking deletes it. Real-
      // time — each click is its own server round-trip rather than
      // batched on Save, since granting/revoking access is a sensitive
      // enough action to want immediate feedback.
      '<div data-sub-tab-pane="jobs" style="padding:18px 22px;display:none;">' +
        '<div style="font-size:13px;font-weight:700;color:var(--text,#fff);margin-bottom:12px;">Job access</div>' +
        (!_editingId
          ? '<div style="font-size:11px;color:var(--text-dim,#888);font-style:italic;">Save the sub first, then toggle which jobs they have access to.</div>'
          : '<div id="subDir_jobAccessMount" style="font-size:12px;color:var(--text-dim,#aaa);">Loading jobs…</div>') +
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
      // Carry-over fields — kept on the directory record alongside
      // the new sub_certificates rows so existing summary views (the
      // directory list compliance chips) keep working until they're
      // migrated to read from sub_certificates directly.
      w9OnFile: get('subDir_w9') === '1',
      w9Expires: get('subDir_w9expires') || null,
      insuranceExpires: get('subDir_insExpires') || null,
      status: get('subDir_status') || 'active'
    };

    // Per-sub notification preferences — Phase 1C. The Notifications
    // tab serializes its current matrix state to a hidden JSON input
    // on every change; we just read + parse here to attach the blob
    // to the save payload.
    try {
      var notifRaw = get('subDir_notifPrefs');
      if (notifRaw) payload.notificationPrefs = JSON.parse(notifRaw);
    } catch (e) {
      // Defensive — bad JSON shouldn't block the save. Drop the field
      // and log; the rest of the form still persists.
      console.warn('Sub notif_prefs parse failed; skipping:', e.message);
    }
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
