// Every money / job-scoped insert names organization_id.
//
// WHY THIS IS NOW A STANDING EXPOSURE RATHER THAN A TIDINESS PROBLEM
// These rows used to land with organization_id NULL and be healed on the next
// boot by the org backfill. 9c1626a correctly gated that backfill — a boot may
// no longer guess which tenant a row belongs to once a second tenant exists —
// and that turned a self-healing NULL into a PERMANENT one. A NULL-org row is
// not hidden from everyone: every read in this repo carries an
// `OR organization_id IS NULL` tolerance arm, so it is visible to EVERY tenant.
//
// The response is to stamp at insert, never to un-gate the backfill.
//
// SCOPE. This is the money / job-scoped subset: job_change_orders, job_subs,
// qb_cost_lines, schedule_entries, node_graphs, clients. The remaining tail
// (attachments, ai_messages, messages, subs, sub_certificates, field_tools,
// managed_agent_registry) is a different risk class and a different argument —
// most of it is agent-written, and several of those contexts resolve their org
// through _cdOrgId / ctx.orgId, which can be null by construction. That needs a
// requireOrgId equivalent for the agent path first, and it should be scoped by
// DOOR ("every agent-reachable insert into an org-scoped table resolves its org
// the way requireOrgId does, or refuses") rather than table by table.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');

// The insert statement beginning at `INSERT INTO <table>`, far enough to cover
// its column list and VALUES clause.
function inserts(src, table) {
  const out = [];
  // `\s*\(` so prose in a comment that happens to say "INSERT INTO x" is not
  // mistaken for a statement.
  const re = new RegExp('INSERT INTO ' + table + '\\s*\\(', 'g');
  let m;
  while ((m = re.exec(src))) out.push(src.slice(m.index, m.index + 700));
  return out;
}

// The column list of one insert, whether it spans lines or not.
function columnsOf(stmt) {
  const m = /INSERT INTO \w+\s*\(([\s\S]*?)\)/.exec(stmt);
  return m ? m[1].split(',').map((c) => c.trim()) : [];
}

const SITES = [
  ['job_change_orders', ['server', 'routes', 'change-order-routes.js'], 1],
  ['job_change_orders', ['server', 'services', 'job-financials.js'], 1],
  ['job_subs', ['server', 'routes', 'purchase-order-routes.js'], 1],
  ['job_subs', ['server', 'routes', 'sub-routes.js'], 3],
  ['qb_cost_lines', ['server', 'routes', 'qb-cost-routes.js'], 1],
  ['schedule_entries', ['server', 'routes', 'schedule-routes.js'], 1],
  ['node_graphs', ['server', 'routes', 'job-routes.js'], 2],
];

describe('the money / job-scoped inserts name organization_id', () => {
  for (const [table, file, count] of SITES) {
    const label = `${table} in ${file[file.length - 1]}`;

    test(`${label}: every insert site is stamped`, () => {
      const found = inserts(read(...file), table);
      expect(found.length).toBe(count);
      for (const stmt of found) {
        expect({ site: label, cols: columnsOf(stmt).includes('organization_id') })
          .toEqual({ site: label, cols: true });
      }
    });

    test(`${label}: the stamp cannot disagree with the parent job`, () => {
      // Two acceptable forms, and no third:
      //   • a subselect off the parent job — unforgeable, and correct even on
      //     a requireAuth-only route;
      //   • the SAME server-derived orgId the sibling `INSERT INTO jobs` in the
      //     same transaction just used (the /convert site, where the parent job
      //     is being created right here and a subselect would read the row the
      //     statement above it just wrote).
      // Never a value that reached the handler from the request body.
      for (const stmt of inserts(read(...file), table)) {
        const fromParent = /\(SELECT organization_id FROM jobs WHERE id = \$\d\)/.test(stmt);
        const fromCreateTxn = /SELECT \$1, data, \$3 FROM lead_graphs/.test(stmt);
        expect({ site: label, stamped: fromParent || fromCreateTxn })
          .toEqual({ site: label, stamped: true });
      }
    });
  }

  test('a re-import / re-assign is not a tenant move', () => {
    // Wherever these inserts carry an ON CONFLICT arm, that arm must not
    // assign organization_id — same rule the jobs upsert follows.
    for (const [table, file] of SITES) {
      for (const stmt of inserts(read(...file), table)) {
        const i = stmt.search(/ON CONFLICT/i);
        if (i === -1) continue;
        const arm = stmt.slice(i);
        const setList = arm.split(/\bWHERE\b/i)[0];
        expect({ table, assigns: /SET[\s\S]*organization_id/i.test(setList) })
          .toEqual({ table, assigns: false });
      }
    }
  });

  test('the clients parent stub is stamped from the caller org', () => {
    // This one has no parent job to read from — it is a client, created by the
    // BT import. The surrounding dedup read is already org-scoped on
    // req.user.organization_id, and this insert binds the same value; without
    // it, a re-import seeded un-stamped parents the (correctly scoped) dedup
    // index could never match again.
    const src = read('server', 'routes', 'client-routes.js');
    const stub = inserts(src, 'clients').find((s) => /Property Mgmt/.test(s));
    expect(stub).toBeDefined();
    expect(columnsOf(stub)).toContain('organization_id');
    expect(src).toMatch(/VALUES \(\$1, \$2, \$2, 'Property Mgmt', \$3\)/);
  });
});

describe('the boot auditor counts what is now permanent', () => {
  const DB = read('server', 'db.js');
  const decl = (() => {
    const i = DB.indexOf('const ORG_STAMP_AUDIT_TABLES');
    return DB.slice(i, DB.indexOf(';', i));
  })();

  test('every table stamped in this wave is audited', () => {
    for (const t of ['job_change_orders', 'job_subs', 'qb_cost_lines',
      'node_graphs', 'schedule_entries', 'clients']) {
      expect({ table: t, audited: decl.includes(`'${t}'`) })
        .toEqual({ table: t, audited: true });
    }
  });

  test('and each one has an IS NULL partial index to answer with', () => {
    // idx_*_org are partial on IS NOT NULL and cannot serve `IS NULL`. The
    // audit runs twice per boot, before listen(), inside the deploy swap
    // window, so an audited table with no matching index is a full sequential
    // scan in front of the port opening.
    for (const t of (decl.match(/'([a-z_]+)'/g) || []).map((s) => s.replace(/'/g, ''))) {
      const re = new RegExp(
        'CREATE INDEX IF NOT EXISTS \\S+ +ON ' + t + ' +\\([a-z_]+\\) WHERE organization_id IS NULL');
      expect({ table: t, indexed: re.test(DB) }).toEqual({ table: t, indexed: true });
    }
  });
});
