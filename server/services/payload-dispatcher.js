// payload-dispatcher.js — Payload DSL apply-time engine.
//
// Single source of truth for:
//   - PAYLOAD_OPS_SCHEMAS (per-entity_type `ops` vocabulary)
//   - validateOps(entityType, ops) — emit-time + apply-time validator
//   - applyPayload(payloadRow, opts) — the canonical apply transaction
//
// Both POST /api/payloads/:id/apply and (later) the make86OnCustomToolUse
// branch in ai-routes will import from here so emit-time validation and
// apply-time dispatch never drift.
//
// C3 ships dispatchers for `client` and `estimate`. C5 lands `job`,
// `lead`, `schedule`, `system` + cross-target `$new_id` ref resolution
// across heterogeneous targets. The ref_table scaffolding is in place
// now so adding entity types in C5 only needs new dispatchN functions.

const { pool } = require('../db');

// ──────────────────────────────────────────────────────────────────
// Wave 1.C — PayloadValidationError carries the structured shape
// 86 (and the UI) need to self-correct on rejection. Existing throws
// of plain Error still work — the route handler treats them as
// generic validation/dispatch failures and leaves apply_error_detail
// null. Throw THIS class when you can name the field path the
// error happened at, what was expected, and what was received.
//
// Usage:
//   throw new PayloadValidationError(
//     'estimate.ops.line_adds[2].unitCost is required',
//     { code: 'missing_field', field_path: 'line_adds[2].unitCost',
//       expected: 'number', received: typeof value }
//   );
//
// The route's catch handler reads err.detail and persists it into
// payloads.apply_error_detail alongside the human message.
// ──────────────────────────────────────────────────────────────────
class PayloadValidationError extends Error {
  constructor(message, detail) {
    super(message);
    this.name = 'PayloadValidationError';
    this.detail = detail && typeof detail === 'object' ? detail : {};
  }
}

// ──────────────────────────────────────────────────────────────────
// PAYLOAD_OPS_SCHEMAS — per-entity_type allowed-op vocabulary.
//
// Lightweight: not a JSON Schema validator; just an allowlist of top-
// level keys and field constraints. The dispatcher is the real
// arbiter — it ignores unknown keys and errors on shape mismatch.
// ──────────────────────────────────────────────────────────────────

// Subset of CLIENTS table columns the agent may write via ops.fields.
// Mirrors EDITABLE_FIELDS in client-routes.js. Keep these in sync —
// adding a column there should add it here too (and vice versa).
const CLIENT_EDITABLE_FIELDS = new Set([
  'name', 'client_type', 'activation_status',
  'first_name', 'last_name', 'email',
  'phone', 'cell',
  'address', 'city', 'state', 'zip',
  'company_name', 'community_name', 'market',
  'property_address', 'property_phone', 'website',
  'gate_code', 'additional_pocs',
  'community_manager', 'cm_email', 'cm_phone',
  'maintenance_manager', 'mm_email', 'mm_phone',
  'short_name', 'notes',
  // parent_client_id is allowed but validated separately (must exist,
  // and a client cannot be its own parent — same rule as the route
  // handler).
  'parent_client_id',
]);

// Estimate-level top-level fields the agent may write via ops.field_updates.
// Estimates store their data as a JSONB blob; this is a soft allowlist of
// keys that we let through to the blob. Unknown keys are silently dropped
// to keep the JSONB clean.
const ESTIMATE_FIELD_KEYS = new Set([
  'name', 'description', 'status', 'salesperson', 'market',
  'client_id', 'lead_id', 'property_id', 'job_id', 'parent_id',
  'address', 'phone', 'contact_name', 'contact_email',
  'tax_rate', 'discount_pct', 'markup_pct', 'units_label',
  'job_name', 'estimate_number', 'bid_due_date', 'expires_on',
  // Anything stored inline on the estimate blob that 86 might tune —
  // we keep this list generous; if 86 writes a junk key, the worst
  // outcome is a stray field in the blob. Hard-blocked keys (id,
  // owner_id, created_at, updated_at) live in ESTIMATE_BLOCKED_FIELDS.
]);

const ESTIMATE_BLOCKED_FIELDS = new Set([
  'id', 'owner_id', 'created_at', 'updated_at',
  '__totals', 'lines', // lines have their own ops; not free-form
  'estimateAlternates', 'estimateLines',
]);

// Lead-table editable fields. Mirrors EDITABLE_FIELDS in lead-routes.js.
const LEAD_EDITABLE_FIELDS = new Set([
  'client_id', 'title',
  'street_address', 'city', 'state', 'zip',
  'status', 'confidence', 'projected_sale_date',
  'estimated_revenue_low', 'estimated_revenue_high',
  'source', 'project_type',
  'salesperson_id',
  'property_name', 'gate_code', 'market',
  'notes', 'job_id',
]);
const LEAD_VALID_STATUSES = new Set([
  'new', 'in_progress', 'sent', 'lost', 'sold', 'no_opportunity',
]);

// Job blob top-level field keys 86 may set via field_updates. Jobs
// store as JSONB so this list is generous; the BLOCKED list is the
// real safety net.
const JOB_BLOCKED_FIELDS = new Set([
  'id', 'owner_id', 'created_at', 'updated_at',
  // Sub-arrays have their own ops; not free-form
  'buildings', 'phases', 'changeOrders', 'subs',
  'purchaseOrders', 'invoices',
]);

// Schedule entry editable fields (matches readEntry's readable shape).
const SCHEDULE_ENTRY_FIELDS = new Set([
  'job_id', 'jobId', 'start_date', 'startDate', 'days',
  'crew', 'includes_weekends', 'includesWeekends',
  'status', 'notes',
]);

const PAYLOAD_OPS_SCHEMAS = Object.freeze({
  client: {
    // op: 'create' | 'update' (default 'update' if entity_id set, else 'create')
    // fields: { ...CLIENT_EDITABLE_FIELDS subset }
    // notes: [string, ...] | [{ body, source_agent? }, ...]
    // structure: { merge?, split?, delete?, reparent?, attach_business_card? } — v2
    allowedTopKeys: new Set(['op', 'fields', 'notes', 'structure']),
  },
  estimate: {
    allowedTopKeys: new Set([
      'op', 'scope', 'field_updates', 'sections', 'groups',
      'line_adds', 'line_edits', 'line_deletes',
    ]),
  },
  job: {
    // field_updates: top-level job blob keys (NOT structural sub-arrays)
    // phase_updates: [{phase_id, pct_complete?, materials?, labor?, sub?, equipment?, buildingId?}]
    // node_values:  [{node_id, amount}]  (graph node value writes)
    // wire_updates: [{from_node_id, to_node_id, pct_complete?, alloc_pct?}]
    // qb_assignments: [{line_id, node_id}]  (direct SQL on qb_cost_lines)
    // change_orders / purchase_orders / invoices: array ops with {op, *_id?, fields}
    // notes: [string, ...]  (append to job.data.agent_notes JSONB array if present)
    // graph: { nodes:[{op,...}], wires:[{op,...}] }  — structural topology
    allowedTopKeys: new Set([
      'field_updates', 'phase_updates',
      'node_values', 'wire_updates', 'qb_assignments',
      'change_orders', 'purchase_orders', 'invoices',
      'notes', 'graph',
    ]),
  },
  lead: {
    // op: 'create' | 'update'
    // fields: { ...LEAD_EDITABLE_FIELDS subset }
    // notes: [string, ...]   (appended to leads.notes free-text column)
    allowedTopKeys: new Set(['op', 'fields', 'notes']),
  },
  schedule: {
    // blocks: [{op:'create'|'update'|'delete', entry_id?, jobId, startDate, days, crew, includesWeekends, status, notes}]
    allowedTopKeys: new Set(['blocks']),
  },
  system: {
    // watch_ops: [{op:'create'|'archive', watch_id?, name, cadence, ...}]
    // skill_pack_ops: [{op:'add'|'edit'|'delete', pack_id?, fields:{name, body, description?, agents?, category?, triggers?}}]
    // field_tool_ops: [{op:'create'|'edit'|'delete', tool_id?, fields:{name, description?, category?, html_body}}]
    // link_ops: [{op:'link_job_to_client', job_id, client_id} | {op:'link_property_to_parent', property_id, parent_client_id} | {op:'attach_files', attachment_ids[], target_entity_type, target_entity_id}]
    // staff_agent_ops: deferred (needs Anthropic SDK calls)
    allowedTopKeys: new Set([
      'watch_ops', 'skill_pack_ops', 'field_tool_ops', 'link_ops', 'staff_agent_ops',
    ]),
  },
  report: {
    // Polymorphic report (job_reports table). Currently supports
    // entity_type='project' parent only; the legacy job-scoped
    // reports route remains separate.
    //
    // op: 'create' | 'update' (defaults: create when entity_id missing,
    //                          else update)
    //
    // Create-only:
    //   template_type   one of REPORT_TEMPLATE_IDS (walkthrough,
    //                   daily-log, weekly-progress, engineers-report,
    //                   submittal-package, punch-list, pre-con-survey,
    //                   change-order). Stored on the row.
    //   parent_type     'project' (only supported value today)
    //   parent_id       UUID of the project this report belongs to.
    //   title           Initial title string.
    //
    // Create + update:
    //   cover_page      Object of cover fields per template_type (see
    //                   server/routes/reports-routes.js COVER_PAGE_KEYS
    //                   for the full whitelist). Replaces existing on
    //                   update; partial replaces NOT supported (provide
    //                   the full cover_page or omit).
    //   sections        Full sections array. Replaces existing on update.
    //                   Each section: {id?, label, layout, photo_ids?,
    //                   captions?, text_body?, attachment_ids?}
    //
    // Update-only granular ops (use INSTEAD of full sections replace
    // when you want a precise change):
    //   section_adds    [{label, layout, ...}] appended to existing.
    //   section_updates [{id, label?, layout?, text_body?, ...}]
    //   section_deletes ['<section_id>', ...]
    allowedTopKeys: new Set([
      'op',
      'template_type', 'parent_type', 'parent_id', 'title',
      'cover_page', 'sections',
      'section_adds', 'section_updates', 'section_deletes',
    ]),
  },
});

// Mirror of the client-side template registry (js/report-templates.js)
// and the server-side TEMPLATE_TYPES set in reports-routes.js. Used
// by the report dispatcher to validate template_type on create.
const REPORT_TEMPLATE_IDS = new Set([
  'walkthrough', 'daily-log', 'weekly-progress', 'engineers-report',
  'submittal-package', 'punch-list', 'pre-con-survey', 'change-order',
]);

const REPORT_SECTION_LAYOUTS = new Set([
  'photo-grid', 'single-photo', 'before-after', 'text-block', 'attachment-list',
]);

// ──────────────────────────────────────────────────────────────────
// validateOps — light shape check raised before any SQL runs.
// Throws Error with a descriptive message; the apply endpoint wraps
// these to return 422.
// ──────────────────────────────────────────────────────────────────

function validateOps(entityType, ops) {
  const schema = PAYLOAD_OPS_SCHEMAS[entityType];
  if (!schema) throw new Error(`Unknown entity_type: ${entityType}`);
  if (!ops || typeof ops !== 'object') {
    throw new Error(`ops must be an object for entity_type=${entityType}`);
  }
  for (const k of Object.keys(ops)) {
    if (!schema.allowedTopKeys.has(k)) {
      const allowedList = [...schema.allowedTopKeys].sort().join(', ');
      throw new Error(
        `Unknown op key '${k}' for entity_type=${entityType}. Allowed top-level op keys: ${allowedList}.`
      );
    }
  }
  // Per-entity sanity:
  if (entityType === 'client') {
    if (ops.fields && typeof ops.fields !== 'object') {
      throw new Error('client.ops.fields must be an object');
    }
    if (ops.fields) {
      const bad = Object.keys(ops.fields).filter(k => !CLIENT_EDITABLE_FIELDS.has(k));
      if (bad.length) {
        const validList = [...CLIENT_EDITABLE_FIELDS].sort().join(', ');
        throw new Error(
          `client.ops.fields contains non-editable column(s): ${bad.map(k => `'${k}'`).join(', ')}. ` +
          `Valid client fields are: ${validList}.`
        );
      }
    }
    if (ops.notes && !Array.isArray(ops.notes)) {
      throw new Error('client.ops.notes must be an array');
    }
  }
  if (entityType === 'estimate') {
    if (ops.field_updates && typeof ops.field_updates !== 'object') {
      throw new PayloadValidationError(
        'estimate.ops.field_updates must be an object',
        { code: 'wrong_type', field_path: 'estimate.ops.field_updates',
          expected: 'object', received: typeof ops.field_updates }
      );
    }
    if (ops.field_updates) {
      for (const k of Object.keys(ops.field_updates)) {
        if (ESTIMATE_BLOCKED_FIELDS.has(k)) {
          throw new PayloadValidationError(
            `estimate.ops.field_updates blocked key: '${k}'`,
            { code: 'blocked_field', field_path: `estimate.ops.field_updates.${k}`,
              received: k, expected: [...ESTIMATE_BLOCKED_FIELDS],
              suggestion: 'This field is not user-writable via payload. Edit it through the proper proposal flow.' }
          );
        }
      }
    }
    for (const k of ['sections', 'groups', 'line_adds', 'line_edits', 'line_deletes']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new PayloadValidationError(
          `estimate.ops.${k} must be an array`,
          { code: 'wrong_type', field_path: `estimate.ops.${k}`,
            expected: 'array', received: typeof ops[k] }
        );
      }
    }
  }
  if (entityType === 'job') {
    if (ops.field_updates && typeof ops.field_updates !== 'object') {
      throw new Error('job.ops.field_updates must be an object');
    }
    if (ops.field_updates) {
      for (const k of Object.keys(ops.field_updates)) {
        if (JOB_BLOCKED_FIELDS.has(k)) {
          throw new Error(`job.ops.field_updates blocked key: '${k}'`);
        }
      }
    }
    for (const k of ['phase_updates', 'node_values', 'wire_updates',
                     'qb_assignments', 'change_orders', 'purchase_orders',
                     'invoices', 'notes']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`job.ops.${k} must be an array`);
      }
    }
    if (ops.graph) {
      if (typeof ops.graph !== 'object') throw new Error('job.ops.graph must be an object');
      for (const k of ['nodes', 'wires']) {
        if (ops.graph[k] != null && !Array.isArray(ops.graph[k])) {
          throw new Error(`job.ops.graph.${k} must be an array`);
        }
      }
    }
  }
  if (entityType === 'lead') {
    if (ops.fields && typeof ops.fields !== 'object') {
      throw new Error('lead.ops.fields must be an object');
    }
    if (ops.fields) {
      const bad = Object.keys(ops.fields).filter(k => !LEAD_EDITABLE_FIELDS.has(k));
      if (bad.length) {
        const validList = [...LEAD_EDITABLE_FIELDS].sort().join(', ');
        throw new PayloadValidationError(
          `lead.ops.fields contains non-editable column(s): ${bad.map(k => `'${k}'`).join(', ')}. ` +
          `Valid lead fields are: ${validList}. ` +
          `Contact info (name/email/phone) lives on the client, not the lead — link via client_id.`,
          {
            code: 'unknown_field',
            field_path: 'lead.ops.fields',
            received: bad,
            expected: [...LEAD_EDITABLE_FIELDS],
            suggestion: 'Contact info (name/email/phone) lives on the client. Use client.ops.fields with client_id from the lead.'
          }
        );
      }
      if (ops.fields.status && !LEAD_VALID_STATUSES.has(ops.fields.status)) {
        const validStatuses = [...LEAD_VALID_STATUSES].sort().join(', ');
        throw new PayloadValidationError(
          `lead.ops.fields.status invalid: '${ops.fields.status}'. Valid statuses: ${validStatuses}.`,
          {
            code: 'invalid_enum',
            field_path: 'lead.ops.fields.status',
            received: ops.fields.status,
            expected: [...LEAD_VALID_STATUSES],
            suggestion: 'Pick a status from the expected list (typically "new" or "qualified" for fresh leads).'
          }
        );
      }
    }
    if (ops.notes && !Array.isArray(ops.notes)) {
      throw new Error('lead.ops.notes must be an array');
    }
  }
  if (entityType === 'schedule') {
    if (!Array.isArray(ops.blocks)) {
      throw new Error('schedule.ops.blocks must be an array');
    }
    for (const b of ops.blocks) {
      if (!b || !b.op) throw new Error('Each schedule block requires an op');
      if (!['create', 'update', 'delete'].includes(b.op)) {
        throw new Error(`schedule.ops.blocks[].op must be create|update|delete, got: ${b.op}`);
      }
      if (b.op !== 'create' && !b.entry_id) {
        throw new Error(`schedule.ops.blocks[].entry_id required for op=${b.op}`);
      }
    }
  }
  if (entityType === 'system') {
    for (const k of ['watch_ops', 'skill_pack_ops', 'field_tool_ops', 'link_ops', 'staff_agent_ops']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`system.ops.${k} must be an array`);
      }
    }
  }
  if (entityType === 'report') {
    const op = ops.op || 'update';
    if (!['create', 'update'].includes(op)) {
      throw new Error(`report.ops.op must be create|update, got: ${op}`);
    }
    if (op === 'create') {
      if (!ops.template_type) {
        throw new Error('report.ops.template_type required for op=create');
      }
      if (!REPORT_TEMPLATE_IDS.has(ops.template_type)) {
        throw new Error(
          `report.ops.template_type invalid: '${ops.template_type}'. Valid: ${[...REPORT_TEMPLATE_IDS].sort().join(', ')}.`
        );
      }
      if (!ops.parent_id) {
        throw new Error('report.ops.parent_id required for op=create (the project id)');
      }
      // parent_type defaults to 'project' (the only supported value
      // for new reports created via payload). Validate explicit ones.
      if (ops.parent_type && ops.parent_type !== 'project') {
        throw new Error(
          `report.ops.parent_type must be 'project' (got '${ops.parent_type}'). ` +
          `Job-scoped reports use the legacy /api/jobs/:jobId/reports route, not the payload primitive.`
        );
      }
    }
    if (ops.sections && !Array.isArray(ops.sections)) {
      throw new Error('report.ops.sections must be an array');
    }
    for (const k of ['section_adds', 'section_updates', 'section_deletes']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`report.ops.${k} must be an array`);
      }
    }
    // Layout validation across every section + section_add.
    const allSections = [].concat(ops.sections || [], ops.section_adds || []);
    for (const s of allSections) {
      if (s && s.layout && !REPORT_SECTION_LAYOUTS.has(s.layout)) {
        throw new Error(
          `report section layout invalid: '${s.layout}'. Valid: ${[...REPORT_SECTION_LAYOUTS].sort().join(', ')}.`
        );
      }
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// $new_id ref resolution.
//
// 86 may emit a payload that creates a client AND an estimate linked
// to that new client in the same bundle. The estimate target references
// the client via "$new_client" in its entity_id (or in ops.field_updates
// .client_id, etc.). The dispatcher builds a refTable as it processes
// targets in array order and rewrites any leading-'$' string it sees.
// ──────────────────────────────────────────────────────────────────

function isRef(value) {
  return typeof value === 'string' && value.length > 1 && value.charAt(0) === '$';
}

function resolveRef(value, refTable) {
  if (!isRef(value)) return value;
  if (Object.prototype.hasOwnProperty.call(refTable, value)) return refTable[value];
  throw new Error(
    `Unresolved ref '${value}'. Declare it as one of:\n` +
    `  • an earlier TARGET's entity_id with op:'create' (cross-target ref)\n` +
    `  • an op:'add' section's section_id (intra-target, then reference from groups/line_adds)\n` +
    `  • an op:'add' group's group_id (intra-target, then reference from line_adds.subgroup_id)\n` +
    `Refs must be DECLARED before they're REFERENCED.`
  );
}

// Walk an ops object and substitute $ref strings in-place. Mutates input.
function resolveRefsInOps(ops, refTable) {
  if (!ops || typeof ops !== 'object') return;
  for (const k of Object.keys(ops)) {
    const v = ops[k];
    if (isRef(v)) {
      ops[k] = resolveRef(v, refTable);
    } else if (Array.isArray(v)) {
      v.forEach((item, idx) => {
        if (isRef(item)) v[idx] = resolveRef(item, refTable);
        else if (item && typeof item === 'object') resolveRefsInOps(item, refTable);
      });
    } else if (v && typeof v === 'object') {
      resolveRefsInOps(v, refTable);
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// dispatchClient — handles ops on entity_type='client'.
// ──────────────────────────────────────────────────────────────────

function newClientId() {
  return 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newNoteId() {
  return 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// ──────────────────────────────────────────────────────────────────
// P0-2 — tolerant org guard for the entity dispatchers. When a concrete
// target row already exists but belongs to a DIFFERENT organization than
// the applier, block the write — surfaced as "not found" (matches the
// dispatchers' own missing-row errors AND avoids confirming the row
// exists in another tenant). Tolerant of NULL organization_id (legacy /
// un-stamped rows) and of $refs / creates (no concrete row yet). No-op
// for single-tenant AGX; closes cross-org payload writes before org #2.
// ──────────────────────────────────────────────────────────────────
const ORG_SCOPED_TABLE = Object.freeze({
  client: 'clients', estimate: 'estimates', job: 'jobs', lead: 'leads',
});
async function assertTargetOrg(dbClient, entityType, entityId, orgId) {
  if (!orgId || !entityId || isRef(entityId)) return;
  const table = ORG_SCOPED_TABLE[entityType];
  if (!table) return;
  const ok = await dbClient.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) LIMIT 1`,
    [entityId, orgId]
  );
  if (ok.rowCount) return;                 // in-org (or NULL-org) → allow
  const exists = await dbClient.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [entityId]);
  if (exists.rowCount) throw new Error(`${entityType} not found: ${entityId}`); // cross-org → block as not-found
  // genuinely absent → let the dispatcher's own create / not-found path run
}

async function dispatchClient(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  await assertTargetOrg(dbClient, 'client', target.entity_id, ctx && ctx.organizationId);

  // Default op based on whether entity_id was provided.
  const opType = ops.op || (target.entity_id ? 'update' : 'create');

  if (opType === 'create') {
    const id = (target.entity_id && !isRef(target.entity_id))
      ? target.entity_id
      : newClientId();
    const fields = ops.fields || {};
    if (!fields.name) throw new Error('client.create requires fields.name');

    const parentId = fields.parent_client_id || null;
    if (parentId) {
      if (parentId === id) throw new Error('A client cannot be its own parent');
      const parent = await dbClient.query('SELECT id FROM clients WHERE id = $1', [parentId]);
      if (!parent.rows.length) throw new Error(`parent_client_id does not exist: ${parentId}`);
    }

    const cols = ['id'];
    const vals = [id];
    for (const k of Object.keys(fields)) {
      cols.push(k);
      vals.push(fields[k]);
    }
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await dbClient.query(
      `INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );

    // Register the ref if entity_id was a $ref placeholder.
    if (isRef(target.entity_id)) refTable[target.entity_id] = id;

    // Notes
    if (Array.isArray(ops.notes)) {
      await appendClientNotes(dbClient, id, ops.notes, ctx);
    }

    return {
      entity_type: 'client',
      entity_id: id,
      op: 'create',
      created: true,
      summary: `Created client ${fields.name} (${id})`,
    };
  }

  if (opType === 'update') {
    const id = resolveRef(target.entity_id, refTable);
    if (!id) throw new Error('client.update requires entity_id');
    const exists = await dbClient.query('SELECT id FROM clients WHERE id = $1', [id]);
    if (!exists.rows.length) throw new Error(`Client not found: ${id}`);

    const fields = ops.fields || {};
    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length) {
      // parent_client_id sanity (same checks as client-routes PUT /:id)
      if (Object.prototype.hasOwnProperty.call(fields, 'parent_client_id')) {
        const parentId = fields.parent_client_id || null;
        if (parentId) {
          if (parentId === id) throw new Error('A client cannot be its own parent');
          const parent = await dbClient.query('SELECT id FROM clients WHERE id = $1', [parentId]);
          if (!parent.rows.length) throw new Error(`parent_client_id does not exist: ${parentId}`);
        }
      }
      const sets = fieldKeys.map((k, i) => `${k} = $${i + 1}`);
      const params = fieldKeys.map((k) => fields[k]);
      sets.push('updated_at = NOW()');
      params.push(id);
      await dbClient.query(
        `UPDATE clients SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }

    if (Array.isArray(ops.notes) && ops.notes.length) {
      await appendClientNotes(dbClient, id, ops.notes, ctx);
    }

    return {
      entity_type: 'client',
      entity_id: id,
      op: 'update',
      fields_changed: fieldKeys,
      notes_added: Array.isArray(ops.notes) ? ops.notes.length : 0,
      summary: summarizeFieldChanges(id, fieldKeys, ops.notes),
    };
  }

  throw new Error(`client: unsupported op '${opType}'`);
}

async function appendClientNotes(dbClient, clientId, notes, ctx) {
  const userId = ctx && ctx.userId;
  const sourceAgent = ctx && ctx.sourceAgent || null;
  const noteObjects = notes.map((n) => {
    const body = typeof n === 'string' ? n : (n && n.body) || '';
    const source = (typeof n === 'object' && n && n.source_agent) || sourceAgent;
    return {
      id: newNoteId(),
      body: String(body).slice(0, 2000),
      created_at: new Date().toISOString(),
      created_by_user_id: userId || null,
      source_agent: source || null,
    };
  });
  await dbClient.query(
    `UPDATE clients
        SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb,
            updated_at = NOW()
      WHERE id = $2`,
    [JSON.stringify(noteObjects), clientId]
  );
}

function summarizeFieldChanges(id, fieldKeys, notes) {
  const parts = [];
  if (fieldKeys.length) parts.push(`updated ${fieldKeys.length} field(s) on ${id}`);
  if (Array.isArray(notes) && notes.length) parts.push(`appended ${notes.length} note(s)`);
  return parts.join(', ') || `no-op on ${id}`;
}

// ──────────────────────────────────────────────────────────────────
// dispatchEstimate — handles ops on entity_type='estimate'.
//
// Estimates are stored as JSONB. We read the current blob, mutate per
// the ops, then write back inside the same transaction. The mutation
// is in-place so we never lose unrelated fields the payload didn't
// touch.
// ──────────────────────────────────────────────────────────────────

function newLineId() {
  return 'line_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newSectionId() {
  return 'section_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newGroupId() {
  return 'group_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// Intra-target ref pre-pass for estimates.
//
// 86 routinely does this: "create a new group, then add 5 line items
// into that group" — emitted as ONE estimate target with
//   ops.groups: [{op:'add', group_id:'$grp_materials', ...}]
//   ops.line_adds: [{subgroup_id:'$grp_materials', ...}, ...]
//
// resolveRefsInOps walks the whole ops tree once at the top of
// dispatchEstimate. Without this pre-pass, the $grp_materials in
// line_adds gets resolved BEFORE the groups op executes, throws
// "Unresolved ref", and the whole payload fails.
//
// Pre-pass strategy: walk sections + groups ops first, mint real
// IDs for any 'add' op whose id is a $ref, register them in
// refTable. The full resolveRefsInOps pass that runs next then
// substitutes the same $ref tokens everywhere they appear with
// the real IDs. The ops themselves are mutated to carry the real
// IDs, so applyEstimateSections / applyEstimateGroups see the
// resolved values when they run.
function preRegisterEstimateRefs(ops, refTable) {
  if (Array.isArray(ops.sections)) {
    for (const sop of ops.sections) {
      if (sop && sop.op === 'add' && isRef(sop.section_id)) {
        const realId = newSectionId();
        refTable[sop.section_id] = realId;
        sop.section_id = realId;
      }
    }
  }
  if (Array.isArray(ops.groups)) {
    for (const gop of ops.groups) {
      if (gop && gop.op === 'add' && isRef(gop.group_id)) {
        const realId = newGroupId();
        refTable[gop.group_id] = realId;
        gop.group_id = realId;
      }
    }
  }
  // line_adds with explicit line_id $refs — register so subsequent
  // line_edits / line_deletes can target them in the same target.
  if (Array.isArray(ops.line_adds)) {
    for (const la of ops.line_adds) {
      if (la && isRef(la.line_id)) {
        const realId = newLineId();
        refTable[la.line_id] = realId;
        la.line_id = realId;
      }
    }
  }
}

async function dispatchEstimate(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  // Register intra-target ref placeholders (groups, sections, lines
  // created in THIS target that other ops in the same target want to
  // reference) so resolveRefsInOps can substitute them just like
  // cross-target refs. See preRegisterEstimateRefs for the why.
  preRegisterEstimateRefs(ops, refTable);
  resolveRefsInOps(ops, refTable);
  await assertTargetOrg(dbClient, 'estimate', target.entity_id, ctx && ctx.organizationId);

  const opType = ops.op || (target.entity_id ? 'update' : 'create');

  if (opType === 'create') {
    // Estimate create is rare via payload (usually paired with a
    // client create + linkage). Support it for completeness so
    // multi-target lead→client→estimate workflows work in C11.
    const id = (target.entity_id && !isRef(target.entity_id))
      ? target.entity_id
      : ('est_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const fields = ops.field_updates || {};
    // Snapshot the linked client's fields into the estimate blob.
    // Why: when 86 creates an estimate via emit_payload_file with
    // client_id pointing at an existing directory entry, the frontend
    // form previously rendered the estimate with empty company /
    // community / address / manager fields — because no human ever
    // clicked the client picker to trigger the in-editor snapshot.
    // Snapshotting at create-time also locks the client's address +
    // manager + short_name at this moment, so future client edits
    // don't silently rewrite a sent proposal.
    const clientId = fields.client_id;
    let snap = {};
    if (clientId && typeof clientId === 'string' && !isRef(clientId)) {
      try {
        const cr = await dbClient.query(
          'SELECT name, short_name, company_name, community_name, ' +
          '       address, property_address, city, state, zip, ' +
          '       community_manager, cm_email, cm_phone, email, phone, cell ' +
          '  FROM clients WHERE id = $1',
          [clientId]
        );
        if (cr.rows.length) {
          const c = cr.rows[0];
          const propAddr = [c.property_address || c.address, c.city, c.state, c.zip]
            .filter(Boolean).join(', ');
          const billAddr = [c.address, c.city, c.state, c.zip]
            .filter(Boolean).join(', ');
          snap = {
            nickName:      c.short_name || '',
            client:        c.company_name || c.name || '',
            community:     c.community_name || c.name || '',
            propertyAddr:  propAddr || '',
            billingAddr:   billAddr || '',
            managerName:   c.community_manager || '',
            managerEmail:  c.cm_email || c.email || '',
            managerPhone:  c.cm_phone || c.phone || c.cell || '',
          };
          // Strip empty strings so they don't override sensible
          // defaults from 86's field_updates.
          Object.keys(snap).forEach((k) => { if (!snap[k]) delete snap[k]; });
        }
      } catch (e) {
        // Snapshot is best-effort — if the lookup fails (deleted
        // client, race, etc.) the estimate still creates with whatever
        // fields 86 supplied. Don't surface as a payload-level error.
        console.warn('[payload-dispatcher] client snapshot failed:', e.message);
      }
    }
    // Merge precedence: client snapshot < 86's explicit field_updates.
    // 86 may already have filled some fields from its own context
    // (e.g. an estimate that reuses an old job's nickname); those
    // take precedence over the auto-snapshot.
    const blob = { id, ...snap, ...fields };
    if (ops.scope !== undefined) blob.scope = ops.scope;
    // Auto-seed a "Base" alternate with the four standard section
    // headers IF the payload doesn't create an alternate of its own
    // via ops.groups. Matches what the editor's New Estimate flow
    // gives the user (estimate-editor.js seeds STANDARD_SECTIONS_PRESET
    // on first alternate creation). Without this, payload-created
    // estimates open with NO alternates → 86 has to scramble to
    // create one, and tends to over-create (one alternate per
    // section name, which is the wrong data shape).
    const hasGroupAdd = Array.isArray(ops.groups) &&
      ops.groups.some((g) => g && g.op === 'add');
    if (!hasGroupAdd) {
      applyEstimateGroups(blob, [{ op: 'add', name: 'Base', isDefault: true }]);
    }
    if (ops.sections) applyEstimateSections(blob, ops.sections);
    if (ops.groups) applyEstimateGroups(blob, ops.groups);
    if (ops.line_adds) applyLineAdds(blob, ops.line_adds);

    await dbClient.query(
      `INSERT INTO estimates (id, owner_id, data) VALUES ($1, $2, $3)`,
      [id, ctx.userId || null, JSON.stringify(blob)]
    );
    if (isRef(target.entity_id)) refTable[target.entity_id] = id;
    return {
      entity_type: 'estimate',
      entity_id: id,
      op: 'create',
      created: true,
      summary: `Created estimate ${blob.name || blob.client || id}`,
    };
  }

  if (opType === 'update') {
    const id = resolveRef(target.entity_id, refTable);
    if (!id) throw new Error('estimate.update requires entity_id');
    const r = await dbClient.query('SELECT data FROM estimates WHERE id = $1', [id]);
    if (!r.rows.length) throw new Error(`Estimate not found: ${id}`);
    const data = r.rows[0].data || {};

    const changes = [];

    if (ops.scope !== undefined) {
      data.scope = ops.scope;
      changes.push('scope');
    }
    if (ops.field_updates) {
      for (const k of Object.keys(ops.field_updates)) {
        if (ESTIMATE_BLOCKED_FIELDS.has(k)) continue;
        data[k] = ops.field_updates[k];
      }
      changes.push(`${Object.keys(ops.field_updates).length} field(s)`);
    }
    if (Array.isArray(ops.sections) && ops.sections.length) {
      applyEstimateSections(data, ops.sections);
      changes.push(`${ops.sections.length} section op(s)`);
    }
    if (Array.isArray(ops.groups) && ops.groups.length) {
      applyEstimateGroups(data, ops.groups);
      changes.push(`${ops.groups.length} group op(s)`);
    }
    if (Array.isArray(ops.line_adds) && ops.line_adds.length) {
      applyLineAdds(data, ops.line_adds);
      changes.push(`+${ops.line_adds.length} line(s)`);
    }
    if (Array.isArray(ops.line_edits) && ops.line_edits.length) {
      applyLineEdits(data, ops.line_edits);
      changes.push(`~${ops.line_edits.length} line(s)`);
    }
    if (Array.isArray(ops.line_deletes) && ops.line_deletes.length) {
      applyLineDeletes(data, ops.line_deletes);
      changes.push(`-${ops.line_deletes.length} line(s)`);
    }

    // Strip computed/runtime fields that should never persist.
    delete data.__totals;

    await dbClient.query(
      `UPDATE estimates
          SET data = $1,
              updated_at = CASE
                WHEN data IS DISTINCT FROM $1::jsonb THEN NOW()
                ELSE updated_at
              END
        WHERE id = $2`,
      [JSON.stringify(data), id]
    );

    return {
      entity_type: 'estimate',
      entity_id: id,
      op: 'update',
      changes,
      summary: changes.length
        ? `Estimate ${id}: ${changes.join(', ')}`
        : `Estimate ${id}: no-op`,
    };
  }

  throw new Error(`estimate: unsupported op '${opType}'`);
}

function ensureArray(obj, key) {
  if (!Array.isArray(obj[key])) obj[key] = [];
  return obj[key];
}

// Map a section name (as 86 might write it) to the canonical BT
// category enum the editor uses for grouping. Falls back to 'other'
// for unrecognized names. Centralized here so both applyEstimateSections
// and applyLineAdds can normalize the same way.
const BT_CATEGORY_BY_NAME_HINTS = {
  materials: 'materials', material: 'materials', supplies: 'materials',
  labor: 'labor',
  sub: 'sub', subs: 'sub', subcontractor: 'sub', subcontractors: 'sub',
  gc: 'gc', equipment: 'gc', 'general conditions': 'gc',
};
function btCategoryFromName(name) {
  if (!name) return 'other';
  const lower = String(name).toLowerCase();
  for (const k of Object.keys(BT_CATEGORY_BY_NAME_HINTS)) {
    if (lower.indexOf(k) !== -1) return BT_CATEGORY_BY_NAME_HINTS[k];
  }
  if (BT_CATEGORY_BY_SECTION_NAME[name]) return BT_CATEGORY_BY_SECTION_NAME[name];
  return 'other';
}

// applyEstimateSections — creates SECTION HEADER ROWS in data.lines[].
// Was previously writing to data.sections[] (a vestigial metadata
// array the editor doesn't read), which is why every line 86 added
// with a subgroup_id reference came out with section: null. The
// editor renders section headers from rows in data.lines[] with
// section === '__section_header__' (see estimate-editor.js:632).
// This function now mirrors the editor's newAlternate seeding flow.
function applyEstimateSections(data, sectionOps) {
  const lines = ensureArray(data, 'lines');
  // Default alternate for section header rows when an op doesn't
  // specify one — most "create section" ops happen in context of
  // the active alternate.
  const defaultAltId = data.activeAlternateId
    || ((data.alternates && data.alternates[0] && data.alternates[0].id) || 'alt_default');
  for (const op of sectionOps) {
    const kind = op && op.op;
    if (kind === 'add') {
      const id = op.section_id || newSectionId();
      const name = op.name || 'Section';
      const altId = op.alternateId || op.group_id || defaultAltId;
      lines.push({
        id,
        estimateId: data.id,
        alternateId: altId,
        section: '__section_header__',
        description: name,
        btCategory: op.btCategory || btCategoryFromName(name),
        markup: (op.markup != null && op.markup !== '') ? Number(op.markup) : 0,
      });
    } else if (kind === 'update') {
      const idx = lines.findIndex((l) => l && l.id === op.section_id && l.section === '__section_header__');
      if (idx < 0) throw new Error(`section_id not found in lines[]: ${op.section_id}`);
      if (op.name !== undefined) lines[idx].description = op.name;
      if (op.btCategory !== undefined) lines[idx].btCategory = op.btCategory;
      if (op.markup !== undefined) lines[idx].markup = op.markup === '' ? 0 : Number(op.markup);
    } else if (kind === 'delete') {
      const before = lines.length;
      data.lines = lines.filter((l) => !(l && l.id === op.section_id && l.section === '__section_header__'));
      if (data.lines.length === before) {
        throw new Error(`section_id not found in lines[]: ${op.section_id}`);
      }
    } else if (kind === 'reorder') {
      // Reorder by setting position on each matching header row.
      if (!Array.isArray(op.order)) throw new Error('reorder requires order: [section_id, ...]');
      op.order.forEach((sid, pos) => {
        const h = lines.find((l) => l && l.id === sid && l.section === '__section_header__');
        if (h) h.position = pos;
      });
    } else {
      throw new Error(`section op must be add|update|delete|reorder, got: ${kind}`);
    }
  }
}

// applyEstimateGroups — creates ALTERNATES in data.alternates[] and
// seeds the four standard section headers under each new alternate
// (matching the editor's newAlternate flow at estimate-editor.js:626).
// Was previously writing to data.groups[] (a vestigial metadata
// array the editor doesn't read), which is why 86's "create a group
// called Materials and add lines to it" payload landed with
// section: null and lines stranded under the default Base alternate.
//
// "Group" in 86's vocabulary and in the UI's button label means
// "alternate" (Base, Alt 1, Phase 1, etc.) — the top-level scope set
// that owns a column on the proposal. Inside each alternate, the
// four canonical section headers (Materials, Labor, GC, Subs) get
// pre-created so line_adds.subgroup_id resolves to the right header.
const STANDARD_SECTION_PRESETS = [
  { name: 'Materials & Supplies Costs', btCategory: 'materials' },
  { name: 'Direct Labor',               btCategory: 'labor' },
  { name: 'General Conditions',         btCategory: 'gc' },
  { name: 'Subcontractors Costs',       btCategory: 'sub' },
];
function applyEstimateGroups(data, groupOps) {
  const alternates = ensureArray(data, 'alternates');
  const lines = ensureArray(data, 'lines');
  for (const op of groupOps) {
    const kind = op && op.op;
    if (kind === 'add') {
      const id = op.group_id || ('alt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
      const name = op.name || 'Group';
      const isDefault = !alternates.length;
      alternates.push({
        id,
        name,
        isDefault,
        scope: op.scope || '',
        excludeFromTotal: false,
      });
      // If no active alternate set yet, point at this new one so
      // subsequent ops.sections.add and ops.line_adds use it as
      // their default alternateId.
      if (!data.activeAlternateId || isDefault) {
        data.activeAlternateId = id;
      }
      // Auto-seed the four standard section headers under this
      // alternate so the line items 86 will add next have a place
      // to land. The pre-pass in preRegisterEstimateRefs registers
      // each $ref to its real id, so 86's payload can reference any
      // of these by $ref names later.
      STANDARD_SECTION_PRESETS.forEach((s, idx) => {
        lines.push({
          id: 's' + Date.now() + '_' + idx + '_' + Math.random().toString(36).slice(2, 4),
          estimateId: data.id,
          alternateId: id,
          section: '__section_header__',
          description: s.name,
          btCategory: s.btCategory,
          markup: 0,
        });
      });
    } else if (kind === 'update') {
      const idx = alternates.findIndex((a) => a.id === op.group_id);
      if (idx < 0) throw new Error(`group_id not found in alternates[]: ${op.group_id}`);
      if (op.name !== undefined) alternates[idx].name = op.name;
      if (op.scope !== undefined) alternates[idx].scope = op.scope;
    } else if (kind === 'delete') {
      const before = alternates.length;
      data.alternates = alternates.filter((a) => a.id !== op.group_id);
      // Cascade: also drop any lines (headers + items) belonging to that alternate.
      data.lines = lines.filter((l) => !l || l.alternateId !== op.group_id);
      if (data.alternates.length === before) {
        throw new Error(`group_id not found in alternates[]: ${op.group_id}`);
      }
    } else {
      throw new Error(`group op must be add|update|delete, got: ${kind}`);
    }
  }
}

// Resolve a section header row by its id (subgroup_id from 86). The
// estimate's data.lines mixes "section header" rows (section ===
// '__section_header__') and real line rows. Headers carry the section
// NAME in their `description` and the BT export category in
// `btCategory`. When 86 adds a line to subgroup_id=<header_id>, the
// new line must copy those onto itself so the editor renders it under
// the right subgroup.
function findSubgroupHeader(lines, subgroupId) {
  if (!subgroupId || !Array.isArray(lines)) return null;
  return lines.find(
    (l) => l && l.id === subgroupId && l.section === '__section_header__'
  ) || null;
}

// Map section names to BT export categories. The four standard
// subgroups all have a canonical btCategory; anything else falls
// through to 'other' (the BT export coalesces these into General
// Conditions on the proposal).
const BT_CATEGORY_BY_SECTION_NAME = {
  'Materials & Supplies': 'materials',
  'Materials': 'materials',
  'Direct Labor': 'labor',
  'Labor': 'labor',
  'General Conditions': 'gc',
  'Subcontractors': 'sub',
  'Subcontractors Costs': 'sub',
  'Subs': 'sub',
};

// Normalize an incoming line-input object to the canonical field
// names the estimate editor reads. 86 (and the docs) say
// `unit_cost` / `markup_pct`, but the editor renders from `unitCost`
// and `markup` — without this normalization, payload-added lines
// showed up at $0.00 with no markup because the JSONB blob carried
// keys the UI doesn't read. Accept every common variant 86 might
// emit (snake_case, camelCase, the catalog's `unit_price`) and
// always emit canonical camelCase to the row.
function pickNum(obj, keys) {
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '') return Number(obj[k]);
  }
  return null;
}

function applyLineAdds(data, lineAdds) {
  const lines = ensureArray(data, 'lines');
  const alternates = Array.isArray(data.alternates) ? data.alternates : [];
  for (const add of lineAdds) {
    // Resolve which subgroup this line belongs to. Input shapes 86
    // might send (we accept all for back-compat):
    //   1. subgroup_id   — preferred. Either a section header row id
    //                      OR an alternate (group) id. If it matches
    //                      a header in lines[], copy that header's
    //                      name+btCategory. If it matches an alternate
    //                      in alternates[] AND the line carries a
    //                      bt-category hint (or one can be inferred
    //                      from the section/name), pick the matching
    //                      section header WITHIN that alternate.
    //   2. section       — direct section name ("Materials & Supplies").
    //   3. section_name  — legacy alias for `section`.
    //   4. alternateId   — explicit "put this line in alternate X".
    let sectionName = add.section || add.section_name || null;
    let btCategory  = add.btCategory || add.bt_category || null;
    let alternateId = add.alternateId || add.group_id || null;
    if (add.subgroup_id) {
      const header = findSubgroupHeader(lines, add.subgroup_id);
      if (header) {
        sectionName = sectionName || header.description || null;
        btCategory  = btCategory  || header.btCategory  || null;
        alternateId = alternateId || header.alternateId || null;
      } else {
        // subgroup_id may be an ALTERNATE id (86 conflates "group"
        // with "section"). If it matches an alternate, route the line
        // to that alternate and pick the matching section header
        // within it (by btCategory hint if 86 gave one, else by
        // section-name match, else the first header in the alternate).
        const alt = alternates.find((a) => a.id === add.subgroup_id);
        if (alt) {
          alternateId = alternateId || alt.id;
          const altHeaders = lines.filter((l) =>
            l && l.section === '__section_header__' && l.alternateId === alt.id
          );
          let chosen = null;
          if (btCategory) {
            chosen = altHeaders.find((h) => h.btCategory === btCategory);
          }
          if (!chosen && sectionName) {
            chosen = altHeaders.find((h) => h.description === sectionName);
          }
          if (!chosen) chosen = altHeaders[0] || null;
          if (chosen) {
            sectionName = sectionName || chosen.description || null;
            btCategory  = btCategory  || chosen.btCategory  || null;
          }
        }
      }
    }
    if (!btCategory && sectionName) {
      btCategory = BT_CATEGORY_BY_SECTION_NAME[sectionName] || btCategoryFromName(sectionName);
    }

    // Cost: accept unit_cost / unitCost / unit_price (catalog's name).
    // Markup: accept markup_pct / markupPct / markup. Empty string for
    // markup means "inherit section default" — preserve that intent
    // so per-line overrides work; otherwise default to null.
    const unitCost = pickNum(add, ['unit_cost', 'unitCost', 'unit_price', 'unitPrice']);
    const markupRaw = (add.markup !== undefined) ? add.markup
                    : (add.markup_pct !== undefined) ? add.markup_pct
                    : (add.markupPct !== undefined) ? add.markupPct
                    : null;
    const markup = (markupRaw === '' || markupRaw == null) ? '' : Number(markupRaw);

    const row = {
      id: add.line_id || newLineId(),
      estimateId: data.id,
      // Use the resolved alternateId from the subgroup_id lookup above
      // when present (the header/alternate match path); fall back to
      // the explicit alternateId/group_id on the line, then to the
      // active alternate on the estimate, then to 'alt_default'.
      alternateId: alternateId
        || data.activeAlternateId
        || 'alt_default',
      section: sectionName,
      btCategory: btCategory,
      description: add.description || '',
      qty: pickNum(add, ['qty', 'quantity']) || 0,
      unit: add.unit || '',
      // Canonical editor field names. unitCost is the source of truth
      // the line table renders from (estimate-editor.js:813 etc.).
      unitCost: unitCost != null ? unitCost : 0,
      markup: markup,
    };
    lines.push(row);
  }
}

// Same normalization as applyLineAdds — map snake_case / unit_price
// input keys to the camelCase fields the editor reads. Without this,
// 86's line_edits with `fields: {unit_cost: 5.99}` would write a
// `unit_cost` property the editor never looks at, leaving the
// displayed cost unchanged.
function normalizeLineFieldKey(k) {
  if (k === 'unit_cost' || k === 'unit_price' || k === 'unitPrice') return 'unitCost';
  if (k === 'markup_pct' || k === 'markupPct') return 'markup';
  if (k === 'quantity') return 'qty';
  return k;
}

function applyLineEdits(data, lineEdits) {
  const lines = ensureArray(data, 'lines');
  for (const edit of lineEdits) {
    const idx = lines.findIndex((l) => l.id === edit.line_id);
    if (idx < 0) throw new Error(`line_id not found: ${edit.line_id}`);
    const f = edit.fields || {};
    for (const k of Object.keys(f)) {
      // Skip blocked keys; let typed fields coerce gently.
      if (k === 'id' || k === 'estimateId') continue;
      const targetKey = normalizeLineFieldKey(k);
      const numericKeys = new Set(['qty', 'unitCost']);
      if (numericKeys.has(targetKey)) {
        lines[idx][targetKey] = f[k] != null && f[k] !== '' ? Number(f[k]) : null;
      } else if (targetKey === 'markup') {
        // Markup empty string means "inherit section default" —
        // preserve that vs null/0 which would override to no markup.
        lines[idx][targetKey] = (f[k] === '' || f[k] == null) ? '' : Number(f[k]);
      } else {
        lines[idx][targetKey] = f[k];
      }
    }
  }
}

function applyLineDeletes(data, lineDeletes) {
  const lines = ensureArray(data, 'lines');
  const ids = new Set(lineDeletes);
  data.lines = lines.filter((l) => !ids.has(l.id));
}

// ──────────────────────────────────────────────────────────────────
// dispatchJob — handles ops on entity_type='job'.
//
// Job state is split across jobs.data (JSONB blob with phases,
// changeOrders, purchaseOrders, invoices, etc.), node_graphs.data
// (graph topology + values), and qb_cost_lines.linked_node_id (QB
// assignments). All mutations happen inside the outer transaction so
// a multi-section apply is atomic.
// ──────────────────────────────────────────────────────────────────

async function dispatchJob(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  const id = resolveRef(target.entity_id, refTable);
  if (!id) throw new Error('job ops require entity_id');
  await assertTargetOrg(dbClient, 'job', id, ctx && ctx.organizationId);

  const r = await dbClient.query('SELECT data FROM jobs WHERE id = $1', [id]);
  if (!r.rows.length) throw new Error(`Job not found: ${id}`);
  const data = r.rows[0].data || {};

  const changes = [];

  // Top-level job blob fields
  if (ops.field_updates && Object.keys(ops.field_updates).length) {
    for (const k of Object.keys(ops.field_updates)) {
      if (JOB_BLOCKED_FIELDS.has(k)) continue;
      data[k] = ops.field_updates[k];
    }
    changes.push(`${Object.keys(ops.field_updates).length} field(s)`);
  }

  // Phase updates — mutate items in data.phases by matching id.
  if (Array.isArray(ops.phase_updates) && ops.phase_updates.length) {
    if (!Array.isArray(data.phases)) data.phases = [];
    for (const pu of ops.phase_updates) {
      if (!pu.phase_id) throw new Error('phase_updates[].phase_id required');
      const idx = data.phases.findIndex((p) => p.id === pu.phase_id);
      if (idx < 0) throw new Error(`phase_id not found on job ${id}: ${pu.phase_id}`);
      const p = data.phases[idx];
      if (pu.pct_complete !== undefined) p.pctComplete = Number(pu.pct_complete);
      if (pu.materials   !== undefined) p.materials   = Number(pu.materials);
      if (pu.labor       !== undefined) p.labor       = Number(pu.labor);
      if (pu.sub         !== undefined) p.sub         = Number(pu.sub);
      if (pu.equipment   !== undefined) p.equipment   = Number(pu.equipment);
      if (pu.buildingId  !== undefined) p.buildingId  = pu.buildingId;
    }
    changes.push(`${ops.phase_updates.length} phase(s)`);
  }

  // Change orders / purchase orders / invoices — array op pattern with
  // {op:'create'|'update'|'delete', *_id?, fields}.
  function applyArrayOps(arrName, items, idKey, displayName) {
    if (!Array.isArray(data[arrName])) data[arrName] = [];
    for (const op of items) {
      if (!op || !op.op) throw new Error(`${arrName}[].op required`);
      if (op.op === 'create') {
        const idVal = op[idKey] || (arrName.slice(0, 2) + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        const row = Object.assign({ id: idVal, jobId: id }, op.fields || {});
        row[idKey] = idVal;
        data[arrName].push(row);
        if (isRef(op[idKey])) refTable[op[idKey]] = idVal;
      } else if (op.op === 'update') {
        const idVal = resolveRef(op[idKey], refTable);
        if (!idVal) throw new Error(`${arrName}[].update requires ${idKey}`);
        const idx = data[arrName].findIndex((x) => x.id === idVal || x[idKey] === idVal);
        if (idx < 0) throw new Error(`${displayName} ${idVal} not found on job ${id}`);
        Object.assign(data[arrName][idx], op.fields || {});
      } else if (op.op === 'delete') {
        const idVal = resolveRef(op[idKey], refTable);
        const before = data[arrName].length;
        data[arrName] = data[arrName].filter((x) => x.id !== idVal && x[idKey] !== idVal);
        if (data[arrName].length === before) {
          throw new Error(`${displayName} ${idVal} not found on job ${id} for delete`);
        }
      } else {
        throw new Error(`${arrName}[].op must be create|update|delete, got: ${op.op}`);
      }
    }
  }

  if (Array.isArray(ops.change_orders) && ops.change_orders.length) {
    applyArrayOps('changeOrders', ops.change_orders, 'co_id', 'change_order');
    changes.push(`${ops.change_orders.length} CO op(s)`);
  }
  if (Array.isArray(ops.purchase_orders) && ops.purchase_orders.length) {
    applyArrayOps('purchaseOrders', ops.purchase_orders, 'po_id', 'purchase_order');
    changes.push(`${ops.purchase_orders.length} PO op(s)`);
  }
  if (Array.isArray(ops.invoices) && ops.invoices.length) {
    applyArrayOps('invoices', ops.invoices, 'invoice_id', 'invoice');
    changes.push(`${ops.invoices.length} invoice op(s)`);
  }

  // Notes — append to data.agent_notes (free-form on jobs).
  if (Array.isArray(ops.notes) && ops.notes.length) {
    if (!Array.isArray(data.agent_notes)) data.agent_notes = [];
    for (const n of ops.notes) {
      const body = typeof n === 'string' ? n : (n && n.body) || '';
      if (!body) continue;
      data.agent_notes.push({
        id: 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
        body: String(body).slice(0, 4000),
        created_at: new Date().toISOString(),
        created_by_user_id: ctx && ctx.userId || null,
      });
    }
    changes.push(`+${ops.notes.length} note(s)`);
  }

  // Write the job blob back atomically.
  await dbClient.query(
    `UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2`,
    [JSON.stringify(data), id]
  );

  // Graph mutations — these live on node_graphs.data, not jobs.data.
  // We do a read-modify-write inside the same transaction so
  // graph + qb_assignments + node_values + wire_updates all serialize.
  const needsGraph =
    (ops.node_values && ops.node_values.length) ||
    (ops.wire_updates && ops.wire_updates.length) ||
    (ops.graph && ((ops.graph.nodes && ops.graph.nodes.length) ||
                   (ops.graph.wires && ops.graph.wires.length)));
  if (needsGraph) {
    const gRes = await dbClient.query(
      'SELECT data FROM node_graphs WHERE job_id = $1 FOR UPDATE',
      [id]
    );
    const graph = (gRes.rows.length && gRes.rows[0].data) || { nodes: [], wires: [] };
    if (!Array.isArray(graph.nodes)) graph.nodes = [];
    if (!Array.isArray(graph.wires)) graph.wires = [];

    // node_values: shorthand for "set the .value field on these nodes".
    if (Array.isArray(ops.node_values)) {
      for (const nv of ops.node_values) {
        const nid = resolveRef(nv.node_id, refTable);
        const idx = graph.nodes.findIndex((n) => n.id === nid);
        if (idx < 0) throw new Error(`node_id not found on job ${id}: ${nid}`);
        graph.nodes[idx].value = Number(nv.amount);
      }
      changes.push(`${ops.node_values.length} node value(s)`);
    }

    // wire_updates: pct_complete / alloc_pct on existing wires.
    if (Array.isArray(ops.wire_updates)) {
      for (const wu of ops.wire_updates) {
        const fromId = resolveRef(wu.from_node_id, refTable);
        const toId   = resolveRef(wu.to_node_id, refTable);
        const idx = graph.wires.findIndex((w) =>
          (w.from === fromId || w.fromNodeId === fromId) &&
          (w.to === toId || w.toNodeId === toId)
        );
        if (idx < 0) throw new Error(`wire ${fromId} → ${toId} not found on job ${id}`);
        if (wu.pct_complete !== undefined) graph.wires[idx].pctComplete = Number(wu.pct_complete);
        if (wu.alloc_pct    !== undefined) graph.wires[idx].allocPct    = Number(wu.alloc_pct);
      }
      changes.push(`${ops.wire_updates.length} wire update(s)`);
    }

    // graph.nodes — create/update/delete topology
    if (ops.graph && Array.isArray(ops.graph.nodes)) {
      for (const nop of ops.graph.nodes) {
        if (nop.op === 'create') {
          const nid = (nop.node_id && !isRef(nop.node_id))
            ? nop.node_id
            : ('node_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
          const row = Object.assign({
            id: nid,
            kind: nop.kind || 'phase',
            label: nop.label || '',
            position: nop.position || { x: 0, y: 0 },
            value: nop.value != null ? Number(nop.value) : 0,
          }, nop.fields || {});
          graph.nodes.push(row);
          if (isRef(nop.node_id)) refTable[nop.node_id] = nid;
        } else if (nop.op === 'update') {
          const nid = resolveRef(nop.node_id, refTable);
          const idx = graph.nodes.findIndex((n) => n.id === nid);
          if (idx < 0) throw new Error(`graph node ${nid} not found`);
          Object.assign(graph.nodes[idx], nop.fields || {});
          if (nop.label !== undefined)    graph.nodes[idx].label = nop.label;
          if (nop.position !== undefined) graph.nodes[idx].position = nop.position;
          if (nop.value !== undefined)    graph.nodes[idx].value = Number(nop.value);
        } else if (nop.op === 'delete') {
          const nid = resolveRef(nop.node_id, refTable);
          graph.nodes = graph.nodes.filter((n) => n.id !== nid);
          // Also drop wires touching the deleted node.
          graph.wires = graph.wires.filter((w) =>
            w.from !== nid && w.to !== nid &&
            w.fromNodeId !== nid && w.toNodeId !== nid
          );
        } else {
          throw new Error(`graph.nodes[].op must be create|update|delete, got: ${nop.op}`);
        }
      }
      changes.push(`${ops.graph.nodes.length} graph node op(s)`);
    }

    // graph.wires — create/delete only (updates go through wire_updates).
    if (ops.graph && Array.isArray(ops.graph.wires)) {
      for (const wop of ops.graph.wires) {
        const fromId = resolveRef(wop.from, refTable);
        const toId   = resolveRef(wop.to, refTable);
        if (wop.op === 'create') {
          graph.wires.push({
            from: fromId, to: toId,
            allocPct: wop.alloc_pct != null ? Number(wop.alloc_pct) : 100,
            pctComplete: wop.pct_complete != null ? Number(wop.pct_complete) : 0,
          });
        } else if (wop.op === 'delete') {
          graph.wires = graph.wires.filter((w) =>
            !((w.from === fromId || w.fromNodeId === fromId) &&
              (w.to === toId || w.toNodeId === toId))
          );
        } else {
          throw new Error(`graph.wires[].op must be create|delete, got: ${wop.op}`);
        }
      }
      changes.push(`${ops.graph.wires.length} graph wire op(s)`);
    }

    await dbClient.query(
      `INSERT INTO node_graphs (job_id, data) VALUES ($1, $2)
       ON CONFLICT (job_id) DO UPDATE SET data = $2, updated_at = NOW()`,
      [id, JSON.stringify(graph)]
    );
  }

  // QB assignments — direct SQL on qb_cost_lines.linked_node_id.
  if (Array.isArray(ops.qb_assignments) && ops.qb_assignments.length) {
    for (const a of ops.qb_assignments) {
      if (!a.line_id) throw new Error('qb_assignments[].line_id required');
      const nid = resolveRef(a.node_id, refTable);
      // node_id can be null to UNLINK; that's allowed.
      const upd = await dbClient.query(
        `UPDATE qb_cost_lines SET linked_node_id = $1, updated_at = NOW()
           WHERE id = $2 AND job_id = $3`,
        [nid || null, a.line_id, id]
      );
      if (!upd.rowCount) {
        throw new Error(`qb_cost_lines row ${a.line_id} not found on job ${id}`);
      }
    }
    changes.push(`${ops.qb_assignments.length} qb assignment(s)`);
  }

  return {
    entity_type: 'job',
    entity_id: id,
    op: 'update',
    changes,
    summary: changes.length
      ? `Job ${id}: ${changes.join(', ')}`
      : `Job ${id}: no-op`,
  };
}

// ──────────────────────────────────────────────────────────────────
// dispatchLead — handles ops on entity_type='lead'.
// ──────────────────────────────────────────────────────────────────

function newLeadId() {
  return 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function dispatchLead(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  await assertTargetOrg(dbClient, 'lead', target.entity_id, ctx && ctx.organizationId);

  const opType = ops.op || (target.entity_id ? 'update' : 'create');
  const fields = ops.fields || {};

  if (opType === 'create') {
    if (!fields.title) throw new Error('lead.create requires fields.title');
    const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newLeadId();

    const cols = ['id', 'created_by'];
    const vals = [id, ctx.userId || null];
    if (!fields.status) fields.status = 'new';
    for (const k of Object.keys(fields)) {
      if (!LEAD_EDITABLE_FIELDS.has(k)) continue;
      cols.push(k);
      vals.push(fields[k]);
    }
    const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
    await dbClient.query(
      `INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`,
      vals
    );
    if (isRef(target.entity_id)) refTable[target.entity_id] = id;

    // Notes — appended to leads.notes free-text column when notes[] is provided.
    if (Array.isArray(ops.notes) && ops.notes.length) {
      await appendLeadNotes(dbClient, id, ops.notes);
    }

    return {
      entity_type: 'lead',
      entity_id: id,
      op: 'create',
      created: true,
      summary: `Created lead "${fields.title}" (${id})`,
    };
  }

  if (opType === 'update') {
    const id = resolveRef(target.entity_id, refTable);
    if (!id) throw new Error('lead.update requires entity_id');
    const exists = await dbClient.query('SELECT id FROM leads WHERE id = $1', [id]);
    if (!exists.rows.length) throw new Error(`Lead not found: ${id}`);
    const fieldKeys = Object.keys(fields);
    if (fieldKeys.length) {
      const sets = fieldKeys.map((k, i) => `${k} = $${i + 1}`);
      const params = fieldKeys.map((k) => fields[k]);
      sets.push('updated_at = NOW()');
      params.push(id);
      await dbClient.query(
        `UPDATE leads SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
    }
    if (Array.isArray(ops.notes) && ops.notes.length) {
      await appendLeadNotes(dbClient, id, ops.notes);
    }
    return {
      entity_type: 'lead',
      entity_id: id,
      op: 'update',
      fields_changed: fieldKeys,
      summary: fieldKeys.length
        ? `Lead ${id}: updated ${fieldKeys.length} field(s)`
        : `Lead ${id}: notes only`,
    };
  }
  throw new Error(`lead: unsupported op '${opType}'`);
}

async function appendLeadNotes(dbClient, leadId, notes) {
  // leads.notes is a single TEXT column, not a JSONB array. Append
  // each note as a new paragraph with a date prefix so the audit
  // trail stays readable in the UI.
  const stamped = notes
    .map((n) => {
      const body = typeof n === 'string' ? n : (n && n.body) || '';
      if (!body) return null;
      return `[${new Date().toISOString().slice(0, 10)}] ${String(body).trim()}`;
    })
    .filter(Boolean)
    .join('\n\n');
  if (!stamped) return;
  await dbClient.query(
    `UPDATE leads
        SET notes = CASE
          WHEN notes IS NULL OR notes = '' THEN $1
          ELSE notes || E'\n\n' || $1
        END,
            updated_at = NOW()
      WHERE id = $2`,
    [stamped, leadId]
  );
}

// ──────────────────────────────────────────────────────────────────
// dispatchSchedule — handles ops on entity_type='schedule'.
//
// Schedule entries live in schedule_entries with discrete columns
// (NOT JSONB). Each block in ops.blocks corresponds to one row op.
// ──────────────────────────────────────────────────────────────────

function newScheduleEntryId() {
  return 'sched_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function dispatchSchedule(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  if (!Array.isArray(ops.blocks) || !ops.blocks.length) {
    throw new Error('schedule ops require non-empty blocks[]');
  }

  // P0-2 org scope — tolerant OR-IS-NULL (no-op for AGX). Scopes the
  // create-time job check + the update/delete by entry org.
  const schedOrgId = (ctx && ctx.organizationId) || null;

  const created = [];
  const updated = [];
  const deleted = [];

  for (const b of ops.blocks) {
    if (b.op === 'create') {
      const jobId = resolveRef(b.jobId || b.job_id, refTable);
      if (!jobId) throw new Error('schedule.create requires jobId');
      const jobChk = schedOrgId
        ? await dbClient.query('SELECT id FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)', [jobId, schedOrgId])
        : await dbClient.query('SELECT id FROM jobs WHERE id = $1', [jobId]);
      if (!jobChk.rows.length) throw new Error(`schedule.create: job ${jobId} not found`);
      const id = (b.entry_id && !isRef(b.entry_id)) ? b.entry_id : newScheduleEntryId();
      const days = Math.max(1, Number(b.days || 1));
      const crew = Array.isArray(b.crew) ? b.crew : [];
      const startDate = b.startDate || b.start_date;
      if (!startDate) throw new Error('schedule.create requires startDate');
      await dbClient.query(
        `INSERT INTO schedule_entries
           (id, job_id, start_date, days, crew, includes_weekends, status, notes, created_by)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9)`,
        [
          id, jobId, startDate, days, JSON.stringify(crew),
          !!(b.includesWeekends || b.includes_weekends),
          b.status || 'planned',
          b.notes || null,
          ctx.userId || null,
        ]
      );
      if (isRef(b.entry_id)) refTable[b.entry_id] = id;
      created.push(id);
    } else if (b.op === 'update') {
      const id = resolveRef(b.entry_id, refTable);
      const sets = [];
      const params = [];
      let p = 1;
      function addSet(col, val) {
        if (val === undefined) return;
        sets.push(`${col} = $${p++}`);
        params.push(val);
      }
      addSet('start_date', b.startDate || b.start_date);
      addSet('days', b.days);
      if (b.crew !== undefined) {
        sets.push(`crew = $${p++}::jsonb`);
        params.push(JSON.stringify(b.crew || []));
      }
      addSet('includes_weekends', b.includesWeekends ?? b.includes_weekends);
      addSet('status', b.status);
      addSet('notes', b.notes);
      if (!sets.length) continue;
      sets.push('updated_at = NOW()');
      params.push(id);
      let schedWhere = `id = $${params.length}`;
      if (schedOrgId) { params.push(schedOrgId); schedWhere += ` AND (organization_id = $${params.length} OR organization_id IS NULL)`; }
      const r = await dbClient.query(
        `UPDATE schedule_entries SET ${sets.join(', ')} WHERE ${schedWhere}`,
        params
      );
      if (!r.rowCount) throw new Error(`schedule entry ${id} not found for update`);
      updated.push(id);
    } else if (b.op === 'delete') {
      const id = resolveRef(b.entry_id, refTable);
      const delParams = [id];
      let delWhere = 'id = $1';
      if (schedOrgId) { delParams.push(schedOrgId); delWhere += ' AND (organization_id = $2 OR organization_id IS NULL)'; }
      const r = await dbClient.query(
        `DELETE FROM schedule_entries WHERE ${delWhere}`, delParams
      );
      if (!r.rowCount) throw new Error(`schedule entry ${id} not found for delete`);
      deleted.push(id);
    }
  }

  const parts = [];
  if (created.length) parts.push(`+${created.length} entries`);
  if (updated.length) parts.push(`~${updated.length} entries`);
  if (deleted.length) parts.push(`-${deleted.length} entries`);

  return {
    entity_type: 'schedule',
    entity_id: target.entity_id || null,
    op: 'multi',
    created, updated, deleted,
    summary: `Schedule: ${parts.join(', ') || 'no-op'}`,
  };
}

// ──────────────────────────────────────────────────────────────────
// dispatchSystem — platform-side writes (watches, future skill packs).
//
// v1 implements `watch_ops` only — create/archive rule-based watches.
// Skill packs / field tools / staff agent definitions stay as
// approval-card tools on the Principal for now.
// ──────────────────────────────────────────────────────────────────

function newWatchId() {
  return 'watch_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

async function dispatchSystem(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  // staff_agent_ops still pending — requires Anthropic SDK calls
  // (beta.agents.create/update/archive). The propose_create_staff_agent
  // tool remains on the Principal until that lands.
  if (Array.isArray(ops.staff_agent_ops) && ops.staff_agent_ops.length) {
    throw new Error(
      'system.ops.staff_agent_ops not yet implemented — Anthropic-side ' +
      'agent registration needs the beta.agents.* API path. Use the ' +
      'propose_create_staff_agent approval-card tool for now.'
    );
  }

  const created = [];
  const archived = [];
  const updated = [];

  // skill_pack_ops — CRUD on org_skill_packs.
  // Shape: [{op:'add'|'edit'|'delete', pack_id?, fields:{name, body, description?, agents?, category?, triggers?}}]
  if (Array.isArray(ops.skill_pack_ops) && ops.skill_pack_ops.length) {
    const orgId = (ctx && ctx.organizationId) || null;
    if (!orgId) throw new Error('skill_pack_ops requires organization context');
    for (const sp of ops.skill_pack_ops) {
      if (!sp || !sp.op) throw new Error('skill_pack_ops[].op required');
      if (sp.op === 'add') {
        const f = sp.fields || {};
        if (!f.name) throw new Error('skill_pack_ops add requires fields.name');
        if (!f.body) throw new Error('skill_pack_ops add requires fields.body');
        const r = await dbClient.query(
          `INSERT INTO org_skill_packs
             (organization_id, name, body, description, agents, category, triggers)
           VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7::jsonb)
           ON CONFLICT (organization_id, name) DO UPDATE
             SET body = EXCLUDED.body,
                 description = EXCLUDED.description,
                 agents = EXCLUDED.agents,
                 category = EXCLUDED.category,
                 triggers = EXCLUDED.triggers,
                 archived_at = NULL,
                 updated_at = NOW()
           RETURNING id`,
          [
            orgId, f.name, f.body, f.description || '',
            JSON.stringify(f.agents || ['job']),
            f.category || null,
            JSON.stringify(f.triggers || {}),
          ]
        );
        created.push({ kind: 'skill_pack', id: r.rows[0].id, name: f.name });
      } else if (sp.op === 'edit') {
        if (!sp.pack_id) throw new Error('skill_pack_ops edit requires pack_id');
        const sets = [];
        const vals = [];
        const f = sp.fields || {};
        let p = 1;
        if (f.name !== undefined)        { sets.push(`name = $${p++}`); vals.push(f.name); }
        if (f.body !== undefined)        { sets.push(`body = $${p++}`); vals.push(f.body); }
        if (f.description !== undefined) { sets.push(`description = $${p++}`); vals.push(f.description); }
        if (f.agents !== undefined)      { sets.push(`agents = $${p++}::jsonb`); vals.push(JSON.stringify(f.agents)); }
        if (f.category !== undefined)    { sets.push(`category = $${p++}`); vals.push(f.category); }
        if (f.triggers !== undefined)    { sets.push(`triggers = $${p++}::jsonb`); vals.push(JSON.stringify(f.triggers)); }
        if (!sets.length) continue;
        sets.push('updated_at = NOW()');
        vals.push(sp.pack_id);
        vals.push(orgId);
        const r = await dbClient.query(
          `UPDATE org_skill_packs SET ${sets.join(', ')}
             WHERE id = $${p++} AND organization_id = $${p}`,
          vals
        );
        if (!r.rowCount) throw new Error(`skill_pack ${sp.pack_id} not found in this org`);
        updated.push({ kind: 'skill_pack', id: sp.pack_id });
      } else if (sp.op === 'delete') {
        if (!sp.pack_id) throw new Error('skill_pack_ops delete requires pack_id');
        const r = await dbClient.query(
          `UPDATE org_skill_packs SET archived_at = NOW(), updated_at = NOW()
             WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL`,
          [sp.pack_id, orgId]
        );
        if (!r.rowCount) throw new Error(`skill_pack ${sp.pack_id} not found or already archived`);
        archived.push({ kind: 'skill_pack', id: sp.pack_id });
      } else {
        throw new Error(`skill_pack_ops[].op must be add|edit|delete, got: ${sp.op}`);
      }
    }
  }

  // field_tool_ops — CRUD on field_tools.
  // Shape: [{op:'create'|'edit'|'delete', tool_id?, fields:{name, description?, category?, html_body}}]
  if (Array.isArray(ops.field_tool_ops) && ops.field_tool_ops.length) {
    for (const ft of ops.field_tool_ops) {
      if (!ft || !ft.op) throw new Error('field_tool_ops[].op required');
      if (ft.op === 'create') {
        const f = ft.fields || {};
        if (!f.name)      throw new Error('field_tool_ops create requires fields.name');
        if (!f.html_body) throw new Error('field_tool_ops create requires fields.html_body');
        const id = ft.tool_id && !isRef(ft.tool_id)
          ? ft.tool_id
          : ('tool_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
        await dbClient.query(
          `INSERT INTO field_tools (id, name, description, category, html_body, created_by)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [id, f.name, f.description || null, f.category || null, f.html_body, ctx.userId || null]
        );
        if (isRef(ft.tool_id)) refTable[ft.tool_id] = id;
        created.push({ kind: 'field_tool', id, name: f.name });
      } else if (ft.op === 'edit') {
        const id = resolveRef(ft.tool_id, refTable);
        if (!id) throw new Error('field_tool_ops edit requires tool_id');
        const f = ft.fields || {};
        const sets = [];
        const vals = [];
        let p = 1;
        if (f.name        !== undefined) { sets.push(`name = $${p++}`);        vals.push(f.name); }
        if (f.description !== undefined) { sets.push(`description = $${p++}`); vals.push(f.description); }
        if (f.category    !== undefined) { sets.push(`category = $${p++}`);    vals.push(f.category); }
        if (f.html_body   !== undefined) { sets.push(`html_body = $${p++}`);   vals.push(f.html_body); }
        if (!sets.length) continue;
        sets.push('updated_at = NOW()');
        vals.push(id);
        // P0-2 — scope to the caller's org and refuse to edit system
        // (built-in) tools via payload. Tolerant OR-IS-NULL for legacy
        // un-stamped org tools; no-op for AGX.
        const ftOrgId = (ctx && ctx.organizationId) || null;
        let ftWhere = `id = $${p}`;
        if (ftOrgId) { vals.push(ftOrgId); ftWhere += ` AND (organization_id = $${vals.length} OR organization_id IS NULL) AND is_system = false`; }
        const r = await dbClient.query(
          `UPDATE field_tools SET ${sets.join(', ')} WHERE ${ftWhere}`,
          vals
        );
        if (!r.rowCount) throw new Error(`field_tool ${id} not found`);
        updated.push({ kind: 'field_tool', id });
      } else if (ft.op === 'delete') {
        const id = resolveRef(ft.tool_id, refTable);
        if (!id) throw new Error('field_tool_ops delete requires tool_id');
        // P0-2 — scope to the caller's org and never delete system tools.
        const ftDelOrgId = (ctx && ctx.organizationId) || null;
        const ftDelParams = [id];
        let ftDelWhere = 'id = $1';
        if (ftDelOrgId) { ftDelParams.push(ftDelOrgId); ftDelWhere += ' AND (organization_id = $2 OR organization_id IS NULL) AND is_system = false'; }
        const r = await dbClient.query(`DELETE FROM field_tools WHERE ${ftDelWhere}`, ftDelParams);
        if (!r.rowCount) throw new Error(`field_tool ${id} not found`);
        archived.push({ kind: 'field_tool', id });
      } else {
        throw new Error(`field_tool_ops[].op must be create|edit|delete, got: ${ft.op}`);
      }
    }
  }

  // link_ops — cross-entity linkage. Currently supports:
  //   - link_job_to_client: {op:'link_job_to_client', job_id, client_id}
  //   - link_property_to_parent: {op:'link_property_to_parent', property_id, parent_client_id}
  //   - attach_files: {op:'attach_files', attachment_ids:[...], target_entity_type, target_entity_id}
  if (Array.isArray(ops.link_ops) && ops.link_ops.length) {
    for (const lk of ops.link_ops) {
      if (!lk || !lk.op) throw new Error('link_ops[].op required');
      if (lk.op === 'link_job_to_client') {
        const jobId = resolveRef(lk.job_id, refTable);
        const clientId = resolveRef(lk.client_id, refTable);
        if (!jobId || !clientId) throw new Error('link_job_to_client requires job_id + client_id');
        // P0-2 — both ends must resolve to the caller's org.
        await assertTargetOrg(dbClient, 'job', jobId, ctx && ctx.organizationId);
        await assertTargetOrg(dbClient, 'client', clientId, ctx && ctx.organizationId);
        // Jobs store linked client_id inside the data JSONB blob.
        const jr = await dbClient.query('SELECT data FROM jobs WHERE id = $1', [jobId]);
        if (!jr.rows.length) throw new Error(`job ${jobId} not found`);
        const data = jr.rows[0].data || {};
        data.client_id = clientId;
        await dbClient.query(
          'UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2',
          [JSON.stringify(data), jobId]
        );
        updated.push({ kind: 'job_client_link', job_id: jobId, client_id: clientId });
      } else if (lk.op === 'link_property_to_parent') {
        const propId = resolveRef(lk.property_id, refTable);
        const parentId = resolveRef(lk.parent_client_id, refTable);
        if (!propId || !parentId) throw new Error('link_property_to_parent requires property_id + parent_client_id');
        if (propId === parentId) throw new Error('A client cannot be its own parent');
        // P0-2 — both clients must belong to the caller's org.
        await assertTargetOrg(dbClient, 'client', propId, ctx && ctx.organizationId);
        await assertTargetOrg(dbClient, 'client', parentId, ctx && ctx.organizationId);
        const pc = await dbClient.query('SELECT id FROM clients WHERE id = $1', [parentId]);
        if (!pc.rows.length) throw new Error(`parent client ${parentId} not found`);
        const r = await dbClient.query(
          'UPDATE clients SET parent_client_id = $1, updated_at = NOW() WHERE id = $2',
          [parentId, propId]
        );
        if (!r.rowCount) throw new Error(`property ${propId} not found`);
        updated.push({ kind: 'property_parent_link', property_id: propId, parent_client_id: parentId });
      } else if (lk.op === 'attach_files') {
        // Wave 2 — re-point EXISTING attachment rows to a target entity.
        // Lets 86 wire already-uploaded files to a job/estimate/lead/etc.
        // via the payload DSL instead of a separate REST round-trip.
        // (Upload itself still goes through the attachment routes; this
        // only relinks rows that already exist.)
        const ATTACH_ENTITY_TYPES = ['lead', 'estimate', 'client', 'job', 'sub', 'user', 'org', 'project'];
        const ids = Array.isArray(lk.attachment_ids)
          ? lk.attachment_ids.map((x) => resolveRef(x, refTable)).filter(Boolean).map(String)
          : [];
        const et = lk.target_entity_type;
        const eid = resolveRef(lk.target_entity_id, refTable);
        if (!ids.length) throw new Error('attach_files requires a non-empty attachment_ids[]');
        if (!ATTACH_ENTITY_TYPES.includes(et)) {
          throw new Error(`attach_files target_entity_type must be one of: ${ATTACH_ENTITY_TYPES.join(', ')} (got '${et}')`);
        }
        if (!eid) throw new Error('attach_files requires target_entity_id');
        // P0-2 — the target entity (for the org-scoped types) must belong
        // to the caller's org, and only the caller's own attachment rows
        // may be re-pointed. Tolerant OR-IS-NULL; no-op for AGX.
        if (ORG_SCOPED_TABLE[et]) await assertTargetOrg(dbClient, et, String(eid), ctx && ctx.organizationId);
        const afOrgId = (ctx && ctx.organizationId) || null;
        const ar = afOrgId
          ? await dbClient.query(
              `UPDATE attachments SET entity_type = $1, entity_id = $2 WHERE id = ANY($3::text[]) AND (organization_id = $4 OR organization_id IS NULL)`,
              [et, String(eid), ids, afOrgId])
          : await dbClient.query(
              `UPDATE attachments SET entity_type = $1, entity_id = $2 WHERE id = ANY($3::text[])`,
              [et, String(eid), ids]);
        updated.push({ kind: 'attach_files', count: ar.rowCount, target_entity_type: et, target_entity_id: String(eid) });
      } else {
        throw new Error(`link_ops[].op unsupported: ${lk.op}`);
      }
    }
  }

  if (Array.isArray(ops.watch_ops)) {
    const orgId = (ctx && ctx.organizationId) || null;
    const userId = (ctx && ctx.userId) || null;

    for (const w of ops.watch_ops) {
      if (!w || !w.op) throw new Error('watch_ops[].op required');
      if (w.op === 'create') {
        if (!orgId) throw new Error('watch create requires organization context');
        const id = (w.watch_id && !isRef(w.watch_id)) ? w.watch_id : newWatchId();
        const cadence = w.cadence || (w.kind === 'agent' ? 'daily' : 'daily');
        const timeOfDay = w.time_of_day_utc || '12:00';
        const prompt = w.prompt || w.name || 'Scan';
        // next_fire_at: roughly +1h to avoid firing immediately.
        await dbClient.query(
          `INSERT INTO ai_watches
            (id, organization_id, created_by_user_id, name, description,
             cadence, time_of_day_utc, prompt, kind, agent_key,
             scope_filter, model, schedule_hours, next_fire_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW() + INTERVAL '1 hour')`,
          [
            id, orgId, userId,
            w.name || 'Untitled watch',
            w.description || null,
            cadence, timeOfDay, prompt,
            w.kind || 'rule',
            w.agent_key || null,
            w.scope_filter ? JSON.stringify(w.scope_filter) : null,
            w.model || 'haiku',
            w.schedule_hours || 12,
          ]
        );
        if (isRef(w.watch_id)) refTable[w.watch_id] = id;
        created.push(id);
      } else if (w.op === 'archive') {
        const id = resolveRef(w.watch_id, refTable);
        // P0-2 — scope archive to the caller's org (ai_watches.organization_id
        // is NOT NULL, so a strict equality is correct here).
        const r = orgId
          ? await dbClient.query(
              `UPDATE ai_watches SET archived_at = NOW(), enabled = false WHERE id = $1 AND organization_id = $2`,
              [id, orgId])
          : await dbClient.query(
              `UPDATE ai_watches SET archived_at = NOW(), enabled = false WHERE id = $1`,
              [id]);
        if (!r.rowCount) throw new Error(`watch ${id} not found`);
        archived.push(id);
      } else {
        throw new Error(`watch_ops[].op must be create|archive, got: ${w.op}`);
      }
    }
  }

  const parts = [];
  if (created.length)  parts.push(`+${created.length} created`);
  if (updated.length)  parts.push(`~${updated.length} updated`);
  if (archived.length) parts.push(`-${archived.length} archived`);

  return {
    entity_type: 'system',
    entity_id: target.entity_id || null,
    op: 'multi',
    created, archived, updated,
    summary: `System: ${parts.join(', ') || 'no-op'}`,
  };
}

// ──────────────────────────────────────────────────────────────────
// dispatchOps — main switch by entity_type.
// ──────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────
// dispatchReport — polymorphic report writes (job_reports table).
//
// Supports:
//   - op:'create'  → INSERT a new project-scoped report with
//                    template_type, optional cover_page, optional
//                    sections array. Returns the new report id.
//   - op:'update'  → UPDATE existing row. Either pass `sections`
//                    (full replace) OR use granular ops
//                    (section_adds / section_updates / section_deletes).
//                    cover_page is replaced wholesale if provided.
//
// Mirrors the shape of /api/reports/:entityType/:entityId routes
// in server/routes/reports-routes.js but skips that route's auth +
// org-scope checks (the payload apply path runs in the user's
// session so authn is already established; org-scope is enforced
// at the project lookup below).
// ──────────────────────────────────────────────────────────────────

function newReportId() {
  return 'rpt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function newReportSectionId() {
  return 'sec_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

function normalizeReportSection(s) {
  if (!s || typeof s !== 'object') return null;
  const layout = (s.layout && REPORT_SECTION_LAYOUTS.has(s.layout)) ? s.layout : 'photo-grid';
  const photoLimit = (layout === 'before-after') ? 2 : 200;
  const photoIds = Array.isArray(s.photo_ids)
    ? s.photo_ids.filter((x) => typeof x === 'string').slice(0, photoLimit)
    : [];
  const captionsIn = (s.captions && typeof s.captions === 'object') ? s.captions : {};
  const captions = {};
  photoIds.forEach((pid) => {
    const c = captionsIn[pid];
    if (typeof c === 'string') captions[pid] = c.slice(0, 500);
  });
  return {
    id: typeof s.id === 'string' ? s.id : newReportSectionId(),
    label: typeof s.label === 'string' ? s.label.slice(0, 120) : '',
    layout,
    photo_ids: photoIds,
    captions,
    text_body: typeof s.text_body === 'string' ? s.text_body.slice(0, 20000) : '',
    attachment_ids: Array.isArray(s.attachment_ids)
      ? s.attachment_ids.filter((x) => typeof x === 'string').slice(0, 50)
      : [],
  };
}

function normalizeReportCoverPage(raw) {
  // Mirror of server/routes/reports-routes.js COVER_PAGE_KEYS.
  const KEYS = [
    'company_name', 'pm_name', 'date', 'address', 'subtitle',
    'crew', 'weather', 'hours_on_site',
    'week_ending', 'project_phase', 'schedule_status',
    'stamped_by', 'license_number', 'signed_date',
    'submittal_number', 'spec_section', 'supplier', 'approval_block',
    'walkthrough_date', 'walkthrough_with',
    'survey_date', 'surveyed_by', 'building',
    'co_number', 'co_amount', 'requested_by',
  ];
  if (!raw || typeof raw !== 'object') return { enabled: false };
  const out = { enabled: !!raw.enabled };
  KEYS.forEach((k) => {
    if (typeof raw[k] === 'string') out[k] = raw[k].slice(0, 500);
  });
  return out;
}

async function dispatchReport(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  const explicitOp = ops.op || (target.entity_id ? 'update' : 'create');

  if (explicitOp === 'create') {
    const projectId = resolveRef(ops.parent_id, refTable);
    if (!projectId) throw new Error('report.create requires parent_id (project id)');

    // Confirm the project exists + is in the caller's org (lightweight
    // scope check; mirrors the route's ensureEntityVisible).
    const projChk = await dbClient.query(
      'SELECT id, organization_id FROM projects WHERE id = $1',
      [projectId]
    );
    if (!projChk.rows.length) throw new Error(`report.create: project ${projectId} not found`);
    if (ctx.organizationId && Number(projChk.rows[0].organization_id) !== Number(ctx.organizationId)) {
      throw new Error(`report.create: project ${projectId} not in caller's org`);
    }

    const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newReportId();
    const title = (typeof ops.title === 'string' && ops.title.trim())
      ? ops.title.slice(0, 200)
      : 'Untitled report';
    const sections = Array.isArray(ops.sections)
      ? ops.sections.map(normalizeReportSection).filter(Boolean).slice(0, 50)
      : [];
    const coverPage = normalizeReportCoverPage(ops.cover_page);

    await dbClient.query(
      `INSERT INTO job_reports
         (id, entity_type, entity_id, title, summary, sections, cover_page, template_type, created_by)
       VALUES ($1, 'project', $2, $3, '', $4::jsonb, $5::jsonb, $6, $7)`,
      [
        id, projectId, title,
        JSON.stringify(sections), JSON.stringify(coverPage),
        ops.template_type, ctx.userId || null,
      ]
    );

    if (isRef(target.entity_id)) refTable[target.entity_id] = id;

    return {
      entity_type: 'report',
      entity_id: id,
      op: 'create',
      summary: `Report created (template=${ops.template_type}, ${sections.length} section(s))`,
    };
  }

  // UPDATE path
  const reportId = resolveRef(target.entity_id, refTable);
  if (!reportId) throw new Error('report.update requires target.entity_id');

  // Fetch the existing report (need current sections for granular ops).
  const existing = await dbClient.query(
    'SELECT id, entity_type, entity_id, sections, cover_page FROM job_reports WHERE id = $1',
    [reportId]
  );
  if (!existing.rows.length) throw new Error(`report.update: ${reportId} not found`);
  const row = existing.rows[0];

  // Org-scope check: if it's a project-scoped report, verify the
  // parent project is in the caller's org.
  if (row.entity_type === 'project' && ctx.organizationId) {
    const p = await dbClient.query(
      'SELECT organization_id FROM projects WHERE id = $1',
      [row.entity_id]
    );
    if (p.rows.length && Number(p.rows[0].organization_id) !== Number(ctx.organizationId)) {
      throw new Error(`report.update: ${reportId} parent project not in caller's org`);
    }
  }

  const sets = [];
  const params = [];
  let p = 1;

  if (typeof ops.title === 'string') {
    sets.push(`title = $${p++}`);
    params.push(ops.title.slice(0, 200));
  }
  if (ops.cover_page && typeof ops.cover_page === 'object') {
    sets.push(`cover_page = $${p++}::jsonb`);
    params.push(JSON.stringify(normalizeReportCoverPage(ops.cover_page)));
  }

  // Sections — either full replace (ops.sections) or granular ops
  // (section_adds / section_updates / section_deletes). Granular ops
  // operate on the CURRENT sections from the row.
  let nextSections = null;
  if (Array.isArray(ops.sections)) {
    nextSections = ops.sections.map(normalizeReportSection).filter(Boolean).slice(0, 50);
  } else if (ops.section_adds || ops.section_updates || ops.section_deletes) {
    nextSections = Array.isArray(row.sections) ? row.sections.slice() : [];
    if (Array.isArray(ops.section_deletes)) {
      const delSet = new Set(ops.section_deletes);
      nextSections = nextSections.filter((s) => !delSet.has(s.id));
    }
    if (Array.isArray(ops.section_updates)) {
      const upMap = new Map(ops.section_updates.filter((s) => s && s.id).map((s) => [s.id, s]));
      nextSections = nextSections.map((s) => {
        const u = upMap.get(s.id);
        return u ? normalizeReportSection(Object.assign({}, s, u)) : s;
      });
    }
    if (Array.isArray(ops.section_adds)) {
      ops.section_adds.forEach((s) => {
        const norm = normalizeReportSection(s);
        if (norm) nextSections.push(norm);
      });
    }
    nextSections = nextSections.slice(0, 50);
  }
  if (nextSections != null) {
    sets.push(`sections = $${p++}::jsonb`);
    params.push(JSON.stringify(nextSections));
  }

  if (!sets.length) {
    return {
      entity_type: 'report',
      entity_id: reportId,
      op: 'update',
      summary: `Report ${reportId}: no-op`,
    };
  }

  sets.push('updated_at = NOW()');
  params.push(reportId);
  await dbClient.query(
    `UPDATE job_reports SET ${sets.join(', ')} WHERE id = $${params.length}`,
    params
  );

  const summaryBits = [];
  if (ops.title) summaryBits.push('title');
  if (ops.cover_page) summaryBits.push('cover');
  if (nextSections != null) summaryBits.push(`${nextSections.length} section(s)`);

  return {
    entity_type: 'report',
    entity_id: reportId,
    op: 'update',
    summary: `Report ${reportId} updated (${summaryBits.join(', ') || 'no-op'})`,
  };
}

const DISPATCHERS = {
  client: dispatchClient,
  estimate: dispatchEstimate,
  job: dispatchJob,
  lead: dispatchLead,
  schedule: dispatchSchedule,
  system: dispatchSystem,
  report: dispatchReport,
};

async function dispatchTarget(dbClient, target, refTable, ctx) {
  const fn = DISPATCHERS[target.entity_type];
  if (!fn) {
    throw new Error(
      `Dispatcher for entity_type=${target.entity_type} not yet implemented. ` +
      `Available in this commit: ${Object.keys(DISPATCHERS).join(', ')}.`
    );
  }
  return fn(dbClient, target, refTable, ctx);
}

// ──────────────────────────────────────────────────────────────────
// Wave 1/2 — target-level conditional / bulk / move handling + the
// before/after changeset audit.
//
// These extend the payload vocabulary at the TARGET level (siblings of
// entity_type / entity_id / ops), NOT inside an entity's ops schema, so
// they work uniformly across every dispatcher and need no per-entity
// schema changes. Every concrete write still flows through the existing
// DISPATCHERS map — these helpers only orchestrate, gate, and snapshot.
//
// Target forms understood by applyPayload:
//   1. Regular:     { entity_type, entity_id?, ops, condition? }
//        condition (optional): 'if_exists' | 'if_missing' | 'upsert'
//          if_exists  — dispatch only if the row exists, else skip
//          if_missing — dispatch only if the row is absent, else skip
//          upsert     — exists → update, absent → create
//   2. Bulk:        { entity_type, bulk: { items: [{ entity_id?, ops }, ...] } }
//        Applies the entity_type's dispatcher once per item.
//   3. Move:        { op:'move', source:{...target}, dest:{...target} }
//        Runs source ops then dest ops in one transaction (e.g. delete a
//        child from estimate A, add it to estimate B).
// ──────────────────────────────────────────────────────────────────

// Single-row backing table per entity_type, used for existence checks
// + changeset snapshots. Multi-row / structural types (schedule,
// system) are intentionally absent — they aren't one snapshot-able row
// and don't support conditional gating.
const TABLE_FOR_ENTITY = Object.freeze({
  client: 'clients',
  estimate: 'estimates',
  job: 'jobs',
  lead: 'leads',
  report: 'job_reports',
});

const CONDITION_VALUES = new Set(['if_exists', 'if_missing', 'upsert']);

async function entityExists(dbClient, entityType, entityId) {
  const table = TABLE_FOR_ENTITY[entityType];
  if (!table || !entityId || isRef(entityId)) return false;
  const r = await dbClient.query(`SELECT 1 FROM ${table} WHERE id = $1 LIMIT 1`, [entityId]);
  return r.rowCount > 0;
}

// Full-row JSONB snapshot for the before/after audit. Returns null for
// types we don't snapshot or rows that don't exist.
async function snapshotEntity(dbClient, entityType, entityId) {
  const table = TABLE_FOR_ENTITY[entityType];
  if (!table || !entityId || isRef(entityId)) return null;
  try {
    const r = await dbClient.query(
      `SELECT to_jsonb(t) AS row FROM ${table} t WHERE id = $1 LIMIT 1`, [entityId]
    );
    return r.rows.length ? r.rows[0].row : null;
  } catch (_) {
    return null;
  }
}

// Validate one top-level target (any form). Attaches target_index to a
// PayloadValidationError so the caller can point 86 at the exact slot.
function validateTarget(target, index) {
  try {
    if (!target || typeof target !== 'object') {
      throw new Error('Each target must be an object');
    }
    if (target.op === 'move') {
      for (const side of ['source', 'dest']) {
        const s = target[side];
        if (!s || !s.entity_type) {
          throw new PayloadValidationError(
            `move.${side} requires entity_type`,
            { code: 'missing_field', field_path: `move.${side}.entity_type` }
          );
        }
        validateOps(s.entity_type, s.ops || {});
      }
      return;
    }
    if (!target.entity_type) throw new Error('Each target requires entity_type');
    if (target.bulk) {
      if (!Array.isArray(target.bulk.items) || !target.bulk.items.length) {
        throw new PayloadValidationError(
          'bulk.items must be a non-empty array',
          { code: 'wrong_type', field_path: 'bulk.items', expected: 'non-empty array' }
        );
      }
      for (const item of target.bulk.items) {
        validateOps(target.entity_type, (item && (item.ops || item)) || {});
      }
      return;
    }
    if (target.condition) {
      if (!CONDITION_VALUES.has(target.condition)) {
        throw new PayloadValidationError(
          `Unknown condition '${target.condition}'`,
          { code: 'invalid_enum', field_path: 'condition',
            received: target.condition, expected: [...CONDITION_VALUES] }
        );
      }
      // if_exists / if_missing need a concrete id to test. upsert may
      // create, so it tolerates a missing/ref id.
      if (target.condition !== 'upsert' && (!target.entity_id || isRef(target.entity_id))) {
        throw new PayloadValidationError(
          `condition '${target.condition}' requires a concrete entity_id`,
          { code: 'missing_field', field_path: 'entity_id',
            suggestion: 'Provide the entity_id of the row to test, or use upsert if it may not exist yet.' }
        );
      }
    }
    validateOps(target.entity_type, target.ops || {});
  } catch (err) {
    if (err instanceof PayloadValidationError && err.detail && err.detail.target_index == null) {
      err.detail.target_index = index;
    }
    throw err;
  }
}

// Every entity any target form touches, for advisory locking.
function collectLockSubjects(targets) {
  const subjects = [];
  const add = (et, id) => subjects.push(`payload:${et || '?'}:${id || '$new'}`);
  for (const t of targets) {
    if (!t) continue;
    if (t.op === 'move') {
      if (t.source) add(t.source.entity_type, t.source.entity_id);
      if (t.dest) add(t.dest.entity_type, t.dest.entity_id);
    } else if (t.bulk && Array.isArray(t.bulk.items)) {
      for (const item of t.bulk.items) add(t.entity_type, item && item.entity_id);
    } else {
      add(t.entity_type, t.entity_id);
    }
  }
  return subjects;
}

// Dispatch a single concrete target through DISPATCHERS, capturing a
// before/after row snapshot into the changeset.
async function dispatchConcrete(dbClient, target, refTable, ctx, results, changeset) {
  const before = await snapshotEntity(dbClient, target.entity_type, target.entity_id);
  const result = await dispatchTarget(dbClient, target, refTable, ctx);
  results.push(result);
  // Use the resolved id from the result so $ref-created entities get an
  // 'after' snapshot too.
  const afterId = (result && result.entity_id) || target.entity_id;
  const after = await snapshotEntity(dbClient, target.entity_type, afterId);
  if (before !== null || after !== null) {
    changeset.push({ entity_type: target.entity_type, id: afterId || null, before, after });
  }
}

// Run ONE top-level target (regular | conditional | bulk | move).
async function runTarget(dbClient, target, refTable, ctx, results, changeset) {
  // move — ordered source→dest, each a normal target.
  if (target.op === 'move') {
    await dispatchConcrete(dbClient, target.source, refTable, ctx, results, changeset);
    await dispatchConcrete(dbClient, target.dest, refTable, ctx, results, changeset);
    results.push({
      entity_type: 'move', op: 'move',
      summary: `Moved ${target.source.entity_type} ${target.source.entity_id || '?'} → `
        + `${target.dest.entity_type} ${target.dest.entity_id || '(new)'}`,
    });
    return;
  }

  // bulk — N items of the same entity_type.
  if (target.bulk && Array.isArray(target.bulk.items)) {
    let n = 0;
    for (const item of target.bulk.items) {
      const concrete = {
        entity_type: target.entity_type,
        entity_id: item && item.entity_id,
        ops: (item && (item.ops || item)) || {},
      };
      await dispatchConcrete(dbClient, concrete, refTable, ctx, results, changeset);
      n++;
    }
    results.push({
      entity_type: target.entity_type, op: 'bulk',
      summary: `Bulk applied ${n} ${target.entity_type} item(s)`,
    });
    return;
  }

  // conditional gate.
  if (target.condition) {
    const exists = await entityExists(dbClient, target.entity_type, target.entity_id);
    if (target.condition === 'if_exists' && !exists) {
      results.push({ entity_type: target.entity_type, entity_id: target.entity_id, op: 'skipped',
        summary: `Skipped ${target.entity_type} ${target.entity_id} (if_exists: not found)` });
      return;
    }
    if (target.condition === 'if_missing' && exists) {
      results.push({ entity_type: target.entity_type, entity_id: target.entity_id, op: 'skipped',
        summary: `Skipped ${target.entity_type} ${target.entity_id} (if_missing: already exists)` });
      return;
    }
    if (target.condition === 'upsert') {
      target.ops = target.ops || {};
      target.ops.op = exists ? 'update' : 'create';
    }
  }

  // regular target.
  await dispatchConcrete(dbClient, target, refTable, ctx, results, changeset);
}

// ──────────────────────────────────────────────────────────────────
// applyPayload — top-level apply. Wraps everything in a single PG
// transaction. Per-target advisory locks acquired in stable sorted
// order so concurrent multi-target applies don't deadlock.
//
// Options:
//   { dryRun: bool } — ROLLBACK at the end and return diffs even on
//     success. (Wires up to ?dry_run=true in C6; supported now so the
//     server-side flow is one-piece.)
//   { userId, sourceAgent } — used by dispatchers for attribution.
//
// Returns: { ok, apply_summary, affected_targets, apply_changeset,
//            ref_resolutions }
// Throws on hard validation errors (caller maps to 422/4xx). On a
// PayloadValidationError, err.detail.target_index points at the slot.
// ──────────────────────────────────────────────────────────────────

async function applyPayload(payloadRow, opts = {}) {
  const targets = Array.isArray(payloadRow.targets) ? payloadRow.targets : [];
  if (!targets.length) throw new Error('Payload has no targets');

  // Validate every target up front so we fail fast before any SQL.
  targets.forEach((t, i) => validateTarget(t, i));

  const dbClient = await pool.connect();
  const refTable = Object.create(null);
  const affectedTargets = [];
  const changeset = [];

  try {
    await dbClient.query('BEGIN');

    // Acquire advisory locks across every entity any target form
    // touches, in stable sorted order, so concurrent applies that share
    // entities serialize without deadlocking.
    const lockKeys = collectLockSubjects(targets).sort();
    for (const key of lockKeys) {
      await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }

    // Dispatch in array order so $new_id refs become available to
    // later targets.
    for (let i = 0; i < targets.length; i++) {
      try {
        await runTarget(dbClient, targets[i], refTable, {
          userId: opts.userId,
          organizationId: opts.organizationId,
          sourceAgent: opts.sourceAgent,
        }, affectedTargets, changeset);
      } catch (err) {
        if (err instanceof PayloadValidationError && err.detail && err.detail.target_index == null) {
          err.detail.target_index = i;
        }
        throw err;
      }
    }

    if (opts.dryRun) {
      // Roll back so nothing actually persisted; return the diff-style
      // affected_targets array so the client can render a preview.
      await dbClient.query('ROLLBACK');
      return {
        ok: true,
        dry_run: true,
        apply_summary: buildApplySummary(affectedTargets),
        affected_targets: affectedTargets,
        apply_changeset: changeset,
        ref_resolutions: Object.assign({}, refTable),
      };
    }

    await dbClient.query('COMMIT');
    return {
      ok: true,
      dry_run: false,
      apply_summary: buildApplySummary(affectedTargets),
      affected_targets: affectedTargets,
      apply_changeset: changeset,
      ref_resolutions: Object.assign({}, refTable),
    };
  } catch (err) {
    try { await dbClient.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    dbClient.release();
  }
}

function buildApplySummary(affectedTargets) {
  if (!affectedTargets.length) return 'No targets applied';
  return affectedTargets
    .map((t) => t.summary || `${t.entity_type} ${t.entity_id} (${t.op})`)
    .join('; ');
}

// ──────────────────────────────────────────────────────────────────
// Filename helpers — used both at emit time (ai-routes
// make86OnCustomToolUse) and from payload-routes when generating
// filenames for CSV / watch / QB-sync emitters. Single source.
//
//   single-target: `{EntityType}.{IDorRef}-{ShortName}.{YYYY-MM-DD}.p86.json`
//   multi-target:  `Multi-{N}.{shortdesc}.{YYYY-MM-DD}.p86.json`
//
// SanitizedShortName: take entity_display (or title), strip
// non-alphanumeric, CamelCase, cap at 24 chars.
// ──────────────────────────────────────────────────────────────────

function sanitizeShortName(s, maxLen = 24) {
  if (!s) return 'Unnamed';
  const parts = String(s).replace(/[^A-Za-z0-9\s]/g, ' ').trim().split(/\s+/);
  const camel = parts.map((p) => p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()).join('');
  return camel.slice(0, maxLen) || 'Unnamed';
}

function generateFilename(targets, title) {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (Array.isArray(targets) && targets.length === 1) {
    const t = targets[0];
    const entityType = String(t.entity_type || 'unknown')
      .charAt(0).toUpperCase() + String(t.entity_type || 'unknown').slice(1).toLowerCase();
    const idRef = String(t.entity_id || 'NEW').slice(0, 24).replace(/[^A-Za-z0-9_-]/g, '');
    const shortName = sanitizeShortName(t.entity_display || title || 'Untitled');
    return `${entityType}.${idRef}-${shortName}.${date}.p86.json`;
  }
  const n = Array.isArray(targets) ? targets.length : 0;
  const shortDesc = sanitizeShortName(title || 'Bundle');
  return `Multi-${n}.${shortDesc}.${date}.p86.json`;
}

// ──────────────────────────────────────────────────────────────────
// newPayloadId — stable id generator used by emitters.
// ──────────────────────────────────────────────────────────────────

function newPayloadId() {
  return 'pl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);
}

module.exports = {
  PAYLOAD_OPS_SCHEMAS,
  PayloadValidationError,
  validateOps,
  validateTarget,
  applyPayload,
  generateFilename,
  sanitizeShortName,
  newPayloadId,
  // Lower-level exports for unit tests + future dispatchers in C5.
  internals: {
    dispatchClient,
    dispatchEstimate,
    resolveRef,
    isRef,
    resolveRefsInOps,
    buildApplySummary,
    CLIENT_EDITABLE_FIELDS,
    ESTIMATE_FIELD_KEYS,
    ESTIMATE_BLOCKED_FIELDS,
  },
};
