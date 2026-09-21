'use strict';

// PHOTO PROOF STAYS PUT (Work Orders 1.29, A2).
//
// A work order's photos are its proof: the completion photo on each building is
// what lets the building be marked done, and after approval the whole set is
// the record of what was approved. Before this guard, the attachment doors
// could quietly take that proof away — delete the photo, move it to another
// job, or retag a completion photo as a before photo — and the building stayed
// "done" with nothing behind it.
//
// THE RULES (images only; documents stay manageable):
//   (a) An APPROVED or CLOSED work order keeps its photos: no delete, no move
//       off it. Cancelled and draft work orders are not locked.
//   (b) On an approved or closed work order a building's completion photo
//       cannot become a before photo.
//   (c) A building that is marked done keeps at least one completion photo:
//       removing (or retagging) the last one is refused until the building is
//       undone. Not applied on a cancelled work order, where nothing is waiting
//       to be approved and "Undo the building first" is not possible anyway.
//
// HOW IT HOLDS UNDER CONCURRENCY. Every check runs under `SELECT ... FOR
// UPDATE` on the ticket row — the same lock the subtask door
// (service-ticket-workorder.js setSubtaskDone) takes — so a building cannot be
// marked done between the count and the delete. Tickets are locked in sorted
// id order, like every other path that locks more than one.
//
// EVENTS. photo_removed / photo_retagged go on the ticket's timeline AFTER the
// change commits, best-effort (insertEvent non-strict): inside the transaction
// a failed INSERT would turn COMMIT into a silent ROLLBACK on Postgres, and a
// missing timeline row must never undo the change it describes.
//
// TWO WAYS IN.
//   changeWorkOrderPhotos(pool, {...apply})  owns its transaction; the HTTP
//     doors in routes/attachment-routes.js use it.
//   checkWorkOrderPhotos(client, {...})      runs inside a transaction the
//     caller already opened (86's payload dispatcher: photo_updates retags,
//     attach_files moves). It returns a refusal or null, and schedules the
//     events on the caller's afterCommit list.
//
// TENANCY: every statement carries organization_id = $n, from the caller's
// proven org or the loaded ticket row.

const svc = require('./service-tickets');
const workOrder = require('./service-ticket-workorder');

const OPS = Object.freeze(['delete', 'move', 'retag']);
const LOCKED_STATUSES = Object.freeze(['approved', 'closed']);
const WORK_ORDER_ENTITY_TYPES = Object.freeze(['task', 'service_ticket']);
const HEAD_MAX = 80;
const TITLE_MAX = 200;

function lockedMessage(status, op) {
  const lead = 'This work order is ' + status + ', so ';
  if (op === 'retag') return lead + "its completion photos can't be changed to before photos. Reopen the work order first.";
  return lead + "its photos are part of the record and can't be " + (op === 'move' ? 'moved off it' : 'deleted') +
    '. Reopen the work order first if a photo has to go.';
}

function lastPhotoMessage(head, op) {
  const ending = op === 'move' ? 'move the photo'
    : op === 'retag' ? 'change it to a before photo'
      : 'delete the photo';
  return 'This is the only completion photo on ' + head + ', and ' + head + ' is marked done. Undo ' + head +
    ' first, then ' + ending + '.';
}

// "Bldg 784 — north side" -> "Bldg 784". The head is the part before the first
// em dash, en dash or spaced hyphen, at most 80 characters.
function subtaskHead(title) {
  let t = String(title == null ? '' : title);
  let cut = -1;
  [' \u2014 ', ' \u2013 ', ' - '].forEach(function (sep) {
    const i = t.indexOf(sep);
    if (i >= 0 && (cut < 0 || i < cut)) cut = i;
  });
  if (cut >= 0) t = t.slice(0, cut);
  t = t.trim().slice(0, HEAD_MAX).trim();
  return t || 'this subtask';
}

function isImage(att) {
  return !!att && /^image\//i.test(String(att.mime_type == null ? '' : att.mime_type));
}

// Pure: could this attachment be work-order proof? (An image on a task or on a
// ticket.) Only these need the guard's look; everything else keeps its door.
function mayBeWorkOrderPhoto(att) {
  return isImage(att) && WORK_ORDER_ENTITY_TYPES.indexOf(att.entity_type) >= 0;
}

// before | completion for a building photo; site for a photo on the ticket.
function kindFor(att, tags) {
  return att && att.entity_type === 'task' ? svc.photoKindOf(tags) : 'site';
}

// Pure: would giving this attachment `nextTags` change what it proves? Only a
// building (task) image can move between before and completion; a ticket's
// own photos are site photos whatever their tags.
function retagChangesProof(att, nextTags) {
  return mayBeWorkOrderPhoto(att) && kindFor(att, att.tags) !== kindFor(att, nextTags);
}

// FAIL CLOSED ON THE ARGUMENTS. A retag with no word on what the tags become
// would see every photo keep its kind and let every change through; a missing
// org would find no work order and do the same. Neither is a pass: both throw.

// nextTags (op 'retag' only): an array (every photo gets it), a Map or plain
// object keyed by attachment id (it must name every photo it is asked about),
// a function(att) (undefined = the photo keeps its tags), or any of those as a
// JSON string (the form bound for $n::jsonb). Anything else throws.
function nextTagsShape(nextTags) {
  let v = nextTags;
  if (typeof v === 'string') {
    try { v = JSON.parse(v); } catch (_) { v = undefined; }
  }
  if (Array.isArray(v) || v instanceof Map || typeof v === 'function') return v;
  if (v && typeof v === 'object') {
    const proto = Object.getPrototypeOf(v);
    if (proto === Object.prototype || proto === null) return v;
  }
  throw new TypeError('work-order-photo-guard: a retag needs nextTags — the new tags as an array, a Map or object ' +
    'keyed by attachment id, or a function(att) (got ' + (v === null ? 'null' : typeof nextTags) + ')');
}

function nextTagsReader(nextTags) {
  const v = nextTagsShape(nextTags);
  if (typeof v === 'function') {
    return function (att) { const t = v(att); return t === undefined ? att.tags : t; };
  }
  if (Array.isArray(v)) return function () { return v; };
  const isMap = v instanceof Map;
  return function (att) {
    const key = String(att.id);
    if (isMap) {
      if (v.has(key)) return v.get(key);
      if (v.has(att.id)) return v.get(att.id);
    } else if (Object.prototype.hasOwnProperty.call(v, key)) {
      return v[key];
    }
    throw new TypeError('work-order-photo-guard: nextTags names no tags for attachment ' + key);
  };
}

function checkOp(op) {
  if (OPS.indexOf(op) < 0) throw new TypeError('work-order-photo-guard: op must be delete, move or retag (got ' + op + ')');
}

function checkOrg(orgId) {
  if (orgId == null || orgId === '') {
    throw new TypeError('work-order-photo-guard: orgId is required (the caller\'s proven organization)');
  }
}

// Every way in checks the whole argument shape before it touches the database.
function checkChange(o) {
  checkOp(o.op);
  checkOrg(o.orgId);
  if (o.op === 'retag') nextTagsShape(o.nextTags);
}

async function loadTicket(db, ticketId, orgId, lock) {
  const r = await db.query(
    'SELECT id, organization_id, title, status FROM service_tickets WHERE id = $1 AND organization_id = $2' +
      (lock ? ' FOR UPDATE' : ''),
    [String(ticketId), orgId]
  );
  return r.rows[0] || null;
}

async function loadWorkOrderTask(db, taskId, orgId) {
  const r = await db.query(
    `SELECT id, title, status, archived_at, service_ticket_id, kind FROM tasks
      WHERE id = $1 AND organization_id = $2 AND scope = 'org' AND service_ticket_id IS NOT NULL`,
    [String(taskId), orgId]
  );
  return r.rows[0] || null;
}

/**
 * workOrderOf(db, att, orgId, { lock }) -> { ticket, task } | null
 *
 * The work order an attachment's photo belongs to: a ticket's own photo
 * (task null), or a photo on one of its org subtasks. Anything else — another
 * entity type, a personal to-do, a task on no ticket, a ticket in another org
 * — is null, and for other entity types no query runs.
 *
 * With lock the ticket row is taken FOR UPDATE and the task is read again
 * under that lock, so its status and its link are the ones the check sees.
 */
async function workOrderOf(db, att, orgId, opts) {
  if (!att || orgId == null) return null;
  const lock = !!(opts && opts.lock);
  const entityId = att.entity_id == null ? '' : String(att.entity_id);
  if (!entityId) return null;
  if (att.entity_type === 'service_ticket') {
    const ticket = await loadTicket(db, entityId, orgId, lock);
    return ticket ? { ticket: ticket, task: null } : null;
  }
  if (att.entity_type !== 'task') return null;

  let task = await loadWorkOrderTask(db, entityId, orgId);
  // A task moved to another ticket between the read and the lock is followed
  // to its new ticket; after that it cannot move again without that lock.
  for (let pass = 0; task && pass < 3; pass++) {
    const ticket = await loadTicket(db, task.service_ticket_id, orgId, lock);
    if (!ticket) return null;
    if (!lock) return { ticket: ticket, task: task };
    const fresh = await loadWorkOrderTask(db, entityId, orgId);
    if (fresh && String(fresh.service_ticket_id) === String(ticket.id)) return { ticket: ticket, task: fresh };
    task = fresh;
  }
  return null;
}

/**
 * isWorkOrderPhoto(db, att, orgId) -> boolean
 * An image that belongs to a work order right now (an unlocked look). The doors
 * use it to choose the guarded path; the guard itself reads again under the
 * lock. No query for a document or for another entity type.
 */
async function isWorkOrderPhoto(db, att, orgId) {
  if (!mayBeWorkOrderPhoto(att)) return false;
  return !!(await workOrderOf(db, att, orgId, { lock: false }));
}

function refusal(code, error, att, wo) {
  return {
    ok: false,
    status: 409,
    code: code,
    error: error,
    attachment_id: att ? att.id : null,
    task_id: wo && wo.task ? wo.task.id : null,
  };
}

/**
 * proofVerdict(db, wo, { orgId, removing, op, nextTags }) -> { ok:true } | refusal
 *
 * removing: the attachment rows of THIS work order being deleted, moved off or
 * retagged. Only images count. op: 'delete' | 'move' | 'retag'. For a retag,
 * nextTags (required; see nextTagsShape) says what each photo's tags become.
 */
async function proofVerdict(db, wo, opts) {
  const o = opts || {};
  checkOp(o.op);
  const op = o.op;
  const nextFor = op === 'retag' ? nextTagsReader(o.nextTags) : null;
  if (!wo || !wo.ticket) return { ok: true };
  const images = (Array.isArray(o.removing) ? o.removing : []).filter(isImage);
  if (!images.length) return { ok: true };

  const status = svc.normalizeStatus(wo.ticket.status);
  const task = wo.task || null;
  // The completion photos this change takes away from the building.
  const losing = images.filter(function (att) {
    if (!task || kindFor(att, att.tags) !== 'completion') return false;
    return op !== 'retag' || kindFor(att, nextFor(att)) === 'before';
  });

  if (LOCKED_STATUSES.indexOf(status) >= 0) {
    if (op !== 'retag') return refusal('photo_locked', lockedMessage(status, op), images[0], wo);
    if (losing.length) return refusal('photo_locked', lockedMessage(status, op), losing[0], wo);
  }

  // Rule (c) is a building's PROOF. A reply-only line (svc.subtaskNeedsPhoto)
  // was finished without one, so a photo on it is extra, never its last proof.
  if (task && losing.length && task.status === 'done' && !task.archived_at && status !== 'cancelled' &&
      svc.subtaskNeedsPhoto(task)) {
    const orgId = wo.ticket.organization_id != null ? wo.ticket.organization_id : o.orgId;
    checkOrg(orgId);
    const r = await db.query(
      `SELECT id, tags FROM attachments
        WHERE entity_type = 'task' AND entity_id = $1 AND organization_id = $2 AND mime_type LIKE 'image/%'`,
      [String(task.id), orgId]
    );
    const changing = new Map(images.map(function (att) { return [String(att.id), att]; }));
    const left = r.rows.filter(function (row) {
      const mine = changing.get(String(row.id));
      if (!mine) return svc.photoKindOf(row.tags) === 'completion';
      if (op !== 'retag') return false;
      return svc.photoKindOf(nextFor(mine)) === 'completion';
    }).length;
    if (left === 0) {
      return refusal('last_completion_photo', lastPhotoMessage(subtaskHead(task.title), op), losing[0], wo);
    }
  }
  return { ok: true };
}

function eventsFor(wo, atts, op, nextFor, actor) {
  const task = wo.task || null;
  const title = task ? String(task.title == null ? '' : task.title).slice(0, TITLE_MAX) : null;
  const out = [];
  atts.forEach(function (att) {
    if (op === 'retag') {
      if (!task) return;
      const from = kindFor(att, att.tags);
      const to = kindFor(att, nextFor(att));
      if (from === to) return;
      out.push({ ticket: wo.ticket, kind: 'photo_retagged', actor: actor || null,
        detail: { attachment_id: att.id, task_id: task.id, title: title, from: from, to: to } });
      return;
    }
    out.push({ ticket: wo.ticket, kind: 'photo_removed', actor: actor || null,
      detail: {
        attachment_id: att.id,
        task_id: task ? task.id : null,
        title: title,
        kind: kindFor(att, att.tags),
        how: op === 'move' ? 'moved' : 'deleted',
      } });
  });
  return out;
}

/**
 * planPhotoChange(db, { orgId, atts, op, nextTags, actor, lock }) ->
 *   { refusal: null | refusal, events: [{ ticket, kind, actor, detail }] }
 *
 * Finds the work orders the photos belong to (locking them, in sorted ticket
 * id order, when lock is set), runs the verdict per work order and builds the
 * timeline events. Writes nothing.
 */
async function planPhotoChange(db, opts) {
  const o = opts || {};
  checkChange(o);
  const op = o.op;
  const nextFor = op === 'retag' ? nextTagsReader(o.nextTags) : null;
  const relevant = (Array.isArray(o.atts) ? o.atts : []).filter(function (att) {
    if (!mayBeWorkOrderPhoto(att)) return false;
    // A retag that does not change what the photo proves is not a proof change.
    // Only a building photo has a kind to change; a site photo stays a site photo.
    return op !== 'retag' || (att.entity_type === 'task' && kindFor(att, att.tags) !== kindFor(att, nextFor(att)));
  });
  if (!relevant.length) return { refusal: null, events: [] };

  const groups = new Map();
  relevant.forEach(function (att) {
    const key = att.entity_type + ':' + String(att.entity_id);
    if (!groups.has(key)) groups.set(key, { sample: att, atts: [] });
    groups.get(key).atts.push(att);
  });

  // The ticket each group hangs on, read without a lock, only to order the
  // locks. The verdict below runs on what is read again under them.
  const ordered = [];
  for (const g of groups.values()) {
    if (g.sample.entity_type === 'service_ticket') {
      ordered.push({ group: g, ticketKey: String(g.sample.entity_id) });
    } else {
      const probe = await workOrderOf(db, g.sample, o.orgId, { lock: false });
      if (probe) ordered.push({ group: g, ticketKey: String(probe.ticket.id) });
    }
  }
  ordered.sort(function (a, b) { return a.ticketKey < b.ticketKey ? -1 : a.ticketKey > b.ticketKey ? 1 : 0; });

  const events = [];
  for (const item of ordered) {
    const wo = await workOrderOf(db, item.group.sample, o.orgId, { lock: !!o.lock });
    if (!wo) continue;
    const verdict = await proofVerdict(db, wo, { orgId: o.orgId, removing: item.group.atts, op: op, nextTags: nextFor });
    if (!verdict.ok) return { refusal: verdict, events: [] };
    Array.prototype.push.apply(events, eventsFor(wo, item.group.atts, op, nextFor, o.actor));
  }
  return { refusal: null, events: events };
}

/**
 * recordPhotoEvents(db, events) -> Promise<number attempted>
 * Best-effort: each insert logs and carries on. Call only after the change
 * has committed.
 */
async function recordPhotoEvents(db, events) {
  let n = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    if (!ev || !ev.ticket) continue;
    try {
      await workOrder.insertEvent(db, ev.ticket, ev.kind, ev.actor, ev.detail);
    } catch (e) {
      console.error('[work-order-photo-guard] event failed', ev.kind, e && e.message);
    }
    n++;
  }
  return n;
}

/**
 * changeWorkOrderPhotos(pool, { orgId, atts, op, actor, apply, nextTags }) ->
 *   { ok:true, result, events } | refusal
 *
 * Connects, BEGINs, locks the work orders and runs the verdict. A refusal
 * rolls back and is returned. Otherwise `await apply(client)` makes the change
 * on the same client; an apply result with ok === false also rolls back and is
 * returned as it is. Then COMMIT, release, and the events on the pool.
 */
async function changeWorkOrderPhotos(pool, opts) {
  const o = opts || {};
  checkChange(o);
  if (typeof o.apply !== 'function') throw new TypeError('changeWorkOrderPhotos needs apply(client)');
  let plan = null;
  let result;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      plan = await planPhotoChange(client, {
        orgId: o.orgId, atts: o.atts, op: o.op, nextTags: o.nextTags, actor: o.actor, lock: true,
      });
      if (plan.refusal) {
        await client.query('ROLLBACK');
        return plan.refusal;
      }
      result = await o.apply(client);
      if (result && result.ok === false) {
        await client.query('ROLLBACK');
        return result;
      }
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* the original error matters */ }
      throw e;
    }
  } finally {
    client.release();
  }
  const events = plan ? plan.events : [];
  await recordPhotoEvents(pool, events);
  return { ok: true, result: result, events: events.length };
}

/**
 * checkWorkOrderPhotos(client, { orgId, atts, op, actor, nextTags, afterCommit, events, eventDb })
 *   -> Promise<null | refusal>
 *
 * For a caller already inside BEGIN..COMMIT (86's payload dispatcher). Locks
 * the work orders on `client`, and answers the refusal, or null when the change
 * may go ahead. On null the photo_removed / photo_retagged events are
 * scheduled, never written inside the transaction:
 *   afterCommit  an array of thunks the caller drains after COMMIT — gets one
 *                that records them on `eventDb` (default: `client`);
 *   events       an array that receives the event specs, for a caller that
 *                records them itself with recordPhotoEvents.
 */
async function checkWorkOrderPhotos(client, opts) {
  const o = opts || {};
  checkChange(o);
  const plan = await planPhotoChange(client, {
    orgId: o.orgId, atts: o.atts, op: o.op, nextTags: o.nextTags, actor: o.actor, lock: true,
  });
  if (plan.refusal) return plan.refusal;
  if (plan.events.length) {
    let scheduled = false;
    if (Array.isArray(o.afterCommit)) {
      const eventDb = o.eventDb || client;
      const events = plan.events;
      o.afterCommit.push(function () { return recordPhotoEvents(eventDb, events); });
      scheduled = true;
    }
    if (Array.isArray(o.events)) {
      Array.prototype.push.apply(o.events, plan.events);
      scheduled = true;
    }
    if (!scheduled) {
      console.warn('[work-order-photo-guard] ' + plan.events.length + ' timeline event(s) not scheduled: pass afterCommit or events');
    }
  }
  return null;
}

module.exports = {
  OPS,
  LOCKED_STATUSES,
  subtaskHead,
  lockedMessage,
  lastPhotoMessage,
  mayBeWorkOrderPhoto,
  retagChangesProof,
  isWorkOrderPhoto,
  workOrderOf,
  proofVerdict,
  planPhotoChange,
  recordPhotoEvents,
  changeWorkOrderPhotos,
  checkWorkOrderPhotos,
};
