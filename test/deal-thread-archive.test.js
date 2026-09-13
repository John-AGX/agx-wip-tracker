// THE BOOT STEP ARCHIVES EXACTLY THE DEAL THREADS HUNG FROM ANOTHER TENANT'S
// LINEAGE — AND NOTHING ELSE, AND NOTHING TWICE.
//
// server/services/deal-thread-archive.js, invoked from server/index.js on every
// boot. Driven against a real SQL engine (test/helpers/pg-sqlite.js) with a
// two-org fixture; every statement it runs must prepare and run (the shim
// throws on anything it cannot translate, and the step is called on the raw
// engine pool, so nothing is swallowed).

'use strict';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const { archiveForeignDealThreads } = require('../server/services/deal-thread-archive');

const TABLES = ['organizations', 'users', 'jobs', 'leads', 'estimates', 'ai_sessions', 'ai_messages'];
const ORGS = { A: 900000501, B: 900000502 };
const USERS = { a: 801, b: 802, noorg: 803 };

function build() {
  const engine = createPgSqlite(
    sqliteSchema(TABLES, { pk: { organizations: 'id', users: 'id', jobs: 'id', leads: 'id', estimates: 'id', ai_sessions: 'id', ai_messages: 'id' } }),
    { jsonColumns: ['data'], dateColumns: ['archived_at', 'created_at', 'last_used_at', 'updated_at'] }
  );
  const db = engine.db;
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORGS.A, 'Arch A', 'arch-a');
  db.prepare('INSERT INTO organizations (id,name,slug) VALUES (?,?,?)').run(ORGS.B, 'Arch B', 'arch-b');
  const u = db.prepare('INSERT INTO users (id,email,name,role,organization_id,active) VALUES (?,?,?,?,?,1)');
  u.run(USERS.a, 'a@arch.test', 'A', 'admin', ORGS.A);
  u.run(USERS.b, 'b@arch.test', 'B', 'admin', ORGS.B);
  u.run(USERS.noorg, 'n@arch.test', 'N', 'admin', null);
  db.prepare('INSERT INTO leads (id,title,organization_id) VALUES (?,?,?)').run('lead-arch-a', 'A lead', ORGS.A);
  db.prepare('INSERT INTO leads (id,title,organization_id) VALUES (?,?,?)').run('lead-arch-b', 'B lead', ORGS.B);
  db.prepare('INSERT INTO leads (id,title,organization_id) VALUES (?,?,?)').run('lead-arch-legacy', 'Legacy lead', null);
  db.prepare('INSERT INTO jobs (id,owner_id,organization_id,data) VALUES (?,?,?,?)').run('job-arch-b', USERS.b, ORGS.B, '{}');
  db.prepare('INSERT INTO estimates (id,owner_id,organization_id,data) VALUES (?,?,?,?)').run('est-arch-b', USERS.b, ORGS.B, '{}');

  const ses = db.prepare(`INSERT INTO ai_sessions (id,agent_key,entity_type,entity_id,user_id,anthropic_session_id,anthropic_agent_id,
      session_kind,lineage_root,archived_at,created_at,last_used_at) VALUES (?,?,?,?,?,?,?,?,?,?,'2026-09-01 12:00:00','2026-09-01 12:00:00')`);
  const S = {
    aOnBLead:    [1, 'lead', 'lead-arch-b', USERS.a, 'deal_thread', 'lead-arch-b', null],       // archive (A->B)
    aOnBJob:     [2, 'job', 'job-arch-b', USERS.a, 'deal_thread', 'job-arch-b', null],          // archive (A->B)
    bOnALead:    [3, 'lead', 'lead-arch-a', USERS.b, 'deal_thread', 'lead-arch-a', null],       // archive (B->A)
    aOnBEst:     [4, 'estimate', 'est-arch-b', USERS.a, 'deal_thread', 'est-arch-b', null],     // archive (A->B)
    aSameOrg:    [5, 'lead', 'lead-arch-a', USERS.a, 'deal_thread', 'lead-arch-a', null],       // same org: untouched
    aMissing:    [6, 'lead', 'lead-arch-gone', USERS.a, 'deal_thread', 'lead-arch-gone', null], // missing root: untouched
    aUserThread: [7, 'general', 'global', USERS.a, 'user_thread', 'lead-arch-b', null],         // non-deal w/ foreign root: untouched
    aLegacy:     [8, 'job', 'job-arch-b', USERS.a, 'legacy_partitioned', null, null],           // non-deal on foreign entity: untouched
    aArchived:   [9, 'lead', 'lead-arch-b', USERS.a, 'deal_thread', 'lead-arch-b', '2026-01-01 00:00:00'], // already archived: untouched
    noOrgUser:   [10, 'lead', 'lead-arch-b', USERS.noorg, 'deal_thread', 'lead-arch-b', null],  // user has no org: untouched
    aLegacyRoot: [11, 'lead', 'lead-arch-legacy', USERS.a, 'deal_thread', 'lead-arch-legacy', null], // un-stamped root: untouched
    aNoRoot:     [12, 'lead', 'lead-arch-a', USERS.a, 'deal_thread', null, null]                // no lineage root: untouched
  };
  for (const v of Object.values(S)) ses.run(v[0], 'job', v[1], v[2], v[3], 'sess_' + v[0], 'agent', v[4], v[5], v[6]);
  const msg = db.prepare(`INSERT INTO ai_messages (id,estimate_id,user_id,role,content,entity_type,session_id,organization_id)
    VALUES (?,?,?,?,?,?,?,?)`);
  msg.run('m1', 'lead-arch-b', USERS.a, 'assistant', 'B contract figure', 'lead', 1, ORGS.A);
  msg.run('m2', 'job-arch-b', USERS.a, 'user', 'job turn', 'job', 2, ORGS.A);
  msg.run('m5', 'lead-arch-a', USERS.a, 'user', 'own turn', 'lead', 5, ORGS.A);
  return { engine, S };
}

const snapshot = (db) => ({
  sessions: db.prepare('SELECT id, session_kind, lineage_root, archived_at, user_id, entity_type, entity_id FROM ai_sessions ORDER BY id').all(),
  messages: db.prepare('SELECT * FROM ai_messages ORDER BY id').all()
});

describe('foreign deal-thread archive', () => {
  let engine, S, before, first, second, logs1, logs2, after1;
  beforeAll(async () => {
    ({ engine, S } = build());
    before = snapshot(engine.db);
    logs1 = [];
    first = await archiveForeignDealThreads(engine.pool, { log: (m) => logs1.push(m) });
    after1 = snapshot(engine.db);
    logs2 = [];
    second = await archiveForeignDealThreads(engine.pool, { log: (m) => logs2.push(m) });
  });
  afterAll(() => { try { engine.close(); } catch (_) {} });

  const archivedIds = (snap) => snap.sessions.filter((r) => r.archived_at != null).map((r) => Number(r.id)).sort((a, b) => a - b);

  test('first run: counts per org pair and per left-alone class', () => {
    expect(first).toEqual({
      scanned: 9, archived: 4, sameOrg: 2, missingRoot: 1, noLineageRoot: 1, sessionOrgUnresolved: 1,
      pairs: { [ORGS.A + '->' + ORGS.B]: 3, [ORGS.B + '->' + ORGS.A]: 1 }
    });
  });
  test('first run: exactly the four foreign deal threads are archived (plus the one already archived)', () => {
    expect(archivedIds(after1)).toEqual([S.aOnBLead[0], S.aOnBJob[0], S.bOnALead[0], S.aOnBEst[0], S.aArchived[0]].sort((a, b) => a - b));
  });
  test('one log line per org pair, then a summary line', () => {
    expect(logs1).toEqual([
      '[deal-thread-archive] org ' + ORGS.A + ' deal threads on org ' + ORGS.B + ' lineage: archived 3',
      '[deal-thread-archive] org ' + ORGS.B + ' deal threads on org ' + ORGS.A + ' lineage: archived 1',
      '[deal-thread-archive] scanned 9 active deal thread(s): archived 4, same-org 2, missing root 1 (left), no lineage root 1 (left), user without org 1 (left)'
    ]);
  });
  test('second run archives 0 and changes nothing', () => {
    expect([second.archived, second.pairs, second.scanned]).toEqual([0, {}, 5]);
    expect(snapshot(engine.db)).toEqual(after1);
    expect(logs2).toEqual(['[deal-thread-archive] scanned 5 active deal thread(s): archived 0, same-org 2, missing root 1 (left), no lineage root 1 (left), user without org 1 (left)']);
  });
  test('no row and no message deleted; only archived_at changed, only on the foreign deal threads', () => {
    expect(after1.messages).toEqual(before.messages);
    expect(after1.sessions.length).toBe(before.sessions.length);
    const changed = new Set([S.aOnBLead[0], S.aOnBJob[0], S.bOnALead[0], S.aOnBEst[0]]);
    after1.sessions.forEach((r, i) => {
      const b = before.sessions[i];
      if (changed.has(Number(r.id))) {
        expect([r.id, b.archived_at, r.archived_at != null, Object.assign({}, r, { archived_at: null })])
          .toEqual([b.id, null, true, Object.assign({}, b, { archived_at: null })]);
      } else {
        expect(r).toEqual(b);
      }
    });
  });
  test('untouched classes: same-org, missing root, non-deal, already archived, org-less user, legacy root, no root', () => {
    const byId = new Map(after1.sessions.map((r) => [Number(r.id), r]));
    for (const k of ['aSameOrg', 'aMissing', 'aUserThread', 'aLegacy', 'noOrgUser', 'aLegacyRoot', 'aNoRoot']) {
      expect([k, byId.get(S[k][0]).archived_at]).toEqual([k, null]);
    }
    expect(String(byId.get(S.aArchived[0]).archived_at)).toBe(String(before.sessions.find((r) => Number(r.id) === S.aArchived[0]).archived_at));
  });
});
