# TENANCY GRADUATION CHECKLIST

**What this is.** The list of things that must be true before a **second
organisation is created in production**. Not before the next deploy, not before
the next feature — before org #2 exists.

**Why it exists.** Project 86 is built multi-tenant: every row carries
`organization_id`. Production has had exactly **one** organisation for its whole
life. That means the tenant boundary has never been *observed* — it has only
been *reasoned about*, and six rounds of reasoning missed real defects that a
second organisation would have exposed in a single request. Nothing in the app
today can tell you the boundary is wrong, because there is no second tenant for
anything to leak to.

The day org #2 is created, every item below stops being theoretical.

**Who checks it.** John (or whoever creates org #2). Items marked
`[machine]` are asserted by `test/tenancy-graduation.test.js`, which fails if
this document's recorded state stops matching the code — **in either
direction**. An item that gets fixed and not ticked here fails the build just as
loudly as one that gets ticked here and is not fixed. Items marked `[human]`
cannot be automated and are signed off by a named person.

**How to use it.** Work top to bottom. Item 1 is a hard prerequisite for
everything else: until it is true, org #2 cannot be created at all.

---

## Status summary

| | |
|---|---|
| Total items | 17 |
| DONE | 6 |
| OPEN | 11 |
| Hard blockers on creating org #2 | 11 |

---

## 1. Affiliate onboarding completes end to end — **DONE** `[machine]`

`POST /api/admin/organizations/invites/:token/accept` inserted a `users.owner_id`
column that **does not exist**. Both statements sat inside a transaction, so
Postgres raised 42703 and the entire organisation-creation flow rolled back
**every single time**. Nothing read the column; the comment that justified it
described a different column on a different table.

*Nothing else on this list mattered until this was true, because org #2 could
not be created at all.*

- **Verified by:** `test/affiliate-onboarding.test.js` (16 tests) drives the real
  route over a schema derived from `server/db.js`, and asserts two organisations
  exist afterwards, read back after the handler returned.
- **Check:** `owner_id` appears nowhere in `server/routes/admin-organizations-routes.js`.
- **Landed in:** `f829e682`.

## 2. The console tenant repairs are landed and covered — **DONE** `[machine]`

Six unpredicated `ai_messages` aggregates on `GET /metrics`, four unpredicated
`entity_title` lookups, `GET /managed` with no `WHERE` clause at all, and
`GET /managed/audit` naming `organization_id` four times while filtering on none.

- **Verified by:** `test/admin-console-tenant-scope.test.js`.
- **Landed in:** `3e2c70a2`.

## 3. Single-tenant behaviour is proven unchanged, differentially — **DONE** `[machine]`

Not asserted — measured. `test/golden/single-tenant-answers.json` was captured
by checking out `69f2cabd` (the commit **before** any repair) into a detached
worktree and recording what the unrepaired code returned for 56 agent tools and
4 admin-console routes against a one-organisation database.

- **Check:** the golden's `generated_from` is `69f2cabd`, and every door matches
  byte for byte at HEAD.
- **Verified by:** `test/tenant-noop-differential.test.js`.
- *If this ever fails it does not mean a tenant leaked — this world has one
  tenant. It means a repair changed what John sees.*

## 4. The two-org conformance harness exists and is red without the repairs — **DONE** `[machine]`

- `test/tenant-conformance.test.js` — 112 published tools, derived from what the
  model is offered; 58 driven, 54 derived-waived, counts committed. Plus the
  four admin-console routes, through the identical oracle.
- `test/tenant-register2-http.test.js` — **REGISTER 2**, added after the scaffold was
  measured driving 4 routes out of 569. `server/index.js` mounts 76 things; 75 of them
  are routers declaring 569 routes; 137 are param-less GETs and every one is now driven,
  twice (as an org admin and as the platform owner), through the same oracle. The other
  432 are writes or need a path parameter and are COUNTED. It found three unplanted
  cross-tenant reads on its first run — see items 15 and 16.
- `test/tenant-attack-classes.test.js` — all eight attack classes planted and
  caught, with seven correctly-predicated counterparts proving the oracle
  discriminates rather than flagging everything.

**Red on the REAL defects, not only on planted ones.** Run inside a detached
worktree at `69f2cabd`, the harness fails **10 of 40** — every arm of
`GET /metrics` (L1), `GET /conversations` (L2), `GET /managed` and
`GET /managed/audit` (L3). At HEAD it is 40/40.

> Worth recording because of how it was found: the first version of this harness
> drove only agent **tools**, and it **passed at `69f2cabd`** — green against a
> tree with three live cross-tenant leaks in it. The tool surface had already
> been repaired by that commit; the leaks that remained were on the console, and
> *a harness that does not drive a surface cannot say anything about it*. That is
> the same "we cannot tell when we have missed some" condition, rebuilt one layer
> up, and it is the reason coverage here is counted rather than assumed.

## 5. The rollback switch exists and its blast radius is derived — **DONE** `[machine]`

`P86_TENANT_SCOPE` (`server/tenant-scope-flag.js`), two values, default
`enforce`, loud on every use, three governed call sites derived by grep rather
than claimed by a list.

**READ THE NEXT PARAGRAPH BEFORE RELYING ON THIS SWITCH.** "The rollback switch
exists" is true and it is not the whole sentence. It reaches **three call sites**,
all in `server/routes/admin-agents-routes.js`. The repo writes the tolerance
predicate `(organization_id = $n OR organization_id IS NULL)` **236 times** across
`server/`; the switch governs three of them.

It reaches **ZERO statements in `server/routes/ai-routes.js`** — grep that file for
`TENANT_SCOPE` and the only hit is a comment saying so. So **the chat surface has no
kill switch**, `GET /86/messages` included. A tenant repair there can only be undone
by `git revert` and a deploy: a laptop, a build, and a deploy window — not a phone.

That is a limit, not a defect: the switch exists to undo a LOCKOUT, and the one real
lockout vector (`registryScope`'s no-org 403) is inside its three sites. But somebody
told "there is a kill switch" at 9pm must not discover its edges by trying it.

---

## 6. Zero UNCOVERED tools; every waiver named and counted — **OPEN** `[machine]`

**The honest residual of this whole design.** Coverage is per-door, and a door is
covered only when someone writes an input recipe for it. The derived population
does not eliminate that — it converts "we forgot" into "we wrote down that we
skipped it, and here is the count."

Today: **58 driven, 54 waived**. Every waived name is a write routed by the
approval-tier executor, or one of two tools with no server executor at all
(`navigate`, `web_search`). No READ tool may be waived — that is asserted by
predicate, not by count, so a read cannot slip into the waived set behind a
write.

**To close:** the write surface needs the same treatment the read surface just
got. `test/agent-write-org-scope.test.js` and
`test/org-write-predicate-invariant.test.js` hold it today by source analysis,
which is exactly the method all eight attack classes defeat.

> This must be closed **before** org #2, not after. Every previous round got that
> sequence wrong.

## 7. `classify()` places every tenant-carrying table — **OPEN** `[machine]`

Three tables carry `organization_id` and are classified nowhere:

    email_attachments    live_participants    live_rooms

`server/services/org-table-classification.js` says it itself: *a table nobody can
classify is where the next hole lives.*

**Note the harness does not depend on this.** Its schema is every table
`server/db.js` creates (108), so an unclassified table cannot drop out of the
population — that is attack class A1, answered structurally. This item is about
the **audit** in `server/services/org-boundary-audit.js`, which does key on the
classification and therefore reports nothing about these three.

- **Check:** `unclassifiedTenantTables()` returns exactly those three.

## 8. `ai_sessions` gets a tenant, or a written parent anchor — **OPEN** `[machine]`

`ai_sessions` has 19 columns and **none of them is a tenant**. `GET /86/messages`
and `search_my_sessions` therefore cannot filter on the row's own org even in
principle; `services/session-search.js` anchors through `ai_messages` instead.

The recommended move is the **anchor, not the column**: classify it as `parent`
via the `legacyLink` that `session-search.js:252-261` already implements — a
classification-file change with zero DDL. Anchoring on `users` would be wrong,
because `users.organization_id` is mutable and that is false premise #1.

**A residual is open and deliberately declined:** a session with *no messages*
has no tenant evidence, and `session-search.js:261` ends its anchor with
`OR NOT EXISTS (...)`, so such a thread's user-typed label is visible whatever
the caller's org. This is covered by a named test
(`R3b … RESIDUAL (declined, not a regression)`) so it cannot change silently.

- **Check:** `classify('ai_sessions')` is still `'unclassified'`.
- **If a column is chosen instead, it is a MIGRATION:**
  `ALTER TABLE ai_sessions ADD COLUMN organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;`
  plus an evidence-based backfill through `ai_messages.session_id`.
  **Rollback:** `ALTER TABLE ai_sessions DROP COLUMN organization_id;` — safe only
  while nothing reads it, so **the column and its first predicate must be
  separate commits, in that order.**

## 9. The `OR organization_id IS NULL` tolerance is retired — **OPEN** `[machine]` — **HIGHEST RISK ITEM ON THIS LIST**

**497** occurrences of `organization_id IS NULL` across `server/`.

486 → 497: the lead → estimate → job delete cascade (`2639e755`) added eleven
statements across `estimate-routes.js`, `job-routes.js` and `lead-routes.js`.
Every one is on `estimates`, `jobs` or `leads` — the three tables that carry
this arm already, and for the original reason: their `organization_id` was
added late and production genuinely holds un-stamped rows in them. So this is
the count moving because the surface grew, NOT the tolerance reaching a table
that had been clean. No new table became tolerant, and the day this item closes
these eleven are part of the same one-line change as the rest.

That distinction is the one worth watching on every future move of this number:
**+N on an already-tolerant table is bookkeeping; +1 on a table that did not
have the arm is a boundary decision** and belongs in a commit that says so. New
tables must be written without it — `service_tickets` and its children have no
tolerance arm anywhere, because they never had un-stamped rows to tolerate.

485 → 486: `GET /api/receipts/merchants` unions receipts with QuickBooks cost
lines, and its QB arm scopes through the parent job with the same tolerance the
route it copied uses (`GET /api/qb-costs`, `qb-cost-routes.js:466-482`). That is
a deliberate inheritance, not a new decision — the two are the same one-line
change on the day this item is closed, and they must be closed together.
Deliberately NOT quoted verbatim in that route's own commentary: the counter
above is a plain text match over `server/`, so prose that repeats the predicate
inflates a number somebody is using to decide when org #2 can be created.

Every tenant predicate in this repo is written as
`(organization_id = $n OR organization_id IS NULL)`. With **one** organisation
that tolerance arm is what makes the repairs a no-op — it is the reason item 3
passes, and production genuinely holds un-stamped rows (`server/db.js:656` adds
the column late, `:721` backfills at every boot, `:761` guesses).

**The day org #2 exists, an un-stamped row is visible to EVERY tenant.** The
tolerance stops being a no-op and becomes the leak.

**To close:** zero un-stamped rows on every `direct` table, then the marked arms are
deleted.

**How to actually check that, as a person, today.** The earlier wording named
`reportOrgStampAudit` as if it were something John could run. It is
`server/db.js:5851`, called only from boot at `:5974`/`:5976` — so its answer is a
line in a Railway deploy log, not an endpoint, and "run the audit" was an instruction
pointing at nothing. There are two doors that a human has:

1. **From a browser, signed in as a System Admin:**
   `GET /api/admin/console/org-boundary` — the same audit, on demand, as JSON. It
   reports per-table un-stamped counts. This is the one to use.
2. **From the Railway deploy log:** search the boot output for `[org-boundary]`. Same
   numbers, only available at boot.

`POST /api/admin/console/org-boundary/backfill` is the paired stamper: dry by default,
evidence-only, idempotent, and it logs its actor when applied. Read the count, stamp
what is derivable, read the count again.

### ⚠ THE SECOND THING THAT STOPS THE DAY ORG #2 EXISTS

This item is about un-stamped **rows**. `NEVER_MULTI_ORG` also gates
**`server/db.js:320`**, which re-adopts every org-less **USER** into AGX at every boot.
Both statements stop at the same instant — the moment `(SELECT COUNT(*) FROM
organizations) <= 1` becomes false.

So the day org #2 is created, a user with no `organization_id` stops being adopted and
stays org-less permanently. `resolveOrgId` RETURNS NULL for that user (it does not
throw), and every predicate written as `(organization_id = $n OR organization_id IS
NULL)` with a NULL bound to `$n` **can only match nothing**. That is a silent empty
behind a 200, and `GET /86/messages` is where a user would meet it first —
measured, and fixed to refuse loudly instead, in `9d2522ef`.

**Before creating org #2:** run
`SELECT id, email FROM users WHERE organization_id IS NULL;`
and attach or deactivate every row it returns. There is no boot sweep after that day.

> **Do not touch `shared` or `mixed_shared` tables.** Their NULLs are correct
> data, re-inserted at every boot by `seedGlobalTaxonomy()`, and their uniqueness
> indexes are built on `COALESCE(organization_id, 0)`. A `SET NOT NULL` there is
> not a failed migration — it is a **boot crash loop**, because the same `init()`
> that adds the constraint violates it.

## 10. `POST /api/admin/organizations` does not create an unreachable tenant — **OPEN** `[machine]`

`server/routes/admin-organizations-routes.js:138` creates an `organizations` row
and **no user**. That is a tenant nobody can sign into. The invite flow (item 1)
is the only complete door to a new organisation.

- **Check:** the route exists and creates no user.

## 11. `roles` is platform-wide — decide before org #2 — **OPEN** `[machine]`

`roles` has `name TEXT PRIMARY KEY` and **no `organization_id`**, and
`auth.js:_roleCache` keys on name alone. Every tenant shares one role catalogue,
so **any holder of `ROLES_MANAGE` edits capabilities for every organisation on
the platform.** With one tenant that is invisible. With two it is a
privilege-escalation path between affiliates.

This is a schema change plus a cache re-key, and it is a **product decision**, not
a bug fix. It must be made — either way — before org #2.

## 12. `resolveOrgId`'s JWT-claim path is proven stale-safe — **OPEN** `[human]`

`server/auth.js:374` returns `req.user.organization_id` **from the token** before
consulting the database, and `PUT /api/auth/users/:id` writes that column. So a
user moved between organisations carries the old claim until their token expires.

"A user id is a tenant" is false precisely *because* the value is mutable.

**To close:** demonstrate that a user moved between organisations does not carry
the old claim past the move.

## 13. `NEVER_MULTI_ORG` is proven to latch shut — **OPEN** `[human]`

`server/db.js:61` gates the most consequential backfill guesses in the file. Its
own comments record that it keys on organisations that **ever** existed. The
archive-then-restart path is exactly where that reasoning could be wrong.

**To close:** create org #2 on **staging**, reboot, and observe. Prove it; do not
read the comment.

## 14. The human checks — **OPEN** `[human]`

Four things no test can do:

1. **Run the harness once against a real two-org Postgres.** `test/helpers/pg-sqlite.js`
   is faithful about `WHERE` clauses and is *not* Postgres — not about collation,
   numeric precision, `jsonb` operator edges, or concurrency. One real run before
   the first affiliate is cheap insurance.
2. **Pull the kill switch once.** Set `P86_TENANT_SCOPE=legacy` on Railway,
   confirm the app serves within one deploy window, unset it. *A switch nobody
   has pulled does not exist.*
3. **Walk staging as org #2's admin.** Restore a production copy, create the
   second organisation, log in as its admin, and walk all 18 sidebar pages and
   the 3 full-page drill-ins. Human, behavioural, not a test.
4. **Record the SHAs** of every repair with its revert command and an
   `/api/health` confirmation.

## 15. Three tables are read cross-tenant because they have NO tenant column — **OPEN** `[machine]`

Found by REGISTER 2 on its first run, at HEAD, with nothing planted. Each is a real
cross-tenant read served to an ordinary org admin today, and none of them is a missing
predicate — **there is no column to filter on**:

| Route | Table | What crosses |
|---|---|---|
| `GET /api/email/log` | `email_log` | recipient addresses and subject lines of every tenant's outbound mail. Gated on `requireRole('admin')`. |
| `GET /api/admin/agents/managed/prompt-audit` | `managed_agent_skills` | the Anthropic skill ids attached to every tenant's agent (`collectSkillsFor`, `admin-agents-routes.js:2762`). The router says so itself at `:3657`. |
| `GET /api/roles` | `roles` | the platform-wide role catalogue — this is item 11, listed here too because the harness cannot tell the three apart. |

All three are ledgered BY NAME in `test/tenant-register2-http.test.js`, with the reason,
and that ledger fails **in both directions** — a fourth is red, and one of these three
silently closing is red too.

**Closing any of them is a MIGRATION** (add the column, backfill from a parent, then the
predicate — and the column and its first predicate must be separate commits, in that
order). That is why they are not fixed in the wave that found them.

- **Check:** `email_log` and `managed_agent_skills` both carry `organization_id`.

## 16. `prompt-audit` honoured a caller-supplied `org_id` — **DONE** `[machine]`

`GET /api/admin/agents/managed/prompt-audit?org_id=<anyone>` took the id straight off the
query string. The gate is `ROLES_MANAGE`, which **both** seeded admin roles hold, so any
affiliate admin naming any organisation received that tenant's
`managed_agent_registry` row — including `anthropic_agent_id`, **the handle the sibling
DELETE on the same router acts on** — plus its composed agent prompt (which embeds the
org's name and skill packs) and its reference-link titles.

Six rounds of static scanning missed it, and the reason is worth keeping: the statement
**is** scoped. `SELECT * FROM organizations WHERE id = $1` binds a parameter and reads
perfectly to a scanner. It is scoped to a value the caller chose.

Found by executing it. Fixed by refusing a foreign `org_id` unless the caller holds
`SYSTEM_ADMIN` — refused **loudly**, not silently redirected to the caller's own org,
because substituting a different answer for the one that was asked for is how a boundary
becomes a mystery. The platform-owner operation is intact and asserted.

- **Verified by:** `test/prompt-audit-org-id-idor.test.js` (6 tests). Against the code as
  it stood it fails 2 of 6 — 200 where 403 is required, with the victim's marker in the
  body. Two anti-lobotomy arms prove an admin still audits their own agent, with and
  without an explicit `org_id`.
- **Check:** the route refuses a foreign `org_id` without `SYSTEM_ADMIN`.

## 17. Registers 3 and 4 are not built — **OPEN** `[machine]`

Said plainly rather than half-built. The wave that added Register 2 did **not** add:

**REGISTER 3 — cron and boot.** Five modules (`reminders-cron`, `cert-expiry-cron`,
`weekly-digest-cron`, `email-snooze-cron`, `ai-spend-cron`) plus `server/db.js`'s boot
backfills. A cron sweeps every tenant **by design**, so the property is not "it must not
see two orgs" — it is "it must not COMBINE them into one output, and must not deliver
one tenant's rows to another's recipient". That is a different assertion and it needs a
per-recipient fixture.

What exists today is **one accidental door**: `GET /api/admin/reminders/cron-preview`
runs three of the five in dry mode, and Register 2 drives it. That is coverage of three
modules' happy path against a second organisation — real, and not a register.

**REGISTER 4 — model context.** What the model is HANDED never appears in a response
body, so no arm in any register can see it. `maybeGenerateSessionLabel` and
`seedRecoveredSession` are exported in writing for this and the conformance harness's SDK
mock is `{ messages: {}, beta: {} }` — it **records nothing**. A plant that put every
tenant's estimates into `buildEstimateContext` would be invisible to all of it.

The machinery already exists one file over: `test/ai-personal-surface-tenant.test.js`
records every `messages.create` and `beta.sessions.events.send` argument into
`__P86_MODEL_SAW__` and asserts on that. Register 4 is that recorder, plus the context
builders driven, plus the same two arms. It is a day of work, not a week, and it is the
register whose absence hides the most.

- **Check:** `test/tenant-register3-cron.test.js` and `test/tenant-register4-model.test.js`
  exist.

---

## Rollback, written down before it is needed

**The switch.** Railway → Variables → `P86_TENANT_SCOPE=legacy`. Railway
restarts the service; that is the same ~2-3 minute swap this repo already
documents, from a phone, with no code push, no build and no git operation.
Verify by SHA at `/api/health`. It writes `[TENANT-SCOPE:legacy]` to the log on
**every** use, deliberately, so it cannot be left on by accident.

**If the switch is not enough.** `git revert <sha>`, in reverse order.

**One commit must never be reverted:** the `users.owner_id` removal (`f829e682`).
It deletes a reference to a column that never existed; reverting it re-breaks a
flow that is already broken.

## What the harness can and cannot catch

Written here because a harness that reports its own limits is worth more than one that
claims eight registers and has five.

**It can now catch, and could not before:**

- A route added anywhere in the server that reads across tenants. 569 routes are
  enumerated from `router.stack`; 137 are driven. Previously 4 were.
- An IDOR — a door answering a foreign id it never checked. The recipes now carry a
  FOREIGN-ID axis, derived, so a recipe added next week gets its foreign twin for free.
- A tool group smuggled in behind a new accessor. The accessor list is derived from
  `internals` by shape, not typed.
- A door that PROVES NOTHING. Arm 0 runs Arm 3 backwards — org A's answer must CHANGE
  when org A's own data disappears — and it found that of 58 "driven" tools only **34**
  are exercised. The other 24 are ledgered by name and category.
- A leak in the approval-tier executor, which no behavioural test reached before.

**It still cannot catch:**

- **Anything a cron does.** Register 3 is not built; see item 17.
- **Anything handed to the model rather than returned to a caller.** Register 4 is not
  built; see item 17. This is the largest hole.
- **A leak past the first page.** The widened-bounds arm pushes every limit to its
  maximum, which catches a handler that clamps LIMIT before applying its predicate. It
  is **not** a true page-2 axis: **no OFFSET** is accepted by any of these tools, and
  with three rows per table no default limit hides anything anyway. A real second page
  needs the fixture padded until org B falls off page one.
- **A leak that needs a WRITE to expose it.** Item 6.
- **A leak in the 432 routes that need a path parameter.** Counted, not driven.
- **A wrong QUERY.** Every failure is a marker, a magnitude or a diff. The harness says
  an ANSWER is wrong; a human finds the statement.
- **A leak welded to a letter with no delimiter** — `org900000002`. Arm 2 stopped reading
  digit runs inside words after a minted folder id (`efld_mtp4sz915488502d`) landed in the
  reserved band by chance and turned the suite red on nothing, one run in three. Arms 1
  and 3 still see that shape; Arm 2 no longer does.

### The instrument itself, and what had to be fixed in it

Three faults in the harness were found by running it many times rather than once. They are
recorded because each one produced a GREEN or a SILENCE that meant nothing, and the next
person to extend this will meet them again.

1. **`process.exit()` in a file named `*.test.js` kills the jest worker.**
   `test/report-shares.test.js` did this at module scope. Its 22 assertions counted as
   ZERO tests and anything queued behind it on that worker went too. Fixed by delegating
   to jest when jest is present.

2. **A native database left open crashes the process with no output at all.**
   `node:sqlite`’s `DatabaseSync` is a native handle and nothing closed one, so a run left
   hundreds open for the GC to finalize whenever it liked. Driving 137 real routes then
   killed the process with exit `0xC0000409` (STATUS_STACK_BUFFER_OVERRUN) — no exception,
   no stack, **zero bytes of output**. THE CRASH RATE TRACKED THE NUMBER OF UN-CLOSED
   HANDLES and nothing else: three engines 3 runs in 20, two engines 1 in 20, one engine 0
   in 24. `createPgSqlite` now exposes `close()`, both registers call it, and Register 2
   additionally retries its child up to three times and PRINTS any retry it needed.
   Measured after the fix: 0 bad runs in 25, 0 retries used.

3. **A per-request fixture makes background work look like a leak.**
   Several handlers keep working after they respond. With a fresh engine per request those
   continuations land in whichever world is active when they finally run — some later
   route's — and `/api/email-folders` came back 'leaking' about one run in three while the
   same route driven 30 times alone was clean every time. One engine per pass removes the
   class. **A flaky boundary assertion is worse than a missing one:** it gets muted, and a
   muted harness protects nothing while wearing the costume of protection.

### The plants, and how to re-run them

The only evidence that counts for "the harness catches X" is a plant of X that turns it
red. `test/fixtures/tenant-plants.js` holds **17 real defects**, one shape each, and runs
them one at a time — applying, running the affected suites, restoring, and verifying the
restore by sha256. Every plant REFUSES a non-unique or missing match, so it cannot
silently no-op and report a false green.

    node test/fixtures/tenant-plants.js list
    node test/fixtures/tenant-plants.js run all

Measured: **14 caught, 3 escape.** The three are the two cron plants and the model-context
plant — i.e. every escape is inside Registers 3 and 4, which item 17 says are not built.
Nothing escapes in a register that exists.

## What this checklist does not cover

- **Writes.** This wave is a read boundary end to end. See item 6.
- **Runtime protection.** If a leak reaches production — a hotfix that skips CI,
  a red build overridden — there is no second line. Postgres RLS would be one,
  and `server/routes/ai-routes.js:8788-8800` already names it as the endgame and
  prices its two costs. That is deferred, not refuted: with one organisation
  there is nothing for a runtime guard to protect, and the failure mode of a
  wrong runtime guard is "the app cannot see its own data" on a live pilot with
  real money in it.
- **The client.** A leak caused by the browser holding another tenant's rows in
  `localStorage` is a different class with its own history in this codebase.
- **What the harness can tell you.** It cannot tell you a *query* is wrong — only
  that an *answer* is. Every failure is a marker, a magnitude or a diff, and a
  human reads it and finds the statement.
