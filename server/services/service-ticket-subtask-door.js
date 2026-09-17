'use strict';

// THE DOORS TO A WORK ORDER'S PUNCH LIST THAT ARE NOT THE WORK ORDER (1.29).
//
// A building on a punch list is an ordinary org task with service_ticket_id
// set, so it can also be ticked in My Tasks or the job's Tasks panel, sent to a
// sub on a task link, moved to another ticket, or archived. Each of those doors
// used to write the task straight away, so a building could be finished with no
// completion photo, on an approved ticket, by someone who cannot edit the job —
// and the ticket never followed. This module is the rule those doors ask.
//
//   isWorkOrderSubtask(task)          a live org task on a ticket
//   lockTickets(client, orgId, ids)   FOR UPDATE, in sorted id order -> Map
//   doneVerdict(db, {user, orgId, ticket, task})
//                                     finish / reopen: a ticket writer, or the
//                                     task's assignee held to the crew rule
//   structureVerdict(db, {user, orgId, ticket})
//                                     add / move / unlink / archive: a ticket
//                                     writer, on a ticket that is not approved,
//                                     closed or cancelled
//   assignVerdict(db, {user, orgId, ticket})
//                                     reassign: a ticket writer only — the
//                                     assignee may finish a building, so naming
//                                     the assignee is a ticket writer's call
//   taskShifted(before, now)          the task row read before the lock is no
//                                     longer the row under it (A10)
//   stale()                           the 409 status_changed a door answers
//                                     when taskShifted says so
//   crewGate(lockedRow)               the crew rule as a setSubtaskDone gate
//   notifyMoves(list, actor, sharedBy, db?)
//                                     after COMMIT only: tell the approvers
//                                     about every arrival at work_complete
//
// Completing, reopening and the ticket's own status still happen in exactly
// one place, services/service-ticket-workorder.js. Every refusal is
// { ok:false, status, error, code }.

const svc = require('./service-tickets');
const access = require('./service-ticket-access');

const MSG = Object.freeze({
  closed: 'This work order is closed. Reopen it before changing its punch list.',
  startsOpen: 'A new subtask starts open. Add a completion photo to it, then mark it done.',
  doneNeedsPhoto: 'This task is marked done but has no completion photo. Reopen it or add a completion photo before putting it on a work order.',
  taskChanged: 'This task just changed. Reload to see the latest.',
});

function parentWord(ticket) {
  return access.parentOf(ticket).kind === 'lead' ? 'lead' : 'job';
}

function doneRefusal(ticket) {
  return 'Only someone who can edit this ' + parentWord(ticket) +
    ', or the person this task is assigned to, can finish or reopen it.';
}

function structureRefusal(ticket) {
  return 'Only someone who can edit this ' + parentWord(ticket) + " can change its work order's punch list.";
}

function isWorkOrderSubtask(task) {
  return !!(task && task.scope === 'org' && task.service_ticket_id != null &&
    String(task.service_ticket_id) !== '' && !task.archived_at);
}

// Tickets are always locked in sorted id order, so two requests moving tasks
// between the same two tickets cannot deadlock. Every door locks the ticket
// before it touches a task.
async function lockTickets(client, orgId, ids) {
  const out = new Map();
  const unique = Array.from(new Set((ids || [])
    .filter(function (id) { return id != null && String(id) !== ''; })
    .map(String))).sort();
  for (const id of unique) {
    const r = await client.query(
      'SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [id, orgId]
    );
    if (r.rows[0]) out.set(id, r.rows[0]);
  }
  return out;
}

async function mayWrite(db, o) {
  const verdict = await access.mayAccessTicketParent({
    query: function (sql, params) { return db.query(sql, params); },
    user: o.user,
    parent: o.ticket,
    mode: 'write',
    orgId: o.orgId,
    hasCapability: o.hasCapability,
  });
  return !!(verdict && verdict.ok);
}

function locked(reason) {
  return { ok: false, status: 409, error: reason, code: 'work_order_locked' };
}

async function doneVerdict(db, o) {
  const ticket = o.ticket;
  if (await mayWrite(db, o)) {
    return svc.isTerminal(ticket.status) ? locked(MSG.closed) : { ok: true };
  }
  const task = o.task;
  const uid = o.user && o.user.id != null ? Number(o.user.id) : null;
  if (task && task.assignee_user_id != null && uid != null && Number(task.assignee_user_id) === uid) {
    const crew = svc.crewSubtasksWritable(ticket.status);
    return crew.ok ? { ok: true } : locked(crew.reason);
  }
  return { ok: false, status: 403, error: doneRefusal(ticket), code: 'no_access' };
}

async function structureVerdict(db, o) {
  const ticket = o.ticket;
  if (!(await mayWrite(db, o))) {
    return { ok: false, status: 403, error: structureRefusal(ticket), code: 'no_access' };
  }
  const shape = svc.subtaskStructureWritable(ticket.status);
  return shape.ok ? { ok: true } : locked(shape.reason);
}

// Reassigning a building. doneVerdict lets the ASSIGNEE finish or reopen one,
// so if anyone in the org could name the assignee, anyone could assign
// themselves in one request and finish the building in the next. Only someone
// who can edit the job (or lead) decides who a building is assigned to. The
// ticket's status is not asked: who a building is assigned to changes nothing
// on the punch list, and finishing it on a locked work order is refused anyway.
async function assignVerdict(db, o) {
  if (await mayWrite(db, o)) return { ok: true };
  return {
    ok: false, status: 403, code: 'no_access',
    error: 'Only someone who can edit this ' + parentWord(o.ticket) + ' can change who this task is assigned to.',
  };
}

// A door decides from the task row it read BEFORE locking the ticket (which
// ticket to lock, whether done-ness changes). Under the lock it reads the row
// again; if another door moved it to another ticket, archived it, or finished
// or reopened it in between, every one of those decisions is stale and the
// request is refused rather than written over the other door's change.
function taskShifted(before, now) {
  if (!before || !now) return true;
  const ticketOf = function (t) { return t.service_ticket_id == null ? '' : String(t.service_ticket_id); };
  return ticketOf(before) !== ticketOf(now) ||
    !!before.archived_at !== !!now.archived_at ||
    String(before.scope) !== String(now.scope) ||
    (before.status === 'done') !== (now.status === 'done');
}

function stale() {
  return { ok: false, status: 409, error: MSG.taskChanged, code: 'status_changed' };
}

function crewGate(lockedRow) {
  const crew = svc.crewSubtasksWritable(lockedRow && lockedRow.status);
  return crew.ok ? { ok: true } : locked(crew.reason);
}

// Called after COMMIT, never inside the transaction: a notice about a move
// that rolled back is a false alarm. Not awaited by the doors — each send is
// tracked so a deploy drains it.
function notifyMoves(list, actor, sharedBy, db) {
  const moves = (list || []).filter(function (m) { return m && m.ticket && m.movedTo === 'work_complete'; });
  if (!moves.length) return [];
  const inflight = require('./inflight');
  const ticketNotify = require('./service-ticket-notify');
  const pool = db || require('../db').pool;
  return moves.map(function (m) {
    const opts = { ticket: m.ticket, actor: actor, reason: 'all_subtasks_done' };
    if (sharedBy != null) opts.sharedBy = sharedBy;
    return inflight.track(ticketNotify.notifyAwaitingApproval(pool, opts), 'ticket_approval');
  });
}

module.exports = {
  MSG,
  isWorkOrderSubtask,
  lockTickets,
  doneVerdict,
  structureVerdict,
  assignVerdict,
  taskShifted,
  stale,
  crewGate,
  notifyMoves,
};
