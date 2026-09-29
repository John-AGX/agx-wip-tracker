'use strict';

// EXPORT A WORK ORDER'S PHOTOS AND FILES AS A ZIP.
//
// John, 2026-09-29: "I need to be able to export a service tickets files and
// photos to a zip folder, that sorts into before after and issues pictures
// ... so I can send the report and photos to someone."
//
// THE THREE FOLDERS ARE NOT NEW WORDS. They are the taxonomy the work order
// already keeps, renamed to what John calls them:
//
//   Before/     photos tagged 'before'. The office and the crew both upload
//               against an explicit Before / Completion control per building,
//               so this tag is deliberate, not inferred from a timestamp.
//   After/      everything else the site read returns — services/service-tickets.js
//               photoKindOf() calls it 'completion', and "after" is the same
//               set under the name somebody uses out loud.
//   Issues/     the photos on a crew-flagged problem. Those are the ones taken
//               because something was wrong, which is what an issue picture is.
//   Documents/  the non-image files on the ticket, so "files and photos" means
//               both. Named apart because a recipient opening Before/ wants
//               photographs, not a PDF.
//
// A RECEIPT IS A PICTURE OF PRICES AND DOES NOT GO. This export exists to be
// SENT TO SOMEONE — that is the whole ask — so the rule that keeps receipts
// off every crew-facing surface (services/service-ticket-field-capture.js,
// and NOT_A_SITE_PHOTO in service-ticket-workorder.js) has to hold here too,
// where the audience is even further outside. It is an OPT-IN per export
// rather than a flat ban, because the office does sometimes send its own
// bookkeeper the lot; the default is off and the caller has to say so.
//
// THE REPORT RIDES ALONG, at the root, because "send the report and photos"
// is one errand and two downloads is two chances to send half of it.
//
// TENANCY. Every statement is predicated on the organization_id of the ticket
// row the route already loaded with the caller's org, and every attachment is
// re-proved to belong to this ticket or one of its buildings before its bytes
// are read — an id on a flag row is a POINTER, not a permission, which is the
// same rule flagPhotos and receiptPhotos already follow.

const path = require('path');
const svc = require('./service-tickets');

const IMAGE_RE = /^image\//i;
const RECEIPT_TAG = 'receipt';
const FLAG_TAG = 'flag';
const BEFORE_TAG = 'before';

const FOLDER = Object.freeze({
  before: 'Before',
  after: 'After',
  issue: 'Issues',
  document: 'Documents',
  receipt: 'Receipts',
});

// A cap, so one export cannot try to stream a library. Well under the zip
// writer's own 4GB ceiling, and it refuses rather than truncating: half an
// export that looks whole is worse than being told to narrow it.
const MAX_FILES = 500;

const MSG = Object.freeze({
  tooMany: 'This work order has more files than one export can carry. Send it in parts, or ask for a narrower export.',
  nothing: 'There is nothing on this work order to export yet.',
});

function tagsOf(v) {
  let list = v;
  if (typeof list === 'string') {
    try { list = JSON.parse(list); } catch (_) { list = list ? [list] : []; }
  }
  return Array.isArray(list) ? list.map(function (t) { return String(t).toLowerCase(); }) : [];
}

function hasTag(v, tag) {
  return tagsOf(v).indexOf(tag) >= 0;
}

function isImage(row) {
  return IMAGE_RE.test(String((row && row.mime_type) || ''));
}

/**
 * Which folder a row belongs in. Order matters and is the point:
 * a receipt is a receipt even if somebody also tagged it 'before', and a flag
 * photo is an issue even though it is technically a completion photo.
 */
function folderFor(row, opts) {
  if (hasTag(row.tags, RECEIPT_TAG)) return (opts && opts.receipts) ? FOLDER.receipt : null;
  if (row.is_flag_photo || hasTag(row.tags, FLAG_TAG)) return FOLDER.issue;
  if (!isImage(row)) return FOLDER.document;
  // svc.photoKindOf is the ONE definition of before-vs-completion in the app;
  // "after" is that same answer under John's word for it.
  return svc.photoKindOf(row.tags) === BEFORE_TAG ? FOLDER.before : FOLDER.after;
}

/** "Bldg 4 — 03 — rail post.jpg": the building groups, the number keeps order. */
function entryNameFor(row, index) {
  const raw = String(row.filename || 'photo');
  const ext = path.extname(raw).slice(0, 12) || guessExt(row.mime_type);
  const stem = (path.basename(raw, path.extname(raw)) || 'photo').slice(0, 60);
  const where = row.building ? String(row.building).slice(0, 60) + ' — ' : '';
  const n = String(index + 1).padStart(2, '0');
  return where + n + ' — ' + stem + ext;
}

function guessExt(mime) {
  const m = String(mime || '').toLowerCase();
  if (m === 'image/jpeg') return '.jpg';
  if (m === 'image/png') return '.png';
  if (m === 'image/webp') return '.webp';
  if (m === 'image/gif') return '.gif';
  if (m === 'application/pdf') return '.pdf';
  return '';
}

/** The download's own filename: "WO-0001 Pump room leak.zip". */
function archiveName(ticket) {
  const num = (ticket && ticket.ticket_number) ? String(ticket.ticket_number) : 'work-order';
  const title = (ticket && ticket.title) ? ' ' + String(ticket.title) : '';
  return (num + title).replace(/[^\w.\- ]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 90) + '.zip';
}

// ── gather ───────────────────────────────────────────────────────────────

/**
 * collect(db, ticket, opts) -> { files, counts, skipped }
 * Every row carries the storage key its bytes come from, the folder it goes
 * in and the name it takes. Nothing is fetched here — the route streams.
 *
 * opts.receipts: true puts receipts in their own folder. Default false.
 */
async function collect(db, ticket, opts) {
  const o = opts || {};
  const orgId = ticket.organization_id;

  // The ticket's buildings, so a photo can say which one it is from. Names
  // come from the same parse the rest of the work order uses.
  // created_at, because `tasks` has no position column — the same order
  // loadSubtasks in services/service-ticket-print.js reads them in, so the
  // export lists buildings the way the completion report does.
  const tasksQ = await db.query(
    `SELECT id, title FROM tasks
      WHERE service_ticket_id = $1 AND organization_id = $2 AND scope = 'org' AND archived_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [ticket.id, orgId]
  );
  const buildingOf = new Map();
  const taskIds = [];
  for (const t of tasksQ.rows) {
    taskIds.push(String(t.id));
    buildingOf.set(String(t.id), headOf(t.title));
  }

  // Which attachments are on a flagged problem. The column is
  // attachment_ids (services/service-ticket-flags.js flagPhotos reads the
  // same one), and a flag's photos are stored against the TICKET, not the
  // building the problem is on — so they arrive in the ticket query below.
  //
  // This list is a POINTER, never a permission: the ids are matched against
  // attachment rows already read under this organization_id, so an id naming
  // somebody else's photo simply never matches anything.
  const flagQ = await db.query(
    'SELECT attachment_ids FROM service_ticket_flags WHERE ticket_id = $1 AND organization_id = $2',
    [ticket.id, orgId]
  );
  const flagIds = new Set();
  for (const r of flagQ.rows) {
    for (const id of tagsOf(r.attachment_ids)) flagIds.add(String(id));
  }

  const cols = `id, entity_type, entity_id, filename, mime_type, original_key, web_key, tags, caption,
                position, COALESCE(taken_at, uploaded_at) AS shot_at, uploaded_at`;
  const [onTicket, onTasks] = await Promise.all([
    db.query(
      `SELECT ${cols} FROM attachments
        WHERE entity_type = 'service_ticket' AND entity_id = $1 AND organization_id = $2
        ORDER BY position ASC, uploaded_at ASC`,
      [ticket.id, orgId]
    ).then(function (r) { return r.rows; }),
    taskIds.length
      ? db.query(
        `SELECT ${cols} FROM attachments
          WHERE entity_type = 'task' AND entity_id = ANY($1::text[]) AND organization_id = $2
          ORDER BY position ASC, uploaded_at ASC`,
        [taskIds, orgId]
      ).then(function (r) { return r.rows; })
      : Promise.resolve([]),
  ]);

  const counts = { before: 0, after: 0, issue: 0, document: 0, receipt: 0, skipped: 0 };
  const perFolder = new Map();
  const files = [];

  // GROUPED BY BUILDING, in the order the buildings are listed. The
  // attachments query orders by position across ALL of them at once, which
  // interleaves: position 1 on Bldg 9 sorts ahead of position 2 on Bldg 4,
  // and the folder ends up shuffled. Somebody opening Before/ is looking for
  // one building's photos together, so the rank is (building, then position).
  // The ticket's own photos come first: they are the site, not a building.
  const rankOf = new Map();
  taskIds.forEach(function (id, i) { rankOf.set(id, i + 1); });
  const ordered = onTicket.concat(onTasks).sort(function (a, b) {
    const ra = a.entity_type === 'task' ? (rankOf.get(String(a.entity_id)) || 9999) : 0;
    const rb = b.entity_type === 'task' ? (rankOf.get(String(b.entity_id)) || 9999) : 0;
    if (ra !== rb) return ra - rb;
    const pa = Number(a.position) || 0, pb = Number(b.position) || 0;
    if (pa !== pb) return pa - pb;
    return String(a.uploaded_at || '') < String(b.uploaded_at || '') ? -1 : 1;
  });

  for (const row of ordered) {
    // flag_ids is matched against rows we already proved belong to this
    // ticket, never used to go and fetch one.
    row.is_flag_photo = flagIds.has(String(row.id));
    row.building = row.entity_type === 'task' ? buildingOf.get(String(row.entity_id)) || null : null;

    const folder = folderFor(row, { receipts: o.receipts === true });
    if (!folder) { counts.receipt += 0; counts.skipped += 1; continue; }

    const key = row.original_key || row.web_key;
    if (!key) { counts.skipped += 1; continue; }   // nothing stored to fetch

    const i = perFolder.get(folder) || 0;
    perFolder.set(folder, i + 1);
    files.push({
      id: String(row.id),
      key: String(key),
      name: folder + '/' + entryNameFor(row, i),
      folder: folder,
      mime: row.mime_type || null,
      date: row.shot_at ? new Date(row.shot_at) : null,
    });
    countKey(counts, folder);
  }

  return { files: files, counts: counts, buildings: buildingOf.size };
}

function countKey(counts, folder) {
  if (folder === FOLDER.before) counts.before += 1;
  else if (folder === FOLDER.after) counts.after += 1;
  else if (folder === FOLDER.issue) counts.issue += 1;
  else if (folder === FOLDER.receipt) counts.receipt += 1;
  else counts.document += 1;
}

/** "Bldg 784" out of "Bldg 784 — Side A: rail post" — the same parse the rest uses. */
function headOf(title) {
  const s = String(title == null ? '' : title).replace(/\s+/g, ' ').trim();
  const m = /^(.+?)\s+[—–-]\s+(.+)$/.exec(s);
  return ((m ? m[1] : s).trim() || null);
}

/** A one-page index so the recipient knows what they are looking at. */
function manifestText(ticket, result, opts) {
  const o = opts || {};
  const L = [];
  L.push((ticket.ticket_number ? ticket.ticket_number + ' — ' : '') + (ticket.title || 'Work order'));
  L.push('');
  if (o.siteLine) L.push(o.siteLine);
  if (o.exportedAt) L.push('Exported ' + o.exportedAt);
  if (o.exportedBy) L.push('Exported by ' + o.exportedBy);
  L.push('');
  L.push('WHAT IS IN HERE');
  L.push('  Before/     ' + result.counts.before + ' photo(s) taken before the work');
  L.push('  After/      ' + result.counts.after + ' photo(s) of the finished work');
  L.push('  Issues/     ' + result.counts.issue + ' photo(s) of problems found on site');
  L.push('  Documents/  ' + result.counts.document + ' file(s)');
  if (result.counts.receipt) L.push('  Receipts/   ' + result.counts.receipt + ' receipt(s)');
  L.push('');
  L.push(result.counts.receipt
    ? 'NOTE: this export INCLUDES receipts, which show what things cost.'
    : 'Receipts are not included: they show what things cost.');
  return L.join('\r\n') + '\r\n';
}

module.exports = {
  FOLDER, MAX_FILES, MSG,
  tagsOf, hasTag, isImage, folderFor, entryNameFor, guessExt, archiveName, headOf,
  collect, manifestText,
};
