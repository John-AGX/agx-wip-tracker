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
// toFile wraps a Buffer as an Uploadable for beta.skills.create.
// Used by the propose_skill_pack_mirror tool below so CoS can push
// local packs to Anthropic native Skills via the approval flow.
const { toFile } = require('@anthropic-ai/sdk');
const { pool } = require('../db');
const { requireAuth, requireCapability, hasCapability, requireOrg } = require('../auth');
const { storage } = require('../storage');

const router = express.Router();

// ── Legacy chat endpoints — dead-routed to the unified /86/chat ─────
// Pre-unification the app had per-surface chat endpoints (estimate, job,
// client, staff, intake) that each opened their own Anthropic session
// with a full system prompt and tool list. The unified /86/chat path
// serves every surface now via the managed-agent V2 sessions API; the
// per-surface paths just duplicated the token spend (every visit paid
// system + tools cache_creation independently). No client code calls
// these any more (confirmed by grep). Return 410 Gone so any stale
// client tab surfaces the issue loudly instead of silently double-
// billing. Delete the dead handler bodies further down the file in a
// follow-up sweep — the early router.use below short-circuits them so
// the inline definitions never see a request.
const LEGACY_CHAT_PATHS = [
  '/estimates/:id/chat',
  '/estimates/:id/chat/continue',
  '/v2/estimates/:id/chat',
  '/v2/estimates/:id/chat/continue',
  '/jobs/:id/chat',
  '/jobs/:id/chat/continue',
  '/v2/jobs/:id/chat',
  '/v2/jobs/:id/chat/continue',
  '/clients/chat',
  '/clients/chat/continue',
  '/staff/chat',
  '/staff/chat/continue',
  '/v2/intake/chat',
  '/v2/intake/chat/continue',
  '/ask86/chat',
  '/ask86/chat/continue'
];
for (const p of LEGACY_CHAT_PATHS) {
  router.post(p, (req, res) => {
    console.warn('[legacy-chat] blocked POST ' + req.originalUrl +
      ' — caller should use /api/ai/86/chat instead');
    res.status(410).json({
      error: 'This endpoint is retired. Use POST /api/ai/86/chat with current_context describing the surface (estimate / job / intake / client / staff / ask86).',
      gone: true,
      replacement: '/api/ai/86/chat'
    });
  });
}

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
  // Recreate the client if the key changed (rare, but possible on rotation).
  // Default headers opt every request into the beta features we
  // depend on:
  //   - files-api-2025-04-14 unlocks {source:{type:'file',file_id:'…'}}
  //     image blocks so the chat path can reference pre-uploaded
  //     photos by id instead of re-base64-encoding the bytes every
  //     turn.
  //   - compact-2026-01-12 enables server-side session compaction.
  //     Once a session's context approaches the trigger threshold
  //     (~150k input tokens by default) Anthropic auto-summarizes
  //     earlier turns server-side and the rolling user-thread can
  //     run indefinitely without context-window blow-up. Phase 4c
  //     of the unified-86 cutover relies on this — without it, a
  //     long-lived user-thread session would die at ~1M tokens.
  if (!_anthropicClient || _anthropicKey !== key) {
    _anthropicClient = new Anthropic({
      apiKey: key,
      defaultHeaders: { 'anthropic-beta': 'files-api-2025-04-14,compact-2026-01-12' }
    });
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
// Per-agent overrides — 86's WIP / margin audits benefit from
// higher thinking budgets; line-item / intake turns don't. Each
// env var is optional; missing → falls back to AI_EFFORT.
//   AI_EFFORT_JOB   86 (operator — estimating + intake + WIP)
//   AI_EFFORT_CRA   86 directory surface (legacy "cra" key)
//   AI_EFFORT_STAFF Chief of Staff
// (Legacy AI_EFFORT_AG still honored as a fallback for AI_EFFORT_JOB
//  in case anyone still has it set in their Railway env vars — drop
//  this fallback after the next ops review.)
const EFFORT_PER_AGENT = {
  job:   (process.env.AI_EFFORT_JOB || process.env.AI_EFFORT_AG || '').trim().toLowerCase(),
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

// Unified-86 Phase 5 — adaptive thinking lets the model self-moderate
// reasoning depth per turn rather than burning a fixed `effort` for
// every request. Cheaper on chit-chat, deeper on hard problems, same
// quality ceiling. Returns the partial payload {thinking: {...}} so
// callers spread it alongside other turn config; null when the
// current model doesn't support adaptive thinking. Opus 4.7
// additionally supports display:"summarized" so a collapsed
// thinking-summary streams to the UI — that's what the panel can
// render as a disclosure. Older Opus / Sonnet variants get plain
// adaptive thinking with no display variant (Phase 5b/UI work can
// hook the summary stream once we're on 4.7).
const ADAPTIVE_THINKING_SUPPORTED = new Set([
  'claude-opus-4-5', 'claude-opus-4-6', 'claude-opus-4-7', 'claude-sonnet-4-6'
]);
function thinkingClause() {
  if (!ADAPTIVE_THINKING_SUPPORTED.has(MODEL)) return null;
  if (MODEL === 'claude-opus-4-7') {
    return { thinking: { type: 'adaptive', display: 'summarized' } };
  }
  return { thinking: { type: 'adaptive' } };
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
        unit_cost: { type: 'number', description: 'Project 86 cost per unit, NOT client price. Markup is applied separately.' },
        markup_pct: { type: 'number', description: 'Optional per-line markup % override. Omit to inherit the subgroup header\'s markup (the standard case).' },
        section_name: { type: 'string', description: 'REQUIRED in practice — the subgroup to slot the line under. Use a case-insensitive substring of one of the four standard subgroup names: "Materials & Supplies Costs" (any physical material, hardware, finish, fastener, paint, lumber, fixture, supply), "Direct Labor" (Project 86 crew hours — anything our own crew physically does), "General Conditions" (mobilization, dump fees, permits, supervision, equipment rental, signage, port-a-john), "Subcontractors Costs" (any scope handed off to another company — paint sub, roof sub, tile sub, etc.). If a custom subgroup exists from a previous user request, you can match it by substring instead. NEVER omit this — uncategorized lines confuse the BT export.' },
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
    description: 'Propose adding a NEW custom subgroup header to the active group. ⚠ Use this ONLY when the user explicitly asks for a custom subgroup ("add a Stair Tread Repairs section under Materials" — no, slot lines into the existing Materials subgroup; "add a separate subgroup for change-order work" — yes, that\'s a real custom subgroup). 99% of the time you should be slotting line items into the FOUR EXISTING standard subgroups (Materials / Labor / GC / Subs) via propose_add_line_item with section_name set. Markup is set per estimate by the user after costs are confirmed — do not apply default markup percentages. Omit markup_pct (or pass 0) and let the user dial it in.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Section name (e.g., "Stair Tread Replacement").' },
        bt_category: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Optional BT cost category mapping. Omit if the section is not one of the four standard cost buckets.' },
        markup_pct: { type: 'number', description: 'Section markup %. Lines under this header inherit it. Markup is set per estimate by the user after costs are confirmed — do not apply default percentages. Omit (or pass 0) to leave it for the user to set manually.' },
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
        unit_cost: { type: 'number', description: 'New Project 86 unit cost, or omit.' },
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
    description: 'Propose appending a durable, agent-readable note to the linked client. Notes auto-inject into 86\'s system prompt on every future turn touching this client (estimate, job, or directory surface), so they compound knowledge across sessions. Only call when you\'ve learned something the user told you that should outlive this conversation — pricing preferences, billing quirks, gate codes, scope rules, contact preferences. NEVER call for facts already in the client record (name, address, salesperson) or for ephemeral state (current weather, today\'s schedule). Only available when the estimate is linked to a client (see context above); skipped otherwise.',
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
    description: 'Search Project 86\'s materials catalog (real purchase history from Home Depot + other vendors — actual prices Project 86 has paid). Auto-applies, no approval. **CALL THIS BEFORE QUOTING ANY MATERIALS LINE ITEM** so your unit costs come from real Project 86 purchase data instead of guesses. Returns each match with cleaned description, unit, last/avg/min/max prices, last-seen date, and total times purchased. Use the most specific keyword you can — "5/4 deck board PT", "trex transcend", "drywall mud", "joist hanger 2x10". If nothing matches, narrow further (or tell the user the SKU isn\'t in our catalog yet so they know to log it after buying).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across description / raw_description / SKU. Use trade words: "PT pickets", "joist hanger", "Behr Marquee", "Hardie lap siding".' },
        subgroup: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Filter to one Project 86 subgroup. Default: all.' },
        category: { type: 'string', description: 'Filter to one Project 86 category, e.g. "Lumber & Decking", "Paint", "Fasteners". Use read_materials with no filters first if unsure what categories exist.' },
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
    description: 'Query Project 86\'s subcontractor directory. Returns name, trade, status, cert (GL / WC / W9 / Bank) expiration dates, primary contact, business phone — everything you need to know if a sub is available + paperwork-current before scoping work to them. Use it when you\'re drafting a Subcontractors line, or when the user mentions "use ABC Drywall" and you want to confirm they\'re an active sub.',
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
    description: 'Query the Project 86 leads pipeline. Returns title, status, projected_revenue, salesperson, market, source, age, projected_sale_date — both individual leads and rollup counts by status. Use it when scoping a new estimate ("what other leads do we have like this?"), when the user asks about pipeline health, or when the linked-lead context above isn\'t enough and you want sibling context.',
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
  // `excludeFromTotal` flag for Good/Better/Best style scenarios. 86 can
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
      'Link this estimate to a client record. Use when the user mentions a client name and the estimate doesn\'t yet have linked_client_id, or when read_clients returns a high-confidence match. After linking, the client\'s notes auto-inject into 86\'s context every turn (see propose_add_client_note for the writeback flow).',
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
      'Search the Project 86 clients directory. Returns id, name, parent client (if any), city, primary contact, and any agent-readable notes. Use this before propose_link_to_client when the estimate isn\'t linked yet and the user mentions a client name. Substring match on name and contact.',
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
      'Search the Project 86 leads pipeline by free text + filters. Lighter-weight than read_lead_pipeline (this one targets a specific lead lookup for linking; read_lead_pipeline is for pipeline analytics). Returns id, title, status, projected_revenue, salesperson, market.',
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
      'Search line items across ALL past Project 86 estimates for pricing benchmark. Returns up to N matching lines with description, qty, unit, unit_cost, markup, section name, parent estimate id + title, and last-modified date. Use BEFORE quoting a non-materials line (labor or sub) so you anchor to Project 86 history instead of guessing — for materials use read_materials (real receipts).',
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
      'Search past Project 86 estimates by title + client + total. Returns estimate id, title, client name, total, status, sold/lost outcome, last-modified. Use to answer "have we done a porch repaint at PAC before?" or to find a recent comparable estimate to model the new one on.',
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
// Job-side tools — write capabilities for 86 (WIP analyst).
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
      'Use when audit findings list a disconnected node and the right parent is obvious from context. Both ids MUST exist in the # Node graph block. ' +
      'Default ports are 0 unless the user specified another port.\n\n' +
      'Recommended topologies for cost flow:\n' +
      '  • inv → po → sub → phase (legacy): sub fans cost to every wired phase. Use ONLY when one PO/sub maps 1:1 to one phase. With multiple phases it double-counts the sub accrued on every phase — fix with set_wire_alloc_pct on each sub→phase wire so they sum to 100, OR migrate to the direct pattern below.\n' +
      '  • inv → po → phase (recommended for multi-phase contracts): wire each PO directly to the phase(s) it covers. If one PO spans multiple phases, add a wire from the PO to each phase and use set_wire_alloc_pct to split (e.g. 60/40). The sub node stays as a contact-record label; cost flows through the PO→phase edges, not through sub→phase.\n' +
      'When you switch a PO from PO→sub→phase to PO→phase direct, also detach the sub→phase wires (or set their allocPct=0) so the same dollars don\'t get summed twice.',
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
      'Create a new invoice on the active job. Use when QB shows a vendor invoice that hasn\'t been logged into Project 86 yet, when the user dictates one ("Acme sent us $12,400 for Apr 15"), or when the playbook\'s chain rule (PO → Invoice → QB-line) requires a missing invoice node. ' +
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
    name: 'request_edit_mode',
    description:
      'Ask the PM\'s permission to switch from Plan mode to Edit mode so you can write changes ' +
      '(set_phase_pct_complete, set_phase_field, set_node_value, assign_qb_line, etc.). Use this ' +
      'in Plan mode whenever your analysis surfaces an action you\'d need to take but can\'t — ' +
      'e.g. "B1 has cost data but pctComplete=0, want me to set it to 100%?" or "131 QB lines are ' +
      'unlinked, want me to wire them to their nodes?". The PM gets an approval card listing your ' +
      'planned actions; on approve, the panel flips to Edit mode and your next turn opens with ' +
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
          description: 'Bullet list of the specific writes you intend to make if granted Edit mode. Each line: action + target. Example: ["Set B1 pctComplete to 100%", "Set B2 pctComplete to 100%", "Assign 14 unlinked Home Depot lines to materials sub-node"]. The PM uses this to decide whether to grant access.'
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
      'Set the allocation percent on a single graph wire — how much of the source\'s value flows along this wire. Two patterns use this:\n' +
      '  1. Revenue split: t2 / co → t1 building wires apportion phase revenue across buildings (e.g. COATINGS is mostly for B1 and only a sliver to B7).\n' +
      '  2. Cost split: po → t2 phase and sub → t2 phase wires apportion the contract / sub accrual across phases when a single PO or sub serves more than one phase. Set this when one PO covers multiple phases — without it the engine sums the FULL accrued on every phase (the doubling pattern audited on j5).\n' +
      'allocPct sums across all outgoing wires from a source should equal 100; the engine accepts other values but the rollup misreads if a source has 200% allocated. Confirm the sum after each change.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        from_node_id: { type: 'string', description: 'Source node id — t2 / co for revenue split, po / sub for cost split.' },
        to_node_id:   { type: 'string', description: 'Target node id — t1 for revenue split, t2 (phase) for cost split.' },
        alloc_pct:    { type: 'number', minimum: 0, maximum: 100, description: 'New allocation percent (0–100). 100 = 100% of source flows along this wire.' },
        rationale:    { type: 'string', description: 'One short sentence — why this split.' }
      },
      required: ['from_node_id', 'to_node_id', 'alloc_pct', 'rationale']
    }
  },

  // ──────────────────────────────────────────────────────────────────
  // Cross-surface read tools — added when 86 took on full company scope.
  // CoS-side: introspection (metrics / conversations / skill packs).
  // Client-directory side: directory lookups (jobs / users). Mutation
  // tools from CoS (propose_skill_pack_*) and the directory surface
  // (create_property, etc.) are NOT in this list — those still flow
  // through the dedicated CoS / Directory panels via approval cards.
  // This expansion gives 86 read scope across every surface without
  // bouncing the user.
  // ──────────────────────────────────────────────────────────────────
  {
    name: 'read_metrics',
    description: 'Aggregate AI-agent usage metrics for a window. Returns per-agent totals (turns, conversations, unique users, tool uses, photos, tokens, model mix). Use to answer "how am I doing this week?" / "what does each agent cost?" / "is anyone overusing tools?". Auto-tier — runs without approval.',
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
    description: 'List recent AI-agent conversations (one row per entity+user pair) with turn count, tool uses, tokens, last activity. Use to spot patterns or pick a conversation to drill into via read_conversation_detail. Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        range: { type: 'string', enum: ['7d', '30d'] },
        entity_type: { type: 'string', enum: ['estimate', 'job', 'client'] },
        limit: { type: 'integer', minimum: 1, maximum: 200 }
      },
      required: []
    }
  },
  {
    name: 'read_conversation_detail',
    description: 'Read every message of a specific conversation. Pass the `key` from read_recent_conversations (entity_type|entity_id|user_id, joined with pipes). Returns user + assistant turns. Use to investigate a specific case. Auto-tier.',
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
    description: 'List the admin-editable skill packs registered for this org. Each pack has name, body preview, agent assignments, and anthropic_skill_id. Use to recommend new skills, audit existing ones, or answer "what context do I have available?". Auto-tier. Bodies are truncated to ~600 chars per pack; the full content lives in the Anthropic native Skill registered on the agent and is auto-discovered by description each turn.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  {
    name: 'search_my_sessions',
    description:
      'Search the current user\'s prior chat sessions for relevant past conversations. Use when the user references something you discussed previously ("you mentioned this last week", "what did we decide about Job RV2018?") or when you think prior context would help answer the current question. Searches labels, summaries, and message bodies; returns up to 10 matches with snippets. Auto-tier (no approval). Sessions are per-user — you only see the current user\'s history.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search terms — substring match across labels, summaries, and message bodies. Use the same words the user used; you don\'t need to be clever.' },
        limit: { type: 'integer', description: 'Optional cap on results. Default 10, max 30.', minimum: 1, maximum: 30 }
      },
      required: ['query']
    }
  },
  {
    name: 'search_my_kb',
    description:
      'Search every file the current user has uploaded — across all buckets (My Files, plus anything they attached to a job, estimate, lead, client, or sub). Returns up to 20 matches with filename, where the file lives (entity_type + id), folder, mime, size, and a snippet of extracted text. Use when the user references something they uploaded ("the spreadsheet I uploaded last week", "the proposal I just exported", "the photo I attached to the Latitude job"). Auto-tier (no approval). Scope: uploaded_by = ctx.userId — never another user\'s files. Call read_attachment_text({attachment_id}) to fetch the full body.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search terms. Matches against filename + extracted_text content (case-insensitive substring).' },
        limit: { type: 'integer', description: 'Optional cap on results. Default 20, max 50.', minimum: 1, maximum: 50 }
      },
      required: ['query']
    }
  },
  {
    name: 'search_org_kb',
    description:
      'Search the COMPANY knowledge base — every file uploaded across the org. Includes the company-files bucket (admin-curated org-wide docs: brand assets, SOPs, master pricing, template proposals) AND every user\'s personal "My Files" bucket AND every job/estimate/lead attachment. Use when the user asks anything that might be covered by an existing doc anywhere ("do we have a template for X?", "find the latest insurance cert", "what did Steve write on the Wimbledon scope?"). Returns up to 20 matches with filename, where it lives (which user / job / estimate), mime, size, and a snippet. Auto-tier. Scope: caller\'s organization only (cross-tenant access blocked). Call read_attachment_text({attachment_id}) for the full body.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Search terms. Matches against filename + extracted_text content (case-insensitive substring).' },
        limit: { type: 'integer', description: 'Optional cap on results. Default 20, max 50.', minimum: 1, maximum: 50 },
        scope: { type: 'string', enum: ['all', 'org_bucket', 'user_buckets', 'entity_buckets'], description: 'Which slice of the KB to search. "all" (default) covers every bucket. "org_bucket" = company-curated files only. "user_buckets" = every user\'s My Files. "entity_buckets" = job/estimate/lead/client/sub attachments.' }
      },
      required: ['query']
    }
  },
  {
    name: 'search_reference_sheet',
    description:
      'Search live reference workbooks the admin has wired up to Project 86 — typically the Job Numbers sheet, Client Short Names sheet, WIP report, master pricing, etc. These are SharePoint / Google Drive XLSX files refreshed every ~15 min. Most rows are kept out of your system prompt to save tokens; call this whenever a user mentions a job number, a community / client short name, or anything else that would map to a row in one of these sheets and you need the canonical id. ' +
      'No args: returns the list of available sheets with row counts. With a query: substring-scans every enabled sheet and returns the matching rows. Auto-tier (no approval).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Substring to find. Case-insensitive. Matches per-line so a job number lookup ("RV2024") or community name ("Latitude") returns the relevant row(s).' },
        sheet_title: { type: 'string', description: 'Optional — restrict the search to one sheet by exact title (case-insensitive). Use the title field from the no-arg listing.' },
        limit: { type: 'integer', description: 'Optional cap on returned rows. Default 20, max 50.', minimum: 1, maximum: 50 }
      },
      required: []
    }
  },
  {
    name: 'read_active_lines',
    description:
      'Return the full line-by-line detail of the active group on an estimate: section header rows, cost-side line items with description / qty / unit / unit_cost / markup / line_id, plus subgroup roll-ups. Use when you need to propose an edit, audit an estimate, or compute totals. ' +
      'The per-turn estimate context shows compact subgroup roll-ups only when the estimate has more than 12 cost-side lines — call this to get the line_ids and full detail. Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        estimate_id: { type: 'string', description: 'The estimate id (e.g. "e1778605032519"). Omit to use the estimate referenced in the current turn_context.' },
        section_id: { type: 'string', description: 'Optional — scope to one subgroup (use the subgroup_id from the roll-up).' },
        limit: { type: 'integer', minimum: 1, maximum: 500, description: 'Cap the line count returned. Default 200 (well above any realistic active-group size).' }
      },
      required: []
    }
  },
  {
    name: 'read_attachment_text',
    description:
      'Fetch the FULL extracted text body of one attached document (PDF, Excel, Word, CSV, plain text). The per-turn manifest only shows a 200-char preview to keep token costs down — call this when you need to quote, cite, scope from, or compute against the doc. Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachment_id: { type: 'string', description: 'The id from the manifest entry (### [source] filename · id=... line in turn_context).' },
        max_chars: { type: 'integer', minimum: 500, maximum: 200000, description: 'Cap the response. Default 60000 (~15k tokens). Lower this for big specs you only need to skim.' }
      },
      required: ['attachment_id']
    }
  },
  {
    name: 'view_attachment_image',
    description:
      'Pull the actual pixels of one attached IMAGE so you can analyze it visually. Use when the user asks about visual conditions (paint color, damage extent, framing detail, photo-based scope verification) and the relevant photo is in the per-turn attachments manifest. Returns the image inline as vision content in this tool result. Auto-tier. ' +
      'Only call this for images you actually need to see — each image costs vision tokens. The estimate / job manifest lists every attached photo with its id; pull the specific one that matches the user\'s question rather than every photo.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        attachment_id: { type: 'string', description: 'The id from the manifest entry (e.g. att_xxx). Must be an image attachment.' }
      },
      required: ['attachment_id']
    }
  },
  {
    name: 'self_diagnose',
    description:
      'Introspect your own recent activity to figure out why a proposed change did not land. Returns, for each recent assistant turn that emitted tool_use blocks: what you proposed (tool name + input), whether the user approved or rejected it on /chat/continue, and — for estimate-side proposals — whether the line/section/group is actually present in the estimate right now. ' +
      'CRITICAL: call this WHEN the user says things like "you didn\'t add the line items" / "that didn\'t work" / "still nothing" / "why didn\'t you do X". Do not guess — pull the trace. The function answers four questions: (1) what did I propose? (2) did I emit the right tool? (3) did the user approve? (4) did the apply actually mutate the estimate? If a proposal was approved but the row is missing, that is the smoking gun — surface it. ' +
      'Auto-tier. Default window 1h.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        window_minutes: {
          type: 'integer',
          minimum: 5,
          maximum: 1440,
          description: 'How far back to look. Default 60.'
        },
        estimate_id: {
          type: 'string',
          description: 'Optional — narrow to one estimate (by id). When provided, the response also reports current line count and the most recent ai_phase on the estimate.'
        }
      },
      required: []
    }
  },
  {
    name: 'navigate',
    description:
      'Take the user to a specific page or entity in the app. Auto-tier — applies immediately, no approval card. ' +
      'Use this when the user asks to "go to", "open", "show me", or "switch to" something. ' +
      'Destinations: home (dashboard), leads, estimates, clients, subs (sub-tabs of the Estimates section), ' +
      'schedule, wip, insights, tools (field tools — calculators/lookups), admin (top-level tabs). ' +
      'For specific entities, use job / estimate / lead and pass entity_id. ' +
      '**CRITICAL: entity_id must be the ROW id (e.g. "j5", "j_1778251182669"), NOT the human-readable ' +
      'jobNumber (e.g. "RV2001"). Passing the jobNumber opens an empty page because the route does ' +
      'not look up by display number.** When the user references a job by jobNumber or a client by name, ' +
      'ALWAYS call read_jobs / read_clients first to resolve the row id, then pass that id to navigate. ' +
      'Example: user says "open RV2001" -> first read_jobs({q:"RV2001"}) returns id "j5" -> ' +
      'navigate({destination:"job", entity_id:"j5"}).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        destination: {
          type: 'string',
          enum: [
            'home', 'leads', 'estimates', 'clients', 'subs',
            'schedule', 'wip', 'insights', 'tools', 'admin',
            'job', 'estimate', 'lead'
          ],
          description: 'Where to take the user.'
        },
        entity_id: {
          type: 'string',
          description: 'Required when destination is job / estimate / lead. The exact entity id from a prior read tool.'
        }
      },
      required: ['destination']
    }
  },
  {
    name: 'read_wip_summary',
    description:
      'Company-wide WIP roll-up. Returns per-job financial summary (contract value, costs, % complete, revenue earned, JTD profit/margin, backlog, invoiced, unbilled) PLUS portfolio totals. Use this for "what\'s under contract right now", "show me our biggest jobs by remaining backlog", "any margin red flags", "what\'s our total billed-to-date". This is the AGGREGATE rollup — replaces the need to fan out per-job WIP reads. Filter by status (e.g. "In Progress" excludes Completed/Archived). The numbers match what the PM sees on the WIP page tiles — same `computeJobWIP` formula. Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', description: 'Filter to one status: New / In Progress / Backlog / On Hold / Completed / Archived. Omit to include all.' },
        sort_by: { type: 'string', enum: ['backlog', 'contract', 'margin', 'pct_complete'], description: 'Sort key for the per-job list. Default backlog (descending = biggest remaining first).' },
        limit: { type: 'integer', minimum: 1, maximum: 200, description: 'Max jobs in per-job list (totals still cover the full filtered set). Default 20.' }
      },
      required: []
    }
  },
  {
    name: 'read_jobs',
    description: 'List jobs in Project 86 with their identity-card fields (jobNumber, title, client linkage, status, location, PM). Use to answer who/where/what for a specific job — NOT financial / WIP / scope detail. For financial roll-up use read_wip_summary instead. Pass q for fuzzy match. Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        status: { type: 'string', description: 'Optional status filter ("New", "In Progress", "Backlog", "On Hold", "Completed", "Archived").' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },
  {
    name: 'propose_link_job_to_client',
    description:
      'Link one job to a client record. Use when read_jobs flags a job without a client link, or when the user mentions which client a job belongs to. Stores client_id on the job\'s data blob (data.clientId). Server-applied on approval — no client-side editor needed. Talk-through tier: describe which job → which client in prose, end with "Approve?", and the client commits the link without a separate card.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        job_id:    { type: 'string', description: 'Job id from read_jobs.' },
        client_id: { type: 'string', description: 'Client id from read_clients.' },
        rationale: { type: 'string', description: 'One short sentence — how you identified the match.' }
      },
      required: ['job_id', 'client_id', 'rationale']
    }
  },
  {
    name: 'propose_bulk_link_jobs_to_clients',
    description:
      'Link many jobs to clients in one approval. Use after read_jobs surfaces a batch of unlinked jobs and you can match them to clients by name / property / community. Talk-through tier: list every job → client mapping in prose first, end with "Approve?", and the client commits all of them in one click. Up to 100 links per call.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        links: {
          type: 'array',
          maxItems: 100,
          description: 'One entry per job→client mapping.',
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              job_id:    { type: 'string' },
              client_id: { type: 'string' },
              note:      { type: 'string', description: 'Optional one-line reason this match holds.' }
            },
            required: ['job_id', 'client_id']
          }
        },
        rationale: { type: 'string', description: 'One short paragraph — how you grouped these matches.' }
      },
      required: ['links', 'rationale']
    }
  },
  {
    name: 'read_users',
    description: 'List Project 86 staff users (PMs, admins, corporate) with name, email, role, active status. Use to answer "who\'s the PM on this job", "is X still on staff", "who can I assign this to". Auto-tier.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string' },
        role: { type: 'string', description: 'Filter — admin / corporate / pm / sub.' },
        active_only: { type: 'boolean', description: 'Default true. Excludes deactivated users.' },
        limit: { type: 'integer', minimum: 1, maximum: 100 }
      },
      required: []
    }
  },

  // ──────── Field tools — self-contained HTML utilities ────────
  // 86 can spin up small calculators / lookups / forms on demand. They
  // live in field_tools and render in a sandboxed iframe on the Tools
  // tab. Use these for quick mobile-friendly utilities the team uses
  // in the field (pressure-wash labor calc, gable sqft calc, etc.).
  {
    name: 'read_field_tools',
    description: 'List every field tool stored in this workspace. Returns id, name, description, category, last update. Call before propose_create_field_tool to avoid duplicate names, or before propose_update_field_tool / propose_delete_field_tool to find the right id.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
      required: []
    }
  },
  {
    name: 'propose_create_field_tool',
    description: 'Create a new field tool — a self-contained HTML document the team opens on a phone in the field. Examples: pressure-wash labor calculator, gable sqft calc, paint coverage estimator, take-off helper. Approval-required so the user reviews the HTML before it lands. STRICT CONSTRAINTS: html_body must be a complete <!doctype html>...</html> document with inline <style> + <script>; NO external CDN / network references (field crews may be offline); mobile-first layout (cards stack vertically, big tap targets); dark theme to match the rest of Project 86. Keep the body under ~400KB.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Short title shown in the Tools list. Must be unique.' },
        description: { type: 'string', description: 'One-line summary of what the tool does (shown as a subtitle on the card).' },
        category: { type: 'string', enum: ['calculator', 'lookup', 'form', 'other'], description: 'Optional category tag for filtering.' },
        html_body: { type: 'string', description: 'Full self-contained HTML document. Inline CSS in <style>, inline JS in <script>. No external sources.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this tool helps the team.' }
      },
      required: ['name', 'html_body', 'rationale']
    }
  },
  {
    name: 'propose_update_field_tool',
    description: 'Edit an existing field tool. Pass the id from read_field_tools plus only the fields you want to change. html_body is a full replacement, not a diff — pass the complete updated document.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Field tool id from read_field_tools.' },
        name: { type: 'string', description: 'Optional rename.' },
        description: { type: 'string', description: 'Optional description update.' },
        category: { type: 'string', enum: ['calculator', 'lookup', 'form', 'other'] },
        html_body: { type: 'string', description: 'Optional replacement HTML document.' },
        rationale: { type: 'string', description: 'One short sentence explaining the change.' }
      },
      required: ['id', 'rationale']
    }
  },
  {
    name: 'propose_delete_field_tool',
    description: 'Remove a field tool permanently. Approval-required since deletion is irreversible.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id: { type: 'string', description: 'Field tool id from read_field_tools.' },
        rationale: { type: 'string', description: 'One short sentence explaining why removal is the right call.' }
      },
      required: ['id', 'rationale']
    }
  }
];

// ──────────────────────────────────────────────────────────────────
// Context builder — pulls everything Claude needs to know about the
// estimate and formats it as a system-prompt prefix. Photos are returned
// separately so the chat handler can attach them as image blocks.
// ──────────────────────────────────────────────────────────────────

async function buildEstimateContext(estimateId, includePhotos, aiPhaseOverride, organization) {
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
    id: d.id,
    source: d.source,
    filename: d.filename,
    mime: d.mime_type,
    size: d.size_bytes,
    // Don't carry the full extracted_text on the manifest object —
    // the per-turn renderer now shows a preview only (first 200 chars).
    // 86 calls `read_attachment_text({attachment_id})` to fetch the
    // full body when he actually needs to quote it. Stops every chat
    // turn from re-shipping 5–15k tokens of unchanged PDF body.
    has_text: !!d.extracted_text,
    text_chars: d.extracted_text ? d.extracted_text.length : 0,
    text_preview: d.extracted_text ? d.extracted_text.slice(0, 200) : null
  }));

  // ────────────────────────────────────────────────────────────────
  // Build the system prompt as TWO blocks so we can cache the stable
  // prefix (identity, role, tools, slotting, skill packs, tone) and
  // only re-send the volatile estimate context each turn. Anthropic's
  // ephemeral cache is 5 min; 86 sessions usually fit inside that, so
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
  lines.push('You are an estimating assistant for Project 86, a Central Florida construction services company specializing in painting, deck repairs, roofing, and exterior services for HOAs and apartment communities.');
  lines.push('');
  lines.push('Here is the current estimate the user is working on:');
  lines.push('');
  lines.push('# Estimate');
  lines.push('- ID: ' + estimateId);
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
    lines.push('Project 86 organizes a multi-scope estimate into Groups (e.g., Deck 1, Deck 2, Roof, Optional Adds). Each group carries its own scope and its own line items. The proposal total = sum of every INCLUDED group; groups marked `excluded` are not priced or shown to the client. Use propose_switch_active_group / propose_add_group to operate on a different group.');
    alternates.forEach(a => {
      const isActive = a.id === blob.activeAlternateId;
      const isExcluded = !!a.excludeFromTotal;
      // Per-group cost-side subtotal so 86 can see what's already in
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
  //
  // Two render modes:
  //   COMPACT (>COMPACT_THRESHOLD cost-side lines)
  //     Subgroup roll-ups only: id + count + cost subtotal + markup +
  //     marked-up subtotal. Saves 60–80% on tokens for dense estimates.
  //     86 calls read_active_lines() to fetch the line-by-line detail
  //     when proposing edits.
  //   FULL (small estimates)
  //     Every line rendered with description/qty/unit/cost/markup/id,
  //     same as before. Useful while building so 86 spots gaps.
  const COMPACT_THRESHOLD = 12;
  const costLines = activeLines.filter(l => l && l.section !== '__section_header__');
  const sectionHeaders = activeLines.filter(l => l && l.section === '__section_header__');
  if (activeLines.length) {
    if (costLines.length > COMPACT_THRESHOLD) {
      // Compact mode — subgroup roll-ups.
      lines.push('## Line items in active group (compact — ' + costLines.length + ' lines across ' + sectionHeaders.length + ' subgroups)');
      lines.push('Call `read_active_lines({estimate_id: "' + estimateId + '"})` to fetch the full line-by-line detail (line_id, description, qty, unit, cost, markup) when you need to propose an edit. Pass `{estimate_id, section_id}` to scope to one subgroup.');
      lines.push('');
      // Walk in declared order so subgroup positions are preserved
      const groupDefaultMarkup = (blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0;
      let currentHeader = null;
      let groupRows = [];
      function flushGroup() {
        if (!currentHeader) return;
        const subMarkup = (currentHeader.markup === '' || currentHeader.markup == null)
          ? groupDefaultMarkup
          : parseFloat(currentHeader.markup);
        let cost = 0;
        groupRows.forEach(l => {
          const qty = parseFloat(l.qty) || 0;
          const uc = parseFloat(l.unitCost) || 0;
          cost += qty * uc;
        });
        // Marked-up subtotal — apply per-line override when set, else subgroup markup.
        let markedUp = 0;
        groupRows.forEach(l => {
          const qty = parseFloat(l.qty) || 0;
          const uc = parseFloat(l.unitCost) || 0;
          const lineMarkup = (l.markup === '' || l.markup == null) ? subMarkup : parseFloat(l.markup);
          markedUp += (qty * uc) * (1 + (lineMarkup / 100));
        });
        lines.push('- ' + (currentHeader.description || 'subgroup') +
          ' (subgroup_id=' + currentHeader.id + '): ' +
          groupRows.length + ' line' + (groupRows.length === 1 ? '' : 's') +
          ', cost $' + cost.toFixed(2) +
          ', markup ' + subMarkup + '%' +
          ' → marked-up $' + markedUp.toFixed(2));
        groupRows = [];
      }
      activeLines.forEach(l => {
        if (l.section === '__section_header__') {
          flushGroup();
          currentHeader = l;
        } else if (currentHeader) {
          groupRows.push(l);
        }
      });
      flushGroup();
      lines.push('');
    } else {
      // Full mode — render every line, same as before.
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
    }
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

  // Photo manifest — always lists IDs so 86 can call view_attachment_image
  // even when the photos aren't auto-attached inline (the default).
  if (photoRows.length) {
    lines.push('# Photos');
    lines.push(photoRows.length + ' photo' + (photoRows.length === 1 ? '' : 's') + ' attached to this estimate' +
      (blob.lead_id ? ' (and linked lead)' : '') + '. ' +
      (photoBlocks.length
        ? photoBlocks.length + ' shown inline as vision content below.'
        : 'Call `view_attachment_image({attachment_id})` on the specific one you need to actually see — each image costs vision tokens, so pull only what the question requires.'));
    photoRows.slice(0, 24).forEach(p => {
      const sz = p.size_bytes ? Math.round(p.size_bytes / 1024) + ' KB' : '?';
      lines.push('  - [' + p.id + '] ' + (p.filename || '(unnamed)') + ' · ' + (p.source || 'estimate') + ' · ' + sz);
    });
    if (photoRows.length > 24) {
      lines.push('  - … and ' + (photoRows.length - 24) + ' more.');
    }
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
      lines.push(`Project 86 has ${totalMat} materials in the catalog (${recentMat} purchased in the last 90 days). Top categories: ${topCats.join(', ') || '(uncategorized)'}.`);
      lines.push('Call `read_materials` to query this catalog before quoting any materials line item — see the # Pricing rules above.');
      lines.push('**Search budget: cap reads at ~3 per scope of work.** If a query returns nothing, do NOT keep narrowing forever — go ahead and quote with a reasonable estimate, mark the line `unit_cost source: estimated (catalog miss)`, and tell the user the SKU isn\'t logged yet so they can add it later. The catalog is small and many real SKUs are missing.');
      lines.push('');
    }
  } catch (e) { /* materials table may not exist yet on a fresh deploy */ }

  // Attachments roll-up — ALWAYS rendered so the model has a
  // definitive signal of "I checked, here's what's attached" even
  // when nothing is. Splits estimate-side vs lead-side counts so
  // the model can tell the user exactly where to look (or upload).
  // Photos are sent inline as vision content; docs are listed with
  // extracted text (when available) for direct citation.
  var estPhotos = photoRows.filter(function(p) { return p.source === 'estimate'; }).length;
  var leadPhotos = photoRows.filter(function(p) { return p.source === 'lead'; }).length;
  var estDocs   = docManifest.filter(function(d) { return d.source === 'estimate'; }).length;
  var leadDocs  = docManifest.filter(function(d) { return d.source === 'lead'; }).length;
  var totalAtts = estPhotos + leadPhotos + estDocs + leadDocs;

  lines.push('# Attachments');
  if (totalAtts === 0) {
    lines.push('No attachments persisted on this estimate or its linked lead.');
    lines.push('If the user references "the attached document / RFP / spec sheet" and you can\'t find it here, tell them to upload it to either:');
    lines.push('  - Estimate → Attachments tab (for docs specific to this proposal), or');
    lines.push('  - Lead → Attachments tab (for the original RFQ from the client).');
    lines.push('Any images the user dropped INLINE THIS TURN (via the chat composer) are visible above as vision content — read those first if they relate to the question.');
    lines.push('');
  } else {
    lines.push('Estimate: ' + estPhotos + ' photo' + (estPhotos === 1 ? '' : 's') + ', ' + estDocs + ' doc' + (estDocs === 1 ? '' : 's') + '.');
    if (blob.lead_id) {
      lines.push('Linked lead: ' + leadPhotos + ' photo' + (leadPhotos === 1 ? '' : 's') + ', ' + leadDocs + ' doc' + (leadDocs === 1 ? '' : 's') + '.');
    }
    lines.push('Photos (' + (estPhotos + leadPhotos) + ') are attached as vision content above — describe / cite them directly.');
    lines.push('');
  }

  // Document manifest. PDF, Excel, Word, CSV, and plain-text contents are
  // extracted at upload time and inlined below in fenced blocks — read them
  // as authoritative content (RFPs, scopes, takeoffs, lead reports). For
  // formats without an extractor or for scanned PDFs that have no text
  // layer, the user can click "Ask AI" from the PDF viewer to attach
  // rendered page images this turn — treat those images as the doc.
  if (docManifest.length) {
    lines.push('## Attached documents (' + docManifest.length + ')');
    var anyWithText = docManifest.some(function(d) { return d.has_text; });
    var headerLine = anyWithText
      ? 'Filenames + size + a 200-char preview of each doc with extracted text. Call `read_attachment_text({attachment_id})` to pull the FULL body of any doc you need to quote, cite, or scope from. Don\'t guess — pull the bytes. The id for each doc is listed below.'
      : 'Filenames listed for reference. None of these docs have extracted text on file.';
    headerLine += ' For docs WITHOUT extracted text (scanned PDFs, photo reports like CompanyCam, image-only formats):' +
      ' if the user has clicked "Ask AI" from the PDF viewer, the page renders are attached as images this turn — read them with vision and treat that as the document content.' +
      ' Only ask the user to paste excerpts if no images were attached.';
    lines.push(headerLine);
    lines.push('');
    docManifest.forEach(function(d) {
      var sizeStr = d.size != null ? ' (' + (d.size > 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.round(d.size / 1024) + ' KB') + ')' : '';
      var mimeBit = d.mime ? ' · ' + d.mime : '';
      var idBit = d.id ? ' · id=' + d.id : '';
      lines.push('### [' + d.source + '] ' + d.filename + sizeStr + mimeBit + idBit);
      if (d.has_text) {
        lines.push('_' + d.text_chars + ' chars of extracted text on file. Preview:_');
        lines.push('```');
        lines.push(d.text_preview);
        lines.push('```');
        lines.push('_Call read_attachment_text({attachment_id:"' + d.id + '"}) to read the full body._');
      } else {
        lines.push('_(no extracted text — either an unsupported format or a scanned image. Read the rendered page images attached this turn, if any.)_');
      }
      lines.push('');
    });
  }

  // ─── STABLE PLAYBOOK (cached prefix — legacy direct-API only) ──────
  // Section overrides loaded first so each named block can be admin-
  // replaced via a skill pack with `replaces_section` set. See
  // SECTION_DEFAULTS for the registry.
  //
  // IMPORTANT (token cost): for the V2 unified /86/chat path, the
  // SECTION_DEFAULTS bodies are also baked into AGENT_SYSTEM_BASELINE
  // via composedAgentSystem() at agent-registration / sync time, so the
  // registered Anthropic agent already carries them in its persistent
  // system prompt — and /86/chat skips this stable block when
  // serializing the turn (see ctxDynamicText). The block is still built
  // here because legacy /estimates/:id/chat + /v2/estimates/:id/chat
  // paths use the direct messages API where the system array with
  // cache_control still gives the 10% cache_read pricing. Once those
  // legacy paths are retired we can stop building stableLines entirely.
  const sectionOverrides = await loadSectionOverridesFor('job');
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

  // Skill packs ship as native Anthropic Skills registered on the
  // agent — the runtime auto-discovers them by description each turn.
  // No system-prompt manifest, no load_skill_pack round-trip.

  // Tone — overridable via section_id `ag_tone`. See SECTION_DEFAULTS.
  renderSection(stableLines, 'ag_tone', sectionOverrides);

  // ─── ASSEMBLE ──────────────────────────────────────────────────────
  // System param goes out as an array of two text blocks. The first is
  // the playbook (cached); the second is the dynamic estimate context
  // refreshed each turn. The cache_control marker on the stable block
  // tells Anthropic to cache everything from the start of the request
  // (including the tools array) up through that block.
  // 86 phase — controls whether the model can propose line-item /
  // section edits this turn. Lives on the estimate JSONB blob; defaults
  // to 'build' when unset (back-compat with estimates created before
  // the toggle existed). The caller can override via aiPhaseOverride —
  // this is how the global Ask 86 surface (/86/chat) forces Build, since
  // chatting from outside the editor means the user has already opted
  // into action and the per-editor Plan/Build toggle doesn't apply.
  let aiPhase;
  if (aiPhaseOverride === 'build' || aiPhaseOverride === 'plan') {
    aiPhase = aiPhaseOverride;
  } else {
    aiPhase = blob.aiPhase === 'plan' ? 'plan' : 'edit';
  }

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
    packsLoaded: []
  };
}

// Filter the 86 tool list for Plan mode — drops every editing-style
// propose_* tool while keeping conversational + scope-capture + note
// + web search. Build mode passes through the full list. Used by the
// 86 chat + continue handlers; web tools are added back by runStream.
const PLAN_MODE_ALLOWED_AG_TOOLS = new Set([
  'propose_update_scope',
  'propose_add_client_note',
  // Reads stay available so 86 can research before proposing.
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

// Plan-mode allowlist for 86 (job side). Read tools + the
// request_edit_mode tool stay; every write tool is removed so the
// model literally cannot mutate WIP data while the PM is in analysis
// mode. The PM grants write access by approving a request_edit_mode
// card or flipping the phase pill manually.
const PLAN_MODE_ALLOWED_JOB_TOOLS = new Set([
  'read_workspace_sheet_full',
  'read_qb_cost_lines',
  'read_materials',
  'read_purchase_history',
  'read_subs',
  'read_building_breakdown',
  'read_job_pct_audit',
  'request_edit_mode',
  // CoS + directory read tools surfaced on 86 — pure introspection / lookup,
  // safe to keep available in plan mode.
  'read_metrics',
  'read_recent_conversations',
  'read_conversation_detail',
  'read_skill_packs',
  'search_my_sessions',
  'search_my_kb',
  'search_org_kb',
  'read_jobs',
  'read_users',
  'read_clients',
  'read_lead_pipeline',
  // Navigation — client-side DOM dispatch. No mutation of data so
  // it stays open in plan mode too.
  'navigate'
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
// declares triggers (currently supports `min_groups` for 86 — load
// only when the estimate has at least N groups), this context is
// matched against them. Packs without triggers always load
// (alwaysOn baseline).
// loadActiveSkillsFor + loadSkillManifestFor + packTriggersPass were
// retired with the native-Anthropic-skills migration. Anthropic
// auto-discovers attached skills by description on each turn — no
// system-prompt manifest, no load_skill_pack round-trip, no
// pack-trigger evaluation. The functions had zero callers post-
// migration; deleted in the system audit cleanup.

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
    agent: 'job',
    description: "Who 86 is. Edit when the platform's positioning / scope changes.",
    body: '# Who you are\nYou are 86 — Project 86\'s single unified operator agent. Project 86 is a SaaS platform for construction-services businesses (the org you serve is described in the org identity block above). You own every surface end-to-end:\n  • Lead intake (capture new opportunities, dedup against existing clients/leads)\n  • Estimating (scope, line items, materials, photos, proposals, group/subgroup discipline)\n  • Client + property + sub directory hygiene (this used to be a separate "HR" agent — that role is yours now)\n  • Job operations + WIP analysis (margin, change orders, billing health, the node graph, QB cost reconciliation)\n  • Self-introspection + skill-pack curation (you can propose your own skill-pack edits via approval cards — this used to be the "Chief of Staff" agent; that role is yours now too)\nYou think like a senior PM: specific, trade-fluent, opinionated about scope completeness, calibrated on the org\'s pricing reality. The user lands on different surfaces (estimate panel, job WIP view, intake panel, global Ask 86 widget) — the per-turn context tells you which. Adapt the work to the surface without changing identity.'
  },
  ag_estimate_structure: {
    agent: 'job',
    description: 'How 86 should think about Group / Subgroup / Line hierarchy. Edit if the estimate model changes.',
    body: '# Estimate structure\nEstimates are organized as Groups → Subgroups → Lines.\n  • Group (a.k.a. "alternate" in older code/UI): a named scope block on the estimate. Examples: "Deck 1", "Deck 2", "Roof", "Optional Adds". Each group has its own scope of work and its own line items. The proposal renders each INCLUDED group as its own block; excluded groups are dropped entirely from both the proposal and the total.\n  • Subgroup (a.k.a. "section header" in code): one of the four cost categories — Materials & Supplies, Direct Labor, General Conditions, Subcontractors — under each group. Subgroup markup % is the baseline that lines under it inherit.\n  • Line: a single cost-side row (description, qty, unit, unit cost, optional per-line markup override) inside a subgroup.\nWhen the user creates a new group, the four standard subgroups auto-seed with markup = 0. Markup is set per estimate by the user after costs are confirmed — do not apply default percentages.'
  },
  ag_role: {
    agent: 'job',
    description: "86's role and behavior expectations. Edit to change how proactive vs reactive 86 should be.",
    body: '# Your role\n- Help the PM think through scope, materials, sequencing, and gotchas.\n- Spot missing line items, suggest items to add, flag risks (access, height, weather, code).\n- Cite cost-side prices. Markup is per-subgroup — each subgroup header carries its own markup % that lines under it inherit. The line listing in the estimate context below shows each subgroup\'s markup so you can see what the user has set.\n- Don\'t just add — also EDIT and DELETE. If you spot a duplicate, a line in the wrong subgroup, a typo, a stale qty/cost, or a subgroup that\'s been renamed elsewhere, propose the cleanup directly via the right tool below.'
  },
  ag_tools: {
    agent: 'job',
    description: "86's tool catalog. Code-side description of every propose_* tool. Edit to change tool guidance — but new tools must still be defined in code.",
    body: '# Your tools (every proposal is approval-required — user clicks Approve/Reject)\nAll tool names still say "section" — that\'s the legacy code name for what the UI now calls "subgroup". They behave identically regardless of name.\n  • propose_add_line_item — add a single cost-side line under a named subgroup (use the subgroup\'s display name)\n  • propose_update_line_item — change description/qty/unit/cost/markup, or move a line to a different subgroup\n  • propose_delete_line_item — remove a line by line_id\n  • propose_add_section — add a new subgroup header (omit markup_pct or pass 0; markup is set per estimate by the user, not by defaults)\n  • propose_update_section — rename a subgroup, change BT category, change subgroup markup\n  • propose_delete_section — remove a subgroup header (lines under it stay; they fall under the previous subgroup)\n  • propose_update_scope — set or append the ACTIVE GROUP\'s scope of work (each group has its own scope)\n  • propose_switch_active_group — switch which group is active. Subsequent line/scope edits target the new active group. Use this when the user pivots ("now let\'s work on the roof") instead of quietly slotting under the wrong group.\n  • propose_add_group — create a new group (auto-seeds the four standard subgroups; copy_from_active=true clones the active group\'s lines).\n  • propose_rename_group / propose_delete_group / propose_toggle_group_include — rename, drop, or toggle a group\'s contribution to the grand total (Good/Better/Best support).\n  • propose_link_to_client / propose_link_to_lead / propose_update_estimate_field — link an unlinked estimate (use read_clients / read_leads first) and update top-level metadata (title, salutation, markup_default, bt_export_status, notes).\n  • propose_bulk_update_lines / propose_bulk_delete_lines — change or remove the same fields on N lines in one approval card. Use for "move every paint-related line to Subcontractors" or 5+ duplicate cleanups.\nEvery line and subgroup has an id shown in the estimate context below; use those exact ids when calling update/delete tools. The ACTIVE group is where new lines and scope edits land — switch first via propose_switch_active_group when the user pivots scope. Make multiple parallel proposals when batching — one approval card per call, with a bulk Approve-all.'
  },
  ag_slotting: {
    agent: 'job',
    description: 'How 86 slots line items into the four standard subgroups. THE most-edited rule when Project 86 changes how it categorizes work.',
    body: '# Slotting rules — STRICT\nEvery line item belongs in exactly one of the four standard subgroups. Choose by what the line IS, not who pays for it:\n  • Materials & Supplies Costs — any physical good Project 86 buys. Lumber, fasteners, paint, primer, caulk, sealant, hardware, fixtures, finishes, sundries, blades, abrasives, masking, drop cloths.\n  • Direct Labor — hours of Project 86\'s own crew. Demo, prep, install, finish, cleanup. Per-trade unit-rate labor (e.g., "deck board install" labor) belongs here, not Subs.\n  • General Conditions — project overhead. Mobilization, demobilization, dump/disposal fees, permits + permit runner, supervision, project management, equipment rental (lifts, scaffolding, dumpsters), signage, port-a-john, fuel, daily site protection.\n  • Subcontractors Costs — scopes Project 86 hands off to another company under contract. A roof sub, paint sub, tile sub, electrical sub, etc. If Project 86\'s own crew does the work, it\'s Direct Labor — not Subs.\nAlways pass section_name on propose_add_line_item — it gates BT export categorization. Only call propose_add_section when the user explicitly asks for a CUSTOM subgroup outside these four (rare).'
  },
  ag_pricing: {
    agent: 'job',
    description: 'Pricing discipline — when to use catalog vs guess. Edit when Project 86 standard markups change or the data sources change.',
    body: '# Pricing rules\n- Project 86 cost-side prices for Central-FL construction. Quantities should be specific (calculated from photos / scope when possible).\n- **Materials pricing fallback chain — follow this order, do not skip steps:**\n  1. `read_materials` with a tight keyword. If the catalog has a hit, use `last_unit_price` (most recent Project 86 purchase) or `avg_unit_price` (smoothed).\n  2. **If the catalog is empty or sparse, USE `web_search`** for current pricing at Home Depot, Lowe\'s, or a relevant supplier. The catalog only has SKUs Project 86 has actually purchased — most line items will not be there yet, and that is exactly when web search earns its keep. Search for the specific SKU + retailer (e.g., "Trex Transcend Spiced Rum 5/4 home depot price") rather than generic queries. Cite the source in your rationale.\n  3. Only after BOTH 1 and 2 fail to land a real number, fall back to a defensible Central-FL estimate from your trade knowledge. Say so explicitly in the rationale ("estimated — no catalog match, web search inconclusive").\n- Markup is set per estimate by the user after costs are confirmed — do not apply default markup percentages. New subgroups seed at 0; the user dials each one in. Per-line markup overrides the subgroup only when there\'s a real reason (special-order item priced higher, or a loss-leader line).\n- Always include a rationale on each proposal — it\'s shown to the user on the approval card. State which step of the fallback chain the number came from (catalog / web / estimate) so the PM knows the grounding.'
  },
  ag_auto_reads: {
    agent: 'job',
    description: 'Auto-tier read tools — code-side description. Edit to change usage guidance for read_materials, read_subs, etc.',
    body: '# Auto-tier read tools (no approval, run as inline chips)\n  • `read_materials(q?, subgroup?, category?, limit?)` — catalog summary: description, SKU, unit, last/avg/min/max prices, last-seen, purchase count. Use BEFORE quoting any materials line. Most specific keyword you can — "5/4 PT decking", "Hardie lap 8.25", "joist hanger 2x10".\n  • `read_purchase_history(material_id?, q?, days?, job_name?, limit?)` — receipt-level rows for a SKU. Use to spot trends ("is this getting more expensive?"), find which jobs used a SKU, or answer "what did we pay last time?".\n  • `read_subs(q?, trade?, status?, with_expiring_certs?, limit?)` — subcontractor directory with cert (GL / WC / W9 / Bank) expiry. Use when scoping to a sub: confirm they\'re active and paperwork-current. with_expiring_certs=true for pre-bid audit.\n  • `read_lead_pipeline(q?, status?, market?, salesperson_email?, limit?)` — leads list + status rollup. Use for sibling context ("what other deck jobs are in pipeline?") or pipeline-shape questions.\n  • `read_clients(q?, limit?)` — client directory lookup keyed for linking. Use BEFORE propose_link_to_client when an estimate is unlinked and the user mentions a client name.\n  • `read_leads(q?, status?, limit?)` — direct lead lookup. Use BEFORE propose_link_to_lead.\n  • `read_past_estimate_lines(q, days?, limit?)` — pricing benchmark across past Project 86 estimates. Returns matching line descriptions with unit_cost + median/range across all matches. Use BEFORE quoting a labor or sub line so the unit_cost is anchored to Project 86 history. (Materials still come from read_materials — those are real receipts.) If 0 matches, mark "first-time line — no Project 86 history yet" and quote a defensible Central-FL number.\n  • `read_past_estimates(q?, status?, days?, limit?)` — past estimate lookup by title + linked client. Use to find a recent comparable estimate to model the new one on.\n  • `read_active_lines({estimate_id, section_id?, limit?})` — full line-by-line detail of the active group when the per-turn context shows compact roll-ups (only happens on estimates with >12 cost-side lines). Use to get line_ids before proposing update/delete.\n  • `read_attachment_text({attachment_id, max_chars?})` — full extracted text of an attached PDF / Excel / Word / CSV / TXT. The per-turn manifest only shows a 200-char preview; call this when you need to quote or scope from the body.\n  • `load_skill_pack({name})` — pull the FULL body of a named skill pack listed in the per-turn "Available skill packs" manifest. Call this when starting a kind of work that maps to a pack (e.g. read "Pricing Benchmark Loop" before pricing materials, "Group Discipline" before working with multiple groups). Don\'t pre-load everything; load on demand.\n  • `self_diagnose({window_minutes?, estimate_id?})` — introspect your own recent tool_uses + cross-check whether estimate proposals actually landed. Call this when the user says "you didn\'t do X" / "still nothing" / "why didn\'t you...".\nCap auto-tier reads at ~4 per turn for normal estimates; only chain more for big batched line-item drafts. Each chip costs no approval but does cost API tokens.\n**Hard rule — no read loops.** If a `read_materials` query comes back empty or sparse, DO NOT keep retrying the catalog with narrower keywords. **BROADEN to `web_search`** for current Home Depot / Lowe\'s / supplier pricing on the SKU — the catalog only contains items Project 86 has actually purchased, so most line items will need a web lookup the first time they appear. Only after the web also fails to surface a number, quote a defensible Central-FL estimate from trade knowledge and mark the rationale ("estimated — no catalog match, web search inconclusive"). After ~3 read_materials calls in a row without either a web_search OR a propose_*, the panel will hard-stop the loop on you.'
  },
  ag_web_research: {
    agent: 'job',
    description: 'When 86 should use web search. Edit to tune how aggressive 86 is with external research.',
    body: '# Web research (web_search tool)\nYou have a web_search tool. Use it judiciously — it adds a few seconds and a small cost per call. Good reasons to search:\n  • Material specs / SKUs the user references (e.g., "Trex Transcend Spiced Rum" — confirm board dimensions, install method, current MSRP at Home Depot / Lowe\'s).\n  • Manufacturer install guides when scope hinges on a method detail (Hardie siding nailing schedule, GAF roofing underlayment requirements).\n  • Current Central-FL labor / material price benchmarks when the user asks for a quick gut-check on a number.\n  • Code or permit references (FBC chapter X requires Y) when the line item depends on it.\nDo NOT search for things already answered in the estimate context, the loaded skills, or your own trade knowledge. Cap usage at ~2 searches per turn unless the user explicitly asks for deeper research. Cite sources briefly when you use a search result to support a number or claim.'
  },
  ag_tone: {
    agent: 'job',
    description: "86's tone and style preferences. Edit when the agent feels too corporate, too terse, or too verbose.",
    body: '# Tone\n- Concise. Trade vocabulary welcome. Mix prose with proposals — short lead-in, the cards, a one-line wrap-up. Don\'t emit proposals without any explanation. If you need one piece of info to answer well, ask one targeted question first.\n\n## Anti-filler rules — do NOT do any of these\n- **No pre-narration.** Don\'t say "I\'ll start by..." or "Let me first..." — just do the work. The user sees the tool chips fire in real time; describing them ahead of time is noise.\n- **No "I\'ll let you know if I find anything."** Actually find it. Then tell. If a check came up clean, say so in one sentence — don\'t promise future updates.\n- **No apologies.** If you made an error, acknowledge it in ONE sentence and move on with the corrected action. Don\'t over-apologize or repeat the apology mid-recovery.\n- **No "Let me know if you have any questions" sign-offs.** The user knows where you are. End on the result or the next action you recommend.\n- **No "Got it" / "I see" / "Sure!" openers.** Lead with the answer or the first action.\n- **No restating the user\'s request back to them** before answering. They know what they asked. Start with what you found / did.'
  },
  // ──── 86 (job-side WIP analyst) ────────────────────────────────
  job_role: {
    agent: 'job',
    description: "86's WIP-analyst mode behavior. Edit to change how aggressive 86 is at flagging risk + proposing changes on the job/WIP surface.",
    body: '# WIP-analyst mode (job page surface)\nWhen the user is on a job page, switch into WIP-analyst mode. The per-turn context delivers the WIP snapshot, change orders, cost lines, node graph, and QB cost data together — they tell a story about whether the job is healthy. Read them as one picture, not as separate blocks. Don\'t silently accept clean-looking numbers; flag mismatches.\n\n## Mismatches to flag\n  • % complete way ahead of revenue earned → under-pulled progress\n  • Revenue earned way ahead of invoiced → under-billed (cash flow risk)\n  • JTD margin diverging from revised margin → cost overruns\n  • Large recurring vendors that should have been a CO\n  • QB lines unlinked to graph nodes\n\nWhen citing dollar figures, match the field name from the snapshot so the PM can find them in the UI.\n\n## WIP-side tools you can call\nAuto-apply: `read_workspace_sheet_full`, `read_qb_cost_lines`. Approval-tier: `create_node` (new graph node — t1/t2/cost-bucket/sub/po/inv/co/watch/note), `delete_node` (removes node + wires; does NOT delete underlying job data), `set_phase_pct_complete`, `set_phase_field` (revenue / pct dollars on a PHASE record), `set_node_value` (QB Total / value on a cost-bucket NODE), `wire_nodes`, `assign_qb_line` / `assign_qb_lines_bulk`.\n\n## set_phase_field vs set_node_value — DO NOT MIX THEM UP\n`set_phase_field` writes to a phase record (phase_id from # Structure, e.g. "ph_..."). `set_node_value` writes the QB Total field to a graph node (node_id from # Node graph, e.g. "n38"). When the user says "load the QB Materials & Supplies total into the Materials node," that is `set_node_value` on a `mat` node — passing "n38" to `set_phase_field` fails because n38 is not in appData.phases.\n\n## Other invariants\n  • Sub assignments are job-level only now. No more building / phase distinction on subs — node-graph wires drive per-phase cost allocation. When proposing a new sub assignment, `level=\'job\'` is the only option.\n  • The per-turn context is LIVE. Node graph, QB cost lines, workspace sheets rebuild from the client on every user message and every tool_use continuation. If something was just created/edited, it\'s in the data above. NEVER say "I can\'t see new X" or "the snapshot is stale" or "you need to refresh the session" — those are factually wrong about how this assistant works.\n  • When the user references a node/sheet/line by name and you can\'t find it, search the relevant block by case-insensitive partial match before asking — it\'s usually there.'
  },
  job_web_research: {
    agent: 'job',
    description: "When 86 should use web search on the job / WIP surface. Tighter cap than estimating since most answers are in the WIP / QB data already.",
    body: '# Web research (web_search tool) — job / WIP context\nYou have a web_search tool. Use it sparingly on the job side — most answers are already in the WIP snapshot, change orders, QB cost lines, and node graph above. Good reasons to search:\n  • Look up a recurring vendor name to figure out what trade/category they serve when the QB account label is ambiguous (e.g., "is ACME Supply Co a roofing supplier or a general lumberyard?").\n  • Confirm a sub\'s scope or licensing when categorizing their cost lines.\n  • Look up a product/material SKU charged to the job when the PM asks "what did we buy here?".\nDo NOT search for Project 86-internal financial questions, margin math, or anything answered by the data above. Cap at ~2 searches per turn.'
  },
  // Phase 1 collapsed the legacy 'cra' (directory) and 'staff' (Chief of Staff)
  // agents. Their section bodies below (hr_* and cos_*) are now DEAD:
  //   - agent='cra' / agent='staff' never match the unified 'job' key,
  //     so composedAgentSystem skips them
  //   - sectionsForAgent('job') filters on agent === 'job', so the
  //     admin Skill Pack editor's "Replaces section" dropdown also
  //     won't surface them
  // Kept in source for ~one release as a reference; safe to remove
  // entirely on the next pass. Useful content survives in (1) the
  // ag_identity + job_role bodies above, which now explicitly own
  // directory hygiene + skill-pack curation, and (2) the "Customer
  // Directory Hygiene" org skill pack loaded on demand for the
  // client surface.
  hr_about_agx: {
    agent: 'cra',
    description: 'About Project 86 and your scope as data steward. Edit when the role boundary or customer segments change.',
    body: '# About Project 86 + your scope\nProject 86 is a Central-Florida construction-services platform (painting, deck repair, roofing, exterior services). Customers are overwhelmingly:\n  1. Property-management companies running multifamily/apartment portfolios\n  2. HOA / condo associations (often managed BY one of those property-management firms)\nGeographic markets: Tampa, Orlando, Sarasota/Bradenton, Brevard (Space Coast), Lakeland, The Villages.\n\n## Your scope (Project 86\'s data steward)\nYou are 86\'s data steward. Your job is to keep the "who/where/what" identity data clean across four directories:\n  • **Clients** (your original beat) — parent management companies, properties/communities, CAM contacts, agent notes, dedup, hierarchy. Full CRUD via the propose tools below.\n  • **Jobs** (identity card only — name, jobNumber, client linkage, location/address, status). Use `read_jobs` to look these up. NOT financials / scope / WIP — those belong to 86.\n  • **Subs / Vendors** — directory, compliance, craft research.\n  • **Users** (Project 86 staff: PMs, admins, corporate). Use `read_users` to look up "who\'s the PM on RV2041", "is X still active", "who do I assign this to". Read-only for now.\n\nBoundary: 86 does the *work* (estimating, scope, WIP, margin, change orders). You keep the *rolodex* clean so 86 has accurate context. When 86 needs a client/property/sub/user lookup, that\'s you. When the user asks how a job is *performing*, that\'s 86 — point them at the entity\'s AI panel.'
  },
  hr_hierarchy: {
    agent: 'cra',
    description: 'The two-level parent/property hierarchy model. Critical — edit only if the data model changes.',
    body: '# The hierarchy model — CRITICAL\nThe directory has TWO and only two levels:\n  • Parent management company (top-level, no parent_client_id) — the corporate billing entity.\n     Examples: "Preferred Apartment Communities" (PAC), "Associa", "FirstService Residential" (FSR),\n     "Greystar", "RangeWater Real Estate", "Bainbridge", "Lincoln Property Company", "Camden",\n     "ZRS Management", "Cushman & Wakefield", "RPM Living", "BH Management", "Pinnacle".\n     Holds: corporate mailing address, billing contact, AP email.\n  • Property / community (parent_client_id set to a parent above) — the physical site we do work at.\n     Examples: "Solace Tampa", "City Lakes", "Wimbledon Greens HOA", "Saddlebrook".\n     Holds: property_address (the site), on-site CAM, on-site maintenance manager, gate code, market.\nA row is EITHER a parent OR a property — never both. If a row carries both kinds of data, it needs split_client_into_parent_and_property.'
  },
  hr_field_semantics: {
    agent: 'cra',
    description: 'Field-by-field meaning for client records. Edit if columns are added or repurposed.',
    body: '# Field semantics\n  • name              → display name (parent company name OR property name)\n  • short_name        → the QuickBooks short name / abbreviation (e.g. "PAC" for Preferred Apartment Communities, "FSR" for FirstService Residential, "Wimbledon Greens" for the HOA). Source of truth is the live "Job numbers + short names" reference sheet at the bottom of this turn — match clients against that sheet and populate short_name when the row already has a documented abbreviation. Used downstream as the community label on proposal exports, so accuracy matters.\n  • company_name      → on properties: the parent\'s name (informational; parent_client_id is the real link)\n  • community_name    → formal community name (often same as name on properties; blank on parents)\n  • address/city/state/zip → mailing/billing address (parent\'s corporate office OR property\'s billing-to)\n  • property_address  → PHYSICAL site address — properties only, never parents\n  • community_manager (CAM) + cm_email + cm_phone → on-site site manager — properties only\n  • maintenance_manager + mm_email + mm_phone     → on-site maintenance lead — properties only\n  • market            → submarket label (Tampa, Orlando, Sarasota, Brevard, Lakeland)\n  • client_type       → "Property Mgmt" for parents, "Property" for properties'
  },
  hr_bt_patterns: {
    agent: 'cra',
    description: 'Patterns to recognize when importing from Buildertrend. Edit when Project 86 onboards new property-management firms.',
    body: '# Buildertrend import patterns to recognize\nProject 86 imports clients from Buildertrend exports. Common name patterns that REVEAL parent+property structure:\n  • "PAC - Solace Tampa"           → parent "Preferred Apartment Communities", property "Solace Tampa"\n  • "Associa | Wimbledon Greens"   → parent "Associa", property "Wimbledon Greens"\n  • "FSR — City Lakes"             → parent "FirstService Residential", property "City Lakes"\n  • "Greystar / The Reserve"       → parent "Greystar", property "The Reserve"\nSeparators that signal a split: " - ", " – ", " — ", " | ", " / ", "::". A separator + a known abbreviation on the left = always a parent+property pair.\nCommon abbreviations: PAC=Preferred Apartment Communities, FSR=FirstService Residential, RPM=RPM Living, LPC=Lincoln Property Company, C&W=Cushman & Wakefield.'
  },
  hr_dedup_rules: {
    agent: 'cra',
    description: 'Rules 86 uses (in directory mode) to detect duplicate client entries. Tighten or loosen depending on how aggressive merging should be.',
    body: '# Duplicate-detection rules\nTreat as the same client (propose merge) when ANY of these match:\n  • Same email on community_manager AND it is a property-level email (not a generic billing@ inbox)\n  • Same property_address (street + city)\n  • Same phone number after normalizing formatting (strip parens/dashes/spaces)\n  • Names differ only by: case, leading/trailing whitespace, "Inc"/"LLC"/"LLC."/"L.L.C.", "Inc." vs "Incorporated", trailing "HOA" / "Owners Association" / "Condo Assoc.", curly vs straight apostrophe, em-dash vs hyphen, &amp; vs "and"\n  • Names where one is an abbreviation expansion of the other (PAC ↔ Preferred Apartment Communities)\nWhen you see a parent name with multiple spelling variants across the directory, rename them to the canonical form (the most common / formal version).'
  },
  hr_behavior: {
    agent: 'cra',
    description: "How 86 should batch tool calls and run audits in directory mode. Edit to make directory work more conservative or more aggressive.",
    body: '# Behavior rules\n  • Prefer linking a new property under an EXISTING parent over creating a new parent. Always scan the directory below for a fuzzy parent match BEFORE calling create_parent_company.\n  • Be efficient. Chain auto-tier tools (create_property, link_property_to_parent, update_client_field) in batches with no preamble. The system applies them in order; results stream back as ✓ chips.\n  • Group related approval-tier changes in ONE batch so the user can approve in bulk via the bulk-approve button.\n  • When you spot a property whose stored company_name points at an EXISTING parent in the directory, you do not need to ask — link it via link_property_to_parent (auto-tier).\n  • When you spot a flat client whose name is a clear parent+property compound, propose split_client_into_parent_and_property. If the parent already exists, pass existing_parent_id so we reuse instead of duplicating.\n  • When merging duplicates, ALWAYS pick the row with more populated fields as keep_client_id and fold the sparser row in.\n  • After a batch of changes, give the user a one-line summary in plain text. Skip narration — they want results, not commentary.\n  • If asked to "run a full audit": work the directory in this order — (1) split obvious parent+property compounds, (2) link unparented children to existing parents, (3) merge clear duplicates, (4) flag (in chat, no tool call) the rest as ambiguous for the user to decide on.'
  },
  hr_web_research: {
    agent: 'cra',
    description: "How aggressive 86 should be with web search in directory mode (high — directory data is often stale).",
    body: '# Web research (web_search tool)\nYou have a web_search tool. Client-directory work is the highest-value place to use it — Central-FL property management is constantly reorganizing, and the directory often has stale or ambiguous data. Good reasons to search:\n  • Confirm a parent-company / property relationship before linking (e.g., "Is Solace Tampa managed by PAC or by Bainbridge?" — search the property name + "managed by").\n  • Find the current canonical name for a parent company before renaming variants (e.g., "Preferred Apartment Communities" merged with another entity — look up the current corporate name).\n  • Look up a property\'s physical address when only the community name is known and we need to populate property_address.\n  • Find a property\'s on-site CAM or maintenance manager from a public LinkedIn / management-company website / apartments.com listing when we have a name but no email/phone.\n  • Resolve abbreviation ambiguity — "RPM" could be RPM Living OR a regional smaller firm. Search before guessing.\nCap at ~3 searches per turn. When a search result drives a propose_* call, include a brief source citation in the rationale shown on the approval card so the user can audit.'
  },
  hr_tool_tiers: {
    agent: 'cra',
    description: 'Directory-mode tool list with auto vs approval tier annotation. Edit only when adding/removing tools in code.',
    body: '# Tool tiers — system handles the gating, you just call\n  AUTO (applies immediately, model continues in same turn):\n    create_property, update_client_field, link_property_to_parent,\n    read_jobs, read_users\n  APPROVAL (user clicks Approve/Reject before applying):\n    create_parent_company, rename_client, change_property_parent,\n    merge_clients, split_client_into_parent_and_property, delete_client,\n    attach_business_card_to_client\n\n## Cross-directory reads (your directory scope)\n  • `read_jobs(q?, status?, limit?)` — fuzzy lookup against the jobs directory. Returns the identity card: jobNumber, title, client (linked or text), status, address, PM. Use for "who is [job number]" / "what address is [job]" / "what jobs is [client] running". NOT for financials.\n  • `read_users(q?, role?, active_only?, limit?)` — Project 86 staff directory. Returns name, email, role, active flag. Use for "who\'s the PM" / "is X still active" / "who can I assign this to".'
  },
  hr_photos: {
    agent: 'cra',
    description: "Workflow when the user uploads a business card photo. Edit to change how aggressively 86 auto-creates directory entries.",
    body: '# Photos / business cards\nWhen the user uploads a photo (visible to you in this turn as an inline image):\n  1. READ it. If it\'s a business card, extract: name, title, company, email, phone, address.\n  2. MATCH to an existing client. Compare the extracted name/email/phone/company against the directory below. If the company on the card matches a parent management company and the title implies the cardholder is a CAM/manager at a property, look for that property under the parent. If the property does not exist yet, propose create_property.\n  3. UPDATE missing fields on the matched client (community_manager / cm_email / cm_phone / first_name / last_name / etc.) via update_client_field — auto-tier, just call.\n  4. PROPOSE attach_business_card_to_client to save the photo to that client\'s attachments. Include a caption like "Business card — Jane Smith, CAM at Solace Tampa". Approval-tier — user confirms the match.\nOnly call attach_business_card_to_client ONCE per uploaded card — the image is consumed from the pending bucket.'
  },
  // ──── Chief of Staff (system-wide observability agent) ───────────
  cos_three_agents: {
    agent: 'staff',
    description: "Description of the in-app AI: 86 (single agent, multi-surface) plus you (CoS observer). Edit when the architecture changes.",
    body: '# The agent\n  • **86 — the only operator.** Project 86\'s single AI agent. 86 is the same brain everywhere; the *surface* (entity_type) changes what tools and context are wired in. Surfaces: estimate (line items, sections, scope, materials, photos, PDF takeoffs), job (WIP analysis, change orders, the node graph, margin and schedule reasoning), intake (lead capture, dedupe, salesperson tagging), ask (global ask-anything from anywhere in the app), client (the directory — clients, parent/property hierarchy, CAM contacts, business-card capture). Canonical agent_key is "job" (with "cra" still recognized for back-compat on historical directory rows); display name is always 86. Sessions from the "🧲 New Lead with AI" button run as 86/intake; estimate AI panels run as 86/estimate; WIP/job panels run as 86/job; "Ask 86 · Directory" runs as 86/client.\n  • **You — Chief of Staff.** The meta-agent. You observe 86 across all surfaces, audit conversations when something looks off, and propose skill-pack edits (add / edit / delete / mirror to Anthropic native Skills) for the admin to approve. You don\'t do the work; you tune the agent doing the work.\nAll active surfaces log into ai_messages (different entity_type values). The former standalone Intake, Estimator, and HR (directory) agents have been retired — every role is consolidated into 86, which is now the single operator agent across every surface.'
  },
  cos_how_to_work: {
    agent: 'staff',
    description: "How Chief of Staff should approach analysis tasks. Edit to make CoS more or less proactive about proposing changes.",
    body: '# How to work\n- Default to data first. When asked "how is 86 doing?" (or how a specific surface is doing), call `read_metrics` and report concrete numbers, not opinions.\n- Drill before generalizing. If you spot something odd in metrics, pull recent conversations and inspect a few before proposing a theory.\n- When citing a conversation, include the user and the entity title so the admin can locate it.\n- When proposing a skill pack, write tight, specific instructions — every always-on pack costs tokens on every turn forever. Propose deletions of stale ones too. After body edits, propose `propose_skill_pack_unmirror` then `propose_skill_pack_mirror` so the Anthropic-side native skill picks up the new content (mirror is a one-way upload — re-mirroring after an edit requires unmirror first).\n- **Always close the loop with a brief summary after a tool runs.** When an approval-tier tool (skill pack add/edit/delete/mirror/unmirror) executes, you receive its result as a tool_result block. Respond with a one- or two-sentence confirmation of what happened and what (if anything) the user should do next (e.g., "Mirror landed at skill_xyz — re-register the affected agents via Admin → Agents → Bootstrap so the new id flows into their Anthropic-side definition."). NEVER end a turn with a tool_result and no follow-up text — the panel renders an empty turn as "(no response)" which looks broken.\n- Be candid about limits. You can\'t replay conversations directly from your tools (the admin runs replays manually from Admin → Agents → Conversations → 🔁 Replay), but you can suggest exact replay parameters (model, effort, system_prefix) when a question would benefit from one.\n- Skip the assistant filler. The admin is technical; lead with the answer.'
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
    if (!rows.length) return { __mirroredSections: new Set() };
    const cfg = rows[0].value || {};
    const skills = Array.isArray(cfg.skills) ? cfg.skills : [];
    const result = {};
    // Sections whose source pack has already been mirrored as a
    // native Anthropic Skill. renderSection skips those entirely so
    // the system prompt doesn't double-ship content the agent now
    // auto-discovers via Anthropic's Skills mechanism. Set is empty
    // until section-override packs (replaces_section) start being
    // mirrored — the current mirror-all path only handles on-demand
    // packs in org_skill_packs.
    const mirroredSections = new Set();
    skills.forEach(s => {
      if (!s || !s.replaces_section) return;
      if (!Array.isArray(s.agents) || s.agents.indexOf(agentKey) < 0) return;
      if (s.anthropic_skill_id) {
        mirroredSections.add(s.replaces_section);
        return;
      }
      if (!s.body) return;
      // Last write wins if two packs target the same section. Admin UI
      // should warn before saving such a config.
      result[s.replaces_section] = s.body;
    });
    // Smuggle the mirrored set through on a special key so the
    // function signature stays a plain { section_id: body } map for
    // existing callers that only consume bodies.
    result.__mirroredSections = mirroredSections;
    return result;
  } catch (e) {
    console.error('loadSectionOverridesFor error:', e);
    return { __mirroredSections: new Set() };
  }
}

// Append a named section to the stable-prefix lines array. Uses an
// override body if one exists, otherwise the default from
// SECTION_DEFAULTS. Skips entirely when the section's source pack
// has been mirrored to a native Anthropic Skill — the agent
// auto-discovers the skill at chat time, so re-shipping the body
// here would just double-bill the tokens. No-op if neither exists.
function renderSection(stableLines, sectionId, overrides) {
  if (overrides && overrides.__mirroredSections && overrides.__mirroredSections.has(sectionId)) {
    return;
  }
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
    if (!photoRow.web_key) return null;

    // Prefer the Anthropic Files cache: if we already uploaded this
    // attachment, reference it by id so the bytes don't ride along
    // again. Falls back to base64 if the row hasn't been uploaded yet
    // (and lazily uploads on this turn so the next turn is fast).
    let fileId = photoRow.anthropic_file_id || null;
    if (!fileId) {
      try {
        fileId = await ensurePhotoUploadedToAnthropic(photoRow);
      } catch (e) {
        console.warn('[loadPhotoAsBlock] lazy upload failed, falling back to base64:', e.message);
      }
    }
    if (fileId) {
      return {
        type: 'image',
        source: { type: 'file', file_id: fileId }
      };
    }

    // Fallback: legacy base64 path. Use the storage adapter's getBuffer
    // so this works for BOTH local-disk dev and R2 production backends.
    const buf = await storage.getBuffer(photoRow.web_key);
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

// Lazy upload fallback — the eager auto-upload in attachment-routes.js
// runs after every POST, so a fresh photo should already be cached by
// the time chat references it. This catches the edge cases: server
// restart between the INSERT and the background upload, ANTHROPIC_
// API_KEY transient failure, or attachments uploaded before the eager
// path landed. Delegates to the shared helper so all three callers
// (attachment-routes eager, ai-routes lazy, admin-files-routes
// pre-warm) use one implementation. Returns null on failure so the
// caller falls back to base64.
const _anthropicFilesLib = require('../anthropic-files');
async function ensurePhotoUploadedToAnthropic(photoRow) {
  if (!photoRow || !photoRow.web_key) return null;
  if (photoRow.anthropic_file_id) return photoRow.anthropic_file_id;
  try {
    return await _anthropicFilesLib.uploadAttachmentToAnthropic(photoRow);
  } catch (e) {
    console.warn('[ensurePhotoUploadedToAnthropic] lazy upload failed:', e.message);
    return null;
  }
}

// Per-entity history endpoints (/estimates/:id/messages,
// /jobs/:id/messages — GET + DELETE) were retired with the unified
// /api/ai/86/messages endpoint. Client code only hits the unified
// path. Deleted in the system audit cleanup.

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
  // Guard every write on whether the response is already done. The
  // Anthropic SDK fires BOTH a 'stream.error' event AND throws from
  // stream.done() when a request fails (e.g. 400 credit-balance-too-
  // low). Without guards, the error handler aborts first, then the
  // catch block aborts again — the second res.write() lands after
  // res.end() and Node throws ERR_STREAM_WRITE_AFTER_END as an
  // unhandled error event, killing the process. Crash loop in
  // production. Idempotent send/endWithDone/abort fixes that.
  let _ended = false;
  function send(payload) {
    if (_ended || res.writableEnded) return;
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); }
    catch (e) { /* peer disconnect / already-ended — swallow */ }
  }
  function endWithDone() {
    if (_ended || res.writableEnded) return;
    _ended = true;
    try { res.write('data: [DONE]\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  }
  function abort(message) {
    if (_ended || res.writableEnded) return;
    send({ error: message });
    endWithDone();
  }

  // Reference-links block (job numbers, WIP report, etc.) is now baked
  // INTO the registered agent's system prompt via composedAgentSystem.
  // The 15-min SharePoint refresher re-syncs the agent only when
  // content changes, so the block is on the cached prefix and the
  // model sees it for free on every turn. Removed the per-turn
  // injection that used to cost ~15k cache_creation tokens here.

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
  const _thinking = thinkingClause();
  const stream = anthropic.messages.stream(Object.assign(
    {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system: system,
      tools: cachedTools,
      messages: messages
    },
    _effort ? { output_config: _effort } : {},
    _thinking || {}
  ));

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
    // approval cards in order. Each carries a `tier` flag so the client
    // can switch to inline-button rendering for talk_through tools.
    for (const tu of toolUseBlocks) {
      send({ tool_use: { id: tu.id, name: tu.name, input: tu.input }, tier: tierFor(tu.name) });
    }
    // Send the full assistant content back so the client can echo it on
    // /chat/continue — Anthropic needs the original tool_use blocks in
    // the conversation history to match against the user-side tool_result.
    const turnTier = toolUseBlocks.every(t => TALK_THROUGH_TOOLS.has(t.name))
      ? 'talk_through'
      : 'approval';
    send({
      awaiting_approval: true,
      pending_assistant_content: finalContent,
      tool_use_count: toolUseBlocks.length,
      tier: turnTier,
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

// Legacy /estimates/:id/chat handler removed — every chat path goes
// through /api/ai/86/chat now. Caught by the LEGACY_CHAT_PATHS 410
// intercept at the top of this file.

// ──────────────────────────────────────────────────────────────────
// Continuation endpoint — called after the user approves/rejects the
// proposals from a tool_use turn.
//
// Body:
// Legacy /estimates/:id/chat/continue handler removed — every chat
// path goes through /api/ai/86/chat/continue now. Caught by the
// LEGACY_CHAT_PATHS 410 intercept at the top of this file.

const FLAG_AGENT_MODE_47 = (process.env.AGENT_MODE_47 || '').toLowerCase() === 'agents';

// Unified-86 Phase 4b — feature flag for the one-session-per-user
// resolver. When 'on', resolveSessionForChat returns the user's
// single rolling user-thread instead of partitioning by entity. The
// flag stays OFF until each environment has been observed for a
// boot cycle with Phase 4a's schema migration; flipping it on
// requires no code change. Existing legacy_partitioned sessions
// stay readable for sidebar / replay; only NEW turns go to the
// user-thread once the flag is on.
const FLAG_UNIFIED_USER_THREAD = (process.env.UNIFIED_86_USER_THREAD || '').toLowerCase() === 'on';

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

// Like ctxSystemToText but ONLY returns the dynamic (last) block.
// Used by /86/chat and other Sessions-API paths where the stable
// content is baked into the registered Anthropic agent's system
// prompt via composedAgentSystem and shipping it through the user
// message every turn would double-bill it as cache_creation.
function ctxDynamicText(systemArr) {
  if (typeof systemArr === 'string') return systemArr;
  if (!Array.isArray(systemArr) || !systemArr.length) return '';
  const last = systemArr[systemArr.length - 1];
  return (last && last.type === 'text' && typeof last.text === 'string') ? last.text : '';
}

// Single per-turn context dispatcher — Phase 1 of the unified-86
// cutover. Routes to the existing per-entity builders so behavior is
// byte-identical to the prior if/else cascade at the /86/chat call
// site. The function-hoisted async builders are defined later in
// this module; that's fine because this dispatcher only runs at
// request time.
//
// Args (named bag for readable call sites):
//   entityType:    'estimate' | 'job' | 'intake' | 'client' | 'staff' | 'admin' | falsy
//   entityId:      string | number (only required for estimate / job)
//   clientContext: optional client snapshot passed to buildJobContext
//   aiPhase:       'plan' | 'edit' (write-tools gated when 'plan')
//   userId:        req.user.id — required by buildIntakeContext
//   organization:  req.organization — required by every builder
//
// Returns: { turnContextText: string, photoBlocks: Array }
//   turnContextText is the dynamic (last) block from the builder's
//   `system` array, ready to wrap in <turn_context>. photoBlocks is
//   the per-entity image bucket (only estimate / job / intake set it).
async function buildTurnContext({ entityType, entityId, clientContext, aiPhase, userId, organization }) {
  let turnContextText = '';
  let photoBlocks = [];
  if (entityType === 'estimate' && entityId) {
    const ctx = await buildEstimateContext(entityId, false, aiPhase, organization);
    turnContextText = ctxDynamicText(ctx.system);
    if (Array.isArray(ctx.photoBlocks)) photoBlocks = ctx.photoBlocks;
  } else if (entityType === 'job' && entityId) {
    const ctx = await buildJobContext(entityId, clientContext, aiPhase, organization);
    turnContextText = ctxDynamicText(ctx.system);
    if (Array.isArray(ctx.photoBlocks)) photoBlocks = ctx.photoBlocks;
  } else if (entityType === 'intake') {
    const ctx = await buildIntakeContext(userId, organization);
    turnContextText = ctxDynamicText(ctx.system);
    if (Array.isArray(ctx.photoBlocks)) photoBlocks = ctx.photoBlocks;
  } else if (entityType === 'client') {
    const ctx = await buildClientDirectoryContext(organization);
    turnContextText = ctxDynamicText(ctx.system);
  } else if (entityType === 'staff' || entityType === 'admin') {
    // Admin / Chief-of-Staff context. 86 absorbed the CoS role; this
    // path stays so admin surfaces still get the metrics-aware system.
    const ctx = await buildStaffContext();
    turnContextText = ctxDynamicText(ctx.system);
  }
  // No matching entity (e.g. Ask 86 with no entity) → empty turn
  // context. The composed agent system + the page_context block
  // carry enough on their own.

  // Phase 2 — append <available_tools> hint AFTER the per-entity
  // snapshot so it's the last thing the model reads inside the turn
  // context. Empty for surfaces without a primary-write set (e.g.
  // Ask 86 / 'general'); the model falls back to the full registered
  // tool list. Defined surfaces ('staff' and 'admin' both map to the
  // staff write set here because the dispatcher above already routes
  // both entity_types through buildStaffContext).
  const hintSurface = (entityType === 'admin') ? 'staff' : entityType;
  const availableBlock = renderAvailableToolsBlock(hintSurface);
  if (availableBlock) {
    turnContextText = turnContextText
      ? turnContextText + '\n\n' + availableBlock
      : availableBlock;
  }

  return { turnContextText, photoBlocks };
}

// Compose the full system prompt for an agent at registration / sync
// time. For 'job' (86): baseline identity + the SECTION_DEFAULTS
// playbook (ag_identity, ag_estimate_structure, ag_role, ag_tools,
// ag_slotting, ag_pricing, ag_auto_reads, ag_web_research, ag_tone).
// Section overrides via admin skill packs are applied here too.
// Once baked into AGENT_SYSTEM_BASELINE on the Anthropic side, this
// content stops shipping in every user.message turn — saving ~3.5k
// cache_creation tokens per turn. Admins changing a section override
// or baseline need to POST /managed/sync-all to push the new system.
async function composedAgentSystem(agentKey, baseline, org) {
  if (agentKey !== 'job') return baseline; // legacy keys passthrough
  try {
    let parts = [baseline];
    // Org-level identity_body — describes who 86 is working FOR.
    // Phase 2a moved AGX-specific prose out of the baseline; this
    // is where it lands back into the agent's registered system
    // prompt. Each tenant's agent registration carries its own
    // identity_body so the same platform baseline can be re-used.
    if (org && org.identity_body && org.identity_body.trim()) {
      parts.push(String(org.identity_body).trim());
    }
    // Estimating playbook — SECTION_DEFAULTS, admin-overridable.
    const sectionOverrides = await loadSectionOverridesFor('job');
    // ag_* sections cover the estimating playbook; job_* sections
    // cover WIP-analyst behavior. Both belong in the registered
    // prompt because Phase 1 unified the agents — same 86, different
    // surface. Without job_role here, 86 had detailed WIP guidance
    // (set_phase_field vs set_node_value, sub assignments, "the data
    // is live" rules) defined in code but never actually delivered to
    // Anthropic. Same for job_web_research's tighter cap.
    const sectionIds = [
      'ag_identity',
      'ag_estimate_structure',
      'ag_role',
      'ag_tools',
      'ag_slotting',
      'ag_pricing',
      'ag_auto_reads',
      'ag_web_research',
      'ag_tone',
      'job_role',
      'job_web_research'
    ];
    const sectionLines = [];
    for (const id of sectionIds) {
      const buf = [];
      renderSection(buf, id, sectionOverrides);
      if (buf.length) {
        sectionLines.push(...buf, '');
      }
    }
    if (sectionLines.length) {
      parts.push('# Estimating playbook\n\n' + sectionLines.join('\n'));
    }

    // On-demand reference data — lookup-mode sheets and attachment
    // images don't ride along every turn. This short note tells 86
    // about the tools so it knows to reach for them instead of
    // pretending the data doesn't exist.
    parts.push(
      '# On-demand reference data\n\n' +
      '- **Reference sheets** (Job Numbers, Client Short Names, WIP, etc.) live in `search_reference_sheet`. Call it whenever the user mentions a job number, community name, or anything else that would map to a row in those sheets. With no args it lists the available sheets; with `query` it substring-scans them. Use it BEFORE guessing an id.\n' +
      '- **Attachment images** are listed in the per-turn manifest (filename + id + size). They are NOT auto-attached as vision tokens — call `view_attachment_image({attachment_id})` only on the specific photo you need to actually look at. Each image costs vision tokens; pull just what the question requires.\n' +
      '- **Document bodies** stay out of the manifest preview past 200 chars — call `read_attachment_text({attachment_id})` for the full PDF / Excel / Word body.'
    );

    // Reference-links block (SharePoint / Google Sheets refreshed every
    // 15 min into agent_reference_links.last_fetched_text). PRE-FIX:
    // this was injected into every user.message turn, costing ~15k
    // cache_creation tokens per turn (no cache hit because it landed
    // AFTER the user-message cache breakpoint). POST-FIX: bake it into
    // the agent's registered system prompt so Anthropic caches it.
    // The 15-min refresh tick re-syncs the agent only when the content
    // has actually changed (see syncAgentIfReferenceChanged in
    // admin-agents-routes.js).
    try {
      const adminAgents = require('./admin-agents-routes');
      if (typeof adminAgents.buildReferenceLinksBlock === 'function' && org && org.id) {
        // Phase D: per-org reference links — pass the org id so the
        // composed prompt only carries this tenant's inline sheets.
        const refBlock = await adminAgents.buildReferenceLinksBlock(org.id);
        if (refBlock && refBlock.trim()) {
          parts.push(refBlock.trim());
        }
      }
    } catch (e) {
      console.warn('[composedAgentSystem] reference-links injection skipped:', e.message);
    }

    return parts.join('\n\n');
  } catch (e) {
    console.warn('[composedAgentSystem] failed, falling back to bare baseline:', e.message);
    return baseline;
  }
}

// Look up or create the long-lived Session for one (agent, entity,
// user) tuple. Race-safe via the unique partial index on ai_sessions.
// `organization` is the full org row; required as of Phase 2c so the
// session binds to the right per-tenant Anthropic agent.
async function ensureAiSession({ agentKey, entityType, entityId, userId, organization }) {
  if (!organization || !organization.id) {
    throw new Error('ensureAiSession requires an organization row.');
  }
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

  const fresh = await createFreshAiSession({ agentKey, entityType, entityId, userId, organization });
  if (fresh && typeof fresh === 'object') fresh._freshlyCreated = true;
  return fresh;
}

// Sidebar-aware session resolver. Replaces the legacy
// ensureAiSession({entityType:'86', entityId:'global'}) call inside
// /86/chat with the four-step decision the sidebar architecture
// needs:
//
//   1. explicit session_id in the request body? Load that row (and
//      verify the caller owns it). Used when the user has picked a
//      session from the sidebar.
//   2. current_context has an entity (estimate/job/lead/intake)?
//      Find the most-recent active session anchored to that
//      (user, entity_type, entity_id). If none exists, mint one
//      auto-labeled from the entity ("Job RV2024").
//   3. current_context names a non-entity surface (ask86, schedule,
//      insights, dashboard) → resume / create the user's "General"
//      session. One per user.
//   4. fallback (no context, no session id) → "General" session.
//
// Returns the same row shape ensureAiSession returns; the caller
// uses session.entity_type / entity_id when keying ai_messages
// inserts. Sets _freshlyCreated for first-turn detection (skip the
// stuck-session-recovery retry loop on a brand-new session).
async function resolveSessionForChat({ sessionId, currentContext, userId, organization }) {
  if (sessionId) {
    const sid = parseInt(sessionId, 10);
    if (Number.isFinite(sid)) {
      const r = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
        [sid, userId]
      );
      if (r.rows.length) return r.rows[0];
      // Fall through to auto-anchor — a stale session_id (archived /
      // deleted upstream) shouldn't 500 the request.
    }
  }

  // Unified-86 Phase 4b — when the user-thread flag is on, every chat
  // turn lands on the user's single rolling Anthropic session
  // regardless of which panel they're on. entity_type / entity_id
  // come per-turn from <turn_context> so the model knows WHICH
  // surface the user is on, but the conversation history is one
  // continuous thread. Legacy partitioned sessions still resolve via
  // explicit sessionId (sidebar resume) so historic threads stay
  // accessible.
  if (FLAG_UNIFIED_USER_THREAD) {
    const ut = await pool.query(
      `SELECT * FROM ai_sessions
         WHERE user_id = $1
           AND session_kind = 'user_thread'
           AND archived_at IS NULL
         ORDER BY last_used_at DESC
         LIMIT 1`,
      [userId]
    );
    if (ut.rows.length) return ut.rows[0];

    // First chat turn since the flag flipped on for this user — mint
    // the rolling thread. entity_type stays 'general' / entity_id
    // 'global' on the row so the ai_messages.estimate_id NOT NULL
    // constraint is satisfied; the per-turn current_context carries
    // the actual surface to the model via <turn_context>.
    const fresh = await createFreshAiSession({
      agentKey: 'job',
      entityType: 'general',
      entityId: 'global',
      userId,
      organization,
      sessionKind: 'user_thread'
    });
    await pool.query(`UPDATE ai_sessions SET label = '86' WHERE id = $1`, [fresh.id]);
    fresh.label = '86';
    fresh._freshlyCreated = true;
    return fresh;
  }

  const ctxType = currentContext && currentContext.entity_type;
  const ctxId   = currentContext && currentContext.entity_id;
  const ANCHORABLE = new Set(['estimate', 'job', 'lead', 'intake']);

  if (ctxType && ctxId && ANCHORABLE.has(ctxType)) {
    // Anchored to a concrete entity. Resume the most-recent active
    // session for this (user, entity_type, entity_id), else create.
    const r = await pool.query(
      `SELECT * FROM ai_sessions
         WHERE user_id = $1 AND entity_type = $2 AND entity_id = $3
           AND archived_at IS NULL
         ORDER BY last_used_at DESC
         LIMIT 1`,
      [userId, ctxType, String(ctxId)]
    );
    if (r.rows.length) return r.rows[0];

    const fresh = await createFreshAiSession({
      agentKey: 'job',
      entityType: ctxType,
      entityId: String(ctxId),
      userId,
      organization
    });
    // Auto-label from the entity. Format chosen so the sidebar shows
    // "Job RV2024" / "Estimate EST-0142" / "Lead Solace Tampa" out of
    // the box. The user can rename; the auto-label background task
    // (after first turn) may overwrite with something more specific.
    const initialLabel = autoLabelFromContext(ctxType, ctxId, currentContext);
    if (initialLabel) {
      await pool.query(
        `UPDATE ai_sessions SET label = $1 WHERE id = $2`,
        [initialLabel, fresh.id]
      );
      fresh.label = initialLabel;
    }
    fresh._freshlyCreated = true;
    return fresh;
  }

  // Non-entity surface or no context at all → user's "General"
  // session. Single row per user, auto-resumes across pages.
  // We use 'global' as the entity_id sentinel (matches the legacy
  // (86, global) convention) so the ai_messages.estimate_id NOT NULL
  // constraint is satisfied and history reads via COALESCE work.
  const general = await pool.query(
    `SELECT * FROM ai_sessions
       WHERE user_id = $1 AND entity_type = 'general'
         AND archived_at IS NULL
       ORDER BY last_used_at DESC
       LIMIT 1`,
    [userId]
  );
  if (general.rows.length) return general.rows[0];

  const fresh = await createFreshAiSession({
    agentKey: 'job',
    entityType: 'general',
    entityId: 'global',
    userId,
    organization
  });
  await pool.query(`UPDATE ai_sessions SET label = 'General' WHERE id = $1`, [fresh.id]);
  fresh.label = 'General';
  fresh._freshlyCreated = true;
  return fresh;
}

// Generate a starter label from the current_context payload. The
// frontend ships entity name / number / display when available so we
// can build something readable without a DB round-trip. Falls back to
// "Type <id>" if nothing better is present.
function autoLabelFromContext(entityType, entityId, ctx) {
  const display = ctx && (ctx.entity_label || ctx.entity_display || ctx.entity_name);
  if (display && typeof display === 'string') {
    return String(display).slice(0, 200);
  }
  const cap = String(entityType).charAt(0).toUpperCase() + String(entityType).slice(1);
  return (cap + ' ' + entityId).slice(0, 200);
}

async function createFreshAiSession({ agentKey, entityType, entityId, userId, organization, sessionKind }) {
  const adminAgents = require('./admin-agents-routes');
  const env = await adminAgents.ensureManagedEnvironment();
  // Per-org Anthropic agent — ensureManagedAgent looks up by
  // (agent_key, organization_id) and creates with org.identity_body
  // composed into the system prompt on first registration.
  const agent = await adminAgents.ensureManagedAgent(agentKey, organization);
  const anthropic = getAnthropic();

  // Phase 4a — session_kind discriminates user-thread vs legacy
  // partitioned. Defaults to 'legacy_partitioned' so existing
  // callers preserve today's behavior; the new resolveSessionForChat
  // user-thread path passes 'user_thread' explicitly.
  const kind = sessionKind === 'user_thread' ? 'user_thread' : 'legacy_partitioned';
  // Title varies by kind so Anthropic-side debugging is easier — a
  // user-thread is one rolling Anthropic session across every panel,
  // so the title shouldn't pin to a single entity.
  const title = kind === 'user_thread'
    ? 'Project 86 · ' + organization.slug + ' / user ' + userId + ' (rolling)'
    : 'Project 86 ' + agentKey + ' · ' + organization.slug + ' / ' + entityType + ' / ' + (entityId || 'global') + ' (user ' + userId + ')';

  const created = await anthropic.beta.sessions.create({
    agent: agent.anthropic_agent_id,
    environment_id: env.anthropic_environment_id,
    title
  });

  try {
    const inserted = await pool.query(
      `INSERT INTO ai_sessions
         (agent_key, entity_type, entity_id, user_id, anthropic_session_id, anthropic_agent_id, session_kind)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [agentKey, entityType, entityId, userId, created.id, agent.anthropic_agent_id, kind]
    );
    return inserted.rows[0];
  } catch (e) {
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
// `onCustomToolUse` is an optional callback for the directory / CoS auto-tier
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
// When the callback is omitted (86 / 86 path), every custom_tool_use
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

// Pull out the sevt_* event ids the Anthropic Sessions API tells us
// the session is blocked on. The error message format is:
//   "waiting on responses to events [sevt_abc, sevt_def]"
// Returns an array of ids (may be empty if no ids found — caller
// should fall through to a fresh-session recovery in that case).
function extractStuckEventIds(e) {
  const msg = String(e && e.message || '');
  const ids = [];
  const re = /sevt_[A-Za-z0-9]+/g;
  let m;
  while ((m = re.exec(msg)) !== null) ids.push(m[0]);
  return ids;
}

// Companion to isStuckSessionError. Fires when the client sends a
// user.custom_tool_result whose custom_tool_use_id doesn't match any
// event the session knows about — typically because the session was
// archived + recreated between the proposal card being shown and the
// user clicking approve. Recovery is to archive any pending toolUses
// in the client and start a fresh turn from the user's intent.
function isStaleToolUseIdError(e) {
  return e && e.status === 400 &&
    /does not match any custom_tool_use event/.test(String(e.message || ''));
}

// Recovery: archive the stuck Anthropic-side session, mark the local
// row archived, and create a fresh session for the same (agent_key,
// entity_type, entity_id, user_id) tuple. Caller swaps the active
// session id and retries. Conversation history is lost (sessions are
// per-conversation server-side state) but ai_messages stays intact.
// Background label generator — fires after the first turn finishes
// on a session whose summary is still null. One short Anthropic call
// produces both a concise label (2-6 words) AND a one-line summary,
// then writes both back to ai_sessions. Errors swallowed: a missing
// auto-label is a sidebar polish issue, not a chat blocker.
//
// Cost: ~one extra cheap call per new session (haiku for this would
// be ideal but we use the same client for simplicity). Triggered
// exclusively on the first user+assistant exchange so sessions don't
// re-bill on every turn.
async function maybeGenerateSessionLabel(sessionId) {
  try {
    const sRes = await pool.query(`SELECT * FROM ai_sessions WHERE id = $1`, [sessionId]);
    if (!sRes.rows.length) return;
    const session = sRes.rows[0];
    if (session.summary) return; // already have a summary; don't overwrite

    // Load the first user + assistant exchange. We summarize from text
    // only — image content is dropped because it would blow up the
    // prompt for no quality gain on a label task.
    const mRes = await pool.query(
      `SELECT role, content FROM ai_messages
         WHERE user_id = $1
           AND entity_type = $2
           AND COALESCE(estimate_id, '') = COALESCE($3, '')
         ORDER BY created_at ASC
         LIMIT 4`,
      [session.user_id, session.entity_type, session.entity_id]
    );
    if (mRes.rows.length < 2) return; // need at least one exchange

    const anthropic = getAnthropic();
    if (!anthropic) return;

    const exchange = mRes.rows
      .map(m => (m.role === 'user' ? 'User: ' : 'Assistant: ') +
        (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 800))
      .join('\n\n');

    const result = await anthropic.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 200,
      messages: [{
        role: 'user',
        content:
          'Given this conversation excerpt, output JSON with exactly two fields:\n' +
          '  "label": a 2-6 word title (no quotes, no period)\n' +
          '  "summary": one short sentence describing what the conversation is about (under 90 chars)\n' +
          'Output ONLY the JSON object, nothing else.\n\n---\n\n' + exchange
      }]
    });
    const text = result && Array.isArray(result.content)
      ? result.content.map(b => b.type === 'text' ? b.text : '').join('')
      : '';
    if (!text) return;
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return;
    let parsed;
    try { parsed = JSON.parse(match[0]); } catch (_) { return; }
    const label = parsed.label && String(parsed.label).slice(0, 200);
    const summary = parsed.summary && String(parsed.summary).slice(0, 500);
    if (!label && !summary) return;

    // Only overwrite the label if the existing one is a placeholder
    // (auto-anchor used the entity name/id). Anything the user
    // explicitly renamed stays. The placeholder pattern is "Type id"
    // or "Type <number>" — distinct from descriptive labels which
    // tend to be longer with multiple lower-case words.
    const isPlaceholder = !session.label ||
      /^(Job|Estimate|Lead|Intake|General|Client)( [A-Za-z0-9_\-]+)?$/.test(session.label);

    await pool.query(
      `UPDATE ai_sessions
          SET label = CASE WHEN $1::boolean THEN COALESCE($2, label) ELSE label END,
              summary = COALESCE($3, summary)
        WHERE id = $4`,
      [isPlaceholder, label || null, summary || null, sessionId]
    );
  } catch (e) {
    console.warn('[maybeGenerateSessionLabel] failed for session', sessionId, ':', e.message);
  }
}

// Archive the active v2 ai_sessions row for one (agent, entity, user)
// tuple AND archive the Anthropic-side session so the next chat turn
// creates a fresh session. Called from the DELETE /messages handlers
// so "Clear conversation" actually starts over instead of leaving the
// agent with full server-side context the user thought they wiped.
// Idempotent — no-op if there's no active row.
async function archiveActiveAiSession({ agentKey, entityType, entityId, userId }) {
  const row = await pool.query(
    `SELECT * FROM ai_sessions
       WHERE agent_key = $1
         AND entity_type = $2
         AND COALESCE(entity_id, '') = COALESCE($3, '')
         AND user_id = $4
         AND archived_at IS NULL`,
    [agentKey, entityType, entityId, userId]
  );
  if (!row.rows.length) return;
  const session = row.rows[0];
  const anthropic = getAnthropic();
  if (anthropic) {
    try { await anthropic.beta.sessions.archive(session.anthropic_session_id); }
    catch (e) { console.warn('Archive of cleared session failed (non-fatal):', e && e.message); }
  }
  await pool.query('UPDATE ai_sessions SET archived_at = NOW() WHERE id = $1', [session.id]);
}

async function recoverStuckSession({ anthropic, sessionRow }) {
  console.warn('[v2-stream] recovering stuck session', sessionRow.anthropic_session_id,
               '(kind=' + (sessionRow.session_kind || 'legacy_partitioned') + ')');
  try { await anthropic.beta.sessions.archive(sessionRow.anthropic_session_id); }
  catch (e) { console.warn('Archive of stuck session failed (non-fatal):', e && e.message); }
  await pool.query('UPDATE ai_sessions SET archived_at = NOW() WHERE id = $1', [sessionRow.id]);

  // Phase 2c: every agent is per-tenant, so createFreshAiSession needs
  // the full organization row. Resolve from the session's user_id —
  // user → organization is 1:1.
  const orgRow = await pool.query(
    `SELECT o.* FROM organizations o
       JOIN users u ON u.organization_id = o.id
      WHERE u.id = $1`,
    [sessionRow.user_id]
  );
  const organization = orgRow.rows[0];
  if (!organization) {
    throw new Error('Cannot recover stuck session: user ' + sessionRow.user_id + ' has no organization.');
  }

  // Unified-86 Phase 4d — preserve session_kind across recovery so a
  // stuck user-thread becomes a fresh user-thread (not a legacy
  // partitioned row). Without this, recovery would silently demote
  // the user back to the per-entity session shape and the next chat
  // turn would carve a new entity-anchored thread instead of
  // continuing the rolling user-thread. Server-side compaction
  // (compact-2026-01-12, Phase 4c) is the steady-state guard against
  // token bloat; this archive+recreate is the last-resort hatch when
  // a session ends up genuinely wedged in requires_action.
  const fresh = await createFreshAiSession({
    agentKey: sessionRow.agent_key,
    entityType: sessionRow.entity_type,
    entityId: sessionRow.entity_id,
    userId: sessionRow.user_id,
    organization,
    sessionKind: sessionRow.session_kind === 'user_thread' ? 'user_thread' : undefined
  });

  // The Anthropic-side history is gone, but ai_messages rows are
  // intact — so user-visible continuity (sidebar transcript, replay,
  // memory recall) survives. Short-term mid-conversation context
  // (last few turns) is what gets lost; the memory tool covers any
  // durable facts the model wanted to keep.
  return fresh;
}

async function runV2SessionStream({ anthropic, res, session, eventsToSend, persistAssistantText, onCustomToolUse, freshlyCreated }) {
  // Same idempotency guard as runStream — V2 sessions also fire dual
  // error paths (events.send throw + stream 'error' event) on certain
  // failures (credit-balance, stuck sessions, etc.). Without these
  // guards, the double-end triggered ERR_STREAM_WRITE_AFTER_END which
  // crashed the Node process and put Railway into a deploy-restart
  // loop. Idempotent writes prevent that.
  let _ended = false;
  function send(payload) {
    if (_ended || res.writableEnded) return;
    try { res.write('data: ' + JSON.stringify(payload) + '\n\n'); }
    catch (e) {}
  }
  function endWithDone() {
    if (_ended || res.writableEnded) return;
    _ended = true;
    try { res.write('data: [DONE]\n\n'); } catch (e) {}
    try { res.end(); } catch (e) {}
  }

  // Resolve the session id, recovering once if the prior session is
  // stuck waiting on tool responses. We have to attempt the events.send
  // before opening the stream when we recover, because the original
  // session id is now archived.
  let activeSession = session;
  let sessionId = session.anthropic_session_id;
  // Tracks whether we've already tried the non-destructive "resolve
  // the dangling sevt_* ids" recovery on this turn. Prevents looping
  // when the in-place recovery itself triggers another stuck error.
  let inPlaceRecoveryAttempted = false;

  // Stall recovery: when the model emits agent.thinking but produces
  // neither a text reply nor a follow-up tool_use before the session
  // idles in `requires_action`, the API rejects free-form user.message
  // events (it's specifically waiting on tool results). Recovery is a
  // two-step server-side dance:
  //   1. Send `user.interrupt` to clear requires_action so the session
  //      will accept a fresh user.message.
  //   2. Reopen the stream and send a nudge user.message that asks the
  //      agent to either reply or call its next tool now.
  // Capped at MAX_NUDGES so a permanently broken conversation can't
  // loop forever — when retries are exhausted, we still send a final
  // `user.interrupt` so the NEXT /chat call from the client starts
  // clean instead of failing on a still-stuck session.
  const MAX_NUDGES = 1;
  let nudgeAttempts = 0;
  const NUDGE_TEXT =
    'Continue. The previous tool calls completed — please respond now ' +
    'by calling your next tool (e.g. propose_create_lead) or by replying ' +
    'to the user. Do not re-run the prior reads with the same arguments.';

  // Silent-stop recovery state — fires when auto-tier tools ran and
  // flushed their results successfully, but the resumed turn produced
  // NO text and went straight to terminal idle. Different from the
  // `stalled` recovery above (which fires on requires_action stalls
  // BEFORE any tools complete). Capped at 1 per turn so a model that
  // simply refuses to summarize doesn't burn endless API calls.
  const MAX_SILENT_STOP_NUDGES = 1;
  let silentStopNudges = 0;
  let autoResultsFlushedThisTurn = false;
  const SILENT_STOP_NUDGE_TEXT =
    'The tool results above completed successfully. Please summarize ' +
    'them in one or two sentences for the user before ending your turn.';

  // Helper to (re)open stream + send events. Stuck-state recovery is
  // skipped for sessions we know are brand-new (Fix 2): /chat handlers
  // that just ran archiveActiveAiSession + createFreshAiSession pass
  // freshlyCreated=true; if events.send to a brand-new session reports
  // "stuck", recovery would only loop archive→create→archive forever.
  // For freshly-created sessions we surface the error to the user.
  async function openStreamAndSend(eventsForThisOpen) {
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

    if (Array.isArray(eventsForThisOpen) && eventsForThisOpen.length) {
      // Anthropic's events.send endpoint caps at 50 events per call.
      // Auto-tier batches (86 running update_client_field across an
      // entire client directory, etc.) routinely exceed that — chunk
      // sequentially. The session processes chunks in order, so
      // tool_result ordering is preserved.
      const EVENTS_PER_SEND = 50;
      try {
        for (let i = 0; i < eventsForThisOpen.length; i += EVENTS_PER_SEND) {
          const chunk = eventsForThisOpen.slice(i, i + EVENTS_PER_SEND);
          await anthropic.beta.sessions.events.send(sessionId, { events: chunk });
          if (eventsForThisOpen.length > EVENTS_PER_SEND) {
            console.log('[v2-stream] sent chunk', (i / EVENTS_PER_SEND) + 1,
              '(' + chunk.length + ' event(s)) to', sessionId);
          }
        }
        console.log('[v2-stream] sent', eventsForThisOpen.length, 'event(s) to', sessionId);
      } catch (e) {
        if (isStuckSessionError(e) && !freshlyCreated) {
          // In-place recovery FIRST: parse the blocked sevt_* ids out
          // of the error, send user.custom_tool_result events to
          // resolve them, then retry the original send on the SAME
          // session. This preserves Anthropic-side conversation
          // history (without this branch, the agent would forget the
          // prior turn — see the "option 1" amnesia bug). Only fall
          // through to the nuclear archive+recreate if in-place
          // recovery itself fails.
          if (!inPlaceRecoveryAttempted) {
            const blockedIds = extractStuckEventIds(e);
            if (blockedIds.length) {
              console.warn('[v2-stream] in-place recovery on', sessionId,
                '— resolving', blockedIds.length, 'dangling tool_use id(s):',
                JSON.stringify(blockedIds));
              try {
                // Resolve each dangling event with a generic "Continue."
                // tool_result. Then close this stream and reopen with
                // the user's original events on the same session.
                const resolveEvents = blockedIds.map(id => ({
                  type: 'user.custom_tool_result',
                  custom_tool_use_id: id,
                  content: [{ type: 'text', text: 'Continue.' }]
                }));
                await anthropic.beta.sessions.events.send(sessionId, { events: resolveEvents });
                try { await stream.controller.abort(); } catch (_) {}
                // Re-enter openStreamAndSend with the SAME sessionId
                // and the user's ORIGINAL events. Mark
                // inPlaceRecoveryAttempted so a repeat stuck error
                // on this turn falls through to nuclear recovery
                // instead of looping forever.
                inPlaceRecoveryAttempted = true;
                return openStreamAndSend(eventsForThisOpen);
              } catch (eInPlace) {
                console.error('[v2-stream] in-place recovery failed, falling through to archive+recreate:', eInPlace && eInPlace.message);
                // Fall through to the nuclear branch below.
              }
            } else {
              console.warn('[v2-stream] stuck-session error had no parseable sevt_* ids, jumping to nuclear recovery');
            }
          } else {
            console.warn('[v2-stream] in-place recovery already attempted, escalating to archive+recreate');
          }
          // Nuclear fallback: archive + recreate. Loses Anthropic-side
          // history; user has to re-state context if they ask a
          // follow-up that depended on a prior turn.
          try {
            activeSession = await recoverStuckSession({ anthropic, sessionRow: activeSession });
            sessionId = activeSession.anthropic_session_id;
            try { await stream.controller.abort(); } catch (_) {}
            return openStreamAndSend(eventsForThisOpen);
          } catch (e2) {
            console.error('Stuck-session recovery failed:', e2);
            send({ error: 'Could not recover session: ' + (e2.message || 'unknown') });
            endWithDone();
            return null;
          }
        }
        if (isStuckSessionError(e) && freshlyCreated) {
          console.error('[v2-stream] freshly-created session reported stuck — refusing to recover (would loop):', sessionId);
        }
        // Stale tool_use_id — the client posted approval for a card
        // whose tool_use event lives in an archived session. Surface
        // a clear instruction instead of bubbling raw Anthropic JSON.
        // The client side drops pendingToolUses on next chat call, so
        // the user just needs to re-prompt.
        if (isStaleToolUseIdError(e)) {
          console.warn('[v2-stream] stale tool_use_id on', sessionId,
            '— session was recreated after the proposal card was shown.');
          send({ error: 'The chat session was reset between turns, so those approval cards no longer apply. Re-send your request and I\'ll redo the proposals fresh.' });
          send({ stale_tool_use_id: true });
          endWithDone();
          return null;
        }
        console.error('Session events.send failed:', e);
        send({ error: e.message || 'Failed to send session events' });
        endWithDone();
        return null;
      }
    }
    return stream;
  }

  // Stall-aware run loop. Each pass opens a stream, iterates events
  // until idle, and either finalizes the SSE response or — on a
  // thinking-then-stop stall — sends a nudge user.message and runs
  // again. Per-pass state (text accumulation, pending tools, usage,
  // event counts) resets each iteration; nudge counter persists.
  let nextEventsToSend = eventsToSend;
  while (true) {
    let assistantText = '';
    const pendingToolUses = [];
    // Auto-tier batch buffer (Phase B refactor): when the model emits
    // parallel `agent.custom_tool_use` events, we run the auto-tier
    // callback inline (so we can show tool_applied chips immediately)
    // but we DEFER the user.custom_tool_result events.send to the
    // next idle. Sending them sequentially while the stream is mid-
    // flight raced with `session.status_idle` and left the session
    // believing the tool_use ids were still blocked — the API would
    // then 400 any subsequent user.message with "waiting on responses
    // to events [sevt_…]". Batching all results in one events.send on
    // idle is robust against the parallel-tool-call race and matches
    // how /chat/continue already delivers approval-tier results.
    const pendingAutoResults = [];
    let usage = { input_tokens: null, output_tokens: null };
    // Diagnostic — counts each event type we see in this turn so a
    // failed/empty turn is debuggable from Railway logs without per-
    // request stack traces. Logged once at end-of-stream.
    const eventCounts = {};
    let stallNudgeQueued = false;

    const stream = await openStreamAndSend(nextEventsToSend);
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
            // Always signal "tool starting" to the client — drives the
            // brain-yoga caption swap to a friendly tool-specific verb
            // ("Drafting line item…" / "Pulling metrics…" / etc.) the
            // moment the model emits the tool_use, before either the
            // approval card or the tool_applied result lands. Fires for
            // every agent regardless of whether onCustomToolUse is set.
            send({ tool_started: { id: tu.id, name: tu.name } });
            // Directory / CoS / 86 auto-tier path: callback decides whether we
            // execute server-side (and resume the session in-stream) or
            // collect for user approval (default behavior).
            if (typeof onCustomToolUse === 'function') {
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
                  // `meta` carries structured tool-specific data
                  // (e.g. subtask_id for spawn_subtask) so the client
                  // can render dedicated UI without parsing summary text.
                  const appliedPayload = { id: tu.id, name: tu.name, input: tu.input, summary: summary.slice(0, 500) };
                  if (decision.meta) appliedPayload.meta = decision.meta;
                  send({ tool_applied: appliedPayload });
                }
                // QUEUE the result; flushed in batch at session.status_idle.
                // See pendingAutoResults comment above for why we don't
                // call events.send here.
                //
                // Structured `blocks` (e.g. view_attachment_image returning
                // an image + text label) ride through as the content array
                // verbatim. The Sessions API's user.custom_tool_result
                // content field mirrors Messages API tool_result and
                // accepts text + image blocks.
                const resultContent = (!isError && Array.isArray(decision.blocks) && decision.blocks.length)
                  ? decision.blocks
                  : [{ type: 'text', text: summary }];
                pendingAutoResults.push({
                  type: 'user.custom_tool_result',
                  custom_tool_use_id: tu.id,
                  content: resultContent,
                  is_error: isError || undefined
                });
                break; // continue iterating; results flush on idle
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
          case 'session.compaction_complete':
          case 'session.compacted': {
            // Anthropic server-side compaction (compact-2026-01-12)
            // just summarized earlier turns. Stamp the row so the
            // sidebar / admin UI can show "last compacted N ago" and
            // observability dashboards can alert when a long thread
            // hasn't compacted recently. Defensive on event name —
            // both shapes are documented variants depending on SDK
            // version. Non-fatal on UPDATE failure (the actual
            // compaction already happened server-side).
            console.log('[v2-stream] compaction event:', event.type, 'session', sessionId);
            try {
              await pool.query(
                `UPDATE ai_sessions
                    SET last_compacted_at = NOW()
                  WHERE id = $1`,
                [session.id]
              );
            } catch (e) {
              console.warn('[v2-stream] last_compacted_at update failed:', e.message);
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
            // Outstanding tool_use event ids the session is blocked on.
            // For requires_action-with-tools, this is the canonical list
            // of ids we still owe user.custom_tool_result events for.
            const blockedEventIds =
              (event.stop_reason && Array.isArray(event.stop_reason.event_ids))
                ? event.stop_reason.event_ids
                : [];
            console.log('[v2-stream] idle', sessionId, 'stop_reason:', stopType,
              'blocked_event_ids:', JSON.stringify(blockedEventIds),
              'pendingTools:', pendingToolUses.length,
              'pendingAutoResults:', pendingAutoResults.length,
              'assistantTextLen:', assistantText.length,
              'nudgeAttempts:', nudgeAttempts,
              'events seen:', JSON.stringify(eventCounts));

            // Auto-tier batch flush (Phase B): if we collected
            // user.custom_tool_result events during the stream, send
            // them all at once now and reopen the stream so the model
            // resumes with all tool responses received atomically. This
            // is the parallel-tool-call race fix — sending results
            // sequentially while the stream is mid-flight left the
            // session believing the tool_use ids were still blocked.
            if (pendingAutoResults.length && stopType === 'requires_action') {
              console.log('[v2-stream] flushing', pendingAutoResults.length,
                'auto-tier tool_result(s) for', sessionId);
              nextEventsToSend = pendingAutoResults.slice();
              // CRITICAL: clear the queue after capturing. Without this,
              // a subsequent batch of auto-tier tools (e.g. 86 fires 3
              // reads, idles, flushes, then fires a 4th read on the
              // next round) would re-flush ALL prior results — including
              // ones the session already resolved. Anthropic 400s with
              // "tool_use_id … does not match any custom_tool_use event
              // in this session" because the earlier ids are gone.
              pendingAutoResults.length = 0;
              // Flag the turn so the post-stream check at the bottom can
              // detect "auto-results flushed, but the resumed turn
              // produced no text" → fire the silent-stop nudge once.
              autoResultsFlushedThisTurn = true;
              stallNudgeQueued = true; // signals "reopen stream"
              break; // exit switch; post-switch check exits for-await
            }

            // Stall-recovery branch: the agent thought, ran no
            // tools, and produced no text before idling in
            // requires_action. Anthropic's API holds requires_action
            // until either a tool_result lands for any outstanding
            // custom_tool_use OR a user.interrupt clears state — a
            // free-form user.message would 400 with "waiting on
            // responses to events". Two-step recovery: send interrupt,
            // then queue a fresh nudge user.message for the next pass
            // of the outer while loop, which reopens the stream.
            const stalled =
              stopType === 'requires_action' &&
              pendingToolUses.length === 0 &&
              assistantText.length === 0;
            if (stalled && nudgeAttempts < MAX_NUDGES) {
              nudgeAttempts++;
              console.warn('[v2-stream] stall detected on', sessionId,
                '— attempting recovery (attempt',
                nudgeAttempts, 'of', MAX_NUDGES + ')');
              // Atomic recovery: queue tool_results for any outstanding
              // event_ids AND the nudge user.message into a single
              // openStreamAndSend call. The API processes them in
              // order (clearing requires_action blockers first), so
              // user.message lands on a session that's no longer
              // waiting on tool responses. Sending these in two
              // separate events.send calls used to race and 400 with
              // "waiting on responses to events [sevt_…]".
              const recoveryEvents = blockedEventIds.length
                ? blockedEventIds.map(id => ({
                    type: 'user.custom_tool_result',
                    custom_tool_use_id: id,
                    content: [{ type: 'text', text: 'Continue.' }]
                  }))
                : [{ type: 'user.interrupt' }];
              recoveryEvents.push({
                type: 'user.message',
                content: [{ type: 'text', text: NUDGE_TEXT }]
              });
              nextEventsToSend = recoveryEvents;
              stallNudgeQueued = true;
              // Break the switch; the post-switch check exits the
              // for-await so the outer while reopens the stream.
              break;
            } else if (stalled) {
              // Retries exhausted — still clear requires_action so
              // the next /chat from the client starts on a clean
              // session instead of bouncing off a stuck state.
              console.warn('[v2-stream] stall retries exhausted on', sessionId,
                '— clearing state for next turn');
              try {
                const clearEvents = blockedEventIds.length
                  ? blockedEventIds.map(id => ({
                      type: 'user.custom_tool_result',
                      custom_tool_use_id: id,
                      content: [{ type: 'text', text: 'Continue.' }]
                    }))
                  : [{ type: 'user.interrupt' }];
                // Same 50-event cap applies here — chunk to be safe in
                // case a stalled session was blocked on >50 tool_use ids.
                const EVENTS_PER_SEND = 50;
                for (let i = 0; i < clearEvents.length; i += EVENTS_PER_SEND) {
                  await anthropic.beta.sessions.events.send(sessionId, {
                    events: clearEvents.slice(i, i + EVENTS_PER_SEND)
                  });
                }
              } catch (e) {
                console.warn('Final clear failed (non-fatal):', e && e.message);
              }
            }

            if (pendingToolUses.length || stopType === 'requires_action') {
              for (const tu of pendingToolUses) {
                // Tag each tool_use with its approval tier so the client
                // can render talk_through tools as a single inline
                // Approve / Reject row rather than per-tool cards.
                send({ tool_use: tu, tier: tierFor(tu.name) });
              }
              // Persist BOTH the streamed prose AND the proposed tool_use
              // blocks before we close the response. Previously this branch
              // emitted awaiting_approval without writing anything to
              // ai_messages — so any prose 86 streamed alongside the
              // proposal ("Here's my plan: …") was lost the moment the
              // user refreshed, and the proposal itself was invisible to
              // future history reads (no tool_uses row, no tool_use_count
              // on any message). That made conversations like the
              // Windermere thread look like 86 ghosted the user even when
              // it had emitted tool_use blocks. Now we always persist a
              // row when tools were proposed, even if assistantText is
              // empty — the tool_uses payload alone is worth keeping.
              if (persistAssistantText && (assistantText || pendingToolUses.length)) {
                try {
                  await persistAssistantText(
                    assistantText || '',
                    usage,
                    {
                      tool_uses: pendingToolUses.map(t => ({
                        id: t.id,
                        name: t.name,
                        input: t.input
                      })),
                      tool_use_count: pendingToolUses.length
                    }
                  );
                } catch (e) {
                  console.error('persistAssistantText (awaiting) failed:', e);
                }
              }
              // Determine the overall tier for the turn. If every
              // pending tool is talk_through, the client renders ONE
              // inline Approve / Reject row. Mixed turns fall back to
              // per-tool approval cards so the user sees the structured
              // fields for the higher-stakes tools.
              const turnTier = pendingToolUses.every(t => TALK_THROUGH_TOOLS.has(t.name))
                ? 'talk_through'
                : 'approval';
              send({
                awaiting_approval: true,
                // Session is server-managed; client doesn't need to echo
                // the assistant content back on /chat/continue.
                pending_assistant_content: null,
                tool_use_count: pendingToolUses.length,
                tier: turnTier,
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
          case 'agent.tool_use': {
            // Built-in toolset (web_search / web_fetch / bash / read /
            // write / edit / glob / grep). Anthropic runs them
            // server-side in the session's container — we don't
            // execute and we don't approve. Forward as both a
            // tool_started (caption flash) and tool_applied (green
            // chip) since these tools fire and complete fast — the
            // pair gives the user visible proof a built-in tool ran
            // even on a turn that produces no follow-up text.
            const name = event.name || 'tool';
            const i = event.input || {};
            const summary =
              name === 'web_search' ? 'web_search · ' + (i.query || '').slice(0, 80) :
              name === 'web_fetch'  ? 'web_fetch · '  + (i.url   || '').slice(0, 80) :
              name === 'bash'       ? 'bash · '       + (i.command || '').slice(0, 80) :
              name === 'read'       ? 'read · '       + (i.path || i.file_path || '').slice(0, 80) :
              name === 'write'      ? 'write · '      + (i.path || i.file_path || '').slice(0, 80) :
              name === 'edit'       ? 'edit · '       + (i.path || i.file_path || '').slice(0, 80) :
              name === 'glob'       ? 'glob · '       + (i.pattern || '').slice(0, 80) :
              name === 'grep'       ? 'grep · '       + (i.pattern || '').slice(0, 80) :
              name;
            send({ tool_started: { id: event.id, name: name } });
            send({ tool_applied: { id: event.id, name: name, summary: summary } });
            break;
          }
          default:
            // Ignore agent.thinking / span.* / etc.
            break;
        }
        // After handling each event, check if the idle case queued a
        // stall-nudge — if so, exit the for-await so the outer while
        // can reopen the stream with the nudge user.message.
        if (stallNudgeQueued) break;
      }
    } catch (e) {
      console.error('Session stream iteration error:', e);
      // Fix 1 diagnostic — capture end-of-stream state for the silent-
      // stop debug story. We log on both the catch path and the normal-
      // exit path below so Railway tail-logs always include enough
      // context to tell model-decision from stream-anomaly.
      console.log('[v2-stream] iteration-catch end state',
        'session', sessionId,
        'session_id_db:', session && session.id,
        'session_kind:', session && session.session_kind,
        'assistantTextLen:', assistantText.length,
        'pendingToolUses:', pendingToolUses.length,
        'pendingAutoResults:', pendingAutoResults.length,
        'nudgeAttempts:', nudgeAttempts,
        'silentStopNudges:', silentStopNudges,
        'autoResultsFlushedThisTurn:', autoResultsFlushedThisTurn,
        'events:', JSON.stringify(eventCounts));
      send({ error: e.message || 'Stream failed' });
      endWithDone();
      return;
    }

    if (!stallNudgeQueued) {
      // Fix 2 — silent-stop recovery. If we already flushed auto-tier
      // tool_results this turn AND the resumed turn produced zero
      // text AND no approval-tier tools are pending, the model fell
      // silent post-results. That's the "Used N tools but didn't
      // produce a summary" symptom in the client UI. Nudge once with
      // an explicit "summarize the tool results" user.message and
      // reopen the stream. Capped at MAX_SILENT_STOP_NUDGES so a
      // model that just refuses doesn't drive endless API calls.
      const silentStop =
        autoResultsFlushedThisTurn &&
        assistantText.length === 0 &&
        pendingToolUses.length === 0;
      if (silentStop && silentStopNudges < MAX_SILENT_STOP_NUDGES) {
        silentStopNudges++;
        console.warn('[v2-stream] silent-stop detected on', sessionId,
          '— nudging for summary (attempt', silentStopNudges,
          'of', MAX_SILENT_STOP_NUDGES + ')');
        nextEventsToSend = [{
          type: 'user.message',
          content: [{ type: 'text', text: SILENT_STOP_NUDGE_TEXT }]
        }];
        stallNudgeQueued = true;
        continue; // loop back, reopen stream with the summary nudge
      }

      // Fix 1 diagnostic — log the FINAL state of every terminal
      // exit (silent-stop, model-end, network-drop). One log line
      // per turn keeps Railway tails scannable.
      console.log('[v2-stream] terminal end',
        'session', sessionId,
        'session_id_db:', session && session.id,
        'session_kind:', session && session.session_kind,
        'assistantTextLen:', assistantText.length,
        'pendingToolUses:', pendingToolUses.length,
        'pendingAutoResults:', pendingAutoResults.length,
        'nudgeAttempts:', nudgeAttempts,
        'silentStopNudges:', silentStopNudges,
        'autoResultsFlushedThisTurn:', autoResultsFlushedThisTurn,
        'events:', JSON.stringify(eventCounts));

      // Stream ended without idle (rare — abort, network drop). Close
      // out so the client gets [DONE] instead of a hung response.
      endWithDone();
      return;
    }
    // else loop back, reopen stream with nextEventsToSend = nudge.
  }
}

// Legacy /v2/estimates/:id/chat (+ /continue) removed — every chat
// path is /api/ai/86/chat now. Caught by LEGACY_CHAT_PATHS 410 intercept.

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
async function buildJobContext(jobId, clientContext, aiPhase, organization, opts) {
  // opts.includePhotos (default false) — when true, the cascade photos
  // are tokenized inline as vision blocks. Default is false so the
  // per-turn user.message stays small; 86 calls view_attachment_image
  // by id when it actually needs to see one. The photo MANIFEST (ids,
  // filenames, sizes) always renders so 86 knows what's available.
  const includePhotos = !!(opts && opts.includePhotos);
  // aiPhase: 'plan' (read-only analysis, no writes) | 'edit' | 'auto'
  // (full tool access, identical on the server — 'auto' is a
  // client-side flag that auto-fires whitelisted line tools without
  // approval cards). Legacy 'build' is coerced to 'edit'. Defaults to
  // 'plan' so 86 starts as an analyst until the PM grants write access
  // via the phase pill or the request_edit_mode tool.
  aiPhase = (aiPhase === 'plan') ? 'plan' : 'edit';
  // Pull the job + the related data the bulk-save serializes alongside it.
  const jobRes = await pool.query('SELECT id, owner_id, data FROM jobs WHERE id = $1', [jobId]);
  if (!jobRes.rows.length) throw new Error('Job not found');
  const job = { id: jobRes.rows[0].id, owner_id: jobRes.rows[0].owner_id, ...jobRes.rows[0].data };

  // Phase 2 — Job context inherits attachments from the originating
  // lead and any estimate(s) that hung off that lead. Mirrors the
  // estimate→lead inheritance buildEstimateContext already does.
  // Lookup chain:
  //   leads.job_id = jobId  → lead.id
  //   estimates.data->>'lead_id' = lead.id  → estimate.id(s)
  // All three (job + lead + estimates) attachments rolled up so the
  // PM working in the job sees every photo/doc captured during the
  // pre-job lifecycle.
  const linkedAtts = [];
  try {
    const jobAtts = await pool.query(
      `SELECT * FROM attachments WHERE entity_type='job' AND entity_id=$1
         ORDER BY position, uploaded_at`,
      [jobId]
    );
    linkedAtts.push(...jobAtts.rows.map(r => ({ ...r, source: 'job' })));
    const leadR = await pool.query(`SELECT id FROM leads WHERE job_id=$1 LIMIT 1`, [jobId]);
    if (leadR.rows.length) {
      const leadId = leadR.rows[0].id;
      const leadAtts = await pool.query(
        `SELECT * FROM attachments WHERE entity_type='lead' AND entity_id=$1
           ORDER BY position, uploaded_at`,
        [leadId]
      );
      linkedAtts.push(...leadAtts.rows.map(r => ({ ...r, source: 'lead' })));
      const estR = await pool.query(`SELECT id FROM estimates WHERE data->>'lead_id'=$1`, [leadId]);
      if (estR.rows.length) {
        const estIds = estR.rows.map(r => r.id);
        const estAtts = await pool.query(
          `SELECT * FROM attachments WHERE entity_type='estimate' AND entity_id = ANY($1::text[])
             ORDER BY position, uploaded_at`,
          [estIds]
        );
        linkedAtts.push(...estAtts.rows.map(r => ({ ...r, source: 'estimate' })));
      }
    }
  } catch (e) {
    console.warn('[buildJobContext] attachment cascade failed (non-fatal):', e && e.message);
  }
  const cascadePhotoBlocks = [];
  const cascadePhotoManifest = []; // {source, filename, id, size} — always built
  const cascadeDocs = [];
  for (const a of linkedAtts) {
    if (a.mime_type && a.mime_type.startsWith('image/') && a.thumb_key) {
      // Always record in the manifest so 86 sees photos exist and can
      // call view_attachment_image({attachment_id}) on the specific one
      // it needs. Cap inline vision blocks at 12 for the rare turns
      // where the caller opted into auto-attach (opts.includePhotos).
      cascadePhotoManifest.push({
        source: a.source,
        filename: a.filename,
        id: a.id,
        size: a.size_bytes
      });
      if (includePhotos && cascadePhotoBlocks.length < 12) {
        try {
          const blk = await loadPhotoAsBlock(a);
          if (blk) cascadePhotoBlocks.push(blk);
        } catch (e) { /* skip a single bad photo */ }
      }
    } else {
      cascadeDocs.push({
        source: a.source,
        filename: a.filename,
        mime: a.mime_type,
        size: a.size_bytes
      });
    }
  }

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
  lines.push('You are 86, Project 86\'s WIP analyst. Project 86 = a Central-Florida construction-services platform, a Central Florida construction services company. The PM is working on the job below — help them spot margin issues, missing change orders, billing gaps, and progress risks. (Your name is a nod to Lisa.)');
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

  // Phase 2 — Surface inherited attachments so 86 knows what photos
  // and docs are visible on this turn. Photo blocks are pushed into
  // userContent on the way out; this section is a roll-up summary.
  if (linkedAtts.length) {
    const bySrc = { job: 0, lead: 0, estimate: 0 };
    linkedAtts.forEach(a => { bySrc[a.source] = (bySrc[a.source] || 0) + 1; });
    const srcParts = [];
    if (bySrc.job)      srcParts.push(bySrc.job      + ' on job');
    if (bySrc.estimate) srcParts.push(bySrc.estimate + ' from estimate');
    if (bySrc.lead)     srcParts.push(bySrc.lead     + ' from lead');
    lines.push('# Attachments');
    lines.push('- Total: ' + linkedAtts.length + ' (' + srcParts.join(' · ') + ').');
    if (cascadeDocs.length) {
      lines.push('## Docs');
      cascadeDocs.slice(0, 12).forEach(d => {
        lines.push('- [' + d.source + '] ' + d.filename + ' (' + (d.mime || '') + (d.size ? ', ' + Math.round(d.size / 1024) + ' KB' : '') + ')');
      });
      if (cascadeDocs.length > 12) lines.push('- … and ' + (cascadeDocs.length - 12) + ' more');
    }
    if (cascadePhotoManifest.length) {
      lines.push('## Photos');
      lines.push('- ' + cascadePhotoManifest.length + ' photo' + (cascadePhotoManifest.length === 1 ? '' : 's') +
        ' attached to this job (priority: job → lead → estimate). ' +
        (includePhotos
          ? cascadePhotoBlocks.length + ' shown inline as vision content below.'
          : 'Call `view_attachment_image({attachment_id})` on the specific one you need to actually see. The manifest below shows ids.'));
      cascadePhotoManifest.slice(0, 24).forEach(p => {
        const sz = p.size ? Math.round(p.size / 1024) + ' KB' : '?';
        lines.push('  - [' + p.id + '] ' + (p.filename || '(unnamed)') + ' · ' + p.source + ' · ' + sz);
      });
      if (cascadePhotoManifest.length > 24) {
        lines.push('  - … and ' + (cascadePhotoManifest.length - 24) + ' more (ask for them by name if needed).');
      }
    }
    lines.push('');
  }

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
  // this 86 has no way to verify her own cascade results before /
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
    // 86 has had trouble with this — two parallel cascade paths
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

  // Cost-side detail — top vendors by total dollars posted from
  // qb_cost_lines for this job. The old code read job.subs and tried
  // to pull .amount/.vendor off sub-directory records that don't
  // have those fields (subs use .name / .contractAmt / .billedToDate),
  // so every row rendered as "$0 <sub-name>" regardless of what was
  // actually posted. Now groups the real QB cost lines by vendor,
  // sums amount, sorts desc, top 20. Includes ALL lines (linked AND
  // unlinked to graph nodes) — many lines on real jobs haven't been
  // wired yet, and silently filtering them out would hide cost.
  try {
    const cl = await pool.query(
      `SELECT COALESCE(NULLIF(TRIM(vendor), ''), '(no vendor)') AS vendor,
              SUM(amount)::numeric(12,2) AS total,
              COUNT(*)::int AS line_count,
              SUM(CASE WHEN linked_node_id IS NULL THEN 1 ELSE 0 END)::int AS unlinked_count
         FROM qb_cost_lines
        WHERE job_id = $1
        GROUP BY 1
        ORDER BY total DESC
        LIMIT 20`,
      [jobId]
    );
    if (cl.rows.length) {
      const grandTotal = cl.rows.reduce((s, r) => s + Number(r.total || 0), 0);
      lines.push('# Top cost lines (top ' + cl.rows.length + ' vendors by spend)');
      lines.push('- Grand total across shown vendors: ' + fmtMoney(grandTotal));
      cl.rows.forEach(r => {
        const amt = fmtMoney(Number(r.total || 0));
        const unlinkedNote = r.unlinked_count > 0
          ? ' · ' + r.unlinked_count + '/' + r.line_count + ' unlinked'
          : '';
        lines.push('- ' + amt + ' ' + r.vendor + ' (' + r.line_count + ' line' + (r.line_count === 1 ? '' : 's') + unlinkedNote + ')');
      });
      lines.push('');
    } else if (subs.length) {
      // No QB cost lines imported yet, but subs are configured —
      // surface the contract-amount view so 86 at least sees the
      // intended sub structure. Label clearly as contracts (not
      // actuals) so it isn\'t mistaken for posted spend.
      const sortedSubs = subs.slice().sort((a, b) => Number(b.contractAmt || b.amount || 0) - Number(a.contractAmt || a.amount || 0));
      const top = sortedSubs.slice(0, 20);
      lines.push('# Sub contracts (' + top.length + ' of ' + subs.length + ' shown)');
      lines.push('- No QB cost lines imported for this job yet. Showing sub contract amounts instead — these are NOT posted actuals.');
      top.forEach(s => {
        const amt = fmtMoney(s.contractAmt || s.amount || 0);
        const label = s.name || s.vendor || s.description || '(unlabeled)';
        const billed = (s.billedToDate || s.billed) ? ' · billed ' + fmtMoney(s.billedToDate || s.billed) : '';
        lines.push('- ' + amt + ' ' + label + billed);
      });
      lines.push('');
    }
  } catch (e) {
    console.warn('[buildJobContext] qb_cost_lines rollup failed:', e.message);
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

  // Section overrides for 86. Loaded once and used at named anchor
  // points so admins can edit instructions without code changes.
  const jobSectionOverrides = await loadSectionOverridesFor('job');
  renderSection(lines, 'job_role', jobSectionOverrides);
  lines.push('');
  renderSection(lines, 'job_web_research', jobSectionOverrides);

  // Skill packs ship as native Anthropic Skills registered on the
  // agent — the runtime auto-discovers them by description each turn.

  // ── Active mode block ──────────────────────────────────────────
  // Mirrors 86's plan/build pattern. Server-side tool filtering is the
  // hard guard; this prompt block is the soft guard so the model
  // doesn't dangle "I would have done X" — it just adapts.
  lines.push('');
  if (aiPhase === 'plan') {
    lines.push('# CURRENT MODE: PLAN');
    lines.push('You are in **Plan mode** — read-only analysis. Every write tool (set_phase_pct_complete, set_phase_field, set_node_value, assign_qb_line, create_node, delete_node) has been removed from your tool list this turn, so you literally cannot call them.');
    lines.push('In Plan mode you SHOULD:');
    lines.push('  - Run reads, audit data, surface gaps and risks, propose what changes WOULD fix them.');
    lines.push('  - When your analysis surfaces an action you\'d need to take but can\'t (e.g. "B1 has cost data but pctComplete=0"), call `request_edit_mode` with a short rationale + the bullet list of writes you\'d make. The PM gets an approval card; on approve, the next turn opens with full write access.');
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

  // Job side stays plain — single string. Lower volume than estimate / directory so
  // the marginal caching benefit isn't worth the structural complexity.
  // photoBlocks now includes the cascade-rolled-up images from
  // job + lead + estimate (Phase 2). The /v2/jobs/:id/chat handler
  // spreads these into userContent so 86 sees the photos inline.
  return {
    system: lines.join('\n'),
    photoBlocks: cascadePhotoBlocks,
    aiPhase: aiPhase,
    packsLoaded: []
  };
}

// /jobs/:id/messages GET+DELETE retired — see the unified
// /api/ai/86/messages endpoint. Deleted in the system audit cleanup.

// Legacy /jobs/:id/chat (+ /continue) removed — every chat path is
// /api/ai/86/chat now. Caught by LEGACY_CHAT_PATHS 410 intercept.

// ════════════════════════════════════════════════════════════════════
// Phase 2 — v2 86 (jobs) chat path on the Anthropic Sessions API
//
// Mirrors Phase 1b's v2 estimates path. Long-lived Anthropic Session
// per (job, user) — agent.create for 86 was registered in Phase 1a,
// so the session inherits 86's system prompt, JOB_TOOLS, web_search.
//
// Per-turn dynamic context (job WIP snapshot, change orders, node
// graph) goes into the user message wrapped in <turn_context> instead
// of being re-shipped as a system prefix on every request.
//
// Gated behind AGENT_MODE_86=agents. Production stays on the v1
// runStream path until the flag is flipped.
// ════════════════════════════════════════════════════════════════════

const FLAG_AGENT_MODE_86 = (process.env.AGENT_MODE_86 || '').toLowerCase() === 'agents';

// Persist the assistant text response for an 86 turn into ai_messages
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

// Legacy /v2/jobs/:id/chat (+ /continue) removed — every chat path
// is /api/ai/86/chat now. Caught by LEGACY_CHAT_PATHS 410 intercept.

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
    salesperson_name: { type: 'string', description: 'Project 86 salesperson name from the Salesperson section or empty string.' },
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
  'You are extracting structured lead data from a Buildertrend "Lead Print" PDF for Project 86, a Central Florida construction services company.',
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

const ClientDirectoryTools = [
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
          description: 'Object of field-name → new-value pairs. Allowed fields: short_name, first_name, last_name, email, phone, cell, address, city, state, zip, company_name, community_name, market, property_address, property_phone, website, gate_code, additional_pocs, community_manager, cm_email, cm_phone, maintenance_manager, mm_email, mm_phone, notes, client_type, activation_status.'
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
    description: 'Append a short, durable fact about how to handle this client to their agent notes. These notes auto-inject into 86\'s system prompt on every future turn that touches the client (estimate, job, or directory surface), so they compound knowledge across sessions. Good notes: "PAC always wants 15% materials markup, not 20%", "Wimbledon Greens proposals must include the gate code on the cover page", "FSR billing prefers a single combined invoice per property — don\'t split by group", "Solace Tampa has a strict noise window (8a-5p) — note it in scope". Bad notes: anything ephemeral ("user is on PTO this week"), anything personal, anything that would already be obvious from the client record. Approval-required so the user vets the wording before it lands. Cap one note per call — call multiple times in parallel for multiple notes.',
    input_schema: {
      type: 'object',
      properties: {
        client_id: { type: 'string', description: 'Client to attach the note to.' },
        body: { type: 'string', description: 'The note itself, ≤ 2000 chars. Should read as a standalone instruction or fact — full sentence, ends with a period.' },
        rationale: { type: 'string', description: 'One short sentence shown on the approval card explaining why this note is worth keeping.' }
      },
      required: ['client_id', 'body', 'rationale']
    }
  },
  // ── Directory-surface scope expansion (2026-05) ──────────────────
  // 86 on the directory surface is the data steward — clients (the
  // historical role) PLUS jobs (identity card: name, jobNumber,
  // client linkage, address) and users (directory lookups). These
  // two read tools give the directory surface enough awareness to
  // answer "who's the PM on RV2041", "what's the address for
  // Wimbledon Greens", "is Calvin still active". Job/user mutations
  // are deferred to a future commit (86 proposes; user approves).
  {
    name: 'read_jobs',
    tier: 'auto',
    description: 'List jobs in Project 86 with their identity-card fields (name, jobNumber, client linkage, status, location). Use this when the user asks about a specific job\'s identity (who, where, what client) — NOT for financial / WIP / scope detail. Pass q for fuzzy name/number match. Returns up to `limit` rows (default 30, max 100).',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional fuzzy match against job number, title, or client name.' },
        status: { type: 'string', description: 'Optional filter — "New", "In Progress", "Backlog", "On Hold", "Completed", "Archived".' },
        limit: { type: 'integer', description: 'Max rows (default 30, max 100).' }
      }
    }
  },
  {
    name: 'read_users',
    tier: 'auto',
    description: 'List Project 86 staff users (PMs, admins, corporate) with name, email, role, and active status. Use to answer "who\'s the PM on this job", "is X still on staff", "who do I assign this to". Returns the directory; does NOT include passwords or sensitive auth fields. Pass q for fuzzy name/email match.',
    input_schema: {
      type: 'object',
      properties: {
        q: { type: 'string', description: 'Optional fuzzy match against name or email.' },
        role: { type: 'string', description: 'Optional filter — "admin", "corporate", "pm", "sub".' },
        active_only: { type: 'boolean', description: 'When true (default), excludes deactivated users.' },
        limit: { type: 'integer', description: 'Max rows (default 30, max 100).' }
      }
    }
  }
];

const CLIENT_EDITABLE_FIELDS = new Set([
  'short_name', 'first_name', 'last_name', 'email', 'phone', 'cell',
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
async function execClientDirectoryTool(name, input) {
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
      // We pass it via execClientDirectoryTool's options arg (added below).
      throw new Error('attach_business_card_to_client must be invoked via execClientDirectoryToolWithCtx');
    }
    case 'add_client_note': {
      // Like the business-card tool, this needs userId for audit trail
      // (created_by_user_id). Routed through execClientDirectoryToolWithCtx.
      throw new Error('add_client_note must be invoked via execClientDirectoryToolWithCtx');
    }
    case 'read_jobs': {
      const q = String(input.q || '').trim().toLowerCase();
      const status = String(input.status || '').trim();
      const limit = Math.max(1, Math.min(100, parseInt(input.limit, 10) || 30));
      const r = await pool.query(
        'SELECT j.id, j.data, c.name AS client_name ' +
        'FROM jobs j ' +
        "LEFT JOIN clients c ON c.id = (j.data->>'clientId') " +
        'ORDER BY j.updated_at DESC NULLS LAST'
      );
      let rows = r.rows.map(row => {
        const d = row.data || {};
        const buildings = Array.isArray(d.buildings) ? d.buildings : [];
        const firstBldg = buildings[0] || {};
        const address = d.address || firstBldg.address || null;
        return {
          id: row.id,
          jobNumber: d.jobNumber || null,
          title: d.title || null,
          client: row.client_name || d.client || null,
          clientId: d.clientId || null,
          status: d.status || null,
          address: address,
          pm: d.pm || null
        };
      });
      if (status) rows = rows.filter(j => String(j.status || '').toLowerCase() === status.toLowerCase());
      if (q) {
        rows = rows.filter(j => {
          const hay = (
            (j.jobNumber || '') + ' ' + (j.title || '') + ' ' +
            (j.client || '') + ' ' + (j.address || '')
          ).toLowerCase();
          return hay.indexOf(q) !== -1;
        });
      }
      rows = rows.slice(0, limit);
      if (!rows.length) return 'No jobs match the filters.';
      return rows.map(j =>
        '• ' + (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + (j.title || '(untitled)') +
        (j.client ? ' — ' + j.client : '') +
        (j.status ? ' · ' + j.status : '') +
        (j.pm ? ' · PM ' + j.pm : '') +
        (j.address ? '\n    ' + j.address : '') +
        (j.clientId ? ' · linked to client ' + j.clientId : ' · no client link')
      ).join('\n');
    }
    case 'read_wip_summary': {
      // Company-wide WIP roll-up. Reuses computeJobWIP per job so the
      // numbers match the WIP page tiles exactly. SELECT all jobs once,
      // compute in Node — jobs table is small (hundreds of rows max).
      const statusFilter = String(input.status || '').trim();
      const sortBy = ['backlog', 'contract', 'margin', 'pct_complete'].includes(input.sort_by)
        ? input.sort_by : 'backlog';
      const limit = Math.max(1, Math.min(200, parseInt(input.limit, 10) || 20));
      const r = await pool.query(
        'SELECT j.id, j.data, j.updated_at, c.name AS client_name ' +
        'FROM jobs j ' +
        "LEFT JOIN clients c ON c.id = (j.data->>'clientId') " +
        'ORDER BY j.updated_at DESC NULLS LAST'
      );
      const allJobs = r.rows.map(row => {
        const d = row.data || {};
        const buildings = Array.isArray(d.buildings) ? d.buildings : [];
        const phases = Array.isArray(d.phases) ? d.phases : [];
        const changeOrders = Array.isArray(d.changeOrders) ? d.changeOrders : [];
        const subs = Array.isArray(d.subs) ? d.subs : [];
        const invoices = Array.isArray(d.invoices) ? d.invoices : [];
        const wip = computeJobWIP(d, buildings, phases, changeOrders, subs, invoices);
        return {
          id: row.id,
          jobNumber: d.jobNumber || null,
          title: d.title || d.jobName || '(untitled)',
          client: row.client_name || d.client || null,
          status: d.status || null,
          pm: d.pm || null,
          targetMarginPct: d.targetMarginPct != null ? Number(d.targetMarginPct) : null,
          updated_at: row.updated_at,
          wip
        };
      });
      const filtered = statusFilter
        ? allJobs.filter(j => String(j.status || '').toLowerCase() === statusFilter.toLowerCase())
        : allJobs;
      if (!filtered.length) {
        return statusFilter
          ? 'No jobs with status "' + statusFilter + '".'
          : 'No jobs in the system.';
      }

      // Portfolio totals across the filtered set.
      const totals = filtered.reduce((acc, j) => {
        acc.contract += j.wip.totalIncome;
        acc.estCosts += j.wip.revisedEstCosts;
        acc.actualCosts += j.wip.actualCosts;
        acc.revenueEarned += j.wip.revenueEarned;
        acc.invoiced += j.wip.invoiced;
        acc.unbilled += j.wip.unbilled;
        acc.backlog += j.wip.backlog;
        return acc;
      }, { contract: 0, estCosts: 0, actualCosts: 0, revenueEarned: 0, invoiced: 0, unbilled: 0, backlog: 0 });
      const portfolioMargin = totals.revenueEarned > 0
        ? ((totals.revenueEarned - totals.actualCosts) / totals.revenueEarned * 100)
        : 0;

      // Margin red flags — jobs where JTD margin is below target (or
      // below 15% if no target set) AND they have meaningful revenue
      // earned. Helps 86 surface the "anything looks off" answer.
      const redFlags = filtered.filter(j => {
        const target = j.targetMarginPct != null ? j.targetMarginPct : 15;
        return j.wip.revenueEarned > 1000 && j.wip.jtdMargin < target;
      }).sort((a, b) => a.wip.jtdMargin - b.wip.jtdMargin).slice(0, 5);

      // Sort the per-job list.
      const sortKey = {
        backlog: j => j.wip.backlog,
        contract: j => j.wip.totalIncome,
        margin: j => -j.wip.jtdMargin, // worst first (negative so descending sort surfaces worst)
        pct_complete: j => j.wip.pctComplete
      }[sortBy];
      const sorted = filtered.slice().sort((a, b) => sortKey(b) - sortKey(a));
      const top = sorted.slice(0, limit);

      // Format. Use $ formatter from local fmtMoney equivalent.
      function $(n) {
        const sign = n < 0 ? '-' : '';
        const abs = Math.abs(Math.round(Number(n) || 0));
        return sign + '$' + abs.toLocaleString('en-US');
      }
      function pctFmt(n) { return (Number(n) || 0).toFixed(1) + '%'; }

      const out = [];
      out.push('## WIP ROLL-UP' + (statusFilter ? ' (status: ' + statusFilter + ')' : '') + ' — ' + filtered.length + ' job' + (filtered.length === 1 ? '' : 's'));
      out.push('');
      out.push('### Portfolio totals');
      out.push('- Contract value (incl. COs): **' + $(totals.contract) + '**');
      out.push('- Estimated costs (revised): ' + $(totals.estCosts));
      out.push('- Actual costs JTD: ' + $(totals.actualCosts));
      out.push('- Revenue earned JTD: ' + $(totals.revenueEarned));
      out.push('- Invoiced JTD: ' + $(totals.invoiced));
      out.push('- Unbilled (earned not invoiced): ' + $(totals.unbilled));
      out.push('- Remaining backlog: **' + $(totals.backlog) + '**');
      out.push('- Portfolio JTD margin: **' + pctFmt(portfolioMargin) + '**');
      out.push('');

      if (redFlags.length) {
        out.push('### Margin red flags (JTD margin below target, sorted worst-first)');
        redFlags.forEach(j => {
          const target = j.targetMarginPct != null ? j.targetMarginPct : 15;
          out.push('- ' + (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + j.title +
            (j.client ? ' (' + j.client + ')' : '') +
            ' — JTD margin ' + pctFmt(j.wip.jtdMargin) + ' vs target ' + pctFmt(target) +
            ' · revenue earned ' + $(j.wip.revenueEarned));
        });
        out.push('');
      }

      out.push('### Top ' + top.length + ' job' + (top.length === 1 ? '' : 's') + ' by ' + sortBy + (sortBy === 'margin' ? ' (worst first)' : ' (descending)'));
      top.forEach(j => {
        out.push('- ' + (j.jobNumber ? '[' + j.jobNumber + '] ' : '') + j.title +
          (j.client ? ' (' + j.client + ')' : '') +
          (j.status ? ' · ' + j.status : '') +
          (j.pm ? ' · PM ' + j.pm : ''));
        out.push('    contract ' + $(j.wip.totalIncome) +
          ' · pct ' + pctFmt(j.wip.pctComplete) +
          ' · earned ' + $(j.wip.revenueEarned) +
          ' · costs ' + $(j.wip.actualCosts) +
          ' · margin ' + pctFmt(j.wip.jtdMargin) +
          ' · backlog ' + $(j.wip.backlog));
      });

      return out.join('\n');
    }
    case 'read_users': {
      const q = String(input.q || '').trim().toLowerCase();
      const role = String(input.role || '').trim();
      const activeOnly = input.active_only !== false; // default true
      const limit = Math.max(1, Math.min(100, parseInt(input.limit, 10) || 30));
      const where = [];
      const args = [];
      let n = 1;
      if (activeOnly) where.push('active = TRUE');
      if (role) { where.push('role = $' + (n++)); args.push(role); }
      const sql =
        'SELECT id, name, email, role, active, last_seen_at FROM users ' +
        (where.length ? 'WHERE ' + where.join(' AND ') + ' ' : '') +
        'ORDER BY name ASC LIMIT 200';
      const r = await pool.query(sql, args);
      let rows = r.rows;
      if (q) {
        rows = rows.filter(u =>
          (String(u.name || '').toLowerCase().indexOf(q) !== -1) ||
          (String(u.email || '').toLowerCase().indexOf(q) !== -1)
        );
      }
      rows = rows.slice(0, limit);
      if (!rows.length) return 'No users match the filters.';
      return rows.map(u =>
        '• ' + (u.name || '(unnamed)') + ' (' + (u.email || 'no email') + ')' +
        ' · role=' + (u.role || 'unknown') +
        (u.active ? ' · active' : ' · INACTIVE') +
        (u.last_seen_at ? ' · last seen ' + u.last_seen_at.toISOString().slice(0, 10) : '')
      ).join('\n');
    }
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// Wrapper that adds context (userId, storage) for tools that need it
// (attach_business_card_to_client, add_client_note). Falls through to
// the stateless executor for everything else.
async function execClientDirectoryToolWithCtx(name, input, ctx) {
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
    return execClientDirectoryTool(name, input);
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
  const t = ClientDirectoryTools.find(t => t.name === name);
  return !!(t && t.tier === 'auto');
}

// Build the directory snapshot Claude reads as context. Capped per
// parent so a huge directory doesn't blow the prompt window.
async function buildClientDirectoryContext(organization) {
  const { rows } = await pool.query(
    `SELECT id, name, short_name, parent_client_id, client_type, company_name, community_name,
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

  // Build the directory-surface prompt as two blocks like 86 elsewhere:
  // stable playbook (cached prefix) + dynamic directory snapshot
  // (refreshed each turn).
  const stable = [];
  const out = []; // dynamic directory snapshot
  stable.push('You are 86, Project 86\'s operator, working in Client Directory mode — keeping the customer directory clean, accurate, and properly structured. You understand the property-management industry in Central Florida and you take pride in a tidy, hierarchical, dedupe-clean directory.');
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

  // Skill packs — manifest only. 86 can call load_skill_pack({name})
  // to pull a body on demand. The `alwaysOn` flag is no longer
  // consulted at runtime.
  // Skill packs ship as native Anthropic Skills registered on the
  // agent — the runtime auto-discovers them by description each turn.

  out.push('# Directory snapshot (' + rows.length + ' clients)');
  out.push('');

  // Pre-existing agent notes — short list of every client that has at
  // least one note, with their notes inline. Lets 86 reference them
  // when proposing changes ("PAC has a 15% materials note from before, do
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
    const parentBits = [];
    if (p.short_name) parentBits.push('short=' + p.short_name);
    if (p.market) parentBits.push(p.market);
    out.push(`- **${p.name}** (id=${p.id})${parentBits.length ? ' — ' + parentBits.join(' · ') : ''}`);
    for (const k of kids) {
      const bits = [];
      if (k.short_name) bits.push('short=' + k.short_name);
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
      if (f.short_name) bits.push('short=' + f.short_name);
      if (f.company_name && f.company_name !== f.name) bits.push('company_name=' + f.company_name);
      if (f.community_name && f.community_name !== f.name) bits.push('community=' + f.community_name);
      if (f.community_manager) bits.push('CAM: ' + f.community_manager);
      if (f.city) bits.push(f.city + (f.state ? ', ' + f.state : ''));
      out.push(`- ${f.name} (id=${f.id})${bits.length ? ' — ' + bits.join(' · ') : ''}`);
    }
  }

  // Reference sheets (job numbers, client short names, WIP report)
  // are now baked into the registered agent system prompt via
  // composedAgentSystem — the per-turn injection that used to live
  // here was double-billing those tokens on every directory-surface turn.

  return {
    system: [
      { type: 'text', text: stable.join('\n'), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n' + out.join('\n') }
    ],
    totalClients: rows.length,
    packsLoaded: []
  };
}

// /clients/chat + /clients/chat/continue stubs removed — already
// caught by the LEGACY_CHAT_PATHS 410 intercept at the top of this file.

// ══════════════════════════════════════════════════════════════════════
// Chief of Staff agent
// ══════════════════════════════════════════════════════════════════════
// A meta-agent that observes 86 across all its surfaces (estimate,
// job, intake, ask, directory), reads its metrics + recent
// conversations, and (in later versions) proposes skill-pack
// improvements based on observed failure patterns or recurring user
// requests.
//
// V1 is read-only — only auto-tier read tools, no proposes. The user
// asks "how is 86 doing this week?" or "what does the directory
// surface usually search for?" and the agent answers by calling read
// tools and synthesizing.
//
// Reuses the same ai_messages table for history, partitioned by
// entity_type='staff'. Like the directory surface, there's no entity_id — the agent is
// global, scoped per user. estimate_id stores the literal sentinel
// 'global'.
// ══════════════════════════════════════════════════════════════════════

const STAFF_TOOLS = [
  {
    name: 'read_metrics',
    tier: 'auto',
    description:
      'Read aggregate AI usage metrics for the requested window. Returns per-surface (86/estimate, 86/job, 86/intake, 86/ask, 86/directory) totals: turns, conversations, unique users, tool uses, photos attached, tokens in/out, model mix, and estimated cost in USD. Use this to answer "how much is 86 being used?", "what does 86 cost us?", "is anyone using the directory surface?" types of questions.',
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
      'List recent AI-agent conversations. Each row is a (entity, user) pair with turn count, tool uses, tokens, cost, and last activity. Use this to spot patterns ("which estimates does 86 get used on most?"), audit usage ("did anyone burn 100K tokens this week?"), or pick a conversation to drill into via read_conversation_detail.',
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
      'Read every message of a specific conversation. Pass the `key` from read_recent_conversations (entity_type|entity_id|user_id, joined with pipes). Returns user + assistant turns with role, model, token usage, content (capped at 16KB per message). Use this to investigate a specific case — "show me what 86 did on the Solace Tampa estimate", "find out why this conversation used so many tools".',
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
      'List the admin-editable skill packs that 86 loads at chat time. Each pack has a name, body (instructions), agent assignments (which surface — "job" for 86 generally, "cra" for the directory surface — load it), and an alwaysOn flag. Use this to recommend new skills, audit existing ones for staleness, or answer "what context does 86 always see?".',
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
      'Search Project 86\'s materials catalog (real purchase history from Home Depot + other vendors). Same tool 86 uses for pricing line items. Use it to answer "do we have a price book?", "what does Project 86 typically pay for X?", or to audit whether 86\'s recent quotes are using catalog data or guessing.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        q: { type: 'string', description: 'Free-text search across description / SKU. Trade words: "PT pickets", "Hardie lap siding", "5/4 deck board".' },
        subgroup: { type: 'string', enum: ['materials', 'labor', 'gc', 'sub'], description: 'Filter to one Project 86 subgroup. Default: all.' },
        category: { type: 'string', description: 'Filter to one Project 86 category, e.g. "Lumber & Decking", "Paint", "Fasteners".' },
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
    description: 'Query Project 86\'s subcontractor directory. Returns name, trade, status, cert (GL / WC / W9 / Bank) expiration dates, contacts. Use to audit cert health, list subs in a trade, or check if a named sub is active.',
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
    description: 'Query the Project 86 leads pipeline. Returns titles, statuses, projected revenue, salespeople, markets, ages. Use to characterize sales activity, find lead clusters by source/market, or audit pipeline health.',
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
      'Propose creating a new admin-editable skill pack. Skill packs are situational instruction blocks that, once approved, are mirrored to Anthropic native Skills and auto-discovered by the runtime when the description matches the current turn. Only call this AFTER read_skill_packs to confirm no name collision. ' +
      'Approval-required so the user vets the wording before it lands.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name: { type: 'string', description: 'Short, unique title (e.g., "Trex decking spec reference"). Must not collide with an existing pack.' },
        body: { type: 'string', description: 'The skill content. Markdown allowed. The body is registered as a native Anthropic Skill and surfaced by the runtime when the description matches — write it as standalone guidance for the moment it activates.' },
        agents: { type: 'array', items: { type: 'string', enum: ['cra', 'job'] }, description: 'Which surface sees this pack in its manifest. "job" for 86 generally, "cra" for the client-directory surface.' },
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
        agents: { type: 'array', items: { type: 'string', enum: ['cra', 'job'] }, description: 'Optional updated surface assignment. job=86, cra=86 directory surface.' },
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
  },
];

// Phase 3 (RETIRED) — subtask fan-out has been removed. Native
// parallel tool calls within a single session cover the same use
// cases (parallel reads, parallel proposals) without the extra
// cache_creation hit each child session costs. The ai_subtasks
// table is kept for historical rollups but is no longer written.
const SUBTASK_TOOLS = [];

// Phase 4 — long-term semantic memory tools.
//
// 86 saves cross-session facts via remember(), pulls them back with
// recall(). Scoped per-tenant: a memory saved in AGX never leaks to
// another org. Within a tenant, scope='user' is private to the user
// who saved it; scope='org' is shared across all users in the org
// (useful for "the company standardized on PT 2x4s for porch framing").
//
// Auto-tier — same as subtask tools, no approval card. The user is
// already opting in by talking to 86; making them approve every save
// would feel adversarial.
const MEMORY_TOOLS = [
  {
    name: 'remember',
    tier: 'auto',
    description:
      'Save a cross-session memory so you can recall it on future turns and future days. Use when the user states a preference ("always show margin as percent"), a per-client quirk ("Solace Tampa has a 4pm delivery cutoff"), a decision ("we standardized on PT 2x4s for porch framing"), or any other fact that should outlive the current conversation. Topic is the short retrieval key — pick something specific you would later search for. Body is the full content. If the same topic exists, it is OVERWRITTEN — use this to update stale memories rather than stacking near-duplicates.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        topic:      { type: 'string', description: 'Short retrieval key (e.g. "estimate-format-pref", "Solace-Tampa-gate-rules"). Lowercase, hyphenated, descriptive. Max 100 chars.' },
        body:       { type: 'string', description: 'The actual memory content. 1-3 sentences ideal. Max 2000 chars.' },
        kind:       { type: 'string', enum: ['preference', 'fact', 'decision', 'context'], description: 'Category. Default: fact.' },
        scope:      { type: 'string', enum: ['user', 'org'], description: '"user" (private to this user) or "org" (every user in the org sees it). Default: user.' },
        importance: { type: 'integer', minimum: 1, maximum: 10, description: 'How load-bearing this memory is. 1-3 = nice-to-have, 4-7 = useful, 8-10 = critical to operations. Default 5.' }
      },
      required: ['topic', 'body']
    }
  },
  {
    name: 'recall',
    tier: 'auto',
    description:
      'Search saved memories by keyword. Returns matching memories with topic, body, kind, importance, and when they were last recalled. Use BEFORE answering a question that might benefit from prior context — e.g. before drafting an estimate, recall "estimate-format" or the client name. Searches both topic and body; topic matches rank higher. Pulls from this user\'s private memories AND org-wide memories visible to them.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Keywords or phrase to search for. Searches topic + body. Min 2 chars.' },
        limit: { type: 'integer', minimum: 1, maximum: 20, description: 'Max memories to return. Default 5.' }
      },
      required: ['query']
    }
  },
  {
    name: 'list_memories',
    tier: 'auto',
    description:
      'List recent saved memories (most recent first) so you can audit what you remember without having to recall a specific topic. Useful for "what do you remember about X?" or for periodic review. Returns id, topic, kind, importance, and a snippet of the body.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind:  { type: 'string', enum: ['preference', 'fact', 'decision', 'context'], description: 'Filter to one kind.' },
        scope: { type: 'string', enum: ['user', 'org', 'all'], description: 'Filter by scope. Default "all".' },
        limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Max rows. Default 20.' }
      },
      required: []
    }
  },
  {
    name: 'forget',
    tier: 'auto',
    description:
      'Archive a memory so it no longer surfaces on recall. Pass either id (from list_memories / recall) or topic. Soft delete — the row stays in the DB for audit but is excluded from search. Use when the user says "forget that" or when a memory becomes stale (e.g. a decision was reversed).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id:    { type: 'string', description: 'Memory id (preferred — unambiguous).' },
        topic: { type: 'string', description: 'Topic key (used only when id is omitted; archives the user\'s memory at that topic).' }
      },
      required: []
    }
  }
];

// Phase 5 — proactive watching tools. Watches are recurring 86
// instructions that fire on a cadence (hourly / daily / weekly).
// Each fire creates a fresh Anthropic session and runs the watch's
// prompt to completion; results are stored in ai_watch_runs for
// later review.
//
// propose_watch_create is approval-tier because each watch becomes
// recurring API spend — the user should explicitly opt in via the
// chat approval card. Reads are auto-tier.
const WATCH_TOOLS = [
  {
    name: 'propose_watch_create',
    tier: 'approval',
    description:
      'Set up a recurring instruction that you (86) will run on a schedule, without the user prompting you. Use for periodic audits / reviews ("every day at 6am, summarize yesterday\'s estimate activity"), proactive alerts ("every Monday at 9am, list any active jobs with margin under 18%"), or follow-up nudges. Each fire spends API tokens — propose conservative cadences. The user must approve this card before the watch starts running.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        name:            { type: 'string', description: 'Short label shown in the watches list (e.g. "Daily margin scan"). Max 100 chars.' },
        description:     { type: 'string', description: 'One-sentence explanation of what this watch does and why. Shown to admins reviewing recurring spend.' },
        cadence:         { type: 'string', enum: ['hourly', 'daily', 'weekly'], description: 'How often it fires.' },
        time_of_day_utc: { type: 'string', description: 'HH:MM UTC for daily/weekly fires (ignored for hourly). Default 03:00 UTC.' },
        prompt:          { type: 'string', description: 'The instruction to run on each fire. Treat like briefing a fresh teammate — include every detail; the runner does NOT see the conversation it was created in.' }
      },
      required: ['name', 'cadence', 'prompt']
    }
  },
  {
    name: 'list_watches',
    tier: 'auto',
    description:
      'List currently active watches with their cadence, last fire, next fire, and whether they are enabled. Use to answer "what am I watching?" or before proposing a new watch (so we don\'t stack duplicates).',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_archived: { type: 'boolean', description: 'Include archived watches. Default false.' }
      },
      required: []
    }
  },
  {
    name: 'read_recent_watch_runs',
    tier: 'auto',
    description:
      'Read the most recent watch fires (across all watches in this org). Each row has the watch name, status, triggered_at, duration, tokens, and the result text. Use this for "what did your watches find this week?" or to debug a failing watch.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        watch_id: { type: 'string', description: 'Limit to one watch.' },
        limit:    { type: 'integer', minimum: 1, maximum: 50, description: 'Max runs to return. Default 10.' }
      },
      required: []
    }
  },
  {
    name: 'propose_watch_archive',
    tier: 'approval',
    description:
      'Disable and archive a watch so it stops firing. Soft delete — the row stays for audit. Use when the watch is no longer useful or when the user asks to stop a specific scheduled review.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        id:        { type: 'string', description: 'Watch id from list_watches.' },
        rationale: { type: 'string', description: 'One short sentence explaining why this watch is being archived (shown on the approval card).' }
      },
      required: ['id', 'rationale']
    }
  }
];

// Build the SKILL.md body for one local pack. Mirrors the helper of
// the same name in admin-agents-routes.js so CoS-driven mirrors and
// admin-button mirrors produce byte-identical uploads.
function slugifyMirrorName(s) {
  return String(s || 'skill')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || 'skill';
}

function buildSkillMarkdownForMirror(pack) {
  const slug = slugifyMirrorName(pack.name);
  const human = (pack.name || 'Project 86 skill').replace(/[\r\n]/g, ' ');
  const desc = (pack.replaces_section
    ? 'Section override for ' + pack.replaces_section
    : (pack.category ? 'Category: ' + pack.category : human)
  ).replace(/[\r\n]/g, ' ');
  return [
    '---',
    'name: ' + slug,
    'description: ' + desc,
    '---',
    '',
    pack.body || ''
  ].join('\n');
}

function isStaffToolAutoTier(name) {
  const t = STAFF_TOOLS.find(t => t.name === name);
  return !!(t && t.tier === 'auto');
}

// Build the chief-of-staff system prompt. Stable identity + role +
// tools rolled into one cached block; a slim live snapshot of the
// current week as a second block (refreshed each turn).
async function buildStaffContext() {
  const stable = [];
  stable.push('You are the Chief of Staff for Project 86\'s in-app AI — a single agent named 86 that runs every surface (estimating, WIP, intake, ask, client directory). Your user is the Project 86 admin / owner. Your job is to observe how 86 is being used across those surfaces, surface trends and anomalies, audit specific conversations on request, and propose skill-pack improvements based on what you see.');
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
  stable.push('  • `read_materials(q?, subgroup?, category?, limit?)` — query Project 86\'s materials catalog (Home Depot purchase history, etc.). Same tool 86 uses for line-item pricing. Use it to answer "do we have a price book?", spot patterns in what 86 should be searching, or audit whether 86 quotes are catalog-backed.');
  stable.push('  • `read_purchase_history(material_id?, q?, days?, job_name?, limit?)` — receipt-level material purchase rows. Use to spot pricing trends, find jobs that used a SKU, or audit whether 86\'s quoted prices match what Project 86 actually paid recently.');
  stable.push('  • `read_subs(q?, trade?, status?, with_expiring_certs?, limit?)` — subcontractor directory with cert expiry. Use to surface paperwork-expiring subs, list subs by trade, or confirm a named sub is active. with_expiring_certs=true for compliance audits.');
  stable.push('  • `read_lead_pipeline(q?, status?, market?, salesperson_email?, limit?)` — leads list + always-included status rollup ($ counts per status). Use for "what does our pipeline look like?", spotting deal-source patterns, or seeing which markets are hot.');
  stable.push('Propose tools (approval-required — user clicks Approve/Reject on a card):');
  stable.push('  • `propose_skill_pack_add(name, body, agents, rationale)` — add a new skill pack. On approval the pack is auto-mirrored to Anthropic native Skills; the agent auto-discovers it by description on the next sync. agents=["cra","job"].');
  stable.push('  • `propose_skill_pack_edit(name, new_name?, new_body?, agents?, rationale)` — change an existing pack. body edits replace the whole body.');
  stable.push('  • `propose_skill_pack_delete(name, rationale)` — remove a pack entirely (also deletes the Anthropic-side mirror).');
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
      const labelMap = { estimate: '86 (estimate)', job: '86 (job)', client: '86 (directory)', staff: 'Chief of Staff (you)' };
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
async function execStaffTool(name, input, ctx) {
  // ctx is optional — currently only self_diagnose uses ctx.userId
  // (it needs to scope the introspection to the calling user). Other
  // tools ignore it. Callers that have a user handy should pass
  // { userId } so future tools can opt in without signature churn.
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
      const labels = { estimate: '86 (estimate)', job: '86 (job/WIP)', client: '86 (directory)' };
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
                tool_use_count, tool_uses, photos_included, created_at
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
        // Surface tool_uses metadata so introspection can see what
        // was proposed/approved on each turn. Without this the
        // conversation looks like prose-only and 86 can't answer
        // "did my line item proposal land?".
        if (Array.isArray(m.tool_uses) && m.tool_uses.length) {
          out.push('  [tool_uses]');
          for (const t of m.tool_uses) {
            if (!t || typeof t !== 'object') continue;
            const inputStr = t.input ? JSON.stringify(t.input).slice(0, 400) : '';
            const approvedFlag = (t.approved === true) ? ' ✓approved'
                              : (t.approved === false) ? ' ✗rejected'
                              : '';
            const summaryStr = t.applied_summary ? ' — ' + String(t.applied_summary).slice(0, 200)
                              : (t.reject_reason ? ' — rejected: ' + String(t.reject_reason).slice(0, 200) : '');
            out.push('    • ' + (t.name || '(unnamed)') + approvedFlag + summaryStr + (inputStr ? '\n      input: ' + inputStr : ''));
          }
        }
      }
      return out.join('\n\n');
    }

    case 'read_active_lines': {
      const estimateId = String((input && input.estimate_id) || '').trim();
      const sectionId = String((input && input.section_id) || '').trim();
      const limit = Math.max(1, Math.min(500, Number(input && input.limit) || 200));
      if (!estimateId) {
        return 'read_active_lines: estimate_id is required. (turn_context shows the id at the top of the estimate block.)';
      }
      const e = await pool.query(`SELECT data FROM estimates WHERE id = $1`, [estimateId]);
      if (!e.rows.length) return 'No estimate with id ' + estimateId + '.';
      const blob = e.rows[0].data || {};
      const allLines = Array.isArray(blob.lines) ? blob.lines : [];
      const alternates = Array.isArray(blob.alternates) ? blob.alternates : [];
      const activeAlt = alternates.find(a => a.id === blob.activeAlternateId) || alternates[0] || null;
      let activeLines = activeAlt ? allLines.filter(l => l.alternateId === activeAlt.id) : allLines;
      if (sectionId) {
        // Find the section header and the cost-side lines that follow it,
        // up to the next section header. Walk in declared order.
        const out = [];
        let inTarget = false;
        for (const l of activeLines) {
          if (l.section === '__section_header__') {
            if (inTarget) break; // hit next header — stop
            if (l.id === sectionId) {
              inTarget = true;
              out.push(l);
            }
            continue;
          }
          if (inTarget) out.push(l);
        }
        activeLines = out;
        if (!activeLines.length) return 'No subgroup with id ' + sectionId + ' in the active group of estimate ' + estimateId + '.';
      }
      const groupDefaultMarkup = (blob.defaultMarkup != null && blob.defaultMarkup !== '') ? parseFloat(blob.defaultMarkup) : 0;
      const out = [];
      const altLabel = activeAlt ? (activeAlt.name || activeAlt.id) : '(no active alternate)';
      out.push('# Active-group lines on ' + estimateId + ' (group: ' + altLabel + ')');
      out.push('');
      let currentMarkup = groupDefaultMarkup;
      let lineNum = 0;
      let shown = 0;
      for (const l of activeLines) {
        if (shown >= limit) {
          out.push('[…truncated at ' + limit + ' rows. Re-call with section_id or a smaller scope.]');
          break;
        }
        if (l.section === '__section_header__') {
          const m = (l.markup === '' || l.markup == null) ? groupDefaultMarkup : parseFloat(l.markup);
          currentMarkup = m;
          lineNum = 0;
          out.push('### ' + (l.description || 'subgroup') + ' (subgroup_id=' + l.id + ', markup ' + m + '%)');
          shown++;
        } else {
          lineNum++;
          const qty = parseFloat(l.qty) || 0;
          const unit = l.unit || 'ea';
          const cost = parseFloat(l.unitCost) || 0;
          const ext = qty * cost;
          const mk = (l.markup === '' || l.markup == null) ? currentMarkup : parseFloat(l.markup);
          const mkNote = (l.markup === '' || l.markup == null) ? '' : ' [overrides subgroup]';
          out.push(lineNum + '. ' + (l.description || '(no description)') +
            ' — qty ' + qty + ' ' + unit + ' @ $' + cost.toFixed(2) +
            ' = $' + ext.toFixed(2) + '; markup ' + mk + '%' + mkNote +
            ' [line_id=' + l.id + ']');
          shown++;
        }
      }
      return out.join('\n');
    }

    case 'read_attachment_text': {
      const attachmentId = String((input && input.attachment_id) || '').trim();
      const maxChars = Math.max(500, Math.min(200000, Number(input && input.max_chars) || 60000));
      if (!attachmentId) return 'read_attachment_text: attachment_id is required.';
      const r = await pool.query(
        `SELECT id, filename, entity_type, mime_type, size_bytes, extracted_text
           FROM attachments WHERE id = $1`,
        [attachmentId]
      );
      if (!r.rows.length) return 'No attachment with id ' + attachmentId + '.';
      const row = r.rows[0];
      const txt = row.extracted_text || '';
      if (!txt) {
        return 'Attachment "' + (row.filename || attachmentId) + '" (' + (row.mime_type || 'unknown') +
          ') has no extracted text on file. ' +
          'If this is a scanned PDF or image-only doc, ask the user to click "Ask AI" from the PDF viewer to attach page renders this turn.';
      }
      const head = '# ' + (row.filename || attachmentId) +
        ' [' + row.entity_type + ', id=' + row.id + ', ' + txt.length + ' chars total]\n\n';
      if (txt.length <= maxChars) return head + txt;
      return head + txt.slice(0, maxChars) +
        '\n\n[…truncated. ' + (txt.length - maxChars) + ' more chars. ' +
        'Call read_attachment_text again with a larger max_chars or a smaller chunk if you need the rest.]';
    }

    case 'view_attachment_image': {
      // Pull the pixels of one attached image as a vision content
      // block. Returns a STRUCTURED result (object with `blocks`) so
      // make86OnCustomToolUse / runV2SessionStream can forward it as
      // tool_result content with image + text blocks instead of the
      // default plain-text result. See the runV2SessionStream branch
      // that consumes `decision.blocks` for the wire format.
      const attachmentId = String((input && input.attachment_id) || '').trim();
      if (!attachmentId) return 'view_attachment_image: attachment_id is required.';
      const r = await pool.query(
        `SELECT id, filename, entity_type, entity_id, mime_type, size_bytes,
                web_key, anthropic_file_id
           FROM attachments WHERE id = $1`,
        [attachmentId]
      );
      if (!r.rows.length) return 'No attachment with id ' + attachmentId + '.';
      const row = r.rows[0];
      if (!row.mime_type || !row.mime_type.startsWith('image/')) {
        return 'Attachment "' + (row.filename || attachmentId) + '" is not an image (mime=' +
          (row.mime_type || 'unknown') + '). Use read_attachment_text for documents.';
      }
      try {
        const imgBlock = await loadPhotoAsBlock(row);
        if (!imgBlock) {
          return 'Could not load image bytes for ' + attachmentId + ' — the underlying file may be missing or unreadable.';
        }
        const sizeKb = row.size_bytes ? Math.round(row.size_bytes / 1024) + ' KB' : '?';
        return {
          blocks: [
            imgBlock,
            { type: 'text', text: 'Image: ' + (row.filename || attachmentId) + ' (' + row.entity_type + ', ' + sizeKb + ')' }
          ]
        };
      } catch (e) {
        return 'Failed to load image ' + attachmentId + ': ' + (e && e.message || 'unknown');
      }
    }

    case 'search_reference_sheet': {
      // Live reference workbook search — Job Numbers, Client Short
      // Names, etc. The sheet rows are stored as one big text blob
      // in agent_reference_links.last_fetched_text (markdown table /
      // newline-delimited rows depending on the SharePoint renderer).
      // We do a per-line substring scan because the volumes are
      // small (hundreds of rows per sheet) and a real FTS index
      // would be overkill.
      //
      // Phase D made the table org-scoped. The user calling 86 has
      // a JWT-resolved userId on ctx; resolve their org and filter
      // so 86 only sees its own tenant's reference sheets.
      const userId = ctx && ctx.userId;
      if (!userId) return 'search_reference_sheet: no user context — cannot scope to organization.';
      const orgRow = await pool.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
      const orgId = orgRow.rows[0] && orgRow.rows[0].organization_id;
      if (!orgId) return 'search_reference_sheet: user is not associated with an organization.';

      const q = String((input && input.query) || '').trim();
      const sheetTitleFilter = String((input && input.sheet_title) || '').trim().toLowerCase();
      const limit = Math.min(50, Math.max(1, parseInt((input && input.limit), 10) || 20));

      const sql =
        "SELECT title, description, last_fetched_text, last_fetched_row_count, inject_mode " +
        "FROM agent_reference_links " +
        "WHERE organization_id = $1 AND enabled = TRUE AND last_fetch_status = 'ok' AND last_fetched_text IS NOT NULL " +
        "ORDER BY created_at ASC";
      const r = await pool.query(sql, [orgId]);
      if (!r.rows.length) {
        return 'No reference sheets configured. Admin can wire one up under Admin → Agents → Reference Links.';
      }

      // No query → list available sheets.
      if (!q) {
        const lines = ['Reference sheets available (' + r.rows.length + '):'];
        for (const row of r.rows) {
          lines.push('• "' + row.title + '" — ' + (row.last_fetched_row_count || '?') + ' rows · mode=' + row.inject_mode +
            (row.description ? '\n    ' + row.description : ''));
        }
        lines.push('');
        lines.push('Call search_reference_sheet({query: "..."}) to find rows. Add sheet_title to restrict to one sheet.');
        return lines.join('\n');
      }

      // Query path — per-line substring scan across every (optionally one) sheet.
      const needle = q.toLowerCase();
      const out = [];
      let totalMatches = 0;
      for (const row of r.rows) {
        if (sheetTitleFilter && row.title.toLowerCase() !== sheetTitleFilter) continue;
        const body = String(row.last_fetched_text || '');
        if (!body) continue;
        const lines = body.split('\n');
        const hits = [];
        for (const line of lines) {
          if (!line.trim()) continue;
          if (line.toLowerCase().indexOf(needle) >= 0) {
            hits.push(line.trim());
            if (hits.length >= limit) break;
          }
        }
        if (hits.length) {
          totalMatches += hits.length;
          out.push('## ' + row.title + ' (' + hits.length + ' match' + (hits.length === 1 ? '' : 'es') + ')');
          out.push(...hits.map(h => '  ' + h));
          out.push('');
        }
      }
      if (!totalMatches) {
        const scopeNote = sheetTitleFilter ? ' in sheet "' + sheetTitleFilter + '"' : '';
        return 'No rows matching "' + q + '"' + scopeNote + '. Try a shorter substring or call with no args to see the available sheets.';
      }
      return out.join('\n');
    }

    case 'self_diagnose': {
      // Pull recent assistant turns where tool_uses were emitted, plus
      // any /chat/continue approval traces. Stitches them into a
      // chronological narrative the model can introspect. When an
      // estimate_id is supplied (or recovered from a recent estimate-
      // side proposal), also reports the current estimate state so the
      // model can answer "did the line actually land?".
      const windowMinutes = Math.max(5, Math.min(1440, Number(input && input.window_minutes) || 60));
      const userId = ctx && ctx.userId; // injected by /api/ai/exec-tool
      if (!userId) return 'self_diagnose requires a user context (call from a /api/ai/exec-tool route).';

      // Recent turns with tool_uses OR approval traces, plus matching
      // user messages so the model sees what was asked.
      const rowsR = await pool.query(
        `SELECT id, role, content, created_at, tool_uses, tool_use_count, entity_type, estimate_id
           FROM ai_messages
          WHERE user_id = $1
            AND entity_type = '86'
            AND created_at >= NOW() - ($2::int || ' minutes')::interval
          ORDER BY created_at ASC`,
        [userId, windowMinutes]
      );
      if (!rowsR.rows.length) {
        return 'No 86-side activity in the last ' + windowMinutes + ' minutes for this user.';
      }

      // If the caller didn't pin an estimate_id, recover the most-recent
      // one any tool_use referenced (estimate-side proposals carry no
      // explicit estimate_id in input — the editor's _currentId is
      // implicit — so we fall back to the parameter or the dialed-in
      // window's last estimate-mentioning user message).
      let targetEstimateId = (input && typeof input.estimate_id === 'string')
        ? input.estimate_id.trim()
        : '';
      if (!targetEstimateId) {
        for (let i = rowsR.rows.length - 1; i >= 0; i--) {
          const m = rowsR.rows[i];
          const inText = String(m.content || '');
          const mm = inText.match(/\b(e\d{10,})\b/);
          if (mm) { targetEstimateId = mm[1]; break; }
        }
      }

      // Build the narrative lines.
      const out = [];
      out.push('# Self-diagnosis — last ' + windowMinutes + 'min of 86 activity');
      out.push('');
      let proposedCount = 0, approvedCount = 0, rejectedCount = 0;

      for (const m of rowsR.rows) {
        const ts = new Date(m.created_at).toISOString().replace('T', ' ').slice(0, 19);
        const prefix = '[' + ts + '] ' + m.role.toUpperCase();
        const body = String(m.content || '');
        if (m.role === 'user' && !Array.isArray(m.tool_uses)) {
          out.push(prefix + ': ' + body.slice(0, 200));
          continue;
        }
        if (m.role === 'user' && Array.isArray(m.tool_uses)) {
          // approval trace row from /86/chat/continue
          for (const t of m.tool_uses) {
            if (!t) continue;
            if (t.approved) approvedCount++; else rejectedCount++;
            out.push(prefix + ' [approval] ' + (t.approved ? '✓' : '✗') + ' '
              + (t.name || '?')
              + (t.applied_summary ? ' — ' + String(t.applied_summary).slice(0, 160) : '')
              + (t.reject_reason ? ' — rejected: ' + String(t.reject_reason).slice(0, 160) : ''));
          }
          continue;
        }
        // assistant row
        if (body) out.push(prefix + ': ' + body.slice(0, 250));
        if (Array.isArray(m.tool_uses) && m.tool_uses.length) {
          for (const t of m.tool_uses) {
            if (!t || !t.name) continue;
            proposedCount++;
            const inputStr = t.input ? JSON.stringify(t.input).slice(0, 250) : '';
            out.push('    → proposed ' + t.name + (inputStr ? ' ' + inputStr : ''));
          }
        }
      }

      out.push('');
      out.push('## Tally');
      out.push('  proposed tool_uses: ' + proposedCount);
      out.push('  approved on /chat/continue: ' + approvedCount);
      out.push('  rejected on /chat/continue: ' + rejectedCount);
      const orphaned = proposedCount - approvedCount - rejectedCount;
      if (orphaned > 0) {
        out.push('  ⚠ orphaned (proposed but no /chat/continue trace): ' + orphaned);
        out.push('    These are tool_uses where the user never clicked Approve or Reject — either the panel');
        out.push('    swallowed an error in applyTool, the user navigated away, or the approval card never');
        out.push('    rendered. Inspect the panel JS console + check /86/chat/continue request logs.');
      }

      // Current estimate state — proves whether the change actually landed.
      if (targetEstimateId) {
        try {
          const e = await pool.query(`SELECT data FROM estimates WHERE id = $1`, [targetEstimateId]);
          if (!e.rows.length) {
            out.push('');
            out.push('## Estimate state (' + targetEstimateId + '): NOT FOUND in DB.');
          } else {
            const blob = e.rows[0].data || {};
            const lines = Array.isArray(blob.lines) ? blob.lines : [];
            const realLines = lines.filter(l => l.section !== '__section_header__');
            const sectionHeaders = lines.filter(l => l.section === '__section_header__');
            out.push('');
            out.push('## Estimate state (' + targetEstimateId + ')');
            out.push('  title: ' + (blob.title || '(untitled)'));
            out.push('  aiPhase: ' + (blob.aiPhase || 'build (default)'));
            out.push('  section headers: ' + sectionHeaders.length);
            out.push('  actual line items: ' + realLines.length);
            if (realLines.length) {
              out.push('  last 5 lines:');
              realLines.slice(-5).forEach(l => {
                out.push('    • ' + (l.description || '(no desc)') +
                  ' · qty=' + (l.qty == null ? '?' : l.qty) +
                  ' · clientPrice=' + (l.clientPrice == null ? '?' : l.clientPrice));
              });
            }
            // Cross-check: did any approved propose_add_line_item actually land?
            const proposedAdds = [];
            rowsR.rows.forEach(m => {
              if (!Array.isArray(m.tool_uses)) return;
              m.tool_uses.forEach(t => {
                if (!t || !t.name) return;
                if (t.name === 'propose_add_line_item') {
                  proposedAdds.push({ desc: (t.input && t.input.description) || null, when: m.created_at });
                }
              });
            });
            if (proposedAdds.length) {
              out.push('  proposed line-item adds in window:');
              const haveDescs = new Set(realLines.map(l => String(l.description || '').toLowerCase().trim()));
              proposedAdds.forEach(p => {
                const present = p.desc && haveDescs.has(String(p.desc).toLowerCase().trim());
                out.push('    ' + (present ? '✓ landed' : '✗ MISSING') + ' — "' + (p.desc || '?') + '"');
              });
            }
          }
        } catch (e) {
          out.push('');
          out.push('## Estimate lookup error: ' + (e.message || 'unknown'));
        }
      } else {
        out.push('');
        out.push('## Estimate state: not pinned — pass estimate_id or include "e<digits>" in conversation to verify changes landed.');
      }

      return out.join('\n');
    }

    case 'read_skill_packs': {
      // Phase 2d: reads from per-tenant org_skill_packs scoped to the
      // caller's org. The userId injected by /api/ai/exec-tool lets us
      // resolve the org without an explicit param.
      const userId = ctx && ctx.userId;
      const orgRow = userId
        ? (await pool.query('SELECT organization_id FROM users WHERE id = $1', [userId])).rows[0]
        : null;
      const orgId = orgRow && orgRow.organization_id;
      if (!orgId) return 'No organization scope — cannot read skill packs.';
      const r = await pool.query(
        `SELECT name, body, description, agents
           FROM org_skill_packs
          WHERE organization_id = $1 AND archived_at IS NULL
          ORDER BY id ASC`,
        [orgId]
      );
      if (!r.rows.length) return 'No skill packs configured.';
      const lines = ['Skill packs (' + r.rows.length + '):'];
      for (const s of r.rows) {
        const agents = Array.isArray(s.agents) ? s.agents.join(',') : '(none)';
        lines.push('• "' + (s.name || '(untitled)') + '" → agents=' + agents);
        const body = String(s.body || '');
        if (body) {
          lines.push('  ```');
          lines.push('  ' + (body.length > 600 ? body.slice(0, 600) + ' [...truncated — the full body is registered as a native Anthropic Skill and is auto-discovered by description]' : body).split('\n').join('\n  '));
          lines.push('  ```');
        }
      }
      return lines.join('\n');
    }

    case 'search_my_sessions': {
      // Cross-session memory: lets 86 reference work from prior chat
      // threads when the user invokes something he discussed before.
      // Scoped strictly to ctx.userId — the agent never sees another
      // user's history. Matches labels + summaries + message bodies
      // and returns short snippets so 86 can decide whether to follow
      // up with a more specific question or pull the user back into
      // the original session.
      const userId = ctx && ctx.userId;
      if (!userId) return 'No user context — cannot search sessions.';
      const q = String((input && input.query) || '').trim();
      if (!q) return 'query is required.';
      const limit = Math.min(30, Math.max(1, parseInt((input && input.limit), 10) || 10));
      const pattern = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';

      const meta = await pool.query(
        `SELECT s.id, s.label, s.summary, s.entity_type, s.entity_id,
                s.last_used_at, s.turn_count, NULL::text AS snippet
           FROM ai_sessions s
          WHERE s.user_id = $1
            AND s.archived_at IS NULL
            AND (s.label ILIKE $2 OR s.summary ILIKE $2)
          ORDER BY s.pinned DESC, s.last_used_at DESC
          LIMIT $3`,
        [userId, pattern, limit]
      );
      const msgs = await pool.query(
        `WITH matches AS (
           SELECT s.id AS session_id, s.label, s.summary, s.entity_type, s.entity_id,
                  s.last_used_at, s.turn_count, m.content AS snippet,
                  ROW_NUMBER() OVER (PARTITION BY s.id ORDER BY m.created_at ASC) AS rn
             FROM ai_sessions s
             JOIN ai_messages m
               ON m.user_id = s.user_id
              AND m.entity_type = s.entity_type
              AND COALESCE(m.estimate_id, '') = COALESCE(s.entity_id, '')
            WHERE s.user_id = $1 AND s.archived_at IS NULL AND m.content ILIKE $2
         )
         SELECT session_id AS id, label, summary, entity_type, entity_id,
                last_used_at, turn_count, substr(snippet, 1, 200) AS snippet
           FROM matches WHERE rn = 1
          ORDER BY last_used_at DESC LIMIT $3`,
        [userId, pattern, limit]
      );

      const seen = new Set();
      const merged = [];
      [...msgs.rows, ...meta.rows].forEach(r => {
        if (seen.has(r.id)) return;
        seen.add(r.id);
        merged.push(r);
      });
      if (!merged.length) return 'No prior sessions matched "' + q + '".';
      const lines = ['Found ' + merged.length + ' session(s) matching "' + q + '":'];
      merged.slice(0, limit).forEach(r => {
        const label = r.label || ('Session ' + r.id);
        const ctxStr = r.entity_id ? r.entity_type + ' ' + r.entity_id : r.entity_type;
        const when = r.last_used_at ? new Date(r.last_used_at).toISOString().slice(0, 10) : '?';
        lines.push('• [' + r.id + '] "' + label + '" (' + ctxStr + ', last used ' + when + ', ' + (r.turn_count || 0) + ' turns)');
        if (r.summary) lines.push('    summary: ' + r.summary);
        if (r.snippet) lines.push('    match: ' + String(r.snippet).replace(/\s+/g, ' ').slice(0, 180));
      });
      return lines.join('\n');
    }

    case 'search_my_kb': {
      // Personal knowledge base = every attachment the caller has
      // uploaded, across every bucket (user / job / estimate / lead /
      // client / sub). Matches against filename + extracted_text.
      // Scoped by uploaded_by = ctx.userId. Cross-tenant access is
      // blocked implicitly because uploads outside the user's org
      // would never have uploaded_by set to them.
      const userId = ctx && ctx.userId;
      if (!userId) return 'No user context — cannot search personal KB.';
      const q = String((input && input.query) || '').trim();
      if (!q) return 'query is required.';
      const limit = Math.min(50, Math.max(1, parseInt((input && input.limit), 10) || 20));
      const pattern = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
      const r = await pool.query(
        `SELECT id, filename, mime_type, size_bytes, folder,
                entity_type, entity_id, created_at,
                substr(COALESCE(extracted_text, ''), 1, 220) AS snippet,
                (extracted_text ILIKE $2) AS body_match,
                (filename ILIKE $2)       AS name_match
           FROM attachments
          WHERE uploaded_by = $1
            AND (filename ILIKE $2 OR extracted_text ILIKE $2)
          ORDER BY created_at DESC
          LIMIT $3`,
        [String(userId), pattern, limit]
      );
      if (!r.rows.length) return 'No personal-KB files matched "' + q + '".';
      const lines = ['Found ' + r.rows.length + ' file(s) you have uploaded matching "' + q + '":'];
      r.rows.forEach(row => {
        const folder = row.folder ? ' · ' + row.folder : '';
        const size = row.size_bytes ? ' · ' + Math.round(row.size_bytes / 1024) + ' KB' : '';
        const mime = row.mime_type ? ' · ' + row.mime_type : '';
        const ctxStr = row.entity_type && row.entity_id
          ? ' · in ' + row.entity_type + ' ' + row.entity_id
          : (row.entity_type ? ' · in ' + row.entity_type : '');
        const where = (row.name_match && !row.body_match) ? 'filename match' : 'content match';
        lines.push('• [' + row.id + '] ' + row.filename + folder + mime + size + ctxStr + ' — ' + where);
        if (row.snippet && row.body_match) {
          lines.push('    "' + String(row.snippet).replace(/\s+/g, ' ').slice(0, 180) + '"');
        }
      });
      lines.push('');
      lines.push('Call read_attachment_text({attachment_id}) on any [id] above to read the full body.');
      return lines.join('\n');
    }

    case 'search_org_kb': {
      // Org-wide knowledge base = every attachment in the caller\'s
      // organization. Cross-tenant access blocked: we resolve the
      // caller\'s organization_id and only return rows where the
      // file\'s owning user, job, estimate, lead, etc. belongs to
      // that org.
      const userId = ctx && ctx.userId;
      if (!userId) return 'No user context — cannot search company KB.';
      const q = String((input && input.query) || '').trim();
      if (!q) return 'query is required.';
      const limit = Math.min(50, Math.max(1, parseInt((input && input.limit), 10) || 20));
      const scope = String((input && input.scope) || 'all');
      const pattern = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';

      // Resolve org from users table — JWT carries it but ctx may not.
      const orgRes = await pool.query(`SELECT organization_id FROM users WHERE id = $1`, [userId]);
      const orgId = orgRes.rows[0] && orgRes.rows[0].organization_id;
      if (!orgId) return 'No organization scope — cannot search company KB.';

      // entity_type filter per scope.
      let entityTypeWhere = '';
      const params = [String(orgId), pattern, limit];
      if (scope === 'org_bucket')       entityTypeWhere = `AND a.entity_type = 'org' AND a.entity_id = $1`;
      else if (scope === 'user_buckets') entityTypeWhere = `AND a.entity_type = 'user' AND u_owner.organization_id = $1`;
      else if (scope === 'entity_buckets') entityTypeWhere = `AND a.entity_type IN ('job','estimate','lead','client','sub')`;
      // 'all' (default) keeps everything; org-id filter still applies via joins.

      // The query unions in the org filter through whichever join is
      // available for the row\'s entity_type. Rows without a clear
      // org link (legacy data) are dropped to avoid cross-tenant leaks.
      const r = await pool.query(
        `SELECT a.id, a.filename, a.mime_type, a.size_bytes, a.folder,
                a.entity_type, a.entity_id, a.uploaded_by, a.created_at,
                substr(COALESCE(a.extracted_text, ''), 1, 220) AS snippet,
                (a.extracted_text ILIKE $2) AS body_match,
                (a.filename ILIKE $2)       AS name_match,
                u_owner.name AS owner_name,
                u_owner.organization_id AS owner_org_id,
                j.id AS job_id_check,
                e.id AS est_id_check
           FROM attachments a
           LEFT JOIN users u_owner ON u_owner.id = a.uploaded_by
           LEFT JOIN jobs   j ON a.entity_type = 'job'      AND j.id = a.entity_id
           LEFT JOIN estimates e ON a.entity_type = 'estimate' AND e.id = a.entity_id
          WHERE (a.filename ILIKE $2 OR a.extracted_text ILIKE $2)
            ${entityTypeWhere}
            AND (
              (a.entity_type = 'org'  AND a.entity_id = $1)
              OR (a.entity_type = 'user' AND u_owner.organization_id = $1)
              OR (a.entity_type IN ('job','estimate','lead','client','sub')
                  AND u_owner.organization_id = $1)
            )
          ORDER BY a.created_at DESC
          LIMIT $3`,
        params
      );
      if (!r.rows.length) return 'No company-KB files matched "' + q + '".';
      const lines = ['Found ' + r.rows.length + ' file(s) in the company KB matching "' + q + '":'];
      r.rows.forEach(row => {
        let where;
        if      (row.entity_type === 'org')  where = 'company files';
        else if (row.entity_type === 'user') where = (row.owner_name ? row.owner_name + '\'s' : 'a user\'s') + ' personal files';
        else where = row.entity_type + ' ' + row.entity_id;
        const folder = row.folder ? ' / ' + row.folder : '';
        const size = row.size_bytes ? ' · ' + Math.round(row.size_bytes / 1024) + ' KB' : '';
        const hit = (row.name_match && !row.body_match) ? 'filename match' : 'content match';
        lines.push('• [' + row.id + '] ' + row.filename + ' (' + where + folder + ')' + size + ' — ' + hit);
        if (row.snippet && row.body_match) {
          lines.push('    "' + String(row.snippet).replace(/\s+/g, ' ').slice(0, 180) + '"');
        }
      });
      lines.push('');
      lines.push('Call read_attachment_text({attachment_id}) on any [id] above to read the full body.');
      return lines.join('\n');
    }

    case 'read_materials': {
      // Same query shape as the GET /api/materials endpoint that 86\'s
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
      // Search the clients directory. Replaced the broken SQL that
      // referenced a non-existent clients.contact_name column — the
      // actual schema uses first_name + last_name, plus a separate
      // community_name and company_name. Also widened the LIKE to
      // cover parent name + community name so 86 can find a property
      // via the HOA or community label, not just the row's own name.
      const q = (input && input.q || '').trim();
      const limit = Math.max(1, Math.min(100, Number(input && input.limit) || 20));
      let r;
      if (q) {
        const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
        r = await pool.query(
          `SELECT c.id, c.name, c.parent_client_id, c.city, c.state,
                  c.first_name, c.last_name, c.email, c.phone,
                  c.company_name, c.community_name, c.client_type,
                  p.name AS parent_name,
                  (SELECT COUNT(*)::int FROM client_notes n WHERE n.client_id = c.id) AS note_count
             FROM clients c
             LEFT JOIN clients p ON p.id = c.parent_client_id
            WHERE c.name ILIKE $1
               OR p.name ILIKE $1
               OR c.community_name ILIKE $1
               OR c.company_name ILIKE $1
               OR c.city ILIKE $1
               OR c.first_name ILIKE $1
               OR c.last_name ILIKE $1
            ORDER BY (c.name ILIKE $1) DESC, lower(c.name)
            LIMIT $2`,
          [like, limit]
        );
      } else {
        r = await pool.query(
          `SELECT c.id, c.name, c.parent_client_id, c.city, c.state,
                  c.first_name, c.last_name, c.email, c.phone,
                  c.company_name, c.community_name, c.client_type,
                  p.name AS parent_name,
                  (SELECT COUNT(*)::int FROM client_notes n WHERE n.client_id = c.id) AS note_count
             FROM clients c
             LEFT JOIN clients p ON p.id = c.parent_client_id
            ORDER BY lower(c.name)
            LIMIT $1`,
          [limit]
        );
      }
      if (!r.rows.length) return q ? 'No clients matched "' + q + '".' : 'No clients in directory.';
      const out = ['Found ' + r.rows.length + ' client' + (r.rows.length === 1 ? '' : 's') + ':'];
      for (const c of r.rows) {
        const contact = [c.first_name, c.last_name].filter(Boolean).join(' ');
        out.push('- ' + c.name + ' [id=' + c.id + ']' +
          (c.parent_name ? ' (under ' + c.parent_name + ')' : '') +
          (c.client_type ? ' · ' + c.client_type : '') +
          (c.city ? ' · ' + c.city + (c.state ? ', ' + c.state : '') : '') +
          (contact ? ' · contact: ' + contact : '') +
          (c.phone ? ' · ' + c.phone : '') +
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
      if (!r.rows.length) return 'No past estimate lines matched "' + q + '" in the last ' + days + ' days. Quote a defensible Central-FL estimate and mark "first-time line — no Project 86 history yet."';
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

// Approval-tier executor for skill-pack mutations. Reads + writes the
// per-tenant org_skill_packs table. Caller passes ctx={userId} so we
// can resolve the right organization.
async function resolveOrgIdFromCtx(ctx) {
  const userId = ctx && ctx.userId;
  if (!userId) throw new Error('Skill-pack mutation requires a user context (call from /api/ai/exec-tool).');
  const r = await pool.query('SELECT organization_id FROM users WHERE id = $1', [userId]);
  const orgId = r.rows[0] && r.rows[0].organization_id;
  if (!orgId) throw new Error('User is not associated with an organization.');
  return orgId;
}

async function execStaffApprovalTool(name, input, ctx) {
  switch (name) {
    case 'propose_skill_pack_add': {
      if (!input || !input.name || !input.body) throw new Error('name and body are required');
      if (!Array.isArray(input.agents) || !input.agents.length) throw new Error('agents must be a non-empty array');
      const anthropic = getAnthropic();
      if (!anthropic) throw new Error('ANTHROPIC_API_KEY not set. All packs must mirror to Anthropic native Skills.');
      const orgId = await resolveOrgIdFromCtx(ctx);
      let insertedId = null;
      try {
        const ins = await pool.query(
          `INSERT INTO org_skill_packs (organization_id, name, body, agents)
           VALUES ($1, $2, $3, $4::jsonb)
           RETURNING *`,
          [orgId, input.name, input.body, JSON.stringify(input.agents)]
        );
        const pack = ins.rows[0];
        insertedId = pack.id;
        const md = buildSkillMarkdownForMirror(pack);
        const slug = slugifyMirrorName(pack.name);
        const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
        const created = await anthropic.beta.skills.create({
          display_title: (pack.name || 'Project 86 skill').slice(0, 200),
          files: [file]
        });
        await pool.query(
          `UPDATE org_skill_packs SET anthropic_skill_id = $1, updated_at = NOW() WHERE id = $2`,
          [created.id, pack.id]
        );
        return 'Added skill pack "' + input.name + '" → agents=' + input.agents.join(',') +
          '. Mirrored to Anthropic (' + created.id + '); the agent will auto-discover it on next sync.';
      } catch (e) {
        if (insertedId) {
          try { await pool.query(`DELETE FROM org_skill_packs WHERE id = $1`, [insertedId]); }
          catch (rollbackErr) { console.error('[propose_skill_pack_add rollback] failed:', rollbackErr); }
        }
        if (e && e.code === '23505') {
          throw new Error('A skill pack named "' + input.name + '" already exists for this organization. Use propose_skill_pack_edit to modify it.');
        }
        throw e;
      }
    }
    case 'propose_skill_pack_edit': {
      if (!input || !input.name) throw new Error('name is required');
      const orgId = await resolveOrgIdFromCtx(ctx);
      const r = await pool.query(
        `SELECT * FROM org_skill_packs WHERE organization_id = $1 AND name = $2 AND archived_at IS NULL`,
        [orgId, input.name]
      );
      if (!r.rows.length) throw new Error('No skill pack named "' + input.name + '"');
      const pack = r.rows[0];
      const updates = [];
      const params = [orgId, input.name];
      const changes = [];
      let p = 3;
      if (input.new_name && input.new_name !== pack.name) {
        const conflict = await pool.query(
          `SELECT 1 FROM org_skill_packs WHERE organization_id = $1 AND name = $2 AND id <> $3`,
          [orgId, input.new_name, pack.id]
        );
        if (conflict.rows.length) throw new Error('A skill pack named "' + input.new_name + '" already exists.');
        updates.push('name = $' + p);
        params.push(input.new_name);
        p++;
        changes.push('name "' + pack.name + '" → "' + input.new_name + '"');
      }
      if (input.new_body != null) {
        updates.push('body = $' + p);
        params.push(input.new_body);
        p++;
        changes.push('body (' + (input.new_body.length || 0) + ' chars)');
      }
      if (Array.isArray(input.agents)) {
        updates.push('agents = $' + p + '::jsonb');
        params.push(JSON.stringify(input.agents));
        p++;
        changes.push('agents → ' + input.agents.join(','));
      }
      if (!updates.length) return 'No changes specified for "' + input.name + '".';
      updates.push('updated_at = NOW()');
      const updRes = await pool.query(
        `UPDATE org_skill_packs SET ${updates.join(', ')}
          WHERE organization_id = $1 AND name = $2
          RETURNING *`,
        params
      );
      const updated = updRes.rows[0];

      const contentChanged = (input.new_body != null && input.new_body !== pack.body)
        || (input.new_name && input.new_name !== pack.name);
      if (contentChanged) {
        const anthropic = getAnthropic();
        if (!anthropic) {
          await pool.query(
            `UPDATE org_skill_packs SET name = $1, body = $2, updated_at = NOW() WHERE id = $3`,
            [pack.name, pack.body, pack.id]
          );
          throw new Error('ANTHROPIC_API_KEY not set — edit rolled back. Packs must stay in sync with Anthropic.');
        }
        try {
          const md = buildSkillMarkdownForMirror(updated);
          const slug = slugifyMirrorName(updated.name);
          const file = await toFile(Buffer.from(md, 'utf8'), 'SKILL.md', { type: 'text/markdown' });
          if (updated.anthropic_skill_id) {
            await anthropic.beta.skills.versions.create(updated.anthropic_skill_id, { files: [file] });
          } else {
            const created = await anthropic.beta.skills.create({
              display_title: (updated.name || 'Project 86 skill').slice(0, 200),
              files: [file]
            });
            await pool.query(
              `UPDATE org_skill_packs SET anthropic_skill_id = $1 WHERE id = $2`,
              [created.id, updated.id]
            );
          }
        } catch (mirrorErr) {
          await pool.query(
            `UPDATE org_skill_packs SET name = $1, body = $2, updated_at = NOW() WHERE id = $3`,
            [pack.name, pack.body, pack.id]
          );
          throw new Error('Mirror to Anthropic failed; local edit rolled back: ' + (mirrorErr.message || 'unknown'));
        }
      }
      return 'Edited skill pack "' + input.name + '": ' + changes.join('; ') + (contentChanged ? ' (re-mirrored to Anthropic).' : '');
    }
    case 'propose_skill_pack_delete': {
      if (!input || !input.name) throw new Error('name is required');
      const orgId = await resolveOrgIdFromCtx(ctx);
      // Snapshot first so we know the Anthropic skill_id to clean up.
      const snap = await pool.query(
        `SELECT id, name, anthropic_skill_id FROM org_skill_packs
          WHERE organization_id = $1 AND name = $2 AND archived_at IS NULL`,
        [orgId, input.name]
      );
      if (!snap.rows.length) throw new Error('No skill pack named "' + input.name + '"');
      const pack = snap.rows[0];

      // Best-effort Anthropic-side delete. If it fails we still scrub
      // locally — orphan Anthropic skills are easier to clean up than
      // a divergent local-only pack.
      if (pack.anthropic_skill_id) {
        const anthropic = getAnthropic();
        if (anthropic) {
          try { await anthropic.beta.skills.delete(pack.anthropic_skill_id); }
          catch (e) { console.warn('[propose_skill_pack_delete] Anthropic-side delete failed:', e.message || e); }
        }
      }

      await pool.query(
        `UPDATE org_skill_packs SET archived_at = NOW(), anthropic_skill_id = NULL
          WHERE id = $1`,
        [pack.id]
      );
      return 'Deleted skill pack "' + input.name + '" (local soft-archive + Anthropic mirror removed).';
    }
    // Phase 5 — proactive watching writes (approval-tier).
    case 'propose_watch_create': {
      if (!input || !input.name) throw new Error('name is required');
      if (!input.prompt) throw new Error('prompt is required');
      const cadence = input.cadence;
      if (!['hourly', 'daily', 'weekly'].includes(cadence)) {
        throw new Error('cadence must be one of: hourly, daily, weekly');
      }
      const timeOfDay = String(input.time_of_day_utc || '03:00').trim();
      if (!/^\d{1,2}:\d{2}$/.test(timeOfDay)) {
        throw new Error('time_of_day_utc must be HH:MM');
      }
      const orgId = await resolveOrgIdFromCtx(ctx);
      const watchId = 'wch_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      const nextFire = computeNextFireAt(cadence, timeOfDay, new Date());
      await pool.query(
        `INSERT INTO ai_watches
           (id, organization_id, created_by_user_id, name, description,
            cadence, time_of_day_utc, prompt, enabled, next_fire_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, $9)`,
        [
          watchId, orgId, ctx.userId,
          String(input.name).slice(0, 100),
          input.description ? String(input.description).slice(0, 500) : null,
          cadence, timeOfDay, String(input.prompt).slice(0, 8000), nextFire
        ]
      );
      return 'Created watch ' + watchId + ' "' + input.name + '" — cadence: ' + cadence +
        (cadence !== 'hourly' ? ' at ' + timeOfDay + ' UTC' : '') +
        '. First fire: ' + nextFire.toISOString() + '.';
    }
    case 'propose_watch_archive': {
      if (!input || !input.id) throw new Error('id is required');
      const orgId = await resolveOrgIdFromCtx(ctx);
      const r = await pool.query(
        `UPDATE ai_watches SET archived_at = NOW(), enabled = false, updated_at = NOW()
          WHERE id = $1 AND organization_id = $2 AND archived_at IS NULL
        RETURNING name`,
        [input.id, orgId]
      );
      if (!r.rows.length) throw new Error('No active watch found with id ' + input.id);
      return 'Archived watch ' + input.id + ' ("' + r.rows[0].name + '"). It will not fire again.';
    }
    default:
      throw new Error('Unknown approval-tier staff tool: ' + name);
  }
}

// Phase 5 — next-fire-at computation for a watch cadence.
// Pure function so it's testable in isolation; called both at watch
// create time and after each fire.
function computeNextFireAt(cadence, timeOfDayUtc, from) {
  const now = new Date(from);
  if (cadence === 'hourly') {
    const next = new Date(now);
    next.setUTCMinutes(0, 0, 0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next;
  }
  const [hh, mm] = String(timeOfDayUtc || '03:00').split(':').map(Number);
  const next = new Date(now);
  next.setUTCHours(hh, mm, 0, 0);
  if (cadence === 'daily') {
    if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
    return next;
  }
  if (cadence === 'weekly') {
    // Monday in UTC.
    const dayUTC = next.getUTCDay(); // 0=Sun..6=Sat
    const daysUntilMonday = ((1 - dayUTC) + 7) % 7;
    next.setUTCDate(next.getUTCDate() + daysUntilMonday);
    if (next <= now) next.setUTCDate(next.getUTCDate() + 7);
    return next;
  }
  return next;
}

// /staff/chat + /staff/chat/continue stubs removed — already caught
// by the LEGACY_CHAT_PATHS 410 intercept at the top of this file.

// 86 auto-execute hook — runs the same read tools the v1 client
// auto-fires through /api/ai/exec-tool, but server-side here so the
// session resumes mid-stream without an extra client round-trip
// (was the source of "86 isn't actually performing the task" — every
// read paused for an approval-card flash + extra HTTP turn).
//
// 86's allowed auto-tier set (ALLOWED_AUTO_TIER_TOOLS) is a strict
// subset of execStaffTool's switch cases, so we reuse the same
// executor instead of duplicating the read logic. Approval-tier
// tools (propose_*) drop through to the UI exactly like before.
function makeAgOnCustomToolUse() {
  return async function (tu) {
    if (!ALLOWED_AUTO_TIER_TOOLS.has(tu.name)) return { tier: 'approval' };
    try {
      const summary = await execStaffTool(tu.name, tu.input || {});
      return { tier: 'auto', summary };
    } catch (e) {
      return { tier: 'auto', error: 'Error: ' + (e.message || 'failed') };
    }
  };
}

// Directory surface (clients) — POST /api/ai/v2/clients/chat
// ════════════════════════════════════════════════════════════════════
// LEAD INTAKE — separate surface, fresh session per panel open
//
// Distinct from directory / job / estimate / CoS surfaces: each
// /v2/intake/chat call archives
// any prior intake session for this user and starts a brand-new
// Anthropic session. There's no persistent history surface — once
// the user creates a lead (or closes the panel), the conversation is
// done.
//
// Two read tools (auto-tier) for dedupe checks; one approval-tier
// tool (propose_create_lead) that does the actual create. Photos
// uploaded mid-chat sit in a per-user temp bucket and move to the
// new lead's attachments on approval.
// ════════════════════════════════════════════════════════════════════

// Per-user pending image bucket scoped to intake. Separate from the
// directory-surface business-card bucket so a stale directory upload can't accidentally
// land on a lead, and vice-versa.
const _intakeImageBuckets = new Map();

function stashPendingIntakeImages(userId, base64Array) {
  if (!base64Array || !base64Array.length) return;
  const existing = _intakeImageBuckets.get(userId) || { images: [], lastTouched: 0 };
  const now = Date.now();
  for (const raw of base64Array) {
    const stripped = typeof raw === 'string' && raw.indexOf('base64,') >= 0
      ? raw.slice(raw.indexOf('base64,') + 7)
      : raw;
    existing.images.push({ b64: stripped, mime: 'image/jpeg', addedAt: now });
  }
  // Cap at 12 images / 30 min — leads usually need 1-6 photos.
  if (existing.images.length > 12) existing.images = existing.images.slice(-12);
  existing.lastTouched = now;
  _intakeImageBuckets.set(userId, existing);
}
function drainPendingIntakeImages(userId) {
  const bucket = _intakeImageBuckets.get(userId);
  if (!bucket) return [];
  _intakeImageBuckets.delete(userId);
  return bucket.images || [];
}
function clearPendingIntakeImages(userId) {
  _intakeImageBuckets.delete(userId);
}

// Per-turn context for the intake agent. Light — just who the user
// is, the date, and how many photos are staged. The agent's stable
// system prompt carries the rest.
async function buildIntakeContext(userId, organization) {
  const lines = [];
  lines.push('# Intake session');
  let userRow = null;
  try {
    const r = await pool.query('SELECT id, email, name, role FROM users WHERE id = $1', [userId]);
    userRow = r.rows[0] || null;
  } catch (e) { /* defensive */ }
  if (userRow) {
    lines.push('Intaking user: **' + userRow.name + '** (' + userRow.email + ', role=' + userRow.role + ')');
    lines.push('  → If this user IS the salesperson on this lead, you can set salesperson_id to "' + userRow.id + '".');
  }
  const today = new Date();
  lines.push('Date: ' + today.toISOString().slice(0, 10));
  // Photo count from the intake bucket — agent already SEES the
  // photos as inline content blocks; this is just a numeric hint.
  const bucket = _intakeImageBuckets.get(userId);
  const n = bucket && bucket.images ? bucket.images.length : 0;
  lines.push('Photos staged this turn: ' + n + (n ? ' (in scope for attach_pending_photos:true on propose_create_lead)' : ''));

  // Skill packs — manifest only (was eager-loading full bodies).
  // Skill packs ship as native Anthropic Skills registered on the
  // agent — the runtime auto-discovers them by description each turn.

  return { system: lines.join('\n') };
}

// Auto-tier intake reads — dedupe checks against existing clients
// and recent leads.
async function execIntakeRead(name, input) {
  if (name === 'read_existing_clients') {
    const q = String((input && input.query) || '').trim();
    if (!q) {
      // Return a successful empty result rather than a sentinel string —
      // the model was misreading "No query provided." as a tool error
      // and looping. This makes the contract explicit: search complete,
      // zero matches, here's why.
      return 'Search complete. Query was empty — call again with a query string (company name, property, or city) to match against the directory.';
    }
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    const r = await pool.query(
      `SELECT c.id, c.name, c.client_type, c.parent_client_id,
              p.name AS parent_name, c.email, c.phone, c.market,
              c.community_name, c.property_address, c.city, c.state
         FROM clients c
         LEFT JOIN clients p ON p.id = c.parent_client_id
        WHERE c.name ILIKE $1 OR p.name ILIKE $1 OR c.community_name ILIKE $1
        ORDER BY (c.name ILIKE $1) DESC, c.name
        LIMIT 30`,
      [like]
    );
    if (!r.rows.length) {
      // Phrase the zero-match case unambiguously as a successful tool
      // result so the model doesn't loop thinking the tool is broken.
      return 'Search complete. Query: "' + q + '". Matches found: 0. The directory has no client whose name, parent, or community contains "' + q + '". This is a valid result — proceed by calling propose_create_lead with new_client (do NOT retry the search with the same query).';
    }
    const lines = ['Search complete. Query: "' + q + '". Matches found: ' + r.rows.length + '.'];
    r.rows.forEach(c => {
      const parent = c.parent_name ? ' (under ' + c.parent_name + ')' : '';
      const where  = [c.city, c.state].filter(Boolean).join(', ');
      lines.push('- id=`' + c.id + '` · ' + c.name + parent +
        ' · ' + (c.client_type || '?') +
        (where ? ' · ' + where : '') +
        (c.email ? ' · ' + c.email : '') +
        (c.phone ? ' · ' + c.phone : ''));
    });
    return lines.join('\n');
  }
  if (name === 'read_existing_leads') {
    const q = String((input && input.query) || '').trim();
    if (!q) {
      return 'Search complete. Query was empty — call again with a query string (project description, property, or city) to match against recent leads.';
    }
    const like = '%' + q.replace(/[\\%_]/g, m => '\\' + m) + '%';
    const r = await pool.query(
      `SELECT l.id, l.title, l.status, l.city, l.state, l.created_at, l.updated_at,
              c.name AS client_name
         FROM leads l
         LEFT JOIN clients c ON c.id = l.client_id
        WHERE (l.title ILIKE $1 OR l.property_name ILIKE $1 OR l.city ILIKE $1
               OR c.name ILIKE $1)
          AND l.created_at >= NOW() - INTERVAL '180 days'
        ORDER BY l.updated_at DESC
        LIMIT 20`,
      [like]
    );
    if (!r.rows.length) {
      return 'Search complete. Query: "' + q + '". Matches found: 0 (looked back 180 days). No recent leads at that property / title / city. This is a valid result — proceed with propose_create_lead (do NOT retry the search with the same query).';
    }
    const lines = ['Search complete. Query: "' + q + '". Matches found: ' + r.rows.length + '.'];
    r.rows.forEach(l => {
      lines.push('- id=`' + l.id + '` · ' + l.title +
        (l.client_name ? ' · ' + l.client_name : '') +
        ' · status=' + l.status +
        ' · updated=' + (l.updated_at ? l.updated_at.toISOString().slice(0, 10) : '?'));
    });
    return lines.join('\n');
  }
  return 'Unknown intake read tool: ' + name;
}

// ──────── Field tools — read + approval executors ────────
//
// read_field_tools (auto-tier) returns the index without html_body
// — name, id, description, category, updated. Keeps the prompt
// short; 86 can call propose_update_field_tool with the id later
// to swap out the body without needing to re-render the existing.
async function execFieldToolRead(name, input) {
  if (name === 'read_field_tools') {
    const r = await pool.query(
      `SELECT id, name, description, category, updated_at,
              LENGTH(html_body) AS html_size
         FROM field_tools
        ORDER BY updated_at DESC`
    );
    if (!r.rows.length) {
      return 'No field tools yet. Use propose_create_field_tool to add the first one.';
    }
    const lines = [r.rows.length + ' field tool(s):'];
    r.rows.forEach(t => {
      const cat = t.category ? ' · ' + t.category : '';
      const desc = t.description ? ' — ' + t.description : '';
      const sz = t.html_size ? ' · ' + Math.ceil(Number(t.html_size) / 1024) + 'KB' : '';
      lines.push('- id=`' + t.id + '` · ' + t.name + cat + sz + desc);
    });
    return lines.join('\n');
  }
  return 'Unknown field-tools read: ' + name;
}

// Approval-tier executor — runs when the user approves a
// propose_*_field_tool card. Returns a summary string for the
// tool_result event. is_error is set in the caller's catch block.
async function execFieldToolApproval(name, input, userId) {
  if (name === 'propose_create_field_tool') {
    const n = String((input && input.name) || '').trim();
    const html = String((input && input.html_body) || '').trim();
    if (!n) throw new Error('name is required');
    if (!html) throw new Error('html_body is required');
    if (html.length > 500 * 1024) throw new Error('html_body exceeds 500KB.');
    const cat = input && input.category ? String(input.category).trim() : null;
    if (cat && !['calculator', 'lookup', 'form', 'other'].includes(cat)) {
      throw new Error('category must be calculator | lookup | form | other');
    }
    const desc = input && input.description ? String(input.description).trim() : null;
    const id = 'ft_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    try {
      await pool.query(
        `INSERT INTO field_tools (id, name, description, category, html_body, created_by)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [id, n, desc, cat, html, userId]
      );
    } catch (e) {
      if (e.code === '23505') throw new Error('A field tool named "' + n + '" already exists. Use propose_update_field_tool to edit it.');
      throw e;
    }
    return 'Created field tool "' + n + '" (id=' + id + ', ' + Math.ceil(html.length / 1024) + 'KB). Open it from the Tools tab.';
  }

  if (name === 'propose_update_field_tool') {
    const id = String((input && input.id) || '').trim();
    if (!id) throw new Error('id is required');
    const sets = [];
    const params = [];
    let p = 1;
    if (input.name != null) { sets.push(`name = $${p++}`); params.push(String(input.name).trim()); }
    if (input.description !== undefined) {
      sets.push(`description = $${p++}`);
      params.push(input.description != null ? String(input.description).trim() : null);
    }
    if (input.category !== undefined) {
      const c = input.category != null ? String(input.category).trim() : null;
      if (c && !['calculator', 'lookup', 'form', 'other'].includes(c)) {
        throw new Error('category must be calculator | lookup | form | other');
      }
      sets.push(`category = $${p++}`); params.push(c);
    }
    if (input.html_body != null) {
      const html = String(input.html_body);
      if (html.length > 500 * 1024) throw new Error('html_body exceeds 500KB.');
      sets.push(`html_body = $${p++}`); params.push(html);
    }
    if (!sets.length) return 'No fields specified to update for tool "' + id + '".';
    sets.push('updated_at = NOW()');
    params.push(id);
    let r;
    try {
      r = await pool.query(
        `UPDATE field_tools SET ${sets.join(', ')} WHERE id = $${p} RETURNING id, name`,
        params
      );
    } catch (e) {
      if (e.code === '23505') throw new Error('A field tool with that name already exists.');
      throw e;
    }
    if (!r.rows.length) throw new Error('No field tool with id "' + id + '"');
    return 'Updated field tool "' + r.rows[0].name + '" (id=' + r.rows[0].id + ').';
  }

  if (name === 'propose_delete_field_tool') {
    const id = String((input && input.id) || '').trim();
    if (!id) throw new Error('id is required');
    const r = await pool.query(`DELETE FROM field_tools WHERE id = $1 RETURNING name`, [id]);
    if (!r.rows.length) throw new Error('No field tool with id "' + id + '"');
    return 'Deleted field tool "' + r.rows[0].name + '" (id=' + id + ').';
  }

  throw new Error('Unknown field tool approval action: ' + name);
}

// Generic R2 + sharp + attachments-insert pipeline. Used by intake
// (drains the per-user bucket onto the new lead) AND by job/estimate
// chat (each upload lands directly on the entity that owns the chat
// — no bucket since the entity already exists). Returns the number
// of photos attached. Errors per-photo are logged but don't abort
// the rest — partial success beats rolling everything back.
//
// `photos` shape: array of either { b64, mime } objects (from intake
// bucket) OR plain base64 strings (from req.body.additional_images).
// Both shapes are normalized internally.
//
// `filenamePrefix` becomes `<prefix>-<idx>.jpg` in the attachments
// table — useful for showing where the file came from in lists
// ("intake-photo-1", "chat-photo-3", etc.).
async function attachBase64PhotosToEntity(entityType, entityId, photos, userId, filenamePrefix) {
  if (!photos || !photos.length) return 0;
  // Append at the end of the existing attachment order so newly
  // uploaded photos don't shuffle positions.
  const posR = await pool.query(
    'SELECT COALESCE(MAX(position), -1) AS max_pos FROM attachments WHERE entity_type = $1 AND entity_id = $2',
    [entityType, entityId]
  );
  const startPos = (posR.rows[0] && posR.rows[0].max_pos != null) ? Number(posR.rows[0].max_pos) + 1 : 0;
  let saved = 0;
  for (let i = 0; i < photos.length; i++) {
    const raw = photos[i];
    // Normalize: { b64, mime } → unwrap; bare string → wrap.
    const b64 = (raw && typeof raw === 'object' && 'b64' in raw)
      ? raw.b64
      : (typeof raw === 'string' && raw.indexOf('base64,') >= 0
          ? raw.slice(raw.indexOf('base64,') + 7)
          : raw);
    const mime = (raw && typeof raw === 'object' && raw.mime) ? raw.mime : 'image/jpeg';
    try {
      const buf = Buffer.from(b64, 'base64');
      const id = 'att_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const baseKey = entityType + '/' + entityId + '/' + id;
      let thumbKey = null, webKey = null, originalKey;
      let thumbUrl = null, webUrl = null, originalUrl;
      let width = null, height = null;
      try {
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
        originalUrl = await storage.put(originalKey, buf, mime);
      } catch (e) {
        originalKey = baseKey + '_orig.jpg';
        originalUrl = await storage.put(originalKey, buf, mime);
      }
      await pool.query(
        `INSERT INTO attachments
           (id, entity_type, entity_id, filename, mime_type, size_bytes,
            width, height, thumb_url, web_url, original_url,
            thumb_key, web_key, original_key, position, uploaded_by)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16)`,
        [id, entityType, entityId,
         (filenamePrefix || 'photo') + '-' + (i + 1) + '.jpg',
         mime, buf.length,
         width, height,
         thumbUrl, webUrl, originalUrl,
         thumbKey, webKey, originalKey,
         startPos + i, userId]
      );
      saved++;
    } catch (e) {
      console.warn('[attach] photo attach failed for ' + entityType + ' ' + entityId + ' (idx ' + i + '):', e && e.message);
    }
  }
  return saved;
}

// Intake-specific wrapper — drains the per-user bucket onto the new
// lead. Kept as a thin shim so the intake propose_create_lead handler
// reads cleanly.
async function attachPendingIntakePhotosToLead(userId, leadId) {
  const photos = drainPendingIntakeImages(userId);
  return await attachBase64PhotosToEntity('lead', leadId, photos, userId, 'intake-photo');
}

// Approval-tier handler: create the client (if inline), insert the
// lead, attach the staged photos. Runs inside make86OnCustomToolUse
// when the user approves propose_create_lead on /chat/continue.
async function execProposeCreateLead(input, userId) {
  const t = String(input.title || '').trim();
  if (!t) throw new Error('title is required');

  // Resolve client_id: existing wins over new_client; if neither, we
  // create the lead with NULL client_id (allowed but flagged in the
  // summary so the user knows to backfill).
  let clientId = input.existing_client_id || null;
  let createdClientNote = '';
  if (!clientId && input.new_client && input.new_client.name) {
    const nc = input.new_client;
    const newClientId = 'client_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO clients
         (id, name, parent_client_id, client_type, email, phone, property_address)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [newClientId, nc.name, nc.parent_client_id || null, nc.client_type || null,
       nc.email || null, nc.phone || null, nc.address || null]
    );
    clientId = newClientId;
    createdClientNote = ' (created new client "' + nc.name + '" id=' + newClientId + ')';
  }

  const leadId = 'lead_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const f = {
    id: leadId,
    created_by: userId,
    client_id: clientId,
    title: t.slice(0, 200),
    street_address: input.street_address || null,
    city: input.city || null,
    state: input.state || null,
    zip: input.zip || null,
    status: 'new',
    confidence: input.confidence != null ? Math.max(0, Math.min(100, parseInt(input.confidence, 10) || 0)) : null,
    projected_sale_date: input.projected_sale_date || null,
    estimated_revenue_low:  input.estimated_revenue_low  != null ? Number(input.estimated_revenue_low)  : null,
    estimated_revenue_high: input.estimated_revenue_high != null ? Number(input.estimated_revenue_high) : null,
    source: input.source || null,
    project_type: input.project_type || null,
    salesperson_id: input.salesperson_id || null,
    property_name: input.property_name || null,
    gate_code: input.gate_code || null,
    market: input.market || null,
    notes: input.notes || null
  };
  const cols = Object.keys(f);
  const vals = cols.map(k => f[k]);
  const placeholders = cols.map((_, i) => '$' + (i + 1)).join(', ');
  await pool.query(
    `INSERT INTO leads (${cols.join(', ')}) VALUES (${placeholders})`,
    vals
  );

  let photoNote = '';
  if (input.attach_pending_photos) {
    const n = await attachPendingIntakePhotosToLead(userId, leadId);
    photoNote = n ? ' · attached ' + n + ' photo' + (n === 1 ? '' : 's') : '';
  } else {
    // No photos requested but bucket may still have stale entries —
    // drop them so the next intake starts clean.
    clearPendingIntakeImages(userId);
  }

  return 'Created lead "' + t + '" id=' + leadId + createdClientNote + photoNote;
}

// ─── Job → Client linkage (server-applied) ────────────────────────────
//
// Both helpers mutate jobs.data.clientId in place. data is JSONB; we
// patch only the single key with jsonb_set so any other in-flight
// edits on the same row don't clobber each other. Returns a string
// summary that 86 sees as the tool result.

async function execLinkJobToClient(input) {
  const jobId = String(input.job_id || '').trim();
  const clientId = String(input.client_id || '').trim();
  if (!jobId) throw new Error('job_id is required');
  if (!clientId) throw new Error('client_id is required');

  // Verify the client exists — silently linking to a stale id would
  // pollute downstream reads with broken pointers.
  const c = await pool.query('SELECT id, name FROM clients WHERE id = $1', [clientId]);
  if (!c.rows.length) throw new Error('client_id "' + clientId + '" does not exist');
  const clientName = c.rows[0].name;

  const j = await pool.query(
    `UPDATE jobs
        SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{clientId}', to_jsonb($2::text), true),
            updated_at = NOW()
      WHERE id = $1
      RETURNING data->>'jobNumber' AS job_number, data->>'title' AS title`,
    [jobId, clientId]
  );
  if (!j.rows.length) throw new Error('job_id "' + jobId + '" does not exist');
  const r = j.rows[0];
  const jobLabel = r.job_number ? ('job ' + r.job_number) : ('job ' + jobId);
  const titlePart = r.title ? ' "' + r.title + '"' : '';
  return 'Linked ' + jobLabel + titlePart + ' to client "' + clientName + '" (' + clientId + ').';
}

async function execBulkLinkJobsToClients(input) {
  const links = Array.isArray(input.links) ? input.links : [];
  if (!links.length) throw new Error('links is required and must be non-empty');
  if (links.length > 100) throw new Error('Up to 100 links per call. Got ' + links.length + '.');

  // Validate every job_id + client_id up front so we either land the
  // whole batch or none of it. Partial-success would leave the user
  // unsure which mappings stuck.
  const jobIds = [...new Set(links.map(l => String(l.job_id || '')))].filter(Boolean);
  const clientIds = [...new Set(links.map(l => String(l.client_id || '')))].filter(Boolean);
  if (!jobIds.length || !clientIds.length) throw new Error('links must include job_id and client_id on every entry');

  const jr = await pool.query(`SELECT id FROM jobs WHERE id = ANY($1::text[])`, [jobIds]);
  const knownJobs = new Set(jr.rows.map(r => r.id));
  const missingJobs = jobIds.filter(id => !knownJobs.has(id));
  if (missingJobs.length) throw new Error('Unknown job_id(s): ' + missingJobs.slice(0, 5).join(', ') + (missingJobs.length > 5 ? ' (+' + (missingJobs.length - 5) + ' more)' : ''));

  const cr = await pool.query(`SELECT id, name FROM clients WHERE id = ANY($1::text[])`, [clientIds]);
  const clientNameById = new Map(cr.rows.map(r => [r.id, r.name]));
  const missingClients = clientIds.filter(id => !clientNameById.has(id));
  if (missingClients.length) throw new Error('Unknown client_id(s): ' + missingClients.slice(0, 5).join(', ') + (missingClients.length > 5 ? ' (+' + (missingClients.length - 5) + ' more)' : ''));

  // Apply in one transaction so a mid-batch crash doesn't leave a
  // partial state. Each UPDATE patches just the clientId key.
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const link of links) {
      await client.query(
        `UPDATE jobs
            SET data = jsonb_set(COALESCE(data, '{}'::jsonb), '{clientId}', to_jsonb($2::text), true),
                updated_at = NOW()
          WHERE id = $1`,
        [String(link.job_id), String(link.client_id)]
      );
    }
    await client.query('COMMIT');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }

  return 'Linked ' + links.length + ' job' + (links.length === 1 ? '' : 's') + ' to clients.';
}

// Phase 3 subtask fan-out is RETIRED. The execSubtaskTool dispatcher
// and formatSubtaskBundle helper were ~150 lines that spawned child
// Anthropic sessions for parallel work. Native parallel tool calls
// within a single session cover the same use cases at a fraction of
// the cost (one cache hit, multiple reads/proposals in one turn).
// The ai_subtasks table is preserved for historical rollups but is
// no longer written.

// Phase 4 — memory tool handler. Called
// from make86OnCustomToolUse when 86 emits remember/recall/list_memories/forget.
// ctx = { userId }; org resolved from the user's row. Returns the
// summary string fed back to 86.
async function execMemoryTool(name, input, ctx) {
  const { userId } = ctx;
  const orgRow = await pool.query(`SELECT organization_id FROM users WHERE id = $1`, [userId]);
  const orgId = orgRow.rows[0] && orgRow.rows[0].organization_id;
  if (!orgId) throw new Error('User has no organization — cannot use memory tools.');

  if (name === 'remember') {
    const topic = String(input.topic || '').trim().slice(0, 100);
    const body = String(input.body || '').trim().slice(0, 2000);
    if (!topic) throw new Error('topic is required.');
    if (!body) throw new Error('body is required.');
    const kind = ['preference', 'fact', 'decision', 'context'].includes(input.kind) ? input.kind : 'fact';
    const scope = (input.scope === 'org') ? 'org' : 'user';
    const importance = Math.max(1, Math.min(10, Number(input.importance) || 5));

    // Upsert on (org, user, topic). If a memory with this topic
    // already exists, REPLACE the body — that's the "update" path.
    // Resurrect from archived state if needed (set archived_at = NULL).
    const existing = await pool.query(
      `SELECT id, archived_at FROM ai_memories
        WHERE organization_id = $1 AND user_id = $2 AND topic = $3`,
      [orgId, userId, topic]
    );

    if (existing.rows.length) {
      const memId = existing.rows[0].id;
      await pool.query(
        `UPDATE ai_memories
            SET body = $2, kind = $3, scope = $4, importance = $5,
                source = 'explicit', updated_at = NOW(), archived_at = NULL
          WHERE id = $1`,
        [memId, body, kind, scope, importance]
      );
      return 'Updated memory ' + memId + ' (topic: "' + topic + '").';
    }

    const memId = 'mem_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO ai_memories (id, organization_id, user_id, scope, kind, topic, body, source, importance)
       VALUES ($1, $2, $3, $4, $5, $6, $7, 'explicit', $8)`,
      [memId, orgId, userId, scope, kind, topic, body, importance]
    );
    return 'Saved memory ' + memId + ' (topic: "' + topic + '", kind: ' + kind + ', scope: ' + scope + ', importance: ' + importance + ').';
  }

  if (name === 'recall') {
    const query = String(input.query || '').trim();
    if (query.length < 2) throw new Error('query must be at least 2 chars.');
    const limit = Math.max(1, Math.min(20, Number(input.limit) || 5));
    const like = '%' + query.replace(/[%_]/g, c => '\\' + c) + '%';
    // Ranking heuristic:
    //   topic match worth 100, body match worth 30, importance up to 10,
    //   recency (last_recalled_at) breaks ties. ORDER BY computed in
    //   the query for atomicity.
    const r = await pool.query(`
      SELECT id, topic, body, kind, scope, importance, source,
             updated_at, last_recalled_at,
             ((CASE WHEN topic ILIKE $2 THEN 100 ELSE 0 END) +
              (CASE WHEN body  ILIKE $2 THEN  30 ELSE 0 END) +
              importance) AS score
        FROM ai_memories
       WHERE organization_id = $1
         AND (user_id = $3 OR scope = 'org')
         AND archived_at IS NULL
         AND (topic ILIKE $2 OR body ILIKE $2)
       ORDER BY score DESC,
                COALESCE(last_recalled_at, updated_at) DESC
       LIMIT $4
    `, [orgId, like, userId, limit]);

    if (!r.rows.length) {
      return 'No memories matched "' + query + '". Either there are none yet, or the topic/body wording differs — try a different keyword.';
    }

    // Bump last_recalled_at for the hits so frequently-used memories
    // surface earlier next time.
    const hitIds = r.rows.map(row => row.id);
    await pool.query(
      `UPDATE ai_memories SET last_recalled_at = NOW() WHERE id = ANY($1)`,
      [hitIds]
    );

    const lines = r.rows.map(row => {
      return '── ' + row.id + ' [' + row.kind + '/' + row.scope + '/imp:' + row.importance + '] "' + row.topic + '"\n' + row.body;
    });
    return 'Recalled ' + r.rows.length + ' memor' + (r.rows.length === 1 ? 'y' : 'ies') + ' matching "' + query + '":\n\n' + lines.join('\n\n');
  }

  if (name === 'list_memories') {
    const limit = Math.max(1, Math.min(100, Number(input.limit) || 20));
    const conds = ['organization_id = $1', 'archived_at IS NULL'];
    const params = [orgId];
    let p = 2;
    const scope = input.scope || 'all';
    if (scope === 'user') {
      conds.push('user_id = $' + p);
      params.push(userId);
      p++;
    } else if (scope === 'org') {
      conds.push("scope = 'org'");
    } else {
      conds.push('(user_id = $' + p + " OR scope = 'org')");
      params.push(userId);
      p++;
    }
    if (input.kind) {
      conds.push('kind = $' + p);
      params.push(input.kind);
      p++;
    }
    params.push(limit);
    const r = await pool.query(`
      SELECT id, topic, kind, scope, importance, body, updated_at
        FROM ai_memories
       WHERE ${conds.join(' AND ')}
       ORDER BY updated_at DESC
       LIMIT $${p}
    `, params);
    if (!r.rows.length) return 'No memories stored yet.';
    const lines = r.rows.map(row => {
      const snippet = row.body.length > 120 ? row.body.slice(0, 117) + '…' : row.body;
      return '── ' + row.id + ' [' + row.kind + '/' + row.scope + '/imp:' + row.importance + '] "' + row.topic + '" — ' + snippet;
    });
    return 'Listing ' + r.rows.length + ' memor' + (r.rows.length === 1 ? 'y' : 'ies') + ':\n\n' + lines.join('\n');
  }

  if (name === 'forget') {
    const id = input.id && String(input.id).trim();
    const topic = input.topic && String(input.topic).trim();
    if (!id && !topic) throw new Error('Pass either id or topic.');
    let target;
    if (id) {
      const r = await pool.query(
        `SELECT id FROM ai_memories
          WHERE id = $1 AND organization_id = $2
            AND (user_id = $3 OR scope = 'org') AND archived_at IS NULL`,
        [id, orgId, userId]
      );
      target = r.rows[0];
    } else {
      const r = await pool.query(
        `SELECT id FROM ai_memories
          WHERE organization_id = $1 AND user_id = $2 AND topic = $3 AND archived_at IS NULL`,
        [orgId, userId, topic]
      );
      target = r.rows[0];
    }
    if (!target) return 'No matching memory found to forget.';
    await pool.query(`UPDATE ai_memories SET archived_at = NOW() WHERE id = $1`, [target.id]);
    return 'Archived memory ' + target.id + '.';
  }

  throw new Error('Unknown memory tool: ' + name);
}

// Phase 5 — auto-tier read handlers for watches. Same pattern as
// execMemoryTool: called from make86OnCustomToolUse when 86 emits
// list_watches or read_recent_watch_runs. ctx = { userId }.
async function execWatchTool(name, input, ctx) {
  const { userId } = ctx;
  const orgRow = await pool.query(`SELECT organization_id FROM users WHERE id = $1`, [userId]);
  const orgId = orgRow.rows[0] && orgRow.rows[0].organization_id;
  if (!orgId) throw new Error('User has no organization — cannot use watch tools.');

  if (name === 'list_watches') {
    const includeArchived = input && input.include_archived === true;
    const r = await pool.query(`
      SELECT id, name, description, cadence, time_of_day_utc, enabled,
             last_fired_at, next_fire_at, created_at, archived_at,
             SUBSTRING(prompt, 1, 200) AS prompt_preview
        FROM ai_watches
       WHERE organization_id = $1
         ${includeArchived ? '' : 'AND archived_at IS NULL'}
       ORDER BY (CASE WHEN enabled AND archived_at IS NULL THEN 0 ELSE 1 END), created_at DESC
       LIMIT 50
    `, [orgId]);
    if (!r.rows.length) return 'No watches configured yet.';
    const lines = r.rows.map(row => {
      const state =
        row.archived_at ? '[ARCHIVED]' :
        row.enabled ? '[ACTIVE]' : '[DISABLED]';
      const when = row.cadence === 'hourly'
        ? 'every hour'
        : row.cadence + ' at ' + (row.time_of_day_utc || '03:00') + ' UTC';
      const last = row.last_fired_at ? new Date(row.last_fired_at).toISOString() : 'never';
      const next = row.next_fire_at ? new Date(row.next_fire_at).toISOString() : '—';
      return '── ' + row.id + ' ' + state + ' "' + row.name + '" · ' + when +
        '\n   last: ' + last + ' · next: ' + next +
        '\n   prompt: ' + (row.prompt_preview || '') + (row.prompt_preview && row.prompt_preview.length === 200 ? '…' : '');
    });
    return 'Watches (' + r.rows.length + '):\n\n' + lines.join('\n\n');
  }

  if (name === 'read_recent_watch_runs') {
    const limit = Math.max(1, Math.min(50, Number(input && input.limit) || 10));
    const params = [orgId];
    let watchClause = '';
    if (input && input.watch_id) {
      params.push(String(input.watch_id));
      watchClause = ' AND r.watch_id = $2';
    }
    params.push(limit);
    const r = await pool.query(`
      SELECT r.id, r.watch_id, r.status, r.triggered_at, r.started_at, r.finished_at,
             r.input_tokens, r.output_tokens, r.result, r.error,
             w.name AS watch_name,
             EXTRACT(EPOCH FROM (r.finished_at - r.started_at))::int AS duration_seconds
        FROM ai_watch_runs r
        JOIN ai_watches w ON w.id = r.watch_id
       WHERE r.organization_id = $1${watchClause}
       ORDER BY r.triggered_at DESC
       LIMIT $${params.length}
    `, params);
    if (!r.rows.length) return 'No watch runs yet.';
    const lines = r.rows.map(row => {
      const tokens = (Number(row.input_tokens) || 0) + (Number(row.output_tokens) || 0);
      const head = '── ' + row.id + ' [' + row.status + '] "' + row.watch_name + '" · ' +
        new Date(row.triggered_at).toISOString() +
        (row.duration_seconds != null ? ' · ' + row.duration_seconds + 's' : '') +
        ' · ' + tokens + ' tokens';
      if (row.status === 'completed') {
        return head + '\n' + (row.result || '(no result text)').slice(0, 2000);
      }
      if (row.status === 'failed') {
        return head + '\nFAILED: ' + (row.error || 'unknown');
      }
      return head + '\n(' + row.status + ')';
    });
    return 'Recent watch runs (' + r.rows.length + '):\n\n' + lines.join('\n\n');
  }

  throw new Error('Unknown watch read tool: ' + name);
}

function make86OnCustomToolUse(userId, parentSession) {
  // Per-request dedupe cache. Scoped to ONE /86/chat (or /chat/continue)
  // call — closes over this Map. If the model calls e.g.
  // read_materials({q:"PT 2x4"}) twice in the same turn (which it
  // sometimes does when reasoning loops on whether the catalog has the
  // sku), the second invocation returns the cached summary instead of
  // hitting the executor again. Saves real DB work AND prevents the
  // tool result from billing twice as cache_creation on the model's
  // next read of the conversation.
  const dedupeCache = new Map();
  function dedupeKey(name, input) {
    // Stable-stringify by sorting keys so {a:1,b:2} and {b:2,a:1}
    // hash identically. JSON.stringify with default order isn't
    // deterministic across object construction paths.
    try {
      return name + '\0' + JSON.stringify(input || {}, Object.keys(input || {}).sort());
    } catch (_) {
      return name + '\0' + String(input);
    }
  }

  return async function (tu) {
    // Phase 2 — entity-bound write gate. The agent has ~50 tools
    // registered; if it misfires (calls propose_add_line_item when
    // no estimate is open, set_phase_pct_complete with no job in
    // context, etc.), return a structured tool_result error in-band
    // so the model self-corrects instead of executing against the
    // wrong / null entity. Only entity-bound writes are gated
    // (TOOL_REQUIRED_ENTITY map); cross-surface writes (client-
    // directory, intake create, skill packs) intentionally pass.
    const requiredEntity = TOOL_REQUIRED_ENTITY.get(tu.name);
    if (requiredEntity) {
      const activeEntity = parentSession && parentSession.entity_type;
      const activeId     = parentSession && parentSession.entity_id;
      const matches      = (activeEntity === requiredEntity) && !!activeId;
      if (!matches) {
        return {
          tier: 'auto',
          error: 'Tool "' + tu.name + '" requires an active ' + requiredEntity +
                 ' surface (with ' + requiredEntity + '_id) but the current turn is on "' +
                 (activeEntity || 'no entity') + '". Use a cross-surface tool, or ask the user to open the ' +
                 requiredEntity + ' first.'
        };
      }
    }
    // Auto-tier: any tool in ALLOWED_AUTO_TIER_TOOLS executes inline
    // and returns its summary to the model. Mirrors the /exec-tool
    // HTTP dispatcher exactly so the V2-session path (this handler)
    // and the client-chip path (/exec-tool) behave identically.
    //
    // Without this branch, read_past_estimates / read_jobs /
    // read_materials / etc. on the unified /86 chat path were all
    // returning {tier:'approval'} — never executing — and the model
    // saw no result, concluding "no match" on real searches.
    if (ALLOWED_AUTO_TIER_TOOLS.has(tu.name)) {
      const name = tu.name;
      const input = tu.input || {};
      const k = dedupeKey(name, input);
      if (dedupeCache.has(k)) {
        // Soft-warn the model so it knows the loop happened — helps it
        // break out instead of trying yet another identical call.
        const prev = dedupeCache.get(k);
        const note = '[Already returned this turn — same arguments, same result. Use the prior output above instead of recalling.] \n\n' + prev;
        return { tier: 'auto', summary: note };
      }
      try {
        let result;
        if (INTAKE_EXECUTOR_TOOLS.has(name)) {
          result = await execIntakeRead(name, input);
        } else if (FIELD_TOOLS_EXECUTOR_TOOLS.has(name)) {
          result = await execFieldToolRead(name, input);
        } else if (CLIENT_EXECUTOR_TOOLS.has(name)) {
          result = await execClientDirectoryTool(name, input);
        } else if (MEMORY_EXECUTOR_TOOLS.has(name)) {
          result = await execMemoryTool(name, input, { userId });
        } else if (WATCH_EXECUTOR_TOOLS.has(name)) {
          result = await execWatchTool(name, input, { userId });
        } else {
          result = await execStaffTool(name, input, { userId });
        }
        // Structured result with `blocks` (e.g. view_attachment_image
        // returns an image block + text label). Pass it through so
        // runV2SessionStream forwards the content blocks verbatim on
        // the user.custom_tool_result event. Dedupe cache stores a
        // short summary string for repeat-detection — we don't want
        // to re-encode the image into base64 every dedupe lookup.
        if (result && typeof result === 'object' && Array.isArray(result.blocks)) {
          const textPart = result.blocks.find(b => b && b.type === 'text');
          const summary = textPart && textPart.text ? textPart.text : '[image attached]';
          dedupeCache.set(k, summary);
          return { tier: 'auto', summary, blocks: result.blocks };
        }
        const summary = result;
        dedupeCache.set(k, summary);
        return { tier: 'auto', summary };
      } catch (e) {
        return { tier: 'auto', error: 'Error: ' + (e.message || 'failed') };
      }
    }
    // Everything else (propose_*) — approval flow. The card renders
    // on the client; the actual exec happens in /chat/continue when
    // the user clicks Approve.
    return { tier: 'approval' };
  };
}

// ─── Background-agent runner (used only by Phase 5 watches now) ────
// Phase 3 subtask fan-out is retired; driveBgAgentTurn is the
// non-streaming Sessions driver that watch fires reuse. The turn cap
// and per-fire token budget below are shared with the watch path.

const MAX_SUBTASK_TURNS = 30;            // Safety cap to prevent runaway tool loops (kept name for back-compat with watch code)
const SUBTASK_BUDGET_TOKENS = 300000;    // Per-fire token budget — fail-stop above this

// Non-streaming version of runV2SessionStream — just drives a Sessions
// turn to completion, collects assistant text + token usage, and
// returns. No SSE, no nudge logic, no stuck-session recovery (each
// fire opens a fresh session).
//
// Returns { text, usage, error? } where usage = { input_tokens,
// output_tokens, cache_creation_input_tokens, cache_read_input_tokens }.
async function driveSubtaskTurn({ anthropic, sessionId, eventsToSend, onCustomToolUse }) {
  let collectedText = '';
  const aggUsage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0
  };
  let turnCount = 0;
  let nextEvents = eventsToSend;

  while (turnCount < MAX_SUBTASK_TURNS) {
    turnCount++;
    let stream;
    try {
      stream = await anthropic.beta.sessions.events.stream(sessionId);
    } catch (e) {
      return { text: collectedText, usage: aggUsage, error: 'Could not open child session stream: ' + (e.message || 'unknown') };
    }

    if (Array.isArray(nextEvents) && nextEvents.length) {
      try {
        const EVENTS_PER_SEND = 50;
        for (let i = 0; i < nextEvents.length; i += EVENTS_PER_SEND) {
          await anthropic.beta.sessions.events.send(sessionId, {
            events: nextEvents.slice(i, i + EVENTS_PER_SEND)
          });
        }
      } catch (e) {
        try { await stream.controller.abort(); } catch (_) {}
        return { text: collectedText, usage: aggUsage, error: 'Subtask events.send failed: ' + (e.message || 'unknown') };
      }
    }

    const pendingResults = [];
    let turnText = '';
    let idleSeen = false;

    try {
      for await (const event of stream) {
        switch (event.type) {
          case 'agent.message': {
            const blocks = Array.isArray(event.content) ? event.content : [];
            for (const b of blocks) {
              if (b && b.type === 'text' && typeof b.text === 'string') {
                turnText += b.text;
              }
            }
            break;
          }
          case 'agent.custom_tool_use': {
            const tu = {
              id: event.id,
              name: event.tool_name || event.name || 'unknown',
              input: event.input || {}
            };
            let decision;
            try { decision = await onCustomToolUse(tu); }
            catch (e) { decision = { tier: 'auto', error: 'Tool exec threw: ' + (e.message || 'unknown') }; }
            const isError = !!(decision && decision.error);
            const summary = isError ? decision.error : (decision && decision.summary) || 'Done.';
            pendingResults.push({
              type: 'user.custom_tool_result',
              custom_tool_use_id: tu.id,
              content: [{ type: 'text', text: summary }],
              is_error: isError || undefined
            });
            break;
          }
          case 'span.model_request_end': {
            if (event.model_usage) {
              aggUsage.input_tokens += event.model_usage.input_tokens || 0;
              aggUsage.output_tokens += event.model_usage.output_tokens || 0;
              aggUsage.cache_creation_input_tokens += event.model_usage.cache_creation_input_tokens || 0;
              aggUsage.cache_read_input_tokens += event.model_usage.cache_read_input_tokens || 0;
            }
            break;
          }
          case 'session.error': {
            const msg = (event.error && event.error.message) || 'Session error';
            return { text: collectedText + turnText, usage: aggUsage, error: msg };
          }
          case 'session.status_idle': {
            idleSeen = true;
            break;
          }
        }
        if (idleSeen) break;
      }
    } catch (e) {
      return { text: collectedText + turnText, usage: aggUsage, error: 'Subtask stream iteration failed: ' + (e.message || 'unknown') };
    }

    collectedText += turnText;

    // Token-budget fail-stop. Prevents a runaway tool loop from
    // burning unbounded spend if the model misbehaves.
    if (aggUsage.input_tokens + aggUsage.output_tokens > SUBTASK_BUDGET_TOKENS) {
      return { text: collectedText, usage: aggUsage, error: 'Subtask exceeded token budget (' + SUBTASK_BUDGET_TOKENS + ').' };
    }

    if (pendingResults.length === 0) {
      // No tool calls this turn — assistant text is the final reply.
      return { text: collectedText, usage: aggUsage };
    }

    // Tool results to feed back; loop with them as the next events.
    nextEvents = pendingResults;
  }

  return { text: collectedText, usage: aggUsage, error: 'Subtask hit turn cap (' + MAX_SUBTASK_TURNS + '). Likely a tool loop.' };
}

// ─── Phase 5: watch runner + scheduler ────────────────────────────────
//
// A watch fire = creating a fresh Anthropic session, running the
// watch's prompt to completion, persisting the result. Same shape as
// runSubtaskInBackground; reuses driveSubtaskTurn so we keep one
// streaming driver instead of two.
//
// runWatchFire(watchRunId) is the unit of work; the scheduler creates
// one ai_watch_runs row per due watch and enqueues a fire.

async function runWatchFire(watchRunId) {
  const anthropic = getAnthropic();
  if (!anthropic) {
    await pool.query(
      `UPDATE ai_watch_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
      [watchRunId, 'ANTHROPIC_API_KEY not configured.']
    );
    return;
  }

  const lookup = await pool.query(
    `SELECT r.*, w.prompt AS watch_prompt, w.name AS watch_name,
            w.created_by_user_id AS user_id, w.organization_id AS watch_org_id
       FROM ai_watch_runs r
       JOIN ai_watches w ON w.id = r.watch_id
      WHERE r.id = $1`,
    [watchRunId]
  );
  if (!lookup.rows.length) return;
  const row = lookup.rows[0];

  const orgRow = await pool.query(`SELECT * FROM organizations WHERE id = $1`, [row.watch_org_id]);
  const organization = orgRow.rows[0];
  if (!organization) {
    await pool.query(
      `UPDATE ai_watch_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
      [watchRunId, 'Watch organization not found.']
    );
    return;
  }

  const flip = await pool.query(
    `UPDATE ai_watch_runs SET status='running', started_at=NOW()
      WHERE id=$1 AND status='pending' RETURNING id`,
    [watchRunId]
  );
  if (!flip.rows.length) return;

  let sessionId = null;
  try {
    const adminAgents = require('./admin-agents-routes');
    const env = await adminAgents.ensureManagedEnvironment();
    const agent = await adminAgents.ensureManagedAgent('job', organization);

    const created = await anthropic.beta.sessions.create({
      agent: agent.anthropic_agent_id,
      environment_id: env.anthropic_environment_id,
      title: 'Project 86 watch · ' + organization.slug + ' · ' + row.watch_name.slice(0, 60)
    });
    sessionId = created.id;
    await pool.query(`UPDATE ai_watch_runs SET anthropic_session_id=$2 WHERE id=$1`, [watchRunId, sessionId]);

    // Use 86's normal auto-exec, but reject subtask-spawning attempts
    // (a watch is itself a top-level fire; nested fan-out would burn
    // unbounded spend without a user gate). parentSession=null so the
    // wrapper rejects spawn/await/status.
    const baseCallback = make86OnCustomToolUse(row.user_id, null);
    const watchCallback = async (tu) => {
      if (tu.name === 'spawn_subtask' || tu.name === 'await_subtasks' || tu.name === 'subtask_status') {
        return { tier: 'auto', error: 'Watches cannot spawn subtasks (recursion guard). Do the work directly in this fire.' };
      }
      const decision = await baseCallback(tu);
      if (decision && decision.tier === 'approval') {
        return {
          tier: 'auto',
          error: 'Tool "' + tu.name + '" is approval-tier and cannot run inside a watch. Summarize what you would propose instead.'
        };
      }
      return decision;
    };

    const prompt =
      '[You are running as a Project 86 watch — a scheduled fire of a recurring instruction set up by the user. ' +
      'Do the work, then reply with ONE final message containing your findings. ' +
      'No conversational filler; the user will read this asynchronously.]\n\n' +
      String(row.watch_prompt || '');

    const result = await driveSubtaskTurn({
      anthropic,
      sessionId,
      eventsToSend: [{ type: 'user.message', content: [{ type: 'text', text: prompt }] }],
      onCustomToolUse: watchCallback
    });

    await pool.query(
      `UPDATE ai_watch_runs SET
         status = $2, result = $3, error = $4,
         input_tokens = COALESCE(input_tokens,0) + $5,
         output_tokens = COALESCE(output_tokens,0) + $6,
         cache_creation_tokens = COALESCE(cache_creation_tokens,0) + $7,
         cache_read_tokens = COALESCE(cache_read_tokens,0) + $8,
         finished_at = NOW()
       WHERE id = $1`,
      [
        watchRunId,
        result.error ? 'failed' : 'completed',
        result.text || null,
        result.error || null,
        result.usage.input_tokens || 0,
        result.usage.output_tokens || 0,
        result.usage.cache_creation_input_tokens || 0,
        result.usage.cache_read_input_tokens || 0
      ]
    );
  } catch (e) {
    console.error('[watch] runner failed for', watchRunId, e);
    await pool.query(
      `UPDATE ai_watch_runs SET status='failed', error=$2, finished_at=NOW() WHERE id=$1`,
      [watchRunId, (e && e.message) || 'Watch runner error']
    );
  } finally {
    if (sessionId) {
      try { await anthropic.beta.sessions.archive(sessionId); } catch (_) {}
    }
  }
}

// Scheduler tick. Looks for due watches, creates one ai_watch_runs row
// per fire, advances next_fire_at, then enqueues the runner. Race-safe
// via an atomic UPDATE-with-WHERE on next_fire_at — if two ticks fire
// simultaneously, only one will see the row in the "due" state.
async function tickWatchScheduler() {
  try {
    const due = await pool.query(`
      SELECT id, organization_id, cadence, time_of_day_utc, next_fire_at
        FROM ai_watches
       WHERE enabled = true
         AND archived_at IS NULL
         AND next_fire_at <= NOW()
       LIMIT 20
    `);
    for (const w of due.rows) {
      const newNext = computeNextFireAt(w.cadence, w.time_of_day_utc, new Date());
      // CAS update: only fire if next_fire_at still matches what we
      // read. If another scheduler beat us, this row will get 0 rows
      // updated and we skip.
      const cas = await pool.query(
        `UPDATE ai_watches
            SET last_fired_at = NOW(), next_fire_at = $2, updated_at = NOW()
          WHERE id = $1 AND next_fire_at = $3
        RETURNING id`,
        [w.id, newNext, w.next_fire_at]
      );
      if (!cas.rows.length) continue;
      const runId = 'wrn_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
      await pool.query(
        `INSERT INTO ai_watch_runs (id, watch_id, organization_id, status)
         VALUES ($1, $2, $3, 'pending')`,
        [runId, w.id, w.organization_id]
      );
      setImmediate(() => {
        runWatchFire(runId).catch(err => {
          console.error('[watch] fire crashed for', runId, err);
        });
      });
    }
  } catch (e) {
    console.error('[watch] scheduler tick failed:', e);
  }
}

// Start the scheduler. Called once at boot from server/index.js.
// SCHEDULER_INTERVAL_MS = 60s. Calls tickWatchScheduler immediately
// then on each interval. unref() so a leftover timer doesn't keep the
// process alive at shutdown.
function startWatchScheduler() {
  const intervalMs = Number(process.env.WATCH_SCHEDULER_MS) || 60000;
  console.log('[watch] scheduler starting (tick every ' + intervalMs + 'ms)');
  // First tick after 10s to let DB init finish.
  setTimeout(tickWatchScheduler, 10000);
  const handle = setInterval(tickWatchScheduler, intervalMs);
  if (handle.unref) handle.unref();
  return handle;
}

// Legacy /v2/intake/chat (+ /continue) removed — intake now runs
// through /api/ai/86/chat with entity_type='intake'. Caught by
// the LEGACY_CHAT_PATHS 410 intercept at the top of this file.


// POST /api/ai/exec-tool — generic auto-tier read-tool executor.
// 86\'s client-side AUTO_READ_TOOLS appliers POST { name, input }
// here; the server runs execStaffTool inline (the same auto-tier
// read paths the chief of staff uses) and returns the formatted
// result string. One endpoint covers read_materials,
// read_purchase_history, read_subs, read_lead_pipeline — adding a
// new auto-tier read tool just needs a new case in execStaffTool,
// no per-tool endpoint.
//
// Auth: ESTIMATES_VIEW (the cap PMs running 86 sessions already have).
// The tools themselves are read-only — no mutation paths here.
// 86 now inherits CoS-side introspection reads (metrics, conversations,
// skill packs) and directory-side reads (jobs, users) so a single
// chat with 86 can answer "how am I doing" / "who's on this job" / etc.
// without bouncing the user to a different agent panel. Mutation tools
// (propose_skill_pack_*, create_property, etc.) are kept off this auto-
// tier endpoint — those still go through approval cards.

// ── Talk-through tier ───────────────────────────────────────────────
// Tools in this set still require user assent (just like approval-
// tier), but instead of rendering a structured Approve / Reject card
// per tool, the client shows a single inline "Approve / Reject" row
// under 86's prose. 86 is expected (via the talk-through skill pack)
// to describe his plan in prose first, then call one or more of these
// tools in the same turn; the user reads the plan and approves all
// of them in one click.
//
// Excluded: high-stakes / irreversible / structured-form mutations
// (propose_skill_pack_*, delete_client, merge_clients, propose_*_field_
// _tool, propose_watch_*). Those keep the full approval card so the
// admin can review fields one by one.
const TALK_THROUGH_TOOLS = new Set([
  // Scope + line items
  'propose_update_scope',
  'propose_add_line_item',
  'propose_update_line_item',
  'propose_delete_line_item',
  'propose_bulk_update_lines',
  'propose_bulk_delete_lines',
  'propose_add_section',
  'propose_update_section',
  'propose_delete_section',
  // Groups
  'propose_switch_active_group',
  'propose_add_group',
  'propose_rename_group',
  'propose_delete_group',
  'propose_toggle_group_include',
  // Relationships
  'propose_link_to_client',
  'propose_link_to_lead',
  // Estimate metadata + notes
  'propose_update_estimate_field',
  'propose_add_client_note',
  // Lead creation — routine intake action, no structured form needed
  // when 86 talks the user through the values in prose first.
  'propose_create_lead',
  // Job → client linkage (server-applied). Bookkeeping fix-up; 86
  // talks through the mappings and the inline Approve commits them.
  'propose_link_job_to_client',
  'propose_bulk_link_jobs_to_clients'
]);
function tierFor(toolName) {
  return TALK_THROUGH_TOOLS.has(toolName) ? 'talk_through' : 'approval';
}

const ALLOWED_AUTO_TIER_TOOLS = new Set([
  // 86's existing read tools (already routed to execStaffTool below)
  'read_materials',
  'read_purchase_history',
  'read_subs',
  'read_lead_pipeline',
  'read_clients',
  'read_leads',
  'read_past_estimate_lines',
  'read_past_estimates',
  // CoS introspection reads — let 86 audit himself + the team
  'read_metrics',
  'read_recent_conversations',
  'read_conversation_detail',
  'read_skill_packs',
  'search_my_sessions',
  'search_my_kb',
  'search_org_kb',
  // Directory reads — let 86 do who/where/what lookups inline
  'read_jobs',
  'read_users',
  // Company-wide WIP roll-up (financial aggregate across all jobs)
  'read_wip_summary',
  // Intake-side dedup reads — without these in the allowlist 86's
  // pre-lead-create dedup pass renders as approval cards instead of
  // chips. Pure lookups, no mutation.
  'read_existing_clients',
  'read_existing_leads',
  // Field tools listing — chip-style auto-apply so 86 can scan
  // existing tools before proposing a new one.
  'read_field_tools',
  // Self-diagnosis — 86 introspects its own recent proposals + checks
  // whether the corresponding estimate change actually landed. Auto-
  // tier so it runs inline when the user asks "why didn't you do X".
  'self_diagnose',
  // Lazy-loaded attachment body — manifest carries preview only;
  // 86 pulls the full text on demand. Auto-tier (pure read).
  'read_attachment_text',
  // Lazy-loaded attachment IMAGE — pulls the actual pixels of one
  // photo as a vision block in the tool_result. The executor returns
  // a structured { blocks: [...] } shape that runV2SessionStream
  // forwards as content on the user.custom_tool_result event.
  'view_attachment_image',
  // Live reference workbook search — Job Numbers, Short Names, etc.
  // Rows are kept out of the system prompt by default (inject_mode
  // 'lookup'); this tool is how 86 hits them.
  'search_reference_sheet',
  // Lazy-loaded line-item detail — compact roll-ups ship in
  // turn_context for dense estimates; 86 pulls full lines on demand.
  'read_active_lines',
  // Phase 4 — long-term semantic memory tools (executor: execMemoryTool).
  'remember', 'recall', 'list_memories', 'forget',
  // Phase 5 — proactive watch READS (executor: execWatchTool). The
  // WRITES (propose_watch_create / propose_watch_archive) stay
  // approval-tier and surface as cards.
  'list_watches', 'read_recent_watch_runs',
  // Client-directory write tools that are explicitly tier:'auto' in
  // their tool definitions. Routed through execClientDirectoryToolWithCtx
  // (executor needs userId for tools that write attributable rows).
  // Without these in the allowlist, 86 fired them on the global
  // surface → runtime fell through to {tier:'approval'} → N approval
  // cards → session went into requires_action → next turn triggered
  // stuck-session recovery → archive+recreate → fresh session amnesia
  // (the "no prior turn" symptom). Now they actually run inline.
  'update_client_field', 'create_property', 'link_property_to_parent'
]);
// Tools whose executor lives in execClientDirectoryTool (client-directory
// reads and tier:'auto' writes — see ALLOWED_AUTO_TIER_TOOLS above).
const CLIENT_EXECUTOR_TOOLS = new Set([
  'read_jobs', 'read_users', 'read_wip_summary',
  'update_client_field', 'create_property', 'link_property_to_parent'
]);
// Tools whose executor lives in execIntakeRead (intake-side dedup
// against existing clients / leads before creating a new one).
const INTAKE_EXECUTOR_TOOLS = new Set(['read_existing_clients', 'read_existing_leads']);
// Tools whose executor lives in execFieldToolRead.
const FIELD_TOOLS_EXECUTOR_TOOLS = new Set(['read_field_tools']);
// Phase 4 — memory tools route to execMemoryTool.
const MEMORY_EXECUTOR_TOOLS = new Set(['remember', 'recall', 'list_memories', 'forget']);
// Phase 5 — watch READS route to execWatchTool (writes stay approval-tier).
const WATCH_EXECUTOR_TOOLS = new Set(['list_watches', 'read_recent_watch_runs']);

// ════════════════════════════════════════════════════════════════════
// Unified-86 Phase 2 — surface-aware tool availability
// ════════════════════════════════════════════════════════════════════
// The managed agent is registered with one big UNION of every Project
// 86 tool (~50). Per-turn we give 86 two pieces of context to keep its
// search space tight:
//
// 1. <available_tools> hint inside <turn_context> — names the writes
//    that are PRIMARY for the active surface. Reads, memory, watches,
//    web search, navigation, attachment lookups stay implicitly
//    available regardless of surface; only PRIMARY WRITES are listed
//    so the model focuses without losing access to anything.
//
// 2. Hard gate in make86OnCustomToolUse — when the model fires a write
//    tool that requires a specific entity (estimate-id or job-id) but
//    none is open in the active turn, return a structured tool_result
//    error in-band instead of executing. The model self-corrects.
//
// Cross-surface writes (client-directory mutations, intake create,
// skill-pack proposals, watch writes) are NOT gated — the model
// legitimately fires them from anywhere ("add a property under PAC"
// works whether the user is on Ask 86, an estimate, or the directory
// panel). Only entity-bound writes are tied down.

// Map of surface (entity_type) -> primary WRITE tool names.
// Used both for the per-turn <available_tools> hint and as the
// source of truth for which surfaces a tool "belongs to".
const SURFACE_PRIMARY_WRITES = {
  estimate: [
    'propose_add_line_item', 'propose_update_line_item', 'propose_remove_line_item',
    'propose_move_line_item', 'propose_add_section', 'propose_remove_section',
    'propose_rename_section', 'propose_set_scope', 'propose_set_estimate_field',
    'propose_add_client_note', 'request_edit_mode'
  ],
  job: [
    'set_phase_pct_complete', 'set_phase_field', 'set_node_value',
    'wire_nodes', 'create_node', 'set_phase_buildingId', 'propose_change_order'
  ],
  intake: [
    'propose_create_lead'
  ],
  client: [
    'create_property', 'create_parent_company', 'update_client_field',
    'link_property_to_parent', 'rename_client', 'change_property_parent',
    'merge_clients', 'split_client_into_parent_and_property',
    'attach_business_card_to_client'
  ],
  staff: [
    'propose_skill_pack_add', 'propose_skill_pack_edit', 'propose_skill_pack_delete',
    'propose_skill_pack_mirror', 'propose_skill_pack_unmirror',
    'propose_watch_create', 'propose_watch_archive'
  ]
};

// Strict-gate map: tool name -> required entity_type. ONLY the entity-
// bound writes — estimate-mutation tools (need an open estimate) and
// job-mutation tools (need an open job). Off-surface client / intake /
// staff writes are intentionally NOT gated.
//
// IMPORTANT: this list is INTENTIONALLY narrower than
// SURFACE_PRIMARY_WRITES — the hint and the gate serve different
// jobs. SURFACE_PRIMARY_WRITES is informational ("here's what's
// primary for this surface"); TOOL_REQUIRED_ENTITY is enforcement
// ("you cannot fire this without an active entity_id"). Some tools
// (like request_edit_mode) are primary on estimate but legitimately
// fire from job/ask86 — they request a mode flip, they don't write
// to the entity. Listing only writes that DEMAND an entity_id keeps
// the gate from false-positive-blocking legitimate cross-surface
// invocations.
const TOOL_REQUIRED_ENTITY = new Map();
const ESTIMATE_REQUIRED = [
  'propose_add_line_item', 'propose_update_line_item', 'propose_remove_line_item',
  'propose_move_line_item', 'propose_add_section', 'propose_remove_section',
  'propose_rename_section', 'propose_set_scope', 'propose_set_estimate_field',
  'propose_add_client_note'
  // request_edit_mode INTENTIONALLY EXCLUDED — it's read-like (proposes
  // a mode flip, doesn't mutate the entity) and listed in
  // PLAN_MODE_ALLOWED_JOB_TOOLS so 86 fires it legitimately from the
  // job surface too. Gating it would return a structured error and
  // confuse the model into the silent-stop path.
];
const JOB_REQUIRED = [
  'set_phase_pct_complete', 'set_phase_field', 'set_node_value',
  'wire_nodes', 'create_node', 'set_phase_buildingId', 'propose_change_order'
];
for (const n of ESTIMATE_REQUIRED) TOOL_REQUIRED_ENTITY.set(n, 'estimate');
for (const n of JOB_REQUIRED)      TOOL_REQUIRED_ENTITY.set(n, 'job');

// Render the <available_tools> hint block. Returns '' when there's
// no surface (Ask 86 with no entity) — the model already sees the
// full tool list registered on the agent; absence of a hint means
// "use anything appropriate to the user's request".
function renderAvailableToolsBlock(entityType) {
  const writes = SURFACE_PRIMARY_WRITES[entityType];
  if (!Array.isArray(writes) || !writes.length) return '';
  return [
    '<available_tools surface="' + entityType + '">',
    'Primary write tools for this surface (reads, memory, watches, web search, navigation, and attachment lookups remain available everywhere):',
    ...writes.map(n => '  - ' + n),
    '</available_tools>'
  ].join('\n');
}

router.post('/exec-tool', requireAuth, requireCapability('ESTIMATES_VIEW'), async (req, res) => {
  try {
    const name = req.body && req.body.name;
    const input = (req.body && req.body.input) || {};
    if (!name || typeof name !== 'string') return res.status(400).json({ error: 'name is required' });
    if (!ALLOWED_AUTO_TIER_TOOLS.has(name)) return res.status(400).json({ error: 'tool not allowed via this endpoint' });
    let summary;
    if (INTAKE_EXECUTOR_TOOLS.has(name)) {
      summary = await execIntakeRead(name, input);
    } else if (FIELD_TOOLS_EXECUTOR_TOOLS.has(name)) {
      summary = await execFieldToolRead(name, input);
    } else if (CLIENT_EXECUTOR_TOOLS.has(name)) {
      summary = await execClientDirectoryTool(name, input);
    } else {
      summary = await execStaffTool(name, input, { userId: req.user.id });
    }
    res.json({ ok: true, summary });
  } catch (e) {
    console.error('POST /api/ai/exec-tool error:', e);
    res.status(500).json({ error: e.message || 'Server error' });
  }
});

// Internals exposed for sibling modules (eval harness in
// admin-agents-routes). NOT for general use — these bypass the
// streaming + auth flow that production 86 depends on.
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

// ══════════════════════════════════════════════════════════════════════
// LEAD INTAKE TOOLS — fifth agent, lives on the Leads page
//
// Each intake conversation is a fresh session: the user describes a
// new lead in natural language, optionally uploads photos, the agent
// confirms client + project details and proposes propose_create_lead.
// On approval, the lead is INSERTed into `leads` and any photos
// staged in the per-session pending bucket move to leads attachments.
//
// The two read tools mirror the directory surface's tools but are scoped to
// what intake actually needs: dedupe checks against existing clients
// + recent leads at the same property.
// ══════════════════════════════════════════════════════════════════════

const INTAKE_TOOLS = [
  {
    name: 'read_existing_clients',
    tier: 'auto',
    description:
      'Search the Project 86 clients directory for matches on a query string. Returns up to 30 candidates with id, name, parent name (if it is a property), client_type, contact info, and counts of related leads/jobs. ALWAYS run this BEFORE proposing a new lead — if the client already exists (matched by company name OR property name), use its id in propose_create_lead\'s existing_client_id field. Search matches partial strings against client names and parent names case-insensitively.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against client name / parent / company. E.g. "Solace Timacuan", "PAC", "Greystar".' }
      },
      required: ['query']
    }
  },
  {
    name: 'read_existing_leads',
    tier: 'auto',
    description:
      'Search recent leads (last 180 days) by title / property / city. Use this BEFORE proposing a new lead to surface possible duplicates — if the user describes "door replacement at Solace" and there\'s already a lead at that property, the user probably wants to update the existing lead instead of creating a new one. Return summary with id, title, status, client name, last update.',
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Substring to match against lead title / property name / city.' }
      },
      required: ['query']
    }
  },
  {
    name: 'propose_create_lead',
    tier: 'approval',
    description:
      'Create a new lead in the Project 86 leads table. Use either existing_client_id (preferred — found via read_existing_clients) or new_client to create a client first. Always include a thorough notes field summarizing what the user described AND your photo interpretation if photos were uploaded. set attach_pending_photos:true when photos are in the chat — they\'ll move from the temp bucket onto the new lead\'s attachments on approval.',
    input_schema: {
      type: 'object',
      properties: {
        title:           { type: 'string', description: 'Lead title — what the project is. E.g. "Door replacement — Unit 12B", "Exterior soft-wash 5 surfaces". Required.' },
        existing_client_id: { type: 'string', description: 'Existing clients.id matched via read_existing_clients. Use this when the property/company is already in the directory. Mutually exclusive with new_client.' },
        new_client: {
          type: 'object',
          description: 'Inline client to create alongside the lead. Use ONLY when read_existing_clients returned no match. Mutually exclusive with existing_client_id.',
          properties: {
            name:           { type: 'string', description: 'Client name — for a property under a parent management firm, this is the property name (e.g. "Solace Timacuan"). For a standalone homeowner, their full name.' },
            parent_client_id: { type: 'string', description: 'Optional. clients.id of an existing PARENT client (e.g. PAC, Greystar) when this is a managed property under that firm.' },
            client_type:    { type: 'string', description: '"Property" / "Property Mgmt" / "Homeowner" / "Commercial". Match the existing directory conventions.' },
            email:          { type: 'string' },
            phone:          { type: 'string' },
            address:        { type: 'string', description: 'Mailing or billing address (street + city + state if known).' }
          }
        },
        // Property location (where the work is)
        street_address:  { type: 'string', description: 'Property/job-site street address.' },
        city:            { type: 'string' },
        state:           { type: 'string', description: 'Two-letter state code.' },
        zip:             { type: 'string' },
        property_name:   { type: 'string', description: 'Property / community name when distinct from the client (e.g. "Solace Timacuan", "The Esplanade").' },
        market:          { type: 'string', description: 'Market region — Tampa / Orlando / etc.' },
        gate_code:       { type: 'string' },
        // Project metadata
        project_type:    { type: 'string', enum: ['Renovation', 'Service & Repair', 'Work Order'], description: 'Map to one of the three Project 86 values.' },
        source:          { type: 'string', description: 'Where the lead came from (e.g. "Buildertrend", "PM referral", "PAC direct").' },
        salesperson_id:  { type: 'string', description: 'Optional. users.id of the Project 86 salesperson on this lead.' },
        // Estimated revenue
        estimated_revenue_low:  { type: 'number', description: 'Low end of est. revenue range in $.' },
        estimated_revenue_high: { type: 'number', description: 'High end. Set both equal for a single number.' },
        confidence:      { type: 'integer', description: '0–100 confidence the lead will close.' },
        projected_sale_date: { type: 'string', description: 'YYYY-MM-DD when the user expects to close.' },
        // Notes — capture EVERYTHING the user said + photo summary
        notes:           { type: 'string', description: 'Full free-form notes. Capture the user\'s description verbatim plus your photo interpretation ("uploaded 3 photos: 36-inch fiberglass entry door with 2 sidelights, weathered jamb, no visible rot on threshold"). Worth being thorough — these notes drive 86\'s estimate later.' },
        attach_pending_photos: { type: 'boolean', description: 'Set true when photos were uploaded in this chat. The handler will move them from the per-session temp bucket onto leads.<new_id>.attachments on approval.' },
        rationale:       { type: 'string', description: 'One short sentence — why you\'re proposing this lead now (mostly used for audit on review).' }
      },
      required: ['title', 'rationale']
    }
  }
];

// ──────────────────────────────────────────────────────────────────
// Global "Ask 86" — entity-less chat surface backed by 86 (the
// operator). Reachable from a header button anywhere in the app
// so users can ask 86 anything without first navigating to a job
// or estimate. Persisted per-user (entity_type='ask86', entity_id
// is fixed at 'global'); only web_search + the auto-injected
// reference sheets are available — no entity-mutating tools since
// there's no entity to mutate.
//
// Tools surface intentionally narrow for v1: this is a "talk to 86
// as a general-purpose helper" surface, not a place to propose
// concrete edits. If a user asks 86 to make a change, 86 should
// direct them to open the relevant entity's AI panel.
// ──────────────────────────────────────────────────────────────────
async function buildAsk86Context() {
  const stable = [];
  stable.push('You are 86, Project 86\'s lead operator agent. Project 86 is a Central-Florida construction-services platform (painting, deck repair, roofing, exterior services for HOAs and apartment communities). The user is talking to you from the global "Ask 86" surface — there is NO specific entity (estimate / job / client / lead) attached to this conversation.');
  stable.push('');
  stable.push('# Your scope');
  stable.push('  You are the company\'s primary AI surface. You take questions about anything — leads, estimates, jobs, WIP, margins, the team, costs — and either answer directly or point the user at the right entity panel for deeper work.');
  stable.push('  The Chief of Staff (the auditor) is your sub-specialist for admin metrics + skill-pack stewardship; you can read across that domain via the tools below, and the admin can open the dedicated CoS panel directly. Your client-directory powers (dedupe, hierarchy, business cards) are also available from here — no separate agent.');
  stable.push('');
  stable.push('# Tools available here');
  stable.push('  ## Read tools (auto-execute, no approval)');
  stable.push('  • `read_jobs(q?, status?, limit?)` — job directory lookup (jobNumber, title, client, address, PM).');
  stable.push('  • `read_users(q?, role?, active_only?, limit?)` — staff directory lookup.');
  stable.push('  • `read_clients(q?, limit?)` — client directory lookup.');
  stable.push('  • `read_subs(q?, trade?, status?, with_expiring_certs?, limit?)` — subcontractor directory.');
  stable.push('  • `read_lead_pipeline(q?, status?, market?, salesperson_email?, limit?)` — leads + pipeline rollup.');
  stable.push('  • `read_materials(q?, subgroup?, category?, limit?)` — material catalog (with last-paid pricing).');
  stable.push('  • `read_purchase_history(material_id?, q?, days?, job_name?, limit?)` — receipt-level material rows.');
  stable.push('  • `read_metrics(range)` — agent-usage metrics (turns, tokens, cost) for last 7d / 30d.');
  stable.push('  • `read_recent_conversations(range, entity_type?, limit?)` — list recent agent conversations.');
  stable.push('  • `read_conversation_detail(key)` — full message log of a specific conversation.');
  stable.push('  • `read_skill_packs()` — list all skill packs registered for this org (names + truncated bodies + Anthropic skill_ids). Use for self-introspection; the full bodies are live as native Anthropic Skills and the runtime auto-surfaces them by description.');
  stable.push('  • `web_search` — pricing, code references, product specs, supplier research.');
  stable.push('  • `navigate({ destination, entity_id? })` — take the user to a page or entity. Use when they say "go to", "open", "show me", "take me to". Destinations: home / leads / estimates / clients / subs / schedule / wip / insights / admin, or job / estimate / lead with entity_id. When the user references an entity by name or number, call read_jobs / read_clients / read_past_estimates first to resolve the id, THEN navigate.');
  stable.push('  Live reference sheets (job-number lookup, WIP report, etc.) are auto-injected below — use them for company-data answers without burning a tool call.');
  stable.push('');
  stable.push('# Mutation tools you have here');
  stable.push('  You CAN make changes from this surface:');
  stable.push('  • `propose_create_lead` — capture a new lead in one shot. ALWAYS call `read_existing_clients` first to dedupe; if the client exists, pass its id as `existing_client_id`. Same flow as the dedicated intake panel.');
  stable.push('  • Client-directory tools — `create_property`, `create_parent_company`, `update_client_field`, `link_property_to_parent`, `rename_client`, `change_property_parent`, `merge_clients`, `split_client_into_parent_and_property`, `attach_business_card_to_client`. Use these inline so the user does not have to open the Directory panel for routine work.');
  stable.push('  • Skill-pack changes — `propose_skill_pack_add` / `_edit` / `_delete`. Approval-tier; the user vets every prompt-shaping change. Mirroring to Anthropic native Skills happens automatically on approval.');
  stable.push('');
  stable.push('# What lives on the per-entity panels (not here)');
  stable.push('  Tools that operate on a SPECIFIC open entity — `propose_add_line_item`, `propose_update_line_item`, `set_phase_pct_complete`, `set_node_value`, `wire_nodes`, `create_node`, etc. — are NOT in the global Ask 86 tool list because they require the entity\'s editor / graph to be open client-side. If the user asks to "add a line to estimate X" or "tweak phase Y on job Z", point them at the right entity panel and offer to draft the exact wording they should paste in.');
  stable.push('  You also can\'t see a specific job\'s live WIP detail, a specific estimate\'s line items, etc., unless the user supplies them in the conversation. Those live in the per-entity context that the dedicated panel-AIs build. Use `read_jobs` / `read_clients` / `read_past_estimates` for the identity-card view from here.');
  stable.push('');
  stable.push('# Tone');
  stable.push('  Concise. Construction trade vocabulary welcome. Lead with the answer, not the framing. If the user\'s question would be better answered inside a specific entity\'s AI panel, say so up front so they don\'t spin their wheels here.');

  // Skill packs live as native Anthropic Skills registered on the
  // agent. The runtime auto-discovers them by description each turn —
  // no system-prompt manifest, no load_skill_pack round-trip needed.
  return {
    system: [
      { type: 'text', text: stable.join('\n'), cache_control: { type: 'ephemeral' } }
    ]
  };
}

// Tools available on the global Ask 86 surface. 86 here is the full
// operator — he can create leads, audit conversations, propose client
// edits, push skill-pack changes, etc. Entity-scoped mutations
// (propose_add_line_item, set_phase_pct_complete, etc.) are NOT
// included since they need an open editor on the client side; for
// those, the user opens the entity panel where the mutation belongs.
function ask86Tools() {
  const wanted = new Set([
    // Reads — cross-surface (CoS introspection + client directory)
    'read_jobs', 'read_users', 'read_clients',
    'read_subs', 'read_lead_pipeline',
    'read_materials', 'read_purchase_history',
    'read_metrics', 'read_recent_conversations', 'read_conversation_detail',
    'read_skill_packs', 'search_my_sessions', 'search_my_kb', 'search_org_kb',
    'search_reference_sheet', 'view_attachment_image', 'read_attachment_text',
    'read_past_estimates', 'read_past_estimate_lines', 'read_leads',
    // DOM navigation — client-side dispatch. Without this, the model
    // on the Ask 86 surface doesn't know it can switch tabs / open
    // entities, so "take me to X" prompts come back as empty text.
    'navigate'
  ]);
  const fromJob = JOB_TOOLS.filter(t => wanted.has(t.name));
  const intake  = INTAKE_TOOLS.map(({ tier, ...t }) => t);
  const client  = ClientDirectoryTools.map(({ tier, ...t }) => t);
  // Dedupe — read_clients / read_jobs / read_users etc. live in
  // both JOB_TOOLS (cross-surface reads added when 86 took the full
  // company scope) and ClientDirectoryTools / INTAKE_TOOLS (directory-
  // surface originals).
  // Anthropic's API rejects requests with duplicate tool names
  // ("tools: Tool names must be unique"), which surfaced as empty
  // responses on the Ask 86 panel. First entry wins.
  const seen = new Set();
  const merged = [];
  [...fromJob, ...intake, ...client].forEach(t => {
    if (!t || !t.name || seen.has(t.name)) return;
    seen.add(t.name);
    merged.push(t);
  });
  return merged;
}

// Legacy V1 /ask86/* routes — replaced by managed-agents V2 at
// /api/ai/86/*. Frontend has been migrated; these stubs surface a
// clear 410 if any stale client retries the old path.
router.all('/ask86/messages', requireAuth, (req, res) => {
  res.status(410).json({ error: 'Removed. Use /api/ai/86/messages (managed-agents V2).' });
});

// Legacy /ask86/chat (+ /chat/continue) stubs removed — caught by
// the LEGACY_CHAT_PATHS 410 intercept at the top of this file.

// ══════════════════════════════════════════════════════════════════════
// Unified 86 — ONE chat surface across the whole system
// ══════════════════════════════════════════════════════════════════════
//
// User's intent: "I want one unified 86 across the whole system, self
// aware of what page the user is on and what they are working on,
// and able to navigate where the user needs to be."
//
// The legacy split (per-entity panels each with their own chat
// endpoint + Ask 86 on V1 messages.stream) is gone here. This single
// surface:
//   - Uses the managed `job` agent (69-tool union: estimate +
//     job + client + intake + reads + navigate).
//   - Loads/creates ONE session per user via beta.sessions —
//     keyed on (agent_key='job', entity_type='86', entity_id='global',
//     user_id). Same agent_id, same conversation continuity wherever
//     the user is in the app.
//   - Each turn carries a `current_context` block describing the
//     user's current page + open entity. 86 reads this on every turn
//     to know "where are we / what's on screen."
//   - Native Skills attached to the managed `job` agent via
//     managed_agent_skills load automatically.
//
// Endpoints:
//   GET    /api/ai/86/messages          → history
//   DELETE /api/ai/86/messages          → clear
//   POST   /api/ai/86/chat              → user turn
//   POST   /api/ai/86/chat/continue     → tool approval continuation

// Render the per-turn page context as a tagged block so the model
// has a clean separator between "where you are" data and the user's
// actual message. Wrapping in <page_context> mirrors the
// <turn_context> convention used by buildJobContext callers.
function renderPageContextBlock(ctx) {
  if (!ctx || typeof ctx !== 'object') return '';
  const lines = ['<page_context>'];
  if (ctx.page)           lines.push('page: ' + String(ctx.page));
  if (ctx.entity_type)    lines.push('entity_type: ' + String(ctx.entity_type));
  if (ctx.entity_id)      lines.push('entity_id: ' + String(ctx.entity_id));
  if (ctx.entity_label)   lines.push('entity_label: ' + String(ctx.entity_label));
  if (ctx.url)            lines.push('url: ' + String(ctx.url));
  if (ctx.open_data_summary) lines.push('open_data_summary:\n  ' + String(ctx.open_data_summary).split('\n').join('\n  '));
  lines.push('</page_context>');
  return lines.join('\n');
}

// Phase 3 subtask polling endpoint removed — fan-out is retired.
router.get('/subtasks', requireAuth, (req, res) => res.json({ subtasks: [], retired: true }));

router.get('/86/messages', requireAuth, async (req, res) => {
  try {
    // Multi-session: when the sidebar passes ?session_id=N, return
    // that session's history (keyed by its own entity_type+entity_id).
    // Without session_id we fall back to the legacy "all entity_type='86'
    // rows" query so any caller that hasn't migrated still works.
    const sessionId = req.query && (req.query.session_id || req.query.sessionId);
    if (sessionId) {
      const sid = parseInt(sessionId, 10);
      if (!Number.isFinite(sid)) return res.status(400).json({ error: 'invalid session_id' });
      const sr = await pool.query(
        `SELECT entity_type, entity_id FROM ai_sessions WHERE id = $1 AND user_id = $2`,
        [sid, req.user.id]
      );
      if (!sr.rows.length) return res.status(404).json({ error: 'session not found' });
      const s = sr.rows[0];
      const mr = await pool.query(
        `SELECT id, role, content, created_at
           FROM ai_messages
          WHERE user_id = $1
            AND entity_type = $2
            AND COALESCE(estimate_id, '') = COALESCE($3, '')
          ORDER BY created_at ASC`,
        [req.user.id, s.entity_type, s.entity_id]
      );
      return res.json({ messages: mr.rows });
    }
    const r = await pool.query(
      `SELECT id, role, content, created_at
         FROM ai_messages
        WHERE entity_type='86' AND user_id=$1
        ORDER BY created_at ASC`,
      [req.user.id]
    );
    res.json({ messages: r.rows });
  } catch (e) {
    console.error('GET /86/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.delete('/86/messages', requireAuth, async (req, res) => {
  try {
    // Archive the Anthropic-side session too so the next chat starts
    // with a clean Anthropic context — otherwise the cleared local
    // history desyncs from the agent's still-loaded events.
    const sessionRow = await pool.query(
      `SELECT id, anthropic_session_id FROM ai_sessions
        WHERE agent_key='job' AND entity_type='86'
          AND entity_id='global' AND user_id=$1 AND archived_at IS NULL`,
      [req.user.id]
    );
    if (sessionRow.rows.length) {
      const s = sessionRow.rows[0];
      try {
        const anthropic = getAnthropic();
        if (anthropic) await anthropic.beta.sessions.archive(s.anthropic_session_id);
      } catch (_) { /* best-effort archive */ }
      await pool.query(`UPDATE ai_sessions SET archived_at = NOW() WHERE id = $1`, [s.id]);
    }
    await pool.query(
      `DELETE FROM ai_messages WHERE entity_type='86' AND user_id=$1`,
      [req.user.id]
    );
    res.json({ ok: true });
  } catch (e) {
    console.error('DELETE /86/messages error:', e);
    res.status(500).json({ error: e.message });
  }
});

router.post('/86/chat', requireAuth, requireOrg, async (req, res) => {
  const anthropic = getAnthropic();
  if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
  if (!FLAG_AGENT_MODE_86) {
    return res.status(503).json({ error: 'Unified 86 path requires AGENT_MODE_86=agents on the server.' });
  }
  const userMessage = (req.body && req.body.message || '').trim();
  if (!userMessage) return res.status(400).json({ error: 'message is required' });

  const currentContext = (req.body && req.body.current_context) || null;
  // Sidebar-driven multi-session: the client can pin a specific
  // session by id (user picked it from the sidebar), or omit it and
  // let the auto-anchor logic resolve from current_context. The
  // resolution happens after history load below so we can use the
  // session's own entity_type/entity_id to key the inserts.
  const explicitSessionId = req.body && (req.body.session_id || req.body.sessionId);
  const additionalImages = Array.isArray(req.body && req.body.additional_images)
    ? req.body.additional_images.slice(0, 12)
    : [];

  setSSEHeaders(res);
  try {
    // ── Per-entity context enrichment (Phase 2 unification) ──
    // If current_context names an entity (job / estimate / intake),
    // load the same per-turn data block the legacy per-entity chat
    // endpoints used to build server-side. Result is a <turn_context>
    // block that 86 sees alongside the user message, so it has all
    // the WIP / line-item / lead data it used to.
    //
    // Photos: when the active entity is a job or estimate, attach
    // uploaded images to that entity's attachments table — mirrors
    // legacy /v2/jobs/:id/chat and /v2/estimate-chat behavior.
    //
    // The session is ALWAYS the unified per-user session (one rolling
    // thread across the app). Entity context is per-turn, not per-
    // session, so switching pages doesn't fork the conversation.
    let turnContextText = '';
    const cctxEntityType = currentContext && currentContext.entity_type;
    const cctxEntityId   = currentContext && currentContext.entity_id;
    // Default phase for /86/chat is **build** — this endpoint is hit
    // from both the in-editor chat AND the floating Ask 86 widget; in
    // either case the user just typed a request, so unless the panel
    // explicitly signals plan we want write-tools available. The per-
    // estimate Plan/Build toggle still wins (handled in
    // buildEstimateContext when the override below is not supplied).
    // Map the client's per-entity phase ('plan' | 'edit' | 'auto') to
    // the server tool filter: only 'plan' filters propose_* tools off;
    // 'edit' and 'auto' both get the full tool set. 'auto' is purely
    // a client-side flag that auto-fires whitelisted line tools without
    // surfacing approval cards — the server doesn't need to know.
    // Legacy 'build' coerces to 'edit'.
    const cctxAiPhase    = (currentContext && currentContext.aiPhase) === 'plan' ? 'plan' : 'edit';
    const cctxClientCtx  = (currentContext && currentContext.clientContext) || null;

    let extraPhotoBlocks = []; // photos pulled from the entity itself (job WIP, estimate, lead)

    // Phase 1 of the unified-86 cutover: single dispatcher that routes
    // to the per-entity context builders. Byte-identical to the prior
    // if/else cascade — same calls, same args, same outputs. Future
    // phases collapse the builders themselves into one, but this entry
    // point gives every surface a single seam to swap.
    //
    // ctxDynamicText (not ctxSystemToText) — only the per-turn dynamic
    // block ships in the user.message. The stable SECTION_DEFAULTS
    // playbook is baked into the registered Anthropic agent system
    // prompt via composedAgentSystem, so duplicating it through
    // user.message would just bill it as cache_creation every turn.
    // Always-on skill packs are merged INTO the dynamic block by each
    // builder for the same reason. Photos are reachable via the
    // view_attachment_image tool by id; the manifest still lists every
    // photo so 86 knows what's available without bloating each turn.
    try {
      const turnCtx = await buildTurnContext({
        entityType:    cctxEntityType,
        entityId:      cctxEntityId,
        clientContext: cctxClientCtx,
        aiPhase:       cctxAiPhase,
        userId:        req.user.id,
        organization:  req.organization,
      });
      turnContextText  = turnCtx.turnContextText;
      extraPhotoBlocks = turnCtx.photoBlocks;
    } catch (e) {
      console.warn('[/86/chat] per-entity context build skipped:', e.message);
    }

    // Auto-attach uploaded photos to whichever entity is open (best-
    // effort — failures don't block the chat from sending).
    if (additionalImages.length) {
      try {
        if (cctxEntityType === 'job' && cctxEntityId) {
          await attachBase64PhotosToEntity('job', cctxEntityId, additionalImages, req.user.id, 'chat-photo');
        } else if (cctxEntityType === 'estimate' && cctxEntityId) {
          await attachBase64PhotosToEntity('estimate', cctxEntityId, additionalImages, req.user.id, 'chat-photo');
        } else if (cctxEntityType === 'intake') {
          // Intake uses the per-user staging bucket — photos move to
          // the new lead's attachments on propose_create_lead approval.
          stashPendingIntakeImages(req.user.id, additionalImages);
        }
        // 'ask86' / no entity_type → no attachment; photos still go
        // inline as vision content below.
      } catch (e) {
        console.warn('[/86/chat] photo attach skipped:', e.message);
      }
    }

    // Build the per-turn user message. <turn_context> (per-entity
    // snapshot) comes first if present, then the page-context tag
    // (where the user is in the app), then the actual message text.
    // Reference sheets (SharePoint / Google Sheets — job numbers,
    // WIP report, client short names) are now baked into the
    // registered agent system prompt via composedAgentSystem, so
    // Anthropic caches them and they cost zero tokens per turn.
    // The 15-min refresh tick re-syncs the agent only when content
    // changes (see syncAgentIfReferenceChanged).
    const pageBlock = renderPageContextBlock(currentContext);
    const turnTextParts = [];
    if (turnContextText) turnTextParts.push('<turn_context>\n' + turnContextText + '\n</turn_context>');
    if (pageBlock) turnTextParts.push(pageBlock);
    turnTextParts.push(userMessage);
    const turnText = turnTextParts.join('\n\n');

    // Compose inline vision content: entity photos (cascaded from
    // buildXContext.photoBlocks) plus any photos the user uploaded
    // this turn. Cap at 18 to stay under Anthropic's per-turn vision
    // budget.
    const uploadedBlocks = additionalImages
      .map(b64 => inlineImageBlock(b64))
      .filter(Boolean);
    const inlineImageBlocks = [...extraPhotoBlocks, ...uploadedBlocks].slice(0, 18);

    const userContent = inlineImageBlocks.length
      ? [...inlineImageBlocks, { type: 'text', text: turnText }]
      : [{ type: 'text', text: turnText }];

    // Resolve which session this turn belongs to. Order of precedence:
    //   explicit session_id from the sidebar pick → entity-anchored
    //   match (job/estimate/lead/intake) → user's "General" session.
    // Resolve BEFORE inserting the user message so the row gets keyed
    // by the session's own (entity_type, entity_id).
    const session = await resolveSessionForChat({
      sessionId: explicitSessionId,
      currentContext,
      userId: req.user.id,
      organization: req.organization
    });
    // ai_messages.estimate_id is NOT NULL on the legacy schema. Older
    // general-session rows might still have entity_id=null in
    // ai_sessions (pre-fix); coalesce to 'global' at every insert so
    // the chat path never trips the constraint.
    const sessionEntityId = session.entity_id || 'global';

    // Persist the user's message under the resolved session's keys.
    // estimate_id is the legacy column name for "entity_id" on
    // ai_messages — kept as-is to avoid a wider migration.
    //
    // Unified-86 Phase 4b — when the resolved session is a user-thread
    // (one rolling Anthropic session for the user), the session's
    // own entity_type is 'general' / entity_id 'global'. The real
    // per-turn surface lives in currentContext. Record THAT on
    // ai_messages so per-surface analytics, deep-link routing, and
    // replay accuracy keep working. Legacy partitioned sessions
    // continue to use the session values (entity_type matches by
    // construction).
    const isUserThread = session.session_kind === 'user_thread';
    const turnEntityType = isUserThread
      ? (cctxEntityType || session.entity_type)
      : session.entity_type;
    const turnEntityId = isUserThread
      ? (cctxEntityId ? String(cctxEntityId) : sessionEntityId)
      : sessionEntityId;
    const userMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    await pool.query(
      `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, photos_included, inline_image_blocks)
       VALUES ($1, $2, $3, $4, 'user', $5, $6, $7::jsonb)`,
      [
        userMsgId,
        turnEntityType,
        turnEntityId,
        req.user.id, userMessage, additionalImages.length,
        uploadedBlocks.length ? JSON.stringify(uploadedBlocks) : null
      ]
    );

    // Track activity + turn counter so the sidebar can order by
    // recency and show "12 turns" badges. last_used_at is what the
    // sidebar's pinned-then-recent sort keys on.
    await pool.query(
      `UPDATE ai_sessions
          SET last_used_at = NOW(),
              turn_count = turn_count + 1
        WHERE id = $1`,
      [session.id]
    );

    await runV2SessionStream({
      anthropic, res,
      session: session,
      eventsToSend: [{ type: 'user.message', content: userContent }],
      // Same auto-tier handler that the per-entity panels use — gives
      // 86 chip-style read_existing_clients / _leads + intake reads
      // anywhere in the app.
      onCustomToolUse: make86OnCustomToolUse(req.user.id, session),
      // When ensureAiSession just minted this session (first /86/chat
      // for the user, or a stuck-session recovery upstream), skip the
      // archive-and-retry recovery path inside runV2SessionStream —
      // otherwise a freshly-created session that the API reports as
      // stuck would archive itself in a loop. See BUG #7.
      freshlyCreated: !!(session && session._freshlyCreated),
      persistAssistantText: async (text, usage, meta) => {
        // Skip only when there's nothing worth keeping — empty text AND
        // no tool_uses meta. Awaiting-approval turns with zero prose
        // but non-empty tool_uses still write a row so introspection
        // can see what was proposed.
        const hasText = !!(text && String(text).trim());
        const toolUses = (meta && Array.isArray(meta.tool_uses)) ? meta.tool_uses : null;
        const toolUseCount = (meta && Number.isInteger(meta.tool_use_count))
          ? meta.tool_use_count
          : (toolUses ? toolUses.length : 0);
        if (!hasText && !toolUseCount) return;
        const aMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await pool.query(
          `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                    input_tokens, output_tokens,
                                    cache_creation_input_tokens, cache_read_input_tokens,
                                    tool_use_count, tool_uses)
           VALUES ($1, $2, $3, $4, 'assistant', $5, $6, $7, $8, $9, $10, $11, $12)`,
          [aMsgId, turnEntityType, turnEntityId, req.user.id, text || '', MODEL,
           (usage && usage.input_tokens) || null,
           (usage && usage.output_tokens) || null,
           (usage && usage.cache_creation_input_tokens) || null,
           (usage && usage.cache_read_input_tokens) || null,
           toolUseCount,
           toolUses ? JSON.stringify(toolUses) : null]
        );

        // Background auto-label: on the very first exchange (the
        // user message we just inserted was turn 1, and this is
        // the corresponding assistant reply), kick off a label /
        // summary generator. setImmediate so it runs after this
        // response is fully flushed.
        if (session._freshlyCreated || session.turn_count <= 1) {
          setImmediate(() => {
            maybeGenerateSessionLabel(session.id).catch(() => {});
          });
        }
      }
    });
  } catch (e) {
    console.error('POST /86/chat error:', e);
    try {
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (_) {}
  }
});

router.post('/86/chat/continue', requireAuth, requireOrg, async (req, res) => {
  const anthropic = getAnthropic();
  if (!anthropic) return res.status(503).json({ error: 'AI assistant is not configured.' });
  if (!FLAG_AGENT_MODE_86) {
    return res.status(503).json({ error: 'Unified 86 path requires AGENT_MODE_86=agents on the server.' });
  }
  const toolResults = req.body && req.body.tool_results;
  if (!Array.isArray(toolResults) || !toolResults.length) {
    return res.status(400).json({ error: 'tool_results is required' });
  }
  // Continue handler also accepts an explicit session_id so the
  // approval card always lands on the same session the proposing
  // turn used — even if the user has clicked a different sidebar row
  // between proposal and approval.
  const continueSessionId = req.body && (req.body.session_id || req.body.sessionId);

  setSSEHeaders(res);
  try {
    let session = null;
    if (continueSessionId) {
      const sid = parseInt(continueSessionId, 10);
      if (Number.isFinite(sid)) {
        const r = await pool.query(
          `SELECT * FROM ai_sessions WHERE id = $1 AND user_id = $2 AND archived_at IS NULL`,
          [sid, req.user.id]
        );
        if (r.rows.length) session = r.rows[0];
      }
    }
    if (!session) {
      // Fallback: any active session for this user. Picks the
      // most-recent, which is almost certainly the one the approval
      // card came from. Preserves legacy behavior where the continue
      // handler "just worked" without a session_id.
      const r = await pool.query(
        `SELECT * FROM ai_sessions
           WHERE user_id = $1 AND archived_at IS NULL
           ORDER BY last_used_at DESC LIMIT 1`,
        [req.user.id]
      );
      if (r.rows.length) session = r.rows[0];
    }
    if (!session) {
      res.write('data: ' + JSON.stringify({ error: 'No active session — start a new turn.' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    // Coalesce to the legacy 'global' sentinel — older general
    // sessions still have entity_id=null in ai_sessions and
    // ai_messages.estimate_id is NOT NULL.
    const sessionEntityId = session.entity_id || 'global';

    // Build tool_result events for each approval, applying server-side
    // any approval-tier propose_* tools the same way the per-entity
    // panels do. propose_create_lead routes through execProposeCreateLead;
    // Client-directory mutations route through execClientDirectoryToolWithCtx; estimate
    // / job entity writes echo the client-supplied applied_summary
    // (those were applied client-side by the editor's tool dispatcher).
    const eventsToSend = [];
    for (const r of toolResults) {
      let summary;
      let isError = false;
      // Client-side apply threw (BUG #6 path). Tag as is_error so the
      // agent reacts as if the tool errored — different remediation
      // than a user-driven reject (retry vs. ask follow-up).
      if (r.apply_error) {
        summary = 'ERROR applying ' + (r.name || 'tool') + ': ' + r.apply_error +
                  ' (client-side mutation failed — propose a corrected version, or ask the user what to do).';
        isError = true;
      } else if (!r.approved) {
        summary = r.reject_reason || 'User rejected this proposal.';
      } else if (r.name === 'propose_create_lead') {
        try { summary = await execProposeCreateLead(r.input || {}, req.user.id); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else if (r.name === 'propose_link_job_to_client') {
        try { summary = await execLinkJobToClient(r.input || {}); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else if (r.name === 'propose_bulk_link_jobs_to_clients') {
        try { summary = await execBulkLinkJobsToClients(r.input || {}); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else if (r.name === 'propose_create_field_tool'
              || r.name === 'propose_update_field_tool'
              || r.name === 'propose_delete_field_tool') {
        try { summary = await execFieldToolApproval(r.name, r.input || {}, req.user.id); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else if (r.name === 'propose_skill_pack_add'
              || r.name === 'propose_skill_pack_edit'
              || r.name === 'propose_skill_pack_delete') {
        // Skill-pack mutations (formerly CoS-only — 86 owns these
        // now that the staff agent is being absorbed). Same handler
        // as the legacy /staff/chat/continue path.
        try { summary = await execStaffApprovalTool(r.name, r.input || {}, { userId: req.user.id }); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else if (ClientDirectoryTools.some(t => t.name === r.name)) {
        try { summary = await execClientDirectoryToolWithCtx(r.name, r.input || {}, { userId: req.user.id }); }
        catch (e) { summary = 'Error: ' + (e.message || 'failed'); isError = true; }
      } else {
        summary = r.applied_summary || 'User approved. Change applied.';
      }
      // V2 sessions expect user.custom_tool_result events with
      // custom_tool_use_id (NOT the v1 messages-API shape of
      // {type:'tool_result', tool_use_id}). My initial /86/chat/continue
      // used the v1 shape and Anthropic 400'd ("events[0].type:
      // tool_result is not a valid value"), which made tool approvals
      // silently fail — the user clicked Approve, the server tried to
      // POST results, Anthropic rejected, no field tool got created.
      eventsToSend.push({
        type: 'user.custom_tool_result',
        custom_tool_use_id: r.tool_use_id,
        content: [{ type: 'text', text: summary }],
        is_error: isError || undefined
      });
    }

    // Persist a row capturing what the user just approved/rejected so
    // self_diagnose can answer "did my proposal land?". We write this
    // BEFORE re-entering the stream — even if the next turn errors,
    // we still know which tool_use_ids were accepted.
    try {
      const continueMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
      const approvalSummary = toolResults.map(r => ({
        tool_use_id: r.tool_use_id,
        name: r.name,
        approved: !!r.approved,
        applied_summary: r.applied_summary || null,
        reject_reason: r.reject_reason || null
      }));
      await pool.query(
        `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                  tool_use_count, tool_uses)
         VALUES ($1, $2, $3, $4, 'user', $5, $6, $7, $8)`,
        [continueMsgId, session.entity_type, sessionEntityId, req.user.id,
         '[tool_results: ' + approvalSummary.map(a =>
           (a.approved ? '✓ ' : '✗ ') + a.name +
           (a.applied_summary ? ' — ' + a.applied_summary.slice(0, 80) : '')
         ).join(' | ') + ']',
         MODEL, approvalSummary.length,
         JSON.stringify(approvalSummary)]
      );
    } catch (e) {
      console.warn('[/86/chat/continue] approval trace insert failed:', e.message);
    }

    await runV2SessionStream({
      anthropic, res,
      session: session,
      eventsToSend: eventsToSend,
      onCustomToolUse: make86OnCustomToolUse(req.user.id, session),
      persistAssistantText: async (text, usage, meta) => {
        const hasText = !!(text && String(text).trim());
        const toolUses = (meta && Array.isArray(meta.tool_uses)) ? meta.tool_uses : null;
        const toolUseCount = (meta && Number.isInteger(meta.tool_use_count))
          ? meta.tool_use_count
          : (toolUses ? toolUses.length : 0);
        if (!hasText && !toolUseCount) return;
        const aMsgId = 'aim_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
        await pool.query(
          `INSERT INTO ai_messages (id, entity_type, estimate_id, user_id, role, content, model,
                                    input_tokens, output_tokens,
                                    cache_creation_input_tokens, cache_read_input_tokens,
                                    tool_use_count, tool_uses)
           VALUES ($1, $2, $3, $4, 'assistant', $5, $6, $7, $8, $9, $10, $11, $12)`,
          [aMsgId, session.entity_type, sessionEntityId, req.user.id, text || '', MODEL,
           (usage && usage.input_tokens) || null,
           (usage && usage.output_tokens) || null,
           (usage && usage.cache_creation_input_tokens) || null,
           (usage && usage.cache_read_input_tokens) || null,
           toolUseCount,
           toolUses ? JSON.stringify(toolUses) : null]
        );
      }
    });
  } catch (e) {
    console.error('POST /86/chat/continue error:', e);
    try {
      res.write('data: ' + JSON.stringify({ error: e.message || 'Server error' }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    } catch (_) {}
  }
});

module.exports = router;
module.exports.startWatchScheduler = startWatchScheduler;
// Exposed for ai-sessions-routes.js (sidebar CRUD shares the Anthropic
// session lifecycle helpers so there's one code path that talks to
// beta.sessions.*).
module.exports.createFreshAiSession = createFreshAiSession;
module.exports.ensureAiSession      = ensureAiSession;
module.exports.archiveActiveAiSession = archiveActiveAiSession;
module.exports.getAnthropic         = getAnthropic;
module.exports.internals = {
  // Phase 1 of the unified-86 cutover — single per-turn dispatcher.
  // New code should prefer this; the per-entity builders below stay
  // exported for admin prompt-preview tooling and the eval harness.
  buildTurnContext,
  buildEstimateContext,
  buildJobContext,
  buildClientDirectoryContext,
  buildStaffContext,
  buildAsk86Context,
  sectionsForAgent,
  // Compose the full system prompt for an agent at registration / sync
  // time — appends the SECTION_DEFAULTS playbook to the bare baseline
  // for 'job' so the prose is cached on the Anthropic agent rather
  // than re-shipped through every user.message. Directory / CoS pass through.
  composedAgentSystem,
  estimateTools: () => [...WEB_TOOLS, ...ESTIMATE_TOOLS],
  // 86 (job-side) inherits the intake tools too so 86 can capture
  // a new lead from any context — not just the dedicated intake
  // panel. Tier markers are stripped (the runtime onCustomToolUse
  // callback decides auto vs approval at call time).
  jobTools:      () => [...WEB_TOOLS, ...JOB_TOOLS, ...INTAKE_TOOLS.map(({ tier, ...t }) => t)],
  clientTools:   () => [...WEB_TOOLS, ...ClientDirectoryTools.map(({ tier, ...t }) => t)],
  staffTools:    () => [...WEB_TOOLS, ...STAFF_TOOLS.map(({ tier, ...t }) => t)],
  // Phase 3 subtask tools removed — fan-out replaced by native parallel
  // tool calls within a single session. Export kept as () => [] so any
  // sibling module still calling it doesn't crash mid-migration.
  subtaskTools:  () => [],
  // Phase 4 — long-term semantic memory tools.
  memoryTools:   () => MEMORY_TOOLS.map(({ tier, ...t }) => t),
  // Phase 5 — proactive watching tools (3 of 4 are auto; the writes
  // are approval-tier and surface as cards).
  watchTools:    () => WATCH_TOOLS.map(({ tier, ...t }) => t),
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
