// LINE ITEMS COME WITH ONE CHANGE ORDER, NOT WITH A LIST.
//
// ── THE MEASUREMENT ───────────────────────────────────────────────────────
// read_change_orders printed every line of every change order it returned,
// always, with no way to ask it not to. Measured on one real job: 42,962
// characters — ~11,000 tokens — to answer "what change orders are on this
// job", which none of those lines are an answer to. And a tool result is not
// paid once: it stays in the transcript, so every later turn of that
// conversation pays for it again.
//
// The line ids exist for a WRITE, and a write addresses ONE change order. So
// naming one prints its lines; a list summarises them.
//
// ── WHAT IS HELD HERE ─────────────────────────────────────────────────────
//   C1  a list prints no line rows, and says how to get them
//   C2  the list is a fraction of its old size — with the old size measured
//       off the fixture's own rows, not asserted from a comment
//   C3  co_id prints that one's lines, with the [line_id=…] a write needs
//   C4  a filter that matches exactly one does the same — "detail" is about
//       having ONE change order in hand, not about which argument named it
//   C5  include_lines is the explicit way to get them across a list
//   C6  the money roll-up keeps drafts and pending out of the job's money
//   C7  and it reads the COUNTING RULE from the money module instead of
//       keeping a second copy of it
//   C8  include_lines over a big list is itself budgeted, and says what it
//       dropped
//   C9  the per-change-order summary counts the two things that decide
//       whether a line needs opening: a promised price, a placeholder cost
//   C10 the instructions 86 is given no longer promise lines on a list
//
// Both doors: the staff executor the live chat dispatches through, and the
// project-inline executor itself.

'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const { createPgSqlite } = require('./helpers/pg-sqlite');
const { sqliteSchema } = require('./helpers/db-schema');
const jobMoney = require('../server/services/money/change-order-totals');

const TABLES = ['organizations', 'roles', 'users', 'jobs', 'job_change_orders'];

const engine = createPgSqlite(sqliteSchema(TABLES), {
  jsonColumns: ['data', 'capabilities', 'notification_prefs'],
  dateColumns: ['created_at', 'updated_at', 'approved_at'],
});
globalThis.__P86_CO_READ_ENGINE__ = engine;
jest.mock('../server/db', () => ({ pool: globalThis.__P86_CO_READ_ENGINE__.pool }));

const { setRolePool, refreshRoleCache } = require('../server/auth');
const aiRoutes = require('../server/routes/ai-routes');
const { execAgentTool, execProjectInlineTool } = aiRoutes.internals;
const { AGENT_SYSTEM_BASELINE } = require('../server/routes/admin-agents-routes');

const ORG = 1;
const UID = 10;
const USER = { id: UID, email: 'pm@a.test', role: 'admin', name: 'PM', organization_id: ORG };

// 20 lines per change order, descriptions long enough that printing them all
// is the cost this change is about.
const LINES_PER_CO = 20;
function mkLines(prefix, opts) {
  const o = opts || {};
  const out = [];
  for (let i = 1; i <= LINES_PER_CO; i++) {
    out.push({
      id: prefix + '-L' + i,
      description: prefix + ' line ' + i + ' — ' + 'detailed scope text '.repeat(3),
      qty: 2,
      unit: 'ea',
      unitCost: 500,
      // Every third line carries a promised price; every fifth a placeholder
      // cost. Both are what the summary counts.
      unitSell: i % 3 === 0 ? 900 : '',
      costPending: i % 5 === 0,
      markup: 20,
    });
  }
  if (o.withSection) out.unshift({ section: '__section_header__', label: prefix + ' SECTION' });
  return out;
}

const COS = [
  { id: 'co_a', num: 'CO-1', status: 'approved', locked: 1 },
  { id: 'co_b', num: 'CO-2', status: 'pending',  locked: 0 },
  { id: 'co_c', num: 'CO-3', status: 'draft',    locked: 0 },
];

function seed() {
  engine.db.exec(`
    DELETE FROM job_change_orders; DELETE FROM jobs;
    DELETE FROM users; DELETE FROM roles; DELETE FROM organizations;
    INSERT INTO organizations (id, name) VALUES (1, 'Org A');
    INSERT INTO users (id, email, name, role, organization_id) VALUES
      (10, 'pm@a.test', 'PM', 'admin', 1);
    INSERT INTO roles (name, label, capabilities) VALUES
      ('admin', 'Admin', '["ESTIMATES_VIEW","ESTIMATES_EDIT","FINANCIALS_VIEW","JOBS_VIEW","JOBS_VIEW_ALL","LEADS_VIEW","CLIENTS_VIEW","SUBS_VIEW","FILES_VIEW","TASKS_VIEW"]');
    INSERT INTO jobs (id, owner_id, organization_id, data) VALUES
      ('j1', 10, 1, '{"jobNumber":"25-101","projectName":"River Landing"}');
  `);
  const ins = engine.db.prepare(
    `INSERT INTO job_change_orders
       (id, job_id, owner_id, organization_id, status, co_number, data, is_locked, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`);
  COS.forEach((c, i) => {
    ins.run(c.id, 'j1', UID, ORG, c.status, c.num,
      JSON.stringify({ title: c.num + ' scope', lines: mkLines(c.num, { withSection: i === 0 }) }),
      c.locked, '2026-09-0' + (i + 1) + ' 09:00:00');
  });
  setRolePool(engine.pool);
  return refreshRoleCache();
}

const ctx = () => ({ userId: UID, orgId: ORG, user: USER });
const flat = (v) => (v == null ? '' : (typeof v === 'string' ? v : JSON.stringify(v)));
const DOORS = [
  // execAgentTool is the door the live chat dispatches through (it routes
  // PROJECT_INLINE_EXECUTOR_TOOLS onward); execProjectInlineTool is the
  // executor itself, reached without that routing in front of it.
  ['execAgentTool', (input) => execAgentTool('read_change_orders', input, ctx())],
  ['execProjectInlineTool', (input) => execProjectInlineTool('read_change_orders', input, ctx())],
];
async function read(input, door) {
  const run = door || DOORS[0][1];
  let out;
  try { out = await run(input || {}); } catch (e) { out = 'THREW: ' + (e && e.message); }
  return flat(out);
}

// What the lines WOULD have cost, measured off the fixture rather than claimed.
function rawLineChars() {
  const rows = engine.db.prepare('SELECT data FROM job_change_orders').all();
  return rows.reduce((n, r) => {
    const d = typeof r.data === 'string' ? JSON.parse(r.data) : r.data;
    return n + (d.lines || []).reduce((m, l) => m + JSON.stringify(l).length, 0);
  }, 0);
}

beforeEach(() => { engine.log.length = 0; return seed(); });

describe('the fixture can catch this', () => {
  test('there is real line weight to print', () => {
    expect(rawLineChars()).toBeGreaterThan(10000);
    const n = engine.db.prepare('SELECT COUNT(*) AS n FROM job_change_orders').get().n;
    expect(n).toBe(3);
  });
});

describe.each(DOORS)('read_change_orders — %s', (label, door) => {
  test('C1 a LIST prints no line rows, and says how to get them', async () => {
    const out = await read({ job_id: 'j1' }, door);
    expect(out).not.toMatch(/THREW/);
    // Every change order is there, with its id and status.
    expect(out).toContain('3 change orders:');
    expect(out).toContain('[co_id=co_a]');
    expect(out).toContain('[co_id=co_c]');
    // And not one line row.
    expect(out).not.toContain('[line_id=');
    expect(out).not.toContain('-- section:');
    expect(out).toContain('call read_change_orders again with co_id=');
  });

  test('C2 the list is a fraction of what it used to be', async () => {
    // The before-number is MEASURED, not asserted from a comment:
    // include_lines:true is exactly the old behaviour — every line of every
    // change order — so the same code that used to run always is run here for
    // comparison.
    const before = await read({ job_id: 'j1', include_lines: true }, door);
    const after = await read({ job_id: 'j1' }, door);
    expect(before.length).toBeGreaterThan(rawLineChars());
    expect(after.length).toBeLessThan(before.length / 8);
    expect(after.length).toBeLessThan(1800);
  });

  test('C3 co_id prints that one change order WITH its line ids', async () => {
    const out = await read({ job_id: 'j1', co_id: 'co_a' }, door);
    expect(out).toContain('1 change order:');
    expect(out).toContain('[line_id=CO-1-L1]');
    expect(out).toContain('[line_id=CO-1-L20]');
    expect(out).toContain('-- section:');
    // …and nothing from the other two.
    expect(out).not.toContain('[line_id=CO-2-L1]');
    expect(out).not.toContain('[co_id=co_b]');
    expect(out).toContain('hand the Scribe the co_id and the line_id');
  });

  test('C3 the CO NUMBER works as the address too, and still prints lines', async () => {
    // A write addresses by what a human says; "CO-2" has to land on co_b.
    const out = await read({ job_id: 'j1', co_id: 'CO-2' }, door);
    expect(out).toContain('[co_id=co_b]');
    expect(out).toContain('[line_id=CO-2-L3]');
    expect(out).not.toContain('[line_id=CO-1-L1]');
  });

  test('C4 a filter that matches exactly ONE prints its lines', async () => {
    // MUTANT: gating detail on `input.co_id` instead of on having one row.
    // "the stucco change order" resolved by filter is the same situation as
    // naming it, and a model that then has to call again learned nothing.
    const out = await read({ job_id: 'j1', filter: 'CO-3' }, door);
    expect(out).toContain('1 change order:');
    expect(out).toContain('[line_id=CO-3-L7]');
  });

  test('C5 include_lines is the explicit way to get them across a list', async () => {
    const out = await read({ job_id: 'j1', include_lines: true }, door);
    expect(out).toContain('[line_id=CO-1-L1]');
    expect(out).toContain('[line_id=CO-2-L1]');
    expect(out).toContain('[line_id=CO-3-L1]');
    // And it is NOT the default: the same call without it has none.
    const plain = await read({ job_id: 'j1' }, door);
    expect(plain).not.toContain('[line_id=');
  });

  test('C6 the roll-up keeps draft and pending OUT of the job money', async () => {
    // MUTANT: totalling every row returned. A pending or draft CO is worth
    // exactly $0 to the job until a human approves it — each row already said
    // so one at a time, and nothing said it in aggregate.
    const out = await read({ job_id: 'j1' }, door);
    const approved = jobMoney.changeOrderMoney(
      JSON.parse(engine.db.prepare('SELECT data FROM job_change_orders WHERE id=?').get('co_a').data));
    const money = (v) => '$' + Math.round(Number(v) || 0).toLocaleString();
    expect(out).toContain('In the job\'s money: 1 approved/applied · income ' + money(approved.income));
    expect(out).toContain('NOT in any contract, WIP, backlog or pay-application total yet');
    expect(out).toContain('draft ');
    expect(out).toContain('pending ');
    expect(out).toContain('worth $0 to this job until approved');
  });

  test('C6 approving one moves it across the line, and only it', async () => {
    engine.db.prepare('UPDATE job_change_orders SET status=? WHERE id=?').run('applied', 'co_b');
    const out = await read({ job_id: 'j1' }, door);
    expect(out).toContain('In the job\'s money: 2 approved/applied');
    expect(out).not.toContain('pending ');
    expect(out).toContain('draft ');
  });

  test('C9 the per-change-order summary counts promised prices and placeholder costs', async () => {
    const out = await read({ job_id: 'j1' }, door);
    // 20 lines: every third promised (6), every fifth a placeholder (4).
    expect(out).toContain('20 lines · 6 with a PROMISED price · 4 with a PLACEHOLDER cost');
    // The section header is NOT counted as a line.
    const co1 = out.split('CO-1')[2] || '';
    expect(co1).not.toContain('21 lines');
  });

  test('C10 a change order with no lines still says it is worth nothing', async () => {
    engine.db.prepare('UPDATE job_change_orders SET data=? WHERE id=?')
      .run(JSON.stringify({ title: 'empty', lines: [] }), 'co_c');
    const out = await read({ job_id: 'j1' }, door);
    expect(out).toContain('(no line items — this change order is worth $0)');
  });
});

describe('C8 include_lines is itself budgeted', () => {
  test('a list too big to print says what it dropped and how to read it', async () => {
    // 30 change orders × 20 lines is far past 24,000 characters of lines.
    const ins = engine.db.prepare(
      `INSERT INTO job_change_orders
         (id, job_id, owner_id, organization_id, status, co_number, data, is_locked, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`);
    for (let i = 4; i <= 30; i++) {
      ins.run('co_x' + i, 'j1', UID, ORG, 'draft', 'CO-' + i,
        JSON.stringify({ title: 'bulk', lines: mkLines('CO-' + i) }), 0,
        '2026-08-' + String(i).padStart(2, '0') + ' 09:00:00');
    }
    const out = await read({ job_id: 'j1', include_lines: true, limit: 100 });
    expect(out).toContain('BUDGETED — NOT ALL LINES ARE HERE');
    expect(out).toContain('Read one change order at a time with co_id');
    expect(out).toContain('Do not treat this as the full line list');
    // The budget is real: the answer is bounded even with include_lines on.
    expect(out.length).toBeLessThan(40000);
    // And a change order whose lines were skipped entirely says so by name.
    expect(out).toMatch(/line\(s\) NOT printed/);
  });

  test('one change order on its own is never clipped in practice', async () => {
    // The write-prep path has to be whole, or the ids it exists to deliver
    // are missing and the write that follows deletes what it cannot see.
    const out = await read({ job_id: 'j1', co_id: 'co_a' });
    expect(out).not.toContain('BUDGETED');
    for (let i = 1; i <= LINES_PER_CO; i++) expect(out).toContain('[line_id=CO-1-L' + i + ']');
  });
});

describe('C7 the counting rule has ONE copy', () => {
  test('the money module owns it and exports it', () => {
    expect(jobMoney.COUNTED_STATUSES instanceof Set).toBe(true);
    expect([...jobMoney.COUNTED_STATUSES].sort()).toEqual(['applied', 'approved']);
  });

  test('the reader asks that set rather than keeping its own list', async () => {
    // Behavioural, not a grep: widen the shared set and the reader's roll-up
    // follows it. A second copy in ai-routes would ignore this and keep
    // reporting 1.
    //
    // `await` INSIDE the try, not a returned promise: a `finally` that
    // restores the set before the awaited read has run would make this test
    // assert against the ORIGINAL set and fail for a reason that has nothing
    // to do with the claim.
    const original = new Set(jobMoney.COUNTED_STATUSES);
    jobMoney.COUNTED_STATUSES.add('pending');
    try {
      const out = await read({ job_id: 'j1' });
      expect(out).toContain('In the job\'s money: 2 approved/applied');
    } finally {
      jobMoney.COUNTED_STATUSES.clear();
      original.forEach((s) => jobMoney.COUNTED_STATUSES.add(s));
    }
  });
});

describe('C10 what 86 is TOLD matches what the tool does', () => {
  // AGENT_SYSTEM_BASELINE is keyed BY AGENT (job, scribe, assistant …), each
  // value an array of instruction lines. Flattened the same way
  // test/agent-instruction-honesty.test.js flattens it, so a promise moved
  // from one agent's baseline to another's is still read.
  const B = AGENT_SYSTEM_BASELINE || {};
  const baseline = Object.keys(B)
    .map((k) => (Array.isArray(B[k]) ? B[k].join('\n') : String(B[k] || '')))
    .join('\n');

  test('the baseline no longer promises every line on a list', () => {
    // It said: "Call read_change_orders FIRST — it returns the co_id and every
    // line's line_id". After this change that is only true of a call that
    // names one, and an instruction that is false about its own tool is how a
    // model ends up reporting that a tool is broken.
    expect(baseline).toMatch(/read_change_orders/);
    expect(baseline).toMatch(/co_id/);
    expect(baseline).not.toMatch(/change orders WITH THEIR LINE ITEMS \(read_change_orders/);
    expect(baseline).toMatch(/call it AGAIN with `co_id`|again with `co_id`/i);
  });

  test('the tool description says when lines arrive', () => {
    // The registered definition, not a grep of the source, and NOT guarded by
    // an `if (!co) pass` — a test that passes when it cannot find its subject
    // is the vacuous-assertion shape this repo keeps getting bitten by.
    const co = aiRoutes.internals.projectInlineTools()
      .find((t) => t && t.name === 'read_change_orders');
    expect(co).toBeTruthy();
    expect(co.description).toMatch(/WITH THEIR LINE ITEMS WHEN YOU NAME ONE/);
    expect(co.description).toMatch(/ONE-LINE summary of its lines/i);
    expect(co.input_schema.properties.include_lines).toBeTruthy();
    expect(co.input_schema.properties.include_lines.type).toBe('boolean');
  });
});
