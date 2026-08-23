// test/co-linked-node-spelling.test.js
//
// PINNING A SPELLING THAT MOVES MONEY.
//
// server/services/money/job-wip.js excludes graph-linked change orders from
// the earned-revenue loop with exactly this:
//
//     if (!c || c.linked_node_id) continue;
//
// A raw blob change order carries the camelCase spelling `linkedNodeId`. It
// therefore reads as UNLINKED here, and its earned is added on top of
// ngRevenueEarned — which already contains it. That is a real, pre-existing
// gap, and job-wip.js names it in a comment rather than repairing it, because
// normalizing the key moves org-wide revenue.
//
// The problem was that NOTHING held it. A verifier added `|| c.linkedNodeId`
// to that predicate — a one-token edit that reprices every job with a legacy
// blob CO — and all 2465 tests stayed green. The next person who tidies a
// spelling would move company revenue and get a passing build for it.
//
// So this file pins what IS, not what ought to be. It does not argue that the
// current behaviour is correct; the money layer's own comments say it is a
// gap. It makes changing it a decision someone has to make on purpose, with
// the size of the move written down.
//
// IT IS NOT THEORETICAL. computeJobWIP is reached with an UNSHAPED array on
// the legacy fallback: server/routes/ai-routes.js does
// `coByJob.get(row.id) || (Array.isArray(d.changeOrders) ? d.changeOrders : [])`
// for the org-wide rollup, and scripts/co-clock-census.js uses the same
// fallback. Rows that come off the change_orders TABLE go through
// shapeChangeOrderRow / shapeLegacyChangeOrder and are fine — which is the
// whole asymmetry, and is pinned below too.

const jobWip = require('../server/services/money/job-wip.js');
const coTotals = require('../server/services/money/change-order-totals.js');
const fs = require('fs');
const path = require('path');

// A job whose earned revenue came from the graph, so the CO loop's result is
// visible in revenueEarned rather than being swallowed by the fallback branch.
const JOB = { contractAmount: 90000, estimatedCosts: 0, pctComplete: 50, ngRevenueEarned: 7000 };
const wipWith = (co) => jobWip.computeJobWIP(JOB, { phases: [], buildings: [], changeOrders: [co] });

const CO = { id: 'c1', income: 10000, costs: 0 };
const SNAKE = Object.assign({}, CO, { linked_node_id: 'n1' });
const CAMEL = Object.assign({}, CO, { linkedNodeId: 'n1' });

// coEarned for this CO on the legacy branch: income x storedPct.
const CO_EARNED = 10000 * 0.50;

describe('the exclusion predicate reads ONE spelling, and that is load-bearing', () => {
  test('snake_case is excluded — its earned already lives in ngRevenueEarned', () => {
    expect(wipWith(SNAKE).revenueEarned).toBe(7000);
  });

  test('camelCase is NOT excluded — it earns again, on top', () => {
    // $5,000 of double-counted revenue on this one fixture. This is the
    // current, documented behaviour. Changing it is a money decision.
    expect(wipWith(CAMEL).revenueEarned).toBe(7000 + CO_EARNED);
    expect(wipWith(CAMEL).revenueEarned).toBe(wipWith(CO).revenueEarned); // same as no link at all
  });

  test('the gap is exactly one coEarned, and it flows on into backlog', () => {
    expect(wipWith(CAMEL).revenueEarned - wipWith(SNAKE).revenueEarned).toBe(CO_EARNED);
    expect(wipWith(SNAKE).backlog - wipWith(CAMEL).backlog).toBe(CO_EARNED);
    // The CO's income joins the contract either way — this is about EARNED,
    // not about the CO being seen at all.
    expect(wipWith(CAMEL).coIncome).toBe(wipWith(SNAKE).coIncome);
  });
});

describe('the shaped path and the raw path disagree on the same record', () => {
  test('shapeLegacyChangeOrder normalizes camelCase; computeJobWIP does not', () => {
    // One record, two answers, depending only on whether the caller shaped it.
    // That asymmetry is the actual defect. It is reported, not repaired.
    expect(coTotals.shapeLegacyChangeOrder(CAMEL).linked_node_id).toBe('n1');
    expect(wipWith(coTotals.shapeLegacyChangeOrder(CAMEL)).revenueEarned).toBe(7000);
    expect(wipWith(CAMEL).revenueEarned).toBe(7000 + CO_EARNED);
  });

  test('a shaped TABLE row carries the column, so it was never at risk', () => {
    const shaped = coTotals.shapeChangeOrderRow({
      id: 'r1', status: 'approved', co_number: 'CO-1', linked_node_id: 'n1',
      data: { lines: [{ id: 'x', qty: 1, unitCost: 10000 }] },
    });
    expect(shaped.linked_node_id).toBe('n1');
    expect(wipWith(shaped).revenueEarned).toBe(7000);
  });
});

describe('the predicate itself is pinned to its current spelling', () => {
  const WIP = fs.readFileSync(
    path.join(__dirname, '..', 'server', 'services', 'money', 'job-wip.js'), 'utf8');
  // Comments in this file discuss `linkedNodeId` on purpose. Only executable
  // lines are searched, so the documentation cannot satisfy or break the pin.
  const CODE = WIP.split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');

  test('the CO loop guard is exactly `!c || c.linked_node_id`', () => {
    expect(CODE).toMatch(/if \(!c \|\| c\.linked_node_id\) continue;/);
  });

  test('no executable line in job-wip.js reads the camelCase key', () => {
    // This is the assertion the `|| c.linkedNodeId` edit slipped past. If you
    // are here because it just went red: you are about to reprice every job
    // carrying a legacy blob change order. See the numbers above for the size
    // of one, and run scripts/co-clock-census.js for the total before shipping.
    expect(CODE).not.toMatch(/linkedNodeId/);
  });

  test('there is exactly ONE such guard, so the pin above is exhaustive', () => {
    expect(CODE.match(/c\.linked_node_id/g) || []).toHaveLength(1);
  });

  test('the gap is still documented where the code is', () => {
    // The pin and the comment have to survive together — a pin with no stated
    // reason is the thing that gets deleted as noise.
    expect(WIP).toMatch(/carries `linkedNodeId`, not `linked_node_id`/);
  });
});
