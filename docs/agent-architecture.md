# Project 86 — Agent, Session & Context Architecture

**Status:** living spec · **Scope:** the AI system (86 / Assistant / Scribe), chat sessions, and the per‑turn context layers · **Audience:** John + Rolling86 (implementer) · **Last mapped from code:** 2026‑07‑19

This document is the **base to build from**. It records how the system works *today* (grounded in the code, with file references) and the **target** it moves toward. Every "TARGET" item is a deliberate change from current behavior; everything else is a fact about the running system. When you change the code, change this doc in the same commit.

---

## 0. Design goals (the scoring function)

Optimize, in order:

1. **Correct** — the money model and writes are never wrong; server is the source of truth.
2. **Snappy** — the user sees tokens fast (perceived latency ≫ raw latency).
3. **Low‑token** — the smallest set of high‑signal tokens that gets the right answer.
4. **Observable** — every layer's cost is measured, so tuning is data‑driven not guessed.

The four universal levers (how every top agent system — Cursor, Claude Code, Devin, Tasklet — wins): **scope the session · cache the prefix · route the model · retrieve, don't stuff.** We already have partial forms of all four; this spec makes them first‑class.

---

## 1. System at a glance

```
                 user turn (chat)
                       │
        resolveHostFor User(role) ──► office roles → ASSISTANT (Sonnet)
                       │                 field crew/subs → 86 (Opus)
                       ▼
        ┌──────────────────────────────┐
        │  ASSISTANT (Sonnet 4.6)       │  fast host · reads + light writes
        │  19 custom tools + web        │  delegates writes → Scribe
        └───────────────┬──────────────┘  hands hard reasoning up ──► 86
                        │ escalate_to_86 (structured)
                        ▼
        ┌──────────────────────────────┐        ┌───────────────────────┐
        │  86 "job" (Opus 4.8)          │ writes │  SCRIBE (Sonnet 4.6)  │
        │  reasoner + DB author         │───────►│  1 tool: emit_payload │
        │  29 custom + 8 sandbox tools  │  draft │  background applier    │
        └──────────────────────────────┘        └───────────────────────┘

  Anthropic MANAGED SESSIONS API — conversation state lives server‑side at
  Anthropic (anthropic_session_id). Each turn ships ONLY the new user.message.
  System prompt + tool schemas are registered ONCE per agent and prompt‑cached.
```

Utility model: a **Haiku 4.5** one‑shot titles/labels each chat (`ai-routes.js:3497`, `max_tokens:200`) — not one of the three agents.

---

## 2. The agents

| Agent | Key | Model | Effort | Tools (custom + builtin) | Registered prefix | Role |
|---|---|---|---|---|---|---|
| **86** | `job` | `claude-opus-4-8` | high (xhigh for agentic) | 29 custom + 8‑tool sandbox = ~37 | ~26k tok (baseline + up to ~15k ref sheets + ~8k tool schemas + org memory) | Reasoner + the one that **writes to the DB**; the escalation target |
| **Assistant** | `assistant` | `claude-sonnet-4-6` | adaptive | 19 custom + `web_search`+`web_fetch` = 21 | ~7k tok (baseline + tools; **no** org memory / ref sheets) | Per‑user host for office roles; fast reads + light ops; delegates writes to Scribe, hard reasoning to 86 |
| **Scribe** | `scribe` | `claude-sonnet-4-6` | adaptive | 1 (`emit_payload_file`) | ~2k tok | Background "apply model" — materializes writes as a payload; never user‑facing |

Grounding: models `admin-agents-routes.js:2370‑2382`; tool allowlists `ROUTER_TOOL_NAMES` (86) `:2501‑2538`, `ASSISTANT_TOOL_NAMES` `:2422‑2439`, Scribe `:2397‑2405`; the model is baked onto the managed agent at create (`:2673‑2682`), so a session's registered agent governs every turn.

**Routing (who hosts a user's chat):** `resolveHostForUser` (`ai-routes.js:3144‑3159`) → `assistant` for `[system_admin, admin, corporate, pm]` (or an explicit `users.ai_host_agent_key`), else `job` (86). Field crew and subs talk to 86 directly.

**The Scribe = "apply model" split** mirrors Cursor's Fast‑Apply: the expensive reasoner (86) emits a compact *edit spec* (which fields on which entity); Scribe materializes the write. The reasoner never re‑emits whole records. Keep this discipline — it is the single biggest write‑side token saver, and we already have it.

### 2.1 Model routing — TARGET

Formalize difficulty‑based routing (Cursor "Auto mode" / cascade routers):

- **Fast lane (Haiku 4.5):** pure read / lookup / status turns ("what's this job's balance", "what's due today"). Haiku 4.5 does **not** support the `effort` param and previously botched `escalate_to_86` structured params — so the fast lane is only for turns that will **not** escalate or write.
- **Host lane (Sonnet 4.6):** the Assistant default — turns that may write (→ Scribe) or escalate (→ 86).
- **Power lane (Opus 4.8):** 86, only when a turn genuinely needs multi‑step reasoning over the DB.
- The router is a cheap classifier (rule/embedding); its latency (~1‑100 ms) is negligible vs. inference. Raise the escalation bar so **fewer** simple turns pay the Opus tax.

---

## 3. Sessions

### 3.1 Foundation — Anthropic Managed Sessions API

This is the most important structural fact and it is **already in place**:

- Conversation state lives **server‑side at Anthropic** under `anthropic_session_id`. The app does **not** re‑send full history each turn.
- A turn = open `anthropic.beta.sessions.events.stream(sessionId)` + `events.send(sessionId, {events:[{type:'user.message', content}]})` (`ai-routes.js:4057, 4094, 13907`).
- The system prompt + tool schemas are registered **once** on the per‑(agent, org) managed agent and held/cached server‑side.
- `ai_messages` is a **local display/search/export mirror only** — never replayed for a normal turn (only `seedRecoveredSession` `:3639‑3682` replays, when a session wedges).

**Consequence that drives everything downstream:** because the session "remembers" by re‑processing its accumulated server‑side history every turn, **per‑turn input tokens grow monotonically with conversation length** until compaction resets them (~150k). Anything you inject into a turn is paid **again on every later turn of that session.** → Volatility discipline (§5) and short session scope (§3.3) matter more than raw per‑turn size.

### 3.2 Schema

`ai_sessions` (`db.js:2723‑2786`) — the session table:

| Column | Meaning |
|---|---|
| `id` BIGSERIAL PK | app session id |
| `agent_key` | host agent (`job` / `assistant`) |
| `entity_type`, `entity_id` | the entity this session is bound to (nullable) |
| `user_id` FK | owner |
| `anthropic_session_id`, `anthropic_agent_id` | Anthropic‑side handles |
| `session_kind` | `user_thread` (rolling, per user+host) **or** `legacy_partitioned` (per user+entity) |
| `label`, `summary`, `pinned`, `turn_count`, `total_cost_usd` | sidebar + cost |
| `effort_override`, `last_compacted_at`, `archived_at` | tuning + lifecycle |

`ai_messages` (`db.js:1389‑1409`) — local mirror, keyed by `(user_id, entity_type, estimate_id)` where `estimate_id` is the **legacy column name for `entity_id`**. Grows ~1‑2 rows/turn, unbounded, never re‑sent wholesale.

### 3.3 Session taxonomy

Two shapes exist; the resolver supports both (`resolveSessionForChat` `ai-routes.js:3161‑3320`):

- **`user_thread`** — ONE rolling Anthropic session per `(user, host agent)`. Default today (`FLAG_UNIFIED_USER_THREAD` ON). Office chat + estimate chat + job chat all accumulate into this **one long‑lived thread**; the open entity rides as a per‑turn `<turn_context>` block, not as session scope.
- **`legacy_partitioned`** — one session per `(user, entity_type, entity_id)`. Entity‑scoped. Still fully supported by the resolver.

**TARGET — entity‑scoped sessions per surface.** Bind a chat opened *from* a job/lead/estimate to that entity (the `legacy_partitioned` shape) instead of dumping it into the unified thread. Rationale: each session's accumulated history stays short + on‑topic, per‑turn re‑processing is bounded, the entity context becomes a stable cacheable prefix, and leaving the surface resets the reprocessing floor. Keep **one** rolling personal `user_thread` for cross‑cutting chat ("what's my day", "message the crew").

**TARGET — "sort sessions" = group by entity.** The sidebar lists sessions under their `entity_type`/`entity_id` (columns already exist) — Job ▸ its chats, Lead ▸ its chats — plus the personal thread. This is the concrete answer to "another way to sort sessions."

### 3.4 Lifecycle

- **Create:** `createFreshAiSession` (`ai-routes.js:3335‑3370`) → `anthropic.beta.sessions.create({agent, environment_id, title})` then INSERT the row.
- **Resolve:** `resolveSessionForChat` — unified mode returns/mint the rolling thread for `(user, hostKey)`; legacy mode anchors to the entity for `ANCHORABLE=[estimate, job, lead, intake]`.
- **"+ New chat":** `POST /api/ai/sessions` with `session_kind:'user_thread'`, stamps `agent_key = resolveHostForUser(user)` so a new chat sticks to its host (`ai-sessions-routes.js:245‑308`).
- **List:** `GET /api/ai/sessions` ordered pinned DESC, last_used DESC, archived excluded (`:42‑69`); search joins `ai_messages.content`.
- **Archive / delete:** PATCH `archived` (`:341‑343`); DELETE archives the Anthropic session + removes the row but **leaves `ai_messages`** (shared across sessions).
- **Compaction:** beta `compact-2026-01-12` on (`ai-routes.js:94`); Anthropic auto‑summarizes near ~150k input tokens; `last_compacted_at` stamped on `session.compaction_complete`. Manual `POST /:id/compact` exists.
- **Concurrency:** `acquireUserTurnLock` (`:2326‑2351`) allows **one in‑flight turn per user** (all their chat shares one Anthropic session per host), 6‑min TTL; a concurrent turn gets a "still working" error.

---

## 4. Context layers (the heart of the system)

### 4.1 What ships each turn

The per‑turn wire payload is a single `user.message` event (`ai-routes.js:13752‑13770`):

```
userContent = [ ...inline image blocks (≤18) ,
                { text: "<turn_context>…</turn_context>\n\n<page_context>…</page_context>\n\n<user message>" } ]
```

`<turn_context>` is assembled by `buildTurnContext` (`ai-routes.js:2726‑2953`). In order:

| # | Layer | Volatility | Source | Notes |
|---|---|---|---|---|
| 1 | `today_digest` (turn 1 only) | one‑shot | `buildTodayDigest` | prepended on fresh session (`:13831`) |
| 2 | `<acting_user>` | **session‑stable** | users row | who "I/me/my" is (`:2927‑2948`) |
| 3 | entity snapshot | entity‑data | `buildJob/Estimate/Intake/Client/StaffContext` | **2‑5k tok — the big one**; has dedup |
| 4 | `<available_tools>` | **redundant** | `renderAvailableToolsBlock` | restates tool *names* already in the registered schema (`:2768`) |
| 5 | `<recent_applied_payloads>` | **ephemeral** | payloads (10‑min window) | relative "Xs ago" timestamps (`:2797‑2808`) |
| 6 | `<recent_background_tasks>` | ephemeral | agent_jobs (24‑hr) | `:2834‑2846` |
| 7 | `<recent_failed_payloads>` | ephemeral | payloads (1‑hr) | structured field‑error detail (`:2875‑2889`) |

Outside `<turn_context>`: `<page_context>` (where the user is, `renderPageContextBlock` `:13530`) + the user's text + inline photos.

**What does NOT ship per turn (correctly baked into the cached registered prefix):** the platform baseline identity, org identity, org memory (86 only), reference sheets (86 only, up to ~15k tok), the retired `SECTION_DEFAULTS` playbook (~3.5k tok/turn saved when it was moved to the prefix, 2026‑05‑22), and all tool JSON schemas.

### 4.2 The volatility principle (why this matters)

On the managed session, **every layer you inject lodges in server‑side history and is re‑processed on every future turn until compaction.** So a layer isn't paid once — it's paid for the rest of the session. Therefore each layer must be placed by how often it actually changes:

- **Session‑stable** (`acting_user`, "which entity is open") — never changes in a session, so re‑injecting it every turn buys nothing and re‑processes forever. → **Send once** (session bootstrap), not every turn. *(TARGET)*
- **Entity‑snapshot** (the 2‑5k render) — changes only when the entity's data changes. → **Dedup** (already the biggest live lever, §4.3), fix its key.
- **Ephemeral** (applied/failed payloads, background tasks) — relevant for a few turns only, yet they lodge permanently and their **relative timestamps go stale‑wrong**. → **Absolute timestamps + clear from history after they age out** (the "tool‑result clearing" pattern). *(TARGET)*
- **Redundant** (`<available_tools>`) — the model already has the schema. → **Cut.** *(TARGET)*

### 4.3 Entity‑snapshot dedup (the current biggest lever)

`_entityCtxSent` Map (`ai-routes.js:13799‑13822`): sha1 of the rendered entity text, keyed `anthropic_session_id | entity_type | entity_id`, 15‑min TTL. On an unchanged match it swaps the whole 2‑5k snapshot for a one‑line `<entity_snapshot_unchanged>` marker. Saves 2‑5k tok/turn.

**Known weakness (TARGET fix):** keyed by `anthropic_session_id`, so any session recovery/recreation (new id) re‑ships the full snapshot. Re‑key on `(entity_type, entity_id, hash)` so a recovered session still skips it; consider a longer TTL.

### 4.4 Observability — `logContextLoad`

Each turn logs the `turn_context` bundle as one event (`ai-routes.js:2904‑2920`, `layer:'turn_context'`, `size_chars` = **total**). Other layers are logged elsewhere: `memory` (`:11196`), `entity_search` (`:7942`), `entity_read` (`:7954`), `wave3` (`:11298`).

**Gap (TARGET):** the turn_context bundle is one number, so you cannot see which *sub‑layer* (acting_user vs entity vs payloads vs tasks) costs what — you're tuning blind. **Instrument per‑sub‑layer** so the registry's Turn Context card shows the real split. *This is the recommended first move — it makes every later decision data‑driven.*

### 4.5 Context layers — TARGET design

Same layers, re‑tiered by volatility, plus a meter:

1. **Meter first:** per‑sub‑layer `logContextLoad`.
2. **Session‑stable → bootstrap once:** move `acting_user` + entity identity into the session's first message / registered context; stop re‑injecting.
3. **Entity‑snapshot → dedup + re‑keyed** (§4.3), backed by a pre‑computed **digest** (§5.2) instead of a raw row dump.
4. **Ephemeral → absolute‑time + clearable:** stamp real times, and strip these blocks from history once they age past their window so they stop re‑processing.
5. **Redundant → delete** `<available_tools>`.
6. **Retrieve for detail:** give the assistant `get_job` / `get_estimate_lines` / `get_po` tools so it pulls detail on demand rather than pre‑loading everything into the snapshot.

---

## 5. Caching model

### 5.1 What's cached today (well)

- **Registered prefix** (system + tool schemas) is prompt‑cached on the managed agent; billed as cache‑read (~0.1×) each turn. The prefix is **stable by design** — reference sheets deliberately omit their fetch timestamp so a 15‑min refresh with identical data doesn't re‑register (`admin-agents-routes.js:3743‑3746`); resync is 6‑h throttled + content‑hash gated (`:3777‑3782`). One needless resync = ~$1.89 of `cache_creation` (`:3772`).
- Inline Messages path (secondary) wraps the stable block + last tool in `cache_control:{ephemeral}` (`ai-routes.js:2129, 2466`).
- `cache_creation_input_tokens` / `cache_read_input_tokens` are persisted per assistant message (`:2544‑2551`).

### 5.2 TARGET — the per‑entity digest as the cacheable block

Assemble **one small, high‑signal digest per entity** — status, contract/CO/PO totals, balance, key dates, open tasks (rollups the app **already computes** server‑side) — and make *that* the stable per‑entity block, instead of re‑rendering 2‑5k of raw rows. It pairs with prompt caching (the digest is the cacheable blob) and, in an entity‑scoped session, makes the 2nd..Nth turn read the prefix at ~10% cost + ~85% lower latency. Pre‑warm the cache when a surface opens.

---

## 6. Escalation (Assistant → 86)

**Current (`ai-routes.js:12157‑12393`):** the Assistant's `escalate_to_86` → `driveEscalateTo86`, which:
1. mints a **brand‑new Opus session every time** (`sessions.create` `:12183`) — no warm cache, so TTFT depends on Anthropic's ~5‑min cross‑session ephemeral cache being hot;
2. runs sequential pre‑work (env read → agent read → sessions.create → jobNumber resolve → `buildJobContext(escalationLean)`), all awaited in series (`:12175‑12253`);
3. is **fully blocking and NOT streamed** — `driveSubtaskTurn` accumulates 86's whole answer into `collectedText` (`:12386‑12393`) while the client gets only `: hb` heartbeats every 15 s (`:3774‑3777`). Visible time‑to‑first‑token for an escalated question = the **entire** 86 Opus turn (thinking + every internal read + full answer), *then* the Assistant relays.

This is where "it feels slow" comes from.

### TARGET

- **Stream 86's tokens through to the user** — forward `agent.message` deltas out the parent SSE instead of accumulating. Converts a minutes‑long blank wait into live progress. *(highest perceived‑speed win)*
- **Warm‑pool a 86 session per user/org** instead of cold‑creating one per escalation — keeps the cached prefix hot, skips the create round‑trip.
- **Parallelize the pre‑work** (env/agent reads + context‑pack build concurrent with `sessions.create`).
- **Raise the escalation bar** so simple business questions stay on the snappy streaming Sonnet host.

---

## 7. Background tasks & subagent isolation

The `agent_jobs` queue + headless 86 runner (see the background‑tasks system) already embodies **subagent context isolation** (Claude Code / Amp pattern): heavy or noisy work (bulk OCR, cost rollups, research) runs in its own context and should return only a **1‑2k‑token summary** to the user‑facing thread, so raw dumps never pollute it. Surfaced back to chat via `<recent_background_tasks>` (§4.1). Keep the "return a summary, not the raw dump" discipline as new background tasks are added.

---

## 8. Invariants (the rules we don't break)

1. **Server is the source of truth for writes.** On any write/push, the server re‑derives/re‑explodes; client numbers are never trusted.
2. **Reasoner emits a spec, Scribe materializes it.** The expensive model never re‑emits whole records.
3. **Cache the prefix; keep it stable.** No volatile ids/timestamps in the registered prefix. Volatile content rides the turn, at the end.
4. **Volatility tiering.** Session‑stable → once. Entity‑snapshot → dedup. Ephemeral → clearable. Redundant → cut. (§4.2)
5. **Scope the session to the surface.** Entity work → entity‑scoped session; cross‑cutting → the one personal thread. (§3.3)
6. **Route by difficulty.** Fast lane (Haiku) for reads, host (Sonnet) for the Assistant, power (Opus/86) only when needed. (§2.1)
7. **Retrieve, don't stuff.** Lightweight identifiers + on‑demand tools over pre‑loaded blobs. (§4.5)
8. **Measure every layer.** No optimization without the per‑layer meter. (§4.4)

---

## 9. Migration order (current → target)

Ranked impact × effort. Each ships independently; none blocks the others.

**Tier 0 — snappiness (do first; low effort, biggest *felt* win)**
- [ ] Stream 86's escalation tokens to the client (§6).
- [ ] Warm‑pool the 86 escalation session (§6).
- [ ] Raise the Assistant's escalation bar (§2.1, §6).

**Tier 1 — 86 token diet (biggest cost lever)**
- [ ] Move reference sheets `inline` → `lookup` on demand; lower `REF_LINKS_PROMPT_CAP` (reclaims up to ~15k tok/turn).
- [ ] Gate the 8‑tool sandbox bundle to sessions that need code‑exec; prune rarely‑used reads; trim the ~6 fattest tool schemas.
- [ ] Set explicit `max_tokens` on managed `sessions.create`.

**Tier 2 — session architecture + context layers (the structural move)**
- [ ] Per‑sub‑layer `logContextLoad` meter (§4.4) — **first**.
- [ ] Entity‑scoped sessions for job/lead/estimate surfaces; sidebar grouped by entity (§3.3).
- [ ] Per‑entity digest as the cacheable block (§5.2); re‑key the dedup (§4.3).
- [ ] Re‑tier the context layers: bootstrap session‑stable once, make ephemeral clearable, cut `<available_tools>` (§4.5).
- [ ] Retrieval tools for entity detail (§4.5).

**Tier 3 — Assistant snappiness/cost**
- [ ] Haiku fast‑lane for read‑only turns (§2.1).
- [ ] More aggressive compaction of the personal thread.

---

## 10. Open decisions (John's call)

1. **Entity‑scoped by default?** Flip entity surfaces to `legacy_partitioned`, or keep unified + rely on scoping only for the digest/dedup? (Recommend: entity‑scoped for job/lead/estimate; keep one personal thread.)
2. **Haiku fast‑lane scope.** Which turn classes are safe for Haiku (definitely: pure reads that can't escalate/write)? Needs the classifier + a fallback‑to‑Sonnet on any structured‑tool need.
3. **Ephemeral clearing horizon.** After how many turns / minutes do applied/failed/background blocks get stripped from history?
4. **Reference‑sheet inline whitelist.** Which sheets (if any) are always‑needed enough to stay inline vs. lookup‑on‑demand?

---

*Grounding note: model ids, tool counts, token sizes, and file:line references were mapped directly from `server/routes/ai-routes.js`, `admin-agents-routes.js`, `ai-sessions-routes.js`, and `db.js` on 2026‑07‑19. Re‑verify against the code before implementing any Tier item.*
