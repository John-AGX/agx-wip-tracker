// ============================================================
// AGX Project 86 — Invoices / Accounts Receivable UI
// ============================================================
// Surfaces the AR foundation (server/routes/invoice-routes.js): a global
// Invoices page (aging summary + filterable list) and an invoice editor
// overlay (line items, tax, retainage, status, payments, PDF). Also the
// entry point the Billing screen calls to turn a certified pay application
// into an invoice. Mounts via switchTab('invoices') -> window.p86Invoices.render.
(function () {
  'use strict';

  function esc(s) {
    if (s == null) return '';
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(String(s));
    return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; });
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function round2(n) { return Math.round(num(n) * 100) / 100; }
  function fmtC(n) { n = num(n); var neg = n < 0, a = Math.abs(n); return (neg ? '-$' : '$') + a.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }); }
  function fmtDate(iso) { if (!iso) return '—'; var s = String(iso).slice(0, 10), p = s.split('-'); return p.length === 3 ? p[1] + '/' + p[2] + '/' + p[0] : s; }
  function todayISO() { try { return new Date().toISOString().slice(0, 10); } catch (e) { return ''; } }
  function toast(m, err) { if (typeof window.p86Toast === 'function') return window.p86Toast(m, err ? 'error' : 'success'); if (err && window.console) console.warn('[invoices]', m); }
  function api() { return window.p86Api && window.p86Api.invoices; }
  function payApi() { return window.p86Api && window.p86Api.payments; }

  var STATUS_COLORS = {
    draft: ['#cbd5e1', 'rgba(148,163,184,.14)'], sent: ['var(--accent,#4f8cff)', 'rgba(79,140,255,.14)'],
    partial: ['var(--yellow,#fbbf24)', 'rgba(251,191,36,.14)'], paid: ['var(--green,#34d399)', 'rgba(52,211,153,.14)'],
    void: ['#94a3b8', 'rgba(148,163,184,.10)']
  };
  function statusBadge(s) {
    s = String(s || 'draft'); var c = STATUS_COLORS[s] || STATUS_COLORS.draft;
    return '<span style="display:inline-block;padding:3px 9px;border-radius:10px;font-size:10px;font-weight:700;letter-spacing:.4px;text-transform:uppercase;color:' + c[0] + ';background:' + c[1] + ';">' + esc(s) + '</span>';
  }

  function ensureStyles() {
    if (document.getElementById('p86inv-styles')) return;
    var st = document.createElement('style'); st.id = 'p86inv-styles';
    st.textContent =
      '.p86inv-input{background:var(--input-bg,#0f131a);border:1px solid var(--border,#2a2f3a);border-radius:6px;color:var(--text,#fff);font-size:13px;padding:6px 9px;font-family:inherit;}' +
      '.p86inv-input:focus{outline:none;border-color:var(--accent,#4f8cff);}' +
      '.p86inv-ov{position:fixed;inset:0;background:rgba(3,6,12,.66);z-index:6000;display:flex;align-items:flex-start;justify-content:center;padding:26px 16px;overflow-y:auto;}' +
      '.p86inv-card{background:var(--card-bg,#141821);border:1px solid var(--border,#2a2f3a);border-radius:14px;width:100%;max-width:900px;box-shadow:0 24px 60px rgba(0,0,0,.5);}' +
      '.p86inv-row{border-bottom:1px solid var(--overlay-light,rgba(255,255,255,.04));cursor:pointer;}' +
      '.p86inv-row:hover{background:var(--overlay-light,rgba(255,255,255,.03));}';
    document.head.appendChild(st);
  }

  // ── money ─────────────────────────────────────────────────
  function lineAmount(l) { if (l && l.amount != null && l.amount !== '') return num(l.amount); return num(l && l.qty != null ? l.qty : 1) * num(l && l.unitPrice); }
  function computeTotals(inv) {
    var lines = Array.isArray(inv.lines) ? inv.lines : [];
    var subtotal = 0, taxable = 0;
    lines.forEach(function (l) { var a = lineAmount(l); subtotal += a; if (l.taxable) taxable += a; });
    var taxAmount = round2(taxable * num(inv.tax_pct) / 100);
    var retain = round2(num(inv.retainage_amount));
    var total = round2(subtotal + taxAmount - retain);
    var paid = round2(num(inv.amount_paid));
    return { subtotal: round2(subtotal), taxAmount: taxAmount, retain: retain, total: total, paid: paid, balance: round2(total - paid) };
  }

  // ── state ─────────────────────────────────────────────────
  var _host = null, _filter = 'all', _list = [], _aging = null;

  // ── AR page ───────────────────────────────────────────────
  function render(host) {
    ensureStyles();
    _host = host || document.getElementById('invoicesHost');
    if (!_host) return;
    _host.innerHTML = '<div style="padding:28px;text-align:center;color:var(--text-dim,#8b93a7);font-size:13px;">Loading invoices…</div>';
    if (!api()) { _host.innerHTML = '<div style="padding:24px;color:var(--red,#f87171);">Invoices API unavailable.</div>'; return; }
    Promise.all([
      api().list(_filter === 'all' ? {} : { status: _filter }).catch(function () { return { invoices: [] }; }),
      api().aging().catch(function () { return null; })
    ]).then(function (r) {
      _list = (r[0] && r[0].invoices) || [];
      _aging = r[1] || null;
      paintPage();
    });
  }
  function reloadPage() { render(_host); }

  function paintPage() {
    if (!_host) return;
    _host.innerHTML =
      '<div style="max-width:1100px;margin:0 auto;padding:8px 4px 40px;">' +
        agingHTML() + toolbarHTML() + listHTML() +
      '</div>';
    wirePage();
  }

  function agingHTML() {
    var a = _aging; if (!a) return '';
    function tile(label, val, color, big) {
      return '<div style="flex:1 1 140px;min-width:130px;background:var(--card-bg,#141821);border:1px solid var(--border,#2a2f3a);' +
        (big ? 'border-color:var(--accent,#4f8cff);' : '') + 'border-radius:10px;padding:11px 14px;">' +
        '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:4px;">' + esc(label) + '</div>' +
        '<div style="font-family:\'SF Mono\',ui-monospace,monospace;font-size:' + (big ? '17px' : '14px') + ';font-weight:700;color:' + (color || 'var(--text,#fff)') + ';">' + esc(fmtC(val)) + '</div></div>';
    }
    var b = a.buckets || {};
    return '<div style="margin-bottom:16px;">' +
      '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:8px;">Accounts Receivable — Aging</div>' +
      '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
        tile('Total Open', a.total_open, 'var(--accent,#4f8cff)', true) +
        tile('Current', b.current, 'var(--green,#34d399)') +
        tile('31–60 days', b.d31, 'var(--yellow,#fbbf24)') +
        tile('61–90 days', b.d61, '#fb923c') +
        tile('90+ days', b.d90, 'var(--red,#f87171)') +
      '</div></div>';
  }

  function toolbarHTML() {
    var opts = ['all', 'draft', 'sent', 'partial', 'paid', 'void'].map(function (s) {
      return '<option value="' + s + '"' + (s === _filter ? ' selected' : '') + '>' + (s === 'all' ? 'All statuses' : s.charAt(0).toUpperCase() + s.slice(1)) + '</option>';
    }).join('');
    return '<div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px;">' +
      '<h2 style="font-size:17px;font-weight:700;margin:0;color:var(--text,#fff);">Invoices</h2>' +
      '<div style="display:flex;gap:8px;align-items:center;">' +
        '<select id="p86inv-filter" class="p86inv-input">' + opts + '</select>' +
        '<button id="p86inv-new" class="ee-btn primary" style="font-size:12px;">+ New Invoice</button>' +
      '</div></div>';
  }

  function listHTML() {
    if (!_list.length) {
      return '<div style="border:1px dashed var(--border,#2a2f3a);border-radius:10px;padding:34px;text-align:center;color:var(--text-dim,#8b93a7);font-size:13px;">' +
        'No invoices yet. Click <strong>+ New Invoice</strong>, or create one from a certified draw on a job&rsquo;s Billing tab.</div>';
    }
    var rows = _list.map(function (i) {
      var who = (i.billTo && i.billTo.name) || (i.job_number ? i.job_number + (i.job_title ? ' — ' + i.job_title : '') : '') || i.client_id || '—';
      var overdue = num(i.balance) > 0.005 && i.due_date && new Date(i.due_date).getTime() < Date.now() && i.status !== 'paid' && i.status !== 'void';
      return '<tr class="p86inv-row" data-open="' + esc(i.id) + '">' +
        '<td style="padding:9px 12px;white-space:nowrap;"><strong style="color:var(--text,#fff);font-size:13px;">' + esc(i.invoice_number || '—') + '</strong></td>' +
        '<td style="padding:9px 12px;font-size:12.5px;color:var(--text,#fff);max-width:260px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">' + esc(who) + '</td>' +
        '<td style="padding:9px 12px;font-size:12px;color:var(--text-dim,#8b93a7);white-space:nowrap;">' + esc(fmtDate(i.issue_date)) + '</td>' +
        '<td style="padding:9px 12px;font-size:12px;color:' + (overdue ? 'var(--red,#f87171)' : 'var(--text-dim,#8b93a7)') + ';white-space:nowrap;">' + esc(fmtDate(i.due_date)) + (overdue ? ' ⚠' : '') + '</td>' +
        '<td style="padding:9px 12px;">' + statusBadge(i.status) + '</td>' +
        '<td class="num" style="padding:9px 12px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12.5px;color:var(--text,#fff);white-space:nowrap;">' + fmtC(i.total) + '</td>' +
        '<td class="num" style="padding:9px 12px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12.5px;color:var(--text-dim,#8b93a7);white-space:nowrap;">' + fmtC(i.amount_paid) + '</td>' +
        '<td class="num" style="padding:9px 12px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12.5px;font-weight:600;color:' + (num(i.balance) > 0.005 ? 'var(--yellow,#fbbf24)' : 'var(--green,#34d399)') + ';white-space:nowrap;">' + fmtC(i.balance) + '</td>' +
      '</tr>';
    }).join('');
    function th(l, a) { return '<th style="text-align:' + (a || 'left') + ';padding:9px 12px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8b93a7);white-space:nowrap;">' + l + '</th>'; }
    return '<div style="border:1px solid var(--border,#2a2f3a);border-radius:10px;overflow-x:auto;background:var(--card-bg,#141821);">' +
      '<table style="width:100%;border-collapse:collapse;min-width:720px;"><thead><tr style="background:var(--overlay-light,rgba(255,255,255,.02));border-bottom:1px solid var(--border,#2a2f3a);">' +
      th('Invoice #') + th('Bill to / Job') + th('Issued') + th('Due') + th('Status') + th('Total', 'right') + th('Paid', 'right') + th('Balance', 'right') +
      '</tr></thead><tbody>' + rows + '</tbody></table></div>';
  }

  function wirePage() {
    var f = _host.querySelector('#p86inv-filter');
    if (f) f.addEventListener('change', function () { _filter = f.value; reloadPage(); });
    var n = _host.querySelector('#p86inv-new'); if (n) n.addEventListener('click', function () { openNew({}); });
    _host.querySelectorAll('[data-open]').forEach(function (tr) {
      tr.addEventListener('click', function () { open(tr.getAttribute('data-open')); });
    });
  }

  // ── editor overlay ────────────────────────────────────────
  var _cur = null; // current invoice object being edited

  function open(id) {
    ensureStyles();
    api().get(id).then(function (r) { _cur = r && r.invoice; if (_cur) showEditor(); else toast('Invoice not found.', true); })
      .catch(function (e) { toast((e && e.message) || 'Could not load invoice.', true); });
  }
  function openNew(opts) {
    opts = opts || {};
    ensureStyles();
    _cur = {
      id: null, invoice_number: null, status: 'draft', job_id: opts.job_id || null,
      client_id: opts.client_id || null, issue_date: todayISO(), due_date: null, terms: 'Net 30',
      tax_pct: 0, retainage_amount: 0, amount_paid: 0,
      lines: opts.lines || [{ id: 'il_' + Date.now(), description: '', qty: 1, unitPrice: 0, taxable: false }],
      notes: '', billTo: opts.billTo || null, _new: true
    };
    showEditor();
  }
  // Called by the Billing screen after the pay-app → invoice bridge.
  function openInvoice(inv) { ensureStyles(); _cur = inv; showEditor(); }

  function editable() { return _cur && _cur.status !== 'paid' && _cur.status !== 'void'; }

  function showEditor() {
    var ov = document.getElementById('p86inv-overlay');
    if (!ov) { ov = document.createElement('div'); ov.id = 'p86inv-overlay'; ov.className = 'p86inv-ov'; document.body.appendChild(ov); }
    ov.innerHTML = '<div class="p86inv-card">' + editorHTML() + '</div>';
    ov.style.display = 'flex';
    ov.onclick = function (e) { if (e.target === ov) closeEditor(); };
    wireEditor(ov);
    loadPayments();
  }
  function closeEditor() { var ov = document.getElementById('p86inv-overlay'); if (ov) ov.style.display = 'none'; if (_host) reloadPage(); }

  function editorHTML() {
    var inv = _cur, t = computeTotals(inv), ed = editable();
    var dis = ed ? '' : ' disabled';
    var lines = Array.isArray(inv.lines) ? inv.lines : [];
    var lineRows = lines.map(function (l, i) {
      var amt = lineAmount(l);
      return '<tr data-li="' + i + '">' +
        '<td style="padding:4px 6px;">' + (ed ? '<input class="p86inv-input p86inv-desc" data-li="' + i + '" style="width:100%;" value="' + esc(l.description || '') + '" placeholder="Description">' : esc(l.description || '')) + '</td>' +
        '<td style="padding:4px 6px;width:74px;">' + (ed ? '<input type="number" class="p86inv-input p86inv-qty" data-li="' + i + '" style="width:66px;text-align:right;" value="' + esc(l.qty != null ? l.qty : 1) + '" step="any">' : esc(l.qty != null ? l.qty : 1)) + '</td>' +
        '<td style="padding:4px 6px;width:110px;">' + (ed ? '<input type="number" class="p86inv-input p86inv-price" data-li="' + i + '" style="width:100px;text-align:right;" value="' + esc(l.unitPrice != null ? l.unitPrice : 0) + '" step="0.01">' : fmtC(l.unitPrice)) + '</td>' +
        '<td class="num" style="padding:4px 10px;text-align:right;font-family:\'SF Mono\',monospace;font-size:12.5px;color:var(--text,#fff);white-space:nowrap;">' + fmtC(amt) + '</td>' +
        '<td style="padding:4px 6px;text-align:center;width:56px;"><input type="checkbox" class="p86inv-tax" data-li="' + i + '"' + (l.taxable ? ' checked' : '') + dis + ' title="Taxable"></td>' +
        '<td style="padding:4px 6px;text-align:center;width:34px;">' + (ed ? '<button class="p86inv-delline" data-li="' + i + '" title="Remove" style="background:none;border:none;color:var(--text-dim,#8b93a7);cursor:pointer;font-size:15px;">&times;</button>' : '') + '</td>' +
      '</tr>';
    }).join('');
    function metaField(label, inner) { return '<div><div style="font-size:9.5px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:3px;">' + label + '</div>' + inner + '</div>'; }
    var billToName = (inv.billTo && inv.billTo.name) || '';
    return '<div style="padding:20px 22px;">' +
      '<div style="display:flex;justify-content:space-between;align-items:flex-start;gap:12px;margin-bottom:16px;">' +
        '<div><div style="font-family:\'SF Mono\',monospace;font-size:18px;font-weight:700;color:var(--text,#fff);">' + esc(inv.invoice_number || 'New Invoice') + '</div>' +
          '<div style="margin-top:5px;">' + statusBadge(inv.status) + (inv.pay_application_id ? ' <span style="font-size:10px;color:var(--accent,#4f8cff);border:1px solid var(--accent,#4f8cff);border-radius:4px;padding:1px 5px;">from pay app</span>' : '') + '</div></div>' +
        '<button id="p86inv-x" style="background:none;border:none;color:var(--text-dim,#8b93a7);font-size:22px;cursor:pointer;line-height:1;">&times;</button>' +
      '</div>' +
      '<div style="display:flex;gap:14px;flex-wrap:wrap;margin-bottom:14px;">' +
        metaField('Bill To', '<input id="p86inv-billto" class="p86inv-input" style="width:200px;"' + dis + ' value="' + esc(billToName) + '" placeholder="Customer name">') +
        metaField('Issue Date', '<input type="date" id="p86inv-issue" class="p86inv-input"' + dis + ' value="' + esc((inv.issue_date || '').slice(0, 10)) + '">') +
        metaField('Due Date', '<input type="date" id="p86inv-due" class="p86inv-input"' + dis + ' value="' + esc((inv.due_date || '').slice(0, 10)) + '">') +
        metaField('Terms', '<input id="p86inv-terms" class="p86inv-input" style="width:96px;"' + dis + ' value="' + esc(inv.terms || '') + '" placeholder="Net 30">') +
      '</div>' +
      '<div style="border:1px solid var(--border,#2a2f3a);border-radius:8px;overflow-x:auto;margin-bottom:12px;">' +
        '<table style="width:100%;border-collapse:collapse;min-width:520px;"><thead><tr style="background:var(--overlay-light,rgba(255,255,255,.03));">' +
          '<th style="text-align:left;padding:7px 10px;font-size:9.5px;text-transform:uppercase;letter-spacing:.4px;color:var(--text-dim,#8b93a7);">Description</th>' +
          '<th style="text-align:right;padding:7px 6px;font-size:9.5px;text-transform:uppercase;color:var(--text-dim,#8b93a7);">Qty</th>' +
          '<th style="text-align:right;padding:7px 6px;font-size:9.5px;text-transform:uppercase;color:var(--text-dim,#8b93a7);">Unit Price</th>' +
          '<th style="text-align:right;padding:7px 10px;font-size:9.5px;text-transform:uppercase;color:var(--text-dim,#8b93a7);">Amount</th>' +
          '<th style="text-align:center;padding:7px 6px;font-size:9.5px;text-transform:uppercase;color:var(--text-dim,#8b93a7);">Tax</th><th></th>' +
        '</tr></thead><tbody>' + lineRows + '</tbody></table>' +
      '</div>' +
      (ed ? '<button id="p86inv-addline" class="ee-btn" style="font-size:12px;margin-bottom:14px;">+ Add line</button>' : '') +
      // totals
      '<div style="display:flex;justify-content:flex-end;margin-bottom:14px;"><div style="min-width:280px;">' +
        totRow('Subtotal', fmtC(t.subtotal)) +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;color:var(--text-dim,#c3c9d6);"><span>Tax <input type="number" id="p86inv-taxpct" class="p86inv-input" style="width:58px;text-align:right;padding:3px 5px;"' + dis + ' value="' + esc(inv.tax_pct) + '" step="0.1">%</span><span class="num" id="p86inv-taxamt" style="font-family:\'SF Mono\',monospace;">' + fmtC(t.taxAmount) + '</span></div>' +
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:4px 0;font-size:13px;color:var(--text-dim,#c3c9d6);"><span>Retainage held</span><input type="number" id="p86inv-retain" class="p86inv-input" style="width:100px;text-align:right;padding:3px 5px;"' + dis + ' value="' + esc(inv.retainage_amount) + '" step="0.01"></div>' +
        '<div style="display:flex;justify-content:space-between;padding:7px 0;border-top:1px solid var(--border,#2a2f3a);font-size:15px;font-weight:700;color:var(--text,#fff);"><span>Total</span><span class="num" id="p86inv-total" style="font-family:\'SF Mono\',monospace;">' + fmtC(t.total) + '</span></div>' +
        totRow('Paid', fmtC(t.paid), 'var(--green,#34d399)') +
        '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:14px;font-weight:700;color:' + (t.balance > 0.005 ? 'var(--yellow,#fbbf24)' : 'var(--green,#34d399)') + ';"><span>Balance</span><span class="num" id="p86inv-balance" style="font-family:\'SF Mono\',monospace;">' + fmtC(t.balance) + '</span></div>' +
      '</div></div>' +
      metaField('Notes', '<textarea id="p86inv-notes" class="p86inv-input" style="width:100%;min-height:48px;resize:vertical;"' + dis + ' placeholder="Optional">' + esc(inv.notes || '') + '</textarea>') +
      '<div id="p86inv-payments" style="margin-top:14px;"></div>' +
      // action bar
      '<div style="display:flex;gap:8px;justify-content:space-between;flex-wrap:wrap;margin-top:16px;padding-top:14px;border-top:1px solid var(--border,#2a2f3a);">' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          (ed ? '<button id="p86inv-save" class="ee-btn primary" style="font-size:12px;">Save</button>' : '') +
          (inv.id && inv.status === 'draft' ? '<button id="p86inv-send" class="ee-btn" style="font-size:12px;">Mark Sent</button>' : '') +
          (inv.id && (inv.status === 'sent' || inv.status === 'partial') ? '<button id="p86inv-pay" class="ee-btn primary" style="font-size:12px;">Record Payment</button>' : '') +
          (inv.id && inv.status !== 'void' && inv.status !== 'paid' ? '<button id="p86inv-void" class="ee-btn" style="font-size:12px;color:#94a3b8;">Void</button>' : '') +
        '</div>' +
        '<div style="display:flex;gap:8px;flex-wrap:wrap;">' +
          (inv.id ? '<button id="p86inv-pdf" class="ee-btn" style="font-size:12px;">&#x2913; PDF</button>' : '') +
          (inv.id && inv.status === 'draft' && num(inv.amount_paid) < 0.005 ? '<button id="p86inv-del" class="ee-btn" style="font-size:12px;color:var(--red,#f87171);border-color:var(--red,#f87171);">Delete</button>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }
  function totRow(label, val, color) {
    return '<div style="display:flex;justify-content:space-between;padding:4px 0;font-size:13px;color:var(--text-dim,#c3c9d6);"><span>' + label + '</span><span class="num" style="font-family:\'SF Mono\',monospace;color:' + (color || 'inherit') + ';">' + val + '</span></div>';
  }

  // Recompute totals live in the editor without a full rebuild.
  function refreshTotals() {
    var t = computeTotals(_cur), ov = document.getElementById('p86inv-overlay'); if (!ov) return;
    function set(id, v) { var e = ov.querySelector('#' + id); if (e) e.textContent = v; }
    set('p86inv-taxamt', fmtC(t.taxAmount)); set('p86inv-total', fmtC(t.total));
    set('p86inv-balance', fmtC(t.balance));
    // per-line amounts
    ov.querySelectorAll('tr[data-li]').forEach(function (tr) {
      var i = +tr.getAttribute('data-li'), cell = tr.children[3];
      if (cell && _cur.lines[i]) cell.textContent = fmtC(lineAmount(_cur.lines[i]));
    });
  }

  function wireEditor(ov) {
    var byId = function (id) { return ov.querySelector('#' + id); };
    var close = function () { closeEditor(); };
    if (byId('p86inv-x')) byId('p86inv-x').addEventListener('click', close);
    // meta
    bindVal(ov, 'p86inv-billto', function (v) { _cur.billTo = Object.assign({}, _cur.billTo, { name: v }); });
    bindVal(ov, 'p86inv-issue', function (v) { _cur.issue_date = v; });
    bindVal(ov, 'p86inv-due', function (v) { _cur.due_date = v; });
    bindVal(ov, 'p86inv-terms', function (v) { _cur.terms = v; });
    bindVal(ov, 'p86inv-notes', function (v) { _cur.notes = v; });
    bindNum(ov, 'p86inv-taxpct', function (v) { _cur.tax_pct = v; refreshTotals(); });
    bindNum(ov, 'p86inv-retain', function (v) { _cur.retainage_amount = v; refreshTotals(); });
    // line inputs
    ov.querySelectorAll('.p86inv-desc').forEach(function (inp) { inp.addEventListener('input', function () { _cur.lines[+inp.getAttribute('data-li')].description = inp.value; }); });
    ov.querySelectorAll('.p86inv-qty').forEach(function (inp) { inp.addEventListener('input', function () { _cur.lines[+inp.getAttribute('data-li')].qty = num(inp.value); refreshTotals(); }); });
    ov.querySelectorAll('.p86inv-price').forEach(function (inp) { inp.addEventListener('input', function () { var l = _cur.lines[+inp.getAttribute('data-li')]; l.unitPrice = num(inp.value); delete l.amount; refreshTotals(); }); });
    ov.querySelectorAll('.p86inv-tax').forEach(function (inp) { inp.addEventListener('change', function () { _cur.lines[+inp.getAttribute('data-li')].taxable = inp.checked; refreshTotals(); }); });
    ov.querySelectorAll('.p86inv-delline').forEach(function (b) { b.addEventListener('click', function () { _cur.lines.splice(+b.getAttribute('data-li'), 1); showEditor(); }); });
    if (byId('p86inv-addline')) byId('p86inv-addline').addEventListener('click', function () { _cur.lines.push({ id: 'il_' + Date.now(), description: '', qty: 1, unitPrice: 0, taxable: false }); showEditor(); });
    // actions
    if (byId('p86inv-save')) byId('p86inv-save').addEventListener('click', save);
    if (byId('p86inv-send')) byId('p86inv-send').addEventListener('click', function () { setStatus('sent'); });
    if (byId('p86inv-void')) byId('p86inv-void').addEventListener('click', function () { doConfirm('Void invoice', 'Void ' + (_cur.invoice_number || 'this invoice') + '? It will no longer count toward AR.', function () { setStatus('void'); }); });
    if (byId('p86inv-pay')) byId('p86inv-pay').addEventListener('click', openPaymentModal);
    if (byId('p86inv-pdf')) byId('p86inv-pdf').addEventListener('click', exportPDF);
    if (byId('p86inv-del')) byId('p86inv-del').addEventListener('click', function () { doConfirm('Delete invoice', 'Delete ' + (_cur.invoice_number || 'this invoice') + '? This cannot be undone.', del); });
  }
  function bindVal(ov, id, fn) { var e = ov.querySelector('#' + id); if (e) e.addEventListener('change', function () { fn(e.value); }); }
  function bindNum(ov, id, fn) { var e = ov.querySelector('#' + id); if (e) e.addEventListener('input', function () { fn(num(e.value)); }); }

  function payload() {
    return { job_id: _cur.job_id, client_id: _cur.client_id, tax_pct: num(_cur.tax_pct),
      retainage_amount: num(_cur.retainage_amount), issue_date: _cur.issue_date || null,
      due_date: _cur.due_date || null, terms: _cur.terms || null,
      lines: _cur.lines, notes: _cur.notes || '', billTo: _cur.billTo || null,
      pay_application_id: _cur.pay_application_id || null };
  }
  function save() {
    var p = payload();
    var req = _cur.id ? api().update(_cur.id, p) : api().create(p);
    req.then(function (r) { _cur = r && r.invoice; toast('Invoice saved.'); showEditor(); })
      .catch(function (e) { toast((e && e.message) || 'Save failed.', true); });
  }
  function setStatus(s) {
    if (!_cur.id) { toast('Save the invoice first.', true); return; }
    api().setStatus(_cur.id, s).then(function (r) { _cur = r && r.invoice; toast('Status → ' + s + '.'); showEditor(); })
      .catch(function (e) { toast((e && e.message) || 'Could not change status.', true); });
  }
  function del() {
    api().remove(_cur.id).then(function () { toast('Invoice deleted.'); closeEditor(); })
      .catch(function (e) { toast((e && e.message) || 'Delete failed.', true); });
  }

  // ── payments ──────────────────────────────────────────────
  function loadPayments() {
    var box = document.querySelector('#p86inv-payments'); if (!box || !_cur || !_cur.id || !payApi()) return;
    payApi().list().then(function (r) {
      var all = (r && r.payments) || [];
      var mine = all.filter(function (p) { return (p.applications || []).some(function (a) { return a.invoice_id === _cur.id; }); });
      if (!mine.length) { box.innerHTML = ''; return; }
      var rows = mine.map(function (p) {
        var amt = (p.applications || []).filter(function (a) { return a.invoice_id === _cur.id; }).reduce(function (s, a) { return s + num(a.amount); }, 0);
        return '<div style="display:flex;justify-content:space-between;font-size:12px;padding:5px 0;border-bottom:1px solid var(--overlay-light,rgba(255,255,255,.04));">' +
          '<span style="color:var(--text-dim,#8b93a7);">' + esc(fmtDate(p.payment_date)) + ' · ' + esc(p.method || 'payment') + (p.reference ? ' · ' + esc(p.reference) : '') + '</span>' +
          '<span class="num" style="font-family:\'SF Mono\',monospace;color:var(--green,#34d399);">' + fmtC(amt) + '</span></div>';
      }).join('');
      box.innerHTML = '<div style="font-size:10px;text-transform:uppercase;letter-spacing:.5px;color:var(--text-dim,#8b93a7);margin-bottom:4px;">Payments</div>' + rows;
    }).catch(function () {});
  }
  function openPaymentModal() {
    var t = computeTotals(_cur);
    var ov = document.createElement('div'); ov.className = 'p86inv-ov'; ov.style.zIndex = 6100;
    ov.innerHTML = '<div class="p86inv-card" style="max-width:400px;"><div style="padding:20px 22px;">' +
      '<div style="font-size:15px;font-weight:700;color:var(--text,#fff);margin-bottom:14px;">Record Payment</div>' +
      '<div style="display:flex;flex-direction:column;gap:10px;">' +
        '<label style="font-size:11px;color:var(--text-dim,#8b93a7);">Amount<input type="number" id="pm-amt" class="p86inv-input" style="width:100%;margin-top:3px;" value="' + esc(t.balance) + '" step="0.01"></label>' +
        '<label style="font-size:11px;color:var(--text-dim,#8b93a7);">Date<input type="date" id="pm-date" class="p86inv-input" style="width:100%;margin-top:3px;" value="' + esc(todayISO()) + '"></label>' +
        '<label style="font-size:11px;color:var(--text-dim,#8b93a7);">Method<select id="pm-method" class="p86inv-input" style="width:100%;margin-top:3px;">' +
          ['check', 'ach', 'card', 'cash', 'wire', 'other'].map(function (m) { return '<option value="' + m + '">' + m.charAt(0).toUpperCase() + m.slice(1) + '</option>'; }).join('') + '</select></label>' +
        '<label style="font-size:11px;color:var(--text-dim,#8b93a7);">Reference<input id="pm-ref" class="p86inv-input" style="width:100%;margin-top:3px;" placeholder="Check # / txn"></label>' +
      '</div>' +
      '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:16px;">' +
        '<button id="pm-cancel" class="ee-btn" style="font-size:12px;">Cancel</button>' +
        '<button id="pm-save" class="ee-btn primary" style="font-size:12px;">Record</button>' +
      '</div></div></div>';
    document.body.appendChild(ov);
    ov.onclick = function (e) { if (e.target === ov) ov.remove(); };
    ov.querySelector('#pm-cancel').addEventListener('click', function () { ov.remove(); });
    ov.querySelector('#pm-save').addEventListener('click', function () {
      var amt = num(ov.querySelector('#pm-amt').value);
      if (amt <= 0) { toast('Enter a payment amount.', true); return; }
      payApi().create({ client_id: _cur.client_id, payment_date: ov.querySelector('#pm-date').value,
        amount: amt, method: ov.querySelector('#pm-method').value, reference: ov.querySelector('#pm-ref').value,
        applications: [{ invoice_id: _cur.id, amount: amt }] })
        .then(function () { ov.remove(); toast('Payment recorded.'); return api().get(_cur.id); })
        .then(function (r) { _cur = r && r.invoice; showEditor(); })
        .catch(function (e) { toast((e && e.message) || 'Could not record payment.', true); });
    });
  }

  // ── PDF ───────────────────────────────────────────────────
  function exportPDF() {
    var inv = _cur, t = computeTotals(inv);
    var contractor = '';
    try { contractor = (window.appData && (appData.organizationName || (appData.organization && appData.organization.name))) || ''; } catch (e) {}
    if (!contractor) contractor = 'AG Exteriors';
    var logo = location.origin + '/images/logo-color.png';
    var lines = (inv.lines || []).map(function (l) {
      return '<tr><td>' + esc(l.description || '') + '</td><td class="n">' + esc(l.qty != null ? l.qty : 1) + '</td><td class="n">' + fmtC(l.unitPrice) + '</td><td class="n">' + fmtC(lineAmount(l)) + '</td></tr>';
    }).join('');
    var doc = '<!doctype html><html><head><meta charset="utf-8"><title>Invoice ' + esc(inv.invoice_number || '') + '</title><style>' +
      '*{box-sizing:border-box;}body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:0;padding:34px;font-size:13px;}' +
      '.doc{max-width:760px;margin:0 auto;}.hd{display:flex;justify-content:space-between;align-items:flex-start;border-bottom:2px solid #1B3A5C;padding-bottom:12px;margin-bottom:16px;}' +
      '.hd img{height:46px;}.ttl{font-size:26px;font-weight:bold;color:#1B3A5C;text-align:right;}.meta{display:flex;justify-content:space-between;gap:20px;margin-bottom:18px;font-size:12.5px;}' +
      '.meta .lbl{color:#888;font-size:10px;text-transform:uppercase;letter-spacing:.5px;}table.li{width:100%;border-collapse:collapse;margin-bottom:14px;}' +
      'table.li th{background:#1B3A5C;color:#fff;text-align:left;padding:7px 9px;font-size:10px;text-transform:uppercase;}table.li th.n,table.li td.n{text-align:right;}table.li td{padding:7px 9px;border-bottom:1px solid #e5e7eb;}' +
      '.tot{margin-left:auto;width:280px;}.tot .r{display:flex;justify-content:space-between;padding:4px 0;font-size:13px;}.tot .g{font-weight:bold;font-size:16px;color:#1B3A5C;border-top:1px solid #1B3A5C;padding-top:7px;}' +
      '.bar{position:fixed;top:10px;right:10px;}.bar button{font:inherit;padding:8px 16px;border-radius:8px;border:0;background:#1B8541;color:#fff;cursor:pointer;font-weight:bold;}@media print{.bar{display:none;}body{padding:0;}}' +
      '</style></head><body><div class="bar"><button onclick="window.print()">Print / Save PDF</button></div><div class="doc">' +
      '<div class="hd"><img src="' + esc(logo) + '" onerror="this.style.display=\'none\'"/><div><div class="ttl">INVOICE</div><div style="text-align:right;font-family:monospace;">' + esc(inv.invoice_number || '') + '</div></div></div>' +
      '<div class="meta"><div><div class="lbl">From</div>' + esc(contractor) + '<br><div class="lbl" style="margin-top:8px;">Bill To</div>' + esc((inv.billTo && inv.billTo.name) || '—') + '</div>' +
        '<div style="text-align:right;"><div class="lbl">Issued</div>' + esc(fmtDate(inv.issue_date)) + '<br><div class="lbl" style="margin-top:6px;">Due</div>' + esc(fmtDate(inv.due_date)) + '<br><div class="lbl" style="margin-top:6px;">Terms</div>' + esc(inv.terms || '—') + '</div></div>' +
      '<table class="li"><thead><tr><th>Description</th><th class="n">Qty</th><th class="n">Unit Price</th><th class="n">Amount</th></tr></thead><tbody>' + lines + '</tbody></table>' +
      '<div class="tot"><div class="r"><span>Subtotal</span><span>' + fmtC(t.subtotal) + '</span></div>' +
        (t.taxAmount ? '<div class="r"><span>Tax</span><span>' + fmtC(t.taxAmount) + '</span></div>' : '') +
        (t.retain ? '<div class="r"><span>Retainage held</span><span>-' + fmtC(t.retain) + '</span></div>' : '') +
        '<div class="r g"><span>Total Due</span><span>' + fmtC(t.total) + '</span></div>' +
        (t.paid ? '<div class="r"><span>Paid</span><span>' + fmtC(t.paid) + '</span></div><div class="r" style="font-weight:bold;"><span>Balance</span><span>' + fmtC(t.balance) + '</span></div>' : '') +
      '</div>' + (inv.notes ? '<div style="margin-top:24px;font-size:12px;color:#444;"><strong>Notes:</strong> ' + esc(inv.notes) + '</div>' : '') +
      '</div></body></html>';
    var w = window.open('', '_blank'); if (!w) { toast('Allow pop-ups to open the PDF.', true); return; }
    w.document.open(); w.document.write(doc); w.document.close();
  }

  function doConfirm(title, message, onYes) {
    if (typeof window.p86Confirm === 'function') {
      var r = window.p86Confirm({ title: title, message: message, confirmText: 'Yes', cancelText: 'Cancel' });
      if (r && typeof r.then === 'function') { r.then(function (ok) { if (ok) onYes(); }); return; }
      if (r) onYes(); return;
    }
    if (window.confirm(message)) onYes();
  }

  window.p86Invoices = { render: render, open: open, openNew: openNew, openInvoice: openInvoice };
})();
