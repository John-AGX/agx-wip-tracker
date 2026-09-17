'use strict';

// PROBLEMS A CREW FLAGGED ON A WORK ORDER (1.29, "Flag a problem").
//
// A crew link holder can say "I can't get in", "there is more damage than the
// scope", "I'm short on material", "this is unsafe" or "something else" about
// the whole work order or about one building on it. Each report is a row in
// service_ticket_flags: a quarantine-style record like service_ticket_revisions,
// with an open/resolved state, a resolver and a resolution note. A flag never
// changes the ticket's status or scope and never blocks finishing a building.
// The office resolves it with a note, and the crew link shows that note.
//
// WHY A TABLE AND NOT AN EVENT. service_ticket_events is append-only; a flag
// needs to be resolved, by someone, with a note, and to carry photo links. The
// timeline still gets flag_raised / flag_resolved, but their detail is SHAPE
// only ({flag_id, category, task_id}) — the crew's words live in the flag row,
// never in the event log.
//
// PHOTOS ARE TICKET ATTACHMENTS TAGGED "flag", NEVER TASK ATTACHMENTS. Every
// task photo not tagged 'before' counts as completion proof (photoKindOf), so a
// damage photo hung on the building would quietly satisfy "add a completion
// photo". The flag row lists the ids; Site photos and the crew-activity batch
// leave flag-tagged photos out.
//
// TENANCY. The table is DIRECT (its own NOT NULL organization_id). Every
// statement here carries `organization_id = $n` taken from the TICKET row the
// caller already proved (office) or the token already resolved (crew link),
// never from a request. Every join is pinned to the flag row's own org.
//
// TIMESTAMPS are compared in the database (NOW() - INTERVAL), never against the
// app server's clock, except new_from_crew, which compares two values read from
// the same row.
//
// NO MONEY: nothing here reads a price, cost, total or contract field, and the
// crew-facing projection (publicFlag) is a whitelist.

const svc = require('./service-tickets');
const workOrder = require('./service-ticket-workorder');
const access = require('./service-ticket-access');

const FLAG_CATEGORIES = Object.freeze(['no_access', 'extra_damage', 'material_short', 'safety', 'other']);
const FLAG_STATUSES = Object.freeze(['open', 'resolved']);

const FLAG_NOTE_MAX = 2000;
const FLAG_RESOLUTION_MAX = 1000;
const FLAG_OPEN_CAP = 20;
const FLAG_PHOTO_CAP = 6;
const FLAG_PHOTO_WINDOW_MS = 2 * 60 * 60 * 1000;
const FLAG_CREW_LIST_LIMIT = 50;
const FLAG_OFFICE_LIST_LIMIT = 100;

const CLIENT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const FLAG_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const CLIENT_REF_INDEX = 'uq_service_ticket_flags_client_ref';

// The body keys the crew door reads. DOCUMENTATION: the handler names each of
// these and never loops over the body, so status, organization_id, share_id,
// attachment_ids and resolution_note cannot be set by a stranger.
const CREW_FLAG_FIELDS = Object.freeze(['category', 'note', 'task_id', 'client_ref', 'photos_expected', 'name']);

const MSG = Object.freeze({
  pickCategory: 'Pick what kind of problem it is.',
  noteRequired: 'Write what the problem is — the office needs a note.',
  buildingNotFound: 'That building is not on this work order.',
  openCap: 'This work order already has 20 problems waiting on the office. Call the office instead.',
  sendFailed: 'Something went wrong sending that. Try again, or call the office.',
  photoFlagNotFound: 'That problem report is not on this work order.',
  photoResolved: 'The office already resolved that problem.',
  photoWindow: 'Photos can only be added to a problem in the first 2 hours. Flag it again with the new photos.',
  photoCap: 'That problem already has 6 photos.',
  photoFailed: 'Something went wrong uploading that.',
  resolveNoteRequired: 'Say how it was handled — the crew sees this note.',
  resolveNotFound: 'That problem is not on this ticket, or it was already resolved.',
  resolveFailed: 'Failed to resolve the problem',
});

// ── small helpers ─────────────────────────────────────────────────────────

// Postgres answers a boolean expression with true/false; the test engine with
// 1/0. Anything else (null included) is false.
function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

// An instant as milliseconds. A zone-less 'YYYY-MM-DD HH:MM:SS' is the
// database's UTC text form, so it is read as UTC rather than local time.
function toTime(v) {
  if (v == null || v === '') return NaN;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'number') return v;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(s)) {
    return Date.parse(s.replace(' ', 'T') + 'Z');
  }
  return Date.parse(s);
}

// attachment_ids arrives parsed (jsonb) or as text (a driver that does not
// decode it). null and anything malformed read as no photos.
function idList(v) {
  let list = v;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = []; }
  }
  if (!Array.isArray(list)) return [];
  const out = [];
  list.forEach(function (id) {
    if (id == null || id === '') return;
    const s = String(id);
    if (out.indexOf(s) < 0) out.push(s);
  });
  return out;
}

function idSet(ids) {
  if (ids instanceof Set) return new Set(Array.from(ids).map(String));
  return new Set((Array.isArray(ids) ? ids : []).filter(function (x) { return x != null; }).map(String));
}

function countOf(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

function clampPhotos(v) {
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(FLAG_PHOTO_CAP, n);
}

// ── pure rules ────────────────────────────────────────────────────────────

// Trimmed, lowercased EXACT match, else null. It never defaults to 'other': a
// category the crew did not pick is a refusal, not a guess.
function normalizeFlagCategory(v) {
  if (typeof v !== 'string') return null;
  const k = v.trim().toLowerCase();
  return FLAG_CATEGORIES.indexOf(k) >= 0 ? k : null;
}

/**
 * validateCrewFlag(body) ->
 *   {ok:true, category, note, taskId, clientRef, photosExpected}
 * | {ok:false, status:400, error}
 * Reads only CREW_FLAG_FIELDS (name is applied separately by applyCrewName).
 */
function validateCrewFlag(body) {
  const b = body && typeof body === 'object' ? body : {};
  const category = normalizeFlagCategory(b.category);
  if (!category) return { ok: false, status: 400, error: MSG.pickCategory };
  const note = typeof b.note === 'string' ? b.note.trim().slice(0, FLAG_NOTE_MAX) : '';
  if (!note) return { ok: false, status: 400, error: MSG.noteRequired };
  let taskId = null;
  if (typeof b.task_id === 'string' || typeof b.task_id === 'number') {
    taskId = String(b.task_id).trim() || null;
  } else if (b.task_id != null) {
    // Not an id at all: proved like any other id, and answered the same 404.
    taskId = String(b.task_id);
  }
  const clientRef = typeof b.client_ref === 'string' && CLIENT_REF_RE.test(b.client_ref) ? b.client_ref : null;
  return {
    ok: true,
    category: category,
    note: note,
    taskId: taskId,
    clientRef: clientRef,
    photosExpected: clampPhotos(b.photos_expected),
  };
}

/**
 * flagMayTakePhoto(row, now?) -> {ok:true} | {ok:false, status, error}
 * The flag must exist, be open, be inside the photo window and have room.
 * row.in_window (computed by the database) wins over row.created_at.
 */
function flagMayTakePhoto(row, now) {
  if (!row) return { ok: false, status: 404, error: MSG.photoFlagNotFound };
  if (row.status !== 'open') return { ok: false, status: 409, error: MSG.photoResolved };
  let fresh;
  if (row.in_window !== undefined) {
    fresh = truthy(row.in_window);
  } else {
    const at = toTime(now == null ? Date.now() : now);
    const created = toTime(row.created_at);
    fresh = Number.isFinite(created) && Number.isFinite(at) && at - created <= FLAG_PHOTO_WINDOW_MS;
  }
  if (!fresh) return { ok: false, status: 409, error: MSG.photoWindow };
  if (idList(row.attachment_ids).length >= FLAG_PHOTO_CAP) return { ok: false, status: 409, error: MSG.photoCap };
  return { ok: true };
}

// The office's note on how a problem was handled. Shown on the crew link.
function cleanResolution(note) {
  return typeof note === 'string' ? note.trim().slice(0, FLAG_RESOLUTION_MAX) : '';
}

// "New from crew": the newest crew event (share_opened excluded) is later than
// the last time someone who can edit the ticket opened it.
function isNewFromCrew(lastCrewAt, seenAt) {
  const last = toTime(lastCrewAt);
  if (!Number.isFinite(last)) return false;
  const seen = toTime(seenAt);
  if (!Number.isFinite(seen)) return true;
  return last > seen;
}

// A list row carrying ATTENTION_COLUMNS, with the counts as numbers and
// new_from_crew added.
function withAttention(row) {
  const r = Object.assign({}, row || {});
  if ('open_flags' in r) r.open_flags = countOf(r.open_flags);
  if ('pending_suggestions' in r) r.pending_suggestions = countOf(r.pending_suggestions);
  r.new_from_crew = isNewFromCrew(r.last_crew_at, r.office_seen_at);
  return r;
}

/**
 * publicFlag(row, photos, liveTaskIds) — what a crew link may see. A whitelist:
 * never share_id, resolved_by, attachment_ids, client_ref or organization_id.
 * task_id is nulled unless it is a live org task of this ticket.
 */
function publicFlag(row, photos, liveTaskIds) {
  const r = row || {};
  const live = idSet(liveTaskIds);
  const taskId = r.task_id != null && live.has(String(r.task_id)) ? String(r.task_id) : null;
  return {
    id: r.id,
    task_id: taskId,
    category: r.category,
    note: r.note,
    author_label: r.author_label == null ? null : r.author_label,
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at == null ? null : r.resolved_at,
    resolution_note: r.resolution_note == null ? null : r.resolution_note,
    photos: (Array.isArray(photos) ? photos : []).map(function (p) {
      return { id: p.id, thumb_url: p.thumb_url, web_url: p.web_url };
    }),
  };
}

/**
 * officeFlag(row, photos) — what the office sees (listOfficeFlags rows).
 * task_id is nulled when the join found no org task on this ticket.
 */
function officeFlag(row, photos) {
  const r = row || {};
  const onTicket = r.task_live_id != null;
  return {
    id: r.id,
    task_id: onTicket ? String(r.task_id) : null,
    task_title: onTicket && r.task_title != null ? r.task_title : null,
    category: r.category,
    note: r.note,
    author_label: r.author_label == null ? null : r.author_label,
    via_revoked_link: truthy(r.via_revoked_link),
    status: r.status,
    created_at: r.created_at,
    resolved_at: r.resolved_at == null ? null : r.resolved_at,
    resolved_by_name: r.resolved_by_name == null ? null : r.resolved_by_name,
    resolution_note: r.resolution_note == null ? null : r.resolution_note,
    photos: (Array.isArray(photos) ? photos : []).map(function (p) {
      return {
        id: p.id,
        filename: p.filename,
        mime_type: p.mime_type,
        thumb_url: p.thumb_url,
        web_url: p.web_url,
        original_url: p.original_url,
        uploaded_at: p.uploaded_at,
      };
    }),
  };
}

// ── reads ─────────────────────────────────────────────────────────────────

const CREW_COLS =
  'id, task_id, category, note, author_label, status, attachment_ids, created_at, resolved_at, resolution_note';

/**
 * flagPhotos(db, ticket, rows) -> Map<attachmentId, photo>
 * Only images on THIS ticket in THIS org — an id a row lists that is not one
 * of those is simply not shown.
 */
async function flagPhotos(db, ticket, rows) {
  const out = new Map();
  if (!ticket || ticket.id == null || ticket.organization_id == null) return out;
  const ids = [];
  (Array.isArray(rows) ? rows : []).forEach(function (r) {
    idList(r && r.attachment_ids).forEach(function (id) { if (ids.indexOf(id) < 0) ids.push(id); });
  });
  if (!ids.length) return out;
  const r = await db.query(
    `SELECT id, filename, mime_type, thumb_url, web_url, original_url, uploaded_at
       FROM attachments
      WHERE id = ANY($1::text[]) AND entity_type = 'service_ticket' AND entity_id = $2
        AND organization_id = $3 AND mime_type LIKE 'image/%'`,
    [ids, String(ticket.id), ticket.organization_id]
  );
  r.rows.forEach(function (p) { out.set(String(p.id), p); });
  return out;
}

function photosFor(row, byId) {
  return idList(row && row.attachment_ids)
    .map(function (id) { return byId.get(id); })
    .filter(Boolean);
}

/**
 * listCrewFlags(db, ticket, liveTaskIds) -> publicFlag[]
 * Newest first, at most 50: every open flag, and flags resolved in the last
 * 14 days.
 */
async function listCrewFlags(db, ticket, liveTaskIds) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return [];
  const r = await db.query(
    `SELECT ${CREW_COLS}
       FROM service_ticket_flags
      WHERE ticket_id = $1 AND organization_id = $2
        AND (status = 'open' OR resolved_at >= NOW() - INTERVAL '14 days')
      ORDER BY created_at DESC, id DESC
      LIMIT ${FLAG_CREW_LIST_LIMIT}`,
    [ticket.id, ticket.organization_id]
  );
  const byId = await flagPhotos(db, ticket, r.rows);
  return r.rows.map(function (row) { return publicFlag(row, photosFor(row, byId), liveTaskIds); });
}

// The office's read of one ticket's flags, open first. Every join is pinned
// to the flag row's own org; the task must be an org task of this ticket.
async function officeRows(db, ticket, flagId) {
  const params = [ticket.id, ticket.organization_id];
  let where = 'f.ticket_id = $1 AND f.organization_id = $2';
  if (flagId != null) { params.push(String(flagId)); where += ' AND f.id = $3'; }
  const r = await db.query(
    `SELECT f.id, f.task_id, f.category, f.note, f.author_label, f.status, f.attachment_ids,
            f.resolved_at, f.resolution_note, f.created_at,
            t.id AS task_live_id, t.title AS task_title,
            (s.id IS NOT NULL AND s.revoked_at IS NOT NULL) AS via_revoked_link,
            u.name AS resolved_by_name
       FROM service_ticket_flags f
       LEFT JOIN service_ticket_shares s
              ON s.id = f.share_id AND s.organization_id = f.organization_id
       LEFT JOIN users u
              ON u.id = f.resolved_by AND u.organization_id = f.organization_id
       LEFT JOIN tasks t
              ON t.id = f.task_id AND t.organization_id = f.organization_id
             AND t.service_ticket_id = f.ticket_id AND t.scope = 'org'
      WHERE ${where}
      ORDER BY (f.status = 'open') DESC, f.created_at DESC, f.id DESC
      LIMIT ${FLAG_OFFICE_LIST_LIMIT}`,
    params
  );
  return r.rows;
}

/**
 * listOfficeFlags(db, ticket) -> officeFlag[] (open first, at most 100)
 */
async function listOfficeFlags(db, ticket) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return [];
  const rows = await officeRows(db, ticket, null);
  const byId = await flagPhotos(db, ticket, rows);
  return rows.map(function (row) { return officeFlag(row, photosFor(row, byId)); });
}

// One flag in the office's shape, or null.
async function loadOfficeFlag(db, ticket, flagId) {
  if (!ticket || ticket.id == null || ticket.organization_id == null || flagId == null) return null;
  const rows = await officeRows(db, ticket, flagId);
  if (!rows[0]) return null;
  const byId = await flagPhotos(db, ticket, rows);
  return officeFlag(rows[0], photosFor(rows[0], byId));
}

/**
 * loadFlag(db, ticket, flagId) -> null | {id, task_id, category, note, status,
 *   photo_ids, photos:[{id, thumb_url, web_url}], created_at}
 * For starting a change order from a flag. task_id is null unless it is an
 * org task of this ticket; photo_ids are the ids of the photos found.
 */
async function loadFlag(db, ticket, flagId) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return null;
  if (typeof flagId !== 'string' || !FLAG_ID_RE.test(flagId)) return null;
  const rows = await officeRows(db, ticket, flagId);
  const row = rows[0];
  if (!row) return null;
  const byId = await flagPhotos(db, ticket, rows);
  const photos = photosFor(row, byId).map(function (p) {
    return { id: p.id, thumb_url: p.thumb_url, web_url: p.web_url };
  });
  return {
    id: row.id,
    task_id: row.task_live_id != null ? String(row.task_id) : null,
    category: row.category,
    note: row.note,
    status: row.status,
    photo_ids: photos.map(function (p) { return p.id; }),
    photos: photos,
    created_at: row.created_at,
  };
}

// A crew flag on this ticket, raised through THIS link, by its client_ref.
async function findByClientRef(db, ticket, shareId, clientRef) {
  if (!ticket || ticket.organization_id == null || shareId == null || !clientRef) return null;
  const r = await db.query(
    `SELECT ${CREW_COLS}
       FROM service_ticket_flags
      WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3 AND client_ref = $4
      LIMIT 1`,
    [ticket.id, ticket.organization_id, String(shareId), String(clientRef)]
  );
  return r.rows[0] || null;
}

async function countOpen(db, ticket) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM service_ticket_flags
      WHERE ticket_id = $1 AND organization_id = $2 AND status = 'open'`,
    [ticket.id, ticket.organization_id]
  );
  return countOf(r.rows[0] && r.rows[0].n);
}

// A unique violation on the client_ref index: a retried Send raced its first
// arrival past the lookup.
function isClientRefConflict(e) {
  if (!e || String(e.code) !== '23505') return false;
  return String(e.constraint || '') === CLIENT_REF_INDEX ||
    String(e.message || '').indexOf(CLIENT_REF_INDEX) >= 0;
}

/**
 * insertCrewFlag(db, {ticket, share, task, flag, authorLabel}) -> crew row
 * organization_id and ticket_id come from the TICKET row, share_id from the
 * SHARE row, task_id from the proved task. status, attachment_ids and
 * created_at are written explicitly. `flag` is validateCrewFlag's answer.
 */
async function insertCrewFlag(db, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  const insertOrg = ticket.organization_id;
  const f = o.flag || {};
  const r = await db.query(
    `INSERT INTO service_ticket_flags
       (id, organization_id, ticket_id, task_id, share_id, author_label, category, note,
        attachment_ids, status, client_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'[]'::jsonb,'open',$9,NOW())
     RETURNING ${CREW_COLS}`,
    [svc.genId('stflag'), insertOrg, ticket.id, o.task ? o.task.id : null,
     o.share ? o.share.id : null, o.authorLabel == null ? null : String(o.authorLabel).slice(0, 200),
     f.category, f.note, f.clientRef || null]
  );
  return r.rows[0] || null;
}

/**
 * loadCrewFlagForPhoto(db, ticket, shareId, flagId) -> row | null
 * Pinned to id + ticket + org + THIS link: another link's flag is not found.
 * in_window is decided by the database clock.
 */
async function loadCrewFlagForPhoto(db, ticket, shareId, flagId) {
  if (!ticket || ticket.organization_id == null || shareId == null) return null;
  if (typeof flagId !== 'string' || !FLAG_ID_RE.test(flagId)) return null;
  const r = await db.query(
    `SELECT id, task_id, category, status, attachment_ids, created_at,
            (created_at >= NOW() - INTERVAL '2 hours') AS in_window
       FROM service_ticket_flags
      WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND share_id = $4`,
    [flagId, ticket.id, ticket.organization_id, String(shareId)]
  );
  return r.rows[0] || null;
}

// Is this attachment id on the flag row's list?
function flagHasPhoto(row, attachmentId) {
  if (!row || attachmentId == null || attachmentId === '') return false;
  return idList(row.attachment_ids).indexOf(String(attachmentId)) >= 0;
}

// An attachments row tagged "flag" (tags arrive as an array or JSON text).
function isFlagPhotoRow(att) {
  if (!att) return false;
  return idList(att.tags).indexOf('flag') >= 0;
}

/**
 * photoHolder(db, ticket, attachmentId) -> flag id | null
 * The flag of this ticket, in this org, whose list holds the attachment.
 */
async function photoHolder(db, ticket, attachmentId) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return null;
  if (attachmentId == null || attachmentId === '') return null;
  const r = await db.query(
    `SELECT id, attachment_ids FROM service_ticket_flags
      WHERE ticket_id = $1 AND organization_id = $2`,
    [ticket.id, ticket.organization_id]
  );
  const hit = (r.rows || []).find(function (row) { return flagHasPhoto(row, attachmentId); });
  return hit ? String(hit.id) : null;
}

/**
 * attachPhoto(db, ticket, flagId, attachmentId)
 *   -> {ok:true, added:true|false} | {ok:false, status, error}
 * Appends the id under a row lock, so two photos arriving together cannot
 * both take the last slot or overwrite each other's id. added is false when
 * the id was already on the list (checked before the cap, so a photo that is
 * already on a full flag still answers ok).
 */
async function attachPhoto(db, ticket, flagId, attachmentId) {
  const client = await db.connect();
  let open = false;
  try {
    await client.query('BEGIN');
    open = true;
    const r = await client.query(
      `SELECT id, attachment_ids FROM service_ticket_flags
        WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND status = 'open'
        FOR UPDATE`,
      [String(flagId), ticket.id, ticket.organization_id]
    );
    if (!r.rows[0]) {
      await client.query('ROLLBACK');
      open = false;
      return { ok: false, status: 409, error: MSG.photoResolved };
    }
    const ids = idList(r.rows[0].attachment_ids);
    const id = String(attachmentId);
    if (ids.indexOf(id) >= 0) {
      await client.query('ROLLBACK');
      open = false;
      return { ok: true, added: false };
    }
    if (ids.length >= FLAG_PHOTO_CAP) {
      await client.query('ROLLBACK');
      open = false;
      return { ok: false, status: 409, error: MSG.photoCap };
    }
    ids.push(id);
    await client.query(
      `UPDATE service_ticket_flags SET attachment_ids = $1::jsonb
        WHERE id = $2 AND organization_id = $3`,
      [JSON.stringify(ids), String(flagId), ticket.organization_id]
    );
    await client.query('COMMIT');
    open = false;
    return { ok: true, added: true };
  } catch (e) {
    if (open) { try { await client.query('ROLLBACK'); } catch (_) { /* already gone */ } }
    throw e;
  } finally {
    client.release();
  }
}

/**
 * resolveFlag(db, {ticket, flagId, userId, note}) -> {id, task_id, category, status} | null
 * Only an OPEN flag of this ticket in this org. A second resolve finds nothing.
 */
async function resolveFlag(db, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  if (!ticket || ticket.organization_id == null || o.flagId == null) return null;
  const uid = Number(o.userId);
  const r = await db.query(
    `UPDATE service_ticket_flags
        SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_note = $2
      WHERE id = $3 AND ticket_id = $4 AND organization_id = $5 AND status = 'open'
    RETURNING id, task_id, category, status`,
    [Number.isSafeInteger(uid) && uid > 0 ? uid : null, cleanResolution(o.note) || null,
     String(o.flagId), ticket.id, ticket.organization_id]
  );
  return r.rows[0] || null;
}

/**
 * logFlagEvent(db, ticket, kind, actor, detail, opts?) — SHAPE only:
 * {flag_id, category, task_id}. The note is never written into events.
 * opts.strict inside a transaction (see workOrder.insertEvent).
 */
async function logFlagEvent(db, ticket, kind, actor, detail, opts) {
  const d = detail || {};
  await workOrder.insertEvent(db, ticket, kind, actor, {
    flag_id: d.flag_id == null ? null : String(d.flag_id),
    category: d.category == null ? null : String(d.category),
    task_id: d.task_id == null ? null : String(d.task_id),
  }, opts);
}

/**
 * resolveOpenFlagsOnClose(db, ticket, actor, note, opts?) -> resolved rows
 * For closing, cancelling or archiving a work order: every open flag is
 * resolved with the note, and each gets its flag_resolved line. Pass the
 * transaction client and {strict:true} when called inside BEGIN..COMMIT.
 */
async function resolveOpenFlagsOnClose(db, ticket, actor, note, opts) {
  if (!ticket || ticket.id == null || ticket.organization_id == null) return [];
  const uid = Number(actor && actor.userId);
  const r = await db.query(
    `UPDATE service_ticket_flags
        SET status = 'resolved', resolved_by = $1, resolved_at = NOW(), resolution_note = $2
      WHERE ticket_id = $3 AND organization_id = $4 AND status = 'open'
    RETURNING id, task_id, category`,
    [Number.isSafeInteger(uid) && uid > 0 ? uid : null, cleanResolution(note) || null,
     ticket.id, ticket.organization_id]
  );
  for (const row of r.rows) {
    await logFlagEvent(db, ticket, 'flag_resolved', actor,
      { flag_id: row.id, category: row.category, task_id: row.task_id }, opts);
  }
  return r.rows;
}

/**
 * markOfficeSeen(db, user, ticket, orgId) -> boolean
 * Stamps office_seen_at when the caller can EDIT the ticket. Never throws and
 * never bumps updated_at.
 */
async function markOfficeSeen(db, user, ticket, orgId) {
  try {
    if (!user || !ticket || ticket.id == null || orgId == null) return false;
    // A ticket row from another tenant is never stamped, whatever the caller holds.
    if (ticket.organization_id == null || String(ticket.organization_id) !== String(orgId)) return false;
    const verdict = await access.mayAccessTicketParent({
      query: function (sql, params) { return db.query(sql, params); },
      user: user,
      parent: ticket,
      mode: 'write',
      orgId: orgId,
    });
    if (!verdict || verdict.ok !== true) return false;
    await db.query(
      'UPDATE service_tickets SET office_seen_at = NOW() WHERE id = $1 AND organization_id = $2',
      [ticket.id, orgId]
    );
    return true;
  } catch (e) {
    console.warn('[service-ticket-flags] office seen stamp failed:', e && e.message);
    return false;
  }
}

/**
 * handOffRaised(db, {ticket, share, flag:{id, category, note, task_id,
 *   task_title}, photosExpected}) -> the tracked promise, or null
 * The alert to the people on the work order (work-order-notices). Called only
 * after the flag row is stored and never for a duplicate. Not awaited by the
 * door; tracked so a deploy lets it finish. Never throws.
 */
function handOffRaised(db, payload) {
  try {
    const p = payload || {};
    const flag = p.flag || {};
    if (!p.ticket || flag.id == null) return null;
    const inflight = require('./inflight');
    const notices = require('./work-order-notices');
    if (!notices || typeof notices.notifyProblemFlagged !== 'function') return null;
    const share = p.share
      ? { id: p.share.id, created_by: p.share.created_by, recipient_name: p.share.recipient_name }
      : null;
    return inflight.track(notices.notifyProblemFlagged(db, {
      ticket: p.ticket,
      share: share,
      flag: {
        id: flag.id,
        category: flag.category,
        note: flag.note,
        task_id: flag.task_id == null ? null : flag.task_id,
        task_title: flag.task_title == null ? null : flag.task_title,
        photo_count: clampPhotos(p.photosExpected),
      },
    }), 'ticket_problem');
  } catch (e) {
    console.warn('[service-ticket-flags] problem hand-off failed:', e && e.message);
    return null;
  }
}

// The office list's attention columns, for a query whose service_tickets alias
// is `t`. Every correlated subquery carries its own org predicate. Open means
// status = 'open'; crew activity excludes a link merely being opened.
const ATTENTION_COLUMNS =
  "(SELECT COUNT(*)::int FROM service_ticket_flags f WHERE f.ticket_id = t.id AND f.organization_id = t.organization_id AND f.status = 'open') AS open_flags,\n" +
  "              (SELECT COUNT(*)::int FROM service_ticket_revisions r WHERE r.ticket_id = t.id AND r.organization_id = t.organization_id AND r.status = 'pending') AS pending_suggestions,\n" +
  "              (SELECT MAX(e.created_at) FROM service_ticket_events e WHERE e.ticket_id = t.id AND e.organization_id = t.organization_id AND e.actor_kind = 'share' AND e.kind <> 'share_opened') AS last_crew_at,\n" +
  '              t.office_seen_at';

module.exports = {
  FLAG_CATEGORIES,
  FLAG_STATUSES,
  FLAG_NOTE_MAX,
  FLAG_RESOLUTION_MAX,
  FLAG_OPEN_CAP,
  FLAG_PHOTO_CAP,
  FLAG_PHOTO_WINDOW_MS,
  CLIENT_REF_RE,
  FLAG_ID_RE,
  CREW_FLAG_FIELDS,
  MSG,
  ATTENTION_COLUMNS,
  normalizeFlagCategory,
  validateCrewFlag,
  flagMayTakePhoto,
  cleanResolution,
  isNewFromCrew,
  withAttention,
  publicFlag,
  officeFlag,
  flagPhotos,
  photosFor,
  listCrewFlags,
  listOfficeFlags,
  loadOfficeFlag,
  loadFlag,
  findByClientRef,
  countOpen,
  isClientRefConflict,
  insertCrewFlag,
  loadCrewFlagForPhoto,
  flagHasPhoto,
  isFlagPhotoRow,
  photoHolder,
  attachPhoto,
  resolveFlag,
  resolveOpenFlagsOnClose,
  logFlagEvent,
  markOfficeSeen,
  handOffRaised,
};
