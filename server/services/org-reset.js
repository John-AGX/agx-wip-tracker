'use strict';
// ════════════════════════════════════════════════════════════════════
// ORG "CLEAN SLATE" — HARD DELETE leads + jobs + estimates + projects and
// every row of data attached to them, scoped to ONE organization, in a
// single transaction. Used by the system-admin Danger Zone to reset a
// workspace before re-seeding (e.g. backfilling active work from
// Buildertrend).
//
// ⚠ DESTRUCTIVE + PERMANENT. The caller's org snapshot is the only undo.
//
// WHAT IT DELETES
//   Anchors:  leads, jobs, estimates, projects (the org's rows).
//   FK-cascade children (auto-removed by Postgres on anchor delete):
//       jobs → job_access, node_graphs, job_change_orders,
//              job_purchase_orders, qb_cost_lines, schedule_entries,
//              job_workflow_items, JOB-scoped job_reports, (job_subs — also
//              explicit)
//       projects → project_pairs, project_activity
//   Polymorphic / non-FK "attached" rows (NO cascade — deleted explicitly,
//     keyed to the exact anchor IDs being removed):
//       attachments, file_folders, attachment_folder_grants,
//       tasks (entity-linked ORG tasks only), reminders, calendar_events,
//       plans, compliance_items (job COIs/licenses),
//       PROJECT-scoped job_reports (job_id NULL — no cascade reaches them),
//       messages + message_reads (entity threads + photo-comment threads).
//
// WHAT IT KEEPS
//   clients, subs, users, org settings/branding, templates, field tools,
//   PERSONAL tasks (scope='personal'), standalone reminders/calendar/plans
//   (entity_type NULL), and AI conversation logs / payloads.
//
// ── CROSS-TENANT SAFETY (the load-bearing invariant) ────────────────────
//   1. Anchors are scoped to organization_id = $1. Legacy un-tagged rows
//      (organization_id IS NULL) are a real state, and the app treats them
//      as "belonging to every org". We therefore sweep them ONLY when this
//      is the SOLE active organization (shouldIncludeNullOrg) — so a second
//      tenant's un-tagged rows can NEVER be hard-deleted by another org's
//      reset. With >1 org, the reset is strict equality only.
//   2. Every polymorphic child delete is keyed to entity_id ∈ (this org's
//      anchor IDs) AND, where the child carries its own org column, also
//      AND organization_id = $1 — so a child row can never be removed on
//      anchor-id membership alone. Belt and suspenders.
// ════════════════════════════════════════════════════════════════════

const { pool } = require('../db');

// "This org's rows". The NULL arm is included only when caller passes
// incNull=true (sole-active-org — see shouldIncludeNullOrg).
function orgPred(incNull) {
  return incNull ? '(organization_id = $1 OR organization_id IS NULL)' : 'organization_id = $1';
}
function leadsQ(incNull)     { return 'SELECT id FROM leads WHERE ' + orgPred(incNull); }
function jobsQ(incNull)      { return 'SELECT id FROM jobs WHERE ' + orgPred(incNull); }
function estimatesQ(incNull) { return 'SELECT id FROM estimates WHERE ' + orgPred(incNull); }
const PROJECTS_Q = 'SELECT id FROM projects WHERE organization_id = $1';

function anchorSubq(incNull) {
  return { lead: leadsQ(incNull), estimate: estimatesQ(incNull), job: jobsQ(incNull), project: PROJECTS_Q };
}
// "entity is one of the target types AND its id is in this org's anchor set".
function polyPred(types, incNull) {
  const sub = anchorSubq(incNull);
  return '(' + types.map(function (t) {
    return "(entity_type = '" + t + "' AND entity_id IN (" + sub[t] + '))';
  }).join(' OR ') + ')';
}
const ALL4 = ['lead', 'estimate', 'job', 'project'];

// Sweep legacy NULL-org rows ONLY when there is a single active org — so a
// second tenant's un-tagged rows can never be caught. Fails CLOSED (strict
// equality) if the org count can't be read.
async function shouldIncludeNullOrg(runner) {
  try {
    const r = await runner.query('SELECT COUNT(*)::int AS n FROM organizations WHERE archived_at IS NULL');
    return Number(r.rows[0].n) <= 1;
  } catch (e) { return false; }
}

// ── Preview: counts only, ZERO writes. Tolerant — a count that errors comes
//    back null so the UI shows "—" instead of failing the whole preview. ──
async function previewOrgData(orgId) {
  const incNull = await shouldIncludeNullOrg(pool);
  const out = { include_legacy_untagged: incNull };
  async function n(label, sql) {
    try { const r = await pool.query(sql, [orgId]); out[label] = Number(r.rows[0].n); }
    catch (e) { out[label] = null; }
  }
  await n('leads', 'SELECT COUNT(*)::int n FROM leads WHERE ' + orgPred(incNull));
  await n('jobs', 'SELECT COUNT(*)::int n FROM jobs WHERE ' + orgPred(incNull));
  await n('estimates', 'SELECT COUNT(*)::int n FROM estimates WHERE ' + orgPred(incNull));
  await n('projects', 'SELECT COUNT(*)::int n FROM projects WHERE organization_id = $1');
  await n('attachments', 'SELECT COUNT(*)::int n FROM attachments WHERE ' + polyPred(ALL4, incNull));
  await n('file_folders', 'SELECT COUNT(*)::int n FROM file_folders WHERE ' + polyPred(ALL4, incNull));
  await n('tasks', "SELECT COUNT(*)::int n FROM tasks WHERE organization_id = $1 AND scope = 'org' AND " + polyPred(ALL4, incNull));
  await n('reminders', 'SELECT COUNT(*)::int n FROM reminders WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));
  await n('calendar_events', 'SELECT COUNT(*)::int n FROM calendar_events WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));
  await n('plans', 'SELECT COUNT(*)::int n FROM plans WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));
  await n('reports', "SELECT COUNT(*)::int n FROM job_reports WHERE job_id IN (" + jobsQ(incNull) + ") OR (entity_type = 'project' AND entity_id IN (" + PROJECTS_Q + '))');
  await n('schedule_entries', 'SELECT COUNT(*)::int n FROM schedule_entries WHERE job_id IN (' + jobsQ(incNull) + ')');
  await n('change_orders', 'SELECT COUNT(*)::int n FROM job_change_orders WHERE job_id IN (' + jobsQ(incNull) + ')');
  await n('compliance_items', "SELECT COUNT(*)::int n FROM compliance_items WHERE organization_id = $1 AND entity_type = 'job' AND entity_id IN (" + jobsQ(incNull) + ')');
  await n('job_subs', 'SELECT COUNT(*)::int n FROM job_subs WHERE job_id IN (' + jobsQ(incNull) + ')');
  await n('messages', "SELECT COUNT(*)::int n FROM messages WHERE thread_key IN (" +
    "SELECT 'job:' || id FROM jobs WHERE " + orgPred(incNull) +
    " UNION SELECT 'lead:' || id FROM leads WHERE " + orgPred(incNull) +
    " UNION SELECT 'estimate:' || id FROM estimates WHERE " + orgPred(incNull) + ')');
  // Legacy un-tagged anchors folded into the totals above (only when swept).
  await n('legacy_untagged_leads', 'SELECT COUNT(*)::int n FROM leads WHERE organization_id IS NULL');
  await n('legacy_untagged_jobs', 'SELECT COUNT(*)::int n FROM jobs WHERE organization_id IS NULL');
  return out;
}

// ── Reset: the destructive transaction. Polymorphic cleanups are each
//    savepoint-wrapped (a surprise missing column skips that one table +
//    is reported, not aborting the whole wipe). The four ANCHOR deletes are
//    NOT savepoint-wrapped: a throw there rolls the ENTIRE transaction back. ─
async function resetOrgData(orgId) {
  const client = await pool.connect();
  const deleted = {};
  const skipped = [];
  try {
    await client.query('BEGIN');
    const incNull = await shouldIncludeNullOrg(client);

    async function del(label, sql) {
      await client.query('SAVEPOINT sp_del');
      try {
        const r = await client.query(sql, [orgId]);
        deleted[label] = r.rowCount;
        await client.query('RELEASE SAVEPOINT sp_del');
      } catch (e) {
        await client.query('ROLLBACK TO SAVEPOINT sp_del');
        skipped.push({ table: label, error: e.message });
      }
    }

    // 1) Photo-comment message threads ('attachment:<id>') for attachments
    //    about to go — before the attachments delete so the id set resolves.
    const attIdSubq = 'SELECT id FROM attachments WHERE ' + polyPred(ALL4, incNull);
    await del('messages.photo_threads',
      "DELETE FROM messages WHERE thread_key IN (SELECT 'attachment:' || id FROM (" + attIdSubq + ') _a)');
    await del('message_reads.photo_threads',
      "DELETE FROM message_reads WHERE thread_key IN (SELECT 'attachment:' || id FROM (" + attIdSubq + ') _a)');

    // 2) Entity message threads. ('project:' is forward-looking — the
    //    messaging layer only mints job/lead/estimate/attachment/dm keys
    //    today, so the project arm matches zero rows but stays future-proof.)
    const entThreads =
      "SELECT 'job:' || id AS k FROM jobs WHERE " + orgPred(incNull) +
      " UNION SELECT 'lead:' || id FROM leads WHERE " + orgPred(incNull) +
      " UNION SELECT 'estimate:' || id FROM estimates WHERE " + orgPred(incNull) +
      " UNION SELECT 'project:' || id FROM projects WHERE organization_id = $1";
    await del('messages.entity_threads',
      'DELETE FROM messages WHERE thread_key IN (SELECT k FROM (' + entThreads + ') _t)');
    await del('message_reads.entity_threads',
      'DELETE FROM message_reads WHERE thread_key IN (SELECT k FROM (' + entThreads + ') _t)');

    // 3) Photos / files + folder structure.
    await del('attachments', 'DELETE FROM attachments WHERE ' + polyPred(ALL4, incNull));
    await del('file_folders', 'DELETE FROM file_folders WHERE ' + polyPred(ALL4, incNull)); // parent_id CASCADE clears subtree
    await del('attachment_folder_grants', 'DELETE FROM attachment_folder_grants WHERE ' + polyPred(['lead', 'estimate', 'job'], incNull));

    // 4) Entity-linked productivity rows. PERSONAL data preserved: tasks
    //    scope='org' only; reminders/calendar/plans require a non-NULL
    //    entity_type (polyPred). Each ALSO guarded by its own org column so a
    //    child can never be removed on anchor-id membership alone.
    await del('tasks', "DELETE FROM tasks WHERE organization_id = $1 AND scope = 'org' AND " + polyPred(ALL4, incNull));
    await del('reminders', 'DELETE FROM reminders WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));
    await del('calendar_events', 'DELETE FROM calendar_events WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));
    await del('plans', 'DELETE FROM plans WHERE organization_id = $1 AND ' + polyPred(ALL4, incNull));

    // 5) Job compliance items (COIs / licenses keyed to a job).
    await del('compliance_items', "DELETE FROM compliance_items WHERE organization_id = $1 AND entity_type = 'job' AND entity_id IN (" + jobsQ(incNull) + ')');

    // 6) PROJECT-scoped reports — job_reports.job_id is NULL for these, so the
    //    jobs FK cascade can't reach them. Delete explicitly (job-scoped
    //    reports cascade via the jobs delete and need no explicit step).
    await del('job_reports.project', "DELETE FROM job_reports WHERE entity_type = 'project' AND entity_id IN (" + PROJECTS_Q + ')');

    // 7) job_subs explicitly before jobs (sub_id is ON DELETE RESTRICT on the
    //    subs side; removing these rows first removes any doubt).
    await del('job_subs', 'DELETE FROM job_subs WHERE job_id IN (' + jobsQ(incNull) + ')');

    // ── ANCHORS (atomic — a throw rolls back everything above). FK cascade
    //    removes their remaining children. Cross-anchor refs are SET NULL.
    async function delAnchor(label, sql) {
      const r = await client.query(sql, [orgId]);
      deleted[label] = r.rowCount;
    }
    await delAnchor('estimates', 'DELETE FROM estimates WHERE ' + orgPred(incNull));
    await delAnchor('leads', 'DELETE FROM leads WHERE ' + orgPred(incNull));
    await delAnchor('projects', 'DELETE FROM projects WHERE organization_id = $1');
    await delAnchor('jobs', 'DELETE FROM jobs WHERE ' + orgPred(incNull));

    await client.query('COMMIT');
    return { ok: true, include_legacy_untagged: incNull, deleted: deleted, skipped: skipped };
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    return { ok: false, error: e.message, deleted: deleted, skipped: skipped };
  } finally {
    client.release();
  }
}

module.exports = { previewOrgData, resetOrgData };
