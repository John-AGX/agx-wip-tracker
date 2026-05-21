// p86-skill-bodies.js — content for the six native Anthropic Skills
// that back the Payload DSL architecture (C8).
//
// Each Skill is registered server-side via beta.skills.create with the
// body string below as the SKILL.md content. The skill is then linked
// to its target managed agent via managed_agent_skills so collectSkillsFor
// picks it up at the next sync.
//
// SKILL_DEFINITIONS is exported as a list so installers can iterate
// idempotently. Each entry carries:
//   - agent_key:    which managed agent the skill links to
//   - display_title: shown in the Anthropic Skills dashboard
//   - slug:         used as the markdown `name:` in frontmatter
//   - description:  triggers when the model decides to invoke the skill
//   - body:         the SKILL.md body content (no frontmatter — added at upload)
//
// Bodies stay terse (~300-500 words). They describe DOMAIN HEURISTICS
// (what to look for, how to think about it). Format spec for emit_payload_file
// lives in the Principal-side payload-drafter skill.

const PAYLOAD_DRAFTER = `# Payload Drafter

You are reading this skill because the Principal (86) is about to emit a write to the system. Your job is to draft a high-quality \`.p86.json\` payload file the user can review and apply.

## When to invoke

Any user request that needs a write — a field update, a line item edit, a phase % change, a new lead, a graph node, a client merge, a CO, a PO, a schedule block, or a system-config change (watches, skill packs).

## Format

\`\`\`json
{
  "targets": [
    {
      "entity_type": "estimate|job|lead|client|schedule|system",
      "entity_id": "<real-id>",                  // or "$new_<name>" placeholder
      "entity_display": "Human-readable name",
      "entity_metadata": { "last_modified": "...", "modified_by": "...", "summary_value": "..." },
      "ops": { /* per-entity_type vocabulary */ }
    }
  ],
  "title": "Short imperative title",
  "summary": "One-line summary of what the file does",
  "rationale": "Why this payload, why now"
}
\`\`\`

## Per-entity_type ops vocabulary

- **client**: \`{op?, fields?, notes?, structure?}\` — fields whitelist matches the clients table editable columns. notes is an array of strings.
- **estimate**: \`{op?, scope?, field_updates?, sections?, groups?, line_adds?, line_edits?, line_deletes?}\` — sections/groups have \`{op:'add|update|delete|reorder', ...}\`. line_adds takes \`{description, qty, unit, unit_cost, markup_pct?}\`. line_edits takes \`{line_id, fields:{...}}\`.
- **job**: \`{field_updates?, phase_updates?, node_values?, wire_updates?, qb_assignments?, change_orders?, purchase_orders?, invoices?, notes?, graph?}\` — phase_updates by phase_id. graph.nodes/wires support op=create|update|delete.
- **lead**: \`{op?, fields?, notes?}\` — status is enum: new|in_progress|sent|lost|sold|no_opportunity.
- **schedule**: \`{blocks: [{op:'create|update|delete', entry_id?, jobId, startDate, days, crew, includesWeekends, status, notes}]}\`.
- **system**: \`{watch_ops?, skill_pack_ops?, field_tool_ops?, staff_agent_ops?}\` — v1 only watch_ops dispatches; others throw "not implemented".

## Cross-entity refs

When a target depends on another target created in the same bundle, use \`$new_<name>\` as the entity_id placeholder. The dispatcher resolves refs at apply time inside one PG transaction. Example: create a lead, then a client from that lead, then an estimate linked to the client.

\`\`\`
[{entity_type:'lead', entity_id:'$new_lead', ops:{op:'create', fields:{title:'...'}}},
 {entity_type:'client', entity_id:'$new_client', ops:{op:'create', fields:{name:'...'}}},
 {entity_type:'estimate', entity_id:'$new_est', ops:{op:'create', field_updates:{client_id:'$new_client'}}}]
\`\`\`

## Discipline

- **Resolve targets first.** Use \`read_*\` tools to find real entity_ids before emitting. Populate \`entity_display\` and \`entity_metadata\` so the user can sanity-check the targets in the file preview.
- **Ambiguous reference → ask, don't guess.** If "the HOA estimate" matches three records, ask in chat which one.
- **One file per turn.** Bundle every change for this user request into ONE \`emit_payload_file\` call.
- **Don't pre-narrate.** The file IS the answer — emit it and let the artifact speak. No "I'll create a payload to..." preamble.
- **Recipes.** If a saved recipe matches the user's request, set \`template_ref: {template_id, template_name, parameters}\` so lineage is preserved.
`;

const PM_WIP_PLAYBOOK = `# WIP Analyst Playbook

You are reading this skill because the Principal is doing a WIP / production analysis on a job. Apply these heuristics.

## What "WIP audit" means

A WIP audit looks for mismatches between what the job CLAIMS (phase %, declared costs, change orders) and what the data SAYS (QB cost lines, node graph rollups, building breakdowns). The goal is to surface drift early so the PM can correct billing or recognize sunk cost before it becomes a margin hole.

## Mismatch patterns to flag

1. **Phase % vs cost ratio drift** — a phase claiming 80% complete with only 30% of the cost realized is either ahead of cost (good — bill for it) or claimed too aggressively (bad — pull back). The reverse (30% claim, 80% cost) usually means missed billing or scope creep.
2. **QB cost lines unlinked to nodes** — every cost line should hit a graph node. Unlinked lines are either misassigned vendors, mis-categorized lines (use suspense, not the cost bucket), or a missing node that the graph needs.
3. **Change orders without matching cost** — a CO with declared income but zero materials/labor allocated is probably approved-not-billed-yet OR a phantom CO. Either way, surface it.
4. **Stale phase pcts** — phases that haven't moved in 4+ weeks while QB cost is still landing.
5. **Sub vs labor misclassification** — large sub line items showing as labor (or vice versa) skew the WIP report.
6. **Building rollup vs total mismatch** — the sum of buildings should equal the job total; differences mean orphan phases or double-counted ones.

## Discipline

- Cite \`$\` and \`%\` together. "Phase 5 claims 80% but cost ratio is 45% ($12K of $27K realized)" is useful. "Phase 5 looks off" is not.
- Distinguish READ findings from RECOMMENDATIONS. The read says "X is the case"; the recommendation says "do Y about it." Both belong in your output, but not conflated.
- Don't propose phase % nudges to match cost ratios mechanically — that erases the diagnostic signal. Recommend the PM investigate; let them decide whether the % or the cost recording is wrong.
- For change_order recommendations, include the CO number, the declared income, the materials/labor split, and the suggested fix.

## Output shape

When the Principal asks for an audit, return findings as prose: a short summary, then a bulleted list of mismatches with $/% citations, then 2-3 specific recommendations. If you (as a background watcher) are emitting a payload, use the \`job\` ops vocabulary — phase_updates / change_orders / qb_assignments — and put the diagnostic prose in the \`rationale\` field.
`;

const ESTIMATOR_STRUCTURE_PLAYBOOK = `# Estimator Structure Playbook

You are reading this skill because the Principal is working on estimate structure, scope, or line items. Apply these heuristics.

## Standard 4-subgroup structure

Each major work category on AGX estimates breaks down into these subgroups (use as section/group names when introducing new line items):
  1. **Materials** — supplies, hardware, fixtures, fasteners
  2. **Labor** — in-house crew hours
  3. **Sub / Trade** — subcontracted work (electrical, plumbing, HVAC, specialty)
  4. **Equipment / Other** — rentals, dumpsters, permits, freight

When ambiguous, prefer the subgroup that matches the LARGEST cost portion of the line. A small fastener pack inside a labor-heavy install can ride on the Labor line as a materials sub-bullet — don't fragment.

## Slotting rules

- New scope item → place it into an existing section/group if a clean match exists. Create a new section only when the work is genuinely new in kind.
- Sections group by ROOM, BUILDING, or PROJECT PHASE — not by trade. Use subgroups for trade splits.
- Line description should READ like a contractor talking — "Frame and sheathe N elevation (8' x 32' wall)" not "Carpentry work".
- Quantities use the unit the trade actually quotes in (SF for siding/drywall, LF for fascia/trim, EA for fixtures, HRS for labor blocks).

## Pricing fallback chain

When the user doesn't give you a unit price:
  1. Look up the line in the pricing history (read_pricing_history) for this line description on prior estimates.
  2. Fall back to material catalog defaults (read_materials).
  3. If both miss, leave unit_cost = 0 and flag in rationale that the user needs to supply pricing.

NEVER guess at trade pricing for unfamiliar scopes. Leave 0 and surface the gap.

## Markup

- Materials default markup: 15%
- Labor default markup: 0% (labor priced at burden + overhead already)
- Sub default markup: 10%
- Equipment default markup: 0%

Override only when the estimate field_updates.markup_pct or the per-line markup_pct is explicitly set.

## Web research posture

For exotic materials or specialty trades you don't have catalog data for, use web_fetch / web_search SPARINGLY — only when the user explicitly asks for current pricing AND the result will be applied to a specific line. Otherwise note the missing data and ask the user.
`;

const DIRECTORY_HIERARCHY_PLAYBOOK = `# Directory Hierarchy Playbook

You are reading this skill because the Principal is doing client / property hygiene work. Apply these heuristics.

## Parent / property model

AGX clients are hierarchical:
  - **Parent companies** (HOAs, property management companies, builder groups) — the entity that pays.
  - **Properties** (individual community buildings, addresses) — the location of the work. Each property has a \`parent_client_id\` pointing back to its parent.
  - **Individual contacts** — the person you talk to. Stored as fields (community_manager, maintenance_manager) on the parent or property row.

When the user mentions "the HOA" they usually mean the parent. When they mention an address, that's the property.

## Dedup rules

Before creating a new client, check for an existing one matching on:
  1. Exact name match (case-insensitive)
  2. Same property_address
  3. Same company_name with overlapping POCs (community_manager email, phone)
  4. Same parent_client_id + similar property name (likely a typo on an existing property)

When matches surface, ASK before merging or creating — these are judgment calls the user needs to make.

## BT (Buildertrend) patterns

Buildertrend exports often look like:
  - Top-level client = the parent company.
  - "community_name" field = the property name (we map this to a child property).
  - "property_address" lives on the property, not the parent.
  - "company_name" duplicated across rows = parent rollup.

When importing from BT, dedupe parents by company_name first, then attach properties as children. The import endpoint already does this; surface conflicts where it can't auto-resolve.

## Field semantics

- \`name\` = the canonical entity name (parent or property)
- \`short_name\` = abbreviation for sidebar / chip display ("Sterling HOA" not "Sterling at Cypress Pointe Homeowners Association Inc.")
- \`activation_status\` = active / dormant / former — drives sidebar grouping
- \`market\` = geographic market (Central FL / Tampa / etc.)
- \`additional_pocs\` = JSON array of extra contacts that don't fit the canonical CM / MM slots

## Output shape

If you're surfacing dedup candidates as a background watcher, emit a \`client\` payload with a \`structure.merge\` op (v2 — for now use a \`note\` with the recommendation). If you're doing inline hygiene as the Principal, emit a \`client.update\` payload with field_updates + an explanatory note.
`;

const SCHEDULER_DISPATCH_PLAYBOOK = `# Scheduler Dispatch Playbook

You are reading this skill because the Principal is working on scheduling / dispatch. Apply these heuristics.

## Dispatch reasoning

When deciding when crew can start a job, weigh:
  1. **Current crew load** — read schedule_entries for the next 2 weeks; flag double-booked crew.
  2. **Sub availability** — for sub-trade work, the sub's calendar is the binding constraint. Sub portal data flows into schedule_entries as crew array.
  3. **Weather windows** — exterior work (siding, roofing, paint) needs 2-3 dry days. read_weather forecasts the next 10 days.
  4. **Job sequence dependencies** — framing before drywall, drywall before paint, etc. Validate against the job's phase order.
  5. **Distance / drive time** — back-to-back jobs in the same neighborhood are more efficient than zigzagging.

## Output shape

Scheduling questions get a prose recommendation with the proposed dates and a one-line rationale per date. If the user wants to commit, emit a \`schedule\` payload with \`blocks: [{op:'create', jobId, startDate, days, crew, ...}]\`.

## Sub availability cross-reference

For each block, before committing, verify:
  - \`crew\` array members are active users
  - None of them are already booked on overlapping days (excluding the entry being updated)
  - For weather-sensitive work, the start_date doesn't fall on a forecasted rain day

Surface conflicts in the rationale; don't auto-shift dates without user input.

## Edge cases

- **Multi-day blocks crossing weekends**: \`includesWeekends: true\` extends the block contiguously. False = crew skips weekend days and the block ends N business days after start.
- **Crew renames**: schedule_entries.crew stores user IDs, not names — renames in users.name flow through automatically.
- **Job phase changes**: if the job's phase order changes, existing schedule blocks DON'T auto-reorder. The PM has to verify and re-sequence; flag this as a follow-up when scope shifts.
`;

const SALES_INTAKE_PLAYBOOK = `# Sales Intake Playbook

You are reading this skill because the Principal is working on lead intake or pipeline analysis. Apply these heuristics.

## Intake dedupe order

Before creating a new lead, check for existing matches:
  1. Existing LEAD with same title + same property_name or street_address
  2. Existing LEAD with same client_id + similar title (likely a follow-up on the same opportunity)
  3. Existing CLIENT (parent or property) matching the prospect — set client_id on the new lead instead of leaving it null
  4. Existing LEAD recently marked "lost" / "no_opportunity" — these are not dedupes but should be SURFACED so the user can decide whether to revive or create fresh

## Recommended lead structure

When intake-data is light, fill in the most-likely values:
  - **status**: 'new' for raw intake, 'in_progress' once the salesperson is assigned
  - **source**: required for funnel analysis — common values: 'BT export', 'web form', 'referral', 'walk-in', 'repeat customer', 'community board'
  - **salesperson_id**: assign based on market geography (Central FL = X, Tampa = Y) or the prior salesperson on this client if it's a repeat
  - **market**: from the property address; falls back to the client.market when set
  - **project_type**: free text — keep it short and useful for funnel filters ("exterior repaint", "deck replacement", "HOA annual touch-up")

## Pipeline health observation

When asked to scan the pipeline:
  - Count leads by status (funnel rollup)
  - Flag stale leads (status='in_progress' for >30 days)
  - Surface conversion gaps (leads created vs leads sent — wide gap = backlog)
  - Note salesperson assignment imbalance if one rep has 10x another's load

## Output shape

Inline lead intake: emit a \`lead\` payload with \`op:'create'\` and the resolved client_id. If the prospect is a new client too, use cross-target refs (\`$new_client\`) to create both atomically.

Background pipeline scans (as the sales watcher) emit one payload per actionable finding — e.g., one note-append per stale lead — so the user can apply selectively.
`;

const SKILL_DEFINITIONS = [
  {
    agent_key: 'job',
    slug: 'p86-payload-drafter',
    display_title: '86 — Payload Drafter',
    description: 'Format spec, ops vocabulary, and discipline for drafting .p86.json payload files. Invoke whenever emit_payload_file is about to be called.',
    body: PAYLOAD_DRAFTER,
  },
  {
    agent_key: '86-pm',
    slug: 'p86-pm-wip-playbook',
    display_title: '86 · PM — WIP Analyst Playbook',
    description: 'Heuristics for WIP / production audits: phase pct vs cost mismatches, unlinked QB lines, change-order drift, billing gaps, margin analysis.',
    body: PM_WIP_PLAYBOOK,
  },
  {
    agent_key: '86-estimator',
    slug: 'p86-estimator-structure-playbook',
    display_title: '86 · Estimator — Structure Playbook',
    description: '4-subgroup standard, line slotting rules, pricing fallback chain, markup defaults, web-research posture for estimating work.',
    body: ESTIMATOR_STRUCTURE_PLAYBOOK,
  },
  {
    agent_key: '86-directory',
    slug: 'p86-directory-hierarchy-playbook',
    display_title: '86 · Directory — Hierarchy Playbook',
    description: 'Parent/property model, dedup rules, BT import patterns, field semantics for client directory hygiene.',
    body: DIRECTORY_HIERARCHY_PLAYBOOK,
  },
  {
    agent_key: '86-scheduler',
    slug: 'p86-scheduler-dispatch-playbook',
    display_title: '86 · Scheduler — Dispatch Playbook',
    description: 'Crew dispatch reasoning, weather windows, sub availability cross-reference, sequence dependencies for scheduling work.',
    body: SCHEDULER_DISPATCH_PLAYBOOK,
  },
  {
    agent_key: '86-sales',
    slug: 'p86-sales-intake-playbook',
    display_title: '86 · Sales — Intake Playbook',
    description: 'Lead intake dedupe order, recommended lead structure, pipeline health observation patterns.',
    body: SALES_INTAKE_PLAYBOOK,
  },
];

module.exports = {
  SKILL_DEFINITIONS,
  PAYLOAD_DRAFTER,
  PM_WIP_PLAYBOOK,
  ESTIMATOR_STRUCTURE_PLAYBOOK,
  DIRECTORY_HIERARCHY_PLAYBOOK,
  SCHEDULER_DISPATCH_PLAYBOOK,
  SALES_INTAKE_PLAYBOOK,
};
