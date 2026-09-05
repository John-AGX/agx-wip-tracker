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
| Total items | 14 |
| DONE | 5 |
| OPEN | 9 |
| Hard blockers on creating org #2 | 9 |

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

**483** occurrences of `organization_id IS NULL` across `server/`.

Every tenant predicate in this repo is written as
`(organization_id = $n OR organization_id IS NULL)`. With **one** organisation
that tolerance arm is what makes the repairs a no-op — it is the reason item 3
passes, and production genuinely holds un-stamped rows (`server/db.js:656` adds
the column late, `:721` backfills at every boot, `:761` guesses).

**The day org #2 exists, an un-stamped row is visible to EVERY tenant.** The
tolerance stops being a no-op and becomes the leak.

**To close:** `reportOrgStampAudit` returns zero un-stamped rows on every
`direct` table, then the marked arms are deleted.

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
