// The wiring, as CODE — the endpoint's guards, the two screens, and the
// propagation that stops a scope rename orphaning a rider change order.
//
// js/co-draw.js proves the math. This proves the math is actually reached, by
// the same file, from both sides of the client/server line — and that nothing
// on the way in bypasses a guard.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = (...p) => stripJs(read(...p));

const CO_ROUTES = code('server', 'routes', 'change-order-routes.js');
const PO_ROUTES = code('server', 'routes', 'purchase-order-routes.js');
const NG = code('nodegraph', 'ui.js');
const JOBS = code('js', 'jobs.js');
const POED = code('js', 'purchase-order-editor.js');
const AUDIT = code('js', 'job-audit.js');
const HTML = read('index.html');

const section = (src, startRe, endRe) => {
  const i = src.search(startRe);
  expect(i).toBeGreaterThan(-1);
  const rest = src.slice(i);
  const j = rest.slice(1).search(endRe);
  return j > -1 ? rest.slice(0, j + 1) : rest;
};

// ══ ONE IMPLEMENTATION, TWO TARGETS ════════════════════════════════════════

describe('the client and the server run the SAME cost-source code', () => {
  test('the module is dual-target, like js/pricing-pipeline.js', () => {
    const SRC = code('js', 'co-draw.js');
    expect(SRC).toMatch(/if \(typeof window !== 'undefined'\) window\.p86CoDraw = api;/);
    expect(SRC).toMatch(/if \(typeof module !== 'undefined' && module\.exports\) module\.exports = api;/);
    expect(SRC).not.toMatch(/document\.|window\.appData/);   // no DOM dependency
  });

  test('the route requires that very file — not a server-side second copy', () => {
    expect(CO_ROUTES).toMatch(/require\('\.\.\/\.\.\/js\/co-draw'\)/);
    expect(fs.existsSync(path.join(__dirname, '..', 'server', 'services', 'money', 'co-draw.js'))).toBe(false);
  });

  test('the browser loads it before the CO editor and the job audit', () => {
    const at = (f) => HTML.indexOf('src="' + f);
    expect(at('js/co-draw.js')).toBeGreaterThan(-1);
    expect(at('nodegraph/ui.js')).toBeGreaterThan(at('js/co-draw.js'));
    expect(at('js/job-audit.js')).toBeGreaterThan(at('js/co-draw.js'));
    expect(HTML).toMatch(/src="js\/co-draw\.js\?v=\d/);
  });
});

// ══ THE ENDPOINT ═══════════════════════════════════════════════════════════

describe('POST /change-orders/:id/cost-source', () => {
  const R = section(CO_ROUTES, /router\.post\('\/change-orders\/:id\/cost-source'/, /^router\./m);

  test('capability-gated the same as every other CO write', () => {
    expect(R).toMatch(/requireAuth, requireCapability\('ESTIMATES_EDIT'\)/);
  });

  test('org-scoped THROUGH THE JOB JOIN — never by id alone', () => {
    expect(R).toMatch(/JOIN jobs j ON j\.id = co\.job_id/);
    expect(R).toMatch(/j\.organization_id = \$2 OR j\.organization_id IS NULL/);
  });

  test('an APPLIED change order is frozen', () => {
    expect(R).toMatch(/cur\.status === 'applied'/);
    expect(R).toMatch(/409/);
  });

  test('a sub is proved to be OURS, like po.sub_id is', () => {
    expect(R).toMatch(/subInOrg\(pool, subId, req\.user\.organization_id\)/);
    expect(R).toMatch(/Subcontractor not found/);
  });

  test('candidate POs are read from THE JOB, so a draw cannot name another job\'s PO', () => {
    expect(R).toMatch(/FROM job_purchase_orders WHERE job_id = \$1/);
  });

  test('the CO\'s cost comes from the SAME pricing pipeline, not a re-sum of lines', () => {
    expect(R).toMatch(/jobMoney\.changeOrderMoney\(data\)\.costs/);
  });

  test('validation runs and a failure is a 422 carrying the reason', () => {
    expect(R).toMatch(/coDraw\.validateCostSource\(req\.body \|\| \{\}, \{ pos: posQ\.rows, coCost \}\)/);
    expect(R).toMatch(/res\.status\(422\)\.json\(\{ error: errs\[0\], errors: errs \}\)/);
  });

  test('the payload is re-normalized rather than trusted', () => {
    expect(R).toMatch(/coDraw\.normalizeDraws\(/);
  });

  test('it writes exactly THREE keys — it cannot clobber the CO\'s line items', () => {
    const writes = R.match(/^\s+data\.\w+ = /gm) || [];
    expect(writes.map((s) => s.trim())).toEqual(['data.costSource =', 'data.subId =', 'data.costDraws =']);
    expect(R).not.toMatch(/data\.lines/);
  });

  test('a non-PO source stores NO draws', () => {
    expect(R).toMatch(/costSource === 'po'\s*\?\s*coDraw\.normalizeDraws\([\s\S]*?\)\s*:\s*\[\]/);
  });
});

// ══ THE PO -> SCOPE LINK, THE PREREQUISITE ═════════════════════════════════

describe('"whichever PO is attached to that scope" now has something to read', () => {
  test('the PO editor has a Scope selector writing data.phaseName', () => {
    expect(POED).toMatch(/<select id="po-f-phase"/);
    expect(POED).toMatch(/_po\.phaseName = phaseSel\.value \|\| '';/);
    expect(POED).toMatch(/phaseName: _po\.phaseName \|\| ''/);
  });

  test('it offers only scopes that exist on THIS job', () => {
    expect(POED).toMatch(/if \(!p \|\| p\.jobId !== _po\.job_id\) return;/);
  });

  test('a stored scope that has since vanished still SHOWS, marked missing', () => {
    expect(POED).toMatch(/\(missing\)/);
  });

  test('phaseName is NOT the contract-prose textarea', () => {
    // data.scope is the Scope of Work & Terms the sub signs. Two different
    // things that both got called "scope".
    expect(POED).toMatch(/<textarea id="po-f-scope"/);
    expect(POED).toMatch(/bindInput\('po-f-scope', function \(v\) \{ _po\.scope = v; \}\)/);
  });

  test('the server lets this ONE key through a locked PO, and nothing else new', () => {
    const put = section(PO_ROUTES, /router\.put\('\/purchase-orders\/:id'/, /^router\./m);
    const lockedBranch = section(put, /if \(locked\) \{/, /\} else \{/);
    expect(lockedBranch).toMatch(/data\.internalNotes = clean\.internalNotes/);
    expect(lockedBranch).toMatch(/data\.phaseName = clean\.phaseName/);
    // Contract fields stay frozen.
    expect(lockedBranch).not.toMatch(/data\.lines|data\.scope =|data\.title/);
  });

  test('cleanPoData still strips every server-owned e-sign key', () => {
    // phaseName rides in through the blob, so the keys that must NEVER arrive
    // that way — the frozen baseline, the addendum ledger, the sub's signature
    // — have to still be stripped. This is the e-sign-wipe guard.
    expect(code('server', 'services', 'job-financials.js'))
      .toMatch(/'baselineTotal', 'addendums', 'acceptance', 'revising'/);
  });
});

// ══ SCOPE RENAME PROPAGATION ═══════════════════════════════════════════════

describe('renaming a scope no longer orphans its riders', () => {
  const P = section(JOBS, /function p86PropagateScopeRename\(/, /^\s{8}window\.p86PropagateScopeRename/m);

  test('it carries the name onto rider COs and scope-linked POs', () => {
    expect(P).toMatch(/c\.data\.riderScopeName = newName/);
    expect(P).toMatch(/po\.data\.phaseName = newName/);
  });

  test('only RIDER change orders on THIS job with THIS scope', () => {
    expect(P).toMatch(/if \(mode !== 'rider' \|\| String\(scope\)\.trim\(\) !== oldName\) return;/);
    expect(P).toMatch(/if \(!c \|\| c\.job_id !== jobId\) return;/);
  });

  test('a no-op rename is a no-op', () => {
    expect(P).toMatch(/if \(!oldName \|\| !newName \|\| oldName === newName\) return;/);
  });

  test('it persists both sides, not just the local mirror', () => {
    expect(P).toMatch(/p86Api\.changeOrders\.setAllocations\(/);
    expect(P).toMatch(/p86Api\.purchaseOrders\.update\(po\.id, \{ phaseName: newName \}\)/);
  });

  test('both rename paths call it', () => {
    expect(JOBS).toMatch(/p86PropagateScopeRename\(jobId, _priorScope, phase\.phase\)/);  // saveManagedPhase
    expect(JOBS).toMatch(/p86PropagateScopeRename\(jobId, _priorScope, newName\)/);       // mergePhaseGroup
  });
});

// ══ THE SILENT DROP, MADE LOUD ═════════════════════════════════════════════

describe('a rider change order whose scope is gone', () => {
  test('coCompletion REPORTS it and deliberately does not paper over it', () => {
    expect(JOBS).toMatch(/riderScopeMissing: !cells\.length,/);
    // No fallback to the job's percent: restoring the revenue would move
    // displayProfit and displayMargin on every job whose rider scope was ever
    // renamed, invisibly, inside a feature commit.
    const rider = section(JOBS, /if \(mode === 'rider'\) \{/, /if \(mode === 'standalone'\)/);
    expect(rider).not.toMatch(/jobPct|p86Progress\.jobPct/);
  });

  test('the CO editor says so on screen', () => {
    expect(NG).toMatch(/comp&&comp\.riderScopeMissing/);
    expect(NG).toMatch(/no longer exists on this job/);
  });

  test('the job audit says so too (R11)', () => {
    expect(AUDIT).toMatch(/Change order rides a scope that is gone/);
    expect(AUDIT).toMatch(/severity: 'high'/);
  });
});

// ══ THE CO EDITOR'S COSTS BLOCK ════════════════════════════════════════════

describe('the change-order editor gained the COSTS half', () => {
  const EDITOR = section(NG, /function openCoAllocEditor\(/, /^function [a-zA-Z]/m);

  test('the header now names both halves', () => {
    expect(EDITOR).toMatch(/choose how it EARNS and what its cost DRAWS AGAINST/);
  });

  test('a sub can be named in BOTH modes — the block is outside the mode branch', () => {
    // costsBlock() is appended after `mid`, which is the only mode-dependent
    // half. Rides-a-scope and its-own-scope both get it.
    expect(EDITOR).toMatch(/\+mid\s*\n\s*\+costsBlock\(\)/);
    expect(EDITOR).toMatch(/<select id="caeSub"/);
  });

  test('three explicit cost sources and NO default', () => {
    expect(EDITOR).toMatch(/\['po','self','unfunded'\]/);
    expect(EDITOR).toMatch(/is not classified yet\. Pick one/);
  });

  test('an extend-the-PO draw must name an APPROVED addendum of the same amount', () => {
    expect(EDITOR).toMatch(/Math\.abs\(Number\(a\.delta\|\|0\)-coCost\)<0\.005/);
    expect(EDITOR).toMatch(/No addendum on that PO is/);
  });

  test('it NEVER drives the PO — no unlock, no addendum, no e-sign from here', () => {
    const costs = section(EDITOR, /function costsBlock\(\)\{/, /^ {2}var ov=/m);
    expect(costs).not.toMatch(/purchaseOrders\.(unlock|addendum|relock|setStatus)/);
    expect(EDITOR).toMatch(/this screen never drives it for you/);
  });

  test('the "within the PO" trap is stated rather than discovered later', () => {
    // revisedEstCosts already added co.costs, so a `within` draw on work that
    // was genuinely ADDED drops the revised margin for cost the PO does not
    // carry.
    expect(EDITOR).toMatch(/the revised margin drops for cost the PO does not carry/);
  });

  test('the two-PO-totals disagreement is surfaced on the CO, not hidden', () => {
    expect(EDITOR).toMatch(/they will not agree until the addendum is approved/);
  });

  test('the cost classification writes through its OWN endpoint', () => {
    expect(EDITOR).toMatch(/p86Api\.changeOrders\.setCostSource\(c\.id, costPayload\)/);
    expect(EDITOR).toMatch(/setAllocations\(c\.id, allocations, opts\)/);
  });

  test('only live purchase orders are offered', () => {
    expect(EDITOR).toMatch(/p\.status!=='draft'&&p\.status!=='cancelled'&&p\.status!=='void'/);
  });

  test('POs are fetched before the draw state is asserted', () => {
    // Otherwise every draw would render "missing-po" on first paint — a wrong
    // state, shown confidently.
    expect(EDITOR).toMatch(/function ensurePOs\(\)/);
    expect(EDITOR).toMatch(/loadPurchaseOrdersForJob\(jid\)/);
  });
});

// ══ THE AUDIT RULES THAT REPORT WHAT THIS DOES NOT REPAIR ══════════════════

describe('what is reported rather than silently fixed', () => {
  test('R12 — change-order cost with no commitment behind it', () => {
    expect(AUDIT).toMatch(/Uncommitted change-order cost/);
    expect(AUDIT).toMatch(/CD\.jobCoCostCoverage\(cos, pos, costOf\)/);
  });

  test('R12 reports UNCLASSIFIED separately and quietly — every existing CO is one', () => {
    expect(AUDIT).toMatch(/of change-order cost is not classified/);
    expect(AUDIT).toMatch(/severity: 'low'/);
  });

  test('R13 — draft bills netted out of accrual and counted as nothing', () => {
    // poBilled excludes only 'void'; billedCostOf excludes five statuses.
    // Reconciling the filters moves money on every job holding such a bill, so
    // it is named here, not repaired inside a change-order commit.
    expect(AUDIT).toMatch(/netted out of accrual but counted nowhere/);
    expect(AUDIT).toMatch(/DEAD_FOR_ACTUAL = \{ draft: 1, cancelled: 1, canceled: 1, rejected: 1 \}/);
  });
});

// ══ NOTHING ELSE MOVED ═════════════════════════════════════════════════════

describe('the blast radius stayed inside the feature', () => {
  test('the allocations endpoint still writes exactly its own three keys', () => {
    const A = section(CO_ROUTES, /router\.post\('\/change-orders\/:id\/allocations'/, /^router\./m);
    const writes = (A.match(/^\s+data\.\w+ = /gm) || []).map((s) => s.trim());
    expect(writes).toEqual(['data.buildingAllocations =', 'data.completionMode =', 'data.riderScopeName =']);
  });

  test('no accrual function anywhere learned about draws', () => {
    for (const src of [code('server', 'services', 'money', 'job-wip.js'),
      code('server', 'services', 'money', 'change-order-totals.js')]) {
      expect(src).not.toMatch(/costDraws|costSource|coDraw/);
    }
  });

  test('poAccruedOf and getJobPOAccrued are untouched by this feature', () => {
    expect(code('server', 'services', 'money', 'job-wip.js'))
      .toMatch(/const earned = poOrderedTotal\(po\) \* \(jobPct \/ 100\);/);
    expect(JOBS).toMatch(/var earned = poRowTotal\(po\) \* \(jobPct \/ 100\);/);
  });

  test('the fuzzy PO-title match stays a display chip and never decides money', () => {
    const acc = section(JOBS, /function getJobPOAccrued\(jobId\) \{/, /window\.getJobPOAccrued/);
    // It still attributes to byPhase (a chip) and the TOTAL is summed before
    // any matching happens.
    expect(acc).toMatch(/total \+= open;/);
    const totalAt = acc.indexOf('total += open;');
    const hayAt = acc.indexOf('var hay =');
    expect(hayAt).toBeGreaterThan(totalAt);
  });
});
