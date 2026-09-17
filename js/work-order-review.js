// Review & approve — window.p86WorkOrderReview.
//
// Everything the office uses to finish off a work order the crew says is done:
//
//   * the bar under the stepper: "Ready for review" with the punch-list tally
//     and a Review & approve button, or the approved / cancelled stamp, or the
//     sent-back note while the crew is working from a send-back;
//   * the review sheet: every building on one screen with its before and
//     completion photos, who finished it and when, its last notes, a marker on
//     anything that isn't finished or has no completion photo, and a
//     "Send back this building" pick per card;
//   * the Approve, Send back, Cancel and Reason dialogs — the ONLY reason
//     dialogs in the app. Move to… goes through them too (confirmMove), so a
//     slip on the status picker can no longer cancel a work order without a
//     reason;
//   * the Progress list wording for the review events.
//
// It registers with window.p86StExt (js/service-ticket-ext.js) as
// 'work-order-review', order 10, and never reads js/service-tickets.js
// internals: the host hands it ctx (shared contracts 5.2).
//
// The server is the authority on every rule shown here
// (server/services/work-order-review.js changeStatus): required reasons, the
// stale-screen check (expected_status), which buildings a send-back may
// reopen. These dialogs only ask the same questions up front so a PM is not
// refused after typing.
//
// No prices: the reason boxes warn that the crew sees what is typed, and
// nothing here reads a money field.
(function () {
  'use strict';

  var STALE = 'This work order just changed. Reload to see the latest.';
  var NO_NAME = 'someone no longer on the team';
  var REASON_MAX = 1000;
  var BUILDING_NOTE_MAX = 500;
  var STATUS_LABEL = {
    draft: 'Draft', open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress',
    work_complete: 'Work complete', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled'
  };
  var CREW_WORKING = { open: true, scheduled: true, in_progress: true };

  // ── Small helpers ──────────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // A host helper may hand back text that is already escaped. Undo the five
  // entities first so escaping again is idempotent either way.
  function unesc(s) {
    return String(s == null ? '' : s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&amp;/g, '&');
  }

  function nonBlank(s) {
    var v = s == null ? '' : String(s).trim();
    return v;
  }

  function plural(n, one, many) {
    return n + ' ' + (n === 1 ? one : many);
  }

  // "Bldg 784 — Side A: rail post" → "Bldg 784". The same parse as the ticket
  // screen and the crew page; a title without the shape is its own heading.
  function parseHead(title) {
    var s = String(title == null ? '' : title).trim();
    var m = s.match(/^(.+?)\s+[—–-]\s+(.+)$/);
    return m ? m[1].trim() : (s || 'Untitled');
  }

  // Instants only (created_at, approved_at, completed_at). A calendar date
  // (due_date) never comes through here.
  function whenOf(v) {
    if (!v) return null;
    var d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  function fmtWhen(v) {
    var d = whenOf(v);
    if (!d) return '';
    return d.toLocaleString(undefined, { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
  }
  function fmtWhenDay(v) {
    var d = whenOf(v);
    if (!d) return '';
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  }

  function parseDetail(d) {
    if (typeof d === 'string') {
      try { d = JSON.parse(d); } catch (e) { d = null; }
    }
    return d && typeof d === 'object' ? d : null;
  }

  function isCompletion(p) { return !!p && p.kind !== 'before'; }

  function liveTasks(r) {
    return ((r && Array.isArray(r.tasks)) ? r.tasks : []).filter(function (k) { return k && !k.archived_at; });
  }

  // Task titles seen on the last painted work order, for timeline headings.
  var _titles = {};
  function rememberTitles(r) {
    liveTasks(r).forEach(function (k) {
      if (k.id != null) _titles[String(k.id)] = k.title || '';
    });
  }

  // The punch-list tally the bar and the Approve dialog read.
  //   n  buildings            d  done           k  not finished
  //   c  completion photos    m  done buildings without a completion photo
  //   look  not finished OR no completion photo (the "Needs a look" filter)
  function tallyOf(r) {
    var tasks = liveTasks(r);
    var out = { n: tasks.length, d: 0, k: 0, c: 0, m: 0, look: 0 };
    tasks.forEach(function (k) {
      var photos = Array.isArray(k.photos) ? k.photos : [];
      var comp = photos.filter(isCompletion).length;
      var done = k.status === 'done';
      out.c += comp;
      if (done) out.d++; else out.k++;
      if (done && !comp) out.m++;
      if (!done || !comp) out.look++;
    });
    return out;
  }

  // ctx from the host, or a bare GET response from an older caller.
  function asCtx(x) {
    if (x && x.ticket && !x.r) return { r: x, t: x.ticket };
    return x || {};
  }
  function ticketOf(ctx) {
    return (ctx && ctx.t) || (ctx && ctx.r && ctx.r.ticket) || {};
  }
  function responseOf(ctx) {
    var r = (ctx && ctx.r) || {};
    var t = ticketOf(ctx);
    return t === r.ticket ? r : Object.assign({}, r, { ticket: t });
  }

  function toast(ctx, msg, kind) {
    if (!msg) return;
    if (ctx && typeof ctx.toast === 'function') {
      try { ctx.toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (typeof window.p86Toast === 'function') {
      try { window.p86Toast(msg, kind); return; } catch (e) { /* fall through */ }
    }
    if (kind === 'error' && typeof console !== 'undefined') console.error('[work-order-review] ' + msg);
  }

  function refresh(ctx) {
    try {
      if (ctx && typeof ctx.refresh === 'function') return Promise.resolve(ctx.refresh());
      if (ctx && typeof ctx.reload === 'function') return Promise.resolve(ctx.reload());
    } catch (e) { /* the toast already said what happened */ }
    return Promise.resolve();
  }

  function statusApi() {
    var st = window.p86Api && window.p86Api.serviceTickets;
    return st && typeof st.setStatus === 'function' ? st : null;
  }

  // ── The bar under the stepper ──────────────────────────────────────────
  function reviewBarHTML(r) {
    var n = tallyOf(r);
    var text;
    if (!n.n) {
      text = '<strong>Ready for review</strong> · no punch list on this work order';
    } else {
      text = '<strong>Ready for review</strong> · ' + n.d + ' of ' + plural(n.n, 'building', 'buildings') + ' done' +
        ' · ' + plural(n.c, 'completion photo', 'completion photos') +
        (n.m ? ' · ' + n.m + ' without a completion photo' : '') +
        (n.k ? ' · ' + n.k + ' not finished' : '');
    }
    return '<div class="p86-wor-bar">' +
      '<div class="p86-wor-bar-text">' + text + '</div>' +
      '<button type="button" class="ee-btn primary p86-wor-open">Review &amp; approve</button>' +
    '</div>';
  }

  function sentBackHTML(sb) {
    var note = nonBlank(sb.note);
    var heads = (Array.isArray(sb.buildings) ? sb.buildings : []).map(function (b) {
      return b ? parseHead(b.title) : '';
    }).filter(Boolean);
    var day = fmtWhenDay(sb.at);
    return '<div class="p86-wor-sentback">' +
      '<strong>Sent back' + (day ? ' ' + esc(day) : '') + '.</strong>' +
      (note ? ' The crew link shows: “' + esc(note) + '”' : '') +
      (heads.length ? ' · Buildings to redo: ' + esc(heads.join(', ')) : '') +
    '</div>';
  }

  // One root element or '' (the host tags the root, contracts 5.2).
  function barHTML(r, canEdit) {
    var t = (r && r.ticket) || {};
    var review = (r && r.review) || {};
    var parts = [];
    if (t.status === 'work_complete' && canEdit) parts.push(reviewBarHTML(r));
    if ((t.status === 'approved' || t.status === 'closed') && t.approved_at) {
      parts.push('<div class="p86-wor-stamp">Approved by ' + esc(review.approved_by_name || NO_NAME) +
        ' · ' + esc(fmtWhenDay(t.approved_at)) + '</div>');
    }
    if (t.status === 'cancelled' && t.cancelled_at) {
      parts.push('<div class="p86-wor-stamp is-cancel">Cancelled by ' + esc(review.cancelled_by_name || NO_NAME) +
        ' · ' + esc(fmtWhenDay(t.cancelled_at)) + '. The reason is in Progress below.</div>');
    }
    if (review.send_back && (CREW_WORKING[t.status] || !t.status)) parts.push(sentBackHTML(review.send_back));
    if (!parts.length) return '';
    return parts.length === 1 ? parts[0] : '<div class="p86-wor-wrap">' + parts.join('') + '</div>';
  }

  // ── Layers: Escape closes the top one ─────────────────────────────────
  var _layers = [];
  function onKey(e) {
    if (e.key !== 'Escape' && e.key !== 'Esc') return;
    // The photo viewer sits above everything and handles its own Escape.
    if (document.querySelector('.p86-photo-viewer')) return;
    var top = _layers[_layers.length - 1];
    if (!top) return;
    e.preventDefault();
    e.stopPropagation();
    top();
  }
  function pushLayer(fn) {
    if (!_layers.length) document.addEventListener('keydown', onKey, true);
    _layers.push(fn);
  }
  function popLayer(fn) {
    var i = _layers.indexOf(fn);
    if (i >= 0) _layers.splice(i, 1);
    if (!_layers.length) document.removeEventListener('keydown', onKey, true);
  }

  var _seq = 0;

  // ── Dialogs ────────────────────────────────────────────────────────────
  // A body-level .p86-st-modal (z 1100), so it stacks above the review sheet
  // (z 1090). p86Confirm cannot collect text, which is why these are our own.
  function openDialog(spec) {
    var id = 'p86WorDlg' + (++_seq);
    var back = document.createElement('div');
    back.className = 'p86-st-modal-back p86-wor-dlg-back';
    back.innerHTML =
      '<div class="p86-st-modal p86-wor-dlg" role="dialog" aria-modal="true" aria-labelledby="' + id + '" data-dialog="' + esc(spec.kind) + '">' +
        '<div class="p86-st-modal-head" id="' + id + '">' + esc(spec.title) + '</div>' +
        '<div class="p86-wor-dlg-body">' + spec.bodyHTML + '</div>' +
        '<div class="p86-wor-err" role="alert" hidden></div>' +
        '<div class="p86-st-modal-actions">' +
          '<button type="button" class="ee-btn secondary p86-wor-dlg-cancel">' + esc(spec.cancelLabel) + '</button>' +
          '<button type="button" class="ee-btn ' + (spec.danger ? 'danger' : 'primary') + ' p86-wor-dlg-ok">' + esc(spec.okLabel) + '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(back);

    var opener = document.activeElement;
    var closed = false;
    var busy = false;
    var errEl = back.querySelector('.p86-wor-err');
    var okBtn = back.querySelector('.p86-wor-dlg-ok');
    var cancelBtn = back.querySelector('.p86-wor-dlg-cancel');

    var dlg = {
      el: back,
      q: function (sel) { return back.querySelector(sel); },
      qa: function (sel) { return Array.prototype.slice.call(back.querySelectorAll(sel)); },
      isClosed: function () { return closed; },
      error: function (msg, focusEl) {
        errEl.textContent = msg || '';
        errEl.hidden = !msg;
        if (focusEl && typeof focusEl.focus === 'function') focusEl.focus();
      },
      busy: function (on) {
        busy = !!on;
        okBtn.disabled = busy;
        cancelBtn.disabled = busy;
        back.querySelector('.p86-wor-dlg').setAttribute('aria-busy', busy ? 'true' : 'false');
      },
      close: function () {
        if (closed) return;
        closed = true;
        popLayer(escClose);
        if (back.parentNode) back.parentNode.removeChild(back);
        if (opener && opener.isConnected && typeof opener.focus === 'function') {
          try { opener.focus(); } catch (e) { /* focus is a nicety */ }
        }
      }
    };

    function escClose() {
      if (busy) return;
      dlg.close();
      if (typeof spec.onDismiss === 'function') spec.onDismiss();
    }
    pushLayer(escClose);

    cancelBtn.addEventListener('click', function () {
      if (busy) return;
      dlg.close();
      if (typeof spec.onDismiss === 'function') spec.onDismiss();
    });
    okBtn.addEventListener('click', function () {
      if (busy || closed) return;
      spec.onOk(dlg);
    });
    if (typeof spec.wire === 'function') spec.wire(dlg);

    var first = back.querySelector('textarea') || okBtn;
    if (first && typeof first.focus === 'function') first.focus();
    return dlg;
  }

  function reasonBoxHTML(o) {
    var id = 'p86WorReason' + (++_seq);
    return '<label class="p86-st-lbl p86-wor-lbl" for="' + id + '">' + esc(o.label) +
        (o.required ? ' <span class="p86-wor-req" aria-hidden="true">*</span>' : '') + '</label>' +
      '<textarea class="p86-wor-reason" id="' + id + '" rows="' + (o.rows || 3) + '" maxlength="' + REASON_MAX + '"' +
        (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : '') +
        (o.required ? ' aria-required="true"' : '') + '></textarea>' +
      (o.help ? '<div class="p86-wor-help">' + esc(o.help) + '</div>' : '');
  }

  function reasonOf(dlg) {
    var box = dlg.q('.p86-wor-reason');
    return { box: box, text: box ? String(box.value || '').trim() : '' };
  }

  // ── The four flows ─────────────────────────────────────────────────────
  // kind → the status it moves to.
  var TARGET = { approve: 'approved', send_back: 'in_progress', cancel: 'cancelled', reopen: 'open', unapprove: 'work_complete' };

  function dialogKind(from, to) {
    if (!to || from === to) return null;
    if (to === 'approved') return 'approve';
    if (from === 'work_complete' && to === 'in_progress') return 'send_back';
    if (to === 'cancelled') return 'cancel';
    if ((from === 'closed' || from === 'cancelled') && to === 'open') return 'reopen';
    if (from === 'approved' && to === 'work_complete') return 'unapprove';
    return null;
  }

  function approveSpec(ctx, opts) {
    var r = responseOf(ctx);
    var t = r.ticket || {};
    var n = tallyOf(r);
    var lines = [];
    if (!n.n) {
      lines.push('This work order has no punch list.');
    } else if (!n.k && !n.m) {
      lines.push(n.n === 1
        ? 'The building is done, with ' + plural(n.c, 'completion photo', 'completion photos') + '.'
        : 'All ' + n.n + ' buildings are done, with ' + plural(n.c, 'completion photo', 'completion photos') + '.');
    } else {
      if (n.k) lines.push(n.k === 1 ? '1 building isn’t finished.' : n.k + ' buildings aren’t finished.');
      if (n.m) lines.push(n.m === 1 ? '1 building has no completion photo.' : n.m + ' buildings have no completion photo.');
    }
    var picked = (opts && opts.picks ? opts.picks : []).length;
    var proposed = nonBlank(t.scope_proposed);
    var approvedHas = !!nonBlank(t.scope_approved);
    var body =
      '<div class="p86-wor-sum">' + lines.map(function (l) { return '<div>' + esc(l) + '</div>'; }).join('') + '</div>' +
      (picked
        ? '<div class="p86-wor-warn">' + esc('You marked ' + plural(picked, 'building', 'buildings') + ' to send back. Approving ignores that.') + '</div>'
        : '') +
      (proposed
        ? '<label class="p86-wor-check"><input type="checkbox" class="p86-wor-copy"' + (approvedHas ? '' : ' checked') + ' /> ' +
            esc(approvedHas ? 'Replace the approved scope with the proposed scope' : 'Copy the proposed scope into the approved scope') +
          '</label>'
        : '') +
      reasonBoxHTML({ label: 'Note for the timeline (optional)' });
    return {
      kind: 'approve',
      title: 'Approve this work order?',
      bodyHTML: body,
      okLabel: 'Approve',
      cancelLabel: 'Keep reviewing',
      collect: function (dlg) {
        var copy = dlg.q('.p86-wor-copy');
        var copyScope = !!(copy && copy.checked);
        var extra = { reason: reasonOf(dlg).text, copy_scope: copyScope };
        return { extra: extra, copied: copyScope && !!proposed };
      }
    };
  }

  function sendBackSpec(ctx, opts) {
    var r = responseOf(ctx);
    var picks = {};
    (opts && opts.picks ? opts.picks : []).forEach(function (p) { picks[String(p.id)] = p; });
    var rows = liveTasks(r).filter(function (k) {
      return k.status === 'done' || picks[String(k.id)];
    }).map(function (k) {
      var id = String(k.id);
      var pick = picks[id];
      var done = k.status === 'done';
      var checked = !!pick || !done;
      return '<div class="p86-wor-rrow" data-task="' + esc(id) + '">' +
        '<label class="p86-wor-check">' +
          '<input type="checkbox" class="p86-wor-rpick"' + (checked ? ' checked' : '') + (done ? '' : ' disabled') + ' /> ' +
          '<span class="p86-wor-rhead">' + esc(parseHead(k.title)) + '</span>' +
          (done ? '' : ' <span class="p86-wor-miss soft">already not finished</span>') +
        '</label>' +
        '<input type="text" class="p86-wor-rnote" maxlength="' + BUILDING_NOTE_MAX + '" placeholder="Note for this building (optional)"' +
          ' value="' + esc(pick && pick.note ? pick.note : '') + '"' + (checked ? '' : ' hidden') + ' />' +
      '</div>';
    });
    var body =
      reasonBoxHTML({
        label: 'What needs fixing?',
        required: true,
        rows: 4,
        placeholder: 'e.g. Bldg 784 Side A: rail post is still loose. Re-photo tread 3 on Bldg 790.',
        help: 'The crew sees this at the top of their link, and whoever the link was emailed to gets it by email. Leave prices out.'
      }) +
      (rows.length
        ? '<div class="p86-st-lbl p86-wor-lbl">Reopen buildings</div><div class="p86-wor-reopen">' + rows.join('') + '</div>'
        : '') +
      '<div class="p86-wor-hint"></div>';

    function syncHint(dlg) {
      var reopening = dlg.qa('.p86-wor-rpick').filter(function (b) { return b.checked && !b.disabled; }).length;
      var hint = dlg.q('.p86-wor-hint');
      if (hint) {
        hint.textContent = reopening
          ? 'Reopened buildings go back to not finished: the crew adds a new completion photo and marks each one complete again. Buildings you don’t reopen stay done.'
          : 'No buildings will be reopened. The crew marks the work complete again once it’s fixed.';
      }
    }

    return {
      kind: 'send_back',
      title: 'Send back to the crew',
      bodyHTML: body,
      okLabel: 'Send back',
      cancelLabel: 'Keep reviewing',
      wire: function (dlg) {
        syncHint(dlg);
        dlg.el.addEventListener('change', function (e) {
          var box = e.target;
          if (!box || !box.classList || !box.classList.contains('p86-wor-rpick')) return;
          var row = box.closest('.p86-wor-rrow');
          var note = row && row.querySelector('.p86-wor-rnote');
          if (note) note.hidden = !box.checked;
          syncHint(dlg);
        });
      },
      collect: function (dlg) {
        var reason = reasonOf(dlg);
        if (!reason.text) {
          dlg.error('Say what needs fixing.', reason.box);
          return null;
        }
        var list = dlg.qa('.p86-wor-rrow').filter(function (row) {
          var b = row.querySelector('.p86-wor-rpick');
          return b && b.checked;
        }).map(function (row) {
          var note = row.querySelector('.p86-wor-rnote');
          return { id: row.getAttribute('data-task'), note: note ? String(note.value || '').trim() : '' };
        });
        var extra = { reason: reason.text };
        if (list.length) extra.reopen_tasks = list;
        return { extra: extra };
      }
    };
  }

  function cancelSpec() {
    return {
      kind: 'cancel',
      title: 'Cancel this work order?',
      bodyHTML:
        '<div class="p86-wor-msg">The work stops and the crew link shows it as cancelled. You can reopen it later.</div>' +
        reasonBoxHTML({
          label: 'Why is it being cancelled?',
          required: true,
          help: 'Office only — this goes on the Progress list, not the crew link.'
        }),
      okLabel: 'Cancel work order',
      danger: true,
      cancelLabel: 'Keep it',
      collect: function (dlg) {
        var reason = reasonOf(dlg);
        if (!reason.text) {
          dlg.error('Say why this work order is being cancelled.', reason.box);
          return null;
        }
        return { extra: { reason: reason.text } };
      }
    };
  }

  function reasonSpec(kind) {
    var reopen = kind === 'reopen';
    var empty = reopen ? 'Say why this work order is being reopened.' : 'Say why the approval is being taken back.';
    return {
      kind: kind,
      title: reopen ? 'Reopen this work order?' : 'Take back the approval?',
      bodyHTML: reasonBoxHTML({
        label: reopen ? 'Why is it being reopened?' : 'Why is the approval being taken back?',
        required: true,
        help: 'This goes on the Progress list.'
      }),
      okLabel: reopen ? 'Reopen' : 'Take back approval',
      cancelLabel: 'Keep it',
      collect: function (dlg) {
        var reason = reasonOf(dlg);
        if (!reason.text) {
          dlg.error(empty, reason.box);
          return null;
        }
        return { extra: { reason: reason.text } };
      }
    };
  }

  function specFor(kind, ctx, opts) {
    if (kind === 'approve') return approveSpec(ctx, opts);
    if (kind === 'send_back') return sendBackSpec(ctx, opts);
    if (kind === 'cancel') return cancelSpec(ctx, opts);
    return reasonSpec(kind);
  }

  // ── After a move lands ─────────────────────────────────────────────────
  function sendBackToast(res) {
    var sb = res && res.send_back;
    var msg = 'Sent back to the crew.';
    if (!sb) return msg;
    var reopened = Number(sb.reopened) || 0;
    var emailing = Number(sb.crew_emailing) || 0;
    if (reopened) msg += ' ' + plural(reopened, 'building', 'buildings') + ' reopened.';
    msg += emailing === 1
      ? ' Emailing the link recipient.'
      : (emailing ? ' Emailing ' + emailing + ' link recipients.' : ' No crew link has an email address, so tell the crew directly.');
    return msg;
  }

  function moveToast(from, to, res, copied) {
    if (to === 'approved') {
      return 'Work order approved.' + (copied ? ' The approved scope was filled in from the proposed scope.' : '');
    }
    if (from === 'work_complete' && to === 'in_progress') return sendBackToast(res);
    if (to === 'cancelled') return 'Work order cancelled.';
    return null;
  }

  // Whether the last Approve dialog answered through Move to… asked to copy
  // the scope, so afterStatus can say so. Keyed by ticket id, read once.
  var _copied = {};

  // ── Flows ──────────────────────────────────────────────────────────────
  // mode 'extra' (Move to…): resolves the extra body, or null when dismissed.
  // mode 'send' (the review sheet): sends the move itself.
  function runFlow(kind, ctx, opts) {
    var o = opts || {};
    var spec = specFor(kind, ctx, o);
    var t = ticketOf(ctx);
    var to = TARGET[kind];

    if (o.mode !== 'send') {
      return new Promise(function (resolve) {
        spec.onDismiss = function () { resolve(null); };
        spec.onOk = function (dlg) {
          var got = spec.collect(dlg);
          if (!got) return;
          if (kind === 'approve' && t.id != null) _copied[String(t.id)] = !!got.copied;
          dlg.close();
          resolve(got.extra);
        };
        openDialog(spec);
      });
    }

    spec.onOk = function (dlg) {
      var got = spec.collect(dlg);
      if (!got) return;
      var st = statusApi();
      if (!st) {
        toast(ctx, 'Reload the page to change the status.', 'error');
        return;
      }
      var from = o.expected || t.status;
      var body = Object.assign({ expected_status: from }, got.extra);
      dlg.error('');
      dlg.busy(true);
      Promise.resolve().then(function () {
        return st.setStatus(t.id, to, body);
      }).then(function (res) {
        dlg.close();
        closeSheet();
        toast(ctx, moveToast(from, to, res, got.copied), 'success');
        return refresh(ctx);
      }, function (err) {
        var stale = !!(err && err.status === 409);
        var msg = (err && err.message) || (stale ? STALE : 'Could not change the status.');
        toast(ctx, msg, 'error');
        if (stale) {
          // The work order moved under this screen. Nothing was written: close
          // and re-read so the office sees where it is now.
          dlg.close();
          closeSheet();
          return refresh(ctx);
        }
        dlg.busy(false);
        dlg.error(msg);
      });
    };
    spec.onDismiss = function () {};
    openDialog(spec);
    return Promise.resolve();
  }

  // ── Hooks ──────────────────────────────────────────────────────────────
  function confirmMove(ctx, to) {
    var c = asCtx(ctx);
    var kind = dialogKind(ticketOf(c).status, to);
    if (!kind) return undefined;
    return runFlow(kind, c, { mode: 'extra' });
  }

  function afterStatus(ctx, res, from, to) {
    var c = asCtx(ctx);
    var t = ticketOf(c);
    var key = t.id != null ? String(t.id) : '';
    var copied = !!_copied[key];
    delete _copied[key];
    var msg = moveToast(from, to, res, copied);
    if (msg) toast(c, msg, 'success');
  }

  // ── The review sheet ───────────────────────────────────────────────────
  var _sheet = null;

  function shotsHTML(photos, all, kind) {
    return photos.map(function (p) {
      return '<button type="button" class="p86-wor-shot" data-kind="' + kind + '" data-idx="' + all.indexOf(p) + '"' +
        ' title="' + (kind === 'before' ? 'Before photo' : 'Completion photo') + '">' +
        '<img src="' + esc(p.thumb_url || p.web_url || '') + '" alt="" loading="lazy" />' +
      '</button>';
    }).join('');
  }

  function cardHTML(k) {
    var photos = Array.isArray(k.photos) ? k.photos : [];
    var before = photos.filter(function (p) { return !isCompletion(p); });
    var comp = photos.filter(isCompletion);
    var done = k.status === 'done';
    var look = !done || !comp.length;
    var notes = (Array.isArray(k.notes) ? k.notes : []).slice(-2);
    var at = fmtWhen(k.completed_at);
    return '<div class="p86-wor-card' + (look ? ' needs-look' : '') + '" data-task="' + esc(k.id) + '">' +
      '<div class="p86-wor-card-head">' + esc(parseHead(k.title)) + '</div>' +
      '<div class="p86-wor-card-status">' +
        (done
          ? 'Done by ' + esc(k.completed_by || 'someone') + (at ? ' · ' + esc(at) : '')
          : '<span class="p86-wor-miss">Not finished</span>') +
      '</div>' +
      '<div class="p86-wor-strip">' +
        '<div class="p86-wor-strip-lbl">Before</div>' +
        '<div class="p86-wor-shots">' +
          (before.length ? shotsHTML(before, photos, 'before') : '<span class="p86-wor-miss soft">No before photo</span>') +
        '</div>' +
      '</div>' +
      '<div class="p86-wor-strip">' +
        '<div class="p86-wor-strip-lbl">Completion</div>' +
        '<div class="p86-wor-shots">' +
          (comp.length ? shotsHTML(comp, photos, 'completion') : '<span class="p86-wor-miss">No completion photo</span>') +
        '</div>' +
      '</div>' +
      (notes.length
        ? '<div class="p86-wor-notes">' + notes.map(function (nt) {
            var day = fmtWhenDay(nt.at);
            return '<div class="p86-wor-note">' + esc(nt.by || 'Someone') + (day ? ' · ' + esc(day) : '') + ': ' + esc(nt.note) + '</div>';
          }).join('') + '</div>'
        : '') +
      '<label class="p86-wor-pick"><input type="checkbox" class="p86-wor-pick-box" /> Send back this building</label>' +
      '<input type="text" class="p86-wor-pick-note" maxlength="' + BUILDING_NOTE_MAX + '" hidden' +
        ' placeholder="What’s wrong here? (optional — the crew sees it)" />' +
    '</div>';
  }

  function sheetHTML(r, headId) {
    var t = r.ticket || {};
    var site = r.site || {};
    var siteLine = [site.job_number, site.name, site.address].map(nonBlank).filter(Boolean).join(' · ');
    var tasks = liveTasks(r);
    var n = tallyOf(r);
    return '<div class="p86-wor-sheet" role="dialog" aria-modal="true" aria-labelledby="' + headId + '">' +
      '<div class="p86-wor-head">' +
        '<div class="p86-wor-head-text">' +
          '<h2 class="p86-wor-h" id="' + headId + '">Review &amp; approve</h2>' +
          '<div class="p86-wor-title">' + esc(t.title || 'Untitled work order') + '</div>' +
          (siteLine ? '<div class="p86-wor-site">' + esc(siteLine) + '</div>' : '') +
        '</div>' +
        '<button type="button" class="p86-wor-x" aria-label="Close">&times;</button>' +
      '</div>' +
      '<div class="p86-wor-filter" role="group" aria-label="Show">' +
        '<button type="button" class="p86-wor-pill is-on" data-filter="all" aria-pressed="true">All buildings (' + n.n + ')</button>' +
        '<button type="button" class="p86-wor-pill" data-filter="look" aria-pressed="false">Needs a look (' + n.look + ')</button>' +
      '</div>' +
      (tasks.length
        ? '<div class="p86-wor-grid">' + tasks.map(cardHTML).join('') + '</div>'
        : '<div class="p86-wor-empty">No punch list on this work order.</div>') +
      '<div class="p86-wor-foot">' +
        '<span class="p86-wor-count" hidden></span>' +
        '<span class="p86-wor-foot-btns">' +
          '<button type="button" class="ee-btn primary p86-wor-approve">Approve</button>' +
          '<button type="button" class="ee-btn secondary p86-wor-sendback">Send back…</button>' +
          '<button type="button" class="ee-btn secondary p86-wor-danger p86-wor-cancel">Cancel work order…</button>' +
          '<button type="button" class="ee-btn secondary p86-wor-close">Close</button>' +
        '</span>' +
      '</div>' +
    '</div>';
  }

  function closeSheet() {
    if (!_sheet) return;
    var s = _sheet;
    _sheet = null;
    popLayer(s.escClose);
    if (s.back.parentNode) s.back.parentNode.removeChild(s.back);
    document.body.style.overflow = s.overflow;
    if (s.opener && s.opener.isConnected && typeof s.opener.focus === 'function') {
      try { s.opener.focus(); } catch (e) { /* focus is a nicety */ }
    }
  }

  function picksOf(back) {
    return Array.prototype.slice.call(back.querySelectorAll('.p86-wor-card')).filter(function (card) {
      var b = card.querySelector('.p86-wor-pick-box');
      return b && b.checked;
    }).map(function (card) {
      var note = card.querySelector('.p86-wor-pick-note');
      return { id: card.getAttribute('data-task'), note: note ? String(note.value || '').trim() : '' };
    });
  }

  function openReview(ctx) {
    var c = asCtx(ctx);
    closeSheet();
    var r = responseOf(c);
    rememberTitles(r);
    var t = r.ticket || {};
    var tasks = liveTasks(r);
    var byId = {};
    tasks.forEach(function (k) { byId[String(k.id)] = k; });

    var back = document.createElement('div');
    back.className = 'p86-wor-back';
    back.innerHTML = sheetHTML(r, 'p86WorHead' + (++_seq));
    var sheet = {
      back: back,
      ctx: c,
      status: t.status,
      opener: document.activeElement,
      overflow: document.body.style.overflow,
      escClose: function () { closeSheet(); }
    };
    _sheet = sheet;
    document.body.appendChild(back);
    document.body.style.overflow = 'hidden';
    pushLayer(sheet.escClose);

    function syncCount() {
      var x = picksOf(back).length;
      var el = back.querySelector('.p86-wor-count');
      el.hidden = !x;
      el.textContent = x ? plural(x, 'building', 'buildings') + ' marked to send back' : '';
    }

    function setFilter(which) {
      back.querySelectorAll('.p86-wor-pill').forEach(function (p) {
        var on = p.getAttribute('data-filter') === which;
        p.classList.toggle('is-on', on);
        p.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      back.querySelectorAll('.p86-wor-card').forEach(function (card) {
        card.hidden = which === 'look' && !card.classList.contains('needs-look');
      });
    }

    back.addEventListener('click', function (e) {
      var el = e.target && e.target.closest ? e.target.closest('button') : null;
      if (!el || !back.contains(el)) return;
      if (el.classList.contains('p86-wor-x') || el.classList.contains('p86-wor-close')) { closeSheet(); return; }
      if (el.classList.contains('p86-wor-pill')) { setFilter(el.getAttribute('data-filter')); return; }
      if (el.classList.contains('p86-wor-shot')) {
        var card = el.closest('.p86-wor-card');
        var task = card ? byId[card.getAttribute('data-task')] : null;
        if (!task || !window.p86Attachments || typeof window.p86Attachments.openLightbox !== 'function') return;
        window.p86Attachments.openLightbox(task.photos || [], Number(el.getAttribute('data-idx')) || 0, {
          parentLabel: parseHead(task.title),
          parentSubtitle: t.title || ''
        });
        return;
      }
      if (el.classList.contains('p86-wor-approve')) {
        runFlow('approve', c, { mode: 'send', expected: sheet.status, picks: picksOf(back) });
        return;
      }
      if (el.classList.contains('p86-wor-sendback')) {
        runFlow('send_back', c, { mode: 'send', expected: sheet.status, picks: picksOf(back) });
        return;
      }
      if (el.classList.contains('p86-wor-cancel')) {
        runFlow('cancel', c, { mode: 'send', expected: sheet.status });
      }
    });

    back.addEventListener('change', function (e) {
      var box = e.target;
      if (!box || !box.classList || !box.classList.contains('p86-wor-pick-box')) return;
      var card = box.closest('.p86-wor-card');
      var note = card && card.querySelector('.p86-wor-pick-note');
      if (note) {
        note.hidden = !box.checked;
        if (box.checked && typeof note.focus === 'function') note.focus();
      }
      syncCount();
    });

    var x = back.querySelector('.p86-wor-x');
    if (x && typeof x.focus === 'function') x.focus();
    return back;
  }

  // ── Progress list wording ─────────────────────────────────────────────
  // Returns escaped html, or null for an event this module does not own.
  // h is the host's helpers {esc, head(taskId), statusLabel(s), detail}, or
  // a plain taskTitleFor(id) function.
  function eventText(e, h) {
    if (!e) return null;
    var helpers = h && typeof h === 'object' ? h : null;
    var titleFor = typeof h === 'function' ? h : null;
    var d = parseDetail(helpers && helpers.detail != null ? helpers.detail : e.detail);
    if (!d) return null;

    function headOf(taskId, fallbackTitle) {
      if (taskId != null) {
        var raw = _titles[String(taskId)];
        if (!raw && titleFor) raw = titleFor(taskId);
        if (raw) return esc(parseHead(raw));
        if (helpers && typeof helpers.head === 'function') {
          var given = helpers.head(taskId);
          if (given) return esc(unesc(given));
        }
      }
      return nonBlank(fallbackTitle) ? esc(parseHead(fallbackTitle)) : '';
    }
    function statusLabel(s) {
      var got = helpers && typeof helpers.statusLabel === 'function' ? helpers.statusLabel(s) : '';
      return esc(unesc(got || STATUS_LABEL[s] || s || ''));
    }

    var note = nonBlank(d.note);
    var said = note ? ': “' + esc(note) + '”' : '';

    if (e.kind === 'status_changed') {
      if (d.action === 'send_back') {
        var heads = (Array.isArray(d.buildings) ? d.buildings : []).filter(function (b) {
          return b && b.reopened;
        }).map(function (b) { return headOf(b.task_id, b.title); }).filter(Boolean);
        return 'sent it back for more work' + said + (heads.length ? ' · reopened ' + heads.join(', ') : '');
      }
      if (d.action === 'approve') {
        return 'approved it' + (d.scope_copied ? ' and copied the proposed scope into the approved scope' : '') + said;
      }
      if (d.action === 'unapprove') return 'took back the approval' + said;
      if (d.action === 'cancel') return 'cancelled it' + said;
      if (d.action === 'reopen') return 'reopened it' + said;
      if (note) {
        var open = Number(d.open);
        var total = Number(d.total);
        var override = d.override === 'buildings_open' && isFinite(open) && isFinite(total) && total > 0
          ? ' with ' + open + ' of ' + total + ' subtasks still open'
          : '';
        return 'moved it to ' + statusLabel(d.to) + override + said;
      }
      return null;
    }

    if (e.kind === 'crew_emailed' && (d.about === 'send_back' || d.about == null)) {
      var sent = Number(d.sent) || 0;
      var failed = Number(d.failed) || 0;
      if (sent > 0) {
        return 'emailed the send-back to the crew link' +
          (sent > 1 ? ' (' + sent + ' people)' : '') +
          (failed ? ' — ' + failed + ' could not be emailed' : '');
      }
      return 'could not email the send-back to the crew link — tell the crew directly';
    }

    if (e.kind === 'subtask_note' && d.sent_back) {
      return 'sent back ' + (headOf(d.task_id) || 'a building') + said;
    }

    return null;
  }

  // ── Registration ───────────────────────────────────────────────────────
  function detailSectionsHook(ctx) {
    var c = asCtx(ctx);
    var r = responseOf(c);
    rememberTitles(r);
    return [{ key: 'wor-bar', slot: 'banner', html: barHTML(r, !!c.canEdit), wire: wireBar }];
  }

  // The host swaps the section node when its html changes and calls wire
  // again; the ctx is re-read on every click so an in-place update is seen.
  function wireBar(node, ctx) {
    if (!node || typeof node.addEventListener !== 'function') return;
    node._p86WorCtx = ctx;
    if (node._p86WorWired) return;
    node._p86WorWired = true;
    node.addEventListener('click', function (e) {
      var btn = e.target && e.target.closest ? e.target.closest('.p86-wor-open') : null;
      if (!btn || btn.disabled) return;
      var c = node._p86WorCtx || {};
      btn.disabled = true;
      // Unsaved edits on the ticket are asked about first: the sheet ends in a
      // re-read that would otherwise lose them.
      Promise.resolve().then(function () {
        return typeof c.leave === 'function' ? c.leave() : true;
      }).then(function (ok) {
        btn.disabled = false;
        if (ok === false) return;
        openReview(c);
      }, function () {
        btn.disabled = false;
      });
    });
  }

  function confirmMoveHook(ctx, to) { return confirmMove(ctx, to); }
  function afterStatusHook(ctx, res, from, to) { return afterStatus(ctx, res, from, to); }
  function eventWhatHook(e, h) { return eventText(e, h); }

  function register() {
    var ext = window.p86StExt;
    if (!ext || typeof ext.register !== 'function') return false;
    ext.register('work-order-review', {
      order: 10,
      detailSections: detailSectionsHook,
      confirmMove: confirmMoveHook,
      afterStatus: afterStatusHook,
      eventWhat: eventWhatHook
    });
    return true;
  }

  window.p86WorkOrderReview = {
    STALE: STALE,
    barHTML: barHTML,
    confirmMove: confirmMove,
    afterStatus: afterStatus,
    eventText: eventText,
    openReview: openReview,
    closeReview: closeSheet,
    wire: wireBar,
    fmtWhen: fmtWhen,
    fmtWhenDay: fmtWhenDay
  };

  if (!register() && typeof document !== 'undefined') {
    document.addEventListener('DOMContentLoaded', register);
  }
})();
