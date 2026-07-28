# Project 86 — Known Issues Register

**Version:** v1 · **Date:** 2026-07-27 · **Build:** `c069704` (v1.15) · **Owner:** John Thilking

> The known-broken list, published deliberately. A triage team needs this *before* the feature list. Items are what is genuinely open as of this date — fixed items are recorded in the per-release change logs (`server/feature-catalog.js`), not here. Severity is assigned honestly, including where it is uncomfortable.
>
> **Severity key:** **P1** = data/money/access risk, fix next · **P2** = real defect or gap, scheduled · **P3** = cleanup / low impact.

## Open — operational (the biggest gaps)

| # | Issue | Severity | Impact | Plan |
|---|---|---|---|---|
| OPS-1 | **No independent off-platform database backup.** Railway holds same-vendor managed snapshots; there is no separate dump, and no restore has ever been tested. | **P1** | Worst case: loss of the pilot dataset. Buildertrend remains system-of-record, so the business survives — the P86 state would not. | Stage 1 — nightly `pg_dump` → separate R2 bucket + weekly second-provider copy; **first restore test ≤ 2026-08-02**. |
| OPS-2 | **No uptime/health monitoring.** Detection today is "a user notices." | **P1** | An outage could run unobserved. | Stage 1 — `/healthz` shipped (this build); external uptime ping + alerting to follow. |
| OPS-3 | **No AI spend/balance alert.** A prepaid balance hitting zero silently stops the AI crew (this has happened once — the $0.30 lapse). | **P1** | AI features stop mid-work with no page. | Stage 1 — provider billing threshold alert + an in-app spend-threshold alert. |
| OPS-4 | **No credential escrow.** Every vendor account recovers to the founder's email; no second recovery contact. | **P1** | Single point of failure for infrastructure access. | Stage 1 — shared vault + named second contact. |
| OPS-5 | **No customer-facing Terms of Service / Privacy Policy**, and no written data-classification + retention policy. | P2 | Needed before wider or external use. | Stage 3. |

## Open — correctness & data integrity

| # | Issue | Severity | Impact | Plan |
|---|---|---|---|---|
| INT-1 | **No reconciliation gate against QuickBooks / Buildertrend.** Job costs are not tied out to an external source with a tolerance and a sign-off. | **P1** | Given AGX's ~$40K historical WIP-workbook variance, an undetected drift is plausible. | Stage 2 — first deliverable. |
| INT-2 | **Client-directory tool org predicate.** `execClientDirectoryTool` mutations were identified in the write-path audit as lacking an `organization_id` predicate. | **P1** | Cross-tenant risk *in a multi-tenant future*; contained today because the platform runs a single pilot org. | Next write-path pass (`docs/write-path-audit.md` §3). |
| INT-3 | **Payload path ignores `is_locked`.** A sold estimate is immutable in the UI but can still be mutated via the AI payload path. | P2 | A locked/sold estimate could be altered after the fact. | Next write-path pass. |
| INT-4 | **No over-billing guard.** A vendor bill's amount has no enforced relationship to its own lines or to its PO. | P2 | Over-billing is not caught by the system. | Stage 2 (with the accounting spine). |
| INT-5 | **Two write paths per entity** (REST + AI payload dispatcher) for ~12 entity types. Rules added to a REST route are not automatically gained by the AI path. | P2 | Failure mode is a *successful-looking* apply. Mitigated by the `dispatchAssembly` service pattern, which is being extended. | Ongoing — see `docs/write-path-audit.md`. |
| INT-6 | **`emit_payload_file` description truncation** (1024 chars) means much of the payload grammar never reaches the model. | P2 | The AI writes a narrower grammar than the system supports. | Scheduled with the agent-topology work. |
| INT-7 | **No commit-time critic** on `applyPayload` (re-derive/diff at commit). Double-apply *is* closed (atomic `status='applying'` claim). | P2 | A wrong-but-valid write is not independently checked. | `docs/write-path-audit.md` item 4. |

## Open — quality & coverage

| # | Issue | Severity | Impact | Plan |
|---|---|---|---|---|
| QA-1 | **Thin automated test coverage.** QA is live end-to-end verification; the repo has a small Jest suite, and the 3,000-line payload dispatcher has no tests. | P2 | Regressions rely on manual verification. | Stage 3 — smoke suite over auth, org-scoping, payload dry-run. |
| QA-2 | **No pilot acceptance criteria / timebox.** Without pass-fail criteria the pilot cannot formally succeed or fail. | P2 | Cannot declare the pilot proven. | Stage 3. |
| QA-3 | **Role smoke-test rig missing** (`field_crew`, `sub` per-role verification). | P2 | Permission regressions could ship unnoticed. | Stage 3. |
| QA-4 | **AI accuracy sample is thin** — 69 captured examples vs 300–1500 fine-tune thresholds. | P3 | The ~7.2% correction rate is directional, not statistically settled. | Accrues with use. |

## Open — platform & housekeeping

| # | Issue | Severity | Impact | Plan |
|---|---|---|---|---|
| PLT-1 | **Prompt-caching/compaction opt-in never fires** — the beta header is set but the path does not trigger. | P3 | Higher token spend than necessary on long sessions. | Diagnose with the agent work. |
| PLT-2 | **Redis cache layer unevaluated** (post query-profiling item). | P3 | Not currently a bottleneck at pilot scale. | Deferred until load warrants. |
| PLT-3 | **OAuth token encryption at rest** is noted in-schema as insufficient pending per-tenant KMS (`server/db.js`). | P2 | Stored third-party tokens rely on app-level protection. | Revisit with the Stage-4 security review. |
| PLT-4 | **Dead code awaiting removal** — retired section-in-inspector pane-moving code; sub-portal persist helper not yet extracted (duplication risk). | P3 | Maintenance drag; the duplicate persist path can drift. | Cleanup pass. |
| PLT-5 | **`buffers@0.1.1`** transitive dependency carries no machine-readable license; two direct deps unverified in the last scan. | P3 | Licensing record incomplete. | Confirm at next dependency cleanup (`docs/DEPENDENCIES.md`). |
| PLT-6 | **Estimate delete returns 403 even for a system admin**; a leftover test estimate cannot be removed from the UI. | P3 | Minor operational annoyance. | Fix with the next estimates pass. |

## Recently closed (for context — full history in the release notes)

- **CO/PO/invoice AI writes were landing in dead arrays** and silently vanishing → fixed (`bf16ead`); `server/services/job-financials.js` is now the single write layer.
- **Boot pushed stale local data over newer server data** → fixed; plus a pre-unload flush and a "never push if the load failed" guard.
- **Dead confirm/approve dialogs in the installed PWA** (62 sites) → fixed.
- **`getJobWIP` drift** — a client/server duplicate quoting different margin math → ported server-side (`b2fad44`), pinned by differential assertions.
- **Double-apply on payloads** → closed with an atomic claim + boot-time reset of stranded claims.

---

*Maintained alongside the deployment report. Update when an item opens or closes; record closures in the release notes.*
