'use strict';

// Review & approve (1.29): the rules for moving a work order through the
// office's decisions — approve, take back an approval, send back for more
// work, cancel, reopen — and the readers the office detail and the crew link
// use to show what the office decided.
//
// This file holds the PURE rules (reasonRule, normalizeReason, statusStamps,
// normalizeReopenList, sendBackFromEvent), two small READERS (activeSendBack,
// peopleNames) and THE ONE STATUS EXECUTOR, changeStatus, which every office
// status move (POST /api/service-tickets/:id/status) runs through. The lattice
// itself is still decided in one place, svc.ticketMayTransition; this file adds
// the reasons, the stamps, the send-back and the concurrency guard around it.
//
// Why the typed text goes under detail.note and never detail.reason:
// status_changed.detail.reason already carries MACHINE codes
// (all_subtasks_done, subtask_reopened, marked_complete, ...) that the approval
// notice, the crew undo rule and the timeline read. Free text there would be
// mistaken for a code.
//
// Why the send-back banner is DERIVED from events rather than stored: the
// newest relevant status_changed row answers "is the crew still redoing work?"
// by construction. A send-back is followed, sooner or later, by an arrival at
// work_complete through one of three doors (office move, the crew's Mark work
// complete, the last building ticked), and every one of them logs
// status_changed with to 'work_complete'. Nothing has to remember to clear a
// flag.
//
// NO MONEY: nothing here reads a price, a cost or a contract field.
// TENANCY: every statement carries organization_id = $n taken from the ticket
// row (or the org id) the caller already proved.

const svc = require('./service-tickets');
// Phase 2: WO-#### / ST-####, minted when a draft is issued.
const ticketNumbers = require('./ticket-numbers');

const REASON_MAX = 1000;
const BUILDING_NOTE_MAX = 500;
const REOPEN_MAX = 200;
const STALE_ERROR = 'This work order just changed. Reload to see the latest.';

const REASON_MESSAGES = Object.freeze({
  send_back: 'Say what needs fixing. The crew sees this on their link.',
  cancel: 'Say why this work order is being cancelled.',
  reopen: 'Say why this work order is being reopened.',
  unapprove: 'Say why the approval is being taken back.',
});

const REOPEN_ERRORS = Object.freeze({
  notList: 'Buildings to reopen must be a list.',
  tooMany: 'Too many buildings in one send-back.',
  badId: 'One of those buildings is not on this work order.',
});

const CREW_BAND = Object.freeze(['open', 'scheduled', 'in_progress']);
const TASK_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// Control characters other than the newline. \r is folded into \n first, so a
// CRLF from a textarea does not leave a stray space at every line end.
const CONTROL_RE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g;

// An unknown status reads as draft (svc.normalizeStatus), which is outside the
// crew band and stands for no office decision — the narrow reading.
function statusOf(s) {
  return svc.normalizeStatus(s);
}

/**
 * normalizeReason(raw, max) -> string ('' when blank)
 * Control characters become spaces (newlines are kept), runs of 3+ newlines
 * collapse to 2, the ends are trimmed, and the text is capped BY CODE POINT so
 * an emoji at the cap is never cut in half.
 */
function normalizeReason(raw, max) {
  const cap = Number.isFinite(Number(max)) && Number(max) > 0 ? Math.floor(Number(max)) : REASON_MAX;
  let s = String(raw == null ? '' : raw)
    .replace(/\r\n?/g, '\n')
    .replace(CONTROL_RE, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (!s) return '';
  const points = Array.from(s);
  if (points.length > cap) s = points.slice(0, cap).join('').trim();
  return s;
}

/**
 * reasonRule(from, to) -> { action, required, message }
 * action is the office decision a move stands for (null for an ordinary
 * move); required says whether a typed reason must come with it.
 */
function reasonRule(from, to) {
  const f = statusOf(from);
  const t = statusOf(to);
  const none = { action: null, required: false, message: null };
  if (f === t) return none;
  if (t === 'approved') return { action: 'approve', required: false, message: null };
  if (f === 'approved' && t === 'work_complete') {
    return { action: 'unapprove', required: true, message: REASON_MESSAGES.unapprove };
  }
  if (f === 'work_complete' && t === 'in_progress') {
    return { action: 'send_back', required: true, message: REASON_MESSAGES.send_back };
  }
  if (t === 'cancelled') return { action: 'cancel', required: true, message: REASON_MESSAGES.cancel };
  if ((f === 'closed' || f === 'cancelled') && t === 'open') {
    return { action: 'reopen', required: true, message: REASON_MESSAGES.reopen };
  }
  return none;
}

/**
 * statusStamps(from, to, actorRef, orgRef) -> string[] of SET fragments
 *
 * actorRef and orgRef are the caller's placeholders ('$4', '$3'). The caller
 * binds the actor parameter only when a returned fragment references actorRef:
 * Postgres refuses a bound parameter that the statement never uses.
 *
 * approved_by / cancelled_by go through an in-org subquery, so an act-as
 * platform user from another org stores NULL instead of another tenant's user
 * id. Approved -> cancelled and approved -> closed keep the approval stamps
 * (history, and the completion report needs them).
 */
function statusStamps(from, to, actorRef, orgRef) {
  const f = statusOf(from);
  const t = statusOf(to);
  const out = [];
  if (f === t) return out;
  const org = orgRef ? String(orgRef) : 'service_tickets.organization_id';
  const who = actorRef
    ? '(SELECT u.id FROM users u WHERE u.id = ' + actorRef + ' AND u.organization_id = ' + org + ')'
    : 'NULL';
  if (t === 'work_complete') {
    out.push('completed_at = COALESCE(completed_at, NOW())');
    if (f === 'approved') out.push('approved_at = NULL', 'approved_by = NULL');
  }
  if (t === 'in_progress' || t === 'scheduled' || t === 'open') {
    out.push('completed_at = NULL', 'approval_notified_at = NULL');
  }
  if (t === 'closed') out.push('closed_at = NOW()');
  if (t === 'open') {
    out.push('closed_at = NULL');
    if (f === 'closed' || f === 'cancelled') {
      out.push('approved_at = NULL', 'approved_by = NULL', 'cancelled_at = NULL', 'cancelled_by = NULL');
    }
  }
  if (t === 'approved') out.push('approved_at = NOW()', 'approved_by = ' + who);
  if (t === 'cancelled') out.push('cancelled_at = NOW()', 'cancelled_by = ' + who);
  return out;
}

/**
 * normalizeReopenList(raw) -> { ok: true, list: [{ id, note }] } | { ok: false, error }
 * Entries are task ids or { id, note }. The first entry for an id wins; a
 * blank note is null.
 */
function normalizeReopenList(raw) {
  if (!Array.isArray(raw)) return { ok: false, error: REOPEN_ERRORS.notList };
  if (raw.length > REOPEN_MAX) return { ok: false, error: REOPEN_ERRORS.tooMany };
  const list = [];
  const seen = Object.create(null);
  for (const entry of raw) {
    let id;
    let note = null;
    if (typeof entry === 'string' || typeof entry === 'number') {
      id = entry;
    } else if (entry && typeof entry === 'object' && !Array.isArray(entry)) {
      id = entry.id;
      note = entry.note;
    } else {
      return { ok: false, error: REOPEN_ERRORS.badId };
    }
    if (typeof id !== 'string' && typeof id !== 'number') return { ok: false, error: REOPEN_ERRORS.badId };
    const key = String(id).trim();
    if (!TASK_ID_RE.test(key)) return { ok: false, error: REOPEN_ERRORS.badId };
    if (seen[key]) continue;
    seen[key] = true;
    list.push({ id: key, note: normalizeReason(note, BUILDING_NOTE_MAX) || null });
  }
  return { ok: true, list: list };
}

function parseDetail(d) {
  if (typeof d === 'string') {
    try { return JSON.parse(d); } catch (_) { return null; }
  }
  return d && typeof d === 'object' ? d : null;
}

/**
 * sendBackFromEvent(eventRow, ticketStatus, tasks) -> banner | null
 *
 * eventRow is the NEWEST status_changed row that is either a send-back or an
 * arrival at work_complete. Only a send-back on a ticket still in the crew
 * band is a live banner: once the work arrives at work_complete again, or the
 * office approves, closes or cancels, there is nothing left to redo.
 * Buildings are filtered to the ticket's current live tasks and carry the
 * CURRENT title, so a renamed building reads as it does now.
 */
function sendBackFromEvent(eventRow, ticketStatus, tasks) {
  if (CREW_BAND.indexOf(statusOf(ticketStatus)) < 0) return null;
  if (!eventRow) return null;
  const detail = parseDetail(eventRow.detail);
  if (!detail || detail.action !== 'send_back') return null;
  const byId = new Map();
  for (const t of Array.isArray(tasks) ? tasks : []) {
    if (t && t.id != null) byId.set(String(t.id), t);
  }
  const buildings = (Array.isArray(detail.buildings) ? detail.buildings : [])
    .filter(function (b) { return b && b.task_id != null && byId.has(String(b.task_id)); })
    .map(function (b) {
      const task = byId.get(String(b.task_id));
      return {
        id: task.id,
        title: task.title == null ? '' : String(task.title),
        note: b.note ? String(b.note) : null,
        reopened: !!b.reopened,
      };
    });
  return {
    note: detail.note ? String(detail.note) : '',
    at: eventRow.created_at,
    buildings: buildings,
  };
}

/**
 * activeSendBack(db, ticket, tasks) -> banner | null
 * No query at all unless the ticket is in the crew band.
 */
async function activeSendBack(db, ticket, tasks) {
  if (!ticket || ticket.organization_id == null || !ticket.id) return null;
  if (CREW_BAND.indexOf(statusOf(ticket.status)) < 0) return null;
  const r = await db.query(
    `SELECT id, detail, created_at FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'status_changed'
        AND (detail->>'action' = 'send_back' OR detail->>'to' = 'work_complete')
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ticket.id, ticket.organization_id]
  );
  return sendBackFromEvent(r.rows[0] || null, ticket.status, tasks);
}

/**
 * peopleNames(db, orgId, ids) -> { [id]: name }
 * In-org users only; no query when there is no id to look up.
 */
async function peopleNames(db, orgId, ids) {
  const out = {};
  if (orgId == null) return out;
  const want = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    if (raw == null || raw === '') continue;
    const n = Number(raw);
    if (Number.isSafeInteger(n) && n > 0 && want.indexOf(n) < 0) want.push(n);
  }
  if (!want.length) return out;
  const r = await db.query(
    'SELECT id, name FROM users WHERE id = ANY($1::int[]) AND organization_id = $2',
    [want, orgId]
  );
  for (const row of r.rows) out[String(row.id)] = row.name;
  return out;
}

// Required on call rather than at the top: the pure half of this file loads
// with nothing but ./service-tickets, and a temp copy of it (the rules suite's
// mutants) must still load where no sibling module sits next to it.
function workOrderService() {
  return require('./service-ticket-workorder');
}

// Same reason, and there is no cycle: service-ticket-flags requires only
// service-tickets, service-ticket-workorder and service-ticket-access.
function flagsService() {
  return require('./service-ticket-flags');
}

function refusal(status, error, extra) {
  return Object.assign({ ok: false, status: status, error: error }, extra || {});
}

function stale(currentStatus) {
  return refusal(409, STALE_ERROR, {
    code: 'status_changed',
    current_status: currentStatus == null ? null : currentStatus,
  });
}

function positiveUserId(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

/**
 * changeStatus(db, { ticket, next, expectedStatus, reason, override, copyScope,
 *                    reopenTasks, actor: { userId, label }, returning })
 *   -> { ok: true, applied: false, ticket }
 *    | { ok: true, applied: true, ticket, from, to, action, sendBack: { note, buildings } | null }
 *    | { ok: false, status, error, code?, current_status?, open?, total? }
 *
 * `ticket` is the row the route loaded, already proved in the caller's org and
 * write-checked. `returning` is the route's column list, so there is still one.
 *
 * ORDER, and why:
 *   1. expected_status first. A screen that is out of date gets "reload", not a
 *      lattice refusal about a move it only offered because it was stale.
 *   2. the lattice (svc.ticketMayTransition) -> 403.
 *   3. the same status -> nothing to do.
 *   4. a required reason -> 400.
 *   5. reopen_tasks -> 400.
 *   6. BEGIN; the ticket row is locked FOR UPDATE and re-read; open subtasks are
 *      counted INSIDE that lock, so a building reopened at the same moment
 *      cannot let Work complete land with buildings open and no override.
 *   7. the guarded UPDATE (AND status = <the status this request saw>): a
 *      concurrent move leaves it matching no row -> 409, nothing written.
 *   8. strict events; COMMIT. Notices are the caller's, after COMMIT.
 *
 * Postgres refuses a bound parameter a statement never references, so the
 * actor id is bound only when a stamp uses it.
 */
async function changeStatus(db, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  if (!ticket || ticket.id == null || ticket.organization_id == null) {
    return refusal(404, 'Service ticket not found');
  }
  const orgId = ticket.organization_id;
  const from = ticket.status;

  const expected = o.expectedStatus == null ? '' : String(o.expectedStatus).trim();
  if (expected && svc.normalizeStatus(expected) !== from) return stale(from);

  const verdict = svc.ticketMayTransition(from, o.next, 'user');
  if (!verdict.ok) return refusal(403, verdict.reason);
  const next = String(o.next == null ? '' : o.next).trim().toLowerCase();
  if (next === from) return { ok: true, applied: false, ticket: ticket };

  const rule = reasonRule(from, next);
  const note = normalizeReason(o.reason, REASON_MAX);
  if (rule.required && !note) return refusal(400, rule.message);

  let reopen = [];
  if (o.reopenTasks !== undefined && o.reopenTasks !== null) {
    if (rule.action !== 'send_back') return refusal(400, 'Buildings can only be reopened when sending work back.');
    const listed = normalizeReopenList(o.reopenTasks);
    if (!listed.ok) return refusal(400, listed.error);
    reopen = listed.list;
  }

  const actor = o.actor || {};
  const eventActor = { kind: 'user', userId: positiveUserId(actor.userId), label: actor.label || null };
  const returning = o.returning ? String(o.returning) : 'id, organization_id, status';
  const workOrder = workOrderService();

  const client = await db.connect();
  let began = false;
  try {
    await client.query('BEGIN');
    began = true;
    const rollback = async function (answer) {
      began = false;
      await client.query('ROLLBACK');
      return answer;
    };

    const lockedRes = await client.query(
      `SELECT status, scope_proposed FROM service_tickets
        WHERE id = $1 AND organization_id = $2 FOR UPDATE`,
      [ticket.id, orgId]
    );
    const locked = lockedRes.rows[0];
    if (!locked) return await rollback(refusal(404, 'Service ticket not found'));
    if (locked.status !== from) return await rollback(stale(locked.status));

    // Buildings still open on an arrival at Work complete. Taking back an
    // approval is exempt: the office already decided that ticket once.
    let openInfo = null;
    if (next === 'work_complete' && from !== 'approved') {
      const c = await workOrder.subtaskCounts(client, ticket);
      const open = c.total - c.done;
      if (c.total > 0 && open > 0) {
        if (o.override !== true) {
          return await rollback(refusal(409, svc.openSubtasksLine(open, c.total, 'subtask') + ' done yet.', {
            code: 'buildings_open', open: open, total: c.total,
          }));
        }
        openInfo = { open: open, total: c.total };
      }
    }

    // Every building named on a send-back must be a live org subtask of THIS
    // ticket, in this org, before anything is written.
    const taskById = new Map();
    if (rule.action === 'send_back' && reopen.length) {
      const ids = reopen.map(function (b) { return b.id; });
      const found = await client.query(
        `SELECT id, title, status FROM tasks
          WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND organization_id = $3
            AND archived_at IS NULL AND scope = 'org'`,
        [ids, ticket.id, orgId]
      );
      for (const row of found.rows) taskById.set(String(row.id), row);
      if (reopen.some(function (b) { return !taskById.has(b.id); })) {
        return await rollback(refusal(400, REOPEN_ERRORS.badId));
      }
    }

    const params = [next, ticket.id, orgId];
    const actorRef = '$4';
    const sets = statusStamps(from, next, actorRef, '$3');
    if (sets.some(function (s) { return s.indexOf(actorRef) >= 0; })) params.push(eventActor.userId);
    const copyScope = rule.action === 'approve' && o.copyScope === true;
    if (copyScope) sets.push("scope_approved = COALESCE(NULLIF(TRIM(scope_proposed), ''), scope_approved)");

    // A draft is not issued yet and carries no number; every other status
    // does. Minted here, inside the same transaction and the same guarded
    // UPDATE as the move, so a ticket cannot end up issued without one — or
    // numbered by a move that was then refused. The series follows how it
    // bills: ST-#### for a contract, WO-#### for everything else.
    if (!ticket.ticket_number && ticketNumbers.statusWantsNumber(next)) {
      const claimed = await ticketNumbers.nextNumber(client, orgId, ticket.bill_as);
      params.push(claimed);
      sets.push('ticket_number = COALESCE(ticket_number, $' + params.length + ')');
    }
    params.push(from);
    const statusRef = '$' + params.length;
    const updated = await client.query(
      'UPDATE service_tickets SET status = $1' + (sets.length ? ', ' + sets.join(', ') : '') +
        ', updated_at = NOW() WHERE id = $2 AND organization_id = $3 AND status = ' + statusRef +
        ' RETURNING ' + returning,
      params
    );
    const row = updated.rows[0];
    if (!row) {
      await rollback(null);
      let current = null;
      try {
        const now = await db.query(
          'SELECT status FROM service_tickets WHERE id = $1 AND organization_id = $2',
          [ticket.id, orgId]
        );
        current = now.rows[0] ? now.rows[0].status : null;
      } catch (_) { current = null; }
      return stale(current);
    }

    const reopenedIds = new Set();
    if (rule.action === 'send_back' && reopen.length) {
      const moved = await client.query(
        `UPDATE tasks SET status = 'open', completed_at = NULL, updated_at = NOW()
          WHERE id = ANY($1::text[]) AND service_ticket_id = $2 AND organization_id = $3
            AND archived_at IS NULL AND scope = 'org' AND status = 'done'
        RETURNING id`,
        [reopen.map(function (b) { return b.id; }), ticket.id, orgId]
      );
      for (const m of moved.rows) reopenedIds.add(String(m.id));
    }

    const buildings = reopen.map(function (b) {
      const task = taskById.get(b.id) || {};
      return {
        task_id: task.id != null ? task.id : b.id,
        title: String(task.title == null ? '' : task.title).slice(0, 200),
        note: b.note || null,
        reopened: reopenedIds.has(b.id),
      };
    });

    // Strict: on Postgres a failed insert aborts the transaction, and a
    // swallowed one would turn COMMIT into a silent ROLLBACK of the move.
    const strict = { strict: true };
    for (const b of buildings) {
      if (b.reopened) {
        await workOrder.insertEvent(client, ticket, 'subtask_reopened', eventActor,
          { task_id: b.task_id, title: b.title, via: 'send_back' }, strict);
      }
    }
    for (const b of buildings) {
      if (b.note) {
        await workOrder.insertEvent(client, ticket, 'subtask_note', eventActor,
          { task_id: b.task_id, note: b.note, sent_back: true }, strict);
      }
    }
    // A work order that ends does not leave the crew's problems open behind
    // it. The office UI only offers Resolve while a ticket is editable, so an
    // open flag on a closed or cancelled ticket would keep the job's Service
    // Tickets chip red with no way back in. Same client and the same `strict`
    // as the events above: a failed flag_resolved line rolls the move back
    // rather than turning COMMIT into a silent no-op.
    if (next === 'closed' || next === 'cancelled') {
      await flagsService().resolveOpenFlagsOnClose(
        client, ticket, eventActor,
        next === 'cancelled' ? 'Cancelled with the work order.' : 'Closed with the work order.',
        strict
      );
    }

    // The typed text goes under `note`; `reason` stays a machine code.
    const detail = { from: from, to: next };
    if (rule.action) detail.action = rule.action;
    if (note) detail.note = note;
    if (buildings.length) detail.buildings = buildings;
    if (copyScope && String(locked.scope_proposed == null ? '' : locked.scope_proposed).trim()) detail.scope_copied = true;
    if (openInfo) {
      detail.override = 'buildings_open';
      detail.open = openInfo.open;
      detail.total = openInfo.total;
    }
    await workOrder.insertEvent(client, ticket, 'status_changed', eventActor, detail, strict);

    await client.query('COMMIT');
    began = false;

    return {
      ok: true,
      applied: true,
      ticket: row,
      from: from,
      to: next,
      action: rule.action,
      sendBack: rule.action === 'send_back'
        ? { note: note, buildings: buildings.map(function (b) { return Object.assign({}, b); }) }
        : null,
    };
  } catch (e) {
    if (began) {
      try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters */ }
    }
    throw e;
  } finally {
    client.release();
  }
}

module.exports = {
  REASON_MAX,
  BUILDING_NOTE_MAX,
  REOPEN_MAX,
  STALE_ERROR,
  normalizeReason,
  reasonRule,
  statusStamps,
  normalizeReopenList,
  sendBackFromEvent,
  activeSendBack,
  peopleNames,
  changeStatus,
};
