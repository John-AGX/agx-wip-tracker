'use strict';

// START A CHANGE ORDER FROM A WORK ORDER (1.29, B8). Office only.
//
// A crew finds extra work on a work order: more rot behind the siding, a stair
// that has to come out, a building nobody put on the punch list. The office
// turns that into a DRAFT change order on the job, with a title, what the extra
// work is, a quantity and the photos that show it, and prices it in the change
// order editor like any other. Nothing about it reaches the crew link.
//
// THE LINK. A change order started here carries job_change_orders
// data.fromWorkOrder, a SERVER-OWNED record:
//   { v:1, ticketId, ticketTitle, ticketNumber,
//     source:{kind, id, taskId, building, category},
//     photos:[{attachment_id, entity_type, entity_id, kind, building, filename, thumb_url, web_url}],
//     startedBy, startedAt }
// It holds no price and no money key. Photos are referenced, not copied. Only
// startChangeOrder writes it (through jobFin.createChangeOrder's fromWorkOrder
// parameter); the REST create door strips it from a body, the REST PUT puts
// the stored value back, and jobFin.createChangeOrder / updateChangeOrder
// ignore it in `fields`, so neither an editor nor an agent payload can forge
// or erase it.
//
// PROOF BEFORE WRITE. Everything the body names is proved to belong to THIS
// work order in THIS organization before a row is written: the suggestion, the
// building note, the flag, and every photo (an image on the ticket itself or on
// one of its live org subtasks). One id that does not prove is a 404 and
// nothing is written.
//
// TENANCY. Every statement carries `organization_id = $n` taken from the ticket
// row the route already loaded with the caller's org. The change order's own
// organization_id comes from its job inside jobFin.createChangeOrder.

const svc = require('./service-tickets');
const text = require('./work-order-notify-text');

const TITLE_MAX = 200;
const DESCRIPTION_MAX = 2000;
const UNIT_MAX = 24;
const QTY_MAX = 1000000;
const PHOTO_MAX = 24;
const TERMS_MAX = 20000;
const BUILDING_MAX = 120;
const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

const SOURCE_KINDS = Object.freeze(['ticket', 'revision', 'building_note', 'flag']);

const MSG = Object.freeze({
  title: 'Give the change order a title.',
  description: 'Describe the extra work.',
  qty: 'Quantity must be a number above zero.',
  photos: 'Pick up to 24 photos.',
  source: 'Unknown source.',
  revision: 'That suggestion is not on this work order.',
  note: 'That note is not on this work order.',
  flag: 'That flag is not on this work order.',
  photo: 'One of those photos is not on this work order.',
  gone: 'Service ticket not found',
  archived: 'This ticket is archived.',
  cancelled: 'This ticket was cancelled. Reopen it before starting a change order.',
});

// The office wording for a flag category, except 'other', which reads better
// as a change order title as 'Problem — Bldg 784'.
const FLAG_CATEGORY_LABEL = Object.freeze(Object.assign({}, text.FLAG_CATEGORY_LABELS, { other: 'Problem' }));

function refuse(status, error, extra) {
  return Object.assign({ ok: false, status: status, error: error }, extra || {});
}

function parseJson(v, fallback) {
  if (typeof v !== 'string') return v == null ? fallback : v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// "Bldg 784" out of "Bldg 784 — Side A: rail post; tread 3". The same parse the
// office and the crew page use for a subtask title.
function parseSubtaskHead(title) {
  const s = text.oneLine(title, 400);
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(s);
  const head = (m ? m[1] : s).trim();
  return Array.from(head).slice(0, BUILDING_MAX).join('') || null;
}

// The change order's scope, from the office's description: escaped, one
// paragraph, line breaks kept. cleanCoData sanitizes it again on the way in.
function scopeHtmlFromDescription(description) {
  const body = text.escHtml(String(description == null ? '' : description)).replace(/\r?\n/g, '<br>');
  return '<p>' + body + '</p>';
}

/**
 * validateStartBody(body) -> {ok:true, values} | {ok:false, status:400, error}
 * values: {title, description, qty, unit, photoIds, terms, source:{kind, id}, allowDuplicate}
 */
function validateStartBody(body) {
  const b = isPlainObject(body) ? body : {};

  const title = String(b.title == null ? '' : b.title).trim();
  if (!title || Array.from(title).length > TITLE_MAX) return refuse(400, MSG.title);

  const description = String(b.description == null ? '' : b.description).trim();
  if (!description || Array.from(description).length > DESCRIPTION_MAX) return refuse(400, MSG.description);

  let qty = 1;
  if (b.qty != null && b.qty !== '') {
    qty = typeof b.qty === 'number' ? b.qty : (typeof b.qty === 'string' ? Number(b.qty.trim()) : NaN);
    if (!Number.isFinite(qty) || qty <= 0 || qty > QTY_MAX) return refuse(400, MSG.qty);
  }

  const unit = Array.from(String(b.unit == null ? '' : b.unit).trim()).slice(0, UNIT_MAX).join('') || 'ea';

  let photoIds = [];
  if (b.photo_ids != null) {
    if (!Array.isArray(b.photo_ids)) return refuse(400, MSG.photos);
    for (const raw of b.photo_ids) {
      if (typeof raw !== 'string' || !ID_RE.test(raw)) return refuse(400, MSG.photos);
      if (photoIds.indexOf(raw) < 0) photoIds.push(raw);
    }
    if (photoIds.length > PHOTO_MAX) return refuse(400, MSG.photos);
  }

  let terms;
  if (typeof b.terms === 'string') terms = b.terms.slice(0, TERMS_MAX);

  const src = isPlainObject(b.source) ? b.source : {};
  const kind = typeof src.kind === 'string' ? src.kind : '';
  if (SOURCE_KINDS.indexOf(kind) < 0) return refuse(400, MSG.source);
  let id = null;
  if (kind !== 'ticket') {
    id = src.id == null ? '' : String(src.id).trim();
    // A malformed id cannot be on this work order; it gets the same answer an
    // id from another work order gets, and never reaches a statement.
    if (!ID_RE.test(id)) id = null;
  }

  return {
    ok: true,
    values: {
      title: title,
      description: description,
      qty: qty,
      unit: unit,
      photoIds: photoIds,
      terms: terms,
      source: { kind: kind, id: id },
      allowDuplicate: b.allow_duplicate === true,
    },
  };
}

function notFoundFor(kind) {
  if (kind === 'revision') return MSG.revision;
  if (kind === 'building_note') return MSG.note;
  return MSG.flag;
}

/**
 * fromWorkOrderRecord({ticket, source, photos, userId, now}) -> the data.fromWorkOrder record.
 * Pure. Only the keys below, whatever the inputs carry.
 */
function fromWorkOrderRecord(o) {
  const opts = o || {};
  const t = opts.ticket || {};
  const s = opts.source || {};
  const when = opts.now instanceof Date ? opts.now : new Date(opts.now == null ? Date.now() : opts.now);
  const uid = Number(opts.userId);
  return {
    v: 1,
    ticketId: String(t.id),
    ticketTitle: text.oneLine(t.title, TITLE_MAX),
    ticketNumber: t.ticket_number == null || t.ticket_number === '' ? null : String(t.ticket_number),
    source: {
      kind: SOURCE_KINDS.indexOf(s.kind) >= 0 ? s.kind : 'ticket',
      id: s.id == null ? null : String(s.id),
      taskId: s.taskId == null ? null : String(s.taskId),
      building: s.building == null ? null : Array.from(String(s.building)).slice(0, BUILDING_MAX).join(''),
      category: s.category == null ? null : String(s.category),
    },
    photos: (Array.isArray(opts.photos) ? opts.photos : []).slice(0, PHOTO_MAX).map(function (p) {
      return {
        attachment_id: String(p.attachment_id),
        entity_type: p.entity_type === 'task' ? 'task' : 'service_ticket',
        entity_id: String(p.entity_id),
        kind: p.kind === 'before' || p.kind === 'completion' ? p.kind : 'site',
        building: p.building == null ? null : String(p.building),
        filename: p.filename == null ? null : String(p.filename),
        thumb_url: p.thumb_url || null,
        web_url: p.web_url || null,
      };
    }),
    startedBy: Number.isSafeInteger(uid) && uid > 0 ? uid : null,
    startedAt: isNaN(when.getTime()) ? new Date().toISOString() : when.toISOString(),
  };
}

/**
 * proveSource(db, ticket, source) ->
 *   {ok:true, source:{kind, id, taskId, building, category}} | {ok:false, status, error}
 */
async function proveSource(db, ticket, source) {
  const s = source || {};
  const kind = s.kind;
  if (kind === 'ticket') {
    return { ok: true, source: { kind: 'ticket', id: null, taskId: null, building: null, category: null } };
  }
  if (SOURCE_KINDS.indexOf(kind) < 0) return refuse(400, MSG.source);
  if (s.id == null || !ID_RE.test(String(s.id))) return refuse(404, notFoundFor(kind));
  const id = String(s.id);

  if (kind === 'revision') {
    const r = await db.query(
      `SELECT id, note, fields FROM service_ticket_revisions
        WHERE id = $1 AND ticket_id = $2 AND organization_id = $3`,
      [id, ticket.id, ticket.organization_id]
    );
    if (!r.rows[0]) return refuse(404, MSG.revision);
    return { ok: true, source: { kind: 'revision', id: id, taskId: null, building: null, category: null } };
  }

  if (kind === 'building_note') {
    const r = await db.query(
      `SELECT id, detail FROM service_ticket_events
        WHERE id = $1 AND ticket_id = $2 AND organization_id = $3 AND kind = 'subtask_note'`,
      [id, ticket.id, ticket.organization_id]
    );
    const row = r.rows[0];
    if (!row) return refuse(404, MSG.note);
    const detail = parseJson(row.detail, {}) || {};
    const task = detail.task_id != null
      ? await require('./service-ticket-workorder').loadSubtask(db, ticket, detail.task_id)
      : null;
    return {
      ok: true,
      source: {
        kind: 'building_note', id: id,
        taskId: task ? String(task.id) : null,
        building: task ? parseSubtaskHead(task.title) : null,
        category: null,
      },
    };
  }

  // A flag the crew raised on this work order.
  const flag = await require('./service-ticket-flags').loadFlag(db, ticket, id);
  if (!flag) return refuse(404, MSG.flag);
  const task = flag.task_id != null
    ? await require('./service-ticket-workorder').loadSubtask(db, ticket, flag.task_id)
    : null;
  return {
    ok: true,
    source: {
      kind: 'flag', id: id,
      taskId: task ? String(task.id) : null,
      building: task ? parseSubtaskHead(task.title) : null,
      category: flag.category == null ? null : String(flag.category),
    },
  };
}

/**
 * provePhotos(db, ticket, ids) -> {ok:true, photos:[record photo]} | {ok:false, status:404, error}
 * Every id must be an image on this ticket, or on one of its live org
 * subtasks, in this org. The photos come back in the order they were asked for.
 */
async function provePhotos(db, ticket, ids) {
  const want = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = String(raw);
    if (want.indexOf(id) < 0) want.push(id);
  }
  if (!want.length) return { ok: true, photos: [] };

  const tasks = await db.query(
    `SELECT id, title FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND scope = 'org' AND archived_at IS NULL`,
    [ticket.id, ticket.organization_id]
  );
  const titles = new Map();
  tasks.rows.forEach(function (t) { titles.set(String(t.id), t.title); });

  const r = await db.query(
    `SELECT id, entity_type, entity_id, filename, mime_type, thumb_url, web_url, tags
       FROM attachments
      WHERE id = ANY($1::text[]) AND organization_id = $2 AND mime_type LIKE 'image/%'
        AND ((entity_type = 'service_ticket' AND entity_id = $3)
          OR (entity_type = 'task' AND entity_id = ANY($4::text[])))`,
    [want, ticket.organization_id, String(ticket.id), Array.from(titles.keys())]
  );
  const byId = new Map();
  r.rows.forEach(function (row) { byId.set(String(row.id), row); });
  if (want.some(function (id) { return !byId.has(id); })) return refuse(404, MSG.photo);

  return {
    ok: true,
    photos: want.map(function (id) {
      const row = byId.get(id);
      const onTask = row.entity_type === 'task';
      return {
        attachment_id: String(row.id),
        entity_type: onTask ? 'task' : 'service_ticket',
        entity_id: String(row.entity_id),
        kind: onTask ? svc.photoKindOf(row.tags) : 'site',
        building: onTask ? parseSubtaskHead(titles.get(String(row.entity_id))) : null,
        filename: row.filename == null ? null : String(row.filename),
        thumb_url: row.thumb_url || null,
        web_url: row.web_url || null,
      };
    }),
  };
}

/**
 * findDuplicate(db, ticket, source) -> {id, co_number, status} | null
 * A change order already started on this job from the same suggestion, note or
 * flag. Ticket-level starts are never duplicates: one work order can have
 * several extras.
 */
async function findDuplicate(db, ticket, source) {
  const s = source || {};
  if (!ticket || !ticket.job_id || s.kind === 'ticket' || s.id == null) return null;
  const r = await db.query(
    `SELECT co.id, co.co_number, co.status
       FROM job_change_orders co
      WHERE co.job_id = $1 AND co.organization_id = $2
        AND co.data->'fromWorkOrder'->>'ticketId' = $3
        AND co.data->'fromWorkOrder'->'source'->>'kind' = $4
        AND co.data->'fromWorkOrder'->'source'->>'id' = $5
      LIMIT 1`,
    [String(ticket.job_id), ticket.organization_id, String(ticket.id), String(s.kind), String(s.id)]
  );
  return r.rows[0] || null;
}

/**
 * startChangeOrder(pool, {ticket, user, body}) ->
 *   {ok:true, change_order:{id, job_id, co_number, status, title}, change_orders}
 *   | {ok:false, status, error, existing?}
 *
 * The route has already proved the ticket (org, write access, ESTIMATES_EDIT,
 * not archived or cancelled, on a job in this org). This validates the body,
 * proves the source and the photos, then in ONE transaction locks the ticket
 * row (so two starts from the same note cannot both pass the duplicate check),
 * creates the draft through the shared change order service and writes the
 * change_order_started event.
 */
async function startChangeOrder(pool, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  const user = o.user || {};
  if (!ticket || ticket.organization_id == null || !ticket.job_id) return refuse(404, MSG.gone);

  const v = validateStartBody(o.body);
  if (!v.ok) return v;
  const values = v.values;

  const proved = await proveSource(pool, ticket, values.source);
  if (!proved.ok) return proved;
  const photos = await provePhotos(pool, ticket, values.photoIds);
  if (!photos.ok) return photos;

  const jobFin = require('./job-financials');
  const workOrder = require('./service-ticket-workorder');
  const record = fromWorkOrderRecord({
    ticket: ticket, source: proved.source, photos: photos.photos, userId: user.id, now: o.now,
  });
  const fields = {
    title: values.title,
    scope: scopeHtmlFromDescription(values.description),
    lines: [{
      description: text.oneLine(values.description, 300),
      qty: values.qty,
      unit: values.unit,
      unitCost: 0,
      unitSell: '',
      markup: '',
      markupMode: 'percent',
    }],
  };
  if (values.terms !== undefined) fields.terms = values.terms;

  const client = await pool.connect();
  let created;
  try {
    await client.query('BEGIN');
    try {
      // LOCK ORDER: jobs FIRST, then service_tickets. Never the other way.
      //
      // createChangeOrder below INSERTs into job_change_orders, and its
      // job_id -> jobs(id) FK check takes FOR KEY SHARE on THIS job's row and
      // holds it to COMMIT. assertJobInOrg's plain `SELECT 1 FROM jobs` takes
      // no lock at all (services/job-financials.js) — the FK does, and it does
      // it LATE, once this transaction is already sitting on the ticket row.
      // DELETE /api/jobs/:id walks the other way round: the jobs row FOR UPDATE
      // first, then every work order on the job (routes/job-routes.js). Two
      // transactions, opposite orders, and FOR KEY SHARE conflicts with
      // FOR UPDATE — that is a cycle, and Postgres kills one of them with
      // 40P01, which surfaces here as MSG.coFailed and there as a bare 500.
      // It is the same inversion on `jobs` that wrote 0 of 1205 rows on the
      // 08.13.26 QB import (the header in routes/qb-cost-routes.js).
      //
      // This is not a NEW lock. It is the exact mode the FK check takes anyway,
      // moved to the front of the transaction: no conflict this transaction did
      // not already have, and no behaviour change. It must stay FOR KEY SHARE.
      // FOR UPDATE would block the FK check of every concurrent INSERT that
      // references this job, and would build a fresh cycle with the punch-list
      // door, which locks a work order and then writes a task whose job_id FK
      // wants precisely this row (services/service-ticket-subtask-door.js).
      //
      // Nothing is read off it: a job that is gone or in another tenant matches
      // no row and takes no lock, and the ticket check immediately below is
      // what answers 404. The organization predicate matches assertJobInOrg's,
      // legacy NULL-org jobs included, so this can never lock a row that call
      // would then refuse.
      await client.query(
        'SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) FOR KEY SHARE',
        [String(ticket.job_id), ticket.organization_id]
      );
      const locked = await client.query(
        'SELECT id, status, archived_at, job_id FROM service_tickets WHERE id = $1 AND organization_id = $2 FOR UPDATE',
        [ticket.id, ticket.organization_id]
      );
      const row = locked.rows[0];
      let refusal = null;
      if (!row || String(row.job_id || '') !== String(ticket.job_id)) refusal = refuse(404, MSG.gone);
      else if (row.archived_at) refusal = refuse(409, MSG.archived);
      else if (row.status === 'cancelled') refusal = refuse(409, MSG.cancelled);
      if (!refusal && proved.source.kind !== 'ticket' && !values.allowDuplicate) {
        const dupe = await findDuplicate(client, ticket, proved.source);
        if (dupe) {
          refusal = refuse(409, 'A change order was already started from this — ' + dupe.co_number + '.', {
            existing: { id: dupe.id, co_number: dupe.co_number, status: dupe.status },
          });
        }
      }
      if (refusal) {
        await client.query('ROLLBACK');
        return refusal;
      }

      created = await jobFin.createChangeOrder(client, {
        jobId: String(ticket.job_id),
        orgId: ticket.organization_id,
        ownerId: user.id,
        fields: fields,
        fromWorkOrder: record,
      });
      await workOrder.insertEvent(client, ticket, 'change_order_started',
        { kind: 'user', userId: user.id || null, label: user.name || null },
        {
          co_id: created.id,
          co_number: created.co_number,
          source_kind: proved.source.kind,
          source_id: proved.source.id,
          task_id: proved.source.taskId,
          photos: photos.photos.length,
        },
        { strict: true });
      await client.query('COMMIT');
    } catch (e) {
      try { await client.query('ROLLBACK'); } catch (_) { /* the throw below is the news */ }
      throw e;
    }
  } finally {
    client.release();
  }

  return {
    ok: true,
    change_order: {
      id: created.id,
      job_id: created.job_id,
      co_number: created.co_number,
      status: created.status || 'draft',
      title: values.title,
    },
    change_orders: await linkedChangeOrders(pool, ticket),
  };
}

/**
 * linkedChangeOrders(db, ticket) -> [{id, co_number, status, title, source_kind, source_id, task_id, created_at}]
 * The change orders started from this work order, oldest first. Never lines or
 * totals. [] on any error: the list is a convenience, and a fixture or an old
 * database without the table must not fail the ticket read.
 */
async function linkedChangeOrders(db, ticket) {
  try {
    if (!ticket || !ticket.job_id || ticket.organization_id == null) return [];
    const r = await db.query(
      `SELECT co.id, co.co_number, co.status, co.data->>'title' AS title,
              co.data->'fromWorkOrder'->'source' AS source, co.created_at
         FROM job_change_orders co
        WHERE co.job_id = $1 AND co.organization_id = $2
          AND co.data->'fromWorkOrder'->>'ticketId' = $3
        ORDER BY co.created_at ASC`,
      [String(ticket.job_id), ticket.organization_id, String(ticket.id)]
    );
    return r.rows.map(function (row) {
      const s = parseJson(row.source, null) || {};
      return {
        id: row.id,
        co_number: row.co_number,
        status: row.status,
        title: row.title == null ? null : String(row.title),
        source_kind: s.kind == null ? null : String(s.kind),
        source_id: s.id == null ? null : String(s.id),
        task_id: s.taskId == null ? null : String(s.taskId),
        created_at: row.created_at,
      };
    });
  } catch (e) {
    console.warn('[service-ticket-change-order] linked change orders read failed:', e && e.message);
    return [];
  }
}

/**
 * coDraftCounts(db, orgId, tickets) -> {ticketId: n}
 * Draft change orders started from each listed ticket, over the listed
 * tickets' jobs only. A change order counts for a ticket only when it sits on
 * that ticket's own job, so a record naming a ticket from another job is not
 * counted. {} on any error.
 */
async function coDraftCounts(db, orgId, tickets) {
  try {
    const list = (Array.isArray(tickets) ? tickets : []).filter(function (t) { return t && t.id != null && t.job_id; });
    if (orgId == null || !list.length) return {};
    const jobOf = new Map();
    const jobIds = [];
    list.forEach(function (t) {
      jobOf.set(String(t.id), String(t.job_id));
      if (jobIds.indexOf(String(t.job_id)) < 0) jobIds.push(String(t.job_id));
    });
    const r = await db.query(
      `SELECT co.job_id, co.data->'fromWorkOrder'->>'ticketId' AS ticket_id
         FROM job_change_orders co
        WHERE co.organization_id = $1 AND co.status = 'draft' AND co.job_id = ANY($2::text[])`,
      [orgId, jobIds]
    );
    const out = {};
    r.rows.forEach(function (row) {
      const tid = row.ticket_id == null ? null : String(row.ticket_id);
      if (!tid || !jobOf.has(tid) || jobOf.get(tid) !== String(row.job_id)) return;
      out[tid] = (out[tid] || 0) + 1;
    });
    return out;
  } catch (e) {
    console.warn('[service-ticket-change-order] draft counts read failed:', e && e.message);
    return {};
  }
}

module.exports = {
  SOURCE_KINDS,
  FLAG_CATEGORY_LABEL,
  MSG,
  parseSubtaskHead,
  scopeHtmlFromDescription,
  validateStartBody,
  fromWorkOrderRecord,
  proveSource,
  provePhotos,
  findDuplicate,
  startChangeOrder,
  linkedChangeOrders,
  coDraftCounts,
};
