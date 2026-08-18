'use strict';
// ── Evidence-only org backfill ────────────────────────────────────────────
//
// Step 2 of the safety property: STAMP THE EXISTING NULLs FROM EVIDENCE,
// never from a guess. A row whose org cannot be derived stays NULL and is
// COUNTED.
//
// WHAT MAKES THIS DIFFERENT FROM THE BACKFILLS ALREADY IN db.js. Those are
// gated on NEVER_MULTI_ORG — `(SELECT COUNT(*) FROM organizations) <= 1` —
// because they GUESS: they stamp the lowest-numbered org, or the org whose
// slug is 'agx', onto rows whose tenant nothing actually states. That guess is
// correct exactly while there is one tenant, which is why it is gated, and it
// has two costs nobody can undo afterwards: a guessed stamp is indistinguishable
// from an evidenced one in every query, and the gate switches OFF at the very
// moment the boundary starts to matter.
//
// Every statement in THIS file reads the tenant off a row that already states
// it — the attachment's parent entity, the cost line's job, the message's user.
// So none of them is gated on the org count, none of them can be wrong, and all
// of them keep working after a second tenant exists. That is the whole point:
// this is the backfill that survives the day the guessing one stops.
//
// THREE PROPERTIES, each load-bearing:
//
//   1. IDEMPOTENT BY CONSTRUCTION. Every UPDATE carries
//      `WHERE t.organization_id IS NULL AND <source> IS NOT NULL`. Re-running
//      it matches nothing. There is no cursor to lose and no partial state.
//   2. IT CANNOT INVENT A TENANT. `<source> IS NOT NULL` is the second half of
//      every predicate. A row whose parent is itself un-stamped, or absent, is
//      left alone — deliberately. It stays NULL, and
//      GET /api/admin/console/org-boundary counts it.
//   3. IT IS NOT ON THE BOOT PATH. server/index.js only calls listen() if
//      init() resolved, so a migration that hangs on a lock never opens the
//      port and never logs why. This runs on demand, under its own
//      statement_timeout and lock_timeout, and a failure is a 500 on one
//      request rather than a container that will not start.
//
// DRY RUN IS THE DEFAULT. `previewOrgData` in services/org-reset.js is the
// precedent — counts only, zero writes, so an operator sees the blast radius
// in the same shape the real run will report it.

const IDENT_RE = /^[a-z_][a-z0-9_]*$/;
const safeIdent = (s) => (typeof s === 'string' && IDENT_RE.test(s) ? s : null);

// ── The evidence map ──────────────────────────────────────────────────────
// `source` is SQL that yields the tenant for one row of `table`, reading it off
// a row that already states it. `why` is recorded in the report so an operator
// can see what each number was derived FROM, not just how big it is.
//
// NOTHING here derives a tenant for users / jobs / estimates / leads / clients
// / subs. Those tables ARE the anchor: there is no other row that states their
// tenant, so any value would be a guess. They are left to the (gated, honest)
// NEVER_MULTI_ORG backfills in db.js and to a human.
const RULES = [
  {
    table: 'ai_messages', key: 'user_id',
    join: 'JOIN users u ON u.id = t.user_id', source: 'u.organization_id',
    why: 'ai_messages.user_id is NOT NULL and the row IS that user\'s conversation. The user states the tenant.',
  },
  {
    table: 'messages', key: 'user_id',
    join: 'JOIN users u ON u.id = t.user_id', source: 'u.organization_id',
    why: 'messages.user_id is NOT NULL. Same anchor as ai_messages.',
  },
  {
    table: 'job_change_orders', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'A change order belongs to whatever tenant its JOB belongs to. job_id is NOT NULL.',
  },
  {
    table: 'qb_cost_lines', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'QuickBooks cost lines hang off a NOT NULL job_id, and they carry no arm of their own — they scope entirely through the parent job.',
  },
  {
    table: 'job_subs', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'The assignment belongs to the job\'s tenant — the same source syncSubAccessForPO already stamps new rows from.',
  },
  {
    table: 'node_graphs', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'node_graphs.job_id is the PRIMARY KEY; the graph IS the job\'s.',
  },
  {
    table: 'schedule_entries', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'Job-linked entries only. A STANDALONE entry (job_id NULL) is skipped here and handled by the created_by rule below.',
  },
  {
    table: 'schedule_entries', key: 'created_by', label: 'schedule_entries (standalone)',
    join: 'JOIN users u ON u.id = t.created_by', source: 'u.organization_id',
    extra: 't.job_id IS NULL',
    why: 'A standalone entry has no job. Its creator is the only row that states a tenant — the same fallback org-access.js already reads it through.',
  },
  {
    table: 'job_purchase_orders', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'job_purchase_orders.job_id is NOT NULL. A subcontract belongs to the tenant that owns the job it is written against.',
  },
  {
    table: 'job_vendor_bills', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'job_vendor_bills.job_id is NOT NULL. The bill is payable by whichever tenant owns the job it was incurred on.',
  },
  {
    table: 'pay_applications', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'pay_applications.job_id is NOT NULL. An AIA G702 draw is billed against exactly one job, in exactly one tenant.',
  },
  {
    table: 'invoices', key: 'job_id',
    join: 'JOIN jobs j ON j.id = t.job_id', source: 'j.organization_id',
    why: 'Only job-linked invoices. invoices.job_id is NULLABLE — a client-only invoice has no job to read a tenant off, so it is skipped, not guessed.',
  },
  {
    table: 'sub_certificates', key: 'sub_id',
    join: 'JOIN subs s ON s.id = t.sub_id', source: 's.organization_id',
    why: 'sub_certificates.sub_id is NOT NULL, and sub names are unique PER TENANT — so the sub states the tenant unambiguously.',
  },
];

// attachments is its own case: the parent is POLYMORPHIC, and the ladder in
// services/attachment-org-scope.js has four rungs. Only rungs 1 and 3 are
// evidence — rung 2 is the column we are trying to fill, and rung 4 is the
// tolerance we must not convert into a stamp.
const ATTACHMENT_RULES = [
  { label: 'attachments (parent entity)', rung: 1 },
  { label: 'attachments (uploader)',      rung: 3 },
];

function attachmentSql(entityTables, rung) {
  const types = Object.keys(entityTables).filter((t) => safeIdent(entityTables[t]));
  if (rung === 1) {
    // Rung 1 — the parent entity. One UPDATE per entity type keeps each
    // statement index-friendly on (entity_type, entity_id) and keeps the
    // whitelist of table names entirely out of the request path.
    return types.map((t) => ({
      type: t,
      count: `SELECT COUNT(*)::bigint AS n FROM attachments a
                JOIN ${entityTables[t]} p ON p.id = a.entity_id
               WHERE a.entity_type = '${t}' AND a.organization_id IS NULL
                 AND p.organization_id IS NOT NULL`,
      update: `UPDATE attachments a SET organization_id = p.organization_id
                 FROM ${entityTables[t]} p
                WHERE p.id = a.entity_id AND a.entity_type = '${t}'
                  AND a.organization_id IS NULL AND p.organization_id IS NOT NULL`,
    }));
  }
  // Rung 3 — an ORPHAN's uploader. Restricted to rows whose entity_type is one
  // we cannot resolve, or whose parent row is gone: a row whose parent EXISTS
  // but is itself un-stamped must not be given the uploader's tenant, because
  // the parent is the anchor and it would then disagree with its own parent.
  const known = types
    .map((t) => `(a.entity_type = '${t}' AND EXISTS (SELECT 1 FROM ${entityTables[t]} x WHERE x.id = a.entity_id))`)
    .join(' OR ');
  return [{
    type: 'orphan',
    count: `SELECT COUNT(*)::bigint AS n FROM attachments a
              JOIN users u ON u.id = a.uploaded_by
             WHERE a.organization_id IS NULL AND u.organization_id IS NOT NULL
               AND NOT (${known})`,
    update: `UPDATE attachments a SET organization_id = u.organization_id
               FROM users u
              WHERE u.id = a.uploaded_by
                AND a.organization_id IS NULL AND u.organization_id IS NOT NULL
                AND NOT (${known})`,
  }];
}

function ruleSql(rule) {
  const t = safeIdent(rule.table);
  const where = `t.organization_id IS NULL AND ${rule.source} IS NOT NULL` +
    (rule.extra ? ` AND ${rule.extra}` : '');
  // The UPDATE ... FROM form needs the join expressed as a FROM + predicate.
  const m = rule.join.match(/^JOIN (\w+) (\w+) ON (.+)$/);
  return {
    count: `SELECT COUNT(*)::bigint AS n FROM ${t} t ${rule.join} WHERE ${where}`,
    update: `UPDATE ${t} t SET organization_id = ${rule.source}
               FROM ${m[1]} ${m[2]} WHERE ${m[3]} AND ${where}`,
  };
}

async function runOne(client, label, sql, dryRun, out) {
  try {
    await client.query('SAVEPOINT bf');
    const c = await client.query(sql.count);
    const n = Number(c.rows[0].n);
    let updated = 0;
    if (!dryRun && n > 0) {
      const r = await client.query(sql.update);
      updated = r.rowCount;
    }
    await client.query('RELEASE SAVEPOINT bf');
    return { label, derivable: n, updated, dry_run: !!dryRun };
  } catch (e) {
    try { await client.query('ROLLBACK TO SAVEPOINT bf'); } catch (_) {}
    out.not_measured.push({ what: label, code: e && e.code, error: (e && e.message) || String(e) });
    // NOT zero. See the header of services/org-boundary-audit.js: a gate built
    // on a measurement that cannot fail loudly is not a gate.
    return { label, derivable: null, updated: null, error: (e && e.message) || String(e) };
  }
}

async function backfillFromEvidence(pool, opts) {
  opts = opts || {};
  const dryRun = opts.dryRun !== false;          // dry by default
  const timeoutMs = Math.max(1000, Math.min(300000, Number(opts.timeoutMs) || 60000));
  const only = Array.isArray(opts.tables) && opts.tables.length ? new Set(opts.tables) : null;
  const out = {
    generated_at: new Date().toISOString(), dry_run: dryRun, results: [], not_measured: [],
  };
  const { ENTITY_TABLES } = require('./attachment-org-scope');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    // A lock_timeout on the WRITE connection, unlike on a boot migration's,
    // is safe to treat as "skip this table": nothing downstream depends on it
    // and the operator can simply run it again.
    await client.query("SET LOCAL lock_timeout = '3s'");

    for (const rule of RULES) {
      const label = rule.label || rule.table;
      if (only && !only.has(rule.table)) continue;
      out.results.push(Object.assign(
        await runOne(client, label, ruleSql(rule), dryRun, out),
        { why: rule.why }));
    }
    if (!only || only.has('attachments')) {
      for (const ar of ATTACHMENT_RULES) {
        for (const s of attachmentSql(ENTITY_TABLES, ar.rung)) {
          out.results.push(Object.assign(
            await runOne(client, ar.label + ' · ' + s.type, s, dryRun, out),
            { why: ar.rung === 1
              ? 'Rung 1 of attachmentInOrg: the PARENT ENTITY. entity_type/entity_id are NOT NULL on every row and this is the anchor the read path already resolves through.'
              : 'Rung 3: an ORPHAN\'s uploader. Only rows whose parent row is ABSENT — a row whose parent exists but is itself un-stamped must keep waiting for its parent, or it would end up disagreeing with it.' }));
        }
      }
    }

    // A dry run must leave nothing behind, including the transaction.
    if (dryRun) await client.query('ROLLBACK');
    else await client.query('COMMIT');

    const nums = out.results.map((r) => r.derivable).filter((n) => typeof n === 'number');
    out.total_derivable = nums.reduce((a, b) => a + b, 0);
    out.unmeasured_tables = out.not_measured.length;
    out.note = dryRun
      ? 'DRY RUN — nothing was written and the transaction was rolled back. `derivable` is how many rows COULD be stamped from evidence. Re-run with dry_run=false to apply.'
      : 'APPLIED. Re-run GET /api/admin/console/org-boundary to see the remaining population. Anything still NULL after this could NOT be derived from any row that states a tenant — it stays NULL and stays counted, because a wrong tenant is worse than none.';
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw e;
  } finally {
    client.release();
  }
}

module.exports = { backfillFromEvidence, RULES };
