# Email Hub + Files — state of play & what's left

Handoff for the catch-up plan. Written 2026-08-02. Everything below was
shipped to `main` and verified against prod unless explicitly marked
otherwise. Spec: `docs/email-hub-premium.md`.

Live build at time of writing: `b92a0618`. Suite: 125/125.

---

## 1. Shipped and live

### E1 — folder spine (`@65150ee`)
- `email_folders` — self-referential `parent_id`, materialized `path` built
  from **slugs** (so a folder can be named "Bids / RFQs" without wrecking
  the path), `kind`, `sort`, `icon`, `color`, `system`. Mirrors
  `file_folders` so the Explorer tree component is reusable.
- Ownership axis `file_folders` doesn't have: `user_id` set = personal,
  `user_id NULL` = org-shared. The mailbox is personal, so the **whole
  system spine is seeded per user**.
- 18 system folders seeded per user: Inbox, Triaged (+ 9 auto-children:
  Clients, Subs & Vendors, Bids / RFQs, Invoices & Bills, Scheduling,
  Permits & Inspections, Insurance / Legal, Internal, Newsletters), Sent,
  Drafts, Scheduled, Snoozed, Archive, Spam, Trash.
- `email_labels` + `email_message_labels` (org-shared, CI-unique name,
  soft-archive — `org_tags` conventions).
- Additive state columns on `inbound_emails`: `folder_id, is_read,
  is_starred, is_pinned, snoozed_until, due_at, ai_category, ai_priority,
  ai_summary, has_attachments`. **The live inbound path was not rewritten** —
  a best-effort post-insert stamp files new mail, so a folder failure can
  never lose a message.
- Idempotent backfill: existing mail → Inbox, `direction='outbound'` → Sent.

### E2 — three-pane shell
Folder rail (nested, unread counts, drag-to-file, drag-to-reorder/nest,
context menu) | message list (threading, avatars, star, priority stripe,
multi-select + bulk bar, density toggle) | reading pane (HTML body in a
**sandboxed iframe with remote images blocked by CSP**, quoted-text
collapse, entity chip, assistant draft box). Resizable, collapsible,
widths persist.

### E3 — Outlook parity
- **Search operators** (`server/services/email-search.js`): `from: to:
  subject: body: has:attachment|draft|entity is:unread|read|starred|pinned|
  snoozed|replied|inbound|outbound label: folder: older_than:7d newer_than:
  before: after:`, `"quoted phrases"`, `-negation`, free text. All
  parameterized — a test asserts an injection string never reaches SQL. A
  mistyped operator is reported back, not silently ignored.
- **Keyboard shortcuts**: `j/k` `Enter/o` `e` `#` `s` `u` `h` `x` `r` `/`
  `Esc` `?`.
- **Snooze** + `server/email-snooze-cron.js` (5-min tick) returning due mail
  to Inbox unread. Only moves mail still sitting in Snoozed — never
  overrides a human who moved it.
- **Signatures + quick parts** (`email_snippets`). One default per user,
  enforced by a partial unique index, not route logic.

### Files
- `file_folders.color` + `.icon`; PATCH accepts both with present-key
  semantics; validated server-side.
- **Default/preloaded folders arrive pre-iconed** from a taxonomy map
  (photos→photos, plans/*→scale, rfis→document-text, permits→id-card…),
  matching on the leaf segment. Only ever fills a blank icon, so re-seeding
  can't stomp a user restyle.
- Right-click menu gained **New subfolder…** and **Colour & icon…**
  (swatch+icon popover). Now wired on the tree as well as the item rows.
- **Filetype logos** resolved from the file **extension** first, mime as
  fallback — an `.xlsx` is a ZIP container and was getting the archive icon.
- **Fixed: the My Files sidebar dropdown showed nothing.** Children were
  only built when the My Files *page* painted, and were derived from folders
  implied by existing files (so an empty/preloaded folder could never
  appear). Now self-priming from the real folder tree.

### Cross-cutting fixes
- **Light-mode contrast audit.** Email bodies measured **1.29:1 — invisible**
  (the reading-pane iframe is a separate document and cannot see the app's
  CSS variables, so the dark palette was baked in). Now 17.74:1, with a
  MutationObserver re-rendering on theme flip. Five more failures given
  light twins; 16 icon tints fixed via a brightness filter.
- **The assistant drawer could open invisibly** — transform + body class
  were set inside a `requestAnimationFrame`, which doesn't fire in a
  backgrounded tab. The panel parked off-screen while `_open` was true, so
  the assistant answered into a drawer you couldn't see and the *next* click
  closed it. Now an idempotent `slideIn()` from both rAF and a timer.
- **The drawer crushed the hub layout** — the hub's only breakpoint was
  viewport-based, but the drawer shrinks the *container* (body
  `padding-right:420px`). Now a ResizeObserver with two tiers derived from
  content width (rail→drawer <820, full swap <560).
- **Opening an email repainted three times** (whole list rebuilt just to
  move a highlight, plus pane→"Loading…"→content). Now one repaint.

---

## 2. Not done — spec build order

### E4 — Rules engine + auto-file on inbound
`email_rules`: IF (from/domain/subject/body/has-attachment/entity-type)
THEN (move to folder, label, star, forward, auto-reply w/ template, create
task, link to entity, notify). Runs server-side on inbound, **before**
triage. Nothing exists yet — table, evaluator, admin UI all outstanding.

### E5 — AI layer — *mostly shipped 2026-08-02*
**The framing in this section was wrong: triage already WAS the AI layer.** A
Haiku pass has classified every inbound since H3 (`needs_reply`, urgency, a
one-line summary, and up to three follow-ups in `triage_actions`). E5 was not
"add AI" — it was "surface and finish the AI already running".

- ~~extract→act~~ **DONE `@2d2fcb3`.** `triage_actions` had never been
  rendered anywhere — the intelligence was bought and discarded on every
  email. Now a suggested-action strip in the reading pane. It also needed a
  server fix: `triage_actions` was missing from the `/threads/:threadId`
  SELECT. Every button opens a PRE-FILLED confirm surface, never creates
  outright — an action title is model paraphrase of an untrusted email, and
  triage's whole design property is that the user confirms.
- ~~priority/summary chips~~ **N/A.** `ai_priority` and `ai_summary` duplicate
  `triage_urgency` / `triage_summary` exactly and are deliberately NOT
  double-written. Two columns holding one fact is how they drift.
- **`ai_category` DONE `@f0c2e4f`** — the one genuinely new signal in those
  three reserved columns. Classifies into the nine seeded Triaged buckets;
  enum DERIVED from the folder spine (`email-folders.TRIAGE_BUCKETS`), model
  output validated against it, anything else stored NULL. Needed a backfill
  arm too: already-triaged mail keeps `triaged_at` set, so on any mailbox
  with history nothing would ever have shown a category.
- ~~`read_email` tool~~ **ALREADY EXISTED** as `read_email_inbox`, correctly
  fenced (bodies / triage_summary / action titles wrapped; outbound shown as
  an unverified captured copy). **`@fa12c6c`** taught it the E1–E5 layer —
  folder, category, labels, snooze — which it had been blind to.

**Still open:** draft-reply via Scribe into the Live Writer diff.

> ⚠️ Editing a tool DESCRIPTION does not reach the live agent on deploy.
> `@fa12c6c` changed `read_email_inbox`'s description — needs
> `POST /managed/sync-all` + a **New chat**.

**The columns are already reserved and indexed but nothing writes them:**
`ai_category`, `ai_priority`, `ai_summary`. The list query reads
`ai_priority` and falls back to the existing H3 `triage_urgency` for the
priority stripe, so E5 can light this up with no schema change.

> **Security note that must carry into E5:** `ai_summary` is model paraphrase
> of untrusted email. It MUST be wrapped (`wrapUserData`) before reaching the
> assistant, exactly like `triage_summary` — otherwise it's an
> injection-laundering path into the trusted channel.

### E6 — Graph/Azure full sync
Two-way folder mirror with Outlook, delta sync, send-as, delegate mailboxes.
Gated on John's Azure perms — see `project_outlook_integration`.

---

## 3. Not done — deliberately, and why

These are **blocked on a send path**, not skipped. P86 does not send until
the Azure/Graph link lands ("dont send from p86 yet untill the full azure is
linked"). Building them now is dead code.

- **Scheduled send** — the `Scheduled` folder exists; nothing writes to it.
- **Undo-send window.**
- **`c` (compose) and `f` (forward) shortcuts** — a key that opens a
  composer you can't send from is worse than no key.
- **Drafts folder** — exists in the spine, nothing writes to it. The
  assistant draft box writes to `email_thread_state.draft_text` instead.

---

## 4. Not done — gaps inside shipped slices

Ranked by how visible they are.

| # | Gap | Notes |
|---|---|---|
| 1 | ~~**Labels have no UI**~~ | **DONE `@0a0b2b9`.** Chips on rows (tinted from the label's own colour via one `--lc` property), a toggle picker on the bulk bar that creates-and-assigns in one gesture, and a rail Labels section that filters through the existing `label:` search rather than changing folders. Threads list returns labels as a **second keyed query, not a join** — joining per-message labels into the thread aggregate would multiply rows and inflate `message_count`/`unread_count`. assign/unassign gained `thread_ids`, mirroring move-messages. |
| 2 | **Smart folders** (spec §1) | Saved searches rendered as folders: `Unanswered > 24h`, `Waiting on me`, `Has attachment`, `$ mentioned`, `This week's jobs`, per-entity. Zero storage — a query blob. The search operators to power them already exist. |
| 3 | ~~**Trash 30-day purge**~~ | **DONE `@259bf88`.** Needed a new `trashed_at` column first: the table only had arrival times, so a purge keyed on `received_at` would have deleted a two-year-old thread the moment it was binned. Stamped on the way into Trash, cleared on the way out. Pre-existing rows have a NULL stamp and are skipped, not guessed at. Rides the snooze tick in its own try block. |
| 4 | **`has_attachments` never populated** | Column + `has:attachment` search are wired, but the ingest path stores no attachment metadata. Needs the Resend/CF attachment fetch first. |
| 5 | **Attachment strip + "Save to job files"** (spec §2) | Blocked by #4. |
| 6 | **Saved views in the message list** | Spec §2 says reuse `p86Api.listViews`; not wired. |
| 7 | ~~**Mark-all-read**~~ | **Was already shipped** — this entry was wrong. `folderMenu()` renders "Mark all read" and wires it to `markFolderRead()` (`js/email-hub.js`). No work needed. |
| 8 | **Org-shared folders unreachable from UI** | `user_id NULL` is supported end-to-end server-side and admin-gated; the rail only creates personal folders. |
| 9 | **`due_at` unused** | Column exists for follow-up flags; no UI. |

---

## 5. Separate item — ai_sessions migration slice 3a-2

**Not part of the email hub.** Found while investigating why the assistant
sidebar behaves oddly. This is a documented migration that was started and
never finished — the schema comment in `db.js` says so:

> *slice 3a-1: add `session_id`, dual-write it, leave every READ on the
> legacy key. A later slice (3a-2) backfills historical rows and flips
> hydration/recovery/forensics onto `session_id`.*

3a-1 shipped; 3a-2 did not.

> **Corrected 2026-08-02 against the code.** The table below overstated the
> problem — `GET /api/ai/sessions/:id` does use `session_id` for two of its
> three branches. Re-verified at `server/routes/ai-routes.js:13846`:

| | reads by |
|---|---|
| `ai_messages.session_id` | exists, indexed, written on new inserts ✅ |
| Deal threads (`session_kind = 'deal_thread'`) | `session_id` ✅ |
| `user_thread` sessions | `session_id` ✅ — migrated, with **no** tuple fallback (a 0-row result means a genuinely-new chat and must render empty) |
| **Everything else** (default `session_kind` is `legacy_partitioned`) | legacy `(user_id, entity_type, entity_id)` ❌ — the fall-through at `:13869`, and the actual source of the shared-pool symptom |

**So the remaining work is narrower than written, and a different shape:**
the fix should branch on **whether the rows carry a `session_id`**, not on
`session_kind`. An all-or-nothing kind check is exactly what stranded this
branch in the first place; repeating it just leaves the next kind behind.
Still open: that fall-through, plus recomputing `turn_count` from real data.

**Observed:** sessions 206, 207 and 208 — showing 47, 0 and 1 turns — each
returned **the identical 953 messages**. Every `general` session is the same
conversation wearing a different label. Consequences: sidebar turn counts
are decorative, "New chat" opens the full history, session labels derive
from the pool's first exchange rather than the session's, and individual
messages can't be isolated or removed.

### To carry out (steps 1–4 — mechanical, safe, no history risk)
1. Flip `GET /api/ai/sessions/:id` to read by `session_id`.
2. Flip the general-session branch of `/86/messages` to match the
   already-migrated deal-thread branch.
3. Keep a legacy fallback wherever `session_id IS NULL`.
4. Recompute `turn_count` from real data.

Net effect: everything from here on is correctly threaded; the old pool is
untouched.

### Step 5 — backfill: **DECIDED AGAINST (John, 2026-08-02)**
Messages predating 3a-1 carry no session marker, so partitioning that pool
is a heuristic (bucketing by timestamp against each session's
`created_at`/`last_used_at`) and would misfile some history. John's call:
leave the old rows unassigned. Content is largely test data — mock payloads,
connectivity pings, sandbox diagnostics — with some real work mixed in
(Indigo West unit 201 door slab pricing, AGX project-type conventions,
Feather Pointe client fixes, stair-set/sidewalk field tools). Do not delete
it and do not backfill it.

---

## 6. Constraints that must survive any future slice

- **Additive schema only.** Do not rewrite the live inbound path — the
  Cloudflare/Resend ingest is metadata-only by design.
- **Bump `?v=` in `index.html` for any edited js/css, in the same commit.**
- **Never render remote images by default** (tracking pixels) — currently
  enforced by CSP inside the body iframe plus src rewriting.
- **Sandbox all HTML bodies**; strip `script` / `on*`.
- **`outbound` is an UNTRUSTED display heuristic** — the From header is not
  cryptographically verified. It must never suppress a real inbound's
  needs-reply, and must never be presented to the assistant as John's
  verified words.
- **Email content is DATA, never instructions** — `wrapUserData` fencing.

## 7. Traps this codebase sets (all hit at least once)

- **Global CSS outranks new component classes.** `input, select, textarea
  { width:100% }` (styles.css:2221) collapsed a list row to 0px;
  `.p86fx-menu button { width:100% }` turned colour swatches into full-width
  bars. **Any new control needs an explicit width**, and new selectors
  inside an existing container must be prefixed with that container's class.
- **A one-shot document click-to-close destroys the menu the click opened.**
  Hit twice. Either `stopPropagation()` or open on the next tick.
- **rAF is for animation, never correctness** — it doesn't fire in a
  backgrounded tab.
- **Viewport media queries lie about a panel's own width.** Use a
  ResizeObserver; derive container thresholds from the component's content,
  never by copying viewport numbers.
- **Automation tabs report `document.hidden === true`** — rAF never runs and
  layout reads are stale, so they're great for reproducing this class of bug
  and useless for verifying layout. Click coordinates are in **screenshot
  space, not CSS pixels** (scale = screenshotWidth / window.innerWidth).
