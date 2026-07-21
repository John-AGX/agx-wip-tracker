# The Efficient Agent Design Template

**Companion to** `agent-architecture.md` (that doc = *what is* + *migration*; this doc = *the pattern everything converges to*). **Use it** whenever you add or refactor a surface, agent, tool, or context layer — the thing you build must satisfy this template. **Audience:** John + Rolling86.

---

## The one principle: **cheap by construction**

You do not make the AI cheap by trimming after the fact. You make it cheap by **placing every token where it is paid the fewest times, and routing every turn to the cheapest model that can do it.** Two facts force this:

1. **Managed sessions re-process their accumulated history every turn** → a token injected once is paid on *every later turn* of that session until compaction. Volatility is destiny.
2. **A cached prefix costs ~10% of a fresh one** → keeping the stable stuff stable, first, and reused is the biggest lever you have.

Everything below is a mechanical consequence of those two facts.

---

## Part 1 — The must-haves (5) and *why*

Each must-have is non-negotiable because removing it re-introduces one of the two costs above. "Done when" is the acceptance test.

| # | Must-have | Why (the cost it kills) | Done when |
|---|---|---|---|
| **M1** | **Every session is bound to a scope** — an entity (job/lead/estimate) or the one personal thread | An unscoped thread accumulates every topic's history and re-processes all of it every turn. Scope **bounds the reprocessing floor** and makes the prefix cacheable. | A chat opened from a job is a job session; leaving the surface stops growing it. |
| **M2** | **Every turn's context is a volatility-tiered envelope** (Part 2) | On managed sessions the *only* thing that controls cost is where a token lives. Untiered context pays volatile prices for stable content forever. | Each token's zone matches its change-frequency; a per-turn re-inject of stable content is a lint failure. |
| **M3** | **Every turn is routed by difficulty** — fast / host / power | ~80% of turns are simple reads. Paying the power model (Opus) for them is pure waste, and it's the main source of "feels slow." | A "what's this job's balance" turn never touches Opus; only reasoning turns escalate. |
| **M4** | **Every entity has one cacheable digest** — a small, high-signal, server-computed blob | Re-rendering 2‑5k of raw rows every turn is the biggest volatile cost. A digest is small, reusable, and cacheable — it turns the 2nd..Nth turn on a surface into a ~10% / ~85%-faster read. | The entity block is a ≤~1.5k digest, hashed + dedup'd, re-keyed on `(entity, hash)`. |
| **M5** | **Every layer self-reports its cost** — per-layer `logContextLoad` | You cannot optimize what you cannot see. Today the whole turn_context logs as one number → tuning is blind. | The registry Turn-Context card shows the per-zone / per-layer split; a regression shows up as a line moving. |

**Why these five and not more:** M1 bounds *how long* context lives, M2 bounds *how much* rides each turn, M3 bounds *what model* pays for it, M4 is the concrete cheap form of the biggest layer, and M5 keeps all four honest. Drop any one and a cost re-opens.

---

## Part 2 — The structure: the **Context Envelope** and *why*

Every turn's tokens live in exactly **four concentric zones, ordered least→most volatile.** The zone determines how many times a token is paid. This ordering is the whole design.

```
 ┌─ ZONE 0 · REGISTERED PREFIX ─────────────── changes: ~never ─ paid: once / cache window (~0.1x) ┐
 │   agent identity · tool schemas · org memory · reference LOOKUPS (not inline)                   │
 │  ┌─ ZONE 1 · SESSION BOOTSTRAP ───────────── changes: never within a session ─ paid: once ────┐ │
 │  │   acting_user · which entity is open · the entity DIGEST (first send)                       │ │
 │  │  ┌─ ZONE 2 · ENTITY REFRESH ───────────── changes: when entity data changes ─ paid: on Δ ─┐ │ │
 │  │  │   digest delta / re-send only when the hash moves (dedup marker otherwise)              │ │ │
 │  │  │  ┌─ ZONE 3 · VOLATILE TAIL ──────────── changes: every turn ─ paid: per turn, then CLEARED ┐
 │  │  │  │   the user message · ephemeral blocks (recent payloads/tasks, ABSOLUTE-timed) · photos │
 │  │  │  └──────────────────────────────────────────────────────────────────────────────────────┘
 │  │  └──────────────────────────────────────────────────────────────────────────────────────────┘
 │  └──────────────────────────────────────────────────────────────────────────────────────────────┘
 └──────────────────────────────────────────────────────────────────────────────────────────────────┘
```

**The placement rule (the one lint):** *a token may live only in the innermost zone whose volatility it matches.* Put stable content in an outer zone (cheap); never let it drift inward (expensive).

**Why each zone exists:**
- **Zone 0 — Registered prefix.** Registered once on the managed agent, cached server-side. This is where identity, tools, and reference data belong because they change ~never. *Every token you can push out to Zone 0 stops being a per-turn cost.* (Today's bug: ~15k of reference sheets are inlined here correctly, but they don't all need to be inline — the ones rarely used belong behind a `search_reference_sheet` lookup, which is Zone 0's cheapest form: reachable, not resident.)
- **Zone 1 — Session bootstrap.** Content that is fixed *for this session* but not global: who the user is, which entity they're on, the opening digest. Send it **once** as the first event. *(Today's bug: `acting_user` re-ships every turn → it lives in Zone 3 but belongs in Zone 1, so it re-processes forever.)*
- **Zone 2 — Entity refresh.** The entity's data does change, so it needs a channel — but only *on change*. The dedup marker is the "no delta" signal. This is where M4's digest is refreshed.
- **Zone 3 — Volatile tail.** The genuinely per-turn stuff: the message, photos, and time-sensitive event blocks. The rule that makes Zone 3 cheap: **it ages out.** Ephemeral blocks get absolute timestamps (never "12s ago") and are **cleared from history after a few turns**, so they don't re-process forever.

**Why the ordering (outer = stable) matters for caching:** the model caches a *prefix*. A stable outer boundary means Zones 0–1 are a cache hit on every turn; only the inner zones are fresh. Reshuffle the order (volatile content near the top) and you bust the cache — which is exactly the failure mode this structure prevents.

---

## Part 3 — The three sub-templates

### 3a. The Session template
```
session = {
  scope:  entity(job|lead|estimate)  OR  personal(user_thread)   // M1
  bootstrap_sent: bool                                            // Zone 1 sent once
  digest_hash:    sha1(entity_digest)                             // M4 dedup key = (entity, hash)
  host_agent:     assistant | job                                // by role
  compaction:     auto @ threshold  (lower for the personal thread)
}
```
- Entity surfaces → entity-scoped. Cross-cutting ("my day", "message the crew") → the one personal thread.
- Sidebar groups sessions **by entity** (the "sort sessions" answer).

### 3b. The Turn template (what goes in each zone)
```
Zone 0  (registered, cached)     : identity + tools + org memory + ref LOOKUPS
Zone 1  (once per session)       : acting_user + entity identity + opening digest
Zone 2  (on entity change only)  : digest delta   |  <entity_snapshot_unchanged> marker
Zone 3  (this turn, then cleared): user message + ephemeral(absolute-timed) + photos(≤18)
```
An efficient steady-state turn (same entity, no data change) = **user message + a dedup marker**, everything else a cache read.

### 3c. The Routing template
```
route(turn):
  needs multi-step reasoning over the DB?   → POWER  (86 / Opus 4.8)
  will write or may escalate?               → HOST   (Assistant / Sonnet 4.6)
  pure read / lookup / status?              → FAST   (Haiku 4.5)     // must NOT escalate/write
  default                                    → HOST
```
Router = a cheap classifier (~1‑100 ms, negligible vs. inference). **Bias the bar upward** — keep turns on the cheapest lane that can be correct; escalate reluctantly.

---

## Part 4 — How we achieve it (mechanism per must-have)

| Must-have | Mechanism | Where it hooks |
|---|---|---|
| M1 scope | Resolve entity surfaces to `legacy_partitioned` (entity) sessions; keep one `user_thread`; sidebar groups by `entity_type/entity_id` | `resolveSessionForChat`, `ai_sessions` (cols exist) |
| M2 envelope | Tag each context block with its zone; assemble in zone order; lint stable-in-Zone-3 | `buildTurnContext` |
| M3 routing | Difficulty classifier in front of host selection; Haiku fast-lane gated to no-escalate/no-write turns | `resolveHostForUser` + a pre-turn classifier |
| M4 digest | Server-computed per-entity digest (reuse existing rollups) as the Zone‑1/2 block; dedup re-keyed `(entity, hash)` | new `buildEntityDigest`, `_entityCtxSent` |
| M5 meter | `logContextLoad` per zone+layer, not per bundle | `logContextLoad` call sites |
| Cache | Stable zone order + pre-warm the digest when a surface opens | prefix assembly + surface-open hook |
| Escalation | Warm-pool a 86 session per user + **stream** its deltas out the parent SSE | `driveEscalateTo86` / `driveSubtaskTurn` |
| Clearing | Strip aged ephemeral blocks from session history after N turns | ephemeral block injectors |

---

## Part 5 — The efficiency budget (the template's measurable target)

Ground truth today vs. the target the template enforces:

| Zone / metric | Today | Target |
|---|---|---|
| Zone 0 — 86 registered prefix | ~26k (≤15k inline ref sheets + ~8k tools) | ≤ ~12k (ref sheets → lookup, fat schemas trimmed) |
| Zone 0 — Assistant prefix | ~7k | ≤ ~6k |
| Zone 1 — bootstrap | (not a zone — re-sent every turn) | ≤ ~1k, once |
| Zone 2 — entity block | 2‑5k **every turn** | ≤ ~1.5k digest, **only on change** |
| Zone 3 — volatile tail | small but **never cleared** | user msg + ≤ ~0.5k, cleared after ~5 turns |
| **Steady-state fresh tokens / turn** (same entity) | 2‑5k + monotonically-growing reprocess | **≤ ~0.5k** (message + marker) |
| Escalation TTFT | full cold-Opus turn (blocking) | first token in ~1‑2 s (warm + streamed) |

If a change moves a number the wrong way, it violates the template.

---

## Part 6 — Using the template (for anything new)

- **New surface?** It gets an entity-scoped session (M1), a digest (M4), and rides the same envelope (M2). Don't invent a new context path.
- **New agent?** Declare its lane (fast/host/power) and its Zone‑0 tool set; it inherits the envelope + router.
- **New context layer?** Classify its volatility → assign a zone → give it a `logContextLoad` line. If it's stable, it goes to Zone 0/1, not Zone 3.
- **New tool?** Fat description = permanent Zone‑0 weight on every turn of every session. Keep schemas lean; prefer a lookup tool over an inline blob.

---

## Part 7 — Anti-patterns (what violates the template — using the real current cases)

- **Stable content in Zone 3** → `acting_user` re-sent every turn. *(Move to Zone 1.)*
- **Reference data resident when it could be reachable** → ~15k of inline ref sheets on every 86 turn. *(Move rarely-used ones to lookup.)*
- **Ephemeral content that never clears** → `recent_applied_payloads` with "Xs ago" lodges forever and goes stale-wrong. *(Absolute-time + clear after N turns.)*
- **Redundant content** → `<available_tools>` restates the registered schema. *(Delete.)*
- **Raw dump where a digest belongs** → the 2‑5k entity render every turn. *(Digest + dedup.)*
- **One session for everything** → the unified thread carries office + estimate + job history in one place. *(Entity-scope the surfaces.)*
- **Blocking, non-streamed escalation** → heartbeat-only silence for the whole cold-Opus turn. *(Warm + stream.)*

---

*The template is the invariant; the Tier 0‑3 plan in `agent-architecture.md` §9 is the path to it. When current and template disagree, the template wins — file the gap as a Tier item.*
