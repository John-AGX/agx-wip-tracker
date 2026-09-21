// Move a work order to another status — window.p86MoveTicketStatus(t, to, extra).
//
// Every office "Move to…" goes through here so the two refusals the status
// door can give back are handled the same way everywhere:
//
//   * The move is sent with expected_status = the status on screen. If
//     somebody else moved the work order in the meantime, the server answers
//     409 status_changed instead of applying a move decided on an old screen.
//     That resolves { outcome: 'stale', message } for the caller to show and
//     reload.
//   * Work complete with buildings still open answers 409 buildings_open. The
//     office may do it anyway, but only after saying so: a yes resends the
//     same move with override:true (the timeline records it), a no resolves
//     { outcome: 'cancelled' }.
//   * Work complete on a work order billed after the work, with no time on it
//     (Phase 3), answers 409 time_missing. Its own question and its own
//     override_time: a yes about the buildings is not a yes about the time,
//     so a move can be asked both, one after the other, and each answer is
//     only ever the answer to its own question.
//
// A move that lands resolves { outcome: 'moved', response, ticket }. Every
// other failure rejects with the server's error, untouched.
//
// extra carries whatever the reason dialog collected (reason, copy_scope,
// reopen_tasks, ...) and is passed through as it is.
(function () {
  'use strict';

  var STALE = 'This work order just changed. Reload to see the latest.';
  var MOVE_ANYWAY = " Move this work order to Work complete anyway? The approvers will be told it's ready, and the timeline will show it was moved with subtasks still open.";
  var NO_TIME_ANYWAY = ' Add the time first from the Time and materials panel, or move it to Work complete anyway — the timeline will show it was moved with no time on it.';

  function codeOf(err) {
    return err && err.data && err.data.code;
  }

  // The in-app dialog, and the browser's own only when that is missing.
  // Resolves true for yes, false for anything else (including a dialog that
  // fails).
  function askMoveAnyway(message, title) {
    if (typeof window.p86Confirm === 'function') {
      return Promise.resolve(window.p86Confirm({
        title: title || 'Subtasks still open',
        message: message,
        confirmText: 'Move anyway',
        confirmLabel: 'Move anyway',
        cancelText: 'Cancel',
        cancelLabel: 'Cancel',
        destructive: false,
        danger: false
      })).then(function (yes) { return yes === true; }, function () { return false; });
    }
    if (typeof window.confirm === 'function') {
      return Promise.resolve(window.confirm(message) === true);
    }
    return Promise.resolve(false);
  }

  function moved(response) {
    return { outcome: 'moved', response: response, ticket: (response && response.ticket) || null };
  }

  function staleOrThrow(err) {
    if (err && err.status === 409 && codeOf(err) === 'status_changed') {
      return { outcome: 'stale', message: (err && err.message) || STALE };
    }
    throw err;
  }

  function moveTicketStatus(t, to, extra) {
    var st = window.p86Api && window.p86Api.serviceTickets;
    if (!st || typeof st.setStatus !== 'function') {
      return Promise.reject(new Error('Reload the page to change the status.'));
    }
    if (!t || t.id == null) return Promise.reject(new Error('No work order to move.'));
    var body = Object.assign({}, extra, { expected_status: t.status });
    // Each refusal the office may answer "anyway" to, with the key its yes
    // adds. Asked at most once each, in the order the server asks them.
    var QUESTIONS = {
      buildings_open: { key: 'override', title: 'Subtasks still open', more: MOVE_ANYWAY },
      time_missing: { key: 'override_time', title: 'No time on this work order', more: NO_TIME_ANYWAY }
    };
    function attempt(sent) {
      return st.setStatus(t.id, to, sent).then(moved, function (err) {
        var q = err && err.status === 409 ? QUESTIONS[codeOf(err)] : null;
        if (q && sent[q.key] !== true) {
          return askMoveAnyway(err.message ? err.message + q.more : q.more.slice(1), q.title).then(function (yes) {
            if (!yes) return { outcome: 'cancelled' };
            var next = Object.assign({}, sent);
            next[q.key] = true;
            return attempt(next);
          });
        }
        return staleOrThrow(err);
      });
    }
    return attempt(body);
  }

  window.p86MoveTicketStatus = moveTicketStatus;
})();
