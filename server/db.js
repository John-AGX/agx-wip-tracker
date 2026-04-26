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
  `);

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
