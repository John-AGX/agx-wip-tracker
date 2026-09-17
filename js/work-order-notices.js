// Approval notice banner and Notify again — window.p86WorkOrderNotices.
//
// When a work order reaches Work complete the approvers are told by email and
// push (server/services/service-ticket-notify.js). When that notice reaches
// nobody, the server retries it (10 minutes, 1 hour, 4 hours) and then gives
// up. The office sees that here, under the stepper:
//
//   retrying  "The ready-for-approval notice didn't go through. Trying again
//             automatically."
//   gave up   "Nobody has been told this is ready for approval."
//
// with a Notify again button for anyone who can edit the work order. The state
// is read from three ticket columns the ticket read already carries
// (approval_notified_at, approval_notice_attempts, approval_notice_gave_up_at);
// there is no extra request. The button posts
// POST /api/service-tickets/:id/notify-approvers
// (server/routes/work-order-notice-routes.js) and shows the server's own
// sentence, so the wording of what happened lives in one place.
//
// It also words the notice events on the Progress list.
//
// Registers with window.p86StExt as 'work-order-notices', order 20. Inline
// styles only: there is no stylesheet for this module.
(function () {
  'use strict';

  var GAVE_UP = 'Nobody has been told this is ready for approval.';
  var RETRYING = "The ready-for-approval notice didn't go through. Trying again automatically.";
  var FAILED = "The notice didn't go through. It will be tried again automatically.";

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function parseDetail(d) {
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d && typeof d === 'object' ? d : null;
  }

  // 'gave_up' | 'retrying' | null. Only a work order waiting for approval has a
  // notice to worry about; once it moves on, the banner goes.
  function noticeState(ticket) {
    var t = ticket || {};
    if (t.status !== 'work_complete') return null;
    if (t.approval_notice_gave_up_at) return 'gave_up';
    if ((Number(t.approval_notice_attempts) || 0) > 0 && !t.approval_notified_at) return 'retrying';
    return null;
  }

  var TONE = {
    gave_up: '#dc2626',
    retrying: '#d97706'
  };

  // One root element or '' (the host tags the root, contracts 5.2).
  function bannerHTML(ticket, canEdit) {
    var state = noticeState(ticket);
    if (!state) return '';
    var tone = TONE[state];
    return '<div class="p86-won-banner is-' + state + '" role="status" data-state="' + state + '" style="' +
        'display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;margin:8px 0 12px;padding:8px 12px;' +
        'border-radius:8px;font-size:13px;line-height:1.45;color:var(--text, #fff);' +
        'border:1px solid color-mix(in srgb, ' + tone + ' 55%, transparent);' +
        'border-left:4px solid ' + tone + ';' +
        'background:color-mix(in srgb, ' + tone + ' 10%, transparent);">' +
      '<span class="p86-won-text" style="flex:1 1 220px;min-width:0;">' + esc(state === 'gave_up' ? GAVE_UP : RETRYING) + '</span>' +
      (canEdit
        ? '<button type="button" class="ee-btn secondary p86-won-again" style="flex:0 0 auto;">Notify again</button>'
        : '') +
    '</div>';
  }

  function say(opts, msg, kind) {
    if (!msg) return;
    if (opts && typeof opts.toast === 'function') {
      try { opts.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (typeof window.p86Toast === 'function') {
      try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (kind === 'error' && typeof console !== 'undefined') console.error('[work-order-notices] ' + msg);
  }

  function settle(opts) {
    try {
      if (opts && typeof opts.onDone === 'function') return Promise.resolve(opts.onDone());
    } catch (e) { /* the toast already said what happened */ }
    return Promise.resolve();
  }

  function sendAgain(btn, ticket, opts) {
    var label = btn.textContent;
    function restore() {
      // A re-read that paints the same banner keeps this very button, so it
      // must not stay on "Sending…".
      btn.disabled = false;
      btn.textContent = label;
      btn.removeAttribute('aria-busy');
    }
    var st = window.p86Api && window.p86Api.serviceTickets;
    if (!st || typeof st.notifyApprovers !== 'function' || !ticket || ticket.id == null) {
      say(opts, 'Reload the page to send the notice.', 'error');
      return Promise.resolve();
    }
    btn.disabled = true;
    btn.textContent = 'Sending…';
    btn.setAttribute('aria-busy', 'true');
    var pending;
    try {
      pending = Promise.resolve(st.notifyApprovers(ticket.id));
    } catch (e) {
      pending = Promise.reject(e);
    }
    return pending.then(function (res) {
      var sent = Number(res && res.sent) || 0;
      say(opts, (res && res.message) || (sent ? (sent === 1 ? 'Told 1 person.' : 'Told ' + sent + ' people.') : FAILED),
        sent > 0 ? 'success' : undefined);
      return settle(opts);
    }, function (err) {
      say(opts, (err && err.message) || FAILED, 'error');
      // 409: it is no longer waiting for approval. Re-read so the banner goes.
      if (err && err.status === 409) return settle(opts);
      return undefined;
    }).then(restore, restore);
  }

  // Delegated, once per container; the ticket and callbacks are refreshed on
  // every call so an in-place update is seen by the next click.
  function bind(container, ticket, opts) {
    if (!container || typeof container.addEventListener !== 'function') return;
    container._p86WonTicket = ticket;
    container._p86WonOpts = opts || {};
    if (container._p86WonBound) return;
    container._p86WonBound = true;
    container.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.p86-won-again') : null;
      if (!btn || btn.disabled || !container.contains(btn)) return;
      sendAgain(btn, container._p86WonTicket, container._p86WonOpts);
    });
  }

  // ── Progress list wording ─────────────────────────────────────────────
  // Escaped html, or null for an event this module does not word.
  function eventWhat(e, h) {
    if (!e) return null;
    var helpers = h && typeof h === 'object' ? h : null;
    var d = parseDetail(helpers && helpers.detail != null ? helpers.detail : e.detail);
    if (!d) return null;
    var names = (Array.isArray(d.names) ? d.names : []).map(function (n) {
      return String(n == null ? '' : n).trim();
    }).filter(Boolean);
    var who = esc(names.join(', '));

    if (e.kind === 'approval_notified') {
      if (!names.length) return null;
      var attempt = Number(d.attempt) || 0;
      return 'told ' + who + ' it is ready for approval' +
        (d.fallback === 'admins' ? ' (nobody on the work order could approve it, so the admins were told)' : '') +
        (attempt > 1 ? ' — on try ' + attempt : '');
    }
    if (e.kind === 'approval_notice_failed') {
      return 'could not tell anyone this is ready for approval' +
        (d.reason === 'muted' ? ' — everyone who can approve it has these notices turned off' : '');
    }
    if (e.kind === 'assignee_notified') {
      return names.length ? 'told ' + who + ' this work order is assigned to them' : null;
    }
    if (e.kind === 'flag_notified') {
      return names.length ? 'told ' + who + ' about the problem' : null;
    }
    return null;
  }

  // ── Registration ───────────────────────────────────────────────────────
  function ticketOf(ctx) {
    return (ctx && ctx.t) || (ctx && ctx.r && ctx.r.ticket) || null;
  }

  function wireBanner(node, ctx) {
    bind(node, ticketOf(ctx), {
      onDone: function () { return ctx && typeof ctx.refresh === 'function' ? ctx.refresh() : undefined; },
      toast: function (msg, kind) { if (ctx && typeof ctx.toast === 'function') ctx.toast(msg, kind); else say(null, msg, kind); }
    });
  }

  function detailSectionsHook(ctx) {
    return [{ key: 'notice-banner', slot: 'banner', html: bannerHTML(ticketOf(ctx), !!(ctx && ctx.canEdit)), wire: wireBanner }];
  }

  function eventWhatHook(e, h) { return eventWhat(e, h); }

  function register() {
    var ext = window.p86StExt;
    if (!ext || typeof ext.register !== 'function') return false;
    ext.register('work-order-notices', {
      order: 20,
      detailSections: detailSectionsHook,
      eventWhat: eventWhatHook
    });
    return true;
  }

  window.p86WorkOrderNotices = {
    GAVE_UP: GAVE_UP,
    RETRYING: RETRYING,
    noticeState: noticeState,
    bannerHTML: bannerHTML,
    bind: bind,
    eventWhat: eventWhat
  };

  if (!register() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', register);
  }
})();
