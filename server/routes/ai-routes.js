// AI estimating assistant — read-only chat panel attached to each estimate.
//
// Phase 1 (this file): the assistant can READ the estimate's full context
// (lines, scope, client, photos) and answer questions / draft scopes /
// flag missing items. It cannot modify the estimate. Phase 2 will add
// tool-use so Claude can propose changes the user approves.
//
// Per-user history: rows in ai_messages are partitioned by user_id so PMs
// each see their own conversation per estimate (two PMs working the same
// estimate don't see each other's prompts).
//
// Streaming uses Server-Sent Events. The frontend reads via fetch + a body
// reader since EventSource doesn't support POST.

const express = require('express');
const fs = require('fs');
const path = require('path');
const Anthropic = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability } = require('../auth');
const { storage } = require('../storage');

const router = express.Router();

// Lazy SDK init — reads ANTHROPIC_API_KEY on first request rather than at
// module-load time. This is more robust against Railway's deploy timing:
// if the env var was set after the build started, a module-level capture
// would miss it and we'd serve "not configured" forever until restart.
// Lazy lookup re-checks on every request, so a fix-and-redeploy works.
let _anthropicClient = null;
let _anthropicKey = null;
function getAnthropic() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const key = raw.trim();
  if (!key) return null;
  // Recreate the client if the key changed (rare, but possible on rotation)
  if (!_anthropicClient || _anthropicKey !== key) {
    _anthropicClient = new Anthropic({ apiKey: key });
    _anthropicKey = key;
  }
  return _anthropicClient;
}

// Startup diagnostic — prints to Railway logs whether the env was visible to
// the Node process at boot. The fingerprint (first 7 / last 4 chars) lets us
// spot accidental whitespace or wrong-key issues without leaking the secret.
(function() {
  const raw = process.env.ANTHROPIC_API_KEY || '';
  const trimmed = raw.trim();
  if (!trimmed) {
    console.log('[ai-routes] ANTHROPIC_API_KEY: MISSING at startup');
  } else {
    const fp = trimmed.length > 12
      ? trimmed.slice(0, 7) + '…' + trimmed.slice(-4)
      : '<short>';
    const wsNote = (raw.length !== trimmed.length) ? ' (had whitespace, trimmed)' : '';
    console.log('[ai-routes] ANTHROPIC_API_KEY: present, fingerprint ' + fp + ', length ' + trimmed.length + wsNote);
  }
})();

// Sonnet 4.6 = the right cost/capability tier for an estimating assistant.
// Override via env if we want to A/B against Opus 4.7 (the right
// flip when the eval harness shows quality is the bottleneck, not
// cost): set AI_MODEL=claude-opus-4-7 on Railway.
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';

// Optional thinking-effort knob. Opus 4.7 supports "low" | "medium" |
// "high" | "xhigh" | "max". xhigh is the recommended default for most
// agentic / coding-style work on 4.7. Sonnet 4.6 supports the same
// scale up to "high". Sonnet 4.5 / Haiku 4.5 do NOT support effort —
// passing it there would 400, so we only attach the param when the
// model is in the supported set.
const EFFORT = (process.env.AI_EFFORT || '').trim().toLowerCase();
const EFFORT_SUPPORTED_MODELS = new Set([
  'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6'
]);
function effortClause() {
  if (!EFFORT) return null;
  if (!EFFORT_SUPPORTED_MODELS.has(MODEL)) return null;
  return { effort: EFFORT };
}

// Bumped from 2000 → 8000 because multi-section audit/summary
// responses (e.g. "Top 5 Actions" tables with rationale per row)
// were hitting the 2000 cap and truncating mid-cell. Sonnet 4.6
// can do up to 64K output; 8000 is enough headroom for detailed
// answers without unbounded cost. Standalone calls that have a
// known-short shape (e.g. lead extraction → JSON) keep their own
// tighter caps.
const MAX_TOKENS = 8000;

// Cap chat history fed back to the API so a long conversation doesn't
// balloon the per-call cost. Keep the most recent N round-trips
// (= 2N messages). System prompt rebuilds estimate context fresh each call,
// so dropped early messages don't lose factual context.
const MAX_HISTORY_PAIRS = 12;

// ──────────────────────────────────────────────────────────────────
// Server-hosted web tools. Anthropic runs these — we just declare them
// and the model decides when to invoke. `web_search` is GA (no beta
// header needed). max_uses caps per-turn calls so a runaway loop can't
// rack up search spend (~$10 / 1k searches as of writing). All three
// agents (estimate, job, client) get the same allowance — researching
// material specs, supplier sites, parent-company background, etc. is
// useful in every role.
//
// `web_fetch` is intentionally not included yet — it's still beta and
// requires a beta header (`web-fetch-2025-09-10`) plumbed through the
// stream call. Add it as a follow-up once we decide we want URL fetch.
// ──────────────────────────────────────────────────────────────────
const WEB_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 5 }
];

// ──────────────────────────────────────────────────────────────────
// Tools — write controls. Claude can propose edits via these; the UI
// shows each proposal as an Approve/Reject card. Nothing lands in the
// estimate until the user approves. The "propose_" prefix in every tool
// name reinforces to the model (and to anyone reading the docs) that
// the action is a request, not a fait accompli.
// ──────────────────────────────────────────────────────────────────
const ESTIMATE_TOOLS = [
  {
    name: 'propose_add_line_item',
    description: 'Propose adding a single cost-side line item to the active group. The user will see your proposal as a card with Approve / Reject buttons before anything lands in the estimate. Use multiple parallel calls to propose several lines at once. ALWAYS supply section_name pointing at one of the four standard subgroups — never let a line fall to the bottom uncategorized.',
    input_schema: {
      type: 'object',
      properties: {
        description: { type: 'string', description: 'What the line item is — short, specific, trade-style ("8d common nails, 5lb box" not "fasteners").' },
        qty: { type: 'number', description: 'Quantity. Must be a positive number.' },
        unit: { type: 'string', description: 'Unit of measure (ea, sf, lf, hr, cy, ton, lot, etc.).' },
        unit_cost: { type: 'number', description: 'AGX cost per unit, NOT client price. Markup is applied separately.' },
        markup_pct: { type: 'number', description: 'Optional per-line markup % override. Omit to inherit the subgroup header\'s markup (the standard case).' },
        section_name: { type: 'string', description: 'REQUIRED in practice — the subgroup to slot the line under. Use a case-insensitive substring of one of the four standard subgroup names: "Materials & Supplies Costs" (any physical material, hardware, finish, fastener, paint, lumber, fixture, supply), "Direct Labor" (AGX crew hours — anything our own crew physically does), "General Conditions" (mobilization, dump fees, permits, supervision, equipment rental, signage, port-a-john), "Subcontractors Costs" (any scope handed off to another company — paint sub, roof sub, tile sub, etc.). If a custom subgroup exists from a previous user request, you can match it by substring instead. NEVER omit this — uncategorized lines confuse the BT export.' },
        rationale: { type: 'string', description: 'One short sentence explaining why this item is needed. Shown on the approval card.' }
      },
      required: ['description', 'qty', 'unit', 'unit_cost', 'section_name', 'rationale']
    }
  },
  {
    name: 'propose_update_scope',
    description: "Propose setting or appending the active alternate's Scope of Work text. Use this when the user asks you to draft or extend the scope.",
    input_schema: {
      type: 'object',
      properties: {
        scope_text: { type: 'string', description: 'The full scope text to apply. Use bullet points (lines starting with "- " or "• ") for typical scopes.' },
        mode: { type: 'string', enum: ['replace', 'append'], description: 'replace = overwrite the current scope; append = add to the end with a blank line separator. Default replace if omitted.' },
        rationale: { type: 'string', description: 'One short sentence explaining the proposed change.' }
      },
      required: ['scope_text', 'rationale']
    }
  },
  {
    name: 'propose_add_section',
    description: 'Propose adding a NEW custom subgroup header to the active group. ⚠ Use this ONLY when the user explicitly asks for a custom subgroup ("add a Stair Tread Repairs section under Materials" — no, slot lines into the existing Materials subgroup; "add a separate subgroup for change-order work" — yes, that\'s a real custom subgroup). 99% of the time you should be slotting line items into the FOUR EXISTING standard subgroups (Materials / Labor / GC / Subs) via propose_add_line_item with section_name set. New subgroups also need a markup_pct (Materials ~20%, Labor ~35%, Subs ~10%, GC by case).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Section name (e.g., "Stair Tread Replacement").' },
        bt_category: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Optional BT cost category mapping. Omit if the section is not one of the four standard cost buckets.' },
        markup_pct: { type: 'number', description: 'Section markup %. Lines under this header inherit it. Typical AGX rates: Materials 20, Labor 35, Subs 10. Omit if you want the user to set it manually.' },
        rationale: { type: 'string', description: 'One short sentence explaining why this section is needed.' }
      },
      required: ['name', 'rationale']
    }
  },
  {
    name: 'propose_delete_line_item',
    description: 'Propose deleting a single cost-side line item by its id. Use when a line is a duplicate, doesn\'t belong, or is being replaced by a different proposal.',
    input_schema: {
      type: 'object',
      properties: {
        line_id: { type: 'string', description: 'The id of the line to delete (visible to you in the line listing).' },
        rationale: { type: 'string', description: 'One short sentence explaining why this line should go.' }
      },
      required: ['line_id', 'rationale']
    }
  },
  {
    name: 'propose_update_line_item',
    description: 'Propose changing one or more fields on an existing line. Only include the fields you actually want to change — others stay as-is. Useful for fixing typos, adjusting qty/cost, moving a line under a different section, or setting a per-line markup override.',
    input_schema: {
      type: 'object',
      properties: {
        line_id: { type: 'string' },
        description: { type: 'string', description: 'New description, or omit to keep current.' },
        qty: { type: 'number', description: 'New quantity, or omit.' },
        unit: { type: 'string', description: 'New unit of measure, or omit.' },
        unit_cost: { type: 'number', description: 'New AGX unit cost, or omit.' },
        markup_pct: { type: 'number', description: 'Per-line markup override. Pass null or omit to clear the override and inherit from the section. Pass a number to set.' },
        section_name: { type: 'string', description: 'Move this line under the section whose name matches (case-insensitive substring). Omit to leave the line where it is.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card.' }
      },
      required: ['line_id', 'rationale']
    }
  },
  {
    name: 'propose_delete_section',
    description: 'Propose deleting a section header. By default the lines that were under it move up under the previous section (or become unsectioned if it was the first). Use carefully — deleting a populated section is rare; usually rename instead.',
    input_schema: {
      type: 'object',
      properties: {
        section_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['section_id', 'rationale']
    }
  },
  {
    name: 'propose_update_section',
    description: 'Propose changing a section header — rename, change BT category, or change the section markup % that lines under it inherit. Only include fields you want to change.',
    input_schema: {
      type: 'object',
      properties: {
        section_id: { type: 'string' },
        name: { type: 'string', description: 'New section name, or omit.' },
        bt_category: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'New BT category mapping, or omit.' },
        markup_pct: { type: 'number', description: 'New section markup %, or omit. Pass null to clear (lines fall back to the legacy estimate-wide default if any).' },
        rationale: { type: 'string' }
      },
      required: ['section_id', 'rationale']
    }
  },
  {
    name: 'propose_add_client_note',
    description: 'Propose appending a durable, agent-readable note to the linked client. Notes auto-inject into AG and HR system prompts on every future turn touching this client, so they compound knowledge across sessions. Only call when you\'ve learned something the user told you that should outlive this conversation — pricing preferences, billing quirks, gate codes, scope rules, contact preferences. NEVER call for facts already in the client record (name, address, salesperson) or for ephemeral state (current weather, today\'s schedule). Only available when the estimate is linked to a client (see context above); skipped otherwise.',
    input_schema: {
      type: 'object',
      properties: {
        body: { type: 'string', description: 'The note itself, ≤ 2000 chars. Should read as a standalone instruction or fact — full sentence, ends with a period. Examples: "PAC always wants 15% materials markup, not 20%.", "Wimbledon Greens proposals must include the gate code on the cover page."' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this note is worth keeping.' }
      },
      required: ['body', 'rationale']
    }
  }
];

// ──────────────────────────────────────────────────────────────────
// Job-side tools — write capabilities for Elle (WIP analyst).
// All proposals route through the same approval-card flow as the
// estimate side: assistant emits a tool_use block, client renders
// a card, user approves, client applies the change locally and
// signals approval back via /chat/continue.
//
// Phase 3 ships the foundation tool. Subsequent commits add
// wire_nodes, assign_qb_line, set_phase_field, create_node, etc.
// ──────────────────────────────────────────────────────────────────
const JOB_TOOLS = [
  {
    name: 'set_phase_pct_complete',
    description:
      'Update a phase\'s % complete. Use when the user verbally confirms a number ' +
      '("phase 1 is at 50%") or when audit findings show a phase has cost data but pctComplete=0. ' +
      'phase_id accepts EITHER a phase record id from the # Structure block (e.g. "ph_...") OR ' +
      'a t2 / t1 graph node id from the # Node graph block (e.g. "n2"). The applier resolves both — ' +
      'pick whichever is more clearly identifiable in the user\'s context. ' +
      'Always include rationale (1 short sentence) explaining why this number.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase_id: { type: 'string', description: 'A phase id from # Structure ("ph_...") or a t2/t1 node id from # Node graph ("n2").' },
        pct_complete: { type: 'number', minimum: 0, maximum: 100, description: 'New % complete value (0–100).' },
        rationale: { type: 'string', description: 'One short sentence — why this number, not the old one.' }
      },
      required: ['phase_id', 'pct_complete', 'rationale']
    }
  },
  {
    name: 'set_phase_field',
    description:
      'Update a single numeric cost field on a phase: materials, labor, sub, or equipment. ' +
      'Use when the user gives a specific dollar figure ("phase 1 had $3,500 in materials this week") ' +
      'or when reconciling against QB lines that map to one specific phase. Only one field per call — ' +
      'chain calls if multiple fields need updates so each one shows as a separate approval card.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase_id: { type: 'string' },
        field: { type: 'string', enum: ['materials', 'labor', 'sub', 'equipment'] },
        amount: { type: 'number', minimum: 0 },
        rationale: { type: 'string' }
      },
      required: ['phase_id', 'field', 'amount', 'rationale']
    }
  },
  {
    name: 'create_node',
    description:
      'Create a new node on the cost-flow graph. Use when the user asks to build out structure ' +
      '("add 8 T1 buildings", "create a Materials node for the porch") or when an audit finding ' +
      'requires a node that doesn\'t exist yet. The engine automatically creates the matching ' +
      'data record for structural types (t1=building, t2=phase, co=change order, po=purchase ' +
      'order, inv=invoice) — you don\'t need to supply ids. ' +
      'Multi-node restructures: fire create_node multiple times in a single turn — each card ' +
      'auto-applies if the user has trusted "Create node", otherwise they\'ll bulk-approve. ' +
      'For multi-node restructures, follow up with wire_nodes calls to connect them.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      // node_type (not "type") — JSON Schema reserves `type` as a
      // meta-keyword and some tool-use validators silently drop a
      // property literally named `type`, leaving the field empty
      // when the apply path runs.
      properties: {
        node_type: {
          type: 'string',
          enum: ['t1', 't2', 'labor', 'mat', 'gc', 'other', 'burden', 'sub', 'po', 'inv', 'co', 'watch', 'note'],
          description:
            't1=building, t2=phase, labor/mat/gc/other/burden=cost buckets, sub=subcontractor, ' +
            'po=purchase order, inv=invoice, co=change order, watch=output watcher, note=sticky note.'
        },
        label: { type: 'string', description: 'Node label / title shown on the card.' },
        value: {
          type: 'number',
          description: 'Initial value for cost-bucket nodes (labor/mat/gc/other/burden/sub) — the QB Total fallback. Optional.'
        },
        budget: {
          type: 'number',
          description: 'Initial budget for t1/t2 nodes. Optional. Drives the "Budget: $X" display.'
        },
        pct_complete: {
          type: 'number', minimum: 0, maximum: 100,
          description: 'Initial % complete for t1/t2 nodes. Defaults to 0.'
        },
        attach_to_node_id: {
          type: 'string',
          description: 'Optional: id of an existing node to wire FROM the new node to (the new node becomes an input to attach_to_node_id). Useful for "create a Materials node and wire it into Phase 5" in one step.'
        },
        rationale: { type: 'string', description: 'One short sentence — what this node represents and why it\'s being created.' }
      },
      required: ['node_type', 'label', 'rationale']
    }
  },
  {
    name: 'delete_node',
    description:
      'Remove a node from the cost-flow graph. The node and all its incoming + outgoing wires ' +
      'are removed in one shot. ' +
      'IMPORTANT: This DOES NOT delete the underlying data record — the building / phase / ' +
      'change order / PO / invoice / sub data stays in appData. Use when the user wants to ' +
      'remove a node from the graph without losing the corresponding job-tab data (a graph ' +
      'cleanup, not a data deletion). For "delete the data too" the user clicks "Delete from ' +
      'Job" in the node\'s right-click menu instead. ' +
      'Multi-node restructures: fire delete_node multiple times in a single turn — each card ' +
      'auto-applies if the user has trusted "Delete graph node", otherwise they\'ll bulk-approve.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node_id: { type: 'string', description: 'The graph node id (e.g. "n38") or exact label.' },
        rationale: { type: 'string', description: 'One short sentence — why this node is being removed.' }
      },
      required: ['node_id', 'rationale']
    }
  },
  {
    name: 'wire_nodes',
    description:
      'Connect two nodes in the cost-flow graph (from output port of source → input port of target). ' +
      'Use when audit findings list a disconnected node and the right parent is obvious from context ' +
      '(e.g., a sub node that should flow into a phase node). Both ids MUST exist in the # Node graph block. ' +
      'Default ports are 0 unless the user specified another port.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_node_id: { type: 'string' },
        to_node_id: { type: 'string' },
        from_port: { type: 'integer', minimum: 0, default: 0 },
        to_port: { type: 'integer', minimum: 0, default: 0 },
        rationale: { type: 'string' }
      },
      required: ['from_node_id', 'to_node_id', 'rationale']
    }
  },
  {
    name: 'set_node_value',
    description:
      'Set the QuickBooks Total / value field on a cost-bucket node in the graph (labor / mat / gc / other / sub / burden). ' +
      'Use this when the user wants a QB account total (e.g. "Materials & Supplies - COGS = $43,078" or "Direct Burden = $1,883") loaded into a specific cost node so it flows up through the graph. ' +
      'node_id MUST be a node id from the # Node graph block (e.g. "n38"), NOT a phase id from # Structure. ' +
      'For phase-level fields (materials/labor/sub/equipment on a phase record) use set_phase_field instead. ' +
      'Only valid on labor / mat / gc / other / sub / burden node types — will error on t1, t2, wip, watch, note, co, po, inv. ' +
      'Note: "burden" (Direct Burden) is the payroll-burden bucket — taxes/insurance/benefits layered on labor — and rolls into the labor cost total at building/phase/job levels.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        node_id: { type: 'string', description: 'The graph node id (e.g. "n38") or exact label.' },
        amount: { type: 'number', minimum: 0, description: 'Dollar amount to set as the node\'s value / QB Total.' },
        rationale: { type: 'string', description: 'One short sentence — what QB account/category this is and why it goes on this node.' }
      },
      required: ['node_id', 'amount', 'rationale']
    }
  },
  {
    name: 'assign_qb_line',
    description:
      'Link a QuickBooks cost line to a node in the graph (sets linked_node_id on the qb_cost_lines row). ' +
      'Use when the audit lists unlinked QB lines and the right node is identifiable from the line\'s vendor / account / memo. ' +
      'line_id is the qb_cost_lines.id; node_id is the graph node it should reconcile against.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line_id: { type: 'string' },
        node_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['line_id', 'node_id', 'rationale']
    }
  },
  {
    name: 'read_workspace_sheet_full',
    description:
      'Read the entire contents of a workspace sheet. Read-only — no approval card; auto-applies and the full sheet text returns as the tool_result so you can analyze it. ' +
      'Use this when the # Workspace sheets preview shows "preview truncated" or the user asks for data that\'s past row 100 / column Z. ' +
      'sheet_name MUST exactly match one of the names listed in the # Workspace sheets headings. ' +
      'DO NOT call on "QB Costs YYYY-MM-DD" sheets or the "Detailed Costs" tab — use read_qb_cost_lines for QuickBooks data instead.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sheet_name: { type: 'string', description: 'The exact sheet name (case-sensitive).' }
      },
      required: ['sheet_name']
    }
  },
  {
    name: 'read_qb_cost_lines',
    description:
      'Read QuickBooks cost lines for the current job from the canonical Detailed Costs view (server-persisted qb_cost_lines table). ' +
      'Read-only — auto-applies, full result returned as tool_result. ' +
      'Use this whenever the user asks about specific QB transactions, vendor totals, account roll-ups, or unlinked lines that aren\'t in the # QuickBooks cost data summary block. ' +
      'Optional filters narrow the result — supply none to get every line. ' +
      'This is the ONLY way to get individual QB lines; never try to read "QB Costs YYYY-MM-DD" sheets one at a time.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        account: { type: 'string', description: 'Distribution account name to filter by (case-insensitive partial match). Example: "Subcontractors", "Materials".' },
        vendor: { type: 'string', description: 'Vendor name to filter by (case-insensitive partial match). Example: "Home Depot", "INVO PEO".' },
        status: { type: 'string', enum: ['linked', 'unlinked', 'all'], description: 'Linked-to-graph-node filter. Default "all".' },
        search: { type: 'string', description: 'Free-text search across vendor / memo / account / class.' },
        limit: { type: 'integer', minimum: 1, maximum: 1000, description: 'Cap rows returned. Default 200, max 1000.' }
      },
      required: []
    }
  }
];

// ──────────────────────────────────────────────────────────────────
// Context builder — pulls everything Claude needs to know about the
// estimate and formats it as a system-prompt prefix. Photos are returned
// separately so the chat handler can attach them as image blocks.
// ──────────────────────────────────────────────────────────────────

async function buildEstimateContext(estimateId, includePhotos) {
  // Estimate row carries the JSONB blob with all the editor fields plus
  // alternates and lines (the bulk-save routes serialize them this way).
  const estRes = await pool.query(
    'SELECT id, owner_id, data FROM estimates WHERE id = $1',
    [estimateId]
  );
  if (!estRes.rows.length) throw new Error('Estimate not found');
  const blob = estRes.rows[0].data || {};

  // Active alternate carries the per-alt scope + lines that the editor uses
  const alternates = Array.isArray(blob.alternates) ? blob.alternates : [];
  const activeAlt = alternates.find(a => a.id === blob.activeAlternateId) || alternates[0] || null;
  const allLines = Array.isArray(blob.lines) ? blob.lines : [];
  const activeLines = activeAlt
    ? allLines.filter(l => l.alternateId === activeAlt.id)
    : allLines;

  // Linked client surfaces the salutation + community + addresses if set
  let clientRow = null;
  if (blob.client_id) {
    const cRes = await pool.query('SELECT * FROM clients WHERE id = $1', [blob.client_id]);
    clientRow = cRes.rows[0] || null;
  }

  // Linked lead — when an estimate was created from a lead, the lead's
  // notes typically carry the SOW summary, POC, and key constraints from
  // BT. Surface them so the assistant can spot missing line items.
  let leadRow = null;
  if (blob.lead_id) {
    const lRes = await pool.query(
      `SELECT l.*, u.name AS salesperson_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.salesperson_id
       WHERE l.id = $1`,
      [blob.lead_id]
    );
    leadRow = lRes.rows[0] || null;
  }

  // Pull every attachment (photos + docs) for both the estimate and the
  // linked lead in one go. Photos go to the vision pipeline (cap 12 per
  // Anthropic's per-request limit); docs are listed as structured text so
  // the assistant knows what RFP / spec / drawing references exist even
  // though it can't read PDF/Excel content yet.
  let photoBlocks = [];
  let docManifest = []; // { source, filename, mime, size }
  const allAttachments = [];

  const estAtts = await pool.query(
    `SELECT * FROM attachments WHERE entity_type='estimate' AND entity_id=$1
     ORDER BY position, uploaded_at`,
    [estimateId]
  );
  allAttachments.push(...estAtts.rows.map(r => ({ ...r, source: 'estimate' })));
  if (blob.lead_id) {
    const leadAtts = await pool.query(
      `SELECT * FROM attachments WHERE entity_type='lead' AND entity_id=$1
       ORDER BY position, uploaded_at`,
      [blob.lead_id]
    );
    allAttachments.push(...leadAtts.rows.map(r => ({ ...r, source: 'lead' })));
  }

  // Partition by mime type. Anything starting with image/ AND with a
  // thumb_key is a server-side resized photo; everything else is a doc.
  const photoRows = allAttachments.filter(a => a.mime_type && a.mime_type.startsWith('image/') && a.thumb_key);
  const docRows = allAttachments.filter(a => !(a.mime_type && a.mime_type.startsWith('image/') && a.thumb_key));

  if (includePhotos) {
    const cappedPhotos = photoRows.slice(0, 12);
    for (const p of cappedPhotos) {
      const block = await loadPhotoAsBlock(p);
      if (block) photoBlocks.push(block);
    }
  }

  docManifest = docRows.map(d => ({
    source: d.source,
    filename: d.filename,
    mime: d.mime_type,
    size: d.size_bytes,
    extracted_text: d.extracted_text || null  // PDF body text when available
  }));

  // ────────────────────────────────────────────────────────────────
  // Build the system prompt as TWO blocks so we can cache the stable
  // prefix (identity, role, tools, slotting, skill packs, tone) and
  // only re-send the volatile estimate context each turn. Anthropic's
  // ephemeral cache is 5 min; AG sessions usually fit inside that, so
  // most turns hit the cache and pay ~10% input-token cost.
  //
  //   stableLines  → playbook (cached)
  //   lines        → current estimate state (refreshed each turn)
  //
  // Order in the final prompt: stable first, then dynamic. The cache
  // breakpoint goes on the stable block.
  // ────────────────────────────────────────────────────────────────
  const stableLines = [];
  const lines = [];
  lines.push('You are an estimating assistant for AG Exteriors, a Central Florida construction services company specializing in painting, deck repairs, roofing, and exterior services for HOAs and apartment communities.');
  lines.push('');
  lines.push('Here is the current estimate the user is working on:');
  lines.push('');
  lines.push('# Estimate');
  lines.push('- Title: ' + (blob.title || '(untitled)'));
  if (blob.issue) lines.push('- Issue / repair: ' + blob.issue);
  if (blob.jobType) lines.push('- Project type: ' + blob.jobType);
  if (clientRow) {
    lines.push('- Client: ' + (clientRow.name || ''));
    if (clientRow.community_name && clientRow.community_name !== clientRow.name) lines.push('  Community: ' + clientRow.community_name);
    if (clientRow.community_manager) lines.push('  CAM / contact: ' + clientRow.community_manager);
  } else if (blob.client) {
    lines.push('- Client: ' + blob.client);
  }
  if (blob.community && (!clientRow || clientRow.community_name !== blob.community)) lines.push('- Community / property: ' + blob.community);
  if (blob.propertyAddr) lines.push('- Job address: ' + blob.propertyAddr);
  lines.push('');

  // Client agent notes — durable, hand-curated facts about how to handle
  // this client. Auto-injected on every turn so they compound across
  // sessions. Surfaced before the line items / scope so the model sees
  // them while reading the rest of the context.
  if (clientRow && Array.isArray(clientRow.agent_notes) && clientRow.agent_notes.length) {
    lines.push('# Client notes (' + clientRow.agent_notes.length + ' — ' + (clientRow.name || 'this client') + ')');
    lines.push('Durable instructions about how to handle this client. Treat as binding additional guidance — they were written by the user or proposed by an agent and approved by the user.');
    clientRow.agent_notes.forEach(function(n, i) {
      var src = n.source_agent ? ' [' + n.source_agent + ']' : '';
      lines.push((i + 1) + '. ' + (n.body || '') + src);
    });
    lines.push('');
  }

  // Linked lead context. The lead's notes often carry the original
  // BT-imported SOW summary, POC contact, gate codes, and special
  // instructions — read these when answering scope / completeness
  // questions. Photos from the lead are already attached as image blocks.
  if (leadRow) {
    lines.push('# Linked lead');
    if (leadRow.title && leadRow.title !== blob.title) lines.push('- Lead title: ' + leadRow.title);
    if (leadRow.status) lines.push('- Status: ' + leadRow.status);
    if (leadRow.salesperson_name) lines.push('- Salesperson: ' + leadRow.salesperson_name);
    if (leadRow.source) lines.push('- Source: ' + leadRow.source);
    if (leadRow.confidence != null && leadRow.confidence > 0) lines.push('- Confidence: ' + leadRow.confidence + '%');
    if (leadRow.estimated_revenue_low || leadRow.estimated_revenue_high) {
      const lo = leadRow.estimated_revenue_low || leadRow.estimated_revenue_high;
      const hi = leadRow.estimated_revenue_high || leadRow.estimated_revenue_low;
      lines.push('- Estimated revenue (from BT): $' + Number(lo).toLocaleString() + (lo !== hi ? ' – $' + Number(hi).toLocaleString() : ''));
    }
    if (leadRow.market) lines.push('- Market: ' + leadRow.market);
    if (leadRow.gate_code) lines.push('- Gate code: ' + leadRow.gate_code);
    if (leadRow.notes && leadRow.notes.trim()) {
      lines.push('## Lead notes (from BT — typically SOW summary + POC)');
      lines.push(leadRow.notes.trim());
    }
    lines.push('');
  }

  if (alternates.length > 1) {
    lines.push('# Groups on this estimate');
    lines.push('AGX organizes a multi-scope estimate into Groups (e.g., Deck 1, Deck 2, Roof, Optional Adds). Each group carries its own scope and its own line items. The proposal total = sum of every INCLUDED group; groups marked `excluded` are not priced or shown to the client.');
    alternates.forEach(a => {
      const isActive = a.id === blob.activeAlternateId;
      const isExcluded = !!a.excludeFromTotal;
      lines.push('- ' + a.name +
        (isActive ? ' (active in editor)' : '') +
        (isExcluded ? ' [EXCLUDED from proposal]' : ''));
    });
    lines.push('');
  }

  if (activeAlt) {
    lines.push('# Active group: ' + activeAlt.name + (activeAlt.excludeFromTotal ? ' [EXCLUDED]' : ''));
    if (activeAlt.scope) {
      lines.push('## Scope of work for this group');
      lines.push(activeAlt.scope);
      lines.push('');
    }
  } else if (blob.scopeOfWork) {
    // legacy estimates that haven't been opened post-migration
    lines.push('# Scope of work');
    lines.push(blob.scopeOfWork);
    lines.push('');
  }

  // Group lines by subgroup header for readable rendering. Subgroup header
  // lines carry the markup % that the cost-side lines under them inherit;
  // individual lines can override. Subgroups are the four cost categories
  // (Materials / Labor / GC / Subs); the active group is the active
  // alternate (e.g., "Deck 1" or "Roof").
  if (activeLines.length) {
    lines.push('## Line items in active group (cost-side)');
    let currentSubgroup = '(uncategorized)';
    let currentSubgroupMarkup = (blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0;
    let lineNumInSubgroup = 0;
    activeLines.forEach(l => {
      if (l.section === '__section_header__') {
        currentSubgroup = l.description || 'subgroup';
        currentSubgroupMarkup = (l.markup === '' || l.markup == null)
          ? ((blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0)
          : parseFloat(l.markup);
        lineNumInSubgroup = 0;
        lines.push(`### ${currentSubgroup} (subgroup markup ${currentSubgroupMarkup}%, subgroup_id=${l.id})`);
      } else {
        lineNumInSubgroup++;
        const qty = parseFloat(l.qty) || 0;
        const unit = l.unit || 'ea';
        const cost = parseFloat(l.unitCost) || 0;
        const ext = qty * cost;
        const markup = (l.markup === '' || l.markup == null) ? currentSubgroupMarkup : parseFloat(l.markup);
        const markupNote = (l.markup === '' || l.markup == null) ? '' : ' [overrides subgroup]';
        lines.push(`${lineNumInSubgroup}. ${l.description || '(no description)'} — qty ${qty} ${unit} @ $${cost.toFixed(2)} = $${ext.toFixed(2)}; markup ${markup}%${markupNote} [line_id=${l.id}]`);
      }
    });
    lines.push('');
  } else {
    lines.push('## Line items');
    lines.push('(none yet)');
    lines.push('');
  }

  // Pricing posture
  const pricingBits = [];
  // Markup is per-section now — see line-item section headers above. The
  // legacy estimate-wide defaultMarkup is retained only as a fall-back for
  // sections that haven't been assigned their own markup yet.
  if (blob.taxPct) pricingBits.push(`tax ${blob.taxPct}%`);
  if (blob.feeFlat) pricingBits.push(`flat fee $${blob.feeFlat}`);
  if (blob.feePct) pricingBits.push(`fee ${blob.feePct}%`);
  if (blob.roundTo) pricingBits.push(`round-up to nearest $${blob.roundTo}`);
  if (pricingBits.length) {
    lines.push('# Pricing settings');
    lines.push(pricingBits.join(', '));
    lines.push('');
  }

  if (photoBlocks.length) {
    lines.push('# Photos');
    lines.push(`${photoBlocks.length} photo(s) attached below — analyze them when relevant to the user's question.`);
    lines.push('');
  }

  // Document manifest. PDF, Excel, Word, CSV, and plain-text contents are
  // extracted at upload time and inlined below in fenced blocks — read them
  // as authoritative content (RFPs, scopes, takeoffs, lead reports). For
  // formats without an extractor or for scanned PDFs that have no text
  // layer, the user can click "Ask AI" from the PDF viewer to attach
  // rendered page images this turn — treat those images as the doc.
  if (docManifest.length) {
    lines.push('# Attached documents (' + docManifest.length + ')');
    var anyWithText = docManifest.some(function(d) { return d.extracted_text; });
    var headerLine = anyWithText
      ? 'Extracted text below — quote / cite directly when relevant. Excel takeoffs render as tab-separated rows under `## Sheet:` headers; treat each sheet as a table.'
      : 'Filenames listed for reference.';
    headerLine += ' For docs WITHOUT extracted text (scanned PDFs, photo reports like CompanyCam, image-only formats):' +
      ' if the user has clicked "Ask AI" from the PDF viewer, the page renders are attached as images this turn — read them with vision and treat that as the document content.' +
      ' Only ask the user to paste excerpts if no images were attached.';
    lines.push(headerLine);
    lines.push('');
    docManifest.forEach(function(d) {
      var sizeStr = d.size != null ? ' (' + (d.size > 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.round(d.size / 1024) + ' KB') + ')' : '';
      var mimeBit = d.mime ? ' · ' + d.mime : '';
      lines.push('## [' + d.source + '] ' + d.filename + sizeStr + mimeBit);
      if (d.extracted_text) {
        lines.push('```');
        lines.push(d.extracted_text);
        lines.push('```');
      } else {
        lines.push('_(no extracted text — either an unsupported format or a scanned image. Read the rendered page images attached this turn, if any.)_');
      }
      lines.push('');
    });
  }

  // ─── STABLE PLAYBOOK (cached prefix) ───────────────────────────────
  stableLines.push('# Who you are');
  stableLines.push('You are AG — AGX\'s estimating teammate. AGX = AG Exteriors, a Central-Florida construction-services company (painting, deck repair, roofing, exterior services for HOAs and apartment communities). You estimate like a senior PM: specific, trade-fluent, opinionated about scope completeness, calibrated on Central-FL pricing.');
  stableLines.push('');
  stableLines.push('# Estimate structure');
  stableLines.push('Estimates are organized as Groups → Subgroups → Lines.');
  stableLines.push('  • Group (a.k.a. "alternate" in older code/UI): a named scope block on the estimate. Examples: "Deck 1", "Deck 2", "Roof", "Optional Adds". Each group has its own scope of work and its own line items. The proposal renders each INCLUDED group as its own block; excluded groups are dropped entirely from both the proposal and the total.');
  stableLines.push('  • Subgroup (a.k.a. "section header" in code): one of the four cost categories — Materials & Supplies, Direct Labor, General Conditions, Subcontractors — under each group. Subgroup markup % is the baseline that lines under it inherit.');
  stableLines.push('  • Line: a single cost-side row (description, qty, unit, unit cost, optional per-line markup override) inside a subgroup.');
  stableLines.push('When the user creates a new group, the four standard subgroups auto-seed with AGX-typical markups (Materials 20, Labor 35, GC 25, Subs 10).');
  stableLines.push('');
  stableLines.push('# Your role');
  stableLines.push('- Help the PM think through scope, materials, sequencing, and gotchas.');
  stableLines.push('- Spot missing line items, suggest items to add, flag risks (access, height, weather, code).');
  stableLines.push('- Cite cost-side prices. Markup is per-subgroup — each subgroup header carries its own markup % that lines under it inherit. The line listing in the estimate context below shows each subgroup\'s markup so you can see what the user has set.');
  stableLines.push('- Don\'t just add — also EDIT and DELETE. If you spot a duplicate, a line in the wrong subgroup, a typo, a stale qty/cost, or a subgroup that\'s been renamed elsewhere, propose the cleanup directly via the right tool below.');
  stableLines.push('');
  stableLines.push('# Your tools (every proposal is approval-required — user clicks Approve/Reject)');
  stableLines.push('All tool names still say "section" — that\'s the legacy code name for what the UI now calls "subgroup". They behave identically regardless of name.');
  stableLines.push('  • propose_add_line_item — add a single cost-side line under a named subgroup (use the subgroup\'s display name)');
  stableLines.push('  • propose_update_line_item — change description/qty/unit/cost/markup, or move a line to a different subgroup');
  stableLines.push('  • propose_delete_line_item — remove a line by line_id');
  stableLines.push('  • propose_add_section — add a new subgroup header (set markup_pct based on AGX typical: Materials 20, Labor 35, GC 25, Subs 10)');
  stableLines.push('  • propose_update_section — rename a subgroup, change BT category, change subgroup markup');
  stableLines.push('  • propose_delete_section — remove a subgroup header (lines under it stay; they fall under the previous subgroup)');
  stableLines.push('  • propose_update_scope — set or append the ACTIVE GROUP\'s scope of work (each group has its own scope)');
  stableLines.push('Every line and subgroup has an id shown in the estimate context below; use those exact ids when calling update/delete tools. Today you only edit the ACTIVE group — if the user wants you to work in a different group, ask them to switch first. Make multiple parallel proposals when batching — one approval card per call, with a bulk Approve-all.');
  stableLines.push('');
  stableLines.push('# Slotting rules — STRICT');
  stableLines.push('Every line item belongs in exactly one of the four standard subgroups. Choose by what the line IS, not who pays for it:');
  stableLines.push('  • Materials & Supplies Costs — any physical good AGX buys. Lumber, fasteners, paint, primer, caulk, sealant, hardware, fixtures, finishes, sundries, blades, abrasives, masking, drop cloths.');
  stableLines.push('  • Direct Labor — hours of AGX\'s own crew. Demo, prep, install, finish, cleanup. Per-trade unit-rate labor (e.g., "deck board install" labor) belongs here, not Subs.');
  stableLines.push('  • General Conditions — project overhead. Mobilization, demobilization, dump/disposal fees, permits + permit runner, supervision, project management, equipment rental (lifts, scaffolding, dumpsters), signage, port-a-john, fuel, daily site protection.');
  stableLines.push('  • Subcontractors Costs — scopes AGX hands off to another company under contract. A roof sub, paint sub, tile sub, electrical sub, etc. If AGX\'s own crew does the work, it\'s Direct Labor — not Subs.');
  stableLines.push('Always pass section_name on propose_add_line_item — it gates BT export categorization. Only call propose_add_section when the user explicitly asks for a CUSTOM subgroup outside these four (rare).');
  stableLines.push('');
  stableLines.push('# Pricing rules');
  stableLines.push('- AGX cost-side prices for Central-FL construction. Quantities should be specific (calculated from photos / scope when possible).');
  stableLines.push('- Subgroup markup typical: Materials 20%, Labor 35%, GC 25%, Subs 10%. Per-line markup overrides the subgroup only when there\'s a real reason (special-order item priced higher, or a loss-leader line).');
  stableLines.push('- Always include a rationale on each proposal — it\'s shown to the user on the approval card.');
  stableLines.push('');
  stableLines.push('# Web research (web_search tool)');
  stableLines.push('You have a web_search tool. Use it judiciously — it adds a few seconds and a small cost per call. Good reasons to search:');
  stableLines.push('  • Material specs / SKUs the user references (e.g., "Trex Transcend Spiced Rum" — confirm board dimensions, install method, current MSRP at Home Depot / Lowe\'s).');
  stableLines.push('  • Manufacturer install guides when scope hinges on a method detail (Hardie siding nailing schedule, GAF roofing underlayment requirements).');
  stableLines.push('  • Current Central-FL labor / material price benchmarks when the user asks for a quick gut-check on a number.');
  stableLines.push('  • Code or permit references (FBC chapter X requires Y) when the line item depends on it.');
  stableLines.push('Do NOT search for things already answered in the estimate context, the loaded skills, or your own trade knowledge. Cap usage at ~2 searches per turn unless the user explicitly asks for deeper research. Cite sources briefly when you use a search result to support a number or claim.');
  stableLines.push('');

  // Load admin-editable skill packs targeted at AG. Stable across the
  // 5-min cache window since admins rarely edit them mid-session.
  const skillBlocks = await loadActiveSkillsFor('ag');
  if (skillBlocks.length) {
    stableLines.push('# Loaded skills');
    stableLines.push('Skill packs your admin has assigned. Treat each as binding additional guidance on top of the baseline rules above.');
    stableLines.push('');
    skillBlocks.forEach(s => {
      stableLines.push('## ' + s.name);
      stableLines.push(s.body);
      stableLines.push('');
    });
  }

  stableLines.push('# Tone');
  stableLines.push('- Concise. Trade vocabulary welcome. Mix prose with proposals — short lead-in, the cards, a one-line wrap-up. Don\'t emit proposals without any explanation. If you need one piece of info to answer well, ask one targeted question first.');

  // ─── ASSEMBLE ──────────────────────────────────────────────────────
  // System param goes out as an array of two text blocks. The first is
  // the playbook (cached); the second is the dynamic estimate context
  // refreshed each turn. The cache_control marker on the stable block
  // tells Anthropic to cache everything from the start of the request
  // (including the tools array) up through that block.
  // AG phase — controls whether the model can propose line-item /
  // section edits this turn. Lives on the estimate JSONB blob; defaults
  // to 'build' when unset (back-compat with estimates created before
  // the toggle existed). Caller filters tools + injects mode block.
  const aiPhase = blob.aiPhase === 'plan' ? 'plan' : 'build';

  // Inject the active-mode block last in the dynamic context so the
  // model sees it just before reading the user message. Strong language
  // because the soft prompt rule pairs with hard tool-array filtering
  // server-side — both belt and suspenders.
  if (aiPhase === 'plan') {
    lines.push('');
    lines.push('# CURRENT MODE: PLAN');
    lines.push('The user has set this estimate to **Plan mode**. They are still thinking through scope, materials, sequencing — not ready for line-item proposals yet.');
    lines.push('In Plan mode you SHOULD:');
    lines.push('  - Discuss scope, ask clarifying questions, surface gotchas, suggest considerations.');
    lines.push('  - Use `propose_update_scope` to capture the scope of work as the conversation evolves — that\'s a planning activity, not an estimate edit.');
    lines.push('  - Use `propose_add_client_note` for durable facts the user shares.');
    lines.push('  - Use `web_search` for spec lookups, code references, supplier research.');
    lines.push('In Plan mode you MUST NOT propose line items, sections, or any other estimate edits — those tools have been removed from your tool list this turn so you literally cannot call them. Don\'t apologize, don\'t hint at line items, don\'t pre-format what you would have proposed; just keep planning. When the user is ready to build, they\'ll flip the mode switch.');
  } else {
    lines.push('');
    lines.push('# CURRENT MODE: BUILD');
    lines.push('The user is in Build mode — propose line items, sections, scope updates, and edits as your tools allow. Default behavior.');
  }

  return {
    system: [
      { type: 'text', text: stableLines.join('\n'), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n# Current estimate context (refreshed each turn)\n\n' + lines.join('\n') }
    ],
    photoBlocks: photoBlocks,
    aiPhase: aiPhase
  };
}

// Filter the AG tool list for Plan mode — drops every editing-style
// propose_* tool while keeping conversational + scope-capture + note
// + web search. Build mode passes through the full list. Used by the
// AG chat + continue handlers; web tools are added back by runStream.
const PLAN_MODE_ALLOWED_AG_TOOLS = new Set([
  'propose_update_scope',
  'propose_add_client_note'
]);
function filterToolsForPhase(tools, phase) {
  if (phase !== 'plan') return tools;
  return (tools || []).filter(t => PLAN_MODE_ALLOWED_AG_TOOLS.has(t.name));
}

// Load skill packs from app_settings.agent_skills filtered by agent +
// alwaysOn. Returns an array of {name, body} blocks ready to append to
// the system prompt. Failures (no setting yet, malformed JSON) return
// an empty array — the agent still works, just without the playbooks.
async function loadActiveSkillsFor(agentKey) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'agent_skills'`
    );
    if (!rows.length) return [];
    const cfg = rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
    return skills
      .filter(s => s && s.alwaysOn !== false && Array.isArray(s.agents) && s.agents.indexOf(agentKey) >= 0 && s.body)
      .map(s => ({ name: s.name || '(untitled skill)', body: s.body }));
  } catch (e) {
    console.error('loadActiveSkillsFor error:', e);
    return [];
  }
}

// Load a photo's web variant from storage and return an Anthropic image
// content block. Returns null on read failure rather than throwing so a
// single broken file doesn't kill the chat.
async function loadPhotoAsBlock(photoRow) {
  try {
    if (!storage.localRoot || !photoRow.web_key) return null;
    const fullPath = path.join(storage.localRoot, photoRow.web_key);
    const buf = await fs.promises.readFile(fullPath);
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: 'image/jpeg', // web variants are jpeg-encoded by the upload pipeline
        data: buf.toString('base64')
      }
    };
  } catch (e) {
    console.warn('Could not load photo', photoRow.id, ':', e.message);
    return null;
  }
}

// ──────────────────────────────────────────────────────────────────
// History endpoints
// ──────────────────────────────────────────────────────────────────

router.get('/estimates/:id/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, photos_included, created_at
         FROM ai_messages
         WHERE estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [req.params.id, req.user.id]
      );
      res.json({ messages: rows });
    } catch (e) {
      console.error('GET /api/ai/estimates/:id/messages error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/estimates/:id/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      await pool.query(
        'DELETE FROM ai_messages WHERE estimate_id = $1 AND user_id = $2',
        [req.params.id, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE history error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Shared streaming helper. Both /chat (initial) and /chat/continue
// (resume after approvals) call this with a pre-built `messages` array.
// It streams text deltas as they arrive, then on finalMessage:
//   - If the response contains tool_use blocks, send them as SSE events
//     and end with `awaiting_approval: true` + the full assistant
//     content array (so the client can echo it back on /chat/continue).
//   - Otherwise (end_turn), persist the assistant text and end with
//     `done: true`.
//
// The assistant message is NOT persisted when it contains tool_use —
// only the final text response of the full multi-step turn lands in
// history. Intermediate proposal turns are transient.
// ──────────────────────────────────────────────────────────────────
function setSSEHeaders(res) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();
}

// Build an Anthropic image content block from a base64-encoded image
// shipped by the client (clipboard paste, PDF page render, etc.).
// Detects the media_type from the base64 magic bytes — the client
// strips the data: URI prefix and we'd otherwise mis-label every
// image as JPEG, which makes Anthropic silently return an empty
// response when the bytes are actually PNG / WebP / GIF.
function inlineImageBlock(b64) {
  if (typeof b64 !== 'string' || !b64) return null;
  // Tolerate clients that pass either pure base64 or "data:...;base64,..."
  const stripped = b64.indexOf('base64,') >= 0
    ? b64.slice(b64.indexOf('base64,') + 7)
    : b64;
  // Inspect the leading bytes (in their base64 form — these prefixes are
  // distinct enough to identify each image type without decoding).
  const head = stripped.slice(0, 12);
  let mediaType = 'image/jpeg';
  if (head.startsWith('iVBOR')) mediaType = 'image/png';
  else if (head.startsWith('R0lGOD')) mediaType = 'image/gif';
  else if (head.startsWith('UklGR')) mediaType = 'image/webp';
  else if (head.startsWith('/9j/')) mediaType = 'image/jpeg';
  return {
    type: 'image',
    source: { type: 'base64', media_type: mediaType, data: stripped }
  };
}

async function runStream({ anthropic, res, system, messages, persistAssistantText, persistArgs, tools }) {
  function send(payload) { res.write('data: ' + JSON.stringify(payload) + '\n\n'); }
  function endWithDone() { res.write('data: [DONE]\n\n'); res.end(); }
  function abort(message) {
    send({ error: message });
    endWithDone();
  }

  let assistantText = '';
  let finalContent = null;
  let usage = { input_tokens: null, output_tokens: null };

  // Cache the tool definitions too — they're stable across all turns
  // and contribute meaningful tokens. Marker on the last tool tells
  // Anthropic to cache the entire tools block + everything before it
  // (system, tools rendered first in cache order). Combined with the
  // system stable-prefix cache, that's two cache breakpoints — well
  // under the per-request limit.
  // Caller can pass `tools` to swap in JOB_TOOLS (or any other tool
  // set). Defaults to ESTIMATE_TOOLS for backwards-compat.
  // Web tools sit at the FRONT of the array so the cache_control
  // breakpoint stays on the last user-defined tool — that way the cached
  // prefix covers system + WEB_TOOLS + user tools as one block.
  const userTools = Array.isArray(tools) ? tools : ESTIMATE_TOOLS;
  const toolList = [...WEB_TOOLS, ...userTools];
  const cachedTools = toolList.length
    ? [
        ...toolList.slice(0, -1),
        Object.assign({}, toolList[toolList.length - 1], { cache_control: { type: 'ephemeral' } })
      ]
    : toolList;
  const _effort = effortClause();
  const stream = anthropic.messages.stream(Object.assign({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: system,
    tools: cachedTools,
    messages: messages
  }, _effort ? { output_config: _effort } : {}));

  stream.on('text', (delta) => {
    assistantText += delta;
    send({ delta: delta });
  });
  stream.on('finalMessage', (msg) => {
    if (msg && msg.usage) usage = msg.usage;
    if (msg && Array.isArray(msg.content)) finalContent = msg.content;
  });
  stream.on('error', (err) => {
    console.error('Anthropic stream error:', err);
    abort(err.message || 'AI request failed');
  });

  try {
    await stream.done();
  } catch (e) {
    abort(e.message || 'Stream failed');
    return;
  }

  // Did Claude produce any tool_use blocks?
  const toolUseBlocks = (finalContent || []).filter(b => b.type === 'tool_use');

  if (toolUseBlocks.length) {
    // Stream each proposal as a discrete event so the client can render
    // approval cards in order.
    for (const tu of toolUseBlocks) {
      send({ tool_use: { id: tu.id, name: tu.name, input: tu.input } });
    }
    // Send the full assistant content back so the client can echo it on
    // /chat/continue — Anthropic needs the original tool_use blocks in
    // the conversation history to match against the user-side tool_result.
    send({
      awaiting_approval: true,
      pending_assistant_content: finalContent,
      tool_use_count: toolUseBlocks.length,
      usage: usage
    });
    endWithDone();
    return;
  }

  // No tool calls — final text response. Persist and complete.
  if (assistantText && persistAssistantText) {
    await persistAssistantText(assistantText, usage, persistArgs);
  }
  send({ done: true, usage: usage });
  endWithDone();
}

// Persist a final assistant text response. Used as the callback on the
// run helper so persistence stays inside this module.
async function saveAssistantMessage({ estimateId, userId, text, usage }) {
  const id = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
     VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7)`,
    [id, estimateId, userId, text, MODEL, usage.input_tokens, usage.output_tokens]
  );
}

// ──────────────────────────────────────────────────────────────────
// Streaming chat endpoint. Body: { message, includePhotos }.
// Response: text/event-stream with structured events:
//   { delta: "..." }                   — text chunk
//   { tool_use: {id, name, input} }    — proposed action (one per block)
//   { awaiting_approval: true,         — end-of-turn: needs user response
//     pending_assistant_content: [...] }
//   { done: true }                     — end-of-turn: nothing pending
//   { error: "..." }                   — failure
// Stream always ends with `data: [DONE]`.
// ──────────────────────────────────────────────────────────────────
router.post('/estimates/:id/chat',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY in the server environment, then redeploy or restart the service.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const includePhotos = req.body && req.body.includePhotos !== false;
    // Inline base64 images shipped with this single turn (e.g., rendered
    // PDF pages from the viewer's "Ask AI" handoff). Hard-capped here on
    // the server side as well so a misbehaving client can't push past
    // Anthropic's per-request image limit.
    const additionalImages = Array.isArray(req.body && req.body.additional_images)
      ? req.body.additional_images.slice(0, 12)
      : [];
    const estimateId = req.params.id;

    setSSEHeaders(res);

    try {
      const histRes = await pool.query(
        `SELECT role, content
         FROM ai_messages
         WHERE estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [estimateId, req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      const ctx = await buildEstimateContext(estimateId, includePhotos);

      // Build the inline image content blocks for this turn. The entity's
      // attached photos come first, then any per-turn additional_images.
      // If both are present we may exceed Anthropic's 20-image limit, so
      // trim the combined list to a safe ceiling (20 minus headroom).
      const inlineImageBlocks = [...ctx.photoBlocks];
      additionalImages.forEach(b64 => {
        const block = inlineImageBlock(b64);
        if (block) inlineImageBlocks.push(block);
      });
      const cappedImages = inlineImageBlocks.slice(0, 18);

      const userContent = cappedImages.length
        ? [...cappedImages, { type: 'text', text: userMessage }]
        : userMessage;

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent }
      ];

      // Persist the user message immediately so a mid-stream failure
      // doesn't lose what they asked.
      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, photos_included)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [userMsgId, estimateId, req.user.id, userMessage, ctx.photoBlocks.length]
      );

      await runStream({
        anthropic, res,
        system: ctx.system,
        // Plan mode hard-filters editing tools — the model literally
        // cannot call them (not just a soft prompt rule). Build mode
        // passes through the full ESTIMATE_TOOLS list.
        tools: filterToolsForPhase(ESTIMATE_TOOLS, ctx.aiPhase),
        messages: messages,
        persistAssistantText: async (text, usage) => {
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// ──────────────────────────────────────────────────────────────────
// Continuation endpoint — called after the user approves/rejects the
// proposals from a tool_use turn.
//
// Body:
//   pending_assistant_content: <the full content array we sent in
//                                awaiting_approval — must be echoed
//                                back verbatim so the API matches the
//                                tool_use IDs against the tool_result>
//   tool_results: [
//     { tool_use_id, approved: bool, applied_summary?: string }
//   ]
//
// We don't include photos on continuation — they were attached to the
// initial user message and are conceptually still in the prior turn's
// context from Claude's perspective.
// ──────────────────────────────────────────────────────────────────
router.post('/estimates/:id/chat/continue',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    const pendingContent = req.body && req.body.pending_assistant_content;
    const toolResults = req.body && req.body.tool_results;
    if (!Array.isArray(pendingContent) || !Array.isArray(toolResults) || !toolResults.length) {
      return res.status(400).json({ error: 'pending_assistant_content and tool_results are required' });
    }
    const estimateId = req.params.id;

    setSSEHeaders(res);

    try {
      const histRes = await pool.query(
        `SELECT role, content
         FROM ai_messages
         WHERE estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [estimateId, req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      // Don't include photos on continuation — they were attached to the
      // initial user message; the system prompt re-mentions them by count.
      const ctx = await buildEstimateContext(estimateId, false);

      // Build tool_result blocks from the user's approve/reject decisions
      const toolResultBlocks = toolResults.map(r => ({
        type: 'tool_result',
        tool_use_id: r.tool_use_id,
        content: r.approved
          ? (r.applied_summary || 'User approved. Change applied to the estimate.')
          : (r.reject_reason || 'User rejected this proposal.')
      }));

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'assistant', content: pendingContent },
        { role: 'user', content: toolResultBlocks }
      ];

      await runStream({
        anthropic, res,
        system: ctx.system,
        // Re-apply phase filtering on the continue path so a Plan-mode
        // estimate can't slip an editing tool back in via the
        // post-approval round-trip.
        tools: filterToolsForPhase(ESTIMATE_TOOLS, ctx.aiPhase),
        messages: messages,
        persistAssistantText: async (text, usage) => {
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// JOB / WIP CHAT — Phase 2B
//
// Same chat infrastructure, different context. Reads the job's WIP
// blob from `jobs.data` and surfaces financials (contract, costs,
// change orders, % complete, margin, billing posture) so the assistant
// can spot underbilled phases, missing change orders, margin drift,
// etc. Read-only for now — no write tools. Storage shares the
// ai_messages table, partitioned via entity_type='job'.
// ════════════════════════════════════════════════════════════════════

function fmtMoney(n) {
  if (n == null || isNaN(n)) n = 0;
  return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}
function pct(n) {
  if (n == null || isNaN(n)) return '0%';
  return Number(n).toFixed(1) + '%';
}

// Mirrors getJobWIP() in js/wip.js so the AI sees the same numbers the
// PM sees on the workspace. Pulled into the server so the assistant
// doesn't have to recompute (and risk drifting from) the UI's math.
function computeJobWIP(job, jobBuildings, jobPhases, jobChangeOrders, jobSubs, jobInvoices) {
  const co = (jobChangeOrders || []).reduce((acc, c) => {
    acc.income += Number(c.income || c.contractAmount || 0);
    acc.costs += Number(c.costs || c.estimatedCosts || 0);
    return acc;
  }, { income: 0, costs: 0 });

  // Sum of sub-level + phase-level + building-level actual costs is the
  // same calc wip.js does in getJobTotalCost(). Subs at level=='phase'
  // / 'building' / 'job' all roll up. Use the override if present.
  let actualCosts = 0;
  if (job.ngActualCosts != null) {
    actualCosts = Number(job.ngActualCosts);
  } else {
    actualCosts = (jobSubs || []).reduce((sum, s) => sum + Number(s.amount || 0), 0);
  }

  const contractIncome = Number(job.contractAmount || 0);
  const estimatedCosts = Number(job.estimatedCosts || 0);
  const totalIncome = contractIncome + co.income;
  const totalEstCosts = estimatedCosts + co.costs;
  const revisedCostChanges = Number(job.revisedCostChanges || 0);
  const revisedEstCosts = totalEstCosts + revisedCostChanges;
  const asSoldProfit = contractIncome - estimatedCosts;
  const asSoldMargin = contractIncome > 0 ? (asSoldProfit / contractIncome * 100) : 0;
  const revisedProfit = totalIncome - revisedEstCosts;
  const revisedMargin = totalIncome > 0 ? (revisedProfit / totalIncome * 100) : 0;
  const pctComplete = Number(job.pctComplete || 0);
  const revenueEarned = totalIncome * (pctComplete / 100);
  const jtdProfit = revenueEarned - actualCosts;
  const jtdMargin = revenueEarned > 0 ? (jtdProfit / revenueEarned * 100) : 0;
  const invoiced = Number(job.invoicedToDate || 0);
  const unbilled = revenueEarned - invoiced;
  const backlog = totalIncome - revenueEarned;
  const remainingCosts = revisedEstCosts - actualCosts;

  return {
    contractIncome, estimatedCosts, coIncome: co.income, coCosts: co.costs,
    totalIncome, totalEstCosts, revisedCostChanges, revisedEstCosts,
    asSoldProfit, asSoldMargin, revisedProfit, revisedMargin,
    pctComplete, revenueEarned, actualCosts, jtdProfit, jtdMargin,
    invoiced, unbilled, backlog, remainingCosts
  };
}

// clientContext is optional; if provided, the client passed extra
// state the server can't reach yet (node graph state lives in
// localStorage; QB cost lines aren't in the DB until Phase 2).
// Fields used: { nodeGraph: { nodes, wires }, qbCosts: { total,
// byCategory, lineCount, mostRecentImport, samples[] } }
async function buildJobContext(jobId, clientContext) {
  // Pull the job + the related data the bulk-save serializes alongside it.
  const jobRes = await pool.query('SELECT id, owner_id, data FROM jobs WHERE id = $1', [jobId]);
  if (!jobRes.rows.length) throw new Error('Job not found');
  const job = { id: jobRes.rows[0].id, owner_id: jobRes.rows[0].owner_id, ...jobRes.rows[0].data };

  // Joined data sits alongside the jobs JSONB blob — the bulk save splits
  // them into separate appData arrays on the client. Read all of them
  // here and filter to this job.
  const jobsRes = await pool.query(`SELECT id, data FROM jobs`);
  // Each job row's data may contain its OWN buildings/phases/etc. arrays,
  // OR the client may have flattened them across the appData blob. Try the
  // job-local arrays first.
  const buildings = Array.isArray(job.buildings) ? job.buildings : [];
  const phases = Array.isArray(job.phases) ? job.phases : [];
  const changeOrders = Array.isArray(job.changeOrders) ? job.changeOrders : [];
  const subs = Array.isArray(job.subs) ? job.subs : [];
  const purchaseOrders = Array.isArray(job.purchaseOrders) ? job.purchaseOrders : [];
  const invoices = Array.isArray(job.invoices) ? job.invoices : [];
  void jobsRes; // future use if cross-job analysis is needed

  const wip = computeJobWIP(job, buildings, phases, changeOrders, subs, invoices);

  const lines = [];
  lines.push('You are Elle, AGX\'s WIP analyst. AGX = AG Exteriors, a Central Florida construction services company. The PM is working on the job below — help them spot margin issues, missing change orders, billing gaps, and progress risks. (Your name is a nod to Lisa.)');
  lines.push('');
  lines.push('# Job');
  lines.push('- Title: ' + (job.title || job.jobName || '(untitled)'));
  if (job.jobNumber) lines.push('- Job number: ' + job.jobNumber);
  if (job.client) lines.push('- Client: ' + job.client);
  if (job.community) lines.push('- Community / property: ' + job.community);
  if (job.propertyAddr) lines.push('- Address: ' + job.propertyAddr);
  if (job.jobType) lines.push('- Type: ' + job.jobType + (job.market ? ' (' + job.market + ')' : ''));
  if (job.status) lines.push('- Status: ' + job.status);
  if (job.targetMarginPct != null) lines.push('- Target margin: ' + job.targetMarginPct + '%');
  lines.push('');

  lines.push('# WIP snapshot');
  lines.push('## Income');
  lines.push('- Contract (as-sold): ' + fmtMoney(wip.contractIncome));
  lines.push('- Change-order income: ' + fmtMoney(wip.coIncome));
  lines.push('- Total income (contract + COs): ' + fmtMoney(wip.totalIncome));
  lines.push('## Costs');
  lines.push('- Estimated costs (as-sold): ' + fmtMoney(wip.estimatedCosts));
  lines.push('- Change-order costs: ' + fmtMoney(wip.coCosts));
  lines.push('- Revised cost changes: ' + fmtMoney(wip.revisedCostChanges));
  lines.push('- Revised estimated costs: ' + fmtMoney(wip.revisedEstCosts));
  lines.push('- Actual costs to date: ' + fmtMoney(wip.actualCosts));
  lines.push('- Remaining costs (revised est − actual): ' + fmtMoney(wip.remainingCosts));
  lines.push('## Margin');
  lines.push('- As-sold profit: ' + fmtMoney(wip.asSoldProfit) + ' (' + pct(wip.asSoldMargin) + ')');
  lines.push('- Revised profit: ' + fmtMoney(wip.revisedProfit) + ' (' + pct(wip.revisedMargin) + ')');
  lines.push('- JTD profit: ' + fmtMoney(wip.jtdProfit) + ' (' + pct(wip.jtdMargin) + ')');
  lines.push('## Progress & billing');
  lines.push('- % complete: ' + pct(wip.pctComplete));
  lines.push('- Revenue earned: ' + fmtMoney(wip.revenueEarned));
  lines.push('- Invoiced to date: ' + fmtMoney(wip.invoiced));
  lines.push('- Unbilled (earned − invoiced): ' + fmtMoney(wip.unbilled));
  lines.push('- Backlog (total income − revenue earned): ' + fmtMoney(wip.backlog));
  lines.push('');

  // Sub-job structure summary so the assistant can reason at the right
  // grain (phase-level vs. building-level)
  if (buildings.length || phases.length) {
    lines.push('# Structure');
    lines.push('- Buildings: ' + buildings.length + (buildings.length ? ' (' + buildings.map(b => b.name || b.id).slice(0, 8).join(', ') + (buildings.length > 8 ? ', …' : '') + ')' : ''));
    lines.push('- Phases: ' + phases.length);
    lines.push('');
  }

  // Change orders — the most-overlooked profit lever
  if (changeOrders.length) {
    lines.push('# Change orders (' + changeOrders.length + ')');
    changeOrders.forEach((c, i) => {
      const num = i + 1;
      const inc = fmtMoney(c.income || c.contractAmount || 0);
      const cost = fmtMoney(c.costs || c.estimatedCosts || 0);
      const desc = c.description || c.title || '(no description)';
      lines.push('- CO ' + num + ': ' + desc + ' — income ' + inc + ', cost ' + cost + (c.status ? ' [' + c.status + ']' : ''));
    });
    lines.push('');
  } else {
    lines.push('# Change orders');
    lines.push('(none recorded)');
    lines.push('');
  }

  // Cost-side detail — top cost-line subs by amount, capped so we don't
  // blow context. Group by phase / building when meaningful.
  if (subs.length) {
    const sortedSubs = subs.slice().sort((a, b) => Number(b.amount || 0) - Number(a.amount || 0));
    const top = sortedSubs.slice(0, 20);
    lines.push('# Top cost lines (' + top.length + ' of ' + subs.length + ' shown)');
    top.forEach(s => {
      const amt = fmtMoney(s.amount || 0);
      const where = s.level === 'phase' ? '[phase]' : s.level === 'building' ? '[building]' : '[job]';
      const label = s.vendor || s.description || s.name || '(unlabeled)';
      lines.push('- ' + amt + ' ' + where + ' ' + label);
    });
    lines.push('');
  }

  // Invoices — billing posture
  if (invoices.length) {
    lines.push('# Invoices (' + invoices.length + ')');
    const invTotal = invoices.reduce((s, i) => s + Number(i.amount || 0), 0);
    lines.push('- Total invoiced (sum): ' + fmtMoney(invTotal));
    invoices.slice(0, 8).forEach(inv => {
      lines.push('- ' + (inv.date || inv.invoiceDate || '') + ' ' + fmtMoney(inv.amount || 0) + ' ' + (inv.number || inv.invoiceNumber || '') + (inv.status ? ' [' + inv.status + ']' : ''));
    });
    if (invoices.length > 8) lines.push('- …and ' + (invoices.length - 8) + ' more');
    lines.push('');
  }

  if (purchaseOrders.length) {
    lines.push('# Purchase orders: ' + purchaseOrders.length);
    lines.push('');
  }

  // ── Client-supplied context (graph + QB cost data) ─────────────
  // The node graph lives in localStorage; QB cost lines lived in
  // workspace sheets pre-Phase-2. The client snapshots both and
  // sends them with the chat request so the assistant can reason
  // about wiring and uncategorized costs.
  if (clientContext && clientContext.nodeGraph) {
    var ng = clientContext.nodeGraph;
    var nodes = Array.isArray(ng.nodes) ? ng.nodes : [];
    var wires = Array.isArray(ng.wires) ? ng.wires : [];
    if (nodes.length) {
      lines.push('# Node graph (' + nodes.length + ' nodes, ' + wires.length + ' wires)');
      lines.push('**This block is LIVE, not a snapshot.** It\'s rebuilt from the client on every user message AND every tool_use continuation. New nodes the user creates (or that you create via tools) WILL appear in the next turn — never tell the user "I can\'t see new nodes in real-time" or "you need to refresh the session." If a node was just added, it\'s in the list below this turn.');
      lines.push('Each node listed as: `[id=NODE_ID] TYPE "label" | value | %complete | budget`. Types: t1 = building, t2 = phase, sub = subcontractor cost, co = change order, po = purchase order, inv = invoice, wip = WIP rollup, watch = KPI display, note = sticky note.');
      lines.push('**CRITICAL** — when calling `wire_nodes`, `assign_qb_line`, or any tool that takes a node id, pass the bracketed `id=` value from this list (e.g. `n_5`, NOT `"Painting - B31"`). Labels can include separator characters (›, /, etc.) and will not match. The client falls back to label lookup as a safety net but you should always send the real id.');
      var sortedNodes = nodes.slice().sort(function(a, b) { return (a.type || '').localeCompare(b.type || ''); });
      sortedNodes.slice(0, 60).forEach(function(n) {
        var pct = (n.pctComplete != null && n.pctComplete > 0) ? ' | ' + Math.round(n.pctComplete) + '%' : '';
        var bud = (n.budget != null && n.budget > 0) ? ' | budget ' + fmtMoney(n.budget) : '';
        var val = (n.value != null && n.value !== 0) ? ' | value ' + fmtMoney(n.value) : '';
        lines.push('- [id=' + (n.id || '?') + '] ' + (n.type || '?') + ' "' + (n.label || '(no label)') + '"' + val + pct + bud);
      });
      if (nodes.length > 60) lines.push('- …and ' + (nodes.length - 60) + ' more nodes');
      lines.push('');
      lines.push('## Wires (' + wires.length + ' connections)');
      // Group wires by source for readability — show ids first, labels in parens for context
      if (wires.length) {
        var nodeById = {};
        nodes.forEach(function(n) { nodeById[n.id] = n; });
        wires.slice(0, 80).forEach(function(w) {
          var from = nodeById[w.fromNode];
          var to = nodeById[w.toNode];
          if (from && to) {
            lines.push('- ' + w.fromNode + ' → ' + w.toNode + ' (' + (from.label || from.type) + ' → ' + (to.label || to.type) + ')');
          }
        });
        if (wires.length > 80) lines.push('- …and ' + (wires.length - 80) + ' more wires');
      } else {
        lines.push('(no wires — every node is currently disconnected)');
      }
      // Connectivity hints — pre-compute simple disconnection signals
      // since the graph data is right here.
      var hasIncoming = {};
      var hasOutgoing = {};
      wires.forEach(function(w) { hasIncoming[w.toNode] = true; hasOutgoing[w.fromNode] = true; });
      var orphans = nodes.filter(function(n) {
        if (n.type === 'note' || n.type === 'wip' || n.type === 'watch') return false;
        return !hasIncoming[n.id] && !hasOutgoing[n.id];
      });
      if (orphans.length) {
        lines.push('## Orphan nodes (disconnected)');
        orphans.slice(0, 20).forEach(function(n) {
          lines.push('- ' + (n.type || '?') + ' "' + (n.label || '(no label)') + '"');
        });
        if (orphans.length > 20) lines.push('- …and ' + (orphans.length - 20) + ' more');
      }
      lines.push('');
    }
  }

  // Workspace spreadsheet content — anything the user typed into the
  // in-app Workspace tab (phase lists, scope notes, custom tables).
  // The client packages each non-QB sheet as a text-table preview;
  // we drop it into the prompt verbatim so the assistant can extract
  // phase names, line items, etc. on demand.
  // Workspace sheet index — the COMPLETE list of sheet names in the
  // user's workspace (including empty ones), so the assistant always
  // knows what tabs exist by name and never says "I don't have a
  // list of your workspace sheet names." Render even when no sheet
  // has populated content.
  if (clientContext && Array.isArray(clientContext.workspaceSheetIndex) && clientContext.workspaceSheetIndex.length) {
    lines.push('# Workspace sheets — index (' + clientContext.workspaceSheetIndex.length + ' tabs)');
    lines.push('Tab names available in the user\'s Workspace right now (1 line each):');
    clientContext.workspaceSheetIndex.forEach(function(name) {
      lines.push('- ' + name);
    });
    lines.push('When the user references a sheet, MATCH AGAINST THIS LIST FIRST — try exact match, then case-insensitive, then trimmed-whitespace. Tell the user the exact name you matched. If no list match, ask which tab they mean and show this index. To fetch any sheet\'s contents call `read_workspace_sheet_full` (auto-applies, no approval).');
    lines.push('');
  }

  if (clientContext && Array.isArray(clientContext.workspaceSheets) && clientContext.workspaceSheets.length) {
    lines.push('# Workspace sheets — populated previews (' + clientContext.workspaceSheets.length + ')');
    lines.push('Each preview is rendered as `<row>: A=val · B=val · …` (1-indexed rows, A–Z columns). Use these to answer "what phases / scope items / line items do I have in my workspace?" — pull data directly from these previews. The default preview window is 100 rows × 26 cols; if a sheet is bigger the heading reads "preview truncated" and you should call `read_workspace_sheet_full` to fetch the rest.');
    clientContext.workspaceSheets.forEach(function(s) {
      lines.push('');
      var hint = s.cellCount === 0 ? ', empty in this session' : (s.truncated ? ', preview truncated' : '');
      lines.push('## "' + s.name + '" (' + s.totalRows + ' rows × ' + s.totalCols + ' cols' + hint + ')');
      if (s.preview) lines.push(s.preview);
      else lines.push('(no populated cells)');
    });
    lines.push('');
  }

  if (clientContext && clientContext.qbCosts) {
    var qb = clientContext.qbCosts;
    if (qb.lineCount > 0 || qb.total) {
      var sourceLabel = qb.source === 'server'
        ? 'server-persisted (qb_cost_lines table — canonical, idempotent across devices)'
        : qb.source === 'sheets'
          ? 'localStorage workspace sheets (legacy, may be partial — recommend re-importing the QB xlsx so data lands on the server)'
          : 'unknown source';
      lines.push('# QuickBooks cost data — ' + sourceLabel);
      lines.push('**This is the SINGLE SOURCE OF TRUTH for all imported QuickBooks cost data on this job.** It is the same data the user sees in the workspace\'s "Detailed Costs" tab (a pinned sheet that renders this exact dataset live — totals, by-account chips, filterable line table). When the user references "the Detailed Costs sheet", "the QB sheet", "imported costs", "the cost data", or any individual transaction, pull from this block — don\'t look anywhere else, and don\'t tell them to re-import or save anything.');
      lines.push('**For individual lines call `read_qb_cost_lines`** (auto-applies, no approval). It returns the full per-line list filtered by account/vendor/status/search. Use it whenever the user asks about a specific transaction, vendor total, or account that isn\'t already in the summary below.');
      lines.push('**DO NOT call `read_workspace_sheet_full` on "QB Costs YYYY-MM-DD" sheets or on the "Detailed Costs" tab.** Those are legacy per-import snapshots / a live view of THIS block. Reading them one-by-one is a useless loop — every line below is already deduplicated server-side.');
      lines.push('- Lines: ' + (qb.lineCount || 0) + (qb.unlinkedCount != null ? ' (' + qb.unlinkedCount + ' unlinked to a graph node)' : ''));
      lines.push('- Total: ' + fmtMoney(qb.total || 0));
      if (qb.mostRecentImport) lines.push('- Most recent import: ' + qb.mostRecentImport);
      if (qb.byCategory && Object.keys(qb.byCategory).length) {
        lines.push('## By category (Distribution Account)');
        Object.keys(qb.byCategory)
          .sort(function(a, b) { return (qb.byCategory[b] || 0) - (qb.byCategory[a] || 0); })
          .slice(0, 12)
          .forEach(function(cat) {
            lines.push('- ' + cat + ': ' + fmtMoney(qb.byCategory[cat] || 0));
          });
      }
      if (Array.isArray(qb.samples) && qb.samples.length) {
        lines.push('## Top ' + Math.min(qb.samples.length, 20) + ' lines by amount');
        qb.samples.slice(0, 20).forEach(function(s) {
          var lineMarker = s.id ? ' [id=' + s.id + ']' : '';
          var linked = s.linkedNodeId ? ' → ' + s.linkedNodeId : '';
          lines.push('- ' + (s.date || '') + ' ' + fmtMoney(s.amount || 0) + ' ' + (s.vendor || '') + (s.account ? ' | ' + s.account : '') + (s.memo ? ' — ' + String(s.memo).slice(0, 80) : '') + linked + lineMarker);
        });
      }
      lines.push('');
    }
  }

  if (job.notes) {
    lines.push('# Job notes');
    lines.push(job.notes);
    lines.push('');
  }

  lines.push('# Your role');
  lines.push('- Read the WIP snapshot, change orders, cost lines, node graph, and QB cost data together — they tell a story about whether the job is healthy.');
  lines.push('- Spot mismatches: % complete way ahead of revenue earned (under-pulled progress), revenue earned way ahead of invoiced (under-billed), JTD margin diverging from revised margin (cost overruns), large recurring vendors that should have been a CO, QB lines unlinked to graph nodes.');
  lines.push('- When citing dollar figures, match the field name from the snapshot above so the PM can find them in the UI.');
  lines.push('- **You CAN make changes.** Available tools: `create_node` (add a new graph node — t1/t2/cost-bucket/sub/po/inv/co/watch/note), `delete_node` (remove a node + its wires — does NOT delete underlying job data), `set_phase_pct_complete`, `set_phase_field` (materials/labor/sub/equipment dollars on a PHASE record from # Structure), `set_node_value` (QB Total / value on a cost-bucket NODE from # Node graph — labor/mat/gc/other/sub/burden), `wire_nodes` (connect graph nodes), `assign_qb_line` (link a QB cost line to a graph node), `read_workspace_sheet_full` and `read_qb_cost_lines` (auto-apply, no approval). Each writer tool writes a proposal card the user approves; trusted tool types auto-apply after a 5s countdown.');
  lines.push('- **set_phase_field vs set_node_value — DO NOT MIX THEM UP.** `set_phase_field` writes to a phase record (phase_id from # Structure, e.g. "ph_..."). `set_node_value` writes the QB Total field to a graph node (node_id from # Node graph, e.g. "n38"). When the user says "load the QB Materials & Supplies total into the Materials node" or similar, that is `set_node_value` on a `mat` node — passing a node id like "n38" to `set_phase_field` will fail because n38 is not in appData.phases.');
  lines.push('- **Every block above is LIVE for this turn** — node graph, QB cost lines, workspace sheets all rebuild from the client on every user message and every tool_use continuation. If something was just created/edited, it\'s in the data above. NEVER say "I can\'t see new X" or "the snapshot is stale" or "you need to refresh the session" — those statements are factually wrong about how this assistant works.');
  lines.push('- When the user references a node/sheet/line by name and you can\'t find it, search the relevant block by case-insensitive partial match before asking — it\'s usually there.');
  lines.push('- Be concise and direct. Construction trade vocabulary is welcome. If you need one piece of info to answer well, ask one targeted question first.');
  lines.push('');
  lines.push('# Web research (web_search tool)');
  lines.push('You have a web_search tool. Use it sparingly on the job side — most answers are already in the WIP snapshot, change orders, QB cost lines, and node graph above. Good reasons to search:');
  lines.push('  • Look up a recurring vendor name to figure out what trade/category they serve when the QB account label is ambiguous (e.g., "is ACME Supply Co a roofing supplier or a general lumberyard?").');
  lines.push('  • Confirm a sub\'s scope or licensing when categorizing their cost lines.');
  lines.push('  • Look up a product/material SKU charged to the job when the PM asks "what did we buy here?".');
  lines.push('Do NOT search for AGX-internal financial questions, margin math, or anything answered by the data above. Cap at ~2 searches per turn.');

  // Skill packs targeted at Elle. Same loader as AG / HR; agentKey
  // for Elle is 'job' (matches entity_type for back-compat). Appended
  // as standalone sections so the model sees them as binding.
  const elleSkills = await loadActiveSkillsFor('job');
  if (elleSkills.length) {
    lines.push('');
    lines.push('# Loaded skills');
    lines.push('Skill packs your admin has assigned to Elle. Treat each as binding additional guidance on top of the baseline rules above.');
    elleSkills.forEach(function(s) {
      lines.push('');
      lines.push('## ' + s.name);
      lines.push(s.body);
    });
  }

  // Job side stays plain — single string. Lower volume than AG/HR so
  // the marginal caching benefit isn't worth the structural complexity.
  return { system: lines.join('\n'), photoBlocks: [] };
}

// History endpoints scoped by entity_type='job'
router.get('/jobs/:id/messages',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, created_at
         FROM ai_messages
         WHERE entity_type = 'job' AND estimate_id = $1 AND user_id = $2
         ORDER BY created_at ASC`,
        [req.params.id, req.user.id]
      );
      res.json({ messages: rows });
    } catch (e) {
      console.error('GET /api/ai/jobs/:id/messages error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/jobs/:id/messages',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM ai_messages WHERE entity_type='job' AND estimate_id=$1 AND user_id=$2`,
        [req.params.id, req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE job history error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.post('/jobs/:id/chat',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY in the server environment.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const jobId = req.params.id;
    const clientContext = (req.body && req.body.clientContext) || null;

    setSSEHeaders(res);

    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
         WHERE entity_type='job' AND estimate_id=$1 AND user_id=$2
         ORDER BY created_at ASC`,
        [jobId, req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      const ctx = await buildJobContext(jobId, clientContext);

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage }
      ];

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'job', $2, $3, 'user', $4)`,
        [userMsgId, jobId, req.user.id, userMessage]
      );

      // Phase 3: route through runStream with JOB_TOOLS so the
      // assistant can emit tool_use proposals. Approval flow is the
      // same as the estimate side — client renders cards, user
      // approves, /chat/continue resumes the turn with tool_results.
      await runStream({
        anthropic, res,
        system: ctx.system,
        messages: messages,
        tools: JOB_TOOLS,
        persistAssistantText: async (text, usage) => {
          if (!text) return;
          const aid = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await pool.query(
            `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
             VALUES ($1, 'job', $2, $3, 'assistant', $4, $5, $6, $7)`,
            [aid, jobId, req.user.id, text, MODEL, usage.input_tokens, usage.output_tokens]
          );
        }
      });
    } catch (e) {
      console.error('AI job chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// Job /chat/continue — resumes a turn after the user has approved
// or rejected proposals from the previous tool_use round.
router.post('/jobs/:id/chat/continue',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    const pendingContent = req.body && req.body.pending_assistant_content;
    const toolResults = req.body && req.body.tool_results;
    const clientContext = (req.body && req.body.clientContext) || null;
    if (!Array.isArray(pendingContent) || !Array.isArray(toolResults) || !toolResults.length) {
      return res.status(400).json({ error: 'pending_assistant_content and tool_results are required' });
    }
    const jobId = req.params.id;

    setSSEHeaders(res);

    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
         WHERE entity_type='job' AND estimate_id=$1 AND user_id=$2
         ORDER BY created_at ASC`,
        [jobId, req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      const ctx = await buildJobContext(jobId, clientContext);

      const toolResultBlocks = toolResults.map(r => ({
        type: 'tool_result',
        tool_use_id: r.tool_use_id,
        content: r.approved
          ? (r.applied_summary || 'User approved. Change applied.')
          : (r.reject_reason || 'User rejected this proposal.')
      }));

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'assistant', content: pendingContent },
        { role: 'user', content: toolResultBlocks }
      ];

      await runStream({
        anthropic, res,
        system: ctx.system,
        messages: messages,
        tools: JOB_TOOLS,
        persistAssistantText: async (text, usage) => {
          if (!text) return;
          const aid = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await pool.query(
            `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
             VALUES ($1, 'job', $2, $3, 'assistant', $4, $5, $6, $7)`,
            [aid, jobId, req.user.id, text, MODEL, usage.input_tokens, usage.output_tokens]
          );
        }
      });
    } catch (e) {
      console.error('AI job chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// LEAD EXTRACTION FROM PDF
//
// Takes rendered pages from a Buildertrend "Lead Print" PDF and returns
// structured lead data that the New Lead form prefills with. The user
// drops a PDF on the modal; client-side PDF.js renders pages; we ship
// the page images to Claude with a tight schema; the model returns
// JSON matching the leads-table column set.
//
// Schema mirrors the editable fields on lead-routes.js EDITABLE_FIELDS
// so the prefilled values can save with no transformation.
// ════════════════════════════════════════════════════════════════════

const LEAD_EXTRACTION_SCHEMA = {
  type: 'object',
  properties: {
    title: { type: 'string', description: 'Lead opportunity title — the project / repair name. Usually shown as the heading of the BT print.' },
    client_company: { type: 'string', description: 'PARENT company / management firm name only (e.g., "PAC", "Greystar"). When the Client Contact line shows "Company - Property/Site Name", extract the LEFT side only into this field. Empty string if not present.' },
    client_property: { type: 'string', description: 'PROPERTY / SITE name from the right side of "Company - Property/Site" on the Client Contact line. E.g., from "PAC - Solace Timacuan" set this to "Solace Timacuan". Empty string when the contact line has no " - Site" suffix.' },
    client_first_name: { type: 'string', description: 'Primary contact first name (often shown after the company in BT) or empty string if only a company is listed.' },
    client_last_name: { type: 'string', description: 'Primary contact last name or empty string.' },
    client_email: { type: 'string', description: 'Client contact email address or empty string.' },
    client_phone: { type: 'string', description: 'Client contact phone (digits with formatting OK) or empty string.' },
    client_address: { type: 'string', description: 'Client mailing street address (line 1) or empty string. NOT the property/job site address.' },
    client_city: { type: 'string', description: 'Client mailing city or empty string.' },
    client_state: { type: 'string', description: 'Two-letter state code or empty string.' },
    client_zip: { type: 'string', description: 'Client mailing ZIP or empty string.' },
    property_name: { type: 'string', description: 'Property / community name (from "Lead Opportunity Info" or similar block). Empty string if not present.' },
    property_address: { type: 'string', description: 'Property / job site street address (line 1) or empty string.' },
    property_city: { type: 'string', description: 'Property city or empty string.' },
    property_state: { type: 'string', description: 'Property state code or empty string.' },
    property_zip: { type: 'string', description: 'Property ZIP or empty string.' },
    salesperson_name: { type: 'string', description: 'AGX salesperson name from the Salesperson section or empty string.' },
    project_type: { type: 'string', enum: ['', 'Renovation', 'Service & Repair', 'Work Order'], description: 'Project type. Map BT values to this enum: Renovation/Repaint/Restoration → "Renovation"; Service or Repair → "Service & Repair"; Work Order/Urgent/Emergency → "Work Order". Empty string if BT did not specify.' },
    market: { type: 'string', description: 'Market field from the custom fields section (e.g., "Tampa", "Orlando"). Empty string if N/A or absent.' },
    gate_code: { type: 'string', description: 'Gate code from the custom fields section. Empty string if N/A or absent.' },
    confidence_pct: { type: 'integer', description: 'Confidence Level as a number 0-100. 0 if absent.' },
    estimated_revenue_low: { type: 'number', description: 'Lower bound of Est. Revenue range. 0 if not specified or both bounds blank.' },
    estimated_revenue_high: { type: 'number', description: 'Upper bound of Est. Revenue range. 0 if not specified.' },
    status: { type: 'string', enum: ['new', 'in_progress', 'sent', 'sold', 'lost', 'no_opportunity'], description: 'Mapped lead status. BT "Open" or "Pending" → "in_progress"; BT "New" → "new"; otherwise default to "new".' },
    notes: { type: 'string', description: 'Full Notes section text. Preserve formatting/line breaks. Includes the SOW summary, POC details, and any other narrative content. Empty string if no notes.' }
  },
  required: [
    'title', 'client_company', 'client_property',
    'client_first_name', 'client_last_name',
    'client_email', 'client_phone', 'client_address', 'client_city',
    'client_state', 'client_zip', 'property_name', 'property_address',
    'property_city', 'property_state', 'property_zip',
    'salesperson_name', 'project_type', 'market', 'gate_code',
    'confidence_pct', 'estimated_revenue_low', 'estimated_revenue_high',
    'status', 'notes'
  ],
  additionalProperties: false
};

const LEAD_EXTRACTION_SYSTEM = [
  'You are extracting structured lead data from a Buildertrend "Lead Print" PDF for AG Exteriors, a Central Florida construction services company.',
  '',
  'The PDF pages are attached as images. Read every page. Return ONLY the JSON described by the schema — no prose, no markdown.',
  '',
  'Field rules:',
  '- Use empty strings for missing text fields, 0 for missing numbers — never null, never the string "N/A".',
  '- The Client Contact block usually shows "Company - Property/Site Name" on line 1, then the mailing address. Split this line on the " - " separator: left side → client_company (e.g., "PAC"), right side → client_property (e.g., "Solace Timacuan"). Both halves matter for client matching downstream — keep them separate. If there is no " - " separator, put the whole name in client_company and leave client_property empty.',
  '- Distinguish the client mailing address from the property/job site address. The Lead Opportunity Info block carries the property address; the Client Contact block carries the mailing address.',
  '- The Notes section in BT often contains "**SOW:** ..." and "**POC:** ..." markers. Preserve them in the notes field as-is — they help the PM know the original structure.',
  '- For status: BT "Open" or "Pending" → "in_progress"; "New" → "new"; "Sent" → "sent"; "Sold" → "sold"; "Lost" → "lost"; "No Opportunity" → "no_opportunity". When in doubt, "new".',
  '- For estimated_revenue_low/high: parse "$1,200 to $1,500" as 1200 / 1500. "0 to 0" → both 0. Single number "$5,000" → both 5000.',
  '- For confidence_pct: parse "75%" as 75 (integer). Absent → 0.'
].join('\n');

router.post('/extract-lead',
  requireAuth, requireCapability('LEADS_EDIT'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured. Set ANTHROPIC_API_KEY.' });
    }
    const images = Array.isArray(req.body && req.body.images) ? req.body.images : [];
    if (!images.length) {
      return res.status(400).json({ error: 'images array is required' });
    }
    if (images.length > 12) {
      return res.status(400).json({ error: 'Up to 12 page images per extraction request.' });
    }

    try {
      // Detect each image's media_type from its base64 magic bytes —
      // hardcoding image/jpeg makes Anthropic silently fail on PNGs etc.
      const imageBlocks = images.map(b64 => inlineImageBlock(b64)).filter(Boolean);

      const userContent = [
        ...imageBlocks,
        { type: 'text', text: 'Extract the lead data from these pages. Return only the JSON.' }
      ];

      const response = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 1500,
        system: LEAD_EXTRACTION_SYSTEM,
        messages: [{ role: 'user', content: userContent }],
        // Structured outputs — the API guarantees a JSON response that
        // validates against this schema. Saves us a parsing-and-retry loop.
        output_config: {
          format: {
            type: 'json_schema',
            schema: LEAD_EXTRACTION_SCHEMA
          }
        }
      });

      // The response's first text block is the JSON string; parse it.
      const textBlock = (response.content || []).find(b => b.type === 'text');
      if (!textBlock) throw new Error('No text response from the model.');
      let parsed;
      try {
        parsed = JSON.parse(textBlock.text);
      } catch (e) {
        throw new Error('Model returned non-JSON response: ' + textBlock.text.slice(0, 200));
      }

      res.json({ ok: true, lead: parsed, usage: response.usage });
    } catch (e) {
      console.error('AI extract-lead error:', e);
      res.status(500).json({ error: e.message || 'Server error' });
    }
  }
);

// ════════════════════════════════════════════════════════════════════
// CLIENT DIRECTORY ASSISTANT
//
// Helps with parent-company / property hierarchy management. Each tool
// is tagged with a risk tier:
//   - 'auto'      → server applies immediately, model sees the result and
//                   continues. No UI gating. Used for clearly-safe ops
//                   (creating a new property under a known parent,
//                   filling in a missing phone/email).
//   - 'approval'  → server emits a tool_use event and stops; the user
//                   clicks Approve/Reject. Used for restructural ops
//                   (merging, splitting, deleting, reparenting).
//
// All writes are logged via clients.updated_at and the response payload
// so the chat can echo what happened.
// ════════════════════════════════════════════════════════════════════
// Pending-image bucket — keyed by user_id. Images sent inline on a
// client-mode chat turn land here so the attach_business_card_to_client
// tool can persist them to a specific client's attachments once the
// agent identifies the match. Bucket is in-memory; a server restart or
// scale-out (multiple dynos) would lose it. Acceptable for a single
// Railway dyno; revisit when scaling out.
//
// Each bucket: { images: [{ b64, mime, addedAt }], lastTouched }.
// We cap at 8 images / 30 min before pruning to avoid unbounded growth.
const _clientImageBuckets = new Map();
const PENDING_IMAGE_TTL_MS = 30 * 60 * 1000;
const PENDING_IMAGE_CAP = 8;

function stashPendingClientImages(userId, base64Array) {
  if (!base64Array || !base64Array.length) return;
  const existing = _clientImageBuckets.get(userId) || { images: [], lastTouched: 0 };
  const now = Date.now();
  for (const raw of base64Array) {
    const stripped = typeof raw === 'string' && raw.indexOf('base64,') >= 0
      ? raw.slice(raw.indexOf('base64,') + 7)
      : raw;
    existing.images.push({ b64: stripped, mime: 'image/jpeg', addedAt: now });
  }
  // Trim oldest first
  if (existing.images.length > PENDING_IMAGE_CAP) {
    existing.images = existing.images.slice(-PENDING_IMAGE_CAP);
  }
  existing.lastTouched = now;
  _clientImageBuckets.set(userId, existing);
}
function getPendingClientImage(userId, indexFromEnd) {
  const bucket = _clientImageBuckets.get(userId);
  if (!bucket || !bucket.images.length) return null;
  // Default: last image. Negative indexes count back from the end.
  const offset = (typeof indexFromEnd === 'number' && indexFromEnd > 0)
    ? Math.min(indexFromEnd, bucket.images.length) - 1
    : 0;
  return bucket.images[bucket.images.length - 1 - offset] || null;
}
function consumePendingClientImage(userId, indexFromEnd) {
  const bucket = _clientImageBuckets.get(userId);
  if (!bucket || !bucket.images.length) return null;
  const offset = (typeof indexFromEnd === 'number' && indexFromEnd > 0)
    ? Math.min(indexFromEnd, bucket.images.length) - 1
    : 0;
  const targetIdx = bucket.images.length - 1 - offset;
  const [picked] = bucket.images.splice(targetIdx, 1);
  if (!bucket.images.length) _clientImageBuckets.delete(userId);
  return picked || null;
}
// Prune stale buckets every 10 min.
setInterval(() => {
  const cutoff = Date.now() - PENDING_IMAGE_TTL_MS;
  for (const [uid, bucket] of _clientImageBuckets.entries()) {
    if ((bucket.lastTouched || 0) < cutoff) _clientImageBuckets.delete(uid);
  }
}, 10 * 60 * 1000).unref();

const CLIENT_TOOLS = [
  {
    name: 'create_property',
    tier: 'auto',
    description: 'Create a new property/community under an existing parent management company. Use this when the user asks to add a new property and the parent company already exists in the directory. The parent_client_id MUST refer to an existing client (look it up in the directory context).',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Display name of the property/community (e.g., "Solace Tampa", "City Lakes").' },
        parent_client_id: { type: 'string', description: 'ID of the existing parent management company.' },
        community_name: { type: 'string', description: 'Optional — usually same as name; set only when the formal community name differs from the display name.' },
        property_address: { type: 'string', description: 'Property street address.' },
        city: { type: 'string' },
        state: { type: 'string' },
        zip: { type: 'string' },
        community_manager: { type: 'string', description: 'CAM / on-site contact name.' },
        cm_email: { type: 'string' },
        cm_phone: { type: 'string' },
        market: { type: 'string', description: 'Geographic market (e.g., "Tampa", "Orlando").' }
      },
      required: ['name', 'parent_client_id']
    }
  },
  {
    name: 'create_parent_company',
    tier: 'approval',
    description: 'Create a new top-level parent management company. Use ONLY when the user explicitly asks to add a new parent company AND no similar name exists in the directory. Approval-required to guard against duplicates.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Company name (e.g., "Preferred Apartment Communities").' },
        company_name: { type: 'string', description: 'Optional formal company name; defaults to name if omitted.' },
        notes: { type: 'string', description: 'Why this is a separate parent rather than reusing an existing one.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card.' }
      },
      required: ['name', 'rationale']
    }
  },
  {
    name: 'update_client_field',
    tier: 'auto',
    description: 'Update one or more editable fields on an existing client (typo fix, fill missing email/phone, etc.). Cannot change name or parent_client_id — use rename_client or change_property_parent for those.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        fields: {
          type: 'object',
          description: 'Object of field-name → new-value pairs. Allowed fields: salutation, first_name, last_name, email, phone, cell, address, city, state, zip, company_name, community_name, market, property_address, property_phone, website, gate_code, additional_pocs, community_manager, cm_email, cm_phone, maintenance_manager, mm_email, mm_phone, notes, client_type, activation_status.'
        }
      },
      required: ['client_id', 'fields']
    }
  },
  {
    name: 'link_property_to_parent',
    tier: 'auto',
    description: 'Set or change the parent_client_id of a client when the parent already exists. Used to slot a flat client under an existing parent management company. If the property already has a different parent, this is restructural — DO NOT use this; use change_property_parent instead.',
    input_schema: {
      type: 'object',
      properties: {
        property_client_id: { type: 'string' },
        parent_client_id: { type: 'string' }
      },
      required: ['property_client_id', 'parent_client_id']
    }
  },
  {
    name: 'rename_client',
    tier: 'approval',
    description: 'Rename an existing client. Approval-required because rename can affect linked leads/estimates display.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        new_name: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['client_id', 'new_name', 'rationale']
    }
  },
  {
    name: 'change_property_parent',
    tier: 'approval',
    description: "Change a property's parent to a different parent company. Restructural — always requires approval.",
    input_schema: {
      type: 'object',
      properties: {
        property_client_id: { type: 'string' },
        new_parent_client_id: { type: 'string', description: 'Pass empty string or null to detach (make it a top-level entry).' },
        rationale: { type: 'string' }
      },
      required: ['property_client_id', 'rationale']
    }
  },
  {
    name: 'merge_clients',
    tier: 'approval',
    description: "Merge two duplicate clients. The 'keep' client is the survivor; data from 'merge_from' is folded into it (only filling empty fields, never overwriting), then merge_from is deleted. Any properties parented to merge_from get reparented to keep.",
    input_schema: {
      type: 'object',
      properties: {
        keep_client_id: { type: 'string' },
        merge_from_client_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['keep_client_id', 'merge_from_client_id', 'rationale']
    }
  },
  {
    name: 'split_client_into_parent_and_property',
    tier: 'approval',
    description: 'Take a single flat client whose name encodes both a parent and a property (e.g., "PAC - Solace Tampa") and split it into a parent company + a property under it. The original client is converted into the property; a new parent is created (or an existing parent is reused if its name matches).',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        new_parent_name: { type: 'string', description: 'The parent company portion (e.g., "Preferred Apartment Communities").' },
        new_property_name: { type: 'string', description: 'The property portion (e.g., "Solace Tampa").' },
        existing_parent_id: { type: 'string', description: 'Optional — if a matching parent already exists, pass its ID here instead of creating a new one.' },
        rationale: { type: 'string' }
      },
      required: ['client_id', 'new_parent_name', 'new_property_name', 'rationale']
    }
  },
  {
    name: 'delete_client',
    tier: 'approval',
    description: 'Delete a client. Children get detached (parent_client_id set NULL on their rows). Always requires approval.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['client_id', 'rationale']
    }
  },
  {
    name: 'attach_business_card_to_client',
    tier: 'approval',
    description: 'Attach the most recent business card / photo the user uploaded in this conversation to a specific client. Use this AFTER you have read the card, identified which client it belongs to, and proposed any update_client_field changes — the photo gets stored under that client\'s attachments. Approval-required so the user confirms the right client was matched. The image is consumed from the pending bucket; only call once per uploaded card.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string' },
        caption: { type: 'string', description: 'Short label, e.g., "Business card — Jane Smith, CAM at Solace Tampa".' },
        image_index: { type: 'number', description: 'Optional. 1 = most recent image (default), 2 = the one before that, etc. Use only if the user uploaded multiple cards in one turn.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this card belongs on this client.' }
      },
      required: ['client_id', 'rationale']
    }
  },
  {
    name: 'add_client_note',
    tier: 'approval',
    description: 'Append a short, durable fact about how to handle this client to their agent notes. These notes auto-inject into AG (estimating) and HR (this — customer relations) system prompts on every future turn that touches the client, so they compound knowledge across sessions. Good notes: "PAC always wants 15% materials markup, not 20%", "Wimbledon Greens proposals must include the gate code on the cover page", "FSR billing prefers a single combined invoice per property — don\'t split by group", "Solace Tampa has a strict noise window (8a-5p) — note it in scope". Bad notes: anything ephemeral ("user is on PTO this week"), anything personal, anything that would already be obvious from the client record. Approval-required so the user vets the wording before it lands. Cap one note per call — call multiple times in parallel for multiple notes.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client to attach the note to.' },
        body: { type: 'string', description: 'The note itself, ≤ 2000 chars. Should read as a standalone instruction or fact — full sentence, ends with a period.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this note is worth keeping.' }
      },
      required: ['client_id', 'body', 'rationale']
    }
  }
];

const CLIENT_EDITABLE_FIELDS = new Set([
  'salutation', 'first_name', 'last_name', 'email', 'phone', 'cell',
  'address', 'city', 'state', 'zip',
  'company_name', 'community_name', 'market',
  'property_address', 'property_phone', 'website', 'gate_code', 'additional_pocs',
  'community_manager', 'cm_email', 'cm_phone',
  'maintenance_manager', 'mm_email', 'mm_phone',
  'notes', 'client_type', 'activation_status'
]);

// ──────────────────────────────────────────────────────────────────
// Tool executors. Each returns a short human-readable summary string
// that gets fed back to the model as the tool_result content AND
// surfaced to the UI as the "applied" chip text. Throws on error;
// the chat loop turns the error into a tool_result with `is_error: true`
// so the model can recover (apologize / try a different tool).
// ──────────────────────────────────────────────────────────────────
async function execClientTool(name, input) {
  switch (name) {
    case 'create_property': {
      if (!input.name || !input.parent_client_id) throw new Error('name and parent_client_id are required');
      const parent = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.parent_client_id]);
      if (!parent.rows.length) throw new Error('parent_client_id not found');
      const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const cols = ['id', 'parent_client_id', 'name', 'client_type'];
      const vals = [id, input.parent_client_id, input.name, 'Property'];
      for (const k of ['community_name', 'property_address', 'city', 'state', 'zip', 'community_manager', 'cm_email', 'cm_phone', 'market']) {
        if (input[k]) { cols.push(k); vals.push(input[k]); }
      }
      const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
      await pool.query(`INSERT INTO clients (${cols.join(', ')}) VALUES (${placeholders})`, vals);
      return `Created property "${input.name}" under "${parent.rows[0].name}" (id=${id}).`;
    }
    case 'create_parent_company': {
      if (!input.name) throw new Error('name is required');
      const id = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO clients (id, name, company_name, client_type, notes)
         VALUES ($1, $2, $3, 'Property Mgmt', $4)`,
        [id, input.name, input.company_name || input.name, input.notes || null]
      );
      return `Created parent company "${input.name}" (id=${id}).`;
    }
    case 'update_client_field': {
      if (!input.client_id || !input.fields || typeof input.fields !== 'object') throw new Error('client_id and fields are required');
      const exists = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.client_id]);
      if (!exists.rows.length) throw new Error('client_id not found');
      const sets = [];
      const params = [];
      let p = 1;
      for (const [k, v] of Object.entries(input.fields)) {
        if (!CLIENT_EDITABLE_FIELDS.has(k)) continue;
        sets.push(k + ' = $' + p++);
        params.push(v);
      }
      if (!sets.length) return `No editable fields supplied for ${exists.rows[0].name}.`;
      sets.push('updated_at = NOW()');
      params.push(input.client_id);
      await pool.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $${p}`, params);
      return `Updated ${Object.keys(input.fields).join(', ')} on ${exists.rows[0].name}.`;
    }
    case 'link_property_to_parent': {
      const child = await pool.query('SELECT id, name, parent_client_id FROM clients WHERE id = $1', [input.property_client_id]);
      if (!child.rows.length) throw new Error('property_client_id not found');
      if (child.rows[0].parent_client_id) throw new Error('Property already has a parent — use change_property_parent instead.');
      const parent = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.parent_client_id]);
      if (!parent.rows.length) throw new Error('parent_client_id not found');
      if (input.property_client_id === input.parent_client_id) throw new Error('A client cannot be its own parent.');
      await pool.query('UPDATE clients SET parent_client_id = $1, updated_at = NOW() WHERE id = $2', [input.parent_client_id, input.property_client_id]);
      return `Linked "${child.rows[0].name}" under "${parent.rows[0].name}".`;
    }
    case 'rename_client': {
      const r = await pool.query('SELECT name FROM clients WHERE id = $1', [input.client_id]);
      if (!r.rows.length) throw new Error('client_id not found');
      await pool.query('UPDATE clients SET name = $1, updated_at = NOW() WHERE id = $2', [input.new_name, input.client_id]);
      return `Renamed "${r.rows[0].name}" to "${input.new_name}".`;
    }
    case 'change_property_parent': {
      const child = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.property_client_id]);
      if (!child.rows.length) throw new Error('property_client_id not found');
      const newParentId = input.new_parent_client_id || null;
      if (newParentId) {
        if (newParentId === input.property_client_id) throw new Error('A client cannot be its own parent.');
        const p = await pool.query('SELECT id FROM clients WHERE id = $1', [newParentId]);
        if (!p.rows.length) throw new Error('new_parent_client_id not found');
      }
      await pool.query('UPDATE clients SET parent_client_id = $1, updated_at = NOW() WHERE id = $2', [newParentId, input.property_client_id]);
      return newParentId
        ? `Moved "${child.rows[0].name}" to a new parent.`
        : `Detached "${child.rows[0].name}" from its parent.`;
    }
    case 'merge_clients': {
      const keep = await pool.query('SELECT * FROM clients WHERE id = $1', [input.keep_client_id]);
      const from = await pool.query('SELECT * FROM clients WHERE id = $1', [input.merge_from_client_id]);
      if (!keep.rows.length) throw new Error('keep_client_id not found');
      if (!from.rows.length) throw new Error('merge_from_client_id not found');
      if (input.keep_client_id === input.merge_from_client_id) throw new Error('keep and merge_from are the same client.');
      const k = keep.rows[0];
      const f = from.rows[0];
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        // Fold: only fill blanks on keep from from
        const sets = [];
        const params = [];
        let p = 1;
        for (const col of CLIENT_EDITABLE_FIELDS) {
          if ((k[col] === null || k[col] === '') && f[col]) {
            sets.push(col + ' = $' + p++);
            params.push(f[col]);
          }
        }
        if (sets.length) {
          sets.push('updated_at = NOW()');
          params.push(input.keep_client_id);
          await cli.query(`UPDATE clients SET ${sets.join(', ')} WHERE id = $${p}`, params);
        }
        // Reparent any children of merge_from to keep
        await cli.query('UPDATE clients SET parent_client_id = $1 WHERE parent_client_id = $2', [input.keep_client_id, input.merge_from_client_id]);
        // Move leads/estimates that pointed at merge_from to keep (estimates store client_id in JSONB; skip for now)
        await cli.query('UPDATE leads SET client_id = $1 WHERE client_id = $2', [input.keep_client_id, input.merge_from_client_id]);
        await cli.query('DELETE FROM clients WHERE id = $1', [input.merge_from_client_id]);
        await cli.query('COMMIT');
      } catch (e) {
        await cli.query('ROLLBACK');
        throw e;
      } finally {
        cli.release();
      }
      return `Merged "${f.name}" into "${k.name}".`;
    }
    case 'split_client_into_parent_and_property': {
      const orig = await pool.query('SELECT * FROM clients WHERE id = $1', [input.client_id]);
      if (!orig.rows.length) throw new Error('client_id not found');
      const cli = await pool.connect();
      try {
        await cli.query('BEGIN');
        let parentId = input.existing_parent_id;
        if (parentId) {
          const p = await cli.query('SELECT id FROM clients WHERE id = $1', [parentId]);
          if (!p.rows.length) throw new Error('existing_parent_id not found');
        } else {
          parentId = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await cli.query(
            `INSERT INTO clients (id, name, company_name, client_type)
             VALUES ($1, $2, $2, 'Property Mgmt')`,
            [parentId, input.new_parent_name]
          );
        }
        await cli.query(
          `UPDATE clients SET name = $1, parent_client_id = $2, client_type = COALESCE(client_type, 'Property'), updated_at = NOW()
           WHERE id = $3`,
          [input.new_property_name, parentId, input.client_id]
        );
        await cli.query('COMMIT');
      } catch (e) {
        await cli.query('ROLLBACK');
        throw e;
      } finally {
        cli.release();
      }
      return `Split "${orig.rows[0].name}" → parent "${input.new_parent_name}" + property "${input.new_property_name}".`;
    }
    case 'delete_client': {
      const r = await pool.query('SELECT name FROM clients WHERE id = $1', [input.client_id]);
      if (!r.rows.length) throw new Error('client_id not found');
      await pool.query('DELETE FROM clients WHERE id = $1', [input.client_id]);
      return `Deleted "${r.rows[0].name}".`;
    }
    case 'attach_business_card_to_client': {
      // Note: the userId is needed to find the right pending bucket.
      // We pass it via execClientTool's options arg (added below).
      throw new Error('attach_business_card_to_client must be invoked via execClientToolWithCtx');
    }
    case 'add_client_note': {
      // Like the business-card tool, this needs userId for audit trail
      // (created_by_user_id). Routed through execClientToolWithCtx.
      throw new Error('add_client_note must be invoked via execClientToolWithCtx');
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// Wrapper that adds context (userId, storage) for tools that need it
// (attach_business_card_to_client, add_client_note). Falls through to
// the stateless executor for everything else.
async function execClientToolWithCtx(name, input, ctx) {
  if (name === 'add_client_note') {
    if (!input.client_id || !input.body) throw new Error('client_id and body are required');
    const body = String(input.body).trim();
    if (!body) throw new Error('body is empty');
    if (body.length > 2000) throw new Error('note body cannot exceed 2000 chars');
    const exists = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.client_id]);
    if (!exists.rows.length) throw new Error('client_id not found');
    const note = {
      id: 'note_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      body,
      created_at: new Date().toISOString(),
      created_by_user_id: (ctx && ctx.userId) || null,
      source_agent: 'cra'
    };
    await pool.query(
      `UPDATE clients
         SET agent_notes = COALESCE(agent_notes, '[]'::jsonb) || $1::jsonb,
             updated_at = NOW()
       WHERE id = $2`,
      [JSON.stringify([note]), input.client_id]
    );
    return `Added note to "${exists.rows[0].name}": "${body.slice(0, 80)}${body.length > 80 ? '…' : ''}".`;
  }
  if (name !== 'attach_business_card_to_client') {
    return execClientTool(name, input);
  }
  const userId = ctx && ctx.userId;
  if (!userId) throw new Error('userId required for attach_business_card_to_client');
  const exists = await pool.query('SELECT id, name FROM clients WHERE id = $1', [input.client_id]);
  if (!exists.rows.length) throw new Error('client_id not found');
  const picked = consumePendingClientImage(userId, input.image_index);
  if (!picked) throw new Error('No pending business-card image found. The user may have uploaded then sent it more than 30 minutes ago, or the image was already attached.');
  // Persist via the storage adapter + attachments table, mirroring the
  // attachment-routes upload flow.
  const buf = Buffer.from(picked.b64, 'base64');
  const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const baseKey = 'client/' + input.client_id + '/' + id;
  let thumbKey = null, webKey = null, originalKey = null;
  let thumbUrl = null, webUrl = null, originalUrl = null;
  let width = null, height = null;
  try {
    // Use sharp pipeline if available — same as attachment-routes.
    const sharp = require('sharp');
    const meta = await sharp(buf).metadata();
    width = meta.width || null;
    height = meta.height || null;
    const thumbBuf = await sharp(buf).rotate().resize(200, 200, { fit: 'cover' }).jpeg({ quality: 80 }).toBuffer();
    const webBuf   = await sharp(buf).rotate().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 85 }).toBuffer();
    thumbKey    = baseKey + '_thumb.jpg';
    webKey      = baseKey + '_web.jpg';
    originalKey = baseKey + '_orig.jpg';
    thumbUrl    = await storage.put(thumbKey, thumbBuf, 'image/jpeg');
    webUrl      = await storage.put(webKey,   webBuf,   'image/jpeg');
    originalUrl = await storage.put(originalKey, buf, picked.mime || 'image/jpeg');
  } catch (e) {
    // sharp not available or pipeline failed — fall back to original-only.
    originalKey = baseKey + '_orig.jpg';
    originalUrl = await storage.put(originalKey, buf, picked.mime || 'image/jpeg');
  }
  await pool.query(
    `INSERT INTO attachments
       (id, entity_type, entity_id, filename, mime_type, size_bytes,
        width, height, thumb_url, web_url, original_url,
        thumb_key, web_key, original_key, caption, position, uploaded_by)
     VALUES ($1, 'client', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, 0, $15)`,
    [id, input.client_id,
     (input.caption || 'Business card').slice(0, 80) + '.jpg',
     picked.mime || 'image/jpeg', buf.length,
     width, height,
     thumbUrl, webUrl, originalUrl,
     thumbKey, webKey, originalKey,
     input.caption || null,
     userId]
  );
  return `Attached business card to "${exists.rows[0].name}".`;
}

function isClientToolAutoTier(name) {
  const t = CLIENT_TOOLS.find(t => t.name === name);
  return !!(t && t.tier === 'auto');
}

// Build the directory snapshot Claude reads as context. Capped per
// parent so a huge directory doesn't blow the prompt window.
async function buildClientDirectoryContext() {
  const { rows } = await pool.query(
    `SELECT id, name, parent_client_id, client_type, company_name, community_name,
            community_manager, cm_email, cm_phone, market, property_address,
            city, state, zip, email, phone, agent_notes
     FROM clients ORDER BY COALESCE(parent_client_id, id), name`
  );
  const byId = new Map(rows.map(r => [r.id, r]));
  const parents = rows.filter(r => !r.parent_client_id);
  const childrenByParent = new Map();
  for (const r of rows) {
    if (r.parent_client_id) {
      if (!childrenByParent.has(r.parent_client_id)) childrenByParent.set(r.parent_client_id, []);
      childrenByParent.get(r.parent_client_id).push(r);
    }
  }
  const flatTopLevel = parents.filter(p => !childrenByParent.has(p.id));

  // Build CRA's prompt as two blocks like AG: stable playbook (cached
  // prefix) + dynamic directory snapshot (refreshed each turn).
  const stable = [];
  const out = []; // dynamic directory snapshot
  stable.push('You are HR, AGX\'s customer relations agent — the dedicated assistant for keeping AG Exteriors\' customer directory clean, accurate, and properly structured. You understand the property-management industry in Central Florida and you take pride in a tidy, hierarchical, dedupe-clean directory. (Yes, "HR" — your name is a small AGX inside joke; the role is customer relations, not human resources.)');
  stable.push('');
  stable.push('# About AGX');
  stable.push('AG Exteriors is a Central-Florida construction-services company (painting, deck repair, roofing, exterior services). AGX\'s customers are overwhelmingly:');
  stable.push('  1. Property-management companies running multifamily/apartment portfolios');
  stable.push('  2. HOA / condo associations (often managed BY one of those property-management firms)');
  stable.push('Geographic markets: Tampa, Orlando, Sarasota/Bradenton, Brevard (Space Coast), Lakeland, The Villages.');
  stable.push('');
  stable.push('# The hierarchy model — CRITICAL');
  stable.push('The directory has TWO and only two levels:');
  stable.push('  • Parent management company (top-level, no parent_client_id) — the corporate billing entity.');
  stable.push('     Examples: "Preferred Apartment Communities" (PAC), "Associa", "FirstService Residential" (FSR),');
  stable.push('     "Greystar", "RangeWater Real Estate", "Bainbridge", "Lincoln Property Company", "Camden",');
  stable.push('     "ZRS Management", "Cushman & Wakefield", "RPM Living", "BH Management", "Pinnacle".');
  stable.push('     Holds: corporate mailing address, billing contact, AP email.');
  stable.push('  • Property / community (parent_client_id set to a parent above) — the physical site we do work at.');
  stable.push('     Examples: "Solace Tampa", "City Lakes", "Wimbledon Greens HOA", "Saddlebrook".');
  stable.push('     Holds: property_address (the site), on-site CAM, on-site maintenance manager, gate code, market.');
  stable.push('A row is EITHER a parent OR a property — never both. If a row carries both kinds of data, it needs split_client_into_parent_and_property.');
  stable.push('');
  stable.push('# Field semantics');
  stable.push('  • name              → display name (parent company name OR property name)');
  stable.push('  • company_name      → on properties: the parent\'s name (informational; parent_client_id is the real link)');
  stable.push('  • community_name    → formal community name (often same as name on properties; blank on parents)');
  stable.push('  • address/city/state/zip → mailing/billing address (parent\'s corporate office OR property\'s billing-to)');
  stable.push('  • property_address  → PHYSICAL site address — properties only, never parents');
  stable.push('  • community_manager (CAM) + cm_email + cm_phone → on-site site manager — properties only');
  stable.push('  • maintenance_manager + mm_email + mm_phone     → on-site maintenance lead — properties only');
  stable.push('  • market            → submarket label (Tampa, Orlando, Sarasota, Brevard, Lakeland)');
  stable.push('  • salutation        → how proposal letters greet them ("PAC Team", "Wimbledon Greens HOA Board", "Jane")');
  stable.push('  • client_type       → "Property Mgmt" for parents, "Property" for properties');
  stable.push('');
  stable.push('# Buildertrend import patterns to recognize');
  stable.push('AGX imports clients from Buildertrend exports. Common name patterns that REVEAL parent+property structure:');
  stable.push('  • "PAC - Solace Tampa"           → parent "Preferred Apartment Communities", property "Solace Tampa"');
  stable.push('  • "Associa | Wimbledon Greens"   → parent "Associa", property "Wimbledon Greens"');
  stable.push('  • "FSR — City Lakes"             → parent "FirstService Residential", property "City Lakes"');
  stable.push('  • "Greystar / The Reserve"       → parent "Greystar", property "The Reserve"');
  stable.push('Separators that signal a split: " - ", " – ", " — ", " | ", " / ", "::". A separator + a known abbreviation on the left = always a parent+property pair.');
  stable.push('Common abbreviations: PAC=Preferred Apartment Communities, FSR=FirstService Residential, RPM=RPM Living, LPC=Lincoln Property Company, C&W=Cushman & Wakefield.');
  stable.push('');
  stable.push('# Duplicate-detection rules');
  stable.push('Treat as the same client (propose merge) when ANY of these match:');
  stable.push('  • Same email on community_manager AND it is a property-level email (not a generic billing@ inbox)');
  stable.push('  • Same property_address (street + city)');
  stable.push('  • Same phone number after normalizing formatting (strip parens/dashes/spaces)');
  stable.push('  • Names differ only by: case, leading/trailing whitespace, "Inc"/"LLC"/"LLC."/"L.L.C.", "Inc." vs "Incorporated", trailing "HOA" / "Owners Association" / "Condo Assoc.", curly vs straight apostrophe, em-dash vs hyphen, &amp; vs "and"');
  stable.push('  • Names where one is an abbreviation expansion of the other (PAC ↔ Preferred Apartment Communities)');
  stable.push('When you see a parent name with multiple spelling variants across the directory, rename them to the canonical form (the most common / formal version).');
  stable.push('');
  stable.push('# Behavior rules');
  stable.push('  • Prefer linking a new property under an EXISTING parent over creating a new parent. Always scan the directory below for a fuzzy parent match BEFORE calling create_parent_company.');
  stable.push('  • Be efficient. Chain auto-tier tools (create_property, link_property_to_parent, update_client_field) in batches with no preamble. The system applies them in order; results stream back as ✓ chips.');
  stable.push('  • Group related approval-tier changes in ONE batch so the user can approve in bulk via the bulk-approve button.');
  stable.push('  • When you spot a property whose stored company_name points at an EXISTING parent in the directory, you do not need to ask — link it via link_property_to_parent (auto-tier).');
  stable.push('  • When you spot a flat client whose name is a clear parent+property compound, propose split_client_into_parent_and_property. If the parent already exists, pass existing_parent_id so we reuse instead of duplicating.');
  stable.push('  • When merging duplicates, ALWAYS pick the row with more populated fields as keep_client_id and fold the sparser row in.');
  stable.push('  • After a batch of changes, give the user a one-line summary in plain text. Skip narration — they want results, not commentary.');
  stable.push('  • If asked to "run a full audit": work the directory in this order — (1) split obvious parent+property compounds, (2) link unparented children to existing parents, (3) merge clear duplicates, (4) flag (in chat, no tool call) the rest as ambiguous for the user to decide on.');
  stable.push('');
  stable.push('# Web research (web_search tool)');
  stable.push('You have a web_search tool. The HR role is the highest-value place to use it — Central-FL property management is constantly reorganizing, and the directory often has stale or ambiguous data. Good reasons to search:');
  stable.push('  • Confirm a parent-company / property relationship before linking (e.g., "Is Solace Tampa managed by PAC or by Bainbridge?" — search the property name + "managed by").');
  stable.push('  • Find the current canonical name for a parent company before renaming variants (e.g., "Preferred Apartment Communities" merged with another entity — look up the current corporate name).');
  stable.push('  • Look up a property\'s physical address when only the community name is known and we need to populate property_address.');
  stable.push('  • Find a property\'s on-site CAM or maintenance manager from a public LinkedIn / management-company website / apartments.com listing when we have a name but no email/phone.');
  stable.push('  • Resolve abbreviation ambiguity — "RPM" could be RPM Living OR a regional smaller firm. Search before guessing.');
  stable.push('Cap at ~3 searches per turn. When a search result drives a propose_* call, include a brief source citation in the rationale shown on the approval card so the user can audit.');
  stable.push('');
  stable.push('# Tool tiers — system handles the gating, you just call');
  stable.push('  AUTO (applies immediately, model continues in same turn):');
  stable.push('    create_property, update_client_field, link_property_to_parent');
  stable.push('  APPROVAL (user clicks Approve/Reject before applying):');
  stable.push('    create_parent_company, rename_client, change_property_parent,');
  stable.push('    merge_clients, split_client_into_parent_and_property, delete_client,');
  stable.push('    attach_business_card_to_client');
  stable.push('');
  stable.push('# Photos / business cards');
  stable.push('When the user uploads a photo (visible to you in this turn as an inline image):');
  stable.push('  1. READ it. If it\'s a business card, extract: name, title, company, email, phone, address.');
  stable.push('  2. MATCH to an existing client. Compare the extracted name/email/phone/company against the directory below. If the company on the card matches a parent management company and the title implies the cardholder is a CAM/manager at a property, look for that property under the parent. If the property does not exist yet, propose create_property.');
  stable.push('  3. UPDATE missing fields on the matched client (community_manager / cm_email / cm_phone / first_name / last_name / etc.) via update_client_field — auto-tier, just call.');
  stable.push('  4. PROPOSE attach_business_card_to_client to save the photo to that client\'s attachments. Include a caption like "Business card — Jane Smith, CAM at Solace Tampa". Approval-tier — user confirms the match.');
  stable.push('Only call attach_business_card_to_client ONCE per uploaded card — the image is consumed from the pending bucket.');
  stable.push('');

  // Skill packs targeted at HR (customer relations). Same loader as
  // AG — admin-editable additions to the baseline prompt. Stable across
  // the cache window since admins rarely edit them mid-session.
  const craSkills = await loadActiveSkillsFor('cra');
  if (craSkills.length) {
    stable.push('# Loaded skills');
    stable.push('Skill packs your admin has assigned. Treat each as binding additional guidance.');
    stable.push('');
    craSkills.forEach(s => {
      stable.push('## ' + s.name);
      stable.push(s.body);
      stable.push('');
    });
  }

  out.push('# Directory snapshot (' + rows.length + ' clients)');
  out.push('');

  // Pre-existing agent notes — short list of every client that has at
  // least one note, with their notes inline. Lets CRA reference them
  // when proposing changes ("PAC has a 15% materials note from AG, do
  // you want me to copy that to the new sub-property?").
  const withNotes = rows.filter(r => Array.isArray(r.agent_notes) && r.agent_notes.length);
  if (withNotes.length) {
    out.push('## Clients with agent notes (' + withNotes.length + ')');
    out.push('Durable hand-curated facts. Treat as binding when working with these clients. Reference by client id when proposing related changes.');
    for (const r of withNotes) {
      out.push(`- **${r.name}** (id=${r.id})`);
      r.agent_notes.forEach(function(n, i) {
        const src = n.source_agent ? ' [' + n.source_agent + ']' : '';
        out.push(`    ${i + 1}. ${n.body || ''}${src}`);
      });
    }
    out.push('');
  }

  out.push('## Parent companies with properties:');
  for (const p of parents) {
    const kids = childrenByParent.get(p.id);
    if (!kids || !kids.length) continue;
    out.push(`- **${p.name}** (id=${p.id})${p.market ? ' — ' + p.market : ''}`);
    for (const k of kids) {
      const bits = [];
      if (k.community_manager) bits.push('CAM: ' + k.community_manager);
      if (k.market) bits.push(k.market);
      if (k.city) bits.push(k.city + (k.state ? ', ' + k.state : ''));
      out.push(`  - ${k.name} (id=${k.id})${bits.length ? ' — ' + bits.join(' · ') : ''}`);
    }
  }
  if (flatTopLevel.length) {
    out.push('');
    out.push('## Flat / unparented entries (potential candidates to organize):');
    for (const f of flatTopLevel) {
      const bits = [];
      if (f.company_name && f.company_name !== f.name) bits.push('company_name=' + f.company_name);
      if (f.community_name && f.community_name !== f.name) bits.push('community=' + f.community_name);
      if (f.community_manager) bits.push('CAM: ' + f.community_manager);
      if (f.city) bits.push(f.city + (f.state ? ', ' + f.state : ''));
      out.push(`- ${f.name} (id=${f.id})${bits.length ? ' — ' + bits.join(' · ') : ''}`);
    }
  }
  return {
    system: [
      { type: 'text', text: stable.join('\n'), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n' + out.join('\n') }
    ],
    totalClients: rows.length
  };
}

// Persist a final assistant text response on the client thread.
async function saveClientAssistantMessage({ userId, text, usage }) {
  const id = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
     VALUES ($1, 'client', 'global', $2, 'assistant', $3, $4, $5, $6)`,
    [id, userId, text, MODEL, usage.input_tokens, usage.output_tokens]
  );
}

// One streaming step against Anthropic. Returns a structured turn outcome
// the loop can branch on: assistant text, tool_use blocks (split by tier),
// final assistant content for echo-on-continue, and usage.
async function streamClientTurn({ anthropic, res, system, messages }) {
  let assistantText = '';
  let finalContent = null;
  let usage = { input_tokens: null, output_tokens: null };
  // Strip our local `tier` field before sending; cache the whole tools
  // block by marking the last entry.
  const cleanTools = CLIENT_TOOLS.map(({ tier, ...t }) => t);
  // Web tools sit at the FRONT so the cache_control breakpoint stays on
  // the last user-defined tool (covers system + WEB_TOOLS + CLIENT_TOOLS
  // in the cached prefix).
  const allClientTools = [...WEB_TOOLS, ...cleanTools];
  const cachedClientTools = allClientTools.length
    ? [
        ...allClientTools.slice(0, -1),
        Object.assign({}, allClientTools[allClientTools.length - 1], { cache_control: { type: 'ephemeral' } })
      ]
    : allClientTools;
  const _effortC = effortClause();
  const stream = anthropic.messages.stream(Object.assign({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: system,
    tools: cachedClientTools,
    messages
  }, _effortC ? { output_config: _effortC } : {}));
  stream.on('text', (delta) => {
    assistantText += delta;
    res.write('data: ' + JSON.stringify({ delta }) + '\n\n');
  });
  stream.on('finalMessage', (msg) => {
    if (msg && msg.usage) usage = msg.usage;
    if (msg && Array.isArray(msg.content)) finalContent = msg.content;
  });
  await stream.done();

  const toolUseBlocks = (finalContent || []).filter(b => b.type === 'tool_use');
  return { assistantText, finalContent, toolUseBlocks, usage };
}

router.get('/clients/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      const { rows } = await pool.query(
        `SELECT id, role, content, created_at FROM ai_messages
         WHERE entity_type='client' AND user_id=$1
         ORDER BY created_at ASC`,
        [req.user.id]
      );
      res.json({ messages: rows });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);
router.delete('/clients/messages',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    try {
      await pool.query(`DELETE FROM ai_messages WHERE entity_type='client' AND user_id=$1`, [req.user.id]);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  }
);

// Client chat endpoint. Loops server-side: stream → if auto-tier tools,
// execute and continue; if approval-tier, stop and emit awaiting_approval.
const MAX_CLIENT_TOOL_LOOPS = 6;
router.post('/clients/chat',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    // Inline images (composer uploads, business cards, etc.). Client mode
    // has no entity_id, so these aren't persisted to attachments yet —
    // we stash them in a per-user pending bucket so the
    // attach_business_card_to_client tool can persist on demand once the
    // agent identifies the right client.
    const additionalImages = Array.isArray(req.body && req.body.additional_images)
      ? req.body.additional_images.slice(0, 12)
      : [];
    if (additionalImages.length) {
      stashPendingClientImages(req.user.id, additionalImages);
    }

    setSSEHeaders(res);
    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
         WHERE entity_type='client' AND user_id=$1
         ORDER BY created_at ASC`,
        [req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'client', 'global', $2, 'user', $3)`,
        [userMsgId, req.user.id, userMessage]
      );

      // Build user message content — text + any inline images (one-shot
      // vision). The agent reads the business card / photo this turn.
      const userContent = additionalImages.length
        ? [
            ...additionalImages
              .map(b64 => inlineImageBlock(b64))
              .filter(Boolean),
            { type: 'text', text: userMessage }
          ]
        : userMessage;

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userContent }
      ];

      let totalUsage = { input_tokens: 0, output_tokens: 0 };
      let finalAssistantText = '';

      for (let loop = 0; loop < MAX_CLIENT_TOOL_LOOPS; loop++) {
        // Refresh directory context each loop iteration so the model sees
        // changes from the auto-tier tools it just ran.
        const ctx = await buildClientDirectoryContext();
        const turn = await streamClientTurn({
          anthropic, res,
          system: ctx.system,
          messages
        });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;

        if (!turn.toolUseBlocks.length) {
          // No more tool use — done.
          if (finalAssistantText) {
            await saveClientAssistantMessage({ userId: req.user.id, text: finalAssistantText, usage: totalUsage });
          }
          res.write('data: ' + JSON.stringify({ done: true, usage: totalUsage }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Partition the tool blocks by tier.
        const autoBlocks = turn.toolUseBlocks.filter(b => isClientToolAutoTier(b.name));
        const approvalBlocks = turn.toolUseBlocks.filter(b => !isClientToolAutoTier(b.name));

        if (approvalBlocks.length) {
          // Mixed or all-approval — stop here and let the user decide.
          // If there are also auto-tier blocks in the SAME turn, we treat
          // them ALL as approval-required so the user sees the full plan.
          for (const tu of turn.toolUseBlocks) {
            res.write('data: ' + JSON.stringify({ tool_use: { id: tu.id, name: tu.name, input: tu.input, tier: isClientToolAutoTier(tu.name) ? 'auto' : 'approval' } }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({
            awaiting_approval: true,
            pending_assistant_content: turn.finalContent,
            tool_use_count: turn.toolUseBlocks.length,
            usage: totalUsage
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // All auto. Execute each, send tool_applied event, append tool_result, loop.
        const toolResultBlocks = [];
        for (const tu of autoBlocks) {
          let summary, isError = false;
          try {
            summary = await execClientToolWithCtx(tu.name, tu.input || {}, { userId: req.user.id });
            res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
          }
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: summary, is_error: isError || undefined });
        }
        messages.push({ role: 'assistant', content: turn.finalContent });
        messages.push({ role: 'user', content: toolResultBlocks });
        // loop continues with updated messages
      }
      // Hit loop cap without resolving
      res.write('data: ' + JSON.stringify({ error: 'Tool loop exceeded maximum iterations' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('AI client chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// Continuation after user approves/rejects. Runs the same multi-step
// loop as /chat so further auto-tier tools can chain off the approved
// ones without another round-trip.
router.post('/clients/chat/continue',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    const pendingContent = req.body && req.body.pending_assistant_content;
    const decisions = req.body && req.body.tool_results;
    if (!Array.isArray(pendingContent) || !Array.isArray(decisions) || !decisions.length) {
      return res.status(400).json({ error: 'pending_assistant_content and tool_results required' });
    }
    setSSEHeaders(res);
    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
         WHERE entity_type='client' AND user_id=$1
         ORDER BY created_at ASC`,
        [req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      // Execute approved tools server-side (the client just sends approval
      // booleans; we never trust the client to apply changes). Build the
      // tool_result blocks the API expects.
      const pendingToolUseById = new Map();
      for (const block of pendingContent) {
        if (block && block.type === 'tool_use') pendingToolUseById.set(block.id, block);
      }
      const toolResultBlocks = [];
      for (const d of decisions) {
        const tu = pendingToolUseById.get(d.tool_use_id);
        let summary, isError = false;
        if (!tu) {
          summary = 'Error: tool_use not found in pending content.';
          isError = true;
        } else if (!d.approved) {
          summary = d.reject_reason || 'User rejected this proposal.';
          res.write('data: ' + JSON.stringify({ tool_rejected: { id: tu.id, name: tu.name } }) + '\n\n');
        } else {
          try {
            summary = await execClientToolWithCtx(tu.name, tu.input || {}, { userId: req.user.id });
            res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
          }
        }
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: d.tool_use_id, content: summary, is_error: isError || undefined });
      }

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'assistant', content: pendingContent },
        { role: 'user', content: toolResultBlocks }
      ];

      let totalUsage = { input_tokens: 0, output_tokens: 0 };
      let finalAssistantText = '';
      for (let loop = 0; loop < MAX_CLIENT_TOOL_LOOPS; loop++) {
        const ctx = await buildClientDirectoryContext();
        const turn = await streamClientTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;

        if (!turn.toolUseBlocks.length) {
          if (finalAssistantText) {
            await saveClientAssistantMessage({ userId: req.user.id, text: finalAssistantText, usage: totalUsage });
          }
          res.write('data: ' + JSON.stringify({ done: true, usage: totalUsage }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const autoBlocks = turn.toolUseBlocks.filter(b => isClientToolAutoTier(b.name));
        const approvalBlocks = turn.toolUseBlocks.filter(b => !isClientToolAutoTier(b.name));
        if (approvalBlocks.length) {
          for (const tu of turn.toolUseBlocks) {
            res.write('data: ' + JSON.stringify({ tool_use: { id: tu.id, name: tu.name, input: tu.input, tier: isClientToolAutoTier(tu.name) ? 'auto' : 'approval' } }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({
            awaiting_approval: true,
            pending_assistant_content: turn.finalContent,
            tool_use_count: turn.toolUseBlocks.length,
            usage: totalUsage
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const inner = [];
        for (const tu of autoBlocks) {
          let summary, isError = false;
          try {
            summary = await execClientToolWithCtx(tu.name, tu.input || {}, { userId: req.user.id });
            res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
          }
          inner.push({ type: 'tool_result', tool_use_id: tu.id, content: summary, is_error: isError || undefined });
        }
        messages.push({ role: 'assistant', content: turn.finalContent });
        messages.push({ role: 'user', content: inner });
      }
      res.write('data: ' + JSON.stringify({ error: 'Tool loop exceeded maximum iterations' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('AI client chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// ══════════════════════════════════════════════════════════════════════
// Chief of Staff agent
// ══════════════════════════════════════════════════════════════════════
// A meta-agent that observes the three task agents (AG / WIP / CRA),
// reads their metrics + recent conversations, and (in later versions)
// proposes skill-pack improvements based on observed failure patterns
// or recurring user requests.
//
// V1 is read-only — only auto-tier read tools, no proposes. The user
// asks "how is AG doing this week?" or "what does CRA usually search
// for?" and the agent answers by calling read tools and synthesizing.
//
// Reuses the same ai_messages table for history, partitioned by
// entity_type='staff'. Like CRA, there's no entity_id — the agent is
// global, scoped per user. estimate_id stores the literal sentinel
// 'global'.
// ══════════════════════════════════════════════════════════════════════

const STAFF_TOOLS = [
  {
    name: 'read_metrics',
    tier: 'auto',
    description:
      'Read aggregate AI-agent usage metrics for the requested window. Returns per-agent (AG / Elle / HR) totals: turns, conversations, unique users, tool uses, photos attached, tokens in/out, model mix, and estimated cost in USD. Use this to answer "how much is AG being used?", "what does Elle cost us?", "is anyone using HR?" types of questions.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: ['7d', '30d'], description: 'Time window. Default 7d.' }
      },
      required: []
    }
  },
  {
    name: 'read_recent_conversations',
    tier: 'auto',
    description:
      'List recent AI-agent conversations. Each row is a (entity, user) pair with turn count, tool uses, tokens, cost, and last activity. Use this to spot patterns ("which estimates does AG get used on most?"), audit usage ("did anyone burn 100K tokens this week?"), or pick a conversation to drill into via read_conversation_detail.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: ['7d', '30d'], description: 'Time window. Default 7d.' },
        entity_type: { type: 'string', enum: ['estimate', 'job', 'client'], description: 'Filter to one agent. Omit for all.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap rows returned. Default 50.' }
      },
      required: []
    }
  },
  {
    name: 'read_conversation_detail',
    tier: 'auto',
    description:
      'Read every message of a specific conversation. Pass the `key` from read_recent_conversations (entity_type|entity_id|user_id, joined with pipes). Returns user + assistant turns with role, model, token usage, content (capped at 16KB per message). Use this to investigate a specific case — "show me what AG did on the Solace Tampa estimate", "find out why this conversation used so many tools".',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        key: { type: 'string', description: 'Conversation key from read_recent_conversations.' }
      },
      required: ['key']
    }
  },
  {
    name: 'read_skill_packs',
    tier: 'auto',
    description:
      'List the admin-editable skill packs that the AI agents load at chat time. Each pack has a name, body (instructions), agent assignments (which of AG / HR load it — internal key for HR is "cra" for back-compat), and an alwaysOn flag. Use this to recommend new skills, audit existing ones for staleness, or answer "what context does AG always see?".',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  {
    name: 'propose_skill_pack_add',
    tier: 'approval',
    description:
      'Propose creating a new admin-editable skill pack. Skill packs are reusable instruction blocks that get appended to an agent\'s system prompt every turn — perfect place to teach AGX-specific workflows, pricing rules, slotting preferences, and common-scope playbooks. Only call this AFTER you have read the existing packs (read_skill_packs) to confirm you are not creating a duplicate. Approval-required so the user vets the wording before it lands and starts shaping every future agent turn.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Short, unique title (e.g., "Trex decking spec reference"). Must not collide with an existing pack.' },
        body: { type: 'string', description: 'The skill content. Markdown allowed. Be tight — every always-on pack costs tokens on every turn.' },
        agents: { type: 'array', items: { type: 'string', enum: ['ag', 'cra', 'job'] }, description: 'Which agents load this pack. Use "ag" for AG (estimator), "cra" for HR (customer relations — key is "cra" for back-compat), "job" for Elle (WIP analyst).' },
        alwaysOn: { type: 'boolean', description: 'If true (default), pack is appended on every turn. If false, the pack is registered but inactive.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this pack is worth keeping.' }
      },
      required: ['name', 'body', 'agents', 'rationale']
    }
  },
  {
    name: 'propose_skill_pack_edit',
    tier: 'approval',
    description:
      'Propose editing an existing skill pack. Pass the exact name from read_skill_packs and only the fields you want to change. Body edits replace the entire body — pass the full new content, not a diff. Approval-required so the user vets every change to a prompt-shaping artifact.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Existing pack name (must match exactly).' },
        new_name: { type: 'string', description: 'Optional rename.' },
        new_body: { type: 'string', description: 'Optional replacement body. Pass the full new content.' },
        agents: { type: 'array', items: { type: 'string', enum: ['ag', 'cra', 'job'] }, description: 'Optional updated agent assignment. ag=AG, cra=HR (back-compat key), job=Elle.' },
        alwaysOn: { type: 'boolean', description: 'Optional updated alwaysOn flag.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining the change.' }
      },
      required: ['name', 'rationale']
    }
  },
  {
    name: 'propose_skill_pack_delete',
    tier: 'approval',
    description:
      'Propose removing a skill pack entirely. Only call this when the pack is genuinely stale or has been superseded — alwaysOn=false is usually a softer alternative. Approval-required since deletion is irreversible.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Existing pack name (must match exactly).' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why removal is the right call.' }
      },
      required: ['name', 'rationale']
    }
  }
];

function isStaffToolAutoTier(name) {
  const t = STAFF_TOOLS.find(t => t.name === name);
  return !!(t && t.tier === 'auto');
}

// Build the chief-of-staff system prompt. Stable identity + role +
// tools rolled into one cached block; a slim live snapshot of the
// current week as a second block (refreshed each turn).
async function buildStaffContext() {
  const stable = [];
  stable.push('You are the Chief of Staff for AGX\'s in-app AI agents — AG (estimating), Elle (WIP analyst), and HR (customer relations). Your user is the AGX admin / owner. Your job is to observe how the three agents are being used, surface trends and anomalies, audit specific conversations on request, and propose skill-pack improvements based on what you see.');
  stable.push('');
  stable.push('# Who the three agents are');
  stable.push('  • **AG (estimate-side)** — helps PMs draft scopes, propose line items with AGX-typical Central-FL pricing, and edit the estimate via approval-gated tools. Heavy vision use (photos, PDFs of RFPs / takeoffs).');
  stable.push('  • **Elle (job-side)** — WIP analyst on live jobs. Reads WIP snapshot, change orders, QB cost lines, and the node graph; spots margin issues, missing COs, billing gaps.');
  stable.push('  • **HR (customer-side)** — owns the customer directory. Splits parent+property compounds, links unparented properties, merges duplicates, attaches business cards, and writes durable client notes. Internal entity_type is "client" and skill-pack agentKey is "cra" (both kept for back-compat); display name is HR.');
  stable.push('All three log into the same ai_messages table (different entity_type values).');
  stable.push('');
  stable.push('# Your tools');
  stable.push('Read tools (auto-apply, no approval):');
  stable.push('  • `read_metrics(range)` — per-agent aggregate stats for last 7d or 30d. Default range is 7d.');
  stable.push('  • `read_recent_conversations(range, entity_type?, limit?)` — recent conversation list with rollup numbers.');
  stable.push('  • `read_conversation_detail(key)` — full message log of one conversation. Pass the `key` from read_recent_conversations.');
  stable.push('  • `read_skill_packs()` — admin-editable instruction packs the agents load each turn.');
  stable.push('Propose tools (approval-required — user clicks Approve/Reject on a card):');
  stable.push('  • `propose_skill_pack_add(name, body, agents, alwaysOn?, rationale)` — add a new skill pack. agents accepts ["ag", "cra", "job"] (ag=AG, cra=HR, job=Elle). ALWAYS call read_skill_packs first to confirm no name collision.');
  stable.push('  • `propose_skill_pack_edit(name, new_name?, new_body?, agents?, alwaysOn?, rationale)` — change an existing pack. body edits replace the whole body.');
  stable.push('  • `propose_skill_pack_delete(name, rationale)` — remove a pack entirely. alwaysOn=false is usually a softer alternative.');
  stable.push('');
  stable.push('# How to work');
  stable.push('- Default to data first. When asked "how is AG doing?", call `read_metrics` and report concrete numbers, not opinions.');
  stable.push('- Drill before generalizing. If you spot something odd in metrics, pull recent conversations and inspect a few before proposing a theory.');
  stable.push('- When citing a conversation, include the user and the entity title so the admin can locate it.');
  stable.push('- When proposing a skill pack, write tight, specific instructions — every always-on pack costs tokens on every turn forever. Propose deletions of stale ones too.');
  stable.push('- **Always close the loop with a brief summary after a tool runs.** When an approval-tier tool (skill pack add/edit/delete) executes, you receive its result as a tool_result block. Respond with a one- or two-sentence confirmation of what happened and what (if anything) the user should do next. NEVER end a turn with a tool_result and no follow-up text — the panel renders an empty turn as "(no response)" which looks broken.');
  stable.push('- Be candid about limits. You can\'t replay conversations directly from your tools (the admin runs replays manually from Admin → Agents → Conversations → 🔁 Replay), but you can suggest exact replay parameters (model, effort, system_prefix) when a question would benefit from one.');
  stable.push('- Skip the assistant filler. The admin is technical; lead with the answer.');
  stable.push('');
  stable.push('# Tone');
  stable.push('- Concise, structured (bullets and short paragraphs over walls of text). Quote token / dollar / count numbers exactly. If a tool call returned an empty result, say so.');

  // Live snapshot for the current week so the agent has cheap baseline
  // numbers without spending a tool call. Best-effort — failures degrade
  // silently, the agent will still call read_metrics if it needs detail.
  const liveLines = [];
  try {
    const r = await pool.query(`
      SELECT entity_type, COUNT(*) FILTER (WHERE role='assistant') AS turns
        FROM ai_messages
       WHERE created_at >= NOW() - INTERVAL '7 days'
       GROUP BY entity_type
    `);
    if (r.rows.length) {
      liveLines.push('# Live snapshot (last 7 days, assistant turns)');
      const labelMap = { estimate: 'AG', job: 'Elle', client: 'HR', staff: 'Chief of Staff (you)' };
      r.rows.forEach(row => {
        liveLines.push('  • ' + (labelMap[row.entity_type] || row.entity_type) + ': ' + Number(row.turns) + ' turns');
      });
      liveLines.push('Use `read_metrics` for full breakdowns (tokens, cost, model mix, conversations).');
    }
  } catch (e) { /* ignore — agent will call read_metrics if needed */ }

  return {
    system: [
      { type: 'text', text: stable.join('\n'), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n' + (liveLines.length ? liveLines.join('\n') : '_(No agent activity recorded in the last 7 days.)_') }
    ]
  };
}

// Read-tool executor. Inlines the same logic the admin REST endpoints
// use so we don't have to round-trip through HTTP.
async function execStaffTool(name, input) {
  switch (name) {
    case 'read_metrics': {
      const range = (input && input.range === '30d') ? '30 days' : '7 days';
      const aggSql = `
        SELECT
          entity_type,
          COUNT(*) FILTER (WHERE role = 'assistant') AS turns,
          COUNT(*) FILTER (WHERE role = 'user')      AS user_msgs,
          COUNT(DISTINCT (estimate_id, user_id))     AS conversations,
          COUNT(DISTINCT user_id)                    AS unique_users,
          COALESCE(SUM(input_tokens),  0)::bigint    AS input_tokens,
          COALESCE(SUM(output_tokens), 0)::bigint    AS output_tokens,
          COALESCE(SUM(tool_use_count), 0)::bigint   AS tool_uses,
          COALESCE(SUM(photos_included), 0)::bigint  AS photos,
          STRING_AGG(DISTINCT model, ',')            AS models
        FROM ai_messages
        WHERE created_at >= NOW() - INTERVAL '${range}'
          AND entity_type IN ('estimate','job','client')
        GROUP BY entity_type
        ORDER BY entity_type
      `;
      const r = await pool.query(aggSql);
      const out = [];
      const labels = { estimate: 'AG (estimate)', job: 'Elle (job/WIP)', client: 'HR (client)' };
      const all = ['estimate', 'job', 'client'];
      const byType = new Map(r.rows.map(row => [row.entity_type, row]));
      out.push('Metrics for last ' + range + ':');
      for (const et of all) {
        const row = byType.get(et);
        if (!row) {
          out.push('• ' + labels[et] + ': no activity');
          continue;
        }
        out.push('• ' + labels[et] + ': ' + Number(row.turns) + ' turns, ' +
          Number(row.conversations) + ' conversations, ' +
          Number(row.unique_users) + ' users, ' +
          Number(row.tool_uses) + ' tool uses, ' +
          Number(row.photos) + ' photos, ' +
          'tokens in/out ' + Number(row.input_tokens) + '/' + Number(row.output_tokens) +
          ', models: ' + (row.models || '(none)'));
      }
      return out.join('\n');
    }

    case 'read_recent_conversations': {
      const range = (input && input.range === '30d') ? '30 days' : '7 days';
      const limit = Math.max(1, Math.min(200, Number(input && input.limit) || 50));
      const params = [];
      const conds = [`created_at >= NOW() - INTERVAL '${range}'`];
      if (input && input.entity_type) {
        params.push(input.entity_type);
        conds.push(`entity_type = $${params.length}`);
      }
      conds.push(`entity_type IN ('estimate','job','client')`);
      const rollupSql = `
        SELECT entity_type, estimate_id AS entity_id, user_id,
               COUNT(*) FILTER (WHERE role='assistant') AS turns,
               COUNT(*) FILTER (WHERE role='user')      AS user_msgs,
               MAX(created_at) AS last_at,
               COALESCE(SUM(input_tokens),0)::bigint AS input_tokens,
               COALESCE(SUM(output_tokens),0)::bigint AS output_tokens,
               COALESCE(SUM(tool_use_count),0)::bigint AS tool_uses,
               STRING_AGG(DISTINCT model, ',') AS models
          FROM ai_messages
         WHERE ${conds.join(' AND ')}
         GROUP BY entity_type, estimate_id, user_id
         ORDER BY MAX(created_at) DESC
         LIMIT ${limit}
      `;
      const r = await pool.query(rollupSql, params);
      if (!r.rows.length) return 'No conversations in the last ' + range + '.';
      // Enrich with user emails + entity titles.
      const userIds = [...new Set(r.rows.map(x => x.user_id).filter(x => x != null))];
      const userMap = new Map();
      if (userIds.length) {
        const u = await pool.query('SELECT id, email FROM users WHERE id = ANY($1::int[])', [userIds]);
        u.rows.forEach(row => userMap.set(row.id, row.email));
      }
      const titleByKey = new Map();
      const ids = (et) => [...new Set(r.rows.filter(x => x.entity_type === et).map(x => x.entity_id))];
      const eIds = ids('estimate');
      if (eIds.length) {
        // estimates / jobs store title + name in JSONB `data`; pull via ->>.
        const er = await pool.query(`SELECT id, data->>'title' AS title FROM estimates WHERE id = ANY($1::text[])`, [eIds]);
        er.rows.forEach(x => titleByKey.set('estimate|' + x.id, x.title));
      }
      const jIds = ids('job');
      if (jIds.length) {
        const jr = await pool.query(`SELECT id, COALESCE(NULLIF(data->>'name',''), NULLIF(data->>'jobName',''), 'Job '||id) AS title FROM jobs WHERE id = ANY($1::text[])`, [jIds]);
        jr.rows.forEach(x => titleByKey.set('job|' + x.id, x.title));
      }
      const lines = [];
      for (const x of r.rows) {
        const t = titleByKey.get(x.entity_type + '|' + x.entity_id) || (x.entity_id === '__global__' ? 'Customer directory' : x.entity_id);
        const u = userMap.get(x.user_id) || ('user ' + x.user_id);
        const key = x.entity_type + '|' + x.entity_id + '|' + x.user_id;
        lines.push('- [' + x.entity_type + '] "' + t + '" · ' + u +
          ' · ' + Number(x.turns) + ' turns · ' + Number(x.tool_uses) + ' tools · ' +
          'tokens ' + (Number(x.input_tokens) + Number(x.output_tokens)) +
          ' · ' + new Date(x.last_at).toISOString().slice(0, 16).replace('T', ' ') +
          ' · key=' + key);
      }
      return lines.join('\n');
    }

    case 'read_conversation_detail': {
      const key = (input && input.key) || '';
      const parts = key.split('|');
      if (parts.length !== 3) throw new Error('key must be entity_type|entity_id|user_id');
      const [et, eid, uidRaw] = parts;
      const uid = Number(uidRaw);
      if (!Number.isFinite(uid)) throw new Error('user_id portion of key is not a number');
      const r = await pool.query(
        `SELECT role, content, model, input_tokens, output_tokens,
                tool_use_count, photos_included, created_at
           FROM ai_messages
          WHERE entity_type=$1 AND estimate_id=$2 AND user_id=$3
          ORDER BY created_at ASC`,
        [et, eid, uid]
      );
      if (!r.rows.length) return 'No messages found for that key.';
      const out = [];
      for (const m of r.rows) {
        const meta = [];
        if (m.model) meta.push(m.model);
        if (m.tool_use_count) meta.push(m.tool_use_count + ' tools');
        if (m.photos_included) meta.push(m.photos_included + ' photos');
        let body = String(m.content || '');
        if (body.length > 4000) body = body.slice(0, 4000) + ' [...truncated]';
        out.push('--- ' + m.role.toUpperCase() + ' (' + new Date(m.created_at).toISOString() + ')' + (meta.length ? ' [' + meta.join(', ') + ']' : '') + ' ---');
        out.push(body);
      }
      return out.join('\n\n');
    }

    case 'read_skill_packs': {
      const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
      const cfg = r.rows.length ? (r.rows[0].value || {}) : {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
      if (!skills.length) return 'No skill packs configured.';
      const lines = ['Skill packs (' + skills.length + '):'];
      for (const s of skills) {
        const agents = Array.isArray(s.agents) ? s.agents.join(',') : '(none)';
        const onOff = s.alwaysOn === false ? 'inactive' : 'always-on';
        lines.push('• "' + (s.name || '(untitled)') + '" → agents=' + agents + ', ' + onOff);
        const body = String(s.body || '');
        if (body) {
          lines.push('  ```');
          lines.push('  ' + (body.length > 600 ? body.slice(0, 600) + ' [...truncated]' : body).split('\n').join('\n  '));
          lines.push('  ```');
        }
      }
      return lines.join('\n');
    }

    default:
      throw new Error('Unknown staff tool: ' + name);
  }
}

// Approval-tier executor for skill-pack mutations. Called from the
// /staff/chat/continue endpoint after the user approves a propose
// card. Reads + writes app_settings.agent_skills as a single JSONB
// blob, optimistic-concurrency be damned (single admin user, no race).
async function execStaffApprovalTool(name, input) {
  switch (name) {
    case 'propose_skill_pack_add': {
      if (!input || !input.name || !input.body) throw new Error('name and body are required');
      if (!Array.isArray(input.agents) || !input.agents.length) throw new Error('agents must be a non-empty array');
      const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
      const cfg = r.rows.length ? (r.rows[0].value || {}) : {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
      if (skills.some(s => s && s.name === input.name)) {
        throw new Error('A skill pack named "' + input.name + '" already exists. Use propose_skill_pack_edit to modify it.');
      }
      skills.push({
        name: input.name,
        body: input.body,
        agents: input.agents,
        alwaysOn: input.alwaysOn === false ? false : true
      });
      const newCfg = Object.assign({}, cfg, { skills });
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('agent_skills', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(newCfg)]
      );
      return 'Added skill pack "' + input.name + '" → agents=' + input.agents.join(',') + (input.alwaysOn === false ? ' (inactive)' : ' (always-on)');
    }
    case 'propose_skill_pack_edit': {
      if (!input || !input.name) throw new Error('name is required');
      const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
      const cfg = r.rows.length ? (r.rows[0].value || {}) : {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
      const idx = skills.findIndex(s => s && s.name === input.name);
      if (idx < 0) throw new Error('No skill pack named "' + input.name + '"');
      const updated = Object.assign({}, skills[idx]);
      const changes = [];
      if (input.new_name && input.new_name !== updated.name) {
        if (skills.some(s => s && s !== updated && s.name === input.new_name)) {
          throw new Error('A skill pack named "' + input.new_name + '" already exists.');
        }
        changes.push('name "' + updated.name + '" → "' + input.new_name + '"');
        updated.name = input.new_name;
      }
      if (input.new_body != null) {
        updated.body = input.new_body;
        changes.push('body (' + (input.new_body.length || 0) + ' chars)');
      }
      if (Array.isArray(input.agents)) {
        updated.agents = input.agents;
        changes.push('agents → ' + input.agents.join(','));
      }
      if (typeof input.alwaysOn === 'boolean') {
        updated.alwaysOn = input.alwaysOn;
        changes.push(input.alwaysOn ? 'activated' : 'deactivated');
      }
      if (!changes.length) return 'No changes specified for "' + input.name + '".';
      skills[idx] = updated;
      const newCfg = Object.assign({}, cfg, { skills });
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('agent_skills', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(newCfg)]
      );
      return 'Edited skill pack "' + input.name + '": ' + changes.join('; ');
    }
    case 'propose_skill_pack_delete': {
      if (!input || !input.name) throw new Error('name is required');
      const r = await pool.query(`SELECT value FROM app_settings WHERE key = 'agent_skills'`);
      const cfg = r.rows.length ? (r.rows[0].value || {}) : {};
      const skills = Array.isArray(cfg.skills) ? cfg.skills.slice() : [];
      const idx = skills.findIndex(s => s && s.name === input.name);
      if (idx < 0) throw new Error('No skill pack named "' + input.name + '"');
      skills.splice(idx, 1);
      const newCfg = Object.assign({}, cfg, { skills });
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at) VALUES ('agent_skills', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()`,
        [JSON.stringify(newCfg)]
      );
      return 'Deleted skill pack "' + input.name + '".';
    }
    default:
      throw new Error('Unknown approval-tier staff tool: ' + name);
  }
}

// Streaming helper — same shape as streamClientTurn.
async function streamStaffTurn({ anthropic, res, system, messages }) {
  const cleanTools = STAFF_TOOLS.map(({ tier, ...t }) => t);
  // Web tools at the front so the cache breakpoint stays on the last
  // user-defined tool (matches the pattern in the other agents).
  const allTools = [...WEB_TOOLS, ...cleanTools];
  const cachedTools = allTools.length
    ? [
        ...allTools.slice(0, -1),
        Object.assign({}, allTools[allTools.length - 1], { cache_control: { type: 'ephemeral' } })
      ]
    : allTools;

  let assistantText = '';
  let finalContent = null;
  let usage = { input_tokens: null, output_tokens: null };
  const _effortS = effortClause();
  const stream = anthropic.messages.stream(Object.assign({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: system,
    tools: cachedTools,
    messages
  }, _effortS ? { output_config: _effortS } : {}));
  stream.on('text', (delta) => {
    assistantText += delta;
    res.write('data: ' + JSON.stringify({ delta }) + '\n\n');
  });
  stream.on('finalMessage', (msg) => {
    if (msg && msg.usage) usage = msg.usage;
    if (msg && Array.isArray(msg.content)) finalContent = msg.content;
  });
  await stream.done();
  const toolUseBlocks = (finalContent || []).filter(b => b.type === 'tool_use');
  return { assistantText, finalContent, toolUseBlocks, usage };
}

router.get('/staff/messages',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    try {
      const r = await pool.query(
        `SELECT id, role, content, created_at, model, input_tokens, output_tokens
           FROM ai_messages
          WHERE entity_type='staff' AND user_id=$1
          ORDER BY created_at ASC`,
        [req.user.id]
      );
      res.json({ messages: r.rows });
    } catch (e) {
      console.error('GET /staff/messages error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

router.delete('/staff/messages',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    try {
      await pool.query(
        `DELETE FROM ai_messages WHERE entity_type='staff' AND user_id=$1`,
        [req.user.id]
      );
      res.json({ ok: true });
    } catch (e) {
      console.error('DELETE /staff/messages error:', e);
      res.status(500).json({ error: 'Server error' });
    }
  }
);

const MAX_STAFF_TOOL_LOOPS = 8;
router.post('/staff/chat',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });

    setSSEHeaders(res);
    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
          WHERE entity_type='staff' AND user_id=$1
          ORDER BY created_at ASC`,
        [req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'staff', 'global', $2, 'user', $3)`,
        [userMsgId, req.user.id, userMessage]
      );

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'user', content: userMessage }
      ];

      let totalUsage = { input_tokens: 0, output_tokens: 0 };
      let finalAssistantText = '';

      for (let loop = 0; loop < MAX_STAFF_TOOL_LOOPS; loop++) {
        const ctx = await buildStaffContext();
        const turn = await streamStaffTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;

        if (!turn.toolUseBlocks.length) {
          if (finalAssistantText) {
            const aMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await pool.query(
              `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
               VALUES ($1, 'staff', 'global', $2, 'assistant', $3, $4, $5, $6)`,
              [aMsgId, req.user.id, finalAssistantText, MODEL, totalUsage.input_tokens, totalUsage.output_tokens]
            );
          }
          res.write('data: ' + JSON.stringify({ done: true, usage: totalUsage }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // Partition tool blocks by tier — read tools auto-execute, skill-
        // pack proposes pause for user approval.
        const autoBlocks     = turn.toolUseBlocks.filter(b => isStaffToolAutoTier(b.name));
        const approvalBlocks = turn.toolUseBlocks.filter(b => !isStaffToolAutoTier(b.name));

        if (approvalBlocks.length) {
          // Mixed or all-approval — stop and let the user decide. If
          // there are also auto-tier blocks in the same turn, treat them
          // ALL as approval so the user sees the full plan together.
          for (const tu of turn.toolUseBlocks) {
            res.write('data: ' + JSON.stringify({
              tool_use: { id: tu.id, name: tu.name, input: tu.input, tier: isStaffToolAutoTier(tu.name) ? 'auto' : 'approval' }
            }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({
            awaiting_approval: true,
            pending_assistant_content: turn.finalContent,
            tool_use_count: turn.toolUseBlocks.length,
            usage: totalUsage
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        // All auto. Execute, append tool_result, loop.
        const toolResultBlocks = [];
        for (const tu of autoBlocks) {
          let summary, isError = false;
          try {
            summary = await execStaffTool(tu.name, tu.input || {});
            res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary: summary.slice(0, 500) } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
          }
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: summary, is_error: isError || undefined });
        }
        messages.push({ role: 'assistant', content: turn.finalContent });
        messages.push({ role: 'user', content: toolResultBlocks });
      }
      res.write('data: ' + JSON.stringify({ error: 'Tool loop exceeded maximum iterations' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('AI staff chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// Continuation after the user approves/rejects skill-pack proposes.
// Mirrors the CRA /clients/chat/continue shape: the client sends the
// pending assistant content + a tool_results array with per-tool
// approval booleans; the server executes the approved propose tools
// and continues the loop so further auto-tier reads can chain.
router.post('/staff/chat/continue',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    const pendingContent = req.body && req.body.pending_assistant_content;
    const decisions = req.body && req.body.tool_results;
    if (!Array.isArray(pendingContent) || !Array.isArray(decisions) || !decisions.length) {
      return res.status(400).json({ error: 'pending_assistant_content and tool_results required' });
    }
    setSSEHeaders(res);
    try {
      const histRes = await pool.query(
        `SELECT role, content FROM ai_messages
          WHERE entity_type='staff' AND user_id=$1
          ORDER BY created_at ASC`,
        [req.user.id]
      );
      let history = histRes.rows;
      const cap = MAX_HISTORY_PAIRS * 2;
      if (history.length > cap) history = history.slice(-cap);

      // Map of tool_use_id → tool_use block for execution lookup.
      const pendingToolUseById = new Map();
      for (const block of pendingContent) {
        if (block && block.type === 'tool_use') pendingToolUseById.set(block.id, block);
      }

      // Execute approved propose tools server-side. Auto-tier blocks
      // that came along for the ride get executed too (read tools
      // bundled with proposes). Rejected blocks become an error
      // tool_result so the model knows.
      //
      // successfulApprovalSummaries — tracks the human-readable result
      // string from each approval-tier tool that succeeded. Used as
      // the fallback assistant text when the model produces empty
      // text after the tool ran, so the panel never renders
      // "(no response)" on a successful approval.
      const toolResultBlocks = [];
      const successfulApprovalSummaries = [];
      for (const d of decisions) {
        const tu = pendingToolUseById.get(d.id);
        if (!tu) {
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: d.id, content: 'Tool not found in pending content.', is_error: true });
          continue;
        }
        if (d.approved === false) {
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: 'User rejected this proposal.', is_error: true });
          res.write('data: ' + JSON.stringify({ tool_rejected: { id: tu.id, name: tu.name } }) + '\n\n');
          continue;
        }
        let summary, isError = false;
        try {
          summary = isStaffToolAutoTier(tu.name)
            ? await execStaffTool(tu.name, tu.input || {})
            : await execStaffApprovalTool(tu.name, tu.input || {});
          res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary: String(summary).slice(0, 500) } }) + '\n\n');
          // Track approval-tier successes so we can synthesize a
          // confirmation if the model later produces no follow-up text.
          if (!isStaffToolAutoTier(tu.name)) {
            successfulApprovalSummaries.push(String(summary));
          }
        } catch (e) {
          summary = 'Error: ' + (e.message || 'failed');
          isError = true;
          res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
        }
        toolResultBlocks.push({ type: 'tool_result', tool_use_id: tu.id, content: summary, is_error: isError || undefined });
      }

      const messages = [
        ...history.map(m => ({ role: m.role, content: m.content })),
        { role: 'assistant', content: pendingContent },
        { role: 'user', content: toolResultBlocks }
      ];

      // Resume the same loop the initial /staff/chat handler runs so
      // the model can chain follow-up reads after a successful edit.
      let totalUsage = { input_tokens: 0, output_tokens: 0 };
      let finalAssistantText = '';
      for (let loop = 0; loop < MAX_STAFF_TOOL_LOOPS; loop++) {
        const ctx = await buildStaffContext();
        const turn = await streamStaffTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;

        if (!turn.toolUseBlocks.length) {
          // Fallback synthesis: if the model returned no text after a
          // successful approval-tier tool execution (e.g. it felt
          // "done" and produced nothing despite the prompt nudge),
          // assemble a one-line confirmation from the tool summaries
          // so the panel never renders an empty "(no response)" turn.
          if (!finalAssistantText && successfulApprovalSummaries.length) {
            finalAssistantText = '✓ ' + successfulApprovalSummaries.join(' Also: ');
          }
          if (finalAssistantText) {
            const aMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await pool.query(
              `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model, input_tokens, output_tokens)
               VALUES ($1, 'staff', 'global', $2, 'assistant', $3, $4, $5, $6)`,
              [aMsgId, req.user.id, finalAssistantText, MODEL, totalUsage.input_tokens, totalUsage.output_tokens]
            );
            // Stream the synthesized fallback as a delta so the panel
            // displays it instead of the empty turn.
            if (!turn.assistantText) {
              res.write('data: ' + JSON.stringify({ delta: finalAssistantText }) + '\n\n');
            }
          }
          res.write('data: ' + JSON.stringify({ done: true, usage: totalUsage }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }

        const autoBlocks2     = turn.toolUseBlocks.filter(b => isStaffToolAutoTier(b.name));
        const approvalBlocks2 = turn.toolUseBlocks.filter(b => !isStaffToolAutoTier(b.name));
        if (approvalBlocks2.length) {
          for (const tu of turn.toolUseBlocks) {
            res.write('data: ' + JSON.stringify({
              tool_use: { id: tu.id, name: tu.name, input: tu.input, tier: isStaffToolAutoTier(tu.name) ? 'auto' : 'approval' }
            }) + '\n\n');
          }
          res.write('data: ' + JSON.stringify({
            awaiting_approval: true,
            pending_assistant_content: turn.finalContent,
            tool_use_count: turn.toolUseBlocks.length,
            usage: totalUsage
          }) + '\n\n');
          res.write('data: [DONE]\n\n');
          res.end();
          return;
        }
        const trBlocks2 = [];
        for (const tu of autoBlocks2) {
          let summary, isError = false;
          try {
            summary = await execStaffTool(tu.name, tu.input || {});
            res.write('data: ' + JSON.stringify({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary: String(summary).slice(0, 500) } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } }) + '\n\n');
          }
          trBlocks2.push({ type: 'tool_result', tool_use_id: tu.id, content: summary, is_error: isError || undefined });
        }
        messages.push({ role: 'assistant', content: turn.finalContent });
        messages.push({ role: 'user', content: trBlocks2 });
      }
      res.write('data: ' + JSON.stringify({ error: 'Tool loop exceeded maximum iterations' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (e) {
      console.error('AI staff chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// Internals exposed for sibling modules (eval harness in
// admin-agents-routes). NOT for general use — these bypass the
// streaming + auth flow that production AG depends on.
module.exports = router;
module.exports.internals = {
  buildEstimateContext,
  buildJobContext,
  buildClientDirectoryContext,
  buildStaffContext,
  estimateTools: () => [...WEB_TOOLS, ...ESTIMATE_TOOLS],
  jobTools:      () => [...WEB_TOOLS, ...JOB_TOOLS],
  clientTools:   () => [...WEB_TOOLS, ...CLIENT_TOOLS.map(({ tier, ...t }) => t)],
  staffTools:    () => [...WEB_TOOLS, ...STAFF_TOOLS.map(({ tier, ...t }) => t)],
  defaultModel: () => MODEL,
  maxTokens: () => MAX_TOKENS,
  // Resolve the effort string for a given model. Caller passes the
  // resolved model (default OR override) plus an optional explicit
  // override; we fall back to env AI_EFFORT and gate by model support.
  // Returns the effort string ("xhigh", "high", etc.) or null when
  // none should be sent.
  effortFor: (resolvedModel, effortOverride) => {
    const eff = ((effortOverride || '') + '').trim().toLowerCase() || EFFORT;
    if (!eff) return null;
    if (!EFFORT_SUPPORTED_MODELS.has(resolvedModel)) return null;
    return eff;
  }
};
