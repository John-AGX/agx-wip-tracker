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
    // watch_ops: [{op:'create'|'archive', watch_id?, name, cadence, time_of_day_utc, prompt, agent_key?, model?, schedule_hours?, kind?}]
    // skill_pack_ops, field_tool_ops, staff_agent_ops — v2
    allowedTopKeys: new Set(['watch_ops', 'skill_pack_ops', 'field_tool_ops', 'staff_agent_ops']),
  },
});

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
      throw new Error(`Unknown op key '${k}' for entity_type=${entityType}`);
    }
  }
  // Per-entity sanity:
  if (entityType === 'client') {
    if (ops.fields && typeof ops.fields !== 'object') {
      throw new Error('client.ops.fields must be an object');
    }
    if (ops.fields) {
      for (const k of Object.keys(ops.fields)) {
        if (!CLIENT_EDITABLE_FIELDS.has(k)) {
          throw new Error(`client.ops.fields contains non-editable column '${k}'`);
        }
      }
    }
    if (ops.notes && !Array.isArray(ops.notes)) {
      throw new Error('client.ops.notes must be an array');
    }
  }
  if (entityType === 'estimate') {
    if (ops.field_updates && typeof ops.field_updates !== 'object') {
      throw new Error('estimate.ops.field_updates must be an object');
    }
    if (ops.field_updates) {
      for (const k of Object.keys(ops.field_updates)) {
        if (ESTIMATE_BLOCKED_FIELDS.has(k)) {
          throw new Error(`estimate.ops.field_updates blocked key: '${k}'`);
        }
      }
    }
    for (const k of ['sections', 'groups', 'line_adds', 'line_edits', 'line_deletes']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`estimate.ops.${k} must be an array`);
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
      for (const k of Object.keys(ops.fields)) {
        if (!LEAD_EDITABLE_FIELDS.has(k)) {
          throw new Error(`lead.ops.fields contains non-editable column '${k}'`);
        }
      }
      if (ops.fields.status && !LEAD_VALID_STATUSES.has(ops.fields.status)) {
        throw new Error(`lead.ops.fields.status invalid: '${ops.fields.status}'`);
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
    for (const k of ['watch_ops', 'skill_pack_ops', 'field_tool_ops', 'staff_agent_ops']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`system.ops.${k} must be an array`);
      }
    }
    // For v1 only watch_ops is dispatch-implemented. The rest validate
    // shape but the dispatcher throws "not yet implemented" so the
    // model knows the op is recognized but the executor isn't ready.
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
  throw new Error(`Unresolved ref '${value}' — refs must be created before they're referenced`);
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

async function dispatchClient(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

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

async function dispatchEstimate(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  const opType = ops.op || (target.entity_id ? 'update' : 'create');

  if (opType === 'create') {
    // Estimate create is rare via payload (usually paired with a
    // client create + linkage). Support it for completeness so
    // multi-target lead→client→estimate workflows work in C11.
    const id = (target.entity_id && !isRef(target.entity_id))
      ? target.entity_id
      : ('est_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8));
    const fields = ops.field_updates || {};
    const blob = { id, ...fields };
    if (ops.scope !== undefined) blob.scope = ops.scope;
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
      summary: `Created estimate ${blob.name || id}`,
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

function applyEstimateSections(data, sectionOps) {
  const sections = ensureArray(data, 'sections');
  for (const op of sectionOps) {
    const kind = op && op.op;
    if (kind === 'add') {
      const id = op.section_id || newSectionId();
      const row = { id, name: op.name || 'Section', position: op.position != null ? op.position : sections.length };
      sections.push(row);
    } else if (kind === 'update') {
      const idx = sections.findIndex((s) => s.id === op.section_id);
      if (idx < 0) throw new Error(`section_id not found: ${op.section_id}`);
      if (op.name !== undefined) sections[idx].name = op.name;
      if (op.position !== undefined) sections[idx].position = op.position;
    } else if (kind === 'delete') {
      const idx = sections.findIndex((s) => s.id === op.section_id);
      if (idx >= 0) sections.splice(idx, 1);
    } else if (kind === 'reorder') {
      // op.order: [section_id, ...]
      if (!Array.isArray(op.order)) throw new Error('reorder requires order: [section_id, ...]');
      op.order.forEach((sid, pos) => {
        const s = sections.find((x) => x.id === sid);
        if (s) s.position = pos;
      });
    } else {
      throw new Error(`section op must be add|update|delete|reorder, got: ${kind}`);
    }
  }
}

function applyEstimateGroups(data, groupOps) {
  const groups = ensureArray(data, 'groups');
  for (const op of groupOps) {
    const kind = op && op.op;
    if (kind === 'add') {
      const id = op.group_id || newGroupId();
      groups.push({ id, section_id: op.section_id || null, name: op.name || 'Group' });
    } else if (kind === 'update') {
      const idx = groups.findIndex((g) => g.id === op.group_id);
      if (idx < 0) throw new Error(`group_id not found: ${op.group_id}`);
      if (op.name !== undefined) groups[idx].name = op.name;
      if (op.section_id !== undefined) groups[idx].section_id = op.section_id;
    } else if (kind === 'delete') {
      const idx = groups.findIndex((g) => g.id === op.group_id);
      if (idx >= 0) groups.splice(idx, 1);
    } else {
      throw new Error(`group op must be add|update|delete, got: ${kind}`);
    }
  }
}

function applyLineAdds(data, lineAdds) {
  const lines = ensureArray(data, 'lines');
  for (const add of lineAdds) {
    const row = {
      id: add.line_id || newLineId(),
      estimateId: data.id,
      section_name: add.section_name || null,
      group_id: add.group_id || null,
      description: add.description || '',
      qty: add.qty != null ? Number(add.qty) : 0,
      unit: add.unit || '',
      unit_cost: add.unit_cost != null ? Number(add.unit_cost) : 0,
      markup_pct: add.markup_pct != null ? Number(add.markup_pct) : null,
    };
    lines.push(row);
  }
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
      if (k === 'qty' || k === 'unit_cost' || k === 'markup_pct') {
        lines[idx][k] = f[k] != null ? Number(f[k]) : null;
      } else {
        lines[idx][k] = f[k];
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

  const created = [];
  const updated = [];
  const deleted = [];

  for (const b of ops.blocks) {
    if (b.op === 'create') {
      const jobId = resolveRef(b.jobId || b.job_id, refTable);
      if (!jobId) throw new Error('schedule.create requires jobId');
      const jobChk = await dbClient.query('SELECT id FROM jobs WHERE id = $1', [jobId]);
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
      const r = await dbClient.query(
        `UPDATE schedule_entries SET ${sets.join(', ')} WHERE id = $${params.length}`,
        params
      );
      if (!r.rowCount) throw new Error(`schedule entry ${id} not found for update`);
      updated.push(id);
    } else if (b.op === 'delete') {
      const id = resolveRef(b.entry_id, refTable);
      const r = await dbClient.query(
        'DELETE FROM schedule_entries WHERE id = $1', [id]
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

  // v1: only watch_ops are dispatch-implemented.
  for (const k of ['skill_pack_ops', 'field_tool_ops', 'staff_agent_ops']) {
    if (Array.isArray(ops[k]) && ops[k].length) {
      throw new Error(
        `system.ops.${k} not yet implemented — use the propose_${k.replace(/_ops$/, '')} ` +
        `approval-card tool for now (will fold into payload in v2).`
      );
    }
  }

  const created = [];
  const archived = [];

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
        const r = await dbClient.query(
          `UPDATE ai_watches SET archived_at = NOW(), enabled = false WHERE id = $1`,
          [id]
        );
        if (!r.rowCount) throw new Error(`watch ${id} not found`);
        archived.push(id);
      } else {
        throw new Error(`watch_ops[].op must be create|archive, got: ${w.op}`);
      }
    }
  }

  const parts = [];
  if (created.length) parts.push(`+${created.length} watch(es)`);
  if (archived.length) parts.push(`-${archived.length} archived`);

  return {
    entity_type: 'system',
    entity_id: target.entity_id || null,
    op: 'multi',
    created, archived,
    summary: `System: ${parts.join(', ') || 'no-op'}`,
  };
}

// ──────────────────────────────────────────────────────────────────
// dispatchOps — main switch by entity_type.
// ──────────────────────────────────────────────────────────────────

const DISPATCHERS = {
  client: dispatchClient,
  estimate: dispatchEstimate,
  job: dispatchJob,
  lead: dispatchLead,
  schedule: dispatchSchedule,
  system: dispatchSystem,
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
// Returns: { ok, apply_summary, affected_targets, ref_resolutions }
// Throws on hard validation errors (caller maps to 422/4xx).
// ──────────────────────────────────────────────────────────────────

async function applyPayload(payloadRow, opts = {}) {
  const targets = Array.isArray(payloadRow.targets) ? payloadRow.targets : [];
  if (!targets.length) throw new Error('Payload has no targets');

  // Validate every target up front so we fail fast before any SQL.
  for (const t of targets) {
    if (!t || !t.entity_type) throw new Error('Each target requires entity_type');
    validateOps(t.entity_type, t.ops || {});
  }

  const dbClient = await pool.connect();
  const refTable = Object.create(null);
  const affectedTargets = [];

  try {
    await dbClient.query('BEGIN');

    // Acquire per-target advisory locks in stable sorted order so
    // concurrent multi-target applies that share entities serialize
    // without deadlocking. The lock key includes both entity_type and
    // entity_id (or '$new' for to-be-created refs).
    const lockKeys = targets
      .map((t) => `payload:${t.entity_type}:${t.entity_id || '$new'}`)
      .sort();
    for (const key of lockKeys) {
      await dbClient.query('SELECT pg_advisory_xact_lock(hashtext($1))', [key]);
    }

    // Dispatch in array order so $new_id refs become available to
    // later targets.
    for (const target of targets) {
      const result = await dispatchTarget(dbClient, target, refTable, {
        userId: opts.userId,
        organizationId: opts.organizationId,
        sourceAgent: opts.sourceAgent,
      });
      affectedTargets.push(result);
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
        ref_resolutions: Object.assign({}, refTable),
      };
    }

    await dbClient.query('COMMIT');
    return {
      ok: true,
      dry_run: false,
      apply_summary: buildApplySummary(affectedTargets),
      affected_targets: affectedTargets,
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
  validateOps,
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
