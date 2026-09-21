'use strict';
// ── BUILDERTREND → PROJECT 86 SYNC PREVIEW ────────────────────────────────
//
// READ-ONLY toward Project 86's records. This module issues SELECTs against the
// P86 database and GETs against Clickr. It stamps no audit row, geocodes
// nothing, and changes no job, lead, client, change order or purchase order.
// What a proposal may contain is enforced in ./bt-match.js.
//
// ITS OWN MEMORY — the one write. To mark what is NEW or CHANGED in
// Buildertrend since the viewing admin's previous refresh (./since-refresh.js),
// a refresh remembers Buildertrend's values in bt_record_snapshots (only for a
// dataset whose read was complete) and that admin's refresh time in
// bt_preview_views. Both are keyed on this organization; neither holds a P86
// value. A failure there never breaks the preview — the dataset just says it
// could not be compared.
//
// ── WHO MAY SEE IT ───────────────────────────────────────────────────────
// CLICKR_API_KEY is ONE global env var belonging to AG Exteriors' Buildertrend
// account. Two gates, both required:
//   1. ROLES_MANAGE — the host route's own middleware, before this code runs;
//   2. the caller's organisation IS the organisation the key belongs to, named
//      by slug in CLICKR_ORG_SLUG (default 'agx', the slug server/db.js seeds for
//      AGX). req.organization comes from requireOrg, which loaded it from the
//      VERIFIED user's organization_id; nothing from the request is consulted.
// SYSTEM_ADMIN buys nothing: a platform owner in another tenant is refused.
//
// ── THE P86 SIDE IS THAT ORGANISATION, EXACTLY ────────────────────────────
// Every SELECT below is `organization_id = $1`, including both JOINs (a lead
// whose salesperson or client belongs to another tenant reads as blank here,
// never as that tenant's name). Rows with NO organization are COUNTED and never
// matched — the job list route includes them (job-routes.js), and this preview
// deliberately does not.
//
// ── HOW IT IS REACHED ────────────────────────────────────────────────────
// A MODE of GET /api/admin/organizations/me (?view=buildertrend-preview), not a
// route of its own, so test/tenant-register2-http.test.js's committed route
// census does not move. Without the parameter /me answers exactly what it did.

const { DATASETS, readRecord, describeMapping } = require('./field-map');
const { fetchDataset, MIN_KEY_LENGTH } = require('./client');
const match = require('./bt-match');
const coMatch = require('./co-match');
const poMatch = require('./po-match');
const billMatch = require('./bill-match');
const estimateMatch = require('./estimate-match');
const taskMatch = require('./task-match');
// The ONE spelling of "not a work-order building", so this list is held to the
// same wording as every other (test/work-order-task-read-ledger.test.js). The
// scope = 'org' predicate beside it already rules out the personal arm, so this
// adds no rows — it adds the shared sentence.
const subtaskDoor = require('../service-ticket-subtask-door');
const coMoney = require('../money/change-order-totals');
const since = require('./since-refresh');
const btMarket = require('./bt-market');

const VIEW_PARAM = 'buildertrend-preview';

function ownerSlug(env) {
  const s = String((env && env.CLICKR_ORG_SLUG) || '').trim();
  return s || 'agx';
}

function parseJsonish(v) {
  if (v == null) return null;
  if (typeof v === 'string') { try { return JSON.parse(v); } catch (e) { return null; } }
  return v;
}

// Approved change-order money per P86 job, computed exactly as the WIP rollup
// computes it: server/services/money/change-order-totals.js — table rows win
// outright; a job with NO table rows falls back to its legacy data.changeOrders
// list; only approved/applied table rows count.
function changeOrderTotals(jobRows, coRows) {
  const byJob = new Map();
  for (const r of coRows) {
    if (!byJob.has(r.job_id)) byJob.set(r.job_id, []);
    byJob.get(r.job_id).push(r);
  }
  const out = new Map();
  for (const j of jobRows) {
    const tableRows = byJob.get(j.id) || [];
    try {
      if (tableRows.length) {
        const shaped = tableRows.map((r) => coMoney.shapeChangeOrderRow(Object.assign({}, r, { data: parseJsonish(r.data) || {} })));
        out.set(j.id, { computable: true, count: shaped.length, total: shaped.reduce((s, x) => s + (x.counted ? x.income : 0), 0),
          source: 'approved and applied change orders in P86 (' + shaped.filter((x) => x.counted).length + ' of ' + shaped.length + ')' });
      } else {
        const legacy = parseJsonish(j.legacy_cos);
        const list = Array.isArray(legacy) ? legacy : [];
        const shaped = list.map(coMoney.shapeLegacyChangeOrder);
        out.set(j.id, { computable: true, count: shaped.length, total: shaped.reduce((s, x) => s + x.income, 0),
          source: list.length ? 'the job\'s legacy change-order list (' + list.length + ')' : 'no change orders in P86' });
      }
    } catch (e) {
      out.set(j.id, { computable: false, count: tableRows.length, total: null, source: '',
        why: 'P86\'s change-order total for this job could not be computed read-only.' });
    }
  }
  return out;
}

// Every jobs.data key bt-match's p86JobView reads. A key missing here reaches
// the matcher as '' — which is how data.btStatus went unread and every
// linked job looked permanently 'status word due', and how a custom field
// P86 already holds would be offered as a blank to fill. Keys are
// constants; they are spliced into the SELECT below.
const JOB_KEYS = ['jobNumber', 'title', 'name', 'status', 'street_address', 'city', 'state', 'zip', 'startDate', 'contractAmount', 'btStatus']
  .concat(match.JOB_CUSTOM_FIELDS.map((f) => f.key));

// P86 side. SELECT only, every statement `organization_id = $1`.
async function readP86(pool, orgId) {
  const jobsRaw = await pool.query(
    'SELECT id, ' + JOB_KEYS.map((k) => "data->>'" + k + "' AS \"" + k + '"').join(', ')
    + ", data->'changeOrders' AS legacy_cos, data->'purchaseOrders' AS legacy_pos, bt_job_id, geocode_lat, geocode_lng, geocode_status, market_id FROM jobs WHERE organization_id = $1 AND bt_archived_at IS NULL", [orgId]);
  const jobRows = jobsRaw.rows.map((r) => ({ id: r.id, legacy_cos: r.legacy_cos, legacy_pos: r.legacy_pos, bt_job_id: r.bt_job_id,
    geocode_lat: r.geocode_lat, geocode_lng: r.geocode_lng, geocode_status: r.geocode_status, market_id: r.market_id,
    data: Object.fromEntries(JOB_KEYS.map((k) => [k, r[k] == null ? '' : r[k]])) }));
  const leads = await pool.query(
    'SELECT l.id, l.title, l.status, l.street_address, l.city, l.state, l.zip, l.source, l.confidence, '
    + 'l.estimated_revenue_low, l.estimated_revenue_high, l.bt_lead_id, l.notes, '
    // Converted = the lead <-> job link on EITHER side (jobs.lead_id or
    // leads.job_id), and only through a job of THIS organization: another
    // tenant's job naming this lead, or this lead naming another tenant's job,
    // does not mark it converted. leads.job_id itself is never read raw.
    + 'EXISTS (SELECT 1 FROM jobs j WHERE (j.lead_id = l.id OR j.id = l.job_id) AND j.organization_id = $1) AS has_job, '
    + 'u.name AS salesperson_name, c.name AS client_name '
    + 'FROM leads l '
    + 'LEFT JOIN users u ON u.id = l.salesperson_id AND u.organization_id = $1 '
    + 'LEFT JOIN clients c ON c.id = l.client_id AND c.organization_id = $1 '
    + 'WHERE l.organization_id = $1 AND l.bt_archived_at IS NULL', [orgId]);
  // Change orders reached through THEIR JOB's organization AND their own: a row
  // stamped with another organization is never read (even on this org's job),
  // and an older row with no organization is — missing it would read its
  // Buildertrend twin as "new" and create a duplicate.
  const cos = await pool.query(
    'SELECT co.id, co.job_id, co.status, co.co_number, co.data, co.is_locked, co.linked_node_id, co.bt_co_id '
    + 'FROM job_change_orders co JOIN jobs j ON j.id = co.job_id '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (co.organization_id = $1 OR co.organization_id IS NULL)', [orgId]);
  // Purchase orders on the same terms as change orders, with what is already
  // billed against each (a Buildertrend cost is never set below it), the
  // sub's name only when the sub is this organization's, and whether that sub
  // already has portal access to the job's files (its job assignment AND the
  // job folder grant — what services/po-sub-access.js writes).
  const pos = await pool.query(
    'SELECT po.id, po.job_id, po.status, po.po_number, po.data, po.is_locked, po.sub_id, po.bt_po_id, s.name AS sub_name, '
    + "(SELECT COALESCE(SUM(b.amount), 0) FROM job_vendor_bills b WHERE b.po_id = po.id AND b.status <> 'void') AS billed, "
    + '(EXISTS (SELECT 1 FROM job_subs js WHERE js.job_id = po.job_id AND js.sub_id = po.sub_id) '
    + "AND EXISTS (SELECT 1 FROM attachment_folder_grants g WHERE g.sub_id = po.sub_id AND g.entity_type = 'job' AND g.entity_id = po.job_id AND g.folder = 'general')) AS sub_access "
    + 'FROM job_purchase_orders po JOIN jobs j ON j.id = po.job_id LEFT JOIN subs s ON s.id = po.sub_id AND s.organization_id = $1 '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (po.organization_id = $1 OR po.organization_id IS NULL)', [orgId]);
  // Vendor bills on exactly the same terms as purchase orders: reached through
  // THEIR JOB's organization AND their own, so a row stamped with another
  // organization is never read (even on this org's job) and an older row with no
  // organization still is — missing it would read its Buildertrend twin as "new"
  // and create a duplicate payable. The purchase order is joined on the SAME JOB
  // (bill-routes.js refuses a bill whose PO is on another job), which scopes it
  // without a tolerance arm of its own.
  const bills = await pool.query(
    'SELECT b.id, b.job_id, b.status, b.bill_number, b.amount, b.bill_date, b.due_date, b.data, b.po_id, b.sub_id, b.bt_bill_id, '
    + 's.name AS sub_name, po.po_number AS po_number '
    + 'FROM job_vendor_bills b JOIN jobs j ON j.id = b.job_id '
    + 'LEFT JOIN subs s ON s.id = b.sub_id AND s.organization_id = $1 '
    + 'LEFT JOIN job_purchase_orders po ON po.id = b.po_id AND po.job_id = b.job_id '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (b.organization_id = $1 OR b.organization_id IS NULL)', [orgId]);
  // ESTIMATES, in two statements because an estimate can be reached two ways
  // and each way has its own tenancy.
  //
  //   (a) filed under a job of this organization (estimates.attached_job_id).
  //       Reached through THEIR JOB’s organization AND their own, exactly as
  //       change orders, purchase orders and bills are: a row stamped with
  //       another organization is never read even on this org’s job, and an
  //       older row with no organization still is — missing it would read its
  //       Buildertrend worksheet as "new" and create a duplicate PROPOSAL.
  //
  //   (b) already linked by this sync but no longer filed under any job
  //       (attached_job_id went NULL when the job was deleted). There is no job
  //       to reach it through, so this one carries NO tolerance arm: with no
  //       parent there is nothing to scope an org-NULL row by, and none can
  //       exist — every estimate this sync creates is stamped from its job’s
  //       organization (sync-apply.js createEstimate), so a row carrying a
  //       bt_worksheet_id always carries an organization too.
  const estsOnJob = await pool.query(
    'SELECT e.id, e.attached_job_id, e.bt_worksheet_id, e.data, e.is_locked, e.sent_at, e.sent_count, '
    + 'e.approval_status, e.accepted_at, e.approved_at, e.declined_at '
    + 'FROM estimates e JOIN jobs j ON j.id = e.attached_job_id '
    + 'WHERE j.organization_id = $1 AND j.bt_archived_at IS NULL AND (e.organization_id = $1 OR e.organization_id IS NULL)', [orgId]);
  const estsLoose = await pool.query(
    'SELECT e.id, e.attached_job_id, e.bt_worksheet_id, e.data, e.is_locked, e.sent_at, e.sent_count, '
    + 'e.approval_status, e.accepted_at, e.approved_at, e.declined_at '
    + 'FROM estimates e WHERE e.organization_id = $1 AND e.bt_worksheet_id IS NOT NULL AND e.attached_job_id IS NULL', [orgId]);
  // ORG TASKS FILED UNDER A JOB. No tolerance arm: tasks.organization_id is
  // NOT NULL, so there is no older row carrying none and an `OR IS NULL` here
  // would be a door with nothing behind it. This organisation appears in the
  // SAME literal three times — the task's own column, its job's, and the
  // assignee join — so a task of another tenant, a task on another tenant's
  // job, and another tenant's user as a name are all unreachable.
  //
  // A task reaches its job through the POLYMORPHIC entity_type/entity_id pair,
  // not a job_id column, which is why entity_type = 'job' is pinned and
  // entity_id is aliased job_id for the matcher.
  //
  // TWO EXCLUSIONS, BOTH LOAD-BEARING:
  //   * scope = 'org'. A 'personal' row is a private To-do belonging to
  //     owner_user_id and visible to nobody else; it is not an org task, an
  //     imported task is never one, and this sync neither reads nor writes one.
  //   * service_ticket_id IS NULL. A task carrying one is a WORK-ORDER
  //     BUILDING, not a to-do: it lives on its service ticket, it is finished
  //     there under the photo rule, and completing one moves the TICKET through
  //     services/service-ticket-subtask-door.js — a door a write from this sync
  //     would walk straight past. Excluded HERE, in the read, so a building can
  //     never be a candidate, a match or a write target anywhere downstream.
  //
  // ARCHIVED TASKS ARE DELIBERATELY INCLUDED. Every other read in this file
  // hides archived rows; this one must not. A task a person archived is still
  // the P86 twin of its Buildertrend to-do, and hiding it would make that to-do
  // read as NEW and create a second copy of the thing somebody put away.
  // task-match.js locks it instead: shown, matched, and never written.
  const tasks = await pool.query(
    'SELECT t.id, t.title, t.notes, t.status, t.priority, t.kind, t.due_date, t.completed_at, t.archived_at, '
    + 't.assignee_user_id, t.entity_id AS job_id, t.bt_task_id, t.bt_task_status, t.bt_synced_at, t.updated_at, '
    + 'u.name AS assignee_name '
    + 'FROM tasks t JOIN jobs j ON j.id = t.entity_id '
    + 'LEFT JOIN users u ON u.id = t.assignee_user_id AND u.organization_id = $1 '
    + "WHERE t.organization_id = $1 AND j.organization_id = $1 AND j.bt_archived_at IS NULL "
    + "AND t.entity_type = 'job' AND t.scope = 'org' AND " + subtaskDoor.notAWorkOrderBuildingSql('t'), [orgId]);
  const subs = await pool.query("SELECT id, name FROM subs WHERE organization_id = $1 AND COALESCE(status, 'active') <> 'closed'", [orgId]);
  const users = await pool.query(
    'SELECT id, name FROM users WHERE organization_id = $1 AND active = true', [orgId]);
  const clients = await pool.query(
    // The custom-field columns ride along: bt-match's p86ClientView reads every
    // one of them, and a column not selected here reads as blank — which would
    // offer a 'fill' over a value P86 already holds.
    'SELECT id, name, first_name, last_name, email, phone, cell, address, city, state, zip, parent_client_id, bt_contact_id, '
    + 'company_name, community_name, gate_code, community_manager, cm_phone, cm_email, additional_pocs, property_address, property_phone, website, maintenance_manager, mm_phone, mm_email, market_id '
    + 'FROM clients WHERE organization_id = $1 AND bt_archived_at IS NULL', [orgId]);
  // Rows with no organization: all rows minus the rows that carry one. Counted,
  // never read — no id, title or value of theirs is selected.
  // The market dimension and the organisation's Buildertrend Market mapping
  // (bt-market.js). Read here so apply, which re-runs this, sees the same.
  const marketRows = await pool.query('SELECT id, name, active FROM markets WHERE organization_id = $1 ORDER BY sort, name', [orgId]);
  const orgRow = await pool.query('SELECT settings FROM organizations WHERE id = $1', [orgId]);
  const market = btMarket.contexts(marketRows.rows, orgRow.rows[0] ? orgRow.rows[0].settings : null);
  const orphanJobs = await pool.query('SELECT COUNT(*) - COUNT(organization_id) AS n FROM jobs');
  const orphanLeads = await pool.query('SELECT COUNT(*) - COUNT(organization_id) AS n FROM leads');
  return {
    jobs: jobRows,
    leads: leads.rows,
    coTotals: changeOrderTotals(jobRows, cos.rows),
    coRows: cos.rows,
    poRows: pos.rows,
    billRows: bills.rows,
    estimateRows: estsOnJob.rows.concat(estsLoose.rows),
    taskRows: tasks.rows,
    subs: subs.rows,
    directory: { users: users.rows.map((r) => ({ id: r.id, name: r.name })), clients: clients.rows.map((r) => ({ id: r.id, name: r.name })) },
    clients: clients.rows,
    market,
    unscopedJobs: Number((orphanJobs.rows[0] && orphanJobs.rows[0].n) || 0),
    unscopedLeads: Number((orphanLeads.rows[0] && orphanLeads.rows[0].n) || 0),
  };
}

function fetchedSentence(ds, fr) {
  if (fr.error) return fr.error.message;
  // Estimates are counted in LINE ITEMS, because that is what Clickr sends:
  // one record is one line of a worksheet, and saying "277 estimates" for 277
  // lines would be a confident wrong answer about the size of the job.
  const noun = ds.key === 'estimates' ? 'estimate line items' : ds.label.toLowerCase();
  const of = fr.reportedCount != null ? ' of ' + fr.reportedCount : '';
  if (fr.complete) {
    return 'Fetched ' + fr.fetched + of + ' ' + noun + ' in ' + fr.pages + ' page' + (fr.pages === 1 ? '' : 's') + ' — every record Clickr reported.';
  }
  return 'PARTIAL READ: fetched ' + fr.fetched + of + ' ' + noun + '. ' + String(fr.reason || 'The read did not complete').replace(/^./, (x) => x.toUpperCase()).replace(/\.?$/, '.')
    + ' Every count below covers only the records fetched.';
}

function notInBtSentence(ds, reliable, fr, p86Error, n, notListed) {
  const noun = ds.label.toLowerCase();
  const extra = ds.key === 'jobs'
    ? ' Only active P86 jobs are listed; ' + notListed + ' Completed or Archived P86 jobs no Buildertrend row reached are not.'
    : ds.key === 'clients'
    ? ' Buildertrend\'s client contacts are its whole directory, so every such P86 client and property is listed.'
    : ds.key === 'changeOrders'
    ? ' Only change orders on P86 jobs whose Buildertrend job sent change orders in this read are listed; ' + notListed + ' on other jobs are not (Clickr\'s change-order dataset covers open jobs only).'
    : ds.key === 'purchaseOrders'
    ? ' Only purchase orders on P86 jobs whose Buildertrend job sent purchase orders in this read are listed; ' + notListed + ' on other jobs are not (Clickr\'s purchase-order dataset covers open jobs only).'
    : ds.key === 'estimates'
    ? ' Only estimates filed under a P86 job whose Buildertrend job sent estimate lines in this read are listed; ' + notListed
      + ' on other jobs, and every estimate that belongs to a lead rather than a job, are not.'
      + ' A P86 estimate nothing in Buildertrend reached is expected: P86 writes proposals Buildertrend never sees. Nothing is proposed for deletion.'
    : ds.key === 'tasks'
    ? ' Only org tasks filed under a P86 job whose Buildertrend job sent tasks in this read are listed; ' + notListed
      + ' on other jobs are not. Private To-dos and work-order buildings are not tasks this sync reads at all.'
      + ' A P86 task nothing in Buildertrend reached is expected: P86 writes tasks Buildertrend never sees. Nothing is proposed for deletion, and a sync never archives one.'
    : ds.key === 'bills'
    ? ' Only bills on P86 jobs whose Buildertrend job sent bills in this read are listed; ' + notListed + ' on other jobs are not (Clickr\'s bills dataset covers open jobs only).'
      + ' A P86 bill nothing in Buildertrend reached is expected: P86 records bills Buildertrend never sees. Nothing is proposed for deletion, and a sync never voids one.'
    : ' Only open P86 leads are listed; ' + notListed + ' sold, lost or no-opportunity leads are expected to be absent (Buildertrend\'s Leads dataset holds open leads only).'
      // The mark itself is gated on a COMPLETE read (bt-match.js
      // notInBuildertrend), so after a partial one this must not describe a
      // convention that is not in force: an unmarked lead would read as "still
      // open in Buildertrend", which is the one conclusion that cannot be drawn.
      + (reliable
        ? ' One that carries a Buildertrend lead id is marked: Buildertrend sold, lost or closed it, so it left that open list. Nothing is proposed for it.'
        : ' No lead is marked as having left that open list: this Buildertrend read did not reach every record, so an id missing from it may sit in the part never fetched.');
  const base = n + ' Project 86 ' + noun + ' were not reached by any Buildertrend record. Review only — nothing is proposed for deletion.' + extra;
  if (reliable) return base;
  return base + ' NOT RELIABLE: ' + (p86Error ? 'Project 86 could not be read completely' : 'Buildertrend\'s read could not be confirmed complete (fetched ' + fr.fetched
    + (fr.reportedCount != null ? ' of ' + fr.reportedCount : ', count unconfirmed') + (fr.reason ? ' — ' + fr.reason : '') + ')')
    + ', so some of these may be in the part that was not read. Do not act on this list.';
}

// The one place a dataset's records meet its matcher; Apply re-runs the same.
function matchRows(kind, values, p86) {
  if (kind === 'jobs') return match.matchJobs(values, p86.jobs, { coTotals: p86.coTotals, market: p86.market && p86.market.jobs });
  if (kind === 'clients') return match.matchClients(values, p86.clients || [], { market: p86.market && p86.market.clients });
  if (kind === 'changeOrders') return coMatch.matchChangeOrders(values, { jobs: p86.jobs, coRows: p86.coRows || [] });
  if (kind === 'purchaseOrders') return poMatch.matchPurchaseOrders(values, { jobs: p86.jobs, poRows: p86.poRows || [], subs: p86.subs || [] });
  // Bills need poRows too: a bill's purchase order is resolved ONLY through the
  // bt_po_id a P86 purchase order already carries.
  if (kind === 'bills') return billMatch.matchBills(values, { jobs: p86.jobs, billRows: p86.billRows || [], poRows: p86.poRows || [], subs: p86.subs || [] });
  // Estimates are the one dataset whose RECORDS are not the rows: a record is
  // one LINE, and matchEstimates groups them into worksheets itself.
  if (kind === 'estimates') return estimateMatch.matchEstimates(values, { jobs: p86.jobs, estimateRows: p86.estimateRows || [] });
  // Tasks need the USER DIRECTORY too: a Buildertrend assignee is a NAME and
  // P86's assignee_user_id is a real foreign key, so the only way from one to
  // the other is this organisation's own active users, read WHERE
  // organization_id = the caller's (see readP86 above).
  if (kind === 'tasks') return taskMatch.matchTasks(values, { jobs: p86.jobs, taskRows: p86.taskRows || [], users: (p86.directory && p86.directory.users) || [] });
  return match.matchLeads(values, p86.leads, { directory: p86.directory });
}

const PREVIEW_KINDS = ['jobs', 'leads', 'clients', 'changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks'];

function buildDataset(kind, fr, p86, p86Error) {
  const ds = DATASETS[kind];
  const out = {
    key: kind, label: ds.label, datasetId: ds.datasetId,
    fetch: { fetched: fr.fetched, reportedCount: fr.reportedCount, pages: fr.pages, mode: fr.mode,
      complete: fr.complete, reason: fr.reason, elapsedMs: fr.elapsedMs },
    error: fr.error ? { kind: fr.error.kind, message: fr.error.message } : null,
    sentence: fetchedSentence(ds, fr),
    mapping: null, classified: false, summary: null, summaryOpen: null, rows: [], notInBuildertrend: null,
  };
  if (fr.error) return out;
  out.mapping = describeMapping(kind, fr.records);
  if (fr.fetched === 0) {
    out.error = { kind: 'empty', message: 'Clickr returned zero ' + ds.label.toLowerCase() + ' records. That is not "no matches" — there was nothing to compare.' };
    return out;
  }
  if (out.mapping.refusal) {
    out.error = { kind: 'mapping', message: out.mapping.refusal };
    return out;
  }
  if (p86Error) {
    out.error = { kind: 'p86_read', message: p86Error };
    return out;
  }
  const values = fr.records.map((r) => readRecord(kind, r));
  const rows = matchRows(kind, values, p86);
  const nib = kind === 'changeOrders'
    ? coMatch.notInBuildertrend(rows, values, p86)
    : kind === 'purchaseOrders'
    ? poMatch.notInBuildertrend(rows, values, p86)
    : kind === 'bills'
    ? billMatch.notInBuildertrend(rows, values, p86)
    : kind === 'estimates'
    ? estimateMatch.notInBuildertrend(rows, values, p86)
    : kind === 'tasks'
    ? taskMatch.notInBuildertrend(rows, values, p86)
    // readComplete: a P86 lead is called "no longer an open lead in Buildertrend"
    // only when the Buildertrend read reached every record. After a partial read
    // its Buildertrend lead may simply be in the part never fetched.
    : match.notInBuildertrend(rows, kind === 'jobs' ? p86.jobs : kind === 'clients' ? (p86.clients || []) : p86.leads, kind,
      { readComplete: fr.complete === true });
  const reliable = fr.complete === true && !p86Error;
  out.classified = true;
  out.rows = rows;
  out.summary = match.summarise(rows);
  // What each Buildertrend Market option seems to mean, from the records
  // already linked, for a person to map (bt-market.js).
  if ((kind === 'jobs' || kind === 'clients') && p86.market) out.marketOptions = btMarket.evidence(rows, p86.market[kind]);
  if (kind === 'jobs') out.summaryOpen = match.summarise(rows, (r) => r.bt.scope === 'open');
  out.notInBuildertrend = {
    reliable, count: nib.rows.length, notListed: nib.notListed,
    sentence: notInBtSentence(ds, reliable, fr, p86Error, nib.rows.length, nib.notListed),
    rows: nib.rows,
  };
  return out;
}

const KEY_WINDOW = 12;
const ENCODED_WINDOW = 16;

function windows(s, n) {
  const out = new Set();
  for (let i = 0; i + n <= s.length; i++) out.add(s.slice(i, i + n));
  return out;
}

// What a leaked key could look like inside the response, all lower-cased:
//   * its first and last 8 characters (any longer prefix or suffix contains them);
//   * ANY 12 consecutive characters of it (a middle chunk, a truncated copy);
//   * any 16 consecutive characters of it base64 / base64url encoded (at each of
//     the three byte alignments), hex encoded, URL encoded, JSON- or \u-escaped.
function keyNeedles(apiKey) {
  const key = String(apiKey || '').trim();
  const low = key.toLowerCase();
  const encoded = [];
  const buf = Buffer.from(key, 'utf8');
  for (let pad = 0; pad < 3; pad++) {
    const b64 = Buffer.concat([Buffer.alloc(pad), buf]).toString('base64');
    // Drop the characters the padding bytes and the tail touch.
    const mid = b64.slice(Math.ceil((pad * 4) / 3) + 1, b64.length - 4);
    encoded.push(mid, mid.replace(/\+/g, '-').replace(/\//g, '_'));
  }
  encoded.push(buf.toString('hex'), encodeURIComponent(key), JSON.stringify(key).slice(1, -1),
    key.split('').map((ch) => '\\u' + ch.charCodeAt(0).toString(16).padStart(4, '0')).join(''));
  const enc = new Set();
  for (const e of encoded) for (const w of windows(e.toLowerCase(), ENCODED_WINDOW)) enc.add(w);
  return { fixed: [low.slice(0, 8), low.slice(-8)], keyWindows: windows(low, KEY_WINDOW), encWindows: enc };
}

function stringCarries(s, n) {
  const t = s.toLowerCase();
  if (n.fixed.some((x) => t.includes(x))) return true;
  for (let i = 0; i + KEY_WINDOW <= t.length; i++) if (n.keyWindows.has(t.slice(i, i + KEY_WINDOW))) return true;
  for (let i = 0; i + ENCODED_WINDOW <= t.length; i++) if (n.encWindows.has(t.slice(i, i + ENCODED_WINDOW))) return true;
  return false;
}

// Every string in the body — keys and values — checked for the key in any of
// the forms above. A key shorter than MIN_KEY_LENGTH is refused before any
// request (client.js), and is treated here as carried: the check cannot work
// on it, so it fails closed.
function carriesKey(body, apiKey) {
  const key = String(apiKey || '').trim();
  if (!key) return false;
  if (key.length < MIN_KEY_LENGTH) return true;
  const n = keyNeedles(key);
  const seen = new Set();
  const stack = [body];
  while (stack.length) {
    const v = stack.pop();
    if (typeof v === 'string') {
      if (stringCarries(v, n)) return true;
    } else if (v && typeof v === 'object') {
      if (seen.has(v)) continue;
      seen.add(v);
      for (const [k, x] of Object.entries(v)) {
        if (stringCarries(k, n)) return true;
        stack.push(x);
      }
    }
  }
  return false;
}

// "New / changed since your last refresh" for every dataset whose Clickr read
// was complete and classified. Returns whether any such dataset existed (the
// only case in which the caller moves the user's refresh marker).
async function markSinceRefresh(org, deps, datasets, reads, ctx) {
  const complete = PREVIEW_KINDS.filter((k) => {
    const fr = reads[k];
    const ds = datasets[k];
    return fr && !fr.error && fr.complete === true && ds && ds.classified === true && !ds.error;
  });
  for (const k of PREVIEW_KINDS) {
    if (complete.indexOf(k) !== -1) continue;
    const ds = datasets[k];
    if (ctx.ready && ds && ds.classified) {
      ds.since = { compared: false, partial: true, previousRefreshAt: ctx.previous ? ctx.previous.toISOString() : null,
        newCount: 0, changedCount: 0, removed: [], removedTotal: 0, note: since.PARTIAL_NOTE };
    } else if (ctx.userId != null && ds && ds.classified) {
      ds.since = { unavailable: true };
    }
  }
  if (!complete.length) return false;
  if (!ctx.ready) {
    for (const k of complete) datasets[k].since = { unavailable: true };
    return true;
  }
  const snaps = {};
  for (const k of complete) {
    // ONE SNAPSHOT PER THING A ROW IS, which for every dataset but estimates is
    // one per record. An estimates record is a LINE, and the rows are
    // WORKSHEETS, so since-refresh groups them: keyed on a line's id nothing
    // would ever line up with a row and no worksheet could be marked at all.
    snaps[k] = since.snapshotRecords(k, (reads[k].records || []).map((r) => readRecord(k, r)));
  }
  // Nothing carrying the key is ever stored: the same check the response gets.
  if (carriesKey(snaps, ctx.apiKey)) throw Object.assign(new Error('withheld'), { keyLeak: true });
  for (const k of complete) {
    try {
      const synced = await since.syncSnapshots(deps.pool, org.id, k, snaps[k], ctx.refreshAt);
      datasets[k].since = since.markDataset(k, datasets[k].rows, synced, ctx.previous);
    } catch (e) {
      console.error('[clickr-preview] Buildertrend records could not be remembered; this dataset is not compared with the last refresh');
      for (const row of datasets[k].rows || []) delete row.since;
      datasets[k].since = { unavailable: true };
    }
  }
  return true;
}

async function buildPreview(org, deps) {
  const env = deps.env || process.env;
  const apiKey = env.CLICKR_API_KEY ? String(env.CLICKR_API_KEY).trim() : '';
  const started = (deps.now || Date.now)();

  // The viewing admin's previous refresh. No user, or an unreadable marker:
  // nothing is marked and the marker is not moved.
  const userId = deps.user && deps.user.id != null ? deps.user.id : null;
  let previous = null;
  let sinceReady = false;
  if (userId != null) {
    try {
      previous = await since.readLastRefresh(deps.pool, org.id, userId);
      sinceReady = true;
    } catch (e) {
      console.error('[clickr-preview] the last refresh could not be read; nothing is marked new or changed');
    }
  }

  let p86;
  let p86Error = null;
  try {
    p86 = await readP86(deps.pool, org.id);
  } catch (e) {
    p86 = { jobs: [], leads: [], clients: [], coRows: [], poRows: [], billRows: [], estimateRows: [], subs: [], coTotals: new Map(), directory: { users: [], clients: [] }, unscopedJobs: 0, unscopedLeads: 0 };
    p86Error = 'Could not read Project 86\'s own jobs and leads, so nothing was classified.';
  }

  const common = { apiKey, transport: deps.transport, limits: deps.limits, now: deps.now, baseUrl: deps.baseUrl };
  const settled = await Promise.allSettled(PREVIEW_KINDS.map((k) =>
    fetchDataset(Object.assign({ datasetId: DATASETS[k].datasetId, label: DATASETS[k].label, idKey: DATASETS[k].idKey }, common))));
  const datasets = {};
  const reads = {};
  PREVIEW_KINDS.forEach((k, i) => {
    const s = settled[i];
    const fr = s.status === 'fulfilled' ? s.value : {
      records: [], fetched: 0, pages: 0, reportedCount: null, mode: null, complete: false, reason: null, elapsedMs: 0,
      error: { kind: 'internal', message: 'The ' + DATASETS[k].label + ' read failed inside this server before Clickr answered.' },
    };
    reads[k] = fr;
    datasets[k] = buildDataset(k, fr, p86, p86Error);
    if (fr && !fr.error && fr.complete === true) rememberFetch(org.id, k, fr, (deps.now || Date.now)());
  });

  // This refresh's instant: generatedAt, every snapshot time written now, and
  // the user's new marker. Never at or before the previous marker.
  let refreshAt = new Date();
  if (previous && refreshAt.getTime() <= previous.getTime()) refreshAt = new Date(previous.getTime() + 1);
  const anyComplete = userId != null
    ? await markSinceRefresh(org, deps, datasets, reads, { userId, ready: sinceReady, previous, refreshAt, apiKey })
    : false;

  const body = {
    readOnly: true,
    readOnlyNote: 'Preview only. Nothing is written to Project 86 or to Buildertrend.',
    direction: 'Buildertrend is the source of truth: every difference is shown as the correction Project 86 would receive. A blank in Buildertrend never overwrites a Project 86 value; money and job numbers are never auto-corrected; ambiguous matches propose nothing; nothing is proposed for deletion.',
    generatedAt: refreshAt.toISOString(),
    since: userId != null && sinceReady ? { previousRefreshAt: previous ? previous.toISOString() : null } : null,
    organization: { id: org.id, slug: org.slug, name: org.name },
    keyConfigured: !!apiKey,
    p86: { jobs: p86.jobs.length, leads: p86.leads.length, clients: (p86.clients || []).length, unscopedJobs: p86.unscopedJobs, unscopedLeads: p86.unscopedLeads, error: p86Error },
    markets: p86.market ? p86.market.list : [],
    datasets,
    elapsedMs: (deps.now || Date.now)() - started,
  };
  if (carriesKey(body, apiKey)) {
    throw Object.assign(new Error('withheld'), { keyLeak: true });
  }
  // Moved only once the response has passed the key check (a withheld preview
  // showed nobody any marks), only after a complete read, and not by the
  // page's own reload after an Apply (?since=keep): that
  // reload is not a refresh the admin asked for, and moving the marker would
  // wipe the marks they are working through.
  if (anyComplete && sinceReady && !deps.keepMarker) {
    try {
      await since.writeLastRefresh(deps.pool, org.id, userId, refreshAt);
    } catch (e) {
      console.error('[clickr-preview] the refresh time could not be saved');
    }
  }
  return body;
}

// Called from GET /api/admin/organizations/me AFTER requireAuth, requireOrg and
// requireCapability('ROLES_MANAGE') have all passed.
async function handle(req, res, deps) {
  const env = (deps && deps.env) || process.env;
  const org = req.organization;
  if (!org || org.id == null) {
    return res.status(403).json({ error: 'Buildertrend sync preview needs an organization.' });
  }
  if (String(org.slug || '') !== ownerSlug(env)) {
    return res.status(403).json({
      error: 'Buildertrend sync preview is not available for this organization. The Buildertrend connection on this server belongs to a different company.',
      code: 'CLICKR_NOT_THIS_ORG',
    });
  }
  // ONE build at a time on this server process. A build reads every Clickr page
  // and compares every record; a second admin (or a second tab) pressing Refresh
  // meanwhile gets a sentence instead of a second build.
  if (inFlight) {
    return res.status(429).json({ error: 'A Buildertrend preview is already being built on this server. Try Refresh again in a moment.', code: 'CLICKR_PREVIEW_BUSY' });
  }
  inFlight = true;
  try {
    // The viewing admin (requireAuth's verified token) owns the "since your
    // last refresh" marker; ?since=keep is the page's reload after an Apply.
    const body = await buildPreview(org, Object.assign({ env, user: req.user || null,
      keepMarker: !!(req.query && req.query.since === 'keep') }, deps));
    // 200 even when Clickr failed: the failure is a per-dataset sentence. A
    // Clickr 401 must never surface as OUR 401 — the client logs the admin out.
    res.set('Cache-Control', 'no-store');
    return res.json(body);
  } catch (e) {
    // Fixed sentences only: an exception message could carry anything.
    const leak = !!(e && e.keyLeak);
    console.error('[clickr-preview] ' + (leak ? 'response withheld: it contained the Clickr API key' : 'preview failed'));
    return res.status(500).json({ error: leak
      ? 'The Buildertrend preview was withheld because the response contained the Clickr API key.'
      : 'The Buildertrend preview failed inside this server.' });
  } finally {
    inFlight = false;
  }
}

// The last COMPLETE Clickr read per organization and dataset, kept briefly so
// Apply (sync-apply.js) right after a preview load does not re-read every
// page. Records only — never P86 data, never the key. Apply always re-reads
// P86 and re-runs the matcher; it drops this cache after any write.
const FETCH_TTL_MS = 5 * 60 * 1000;
const _fetches = new Map();
function rememberFetch(orgId, kind, fr, at) {
  _fetches.set(String(orgId) + ':' + kind, { at, fr });
}
function cachedFetch(orgId, kind, maxAgeMs, now) {
  const hit = _fetches.get(String(orgId) + ':' + kind);
  if (!hit) return null;
  const age = (now || Date.now)() - hit.at;
  return age >= 0 && age <= (maxAgeMs == null ? FETCH_TTL_MS : maxAgeMs) ? hit.fr : null;
}
function forgetFetch(orgId) {
  for (const k of [..._fetches.keys()]) if (k.startsWith(String(orgId) + ':')) _fetches.delete(k);
}

let inFlight = false;

module.exports = { PREVIEW_KINDS, handle, buildPreview, rememberFetch, cachedFetch, forgetFetch, readP86, matchRows, changeOrderTotals, ownerSlug, fetchedSentence, carriesKey, VIEW_PARAM };
