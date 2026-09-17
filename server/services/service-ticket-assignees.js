'use strict';

// WHO A WORK ORDER MAY BE ASSIGNED TO (1.29).
//
// "Assigned to" names a person the work order is handed to, and the first
// thing that person does is open it. So the only people offered, and the only
// people accepted, are the ones who can OPEN the ticket's job or lead — the
// same rule every ticket door asks, services/service-ticket-access.js
// mayAccessTicketParent in mode 'read'. It is asked here per person rather than
// copied, so the picker and the doors can never disagree: wide roles
// short-circuit, the narrow tier needs the job's owner or a grant, a lead needs
// the lead capability.
//
//   eligibleAssignees(db, { orgId, parent })       -> [{ id, name }]
//   proveAssigneeForParent(db, { raw, orgId, parent })
//                                                   -> { ok: true, value } | { ok: false, error }
//
// Sub-portal accounts (a sub_id, or the 'sub' role) are never offered: a
// subcontractor reaches a work order through its crew link, not the office app.
// A switched-off account is never offered and is refused with its own sentence.
//
// The list carries id and name ONLY — no email, phone or role.
//
// TENANCY: every users statement carries organization_id = $n from the org the
// route already proved.

const access = require('./service-ticket-access');
const fields = require('./service-ticket-fields');

const LIST_LIMIT = 500;

const SWITCHED_OFF = "That person's account is switched off. Pick someone else.";
const CANT_OPEN_JOB = "That person can't open this job, so they can't be assigned. Give them access to the job first, or pick someone else.";
const CANT_OPEN_LEAD = "That person can't open this lead, so they can't be assigned. Give them access to leads first, or pick someone else.";

function isSubPortal(row) {
  return !!(row && ((row.sub_id != null && String(row.sub_id) !== '') || row.role === 'sub'));
}

function isSwitchedOff(row) {
  return !!row && (row.active === false || row.active === 0);
}

async function canOpen(db, row, parent, orgId) {
  const verdict = await access.mayAccessTicketParent({
    query: function (sql, params) { return db.query(sql, params); },
    user: { id: row.id, role: row.role },
    parent: parent,
    mode: 'read',
    orgId: orgId,
  });
  return !!(verdict && verdict.ok === true);
}

/**
 * eligibleAssignees(db, { orgId, parent }) -> [{ id, name }]
 * Active, non-sub users of this org who can open the parent, sorted by name.
 */
async function eligibleAssignees(db, opts) {
  const o = opts || {};
  const orgId = o.orgId;
  if (orgId == null || !access.parentOf(o.parent).kind) return [];
  const r = await db.query(
    `SELECT id, name, role, active, sub_id FROM users
      WHERE organization_id = $1 AND active IS NOT FALSE
      ORDER BY LOWER(name) LIMIT ${LIST_LIMIT}`,
    [orgId]
  );
  const out = [];
  for (const row of r.rows) {
    if (isSubPortal(row) || isSwitchedOff(row)) continue;
    if (!(await canOpen(db, row, o.parent, orgId))) continue;
    out.push({ id: Number(row.id), name: row.name == null ? '' : String(row.name) });
  }
  return out;
}

/**
 * proveAssigneeForParent(db, { raw, orgId, parent }) -> { ok: true, value } | { ok: false, error }
 * null or '' clears the assignee. Anything else must be a user of this org who
 * is switched on and can open the parent.
 */
async function proveAssigneeForParent(db, opts) {
  const o = opts || {};
  if (o.raw === undefined || o.raw === null || o.raw === '') return { ok: true, value: null };
  const shaped = fields.validateTicketFields({ assignee_user_id: o.raw }, { mode: 'update' });
  if (!shaped.ok) return { ok: false, error: fields.ASSIGNEE_REFUSAL };
  const id = shaped.values.assignee_user_id;
  if (id == null) return { ok: true, value: null };
  if (o.orgId == null) return { ok: false, error: fields.ASSIGNEE_REFUSAL };

  const r = await db.query(
    'SELECT id, name, role, active, sub_id FROM users WHERE id = $1 AND organization_id = $2',
    [id, o.orgId]
  );
  const row = r.rows[0];
  if (!row) return { ok: false, error: fields.ASSIGNEE_REFUSAL };
  if (isSwitchedOff(row)) return { ok: false, error: SWITCHED_OFF };
  const kind = access.parentOf(o.parent).kind;
  const cantOpen = kind === 'lead' ? CANT_OPEN_LEAD : CANT_OPEN_JOB;
  if (!kind || isSubPortal(row)) return { ok: false, error: cantOpen };
  if (!(await canOpen(db, row, o.parent, o.orgId))) return { ok: false, error: cantOpen };
  return { ok: true, value: id };
}

module.exports = {
  eligibleAssignees,
  proveAssigneeForParent,
  SWITCHED_OFF,
  CANT_OPEN_JOB,
  CANT_OPEN_LEAD,
};
