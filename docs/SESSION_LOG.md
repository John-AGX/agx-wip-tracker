# Session Log — multi-session coordination

**On `main`. The shared bus is git: sessions don't talk directly — we coordinate by
reading/writing this repo.** `main` is the trunk every active session lands on, so this
log + the `docs/*` specs + recent commits are how we stay in sync.

### Protocol (every session)
1. **Before working:** `git fetch origin main`, then read this log + recent `git log`
   + any relevant `docs/*.md` spec. Get current first.
2. **While working:** note your session name, branch, and which files/areas you're
   touching (below), so others don't collide.
3. **When you land work:** update your section here + commit to `main`. Park durable
   plans/rationale as their own `docs/<workstream>.md` (Rolling86's convention).
4. **Cross-session reads** (if someone's on a side branch):
   `git show origin/<branch>:docs/<file>.md` — no merge needed.

### How to read another session's work without a chat channel
You can't message a session, but you can read everything it *does*: `git fetch --all`
then read its commits (`git log origin/main`) and its `docs/*` specs. That's the
knowledge transfer — durable and complete.

---

## Roster

| Session | Branch | Focus | Knowledge docs |
| --- | --- | --- | --- |
| **Rolling86** | `main` | AI re-architecture: 86→orchestrator + write-only Scribe + Haiku Assistant; retired the 5 staff watchers | `86-scribe-rework.md`, `assistant-v1.md` |
| **BugSec** | ❓ unknown | ❓ unidentified — no doc/footprint on `main` yet | — (needs one) |
| **affectionate-feynman** (this) | `main` (was `claude/affectionate-feynman-1modbp`) | Property-intel→CRM plan; production-state audit; cross-session coordination | `PROJECT86_CRM_PLAN.md`, `PROJECT86_STATUS.md`, this log |

> **Other active streams on `main`, attribution TBD:** Calendar/Schedule overhaul
> (Slices A–C, personal events), Purchase Orders + cross-job hub, Estimates Map,
> Lead Activities. If these are yours, claim them here.

---

## Active handoffs

### → Rolling86 — complete the push (assigned 2026-06-14 · affectionate-feynman)
Two branches pushed, ready to **review → merge to `main` → deploy**. Baton: **`docs/handoff-to-rolling86.md`**.
- **`claude/scribe-user-ops`** — `system.user_ops` (password_reset + resend_invite) on the Scribe. **In your subsystem** (payload-dispatcher / Scribe vocab) + auth-sensitive → you're the right reviewer. SYSTEM_ADMIN-gated, dry-run-safe, audit-logged.
- **`claude/project-costs-backfill`** — bulk historical jobs+costs importer (~293 jobs / 2,237 lines). Cut from older `main`; rebase on current `main` (additive, low-conflict).
Neither ran against a DB; both ship with dry-run/preview safety nets (verification in the doc).

---

## Entries (newest first)

### 2026-06-14 · affectionate-feynman (handoff)
- Shipped two feature branches and **handed the push to Rolling86** (see Active handoffs + `docs/handoff-to-rolling86.md`): `claude/scribe-user-ops` + `claude/project-costs-backfill`.
- Heads-up for Rolling86: scribe-user-ops adds `dryRun` to the dispatcher ctx (`payload-dispatcher.js` ~2937), shared by all dispatchers — worth a glance.

### 2026-06-14 · affectionate-feynman
- Joined `main` and caught up on 72 missed commits (was branched off stale `f208bbc`).
- **Corrected the record:** the AI is now 3 agents (Assistant/Haiku → 86/Opus → Scribe/Sonnet); the 5 staff watchers are retired. Earlier audit (off stale code) was wrong; `PROJECT86_STATUS.md` now reflects live `main`.
- Absorbed Rolling86's specs (`86-scribe-rework.md`, `assistant-v1.md`) — in line with the architecture + rationale.
- Brought the property-intel **CRM plan** onto `main`; flagged that its map section predates `entities-map.js` / `map-routes.js` and needs a refresh.
- Set up this coordination log + protocol.
- **Open:** identify **BugSec**; confirm **voice-chat** direction (A/B/C in STATUS §4); confirm whether the Calendar/PO/Map/Leads streams are Rolling86 or separate.

### (Rolling86 — please add your entries)
### (BugSec — please add your entries)

---

## Directive to hand to other sessions
Paste this into **Rolling86** and **BugSec** so they join the protocol:

> We run multiple Claude Code sessions on `agx-wip-tracker`; we coordinate through git,
> not chat. (1) `git fetch origin main` and read `docs/SESSION_LOG.md` + recent commits.
> (2) Run `git log -25 --oneline` on your branch and summarize who you are, what you've
> built, what's in-flight, and key decisions — add it under your heading in
> `docs/SESSION_LOG.md`, and park any durable plan as `docs/<workstream>.md`. (3) Commit
> to `main`. (4) Going forward: read-before / update-after, and note which files you're
> touching so we don't collide.
