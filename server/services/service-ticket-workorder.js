'use strict';

// The WORK-ORDER view of a service ticket (John, 2026-09-13): the ticket is the
// larger task a crew is handed, so it has to say WHERE the work is — job name,
// job number, an address that opens in a maps app, the gate code — WHO to call,
// and every subtask under it carries its own before and completion photos,
// notes, and who finished it.
//
// Shared by the office door (service-ticket-routes.js GET /:id) and the crew's
// share link (service-ticket-share-routes.js), so the two can never disagree
// about what the site is or which photo belongs to which subtask.
//
// NO MONEY, by construction: each statement names the columns it reads, and
// none of them is a price, a cost, a contract or a margin. A work order goes to
// crews and subs.
//
// Tenancy: every read carries `organization_id = $n` taken from the TICKET row
// the caller already proved (office) or the token already resolved (share
// link). A parent in another org, or an un-stamped legacy row, simply yields
// no site — the ticket still opens, just without an address.

const svc = require('./service-tickets');

function nonBlank(v) {
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

function num(v) {
  if (v == null || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function joinAddress(street, city, state, zip) {
  return [street, city, state, zip].map(nonBlank).filter(Boolean).join(', ') || null;
}

/**
 * workOrderSite(db, ticket) -> { kind, job_number, name, address, lat, lng, gate_code }
 *
 * The ticket's OWN address wins when it has one (a ticket can be for one
 * building of a large site); otherwise the parent job's or lead's. Coordinates
 * follow the same rule, so a maps link never pairs one place's address with
 * another's pin. The gate code is the ticket's access notes, else the lead's
 * gate code (a job reaches it through the lead it came from).
 */
async function workOrderSite(db, ticket) {
  const orgId = ticket && ticket.organization_id;
  const site = {
    kind: ticket && ticket.job_id ? 'job' : 'lead',
    job_number: null, name: null, address: null, lat: null, lng: null, gate_code: null,
  };
  if (!ticket || orgId == null) return site;

  let parent = null;
  let leadId = ticket.lead_id || null;
  try {
    if (ticket.job_id) {
      const r = await db.query(
        `SELECT data->>'jobNumber' AS job_number, data->>'title' AS title,
                data->>'address' AS address, data->>'street_address' AS street_address,
                data->>'city' AS city, data->>'state' AS state, data->>'zip' AS zip,
                geocode_lat, geocode_lng, lead_id
           FROM jobs WHERE id = $1 AND organization_id = $2`,
        [ticket.job_id, orgId]
      );
      parent = r.rows[0] || null;
      if (parent && parent.lead_id) leadId = parent.lead_id;
    }
    if (leadId) {
      const r = await db.query(
        `SELECT title, street_address, city, state, zip, geocode_lat, geocode_lng, gate_code
           FROM leads WHERE id = $1 AND organization_id = $2`,
        [leadId, orgId]
      );
      const lead = r.rows[0] || null;
      if (lead) {
        site.gate_code = nonBlank(lead.gate_code);
        if (!parent) parent = lead;
      }
    }
  } catch (_) {
    parent = parent || null;   // an address is a convenience; never fail the ticket over it
  }

  if (parent) {
    site.job_number = ticket.job_id ? nonBlank(parent.job_number) : null;
    site.name = nonBlank(parent.title);
  }
  if (nonBlank(ticket.access_notes)) site.gate_code = nonBlank(ticket.access_notes);

  const ownAddress = nonBlank(ticket.street_address)
    ? joinAddress(ticket.street_address, ticket.city, ticket.state, ticket.zip)
    : null;
  if (ownAddress) {
    site.address = ownAddress;
    site.lat = num(ticket.lat);
    site.lng = num(ticket.lng);
  } else if (parent) {
    site.address = nonBlank(parent.street_address)
      ? joinAddress(parent.street_address, parent.city, parent.state, parent.zip)
      : nonBlank(parent.address);
    site.lat = num(parent.geocode_lat);
    site.lng = num(parent.geocode_lng);
  }
  if (site.lat == null || site.lng == null) { site.lat = null; site.lng = null; }
  return site;
}

/**
 * workOrderContact(db, orgId, userIds) -> { name, phone } | null
 *
 * John: the crew's tap-to-call goes to "the project manager who assigns the
 * task". The first of `userIds` (in order) who is in this org and has a name
 * — the person who sent the link, then whoever raised the ticket.
 */
async function workOrderContact(db, orgId, userIds) {
  const ids = (userIds || []).map(Number).filter((n) => Number.isSafeInteger(n) && n > 0);
  if (!ids.length || orgId == null) return null;
  try {
    const r = await db.query(
      'SELECT id, name, phone_number FROM users WHERE id = ANY($1::int[]) AND organization_id = $2',
      [ids, orgId]
    );
    // The first named user WITH a phone wins: a Call button is the point, so
    // a sharer with no number on their account falls through to the ticket's
    // creator rather than leaving the crew with nobody to call.
    let named = null;
    for (const id of ids) {
      const u = r.rows.find((row) => Number(row.id) === id);
      if (!u || !nonBlank(u.name)) continue;
      const contact = { name: nonBlank(u.name), phone: nonBlank(u.phone_number) };
      if (contact.phone) return contact;
      if (!named) named = contact;
    }
    return named;
  } catch (_) { /* a contact is a convenience */ }
  return null;
}

/**
 * taskPhotosByTask(db, orgId, taskIds) -> Map<taskId, photo[]>
 *
 * Subtask photos are ordinary task attachments (entity_type 'task') — the same
 * rows the task modal shows — so a photo added from the office, the crew link
 * or the task itself is one photo in one place. Images only. `kind` is
 * 'before' for a photo tagged before, otherwise 'completion'.
 */
async function taskPhotosByTask(db, orgId, taskIds) {
  const out = new Map();
  const ids = (taskIds || []).map(String).filter(Boolean);
  if (!ids.length || orgId == null) return out;
  const r = await db.query(
    `SELECT id, entity_id, filename, mime_type, thumb_url, web_url, original_url, uploaded_at, tags
       FROM attachments
      WHERE entity_type = 'task' AND entity_id = ANY($1::text[]) AND organization_id = $2
        AND mime_type LIKE 'image/%'
      ORDER BY position ASC, uploaded_at ASC`,
    [ids, orgId]
  );
  for (const row of r.rows) {
    const key = String(row.entity_id);
    if (!out.has(key)) out.set(key, []);
    out.get(key).push({
      id: row.id,
      kind: svc.photoKindOf(row.tags),
      filename: row.filename,
      mime_type: row.mime_type,
      thumb_url: row.thumb_url,
      web_url: row.web_url,
      original_url: row.original_url,
      uploaded_at: row.uploaded_at,
    });
  }
  return out;
}

/**
 * ticketSitePhotos(db, orgId, ticketId, { withNames }) -> photo[]
 *
 * The work order's SITE photos: images on the ticket itself (entity_type
 * 'service_ticket'), newest first, at most 60. Photos tagged 'flag' belong to
 * a flagged problem and are left out IN THE WHERE, before the LIMIT, so a
 * ticket carrying a wall of flag photos still shows its site photos; the JS
 * filter below stays as the case-insensitive backstop. `by` names who added
 * each one — the crew link's label (or 'Crew link') for a photo with no
 * uploader, otherwise the uploader's name when withNames is set (the office
 * read) or 'Office' (the crew read, which never shows office names). via_link
 * says it came from a link.
 */
const SITE_PHOTO_LIMIT = 60;

function tagList(tags) {
  let list = tags;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = [list]; }
  }
  return Array.isArray(list) ? list.map(function (t) { return String(t).toLowerCase(); }) : [];
}

async function ticketSitePhotos(db, orgId, ticketId, opts) {
  if (orgId == null || ticketId == null || String(ticketId) === '') return [];
  const withNames = !!(opts && opts.withNames);
  // The flag exclusion is a WHERE PREDICATE, not a post-filter. The LIMIT runs
  // in the database, so filtering afterwards let flag photos eat the window:
  // FLAG_OPEN_CAP (20) open flags x FLAG_PHOTO_CAP (6) photos = 120 rows on the
  // SAME parent (service-ticket-flag-routes.js inserts them as entity_type
  // 'service_ticket', entity_id = ticket.id, tags ['flag']), and resolved flags
  // keep theirs forever — so a busy ticket returned an EMPTY Site photos card
  // while every field-report photo was still in the table.
  //
  // `$3 = ANY (SELECT jsonb_array_elements_text(tags))` is the containment
  // idiom this codebase already uses (admin-agents-routes.js:2785). The JS
  // filter below STAYS and is not redundant: it lowercases, while
  // normalizeTagsInput preserves the case a retag typed, so a hand-typed 'Flag'
  // is caught there and only there.
  const r = await db.query(
    `SELECT a.id, a.filename, a.mime_type, a.thumb_url, a.web_url, a.original_url, a.uploaded_at, a.uploaded_by, a.tags` +
      (withNames ? ', u.name AS uploader_name' : '') + `
       FROM attachments a` +
      (withNames ? `
       LEFT JOIN users u ON u.id = a.uploaded_by AND u.organization_id = a.organization_id` : '') + `
      WHERE a.entity_type = 'service_ticket' AND a.entity_id = $1 AND a.organization_id = $2
        AND a.mime_type LIKE 'image/%'
        AND NOT ($3 = ANY (SELECT jsonb_array_elements_text(tags)))
      ORDER BY a.uploaded_at DESC LIMIT 120`,
    [String(ticketId), orgId, 'flag']
  );
  const rows = r.rows
    .filter(function (row) { return tagList(row.tags).indexOf('flag') < 0; })
    .slice(0, SITE_PHOTO_LIMIT);
  if (!rows.length) return [];

  const labels = new Map();
  if (rows.some(function (row) { return row.uploaded_by == null; })) {
    const ev = await db.query(
      `SELECT actor_label, detail FROM service_ticket_events
        WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'photo_added' AND actor_kind = 'share'
        ORDER BY created_at DESC LIMIT 500`,
      [String(ticketId), orgId]
    );
    for (const e of ev.rows) {
      let d = e.detail;
      if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
      const key = d && d.attachment_id != null ? String(d.attachment_id) : null;
      if (!key || labels.has(key)) continue;
      const label = e.actor_label != null ? String(e.actor_label).trim() : '';
      labels.set(key, label);
    }
  }

  return rows.map(function (row) {
    const viaLink = row.uploaded_by == null;
    const by = viaLink
      ? (labels.get(String(row.id)) || 'Crew link')
      : ((withNames && row.uploader_name && String(row.uploader_name).trim()) || 'Office');
    return {
      id: row.id,
      filename: row.filename,
      mime_type: row.mime_type,
      thumb_url: row.thumb_url,
      web_url: row.web_url,
      original_url: row.original_url,
      uploaded_at: row.uploaded_at,
      by: by,
      via_link: viaLink,
    };
  });
}

/**
 * subtaskActivity(db, orgId, ticketId, opts) -> Map<taskId, { notes[], completed_by, completed_at }>
 *
 * Per-subtask notes and "who finished it" live in the ticket's event log —
 * append-only and attributed — rather than in tasks.notes, which the office
 * overwrites (a crew note and an office edit would race; see task-share).
 *
 * opts.withIds (the office read only) adds each note's event `id`, so a note
 * can be addressed later. Without it the output is exactly what the crew link
 * has always received.
 */
async function subtaskActivity(db, orgId, ticketId, opts) {
  const out = new Map();
  if (orgId == null || !ticketId) return out;
  const withIds = !!(opts && opts.withIds);
  const r = await db.query(
    `SELECT id, kind, actor_kind, actor_label, detail, created_at
       FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2
        AND kind IN ('subtask_note', 'subtask_completed', 'subtask_reopened')
      ORDER BY created_at ASC`,
    [ticketId, orgId]
  );
  for (const e of r.rows) {
    let d = e.detail;
    if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = {}; } }
    const taskId = d && d.task_id != null ? String(d.task_id) : null;
    if (!taskId) continue;
    if (!out.has(taskId)) out.set(taskId, { notes: [], completed_by: null, completed_at: null });
    const slot = out.get(taskId);
    const who = e.actor_label || (e.actor_kind === 'share' ? 'Shared link' : 'Office');
    if (e.kind === 'subtask_note' && d.note) {
      const item = { note: String(d.note), by: who, at: e.created_at };
      if (withIds) item.id = e.id;
      slot.notes.push(item);
    } else if (e.kind === 'subtask_completed') {
      slot.completed_by = who;
      slot.completed_at = e.created_at;
    } else if (e.kind === 'subtask_reopened') {
      slot.completed_by = null;
      slot.completed_at = null;
    }
  }
  return out;
}

// A subtask of THIS ticket, in this org, live, and an org task (a private to-do
// hanging off a ticket is its owner's and never a work-order subtask).
async function loadSubtask(db, ticket, taskId) {
  if (!ticket || taskId == null || String(taskId) === '') return null;
  const r = await db.query(
    `SELECT id, title, status, completed_at, kind FROM tasks
      WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3
        AND archived_at IS NULL AND scope = 'org'`,
    [String(taskId), ticket.id, ticket.organization_id]
  );
  return r.rows[0] || null;
}

// opts.strict RETHROWS after logging. Inside BEGIN..COMMIT every event insert
// must be strict: on Postgres a failed INSERT aborts the transaction, and a
// swallowed failure turns the later COMMIT into a silent ROLLBACK of the whole
// change. Outside a transaction the default (log and carry on) stays right: an
// event is the record of a write that has already happened.
async function insertEvent(db, ticket, kind, actor, detail, opts) {
  try {
    await db.query(
      `INSERT INTO service_ticket_events
         (id, organization_id, ticket_id, kind, actor_kind, actor_user_id, share_id, actor_label, detail)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [svc.genId('ste'), ticket.organization_id, ticket.id, kind,
       (actor && actor.kind) || 'user', (actor && actor.userId) || null, (actor && actor.shareId) || null,
       (actor && actor.label) || null, JSON.stringify(detail || {})]
    );
  } catch (e) {
    console.error('[service-ticket-workorder] event log failed', kind, e.message);
    if (opts && opts.strict) throw e;
  }
}

/**
 * subtaskCounts(db, ticket) -> { total, done }
 * Over the same live org subtasks the crew sees and setSubtaskDone counts.
 */
async function subtaskCounts(db, ticket) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return { total: 0, done: 0 };
  const r = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done
       FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,
    [ticket.id, ticket.organization_id]
  );
  const c = r.rows[0] || {};
  return { total: Number(c.total) || 0, done: Number(c.done) || 0 };
}

/**
 * lastStatusEvent(db, ticket) -> { actor_kind, share_id, detail, created_at } | null
 * The newest status_changed row for the ticket (detail parsed when a driver
 * hands it back as text).
 */
async function lastStatusEvent(db, ticket) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return null;
  const r = await db.query(
    `SELECT actor_kind, share_id, detail, created_at FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2 AND kind = 'status_changed'
      ORDER BY created_at DESC, id DESC LIMIT 1`,
    [ticket.id, ticket.organization_id]
  );
  const row = r.rows[0];
  if (!row) return null;
  let d = row.detail;
  if (typeof d === 'string') { try { d = JSON.parse(d); } catch (_) { d = null; } }
  return { actor_kind: row.actor_kind, share_id: row.share_id, detail: d || {}, created_at: row.created_at };
}

/**
 * withTicketLock(db, ticket, work) -> whatever work returns
 *
 * Runs `work(client, lockedRow)` with the ticket row locked FOR UPDATE, so
 * every door that changes a punch list — the office checkbox, the crew link,
 * My Tasks, a task link, 86 — decides on the row as it is NOW, not on the copy
 * a request loaded a moment earlier.
 *   * db with .release is a client already inside the caller's transaction:
 *     no BEGIN or COMMIT here, the caller owns both.
 *   * db with .connect is a pool: connect, BEGIN, work, then COMMIT — or
 *     ROLLBACK when the work answers ok === false or throws — and release.
 *   * db with neither (a query-only test fake) runs the work directly.
 * The lock read carries the org, so a ticket id from another tenant is simply
 * not there.
 */
const TICKET_GONE = 'This work order is no longer available.';

async function withTicketLock(db, ticket, work) {
  const run = async function (client) {
    if (!ticket || ticket.id == null || ticket.organization_id == null) {
      return { ok: false, status: 404, error: TICKET_GONE };
    }
    const r = await client.query(
      'SELECT * FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE',
      [ticket.id, ticket.organization_id]
    );
    const locked = r.rows[0];
    if (!locked) return { ok: false, status: 404, error: TICKET_GONE };
    return work(client, locked);
  };

  if (db && typeof db.release === 'function') return run(db);
  if (!db || typeof db.connect !== 'function') return run(db);

  const client = await db.connect();
  try {
    await client.query('BEGIN');
    let result;
    try {
      result = await run(client);
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* the throw below is the news */ }
      throw e;
    }
    if (result && result.ok === false) await client.query('ROLLBACK');
    else await client.query('COMMIT');
    return result;
  } finally {
    client.release();
  }
}

// Does the missing-time rule hold this ticket back from Work complete? The
// callers lock the row with different column lists, so bill_as is read when
// the row in hand does not carry it — a row that merely omitted the column
// must not read as a ticket that bills nothing.
async function timeHoldsArrival(db, ticket) {
  let billAs = ticket.bill_as;
  if (billAs === undefined) {
    const r = await db.query(
      'SELECT bill_as FROM service_tickets WHERE id = $1 AND organization_id = $2',
      [ticket.id, ticket.organization_id]
    );
    billAs = r.rows[0] ? r.rows[0].bill_as : null;
  }
  const fieldCapture = require('./service-ticket-field-capture');
  if (!fieldCapture.fieldCaptureOn({ bill_as: billAs })) return false;
  return !(await fieldCapture.hasUsableTime(db, ticket));
}

/**
 * recountTicket(db, ticket, actor, hint) -> { ticketStatus, movedTo }
 *
 * The ticket follows its subtasks (autoStatusForSubtasks): all live org
 * subtasks done moves it to work_complete, anything open again on a ticket
 * awaiting approval moves it back to in_progress. `ticket` must be the row the
 * caller holds locked. The UPDATE is guarded on that status, and the event is
 * strict because callers run inside a transaction.
 *
 * hint names why a ticket went BACK (subtask_added, subtask_removed); an
 * arrival is always all_subtasks_done. movedTo is set only when THIS call's
 * guarded UPDATE moved the ticket — the signal the doors use to announce an
 * arrival at work_complete exactly once.
 */
async function recountTicket(db, ticket, actor, hint) {
  let ticketStatus = ticket.status;
  let movedTo = null;
  const c = await subtaskCounts(db, ticket);
  const allDone = c.total > 0 && c.done === c.total;
  let next = svc.autoStatusForSubtasks(ticket.status, allDone);
  // Phase 3: the last building ticked is not Work complete on a work order
  // billed after the work while nobody has sent any time — the same rule the
  // crew's Finish and the office's status door apply, or it would be a rule
  // with a side door. The ticket stays where it is and the crew's Finish, once
  // there is time, takes it the rest of the way.
  if (next === 'work_complete' && (await timeHoldsArrival(db, ticket))) next = null;
  if (next && next !== ticket.status) {
    const r = await db.query(
      `UPDATE service_tickets
          SET status = $1,
              completed_at = ${next === 'work_complete' ? 'COALESCE(completed_at, NOW())' : 'NULL'},
              updated_at = NOW()
        WHERE id = $2 AND organization_id = $3 AND status = $4
        RETURNING status`,
      [next, ticket.id, ticket.organization_id, ticket.status]
    );
    if (r.rows[0]) {
      ticketStatus = r.rows[0].status;
      movedTo = next;
      await insertEvent(db, ticket, 'status_changed', actor,
        { from: ticket.status, to: next, reason: allDone ? 'all_subtasks_done' : (hint || 'subtask_reopened') },
        { strict: true });
      // The OFFICE sending a ticket back (a new building, an untick) makes the
      // next arrival at Work complete news, even inside the approval notice's
      // 15-minute window.
      //
      // 'agent' counts as the office: 86 adding a building runs THIS recount
      // (payload-dispatcher.js hands it { kind: 'agent', userId }), and it is
      // the office asking. Left out, the stale approval_notified_at stood, the
      // notice claim (service-ticket-notify.js) answered 'already_notified',
      // the cron's retry only looks at approval_notified_at IS NULL, and the
      // crew-activity fallback suppresses a work_complete ticket's rows — so
      // the second arrival reached nobody, ever. An explicit allow-list rather
      // than `!== 'share'`: 'system' (the notice cron) must NOT clear it.
      if (actor && (actor.kind === 'user' || actor.kind === 'agent') && movedTo === 'in_progress') {
        await db.query(
          `UPDATE service_tickets SET approval_notified_at = NULL
            WHERE id = $1 AND organization_id = $2 AND approval_notified_at IS NOT NULL`,
          [ticket.id, ticket.organization_id]
        );
      }
    }
  }
  return { ticketStatus: ticketStatus, movedTo: movedTo };
}

/**
 * setSubtaskDone(db, { ticket, taskId, done, actor, gate? }) ->
 *   { ok: true, task, ticketStatus, movedTo, ticket }
 *   | { ok: false, status, error, code? }
 *
 * THE one door for completing or reopening a subtask — the office's checkbox,
 * the crew link, My Tasks and a task link all come through here, so the rules
 * cannot differ:
 *   * it decides on the LOCKED ticket row (withTicketLock), never on the copy
 *     the caller loaded;
 *   * opts.gate(lockedRow), when given, runs first and may refuse with
 *     { ok:false, status, error, code } (work_order_locked);
 *   * completing needs at least one COMPLETION photo on that subtask
 *     (code completion_photo_required);
 *   * the task UPDATE is guarded, so a double tap writes one event;
 *   * every change is an attributed, strict event (who finished Bldg 784);
 *   * the ticket follows its subtasks (recountTicket).
 * result.ticket is the locked row with its status after the recount — the row
 * a notice should describe.
 */
async function setSubtaskDone(db, opts) {
  return withTicketLock(db, opts.ticket, function (client, locked) {
    return applySubtaskDone(client, locked, opts);
  });
}

async function applySubtaskDone(db, ticket, opts) {
  if (typeof opts.gate === 'function') {
    const g = await opts.gate(ticket);
    if (g && g.ok === false) {
      return { ok: false, status: g.status || 409, error: g.error, code: g.code };
    }
  }
  const done = !!opts.done;
  const task = await loadSubtask(db, ticket, opts.taskId);
  if (!task) return { ok: false, status: 404, error: 'That subtask is not on this work order.' };

  if (done) {
    const photos = (await taskPhotosByTask(db, ticket.organization_id, [task.id])).get(String(task.id)) || [];
    // A reply-only line (kind follow_up) is completed without a photo; every
    // other building still needs one. The kind is read from the LOCKED row.
    const verdict = svc.subtaskMayComplete(photos, task);
    if (!verdict.ok) return { ok: false, status: 409, error: verdict.reason, code: 'completion_photo_required' };
  }

  const wasDone = task.status === 'done';
  let updated = task;
  if (wasDone !== done) {
    const r = await db.query(
      `UPDATE tasks
          SET status = $1,
              completed_at = ${done ? 'COALESCE(completed_at, NOW())' : 'NULL'},
              updated_at = NOW()
        WHERE id = $2 AND service_ticket_id = $3 AND organization_id = $4
          AND ${done ? "status <> 'done'" : "status = 'done'"}
        RETURNING id, title, status, completed_at`,
      [done ? 'done' : 'open', task.id, ticket.id, ticket.organization_id]
    );
    if (r.rows[0]) {
      updated = r.rows[0];
      await insertEvent(db, ticket, done ? 'subtask_completed' : 'subtask_reopened', opts.actor,
        { task_id: task.id, title: String(task.title || '').slice(0, 200) }, { strict: true });
    }
  }

  // Does the ticket move? Counted over the same live org subtasks the crew sees.
  const moved = await recountTicket(db, ticket, opts.actor, null);

  // The OFFICE unticking a building is a send-back for rework, so the next
  // arrival at Work complete is news even inside the approval notice's
  // 15-minute window (services/service-ticket-notify.js) — whether or not this
  // untick moved the ticket (it may already be In progress from a crew undo).
  // The crew undoing its own tick keeps the window: that undo-and-redo is what
  // the window is for. 'agent' is the office too, for the same reason and in
  // the same shape as recountTicket above — no caller hands an agent actor here
  // today, and the two doors must not drift apart when one does.
  if (!done && wasDone && opts.actor && (opts.actor.kind === 'user' || opts.actor.kind === 'agent')) {
    await db.query(
      `UPDATE service_tickets SET approval_notified_at = NULL
        WHERE id = $1 AND organization_id = $2 AND approval_notified_at IS NOT NULL`,
      [ticket.id, ticket.organization_id]
    );
  }

  return {
    ok: true,
    task: updated,
    ticketStatus: moved.ticketStatus,
    movedTo: moved.movedTo,
    ticket: Object.assign({}, ticket, { status: moved.ticketStatus }),
  };
}

// The shape of the retry key the crew page mints — one opaque token per UNSENT
// note, sent again by every retry of that same note. Spelled here rather than
// imported from service-ticket-flags.js, which owns the other copy: that module
// requires THIS one, so reaching back for the constant would be a require cycle
// (and a lazy require would not resolve from the temp copies the mutation
// suites load). Shape only — never contents, never an id of ours.
const CLIENT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;

/**
 * addSubtaskNote(db, { ticket, taskId, note, actor, clientRef }) ->
 *   { ok, duplicate? } | { ok:false, status, error }
 * An attributed, append-only note on one subtask.
 *
 * IDEMPOTENT (1.30), the key the site-photo, building-photo and flag doors
 * already carry. A crew phone on a dead spot sends the note, loses the answer
 * and sends it again; without a key the building's field log grows the same
 * sentence twice and the crew cannot delete either one. So the caller may pass
 * the page's `client_ref`: if this work order already carries a subtask_note
 * written under that key by the same link, nothing is written and the answer is
 * the one a first save gets — a retry lands, it is not refused.
 *
 * The lookup and the insert run under ONE withTicketLock, so two retries
 * arriving together are serialized on the ticket row and no second unique index
 * is needed. A body with no key always writes, exactly as the flag door treats a
 * missing key — an old cached page must not start silently dropping notes.
 */
async function addSubtaskNote(db, opts) {
  const text = String(opts.note == null ? '' : opts.note).trim().slice(0, 2000);
  if (!text) return { ok: false, status: 400, error: 'Write a note first.' };
  const ref = typeof opts.clientRef === 'string' && CLIENT_REF_RE.test(opts.clientRef)
    ? opts.clientRef : null;
  const shareId = (opts.actor && opts.actor.shareId) || null;

  return withTicketLock(db, opts.ticket, async function (client) {
    const task = await loadSubtask(client, opts.ticket, opts.taskId);
    if (!task) return { ok: false, status: 404, error: 'That subtask is not on this work order.' };

    if (ref) {
      // Scoped to this ticket, this org and this link: `IS NOT DISTINCT FROM`
      // rather than `=` so the office door (share_id NULL) is deduped by the
      // same statement instead of never matching.
      const seen = await client.query(
        `SELECT 1 FROM service_ticket_events
          WHERE ticket_id = $1 AND organization_id = $2
            AND share_id IS NOT DISTINCT FROM $3
            AND kind = 'subtask_note' AND detail->>'client_ref' = $4
          LIMIT 1`,
        [opts.ticket.id, opts.ticket.organization_id, shareId, ref]
      );
      if (seen.rows.length) return { ok: true, duplicate: true };
    }

    const detail = { task_id: task.id, note: text };
    if (ref) detail.client_ref = ref;
    // Strict: inside the lock's transaction a swallowed failure would turn
    // COMMIT into a silent ROLLBACK and answer ok with nothing written.
    await insertEvent(client, opts.ticket, 'subtask_note', opts.actor, detail, { strict: true });
    return { ok: true };
  });
}

module.exports = {
  workOrderSite, workOrderContact, taskPhotosByTask, subtaskActivity,
  loadSubtask, setSubtaskDone, addSubtaskNote, joinAddress,
  insertEvent, subtaskCounts, lastStatusEvent, ticketSitePhotos,
  withTicketLock, recountTicket,
};
