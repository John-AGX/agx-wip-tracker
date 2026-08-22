// test/co-income-call-sites.test.js — every door onto a change order's
// income runs the SAME resolver, and nothing else moved.
//
// The sell-lock rule has two halves. The arithmetic is proven in
// test/co-sell-lock.test.js. This file proves the arithmetic is actually
// REACHED — from all six income sites — because an un-ported site does not
// throw. It computes `applyTargetMargin(per.subtotal, rec)`, silently
// discards a promised price, and under-reports a change order by exactly
// the promise. That failure is invisible at runtime and invisible in a
// diff, so it is caught here or it is not caught.
//
// Three of the six live in js/jobs.js and js/change-order-editor.js, which
// jest cannot require (browser IIFEs reading window/appData). Those are
// asserted as source. The server module is executed.
//
// A NOTE ON THE COMMENT STRIPPER used elsewhere in this suite: run over
// js/estimate-editor.js it eats 74% of the file (an unbalanced `/*` inside
// a string literal swallows everything to the next close), which would turn
// every `not.toMatch` on it into a vacuous pass. So POSITIVE structural
// assertions read stripped source (prose can't false-positive them) and
// every NEGATIVE assertion reads RAW source. A guard that can pass by
// accident is not a guard.

const fs = require('fs');
const path = require('path');
const raw = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = (...p) => stripJs(raw(...p));

const PIPELINE = code('js', 'pricing-pipeline.js');
const CO_TOTALS = code('server', 'services', 'money', 'change-order-totals.js');
const JOBS = code('js', 'jobs.js');
const CO_ED = code('js', 'change-order-editor.js');
const DISPATCH = code('server', 'services', 'payload-dispatcher.js');

const pricing = require('../js/pricing-pipeline.js');
const { changeOrderMoney } = require('../server/services/money/change-order-totals');

// One shared fixture. Every site must produce this number.
const REC = {
  targetMargin: 30,
  lines: [
    { id: 'promised', qty: 1, unitCost: 1650, unitSell: 2750 },
    { id: 'derived', qty: 1, unitCost: 3000 },
  ],
};
const CARVED = 7035.714285714286;
const UNPORTED = 6642.857142857143;

describe('one implementation — there is no CO-specific pricing maths', () => {
  test('the resolver lives in the shared pipeline and is exported to both targets', () => {
    expect(PIPELINE).toMatch(/function resolveMarkedUp\(per, rec\)/);
    expect(PIPELINE).toMatch(/resolveMarkedUp: resolveMarkedUp/);
    expect(PIPELINE).toMatch(/if \(typeof window !== 'undefined'\) window\.p86Pricing = api;/);
    expect(PIPELINE).toMatch(/if \(typeof module !== 'undefined' && module\.exports\) module\.exports = api;/);
  });

  test('the server requires that very file rather than carrying a second copy', () => {
    expect(CO_TOTALS).toMatch(/require\('\.\.\/\.\.\/\.\.\/js\/pricing-pipeline\.js'\)/);
  });

  test('the qty x unitSell rule exists in exactly ONE file', () => {
    // If it is written anywhere else, the rows, the totals bar and the WIP
    // number can disagree — which is the drift the shared pipeline was
    // created to end.
    expect(PIPELINE).toMatch(/num\(line\.qty\) \* num\(line\.unitSell\)/);
    for (const rel of [['js', 'jobs.js'], ['js', 'change-order-editor.js'],
      ['server', 'services', 'money', 'change-order-totals.js'],
      ['server', 'services', 'money', 'job-wip.js'],
      ['nodegraph', 'ui.js'], ['js', 'co-draw.js']]) {
      expect(raw(...rel)).not.toMatch(/\*\s*num\(\w+\.unitSell\)|unitSell\s*\)?\s*\*/);
    }
  });
});

describe('all six income sites call resolveMarkedUp', () => {
  test('1 — change-order-totals.changeOrderMoney (WIP + AI context)', () => {
    expect(CO_TOTALS).toMatch(/pricing\.resolveMarkedUp\(per, r\)/);
    expect(changeOrderMoney(REC).income).toBe(CARVED);
  });

  test('2 — change-order-editor.computeTotals (the number on screen)', () => {
    expect(CO_ED).toMatch(/window\.p86Pricing\.resolveMarkedUp\(per, co\)/);
  });

  test('3 — jobs.coSellAmount (Site Plan, G703, audit, node graph all route here)', () => {
    expect(JOBS).toMatch(/function coSellAmount\(c\)[\s\S]{0,400}?resolveMarkedUp\(per, c\)/);
  });

  test('4 — jobs.coTotal (the change-order list)', () => {
    expect(JOBS).toMatch(/function coTotal\(c\)[\s\S]{0,600}?resolveMarkedUp\(per, c\)/);
  });

  test('5 — jobs building-card CO income', () => {
    expect(JOBS).toMatch(/resolveMarkedUp\(per, srv\)/);
  });

  test('6 — the CO editor row paints, via the shared per-line rule', () => {
    // Two row sites that each hand-rolled `ext * (1 + m/100)`. A rule
    // written four times is a rule that will disagree with itself.
    expect(CO_ED).toMatch(/window\.p86Pricing\.lineMoney\(l, lines, _state\.co\)/);
    expect(CO_ED).toMatch(/window\.p86Pricing\.lineMoney\(line, lines, _state\.co\)\.sell/);
  });

  test('NO CO income path still hand-rolls the old ternary', () => {
    // The exact shape that silently discards a promise.
    for (const rel of [['js', 'jobs.js'], ['js', 'change-order-editor.js'],
      ['server', 'services', 'money', 'change-order-totals.js']]) {
      const hits = raw(...rel).match(/applyTargetMargin\(\s*per\.subtotal/g) || [];
      expect({ file: rel.join('/'), hits }).toEqual({ file: rel.join('/'), hits: [] });
    }
  });

  test('and no CO row paint still hand-rolls the markup arithmetic', () => {
    expect(raw('js', 'change-order-editor.js')).not.toMatch(/\(1 \+ m \/ 100\)/);
  });

  test('the un-ported number is a DIFFERENT number — so a miss is a red test', () => {
    const per = pricing.computeForLines(REC, REC.lines);
    expect(pricing.applyTargetMargin(per.subtotal, REC)).toBe(UNPORTED);
    expect(pricing.resolveMarkedUp(per, REC)).toBe(CARVED);
    expect(UNPORTED).not.toBe(CARVED);
  });
});

describe('unitSell is change-order-only, and that is ENFORCED not assumed', () => {
  test('the agent line-edit door refuses to write it onto an estimate line', () => {
    // applyLineEdits assigns arbitrary keys onto an estimate line. The
    // pipeline honours the key on any line it sees, but every estimate
    // READER is blind to it — the row paint, js/bt-export.js's forked
    // cascade, and the hand-rolled cascades in server/routes/ai-routes.js.
    // Without this skip, "CO-only" is enforced nowhere.
    expect(DISPATCH).toMatch(/if \(targetKey === 'unitSell' \|\| targetKey === 'unit_sell'\) continue;/);
  });

  test('the estimate editor rebuilds `per` as a literal — and now says why that is a trap', () => {
    // Two places drop lockedSubtotal/lockedSell. Harmless while the field
    // is CO-only; the day it reaches estimates they silently discard every
    // promised price under a target margin. Raw source: the stripper eats
    // most of this file.
    const EST = raw('js', 'estimate-editor.js');
    const rebuilds = EST.match(/= \{ subtotal: \w+\.subtotal, markedUp: applyTargetMargin\(/g) || [];
    expect(rebuilds).toHaveLength(2);
    expect(EST).toMatch(/dropping p86Pricing's/);
    expect(EST).toMatch(/lockedSubtotal\/lockedSell keys/);
  });

  test('no estimate money module learned about the field', () => {
    for (const rel of [['server', 'services', 'money', 'estimate-totals.js'],
      ['js', 'estimates.js'], ['js', 'estimate-preview.js'], ['js', 'bt-export.js'],
      ['server', 'services', 'estimate-lines.js']]) {
      expect(raw(...rel)).not.toMatch(/unitSell/);
    }
  });
});

// ══ THE BLAST RADIUS — what this change may not touch ═══════════════════

describe('cost attribution stays provably non-accruing', () => {
  test('costDraws and costSource still have ZERO consumers in the money path', () => {
    for (const rel of [['server', 'services', 'money', 'job-wip.js'],
      ['server', 'services', 'money', 'change-order-totals.js'],
      ['server', 'services', 'money', 'job-cost-buckets.js'],
      ['server', 'services', 'money', 'cost-line-filters.js']]) {
      expect(raw(...rel)).not.toMatch(/costDraws|costSource/);
    }
  });

  test('job-wip has never heard of the pricing model at all', () => {
    const WIP = raw('server', 'services', 'money', 'job-wip.js');
    expect(WIP).not.toMatch(/unitSell|lockedSell|lockedSubtotal|resolveMarkedUp|costPending/);
  });

  test('job-wip still folds a CO cost into estimated costs exactly once', () => {
    expect(code('server', 'services', 'money', 'job-wip.js'))
      .toMatch(/totalEstCosts\s*=\s*estimatedCosts \+ /);
  });

  test("a change order's cost is still Sigma qty x unitCost and nothing else", () => {
    expect(CO_TOTALS).toMatch(/return \{ income, costs: per\.subtotal \};/);
    expect(PIPELINE).toMatch(/var ext = num\(line && line\.qty\) \* num\(line && line\.unitCost\);/);
  });
});

describe('the building sort money paths are untouched', () => {
  test('js/building-sort.js carries no edit from this change', () => {
    expect(raw('js', 'building-sort.js'))
      .not.toMatch(/unitSell|resolveMarkedUp|lineMoney|lockedSell|costPending/);
  });

  test('the node graph learned nothing about the pricing model', () => {
    // Its CO money already routes through window.coSellAmount, which is
    // ported once, in js/jobs.js. Nothing here needed an edit — and the
    // largest-remainder walk (sell / 10,000 per building; $2.75 on
    // CO-0001's $27,500) must not be reachable from a pricing change.
    const NG = raw('nodegraph', 'ui.js');
    expect(NG).not.toMatch(/unitSell|resolveMarkedUp|lineMoney|lockedSell/);
    expect(NG).toMatch(/coSellAmount/);
  });
});

describe('the pending one-clock port is not collided with', () => {
  test('nothing named coEarned, coCompletion or riderScopeName was edited', () => {
    for (const rel of [['js', 'jobs.js'], ['js', 'change-order-editor.js'],
      ['server', 'services', 'money', 'change-order-totals.js']]) {
      const src = raw(...rel);
      expect(src).not.toMatch(/coEarned[\s\S]{0,300}?unitSell/);
      expect(src).not.toMatch(/completionMode[\s\S]{0,300}?unitSell/);
      expect(src).not.toMatch(/riderScopeName[\s\S]{0,300}?unitSell/);
    }
  });

  test('coCompletion still reads coSellAmount and subtotal as opaque scalars', () => {
    expect(JOBS).toMatch(/var sell = coSellAmount\(co\);/);
    expect(JOBS).toMatch(/computeForLines\(co, lines\) \|\| \{\}\)\.subtotal/);
  });
});
