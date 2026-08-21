// One building comparator for the whole app — window.p86BuildingSort.
//
// THE BUG THIS EXISTS FOR
// -----------------------
// Fairways RV2008 showed its ten buildings as B2, B3, B4 … B10, B1. That is
// neither a string sort (B1, B10, B2 …) nor a natural sort (B1, B2 … B10): it
// is NO SORT AT ALL. appData.buildings is only ever appended to (js/app.js,
// js/jobs.js addBuilding, nodegraph/engine.js, and the orphan self-heal in
// nodegraph/ui.js), so a raw `.filter()` renders INSERTION ORDER — and B1 was
// re-traced on the map last, so B1 lands last. Several surfaces did exactly
// that raw filter; the CO allocation editor was one of them.
//
// Before this file the app carried FOUR different orders for one job's
// buildings: _bldgNumSort (js/jobs.js), bldgSort (js/pay-applications.js),
// insertion order (everything else), and a derived order for rider-CO G703
// lines. Two of them disagreed on the same job.
//
// WHY THIS SHAPE AND NOT A "BETTER" NATURAL SORT
// ----------------------------------------------
// This is bldgSort's algorithm, character for character, and that is a
// deliberate constraint rather than laziness: js/pay-applications.js deriveSOV
// orders a pay application's schedule-of-values lines with it. Adopting its
// exact shape makes deriveSOV a provable NO-OP — no G703's line order can move
// because a comparator was unified. (Frozen data.lines plus id-keyed `previous`
// carry-forward already protect an ISSUED application; this protects an
// uncertified draft's line order too.)
//
// It also survives a name like "Phase 2 Bldg 3", which _bldgNumSort mangled by
// stripping every non-digit and reading it as the number 23.
//
// KNOWN LIMIT, stated rather than hidden: two names whose skeletons differ only
// in a second number ("Building 2 East" vs "Building 10 West") fall through to
// localeCompare and read 10 before 2. Fixing that means a chunked natural sort,
// which is NOT a no-op against the pay-application order — so it is a separate,
// measured decision, not a side effect of this one.
//
// THE RULE THAT COMES WITH IT
// ---------------------------
// SORT AT THE PRESENTATION BOUNDARY. NEVER re-order an array that remainder
// math walks by index. Four distributions in this repo hand the last cent (or
// the last 0.01 of a percent) to whichever element the array happened to put
// first among equal remainders:
//
//   js/jobs.js recomputePhasePctAllocation   (±$1/building, writes the money
//                                             mirror asSoldRevenue /
//                                             asSoldPhaseBudget / phaseBudget)
//   js/jobs.js _p86DoSplitJobLevelScopes     (±$1/building, same mirror)
//   js/jobs.js distributeContractToPhases    (feeds the two above)
//   nodegraph/ui.js openCoAllocEditor save() (±0.01 percentage point, i.e.
//                                             sell/10,000 per building — $2.75
//                                             on a $27,500 CO, $100 on $1M)
//
// Sorting the array those read would silently move real dollars between
// buildings. So each of them keeps its own unsorted filter, and the surfaces
// that DISPLAY buildings take a sorted COPY. openCoAllocEditor holds both at
// once on purpose: `buildings` (unsorted) is the money array its
// largest-remainder tie-break walks, `buildingsView` is what the user reads.
(function () {
  'use strict';

  function p86BuildingSort(a, b) {
    var na = String((a && a.name) || ''), nb = String((b && b.name) || '');
    var ma = na.match(/\d+/), mb = nb.match(/\d+/);
    if (ma && mb && na.replace(/\d+/, '') === nb.replace(/\d+/, '')) return (+ma[0]) - (+mb[0]);
    return na.localeCompare(nb);
  }

  // Sorted COPY. Callers get a new array so the caller's own source array —
  // which may be the one a distribution walks by index — is never mutated.
  function p86SortBuildings(list) {
    return (Array.isArray(list) ? list.slice() : []).sort(p86BuildingSort);
  }

  if (typeof window !== 'undefined') {
    window.p86BuildingSort = p86BuildingSort;
    window.p86SortBuildings = p86SortBuildings;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = { p86BuildingSort: p86BuildingSort, p86SortBuildings: p86SortBuildings };
  }
})();
