// Problems the crew flagged — the office side (Work Orders 1.29, "Flag a problem").
//
// window.p86TicketFlags. A crew link holder can flag a problem on a work order
// or on one building. This module is everything the office sees of that:
//
//   rowBadgesHTML(row)        the ticket list badges: "N problems" (red, on any
//                             ticket with an open flag), "N suggestions waiting"
//                             and "New from crew" (both only while the ticket is
//                             not closed or cancelled).
//   panelHTML(flags, ticket, {canResolve, headOf, ctx})
//                             "Problems from the crew" on the open ticket: open
//                             cards first, resolved ones behind "Show N resolved".
//   wire(el, ticket, {canResolve, onChanged, ctx})
//                             one delegated listener: Resolve (with its note),
//                             photo thumbs, the resolved toggle, card actions.
//   eventWhat(event, head)    the timeline wording for flag_raised,
//                             flag_resolved and a photo added to a problem.
//   openFlagsByTask(flags)    { taskId: open count } for the "Needs office" chip.
//   fillJobChip(jobId, rows?) the count on the job's Service Tickets section.
//   markSeen(rowEl, row, rows, jobId, seen?)
//                             clears "New from crew" once the office has opened
//                             the ticket (the server stamped office_seen).
//   registerAction({key, label, title, visible, run, html?})
//                             a button in every card's actions slot (Start
//                             change order registers here).
//
// It registers with window.p86StExt as 'ticket-flags' (order 30), so
// js/service-tickets.js never calls it by name.
//
// The resolve note is SHOWN ON THE CREW LINK. The placeholder says so, and says
// no prices, because a PM typing "charged them $300" would put it in front of
// the crew. Everything interpolated is escaped. Category labels here are the
// office's short ones; the crew page has its own wording.
(function () {
  'use strict';

  var CATEGORY_LABEL = {
    no_access: 'No access',
    extra_damage: 'Extra damage',
    material_short: 'Material short',
    safety: 'Safety',
    other: 'Other'
  };

  var RESOLVE_FIRST = 'Say how it was handled first — the crew sees this note.';
  var RESOLVED_TOAST = 'Problem resolved';
  var RESOLVE_FAILED = 'Failed to resolve the problem';
  var NOTE_PLACEHOLDER = 'How was it handled? Shown on the crew link — no prices.';
  var CHIP_TTL_MS = 60 * 1000;
  var CHIP_TAB = 'job-service-tickets';

  var _actions = [];
  var _flagsByTicket = {};   // ticketId -> the flags last painted, for clicks
  var _showResolved = {};    // ticketId -> true while "Show N resolved" is open
  var _chipRows = {};        // jobId -> { at, rows }
  var _chipLoading = {};     // jobId -> Promise

  // ── small helpers ─────────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // An instant (created_at, resolved_at) in the viewer's own zone.
  function fmtWhen(v) {
    if (!v) return '';
    var d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  }

  function countOf(v) {
    var n = Number(v);
    return isFinite(n) && n > 0 ? Math.floor(n) : 0;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  function isTerminal(row) {
    var s = row && row.status;
    return s === 'closed' || s === 'cancelled';
  }

  function categoryLabel(cat) {
    return Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, cat) ? CATEGORY_LABEL[cat] : CATEGORY_LABEL.other;
  }

  function api() {
    return (window.p86Api && window.p86Api.serviceTickets) || null;
  }

  function toast(msg, kind) {
    if (typeof window.p86Toast === 'function') {
      try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (kind === 'error' && typeof console !== 'undefined') console.error('[ticket-flags] ' + msg);
  }

  function flagList(flags) {
    return (Array.isArray(flags) ? flags : []).filter(function (f) { return f && f.id != null; });
  }

  function detailOf(e) {
    var d = e && e.detail;
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (err) { d = null; }
    }
    return d && typeof d === 'object' ? d : {};
  }

  // ── list badges ───────────────────────────────────────────────────────────
  function rowBadgesHTML(row) {
    if (!row) return '';
    var out = '';
    var problems = countOf(row.open_flags);
    if (problems) {
      out += '<span class="p86-st-badge is-flag" title="Open problems flagged by the crew">' +
        plural(problems, 'problem', 'problems') + '</span>';
    }
    if (!isTerminal(row)) {
      var waiting = countOf(row.pending_suggestions);
      if (waiting) {
        out += '<span class="p86-st-badge is-sugg" title="Suggestions from a crew link waiting for you">' +
          plural(waiting, 'suggestion', 'suggestions') + ' waiting</span>';
      }
      if (row.new_from_crew === true) {
        out += '<span class="p86-st-badge is-new" title="The crew added something since this ticket was last opened">New from crew</span>';
      }
    }
    return out;
  }

  // ── the panel ─────────────────────────────────────────────────────────────
  function openFlagsByTask(flags) {
    var out = {};
    flagList(flags).forEach(function (f) {
      if (f.status !== 'open' || f.task_id == null || f.task_id === '') return;
      var k = String(f.task_id);
      out[k] = (out[k] || 0) + 1;
    });
    return out;
  }

  function whereOf(f, headOf) {
    if (f.task_id == null || f.task_id === '') return 'Whole work order';
    var head = '';
    if (typeof headOf === 'function') {
      try { head = headOf(f.task_id) || ''; } catch (e) { head = ''; }
    }
    return head || f.task_title || 'A building';
  }

  function actionsHTML(f, ticket, ctx) {
    return _actions.map(function (a) {
      try {
        if (typeof a.visible === 'function' && !a.visible(f, ticket, ctx)) return '';
        if (typeof a.html === 'function') {
          var custom = a.html(f, ticket, ctx);
          return typeof custom === 'string' ? custom : '';
        }
        return '<button type="button" class="ee-btn secondary p86-st-flag-act" data-flag-act="' + esc(a.key) + '"' +
          (a.title ? ' title="' + esc(a.title) + '"' : '') + '>' + esc(a.label) + '</button>';
      } catch (e) {
        if (typeof console !== 'undefined') console.warn('[ticket-flags] action ' + a.key, e);
        return '';
      }
    }).join('');
  }

  function cardHTML(f, ticket, opts) {
    var open = f.status === 'open';
    var cat = Object.prototype.hasOwnProperty.call(CATEGORY_LABEL, f.category) ? f.category : 'other';
    var photos = Array.isArray(f.photos) ? f.photos : [];
    var when = fmtWhen(f.created_at);

    var html = '<div class="p86-st-flag ' + (open ? 'is-open' : 'is-resolved') + ' cat-' + esc(cat) + '" data-flag="' + esc(f.id) + '">' +
      '<div class="p86-st-flag-head">' +
        '<span class="p86-st-flag-cat">' + esc(categoryLabel(cat)) + '</span>' +
        '<span class="p86-st-flag-where">' + esc(whereOf(f, opts.headOf)) + '</span>' +
        // author_label is a CLAIM typed on the link, never an identity.
        '<span class="p86-st-flag-who">' + (f.author_label ? esc(f.author_label) : 'Someone on the link') +
          '<span class="p86-st-rev-claim" title="Typed by the guest. Nobody signed in to prove it.">unverified</span>' +
        '</span>' +
        (when ? '<span class="p86-st-flag-when">' + esc(when) + '</span>' : '') +
        (f.via_revoked_link
          ? '<span class="p86-st-rev-revoked" title="The link this came through has since been turned off. The problem is kept.">link revoked</span>'
          : '') +
      '</div>' +
      '<div class="p86-st-flag-note">' + esc(f.note) + '</div>';

    if (photos.length) {
      html += '<div class="p86-st-flag-photos">' + photos.map(function (p, i) {
        var src = p && (p.thumb_url || p.web_url);
        return '<button type="button" class="p86-st-flag-thumb" data-flag-photo="' + i + '" aria-label="Open photo ' + (i + 1) + '">' +
          (src ? '<img src="' + esc(src) + '" alt="" loading="lazy" />' : '') +
        '</button>';
      }).join('') + '</div>';
    }

    if (open && opts.canResolve) {
      html += '<div class="p86-st-flag-resolve">' +
        '<input type="text" class="p86-st-flag-note-in" maxlength="1000" placeholder="' + esc(NOTE_PLACEHOLDER) + '" aria-label="How it was handled" />' +
        '<button type="button" class="ee-btn secondary p86-st-flag-resolve-go">Resolve</button>' +
      '</div>';
    }

    if (!open) {
      var resolvedWhen = fmtWhen(f.resolved_at);
      html += '<div class="p86-st-flag-res">Resolved by ' + esc(f.resolved_by_name || 'the office') +
        (resolvedWhen ? ' · ' + esc(resolvedWhen) : '') +
        (f.resolution_note ? ' — ' + esc(f.resolution_note) : '') +
      '</div>';
    }

    html += '<div class="p86-st-flag-acts">' + actionsHTML(f, ticket, opts.ctx) + '</div>';
    return html + '</div>';
  }

  function panelHTML(flags, ticket, opts) {
    var o = opts || {};
    var t = ticket || {};
    var list = flagList(flags);
    if (t.id != null) _flagsByTicket[String(t.id)] = list;
    if (!list.length) return '';

    var open = list.filter(function (f) { return f.status === 'open'; });
    var resolved = list.filter(function (f) { return f.status !== 'open'; });
    var showing = !!_showResolved[String(t.id)];

    var html = '<div class="p86-st-flags' + (open.length ? ' has-open' : '') + '" data-flags-ticket="' + esc(t.id) + '">' +
      '<label class="p86-st-lbl">Problems from the crew' +
        (open.length ? ' <span class="p86-st-flags-badge">' + open.length + ' open</span>' : '') +
      '</label>' +
      open.map(function (f) { return cardHTML(f, t, o); }).join('');

    if (resolved.length) {
      html += '<button type="button" class="p86-st-flags-more" aria-expanded="' + (showing ? 'true' : 'false') + '" data-resolved-count="' + resolved.length + '">' +
          (showing ? 'Hide resolved' : 'Show ' + resolved.length + ' resolved') +
        '</button>' +
        '<div class="p86-st-flags-resolved"' + (showing ? '' : ' hidden') + '>' +
          resolved.map(function (f) { return cardHTML(f, t, o); }).join('') +
        '</div>';
    }
    return html + '</div>';
  }

  // ── wiring ────────────────────────────────────────────────────────────────
  function stateOf(el) {
    return el.__p86FlagsState || { ticket: {}, opts: {} };
  }

  function flagById(ticket, opts, id) {
    var list = flagList(opts && opts.flags ? opts.flags : _flagsByTicket[String(ticket && ticket.id)]);
    for (var i = 0; i < list.length; i++) {
      if (String(list[i].id) === String(id)) return list[i];
    }
    return null;
  }

  function resolveCard(card, ticket, opts) {
    if (!card || card.__p86Resolving) return;
    var input = card.querySelector('.p86-st-flag-note-in');
    var button = card.querySelector('.p86-st-flag-resolve-go');
    var note = input ? String(input.value || '').trim() : '';
    if (!note) {
      if (input) { try { input.focus(); } catch (e) { /* not focusable */ } }
      toast(RESOLVE_FIRST, 'error');
      return;
    }
    var st = api();
    if (!st || typeof st.resolveFlag !== 'function') {
      toast(RESOLVE_FAILED, 'error');
      return;
    }
    card.__p86Resolving = true;
    if (button) button.disabled = true;
    var flagId = card.getAttribute('data-flag');
    var done = function () {
      card.__p86Resolving = false;
      if (button) button.disabled = false;
    };
    return Promise.resolve()
      .then(function () { return st.resolveFlag(ticket.id, flagId, note); })
      .then(function () {
        // Emptied before the refresh, so the host does not hold the paint for
        // a typed note that has already been saved.
        if (input) input.value = '';
        done();
        toast(RESOLVED_TOAST, 'success');
        if (opts && typeof opts.onChanged === 'function') return opts.onChanged();
      }, function (err) {
        done();
        toast((err && err.message) || RESOLVE_FAILED, 'error');
      });
  }

  function toggleResolved(panel, button, ticket) {
    var box = panel && panel.querySelector('.p86-st-flags-resolved');
    if (!box) return;
    var key = String(ticket && ticket.id);
    var showing = !_showResolved[key];
    _showResolved[key] = showing;
    box.hidden = !showing;
    button.setAttribute('aria-expanded', showing ? 'true' : 'false');
    button.textContent = showing ? 'Hide resolved' : 'Show ' + (button.getAttribute('data-resolved-count') || '') + ' resolved';
  }

  function openPhoto(card, index, ticket, opts) {
    var f = flagById(ticket, opts, card.getAttribute('data-flag'));
    var photos = f && Array.isArray(f.photos) ? f.photos : [];
    if (!photos.length) return;
    var viewer = window.p86Attachments;
    if (viewer && typeof viewer.openLightbox === 'function') {
      viewer.openLightbox(photos, index, { parentLabel: 'Problem · ' + categoryLabel(f.category) });
    }
  }

  function runAction(card, key, ticket, opts) {
    var f = flagById(ticket, opts, card.getAttribute('data-flag'));
    if (!f) return;
    for (var i = 0; i < _actions.length; i++) {
      if (_actions[i].key !== key || typeof _actions[i].run !== 'function') continue;
      try { _actions[i].run(f, ticket, opts && opts.ctx); } catch (e) {
        toast((e && e.message) || 'That did not work.', 'error');
      }
      return;
    }
  }

  function onClick(ev) {
    var el = ev.currentTarget;
    var target = ev.target && ev.target.closest ? ev.target : null;
    if (!target) return;
    var st = stateOf(el);
    var ticket = st.ticket;
    var opts = st.opts;

    var more = target.closest('.p86-st-flags-more');
    if (more && el.contains(more)) {
      toggleResolved(more.closest('.p86-st-flags'), more, ticket);
      return;
    }
    var card = target.closest('.p86-st-flag');
    if (!card || !el.contains(card)) return;

    if (target.closest('.p86-st-flag-resolve-go')) {
      if (opts.canResolve) resolveCard(card, ticket, opts);
      return;
    }
    var thumb = target.closest('.p86-st-flag-thumb');
    if (thumb) {
      openPhoto(card, Number(thumb.getAttribute('data-flag-photo')) || 0, ticket, opts);
      return;
    }
    var act = target.closest('[data-flag-act]');
    if (act) runAction(card, act.getAttribute('data-flag-act'), ticket, opts);
  }

  function onKey(ev) {
    if (ev.key !== 'Enter') return;
    var target = ev.target;
    if (!target || !target.classList || !target.classList.contains('p86-st-flag-note-in')) return;
    ev.preventDefault();
    var st = stateOf(ev.currentTarget);
    if (st.opts.canResolve) resolveCard(target.closest('.p86-st-flag'), st.ticket, st.opts);
  }

  // Safe to call on every paint: the listeners go on once per element, and
  // each call refreshes the ticket and options they read at click time.
  function wire(el, ticket, opts) {
    if (!el || typeof el.addEventListener !== 'function') return;
    el.__p86FlagsState = { ticket: ticket || {}, opts: opts || {} };
    if (el.__p86FlagsWired) return;
    el.__p86FlagsWired = true;
    el.addEventListener('click', onClick);
    el.addEventListener('keydown', onKey);
  }

  // ── timeline ──────────────────────────────────────────────────────────────
  // Plain text; the caller escapes it.
  function eventWhat(e, head) {
    if (!e) return null;
    var d = detailOf(e);
    var on = head ? ' on ' + head : '';
    if (e.kind === 'flag_raised') return 'flagged a problem' + on + ' — ' + categoryLabel(d.category);
    if (e.kind === 'flag_resolved') return 'resolved a problem' + on;
    if (e.kind === 'photo_added' && d.flag_id) return 'added a photo to a problem';
    return null;
  }

  // ── the job's Service Tickets chip ────────────────────────────────────────
  function attentionOf(rows) {
    var a = { total: 0, problems: 0, waiting: 0, fresh: 0 };
    (Array.isArray(rows) ? rows : []).forEach(function (r) {
      if (!r || r.archived_at) return;
      var problems = countOf(r.open_flags) > 0;
      var live = !isTerminal(r);
      var waiting = live && countOf(r.pending_suggestions) > 0;
      var fresh = live && r.new_from_crew === true;
      if (problems) a.problems++;
      if (waiting) a.waiting++;
      if (fresh) a.fresh++;
      if (problems || waiting || fresh) a.total++;
    });
    return a;
  }

  function paintJobChip(jobId, rows) {
    var app = window.appState;
    if (!app || app.currentJobId == null || String(app.currentJobId) !== String(jobId)) return false;
    var chip = document.querySelector('[data-jobchip="' + CHIP_TAB + '"]');
    if (!chip) return false;
    var a = attentionOf(rows);
    chip.textContent = a.total ? String(a.total) : '';
    if (a.total) chip.setAttribute('data-tone', a.problems ? 'r' : 'o');
    else chip.removeAttribute('data-tone');

    var tab = (chip.closest && chip.closest('.ws-right-tab')) || chip.parentNode;
    if (tab && tab.setAttribute) {
      if (a.total) {
        var parts = [];
        if (a.problems) parts.push(a.problems + ' with open problems');
        if (a.waiting) parts.push(a.waiting + ' with suggestions waiting');
        if (a.fresh) parts.push(a.fresh + ' new from crew');
        tab.setAttribute('title', 'Service tickets needing you: ' + parts.join(' · '));
        tab.setAttribute('data-flag-title', '1');
      } else if (tab.getAttribute('data-flag-title')) {
        tab.removeAttribute('title');
        tab.removeAttribute('data-flag-title');
      }
    }
    return true;
  }

  // rows given: the list the caller already holds (painted and cached).
  // rows omitted: the cached list while it is under a minute old, else one
  // fetch of the job's tickets (shared by callers that ask at the same time).
  function fillJobChip(jobId, rows) {
    if (jobId == null || jobId === '') return Promise.resolve(false);
    var key = String(jobId);
    if (Array.isArray(rows)) {
      _chipRows[key] = { at: Date.now(), rows: rows };
      return Promise.resolve(paintJobChip(jobId, rows));
    }
    var cached = _chipRows[key];
    if (cached && Date.now() - cached.at < CHIP_TTL_MS) {
      return Promise.resolve(paintJobChip(jobId, cached.rows));
    }
    if (_chipLoading[key]) return _chipLoading[key];
    var st = api();
    if (!st || typeof st.list !== 'function') return Promise.resolve(false);
    var p = Promise.resolve()
      .then(function () { return st.list({ job_id: jobId }); })
      .then(function (res) {
        var list = res && Array.isArray(res.tickets) ? res.tickets : [];
        _chipRows[key] = { at: Date.now(), rows: list };
        return paintJobChip(jobId, list);
      }, function () { return false; })
      .then(function (painted) {
        delete _chipLoading[key];
        return painted;
      });
    _chipLoading[key] = p;
    return p;
  }

  // The office opened the ticket and the server stamped it seen. `seen`, when
  // passed, is the detail read's office_seen: anything but true changes nothing
  // (a caller who can only view the ticket does not clear it for the office).
  function markSeen(rowEl, row, rows, jobId, seen) {
    if (arguments.length >= 5 && seen !== true) return false;
    if (!row) return false;
    var id = String(row.id);
    row.new_from_crew = false;
    var clear = function (list) {
      (Array.isArray(list) ? list : []).forEach(function (r) {
        if (r && String(r.id) === id) r.new_from_crew = false;
      });
    };
    clear(rows);
    var cached = jobId != null ? _chipRows[String(jobId)] : null;
    if (cached) clear(cached.rows);
    if (rowEl && rowEl.querySelectorAll) {
      Array.prototype.forEach.call(rowEl.querySelectorAll('.p86-st-badge.is-new'), function (b) {
        if (b.parentNode) b.parentNode.removeChild(b);
      });
    }
    if (jobId != null) {
      if (Array.isArray(rows)) fillJobChip(jobId, rows);
      else if (cached) paintJobChip(jobId, cached.rows);
    }
    return true;
  }

  // ── card actions (B8 Start change order) ──────────────────────────────────
  function registerAction(action) {
    if (!action || typeof action.key !== 'string' || !action.key) return false;
    if (typeof action.run !== 'function' && typeof action.html !== 'function') return false;
    for (var i = 0; i < _actions.length; i++) {
      if (_actions[i].key === action.key) { _actions[i] = action; return true; }
    }
    _actions.push(action);
    return true;
  }

  // ── registration with the ticket screen ───────────────────────────────────
  function headOfFor(ctx) {
    return function (taskId) {
      if (!ctx || typeof ctx.taskTitle !== 'function') return '';
      var title = ctx.taskTitle(taskId);
      if (!title) return '';
      if (typeof ctx.parseSubtaskTitle === 'function') {
        var parsed = ctx.parseSubtaskTitle(title);
        if (parsed && parsed.head) return parsed.head;
      }
      return title;
    };
  }

  var extension = {
    order: 30,
    rowBadges: function (row) {
      return rowBadgesHTML(row);
    },
    detailSections: function (ctx) {
      var c = ctx || {};
      var r = c.r || {};
      return [{
        key: 'flags',
        slot: 'afterSite',
        html: panelHTML(r.flags || [], c.t || {}, { canResolve: !!c.canEdit, headOf: headOfFor(c), ctx: c }),
        wire: function (node, live) {
          var x = live || c;
          wire(node, x.t || {}, {
            canResolve: !!x.canEdit,
            ctx: x,
            onChanged: function () { return typeof x.refresh === 'function' ? x.refresh() : undefined; }
          });
        }
      }];
    },
    cardMeta: function (task, ctx) {
      var r = ctx && ctx.r;
      if (!task || !r) return '';
      return openFlagsByTask(r.flags)[String(task.id)] ? '<span class="p86-wo-flagchip">Needs office</span>' : '';
    },
    eventWhat: function (event, helpers) {
      var d = detailOf(event);
      var head = '';
      if (d.task_id != null && helpers && typeof helpers.head === 'function') {
        try { head = helpers.head(d.task_id) || ''; } catch (e) { head = ''; }
      }
      var text = eventWhat(event, head);
      return text == null ? null : esc(text);
    },
    onRowExpanded: function (rowEl, row, response, listCtx) {
      var l = listCtx || {};
      markSeen(rowEl, row, l.tickets, l.jobId, !!(response && response.office_seen === true));
    },
    onListPainted: function (host, listCtx) {
      if (listCtx && listCtx.jobId) fillJobChip(listCtx.jobId, listCtx.tickets);
    }
  };

  window.p86TicketFlags = {
    CATEGORY_LABEL: CATEGORY_LABEL,
    rowBadgesHTML: rowBadgesHTML,
    panelHTML: panelHTML,
    wire: wire,
    eventWhat: eventWhat,
    openFlagsByTask: openFlagsByTask,
    fillJobChip: fillJobChip,
    markSeen: markSeen,
    registerAction: registerAction,
    extension: extension
  };

  // The registry normally loads first. If this tag ever lands ahead of it,
  // try again once the page has parsed (registering twice replaces, so a
  // second call is harmless).
  function registerWithTicketScreen() {
    if (!window.p86StExt || typeof window.p86StExt.register !== 'function') return false;
    return window.p86StExt.register('ticket-flags', extension);
  }
  if (!registerWithTicketScreen() && typeof document !== 'undefined' && document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', registerWithTicketScreen);
  }
})();
