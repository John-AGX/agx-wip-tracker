// THE GRADUATION CHECKLIST, HELD HONEST BY EXECUTION.
//
// ── THE PROBLEM WITH CHECKLISTS ───────────────────────────────────────────
// A checklist in a markdown file is prose, and prose rots in the direction of
// whoever last touched the code. This repo has a specific, expensive history
// with that: the `users.owner_id` INSERT carried a confident comment
// explaining why it was load-bearing, and the column had never existed, and
// the whole affiliate-onboarding flow had never once succeeded. The comment
// was the reason nobody looked.
//
// So `docs/TENANCY-GRADUATION.md` is not trusted. Every item marked `[machine]`
// is CHECKED HERE, and the check runs BOTH WAYS:
//
//   * an item recorded DONE whose condition is false            -> RED
//   * an item recorded OPEN whose condition is now true         -> RED
//
// The second direction is the one that matters and the one a normal test suite
// never does. Without it, somebody fixes `ai_sessions`, the checklist still says
// OPEN, and org #2 gets blocked on an item that was closed months ago — or,
// worse, the list gets ignored wholesale because everyone knows it is stale.
//
// ── WHY THIS DOES NOT MAKE CI PERMANENTLY RED ─────────────────────────────
// The obvious reading of "a test fails while any box is unchecked" would put
// the suite in permanent failure, which means it gets muted in a week and the
// checklist protects nothing while wearing the costume of protection. What is
// asserted instead is AGREEMENT between the document and the code. Eleven items
// are open today; this suite is green today; and the day one of them changes
// state in either direction, this suite says so.
'use strict';

const fs = require('fs');
const path = require('path');

const DOC = path.join(__dirname, '..', 'docs', 'TENANCY-GRADUATION.md');
const SERVER = path.join(__dirname, '..', 'server');

// LINE ENDINGS NORMALIZED AT READ TIME, and this is not cosmetic. This repo
// carries a mix — server/routes/ai-routes.js is CRLF, server/services/
// session-search.js is LF — and git converts on checkout, so the bytes on disk
// depend on how the file arrived rather than on how it was written. The first
// version of this file asserted a substring spanning a line break, passed
// locally, and failed the moment a rebase rewrote the working tree. An
// assertion whose result depends on the checkout is not an assertion about the
// document.
const doc = fs.readFileSync(DOC, 'utf8').replace(/\r\n/g, '\n');

function read(p) { return fs.readFileSync(path.join(SERVER, p), 'utf8'); }

// Every heading of the form `## <n>. <title> — <STATE>`.
function items() {
  const out = [];
  const re = /^## (\d+)\.\s+(.+?)\s+—\s+\*\*(DONE|OPEN)\*\*(.*)$/gm;
  let m;
  while ((m = re.exec(doc))) {
    out.push({ n: Number(m[1]), title: m[2], state: m[3], tail: m[4] });
  }
  return out;
}

// ── THE CONDITIONS. Each returns true when the item is genuinely CLOSED. ──
// Deliberately narrow and mechanical: each one asks the single question the
// checklist entry claims to be about, and nothing else.
const CONDITION = {
  // COMMENTS STRIPPED FIRST. The file still says `owner_id` four times — in the
  // block explaining why it is gone, which is exactly the commentary that
  // should survive. A bare grep called the item open and would have blocked
  // graduation on a thing that is done, which is the same rot in the other
  // direction.
  1: () => {
    const { stripComments } = require('./helpers/db-schema');
    const code = stripComments(read('routes/admin-organizations-routes.js'));
    return !/owner_id/.test(code)
      && fs.existsSync(path.join(__dirname, 'affiliate-onboarding.test.js'));
  },

  2: () => fs.existsSync(path.join(__dirname, 'admin-console-tenant-scope.test.js'))
        && /registryScope/.test(read('routes/admin-agents-routes.js')),

  3: () => {
    const g = path.join(__dirname, 'golden', 'single-tenant-answers.json');
    if (!fs.existsSync(g)) return false;
    const j = JSON.parse(fs.readFileSync(g, 'utf8'));
    // A golden regenerated from HEAD proves only that HEAD equals itself.
    return j.generated_from === '69f2cabd' && Object.keys(j.answers || {}).length >= 60;
  },

  4: () => fs.existsSync(path.join(__dirname, 'tenant-conformance.test.js'))
        && fs.existsSync(path.join(__dirname, 'tenant-attack-classes.test.js')),

  5: () => {
    const f = require('../server/tenant-scope-flag');
    return f.mode() === 'enforce' && Array.isArray(f.GOVERNED_SITES);
  },

  // OPEN: the write surface is still held by source analysis, which is the
  // method all eight attack classes defeat. Closed when a two-org WRITE harness
  // exists beside the read one.
  6: () => fs.existsSync(path.join(__dirname, 'tenant-write-conformance.test.js')),

  // OPEN: three tables carry organization_id and classify() places none of them.
  7: () => require('./helpers/two-org').unclassifiedTenantTables().length === 0,

  // OPEN: ai_sessions has no tenant column and no classification.
  8: () => require('../server/services/org-table-classification').classify('ai_sessions') !== 'unclassified',

  // OPEN: 485 tolerance arms. Closed when the marked arms are gone.
  9: () => countToleranceArms() === 0,

  // OPEN: creates an organizations row and no user — a tenant nobody can sign into.
  10: () => {
    const src = read('routes/admin-organizations-routes.js');
    const i = src.indexOf("router.post('/', requireAuth, requireSystemAdmin");
    if (i === -1) return true;                       // route gone => closed
    const body = src.slice(i, i + 4000);
    return /INSERT INTO users/i.test(body);          // creates a first admin => closed
  },

  // OPEN: roles is platform-wide; one tenant's ROLES_MANAGE edits every tenant.
  11: () => {
    const { columnsFor } = require('./helpers/db-schema');
    const cols = columnsFor('roles');
    return !!(cols && cols.has('organization_id'));
  },

  // OPEN: email_log and managed_agent_skills carry no tenant column, so the
  // routes that read them serve every tenant's rows to any org admin. Closed
  // only by a migration — the column, then the predicate, in that order.
  // `roles` is item 11 and is not re-checked here.
  15: () => {
    const { columnsFor } = require('./helpers/db-schema');
    return ['email_log', 'managed_agent_skills'].every((t) => {
      const cols = columnsFor(t);
      return !!(cols && cols.has('organization_id'));
    });
  },

  // DONE: prompt-audit refuses a foreign org_id without SYSTEM_ADMIN.
  //
  // The condition asks the ROUTE, not the test file, because a test file that
  // exists proves only that somebody wrote one. It reads the handler body and
  // requires both halves of the guard — the capability check AND the comparison
  // against the caller's own org — so deleting either one reopens the item.
  16: () => {
    const src = read('routes/admin-agents-routes.js');
    const i = src.indexOf("router.get('/managed/prompt-audit'");
    if (i === -1) return true;                     // route gone => closed
    const body = src.slice(i, i + 4000);
    return /askedOrgId/.test(body)
        && /hasCapability\(req\.user, 'SYSTEM_ADMIN'\)/.test(body)
        && fs.existsSync(path.join(__dirname, 'prompt-audit-org-id-idor.test.js'));
  },

  // OPEN: Registers 3 (cron/boot) and 4 (model context) do not exist. Named
  // rather than half-built — see the item for what each would have to assert.
  17: () => fs.existsSync(path.join(__dirname, 'tenant-register3-cron.test.js'))
         && fs.existsSync(path.join(__dirname, 'tenant-register4-model.test.js')),
};

function countToleranceArms() {
  let n = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); continue; }
      if (!e.name.endsWith('.js')) continue;
      n += (fs.readFileSync(p, 'utf8').match(/organization_id IS NULL/g) || []).length;
    }
  };
  walk(SERVER);
  return n;
}

describe('the graduation checklist agrees with the code', () => {
  test('the document parses, and has the number of items it says it has', () => {
    const list = items();
    expect(list.length).toBe(17);
    expect(doc).toContain("| Total items | 17 |");
    expect(list.map((i) => i.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17]);
  });

  test('the DONE / OPEN counts in the summary match the items', () => {
    const list = items();
    const done = list.filter((i) => i.state === 'DONE').length;
    const open = list.filter((i) => i.state === 'OPEN').length;
    expect(doc).toContain('| DONE | ' + done + ' |');
    expect(doc).toContain('| OPEN | ' + open + ' |');
    expect(done + open).toBe(17);
  });

  // ── THE LEDGER, BOTH DIRECTIONS ────────────────────────────────────────
  test('every [machine] item recorded DONE is genuinely closed', () => {
    const wrong = [];
    for (const it of items()) {
      if (it.state !== 'DONE' || !CONDITION[it.n]) continue;
      if (CONDITION[it.n]() !== true) wrong.push(it.n + '. ' + it.title);
    }
    expect(wrong).toEqual([]);
  });

  test('every [machine] item recorded OPEN is genuinely STILL open', () => {
    // The direction a normal suite never checks. If somebody closes one of
    // these and does not tick it here, this fails and names it — so the
    // checklist cannot quietly become a museum piece.
    const stale = [];
    for (const it of items()) {
      if (it.state !== 'OPEN' || !CONDITION[it.n]) continue;
      if (CONDITION[it.n]() === true) {
        stale.push(it.n + '. ' + it.title + '  <- THIS IS NOW CLOSED. Tick it in docs/TENANCY-GRADUATION.md.');
      }
    }
    expect(stale).toEqual([]);
  });

  test('every item is marked [machine] or [human], and no item is unmarked', () => {
    const unmarked = items().filter((i) => !/\[machine\]|\[human\]/.test(i.tail));
    expect(unmarked.map((i) => i.n)).toEqual([]);
  });

  test('every [machine] item has a condition function — a claim with no check is prose', () => {
    const missing = items()
      .filter((i) => /\[machine\]/.test(i.tail) && !CONDITION[i.n])
      .map((i) => i.n + '. ' + i.title);
    expect(missing).toEqual([]);
  });

  // ── the facts the document quotes, quoted back from the code ───────────
  test('the three unclassified tenant tables are the three the document names', () => {
    const actual = require('./helpers/two-org').unclassifiedTenantTables().sort();
    expect(actual).toEqual(['email_attachments', 'live_participants', 'live_rooms']);
    for (const t of actual) expect(doc).toContain(t);
  });

  test('the tolerance-arm count in the document is the real one', () => {
    const n = countToleranceArms();
    expect(doc).toContain('**' + n + '** occurrences of `organization_id IS NULL`');
  });

  test('the rollback names the variable, the platform and the one commit never to revert', () => {
    expect(doc).toContain('P86_TENANT_SCOPE=legacy');
    expect(doc).toContain('Railway');
    expect(doc).toContain('f829e682');
  });

  test('item 1 is stated as the hard prerequisite it is', () => {
    const list = items();
    expect(list[0].n).toBe(1);
    expect(list[0].state).toBe('DONE');
    expect(doc).toContain('org #2 could\nnot be created at all');
  });
});
