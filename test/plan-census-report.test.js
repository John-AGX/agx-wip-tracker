// GATE 1 — the census's OUTPUT, not just its classifier.
//
// The defect that started this was not a wrong function. It was a correct-
// looking number printed under a wrong legend: rows with nothing left in them
// appeared beside "geometry intact in model.* — self-heals on the next open.
// No action needed; count should fall to 0."
//
// A classifier that returns 'destroyed' under a legend that says "no action
// needed" fails exactly the same way, so the classification is not the whole
// fix and asserting it is not the whole test. This runs the REAL script
// against a fake pool holding REAL wreckage and reads what it prints.

'use strict';

const W = require('./helpers/plan-wreckage');
const H = require('./helpers/sheet-doc-harness');
const PD = require('../server/services/plan-doc');

const SE_PRE = W.preFixEditor();
const PD_PRE = W.preFixPlanDoc();

// One destroyed drawing with a surviving snapshot, one destroyed drawing with
// nothing behind it, one row the loader will heal by itself, one healthy row.
const WRECKED = W.run(SE_PRE, PD_PRE, 15, 4).stored;
const GOOD = W.run(H.SE, PD, 15, 1).stored;
const HIDDEN = W.run(H.SE, PD_PRE, 15, 4).stored;

const PLANS = [
  { id: 'plan_destroyed', organization_id: 7, name: 'Bldg 3 framing', base_kind: 'sheet', updated_at: '2026-08-18T12:00:00Z', pages: WRECKED, versions: '4' },
  { id: 'plan_gone', organization_id: 7, name: 'Sitework detail', base_kind: 'sheet', updated_at: '2026-08-17T12:00:00Z', pages: WRECKED, versions: '2' },
  { id: 'plan_hidden', organization_id: 7, name: 'Unit A elevation', base_kind: 'sheet', updated_at: '2026-08-16T12:00:00Z', pages: HIDDEN, versions: '1' },
  { id: 'plan_ok', organization_id: 7, name: 'Clubhouse plan', base_kind: 'sheet', updated_at: '2026-08-15T12:00:00Z', pages: GOOD, versions: '9' },
  { id: 'plan_markup', organization_id: 7, name: 'Photo takeoff', base_kind: 'photo', updated_at: '2026-08-14T12:00:00Z', pages: [{ page: 0, calibration: null, strokes: [] }], versions: '0' }
];
const VERSIONS = {
  plan_destroyed: [
    { id: 41, created_at: '2026-08-05T10:00:00Z', pages: WRECKED },
    { id: 40, created_at: '2026-07-09T10:00:00Z', pages: GOOD }
  ],
  plan_gone: [{ id: 30, created_at: '2026-08-04T10:00:00Z', pages: WRECKED }]
};

jest.mock('../server/db', () => {
  const q = async (sql, params) => {
    const t = String(sql).replace(/\s+/g, ' ');
    global.__censusSql.push(t);
    if (/FROM plans p/.test(t)) return { rows: global.__censusPlans };
    if (/FROM plans WHERE id/.test(t)) {
      return { rows: global.__censusPlans.filter((p) => p.id === params[0]) };
    }
    if (/FROM plans WHERE base_kind/.test(t)) {
      return { rows: global.__censusPlans.filter((p) => p.base_kind === 'sheet') };
    }
    // plan-recover's single-version lookup: WHERE id = $1 AND plan_id = $2
    if (/FROM plan_versions WHERE id = \$1 AND plan_id/.test(t)) {
      return { rows: (global.__censusVersions[params[1]] || []).filter((v) => v.id === params[0]) };
    }
    if (/FROM plan_versions/.test(t)) return { rows: (global.__censusVersions[params[0]] || []) };
    return { rows: [] };
  };
  return {
    pool: {
      query: q,
      connect: async () => ({ query: q, release() {} }),
      end: async () => {}
    }
  };
});

// Run a shipped script end to end and read what it printed. Scripts execute
// on require, so this isolates the module registry per run.
function runScript(rel, argv) {
  global.__censusPlans = PLANS;
  global.__censusVersions = VERSIONS;
  global.__censusSql = [];
  const out = [];
  const realLog = console.log;
  const realArgv = process.argv;
  const realCode = process.exitCode;
  process.argv = ['node', rel].concat(argv || []);
  console.log = function () {
    const args = Array.prototype.slice.call(arguments);
    out.push(args.length > 1 ? require('util').format.apply(null, args) : String(args[0]));
  };
  let done;
  jest.isolateModules(() => { done = require(rel); });
  return Promise.resolve(done).then(() => new Promise((r) => setImmediate(r))).then(() => {
    console.log = realLog;
    process.argv = realArgv;
    const code = process.exitCode;
    process.exitCode = realCode;
    return { text: out.join('\n'), code: code, sql: global.__censusSql.slice() };
  });
}
function runCensus(argv) { return runScript('../scripts/plan-doc-census.js', argv).then((r) => r.text); }
function runRecover(argv) { return runScript('../scripts/plan-recover.js', argv); }

describe('the census report', () => {

  test('names the casualties, and counts them', async () => {
    const text = await runCensus();
    expect(text).toMatch(/DESTROYED\s+: 1/);            // plan_destroyed
    expect(text).toMatch(/EMPTY - CANNOT TELL\s+: 1/);  // plan_gone
    expect(text).toMatch(/recoverable-by-open\s+: 1/);  // plan_hidden
    expect(text).toMatch(/healthy\s+: 1/);              // plan_ok
  });

  test('the DESTROYED count is not printed as recoverable-by-open', async () => {
    const text = await runCensus();
    // The whole original failure in one assertion: the destroyed row must not
    // be absorbed into the class whose legend says nothing needs doing.
    expect(text).not.toMatch(/recoverable-by-open\s+: 2/);
    // The tally line itself, not the legend paragraph that quotes the phrase.
    expect(text).not.toMatch(/^ +DESTROYED +: 0/m);
    expect(text).toMatch(/^ +DESTROYED +: 1/m);
  });

  test('"no action needed" is attached to the harmless class and to nothing else', async () => {
    const text = await runCensus();
    const lines = text.split('\n');
    const noAction = lines.findIndex((l) => /No action needed/i.test(l));
    const recoverable = lines.findIndex((l) => /recoverable-by-open\s+:/.test(l));
    const destroyed = lines.findIndex((l) => /DESTROYED\s+:/.test(l));
    expect(noAction).toBeGreaterThan(recoverable);
    expect(noAction).toBeLessThan(destroyed);           // it sits in the recoverable block
    // and the destroyed block says the opposite
    expect(text).toMatch(/the casualties/);
    expect(text).toMatch(/plan-recover\.js/);
  });

  test('it says what "DESTROYED : 0" would and would not mean', async () => {
    const text = await runCensus();
    expect(text).toMatch(/READING "DESTROYED : 0"/);
    expect(text).toMatch(/does NOT mean nothing was\s*\n?\s*lost/);
  });

  test('it refuses to guess about a row with nothing behind it', async () => {
    const text = await runCensus();
    expect(text).toMatch(/CANNOT TELL THE/);
    expect(text).toMatch(/nobody ever drew on/);
    expect(text).toMatch(/will not guess/);
  });

  test('--rows names the destroyed plan and the restore point that can save it', async () => {
    const text = await runCensus(['--rows']);
    const line = text.split('\n').find((l) => /plan_destroyed/.test(l));
    expect(line).toMatch(/^DESTROYED/);
    expect(line).toMatch(/RESTORE v40 \(15 entities, 2026-07-09/);
    expect(line).toMatch(/Bldg 3 framing/);
    const gone = text.split('\n').find((l) => /plan_gone/.test(l));
    expect(gone).toMatch(/^EMPTY-UNKNOWN/);
    expect(gone).toMatch(/none held geometry/);
  });

  test('it reads plans without writing to them', async () => {
    const r = await runScript('../scripts/plan-doc-census.js');
    expect(r.sql.length).toBeGreaterThan(0);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════
describe('the recovery tool shows before it acts, and refuses the rest', () => {

  test('--plan prints both sides and the exact command, and writes nothing', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed']);
    expect(r.text).toMatch(/state\s+: DESTROYED/);
    expect(r.text).toMatch(/right now: 0 object\(s\)/);      // what would be replaced
    expect(r.text).toMatch(/version 40 — 15 object\(s\)/);   // what would be taken
    expect(r.text).toMatch(/--restore 40 --expect-entities 15 --operator/);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });

  test('it names the newest restore point that still HOLDS a drawing, not the newest one', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed']);
    // version 41 is newer but was taken after the bug and is empty.
    expect(r.text).toMatch(/version 40 —/);
    expect(r.text).not.toMatch(/version 41 —/);
  });

  test('a plan with nothing behind it is told so, not offered a restore', async () => {
    const r = await runRecover(['--plan', 'plan_gone']);
    expect(r.text).toMatch(/Every restore point is empty too/);
    expect(r.text).toMatch(/cannot tell those apart and will not guess/);
    expect(r.text).not.toMatch(/--restore /);
  });

  test('--list shows candidates and explicitly does not restore them', async () => {
    const r = await runRecover(['--list']);
    expect(r.text).toMatch(/1 destroyed plan\(s\) with a recoverable snapshot/);
    expect(r.text).toMatch(/plan_destroyed/);
    expect(r.text).toMatch(/Nothing above has been changed/);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });

  test('a restore with no stated expectation is refused before any connection', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed', '--restore', '40', '--operator', 'John']);
    expect(r.text).toMatch(/REFUSED\. --expect-entities/);
    expect(r.code).toBe(1);
    expect(r.sql).toEqual([]);
  });

  test('a restore with no named operator is refused — the audit row has to name a human', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed', '--restore', '40', '--expect-entities', '15']);
    expect(r.text).toMatch(/REFUSED\. --operator/);
    expect(r.code).toBe(1);
    expect(r.sql).toEqual([]);
  });

  test('a stale expectation is refused, and nothing is written', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed', '--restore', '40',
      '--expect-entities', '9', '--operator', 'John']);
    expect(r.text).toMatch(/REFUSED\. You passed --expect-entities 9 but that restore point holds 15/);
    expect(r.code).toBe(1);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });

  test('an empty restore point is refused — restoring nothing is never the intent', async () => {
    const r = await runRecover(['--plan', 'plan_destroyed', '--restore', '41',
      '--expect-entities', '0', '--operator', 'John']);
    expect(r.text).toMatch(/REFUSED\. That restore point is empty/);
    expect(r.code).toBe(1);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });

  test('restoring onto a plan that still HAS a drawing needs a second, explicit flag', async () => {
    // plan_ok is healthy. Recovering onto it would overwrite live work — a
    // different and far more dangerous operation than recovering onto an
    // empty row, and it must not share the same command shape.
    global.__censusVersions.plan_ok = [{ id: 60, created_at: '2026-07-01T10:00:00Z', pages: GOOD }];
    const r = await runRecover(['--plan', 'plan_ok', '--restore', '60',
      '--expect-entities', '15', '--operator', 'John']);
    delete VERSIONS.plan_ok;
    expect(r.text).toMatch(/REFUSED\. The live row still holds 15 object\(s\)/);
    expect(r.text).toMatch(/--replace-live/);
    expect(r.code).toBe(1);
    expect(r.sql.every((s) => /^SELECT/i.test(s))).toBe(true);
  });

  test('with no arguments it explains itself and does nothing', async () => {
    const r = await runRecover([]);
    expect(r.text).toMatch(/usage:/);
    expect(r.code).toBe(1);
    expect(r.sql).toEqual([]);
  });
});
