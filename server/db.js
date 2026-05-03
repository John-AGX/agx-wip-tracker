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

    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      owner_id INTEGER NOT NULL REFERENCES users(id),
      data JSONB NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

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
    ALTER TABLE clients ADD COLUMN IF NOT EXISTS salutation TEXT;

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
      CHECK (entity_type IN ('lead', 'estimate', 'client', 'job', 'sub'));

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

    -- Materials catalog — AGX's purchase history (Home Depot to start;
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
    CREATE UNIQUE INDEX IF NOT EXISTS idx_job_subs_unique ON job_subs(job_id, sub_id, COALESCE(building_id, ''), COALESCE(phase_id, ''));

    -- QuickBooks Detailed Job Cost lines. Imported from the weekly
    -- "Project Costs" / "Detailed Job Costs" xlsx export. The id is a
    -- content-derived hash so re-imports of the same QB row land on the
    -- same record (idempotent across devices and re-runs).
    -- linked_node_id is set by the user (or AI in Phase 3) to attach
    -- a line to a node graph node — that's how QB spend gets reconciled
    -- against the cost-flow tree.
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
      category TEXT,                       -- AGX-natural category: 'Lumber & Decking', 'Paint', 'Fasteners', etc.
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
  `);

  // Seed built-in roles. ON CONFLICT lets us re-run safely without
  // overwriting capability edits an admin made post-seed (only the label,
  // description, and builtin flag get refreshed).
  const BUILTIN_ROLES = [
    {
      name: 'admin',
      label: 'Admin',
      description: 'Full access. Manages users, roles, jobs, and site settings.',
      capabilities: [
        'JOBS_VIEW_ALL', 'JOBS_EDIT_ANY', 'JOBS_DELETE', 'JOBS_GO_LIVE', 'JOBS_REASSIGN',
        'FINANCIALS_VIEW', 'PROGRESS_UPDATE',
        'ESTIMATES_VIEW', 'ESTIMATES_EDIT',
        'LEADS_VIEW', 'LEADS_EDIT',
        'USERS_MANAGE', 'ROLES_MANAGE',
        'INSIGHTS_VIEW', 'ADMIN_METRICS'
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
    }
  ];
  for (const r of BUILTIN_ROLES) {
    // The admin role is special-cased: its capability list is always re-synced
    // to the canonical full set on boot. That way new capabilities added to
    // the codebase (LEADS_*, future features) flow automatically to admins
    // without anyone having to toggle them in the Roles UI. Other built-ins
    // preserve admin customizations on conflict.
    if (r.name === 'admin') {
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

  // Seed the default proposal template once. Re-running is a no-op so admins
  // can edit the live template via /api/settings/proposal_template without
  // having their changes reverted on the next boot. The placeholder tokens
  // ({salutation}, {issue}, {community}, {date}, {total}) are filled in by the
  // preview renderer on the client.
  const DEFAULT_PROPOSAL_TEMPLATE = {
    company_header: '13191 56th Court, Ste 102 · Clearwater, FL 33760-4030 · Phone: 813-725-5233',
    intro_template:
      'AG Exteriors is pleased to provide you with a proposal to complete the {issue} needed by the {community} community.',
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

  // BT export mapping — drives the Buildertrend xlsx exporter. Keys map
  // each btCategory (and the auto-injected income line) to a BT Parent
  // Group / Subgroup / Cost Type / Cost Code. Cost Code is intentionally
  // blank by default; admins fill it in with their own BT codes.
  const DEFAULT_BT_MAPPING = {
    categories: {
      materials: { parentGroup: 'Materials & Supplies', parentDesc: 'Materials and supplies costs', subgroup: 'Materials',              subgroupDesc: 'General materials',          costCode: '', costType: 'Material' },
      labor:     { parentGroup: 'Direct Labor',         parentDesc: 'AG Exteriors direct labor',     subgroup: 'Field Labor',            subgroupDesc: 'Field crew labor',           costCode: '', costType: 'Labor' },
      gc:        { parentGroup: 'General Conditions',   parentDesc: 'Project general conditions',     subgroup: 'Site Operations',        subgroupDesc: 'General site operations',   costCode: '', costType: 'Other' },
      sub:       { parentGroup: 'Subcontractors',       parentDesc: 'Subcontracted scopes',           subgroup: 'General Subcontractors', subgroupDesc: 'General subcontracted work', costCode: '', costType: 'Subcontractor' }
    },
    fallback: { parentGroup: 'Uncategorized', parentDesc: '', subgroup: 'General', subgroupDesc: '', costCode: '', costType: 'Other' },
    income: {
      title: 'Service & Repair Income',
      parentGroup: 'Income',
      parentDesc: 'Client-facing income line',
      subgroup: 'Service & Repair',
      subgroupDesc: 'Service and repair income',
      costCode: 'Service & Repair Income',
      costType: 'Other'
    }
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
  // Default seed bundles AGX's house-style estimating playbook for AG.
  // Admins edit these in Admin -> Templates -> Skills; nothing in code
  // needs to change to add a new playbook.
  const DEFAULT_AGENT_SKILLS = {
    skills: [
      {
        id: 'sk_agx_estimating_playbook',
        name: 'AGX Estimating Playbook',
        agents: ['ag'],
        alwaysOn: true,
        body: [
          'AGX house style for estimating:',
          '',
          '## Slotting (extra emphasis)',
          'Always slot lines into the four standard subgroups. Materials = anything you can hold. Labor = AGX crew hours. GC = overhead/permits/dumpster/PM. Subs = work handed to another company.',
          '',
          '## Quantity discipline',
          'Take quantities off photos when possible: count balusters, pickets, treads, doors, windows, panels. State your count in the rationale ("counted 38 balusters across 4 sections of railing"). When you can\'t count from the photo, ask for a measurement.',
          '',
          '## Common AGX scopes — typical line bundles',
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

  // Sync the admin user from env vars on every boot.
  // ADMIN_EMAIL + ADMIN_PASSWORD are set in Railway/production env. Treated as a
  // system-managed account, not user-facing — change the env var to rotate the password.
  // Without env vars, fall back to a clearly-fake dev seed only when the DB is empty.
  if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) {
    const hash = bcrypt.hashSync(process.env.ADMIN_PASSWORD, 10);
    await pool.query(
      `INSERT INTO users (email, password_hash, name, role)
       VALUES ($1, $2, 'Admin', 'admin')
       ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
      [process.env.ADMIN_EMAIL, hash]
    );
    console.log(`Synced admin user from env: ${process.env.ADMIN_EMAIL}`);
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

module.exports = { pool, init };
