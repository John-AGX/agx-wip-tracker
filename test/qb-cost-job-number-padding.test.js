// THE TWO SIDES SPELL THE SAME JOB NUMBER DIFFERENTLY.
//
// Project 86 pads a job number to its type's width — WO0004. The accounting
// system does not — WO4. matchJobs() compared the two as strings, so the
// 2026-10-01 export missed ten of thirteen work orders on the leading zeros
// alone: WO4, WO5, WO8, WO9, WO27, WO32, WO70, WO80, WO719 and WO24-2,
// $3,866.28 of real cost with nowhere to land. The three that did match —
// WO1928, WO1929, WO1932 — matched only because they happen to be four
// digits already.
//
// The matcher now falls back to a loose key when, and only when, the exact
// code found nothing. What this file pins is mostly the limits of that
// tolerance, because a matcher that is too generous posts money to the wrong
// job and nobody finds out:
//
//   * R2006 must NOT reach RV2006. They are different series and different
//     jobs — "Goetz Residential Paint" against "Fairway Paint & Gutters",
//     which carries $217,723.67. The letter RUN is matched as a unit.
//   * An exact match always wins, so no padding rule can take a project away
//     from the job whose number it literally is.
//   * Two jobs that differ only by leading zeros are AMBIGUOUS. The importer
//     names them and leaves the project unmatched rather than picking one.

const { matchJobs, looseNumberKey } = require('../js/job-costs-import');

// matchJobs reads window.appData.jobs — the module guards for node, so the
// test supplies the global the browser would have.
function withJobs(numbers, fn) {
  const had = Object.prototype.hasOwnProperty.call(global, 'window');
  const prev = global.window;
  global.window = { appData: { jobs: numbers.map((n, i) => ({
    id: 'job_' + i, jobNumber: n, title: 'Job ' + n
  })) } };
  try { return fn(); } finally {
    if (had) global.window = prev; else delete global.window;
  }
}

const project = (code, name) => ({
  code, name: name || (code + ' work'), lines: [{ amount: 1 }], computedTotal: 1
});

function match(jobNumbers, codes) {
  return withJobs(jobNumbers, () => matchJobs(codes.map((c) => project(c))));
}

describe('the loose key', () => {
  test('strips leading zeros from the number and keeps the letter run', () => {
    expect(looseNumberKey('WO0004')).toBe(looseNumberKey('WO4'));
    expect(looseNumberKey('WO0070')).toBe(looseNumberKey('WO70'));
    expect(looseNumberKey('S0001')).toBe(looseNumberKey('S1'));
  });

  test('keeps a suffix, so WO0024-2 and WO24-2 are the same errand', () => {
    expect(looseNumberKey('WO0024-2')).toBe(looseNumberKey('WO24-2'));
    expect(looseNumberKey('WO0024-2')).not.toBe(looseNumberKey('WO0024-3'));
  });

  test('NEVER collapses one letter run into another', () => {
    // The whole safety argument. R#### and RV#### are both real AGX series.
    expect(looseNumberKey('R2006')).not.toBe(looseNumberKey('RV2006'));
    expect(looseNumberKey('S2240')).not.toBe(looseNumberKey('SV2240'));
    expect(looseNumberKey('M1001')).not.toBe(looseNumberKey('MO1001'));
  });

  test('does not make different numbers equal', () => {
    expect(looseNumberKey('WO4')).not.toBe(looseNumberKey('WO40'));
    expect(looseNumberKey('WO40')).not.toBe(looseNumberKey('WO400'));
    // A trailing zero is part of the number; only LEADING zeros are padding.
    expect(looseNumberKey('WO0040')).toBe(looseNumberKey('WO40'));
  });

  test('is empty for a code with no digits, so it can never match anything', () => {
    // The export's footer timestamp parses as a project called "THURSDAY,".
    expect(looseNumberKey('THURSDAY,')).toBe('');
    expect(looseNumberKey('')).toBe('');
    expect(looseNumberKey(null)).toBe('');
  });

  test('is case- and whitespace-insensitive, like the exact match beside it', () => {
    expect(looseNumberKey(' wo4 ')).toBe(looseNumberKey('WO0004'));
  });
});

describe('the ten work orders that used to miss', () => {
  const P86 = ['WO0004', 'WO0005', 'WO0008', 'WO0009', 'WO0027', 'WO0032',
    'WO0070', 'WO0080', 'WO0719', 'WO1928'];
  const QB = ['WO4', 'WO5', 'WO8', 'WO9', 'WO27', 'WO32', 'WO70', 'WO80', 'WO719', 'WO1928'];

  test('all ten match now', () => {
    const m = match(P86, QB);
    expect(m.unmatched).toEqual([]);
    expect(m.matched).toHaveLength(10);
  });

  test('each lands on the right job, not merely on some job', () => {
    const m = match(P86, QB);
    const pairs = m.matched.map((x) => [x.parsed.code, x.job.jobNumber]);
    expect(pairs).toEqual([
      ['WO4', 'WO0004'], ['WO5', 'WO0005'], ['WO8', 'WO0008'], ['WO9', 'WO0009'],
      ['WO27', 'WO0027'], ['WO32', 'WO0032'], ['WO70', 'WO0070'], ['WO80', 'WO0080'],
      ['WO719', 'WO0719'], ['WO1928', 'WO1928']
    ]);
  });

  test('a padded match is FLAGGED, an exact one is not', () => {
    // The preview draws "WO0004 ← WO4" off this flag. A reconciliation the
    // user cannot see is one they cannot check.
    const m = match(P86, QB);
    const byCode = {};
    m.matched.forEach((x) => { byCode[x.parsed.code] = x.padded; });
    expect(byCode.WO4).toBe(true);
    expect(byCode.WO1928).toBe(false);   // already four digits — exact
  });
});

describe('what the tolerance must NOT do', () => {
  test('R2006 does not reach RV2006', () => {
    const m = match(['RV2006'], ['R2006']);
    expect(m.matched).toEqual([]);
    expect(m.unmatched.map((p) => p.code)).toEqual(['R2006']);
  });

  test('…and RV2006 does not reach R2006 either', () => {
    const m = match(['R2006'], ['RV2006']);
    expect(m.matched).toEqual([]);
  });

  test('both series can coexist and each finds its own', () => {
    const m = match(['R2006', 'RV2006'], ['R2006', 'RV2006']);
    expect(m.matched.map((x) => [x.parsed.code, x.job.jobNumber]))
      .toEqual([['R2006', 'R2006'], ['RV2006', 'RV2006']]);
    expect(m.matched.every((x) => x.padded === false)).toBe(true);
  });

  test('AN EXACT MATCH ALWAYS WINS over a padded one', () => {
    // Both WO0004 and WO4 exist as jobs. QuickBooks says WO4; it must go to
    // the job literally numbered WO4, never to the padded neighbour.
    const m = match(['WO0004', 'WO4'], ['WO4']);
    expect(m.matched).toHaveLength(1);
    expect(m.matched[0].job.jobNumber).toBe('WO4');
    expect(m.matched[0].padded).toBe(false);
  });

  test('two jobs differing ONLY by padding are named, not guessed between', () => {
    // WO0004 and WO004 both exist, QuickBooks says WO4. Picking one would
    // post real cost on a coin flip.
    const m = match(['WO0004', 'WO004'], ['WO4']);
    expect(m.matched).toEqual([]);
    expect(m.unmatched).toHaveLength(1);
    expect(m.unmatched[0].ambiguousPadding.sort()).toEqual(['WO0004', 'WO004']);
  });

  test('a code with no digits still matches nothing', () => {
    const m = match(['S2240'], ['THURSDAY,']);
    expect(m.matched).toEqual([]);
    expect(m.unmatched[0].ambiguousPadding).toBe(null);
  });

  test('a QuickBooks auto-number does not unpad into a job number', () => {
    // 437775 has no letter run; it must not reach S437775 or anything else.
    const m = match(['S2240', 'S437775'], ['437775']);
    expect(m.matched).toEqual([]);
  });
});

describe('nothing about the ordinary path changed', () => {
  test('a plain exact match still matches, unflagged', () => {
    const m = match(['S2240', 'RV2001'], ['S2240', 'RV2001']);
    expect(m.matched).toHaveLength(2);
    expect(m.matched.every((x) => x.padded === false)).toBe(true);
    expect(m.unmatched).toEqual([]);
  });

  test('jobNumbers still reports the org numbers the classifier learns from', () => {
    const m = match(['S2240', 'WO0004'], ['S2240']);
    expect(m.jobNumbers.sort()).toEqual(['S2240', 'WO0004']);
  });

  test('a genuinely missing job is still unmatched', () => {
    const m = match(['S2240'], ['M1002']);
    expect(m.matched).toEqual([]);
    expect(m.unmatched.map((p) => p.code)).toEqual(['M1002']);
  });

  test('a job with no number is ignored rather than matching everything', () => {
    const m = match(['', 'S2240'], ['S2240']);
    expect(m.matched).toHaveLength(1);
    expect(m.jobNumbers).toEqual(['S2240']);
  });
});
