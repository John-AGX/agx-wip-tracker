/**
 * @jest-environment jsdom
 */
// test/qb-costs-unmatched-cause.test.js — WHY a QuickBooks project did
// not import.
//
// The defect: two completely different failures shared one message, and
// it led with the wrong one —
//
//   "Not sent — the QuickBooks project code doesn't match any Project 86
//    job number. Fix the project name in QB to lead with the job number,
//    or create a stub job, then re-import."
//
// John hit it on two projects, S2240 Citi Lakes Garage Repair G48 (2
// rows, $620.57) and S2157 Hammock II Stairway and Catwalk Painting (16
// rows, $13,065.74). He read "fix the project name in QB" and went
// hunting a formatting problem — specifically whether the matcher wanted
// a dash. It doesn't: the code is the first whitespace-delimited token,
// so "S2240 - Citi Lakes" yields the same S2240 either way. The names
// were fine. Neither job existed in Project 86. Twenty minutes spent in
// the wrong application.
//
// So there are two causes wearing one message:
//   (A) the project name carries no recognisable job number — a QB
//       auto-number like 437775, or a customer name → fix it in QB;
//   (B) a perfectly well-formed code with no such job here → create the
//       job in Project 86.
// Plus a third honest answer when the code's shape is genuinely
// undecidable: we can't tell.
//
// The shape a code is judged against is LEARNED from the org's own job
// numbers, never hardcoded to AGX's S#### / RV####. Job numbering is
// configurable (a type maps to a prefix and a counter, claimed via
// POST /api/org/next-job-number), so a hardcoded regex would make this
// message nonsense for any org numbering differently. Several tests
// below exist only to pin that.
//
// And the whole change is words: which rows match, which are refused,
// and what totals are reported must be byte-for-byte what they were.

const {
  orgJobNumberShape,
  classifyUnmatchedCode,
  unmatchedReason,
  groupUnmatched,
  unmatchedGroupSentence,
  matchJobs,
  renderCommitReceipt
} = require('../js/job-costs-import');

// The org John actually has: 25 jobs on two prefixes. Trimmed to the
// ones these tests lean on.
const AGX_JOB_NUMBERS = ['RV2000-2013', 'RV2004', 'RV2041', 'S2095', 'S2205', 'S2222', 'S2252'];
const AGX = orgJobNumberShape(AGX_JOB_NUMBERS);

function project(code, name, total, lines) {
  return {
    code: code,
    name: name,
    computedTotal: total,
    lines: new Array(lines == null ? 1 : lines).fill({})
  };
}

describe('classification — one cause per unmatched project', () => {
  // (B). The case that cost the twenty minutes.
  test('a well-formed code with no such job is (B), and the message names the job to create', () => {
    expect(classifyUnmatchedCode('S2240', AGX)).toBe('missing-job');

    const msg = unmatchedReason('S2240', AGX);
    expect(msg).toContain('S2240');
    expect(msg).toMatch(/no job numbered S2240 exists in Project 86/);
    expect(msg).toMatch(/Create job S2240/);
    // The whole point: do NOT send him back to QuickBooks to rename
    // something that was already correct.
    expect(msg).not.toMatch(/Rename/i);
    expect(msg).not.toMatch(/lead with the job number/i);
  });

  test('S2157 — the $13,065.74 project — reads the same way', () => {
    expect(classifyUnmatchedCode('S2157', AGX)).toBe('missing-job');
    expect(unmatchedReason('S2157', AGX)).toMatch(/Create job S2157/);
  });

  // (A), high confidence. An all-numeric leading token in an org that
  // does not number jobs numerically is a QB auto-number — say that
  // specifically rather than generically.
  test('a 437775-style auto-number is (A), named as a QuickBooks auto-number', () => {
    expect(classifyUnmatchedCode('437775', AGX)).toBe('qb-autonumber');

    const msg = unmatchedReason('437775', AGX);
    expect(msg).toMatch(/QuickBooks auto-number/);
    expect(msg).toMatch(/Rename the project in QuickBooks/);
    // Never tell them to create a job called 437775.
    expect(msg).not.toMatch(/Create job/);
  });

  // (A). A customer-name project: "Citi Lakes Garage Repair G48" with no
  // code in front leaves CITI as the leading token.
  test('a customer-name project is (A) — nothing to match on', () => {
    expect(classifyUnmatchedCode('CITI', AGX)).toBe('no-code');

    const msg = unmatchedReason('CITI', AGX);
    expect(msg).toMatch(/isn’t a job number/);
    expect(msg).toMatch(/Rename the project in QuickBooks/);
    expect(msg).not.toMatch(/Create job/);
  });

  test('a header with no name after the code leaves an empty code, still (A)', () => {
    expect(classifyUnmatchedCode('', AGX)).toBe('no-code');
    expect(unmatchedReason('', AGX)).toMatch(/carries no job number/);
  });

  // The third answer. T4100 is shaped exactly like a job number but
  // carries a prefix this org has never used. A job TYPE can exist with
  // no job claimed under it yet, so its prefix is invisible here — which
  // makes this genuinely undecidable. "We can't tell" beats a confident
  // wrong cause.
  test('a well-shaped code under an unseen prefix takes the third branch', () => {
    expect(classifyUnmatchedCode('T4100', AGX)).toBe('unclear');

    const msg = unmatchedReason('T4100', AGX);
    expect(msg).toMatch(/can’t tell/);
    expect(msg).toMatch(/job is missing or the code is wrong/);
    // It must not commit to either fix.
    expect(msg).not.toMatch(/Create job T4100/);
    expect(msg).not.toMatch(/Rename the project in QuickBooks/);
  });

  test('a hyphenated real number like RV2000-2013 reads as well-formed, not as junk', () => {
    expect(classifyUnmatchedCode('RV2000-2099', AGX)).toBe('missing-job');
  });
});

describe('the shape is learned from the org, not hardcoded to S#### / RV####', () => {
  test('shape derives the prefix set actually in use', () => {
    expect(AGX.known).toBe(true);
    expect(Object.keys(AGX.prefixes).sort()).toEqual(['RV', 'S']);
    expect(AGX.allowsNumeric).toBe(false);
  });

  // The tenant-boundary point. An org numbering AX#### must get the same
  // quality of message, and must NOT be told that S2240 is a missing job
  // of theirs.
  test('an org numbering AX#### classifies AX0007 as (B) and S2240 as unclear', () => {
    const other = orgJobNumberShape(['AX0001', 'AX0002', 'AX0006']);
    expect(Object.keys(other.prefixes)).toEqual(['AX']);

    expect(classifyUnmatchedCode('AX0007', other)).toBe('missing-job');
    expect(unmatchedReason('AX0007', other)).toMatch(/Create job AX0007/);

    expect(classifyUnmatchedCode('S2240', other)).toBe('unclear');
  });

  // Honesty in the other direction: calling 437775 an auto-number is only
  // safe when the org does not number jobs with bare digits. An org that
  // does gets "we can't tell", not a confident wrong cause.
  test('an org that numbers jobs numerically makes an all-digit code ambiguous, not (A)', () => {
    const numeric = orgJobNumberShape(['1001', '1002', '1003']);
    expect(numeric.allowsNumeric).toBe(true);
    expect(numeric.known).toBe(true);

    expect(classifyUnmatchedCode('437775', numeric)).toBe('unclear');
    expect(unmatchedReason('437775', numeric)).not.toMatch(/auto-number/);
  });

  // A brand-new org has no numbering to learn from. It must degrade to
  // the (A) branch rather than throw, and it must not claim S2240 "isn't
  // a job number" — it has no basis for that.
  test('an org with zero jobs degrades to (A) without throwing', () => {
    const empty = orgJobNumberShape([]);
    expect(empty.known).toBe(false);
    // Nothing invented out of thin air — no fallback prefix set.
    expect(Object.keys(empty.prefixes)).toEqual([]);

    expect(() => classifyUnmatchedCode('S2240', empty)).not.toThrow();
    expect(classifyUnmatchedCode('S2240', empty)).toBe('no-code');

    const msg = unmatchedReason('S2240', empty);
    expect(msg).toMatch(/Project 86 has no jobs yet/);
    expect(msg).not.toMatch(/isn’t a job number/);
  });

  test('junk input never throws', () => {
    expect(() => orgJobNumberShape(null)).not.toThrow();
    expect(() => orgJobNumberShape([null, undefined, '', 42])).not.toThrow();
    expect(() => classifyUnmatchedCode(undefined, undefined)).not.toThrow();
    expect(() => unmatchedReason(null, null)).not.toThrow();
  });
});

describe('the preview summary splits the causes it used to merge', () => {
  const UNMATCHED = [
    project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2),
    project('S2157', 'Hammock II Stairway and Catwalk Painting', 13065.74, 16),
    project('437775', 'Solace Exterior Paint & Repairs', 900, 3),
    project('CITI', 'Lakes Garage Repair G48', 100, 1)
  ];

  test('groups by cause, keeping count and dollars per cause', () => {
    const groups = groupUnmatched(UNMATCHED, AGX);
    const byCause = {};
    groups.forEach(g => { byCause[g.cause] = g; });

    expect(byCause['missing-job'].count).toBe(2);
    expect(byCause['missing-job'].total).toBeCloseTo(13686.31, 2);
    expect(byCause['missing-job'].codes).toEqual(['S2240', 'S2157']);
    expect(byCause['qb-autonumber'].count).toBe(1);
    expect(byCause['no-code'].count).toBe(1);
  });

  test('the missing-job sentence names the jobs and clears QuickBooks of blame', () => {
    const g = groupUnmatched(UNMATCHED, AGX).filter(x => x.cause === 'missing-job')[0];
    const s = unmatchedGroupSentence(g);

    expect(s).toContain('S2240');
    expect(s).toContain('S2157');
    expect(s).toContain('$13,686.31');
    expect(s).toMatch(/does not exist in Project 86 yet/);
    expect(s).toMatch(/The QuickBooks names are fine/);
  });

  test('the auto-number sentence sends the user to QuickBooks and nowhere else', () => {
    const g = groupUnmatched(UNMATCHED, AGX).filter(x => x.cause === 'qb-autonumber')[0];
    const s = unmatchedGroupSentence(g);

    expect(s).toMatch(/QuickBooks auto-number/);
    expect(s).toMatch(/Rename it in QuickBooks/);
    expect(s).not.toMatch(/Create/);
  });

  // The old summary asserted one cause covered both, in AGX's own
  // vocabulary. Neither may come back.
  test('the summary no longer asserts a single hardcoded cause', () => {
    const all = groupUnmatched(UNMATCHED, AGX).map(unmatchedGroupSentence).join(' ');
    expect(all).not.toMatch(/usually a QB auto-number/);
    expect(all).not.toMatch(/S####/);
    expect(all).not.toMatch(/RV####/);
  });
});

describe('the receipt row — one cause, one action, per row', () => {
  function mount() {
    document.body.innerHTML =
      '<div id="qbCostsImportModal" class="modal"><div class="modal-content">' +
        '<div id="qbCostsImport_body"></div>' +
        '<div class="modal-footer">' +
          '<button class="secondary">Cancel</button>' +
          '<button class="primary" id="qbCostsImport_confirmBtn">Import</button>' +
        '</div>' +
      '</div></div>';
    return document.getElementById('qbCostsImport_body');
  }

  function render(unmatched, jobNumbers) {
    const body = mount();
    renderCommitReceipt({
      fileName: '08.20.26 - Project Costs.xlsx',
      reportDate: '2026-08-20',
      parsedProjects: 25,
      parsedLines: 700,
      matched: [],
      unmatched: unmatched,
      jobNumbers: jobNumbers,
      sentLines: 0,
      srv: { ok: true, received: 0, inserted: 0, updated: 0, skipped: 0, cleaned: 0, rejected: [], byJob: {} },
      srvErr: null,
      sheetCacheFailed: null
    });
    return body;
  }

  test('two projects failing for different reasons get different sentences', () => {
    const body = render([
      project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2),
      project('437775', 'Solace Exterior Paint & Repairs', 900, 3)
    ], AGX_JOB_NUMBERS);

    const rows = Array.from(body.querySelectorAll('tr'))
      .map(tr => (tr.textContent || '').replace(/\s+/g, ' ').trim())
      .filter(t => /Not sent/.test(t));
    expect(rows.length).toBe(2);

    const s2240 = rows.filter(t => /S2240/.test(t))[0];
    const auto = rows.filter(t => /437775/.test(t))[0];

    expect(s2240).toMatch(/no job numbered S2240 exists in Project 86/);
    expect(s2240).toMatch(/Create job S2240/);
    expect(auto).toMatch(/QuickBooks auto-number/);
    expect(auto).toMatch(/Rename the project in QuickBooks/);

    // The two rows must not be the same sentence any more.
    expect(s2240.replace(/^.*Not sent/, '')).not.toBe(auto.replace(/^.*Not sent/, ''));
  });

  // The exact string the old code printed for every unmatched project.
  test('the one-size-fits-all sentence is gone from the receipt', () => {
    const body = render([
      project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2)
    ], AGX_JOB_NUMBERS);
    const text = (body.textContent || '').replace(/\s+/g, ' ');

    expect(text).not.toMatch(/the QuickBooks project code doesn’t match any Project\s*86 job number/);
    expect(text).not.toMatch(/Fix the project name in QB to lead with the job number/);
  });

  test('with no jobNumbers on the receipt it falls back to appData and still renders', () => {
    window.appData = { jobs: AGX_JOB_NUMBERS.map((n, i) => ({ id: 'j' + i, jobNumber: n, title: 't' + i })) };
    try {
      const body = render([project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2)], undefined);
      expect((body.textContent || '')).toMatch(/Create job S2240/);
    } finally {
      delete window.appData;
    }
  });

  test('an org with zero jobs renders the receipt without throwing', () => {
    window.appData = { jobs: [] };
    try {
      let body;
      expect(() => {
        body = render([project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2)], undefined);
      }).not.toThrow();
      expect((body.textContent || '')).toMatch(/Project 86 has no jobs yet/);
    } finally {
      delete window.appData;
    }
  });
});

// The guard rail on the whole change. This is a message and
// classification change only — if the partition or the money moves, the
// change is a defect no matter how good the copy reads.
describe('nothing about WHAT imports changed', () => {
  const PARSED = [
    project('RV2004', 'Citi Lakes Repaint and Repairs', 368057.80, 222),
    project('S2205', 'Something Real', 1000, 4),
    project('S2240', 'Citi Lakes Garage Repair G48', 620.57, 2),
    project('S2157', 'Hammock II Stairway and Catwalk Painting', 13065.74, 16),
    project('437775', 'Solace Exterior Paint & Repairs', 900, 3),
    // Near-misses. Exact match on the whole token is the rule; nothing
    // about explaining a failure may loosen it into a prefix match.
    project('S2205-2', 'Phase Two', 700, 2),
    project('S22', 'Truncated', 300, 1),
    project('', 'Nameless', 5, 1)
  ];

  beforeEach(() => {
    window.appData = {
      jobs: AGX_JOB_NUMBERS.map((n, i) => ({ id: 'j' + i, jobNumber: n, title: 'Job ' + n }))
    };
  });
  afterEach(() => { delete window.appData; });

  test('the same projects match and the same projects are refused', () => {
    const m = matchJobs(PARSED);
    expect(m.matched.map(x => x.parsed.code)).toEqual(['RV2004', 'S2205']);
    expect(m.unmatched.map(p => p.code)).toEqual(['S2240', 'S2157', '437775', 'S2205-2', 'S22', '']);
  });

  test('the same totals are reported on each side', () => {
    const m = matchJobs(PARSED);
    const matchedTotal = m.matched.reduce((s, x) => s + x.parsed.computedTotal, 0);
    const unmatchedTotal = m.unmatched.reduce((s, p) => s + p.computedTotal, 0);

    expect(matchedTotal).toBeCloseTo(369057.80, 2);
    expect(unmatchedTotal).toBeCloseTo(15591.31, 2);
    // Classification must not silently move money between the two sides.
    expect(matchedTotal + unmatchedTotal)
      .toBeCloseTo(PARSED.reduce((s, p) => s + p.computedTotal, 0), 2);
  });

  test('a dash after the code is still irrelevant to matching, as it always was', () => {
    // The formatting problem John went looking for does not exist: the
    // code is the leading token either way.
    const withDash = matchJobs([project('S2205', '- Something Real', 1000, 4)]);
    expect(withDash.matched.length).toBe(1);
    expect(withDash.unmatched.length).toBe(0);
  });

  test('the classifier learns from exactly the numbers the matcher matched on', () => {
    const m = matchJobs(PARSED);
    expect(m.jobNumbers.slice().sort()).toEqual(AGX_JOB_NUMBERS.slice().sort());
  });
});
