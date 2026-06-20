# Project 86 — Production Status Board

**Living doc · on `main` · last updated 2026-06-14.** Single always-current map of
what's **intended / built / left out**, so any device or session can pick up where we
are without chat memory. Update when something ships. Companion: `docs/SESSION_LOG.md`
(who's working on what), `docs/86-scribe-rework.md` + `docs/assistant-v1.md` (Rolling86's
AI specs), `docs/PROJECT86_CRM_PLAN.md` (property-intel CRM).

---

## 1. Snapshot

Mature, in-production construction ERP — Express + PostgreSQL + vanilla-JS SPA/PWA on
Railway. Shipping fast (72 commits to `main` in the ~3 days before this update). The AI
was just **re-architected into a 3-agent tiered pipeline** (see §3). Voice is still
**dictation only** — 86 does not speak back yet.

---

## 2. Built & shipped (by area)

- **AI (86)** — the centerpiece; re-architected. See §3.
- **Jobs / Estimating** — estimate builder (lines/groups/alternates/scope/markup), **Change Orders**, **Purchase Orders** (net-new entity, BT spec), **cross-job hub** (COs / RFIs / Submittals), WIP node graph, QB cost import, edit-gate, live totals chip.
- **Estimates Map** — server-side geocoding so every estimate plots on a map view.
- **Leads** — 6-stage pipeline + **Lead Activities** board (follow-ups).
- **Schedule / Calendar** — major overhaul: Outlook-style bars + month grid (mobile per-cell chips), unified day-at-a-glance, **per-user personal events** layer.
- **Assistant Hub / My Notes** — `user_notes` + a combined map + notes + hub surface (Assistant P1).
- **Photos** — viewer + side panel, comments, tag picker, annotate-in-place, tile density. *(complete)*
- **Reports** — 8 templates, 5 layouts, 8 style packs, per-template covers, searchable list. *(complete)*
- **Org / multi-tenant** — orgs, roles+capabilities, invites, users directory, My Files, per-org branding (incl. map pins).
- **Compliance (Wave 3)** — COI / license / lien-waiver / WC cert tracking. *(beta — alerts on hold)*
- **Maps** — Google Maps, typed pins, geocoding on write; now `js/entities-map.js` + `server/routes/map-routes.js` plot leads/jobs/estimates; co-located pins grouped.

---

## 3. The AI — now a 3-agent tiered pipeline (Rolling86's rework, live ~2026-06-18)

One conversational door (the "86" button). Three agents behind it:

```
Assistant (Haiku 4.5) ── default host; reads/navigates/memory, capability bounded by the
   │                      user's role. Personal layer (calendar/tasks/daily summary).
   ├─ scribe_write ───────────►  Scribe (Sonnet 4.6) ── write-only worker, NO reads.
   │  (light/menial writes)        │   Authors ONE emit_payload_file, dry-runs it,
   │                               │   returns the inline Approve/Reject card.
   └─ escalate_to_86 ─────────►  86 (Opus 4.8) ── deep reasoning: estimating, WIP,
                                   │   job-costing, margins, scope. Does NOT write —
                                   │   delegates to the Scribe via scribe_write.
                                   └─ baton: hands control BACK to the Assistant.
```

- **Capability is bounded by the acting user's role** (acts AS the user, never above); org-scoping always on (`assertTargetOrg`).
- **Approval card is a separate, risk-tiered lever:** personal/low-stakes → low-friction; shared-business / outward-facing → inline Approve/Reject card.
- **Memory** (`remember`/`recall`) + per-client `agent_notes` persist across sessions.
- **Retired:** the 5 staff watchers (`86-pm/estimator/directory/scheduler/sales`) + Tier-3 staff-spawn + server-side skills install — `STANDING_STAFF_SPECS = []`. Legacy payload UI (drag-to-dropbox, CSV converter) deleted.
- Full spec + rationale: `docs/86-scribe-rework.md`, `docs/assistant-v1.md`.

---

## 4. Voice — current vs. target (active focus)

**Shipped:** dictation / speech-to-text via the browser Web Speech API — shared helper
(`js/voice-input.js`) on the chat mic + walkthrough captions. Recent commits hardened
mobile (mic usable after send, killed double-speak). **Voice in → text out.**

**Missing for real "voice chat":** 86/Assistant **speaking back** (no TTS / `speechSynthesis`
anywhere), a **hands-free turn-taking loop**, optional realtime audio. Confirmed absent —
not even a stub.

**Natural home:** the new **Assistant (Haiku)** is the conversational front door, so voice
chat should layer onto it. Roadmap:
- **A — Browser-native loop (fast):** `speechSynthesis` to speak replies + auto-listen + a "voice mode" toggle. Cheap, robotic voices.
- **B — Premium streaming voice:** high-quality TTS / realtime with barge-in. Best UX, more build + per-minute cost.
- **C — Phased (recommended):** ship A on the Assistant to prove the loop, swap in B behind the same toggle.

---

## 5. Partial / in-progress / risks

- **Assistant v1 not finished** — per `assistant-v1.md`, still pending: baton hand-back (`route_next`), Scribe write-coverage for **tasks + reminders**, the personal toolset (calendar / daily summary / "jobs near me"), and **Outlook / MS-Graph** (`[LATER]`).
- **Scribe pipeline freshly landed** — many `fix(scribe)` commits in the last few days; treat as stabilizing.
- **Compaction (task #30, watch):** the `compact-2026-01-12` beta header is set but reportedly never fires → 86's rolling `user_thread` can blow context on long sessions (86-only; Scribe is stateless).
- **Compliance expiration alerts** — on hold pending the maintenance-clock feature.
- **RBAC granularity** — roles/capabilities exist but are still coarse.

---

## 6. Planned / not started

- **Property-Intelligence CRM** (current clients + scored Central-FL prospects + lead heat
  map). Designed in **`docs/PROJECT86_CRM_PLAN.md`**; blocked on engine **Phase 0**
  (`agx-property-intel` emits lat/lng + a join key). *Note:* the map plumbing has since
  advanced (`entities-map.js`, `map-routes.js`, estimate geocoding) — the plan's map
  section should be refreshed against those before building.

---

## 7. Open questions

- **"BugSec"** — referenced as a session/workstream but has no doc or clear footprint on
  `main`. Needs John to identify it (and ideally have it drop a spec in `docs/`).
- **Voice direction** — confirm A / B / C (§4).
- **Other active streams** (Calendar overhaul, Purchase Orders, Estimates Map, Lead
  Activities) — session attribution TBD; see `SESSION_LOG.md`.

---

## Appendix — key files (current `main`)

- AI agents: `server/routes/ai-routes.js`, `server/routes/admin-agents-routes.js`, `js/ai-panel.js`
- Voice: `js/voice-input.js`
- Maps: `js/entities-map.js`, `server/routes/map-routes.js`, `js/map-pins.js`, `server/geocoder.js`
- Calendar: `server/routes/calendar-routes.js`, `js/schedule.js`
- Purchase Orders / hub: `js/purchase-order-editor.js`, `server/routes/purchase-order-routes.js`, `js/jobs-hub.js`
- Notes/Assistant: `server/routes/notes-routes.js`
- Feature catalog: `server/feature-catalog.js`
