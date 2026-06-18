# 86 → Orchestrator + Scribe rework — Rolling86 build spec

**Owner:** John · **Author:** Claude (audit/plan) · **Implementer:** Rolling86
**Status:** approved to build · decisions locked (see top of each section)
All `file:line` are from the recon pass; re-confirm before editing (line numbers drift).

## Goal
Split the in-app AI "86" into:
- **86 = orchestrator** — heavy reasoning, conversation, planning, estimating, reading (WIP / job costs / budgets / context). Read-only + memory + navigate. **No direct writes.**
- **Scribe = cheap, stateless, write-only worker** — owns the one write primitive (`emit_payload_file`), authors the payload from a fully-specified intent, runs the dry-run, self-corrects on validation errors, returns the diff. 86 hands off, verifies, commits on the user's inline approval.

While here, **strip all legacy/dead agent + tool + skill scaffolding** so nothing unintended is attached.

### Locked decisions
1. **Full strip** — remove dead code AND decommission the 5 dormant watcher agents + inert server-side skills-install path + Tier-3 staff-spawn (after empty-table safety checks). Claude-app skills (agx-lead-report, build-proposal) are in the harness, NOT this server — untouched.
2. **Inline approve/reject card** in chat for the dry-run diff (replaces drag-to-dropbox). Client work in `js/ai-panel.js`.
3. **Scribe model: Sonnet default, Haiku for trivial** (single-field `field_updates` / `notes` / one schedule block).

---

## Current state (verified)
- **Only live user agent = "86"** (`agentKey: 'job'`): baseline `admin-agents-routes.js:1955-2026`; loop `runV2SessionStream` `ai-routes.js:3391`; route `/86/chat` `ai-routes.js:12153`.
- **Live tool surface = `ROUTER_TOOL_NAMES`, 17 tools** (`admin-agents-routes.js:2361-2387`): reads (`read_entity`, `search_entities`, `search_reference_sheet`, `read_attachment_text`, `view_attachment_image`, `read_photo_comments`, `add_photo_comment`, `read_schedule_blocks`, `list_workflow_items`, `list_compliance_expiring`), memory (`remember`/`recall`/`list_memories`/`forget`), `navigate`, and the **single write primitive `emit_payload_file`**. Plus builtin `agent_toolset_20260401` (bash/write/web) for .xlsx authoring.
- **Write engine** = `emit_payload_file` → `payload-dispatcher.js`. Op vocabulary `PAYLOAD_OPS_SCHEMAS` (`:127-216`) for 7 entities; `applyPayload(row,{dryRun})` `:2468` — one PG txn, dryRun ⇒ ROLLBACK + `affected_targets`/`apply_changeset` diff, else COMMIT (`:2508-2530`).
- **Context:** stable prefix `composedAgentSystem` `ai-routes.js:2700` (baseline + org.identity_body + org_memory + reference links); volatile `buildTurnContext` `ai-routes.js:~2528` (entity snapshot + workspace-sheet index + tool hint + recent applied/failed payloads). Capability gate `make86OnCustomToolUse` + `AI_TOOL_CAPABILITY` `ai-routes.js:~10675`; org re-check `assertTargetOrg` `payload-dispatcher.js:~499`.
- **Sub-session primitive** = `driveSubtaskTurn` `ai-routes.js:10948` (non-streaming Sessions driver, one-event-at-a-time, `MAX_SUBTASK_TURNS` guard). **Repurpose for the Scribe.**
- **Session labeler** `ai-routes.js:3189-3200` uses `claude-haiku-4-5-20251001`, `max_tokens:200` — the cheap-model precedent.

---

## Build sequence
`[CODE]` = no migration · `[DATA]` = touches DB / Anthropic registry. Ship + verify each step independently.

### 1. `[CODE]` Strip pure tombstones
Delete: `runStream` (`ai-routes.js:2227`), `filterToolsForPhase`/`filterToolsForJobPhase`/`PLAN_MODE_ALLOWED_*`, `SUBTASK_TOOLS`/`subtaskTools()`, `HANDOFF_TOOLS`/`handoffTools()`, `execHandoffToStaff`+`STAFF_AGENT_KEY_BY_HANDOFF`+`isHandoff` branch, `STAFF_HINT_BY_SURFACE`+`activeStaffHint`, empty `stableLines`/`SECTION_DEFAULTS` placeholders.
**Verify:** server boots; `/86/chat` round-trips a read. (All dead — no behavior change.)

### 2. `[CODE]` Delete dead tool-schema arrays
Remove `ESTIMATE_TOOLS`/`JOB_TOOLS`/`ClientDirectoryTools` `propose_*` write defs, `WATCH_TOOLS` (keep the runner — see step 8), field-tool tool defs, duplicate read defs (`read_jobs`/`read_users`/etc.), `search_my_*`/`self_diagnose`, and the `cra`/`staff`/`ag` branch in `customToolsFor` (`admin-agents-routes.js:2324`).
**Verify:** `/managed/audit` still shows `tool_count: 17` for `job`; a full estimate-edit via `emit_payload_file` still applies (proves the executors backing the write primitive survived).

### 3. `[CODE]` Rebuild stale turn-context hints (real bug — likely silent-stop cause)
`SURFACE_PRIMARY_WRITES` (`ai-routes.js:~11813`) + `TOOL_REQUIRED_ENTITY` (`:~11855`) still point 86 at retired `propose_*` tools it can't fire. Rewrite to reference only the write path (interim: `emit_payload_file`; final: the `scribe.write` handoff from step 7).
**Verify:** fresh session — 86 no longer attempts unregistered tools (Chrome MCP on WIP page, per prior method).

### 4. `[CODE]` Cache-buster fix
Drop the per-row `(fetched <ISO timestamp>)` text from `buildReferenceLinksBlock` (`admin-agents-routes.js:~3816`); keep the timestamp in DB metadata only. No clock/date token anywhere in the stable prefix — if 86 needs "today", append it to the tail of the volatile `<turn_context>`.
**Verify:** two consecutive syncs with no data change → identical registered `system` (zero drift).

### 5. `[CODE]` Register the Scribe agent
- New `AGENT_SYSTEM_BASELINE['scribe']` = the payload-vocabulary block **lifted out of 86's baseline** (`admin-agents-routes.js:1980-2013`) + the one-paragraph Scribe contract (below).
- New `customToolsFor('scribe')` branch = `[emit_payload_file]` only. **No builtin toolset, no reads, no memory, no navigate.**
- Wire an explicit cheap `model` on this key in `ensureManagedAgent` (net-new — no per-agent model override exists today). Sonnet default; Haiku when the handoff sets `scribe_tier:'haiku'`.
**Scribe contract (system prompt):** *"You receive an approved plan with complete target states. You emit a single valid `emit_payload_file` payload and nothing else — no prose. Address entities by id/`$ref` only, never by array index. On a validation error, self-correct using the named `field_path`/`op_index`."*
**Verify:** `/managed/audit` shows `scribe` registered, `tool_count: 1`, Sonnet model.

### 6. `[CODE]` Build the Scribe driver
New `driveScribeWrite(intent, ctx)` wrapping `driveSubtaskTurn` (`ai-routes.js:10948`): open/reuse a Scribe sub-session, send `intent` + **target-entity snapshot** (the one net-new context layer — same shape `read_entity(depth:'full')` returns; 86 passes it since the Scribe can't read), run `applyPayload({dryRun:true})` on the emitted payload, implement the **≤2-retry** structured-error loop (`PayloadValidationError` → re-emit; then bail to 86), return `{payloadId, diff, error?}`. Pass `ctx={userId,orgId}` so `emit_payload_file` still hits the capability gate + `assertTargetOrg`.
**Verify:** good intent → valid payload + dry-run diff; bad field → structured error → self-correct → valid on retry; 3rd failure → clean bail to 86.

### 7. `[CODE]` 86 handoff tool + remove 86's write
- Add custom tool `scribe.write` to 86's `ROUTER_TOOL_NAMES`; executor calls `driveScribeWrite`. To 86 it's "describe the change in words (+ target snapshot)."
- **Remove `emit_payload_file` from 86's allowlist** (`admin-agents-routes.js:~2380`); move the payload-vocabulary block out of 86's baseline (now lives only on the Scribe — shrinks 86's cached prefix).
- **Inline approval card** (`js/ai-panel.js`): render the dry-run before/after diff in the conversation with Approve / Reject; Approve → `POST /api/payloads/:id/apply` (`payload-routes.js:~337`, `applyPayload{dryRun:false}` COMMIT) → `auditLog()` (CC-1/CC-2, already built). Retire the drag-to-dropbox gesture.
**Verify (e2e):** user asks 86 for a field change → 86 plans → Scribe authors + dry-runs → inline diff card → Approve → commit → `admin_audit_log` row → `recent_applied_payloads` reflects it next turn.

### 8. `[DATA]` Decommission watcher fleet (full-strip decision)
Safety: `SELECT count(*) FROM ai_watches;` must be 0. Kill Anthropic-side `86-*` agents via `/managed/:key` first. Then delete `runAgentWatchFire`, `startWatchScheduler` boot (`server/index.js:~340`), the 5 `86-*` baselines, `WATCH_TOOLS` runner. Optionally drop `ai_watches`/`ai_watch_runs`.
**Verify:** boot logs no scheduler start; `/managed/audit` shows no orphaned `86-*` agents.

### 9. `[DATA]` Decommission server skills + Tier-3 spawn (full-strip decision)
Safety: `SELECT count(*) FROM managed_agent_skills;` and `SELECT count(*) FROM staff_agents;` must be 0. Remove `p86/install-skills`, `SKILL_DEFINITIONS`/`collectSkillsFor`, `propose_create_staff_agent`, `services/p86-skill-bodies.js`. (Does NOT touch harness skills.)
**Verify:** sync-all succeeds with no skill attachments; admin agents surface still loads.

### 10. `[CODE]` Narrow legacy read endpoints
After confirming `js/ai-panel.js` doesn't POST legacy read names: narrow `/api/ai/exec-tool` whitelist + `ALLOWED_AUTO_TIER_TOOLS` (`ai-routes.js:~11889`/`:~11677`) to the live read surface.
**Verify:** every client read chip still resolves.

---

## Context layers
- **86 (reuse all):** `buildTurnContext` aggregator (rebuild its `SURFACE_PRIMARY_WRITES`/`TOOL_REQUIRED_ENTITY` per step 3/7), entity snapshot + workspace-sheet index, `org_memory` posture, job/estimate/client context builders, and **`recent_applied_payloads`/`recent_failed_payloads`** (`ai-routes.js:~2584-2663`) — the feedback channel telling 86 what the Scribe just committed/failed.
- **Scribe (minimal):** target-entity snapshot (passed in handoff — **the one new layer**), the frozen op schemas (its system prompt), `PayloadValidationError` (retry loop), capability/org ctx. Everything else = reuse.

## Parking lot (not gating this build)
- **Compaction (task #30):** beta header `compact-2026-01-12` set but never fires → 86's rolling `user_thread` can blow context on long sessions. 86-only risk (Scribe is stateless). Decide separately whether to force per-session opt-in.
- **Materials catalog** (the Xactimate-informed build) layers on AFTER the Scribe: it's just more entity types the Scribe writes + a cached read layer for 86. See the catalog synthesis.
