# Project 86 — Production Status Board

**Living doc · last updated 2026-06-14.** Purpose: a single always-current map of
what's **intended**, **built**, and **left out** in Project 86 (`agx-wip-tracker`,
project86.net), so any device or any new session can pick up exactly where we are
without relying on chat memory. Update this whenever something ships or changes.

---

## 1. Snapshot

Project 86 is a **mature, in-production construction ERP** — Express + PostgreSQL +
vanilla-JS SPA/PWA on Railway. ~25 catalogued user features across 8 areas, shipping
3–5/week through late May 2026. The **unified "86" AI agent is the centerpiece**.
**Voice today is dictation only** (speech→text); 86 does **not** speak back.

---

## 2. Built & shipped (by area)

- **Photos** — viewer + side panel, comments, tag picker, **annotate-in-place** (vector strokes), tile-size density. *(complete)*
- **Reports** — **8 templates** (Walkthrough, Daily Log, Weekly Progress, Engineer's, Submittal, Punch List, Pre-Con, CO Justification), 5 section layouts, **8 style packs**, per-template cover pages, searchable list. *(complete)*
- **Schedule** — day-at-glance sheet, mobile drawer. *(partial — no in-tab scheduling assistant yet)*
- **Jobs & Estimating** — estimate builder (lines/groups/alternates/scope/markup), **Change Orders**, edit-gate, live totals chip, WIP node graph ("Windermere"), QB cost import. *(substantial)*
- **Org / multi-tenant** — orgs, roles+capabilities, org invites, internal users directory, My Files, per-org branding (incl. map pins). *(partial — RBAC still coarse)*
- **AI (86)** — see §3. *(core complete)*
- **Mobile / Field** — Field Tools (calculators/forms), printouts. *(partial — small catalog, no custom-tool UI)*
- **Compliance (Wave 3)** — COI / license / lien-waiver / WC cert tracking. *(beta — expiration alerts on hold)*
- **Maps** — Google Maps, typed teardrop pins (lead/service/reno/wo/job/project), geocoding on write. *(complete; `prospect` pin + heat layer planned — see CRM plan)*

---

## 3. The "86" AI agent (crown jewel)

**One unified agent** across 5 surfaces (estimate / job WIP / lead intake / client
directory / admin), backed by Anthropic **Sessions API v2** with a **rolling
per-user thread** + server-side compaction (~150k tokens), default **Claude Opus 4.8**.

- **Write actions** are **approval-gated** via "reviewable payload files" — 86 proposes a diff card, you approve/reject, then it applies. An **auto-mode** runs low-risk line/scope edits inline.
- **Read tools** auto-apply (materials + purchase history, subs, clients, leads, past estimates/lines, jobs, WIP rollup, job graph, web search, project photos, org settings).
- **Memory** — `remember()` saves facts/decisions (org+user scoped), auto-recalled in the system prompt. Per-client `agent_notes` compound across sessions.
- **5 background "staff" watchers** registered — `86-pm`, `86-estimator`, `86-directory`, `86-scheduler`, `86-sales` — scheduled, scope-filtered, emit approval payloads. *(installed but not yet surfaced to users.)*

---

## 4. Voice — current vs. target (active focus)

**Shipped (2026-05-26 "Voice input"):** dictation / speech-to-text via the browser
**Web Speech API** — one shared helper (`js/voice-input.js`, `window.p86VoiceInput.wire`)
on the **86 chat mic** and **walkthrough photo-caption mic**. Silence watchdog
(3s chat / 5s walkthrough); reverted to a simple idempotent algorithm ("Version A")
after a mobile double-speak bug. **Voice in → text out.**

**Missing for real "voice chat":**
- 86 **speaking back** (no text-to-speech / `speechSynthesis` / audio output anywhere — confirmed absent, not even a stub or flag).
- A **hands-free turn-taking loop** (talk → 86 answers aloud → auto-listen).
- (optional) **low-latency realtime** audio + barge-in.

**Roadmap options:**
- **A — Browser-native loop (fast):** add `speechSynthesis` to speak replies + auto-listen + a "voice mode" toggle, on top of existing dictation + streaming chat. Small build, free. Robotic voices, some mobile-Safari TTS quirks.
- **B — Premium streaming voice:** server-side high-quality TTS (e.g. ElevenLabs/Deepgram) and/or a realtime voice pipeline with barge-in. Best UX; more build + per-minute cost.
- **C — Phased (recommended):** ship A to prove the interaction loop (cheap because the pieces exist), then swap the TTS/STT layer to B behind the same "voice mode" UI.

---

## 5. Partial / in-progress

- **Thinking-summary UI** — server streams Opus 4.8 summarized thinking; the collapsible UI to render it is pending.
- **Staff watchers visibility** — 5 agents installed + scheduled, but not yet shown to users; scope/prompt tuning ongoing.
- **Job-graph write APIs** — `create_node` / `wire_nodes` / `assign_qb_line` being added on top of the Phase 3 foundation.
- **Custom Tier-3 staff agents** — spawn infrastructure (`request_create_staff_agent`) built; per-org rollout not deployed.
- **Compliance expiration alerts** — on hold pending the maintenance-clock feature.
- **RBAC granularity** — roles/capabilities exist but permissions are still coarse.

---

## 6. Planned / not started

- **Property-Intelligence CRM** (current clients + scored Central-FL prospects + lead
  heat map). Fully designed in **`docs/PROJECT86_CRM_PLAN.md`**; blocked on engine
  **Phase 0** (`agx-property-intel` must emit lat/lng + a stable join key).

---

## 7. Open questions / unknowns

- **"Rolling 86" and "BugSec"** — referenced as workstreams/sessions but appear in **no**
  repo, branch, commit, or code. Only two repos exist (`agx-wip-tracker`,
  `agx-property-intel`). Need John to identify them so their plans can be traced.
- **Voice direction** — confirm target (A / B / C above).

---

## Appendix — key files

- Feature catalog (source of truth for shipped): `server/feature-catalog.js`
- 86 agent core: `server/routes/ai-routes.js`, `server/routes/admin-agents-routes.js`, `js/ai-panel.js`
- Voice: `js/voice-input.js`
- Sessions/turn context: `ai-routes.js` (`buildTurnContext`, `resolveSessionForChat`)
- Maps: `js/map-pins.js`, `js/projects-map.js`, `server/geocoder.js`
- CRM integration plan: `docs/PROJECT86_CRM_PLAN.md`
