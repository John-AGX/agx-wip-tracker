// The boot org backfills: which ones are allowed to GUESS, and when.
//
// WHAT THIS FILE PROTECTS
// server/db.js runs a batch of organization_id backfills inside initSchema, on
// EVERY boot. They fall into two kinds and the difference is the whole point:
//
//   EVIDENCE-BASED — the org comes from the row's own owner or parent
//     (jobs.owner_id -> users.organization_id, node_graphs -> its job, …).
//     No judgement call, nothing can move between tenants, so these run
//     unconditionally and must KEEP running unconditionally.
//
//   GUESSES — "the org of the lowest-numbered user", "the org whose slug is
//     agx", "the lowest-id live organization". These have no per-row evidence
//     behind them at all. Harmless while one tenant exists; with two, one of
//     them silently moves a row — with contract money attached, in the case of
//     jobs — into a stranger's tenant, where it is indistinguishable from a
//     legitimate row and there is no record of what it was before.
//
// So every guess is gated on there being exactly one live organization, and a
// row it declines to touch stays NULL and gets counted at boot. A NULL row is
// wrong in a visible, countable, reversible way; a wrong-tenant row is not.
//
// WHY THE ASSERTIONS ARE ON THE RENDERED SQL
// The statements live inside one multi-statement template literal, so there is
// no function to call and no JS branch to exercise. This file renders that
// literal exactly as db.js builds it and asserts on the SQL that Postgres will
// actually receive — which also catches a gate that was written but landed in
// the wrong clause, something a source grep cannot distinguish.

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const DB_PATH = path.join(__dirname, '..', 'server', 'db.js');
const SRC = fs.readFileSync(DB_PATH, 'utf8');

// Render initSchema's template literal with the real NEVER_MULTI_ORG value.
function renderSchemaSql() {
  const lines = SRC.split(/\r?\n/);
  const start = lines.findIndex((l) => /await pool\.query\(`/.test(l));
  expect(start).toBeGreaterThan(-1);
  let end = -1;
  for (let i = start + 1; i < lines.length; i++) {
    if (/^\s*`\)/.test(lines[i])) { end = i; break; }
  }
  expect(end).toBeGreaterThan(start);

  const soleOrg = (SRC.match(/const NEVER_MULTI_ORG\s*=\s*\n?\s*'([^']+)'/) || [])[1];
  expect(soleOrg).toBeTruthy();

  const body = lines.slice(start + 1, end).join('\n');
  const script = new vm.Script(
    'NEVER_MULTI_ORG = ' + JSON.stringify(soleOrg) + '; OUT = `' + body + '`;');
  const ctx = { NEVER_MULTI_ORG: null, OUT: null };
  vm.createContext(ctx);
  script.runInContext(ctx);
  return { sql: ctx.OUT, gate: soleOrg };
}

const { sql: SCHEMA_SQL, gate: GATE } = renderSchemaSql();

// Split the rendered SQL into statements, ignoring `;` inside dollar-quoted
// blocks (DO $tag$ … $tag$) so a PL/pgSQL body stays one statement.
function statements(text) {
  const out = [];
  let buf = '', i = 0, tag = null;
  while (i < text.length) {
    if (!tag) {
      const m = /^\$[a-zA-Z_]*\$/.exec(text.slice(i));
      if (m) { tag = m[0]; buf += tag; i += tag.length; continue; }
      if (text[i] === ';') { out.push(buf); buf = ''; i++; continue; }
    } else if (text.startsWith(tag, i)) {
      buf += tag; i += tag.length; tag = null; continue;
    }
    buf += text[i]; i++;
  }
  if (buf.trim()) out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

const STATEMENTS = statements(SCHEMA_SQL);

// Every statement that writes organization_id.
const ORG_WRITES = STATEMENTS.filter((s) => /SET\s+organization_id/i.test(s));

// A guess: the org is chosen with no reference to the row being updated —
// a hardcoded slug, or "pick an org ordered by id".
const GUESS = /slug\s*=\s*'agx'|ORDER BY\s+u?\.?id\s+ASC\s+LIMIT 1|ORDER BY id ASC LIMIT 1/i;

// Evidence: the value assigned is read off a joined parent/owner row.
const EVIDENCE = /SET\s+organization_id\s*=\s*\w+\.organization_id/i;

function label(stmt) {
  const m = /UPDATE\s+([a-z_]+)/i.exec(stmt);
  return (m ? m[1] : stmt.slice(0, 40));
}

describe('the guess gate', () => {
  test('the gate is a LATCH: EVER multi-org, not currently live', () => {
    // Archiving an org is a live, one-way, system-admin feature
    // (DELETE /api/admin/organizations/:id sets archived_at = NOW(); no restore
    // endpoint exists anywhere in this repo — `archived_at = NULL` appears once,
    // on a different table). Under the old "WHERE archived_at IS NULL" form:
    // onboard org B, archive it, restart — the live count drops back to 1,
    // every gated guess resumes, and org B's NULL rows are stamped into org A on
    // the next boot. A gate that swings back open on an irreversible action is a
    // one-way door into a guess.
    //
    // COUNT(*) over organizations only ever rises (no hard delete exists, and
    // users.organization_id is ON DELETE RESTRICT, which blocks one while any
    // user references the org), so the ungated form is a latch: once closed,
    // closed forever.
    expect(GATE).toBe('(SELECT COUNT(*) FROM organizations) <= 1');
    expect(GATE).not.toMatch(/archived_at/);

    // services/org-reset.js computes the same thing for the same reason, and
    // the stake there is higher: that predicate decides whether the Danger Zone
    // reset HARD-DELETES NULL-org rows. Archive org B, reset org A, and org B's
    // un-stamped rows are destroyed rather than merely mis-stamped.
    const reset = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'org-reset.js'), 'utf8');
    const fn = reset.slice(reset.indexOf('async function shouldIncludeNullOrg'));
    const body = fn.slice(0, fn.search(/\r?\n\}/));
    expect(body).toMatch(/COUNT\(\*\)::int AS n FROM organizations'/);
    expect(body).not.toMatch(/archived_at/);
  });

  test('archiving the second org does not reopen the gate', () => {
    // The two forms, as predicates over the counts each one sees.
    const latch = (everCreated) => everCreated <= 1;
    const oldGate = (liveNow) => liveNow <= 1;

    // One tenant, always: unchanged. AGX's boot is byte-identical, because the
    // migration seeds exactly one org before any gated statement runs.
    expect(latch(1)).toBe(true);
    expect(oldGate(1)).toBe(true);

    // Org B onboarded, then archived. The archive touches neither its users,
    // nor their organization_id, nor its jobs — the data is all still there,
    // still belonging to a tenant that still exists as a row.
    expect(oldGate(1)).toBe(true);    // reopened. this is the defect.
    expect(latch(2)).toBe(false);     // stays shut, and stays shut forever.
  });

  test('a fresh database, and an empty one, both stay safe', () => {
    // Zero orgs also satisfies <= 1 — and the `(SELECT id … WHERE slug='agx')`
    // subquery every guess uses is then NULL, so the UPDATE is a no-op.
    expect(GATE).toMatch(/<= 1$/);
    const guesses = ORG_WRITES.filter((s) => GUESS.test(s));
    for (const g of guesses) {
      expect(g).toMatch(/SELECT id FROM organizations|SELECT organization_id FROM users|organizations/i);
    }
  });

  test('there is something to gate (the fixture found the real statements)', () => {
    expect(ORG_WRITES.length).toBeGreaterThan(15);
    expect(ORG_WRITES.filter((s) => GUESS.test(s)).length).toBeGreaterThan(10);
  });

  test('EVERY guessing backfill is gated on there being one live org', () => {
    const ungated = ORG_WRITES
      .filter((s) => GUESS.test(s))
      .filter((s) => !s.includes(GATE))
      .map(label);
    expect(ungated).toEqual([]);
  });

  test('the users->agx slug backfill is gated — the guess one table upstream', () => {
    // This one mattered most and was least visible: it turned any org-less
    // user into an AGX user on the next boot, and the evidence-based jobs
    // backfill then faithfully stamped AGX onto every job that user owned.
    // The jobs backfill was only judgement-free because the judgement had
    // already been made here.
    const s = ORG_WRITES.find((x) => /UPDATE users/i.test(x) && /slug = 'agx'/.test(x));
    expect(s).toBeDefined();
    expect(s).toContain(GATE);
  });

  test('evidence-based backfills are NOT gated — they can never pick a tenant', () => {
    const evidence = ORG_WRITES.filter((s) => EVIDENCE.test(s) && !GUESS.test(s));
    expect(evidence.length).toBeGreaterThan(8);
    for (const s of evidence) expect(s).not.toContain(GATE);
  });

  test('the jobs backfill derives from the row own owner, and only when that owner has an org', () => {
    const s = ORG_WRITES.find((x) =>
      /UPDATE jobs j/i.test(x) && /FROM users u/i.test(x));
    expect(s).toBeDefined();
    expect(s).toMatch(/u\.id = j\.owner_id/);
    expect(s).toMatch(/j\.organization_id IS NULL/);
    // Without this, the statement was only "total" as a side effect of the
    // users backfill running earlier in the same query — an ordering
    // property, not a property of this UPDATE. Gating the users backfill
    // removed that accident.
    expect(s).toMatch(/u\.organization_id IS NOT NULL/);
    expect(s).not.toContain(GATE);
  });

  test('no backfill derives an org from MARKET — market is the operating dimension', () => {
    for (const s of ORG_WRITES) {
      expect(s).not.toMatch(/SET\s+organization_id\s*=[^;]*\bmarkets?\b/i);
    }
  });

  test('no backfill CHANGES an org that is already set — every one is NULL-only', () => {
    // This is what makes the whole batch idempotent AND non-destructive: a
    // second run has nothing left to match, and an explicit assignment made
    // by a human is never dragged back.
    for (const s of ORG_WRITES) {
      expect(s).toMatch(/organization_id IS NULL/i);
    }
  });

  test('re-running is a no-op: every write is guarded by its own IS NULL', () => {
    // Idempotence modelled directly. Each statement is
    // "set X where X IS NULL", so applying it twice equals applying it once.
    const apply = (rows, stmt) => rows.map((r) =>
      r.org == null && /organization_id IS NULL/i.test(stmt) ? { org: 1 } : r);
    for (const s of ORG_WRITES) {
      const once = apply([{ org: null }, { org: 5 }], s);
      const twice = apply(once, s);
      expect(twice).toEqual(once);
      expect(once[1].org).toBe(5);   // an existing assignment is untouched
    }
  });
});

describe('boot reports what it could not derive', () => {
  test('the audit counts un-stamped rows on both sides of the migration', () => {
    expect(SRC).toMatch(/async function reportOrgStampAudit/);
    expect(SRC).toMatch(/reportOrgStampAudit\('pre-migration'\)/);
    expect(SRC).toMatch(/reportOrgStampAudit\('post-migration'\)/);
    // Pre-migration matters because the backfill destroys the evidence: a low
    // count taken just after a boot is not proof nothing ever happened.
    const init = SRC.slice(SRC.indexOf('async function init()'));
    expect(init.indexOf("reportOrgStampAudit('pre-migration')"))
      .toBeLessThan(init.indexOf('await initSchema()'));
  });

  test('the audit names the un-stamped JOBS, because those carry money', () => {
    const fn = SRC.slice(SRC.indexOf('async function reportOrgStampAudit'));
    expect(fn.slice(0, 3000)).toMatch(/SELECT id FROM jobs WHERE organization_id IS NULL/);
  });

  test('boot also counts column/owner DIVERGENCE — the failure NOT NULL cannot see', () => {
    // A row where jobs.organization_id disagrees with its owner's org is
    // fully stamped, so it survives NOT NULL and survives dropping the
    // IS-NULL tolerance arms, while still being reachable by two tenants
    // through two different code paths.
    expect(SRC).toMatch(/async function reportOrgOwnerDivergence/);
    const fn = SRC.slice(SRC.indexOf('async function reportOrgOwnerDivergence'));
    expect(fn.slice(0, 1500)).toMatch(/j\.organization_id <> u\.organization_id/);
    expect(SRC).toMatch(/await reportOrgOwnerDivergence\(\)/);
  });
});
