// THE MIGRATION, AND THE PROOF THAT IT IS INERT.
//
// Five columns land on `receipts` in a live pilot with real money in it:
// store_number, store_name, store_address, store_phone, store_phone_kind. This
// file exists to hold the two claims a schema commit is allowed to make and nothing else:
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

// THE FIFTH ARRIVED, AND THIS IS THE REVISIT db.js ASKED FOR. store_phone_kind
// is not a fifth IDENTITY field — it is the second half of store_phone. The
// design these columns shipped under says a number is TWO FACTS, the digits and
// WHAT KIND OF LINE they are, and the second fact was being re-derived from the
// digits at read time. That works for a 1-800 number, whose kind is in its area
// code. It cannot work for a FAX LINE, whose kind exists only in the word
// printed beside it on the paper — a word normalizePhone() throws away and
// nothing downstream can recover. So it is written down at capture.
//
// It is in this list rather than exempted from it because every claim the list
// makes is a claim that must hold for it too: TEXT, nullable, defaultless,
// IF NOT EXISTS, rollback written out, unreadable by the money aggregate.
const NEW_COLS = ['store_number', 'store_name', 'store_address', 'store_phone', 'store_phone_kind'];

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

describe('the store columns are on receipts, and they are additive', () => {
  test('server/db.js declares every one of them on receipts', () => {
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

// ── WHAT USED TO BE HERE, AND WHY IT IS NOT ──────────────────────────────
// The migration commit (77f3fa26) carried two assertions that the columns were
// UNREAD: COLS did not name them, and no file outside db.js mentioned them.
// Those were claims about that commit in isolation, and they were true when it
// was made — that is what "revertable alone" means and it was measured, not
// asserted. The capture commit deliberately falsifies both, so keeping them
// would leave a permanently red test that teaches the next person to delete
// assertions instead of reading them. They are replaced below by the property
// that outlives the wave: the columns are read through ONE set of validators,
// in a ledger of files, and everything else still cannot see them.
describe('the columns are read, and only where they are supposed to be', () => {
  test('COLS names every one of them — they are projected deliberately', () => {
    // Resolved through its constants rather than matched as characters. COLS
    // was one long literal when this was written; it now composes STORE_COLS,
    // and asserting on the raw text went red on that refactor while the
    // columns were still projected exactly as before. What matters is the
    // string the SELECT ends up with, so build it the way the module does.
    const cols = /const COLS =\s*([\s\S]*?);\n/.exec(RECEIPT_ROUTES);
    expect(cols).not.toBeNull();

    let projected = cols[1];
    // Inline any `const NAME = '...'` the definition refers to, once each.
    for (const ref of projected.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) || []) {
      const decl = new RegExp('const ' + ref + ' =\\s*([\\s\\S]*?);\\n').exec(RECEIPT_ROUTES);
      if (decl) projected = projected.split(ref).join(decl[1]);
    }
    // Strip comments and quoting so only the column names remain.
    projected = projected.replace(/\/\/[^\n]*/g, '').replace(/['"+\s]/g, '');

    for (const c of NEW_COLS) expect(projected).toContain(c);
  });

  test('the files that touch them are an enumerated ledger, not a habit', () => {
    // Scoped to the receipt spelling: material_purchases has had its own
    // store_number since db.js:2219 and is not what this asks about. A file
    // joining this list is a deliberate decision somebody writes down.
    const roots = [
      path.join(__dirname, '..', 'server'),
      path.join(__dirname, '..', 'js'),
    ];
    const hits = new Set();
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
        if (!/\.js$/.test(e.name)) continue;
        if (p.endsWith(path.join('server', 'db.js'))) continue;
        const src = fs.readFileSync(p, 'utf8');
        for (const c of ['store_name', 'store_address', 'store_phone']) {
          if (src.includes(c)) hits.add(path.relative(path.join(__dirname, '..'), p).replace(/\\/g, '/'));
        }
      }
    };
    roots.forEach(walk);
    expect([...hits].sort()).toEqual([
      'js/cost-inbox.js',                  // the capture screen + the read-back
      'server/routes/receipt-routes.js',   // OCR, save, and the merchant view
      // NOT server/services/vendor-name.js: it validates these VALUES and knows
      // nothing about the column names, which is why it is reusable by anything
      // that later reads a merchant string out of a bill or a PO.
    ]);
  });

  test('every store field the API accepts goes through the shared validators', () => {
    // Not `cleanStr`. A phone that was merely trimmed to 200 characters is a
    // phone nobody checked, and it would reach the screen looking exactly like
    // one that had been. cleanStoreFields is the only door.
    expect(RECEIPT_ROUTES).toContain("require('../services/vendor-name')");
    const helper = /function cleanStoreFields\(([\s\S]*?)\n}/.exec(RECEIPT_ROUTES);
    expect(helper).not.toBeNull();
    expect(helper[0]).toContain('VN.normalizeStoreNumber');
    expect(helper[0]).toContain('VN.cleanStoreName');
    expect(helper[0]).toContain('VN.cleanStoreAddress');
    expect(helper[0]).toContain('VN.normalizePhone');
    // Both write paths use it. If one stopped, the two would drift, which is
    // how `vendor` and `amount` ended up validated in two places.
    expect((RECEIPT_ROUTES.match(/cleanStoreFields\(/g) || []).length).toBeGreaterThanOrEqual(4);
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
    // Bounded at the NEXT route declaration, whichever it is. Bounding it at
    // '/categories' by name silently swallowed the merchant view when that
    // landed between the two, and the test then failed for a reason that was
    // about the slice rather than about the money.
    const nextRoute = RECEIPT_ROUTES.indexOf('\nrouter.', start + 10);
    expect(nextRoute).toBeGreaterThan(start);
    const rollup = RECEIPT_ROUTES.slice(start, nextRoute);
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
    //
    // store_phone_kind is derived too, and from a DIFFERENT KEY ON PURPOSE: it
    // is keyed on has('store_phone'), because the kind is a fact ABOUT the
    // number and has no meaning apart from it. Keyed on its own name, a body
    // carrying a kind and no phone would stamp "fax" onto digits it never saw;
    // keyed on the phone, the pair moves together or not at all. The preserve
    // property this test exists for still holds — an unrelated PATCH that
    // sends neither leaves both alone — it is just satisfied by the phone's
    // guard rather than by one of its own.
    expect(unpreserved).toEqual(['is_presale', 'store_phone_kind']);
    expect(patch).toContain("has('store_phone') ? cleanedStore.store_phone_kind : row.store_phone_kind");
  });
});
