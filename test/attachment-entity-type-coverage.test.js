// Every entity_type attachment-routes.js ACCEPTS must be one
// attachment-org-scope.js can RESOLVE — and the resolution has to run.
//
// WHAT WENT WRONG
// `services/attachment-org-scope.js` holds ENTITY_TABLES, the whitelist that
// turns a polymorphic attachment's entity_type into the parent table whose
// organization_id answers "whose row is this". Its header claimed the map
// "Mirrors VALID_ENTITY_TYPES in attachment-routes.js minus the two IDENTITY
// buckets". Nothing checked that claim, and it stopped being true the moment
// 'service_ticket' was added to VALID_ENTITY_TYPES (attachment-routes.js) and
// not here. Twelve types accepted at the door, eleven resolvable behind it.
//
// The unresolvable type fails in BOTH directions at once, which is what makes
// it worth a file of its own:
//
//   • WRITE-ONLY. entityOrgVerdict() answers 'unknown' for a type with no
//     table, and attachmentEntityInOrg() — the guard on the LIST and the
//     UPLOAD — turns 'unknown' into false for the OWNING organization. A
//     subcontractor's work-order photo uploads, the guest page prints "Photo
//     added.", the office timeline prints "added a photo", and no door in the
//     product can ever read it back. Silent success on the flagship surface of
//     the release.
//
//   • A CROSS-TENANT HOLE. attachmentInOrg()'s ladder is four rungs and rung 1
//     — the parent lookup the module header calls THE ANCHOR — cannot fire for
//     an unresolvable type. The verdict falls through to the row's own stamp,
//     then the uploader, then rung 4, which ALLOWS when nothing names a
//     tenant. The guest upload door writes uploaded_by = NULL by design
//     (service-ticket-share-routes.js:868), so such a row rests entirely on
//     its organization_id stamp; any row that lacks one is readable by every
//     tenant on the box, bytes included.
//
// WHY THE STRUCTURAL TEST IS HERE TOO
// Fixing the one missing entry fixes one instance. The DEFECT is a hand-kept
// mirror with nothing checking it, and it recurs every time someone adds a
// type. So the first test below performs the real set difference — reading
// VALID_ENTITY_TYPES out of the route source rather than restating it, because
// a restated list is a third copy of the same mirror — and fails the next time
// an accepted type has no resolution.
//
// HOW IT IS DRIVEN
// At the module, against a REAL SQL engine (node:sqlite via
// test/helpers/pg-sqlite.js) over a schema DERIVED from server/db.js by
// test/helpers/db-schema.js. Nothing here hand-types a column name, so the
// fixture cannot drift toward whatever the code happens to ask for.
//
// WHAT IS DELIBERATELY NOT TESTED AS A BUG
// Rung 4 — "nothing names a tenant, therefore allow" — is a deliberate design
// decision documented in the module header (refusing orphans is a lockout, and
// DELETE there also destroys the storage blob). It is pinned below as
// UNCHANGED behaviour, not asserted as correct. Changing it is a separate,
// reviewed decision.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema, columnsFor, hasTable } = require('./helpers/db-schema');

const {
  ENTITY_TABLES,
  IDENTITY_TYPES,
  entityOrgVerdict,
  attachmentEntityInOrg,
  attachmentInOrg,
} = require('../server/services/attachment-org-scope');

// ── The accepted set, read from the route source ──────────────────────────
// Not require()d: attachment-routes.js does not export it, and pulling the
// whole route module in would drag storage, sharp and the Anthropic SDK into a
// unit test. Parsed instead, and the parse is asserted to have found something
// plausible so a regex that silently matched nothing cannot pass this file.
function validEntityTypesFromSource() {
  const src = fs.readFileSync(
    path.resolve(__dirname, '..', 'server', 'routes', 'attachment-routes.js'), 'utf8');
  const m = src.match(/const\s+VALID_ENTITY_TYPES\s*=\s*new\s+Set\(\[([\s\S]*?)\]\)/);
  if (!m) throw new Error('could not locate VALID_ENTITY_TYPES in attachment-routes.js');
  const types = m[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  if (types.length < 5) throw new Error('VALID_ENTITY_TYPES parse looks wrong: ' + JSON.stringify(types));
  return types;
}

const ORG_A = 1;   // the tenant that owns the ticket
const ORG_B = 2;   // a foreign tenant
const USER_A = 11;
const USER_B = 12;

const TICKET_A = 'st_alpha';
const TICKET_B = 'st_bravo';
const JOB_A = 'job_alpha';

const TABLES = ['organizations', 'users', 'service_tickets', 'jobs', 'attachments'];

let engine;

beforeAll(() => {
  engine = createPgSqlite(sqliteSchema(TABLES));
  const db = engine.db;

  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(ORG_A, 'Alpha', 'alpha');
  db.prepare('INSERT INTO organizations (id, name, slug) VALUES (?,?,?)').run(ORG_B, 'Bravo', 'bravo');

  db.prepare('INSERT INTO users (id, email, name, role, active, organization_id) VALUES (?,?,?,?,?,?)')
    .run(USER_A, 'a@a.a', 'A', 'admin', 1, ORG_A);
  db.prepare('INSERT INTO users (id, email, name, role, active, organization_id) VALUES (?,?,?,?,?,?)')
    .run(USER_B, 'b@b.b', 'B', 'admin', 1, ORG_B);

  // Two work orders, one per tenant. Only organization_id differs.
  const ins = db.prepare(
    'INSERT INTO service_tickets (id, organization_id, ticket_number, title, status) VALUES (?,?,?,?,?)');
  ins.run(TICKET_A, ORG_A, 'WO-1', 'Alpha work order', 'open');
  ins.run(TICKET_B, ORG_B, 'WO-2', 'Bravo work order', 'open');

  // A job in the same tenant — the CONTROL. It travels the identical runner
  // and the identical ladder, so any difference in verdict is the map, not the
  // plumbing.
  db.prepare('INSERT INTO jobs (id, organization_id) VALUES (?,?)').run(JOB_A, ORG_A);
});

afterAll(() => { if (engine) engine.close(); });

const runner = () => engine.pool;

// ─────────────────────────────────────────────────────────────────────────
// 1. THE RECURRENCE GUARD — the real set difference, computed not restated.
// ─────────────────────────────────────────────────────────────────────────
describe('the accepted set and the resolvable set are the same set', () => {
  /* THIS GUARD IS DRIVEN, NOT DECLARED — and that distinction is the whole
   * guard.
   *
   * The obvious spelling is "every accepted type is in ENTITY_TABLES or in
   * IDENTITY_TYPES". It has a one-line escape hatch, and it is the escape a
   * developer staring at a red test would actually reach for: IDENTITY_TYPES
   * RESOLVES NOTHING. entityOrgVerdict branches on the string literals 'org'
   * and 'user' and never consults the set; org-boundary-audit.js imports it and
   * then hardcodes ['user','org'] anyway (line 195), so across the entire repo
   * the only reader of IDENTITY_TYPES is this file. Adding a name to it buys
   * membership in a set nothing enforces.
   *
   * Driven rather than argued: adding 'warranty_claim' to VALID_ENTITY_TYPES
   * and to IDENTITY_TYPES — two lines, no table, no resolution — left the
   * declared form of this suite at 17/17 GREEN while both halves of the very
   * defect it guards reproduced verbatim:
   *   entityOrgVerdict('warranty_claim', ...)        -> 'unknown'
   *   attachmentEntityInOrg(..., OWNING org)         -> false   (owner refused)
   *   attachmentInOrg(unstamped row, FOREIGN tenant) -> true    (cross-tenant)
   * A guard that sleeps through its own defect is the silent-success bug it was
   * written to prevent, so it is not spelled that way here.
   *
   * Instead: a type is resolvable only if it RESOLVES. Table-backed types are
   * proven by the schema clause below; every other accepted type must come back
   * non-'unknown' from the real entityOrgVerdict against a real engine for at
   * least one of the two identity shapes that exist. A type with no branch and
   * no table returns 'unknown' for every id there is, so no edit to any Set can
   * quiet this. */
  test('every VALID_ENTITY_TYPE actually RESOLVES — no set membership accepted', async () => {
    const accepted = validEntityTypesFromSource();
    const unresolvable = [];
    for (const t of accepted) {
      if (ENTITY_TABLES[t]) continue;             // held by the schema clause below
      // The only two identity shapes the resolver knows: entity_id is an
      // organizations.id ('org') or a users.id ('user'). Anything the resolver
      // has no branch for is 'unknown' for both, and lands in the list.
      const verdicts = await Promise.all([
        entityOrgVerdict(runner(), t, ORG_A, ORG_A),
        entityOrgVerdict(runner(), t, USER_A, ORG_A),
      ]);
      if (verdicts.every((v) => v === 'unknown')) unresolvable.push(t);
    }
    expect(unresolvable).toEqual([]);
  });

  test('IDENTITY_TYPES is exactly the two literals entityOrgVerdict branches on', () => {
    // Pinned separately, and low: it is documentation, not a mechanism. If a
    // third name ever belongs here, entityOrgVerdict needs a third branch first
    // — and the driven clause above is what will say so.
    expect([...IDENTITY_TYPES].sort()).toEqual(['org', 'user']);
    const src = fs.readFileSync(
      path.resolve(__dirname, '..', 'server', 'services', 'attachment-org-scope.js'), 'utf8');
    expect(src).toMatch(/if\s*\(type === 'org'\)/);
    expect(src).toMatch(/if\s*\(type === 'user'\)/);
  });

  test('nothing accepted is left unaccounted for by BOTH halves of the map', () => {
    const accepted = validEntityTypesFromSource();
    const resolvable = new Set([...Object.keys(ENTITY_TABLES), ...IDENTITY_TYPES]);
    expect(accepted.filter((t) => !resolvable.has(t))).toEqual([]);
    // Counts line up, so removing a type from BOTH sides still leaves the
    // mirror provably complete rather than vacuously so.
    expect(resolvable.size).toBe(accepted.length);
  });

  test('nothing is resolvable that the door does not accept', () => {
    const accepted = new Set(validEntityTypesFromSource());
    const resolvable = [...Object.keys(ENTITY_TABLES), ...IDENTITY_TYPES];
    expect(resolvable.filter((t) => !accepted.has(t))).toEqual([]);
  });

  test('every table ENTITY_TABLES names exists in server/db.js and carries organization_id', () => {
    const bad = [];
    for (const [type, table] of Object.entries(ENTITY_TABLES)) {
      const cols = hasTable(table) ? columnsFor(table) : null;
      if (!cols) { bad.push([type, table, 'no such table in db.js']); continue; }
      if (!cols.has('organization_id')) bad.push([type, table, 'no organization_id column']);
      if (!cols.has('id')) bad.push([type, table, 'no id column']);
    }
    expect(bad).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 2. THE ENTITY-KEYED DOOR — list, upload, tag-suggest, move/copy DESTINATION.
// ─────────────────────────────────────────────────────────────────────────
describe('attachmentEntityInOrg on a service_ticket', () => {
  test('the OWNING organization can reach its own work order', async () => {
    await expect(attachmentEntityInOrg(runner(), 'service_ticket', TICKET_A, ORG_A))
      .resolves.toBe(true);
  });

  test('a FOREIGN organization cannot, even though the ticket exists', async () => {
    await expect(attachmentEntityInOrg(runner(), 'service_ticket', TICKET_A, ORG_B))
      .resolves.toBe(false);
    await expect(attachmentEntityInOrg(runner(), 'service_ticket', TICKET_B, ORG_A))
      .resolves.toBe(false);
  });

  test('a ticket id that resolves to nothing is refused, same as a foreign one', async () => {
    await expect(attachmentEntityInOrg(runner(), 'service_ticket', 'st_nope', ORG_A))
      .resolves.toBe(false);
  });

  test('the verdict is EVIDENCE from a real lookup, not a default', async () => {
    const before = engine.log.length;
    await expect(entityOrgVerdict(runner(), 'service_ticket', TICKET_A, ORG_A)).resolves.toBe('in');
    await expect(entityOrgVerdict(runner(), 'service_ticket', TICKET_A, ORG_B)).resolves.toBe('out');
    await expect(entityOrgVerdict(runner(), 'service_ticket', 'st_nope', ORG_A)).resolves.toBe('unknown');
    // Three verdicts, three statements actually executed against service_tickets.
    // An 'unknown' produced by falling off the map issues NO query at all, which
    // is how the unfixed module looked from here.
    const issued = engine.log.slice(before)
      .filter((e) => /FROM service_tickets\b/i.test(e.sql));
    expect(issued.length).toBe(3);
    expect(issued.every((e) => e.ok)).toBe(true);
  });

  test('the control: a job in the same tenant answers the same way through the same runner', async () => {
    await expect(attachmentEntityInOrg(runner(), 'job', JOB_A, ORG_A)).resolves.toBe(true);
    await expect(attachmentEntityInOrg(runner(), 'job', JOB_A, ORG_B)).resolves.toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────
// 3. THE ROW-KEYED DOOR — raw stream, caption PUT, DELETE, bulk-tag, move/copy
//    SOURCE. This is where the pixels are.
// ─────────────────────────────────────────────────────────────────────────
describe('attachmentInOrg on a work-order photo', () => {
  // Exactly the row the guest door writes: uploaded_by NULL by design, stamp
  // copied off the ticket (service-ticket-share-routes.js:864-869).
  const guestRow = (over) => Object.assign({
    id: 'att_guest',
    entity_type: 'service_ticket',
    entity_id: TICKET_A,
    organization_id: ORG_A,
    uploaded_by: null,
  }, over || {});

  test('the owning organization can read its own crew photo', async () => {
    await expect(attachmentInOrg(runner(), guestRow(), ORG_A)).resolves.toBe(true);
  });

  test('a foreign organization is refused on rung 1 — the parent ticket EXISTS', async () => {
    await expect(attachmentInOrg(runner(), guestRow(), ORG_B)).resolves.toBe(false);
  });

  // THE PIXEL HOLE. Stamp NULL and uploader NULL — the guest door supplies the
  // second of those on every row it writes. With no resolvable parent the
  // ladder walked past rungs 1, 2 and 3 and landed on rung 4's allow.
  test('an UNSTAMPED work-order photo is NOT readable by a foreign tenant', async () => {
    const row = guestRow({ id: 'att_unstamped', organization_id: null });
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
  });

  test('rung 1 outranks a MISSTAMPED row in both directions', async () => {
    // A row whose own stamp says org B but whose parent ticket is org A's.
    const row = guestRow({ id: 'att_misstamped', organization_id: ORG_B });
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
  });

  test('rung 3 is not consulted once the parent answers', async () => {
    // Uploader in org B, parent ticket in org A. The anchor is the parent.
    const row = guestRow({ id: 'att_foreign_uploader', organization_id: null, uploaded_by: USER_B });
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
  });

  // ── ORPHANS: pinned as UNCHANGED, not asserted as correct ──────────────
  // The parent ticket is gone (attachments has no FK to any entity table), so
  // rung 1 legitimately answers 'unknown' and the documented fallbacks run.
  // This is the behaviour the module header describes for every entity type;
  // adding service_ticket to the map does not alter it and is not meant to.
  test('an ORPHAN with a stamp follows its stamp', async () => {
    const row = guestRow({ id: 'att_orphan_stamped', entity_id: 'st_deleted', organization_id: ORG_A });
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
  });

  test('an ORPHAN with no stamp follows its uploader', async () => {
    const row = guestRow({
      id: 'att_orphan_uploader', entity_id: 'st_deleted', organization_id: null, uploaded_by: USER_A });
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
  });

  test('an ORPHAN that names no tenant at all still reaches rung 4 and is ALLOWED', async () => {
    // NOT an endorsement. Rung 4's allow-when-nothing-names-a-tenant is the
    // module's stated, deliberate tolerance and is out of scope here; this
    // pins it so a later change to it is a visible change, not a side effect.
    const row = guestRow({
      id: 'att_orphan_anonymous', entity_id: 'st_deleted', organization_id: null, uploaded_by: null });
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(true);
  });

  test('the control: the identical ladder on a job row', async () => {
    const row = {
      id: 'att_job', entity_type: 'job', entity_id: JOB_A,
      organization_id: null, uploaded_by: null,
    };
    await expect(attachmentInOrg(runner(), row, ORG_A)).resolves.toBe(true);
    await expect(attachmentInOrg(runner(), row, ORG_B)).resolves.toBe(false);
  });
});
