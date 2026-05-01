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
// Override via env if we want to A/B against Opus.
const MODEL = process.env.AI_MODEL || 'claude-sonnet-4-6';
const MAX_TOKENS = 2000;

// Cap chat history fed back to the API so a long conversation doesn't
// balloon the per-call cost. Keep the most recent N round-trips
// (= 2N messages). System prompt rebuilds estimate context fresh each call,
// so dropped early messages don't lose factual context.
const MAX_HISTORY_PAIRS = 12;

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
  }
];

// ──────────────────────────────────────────────────────────────────
// Job-side tools — write capabilities for the WIP Assistant.
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
      'phase_id MUST be one of the phase ids visible in the # Structure block; do not invent ids. ' +
      'Always include rationale (1 short sentence) explaining why this number.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        phase_id: { type: 'string', description: 'The phase id from the # Structure block of the system prompt.' },
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
      'sheet_name MUST exactly match one of the names listed in the # Workspace sheets headings.',
    input_schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sheet_name: { type: 'string', description: 'The exact sheet name (case-sensitive).' }
      },
      required: ['sheet_name']
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

  // Document manifest. We can't read PDF/Excel/Word contents directly, but
  // surfacing what's attached lets the assistant ask the user to summarize
  // a relevant doc, OR cite a doc by name when recommending follow-ups
  // ("see the RFP attached on the lead for the spec on caulk type").
  if (docManifest.length) {
    lines.push('# Attached documents (' + docManifest.length + ')');
    var anyWithText = docManifest.some(function(d) { return d.extracted_text; });
    lines.push(anyWithText
      ? 'PDF text below has been extracted at upload time. Quote / cite directly when relevant. For docs without extracted text (scanned PDFs, Excel, Word), ask the user to paste excerpts.'
      : 'Filenames listed for reference. Ask the user to paste relevant excerpts if needed.');
    lines.push('');
    docManifest.forEach(function(d) {
      var sizeStr = d.size != null ? ' (' + (d.size > 1048576 ? (d.size / 1048576).toFixed(1) + ' MB' : Math.round(d.size / 1024) + ' KB') + ')' : '';
      lines.push('## [' + d.source + '] ' + d.filename + sizeStr);
      if (d.extracted_text) {
        lines.push('```');
        lines.push(d.extracted_text);
        lines.push('```');
      } else {
        lines.push('_(no extractable text — likely a scanned PDF or non-PDF doc)_');
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
  return {
    system: [
      { type: 'text', text: stableLines.join('\n'), cache_control: { type: 'ephemeral' } },
      { type: 'text', text: '\n\n# Current estimate context (refreshed each turn)\n\n' + lines.join('\n') }
    ],
    photoBlocks: photoBlocks
  };
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
  const toolList = Array.isArray(tools) ? tools : ESTIMATE_TOOLS;
  const cachedTools = toolList.length
    ? [
        ...toolList.slice(0, -1),
        Object.assign({}, toolList[toolList.length - 1], { cache_control: { type: 'ephemeral' } })
      ]
    : toolList;
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: system,
    tools: cachedTools,
    messages: messages
  });

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
        // Tolerate clients that pass either pure base64 or "data:...;base64,..."
        const stripped = typeof b64 === 'string' && b64.indexOf('base64,') >= 0
          ? b64.slice(b64.indexOf('base64,') + 7)
          : b64;
        inlineImageBlocks.push({
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: stripped }
        });
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
  lines.push('You are a WIP-and-financial analyst for AG Exteriors, a Central Florida construction services company. The PM is working on the job below — help them spot margin issues, missing change orders, billing gaps, and progress risks.');
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
      lines.push('Nodes appear as: TYPE | label | computed-value | %complete | budget. Note types: t1 = building, t2 = phase, sub = subcontractor cost, co = change order, po = purchase order, inv = invoice, wip = WIP rollup, watch = KPI display, note = sticky note (visual only).');
      var sortedNodes = nodes.slice().sort(function(a, b) { return (a.type || '').localeCompare(b.type || ''); });
      sortedNodes.slice(0, 60).forEach(function(n) {
        var pct = (n.pctComplete != null && n.pctComplete > 0) ? ' | ' + Math.round(n.pctComplete) + '%' : '';
        var bud = (n.budget != null && n.budget > 0) ? ' | budget ' + fmtMoney(n.budget) : '';
        var val = (n.value != null && n.value !== 0) ? ' | value ' + fmtMoney(n.value) : '';
        lines.push('- ' + (n.type || '?') + ' "' + (n.label || '(no label)') + '"' + val + pct + bud);
      });
      if (nodes.length > 60) lines.push('- …and ' + (nodes.length - 60) + ' more nodes');
      lines.push('');
      lines.push('## Wires (' + wires.length + ' connections)');
      // Group wires by source for readability
      if (wires.length) {
        var nodeById = {};
        nodes.forEach(function(n) { nodeById[n.id] = n; });
        wires.slice(0, 80).forEach(function(w) {
          var from = nodeById[w.fromNode];
          var to = nodeById[w.toNode];
          if (from && to) {
            lines.push('- ' + (from.label || from.type) + ' → ' + (to.label || to.type));
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
  if (clientContext && Array.isArray(clientContext.workspaceSheets) && clientContext.workspaceSheets.length) {
    lines.push('# Workspace sheets (' + clientContext.workspaceSheets.length + ')');
    lines.push('Each sheet preview is rendered as `<row>: A=val · B=val · …` (1-indexed rows, A–Z columns). Use these to answer "what phases / scope items / line items do I have in my workspace?" When the user asks you to extract data, pull it directly from the relevant sheet here — do NOT say you can\'t see the workspace. The default preview window is 100 rows × 26 cols; if a sheet is bigger the totalRows/totalCols line will say so and you can call the `read_workspace_sheet_full` tool with sheet_name to fetch the entire sheet — that tool auto-applies (no approval card), so use it freely whenever the preview is truncated.');
    clientContext.workspaceSheets.forEach(function(s) {
      lines.push('');
      lines.push('## "' + s.name + '" (' + s.totalRows + ' rows × ' + s.totalCols + ' cols' + (s.truncated ? ', preview truncated' : '') + ')');
      if (s.preview) lines.push(s.preview);
    });
    lines.push('');
  }

  if (clientContext && clientContext.qbCosts) {
    var qb = clientContext.qbCosts;
    if (qb.lineCount > 0 || qb.total) {
      lines.push('# QuickBooks cost data (imported, client-side)');
      lines.push('- Lines: ' + (qb.lineCount || 0));
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
        lines.push('## Sample lines (top by amount)');
        qb.samples.slice(0, 15).forEach(function(s) {
          lines.push('- ' + (s.date || '') + ' ' + fmtMoney(s.amount || 0) + ' ' + (s.vendor || '') + (s.account ? ' | ' + s.account : '') + (s.memo ? ' — ' + String(s.memo).slice(0, 80) : ''));
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
  lines.push('- Read the WIP snapshot, change orders, and cost lines together — they tell a story about whether the job is healthy.');
  lines.push('- Spot mismatches: % complete way ahead of revenue earned (under-pulled progress), revenue earned way ahead of invoiced (under-billed), JTD margin diverging from revised margin (cost overruns), large recurring vendors that should have been a CO.');
  lines.push('- When citing dollar figures, match the field name from the snapshot above so the PM can find them in the UI.');
  lines.push('- You are READ-ONLY for the job side. When you see something that needs action, format it as a checklist the PM can work through. (Write controls — adjusting % complete, adding a CO, etc. — come in a future phase.)');
  lines.push('- Be concise and direct. Construction trade vocabulary is welcome. If you need one piece of info to answer well, ask one targeted question first.');

  // Job side stays plain — single string. Lower volume than AG/CRA so
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
    client_company: { type: 'string', description: 'Client company / management firm name. From the Client Contact block. Empty string if not present.' },
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
    'title', 'client_company', 'client_first_name', 'client_last_name',
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
  '- The Client Contact block usually shows "Company Name - Property/Site Name" on line 1, then the mailing address. Extract the company name only (strip the " - Site Name" suffix) into client_company.',
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
      // Strip "data:image/...;base64," prefixes if any so the API gets pure base64
      const imageBlocks = images.map(b64 => {
        const stripped = typeof b64 === 'string' && b64.indexOf('base64,') >= 0
          ? b64.slice(b64.indexOf('base64,') + 7)
          : b64;
        return {
          type: 'image',
          source: { type: 'base64', media_type: 'image/jpeg', data: stripped }
        };
      });

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
    default:
      throw new Error('Unknown tool: ' + name);
  }
}

// Wrapper that adds context (userId, storage) for tools that need it
// (currently only attach_business_card_to_client). Falls through to the
// stateless executor for everything else.
async function execClientToolWithCtx(name, input, ctx) {
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
            city, state, zip, email, phone
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
  stable.push('You are AGX\'s Customer Relations Agent — the dedicated assistant for keeping AG Exteriors\' customer directory clean, accurate, and properly structured. You understand the property-management industry in Central Florida and you take pride in a tidy, hierarchical, dedupe-clean directory.');
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

  // Skill packs targeted at the Customer Relations Agent. Same loader as
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
  const cachedClientTools = cleanTools.length
    ? [
        ...cleanTools.slice(0, -1),
        Object.assign({}, cleanTools[cleanTools.length - 1], { cache_control: { type: 'ephemeral' } })
      ]
    : cleanTools;
  const stream = anthropic.messages.stream({
    model: MODEL,
    max_tokens: MAX_TOKENS,
    system: system,
    tools: cachedClientTools,
    messages
  });
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
            ...additionalImages.map(b64 => {
              const stripped = typeof b64 === 'string' && b64.indexOf('base64,') >= 0
                ? b64.slice(b64.indexOf('base64,') + 7)
                : b64;
              return { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: stripped } };
            }),
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

module.exports = router;
