// ── The tenancy classification of every table in this database ─────────────
//
// WHY THIS FILE EXISTS. `server/org-access.js` declares the convention; this
// file is the machine-readable half of it, so that the classification can be
// CHECKED rather than believed. A table that carries `organization_id` but is
// named nowhere below is reported as `unclassified` by the org-boundary audit
// (server/services/org-boundary-audit.js) — loudly, by name. That is the whole
// point: "a table nobody can classify is where the next hole lives", and a
// prose list in a comment cannot make an omission visible. This one can.
//
// THREE CLASSES, and they are NOT interchangeable:
//
//   direct   — the row's own organization_id column is the tenant. A NULL here
//              is an UN-STAMPED row: a leak, visible to every tenant through
//              the `OR organization_id IS NULL` tolerance arms. It should
//              reach zero, and only then may the column be tightened.
//
//   parent   — the row's tenant is its PARENT's tenant. Its own column (if it
//              has one) is a denormalised cache, not the anchor. The row
//              disappears when the PARENT's stamp is NULL, so counting the
//              child's own NULLs answers the wrong question. `attachments` is
//              the canonical case: services/attachment-org-scope.js resolves
//              it through entity_type/entity_id (both NOT NULL) and only falls
//              back to the row's own column. Tightening a parent-scoped
//              child's column buys nothing the parent does not already give,
//              and costs the most on exactly the largest tables.
//
//   shared   — NULL is CORRECT DATA and must never be "fixed". These rows are
//              the platform-wide catalog every tenant reads. Their NULLs are
//              re-inserted on every boot by seedGlobalTaxonomy(), and their
//              uniqueness indexes are built on COALESCE(organization_id, 0),
//              which only makes sense with NULLs present. A `SET NOT NULL`
//              here is not a failed migration, it is a BOOT CRASH LOOP: the
//              same init() that adds the constraint violates it.
//
//   platform — no tenant, by construction, and none can be invented. Either
//              the table has no organization_id at all, or its parent has no
//              tenant either (a child cannot carry a tenant its parent does
//              not have). The correct control on these is the CAPABILITY GATE,
//              not a predicate: they belong behind SYSTEM_ADMIN, not behind
//              ROLES_MANAGE (which every org admin holds).
//
// The `shared` list is NOT hardcoded here. It is imported from the module that
// actually writes the NULLs — services/assemblies.js — so a table added to the
// seeder is classified by the same edit that creates it. Deriving it from a
// second list here is precisely how a future shared table gets counted as
// un-stamped, "fixed" by a backfill, and split per tenant.

const { SHARED_NULL_ORG_TABLES } = require('./assemblies');

// ── direct ────────────────────────────────────────────────────────────────
// The row's own column IS the tenant.
const DIRECT = [
  'admin_audit_log', 'agent_jobs', 'agent_reference_links', 'ai_memories',
  'ai_subtasks', 'ai_training_examples', 'ai_watch_runs', 'ai_watches',
  'assembly_research', 'assembly_tuning_log', 'calendar_events', 'clients',
  'compliance_items', 'context_load_events', 'cost_categories', 'deal_memory',
  'email_campaigns', 'email_folders', 'email_labels', 'email_rules',
  'email_snippets', 'email_template_overrides', 'email_thread_state',
  'estimates', 'field_tools', 'inbound_emails', 'jobs', 'leads', 'list_views',
  'managed_agent_registry', 'markets', 'oauth_tokens', 'org_folder_templates',
  'org_mcp_servers', 'org_memory', 'org_skill_packs', 'org_tags',
  'payload_templates', 'payloads', 'plan_versions', 'plans', 'projects',
  'receipt_ocr_feedback', 'receipts', 'reminders', 'reports', 'staff_agents',
  'subs', 'task_shares', 'tasks', 'usage_counters', 'user_notes', 'users',
];

// ── parent ────────────────────────────────────────────────────────────────
// Tenant = the parent's tenant. `column` is the child's own (cache) column, or
// null when it has none. `orphanable` marks a child whose parent row can be
// absent (polymorphic pointer, or a nullable FK) — those need a SEPARATE count,
// because an orphan is not the same population as "parent exists but is NULL".
const PARENT = {
  // Polymorphic. entity_type/entity_id are NOT NULL; see attachment-org-scope.
  attachments:              { via: 'polymorphic', column: 'organization_id', orphanable: true },
  file_folders:             { via: 'polymorphic', column: 'organization_id', orphanable: true },
  attachment_folder_grants: { parent: 'subs',  fk: 'sub_id',      column: null,             orphanable: false },
  sub_certificates:         { parent: 'subs',  fk: 'sub_id',      column: 'organization_id', orphanable: false },
  job_change_orders:        { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  job_purchase_orders:      { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  job_vendor_bills:         { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  job_workflow_items:       { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  job_reports:              { parent: 'jobs',  fk: 'job_id',      column: null,             orphanable: false },
  job_subs:                 { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  node_graphs:              { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  qb_cost_lines:            { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  pay_applications:         { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: false },
  // job_id is NULLABLE here (standalone entries) — see org-access.js's
  // schedule_entry case, which is why this one is orphanable.
  schedule_entries:         { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: true },
  invoices:                 { parent: 'jobs',  fk: 'job_id',      column: 'organization_id', orphanable: true },
  // The anchor is the USER, not a business entity. ai_messages/messages are
  // per-user conversation rows; users.organization_id is their tenant.
  ai_messages:              { parent: 'users', fk: 'user_id',     column: 'organization_id', orphanable: false },
  messages:                 { parent: 'users', fk: 'user_id',     column: 'organization_id', orphanable: false },
  material_purchases:       { parent: 'materials', fk: 'material_id', column: 'organization_id', orphanable: true },
  payments:                 { parent: 'clients', fk: 'client_id', column: 'organization_id', orphanable: true },
};

// ── platform ──────────────────────────────────────────────────────────────
// No tenant exists to stamp. Listed so the audit does not report them as
// unclassified, and so the reason is recorded next to the name.
//
// The control on every one of these is the CAPABILITY, not a predicate. Three
// of them (ai_evals, ai_eval_runs, agent_skills_versions) sat behind
// ROLES_MANAGE, which every org admin holds — a gate, not a boundary.
const PLATFORM = {
  roles:                  'name is the PRIMARY KEY and auth.js:_roleCache keys on name alone. One tenant editing "pm" changes every tenant\'s PMs. Per-org roles is a schema change plus a cache re-key, not an endgame item.',
  app_settings:           'key TEXT PRIMARY KEY, no tenant column and no tenant parent.',
  agent_skills_versions:  'snapshots app_settings.agent_skills, which has no tenant. A CHILD CANNOT CARRY A TENANT ITS PARENT DOES NOT HAVE — adding a column here would invent one.',
  ai_evals:               'platform-authored evaluation definitions. Bare WHERE id = $1 statements; the defect was the capability (ROLES_MANAGE), not the missing column.',
  ai_eval_runs:           'results of the above — a run of a platform-authored eval against a platform-managed agent. Same gate, same reasoning: no tenant exists to stamp, so the control is SYSTEM_ADMIN.',
};

// ── shared ────────────────────────────────────────────────────────────────
// Imported, never re-listed. See the header.
const SHARED = SHARED_NULL_ORG_TABLES.slice();

// Tables whose NULL-org rows are a documented SHARED-CATALOG fallback even
// though the table also holds per-tenant rows. `materials` and `assemblies`
// both resolve "org row first, else the global row" (services/materials.js
// ORDER BY organization_id NULLS LAST). Their NULLs are load-bearing for the
// global half and un-stamped for the tenant half, and NOTHING in the schema
// tells the two apart — so they are reported in their own bucket and are not
// candidates for NOT NULL or for an arm drop under any count.
const MIXED_SHARED = ['materials', 'assemblies'];

function classify(table) {
  if (SHARED.indexOf(table) !== -1) return 'shared';
  if (MIXED_SHARED.indexOf(table) !== -1) return 'mixed_shared';
  if (Object.prototype.hasOwnProperty.call(PARENT, table)) return 'parent';
  if (Object.prototype.hasOwnProperty.call(PLATFORM, table)) return 'platform';
  if (DIRECT.indexOf(table) !== -1) return 'direct';
  return 'unclassified';
}

module.exports = { DIRECT, PARENT, PLATFORM, SHARED, MIXED_SHARED, classify };
