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

  function codeOf(err) {
    return err && err.data && err.data.code;
  }

  // The in-app dialog, and the browser's own only when that is missing.
  // Resolves true for yes, false for anything else (including a dialog that
  // fails).
  function askMoveAnyway(message) {
    if (typeof window.p86Confirm === 'function') {
      return Promise.resolve(window.p86Confirm({
        title: 'Subtasks still open',
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
    return st.setStatus(t.id, to, body).then(moved, function (err) {
      if (err && err.status === 409 && codeOf(err) === 'buildings_open') {
        return askMoveAnyway(err.message ? err.message + MOVE_ANYWAY : MOVE_ANYWAY.slice(1)).then(function (yes) {
          if (!yes) return { outcome: 'cancelled' };
          return st.setStatus(t.id, to, Object.assign({}, body, { override: true }))
            .then(moved, staleOrThrow);
        });
      }
      return staleOrThrow(err);
    });
  }

  window.p86MoveTicketStatus = moveTicketStatus;
})();
