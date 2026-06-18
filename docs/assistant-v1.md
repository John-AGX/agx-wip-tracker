# Assistant v1 — build spec (Rolling86)

**Owner:** John · **Status:** approved to build · decisions locked
All `file:line` from the 2026-06-18 recon — re-confirm before editing (lines drift).

## The shape (locked)

One conversational door (the mobile/desktop "86" button). Three agents behind it:

```
Assistant (Haiku)  ── hosts every conversation; full read/write (bounded by the
   │                   user's role); full builtin toolset; memory. Personal layer:
   │                   calendar, tasks, reminders, daily summary, "jobs near me".
   ├─ scribe_write ─────────────►  Scribe  ── the shared write/execution worker.
   │  (menial writes)                │         Authors the payload, dry-runs it,
   │                                 │         returns the inline approval card.
   └─ escalate_to_86 ─────────────►  86 (Opus)  ── deep reasoning: estimating, WIP,
                                      │            job-costing, budgets, scope.
                                      ├─ scribe_write ──► Scribe (business writes)
                                      └─ baton: reasons when the heavy lift is done
                                         and hands control BACK to the Assistant.
```

- **Assistant is the default host.** Cheap Haiku handles personal/light turns. It
  escalates to 86 only when the turn needs Opus-level reasoning — not because it
  lacks a tool (it has the full surface). Escalation = a handoff (the Sessions API
  pins a session to one model, so "become 86" is a handoff, not a costume change).
- **86 reasons when to hand the baton back.** At the end of its turn 86 emits a
  structured `route_next: 'assistant' | 'stay'`. Flag flips the session's
  `activeAgent` for the NEXT user message — no extra latency, no flapping. Bias:
  hand back when in doubt (lingering on Opus is the costly error; an early hand-back
  self-corrects — the Assistant just re-escalates, one cheap hop, shared thread so
  no lost context).
- **Scribe = shared hands.** Both the Assistant and 86 delegate writes to it. It
  owns the write/execution tool surface and "touches everything."

## Capability + safety (non-negotiable)

- **Capability is bounded by the acting user's role.** The agent acts AS the user,
  never above. John's assistant = full (system admin); a field-crew member's
  assistant inherits field-crew caps automatically. This is what makes "everyone
  gets one" safe — convenience is elevated, permissions are not.
- **Org-scoping always on** (`assertTargetOrg` in payload-dispatcher.js + per-org
  agent registration). No cross-tenant reads/writes.
- **Approval card is a SEPARATE lever from capability.** Risk-tiered:
  - low-stakes / personal / internal (reminders, the user's own tasks, private
    notes) → apply with light/undo friction, no card.
  - shared-business or outward-facing (job/estimate/client edits, sending an email,
    an Outlook invite to others) → the inline Approve/Reject card (already built).
- **Email/observed content is data, not instructions** (Outlook phase): the
  assistant summarizes/extracts but never acts on instructions found in mail;
  outward actions (send/delete/rules) always gated.

## Current wiring (recon 2026-06-18) — what changes

- `AGENT_SYSTEM_BASELINE` (admin-agents-routes.js ~1932-2133): keys `job` (86),
  `scribe`, staff watchers. → ADD `assistant` baseline (host identity + lane
  discipline: "fully capable, but hand deep business judgment to 86").
- `modelForAgentKey` (~2327): `SCRIBE_MODEL='claude-sonnet-4-6'`. → ADD
  `ASSISTANT_MODEL='claude-haiku-4-5'` with the same hardlock.
- `customToolsFor` (~2350): scribe = emit_payload_file only; job = ROUTER_TOOL_NAMES.
  → ADD `assistant` allowlist: reads + memory + navigate + `scribe_write` +
  `escalate_to_86`. (86 + scribe unchanged; both already use scribe_write.)
- `builtinToolsetFor` (~2312): all agents get `agent_toolset_20260401` except
  scribe. → assistant gets it too.
- `collectSkillsFor` (~2184): scribe skips skills. → assistant gets org skills.
- `/managed/:key/sync` allowlist (~4254): add `assistant`.
- `ensureManagedAgent` / `managed_agent_registry` / bootstrap: register `assistant`
  per org (additive; no schema change).
- ai-routes.js: `driveScribeWrite`/`execScribeWrite`/`scribe_write` unchanged (both
  callers route through them). → ADD `escalate_to_86` tool + handler + the
  `route_next` baton signal in 86's turn finalize. NEW per-agent dispatcher for the
  assistant (mirrors `make86OnCustomToolUse`).
- Scribe write coverage: today `PAYLOAD_OPS_SCHEMAS` = client/estimate/job/lead/
  schedule/system/report. The assistant's menial writes need **task** + **reminder**
  → extend the payload dispatcher so the Scribe can write those.

## Build sequence (ship + verify each)

1. **`[CODE]` Register the Assistant agent.** Baseline + Haiku model + toolset
   (reads/memory/navigate/scribe_write/escalate_to_86) + builtin toolset + skills +
   sync allowlist + bootstrap. Verify: `/managed/audit` shows `assistant` registered,
   Haiku, expected tool_count. (Additive — does not touch 86 or scribe.)
2. **`[CODE]` Escalation handoff.** `escalate_to_86` tool on the assistant →
   `driveEscalateTo86(intent, ctx)` wrapping the sub-session driver (mirror
   driveScribeWrite). Assistant passes the thread frame; 86 reasons, returns.
   Verify: assistant escalates a job-costing question, 86 answers in-thread.
3. **`[CODE]` Baton hand-back.** 86 emits `route_next`; persist `activeAgent` on the
   session row; client routes the next user message accordingly + a subtle UI cue.
   Verify: deep job thread stays on 86, then a "remind me" hands back to assistant.
4. **`[CODE]` Chat entry = assistant by default.** The 86 button opens an assistant-
   hosted session. Single thread; the active brain answers each turn.
5. **`[DATA]` Scribe write coverage: tasks + reminders.** Extend PAYLOAD_OPS_SCHEMAS
   + dispatcher + PAYLOAD_APPLY_CAP. Risk-tier the approval gate (personal = low
   friction). Verify: assistant creates a reminder via Scribe, no nag-card.
6. **`[CODE]` v1 personal toolset.** Calendar (internal schedule), tasks, daily
   summary, "jobs near me" (geolocation opt-in + job geocodes). Reuse tasks-routes /
   schedule. Proactive daily summary via the existing scheduler + push.
7. **`[LATER]` Outlook / Microsoft Graph.** One per-user OAuth unlocks mail +
   calendar. Delegated auth (each user signs in; we never handle credentials).
   Read/summarize/extract free; send/calendar-invite/rules gated.

## Parking lot
- Sticky-routing tuning (only if real sessions flap).
- Whether the assistant gets its own native Skills (playbooks) vs. inheriting 86's.
- Per-user assistant context builder (calendar/location/tasks) — the one net-new
  context layer; reuse `buildTurnContext` patterns.
