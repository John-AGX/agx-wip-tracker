'use strict';

// WHAT NEEDS ATTENTION ON AN ORGANIZATION'S WORK ORDERS, PER PERSON.
//
// One assembly for two readers: the morning digest and waiting reminder
// (server/work-order-notify-cron.js, step D) and the Work Orders page's
// "Needs attention" count (attentionForUser). They cannot disagree, because
// both ask this module.
//
// SECTIONS, per person:
//   approvals    the person can EDIT it (write tier) and is on it; status
//                work_complete for more than 24 hours. Days waiting, and the
//                business days since it finished marked when over the org's N
//                (organizations.settings.work_orders.approval_reminder_business_days,
//                1..10, default 2). A work order nobody on it can approve goes to
//                the company admins who can, as the approval notice does.
//   flags        can read it; open problems a crew flagged (service_ticket_flags,
//                status 'open').
//   overdue      can read it; due date before today in the org's zone; open,
//                scheduled or in progress.
//   unopened     can read it; scheduled today or tomorrow in the org's zone; open
//                or scheduled; no live crew link has been opened.
//   expiring     can read it; a live crew link expires within 3 days.
//   suggestions  can edit it; crew suggestions pending for more than 24 hours.
//   your_buildings
//                THE WORK ORDER IS ASSIGNED TO THIS PERSON
//                (service_tickets.assignee_user_id, the Assigned to the office
//                sets from a real dropdown) and its punch list still has at
//                least one live, open org building. How many are still open,
//                and the soonest due date among them. Not gated on access —
//                see below.
//
// RESPONSIBILITY SITS ON THE RECORD, NEVER ON A BUILDING (1.35, the owner:
// "whoever is assigned to the ticket, task or work order is evenly
// responsible"). A building is a row in `tasks` and so inherited
// tasks.assignee_user_id by accident; no screen ever offered to set it, and
// since 1.35 no door will. This section therefore reads that column on a
// building NOWHERE: it asks the ticket who it is assigned to, and counts the
// work order's WHOLE punch list, because everyone on the record is equally
// responsible for every building on it. That is the same predicate
// services/service-ticket-subtask-door.js myOpenBuildingSql spells for
// GET /api/service-tickets/my-buildings, said here in one org-wide pass.
//   A value left on an old building row is not read and not cleared: there is
//   no backfill anywhere in 1.35.
//
// THE ONE SECTION THAT IS NOT GATED ON ACCESS. Every section above is filtered
// through reaches(), which is services/service-ticket-access.js listVisibility.
// your_buildings deliberately is not, and must never be. The work order's
// assignee may be a crew lead with no grant on the job, and
// services/service-ticket-subtask-door.js doneVerdict lets exactly that person
// tick its buildings off. Since 1.33 buildings are off every task list (the
// owner's other rule: a service ticket is not a task), so this section — and
// GET /api/service-tickets/my-buildings, the same rule on the page — is the
// only place they are TOLD about the punch list they are on the hook for. Put
// it through listVisibility and that crew lead is shown nothing, which is the
// exact failure it exists to prevent. Nor is membership of `related` /
// relationIds asked: being the work order's assignee is the whole claim.
//   A deliberate widening, named out loud: the recipient learns the job's number
//   and title (jobLine) and the work order's title for a job they may not be
//   able to open. That is necessary — they have to know where to go — and it is
//   all they learn. Nothing priced, ever, here as everywhere else.
//   Only an ACTIVE work order counts: the ticket query below already restricts
//   to open, scheduled, in_progress and work_complete, so this section needs no
//   status filter of its own.
//
// WHO IS "ON" A WORK ORDER is services/work-order-recipients.js relationIds —
// the same relations every notice uses (PM, creator, every link sender,
// assignee, salesperson on a lead-only ticket, participants). The access tier
// is services/service-ticket-access.js listVisibility in 'read' or 'write'
// mode, answered from rows read once per org: the wide capability sees every
// job's work orders; the narrow one only a job the person owns or holds a
// grant on — any grant to read, an 'edit' grant to approve — the same split
// mayAccessTicketParent draws; lead capabilities cover lead-only tickets.
//
// READ-ONLY. Every statement carries `organization_id = $1` (job grants, which
// have no org column, are joined to the org's jobs). Threshold comparisons on
// stored instants (24 hours) run DB-side against NOW(). Calendar days (today,
// tomorrow, business days) are the org's zone, from `now`.
//
// NO MONEY: a job is read for its number and title only; items carry the
// ticket row's id, title and parent ids for the link.

const tz = require('../timezone');
const text = require('./work-order-notify-text');
const recipients = require('./work-order-recipients');
const access = require('./service-ticket-access');

const TICKET_CAP = 500;
const DAY_MS = 86400000;
const EXPIRING_MS = 3 * DAY_MS;
// Appended to, never reordered: the digest and the page's count index this list.
const SECTION_KEYS = Object.freeze(['approvals', 'flags', 'overdue', 'unopened', 'expiring', 'suggestions', 'your_buildings']);
const ACTIVE_STATUSES = Object.freeze(['open', 'scheduled', 'in_progress']);

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function truthy(v) {
  return v === true || v === 1 || v === '1' || v === 't' || v === 'true';
}

function dayText(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return null;
    return v.getFullYear() + '-' + String(v.getMonth() + 1).padStart(2, '0') + '-' + String(v.getDate()).padStart(2, '0');
  }
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(String(v).trim());
  return m ? m[1] : null;
}

function ymdPlusDays(ymd, n) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + n * DAY_MS).toISOString().slice(0, 10);
}

function groupBy(rows, key) {
  const map = new Map();
  (rows || []).forEach(function (row) {
    const k = String(row[key]);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(row);
  });
  return map;
}

async function defaultOpenFlags(db, orgId, ticketIds) {
  const r = await db.query(
    `SELECT ticket_id, id AS flag_id, category, created_at FROM service_ticket_flags
      WHERE organization_id = $1 AND ticket_id = ANY($2::text[]) AND status = 'open'
      ORDER BY created_at ASC`,
    [orgId, ticketIds]
  );
  return groupBy(r.rows, 'ticket_id');
}

// Does this person reach this ticket in this mode? From the visibility the
// access module answers and the org's job rows and grants read once.
function reaches(person, ticket, mode, jobs, grants) {
  const vis = mode === 'write' ? person.visWrite : person.visRead;
  if (!vis) return false;
  const uid = positiveInt(person.user.id);
  if (ticket.job_id != null && ticket.job_id !== '') {
    if (vis.jobs === 'all') return true;
    if (vis.jobs !== 'assigned' || uid == null) return false;
    const job = jobs.get(String(ticket.job_id));
    if (!job) return false;
    if (job.owner_id != null && Number(job.owner_id) === uid) return true;
    const level = grants.get(String(ticket.job_id) + '|' + uid);
    if (level == null) return false;
    return mode === 'read' ? true : level === 'edit';
  }
  if (ticket.lead_id != null && ticket.lead_id !== '') return !!vis.leads;
  return false;
}

function emptySections() {
  const s = {};
  SECTION_KEYS.forEach(function (k) { s[k] = []; });
  return s;
}

/**
 * attentionForOrg(db, {org:{id, name, timezone, settings}, now?, deps?, userIds?})
 *   -> Map<userId, {user, sections:{approvals, flags, overdue, unopened, expiring,
 *                   suggestions, your_buildings},
 *                   overBusinessDays:[{ticket, jobLine, businessDays}]}>
 * Only people with at least one item are in the map.
 *   deps.hasCapability  injected by tests; auth's role cache by default
 *   deps.openFlags      (db, orgId, ticketIds) -> Map<ticketId, [{flag_id, category, created_at}]>
 *   userIds             only assemble these people (the page's own count)
 * Throws on a database error; callers catch.
 */
async function attentionForOrg(db, opts) {
  const o = opts || {};
  const org = o.org || {};
  const orgId = org.id;
  const out = new Map();
  if (orgId == null) return out;
  const deps = o.deps || {};
  const now = text.asDate(o.now) || new Date();
  const zone = tz.resolveTz(null, org.timezone);
  const overDays = text.reminderBusinessDays(org.settings);
  const today = tz.localDateInTz(zone, now);
  const tomorrow = ymdPlusDays(today, 1);
  const only = Array.isArray(o.userIds) ? new Set(o.userIds.map(positiveInt).filter(Boolean)) : null;

  const t = await db.query(
    `SELECT ${recipients.NOTICE_TICKET_COLS},
            CAST(scheduled_for AS TEXT) AS scheduled_iso, CAST(due_date AS TEXT) AS due_iso,
            CASE WHEN COALESCE(completed_at, updated_at) < NOW() - INTERVAL '24 hours' THEN 1 ELSE 0 END AS waited_a_day
       FROM service_tickets
      WHERE organization_id = $1 AND archived_at IS NULL
        AND status IN ('open', 'scheduled', 'in_progress', 'work_complete')
      ORDER BY created_at DESC LIMIT ${TICKET_CAP}`,
    [orgId]
  );
  const tickets = t.rows;
  if (!tickets.length) return out;
  if (tickets.length >= TICKET_CAP) {
    console.warn('[work-order-attention] org ' + orgId + ' has ' + TICKET_CAP + '+ open work orders; only the newest ' + TICKET_CAP + ' were read');
  }
  const ids = tickets.map(function (row) { return String(row.id); });
  const jobIds = Array.from(new Set(tickets.filter(function (row) { return row.job_id; }).map(function (row) { return String(row.job_id); })));
  const leadIds = Array.from(new Set(tickets.filter(function (row) { return row.lead_id; }).map(function (row) { return String(row.lead_id); })));

  const [shares, pending, tallies, jobRows, grantRows, leadRows, participants, users] = await Promise.all([
    db.query(
      `SELECT id, ticket_id, created_by, recipient_name, scope, opened_at, revoked_at, expires_at,
              CASE WHEN revoked_at IS NULL AND expires_at > NOW() THEN 1 ELSE 0 END AS live
         FROM service_ticket_shares
        WHERE organization_id = $1 AND ticket_id = ANY($2::text[])
        ORDER BY created_at ASC`,
      [orgId, ids]
    ),
    db.query(
      `SELECT ticket_id, COUNT(*)::int AS n FROM service_ticket_revisions
        WHERE organization_id = $1 AND status = 'pending' AND created_at < NOW() - INTERVAL '24 hours'
        GROUP BY ticket_id`,
      [orgId]
    ),
    // THE WORK ORDER'S OWN PUNCH LIST, read once for both readers of it: the
    // done/total tally the overdue row shows, and the open count and soonest
    // due date your_buildings shows. One statement, so "1 of 3 buildings done"
    // and "2 buildings still open" can never disagree about the same work
    // order. A building is a live org task on the ticket: `scope = 'org'`
    // leaves a private to-do that happens to carry a ticket id to its owner,
    // exactly as services/service-ticket-subtask-door.js draws the line.
    // NO ASSIGNEE COLUMN IS READ — see "RESPONSIBILITY SITS ON THE RECORD".
    db.query(
      `SELECT service_ticket_id AS ticket_id, COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE status = 'done')::int AS done,
              COUNT(*) FILTER (WHERE status <> 'done')::int AS open_n,
              CAST(MIN(due_date) FILTER (WHERE status <> 'done') AS TEXT) AS next_due
         FROM tasks
        WHERE organization_id = $1 AND service_ticket_id = ANY($2::text[]) AND archived_at IS NULL AND scope = 'org'
        GROUP BY service_ticket_id`,
      [orgId, ids]
    ),
    jobIds.length
      ? db.query(
        `SELECT id, owner_id, data->>'jobNumber' AS job_number, data->>'title' AS title
           FROM jobs WHERE organization_id = $1 AND id = ANY($2::text[])`,
        [orgId, jobIds])
      : { rows: [] },
    jobIds.length
      ? db.query(
        `SELECT a.job_id, a.user_id, a.access_level
           FROM job_access a JOIN jobs j ON j.id = a.job_id
          WHERE j.organization_id = $1 AND a.job_id = ANY($2::text[])`,
        [orgId, jobIds])
      : { rows: [] },
    leadIds.length
      ? db.query(
        'SELECT id, title, salesperson_id FROM leads WHERE organization_id = $1 AND id = ANY($2::text[])',
        [orgId, leadIds])
      : { rows: [] },
    db.query(
      `SELECT ticket_id, user_id FROM service_ticket_participants
        WHERE organization_id = $1 AND ticket_id = ANY($2::text[])
        ORDER BY created_at ASC`,
      [orgId, ids]
    ),
    db.query(
      `SELECT id, name, email, role, timezone, notification_prefs FROM users
        WHERE organization_id = $1 AND active = TRUE
        ORDER BY id ASC`,
      [orgId]
    ),
  ]);

  let flags = new Map();
  try {
    const got = typeof deps.openFlags === 'function'
      ? await deps.openFlags(db, orgId, ids)
      : await defaultOpenFlags(db, orgId, ids);
    if (got instanceof Map) flags = got;
  } catch (e) {
    console.warn('[work-order-attention] open flags read failed:', e && e.message);
  }

  const sharesByTicket = groupBy(shares.rows, 'ticket_id');
  const participantsByTicket = groupBy(participants.rows, 'ticket_id');
  const pendingByTicket = new Map(pending.rows.map(function (r) { return [String(r.ticket_id), Number(r.n) || 0]; }));
  const tallyByTicket = new Map(tallies.rows.map(function (r) {
    return [String(r.ticket_id), {
      total: Number(r.total) || 0,
      done: Number(r.done) || 0,
      open: Number(r.open_n) || 0,
      nextDue: dayText(r.next_due),
    }];
  }));
  const NO_PUNCH_LIST = Object.freeze({ total: 0, done: 0, open: 0, nextDue: null });
  const jobs = new Map(jobRows.rows.map(function (r) { return [String(r.id), r]; }));
  const leads = new Map(leadRows.rows.map(function (r) { return [String(r.id), r]; }));
  const grants = new Map(grantRows.rows.map(function (r) { return [String(r.job_id) + '|' + Number(r.user_id), r.access_level]; }));

  const hasCap = deps.hasCapability;
  const people = new Map();
  users.rows.forEach(function (u) {
    const id = positiveInt(u.id);
    if (!id) return;
    people.set(id, {
      user: u,
      visRead: access.listVisibility(u, hasCap, 'read'),
      visWrite: access.listVisibility(u, hasCap, 'write'),
    });
  });
  const admins = Array.from(people.values()).filter(function (p) {
    return p.user.role === 'admin' || p.user.role === 'system_admin';
  });

  function entryFor(person) {
    const id = positiveInt(person.user.id);
    if (!out.has(id)) out.set(id, { user: person.user, sections: emptySections(), overBusinessDays: [] });
    return out.get(id);
  }
  function add(person, key, item) {
    if (only && !only.has(positiveInt(person.user.id))) return;
    entryFor(person).sections[key].push(item);
  }

  tickets.forEach(function (ticket) {
    const id = String(ticket.id);
    const job = ticket.job_id ? jobs.get(String(ticket.job_id)) : null;
    const lead = ticket.lead_id ? leads.get(String(ticket.lead_id)) : null;
    const leadOnly = !ticket.job_id && !!ticket.lead_id;
    const tShares = sharesByTicket.get(id) || [];
    const liveShares = tShares.filter(function (s) { return truthy(s.live); });
    const related = recipients.relationIds({
      jobOwnerId: job ? job.owner_id : null,
      createdBy: ticket.created_by,
      senderIds: tShares.map(function (s) { return s.created_by; }),
      assigneeId: ticket.assignee_user_id,
      salespersonId: lead ? lead.salesperson_id : null,
      participantIds: (participantsByTicket.get(id) || []).map(function (p) { return p.user_id; }),
      leadOnly: leadOnly,
    }, {}).map(function (uid) { return people.get(uid); }).filter(Boolean);
    const jobLine = job
      ? text.jobLineOf({ job_number: job.job_number, name: job.title })
      : (leadOnly && lead ? text.jobLineOf({ name: lead.title }) : '');
    const readers = related.filter(function (p) { return reaches(p, ticket, 'read', jobs, grants); });
    const writers = related.filter(function (p) { return reaches(p, ticket, 'write', jobs, grants); });
    const status = ticket.status;
    const punch = tallyByTicket.get(id) || NO_PUNCH_LIST;

    if (status === 'work_complete' && truthy(ticket.waited_a_day)) {
      const approvers = writers.length
        ? writers
        : admins.filter(function (p) { return reaches(p, ticket, 'write', jobs, grants); });
      const finished = text.asDate(ticket.completed_at || ticket.updated_at);
      const daysWaiting = finished ? Math.max(1, Math.floor((now.getTime() - finished.getTime()) / DAY_MS)) : 1;
      const businessDays = finished ? text.businessDaysSince(finished, now, zone) : 0;
      const over = businessDays > overDays;
      approvers.forEach(function (p) {
        add(p, 'approvals', { ticket: ticket, jobLine: jobLine, daysWaiting: daysWaiting, businessDays: businessDays, over: over });
        if (over && (!only || only.has(positiveInt(p.user.id)))) {
          entryFor(p).overBusinessDays.push({ ticket: ticket, jobLine: jobLine, businessDays: businessDays });
        }
      });
    }

    (flags.get(id) || []).forEach(function (f) {
      readers.forEach(function (p) {
        add(p, 'flags', { ticket: ticket, jobLine: jobLine, flagId: f.flag_id, category: f.category, flaggedAt: f.created_at });
      });
    });

    const due = dayText(ticket.due_iso);
    if (ACTIVE_STATUSES.indexOf(status) >= 0 && due && due < today) {
      readers.forEach(function (p) {
        add(p, 'overdue', { ticket: ticket, jobLine: jobLine, dueDate: due, done: punch.done, total: punch.total });
      });
    }

    const scheduled = dayText(ticket.scheduled_iso);
    if ((status === 'open' || status === 'scheduled') && scheduled && (scheduled === today || scheduled === tomorrow)) {
      if (!liveShares.some(function (s) { return s.opened_at; })) {
        readers.forEach(function (p) {
          add(p, 'unopened', {
            ticket: ticket, jobLine: jobLine,
            when: scheduled === today ? 'today' : 'tomorrow',
            linkSent: liveShares.length > 0,
          });
        });
      }
    }

    const soon = liveShares
      .map(function (s) { return { share: s, at: text.asDate(s.expires_at) }; })
      .filter(function (x) { return x.at && x.at.getTime() - now.getTime() <= EXPIRING_MS; })
      .sort(function (a, b) { return a.at.getTime() - b.at.getTime(); })[0];
    if (soon) {
      readers.forEach(function (p) {
        add(p, 'expiring', { ticket: ticket, jobLine: jobLine, crewName: soon.share.recipient_name, expiresAt: soon.share.expires_at });
      });
    }

    const waiting = pendingByTicket.get(id) || 0;
    if (waiting > 0) {
      writers.forEach(function (p) {
        add(p, 'suggestions', { ticket: ticket, jobLine: jobLine, count: waiting });
      });
    }

    // THE PUNCH LIST OF A WORK ORDER ASSIGNED TO SOMEBODY. The recipient is the
    // TICKET's own assignee, and the count is the work order's whole open punch
    // list — never one person's share of it, because there are no shares: the
    // person the record is assigned to is responsible for every building on it.
    // Not `readers`, not `writers`, not even `related`: reaches() is NEVER
    // asked here — see "THE ONE SECTION THAT IS NOT GATED ON ACCESS" in the
    // header. `add` still honours the `only` (userIds) filter, so the page's
    // own count is unaffected. No status filter: the ticket query already keeps
    // only open, scheduled, in_progress and work_complete.
    if (punch.open > 0) {
      // Nobody assigned, inactive, or moved to another organization: nobody is
      // told. `people` holds this org's active users alone, so an assignee id
      // from another tenant finds nothing here.
      const owner = people.get(positiveInt(ticket.assignee_user_id));
      if (owner) {
        add(owner, 'your_buildings', {
          ticket: ticket, jobLine: jobLine,
          count: punch.open,
          nextDue: punch.nextDue,
        });
      }
    }
  });

  out.forEach(function (entry, id) {
    entry.sections.approvals.sort(function (a, b) { return b.daysWaiting - a.daysWaiting; });
    entry.sections.overdue.sort(function (a, b) { return a.dueDate < b.dueDate ? -1 : (a.dueDate > b.dueDate ? 1 : 0); });
    // Soonest first, mirroring overdue; a work order whose buildings carry no
    // due date at all goes last rather than to the top.
    entry.sections.your_buildings.sort(function (a, b) {
      if (!a.nextDue) return b.nextDue ? 1 : 0;
      if (!b.nextDue) return -1;
      return a.nextDue < b.nextDue ? -1 : (a.nextDue > b.nextDue ? 1 : 0);
    });
    const any = SECTION_KEYS.some(function (k) { return entry.sections[k].length; });
    if (!any) out.delete(id);
  });
  return out;
}

function countsOf(entry) {
  const counts = { approvals: 0, flags: 0, overdue: 0, unopened: 0, expiring: 0, suggestions: 0, your_buildings: 0, total: 0 };
  if (!entry) return counts;
  const ticketIds = new Set();
  SECTION_KEYS.forEach(function (k) {
    const items = entry.sections[k] || [];
    counts[k] = items.length;
    items.forEach(function (it) { if (it && it.ticket) ticketIds.add(String(it.ticket.id)); });
  });
  counts.total = ticketIds.size;
  return counts;
}

/**
 * attentionForUser(db, {orgId, userId, now?, deps?})
 *   -> {approvals, flags, overdue, unopened, expiring, suggestions,
 *       your_buildings, total}
 * total counts distinct work orders across the sections.
 */
async function attentionForUser(db, opts) {
  const o = opts || {};
  const uid = positiveInt(o.userId);
  if (o.orgId == null || !uid) return countsOf(null);
  const r = await db.query('SELECT id, name, timezone, settings FROM organizations WHERE id = $1', [o.orgId]);
  const org = r.rows[0];
  if (!org) return countsOf(null);
  const map = await attentionForOrg(db, { org: org, now: o.now, deps: o.deps, userIds: [uid] });
  return countsOf(map.get(uid));
}

module.exports = {
  SECTION_KEYS,
  attentionForOrg,
  attentionForUser,
  countsOf,
};
