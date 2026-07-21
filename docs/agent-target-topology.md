# Agent Target Topology — the premium blueprint

**Companion to** `agent-architecture.md` (the system) and `agent-design-template.md` (the context template). **This doc** answers: *is the three‑agent system the most efficient shape, and if not, what is?* **Audience:** John + Rolling86.

> **This is v2 — pressure‑tested.** A 4‑dimension adversarial review (18 confirmed findings) overturned two premises in the first draft. Corrections are folded in and called out in the boxes marked **⟳ review**. Read those — they are the difference between a plan that builds and one that stalls.

> **Verdict.** The three **roles** are right — converse / reason / write is the correct decomposition. What's inefficient is the **wiring**: each role is pinned to one fixed, over‑provisioned model, escalation is a cold blocking hand‑off, writes ride on a single ungrounded generation, and background runs single‑threaded. The premium path is the **same roles, tiered by model, with a grounded verifier added and escalation made warm‑*ish* + streamed** — but the *mechanism* is constrained by one hard fact the first draft got wrong (§2). It is a re‑architecture of the routing + the write path, not a rewrite.

---

## 1. The core reframe: role ≠ model

"3 agents" today literally means "3 fixed models" (Assistant→Sonnet, 86→Opus, Scribe→Sonnet), baked at registration. That conflates **role** (the job: host & route · reason · write · verify) with **tier** (the model: Haiku · Sonnet · Opus). A premium system separates them: a role runs on the *cheapest tier that clears the turn's bar.*

**Do not** add domain‑specialist agents (an "estimating agent," an "AP agent") — at single‑org scale that multiplies cost and routing surface for no gain. We keep the role count and add exactly one: the **critic**.

---

## 2. The hard constraint that shapes everything: managed sessions bind the model *per session, immutably*

> **⟳ review — the first draft was wrong here, twice.** (a) It claimed model is bound *at agent registration* and therefore tiering requires *registering separate agents.* False: `sessions.create` accepts an **`agent_with_overrides`** form that overrides `model` (and system/tools/mcp/skills) against **one base agent** — no extra registrations, no prompt drift, keeps managed history/compaction. (b) But the deeper truth the draft missed: **you cannot change a session's model after it is created** (`sessions.update` can only change tools/mcp). So **there is no per‑turn model routing inside one continuous managed thread — a tier change forks a new session.** Verified against the current `managed-agents-2026-04-01` docs + the code (`admin-agents-routes.js:2673`, `ai-routes.js:11957`).

This reshapes "route by tier." Three shapes are available; pick per role:

| Shape | How | Keeps | Costs |
|---|---|---|---|
| **A · Per‑session tier (override)** | mint the session with `agent:{type:'agent_with_overrides', id, model:{id:…}}` | managed history + compaction; one base agent | model fixed for that session's life; a tier change = a new session |
| **B · In‑process Messages path** | run the turn on `messages.create`, model per request | true per‑turn model choice | you own history; forfeits managed server‑side session + native compaction |
| **C · Ephemeral tier‑worker** | a read/critic turn runs in a throwaway session (or Messages call), re‑grounded by the digest | cheap, isolated | no conversational continuity for that turn (digest gives entity *state*, not the last few messages) |

**Caches are model‑scoped regardless.** The Haiku prefix and the Sonnet prefix are cached separately whether they come from two agents or one agent with overrides — overrides remove the *registration* multiplication, **not** the per‑model cache duplication.

---

## 3. The four roles

| Role | Job | Today | Target |
|---|---|---|---|
| **Host** | converse + the continuous thread | fixed **Sonnet** | **Sonnet** stays the continuous host (safe default); cheap reads offloaded (§4) |
| **Reasoner (86)** | multi‑step reasoning + the write‑spec | **Opus** — field crew hit it for trivial asks | **Opus, reached only on need** |
| **Writer (Scribe)** | materialize a write‑spec | **Sonnet** | **Haiku**, once the write path is unified + verified (§6) |
| **Critic** | grounded verify at the write chokepoint | **missing** | a server‑side checker at `applyPayload` (§6) |

---

## 4. Where the Haiku win actually lives

Given §2, you don't flip the host to Haiku mid‑thread. The realistic, honest win:

- **The continuous host stays Sonnet.** It's the thread with memory; keep it safe and coherent.
- **Route pure, self‑contained read turns** ("what's this job's balance", "what's due") to a **Haiku tier‑worker** — Shape C: a cheap call re‑grounded by the entity **digest**, no continuity needed because the answer is a lookup. This is where the ~80%‑of‑turns‑are‑reads economics pay off, without fragmenting the conversation.
- **Follow‑up reads that need "what about the other one"** stay on the Sonnet host (they need the thread). The router's job is to recognize the self‑contained lookups and peel only those off to Haiku.
- **Escalate writes/reasoning to 86** (§5).

> **⟳ review.** The draft's "host‑haiku + host‑sonnet as two registered agents, continuity preserved by the digest" was wrong two ways: those would fork the `agent_key`‑scoped `user_thread` into two diverging histories, and the digest carries entity *state*, not dialogue. The corrected model above avoids the fork by keeping one continuous host and offloading only *stateless* reads.

---

## 5. Escalation — streamed, ephemeral, de‑narrated (not warm‑pooled)

**Today (`ai-routes.js:12157‑12393`):** Assistant→86 mints a fresh Opus session, runs sequential pre‑work, then **blocks un‑streamed** — heartbeat‑only silence for the whole Opus turn, then the host relays the answer.

**Target:**
- **Stream 86's output as a distinct, labeled event** — not raw deltas onto the parent bubble. Emit `event:'subagent_delta'`, render it in a separate "86 is working…" panel, and **suppress the host's re‑narration** (the host relays a one‑line handoff, not a full restatement). *(⟳ review: 86's answer is already returned to the host as a tool_result which the host re‑narrates — streaming raw deltas onto the same bubble double‑renders. All `res.write` must stay on the parent loop's `send()`.)*
- **Overlap the pre‑work** (env/agent reads + the escalation context‑pack) with the session open instead of awaiting serially.
- **Keep escalation sessions ephemeral.** *(⟳ review: do NOT warm‑pool a persistent 86 session per user/org. The per‑user turn lock only guards the two host chat endpoints; the background `agent_jobs` worker drives 86 sessions unlocked, so a pooled per‑user 86 session is corruptible by a concurrent background job, and a per‑org pool bleeds one user's job context into another's escalation. The existing context‑pack already removed most of the cold‑read tax the draft blamed on cold sessions — verify a pool saves anything before taking the collision risk.)* If pooling is ever revisited: per‑user only, and the mutex must span **every** driver (host + background), never org‑level.
- **Raise the escalation bar** so fewer turns escalate at all.

---

## 6. The critic — at the write chokepoint, grounded server‑side

> **⟳ review — the draft placed this wrong.** "Between the spec and Scribe" misses most writes: `emit_payload_file` is dispatched **directly** by 86 (not via Scribe), background watchers author writes directly, and Scribe itself calls `execEmitPayloadFile`/`applyPayload`. The single funnel **every** server‑side write passes through is **`execEmitPayloadFile → applyPayload`** (`payload-dispatcher.js`). Put the critic and the deterministic hooks **there**, and **unify the two authoring tools** (retire one of `emit_payload_file`/`scribe_write`) so there is one path to gate.

- **Grounded, at `applyPayload`.** Verify the *materialized* changeset against retrieved real state: does the CO reconcile, is the bill's vendor on the PO, does closing the job leave retainage. On failure: retry once, else downgrade to a flagged draft.
- **Money authorities must move server‑side first.** *(⟳ review: `getJobCOTotals` and `p86Pricing` are browser‑only globals — a server critic cannot call them. And estimate/CO `propose_*` writes currently apply **client‑side** — the server never sees them. Before the critic is real: port the reconciliation math into server modules, and give the client‑apply path its own server re‑derivation guard. Don't claim "100% money‑write coverage" until both write mechanisms are covered.)*
- **Close the TOCTOU window.** *(⟳ review: the dry‑run/critic runs at **authoring** time; the real commit happens **later** on human approval, against possibly‑changed state. Re‑derive + diff the changeset against what was approved **inside the commit transaction**, reject/re‑card on mismatch, and make writes idempotent — dedupe on `tool_use_id` — so `execProposeCreateLead` and friends can't double‑apply.)*
- **Deterministic hooks alongside** (non‑LLM: block any write that orphans a cost, require `job_id` on financial rows) — the hook catches what the model shouldn't be trusted to judge.

---

## 7. Structured outputs — a targeted tool, not the topology's unlock

> **⟳ review — de‑sequenced.** The draft made strict structured outputs the "do‑first precondition that gates everything." It doesn't, for three reasons: (1) **strict tool inputs aren't available on the managed path** — managed custom tools take only `{type,name,description,input_schema}`, no `strict`; the code even *strips* `additionalProperties` (which strict requires) because the managed validator rejects it. (2) `emit_payload_file`'s `ops` is a **freeform JSONB** object that can't be expressed as a strict schema at all without enumerating the whole dispatcher vocabulary (enum‑drift → silent write‑loss). (3) Strict guarantees **shape, not correctness** — the real failures your bounce‑loops handle (`driveScribeWrite` retries; the `<recent_failed_payloads>` feedback) are **semantic** (wrong ids, totals that don't reconcile), which strict can't touch.

Where strict *does* help, use it: the **in‑process, structured hand‑offs** — the `escalate_to_86` param object, and the extract‑lead/extract‑PO calls that already use `output_config`. That's the narrow, real win (it's what broke Haiku on escalation). It is **not** a precondition for the tiering or the critic; the semantic validation loops stay either way.

---

## 8. Background — parallel workers, batched only where truly single‑shot

- **Fan‑out for genuine parallel work** — 86 as orchestrator spawning N isolated sub‑agents ("audit every open job," "reconcile all bills," bulk‑doc OCR), one per item, merged into a review grid. The `agent_jobs` queue exists; it runs single‑threaded (and its `MAX_CONCURRENT=2` is per‑instance, so effective concurrency is already `2 × instances`).
- **Gate fan‑out on spend + concurrency.** *(⟳ review: a 16‑wide Opus fan‑out with no per‑run cap is the silent‑spend failure you've been bitten by. `SUBTASK_BUDGET_TOKENS` is per‑fire, not per‑job. Resolve the per‑run budget flag (§10 flags) first; enforce a DB‑backed cross‑instance concurrency cap + a per‑job spend cap before fanning out.)*
- **Batch only single‑shot sub‑steps.** *(⟳ review: the Batch API is stateless Messages‑only — it cannot run the agentic managed‑session jobs, which are exactly the "top spender" the draft pointed at. Batch the genuinely single‑shot calls — the bulk‑doc OCR/extraction — and leave the tool‑looping runner on the managed path at full price.)*

---

## 9. The honest cost ledger

- **Router:** ~free (a classifier).
- **Haiku for stateless reads:** the real win — Haiku is a fraction of Sonnet and reads are the bulk of traffic. *(Not "the host becomes Haiku"; §4.)*
- **Per‑model caches don't share** (§2) — pricing the Haiku read‑worker means its own cached prefix, but that prefix is tiny (lean read toolset + digest).
- **Critic:** one extra cheap pass per money‑write — bounded (writes only), and it prevents the far costlier wrong write + rework.
- **Escalation:** streaming + overlap cut *perceived* latency; ephemeral (not pooled) keeps it safe.
- **Net:** cost down (Haiku reads + batched OCR), reliability + snappiness up (critic + streamed escalation) — without the registration/resync multiplication the draft wrongly priced in.

---

## 10. Build order (revised)

Sequenced so nothing gates on a capability that isn't there.

1. **Unify the write path + move money authorities server‑side.** Retire one authoring tool; make `applyPayload` the sole funnel; port `getJobCOTotals`/pricing into server modules; guard the client‑apply estimate/CO path. *This is the real foundation — the critic and safe tiering both depend on it.*
2. **The grounded critic + deterministic hooks at `applyPayload`**, with commit‑time re‑derive/diff + idempotent writes (TOCTOU).
3. **Streamed, de‑narrated escalation** (distinct `subagent_delta` event; suppress re‑narration; overlap pre‑work). Keep sessions ephemeral.
4. **The read router + Haiku tier‑worker** (Shape C) for stateless lookups, grounded by the entity digest.
5. **Strict outputs on the in‑process hand‑offs** (`escalate_to_86` params) — the narrow real win; not a gate.
6. **Scribe → Haiku**, once (1)+(2) make writes safe.
7. **Background fan‑out** (spend/concurrency‑gated) + **batch** the single‑shot OCR only.

---

## 11. Feasibility flags — resolved + remaining

- ✅ **Per‑session model override exists** (`agent_with_overrides`) — no separate registrations needed (§2).
- ✅ **Strict tool inputs are NOT on the managed path** — confirmed; use the in‑process path for the narrow strict hand‑offs (§7).
- ✅ **Model is immutable mid‑session** — a tier change forks a session (§2); shapes A/B/C chosen per role.
- ❓ **Per‑run token budget / stop‑condition on a managed session** — still unconfirmed. **Resolve before any fan‑out** (§8); it's the spend backstop.
- ❓ **`context_management` / `clear_tool_uses` attachable to `agents.create`** — for continuous tool‑result clearing; verify and enable (it's a headline platform win, see the "what's unused" scan).
- ❓ **Adaptive thinking / effort on the managed path** — the config exists only on the legacy in‑process stream; `beta.agents.create` omits it, so 86 may run with no effort tuning. Confirm + wire.

---

## 12. Invariants (unchanged — this topology serves them)

Server is the source of truth for writes · the reasoner emits a spec, the writer materializes it, **the critic verifies it at the funnel** · route to the cheapest tier that fits the turn *and the session model* (§2) · escalation is streamed + ephemeral · scope the session to the surface · retrieve, don't stuff · measure every layer.

---

*v2 grounded + adversarially reviewed 2026‑07‑19 (findings wf_76c851ba). The §11 ❓ flags are the remaining load‑bearing unknowns — resolve them before the dependent build step. When this doc and the code disagree, the code is truth — update this doc in the same commit.*
