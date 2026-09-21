// EVERY "does anything still point at this?" CHECK THE UNDO RUNS IS A QUERY
// THAT RUNS.
//
// sync-journal.js refuses to delete a record a sync created while another
// record still points at it, and it finds out by querying each REFERRERS entry.
// One of those entries named a column that does not exist (estimates.lead_id —
// an estimate's lead lives at data->>'lead_id'), so undoing ANY run that had
// created a lead threw, rolled back, and answered 500. Nothing had exercised
// that path: the undo suite's runs created jobs, never leads. This file runs
// every entry against the schema derived from server/db.js, so a referrer that
// names a column the table does not have fails here and not in front of
// somebody trying to take a bad run back.
'use strict';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, tableNames } = require('./helpers/db-schema');
const journal = require('../server/services/clickr/sync-journal');

const engine = createPgSqlite(sqliteSchema(tableNames()), { jsonColumns: ['data'] });
afterAll(() => engine.close());

const TABLES = Object.keys(journal.REFERRERS);

test('every table a sync can create into has its referrers listed', () => {
  // A table missing here is a created row the undo deletes without looking.
  for (const t of Object.values(journal.TABLE)) expect([t, TABLES.includes(t)]).toEqual([t, true]);
});

test.each(TABLES)('the referrer checks for %s all run', async (table) => {
  await expect(journal.blockedBy(engine.pool, 1, table, 'no-such-id')).resolves.toBeNull();
});

test('a lead an estimate still names is NOT deleted by an undo', async () => {
  engine.db.prepare('INSERT INTO estimates (id, data) VALUES (?, ?)').run('est-1', JSON.stringify({ lead_id: 'lead-1', title: 'Gazebo' }));
  await expect(journal.blockedBy(engine.pool, 1, 'leads', 'lead-1')).resolves.toBe('estimates');
  await expect(journal.blockedBy(engine.pool, 1, 'leads', 'lead-2')).resolves.toBeNull();
});
