# Project 86 — Property-Intelligence CRM Integration Plan

**Status:** living draft (v1) · **Last updated:** 2026-06-14

Goal (John's words): pull intelligence on our **current clients** *and* on every
multifamily property in Central Florida we cover or that sits **near a property
we already work**, list those as **scored prospects** with **lead heat maps based
on their reviews and needs**, and fold all of it into the **client system so
Project 86 becomes a robust CRM that's ahead of the curve.** QuickBooks is **not**
involved.

Two repos, one platform:
- **`agx-wip-tracker`** — Project 86 itself (project86.net). The CRM core / system of record.
- **`agx-property-intel`** — the intelligence engine that discovers + scores apartment complexes.

---

## 0. TL;DR — what changed once we could read the real code

The first version of this plan was written without access to `agx-wip-tracker`,
so it recommended building a new datastore, inventing a pipeline, and standing up
a Leaflet heat map. Reading the actual platform flips that: **most of it already
exists.** This is mostly a *feed-and-extend* job, not a *build-from-scratch* job.

**Already built — do NOT rebuild:**

| Earlier plan assumed we'd need… | Reality in Project 86 |
| --- | --- |
| A new datastore (Supabase/Postgres) | **PostgreSQL already runs on Railway** (`server/db.js`, `pg` driver) |
| To invent a "pipeline status" to make it a CRM | **`leads` already has a 6-stage pipeline**: `new → in_progress → sent → sold \| lost \| no_opportunity`, with `confidence`, `estimated_revenue_low/high`, `projected_sale_date`, `salesperson_id` (`server/db.js:749-790`) |
| A property-management client schema | **`clients` is already BT-style property-mgmt** — `company_name`, `community_name`, `market`, `property_address`, `community_manager`/`cm_email`/`cm_phone`, `maintenance_manager`/…, `parent_client_id` (HOA/PM trees), `agent_notes` JSONB fed to the AI (`server/db.js:661-738`) |
| A Leaflet heat map from scratch | **Google Maps is already wired** with typed teardrop pins (`lead/service/reno/wo/job/project`), per-org pin config, and a geocoder that fills `geocode_lat/lng` on write (`js/map-pins.js`, `js/projects-map.js`, `js/maps-loader.js`, `server/geocoder.js`) |
| A way to act on leads | **Estimate builder + proposal/PDF already exist** (`server/routes/estimate-routes.js`, `js/estimate-editor.js`, `js/proposal.js`) |
| A way to automate outreach | **The "86" AI already mutates entities via tool use and reads client `agent_notes`** (`server/routes/ai-routes.js`) |

**So the real work is narrow:** make the engine emit coordinates, pipe its scored
output into the Postgres Project 86 already has (as **prospects** + an
**enrichment blob**), and add a **heat layer + a prospect pin** to the map that's
already on screen.

---

## 1. The shape of the integration

```
                            agx-property-intel (Python, weekly)
            discovers + scores Central FL multifamily from
            Google reviews · permits · county appraiser · Sunbiz owners
                                   │
                                   │  slim JSON export  (the "contract")
                                   │  address + parcel key, lat/lng, score, needs, owner
                                   ▼
                  ┌────────────────────────────────────────┐
                  │  Project 86  (Express + Postgres)        │
                  │                                          │
                  │  import route  ──▶  prospects table      │
                  │                ──▶  property_intel JSONB  │
                  │                      on clients / leads   │
                  │                                          │
                  │  proximity + ownership-lookalike queries │
                  └────────────────────────────────────────┘
                                   │
                                   ▼
                     project86.net UI (already built, extended)
        Google map + heat layer · prospect cards · "Promote to lead"
                 · 86 AI outreach drafts · maintenance-clock alerts
```

The engine stays a **publisher**; Project 86 stays the **owner of its own data**.
The "shared data contract" the first plan agonized over shrinks to a single,
well-defined **import feed**.

---

## 2. Data model changes (in the Postgres that already exists)

Project 86 already stores complex data as JSONB blobs on normalized rows (jobs,
estimates, change orders all do this). We follow that pattern.

### 2.1 `prospects` — machine-discovered, scored, not-yet-worked properties
A new org-scoped table, mirroring the columns of `leads` that matter for mapping
and triage, plus the engine's score:

- `id TEXT` (pk), `organization_id INTEGER`
- `property_name`, `street_address`, `city`, `state`, `zip`, `county`, `market`
- `geocode_lat`, `geocode_lng`, `geocode_status`  *(same shape as leads/jobs)*
- `lead_score NUMERIC`, `priority TEXT` (`hot|warm|cold`)
- `owner_entity TEXT`, `registered_agent TEXT`  *(denormalized from Sunbiz for fast lookalike joins)*
- `source TEXT DEFAULT 'property-intel'`, `intel_key TEXT UNIQUE` *(stable join key — see §3)*
- `property_intel JSONB` — the full enrichment blob (review_issues, permits, owner_info, corporate_info, score_breakdown)
- `status TEXT DEFAULT 'new'`, `promoted_lead_id TEXT` → `leads(id)` *(set when promoted)*
- `first_seen`, `last_updated TIMESTAMPTZ`

Why a separate table (recommended): the engine will produce **hundreds** of cold,
machine-generated rows. Keeping them out of the human `leads` board until someone
acts ("**Promote to lead**") keeps the salesperson's pipeline clean. *(Fork — see §7.)*

### 2.2 `property_intel JSONB` on existing `clients` (and optionally `leads`)
The same enrichment blob attached to a **current client's** property by address /
parcel match — so a client card shows its review complaints, roof age, and owner
chain. This also gives the 86 AI real context to reason about (alongside the
existing `agent_notes`).

### 2.3 `prospect` pin type
Add `prospect` to the pin library (`js/map-pins.js` `DEFAULTS`) and to the per-org
override slot (`organizations.branding.map_pins`), so prospects render distinctly
from current-client pins and admins can recolor them.

No new datastore. No schema rewrite. Two tables/columns and a pin type.

---

## 3. The ingestion feed (the real "contract")

The engine's per-property profile is already rich (~52 fields, assembled in
`agx-property-intel/modules/database.py:122-169`). We **don't** import all of it
raw; we publish a slim, stable export and keep the full blob as enrichment.

**Engine-side changes (Phase 0, in `agx-property-intel`):**
1. **Emit `lat`/`lng`.** Today the engine stores address + Google `place_id` but
   never extracts coordinates (confirmed — no geocoding in the engine). This is the
   one true gap; coordinates come essentially free from the Places data already
   fetched. *Hard prerequisite for any map work.*
2. **Emit a stable `intel_key`** — normalized address + `parcel_id` — so re-imports
   upsert instead of duplicating.
3. **Publish a slim JSON export** (`data/export.json`) alongside the existing
   `data/properties.json`: `{ intel_key, name, address, county, lat, lng,
   lead_score, priority, needs[], owner_entity, registered_agent, profile_url }`,
   plus the full `property_intel` blob.

**Project 86 side (Phase 1, in `agx-wip-tracker`):**
- `POST /api/admin/property-intel/import` (system_admin, audit-logged) — accepts the
  export, **upserts** `prospects` by `intel_key`, and **backfills** `property_intel`
  onto any `clients` whose address/parcel matches.

> ⚠️ **Live vs demo data.** The engine's weekly GitHub Action currently runs
> `run.py --demo` — so today's published dashboard is **demo properties, not real
> scans**. Making "current/nearby properties" real means wiring the Google Places
> key into the weekly job and accepting pay-as-you-go scan costs. *(Decision — §7.)*

---

## 4. The "ahead of the curve" prospecting — now just queries

Because clients/jobs already carry `geocode_lat/lng` and prospects will too, the
two signature features are simple Postgres queries once both live in the same DB:

**4.1 Geographic proximity** — "prospects within N miles of a current client or an
active job." Haversine in SQL now; the schema is already PostGIS-ready (`ST_*`
noted in the codebase) if we want true spatial indexing later. Output tag:
*"hot prospect, 2.1 mi from active job #RV-1042."*

**4.2 Ownership lookalikes (the secret weapon)** — the engine already captures
`corporate_info.entity_name` + `officers[]` per property. Match a current client's
owner entity/officers against every prospect's `owner_entity` → "you already do
work for this LLC's portfolio; here are their other 6 buildings." A warm intro,
not a cold call. Pure join, no new data source.

Both feed one ranked prospect list, scored 0–100 by the engine's existing model
(reviews 0-40 · permits 0-30 · building age 0-10 · size 0-10 · reachability 0-10;
`agx-property-intel/modules/scorer.py:33-173`).

---

## 5. The lead heat map — extend, don't rebuild

On the **existing** Google Maps surface (`js/projects-map.js`):
- **Two pin classes:** current clients (solid, one color) vs. prospects (heat-shaded
  by `lead_score`), so "hot prospect near an existing client" is visible at a glance.
- **Heat/weight layer** weighted by `lead_score` (Google Maps visualization heatmap
  layer, or graduated pin size/color by `priority` tier 🔥/🟡/🔵).
- **Filters:** county · issue type ("show every roofing-complaint cluster") · heat
  tier · "near a client/job." Issue categories already exist in the engine's
  `review_issues[].category` (Roofing & Water, Foundation & Structural, Siding &
  Stucco, Parking & Paving, Mold & Moisture, General Neglect).
- **Needs clusters:** spatial aggregation of complaint categories → a neighborhood
  lighting up with roof-leak reviews becomes a visible target zone.

Reuses the existing maps loader, geocoder, and per-org pin branding.

---

## 6. How you interact with it (the CRM workflow)

1. **See it on the map / hot list** — prospects shaded by heat, clustered by need,
   near your existing work.
2. **Open a prospect** — card shows the *actual* complaint and quoted review
   ("tenants reporting roof leaks since 2022"), roof/paint permit age, owner chain.
3. **One-click "Promote to lead"** — copies the prospect into the existing `leads`
   pipeline (`new → in_progress → …`), preserving the enrichment blob.
4. **Estimate + propose in-house** — straight into the existing estimate builder →
   proposal/PDF. No QuickBooks; the estimate loop stays inside Project 86.
5. **Let 86 work it** — the AI (already wired for tool use + reads client context)
   drafts tailored outreach from the specific complaint, fires **maintenance-clock
   alerts** (a client's roof crossing 15 yrs, a new hot prospect near an active
   job), and can schedule inspections via the connected Google Calendar / store
   photos in Drive.

---

## 7. The only real decisions

1. **Where prospects live** — *(recommended)* a dedicated `prospects` table with a
   "Promote to lead" action, keeping cold machine rows off the sales board; **vs.**
   reuse `leads` with `status='prospect'` (simpler, but clutters the pipeline).
2. **Ingestion mechanism** — *(recommended)* engine publishes JSON → Project 86
   import route (decoupled, engine never touches prod DB); **vs.** engine writes
   directly into Project 86's Postgres (tighter coupling).
3. **Live vs demo data** — keep planning against demo data for now, **or** wire the
   real Google Places key into the weekly scan so prospects are real Central FL
   properties (costs money per scan).

---

## 8. Phased roadmap

| Phase | Repo | Deliverable |
| --- | --- | --- |
| **0** | property-intel | Engine emits `lat/lng` + stable `intel_key`; publish slim `data/export.json` (the contract) |
| **1** | wip-tracker | `prospects` table + `property_intel` JSONB column + `import` route; backfill enrichment onto existing clients |
| **2** | wip-tracker | Proximity + ownership-lookalike read endpoints |
| **3** | wip-tracker | Map: `prospect` pin type + heat layer + need/tier/county filters |
| **4** | wip-tracker | Prospect list/board + prospect card (complaints) + "Promote to lead" |
| **5** | wip-tracker | 86 automation: AI outreach drafts, maintenance-clock alerts, Calendar/Drive tie-ins |

**Highest-leverage starting point:** Phase 0 + the Phase 1 schema — once real,
geocoded, scored prospects are upserting into Postgres, every downstream phase is
conventional Project 86 work (a route, a list view, a map layer).

---

## Appendix — key files

**Project 86 (`agx-wip-tracker`)**
- DB schema: `server/db.js` — leads `749-790`, clients `661-738`, organizations `69-89`, jobs `372-595`
- Map: `js/map-pins.js`, `js/projects-map.js`, `js/maps-loader.js`; geocoder `server/geocoder.js`
- Per-org pin config: `organizations.branding.map_pins`
- Estimates: `server/routes/estimate-routes.js`, `js/estimate-editor.js`, `js/proposal.js`
- AI: `server/routes/ai-routes.js` (+ client `agent_notes`)

**Engine (`agx-property-intel`)**
- Profile schema: `modules/database.py:122-169`
- Scoring: `modules/scorer.py:33-173`
- Coverage (7 Central FL counties, 17 areas): `config.py:20-99`
- Sunbiz owners/officers: `modules/sunbiz.py`
- Weekly job (currently `--demo`): `.github/workflows/scan.yml`
