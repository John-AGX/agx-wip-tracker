# Client Page Dashboard — spec (living draft)

**Status:** draft v1 · **2026-06-14** · author: affectionate-feynman · no code yet — shape this first.
Companion to `docs/PROJECT86_CRM_PLAN.md` (this is the client-facing UI realization of that plan).

Goal (John): make the **client page a real CRM dashboard** — "robust, ahead of the curve" —
starting from what links cleanly today and layering the property-intel enrichment later.

---

## 1. Current state (grounded)

The client "page" is today a **modal edit form** (`#clientEditorModal`, `index.html:2754-2903`),
opened by `openEditClientModal()` (`js/clients.js:784-807`). Sections (fieldset + edit-gate):
Identity · Primary Contact · Mailing Address · Property & Community · **CAM (community manager)** ·
**Maintenance Manager** · Notes · **Agent Notes** (AI durable bullets) · **Tasks** (lazy-mounted,
`p86Tasks`) · **Files** (lazy-mounted, `p86Explorer`).

**There are no metrics, no map, and no activity feed on it today.**

## 2. The data-linkage reality (the constraint that shapes everything)

| Entity → Client | Link today | Dashboard impact |
| --- | --- | --- |
| **Leads** | real `leads.client_id` FK | ✅ per-client leads, pipeline $, lead map all buildable now |
| **Tasks / Files / Agent-notes** | polymorphic by client id | ✅ activity feed buildable now |
| **Jobs** | **none** — `jobs.data.client` is freeform **name text**, not an id | ❌ jobs/WIP/contract-value per client need a `jobs.client_id` link first |
| **Estimates** | **none** — no `client_id`; `data.client` is freeform | ❌ same |
| **Client property location** | `property_address` text only; **clients are not geocoded** | ❌ property pin on map needs client geocoding |

**Takeaway:** leads + activity + contacts + a lead map are buildable immediately; jobs/financials
and the property pin need foundational fixes (a job↔client FK; client geocoding).

## 3. The dashboard — phased

### Phase 1 — buildable now (no blockers)
A **"Dashboard" section** on the client page (lazy-mounted, mirroring how Tasks/Files mount —
low friction). Contents:
- **Metric strip:** Open Leads (count) · **Pipeline value** (Σ `estimated_revenue_low/high` of open leads) · Recent activity (count, last 7d) · one-tap **CAM contact** (call/email badge).
- **Per-client lead map:** this client's geocoded leads, reusing `js/entities-map.js`; click pin → existing lead modal.
- **Activity feed:** latest tasks + agent notes + file uploads (3–5 items).

### Phase 1.5 — foundational unlock (one migration, big payoff)
Add **`jobs.client_id`** (FK) + backfill by matching `jobs.data->>'client'` to `clients.name`/`short_name`.
Then the dashboard gains: **Job count · WIP / contract value · won-from-lead conversion**. Makes the
cost-backfilled jobs (`claude/project-costs-backfill`) first-class CRM children. *(Name-match is
fragile → include a small "reconcile unmatched" view.)*

### Phase 2 — ahead of the curve (blocked on engine Phase 0 + client geocoding)
Property-intel enrichment in the same dashboard: **review complaints, roof/permit age, lead
score + heat, nearby prospects, ownership lookalikes** (see `PROJECT86_CRM_PLAN.md`). Needs:
(a) engine emits lat/lng + join key, (b) clients get geocoded.

## 4. UI placement — decision
- **Option B (recommended for Phase 1):** new collapsible **`<fieldset id="clientEditor_dashboardHost">`**
  in the existing modal at `index.html:~2862` (before Notes), lazy-mounted. Zero restructuring.
- **Option A (later):** promote the client modal to a **full-page tabbed view** (Details · Dashboard ·
  Tasks · Files) via the router. Better long-term home for a rich CRM dashboard; more work.

Recommendation: ship the dashboard in-modal now; promote to a full page once it earns the space.

## 5. Endpoints to add (`server/routes/client-routes.js`, org-scoped + access-checked)
- `GET /api/clients/:id/summary` → `{ openLeads, leadCount, pipelineValue, activityCount, cam:{name,email,phone} }`
- `GET /api/clients/:id/leads` → this client's leads incl. `geocode_lat/lng` + status
- `GET /api/clients/:id/activity?limit=5` → merged tasks + agent-notes + file-uploads, newest first
- *(Phase 1.5)* extend `/summary` with `jobCount, wipValue, contractValue` once `jobs.client_id` exists

## 6. Files
- **New:** `js/clients-dashboard.js` — `window.p86ClientsDashboard.mount(host, clientId, name)`
- **Modify:** `js/clients.js` — call `mountClientDashboard(c)` in `openEditClientModal()` (pattern: `mountClientTasksPanel` at `:745-751`)
- **Modify:** `index.html` — add the `clientEditor_dashboardHost` fieldset (~`:2862`) + script include
- **Modify:** `server/routes/client-routes.js` — the 3 endpoints above
- *(Phase 1.5)* `server/db.js` — `ALTER TABLE jobs ADD COLUMN client_id` + backfill

## 7. Open decisions for John
1. **In-modal dashboard now**, or go straight to a **full-page client view**?
2. **Include the jobs↔client link (Phase 1.5) now**, or ship Phase 1 leads-only first?
3. **Metric set** — are Open Leads / Pipeline $ / Activity / CAM the right four, or swap any?
4. **Map scope** — leads only (now), or also show the client's property pin (needs client geocoding)?

---

## Appendix — key files
- Client modal: `index.html:2754-2903`; open/mount: `js/clients.js:784-807`, tasks-mount pattern `:745-751`
- Client API: `server/routes/client-routes.js:34-66`; editable fields `js/clients.js:667-679`
- Map: `js/entities-map.js`, `server/routes/map-routes.js:45-124`
- Reusable metric/card patterns: `js/app.js:847-1000` (`paintSummaryToday`)
- CRM vision: `docs/PROJECT86_CRM_PLAN.md`
