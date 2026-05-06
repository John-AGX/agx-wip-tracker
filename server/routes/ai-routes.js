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
// Per-agent overrides — Elle's WIP audits benefit from higher
// thinking budgets, AG's quick line-item turns don't. Each env var
// is optional; missing → falls back to AI_EFFORT.
//   AI_EFFORT_AG    AG (estimating)
//   AI_EFFORT_JOB   Elle (WIP analyst)
//   AI_EFFORT_CRA   HR (customer relations)
//   AI_EFFORT_STAFF Chief of Staff
const EFFORT_PER_AGENT = {
  ag:    (process.env.AI_EFFORT_AG    || '').trim().toLowerCase(),
  job:   (process.env.AI_EFFORT_JOB   || '').trim().toLowerCase(),
  cra:   (process.env.AI_EFFORT_CRA   || '').trim().toLowerCase(),
  staff: (process.env.AI_EFFORT_STAFF || '').trim().toLowerCase()
};
const EFFORT_SUPPORTED_MODELS = new Set([
  'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6'
]);
function effortClause(agentKey) {
  // Per-agent override beats global default. Resolve in this order:
  //   1. EFFORT_PER_AGENT[agentKey] (env-var per agent)
  //   2. EFFORT (global env-var fallback)
  //   3. null (no effort param sent)
  const eff = (agentKey && EFFORT_PER_AGENT[agentKey]) || EFFORT;
  if (!eff) return null;
  if (!EFFORT_SUPPORTED_MODELS.has(MODEL)) return null;
  return { effort: eff };
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
  },
  {
    name: 'read_materials',
    description: 'Search AGX\'s materials catalog (real purchase history from Home Depot + other vendors — actual prices AGX has paid). Auto-applies, no approval. **CALL THIS BEFORE QUOTING ANY MATERIALS LINE ITEM** so your unit costs come from real AGX purchase data instead of guesses. Returns each match with cleaned description, unit, last/avg/min/max prices, last-seen date, and total times purchased. Use the most specific keyword you can — "5/4 deck board PT", "trex transcend", "drywall mud", "joist hanger 2x10". If nothing matches, narrow further (or tell the user the SKU isn\'t in our catalog yet so they know to log it after buying).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across description / raw_description / SKU. Use trade words: "PT pickets", "joist hanger", "Behr Marquee", "Hardie lap siding".' },
        subgroup: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Filter to one AGX subgroup. Default: all.' },
        category: { type: 'string', description: 'Filter to one AGX category, e.g. "Lumber & Decking", "Paint", "Fasteners". Use read_materials with no filters first if unsure what categories exist.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Cap rows returned. Default 20.' }
      },
      required: []
    }
  },
  {
    name: 'read_purchase_history',
    description: 'Drill into the per-purchase log for a specific material (or by free-text query). Returns purchase_date, quantity, unit_price, store_number, job_name, and net_unit_price for individual receipts — the source rows that aggregate into read_materials\' last/avg/min/max stats. Use this to answer "what did we pay last time we bought X?", "is this material trending up in price?", "which jobs used this SKU recently?". Pair with read_materials: read_materials gets you the rolled-up summary, read_purchase_history gets you the receipt-level detail.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        material_id: { type: 'integer', description: 'Specific material id (from read_materials results). Skip free-text matching when you already know the SKU.' },
        q: { type: 'string', description: 'Free-text search across the material description if you don\'t have the id yet.' },
        days: { type: 'integer', minimum: 1, maximum: 730, description: 'Only show purchases in the last N days. Default 365 (last year).' },
        job_name: { type: 'string', description: 'Filter to purchases tagged to a specific job name (case-insensitive partial match).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap rows returned. Default 30.' }
      },
      required: []
    }
  },
  {
    name: 'read_subs',
    description: 'Query AGX\'s subcontractor directory. Returns name, trade, status, cert (GL / WC / W9 / Bank) expiration dates, primary contact, business phone — everything you need to know if a sub is available + paperwork-current before scoping work to them. Use it when you\'re drafting a Subcontractors line, or when the user mentions "use ABC Drywall" and you want to confirm they\'re an active sub.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across name / trade / contact name.' },
        trade: { type: 'string', description: 'Filter to one trade, e.g. "Painter", "Drywall", "Roofer".' },
        status: { type: 'string', enum: ['active', 'paused', 'closed'], description: 'Filter by status. Default: active only.' },
        with_expiring_certs: { type: 'boolean', description: 'When true, only return subs with at least one cert expiring in the next 60 days OR already expired. Useful for audits.' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap rows returned. Default 30.' }
      },
      required: []
    }
  },
  {
    name: 'read_lead_pipeline',
    description: 'Query the AGX leads pipeline. Returns title, status, projected_revenue, salesperson, market, source, age, projected_sale_date — both individual leads and rollup counts by status. Use it when scoping a new estimate ("what other leads do we have like this?"), when the user asks about pipeline health, or when the linked-lead context above isn\'t enough and you want sibling context.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across title / property_name / notes.' },
        status: { type: 'string', enum: ['new', 'in_progress', 'sent', 'sold', 'lost', 'no_opportunity'], description: 'Filter to one status.' },
        market: { type: 'string', description: 'Filter to one market (Tampa, Orlando, Sarasota, Brevard, Lakeland, etc.).' },
        salesperson_email: { type: 'string', description: 'Filter to leads owned by a specific salesperson (matches by email substring).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Cap rows returned. Default 30.' }
      },
      required: []
    }
  },
  // ──── Group / alternate management ────────────────────────────────
  // Each estimate has one or more "groups" (a.k.a. alternates) — Group 1,
  // Group 2, etc. — each with its own scope, line items, and a
  // `excludeFromTotal` flag for Good/Better/Best style scenarios. AG can
  // now switch which group is active (subsequent line edits target the
  // active group), add/rename/delete groups, and toggle inclusion.
  {
    name: 'propose_switch_active_group',
    description:
      'Switch the active group on the estimate. Subsequent propose_add_line_item / propose_update_scope calls target the new active group. ' +
      'Use when the user pivots focus mid-conversation ("now let\'s work on the roof") and you need to slot lines under a different group than the one currently active. ' +
      'Resolves by group id OR case-insensitive group name (substring match).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'Group id (e.g., "alt_…") OR exact/substring case-insensitive group name (e.g., "Group 2", "roof").' },
        rationale: { type: 'string', description: 'One short sentence — why we\'re switching.' }
      },
      required: ['group_id', 'rationale']
    }
  },
  {
    name: 'propose_add_group',
    description:
      'Create a new group on the estimate and switch focus to it. Auto-seeds the four standard subgroups (Materials & Supplies, Direct Labor, General Conditions, Subcontractors) so the next propose_add_line_item call has somewhere to slot. ' +
      'When `copy_from_active` is true, every line + section header in the currently-active group is cloned into the new group (the duplicate-group flow); otherwise the new group is empty except for the seeded subgroup headers.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Group name (e.g., "Roof", "Phase 2", "Optional Adds").' },
        copy_from_active: { type: 'boolean', description: 'If true, clone all lines + section headers from the currently-active group. Default false (empty new group).' },
        rationale: { type: 'string', description: 'One short sentence — what this group is for.' }
      },
      required: ['name', 'rationale']
    }
  },
  {
    name: 'propose_rename_group',
    description: 'Rename an existing group. Resolves by id or case-insensitive name match.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group_id: { type: 'string', description: 'Group id or current name.' },
        new_name: { type: 'string', description: 'New name for the group.' },
        rationale: { type: 'string' }
      },
      required: ['group_id', 'new_name', 'rationale']
    }
  },
  {
    name: 'propose_delete_group',
    description:
      'Delete a group and all its line items. Refuses if it\'s the only group remaining (estimates require at least one group). ' +
      'If the deleted group was active, focus auto-shifts to the first remaining group.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['group_id', 'rationale']
    }
  },
  {
    name: 'propose_toggle_group_include',
    description:
      'Set whether a group is included in the estimate\'s grand total. Use for Good/Better/Best scenarios where the user wants to present multiple scopes but only one rolls into the headline number, or for "optional adds" groups that price separately.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        group_id: { type: 'string' },
        included: { type: 'boolean', description: 'true = group counts toward the grand total; false = group is presented separately, doesn\'t add to the headline.' },
        rationale: { type: 'string' }
      },
      required: ['group_id', 'included', 'rationale']
    }
  },
  // ──── Linking + estimate metadata ─────────────────────────────────
  {
    name: 'propose_link_to_client',
    description:
      'Link this estimate to a client record. Use when the user mentions a client name and the estimate doesn\'t yet have linked_client_id, or when read_clients returns a high-confidence match. After linking, the client\'s notes auto-inject into AG\'s context every turn (see propose_add_client_note for the writeback flow).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        client_id: { type: 'string', description: 'Client id from read_clients results.' },
        rationale: { type: 'string', description: 'One short sentence — how you identified this client.' }
      },
      required: ['client_id', 'rationale']
    }
  },
  {
    name: 'propose_link_to_lead',
    description:
      'Link this estimate to a lead record so the lead\'s pipeline status, projected revenue, and projected sale date stay in sync. Use after read_lead_pipeline returns a confident match.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        lead_id: { type: 'string' },
        rationale: { type: 'string' }
      },
      required: ['lead_id', 'rationale']
    }
  },
  {
    name: 'propose_update_estimate_field',
    description:
      'Update one estimate-level metadata field. Use for the title (rename), salutation (proposal "Dear ___,"), markup_default (estimate-wide default markup % for sections that don\'t set their own), bt_export_status (BT pipeline status), or notes. One field per call.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        field: {
          type: 'string',
          enum: ['title', 'salutation', 'markup_default', 'bt_export_status', 'notes'],
          description: 'Which estimate-level field to update.'
        },
        value: {
          type: ['string', 'number'],
          description: 'New value. Number for markup_default; string for everything else.'
        },
        rationale: { type: 'string' }
      },
      required: ['field', 'value', 'rationale']
    }
  },
  // ──── Bulk line operations ────────────────────────────────────────
  {
    name: 'propose_bulk_update_lines',
    description:
      'Update the same fields on multiple lines in one approval card — instead of N separate propose_update_line_item calls. Use for "move every line in Materials that mentions paint over to Subcontractors" or "set markup to 30% on these 12 lines." ' +
      'Only changes the fields you supply (description / qty / unit / unit_cost / markup_pct / section_name); each line keeps every other field. ' +
      'For a homogeneous bulk delete use propose_bulk_delete_lines instead.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line_ids: { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Ids of every line being updated.' },
        changes: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: { type: 'string' },
            qty: { type: 'number' },
            unit: { type: 'string' },
            unit_cost: { type: 'number' },
            markup_pct: { type: 'number' },
            section_name: { type: 'string', description: 'Move every line under this subgroup. Case-insensitive substring match.' }
          },
          description: 'The fields to apply to every line in line_ids. Omit fields you don\'t want to touch.'
        },
        rationale: { type: 'string' }
      },
      required: ['line_ids', 'changes', 'rationale']
    }
  },
  {
    name: 'propose_bulk_delete_lines',
    description: 'Delete multiple lines in one approval card. Use after audit findings list 5+ duplicate / dead lines.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        line_ids: { type: 'array', items: { type: 'string' }, minItems: 1 },
        rationale: { type: 'string' }
      },
      required: ['line_ids', 'rationale']
    }
  },
  // ──── New read tools — auto-apply, no approval ─────────────────────
  {
    name: 'read_clients',
    description:
      'Search the AGX clients directory. Returns id, name, parent client (if any), city, primary contact, and any agent-readable notes. Use this before propose_link_to_client when the estimate isn\'t linked yet and the user mentions a client name. Substring match on name and contact.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search on name / contact / city.' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Cap rows returned. Default 20.' }
      },
      required: []
    }
  },
  {
    name: 'read_leads',
    description:
      'Search the AGX leads pipeline by free text + filters. Lighter-weight than read_lead_pipeline (this one targets a specific lead lookup for linking; read_lead_pipeline is for pipeline analytics). Returns id, title, status, projected_revenue, salesperson, market.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text on title / property name.' },
        status: { type: 'string', enum: ['new', 'in_progress', 'sent', 'sold', 'lost', 'no_opportunity'] },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Cap rows returned. Default 15.' }
      },
      required: []
    }
  },
  {
    name: 'read_past_estimate_lines',
    description:
      'Search line items across ALL past AGX estimates for pricing benchmark. Returns up to N matching lines with description, qty, unit, unit_cost, markup, section name, parent estimate id + title, and last-modified date. Use BEFORE quoting a non-materials line (labor or sub) so you anchor to AGX history instead of guessing — for materials use read_materials (real receipts).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text on line description (e.g., "fascia replacement", "hang and finish drywall").' },
        days: { type: 'integer', minimum: 30, maximum: 1825, description: 'Only show lines from estimates updated in the last N days. Default 730 (2 years).' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Cap rows returned. Default 25.' }
      },
      required: ['q']
    }
  },
  {
    name: 'read_past_estimates',
    description:
      'Search past AGX estimates by title + client + total. Returns estimate id, title, client name, total, status, sold/lost outcome, last-modified. Use to answer "have we done a porch repaint at PAC before?" or to find a recent comparable estimate to model the new one on.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text on estimate title or linked client name.' },
        status: { type: 'string', enum: ['draft', 'sent', 'sold', 'lost'], description: 'Filter to one outcome. Omit for all statuses.' },
        days: { type: 'integer', minimum: 30, maximum: 1825, description: 'Only show estimates updated in the last N days. Default 730.' },
        limit: { type: 'integer', minimum: 1, maximum: 50, description: 'Cap rows returned. Default 15.' }
      },
      required: []
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
      'Update % complete. The id parameter accepts FOUR shapes:\n' +
      '  1. Phase record id ("ph_...") — updates that one phase.\n' +
      '  2. Building record id ("b1") — cascades to every dependent under that building.\n' +
      '  3. Graph t1 node id ("n3") — resolves to the building record, then cascades as in (2).\n' +
      '  4. Graph t2 node id ("n2") — updates that one t2 node\'s pct.\n' +
      'For building/t1 cascades, the applier writes wire.pctComplete on every incoming t2/co wire AND phase.pctComplete on every phase record with that buildingId. The t1\'s own pctComplete is left to the rollup. Only when no wires or phases exist do we write directly to t1.pctComplete.\n' +
      'If the user wants ONE specific phase changed, pass that phase\'s id, not the building. Always include a rationale (one short sentence).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase_id: { type: 'string', description: 'A phase record id ("ph_..."), a building record id ("b1"), or a t1/t2 node id ("n2"). The applier resolves all four.' },
        pct_complete: { type: 'number', minimum: 0, maximum: 100, description: 'New % complete value (0–100).' },
        rationale: { type: 'string', description: 'One short sentence — why this number, not the old one. For building/t1 ids, mention you understand this cascades to every phase under that building.' }
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
      'line_id is the qb_cost_lines.id; node_id is the graph node it should reconcile against. ' +
      'For bulk assignments (5+ lines that all map cleanly), prefer `assign_qb_lines_bulk` — one approval card instead of N.',
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
    name: 'set_co_field',
    description:
      'Update a single field on a change order (CO) record. Use when an audit shows a CO has $0 cost but should have a real number ' +
      '(common cause of inflated revised margin), when income needs adjusting after the GC accepts/rejects a partial, or when the ' +
      'description / co_number needs cleanup. One field per call so each shows as its own approval card; chain calls if multiple ' +
      'fields need updates on the same CO.\n' +
      'co_id is the changeOrders[].id from the # Change orders block. ' +
      'Only allowed fields: income (CO revenue), estimatedCosts (CO cost — note the field name uses "estimatedCosts", NOT "costs"), ' +
      'description, notes, coNumber, date (YYYY-MM-DD).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        co_id: { type: 'string', description: 'changeOrders[].id from the # Change orders block.' },
        field: {
          type: 'string',
          enum: ['income', 'estimatedCosts', 'description', 'notes', 'coNumber', 'date'],
          description: 'Which field to set.'
        },
        value: {
          type: ['string', 'number'],
          description: 'New value. Numbers for income / estimatedCosts (dollars, not cents), strings for description / notes / coNumber / date.'
        },
        rationale: { type: 'string', description: 'One short sentence — why this change.' }
      },
      required: ['co_id', 'field', 'value', 'rationale']
    }
  },
  {
    name: 'create_po',
    description:
      'Create a new purchase order on the active job. Use when the user describes a sub commitment ("$25k to ABC Drywall for B1 hang and finish") and there\'s no existing PO record, or when the playbook\'s QB→PO→Invoice chain rule requires a PO that\'s missing. ' +
      'Required: vendor + amount. Strongly preferred: poNumber, description, date (defaults to today). ' +
      'subId is auto-resolved from vendor when the name matches a row in the subs directory; pass it explicitly only if you already know the id from the # Subs block.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor:        { type: 'string', description: 'Vendor / sub name. Used as the display label and for sub-directory matching.' },
        amount:        { type: 'number', description: 'PO amount in dollars (not cents). The committed dollar value at issue.' },
        poNumber:      { type: 'string', description: 'PO number string (e.g. "PO-1042"). Often blank when the PM hasn\'t numbered it yet.' },
        description:   { type: 'string', description: 'Scope summary — what this PO covers.' },
        billedToDate:  { type: 'number', description: 'Optional — already-invoiced amount against this PO. Default 0.' },
        date:          { type: 'string', description: 'Issue date (YYYY-MM-DD). Defaults to today if omitted.' },
        status:        { type: 'string', enum: ['Open', 'Closed', 'Pending'], description: 'PO status. Default "Open".' },
        notes:         { type: 'string', description: 'Free-form notes.' },
        rationale:     { type: 'string', description: 'One short sentence — why this PO needs to exist.' }
      },
      required: ['vendor', 'amount', 'rationale']
    }
  },
  {
    name: 'set_po_field',
    description:
      'Update a single field on an existing purchase order. One field per call so each shows as its own approval card. ' +
      'po_id is the purchaseOrders[].id from the # Purchase orders block. ' +
      'Allowed: vendor, amount, poNumber, description, billedToDate (already-invoiced amount), date, status (Open/Closed/Pending), notes.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        po_id:     { type: 'string', description: 'purchaseOrders[].id from the # Purchase orders block.' },
        field:     { type: 'string', enum: ['vendor', 'amount', 'poNumber', 'description', 'billedToDate', 'date', 'status', 'notes'] },
        value:     { type: ['string', 'number'], description: 'Numbers for amount / billedToDate; strings for the rest.' },
        rationale: { type: 'string', description: 'One short sentence — why this change.' }
      },
      required: ['po_id', 'field', 'value', 'rationale']
    }
  },
  {
    name: 'create_invoice',
    description:
      'Create a new invoice on the active job. Use when QB shows a vendor invoice that hasn\'t been logged into AGX yet, when the user dictates one ("Acme sent us $12,400 for Apr 15"), or when the playbook\'s chain rule (PO → Invoice → QB-line) requires a missing invoice node. ' +
      'Required: vendor + amount. Strongly preferred: invNumber, date, status. dueDate defaults to date+30 days when omitted.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        vendor:      { type: 'string', description: 'Vendor name on the invoice.' },
        amount:      { type: 'number', description: 'Invoice amount in dollars.' },
        invNumber:   { type: 'string', description: 'Invoice number from the document.' },
        description: { type: 'string', description: 'What the invoice covers.' },
        date:        { type: 'string', description: 'Invoice date (YYYY-MM-DD). Defaults to today.' },
        dueDate:     { type: 'string', description: 'Due date (YYYY-MM-DD). Defaults to date + 30 days.' },
        status:      { type: 'string', enum: ['Draft', 'Pending', 'Paid', 'Overdue'], description: 'Default "Draft".' },
        notes:       { type: 'string' },
        rationale:   { type: 'string', description: 'One short sentence — why log this invoice.' }
      },
      required: ['vendor', 'amount', 'rationale']
    }
  },
  {
    name: 'set_invoice_field',
    description:
      'Update a single field on an existing invoice. One field per call. ' +
      'inv_id is the invoices[].id from the # Invoices block. ' +
      'Allowed: vendor, amount, invNumber, description, date, dueDate, status (Draft/Pending/Paid/Overdue), notes.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inv_id:    { type: 'string', description: 'invoices[].id from the # Invoices block.' },
        field:     { type: 'string', enum: ['vendor', 'amount', 'invNumber', 'description', 'date', 'dueDate', 'status', 'notes'] },
        value:     { type: ['string', 'number'] },
        rationale: { type: 'string', description: 'One short sentence — why this change.' }
      },
      required: ['inv_id', 'field', 'value', 'rationale']
    }
  },
  {
    name: 'assign_qb_lines_bulk',
    description:
      'Bulk-link many QuickBooks cost lines to graph nodes in a single approval card. ' +
      'Use this whenever you have 5+ lines that all map cleanly — a vendor-to-sub-node sweep, an entire account routed to one cost-bucket, a batch reclassification after fixing a misposted PO. ' +
      'Each item is {line_id, node_id}; the applier runs the same resolution + server PATCH as `assign_qb_line` for each one. ' +
      'Mixed outcomes (some succeed, some skip due to missing node) are summarized in the result so the next turn knows what still needs cleanup. ' +
      'Cap at 200 pairs per call.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pairs: {
          type: 'array',
          minItems: 1,
          maxItems: 200,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              line_id: { type: 'string' },
              node_id: { type: 'string' }
            },
            required: ['line_id', 'node_id']
          },
          description: 'Array of {line_id, node_id} pairs. line_id is qb_cost_lines.id; node_id is the graph node id.'
        },
        rationale: { type: 'string', description: 'One short sentence describing the batch as a whole — e.g. "All Home Depot lines route to the materials sub-node for B1." Do NOT enumerate every pair here; the pairs array is the audit trail.' }
      },
      required: ['pairs', 'rationale']
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
  },
  {
    name: 'request_build_mode',
    description:
      'Ask the PM\'s permission to switch from Plan mode to Build mode so you can write changes ' +
      '(set_phase_pct_complete, set_phase_field, set_node_value, assign_qb_line, etc.). Use this ' +
      'in Plan mode whenever your analysis surfaces an action you\'d need to take but can\'t — ' +
      'e.g. "B1 has cost data but pctComplete=0, want me to set it to 100%?" or "131 QB lines are ' +
      'unlinked, want me to wire them to their nodes?". The PM gets an approval card listing your ' +
      'planned actions; on approve, the panel flips to Build mode and your next turn opens with ' +
      'full write access. Do NOT call this for trivial questions or when the PM hasn\'t asked for ' +
      'a change — it\'s for moments where Plan mode is actively blocking productive work.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        reason: {
          type: 'string',
          description: '1–2 sentences summarizing why you need write access. Shown on the approval card. Be specific: "I want to update the % complete on 5 buildings to match what you just told me," not "I want to make changes."'
        },
        planned_actions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Bullet list of the specific writes you intend to make if granted Build mode. Each line: action + target. Example: ["Set B1 pctComplete to 100%", "Set B2 pctComplete to 100%", "Assign 14 unlinked Home Depot lines to materials sub-node"]. The PM uses this to decide whether to grant access.'
        }
      },
      required: ['reason', 'planned_actions']
    }
  },
  {
    name: 'read_building_breakdown',
    description:
      'Read the complete phase composition + computed rollups for a single building. Auto-applies, no approval. ' +
      'Returns every phase under the building (no truncation), each phase\'s pctComplete + budget + weight, the budget-weighted rollup, AND every graph wire (t2/co → t1) feeding the building with their wire-level pctComplete + allocPct overrides. ' +
      'Use this when the truncated # Structure block in your context isn\'t enough — i.e. building has more phases than were shown, or you need wire-level allocation/pct values to diagnose why the WIP page and the graph view disagree on a building\'s number.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        building_id: { type: 'string', description: 'building record id (e.g. "b1") OR a t1 node id ("n3"). The applier resolves either.' }
      },
      required: ['building_id']
    }
  },
  {
    name: 'read_job_pct_audit',
    description:
      'Sweep the job for percent-complete inconsistencies. Auto-applies, no approval. Reports:\n' +
      '  • Orphan phases (no buildingId or pointing at a deleted building — invisible to the rollup).\n' +
      '  • Dangling t1 nodes (graph t1 with no underlying building record).\n' +
      '  • Stale t1 pctComplete (t1 with its own pctComplete set AND wired t2/co children — value is ignored, usually leftover).\n' +
      '  • Wires with allocPct=0 (contribute nothing to the rollup).\n' +
      '  • Buildings with no phases (always read 0%).\n' +
      '  • Phases with no budget (equal-weighted in the rollup; can over/under-count vs. intent).\n' +
      'Run this FIRST when the PM says "something\'s off with the percentages" or before a big cascade write.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  {
    name: 'set_phase_buildingId',
    description:
      'Re-link an orphan phase to a building, or move a phase between buildings. Use after `read_job_pct_audit` flags orphans, or when the user dictates "move phase X under building Y." ' +
      'phase_id is the phase record id (e.g. "ph_..."). building_id is the target building record id (e.g. "b1") OR the empty string to UNLINK (rare — usually you want to link, not unlink).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase_id:    { type: 'string', description: 'phase record id from the # Structure block.' },
        building_id: { type: 'string', description: 'target building record id (e.g. "b1"), or "" to unlink.' },
        rationale:   { type: 'string', description: 'One short sentence — why this phase belongs (or doesn\'t belong) under this building.' }
      },
      required: ['phase_id', 'building_id', 'rationale']
    }
  },
  {
    name: 'set_wire_pct_complete',
    description:
      'Set the per-allocation pctComplete on a single graph wire. This is the SURGICAL way to mark "this building\'s slice of phase X is done" without touching the source phase\'s overall pct (which would propagate to every other building that phase wires to). ' +
      'When a wire has its own pctComplete set, it overrides the source node\'s pctComplete in the budget-weighted rollup at the t1.\n' +
      'Use when the PM says "B1 is done with COATINGS but B2 is only at 50%" — set the wire from COATINGS → B1 to 100 and the wire from COATINGS → B2 to 50. The COATINGS source node stays untouched.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_node_id: { type: 'string', description: 'Source t2 / co node id (e.g. "n12"). The wire originates here.' },
        to_node_id:   { type: 'string', description: 'Target t1 (building) node id (e.g. "n3").' },
        pct_complete: { type: 'number', minimum: 0, maximum: 100, description: 'New wire-level pctComplete (0–100). Pass null to clear the override and fall back to source.pctComplete.' },
        rationale:    { type: 'string', description: 'One short sentence — why this wire-level override.' }
      },
      required: ['from_node_id', 'to_node_id', 'pct_complete', 'rationale']
    }
  },
  {
    name: 'set_wire_alloc_pct',
    description:
      'Set the allocation percent on a single graph wire — i.e. how much of the source\'s revenue/value flows along this wire. Used to fix the COATINGS-allocates-14.3%-to-each-of-7-buildings type setup when the PM wants a different split (e.g. COATINGS is mostly for B1 and only a sliver goes to B7).\n' +
      'allocPct sums across all outgoing wires from a source should generally equal 100; the engine uses raw percentages but the rollup math gets weird if a source has 200% allocated. Confirm the sum after each change.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_node_id: { type: 'string', description: 'Source t2 / co node id.' },
        to_node_id:   { type: 'string', description: 'Target node id (typically a t1 building).' },
        alloc_pct:    { type: 'number', minimum: 0, maximum: 100, description: 'New allocation percent (0–100). 100 = 100% of source\'s value flows along this wire.' },
        rationale:    { type: 'string', description: 'One short sentence — why this split.' }
      },
      required: ['from_node_id', 'to_node_id', 'alloc_pct', 'rationale']
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
    lines.push('AGX organizes a multi-scope estimate into Groups (e.g., Deck 1, Deck 2, Roof, Optional Adds). Each group carries its own scope and its own line items. The proposal total = sum of every INCLUDED group; groups marked `excluded` are not priced or shown to the client. Use propose_switch_active_group / propose_add_group to operate on a different group.');
    alternates.forEach(a => {
      const isActive = a.id === blob.activeAlternateId;
      const isExcluded = !!a.excludeFromTotal;
      // Per-group cost-side subtotal so AG can see what's already in
      // each group without having to switch into it. This is the cost
      // side (qty * unitCost * (1 + markup/100)) — the same math
      // the editor uses for the headline number.
      const groupLines = allLines.filter(l => l.alternateId === a.id);
      const itemLines = groupLines.filter(l => l.section !== '__section_header__');
      let subtotal = 0;
      // Build a markup map from the section headers in this group.
      const sectionMarkupById = {};
      groupLines.forEach(l => {
        if (l.section === '__section_header__') {
          sectionMarkupById[l.id] = (l.markup === '' || l.markup == null)
            ? ((blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0)
            : parseFloat(l.markup);
        }
      });
      // Walk lines in order; track which section we're under so each
      // line can fall back to its section's markup if it doesn't override.
      let curSectionMarkup = (blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0;
      groupLines.forEach(l => {
        if (l.section === '__section_header__') {
          curSectionMarkup = sectionMarkupById[l.id];
          return;
        }
        const qty = parseFloat(l.qty) || 0;
        const cost = parseFloat(l.unitCost) || 0;
        const m = (l.markup === '' || l.markup == null) ? curSectionMarkup : parseFloat(l.markup);
        subtotal += qty * cost * (1 + (m / 100));
      });
      const subtotalStr = '$' + Math.round(subtotal).toLocaleString();
      const sectionNames = groupLines
        .filter(l => l.section === '__section_header__')
        .map(l => l.description || 'subgroup');
      lines.push('- ' + a.name +
        (isActive ? ' (active in editor)' : '') +
        (isExcluded ? ' [EXCLUDED from proposal]' : '') +
        ' · ' + itemLines.length + ' line' + (itemLines.length === 1 ? '' : 's') +
        ' · ' + subtotalStr +
        (sectionNames.length ? ' · subgroups: ' + sectionNames.join(', ') : ''));
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

  // Materials catalog snapshot — small overview so the model knows the
  // catalog exists and how big it is. Detailed lookups go through the
  // `read_materials` tool. Best-effort: if the count query fails (no
  // table yet on a fresh deploy), skip silently.
  try {
    const matRes = await pool.query(
      `SELECT
         (SELECT COUNT(*)::int FROM materials WHERE is_hidden = false) AS total,
         (SELECT COUNT(*)::int FROM materials WHERE is_hidden = false AND last_seen >= NOW() - INTERVAL '90 days') AS recent,
         (SELECT array_agg(DISTINCT category) FROM (
            SELECT category FROM materials WHERE is_hidden = false AND category IS NOT NULL
              GROUP BY category ORDER BY COUNT(*) DESC LIMIT 8
         ) c) AS top_cats`
    );
    const totalMat = matRes.rows[0].total || 0;
    const recentMat = matRes.rows[0].recent || 0;
    const topCats = (matRes.rows[0].top_cats || []).filter(Boolean);
    if (totalMat > 0) {
      lines.push('# Materials catalog');
      lines.push(`AGX has ${totalMat} materials in the catalog (${recentMat} purchased in the last 90 days). Top categories: ${topCats.join(', ') || '(uncategorized)'}.`);
      lines.push('Call `read_materials` to query this catalog before quoting any materials line item — see the # Pricing rules above.');
      lines.push('**Search budget: cap reads at ~3 per scope of work.** If a query returns nothing, do NOT keep narrowing forever — go ahead and quote with a reasonable estimate, mark the line `unit_cost source: estimated (catalog miss)`, and tell the user the SKU isn\'t logged yet so they can add it later. The catalog is small and many real SKUs are missing.');
      lines.push('');
    }
  } catch (e) { /* materials table may not exist yet on a fresh deploy */ }

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
  // Section overrides loaded first so each named block can be admin-
  // replaced via a skill pack with `replaces_section` set. See
  // SECTION_DEFAULTS for the registry.
  const sectionOverrides = await loadSectionOverridesFor('ag');
  renderSection(stableLines, 'ag_identity', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_estimate_structure', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_role', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_tools', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_slotting', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_pricing', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_auto_reads', sectionOverrides);
  stableLines.push('');
  renderSection(stableLines, 'ag_web_research', sectionOverrides);
  stableLines.push('');

  // Load admin-editable skill packs targeted at AG. Stable across the
  // 5-min cache window since admins rarely edit them mid-session.
  // Pass turn context so packs with triggers (e.g. min_groups, has_lead)
  // can load conditionally instead of always.
  const triggerCtx = {
    group_count: alternates.length,
    has_lead: !!blob.lead_id,
    has_client: !!blob.client_id
  };
  const skillBlocks = await loadActiveSkillsFor('ag', triggerCtx);
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

  // Tone — overridable via section_id `ag_tone`. See SECTION_DEFAULTS.
  renderSection(stableLines, 'ag_tone', sectionOverrides);

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
    aiPhase: aiPhase,
    packsLoaded: skillBlocks.map(s => s.name)
  };
}

// Filter the AG tool list for Plan mode — drops every editing-style
// propose_* tool while keeping conversational + scope-capture + note
// + web search. Build mode passes through the full list. Used by the
// AG chat + continue handlers; web tools are added back by runStream.
const PLAN_MODE_ALLOWED_AG_TOOLS = new Set([
  'propose_update_scope',
  'propose_add_client_note',
  // Reads stay available so AG can research before proposing.
  'read_materials',
  'read_purchase_history',
  'read_subs',
  'read_lead_pipeline',
  'read_clients',
  'read_leads',
  'read_past_estimate_lines',
  'read_past_estimates'
]);
function filterToolsForPhase(tools, phase) {
  if (phase !== 'plan') return tools;
  return (tools || []).filter(t => PLAN_MODE_ALLOWED_AG_TOOLS.has(t.name));
}

// Plan-mode allowlist for Elle (job side). Read tools + the
// request_build_mode tool stay; every write tool is removed so the
// model literally cannot mutate WIP data while the PM is in analysis
// mode. The PM grants write access by approving a request_build_mode
// card or flipping the phase pill manually.
const PLAN_MODE_ALLOWED_JOB_TOOLS = new Set([
  'read_workspace_sheet_full',
  'read_qb_cost_lines',
  'read_materials',
  'read_purchase_history',
  'read_subs',
  'read_building_breakdown',
  'read_job_pct_audit',
  'request_build_mode'
]);
function filterToolsForJobPhase(tools, phase) {
  if (phase !== 'plan') return tools;
  return (tools || []).filter(t => PLAN_MODE_ALLOWED_JOB_TOOLS.has(t.name));
}

// Load skill packs from app_settings.agent_skills filtered by agent +
// alwaysOn. Returns an array of {name, body} blocks ready to append to
// the system prompt. Failures (no setting yet, malformed JSON) return
// an empty array — the agent still works, just without the playbooks.
//
// `triggerCtx` is an optional object providing facts about the current
// turn (e.g., { has_groups_min: 2, is_linked: true }). When a pack
// declares triggers (currently supports `min_groups` for AG — load
// only when the estimate has at least N groups), this context is
// matched against them. Packs without triggers always load
// (alwaysOn baseline).
async function loadActiveSkillsFor(agentKey, triggerCtx) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'agent_skills'`
    );
    if (!rows.length) return [];
    const cfg = rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
    // alwaysOn packs append AT THE END of the system prompt. Section
    // overrides (replaces_section set) are loaded separately by
    // loadSectionOverridesFor and inserted INLINE at named anchor
    // points — exclude them from the always-on append list so we
    // don't double-load.
    return skills
      .filter(s => s && s.alwaysOn !== false && Array.isArray(s.agents) && s.agents.indexOf(agentKey) >= 0 && s.body && !s.replaces_section)
      .filter(s => packTriggersPass(s.triggers, triggerCtx))
      .map(s => ({ name: s.name || '(untitled skill)', body: s.body, category: s.category || null }));
  } catch (e) {
    console.error('loadActiveSkillsFor error:', e);
    return [];
  }
}

// Evaluate a pack's triggers object against the current turn's context.
// Returns true when the pack should load. Empty/missing triggers always
// pass (preserves alwaysOn semantics for packs without conditions).
//
// Supported triggers (extend here as needs surface):
//   min_groups   number  — load only when ctx.group_count >= min_groups
//   has_lead     bool    — load only when the estimate is linked to a lead
//   has_client   bool    — load only when the estimate is linked to a client
function packTriggersPass(triggers, ctx) {
  if (!triggers || typeof triggers !== 'object') return true;
  ctx = ctx || {};
  if (typeof triggers.min_groups === 'number' && (ctx.group_count || 0) < triggers.min_groups) return false;
  if (triggers.has_lead === true && !ctx.has_lead) return false;
  if (triggers.has_client === true && !ctx.has_client) return false;
  return true;
}

// ──────────────────────────────────────────────────────────────────
// Section-override mechanism — admin can replace specific named blocks
// of the stable prefix without touching code. Each replaceable block
// has a stable section_id, a default body, and a description for the
// admin UI. Skill packs with `replaces_section: <id>` substitute their
// body for that block's default at render time. Falls back to default
// when no override exists.
//
// To add a new replaceable block:
//   1. Add an entry to SECTION_DEFAULTS below with default body text.
//   2. In the relevant buildXContext function, replace the inline
//      stableLines.push(...) calls with renderSection(stableLines,
//      agentKey, sectionId, overrides).
// ──────────────────────────────────────────────────────────────────
const SECTION_DEFAULTS = {
  ag_identity: {
    agent: 'ag',
    description: "Who AG is and what AGX does. Edit when AGX's company description / market changes.",
    body: '# Who you are\nYou are AG — AGX\'s estimating teammate. AGX = AG Exteriors, a Central-Florida construction-services company (painting, deck repair, roofing, exterior services for HOAs and apartment communities). You estimate like a senior PM: specific, trade-fluent, opinionated about scope completeness, calibrated on Central-FL pricing.'
  },
  ag_estimate_structure: {
    agent: 'ag',
    description: 'How AG should think about Group / Subgroup / Line hierarchy. Edit if the estimate model changes.',
    body: '# Estimate structure\nEstimates are organized as Groups → Subgroups → Lines.\n  • Group (a.k.a. "alternate" in older code/UI): a named scope block on the estimate. Examples: "Deck 1", "Deck 2", "Roof", "Optional Adds". Each group has its own scope of work and its own line items. The proposal renders each INCLUDED group as its own block; excluded groups are dropped entirely from both the proposal and the total.\n  • Subgroup (a.k.a. "section header" in code): one of the four cost categories — Materials & Supplies, Direct Labor, General Conditions, Subcontractors — under each group. Subgroup markup % is the baseline that lines under it inherit.\n  • Line: a single cost-side row (description, qty, unit, unit cost, optional per-line markup override) inside a subgroup.\nWhen the user creates a new group, the four standard subgroups auto-seed with AGX-typical markups (Materials 20, Labor 35, GC 25, Subs 10).'
  },
  ag_role: {
    agent: 'ag',
    description: "AG's role and behavior expectations. Edit to change how proactive vs reactive AG should be.",
    body: '# Your role\n- Help the PM think through scope, materials, sequencing, and gotchas.\n- Spot missing line items, suggest items to add, flag risks (access, height, weather, code).\n- Cite cost-side prices. Markup is per-subgroup — each subgroup header carries its own markup % that lines under it inherit. The line listing in the estimate context below shows each subgroup\'s markup so you can see what the user has set.\n- Don\'t just add — also EDIT and DELETE. If you spot a duplicate, a line in the wrong subgroup, a typo, a stale qty/cost, or a subgroup that\'s been renamed elsewhere, propose the cleanup directly via the right tool below.'
  },
  ag_tools: {
    agent: 'ag',
    description: "AG's tool catalog. Code-side description of every propose_* tool. Edit to change tool guidance — but new tools must still be defined in code.",
    body: '# Your tools (every proposal is approval-required — user clicks Approve/Reject)\nAll tool names still say "section" — that\'s the legacy code name for what the UI now calls "subgroup". They behave identically regardless of name.\n  • propose_add_line_item — add a single cost-side line under a named subgroup (use the subgroup\'s display name)\n  • propose_update_line_item — change description/qty/unit/cost/markup, or move a line to a different subgroup\n  • propose_delete_line_item — remove a line by line_id\n  • propose_add_section — add a new subgroup header (set markup_pct based on AGX typical: Materials 20, Labor 35, GC 25, Subs 10)\n  • propose_update_section — rename a subgroup, change BT category, change subgroup markup\n  • propose_delete_section — remove a subgroup header (lines under it stay; they fall under the previous subgroup)\n  • propose_update_scope — set or append the ACTIVE GROUP\'s scope of work (each group has its own scope)\n  • propose_switch_active_group — switch which group is active. Subsequent line/scope edits target the new active group. Use this when the user pivots ("now let\'s work on the roof") instead of quietly slotting under the wrong group.\n  • propose_add_group — create a new group (auto-seeds the four standard subgroups; copy_from_active=true clones the active group\'s lines).\n  • propose_rename_group / propose_delete_group / propose_toggle_group_include — rename, drop, or toggle a group\'s contribution to the grand total (Good/Better/Best support).\n  • propose_link_to_client / propose_link_to_lead / propose_update_estimate_field — link an unlinked estimate (use read_clients / read_leads first) and update top-level metadata (title, salutation, markup_default, bt_export_status, notes).\n  • propose_bulk_update_lines / propose_bulk_delete_lines — change or remove the same fields on N lines in one approval card. Use for "move every paint-related line to Subcontractors" or 5+ duplicate cleanups.\nEvery line and subgroup has an id shown in the estimate context below; use those exact ids when calling update/delete tools. The ACTIVE group is where new lines and scope edits land — switch first via propose_switch_active_group when the user pivots scope. Make multiple parallel proposals when batching — one approval card per call, with a bulk Approve-all.'
  },
  ag_slotting: {
    agent: 'ag',
    description: 'How AG slots line items into the four standard subgroups. THE most-edited rule when AGX changes how it categorizes work.',
    body: '# Slotting rules — STRICT\nEvery line item belongs in exactly one of the four standard subgroups. Choose by what the line IS, not who pays for it:\n  • Materials & Supplies Costs — any physical good AGX buys. Lumber, fasteners, paint, primer, caulk, sealant, hardware, fixtures, finishes, sundries, blades, abrasives, masking, drop cloths.\n  • Direct Labor — hours of AGX\'s own crew. Demo, prep, install, finish, cleanup. Per-trade unit-rate labor (e.g., "deck board install" labor) belongs here, not Subs.\n  • General Conditions — project overhead. Mobilization, demobilization, dump/disposal fees, permits + permit runner, supervision, project management, equipment rental (lifts, scaffolding, dumpsters), signage, port-a-john, fuel, daily site protection.\n  • Subcontractors Costs — scopes AGX hands off to another company under contract. A roof sub, paint sub, tile sub, electrical sub, etc. If AGX\'s own crew does the work, it\'s Direct Labor — not Subs.\nAlways pass section_name on propose_add_line_item — it gates BT export categorization. Only call propose_add_section when the user explicitly asks for a CUSTOM subgroup outside these four (rare).'
  },
  ag_pricing: {
    agent: 'ag',
    description: 'Pricing discipline — when to use catalog vs guess. Edit when AGX standard markups change or the data sources change.',
    body: '# Pricing rules\n- AGX cost-side prices for Central-FL construction. Quantities should be specific (calculated from photos / scope when possible).\n- **Use real AGX purchase data, not guesses.** AGX has a materials catalog populated from actual purchase history (Home Depot + other vendors). Call the `read_materials` tool with a tight keyword BEFORE quoting any line item that has materials cost. Use the returned `last_unit_price` (most recent AGX purchase) or `avg_unit_price` (smoothed) — not training-data memory. If the SKU isn\'t in the catalog, say so in your rationale and quote a defensible Central-FL number with a note that we should log the purchase next time.\n- Subgroup markup typical: Materials 20%, Labor 35%, GC 25%, Subs 10%. Per-line markup overrides the subgroup only when there\'s a real reason (special-order item priced higher, or a loss-leader line).\n- Always include a rationale on each proposal — it\'s shown to the user on the approval card. When the unit cost came from `read_materials`, mention "from catalog (last seen YYYY-MM-DD, Nx purchases)" so the PM knows the number is grounded.'
  },
  ag_auto_reads: {
    agent: 'ag',
    description: 'Auto-tier read tools — code-side description. Edit to change usage guidance for read_materials, read_subs, etc.',
    body: '# Auto-tier read tools (no approval, run as inline chips)\n  • `read_materials(q?, subgroup?, category?, limit?)` — catalog summary: description, SKU, unit, last/avg/min/max prices, last-seen, purchase count. Use BEFORE quoting any materials line. Most specific keyword you can — "5/4 PT decking", "Hardie lap 8.25", "joist hanger 2x10".\n  • `read_purchase_history(material_id?, q?, days?, job_name?, limit?)` — receipt-level rows for a SKU. Use to spot trends ("is this getting more expensive?"), find which jobs used a SKU, or answer "what did we pay last time?".\n  • `read_subs(q?, trade?, status?, with_expiring_certs?, limit?)` — subcontractor directory with cert (GL / WC / W9 / Bank) expiry. Use when scoping to a sub: confirm they\'re active and paperwork-current. with_expiring_certs=true for pre-bid audit.\n  • `read_lead_pipeline(q?, status?, market?, salesperson_email?, limit?)` — leads list + status rollup. Use for sibling context ("what other deck jobs are in pipeline?") or pipeline-shape questions.\n  • `read_clients(q?, limit?)` — client directory lookup keyed for linking. Use BEFORE propose_link_to_client when an estimate is unlinked and the user mentions a client name.\n  • `read_leads(q?, status?, limit?)` — direct lead lookup. Use BEFORE propose_link_to_lead.\n  • `read_past_estimate_lines(q, days?, limit?)` — pricing benchmark across past AGX estimates. Returns matching line descriptions with unit_cost + median/range across all matches. Use BEFORE quoting a labor or sub line so the unit_cost is anchored to AGX history. (Materials still come from read_materials — those are real receipts.) If 0 matches, mark "first-time line — no AGX history yet" and quote a defensible Central-FL number.\n  • `read_past_estimates(q?, status?, days?, limit?)` — past estimate lookup by title + linked client. Use to find a recent comparable estimate to model the new one on.\nCap auto-tier reads at ~4 per turn for normal estimates; only chain more for big batched line-item drafts. Each chip costs no approval but does cost API tokens.\n**Hard rule — no read loops.** If a `read_materials` query comes back empty or sparse, DO NOT keep retrying narrower queries. Quote the line with a defensible Central-FL estimate, mark the rationale "estimated — SKU not in catalog yet (catalog miss)", and move on. The catalog is small; missing SKUs are normal. After ~3 read_materials calls in a row without producing a propose_*, the panel will hard-stop the loop on you.'
  },
  ag_web_research: {
    agent: 'ag',
    description: 'When AG should use web search. Edit to tune how aggressive AG is with external research.',
    body: '# Web research (web_search tool)\nYou have a web_search tool. Use it judiciously — it adds a few seconds and a small cost per call. Good reasons to search:\n  • Material specs / SKUs the user references (e.g., "Trex Transcend Spiced Rum" — confirm board dimensions, install method, current MSRP at Home Depot / Lowe\'s).\n  • Manufacturer install guides when scope hinges on a method detail (Hardie siding nailing schedule, GAF roofing underlayment requirements).\n  • Current Central-FL labor / material price benchmarks when the user asks for a quick gut-check on a number.\n  • Code or permit references (FBC chapter X requires Y) when the line item depends on it.\nDo NOT search for things already answered in the estimate context, the loaded skills, or your own trade knowledge. Cap usage at ~2 searches per turn unless the user explicitly asks for deeper research. Cite sources briefly when you use a search result to support a number or claim.'
  },
  ag_tone: {
    agent: 'ag',
    description: "AG's tone and style preferences. Edit when the agent feels too corporate, too terse, or too verbose.",
    body: '# Tone\n- Concise. Trade vocabulary welcome. Mix prose with proposals — short lead-in, the cards, a one-line wrap-up. Don\'t emit proposals without any explanation. If you need one piece of info to answer well, ask one targeted question first.'
  },
  // ──── Elle (job-side WIP analyst) ────────────────────────────────
  elle_role: {
    agent: 'job',
    description: "Elle's role and what tools she should use. Edit to change how aggressive Elle is at proposing changes vs analyzing only.",
    body: '# Your role\n- Read the WIP snapshot, change orders, cost lines, node graph, and QB cost data together — they tell a story about whether the job is healthy.\n- Spot mismatches: % complete way ahead of revenue earned (under-pulled progress), revenue earned way ahead of invoiced (under-billed), JTD margin diverging from revised margin (cost overruns), large recurring vendors that should have been a CO, QB lines unlinked to graph nodes.\n- When citing dollar figures, match the field name from the snapshot above so the PM can find them in the UI.\n- **You CAN make changes.** Available tools: `create_node` (add a new graph node — t1/t2/cost-bucket/sub/po/inv/co/watch/note), `delete_node` (remove a node + its wires — does NOT delete underlying job data), `set_phase_pct_complete`, `set_phase_field` (materials/labor/sub/equipment dollars on a PHASE record from # Structure), `set_node_value` (QB Total / value on a cost-bucket NODE from # Node graph — labor/mat/gc/other/sub/burden), `wire_nodes` (connect graph nodes), `assign_qb_line` (link a QB cost line to a graph node), `read_workspace_sheet_full` and `read_qb_cost_lines` (auto-apply, no approval). Each writer tool writes a proposal card the user approves; trusted tool types auto-apply after a 5s countdown.\n- **set_phase_field vs set_node_value — DO NOT MIX THEM UP.** `set_phase_field` writes to a phase record (phase_id from # Structure, e.g. "ph_..."). `set_node_value` writes the QB Total field to a graph node (node_id from # Node graph, e.g. "n38"). When the user says "load the QB Materials & Supplies total into the Materials node" or similar, that is `set_node_value` on a `mat` node — passing a node id like "n38" to `set_phase_field` will fail because n38 is not in appData.phases.\n- **Every block above is LIVE for this turn** — node graph, QB cost lines, workspace sheets all rebuild from the client on every user message and every tool_use continuation. If something was just created/edited, it\'s in the data above. NEVER say "I can\'t see new X" or "the snapshot is stale" or "you need to refresh the session" — those statements are factually wrong about how this assistant works.\n- When the user references a node/sheet/line by name and you can\'t find it, search the relevant block by case-insensitive partial match before asking — it\'s usually there.\n- Be concise and direct. Construction trade vocabulary is welcome. If you need one piece of info to answer well, ask one targeted question first.'
  },
  elle_web_research: {
    agent: 'job',
    description: "When Elle should use web search. Tighter than AG since most answers are in the WIP / QB data already.",
    body: '# Web research (web_search tool)\nYou have a web_search tool. Use it sparingly on the job side — most answers are already in the WIP snapshot, change orders, QB cost lines, and node graph above. Good reasons to search:\n  • Look up a recurring vendor name to figure out what trade/category they serve when the QB account label is ambiguous (e.g., "is ACME Supply Co a roofing supplier or a general lumberyard?").\n  • Confirm a sub\'s scope or licensing when categorizing their cost lines.\n  • Look up a product/material SKU charged to the job when the PM asks "what did we buy here?".\nDo NOT search for AGX-internal financial questions, margin math, or anything answered by the data above. Cap at ~2 searches per turn.'
  },
  // ──── HR (customer relations / client directory) ─────────────────
  hr_about_agx: {
    agent: 'cra',
    description: 'About AGX and its customer types. Edit if AGX expands into new customer segments or markets.',
    body: '# About AGX\nAG Exteriors is a Central-Florida construction-services company (painting, deck repair, roofing, exterior services). AGX\'s customers are overwhelmingly:\n  1. Property-management companies running multifamily/apartment portfolios\n  2. HOA / condo associations (often managed BY one of those property-management firms)\nGeographic markets: Tampa, Orlando, Sarasota/Bradenton, Brevard (Space Coast), Lakeland, The Villages.'
  },
  hr_hierarchy: {
    agent: 'cra',
    description: 'The two-level parent/property hierarchy model. Critical — edit only if the data model changes.',
    body: '# The hierarchy model — CRITICAL\nThe directory has TWO and only two levels:\n  • Parent management company (top-level, no parent_client_id) — the corporate billing entity.\n     Examples: "Preferred Apartment Communities" (PAC), "Associa", "FirstService Residential" (FSR),\n     "Greystar", "RangeWater Real Estate", "Bainbridge", "Lincoln Property Company", "Camden",\n     "ZRS Management", "Cushman & Wakefield", "RPM Living", "BH Management", "Pinnacle".\n     Holds: corporate mailing address, billing contact, AP email.\n  • Property / community (parent_client_id set to a parent above) — the physical site we do work at.\n     Examples: "Solace Tampa", "City Lakes", "Wimbledon Greens HOA", "Saddlebrook".\n     Holds: property_address (the site), on-site CAM, on-site maintenance manager, gate code, market.\nA row is EITHER a parent OR a property — never both. If a row carries both kinds of data, it needs split_client_into_parent_and_property.'
  },
  hr_field_semantics: {
    agent: 'cra',
    description: 'Field-by-field meaning for client records. Edit if columns are added or repurposed.',
    body: '# Field semantics\n  • name              → display name (parent company name OR property name)\n  • company_name      → on properties: the parent\'s name (informational; parent_client_id is the real link)\n  • community_name    → formal community name (often same as name on properties; blank on parents)\n  • address/city/state/zip → mailing/billing address (parent\'s corporate office OR property\'s billing-to)\n  • property_address  → PHYSICAL site address — properties only, never parents\n  • community_manager (CAM) + cm_email + cm_phone → on-site site manager — properties only\n  • maintenance_manager + mm_email + mm_phone     → on-site maintenance lead — properties only\n  • market            → submarket label (Tampa, Orlando, Sarasota, Brevard, Lakeland)\n  • salutation        → how proposal letters greet them ("PAC Team", "Wimbledon Greens HOA Board", "Jane")\n  • client_type       → "Property Mgmt" for parents, "Property" for properties'
  },
  hr_bt_patterns: {
    agent: 'cra',
    description: 'Patterns to recognize when importing from Buildertrend. Edit when AGX onboards new property-management firms.',
    body: '# Buildertrend import patterns to recognize\nAGX imports clients from Buildertrend exports. Common name patterns that REVEAL parent+property structure:\n  • "PAC - Solace Tampa"           → parent "Preferred Apartment Communities", property "Solace Tampa"\n  • "Associa | Wimbledon Greens"   → parent "Associa", property "Wimbledon Greens"\n  • "FSR — City Lakes"             → parent "FirstService Residential", property "City Lakes"\n  • "Greystar / The Reserve"       → parent "Greystar", property "The Reserve"\nSeparators that signal a split: " - ", " – ", " — ", " | ", " / ", "::". A separator + a known abbreviation on the left = always a parent+property pair.\nCommon abbreviations: PAC=Preferred Apartment Communities, FSR=FirstService Residential, RPM=RPM Living, LPC=Lincoln Property Company, C&W=Cushman & Wakefield.'
  },
  hr_dedup_rules: {
    agent: 'cra',
    description: 'Rules HR uses to detect duplicate client entries. Tighten or loosen depending on how aggressive merging should be.',
    body: '# Duplicate-detection rules\nTreat as the same client (propose merge) when ANY of these match:\n  • Same email on community_manager AND it is a property-level email (not a generic billing@ inbox)\n  • Same property_address (street + city)\n  • Same phone number after normalizing formatting (strip parens/dashes/spaces)\n  • Names differ only by: case, leading/trailing whitespace, "Inc"/"LLC"/"LLC."/"L.L.C.", "Inc." vs "Incorporated", trailing "HOA" / "Owners Association" / "Condo Assoc.", curly vs straight apostrophe, em-dash vs hyphen, &amp; vs "and"\n  • Names where one is an abbreviation expansion of the other (PAC ↔ Preferred Apartment Communities)\nWhen you see a parent name with multiple spelling variants across the directory, rename them to the canonical form (the most common / formal version).'
  },
  hr_behavior: {
    agent: 'cra',
    description: "How HR should batch tool calls and run audits. Edit to make HR more conservative or more aggressive.",
    body: '# Behavior rules\n  • Prefer linking a new property under an EXISTING parent over creating a new parent. Always scan the directory below for a fuzzy parent match BEFORE calling create_parent_company.\n  • Be efficient. Chain auto-tier tools (create_property, link_property_to_parent, update_client_field) in batches with no preamble. The system applies them in order; results stream back as ✓ chips.\n  • Group related approval-tier changes in ONE batch so the user can approve in bulk via the bulk-approve button.\n  • When you spot a property whose stored company_name points at an EXISTING parent in the directory, you do not need to ask — link it via link_property_to_parent (auto-tier).\n  • When you spot a flat client whose name is a clear parent+property compound, propose split_client_into_parent_and_property. If the parent already exists, pass existing_parent_id so we reuse instead of duplicating.\n  • When merging duplicates, ALWAYS pick the row with more populated fields as keep_client_id and fold the sparser row in.\n  • After a batch of changes, give the user a one-line summary in plain text. Skip narration — they want results, not commentary.\n  • If asked to "run a full audit": work the directory in this order — (1) split obvious parent+property compounds, (2) link unparented children to existing parents, (3) merge clear duplicates, (4) flag (in chat, no tool call) the rest as ambiguous for the user to decide on.'
  },
  hr_web_research: {
    agent: 'cra',
    description: "How aggressive HR should be with web search (high — directory data is often stale).",
    body: '# Web research (web_search tool)\nYou have a web_search tool. The HR role is the highest-value place to use it — Central-FL property management is constantly reorganizing, and the directory often has stale or ambiguous data. Good reasons to search:\n  • Confirm a parent-company / property relationship before linking (e.g., "Is Solace Tampa managed by PAC or by Bainbridge?" — search the property name + "managed by").\n  • Find the current canonical name for a parent company before renaming variants (e.g., "Preferred Apartment Communities" merged with another entity — look up the current corporate name).\n  • Look up a property\'s physical address when only the community name is known and we need to populate property_address.\n  • Find a property\'s on-site CAM or maintenance manager from a public LinkedIn / management-company website / apartments.com listing when we have a name but no email/phone.\n  • Resolve abbreviation ambiguity — "RPM" could be RPM Living OR a regional smaller firm. Search before guessing.\nCap at ~3 searches per turn. When a search result drives a propose_* call, include a brief source citation in the rationale shown on the approval card so the user can audit.'
  },
  hr_tool_tiers: {
    agent: 'cra',
    description: 'HR tool list with auto vs approval tier annotation. Edit only when adding/removing tools in code.',
    body: '# Tool tiers — system handles the gating, you just call\n  AUTO (applies immediately, model continues in same turn):\n    create_property, update_client_field, link_property_to_parent\n  APPROVAL (user clicks Approve/Reject before applying):\n    create_parent_company, rename_client, change_property_parent,\n    merge_clients, split_client_into_parent_and_property, delete_client,\n    attach_business_card_to_client'
  },
  hr_photos: {
    agent: 'cra',
    description: "Workflow when the user uploads a business card photo. Edit to change how aggressively HR auto-creates entries.",
    body: '# Photos / business cards\nWhen the user uploads a photo (visible to you in this turn as an inline image):\n  1. READ it. If it\'s a business card, extract: name, title, company, email, phone, address.\n  2. MATCH to an existing client. Compare the extracted name/email/phone/company against the directory below. If the company on the card matches a parent management company and the title implies the cardholder is a CAM/manager at a property, look for that property under the parent. If the property does not exist yet, propose create_property.\n  3. UPDATE missing fields on the matched client (community_manager / cm_email / cm_phone / first_name / last_name / etc.) via update_client_field — auto-tier, just call.\n  4. PROPOSE attach_business_card_to_client to save the photo to that client\'s attachments. Include a caption like "Business card — Jane Smith, CAM at Solace Tampa". Approval-tier — user confirms the match.\nOnly call attach_business_card_to_client ONCE per uploaded card — the image is consumed from the pending bucket.'
  },
  // ──── Chief of Staff (system-wide observability agent) ───────────
  cos_three_agents: {
    agent: 'staff',
    description: "Description of the three in-app agents (AG / Elle / HR). Edit when adding a new agent or renaming one.",
    body: '# Who the three agents are\n  • **AG (estimate-side)** — helps PMs draft scopes, propose line items with AGX-typical Central-FL pricing, and edit the estimate via approval-gated tools. Heavy vision use (photos, PDFs of RFPs / takeoffs).\n  • **Elle (job-side)** — WIP analyst on live jobs. Reads WIP snapshot, change orders, QB cost lines, and the node graph; spots margin issues, missing COs, billing gaps.\n  • **HR (customer-side)** — owns the customer directory. Splits parent+property compounds, links unparented properties, merges duplicates, attaches business cards, and writes durable client notes. Internal entity_type is "client" and skill-pack agentKey is "cra" (both kept for back-compat); display name is HR.\nAll three log into the same ai_messages table (different entity_type values).'
  },
  cos_how_to_work: {
    agent: 'staff',
    description: "How Chief of Staff should approach analysis tasks. Edit to make CoS more or less proactive about proposing changes.",
    body: '# How to work\n- Default to data first. When asked "how is AG doing?", call `read_metrics` and report concrete numbers, not opinions.\n- Drill before generalizing. If you spot something odd in metrics, pull recent conversations and inspect a few before proposing a theory.\n- When citing a conversation, include the user and the entity title so the admin can locate it.\n- When proposing a skill pack, write tight, specific instructions — every always-on pack costs tokens on every turn forever. Propose deletions of stale ones too.\n- **Always close the loop with a brief summary after a tool runs.** When an approval-tier tool (skill pack add/edit/delete) executes, you receive its result as a tool_result block. Respond with a one- or two-sentence confirmation of what happened and what (if anything) the user should do next. NEVER end a turn with a tool_result and no follow-up text — the panel renders an empty turn as "(no response)" which looks broken.\n- Be candid about limits. You can\'t replay conversations directly from your tools (the admin runs replays manually from Admin → Agents → Conversations → 🔁 Replay), but you can suggest exact replay parameters (model, effort, system_prefix) when a question would benefit from one.\n- Skip the assistant filler. The admin is technical; lead with the answer.'
  },
  cos_tone: {
    agent: 'staff',
    description: "Chief of Staff tone preferences.",
    body: '# Tone\n- Concise, structured (bullets and short paragraphs over walls of text). Quote token / dollar / count numbers exactly. If a tool call returned an empty result, say so.'
  }
};

async function loadSectionOverridesFor(agentKey) {
  try {
    const { rows } = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'agent_skills'`
    );
    if (!rows.length) return {};
    const cfg = rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
    const result = {};
    skills.forEach(s => {
      if (!s || !s.replaces_section || !s.body) return;
      if (!Array.isArray(s.agents) || s.agents.indexOf(agentKey) < 0) return;
      // Last write wins if two packs target the same section. Admin UI
      // should warn before saving such a config.
      result[s.replaces_section] = s.body;
    });
    return result;
  } catch (e) {
    console.error('loadSectionOverridesFor error:', e);
    return {};
  }
}

// Append a named section to the stable-prefix lines array. Uses an
// override body if one exists, otherwise the default from SECTION_DEFAULTS.
// No-op if neither exists (defensive).
function renderSection(stableLines, sectionId, overrides) {
  const override = overrides && overrides[sectionId];
  if (override) { stableLines.push(override); return; }
  const def = SECTION_DEFAULTS[sectionId];
  if (def && def.body) stableLines.push(def.body);
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

async function runStream({ anthropic, res, system, messages, persistAssistantText, persistArgs, tools, agentKey }) {
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
  const _effort = effortClause(agentKey);
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
async function saveAssistantMessage({ estimateId, userId, text, usage, packsLoaded }) {
  const id = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const packsJson = (Array.isArray(packsLoaded) && packsLoaded.length) ? JSON.stringify(packsLoaded) : null;
  await pool.query(
    `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, model,
                              input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens,
                              packs_loaded)
     VALUES ($1, $2, $3, 'assistant', $4, $5, $6, $7, $8, $9, $10::jsonb)`,
    [id, estimateId, userId, text, MODEL,
     usage.input_tokens, usage.output_tokens,
     usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null,
     packsJson]
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
        agentKey: 'ag',
        persistAssistantText: async (text, usage) => {
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage, packsLoaded: ctx.packsLoaded });
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
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage, packsLoaded: ctx.packsLoaded });
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
// Phase 1b — v2 chat path (Anthropic Sessions API)
//
// Replaces anthropic.messages.stream with a long-lived Anthropic Session
// per (agent, entity, user). The Session inherits the agent's
// pre-registered system prompt + tools + skills, so we no longer ship
// the stable prefix on every request — the API handles that internally
// via prompt caching + automatic compaction.
//
// Per-turn dynamic context (estimate snapshot, photos) is wrapped in
// <turn_context> tags inside the user message instead of being
// injected as a system prefix.
//
// Gated behind the AGX_AGENT_MODE_AG=agents env var so the production
// path (above) stays the default until the v2 path is verified.
//
// Output is adapted to the same SSE event shape the client already
// consumes — { delta }, { tool_use }, { awaiting_approval, … },
// { done, … }, [DONE] — so the only client change in Phase 1c is
// switching the URL.
// ════════════════════════════════════════════════════════════════════

const FLAG_AGENT_MODE_AG = (process.env.AGX_AGENT_MODE_AG || '').toLowerCase() === 'agents';

// Three of our four context builders return `system` as an array of
// TextBlockParam objects (with cache_control on the first block);
// buildJobContext returns it as a plain string. The v2 path embeds
// it in a `<turn_context>` wrapper inside the user message, so we
// need a single string. Coerce here — string passes through, array
// gets its text blocks concatenated.
function ctxSystemToText(systemArr) {
  if (typeof systemArr === 'string') return systemArr;
  if (!Array.isArray(systemArr)) return '';
  return systemArr
    .map(b => (b && b.type === 'text' && typeof b.text === 'string') ? b.text : '')
    .join('');
}

// Look up or create the long-lived Session for one (agent, entity,
// user) tuple. Race-safe via the unique partial index on ai_sessions.
async function ensureAiSession({ agentKey, entityType, entityId, userId }) {
  const found = await pool.query(
    `SELECT * FROM ai_sessions
       WHERE agent_key = $1
         AND entity_type = $2
         AND COALESCE(entity_id, '') = COALESCE($3, '')
         AND user_id = $4
         AND archived_at IS NULL`,
    [agentKey, entityType, entityId, userId]
  );
  if (found.rows.length) return found.rows[0];

  return createFreshAiSession({ agentKey, entityType, entityId, userId });
}

// Create a brand-new Anthropic session row + DB row for the given tuple.
// Extracted so we can recover from stuck sessions (e.g. requires_action
// state inherited from a prior broken bootstrap) by archiving the
// previous row and creating a fresh one in its place.
async function createFreshAiSession({ agentKey, entityType, entityId, userId }) {
  // Lazy require avoids the ai-routes ↔ admin-agents-routes cycle at
  // module-load time (admin-agents pulls ai-routes-internals).
  const adminAgents = require('./admin-agents-routes');
  const env = await adminAgents.ensureManagedEnvironment();
  const agent = await adminAgents.ensureManagedAgent(agentKey);
  const anthropic = getAnthropic();

  const created = await anthropic.beta.sessions.create({
    agent: agent.anthropic_agent_id,
    environment_id: env.anthropic_environment_id,
    title: 'AGX ' + agentKey + ' / ' + entityType + '/' + (entityId || 'staff') + ' (user ' + userId + ')'
  });

  try {
    const inserted = await pool.query(
      `INSERT INTO ai_sessions
         (agent_key, entity_type, entity_id, user_id, anthropic_session_id, anthropic_agent_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [agentKey, entityType, entityId, userId, created.id, agent.anthropic_agent_id]
    );
    return inserted.rows[0];
  } catch (e) {
    // Race: a parallel request inserted first. Archive the orphan
    // session we created and use the canonical row.
    try { await anthropic.beta.sessions.archive(created.id); } catch (_) {}
    const reread = await pool.query(
      `SELECT * FROM ai_sessions
         WHERE agent_key = $1
           AND entity_type = $2
           AND COALESCE(entity_id, '') = COALESCE($3, '')
           AND user_id = $4
           AND archived_at IS NULL`,
      [agentKey, entityType, entityId, userId]
    );
    if (reread.rows.length) return reread.rows[0];
    throw e;
  }
}

// Drive one Session turn: open the SSE stream, send the queued events
// (user message and/or tool results), translate session events to the
// existing v1 SSE shape, and persist the assistant text on terminal
// idle. Stream-first then send — see managed-agents-events.md.
// `onCustomToolUse` is an optional callback for the HR / CoS auto-tier
// pattern. It receives `{ id, name, input }` and returns one of:
//   { tier: 'auto', summary: 'text' }    — auto-execute succeeded; we
//                                            send the summary back to
//                                            the agent and the session
//                                            resumes
//   { tier: 'auto', error: 'text' }      — auto-execute failed; we send
//                                            an is_error result back
//   { tier: 'approval' }                  — surface the tool use to the
//                                            UI; collect it in
//                                            pendingToolUses and end on
//                                            the next idle
// When the callback is omitted (AG / Elle path), every custom_tool_use
// is treated as approval — matching today's behavior.
// Match the API's "session is stuck waiting for tool responses" error.
// Happens when a prior turn emitted agent.custom_tool_use events but
// the session never received the matching user.custom_tool_result —
// e.g., the request was aborted mid-stream, an exception killed the
// loop, or an earlier broken bootstrap left orphaned tool calls.
function isStuckSessionError(e) {
  return e && e.status === 400 &&
    /waiting on responses to events/.test(String(e.message || ''));
}

// Recovery: archive the stuck Anthropic-side session, mark the local
// row archived, and create a fresh session for the same (agent_key,
// entity_type, entity_id, user_id) tuple. Caller swaps the active
// session id and retries. Conversation history is lost (sessions are
// per-conversation server-side state) but ai_messages stays intact.
async function recoverStuckSession({ anthropic, sessionRow }) {
  console.warn('[v2-stream] recovering stuck session', sessionRow.anthropic_session_id);
  try { await anthropic.beta.sessions.archive(sessionRow.anthropic_session_id); }
  catch (e) { console.warn('Archive of stuck session failed (non-fatal):', e && e.message); }
  await pool.query('UPDATE ai_sessions SET archived_at = NOW() WHERE id = $1', [sessionRow.id]);
  return createFreshAiSession({
    agentKey: sessionRow.agent_key,
    entityType: sessionRow.entity_type,
    entityId: sessionRow.entity_id,
    userId: sessionRow.user_id
  });
}

async function runV2SessionStream({ anthropic, res, session, eventsToSend, persistAssistantText, onCustomToolUse }) {
  function send(payload) { res.write('data: ' + JSON.stringify(payload) + '\n\n'); }
  function endWithDone() { res.write('data: [DONE]\n\n'); res.end(); }

  let assistantText = '';
  const pendingToolUses = [];
  let usage = { input_tokens: null, output_tokens: null };
  // Diagnostic — counts each event type we see in this turn so a
  // failed/empty turn is debuggable from Railway logs without per-
  // request stack traces. Logged once at end-of-stream.
  const eventCounts = {};

  // Resolve the session id, recovering once if the prior session is
  // stuck waiting on tool responses. We have to attempt the events.send
  // before opening the stream when we recover, because the original
  // session id is now archived.
  let activeSession = session;
  let sessionId = session.anthropic_session_id;

  // Helper to (re)open stream + send events with stuck-state recovery.
  async function openStreamAndSend() {
    let stream;
    try {
      stream = await anthropic.beta.sessions.events.stream(sessionId);
      console.log('[v2-stream] opened', sessionId);
    } catch (e) {
      console.error('Session stream open failed:', e);
      send({ error: e.message || 'Failed to open session stream' });
      endWithDone();
      return null;
    }

    if (Array.isArray(eventsToSend) && eventsToSend.length) {
      try {
        await anthropic.beta.sessions.events.send(sessionId, { events: eventsToSend });
        console.log('[v2-stream] sent', eventsToSend.length, 'event(s) to', sessionId);
      } catch (e) {
        if (isStuckSessionError(e)) {
          // Stuck session: archive + recreate, then retry once.
          try {
            activeSession = await recoverStuckSession({ anthropic, sessionRow: activeSession });
            sessionId = activeSession.anthropic_session_id;
            // Re-open the stream against the new session id; the
            // previous stream is bound to the archived session.
            try {
              await stream.controller.abort();
            } catch (_) { /* best-effort */ }
            return openStreamAndSend();
          } catch (e2) {
            console.error('Stuck-session recovery failed:', e2);
            send({ error: 'Could not recover session: ' + (e2.message || 'unknown') });
            endWithDone();
            return null;
          }
        }
        console.error('Session events.send failed:', e);
        send({ error: e.message || 'Failed to send session events' });
        endWithDone();
        return null;
      }
    }
    return stream;
  }

  const stream = await openStreamAndSend();
  if (!stream) return;

  try {
    for await (const event of stream) {
      eventCounts[event.type] = (eventCounts[event.type] || 0) + 1;
      switch (event.type) {
        case 'agent.message': {
          // The session's agent.message arrives as a list of content
          // blocks (text, etc.). We forward each text block as a single
          // delta — coarser than the per-token v1 stream, but this is
          // the granularity the Sessions API exposes today.
          const blocks = Array.isArray(event.content) ? event.content : [];
          for (const b of blocks) {
            if (b && b.type === 'text' && typeof b.text === 'string') {
              assistantText += b.text;
              send({ delta: b.text });
            }
          }
          break;
        }
        case 'agent.custom_tool_use': {
          // Per managed-agents docs, the id we send back as
          // custom_tool_use_id is event.id (e.g. sevt_…), not a
          // toolu_… id.
          const tu = {
            id: event.id,
            name: event.tool_name || event.name || 'unknown',
            input: event.input || {}
          };
          // HR / CoS auto-tier path: callback decides whether we
          // execute server-side (and resume the session in-stream) or
          // collect for user approval (default behavior).
          if (typeof onCustomToolUse === 'function') {
            // Signal to the client that an auto-tool is starting NOW —
            // the read might take several seconds (read_metrics scans a
            // week of ai_messages, read_recent_conversations does a
            // grouped rollup, etc.) and without this the streaming
            // bubble sits silent the whole time.
            send({ tool_started: { id: tu.id, name: tu.name } });
            let decision;
            try {
              decision = await onCustomToolUse(tu);
            } catch (e) {
              decision = { tier: 'auto', error: 'Tool execution failed: ' + (e.message || 'unknown') };
            }
            if (decision && decision.tier === 'auto') {
              const isError = !!decision.error;
              const summary = isError ? decision.error : (decision.summary || 'Done.');
              if (isError) {
                send({ tool_failed: { id: tu.id, name: tu.name, input: tu.input, error: summary } });
              } else {
                send({ tool_applied: { id: tu.id, name: tu.name, input: tu.input, summary: summary.slice(0, 500) } });
              }
              try {
                await anthropic.beta.sessions.events.send(sessionId, {
                  events: [{
                    type: 'user.custom_tool_result',
                    custom_tool_use_id: tu.id,
                    content: [{ type: 'text', text: summary }],
                    is_error: isError || undefined
                  }]
                });
              } catch (e) {
                console.error('Failed to send tool result back to session:', e);
                send({ error: 'Failed to send tool result back to session: ' + (e.message || 'unknown') });
                endWithDone();
                return;
              }
              break; // continue iterating for the resumed agent events
            }
            // tier === 'approval' — surface to UI on next idle
          }
          pendingToolUses.push(tu);
          break;
        }
        case 'span.model_request_end': {
          if (event.model_usage) {
            usage = {
              input_tokens: event.model_usage.input_tokens,
              output_tokens: event.model_usage.output_tokens,
              cache_creation_input_tokens: event.model_usage.cache_creation_input_tokens,
              cache_read_input_tokens: event.model_usage.cache_read_input_tokens
            };
          }
          break;
        }
        case 'session.error': {
          const msg = (event.error && event.error.message) || 'Session error';
          send({ error: msg });
          endWithDone();
          return;
        }
        case 'session.status_terminated': {
          send({ error: 'Session terminated' });
          endWithDone();
          return;
        }
        case 'session.status_idle': {
          // Per managed-agents-client-patterns.md Pattern 5, only break
          // on idle when the stop_reason is terminal — `requires_action`
          // means the session is waiting on us. Our flow ends the HTTP
          // response either way (the client picks up the conversation
          // again on /chat/continue), but we use the stop_reason to
          // pick the SSE shape: tool-use awaiting vs. final done.
          const stopType = event.stop_reason && event.stop_reason.type;
          console.log('[v2-stream] idle', sessionId, 'stop_reason:', stopType,
            'pendingTools:', pendingToolUses.length,
            'assistantTextLen:', assistantText.length,
            'events seen:', JSON.stringify(eventCounts));
          if (pendingToolUses.length || stopType === 'requires_action') {
            for (const tu of pendingToolUses) {
              send({ tool_use: tu });
            }
            send({
              awaiting_approval: true,
              // Session is server-managed; client doesn't need to echo
              // the assistant content back on /chat/continue.
              pending_assistant_content: null,
              tool_use_count: pendingToolUses.length,
              usage: usage,
              session_id: sessionId
            });
          } else {
            if (assistantText && persistAssistantText) {
              try { await persistAssistantText(assistantText, usage); }
              catch (e) { console.error('persistAssistantText failed:', e); }
            }
            send({ done: true, usage: usage });
          }
          endWithDone();
          return;
        }
        default:
          // Ignore agent.thinking / span.* / agent.tool_use (built-in
          // tools; web_search is auto-handled). Add explicit cases here
          // when we need to surface them to the client.
          break;
      }
    }
  } catch (e) {
    console.error('Session stream iteration error:', e);
    send({ error: e.message || 'Stream failed' });
    endWithDone();
  }
}

// POST /api/ai/v2/estimates/:id/chat — Sessions-backed chat for AG.
// Body: { message, includePhotos, additional_images }
router.post('/v2/estimates/:id/chat',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    if (!FLAG_AGENT_MODE_AG) {
      return res.status(503).json({ error: 'v2 chat path is disabled. Set AGX_AGENT_MODE_AG=agents to enable.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const includePhotos = req.body && req.body.includePhotos !== false;
    const additionalImages = Array.isArray(req.body && req.body.additional_images)
      ? req.body.additional_images.slice(0, 12)
      : [];
    const estimateId = req.params.id;

    setSSEHeaders(res);

    try {
      const ctx = await buildEstimateContext(estimateId, includePhotos);

      // Inline images for this turn (estimate photos + per-turn additionals).
      const inlineImageBlocks = [...ctx.photoBlocks];
      additionalImages.forEach(b64 => {
        const block = inlineImageBlock(b64);
        if (block) inlineImageBlocks.push(block);
      });
      const cappedImages = inlineImageBlocks.slice(0, 18);

      // The agent's stable system prompt holds identity. Per-turn
      // dynamic context (estimate snapshot, lines, scope, photos
      // metadata) goes inside the user message wrapped in
      // <turn_context>. Images precede the text block per Anthropic
      // guidance. Plan/build phase is also surfaced here as a soft
      // guard — v1 hard-filters edit tools out of the request, but
      // v2 registers all tools at agent-create time, so we steer with
      // a strict instruction instead.
      const phaseGuard = ctx.aiPhase === 'plan'
        ? '<turn_phase>plan</turn_phase>\n[STRICT] You are in PLAN mode. Do NOT call any propose_* tool that mutates the estimate (line items, scope, sections, groups, links). You may only call read_* tools and answer in text. If the user asks for a change, describe what you would propose and tell them to switch to Build mode first.\n\n'
        : '<turn_phase>build</turn_phase>\n';
      const turnText =
        '<turn_context>\n' + ctxSystemToText(ctx.system) + '\n</turn_context>\n\n' + phaseGuard + userMessage;
      const userContent = cappedImages.length
        ? [...cappedImages, { type: 'text', text: turnText }]
        : [{ type: 'text', text: turnText }];

      const session = await ensureAiSession({
        agentKey: 'ag',
        entityType: 'estimate',
        entityId: estimateId,
        userId: req.user.id
      });
      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, estimate_id, user_id, role, content, photos_included)
         VALUES ($1, $2, $3, 'user', $4, $5)`,
        [userMsgId, estimateId, req.user.id, userMessage, ctx.photoBlocks.length]
      );

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend: [{ type: 'user.message', content: userContent }],
        onCustomToolUse: makeAgOnCustomToolUse(),
        persistAssistantText: async (text, usage) => {
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage, packsLoaded: ctx.packsLoaded });
        }
      });
    } catch (e) {
      console.error('AI v2 chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// POST /api/ai/v2/estimates/:id/chat/continue
// Body: { tool_results: [{ tool_use_id, approved, applied_summary?, reject_reason? }] }
// pending_assistant_content is NOT required — the session holds it.
router.post('/v2/estimates/:id/chat/continue',
  requireAuth, requireCapability('ESTIMATES_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    if (!FLAG_AGENT_MODE_AG) {
      return res.status(503).json({ error: 'v2 chat path is disabled.' });
    }
    const toolResults = req.body && req.body.tool_results;
    if (!Array.isArray(toolResults) || !toolResults.length) {
      return res.status(400).json({ error: 'tool_results is required' });
    }
    const estimateId = req.params.id;

    setSSEHeaders(res);

    try {
      const sessionRow = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE agent_key = 'ag' AND entity_type = 'estimate'
             AND entity_id = $1 AND user_id = $2 AND archived_at IS NULL`,
        [estimateId, req.user.id]
      );
      if (!sessionRow.rows.length) {
        res.write('data: ' + JSON.stringify({ error: 'No active session — start a new turn.' }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const session = sessionRow.rows[0];

      // Translate v1-shape tool_results into Sessions
      // user.custom_tool_result events. tool_use_id should match the
      // sevt_… id we sent down on the prior turn.
      const eventsToSend = toolResults.map(r => ({
        type: 'user.custom_tool_result',
        custom_tool_use_id: r.tool_use_id,
        content: [{
          type: 'text',
          text: r.approved
            ? (r.applied_summary || 'User approved. Change applied to the estimate.')
            : (r.reject_reason || 'User rejected this proposal.')
        }]
      }));

      const ctx = await buildEstimateContext(estimateId, false);
      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend,
        onCustomToolUse: makeAgOnCustomToolUse(),
        persistAssistantText: async (text, usage) => {
          await saveAssistantMessage({ estimateId, userId: req.user.id, text, usage, packsLoaded: ctx.packsLoaded });
        }
      });
    } catch (e) {
      console.error('AI v2 chat/continue error:', e);
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
async function buildJobContext(jobId, clientContext, aiPhase) {
  // aiPhase: 'plan' (read-only analysis, no writes) | 'build' (full
  // tool access). Defaults to 'plan' for Elle — she's an analyst, so
  // the safer default is no surprise mutations until the PM explicitly
  // grants build access via the request_build_mode tool or the phase
  // pill. The caller forwards this to filterToolsForJobPhase to drop
  // every write tool from the request when phase==='plan'.
  aiPhase = aiPhase === 'build' ? 'build' : 'plan';
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

  // Sub-job structure — full per-building phase composition with the
  // computed budget-weighted rollup that drives the WIP page. Without
  // this Elle has no way to verify her own cascade results before /
  // after a write.
  if (buildings.length || phases.length) {
    lines.push('# Structure (buildings + phases with computed rollups)');
    lines.push('Format per building: `<name> [<id>]` then 1 line per phase: `• [<phase_id>] <phase_name> · pct=N% · budget=$N · weight=N%`. The "Computed building pct" line at the bottom of each block is the budget-weighted average that drives the WIP page rollup. Use the bracketed phase ids when calling `set_phase_pct_complete` or `set_phase_field`.');
    lines.push('');

    // Cap so very large jobs (20+ buildings) don't blow the context.
    var MAX_BLDGS_LISTED = 12;
    var MAX_PHASES_PER_BLDG = 14;
    var listed = buildings.slice(0, MAX_BLDGS_LISTED);
    listed.forEach(function(b) {
      var bldgPhases = phases.filter(function(p) { return p.buildingId === b.id; });
      var totalBudget = bldgPhases.reduce(function(s, p) { return s + (Number(p.phaseBudget) || 0); }, 0);
      var weightedPct = 0;
      if (bldgPhases.length) {
        if (totalBudget > 0) {
          weightedPct = bldgPhases.reduce(function(s, p) {
            return s + (Number(p.pctComplete) || 0) * (Number(p.phaseBudget) || 0);
          }, 0) / totalBudget;
        } else {
          weightedPct = bldgPhases.reduce(function(s, p) { return s + (Number(p.pctComplete) || 0); }, 0) / bldgPhases.length;
        }
      }
      lines.push('## ' + (b.name || b.id) + ' [' + b.id + ']' +
        (b.budget ? ' · budget ' + fmtMoney(b.budget) : '') +
        ' · ' + bldgPhases.length + ' phase' + (bldgPhases.length === 1 ? '' : 's'));
      if (!bldgPhases.length) {
        lines.push('  (no phases linked to this building — building % complete will read 0 from the legacy WIP rollup)');
      } else {
        var phasesShown = bldgPhases.slice(0, MAX_PHASES_PER_BLDG);
        phasesShown.forEach(function(p) {
          var weight = (totalBudget > 0)
            ? '· weight ' + Math.round(((Number(p.phaseBudget) || 0) / totalBudget) * 100) + '%'
            : '· weight equal';
          lines.push('  • [' + p.id + '] ' + (p.phase || p.name || '(unnamed)') +
            ' · pct=' + Math.round(Number(p.pctComplete) || 0) + '%' +
            ' · budget=' + fmtMoney(p.phaseBudget) +
            ' ' + weight);
        });
        if (bldgPhases.length > MAX_PHASES_PER_BLDG) {
          lines.push('  • …and ' + (bldgPhases.length - MAX_PHASES_PER_BLDG) + ' more phases (truncated for context budget)');
        }
        lines.push('  Computed building pct (budget-weighted): ' + Math.round(weightedPct) + '%');
      }
      lines.push('');
    });
    if (buildings.length > MAX_BLDGS_LISTED) {
      lines.push('…and ' + (buildings.length - MAX_BLDGS_LISTED) + ' more buildings (truncated; ask for them by name if needed).');
      lines.push('');
    }

    // Orphan phases — phases not linked to any building. Common cause
    // of WIP rollups being lower than expected.
    var orphans = phases.filter(function(p) {
      return !p.buildingId || !buildings.some(function(b) { return b.id === p.buildingId; });
    });
    if (orphans.length) {
      lines.push('## Orphan phases (no buildingId — invisible to the building rollup)');
      orphans.slice(0, 12).forEach(function(p) {
        lines.push('  • [' + p.id + '] ' + (p.phase || '(unnamed)') +
          ' · pct=' + Math.round(Number(p.pctComplete) || 0) + '%' +
          ' · budget=' + fmtMoney(p.phaseBudget));
      });
      if (orphans.length > 12) {
        lines.push('  • …and ' + (orphans.length - 12) + ' more.');
      }
      lines.push('  These phases need a buildingId set OR they need to be moved/deleted before the WIP rollup will reflect them.');
      lines.push('');
    }

    // ── How building % complete actually works (mental model) ─────
    // Elle has had trouble with this — two parallel cascade paths
    // exist that compute the SAME conceptual number from DIFFERENT
    // data, and they can diverge. Spell it out so she can diagnose.
    lines.push('## How building % complete works (read this before answering rollup questions)');
    lines.push('Building % complete is computed by TWO parallel paths that may show different numbers for the same building:');
    lines.push('');
    lines.push('  • **Legacy WIP rollup** (the WIP page tiles, the per-building cards): a *budget-weighted average* of every phase record where `phase.buildingId == building.id`. Each phase\'s contribution = `phase.pctComplete × phase.phaseBudget / sum(phase.phaseBudget)`. This is what the # Structure block above shows.');
    lines.push('  • **Graph rollup** (the canvas, the t1 node\'s % display): a *revenue-weighted sum* over incoming t2 (phase) and co (change order) wires. Per-wire contribution = `wire.pctComplete × wire.allocPct × source.revenue`. The wire\'s `pctComplete` is a per-allocation override; if not set, it falls back to the source node\'s `pctComplete`.');
    lines.push('');
    lines.push('Key asymmetry: a phase RECORD has exactly one `buildingId`, but a phase NODE in the graph can wire to MANY buildings (COATINGS allocates 14% to each of 7 buildings). When that happens:');
    lines.push('  – Setting `phase.pctComplete = 100` propagates to ALL wired buildings (via the wire-fallback path) AND to the legacy WIP rollup for the one buildingId on the record.');
    lines.push('  – Setting `wire.pctComplete = 100` only affects ONE building\'s graph view (the wire\'s target).');
    lines.push('  – Setting the t1 node\'s own `pctComplete` is a no-op when there are wires; the rollup ignores it.');
    lines.push('');
    lines.push('When the user says "set B1 to 100%": call `set_phase_pct_complete` with the BUILDING id (e.g. "b1") or t1 node id. The applier cascades to BOTH paths — every incoming t2/co wire gets its `pctComplete` set, AND every phase record with `buildingId=b1` gets its `pctComplete` set. The t1 node\'s own pct is left to the rollup. This is the only call that updates both the WIP page AND the graph in one shot.');
    lines.push('');
    lines.push('Diagnostic checklist when a building % won\'t move:');
    lines.push('  1. Are there phase records linked to this building? If 0, the legacy rollup will show 0% no matter what you do at the t1 level. (Check the # Structure block.)');
    lines.push('  2. Are there orphan phases that should be linked? (Check the "Orphan phases" subsection above.)');
    lines.push('  3. Are wires set on the graph? If a t2 has a wire to a t1 with `allocPct=0`, that allocation contributes nothing.');
    lines.push('  4. Did you write to `t1.pctComplete` directly? That field is ignored when wires/phases exist — write to phases or wires instead.');
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

  // Section overrides for Elle. Loaded once and used at named anchor
  // points so admins can edit instructions without code changes.
  const elleSectionOverrides = await loadSectionOverridesFor('job');
  renderSection(lines, 'elle_role', elleSectionOverrides);
  lines.push('');
  renderSection(lines, 'elle_web_research', elleSectionOverrides);

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

  // ── Active mode block ──────────────────────────────────────────
  // Mirrors AG's plan/build pattern. Server-side tool filtering is the
  // hard guard; this prompt block is the soft guard so the model
  // doesn't dangle "I would have done X" — it just adapts.
  lines.push('');
  if (aiPhase === 'plan') {
    lines.push('# CURRENT MODE: PLAN');
    lines.push('You are in **Plan mode** — read-only analysis. Every write tool (set_phase_pct_complete, set_phase_field, set_node_value, assign_qb_line, create_node, delete_node) has been removed from your tool list this turn, so you literally cannot call them.');
    lines.push('In Plan mode you SHOULD:');
    lines.push('  - Run reads, audit data, surface gaps and risks, propose what changes WOULD fix them.');
    lines.push('  - When your analysis surfaces an action you\'d need to take but can\'t (e.g. "B1 has cost data but pctComplete=0"), call `request_build_mode` with a short rationale + the bullet list of writes you\'d make. The PM gets an approval card; on approve, the next turn opens with full write access.');
    lines.push('  - Do NOT write the planned actions out as fake tool calls or as placeholder JSON. Just describe them in prose so the user can decide.');
  } else {
    lines.push('# CURRENT MODE: BUILD');
    lines.push('You are in **Build mode** — full tool access. The PM has explicitly granted writes for this session (or has the panel pinned in Build). Make changes confidently when the data supports them, but every write still goes through the per-tool approval card so the PM can veto.');
    lines.push('Reminder: prefer one focused edit per tool call (each becomes its own approval card). Building % complete cascades to every phase under that building — call that out in your rationale when you use it.');
    lines.push('');
    lines.push('## Authoritative tool list (overrides any older skill-pack guidance)');
    lines.push('Your live tool list this turn is the source of truth — IGNORE any skill-pack instruction that says you "cannot create nodes" or "must tell the user to drop a node manually." Those are stale. `create_node` and `delete_node` are working tools and you should use them when the situation calls for it (e.g. user asks to add a sub node for a vendor, or asks you to remove an obsolete legacy node). Each one still routes through the approval card so the PM can veto.');
    lines.push('When you have 5+ QB lines that all map cleanly to nodes, prefer `assign_qb_lines_bulk` (one card) over many individual `assign_qb_line` calls.');
    lines.push('When a CO has $0 cost loaded but the audit suggests it should have a real number, propose `set_co_field` with field=estimatedCosts — that\'s the canonical fix.');
    lines.push('');
    lines.push('## Schema notes (so you don\'t propose tools that can\'t exist)');
    lines.push('Buildings store ONLY {id, jobId, name, budget, address}. They do NOT have materials / labor / sub / equipment dollar fields — those live on phase records (which carry buildingId). There is no `set_building_field` tool because the cost data lives one layer down. To "set materials cost on B1," update the phase under B1 with `set_phase_field`, OR allocate via the relevant cost-bucket node with `set_node_value`.');
  }

  // Job side stays plain — single string. Lower volume than AG/HR so
  // the marginal caching benefit isn't worth the structural complexity.
  return {
    system: lines.join('\n'),
    photoBlocks: [],
    aiPhase: aiPhase,
    packsLoaded: elleSkills.map(s => s.name)
  };
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
    const aiPhase = (req.body && req.body.aiPhase) === 'build' ? 'build' : 'plan';

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

      const ctx = await buildJobContext(jobId, clientContext, aiPhase);

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
      // Plan mode filters JOB_TOOLS down to read-only + request_build_mode.
      await runStream({
        anthropic, res,
        system: ctx.system,
        messages: messages,
        tools: filterToolsForJobPhase(JOB_TOOLS, ctx.aiPhase),
        agentKey: 'job',
        persistAssistantText: async (text, usage) => {
          if (!text) return;
          const aid = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await pool.query(
            `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                      input_tokens, output_tokens,
                                      cache_creation_input_tokens, cache_read_input_tokens)
             VALUES ($1, 'job', $2, $3, 'assistant', $4, $5, $6, $7, $8, $9)`,
            [aid, jobId, req.user.id, text, MODEL,
             usage.input_tokens, usage.output_tokens,
             usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null]
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
    const aiPhase = (req.body && req.body.aiPhase) === 'build' ? 'build' : 'plan';
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

      const ctx = await buildJobContext(jobId, clientContext, aiPhase);

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
        tools: filterToolsForJobPhase(JOB_TOOLS, ctx.aiPhase),
        agentKey: 'job',
        persistAssistantText: async (text, usage) => {
          if (!text) return;
          const aid = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
          await pool.query(
            `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                      input_tokens, output_tokens,
                                      cache_creation_input_tokens, cache_read_input_tokens)
             VALUES ($1, 'job', $2, $3, 'assistant', $4, $5, $6, $7, $8, $9)`,
            [aid, jobId, req.user.id, text, MODEL,
             usage.input_tokens, usage.output_tokens,
             usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null]
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
// Phase 2 — v2 Elle (jobs) chat path on the Anthropic Sessions API
//
// Mirrors Phase 1b's v2 estimates path. Long-lived Anthropic Session
// per (job, user) — agent.create for Elle was registered in Phase 1a,
// so the session inherits Elle's system prompt, JOB_TOOLS, web_search.
//
// Per-turn dynamic context (job WIP snapshot, change orders, node
// graph) goes into the user message wrapped in <turn_context> instead
// of being re-shipped as a system prefix on every request.
//
// Gated behind AGX_AGENT_MODE_JOB=agents. Production stays on the v1
// runStream path until the flag is flipped.
// ════════════════════════════════════════════════════════════════════

const FLAG_AGENT_MODE_JOB = (process.env.AGX_AGENT_MODE_JOB || '').toLowerCase() === 'agents';

// Persist the assistant text response for an Elle turn into ai_messages
// (entity_type='job'). Mirrors the v1 inline insert so the messages
// table stays canonical regardless of which path produced the row.
async function saveJobAssistantMessage({ jobId, userId, text, usage }) {
  if (!text) return;
  const aid = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                              input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens)
     VALUES ($1, 'job', $2, $3, 'assistant', $4, $5, $6, $7, $8, $9)`,
    [aid, jobId, userId, text, MODEL,
     usage.input_tokens, usage.output_tokens,
     usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null]
  );
}

// POST /api/ai/v2/jobs/:id/chat — Sessions-backed chat for Elle.
// Body: { message, clientContext, aiPhase }
router.post('/v2/jobs/:id/chat',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    if (!FLAG_AGENT_MODE_JOB) {
      return res.status(503).json({ error: 'v2 chat path is disabled. Set AGX_AGENT_MODE_JOB=agents to enable.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const jobId = req.params.id;
    const clientContext = (req.body && req.body.clientContext) || null;
    const aiPhase = (req.body && req.body.aiPhase) === 'build' ? 'build' : 'plan';

    setSSEHeaders(res);

    try {
      const ctx = await buildJobContext(jobId, clientContext, aiPhase);

      // Wrap per-turn dynamic context in <turn_context> tags so the
      // agent's stable system prompt isn't polluted with churn-prone
      // fields. Elle's WIP snapshots can run long; the Session's
      // built-in compaction will shorten older turns automatically.
      const turnText =
        '<turn_context>\n' + ctxSystemToText(ctx.system) + '\n</turn_context>\n\n' + userMessage;
      const userContent = [{ type: 'text', text: turnText }];

      const session = await ensureAiSession({
        agentKey: 'job',
        entityType: 'job',
        entityId: jobId,
        userId: req.user.id
      });
      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'job', $2, $3, 'user', $4)`,
        [userMsgId, jobId, req.user.id, userMessage]
      );

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend: [{ type: 'user.message', content: userContent }],
        persistAssistantText: async (text, usage) => {
          await saveJobAssistantMessage({ jobId, userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 job chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// POST /api/ai/v2/jobs/:id/chat/continue
// Body: { tool_results: [{ tool_use_id, approved, applied_summary?, reject_reason? }] }
router.post('/v2/jobs/:id/chat/continue',
  requireAuth, requireCapability('FINANCIALS_VIEW'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) {
      return res.status(503).json({ error: 'AI assistant is not configured.' });
    }
    if (!FLAG_AGENT_MODE_JOB) {
      return res.status(503).json({ error: 'v2 chat path is disabled.' });
    }
    const toolResults = req.body && req.body.tool_results;
    if (!Array.isArray(toolResults) || !toolResults.length) {
      return res.status(400).json({ error: 'tool_results is required' });
    }
    const jobId = req.params.id;

    setSSEHeaders(res);

    try {
      const sessionRow = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE agent_key = 'job' AND entity_type = 'job'
             AND entity_id = $1 AND user_id = $2 AND archived_at IS NULL`,
        [jobId, req.user.id]
      );
      if (!sessionRow.rows.length) {
        res.write('data: ' + JSON.stringify({ error: 'No active session — start a new turn.' }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const session = sessionRow.rows[0];

      const eventsToSend = toolResults.map(r => ({
        type: 'user.custom_tool_result',
        custom_tool_use_id: r.tool_use_id,
        content: [{
          type: 'text',
          text: r.approved
            ? (r.applied_summary || 'User approved. Change applied.')
            : (r.reject_reason || 'User rejected this proposal.')
        }]
      }));

      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend,
        persistAssistantText: async (text, usage) => {
          await saveJobAssistantMessage({ jobId, userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 job chat/continue error:', e);
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
  // Section overrides — admin-editable named blocks.
  const hrSectionOverrides = await loadSectionOverridesFor('cra');
  renderSection(stable, 'hr_about_agx', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_hierarchy', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_field_semantics', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_bt_patterns', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_dedup_rules', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_behavior', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_web_research', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_tool_tiers', hrSectionOverrides);
  stable.push('');
  renderSection(stable, 'hr_photos', hrSectionOverrides);
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
    totalClients: rows.length,
    packsLoaded: craSkills.map(s => s.name)
  };
}

// Persist a final assistant text response on the client thread.
async function saveClientAssistantMessage({ userId, text, usage }) {
  const id = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                              input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens)
     VALUES ($1, 'client', 'global', $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
    [id, userId, text, MODEL,
     usage.input_tokens, usage.output_tokens,
     usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null]
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
  const _effortC = effortClause('cra');
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

      let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
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
        if (turn.usage.cache_creation_input_tokens) totalUsage.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
        if (turn.usage.cache_read_input_tokens) totalUsage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;

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

      let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      let finalAssistantText = '';
      for (let loop = 0; loop < MAX_CLIENT_TOOL_LOOPS; loop++) {
        const ctx = await buildClientDirectoryContext();
        const turn = await streamClientTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;
        if (turn.usage.cache_creation_input_tokens) totalUsage.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
        if (turn.usage.cache_read_input_tokens) totalUsage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;

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
    name: 'read_materials',
    tier: 'auto',
    description:
      'Search AGX\'s materials catalog (real purchase history from Home Depot + other vendors). Same tool AG uses for pricing line items. Use it to answer "do we have a price book?", "what does AGX typically pay for X?", or to audit whether AG\'s recent quotes are using catalog data or guessing.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across description / SKU. Trade words: "PT pickets", "Hardie lap siding", "5/4 deck board".' },
        subgroup: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Filter to one AGX subgroup. Default: all.' },
        category: { type: 'string', description: 'Filter to one AGX category, e.g. "Lumber & Decking", "Paint", "Fasteners".' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Cap rows returned. Default 20.' }
      },
      required: []
    }
  },
  {
    name: 'read_purchase_history',
    tier: 'auto',
    description: 'Per-purchase log for a specific material — the receipt-level rows that aggregate into read_materials\' summary stats. Use to spot pricing trends, find which jobs used a SKU, answer "what did we pay last time?".',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        material_id: { type: 'integer' },
        q: { type: 'string' },
        days: { type: 'integer', minimum: 1, maximum: 730 },
        job_name: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: []
    }
  },
  {
    name: 'read_subs',
    tier: 'auto',
    description: 'Query AGX\'s subcontractor directory. Returns name, trade, status, cert (GL / WC / W9 / Bank) expiration dates, contacts. Use to audit cert health, list subs in a trade, or check if a named sub is active.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        trade: { type: 'string' },
        status: { type: 'string', enum: ['active', 'paused', 'closed'] },
        with_expiring_certs: { type: 'boolean' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: []
    }
  },
  {
    name: 'read_lead_pipeline',
    tier: 'auto',
    description: 'Query the AGX leads pipeline. Returns titles, statuses, projected revenue, salespeople, markets, ages. Use to characterize sales activity, find lead clusters by source/market, or audit pipeline health.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        status: { type: 'string', enum: ['new', 'in_progress', 'sent', 'sold', 'lost', 'no_opportunity'] },
        market: { type: 'string' },
        salesperson_email: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
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
  // Section overrides — admin-editable named blocks for Chief of Staff.
  const cosSectionOverrides = await loadSectionOverridesFor('staff');
  renderSection(stable, 'cos_three_agents', cosSectionOverrides);
  stable.push('');
  stable.push('# Your tools');
  stable.push('Read tools (auto-apply, no approval):');
  stable.push('  • `read_metrics(range)` — per-agent aggregate stats for last 7d or 30d. Default range is 7d.');
  stable.push('  • `read_recent_conversations(range, entity_type?, limit?)` — recent conversation list with rollup numbers.');
  stable.push('  • `read_conversation_detail(key)` — full message log of one conversation. Pass the `key` from read_recent_conversations.');
  stable.push('  • `read_skill_packs()` — admin-editable instruction packs the agents load each turn.');
  stable.push('  • `read_materials(q?, subgroup?, category?, limit?)` — query AGX\'s materials catalog (Home Depot purchase history, etc.). Same tool AG uses for line-item pricing. Use it to answer "do we have a price book?", spot patterns in what AG should be searching, or audit whether AG quotes are catalog-backed.');
  stable.push('  • `read_purchase_history(material_id?, q?, days?, job_name?, limit?)` — receipt-level material purchase rows. Use to spot pricing trends, find jobs that used a SKU, or audit whether AG\'s quoted prices match what AGX actually paid recently.');
  stable.push('  • `read_subs(q?, trade?, status?, with_expiring_certs?, limit?)` — subcontractor directory with cert expiry. Use to surface paperwork-expiring subs, list subs by trade, or confirm a named sub is active. with_expiring_certs=true for compliance audits.');
  stable.push('  • `read_lead_pipeline(q?, status?, market?, salesperson_email?, limit?)` — leads list + always-included status rollup ($ counts per status). Use for "what does our pipeline look like?", spotting deal-source patterns, or seeing which markets are hot.');
  stable.push('Propose tools (approval-required — user clicks Approve/Reject on a card):');
  stable.push('  • `propose_skill_pack_add(name, body, agents, alwaysOn?, rationale)` — add a new skill pack. agents accepts ["ag", "cra", "job"] (ag=AG, cra=HR, job=Elle). ALWAYS call read_skill_packs first to confirm no name collision.');
  stable.push('  • `propose_skill_pack_edit(name, new_name?, new_body?, agents?, alwaysOn?, rationale)` — change an existing pack. body edits replace the whole body.');
  stable.push('  • `propose_skill_pack_delete(name, rationale)` — remove a pack entirely. alwaysOn=false is usually a softer alternative.');
  stable.push('');
  renderSection(stable, 'cos_how_to_work', cosSectionOverrides);
  stable.push('');
  renderSection(stable, 'cos_tone', cosSectionOverrides);

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

    case 'read_materials': {
      // Same query shape as the GET /api/materials endpoint that AG\'s
      // client-side applier hits — kept inline rather than HTTP-loop
      // through self so the staff agent doesn\'t need to forge a
      // bearer token.
      const q = (input && input.q || '').trim();
      const subgroup = (input && input.subgroup || '').trim();
      const category = (input && input.category || '').trim();
      const limit = Math.max(1, Math.min(100, Number(input && input.limit) || 20));
      const where = ['is_hidden = false'];
      const params = [];
      let p = 1;
      if (subgroup) { where.push('agx_subgroup = $' + p++); params.push(subgroup); }
      if (category) { where.push('category = $' + p++); params.push(category); }
      if (q) {
        where.push('(description ILIKE $' + p + ' OR raw_description ILIKE $' + p + ' OR sku ILIKE $' + p + ')');
        params.push('%' + q + '%');
        p++;
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT description, sku, unit, agx_subgroup, category,
                last_unit_price, avg_unit_price, min_unit_price, max_unit_price,
                last_seen, purchase_count
           FROM materials WHERE ${where.join(' AND ')}
           ORDER BY purchase_count DESC, last_seen DESC NULLS LAST
           LIMIT $${p}`,
        params
      );
      const totalQ = await pool.query('SELECT COUNT(*)::int AS c FROM materials');
      const total = totalQ.rows[0].c;
      if (!r.rows.length) {
        const queryDesc = q ? '"' + q + '"' : '(no filter)';
        return 'No materials matched ' + queryDesc + '. Catalog has ' + total + ' total entries. Try a broader keyword or different subgroup/category.';
      }
      const fmtMoney = (n) => n == null ? '—' : '$' + Number(n).toFixed(2);
      const out = ['Found ' + r.rows.length + ' material' + (r.rows.length === 1 ? '' : 's') + ' (catalog: ' + total + ' total).'];
      for (const m of r.rows) {
        const lastSeen = m.last_seen ? String(m.last_seen).slice(0, 10) : 'never';
        out.push('- ' + m.description +
          (m.sku ? ' [SKU ' + m.sku + ']' : '') +
          ' · ' + (m.unit || '?') +
          ' · last ' + fmtMoney(m.last_unit_price) + '/avg ' + fmtMoney(m.avg_unit_price) +
          ' (range ' + fmtMoney(m.min_unit_price) + '-' + fmtMoney(m.max_unit_price) + ')' +
          ' · ' + lastSeen +
          ' · ' + (m.purchase_count || 0) + 'x' +
          (m.category ? ' · ' + m.category : '') +
          (m.agx_subgroup ? ' [' + m.agx_subgroup + ']' : ''));
      }
      return out.join('\n');
    }

    case 'read_purchase_history': {
      const days = Math.max(1, Math.min(730, Number(input && input.days) || 365));
      const limit = Math.max(1, Math.min(200, Number(input && input.limit) || 30));
      const where = [`purchase_date >= NOW() - INTERVAL '${days} days'`];
      const params = [];
      let p = 1;
      if (input && input.material_id) {
        params.push(Number(input.material_id));
        where.push('mp.material_id = $' + p++);
      } else if (input && input.q && input.q.trim()) {
        params.push('%' + input.q.trim() + '%');
        where.push('(m.description ILIKE $' + p + ' OR m.raw_description ILIKE $' + p + ' OR m.sku ILIKE $' + p + ')');
        p++;
      }
      if (input && input.job_name && input.job_name.trim()) {
        params.push('%' + input.job_name.trim() + '%');
        where.push('mp.job_name ILIKE $' + p++);
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT mp.purchase_date, mp.quantity, mp.unit_price, mp.net_unit_price,
                mp.store_number, mp.job_name, mp.is_return,
                m.description, m.sku, m.unit
           FROM material_purchases mp
           LEFT JOIN materials m ON m.id = mp.material_id
          WHERE ${where.join(' AND ')}
          ORDER BY mp.purchase_date DESC
          LIMIT $${p}`,
        params
      );
      if (!r.rows.length) return 'No purchase records matched in the last ' + days + ' days.';
      const out = ['Found ' + r.rows.length + ' purchase' + (r.rows.length === 1 ? '' : 's') + ' (last ' + days + ' days):'];
      for (const x of r.rows) {
        const date = x.purchase_date ? String(x.purchase_date).slice(0, 10) : '?';
        const ret = x.is_return ? ' [RETURN]' : '';
        out.push('- ' + date + ': ' + (x.description || '(unknown)') +
          (x.sku ? ' [' + x.sku + ']' : '') +
          ' · qty ' + (x.quantity == null ? '?' : Number(x.quantity)) +
          ' ' + (x.unit || '') +
          ' @ $' + (x.unit_price == null ? '?' : Number(x.unit_price).toFixed(2)) +
          (x.net_unit_price != null && Math.abs(Number(x.net_unit_price) - Number(x.unit_price || 0)) > 0.01 ? ' (net $' + Number(x.net_unit_price).toFixed(2) + ')' : '') +
          (x.job_name ? ' · ' + x.job_name : '') +
          (x.store_number ? ' · store #' + x.store_number : '') +
          ret);
      }
      return out.join('\n');
    }

    case 'read_subs': {
      const status = (input && input.status) || 'active';
      const limit = Math.max(1, Math.min(200, Number(input && input.limit) || 30));
      const where = [];
      const params = [];
      let p = 1;
      if (status !== 'all') { where.push('s.status = $' + p++); params.push(status); }
      if (input && input.trade && input.trade.trim()) {
        where.push('s.trade ILIKE $' + p++);
        params.push('%' + input.trade.trim() + '%');
      }
      if (input && input.q && input.q.trim()) {
        where.push('(s.name ILIKE $' + p + ' OR s.contact_name ILIKE $' + p + ' OR s.primary_contact_first ILIKE $' + p + ' OR s.primary_contact_last ILIKE $' + p + ')');
        params.push('%' + input.q.trim() + '%');
        p++;
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT s.id, s.name, s.trade, s.status, s.contact_name,
                s.primary_contact_first, s.primary_contact_last,
                s.business_phone, s.cell_phone, s.email,
                s.license_no,
                (SELECT json_agg(json_build_object(
                   'cert_type', c.cert_type, 'expires', c.expiration_date)
                   ORDER BY c.cert_type)
                 FROM sub_certificates c WHERE c.sub_id = s.id) AS certs
           FROM subs s
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY lower(s.name)
          LIMIT $${p}`,
        params
      );
      if (!r.rows.length) return 'No subs matched.';
      // Optional with_expiring_certs filter — applied in JS since the
      // expiry condition spans multiple cert rows aggregated as JSON.
      const today = new Date();
      const sixtyDaysOut = new Date(today.getTime() + 60 * 24 * 3600 * 1000);
      let rows = r.rows;
      if (input && input.with_expiring_certs) {
        rows = rows.filter(s => {
          const certs = s.certs || [];
          return certs.some(c => {
            if (!c.expires) return false;
            const d = new Date(c.expires);
            return d <= sixtyDaysOut;
          });
        });
        if (!rows.length) return 'No subs have certs expiring in the next 60 days.';
      }
      const out = ['Found ' + rows.length + ' sub' + (rows.length === 1 ? '' : 's') + ' (status=' + status + '):'];
      for (const s of rows) {
        const fullName = [s.primary_contact_first, s.primary_contact_last].filter(Boolean).join(' ') || s.contact_name || '';
        const certBits = (s.certs || []).map(c => {
          if (!c.expires) return c.cert_type + ': none';
          const d = new Date(c.expires);
          const daysOut = Math.round((d.getTime() - today.getTime()) / (24 * 3600 * 1000));
          let tag;
          if (daysOut < 0) tag = ' (EXPIRED ' + Math.abs(daysOut) + 'd ago)';
          else if (daysOut <= 60) tag = ' (expires in ' + daysOut + 'd)';
          else tag = '';
          return c.cert_type + ': ' + String(c.expires).slice(0, 10) + tag;
        });
        out.push('- ' + s.name +
          (s.trade ? ' · ' + s.trade : '') +
          ' · ' + s.status +
          (fullName ? ' · ' + fullName : '') +
          (s.business_phone || s.cell_phone ? ' · ' + (s.business_phone || s.cell_phone) : '') +
          (s.email ? ' · ' + s.email : '') +
          (s.license_no ? ' · lic ' + s.license_no : '') +
          (certBits.length ? '\n    certs: ' + certBits.join(', ') : '\n    certs: (none on file)'));
      }
      return out.join('\n');
    }

    case 'read_lead_pipeline': {
      const limit = Math.max(1, Math.min(200, Number(input && input.limit) || 30));
      const where = [];
      const params = [];
      let p = 1;
      if (input && input.status) { where.push('l.status = $' + p++); params.push(input.status); }
      if (input && input.market) { where.push('l.market ILIKE $' + p++); params.push('%' + input.market + '%'); }
      if (input && input.q && input.q.trim()) {
        where.push('(l.title ILIKE $' + p + ' OR l.property_name ILIKE $' + p + ' OR l.notes ILIKE $' + p + ')');
        params.push('%' + input.q.trim() + '%');
        p++;
      }
      if (input && input.salesperson_email && input.salesperson_email.trim()) {
        where.push('u.email ILIKE $' + p++);
        params.push('%' + input.salesperson_email.trim() + '%');
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT l.id, l.title, l.status, l.confidence, l.market, l.source,
                l.estimated_revenue_low, l.estimated_revenue_high,
                l.projected_sale_date, l.created_at, l.updated_at,
                c.name AS client_name,
                u.email AS salesperson_email, u.name AS salesperson_name
           FROM leads l
           LEFT JOIN clients c ON c.id = l.client_id
           LEFT JOIN users u ON u.id = l.salesperson_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY l.updated_at DESC
          LIMIT $${p}`,
        params
      );
      // Always include a status rollup so the model can reason about pipeline shape
      // without asking for it separately.
      const rollupQ = await pool.query(
        `SELECT status, COUNT(*)::int AS n,
                COALESCE(SUM((estimated_revenue_low + estimated_revenue_high) / 2), 0)::numeric AS midpoint_rev
           FROM leads GROUP BY status ORDER BY status`
      );
      const out = [];
      out.push('Pipeline rollup (all leads): ' +
        rollupQ.rows.map(x => x.status + '=' + x.n + ' ($' + Math.round(Number(x.midpoint_rev || 0) / 1000) + 'K)').join(', ') || '(empty)');
      out.push('');
      if (!r.rows.length) {
        out.push('No leads matched the filter.');
        return out.join('\n');
      }
      out.push('Matching leads (' + r.rows.length + '):');
      for (const x of r.rows) {
        const lo = Number(x.estimated_revenue_low || 0);
        const hi = Number(x.estimated_revenue_high || 0);
        const rev = lo && hi ? '$' + Math.round(lo / 1000) + 'K-$' + Math.round(hi / 1000) + 'K'
                  : lo || hi ? '$' + Math.round((lo || hi) / 1000) + 'K'
                  : '?';
        const days = x.created_at ? Math.round((Date.now() - new Date(x.created_at).getTime()) / (24 * 3600 * 1000)) : null;
        out.push('- ' + x.title +
          (x.client_name ? ' · ' + x.client_name : '') +
          ' · ' + x.status +
          (x.confidence ? ' · conf ' + x.confidence + '%' : '') +
          ' · ' + rev +
          (x.market ? ' · ' + x.market : '') +
          (x.source ? ' · src ' + x.source : '') +
          (x.salesperson_email ? ' · sales ' + x.salesperson_email : '') +
          (days != null ? ' · age ' + days + 'd' : ''));
      }
      return out.join('\n');
    }

    case 'read_clients': {
      const q = (input && input.q || '').trim();
      const limit = Math.max(1, Math.min(100, Number(input && input.limit) || 20));
      const where = [];
      const params = [];
      let p = 1;
      if (q) {
        where.push('(c.name ILIKE $' + p + ' OR c.contact_name ILIKE $' + p + ' OR c.city ILIKE $' + p + ')');
        params.push('%' + q + '%');
        p++;
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT c.id, c.name, c.parent_client_id, c.city, c.state, c.contact_name, c.phone,
                p.name AS parent_name,
                (SELECT COUNT(*)::int FROM client_notes n WHERE n.client_id = c.id) AS note_count
           FROM clients c
           LEFT JOIN clients p ON p.id = c.parent_client_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY lower(c.name)
          LIMIT $${p}`,
        params
      );
      if (!r.rows.length) return q ? 'No clients matched "' + q + '".' : 'No clients in directory.';
      const out = ['Found ' + r.rows.length + ' client' + (r.rows.length === 1 ? '' : 's') + ':'];
      for (const c of r.rows) {
        out.push('- ' + c.name + ' [id=' + c.id + ']' +
          (c.parent_name ? ' (under ' + c.parent_name + ')' : '') +
          (c.city ? ' · ' + c.city + (c.state ? ', ' + c.state : '') : '') +
          (c.contact_name ? ' · ' + c.contact_name : '') +
          (c.note_count ? ' · ' + c.note_count + ' note' + (c.note_count === 1 ? '' : 's') : ''));
      }
      return out.join('\n');
    }

    case 'read_leads': {
      const q = (input && input.q || '').trim();
      const limit = Math.max(1, Math.min(50, Number(input && input.limit) || 15));
      const where = [];
      const params = [];
      let p = 1;
      if (q) {
        where.push('(l.title ILIKE $' + p + ' OR l.property_name ILIKE $' + p + ')');
        params.push('%' + q + '%');
        p++;
      }
      if (input && input.status) { where.push('l.status = $' + p++); params.push(input.status); }
      params.push(limit);
      const r = await pool.query(
        `SELECT l.id, l.title, l.status, l.market,
                l.estimated_revenue_low, l.estimated_revenue_high,
                c.name AS client_name,
                u.email AS salesperson_email
           FROM leads l
           LEFT JOIN clients c ON c.id = l.client_id
           LEFT JOIN users u ON u.id = l.salesperson_id
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY l.updated_at DESC
          LIMIT $${p}`,
        params
      );
      if (!r.rows.length) return q ? 'No leads matched "' + q + '".' : 'No leads in pipeline.';
      const out = ['Found ' + r.rows.length + ' lead' + (r.rows.length === 1 ? '' : 's') + ':'];
      for (const x of r.rows) {
        const lo = Number(x.estimated_revenue_low || 0);
        const hi = Number(x.estimated_revenue_high || 0);
        const rev = lo && hi ? '$' + Math.round(lo / 1000) + 'K-$' + Math.round(hi / 1000) + 'K'
                  : lo || hi ? '$' + Math.round((lo || hi) / 1000) + 'K' : '?';
        out.push('- ' + x.title + ' [id=' + x.id + ']' +
          (x.client_name ? ' · ' + x.client_name : '') +
          ' · ' + x.status +
          ' · ' + rev +
          (x.market ? ' · ' + x.market : '') +
          (x.salesperson_email ? ' · ' + x.salesperson_email : ''));
      }
      return out.join('\n');
    }

    case 'read_past_estimate_lines': {
      const q = (input && input.q || '').trim();
      if (!q) return 'q is required — search keyword across line descriptions.';
      const days = Math.max(30, Math.min(1825, Number(input && input.days) || 730));
      const limit = Math.max(1, Math.min(100, Number(input && input.limit) || 25));
      // Estimates store lines inside the JSONB blob (data->>'lines'). Walk
      // the blob server-side via jsonb_array_elements so we can ILIKE on
      // descriptions without pulling every estimate to Node first.
      const r = await pool.query(
        `SELECT e.id AS estimate_id, e.data->>'title' AS title, e.updated_at,
                line->>'description' AS description,
                (line->>'qty')::numeric  AS qty,
                line->>'unit'            AS unit,
                (line->>'unitCost')::numeric AS unit_cost,
                (line->>'markup')::numeric   AS markup,
                line->>'section'         AS section
           FROM estimates e,
                jsonb_array_elements(COALESCE(e.data->'lines', '[]'::jsonb)) AS line
          WHERE e.updated_at >= NOW() - ($1 || ' days')::interval
            AND COALESCE(line->>'section', '') <> '__section_header__'
            AND line->>'description' ILIKE $2
          ORDER BY e.updated_at DESC
          LIMIT $3`,
        [String(days), '%' + q + '%', limit]
      );
      if (!r.rows.length) return 'No past estimate lines matched "' + q + '" in the last ' + days + ' days. Quote a defensible Central-FL estimate and mark "first-time line — no AGX history yet."';
      // Median + range across the matching lines for a quick anchor.
      const costs = r.rows.map(x => Number(x.unit_cost || 0)).filter(v => v > 0).sort((a, b) => a - b);
      const median = costs.length ? costs[Math.floor(costs.length / 2)] : null;
      const out = ['Found ' + r.rows.length + ' past line' + (r.rows.length === 1 ? '' : 's') + ' matching "' + q + '" (last ' + days + ' days).'];
      if (median != null) {
        out.push('Unit-cost anchor: median $' + median.toFixed(2) + ', range $' + costs[0].toFixed(2) + '-$' + costs[costs.length - 1].toFixed(2) + ' across ' + costs.length + ' priced line' + (costs.length === 1 ? '' : 's') + '.');
      }
      out.push('');
      for (const x of r.rows) {
        const updated = x.updated_at ? String(x.updated_at).slice(0, 10) : '?';
        out.push('- ' + (x.description || '(no description)') +
          ' · qty ' + (x.qty == null ? '?' : Number(x.qty)) +
          ' ' + (x.unit || '') +
          ' @ $' + (x.unit_cost == null ? '?' : Number(x.unit_cost).toFixed(2)) +
          (x.markup != null ? ' · markup ' + Number(x.markup) + '%' : '') +
          ' · ' + (x.section || '(no section)') +
          ' · est "' + (x.title || x.estimate_id) + '" · ' + updated);
      }
      return out.join('\n');
    }

    case 'read_past_estimates': {
      const q = (input && input.q || '').trim();
      const days = Math.max(30, Math.min(1825, Number(input && input.days) || 730));
      const limit = Math.max(1, Math.min(50, Number(input && input.limit) || 15));
      const where = ['e.updated_at >= NOW() - ($1 || \' days\')::interval'];
      const params = [String(days)];
      let p = 2;
      if (q) {
        where.push("(e.data->>'title' ILIKE $" + p + " OR c.name ILIKE $" + p + ')');
        params.push('%' + q + '%');
        p++;
      }
      if (input && input.status) {
        where.push("COALESCE(e.data->>'btExportStatus', e.data->>'status', 'draft') = $" + p++);
        params.push(input.status);
      }
      params.push(limit);
      const r = await pool.query(
        `SELECT e.id, e.data->>'title' AS title, e.updated_at,
                COALESCE(e.data->>'btExportStatus', e.data->>'status', 'draft') AS status,
                c.name AS client_name,
                COALESCE((e.data->>'totalProposal')::numeric, 0) AS total
           FROM estimates e
           LEFT JOIN clients c ON c.id = (e.data->>'clientId')
          WHERE ${where.join(' AND ')}
          ORDER BY e.updated_at DESC
          LIMIT $${p}`,
        params
      );
      if (!r.rows.length) return q ? 'No past estimates matched "' + q + '" in the last ' + days + ' days.' : 'No estimates in the last ' + days + ' days.';
      const out = ['Found ' + r.rows.length + ' past estimate' + (r.rows.length === 1 ? '' : 's') + ' (last ' + days + ' days):'];
      for (const x of r.rows) {
        const updated = x.updated_at ? String(x.updated_at).slice(0, 10) : '?';
        out.push('- "' + (x.title || '(untitled)') + '" [id=' + x.id + ']' +
          (x.client_name ? ' · ' + x.client_name : '') +
          ' · ' + x.status +
          ' · $' + Math.round(Number(x.total || 0)).toLocaleString() +
          ' · ' + updated);
      }
      return out.join('\n');
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
  const _effortS = effortClause('staff');
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

      let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      let finalAssistantText = '';

      for (let loop = 0; loop < MAX_STAFF_TOOL_LOOPS; loop++) {
        const ctx = await buildStaffContext();
        const turn = await streamStaffTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;
        if (turn.usage.cache_creation_input_tokens) totalUsage.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
        if (turn.usage.cache_read_input_tokens) totalUsage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;

        if (!turn.toolUseBlocks.length) {
          if (finalAssistantText) {
            const aMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
            await pool.query(
              `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                        input_tokens, output_tokens,
                                        cache_creation_input_tokens, cache_read_input_tokens)
               VALUES ($1, 'staff', 'global', $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
              [aMsgId, req.user.id, finalAssistantText, MODEL,
               totalUsage.input_tokens, totalUsage.output_tokens,
               totalUsage.cache_creation_input_tokens || null, totalUsage.cache_read_input_tokens || null]
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
        // Panel sends `tool_use_id` (matches CRA continue handler);
        // earlier this read `d.id` which was always undefined →
        // pendingToolUseById.get returned undefined → tool never ran
        // and the model got back "Tool not found in pending content."
        // as is_error. Result: skill packs silently failed to save
        // and the model often produced no follow-up text →
        // "(no response)" in the panel.
        const tuId = d.tool_use_id || d.id;
        const tu = pendingToolUseById.get(tuId);
        if (!tu) {
          toolResultBlocks.push({ type: 'tool_result', tool_use_id: tuId, content: 'Tool not found in pending content.', is_error: true });
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
      let totalUsage = { input_tokens: 0, output_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 };
      let finalAssistantText = '';
      for (let loop = 0; loop < MAX_STAFF_TOOL_LOOPS; loop++) {
        const ctx = await buildStaffContext();
        const turn = await streamStaffTurn({ anthropic, res, system: ctx.system, messages });
        finalAssistantText = turn.assistantText;
        if (turn.usage.input_tokens) totalUsage.input_tokens += turn.usage.input_tokens;
        if (turn.usage.output_tokens) totalUsage.output_tokens += turn.usage.output_tokens;
        if (turn.usage.cache_creation_input_tokens) totalUsage.cache_creation_input_tokens += turn.usage.cache_creation_input_tokens;
        if (turn.usage.cache_read_input_tokens) totalUsage.cache_read_input_tokens += turn.usage.cache_read_input_tokens;

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
              `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                        input_tokens, output_tokens,
                                        cache_creation_input_tokens, cache_read_input_tokens)
               VALUES ($1, 'staff', 'global', $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
              [aMsgId, req.user.id, finalAssistantText, MODEL,
               totalUsage.input_tokens, totalUsage.output_tokens,
               totalUsage.cache_creation_input_tokens || null, totalUsage.cache_read_input_tokens || null]
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

// ════════════════════════════════════════════════════════════════════
// Phase 2 (HR + CoS) — v2 chat paths on the Anthropic Sessions API
//
// HR (clients) and CoS (staff) chat paths share an extra wrinkle vs.
// AG/Elle: their tools split into auto-tier (executed server-side
// inline) and approval-tier (surfaced to the user). The Sessions
// migration handles this via the `onCustomToolUse` callback on
// runV2SessionStream — auto-tier tools execute mid-stream and feed
// their result back as a `user.custom_tool_result` so the session
// resumes within the same HTTP request, while approval-tier tools
// queue up and surface to the UI on the next idle.
//
// Each agent gets its own env-var flag so we can ramp them
// independently:
//   AGX_AGENT_MODE_CRA   = 'agents'   — HR on Sessions
//   AGX_AGENT_MODE_STAFF = 'agents'   — CoS on Sessions
// ════════════════════════════════════════════════════════════════════

const FLAG_AGENT_MODE_CRA   = (process.env.AGX_AGENT_MODE_CRA || '').toLowerCase() === 'agents';
const FLAG_AGENT_MODE_STAFF = (process.env.AGX_AGENT_MODE_STAFF || '').toLowerCase() === 'agents';

// HR (clients) auto-execute hook — runs the same server-side code
// path as v1's auto-tier branch (execClientToolWithCtx).
function makeClientOnCustomToolUse(userId) {
  return async function (tu) {
    if (!isClientToolAutoTier(tu.name)) return { tier: 'approval' };
    try {
      const summary = await execClientToolWithCtx(tu.name, tu.input || {}, { userId });
      return { tier: 'auto', summary };
    } catch (e) {
      return { tier: 'auto', error: 'Error: ' + (e.message || 'failed') };
    }
  };
}

// CoS (staff) auto-execute hook — read-only tools mostly; staff
// approval-tier tools (skill-pack proposals) drop through to UI.
function makeStaffOnCustomToolUse() {
  return async function (tu) {
    if (!isStaffToolAutoTier(tu.name)) return { tier: 'approval' };
    try {
      const summary = await execStaffTool(tu.name, tu.input || {});
      return { tier: 'auto', summary };
    } catch (e) {
      return { tier: 'auto', error: 'Error: ' + (e.message || 'failed') };
    }
  };
}

// AG auto-execute hook — runs the same read tools the v1 client
// auto-fires through /api/ai/exec-tool, but server-side here so the
// session resumes mid-stream without an extra client round-trip
// (was the source of "AG isn't actually performing the task" — every
// read paused for an approval-card flash + extra HTTP turn).
//
// AG's allowed auto-tier set (ALLOWED_AG_AUTO_TOOLS) is a strict
// subset of execStaffTool's switch cases, so we reuse the same
// executor instead of duplicating the read logic. Approval-tier
// tools (propose_*) drop through to the UI exactly like before.
function makeAgOnCustomToolUse() {
  return async function (tu) {
    if (!ALLOWED_AG_AUTO_TOOLS.has(tu.name)) return { tier: 'approval' };
    try {
      const summary = await execStaffTool(tu.name, tu.input || {});
      return { tier: 'auto', summary };
    } catch (e) {
      return { tier: 'auto', error: 'Error: ' + (e.message || 'failed') };
    }
  };
}

// HR (clients) — POST /api/ai/v2/clients/chat
router.post('/v2/clients/chat',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    if (!FLAG_AGENT_MODE_CRA) {
      return res.status(503).json({ error: 'v2 chat path is disabled. Set AGX_AGENT_MODE_CRA=agents to enable.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });
    const additionalImages = Array.isArray(req.body && req.body.additional_images)
      ? req.body.additional_images.slice(0, 12)
      : [];
    if (additionalImages.length) stashPendingClientImages(req.user.id, additionalImages);

    setSSEHeaders(res);
    try {
      const ctx = await buildClientDirectoryContext();

      // Per-turn directory snapshot wraps in <turn_context>; agent's
      // stable system prompt holds identity. Inline images go before
      // the text block.
      const turnText = '<turn_context>\n' + ctxSystemToText(ctx.system) + '\n</turn_context>\n\n' + userMessage;
      const imgBlocks = additionalImages.map(b64 => inlineImageBlock(b64)).filter(Boolean);
      const userContent = imgBlocks.length
        ? [...imgBlocks, { type: 'text', text: turnText }]
        : [{ type: 'text', text: turnText }];

      const session = await ensureAiSession({
        agentKey: 'cra',
        entityType: 'client',
        entityId: null,
        userId: req.user.id
      });
      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'client', 'global', $2, 'user', $3)`,
        [userMsgId, req.user.id, userMessage]
      );

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend: [{ type: 'user.message', content: userContent }],
        onCustomToolUse: makeClientOnCustomToolUse(req.user.id),
        persistAssistantText: async (text, usage) => {
          await saveClientAssistantMessage({ userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 client chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// HR /chat/continue — translate the user's approve/reject decisions
// into user.custom_tool_result events. Approved tools execute
// server-side here; rejected tools just send a rejection message back
// to the agent. The Session resumes from there and any subsequent
// custom_tool_use events are routed through the auto-tier hook again.
router.post('/v2/clients/chat/continue',
  requireAuth, requireCapability('ESTIMATES_EDIT'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    if (!FLAG_AGENT_MODE_CRA) {
      return res.status(503).json({ error: 'v2 chat path is disabled.' });
    }
    const decisions = req.body && req.body.tool_results;
    if (!Array.isArray(decisions) || !decisions.length) {
      return res.status(400).json({ error: 'tool_results is required' });
    }

    setSSEHeaders(res);
    try {
      const sessionRow = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE agent_key = 'cra' AND entity_type = 'client'
             AND entity_id IS NULL AND user_id = $1 AND archived_at IS NULL`,
        [req.user.id]
      );
      if (!sessionRow.rows.length) {
        res.write('data: ' + JSON.stringify({ error: 'No active session — start a new turn.' }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const session = sessionRow.rows[0];

      // Execute approved tools server-side; build the event list to
      // feed back to the session.
      const eventsToSend = [];
      for (const d of decisions) {
        let summary, isError = false;
        if (!d.approved) {
          summary = d.reject_reason || 'User rejected this proposal.';
          res.write('data: ' + JSON.stringify({ tool_rejected: { id: d.tool_use_id, name: d.name } }) + '\n\n');
        } else {
          try {
            // d.name + d.input are echoed by the client from the
            // tool_use event the server sent on the prior turn.
            summary = await execClientToolWithCtx(d.name, d.input || {}, { userId: req.user.id });
            res.write('data: ' + JSON.stringify({ tool_applied: { id: d.tool_use_id, name: d.name, input: d.input, summary } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: d.tool_use_id, name: d.name, input: d.input, error: summary } }) + '\n\n');
          }
        }
        eventsToSend.push({
          type: 'user.custom_tool_result',
          custom_tool_use_id: d.tool_use_id,
          content: [{ type: 'text', text: summary }],
          is_error: isError || undefined
        });
      }

      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend,
        onCustomToolUse: makeClientOnCustomToolUse(req.user.id),
        persistAssistantText: async (text, usage) => {
          await saveClientAssistantMessage({ userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 client chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// CoS (staff) — POST /api/ai/v2/staff/chat
async function saveStaffAssistantMessage({ userId, text, usage }) {
  const id = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  await pool.query(
    `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                              input_tokens, output_tokens,
                              cache_creation_input_tokens, cache_read_input_tokens)
     VALUES ($1, 'staff', 'global', $2, 'assistant', $3, $4, $5, $6, $7, $8)`,
    [id, userId, text, MODEL,
     usage.input_tokens, usage.output_tokens,
     usage.cache_creation_input_tokens || null, usage.cache_read_input_tokens || null]
  );
}

router.post('/v2/staff/chat',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    if (!FLAG_AGENT_MODE_STAFF) {
      return res.status(503).json({ error: 'v2 chat path is disabled. Set AGX_AGENT_MODE_STAFF=agents to enable.' });
    }
    const userMessage = (req.body && req.body.message || '').trim();
    if (!userMessage) return res.status(400).json({ error: 'message is required' });

    setSSEHeaders(res);
    try {
      const ctx = await buildStaffContext();
      const turnText = '<turn_context>\n' + ctxSystemToText(ctx.system) + '\n</turn_context>\n\n' + userMessage;

      const session = await ensureAiSession({
        agentKey: 'staff',
        entityType: 'staff',
        entityId: null,
        userId: req.user.id
      });
      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content)
         VALUES ($1, 'staff', 'global', $2, 'user', $3)`,
        [userMsgId, req.user.id, userMessage]
      );

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend: [{ type: 'user.message', content: [{ type: 'text', text: turnText }] }],
        onCustomToolUse: makeStaffOnCustomToolUse(),
        persistAssistantText: async (text, usage) => {
          await saveStaffAssistantMessage({ userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 staff chat error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

router.post('/v2/staff/chat/continue',
  requireAuth, requireCapability('ROLES_MANAGE'),
  async (req, res) => {
    const anthropic = getAnthropic();
    if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
    if (!FLAG_AGENT_MODE_STAFF) {
      return res.status(503).json({ error: 'v2 chat path is disabled.' });
    }
    const decisions = req.body && req.body.tool_results;
    if (!Array.isArray(decisions) || !decisions.length) {
      return res.status(400).json({ error: 'tool_results is required' });
    }

    setSSEHeaders(res);
    try {
      const sessionRow = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE agent_key = 'staff' AND entity_type = 'staff'
             AND entity_id IS NULL AND user_id = $1 AND archived_at IS NULL`,
        [req.user.id]
      );
      if (!sessionRow.rows.length) {
        res.write('data: ' + JSON.stringify({ error: 'No active session — start a new turn.' }) + '\n\n');
        res.write('data: [DONE]\n\n');
        return res.end();
      }
      const session = sessionRow.rows[0];

      const eventsToSend = [];
      for (const d of decisions) {
        let summary, isError = false;
        if (!d.approved) {
          summary = d.reject_reason || 'User rejected this proposal.';
          res.write('data: ' + JSON.stringify({ tool_rejected: { id: d.tool_use_id, name: d.name } }) + '\n\n');
        } else {
          try {
            summary = await execStaffTool(d.name, d.input || {});
            res.write('data: ' + JSON.stringify({ tool_applied: { id: d.tool_use_id, name: d.name, input: d.input, summary: summary.slice(0, 500) } }) + '\n\n');
          } catch (e) {
            summary = 'Error: ' + (e.message || 'failed');
            isError = true;
            res.write('data: ' + JSON.stringify({ tool_failed: { id: d.tool_use_id, name: d.name, input: d.input, error: summary } }) + '\n\n');
          }
        }
        eventsToSend.push({
          type: 'user.custom_tool_result',
          custom_tool_use_id: d.tool_use_id,
          content: [{ type: 'text', text: summary }],
          is_error: isError || undefined
        });
      }

      await pool.query('UPDATE ai_sessions SET last_used_at = NOW() WHERE id = $1', [session.id]);

      await runV2SessionStream({
        anthropic, res,
        session: session,
        eventsToSend,
        onCustomToolUse: makeStaffOnCustomToolUse(),
        persistAssistantText: async (text, usage) => {
          await saveStaffAssistantMessage({ userId: req.user.id, text, usage });
        }
      });
    } catch (e) {
      console.error('AI v2 staff chat/continue error:', e);
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    }
  }
);

// POST /api/ai/exec-tool — generic auto-tier read-tool executor.
// AG\'s client-side AUTO_READ_TOOLS appliers POST { name, input }
// here; the server runs execStaffTool inline (the same auto-tier
// read paths the chief of staff uses) and returns the formatted
// result string. One endpoint covers read_materials,
// read_purchase_history, read_subs, read_lead_pipeline — adding a
// new auto-tier read tool just needs a new case in execStaffTool,
// no per-tool endpoint.
//
// Auth: ESTIMATES_VIEW (the cap PMs running AG sessions already have).
// The tools themselves are read-only — no mutation paths here.
const ALLOWED_AG_AUTO_TOOLS = new Set([
  'read_materials',
  'read_purchase_history',
  'read_subs',
  'read_lead_pipeline',
  'read_clients',
  'read_leads',
  'read_past_estimate_lines',
  'read_past_estimates'
]);
router.post('/exec-tool', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const name = req.body && req.body.name;
    const input = (req.body && req.body.input) || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!ALLOWED_AG_AUTO_TOOLS.has(name)) return res.status(400).json({ error: 'tool not allowed via this endpoint' });
    const summary = await execStaffTool(name, input);
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('POST /api/ai/exec-tool error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// Internals exposed for sibling modules (eval harness in
// admin-agents-routes). NOT for general use — these bypass the
// streaming + auth flow that production AG depends on.
// List of admin-overridable named sections per agent. Returned by
// /api/admin/agents/sections so the skill-pack editor can render a
// "Replaces section" dropdown with descriptions + default bodies.
function sectionsForAgent(agentKey) {
  const out = [];
  Object.keys(SECTION_DEFAULTS).forEach(id => {
    const def = SECTION_DEFAULTS[id];
    if (def && def.agent === agentKey) {
      out.push({ id, description: def.description || '', body: def.body || '' });
    }
  });
  return out;
}

module.exports = router;
module.exports.internals = {
  buildEstimateContext,
  buildJobContext,
  buildClientDirectoryContext,
  buildStaffContext,
  sectionsForAgent,
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
