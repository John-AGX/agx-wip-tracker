// The Writes ledger reads payload rows. Until this shipped, a Scribe that
// COULDN'T do something left no row at all — the draft is deleted on a
// dry-run validation failure, and a Scribe that never authors an acceptable
// payload writes nothing in the first place. So the ledger, asked what the
// coworker did today, answered with a list of its successes.
//
// These pin the shape of the row that fixes that, and the two things about it
// that are load-bearing: it can never be approved, and it can never be
// mistaken for a failed apply.

const { buildRefusalRow, refusalTitle, tidyReason, tidyInstruction } =
  require('../server/services/scribe-refusal');

const base = {
  id: 'pl_1', orgId: 42, userId: 7, sessionId: 99,
  instruction: 'Set the scope of work on estimate est_9 to the concrete pad text.',
  error: 'Assembly refused: unpriced item in recipe CONC-PAD-01.'
};

function fields(row) {
  const p = row.params;
  return {
    id: p[0], orgId: p[1], userId: p[2], sessionId: p[3],
    filename: p[4], fileContent: JSON.parse(p[5]),
    title: p[6], summary: p[7], applyError: p[8]
  };
}

describe('buildRefusalRow', () => {
  test('writes a TERMINAL row that can never be approved or applied', () => {
    const row = buildRefusalRow(base);
    // status 'failed' + empty targets, both literal in the SQL so no caller
    // can pass something else. claimable() only ever lets 'ready'/'applying'
    // through, so this row is inert on arrival.
    expect(row.text).toMatch(/'\[\]'::jsonb/);
    expect(row.text).toMatch(/'failed'/);
    expect(row.text).not.toMatch(/applied_at/);
    expect(row.text).toMatch(/ON CONFLICT \(id\) DO NOTHING/);
  });

  test('empty targets is the ONLY thing separating a refusal from a failed apply', () => {
    // Both are status 'failed'. Every surface tells them apart by targets
    // being an empty array, so it must be written as one — not null, not
    // absent.
    expect(buildRefusalRow(base).text).toContain("'[]'::jsonb");
  });

  test('carries the reason, the ask, and the tenant', () => {
    const f = fields(buildRefusalRow(base));
    expect(f.orgId).toBe(42);
    expect(f.userId).toBe(7);
    expect(f.sessionId).toBe(99);
    expect(f.applyError).toContain('unpriced item');
    expect(f.summary).toContain('Set the scope of work on estimate est_9');
    expect(f.title).toContain("Couldn't draft");
    expect(f.fileContent.kind).toBe('scribe_refusal');
  });

  // organization_id is NOT NULL and it is the tenant boundary. A refusal we
  // cannot attribute is one we do not record — an unscoped ledger row is
  // worse than a missing one.
  test('refuses to build without an org or an id', () => {
    expect(buildRefusalRow({ id: 'pl_1' })).toBeNull();
    expect(buildRefusalRow({ orgId: 42 })).toBeNull();
    expect(buildRefusalRow(null)).toBeNull();
  });

  test('a missing reason still produces a row that says something', () => {
    const f = fields(buildRefusalRow({ id: 'pl_2', orgId: 1 }));
    expect(f.applyError).toMatch(/no reason/i);
    expect(f.title).toBeTruthy();
    expect(f.summary).toBeTruthy();
  });
});

describe('the strings a human reads in a 236px rail', () => {
  test('the reason is collapsed, de-marked-up and capped', () => {
    const long = '<b>Validation</b> failed\n\n  on   field_path  ' + 'x'.repeat(2000);
    const out = tidyReason(long);
    expect(out).not.toContain('<b>');
    expect(out).not.toMatch(/\s{2}/);
    expect(out.length).toBeLessThanOrEqual(801);
  });

  test('the title is the first clause, so a day of refusals is not 20 identical rows', () => {
    expect(refusalTitle('Add a dumpster pad line. Then reprice the section.'))
      .toBe("Couldn't draft: Add a dumpster pad line.");
  });

  test('an empty instruction never yields an empty title or summary', () => {
    expect(refusalTitle('')).toBeTruthy();
    expect(refusalTitle(null)).toBeTruthy();
    expect(tidyInstruction('')).toBeTruthy();
    expect(tidyInstruction(undefined)).toBeTruthy();
  });
});
