// test/co-clock-census-truth.test.js
//
// scripts/co-clock-census.js is the instrument John was told to run BEFORE
// trusting the new WIP. An instrument that overstates is worse than no
// instrument, so what it EXCLUDES has to be as true as what it reports.
//
// G2 emitted dRevenueEarned / dDisplayProfit / dBacklog / dUnbilled for every
// job with a non-zero clock Δ. But computeJobWIP folds coEarned in on ONE
// branch only, and prefers a stored backlog over the derived one:
//
//   revenueEarned = job.ngRevenueEarned != null ? ngRevenueEarned + coEarned
//                                               : totalIncome × storedPct
//   backlog       = job.ngBacklog       != null ? ngBacklog
//                                               : totalIncome − revenueEarned
//
// So on a job with no graph-pushed earned revenue the census promised a move
// that will never materialise, and Δ backlog = −Δ held only where one ng*
// field is set and the other is not.
//
// HOW THE MOVE IS MEASURED HERE. The counterfactual is the CLOCK, not the
// change order. Running computeJobWIP with and without a CO is the wrong
// comparison: the CO's income also joins totalIncome, so revenueEarned moves
// on the fallback branch too and everything looks like it lands. What the
// port actually changed is what a FIXED change order earns — so these tests
// hold the CO, the income and the stored percent constant and move only the
// ridden scope's percent (51% → 60%, a $900 clock Δ on a $10k rider). Any
// figure that does not move under that is a figure the census must not claim.
//
// These assertions run against computed numbers, not against job-wip.js's
// comment. If someone later makes coEarned land on both branches (a
// defensible change; that file says so), the census's "excluded, and here is
// why" line becomes a lie — and this is what says so, instead of a silent
// overstatement in the report John is using to decide whether to ship.

const { deltaLanding } = require('../scripts/co-clock-census.js');
const jobWip = require('../server/services/money/job-wip.js');

// One approved, unlinked rider CO riding a single job-level scope.
const CO = { id: 'co1', income: 10000, costs: 4000, linked_node_id: null,
  completionMode: 'rider', riderScopeName: 'Roof' };
const scopeAt = (pct) => [{ jobId: 'J', phase: 'Roof', asSoldRevenue: 50000, pctComplete: pct }];
const wipAt = (job, pct, extra) =>
  jobWip.computeJobWIP(job, Object.assign({ phases: scopeAt(pct), buildings: [], changeOrders: [CO] }, extra));

// The four figures the census reports, measured as "what moves when the CO's
// clock moves from the stored 51% to the scope's 60%". Δ = $900.
const CLOCK_DELTA = 10000 * 0.60 - 10000 * 0.51;
function moves(job, extra) {
  const before = wipAt(job, 51, extra), after = wipAt(job, 60, extra);
  expect(after.totalIncome).toBe(before.totalIncome);  // the income side never moves
  return {
    revenueEarned: after.revenueEarned - before.revenueEarned,
    displayProfit: after.displayProfit - before.displayProfit,
    backlog: after.backlog - before.backlog,
    unbilled: after.unbilled - before.unbilled,
  };
}

const JOB = { contractAmount: 90000, estimatedCosts: 0, pctComplete: 51 };
const job = (extra) => Object.assign({}, JOB, extra);

describe('the census excludes exactly the jobs whose Δ reaches no stored number', () => {
  test('ngRevenueEarned absent → NONE of the four figures move', () => {
    const j = job();
    expect(deltaLanding(j).landsInEarned).toBe(false);
    // This is the overstatement. The census used to print a Δ on all four.
    expect(moves(j)).toEqual({ revenueEarned: 0, displayProfit: 0, backlog: 0, unbilled: 0 });
  });

  test('ngRevenueEarned present → the Δ lands, and the census counts it', () => {
    const j = job({ ngRevenueEarned: 7000 });
    expect(deltaLanding(j).landsInEarned).toBe(true);
    const m = moves(j);
    expect(m.revenueEarned).toBeCloseTo(CLOCK_DELTA, 6);
    expect(m.displayProfit).toBeCloseTo(CLOCK_DELTA, 6);
    expect(m.unbilled).toBeCloseTo(CLOCK_DELTA, 6);
  });

  test('ngRevenueEarned: 0 is a pushed value, not an absence', () => {
    // `!= null`, not a truthiness test. A Site-Plan graph at 0% done pushes a
    // non-null zero and that job's Δ DOES land — excluding it would understate,
    // which is the same failure pointed the other way.
    const j = job({ ngRevenueEarned: 0 });
    expect(deltaLanding(j).landsInEarned).toBe(true);
    expect(moves(j).revenueEarned).toBeCloseTo(CLOCK_DELTA, 6);
  });

  test('the flag equals the measured move on every combination of the ng* fields', () => {
    const CASES = [
      {},
      { ngBacklog: 5000 },
      { ngRevenueEarned: 0 },
      { ngRevenueEarned: 7000 },
      { ngRevenueEarned: 7000, ngBacklog: 5000 },
      { ngRevenueEarned: 0, ngBacklog: 0 },
    ];
    for (const c of CASES) {
      const j = job(c);
      const m = moves(j);
      const label = JSON.stringify(c);
      expect([label, deltaLanding(j).landsInEarned]).toEqual([label, Math.abs(m.revenueEarned) > 0.005]);
      expect([label, deltaLanding(j).landsInBacklog]).toEqual([label, Math.abs(m.backlog) > 0.005]);
    }
  });
});

describe('Δ backlog = −Δ holds on fewer jobs than the census used to claim', () => {
  test('a stored ngBacklog is preferred, so backlog does not move at all', () => {
    // nodegraph/ui.js writes ngBacklog in the same block as ngRevenueEarned,
    // so THIS is the ordinary shape of a job whose earned Δ lands: earned,
    // profit and unbilled move, backlog is frozen. `dBacklog: -delta` was
    // wrong on exactly these.
    const j = job({ ngRevenueEarned: 7000, ngBacklog: 5000 });
    expect(deltaLanding(j).landsInBacklog).toBe(false);
    const m = moves(j);
    expect(m.backlog).toBe(0);
    expect(m.revenueEarned).toBeCloseTo(CLOCK_DELTA, 6);  // and the rest still move
  });

  test('derived backlog moves by −Δ', () => {
    const j = job({ ngRevenueEarned: 7000 });
    expect(deltaLanding(j).landsInBacklog).toBe(true);
    expect(moves(j).backlog).toBeCloseTo(-CLOCK_DELTA, 6);
  });

  test('no earned move ⇒ no backlog move, even with backlog derived', () => {
    const j = job();
    expect(deltaLanding(j).landsInBacklog).toBe(false);
    expect(moves(j).backlog).toBe(0);
  });
});

describe('unbilled moves with earned — invoiced is frozen AR', () => {
  test('Δ unbilled equals Δ revenueEarned, and AR does not reprice', () => {
    const j = job({ ngRevenueEarned: 7000 });
    const invoices = [{ amount: 20000, status: 'sent' }];
    const before = wipAt(j, 51, { invoices }), after = wipAt(j, 60, { invoices });
    expect(after.invoiced).toBe(before.invoiced);
    expect(after.unbilled - before.unbilled).toBeCloseTo(after.revenueEarned - before.revenueEarned, 6);
  });
});

describe('the report itself does not silently drop the excluded jobs', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'scripts', 'co-clock-census.js'), 'utf8');

  test('the totals are summed over what LANDS, not over the raw clock Δ', () => {
    expect(src).toMatch(/const landing = sorted\.filter\(\(r\) => r\.landsInEarned\)/);
    expect(src).toMatch(/const stranded = sorted\.filter\(\(r\) => !r\.landsInEarned\)/);
    // The old totals summed r.delta across every row. That was the overstatement.
    expect(src).not.toMatch(/up\.reduce\(\(s, r\) => s \+ r\.delta, 0\)/);
  });

  test('the excluded count, its dollars and its reason are printed', () => {
    expect(src).toMatch(/EXCLUDED FROM THE TOTALS[^\n]*\$\{stranded\.length\}/);
    expect(src).toMatch(/stranded\.reduce\(\(s, r\) => s \+ r\.delta, 0\)/);
    expect(src).toMatch(/ngRevenueEarned == null/);
  });

  test('the excluded jobs are still LISTED and flagged, not filtered out', () => {
    // This repo has an explicit rule against silent truncation: the rows stay
    // in g2 and in the printed table, carrying a marker that explains them.
    expect(src).toMatch(/const mark = !r\.landsInEarned/);
    expect(src).not.toMatch(/g2\s*=\s*g2\.filter/);
  });

  test('the CSV carries the flags and the raw clock Δ alongside the landed ones', () => {
    expect(src).toMatch(/d_clock,/);
    expect(src).toMatch(/lands_in_earned,lands_in_backlog/);
    expect(src).toMatch(/r\.landsInEarned, r\.landsInBacklog/);
  });

  test('requiring the census does not open a database connection', () => {
    // The require() at the top of this file is the assertion — main() is the
    // only thing that touches server/db.js and it sits behind require.main.
    expect(src).toMatch(/if \(require\.main === module\) main\(\)/);
    expect(typeof deltaLanding).toBe('function');
  });
});
