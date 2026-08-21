/**
 * @jest-environment jsdom
 */
// ONE building comparator — and proof that unifying it moved NO money.
//
// The bug: Fairways RV2008 CO-0001 listed its ten buildings B2, B3 … B10, B1.
// Not a string sort, not a natural sort — NO sort. appData.buildings is
// append-only, so a raw `.filter()` renders insertion order, and B1 was traced
// on the map last.
//
// The hazard in fixing it: four distributions in this repo hand the last cent
// (or the last hundredth of a percent) to whichever element the array put first
// among EQUAL remainders. Sorting one of those arrays silently moves real
// dollars between buildings. So the two halves of this file are:
//
//   1. the comparator sorts naturally, and every surface uses THE SAME ONE
//   2. every order-sensitive money distribution still walks an UNSORTED array,
//      and its output is byte-identical to what it produced before
//
// Both halves matter. Half 1 alone is the change John asked for; half 2 alone
// is what stops it being a money bug wearing a rendering commit's clothes.

const fs = require('fs');
const path = require('path');
const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const stripJs = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
const code = (...p) => stripJs(read(...p));

const { p86BuildingSort, p86SortBuildings } = require('../js/building-sort.js');

const names = (list) => list.map((b) => b.name);
const mk = (...ns) => ns.map((n, i) => ({ id: 'b' + i, name: n }));

// ══ 1. THE COMPARATOR ══════════════════════════════════════════════════════

describe('the order John actually saw, and the two wrong answers', () => {
  // Fairways' stored order, exactly as the screenshot reads it.
  const FAIRWAYS = mk('B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10', 'B1');

  test('B2…B10, B1 becomes B1…B10', () => {
    expect(names(p86SortBuildings(FAIRWAYS)))
      .toEqual(['B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8', 'B9', 'B10']);
  });

  test('it is NOT a plain string sort — that is the answer that puts B10 second', () => {
    const stringSorted = names(FAIRWAYS.slice()).sort();
    expect(stringSorted[1]).toBe('B10');
    expect(names(p86SortBuildings(FAIRWAYS))[1]).toBe('B2');
  });

  test('it is NOT the raw insertion order the modal used to render', () => {
    expect(names(p86SortBuildings(FAIRWAYS))).not.toEqual(names(FAIRWAYS));
  });
});

describe('the comparator itself', () => {
  test('numbers compare numerically when the surrounding text matches', () => {
    expect(names(p86SortBuildings(mk('Building 10', 'Building 2', 'Building 1'))))
      .toEqual(['Building 1', 'Building 2', 'Building 10']);
  });

  test('a name with two numbers is not collapsed into one — the _bldgNumSort bug', () => {
    // The retired local comparator stripped EVERY non-digit: "Phase 2 Bldg 3"
    // parsed as 23 and "Phase 1 Bldg 4" as 14, so Phase 1 Bldg 4 sorted after
    // Phase 2 Bldg 3's siblings. Reproduce the old rule and show it disagrees.
    const oldSort = (a, b) => {
      const na = parseInt(String(a.name || '').replace(/\D/g, ''), 10);
      const nb = parseInt(String(b.name || '').replace(/\D/g, ''), 10);
      if (!isNaN(na) && !isNaN(nb) && na !== nb) return na - nb;
      return String(a.name || '').localeCompare(String(b.name || ''));
    };
    // Where the digit-strip genuinely inverts the answer: "Phase 1 Bldg 10"
    // strips to 110, "Phase 2 Bldg 3" to 23, so the old rule put Phase 2 first.
    const bad = mk('Phase 1 Bldg 10', 'Phase 2 Bldg 3');
    expect(names(bad.slice().sort(oldSort))).toEqual(['Phase 2 Bldg 3', 'Phase 1 Bldg 10']);
    expect(names(p86SortBuildings(bad))).toEqual(['Phase 1 Bldg 10', 'Phase 2 Bldg 3']);
  });

  test('THE KNOWN LIMIT, asserted rather than hidden', () => {
    // Two names whose text differs only AFTER a second number fall through to
    // localeCompare, and localeCompare reads "10" before "9". This is inherited
    // from the pay-application comparator on purpose: the shared one adopted
    // that algorithm character for character so no schedule of values could be
    // re-ordered by unifying it. Fixing this needs a chunked natural sort, which
    // is NOT a no-op against the G703 — a separate, measured decision.
    expect(names(p86SortBuildings(mk('Bldg 9 Unit 1', 'Bldg 10'))))
      .toEqual(['Bldg 10', 'Bldg 9 Unit 1']);
    // The case that actually matters — one number, matching text — is right:
    expect(names(p86SortBuildings(mk('Bldg 10', 'Bldg 9')))).toEqual(['Bldg 9', 'Bldg 10']);
  });

  test('un-numbered names fall back to locale order, and missing names do not throw', () => {
    expect(names(p86SortBuildings(mk('Clubhouse', 'Amenity', 'Pool'))))
      .toEqual(['Amenity', 'Clubhouse', 'Pool']);
    expect(() => p86SortBuildings([{ id: 'x' }, null, { id: 'y', name: 'B1' }])).not.toThrow();
  });

  test('it returns a COPY — the caller\'s array is never re-ordered under it', () => {
    const src = mk('B2', 'B1');
    const out = p86SortBuildings(src);
    expect(names(src)).toEqual(['B2', 'B1']);
    expect(out).not.toBe(src);
  });

  test('a non-array is a safe empty list, not a crash', () => {
    expect(p86SortBuildings(undefined)).toEqual([]);
    expect(p86SortBuildings(null)).toEqual([]);
  });
});

// ══ 2. THE PAY APPLICATION DOES NOT MOVE ═══════════════════════════════════

describe('a schedule of values cannot be re-ordered by unifying a comparator', () => {
  // deriveSOV ordered its lines with a LOCAL bldgSort. The shared comparator
  // adopted that algorithm character for character precisely so this stays a
  // no-op. Reproduce the retired local version and prove they agree on a corpus
  // wide enough to catch a divergence.
  const payAppLocal = (a, b) => {
    const na = String(a.name || ''), nb = String(b.name || '');
    const ma = na.match(/\d+/), mb = nb.match(/\d+/);
    if (ma && mb && na.replace(/\d+/, '') === nb.replace(/\d+/, '')) return (+ma[0]) - (+mb[0]);
    return na.localeCompare(nb);
  };
  const CORPUS = [
    'B1', 'B2', 'B10', 'B9', 'B12A', 'Building 3', 'Building 30', 'Clubhouse',
    'Amenity Center', 'Bldg 9 Unit 1', 'Bldg 10', 'Phase 2 Bldg 3', '7', '70',
    'Pool House', 'b4', 'B4', '', 'Garage 2', 'Garage 11',
  ];

  test('the shared comparator agrees with the retired pay-application one on every pair', () => {
    for (const x of CORPUS) {
      for (const y of CORPUS) {
        const a = { name: x }, b = { name: y };
        expect(Math.sign(p86BuildingSort(a, b))).toBe(Math.sign(payAppLocal(a, b)));
      }
    }
  });

  test('and on the whole corpus sorted at once', () => {
    const set = CORPUS.map((n, i) => ({ id: 'b' + i, name: n }));
    expect(names(p86SortBuildings(set))).toEqual(names(set.slice().sort(payAppLocal)));
  });

  test('pay-applications.js delegates rather than keeping a second copy', () => {
    const SRC = code('js', 'pay-applications.js');
    expect(SRC).toMatch(/function bldgSort\(a, b\) \{\s*return window\.p86BuildingSort\(a, b\);\s*\}/);
    // The old body is gone — no second algorithm to drift.
    expect(SRC).not.toMatch(/na\.replace\(\/\\d\+\/, ''\) === nb\.replace/);
  });
});

// ══ 3. NO ALLOCATION MOVES ═════════════════════════════════════════════════
//
// The four order-sensitive distributions, checked as CODE. Each must keep
// reading an UNSORTED filter; a sorted array reaching any of them is the
// failure this whole section exists to catch.

describe('every remainder distribution still walks an unsorted array', () => {
  const JOBS = code('js', 'jobs.js');
  const NG = code('nodegraph', 'ui.js');

  const between = (src, startRe, endRe) => {
    const i = src.search(startRe);
    expect(i).toBeGreaterThan(-1);
    const rest = src.slice(i);
    const j = rest.search(endRe);
    return j > -1 ? rest.slice(0, j) : rest;
  };

  test('phasePctShares — feeds recomputePhasePctAllocation\'s ±$1 tie-break', () => {
    const body = between(JOBS, /function phasePctShares\(/, /\n {8}function /);
    expect(body).toMatch(/var buildings = \(appData\.buildings \|\| \[\]\)\.filter\(function\(b\) \{ return b\.jobId === jobId; \}\);/);
    expect(body).not.toMatch(/p86SortBuildings|p86BuildingSort|_bldgNumSort/);
  });

  test('recomputePhasePctAllocation still breaks ties by array index, unchanged', () => {
    const body = between(JOBS, /function recomputePhasePctAllocation\(/, /\n {8}function /);
    // The tie-break: a STABLE sort by fractional remainder, so equal remainders
    // keep phasePctShares' order. That is the behaviour being preserved.
    expect(body).toMatch(/\.sort\(function\(a, b\) \{ return \(b\.exact - b\.base\) - \(a\.exact - a\.base\); \}\)/);
    expect(body).toMatch(/forEach\(function\(p, i\) \{ if \(i < rem\) p\.dollars \+= 1; \}\)/);
    expect(body).not.toMatch(/p86SortBuildings|p86BuildingSort/);
  });

  test('spreadPhaseCore and distributeContractToPhases stay unsorted', () => {
    const spread = between(JOBS, /function spreadPhaseCore\(/, /\n {8}function /);
    expect(spread).toMatch(/var buildings = \(appData\.buildings \|\| \[\]\)\.filter\(function\(b\) \{ return b\.jobId === jobId; \}\);/);
    expect(spread).not.toMatch(/p86SortBuildings|p86BuildingSort/);

    const dist = between(JOBS, /function distributeContractToPhases\(/, /\n {8}function /);
    expect(dist).toMatch(/var bldgIds = \(appData\.buildings \|\| \[\]\)\.filter\(function\(b\) \{ return b\.jobId === jobId; \}\)\.map/);
    expect(dist).not.toMatch(/p86SortBuildings|p86BuildingSort/);
  });

  test('_p86DoSplitJobLevelScopes — ±$1/building through the money mirror — stays unsorted', () => {
    const caller = between(JOBS, /function p86SplitJobLevelScopes\(/, /window\.p86SplitJobLevelScopes/);
    expect(caller).toMatch(/var buildings = \(appData\.buildings \|\| \[\]\)\.filter\(function \(b\) \{ return b\.jobId === jobId; \}\);/);
    expect(caller).not.toMatch(/p86SortBuildings|p86BuildingSort/);
    // splitLR's largest-remainder pass is index-tie-broken and writes
    // setPhaseDollar, i.e. asSoldRevenue / asSoldPhaseBudget / phaseBudget.
    const doer = between(JOBS, /function _p86DoSplitJobLevelScopes\(/, /window\.p86SplitJobLevelScopes = /);
    expect(doer).toMatch(/res\[idx\[k % res\.length\]\.i\] \+= 1/);
    expect(doer).toMatch(/setPhaseDollar\(rec, slices\[i\]\)/);
  });

  test('the CO allocation editor holds an unsorted money array and a sorted view', () => {
    const body = between(NG, /function openCoAllocEditor\(/, /\nfunction [a-zA-Z]/);
    // The money array — insertion order, exactly as before.
    expect(body).toMatch(/var buildings=\(appData\.buildings\|\|\[\]\)\.filter\(function\(b\)\{ return b\.jobId===jid; \}\);/);
    // The view — sorted, used only to render.
    expect(body).toMatch(/var buildingsView=window\.p86SortBuildings\(buildings\);/);
    // save() must pick from the UNSORTED array. Its largest-remainder pass
    // adds 0.01 of a percentage point — sell/10,000 per building, i.e. $2.75
    // on Fairways' $27,500 CO — to whichever elements come first.
    const save = between(body, /function save\(\)\{/, /\n {2}paint\(\);/);
    expect(save).toMatch(/var picked=buildings\.filter\(/);
    expect(save).not.toMatch(/buildingsView/);
    expect(save).toMatch(/floors\[order\[k\]\.i\]\+=1/);
  });

  test('every render inside that editor uses the view, so the user sees B1 first', () => {
    const body = between(NG, /function openCoAllocEditor\(/, /\nfunction [a-zA-Z]/);
    expect(body).toMatch(/preview=buildingsView\.filter\(/);   // rides-a-scope table
    expect(body).toMatch(/var chips=buildingsView\.map\(/);    // its-own-scope chips
    expect(body).toMatch(/var rows=buildingsView\.map\(/);     // its-own-scope rows
  });
});

// ══ 4. EVERY SURFACE, ONE ORDER ════════════════════════════════════════════

describe('the surfaces that LIST buildings all share the comparator', () => {
  test('js/jobs.js keeps one alias and it delegates', () => {
    const SRC = code('js', 'jobs.js');
    expect(SRC).toMatch(/function _bldgNumSort\(a, b\) \{\s*return window\.p86BuildingSort\(a, b\);\s*\}/);
    // The digit-stripping body is gone.
    expect(SRC).not.toMatch(/parseInt\(String\(a\.name \|\| ''\)\.replace\(\/\\D\/g, ''\), 10\)/);
  });

  test.each([
    ['job overview building tiles', 'js/jobs.js', /renderJobBuildings\(jobId, hostId\) \{[\s\S]{0,200}?\.sort\(_bldgNumSort\)/],
    ['scope matrix', 'js/jobs.js', /renderPhaseMatrixInto[\s\S]{0,600}?\.sort\(_bldgNumSort\)/],
    ['scope allocation editor', 'js/jobs.js', /renderPhaseAllocEditorInto[\s\S]{0,400}?\.sort\(_bldgNumSort\)/],
    ['scope modal building picker', 'js/jobs.js', /window\.p86SortBuildings\(appData\.buildings\.filter\(b => b\.jobId === appState\.currentJobId\)\)/],
    ['WIP snapshot detail', 'js/jobs.js', /window\.p86SortBuildings\(appData\.buildings\.filter\(b => b\.jobId === jobId\)\)/],
    ['G703 schedule of values', 'js/pay-applications.js', /\.slice\(\)\.sort\(bldgSort\)/],
    ['Site Plan contract-allocation board', 'nodegraph/ui.js', /var blds=window\.p86SortBuildings\(/],
    ['workspace cell-link targets', 'js/workspace.js', /var buildings = window\.p86SortBuildings\(/],
    ['QB cost attribution dropdown', 'js/qb-costs-view.js', /window\.p86SortBuildings\(list\)/],
    ['job audit findings', 'js/job-audit.js', /buildings = window\.p86SortBuildings\(buildings\)/],
  ])('%s', (_label, file, re) => {
    expect(code(...file.split('/'))).toMatch(re);
  });

  test('the comparator loads before every one of its callers', () => {
    const HTML = read('index.html');
    const at = (f) => HTML.indexOf('src="' + f);
    const self = at('js/building-sort.js');
    expect(self).toBeGreaterThan(-1);
    for (const dep of ['js/jobs.js', 'js/pay-applications.js', 'js/job-audit.js',
      'js/workspace.js', 'js/qb-costs-view.js', 'nodegraph/ui.js']) {
      expect(at(dep)).toBeGreaterThan(self);
    }
  });

  test('it is cache-busted like every other js file', () => {
    expect(read('index.html')).toMatch(/src="js\/building-sort\.js\?v=\d/);
  });
});
