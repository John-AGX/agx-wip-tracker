'use strict';
// ── The org-boundary audit: the instrument that turns "unknown" into a number
//
// WHAT THIS IS FOR. The tenant-boundary endgame has one gating question —
// "which rows would become invisible if the tolerance came out?" — and until
// now nobody could answer it. The two boot reporters in db.js cover 10 tables
// of ~75, run twice per boot inside the Railway swap window, and are read from
// scrollback. This is the same idea, off the boot path, where it can afford to
// be complete.
//
// IT IS A PURE READ. It opens its own client, runs everything inside a
// READ ONLY transaction, and ROLLBACKs. It writes nothing, locks nothing
// beyond ACCESS SHARE, and can be run any number of times.
//
// THE ONE HAZARD IT HAS, AND HOW IT IS BOUNDED. Every count here is a
// guaranteed sequential scan — the idx_*_org indexes are PARTIAL
// (`WHERE organization_id IS NOT NULL`), so by construction none of them can
// serve `IS NULL`. That is exactly why db.js:5530 excluded attachments /
// ai_messages / messages from the boot audit. The pool in db.js is created
// with connectionString and ssl only: NO statement_timeout and NO
// lock_timeout. So one admin click on a table with tens of millions of rows
// could otherwise pin a pool connection indefinitely. Every statement here
// runs under `SET LOCAL statement_timeout` — aborting a read costs nothing,
// and a timed-out count is reported as `null` (not measured), never as 0.
//
// "COULD NOT MEASURE" IS NEVER REPORTED AS ZERO. This is the single most
// important property of the whole file, and it is the bug that already exists
// in both boot reporters: reportOrgStampAudit swallows per-table errors and
// then prints "every row in <all ten tables> carries an organization_id"
// regardless of how many were actually counted, and reportOrgOwnerDivergence
// returns a bare 0 when to_regclass says the table is absent. A gate built on
// a measurement that cannot fail loudly is not a gate. Every number below is
// either an integer or `null`, and `null` means NOT MEASURED.

const {
  DIRECT, PARENT, PLATFORM, SHARED, MIXED_SHARED, classify,
} = require('./org-table-classification');
const { ENTITY_TABLES, IDENTITY_TYPES } = require('./attachment-org-scope');

// Identifiers only ever come from information_schema or from the constant maps
// above — never from a request. This is belt-and-braces on top of that: any
// name that is not a plain lowercase identifier is dropped rather than
// interpolated.
const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const safeIdent = (s) => (typeof s === 'string' && IDENT_RE.test(s) ? s : null);

const DEFAULT_TIMEOUT_MS = 20000;

// One measurement. Returns a number, or null when it could not be taken —
// and records WHY, so a timeout and a missing column are distinguishable.
async function measure(client, label, sql, params, out) {
  try {
    const r = await client.query(sql, params || []);
    return r.rows.length ? Number(r.rows[0].n) : null;
  } catch (e) {
    // 57014 = statement_timeout. 42P01/42703 = table/column absent.
    out.not_measured.push({ what: label, code: e && e.code, error: (e && e.message) || String(e) });
    // A failed statement aborts the surrounding transaction, so the rest of
    // the audit would fail too. Recover to a usable state and carry on.
    try { await client.query('ROLLBACK TO SAVEPOINT sp'); } catch (_) {}
    return null;
  }
}

// Wrap each measurement in a savepoint so one failure does not poison the run.
async function counted(client, label, sql, params, out) {
  try { await client.query('SAVEPOINT sp'); } catch (_) {}
  const n = await measure(client, label, sql, params, out);
  try { await client.query('RELEASE SAVEPOINT sp'); } catch (_) {}
  return n;
}

// ── 1. The catalog ────────────────────────────────────────────────────────
// Enumerate from information_schema, NOT from an array. The hardcoded list of
// ten in db.js is precisely how attachments / ai_messages / messages — the
// three tables the write-path audit named as leaking — fell out of the count.
// A table added next year cannot be silently omitted from this one.
//
// is_nullable is read too, which the boot audit never did: without it you
// cannot tell "zero because the column is already NOT NULL" from "zero today,
// and a write could make it non-zero tomorrow". Three tables (projects,
// compliance_items, job_workflow_items) are already NOT NULL in the DDL, so
// their tolerance arms are provably dead code.
async function catalog(client, out) {
  const { rows } = await client.query(`
    SELECT c.table_name, c.is_nullable
      FROM information_schema.columns c
      JOIN information_schema.tables t
        ON t.table_schema = c.table_schema AND t.table_name = c.table_name
     WHERE c.table_schema = 'public'
       AND c.column_name  = 'organization_id'
       AND t.table_type   = 'BASE TABLE'
     ORDER BY c.table_name`);
  return rows
    .map((r) => ({ table: safeIdent(r.table_name), nullable: r.is_nullable === 'YES' }))
    .filter((r) => r.table);
}

// ── 2. Per-table NULL counts, bucketed by CLASS ───────────────────────────
// The bucketing is the point. A NULL in a `direct` table is a leak; a NULL in
// a `shared` table is correct data. Summing them into one "un-stamped total"
// is how somebody eventually "fixes" the shared catalog and deletes it from
// every tenant but one.
async function tableCounts(client, cat, out) {
  const buckets = { direct: [], parent: [], shared: [], mixed_shared: [], platform: [], unclassified: [] };
  for (const { table, nullable } of cat) {
    const cls = classify(table);
    const row = { table, nullable, class: cls, nulls: null, total: null };
    if (!nullable) {
      // Already tight. No NULL is possible; skip the scan entirely.
      row.nulls = 0;
      row.note = 'column is already NOT NULL — its tolerance arms are dead code';
    } else {
      row.nulls = await counted(client, `nulls:${table}`,
        `SELECT COUNT(*)::bigint AS n FROM ${table} WHERE organization_id IS NULL`, [], out);
      row.total = await counted(client, `total:${table}`,
        `SELECT COUNT(*)::bigint AS n FROM ${table}`, [], out);
    }
    buckets[cls].push(row);
  }
  return buckets;
}

// ── 3. Parent-scoped children: the child's own NULL count is the WRONG number
// These rows disappear when the PARENT's stamp is NULL, not when their own is.
// Counted separately: parent-stamped (safe), parent-NULL (would vanish with
// the parent's arm), and orphaned (no parent row at all — the population that
// nothing can derive and that must therefore stay tolerant).
async function parentFamilies(client, cat, out) {
  const present = new Set(cat.map((c) => c.table));
  const rows = [];
  for (const child of Object.keys(PARENT)) {
    const spec = PARENT[child];
    if (spec.via === 'polymorphic') continue;      // handled in its own section
    const c = safeIdent(child), p = safeIdent(spec.parent), fk = safeIdent(spec.fk);
    if (!c || !p || !fk) continue;
    if (!present.has(child) && child !== 'job_reports' && child !== 'attachment_folder_grants') {
      // Tables without their own column still belong here — they are scoped
      // ONLY through the parent, which is exactly why they carry no arm and
      // vanish silently when the parent's arm comes out.
    }
    const r = {
      table: c, parent: p, fk,
      parent_stamped: await counted(client, `parent_stamped:${c}`,
        `SELECT COUNT(*)::bigint AS n FROM ${c} ch JOIN ${p} pa ON pa.id = ch.${fk}
          WHERE pa.organization_id IS NOT NULL`, [], out),
      parent_null: await counted(client, `parent_null:${c}`,
        `SELECT COUNT(*)::bigint AS n FROM ${c} ch JOIN ${p} pa ON pa.id = ch.${fk}
          WHERE pa.organization_id IS NULL`, [], out),
      orphan: await counted(client, `orphan:${c}`,
        `SELECT COUNT(*)::bigint AS n FROM ${c} ch LEFT JOIN ${p} pa ON pa.id = ch.${fk}
          WHERE pa.id IS NULL`, [], out),
    };
    rows.push(r);
  }
  return rows;
}

// ── 4. attachments: four counts, one per rung of attachmentInOrg's ladder ──
// Each rung is a DIFFERENT population with a DIFFERENT fate under tightening,
// and only the fourth is genuinely un-derivable. A single "attachments has N
// NULLs" number conflates all four and answers no question anybody has.
//
// Note what this measures that no SQL predicate can: rungs 2-4 live in
// JAVASCRIPT (services/attachment-org-scope.js), not in a WHERE clause. There
// is no `OR organization_id IS NULL` to diff for this table, so a simulator
// that only diffs SQL arms reports "0 rows would be hidden" for the largest
// table in the database. These four counts are that table's substitute.
async function attachmentLadder(client, out) {
  const types = Object.keys(ENTITY_TABLES).filter((t) => safeIdent(ENTITY_TABLES[t]));
  // A CASE ladder that mirrors entityOrgVerdict + attachmentInOrg exactly.
  const parentOrg =
    `CASE a.entity_type ` +
    types.map((t) => `WHEN '${t}' THEN (SELECT x.organization_id FROM ${ENTITY_TABLES[t]} x WHERE x.id = a.entity_id)`).join(' ') +
    ` WHEN 'user' THEN (SELECT u2.organization_id FROM users u2 WHERE u2.id::text = a.entity_id)` +
    ` WHEN 'org'  THEN NULLIF(a.entity_id,'')::int ` +
    ` ELSE NULL END`;
  const known =
    `(a.entity_type = ANY($1::text[]) AND EXISTS (SELECT 1 FROM (` +
    types.map((t) => `SELECT '${t}'::text AS et, x.id::text AS xid FROM ${ENTITY_TABLES[t]} x`).join(' UNION ALL ') +
    `) m WHERE m.et = a.entity_type AND m.xid = a.entity_id))`;
  const allTypes = types.concat(['user', 'org']);

  const base = `FROM attachments a`;
  const r = {
    // Rung 1a — parent row exists and names a tenant. Safe under any tightening.
    rung1_parent_stamped: await counted(client, 'att:rung1_parent_stamped',
      `SELECT COUNT(*)::bigint AS n ${base} WHERE (${parentOrg}) IS NOT NULL`, [], out),
    // Rung 1b — parent row exists but its OWN stamp is NULL. These vanish when
    // the PARENT table's arm comes out, regardless of the attachment's column.
    rung1_parent_null: await counted(client, 'att:rung1_parent_null',
      `SELECT COUNT(*)::bigint AS n ${base}
        WHERE ${known} AND (${parentOrg}) IS NULL`, [allTypes], out),
    // Rung 2 — orphan (parent gone / untyped) but the row carries its own stamp.
    rung2_own_stamp: await counted(client, 'att:rung2_own_stamp',
      `SELECT COUNT(*)::bigint AS n ${base}
        WHERE NOT ${known} AND a.organization_id IS NOT NULL`, [allTypes], out),
    // Rung 3 — orphan, unstamped, but the uploader names a tenant. DERIVABLE:
    // this is the population an evidence backfill can legitimately stamp.
    rung3_uploader: await counted(client, 'att:rung3_uploader',
      `SELECT COUNT(*)::bigint AS n ${base}
         LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE NOT ${known} AND a.organization_id IS NULL AND u.organization_id IS NOT NULL`, [allTypes], out),
    // Rung 4 — NOTHING names a tenant. This is the only genuinely un-derivable
    // population, and it is the one that must stay tolerant. If this is not
    // zero, attachments does not tighten. Full stop.
    rung4_nothing: await counted(client, 'att:rung4_nothing',
      `SELECT COUNT(*)::bigint AS n ${base}
         LEFT JOIN users u ON u.id = a.uploaded_by
        WHERE NOT ${known} AND a.organization_id IS NULL AND u.organization_id IS NULL`, [allTypes], out),
  };
  r.note = 'attachments is PARENT-anchored (services/attachment-org-scope.js). Rungs 2-4 are JavaScript, ' +
           'not SQL — no `OR organization_id IS NULL` arm exists to drop for this table, so an arm-diff ' +
           'simulator reports 0 for it. rung4_nothing is the only un-derivable population.';
  return r;
}

// ── 5. The two tenancy pointers ───────────────────────────────────────────
// org-access.js scopes job/estimate/change_order through owner_id ->
// users.organization_id and calls that its "source of truth"; job-routes.js
// reads the COLUMN. Two sources that can disagree, and THREE failure shapes,
// of which the boot reporter sees exactly one.
async function pointerState(client, out) {
  const shapes = {};
  // Shape 1 — DIVERGENT. Both stamped, and they disagree. Survives NOT NULL,
  // survives dropping every arm, readable by two tenants through two paths.
  // This is the number the composite-FK constraint is gated on.
  shapes.divergent = await counted(client, 'ptr:divergent',
    `SELECT COUNT(*)::bigint AS n FROM jobs j JOIN users u ON u.id = j.owner_id
      WHERE j.organization_id IS NOT NULL AND u.organization_id IS NOT NULL
        AND j.organization_id <> u.organization_id`, [], out);

  // Shape 2 — POINTER-ORPHAN. Fully stamped column (so the NULL audit reads
  // clean) with an ORG-LESS OWNER (so the divergence reporter's
  // `u.organization_id IS NOT NULL` guard skips it). BOTH existing gauges read
  // clean on exactly these rows — and one admin adopting that user moves every
  // job under them in a single UPDATE, with no job write at all.
  shapes.pointer_orphan = await counted(client, 'ptr:pointer_orphan',
    `SELECT COUNT(*)::bigint AS n FROM jobs j JOIN users u ON u.id = j.owner_id
      WHERE j.organization_id IS NOT NULL AND u.organization_id IS NULL`, [], out);

  // Shape 3 — OWNERLESS. owner_id is NULL (or points at a deleted user), so
  // the INNER JOIN in every owner-scoped query DROPS the row entirely. These
  // are already invisible to the owner-join surfaces today.
  shapes.jobs_ownerless = await counted(client, 'ptr:jobs_ownerless',
    `SELECT COUNT(*)::bigint AS n FROM jobs j LEFT JOIN users u ON u.id = j.owner_id
      WHERE u.id IS NULL`, [], out);
  shapes.estimates_ownerless = await counted(client, 'ptr:estimates_ownerless',
    `SELECT COUNT(*)::bigint AS n FROM estimates e LEFT JOIN users u ON u.id = e.owner_id
      WHERE u.id IS NULL`, [], out);
  return shapes;
}

// ── 6. The tightening simulator ───────────────────────────────────────────
// "Which rows would become invisible" — answered BEFORE anything is dropped,
// per arm family, with sample ids. This is the gating question in mechanical
// form. Re-run it after each stamping pass and watch the number go to zero.
//
// TWO KINDS OF SITE, and reporting only the first is how the biggest hiding
// surfaces get certified clean:
//
//   would_hide   — the site carries a tolerance arm today. Dropping it hides
//                  exactly the rows counted here.
//   already_hidden — the site is ALREADY strict (144 statements in this repo
//                  bind `organization_id = $1` with no arm, and 36 of those
//                  are the Command-Center owner-joins). Nothing is dropped, so
//                  an arm-diff reports zero — while the rows below are hidden
//                  from that surface RIGHT NOW.
async function simulate(client, cat, out) {
  const would_hide = [];
  const already_hidden = [];
  const present = new Map(cat.map((c) => [c.table, c]));

  // (a) direct-column arms: dropping `OR t.organization_id IS NULL` hides
  //     exactly the un-stamped rows.
  for (const t of DIRECT) {
    const meta = present.get(t);
    if (!meta || !meta.nullable) continue;
    const n = await counted(client, `sim:${t}`,
      `SELECT COUNT(*)::bigint AS n FROM ${t} WHERE organization_id IS NULL`, [], out);
    if (n === null || n > 0) {
      let sample = [];
      try {
        await client.query('SAVEPOINT sp');
        const s = await client.query(`SELECT id FROM ${t} WHERE organization_id IS NULL ORDER BY id LIMIT 10`);
        sample = s.rows.map((r) => r.id);
        await client.query('RELEASE SAVEPOINT sp');
      } catch (_) { try { await client.query('ROLLBACK TO SAVEPOINT sp'); } catch (__) {} }
      would_hide.push({ arm: `${t}.organization_id`, table: t, rows: n, sample });
    }
  }

  // (b) parent arms cascade. job_change_orders, qb_cost_lines and job_reports
  //     carry NO arm of their own and scope ENTIRELY through the parent job —
  //     so dropping the JOBS arm removes them silently, and their own count
  //     says nothing about it. Same for every other jobs-child.
  const jobsNull = await counted(client, 'sim:jobs_null',
    `SELECT COUNT(*)::bigint AS n FROM jobs WHERE organization_id IS NULL`, [], out);
  if (jobsNull === null || jobsNull > 0) {
    for (const child of Object.keys(PARENT)) {
      const spec = PARENT[child];
      if (spec.parent !== 'jobs') continue;
      const c = safeIdent(child), fk = safeIdent(spec.fk);
      if (!c || !fk) continue;
      const n = await counted(client, `sim:cascade:${c}`,
        `SELECT COUNT(*)::bigint AS n FROM ${c} ch JOIN jobs j ON j.id = ch.${fk}
          WHERE j.organization_id IS NULL`, [], out);
      if (n === null || n > 0) {
        would_hide.push({ arm: 'jobs.organization_id (CASCADE)', table: c, rows: n, sample: [],
          note: `${c} scopes through its parent job and carries no arm of its own — it disappears with the jobs arm, silently.` });
      }
    }
    would_hide.push({ arm: 'jobs.organization_id (MONEY)', table: 'services/money/job-wip.js', rows: jobsNull, sample: [],
      note: 'job-wip.js contains no organization_id at all: it inherits whatever job set the caller\'s arm returned. ' +
            'A job dropping out changes a WIP total with NO error. job-financials.js nextPoNumber scans the tolerant ' +
            'set to pick the next PO number — tightening it RESTARTS numbering and can re-issue a live number.' });
  }

  // (c) already strict — the surfaces with no arm to remove.
  //     The Command-Center manifest and the weekly digest scope EVERY count
  //     through `JOIN users u ON u.id = <t>.owner_id WHERE u.organization_id = $1`,
  //     with no tolerance. Rows whose owner has a NULL org are hidden from
  //     those surfaces today, and the queries are wrapped in safeCount /
  //     .catch(() => ({rows:[]})) so the exclusion renders as a plain zero.
  for (const [t, owner] of [['jobs', 'owner_id'], ['estimates', 'owner_id']]) {
    const n = await counted(client, `sim:strict:${t}`,
      `SELECT COUNT(*)::bigint AS n FROM ${t} x LEFT JOIN users u ON u.id = x.${owner}
        WHERE u.id IS NULL OR u.organization_id IS NULL`, [], out);
    if (n === null || n > 0) {
      already_hidden.push({ site: 'org-manifest-routes.js / weekly-digest-cron.js owner-join', table: t, rows: n,
        note: 'no tolerance arm exists here to drop — these rows are excluded from the Command Center and the weekly digest RIGHT NOW.' });
    }
  }
  // leads is worse than strict: it is a hard SQL error. leads has NO owner_id
  // column (server/db.js CREATE TABLE leads declares client_id, salesperson_id,
  // job_id, created_by — and no ALTER adds owner_id), so every
  // `JOIN users u ON u.id = l.owner_id` raises 42703 and safeCount renders it
  // as zero. Measured, not assumed:
  already_hidden.push({
    site: 'org-manifest-routes.js / weekly-digest-cron.js / org-access.js lead owner-join',
    table: 'leads',
    rows: await counted(client, 'sim:leads_total',
      `SELECT COUNT(*)::bigint AS n FROM leads`, [], out),
    note: 'leads has NO owner_id column, so every owner-join over it is a 42703 swallowed into 0. ' +
          'EVERY lead is hidden from those surfaces, unconditionally. Repaired onto the column in this wave.',
  });

  // (d) The JS tolerance twins. orgPred()-style SQL rewriting cannot reach
  //     these: `userInOrg(orgId, rowOrg)` returns TRUE when rowOrg is null, in
  //     JavaScript, and it gates every attachment by-id door, every admin user
  //     door, and job-routes' node_graphs / job_access / site-plan reads.
  const jsTwins = await counted(client, 'sim:js_twin_users',
    `SELECT COUNT(*)::bigint AS n FROM users WHERE organization_id IS NULL`, [], out);
  if (jsTwins === null || jsTwins > 0) {
    would_hide.push({ arm: 'services/user-org-scope.js userInOrg (JAVASCRIPT)', table: 'users', rows: jsTwins, sample: [],
      note: 'NOT a SQL arm. `if (targetOrg == null) return true` in JS. It gates every attachment parent lookup and ' +
            'every admin user door. No SQL-level tightening can reach it, and no arm-diff can see it.' });
  }
  return { would_hide, already_hidden };
}

// ── Entry point ───────────────────────────────────────────────────────────
async function auditOrgBoundary(pool, opts) {
  opts = opts || {};
  const timeoutMs = Math.max(1000, Math.min(120000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const out = { generated_at: new Date().toISOString(), not_measured: [] };
  const client = await pool.connect();
  try {
    // READ ONLY is belt-and-braces: this file contains no write, and the
    // transaction refuses one anyway. statement_timeout bounds every scan;
    // lock_timeout is set too so a concurrent ACCESS EXCLUSIVE (a boot
    // migration on the other instance during a Railway swap) cannot park this
    // read behind it.
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    await client.query("SET LOCAL lock_timeout = '3s'");

    const orgs = await counted(client, 'organizations',
      'SELECT COUNT(*)::bigint AS n FROM organizations', [], out);
    out.organizations = orgs;
    out.sole_org = orgs === 1;
    // The guessing backfills in db.js are gated on `(SELECT COUNT(*) FROM
    // organizations) <= 1`. The DAY a second org is created they all stop —
    // so any count taken while this is true was taken with a healer running,
    // and that healer stops at the same instant the boundary starts mattering.
    out.gate_note = out.sole_org
      ? 'SOLE ORG. Every NEVER_MULTI_ORG backfill in db.js is still running, so a low un-stamped count here is ' +
        'partly the healer, not the write paths. Those backfills GUESS the tenant (lowest-numbered org / slug=agx) ' +
        'for users, clients, jobs, estimates, leads, subs, reports and nine child tables — a guessed stamp is ' +
        'indistinguishable from an evidenced one in every query. NOT NULL is still licensed by a zero here; ' +
        'DROPPING AN ARM IS NOT.'
      : 'MULTIPLE ORGS. Every NEVER_MULTI_ORG backfill in db.js has stopped. Un-stamped rows are now PERMANENT.';

    const cat = await catalog(client, out);
    out.tables_with_org_column = cat.length;
    out.buckets = await tableCounts(client, cat, out);
    out.parent_families = await parentFamilies(client, cat, out);
    out.attachments = await attachmentLadder(client, out);
    out.pointers = await pointerState(client, out);
    out.simulation = await simulate(client, cat, out);
    out.platform_tables = PLATFORM;
    out.shared_tables = SHARED;
    out.mixed_shared_tables = MIXED_SHARED;

    // The verdict line. Deliberately conservative: a table is only "ready to
    // tighten" when its count is a MEASURED zero. `null` (not measured) never
    // counts as zero, which is the trap both boot reporters fall into.
    const direct = out.buckets.direct;
    out.ready_for_not_null = direct.filter((t) => t.nullable && t.nulls === 0).map((t) => t.table);
    out.blocked = direct.filter((t) => t.nullable && t.nulls !== 0)
      .map((t) => ({ table: t.table, nulls: t.nulls,
        reason: t.nulls === null ? 'NOT MEASURED — could not be counted, which is not the same as zero' : 'un-stamped rows present' }));
    out.unclassified = out.buckets.unclassified.map((t) => t.table);
    if (out.unclassified.length) {
      out.unclassified_warning =
        'These tables carry organization_id and are named nowhere in services/org-table-classification.js. ' +
        'A table nobody can classify is where the next hole lives — classify each before any tightening.';
    }
    return out;
  } finally {
    try { await client.query('ROLLBACK'); } catch (_) {}
    client.release();
  }
}

module.exports = { auditOrgBoundary };
