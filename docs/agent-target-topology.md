# Agent Target Topology — the premium blueprint

**Companion to** `agent-architecture.md` (the system) and `agent-design-template.md` (the context template). **This doc** answers one question: *is the three‑agent system the most efficient shape, and if not, what is?* **Audience:** John + Rolling86.

> **Verdict.** The three **roles** are right — converse / reason / write is the correct decomposition and matches where the frontier converges. What's inefficient is the **wiring**: each role is pinned to one fixed, over‑provisioned model, escalation is a cold model‑swap, and the system is missing a verifier. The premium path is the **same roles, un‑pinned from fixed models and routed by tier**, escalation made warm, a critic added, background made parallel — with **strict structured outputs as the enabling key.** It is a re‑architecture of the *routing*, not a rewrite.

---

## 1. The core reframe: role ≠ model

Today "3 agents" literally means "3 fixed models": Assistant→Sonnet, 86→Opus, Scribe→Sonnet, baked onto each managed agent at registration. That conflates two independent things:

- **Role** — the *job*: host & route · reason · write · verify.
- **Tier** — the *model* that does a given turn: Haiku · Sonnet · Opus.

A premium system separates them. A role is not "a Sonnet"; it is a job that runs on **the cheapest tier that clears this turn's bar.** The whole design below is that separation.

**Do not** add domain‑specialist agents (an "estimating agent," an "AP agent"). At single‑org scale that multiplies separately‑cached prefixes and routing surface for no gain; Anthropic's own guidance is that sub‑agents are for *parallel work*, not standing silos. The role count is right — we add exactly one (the critic) and change how models attach.

---

## 2. The four roles

| Role | Job | Today | Target |
|---|---|---|---|
| **Host / Router** | converse, and decide the tier | fixed **Sonnet** for all office turns | a **router** in front of a tiered host |
| **Reasoner (86)** | multi‑step reasoning + the DB write‑spec | **Opus** — but field crew hit it for trivial asks too | **Opus, reached only on need** |
| **Writer (Scribe)** | materialize a write‑spec into a payload | **Sonnet** | **Haiku** — applying a spec is mechanical |
| **Critic** | grounded verify *before* a money‑write | **missing** | a cheap grounded checker between spec and Scribe |

The critic is the one genuinely missing role — and the one a *trustworthy* system needs (§6).

---

## 3. The tier ladder and the routing rule

```
route(turn):
  needs multi-step reasoning over the DB / a real write-spec?  → REASON  (86 · Opus 4.8)
  a write, or genuinely ambiguous?                             → HOST-SONNET
  pure read / lookup / status / "what's due"?                  → HOST-HAIKU
  default                                                       → HOST-SONNET
writes always pass:  spec → CRITIC (grounded) → SCRIBE (Haiku) → server re-derive → apply
```

- **~80% of turns are reads** — they belong on Haiku. Sonnet only earns the turn when it's a write or ambiguous. Opus only when the turn genuinely reasons.
- The router is a cheap classifier (rule/embedding, ~1–100 ms — negligible vs. inference).
- **Bias the bar upward:** keep every turn on the cheapest tier that can be correct; escalate reluctantly.

---

## 4. How tier‑routing is actually expressed on the Managed API

This is the load‑bearing mechanic, and it's specific to our stack: on the **Managed Agents / Sessions API, the model is bound to the agent at registration** — a session just references the agent, and a turn only sends the new event. *There is no per‑turn model parameter.* (Grounded: `admin-agents-routes.js:2673‑2682` bakes `model` at create; `ai-routes.js:11957` opens sessions with only `{agent, environment_id, title}`.)

**Therefore "route by tier" = route to a different registered agent, not flip a model field.** The registered roster becomes:

```
host-haiku     · Haiku 4.5   · lean read toolset
host-sonnet    · Sonnet 4.6  · read + propose/write toolset
job (86)       · Opus 4.8    · full reasoning + write toolset
scribe         · Haiku 4.5   · 1 tool (emit_payload)
critic         · Haiku 4.5   · read-only verify toolset
```

The router picks **which agent's session** a turn is sent to. Two consequences:

- **Cost caveat — shared prefixes.** More registered agents = more separately‑cached prefixes. Mitigate by giving `host-haiku` and `host-sonnet` the **same lean toolset + system prompt** (only the model differs), so their cached prefixes are small and nearly identical. The Haiku‑for‑80% win dominates the extra registration cost.
- **Session continuity across a tier bump.** A Haiku read‑turn and a Sonnet write‑turn on the same surface are *different agents* → different Anthropic sessions. Continuity is preserved by the **entity‑scoped session + digest** model (see `agent-architecture.md §3`): both tiers open on the same entity and read the same digest, so the user sees one coherent thread even though the tier moved underneath.

> **Alternative considered:** run the host on the **in‑process Messages path** (where model *is* a per‑request field) instead of managed agents, to route tier per‑turn in one agent. Rejected as the default: it gives up managed server‑side history + native compaction. Keep managed; route by agent.

---

## 5. The unlock — strict structured outputs (why it's first)

You are on Sonnet‑everywhere today for one reason: **Haiku malformed the `escalate_to_86` params, so you over‑provisioned.** (History: Assistant was Haiku until 2026‑06‑24, reverted for exactly this.) That is the thing strict outputs fixes.

**Strict / structured tool inputs** make the API guarantee a tool call validates against its schema — malformed args become impossible instead of a 10–20% failure rate patched by a validation‑bounce retry loop (the live loop is at `ai-routes.js:2877`). Today strict output is used on only **two** extraction endpoints (`ai-routes.js:5820, 5931`); the ~30 write/propose tools run plain.

Strict outputs is therefore **not polish — it is the precondition for the whole topology.** It is what makes Haiku reliable enough to host the 80%, safe enough to be Scribe, and trustworthy enough that the critic's job shrinks. **Sequence it first.**

> **Verify on the current Agents API:** confirm strict/structured tool inputs are settable on the managed agent tool definitions (not just the in‑process `output_config` path). If they are managed‑path only via the in‑process route, the host‑Haiku fast‑lane may need the in‑process Messages path for its write turns. Flagged, not assumed.

---

## 6. Warm escalation — an in‑thread tier bump, not a cold hand‑off

**Today (`ai-routes.js:12157‑12393`):** Assistant→86 mints a **brand‑new cold Opus session every time**, runs sequential pre‑work, then **blocks, un‑streamed** — the user gets heartbeat‑only silence for the entire Opus turn, and only then does the host relay it.

**Target — escalation is a tier bump within the same conversation:**
- **Warm‑pool** the 86 session per user/org so its cached prefix stays hot (no cold `sessions.create` per escalation).
- **Stream** 86's `agent.message` deltas straight out the parent SSE — the user watches 86 think, no blank wait.
- **Overlap** the pre‑work (env/agent reads + the escalation context pack) with the session open instead of awaiting serially.
- **Raise the bar** so fewer turns escalate at all (§3).

The user should never perceive a "hand‑off." They perceive one assistant that got smarter for one turn.

---

## 7. The critic — grounded verify‑before‑write (the premium role)

Every PO, bill, CO, and estimate line the system creates rides on a **single ungrounded generation**, with a human approval card as the *only* gate. A premium system inserts a cheap **grounded** critic between the write‑spec and Scribe:

- **Grounded, not introspective.** It checks the spec against *retrieved real state* — does the CO total reconcile with `getJobCOTotals`? is the bill's vendor on the linked PO? does closing this job leave retainage or open tasks? is the estimate margin consistent with `p86Pricing`? (Plain "are you sure?" self‑critique degrades quality — the check must read the data.)
- **On failure:** auto‑retry once, then downgrade to a **flagged draft** with the reason, rather than applying or silently failing.
- **Cheap:** Haiku with a read‑only toolset; a distilled judge on 100% of money‑touching writes.

This makes the approval card a *real* check instead of a rubber stamp, and it catches the "rollup helper read empty legacy `appData`" class of silent money bug directly. Pair it with **deterministic hooks** (non‑LLM: block any write that orphans a cost, require `job_id` on financial rows) — the hook catches what the model shouldn't be trusted to judge at all.

---

## 8. Background = orchestrator + parallel workers

Interactive chat wants the host→reason→write pipeline. **Background** work wants a different shape: **86 as orchestrator fanning a job out across N isolated sub‑agents**, each in its own context window, merged into one review grid.

- Ideal for: *audit every open job for margin erosion · reconcile all unmatched bills to POs · the Bulk‑Doc‑Import OCR pass* — one worker per job/document.
- You already have the `agent_jobs` queue; it runs **single‑threaded**. The change is fan‑out + merge (Anthropic caps this ~16 workers — reserve it for genuine fan‑out, not chat).
- Latency‑tolerant background runs should also move to the **Batch API (50% off)** — background jobs are the top token spender and the batch surface is currently unused.

---

## 9. What each shape costs (the honest ledger)

- **Router:** ~free (a classifier).
- **Haiku host for 80%:** the large win — Haiku is a fraction of Sonnet, and the reads are the bulk of traffic.
- **Extra registered agents:** small, if `host-haiku`/`host-sonnet`/`critic` share lean toolsets (shared, near‑identical cached prefixes).
- **Critic:** one extra cheap Haiku pass per money‑write — bounded (only writes, not reads), and it *prevents* the far more expensive wrong write + human rework.
- **Warm‑pooled 86:** cheaper and faster than cold `sessions.create` per escalation.
- **Net:** cost goes *down* (tiering + batch) while reliability and snappiness go *up* (critic + warm/streamed escalation).

---

## 10. Build order

1. **Strict structured outputs** on the money‑writing tools. *The unlock — do first.* Independently makes writes safer and kills the bounce‑retry loop.
2. **The router + `host-haiku`.** Register the Haiku host (shared lean toolset), add the classifier, send reads to it. Immediate cost + latency win once (1) makes it safe.
3. **Warm + streamed escalation.** Pool the 86 session, stream deltas, overlap pre‑work.
4. **The critic** before money‑writes (+ the deterministic hooks).
5. **Scribe → Haiku.** Once strict outputs + critic are in, the applier drops a tier.
6. **Background fan‑out + Batch API.** Parallel workers for audits/reconcile/OCR; batch the latency‑tolerant runs.

Each ships independently; (1) gates the safety of (2) and (5).

---

## 11. Open feasibility flags (verify on the current Agents API before building)

- **Strict tool inputs on the managed agent path** — settable on `agents.create` tool defs, or in‑process only? (Determines whether host‑Haiku write turns need the in‑process path.) *(§5)*
- **Adaptive thinking / effort on the managed path** — the scan found these wired only into the legacy in‑process stream; `beta.agents.create` omits them, so 86 may run with no effort tuning. Confirm and, if so, wire it.
- **Per‑run token budget / stop‑condition** on a managed session — exists? If so, cap each background `agent_job` as a spend backstop (you've been bitten by silent‑spend before).
- **`context_management` / `clear_tool_uses`** attachable to `agents.create` — for continuous tool‑result clearing between compactions.

---

## 12. Invariants (unchanged — this topology serves them)

Server is the source of truth for writes · the reasoner emits a spec, the writer materializes it, **the critic verifies it** · route by difficulty, cheapest safe tier · escalation is warm and in‑thread · scope the session to the surface · retrieve, don't stuff · measure every layer.

---

*Grounded 2026‑07‑19 from `ai-routes.js`, `admin-agents-routes.js`, `ai-sessions-routes.js`. The §11 flags are the only load‑bearing unknowns; resolve them first. When this doc and the code disagree, the code is truth — update this doc in the same commit.*
