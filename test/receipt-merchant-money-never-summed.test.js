// A RECEIPT DOLLAR AND A QUICKBOOKS DOLLAR ARE NOT TWO DOLLARS.
//
// John photographs a Home Depot receipt in September. In October that same
// purchase arrives again on the QuickBooks export. SAME DOLLAR, TWICE. So the
// server returns qb_amount and receipt_amount as SEPARATE fields and computes
// no total, the headline block on the merchant card prints them on separate
// lines, and the card says out loud that they are not added together.
//
// The variants row — the list of spellings under each merchant — was adding
// them anyway and printing one figure:
//
//   money(v.qb_amount + v.receipt_amount)
//
// which turned $412.55 of QuickBooks cost and $462.55 of receipts into a
// single confident $875.10 that corresponds to no money that was ever spent.
//
// These tests execute the SHIPPED renderer, so they hold the screen rather
// than the intention. The sum is COMPUTED here rather than written down,
// because a hard-coded expected total is exactly the kind of arithmetic that
// goes stale without failing.

const fs = require('fs');
const path = require('path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'cost-inbox.js'), 'utf8')
  .replace(/\r\n?/g, '\n');

function lift(name) {
  const i = SRC.indexOf('function ' + name + '(');
  if (i < 0) throw new Error('cost-inbox.js no longer defines ' + name);
  let depth = 0;
  let started = false;
  for (let k = SRC.indexOf('{', i); k < SRC.length; k++) {
    if (SRC[k] === '{') { depth++; started = true; } else if (SRC[k] === '}') {
      depth--;
      if (started && depth === 0) return SRC.slice(i, k + 1);
    }
  }
  throw new Error('unbalanced braces lifting ' + name);
}

const R = new Function(
  ['esc', 'money', 'fmtDate', 'agreementLine', 'phoneLine', 'merchantCard']
    .map(lift).join('\n')
  + '\nreturn { merchantCard: merchantCard, money: money };'
)();

// The server's merchant shape. Two spellings, because the variants list only
// renders when the normalizer grouped more than one.
function merchant(over) {
  return Object.assign({
    key: 'home depot',
    display: 'THE HOME DEPOT',
    variants: [
      { raw: 'THE HOME DEPOT', qb_lines: 12, qb_amount: 412.55, receipts: 3, receipt_amount: 462.55 },
      { raw: 'HOME DEPOT #0242', qb_lines: 4, qb_amount: 88.10, receipts: 1, receipt_amount: 51.25 },
    ],
    receipts: { count: 4, amount: 513.80 },
    qb_cost: { lines: 16, amount: 500.65 },
    qb_sub: { lines: 0, amount: 0 },
    qb_accrual_excluded: { lines: 0 },
    first_seen: '2026-08-01',
    last_seen: '2026-08-20',
    stores: [],
  }, over || {});
}

describe('the two dollars are never added, on any row of the card', () => {
  test('the exact figures from the defect: both are printed, the sum is not', () => {
    const html = R.merchantCard(merchant());
    expect(html).toContain(R.money(412.55));
    expect(html).toContain(R.money(462.55));
    // 412.55 + 462.55. Computed, never written down.
    expect(html).not.toContain(R.money(412.55 + 462.55));
  });

  test('no pair of QuickBooks and receipt money ever produces its total', () => {
    // A property over many shapes, because the defect was one expression that
    // happened to be reachable — not one bad number.
    const pairs = [
      [412.55, 462.55], [88.10, 51.25], [1, 1], [0.01, 0.02], [40000, 12],
      [999999.99, 0.01], [250, 250], [3.33, 6.67], [10, 90], [1234.56, 8765.44],
    ];
    pairs.forEach(([qb, rec]) => {
      const html = R.merchantCard(merchant({
        variants: [
          { raw: 'A SPELLING', qb_lines: 2, qb_amount: qb, receipts: 2, receipt_amount: rec },
          { raw: 'ANOTHER SPELLING', qb_lines: 1, qb_amount: 5, receipts: 1, receipt_amount: 7 },
        ],
      }));
      expect(html).toContain(R.money(qb));
      expect(html).toContain(R.money(rec));
      // Both sides are non-zero in every pair, so the total is a number that
      // could only appear by having been added.
      expect(html).not.toContain(R.money(qb + rec));
    });
  });

  test('the row COUNTS are reported against the rows they came from', () => {
    const html = R.merchantCard(merchant());
    // 12 QuickBooks lines and 3 receipts — not "15 rows".
    expect(html).toMatch(/12 QuickBooks lines/);
    expect(html).toMatch(/3 receipts/);
    expect(html).not.toMatch(/15 rows/);
  });

  test('a spelling with money on only one side does not invent the other', () => {
    const html = R.merchantCard(merchant({
      variants: [
        { raw: 'QB ONLY', qb_lines: 9, qb_amount: 300, receipts: 0, receipt_amount: 0 },
        { raw: 'RECEIPTS ONLY', qb_lines: 0, qb_amount: 0, receipts: 2, receipt_amount: 44 },
      ],
    }));
    expect(html).toContain('9 QuickBooks lines');
    expect(html).toContain('2 receipts');
    // no empty "0 receipts $0.00" noise on either row
    expect(html).not.toContain('0 receipts');
    expect(html).not.toContain('0 QuickBooks lines');
  });

  test('the money is still there — it was not fixed by deleting it', () => {
    // The money is why the spellings list exists: a spelling with $40k behind
    // it is worth consolidating and one with $12 is not.
    const html = R.merchantCard(merchant());
    expect(html).toContain('$412.55');
    expect(html).toContain('$462.55');
  });
});

describe('the headline block, which was already right, stays right', () => {
  const html = R.merchantCard(merchant());

  test('QuickBooks cost and receipts are printed as separate figures', () => {
    expect(html).toContain(R.money(500.65));
    expect(html).toContain(R.money(513.80));
    expect(html).not.toContain(R.money(500.65 + 513.80));
  });

  test('and the card still says out loud that they are not a total', () => {
    expect(html).toContain('not added together');
    expect(html).toContain('the same dollar can appear twice');
  });
});

describe('the source carries no qb+receipt addition at all', () => {
  test('no expression in the file adds a QuickBooks amount to a receipt amount', () => {
    // The rendered-output tests above are the real proof; this one catches a
    // reintroduction on a surface that has no test yet.
    expect(SRC).not.toMatch(/qb_amount\s*\+\s*v?\.?receipt_amount/);
    expect(SRC).not.toMatch(/receipt_amount\s*\+\s*v?\.?qb_amount/);
    expect(SRC).not.toMatch(/qb_cost\.amount\s*\+\s*m?\.?receipts\.amount/);
  });
});
