const { Pool } = require('pg');
const bcrypt = require('bcryptjs');

// Railway internal hostnames don't terminate TLS, so don't try to SSL-handshake them.
// Public proxy URLs (and most other hosted Postgres) require SSL in production.
const url = process.env.DATABASE_URL || '';
const useSsl = process.env.NODE_ENV === 'production' && !url.includes('.railway.internal');

const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false
});

async function initSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      email TEXT UNIQUE NOT NULL,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'pm',
      active BOOLEAN NOT NULL DEFAULT true,
      -- JSONB notification opt-out map. See server/email-templates.js
      -- for the event keys. Default empty {} = everything enabled
      -- (opt-out model). Each key, when set to false, suppresses that
      -- event's email for this user.
      notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Backfill the column on existing deployments. Safe re-run.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- last_seen_at is bumped by requireAuth on each authenticated
    -- request (throttled to once per 30s per user). Drives the
    -- "users online now" metric on Admin → Metrics. NULL = never seen.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_users_last_seen_at ON users(last_seen_at) WHERE last_seen_at IS NOT NULL;
    -- Phone number used by the SMS scheduling agent to identify the
    -- texter. Stored in E.164 format (+15555551234) so the inbound
    -- webhook can match it to a user by exact equality without
    -- formatting heuristics. Nullable — most office users won't set it.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS phone_number TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_number ON users(phone_number) WHERE phone_number IS NOT NULL;
    -- Per-user IANA timezone OVERRIDE (e.g. 'America/Chicago'). NULL =
    -- inherit the org timezone. Lets a crew member who works a different
    -- market than the org's home base get reminders in THEIR local time.
    -- Resolution order (server/timezone.js resolveTz): user → org → default
    -- ('America/New_York'). Drives the morning-gate on reminder digests and
    -- the timezone every reminder/notification email renders dates in.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS timezone TEXT;
    -- Assistant v1 rollout — per-user OVERRIDE of which AI hosts the in-app
    -- chat: 'assistant' (Haiku personal aide) or 'job' (86/Opus). NULL =
    -- use the role default in resolveSessionForChat (office roles —
    -- system_admin/admin/corporate/pm — host on the Assistant; field crew +
    -- subs stay on 86 until the role-permission smoke-test rig lands).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS ai_host_agent_key TEXT;
    -- Job title (free text, e.g. "Project Manager") — shown on the My Account +
    -- user-management cards; self-editable via PUT /api/auth/me. Nullable.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS title TEXT;
    -- users.sub_id (sub portal) is added AFTER the subs table is
    -- created further down so the FK resolves on first run.

    -- ───────────────────────────────────────────────────────────────
    -- Organizations — multi-tenant foundation. Each row = one company
    -- using the Project 86 platform. Today there's exactly one
    -- (AGX Central Florida); the table exists so future signups can
    -- be onboarded without a code change. Each org has:
    --   - slug: stable URL-safe key (e.g. 'agx') — used in admin URLs
    --     and as the suffix when registering per-org Anthropic agents
    --     in Phase 2c (e.g. agent_key='job_agx').
    --   - name: display name (e.g. 'AGX Central Florida').
    --   - description: short marketing-style blurb (used in the
    --     Anthropic agent's description field on registration).
    --   - identity_body: ADMIN-EDITABLE prose composed into the
    --     agent's system prompt at registration / sync time. This is
    --     the org-specific "who 86 is working for" text — the AGX
    --     baseline that used to live hardcoded in
    --     AGENT_SYSTEM_BASELINE.job. Phase 2c moves it here so other
    --     tenants can customize without touching code.
    --   - settings JSONB: catch-all for per-org config (default
    --     markups, web-research caps, etc.) — extended over time.
    --   - archived_at: soft delete. Archived orgs keep their data
    --     but their users can't log in and their agent is
    --     deregistered from Anthropic.
    CREATE TABLE IF NOT EXISTS organizations (
      id SERIAL PRIMARY KEY,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      identity_body TEXT NOT NULL DEFAULT '',
      settings JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_organizations_slug ON organizations(slug) WHERE archived_at IS NULL;
    -- Org branding kit (Wave 6 of email work). JSONB with shape:
    --   { logo_url, primary_color, accent_color, footer_address }
    -- Used by the email block renderer: when an outbound email is
    -- scoped to an org, missing block fields (header logo, button
    -- color, footer address) fall back to the org's branding so all
    -- the org's emails share a consistent look without re-editing
    -- every template.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS branding JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Org's home-market IANA timezone (e.g. 'America/New_York'). Default
    -- US Eastern. This is the multi-market anchor: every time-gated cron
    -- (reminder digests, cert-expiry, weekly digest) and every date/time
    -- rendered in this org's emails resolves against THIS zone unless a
    -- user has set their own override. Adding a new market = create/assign
    -- its org and set this field. Validated as a real IANA zone on save.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS timezone TEXT NOT NULL DEFAULT 'America/New_York';

    -- ── SaaS commercialization scaffold ─────────────────────────────
    -- Subscription state per org. All additive + defaulted, so every
    -- existing row (AGX) becomes plan_key='internal' / status='active'
    -- automatically — the 'internal' plan is unlimited, so the
    -- entitlements layer is a NO-OP until a real (non-internal) plan is
    -- assigned. See server/plans-catalog.js + server/entitlements.js.
    --
    --   plan_key       machine id of the tier (matches plans-catalog).
    --   plan_status    trialing | active | past_due | canceled. Drives
    --                  future suspension logic + the trial-ending cron.
    --   trial_ends_at  when a trial converts/expires (NULL = no trial).
    --   billing        provider-specific junk drawer (Stripe customer +
    --                  subscription ids, payment method last4, etc.) —
    --                  JSONB so wiring Stripe later needs no migration.
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_key      TEXT NOT NULL DEFAULT 'internal';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS plan_status   TEXT NOT NULL DEFAULT 'active';
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS trial_ends_at TIMESTAMPTZ;
    ALTER TABLE organizations ADD COLUMN IF NOT EXISTS billing       JSONB NOT NULL DEFAULT '{}'::jsonb;
    -- Partial index for the future "trials ending soon" / "past_due
    -- sweep" crons — cheap, and only covers the rows those jobs scan.
    CREATE INDEX IF NOT EXISTS idx_organizations_plan_status
      ON organizations(plan_status) WHERE archived_at IS NULL;

    -- Per-org usage counters (SaaS scaffold). ONE row per
    -- (org, metric, period) where period is the 'YYYY-MM' billing month.
    -- recordUsage() in server/usage-meter.js UPSERT-increments these.
    -- We start ACCUMULATING now — before any plan enforces a limit — so
    -- that when billing turns on there's already real usage history to
    -- meter against and to show on an account/usage page. Nothing reads
    -- these for enforcement yet; they're pure accounting.
    --   metric examples: 'ai_messages' | 'email_sends' | 'storage_bytes'
    CREATE TABLE IF NOT EXISTS usage_counters (
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      metric          TEXT NOT NULL,
      period          TEXT NOT NULL,                 -- 'YYYY-MM'
      count           BIGINT NOT NULL DEFAULT 0,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (organization_id, metric, period)
    );
    CREATE INDEX IF NOT EXISTS idx_usage_counters_org_period
      ON usage_counters(organization_id, period);

    -- Email tracking events (Wave 7). One row per open/click recorded
    -- by the tracking pixel + link rewriter. log_id matches the
    -- email_log row's text id. kind = 'open' | 'click'. ip is the
    -- caller's address (IPv4/IPv6 string), user_agent is the UA
    -- header capped at 500 chars. url is the original URL the user
    -- clicked (NULL for opens). Indexed by log_id for fast aggregation.
    CREATE TABLE IF NOT EXISTS email_log_events (
      id           SERIAL PRIMARY KEY,
      log_id       TEXT NOT NULL,
      kind         TEXT NOT NULL,
      occurred_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      url          TEXT,
      ip           TEXT,
      user_agent   TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_events_log
      ON email_log_events(log_id, kind);
    CREATE INDEX IF NOT EXISTS idx_email_log_events_recent
      ON email_log_events(occurred_at DESC);

    -- Email campaigns (Wave 9 — marketing-style bulk sends). One row
    -- per outbound batch. recipient_query is the JSONB filter the org
    -- admin saved on the builder page; we re-resolve it at send time
    -- so a 'send to all active subs' campaign picks up a sub added
    -- after the campaign was drafted. subject + body are the override
    -- shape — empty means use the underlying event's template (the
    -- builder can also pick a 'custom' shape without a backing event).
    -- status lifecycle: draft → scheduled → sending → completed | failed | canceled.
    CREATE TABLE IF NOT EXISTS email_campaigns (
      id              TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      event_key       TEXT,                            -- nullable: NULL = custom
      subject         TEXT NOT NULL,
      body            TEXT NOT NULL,                   -- raw HTML or blocks JSON
      recipient_query JSONB NOT NULL DEFAULT '{}'::jsonb,
      scheduled_at    TIMESTAMPTZ,                     -- NULL = send immediately on POST /send
      status          TEXT NOT NULL DEFAULT 'draft',
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      sent_at         TIMESTAMPTZ,
      total_count     INTEGER NOT NULL DEFAULT 0,
      sent_count      INTEGER NOT NULL DEFAULT 0,
      failed_count    INTEGER NOT NULL DEFAULT 0,
      archived_at     TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_email_campaigns_org
      ON email_campaigns(organization_id, created_at DESC) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_email_campaigns_due
      ON email_campaigns(scheduled_at) WHERE status = 'scheduled' AND archived_at IS NULL;

    -- Per-campaign materialized recipient list. Resolved at send time
    -- (POST /send → resolveRecipients → INSERT … one row per email).
    -- Status: queued → sent | failed. log_id (when sent) links back to
    -- email_log so the analytics rollup can correlate opens/clicks.
    -- params is the per-row interpolation context: {{name}}, {{email}},
    -- {{company}}, {{first_name}}, plus org defaults.
    CREATE TABLE IF NOT EXISTS email_campaign_recipients (
      id            SERIAL PRIMARY KEY,
      campaign_id   TEXT NOT NULL REFERENCES email_campaigns(id) ON DELETE CASCADE,
      email         TEXT NOT NULL,
      name          TEXT,
      params        JSONB NOT NULL DEFAULT '{}'::jsonb,
      status        TEXT NOT NULL DEFAULT 'queued',
      sent_at       TIMESTAMPTZ,
      log_id        TEXT,
      error         TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_email_campaign_recipients_campaign
      ON email_campaign_recipients(campaign_id, status);


    -- Seed AGX as the sole org. Idempotent — no-op if a row with
    -- slug='agx' already exists. The identity_body matches what
    -- AGENT_SYSTEM_BASELINE.job currently hardcodes about AGX so
    -- the agent's behavior doesn't shift the moment 2c flips to
    -- reading from this column.
    INSERT INTO organizations (slug, name, description, identity_body)
    VALUES (
      'agx',
      'AGX Central Florida',
      'Central-Florida construction-services company specializing in painting, deck repairs, roofing, and exterior services for HOAs and apartment communities.',
      '# About the company you serve\nYou are working for AGX Central Florida — a Central-FL construction-services company specializing in painting, deck repairs, roofing, and exterior services for HOAs and apartment communities.\n\nAGX standards:\n- Estimate structure: every line item lives in one of four standard subgroups (Materials & Supplies / Direct Labor / General Conditions / Subcontractors).\n- Markup posture: subgroup markup is set per estimate by the user after costs are confirmed. Do NOT apply default markup percentages; new subgroups seed at 0 and the user dials them in.\n- Pricing posture: materials anchored to actual purchase history (the materials catalog), labor + subs anchored to past-estimate medians. When neither source has a number, defensible Central-FL estimate with rationale.\n- Customers: HOA boards, property management companies, apartment community CAMs. Treat their hierarchy seriously (parent management co → property/community → CAM contact).\n\nThese standards define how AGX operates — they do NOT define WHO YOU are. You are 86 (the Project 86 platform agent). AGX is the company you currently work for.'
    )
    ON CONFLICT (slug) DO NOTHING;

    -- Link users to their organization. Nullable for the duration
    -- of the migration; backfilled to AGX immediately below; flipped
    -- to NOT NULL once we're confident no orphan rows can appear
    -- (Phase 2c after the org-aware user-creation flow lands).
    ALTER TABLE users ADD COLUMN IF NOT EXISTS organization_id INTEGER
      REFERENCES organizations(id) ON DELETE RESTRICT;
    CREATE INDEX IF NOT EXISTS idx_users_organization_id ON users(organization_id);

    -- Backfill: every existing user belongs to AGX. Safe re-run
    -- (only touches NULL rows; explicit assignments stay).
    UPDATE users
       SET organization_id = (SELECT id FROM organizations WHERE slug = 'agx')
     WHERE organization_id IS NULL;

    -- ───────────────────────────────────────────────────────────────
    -- Per-org skill packs. Replaces the global app_settings.agent_skills
    -- JSONB blob (which conflated skill packs with section overrides)
    -- with a proper per-tenant table. Each pack:
    --   - belongs to one organization
    --   - targets one or more agent keys (today only 'job')
    --   - is scoped to one or more surface contexts
    --   - has an admin-editable body, optional category + triggers
    --   - tracks a mirror to native Anthropic Skills via anthropic_skill_id
    --   - soft-deletes via archived_at so name conflicts don't bite
    --     after a pack is removed
    -- Packs are mirrored to native Anthropic Skills (anthropic_skill_id)
    -- and the agent auto-discovers them by description each turn —
    -- no in-prompt manifest, no load_skill_pack round-trip. The
    -- legacy app_settings.agent_skills row stays in place because
    -- loadSectionOverridesFor still uses it for replaces_section
    -- packs (system-prompt patches, distinct from these on-demand
    -- packs).
    CREATE TABLE IF NOT EXISTS org_skill_packs (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      agents JSONB NOT NULL DEFAULT '["job"]'::jsonb,    -- agent_keys this pack targets
      category TEXT,
      triggers JSONB NOT NULL DEFAULT '{}'::jsonb,       -- conditional load rules
      anthropic_skill_id TEXT,                           -- when mirrored to native Anthropic Skills
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      -- Unique per (organization, name) so propose_skill_pack_add can
      -- safely upsert without colliding across tenants.
      UNIQUE (organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_org_skill_packs_org
      ON org_skill_packs(organization_id) WHERE archived_at IS NULL;
    -- The contexts JSONB column was retired with the native-skills
    -- migration. Drop it on existing deployments — idempotent. Any
    -- legacy SELECT references in older code were removed in the
    -- system-audit cleanup, so this is safe.
    ALTER TABLE org_skill_packs DROP COLUMN IF EXISTS contexts;

    -- One-shot migration: copy non-replaces_section packs from the
    -- legacy app_settings.agent_skills row into org_skill_packs under
    -- AGX. Uses a JSONB-extract subquery so the migration runs as a
    -- single SQL pass — Postgres-side, no Node code involved. Safe
    -- re-run because of UNIQUE (organization_id, name) + ON CONFLICT.
    DO $migrate_packs$
    DECLARE
      agx_id INTEGER;
    BEGIN
      SELECT id INTO agx_id FROM organizations WHERE slug = 'agx';
      IF agx_id IS NULL THEN RETURN; END IF;
      -- Phase E retired the contexts column; the one-shot pack-copy
      -- migration below no longer references it (legacy 'contexts'
      -- value from app_settings.agent_skills is dropped on the way
      -- across — packs always loaded for the 'job' agent now).
      INSERT INTO org_skill_packs (
        organization_id, name, body, description,
        agents, category, triggers, anthropic_skill_id
      )
      SELECT
        agx_id,
        COALESCE(pack->>'name', '(untitled)'),
        COALESCE(pack->>'body', ''),
        COALESCE(pack->>'description', ''),
        COALESCE(pack->'agents', '["job"]'::jsonb),
        pack->>'category',
        COALESCE(pack->'triggers', '{}'::jsonb),
        pack->>'anthropic_skill_id'
      FROM app_settings,
           LATERAL jsonb_array_elements(value->'skills') pack
      WHERE app_settings.key = 'agent_skills'
        AND COALESCE(pack->>'replaces_section', '') = ''
      ON CONFLICT (organization_id, name) DO NOTHING;
    END
    $migrate_packs$;

    -- Org-level always-on memory. Parallel to org_skill_packs, but with
    -- one critical difference: skill packs are loaded ON DEMAND by
    -- Anthropic's auto-discovery (description match per turn); memory
    -- rows are injected into the system prompt on EVERY turn. Use this
    -- for posture / discipline that should be ambient (Talk-through
    -- workflow, Change order discipline, AGX house-style estimating
    -- posture, etc.) — anything where John would be annoyed I didn't
    -- apply it on a turn where it wasn't named.
    --
    -- Trade-off vs identity_body: identity_body is one big text blob
    -- (a single editable field on organizations); org_memory rows are
    -- individually editable with sort_order + audit timestamps. Both
    -- get concatenated into the same system-prompt block at runtime;
    -- choosing memory rows over identity_body is just an admin-UX call.
    --
    -- Sort order lets the admin reorder the blocks (lower = earlier in
    -- the prompt). archived_at provides soft-delete consistent with
    -- org_skill_packs. UNIQUE (organization_id, name) prevents
    -- accidental duplicates.
    CREATE TABLE IF NOT EXISTS org_memory (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      body TEXT NOT NULL,
      sort_order INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ,
      UNIQUE (organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_org_memory_org
      ON org_memory(organization_id, sort_order, created_at) WHERE archived_at IS NULL;

    -- Team messaging — per-entity comment threads + (future) DMs.
    -- thread_key conventions:
    --   'job:<id>'      one thread per job (per-job comments)
    --   'lead:<id>'     one thread per lead
    --   'estimate:<id>' one thread per estimate
    --   'dm:<a>:<b>'    direct message (a < b lexicographically)
    -- Single table because read patterns are the same regardless
    -- of source — list-by-thread, post-to-thread, mark-read.
    -- message_reads tracks the high-water mark of a user's last
    -- view per thread so unread counts are cheap to compute.
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      thread_key TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      edited_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_messages_thread_created ON messages(thread_key, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_messages_user ON messages(user_id);

    CREATE TABLE IF NOT EXISTS message_reads (
      thread_key TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (thread_key, user_id)
    );

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- CRM: explicit job→client link for the client dashboard. Additive +
    -- nullable; existing jobs (which store only the client NAME in data)
    -- resolve by name-match in the dashboard endpoint until linked here.
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS client_id TEXT;
    CREATE INDEX IF NOT EXISTS idx_jobs_client_id ON jobs(client_id);
    -- Geocode cache for the schedule's per-job weather lookup. Filled
    -- in lazily by the weather route the first time a job's address
    -- is needed; status='ok'|'failed'|null lets us avoid retrying a
    -- known-bad address on every render. Rounded address that was
    -- geocoded is stored so we can detect stale cache when the user
    -- edits the address and re-geocode.
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geocode_lat NUMERIC(8, 5);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geocode_lng NUMERIC(8, 5);
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geocode_status TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geocode_address TEXT;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS geocode_at TIMESTAMPTZ;

    -- ──────────────────────────────────────────────────────────────────
    -- Wave 1.A Phase 1 — multi-tenancy completion for the four core
    -- anchor tables (jobs / estimates / leads / clients). Adds
    -- organization_id as a NULLABLE column for now + backfills from
    -- owner-user joins. Routes don't filter by this yet; that's the
    -- next commit. NOT NULL tightening comes in a separate later
    -- commit once we've verified zero NULLs slip through new writes.
    --
    -- Why nullable first: zero-downtime migration on a live system.
    -- The deploy can land, the backfill runs, then a follow-up commit
    -- makes new writes set the column, then a follow-up tightens to
    -- NOT NULL. Adding NOT NULL on a populated table is fine in PG
    -- but it briefly takes an AccessExclusiveLock — better in the
    -- maintenance commit.
    --
    -- Single-tenant fallback: rows that can't be traced to a user
    -- (clients with no creator-trail, leads with no salesperson, etc.)
    -- get backfilled with the org id of the most-active user — see
    -- the COALESCE branches in the UPDATE statements. In practice
    -- Project 86 runs as one org today, so this is a safe default.
    -- ──────────────────────────────────────────────────────────────────
    ALTER TABLE jobs      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE leads     ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;

    -- Lead/estimate provenance on jobs. A job created via "Create Job" from a
    -- lead or estimate records where it came from, so (a) the estimate's bid
    -- carries into the job and (b) the relationship is queryable both ways:
    --   lead.job_id  <-> jobs.lead_id
    --   estimate.data.job_id <-> jobs.estimate_id
    -- Placed after the core tables exist so the FKs resolve. ON DELETE SET NULL
    -- keeps a job alive if its source lead/estimate is later deleted.
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS lead_id     TEXT REFERENCES leads(id)     ON DELETE SET NULL;
    ALTER TABLE jobs ADD COLUMN IF NOT EXISTS estimate_id TEXT REFERENCES estimates(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_jobs_lead_id     ON jobs(lead_id);
    CREATE INDEX IF NOT EXISTS idx_jobs_estimate_id ON jobs(estimate_id);
    ALTER TABLE clients   ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;

    -- Indexes to power the upcoming per-org route filters. Partial
    -- index where archived/deleted_at is NULL would be cleaner but
    -- these tables don't all have consistent soft-delete columns,
    -- so a plain btree on the FK is fine.
    CREATE INDEX IF NOT EXISTS idx_jobs_org      ON jobs (organization_id)      WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_estimates_org ON estimates (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_leads_org     ON leads (organization_id)     WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_clients_org   ON clients (organization_id)   WHERE organization_id IS NOT NULL;

    -- Backfills. Each WHERE organization_id IS NULL guard makes the
    -- UPDATE idempotent — running schema init twice is safe.
    --
    -- jobs.owner_id is NOT NULL, so the join always finds a user.
    UPDATE jobs j
       SET organization_id = u.organization_id
      FROM users u
     WHERE u.id = j.owner_id
       AND j.organization_id IS NULL;

    -- estimates.owner_id is NULLABLE. The NOT NULL guard on u skips
    -- estimates without an owner; those stay NULL until the follow-up
    -- single-org fallback below.
    UPDATE estimates e
       SET organization_id = u.organization_id
      FROM users u
     WHERE u.id = e.owner_id
       AND e.organization_id IS NULL
       AND u.organization_id IS NOT NULL;

    -- leads.salesperson_id is NULLABLE. Same shape as estimates.
    UPDATE leads l
       SET organization_id = u.organization_id
      FROM users u
     WHERE u.id = l.salesperson_id
       AND l.organization_id IS NULL
       AND u.organization_id IS NOT NULL;

    -- clients has NO owner column. Backfill from the most-recent
    -- user's organization — a safe default for a single-tenant
    -- install. If Project 86 ever onboards a second org BEFORE this
    -- backfill runs, the per-client assignment will need a manual
    -- pass (admin UI) before opening the second tenant.
    UPDATE clients c
       SET organization_id = (
         SELECT u.organization_id FROM users u
          WHERE u.organization_id IS NOT NULL
          ORDER BY u.id ASC
          LIMIT 1
       )
     WHERE c.organization_id IS NULL;

    -- Single-tenant fallback for remaining nulls on jobs/estimates/leads
    -- (e.g. legacy rows where owner_id pointed to a deleted user).
    -- Same source as the clients backfill — pick a stable org from the
    -- first user. Idempotent via the NULL guard.
    UPDATE jobs SET organization_id = (
      SELECT u.organization_id FROM users u
       WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1
    ) WHERE organization_id IS NULL;
    UPDATE estimates SET organization_id = (
      SELECT u.organization_id FROM users u
       WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1
    ) WHERE organization_id IS NULL;
    UPDATE leads SET organization_id = (
      SELECT u.organization_id FROM users u
       WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1
    ) WHERE organization_id IS NULL;

    -- ──────────────────────────────────────────────────────────────────
    -- Wave 1.A Phase 3 — multi-tenancy completion for the remaining
    -- transactional tables. Each picks the cheapest backfill path:
    --   • Job-anchored (5 tables): join job_id → jobs.organization_id.
    --     Cheap because jobs.organization_id is already populated
    --     from Phase 1.
    --   • Sub-anchored (sub_certificates): join sub_id → subs once
    --     subs is backfilled.
    --   • Polymorphic (attachments, ai_messages, reports): fall back
    --     to the row's user_id → users.organization_id; a per-entity-
    --     type backfill could resolve more rows but adds complexity
    --     not justified at the current data volume.
    --   • messages: user_id → users.organization_id (direct).
    --   • subs: no parent — first-user fallback (same pattern as
    --     clients in Phase 1).
    -- All ALTER + UPDATE statements are idempotent.
    -- ──────────────────────────────────────────────────────────────────

    -- Schema migrations: add the column on all 10 tables.
    ALTER TABLE node_graphs       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE job_change_orders ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE schedule_entries  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE qb_cost_lines     ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE job_subs          ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE attachments       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE ai_messages       ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE messages          ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE subs              ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    ALTER TABLE sub_certificates  ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    -- reports (was job_reports — completed task #88 renamed). Guard so
    -- migration is no-op if the table doesn't exist yet on a fresh DB.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reports') THEN
        ALTER TABLE reports ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
      END IF;
    END $$;

    -- Indexes (partial — only on populated rows).
    CREATE INDEX IF NOT EXISTS idx_node_graphs_org       ON node_graphs       (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_jco_org               ON job_change_orders (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_schedule_entries_org  ON schedule_entries  (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_qb_cost_lines_org     ON qb_cost_lines     (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_job_subs_org          ON job_subs          (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_org       ON attachments       (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_messages_org       ON ai_messages       (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_messages_org          ON messages          (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_subs_org              ON subs              (organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sub_certificates_org  ON sub_certificates  (organization_id) WHERE organization_id IS NOT NULL;

    -- Job-anchored backfills (5 tables). jobs.organization_id is already
    -- populated from Phase 1.
    UPDATE node_graphs n SET organization_id = j.organization_id
      FROM jobs j WHERE j.id = n.job_id AND n.organization_id IS NULL AND j.organization_id IS NOT NULL;
    UPDATE job_change_orders c SET organization_id = j.organization_id
      FROM jobs j WHERE j.id = c.job_id AND c.organization_id IS NULL AND j.organization_id IS NOT NULL;
    UPDATE schedule_entries s SET organization_id = j.organization_id
      FROM jobs j WHERE j.id = s.job_id AND s.organization_id IS NULL AND j.organization_id IS NOT NULL;
    UPDATE qb_cost_lines q SET organization_id = j.organization_id
      FROM jobs j WHERE j.id = q.job_id AND q.organization_id IS NULL AND j.organization_id IS NOT NULL;
    UPDATE job_subs js SET organization_id = j.organization_id
      FROM jobs j WHERE j.id = js.job_id AND js.organization_id IS NULL AND j.organization_id IS NOT NULL;

    -- Polymorphic + user-anchored backfills.
    -- attachments has uploaded_by (not uploaded_by_user_id — caught
    -- via direct schema inspection); ai_messages has user_id; messages
    -- has user_id. All resolve via users.organization_id.
    UPDATE attachments a SET organization_id = u.organization_id
      FROM users u WHERE u.id = a.uploaded_by
        AND a.organization_id IS NULL AND u.organization_id IS NOT NULL;
    UPDATE ai_messages m SET organization_id = u.organization_id
      FROM users u WHERE u.id = m.user_id
        AND m.organization_id IS NULL AND u.organization_id IS NOT NULL;
    UPDATE messages m SET organization_id = u.organization_id
      FROM users u WHERE u.id = m.user_id
        AND m.organization_id IS NULL AND u.organization_id IS NOT NULL;

    -- subs: no parent. First-user fallback (matches clients pattern).
    UPDATE subs SET organization_id = (
      SELECT u.organization_id FROM users u
       WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1
    ) WHERE organization_id IS NULL;

    -- sub_certificates: anchor on the parent sub (subs is now backfilled).
    UPDATE sub_certificates sc SET organization_id = s.organization_id
      FROM subs s WHERE s.id = sc.sub_id
        AND sc.organization_id IS NULL AND s.organization_id IS NOT NULL;

    -- reports (job_reports rename). Polymorphic; fall back via uploaded_by
    -- if present, else first-user fallback. Guarded so it's a no-op if
    -- the reports table doesn't exist yet.
    DO $$ BEGIN
      IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'reports') THEN
        EXECUTE 'UPDATE reports r SET organization_id = (
          SELECT u.organization_id FROM users u
           WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1
        ) WHERE organization_id IS NULL';
      END IF;
    END $$;

    -- Final single-tenant fallback for any remaining nulls across these
    -- 10 tables (orphaned rows where the parent has no org_id, etc.).
    UPDATE node_graphs       SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE job_change_orders SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE schedule_entries  SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE qb_cost_lines     SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE job_subs          SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE attachments       SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE ai_messages       SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE messages          SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;
    UPDATE sub_certificates  SET organization_id = (SELECT u.organization_id FROM users u WHERE u.organization_id IS NOT NULL ORDER BY u.id ASC LIMIT 1) WHERE organization_id IS NULL;

    CREATE TABLE IF NOT EXISTS job_access (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      access_level TEXT NOT NULL DEFAULT 'edit',
      PRIMARY KEY (job_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS node_graphs (
      job_id TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Lead-scoped survey Site Plan graph — the pre-sale mirror of node_graphs.
    -- A lead's survey is geometry only (traced footprints + measurements[] +
    -- photo pins), no cost dataflow. Same {data JSONB} shape so the same engine
    -- serializes it; separate table keeps the leads row flat and the job graph
    -- RMW paths (CO/dispatcher/org-reset) strictly job-only. On lead→job
    -- conversion the blob is copied into node_graphs (see /api/jobs/convert).
    CREATE TABLE IF NOT EXISTS lead_graphs (
      lead_id TEXT PRIMARY KEY REFERENCES leads(id) ON DELETE CASCADE,
      data JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE IF NOT EXISTS estimates (
      id TEXT PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Job-scoped Change Orders. Same JSONB-blob shape as estimates so
    -- the line-item editor + pricing pipeline can share code, but the
    -- canonical job_id / status / approved_at columns sit outside the
    -- blob so we can query "all approved COs for this job" efficiently
    -- in the WIP rollup path without parsing JSONB. Lines live inside
    -- data.lines[] (same __section_header__ sentinel convention as
    -- estimateLines). linked_node_id is nullable until the user wires
    -- the CO to a nodegraph CO node.
    CREATE TABLE IF NOT EXISTS job_change_orders (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      owner_id INTEGER REFERENCES users(id),
      status TEXT NOT NULL DEFAULT 'draft',
      co_number TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved_at TIMESTAMPTZ,
      approved_by INTEGER REFERENCES users(id),
      linked_node_id TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_change_orders_job ON job_change_orders(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_change_orders_status ON job_change_orders(status);
    -- Lock flag: set TRUE when a CO is approved (or applied) — an approved CO is
    -- a committed scope change and becomes read-only. Admin can clear it via
    -- PUT /api/change-orders/:id/lock. Backfill locks any already approved/applied.
    ALTER TABLE job_change_orders ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
    UPDATE job_change_orders SET is_locked = TRUE
      WHERE COALESCE(is_locked, FALSE) = FALSE
        AND status IN ('approved', 'applied');

    -- Purchase Orders — the AGX <-> subcontractor scope-of-work contract
    -- (net-new entity modeled on Buildertrend POs; see the saved
    -- reference_buildertrend_po_spec). Mirrors job_change_orders' shape:
    -- canonical lifecycle columns ride alongside a data JSONB blob holding
    -- the editable body (title, scope rich text, lines[], materialsOnly,
    -- scheduledCompletion, internalNotes, acceptance{name,date,accepted}).
    -- sub_id links the assigned subcontractor (subs.id, loose — a sub may
    -- be removed without cascading the historical PO). organization_id is
    -- set on every insert (net-new table, no backfill needed). Status
    -- workflow: draft -> issued -> approved (sub e-signs) -> work_complete
    -- -> closed. idx ...org is built for the cross-job Jobs-hub list.
    CREATE TABLE IF NOT EXISTS job_purchase_orders (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      owner_id INTEGER REFERENCES users(id),
      sub_id TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      po_number TEXT,
      data JSONB NOT NULL DEFAULT '{}'::jsonb,
      approved_at TIMESTAMPTZ,
      approved_by INTEGER REFERENCES users(id),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_purchase_orders_job ON job_purchase_orders(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_purchase_orders_org ON job_purchase_orders(organization_id, status, created_at DESC) WHERE organization_id IS NOT NULL;

    -- Role definitions. users.role is a TEXT FK by name (no schema change to
    -- users), so existing 'admin'/'corporate'/'pm' values keep working as
    -- soon as the matching rows are seeded below. capabilities is a JSONB
    -- array of capability keys (see CAPABILITY_KEYS in server/auth.js).
    CREATE TABLE IF NOT EXISTS roles (
      name TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      description TEXT,
      builtin BOOLEAN NOT NULL DEFAULT FALSE,
      capabilities JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- CRM client directory. parent_client_id self-references so HOA /
    -- property-management hierarchies are first-class (e.g. "Associa Gulf
    -- Coast" parent with each managed property as a child). Column set
    -- maps the Buildertrend Client Contacts export verbatim — both the
    -- standard fields (name/phone/address/...) and the custom property-
    -- management fields (community_name, company_name, cm_*, mm_*, etc.).
    CREATE TABLE IF NOT EXISTS clients (
      id TEXT PRIMARY KEY,
      parent_client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      -- Identity
      name TEXT NOT NULL,
      client_type TEXT,
      activation_status TEXT DEFAULT 'active',
      -- Primary contact
      first_name TEXT,
      last_name TEXT,
      email TEXT,
      phone TEXT,
      cell TEXT,
      -- Mailing / billing address
      address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      -- Property / community details
      company_name TEXT,
      community_name TEXT,
      market TEXT,
      property_address TEXT,
      property_phone TEXT,
      website TEXT,
      gate_code TEXT,
      additional_pocs TEXT,
      -- Community manager / CAM
      community_manager TEXT,
      cm_email TEXT,
      cm_phone TEXT,
      -- Maintenance manager
      maintenance_manager TEXT,
      mm_email TEXT,
      mm_phone TEXT,
      -- Free-form
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_clients_parent ON clients(parent_client_id);
    CREATE INDEX IF NOT EXISTS idx_clients_name ON clients(name);
    CREATE INDEX IF NOT EXISTS idx_clients_company ON clients(company_name);

    -- Salutation = the "Dear X," opening on a proposal letter (e.g. "PAC Team",
    -- "Jane", "Wimbledon Greens HOA Board"). Added after the initial schema so
    -- existing rows just get NULL — front-end falls back to the contact name.
    -- DEPRECATED 2026-05: removed from the client editor UI (Project 86 dropped
    -- the "Dear X," greeting from proposals). Column is intentionally kept so
    -- existing data isn't lost; it's no longer surfaced or written by the app.
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS salutation TEXT;

    -- Short name = the QuickBooks short name / abbreviation 86 (in
    -- directory mode) uses to match clients to AGX's bookkeeping records
    -- (e.g. "PAC" for "Preferred Apartment Communities", "FSR" for
    -- "FirstService Residential"). Sourced from the live job-numbers +
    -- short-names reference sheet 86 consults,
    -- and used downstream as the community label on proposal exports.
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS short_name TEXT;

    -- Agent notes — accumulated free-form facts about how to handle this
    -- client, written by either the user or 86 (across surfaces) and
    -- auto-injected into 86's system prompt on every turn that touches
    -- this client. Examples: "PAC always wants 15% materials
    -- markup, not 20%", "Wimbledon Greens proposals must include the gate
    -- code in the cover page", "FSR billing prefers a single combined
    -- invoice per property — don't split by group".
    --
    -- Stored as JSONB so we can grow the entry shape without migrations.
    -- Current shape: array of { id, body, created_at, created_by_user_id,
    -- source_agent } where source_agent is null (user-authored), 'cra',
    -- or 'ag'.
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS agent_notes JSONB NOT NULL DEFAULT '[]'::jsonb;

    -- Site-wide settings keyed by short string (e.g. 'proposal_template').
    -- value is JSONB so each setting can store whatever shape it needs without
    -- a schema change. Read/write gated by the ROLES_MANAGE capability.
    CREATE TABLE IF NOT EXISTS app_settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    -- Sales pipeline. A lead is one opportunity for work; estimates (the
    -- "proposals" in BT terminology) hang off a lead via lead_id stored in
    -- the estimate's JSONB blob. Status drives the pipeline:
    --   new -> in_progress -> sent -> sold | lost | no_opportunity
    -- A "sold" lead converts to a job (job_id is set on conversion).
    CREATE TABLE IF NOT EXISTS leads (
      id TEXT PRIMARY KEY,
      client_id TEXT REFERENCES clients(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      -- Address (defaults to the client's address but can be overridden)
      street_address TEXT,
      city TEXT,
      state TEXT,
      zip TEXT,
      -- Sales pipeline
      status TEXT NOT NULL DEFAULT 'new',
      confidence INTEGER DEFAULT 0,
      projected_sale_date DATE,
      estimated_revenue_low NUMERIC(12, 2),
      estimated_revenue_high NUMERIC(12, 2),
      source TEXT,
      project_type TEXT,
      -- Assignment
      salesperson_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- BT-style custom fields that came up on the lead detail screenshot
      property_name TEXT,
      gate_code TEXT,
      market TEXT,
      -- Free-form
      notes TEXT,
      -- Conversion tracking
      job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      -- Audit
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_leads_client ON leads(client_id);
    CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
    CREATE INDEX IF NOT EXISTS idx_leads_salesperson ON leads(salesperson_id);

    -- Geocode cache for the leads map view (mirrors the jobs pattern at the
    -- jobs table above). Populated by lead-routes on create/update + a boot
    -- backfill; status 'failed' is sticky per address so bad addresses are
    -- not retried on every boot.
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS geocode_lat NUMERIC(8, 5);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS geocode_lng NUMERIC(8, 5);
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS geocode_status TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS geocode_at TIMESTAMPTZ;
    -- Lead lifecycle timestamps: WHEN each stage change happened, distinct from
    -- created_at/updated_at. status_changed_at bumps on every status change
    -- (drives days-in-stage); converted_at set when a lead goes 'sold';
    -- lost_at when it goes 'lost'/'no_opportunity'; lost_reason categorizes the
    -- loss; next_followup_at is a user-set date (overdue-follow-up filtering).
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS status_changed_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS converted_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_at TIMESTAMPTZ;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS lost_reason TEXT;
    ALTER TABLE leads ADD COLUMN IF NOT EXISTS next_followup_at DATE;
    -- Idempotent backfill so history isn't blank: converted_at from the linked
    -- job's created_at; lost_at from updated_at for already-lost leads;
    -- status_changed_at defaults to updated_at for every existing row.
    UPDATE leads l SET converted_at = j.created_at
      FROM jobs j WHERE j.lead_id = l.id AND l.converted_at IS NULL;
    UPDATE leads SET lost_at = updated_at
      WHERE lost_at IS NULL AND status IN ('lost', 'no_opportunity');
    UPDATE leads SET status_changed_at = updated_at WHERE status_changed_at IS NULL;

    -- Geocode cache for the Estimates map view. Estimates store their
    -- address as a single free-form data->>'propertyAddr' string (not split
    -- columns like leads), so geocode_addr records which address string the
    -- coords were resolved from — estimate-routes self-skips re-geocoding
    -- when the address is unchanged. Same 'failed'-is-sticky posture as leads.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS geocode_lat NUMERIC(8, 5);
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS geocode_lng NUMERIC(8, 5);
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS geocode_status TEXT;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS geocode_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS geocode_addr TEXT;
    -- Lock flag: set TRUE when a lead converts to a job (the estimate is "sold"
    -- and becomes read-only). An admin can clear it via PUT /api/estimates/:id/lock.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS is_locked BOOLEAN NOT NULL DEFAULT FALSE;
    -- One-time (idempotent) backfill: any estimate already linked to a job
    -- (jobs.estimate_id) is "sold" and must be locked. Earlier conversions and
    -- the /link-estimate path didn't set is_locked, so existing rows were left
    -- editable. Re-run-safe: only flips currently-unlocked linked estimates.
    UPDATE estimates SET is_locked = TRUE
      WHERE COALESCE(is_locked, FALSE) = FALSE
        AND id IN (SELECT estimate_id FROM jobs WHERE estimate_id IS NOT NULL);

    -- Estimate lifecycle timestamps: track WHEN a proposal was sent / accepted,
    -- distinct from created_at/updated_at. sent_at is set by the "Mark Sent"
    -- action; accepted_at is stamped when the estimate is sold (lead→job convert
    -- / link). sent_count bumps each time it's (re)marked sent. viewed_at is
    -- reserved for a future client-facing proposal-view link.
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS sent_at     TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS viewed_at   TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ;
    ALTER TABLE estimates ADD COLUMN IF NOT EXISTS sent_count  INTEGER NOT NULL DEFAULT 0;
    -- Backfill accepted_at for already-sold estimates (linked to a job) so the
    -- "Accepted" date isn't blank on historical wins. Use the job's created_at.
    UPDATE estimates e SET accepted_at = j.created_at
      FROM jobs j
     WHERE j.estimate_id = e.id
       AND e.accepted_at IS NULL;

    -- Polymorphic attachments — each row is a single uploaded photo (or doc)
    -- belonging to either a lead or an estimate. We store three size variants
    -- per upload (thumbnail, web, original) so the UI can show a fast grid,
    -- a lightbox view, and offer a full-res download. URLs are absolute paths
    -- that the storage backend (local disk now, R2 later) returns. Keys are
    -- the storage-side identifiers we hand back when deleting.
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('lead', 'estimate')),
      entity_id TEXT NOT NULL,
      filename TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      thumb_url TEXT NOT NULL,
      web_url TEXT NOT NULL,
      original_url TEXT NOT NULL,
      thumb_key TEXT NOT NULL,
      web_key TEXT NOT NULL,
      original_key TEXT NOT NULL,
      caption TEXT,
      position INTEGER NOT NULL DEFAULT 0,
      uploaded_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      uploaded_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_attachments_entity ON attachments(entity_type, entity_id, position);

    -- Make image-pipeline columns nullable so document attachments (PDFs,
    -- Excel, Word, drawings, RFPs, etc.) can store just the original
    -- without having to fake thumb/web URLs. Image uploads still set all
    -- three. Idempotent — DROP NOT NULL on an already-nullable column is
    -- a no-op in Postgres.
    ALTER TABLE attachments ALTER COLUMN thumb_url DROP NOT NULL;
    ALTER TABLE attachments ALTER COLUMN web_url   DROP NOT NULL;
    ALTER TABLE attachments ALTER COLUMN thumb_key DROP NOT NULL;
    ALTER TABLE attachments ALTER COLUMN web_key   DROP NOT NULL;

    -- Extracted text from PDF / Excel / Word docs (Phase A: just PDFs).
    -- Populated at upload time via pdf-parse so AG can read the actual
    -- contents instead of just the filename. Idempotent.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extracted_text TEXT;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS extracted_text_at TIMESTAMPTZ;

    -- Anthropic Files API caching — when an attachment's web variant
    -- has been uploaded to Anthropic via beta.files.upload, the
    -- returned file id lives here. The chat path can then reference
    -- the photo by file_id instead of base64-encoding it on every
    -- turn (cheaper, faster). Switching loadPhotoAsBlock to use
    -- file_id requires migrating from messages.stream → beta.messages
    -- .stream — that's a separate commit. For now this column is
    -- populated by the admin /api/admin/files/upload-attachment/:id
    -- endpoint and consumed by future chat changes.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS anthropic_file_id TEXT;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS anthropic_file_uploaded_at TIMESTAMPTZ;

    -- Markup linkage: when a user annotates a photo and saves it as a NEW
    -- attachment (rather than replacing the original), markup_of points
    -- back at the source attachment id. Lets the UI render a "Markups"
    -- section grouped under each original. ON DELETE SET NULL so deleting
    -- the original doesn't cascade-kill the markups.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS markup_of TEXT REFERENCES attachments(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_markup_of ON attachments(markup_of) WHERE markup_of IS NOT NULL;

    -- include_in_proposal: when true, the estimate's proposal preview +
    -- export embeds this attachment. Both photos and PDFs respect the
    -- flag; admin/PM can toggle it from the attachments tab. Lead-side
    -- attachments use it too (surfaced into the estimate as parent set).
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS include_in_proposal BOOLEAN NOT NULL DEFAULT FALSE;

    -- Per-attachment tags (CompanyCam-style). JSONB array of lowercase
    -- strings, capped at 20 per attachment by the route layer. Drives
    -- the tag filter strip in the Projects photo feed. GIN index on
    -- jsonb_path_ops supports the @> containment operator we use for
    -- filtering.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_attachments_tags
      ON attachments USING gin (tags jsonb_path_ops);

    -- Editable vector annotations (Phase 1.7). Stores the strokes
    -- array the markup viewer produces — arrows, text, polylines,
    -- measurements, etc. — directly on the original attachment row.
    -- Replaces the previous "rasterize-to-PNG-as-new-attachment"
    -- pattern. The image stays untouched; the strokes ride alongside
    -- and can be edited indefinitely. Rasterization only happens at
    -- report-generation time.
    --
    -- Shape (per stroke): { tool, color, lineWidth, startX, startY,
    --   endX, endY } for shapes; { tool: 'text', x, y, text, fontPx }
    --   for text; { tool: 'sticker', kind, x, y, size } for stickers;
    --   { tool: 'measure', ..., measureInches, measureLabel } for
    --   dimensions. GIN index supports future queries like "find
    --   photos with measurement strokes".
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS annotations JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_attachments_annotations
      ON attachments USING gin (annotations);

    -- ── Photo geolocation ─────────────────────────────────────────
    -- Per-photo GPS coords for the field map view. Populated at upload
    -- time from two sources, server-side reconciled:
    --   - 'device': browser navigator.geolocation, posted by the client
    --              in the upload body (always real-time = "where am I now")
    --   - 'exif':   GPSLatitude/GPSLongitude embedded in the JPEG by
    --              the camera. Survives Camera-Roll uploads only when
    --              the platform doesn't strip EXIF on share.
    --   - 'manual': user dropped the pin on the map (edit flow)
    --
    -- Priority when both sources exist: 'device' if its accuracy
    -- (geo_accuracy in meters) <= 50m, else whichever has the smaller
    -- accuracy value. NULL if neither source provided coords.
    --
    -- taken_at: from EXIF DateTimeOriginal when present, so the map
    -- timeline can show "shots taken on day X" even if the upload
    -- happened later. Falls back to uploaded_at when null.
    --
    -- (lat, lng) index supports "give me every photo within bbox" for
    -- the entity map view's pin layer.
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS lat REAL;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS lng REAL;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS geo_accuracy REAL;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS geo_source TEXT;
    ALTER TABLE attachments ADD COLUMN IF NOT EXISTS taken_at TIMESTAMPTZ;
    CREATE INDEX IF NOT EXISTS idx_attachments_geo
      ON attachments (lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;

    -- Org-level tag catalog (Phase 1.7). Curated master list of tag
    -- names per organization so users don't retype "roof" / "gutter"
    -- / "fascia" on every project. The catalog is a hint registry —
    -- attachments still store tag STRINGS in their JSONB array (no
    -- FK), but autocomplete is seeded from this table and admins
    -- can rename / merge / archive globally.
    --
    -- use_count is bumped every time a tag string is added to an
    -- attachment (route-side, best-effort). Drives the
    -- "most-used first" autocomplete ordering.
    CREATE TABLE IF NOT EXISTS org_tags (
      id              BIGSERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      hue             INTEGER,
      use_count       INTEGER NOT NULL DEFAULT 0,
      archived_at     TIMESTAMPTZ,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, name)
    );
    CREATE INDEX IF NOT EXISTS idx_org_tags_org
      ON org_tags(organization_id) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_org_tags_use_count
      ON org_tags(organization_id, use_count DESC) WHERE archived_at IS NULL;
    -- Case-insensitive uniqueness so "Trim Carpentry" and "trim
    -- carpentry" can't both exist as separate org-tag rows. We keep
    -- the case-sensitive UNIQUE(organization_id, name) above as well
    -- — this expression index just adds the case-fold check.
    -- ON CONFLICT in attachment-routes.js targets this expression
    -- index so case-preserved new entries fold into existing rows
    -- of any case rather than spawning duplicates.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_tags_ci_name
      ON org_tags(organization_id, (LOWER(name)));
    -- Per-tag map-pin icon (an agx-icons.js name). hue (above) carries
    -- the color; together they style this tag's photo map pins. NULL =
    -- fall back to the built-in tag-icons.js catalog.
    ALTER TABLE org_tags ADD COLUMN IF NOT EXISTS icon TEXT;

    -- ---------------------------------------------------------------
    -- Per-org folder templates. Folders in Project 86 are IMPLICIT --
    -- a folder only "exists" once an attachment row carries that
    -- folder string. js/folder-taxonomy.js ships a hard-coded
    -- DEFAULT set per entity type (lead / estimate / job / client) so
    -- the My Files tree, send/copy picker, and sub-grant dropdown can
    -- show a folder structure before any file is uploaded.
    --
    -- This table lets each org OVERRIDE those defaults without code
    -- changes: one row per (organization_id, entity_type) holding an
    -- ordered JSONB array of folder strings (already sanitized to the
    -- shape sanitizeFolderPath produces -- lowercase, hyphenated,
    -- slash-delimited, max 3 levels). Absence of a row falls back to
    -- the built-in defaults. A present row fully REPLACES the defaults
    -- for that type (not merged), so an org that wants fewer folders
    -- gets exactly what it configures.
    --
    -- 'general' is always appended client-side as the catch-all and is
    -- NOT stored here. entity_type is constrained to the four taxonomy
    -- types so a typo can't create a dead row.
    CREATE TABLE IF NOT EXISTS org_folder_templates (
      id              BIGSERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      entity_type     TEXT NOT NULL CHECK (entity_type IN ('lead','estimate','job','client')),
      folders         JSONB NOT NULL DEFAULT '[]'::jsonb,
      updated_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, entity_type)
    );
    CREATE INDEX IF NOT EXISTS idx_org_folder_templates_org
      ON org_folder_templates(organization_id);

    -- Extend the entity_type enum to support clients (business-card photos,
    -- W9s, COIs, etc. attached to a parent management company or property).
    -- The CHECK constraint is named implicitly so we have to drop and re-add
    -- by inspecting the catalog. Idempotent: safe to run on every boot.
    DO $$
    DECLARE
      cname TEXT;
    BEGIN
      SELECT conname INTO cname
        FROM pg_constraint
        WHERE conrelid = 'attachments'::regclass
          AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%entity_type%';
      IF cname IS NOT NULL THEN
        EXECUTE 'ALTER TABLE attachments DROP CONSTRAINT ' || quote_ident(cname);
      END IF;
    END $$;
    ALTER TABLE attachments
      ADD CONSTRAINT attachments_entity_type_check
      CHECK (entity_type IN ('lead', 'estimate', 'client', 'job', 'sub', 'user', 'org', 'project', 'task'));

    -- Folder grouping (Phase 3). Free-text folder name per attachment;
    -- 'general' is the default catch-all. Users can move files into
    -- named folders (e.g. 'photos', 'rfp', 'contracts', 'inspection')
    -- via the move endpoint. Phase 4 layers per-folder sub access on
    -- top of this column. (Phase 4's attachment_folder_grants table
    -- is defined AFTER the subs table further down so its FK resolves
    -- on the first run.)
    --
    -- 2026-05-23: the ALTER below was missing from the original Phase 3
    -- migration — the column was documented in this comment but never
    -- actually added. /api/attachments/recent, 86's search_my_kb tool,
    -- and the sub portal routes all SELECT a.folder and were failing
    -- with "column folder does not exist". Adding it now with the
    -- intended default so existing rows backfill to 'general'.
    ALTER TABLE attachments
      ADD COLUMN IF NOT EXISTS folder TEXT NOT NULL DEFAULT 'general';
    CREATE INDEX IF NOT EXISTS idx_attachments_entity_folder
      ON attachments (entity_type, entity_id, folder);

    -- ── Real folder tree (Explorer-style file system) ──────────────
    -- Folders graduate from the free-text attachments.folder string to
    -- actual rows: scoped to (entity_type, entity_id), self-referential
    -- parent_id, materialized path ('a/b/c'). attachments.folder_id
    -- points at the leaf; the legacy attachments.folder TEXT column stays
    -- DUAL-WRITTEN = folder.path during the transition so string readers
    -- (sub-portal grants, 86 search) keep working until they migrate.
    -- A folders refactor touches only metadata, never the stored bytes.
    -- Unique per entity by (parent, name) case-insensitively (Windows-
    -- like). parent_id CASCADE so deleting a folder removes its subtree;
    -- attachments.folder_id SET NULL so files are never destroyed by a
    -- folder delete (the route unfiles them to root instead).
    CREATE TABLE IF NOT EXISTS file_folders (
      id              TEXT PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      entity_type     TEXT NOT NULL,
      entity_id       TEXT NOT NULL,
      parent_id       TEXT REFERENCES file_folders(id) ON DELETE CASCADE,
      name            TEXT NOT NULL,
      path            TEXT NOT NULL,
      position        INTEGER NOT NULL DEFAULT 0,
      created_by      INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_file_folders_unique
      ON file_folders (entity_type, entity_id, COALESCE(parent_id, ''), LOWER(name));
    CREATE INDEX IF NOT EXISTS idx_file_folders_parent
      ON file_folders (entity_type, entity_id, parent_id);
    CREATE INDEX IF NOT EXISTS idx_file_folders_path
      ON file_folders (entity_type, entity_id, path);

    ALTER TABLE attachments
      ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES file_folders(id) ON DELETE SET NULL;
    CREATE INDEX IF NOT EXISTS idx_attachments_folder_id
      ON attachments (folder_id);

    -- Domain rebrand: rewrite attachment URLs from the old
    -- wip-agxco.com host to attachments.project86.net. Existing rows
    -- baked the host into thumb_url / web_url / original_url at
    -- upload time; new uploads pick up the new host via the
    -- R2_PUBLIC_BASE env var, but historical rows still point at the
    -- old domain. Idempotent: the EXISTS guard short-circuits once
    -- the rewrite is done, so subsequent boots skip it. If the
    -- domain ever changes again, bump the OLD/NEW literals or add
    -- a parallel block — REPLACE is a no-op when no match exists.
    DO $$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM attachments
         WHERE thumb_url LIKE '%attachments.wip-agxco.com%'
            OR web_url LIKE '%attachments.wip-agxco.com%'
            OR original_url LIKE '%attachments.wip-agxco.com%'
         LIMIT 1
      ) THEN
        UPDATE attachments
           SET thumb_url    = REPLACE(thumb_url,    'attachments.wip-agxco.com', 'attachments.project86.net'),
               web_url      = REPLACE(web_url,      'attachments.wip-agxco.com', 'attachments.project86.net'),
               original_url = REPLACE(original_url, 'attachments.wip-agxco.com', 'attachments.project86.net')
         WHERE thumb_url LIKE '%attachments.wip-agxco.com%'
            OR web_url LIKE '%attachments.wip-agxco.com%'
            OR original_url LIKE '%attachments.wip-agxco.com%';
        RAISE NOTICE 'Rewrote attachment URLs to attachments.project86.net';
      END IF;
    END $$;

    -- AI estimating-assistant chat. Per-user, per-estimate (so PMs each see
    -- their own conversation). Two messages per round (one user, one
    -- assistant) ordered by created_at; the route layer rebuilds the
    -- conversation by selecting all rows with matching (estimate_id, user_id).
    -- Token counts let us tally cost later.
    CREATE TABLE IF NOT EXISTS ai_messages (
      id TEXT PRIMARY KEY,
      estimate_id TEXT NOT NULL,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      role TEXT NOT NULL CHECK (role IN ('user', 'assistant')),
      content TEXT NOT NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      photos_included INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_messages_conversation
      ON ai_messages(estimate_id, user_id, created_at);

    -- Polymorphic the AI conversation table so the same widget can run
    -- against different entities (estimates today, jobs starting Phase 2B,
    -- maybe leads later). estimate_id holds whatever entity ID; entity_type
    -- discriminates. Idempotent ADD COLUMN with default 'estimate' so
    -- existing rows belong to the estimate flow.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS entity_type TEXT NOT NULL DEFAULT 'estimate';
    CREATE INDEX IF NOT EXISTS idx_ai_messages_entity
      ON ai_messages(entity_type, estimate_id, user_id, created_at);

    -- tool_use_count — assistant rows record how many tool_use blocks
    -- were emitted that turn. Used by the admin Agents page to spot
    -- tool-heavy conversations. Existing rows default to 0; new inserts
    -- populate from the streamed turn.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS tool_use_count INTEGER DEFAULT 0;

    -- tool_uses — full proposal payload for the turn (JSONB array of
    -- {id, name, input}). Lets 86 introspect its own past activity via
    -- the self_diagnose tool: "what did I propose, was it approved,
    -- did the change actually land?" Without this column, awaiting-
    -- approval turns wrote NO row (text only) and approved turns left
    -- no trail of what was approved — making it impossible for the
    -- model to answer "why didn't my line item land?". Populated by
    -- runV2SessionStream when emitting awaiting_approval, and again
    -- on /86/chat/continue when the user approves or rejects.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS tool_uses JSONB;

    -- Prompt-cache breakdown from Anthropic's streaming usage object.
    -- cache_creation_input_tokens = tokens that were *added* to the cache
    -- this turn (5-min ephemeral TTL). cache_read_input_tokens = tokens
    -- that were served *from* the cache (10% of normal input cost).
    -- input_tokens already excludes the cache_read amount, so the full
    -- input footprint is input_tokens + cache_read_input_tokens. Lets
    -- the Admin Agents page show cache hit % per turn / per agent.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS cache_creation_input_tokens INTEGER;
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS cache_read_input_tokens INTEGER;

    -- Names of skill packs that loaded into the agent's system prompt
    -- this turn. Stored as JSONB array of strings (e.g. ["Project 86 Group
    -- Discipline", "Project 86 Pricing Benchmark Loop"]). Lets admins see
    -- which packs are actually firing per turn (some packs are
    -- conditionally loaded via triggers, so the count varies).
    -- Section overrides (replaces_section packs) NOT counted here —
    -- they substitute for hardcoded blocks rather than appending.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS packs_loaded JSONB;

    -- Inline image content blocks that accompanied a user message.
    -- Stored as a JSONB array of Anthropic image content blocks
    -- ({ type:'image', source:{ type:'base64', media_type, data } }).
    -- Without this column the per-turn images were sent to Anthropic
    -- on the FIRST turn only, then dropped from history when
    -- /chat/continue (or the next /chat) rebuilt the message array
    -- from rows that only stored the message TEXT. Symptom: model
    -- correctly described an attached PDF on turn 1, then on turn 2
    -- said "I don't actually have the lead details" because the
    -- image content was gone. Persisting it here lets the history
    -- rebuilder rehydrate the image blocks alongside the text so
    -- the model keeps seeing the attachment across the full
    -- conversation (capped by MAX_HISTORY_PAIRS).
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS inline_image_blocks JSONB;

    -- output_files: code_execution artifacts (xlsx, csv, pdf, png, etc.)
    -- produced by Anthropic's server-hosted Python sandbox during this
    -- assistant turn. Persisted from runV2SessionStream's
    -- harvestOutputFiles helper — each entry is
    --   { file_id, filename, mime, size, url }
    -- where url points to our own storage (Anthropic's session
    -- container is ephemeral, so we re-host the bytes locally). The
    -- chat history rebuilder can read this column to render download
    -- chips on a page refresh; the live SSE stream emits a chat_file
    -- event for the same files in real time.
    ALTER TABLE ai_messages ADD COLUMN IF NOT EXISTS output_files JSONB;

    -- Materials catalog — Project 86's purchase history (Home Depot to start;
    -- vendor column makes Lowe's / Sherwin Williams / etc. a config
    -- addition later, not a schema change). One row per unique
    -- (vendor, cleaned-description); SKU is stored as metadata but is
    -- not the primary identity since vendors do change SKUs over time.
    -- Subcontractor directory. Replaces the inline-per-job sub
    -- records (which lived on the job JSON blob) with a real
    -- first-class directory. One row per company; per-job
    -- contract/billing data lives in job_subs below.
    --
    -- trade is freeform but the UI presents a curated dropdown
    -- (Painter / Drywall / Roofing / etc.) with an "Other" fallback.
    -- W-9 + insurance expiration are tracked because expiry dates
    -- need to surface in the directory view as warnings.
    -- parent_sub_id lets you group sister-companies (a holding +
    -- subsidiaries) the same way clients have parent_client_id.
    CREATE TABLE IF NOT EXISTS subs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      trade TEXT,                          -- "Painter", "Drywall", … or freeform "Other"
      contact_name TEXT,
      phone TEXT,
      email TEXT,
      license_no TEXT,
      w9_on_file BOOLEAN DEFAULT FALSE,
      w9_expires DATE,                     -- W-9 expiration if tracked
      insurance_expires DATE,              -- general liability expiry
      parent_sub_id TEXT REFERENCES subs(id) ON DELETE SET NULL,
      status TEXT DEFAULT 'active',        -- 'active' | 'paused' | 'closed'
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_subs_name_lower ON subs(lower(name));
    CREATE INDEX IF NOT EXISTS idx_subs_trade ON subs(trade);
    CREATE INDEX IF NOT EXISTS idx_subs_status ON subs(status);
    CREATE INDEX IF NOT EXISTS idx_subs_parent ON subs(parent_sub_id);

    -- Phase 1A: expand the sub directory record to a Buildertrend-style
    -- detail level. Additive only — existing rows get NULL/false defaults.
    -- preferences + notification_prefs are JSONB so we can grow the
    -- schema (more checkboxes, per-channel matrix) without another
    -- migration round.
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS division TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS primary_contact_first TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS primary_contact_last TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS business_phone TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS cell_phone TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS fax TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS street_address TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS city TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS state TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS zip TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS payment_email TEXT;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS payment_hold BOOLEAN DEFAULT FALSE;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS preferences JSONB NOT NULL DEFAULT '{}'::jsonb;
    ALTER TABLE subs ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Phase 1B: certificates table. One row per (sub, cert_type) — UNIQUE
    -- enforces upsert semantics so a sub has at most one of each cert
    -- type. attachment_id points to an attachments row with
    -- entity_type='sub' that holds the actual PDF bytes; ON DELETE SET
    -- NULL preserves the cert metadata (reminder schedule, expiration)
    -- if the attachment is removed, so a re-upload doesn't lose the
    -- reminder config the user already set.
    CREATE TABLE IF NOT EXISTS sub_certificates (
      id TEXT PRIMARY KEY,
      sub_id TEXT NOT NULL REFERENCES subs(id) ON DELETE CASCADE,
      cert_type TEXT NOT NULL CHECK (cert_type IN ('gl', 'wc', 'w9', 'bank')),
      attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
      expiration_date DATE,
      reminder_days INTEGER NOT NULL DEFAULT 30,
      reminder_direction TEXT NOT NULL DEFAULT 'before'
        CHECK (reminder_direction IN ('before', 'after')),
      reminder_limit INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (sub_id, cert_type)
    );
    CREATE INDEX IF NOT EXISTS idx_sub_certificates_sub ON sub_certificates(sub_id);
    -- Expiration index for the future reminder scheduler — lets it scan
    -- "what's expiring in the next N days across all subs" cheaply.
    CREATE INDEX IF NOT EXISTS idx_sub_certificates_expiration ON sub_certificates(expiration_date) WHERE expiration_date IS NOT NULL;

    -- Per-job assignment + financials. Same sub on two jobs gets two
    -- rows. UNIQUE(job_id, sub_id) so a sub isn't double-assigned to
    -- the same job (use multiple line entries on the job-side row
    -- if you have multiple contracts with the same sub on one job).
    CREATE TABLE IF NOT EXISTS job_subs (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      sub_id TEXT NOT NULL REFERENCES subs(id) ON DELETE RESTRICT,
      level TEXT DEFAULT 'job',            -- 'job' | 'building' | 'phase'
      building_id TEXT,                    -- when level='building'
      phase_id TEXT,                       -- when level='phase'
      contract_amt NUMERIC(12, 2) DEFAULT 0,
      billed_to_date NUMERIC(12, 2) DEFAULT 0,
      status TEXT DEFAULT 'active',        -- 'active' | 'paused' | 'closed'
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_subs_job ON job_subs(job_id);
    CREATE INDEX IF NOT EXISTS idx_job_subs_sub ON job_subs(sub_id);

    -- Sub assignments are job-level only — building/phase distribution
    -- is driven by the node graph. Collapse any legacy multi-level
    -- rows into one (job, sub) row by summing dollar amounts and
    -- nulling level/building_id/phase_id, then swap the old composite
    -- unique index for a (job_id, sub_id) one. Idempotent: the DO
    -- block bails out if the new index already exists.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM pg_indexes
         WHERE schemaname = 'public'
           AND indexname  = 'idx_job_subs_unique_v2'
      ) THEN
        -- Collapse: pick the oldest row per (job, sub) as the survivor,
        -- sum contract_amt + billed_to_date into it, delete the rest.
        -- Use temp tables (not CTEs) because each statement in a
        -- DO block is its own scope — CTEs from one UPDATE don't
        -- carry into the next DELETE.
        CREATE TEMP TABLE _js_survivor ON COMMIT DROP AS
          SELECT DISTINCT ON (job_id, sub_id) id, job_id, sub_id
            FROM job_subs
           ORDER BY job_id, sub_id, created_at ASC;

        CREATE TEMP TABLE _js_totals ON COMMIT DROP AS
          SELECT job_id, sub_id,
                 SUM(COALESCE(contract_amt, 0))   AS contract_amt,
                 SUM(COALESCE(billed_to_date, 0)) AS billed_to_date
            FROM job_subs
           GROUP BY job_id, sub_id;

        -- Drop the old composite unique index BEFORE mutating data.
        -- The UPDATE below nulls out building_id/phase_id on the
        -- survivor row, which under the old index collapses its
        -- key to (job_id, sub_id, '', '') — that collides with any
        -- pre-existing (job, sub, NULL, NULL) row in the same
        -- family, so we'd get a duplicate-key violation if the
        -- index is still active. Drop first, mutate freely, then
        -- create the new (job_id, sub_id) unique index at the end.
        DROP INDEX IF EXISTS idx_job_subs_unique;

        -- Delete non-survivors BEFORE updating the survivor. This
        -- leaves exactly one row per (job, sub), so the UPDATE
        -- can't conflict with the new unique index either.
        DELETE FROM job_subs js
          USING _js_survivor s
         WHERE js.job_id = s.job_id
           AND js.sub_id = s.sub_id
           AND js.id <> s.id;

        UPDATE job_subs js
           SET contract_amt   = t.contract_amt,
               billed_to_date = t.billed_to_date,
               level          = 'job',
               building_id    = NULL,
               phase_id       = NULL,
               updated_at     = NOW()
          FROM _js_survivor s, _js_totals t
         WHERE js.id = s.id
           AND t.job_id = s.job_id
           AND t.sub_id = s.sub_id;

        CREATE UNIQUE INDEX idx_job_subs_unique_v2 ON job_subs(job_id, sub_id);
      END IF;
    END $$;

    -- Sub portal user link (Phase 5). Defined here, after the subs
    -- table, so the FK resolves on the first run. Every non-sub user
    -- has sub_id = NULL; sub-portal users have exactly one row in
    -- the subs table they are tied to. ON DELETE CASCADE so removing
    -- a sub automatically nukes their portal login too.
    ALTER TABLE users ADD COLUMN IF NOT EXISTS sub_id TEXT REFERENCES subs(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_users_sub_id ON users(sub_id) WHERE sub_id IS NOT NULL;

    -- Sub portal magic-link invites. PM creates one from the sub
    -- editor → server emails the sub a one-time URL → first click
    -- creates / activates the sub-role user and signs them in.
    -- token is a 32-byte random hex string (cryptographically
    -- random); used_at is set on first claim so a leaked link can't
    -- be re-used. Expired or used invites are kept around for audit
    -- (no cron sweep yet — table will stay tiny).
    CREATE TABLE IF NOT EXISTS sub_invites (
      id TEXT PRIMARY KEY,
      sub_id TEXT NOT NULL REFERENCES subs(id) ON DELETE CASCADE,
      email TEXT NOT NULL,
      token TEXT NOT NULL UNIQUE,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL,
      used_at TIMESTAMPTZ,
      used_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sub_invites_sub ON sub_invites(sub_id);
    CREATE INDEX IF NOT EXISTS idx_sub_invites_token ON sub_invites(token);

    -- Per-folder sub access (Phase 4). A grant says "sub X can see
    -- folder F on entity (T,I)". One sub may have many grants;
    -- revoking is a row delete. PMs grant/revoke from the attachment
    -- list UI or the sub editor; the future sub-facing portal will
    -- read this table to know which folders to surface.
    --
    -- Why a table and not a JSONB column on subs: grants need to be
    -- queryable both directions — "what folders does this sub see"
    -- AND "which subs see this folder" — so a normalized table is
    -- cheaper than scanning JSONB. ON DELETE CASCADE on sub_id keeps
    -- the table consistent when subs are removed; entity_id is
    -- polymorphic (leads/jobs/estimates) so it isn't FK'd — orphan
    -- grants are filtered out at read time.
    CREATE TABLE IF NOT EXISTS attachment_folder_grants (
      id TEXT PRIMARY KEY,
      sub_id TEXT NOT NULL REFERENCES subs(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('lead','estimate','client','job','sub')),
      entity_id TEXT NOT NULL,
      folder TEXT NOT NULL DEFAULT 'general',
      granted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      granted_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (sub_id, entity_type, entity_id, folder)
    );
    CREATE INDEX IF NOT EXISTS idx_afg_sub ON attachment_folder_grants(sub_id);
    CREATE INDEX IF NOT EXISTS idx_afg_entity ON attachment_folder_grants(entity_type, entity_id, folder);
    -- Rename/move-safe grants: point at the folder row, not the string.
    -- Backfilled by the file-folders migration; enforcement switches to
    -- folder_id in a later phase (string match still works meanwhile).
    ALTER TABLE attachment_folder_grants
      ADD COLUMN IF NOT EXISTS folder_id TEXT REFERENCES file_folders(id) ON DELETE CASCADE;
    CREATE INDEX IF NOT EXISTS idx_afg_folder_id ON attachment_folder_grants(folder_id);

    -- QuickBooks Detailed Job Cost lines. Imported from the weekly
    -- "Project Costs" / "Detailed Job Costs" xlsx export. The id is a
    -- content-derived hash so re-imports of the same QB row land on the
    -- same record (idempotent across devices and re-runs).
    -- linked_node_id is set by the user (or AI in Phase 3) to attach
    -- a line to a node graph node — that's how QB spend gets reconciled
    -- against the cost-flow tree.
    -- Field tools — self-contained HTML utilities (calculators, lookups,
    -- forms) that 86 can spin up on demand and the team uses on phones
    -- in the field. Stored as a complete <!doctype html>...</html>
    -- document with inline <style> + <script>. Rendered client-side in
    -- a sandboxed iframe so untrusted JS can't reach the parent page.
    --
    -- Examples:
    --   - "Pressure Wash Labor Calculator" — sqft × rate calculator
    --   - "Gable Calculator" — base × peak ÷ 2 for triangle sqft
    -- More can be added by asking 86 ("save this HTML as a tool called
    -- X") or via the Tools tab's "+ Add tool" button.
    CREATE TABLE IF NOT EXISTS field_tools (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      description TEXT,
      category TEXT,                                       -- 'calculator' | 'lookup' | 'form' | 'other'
      html_body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      -- Owning organization. Field tools are per-org: each org curates its
      -- own list (and its own selection of system presets). NULL = legacy
      -- deployment-wide tool (visible to all) until backfilled.
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      -- System (preset) tools come from the code catalog in
      -- server/field-tool-catalog.js. They carry the catalog key in
      -- system_key, render with a gold star, and cannot be deleted by
      -- regular users (only removed from the catalog picker by an admin).
      is_system BOOLEAN NOT NULL DEFAULT FALSE,
      system_key TEXT
    );
    -- Backfill columns for already-deployed DBs.
    ALTER TABLE field_tools ADD COLUMN IF NOT EXISTS is_system BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE field_tools ADD COLUMN IF NOT EXISTS system_key TEXT;
    ALTER TABLE field_tools ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    -- Per-org scoping: drop the old global UNIQUE(name) + global system_key
    -- index, scope both per organization. Backfill org from the creator.
    ALTER TABLE field_tools DROP CONSTRAINT IF EXISTS field_tools_name_key;
    DROP INDEX IF EXISTS idx_field_tools_system_key;
    UPDATE field_tools ft SET organization_id = u.organization_id
      FROM users u WHERE u.id = ft.created_by AND ft.organization_id IS NULL;
    CREATE INDEX IF NOT EXISTS idx_field_tools_category ON field_tools(category);
    CREATE INDEX IF NOT EXISTS idx_field_tools_updated ON field_tools(updated_at DESC);
    CREATE INDEX IF NOT EXISTS idx_field_tools_org ON field_tools(organization_id);
    -- Unique tool name per org, and one row per catalog key per org.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_field_tools_org_name ON field_tools(organization_id, name);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_field_tools_org_syskey ON field_tools(organization_id, system_key) WHERE system_key IS NOT NULL;

    -- Field tool printouts — one row per saved run. The user clicks
    -- "Save Printout" inside a field tool modal; the tool's HTML
    -- posts a {type:'p86-field-tool-result', inputs, outputs} message
    -- to the parent which then saves a row here. inputs / outputs
    -- are tool-shape-agnostic JSONB so each tool defines its own
    -- field structure. notes is a user-typed label
    -- ("for Johnson property"). The receipt-style print view in
    -- My Files renders this row as a paper-style document so the
    -- user can reference past calculations.
    CREATE TABLE IF NOT EXISTS field_tool_runs (
      id              TEXT PRIMARY KEY,
      field_tool_id   TEXT NOT NULL REFERENCES field_tools(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
      outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes           TEXT,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_field_tool_runs_tool ON field_tool_runs(field_tool_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_field_tool_runs_user ON field_tool_runs(user_id, created_at DESC);

    -- Per-user, per-tool input draft (autosave). ONE row per (user, tool)
    -- — each save (debounced from the iframe's input events) is an
    -- UPSERT that overwrites the previous values. This is the
    -- "save on input" restoration surface: reopen any tool and the
    -- inputs you last typed are still there. Distinct from
    -- field_tool_runs, which are explicit named printouts the user
    -- chose to keep.
    CREATE TABLE IF NOT EXISTS field_tool_drafts (
      field_tool_id   TEXT NOT NULL REFERENCES field_tools(id) ON DELETE CASCADE,
      user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      inputs          JSONB NOT NULL DEFAULT '{}'::jsonb,
      outputs         JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (field_tool_id, user_id)
    );

    CREATE TABLE IF NOT EXISTS qb_cost_lines (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      vendor TEXT,
      txn_date DATE,
      txn_type TEXT,
      num TEXT,
      account TEXT,
      account_type TEXT,
      klass TEXT,
      memo TEXT,
      amount NUMERIC(12, 2) NOT NULL,
      linked_node_id TEXT,
      raw_data JSONB,
      source_file TEXT,
      report_date DATE,
      imported_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_qb_cost_lines_job ON qb_cost_lines(job_id);
    CREATE INDEX IF NOT EXISTS idx_qb_cost_lines_date ON qb_cost_lines(txn_date);
    CREATE INDEX IF NOT EXISTS idx_qb_cost_lines_account ON qb_cost_lines(account);
    CREATE INDEX IF NOT EXISTS idx_qb_cost_lines_linked_node ON qb_cost_lines(linked_node_id);

    CREATE TABLE IF NOT EXISTS materials (
      id SERIAL PRIMARY KEY,
      vendor TEXT NOT NULL DEFAULT 'home_depot',
      sku TEXT,
      internet_sku TEXT,
      raw_description TEXT NOT NULL,
      description TEXT NOT NULL,           -- cleaned, AG-readable
      hd_department TEXT,
      hd_class TEXT,
      hd_subclass TEXT,
      agx_subgroup TEXT,                   -- 'materials' | 'labor' | 'gc' | 'sub'
      category TEXT,                       -- Project 86-natural category: 'Lumber & Decking', 'Paint', 'Fasteners', etc.
      unit TEXT,                           -- ea / qt / gal / lb / lf / sf / ...
      last_unit_price NUMERIC(10, 2),
      avg_unit_price NUMERIC(10, 2),
      min_unit_price NUMERIC(10, 2),
      max_unit_price NUMERIC(10, 2),
      total_qty NUMERIC(12, 2) DEFAULT 0,
      purchase_count INTEGER DEFAULT 0,
      first_seen DATE,
      last_seen DATE,
      is_hidden BOOLEAN DEFAULT FALSE,     -- admin can hide noise SKUs
      manual_override BOOLEAN DEFAULT FALSE, -- admin-edited; protect from re-import
      notes TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    -- Idempotent ADD COLUMN for upgrades from earlier schema (where the
    -- category col didn't exist yet). Must run BEFORE the index creation
    -- below — otherwise on an existing materials table from a prior
    -- deploy, the CREATE INDEX hits a missing column and crashes the
    -- migration. Safe to re-run; ADD COLUMN IF NOT EXISTS is a no-op
    -- when the column already exists.
    ALTER TABLE materials ADD COLUMN IF NOT EXISTS category TEXT;
    -- Phase F — materials go org-scoped. Same pattern as
    -- agent_reference_links (and org_skill_packs / org_memory).
    -- The catalog was previously implicitly per-tenant (purchases came
    -- from one tenant's QB feed) but lacked an explicit FK; multi-tenant
    -- would have leaked one org's pricing into another's drawer. Idempotent
    -- ADD COLUMN + conditional backfill onto the lowest-id org.
    ALTER TABLE materials
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    DO $migrate_materials_org$
    DECLARE
      bootstrap_org_id INTEGER;
    BEGIN
      SELECT id INTO bootstrap_org_id
        FROM organizations
       WHERE archived_at IS NULL
       ORDER BY id ASC LIMIT 1;
      IF bootstrap_org_id IS NOT NULL THEN
        UPDATE materials
           SET organization_id = bootstrap_org_id
         WHERE organization_id IS NULL;
      END IF;
    END
    $migrate_materials_org$;
    CREATE INDEX IF NOT EXISTS idx_materials_org
      ON materials(organization_id) WHERE organization_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_materials_subgroup ON materials(agx_subgroup);
    CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category);
    CREATE INDEX IF NOT EXISTS idx_materials_sku ON materials(sku);
    CREATE INDEX IF NOT EXISTS idx_materials_hidden ON materials(is_hidden);
    CREATE INDEX IF NOT EXISTS idx_materials_search ON materials
      USING gin(to_tsvector('english', description || ' ' || raw_description));
    -- Natural-key dedupe — case-insensitive description per vendor, now
    -- scoped PER-ORG (Phase F follow-up) so two tenants can each carry the
    -- same vendor+description without the import colliding on a global
    -- unique. The materials org backfill above already stamped every row,
    -- so the new index sees no NULLs. Drop the old global unique, create
    -- the org-scoped one.
    DROP INDEX IF EXISTS idx_materials_natural_key;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_natural_key_org
      ON materials(organization_id, vendor, lower(raw_description));

    -- Materials Catalog Drawer phase 2 — per-user starred materials.
    -- Lets PMs pin frequent SKUs so the drawer surfaces them at the
    -- top of the empty-search state and via the Favorites filter
    -- chip. Composite PK doubles as the unique constraint so
    -- POST /favorite is idempotent (ON CONFLICT DO NOTHING).
    CREATE TABLE IF NOT EXISTS user_material_favorites (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      material_id INTEGER NOT NULL REFERENCES materials(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (user_id, material_id)
    );
    CREATE INDEX IF NOT EXISTS idx_user_material_favorites_user
      ON user_material_favorites(user_id, created_at DESC);

    -- Per-purchase rows kept for audit + price-history queries. Lets us
    -- re-run aggregates after admins fix descriptions, and lets AG
    -- answer "when did we last buy this?" with a date.
    CREATE TABLE IF NOT EXISTS material_purchases (
      id SERIAL PRIMARY KEY,
      material_id INTEGER REFERENCES materials(id) ON DELETE CASCADE,
      purchase_date DATE,
      store_number TEXT,
      transaction_id TEXT,
      job_name TEXT,
      quantity NUMERIC(10, 2),
      unit_price NUMERIC(10, 2),
      net_unit_price NUMERIC(10, 2),
      is_return BOOLEAN DEFAULT FALSE,
      source_file TEXT,
      imported_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_material_purchases_material ON material_purchases(material_id);
    CREATE INDEX IF NOT EXISTS idx_material_purchases_date ON material_purchases(purchase_date);
    CREATE INDEX IF NOT EXISTS idx_material_purchases_job ON material_purchases(job_name);
    -- Phase F follow-up — material_purchases go org-scoped to match
    -- materials. Same bootstrap-lowest-id idiom; prefer the parent
    -- material's org, fall back to bootstrap for orphan rows.
    ALTER TABLE material_purchases
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    DO $migrate_material_purchases_org$
    DECLARE
      bootstrap_org_id INTEGER;
    BEGIN
      SELECT id INTO bootstrap_org_id
        FROM organizations
       WHERE archived_at IS NULL
       ORDER BY id ASC LIMIT 1;
      IF bootstrap_org_id IS NOT NULL THEN
        UPDATE material_purchases mp
           SET organization_id = COALESCE(
                 (SELECT m.organization_id FROM materials m WHERE m.id = mp.material_id),
                 bootstrap_org_id)
         WHERE mp.organization_id IS NULL;
      END IF;
    END
    $migrate_material_purchases_org$;
    CREATE INDEX IF NOT EXISTS idx_material_purchases_org
      ON material_purchases(organization_id) WHERE organization_id IS NOT NULL;

    -- Cost Inbox — field-captured cost receipts (photo + amount + cost code),
    -- attached to a JOB or a LEAD (lead = pre-sale / pursuit cost). Distinct
    -- from material_purchases (that's the Home-Depot CSV-history import). The
    -- photo lives in attachments (attachment_id); bytes handled by storage.js.
    -- status: 'unprocessed' = quick photo-only capture (still needs job +
    -- amount), 'processed' = complete & counts toward the entity's actual
    -- costs (no approval gate — completeness IS the gate), 'void' = discarded.
    -- cost_code: materials | labor | sub | gc (Equipment/Permits/Fuel ride
    -- under gc per AGX). is_presale flags lead/pre-award costs so job costing
    -- can separate pursuit cost from build cost after a lead converts.
    CREATE TABLE IF NOT EXISTS receipts (
      id TEXT PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      ref TEXT,                                  -- short 8-char display code (e.g. 2da04fc4)
      entity_type TEXT,                          -- 'job' | 'lead' | 'category' | NULL (unassigned capture)
      entity_id TEXT,                            -- job id | lead id | cost_categories.id
      amount NUMERIC(12, 2),
      vendor TEXT,
      cost_code TEXT DEFAULT 'materials',        -- materials | labor | sub | gc
      is_presale BOOLEAN DEFAULT FALSE,          -- true for lead (pre-award) costs
      notes TEXT,
      attachment_id TEXT,                        -- the receipt photo (attachments.id)
      status TEXT DEFAULT 'unprocessed',         -- unprocessed | processed | void
      purchased_at DATE,                         -- receipt date (OCR/manual), defaults today
      entered_by INTEGER,                        -- users.id who captured it
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_receipts_org ON receipts(organization_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_entity ON receipts(organization_id, entity_type, entity_id);
    CREATE INDEX IF NOT EXISTS idx_receipts_status ON receipts(organization_id, status);
    CREATE INDEX IF NOT EXISTS idx_receipts_date ON receipts(organization_id, purchased_at);
    -- Slice 3 richer fields (idempotent ALTERs; existing rows keep NULL/false):
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;  -- chip labels
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS sub_id TEXT;              -- optional link to subs directory (subs.id)
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS payment_method TEXT;      -- cash|company_card|personal_card|check|ach|other
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS reimbursable BOOLEAN DEFAULT FALSE;
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS reimburse_to TEXT;        -- who to reimburse (free-text name)
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS is_billable BOOLEAN DEFAULT FALSE;  -- pass-through vs overhead
    ALTER TABLE receipts ADD COLUMN IF NOT EXISTS invoice_no TEXT;          -- vendor's invoice # (vs our internal ref)
    CREATE INDEX IF NOT EXISTS idx_receipts_tags ON receipts USING gin (tags jsonb_path_ops);

    -- Receipt OCR feedback — one row per captured receipt that had an OCR
    -- suggestion. Records what the model guessed vs what the user actually
    -- saved, per field, so the hit-rate is measurable (GET /api/receipts/ocr/stats)
    -- and the model can be tuned. amount_ok=false = the user corrected the total
    -- (the "fail" John wants tracked). Org-scoped.
    CREATE TABLE IF NOT EXISTS receipt_ocr_feedback (
      id TEXT PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      receipt_id TEXT,
      ocr_vendor TEXT, final_vendor TEXT, vendor_ok BOOLEAN,
      ocr_date TEXT, final_date TEXT, date_ok BOOLEAN,
      ocr_cost_code TEXT, final_cost_code TEXT, cost_code_ok BOOLEAN,
      ocr_amount NUMERIC(12, 2), final_amount NUMERIC(12, 2), amount_ok BOOLEAN,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_receipt_ocr_fb_org ON receipt_ocr_feedback(organization_id);

    -- Cost categories — org-defined non-job coding buckets a receipt can link to
    -- instead of a job/lead (entity_type='category', entity_id=cost_categories.id):
    -- Tools, Overhead, Fuel, etc. "Tools" is lazily seeded on first list. The
    -- category IS the coding, so cost_code is irrelevant for category receipts.
    CREATE TABLE IF NOT EXISTS cost_categories (
      id TEXT PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      position INTEGER DEFAULT 0,
      archived BOOLEAN DEFAULT FALSE,
      created_by INTEGER,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_cost_categories_org_name ON cost_categories(organization_id, lower(name));
    CREATE INDEX IF NOT EXISTS idx_cost_categories_org ON cost_categories(organization_id);

    -- Saved list views — per-USER grid configuration for a list page (Cost Inbox
    -- first, then Jobs/Leads/Estimates). config holds { columns:[...], filters:{...} }.
    -- One default per (user, page) auto-applies on load. Personal (no sharing yet).
    CREATE TABLE IF NOT EXISTS list_views (
      id TEXT PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      page TEXT NOT NULL,                        -- 'cost_inbox' | 'jobs' | 'leads' | ...
      name TEXT NOT NULL,
      config JSONB DEFAULT '{}'::jsonb,          -- { columns:[...], filters:{...} }
      is_default BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_list_views_owner ON list_views(organization_id, user_id, page);

    -- Email send log — every transactional email goes through
    -- server/email.js which writes a row here so admins can see
    -- delivery state, retry failures, and audit who got what.
    CREATE TABLE IF NOT EXISTS email_log (
      id TEXT PRIMARY KEY,
      to_address TEXT NOT NULL,
      subject TEXT NOT NULL,
      tag TEXT,                                  -- short event tag ("password_reset" / "schedule_entry" / etc.)
      status TEXT NOT NULL,                      -- 'sent' | 'failed' | 'dry-run' | 'unconfigured' | 'invalid'
      provider_id TEXT,                          -- Resend's message id, when available
      error TEXT,
      dry_run BOOLEAN NOT NULL DEFAULT FALSE,
      sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_email_log_sent_at ON email_log(sent_at DESC);
    CREATE INDEX IF NOT EXISTS idx_email_log_status ON email_log(status);
    CREATE INDEX IF NOT EXISTS idx_email_log_tag ON email_log(tag);
    CREATE INDEX IF NOT EXISTS idx_email_log_to ON email_log(to_address);

    -- Project 86 Command Center — append-only audit trail of privileged
    -- actions (role changes, org create/archive, skill/MCP edits, native
    -- Anthropic skill deletes, any system_admin operation). actor_email /
    -- actor_role are SNAPSHOTTED so the record survives the user being
    -- deleted. organization_id = the TARGET org the action touched
    -- (nullable for platform-level ops); actor_org_id = the actor's home
    -- org. Written fire-and-forget by server/audit.js — never blocks the
    -- request. Append-only by convention (no UPDATE/DELETE paths).
    CREATE TABLE IF NOT EXISTS admin_audit_log (
      id BIGSERIAL PRIMARY KEY,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      actor_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      actor_email TEXT,
      actor_role TEXT,
      action TEXT NOT NULL,
      target_type TEXT,
      target_id TEXT,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      actor_org_id INTEGER,
      detail JSONB,
      ip TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_admin_audit_created ON admin_audit_log(created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_actor ON admin_audit_log(actor_user_id);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_action ON admin_audit_log(action);
    CREATE INDEX IF NOT EXISTS idx_admin_audit_org ON admin_audit_log(organization_id);

    -- Per-event template overrides. The codebase ships baked-in defaults
    -- in server/email-templates.js; admins can customize subject + body
    -- without redeploying by saving a row here. Lookup at send time
    -- prefers the override (if present) over the baked-in default.
    -- One row per event key (PK), so there's exactly one customization
    -- per template type.
    CREATE TABLE IF NOT EXISTS email_template_overrides (
      event_key TEXT PRIMARY KEY,
      subject TEXT,
      html_body TEXT,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
    );
    -- Phase F — email_template_overrides go org-scoped so each tenant
    -- can customize templates independently. Today the table is keyed
    -- by event_key alone (one row per event globally); adding org_id
    -- means we can have separate rows per (org, event) pair.
    --
    -- Strategy:
    --   1. Add organization_id column (nullable, FK).
    --   2. Backfill existing rows to the bootstrap org.
    --   3. Drop the single-column PK; add composite PK (org_id, event_key).
    --      The composite key replaces the prior uniqueness guarantee.
    --   4. Index on org_id for efficient per-tenant fetches.
    ALTER TABLE email_template_overrides
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    DO $migrate_email_overrides_org$
    DECLARE
      bootstrap_org_id INTEGER;
      has_composite_pk BOOLEAN;
    BEGIN
      SELECT id INTO bootstrap_org_id
        FROM organizations
       WHERE archived_at IS NULL
       ORDER BY id ASC LIMIT 1;
      IF bootstrap_org_id IS NOT NULL THEN
        UPDATE email_template_overrides
           SET organization_id = bootstrap_org_id
         WHERE organization_id IS NULL;
      END IF;
      -- Swap to composite PK if we haven't already. Check by counting
      -- columns in the current PK; if there's just one (event_key), we
      -- need to migrate. If there are two (org_id + event_key), we're
      -- already on the new shape.
      SELECT (COUNT(*) > 1) INTO has_composite_pk
        FROM information_schema.key_column_usage
       WHERE table_name = 'email_template_overrides'
         AND constraint_name = 'email_template_overrides_pkey';
      IF NOT has_composite_pk THEN
        ALTER TABLE email_template_overrides DROP CONSTRAINT IF EXISTS email_template_overrides_pkey;
        ALTER TABLE email_template_overrides
          ADD CONSTRAINT email_template_overrides_pkey
          PRIMARY KEY (organization_id, event_key);
      END IF;
    END
    $migrate_email_overrides_org$;
    CREATE INDEX IF NOT EXISTS idx_email_template_overrides_org
      ON email_template_overrides(organization_id);

    -- Organization invitations — system-admin onboarding flow.
    -- A system admin enters an email + proposed org name; we create
    -- a row here, generate a token, and email the recipient with an
    -- accept link. When they click and submit a password we create
    -- the org + owner user and mark accepted_at.
    --
    -- Tokens are random 32-byte hex (64 chars). Expire after 7 days
    -- by default. Single-use — once accepted_at is set, subsequent
    -- accept attempts return 409.
    CREATE TABLE IF NOT EXISTS org_invitations (
      id              SERIAL PRIMARY KEY,
      email           TEXT NOT NULL,
      org_name        TEXT NOT NULL,
      token           TEXT NOT NULL UNIQUE,
      invited_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      expires_at      TIMESTAMPTZ NOT NULL,
      accepted_at     TIMESTAMPTZ,
      accepted_org_id INTEGER REFERENCES organizations(id) ON DELETE SET NULL,
      accepted_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_org_invitations_token
      ON org_invitations(token);
    CREATE INDEX IF NOT EXISTS idx_org_invitations_pending
      ON org_invitations(created_at DESC) WHERE accepted_at IS NULL;

    -- Schedule page: production entries placed on the calendar.
    -- Phase 2 of the schedule feature — replaces the localStorage
    -- shim from Phase 1 with server-persisted, multi-device-synced
    -- entries. crew is a JSONB array of user ids assigned to the day.
    CREATE TABLE IF NOT EXISTS schedule_entries (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      start_date DATE NOT NULL,
      days INTEGER NOT NULL DEFAULT 1 CHECK (days >= 1 AND days <= 365),
      crew JSONB NOT NULL DEFAULT '[]'::jsonb,    -- [user_id, ...]
      includes_weekends BOOLEAN NOT NULL DEFAULT FALSE,
      status TEXT NOT NULL DEFAULT 'planned',     -- 'planned' | 'in-progress' | 'done' | 'rolled-over'
      notes TEXT,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_schedule_entries_job ON schedule_entries(job_id);
    CREATE INDEX IF NOT EXISTS idx_schedule_entries_start ON schedule_entries(start_date);
    CREATE INDEX IF NOT EXISTS idx_schedule_entries_status ON schedule_entries(status);

    -- SMS audit log — every inbound text from a worker and every
    -- outbound reply we sent back. Used for debugging the intent
    -- matcher and to give admins a paper trail of what the bot said.
    -- direction: 'in' (worker → us) or 'out' (us → worker).
    -- intent: matched keyword for inbound rows ('today', 'next', etc.)
    -- or the trigger that produced an outbound row.
    -- user_id may be NULL on inbound when the phone doesn't match a
    -- known user (we still log unknown senders so admins can spot a
    -- forgotten employee or a wrong number).
    CREATE TABLE IF NOT EXISTS sms_log (
      id BIGSERIAL PRIMARY KEY,
      direction TEXT NOT NULL CHECK (direction IN ('in','out')),
      from_number TEXT NOT NULL,
      to_number TEXT NOT NULL,
      body TEXT NOT NULL,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      intent TEXT,
      twilio_sid TEXT,
      error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_sms_log_user ON sms_log(user_id) WHERE user_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_sms_log_created ON sms_log(created_at DESC);

    -- AI eval harness — curated fixtures we replay against the agents to
    -- catch regressions when prompts / models / skill packs change.
    --
    -- One row = one fixture. The kind column discriminates the runner
    -- (today only estimate_draft which replays a known estimate
    -- snapshot through AG with a known prompt and scores the response).
    -- The fixture column carries everything the runner needs to
    -- reconstruct context (estimate id, photo refs, user prompt).
    -- The expected_signals column describes pass/fail criteria —
    -- keyword presence, line-count ranges, total within +/- pct.
    --
    -- Idempotent so repeat init() calls do not error.
    CREATE TABLE IF NOT EXISTS ai_evals (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'estimate_draft',
      description TEXT,
      fixture JSONB NOT NULL,
      expected_signals JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- One row per replay. Lets us see whether a fixture passed/failed
    -- across model / prompt changes over time.
    CREATE TABLE IF NOT EXISTS ai_eval_runs (
      id TEXT PRIMARY KEY,
      eval_id TEXT NOT NULL REFERENCES ai_evals(id) ON DELETE CASCADE,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      run_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      model TEXT,
      input_tokens INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      passed BOOLEAN,
      score JSONB,         -- per-signal pass/fail breakdown
      response_text TEXT,
      tool_calls JSONB,    -- array of {name, input}
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_eval_runs_eval ON ai_eval_runs(eval_id, run_at DESC);
    -- Idempotent column add — captures the effort param used on each run
    -- so the history can show whether runs were on xhigh / high / etc.
    ALTER TABLE ai_eval_runs ADD COLUMN IF NOT EXISTS effort TEXT;

    -- Managed-agents registry — Phase 1a of the Anthropic Agents API
    -- migration. Each row maps a Project 86 agent key (ag/job/cra/staff) to
    -- the Anthropic-side Agent record id. Bootstrapped via the admin
    -- "Register managed agents" button. The chat path hasn't migrated
    -- yet (still on messages.stream); this row is what the v2 chat
    -- endpoint will reference once we cut over.
    -- system_hash + tools_hash + skills_hash let us detect drift —
    -- if the local definition diverges from what was registered, the
    -- bootstrap can update the agent instead of leaving stale config.
    CREATE TABLE IF NOT EXISTS managed_agent_registry (
      agent_key TEXT PRIMARY KEY,                          -- 'job' (post-unification — was 'ag'|'job'|'cra'|'staff')
      anthropic_agent_id TEXT NOT NULL,
      model TEXT,
      tool_count INTEGER NOT NULL DEFAULT 0,
      skill_count INTEGER NOT NULL DEFAULT 0,
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Phase 2c: move from one-agent-per-key to one-agent-per-(key, org).
    -- Each tenant gets their own Anthropic agent so the registered
    -- system prompt can carry per-org identity (identity_body from the
    -- organizations table). Migration steps below are idempotent so a
    -- re-run on a deployment that already migrated is a no-op.
    ALTER TABLE managed_agent_registry
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    -- Backfill: existing rows belong to AGX (the only tenant so far).
    UPDATE managed_agent_registry
       SET organization_id = (SELECT id FROM organizations WHERE slug = 'agx')
     WHERE organization_id IS NULL;
    -- Re-key: drop the old single-column PK and replace with the
    -- composite (agent_key, organization_id). Wrapped in DO so a
    -- re-run (where the PK is already composite) doesn't error.
    DO $migrate_mar_pk$
    BEGIN
      IF EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'managed_agent_registry'::regclass
           AND contype = 'p'
           AND conname = 'managed_agent_registry_pkey'
           AND array_length(conkey, 1) = 1
      ) THEN
        ALTER TABLE managed_agent_registry DROP CONSTRAINT managed_agent_registry_pkey;
        ALTER TABLE managed_agent_registry
          ADD CONSTRAINT managed_agent_registry_pkey PRIMARY KEY (agent_key, organization_id);
      END IF;
    END
    $migrate_mar_pk$;
    CREATE INDEX IF NOT EXISTS idx_managed_agent_registry_org
      ON managed_agent_registry(organization_id);

    -- Phase 1b — single shared Anthropic-side Environment that all our
    -- managed agents' Sessions provision containers from. We only ever
    -- need one row here ('default'); the env_key column lets us add more
    -- later (e.g. a restricted-network env) without a schema migration.
    CREATE TABLE IF NOT EXISTS managed_environment_registry (
      env_key TEXT PRIMARY KEY,                            -- 'default'
      anthropic_environment_id TEXT NOT NULL,
      networking TEXT NOT NULL DEFAULT 'unrestricted',
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    -- Project 86 Agent Platform — Phase S2 (Crew scaffolding)
    --
    -- Declarative SPEC for every staff agent the platform supports.
    -- managed_agent_registry holds the per-tenant Anthropic-side id;
    -- THIS table answers "what staff agents exist and what's each
    -- one's job, tool set, and routing role?"
    --
    -- Tier 1 row = the Principal (86 itself). Tier 2 = standing
    -- staff seeded at boot (Estimator, PM, Scheduler, Directory,
    -- Sales, Books, Subs, Proposal, CoS — but only the ones we've
    -- actually built). Tier 3 = dynamic agents 86 spawns via
    -- propose_create_staff_agent on user approval.
    --
    -- The tool_keys array lists the names of custom tools this staff
    -- agent should have attached at registration. routing_hints is
    -- the principal's LangGraph-style guide for when to delegate
    -- to this staff. archived_at lets us retire a dynamic agent
    -- without losing the audit trail (Anthropic-side agent stays
    -- archivable via managed_agent_registry separately).
    CREATE TABLE IF NOT EXISTS staff_agents (
      id SERIAL PRIMARY KEY,
      organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE,
      agent_key TEXT NOT NULL,                             -- e.g. '86-estimator', '86-pm', '86-sub-compliance'
      display_name TEXT NOT NULL,                          -- e.g. '86 · Estimator'
      tier INTEGER NOT NULL DEFAULT 2,                     -- 1 principal / 2 standing / 3 dynamic
      role_card TEXT NOT NULL DEFAULT '',                  -- one-paragraph job description (read by principal)
      system_prompt TEXT,                                  -- optional override of the default baseline
      tool_keys JSONB NOT NULL DEFAULT '[]'::jsonb,        -- array of custom tool names
      skill_pack_ids JSONB NOT NULL DEFAULT '[]'::jsonb,   -- array of org_skill_packs.id values
      trigger_rules JSONB NOT NULL DEFAULT '{}'::jsonb,    -- cron / event / on-demand-only
      routing_hints JSONB NOT NULL DEFAULT '{}'::jsonb,    -- principal's guide for "when to delegate here"
      spawned_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      spawned_by TEXT,                                     -- 'system' (Tier 2 seed) or user_id (Tier 3 approval)
      archived_at TIMESTAMPTZ,
      UNIQUE (organization_id, agent_key)
    );
    CREATE INDEX IF NOT EXISTS idx_staff_agents_org ON staff_agents(organization_id) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_staff_agents_tier ON staff_agents(tier) WHERE archived_at IS NULL;

    -- Phase 2 native-skills assignment — per-agent attachment of
    -- native Anthropic Skills (skill_id values from beta.skills.create).
    -- Replaces the legacy "scan app_settings.agent_skills for packs
    -- whose agents[] includes this agent" path. The runtime collector
    -- (collectSkillsFor in admin-agents-routes.js) UNIONs this table
    -- with the legacy source so existing assignments keep working
    -- while admins migrate.
    --
    -- position is 0-based ordering — Anthropic respects skill order
    -- in the agent definition, so we preserve it. enabled lets the
    -- admin temporarily detach a skill without losing the row.
    CREATE TABLE IF NOT EXISTS managed_agent_skills (
      agent_key TEXT NOT NULL,                             -- matches managed_agent_registry.agent_key
      skill_id TEXT NOT NULL,                              -- Anthropic-side skill id from beta.skills.create
      position INTEGER NOT NULL DEFAULT 0,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      PRIMARY KEY (agent_key, skill_id)
    );
    CREATE INDEX IF NOT EXISTS idx_managed_agent_skills_agent ON managed_agent_skills(agent_key, position);

    -- Reference links the AI agents see in their system prompt.
    -- Each row points at a SharePoint / OneDrive XLSX share URL that
    -- the server fetches + parses + caches; the parsed rows are
    -- injected into every agent turn so the agents have live access
    -- to whatever accounting publishes there (job-number lookup, WIP
    -- report, etc.). Cached XLSX content lives in last_fetched_text
    -- so a render doesn't have to re-fetch on every turn — a 15-min
    -- TTL refresh runs in the background.
    --
    -- last_fetch_status: 'ok' | 'failed' | 'never'.
    -- last_fetched_text holds a CSV-ish preview of the parsed sheet
    -- that's safe to embed in the system prompt directly.
    CREATE TABLE IF NOT EXISTS agent_reference_links (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT TRUE,
      max_rows INTEGER NOT NULL DEFAULT 200,
      last_fetched_at TIMESTAMPTZ,
      last_fetch_status TEXT NOT NULL DEFAULT 'never',
      last_fetch_error TEXT,
      last_fetched_text TEXT,
      last_fetched_row_count INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_agent_reference_links_enabled ON agent_reference_links(enabled);
    -- inject_mode controls whether the sheet's body rides inline in the
    -- registered agent system prompt (always cached, fast lookup but
    -- expensive on cache rebuilds) or stays out-of-band and is reached
    -- on demand via the search_reference_sheet tool. Default 'lookup'
    -- so adding a new sheet doesn't bloat every turn's prompt; admins
    -- opt specific sheets into 'inline' from the editor when they
    -- want always-on visibility (typically tiny cheat sheets).
    ALTER TABLE agent_reference_links
      ADD COLUMN IF NOT EXISTS inject_mode TEXT NOT NULL DEFAULT 'lookup'
        CHECK (inject_mode IN ('inline', 'lookup'));

    -- Phase D — reference links go org-scoped so the table is correct
    -- for the multi-tenant case from day one (today AGX is the only
    -- tenant; bootstrap row gets backfilled to that org). Without this
    -- a future second tenant would inherit the first tenant's
    -- SharePoint URLs. Idempotent: ADD COLUMN IF NOT EXISTS + a
    -- conditional UPDATE that only fires while rows are still NULL.
    ALTER TABLE agent_reference_links
      ADD COLUMN IF NOT EXISTS organization_id INTEGER REFERENCES organizations(id) ON DELETE CASCADE;
    DO $migrate_ref_links_org$
    DECLARE
      bootstrap_org_id INTEGER;
    BEGIN
      -- Pick the lowest-id non-archived org as the backfill target.
      -- On a single-tenant deploy that is AGX; on a fresh deploy with
      -- no orgs yet there's nothing to backfill (the column stays NULL
      -- until the admin assigns the row to a tenant).
      SELECT id INTO bootstrap_org_id
        FROM organizations
       WHERE archived_at IS NULL
       ORDER BY id ASC LIMIT 1;
      IF bootstrap_org_id IS NOT NULL THEN
        UPDATE agent_reference_links
           SET organization_id = bootstrap_org_id
         WHERE organization_id IS NULL;
      END IF;
    END
    $migrate_ref_links_org$;
    CREATE INDEX IF NOT EXISTS idx_agent_reference_links_org
      ON agent_reference_links(organization_id) WHERE organization_id IS NOT NULL;

    -- (Migration block for the legacy estimator-agent retirement was
    -- originally here, but it referenced ai_sessions which is created
    -- BELOW this point in the same SQL template. Moved out to a
    -- separate pool.query after the main template runs — see init()
    -- below.)

    -- Phase 1b — durable mapping from (agent_key, entity, user) to
    -- the long-lived Anthropic Session that backs that conversation.
    -- We reuse one Session per Project 86 conversation so we don't pay session-
    -- creation latency on every turn AND so the Anthropic side gets the
    -- benefit of accumulated session context (built-in compaction, prompt
    -- caching, the works). entity_type lets one table cover estimates,
    -- jobs, clients, and the staff (singleton) agent.
    --
    -- entity_id is nullable for staff (Chief of Staff has no entity).
    -- archived_at lets us terminate a session (delete or archive on the
    -- Anthropic side) and create a fresh one on the next turn — used
    -- when context has gotten so stale that compaction can't save it,
    -- or when an admin wants a clean-slate replay.
    CREATE TABLE IF NOT EXISTS ai_sessions (
      id BIGSERIAL PRIMARY KEY,
      agent_key TEXT NOT NULL,                             -- 'ag' | 'job' | 'cra' | 'staff'
      entity_type TEXT NOT NULL,                           -- 'estimate' | 'job' | 'client' | 'staff' | 'general'
      entity_id TEXT,                                      -- estimate id / job id / client id; NULL for general
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      anthropic_session_id TEXT NOT NULL,
      anthropic_agent_id TEXT NOT NULL,                    -- snapshot at create time
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );

    -- Sidebar-driven session columns (added when sessions became
    -- user-pickable from a left-rail list, like Claude Code). label is
    -- shown in the sidebar row; summary is a one-line auto-generated
    -- description set after the first turn; pinned floats the row to
    -- the top of the list; turn_count / total_cost_usd are display
    -- counters. effort_override lets the user dial individual sessions
    -- up to 'max' for deep-dive work without changing the global
    -- default.
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS label TEXT;
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS summary TEXT;
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS pinned BOOLEAN NOT NULL DEFAULT FALSE;
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS turn_count INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS total_cost_usd NUMERIC(12,6) NOT NULL DEFAULT 0;
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS effort_override TEXT;

    -- The old unique-active index enforced "one session per (agent,
    -- entity, user)" — the legacy single-thread-per-context model.
    -- The sidebar architecture allows many sessions per context, so
    -- the unique constraint is gone. The replacement indexes below
    -- speed up the two queries that actually matter:
    --   1. user's sidebar (latest sessions for this user)
    --   2. auto-anchor (most-recent session for user+context)
    DROP INDEX IF EXISTS idx_ai_sessions_active;
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_last
      ON ai_sessions(user_id, last_used_at DESC) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_context
      ON ai_sessions(user_id, entity_type, entity_id, last_used_at DESC)
      WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_last_used
      ON ai_sessions(last_used_at DESC);

    -- Unified-86 Phase 4a — one rolling session per user instead of
    -- one per (user, entity_type, entity_id). session_kind discrimin-
    -- ates between new user-thread rows ('user_thread') and pre-
    -- cutover rows ('legacy_partitioned'); the resolver picks the
    -- right shape and the sidebar can group them visually (legacy
    -- rows collapse under an "Archive" header). last_compacted_at
    -- records the last server-side compaction event so the resolver
    -- knows when to trigger the next one (~150k input tokens
    -- threshold). Both columns are idempotent ADDs with safe defaults
    -- — existing rows backfill to 'legacy_partitioned' / NULL on
    -- migration, no data rewrite needed.
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS session_kind TEXT NOT NULL DEFAULT 'legacy_partitioned';
    ALTER TABLE ai_sessions ADD COLUMN IF NOT EXISTS last_compacted_at TIMESTAMPTZ;
    -- Fast lookup of "the user-thread for this user" — used by the
    -- new resolveSessionForChat path. archived_at filter so
    -- abandoned threads (manual delete, stuck-session recovery)
    -- don't shadow the active one.
    CREATE INDEX IF NOT EXISTS idx_ai_sessions_user_thread
      ON ai_sessions(user_id, last_used_at DESC)
      WHERE session_kind = 'user_thread' AND archived_at IS NULL;

    -- Backfill labels for pre-sidebar rows so the sidebar UI doesn't
    -- show blank labels on existing sessions. "General" for the
    -- catch-all (entity_type='86' historically meant the global
    -- thread). Entity-anchored rows get a placeholder label that the
    -- UI / auto-label flow will replace on next turn.
    UPDATE ai_sessions
       SET label = CASE
         WHEN entity_type IN ('86', 'general', 'ask86') THEN 'General'
         WHEN entity_id IS NOT NULL THEN INITCAP(entity_type) || ' ' || entity_id
         ELSE INITCAP(entity_type)
       END
     WHERE label IS NULL;

    -- Heal any pre-sidebar general-session rows that have entity_id=NULL.
    -- The chat path keys ai_messages.estimate_id by the session's
    -- entity_id, and ai_messages.estimate_id is NOT NULL — so a session
    -- with entity_id=NULL would 500 every chat turn. 'global' is the
    -- legacy sentinel the original /86/chat code used.
    UPDATE ai_sessions
       SET entity_id = 'global'
     WHERE entity_type = 'general' AND entity_id IS NULL;

    -- Batch jobs — wraps Anthropic's Batches API for proactive
    -- analyses (currently nightly 86 audits across active jobs).
    -- Each row tracks one submitted batch + its lifecycle.
    -- anthropic_batch_id is the id returned by anthropic.beta.messages.
    -- batches.create. status mirrors Anthropic's processing_status
    -- ("in_progress"|"canceling"|"ended") with a few extra terminal
    -- states ("failed", "submitted") for client display.
    -- results stores per-request output (custom_id + assistant text +
    -- usage) once the batch ends; null until then.
    -- request_count lets the UI show "12 jobs in batch" without
    -- decoding results.
    CREATE TABLE IF NOT EXISTS batch_jobs (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,                                  -- always 'job' (86)
      kind TEXT NOT NULL DEFAULT 'audit',                   -- only 'audit' today
      anthropic_batch_id TEXT,
      status TEXT NOT NULL DEFAULT 'submitted',
      request_count INTEGER NOT NULL DEFAULT 0,
      submitted_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      submitted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at TIMESTAMPTZ,
      results JSONB,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_batch_jobs_submitted ON batch_jobs(submitted_at DESC);
    CREATE INDEX IF NOT EXISTS idx_batch_jobs_status ON batch_jobs(status);

    -- Skill-pack version history — every PUT /api/settings/agent_skills
    -- snapshots the prior value into this table before overwriting.
    -- Lets admins see who changed what and roll back via the
    -- /api/admin/agents/skills/versions endpoints. value carries the
    -- full agent_skills blob (skills array). saved_at is when the
    -- snapshot was taken (= when the user clicked Save). comment is
    -- optional; admins can label major edits.
    CREATE TABLE IF NOT EXISTS agent_skills_versions (
      id BIGSERIAL PRIMARY KEY,
      saved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      saved_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      value JSONB NOT NULL,
      comment TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_agent_skills_versions_saved ON agent_skills_versions(saved_at DESC);

    -- Conversation replays — sandboxed re-runs of an existing
    -- conversation (or a prefix of it) under different model / effort /
    -- system-prefix params. Stored separately from ai_messages so a
    -- replay never pollutes a real user thread or skews metrics.
    --
    -- Conversation key is the same entity_type|entity_id|user_id triple
    -- the admin agents page surfaces. from_index is the message offset
    -- to start replaying from (0 = full conversation, N = last user
    -- message at index N becomes the new turn).
    CREATE TABLE IF NOT EXISTS ai_replays (
      id TEXT PRIMARY KEY,
      conversation_key TEXT NOT NULL,
      from_index INTEGER NOT NULL DEFAULT 0,
      model_override TEXT,
      effort_override TEXT,
      system_prefix TEXT,
      run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      run_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      input_tokens INTEGER,
      output_tokens INTEGER,
      duration_ms INTEGER,
      response_text TEXT,
      tool_calls JSONB,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_ai_replays_conv ON ai_replays(conversation_key, run_at DESC);

    -- ai_subtasks — Phase 3 (parallel work / sub-agent fan-out).
    -- 86 spawns these via the spawn_subtask tool. Each row is a child
    -- Anthropic session running on the same per-org managed agent, with
    -- an isolated context window so parallel fan-out doesn't poison
    -- the parent. parent_session_id binds back to the ai_sessions row
    -- that spawned it so we can show nested progress in the chat UI
    -- and roll up token cost.
    --
    -- status lifecycle: pending → running → completed | failed | canceled.
    -- 'pending' is the brief window between spawn_subtask returning
    -- and the background runner picking it up; usually milliseconds.
    --
    -- depth caps recursion: a subtask cannot spawn its own subtasks
    -- (depth 0 = top-level user turn, depth 1 = subtask). Enforced in
    -- the spawn_subtask handler, not the schema, but recorded here for
    -- audit visibility.
    --
    -- result is the final assistant text on completion; error is set
    -- on failure. Both null while running.
    --
    -- tokens columns mirror ai_messages so cost rollups treat subtask
    -- usage the same as direct user turns.
    CREATE TABLE IF NOT EXISTS ai_subtasks (
      id TEXT PRIMARY KEY,
      parent_session_id BIGINT NOT NULL REFERENCES ai_sessions(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      agent_key TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 1,
      title TEXT,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      anthropic_session_id TEXT,
      anthropic_agent_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_ai_subtasks_parent ON ai_subtasks(parent_session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_subtasks_status ON ai_subtasks(status) WHERE status IN ('pending','running');
    CREATE INDEX IF NOT EXISTS idx_ai_subtasks_org ON ai_subtasks(organization_id, created_at DESC);

    -- ai_memories — Phase 4 (long-term semantic memory).
    -- 86 stores cross-session facts here so the user doesn't have to
    -- repeat themselves: preferences ("John prefers margin shown as a
    -- percentage on estimates"), per-client quirks ("Solace project
    -- has a 4pm delivery cutoff at the gate"), decisions ("we standardized
    -- on PT 2x4s for porch framing in Q1 2026").
    --
    -- scope = 'user' — memory visible only to the user who saved it
    -- scope = 'org'  — memory visible to every user in the org
    --
    -- kind is a soft category: 'preference' | 'fact' | 'decision' |
    -- 'context'. Free-text so 86 can invent new ones.
    --
    -- topic is the short retrieval key; body is the actual content.
    -- importance (1-10) breaks ties when many memories match a query.
    -- last_recalled_at gets bumped on each recall hit so a per-topic
    -- "recency" signal feeds back into ranking.
    --
    -- Soft delete via archived_at (the forget tool sets this, never
    -- DELETE — preserves audit trail and recovery).
    CREATE TABLE IF NOT EXISTS ai_memories (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      scope TEXT NOT NULL DEFAULT 'user',
      kind TEXT NOT NULL DEFAULT 'fact',
      topic TEXT NOT NULL,
      body TEXT NOT NULL,
      source TEXT NOT NULL DEFAULT 'explicit',
      importance INTEGER NOT NULL DEFAULT 5,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_recalled_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ai_memories_org_user
      ON ai_memories (organization_id, user_id)
      WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_memories_topic
      ON ai_memories (organization_id, topic)
      WHERE archived_at IS NULL;
    -- Block exact duplicates within (org, user, topic) so callers
    -- update instead of stacking near-identical rows.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_memories_unique_topic
      ON ai_memories (organization_id, user_id, topic)
      WHERE archived_at IS NULL;

    -- context_load_events — Wave 1.B context registry / observability.
    --
    -- One row per "piece of context that loaded for the AI". The point
    -- is to make the layered context model auditable: which memories
    -- got recalled, which entities got read, which skills attached,
    -- which turn_context bundles fired. Today we ship many layers but
    -- can only observe a couple of them; this is the cross-layer event
    -- log that powers the admin Context Registry page.
    --
    -- Design notes:
    --   • Layer is free text instead of an enum so we can add new
    --     layers (skill, watch, etc.) without a schema migration. The
    --     admin UI groups by this column.
    --   • item_id is TEXT because different layers reference different
    --     entities — memory ids and entity ids are both strings, skill
    --     names too. Don't enforce a foreign key.
    --   • item_meta JSONB carries layer-specific context (e.g. memory
    --     kind+importance, entity depth, search filter). Keep it small;
    --     it's read every time the registry view renders.
    --   • Fire-and-forget inserts — see server/services/context-registry.js
    --     for the helper. Logging failures must never break a tool
    --     call, so the helper swallows errors.
    -- Wave 3 — compliance_items.
    -- Unified table for client COIs, license renewals, lien waivers,
    -- and any other "thing that expires and needs renewal" workflow.
    -- Same shape as job_workflow_items but anchored on a flexible
    -- entity (client / sub / employee / job) with an expiration date
    -- as the primary scanning key.
    --
    -- type ∈ ('client_coi' | 'license' | 'lien_waiver' | 'wc_cert' | 'other')
    -- status ∈ ('active' | 'pending' | 'expired' | 'archived')
    --   active   — in force, not yet expiring within 30 days
    --   pending  — uploaded but awaiting approval
    --   expired  — past expiration_date (auto-set by lookup/scan)
    --   archived — soft-deleted; not surfaced anywhere
    --
    -- entity_type / entity_id reference what the cert is FOR:
    --   client_coi      → entity_type='client', entity_id=clients.id
    --   license         → entity_type='sub' or 'user' (for employees)
    --   lien_waiver     → entity_type='job', entity_id=jobs.id (with
    --                     metadata: {sub_id, amount, period_through})
    --   wc_cert         → entity_type='sub' or 'client'
    --
    -- metadata JSONB carries type-specific detail:
    --   client_coi:   {carrier, policy_number, holder_name, liability_amount}
    --   license:      {license_number, issuing_state, license_type}
    --   lien_waiver:  {sub_id, amount, period_through, waiver_type}
    --   wc_cert:      {carrier, policy_number, holder_name, exp_modifier}
    --
    -- file_attachment_id links to the uploaded PDF (an attachments row).
    -- Reminder cadence is computed on the fly from days-until-expiration.
    CREATE TABLE IF NOT EXISTS compliance_items (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      entity_type TEXT NOT NULL CHECK (entity_type IN ('client', 'sub', 'user', 'job')),
      entity_id TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      title TEXT NOT NULL,
      effective_date DATE,
      expiration_date DATE,
      file_attachment_id TEXT REFERENCES attachments(id) ON DELETE SET NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      notes TEXT,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Per-entity list (e.g. all COIs on this client).
    CREATE INDEX IF NOT EXISTS idx_compliance_entity
      ON compliance_items (organization_id, entity_type, entity_id)
      WHERE archived_at IS NULL;
    -- Expiration scanning — "show me everything expiring in the next
    -- 30 days". Partial index on the open items with a date.
    CREATE INDEX IF NOT EXISTS idx_compliance_expiring
      ON compliance_items (organization_id, expiration_date)
      WHERE archived_at IS NULL AND expiration_date IS NOT NULL;
    -- Type rollup for org-wide reporting.
    CREATE INDEX IF NOT EXISTS idx_compliance_type
      ON compliance_items (organization_id, type, status)
      WHERE archived_at IS NULL;

    -- Wave 3 — job_workflow_items.
    -- One unified table for RFIs, submittals, and transmittals
    -- (construction-trade workflows that all share the same shape:
    -- a job-scoped item with status, due date, responsible party, and
    -- type-specific detail in JSONB). Treating them as one table:
    --   • Cuts CRUD surface by 3× (one route file, one UI page)
    --   • Mirrors how field reports already work (polymorphic via type)
    --   • Per-type validation lives in the route layer where it can
    --     evolve without schema migrations
    --
    -- type ∈ ('rfi' | 'submittal' | 'transmittal')
    -- status (validated per type at route layer):
    --   rfi:         'open' | 'answered' | 'closed'
    --   submittal:   'submitted' | 'approved' | 'revise_resubmit' | 'rejected' | 'closed'
    --   transmittal: 'pending' | 'sent' | 'received'
    --
    -- metadata JSONB carries type-specific fields:
    --   rfi:         {question, response, response_by_user_id, response_at}
    --   submittal:   {category, spec_section, response, response_by_user_id, response_at}
    --   transmittal: {recipient_name, recipient_email, method, document_ids[]}
    --
    -- number is auto-assigned per (job, type) — RFI-01, RFI-02, SUB-01,
    -- TRX-01, etc. The route handler computes it at INSERT.
    CREATE TABLE IF NOT EXISTS job_workflow_items (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      type TEXT NOT NULL CHECK (type IN ('rfi', 'submittal', 'transmittal')),
      number TEXT,
      subject TEXT NOT NULL,
      body TEXT,
      status TEXT NOT NULL,
      due_date DATE,
      responsible_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      closed_at TIMESTAMPTZ,
      archived_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Primary access pattern: list by (job, type, open-status).
    CREATE INDEX IF NOT EXISTS idx_jwi_job_type_status
      ON job_workflow_items (job_id, type, status)
      WHERE archived_at IS NULL;
    -- "My open items" — list by responsible user.
    CREATE INDEX IF NOT EXISTS idx_jwi_responsible
      ON job_workflow_items (responsible_user_id, status)
      WHERE archived_at IS NULL AND responsible_user_id IS NOT NULL;
    -- Overdue scanning — partial index on still-open items with a due
    -- date in the past. Cheap rollup for the "needs attention" widget.
    CREATE INDEX IF NOT EXISTS idx_jwi_due_open
      ON job_workflow_items (organization_id, due_date)
      WHERE archived_at IS NULL AND closed_at IS NULL AND due_date IS NOT NULL;
    -- Org-scoped list (admin overview).
    CREATE INDEX IF NOT EXISTS idx_jwi_org
      ON job_workflow_items (organization_id, type, status, created_at DESC)
      WHERE archived_at IS NULL;

    -- payloads.apply_error_detail — Wave 1.C structured-error capture.
    -- Existing apply_error column stays as the human-readable string;
    -- this JSONB column captures the structured shape the dispatcher
    -- can throw via PayloadValidationError so 86 (and the UI) can
    -- self-correct without parsing the message text. Shape:
    --   {op_index, target_index, code, field_path, expected, received, suggestion}
    -- Nullable; only populated when the dispatcher throws a
    -- PayloadValidationError. Plain Error throws still land in
    -- apply_error and leave this null.
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'payloads' AND column_name = 'apply_error_detail'
      ) THEN
        ALTER TABLE payloads ADD COLUMN apply_error_detail JSONB;
      END IF;
    END $$;

    -- payloads.apply_changeset — Wave 1.C before/after audit capture.
    -- Populated inside the dispatch transaction (applyPayload) with an
    -- array of {entity_type, id, before, after} row snapshots for every
    -- single-row entity a payload touches (client/estimate/job/lead/
    -- report). Enables "undo last payload" and feeds the dispatcher→
    -- memory feedback loop. Nullable; null on payloads applied before
    -- this column existed or that touched only structural/multi-row
    -- entity types (schedule/system).
    DO $$ BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
         WHERE table_name = 'payloads' AND column_name = 'apply_changeset'
      ) THEN
        ALTER TABLE payloads ADD COLUMN apply_changeset JSONB;
      END IF;
    END $$;

    CREATE TABLE IF NOT EXISTS context_load_events (
      id BIGSERIAL PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      layer TEXT NOT NULL,
      item_id TEXT,
      item_name TEXT,
      item_meta JSONB,
      loaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Primary access pattern: "what loaded for org X in the last N
    -- days, grouped by layer". Index covers org_id + loaded_at DESC.
    CREATE INDEX IF NOT EXISTS idx_context_load_events_org_time
      ON context_load_events (organization_id, loaded_at DESC);
    -- Secondary pattern: "show me every event for this specific item"
    -- (e.g. for a memory's use count over time).
    CREATE INDEX IF NOT EXISTS idx_context_load_events_item
      ON context_load_events (organization_id, layer, item_id, loaded_at DESC)
      WHERE item_id IS NOT NULL;

    -- ai_watches — Phase 5 (proactive watching).
    -- A watch is a recurring instruction 86 runs on its own (without a
    -- user prompt). cadence + time_of_day_utc define when. The runner
    -- creates a fresh Anthropic session per fire — runs aren't bound to
    -- any specific user turn; they live in their own ai_watch_runs row.
    --
    -- cadence enum:
    --   'hourly' — top of every hour
    --   'daily'  — once a day at time_of_day_utc (HH:MM)
    --   'weekly' — once a week, Monday at time_of_day_utc
    --
    -- next_fire_at gets recomputed on save AND on every fire. The
    -- scheduler picks up rows where next_fire_at <= NOW(), enabled is
    -- true, and archived_at IS NULL.
    --
    -- created_by_user_id is the user who set the watch up; runs use
    -- that user's id for context and ownership.
    CREATE TABLE IF NOT EXISTS ai_watches (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      description TEXT,
      cadence TEXT NOT NULL,
      time_of_day_utc TEXT,
      prompt TEXT NOT NULL,
      enabled BOOLEAN NOT NULL DEFAULT true,
      last_fired_at TIMESTAMPTZ,
      next_fire_at TIMESTAMPTZ NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_ai_watches_due
      ON ai_watches (next_fire_at)
      WHERE enabled AND archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_ai_watches_org
      ON ai_watches (organization_id, created_at DESC);

    -- ai_watch_runs — one row per fire. result holds the assistant's
    -- final reply; error holds the failure mode if the runner blew up.
    -- input_tokens / output_tokens roll up per run so admins see watch
    -- cost over time.
    CREATE TABLE IF NOT EXISTS ai_watch_runs (
      id TEXT PRIMARY KEY,
      watch_id TEXT NOT NULL REFERENCES ai_watches(id) ON DELETE CASCADE,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      triggered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      finished_at TIMESTAMPTZ,
      status TEXT NOT NULL DEFAULT 'pending',
      result TEXT,
      error TEXT,
      anthropic_session_id TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ai_watch_runs_watch
      ON ai_watch_runs (watch_id, triggered_at DESC);
    CREATE INDEX IF NOT EXISTS idx_ai_watch_runs_status
      ON ai_watch_runs (status)
      WHERE status IN ('pending','running');

    -- agent_jobs — user-initiated BACKGROUND agent tasks. 86 / the assistant hands
    -- a bigger task to the in-process worker (server/agent-jobs-worker.js), which runs
    -- the same headless agent loop (driveSubtaskTurn), pauses to ask the user when it
    -- needs a decision (status='needs_input' + pause_question), and resumes when they
    -- answer (pause_answer). Reads run free; any write pauses for approval. Notifies
    -- in-app + email + push on each state change.
    CREATE TABLE IF NOT EXISTS agent_jobs (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      session_id BIGINT REFERENCES ai_sessions(id) ON DELETE SET NULL,
      agent_key TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      title TEXT,
      prompt TEXT NOT NULL,
      payload JSONB NOT NULL DEFAULT '{}'::jsonb,
      pause_question TEXT,
      pause_kind TEXT,
      pause_answer TEXT,
      result TEXT,
      error TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      started_at TIMESTAMPTZ,
      paused_at TIMESTAMPTZ,
      completed_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      notified_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_claim
      ON agent_jobs (status, created_at)
      WHERE status IN ('queued','needs_input','running');
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_user
      ON agent_jobs (user_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_agent_jobs_org
      ON agent_jobs (organization_id, created_at DESC);
    ALTER TABLE agent_jobs ADD COLUMN IF NOT EXISTS seen_at TIMESTAMPTZ;

    -- push_subscriptions — Web Push endpoints (S7). One row per browser/device the
    -- user enabled notifications on (a user can have several devices); endpoint is
    -- the unique key. 404/410 from the push service prunes the row on send.
    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id SERIAL PRIMARY KEY,
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      last_used_at TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_push_subscriptions_user
      ON push_subscriptions (user_id);

    -- Extend ai_watches for agent-based watchers (Payload DSL v1).
    -- kind='rule' is the legacy SQL-condition watch; kind='agent' is a
    -- new LLM-driven scan where the watch-runner spins up a one-shot
    -- session against agent_key, injects an incremental scope (entities
    -- modified since last_scan_at), and the agent emits payload files
    -- with source='watcher_<agent_key>' via emit_payload_file. model +
    -- schedule_hours let admins tune cost/cadence per watcher.
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'rule';
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS agent_key TEXT;
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS scope_filter JSONB;
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS last_scan_at TIMESTAMPTZ;
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS model TEXT DEFAULT 'haiku';
    ALTER TABLE ai_watches ADD COLUMN IF NOT EXISTS schedule_hours INTEGER DEFAULT 12;
    CREATE INDEX IF NOT EXISTS idx_ai_watches_kind
      ON ai_watches (kind, next_fire_at)
      WHERE enabled AND archived_at IS NULL;

    -- payloads — Project 86 Payload DSL (v1).
    -- A payload is a single typed "work order" file 86 (or a background
    -- watcher) produces. The .p86.json file_content holds targets[] +
    -- ops + metadata; the user drags it into the universal dropbox in
    -- the AI panel to apply, and the server-side decoder dispatches each
    -- target.ops to existing write routes within a single PG transaction.
    --
    -- source tracks who emitted it. '86' for the Principal (sync user
    -- turn); 'watcher_<agent_key>' for background watchers; 'watch_rule'
    -- for legacy rule-based watches that produce payloads; 'csv_import',
    -- 'qb_sync', 'manual' for non-LLM sources. Single read endpoint with
    -- a source filter feeds the sidebar Payloads + admin audit view.
    --
    -- user_id is nullable so watcher-emitted payloads can land at org
    -- scope (any user in the org can review). Principal-emitted payloads
    -- always have a user_id (the user whose chat turn produced it).
    --
    -- targets is the denormalized array of {entity_type, entity_id} for
    -- indexed queries ("show me every payload touching this estimate").
    -- file_content holds the complete bundle including ops.
    --
    -- status lifecycle: ready → applied | rejected | expired | failed.
    -- No proposed/pending split — the file IS the proposal; drag is the
    -- commit. expired flips automatically after 7 days; rejected is the
    -- user explicitly dismissing.
    --
    -- expires_at is checked at apply time too, so a stale ready payload
    -- can't be dragged weeks later.
    CREATE TABLE IF NOT EXISTS payloads (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
      session_id BIGINT REFERENCES ai_sessions(id) ON DELETE SET NULL,
      parent_message_id TEXT REFERENCES ai_messages(id) ON DELETE SET NULL,
      source TEXT NOT NULL,
      emitting_agent_key TEXT,
      filename TEXT NOT NULL,
      file_content JSONB NOT NULL,
      targets JSONB NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      rationale TEXT,
      template_id TEXT,
      status TEXT NOT NULL DEFAULT 'ready',
      applied_at TIMESTAMPTZ,
      apply_summary TEXT,
      apply_error TEXT,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      expires_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '7 days')
    );
    CREATE INDEX IF NOT EXISTS idx_payloads_session
      ON payloads (session_id, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payloads_user_status
      ON payloads (user_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payloads_org_status
      ON payloads (organization_id, status, created_at DESC);
    CREATE INDEX IF NOT EXISTS idx_payloads_expiry
      ON payloads (expires_at)
      WHERE status = 'ready';
    CREATE INDEX IF NOT EXISTS idx_payloads_targets_gin
      ON payloads USING gin (targets jsonb_path_ops);
    CREATE INDEX IF NOT EXISTS idx_payloads_source
      ON payloads (organization_id, source, created_at DESC);

    -- payload_templates — user-pinnable recurring payloads ("recipes").
    -- A user (or 86 on the user's behalf) pins an applied payload as a
    -- template: ops_template carries the bundle with {{placeholder}}
    -- markers in fields that vary by use; parameters describes the
    -- expected placeholder names + types + descriptions. The recipe
    -- modal collects values, and the clone endpoint produces a concrete
    -- payload row.
    --
    -- description carries the "when to use + gotchas" wisdom that lives
    -- with the recipe (replaces what would have been agent_notes — see
    -- the v1 plan for the deduplication rationale).
    --
    -- is_pinned controls sidebar visibility; use_count + last_used_at
    -- power the "most-used recipes first" ordering. Soft delete via
    -- archived; unique (org, name) only enforced for non-archived rows
    -- so a recipe name can be reused after the prior version is retired.
    CREATE TABLE IF NOT EXISTS payload_templates (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      created_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      name TEXT NOT NULL,
      description TEXT,
      icon TEXT,
      parameters JSONB NOT NULL DEFAULT '[]'::jsonb,
      ops_template JSONB NOT NULL,
      origin_payload_id TEXT REFERENCES payloads(id) ON DELETE SET NULL,
      is_pinned BOOLEAN NOT NULL DEFAULT false,
      pinned_by_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TIMESTAMPTZ,
      archived BOOLEAN NOT NULL DEFAULT false,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_templates_unique_name
      ON payload_templates (organization_id, name)
      WHERE archived = false;
    CREATE INDEX IF NOT EXISTS idx_templates_pinned
      ON payload_templates (organization_id, is_pinned DESC, last_used_at DESC NULLS LAST)
      WHERE archived = false;

    -- Backfill the FK on payloads.template_id once payload_templates
    -- exists. Done as an ALTER (not in the CREATE TABLE above) to avoid
    -- a chicken-and-egg dependency on the table creation order during
    -- idempotent init.
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'payloads_template_id_fkey'
      ) THEN
        ALTER TABLE payloads
          ADD CONSTRAINT payloads_template_id_fkey
          FOREIGN KEY (template_id) REFERENCES payload_templates(id) ON DELETE SET NULL;
      END IF;
    END$$;

    -- org_mcp_servers — Phase 6 (MCP connectors). Per-tenant external
    -- tool reach: Gmail, Google Calendar, QuickBooks, Slack, etc.
    -- Each row is one MCP server URL the tenant has provisioned (either
    -- a self-hosted MCP server or an Anthropic-hosted connector with a
    -- shareable URL).
    --
    -- authorization_token is the optional bearer the agent sends with
    -- every MCP request. STORED IN PLAIN TEXT for now — system admins
    -- already see other tenant secrets; encrypting only this would be
    -- security theatre. TODO: when we introduce per-tenant KMS, encrypt
    -- this column.
    --
    -- (organization_id, name) is unique while not archived so the
    -- "gmail" label can only refer to one server per tenant; readers
    -- always pick the active row.
    CREATE TABLE IF NOT EXISTS org_mcp_servers (
      id TEXT PRIMARY KEY,
      organization_id INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      url TEXT NOT NULL,
      authorization_token TEXT,
      description TEXT,
      enabled BOOLEAN NOT NULL DEFAULT true,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at TIMESTAMPTZ
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_org_mcp_servers_unique
      ON org_mcp_servers (organization_id, name)
      WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_org_mcp_servers_enabled
      ON org_mcp_servers (organization_id)
      WHERE enabled AND archived_at IS NULL;

    -- Job-level reports — Project 86 "report" feature similar to
    -- CompanyCam: a user-curated photo collection grouped into named
    -- sections (Before / During / After by default, but renamable +
    -- extensible) with per-photo captions and a summary block at the
    -- top. Rendered to letter-page PDF via the browser's native print.
    --
    -- sections JSONB shape:
    --   [
    --     { id, label, photo_ids: [attachment_id, ...],
    --       captions: { attachment_id: 'text', ... } }
    --   ]
    --
    -- Photos reference the existing attachments table by id, so any
    -- photo already uploaded to the job (or to a building / phase /
    -- CO under the job) is available in the report's photo picker.
    -- No copy is made — if the attachment is deleted, the report
    -- silently drops it on next render.
    CREATE TABLE IF NOT EXISTS job_reports (
      id           TEXT PRIMARY KEY,
      job_id       TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      title        TEXT,
      summary      TEXT,
      sections     JSONB NOT NULL DEFAULT '[]'::jsonb,
      created_by   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_job_reports_job ON job_reports(job_id, updated_at DESC);

    -- Polymorphic refactor (Phase 2). Add nullable entity_type +
    -- entity_id columns alongside the legacy job_id so reports can
    -- belong to jobs OR projects (and later: leads, estimates).
    -- entity_type is NULL on existing rows; the backfill below stamps
    -- them as 'job' / job_id. Once every row has entity_type set,
    -- the job_id column can be dropped in a future migration. Until
    -- then both routes (legacy /api/jobs/:jobId/reports AND new
    -- /api/reports/:entityType/:entityId) work side-by-side.
    ALTER TABLE job_reports ADD COLUMN IF NOT EXISTS entity_type TEXT;
    ALTER TABLE job_reports ADD COLUMN IF NOT EXISTS entity_id   TEXT;
    UPDATE job_reports
       SET entity_type = 'job', entity_id = job_id
     WHERE entity_type IS NULL;
    -- Make job_id nullable so future project-scoped rows can leave it
    -- empty. Existing rows keep their job_id; new rows only need
    -- entity_type + entity_id.
    ALTER TABLE job_reports ALTER COLUMN job_id DROP NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_job_reports_entity
      ON job_reports(entity_type, entity_id, updated_at DESC)
      WHERE entity_type IS NOT NULL;
    -- Optional cover page (Phase 2). JSONB blob holds the toggle +
    -- overrides for company name, PM name, date, address. Defaults
    -- compose from the project + creating user at render time; the
    -- blob just stores what the user typed over the defaults plus
    -- the enabled flag.
    --
    -- Shape: { enabled: bool, company_name?, pm_name?, date?,
    --   address?, subtitle? }
    -- (Per-template cover field schemas — daily-log, weekly-progress,
    --  engineer's-report, submittal-package — are stored in this same
    --  JSONB without schema changes. The client decides which fields
    --  to surface based on template_type below.)
    ALTER TABLE job_reports ADD COLUMN IF NOT EXISTS cover_page JSONB NOT NULL DEFAULT '{}'::jsonb;

    -- Template type (Wave B). A short string id picking one of the
    -- baked-in report templates: walkthrough, daily-log,
    -- weekly-progress, engineers-report, submittal-package,
    -- punch-list, pre-con-survey, change-order. Drives section
    -- seeding on create + which cover fields the editor surfaces
    -- + print stylesheet selectors. Existing rows backfill to
    -- 'walkthrough' (matches the prior single-template behavior).
    ALTER TABLE job_reports ADD COLUMN IF NOT EXISTS template_type TEXT NOT NULL DEFAULT 'walkthrough';

    -- Visual style pack — orthogonal to template_type. template_type
    -- picks the CONTENT (which sections seed); style_pack picks the
    -- VISUAL THEME (fonts / colors / borders / cover treatment).
    -- Whitelisted IDs live in js/report-style-packs.js + server-side
    -- in normalizeStylePack. Existing rows backfill to 'clean'
    -- (matches the original look — no visual change for old reports).
    ALTER TABLE job_reports ADD COLUMN IF NOT EXISTS style_pack TEXT NOT NULL DEFAULT 'clean';

    -- ───────────────────────────────────────────────────────────────
    -- Projects — CompanyCam-style first-class entity that buckets
    -- photos + markups + reports around a single physical site /
    -- walkthrough. A project links to a lead (during sales), to a
    -- job (once sold), and to a client (the buyer). All three FKs
    -- are nullable so a project can exist before any of those exist
    -- and gets linked as the lifecycle progresses.
    --
    -- Cover photo: cover_attachment_id points at an attachments row
    -- (entity_type='project', entity_id=this project's id). If null,
    -- the UI falls back to the most-recent photo in the project.
    --
    -- Geocoding is denormalized onto the project so the projects map
    -- view can plot pins without fanning out to lead/job/client.
    -- address_text is the human-entered address; lat/lng are filled
    -- by the existing Census geocoder when the address is set or
    -- when the linked entity changes.
    CREATE TABLE IF NOT EXISTS projects (
      id                   TEXT PRIMARY KEY,
      organization_id      INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name                 TEXT NOT NULL,
      description          TEXT,
      -- attachments.id is TEXT (prefixed-timestamp id, e.g. att_…)
      -- so this FK must be TEXT too, not INTEGER. Earlier draft used
      -- INTEGER and crashed initSchema on first deploy.
      cover_attachment_id  TEXT REFERENCES attachments(id) ON DELETE SET NULL,
      lead_id              TEXT REFERENCES leads(id) ON DELETE SET NULL,
      job_id               TEXT REFERENCES jobs(id) ON DELETE SET NULL,
      client_id            TEXT REFERENCES clients(id) ON DELETE SET NULL,
      address_text         TEXT,
      geocode_lat          NUMERIC,
      geocode_lng          NUMERIC,
      status               TEXT NOT NULL DEFAULT 'active',
      created_by           INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at          TIMESTAMPTZ
    );
    CREATE INDEX IF NOT EXISTS idx_projects_org
      ON projects(organization_id, updated_at DESC) WHERE archived_at IS NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_lead
      ON projects(lead_id) WHERE lead_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_job
      ON projects(job_id) WHERE job_id IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_projects_client
      ON projects(client_id) WHERE client_id IS NOT NULL;

    -- Per-project tags. JSONB array of lowercase strings, capped at 20
    -- by the route layer. GIN index supports the @> containment filter
    -- (find projects tagged 'roof', etc.). jsonb_path_ops is the
    -- smaller index variant that's faster on the containment operator
    -- we actually use; if we later need ? / ?| / ?& we'd swap to the
    -- default jsonb_ops opclass.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS tags JSONB NOT NULL DEFAULT '[]'::jsonb;
    CREATE INDEX IF NOT EXISTS idx_projects_tags
      ON projects USING gin (tags jsonb_path_ops) WHERE archived_at IS NULL;

    -- Geocode result status ('ok' | 'failed'). 'failed' is sticky so the boot
    -- backfill doesn't re-hit the Census geocoder for the same unmatchable
    -- address on every restart; clearing happens when the address changes.
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS geocode_status TEXT;

    -- Before/After pairs — CompanyCam-style paired photos. Each row
    -- couples two attachments (both must have entity_type='project'
    -- and entity_id=<this row's project_id>; route layer enforces).
    -- ON DELETE CASCADE from either side intentionally drops the pair
    -- — same posture as job_reports' missing-photo handling: if a
    -- source photo is removed, the comparison loses meaning, so the
    -- pair silently disappears rather than rendering broken.
    CREATE TABLE IF NOT EXISTS project_pairs (
      id                    TEXT PRIMARY KEY,
      project_id            TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      before_attachment_id  TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      after_attachment_id   TEXT NOT NULL REFERENCES attachments(id) ON DELETE CASCADE,
      label                 TEXT,
      created_by            INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_pairs_project
      ON project_pairs(project_id, created_at DESC);

    -- Activity log for the project detail's timeline feed. One row
    -- per material mutation (photo added/removed, caption edited,
    -- tag changed, linkage changed, cover set, pair created/deleted,
    -- status changed, description/address edited). detail is a free
    -- JSONB payload whose shape is convention-defined per kind and
    -- rendered by the client. We don't enforce the shape with a
    -- CHECK constraint — kinds may evolve over time and a strict
    -- check would force migration coupling.
    --
    -- BIGSERIAL because at scale (many photos × many projects ×
    -- multiple edits each) this is the highest-volume table in the
    -- projects feature. INDEX is on (project_id, created_at DESC) to
    -- match the "show me the last N events for this project" query.
    CREATE TABLE IF NOT EXISTS project_activity (
      id              BIGSERIAL PRIMARY KEY,
      project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      actor_user_id   INTEGER REFERENCES users(id) ON DELETE SET NULL,
      kind            TEXT NOT NULL,
      detail          JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_project_activity_project
      ON project_activity(project_id, created_at DESC);

    -- ───────────────────────────────────────────────────────────────
    -- Tasks — Project 86's streamlined to-do / task entity. ONE
    -- polymorphic table (deliberately NOT separate punch/RFI/submittal
    -- tables): a kind discriminator (todo | punch | follow_up) covers
    -- the variants, and entity_type/entity_id link a task to ANY entity
    -- (job/lead/estimate/client/sub/project) the same way reports do —
    -- or stay NULL for a personal task. The design synthesizes
    -- Buildertrend (field assignment + due dates + photos), Todoist
    -- (fast single-line capture), and Asana (subtasks via the checklist
    -- JSONB), without Procore's separate-table sprawl.
    --
    -- checklist JSONB shape: [{ text: '…', done: bool }]  (subtasks)
    -- Photos attach via the attachments table with entity_type='task',
    -- entity_id=<this task's id> (see VALID_ENTITY_TYPES).
    CREATE TABLE IF NOT EXISTS tasks (
      id                TEXT PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      title             TEXT NOT NULL,
      notes             TEXT,
      kind              TEXT NOT NULL DEFAULT 'todo',     -- todo | punch | follow_up
      status            TEXT NOT NULL DEFAULT 'open',     -- open | in_progress | blocked | done
      priority          TEXT NOT NULL DEFAULT 'normal',   -- low | normal | high | urgent
      due_date          DATE,
      assignee_user_id  INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_by        INTEGER REFERENCES users(id) ON DELETE SET NULL,
      entity_type       TEXT,    -- polymorphic link (NULL = unlinked; NOT a privacy signal — see scope/owner_user_id)
      entity_id         TEXT,
      checklist         JSONB NOT NULL DEFAULT '[]'::jsonb,
      completed_at      TIMESTAMPTZ,
      archived_at       TIMESTAMPTZ,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Geolocated tasks: optional map pin (lat/lng) + field-capture accuracy +
    -- written directions/access notes. All optional; rendered as filterable pins
    -- on the job Site Plan map.
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lat REAL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS lng REAL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS geo_accuracy REAL;
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS directions TEXT;
    CREATE INDEX IF NOT EXISTS idx_tasks_geo ON tasks (lat, lng) WHERE lat IS NOT NULL AND lng IS NOT NULL;
    -- "My open tasks" — powers the My Tasks page default query.
    CREATE INDEX IF NOT EXISTS idx_tasks_assignee
      ON tasks(organization_id, assignee_user_id, status)
      WHERE archived_at IS NULL;
    -- Per-entity Tasks panel — mirrors reports' polymorphic index.
    CREATE INDEX IF NOT EXISTS idx_tasks_entity
      ON tasks(entity_type, entity_id, updated_at DESC)
      WHERE entity_type IS NOT NULL AND archived_at IS NULL;
    -- Due / Overdue quick filters + the optional task_due digest.
    CREATE INDEX IF NOT EXISTS idx_tasks_due
      ON tasks(organization_id, due_date)
      WHERE archived_at IS NULL AND status <> 'done';

    -- 3-tier model (Tasks / To-dos / Reminders). scope is the PRIVACY axis
    -- (org | personal), ORTHOGONAL to kind (work-type). Additive + SAFE:
    -- every existing row defaults to 'org' so it stays team-visible (no
    -- surprise hide; zero UPDATEs). A 'personal' task = a private To-do,
    -- visible ONLY to owner_user_id (fail-closed, like user_notes); for 'org'
    -- rows owner_user_id is NULL and ignored. NEVER derive personal-ness from
    -- kind='todo' (that's the column default — would mass-hide the backlog).
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS scope         TEXT NOT NULL DEFAULT 'org';
    ALTER TABLE tasks ADD COLUMN IF NOT EXISTS owner_user_id INTEGER REFERENCES users(id) ON DELETE CASCADE;
    -- ADD CONSTRAINT has no IF NOT EXISTS — guard so the boot-time re-run no-ops.
    DO $tasks_scope_chk$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'tasks_scope_chk') THEN
        ALTER TABLE tasks ADD CONSTRAINT tasks_scope_chk CHECK (scope IN ('org','personal'));
      END IF;
    END $tasks_scope_chk$;
    -- Personal To-do list + the privacy predicate (avoids a table scan).
    CREATE INDEX IF NOT EXISTS idx_tasks_personal
      ON tasks(organization_id, owner_user_id, status)
      WHERE scope = 'personal' AND archived_at IS NULL;

    -- ───────────────────────────────────────────────────────────────
    -- My Notes — a personal, PRIVATE scratchpad (Phase 1 / Deliverable
    -- 3). Unlike tasks (org-shared, assignee-driven), a note belongs to
    -- exactly one user in one org and is visible to NO other user. The
    -- routes (server/routes/notes-routes.js) filter every query by BOTH
    -- organization_id AND user_id, fail-closed. Index ordered to match
    -- the list query (pinned first, then most-recently-updated).
    CREATE TABLE IF NOT EXISTS user_notes (
      id               TEXT PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title            TEXT,
      body             TEXT,
      pinned           BOOLEAN NOT NULL DEFAULT false,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_user_notes_owner
      ON user_notes (organization_id, user_id, updated_at DESC);

    -- ───────────────────────────────────────────────────────────────
    -- Personal calendar events — the per-user Assistant calendar
    -- (unified-calendar Slice B). PRIVATE, owner+org scoped, fail-closed
    -- exactly like user_notes. Distinct from the production-scheduling
    -- job entries (schedule_entries / the Schedule tab); these are the
    -- user's own meetings / reminders / appointments that the unified
    -- calendar overlays as a "My Events" layer.
    --
    -- status drives the Outlook opaque/translucent bar styling:
    --   'confirmed' → opaque fill   'tentative' → translucent outline
    --   'canceled'  → translucent outline + strikethrough
    CREATE TABLE IF NOT EXISTS calendar_events (
      id               TEXT PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title            TEXT,
      starts_at        TIMESTAMPTZ NOT NULL,
      ends_at          TIMESTAMPTZ,
      all_day          BOOLEAN NOT NULL DEFAULT false,
      location         TEXT,
      notes            TEXT,
      color            TEXT,
      status           TEXT NOT NULL DEFAULT 'confirmed',
      recurrence       TEXT,
      reminder_minutes INTEGER,
      created_at       TIMESTAMPTZ DEFAULT NOW(),
      updated_at       TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_calendar_events_owner
      ON calendar_events (organization_id, user_id, starts_at);
    -- OPTIONAL polymorphic link to the entity this event/reminder is
    -- about (client | job | lead | project). NULL = a standalone personal
    -- appointment/reminder. Mirrors tasks.entity_type/entity_id. The
    -- Assistant defaults to linking the CLIENT when an event concerns a
    -- property, the JOB when it's active work, else leaves it NULL.
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS entity_type TEXT;
    ALTER TABLE calendar_events ADD COLUMN IF NOT EXISTS entity_id   TEXT;

    -- Per-user OAuth tokens for external mailbox/calendar providers
    -- (Phase 4: Microsoft 365 / Outlook). OWNER-SCOPED by (organization_id,
    -- user_id) — a tenant/system admin must NOT be able to read another
    -- user's mailbox token, so unlike org_mcp_servers these are NOT stored
    -- in the clear: access_token_enc / refresh_token_enc hold AES-256-GCM
    -- ciphertext from server/util/secretbox.js (key only in Railway env,
    -- never the DB). One row per (org, user, provider).
    CREATE TABLE IF NOT EXISTS oauth_tokens (
      id                SERIAL PRIMARY KEY,
      organization_id   INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id           INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      provider          TEXT NOT NULL DEFAULT 'microsoft',
      account_email     TEXT,                 -- which mailbox is connected (from /me)
      scope             TEXT,                 -- granted delegated scopes
      access_token_enc  TEXT,                 -- AES-256-GCM ciphertext (v1:iv:tag:ct)
      refresh_token_enc TEXT,                 -- AES-256-GCM ciphertext
      expires_at        TIMESTAMPTZ,          -- access-token expiry
      connected_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (organization_id, user_id, provider)
    );
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_owner
      ON oauth_tokens (organization_id, user_id, provider);
    CREATE INDEX IF NOT EXISTS idx_oauth_tokens_refresh
      ON oauth_tokens (provider, expires_at);
    -- MSAL serialized token cache (encrypted): the source of truth for the
    -- access + rolling refresh tokens. Supersedes access_token_enc/
    -- refresh_token_enc (kept nullable for compatibility). Idempotent add.
    ALTER TABLE oauth_tokens ADD COLUMN IF NOT EXISTS token_cache_enc TEXT;
    -- Per-entity lookup so a client/job page can list its appointments.
    CREATE INDEX IF NOT EXISTS idx_calendar_events_entity
      ON calendar_events (entity_type, entity_id, starts_at)
      WHERE entity_type IS NOT NULL;

    -- Reminders (3-tier model) — PERSONAL, timed, assistant-driven nudges on
    -- their OWN list, SEPARATE from calendar_event appointments. Owner-scoped
    -- (organization_id + user_id, both NOT NULL + CASCADE) like user_notes —
    -- fail-closed private. The reminders-cron emails at remind_at and stamps
    -- fired_at (the atomic per-row fire flag); status is the user's
    -- pending|done|dismissed lifecycle.
    CREATE TABLE IF NOT EXISTS reminders (
      id               TEXT PRIMARY KEY,
      organization_id  INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      user_id          INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title            TEXT NOT NULL,
      notes            TEXT,
      remind_at        TIMESTAMPTZ NOT NULL,
      status           TEXT NOT NULL DEFAULT 'pending',   -- pending | done | dismissed
      source           TEXT NOT NULL DEFAULT 'user',      -- user | assistant
      fired_at         TIMESTAMPTZ,                        -- set once the cron nudged it
      entity_type      TEXT,                               -- optional polymorphic link
      entity_id        TEXT,
      created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    -- Owner's list, soonest first.
    CREATE INDEX IF NOT EXISTS idx_reminders_owner
      ON reminders (organization_id, user_id, remind_at);
    -- Cron firing scan (system-wide; supports the atomic claim) — only unfired
    -- pending rows.
    CREATE INDEX IF NOT EXISTS idx_reminders_due
      ON reminders (remind_at)
      WHERE status = 'pending' AND fired_at IS NULL;
    -- Per-entity reminders panel.
    CREATE INDEX IF NOT EXISTS idx_reminders_entity
      ON reminders (entity_type, entity_id, remind_at)
      WHERE entity_type IS NOT NULL;

    -- ───────────────────────────────────────────────────────────────
    -- Plans & Takeoffs — first-class scale-drawing documents (the
    -- "dedicated home" for the Bluebeam-style markup tool). A plan is a
    -- drawing surface (blank gridded canvas / a photo / a PDF) plus its
    -- per-page calibration + measurement strokes + computed totals.
    --
    -- base_kind:
    --   'blank' → drawn from scratch; width/height/grid_spacing set the
    --             canvas; base_attachment_id NULL.
    --   'photo' → base_attachment_id points at an image attachment.
    --   'pdf'   → base_attachment_id points at a PDF attachment.
    --
    -- pages JSONB: per-page { calibration, strokes } — the SAME shape the
    -- markup viewer persists in attachments.annotations, but owned by the
    -- plan rather than an attachment (so blank canvases + standalone
    -- takeoffs are first-class). Shape:
    --   [{ page:0, calibration:{…}|null, strokes:[…] }, …]
    -- totals JSONB: cached headline numbers for the list view
    --   { lf:number, sf:number, count:number }  (recomputed on save)
    --
    -- entity_type/entity_id link a plan to ANY entity (job/lead/estimate/
    -- client/sub/project) the same polymorphic way reports + tasks do, or
    -- stay NULL for a standalone plan.
    CREATE TABLE IF NOT EXISTS plans (
      id                  TEXT PRIMARY KEY,
      organization_id     INTEGER NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      name                TEXT NOT NULL,
      base_kind           TEXT NOT NULL DEFAULT 'blank',   -- blank | photo | pdf
      base_attachment_id  TEXT REFERENCES attachments(id) ON DELETE SET NULL,
      width               INTEGER,                          -- blank canvas px
      height              INTEGER,                          -- blank canvas px
      grid_spacing        INTEGER NOT NULL DEFAULT 40,      -- blank grid px
      pages               JSONB NOT NULL DEFAULT '[]'::jsonb,
      totals              JSONB NOT NULL DEFAULT '{}'::jsonb,
      entity_type         TEXT,    -- polymorphic link (NULL = standalone)
      entity_id           TEXT,
      thumb_url           TEXT,
      created_by          INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      archived_at         TIMESTAMPTZ
    );
    -- Plans list (org-scoped, newest first).
    CREATE INDEX IF NOT EXISTS idx_plans_org
      ON plans(organization_id, updated_at DESC) WHERE archived_at IS NULL;
    -- Per-entity Plans panel — mirrors reports/tasks polymorphic index.
    CREATE INDEX IF NOT EXISTS idx_plans_entity
      ON plans(entity_type, entity_id, updated_at DESC)
      WHERE entity_type IS NOT NULL AND archived_at IS NULL;
  `);

  // ── Performance indexes: 86's read-tool surface (2026-05-23) ──────
  // The audit on 2026-05-23 mapped every SQL query 86 hits via its
  // read tools (read_entity, search_entities, read_clients,
  // read_leads, read_jobs, read_subs, read_past_estimate_lines,
  // search_my_sessions, etc.) and identified the missing-index
  // candidates ranked by impact. This block lands them.
  //
  // Two categories:
  //
  // 1. ORDER BY updated_at DESC scans on unbounded tables. These hit
  //    full sequential scans + in-memory sort. Plain B-tree DESC
  //    index turns them into index scans. Always safe to create.
  //
  // 2. ILIKE substring searches (`column ILIKE '%foo%'`). Plain
  //    B-tree indexes only help with prefix matches (`'foo%'`); for
  //    internal substrings we need pg_trgm (trigram) GIN indexes,
  //    which decompose the column into 3-char overlapping shingles
  //    and index those. Order-of-magnitude speedup on multi-column
  //    OR-of-ILIKEs (which is exactly what read_clients does across
  //    7 columns). REQUIRES the pg_trgm extension — if CREATE
  //    EXTENSION fails (some managed Postgres setups restrict role
  //    permissions), we log and skip the trigram block. The plain
  //    B-tree indexes still land.
  //
  // All indexes are CREATE INDEX IF NOT EXISTS so re-running is a
  // no-op on a hot DB.

  // Category 1 — plain B-tree DESC indexes for ORDER BY updated_at.
  // Safe on any Postgres role; no extension required.
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_leads_updated_at
      ON leads(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_jobs_updated_at
      ON jobs(updated_at DESC NULLS LAST);

    CREATE INDEX IF NOT EXISTS idx_estimates_updated_at
      ON estimates(updated_at DESC);

    CREATE INDEX IF NOT EXISTS idx_ai_messages_user_entity_created
      ON ai_messages(user_id, entity_type, created_at DESC);
  `);

  // Category 2 — pg_trgm GIN indexes. Wrapped in its own try/catch so
  // a permission failure on CREATE EXTENSION logs a warning and skips
  // the trigram indexes instead of crashing the schema init. (Railway,
  // Supabase, Neon all ship with pg_trgm pre-available in their
  // contrib bundle; most fresh roles can run CREATE EXTENSION on it.
  // Bare PG installs may need a superuser to enable it first.)
  try {
    await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    await pool.query(`
      -- read_clients ILIKEs 7 columns in an OR chain. Trigram
      -- indexes on the high-cardinality ones make the OR sargable.
      CREATE INDEX IF NOT EXISTS idx_clients_name_trgm
        ON clients USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_clients_company_name_trgm
        ON clients USING gin (company_name gin_trgm_ops)
        WHERE company_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_clients_community_name_trgm
        ON clients USING gin (community_name gin_trgm_ops)
        WHERE community_name IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_clients_city_trgm
        ON clients USING gin (city gin_trgm_ops)
        WHERE city IS NOT NULL;

      -- read_leads ILIKEs title + property_name.
      CREATE INDEX IF NOT EXISTS idx_leads_title_trgm
        ON leads USING gin (title gin_trgm_ops)
        WHERE title IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_leads_property_name_trgm
        ON leads USING gin (property_name gin_trgm_ops)
        WHERE property_name IS NOT NULL;

      -- read_subs ILIKEs subs.name + subs.contact_name.
      CREATE INDEX IF NOT EXISTS idx_subs_name_trgm
        ON subs USING gin (name gin_trgm_ops);
      CREATE INDEX IF NOT EXISTS idx_subs_contact_name_trgm
        ON subs USING gin (contact_name gin_trgm_ops)
        WHERE contact_name IS NOT NULL;

      -- search_my_sessions ILIKEs ai_sessions.label + summary.
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_label_trgm
        ON ai_sessions USING gin (label gin_trgm_ops)
        WHERE archived_at IS NULL AND label IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_ai_sessions_summary_trgm
        ON ai_sessions USING gin (summary gin_trgm_ops)
        WHERE archived_at IS NULL AND summary IS NOT NULL;
    `);
    console.log('[db] pg_trgm trigram indexes ready');
  } catch (e) {
    console.warn('[db] pg_trgm trigram indexes skipped — ILIKE substring searches will sequential-scan:', e.message);
  }

  // ── Migration: legacy estimator agent retired (agent_key 'ag' → 'job') ──
  // Runs in its own pool.query AFTER the main schema-init template
  // so all referenced tables exist. Idempotent — re-running on a
  // post-migration DB is a no-op. Both tables we touch have unique
  // constraints that include agent_key, so the rename strategy is
  // delete-then-update: drop any 'ag' row that would collide with
  // an existing 'job' row, then rename whatever 'ag' rows are left.
  // ai_messages has no agent_key column (agent identity there is
  // encoded via entity_type), so it's not migrated.
  await pool.query(`
    -- managed_agent_registry: agent_key is the PRIMARY KEY. If both
    -- 'ag' and 'job' rows exist, the bootstrap registered both
    -- agents independently — drop the 'ag' row, keep 'job'.
    DELETE FROM managed_agent_registry
     WHERE agent_key = 'ag'
       AND EXISTS (SELECT 1 FROM managed_agent_registry WHERE agent_key = 'job');
    UPDATE managed_agent_registry SET agent_key = 'job' WHERE agent_key = 'ag';

    -- ai_sessions: unique on (agent_key, entity_type, entity_id, user_id)
    -- WHERE archived_at IS NULL. Archive any 'ag' session that would
    -- collide with an active 'job' session for the same entity tuple,
    -- then rename what remains.
    UPDATE ai_sessions s
       SET archived_at = NOW()
     WHERE s.agent_key = 'ag'
       AND s.archived_at IS NULL
       AND EXISTS (
         SELECT 1 FROM ai_sessions t
          WHERE t.agent_key = 'job'
            AND t.archived_at IS NULL
            AND t.entity_type = s.entity_type
            AND COALESCE(t.entity_id, '') = COALESCE(s.entity_id, '')
            AND t.user_id = s.user_id
       );
    UPDATE ai_sessions SET agent_key = 'job' WHERE agent_key = 'ag';

    -- agent_skills lives in app_settings as a JSONB blob; each pack
    -- has an "agents" string array. Walk every pack, replace 'ag'
    -- with 'job' (deduping if 'job' is already present), write back.
    UPDATE app_settings
       SET value = jsonb_set(
         value, '{skills}',
         (
           SELECT COALESCE(jsonb_agg(
             CASE
               WHEN s ? 'agents' AND jsonb_typeof(s->'agents') = 'array' THEN
                 jsonb_set(
                   s, '{agents}',
                   (
                     SELECT COALESCE(jsonb_agg(DISTINCT v), '[]'::jsonb)
                     FROM (
                       SELECT CASE WHEN x = 'ag' THEN 'job' ELSE x END AS v
                       FROM jsonb_array_elements_text(s->'agents') AS x
                     ) sub
                   )
                 )
               ELSE s
             END
           ), '[]'::jsonb)
           FROM jsonb_array_elements(value->'skills') AS s
         )
       )
     WHERE key = 'agent_skills'
       AND value ? 'skills'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(value->'skills') s
         WHERE s ? 'agents' AND s->'agents' ? 'ag'
       );

    -- Brand cleanup (2026-05): seeded skill-pack names from the AGX
    -- era still carry "AGX " prefixes and the legacy "Elle WIP Analyst
    -- Playbook" name. Strip the prefix and rename Elle so the prompt
    -- preview / skill-pack list don't surface stale brand artifacts.
    -- Re-running this is a no-op once the names are clean (the WHERE
    -- clauses self-gate).
    UPDATE app_settings
       SET value = jsonb_set(
         value, '{skills}',
         (
           SELECT COALESCE(jsonb_agg(
             CASE
               WHEN s ? 'name' AND s->>'name' = 'Elle WIP Analyst Playbook' THEN
                 jsonb_set(s, '{name}', '"WIP Analyst Playbook"'::jsonb)
               WHEN s ? 'name' AND s->>'name' LIKE 'AGX %' THEN
                 jsonb_set(s, '{name}',
                   to_jsonb(REGEXP_REPLACE(s->>'name', '^AGX ', '')))
               ELSE s
             END
           ), '[]'::jsonb)
           FROM jsonb_array_elements(value->'skills') AS s
         )
       )
     WHERE key = 'agent_skills'
       AND value ? 'skills'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(value->'skills') s
         WHERE s ? 'name'
           AND (s->>'name' LIKE 'AGX %' OR s->>'name' = 'Elle WIP Analyst Playbook')
       );

    -- Seed the "Workspace placement & wiring discipline" always-on skill
    -- pack for 86 so any time he adds nodes via create_node / wire_nodes
    -- they follow the user's preferred LTR cost-flow layout. Idempotent:
    -- the WHERE NOT EXISTS gate skips re-insert once the pack is in place.
    INSERT INTO app_settings (key, value, updated_at)
    SELECT 'agent_skills',
           jsonb_build_object(
             'skills',
             jsonb_build_array(
               jsonb_build_object(
                 'name', 'Workspace placement and wiring discipline',
                 'agents', jsonb_build_array('job'),
                 'contexts', jsonb_build_array('job'),
                 'alwaysOn', true,
                 'body',
                 E'# Workspace node-graph placement and wiring\n' ||
                 E'\n' ||
                 E'When you add nodes via create_node or connect them via wire_nodes, follow the LTR cost-flow layout the user has standardized on. The graph reads like an org chart for money: sources on the left, accumulator (WIP) on the far right.\n' ||
                 E'\n' ||
                 E'## The 5-column layout (left to right)\n' ||
                 E'1. **Subs** (cyan, person glyph). Subcontractor source nodes.\n' ||
                 E'2. **Scope / Change Orders** — green (t2 / scope) on top, pink (CO) on bottom of the same column.\n' ||
                 E'3. **Buildings** (cyan, lock glyph). t1 nodes representing the physical structures.\n' ||
                 E'4. **Job-level cost buckets** (yellow). JOB LABOR / JOB MATERIALS / JOB GC / JOB EQUIPMENT.\n' ||
                 E'5. **WIP master** (yellow border). The single accumulator on the far right.\n' ||
                 E'\n' ||
                 E'## Wiring rules\n' ||
                 E'- Every wire flows LEFT to RIGHT. Never create a wire that closes a loop or runs right-to-left.\n' ||
                 E'- Subs feed into the Scope or Building they serve, not directly into a cost bucket.\n' ||
                 E'- Change Orders feed into the Building(s) they impact.\n' ||
                 E'- Cost-bucket nodes (mat / labor / gc / sub / burden / other) sit BETWEEN buildings and the WIP master, not before buildings.\n' ||
                 E'- Wire color is derived from the source node — let it be. Do not override.\n' ||
                 E'\n' ||
                 E'## Node-type discipline\n' ||
                 E'- A new building -> t1.\n' ||
                 E'- A scope item / phase -> t2.\n' ||
                 E'- A subcontractor on the job -> sub.\n' ||
                 E'- A change order -> co.\n' ||
                 E'- A job-level rolled-up cost bucket -> labor / mat / gc / sub / burden / other (pick the right one).\n' ||
                 E'- Use note nodes only for sticky annotations the user wants visible — never as a substitute for a real type.\n' ||
                 E'\n' ||
                 E'## After multi-node restructures\n' ||
                 E'create_node does not accept x/y coordinates — the engine auto-positions. After a batch (3+ create_node + wire_nodes calls), end the turn with a one-line note suggesting the user click "Arrange" in the graph toolbar so the new nodes snap into the column scheme above. Do not call Arrange yourself; it is a UI action.\n'
               )
             )
           ),
           NOW()
    WHERE NOT EXISTS (SELECT 1 FROM app_settings WHERE key = 'agent_skills');

    -- Tag every existing 86 skill pack with the right contexts array
    -- so the loader filters by entity_type. Idempotent: only sets
    -- contexts when the field is missing (existing tags survive).
    -- Pack-name-to-contexts mapping reflects what each playbook is for
    -- (estimating-only, WIP-only, multi-context, etc.).
    UPDATE app_settings
       SET value = jsonb_set(
         value, '{skills}',
         (
           SELECT COALESCE(jsonb_agg(
             CASE
               WHEN s ? 'contexts' THEN s
               WHEN s->>'name' = 'Estimating Playbook'
                 OR s->>'name' = 'Group Discipline'
                 OR s->>'name' = 'Pricing Benchmark Loop'
                 OR s->>'name' = 'Cross-Group Awareness'
                 THEN jsonb_set(s, '{contexts}', '["estimate"]'::jsonb)
               WHEN s->>'name' = 'Lead/Client Linking'
                 THEN jsonb_set(s, '{contexts}', '["estimate","intake"]'::jsonb)
               WHEN s->>'name' = 'WIP Analyst Playbook'
                 OR s->>'name' = 'QB cost to node mapping'
                 OR s->>'name' = 'Workspace placement and wiring discipline'
                 THEN jsonb_set(s, '{contexts}', '["job"]'::jsonb)
               -- Older packs that may still be named with the legacy
               -- "QB cost → node mapping" arrow form (Unicode 2192
               -- could've slipped through earlier rename migrations).
               WHEN s->>'name' LIKE 'QB cost%node mapping%'
                 THEN jsonb_set(s, '{contexts}', '["job"]'::jsonb)
               ELSE s
             END
           ), '[]'::jsonb)
           FROM jsonb_array_elements(value->'skills') AS s
         )
       )
     WHERE key = 'agent_skills'
       AND value ? 'skills'
       AND EXISTS (
         SELECT 1 FROM jsonb_array_elements(value->'skills') s
         WHERE NOT (s ? 'contexts')
           AND s->>'name' IN (
             'Estimating Playbook',
             'Group Discipline',
             'Pricing Benchmark Loop',
             'Cross-Group Awareness',
             'Lead/Client Linking',
             'WIP Analyst Playbook',
             'QB cost to node mapping',
             'Workspace placement and wiring discipline'
           )
       );

    -- (AG / Elle / AGX wording cleanup deferred to a follow-up commit
    -- — earlier attempt with nested replace() blew up paren-balance in
    -- the JS template literal. Admins can clean pack bodies via
    -- Admin -> Agents -> Skills until that ships.)

    -- If the row already existed, append the pack only if the name isn't
    -- already present (covers admins who edited skill packs via the UI
    -- before this migration shipped).
    UPDATE app_settings
       SET value = jsonb_set(
             value,
             '{skills}',
             COALESCE(value->'skills', '[]'::jsonb) ||
               jsonb_build_array(
                 jsonb_build_object(
                   'name', 'Workspace placement and wiring discipline',
                   'agents', jsonb_build_array('job'),
                   'contexts', jsonb_build_array('job'),
                   'alwaysOn', true,
                   'body',
                   E'# Workspace node-graph placement and wiring\n' ||
                   E'\n' ||
                   E'When you add nodes via create_node or connect them via wire_nodes, follow the LTR cost-flow layout the user has standardized on. The graph reads like an org chart for money: sources on the left, accumulator (WIP) on the far right.\n' ||
                   E'\n' ||
                   E'## The 5-column layout (left to right)\n' ||
                   E'1. **Subs** (cyan, person glyph). Subcontractor source nodes.\n' ||
                   E'2. **Scope / Change Orders** — green (t2 / scope) on top, pink (CO) on bottom of the same column.\n' ||
                   E'3. **Buildings** (cyan, lock glyph). t1 nodes representing the physical structures.\n' ||
                   E'4. **Job-level cost buckets** (yellow). JOB LABOR / JOB MATERIALS / JOB GC / JOB EQUIPMENT.\n' ||
                   E'5. **WIP master** (yellow border). The single accumulator on the far right.\n' ||
                   E'\n' ||
                   E'## Wiring rules\n' ||
                   E'- Every wire flows LEFT to RIGHT. Never create a wire that closes a loop or runs right-to-left.\n' ||
                   E'- Subs feed into the Scope or Building they serve, not directly into a cost bucket.\n' ||
                   E'- Change Orders feed into the Building(s) they impact.\n' ||
                   E'- Cost-bucket nodes (mat / labor / gc / sub / burden / other) sit BETWEEN buildings and the WIP master, not before buildings.\n' ||
                   E'- Wire color is derived from the source node — let it be. Do not override.\n' ||
                   E'\n' ||
                   E'## Node-type discipline\n' ||
                   E'- A new building -> t1.\n' ||
                   E'- A scope item / phase -> t2.\n' ||
                   E'- A subcontractor on the job -> sub.\n' ||
                   E'- A change order -> co.\n' ||
                   E'- A job-level rolled-up cost bucket -> labor / mat / gc / sub / burden / other (pick the right one).\n' ||
                   E'- Use note nodes only for sticky annotations the user wants visible — never as a substitute for a real type.\n' ||
                   E'\n' ||
                   E'## After multi-node restructures\n' ||
                   E'create_node does not accept x/y coordinates — the engine auto-positions. After a batch (3+ create_node + wire_nodes calls), end the turn with a one-line note suggesting the user click "Arrange" in the graph toolbar so the new nodes snap into the column scheme above. Do not call Arrange yourself; it is a UI action.\n'
                 )
               )
           ),
           updated_at = NOW()
     WHERE key = 'agent_skills'
       AND value ? 'skills'
       AND NOT EXISTS (
         SELECT 1 FROM jsonb_array_elements(value->'skills') s
         WHERE s->>'name' = 'Workspace placement and wiring discipline'
       );
  `);

  // ── One-shot migration: reset estimates.updated_at on rows the
  // bulk-save-touches-everything bug had been bumping unnecessarily ──
  //
  // Before the fix in estimate-routes.js, every saveData() POST
  // bumped updated_at on every estimate in the array, so the
  // "Updated" column ended up showing the same recent time on every
  // row regardless of which one had actually been edited. The fix
  // stops that going forward, but the existing wrong timestamps
  // stay until each row is touched naturally.
  //
  // This migration is the corrective sweep: set updated_at back to
  // created_at for every row where they differ. Result is that the
  // "Updated" column reads as "since creation" — which is the right
  // floor for any estimate that hasn't been intentionally edited
  // since the fix. Real edits going forward bump correctly.
  //
  // Idempotent via a sentinel app_settings row so it only runs once
  // even though initSchema() re-runs on every boot.
  try {
    const sentinelKey = 'estimates_updated_at_reset_v1';
    const exists = await pool.query(
      `SELECT 1 FROM app_settings WHERE key = $1`,
      [sentinelKey]
    );
    if (!exists.rows.length) {
      const r = await pool.query(
        `UPDATE estimates SET updated_at = created_at
          WHERE updated_at > created_at`
      );
      await pool.query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ($1, $2::jsonb, NOW())
         ON CONFLICT (key) DO NOTHING`,
        [sentinelKey, JSON.stringify({ ran_at: new Date().toISOString(), rows_touched: r.rowCount })]
      );
      if (r.rowCount > 0) {
        console.log('[db] estimates updated_at one-shot reset: cleared', r.rowCount, 'bumped row(s).');
      }
    }
  } catch (e) {
    console.warn('[db] estimates updated_at reset skipped:', e.message);
  }

  // Seed built-in roles. ON CONFLICT lets us re-run safely without
  // overwriting capability edits an admin made post-seed (only the label,
  // description, and builtin flag get refreshed).
  const BUILTIN_ROLES = [
    {
      name: 'system_admin',
      label: 'System Admin',
      description: 'Platform owner. All admin capabilities PLUS cross-tenant access (manage organizations, see cross-org metrics, manage Anthropic-account-wide resources).',
      capabilities: [
        'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
        'FINANCIALS_VIEW', 'PROGRESS_UPDATE',
        'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
        'LEADS_VIEW', 'LEADS_EDIT',
        'USERS_MANAGE', 'ROLES_MANAGE',
        'INSIGHTS_VIEW', 'ADMIN_METRICS',
        'SYSTEM_ADMIN'
      ]
    },
    {
      name: 'admin',
      label: 'Org Admin',
      description: 'Full access within ONE organization. Manages users, roles, jobs, and org settings for their tenant. Does NOT see cross-tenant operations (those require System Admin).',
      capabilities: [
        'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
        'FINANCIALS_VIEW', 'PROGRESS_UPDATE',
        'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
        'LEADS_VIEW', 'LEADS_EDIT',
        'USERS_MANAGE', 'ROLES_MANAGE',
        'INSIGHTS_VIEW', 'ADMIN_METRICS'
        // SYSTEM_ADMIN intentionally absent.
      ]
    },
    {
      name: 'corporate',
      label: 'Corporate',
      description: 'Read-only across all jobs, leads, and dashboards.',
      capabilities: ['JOBS_VIEW_ALL', 'FINANCIALS_VIEW', 'ESTIMATES_VIEW', 'LEADS_VIEW', 'INSIGHTS_VIEW']
    },
    {
      name: 'pm',
      label: 'Project Manager',
      description: 'Edits own / assigned jobs and leads; full estimate access; sees insights.',
      capabilities: [
        'JOBS_VIEW_ALL', 'JOBS_EDIT_OWN',
        'FINANCIALS_VIEW', 'PROGRESS_UPDATE',
        'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
        'LEADS_VIEW', 'LEADS_EDIT',
        'INSIGHTS_VIEW'
      ]
    },
    {
      name: 'field_crew',
      label: 'Field Crew',
      description: 'Estimates and Cost Inbox only. No jobs, no financials.',
      capabilities: ['ESTIMATES_VIEW', 'ESTIMATES_EDIT']
    },
    {
      name: 'sub',
      label: 'Subcontractor (Portal)',
      description: 'External user. Sees only folders granted to their sub record; uploads into those same folders. No PM-app access.',
      capabilities: ['SUB_PORTAL_VIEW', 'SUB_PORTAL_UPLOAD']
    }
  ];
  for (const r of BUILTIN_ROLES) {
    // The admin + system_admin roles are special-cased: their capability
    // lists are always re-synced to the canonical full set on boot.
    // New capabilities added to the codebase (LEADS_*, SYSTEM_ADMIN, etc.)
    // flow automatically to these roles without anyone having to toggle
    // them in the Roles UI. Other built-ins preserve admin customizations
    // on conflict.
    if (r.name === 'admin' || r.name === 'system_admin') {
      await pool.query(
        `INSERT INTO roles (name, label, description, builtin, capabilities)
         VALUES ($1, $2, $3, true, $4::jsonb)
         ON CONFLICT (name) DO UPDATE
           SET label = EXCLUDED.label,
               description = EXCLUDED.description,
               builtin = true,
               capabilities = EXCLUDED.capabilities,
               updated_at = NOW()`,
        [r.name, r.label, r.description, JSON.stringify(r.capabilities)]
      );
    } else {
      await pool.query(
        `INSERT INTO roles (name, label, description, builtin, capabilities)
         VALUES ($1, $2, $3, true, $4::jsonb)
         ON CONFLICT (name) DO UPDATE
           SET label = EXCLUDED.label,
               description = EXCLUDED.description,
               builtin = true,
               updated_at = NOW()`,
        [r.name, r.label, r.description, JSON.stringify(r.capabilities)]
      );
    }
  }

  // Promote a user to system_admin so the platform owner exists.
  // Two paths, applied in order:
  //   1. Explicit env override: SYSTEM_ADMIN_EMAIL — promote the
  //      user with that email (idempotent).
  //   2. Single-tenant bootstrap: if NO user has role='system_admin'
  //      yet AND exactly one user has role='admin', promote that
  //      one admin. This handles the first deploy after this
  //      migration lands — the existing sole admin becomes the
  //      platform owner automatically.
  // If neither condition fires (multiple admins, no env, no admin
  // at all), the migration leaves users alone — the platform owner
  // is expected to set SYSTEM_ADMIN_EMAIL or promote a user via
  // SQL manually.
  try {
    const envEmail = (process.env.SYSTEM_ADMIN_EMAIL || '').trim().toLowerCase();
    if (envEmail) {
      await pool.query(
        `UPDATE users SET role = 'system_admin' WHERE LOWER(email) = $1`,
        [envEmail]
      );
    }
    const hasSysAdmin = await pool.query(
      `SELECT 1 FROM users WHERE role = 'system_admin' LIMIT 1`
    );
    if (!hasSysAdmin.rows.length) {
      const adminsR = await pool.query(`SELECT id FROM users WHERE role = 'admin'`);
      if (adminsR.rows.length === 1) {
        await pool.query(
          `UPDATE users SET role = 'system_admin' WHERE id = $1`,
          [adminsR.rows[0].id]
        );
        console.log('[db] Auto-promoted sole admin (id=' + adminsR.rows[0].id + ') to system_admin.');
      }
    }
  } catch (e) {
    console.warn('[db] system_admin promotion skipped:', e.message);
  }

  // Seed the default proposal template once. Re-running is a no-op so admins
  // can edit the live template via /api/settings/proposal_template without
  // having their changes reverted on the next boot. The placeholder tokens
  // ({salutation}, {issue}, {community}, {date}, {total}) are filled in by the
  // preview renderer on the client.
  const DEFAULT_PROPOSAL_TEMPLATE = {
    company_header: '13191 56th Court, Ste 102 · Clearwater, FL 33760-4030 · Phone: 813-725-5233',
    intro_template:
      'AG Exteriors is pleased to provide you with this proposal to complete the work outlined below.',
    about_paragraph:
      'We proudly specialize in a wide range of exterior services, including roofing, siding, painting, deck rebuilding, and more—delivering each with care and attention to detail. Backed by our leadership team with extensive experience in construction, development, and property management. AG Exteriors is committed to bringing a thoughtful, professional approach to every project. With this foundation, we’re committed to providing high-quality work and dependable service on every project.',
    exclusions: [
      'This proposal may be withdrawn by AG Exteriors if not accepted within 30 days.',
      'Pricing assumes unfettered access to the property during the project.',
      'If AG Exteriors encounters unforeseen conditions that differ from those anticipated or ordinarily found to exist in the construction activities being provided, AG Exteriors retains the right to make an equitable adjustment to the pricing.',
      'Client will provide electrical power and water at no charge.',
      'Client will provide a location for dumpsters on site for trash and material disposal. AG Exteriors will provide the dumpsters for the entire job. However, if we are required to switch out dumpsters due to residents’ use, AG Exteriors reserves the right to charge the Client accordingly.',
      'Mold/Asbestos/Lead Paint: Any detection or remediation of mold, asbestos, and lead paint is specifically excluded from this proposal. Any costs associated with the detection and/or removal of mold, mold spores, asbestos, and lead paint are the responsibility of others.',
      'Damage to the physical property that occurred prior to AG Exteriors’ work not specifically called out in the scope of work is excluded.',
      'Proposal excludes any engineering and/or permit fees. If any of these are required to complete the project, AG Exteriors will charge the client the cost of these fees plus an additional 10%.',
      'Client acknowledges that markets are experiencing significant, industry-wide economic fluctuations, impacting the price of materials to be supplied in conjunction with the agreement. Client acknowledges that materials pricing has the potential to significantly increase between the time of the issuance of the underlying bid and the date of materials purchase for the Project. If the cost of any given material increases above the amount shown in the bid proposal for such material, this quote shall be adjusted upwards, and the Client will be responsible for the increased cost of the materials. In order to mitigate the potential for material-based price increases, the Client has the option to pay for materials in advance of the job. Material costs are guaranteed if materials are paid for at the time the proposal is accepted. Any prepayment of materials will be in addition to the normal deposit of 35%.'
    ],
    signature_text: 'I confirm that my action here represents my electronic signature and is binding.'
  };
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('proposal_template', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_PROPOSAL_TEMPLATE)]
  );

  // Auto-upgrade: if a deployment still carries the OLD intro_template
  // (with {issue} / {community} placeholders), swap it for the new
  // ambiguous one that matches the AGX print-format reference. We
  // only update when the stored value EXACTLY matches the old
  // default — admin customizations are preserved.
  try {
    const OLD_INTRO = 'AG Exteriors is pleased to provide you with a proposal to complete the {issue} needed by the {community} community.';
    const NEW_INTRO = DEFAULT_PROPOSAL_TEMPLATE.intro_template;
    await pool.query(
      `UPDATE app_settings
          SET value = jsonb_set(value, '{intro_template}', to_jsonb($1::text), false),
              updated_at = NOW()
        WHERE key = 'proposal_template'
          AND value->>'intro_template' = $2`,
      [NEW_INTRO, OLD_INTRO]
    );
  } catch (e) {
    console.warn('[db] proposal intro_template auto-upgrade skipped:', e.message);
  }

  // BT export mapping — drives the Buildertrend xlsx exporter. As of
  // the new BT proposal-import format (Phase D), each Project 86 btCategory
  // maps to a single BT Cost Code string. The old Parent Group /
  // Subgroup / Cost Type fields and the auto-injected Service &
  // Repair Income line are gone — the export emits pure cost lines at
  // their real markups. Section flat-$, fees, and tax are pro-rata
  // distributed onto each line so the export total matches the
  // proposal exactly.
  const DEFAULT_BT_MAPPING = {
    categories: {
      materials: { costCode: 'Materials & Supplies Costs' },
      labor:     { costCode: 'Direct Labor' },
      gc:        { costCode: 'General Conditions' },
      sub:       { costCode: 'Subcontractors Costs' }
    },
    fallback: { costCode: 'General Conditions' }
  };
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('bt_export_mapping', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_BT_MAPPING)]
  );

  // Agent skills — admin-editable prompt extensions that the in-app AI
  // agents (AG, the Customer Relations Agent) load into their system
  // prompts. Each skill has a body (free-form prompt text), the agents
  // it applies to, and an alwaysOn flag. v1 only honors alwaysOn — the
  // body just gets appended for every chat. v2 will support on-demand
  // loading via a tool call.
  //
  // Default seed bundles Project 86's house-style estimating playbook for AG.
  // Admins edit these in Admin -> Templates -> Skills; nothing in code
  // needs to change to add a new playbook.
  const DEFAULT_AGENT_SKILLS = {
    skills: [
      {
        id: 'sk_agx_estimating_playbook',
        name: 'Project 86 Estimating Playbook',
        agents: ['ag'],
        alwaysOn: true,
        body: [
          'Project 86 house style for estimating:',
          '',
          '## Slotting (extra emphasis)',
          'Always slot lines into the four standard subgroups. Materials = anything you can hold. Labor = Project 86 crew hours. GC = overhead/permits/dumpster/PM. Subs = work handed to another company.',
          '',
          '## Quantity discipline',
          'Take quantities off photos when possible: count balusters, pickets, treads, doors, windows, panels. State your count in the rationale ("counted 38 balusters across 4 sections of railing"). When you can\'t count from the photo, ask for a measurement.',
          '',
          '## Common Project 86 scopes — typical line bundles',
          '- Deck repair: PT 5/4 deck boards (Materials), 8d hot-dip nails or trim screws (Materials), demo + install labor (Direct Labor), dump fees (GC), paint sub if separate (Subs).',
          '- Painting: primer (Materials), top-coat paint (Materials), masking + drop cloths (Materials), prep + paint labor (Direct Labor), color match samples (Materials small lot).',
          '- Stair tread replacement: oak/PT treads (Materials), risers if needed (Materials), construction adhesive (Materials), demo + install labor (Direct Labor), finish stain/sealer (Materials).',
          '',
          '## What I always check before saying "complete"',
          '- Did I cover demo / disposal? (GC dump fees + Direct Labor demo hours)',
          '- Did I include mobilization?',
          '- Is there a permit cost the client expects us to pull?',
          '- Are there access issues (height, gate codes, scheduling) that need a line?',
          '- Did I match section_name on every line item?',
          '',
          '## Tone',
          'Trade vocab welcome. Speak like a senior PM walking the job. No corporate filler.'
        ].join('\n')
      },
      {
        id: 'sk_cra_directory_hygiene',
        name: 'Customer Directory Hygiene',
        agents: ['cra'],
        alwaysOn: true,
        body: [
          'When auditing the directory, work in this order: (1) split obvious parent+property compounds, (2) link unparented properties to existing parents, (3) merge clear duplicates, (4) normalize parent-company spelling. Flag ambiguous cases for the user — don\'t guess on a 50/50.',
          'Always prefer reusing an existing parent over creating a new one. PAC, Associa, FirstService Residential, Greystar, RangeWater are common — check the directory before proposing new ones.'
        ].join('\n')
      }
    ]
  };
  await pool.query(
    `INSERT INTO app_settings (key, value)
     VALUES ('agent_skills', $1::jsonb)
     ON CONFLICT (key) DO NOTHING`,
    [JSON.stringify(DEFAULT_AGENT_SKILLS)]
  );

  // Idempotent additive merge — packs we want every deployment to have
  // even after the initial agent_skills row has been written. Each
  // pack is identified by id; if the id already exists in the row,
  // we leave it alone (admins may have edited the body). New packs
  // get appended.
  const ADDITIVE_AGENT_SKILLS = [
    {
      id: 'sk_ag_group_discipline',
      name: 'Project 86 Group Discipline',
      agents: ['ag'],
      alwaysOn: true,
      body: [
        'Estimates can have multiple Groups. Discipline:',
        '- Before adding lines or scope, confirm which group the user is talking about. The "Groups on this estimate" block in your context shows every group with line count + subtotal + subgroup names.',
        '- When the user pivots ("now let\'s work on the roof", "let\'s look at the optional adds") and the active group is not the one they\'re talking about: call propose_switch_active_group FIRST. Don\'t silently slot lines into the wrong group.',
        '- When the user describes a NEW scope that doesn\'t belong in any existing group ("add a separate scope for the back deck"), call propose_add_group with a clear name. The four standard subgroups auto-seed.',
        '- When the user says "same as Deck 1 but for Deck 2," call propose_add_group with copy_from_active=true, then walk through delta edits.',
        '- For Good/Better/Best style estimates, use propose_toggle_group_include to mark the alternate options as excluded so only one rolls into the headline.'
      ].join('\n')
    },
    {
      id: 'sk_ag_lead_client_linking',
      name: 'Project 86 Lead/Client Linking',
      agents: ['ag'],
      alwaysOn: true,
      body: [
        'When an estimate is unlinked (no client_id / lead_id in context) and the user mentions a client or lead name:',
        '- For client name → call read_clients(q="...") first. If you find a confident match (single result OR exact name match in top 3), call propose_link_to_client. If the match is ambiguous, ask the user to confirm before linking.',
        '- For lead → call read_leads(q="...") then propose_link_to_lead the same way.',
        '- After linking a client, the client\'s notes start auto-injecting into your context every turn. propose_add_client_note becomes available for durable facts the user shares.',
        '- Do NOT link based on weak matches (substring of a common word, fuzzy partial). Better to ask "is this PAC at Wimbledon Greens, or PAC at another property?" than to mis-link.',
        'Other top-level metadata: title, salutation, markup_default, bt_export_status, notes — use propose_update_estimate_field. Don\'t use it for fields the user can edit faster themselves (most metadata); reserve it for moments where you\'re confident from conversation context (e.g., user says "rename this to Wimbledon Greens — Building 4 deck rebuild").'
      ].join('\n')
    },
    {
      id: 'sk_ag_pricing_benchmark',
      name: 'Project 86 Pricing Benchmark Loop',
      agents: ['ag'],
      alwaysOn: true,
      body: [
        'Before quoting a NON-MATERIALS line (Direct Labor, Subcontractors, GC):',
        '- Call read_past_estimate_lines(q="<trade keyword>") to anchor the unit_cost to Project 86 history.',
        '- If the median + range output shows 3+ priced matches in the last 2 years, anchor your quote to the median (or the high end if recent inflation is visible in the range).',
        '- If 0 matches, mark the rationale "first-time line — no Project 86 history yet" and quote a defensible Central-FL number from your trade knowledge.',
        '- 1-2 matches: cite both — "$X based on [estimate title], $Y based on [other estimate title], proposing $Z."',
        'For MATERIALS still use read_materials (real receipts) — past_estimate_lines doesn\'t differentiate retail vs Project 86 cost the way the receipt log does.',
        'Don\'t loop. ONE read_past_estimate_lines call per trade keyword. If empty, move on — don\'t keep retrying narrower queries.'
      ].join('\n')
    },
    {
      id: 'sk_ag_cross_group_awareness',
      name: 'Project 86 Cross-Group Awareness',
      agents: ['ag'],
      alwaysOn: true,
      body: [
        'The "Groups on this estimate" block in your context shows every group\'s line count, subtotal, and subgroup names. Before proposing a line, scan it.',
        '- If the user describes a scope that already exists in a different (inactive) group, surface that BEFORE proposing duplicates: "Looks like Deck 1 already has the deck-board work — did you want me to add it to Deck 2 (this one), or move it from Deck 1?"',
        '- For multi-deck or multi-building scopes, prefer one group per scope (Deck 1, Deck 2, Roof) over jamming everything into one group with subgroup gymnastics.',
        '- When the user says "do the same for the other decks too," consider propose_add_group(copy_from_active=true) per additional deck instead of duplicating lines manually.'
      ].join('\n')
    }
  ];
  // Read the current row, merge any missing packs, write back.
  const existingSkills = await pool.query(
    `SELECT value FROM app_settings WHERE key = 'agent_skills'`
  );
  if (existingSkills.rows.length) {
    const cur = existingSkills.rows[0].value || {};
    const skills = Array.isArray(cur.skills) ? cur.skills.slice() : [];
    let added = 0;
    for (const pack of ADDITIVE_AGENT_SKILLS) {
      if (!skills.some(s => s && (s.id === pack.id || s.name === pack.name))) {
        skills.push(pack);
        added++;
      }
    }
    if (added > 0) {
      const merged = Object.assign({}, cur, { skills });
      await pool.query(
        `UPDATE app_settings SET value = $1::jsonb, updated_at = NOW() WHERE key = 'agent_skills'`,
        [JSON.stringify(merged)]
      );
      console.log('[db] seeded ' + added + ' new agent skill pack' + (added === 1 ? '' : 's'));
    }
  }

  // Sync the admin user from env vars on every boot.
  // ADMIN_EMAIL + ADMIN_PASSWORD are set in Railway/production env. Treated as a
  // system-managed account, not user-facing — change the env var to rotate the password.
  // Without env vars, fall back to a clearly-fake dev seed only when the DB is empty.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    // Normalize the email the same way PUT /api/auth/users/:id does
    // (lowercase + trim) so a typo in the env var with stray whitespace
    // or different casing doesn't miss the ON CONFLICT and create a
    // duplicate admin row.
    const adminEmail = String(process.env.ADMIN_EMAIL).trim().toLowerCase();
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    const result = await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, 'Admin', 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash
       RETURNING (xmax = 0) AS inserted, id, role`,
      [adminEmail, hash]
    );
    const row = result.rows[0] || {};
    if (row.inserted) {
      console.log(`Created admin user from env (id=${row.id}): ${adminEmail}`);
    } else {
      console.log(`Refreshed admin password from env (id=${row.id}, role=${row.role}): ${adminEmail}`);
    }
  } else {
    const { rows } = await pool.query('SELECT COUNT(*)::int as c FROM users');
    if (rows[0].c === 0) {
      const hash = bcrypt.hashSync('changeme', 10);
      await pool.query(
        'INSERT INTO users (email, password_hash, name, role) VALUES ($1, $2, $3, $4)',
        ['admin@local', hash, 'Admin', 'admin']
      );
      console.log('Seeded dev admin: admin@local / changeme — set ADMIN_EMAIL and ADMIN_PASSWORD env vars in production');
    }
  }
}

async function init() {
  await initSchema();
  // Build the real folder tree from existing folder strings (idempotent;
  // a fast no-op once every attachment/grant has a folder_id).
  try {
    await require('./services/file-folders').backfill();
  } catch (e) {
    console.error('[init] file-folders backfill failed (non-fatal):', e && e.message);
  }
}

// ────────────────────────────────────────────────────────────────
// Organization helpers — used by request handlers + agent
// registration to scope work per tenant. All public callers should
// use these instead of re-querying organizations directly so the
// schema can evolve (e.g. caching) without touching every caller.
// ────────────────────────────────────────────────────────────────

// Resolve a user's organization row. Returns null if the user has
// no organization (only possible during the migration window — the
// boot-time backfill assigns AGX to every existing user). Callers
// that require an org should treat null as a 500-level bug.
async function getOrgForUser(userId) {
  if (!userId) return null;
  const r = await pool.query(
    `SELECT o.*
       FROM organizations o
       JOIN users u ON u.organization_id = o.id
      WHERE u.id = $1
        AND o.archived_at IS NULL
      LIMIT 1`,
    [userId]
  );
  return r.rows[0] || null;
}

// Lookup an org by its slug (e.g. 'agx'). Used by admin endpoints
// that operate on a specific org without going through a user
// context.
async function getOrgBySlug(slug) {
  if (!slug) return null;
  const r = await pool.query(
    `SELECT * FROM organizations WHERE slug = $1 AND archived_at IS NULL LIMIT 1`,
    [String(slug).toLowerCase()]
  );
  return r.rows[0] || null;
}

// Lookup an org by id. Cheaper than getOrgForUser when the caller
// already has the org id (e.g. from a JWT claim).
async function getOrgById(orgId) {
  if (!orgId) return null;
  const r = await pool.query(
    `SELECT * FROM organizations WHERE id = $1 AND archived_at IS NULL LIMIT 1`,
    [orgId]
  );
  return r.rows[0] || null;
}

// List every active org (admin views, future signup screens).
async function listOrganizations() {
  const r = await pool.query(
    `SELECT * FROM organizations WHERE archived_at IS NULL ORDER BY created_at ASC`
  );
  return r.rows;
}

module.exports = {
  pool,
  init,
  getOrgForUser,
  getOrgBySlug,
  getOrgById,
  listOrganizations
};
