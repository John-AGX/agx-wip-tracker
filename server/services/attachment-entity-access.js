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
'use strict';
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
  return 'LEADS_EDIT';
}

module.exports = { readCapForEntity, writeCapForEntity };
