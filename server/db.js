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
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

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
