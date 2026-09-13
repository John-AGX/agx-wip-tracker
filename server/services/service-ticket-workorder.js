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
 * subtaskActivity(db, orgId, ticketId) -> Map<taskId, { notes[], completed_by, completed_at }>
 *
 * Per-subtask notes and "who finished it" live in the ticket's event log —
 * append-only and attributed — rather than in tasks.notes, which the office
 * overwrites (a crew note and an office edit would race; see task-share).
 */
async function subtaskActivity(db, orgId, ticketId) {
  const out = new Map();
  if (orgId == null || !ticketId) return out;
  const r = await db.query(
    `SELECT kind, actor_kind, actor_label, detail, created_at
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
      slot.notes.push({ note: String(d.note), by: who, at: e.created_at });
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
    `SELECT id, title, status, completed_at FROM tasks
      WHERE id = $1 AND service_ticket_id = $2 AND organization_id = $3
        AND archived_at IS NULL AND scope = 'org'`,
    [String(taskId), ticket.id, ticket.organization_id]
  );
  return r.rows[0] || null;
}

async function insertEvent(db, ticket, kind, actor, detail) {
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
  }
}

/**
 * setSubtaskDone(db, { ticket, taskId, done, actor }) ->
 *   { ok: true, task, ticketStatus } | { ok: false, status, error }
 *
 * THE one door for completing or reopening a subtask — the office's checkbox
 * and the crew link both come through here, so the rules cannot differ:
 *   * completing needs at least one COMPLETION photo on that subtask;
 *   * every change is an attributed event (who finished Bldg 784, and when);
 *   * the ticket follows its subtasks (autoStatusForSubtasks): the last one
 *     done moves it to work_complete, undoing one moves it back to in_progress.
 * The caller has already decided WHETHER this actor may write (ticket access
 * for the office; scope + crewSubtasksWritable for a link).
 */
async function setSubtaskDone(db, opts) {
  const ticket = opts.ticket;
  const done = !!opts.done;
  const task = await loadSubtask(db, ticket, opts.taskId);
  if (!task) return { ok: false, status: 404, error: 'That subtask is not on this work order.' };

  if (done) {
    const photos = (await taskPhotosByTask(db, ticket.organization_id, [task.id])).get(String(task.id)) || [];
    const verdict = svc.subtaskMayComplete(photos);
    if (!verdict.ok) return { ok: false, status: 409, error: verdict.reason };
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
        RETURNING id, title, status, completed_at`,
      [done ? 'done' : 'open', task.id, ticket.id, ticket.organization_id]
    );
    updated = r.rows[0] || task;
    await insertEvent(db, ticket, done ? 'subtask_completed' : 'subtask_reopened', opts.actor,
      { task_id: task.id, title: String(task.title || '').slice(0, 200) });
  }

  // Does the ticket move? Counted over the same live org subtasks the crew sees.
  let ticketStatus = ticket.status;
  // Set only when THIS call's guarded UPDATE moved the ticket — the signal the
  // routes use to announce an arrival at work_complete exactly once.
  let movedTo = null;
  const counts = await db.query(
    `SELECT COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE status = 'done')::int AS done
       FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'`,
    [ticket.id, ticket.organization_id]
  );
  const c = counts.rows[0] || { total: 0, done: 0 };
  const allDone = Number(c.total) > 0 && Number(c.done) === Number(c.total);
  const next = svc.autoStatusForSubtasks(ticket.status, allDone);
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
      await insertEvent(db, ticket, 'status_changed', opts.actor,
        { from: ticket.status, to: next, reason: allDone ? 'all_subtasks_done' : 'subtask_reopened' });
    }
  }

  // The OFFICE unticking a building is a send-back for rework, so the next
  // arrival at Work complete is news even inside the approval notice's
  // 15-minute window (services/service-ticket-notify.js) — whether or not this
  // untick moved the ticket (it may already be In progress from a crew undo).
  // The crew undoing its own tick keeps the window: that undo-and-redo is what
  // the window is for.
  if (!done && wasDone && opts.actor && opts.actor.kind === 'user') {
    await db.query(
      `UPDATE service_tickets SET approval_notified_at = NULL
        WHERE id = $1 AND organization_id = $2 AND approval_notified_at IS NOT NULL`,
      [ticket.id, ticket.organization_id]
    );
  }

  return { ok: true, task: updated, ticketStatus: ticketStatus, movedTo: movedTo };
}

/**
 * addSubtaskNote(db, { ticket, taskId, note, actor }) -> { ok } | { ok:false, status, error }
 * An attributed, append-only note on one subtask.
 */
async function addSubtaskNote(db, opts) {
  const text = String(opts.note == null ? '' : opts.note).trim().slice(0, 2000);
  if (!text) return { ok: false, status: 400, error: 'Write a note first.' };
  const task = await loadSubtask(db, opts.ticket, opts.taskId);
  if (!task) return { ok: false, status: 404, error: 'That subtask is not on this work order.' };
  await insertEvent(db, opts.ticket, 'subtask_note', opts.actor, { task_id: task.id, note: text });
  return { ok: true };
}

module.exports = {
  workOrderSite, workOrderContact, taskPhotosByTask, subtaskActivity,
  loadSubtask, setSubtaskDone, addSubtaskNote, joinAddress,
};
