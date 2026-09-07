// THE MIGRATION, AND THE PROOF THAT IT IS INERT.
//
// Four columns land on `receipts` in a live pilot with real money in it:
// store_number, store_name, store_address, store_phone. This file exists to
// hold the two claims a schema commit is allowed to make and nothing else:
//
//   1. the columns are ADDITIVE — nullable, defaultless, IF NOT EXISTS, so an
//      existing row is not touched and a re-run is a no-op;
//   2. NOTHING READS THEM YET. A migration whose columns are already wired is
//      not revertable alone, which is the entire reason it is its own commit.
//
// And one claim about the money, which is the constraint the whole wave is
// under: no existing amount, cost code, job link or bucket total can move.
// That is not asserted here as a sentence — it is derived from the shape of
// the two statements that could move it.
//
// EVERYTHING IS PARSED FROM server/db.js. Nothing in this file types a column
// name and then checks that it is there; the derived column map is the oracle,
// for the reason test/helpers/db-schema.js exists at length.

const fs = require('fs');
const path = require('path');
const { tableColumns } = require('./helpers/db-schema');

// LF-normalized. The tree checks out CRLF on Windows, and every `;\n` anchor
// below would otherwise miss for a reason that has nothing to do with the code.
const lf = (p) => fs.readFileSync(p, 'utf8').replace(/\r\n?/g, '\n');

const DB_JS = lf(path.join(__dirname, '..', 'server', 'db.js'));
const RECEIPT_ROUTES = lf(path.join(__dirname, '..', 'server', 'routes', 'receipt-routes.js'));

const NEW_COLS = ['store_number', 'store_name', 'store_address', 'store_phone'];

describe('server/db.js is still JavaScript', () => {
  test('it parses, and it can be required', () => {
    // WRITING THIS COMMIT BROKE THE SERVER AND EVERY OTHER ASSERTION IN THIS
    // FILE STAYED GREEN. The schema DDL lives inside a JS template literal, and
    // the prose commentary added above the new columns contained a BACKTICK
    // (quoting a JSONB accessor). That backtick closed the literal, and db.js
    // stopped parsing at line 2248 — a boot crash on Railway, not a test
    // failure, because every schema helper in test/helpers/ reads this file as
    // TEXT and none of them require() it.
    //
    // Exactly one suite in 170 caught it, incidentally:
    // test/locked-record-refuses-every-writer.test.js is the only test that
    // requires ../server/db without mocking it. That is one file's habit
    // standing between a comment and a production outage, so the property is
    // written down here rather than left as luck.
    expect(() => require('../server/db')).not.toThrow();
  });
});

describe('the four columns are on receipts, and they are additive', () => {
  test('server/db.js declares all four on receipts', () => {
    const cols = tableColumns().tables.get('receipts');
    expect(cols).toBeDefined();
    const missing = NEW_COLS.filter((c) => !cols.has(c));
    expect(missing).toEqual([]);
  });

  test('each is TEXT, nullable, and defaultless', () => {
    // A NOT NULL or a DEFAULT would rewrite meaning onto every row that
    // already exists. NULL is the honest value for "nothing was read", and the
    // client is required to render that as a sentence rather than as blank.
    const cols = tableColumns().tables.get('receipts');
    for (const c of NEW_COLS) {
      const ty = String(cols.get(c) || '');
      expect({ col: c, type: ty }).toEqual({ col: c, type: 'TEXT' });
    }
    for (const c of NEW_COLS) {
      const stmt = new RegExp('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ' + c + '\\b[^\\n;]*', 'i')
        .exec(DB_JS);
      expect(stmt).not.toBeNull();
      expect(stmt[0]).not.toMatch(/NOT NULL/i);
      expect(stmt[0]).not.toMatch(/\bDEFAULT\b/i);
    }
  });

  test('each ALTER is IF NOT EXISTS, so boot is idempotent', () => {
    for (const c of NEW_COLS) {
      expect(DB_JS).toContain('ALTER TABLE receipts ADD COLUMN IF NOT EXISTS ' + c + ' TEXT;');
    }
  });

  test('the rollback is written down, in full, next to the migration', () => {
    // "A SCHEMA CHANGE IS A MIGRATION: its own commit, additive only, with the
    // rollback written out." A rollback that lives only in a commit message is
    // a rollback nobody finds at 2am with the pilot down.
    for (const c of NEW_COLS) {
      expect(DB_JS).toContain('ALTER TABLE receipts DROP COLUMN IF EXISTS ' + c + ';');
    }
  });

  test('no index was added on a column no query reads', () => {
    expect(DB_JS).not.toMatch(/CREATE INDEX[^\n;]*receipts\s*\([^)]*store_/i);
  });
});

describe('nothing reads them yet — this commit is revertable alone', () => {
  test('the receipts COLS projection does not name them', () => {
    // COLS is the explicit column list every receipt read and write projects
    // through (receipt-routes.js:48). A new column is invisible to the API
    // until it is added there, which is what makes this commit inert.
    const cols = /const COLS =\s*([\s\S]*?);\n/.exec(RECEIPT_ROUTES);
    expect(cols).not.toBeNull();
    for (const c of NEW_COLS) expect(cols[1]).not.toContain(c);
  });

  test('no server or client file outside db.js mentions them', () => {
    // Scoped to the receipt spelling: material_purchases has had its own
    // store_number since db.js:2219 and is not what this asks about.
    const roots = [
      path.join(__dirname, '..', 'server'),
      path.join(__dirname, '..', 'js'),
    ];
    const hits = [];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.js$/.test(e.name)) continue;
        if (p.endsWith(path.join('server', 'db.js'))) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const c of ['store_name', 'store_address', 'store_phone']) {
          if (src.includes(c)) hits.push(path.relative(path.join(__dirname, '..'), p) + ' : ' + c);
        }
      }
    };
    roots.forEach(walk);
    expect(hits).toEqual([]);
  });
});

describe('no existing amount, cost code, job link or bucket can move', () => {
  test('the money aggregate reads three columns and none of them is new', () => {
    // GET /api/receipts/rollup is the ONE statement that turns receipts into
    // money on a job. Its shape is the proof: it groups on cost_code and
    // is_presale and sums amount. A column it does not name cannot change what
    // it returns — that is a fact about the statement, not a hope about it.
    const start = RECEIPT_ROUTES.indexOf("router.get('/rollup'");
    expect(start).toBeGreaterThan(0);
    const rollup = RECEIPT_ROUTES.slice(start, RECEIPT_ROUTES.indexOf("router.get('/categories'", start));
    expect(rollup).toMatch(/SUM\(amount\)/i);
    expect(rollup).toMatch(/GROUP BY cost_code, is_presale/i);
    for (const c of NEW_COLS) expect(rollup).not.toContain(c);
  });

  test('the PATCH still preserves every column it does not receive', () => {
    // The trap this table is shaped for. PATCH /api/receipts/:id reads the row
    // with SELECT *, then writes an EXPLICIT SET list using
    // `has('x') ? b.x : row.x`. The photo-attach step
    // (js/cost-inbox.js) and the void/restore buttons all PATCH with one
    // field in the body. A column added to that SET list WITHOUT the preserve
    // idiom is nulled by every unrelated save — one fact, two writers, one of
    // them silent.
    const start = RECEIPT_ROUTES.indexOf("router.patch('/:id'");
    expect(start).toBeGreaterThan(0);
    const patch = RECEIPT_ROUTES.slice(start, RECEIPT_ROUTES.indexOf("router.delete('/:id'", start));
    // Every column named in the UPDATE ... SET list has a local whose value
    // falls back to row.<col> when the body did not carry it.
    const set = /UPDATE receipts SET([\s\S]*?)WHERE id = \$1/.exec(patch);
    expect(set).not.toBeNull();
    const named = [...set[1].matchAll(/([a-z_]+)\s*=\s*\$\d+/g)].map((m) => m[1])
      .filter((c) => c !== 'updated_at');
    expect(named.length).toBeGreaterThan(10);
    const unpreserved = named.filter((c) => !new RegExp("has\\('" + c + "'\\)").test(patch));
    // is_presale is DERIVED from the entity type on every save, by design.
    expect(unpreserved).toEqual(['is_presale']);
  });
});
