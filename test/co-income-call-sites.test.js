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
    // Still ONE file, and the list below is still every file that must not
    // carry a second copy — the estimate side reaches the rule through
    // p86Pricing.lineMoney rather than by writing it again.
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
    // written four times is a rule that will disagree with itself. Both
    // now take their cost AND their amount from lineMoney.
    expect(CO_ED).toMatch(/window\.p86Pricing\.lineMoney\(l, lines, _state\.co\)/);
    expect(CO_ED).toMatch(/window\.p86Pricing\.lineMoney\(line, lines, _state\.co\)/);
    // ...and the section header row's money comes from the same call.
    expect(CO_ED).toMatch(/window\.p86Pricing\.lineMoney\(l, lines, rec\)/);
  });

  test('NO CO income path still hand-rolls the old ternary', () => {
    // The exact shape that silently discards a promise.
    for (const rel of [['js', 'jobs.js'], ['js', 'change-order-editor.js'],
      ['server', 'services', 'money', 'change-order-totals.js']]) {
      const hits = raw(...rel).match(/applyTargetMargin\(\s*per\.subtotal/g) || [];
      expect({ file: rel.join('/'), hits }).toEqual({ file: rel.join('/'), hits: [] });
    }
  });

  test('and no PRICED amount in the CO editor is hand-rolled', () => {
    // The exact old shape: the row's Amount computed from cost x markup
    // instead of from the shared rule. (A greyed per-unit PLACEHOLDER on a
    // zero-qty line still applies a percentage for display — that number
    // is never summed, never saved, and never reaches a total.)
    const SRC = raw('js', 'change-order-editor.js');
    expect(SRC).not.toMatch(/ext \* \(1 \+ m \/ 100\)/);
    expect(SRC).not.toMatch(/marked = ext/);
  });

  test('the un-ported number is a DIFFERENT number — so a miss is a red test', () => {
    const per = pricing.computeForLines(REC, REC.lines);
    expect(pricing.applyTargetMargin(per.subtotal, REC)).toBe(UNPORTED);
    expect(pricing.resolveMarkedUp(per, REC)).toBe(CARVED);
    expect(UNPORTED).not.toBe(CARVED);
  });
});

// ══════════════════════════════════════════════════════════════════════
// unitSell REACHED ESTIMATES. THIS GUARD DID NOT GO AWAY — IT SPLIT.
//
// It was one claim ("no estimate module has heard of this field") standing
// in for three separate ones, and only the first has stopped being true:
//
//   1. the estimate MONEY path may now know about it — and that is asserted
//      POSITIVELY below, per file, rather than merely no longer forbidden.
//      A guard that is deleted when its subject changes protects nothing
//      during the change, which is exactly when protection is worth having;
//   2. server/services/estimate-lines.js must STILL never write it. An
//      assembly is a costed recipe and a recipe cannot promise a price —
//      the long comment in that file says why. Unchanged, and still a
//      negative;
//   3. every change-order-side guarantee in this file is untouched.
//
// AND THE ONE THAT CANNOT BE ASSERTED FROM SOURCE — that the numbers these
// paths produce actually AGREE — is not attempted here. It is proven
// arithmetically, over every path at once, in
// test/estimate-promised-price.test.js.
// ══════════════════════════════════════════════════════════════════════
describe('unitSell now reaches estimates, and every estimate money path knows it', () => {
  test('the agent line-edit door STILL refuses to write it onto an estimate line', () => {
    // applyLineEdits assigns arbitrary keys onto an estimate line. The
    // readers are no longer blind — that is the change — but this door is
    // NOT how the field should arrive on an estimate. It is the generic
    // key-assign path with no per-field validation of its own, and the two
    // shapes that matter here are indistinguishable to it: `0` is a real
    // promise at free and `''` is no promise at all. An agent that wants to
    // promise a price on an estimate line has a reviewed door to build; it
    // does not get this one by default because a guard was relaxed
    // elsewhere. Kept deliberately, not by omission.
    expect(DISPATCH).toMatch(/if \(targetKey === 'unitSell' \|\| targetKey === 'unit_sell'\) continue;/);
  });

  test('the estimate editor NO LONGER rebuilds `per` as a bare literal', () => {
    // The trap the old test described has been sprung and closed. Two
    // places rebuilt `per` as {subtotal, markedUp}, dropping p86Pricing's
    // lockedSubtotal/lockedSell keys, and under a target margin that
    // silently discards every promised price. Both are gone; both now hand
    // the WHOLE `per` to the pipeline. Raw source: the stripper eats most
    // of this file.
    const EST = raw('js', 'estimate-editor.js');
    const rebuilds = EST.match(/= \{ subtotal: \w+\.subtotal, markedUp: applyTargetMargin\(/g) || [];
    expect(rebuilds).toHaveLength(0);
    // ...and neither site re-derives the target margin by hand any more.
    const byHand = EST.match(/markedUp: applyTargetMargin\(/g) || [];
    expect(byHand).toHaveLength(0);
  });

  test('resolveTargetMargin is the estimate resolver, and it is NOT resolveMarkedUp', () => {
    // The split exists for one reason: resolveMarkedUp additionally honours
    // a document `targetPrice`, and clientPriceRequested returns TRUE on an
    // estimate blob with no `alternates` key — the legacy arm both
    // computeEstimateTotals implementations still price. Pointing the
    // estimate call sites at resolveMarkedUp would have moved the estimate
    // lock while claiming to port a per-line field.
    expect(PIPELINE).toMatch(/function resolveTargetMargin\(per, rec\)/);
    expect(PIPELINE).toMatch(/resolveTargetMargin: resolveTargetMargin/);
    // resolveMarkedUp is now literally the typed-price branch in front of it.
    expect(PIPELINE).toMatch(/if \(cp && cp\.ok\) return cp\.markedUp;\s*\r?\n\s*return resolveTargetMargin\(p, rec\);/);
    // NO ESTIMATE MONEY PATH MAY CALL THE CLIENT-PRICE DOOR.
    //
    // ⚠ THE CALL SHAPE, ON RAW SOURCE — not the identifier, and not on
    // stripped source. Both of those were tried and both are wrong here:
    //   • the two-regex stripper at the top of this file keeps 36% of
    //     js/estimate-editor.js and 42% of estimate-totals.js, so a negative
    //     read through it passes for files it has eaten;
    //   • the bare identifier appears in the prose of four of these files,
    //     explaining WHY resolveTargetMargin is called instead. Forbidding
    //     the word would forbid the explanation.
    // `resolveMarkedUp(` is a call and prose does not write one.
    //
    // This is the SOURCE half. The half that matters — that a typed price
    // actually prices nothing on an estimate, at every alternate count and
    // with promised lines present — is arithmetic, and it is in
    // test/estimate-promised-price.test.js and
    // test/co-fees-decision-is-state.test.js.
    for (const rel of [['server', 'services', 'money', 'estimate-totals.js'],
      ['js', 'estimates.js'], ['js', 'estimate-preview.js'], ['js', 'bt-export.js'],
      ['js', 'estimate-editor.js']]) {
      const SRC = raw(...rel);
      // Non-vacuity: the file was read and it is the file we think it is.
      expect({ file: rel.join('/'), len: SRC.length > 2000 })
        .toEqual({ file: rel.join('/'), len: true });
      const calls = SRC.match(/resolveMarkedUp\s*\(/g) || [];
      expect({ file: rel.join('/'), calls }).toEqual({ file: rel.join('/'), calls: [] });
    }
  });

  test('EVERY estimate money module learned about the field — asserted, not assumed', () => {
    // The positive half. Each of these priced an estimate by a rule of its
    // own that could not see a promised price; each now reads the shared
    // pipeline. The regex per file names the SPECIFIC call that carries the
    // promise, not merely the word — a file could mention `unitSell` in a
    // comment and still price it wrong.
    const MUST = [
      // the browser list/convert/proposal-email total
      [['js', 'estimates.js'], /P\.resolveTargetMargin\(per, est\)/],
      // the server total (deal memory, the clickr import proof)
      [['server', 'services', 'money', 'estimate-totals.js'], /P\.resolveTargetMargin\(per, est\)/],
      // the editor's chip + per-group breakdown
      [['js', 'estimate-editor.js'], /_P\.resolveTargetMargin\(per, est\)/],
      // the proposal / takeoff document
      [['js', 'estimate-preview.js'], /_P\.resolveTargetMargin\(per, estimate\)/],
      // the Buildertrend export's formerly-forked cascade
      [['js', 'bt-export.js'], /P\(\)\.resolveTargetMargin\(P\(\)\.computeForLines\(estimate, group\), estimate\)/],
    ];
    // RAW source: see the note in the test above — the stripper eats these
    // files. Every pattern below is a CALL with its exact arguments, which
    // is not a shape prose produces, and none of the comments in this change
    // reproduces one. The proof that these calls also AGREE numerically is
    // test/estimate-promised-price.test.js.
    for (const [rel, re] of MUST) {
      const SRC = raw(...rel);
      expect({ file: rel.join('/'), wired: re.test(SRC) })
        .toEqual({ file: rel.join('/'), wired: true });
    }
  });

  test('every estimate ROW PAINT takes its price from the shared per-line rule', () => {
    // A total that carries the promise while the rows do not is the exact
    // shape that cost 2.52% of client-priced change orders a median of
    // $4,857.61 (see the header of decideClientPrice). These are the four
    // places an estimate paints a per-line or per-section price.
    const ED = raw('js', 'estimate-editor.js');
    expect(ED).toMatch(/_P\.lineMoney\(line, allLines, est\)/);   // the row
    expect(ED).toMatch(/_P\.lineMoney\(line, lines, est\)/);      // eeLineMath
    expect(ED).toMatch(/_P\.lineMoney\(L, lines, est\)/);         // section subtotal
    // bt-export prices each row against ITS OWN GROUP's slice, not every
    // included group concatenated. sectionHeaderFor walks backwards by
    // index with no boundary awareness, so the concatenation let a line
    // that leads its own group inherit the PREVIOUS group's last header —
    // an owner-facing Client Price the editor never showed. The negative
    // below pins the BOUNDARY rather than this spelling; the arithmetic
    // that a source pin cannot reach is in
    // test/estimate-promised-price.test.js section 2b.
    expect(raw('js', 'bt-export.js')).toMatch(/P\(\)\.lineMoney\(l, catMap\.byGroup\[l\.alternateId\], estimate\)/);
    expect(raw('js', 'bt-export.js')).not.toMatch(/lineMoney\(l, (orderedAll|catMap\.lines)/);
    expect(raw('js', 'estimate-preview.js')).toMatch(/_P\.promisedUnitSell\(line\)/);
    // The legacy preview modal in js/estimates.js is REACHABLE —
    // js/leads.js renders a Preview button that routes to it — so it is
    // held to the same rule as the rest.
    expect(raw('js', 'estimates.js')).toMatch(/_P\.lineMoney\(l, lineItems, estimate\)/);
    // The row paints must not have kept a second copy of the cascade.
    expect(ED).not.toMatch(/ext \* \(1 \+ effectiveMarkupForLine\(/);
    expect(raw('js', 'bt-export.js')).not.toMatch(/bc \* \(1 \+ pctMarkup \/ 100\)/);
  });

  test('the server AI context stopped hand-rolling the cascade', () => {
    const AI = raw('server', 'routes', 'ai-routes.js');
    expect(AI).toMatch(/require\('\.\.\/\.\.\/js\/pricing-pipeline\.js'\)/);
    expect(AI).toMatch(/pricing\.resolveTargetMargin\(groupPer, blob\)/);
    // The three shapes it used to compute by hand are gone.
    expect(AI).not.toMatch(/subtotal \+= qty \* cost \* \(1 \+ \(m \/ 100\)\)/);
    expect(AI).not.toMatch(/markedUp \+= \(qty \* uc\) \* \(1 \+ \(lineMarkup \/ 100\)\)/);
  });

  test('AN ASSEMBLY STILL MAY NOT MINT A PROMISED PRICE', () => {
    // UNCHANGED, and the one negative in this block that stays a negative.
    // server/services/estimate-lines.js explodes a costed recipe onto an
    // estimate; a recipe knows what something COSTS and can never know what
    // was promised for it. Comments stripped, because that file explains
    // the rule at length and a guard has to read code rather than the prose
    // forbidding the thing.
    const SRC = raw('server', 'services', 'estimate-lines.js');
    const CODE = stripJs(SRC);
    // Non-vacuity: the stripper keeps ~59% of THIS file and that is comments,
    // but it must not have eaten the thing being searched. If the export
    // block is gone the negative below proves nothing.
    expect(CODE).toMatch(/module\.exports/);
    expect({ file: 'server/services/estimate-lines.js', hit: /unitSell/.test(CODE) })
      .toEqual({ file: 'server/services/estimate-lines.js', hit: false });
    // And the prose that says why is still there to be read.
    expect(raw('server', 'services', 'estimate-lines.js'))
      .toMatch(/An assembly never writes `unitSell`/);
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

  test('coCompletion still reads coSellAmount and subtotal as OPAQUE SCALARS', () => {
    // The invariant, not the spelling: the completion clock is handed a
    // sell number and a cost number and never learns how either was
    // derived. Porting coSellAmount to resolveMarkedUp therefore changes
    // no field it reads. Deliberately NOT pinned to a particular line of
    // js/jobs.js — the one-clock port is actively reshaping this function,
    // and a guard that breaks on someone else's refactor is a guard that
    // gets deleted rather than heeded.
    const i = JOBS.indexOf('function coCompletion(');
    expect(i).toBeGreaterThan(-1);
    const body = JOBS.slice(i, i + 2000);
    expect(body).toMatch(/coSellAmount\(co\)/);
    expect(body).toMatch(/computeForLines\(co, lines\) \|\| \{\}\)\.subtotal/);
    // And it must not reach into the pricing model itself.
    expect(body).not.toMatch(/unitSell|resolveMarkedUp|applyTargetMargin|lineMoney/);
  });
});
