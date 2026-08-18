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
const { resolveTz, localWallClockToInstant, DEFAULT_TZ } = require('../timezone');
// Change orders / purchase orders / invoices live in their own tables; this
// is the same write layer the REST routes use, taking our transaction client.
const jobFin = require('./job-financials');

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
  // `alternates` are the SCOPES. Replacing the array wholesale orphans
  // every line's alternateId (and every line's money with it) while
  // being reported as "1 field(s)". Scopes have their own ops: groups[].
  'alternates',
  'estimateAlternates', 'estimateLines',
]);

// Where a blocked estimate field SHOULD be written instead. Named in the
// refusal so the agent gets a route, not just a "no".
const ESTIMATE_BLOCKED_FIELD_ROUTES = {
  lines:      "Use estimate ops line_adds / line_edits / line_deletes.",
  alternates: "Use estimate ops groups:[{op:'add'|'update'|'delete', ...}] — one op per scope.",
  __totals:   'Totals are computed from the lines; they are never written directly.',
};

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

// Calendar-event editable fields (mirrors calendar-routes.js). Owner
// (user_id) + organization_id are NEVER settable via ops — the dispatcher
// stamps them from ctx so a payload can't write into another user's calendar.
const CALENDAR_EVENT_FIELDS = new Set([
  'title', 'starts_at', 'ends_at', 'all_day', 'location',
  'notes', 'color', 'status', 'recurrence', 'reminder_minutes',
  // OPTIONAL polymorphic link — the entity this event/reminder is about
  // (client | job | lead | project). Omit both for a standalone personal
  // appointment/reminder.
  'entity_type', 'entity_id',
]);
const CALENDAR_EVENT_STATUSES = new Set(['confirmed', 'tentative', 'canceled']);

// Task/to-do/reminder editable fields (mirror tasks-routes.js +
// reminders-crud-routes.js). organization_id + created_by are always stamped
// from ctx; scope/owner_user_id/user_id are set per dispatcher. entity_type/
// entity_id OPTIONALLY link the item to a client/job/lead/project.
//
// THREE tiers (3-tier model):
//   task     → ORG task, org-wide visible, assignable to any org user via
//              assignee_user_id (validated in-org; defaults to the actor).
//   todo     → PERSONAL to-do, private to the actor (scope='personal',
//              owner_user_id stamped) — NOT assignable.
//   reminder → PERSONAL timed nudge in the reminders table (its own list),
//              source='assistant'.
const TASK_FIELDS = new Set([
  'title', 'notes', 'kind', 'status', 'priority', 'due_date',
  'assignee_user_id', 'entity_type', 'entity_id',
]);
const TODO_FIELDS = new Set([
  'title', 'notes', 'kind', 'status', 'priority', 'due_date',
  'entity_type', 'entity_id',
]);
const REMINDER_FIELDS = new Set([
  'title', 'notes', 'remind_at', 'entity_type', 'entity_id',
]);

// Entity kinds a calendar_event or task may be linked to. Mirrors the
// tasks-routes LINKABLE_ENTITY_TYPES, minus the ones that don't represent
// a property/relationship (the Assistant defaults to CLIENT when an event
// concerns a property, JOB for active work).
const SCHEDULE_LINK_ENTITY_TYPES = new Set(['client', 'job', 'lead', 'project']);
const TASK_KINDS = new Set(['todo', 'punch', 'follow_up']);
const TASK_STATUSES = new Set(['open', 'in_progress', 'blocked', 'done']);
const TASK_PRIORITIES = new Set(['low', 'normal', 'high', 'urgent']);

// Deal-memory notes (slice 4) — the deterministic Critic's bounds. A note is a
// short PROSE decision/constraint. It must never carry a money figure — a dollar
// amount is the deterministic rollup's job (the numbers sub-block), not model
// prose. This is the no-LLM-owns-a-number rule enforced at the write layer.
const NOTE_TEXT_CAP = 500;       // chars per note
const NOTES_TOTAL_CAP = 4000;    // ~1k tokens across ACTIVE (non-superseded) notes
// Money/number detector for note prose — strict on the no-numbers-in-a-note rule
// but tuned to avoid over-blocking the identifiers that pepper construction
// notes. Rejects: $-prefixed ($190); magnitude-suffixed (190k / 3 million / 500
// dollars — NOT bare 'm'/'mm', which collide with metric specs); comma-grouped
// thousands (3,000); and bare 6+-digit integers (≥$100k — a size that no unit /
// lot / zip / year uses). Deliberately PASSES ≤5-digit bare numbers (unit 3253,
// zip 33684, year 2026, small counts). A bare 4–5-digit dollar amount can slip,
// but that requires 86 to disobey the explicit "prose, no numbers" instruction
// AND drop the $/comma — a bounded, rare context-pollution edge, not corruption.
const MONEY_RE = /(\$\s*\d)|(\b\d[\d,]*\.?\d*\s*(k|million|thousand|dollars?|usd)\b)|(\b\d{1,3}(,\d{3})+\b)|(\b\d{6,}\b)/i;

const PAYLOAD_OPS_SCHEMAS = Object.freeze({
  client: {
    // op: 'create' | 'update' (default 'update' if entity_id set, else 'create')
    // fields: { ...CLIENT_EDITABLE_FIELDS subset }
    // notes: [string, ...] | [{ body, source_agent? }, ...]
    // structure: { merge?, split?, delete?, reparent?, attach_business_card? } — v2
    allowedTopKeys: new Set(['op', 'fields', 'notes', 'structure']),
  },
  estimate: {
    // assembly_adds: [{assembly_id, params:{Q,...}, mode?, alternate_id?,
    //   alternate_name?}] — put a COSTED RECIPE on the estimate INTACT.
    //   The dispatcher explodes + prices it; the agent never hand-expands.
    allowedTopKeys: new Set([
      'op', 'scope', 'field_updates', 'sections', 'groups',
      'line_adds', 'line_edits', 'line_deletes', 'assembly_adds',
    ]),
  },
  job: {
    // field_updates: top-level job blob keys (NOT structural sub-arrays)
    // phase_updates: [{phase_id, pct_complete?, materials?, labor?, sub?, equipment?, buildingId?}]
    // change_orders / purchase_orders / invoices: array ops with {op, *_id?, fields}
    // notes: [string, ...]  (append to job.data.agent_notes JSONB array if present)
    //
    // node_values / wire_updates / qb_assignments / graph are RETIRED —
    // see RETIRED_JOB_OPS below. They are deliberately absent here and
    // refused with a named error instead of falling through to the
    // generic "unknown op key" message.
    allowedTopKeys: new Set([
      'field_updates', 'phase_updates',
      'change_orders', 'purchase_orders', 'invoices',
      'notes',
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
    // skill_pack_ops: [{op:'add'|'edit'|'delete', pack_id?, fields:{name, body, description?, agents?, category?, triggers?}}]
    // field_tool_ops: [{op:'create'|'edit'|'delete', tool_id?, fields:{name, description?, category?, html_body}}]
    // link_ops: [{op:'link_job_to_client', job_id, client_id} | {op:'link_property_to_parent', property_id, parent_client_id} | {op:'attach_files', attachment_ids[], target_entity_type, target_entity_id}]
    // (watch_ops + staff_agent_ops removed 2026-07-03 — features retired.)
    allowedTopKeys: new Set([
      'skill_pack_ops', 'field_tool_ops', 'link_ops',
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
  calendar_event: {
    // op: 'create' (v1 — the assistant scheduling a new timed event/reminder).
    // fields: { title, starts_at (ISO datetime), ends_at?, all_day?, location?,
    //           notes?, color?, status?, recurrence?, reminder_minutes? }
    // A timed "reminder" = a calendar_event with starts_at + reminder_minutes.
    // org + user are stamped from ctx, never from fields.
    allowedTopKeys: new Set(['op', 'fields']),
  },
  task: {
    // op: 'create' (v1). fields: { title, due_date? (DATE), notes?, kind?,
    //           status?, priority?, assignee_user_id? (in-org user; defaults
    //           to the actor) }. An ORG task — org-wide visible. org + creator
    //           stamped from ctx.
    allowedTopKeys: new Set(['op', 'fields']),
  },
  todo: {
    // op: 'create' (v1). fields: same as task MINUS assignee_user_id. A
    //           PERSONAL to-do — private to the actor (scope='personal',
    //           owner_user_id stamped from ctx). Not assignable.
    allowedTopKeys: new Set(['op', 'fields']),
  },
  reminder: {
    // op: 'create' (v1). fields: { title, remind_at (ISO datetime), notes?,
    //           entity_type?, entity_id? }. A PERSONAL timed nudge written to
    //           the reminders table (its own list); source='assistant'. org +
    //           user stamped from ctx.
    allowedTopKeys: new Set(['op', 'fields']),
  },
  assembly: {
    // Costed estimating recipes (assemblies + assembly_items — relational,
    // NOT appData JSONB). 86 owns this database; writes ride the normal
    // approval flow.
    // op 'create': fields { name (required), code?, trade?, category?,
    //   unit? (output unit, default EA), description?, notes?, source? } +
    //   items[] (full recipe rows).
    // op 'update': entity_id = assembly id; fields (header changes) and/or
    //   items[] (FULL REPLACE of the recipe rows).
    // op 'delete': entity_id = assembly id. High-risk → always cards.
    // Item row: { kind: material|labor|sub|gc|assembly, material_id?,
    //   child_assembly_id?, description?, qty_per_unit (per 1 output unit),
    //   unit?, unit_cost? (null on material rows = live catalog price),
    //   cost_code?, waste_pct? }
    // 'reason' — the agent's stated why; lands in assembly_tuning_log.
    // 'source_research_id' — (create only) the assembly_research packet this
    //   recipe was built from; the dispatcher consumes+links that packet
    //   in-txn so a shared-pane card links to exactly its source (no client
    //   guessing about which of many cards a handed packet belongs to).
    allowedTopKeys: new Set(['op', 'fields', 'items', 'reason', 'source_research_id']),
  },
  deal_memory: {
    // Deal-thread durable memory (slice 4). The model appends DECISIONS /
    // CONSTRAINTS as PROSE ('client waived the flashing CO'); it never touches
    // 'numbers' (the deterministic rollup owns those). entity_id = the
    // lineage_root shown in the <deal_memory> block. The absent 'numbers' key
    // IS the ownership lint — the grammar structurally denies the model any
    // path to the money column.
    allowedTopKeys: new Set(['note_adds', 'note_supersedes']),
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
// RETIRED_JOB_OPS — the node-graph write vocabulary, refused by name.
//
// These four used to EXECUTE: dispatchJob loaded node_graphs.data, wrote
// graph.wires[i].pctComplete / graph.nodes[i].value / qb_cost_lines
// .linked_node_id, committed, and reported success. None of it has moved a
// dollar since the node retirement — the phase matrix is the rollup — so
// "set B1 to 100%" routed through wire_updates came back APPLIED with the
// job's money untouched. A write that reports success and moves nothing is
// the worst possible outcome; these now refuse loudly instead.
//
// (node_graphs itself is NOT dead — it is the Site Plan's geometry store,
// written by PUT /api/jobs/:id/graph. Nothing but these ops ever reached it
// from a payload, so removing the branch strands no other caller.)
//
// retryable:false so the Scribe's self-correction loop stops rather than
// re-emitting a variant of the same dead op.
// ──────────────────────────────────────────────────────────────────
const RETIRED_JOB_OPS = {
  node_values: 'The node graph no longer carries job money. Move the number with `phase_updates` on the phase records instead.',
  wire_updates: 'Wire pctComplete/allocPct no longer feed any rollup. To set completion, emit `phase_updates`: [{phase_id, pct_complete}] for EVERY phase whose buildingId is the target building.',
  graph: 'Graph topology is not a money model and is not writable from a payload. Building/phase structure is edited on the job; completion moves through `phase_updates`.',
  qb_assignments: 'qb_cost_lines.linked_node_id no longer affects cost — every imported line counts by its account bucket. There is no payload op for reclassifying a QB line; do it in the job\'s cost view.',
};

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
  // Retired node-graph ops get a NAMED refusal, ahead of the generic
  // unknown-key message — "unknown op key 'wire_updates'" reads like a
  // typo, and the agent's next move is to try a spelling variant.
  if (entityType === 'job') {
    for (const k of Object.keys(ops)) {
      if (RETIRED_JOB_OPS[k]) {
        throw new PayloadValidationError(
          `job.ops.${k} is RETIRED — this write would move NO money and is refused. ${RETIRED_JOB_OPS[k]}`,
          { code: 'retired_op', field_path: `job.ops.${k}`, received: k,
            retryable: false, suggestion: RETIRED_JOB_OPS[k] }
        );
      }
    }
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
  if (entityType === 'deal_memory') {
    // Emit-time deterministic Critic — shape + the no-money rule. (id-existence
    // and the total cap need the DB row, so they run at apply time in the
    // dispatcher.)
    if (ops.note_adds != null && !Array.isArray(ops.note_adds)) {
      throw new Error('deal_memory.ops.note_adds must be an array');
    }
    if (ops.note_supersedes != null && !Array.isArray(ops.note_supersedes)) {
      throw new Error('deal_memory.ops.note_supersedes must be an array');
    }
    (ops.note_adds || []).forEach((n, i) => {
      const text = (n && typeof n === 'object') ? n.text : n;
      if (!text || !String(text).trim()) {
        throw new PayloadValidationError(`deal_memory.note_adds[${i}].text is required`,
          { code: 'missing_field', field_path: `note_adds[${i}].text` });
      }
      if (String(text).length > NOTE_TEXT_CAP) {
        throw new PayloadValidationError(`deal_memory.note_adds[${i}].text exceeds ${NOTE_TEXT_CAP} chars`,
          { code: 'note_too_long', field_path: `note_adds[${i}].text` });
      }
      if (MONEY_RE.test(String(text))) {
        throw new PayloadValidationError(
          `deal_memory.note_adds[${i}].text contains a money figure — notes hold decisions/constraints in PROSE, never numbers. A dollar amount is the deterministic rollup's job (the numbers sub-block), not model prose. Rephrase without the figure (e.g. "client imposed a hard price cap" not "hard cap $190k").`,
          { code: 'money_in_note', field_path: `note_adds[${i}].text`, received: String(text) });
      }
    });
    (ops.note_supersedes || []).forEach((s, i) => {
      if (!s || !s.id) {
        throw new PayloadValidationError(`deal_memory.note_supersedes[${i}].id is required`,
          { code: 'missing_field', field_path: `note_supersedes[${i}].id` });
      }
    });
  }
  if (entityType === 'assembly') {
    if (ops.op && !['create', 'update', 'delete'].includes(ops.op)) {
      throw new Error(`assembly op must be create | update | delete (got '${ops.op}')`);
    }
    if (ops.fields && typeof ops.fields !== 'object') {
      throw new Error('assembly ops.fields must be an object of header fields');
    }
    if (ops.items && !Array.isArray(ops.items)) {
      throw new Error('assembly ops.items must be an array of recipe rows');
    }
    if ((ops.op === 'create' || !ops.op) && !(ops.fields && ops.fields.name)) {
      throw new Error('assembly create requires fields.name');
    }
  }
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
              received: k, expected: [...ESTIMATE_BLOCKED_FIELDS], retryable: false,
              suggestion: ESTIMATE_BLOCKED_FIELD_ROUTES[k] ||
                'This field is not user-writable via payload. Edit it through the proper proposal flow.' }
          );
        }
      }
    }
    for (const k of ['sections', 'groups', 'line_adds', 'line_edits', 'line_deletes', 'assembly_adds']) {
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
    for (const k of ['phase_updates', 'change_orders', 'purchase_orders',
                     'invoices', 'notes']) {
      if (ops[k] != null && !Array.isArray(ops[k])) {
        throw new Error(`job.ops.${k} must be an array`);
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
    for (const k of ['skill_pack_ops', 'field_tool_ops', 'link_ops']) {
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
  if (entityType === 'calendar_event') {
    const op = ops.op || 'create';
    if (op !== 'create') {
      throw new Error(`calendar_event.ops.op must be 'create' (got '${op}')`);
    }
    const fields = ops.fields || {};
    if (typeof fields !== 'object') throw new Error('calendar_event.ops.fields must be an object');
    if (!fields.title || !String(fields.title).trim()) {
      throw new Error('calendar_event.create requires fields.title');
    }
    if (!fields.starts_at) {
      throw new Error('calendar_event.create requires fields.starts_at (ISO datetime)');
    }
    if (isNaN(new Date(fields.starts_at).getTime())) {
      throw new Error(`calendar_event.fields.starts_at is not a valid datetime: '${fields.starts_at}'`);
    }
    const bad = Object.keys(fields).filter(k => !CALENDAR_EVENT_FIELDS.has(k));
    if (bad.length) {
      throw new PayloadValidationError(
        `calendar_event.ops.fields has non-editable key(s): ${bad.map(k => `'${k}'`).join(', ')}. ` +
        `Valid: ${[...CALENDAR_EVENT_FIELDS].sort().join(', ')}. ` +
        `(organization_id/user_id are set automatically — never pass them.)`,
        { code: 'unknown_field', field_path: 'calendar_event.ops.fields', received: bad, expected: [...CALENDAR_EVENT_FIELDS] }
      );
    }
    if (fields.status && !CALENDAR_EVENT_STATUSES.has(fields.status)) {
      throw new Error(`calendar_event.fields.status invalid: '${fields.status}'. Valid: ${[...CALENDAR_EVENT_STATUSES].sort().join(', ')}.`);
    }
    validateScheduleLink('calendar_event', fields);
  }
  if (entityType === 'task' || entityType === 'todo') {
    const op = ops.op || 'create';
    if (op !== 'create') {
      throw new Error(`${entityType}.ops.op must be 'create' (got '${op}')`);
    }
    const fields = ops.fields || {};
    if (typeof fields !== 'object') throw new Error(`${entityType}.ops.fields must be an object`);
    if (!fields.title || !String(fields.title).trim()) {
      throw new Error(`${entityType}.create requires fields.title`);
    }
    const allowed = entityType === 'task' ? TASK_FIELDS : TODO_FIELDS;
    const bad = Object.keys(fields).filter(k => !allowed.has(k));
    if (bad.length) {
      throw new PayloadValidationError(
        `${entityType}.ops.fields has non-editable key(s): ${bad.map(k => `'${k}'`).join(', ')}. ` +
        `Valid: ${[...allowed].sort().join(', ')}. (org/creator${entityType === 'todo' ? '/owner' : ''} set automatically.)`,
        { code: 'unknown_field', field_path: `${entityType}.ops.fields`, received: bad, expected: [...allowed] }
      );
    }
    if (fields.kind && !TASK_KINDS.has(fields.kind)) throw new Error(`${entityType}.fields.kind invalid: '${fields.kind}'. Valid: ${[...TASK_KINDS].sort().join(', ')}.`);
    if (fields.status && !TASK_STATUSES.has(fields.status)) throw new Error(`${entityType}.fields.status invalid: '${fields.status}'. Valid: ${[...TASK_STATUSES].sort().join(', ')}.`);
    if (fields.priority && !TASK_PRIORITIES.has(fields.priority)) throw new Error(`${entityType}.fields.priority invalid: '${fields.priority}'. Valid: ${[...TASK_PRIORITIES].sort().join(', ')}.`);
    if (fields.due_date && isNaN(new Date(fields.due_date).getTime())) throw new Error(`${entityType}.fields.due_date is not a valid date: '${fields.due_date}'`);
    if (entityType === 'task' && fields.assignee_user_id != null && !Number.isInteger(Number(fields.assignee_user_id))) {
      throw new Error('task.fields.assignee_user_id must be a numeric user id (validated in-org at apply time).');
    }
    validateScheduleLink(entityType, fields);
  }
  if (entityType === 'reminder') {
    const op = ops.op || 'create';
    if (op !== 'create') throw new Error(`reminder.ops.op must be 'create' (got '${op}')`);
    const fields = ops.fields || {};
    if (typeof fields !== 'object') throw new Error('reminder.ops.fields must be an object');
    if (!fields.title || !String(fields.title).trim()) throw new Error('reminder.create requires fields.title');
    if (!fields.remind_at) throw new Error('reminder.create requires fields.remind_at (ISO datetime)');
    if (isNaN(new Date(fields.remind_at).getTime())) throw new Error(`reminder.fields.remind_at is not a valid datetime: '${fields.remind_at}'`);
    const bad = Object.keys(fields).filter(k => !REMINDER_FIELDS.has(k));
    if (bad.length) {
      throw new PayloadValidationError(
        `reminder.ops.fields has non-editable key(s): ${bad.map(k => `'${k}'`).join(', ')}. ` +
        `Valid: ${[...REMINDER_FIELDS].sort().join(', ')}. (org/user set automatically.)`,
        { code: 'unknown_field', field_path: 'reminder.ops.fields', received: bad, expected: [...REMINDER_FIELDS] }
      );
    }
    validateScheduleLink('reminder', fields);
  }
}

// Shared validation for the OPTIONAL entity link on calendar_event / task.
// Both fields together or neither; the type must be linkable.
function validateScheduleLink(label, fields) {
  const hasType = !!fields.entity_type;
  const hasId = !!(fields.entity_id != null && String(fields.entity_id).trim());
  if (hasType !== hasId) {
    throw new Error(`${label} link requires BOTH entity_type and entity_id (or neither, for a standalone personal item).`);
  }
  if (hasType && !SCHEDULE_LINK_ENTITY_TYPES.has(fields.entity_type)) {
    throw new Error(`${label}.fields.entity_type invalid: '${fields.entity_type}'. Linkable: ${[...SCHEDULE_LINK_ENTITY_TYPES].sort().join(', ')} (or omit for a standalone item).`);
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
  if (!entityId || isRef(entityId)) return;      // no concrete row yet
  // A NULL org used to `return` here — a fail-OPEN guard sitting underneath two
  // fail-closed ones. Both live apply doors do refuse without an org today
  // (payload-routes uses requireOrg; applyPayloadForUser returns an error), so
  // this was not reachable — but agent contexts resolve their org through
  // _cdOrgId / ctx.orgId and several can be null by construction, which is
  // exactly the input this opened on. "I have no tenant" is the case the guard
  // exists for, not an exemption from it.
  if (!orgId) throw new Error(`${entityType} not found: ${entityId}`);
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

// resolveJobTarget — tolerate a human jobNumber ("RV2000") where a canonical
// row id ("j1778…") is expected. Reads format jobs by their jobNumber and hide
// the row id, so 86/the Scribe naturally reference a job by its number; without
// this, that lands as "Job not found" and 86 burns turns reverse-engineering the
// row id from cross-links. Resolution is ORG-SCOPED (only a job in the applier's
// org or a NULL-org legacy row) so it can never reach across tenants, and a
// jobNumber that matches >1 job is rejected as ambiguous rather than guessed.
// A $ref or an id that already resolves to a row is passed through untouched.
async function resolveJobTarget(dbClient, rawId, orgId) {
  if (!rawId || isRef(rawId)) return rawId;
  // F5. This probe used to be `SELECT 1 FROM jobs WHERE id = $1` with no
  // predicate. Every downstream write already carries one, so it was never a
  // write — but "is this a real row id" answered TRUE for another tenant's job
  // and FALSE for a string that is nothing, and that difference is an existence
  // oracle over the whole jobs table, reachable from an agent payload.
  //
  // Scoped, it also reads better: the question this function is actually asking
  // is "is this already a canonical id I can use", and another tenant's id is
  // not one. A foreign id now falls through to the jobNumber branch (which has
  // been org-scoped since it was written) and out to "Job not found", exactly
  // like a typo.
  const direct = orgId
    ? await dbClient.query(
        `SELECT 1 FROM jobs WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL) LIMIT 1`,
        [rawId, orgId])
    : await dbClient.query('SELECT 1 FROM jobs WHERE id = $1 LIMIT 1', [rawId]);
  if (direct.rowCount) return rawId;             // already a canonical row id
  // jobNumber fallback is ORG-SCOPED only — never resolve a number across the
  // whole table. Without an orgId we decline to guess (the row-id lookup above
  // already failed), so this can never select another tenant's job.
  if (!orgId) return rawId;                       // unresolved → "Job not found: <id>"
  const byNum = await dbClient.query(
    `SELECT id FROM jobs WHERE data->>'jobNumber' = $1 AND (organization_id = $2 OR organization_id IS NULL)`,
    [rawId, orgId]);
  if (byNum.rowCount === 1) return byNum.rows[0].id;
  if (byNum.rowCount > 1) {
    throw new Error(`Ambiguous job number "${rawId}" — it matches ${byNum.rowCount} jobs. Pass the canonical job id (j-style) instead.`);
  }
  return rawId;                                  // unresolved → downstream "Job not found: <id>"
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

    // Stamp the applier's org. Without it the row lands organization_id
    // NULL, and every org-scoped read uses `OR organization_id IS NULL`
    // to keep pre-tenancy rows visible — so an AI-created client would be
    // readable, editable, and deletable by every tenant until the boot-time
    // backfill happened to claim it. Taken from ctx, never from fields, so
    // a payload can't nominate someone else's org.
    const cols = ['id', 'organization_id'];
    const vals = [id, (ctx && ctx.organizationId) || null];
    for (const k of Object.keys(fields)) {
      if (k === 'organization_id' || k === 'id') continue;
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

// ── applyAssemblyAdds ────────────────────────────────────────────────
// estimate.ops.assembly_adds — put a costed ASSEMBLY (recipe) on the
// estimate as ONE line per cost bucket, intact.
//
// Why this is an op and not a tool: an assembly append is estimate money,
// and estimate money is written in exactly one place — this dispatcher,
// behind ESTIMATES_EDIT, inside applyPayload's transaction, with a
// before/after changeset and an approve-in-chat card. A direct HTTP tool
// for 86 would be a second, ungoverned door into the same numbers.
//
// The agent must NEVER hand-expand a recipe into line_adds: doing that
// re-prices it from a stale read, drops the assembly provenance
// (sourceAssemblyId / assemblyBreakdown) the editor's explode + per-unit
// refresh depend on, and pushes every line to the END of the array
// instead of into its section. This op does all three correctly by
// reusing estimate-lines.applyAssemblyToEstimateData — the same code the
// takeoff "Add to estimate" button runs.
//
// Refusals (explodeForEstimate) are TERMINAL: they carry
// detail.retryable === false so the Scribe's retry loop breaks instead of
// re-prompting, because the Scribe's only available "fix" for an unpriced
// recipe is to invent unit costs in hand-written line_adds — which would
// launder a refusal into a silently understated estimate.
async function applyAssemblyAdds(dbClient, data, estId, entries, ctx) {
  const asmSvc = require('./assemblies');
  const estLines = require('./estimate-lines');
  if (!ctx || !ctx.organizationId) {
    throw new PayloadValidationError(
      'estimate.ops.assembly_adds requires an authenticated org context',
      { code: 'missing_org', field_path: 'estimate.ops.assembly_adds', retryable: false }
    );
  }
  // One catalog load for the whole array — loadGraph is org-scoped and
  // read-only, and re-loading per entry would be a query per assembly.
  const graph = await asmSvc.loadGraph(dbClient, ctx.organizationId);
  let added = 0;
  const names = [];
  // applyAssemblyToEstimateData derives line ids from a timestamp; two entries
  // in the same array land in the same millisecond, so disambiguate per entry
  // or the second assembly's lines collide with the first's.
  const stampBase = Date.now().toString(36);

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i] || {};
    const path = `estimate.ops.assembly_adds[${i}]`;
    // 'rollup' (ONE line per cost bucket) is the default and the norm.
    // Exploding a recipe into its components is a HUMAN action taken
    // later in the estimate editor — only honour 'exploded' when the
    // caller asked for it in so many words.
    const mode = e.mode === 'exploded' ? 'exploded' : 'rollup';

    const ex = estLines.explodeForEstimate({
      assembly_id: e.assembly_id, graph: graph, params: e.params || {},
    });
    if (!ex.ok) {
      throw new PayloadValidationError(ex.error, {
        code: ex.code, field_path: path, op_index: i, retryable: false,
        received: e.assembly_id,
        suggestion: ex.code === 'assembly_unpriced'
          ? 'Do NOT work around this by hand-writing line_adds with guessed unit costs. The recipe has to be priced first.'
          : 'Fix the recipe (or the takeoff quantity) before putting it on an estimate.',
      });
    }

    // Which SCOPE (alternate) does this land in? An id wins; a name is
    // resolved case-insensitively (86 sees alternates by name in its turn
    // context). Both are optional — applyAssemblyToEstimateData falls back
    // to the active alternate, then the first one, i.e. "Base".
    let altPref = e.alternate_id || null;
    const wantName = (typeof e.alternate_name === 'string' && e.alternate_name.trim())
      ? e.alternate_name.trim().toLowerCase() : null;
    const alts = Array.isArray(data.alternates) ? data.alternates : [];
    if (!altPref && wantName) {
      const hits = alts.filter((x) => x && String(x.name || '').trim().toLowerCase() === wantName);
      if (hits.length !== 1) {
        // Self-correcting: name the valid choices so the Scribe can retry.
        throw new PayloadValidationError(
          (hits.length ? 'Ambiguous' : 'Unknown') + ` alternate_name "${e.alternate_name}" on this estimate.`,
          { code: hits.length ? 'ambiguous_alternate' : 'unknown_alternate',
            field_path: path + '.alternate_name', op_index: i, received: e.alternate_name,
            expected: alts.map((x) => (x && x.name) || '').filter(Boolean),
            suggestion: 'Use one of the listed group names exactly, or omit alternate_name to use the active group.' }
        );
      }
      altPref = hits[0].id;
    }

    const plan = estLines.applyAssemblyToEstimateData(data, {
      estId: estId, assembly: ex.assembly, rows: ex.rows, scope: ex.scope,
      mode: mode, alternatePref: altPref, nowStamp: stampBase + 'a' + i,
    });
    if (!plan.added) {
      throw new PayloadValidationError(
        `Assembly "${ex.assembly.name || e.assembly_id}" produced no lines (all items priced at zero or empty).`,
        { code: 'assembly_empty', field_path: path, op_index: i, retryable: false }
      );
    }
    added += plan.added;
    names.push(ex.assembly.name || ('#' + ex.assembly.id));
  }
  return { added, names };
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
    // NB: ops.scope is applied AFTER the group ops below — scope lives on
    // a group, so there has to be a group first. See applyEstimateScopeText.
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
    // Scope text goes on the group the payload just established, never on
    // the blob (the blob key has no readers — that was the bug).
    if (ops.scope !== undefined) {
      applyEstimateScopeText(blob, ops.scope, { fieldPath: 'estimate.ops.scope' });
    }
    if (ops.line_adds) applyLineAdds(blob, ops.line_adds);
    // Assemblies land AFTER the groups/sections ops above so they can be
    // routed into an alternate this same payload just created.
    if (Array.isArray(ops.assembly_adds) && ops.assembly_adds.length) {
      await applyAssemblyAdds(dbClient, blob, id, ops.assembly_adds, ctx);
    }

    // organization_id must be stamped here — a NULL-org estimate is visible
    // to every tenant through the `OR organization_id IS NULL` read predicate.
    await dbClient.query(
      `INSERT INTO estimates (id, organization_id, owner_id, data) VALUES ($1, $2, $3, $4)`,
      [id, (ctx && ctx.organizationId) || null, ctx.userId || null, JSON.stringify(blob)]
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
    const r = await dbClient.query('SELECT data, is_locked FROM estimates WHERE id = $1', [id]);
    if (!r.rows.length) throw new Error(`Estimate not found: ${id}`);
    // A locked estimate has been sold — its total became the job's contract
    // amount at conversion. Editing the lines afterwards silently decouples
    // the contract from the estimate it came from. An admin unlocks to edit.
    if (r.rows[0].is_locked) {
      throw new Error(`Cannot edit a locked (sold) estimate: ${id} — an admin must unlock it first.`);
    }
    const data = r.rows[0].data || {};

    const changes = [];

    // Self-heal FIRST, on every estimate update: earlier builds wrote scope
    // text into data.scope, where nothing could read it. Move it onto the
    // group before this payload's own ops run, so the recovery happens even
    // when the payload is about something else entirely.
    if (migrateLegacyEstimateScope(data)) {
      changes.push('scope (recovered from the legacy estimate-level field)');
    }

    if (ops.scope !== undefined) {
      applyEstimateScopeText(data, ops.scope, { fieldPath: 'estimate.ops.scope' });
      changes.push('scope');
    }
    if (ops.field_updates) {
      for (const k of Object.keys(ops.field_updates)) {
        if (ESTIMATE_BLOCKED_FIELDS.has(k)) continue;
        // `scope` is NOT a blob field. This is the exact shape the Scribe
        // emitted on the Uptown estimate; sending it to data[k] is what
        // made three successive "applied" writes invisible.
        if (k === 'scope') {
          applyEstimateScopeText(data, ops.field_updates[k],
            { fieldPath: 'estimate.ops.field_updates.scope' });
          continue;
        }
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
    if (Array.isArray(ops.assembly_adds) && ops.assembly_adds.length) {
      const r2 = await applyAssemblyAdds(dbClient, data, id, ops.assembly_adds, ctx);
      changes.push(`+${r2.added} line(s) from assembly ${r2.names.map((n) => `"${n}"`).join(', ')}`);
    }
    if (Array.isArray(ops.line_edits) && ops.line_edits.length) {
      const n = applyLineEdits(data, ops.line_edits);
      changes.push(`~${n} line(s)`);
    }
    if (Array.isArray(ops.line_deletes) && ops.line_deletes.length) {
      const n = applyLineDeletes(data, ops.line_deletes);
      changes.push(`-${n} line(s)`);
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
      // Typed, not bare: a bare Error gives the agent no `code` and no
      // `retryable:false`, so it re-emits the same unresolvable id.
      if (idx < 0) throw unknownAlternateError(alternates, op.group_id, 'estimate.ops.groups.group_id');
      if (op.name !== undefined) alternates[idx].name = op.name;
      if (op.scope !== undefined) alternates[idx].scope = op.scope;
    } else if (kind === 'delete') {
      const before = alternates.length;
      data.alternates = alternates.filter((a) => a.id !== op.group_id);
      // Cascade: also drop any lines (headers + items) belonging to that alternate.
      data.lines = lines.filter((l) => !l || l.alternateId !== op.group_id);
      if (data.alternates.length === before) {
        throw unknownAlternateError(alternates, op.group_id, 'estimate.ops.groups.group_id');
      }
    } else {
      throw new Error(`group op must be add|update|delete, got: ${kind}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────
// SCOPE TEXT — an estimate's scope of work lives on the GROUP
// (alternate), never on the estimate blob.
//
// THE FAILING CONDITION THIS CLOSES: `estimate.ops.scope` and
// `ops.field_updates.scope` both wrote `data.scope` — a blob key with
// ZERO readers anywhere in the product. Every surface that shows scope
// reads `data.alternates[i].scope` (estimate-editor renderScopePanel,
// estimate-preview, proposal, bt-export), and the agent's own turn
// context reads `activeAlt.scope` too. So the write committed, the
// payload went `applied` with `apply_error: null`, and the text was
// invisible forever — including to the agent that wrote it, which then
// concluded there was no scope yet and wrote it again. A write-only
// field plus a read path that skips it is a closed retry loop.
//
// Everything below routes scope text to the field the app reads, and
// refuses with a NAMED code when it cannot work out which group is
// meant. Silence is what caused this bug; it is not an option here.
// ──────────────────────────────────────────────────────────────────

function alternateNamesOf(alternates) {
  return (alternates || []).map((a) => (a && a.name) || '').filter(Boolean);
}

function unknownAlternateError(alternates, received, fieldPath, extra) {
  return new PayloadValidationError(
    `Unknown group "${received}" on this estimate — nothing was written.`,
    Object.assign({
      code: 'unknown_alternate',
      field_path: fieldPath,
      received: received,
      retryable: false,
      expected: (alternates || []).map((a) => a && a.id).filter(Boolean),
      expected_names: alternateNamesOf(alternates),
      suggestion: 'Use one of the listed group ids (or names) exactly, or omit the group target to use the active group.',
    }, extra || {})
  );
}

// Resolve WHICH group an op is aimed at. Order: explicit id → explicit
// name (case-insensitive, must be unique) → the estimate's active group
// → the first group. Returns null only when the estimate has no groups.
function resolveAlternateTarget(data, opts, fieldPath) {
  const o = opts || {};
  const alternates = Array.isArray(data.alternates) ? data.alternates : [];
  const wantId = o.alternateId || null;
  if (wantId) {
    const hit = alternates.find((a) => a && a.id === wantId);
    if (!hit) throw unknownAlternateError(alternates, wantId, fieldPath + '.alternate_id', o.errorExtra);
    return hit;
  }
  const wantName = (typeof o.alternateName === 'string' && o.alternateName.trim())
    ? o.alternateName.trim().toLowerCase() : null;
  if (wantName) {
    const hits = alternates.filter(
      (a) => a && String(a.name || '').trim().toLowerCase() === wantName
    );
    if (hits.length !== 1) {
      throw new PayloadValidationError(
        (hits.length ? 'Ambiguous' : 'Unknown') +
          ` group name "${o.alternateName}" on this estimate — nothing was written.`,
        Object.assign({
          code: hits.length ? 'ambiguous_alternate' : 'unknown_alternate',
          field_path: fieldPath + '.alternate_name',
          received: o.alternateName,
          retryable: false,
          expected: alternateNamesOf(alternates),
          suggestion: 'Use one of the listed group names exactly, or omit it to use the active group.',
        }, o.errorExtra || {})
      );
    }
    return hits[0];
  }
  if (data.activeAlternateId) {
    const hit = alternates.find((a) => a && a.id === data.activeAlternateId);
    if (hit) return hit;
  }
  return alternates[0] || null;
}

// Recover scope text stranded on the blob by the old write path. Moves
// it onto the group that owns it, and only DELETES the dead key once the
// text is safely somewhere a reader can see it. If the group already has
// different scope text we leave the orphan alone — a dead field costs
// nothing; destroying a client's scope of work costs a lot.
function migrateLegacyEstimateScope(data) {
  if (!data || typeof data.scope !== 'string') return false;
  const legacy = data.scope;
  if (!legacy.trim()) { delete data.scope; return false; }
  const alternates = Array.isArray(data.alternates) ? data.alternates : [];
  if (!alternates.length) return false; // no home yet — keep it until there is one
  let idx = alternates.findIndex((a) => a && a.id === data.activeAlternateId);
  if (idx < 0) idx = 0;
  const current = String((alternates[idx] && alternates[idx].scope) || '');
  if (!current.trim()) { alternates[idx].scope = legacy; delete data.scope; return true; }
  if (current.indexOf(legacy) >= 0) { delete data.scope; return false; } // already superseded
  return false;
}

// Write scope text onto a group. Never touches data.scope.
function applyEstimateScopeText(data, text, opts) {
  const o = opts || {};
  const fieldPath = o.fieldPath || 'estimate.ops.scope';
  const alternates = ensureArray(data, 'alternates');

  if (!alternates.length) {
    if (o.alternateId || o.alternateName) {
      throw unknownAlternateError(alternates, o.alternateId || o.alternateName, fieldPath);
    }
    // Legacy estimate with no groups. Seed "Base" EXACTLY the way the
    // editor's ensureAlternates does — a bare group, no section headers —
    // and adopt every existing line into it.
    //
    // MONEY: both totals engines (js/estimates.js and
    // server/services/money/estimate-totals.js) switch from "sum every
    // line" to "sum lines whose alternateId matches an INCLUDED group"
    // the moment alternates[] stops being empty. Without the adoption
    // backfill below, a text-only scope write would drop this estimate's
    // proposal total to $0 — and a job converted from it would be seeded
    // with no scope at all. The backfill makes the seed provably
    // total-neutral: same lines, same one group, same sum.
    alternates.push({
      id: 'alt_default',
      name: 'Base',
      isDefault: true,
      scope: (typeof data.scopeOfWork === 'string' ? data.scopeOfWork : '') || '',
    });
    data.activeAlternateId = 'alt_default';
    ensureArray(data, 'lines').forEach((l) => {
      if (l && !l.alternateId) l.alternateId = 'alt_default';
    });
  }

  // Recover anything the old dead-field path stranded before we overwrite.
  migrateLegacyEstimateScope(data);

  const alt = resolveAlternateTarget(data, o, fieldPath);
  if (!alt) {
    throw new PayloadValidationError(
      'Cannot write scope: this estimate has no groups to attach it to — nothing was written.',
      { code: 'no_scope_target', field_path: fieldPath, retryable: false,
        suggestion: "Emit estimate ops groups:[{op:'add', name:'Base'}] first, then set the scope." }
    );
  }
  // `undefined` means "no scope text in this op" — used by the seed path,
  // where the point was to establish the group, not to blank its scope.
  // An explicit null/'' is a deliberate clear and is honoured.
  if (text !== undefined) alt.scope = (text === null) ? '' : String(text);
  return alt;
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

// ── Section placement ──────────────────────────────────────────────
//
// The estimate editor groups lines by their POSITION in data.lines, using
// `__section_header__` rows as delimiters (js/estimate-editor.js:2163): a
// header opens a section and every row after it belongs to that section
// until the next header. A line's own `section` / `btCategory` fields are
// NOT consulted for placement.
//
// So appending a new line to the END of the array books it under whichever
// header happens to be last — in a standard estimate, "Subcontractors
// Costs". applyLineAdds resolved the correct target and then pushed anyway,
// which is why 86 burned 2-3 payloads re-placing the same lines.
//
// These mirror the INLINE tool path, which already routes deterministically:
// eeEnsureSectionByCategory (js/estimate-editor.js:3546) and
// applyAddLineItem's insert walk (:3645).

function sameAlternate(a, b) {
  return (a || 'alt_default') === (b || 'alt_default');
}

// Find — or create — the standard section header for a bt category inside
// one alternate. Returns the header row, or null for an unknown category.
function ensureSectionHeader(lines, estimateId, alternateId, btCategory) {
  const preset = STANDARD_SECTION_PRESETS.find((p) => p.btCategory === btCategory);
  const presetName = preset ? preset.name.toLowerCase() : null;
  const existing = lines.find((l) => {
    if (!l || l.section !== '__section_header__') return false;
    if (!sameAlternate(l.alternateId, alternateId)) return false;
    if (l.btCategory === btCategory) return true;
    // A same-named header carrying no btCategory (legacy / AI-created) is
    // the same bucket — adopt and backfill it rather than making a twin.
    return !l.btCategory && presetName &&
           String(l.description || '').toLowerCase() === presetName;
  });
  if (existing) {
    if (!existing.btCategory && preset) existing.btCategory = preset.btCategory;
    return existing;
  }
  if (!preset) return null;
  const hdr = {
    id: 's' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
    estimateId: estimateId,
    alternateId: alternateId || 'alt_default',
    section: '__section_header__',
    description: preset.name,
    btCategory: preset.btCategory,
    // MONEY: a header with no `markup` is not neutral. pricing-pipeline.js
    // sectionMarkupForLine falls through to est.defaultMarkup when the
    // header carries none, so lines under a markup-less header price
    // differently from identical lines under a seeded one. Every other
    // header-creation site stamps 0 (applyEstimateGroups here, and
    // eeEnsureSectionByCategory client-side) — match them.
    markup: 0,
  };
  lines.push(hdr);
  return hdr;
}

// An existing header in this alternate whose NAME matches. The inline path
// does this before falling back to a category (js/estimate-editor.js:3597);
// without it a line addressed to a CUSTOM section ("Roofing") silently
// lands somewhere else.
function findHeaderByName(lines, alternateId, name) {
  const want = String(name || '').trim().toLowerCase();
  if (!want) return null;
  return lines.find((l) =>
    l && l.section === '__section_header__' &&
    sameAlternate(l.alternateId, alternateId) &&
    String(l.description || '').trim().toLowerCase() === want
  ) || null;
}

// The header a row currently sits under — nearest preceding header in the
// same alternate. Used to skip a no-op move (and the reorder it would cause).
function enclosingHeader(lines, idx, alternateId) {
  for (let i = idx - 1; i >= 0; i--) {
    const L = lines[i];
    if (!L || L.section !== '__section_header__') continue;
    if (sameAlternate(L.alternateId, alternateId)) return L;
  }
  return null;
}

// Splice `row` into the section that `header` opens — i.e. immediately
// before the next section header in the SAME alternate. Falls back to the
// end of that alternate's own block, and only then to the array end.
function insertIntoSection(lines, row, header) {
  const startIdx = lines.indexOf(header);
  if (startIdx < 0) { lines.push(row); return; }
  let insertAt = -1;
  for (let j = startIdx + 1; j < lines.length; j++) {
    const L = lines[j];
    if (!L || !sameAlternate(L.alternateId, header.alternateId)) continue;
    if (L.section === '__section_header__') { insertAt = j; break; }
  }
  if (insertAt < 0) {
    // No later header in this alternate — land after the last row that
    // belongs to it, so we never jump past another alternate's block.
    for (let k = lines.length - 1; k > startIdx; k--) {
      const M = lines[k];
      if (M && sameAlternate(M.alternateId, header.alternateId)) { insertAt = k + 1; break; }
    }
  }
  if (insertAt < 0) insertAt = startIdx + 1;
  lines.splice(insertAt, 0, row);
}

function applyLineAdds(data, lineAdds) {
  const lines = ensureArray(data, 'lines');
  const alternates = Array.isArray(data.alternates) ? data.alternates : [];
  let opIndex = -1;
  for (const rawAdd of lineAdds) {
    let add = rawAdd;
    opIndex++;
    const path = `estimate.ops.line_adds[${opIndex}]`;
    // WHICH SCOPE? Resolve it BEFORE anything else, and refuse by name if
    // it can't be resolved. The old behaviour was to fall through to the
    // active scope's Materials section and report "+1 line(s)" — a wrong
    // scope that looks exactly like a right one. `alternate_name` is
    // accepted here for parity with assembly_adds, which has had name
    // resolution (and these refusals) all along.
    const wantsNamedAlt = !!(add.alternate_id || add.alternate_name || add.group_name);
    if (wantsNamedAlt && !alternates.length) {
      // Naming a scope on an estimate that has none can only be a mistake.
      throw unknownAlternateError(
        alternates, add.alternate_id || add.alternate_name || add.group_name,
        path, { op_index: opIndex }
      );
    }
    if (alternates.length) {
      const named = resolveAlternateTarget(data, {
        alternateId: add.alternate_id || null,
        alternateName: add.alternate_name || add.group_name || null,
        errorExtra: { op_index: opIndex },
      }, path);
      if (wantsNamedAlt && named) {
        add = Object.assign({}, add, { alternateId: named.id });
      }
      const explicitAlt = add.alternateId || add.group_id || null;
      // group_id doubles as a subgroup (section header) id in some older
      // payloads, so only refuse when it matches NEITHER.
      if (explicitAlt
          && !alternates.some((a) => a && a.id === explicitAlt)
          && !findSubgroupHeader(lines, explicitAlt)) {
        throw unknownAlternateError(alternates, explicitAlt, path, { op_index: opIndex });
      }
      if (add.subgroup_id
          && !findSubgroupHeader(lines, add.subgroup_id)
          && !alternates.some((a) => a && a.id === add.subgroup_id)) {
        throw new PayloadValidationError(
          `Unknown subgroup_id "${add.subgroup_id}" on this estimate — no line was added.`,
          { code: 'unknown_subgroup', field_path: path + '.subgroup_id',
            op_index: opIndex, received: add.subgroup_id, retryable: false,
            expected: lines.filter((l) => l && l.section === '__section_header__')
              .map((l) => `${l.id} (${l.description || 'subgroup'})`),
            suggestion: 'Use a section-header id from this estimate, or drop subgroup_id and pass `section` (the subgroup name) instead.' }
        );
      }
    }
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
    // The header row this line must be spliced under. The resolve block
    // below already finds it; capturing it here is what stops the answer
    // being thrown away at placement time.
    let targetHeader = null;
    if (add.subgroup_id) {
      const header = findSubgroupHeader(lines, add.subgroup_id);
      if (header) {
        targetHeader = header;
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
            targetHeader = chosen;
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

    // Placement. Grouping is positional, so this is what actually decides
    // which subgroup the line renders under — the section/btCategory fields
    // above are only carried for the BT export.
    // 1. The header subgroup_id resolved to. An explicit alternateId can
    //    override the one it came from, in which case it belongs to another
    //    alternate and must not be used.
    let placeHeader = targetHeader;
    if (placeHeader && !sameAlternate(placeHeader.alternateId, row.alternateId)) {
      placeHeader = null;
    }
    // 2. An existing header matching the section NAME. Mirrors the inline
    //    path; without it, adds addressed to a custom section land elsewhere.
    if (!placeHeader && sectionName) {
      placeHeader = findHeaderByName(lines, row.alternateId, sectionName);
    }
    // 3. A standard section by category — EXACT matches only. btCategoryFromName
    //    (used for the export metadata above) is a substring matcher whose keys
    //    include the 3-char 'sub', so it resolves "Substrate Repair" to
    //    Subcontractors and never returns falsy. Fine for a metadata field;
    //    it must never decide placement.
    const placeCat = add.btCategory || add.bt_category
      || BT_CATEGORY_BY_SECTION_NAME[sectionName];
    if (!placeHeader && placeCat) {
      placeHeader = ensureSectionHeader(lines, data.id, row.alternateId, placeCat);
    }
    // 4. Nothing resolved. Materials — never the array end, which silently
    //    books the line as Subcontractor cost.
    if (!placeHeader) {
      placeHeader = ensureSectionHeader(lines, data.id, row.alternateId, 'materials');
    }
    if (placeHeader) {
      if (!row.section)    row.section    = placeHeader.description || null;
      if (!row.btCategory) row.btCategory = placeHeader.btCategory  || null;
      insertIntoSection(lines, row, placeHeader);
    } else {
      lines.push(row); // true last resort — no headers exist at all
    }
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
  let edited = 0;
  for (const edit of lineEdits) {
    const idx = lines.findIndex((l) => l.id === edit.line_id);
    if (idx < 0) throw new Error(`line_id not found: ${edit.line_id}`);
    // The Scribe emits edits FLAT ({line_id, markup, unitCost, description, …});
    // an earlier shape nested them under `fields`. Accept BOTH: use `fields`
    // when present, else the edit's own top-level keys. line_id/op/fields/
    // subgroup_id are control keys (not editable line fields), so they're
    // excluded — a reprice/rename edit must not silently move the line's scope.
    const CONTROL = new Set(['line_id', 'op', 'fields', 'subgroup_id']);
    const f = (edit.fields && typeof edit.fields === 'object')
      ? edit.fields
      : Object.fromEntries(Object.entries(edit).filter(([k]) => !CONTROL.has(k)));
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

    // MOVE. An edit carrying subgroup_id is a request to RE-SECTION the
    // line. Grouping is positional, so writing section/btCategory alone
    // does nothing — the row has to be physically re-spliced. Before this,
    // subgroup_id was dropped as a control key and the move silently
    // no-op'd, which is why 86's "reassign these lines" retries appeared
    // to do nothing.
    //
    // subgroup_id STAYS in CONTROL above on purpose: it must never be
    // copied onto the row as a stray property. It is read directly here.
    // No subgroup_id → no move, which preserves the guard that a pure
    // reprice/rename edit can't shift a line's scope.
    if (edit.subgroup_id) {
      const line = lines[idx];
      if (line.section !== '__section_header__') {
        // Resolve the alternate the same way the add path does — reading
        // line.alternateId raw would mint a phantom 'alt_default' header
        // that no alternate owns, dropping the line out of the proposal.
        const altId = line.alternateId
          || data.activeAlternateId
          || (Array.isArray(data.alternates) && data.alternates[0] && data.alternates[0].id)
          || 'alt_default';
        let hdr = findSubgroupHeader(lines, edit.subgroup_id);
        // A header in ANOTHER alternate must not pull the line out of its
        // own block: it would sit above its alternate's first header with no
        // section markup, no subtotal and a fallback BT code. Re-resolve the
        // same category inside this line's alternate instead.
        if (hdr && !sameAlternate(hdr.alternateId, altId)) {
          hdr = ensureSectionHeader(lines, data.id, altId, hdr.btCategory);
        }
        if (!hdr) {
          // 86 conflates header id / section name / bt category. Resolve by
          // NAME then by EXACT category — deliberately not btCategoryFromName,
          // which substring-matches (a header id whose random suffix contains
          // 'gc' or 'sub' would relocate the line) and never returns falsy.
          hdr = findHeaderByName(lines, altId, edit.subgroup_id);
          if (!hdr) {
            const cat = edit.btCategory || edit.bt_category
              || BT_CATEGORY_BY_SECTION_NAME[edit.subgroup_id];
            if (cat) hdr = ensureSectionHeader(lines, data.id, altId, cat);
          }
        }
        if (!hdr) {
          // Never report a move that did not happen. line_id already throws
          // when unresolvable; an unresolvable subgroup_id is the same class
          // of caller error, and silently counting it as an applied edit is
          // how 86 concludes a write landed and stops retrying.
          throw new Error(`subgroup_id not found: ${edit.subgroup_id}`);
        }
        // Skip a no-op move — re-splicing into the section it already sits
        // in would reorder it for nothing.
        if (enclosingHeader(lines, idx, altId) !== hdr) {
          lines.splice(idx, 1);            // remove from its current slot
          insertIntoSection(lines, line, hdr);
          line.section    = hdr.description || line.section;
          line.btCategory = hdr.btCategory  || line.btCategory;
        }
      }
    }
    edited++;
  }
  return edited;
}

function applyLineDeletes(data, lineDeletes) {
  const lines = ensureArray(data, 'lines');
  // The Scribe emits deletes as objects [{line_id:'…'}]; accept bare id strings
  // too. Return the count ACTUALLY removed (not the request length) so the apply
  // summary can't report a phantom deletion.
  const ids = new Set(lineDeletes.map((d) => (typeof d === 'string' ? d : (d && (d.line_id || d.id)))).filter(Boolean));
  const before = lines.length;
  data.lines = lines.filter((l) => !ids.has(l.id));
  return before - data.lines.length;
}

// ──────────────────────────────────────────────────────────────────
// dispatchJob — handles ops on entity_type='job'.
//
// Job state lives in jobs.data (JSONB blob with phases, changeOrders,
// purchaseOrders, invoices, etc.) plus the real CO/PO/invoice tables.
// All mutations happen inside the outer transaction so a multi-section
// apply is atomic.
//
// It ALSO used to write node_graphs.data and qb_cost_lines.linked_node_id
// for node_values / wire_updates / graph / qb_assignments. Those wrote
// fields no rollup reads anymore, so they committed and reported success
// while the job's money stayed exactly where it was. The branch is gone and
// the ops are refused by name (RETIRED_JOB_OPS) — validateOps catches them
// first; the guard below is the belt for any path that skips validation.
// ──────────────────────────────────────────────────────────────────

async function dispatchJob(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

  for (const k of Object.keys(RETIRED_JOB_OPS)) {
    if (ops[k] != null) {
      throw new PayloadValidationError(
        `job.ops.${k} is RETIRED — this write would move NO money and is refused. ${RETIRED_JOB_OPS[k]}`,
        { code: 'retired_op', field_path: `job.ops.${k}`, received: k,
          retryable: false, suggestion: RETIRED_JOB_OPS[k] }
      );
    }
  }

  let id = resolveRef(target.entity_id, refTable);
  if (!id) throw new Error('job ops require entity_id');
  id = await resolveJobTarget(dbClient, id, ctx && ctx.organizationId);
  await assertTargetOrg(dbClient, 'job', id, ctx && ctx.organizationId);

  // Second layer under assertTargetOrg. Same shape the bulk save now carries:
  // the JS guard should already have refused, and a wholesale `data` rewrite is
  // not a statement to leave unpredicated on the strength of a guard one call
  // frame up.
  const r = await dbClient.query(
    `SELECT data FROM jobs WHERE id = $1
       AND (organization_id = $2 OR organization_id IS NULL)`,
    [id, ctx && ctx.organizationId]);
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
  //
  // These are REAL TABLES — job_change_orders, job_purchase_orders,
  // invoices — not arrays on the job blob. They used to be written into
  // data.changeOrders / .purchaseOrders / .invoices here, which no
  // reader has consulted since those tables landed: every CO, PO, and
  // invoice an agent created was silently lost. Everything now routes
  // through services/job-financials.js, which gets THIS transaction's
  // client so the records commit or roll back with the rest of the
  // payload, and which enforces the same numbering, field stripping,
  // and applied/locked/closed guards as the REST routes.
  const orgId = (ctx && ctx.organizationId) != null ? ctx.organizationId : null;
  const ownerId = (ctx && ctx.userId) || null;

  async function applyRecordOps(items, idKey, svc, displayName) {
    for (const op of items) {
      if (!op || !op.op) throw new Error(`${displayName}[].op required`);
      if (op.op === 'create') {
        const row = await svc.create(op.fields || {});
        // Let later ops in the same payload point at what we just made.
        if (isRef(op[idKey])) refTable[op[idKey]] = row.id;
      } else if (op.op === 'update') {
        const idVal = resolveRef(op[idKey], refTable);
        if (!idVal) throw new Error(`${displayName}[].update requires ${idKey}`);
        await svc.update(idVal, op.fields || {});
      } else if (op.op === 'delete') {
        const idVal = resolveRef(op[idKey], refTable);
        if (!idVal) throw new Error(`${displayName}[].delete requires ${idKey}`);
        await svc.remove(idVal);
      } else {
        throw new Error(`${displayName}[].op must be create|update|delete, got: ${op.op}`);
      }
    }
  }

  if (Array.isArray(ops.change_orders) && ops.change_orders.length) {
    await applyRecordOps(ops.change_orders, 'co_id', {
      // jobId is passed on update/delete too: without it, an op inside a
      // payload targeting job A could reach job B's CO by id alone.
      create: (fields) => jobFin.createChangeOrder(dbClient, { jobId: id, orgId, ownerId, fields }),
      update: (rid, fields) => jobFin.updateChangeOrder(dbClient, { id: rid, orgId, jobId: id, fields }),
      remove: (rid) => jobFin.deleteChangeOrder(dbClient, { id: rid, orgId, jobId: id }),
    }, 'change_orders');
    changes.push(`${ops.change_orders.length} CO op(s)`);
  }
  if (Array.isArray(ops.purchase_orders) && ops.purchase_orders.length) {
    await applyRecordOps(ops.purchase_orders, 'po_id', {
      create: (fields) => jobFin.createPurchaseOrder(dbClient, { jobId: id, orgId, ownerId, fields }),
      update: (rid, fields) => jobFin.updatePurchaseOrder(dbClient, { id: rid, orgId, jobId: id, fields }),
      remove: (rid) => jobFin.deletePurchaseOrder(dbClient, { id: rid, orgId, jobId: id }),
    }, 'purchase_orders');
    changes.push(`${ops.purchase_orders.length} PO op(s)`);
  }
  if (Array.isArray(ops.invoices) && ops.invoices.length) {
    await applyRecordOps(ops.invoices, 'invoice_id', {
      // An invoice op inside a JOB payload belongs to THAT job. Honouring a
      // fields.job_id override would let a payload for job A create or move
      // an invoice onto job B — and GET /jobs/:jobId/invoices filters on
      // job_id alone, with no org predicate, so the invoice would surface
      // there. The dispatched job wins; a mismatched job_id is refused.
      create: (fields) => {
        if (fields && fields.job_id && fields.job_id !== id) {
          throw new Error(
            `invoice create: fields.job_id (${fields.job_id}) does not match the job this ` +
            `payload targets (${id}). Emit a separate target for the other job.`);
        }
        return jobFin.createInvoice(dbClient, { jobId: id, orgId, ownerId, fields });
      },
      update: (rid, fields) => jobFin.updateInvoice(dbClient, { id: rid, orgId, jobId: id, fields }),
      remove: (rid) => jobFin.deleteInvoice(dbClient, { id: rid, orgId, jobId: id }),
    }, 'invoices');
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
  const wrote = await dbClient.query(
    `UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2
       AND (organization_id = $3 OR organization_id IS NULL)`,
    [JSON.stringify(data), id, ctx && ctx.organizationId]
  );
  if (!wrote.rowCount) throw new Error(`Job not found: ${id}`);

  // (node_graphs + qb_cost_lines.linked_node_id writes removed here —
  // see the RETIRED_JOB_OPS guard at the top of this function.)

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

    // organization_id from ctx — a NULL-org lead is readable by every tenant
    // through the `OR organization_id IS NULL` predicate. LEAD_EDITABLE_FIELDS
    // already excludes it, so this cannot be overridden from the payload.
    const cols = ['id', 'created_by', 'organization_id'];
    const vals = [id, ctx.userId || null, (ctx && ctx.organizationId) || null];
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
  //
  // REFUSED rather than defaulted to null. Every live caller already has one:
  // POST /api/payloads/:id/apply is behind requireOrg, and applyPayloadForUser
  // refuses outright without `user.organization_id`. So `|| null` never
  // described a real caller — it described the shape of the bug, because the
  // `if (schedOrgId)` guards below then emitted UPDATE and DELETE statements
  // with NO tenant predicate. A write arm that silently widens is worse than a
  // read arm that does: it returns 200 with 0 rows matched, or matches the
  // wrong tenant's row, and nothing about the response says so.
  const schedOrgId = (ctx && ctx.organizationId) || null;
  if (schedOrgId == null) {
    throw new Error('schedule_ops requires a resolved organization — the payload apply was refused rather than run unscoped.');
  }

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
           (id, job_id, start_date, days, crew, includes_weekends, status, notes, created_by, organization_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $10)`,
        [
          id, jobId, startDate, days, JSON.stringify(crew),
          !!(b.includesWeekends || b.includes_weekends),
          b.status || 'planned',
          b.notes || null,
          ctx.userId || null,
          // Same NULL-org visibility problem as clients/leads/estimates: this
          // dispatcher's own update/delete predicate is `OR organization_id
          // IS NULL`, so an unstamped entry is editable by any tenant.
          (ctx && ctx.organizationId) || null,
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
      // Unconditional — schedOrgId cannot be null (refused above).
      // OR-IS-NULL (org tolerance).
      params.push(schedOrgId); schedWhere += ` AND (organization_id = $${params.length} OR organization_id IS NULL)`;
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
      // Unconditional — schedOrgId cannot be null (refused above).
      // OR-IS-NULL (org tolerance).
      delParams.push(schedOrgId); delWhere += ' AND (organization_id = $2 OR organization_id IS NULL)';
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
// dispatchSystem — platform-side writes (skill packs, field tools,
// entity links). watch_ops + staff_agent_ops removed 2026-07-03 —
// both features retired with zero production usage.
// ──────────────────────────────────────────────────────────────────

async function dispatchSystem(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);

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
        const ftCreateOrg = (ctx && ctx.organizationId) || null;
        if (!ftCreateOrg) {
          throw new Error('field_tool_ops create: could not determine your organization — nothing was written.');
        }
        await dbClient.query(
          // F4 — the tell. field_tools has THREE create doors: the human one
          // (field-tools-routes.js) stamps organization_id, and both AGENT
          // doors did not, so the table already holds non-uniform data. Two
          // consequences, not one: an un-stamped tool is visible to every
          // tenant through the OR-IS-NULL arm the edit/delete below carry, AND
          // the unique index is on (organization_id, name) — NULLs never
          // collide in Postgres, so agent-created tools could pile up under one
          // name and could never conflict with a real org's tool.
          //
          // Stamped from ctx, never from the payload's fields, and refused
          // rather than written NULL: the org is the boundary, so "I could not
          // tell" has to stop the write.
          `INSERT INTO field_tools (id, name, description, category, html_body, created_by, organization_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [id, f.name, f.description || null, f.category || null, f.html_body, ctx.userId || null, ftCreateOrg]
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
        // Unconditional, and note WHAT the false branch was dropping: not just
        // the tenant predicate but `AND is_system = false` with it. An org-less
        // apply could therefore edit a BUILT-IN field tool — the one thing the
        // comment above says this guard exists to prevent. The guard and the
        // tenant scope were welded to the same `if`, so losing one lost both.
        if (ftOrgId == null) {
          throw new Error('field_tool_ops edit requires a resolved organization — refused rather than run unscoped (which would also have bypassed the is_system guard).');
        }
        let ftWhere = `id = $${p}`;
        // OR-IS-NULL (org tolerance).
        vals.push(ftOrgId); ftWhere += ` AND (organization_id = $${vals.length} OR organization_id IS NULL) AND is_system = false`;
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
        // Same weld as the edit above, and DELETE is the worse half: without
        // an org the statement became `DELETE FROM field_tools WHERE id = $1`,
        // which reaches another tenant's tool and every built-in one.
        if (ftDelOrgId == null) {
          throw new Error('field_tool_ops delete requires a resolved organization — refused rather than run unscoped (which would also have bypassed the is_system guard).');
        }
        const ftDelParams = [id];
        let ftDelWhere = 'id = $1';
        // OR-IS-NULL (org tolerance).
        ftDelParams.push(ftDelOrgId); ftDelWhere += ' AND (organization_id = $2 OR organization_id IS NULL) AND is_system = false';
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
        const jr = await dbClient.query(
          `SELECT data FROM jobs WHERE id = $1
             AND (organization_id = $2 OR organization_id IS NULL)`,
          [jobId, ctx && ctx.organizationId]);
        if (!jr.rows.length) throw new Error(`job ${jobId} not found`);
        const data = jr.rows[0].data || {};
        data.client_id = clientId;
        const lw = await dbClient.query(
          `UPDATE jobs SET data = $1, updated_at = NOW() WHERE id = $2
             AND (organization_id = $3 OR organization_id IS NULL)`,
          [JSON.stringify(data), jobId, ctx && ctx.organizationId]
        );
        if (!lw.rowCount) throw new Error(`job ${jobId} not found`);
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

function newCalendarEventId() {
  return 'cal_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}
function newTaskId() {
  return 'task_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// dispatchCalendarEvent — create a personal/timed calendar event (also the
// vehicle for a timed "reminder" via reminder_minutes). organization_id +
// user_id are stamped from ctx so a payload can never write into another
// user's calendar or org. Create-only in v1.
async function dispatchCalendarEvent(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  if (!ctx || !ctx.organizationId || !ctx.userId) {
    throw new Error('calendar_event write requires an authenticated org + user context');
  }
  const opType = ops.op || 'create';
  if (opType !== 'create') throw new Error(`calendar_event: only op:create is supported (got '${opType}')`);
  const fields = ops.fields || {};
  if (!fields.title || !String(fields.title).trim()) throw new Error('calendar_event.create requires fields.title');
  if (!fields.starts_at) throw new Error('calendar_event.create requires fields.starts_at');

  const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newCalendarEventId();

  // 86/Scribe emits starts_at/ends_at as a NAIVE local datetime
  // ('2026-06-25T09:00:00', no offset). starts_at is TIMESTAMPTZ and the
  // pg session is UTC, so a bare string would be stored as UTC and then
  // re-render in the user's zone shifted by hours (and, near midnight, a
  // whole day). Resolve the acting user's tz and stamp the offset so the
  // saved instant matches the local day/time the user approved.
  let acctTz = DEFAULT_TZ;
  if (fields.starts_at || fields.ends_at) {
    try {
      const tzr = await dbClient.query(
        'SELECT u.timezone AS utz, o.timezone AS otz FROM users u ' +
        'LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1',
        [ctx.userId]
      );
      const r = tzr.rows[0] || {};
      acctTz = resolveTz(r.utz, r.otz);
    } catch (e) { acctTz = DEFAULT_TZ; }
  }
  let savedStartsAt = fields.starts_at;

  // Whitelisted columns only; org + owner are stamped, never client-supplied.
  const cols = ['id', 'organization_id', 'user_id'];
  const vals = [id, ctx.organizationId, ctx.userId];
  for (const k of Object.keys(fields)) {
    if (!CALENDAR_EVENT_FIELDS.has(k)) continue;
    let v = fields[k];
    if ((k === 'starts_at' || k === 'ends_at') && v) {
      const inst = localWallClockToInstant(v, acctTz);
      if (inst) v = inst.toISOString();
      if (k === 'starts_at') savedStartsAt = v;
    }
    cols.push(k);
    vals.push(v);
  }
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await dbClient.query(
    `INSERT INTO calendar_events (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
  if (isRef(target.entity_id)) refTable[target.entity_id] = id;

  return {
    entity_type: 'calendar_event',
    entity_id: id,
    op: 'create',
    created: true,
    title: String(fields.title).trim(),
    starts_at: savedStartsAt,
    all_day: !!(fields.all_day === true || fields.all_day === 'true'),
    linked_entity_type: fields.entity_type || null,
    linked_entity_id: fields.entity_id || null,
    summary: `Created calendar event "${String(fields.title).trim()}"` +
      (fields.entity_type ? ` (linked to ${fields.entity_type})` : ''),
  };
}

// dispatchTask — create an ORG task (org-wide visible). organization_id +
// created_by are stamped from ctx; assignee_user_id comes from the op (an
// explicit in-org user) and defaults to the actor. scope stays the table
// default 'org'. Create-only in v1.
async function dispatchTask(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  if (!ctx || !ctx.organizationId || !ctx.userId) {
    throw new Error('task write requires an authenticated org + user context');
  }
  const opType = ops.op || 'create';
  if (opType !== 'create') throw new Error(`task: only op:create is supported (got '${opType}')`);
  const fields = ops.fields || {};
  if (!fields.title || !String(fields.title).trim()) throw new Error('task.create requires fields.title');

  // Resolve assignee: an explicit in-org user, else default to the actor. A
  // foreign/invalid id is rejected here (before the FK would blow up).
  let assignee = ctx.userId;
  if (fields.assignee_user_id != null) {
    const n = Number(fields.assignee_user_id);
    const okq = await dbClient.query(
      'SELECT 1 FROM users WHERE id = $1 AND organization_id = $2',
      [n, ctx.organizationId]
    );
    if (!okq.rowCount) throw new Error(`task.fields.assignee_user_id ${n} is not a user in this organization`);
    assignee = n;
  }

  const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newTaskId();
  // assignee_user_id is in the base cols ONCE; the field loop skips it to
  // avoid a duplicate-column INSERT.
  const cols = ['id', 'organization_id', 'created_by', 'assignee_user_id'];
  const vals = [id, ctx.organizationId, ctx.userId, assignee];
  for (const k of Object.keys(fields)) {
    if (!TASK_FIELDS.has(k) || k === 'assignee_user_id') continue;
    cols.push(k);
    vals.push(fields[k]);
  }
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await dbClient.query(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
  if (isRef(target.entity_id)) refTable[target.entity_id] = id;

  return {
    entity_type: 'task',
    entity_id: id,
    op: 'create',
    created: true,
    title: String(fields.title).trim(),
    assignee_user_id: assignee,
    due_date: fields.due_date || null,
    linked_entity_type: fields.entity_type || null,
    linked_entity_id: fields.entity_id || null,
    summary: `Created task "${String(fields.title).trim()}"` +
      (assignee !== ctx.userId ? ` (assigned to user ${assignee})` : '') +
      (fields.entity_type ? ` (linked to ${fields.entity_type})` : ''),
  };
}

// dispatchTodo — create a PERSONAL to-do, private to the acting user.
// scope='personal' + owner_user_id stamped from ctx; NOT assignable. The
// fail-closed read predicate (tasks-routes.js) shows it only to its owner.
async function dispatchTodo(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  if (!ctx || !ctx.organizationId || !ctx.userId) {
    throw new Error('todo write requires an authenticated org + user context');
  }
  const opType = ops.op || 'create';
  if (opType !== 'create') throw new Error(`todo: only op:create is supported (got '${opType}')`);
  const fields = ops.fields || {};
  if (!fields.title || !String(fields.title).trim()) throw new Error('todo.create requires fields.title');

  const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newTaskId();
  const cols = ['id', 'organization_id', 'created_by', 'scope', 'owner_user_id'];
  const vals = [id, ctx.organizationId, ctx.userId, 'personal', ctx.userId];
  for (const k of Object.keys(fields)) {
    if (!TODO_FIELDS.has(k)) continue;
    cols.push(k);
    vals.push(fields[k]);
  }
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await dbClient.query(
    `INSERT INTO tasks (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
  if (isRef(target.entity_id)) refTable[target.entity_id] = id;

  return {
    entity_type: 'todo',
    entity_id: id,
    op: 'create',
    created: true,
    title: String(fields.title).trim(),
    due_date: fields.due_date || null,
    linked_entity_type: fields.entity_type || null,
    linked_entity_id: fields.entity_id || null,
    summary: `Added to-do "${String(fields.title).trim()}"`,
  };
}

function newReminderId() {
  return 'rem_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
}

// dispatchReminder — create a PERSONAL timed nudge in the reminders table
// (its own list, separate from the calendar). org + user stamped from ctx;
// source='assistant'. remind_at arrives as a naive local datetime from
// 86/Scribe — resolved to the actor's tz so the stored instant matches the
// local time the user approved (same posture as dispatchCalendarEvent).
async function dispatchReminder(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  if (!ctx || !ctx.organizationId || !ctx.userId) {
    throw new Error('reminder write requires an authenticated org + user context');
  }
  const opType = ops.op || 'create';
  if (opType !== 'create') throw new Error(`reminder: only op:create is supported (got '${opType}')`);
  const fields = ops.fields || {};
  if (!fields.title || !String(fields.title).trim()) throw new Error('reminder.create requires fields.title');
  if (!fields.remind_at) throw new Error('reminder.create requires fields.remind_at');

  let acctTz = DEFAULT_TZ;
  try {
    const tzr = await dbClient.query(
      'SELECT u.timezone AS utz, o.timezone AS otz FROM users u ' +
      'LEFT JOIN organizations o ON o.id = u.organization_id WHERE u.id = $1',
      [ctx.userId]
    );
    const r = tzr.rows[0] || {};
    acctTz = resolveTz(r.utz, r.otz);
  } catch (e) { acctTz = DEFAULT_TZ; }
  let remindAt = fields.remind_at;
  const inst = localWallClockToInstant(remindAt, acctTz);
  if (inst) remindAt = inst.toISOString();

  const id = (target.entity_id && !isRef(target.entity_id)) ? target.entity_id : newReminderId();
  const cols = ['id', 'organization_id', 'user_id', 'title', 'remind_at', 'source'];
  const vals = [id, ctx.organizationId, ctx.userId, String(fields.title).trim(), remindAt, 'assistant'];
  if (fields.notes != null) { cols.push('notes'); vals.push(String(fields.notes)); }
  if (fields.entity_type && fields.entity_id) {
    cols.push('entity_type'); vals.push(String(fields.entity_type));
    cols.push('entity_id');   vals.push(String(fields.entity_id));
  }
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await dbClient.query(
    `INSERT INTO reminders (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );
  if (isRef(target.entity_id)) refTable[target.entity_id] = id;

  return {
    entity_type: 'reminder',
    entity_id: id,
    op: 'create',
    created: true,
    title: String(fields.title).trim(),
    remind_at: remindAt,
    linked_entity_type: fields.entity_type || null,
    linked_entity_id: fields.entity_id || null,
    summary: `Set reminder "${String(fields.title).trim()}"`,
  };
}

// ── assembly — costed estimating recipes (relational tables) ─────────
// 86's write path for the assembly database. Reuses the shared service
// (validation incl. the sub-assembly cycle guard) with THIS transaction's
// client so the whole payload stays atomic.
async function dispatchAssembly(dbClient, target, refTable, ctx) {
  const asmSvc = require('./assemblies');
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  if (!ctx || !ctx.organizationId) {
    throw new Error('assembly write requires an authenticated org context');
  }
  const orgId = ctx.organizationId;
  const opType = ops.op || (target.entity_id ? 'update' : 'create');

  const tuneOpts = {
    userId: ctx.userId || null,
    source: (ctx.sourceAgent === 'scribe' || ctx.emittingAgentKey === 'scribe') ? 'scribe' : '86',
    reason: ops.reason ? String(ops.reason).slice(0, 500) : null,
    // We always run inside applyPayload's BEGIN/COMMIT — tells assemblies.js to
    // SAVEPOINT-isolate its best-effort tuning-log write so a log failure can't
    // poison this transaction (and silently ROLLBACK the whole assembly).
    inTxn: true,
  };

  if (opType === 'create') {
    const fields = ops.fields || {};
    let id;
    try {
      id = await asmSvc.createAssembly(dbClient, orgId, fields, ctx.userId || null);
    } catch (ve) { throw new Error('assembly.create: ' + ve.message); }
    if (Array.isArray(ops.items) && ops.items.length) {
      const err = await asmSvc.replaceItems(dbClient, id, ops.items, orgId, tuneOpts);
      if (err) throw new Error('assembly.create items: ' + err);
    }
    // Best-effort creation log — SAVEPOINT-isolated so a log failure can't
    // poison the outer txn (which would silently ROLLBACK the assembly).
    await asmSvc.bestEffortInTxn(dbClient, 'asm_log_create', () => asmSvc.logTuning(dbClient, orgId, id,
      [{ field: 'created', new_value: (fields.name || '') + ' (' + ((ops.items || []).length) + ' items)' }], tuneOpts));
    // If this assembly was built from a research-inbox packet, consume+link
    // that packet in-txn — org-scoped, unprocessed-only — so it points at
    // exactly the assembly 86 built from it. No client-side guessing about
    // which of the shared pane's cards a handed packet belongs to. Same
    // SAVEPOINT isolation: a failed link (e.g. a lock timeout when two applies
    // build from the same packet) degrades to skip-the-link, never poisoning
    // the assembly create.
    const srcRid = parseInt(ops.source_research_id, 10);
    if (Number.isFinite(srcRid) && srcRid > 0) {
      await asmSvc.bestEffortInTxn(dbClient, 'link_src', () => dbClient.query(
        `UPDATE assembly_research SET status = 'consumed', consumed_assembly_id = $1, consumed_at = NOW()
           WHERE id = $2 AND organization_id = $3 AND status = 'unprocessed'`,
        [id, srcRid, orgId]));
    }
    if (isRef(target.entity_id)) refTable[target.entity_id] = id;
    return {
      entity_type: 'assembly', entity_id: id, op: 'create',
      changes: [{ field: 'items', after: (ops.items || []).length + ' recipe row(s)' }],
      summary: `Created assembly "${fields.name}" (${fields.unit || 'EA'}) with ${(ops.items || []).length} item(s)`,
    };
  }

  const asmId = parseInt(target.entity_id, 10);
  if (!isFinite(asmId)) throw new Error('assembly.' + opType + ' requires a numeric entity_id');
  const row = await dbClient.query(
    'SELECT id, name FROM assemblies WHERE id = $1 AND (organization_id = $2 OR organization_id IS NULL)',
    [asmId, orgId]);
  if (!row.rows.length) throw new Error('Assembly not found: ' + asmId);
  const asmName = row.rows[0].name;

  if (opType === 'update') {
    const changes = [];
    if (ops.fields && Object.keys(ops.fields).length) {
      await asmSvc.updateHeader(dbClient, orgId, asmId, ops.fields);
      changes.push({ field: 'header', after: Object.keys(ops.fields).join(', ') });
    }
    if (Array.isArray(ops.items)) {
      const err = await asmSvc.replaceItems(dbClient, asmId, ops.items, orgId, tuneOpts);
      if (err) throw new Error('assembly.update items: ' + err);
      changes.push({ field: 'items', after: ops.items.length + ' recipe row(s) (full replace)' });
    }
    return {
      entity_type: 'assembly', entity_id: asmId, op: 'update', changes,
      summary: `Updated assembly "${asmName}" (${changes.map((c) => c.field).join(' + ') || 'no-op'})`,
    };
  }

  if (opType === 'delete') {
    const parents = await dbClient.query(
      `SELECT DISTINCT a.name FROM assembly_items ai JOIN assemblies a ON a.id = ai.assembly_id
        WHERE ai.child_assembly_id = $1`, [asmId]);
    if (parents.rows.length) {
      throw new Error(`Cannot delete "${asmName}" — nested as a sub-assembly in: ` +
        parents.rows.map((r) => r.name).join(', '));
    }
    await dbClient.query('DELETE FROM assemblies WHERE id = $1', [asmId]);
    return {
      entity_type: 'assembly', entity_id: asmId, op: 'delete', changes: [],
      summary: `Deleted assembly "${asmName}"`,
    };
  }

  throw new Error(`assembly: unsupported op '${opType}'`);
}

// Deal-memory notes (slice 4) — the APPLY-TIME Critic + append-only writer.
// entity_id = the lineage_root. Only the notes column is ever written; numbers
// stay owned by refreshDealNumbers (single-writer). The row is guaranteed to
// exist because refreshDealNumbers runs on every deal-thread turn before 86 can
// emit this op.
async function dispatchDealMemory(dbClient, target, refTable, ctx) {
  const ops = target.ops || {};
  resolveRefsInOps(ops, refTable);
  // Fail CLOSED on missing org context (matches dispatchReminder) — an authed
  // org is required before we touch any deal's memory.
  if (!ctx || !ctx.organizationId) {
    throw new Error('deal_memory write requires an authenticated org context');
  }
  const root = target.entity_id;
  if (!root || isRef(root)) {
    throw new Error('deal_memory requires a concrete entity_id (the lineage_root from the <deal_memory> block)');
  }
  const r = await dbClient.query(
    'SELECT organization_id, notes FROM deal_memory WHERE lineage_root = $1 FOR UPDATE', [root]
  );
  if (!r.rows.length) {
    // Structured so 86 self-corrects: it must target the "Deal key" from the
    // <deal_memory> block, and the row seeds on the first deal-thread turn.
    throw new PayloadValidationError(
      `deal_memory row not found for lineage_root ${root} — target the "Deal key" shown in the <deal_memory> block (the deal thread seeds its row on the first turn)`,
      { code: 'deal_memory_not_seeded', received: root });
  }
  // Tolerant org guard — deal_memory is keyed on lineage_root, so assertTargetOrg
  // (which keys on id) can't be reused. Skip when the row has no org (legacy).
  const rowOrg = r.rows[0].organization_id;
  if (rowOrg != null && ctx && ctx.organizationId && rowOrg !== ctx.organizationId) {
    throw new Error(`deal_memory not found for lineage_root ${root}`);
  }
  let notes = Array.isArray(r.rows[0].notes) ? r.rows[0].notes.slice() : [];
  const by = (ctx && ctx.sourceAgent) || '86';
  const now = new Date().toISOString();

  // (a) validate supersede ids exist BEFORE any mutation.
  const supersedeIds = new Set((ops.note_supersedes || []).map((s) => s.id));
  for (const id of supersedeIds) {
    if (!notes.find((n) => n && n.id === id)) {
      throw new PayloadValidationError(`deal_memory.note_supersedes: unknown note id '${id}'`,
        { code: 'missing_supersede_id', received: id });
    }
  }
  // (b) append new notes (append-only) — apply-time no-money re-check (defense in depth).
  const added = [], newAddIds = [];
  for (const n of (ops.note_adds || [])) {
    const text = String((typeof n === 'object' ? n.text : n)).slice(0, NOTE_TEXT_CAP);
    if (MONEY_RE.test(text)) {
      throw new PayloadValidationError('deal_memory note contains a money figure', { code: 'money_in_note', received: text });
    }
    const note = { id: newNoteId(), at: now, by, text, superseded_by: null };
    notes.push(note); added.push(note); newAddIds.push(note.id);
  }
  // (c) link supersede → replacement (first added note, else a marker).
  const replacementId = newAddIds[0] || null;
  for (const nn of notes) {
    if (nn && supersedeIds.has(nn.id) && !nn.superseded_by) nn.superseded_by = replacementId || 'superseded';
  }
  // (d) deterministic total-cap eviction — drop already-superseded first, then
  // oldest active, until ACTIVE text is under the cap. Never evict a note added
  // in THIS op (a single huge op may exceed the cap by design rather than drop
  // its own writes).
  // (d) active-text cap — evict the oldest ACTIVE note (never one added in THIS
  // op) until active text is under cap. Superseded notes don't count toward
  // activeLen, so they are NOT eviction targets here; that guarantees every
  // iteration reduces activeLen and the cap actually holds.
  const activeLen = () => notes.filter((n) => n && !n.superseded_by).reduce((s, n) => s + (n.text || '').length, 0);
  let guard = 0;
  while (activeLen() > NOTES_TOTAL_CAP && guard++ < 500) {
    const victim = notes.find((n) => n && !n.superseded_by && !newAddIds.includes(n.id));
    if (!victim) break;  // only just-added active notes left — a single huge op may exceed the cap by design
    notes = notes.filter((n) => n !== victim);
  }
  // (e) bound total array growth — drop the oldest SUPERSEDED note first (the
  // audit tail) once the row gets large, so superseded notes can't accumulate
  // unbounded on a long-lived deal.
  const MAX_TOTAL_NOTES = 200;
  guard = 0;
  while (notes.length > MAX_TOTAL_NOTES && guard++ < 500) {
    const victim = notes.find((n) => n && n.superseded_by) || notes.find((n) => n && !newAddIds.includes(n.id));
    if (!victim) break;
    notes = notes.filter((n) => n !== victim);
  }

  await dbClient.query('UPDATE deal_memory SET notes = $1::jsonb, updated_at = NOW() WHERE lineage_root = $2',
    [JSON.stringify(notes), root]);
  return {
    entity_type: 'deal_memory', entity_id: root, op: 'notes',
    notes_added: added.length, notes_superseded: supersedeIds.size,
    summary: `Deal memory ${root}: +${added.length} note(s)` + (supersedeIds.size ? `, superseded ${supersedeIds.size}` : ''),
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
  calendar_event: dispatchCalendarEvent,
  task: dispatchTask,
  todo: dispatchTodo,
  reminder: dispatchReminder,
  assembly: dispatchAssembly,
  deal_memory: dispatchDealMemory,
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
    // Exported for test/retired-job-ops.test.js — the retired-op guard must
    // be provable to fire BEFORE any SQL runs, which needs the raw handler.
    dispatchJob,
    RETIRED_JOB_OPS,
    // Exported for test/agent-write-org-scope.test.js — the job-id probe and
    // the field_tools arms both have to be provable against a runner rather
    // than by reading the source for a substring.
    resolveJobTarget,
    dispatchSystem,
    dispatchTask,
    dispatchTodo,
    dispatchReminder,
    dispatchCalendarEvent,
    resolveRef,
    isRef,
    resolveRefsInOps,
    // Section placement — pure array surgery over data.lines, no DB.
    applyLineAdds,
    applyLineEdits,
    ensureSectionHeader,
    insertIntoSection,
    // Scope (alternate) ops — pure blob surgery, no DB.
    applyEstimateGroups,
    applyEstimateScopeText,
    migrateLegacyEstimateScope,
    resolveAlternateTarget,
    buildApplySummary,
    CLIENT_EDITABLE_FIELDS,
    ESTIMATE_FIELD_KEYS,
    ESTIMATE_BLOCKED_FIELDS,
    TASK_FIELDS,
    TODO_FIELDS,
    REMINDER_FIELDS,
  },
};
