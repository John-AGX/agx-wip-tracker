#!/usr/bin/env node
'use strict';

/**
 * export-all-data.js — take a full copy of the Project 86 database.
 *
 * WHY THIS EXISTS
 * There has never been a backup. docs/KNOWN_ISSUES.md logs it as OPS-1,
 * priority 1, and notes that no restore has ever been tested. Two other files
 * in this repository look like backup provisions and are not: deploy/setup.sh
 * copies a SQLite file this Postgres app does not have, and
 * docs/proprietary-model-v1.md refers to "DB backups" that do not exist.
 *
 * This writes one JSONL file per table plus a manifest. It is READ ONLY: it
 * issues SELECTs and nothing else, and never writes to the database.
 *
 * USAGE — the connection string is never passed on the command line, so it
 * does not land in your shell history:
 *
 *   # PowerShell
 *   $env:DATABASE_URL="<paste DATABASE_PUBLIC_URL from Railway>"
 *   node scripts/export-all-data.js
 *
 *   # bash
 *   export DATABASE_URL='<paste DATABASE_PUBLIC_URL from Railway>'
 *   node scripts/export-all-data.js
 *
 *   node scripts/export-all-data.js --out D:/p86-backup   # choose a directory
 *   node scripts/export-all-data.js --counts-only         # just size the job
 *
 * Use DATABASE_PUBLIC_URL, not DATABASE_URL, when running from your own
 * machine — the internal one only resolves inside Railway's network.
 *
 * WHAT A RESTORE LOOKS LIKE
 * The schema is not in these files and does not need to be: server/db.js
 * creates every table on boot and is the single source of truth for the
 * structure. So a restore is (1) point the app at an empty database and start
 * it, which builds all 126 tables, (2) load these JSONL files back in parent
 * before child order. The manifest records the row count per table so a
 * restore can be checked against it rather than assumed.
 *
 * TAKE ONE AND READ IT BACK. A backup nobody has restored is a guess, which is
 * the exact finding OPS-1 has been carrying since August.
 */

const fs = require('fs');
const path = require('path');
const { Client } = require('pg');

const ARGV = process.argv.slice(2);
const COUNTS_ONLY = ARGV.includes('--counts-only');
const OUT = (() => {
  const i = ARGV.indexOf('--out');
  if (i !== -1 && ARGV[i + 1]) return ARGV[i + 1];
  const d = new Date().toISOString().slice(0, 10);
  return path.join(process.cwd(), 'p86-backup-' + d);
})();
const BATCH = 5000;

const url = process.env.DATABASE_URL || process.env.DATABASE_PUBLIC_URL || '';
if (!url) {
  console.error('\nSet DATABASE_URL first (use Railway\'s DATABASE_PUBLIC_URL when running');
  console.error('from your own machine — the internal host only resolves inside Railway).\n');
  console.error('  PowerShell:  $env:DATABASE_URL="postgresql://..."');
  console.error('  bash:        export DATABASE_URL=\'postgresql://...\'\n');
  process.exit(1);
}

/* Railway terminates TLS with its own chain; server/db.js does the same thing. */
const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: false } });

const human = (n) => (n < 1024 ? n + ' B'
  : n < 1048576 ? (n / 1024).toFixed(1) + ' KB'
  : (n / 1048576).toFixed(1) + ' MB');

/* Identifiers come from the catalogue, but quote them anyway rather than
 * trusting that forever. */
function q(ident) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(ident)) throw new Error('refusing identifier: ' + ident);
  return '"' + ident + '"';
}

async function main() {
  await client.connect();

  const { rows: tables } = await client.query(`
    SELECT c.relname AS name, c.reltuples::bigint AS est
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r'
     ORDER BY c.relname`);

  console.log('\n' + tables.length + ' tables in this database.\n');

  /* Exact counts. reltuples is an estimate and a backup is not a place for
   * estimates — the manifest has to be checkable against a restore. */
  const plan = [];
  let grand = 0;
  for (const t of tables) {
    const { rows } = await client.query('SELECT COUNT(*)::bigint AS n FROM ' + q(t.name));
    const n = Number(rows[0].n);
    grand += n;
    plan.push({ table: t.name, rows: n });
  }

  plan.slice().sort((a, b) => b.rows - a.rows).slice(0, 15).forEach((p) => {
    if (p.rows) console.log('  ' + String(p.rows).padStart(9) + '  ' + p.table);
  });
  const empties = plan.filter((p) => !p.rows).length;
  console.log('\n  ' + String(grand).padStart(9) + '  TOTAL ROWS   (' + empties + ' tables are empty)\n');

  if (COUNTS_ONLY) { await client.end(); return; }

  fs.mkdirSync(OUT, { recursive: true });
  console.log('writing to ' + OUT + '\n');

  let bytes = 0;
  const manifest = { takenAt: new Date().toISOString(), database: 'project86', tables: [] };

  for (const p of plan) {
    if (!p.rows) { manifest.tables.push({ table: p.table, rows: 0, file: null }); continue; }

    const file = path.join(OUT, p.table + '.jsonl');
    const out = fs.createWriteStream(file, { flags: 'w' });
    let written = 0;

    /* Batched by OFFSET with a stable order. Slower than a cursor, but it needs
     * no extra dependency and never holds a whole large table in memory. */
    for (let off = 0; off < p.rows; off += BATCH) {
      const { rows } = await client.query(
        'SELECT * FROM ' + q(p.table) + ' ORDER BY 1 LIMIT $1 OFFSET $2', [BATCH, off]);
      if (!rows.length) break;
      for (const r of rows) {
        out.write(JSON.stringify(r, (k, v) => (Buffer.isBuffer(v) ? { __bytea: v.toString('base64') } : v)) + '\n');
        written++;
      }
      process.stdout.write('\r  ' + p.table + ': ' + written + '/' + p.rows + '   ');
    }
    await new Promise((res) => out.end(res));

    const size = fs.statSync(file).size;
    bytes += size;
    manifest.tables.push({ table: p.table, rows: written, file: p.table + '.jsonl', bytes: size });
    console.log('\r  ' + p.table + ': ' + written + ' rows, ' + human(size) + '            ');

    if (written !== p.rows) {
      console.log('  !! ' + p.table + ': expected ' + p.rows + ', wrote ' + written
        + ' — the table changed while it was being read.');
    }
  }

  manifest.totalRows = grand;
  manifest.totalBytes = bytes;
  fs.writeFileSync(path.join(OUT, '_manifest.json'), JSON.stringify(manifest, null, 2));

  console.log('\n' + '='.repeat(60));
  console.log('DONE — ' + grand + ' rows, ' + human(bytes) + ' in ' + OUT);
  console.log('_manifest.json records the row count per table. Check a restore');
  console.log('against it rather than assuming it worked.');
  console.log('\nTHIS FILE SET CONTAINS SECRETS: Microsoft OAuth tokens, MCP');
  console.log('connector bearer tokens stored in plain text, and possibly the');
  console.log('web-push private key. Encrypt it at rest and do not email it.');
  console.log('\nThe photos and documents are NOT in here — those live in the');
  console.log('Cloudflare R2 bucket and need a separate copy.');
  await client.end();
}

main().catch((e) => {
  console.error('\n' + (e.stack || e));
  console.error('\nIf this is a connection error, check you used DATABASE_PUBLIC_URL');
  console.error('rather than the internal DATABASE_URL.');
  process.exitCode = 1;
  try { client.end(); } catch (_) {}
});
