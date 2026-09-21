'use strict';

// THE PRINTABLES FOR A WORK ORDER (1.29, B9). Built on the SERVER, from named
// columns, so "no prices" is a tested property of the payload rather than a
// promise about client code that happens to hold the whole ticket in memory.
//
//   buildWorkOrderPrint     the paper work order a crew or sub works from:
//                           where, who to call, when, the scope, the
//                           checklist, materials (quantity, unit and material
//                           only), every building and what is on each side.
//   buildCompletionReport   the before-and-completion photo report for the
//                           property manager, in the shape of the report
//                           share portal's document (./report-document.js
//                           buildDocument), so the public /r/ page shows it
//                           unchanged.
//
// NO MONEY, by construction:
//   * the scope printed is scope_proposed ONLY (what the crew link already
//     shows). scope_approved is where a priced, signed-off scope lands and is
//     never read here — on the work order or on the completion report;
//   * materials go through svc.normalizeMaterials, which keeps description,
//     qty and unit and nothing else;
//   * internal_notes, guest_log, crew_takeoff, requested_by and every id are
//     never read;
//   * typed text can still mention a dollar amount, so each builder returns
//     money_mentions naming what does, and the office is warned before it
//     prints or sends. Nothing is silently edited.
//
// The completion report goes to someone outside the company: every crew-typed
// name passes through crewName and every crew note through crewText, which
// drop anything that reads as a link.
//
// The builders are pure. The loaders at the bottom are the only part that
// needs a database, and every statement carries `organization_id = $n` taken
// from the ticket row the route already proved.

const svc = require('./service-tickets');
const text = require('./work-order-notify-text');
const tz = require('../timezone');
const reportDocument = require('./report-document');

const STATUS_LABELS = Object.freeze({
  draft: 'Draft', open: 'Open', scheduled: 'Scheduled', in_progress: 'In progress',
  work_complete: 'Work complete', approved: 'Approved', closed: 'Closed', cancelled: 'Cancelled',
});
const PRIORITY_LABELS = Object.freeze({ low: 'Low', normal: 'Normal', high: 'High', urgent: 'Urgent' });

const WORK_ORDER_KEYS = Object.freeze([
  'v', 'kind', 'org_name', 'ticket_number', 'title', 'status_label', 'priority_label',
  'scheduled_label', 'due_label', 'site', 'site_contact', 'office_contact', 'scope',
  'checklist', 'materials', 'buildings', 'time_sheet', 'money_mentions', 'printed_label',
]);

const APPROVED_STATUSES = Object.freeze(['approved', 'closed']);

// A dollar sign before a digit, or a number followed by "dollars" / "usd".
const MONEY_RE = /\$\s?\d|\b\d[\d,]*(\.\d{2})?\s?(dollars|usd)\b/i;

function nonBlank(v) {
  return v != null && String(v).trim() !== '' ? String(v).trim() : null;
}

function parseJson(v, fallback) {
  if (typeof v !== 'string') return v == null ? fallback : v;
  try { return JSON.parse(v); } catch (_) { return fallback; }
}

function zoneOf(orgTz) {
  return tz.resolveTz(null, orgTz);
}

// "Bldg 784 — Side A: rail post; tread 3 · Side D: stringer" ->
//   {head:'Bldg 784', sides:[{label:'Side A', items:['rail post','tread 3']}, {label:'Side D', items:['stringer']}]}
// The server port of js/service-tickets.js parseSubtaskTitle.
function parseSubtaskTitle(title) {
  const s = String(title == null ? '' : title).trim();
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(s);
  if (!m) return { head: s || 'Untitled', sides: [] };
  const sides = m[2].split(/\s+·\s+/).map(function (part) {
    const sm = /^([^:]{1,40}):\s*(.+)$/.exec(part);
    if (!sm) return { label: '', items: [part.trim()] };
    return {
      label: sm[1].trim(),
      items: sm[2].split(/;\s*/).map(function (x) { return x.trim(); }).filter(Boolean),
    };
  });
  return { head: m[1].trim(), sides: sides };
}

// A DATE column is a calendar day and is never shifted into a zone:
// '2026-09-20' -> 'Sep 20, 2026'. node-postgres hands a DATE back as local
// midnight, so a Date is read by its local parts; a string by its prefix.
function calendarDayLabel(v) {
  if (v == null || v === '') return '';
  let ms = null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return '';
    ms = Date.UTC(v.getFullYear(), v.getMonth(), v.getDate());
  } else {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v).trim());
    if (m) ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  }
  if (ms == null) return '';
  return tz.formatInTz(new Date(ms), 'UTC', { month: 'short', day: 'numeric', year: 'numeric' });
}

// An instant, in the org's zone: 'Sep 15, 2026 at 3:10 PM'.
function instantLabel(v, orgTz) {
  const d = text.asDate(v);
  if (!d) return '';
  const zone = zoneOf(orgTz);
  return tz.formatInTz(d, zone, { month: 'short', day: 'numeric', year: 'numeric' }) + ' at ' +
    tz.formatInTz(d, zone, { hour: 'numeric', minute: '2-digit' });
}

// The day an instant falls on in the org's zone: 'Sep 15, 2026'.
function instantDateLabel(v, orgTz) {
  const d = text.asDate(v);
  if (!d) return '';
  return tz.formatInTz(d, zoneOf(orgTz), { month: 'short', day: 'numeric', year: 'numeric' });
}

/**
 * moneyMentions([{label, text}]) -> [label]
 * The labels whose text mentions a dollar amount, each once, in order.
 */
function moneyMentions(parts) {
  const out = [];
  (Array.isArray(parts) ? parts : []).forEach(function (p) {
    if (!p || !p.label) return;
    const body = Array.isArray(p.text) ? p.text.join('\n') : String(p.text == null ? '' : p.text);
    if (MONEY_RE.test(body) && out.indexOf(p.label) < 0) out.push(String(p.label));
  });
  return out;
}

function checklistOf(ticket) {
  return svc.normalizeChecklist(parseJson(ticket && ticket.checklist, []));
}

function materialsOf(ticket) {
  return svc.normalizeMaterials(parseJson(ticket && ticket.materials, []));
}

/**
 * buildWorkOrderPrint({ticket, site, contact, tasks, orgName, tz, now}) -> document
 * Exactly WORK_ORDER_KEYS, whatever the inputs carry.
 */
function buildWorkOrderPrint(input) {
  const a = input || {};
  const t = a.ticket || {};
  const s = a.site || {};
  const scope = nonBlank(t.scope_proposed) ? String(t.scope_proposed) : '';
  const checklist = checklistOf(t);
  const materials = materialsOf(t);
  const buildings = (Array.isArray(a.tasks) ? a.tasks : []).map(function (task) {
    const parsed = parseSubtaskTitle(task && task.title);
    return { head: parsed.head, sides: parsed.sides, done: !!task && task.status === 'done' };
  });
  const contact = a.contact && nonBlank(a.contact.name)
    ? { name: nonBlank(a.contact.name), phone: nonBlank(a.contact.phone) }
    : null;
  const status = svc.normalizeStatus(t.status);

  const doc = {
    v: 1,
    kind: 'work_order',
    org_name: nonBlank(a.orgName) || '',
    ticket_number: nonBlank(t.ticket_number),
    title: text.oneLine(t.title, 200) || 'Work order',
    status_label: STATUS_LABELS[status],
    priority_label: PRIORITY_LABELS[svc.normalizePriority(t.priority)],
    scheduled_label: calendarDayLabel(t.scheduled_for),
    due_label: calendarDayLabel(t.due_date),
    site: {
      job_number: nonBlank(s.job_number),
      name: nonBlank(s.name),
      address: nonBlank(s.address),
      gate_code: nonBlank(s.gate_code),
    },
    site_contact: { name: nonBlank(t.site_contact_name), phone: nonBlank(t.site_contact_phone) },
    office_contact: contact,
    scope: scope,
    checklist: checklist,
    materials: materials,
    buildings: buildings,
    // Phase 3: a work order billed after the work carries a BLANK time and
    // materials sheet for the crew to fill in on site — a yes or no, and
    // nothing else. No rate, no total, no line the office has entered: the
    // paper goes wherever the crew takes it.
    time_sheet: String(t.bill_as || '') === 'time_materials',
    money_mentions: moneyMentions([
      { label: 'Title', text: t.title },
      { label: 'Scope of work', text: scope },
      { label: 'Checklist', text: checklist.map(function (c) { return c.text; }) },
      { label: 'Materials', text: materials.map(function (m) { return [m.qty, m.unit, m.description].join(' '); }) },
      { label: 'Buildings', text: (Array.isArray(a.tasks) ? a.tasks : []).map(function (k) { return k && k.title; }) },
    ]),
    printed_label: instantLabel(a.now == null ? new Date() : a.now, a.tz),
  };
  const out = {};
  WORK_ORDER_KEYS.forEach(function (k) { out[k] = doc[k]; });
  return out;
}

function activityFor(activity, taskId) {
  if (!activity) return null;
  const key = String(taskId);
  if (typeof activity.get === 'function') return activity.get(key) || null;
  return activity[key] || null;
}

function photoRowFor(row) {
  let annotations = parseJson(row.annotations, null);
  if (!Array.isArray(annotations)) annotations = null;
  return {
    id: row.id,
    filename: row.filename,
    mime_type: row.mime_type,
    thumb_url: row.thumb_url,
    web_url: row.web_url,
    caption: row.caption,
    annotations: annotations,
    lat: row.lat,
    lng: row.lng,
    shot_at: row.shot_at || row.taken_at || row.uploaded_at || null,
  };
}

// The crew's name on the report, or '' — a finisher recorded as the shared
// link itself names nobody.
function finisherName(label) {
  const raw = nonBlank(label);
  if (!raw || raw === 'Shared link') return '';
  return text.crewName(raw);
}

// Who finished a building when no printable name is left. A completion made
// from a crew link (the actor was the link, it is labelled 'Shared link', or
// it carries a label crewName empties, such as the link's recipient email) was
// the crew's work, never the office's.
function finisherFallback(act) {
  if (act.completed_via_share) return 'the crew';
  const raw = nonBlank(act.completed_by);
  return raw ? 'the crew' : 'the office';
}

/**
 * buildCompletionReport({ticket, site, tasks, photoRows, activity, approval,
 *   orgName, tz, includeNotes, preparedBy, now}) -> {document, summary}
 *
 * tasks      live org subtasks in created order [{id, title, status}]
 * photoRows  image attachments on those subtasks (entity_id, tags, caption, ...)
 * activity   Map|object taskId -> {notes:[{note, by, at}], completed_by, completed_at,
 *            completed_via_share} — loadBuildingActivity's shape, which already
 *            leaves out the office's send-back reasons
 * approval   {name, at} | null — who approved it and when
 */
function buildCompletionReport(input) {
  const a = input || {};
  const t = a.ticket || {};
  const s = a.site || {};
  const orgTz = a.tz;
  const now = a.now == null ? new Date() : a.now;
  const includeNotes = a.includeNotes !== false;
  const status = svc.normalizeStatus(t.status);
  const approved = APPROVED_STATUSES.indexOf(status) >= 0;
  const approval = a.approval || null;
  const tasks = Array.isArray(a.tasks) ? a.tasks : [];

  const rowsByTask = new Map();
  (Array.isArray(a.photoRows) ? a.photoRows : []).forEach(function (row) {
    if (!row || row.id == null) return;
    const key = String(row.entity_id);
    if (!rowsByTask.has(key)) rowsByTask.set(key, []);
    rowsByTask.get(key).push(row);
  });

  const sections = [];
  const photoRows = [];
  const scope = nonBlank(t.scope_proposed) ? String(t.scope_proposed) : '';
  if (scope) {
    sections.push({ id: 'scope', label: 'Scope of work', layout: 'text-block', text_body: scope });
  }

  let done = 0;
  let beforeCount = 0;
  let completionCount = 0;
  const missing = [];
  const finishers = [];
  const moneyParts = [{ label: 'Scope of work', text: scope }];

  tasks.forEach(function (task, i) {
    const head = parseSubtaskTitle(task.title).head;
    const isDone = task.status === 'done';
    if (isDone) done++;
    const act = activityFor(a.activity, task.id) || {};
    const rows = rowsByTask.get(String(task.id)) || [];
    const before = rows.filter(function (r) { return svc.photoKindOf(r.tags) === 'before'; });
    const completion = rows.filter(function (r) { return svc.photoKindOf(r.tags) !== 'before'; });
    beforeCount += before.length;
    completionCount += completion.length;
    if (!completion.length) missing.push(head);

    const captions = {};
    const ids = [];
    before.concat(completion).forEach(function (r) {
      const kind = svc.photoKindOf(r.tags) === 'before' ? 'Before' : 'Completion';
      const own = text.oneLine(r.caption, 400);
      captions[r.id] = own ? kind + ' — ' + own : kind;
      ids.push(r.id);
      photoRows.push(photoRowFor(r));
    });

    let label;
    if (isDone) {
      const who = finisherName(act.completed_by);
      if (who && finishers.indexOf(who) < 0) finishers.push(who);
      const at = instantLabel(act.completed_at, orgTz);
      label = head + ' — finished by ' + (who || finisherFallback(act)) + (at ? ' · ' + at : '');
    } else {
      label = head + ' — not finished';
    }
    const sectionKey = String(i + 1);
    sections.push({
      id: 'building_' + sectionKey,
      label: label,
      layout: 'photo-grid',
      photoSize: 'medium',
      photo_ids: ids,
      captions: captions,
    });
    moneyParts.push({ label: label, text: ids.map(function (id) { return captions[id]; }) });

    const notes = Array.isArray(act.notes) ? act.notes : [];
    if (includeNotes && notes.length) {
      const lines = notes.map(function (n) {
        const who = finisherName(n.by) || 'Crew';
        const at = instantLabel(n.at, orgTz);
        return who + (at ? ' · ' + at : '') + ': ' + text.crewText(n.note, 1000);
      });
      const notesLabel = head + ' — crew notes';
      sections.push({ id: 'notes_' + sectionKey, label: notesLabel, layout: 'text-block', text_body: lines.join('\n') });
      moneyParts.push({ label: notesLabel, text: lines });
    }
  });

  const approvedName = approved && approval ? nonBlank(approval.name) : null;
  const approvedAt = approved && approval ? instantLabel(approval.at, orgTz) : '';
  let approvalText;
  if (!approved) approvalText = 'Not approved yet.';
  else if (approvedName && approvedAt) approvalText = 'Approved by ' + approvedName + ' on ' + approvedAt + '.';
  else if (approvedName) approvalText = 'Approved by ' + approvedName + '.';
  else if (approvedAt) approvalText = 'Approved on ' + approvedAt + '.';
  else approvalText = 'Approved.';
  const completedLabel = instantLabel(t.completed_at, orgTz);
  if (completedLabel) approvalText += '\nWork completed ' + completedLabel + '.';
  sections.push({ id: 'approval', label: 'Approval', layout: 'text-block', text_body: approvalText });

  const subtitle = (nonBlank(t.ticket_number) ? 'Work order ' + nonBlank(t.ticket_number) : 'Work order') +
    (approved ? '' : ' — Draft, not approved yet');
  const orgName = nonBlank(a.orgName) || '';
  const cover = {
    enabled: true,
    company_name: orgName,
    subtitle: subtitle,
    address: nonBlank(s.address) || '',
    date: (approved && approval && instantDateLabel(approval.at, orgTz)) || instantDateLabel(now, orgTz),
    pm_name: nonBlank(a.preparedBy) || '',
    crew: finishers.join(', '),
  };
  const summaryLine = done + ' of ' + tasks.length + ' buildings finished · ' +
    completionCount + ' completion photo' + (completionCount === 1 ? '' : 's');

  const document = reportDocument.buildDocument({
    report: {
      title: 'Completion report — ' + (text.oneLine(t.title, 200) || 'Work order'),
      summary: summaryLine,
      template_type: 'punch-list',
      style_pack: 'clean',
      cover_page: cover,
      sections_raw: sections,
    },
    photoRows: photoRows,
    fileRows: [],
    project: {
      name: [nonBlank(s.job_number), nonBlank(s.name)].filter(Boolean).join(' · '),
      address_text: nonBlank(s.address) || '',
    },
    orgName: orgName,
    hideFinancials: true,
  });

  return {
    document: document,
    summary: {
      approved: approved ? { name: approvedName, at_label: approvedAt || null } : null,
      sendable: approved,
      buildings_total: tasks.length,
      buildings_done: done,
      before_photos: beforeCount,
      completion_photos: completionCount,
      missing_completion: missing,
      money_mentions: moneyMentions(moneyParts),
      notes_included: includeNotes,
    },
  };
}

// ── loaders ──────────────────────────────────────────────────────────────

async function orgInfo(db, orgId) {
  try {
    const r = await db.query('SELECT name, timezone FROM organizations WHERE id = $1', [orgId]);
    const row = r.rows[0] || {};
    return { name: nonBlank(row.name), timezone: nonBlank(row.timezone) };
  } catch (_) {
    return { name: null, timezone: null };
  }
}

// Live org subtasks of this work order, in the order they were added.
async function loadSubtasks(db, ticket) {
  const r = await db.query(
    `SELECT id, title, status, completed_at FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND archived_at IS NULL AND scope = 'org'
      ORDER BY created_at ASC`,
    [ticket.id, ticket.organization_id]
  );
  return r.rows;
}

/**
 * loadWorkOrderInputs(db, ticket) -> the input buildWorkOrderPrint takes (without now)
 */
async function loadWorkOrderInputs(db, ticket) {
  const workOrder = require('./service-ticket-workorder');
  const [site, contact, tasks, org] = await Promise.all([
    workOrder.workOrderSite(db, ticket),
    workOrder.workOrderContact(db, ticket.organization_id, [ticket.assignee_user_id, ticket.created_by]),
    loadSubtasks(db, ticket),
    orgInfo(db, ticket.organization_id),
  ]);
  return { ticket: ticket, site: site, contact: contact, tasks: tasks, orgName: org.name, tz: org.timezone };
}

// Who approved the work order and when: B3's approved_by / approved_at columns
// when the row has them, else the newest status_changed -> approved event.
async function loadApproval(db, ticket) {
  if (APPROVED_STATUSES.indexOf(svc.normalizeStatus(ticket.status)) < 0) return null;
  if (ticket.approved_by != null || ticket.approved_at) {
    const names = await require('./work-order-review').peopleNames(db, ticket.organization_id, [ticket.approved_by]);
    return {
      name: ticket.approved_by == null ? null : (names[String(ticket.approved_by)] || null),
      at: ticket.approved_at || null,
    };
  }
  const r = await db.query(
    `SELECT e.actor_user_id, e.created_at, u.name
       FROM service_ticket_events e
       LEFT JOIN users u ON u.id = e.actor_user_id AND u.organization_id = e.organization_id
      WHERE e.ticket_id = $1 AND e.organization_id = $2 AND e.kind = 'status_changed'
        AND e.detail->>'to' = 'approved'
      ORDER BY e.created_at DESC LIMIT 1`,
    [ticket.id, ticket.organization_id]
  );
  const row = r.rows[0];
  return row ? { name: nonBlank(row.name), at: row.created_at || null } : null;
}

/**
 * loadBuildingActivity(db, orgId, ticketId) -> Map taskId ->
 *   {notes:[{note, by, at}], completed_by, completed_at, completed_via_share}
 *
 * The report's own read of the building events, not the office's
 * subtaskActivity: a subtask_note flagged sent_back is the office's reason for
 * sending a building back, and send-back reasons are NOT put on the completion
 * report. completed_by is the actor's label as typed (null when there is none)
 * and completed_via_share says the building was finished from a crew link.
 */
async function loadBuildingActivity(db, orgId, ticketId) {
  const out = new Map();
  if (orgId == null || !ticketId) return out;
  const r = await db.query(
    `SELECT id, kind, actor_kind, actor_label, detail, created_at
       FROM service_ticket_events
      WHERE ticket_id = $1 AND organization_id = $2
        AND kind IN ('subtask_note', 'subtask_completed', 'subtask_reopened')
      ORDER BY created_at ASC`,
    [ticketId, orgId]
  );
  for (const e of r.rows) {
    const d = parseJson(e.detail, {}) || {};
    const taskId = d.task_id != null ? String(d.task_id) : null;
    if (!taskId) continue;
    if (!out.has(taskId)) out.set(taskId, { notes: [], completed_by: null, completed_at: null, completed_via_share: false });
    const slot = out.get(taskId);
    const viaShare = e.actor_kind === 'share';
    if (e.kind === 'subtask_note') {
      if (d.sent_back === true || d.sent_back === 'true') continue;
      if (!nonBlank(d.note)) continue;
      slot.notes.push({ note: String(d.note), by: e.actor_label || (viaShare ? 'Shared link' : 'Office'), at: e.created_at });
    } else if (e.kind === 'subtask_completed') {
      slot.completed_by = nonBlank(e.actor_label);
      slot.completed_at = e.created_at;
      slot.completed_via_share = viaShare;
    } else if (e.kind === 'subtask_reopened') {
      slot.completed_by = null;
      slot.completed_at = null;
      slot.completed_via_share = false;
    }
  }
  return out;
}

/**
 * loadCompletionInputs(db, ticket) -> the input buildCompletionReport takes
 * (without includeNotes, preparedBy and now)
 */
async function loadCompletionInputs(db, ticket) {
  const workOrder = require('./service-ticket-workorder');
  const orgId = ticket.organization_id;
  const tasks = await loadSubtasks(db, ticket);
  const taskIds = tasks.map(function (k) { return String(k.id); });
  const [site, activity, photos, approval, org] = await Promise.all([
    workOrder.workOrderSite(db, ticket),
    loadBuildingActivity(db, orgId, ticket.id),
    taskIds.length
      ? db.query(
        `SELECT id, entity_id, filename, mime_type, thumb_url, web_url, caption, annotations, lat, lng, tags,
                COALESCE(taken_at, uploaded_at) AS shot_at
           FROM attachments
          WHERE entity_type = 'task' AND entity_id = ANY($1::text[]) AND organization_id = $2
            AND mime_type LIKE 'image/%'
          ORDER BY position ASC, uploaded_at ASC`,
        [taskIds, orgId]
      ).then(function (r) { return r.rows; })
      : Promise.resolve([]),
    loadApproval(db, ticket),
    orgInfo(db, orgId),
  ]);
  return {
    ticket: ticket, site: site, tasks: tasks, photoRows: photos, activity: activity,
    approval: approval, orgName: org.name, tz: org.timezone,
  };
}

const loaders = Object.freeze({ loadWorkOrderInputs, loadCompletionInputs, loadApproval, loadBuildingActivity });

module.exports = {
  STATUS_LABELS,
  PRIORITY_LABELS,
  WORK_ORDER_KEYS,
  APPROVED_STATUSES,
  MONEY_RE,
  parseSubtaskTitle,
  calendarDayLabel,
  instantLabel,
  instantDateLabel,
  moneyMentions,
  buildWorkOrderPrint,
  buildCompletionReport,
  loaders,
  loadWorkOrderInputs,
  loadCompletionInputs,
  loadBuildingActivity,
};
