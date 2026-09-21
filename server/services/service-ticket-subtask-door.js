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
//                                     WORK ORDER's assignee held to the crew
//                                     rule
//   structureVerdict(db, {user, orgId, ticket})
//                                     add / move / unlink / archive: a ticket
//                                     writer, on a ticket that is not approved,
//                                     closed or cancelled
//   assignVerdict()                   always a refusal: a BUILDING is never
//                                     assigned to anybody (1.35)
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
//
// ── RESPONSIBILITY SITS ON THE RECORD, NOT ON A BUILDING (1.35) ───────────
//
// The owner's rule, 2026-09-20, which overrides every earlier answer on this
// subject: "i dont want assignments to individual buildings like that, whoever
// is assigned to the ticket, task or work order is evenly responsible."
//
// So a BUILDING is never assigned to anybody. The one Assigned to that means
// anything is the work order's own (service_tickets.assignee_user_id, which
// the office sets from a real dropdown), and everyone on that record is
// equally responsible for every building on its punch list.
//
// tasks.assignee_user_id exists on a building row only because a building IS a
// task row — it was inherited by accident and no screen ever offered to set
// it. From 1.35 nothing reads it on a building (myOpenBuildingSql below and
// doneVerdict both ask the TICKET) and nothing writes it (assignVerdict
// refuses from every door). EXISTING DATA IS LEFT EXACTLY AS IT IS: there is
// no backfill and no clearing pass, because deleting a column's worth of
// history to enforce a rule that no longer reads it buys nothing. A value
// already sitting on a building row simply stops being read and stops being
// settable.

const svc = require('./service-tickets');
const access = require('./service-ticket-access');

const MSG = Object.freeze({
  closed: 'This work order is closed. Reopen it before changing its punch list.',
  startsOpen: 'A new subtask starts open. Add a completion photo to it, then mark it done.',
  doneNeedsPhoto: 'This task is marked done but has no completion photo. Reopen it or add a completion photo before putting it on a work order.',
  replyOnlyDoneNeedsPhoto: 'This line was finished as reply only, with no completion photo. Add a completion photo to it, or reopen it, before it needs one.',
  taskChanged: 'This task just changed. Reload to see the latest.',
  // ONE sentence, said the same way by every door that could have written
  // tasks.assignee_user_id on a building: the two REST doors, the task link,
  // and 86's payload dispatcher. A person reading it is told where the real
  // Assigned to lives and what it means, so the next thing they do is the
  // right thing rather than a spelling variant of the refused one.
  notAssignable: 'A building on a work order is never assigned to one person. ' +
    "Set the work order's Assigned to instead — everyone on it is equally responsible for every building on its punch list.",
});

function parentWord(ticket) {
  return access.parentOf(ticket).kind === 'lead' ? 'lead' : 'job';
}

// Names the rule doneVerdict actually applies (1.35): the WORK ORDER's
// Assigned to, not the building's. Naming the task's would send the reader to
// a field no screen sets and no door reads.
function doneRefusal(ticket) {
  return 'Only someone who can edit this ' + parentWord(ticket) +
    ', or the person this work order is assigned to, can finish or reopen it.';
}

function structureRefusal(ticket) {
  return 'Only someone who can edit this ' + parentWord(ticket) + " can change its work order's punch list.";
}

function isWorkOrderSubtask(task) {
  return !!(task && task.scope === 'org' && task.service_ticket_id != null &&
    String(task.service_ticket_id) !== '' && !task.archived_at);
}

// ── THE SAME RULE IN SQL (1.33) ────────────────────────────────────────────
//
// The owner's rule for this release: "service tickets are not to be confused
// with tasks, they are two different things; the subtasks in a service ticket
// shouldn't show up on any task lists separately." A building is not a to-do,
// so every task-list READ subtracts the buildings — and the only way SQL and
// isWorkOrderSubtask above cannot drift apart is for both to live here.
//
//   notAWorkOrderBuildingSql(alias)   the negation, for a task list's WHERE
//   myOpenBuildingSql(t, $n)          "this work order is ASSIGNED TO ME and
//                                      still has an open org building" — the
//                                      replacement read's whole predicate
//
// Buildings leaving the task lists is only SAFE because myOpenBuildingSql
// gives the people responsible for them somewhere else to see and reach them
// (GET /api/service-tickets/my-buildings).

// The SQL negation of isWorkOrderSubtask, for the WHERE of a task list.
//
// The `scope` arm is LOAD-BEARING, not belt-and-braces. server/routes/
// tasks-routes.js (the POST handler's `onWorkOrder` branch) treats a PERSONAL
// to-do carrying a service_ticket_id as its owner's own and never a subtask —
// it is not on the punch list and no work-order rule touches it. So a bare
// `service_ticket_id IS NULL` here would hide a private to-do from the only
// person who can see it at all: its owner.
//
// `archived_at IS NULL` is deliberately NOT repeated. It is already in the
// base WHERE of every list that will use this, and a second copy would read
// as though this predicate were the one deciding it.
function notAWorkOrderBuildingSql(alias) {
  const t = String(alias == null ? 't' : alias);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error('notAWorkOrderBuildingSql: bad table alias');
  return '(' + t + '.service_ticket_id IS NULL OR ' + t + ".scope = 'personal')";
}

// "This WORK ORDER is assigned to me, and it still has an open org building."
//
// 1.35 MOVED THE KEY FROM THE BUILDING TO THE RECORD. It used to read
// `wob.assignee_user_id = $n` — a building assigned to me — and that was the
// whole reason the five 1.34 surfaces answered nothing: tasks.assignee_user_id
// on a building is a column a building inherited by being a task row, and no
// screen has ever offered to set it. The Assigned to the office really sets is
// the WORK ORDER's own, so that is what this asks. Everyone on the record is
// equally responsible for every building on it, which is why the EXISTS arm
// says only "an open building", with no owner of its own.
//
// It is deliberately NOT the job-access rule (services/service-ticket-access.js
// listVisibility): doneVerdict below lets the work order's assignee finish a
// building on a job they cannot otherwise open, so a replacement gated on job
// access would show that person nothing — which is exactly the regression
// removing buildings from the task lists must not cause. It is also
// deliberately NOT an arm on work-order-recipients.js myTicketRelationSql:
// that SQL's only consumer is the board's "My approvals", and the assignee of
// a work order is not its approver.
//
// Every column is pinned to the TICKET's own organization, so a building can
// never be reached on the ticket id alone.
function myOpenBuildingSql(ticketAlias, meRef) {
  const t = String(ticketAlias == null ? 't' : ticketAlias);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error('myOpenBuildingSql: bad table alias');
  const me = String(meRef);
  if (!/^\$\d+$/.test(me)) throw new Error('myOpenBuildingSql: the user must be a $n parameter');
  return '(' + t + '.assignee_user_id = ' + me +
    ' AND EXISTS (SELECT 1 FROM tasks wob' +
    ' WHERE wob.service_ticket_id = ' + t + '.id' +
    ' AND wob.organization_id = ' + t + '.organization_id' +
    ' AND wob.archived_at IS NULL' +
    " AND wob.scope = 'org'" +
    " AND wob.status <> 'done'))";
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

// THE FINISH RULE FOLLOWS RESPONSIBILITY (1.35). The second arm used to be
// "the person this TASK is assigned to" — a field nothing sets — so in
// practice only a job editor could ever tick a building. It is now the WORK
// ORDER's assignee, held to the same crew rule: the crew lead the office put
// on the record can tick its buildings without being able to edit the job,
// which is the whole point of assigning a work order to someone.
//
// `o.task` is still accepted (every caller passes it) and is deliberately NOT
// read: a value left on a building row by an older release must not become a
// second, quieter way to get write access.
async function doneVerdict(db, o) {
  const ticket = o.ticket;
  if (await mayWrite(db, o)) {
    return svc.isTerminal(ticket.status) ? locked(MSG.closed) : { ok: true };
  }
  const uid = o.user && o.user.id != null ? Number(o.user.id) : null;
  if (ticket && ticket.assignee_user_id != null && uid != null && Number(ticket.assignee_user_id) === uid) {
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

// A BUILDING CAN NEVER BE ASSIGNED — to anybody, by anybody (1.35).
//
// This used to be a permission question ("may THIS caller name the assignee?"),
// answered yes for someone who could edit the job. It is no longer a
// permission question at all: responsibility sits on the record, so there is
// nobody a building may be assigned to and no caller who may do it. A job
// editor, the office, the work order's own assignee and 86 all get the same
// answer, and the refusal says where the real Assigned to is.
//
// It takes no arguments and asks no database. The (db, o) call sites are still
// valid — extra arguments are ignored and `await` on a plain object is the
// object — so a door that has not been re-read still refuses correctly. The
// ticket's status is not asked either: the answer is the same on every status.
function assignVerdict() {
  return { ok: false, status: 409, code: 'building_not_assignable', error: MSG.notAssignable };
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
  notAWorkOrderBuildingSql,
  myOpenBuildingSql,
  lockTickets,
  doneVerdict,
  structureVerdict,
  assignVerdict,
  taskShifted,
  stale,
  crewGate,
  notifyMoves,
};
