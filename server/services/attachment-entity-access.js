// attachment-entity-access.js — WHICH CAPABILITY does an attachment of this
// entity_type require?
//
// Lives in services/ (not routes/) deliberately, for the reason
// changeset-guard.js states: routes/* pull in the auth module, which hard-fails
// without JWT_SECRET, so anything parked there can only be reached from code
// that already paid that cost. services/payload-dispatcher.js is requirable
// with no auth env and must stay that way, and its attachment.photo_updates arm
// has to ask the SAME question PUT /api/attachments/:id asks. Two answers to
// "may this caller write this row" is the defect class this repo keeps paying
// for, so there is one function and it lives where both doors can reach it.
//
// Moved here VERBATIM from routes/attachment-routes.js, which now requires it
// and re-exports it on module.exports.entityAccess unchanged — file-folders-
// routes.js and the capability tests see no difference.
//
// ── SERVICE TICKETS: A FLAT STRING CANNOT NAME THE RULE ─────────────────────
// A work order has no capability of its own; it inherits its PARENT's (a job's
// or a lead's), and the job's narrow tier depends on whether THIS job is the
// caller's. services/service-ticket-access.js decides that, once. A function
// that returns one string per entity TYPE cannot express it, and until this
// change 'service_ticket' fell through to the LEADS_VIEW / LEADS_EDIT default
// below. Executed consequences: a LEADS_VIEW-only user listed and downloaded the
// crew photos on a JOB ticket they cannot open; a JOBS_VIEW_ALL user without
// LEADS_VIEW was refused their own job's work-order photos; and a crew lead
// holding one job's grant was never narrowed to that job.
//
// So the answer is split in two, and BOTH halves are mandatory:
//   * readCapForEntity / writeCapForEntity return coarseCaps(mode) — every
//     capability that could grant the mode on SOME ticket. It is the
//     NECESSARY pre-gate for code that has not loaded the ticket (and for
//     consumers that only know the type), never sufficient on its own.
//   * ticketAttachmentAccess() — below — loads the ticket strictly in the
//     caller's org and asks mayAccessTicketParent. Every attachment door on a
//     ticket runs it once the ticket id is known.
// Routing 'service_ticket' AROUND the flat functions instead was rejected: they
// have consumers outside the attachment doors (the file-folders router, the
// payload dispatcher, the AI photo-read gate), and any consumer that forgot the
// special case would silently get the LEADS default back — the defect itself.
'use strict';

// Requires nothing at load time (auth is pulled in lazily there, and a failure
// to load it is a refusal), so this module stays requirable with no JWT_SECRET —
// payload-dispatcher.js and several JWT-free suites depend on that.
const ticketAccess = require('./service-ticket-access');

const TICKET_ENTITY_TYPE = 'service_ticket';
// Authorization helper. Reads aren't gated tightly — anyone who can see
// the parent entity can see its photos. Writes require the matching
// edit capability.
function readCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_VIEW';
  if (entityType === 'client')   return 'ESTIMATES_VIEW';
  // Job reads accept either the all-jobs view cap or the assigned-only
  // cap. Returning a space-separated list is the convention used in
  // report-routes / qb-cost-routes — see requireDynamicCapability below
  // for the OR-match logic.
  if (entityType === 'job')      return 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN';
  if (entityType === 'sub')      return 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Personal-files bucket. Capability is universal so authenticated
  // users can land on their own folder; the ownership check below
  // (ensureUserAttachmentOwner) enforces "only you can see your own".
  if (entityType === 'user')     return '__owner__';
  // Org-wide knowledge base — every authenticated user in the org
  // can READ the company files; per-row org_id scoping (enforced by
  // ensureOrgAttachmentScope below) keeps tenants isolated. Writes
  // are gated separately by writeCapForEntity.
  if (entityType === 'org')      return '__org_member__';
  // Projects are sales/job-lifecycle buckets — reads follow the same
  // posture as leads (anyone on the team can see; org isolation is
  // enforced by the project's row org_id elsewhere).
  if (entityType === 'project')  return 'LEADS_VIEW';
  // Task photos — any content-editor on the team can view a task's photos
  // (tasks are a general productivity primitive: job tasks for the field, plus
  // office to-dos). Org isolation is enforced by the task's row org_id.
  if (entityType === 'task')     return 'JOBS_VIEW_ALL JOBS_VIEW_ASSIGNED JOBS_EDIT_ANY JOBS_EDIT_OWN LEADS_VIEW LEADS_EDIT';
  // Work-order photos. COARSE ONLY — see the header: passing this proves
  // nothing until ticketAttachmentAccess has answered for the ticket's parent.
  if (entityType === TICKET_ENTITY_TYPE) return ticketAccess.coarseCaps('read').join(' ');
  return 'LEADS_VIEW';
}
function writeCapForEntity(entityType) {
  if (entityType === 'estimate') return 'ESTIMATES_EDIT';
  if (entityType === 'client')   return 'ESTIMATES_EDIT';
  // Job writes — JOBS_EDIT was never a real capability (only _ANY and
  // _OWN exist), so the prior single-cap lookup 403'd for every user
  // and broke .xlsx / .docx / generic file uploads attached to a job
  // chat. Accept either edit-tier cap; per-job ownership is enforced
  // upstream by the canEdit() helper in job-routes for the row itself.
  if (entityType === 'job')      return 'JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Sub uploads (cert PDFs) — same shape; allow OWN-tier too because
  // PMs who own a job often handle their sub paperwork.
  if (entityType === 'sub')      return 'JOBS_EDIT_ANY JOBS_EDIT_OWN';
  // Same owner-only model as the read side.
  if (entityType === 'user')     return '__owner__';
  // Company knowledge base — admin-tier only. Plain users can READ
  // (via the __org_member__ sentinel on the read side) but the
  // bucket is curated by admins so it doesn\'t accumulate noise.
  if (entityType === 'org')      return 'USERS_MANAGE ROLES_MANAGE SYSTEM_ADMIN';
  // Project uploads — anyone with lead-edit capability can drop photos
  // into a project. This is a sales/walk-through bucket; gating it
  // tighter (e.g. behind a per-project ACL) was considered overkill
  // for the v1 ship.
  if (entityType === 'project')  return 'LEADS_EDIT';
  // Task photo uploads — field crew (JOBS_EDIT_OWN) attach photos to job tasks;
  // office staff (LEADS_EDIT) can attach to their to-dos. Org-scoped by row.
  if (entityType === 'task')     return 'JOBS_EDIT_ANY JOBS_EDIT_OWN LEADS_EDIT';
  // Same split as the read side: coarse here, the parent's rule per ticket.
  if (entityType === TICKET_ENTITY_TYPE) return ticketAccess.coarseCaps('write').join(' ');
  return 'LEADS_EDIT';
}

// THE PER-TICKET HALF. Every attachment door whose entity is a service ticket
// asks this once the ticket id is known.
//
// opts:
//   query(sql, params) -> Promise<{ rows }>  pool.query or a transaction client
//   user                                        the actor ({ id, role, ... })
//   ticketId                                    attachments.entity_id
//   orgId                                       the CALLER's organization
//   mode                                        'read' | 'write'
//   hasCapability                               optional; tests only
//
// Returns { ok: true } or { ok: false, hidden, reason, kind? }.
//   hidden === true  -> the door answers with ITS OWN not-found response, the
//                       exact body an absent id gets. Used for a ticket that is
//                       absent, in another org, or on a job the narrow-tier
//                       caller is not on ('not_assigned'). A distinguishable
//                       refusal there would tell a guesser "that work order
//                       exists", which the ticket REST doors refuse to say.
//   hidden === false -> the door answers with its existing 403. 'no_capability'
//                       is decided by role and parent KIND, the same refusal
//                       the ticket REST doors give; bad_mode / no_user /
//                       no_parent / auth_unavailable are "cannot be authorized",
//                       never a pass.
//
// The ticket is loaded by id AND organization_id, strictly. The attachment
// predicate that ran before this (attachment-org-scope.js) is a ladder that can
// settle on the attachment row's own stamp when the parent does not resolve;
// the ticket rule needs the TICKET's parent, so a ticket that does not load in
// the caller's org has no parent to ask about and is simply not there.
//
// A query failure THROWS rather than answering. Every caller already turns a
// throw into a refusal (a route's 500, the dispatcher's ROLLBACK), and on a
// Postgres transaction client a swallowed error would leave an aborted
// transaction behind a verdict that looked ordinary.
async function ticketAttachmentAccess(opts) {
  const o = opts || {};
  const mode = o.mode === 'read' || o.mode === 'write' ? o.mode : null;
  if (!mode) return { ok: false, hidden: false, reason: 'bad_mode' };
  const ticketId = o.ticketId == null ? '' : String(o.ticketId);
  // No id, no org, or nothing to query with: there is no ticket this caller can
  // be shown, and saying so is the not-found answer, not a pass.
  if (!ticketId || o.orgId == null || typeof o.query !== 'function') {
    return { ok: false, hidden: true, reason: 'not_found' };
  }
  const r = await o.query(
    'SELECT id, job_id, lead_id FROM service_tickets WHERE id = $1 AND organization_id = $2',
    [ticketId, o.orgId]
  );
  const ticket = r && r.rows && r.rows[0];
  if (!ticket) return { ok: false, hidden: true, reason: 'not_found' };

  const verdict = await ticketAccess.mayAccessTicketParent({
    query: o.query,
    user: o.user,
    parent: ticket,
    mode,
    orgId: o.orgId,
    hasCapability: o.hasCapability,
  });
  if (verdict && verdict.ok === true) return { ok: true };
  const reason = (verdict && verdict.reason) || 'denied';
  if (reason === 'not_assigned') return { ok: false, hidden: true, reason };
  return { ok: false, hidden: false, reason, kind: ticketAccess.parentOf(ticket).kind };
}

module.exports = {
  TICKET_ENTITY_TYPE,
  readCapForEntity,
  writeCapForEntity,
  ticketAttachmentAccess,
};
