'use strict';

// FIELD CAPTURE ON A WORK ORDER (Phase 3) — the time, the work performed and
// the materials used, from the person who did the work.
//
// John, 2026-09-19: "work orders are mainly for urgent issues ... we need to
// bill based on work performed and materials and mark-up after the job is
// done ... more info needs to be gathered from the service tech on these, more
// pictures and descriptions of the work being performed." And on who enters
// it: "Both: tech optional, office can enter."
//
// ONLY ON A TICKET THAT BILLS AFTER THE WORK. fieldCaptureOn() is keyed on
// bill_as = 'time_materials' and on nothing else — never on ticket_kind, the
// displayed word. Every ticket that existed before the two kinds is bill_as
// 'none', so none of them grows a time card or a stricter finish rule
// overnight. (The review of the plan caught exactly that: a rule keyed on the
// kind would have demanded hours on every live punch list.)
//
// A LINE IS A CLAIM, NOT A FACT. A tech's line lands `submitted` and the office
// accepts it, corrects it or rejects it. A correction is written BESIDE the
// claim (office_hours, office_crew_size, office_quantity) and the claimed
// number is never overwritten, so "the tech said 8, it was 6" stays readable.
// A line the office types itself is born `accepted`: the office typing it is
// the acceptance.
//
// NO MONEY, AND NO TOTALS TO THE CREW. Nothing here reads or writes a rate, a
// cost or a price — that is the billing phase, and it will live in office-only
// columns. A crew link sees only the lines IT sent (a tech sees the hours they
// typed, not the crew's), with a status word and never the office's numbers or
// notes: total hours times a rate is a labour budget, which this app already
// refuses to show a guest elsewhere.
//
// TENANCY. Both tables are DIRECT. Every statement carries `organization_id =
// $n` from the TICKET row the caller already proved (office) or the token
// already resolved (crew link), never from a request, and every join is pinned
// to the line's own organization.

const svc = require('./service-tickets');

const KINDS = Object.freeze(['labor', 'material']);
const STATUSES = Object.freeze(['submitted', 'accepted', 'rejected']);
const SOURCES = Object.freeze(['crew', 'office']);

const CREW_SIZE_MAX = 50;
const HOURS_MAX = 24;
const QUANTITY_MAX = 99999;
const WORK_TEXT_MAX = 2000;
const DESCRIPTION_MAX = 200;
const UNIT_MAX = 30;
const LABEL_MAX = 120;
const NOTE_MAX = 1000;
// Per ticket, per kind. A work order is a visit or a few; hundreds of lines
// is a script, not a crew.
const LINE_CAP = 300;
const CREW_LIST_LIMIT = 100;
const OFFICE_LIST_LIMIT = 500;
// A work date more than this far back is a typo, not a late timesheet.
const WORK_DATE_MAX_AGE_DAYS = 366;

const CLIENT_REF_RE = /^[A-Za-z0-9_-]{8,64}$/;
const LINE_ID_RE = /^[A-Za-z0-9_-]{1,80}$/;
const DAY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
// Decimal with at most two places. No thousands separators, no signs: a
// quantity with a comma in it is more likely a typo than 1,200 of something.
const AMOUNT_RE = /^(?:\d+(?:\.\d{1,2})?|\.\d{1,2})$/;

const TABLES = Object.freeze({ labor: 'service_ticket_labor', material: 'service_ticket_materials_used' });
const CLIENT_REF_INDEX = Object.freeze({
  labor: 'uq_service_ticket_labor_client_ref',
  material: 'uq_service_ticket_materials_used_client_ref',
});

const MSG = Object.freeze({
  notTimeAndMaterials: 'This work order does not record time or materials.',
  workDate: 'Pick the day the work was done.',
  workDateFuture: 'That day has not happened yet.',
  workDateOld: 'That day is more than a year ago. Check the date.',
  crewSize: 'Say how many people were on site (1 to 50).',
  hours: 'Say how many hours on site, up to 24 — for example 6 or 6.5.',
  workPerformed: 'Say what was done — the office bills from this.',
  description: 'Say what material it was.',
  quantity: 'Say how much was used — a number, for example 3 or 2.5.',
  buildingNotFound: 'That building is not on this work order.',
  lineCap: 'This work order already has 300 of these. Call the office.',
  sendFailed: 'Something went wrong sending that. Try again, or call the office.',
  decision: 'Accept or reject the line.',
  lineNotFound: 'That line is not on this work order.',
  officeHours: 'Hours must be more than 0 and no more than 24.',
  officeCrewSize: 'People on site must be 1 to 50.',
  officeQuantity: 'The quantity must be more than 0.',
  timeMissing: 'No time has been sent on this work order yet. It is billed from the time and the work performed, so send yours before finishing.',
  officeTimeMissing: 'No time has been entered on this work order, and it is billed from the time worked.',
});

// ── small helpers ─────────────────────────────────────────────────────────

function has(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function cleanText(v, max) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

function numberOr(v, fallback) {
  if (v == null || v === '') return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

// '6', '6.5', '.25' -> a number; anything else -> null. Numbers arrive as
// numbers from a JSON body, and are read the same way.
function readAmount(v) {
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? Math.round(v * 100) / 100 : null;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (!AMOUNT_RE.test(t)) return null;
  const n = Number(t);
  return n > 0 ? n : null;
}

function readCount(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && /^\d{1,3}$/.test(v.trim()) ? Number(v.trim()) : NaN);
  return Number.isInteger(n) ? n : null;
}

function dayNumber(ymd) {
  const m = DAY_RE.exec(String(ymd || ''));
  if (!m) return NaN;
  const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
  const t = Date.UTC(y, mo - 1, d);
  const probe = new Date(t);
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return NaN;
  return t / 86400000;
}

// The id of a building, as sent. Proved against the ticket by the caller.
function taskIdOf(v) {
  if (typeof v === 'string' || typeof v === 'number') return String(v).trim() || null;
  return v == null ? null : String(v);
}

function clientRefOf(v) {
  return typeof v === 'string' && CLIENT_REF_RE.test(v) ? v : null;
}

// ── the one switch ────────────────────────────────────────────────────────

// Does this ticket carry a time-and-materials card at all? bill_as only.
function fieldCaptureOn(ticket) {
  return !!ticket && String(ticket.bill_as || '') === 'time_materials';
}

// ── validation (pure) ─────────────────────────────────────────────────────

/**
 * validateWorkDate(value, today) -> { ok, day } | { ok:false, error }
 * `today` is the org's calendar day ('YYYY-MM-DD'). A day ahead of it is
 * refused — except tomorrow, because a crew finishing after midnight on the
 * far side of a time zone from the office is still writing up today.
 */
function validateWorkDate(value, today) {
  const day = typeof value === 'string' ? value.trim() : '';
  const n = dayNumber(day);
  if (!Number.isFinite(n)) return { ok: false, error: MSG.workDate };
  const t = dayNumber(today);
  if (Number.isFinite(t)) {
    if (n > t + 1) return { ok: false, error: MSG.workDateFuture };
    if (n < t - WORK_DATE_MAX_AGE_DAYS) return { ok: false, error: MSG.workDateOld };
  }
  return { ok: true, day: day };
}

/**
 * validateLabor(body, { today }) ->
 *   { ok:true, workDate, crewSize, hours, workPerformed, taskId, clientRef, label }
 * | { ok:false, status:400, error, field }
 * Reads named keys only; nothing loops over the body.
 */
function validateLabor(body, opts) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const date = validateWorkDate(b.work_date, opts && opts.today);
  if (!date.ok) return { ok: false, status: 400, error: date.error, field: 'work_date' };
  const crewSize = readCount(b.crew_size);
  if (crewSize == null || crewSize < 1 || crewSize > CREW_SIZE_MAX) {
    return { ok: false, status: 400, error: MSG.crewSize, field: 'crew_size' };
  }
  const hours = readAmount(b.hours);
  if (hours == null || hours > HOURS_MAX) return { ok: false, status: 400, error: MSG.hours, field: 'hours' };
  const workPerformed = cleanText(b.work_performed, WORK_TEXT_MAX);
  if (!workPerformed) return { ok: false, status: 400, error: MSG.workPerformed, field: 'work_performed' };
  return {
    ok: true,
    workDate: date.day,
    crewSize: crewSize,
    hours: hours,
    workPerformed: workPerformed,
    taskId: taskIdOf(b.task_id),
    clientRef: clientRefOf(b.client_ref),
    label: cleanText(b.by, LABEL_MAX) || null,
  };
}

/**
 * validateMaterial(body) ->
 *   { ok:true, description, quantity, unit, taskId, clientRef, label }
 * | { ok:false, status:400, error, field }
 */
function validateMaterial(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const description = cleanText(b.description, DESCRIPTION_MAX);
  if (!description) return { ok: false, status: 400, error: MSG.description, field: 'description' };
  const quantity = readAmount(b.quantity);
  if (quantity == null || quantity > QUANTITY_MAX) {
    return { ok: false, status: 400, error: MSG.quantity, field: 'quantity' };
  }
  return {
    ok: true,
    description: description,
    quantity: quantity,
    unit: cleanText(b.unit, UNIT_MAX) || null,
    taskId: taskIdOf(b.task_id),
    clientRef: clientRefOf(b.client_ref),
    label: cleanText(b.by, LABEL_MAX) || null,
  };
}

/**
 * validateDecision(kind, body) ->
 *   { ok:true, status:'accepted'|'rejected', office:{...}, note }
 * | { ok:false, status:400, error, field }
 *
 * Accepting may correct the numbers; a correction equal to the claim is not a
 * correction and is stored as none, so "Changed by the office" only ever
 * appears when something actually changed. Rejecting clears any correction:
 * a rejected line bills nothing, so a corrected number on it would only
 * mislead. The note is the office's and never reaches a crew link.
 */
function validateDecision(kind, body, claimed) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const word = typeof b.decision === 'string' ? b.decision.trim().toLowerCase() : '';
  if (word !== 'accept' && word !== 'reject') return { ok: false, status: 400, error: MSG.decision, field: 'decision' };
  const note = cleanText(b.note, NOTE_MAX) || null;
  const c = claimed || {};
  if (word === 'reject') {
    const office = kind === 'labor' ? { office_hours: null, office_crew_size: null } : { office_quantity: null };
    return { ok: true, status: 'rejected', office: office, note: note };
  }
  if (kind === 'labor') {
    let hours = null;
    if (has(b, 'hours') && b.hours !== null && b.hours !== '') {
      hours = readAmount(b.hours);
      if (hours == null || hours > HOURS_MAX) return { ok: false, status: 400, error: MSG.officeHours, field: 'hours' };
      if (hours === numberOr(c.hours, NaN)) hours = null;
    }
    let crew = null;
    if (has(b, 'crew_size') && b.crew_size !== null && b.crew_size !== '') {
      crew = readCount(b.crew_size);
      if (crew == null || crew < 1 || crew > CREW_SIZE_MAX) {
        return { ok: false, status: 400, error: MSG.officeCrewSize, field: 'crew_size' };
      }
      if (crew === numberOr(c.crew_size, NaN)) crew = null;
    }
    return { ok: true, status: 'accepted', office: { office_hours: hours, office_crew_size: crew }, note: note };
  }
  let qty = null;
  if (has(b, 'quantity') && b.quantity !== null && b.quantity !== '') {
    qty = readAmount(b.quantity);
    if (qty == null || qty > QUANTITY_MAX) return { ok: false, status: 400, error: MSG.officeQuantity, field: 'quantity' };
    if (qty === numberOr(c.quantity, NaN)) qty = null;
  }
  return { ok: true, status: 'accepted', office: { office_quantity: qty }, note: note };
}

// ── what each side may see ────────────────────────────────────────────────

// The word a crew link sees for a line. The office's numbers never go with it.
function crewStatusWord(row) {
  const r = row || {};
  if (r.status === 'rejected') return 'not_accepted';
  if (r.status === 'accepted') {
    const changed = r.office_hours != null || r.office_crew_size != null || r.office_quantity != null;
    return changed ? 'changed' : 'accepted';
  }
  return 'sent';
}

function liveTaskOf(row, liveTaskIds) {
  const live = liveTaskIds instanceof Set ? liveTaskIds
    : new Set((Array.isArray(liveTaskIds) ? liveTaskIds : []).map(String));
  return row && row.task_id != null && live.has(String(row.task_id)) ? String(row.task_id) : null;
}

/**
 * publicLine(kind, row, liveTaskIds) — a crew link's view of ONE line it sent.
 * A whitelist: never share_id, entered_by, decided_by, client_ref,
 * organization_id, office_* or office_note.
 */
function publicLine(kind, row, liveTaskIds) {
  const r = row || {};
  const base = {
    id: r.id,
    task_id: liveTaskOf(r, liveTaskIds),
    status: crewStatusWord(r),
    created_at: r.created_at,
  };
  if (kind === 'labor') {
    base.work_date = r.work_date == null ? null : String(r.work_date).slice(0, 10);
    base.crew_size = numberOr(r.crew_size, null);
    base.hours = numberOr(r.hours, null);
    base.work_performed = r.work_performed == null ? '' : String(r.work_performed);
  } else {
    base.description = r.description == null ? '' : String(r.description);
    base.quantity = numberOr(r.quantity, null);
    base.unit = r.unit == null ? null : String(r.unit);
  }
  return base;
}

// The number the office bills from: its correction when it made one, else the
// claim. null on a rejected line, which bills nothing.
function effective(row, claimKey, officeKey) {
  if (!row || row.status === 'rejected') return null;
  const o = numberOr(row[officeKey], null);
  return o != null ? o : numberOr(row[claimKey], null);
}

/**
 * officeLine(kind, row) — everything the office needs to decide and bill.
 * task_id is nulled when the join found no org building on this ticket.
 */
function officeLine(kind, row) {
  const r = row || {};
  const onTicket = r.task_live_id != null;
  const out = {
    kind: kind,
    id: r.id,
    task_id: onTicket ? String(r.task_id) : null,
    task_title: onTicket && r.task_title != null ? r.task_title : null,
    source: r.source,
    author_label: r.author_label == null ? null : r.author_label,
    entered_by_name: r.entered_by_name == null ? null : r.entered_by_name,
    via_revoked_link: r.via_revoked_link === true || r.via_revoked_link === 1 || r.via_revoked_link === 't',
    status: r.status,
    office_note: r.office_note == null ? null : r.office_note,
    decided_by_name: r.decided_by_name == null ? null : r.decided_by_name,
    decided_at: r.decided_at == null ? null : r.decided_at,
    created_at: r.created_at,
  };
  if (kind === 'labor') {
    out.work_date = r.work_date == null ? null : String(r.work_date).slice(0, 10);
    out.crew_size = numberOr(r.crew_size, null);
    out.hours = numberOr(r.hours, null);
    out.work_performed = r.work_performed == null ? '' : String(r.work_performed);
    out.office_crew_size = numberOr(r.office_crew_size, null);
    out.office_hours = numberOr(r.office_hours, null);
    const crew = effective(r, 'crew_size', 'office_crew_size');
    const hours = effective(r, 'hours', 'office_hours');
    // Person-hours: the labour a bill is made of. Office only.
    out.person_hours = crew != null && hours != null ? Math.round(crew * hours * 100) / 100 : null;
  } else {
    out.description = r.description == null ? '' : String(r.description);
    out.quantity = numberOr(r.quantity, null);
    out.unit = r.unit == null ? null : String(r.unit);
    out.office_quantity = numberOr(r.office_quantity, null);
    out.billable_quantity = effective(r, 'quantity', 'office_quantity');
  }
  return out;
}

/**
 * officeSummary(labor, materials) -> the office card's header line. Only
 * ACCEPTED lines count toward the totals; waiting lines are counted apart,
 * so a number the office has not looked at never reads as settled.
 */
function officeSummary(labor, materials) {
  const L = Array.isArray(labor) ? labor : [];
  const M = Array.isArray(materials) ? materials : [];
  let personHours = 0;
  L.forEach(function (l) { if (l.status === 'accepted' && l.person_hours != null) personHours += l.person_hours; });
  return {
    waiting: L.concat(M).filter(function (x) { return x.status === 'submitted'; }).length,
    accepted_person_hours: Math.round(personHours * 100) / 100,
    accepted_labor: L.filter(function (l) { return l.status === 'accepted'; }).length,
    accepted_materials: M.filter(function (m) { return m.status === 'accepted'; }).length,
  };
}

// ── reads ─────────────────────────────────────────────────────────────────

const CREW_COLS = {
  labor: 'id, task_id, work_date, crew_size, hours, work_performed, status, office_hours, office_crew_size, created_at',
  material: 'id, task_id, description, quantity, unit, status, office_quantity, created_at',
};

function tableOf(kind) {
  const t = TABLES[kind];
  if (!t) throw new Error('unknown field line kind: ' + kind);
  return t;
}

function ticketOk(ticket) {
  return !!ticket && ticket.id != null && ticket.organization_id != null;
}

/**
 * listCrewLines(db, ticket, shareId, liveTaskIds) -> { labor, materials }
 * ONLY the lines THIS link sent, newest first. Another link's lines and the
 * office's own are not a crew member's business.
 */
async function listCrewLines(db, ticket, shareId, liveTaskIds) {
  const out = { labor: [], materials: [] };
  if (!ticketOk(ticket) || shareId == null) return out;
  const live = new Set((Array.isArray(liveTaskIds) ? liveTaskIds : []).map(String));
  for (const kind of KINDS) {
    const r = await db.query(
      `SELECT ${CREW_COLS[kind]} FROM ${tableOf(kind)}
        WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3 AND source = 'crew'
        ORDER BY created_at DESC, id DESC
        LIMIT ${CREW_LIST_LIMIT}`,
      [ticket.id, ticket.organization_id, String(shareId)]
    );
    const rows = r.rows.map(function (row) { return publicLine(kind, row, live); });
    if (kind === 'labor') out.labor = rows; else out.materials = rows;
  }
  return out;
}

async function officeRows(db, kind, ticket, lineId) {
  const params = [ticket.id, ticket.organization_id];
  let where = 'l.ticket_id = $1 AND l.organization_id = $2';
  if (lineId != null) { params.push(String(lineId)); where += ' AND l.id = $3'; }
  const r = await db.query(
    `SELECT l.*,
            t.id AS task_live_id, t.title AS task_title,
            (s.id IS NOT NULL AND s.revoked_at IS NOT NULL) AS via_revoked_link,
            eu.name AS entered_by_name, du.name AS decided_by_name
       FROM ${tableOf(kind)} l
       LEFT JOIN service_ticket_shares s
              ON s.id = l.share_id AND s.organization_id = l.organization_id
       LEFT JOIN users eu ON eu.id = l.entered_by AND eu.organization_id = l.organization_id
       LEFT JOIN users du ON du.id = l.decided_by AND du.organization_id = l.organization_id
       LEFT JOIN tasks t
              ON t.id = l.task_id AND t.organization_id = l.organization_id
             AND t.service_ticket_id = l.ticket_id AND t.scope = 'org'
      WHERE ${where}
      ORDER BY (l.status = 'submitted') DESC, l.created_at DESC, l.id DESC
      LIMIT ${OFFICE_LIST_LIMIT}`,
    params
  );
  return r.rows;
}

/**
 * listOfficeLines(db, ticket) -> { labor, materials, summary }
 * Waiting lines first, then newest.
 */
async function listOfficeLines(db, ticket) {
  if (!ticketOk(ticket)) return { labor: [], materials: [], summary: officeSummary([], []) };
  const labor = (await officeRows(db, 'labor', ticket, null)).map(function (r) { return officeLine('labor', r); });
  const materials = (await officeRows(db, 'material', ticket, null)).map(function (r) { return officeLine('material', r); });
  return { labor: labor, materials: materials, summary: officeSummary(labor, materials) };
}

async function loadOfficeLine(db, kind, ticket, lineId) {
  if (!ticketOk(ticket) || lineId == null) return null;
  const rows = await officeRows(db, kind, ticket, lineId);
  return rows[0] ? officeLine(kind, rows[0]) : null;
}

// A crew line on this ticket, sent through THIS link, by its client_ref.
async function findByClientRef(db, kind, ticket, shareId, clientRef) {
  if (!ticketOk(ticket) || shareId == null || !clientRef) return null;
  const r = await db.query(
    `SELECT ${CREW_COLS[kind]} FROM ${tableOf(kind)}
      WHERE ticket_id = $1 AND organization_id = $2 AND share_id = $3 AND client_ref = $4
      LIMIT 1`,
    [ticket.id, ticket.organization_id, String(shareId), String(clientRef)]
  );
  return r.rows[0] || null;
}

async function countLines(db, kind, ticket) {
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM ${tableOf(kind)} WHERE ticket_id = $1 AND organization_id = $2`,
    [ticket.id, ticket.organization_id]
  );
  const n = Number(r.rows[0] && r.rows[0].n);
  return Number.isFinite(n) ? n : 0;
}

/**
 * hasUsableTime(db, ticket) -> boolean
 * The finish rule's question: is there at least one time line that has not
 * been rejected — sent by any link, or typed by the office? A line still
 * waiting on the office counts: the crew has done its part.
 */
async function hasUsableTime(db, ticket) {
  if (!ticketOk(ticket)) return false;
  const r = await db.query(
    `SELECT COUNT(*)::int AS n FROM service_ticket_labor
      WHERE ticket_id = $1 AND organization_id = $2 AND status IN ('submitted', 'accepted')`,
    [ticket.id, ticket.organization_id]
  );
  return Number(r.rows[0] && r.rows[0].n) > 0;
}

// A unique violation on this kind's client_ref index.
function isClientRefConflict(kind, e) {
  if (!e || String(e.code) !== '23505') return false;
  const idx = CLIENT_REF_INDEX[kind];
  return String(e.constraint || '') === idx || String(e.message || '').indexOf(idx) >= 0;
}

// ── writes ────────────────────────────────────────────────────────────────

/**
 * insertLine(db, kind, { ticket, share, task, line, source, userId, authorLabel })
 *   -> the crew-shaped row
 * organization_id and ticket_id from the TICKET row, share_id from the SHARE
 * row, task_id from the proved building. status and created_at are written
 * explicitly: a crew line is `submitted`, an office line `accepted` and
 * decided by the person who typed it.
 */
async function insertLine(db, kind, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  const v = o.line || {};
  const source = o.source === 'office' ? 'office' : 'crew';
  const office = source === 'office';
  const label = o.authorLabel == null ? null : String(o.authorLabel).slice(0, LABEL_MAX);
  const common = [
    svc.genId(kind === 'labor' ? 'stlab' : 'stmat'),
    ticket.organization_id, ticket.id,
    o.task ? o.task.id : null,
    office ? null : (o.share ? o.share.id : null),
    source, label,
    office ? (o.userId == null ? null : o.userId) : null,
  ];
  const decided = office ? 'NOW()' : 'NULL';
  const status = office ? 'accepted' : 'submitted';
  if (kind === 'labor') {
    const r = await db.query(
      `INSERT INTO service_ticket_labor
         (id, organization_id, ticket_id, task_id, share_id, source, author_label, entered_by,
          work_date, crew_size, hours, work_performed, status, decided_by, decided_at, client_ref, created_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'${status}',$13,${decided},$14,NOW())
       RETURNING ${CREW_COLS.labor}`,
      common.concat([v.workDate, v.crewSize, v.hours, v.workPerformed,
        office ? (o.userId == null ? null : o.userId) : null, office ? null : (v.clientRef || null)])
    );
    return r.rows[0] || null;
  }
  const r = await db.query(
    `INSERT INTO service_ticket_materials_used
       (id, organization_id, ticket_id, task_id, share_id, source, author_label, entered_by,
        description, quantity, unit, status, decided_by, decided_at, client_ref, created_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'${status}',$12,${decided},$13,NOW())
     RETURNING ${CREW_COLS.material}`,
    common.concat([v.description, v.quantity, v.unit,
      office ? (o.userId == null ? null : o.userId) : null, office ? null : (v.clientRef || null)])
  );
  return r.rows[0] || null;
}

/**
 * decideLine(db, kind, { ticket, lineId, decision, userId, claimed })
 *   -> the stored row, or null when the line is not on this ticket
 * The claimed columns are never in the SET list — that is the whole promise.
 */
async function decideLine(db, kind, opts) {
  const o = opts || {};
  const ticket = o.ticket;
  const d = o.decision || {};
  if (!ticketOk(ticket) || typeof o.lineId !== 'string' || !LINE_ID_RE.test(o.lineId)) return null;
  const sets = ['status = $4', 'office_note = $5', 'decided_by = $6', 'decided_at = NOW()'];
  const params = [o.lineId, ticket.id, ticket.organization_id, d.status, d.note == null ? null : d.note,
    o.userId == null ? null : o.userId];
  const office = d.office || {};
  const keys = kind === 'labor' ? ['office_hours', 'office_crew_size'] : ['office_quantity'];
  keys.forEach(function (k) {
    params.push(has(office, k) ? office[k] : null);
    sets.push(k + ' = $' + params.length);
  });
  const r = await db.query(
    `UPDATE ${tableOf(kind)} SET ${sets.join(', ')}
      WHERE id = $1 AND ticket_id = $2 AND organization_id = $3
      RETURNING id, task_id, status`,
    params
  );
  return r.rows[0] || null;
}

// The claimed numbers of one line, for a decision to compare its correction
// against. Pinned to the ticket and its org.
async function loadClaim(db, kind, ticket, lineId) {
  if (!ticketOk(ticket) || typeof lineId !== 'string' || !LINE_ID_RE.test(lineId)) return null;
  const cols = kind === 'labor' ? 'id, hours, crew_size' : 'id, quantity';
  const r = await db.query(
    `SELECT ${cols} FROM ${tableOf(kind)} WHERE id = $1 AND ticket_id = $2 AND organization_id = $3`,
    [lineId, ticket.id, ticket.organization_id]
  );
  return r.rows[0] || null;
}

module.exports = {
  KINDS,
  STATUSES,
  SOURCES,
  TABLES,
  CREW_SIZE_MAX,
  HOURS_MAX,
  QUANTITY_MAX,
  LINE_CAP,
  LINE_ID_RE,
  CLIENT_REF_RE,
  MSG,
  fieldCaptureOn,
  validateWorkDate,
  validateLabor,
  validateMaterial,
  validateDecision,
  crewStatusWord,
  publicLine,
  officeLine,
  officeSummary,
  listCrewLines,
  listOfficeLines,
  loadOfficeLine,
  findByClientRef,
  countLines,
  hasUsableTime,
  isClientRefConflict,
  insertLine,
  decideLine,
  loadClaim,
};
