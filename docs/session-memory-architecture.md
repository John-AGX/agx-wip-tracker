# Session & Memory Architecture — the definitive plan

**Status:** APPROVED direction (John, 2026-07-25). This document supersedes the session/topology sections of `agent-target-topology.md` and `agent-architecture.md` §3.3/§5.2 — those remain valid for the managed-session mechanics they document. **Audience:** John + Rolling86 + any session building this.

---

## 0. The one invariant

> **No fact may exist only in raw conversation turns.**

The session is a disposable scratchpad. Everything load-bearing lives in an external memory layer (rollups → digest → deal memory block → org memory) and is **assembled per turn**. If losing a thread would lose information, that information is in the wrong place. Once this holds, sessions can be compacted aggressively, switched freely, and thrown away — bloat becomes structurally impossible rather than something to fight.

---

## 1. The two thread types

| Thread | Model | Scope | Why it stays thin |
|---|---|---|---|
| **Deal thread** — one per lead→estimate→job **lineage** | Opus 4.8 + adaptive thinking | everything about that deal: photos, scope, estimate, deal emails, money | scoped to ONE deal; digest + deal block re-ground it, so raw turns are expendable and compaction is near-lossless |
| **Personal thread** — one rolling per user | Sonnet 4.6 + adaptive thinking | cross-cutting: my day, messages, org questions | deliberately shallow — re-derives "my day" from live org state each open instead of hoarding it |

- **Model is chosen by surface at session create.** The model binds immutably per managed session — there is no runtime model handoff, and we don't want one.
- **Escalation is retired.** The Assistant→86 `escalate_to_86` hop (blocking, confusing, double-billed) is replaced by a **visible surface-switch**: on a deal question in the personal thread, the assistant answers shallowly from the deal digest (a JIT bridge, ~1.5k) or offers to open the deal thread. Three questions deep on a deal = push to the deal thread, don't fake depth.
- **Adaptive thinking is the per-turn tier** within each thread: near-zero thinking on lookups, deep on estimating/financial reasoning. `thinking:{type:'adaptive', display:'summarized'}` (already live).
- Scribe (Sonnet, write worker) and the background `agent_jobs` runner are unchanged. The Critic hardens at `applyPayload` (see §4).

### Lineage = the deal root

`jobs.lead_id` / `jobs.estimate_id` are real columns set atomically at convert (`/api/jobs/convert`); `leads.job_id` links back; estimates carry `lead_id` in the record. **Root resolution:** walk to the lead if one exists anywhere in the chain; an orphan estimate or direct-created job roots at itself. The deal thread is keyed on this root (`ai_sessions.lineage_root`), so converting a lead **re-anchors nothing** — the thread was never keyed on the entity, and every stage resolves to the same root.

---

## 2. The memory layers

| # | Layer | Holds | Loaded | Borrowed from | Status |
|---|---|---|---|---|---|
| 0 | **Registered agent baseline** | identity, playbook, tools | always · cached ~0.1× | Anthropic prompt caching | ✅ live |
| 1 | **Deal Memory Block** ⭐ | per-lineage ≤1k tokens: **numbers** (deterministic, model can't write) + **notes** (append-only decisions/constraints via Scribe, capped→summarized) | always, as the deal thread's bootstrap; re-asserted after compaction | MemGPT/Letta core memory | 🔨 build |
| 2 | **Entity digest** | ≤1.5k rollup of the focused entity + pull-on-demand manifest | injected on switch, then decays to the marker | Devin knowledge notes | ⚠️ partial — `escalationLean` exists (jobs only), needs switch-time wiring + lead/estimate generators |
| 3 | **Snapshot dedup marker** | 1-line "unchanged" marker vs the 2-5k snapshot | per turn on hash match | Anthropic context-editing | ✅ live — needs re-key on (entity, hash) |
| 4 | **Volatile tail** | user msg + recent payloads/tasks, absolute timestamps, windowed out | per turn | Anthropic volatility discipline | ✅ live |
| 5 | **Org memory (`ai_memories`)** | durable cross-deal facts/preferences | `recall()` on demand — never auto-injected | MemGPT archival / ChatGPT memory | ✅ live |
| 6 | **JIT retrieval** | attachment bodies, line items, KB docs, prior sessions — by id | pulled only when needed | Cursor @codebase | ✅ live |
| 7 | **Sub-agents** (Scribe / Critic / background) | heavy work off-thread; returns a 1-2k summary | spawned on demand | Claude Code subagents | ⚠️ partial — Critic thin |
| 8 | **Lineage fuzzy index** | emails/docs/turns embedded + re-ranked | on demand | Cursor two-stage index | ⏸ deferred |

### The Deal Memory Block (the centerpiece)

A `deal_memory` row keyed on `lineage_root`. Hard cap ~1k tokens. Two sub-blocks with **single-writer ownership**:

- **Numbers** — contract, CO total, committed PO, balance, stage, key dates, %complete. Written **deterministically** from the server money layer (`server/services/money/job-wip.js`, `change-order-totals.js` — ported this month precisely so the server can compute these without the browser). **The model reads it, never writes it.** LLM prose never owns a number — non-negotiable given the dead-store bug class.
- **Notes** — append-only free text via Scribe→Critic: decisions ("client waived the flashing CO"), constraints ("hard cap $190k"), open items. At cap: oldest notes summarized. A **supersede** path corrects a wrong entry rather than burying it.

Re-grounding: injected as the deal thread's Zone-1 bootstrap — cold thread, entity switch within the lineage, and **immediately after compaction**. A compacted thread recovers its working memory in one send.

**Ownership lint (enforced, not assumed):** rollup owns numbers · notes own open-items · digest renders both, writes neither · `ai_memories` holds nothing deal-scoped (the `remember()` tool gets a guard steering deal facts to the deal block).

---

## 3. Anti-bloat mechanics (how a turn stays thin)

Steady-state same-entity turn = user message + ~0.5k marker + volatile tail. Surface-switch turn = +one ~1.5k digest injection, then decay. The six mechanisms:

1. **Four-zone volatility placement** — every token lives in the innermost zone matching its change-frequency (live).
2. **Snapshot dedup** — the 2-5k snapshot ships once per TTL, then the 1-line marker (live; re-key in slice 1).
3. **JIT retrieval** — bodies-by-id, never resident (live).
4. **Deterministic digest** — a ≤1.5k rollup replaces raw-row re-rendering (partial; slice 1).
5. **Sub-agent isolation** — OCR dumps, bulk writes, research stay off-thread; a 1-2k summary returns (live).
6. **Per-thread compaction posture** — deal threads compact aggressively + re-assert the block (slice 5); the personal thread is the most exposed (it externalizes the least) and gets the lowest threshold we can approximate.

---

## 4. Build slices

> Ordering rule: each slice ships alone, reviewed before deploy (money/agent-path discipline), and is independently valuable.

**Slice 1 — Switch-time digest** *(mostly glue; felt immediately)* — gaps G1–G4
Wire the existing `escalationLean` digest to entity switches on any thread; add `buildLeadContext` + an estimate lean cut (leads ship an empty snapshot today, G2); inject the digest before turn-text is frozen (G4). **Dedup re-key is within-session only** (G3 ⚠️): keep session in the key, compare hash past the 15-min TTL once the switch marker confirms the entity is in-context — cross-session dedup would lie to fresh threads. This slice touches no schema and is independently valuable even before deal threads exist.

**Slice 2 — `deal_memory` + numbers sub-block** — gaps G5–G10

> **2a SHIPPED (foundation):** `estimate-totals.js` (server port, parity-tested) · `deal_memory` table + `idx_estimates_lead_id` (G10) · `deal-memory.js` resolver + numbers writer (lead/estimate stages + job contract+%; full job WIP = 2b). Reviewed (12 agents): one HIGH (resolver split one deal into two rows — fixed with transitive lead recovery, mock-verified stable across all entry surfaces) + phantom-lead guard + multi-estimate determinism + tx-poison contract corrected. **2b:** recompute triggers · guards G8/G9 · job WIP via shared `buildJobContext` extraction.
Table keyed on `lineage_root`; deterministic numbers writer off the server money layer, **scoped to server-derivable fields** (contract/CO/committed-PO/stage/dates; %complete "as-pushed" until the matrix port, G7); port `computeEstimateTotals` server-side for the pre-job stage (G6); extend `JOB_BLOCKED_FIELDS` so a payload can't write money blob fields (G8); guard `remember()` against deal-fact leakage (G9); one shared lineage resolver + expression index (G10). Recompute trigger = payload apply + REST money-write paths.

**Slice 2 — `deal_memory` + numbers sub-block**
Table keyed on `lineage_root`; deterministic writer off the server money layer; recompute trigger = payload apply + the entity-write paths (gap G-6); injected as deal-thread bootstrap.

**Slice 3 — Deal threads live** *(the big one — the hunt found this is more than a flag flip)*

> **Sub-slice 3a — the schema keystone (G11 ⚠️REVISED, the finding that most changed this plan).** `ai_messages` has **no `session_id` column** — rows are keyed `(user_id, entity_type, estimate_id)`. Without it, per-thread history, hydration, stuck-session recovery, background-completion threading, and cost forensics all cannot follow a thread. **Nothing else in slice 3 is safe until this lands.** Add `session_id`, stamp it on every insert, backfill best-effort from the existing keying, and re-key hydration/recovery/forensics onto it. This is a live-pilot schema migration — additive column, backfill, dual-read during cutover — reviewed like money code.

Then **3b** (the routing flip): `lineage_root` column + one canonical root resolver (G10); replace role-based host routing with **surface-based** for deal surfaces (G16, drop the SYSTEM_ADMIN `hostOverride` gate for deal threads so office staff reach Opus); introduce `session_kind='deal_thread'` through the five hard-coded `user_thread` whitelist points (G13); per-**session** turn lock + `/turn-status` (G14); `/continue` passes `session_id` explicitly (G15); re-anchor at lead→job convert (G17–G18); retire `escalate_to_86` as an explicit step after surface-switch ships (G18); background/Scribe completions carry the originating `session_id` (G19, needs 3a); re-seed recovery per-session (G20); add sessions + `deal_memory` to the clean-slate reset sweep (G22); deal dashboard sidebar with lineage grouping (G21 — chips 🌱→💰→📋 + snippet + money digest, mocked and approved); migration per §5.

The precise `resolveSessionForChat` change (verified against `ai-routes.js:3069-3160`):
1. Host-key resolution stays as-is (role-based default + capability-checked override).
2. **New branch ahead of the unified-thread resolver:** when `currentContext` names a deal surface (lead/estimate/job + entity_id), resolve `lineage_root` and return/mint the **deal thread** — `session_kind='deal_thread'`, `agent_key='job'` (Opus), `lineage_root` stamped, `entity_type/entity_id` = the current stage (satisfies the `ai_messages.estimate_id` NOT-NULL keying).
3. Everything else → the personal `user_thread` (`agent_key='assistant'`, Sonnet) — for every role, field crew included.
4. The explicit-sessionId anti-pinning logic (`:3090-3111`) becomes lineage-aware: respect the pick when it IS the deal thread for the current lineage or the personal thread; otherwise redirect exactly as today.

**Slice 4 — Notes sub-block + supersede** *(after the minimum Critic)*
Scribe-written, append-only, capped→summarized. Minimum Critic for this slice is **deterministic** (caps, no-numbers-in-notes, supersede-id validity) — the second-model Critic stays deferred (gap G-7).

**Slice 5 — Post-compaction re-assert**
Hook `compaction_complete` (observed at `ai-routes.js` ~4339) → immediately re-inject deal block + digest in one send. Close the race where a turn lands between compaction and re-assert (gap G-8).

**Slice 6 — Deferred, deliberately**
Lineage embedding index · Haiku shadow-router (deterministic classifier, log-only, decide from data) · second-model Critic · retiring `escalate_to_86` fully once surface-switch proves out.

---

## 5. Migration & day-one UX

- The existing unified `user_thread` **becomes the personal thread** — nothing moves, it just stops absorbing deal chat. Labels/pins/archive survive untouched.
- Deal threads start **fresh** and are re-grounded by digest + deal block — day one they are not amnesiac about the *deal* (numbers + digest carry it) but they do not inherit old unified-thread conversation. Old history stays searchable via `search_my_sessions`.
- The just-shipped entity-grouped sidebar upgrades to lineage grouping in slice 3 (entity grouping is the degenerate case of lineage grouping — same code path, wider key).
- The fresh-upload fix carries over unchanged (it's per-turn injection, thread-agnostic).

---

## 6. Gaps found by the pre-build hunt — and how each closes

*77-agent adversarial hunt (wf_1f1e5253), 71 confirmed findings deduped to the canonical set below. Every gap is code-verified with file:line. Two findings **corrected this plan itself** — marked ⚠️REVISED.*

### Slice 1 — digest + dedup

| # | Gap | Fix | Size |
|---|---|---|---|
| G1 | Switch-time injection **partially exists** — but ships the 2-5k slim snapshot, not the ≤1.5k digest; `escalationLean` is job-only and consumed solely by the escalation path (`ai-routes.js:4974, 12281`) | lean/digest mode in `buildTurnContext`; first-send path sends the digest; extend the lean cut to estimates | M |
| G2 | **`buildLeadContext` does not exist** — a chat opened on a bare lead ships an *empty* entity snapshot (`buildTurnContext:2634-2661` has no lead branch); chat photos also never persist to leads (`:13772` dispatch skips 'lead' — helper already supports it) | new `buildLeadContext` (lead row + linked estimates via `data->>'lead_id'` + receipts + survey graph + attachment manifest); one-line photo-attach case | M |
| G3 ⚠️REVISED | The planned "re-key dedup on (entity, hash)" **would ship a bug**: session-scoping is deliberate (`:2629-2632` — a recreated session must cache-miss and get the full snapshot). Cross-session dedup would tell a fresh thread "snapshot unchanged" with empty history | keep session in the key; the improvement is *within-session*: compare hash past the 15-min TTL once the switch marker confirms the entity is in-context; document that cross-session dedup is intentionally not done | S |
| G4 ⚠️REVISED | Injection ordering: dedup/today-digest mutate `turnContextText` **after** `turnText`/`userContent` are frozen, so both reached only the handoff-forward path, never the main turn. **Slice-1b review found the dedup is *doubly* dead** — the ordering bug *and* a `turnCtx` scope bug (const-scoped to the context-build try; the dedup reads it out of scope → swallowed `ReferenceError`). | **Shipped (`@…`):** rebuild `turnText`/`userContent` after the mutations → the fresh-session **today-digest** now reaches the main turn. The **dedup marker stays deliberately inert + documented** — activating it (hoist `turnCtx`) arms "work from that snapshot" on the main turn, which needs slice-5's post-compaction re-assert guard first. **Dedup activation moved to slice 5.** | S |

### Slice 2 — deal_memory

| # | Gap | Fix | Size |
|---|---|---|---|
| G5 | `deal_memory` fully greenfield (zero matches repo-wide) — expected; it *is* the slice | table + writer + injection | L |
| G6 | **No server-side estimate totals** — `computeEstimateTotals` is browser-only, so the numbers sub-block can't compute the pre-job stage | port it dual-target (the pricing-pipeline pattern; already the money-layer Tier-B backlog item) | M |
| G7 | `computeJobWIP` trusts browser-pushed blob fields (`ngActualCosts`, `pctComplete`) — not every numbers field is server-deterministic | scope the block to server-derivable fields (contract, CO total, committed PO, stage, dates); %complete marked "as-pushed" until the matrix port lands | M |
| G8 | "Model can't write numbers" is violated *upstream*: `JOB_BLOCKED_FIELDS` doesn't block `contractAmount` & co. — a payload `field_updates` can write money blob fields directly | extend the blocklist | S |
| G9 | `remember()` is an unguarded free-form write — deal facts can leak into `ai_memories`, bypassing the deal block | steering guard in the tool description + `execMemoryTool` | S |
| G10 | No canonical server-side lineage resolver; estimate→lead link is JSONB-only, unindexed | one shared resolver + expression index on `(data->>'lead_id')` | M |

### Slice 3 — deal threads live *(bigger than originally billed)*

| # | Gap | Fix | Size |
|---|---|---|---|
| G11 ⚠️REVISED | **`ai_messages` has no `session_id` column** — history is keyed `(user_id, entity_type, estimate_id)`, so per-thread history, hydration, recovery, background threading, and forensics all can't follow a thread. This is the schema keystone the original plan missed | **new sub-slice 3a**: add `session_id`, stamp on every insert, backfill best-effort, re-key hydration | L |
| G12 | The flip is not a flag flip — the flag-off legacy branch is stale/broken under default-on; the deal branch must be written fresh (per the resolver spec in §4) | implement the new branch; delete the dead legacy branch | L |
| G13 | Five choke points hard-whitelist `user_thread` (`createFreshAiSession` binary sessionKind coercion `:3256`, explicit-pick honor `:3101`, "+ New chat", …) | introduce `session_kind='deal_thread'` through all five | M |
| G14 | Turn lock + `/turn-status` are per-USER (`_activeChatTurns:2234`) — a long deal turn blocks a quick personal question | per-session lock keyed `(userId, sessionId)`; same-session turns still serialize | M |
| G15 | `/86/chat/continue` guesses the most-recent session — unsafe with two live threads | client passes `session_id` explicitly on continue | S |
| G16 | Office staff **can't reach an Opus thread today**: host routing is role-based and `hostOverride` is SYSTEM_ADMIN-gated (`:3077, :13830`) | deal surfaces resolve host='job' for all roles; drop the role gate for deal threads specifically | M |
| G17 | Jobs created outside `/convert` never populate `lead_id`/`estimate_id` — they root at themselves (acceptable; documented). `link-estimate` can create job/estimate lineage disagreement | resolver precedence: `job.lead_id` wins; log mismatches | S |
| G18 | The escalation machinery being retired is **live and load-bearing** (`escalate_to_86` on the Assistant's managed allowlist) | retirement is an explicit step: remove from allowlist + `sync-all` + new chats; surface-switch ships first | M |
| G19 | Background/Scribe completions post to the `('general','global')` thread and `start_background_task` stamps a last-touched *guess* | carry the originating `session_id` explicitly end-to-end (needs 3a) | M |
| G20 | `seedRecoveredSession` seeds a recovered session from the last N messages **regardless of surface** — cross-thread contamination under two threads | re-seed per-session once 3a lands | M |
| G21 | The shipped entity-grouped sidebar keys on single entities | upgrade to lineage grouping (same code path, wider key) + the deal dashboard | S |
| G22 | Clean-slate reseed (`org-reset.js`) orphans entity-anchored sessions and future `deal_memory` rows | add both to the reset sweep | S |

### Slice 4 — notes + Critic

| # | Gap | Fix | Size |
|---|---|---|---|
| G23 | The Critic **does not exist in any form** (no agent key, no step) — "harden the Critic" was mis-framed | build the deterministic validator from zero as a step inside `applyPayload` (caps, no-numbers-in-notes, supersede-id validity); the LLM Critic stays deferred | M |
| G24 | The Scribe can *only* call `emit_payload_file` — notes have no write vehicle | notes become a payload op (`deal_memory: {note_adds, note_supersedes}`) in the existing grammar — no new tool, rides the existing approval/audit path | M |

### Slice 5 — compaction re-assert

| # | Gap | Fix | Size |
|---|---|---|---|
| G25 | Compaction is observed in **two** places (stream handler `:4338-4364` + the non-streaming subtask driver) and acted on in neither | re-assert hook covering both sites; the stall-nudge machinery covers the turn-lands-mid-compaction race | M |

### Decisions closed by the hunt

- **D1 — field crew personal thread = Sonnet** (code comment explicitly defers subs; confirm at flip). Adopted.
- **D2 — lineage disagreement precedence**: `job.lead_id` wins; mismatches logged, not blocked.
- **D3 — deal_memory recompute trigger**: post-commit hook in `applyPayload` + the REST money-write paths (no cron initially).
- **D4 — existing agent models are already right** (assistant=Sonnet, job=Opus, fixed at first registration) — no re-registration needed for the flip.
- **D5 — per-thread deletion/clear semantics** depend on 3a; deferred to it.

---

## 7. Open decisions already made

- **Field crew personal thread:** Sonnet, same as office (the personal thread is cross-cutting for everyone; deal depth lives on deal threads). *(Confirm at slice 3 flip.)*
- **In-place vs switch for one-off cross-cutting questions on a deal page:** answer in place on the deal thread; reserve the visible switch for sustained cross-cutting work.
- **Multi-estimate leads / multi-job leads:** the lineage root is the LEAD; all its estimates/jobs share one deal thread until that proves wrong in practice. Splitting a runaway deal is a manual "new thread from here" affordance, not automatic.

*When this doc and the code disagree, the code is truth — update this doc in the same commit.*
