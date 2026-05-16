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
      INSERT INTO org_skill_packs (
        organization_id, name, body, description,
        agents, contexts, category, triggers, anthropic_skill_id
      )
      SELECT
        agx_id,
        COALESCE(pack->>'name', '(untitled)'),
        COALESCE(pack->>'body', ''),
        COALESCE(pack->>'description', ''),
        COALESCE(pack->'agents', '["job"]'::jsonb),
        COALESCE(pack->'contexts', '[]'::jsonb),
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

    CREATE TABLE IF NOT EXISTS estimates (
      id TEXT PRIMARY KEY,
      owner_id INTEGER REFERENCES users(id),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

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

    -- Short name = the QuickBooks short name / abbreviation HR uses to match
    -- clients to AGX's bookkeeping records (e.g. "PAC" for "Preferred
    -- Apartment Communities", "FSR" for "FirstService Residential"). Sourced
    -- from the live job-numbers + short-names reference sheet HR consults,
    -- and used downstream as the community label on proposal exports.
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS short_name TEXT;

    -- Agent notes — accumulated free-form facts about how to handle this
    -- client, written by either the user or one of the AI agents (CRA, AG)
    -- and auto-injected into agent system prompts on every turn that
    -- touches this client. Examples: "PAC always wants 15% materials
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
      CHECK (entity_type IN ('lead', 'estimate', 'client', 'job', 'sub', 'user'));

    -- Folder grouping (Phase 3). Free-text folder name per attachment;
    -- 'general' is the default catch-all. Users can move files into
    -- named folders (e.g. 'photos', 'rfp', 'contracts', 'inspection')
    -- via the move endpoint. Phase 4 layers per-folder sub access on
    -- top of this column. (Phase 4's attachment_folder_grants table
    -- is defined AFTER the subs table further down so its FK resolves
    -- on the first run.)

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
      name TEXT NOT NULL UNIQUE,
      description TEXT,
      category TEXT,                                       -- 'calculator' | 'lookup' | 'form' | 'other'
      html_body TEXT NOT NULL,
      created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_field_tools_category ON field_tools(category);
    CREATE INDEX IF NOT EXISTS idx_field_tools_updated ON field_tools(updated_at DESC);

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
    CREATE INDEX IF NOT EXISTS idx_materials_subgroup ON materials(agx_subgroup);
    CREATE INDEX IF NOT EXISTS idx_materials_category ON materials(category);
    CREATE INDEX IF NOT EXISTS idx_materials_sku ON materials(sku);
    CREATE INDEX IF NOT EXISTS idx_materials_hidden ON materials(is_hidden);
    CREATE INDEX IF NOT EXISTS idx_materials_search ON materials
      USING gin(to_tsvector('english', description || ' ' || raw_description));
    -- Natural-key dedupe — case-insensitive description per vendor.
    CREATE UNIQUE INDEX IF NOT EXISTS idx_materials_natural_key
      ON materials(vendor, lower(raw_description));

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
      agent TEXT NOT NULL,                                  -- 'job' (86), 'ag', 'cra', 'staff'
      kind TEXT NOT NULL DEFAULT 'audit',                   -- 'audit' | 'extract' | future kinds
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
  `);

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
