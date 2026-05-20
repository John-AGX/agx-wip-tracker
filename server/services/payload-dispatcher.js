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

const PAYLOAD_OPS_SCHEMAS = Object.freeze({
  client: {
    // op: 'create' | 'update' (default 'update' if entity_id set, else 'create')
    // fields: { ...CLIENT_EDITABLE_FIELDS subset }
    // notes: [string, ...] | [{ body, source_agent? }, ...]
    // structure: { merge?, split?, delete?, reparent?, attach_business_card? } — C5
    allowedTopKeys: new Set(['op', 'fields', 'notes', 'structure']),
  },
  estimate: {
    // op: 'create' | 'update' (default 'update')
    // scope: string (full replacement)
    // field_updates: { ...ESTIMATE_FIELD_KEYS subset }
    // sections: [{op:'add'|'update'|'delete'|'reorder', section_id?, name?, position?}]
    // groups: [{op, group_id?, section_id?, name?}]
    // line_adds: [{section_name?, group_id?, description, qty, unit, unit_cost, markup_pct?}]
    // line_edits: [{line_id, fields:{...}}]
    // line_deletes: [line_id, ...]
    allowedTopKeys: new Set([
      'op', 'scope', 'field_updates', 'sections', 'groups',
      'line_adds', 'line_edits', 'line_deletes',
    ]),
  },
  // C5 — placeholders so validateOps doesn't false-positive when a
  // payload includes targets the dispatcher hasn't been taught yet.
  job:      { allowedTopKeys: null }, // null = "not yet implemented"
  lead:     { allowedTopKeys: null },
  schedule: { allowedTopKeys: null },
  system:   { allowedTopKeys: null },
});

// ──────────────────────────────────────────────────────────────────
// validateOps — light shape check raised before any SQL runs.
// Throws Error with a descriptive message; the apply endpoint wraps
// these to return 422.
// ──────────────────────────────────────────────────────────────────

function validateOps(entityType, ops) {
  const schema = PAYLOAD_OPS_SCHEMAS[entityType];
  if (!schema) throw new Error(`Unknown entity_type: ${entityType}`);
  if (schema.allowedTopKeys === null) {
    throw new Error(`Dispatcher for entity_type=${entityType} lands in C5; not implemented yet.`);
  }
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
// dispatchOps — main switch by entity_type.
// ──────────────────────────────────────────────────────────────────

const DISPATCHERS = {
  client: dispatchClient,
  estimate: dispatchEstimate,
  // job, lead, schedule, system land in C5
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
