// test/qb-line-id.test.js — content-hash ids for QB cost lines.
//
// Two obligations:
//   1. The hash is FROZEN. Every row in qb_cost_lines is keyed by it, so
//      a change silently orphans the whole table and re-imports would
//      duplicate instead of update. The golden values below are the
//      guard — if you change hashLineId, these break, and that is the
//      point.
//   2. staleZeroLineId has to name exactly the row the pre-fix parser
//      wrote for a credit (same line, amount 0.00), so the importer can
//      retire it without touching anything else.

const { hashLineId, staleZeroLineId } = require('../server/util/qb-line-id');

const LINE = {
  vendor: 'Home Depot',
  date: '05/14/2026',
  txnType: 'Bill',
  num: 'INV 1',
  account: 'Materials',
  memo: 'sale',
  amount: -850,
};

describe('hashLineId', () => {
  // Golden values captured from the pre-refactor implementation.
  test('is frozen — golden hashes must not drift', () => {
    expect(hashLineId('j1', LINE)).toBe('qbc_a8c2429696813419');
    expect(hashLineId('j2', {
      vendor: '', date: '', txnType: '', num: '', account: '', memo: '', amount: 0,
    })).toBe('qbc_12ed018e5fdc198b');
    expect(hashLineId('j3', {
      vendor: 'A|B', date: '01/02/2026', txnType: 'Check', num: '',
      account: 'Subs', memo: 'pipe | fitting', amount: 1234.56,
    })).toBe('qbc_c016ac1d1de8ea69');
  });

  test('is deterministic', () => {
    expect(hashLineId('j1', LINE)).toBe(hashLineId('j1', LINE));
  });

  test('same line on two jobs gets two ids', () => {
    expect(hashLineId('jobA', LINE)).not.toBe(hashLineId('jobB', LINE));
  });

  test('amount is part of the identity', () => {
    expect(hashLineId('j1', { ...LINE, amount: -850 }))
      .not.toBe(hashLineId('j1', { ...LINE, amount: -851 }));
  });

  test('vendor and txnType compare case-insensitively', () => {
    expect(hashLineId('j1', { ...LINE, vendor: 'HOME DEPOT', txnType: 'BILL' }))
      .toBe(hashLineId('j1', LINE));
  });

  test('a "|" in the memo does not collide with the field separator', () => {
    const a = hashLineId('j1', { ...LINE, memo: 'pipe', account: 'x|y' });
    const b = hashLineId('j1', { ...LINE, memo: 'pipe|x', account: 'y' });
    expect(a).not.toBe(b);
  });
});

describe('staleZeroLineId', () => {
  test('names the row the old zeroing parser would have written', () => {
    expect(staleZeroLineId('j1', LINE)).toBe(hashLineId('j1', { ...LINE, amount: 0 }));
  });

  test('differs from the corrected row it supersedes', () => {
    expect(staleZeroLineId('j1', LINE)).not.toBe(hashLineId('j1', LINE));
  });

  test('does not mutate the caller\'s line', () => {
    const line = { ...LINE };
    staleZeroLineId('j1', line);
    expect(line.amount).toBe(-850);
  });

  test('is a no-op identity for a line that is already zero', () => {
    // Guard for the importer's `staleId !== id` check: a genuine $0 line
    // must never delete itself.
    const zero = { ...LINE, amount: 0 };
    expect(staleZeroLineId('j1', zero)).toBe(hashLineId('j1', zero));
  });
});
