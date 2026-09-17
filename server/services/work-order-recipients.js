'use strict';

// WHO IS ON A WORK ORDER — ONE LIST FOR EVERY NOTICE ABOUT IT.
//
// The approval notice, a problem a crew flagged, the crew-activity batch, the
// morning digest and the Work Orders page's "My approvals" all ask the same
// question, so it is answered once, here:
//
//   pm           jobs.owner_id — the person who runs the job
//   creator      service_tickets.created_by
//   sender       service_ticket_shares.created_by — who sent a crew link
//   assignee     service_tickets.assignee_user_id
//   salesperson  leads.salesperson_id, ONLY on a ticket that hangs off a lead
//                alone (job_id NULL); a converted lead's work order belongs to
//                the job and its PM now
//   participant  service_ticket_participants, by created_at
//
// in that order, each person once, never the person who made the move, and
// only people who pass services/service-ticket-access.js for the notice's mode
// ('write' for "ready for your approval", 'read' for everything else). Raising
// a ticket or sending its link once is not a standing grant: someone taken off
// the job since hears nothing.
//
// ADMIN FALLBACK. When the caller asks for it and NOBODY on the ticket passes
// the access rule, the org's admins are asked instead (fallback: 'admins').
// Never because people muted the notice: muting is a choice, and emailing the
// admins against it would overrule that choice. Callers filter mutes after.
//
// Tenancy: every statement carries `organization_id = $n` taken from the
// ticket row the caller already proved. The users read is org-predicated too,
// because a wide capability (an admin's) is not tied to an org by the access
// rule, and that predicate is the only thing keeping another tenant's admin
// off this org's mail.

const access = require('./service-ticket-access');

const RELATIONS = Object.freeze(['pm', 'creator', 'sender', 'assignee', 'salesperson', 'participant']);

// Columns a notice or the notice cron reads from service_tickets. No money,
// no scope text, no internal notes, no guest log, no takeoff.
const NOTICE_TICKET_COLS = [
  'id', 'organization_id', 'title', 'job_id', 'lead_id', 'status', 'priority',
  'created_by', 'assignee_user_id', 'completed_at', 'updated_at', 'scheduled_for',
  'due_date', 'street_address', 'city', 'state', 'zip', 'lat', 'lng', 'access_notes',
  'approval_notified_at', 'approval_notice_attempts', 'approval_notice_last_try_at',
  'approval_notice_gave_up_at', 'crew_activity_notified_at',
].join(', ');

function positiveInt(v) {
  const n = Number(v);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function idList(v) {
  return (Array.isArray(v) ? v : [v]).map(positiveInt).filter(Boolean);
}

// [{id, relations:[...]}] in relation order. Pure.
//   facts: {jobOwnerId, createdBy, senderIds[], assigneeId, salespersonId,
//           participantIds[], leadOnly}
//   opts:  {relations?: subset of RELATIONS, actorUserId?}
function relationEntries(facts, opts) {
  const f = facts || {};
  const o = opts || {};
  const allowed = Array.isArray(o.relations) ? o.relations : RELATIONS;
  const actor = positiveInt(o.actorUserId);
  const order = [];
  const byId = new Map();
  function add(relation, value) {
    if (allowed.indexOf(relation) < 0) return;
    idList(value).forEach(function (id) {
      if (id === actor) return;
      if (!byId.has(id)) { byId.set(id, []); order.push(id); }
      const rels = byId.get(id);
      if (rels.indexOf(relation) < 0) rels.push(relation);
    });
  }
  add('pm', f.jobOwnerId);
  add('creator', f.createdBy);
  add('sender', f.senderIds);
  add('assignee', f.assigneeId);
  if (f.leadOnly) add('salesperson', f.salespersonId);
  add('participant', f.participantIds);
  return order.map(function (id) { return { id: id, relations: byId.get(id) }; });
}

function relationIds(facts, opts) {
  return relationEntries(facts, opts).map(function (e) { return e.id; });
}

// A memoised access check, so a batch that asks about the same person and the
// same parent many times (the digest) queries once. Key: user|org|parent|mode.
// A failed check is a refusal, never a pass.
function accessMemo(hasCapability) {
  const cache = new Map();
  return {
    check: function (db, user, parent, mode, orgId) {
      const p = access.parentOf(parent);
      const key = String(user && user.id) + '|' + String(orgId) + '|' + p.kind + ':' + p.id + '|' + mode;
      if (!cache.has(key)) {
        cache.set(key, Promise.resolve()
          .then(function () {
            return access.mayAccessTicketParent({
              query: function (sql, params) { return db.query(sql, params); },
              user: { id: user && user.id, role: user && user.role },
              parent: parent,
              mode: mode,
              orgId: orgId,
              hasCapability: hasCapability,
            });
          })
          .then(function (v) { return !!(v && v.ok); }, function () { return false; }));
      }
      return cache.get(key);
    },
    size: function () { return cache.size; },
  };
}

async function orgAdmins(db, orgId) {
  if (orgId == null) return [];
  const r = await db.query(
    `SELECT id, name, email, role, timezone, notification_prefs FROM users
      WHERE organization_id = $1 AND active = TRUE AND role IN ('admin', 'system_admin')
      ORDER BY id ASC`,
    [orgId]
  );
  return r.rows;
}

/**
 * ticketRecipients(db, ticket, opts) -> {users:[{...user, relations}], fallback: null|'admins'}
 *   opts.mode             'read' | 'write' (default 'read')
 *   opts.relations        subset of RELATIONS (default all)
 *   opts.actorUserId      never told about their own move
 *   opts.sharedBy         the sender(s) of the link(s) this notice is about
 *   opts.allSenders       every link's sender counts, not only sharedBy
 *   opts.fallbackToAdmins ask the org's admins when nobody on it can
 *   opts.hasCapability    injected by tests; auth's role cache by default
 *   opts.memo             an accessMemo to share across calls
 * Throws on a database error; callers are best-effort and catch.
 */
async function ticketRecipients(db, ticket, opts) {
  const o = opts || {};
  const orgId = ticket && ticket.organization_id;
  if (!ticket || orgId == null) return { users: [], fallback: null };
  const mode = o.mode || 'read';
  const memo = o.memo || accessMemo(o.hasCapability);

  const facts = {
    jobOwnerId: null,
    createdBy: ticket.created_by,
    senderIds: idList(o.sharedBy),
    assigneeId: ticket.assignee_user_id,
    salespersonId: null,
    participantIds: [],
    leadOnly: !ticket.job_id && !!ticket.lead_id,
  };
  if (ticket.job_id) {
    const j = await db.query('SELECT owner_id FROM jobs WHERE id = $1 AND organization_id = $2', [ticket.job_id, orgId]);
    if (j.rows[0]) facts.jobOwnerId = j.rows[0].owner_id;
  }
  if (ticket.lead_id) {
    const l = await db.query('SELECT salesperson_id FROM leads WHERE id = $1 AND organization_id = $2', [ticket.lead_id, orgId]);
    if (l.rows[0]) facts.salespersonId = l.rows[0].salesperson_id;
  }
  if (ticket.id != null) {
    if (o.allSenders) {
      const s = await db.query(
        `SELECT created_by FROM service_ticket_shares
          WHERE ticket_id = $1 AND organization_id = $2 AND created_by IS NOT NULL
          ORDER BY created_at ASC`,
        [ticket.id, orgId]
      );
      s.rows.forEach(function (row) { facts.senderIds.push(row.created_by); });
    }
    const p = await db.query(
      `SELECT user_id FROM service_ticket_participants
        WHERE ticket_id = $1 AND organization_id = $2
        ORDER BY created_at ASC`,
      [ticket.id, orgId]
    );
    facts.participantIds = p.rows.map(function (row) { return row.user_id; });
  }

  const entries = relationEntries(facts, { relations: o.relations, actorUserId: o.actorUserId });
  const wanted = entries.map(function (e) { return e.id; });
  const users = [];
  if (wanted.length) {
    const r = await db.query(
      'SELECT id, name, email, role, timezone, notification_prefs FROM users WHERE id = ANY($1::int[]) AND organization_id = $2 AND active = TRUE',
      [wanted, orgId]
    );
    for (const e of entries) {
      const u = r.rows.find(function (row) { return Number(row.id) === e.id; });
      if (!u) continue;
      if (await memo.check(db, u, ticket, mode, orgId)) users.push(Object.assign({}, u, { relations: e.relations }));
    }
  }
  if (users.length || !o.fallbackToAdmins) return { users: users, fallback: null };

  const actor = positiveInt(o.actorUserId);
  const admins = [];
  for (const u of await orgAdmins(db, orgId)) {
    const id = positiveInt(u.id);
    if (!id || id === actor) continue;
    if (await memo.check(db, u, ticket, mode, orgId)) admins.push(Object.assign({}, u, { relations: ['admin'] }));
  }
  return { users: admins, fallback: admins.length ? 'admins' : null };
}

// SQL: is the user in `meRef` on the ticket aliased `alias`? The same
// relations as ticketRecipients (job owner, creator, assignee, link sender,
// salesperson on a lead-only ticket, participant), so the Work Orders page's
// "My approvals" and the morning digest cannot disagree with who is emailed.
// Every subquery is pinned to the ticket's own organization. Access (the
// write tier) is the caller's to add.
function myTicketRelationSql(alias, meRef) {
  const t = String(alias == null ? 't' : alias);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(t)) throw new Error('myTicketRelationSql: bad table alias');
  const me = String(meRef);
  if (!/^\$\d+$/.test(me)) throw new Error('myTicketRelationSql: the user must be a $n parameter');
  return '(' +
    'EXISTS (SELECT 1 FROM jobs rel_j WHERE rel_j.id = ' + t + '.job_id AND rel_j.organization_id = ' + t + '.organization_id AND rel_j.owner_id = ' + me + ')' +
    ' OR ' + t + '.created_by = ' + me +
    ' OR ' + t + '.assignee_user_id = ' + me +
    ' OR EXISTS (SELECT 1 FROM service_ticket_shares rel_s WHERE rel_s.ticket_id = ' + t + '.id AND rel_s.organization_id = ' + t + '.organization_id AND rel_s.created_by = ' + me + ')' +
    ' OR (' + t + '.job_id IS NULL AND EXISTS (SELECT 1 FROM leads rel_l WHERE rel_l.id = ' + t + '.lead_id AND rel_l.organization_id = ' + t + '.organization_id AND rel_l.salesperson_id = ' + me + '))' +
    ' OR EXISTS (SELECT 1 FROM service_ticket_participants rel_p WHERE rel_p.ticket_id = ' + t + '.id AND rel_p.organization_id = ' + t + '.organization_id AND rel_p.user_id = ' + me + ')' +
  ')';
}

module.exports = {
  RELATIONS,
  NOTICE_TICKET_COLS,
  relationIds,
  relationEntries,
  accessMemo,
  orgAdmins,
  ticketRecipients,
  myTicketRelationSql,
};
