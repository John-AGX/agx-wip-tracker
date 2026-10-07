#!/usr/bin/env node
'use strict';
//  Project 86 — delete every user except one kept admin.
//
//  DRY RUN BY DEFAULT. Nothing is written without --apply.
//
//    node delete-users.js                 # keeps role=system_admin, dry run
//    node delete-users.js --apply         # keeps role=system_admin, commits
//    node delete-users.js --keep=someone@example.com --apply
//
//  Requires DATABASE_URL in the environment (Railway → Postgres →
//  Variables → DATABASE_PUBLIC_URL) and `npm install pg`.
//
//  WHY THIS IS NOT ONE DELETE STATEMENT. 117 foreign keys point at
//  users(id), with three different delete rules, and a plain
//  `DELETE FROM users` fails on the first of them:
//
//    RESTRICT / NO ACTION (16) — jobs.owner_id is NOT NULL REFERENCES
//      users(id). Postgres refuses the delete outright. These columns are
//      REASSIGNED to the kept admin first; that is the only way the delete
//      can proceed at all.
//    CASCADE (28) — the referencing rows are DESTROYED along with the user:
//      inbound_emails, email_attachments, ai_sessions, ai_memories,
//      payloads, calendar_events, reminders, user_notes, oauth_tokens and
//      more. This script counts them before you commit to it.
//    SET NULL (71) — created_by and friends go NULL. Attribution is lost
//      across the dataset, audit rows included.
//
//  The FK list is read from the live catalog rather than hardcoded, so it
//  is correct even if the schema has drifted from db.js.

const { Pool } = require('pg');

const args = process.argv.slice(2);
const APPLY = args.includes('--apply');
const keepArg = (args.find(a => a.startsWith('--keep=')) || '').split('=')[1];
const KEEP_EMAIL = (keepArg || process.env.SYSTEM_ADMIN_EMAIL || process.env.ADMIN_EMAIL || '').toLowerCase().trim();

if (!process.env.DATABASE_URL) { console.error('DATABASE_URL is not set.'); process.exit(1); }

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.DATABASE_URL.includes('.railway.internal') ? false : { rejectUnauthorized: false },
  connectionTimeoutMillis: 10000,
});
pool.on('error', e => console.error('[db] idle client error:', e.message));

const FK_SQL = `
  SELECT src.relname AS tbl, att.attname AS col, con.confdeltype AS rule, att.attnotnull AS notnull
    FROM pg_constraint con
    JOIN pg_class src ON src.oid = con.conrelid
    JOIN pg_class tgt ON tgt.oid = con.confrelid
    JOIN pg_namespace ns ON ns.oid = src.relnamespace
    JOIN unnest(con.conkey) AS k(attnum) ON true
    JOIN pg_attribute att ON att.attrelid = src.oid AND att.attnum = k.attnum
   WHERE con.contype = 'f' AND tgt.relname = 'users' AND ns.nspname = 'public'
   ORDER BY src.relname, att.attname`;

(async () => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // The survivor is the SYSTEM ADMIN. Resolved by role, not by a typed
    // address, because a typo in an email argument here deletes the account
    // it was meant to protect. --keep=<email> overrides, and is required if
    // the role is held by more than one account — the script will not guess
    // which of them the business still needs.
    let keeper;
    if (KEEP_EMAIL) {
      keeper = await client.query(
        'SELECT id, email, name, role, active FROM users WHERE lower(email) = $1', [KEEP_EMAIL]);
      if (!keeper.rows.length) throw new Error('No user with email ' + KEEP_EMAIL + ' — nothing was changed.');
    } else {
      keeper = await client.query(
        "SELECT id, email, name, role, active FROM users WHERE role = 'system_admin' ORDER BY id");
      if (!keeper.rows.length) {
        throw new Error('No user has role=system_admin. Pass --keep=<email> explicitly. Nothing was changed.');
      }
      if (keeper.rows.length > 1) {
        console.error('\n  More than one system_admin — refusing to choose:');
        keeper.rows.forEach(r => console.error('    #' + r.id + '  ' + r.email + '  (' + r.name + ')'));
        throw new Error('Re-run with --keep=<email> naming the one to keep. Nothing was changed.');
      }
    }
    const K = keeper.rows[0];

    const total = (await client.query('SELECT count(*)::int n FROM users')).rows[0].n;
    const doomed = (await client.query('SELECT count(*)::int n FROM users WHERE id <> $1', [K.id])).rows[0].n;

    console.log('\n  Database : ' + process.env.DATABASE_URL.replace(/:[^:@/]*@/, ':****@'));
    console.log('  Keeping  : #' + K.id + '  ' + K.email + '  (' + K.name + ', role=' + K.role + ', active=' + K.active + ')');
    console.log('  Deleting : ' + doomed + ' of ' + total + ' users\n');
    if (doomed === 0) { await client.query('ROLLBACK'); console.log('  Nothing to do.\n'); return; }

    const fks = (await client.query(FK_SQL)).rows;
    const reassign = fks.filter(f => f.rule === 'a' || f.rule === 'r' || f.rule === 'd' || (f.rule === 'n' && f.notnull));
    const cascade  = fks.filter(f => f.rule === 'c');
    const setnull  = fks.filter(f => f.rule === 'n' && !f.notnull);

    // 1. Reassign what cannot be nulled or cascaded. Without this the delete
    //    cannot run at all. NOT NULL + SET NULL is included: nulling it would
    //    violate the column, so it is reassigned too.
    console.log('  REASSIGNED TO THE KEPT ADMIN (' + reassign.length + ' columns)');
    let movedTotal = 0;
    for (const f of reassign) {
      const q = 'UPDATE "' + f.tbl + '" SET "' + f.col + '" = $1 WHERE "' + f.col + '" IS NOT NULL AND "' + f.col + '" <> $1';
      const n = APPLY
        ? (await client.query(q, [K.id])).rowCount
        : (await client.query('SELECT count(*)::int n FROM "' + f.tbl + '" WHERE "' + f.col + '" IS NOT NULL AND "' + f.col + '" <> $1', [K.id])).rows[0].n;
      if (n) { console.log('    ' + String(n).padStart(7) + '  ' + f.tbl + '.' + f.col); movedTotal += n; }
    }
    console.log('    ' + String(movedTotal).padStart(7) + '  TOTAL\n');

    // 2. Rows that will be destroyed outright. This is the part that is not
    //    recoverable from this database once committed.
    console.log('  DELETED BY CASCADE — THIS DATA IS DESTROYED (' + cascade.length + ' columns)');
    let killedTotal = 0;
    for (const f of cascade) {
      const n = (await client.query(
        'SELECT count(*)::int n FROM "' + f.tbl + '" WHERE "' + f.col + '" IS NOT NULL AND "' + f.col + '" <> $1', [K.id])).rows[0].n;
      if (n) { console.log('    ' + String(n).padStart(7) + '  ' + f.tbl + '  (via ' + f.col + ')'); killedTotal += n; }
    }
    console.log('    ' + String(killedTotal).padStart(7) + '  TOTAL ROWS DESTROYED\n');

    // 3. Attribution loss.
    let nulledTotal = 0;
    for (const f of setnull) {
      const n = (await client.query(
        'SELECT count(*)::int n FROM "' + f.tbl + '" WHERE "' + f.col + '" IS NOT NULL AND "' + f.col + '" <> $1', [K.id])).rows[0].n;
      nulledTotal += n;
    }
    console.log('  SET NULL — attribution erased on ' + nulledTotal + ' rows across ' + setnull.length + ' columns\n');

    const del = APPLY
      ? (await client.query('DELETE FROM users WHERE id <> $1', [K.id])).rowCount
      : doomed;
    console.log('  USERS DELETED: ' + del);

    if (APPLY) {
      await client.query('COMMIT');
      console.log('\n  COMMITTED. This cannot be undone from this database.\n');
    } else {
      await client.query('ROLLBACK');
      console.log('\n  DRY RUN — rolled back, nothing changed.');
      console.log('  Re-run with --apply to commit.\n');
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    console.error('\n  FAILED, nothing changed:', e.message, '\n');
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
