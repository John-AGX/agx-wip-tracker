# Handoff → Rolling86: complete the push

**From:** affectionate-feynman · **2026-06-14** · **Requested:** review → merge to `main` → deploy.

Two branches are pushed and ready. Sessions can't message each other, so this doc is the
baton. Both are **additive** features. Neither could be run against a live DB in my session,
so **each has a dry-run/preview safety net** — verify through that before the real apply.

---

## 1. `claude/scribe-user-ops` — Scribe gains password-reset + invite-resend  ← your subsystem

Adds a `user_ops` group to the `system` payload entity so 86 / the Assistant can, via
`scribe_write`, **resend a pending org invite** or **reset a user's password** — behind the
approve/reject card.

**Files**
- `server/services/payload-dispatcher.js` — `system` schema (+`user_ops`), `validateOps`
  (+`user_ops`), **threaded `dryRun` into the dispatcher ctx**, and the `user_ops` handler
  in `dispatchSystem`.
- `server/routes/ai-routes.js` — `emit_payload_file` tool description updated.
- `server/routes/admin-agents-routes.js` — Scribe system-prompt op vocab updated.

**Security model (please sanity-check — it's auth-sensitive, and it's your area):**
- **SYSTEM_ADMIN only.** Actor role is loaded server-side from `ctx.userId` *inside* the
  dispatcher (ctx carries no role → caller can't spoof it).
- **dry-run safe.** `applyPayload` previously passed only `{userId, organizationId,
  sourceAgent}` to dispatchers — **not** `dryRun`. Since these ops email + change auth
  (non-transactional), I added `dryRun: opts.dryRun` to that ctx (`payload-dispatcher.js`
  ~2937) and the handler **skips all email/password side-effects on dry-run** (validate +
  report only). ⚠️ That ctx field is shared by every dispatcher — worth a glance that
  nothing else cared about its absence.
- **password_reset** = matches your existing admin flow (`auth-routes.js` PUT
  `/users/:id/password`): set a strong temp password + email it (John's call: "match
  existing"). Never logs/returns the password.
- **resend_invite** = reuse the existing token, refresh `expires_at` +7d (the
  `org_invitations` table has no `updated_at`), reject already-accepted; reuses
  `sendForEvent('org_invite', …)`.
- **Audited** via a synthetic-req `auditLog()` (`user.password_reset` / `org.invite_resend`).

**Verify:** boot server; as system_admin, `scribe_write("reset password for user <id>")` →
approve card previews with **no email sent**; approve → temp-password email + `admin_audit_log`
row. Repeat `resend_invite`. Confirm a non-system-admin agent gets the hard error.

---

## 2. `claude/project-costs-backfill` — bulk historical jobs + costs importer

A **"Backfill Project Costs"** button (Jobs screen) that reads a QB Project Costs workbook
(Profitability + Cost Detail tabs), **creates jobs + attaches cost lines** server-side,
idempotently, with a dry-run preview. Built for John's 06.19.26 export
(~**293 jobs / 2,237 lines / $1.86M cost**).

**Files:** `server/routes/project-costs-backfill-routes.js` (new, admin/PM-gated),
`server/index.js` (mount), `js/project-costs-backfill.js` (new), `index.html`
(button + modal + script include).

**⚠️ Rebase note:** this branch was cut from an **older `main`** (before outlook/reminders/
etc.). Rebase/merge onto current `main` — additive (new files + small `index.js`/`index.html`
inserts), low conflict risk; re-verify the `index.js` mount + `index.html` anchors after.

**Verify:** deploy → Jobs → Backfill Project Costs → upload xlsx → preview should show
~293 create / 2,237 lines / $1.86M (writes nothing) → approve → jobs+costs land. Idempotent
(jobs match by jobNumber; lines by content-hash).

---

## To complete the push
1. Review the diffs (scribe-user-ops especially — your area + auth).
2. Rebase/merge each onto current `main`.
3. Push `main` → Railway deploys project86.net.
4. Run the dry-run/preview on each before the real apply.
5. Add a line to `SESSION_LOG.md`.

Open Qs for John (not blockers): voice-chat direction (`PROJECT86_STATUS.md` §4), BugSec identity.
