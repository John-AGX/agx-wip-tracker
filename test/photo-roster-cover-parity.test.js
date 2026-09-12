// TWO COVER RULES IN ONE HUB IS THE DRIFT THIS REPO KEEPS PAYING FOR.
//
// 7bc0c225 settled what photo represents a site: the FIRST photo TAKEN,
// ordered by COALESCE(taken_at, uploaded_at) because taken_at is EXIF and
// absent on screenshots, excluding PDFs, excluding images whose thumbnail never
// generated, and excluding markups — a markup is a drawing OF the site, not the
// site. That rule lives in server/routes/project-routes.js as a local
// `firstPhotoSql(col)` and feeds the Projects tab of the Photos hub.
//
// The Jobs and Leads rosters need EXACTLY that treatment. The obvious way to
// guarantee it — make the route call a shared service — is closed: the existing
// test/project-cover-fallback.test.js extracts that helper's BODY and
// re-evaluates it in isolation with `new Function('col', body)`, so a body that
// referenced a require()'d binding would throw there. Turning a green suite red
// to share a string is not a trade worth making.
//
// So the rule is written once in server/services/photo-cover.js, generalised
// over the parent type, and the two are held together HERE, by execution: the
// service's output for ('thumb_url', 'project', 'p.id') must be the byte-
// identical string the route emits for ('thumb_url'). Change either one and
// this file names the divergence. That is a weaker coupling than a shared
// function and a stronger one than a comment, which is the trade actually on
// offer.
//
// The second half of the file pins the OTHER predicate — what counts as a photo
// at all — to js/attachments.js's own isImageAttachment(), for the same reason:
// a roster that says "12 photos" and opens to 3 is the silent-success class,
// and the only way the two can be guaranteed to agree is to derive one from the
// other rather than to write both.
'use strict';

const fs = require('fs');
const path = require('path');

const { firstPhotoSql, viewerImageSql } = require('../server/services/photo-cover');
const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');

const ROOT = path.join(__dirname, '..');

// The SHIPPED helper out of the route, re-evaluated in isolation. Deliberately
// not a copy — a copied SQL string is a second implementation that drifts.
// Same extraction test/project-cover-fallback.test.js uses, on purpose: if that
// file's regex stops matching, both suites say so at once rather than one of
// them quietly asserting nothing.
function routeFirstPhotoSql(col) {
  const src = fs.readFileSync(path.join(ROOT, 'server', 'routes', 'project-routes.js'), 'utf8');
  const m = /function firstPhotoSql\(col\) \{([\s\S]*?)\n\}/.exec(src);
  if (!m) throw new Error('firstPhotoSql not found in project-routes.js');
  // eslint-disable-next-line no-new-func
  return new Function('col', m[1])(col);
}

describe('the cover rule has ONE definition', () => {
  test('the service reproduces the project route BYTE FOR BYTE', () => {
    for (const col of ['thumb_url', 'web_url']) {
      const fromRoute = routeFirstPhotoSql(col);
      const fromService = firstPhotoSql(col, 'project', 'p.id');
      // Not .toContain, not a normalised comparison: equality on the exact
      // string, so a changed ORDER BY, a dropped exclusion or an extra space
      // all fail.
      expect(fromService).toBe(fromRoute);
    }
  });

  test('the extraction is not vacuously passing on two empty strings', () => {
    const s = routeFirstPhotoSql('thumb_url');
    expect(s.length).toBeGreaterThan(200);
    // The four clauses that ARE the decision, named individually so a silent
    // removal of any one of them is reported as itself.
    expect(s).toContain("a2.mime_type LIKE 'image/%'");
    expect(s).toContain('a2.thumb_url IS NOT NULL');
    expect(s).toContain('a2.markup_of IS NULL');
    expect(s).toContain('ORDER BY COALESCE(a2.taken_at, a2.uploaded_at) ASC');
  });

  test('the generalisation only moves the entity type and the parent id', () => {
    const project = firstPhotoSql('thumb_url', 'project', 'p.id');
    const job = firstPhotoSql('thumb_url', 'job', 'e.id');
    expect(job).toBe(
      project.replace("= 'project'", "= 'job'").replace('a2.entity_id = p.id', 'a2.entity_id = e.id'));
  });

  test('neither the type nor the id expression is an injection point', () => {
    expect(() => firstPhotoSql('thumb_url', "project' OR '1'='1", 'p.id')).toThrow();
    expect(() => firstPhotoSql('thumb_url', 'project', "p.id) OR (1=1")).toThrow();
    expect(() => firstPhotoSql('caption', 'project', 'p.id')).toThrow();
    // And the types that ARE allowed are only the three photo parents the hub
    // has surfaces for.
    expect(() => firstPhotoSql('thumb_url', 'estimate', 'e.id')).toThrow();
  });
});

describe('the count predicate IS the viewer\'s predicate', () => {
  // js/attachments.js:23, read rather than retyped.
  function viewerFn() {
    const src = fs.readFileSync(path.join(ROOT, 'js', 'attachments.js'), 'utf8');
    const m = /function isImageAttachment\(att\) \{([\s\S]*?)\n {2}\}/.exec(src);
    if (!m) throw new Error('isImageAttachment not found in js/attachments.js');
    // eslint-disable-next-line no-new-func
    return new Function('att', m[1]);
  }

  // Rather than compare two strings — one SQL, one JavaScript, which cannot be
  // compared — run BOTH over the same rows and require the same verdict on
  // every one. The rows cover each way the two could disagree.
  const ROWS = [
    { id: 'a', mime_type: 'image/jpeg', thumb_url: 't' },          // a photo
    { id: 'b', mime_type: 'image/png',  thumb_url: 't' },          // a photo
    { id: 'c', mime_type: 'application/pdf', thumb_url: 't' },     // not an image
    { id: 'd', mime_type: 'image/jpeg', thumb_url: null },         // no derivative
    { id: 'e', mime_type: null,         thumb_url: 't' },          // no mime at all
    { id: 'f', mime_type: 'text/image/jpeg', thumb_url: 't' },     // 'image/' not at the START
    { id: 'g', mime_type: 'image/jpeg', thumb_url: 't', markup_of: 'a' }, // a markup IS shown
  ];

  test('SQL and JavaScript agree on every row', async () => {
    const isImage = viewerFn();
    const db = createPgSqlite(sqliteSchema(['attachments'], { pk: { attachments: 'id' } }),
      { dateColumns: ['uploaded_at', 'taken_at'] });
    for (const r of ROWS) {
      await db.pool.query(
        'INSERT INTO attachments (id, entity_type, entity_id, mime_type, thumb_url, markup_of) ' +
        'VALUES ($1,$2,$3,$4,$5,$6)',
        [r.id, 'lead', 'L1', r.mime_type, r.thumb_url, r.markup_of || null]);
    }
    const got = await db.pool.query(
      'SELECT a.id FROM attachments a WHERE ' + viewerImageSql('a') + ' ORDER BY a.id');
    const fromSql = got.rows.map((x) => x.id);
    const fromJs = ROWS.filter(isImage).map((x) => x.id);

    expect(fromSql).toEqual(fromJs);
    // Not vacuous in either direction: some rows pass and some do not.
    expect(fromJs.length).toBeGreaterThan(0);
    expect(fromJs.length).toBeLessThan(ROWS.length);
    // And the markup is IN, which is the one place the count predicate and the
    // cover predicate deliberately differ — the viewer shows markups in their
    // own section, so counting them is what makes the number true.
    expect(fromJs).toContain('g');
    if (db.close) db.close();
  });
});

// ── THE POSTGRES HAZARD THE SQLITE HARNESS CANNOT SEE ────────────────────
// Every assertion in test/photo-roster.test.js runs the emitted SQL through
// node:sqlite, which is dynamically typed and will concatenate anything. Two
// statements that pass there raise in Postgres:
//
//   SELECT '' || ' ';   -->  ERROR: operator is not unique: unknown || unknown
//
// An UNKNOWN-typed literal is resolved to text when it stands alone in a
// select list and is NOT resolved when it meets an operator. The lead roster
// has a constant `num` column (leads have no job number), so the first draft of
// the search predicate composed `('' ) || ' ' || (title)` and would have thrown
// 42725 the first time anybody typed in the search box on the Leads tab — with
// the whole suite green. That is precisely the shape of failure this repo keeps
// paying for, so the property is asserted over the GENERATED statement rather
// than left to whoever edits ROSTERS next.
const { ROSTERS, buildRosterQuery } = require('../server/services/photo-roster');

// A REGEX OVER SQL WAS THE WRONG INSTRUMENT, AND IT FAILED BOTH WAYS.
// The first attempt guarded /''\s*\|\|/ and its own counter-example was
// `('') || ' '`, which that pattern does not match — a check that would have
// passed forever having proved nothing. Loosened to allow a closing paren, it
// then flagged `COALESCE(e.title, '') ||`, which is FINE: that argument's type
// comes from its sibling, not from the literal. Postgres's rule is about the
// TYPE of an operand, and a regex cannot see a type.
//
// So the property is asserted where it is actually decidable — on the spec —
// and it is the property that makes the bad statement unconstructible rather
// than merely absent today:
//
//   • A roster's searchExpr must reference a COLUMN of the parent row. The
//     draft that broke composed the search out of numExpr, which on the lead
//     roster is the constant '' — that is how `'' || ' '` got emitted at all.
//   • A numExpr that IS a constant must be explicitly typed, so if a future
//     edit does put it next to an operator, Postgres has a type to work with.
describe('a roster search is a column, and a constant column is typed', () => {
  test('every roster, on the shipped spec', () => {
    const names = Object.keys(ROSTERS);
    expect(names.length).toBeGreaterThan(1);
    for (const name of names) {
      const spec = ROSTERS[name];
      // `e` is the parent alias buildRosterQuery uses. A searchExpr with no
      // `e.` in it is a constant and cannot be a search.
      expect({ roster: name, searchesAColumn: /\be\.[a-z_]/.test(spec.searchExpr) })
        .toEqual({ roster: name, searchesAColumn: true });
      const isConstant = !/\be\.[a-z_]/.test(spec.numExpr);
      if (isConstant) {
        expect({ roster: name, typed: /::text\b/.test(spec.numExpr) })
          .toEqual({ roster: name, typed: true });
      }
    }
  });

  test('and it is not vacuous — the draft that broke fails it', () => {
    // Exactly what the lead spec looked like before this was found.
    const broken = { numExpr: "''", searchExpr: "('') || ' ' || (COALESCE(e.title, ''))" };
    expect(/::text\b/.test(broken.numExpr)).toBe(false);
    // Its searchExpr DOES reference a column, which is why the second clause —
    // the typed constant — is the one that catches it. Both clauses are needed;
    // neither alone would have.
    expect(/\be\.[a-z_]/.test(broken.searchExpr)).toBe(true);

    // A roster whose search is a pure constant is caught by the first clause.
    expect(/\be\.[a-z_]/.test("''")).toBe(false);
  });

  test('the emitted SQL types the lead roster\'s constant column', () => {
    const sql = buildRosterQuery('lead', { orgId: 1, q: 'gazebo', limit: 5, offset: 0 }).text;
    expect(sql).toContain("''::text AS num");
    // And the search predicate is the lead's own title, not a composition
    // that drags the constant into a `||`.
    expect(sql).toContain("(COALESCE(e.title, '')) ILIKE");
  });
});
