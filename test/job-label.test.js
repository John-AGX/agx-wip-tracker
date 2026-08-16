// Job label formatter — the owner's standard is `jobNumber + ' ' + title`,
// one space, no em dash. These tests pin the four input cases plus the
// specific defects the sweep was fixing (stranded separators, "[object
// Object]", raw-id fallbacks).
const jobLabel = require('../js/job-label');

describe('jobLabel(number, title)', () => {
  test('both parts → number, one space, title (John\'s standard)', () => {
    expect(jobLabel('RV2006', 'Waterside 1 Siding Replacement'))
      .toBe('RV2006 Waterside 1 Siding Replacement');
  });

  test('number only → the number alone, no trailing separator', () => {
    expect(jobLabel('RV2006', '')).toBe('RV2006');
    expect(jobLabel('RV2006', null)).toBe('RV2006');
    expect(jobLabel('RV2006', undefined)).toBe('RV2006');
  });

  test('title only → the title alone, no leading separator', () => {
    expect(jobLabel('', 'Waterside 1')).toBe('Waterside 1');
    expect(jobLabel(null, 'Waterside 1')).toBe('Waterside 1');
  });

  test('neither → a sensible fallback, never "undefined"', () => {
    expect(jobLabel('', '')).toBe('Untitled job');
    expect(jobLabel(null, undefined)).toBe('Untitled job');
    expect(jobLabel(undefined, undefined)).not.toMatch(/undefined|null|NaN/);
  });

  test('caller can override the both-empty fallback', () => {
    expect(jobLabel('', '', { fallback: 'Job j17' })).toBe('Job j17');
    // A blank / non-string fallback falls back to the default rather than
    // rendering an empty label.
    expect(jobLabel('', '', { fallback: '   ' })).toBe('Untitled job');
    expect(jobLabel('', '', { fallback: 42 })).toBe('Untitled job');
    expect(jobLabel('', '', {})).toBe('Untitled job');
  });

  test('whitespace-only parts count as absent (no " " label, no double space)', () => {
    expect(jobLabel('  ', '  ')).toBe('Untitled job');
    expect(jobLabel('  RV2006 ', ' Waterside 1 ')).toBe('RV2006 Waterside 1');
    expect(jobLabel('RV2006', '   ')).toBe('RV2006');
  });

  test('never emits a separator with nothing on one side', () => {
    // The workspace-layout defect: an unconditional " — " produced "RV2006 — "
    // and a leading " — " for numberless jobs.
    expect(jobLabel('RV2006', '')).not.toMatch(/\s$/);
    expect(jobLabel('', 'Waterside 1')).not.toMatch(/^\s/);
  });

  test('numeric job numbers are labels too', () => {
    expect(jobLabel(2006, 'Waterside 1')).toBe('2006 Waterside 1');
  });

  test('non-string junk never stringifies into the label', () => {
    expect(jobLabel({}, 'Waterside 1')).toBe('Waterside 1');
    expect(jobLabel(['RV2006'], 'Waterside 1')).toBe('Waterside 1');
    expect(jobLabel(NaN, 'Waterside 1')).toBe('Waterside 1');
    expect(jobLabel(true, '')).toBe('Untitled job');
  });

  test('the format carries no em dash, hyphen, pipe, dot or bracket', () => {
    const out = jobLabel('RV2006', 'Waterside 1');
    expect(out).not.toMatch(/[—–|·\[\]]/);
    expect(out).toBe('RV2006 Waterside 1');
  });
});

describe('jobLabel.fromJob(jobLike)', () => {
  test('client appData record shape (jobNumber / title)', () => {
    expect(jobLabel.fromJob({ jobNumber: 'RV2006', title: 'Waterside 1' }))
      .toBe('RV2006 Waterside 1');
  });

  test('joined server row shape (job_number / job_title)', () => {
    expect(jobLabel.fromJob({ job_number: 'RV2006', job_title: 'Waterside 1' }))
      .toBe('RV2006 Waterside 1');
  });

  test('legacy title aliases resolve (name / jobName)', () => {
    expect(jobLabel.fromJob({ jobNumber: 'RV2006', name: 'Waterside 1' }))
      .toBe('RV2006 Waterside 1');
    expect(jobLabel.fromJob({ jobNumber: 'RV2006', jobName: 'Waterside 1' }))
      .toBe('RV2006 Waterside 1');
    // title wins over the aliases when both are present.
    expect(jobLabel.fromJob({ jobNumber: 'RV2006', title: 'Real', name: 'Stale' }))
      .toBe('RV2006 Real');
  });

  test('a bare `number` field is NOT read as the job number', () => {
    // On a PO / invoice row `number` is the document's own number.
    expect(jobLabel.fromJob({ number: 'PO-114', title: 'Waterside 1' }))
      .toBe('Waterside 1');
  });

  test('missing / non-object job resolves to the fallback, not a crash', () => {
    expect(jobLabel.fromJob(null)).toBe('Untitled job');
    expect(jobLabel.fromJob(undefined)).toBe('Untitled job');
    expect(jobLabel.fromJob('RV2006')).toBe('Untitled job');
    expect(jobLabel.fromJob(null, { fallback: 'Job j17' })).toBe('Job j17');
  });

  test('empty record uses the fallback rather than a raw id', () => {
    expect(jobLabel.fromJob({ id: 'j17' })).toBe('Untitled job');
    expect(jobLabel.fromJob({ id: 'j17' })).not.toContain('j17');
  });
});
