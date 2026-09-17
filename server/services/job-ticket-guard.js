// WHAT A JOB DELETE MAY TAKE WITH IT: THE WORK ORDERS ON THAT JOB.
//
// service_tickets.job_id is ON DELETE CASCADE, and so is everything hanging off
// a ticket (events, revisions, crew links, flags, completion report links). A
// job delete therefore used to erase every work order on the job silently,
// open or not, with its approval history and timeline.
//
// One rule, shared by both doors that can cascade a job:
//   - DELETE /api/jobs/:id (job-routes.js) refuses on OPEN tickets, and asks the
//     caller to echo back the exact count of closed, cancelled or archived ones
//     before it takes them.
//   - The lead delete chain (lead-routes.js) refuses on OPEN tickets.
//
// Pure data helpers: every function takes the query runner (a pool or a client
// already inside a transaction) and requires nothing. Every statement carries
// the ticket's own organization predicate.
'use strict';

// Open (non-archived, non-terminal) service tickets that cascading these JOBS
// would destroy. db.js states the invariant plainly: "after conversion a ticket
// is about the JOB, and deleting the originating lead must not take the job's
// live work order with it." leadsBlockedByTickets only sees tickets with
// job_id IS NULL, so converted work orders need their own guard. Statuses:
// draft|open|scheduled|in_progress|work_complete|approved|closed|cancelled.
async function openTicketsOnJobs(q, jobIds, orgId) {
  if (!jobIds || !jobIds.length) return 0;
  const { rows } = await q.query(
    `SELECT COUNT(*)::int AS n FROM service_tickets
      WHERE job_id = ANY($1::text[])
        AND organization_id = $2
        AND archived_at IS NULL
        AND status NOT IN ('closed', 'cancelled')`,
    [jobIds, orgId]
  );
  return rows[0] ? rows[0].n : 0;
}

// The tickets a job delete WOULD take once nothing open is left: closed,
// cancelled or archived. Archived wins over status, so an archived closed
// ticket counts once, as archived. `ids` feeds the audit row.
async function retiredTicketsOnJobs(q, jobIds, orgId) {
  const out = { total: 0, closed: 0, cancelled: 0, archived: 0, ids: [] };
  if (!jobIds || !jobIds.length) return out;
  const { rows } = await q.query(
    `SELECT id, status, archived_at FROM service_tickets
      WHERE job_id = ANY($1::text[])
        AND organization_id = $2
        AND (archived_at IS NOT NULL OR status IN ('closed', 'cancelled'))
      ORDER BY created_at`,
    [jobIds, orgId]
  );
  for (const r of rows) {
    out.ids.push(r.id);
    if (r.archived_at != null) out.archived++;
    else if (r.status === 'cancelled') out.cancelled++;
    else out.closed++;
  }
  out.total = rows.length;
  return out;
}

function plural(n, one, many) { return n === 1 ? one : many; }

// 'This job has 2 open service tickets. Close or archive them before deleting the job.'
function openTicketsMessage(n) {
  return 'This job has ' + n + ' open service ' + plural(n, 'ticket', 'tickets') +
    '. Close or archive ' + plural(n, 'it', 'them') + ' before deleting the job.';
}

// 'This job has 4 closed, cancelled or archived service tickets. Deleting the job
// deletes them too, with their approval history, timeline and crew links.'
function closedTicketsMessage(n) {
  return 'This job has ' + n + ' closed, cancelled or archived service ' + plural(n, 'ticket', 'tickets') +
    '. Deleting the job deletes ' + plural(n, 'it', 'them') + ' too, with ' + plural(n, 'its', 'their') +
    ' approval history, timeline and crew links.';
}

module.exports = {
  openTicketsOnJobs,
  retiredTicketsOnJobs,
  openTicketsMessage,
  closedTicketsMessage,
};
