# Write-Path Audit — current state, the payload verdict, and the kill-list

**Companion to** `agent-target-topology.md` (the blueprint). **This doc** is the ground truth it lands on: every mutation path that exists today, whether the payload system is the right architecture, what is actively broken, and what must not be left behind. **Audience:** John + Rolling86. **Audited** 2026‑07‑19 (5‑agent sweep, `wf_02201668`).

---

## 0. TL;DR

- **The payload system is the right architecture at the outer layer and the wrong one at the inner layer.** Keep the envelope, gut the dispatchers. The replacement pattern already exists in the codebase (`dispatchAssembly`).
- **`applyPayload` is not a universal funnel** — ~20‑25% of the write surface, far less by volume, and one of **eight** parallel write stacks.
- **There is no server‑side money layer.** `p86Pricing`, `computeEstimateTotals`, `getJobCOTotals`, `getJobWIP` are browser globals whose numbers are persisted as server truth. **A critic today cannot verify a single dollar.**
- **Three live defects are losing data or money right now** (§3). Fix those before any re‑architecture.

---

## 1. The eight write stacks

| # | Stack | Goes through `applyPayload`? | Validated | Audited |
|---|---|---|---|---|
| 1 | Payload dispatcher (`emit_payload_file` → `applyPayload`) | ✅ (12 entity types) | shape only for money | ✅ `apply_changeset` |
| 2 | ~269 REST CRUD handlers (~186 write business data) | ❌ | lifecycle/access, never math | ❌ |
| 3 | **Whole‑blob bulk‑save** (`PUT /api/jobs/bulk/save`, `/api/estimates/bulk/save`) | ❌ | **none** — blind JSONB replace | ❌ |
| 4 | AI direct‑SQL executors in `ai-routes.js` (client directory, `propose_create_lead`, job→client links, field tools, skill packs) | ❌ | ad‑hoc | ❌ |
| 5 | **Client‑side `propose_*`** — mutate `window.appData` in the browser, persist via stack 3 | ❌ | none server‑side | ❌ |
| 6 | Background/cron workers (agent‑jobs, reminders, campaigns, cert‑expiry, digest) | partial | varies | ❌ |
| 7 | Service‑layer direct SQL (`assemblies`, `materials`, `file-folders`, `org-reset`, `training-capture`, `email-triage`) | ❌ | in‑service | partial |
| 8 | Unauthenticated/token ingress (2 email webhooks, assembly‑research `/ingest`, sub‑portal) | ❌ | token only | ❌ |

**Coverage reality:** the dispatcher covers 12 entity types (~40 of ~186 write routes). Everything else — **purchase orders, vendor bills, change orders, invoices, payments, pay applications, receipts, attachments, materials, plans, subs, compliance, RFI/submittals, projects, QB costs, workspace, users/roles** — has no dispatcher and is REST‑only. The **highest‑volume** writer is stack 3, which is also where every AI `propose_*` edit lands.

> **Audit trail:** only the payload path and the admin/auth/org/role routes record anything. There is **no change history at all** for jobs, estimates, POs, COs, bills, invoices, payments, receipts, leads, or subs.

---

## 2. Verdict — keep the envelope, gut the dispatchers

**What the envelope buys (do not touch this):**
1. **Intent as a durable artifact** — a row with targets/ops/rationale/status that survives the turn and can be diffed, re‑read, re‑run.
2. **A dry‑run that cannot lie** — `applyPayload` runs the real code path and `ROLLBACK`s, so the preview is a true before/after.
3. **Cross‑entity atomicity** — create a client + an estimate referencing it via `$new_client` + a task, all‑or‑nothing, with `$ref` resolution.
4. **One chokepoint** — the capability gate, high‑risk classification, approve‑in‑chat, training capture, and Scribe's dry‑run‑and‑self‑correct loop were each written **once** and apply to all 12 types. That loop is already a working critic, and it exists *because there is one door.*
5. **A coherent approval UX** — only possible because the proposal is a first‑class object.

**What the dispatchers cost (this is the failure):** they are a hand‑written re‑implementation of the domain that has already drifted — see §3. The op grammar is hand‑maintained in **four** places with "keep these in sync" comments as the only enforcement; conditionals misbehave on 7 of 12 types; 3,127 lines of interpreter that is the sole LLM write path has **zero tests**.

**Why not replace it:** every real defect is a *dispatcher* defect. None is caused by having an envelope. Ripping it out deletes the dry‑run, the transaction boundary, the capability gate, the approval card, the training flywheel and the Scribe loop — and fixes not one missing `organization_id`.

**Why not leave it:** two write paths per entity is a slow leak with a fixed direction. Every rule added to a REST route from now on is a rule the AI path silently lacks, and the failure mode is a **successful‑looking apply** — the most expensive kind.

### The commitment: a thin adapter over a shared domain service layer
**The template already exists.** `dispatchAssembly` (`payload-dispatcher.js:2629`) is ~95 lines that hands `services/assemblies.js` the transaction's db client and lets the service own validation, the cycle guard, and the tuning log — so the payload path and the REST path **cannot diverge, by construction.**

Replicate it:
1. For each entity, extract the route's normalization + invariants + lifecycle stamping + side effects into `server/services/<entity>.js` taking a **db client**, and call it from **both** the route and the dispatcher.
2. Have those services export their own field/enum sets, and **generate** `PAYLOAD_OPS_SCHEMAS` *and the model‑facing tool description* from them — killing the four‑way hand‑mirror.
3. Keep the envelope exactly as is (targets, `$ref`, conditionals, bulk, move, advisory locks, dry‑run, changeset, status lifecycle, capability gate, Scribe loop).

Post‑extraction `payload-dispatcher.js` should be well under 1,000 lines and contain almost no business rules — only orchestration, refs, locking, and audit.

---

## 3. Live defects, ranked (fix before re‑architecting)

### 🔴 Data loss — today
**AI‑created change orders and purchase orders vanish.** The payload job dispatcher writes CO/PO/invoices into the **abandoned** `jobs.data.changeOrders` / `.purchaseOrders` / `.invoices` arrays (`payload-dispatcher.js:1492` `applyArrayOps`, write‑back `:1553`), while the REST routes write to the real tables `job_change_orders` (`change-order-routes.js:226`), `job_purchase_orders` (`purchase-order-routes.js:276`), `invoices` (`invoice-routes.js:194`). The tool description still teaches 86 to do it. **The write commits, reports success, and disappears.** This is also the mechanism behind the recurring "rollup helpers read empty legacy `appData.*`" bug.

### 🔴 Money — wrong dollars booked
- **CO approval books a different number than quoted.** `change-order-routes.js:396` computes `ext*(1+markup/100)` — ignoring the section cascade, dollar‑mode sections, target‑margin back‑solve and fees — and writes `node.items` amounts into `node_graphs` **on approval**. WIP revenue ≠ the customer's number.
- **AI‑added estimate lines price at cost.** Section membership is **positional**; `payload-dispatcher.js:1305` breaks it with a bare `lines.push()`, and its sections seed `markup:0`, which blocks the default‑markup fallback.
- **No over‑billing guard anywhere** — a bill's amount has no relationship to its own lines or to its PO.

### 🟠 Tenancy (matters now that tenants are billed affiliates)
- Payload `create` for **client / lead / estimate** omits `organization_id` (`payload-dispatcher.js:767 / 1729 / 1024`) while the REST equivalents stamp it → AI‑created records land in the legacy `NULL` bucket **visible to every tenant**.
- `execClientDirectoryTool` (`ai-routes.js:6251`) runs raw SQL with **no `organization_id` predicate** on every mutation — update/rename/reparent/**merge**/**delete** by guessed id — and `update_client_field`, `create_property`, `link_property_to_parent` are **auto‑tier (no approval card)**.
- `PUT /api/estimates/bulk/save` (`estimate-routes.js:199`) upserts `ON CONFLICT (id) DO UPDATE` with **no org predicate in the conflict path** → cross‑tenant blob overwrite by known id.

### 🟠 Lifecycle
- The payload path **ignores `is_locked`** — a sold estimate is immutable in the UI but mutable by AI.
- Payload lead updates never stamp `converted_at`, never notify, never geocode, never clamp confidence (those rules live only in `lead-routes.js`). The lead field allowlist is four columns behind and its self‑correction hint names a status that doesn't exist — guiding the model into a guaranteed second rejection.

---

## 4. The missing money layer (why the critic is blocked)

There is **no server money module.** The only implementations live in the browser:
- `js/pricing-pipeline.js` (`window.p86Pricing`) — the *only* markup cascade, override markups, dollar‑mode sections, target‑margin back‑solve, fee/tax/round.
- `js/jobs.js` — the *only* `getJobWIP` / `getJobCOTotals` / `getJobPOAccrued` / `getJobBilledCost`, including all double‑count‑avoidance rules.

And those browser numbers become durable server state: `job-routes.js:305‑306` accepts `contractAmount`/`estimatedCosts` verbatim, and pay‑application `cleanData` doesn't strip `summary`, so the browser's retainage/due/balance is persisted and read back as truth.

**Unblocking move:** port `pricing-pipeline.js` → `server/services/money/pricing.js` and a WIP/CO‑totals service alongside it, then route `change-order-routes`, `ai-routes`, and the contract‑setting endpoints through them. **Must be a byte‑identical port with client/server fixture tests** — a divergence would make the critic reject correct writes.

---

## 5. Legacy stragglers — kill list

| Item | State | Action |
|---|---|---|
| **Two authoring tools** | already unified **in code** (`emit_payload_file` is Scribe‑only) — but **5 per‑turn prompt strings still tell 86 to use it**, contradicting its own baseline | **fix the prompts** (correctness, every turn) |
| Legacy in‑process `runStream` Messages path | fully dead, zero callers, ~250 lines (+ `saveAssistantMessage`, `effortClause`, `thinkingClause`, `ctxSystemToText`) | delete |
| **81 of 112 tool schemas** registered on **no agent** | + 3 dead server dispatch maps, ~108 `propose_*` refs, the client Auto‑mode auto‑commit path | delete schemas, **keep ~12 executors** still used internally by `read_entity`/`search_entities` |
| `AGENT_MODE_86`, `UNIFIED_86_USER_THREAD` flags | one‑way doors already walked (chat 503s without the first; the second's off‑branch is unreachable/inconsistent) | retire the branches |
| Orphan endpoints | `usage-forensics`, `/agents/user-threads`, session `branch`, session `compact` | wire (§6) or drop |
| Orphan tables | `batch_jobs`, `ai_subtasks`, `ai_watches`+runs, `staff_agents` | drop |
| Dead column | `ai_sessions.total_cost_usd` always 0 | compute live or drop |
| **Active bug** | header crew chip un‑clickable (`js/crew-chip.js:65` no‑arg `open()` → "Save the record first") | fix |
| **Active bug** | `POST /api/ai/sessions` without `session_kind` mints a `legacy_partitioned` row the resolver abandons | fix ("new chats don't stick", armed) |

---

## 6. Hit‑list — where the blueprint lands

**Smaller than billed**
- *Unify the write path* — largely **already done**; the live path is `scribe_write → driveScribeWrite → emit_payload_file (Scribe‑only) → applyPayload`. What remains is residue removal in 5 places + prompt copy.
- *Entity‑scoped sessions* — a routing predicate at `ai-routes.js:3218`; the `legacy_partitioned` implementation exists at `:3256‑3280` and is merely unreachable.

**Larger than billed**
- *Money authorities* — **no server seam exists at all**; plus `bulk/save` is a blind blob write with zero re‑derivation.
- *The `propose_*` client‑apply path* is a genuine second write mechanism; retiring an authoring tool does not touch it.
- *Haiku router/worker* — three new modules with no precedent beyond the chat‑titler Messages call.

**Must be created from scratch:** `server/services/money/{pricing,co-totals}.js` · the re‑derive guard on estimate + CO writes · `server/services/{payload-hooks,payload-critic}.js` · `payloads.tool_use_id` (+ unique index) and `payloads.approved_changeset` · a delta sink on `driveSubtaskTurn` + a `send` param on `make86OnCustomToolUse` · the client `subagent_delta` branch · `turn-router.js`, `haiku-read-worker.js`, the first `agent_with_overrides` call · `entity-digest.js` · `agent_jobs.parent_job_id` + budget columns + a DB‑backed concurrency claim · the fan‑out spawner.

**Hard dependency:** the **critic cannot ship before the money layer** — it runs server‑side inside `applyPayload`'s transaction and has nothing to check against until pricing/CO totals exist there.

**Ordering correction:** pull "cut `<available_tools>`" forward into the write‑path item — `SURFACE_PRIMARY_WRITES` (`ai-routes.js:13297‑13301`) names a tool 86 isn't registered with, so it ships wrong information to the model **every turn**. It's a correctness fix wearing a token‑diet label.

**Operational gotchas:** (a) any prompt‑surface edit needs `POST /managed/sync-all` **plus a new chat**, or the live agent keeps the old instructions; (b) anything touching `js/ai-panel.js` must bump `index.html` `?v=` in the same commit; (c) two topology ❓ flags remain load‑bearing and aren't resolvable from this codebase (per‑run managed‑session budget → gates fan‑out; `context_management`/`clear_tool_uses` on `agents.create` → gates tool‑result clearing).

---

## 7. Work order

1. ~~**Stop the bleeding** — CO/PO/invoice payload ops writing to dead arrays (§3, data loss) → then `organization_id` stamping + the client‑directory org predicate (§3, tenancy).~~ **✅ SHIPPED `bf16ead`.** `server/services/job-financials.js` is now the one write layer for COs/POs/invoices, taking an explicit `db` so the dispatcher hands it the open transaction; it stamps `organization_id` on POs and resolves every write through the job's org. The REST routes import its helpers. **The client‑directory org predicate is still open.**
   - **Found while fixing it — the read side had the same bug.** The AI job‑context builder read `job.changeOrders` / `.purchaseOrders` / `.invoices` off the blob, so the write and the read agreed with each other and with nothing else: a job with real approved COs printed `# Change orders (none recorded)` and `computeJobWIP` booked $0 of CO revenue. Fixed in the same commit via `server/services/money/change-order-totals.js`.
   - **Still open (deliberately unbundled):** four of 86's client‑side tools — `set_co_field`, `create_po`, `set_po_field`, `create_invoice` (`js/ai-panel.js:5007‑5125`) — read and write the same dead `appData` stores. `set_co_field`/`set_po_field` always throw "not found"; **`create_po` and `create_invoice` report success for a record that never reaches the table.** The payload path now covers both, so these should be *retired*, not repointed. Changes the tool surface → needs `POST /managed/sync-all` + a new chat.
2. **Fix the prompt lie** about `emit_payload_file` + cut `<available_tools>` (§5, §6). *Note: `emit_payload_file` IS registered for 86 — `admin-agents-routes.js:2444‑2449` composes `jobTools() + payloadTools()`. Re‑scope this item to the surfaces where it genuinely isn't registered before acting.*
3. **Port the money layer** to `server/services/money/` with fixture tests (§4) — unblocks everything downstream. **Started in `bf16ead`:** `js/pricing-pipeline.js` is now dual‑target (`window.p86Pricing` in the browser, `module.exports` on the server) and `money/change-order-totals.js` derives CO income/costs from it, so server and client totals cannot drift by construction. Remaining: estimate totals, WIP, and the phase/revenue rollup.
4. **Critic + deterministic hooks at `applyPayload`** with commit‑time re‑derive/diff + `tool_use_id` idempotency.
5. **Service extraction per entity** using the `dispatchAssembly` template; then **generate** the op grammar + tool description from the services.
6. Then the topology slices: streamed escalation → entity sessions → Haiku read‑worker → background fan‑out.
7. **Straggler sweep** (§5) — safe to run in parallel with any of the above.

---

*Audited 2026‑07‑19 from `payload-dispatcher.js`, `payload-routes.js`, `ai-routes.js`, `admin-agents-routes.js`, the `server/routes/*` CRUD surface, and the client editors. When this doc and the code disagree, the code is truth — update this doc in the same commit.*
