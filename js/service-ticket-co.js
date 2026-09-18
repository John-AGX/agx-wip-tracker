// Start a change order from a work order — the office side (Work Orders 1.29, B8).
//
// window.p86ServiceTicketCo. When a crew finds extra work on a work order, the
// office turns it into a DRAFT change order on the job, with a title, what the
// extra work is, a quantity and unit, and the photos that show it. It is priced
// in the change order editor like any other. Nothing about it reaches the crew
// link: every surface here is on the office ticket screen only.
//
//   canStart(t)                 whether this person may start one on this ticket
//                               (on a job, not archived or cancelled, the job is
//                               not read-only here, and ESTIMATES_EDIT).
//   setContext(t, r)            remembers the last ticket read, for callers that
//                               do not pass one.
//   chipHTML(cos)               "CO draft" / "CO approved" beside the status.
//   listHTML(cos, opts)         "Change orders" under the suggestions.
//   actionButtonHTML()          "Start change order" in the actions bar.
//   sourceButtonHTML(kind, id, cos, opts)
//                               the button on a suggestion, a building note or a
//                               flagged problem; "CO-4 started" once one exists.
//   prefillFor(kind, id, context)
//                               the dialog's title, description and ticked photos.
//   wire(detailEl, ctx)         ONE delegated click listener per detail element.
//   open(kind, id, ctx)         the "Start a change order" dialog.
//
// It registers with window.p86StExt as 'ticket-co' (order 50) and adds a card
// action to window.p86TicketFlags, so js/service-tickets.js never calls it by
// name. It never writes appData: after a start it re-reads the ticket and asks
// the refresh registry (p86Refresh('co', ...)) to reload the job's change orders.
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : null;

  var PHOTO_MAX = 24;
  var TITLE_MAX = 200;
  var DESCRIPTION_MAX = 2000;
  var UNIT_MAX = 24;

  // The office's short flag labels, as a change order title reads them: 'other'
  // is 'Problem — Bldg 784'.
  var FLAG_TITLE = {
    no_access: 'No access',
    extra_damage: 'Extra damage',
    material_short: 'Material short',
    safety: 'Safety',
    other: 'Problem'
  };

  // "Pending approval", never a bare "Pending": on these screens a bare
  // pending also means a placeholder unit cost and an unsigned PO addendum.
  var STATE_LABEL = { draft: 'Draft', pending: 'Pending approval', approved: 'Approved', applied: 'Applied' };

  var MSG = {
    title: 'Give the change order a title.',
    description: 'Describe the extra work.',
    qty: 'Quantity must be a number above zero.',
    photos: 'Pick up to 24 photos.',
    failed: 'Could not start the change order',
    noEditor: 'Change orders are unavailable — refresh the page.',
    notAllowed: 'You can\'t start a change order on this work order.'
  };

  var _last = { t: null, r: null };

  // ── small helpers ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function list(v) {
    return Array.isArray(v) ? v : [];
  }

  function parseMaybe(v) {
    if (typeof v !== 'string') return v == null ? null : v;
    try { return JSON.parse(v); } catch (e) { return null; }
  }

  function nonBlank(v) {
    return v != null && String(v).trim() !== '';
  }

  function clip(s, max) {
    var chars = Array.from ? Array.from(String(s == null ? '' : s)) : String(s == null ? '' : s).split('');
    return chars.length > max ? chars.slice(0, max).join('') : chars.join('');
  }

  function oneLine(s) {
    return String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  }

  // "Bldg 784" out of "Bldg 784 — Side A: rail post". The host's parser when it
  // is handed one, otherwise the same rule the server uses.
  function headOf(title, parse) {
    if (typeof parse === 'function') {
      try {
        var parsed = parse(title);
        if (parsed && nonBlank(parsed.head)) return String(parsed.head);
      } catch (e) { /* fall back to the plain rule */ }
    }
    var s = oneLine(title);
    var m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(s);
    return (m ? m[1] : s).trim();
  }

  function stateLabel(status) {
    var s = String(status == null ? '' : status);
    if (Object.prototype.hasOwnProperty.call(STATE_LABEL, s)) return STATE_LABEL[s];
    s = s.replace(/_/g, ' ');
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : 'Draft';
  }

  function cosOf(r) {
    return list(r && r.change_orders).filter(function (c) { return c && c.id != null; });
  }

  // The newest change order started from exactly this source, or null.
  function linkedFor(cos, kind, id) {
    if (id == null || id === '') return null;
    var found = null;
    list(cos).forEach(function (c) {
      if (c && c.source_kind === kind && c.source_id != null && String(c.source_id) === String(id)) found = c;
    });
    return found;
  }

  function hasCap(key) {
    try {
      var a = W && W.p86Auth;
      return !!(a && typeof a.hasCapability === 'function' && a.hasCapability(key));
    } catch (e) { return false; }
  }

  // Fail OPEN like the host (the server still refuses): only an explicit
  // _canEdit:false on the job hides the button.
  function jobEditable(jobId) {
    try {
      var jobs = (W && W.appData && W.appData.jobs) || [];
      for (var i = 0; i < jobs.length; i++) {
        if (jobs[i] && String(jobs[i].id) === String(jobId)) return jobs[i]._canEdit !== false;
      }
    } catch (e) { /* no store: fail open */ }
    return true;
  }

  function canStart(t) {
    return !!(t && t.job_id && !t.archived_at && t.status !== 'cancelled' &&
      jobEditable(t.job_id) && hasCap('ESTIMATES_EDIT'));
  }

  // Opening a change order shows its prices, so only people who work with them.
  function canOpenCos() {
    return hasCap('ESTIMATES_EDIT') || hasCap('ESTIMATES_VIEW') || hasCap('FINANCIALS_VIEW');
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
    if (kind === 'error' && typeof console !== 'undefined') console.error('[ticket-co] ' + msg);
  }

  function setContext(t, r) {
    _last = { t: t || null, r: r || null };
  }

  // ── markup ────────────────────────────────────────────────────────────────
  function chipHTML(cos) {
    var rows = list(cos);
    var draft = rows.some(function (c) { return c && c.status === 'draft'; });
    if (draft) {
      return '<span class="p86-st-co-chip is-draft" title="A change order was started from this work order. Office only.">CO draft</span>';
    }
    var pending = rows.some(function (c) { return c && c.status === 'pending'; });
    if (pending) {
      return '<span class="p86-st-co-chip is-pending" title="A change order from this work order is with the owner for approval. Office only.">CO pending</span>';
    }
    var approved = rows.some(function (c) { return c && (c.status === 'approved' || c.status === 'applied'); });
    if (approved) {
      return '<span class="p86-st-co-chip is-approved" title="A change order started from this work order was approved. Office only.">CO approved</span>';
    }
    return '';
  }

  function rowChipHTML(row) {
    var n = Number(row && row.co_draft_count);
    if (!isFinite(n) || n <= 0) return '';
    return '<span class="p86-st-co-chip is-draft" title="A draft change order was started from this work order">CO draft</span>';
  }

  function listHTML(cos, opts) {
    var rows = list(cos).filter(function (c) { return c && c.id != null; });
    if (!rows.length) return '';
    var canOpen = !(opts && opts.canOpen === false);
    return '<div class="p86-st-cos">' +
      '<label class="p86-st-lbl">Change orders <span class="p86-st-co-note">Office only — not on the crew link</span></label>' +
      rows.map(function (c) {
        var state = String(c.status || 'draft');
        return '<div class="p86-st-co-row" data-co-row="' + esc(c.id) + '">' +
          '<span class="p86-st-co-num">' + esc(c.co_number || 'CO') + '</span>' +
          '<span class="p86-st-co-title">' + esc(c.title || 'Untitled change order') + '</span>' +
          '<span class="p86-st-co-state is-' + esc(state.replace(/[^a-z_]/gi, '')) + '">' + esc(stateLabel(state)) + '</span>' +
          (canOpen
            ? '<button type="button" class="ee-btn secondary p86-st-co-open" data-co-open="' + esc(c.id) + '">Open</button>'
            : '') +
        '</div>';
      }).join('') +
    '</div>';
  }

  function actionButtonHTML() {
    return '<button type="button" class="ee-btn secondary p86-st-co-start" data-co-src="ticket">Start change order</button>';
  }

  // opts.canStart / opts.canOpen default to true, so a bare call answers the
  // button itself.
  function sourceButtonHTML(kind, id, cos, opts) {
    var o = opts || {};
    var rows = arguments.length >= 3 ? cos : cosOf(_last.r);
    var linked = linkedFor(rows, kind, id);
    if (linked) {
      var label = esc((linked.co_number || 'CO') + ' started');
      if (o.canOpen === false) return '<span class="p86-st-co-src is-linked">' + label + '</span>';
      return '<button type="button" class="p86-st-co-src is-linked" data-co-open="' + esc(linked.id) + '">' + label + '</button>';
    }
    if (o.canStart === false || id == null || id === '') return '';
    return '<button type="button" class="p86-st-co-src" data-co-src="' + esc(kind) + '" data-co-src-id="' + esc(id) + '">Start change order</button>';
  }

  // ── prefill ───────────────────────────────────────────────────────────────
  function photoIdsOf(photos) {
    var out = [];
    list(photos).forEach(function (p) {
      if (!p || p.id == null) return;
      var id = String(p.id);
      if (out.indexOf(id) < 0 && out.length < PHOTO_MAX) out.push(id);
    });
    return out;
  }

  function findById(rows, id) {
    for (var i = 0; i < rows.length; i++) {
      if (rows[i] && String(rows[i].id) === String(id)) return rows[i];
    }
    return null;
  }

  /**
   * prefillFor(kind, id, context) -> {kind, id, title, description, photoIds}
   * context: {ticket, tasks, revisions, flags, parseSubtaskTitle?} or a host
   * ctx ({t, r, parseSubtaskTitle}).
   */
  function prefillFor(kind, id, context) {
    var c = context || {};
    var r = c.r || {};
    var t = c.ticket || c.t || r.ticket || {};
    var tasks = list(c.tasks || r.tasks);
    var parse = c.parseSubtaskTitle;
    var ticketTitle = oneLine(t.title) || 'this work order';
    var out = {
      kind: kind === 'revision' || kind === 'building_note' || kind === 'flag' ? kind : 'ticket',
      id: kind === 'ticket' || id == null ? null : String(id),
      title: 'Extra work — ' + ticketTitle,
      description: '',
      photoIds: []
    };

    if (out.kind === 'revision') {
      var rev = findById(list(c.revisions || r.revisions), id);
      if (rev) {
        var fields = parseMaybe(rev.fields) || {};
        out.description = [rev.note, fields.scope_proposed]
          .filter(nonBlank)
          .map(function (s) { return String(s).trim(); })
          .join('\n\n');
      }
    } else if (out.kind === 'building_note') {
      for (var i = 0; i < tasks.length; i++) {
        var task = tasks[i];
        var note = null;
        list(task && task.notes).forEach(function (n) {
          if (n && n.id != null && String(n.id) === String(id)) note = n;
        });
        if (note) {
          out.title = 'Extra work — ' + (headOf(task.title, parse) || ticketTitle);
          out.description = String(note.note == null ? '' : note.note).trim();
          out.photoIds = photoIdsOf(task.photos);
          break;
        }
      }
    } else if (out.kind === 'flag') {
      var flag = findById(list(c.flags || r.flags), id);
      if (flag) {
        var label = Object.prototype.hasOwnProperty.call(FLAG_TITLE, flag.category) ? FLAG_TITLE[flag.category] : FLAG_TITLE.other;
        var onTask = flag.task_id != null ? findById(tasks, flag.task_id) : null;
        var where = onTask ? headOf(onTask.title, parse)
          : (nonBlank(flag.task_title) ? headOf(flag.task_title, parse) : ticketTitle);
        out.title = label + ' — ' + (where || ticketTitle);
        out.description = String(flag.note == null ? '' : flag.note).trim();
        out.photoIds = photoIdsOf(flag.photos);
      }
    }

    out.title = clip(out.title, TITLE_MAX);
    out.description = clip(out.description, DESCRIPTION_MAX);
    return out;
  }

  // The photos the dialog offers, grouped: the problem's own photos (for a flag),
  // each building by its heading, then the work order's site photos.
  function photoGroups(kind, id, context) {
    var c = context || {};
    var r = c.r || {};
    var parse = c.parseSubtaskTitle;
    var seen = {};
    var groups = [];
    function add(head, photos) {
      var rows = list(photos).filter(function (p) {
        if (!p || p.id == null || seen[String(p.id)]) return false;
        seen[String(p.id)] = true;
        return true;
      });
      if (rows.length) groups.push({ head: head, photos: rows });
    }
    if (kind === 'flag') {
      var flag = findById(list(c.flags || r.flags), id);
      if (flag) add('Photos on this problem', flag.photos);
    }
    list(c.tasks || r.tasks).forEach(function (task) {
      if (task) add(headOf(task.title, parse) || 'Building', task.photos);
    });
    add('Site photos', c.site_photos || r.site_photos);
    return groups;
  }

  function jobLabel(r) {
    var s = (r && r.site) || {};
    var parts = [s.job_number, s.name].filter(nonBlank).map(function (x) { return String(x).trim(); });
    return parts.length ? parts.join(' · ') : 'the job';
  }

  // ── opening a change order ──────────────────────────────────────────────
  function refreshAfter(ctx) {
    var host = W && W.p86ServiceTickets;
    if (host && typeof host.refresh === 'function') {
      try { return host.refresh(); } catch (e) { /* fall through */ }
    }
    if (ctx && typeof ctx.refresh === 'function') return ctx.refresh();
    return undefined;
  }

  function openCo(coId, ctx) {
    var editor = W && W.p86ChangeOrders;
    if (!coId || !editor || typeof editor.open !== 'function') {
      toast(MSG.noEditor, 'error', ctx);
      return false;
    }
    editor.open(coId, { onClose: function () { refreshAfter(ctx); } });
    return true;
  }

  // ── the dialog ────────────────────────────────────────────────────────────
  var _open = null;

  function close() {
    if (!_open) return;
    var o = _open;
    _open = null;
    try { o.doc.removeEventListener('keydown', o.onKey, true); } catch (e) { /* gone */ }
    if (o.back && o.back.parentNode) o.back.parentNode.removeChild(o.back);
    if (o.returnFocus && typeof o.returnFocus.focus === 'function') {
      try { o.returnFocus.focus(); } catch (e) { /* not focusable */ }
    }
  }

  function photoGridHTML(groups, ticked) {
    if (!groups.length) return '<div class="p86-st-co-empty">No photos on this work order yet.</div>';
    return groups.map(function (g) {
      return '<div class="p86-st-co-group">' +
        '<div class="p86-st-co-group-head">' + esc(g.head) + '</div>' +
        '<div class="p86-st-co-photos">' + g.photos.map(function (p) {
          var src = p.thumb_url || p.web_url || '';
          var on = ticked.indexOf(String(p.id)) >= 0;
          return '<label class="p86-st-co-photo' + (on ? ' is-on' : '') + '">' +
            '<input type="checkbox" class="p86-st-co-pick" value="' + esc(p.id) + '"' + (on ? ' checked' : '') + ' />' +
            (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" />' : '<span class="p86-st-co-nothumb">Photo</span>') +
          '</label>';
        }).join('') + '</div>' +
      '</div>';
    }).join('');
  }

  function dialogHTML(pre, groups, r) {
    return '<div class="p86-st-modal p86-st-co-modal" role="dialog" aria-modal="true" aria-labelledby="p86StCoHead">' +
      '<div class="p86-st-modal-head" id="p86StCoHead">Start a change order</div>' +
      '<div class="p86-st-co-sub">Creates a draft change order on ' + esc(jobLabel(r)) +
        '. You price it in the change order. Nothing is added to the crew link.</div>' +
      '<label class="p86-st-lbl" for="p86StCoTitle">Title</label>' +
      '<input type="text" id="p86StCoTitle" class="p86-st-co-title-in" maxlength="' + TITLE_MAX + '" value="' + esc(pre.title) + '" />' +
      '<label class="p86-st-lbl" for="p86StCoDesc">What is the extra work?</label>' +
      '<textarea id="p86StCoDesc" class="p86-st-co-desc" rows="4" maxlength="' + DESCRIPTION_MAX + '" placeholder="What did the crew find, and where?">' +
        esc(pre.description) + '</textarea>' +
      '<div class="p86-st-modal-row">' +
        '<div><label class="p86-st-lbl" for="p86StCoQty">Quantity</label>' +
          '<input type="number" id="p86StCoQty" class="p86-st-co-qty" step="any" min="0" value="1" /></div>' +
        '<div><label class="p86-st-lbl" for="p86StCoUnit">Unit</label>' +
          '<input type="text" id="p86StCoUnit" class="p86-st-co-unit" maxlength="' + UNIT_MAX + '" value="ea" /></div>' +
      '</div>' +
      '<label class="p86-st-lbl">Photos</label>' +
      '<div class="p86-st-co-help">Tick the photos that show the extra work. Up to 24.</div>' +
      photoGridHTML(groups, pre.photoIds) +
      '<div class="p86-st-co-dupe" role="alert" hidden></div>' +
      '<div class="p86-st-co-err" role="alert" hidden></div>' +
      '<div class="p86-st-modal-actions">' +
        '<button type="button" class="ee-btn secondary p86-st-co-cancel">Cancel</button>' +
        '<button type="button" class="ee-btn primary p86-st-co-go">Create draft change order</button>' +
      '</div>' +
    '</div>';
  }

  function showError(o, msg) {
    var box = o.back.querySelector('.p86-st-co-err');
    if (!box) return;
    box.textContent = msg || '';
    box.hidden = !msg;
  }

  function setBusy(o, busy) {
    o.busy = busy;
    Array.prototype.forEach.call(o.back.querySelectorAll('.p86-st-co-go, .p86-st-co-again'), function (b) {
      b.disabled = busy;
    });
    var go = o.back.querySelector('.p86-st-co-go');
    if (go) go.textContent = busy ? 'Creating…' : 'Create draft change order';
  }

  function picked(o) {
    return Array.prototype.filter.call(o.back.querySelectorAll('.p86-st-co-pick'), function (x) { return x.checked; })
      .map(function (x) { return x.value; });
  }

  function payloadOf(o, allowDuplicate) {
    var q = o.back.querySelector('.p86-st-co-qty');
    var rawQty = q ? String(q.value || '').trim() : '';
    var unitIn = o.back.querySelector('.p86-st-co-unit');
    var payload = {
      source: o.kind === 'ticket' ? { kind: 'ticket' } : { kind: o.kind, id: o.id },
      title: String(o.back.querySelector('.p86-st-co-title-in').value || '').trim(),
      description: String(o.back.querySelector('.p86-st-co-desc').value || '').trim(),
      qty: rawQty === '' ? 1 : Number(rawQty),
      unit: String((unitIn && unitIn.value) || '').trim() || 'ea',
      photo_ids: picked(o)
    };
    var editor = W && W.p86ChangeOrders;
    if (editor && typeof editor.defaultTerms === 'string' && editor.defaultTerms) payload.terms = editor.defaultTerms;
    if (allowDuplicate) payload.allow_duplicate = true;
    return payload;
  }

  function checkPayload(p) {
    if (!p.title) return { field: '.p86-st-co-title-in', error: MSG.title };
    if (!p.description) return { field: '.p86-st-co-desc', error: MSG.description };
    if (!isFinite(p.qty) || p.qty <= 0 || p.qty > 1000000) return { field: '.p86-st-co-qty', error: MSG.qty };
    if (p.photo_ids.length > PHOTO_MAX) return { field: null, error: MSG.photos };
    return null;
  }

  function showDuplicate(o, existing) {
    var box = o.back.querySelector('.p86-st-co-dupe');
    if (!box) return;
    var num = existing.co_number || 'CO';
    box.innerHTML = '<div class="p86-st-co-dupe-msg">A change order was already started from this: ' +
        esc(num) + ' (' + esc(stateLabel(existing.status)) + ').</div>' +
      '<div class="p86-st-co-dupe-acts">' +
        '<button type="button" class="ee-btn secondary p86-st-co-dupe-open" data-co-existing="' + esc(existing.id) + '">Open ' + esc(num) + '</button>' +
        '<button type="button" class="ee-btn secondary p86-st-co-again">Start another</button>' +
      '</div>';
    box.hidden = false;
  }

  function submit(o, allowDuplicate) {
    if (o.busy) return null;
    var st = api();
    showError(o, '');
    var payload = payloadOf(o, allowDuplicate);
    var problem = checkPayload(payload);
    if (problem) {
      showError(o, problem.error);
      var el = problem.field && o.back.querySelector(problem.field);
      if (el) { try { el.focus(); } catch (e) { /* not focusable */ } }
      return null;
    }
    if (!st || typeof st.startChangeOrder !== 'function') {
      showError(o, MSG.failed);
      return null;
    }
    var dupe = o.back.querySelector('.p86-st-co-dupe');
    if (dupe) dupe.hidden = true;
    setBusy(o, true);
    var ticket = o.ctx.t || {};
    return Promise.resolve()
      .then(function () { return st.startChangeOrder(ticket.id, payload); })
      .then(function (res) {
        setBusy(o, false);
        var co = (res && res.change_order) || {};
        toast(co.co_number ? 'Draft change order ' + co.co_number + ' created' : 'Draft change order created', 'success', o.ctx);
        close();
        if (typeof o.ctx.refresh === 'function') {
          try { o.ctx.refresh(); } catch (e) { /* the re-read is a convenience */ }
        }
        if (W && typeof W.p86Refresh === 'function') W.p86Refresh('co', { id: co.id, jobId: co.job_id || ticket.job_id });
        if (co.id) openCo(co.id, o.ctx);
        return res;
      }, function (err) {
        setBusy(o, false);
        var data = err && err.data;
        if (err && err.status === 409 && data && data.existing && data.existing.id != null) {
          showDuplicate(o, data.existing);
          return null;
        }
        showError(o, (err && err.message) || MSG.failed);
        return null;
      });
  }

  function open(kind, id, ctx) {
    var doc = W && W.document;
    if (!doc) return null;
    var c = ctx || { t: _last.t, r: _last.r };
    var t = c.t || (c.r && c.r.ticket) || {};
    if (!canStart(t)) {
      toast(MSG.notAllowed, 'error', c);
      return null;
    }
    close();
    var k = kind === 'revision' || kind === 'building_note' || kind === 'flag' ? kind : 'ticket';
    var pre = prefillFor(k, id, c);
    var groups = photoGroups(k, id, c);

    var back = doc.createElement('div');
    back.className = 'p86-st-modal-back p86-st-co-back';
    back.innerHTML = dialogHTML(pre, groups, c.r || {});
    var o = {
      doc: doc, back: back, ctx: c, kind: k, id: pre.id, busy: false,
      returnFocus: doc.activeElement,
      prefill: pre,
      onKey: function (ev) {
        if (ev.key === 'Escape' && _open === o) { ev.preventDefault(); close(); }
      }
    };

    back.addEventListener('click', function (ev) {
      var target = ev.target;
      if (target === back) {
        // A backdrop click closes only while nothing was typed over the prefill.
        var title = back.querySelector('.p86-st-co-title-in');
        var desc = back.querySelector('.p86-st-co-desc');
        if (!o.busy && title && desc && title.value === pre.title && desc.value === pre.description) close();
        return;
      }
      if (!target || !target.closest) return;
      if (target.closest('.p86-st-co-cancel')) { close(); return; }
      if (target.closest('.p86-st-co-go')) { submit(o, false); return; }
      if (target.closest('.p86-st-co-again')) { submit(o, true); return; }
      var existing = target.closest('[data-co-existing]');
      if (existing) {
        var coId = existing.getAttribute('data-co-existing');
        close();
        openCo(coId, c);
      }
    });
    back.addEventListener('change', function (ev) {
      var box = ev.target;
      if (!box || !box.classList || !box.classList.contains('p86-st-co-pick')) return;
      if (box.checked && picked(o).length > PHOTO_MAX) {
        box.checked = false;
        showError(o, MSG.photos);
      } else {
        showError(o, '');
      }
      var tile = box.closest ? box.closest('.p86-st-co-photo') : null;
      if (tile) tile.classList.toggle('is-on', !!box.checked);
    });

    doc.body.appendChild(back);
    doc.addEventListener('keydown', o.onKey, true);
    _open = o;
    var first = back.querySelector(pre.description ? '.p86-st-co-go' : '.p86-st-co-desc');
    if (first) { try { first.focus(); } catch (e) { /* not focusable */ } }
    return o;
  }

  // ── wiring on the ticket screen ─────────────────────────────────────────
  function wire(d, ctx) {
    if (!d || typeof d.addEventListener !== 'function' || d.__p86CoWired) return;
    d.__p86CoWired = true;
    d.addEventListener('click', function (ev) {
      var target = ev.target && ev.target.closest ? ev.target : null;
      if (!target) return;
      // The host keeps one ctx per detail element and updates it in place; read
      // it at click time so a button drawn before an update acts on the ticket
      // as it is now.
      var live = d._st || ctx || { t: _last.t, r: _last.r };
      var openBtn = target.closest('[data-co-open]');
      if (openBtn && d.contains(openBtn)) {
        ev.preventDefault();
        openCo(openBtn.getAttribute('data-co-open'), live);
        return;
      }
      var src = target.closest('[data-co-src]');
      if (src && d.contains(src)) {
        ev.preventDefault();
        open(src.getAttribute('data-co-src'), src.getAttribute('data-co-src-id'), live);
      }
    });
  }

  // ── timeline ─────────────────────────────────────────────────────────────
  function eventWhat(event, helpers) {
    if (!event || event.kind !== 'change_order_started') return null;
    var h = helpers || {};
    var d = h.detail && typeof h.detail === 'object' ? h.detail : (parseMaybe(event.detail) || {});
    var head = '';
    if (d.task_id != null && typeof h.head === 'function') {
      try { head = h.head(d.task_id) || ''; } catch (e) { head = ''; }
    }
    var text = nonBlank(d.co_number) ? 'started change order ' + String(d.co_number) : 'started a change order';
    if (d.source_kind === 'revision') text += ' from a suggestion';
    else if (d.source_kind === 'building_note') text += head ? ' from a note on ' + head : ' from a building note';
    else if (d.source_kind === 'flag') text += head ? ' from a flag on ' + head : ' from a flagged problem';
    return esc(text);
  }

  // ── registration ─────────────────────────────────────────────────────────
  function sourceOpts(ctx) {
    var t = (ctx && ctx.t) || {};
    return { canStart: canStart(t), canOpen: canOpenCos() };
  }

  var extension = {
    order: 50,
    rowBadges: function (row) {
      return rowChipHTML(row);
    },
    detailSections: function (ctx) {
      var c = ctx || {};
      var t = c.t || {};
      var cos = cosOf(c.r);
      setContext(t, c.r);
      registerFlagAction();
      return [
        { key: 'co-chip', slot: 'statusMeta', html: chipHTML(cos) },
        { key: 'co-list', slot: 'afterRevisions', html: listHTML(cos, { canOpen: canOpenCos() }) },
        { key: 'co-start', slot: 'actions', html: canStart(t) ? actionButtonHTML() : '' }
      ];
    },
    revisionActions: function (rev, ctx) {
      if (!rev || rev.id == null) return '';
      var html = sourceButtonHTML('revision', rev.id, cosOf(ctx && ctx.r), sourceOpts(ctx));
      return html ? '<div class="p86-st-co-srcwrap">' + html + '</div>' : '';
    },
    noteActions: function (note, task, ctx) {
      if (!note || note.id == null) return '';
      return sourceButtonHTML('building_note', note.id, cosOf(ctx && ctx.r), sourceOpts(ctx));
    },
    wireDetail: function (d, ctx) {
      wire(d, ctx);
    },
    eventWhat: eventWhat
  };

  // The Start change order button on each flagged problem. html() draws it (or
  // "CO-4 started"), and the click is caught by wire() on the detail element.
  function registerFlagAction() {
    var flags = W && W.p86TicketFlags;
    if (!flags || typeof flags.registerAction !== 'function') return false;
    return flags.registerAction({
      key: 'co',
      label: 'Start change order',
      title: 'Start a draft change order from this problem. Office only.',
      visible: function (f, t, ctx) {
        if (!f || f.id == null) return false;
        var live = (ctx && ctx.t) || t;
        return canStart(live) || !!linkedFor(cosOf(ctx && ctx.r), 'flag', f.id);
      },
      run: function (f, t, ctx) {
        open('flag', f.id, ctx || { t: t, r: _last.r });
      },
      html: function (f, t, ctx) {
        var c = ctx || { t: t, r: _last.r };
        return sourceButtonHTML('flag', f.id, cosOf(c.r), sourceOpts(c));
      }
    });
  }

  var publicApi = {
    canStart: canStart,
    setContext: setContext,
    chipHTML: chipHTML,
    rowChipHTML: rowChipHTML,
    listHTML: listHTML,
    actionButtonHTML: actionButtonHTML,
    sourceButtonHTML: sourceButtonHTML,
    prefillFor: prefillFor,
    wire: wire,
    open: open,
    close: close,
    eventWhat: eventWhat,
    extension: extension
  };

  if (W) {
    W.p86ServiceTicketCo = publicApi;
    var registerWithTicketScreen = function () {
      registerFlagAction();
      if (!W.p86StExt || typeof W.p86StExt.register !== 'function') return false;
      return W.p86StExt.register('ticket-co', extension);
    };
    if (!registerWithTicketScreen() && W.document && W.document.readyState === 'loading') {
      W.document.addEventListener('DOMContentLoaded', registerWithTicketScreen);
    } else if (W.document && W.document.readyState === 'loading') {
      // Registered already; the flags module may still be on its way.
      W.document.addEventListener('DOMContentLoaded', registerFlagAction);
    }
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      __test: {
        prefillFor: prefillFor,
        photoGroups: photoGroups,
        chipHTML: chipHTML,
        rowChipHTML: rowChipHTML,
        listHTML: listHTML,
        sourceButtonHTML: sourceButtonHTML,
        eventWhat: eventWhat,
        FLAG_TITLE: FLAG_TITLE
      }
    };
  }
})();
