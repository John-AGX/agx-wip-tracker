# Multi-market model — spec (P86)

Goal (John, 2026-07-28): AGX operates as a **truly multi-market company** —
**Tampa · Orlando · Denver · Arizona · Texas** — with one Project 86 instance.

## Current state (verified 2026-07-28)
- `market TEXT` column exists on **jobs** and **leads** only (`server/db.js` ~907, ~996).
- The picker is **hardcoded** to `['Tampa','Orlando']` (`js/jobs.js:2639`); seed data in
  `js/app.js` uses those two strings.
- No markets table, no scoping, no per-market rollups, no market-aware crews/subs/pricing.
- Timezone is currently an **org-level** anchor (`organizations.timezone`) — the
  "multi-market anchor" comment in db.js. That breaks the moment Denver (MT) and
  Arizona (no DST!) and Texas (CT) run under one org.

## The call: market is a DIMENSION, not a view filter
A saved-view filter can't give per-market P&L, can't stop a Tampa crew being scheduled in
Denver, and can't localize tax/licensing/time. So: **first-class `markets` table + a
`market_id` FK on every market-owned record**, with the UI expressed as ONE global switcher.

Think of it as a middle tier: `organization → market → job`. Org stays the tenant boundary
(billing, auth); market is the operating unit inside it.

### `markets` table
`id, organization_id, name, code (TPA/ORL/DEN/PHX/TEX), state, timezone (IANA),
address, phone, license_no, sales_tax_rate, labor_rate_default, color, active, sort`

Seed: Tampa `America/New_York` · Orlando `America/New_York` · Denver `America/Denver` ·
Arizona **`America/Phoenix`** (no DST — must be its own zone, not "Mountain") ·
Texas `America/Chicago`.

### `market_id` FK on (additive, nullable, backfilled):
jobs · leads · estimates · clients · subs · purchase_orders · bills · invoices ·
change_orders · receipts (cost inbox) · projects · tasks · calendar_events · users
(home market) · materials/assemblies (market pricing overrides) · email_folders (optional).

Backfill: existing rows → Tampa or Orlando from the current `market` text; keep the old
TEXT column one release as a shadow, then drop.

## UI: the global market switcher
- **Sidebar header switcher** (next to the org logo lockup): `All markets ▾ | Tampa |
  Orlando | Denver | Arizona | Texas`. Selection persists in localStorage +
  user profile (`users.default_market_id`), and **scopes every list, map, dashboard,
  and KPI** — same mechanism as the existing saved-views/filter layer.
- **"All markets"** is the roll-up view (John/exec): every list gains a **Market column**
  + market color chip; Summary/Insights show a **per-market comparison** row
  (revenue · backlog · margin · WIP · lead conversion).
- Non-exec users default to (and are soft-scoped to) their home market.
- Maps: market switcher re-centers + filters pins; each market gets its own color.

## What market actually changes (why it's not cosmetic)
1. **Money** — per-market P&L, backlog, margin; per-market sales-tax rate on estimates;
   per-market default labor rate + burden.
2. **Time** — reminders/cron/My Day resolve to the **market's** timezone, not the org's.
   (Extends the existing per-org TZ work; Arizona is the trap — no DST.)
3. **People** — users + subs carry a home market; assignment pickers filter to the job's
   market (with an explicit "out of market" override).
4. **Pricing** — materials/assemblies can carry a per-market cost override; the resolver
   falls back org-wide when no market row exists.
5. **Compliance** — license #, permit authority, insurance cert requirements per market.
6. **Numbering** — job/estimate numbers prefixed by market code (TPA-1042, DEN-0007).

## Build order
- **M1 — Spine**: `markets` table + seed 5 + `market_id` FK on the core entities
  (jobs, leads, estimates, clients, subs) + backfill from the TEXT column + market CRUD
  (admin → Organization). Replace the hardcoded `['Tampa','Orlando']` picker with a
  markets-table lookup **everywhere** (grep for the literal).
- **M2 — Switcher + scoping**: global market switcher, persisted; every list/map/KPI
  reads it; Market column + color chip; "All markets" roll-up.
- **M3 — Money**: per-market P&L + comparison on Summary/Insights; per-market tax +
  labor-rate defaults flowing into estimates.
- **M4 — Time + people**: market timezone drives reminders/My Day/cron (Arizona!);
  users/subs home market + assignment filtering.
- **M5 — Pricing + compliance**: per-market material/assembly cost overrides; license,
  permit authority, insurance requirements per market; market-prefixed numbering.

## Constraints
- Org remains the tenant/security boundary — **market is NOT a security boundary**; never
  replace `organization_id` checks with market checks (see the AUDIT Wave A org-scoping).
- Additive + nullable FKs, backfill, dual-read for one release. No destructive migration.
- Bump `?v=` for edited js in the same commit (`reference_cache_buster`).
- Arizona = `America/Phoenix` (no DST). Do not fold it into Denver/Mountain.
