'use strict';
// ── FOLD ONE CLIENT INTO ANOTHER ──────────────────────────────────────────
//
// WHY THIS FILE EXISTS
// The directory's "Merge Client" told the user, verbatim: "Children, linked
// leads, and estimates of the source are reparented to the survivor." It did
// none of that. js/clients.js PUT a blank-fill patch, PUT parent_client_id on
// the child clients, and then DELETE'd the source — three calls from a
// browser, with no transaction and no idea what else pointed at the row.
//
// What the DELETE then did, per column:
//   leads.client_id      FK ON DELETE SET NULL  -> the lead lost its client.
//   projects.client_id   FK ON DELETE SET NULL  -> same silent loss.
//   jobs.client_id       plain TEXT, no FK      -> a DANGLING id.
//   invoices.client_id   plain TEXT, no FK      -> a dangling id.
//   payments.client_id   plain TEXT, no FK      -> a dangling id.
//   estimates.data       JSONB blob             -> a dangling id, AND a frozen
//                        display string (data.client, "Client Company Name")
//                        that goes on naming the deleted client for ever.
//   every polymorphic row keyed (entity_type='client', entity_id) — the
//   client's attachments, tasks, reminders, calendar events, compliance
//   items, receipts, inbound emails, plans, report shares, folders — kept
//   pointing at a row that no longer existed.
//
// So the merge did not merge. It deleted a client and scattered everything
// that referenced it. This module is the whole operation, server-side, in one
// transaction, with the survivor's blanks filled from the source, every
// reference repointed, the frozen display strings rewritten from the
// survivor, and the source deleted LAST.
//
// ── THE REFERENCE REGISTRY IS NOT RE-TYPED HERE ───────────────────────────
// services/clickr/reconcile-merge.js already carries the list of every column
// in server/db.js that points at a client, and test/reconcile-merge.test.js
// pins that list to the schema: a new client reference in db.js fails that
// test until it is registered. Re-typing the list here would give this file a
// SECOND list that drifts away from the schema silently — the exact failure
// mode the pin exists to prevent. Instead PLAIN.clients and POLYMORPHIC are
// imported, and test/client-merge.test.js asserts that the statements below
// cover them exactly. One registry, pinned once, consumed twice.
//
// ── TENANCY ───────────────────────────────────────────────────────────────
// Every statement carries `(organization_id = $n OR organization_id IS NULL)`
// in its own SQL literal — not in a helper that builds the predicate, and not
// leaning on the org-scoped read above it. Both client ids ARE proved in-org
// by the FOR UPDATE reads at the top, and that would be an argument for
// leaning; it is the same argument that was made for the estimates upsert
// right up until a branch reached the write without going through the read.
// The three tables with no organization_id column of their own (job_reports,
// ai_sessions, attachment_folder_grants) are predicated on the entity pair and
// listed in TENANT_LESS, which test/client-merge.test.js checks against the
// real schema so a table that GAINS the column cannot stay on the list.

const { PLAIN, POLYMORPHIC } = require('./clickr/reconcile-merge');

// Editable client fields — the directory's own allowlist, and the set whose
// BLANK members on the survivor are filled from the source. It lives here
// rather than in client-routes.js so the route's PUT and this merge cannot
// disagree about what a client's editable data is.
const EDITABLE_FIELDS = [
  'name', 'client_type', 'activation_status',
  'first_name', 'last_name', 'email',
  'phone', 'cell',
  'address', 'city', 'state', 'zip',
  'company_name', 'community_name', 'market',
  'property_address', 'property_phone', 'website',
  'gate_code', 'additional_pocs',
  'community_manager', 'cm_email', 'cm_phone',
  'maintenance_manager', 'mm_email', 'mm_phone',
  'short_name',
  'notes'
];

// The four columns above that are what the folded row was CALLED, not data
// the survivor is missing. They are exactly the set `srcNames` is built from
// below, where the reframe ERASES them from every estimate and job display
// string — so filling one ONTO the survivor is this file undoing its own work
// a hundred lines apart. And it is not only the client row that is wrong
// after that: the directory renders a row as name + ' — ' + company_name, and
// js/estimate-editor.js (setIf('ee-client', c.company_name || c.name);
// setIf('ee-nickName', c.short_name)) and server/services/payload-dispatcher.js
// (nickName: c.short_name) freeze the SURVIVOR's names onto every FUTURE
// estimate — so a filled name re-seeds itself onto fresh proposals for ever.
//
// EDITABLE_FIELDS itself stays whole: client-routes.js imports it as the PUT
// allowlist, and a user editing a client by hand may of course type a company
// name. A MERGE may not type one for them. One list, read twice, so the fill
// and the erase can never drift apart.
const IDENTITY_FIELDS = ['name', 'company_name', 'community_name', 'short_name'];
const FILL_FIELDS = EDITABLE_FIELDS.filter((c) => IDENTITY_FIELDS.indexOf(c) < 0);

// Tables this merge writes that have NO organization_id column, so the tenant
// predicate cannot be written on them. Pinned to the schema by the test.
const TENANT_LESS = ['job_reports', 'ai_sessions', 'attachment_folder_grants'];

// The polymorphic tables that DO carry organization_id, in the order the
// statements below run them. Kept beside TENANT_LESS so the two together must
// account for every name in POLYMORPHIC.
const POLY_TENANTED = ['attachments', 'tasks', 'reminders', 'calendar_events', 'compliance_items',
  'receipts', 'inbound_emails', 'plans', 'report_shares'];

const str = (v) => (v == null ? '' : String(v));
const norm = (v) => str(v).trim();
const blank = (v) => v === null || v === undefined || v === '';

function parseData(v) {
  if (v && typeof v === 'object') return v;
  try { return JSON.parse(v || '{}') || {}; } catch (e) { return {}; }
}

function bump(counts, key, n) {
  if (n) counts[key] = (counts[key] || 0) + n;
}

async function readClient(db, id, orgId, lock) {
  const r = await db.query(
    'SELECT * FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)' + (lock ? ' FOR UPDATE' : ''),
    [id, orgId]
  );
  return r.rows[0] || null;
}

// Walk parent_client_id upward. Used for both cycle guards below. The visited
// set bounds a tree that is already broken rather than looping for ever.
async function ancestorIds(db, id, orgId) {
  const out = [];
  let cur = norm(id);
  while (cur) {
    const r = await db.query(
      'SELECT parent_client_id FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [cur, orgId]
    );
    if (!r.rows.length) break;
    const p = norm(r.rows[0].parent_client_id);
    if (!p || out.indexOf(p) >= 0) break;
    out.push(p);
    cur = p;
  }
  return out;
}

// ── frozen display strings ────────────────────────────────────────────────
// An estimate carries a SNAPSHOT of its client's names, taken when the client
// was picked. The snapshot is what the proposal prints, so after a merge it
// must name the survivor or the folded client keeps its name on paper for
// ever. The rule is not invented here: it is window.onEstimateClientPicked in
// js/clients.js, which resolves the parent firm for a child (property) row —
// Client = the firm, Community = the property — and falls back to the row's
// own company_name/name when it is top level. A field the survivor has no
// value for comes back '' here, and the caller decides what that means (see
// reframe): keep what a user typed, clear what was the folded client's name.
async function estimateSnapshot(db, survivor, orgId) {
  const parent = survivor.parent_client_id ? await readClient(db, survivor.parent_client_id, orgId, false) : null;
  return {
    nickName: str(survivor.short_name),
    client: parent ? str(parent.company_name || parent.name) : str(survivor.company_name || survivor.name),
    community: parent
      ? str(survivor.community_name || survivor.name)
      : (survivor.community_name && survivor.community_name !== survivor.name ? str(survivor.community_name) : '')
  };
}

// ── the operation ─────────────────────────────────────────────────────────
// Runs inside the caller's transaction. Returns { refused, status } or
// { moved, also, filled, survivor, source }.
async function mergeClients(db, orgId, sourceId, targetId) {
  const src = norm(sourceId);
  const dst = norm(targetId);
  if (!src || !dst) return { refused: 'sourceId and targetId are required.', status: 400 };
  if (src === dst) return { refused: 'A client cannot be merged into itself.', status: 400 };

  const survivor = await readClient(db, dst, orgId, true);
  const source = await readClient(db, src, orgId, true);
  // One message for both, and for "not in this organization" too: which of the
  // two ids exists somewhere else is not this caller's business.
  if (!survivor || !source) return { refused: 'Client not found.', status: 404 };
  if (survivor.bt_archived_at) {
    return { refused: 'The survivor is archived. Restore it before merging into it.', status: 400 };
  }

  // SOURCE IS AN ANCESTOR OF THE TARGET -> REFUSE.
  // The children repoint below moves every child of the source onto the
  // survivor, and skips only the survivor itself (`id <> $1`). That one guard
  // covers the one-hop case (source is the target's direct parent) and nothing
  // deeper: with S -> X -> T, X is repointed onto T while X is still T's
  // ancestor, so the directory tree gains a cycle T -> X -> T. Every renderer
  // that walks parents then hangs. There is no automatic repair that is
  // obviously the user's intent — the answer might be to detach T first, or to
  // merge the other way round — so this refuses and says so instead of
  // guessing.
  const dstAncestors = await ancestorIds(db, dst, orgId);
  if (dstAncestors.indexOf(src) >= 0) {
    return {
      refused: 'That client is a parent of the survivor. Detach the survivor from it first, then merge.',
      status: 400
    };
  }

  // Two DIFFERENT Buildertrend contacts cannot be folded into one row: the
  // source's link is about to be deleted with it, and there is no second
  // column to keep it in. Refuse rather than destroy a reconcile mapping
  // silently. (A source link with a blank survivor link is moved below —
  // there the link would be LOST by doing nothing, which is the worse answer.)
  if (norm(source.bt_contact_id) && norm(survivor.bt_contact_id)
      && norm(source.bt_contact_id) !== norm(survivor.bt_contact_id)) {
    return {
      refused: 'Both clients are linked to different Buildertrend contacts. Unlink one in the Buildertrend reconcile first.',
      status: 400
    };
  }

  const moved = { leads: 0, estimates: 0, jobs: 0, projects: 0, invoices: 0, payments: 0, service_tickets: 0, children: 0 };
  const also = {};

  // ── 1. fill the survivor's BLANKS from the source ───────────────────────
  // Blank is null / undefined / ''. A value the survivor already has is never
  // overwritten, however empty-looking — a survivor whose notes are ' ' keeps
  // ' ', because the alternative is a merge that edits data the user can see.
  const filled = [];
  const sets = [];
  const params = [];
  let p = 1;
  for (const col of FILL_FIELDS) {
    if (blank(survivor[col]) && !blank(source[col])) {
      sets.push(col + ' = $' + p++);
      params.push(source[col]);
      filled.push(col);
    }
  }

  // parent_client_id is not in EDITABLE_FIELDS (the route gates it separately)
  // but it is the survivor's place in the tree, so a blank one is worth
  // filling. Guarded twice: never the survivor itself, and never one of the
  // survivor's own DESCENDANTS, either of which is a cycle.
  if (blank(survivor.parent_client_id) && !blank(source.parent_client_id)) {
    const cand = norm(source.parent_client_id);
    const candAncestors = cand === dst ? [] : await ancestorIds(db, cand, orgId);
    if (cand !== dst && cand !== src && candAncestors.indexOf(dst) < 0) {
      sets.push('parent_client_id = $' + p++);
      params.push(cand);
      filled.push('parent_client_id');
    }
  }

  // The Buildertrend link, when only the source has one. Cleared on the source
  // FIRST: uq_clients_org_bt_contact_id is UNIQUE (organization_id,
  // bt_contact_id) WHERE bt_contact_id IS NOT NULL, so both rows holding the
  // value at once — even for the microseconds before the DELETE — is a
  // constraint violation that would abort the whole merge.
  if (blank(survivor.bt_contact_id) && !blank(source.bt_contact_id)) {
    await db.query(
      'UPDATE clients SET bt_contact_id = NULL, updated_at = NOW() WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
      [src, orgId]
    );
    sets.push('bt_contact_id = $' + p++);
    params.push(source.bt_contact_id);
    filled.push('bt_contact_id');
  }

  if (sets.length) {
    sets.push('updated_at = NOW()');
    params.push(dst, orgId);
    // SAFE: every column name comes from the constant EDITABLE_FIELDS above or
    // is a literal written here; none is reachable from the request body.
    await db.query(
      'UPDATE clients SET ' + sets.join(', ') + ' WHERE id = $' + p + ' AND (organization_id = $' + (p + 1) + ' OR organization_id IS NULL)',
      params
    );
  }

  // Agent notes are AUTHORED CONTENT, not a reference: nothing points at them,
  // so nothing above moves them, and the DELETE at the bottom would take them
  // with it. Appended to the survivor's in order.
  const srcNotes = Array.isArray(source.agent_notes) ? source.agent_notes : parseData(source.agent_notes);
  if (Array.isArray(srcNotes) && srcNotes.length) {
    await db.query(
      `UPDATE clients SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb, updated_at = NOW()
        WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)`,
      [JSON.stringify(srcNotes), dst, orgId]
    );
    bump(also, 'agent_notes', srcNotes.length);
  }

  // ── 2. repoint the id columns ───────────────────────────────────────────
  // Written out one statement at a time rather than looped over the registry,
  // so that each table name and each tenant predicate is READABLE IN THE
  // SOURCE — which is also what lets test/org-write-predicate-invariant.js see
  // the invoices and payments writes at all. The test pins this set against
  // PLAIN.clients, so a column added to the registry fails until it is here.

  // A child of the source becomes a child of the survivor — never of itself.
  const kids = await db.query(
    'UPDATE clients SET parent_client_id = $1, updated_at = NOW() WHERE parent_client_id = $2 AND id <> $1 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.children = kids.rowCount || 0;

  const leads = await db.query(
    'UPDATE leads SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.leads = leads.rowCount || 0;

  const projects = await db.query(
    'UPDATE projects SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.projects = projects.rowCount || 0;

  const invoices = await db.query(
    'UPDATE invoices SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.invoices = invoices.rowCount || 0;

  const payments = await db.query(
    'UPDATE payments SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.payments = payments.rowCount || 0;

  // A work order or service ticket raised for the duplicate client. The row
  // also carries job_id and lead_id, but those belong to the JOB and LEAD
  // merges (reconcile-merge's PLAIN.jobs / PLAIN.leads)  a client merge
  // moves the client link and nothing else, so a ticket keeps whatever job
  // or lead it was raised under.
  const tickets = await db.query(
    'UPDATE service_tickets SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
    [dst, src, orgId]
  );
  moved.service_tickets = tickets.rowCount || 0;

  // jobs are counted as a SET of ids, because a job can be reached two ways —
  // the real column and the blob key below — and a job moved by both is one
  // job moved, not two.
  const jobIds = new Set();
  const jobCol = await db.query(
    'UPDATE jobs SET client_id = $1, updated_at = NOW() WHERE client_id = $2 AND (organization_id = $3 OR organization_id IS NULL) RETURNING id',
    [dst, src, orgId]
  );
  for (const r of jobCol.rows) jobIds.add(r.id);

  // ── 3. repoint the JSONB blobs ──────────────────────────────────────────
  // Read the org's rows and filter in JS rather than predicating on
  // `data->>'client_id'`. Two reasons, and neither is convenience: the blob
  // key is written by the browser and appears under BOTH spellings in the
  // wild (js/estimate-editor.js writes estimates' as `client_id`;
  // js/jobs.js writes jobs' as `clientId`, and older rows carry the other),
  // and a single SQL predicate would silently match only one of them.
  const snapshot = await estimateSnapshot(db, survivor, orgId);
  // Every name the folded client went by. A snapshot field that still holds
  // one of these after the move is the defect itself — the estimate would go
  // on printing the deleted client's name for ever — so it is CLEARED even
  // when the survivor has nothing to put there. A value that is none of
  // these was typed by a user and is left alone.
  const srcNames = new Set(IDENTITY_FIELDS.map((c) => norm(source[c]).toLowerCase()).filter(Boolean));
  const reframe = (d, key, next) => {
    if (next) { d[key] = next; return; }
    if (srcNames.has(norm(d[key]).toLowerCase())) d[key] = '';
  };
  const est = await db.query(
    'SELECT id, data FROM estimates WHERE (organization_id = $1 OR organization_id IS NULL)',
    [orgId]
  );
  for (const row of est.rows) {
    const d = parseData(row.data);
    const hits = norm(d.client_id) === src || norm(d.clientId) === src;
    if (!hits) continue;
    if (norm(d.client_id) === src) d.client_id = dst;
    if (norm(d.clientId) === src) d.clientId = dst;
    // The frozen names, re-derived from the survivor.
    reframe(d, 'client', snapshot.client);
    reframe(d, 'community', snapshot.community);
    reframe(d, 'nickName', snapshot.nickName);
    await db.query(
      'UPDATE estimates SET data = $1::jsonb, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
      [JSON.stringify(d), row.id, orgId]
    );
    moved.estimates++;
  }

  const jobRows = await db.query(
    'SELECT id, data FROM jobs WHERE (organization_id = $1 OR organization_id IS NULL)',
    [orgId]
  );
  for (const row of jobRows.rows) {
    const d = parseData(row.data);
    // jobIds already holds the jobs the COLUMN update moved. They are in
    // scope here too: a job linked only by jobs.client_id still carries the
    // folded client's name in data.client, and skipping it because its blob
    // has no client key is how the display string outlives the merge.
    const hits = jobIds.has(row.id) || norm(d.clientId) === src || norm(d.client_id) === src;
    if (!hits) continue;
    if (norm(d.clientId) === src) d.clientId = dst;
    if (norm(d.client_id) === src) d.client_id = dst;
    // jobs.data.client is the job's displayed client name, and
    // confirmLinkJobClient in js/jobs.js writes it as the linked row's `name`
    // — not company_name. Same rule here.
    reframe(d, 'client', str(survivor.name));
    await db.query(
      'UPDATE jobs SET data = $1::jsonb, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
      [JSON.stringify(d), row.id, orgId]
    );
    jobIds.add(row.id);
  }
  moved.jobs = jobIds.size;

  // ── 4. repoint the polymorphic rows ─────────────────────────────────────
  // Everything filed against the client as (entity_type='client', entity_id).
  const poly = {};
  poly.attachments = (await db.query(
    "UPDATE attachments SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.tasks = (await db.query(
    "UPDATE tasks SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.reminders = (await db.query(
    "UPDATE reminders SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.calendar_events = (await db.query(
    "UPDATE calendar_events SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.compliance_items = (await db.query(
    "UPDATE compliance_items SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.receipts = (await db.query(
    "UPDATE receipts SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.inbound_emails = (await db.query(
    "UPDATE inbound_emails SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.plans = (await db.query(
    "UPDATE plans SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  poly.report_shares = (await db.query(
    "UPDATE report_shares SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount;
  // job_reports and ai_sessions have NO organization_id column (TENANT_LESS).
  // The tenant proof is the entity pair: entity_id is the source id, which the
  // FOR UPDATE read at the top proved is a client of THIS organization, and a
  // row of another tenant cannot carry it.
  poly.job_reports = (await db.query(
    "UPDATE job_reports SET entity_id = $1, updated_at = NOW() WHERE entity_type = 'client' AND entity_id = $2",
    [dst, src])).rowCount;
  poly.ai_sessions = (await db.query(
    "UPDATE ai_sessions SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2",
    [dst, src])).rowCount;
  for (const t of Object.keys(poly)) bump(also, t, poly[t]);

  // ── 5. the rows that cannot simply move ─────────────────────────────────
  // A folder whose (parent, name) the survivor already has is FOLDED into it:
  // the files and subfolders move into the survivor's folder and the emptied
  // folder is removed. Every other folder moves. Top-down, so a parent is
  // resolved before its children. Same algorithm as reconcile-merge's
  // moveFolders, predicated here.
  //
  // THE BOUND IS THE DATA, NOT A CONSTANT. Exactly ONE source folder is
  // resolved per pass — folded into the survivor's twin and deleted, or moved
  // wholesale — so the number of source folders read on the first pass IS the
  // number of passes needed, and the +1 is the pass that reads the empty set
  // and breaks. A fixed cap is a capacity limit wearing a safety backstop's
  // clothes: at one folder more than the cap the loop simply stopped, fell
  // through to the DELETE at the bottom, and left file_folders rows naming a
  // client that no longer existed — the exact orphan class this module was
  // written to eliminate, produced by the module itself. cap is captured ONCE
  // and never recomputed, so nothing the loop does to the data can raise it.
  let guard = 0;
  let cap = Infinity;
  while (guard++ < cap) {
    const folders = (await db.query(
      "SELECT * FROM file_folders WHERE entity_type = 'client' AND entity_id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
      [src, orgId])).rows;
    if (!folders.length) break;
    if (cap === Infinity) cap = folders.length + 1;
    const ids = new Set(folders.map((f) => f.id));
    const f = folders.find((x) => !x.parent_id || !ids.has(x.parent_id));
    if (!f) break;
    const twin = (await db.query(
      `SELECT id FROM file_folders
        WHERE entity_type = 'client' AND entity_id = $1 AND COALESCE(parent_id, '') = COALESCE($2, '')
          AND LOWER(name) = LOWER($3) AND (organization_id = $4 OR organization_id IS NULL)`,
      [dst, f.parent_id || null, f.name, orgId])).rows[0];
    if (twin) {
      await db.query(
        'UPDATE attachments SET folder_id = $1 WHERE folder_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
        [twin.id, f.id, orgId]);
      await db.query(
        'UPDATE file_folders SET parent_id = $1, updated_at = NOW() WHERE parent_id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
        [twin.id, f.id, orgId]);
      // attachment_folder_grants.folder_id is REFERENCES file_folders(id) ON
      // DELETE **CASCADE** (db.js), not SET NULL like attachments.folder_id —
      // which is why the attachments repoint above is a tidy-up and this one is
      // load-bearing. Deleting the emptied folder without it takes the sub's
      // whole GRANT ROW with it, not just its pointer; the dedupe and the
      // entity_id move below then find nothing left to move and report nothing,
      // and the sub silently loses the files this merge has just carried into
      // the survivor's folder. So: repoint BEFORE the DELETE.
      //
      // Only folder_id moves. The dual-written `folder` STRING is deliberately
      // left alone: it is part of UNIQUE (sub_id, entity_type, entity_id,
      // folder), and rewriting it could collide with a grant the source already
      // holds — a unique violation in here aborts the ENTIRE merge, which is far
      // worse than a stale string. Nothing is lost by leaving it, because both
      // portal doors match ADDITIVELY on purpose: sub-portal-routes.js joins on
      // `a.folder = g.folder OR (g.folder_id IS NOT NULL AND a.folder_id =
      // g.folder_id)` and checks access with `g.folder = $4 OR LOWER(ff.path) =
      // $4`, whose own comment says the OR is there to keep a folder_id-backed
      // grant working when the string has drifted. This is that case.
      //
      // No org predicate, consistently with the two grant statements below:
      // attachment_folder_grants has no organization_id column (TENANT_LESS),
      // and f.id is itself the tenant proof — f came from the org-predicated
      // read at the top of this loop.
      await db.query(
        'UPDATE attachment_folder_grants SET folder_id = $1 WHERE folder_id = $2',
        [twin.id, f.id]);
      await db.query(
        'DELETE FROM file_folders WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
        [f.id, orgId]);
      bump(also, 'file_folders_folded', 1);
    } else {
      await db.query(
        'UPDATE file_folders SET entity_id = $1, updated_at = NOW() WHERE id = $2 AND (organization_id = $3 OR organization_id IS NULL)',
        [dst, f.id, orgId]);
      bump(also, 'file_folders', 1);
    }
  }

  // With the bound above derived from the row count, the loop has exactly one
  // remaining way to stop with work left: a folder CYCLE, where every remaining
  // source folder is parented by another of them, so `find` has nothing it can
  // resolve first. services/file-folders.js refuses to build one, so this
  // should be unreachable — but "should be unreachable" is not a reason to fall
  // through to a DELETE that strands these rows on a dead id, and by this point
  // their attachments have already been repointed into the survivor. There is
  // no repair that is obviously the user's intent, and a silent partial is the
  // one outcome the rest of this file is careful never to produce, so refuse:
  // the route wraps this in BEGIN/ROLLBACK, so every statement above is undone.
  const stray = await db.query(
    "SELECT id FROM file_folders WHERE entity_type = 'client' AND entity_id = $1 AND (organization_id = $2 OR organization_id IS NULL)",
    [src, orgId]);
  if (stray.rows.length) {
    return {
      refused: 'That client\'s folder tree is malformed — a folder is its own ancestor — so its filed documents cannot be refiled under the survivor. Fix the folder tree first, then merge.',
      status: 409
    };
  }

  // Sub folder grants are UNIQUE (sub_id, entity_type, entity_id, folder). A
  // grant the survivor already has is the SAME FACT — same sub, same folder —
  // so the source's copy is dropped rather than moved into a constraint
  // violation. Nothing is lost: the sub keeps the access.
  // No organization_id column (TENANT_LESS); scoped by the entity pair.
  await db.query(
    `DELETE FROM attachment_folder_grants
      WHERE entity_type = 'client' AND entity_id = $1
        AND EXISTS (SELECT 1 FROM attachment_folder_grants g2
                     WHERE g2.entity_type = 'client' AND g2.entity_id = $2
                       AND g2.sub_id = attachment_folder_grants.sub_id
                       AND g2.folder = attachment_folder_grants.folder)`,
    [src, dst]);
  bump(also, 'attachment_folder_grants', (await db.query(
    "UPDATE attachment_folder_grants SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2",
    [dst, src])).rowCount);

  // One LIVE room per entity (idx_live_rooms_one_live_per_entity, partial on
  // ended_at IS NULL AND revoked_at IS NULL). If the survivor is already
  // broadcasting, the source's live room is ENDED before it moves — ended
  // rows fall outside the partial index, so both can sit on the survivor and
  // nothing is deleted. Leaving the row where it was is the one option that
  // is not available: the client it names is about to stop existing.
  const survivorLive = await db.query(
    `SELECT 1 FROM live_rooms
      WHERE entity_type = 'client' AND entity_id = $1 AND ended_at IS NULL AND revoked_at IS NULL
        AND (organization_id = $2 OR organization_id IS NULL)`,
    [dst, orgId]);
  if (survivorLive.rows.length) {
    await db.query(
      `UPDATE live_rooms SET ended_at = NOW()
        WHERE entity_type = 'client' AND entity_id = $1 AND ended_at IS NULL AND revoked_at IS NULL
          AND (organization_id = $2 OR organization_id IS NULL)`,
      [src, orgId]);
  }
  bump(also, 'live_rooms', (await db.query(
    "UPDATE live_rooms SET entity_id = $1 WHERE entity_type = 'client' AND entity_id = $2 AND (organization_id = $3 OR organization_id IS NULL)",
    [dst, src, orgId])).rowCount);

  // ── 6. the source goes last ─────────────────────────────────────────────
  const gone = await db.query(
    'DELETE FROM clients WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
    [src, orgId]);
  if (!gone.rowCount) return { refused: 'Client not found.', status: 404 };

  return {
    moved,
    also,
    filled,
    survivor: { id: dst, name: str(survivor.name) },
    source: { id: src, name: str(source.name) }
  };
}

module.exports = { mergeClients, EDITABLE_FIELDS, IDENTITY_FIELDS, FILL_FIELDS, TENANT_LESS, POLY_TENANTED, PLAIN, POLYMORPHIC };
