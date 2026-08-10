# Agent convert capability (estimate → job) — implementation plan

**Status:** designed, not built. Written 2026-08-09 after a live test where
Scribe, lacking this capability, improvised (see "Why" below).

## Why this exists

Asked to convert an estimate to a job, 86 had no tool for it. First attempt it
fabricated success ("one conversion queued") with **zero payloads**. Second
attempt Scribe improvised a payload titled *"Convert Estimate est_… to Job"*
whose only op was `{status:'sold'}`, rationale *"attempting to drive job
creation by updating estimate status"*. It auto-applied. Result: an estimate
marked sold with **no job**, inflating pipeline.

Mitigations already shipped (they contain the damage, they do NOT fill the gap):
- `86c7243` — status/stage/state change on a money entity always cards.
- `7a34252` — cards render real ops, so a field-only write is no longer invisible.
- `4b9148c` — `WRITE_HONESTY`: say you lack the tool instead of improvising.

The agent still has no legitimate path, which is what invites improvisation.

## The two things that already exist (verified 2026-08-09)

1. **`POST /api/jobs/convert`** — `server/routes/job-routes.js:192`,
   `requireAuth, requireRole('admin','pm')`. One transaction:
   - INSERT `jobs` (id, owner_id, data, org, lead_id, estimate_id, market_id)
   - `leads` → `job_id`, `status='sold'`, `converted_at`
   - `receipts` lead → job (keeps `is_presale` unless `roll_presale_to_cost`)
   - `lead_graphs` → `node_graphs` (survey carries into the site plan)
   - `estimates` → `data.job_id`, `data.status='sold'`, **`is_locked=TRUE`**, `accepted_at`
   - COMMIT, then best-effort geocode (cannot affect the commit)
   - Guards: job number must match `^(S|RV)\d{1,6}$`; 409 if the lead already
     has a `job_id`; market inherits lead → job → estimate via COALESCE.

2. **`POST /api/org/next-job-number`** — `server/routes/org-manifest-routes.js:582`,
   atomically claims the next number for a type/prefix. ⚠️ Earlier notes said
   this engine was "pending" — **it is built**. This is what makes an agent-driven
   convert safe; without it the agent would have to invent a number.

## Build steps

**S1 — extract the service (no behavior change).**
New `server/services/job-convert.js` exporting
`convertToJob(user, { job, lead_id, estimate_id, roll_presale_to_cost })`
→ `{ ok, status, error, job_id, owner_id }`.
Move the route body verbatim; swap `req.user`→`user`, `req.body`→arg, and every
`return res.status(X).json({error})` → `return {ok:false, status:X, error}`.
Keep the transaction, the guards, and the post-commit geocode exactly as-is.
`job-routes.js` becomes a thin wrapper that maps the result onto res.
*Verify: the existing UI "Create Job" button still converts, unchanged.*

**S2 — dispatcher op.** In `payload-dispatcher.js`, on an `estimate` target with
`ops.op === 'convert_to_job'`:
- load the estimate, resolve its `lead_id`
- claim a number via the same helper `/api/org/next-job-number` uses (call the
  function, not the HTTP route)
- build the job blob: **`contractAmount` = the estimate's proposal total** (one
  totals engine — see EST-6/convert), title/address carried from the lead
- call `convertToJob(...)`; surface `{ok:false}` as a real payload `apply_error`,
  never a silent no-op.

**S3 — force the card.** Add `"op":"convert_to_job"` to `isHighRiskPayload`
(`payload-routes.js`) so it can never auto-apply, regardless of prior "yes".

**S4 — capability.** The apply path runs `denyPayloadApply`; require admin/pm
so the payload path cannot exceed what `POST /convert` allows a user to do.
A `field_crew` approving in chat must be refused.

**S5 — tool + prompt.** Give 86 a `convert_estimate_to_job` tool (or teach it the
payload shape), then **`POST /api/admin/agents/managed/sync-all` AND a new chat** —
tool/prompt edits do not reach a live agent on deploy.

**S6 — live test.** Convert a throwaway estimate. Assert: exactly ONE job, its
contract equals the estimate total, the lead reads `sold` with `job_id` set, the
estimate is `sold` + `is_locked`, and the card showed the real ops before approval.

## Traps

- **Never let the agent pick a job number.** Always claim one; a duplicate or a
  wrong prefix is unrecoverable in reporting.
- **Convert LOCKS the estimate.** Approving is not a soft action — an admin has
  to unlock via `PUT /api/estimates/:id/lock` to undo.
- **Double-convert** is guarded server-side (409 on a lead with `job_id`). Keep
  that guard reachable from the payload path; do not reimplement it.
- **Contract = estimate total, one engine.** Don't recompute in the dispatcher.
- There is no REST route for a plain estimate `status` edit — `/lock`, `/sent`,
  `/send`, `/approve`, `/decline`, `/bulk/save` only. The dispatcher reaches
  `status` through the generic payload path.
