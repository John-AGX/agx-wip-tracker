// Print a work order, or a completion report for the property manager — the
// office side (Work Orders 1.29, B9).
//
// window.p86ServiceTicketPrint. The actions bar of an open ticket gets
// "Print / PDF", for anyone who can read the ticket, with two items:
//
//   Work order — for the crew, no prices
//     A Letter page to print or save as a PDF for a crew or sub without a
//     phone. The server builds the document (GET /:id/print/work-order) from
//     named columns only, so there is nothing priced in it to leak: no approved
//     scope, no internal notes, no crew link takeoff file. This file only draws
//     it, and warns when the scope mentions a dollar amount.
//
//   Completion report — photos for the property manager
//     A modal with the counts, an Include crew notes toggle, Print / Save PDF
//     (the same renderer the report share page uses, js/report-document.js) and,
//     for people who can edit the ticket, Send report and the links already
//     sent, each with Turn off.
//
//   menuButtonHTML(t)         the Print / PDF button (one root element).
//   wire(detailEl, ctx)       ONE delegated listener per detail element.
//   openWorkOrder(t)          opens the print window SYNCHRONOUSLY in the click
//                             (so a popup blocker allows it), then fills it.
//   openCompletionReport(t, canEdit, ctx)
//   workOrderHTML(doc, opts), completionShellHTML(doc, bodyHtml, opts)
//                             pure page builders (module.exports.__test).
//
// Every date arrives as a label the server formatted in the organization's
// timezone, so this file has no date helper. It registers with window.p86StExt
// as 'ticket-print' (order 60).
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : null;

  var BOX_OPEN = '☐';
  var BOX_DONE = '☑';
  var PHOTO_WAIT_MS = 8000;

  var MSG = {
    popups: 'Allow pop-ups to print.',
    workOrderFailed: 'Could not build the work order',
    reportFailed: 'Could not build the completion report',
    sendFailed: 'Could not send the completion report',
    revokeFailed: 'Could not turn that link off',
    noRenderer: 'The report viewer is not loaded. Refresh the page and try again.',
    notApproved: 'This work order hasn\'t been approved yet. You can print a draft; it can be sent to the property manager once the work is approved.'
  };

  var SHARE_STATE = { sent: 'Sent', opened: 'Opened', expired: 'Expired', revoked: 'Turned off' };

  // ── small helpers ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function list(v) {
    return Array.isArray(v) ? v : [];
  }

  function nonBlank(v) {
    return v != null && String(v).trim() !== '';
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // 'A' | 'A and B' | 'A, B and C'
  function joinLabels(labels) {
    var l = list(labels).filter(nonBlank).map(String);
    if (l.length <= 1) return l.join('');
    return l.slice(0, -1).join(', ') + ' and ' + l[l.length - 1];
  }

  function api() {
    return (W && W.p86Api && W.p86Api.serviceTickets) || null;
  }

  function toast(msg, kind, ctx) {
    if (ctx && typeof ctx.toast === 'function') {
      try { ctx.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (W && typeof W.p86Toast === 'function') {
      try { W.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (kind === 'error' && typeof console !== 'undefined') console.error('[ticket-print] ' + msg);
  }

  function originOf(opts) {
    if (opts && typeof opts.origin === 'string') return opts.origin;
    try { return (W && W.location && W.location.origin) || ''; } catch (e) { return ''; }
  }

  function writeWindow(w, html) {
    var d = w.document;
    d.open();
    d.write(html);
    d.close();
  }

  function messagePage(title, detail) {
    return '<!doctype html><html><head><meta charset="utf-8"><title>' + esc(title) + '</title>' +
      '<style>body{font-family:Arial,Helvetica,sans-serif;color:#222;padding:40px;}h1{font-size:18px;}p{color:#555;}</style>' +
      '</head><body><h1>' + esc(title) + '</h1>' + (detail ? '<p>' + esc(detail) + '</p>' : '') + '</body></html>';
  }

  // ── the menu ──────────────────────────────────────────────────────────────
  function menuButtonHTML() {
    return '<span class="p86-st-print-wrap">' +
      '<button type="button" class="ee-btn secondary p86-st-print" aria-haspopup="true" aria-expanded="false">Print / PDF</button>' +
    '</span>';
  }

  function menuHTML() {
    return '<div class="p86-st-print-menu" role="menu">' +
      '<button type="button" role="menuitem" class="p86-st-print-item" data-print="work_order">' +
        '<span class="p86-st-print-name">Work order</span> — <span class="p86-st-print-hint">for the crew, no prices</span></button>' +
      '<button type="button" role="menuitem" class="p86-st-print-item" data-print="completion">' +
        '<span class="p86-st-print-name">Completion report</span> — <span class="p86-st-print-hint">photos for the property manager</span></button>' +
    '</div>';
  }

  function closeMenus(root) {
    if (!root || !root.querySelectorAll) return;
    Array.prototype.forEach.call(root.querySelectorAll('.p86-st-print-menu'), function (m) {
      var btn = m.parentNode && m.parentNode.querySelector('.p86-st-print');
      if (btn) btn.setAttribute('aria-expanded', 'false');
      if (m.parentNode) m.parentNode.removeChild(m);
    });
  }

  function toggleMenu(button) {
    var wrap = button.closest('.p86-st-print-wrap') || button.parentNode;
    var doc = button.ownerDocument;
    var existing = wrap.querySelector('.p86-st-print-menu');
    closeMenus(doc);
    if (existing) return;
    var holder = doc.createElement('div');
    holder.innerHTML = menuHTML();
    var menu = holder.firstChild;
    wrap.appendChild(menu);
    button.setAttribute('aria-expanded', 'true');
    var outside = function (ev) {
      if (!menu.parentNode) { cleanup(); return; }
      if (ev.type === 'keydown') {
        if (ev.key === 'Escape') { closeMenus(doc); cleanup(); try { button.focus(); } catch (e) { /* gone */ } }
        return;
      }
      if (!wrap.contains(ev.target)) { closeMenus(doc); cleanup(); }
    };
    function cleanup() {
      doc.removeEventListener('click', outside, true);
      doc.removeEventListener('keydown', outside, true);
    }
    doc.addEventListener('click', outside, true);
    doc.addEventListener('keydown', outside, true);
    var first = menu.querySelector('[data-print]');
    if (first) { try { first.focus(); } catch (e) { /* not focusable */ } }
  }

  // ── the printable work order ─────────────────────────────────────────────
  function factRow(label, value) {
    return '<tr><th>' + esc(label) + '</th><td>' + (nonBlank(value) ? esc(value) : '—') + '</td></tr>';
  }

  function nameAndPhone(p) {
    if (!p) return '';
    return [p.name, p.phone].filter(nonBlank).map(String).join(' · ');
  }

  var WORK_ORDER_CSS =
    '@page{size:letter;margin:0.5in;}' +
    '*{box-sizing:border-box;}' +
    'body{margin:0;font-family:Arial,Helvetica,sans-serif;font-size:12px;color:#111;background:#fff;}' +
    '.wo-bar{position:sticky;top:0;display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 16px;background:#f4f2ee;border-bottom:1px solid #ccc;}' +
    '.wo-bar button{font:inherit;font-size:13px;font-weight:700;padding:8px 14px;border-radius:6px;border:1px solid #999;background:#fff;cursor:pointer;}' +
    '.wo-money{background:#fff4d6;border:1px solid #e0b545;color:#6b4b00;padding:6px 10px;border-radius:6px;}' +
    '.wo-page{max-width:7.5in;margin:0 auto;padding:18px 16px 32px;}' +
    '.wo-head{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;border-bottom:2px solid #111;padding-bottom:10px;}' +
    '.wo-org{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:700;}' +
    '.wo-org img{height:40px;width:auto;}' +
    '.wo-kind{text-align:right;}' +
    '.wo-kind .k{font-size:18px;font-weight:700;letter-spacing:2px;}' +
    '.wo-kind .n{font-size:13px;font-weight:700;}' +
    '.wo-kind .p{color:#555;font-size:11px;}' +
    'h1{font-size:20px;margin:14px 0 10px;}' +
    'h2{font-size:13px;text-transform:uppercase;letter-spacing:1px;margin:18px 0 6px;border-bottom:1px solid #999;padding-bottom:3px;}' +
    '.wo-facts{display:grid;grid-template-columns:1fr 1fr;gap:0 18px;}' +
    '.wo-facts table{width:100%;border-collapse:collapse;}' +
    '.wo-facts th{text-align:left;width:34%;color:#555;font-weight:600;padding:3px 6px 3px 0;vertical-align:top;}' +
    '.wo-facts td{padding:3px 0;vertical-align:top;}' +
    '.wo-scope{white-space:pre-wrap;line-height:1.45;}' +
    '.wo-empty{color:#777;font-style:italic;}' +
    '.wo-check{list-style:none;margin:0;padding:0;}' +
    '.wo-check li{padding:2px 0;}' +
    '.wo-box{font-size:15px;margin-right:6px;}' +
    'table.wo-grid{width:100%;border-collapse:collapse;}' +
    'table.wo-grid th,table.wo-grid td{border:1px solid #999;padding:5px 6px;text-align:left;vertical-align:top;}' +
    'table.wo-grid th{background:#eee;font-size:11px;text-transform:uppercase;letter-spacing:.5px;}' +
    'table.wo-grid tr{break-inside:avoid;page-break-inside:avoid;}' +
    'td.wo-tick{width:28px;text-align:center;font-size:16px;}' +
    'td.wo-initials{width:70px;}' +
    '.wo-lines div{border-bottom:1px solid #999;height:26px;}' +
    '.wo-sign{margin-top:22px;display:grid;grid-template-columns:2fr 1fr;gap:18px 24px;break-inside:avoid;page-break-inside:avoid;}' +
    '.wo-sign div{border-bottom:1px solid #111;height:34px;position:relative;}' +
    '.wo-sign span{position:absolute;bottom:-16px;left:0;font-size:10px;color:#555;}' +
    '@media print{.wo-bar{display:none;}.wo-page{padding:0;}}';

  /**
   * workOrderHTML(doc, opts{origin}) -> a whole HTML page. doc is the server's
   * work order document (service-ticket-print.js buildWorkOrderPrint).
   * No inline event handlers: the print window wires its button and logo after
   * the page is written.
   */
  function workOrderHTML(doc, opts) {
    var d = doc || {};
    var site = d.site || {};
    var origin = originOf(opts);
    var jobLine = [site.job_number, site.name].filter(nonBlank).map(String).join(' · ');
    var money = list(d.money_mentions).length > 0;

    var checklist = list(d.checklist);
    var materials = list(d.materials);
    var buildings = list(d.buildings);

    var html = '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc('Work order — ' + (d.title || 'Work order')) + '</title>' +
      '<style>' + WORK_ORDER_CSS + '</style></head><body>' +
      '<div class="wo-bar">' +
        '<button type="button" id="p86woPrint">Print / Save PDF</button>' +
        (money ? '<span class="wo-money" role="note">The scope mentions a dollar amount. Check it before you hand this to a crew.</span>' : '') +
      '</div>' +
      '<div class="wo-page">' +
      '<div class="wo-head">' +
        '<div class="wo-org">' +
          '<img id="p86woLogo" src="' + esc(origin + '/images/logo-color.png') + '" alt="" />' +
          '<span>' + esc(d.org_name || '') + '</span>' +
        '</div>' +
        '<div class="wo-kind">' +
          '<div class="k">WORK ORDER</div>' +
          (nonBlank(d.ticket_number) ? '<div class="n">' + esc(d.ticket_number) + '</div>' : '') +
          (nonBlank(d.printed_label) ? '<div class="p">Printed ' + esc(d.printed_label) + '</div>' : '') +
        '</div>' +
      '</div>' +
      '<h1>' + esc(d.title || 'Work order') + '</h1>' +
      '<div class="wo-facts">' +
        '<table>' +
          factRow('Job', jobLine) +
          factRow('Address', site.address) +
          factRow('Gate code', site.gate_code) +
          factRow('Site contact', nameAndPhone(d.site_contact)) +
        '</table>' +
        '<table>' +
          factRow('Scheduled', d.scheduled_label) +
          factRow('Due', d.due_label) +
          factRow('Priority', d.priority_label) +
          factRow('Office contact', nameAndPhone(d.office_contact)) +
        '</table>' +
      '</div>' +
      '<h2>Scope of work</h2>' +
      (nonBlank(d.scope) ? '<div class="wo-scope">' + esc(d.scope) + '</div>' : '<div class="wo-empty">No scope written.</div>');

    if (checklist.length) {
      html += '<h2>Checklist</h2><ul class="wo-check">' + checklist.map(function (c) {
        return '<li><span class="wo-box">' + (c && c.done ? BOX_DONE : BOX_OPEN) + '</span>' + esc(c && c.text) + '</li>';
      }).join('') + '</ul>';
    }

    if (materials.length) {
      html += '<h2>Materials</h2><table class="wo-grid wo-materials"><thead><tr>' +
          '<th>Qty</th><th>Unit</th><th>Material</th>' +
        '</tr></thead><tbody>' + materials.map(function (m) {
          return '<tr><td>' + esc(m && m.qty) + '</td><td>' + esc(m && m.unit) + '</td><td>' + esc(m && m.description) + '</td></tr>';
        }).join('') + '</tbody></table>';
    }

    if (buildings.length) {
      html += '<h2>Buildings</h2><table class="wo-grid wo-buildings"><thead><tr>' +
          '<th></th><th>Building</th><th>Work</th><th>Initials</th>' +
        '</tr></thead><tbody>' + buildings.map(function (b) {
          var sides = list(b && b.sides).map(function (s) {
            var items = list(s && s.items).filter(nonBlank).map(String).join('; ');
            return esc((s && nonBlank(s.label) ? s.label + ': ' : '') + items);
          }).filter(Boolean).join('<br>');
          return '<tr><td class="wo-tick">' + (b && b.done ? BOX_DONE : BOX_OPEN) + '</td>' +
            '<td>' + esc(b && b.head) + '</td>' +
            '<td>' + sides + '</td>' +
            '<td class="wo-initials"></td></tr>';
        }).join('') + '</tbody></table>';
    }

    html += '<h2>Notes</h2><div class="wo-lines"><div></div><div></div><div></div><div></div><div></div></div>' +
      '<div class="wo-sign">' +
        '<div><span>Work completed by</span></div><div><span>Date</span></div>' +
        '<div><span>Signature</span></div><div></div>' +
        '<div><span>' + esc('Checked for ' + (d.org_name || 'the office')) + '</span></div><div><span>Date</span></div>' +
      '</div>' +
      '</div></body></html>';
    return html;
  }

  function wireWorkOrderWindow(w) {
    var d = w.document;
    var btn = d.getElementById('p86woPrint');
    if (btn) btn.addEventListener('click', function () { w.print(); });
    var logo = d.getElementById('p86woLogo');
    if (logo) {
      var hide = function () { logo.style.display = 'none'; };
      logo.addEventListener('error', hide);
      if (logo.complete && !logo.naturalWidth) hide();
    }
  }

  function openWindow(ctx) {
    var w = null;
    try { w = W && typeof W.open === 'function' ? W.open('', '_blank') : null; } catch (e) { w = null; }
    if (!w) toast(MSG.popups, 'error', ctx);
    return w;
  }

  function openWorkOrder(t, ctx) {
    // Opened now, inside the click, before anything async: a popup blocker
    // allows a window the click itself opened.
    var w = openWindow(ctx);
    if (!w) return Promise.resolve(null);
    writeWindow(w, messagePage('Preparing…', ''));
    var st = api();
    if (!st || typeof st.workOrderPrint !== 'function' || !t || t.id == null) {
      writeWindow(w, messagePage(MSG.workOrderFailed, ''));
      return Promise.resolve(null);
    }
    return Promise.resolve()
      .then(function () { return st.workOrderPrint(t.id); })
      .then(function (res) {
        if (w.closed) return null;
        writeWindow(w, workOrderHTML((res && res.document) || {}, {}));
        wireWorkOrderWindow(w);
        return w;
      }, function (err) {
        if (!w.closed) writeWindow(w, messagePage(MSG.workOrderFailed, err && err.message));
        return null;
      });
  }

  // ── the completion report print window ────────────────────────────────────
  // The cover and body rules are the report share page's (report-share.html),
  // so a printed report looks like the one the property manager opens.
  var COMPLETION_CSS =
    ':root{--rule:#d9d5cd;}' +
    '*{box-sizing:border-box;}html,body{margin:0;padding:0;}' +
    'body{background:#edeae4;color:#14171c;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Arial,sans-serif;font-size:15px;line-height:1.5;}' +
    '.cr-bar{position:sticky;top:0;z-index:10;display:flex;align-items:center;gap:12px;padding:12px 18px;background:#fff;border-bottom:1px solid var(--rule);}' +
    '.cr-bar-org{font-weight:700;}.cr-bar-sub{color:#565d68;font-size:13px;}.cr-spacer{flex:1 1 auto;}' +
    '.cr-btn{font:inherit;font-size:13px;font-weight:600;padding:8px 14px;border-radius:8px;border:1px solid var(--rule);background:#fff;color:#14171c;cursor:pointer;}' +
    '.cr-btn[disabled]{opacity:.6;cursor:progress;}' +
    '.cr-wrap{padding:22px 14px 60px;}' +
    '.p86-report-preview-paper{width:min(839px,100%);margin:0 auto;background:#fff;color:#000;padding:56px 50px;box-shadow:0 2px 6px rgba(0,0,0,.08),0 18px 50px rgba(0,0,0,.10);border-radius:2px;}' +
    '.p86-report-cover-rendered{text-align:center;padding-bottom:26px;border-bottom:1px solid var(--rule);margin-bottom:30px;}' +
    '.p86-report-cover-company{font-size:13px;font-weight:700;color:#666;text-transform:uppercase;letter-spacing:2px;margin-bottom:6px;}' +
    '.p86-report-cover-subtitle{font-size:14px;color:#666;font-style:italic;margin-bottom:14px;}' +
    '.p86-report-cover-title{font-size:30px;line-height:1.2;margin:8px 0 10px;}' +
    '.p86-report-cover-addr{color:#555;font-size:14px;}' +
    '.p86-report-cover-meta{display:flex;flex-wrap:wrap;justify-content:center;gap:10px 34px;margin-top:22px;}' +
    '.p86-report-cover-meta>div{text-align:left;}' +
    '.p86-report-cover-meta .k{display:block;font-size:10.5px;text-transform:uppercase;letter-spacing:1px;color:#888;}' +
    '.p86-report-cover-meta .v{display:block;font-size:14px;font-weight:600;}' +
    '.p86-report-preview-summary{font-size:15px;color:#333;margin-bottom:26px;white-space:pre-wrap;}' +
    '.p86-report-preview-section{margin-bottom:34px;}' +
    '.p86-report-preview-section-label{font-size:17px;margin:0 0 12px;padding-bottom:6px;border-bottom:1px solid var(--rule);}' +
    '.p86-report-preview-text{white-space:pre-wrap;font-size:14.5px;color:#222;}' +
    '.p86-report-preview-section-grid{display:grid;gap:14px;}' +
    '.p86-report-preview-section-grid.size-small{grid-template-columns:repeat(2,minmax(0,1fr));}' +
    '.p86-report-preview-section-grid.size-medium{grid-template-columns:repeat(3,minmax(0,1fr));}' +
    '.p86-report-preview-section-grid.size-large{grid-template-columns:repeat(2,minmax(0,1fr));}' +
    '.p86-report-preview-photo{display:flex;flex-direction:column;break-inside:avoid;page-break-inside:avoid;}' +
    '.p86-report-preview-photo-img-wrap{position:relative;overflow:hidden;border-radius:3px;}' +
    '.p86-report-preview-photo-img-wrap img{display:block;width:100%;height:auto;}' +
    '.p86-report-preview-photo-anno{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;}' +
    '@media print{body{background:#fff;}.cr-bar{display:none;}.cr-wrap{padding:0;}.p86-report-preview-paper{box-shadow:none;width:100%;padding:0;}}' +
    '@media (max-width:600px){.p86-report-preview-paper{padding:28px 18px;}.p86-report-preview-section-grid.size-medium{grid-template-columns:repeat(2,minmax(0,1fr));}}';

  /**
   * completionShellHTML(doc, bodyHtml, opts{origin}) -> a whole HTML page.
   * bodyHtml is js/report-document.js render(doc), which escapes what it draws.
   */
  function completionShellHTML(doc, bodyHtml, opts) {
    var d = doc || {};
    var origin = originOf(opts);
    return '<!doctype html><html><head><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width, initial-scale=1">' +
      '<title>' + esc(d.title || 'Completion report') + '</title>' +
      '<link rel="stylesheet" href="' + esc(origin + '/css/report-paper.css?v=2') + '">' +
      '<link rel="stylesheet" href="' + esc(origin + '/css/report-style-packs.css?v=2') + '">' +
      '<style>' + COMPLETION_CSS + '</style></head><body>' +
      '<div class="cr-bar">' +
        '<div><div class="cr-bar-org">' + esc(d.org_name || 'Completion report') + '</div>' +
          '<div class="cr-bar-sub">' + esc(d.project_name || '') + '</div></div>' +
        '<div class="cr-spacer"></div>' +
        '<button type="button" class="cr-btn" id="p86crPrint" disabled>Loading photos…</button>' +
      '</div>' +
      '<div class="cr-wrap"><div id="p86crDoc">' + String(bodyHtml == null ? '' : bodyHtml) + '</div></div>' +
      '</body></html>';
  }

  // The Print button waits until every photo has loaded or failed (8 s at
  // most), so a printout is not missing the photos it exists for.
  function gateOnPhotos(w) {
    var d = w.document;
    var btn = d.getElementById('p86crPrint');
    if (!btn) return;
    btn.addEventListener('click', function () { w.print(); });
    var imgs = Array.prototype.slice.call(d.images || []);
    var ready = false;
    function go() {
      if (ready) return;
      ready = true;
      btn.disabled = false;
      btn.textContent = 'Print / Save PDF';
    }
    var waiting = imgs.filter(function (img) { return !img.complete; });
    if (!waiting.length) { go(); return; }
    var left = waiting.length;
    waiting.forEach(function (img) {
      var done = function () { left--; if (left <= 0) go(); };
      img.addEventListener('load', done, { once: true });
      img.addEventListener('error', done, { once: true });
    });
    setTimeout(go, PHOTO_WAIT_MS);
  }

  function printCompletion(doc, ctx) {
    var w = openWindow(ctx);
    if (!w) return null;
    var renderer = W && W.p86ReportDocument;
    if (!renderer || typeof renderer.render !== 'function') {
      writeWindow(w, messagePage(MSG.noRenderer, ''));
      return w;
    }
    writeWindow(w, completionShellHTML(doc, renderer.render(doc), {}));
    if (typeof renderer.wire === 'function') {
      try { renderer.wire(w.document.getElementById('p86crDoc'), doc); } catch (e) { /* the photos still show */ }
    }
    gateOnPhotos(w);
    return w;
  }

  // ── the completion report modal ─────────────────────────────────────────
  var _modal = null;

  function closeModal() {
    if (!_modal) return;
    var m = _modal;
    _modal = null;
    try { m.doc.removeEventListener('keydown', m.onKey, true); } catch (e) { /* gone */ }
    if (m.back && m.back.parentNode) m.back.parentNode.removeChild(m.back);
  }

  function approvalLine(summary) {
    var a = summary && summary.approved;
    if (!a) return MSG.notApproved;
    if (nonBlank(a.name) && nonBlank(a.at_label)) return 'Approved by ' + a.name + ' on ' + a.at_label + '.';
    if (nonBlank(a.name)) return 'Approved by ' + a.name + '.';
    if (nonBlank(a.at_label)) return 'Approved on ' + a.at_label + '.';
    return 'Approved.';
  }

  function shareRowHTML(s) {
    var who = nonBlank(s.recipient_name) ? s.recipient_name : (nonBlank(s.recipient_email) ? s.recipient_email : 'Link only');
    var state = SHARE_STATE[s.state] || 'Sent';
    var views = Number(s.view_count) || 0;
    var live = s.state === 'sent' || s.state === 'opened';
    return '<div class="p86-st-cr-share" data-share="' + esc(s.id) + '">' +
      '<span class="p86-st-cr-share-text">' + esc(who) + ' · ' + esc(state) + ' · ' + esc(plural(views, 'view', 'views')) +
        (nonBlank(s.expires_label) ? ' · expires ' + esc(s.expires_label) : '') + '</span>' +
      (live ? '<button type="button" class="ee-btn secondary p86-st-cr-revoke" data-share-off="' + esc(s.id) + '">Turn off</button>' : '') +
    '</div>';
  }

  function modalBodyHTML(m) {
    var r = m.r || {};
    var s = r.summary || {};
    var missing = list(s.missing_completion);
    var money = list(s.money_mentions);
    var shares = Array.isArray(r.shares) ? r.shares : null;
    var total = Number(s.buildings_total) || 0;
    var doneCount = Number(s.buildings_done) || 0;
    var before = Number(s.before_photos) || 0;
    var completion = Number(s.completion_photos) || 0;

    var html = '<div class="p86-st-cr-status' + (s.approved ? ' is-approved' : '') + '">' + esc(approvalLine(s)) + '</div>' +
      '<div class="p86-st-cr-counts">' + esc(doneCount + ' of ' + total + ' buildings finished · ' +
        before + ' before and ' + completion + ' completion photos') + '</div>' +
      (missing.length
        ? '<div class="p86-st-cr-missing">' + esc((missing.length === 1
            ? '1 building has no completion photo: '
            : missing.length + ' buildings have no completion photo: ') + missing.join(', ') + '.') + '</div>'
        : '') +
      '<label class="p86-st-cr-notes"><input type="checkbox" class="p86-st-cr-notes-in"' + (m.includeNotes ? ' checked' : '') +
        (m.loading ? ' disabled' : '') + ' /> Include crew notes</label>' +
      (money.length
        ? '<div class="p86-st-cr-money" role="note">' + esc(joinLabels(money) + (money.length === 1 ? ' mentions' : ' mention') +
            ' a dollar amount. Whoever you send this to will see it.') + '</div>'
        : '') +
      '<div class="p86-st-cr-printrow"><button type="button" class="ee-btn primary p86-st-cr-print"' + (m.loading ? ' disabled' : '') +
        '>Print / Save PDF</button></div>';

    if (shares) {
      var sendable = s.sendable === true;
      html += '<div class="p86-st-cr-send">' +
        '<label class="p86-st-lbl">Send to the property manager</label>' +
        '<div class="p86-st-cr-sendrow">' +
          '<div><label class="p86-st-lbl" for="p86CrEmail">Their email</label>' +
            '<input type="email" id="p86CrEmail" class="p86-st-cr-email" maxlength="200" placeholder="name@property.com" value="' + esc(m.email || '') + '" /></div>' +
          '<div><label class="p86-st-lbl" for="p86CrName">Their name (optional)</label>' +
            '<input type="text" id="p86CrName" class="p86-st-cr-name" maxlength="120" value="' + esc(m.name || '') + '" /></div>' +
        '</div>' +
        '<div class="p86-st-cr-sendacts"><button type="button" class="ee-btn primary p86-st-cr-sendgo"' +
          (sendable && !m.sending ? '' : ' disabled') + (sendable ? '' : ' title="Approve the work order first"') + '>' +
          (m.sending ? 'Sending…' : 'Send report') + '</button></div>' +
        '<div class="p86-st-help">They get a link to a read-only page with the photos — no login. They can print it or save it as a PDF. The link works for 30 days and you can turn it off.</div>' +
        '<div class="p86-st-cr-sendwrap" role="status"></div>' +
        '<div class="p86-st-cr-err" role="alert" hidden></div>' +
        (shares.length
          ? '<div class="p86-st-cr-shares"><label class="p86-st-lbl">Sent</label>' + shares.map(shareRowHTML).join('') + '</div>'
          : '') +
      '</div>';
    }
    return html;
  }

  function resultHTML(res, email) {
    var link = res && res.link ? String(res.link) : '';
    var line;
    if (email && res && res.email_sent) line = 'Emailed to ' + email + '.';
    else if (email) line = 'The email didn\'t send — copy the link instead.';
    else line = 'Copy this link and send it yourself.';
    return '<div class="p86-st-cr-result">' +
      '<div class="p86-st-cr-result-line">' + esc(line) + '</div>' +
      (link
        ? '<div class="p86-st-cr-linkrow"><input type="text" readonly class="p86-st-cr-link" value="' + esc(link) + '" aria-label="Report link" />' +
            '<button type="button" class="ee-btn secondary p86-st-cr-copy">Copy</button></div>' +
          '<div class="p86-st-help">Copy this now: it is stored only as a hash, so it cannot be shown again.</div>'
        : '') +
    '</div>';
  }

  function paintModal(m) {
    var body = m.back.querySelector('.p86-st-cr-body');
    if (!body) return;
    if (!m.r) {
      body.innerHTML = m.error
        ? '<div class="p86-st-cr-err" role="alert">' + esc(m.error) + '</div>'
        : '<div class="p86-st-loading">Loading…</div>';
      return;
    }
    body.innerHTML = modalBodyHTML(m);
    var wrap = body.querySelector('.p86-st-cr-sendwrap');
    if (wrap && m.result) wrap.innerHTML = m.result;
    var err = body.querySelector('.p86-st-cr-err');
    if (err && m.sendError) { err.textContent = m.sendError; err.hidden = false; }
  }

  function loadReport(m) {
    var st = api();
    m.loading = true;
    paintModal(m);
    if (!st || typeof st.completionReport !== 'function') {
      m.loading = false;
      m.error = MSG.reportFailed;
      m.r = null;
      paintModal(m);
      return Promise.resolve(null);
    }
    var want = m.includeNotes;
    return Promise.resolve()
      .then(function () { return st.completionReport(m.t.id, { includeNotes: want }); })
      .then(function (res) {
        if (_modal !== m) return null;
        m.loading = false;
        m.error = null;
        m.r = res || {};
        paintModal(m);
        return res;
      }, function (err) {
        if (_modal !== m) return null;
        m.loading = false;
        if (!m.r) m.error = (err && err.message) || MSG.reportFailed;
        else toast((err && err.message) || MSG.reportFailed, 'error', m.ctx);
        paintModal(m);
        return null;
      });
  }

  function keepTyped(m) {
    var email = m.back.querySelector('.p86-st-cr-email');
    var name = m.back.querySelector('.p86-st-cr-name');
    if (email) m.email = email.value;
    if (name) m.name = name.value;
  }

  function sendReport(m) {
    if (m.sending) return null;
    var st = api();
    keepTyped(m);
    var email = String(m.email || '').trim();
    var name = String(m.name || '').trim();
    m.sendError = null;
    if (!st || typeof st.sendCompletionReport !== 'function') {
      m.sendError = MSG.sendFailed;
      paintModal(m);
      return null;
    }
    m.sending = true;
    m.result = null;
    paintModal(m);
    var payload = { include_notes: !!m.includeNotes };
    if (email) payload.email = email;
    if (name) payload.name = name;
    return Promise.resolve()
      .then(function () { return st.sendCompletionReport(m.t.id, payload); })
      .then(function (res) {
        m.sending = false;
        m.result = resultHTML(res, email);
        m.email = '';
        m.name = '';
        if (m.ctx && typeof m.ctx.refresh === 'function') {
          try { m.ctx.refresh(); } catch (e) { /* the timeline row is a convenience */ }
        }
        return loadReport(m);
      }, function (err) {
        m.sending = false;
        // The server's own sentence, including the just_sent refusal.
        m.sendError = (err && err.message) || MSG.sendFailed;
        paintModal(m);
        return null;
      });
  }

  function confirmTurnOff() {
    if (W && typeof W.p86Confirm === 'function') {
      return Promise.resolve(W.p86Confirm({
        title: 'Turn off this link?',
        message: 'Whoever has it will no longer be able to open the completion report. You can send a new one.',
        confirmText: 'Turn off',
        confirmLabel: 'Turn off',
        cancelText: 'Keep it',
        cancelLabel: 'Keep it',
        destructive: true,
        danger: true
      }));
    }
    return Promise.resolve(true);
  }

  function revokeShare(m, shareId) {
    // Turning a link off reloads the report, which rebuilds the whole modal
    // body from m — so the address and name typed into the send row above the
    // Sent list are read back first, exactly as sending does. Without this the
    // office retypes them after every Turn off.
    keepTyped(m);
    var st = api();
    if (!st || typeof st.revokeCompletionReport !== 'function') {
      toast(MSG.revokeFailed, 'error', m.ctx);
      return Promise.resolve(null);
    }
    return confirmTurnOff().then(function (yes) {
      if (!yes || _modal !== m) return null;
      return Promise.resolve()
        .then(function () { return st.revokeCompletionReport(m.t.id, shareId); })
        .then(function () {
          toast('Link turned off', 'success', m.ctx);
          if (m.ctx && typeof m.ctx.refresh === 'function') {
            try { m.ctx.refresh(); } catch (e) { /* convenience */ }
          }
          return loadReport(m);
        }, function (err) {
          toast((err && err.message) || MSG.revokeFailed, 'error', m.ctx);
          return loadReport(m);
        });
    });
  }

  function copyLink(m) {
    var input = m.back.querySelector('.p86-st-cr-link');
    if (!input) return;
    var value = input.value;
    var nav = W && W.navigator;
    if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') {
      nav.clipboard.writeText(value).then(function () { toast('Link copied', 'success', m.ctx); }, function () {
        try { input.select(); } catch (e) { /* not selectable */ }
      });
      return;
    }
    try {
      input.select();
      if (m.doc.execCommand && m.doc.execCommand('copy')) toast('Link copied', 'success', m.ctx);
    } catch (e) { /* the PM can still select it */ }
  }

  function openCompletionReport(t, canEdit, ctx) {
    var doc = W && W.document;
    if (!doc || !t || t.id == null) return null;
    closeModal();
    var back = doc.createElement('div');
    back.className = 'p86-st-modal-back p86-st-cr-back';
    back.innerHTML = '<div class="p86-st-modal p86-st-cr-modal" role="dialog" aria-modal="true" aria-labelledby="p86CrHead">' +
      '<div class="p86-st-modal-head" id="p86CrHead">Completion report</div>' +
      '<div class="p86-st-cr-title">' + esc(t.title || '') + '</div>' +
      '<div class="p86-st-cr-body" aria-live="polite"></div>' +
      '<div class="p86-st-modal-actions"><button type="button" class="ee-btn secondary p86-st-cr-close">Close</button></div>' +
    '</div>';
    var m = {
      doc: doc, back: back, t: t, ctx: ctx || null, canEdit: canEdit !== false,
      includeNotes: true, loading: false, sending: false, r: null, error: null,
      result: null, sendError: null, email: '', name: '',
      onKey: function (ev) { if (ev.key === 'Escape' && _modal === m) { ev.preventDefault(); closeModal(); } }
    };

    back.addEventListener('click', function (ev) {
      var target = ev.target;
      if (target === back) { if (!m.sending) closeModal(); return; }
      if (!target || !target.closest) return;
      if (target.closest('.p86-st-cr-close')) { closeModal(); return; }
      if (target.closest('.p86-st-cr-print')) {
        if (m.r && m.r.document) printCompletion(m.r.document, m.ctx);
        return;
      }
      if (target.closest('.p86-st-cr-sendgo')) { sendReport(m); return; }
      if (target.closest('.p86-st-cr-copy')) { copyLink(m); return; }
      var off = target.closest('[data-share-off]');
      if (off) revokeShare(m, off.getAttribute('data-share-off'));
    });
    back.addEventListener('change', function (ev) {
      var box = ev.target;
      if (!box || !box.classList || !box.classList.contains('p86-st-cr-notes-in')) return;
      keepTyped(m);
      m.includeNotes = !!box.checked;
      loadReport(m);
    });

    doc.body.appendChild(back);
    doc.addEventListener('keydown', m.onKey, true);
    _modal = m;
    loadReport(m);
    return m;
  }

  // ── wiring on the ticket screen ─────────────────────────────────────────
  function wire(d, ctx) {
    if (!d || typeof d.addEventListener !== 'function' || d.__p86PrintWired) return;
    d.__p86PrintWired = true;
    d.addEventListener('click', function (ev) {
      var target = ev.target && ev.target.closest ? ev.target : null;
      if (!target) return;
      var live = d._st || ctx || {};
      var item = target.closest('[data-print]');
      if (item && d.contains(item)) {
        ev.preventDefault();
        closeMenus(d.ownerDocument);
        var t = live.t || {};
        if (item.getAttribute('data-print') === 'work_order') openWorkOrder(t, live);
        else openCompletionReport(t, !!live.canEdit, live);
        return;
      }
      var button = target.closest('.p86-st-print');
      if (button && d.contains(button)) {
        ev.preventDefault();
        toggleMenu(button);
      }
    });
  }

  function eventWhat(event, helpers) {
    if (!event) return null;
    var h = helpers || {};
    var d = h.detail && typeof h.detail === 'object' ? h.detail : null;
    if (!d) {
      d = event.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
      d = d && typeof d === 'object' ? d : {};
    }
    if (event.kind === 'completion_report_sent') {
      return esc(d.emailed === true ? 'sent the completion report by email' : 'made a completion report link');
    }
    if (event.kind === 'completion_report_link_off') return esc('turned a completion report link off');
    return null;
  }

  var extension = {
    order: 60,
    detailSections: function (ctx) {
      var t = (ctx && ctx.t) || {};
      return [{ key: 'print-menu', slot: 'actions', html: t.id != null ? menuButtonHTML(t) : '' }];
    },
    wireDetail: function (d, ctx) {
      wire(d, ctx);
    },
    eventWhat: eventWhat
  };

  var publicApi = {
    menuButtonHTML: menuButtonHTML,
    wire: wire,
    openWorkOrder: openWorkOrder,
    openCompletionReport: openCompletionReport,
    closeCompletionReport: closeModal,
    workOrderHTML: workOrderHTML,
    completionShellHTML: completionShellHTML,
    eventWhat: eventWhat,
    extension: extension
  };

  if (W) {
    W.p86ServiceTicketPrint = publicApi;
    var registerWithTicketScreen = function () {
      if (!W.p86StExt || typeof W.p86StExt.register !== 'function') return false;
      return W.p86StExt.register('ticket-print', extension);
    };
    if (!registerWithTicketScreen() && W.document && W.document.readyState === 'loading') {
      W.document.addEventListener('DOMContentLoaded', registerWithTicketScreen);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __test: {
        workOrderHTML: workOrderHTML,
        completionShellHTML: completionShellHTML,
        modalBodyHTML: modalBodyHTML,
        resultHTML: resultHTML,
        shareRowHTML: shareRowHTML,
        approvalLine: approvalLine,
        eventWhat: eventWhat,
        menuHTML: menuHTML
      }
    };
  }
})();
