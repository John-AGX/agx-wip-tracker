// WORK ORDERS 1.29 — THE SCHEMA, AND THE LEDGERS THAT HAVE TO KNOW ABOUT IT.
//
// WHAT THIS FILE HOLDS
// server/db.js gains one block for 1.29, directly after the service ticket
// participants indexes: attachments.client_upload_id (upload dedupe), the
// approval-notice and crew-batch bookkeeping on service_tickets, who approved
// or cancelled a work order, office_seen_at, the service_ticket_flags table,
// the org/due index for the Work Orders page, and report_shares rows that hang
// off a work order instead of a job_reports row.
//
// A schema edit is only real when every copy of the schema a test builds from
// agrees with it, so the assertions here are over the DERIVED schema
// (test/helpers/db-schema.js), the db.js text the boot runs, a real SQL engine
// built from that derivation, and the two server ledgers a new table must be
// registered in: org-table-classification.js (or the org-boundary audit calls
// it unclassified) and org-reset.js (or a Danger Zone reset leaves crew flags
// behind for the next seed to trip over).
//
// Every source-shape claim below has a MUTANT: the same check run against a
// temp copy of the source with one CRLF-normalised anchor changed, proving the
// check can go red for the reason it names.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { tableColumns, sqliteSchema } = require('./helpers/db-schema');
const { createPgSqlite } = require('./helpers/pg-sqlite');

const ROOT = path.resolve(__dirname, '..');
const DB_JS = path.join(ROOT, 'server', 'db.js');
const RESET_JS = path.join(ROOT, 'server', 'services', 'org-reset.js');

const norm = (s) => String(s).replace(/\r\n/g, '\n');
const readNorm = (p) => norm(fs.readFileSync(p, 'utf8'));

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1a-schema-'));
  try { return fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

// Replace a unique anchor, or throw — a mutant whose anchor drifted must not
// "pass" by mutating nothing.
function mutate(src, anchor, replacement) {
  if (src.split(anchor).length !== 2) throw new Error('anchor not found');
  return src.replace(anchor, () => replacement);
}

const BLOCK_START = '    -- 1.29 work orders. Every statement is idempotent. No backfill.\n';
const BLOCK_END_LINE = '      ON report_shares(service_ticket_id, created_at DESC) WHERE service_ticket_id IS NOT NULL;\n';
const PARTICIPANTS_ANCHOR =
  '    CREATE INDEX IF NOT EXISTS idx_service_ticket_participants_user\n'
  + '      ON service_ticket_participants(organization_id, user_id);\n';

function newBlock(src) {
  const a = src.indexOf(BLOCK_START);
  if (a === -1 || src.indexOf(BLOCK_START, a + 1) !== -1) throw new Error('1.29 block start not found exactly once');
  const b = src.indexOf(BLOCK_END_LINE, a);
  if (b === -1) throw new Error('1.29 block end not found');
  return { start: a, end: b + BLOCK_END_LINE.length, text: src.slice(a, b + BLOCK_END_LINE.length) };
}

// ── The columns ────────────────────────────────────────────────────────────
const NEW_TICKET_COLUMNS = [
  'approval_notice_attempts', 'approval_notice_last_try_at', 'approval_notice_gave_up_at',
  'crew_activity_notified_at', 'crew_activity_prev_notified_at',
  'approved_at', 'approved_by', 'cancelled_at', 'cancelled_by',
  'office_seen_at',
];

const FLAG_COLUMNS = [
  'id', 'organization_id', 'ticket_id', 'task_id', 'share_id', 'author_label',
  'category', 'note', 'attachment_ids', 'status', 'resolved_by', 'resolved_at',
  'resolution_note', 'client_ref', 'created_at',
];

describe('the derived schema carries every 1.29 column', () => {
  test('service_tickets gains the notice, crew-batch, review and office_seen columns', () => {
    const cols = tableColumns().tables.get('service_tickets');
    expect(cols).toBeTruthy();
    const missing = NEW_TICKET_COLUMNS.filter((c) => !cols.has(c));
    expect(missing).toEqual([]);
  });

  test('attachments gains client_upload_id and report_shares gains service_ticket_id', () => {
    const { tables } = tableColumns();
    expect(tables.get('attachments').has('client_upload_id')).toBe(true);
    expect(tables.get('report_shares').has('service_ticket_id')).toBe(true);
    // report_id is still a column — it became nullable, it did not go away.
    expect(tables.get('report_shares').has('report_id')).toBe(true);
  });

  test('service_ticket_flags exists with exactly its 15 columns, in order', () => {
    const { tables, order } = tableColumns();
    expect(tables.has('service_ticket_flags')).toBe(true);
    expect(order.get('service_ticket_flags')).toEqual(FLAG_COLUMNS);
    expect(FLAG_COLUMNS.length).toBe(15);
  });
});

// ── Names: declared exactly once ───────────────────────────────────────────
const NEW_INDEXES = [
  'uq_attachments_client_upload',
  'idx_service_tickets_awaiting_notice',
  'idx_service_ticket_events_share_recent',
  'idx_service_ticket_flags_ticket',
  'idx_service_ticket_flags_open',
  'uq_service_ticket_flags_client_ref',
  'idx_service_tickets_org_due',
  'idx_report_shares_ticket',
];
const NEW_CONSTRAINTS = [
  'service_ticket_flags_category_chk',
  'service_ticket_flags_status_chk',
  'report_shares_parent_chk',
];

const countOf = (src, re) => (src.match(re) || []).length;
const wordRe = (name) => new RegExp('\\b' + name + '\\b', 'g');

function indexDeclCount(src, name) {
  return countOf(src, new RegExp('INDEX\\s+IF\\s+NOT\\s+EXISTS\\s+' + name + '\\b', 'g'));
}
function constraintDeclCount(src, name) {
  return countOf(src, new RegExp('ADD\\s+CONSTRAINT\\s+' + name + '\\b', 'g'));
}

describe('each new index and constraint is declared exactly once in server/db.js', () => {
  const src = readNorm(DB_JS);

  test.each(NEW_INDEXES)('index %s', (name) => {
    expect(indexDeclCount(src, name)).toBe(1);
    // An index name appears nowhere else — no second spelling in a comment
    // that a later reader could take for the real one.
    expect(countOf(src, wordRe(name))).toBe(1);
  });

  test.each(NEW_CONSTRAINTS)('constraint %s', (name) => {
    expect(constraintDeclCount(src, name)).toBe(1);
    // The IF NOT EXISTS guard shape: two dollar tags, the conname probe and the
    // ADD CONSTRAINT itself. Nothing more.
    expect(countOf(src, wordRe(name))).toBe(4);
    expect(src).toContain("WHERE conname = '" + name + "'");
  });

  test('the cron indexes lead with organization_id (critique #14)', () => {
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_tickets_awaiting_notice\n\s+ON service_tickets\(organization_id, completed_at\)/);
    expect(src).toMatch(/CREATE INDEX IF NOT EXISTS idx_service_ticket_events_share_recent\n\s+ON service_ticket_events\(organization_id, created_at\)/);
  });

  test('work_order_notify_log is an app_settings key, not a table', () => {
    expect(tableColumns().tables.has('work_order_notify_log')).toBe(false);
    expect(src).not.toMatch(/CREATE\s+TABLE\s+(IF\s+NOT\s+EXISTS\s+)?work_order_notify_log/i);
  });

  test('MUTANT: a second declaration of an index goes red', () => withTempDir((dir) => {
    const copy = path.join(dir, 'db.js');
    fs.writeFileSync(copy, mutate(src, BLOCK_END_LINE,
      BLOCK_END_LINE + '    CREATE INDEX IF NOT EXISTS idx_service_tickets_org_due ON service_tickets(due_date);\n'));
    const mutated = readNorm(copy);
    expect(indexDeclCount(mutated, 'idx_service_tickets_org_due')).toBe(2);
  }));

  test('MUTANT: an awaiting-notice index without organization_id goes red', () => withTempDir((dir) => {
    const copy = path.join(dir, 'db.js');
    fs.writeFileSync(copy, mutate(src,
      'ON service_tickets(organization_id, completed_at)', 'ON service_tickets(completed_at)'));
    const mutated = readNorm(copy);
    expect(() => expect(mutated).toMatch(
      /CREATE INDEX IF NOT EXISTS idx_service_tickets_awaiting_notice\n\s+ON service_tickets\(organization_id, completed_at\)/)).toThrow();
  }));
});

// ── Order on a fresh database ──────────────────────────────────────────────
// The schema runs top to bottom. An ALTER on a table that has not been created
// yet fails the first boot of a new database, and a REFERENCES to a table that
// comes later does the same.
//
// The CREATE text is assembled rather than spelled out: test/schema-truth.test.js
// reads every test file for fixture DDL, and a literal create-table-paren here
// would read to it as a hand-declared fixture.
const createStmt = (table) => ['CREATE', 'TABLE', 'IF', 'NOT', 'EXISTS', table].join(' ') + ' (';

function orderProblems(src) {
  const problems = [];
  const at = (needle) => {
    const i = src.indexOf(needle);
    if (i === -1) problems.push('missing: ' + needle);
    else if (src.indexOf(needle, i + 1) !== -1) problems.push('not unique: ' + needle);
    return i;
  };
  const dropNotNull = at('ALTER TABLE report_shares ALTER COLUMN report_id DROP NOT NULL');
  const reportShares = at(createStmt('report_shares'));
  const tickets = at(createStmt('service_tickets'));
  const shares = at(createStmt('service_ticket_shares'));
  const tasks = at(createStmt('tasks'));
  const flags = at(createStmt('service_ticket_flags'));
  if (!(dropNotNull > reportShares)) problems.push('report_id DROP NOT NULL runs before report_shares exists');
  if (!(dropNotNull > tickets)) problems.push('report_shares.service_ticket_id runs before service_tickets exists');
  if (!(flags > tickets && flags > shares && flags > tasks)) problems.push('service_ticket_flags is created before a table it references');
  return problems;
}

describe('the 1.29 block sits where a fresh database can run it', () => {
  const src = readNorm(DB_JS);

  test('report_id DROP NOT NULL comes after report_shares and service_tickets are created', () => {
    expect(orderProblems(src)).toEqual([]);
  });

  test('the block starts directly after the participants user index', () => {
    const block = newBlock(src);
    const anchorAt = src.indexOf(PARTICIPANTS_ANCHOR);
    expect(anchorAt).toBeGreaterThan(-1);
    expect(src.slice(anchorAt + PARTICIPANTS_ANCHOR.length, block.start)).toMatch(/^\s*$/);
  });

  test('MUTANT: the DROP NOT NULL moved above report_shares goes red', () => withTempDir((dir) => {
    const copy = path.join(dir, 'db.js');
    let m = mutate(src, '    ALTER TABLE report_shares ALTER COLUMN report_id DROP NOT NULL;\n', '');
    m = mutate(m, '    ' + createStmt('report_shares') + '\n',
      '    ALTER TABLE report_shares ALTER COLUMN report_id DROP NOT NULL;\n    ' + createStmt('report_shares') + '\n');
    fs.writeFileSync(copy, m);
    expect(orderProblems(readNorm(copy))).toContain('report_id DROP NOT NULL runs before report_shares exists');
  }));
});

// ── The flag CHECK literals ────────────────────────────────────────────────
function checkLiterals(src, constraint, column) {
  const re = new RegExp('ADD CONSTRAINT ' + constraint + '\\s+CHECK\\s*\\(\\s*' + column + '\\s+IN\\s*\\(([^)]*)\\)\\s*\\)', 'g');
  const found = [...src.matchAll(re)];
  if (found.length !== 1) throw new Error(constraint + ' found ' + found.length + ' times');
  return found[0][1].split(',').map((x) => x.trim().replace(/^'|'$/g, ''));
}

describe('service_ticket_flags CHECKs', () => {
  const src = readNorm(DB_JS);

  test('category and status literals are exactly the contract lists', () => {
    expect(checkLiterals(src, 'service_ticket_flags_category_chk', 'category'))
      .toEqual(['no_access', 'extra_damage', 'material_short', 'safety', 'other']);
    expect(checkLiterals(src, 'service_ticket_flags_status_chk', 'status'))
      .toEqual(['open', 'resolved']);
  });

  test('report_shares_parent_chk requires one of the two parents', () => {
    expect(src).toMatch(/ADD CONSTRAINT report_shares_parent_chk\s+CHECK \(report_id IS NOT NULL OR service_ticket_id IS NOT NULL\)/);
  });

  test('MUTANT: a category CHECK missing safety goes red', () => withTempDir((dir) => {
    const copy = path.join(dir, 'db.js');
    fs.writeFileSync(copy, mutate(src,
      "CHECK (category IN ('no_access','extra_damage','material_short','safety','other'))",
      "CHECK (category IN ('no_access','extra_damage','material_short','other'))"));
    expect(() => expect(checkLiterals(readNorm(copy), 'service_ticket_flags_category_chk', 'category'))
      .toEqual(['no_access', 'extra_damage', 'material_short', 'safety', 'other'])).toThrow();
  }));
});

// ── No tolerance arm ───────────────────────────────────────────────────────
const TOLERANCE = 'organization_id' + ' IS NULL';

describe('the 1.29 block adds no tolerance arm', () => {
  const src = readNorm(DB_JS);

  test('the block contains no organization-null arm, comments included', () => {
    const block = newBlock(src);
    expect(block.text.length).toBeGreaterThan(2000);
    expect(block.text.indexOf(TOLERANCE)).toBe(-1);
  });

  test('MUTANT: a tolerance arm inside the block goes red', () => withTempDir((dir) => {
    const copy = path.join(dir, 'db.js');
    fs.writeFileSync(copy, mutate(src,
      "ON service_ticket_flags(organization_id, ticket_id) WHERE status = 'open';",
      "ON service_ticket_flags(organization_id, ticket_id) WHERE status = 'open' OR " + TOLERANCE + ';'));
    expect(newBlock(readNorm(copy)).text.indexOf(TOLERANCE)).toBeGreaterThan(-1);
  }));
});

// ── A real engine built from the derivation ────────────────────────────────
describe('sqliteSchema builds the 1.29 tables and accepts their rows', () => {
  let engine;
  beforeAll(() => {
    engine = createPgSqlite(
      sqliteSchema(['organizations', 'service_tickets', 'service_ticket_flags', 'attachments', 'report_shares']),
      { jsonColumns: ['attachment_ids'] });
  });
  afterAll(() => { if (engine) engine.close(); });

  test('a flag row, a work-order report share and a deduped upload all insert and read back', async () => {
    const q = engine.pool.query;
    await q('INSERT INTO organizations (id, name, slug) VALUES ($1, $2, $3)', [1, 'Alpha', 'alpha']);
    await q(
      `INSERT INTO service_tickets (id, organization_id, title, status, approval_notice_attempts, approved_at, approved_by, office_seen_at)
       VALUES ($1, $2, $3, $4, $5, NOW(), $6, NOW())`,
      ['st_1', 1, 'Roof leak', 'approved', 0, 7]);
    await q(
      `INSERT INTO service_ticket_flags (id, organization_id, ticket_id, task_id, share_id, author_label, category, note, attachment_ids, status, client_ref, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, $10, $11, NOW())`,
      ['stf_1', 1, 'st_1', null, 'sts_1', 'Crew lead', 'no_access', 'Gate locked', ['att_9'], 'open', 'ref-abc']);
    await q(
      `INSERT INTO report_shares (id, organization_id, report_id, service_ticket_id, entity_type, entity_id, token_hash, scope, document, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb, NOW())`,
      ['rs_1', 1, null, 'st_1', 'service_ticket', 'st_1', 'hash', 'view', { sections: [] }]);
    await q(
      `INSERT INTO attachments (id, organization_id, entity_type, entity_id, filename, client_upload_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      ['att_9', 1, 'service_ticket', 'st_1', 'gate.jpg', 'up_12345678']);

    const flags = await q(
      "SELECT id, category, status, attachment_ids FROM service_ticket_flags WHERE organization_id = $1 AND status = 'open'", [1]);
    expect(flags.rows).toEqual([{ id: 'stf_1', category: 'no_access', status: 'open', attachment_ids: ['att_9'] }]);
    const share = await q('SELECT report_id, service_ticket_id FROM report_shares WHERE organization_id = $1', [1]);
    expect(share.rows).toEqual([{ report_id: null, service_ticket_id: 'st_1' }]);
    const att = await q('SELECT client_upload_id FROM attachments WHERE organization_id = $1 AND entity_id = $2', [1, 'st_1']);
    expect(att.rows[0].client_upload_id).toBe('up_12345678');
    const t = await q('SELECT COALESCE(approval_notice_attempts, 0) AS n, approved_by FROM service_tickets WHERE organization_id = $1 AND id = $2', [1, 'st_1']);
    expect(t.rows[0]).toEqual({ n: 0, approved_by: 7 });
  });
});

// ── The ledgers: classification and the org reset ──────────────────────────
describe('service_ticket_flags is registered in the tenancy ledgers', () => {
  test('org-table-classification calls it DIRECT', () => {
    const { classify, DIRECT } = require('../server/services/org-table-classification');
    expect(DIRECT).toContain('service_ticket_flags');
    expect(classify('service_ticket_flags')).toBe('direct');
  });

  test('its own organization_id column is NOT NULL in db.js', () => {
    const cols = tableColumns().tables.get('service_ticket_flags');
    expect(cols.get('organization_id')).toMatch(/NOT NULL/);
    expect(cols.get('share_id')).toMatch(/ON DELETE SET NULL/);
    expect(cols.get('task_id')).toMatch(/ON DELETE SET NULL/);
  });
});

// Driven, not read: resetOrgData runs against a real engine with two tenants'
// flags in it. The engine has no foreign keys (the derivation emits none), so
// nothing cascades for free — a flag row only disappears if the reset issues
// the statement.
const RESET_TABLES = [
  'organizations', 'leads', 'jobs', 'estimates', 'projects', 'tasks', 'attachments',
  'service_tickets', 'service_ticket_flags', 'service_ticket_revisions',
  'service_ticket_participants', 'service_ticket_events', 'service_ticket_shares',
];

function seedTwoTenants(engine) {
  const db = engine.db;
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(1, 'Alpha', 'alpha');
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(2, 'Bravo', 'bravo');
  const tk = db.prepare('INSERT INTO service_tickets (id, organization_id, title, status, job_id) VALUES (?,?,?,?,?)');
  tk.run('st_a', 1, 'A', 'open', 'job_a');
  tk.run('st_b', 2, 'B', 'open', 'job_b');
  const fl = db.prepare(
    "INSERT INTO service_ticket_flags (id, organization_id, ticket_id, category, note, attachment_ids, status) VALUES (?,?,?,?,?,'[]','open')");
  fl.run('stf_a1', 1, 'st_a', 'safety', 'loose rail');
  fl.run('stf_a2', 1, 'st_a', 'other', 'dog in yard');
  fl.run('stf_b1', 2, 'st_b', 'safety', 'foreign tenant flag');
}

async function runReset(resetModulePath, engine) {
  let result;
  await jest.isolateModulesAsync(async () => {
    jest.doMock(path.join(ROOT, 'server', 'db.js'), () => ({ pool: engine.pool }));
    const { resetOrgData } = require(resetModulePath);
    result = await resetOrgData(1);
  });
  return result;
}

describe('resetOrgData removes the resetting org\'s flags and only those', () => {
  afterEach(() => { jest.dontMock(path.join(ROOT, 'server', 'db.js')); });

  test('org A\'s flags go, org B\'s stay, and the count is reported', async () => {
    const engine = createPgSqlite(sqliteSchema(RESET_TABLES));
    try {
      seedTwoTenants(engine);
      const r = await runReset(RESET_JS, engine);
      expect(r.ok).toBe(true);
      expect(r.deleted.service_ticket_flags).toBe(2);
      expect(r.skipped.map((s) => s.table)).not.toContain('service_ticket_flags');
      expect(engine.all('SELECT id FROM service_ticket_flags ORDER BY id')).toEqual([{ id: 'stf_b1' }]);
      expect(engine.all('SELECT id FROM service_tickets ORDER BY id')).toEqual([{ id: 'st_b' }]);
    } finally {
      engine.close();
    }
  });

  test('the flags delete runs before revisions, shares and tickets', () => {
    const src = readNorm(RESET_JS);
    const flags = src.indexOf("await del('service_ticket_flags', 'DELETE FROM service_ticket_flags WHERE organization_id = $1');");
    expect(flags).toBeGreaterThan(-1);
    expect(flags).toBeLessThan(src.indexOf("await del('service_ticket_revisions'"));
    expect(flags).toBeLessThan(src.indexOf("await del('service_ticket_shares'"));
    expect(flags).toBeLessThan(src.indexOf("await del('service_tickets'"));
  });

  test('MUTANT: a reset without the flags delete leaves org A\'s flags behind', async () => {
    const src = readNorm(RESET_JS);
    await withTempDirAsync(async (dir) => {
      fs.mkdirSync(path.join(dir, 'services'));
      // The chained module: the copy's require('../db') lands here.
      fs.writeFileSync(path.join(dir, 'db.js'), 'module.exports = { pool: globalThis.__W1A_RESET_POOL__ };\n');
      const copy = path.join(dir, 'services', 'org-reset.js');
      fs.writeFileSync(copy, mutate(src,
        "    await del('service_ticket_flags', 'DELETE FROM service_ticket_flags WHERE organization_id = $1');\n", ''));
      const engine = createPgSqlite(sqliteSchema(RESET_TABLES));
      try {
        seedTwoTenants(engine);
        globalThis.__W1A_RESET_POOL__ = engine.pool;
        let r;
        await jest.isolateModulesAsync(async () => {
          r = await require(copy).resetOrgData(1);
        });
        expect(r.ok).toBe(true);
        expect(r.deleted.service_ticket_flags).toBeUndefined();
        expect(engine.all('SELECT id FROM service_ticket_flags WHERE organization_id = 1').length).toBe(2);
      } finally {
        delete globalThis.__W1A_RESET_POOL__;
        engine.close();
      }
    });
  });
});

async function withTempDirAsync(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'w1a-reset-'));
  try { return await fn(dir); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}
