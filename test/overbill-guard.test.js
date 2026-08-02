// test/overbill-guard.test.js — the over-billing guard (KNOWN_ISSUES INT-4).
//
// A vendor bill's amount had no enforced relationship to the PO it bills
// against, so a sub could be paid past their commitment and nothing said
// so. The PO editor already *showed* billed-vs-total; it just never
// stopped anyone.
//
// The authorizing figure is poEffectiveTotal() — the committed total
// (frozen baseline + APPROVED addendum deltas), NOT the raw line sum. A
// PO under revision carries unapproved pending changes, and billing
// against a price nobody approved is the hole this closes. That part is
// pinned in poEffectiveTotal's own coverage; here we pin the decision.

// Imported from the money service, NOT the route: requiring bill-routes
// pulls in auth.js, which hard-fails without a valid JWT_SECRET (A1). A
// pure money-math test must not depend on the environment having one.
const { overbillVerdict } = require('../server/services/money/overbill');
const { poEffectiveTotal } = require('../server/services/job-financials');

describe('overbillVerdict', () => {
  test('allows a bill that lands exactly on the PO total', () => {
    expect(overbillVerdict(10000, 7500, 2500)).toBeNull();
  });

  test('allows a partial draw', () => {
    expect(overbillVerdict(10000, 0, 2500)).toBeNull();
  });

  test('blocks a bill that pushes past the PO, and shows the arithmetic', () => {
    const v = overbillVerdict(10000, 9000, 2500);
    expect(v).not.toBeNull();
    expect(v.code).toBe('OVERBILL');
    expect(v.po_total).toBe(10000);
    expect(v.already_billed).toBe(9000);
    expect(v.this_bill).toBe(2500);
    expect(v.would_total).toBe(11500);
    expect(v.over_by).toBe(1500);
  });

  test('a single bill larger than the whole PO is blocked', () => {
    const v = overbillVerdict(5000, 0, 7500);
    expect(v).not.toBeNull();
    expect(v.over_by).toBe(2500);
  });

  // Float noise must not manufacture an overage: 0.1 + 0.2 > 0.3 in IEEE754.
  test('sub-cent float noise does not trip the guard', () => {
    expect(overbillVerdict(0.3, 0.1, 0.2)).toBeNull();
  });

  test('a penny over is still over', () => {
    const v = overbillVerdict(1000, 1000, 0.02);
    expect(v).not.toBeNull();
    expect(v.over_by).toBeCloseTo(0.02, 2);
  });

  // An unpriced PO has no ceiling — blocking every bill against a PO whose
  // lines aren't filled in yet would make the guard the problem.
  test('a $0 or unpriced PO authorizes nothing and never blocks', () => {
    expect(overbillVerdict(0, 0, 5000)).toBeNull();
    expect(overbillVerdict(null, 0, 5000)).toBeNull();
    expect(overbillVerdict(undefined, 0, 5000)).toBeNull();
  });

  test('a credit/negative bill can never trip the guard', () => {
    expect(overbillVerdict(10000, 10000, -500)).toBeNull();
  });
});

// The guard is only as good as the number it compares against. These pin
// that "the PO total" means the COMMITTED total — the same figure the
// rest of the money stack uses — so a PO mid-revision can't authorize
// billing against a price nobody approved.
describe('overbillVerdict × poEffectiveTotal — the authorizing figure', () => {
  const lines = [{ qty: 10, unitCost: 100 }];   // raw line sum = 1000

  test('a never-locked PO authorizes its raw line sum', () => {
    const po = { lines };
    expect(poEffectiveTotal(po)).toBe(1000);
    expect(overbillVerdict(poEffectiveTotal(po), 0, 1000)).toBeNull();
  });

  test('PENDING (unapproved) addendum does NOT raise the ceiling', () => {
    // Lines were revised up to 1500, but the addendum is still pending.
    const po = {
      lines: [{ qty: 15, unitCost: 100 }],
      baselineTotal: 1000,
      addendums: [{ status: 'pending', delta: 500 }]
    };
    expect(poEffectiveTotal(po)).toBe(1000);   // NOT 1500
    const v = overbillVerdict(poEffectiveTotal(po), 0, 1500);
    expect(v).not.toBeNull();
    expect(v.over_by).toBe(500);
  });

  test('an APPROVED addendum does raise the ceiling', () => {
    const po = {
      lines: [{ qty: 15, unitCost: 100 }],
      baselineTotal: 1000,
      addendums: [{ status: 'approved', delta: 500 }]
    };
    expect(poEffectiveTotal(po)).toBe(1500);
    expect(overbillVerdict(poEffectiveTotal(po), 0, 1500)).toBeNull();
  });

  test('section-header rows are not priced into the ceiling', () => {
    const po = { lines: [{ section: '__section_header__', qty: 99, unitCost: 99 }, ...lines] };
    expect(poEffectiveTotal(po)).toBe(1000);
  });
});
