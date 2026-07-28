# Premium Email Hub — spec (P86)

Goal (John, 2026-07-28): an Outlook-grade mail client **inside Project 86**, so once the
full Azure/Graph connection is live he does his mail triage + AI work here, not in Outlook.
Today's hub is a flat list (only `'sent'` exists as a folder concept) — this adds the
folder spine, the three-pane client, and the AI layer Outlook can't do.

The differentiator is NOT "reimplement Outlook". It's that **every email is already
connected to a lead / job / estimate / client / sub / PO** — mail becomes an operational
surface, not a separate inbox.

---

## 1. Folder + label model (the spine)

Two orthogonal systems, like modern mail:

**Folders (exclusive — one per message).** Table `email_folders`
(`id, organization_id, user_id NULL=org-shared, name, slug, kind, parent_id, sort, icon, color, system BOOL`).
Self-referential `parent_id` = unlimited nesting, same shape as the file Explorer
(`file_folders`) so the tree component is reusable.

System folders (auto-seeded, undeletable):
- **Inbox** — unfiled, needs a human
- **Triaged** (AI-sorted, auto-children below)
- **Sent** · **Drafts** · **Scheduled** · **Snoozed** · **Archive** · **Spam** · **Trash** (30-day purge)

Auto-child folders under Triaged, driven by the existing Haiku triage:
`Clients` · `Subs & Vendors` · `Bids / RFQs` · `Invoices & Bills` · `Scheduling` ·
`Permits & Inspections` · `Insurance / Legal` · `Internal` · `Newsletters`

**Labels (multi — many per message).** Table `email_labels` + `email_message_labels`.
Colored chips, org-shared. Reuse `org_tags` conventions.

**Smart folders (saved searches, zero storage).** Stored as a query blob, rendered as a
folder: `Unanswered > 24h` · `Waiting on me` · `Has attachment` · `$ mentioned` ·
`This week's jobs` · per-entity (`Mail for job #1234`).

**Message state columns** on the inbox table (additive, no rewrite):
`folder_id, is_read, is_starred, is_pinned, snoozed_until, due_at, thread_id,
entity_type, entity_id, ai_category, ai_priority, ai_summary, has_attachments`.

---

## 2. Layout — three-pane client

`[ folder rail | message list | reading pane ]`, resizable, collapsible, remembers widths.
Mobile: rail → drawer, list → full width, tap = reading pane (matches the app's PWA pattern).

- **Folder rail**: nested tree, unread counts, drag-to-reorder, drag message → folder,
  right-click (New subfolder / Rename / Color / Mark all read).
- **Message list**: **conversation threading** (group by `thread_id`, collapse to newest
  + count), sender avatar, preview line, attachment clip, star, AI-priority stripe,
  multi-select + bulk bar (reuse the pattern from Jobs/Leads bulk), density toggle
  (comfortable/compact), saved views (reuse `p86Api.listViews` — already built).
- **Reading pane**: full HTML body (sandboxed iframe), quoted-text collapse, attachment
  strip w/ preview + **"Save to job files"**, entity context card (`p86EntityCard` —
  already built), and the AI action bar.

---

## 3. Outlook-parity features (the "premium" table stakes)

Rules engine · signatures (per-user, rich) · templates/quick-parts (reuse
`email_templates`) · scheduled send · snooze · follow-up flags w/ due date · out-of-office ·
read receipts · conversation mute · block/allow sender · undo-send window · unified search
(sender/subject/body/attachment name, operators `from: has:attachment older_than:`) ·
keyboard shortcuts (`j/k` `e` archive `#` trash `r` reply `f` forward `/` search `c`
compose) · print/export EML · CC/BCC + delegate mailbox once Graph lands.

**Rules engine** (`email_rules`): IF (from/domain/subject/body/has-attachment/entity-type)
THEN (move to folder, label, star, forward, auto-reply w/ template, create task, link to
entity, notify). Runs server-side on inbound, before triage.

---

## 4. The AI layer (why this beats Outlook)

Built on what's already live (Haiku triage + 86 + Scribe + the Live Writer):
1. **Auto-file + auto-link** — triage picks the folder AND resolves the entity
   (lead/job/estimate/sub) from sender + subject + body. Low-confidence → Inbox, never guess.
2. **Priority + summary on every thread** — one-line "what this is / what it wants",
   priority stripe (Needs reply · FYI · Money · Schedule).
3. **Draft replies in your voice** — Scribe drafts, shows in the Live Writer diff, you
   approve. Reuses the existing approval card + `p86:payload-applied`.
4. **Extract → act**: email → Task, → Calendar event, → Cost Inbox receipt, → RFI, → CO,
   → Bill (the Doc Import OCR path already exists for PDFs).
5. **Digest**: "20 emails while you drove — 3 need you" (weave into My Day, already built).
6. **Ask 86 about mail**: "what did the Solace engineer say about the chimney caps?" —
   needs a `read_email` tool + the auto-tier allowlist trio
   (see `reference_ai_autotier_misroute`).

---

## 5. Build order

- **E1 — Folder spine**: `email_folders` + `email_labels` tables, seed system folders,
  CRUD routes, message state columns. *(no UI change; everything else stands on this)*
- **E2 — Three-pane shell**: folder rail + list + reading pane, threading, read/unread,
  star, move/archive/trash, bulk bar, density.
- **E3 — Outlook parity**: search + operators, keyboard shortcuts, snooze, scheduled send,
  signatures, templates, undo-send.
- **E4 — Rules engine** + auto-file on inbound.
- **E5 — AI layer**: priority/summary chips, draft-reply via Scribe, extract→act buttons,
  `read_email` tool for 86.
- **E6 — Graph/Azure full sync**: two-way folder mirror w/ Outlook, delta sync, send-as,
  delegate mailboxes. *(gated on John's Azure perms — see project_outlook_integration)*

## Constraints
- Additive schema only; don't rewrite the live inbound path (Resend webhook is
  metadata-only by design — see `project_86_email_hub`).
- Bump `?v=` for any edited js in the same commit (`reference_cache_buster`).
- Never render remote images by default (tracking-pixel privacy); proxy or block.
- Sandbox all HTML bodies (`iframe sandbox`, strip script/on* — XSS surface).
