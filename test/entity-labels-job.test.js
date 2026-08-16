// server/services/entity-labels.js — the `job` branch.
//
// This resolver is what the sub portal and task share links now paint, so
// its job labels are FORWARD-FACING: a subcontractor and an outside worker
// read them. It must never hand back a synthetic word, a raw id, or a
// stranded fragment.
//
// The specific defect pinned here: the SQL used to COALESCE the title to
// the literal string 'Job', which then reached the shared formatter as if
// it were a real title — so a job carrying a number but no title yet
// resolved to "RV2006 Job". The title now COALESCEs to '' and
// js/job-label.js decides what an empty pair looks like, which is the whole
// reason that module exists.
//
// `../db` is mocked: requiring the real one opens a pg pool, and these
// assertions are about composition, not Postgres.

const jobLabel = require('../js/job-label');

// `mock`-prefixed so jest's out-of-scope guard lets the factory close over them.
let mockQueries;
let mockFixture;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      mockQueries.push({ sql: String(sql), params: params });
      const text = String(sql);
      if (/FROM jobs/i.test(text)) {
        const ids = (params && params[0]) || [];
        return { rows: (mockFixture.jobs || []).filter((j) => ids.indexOf(j.id) >= 0) };
      }
      if (/FROM leads/i.test(text)) {
        const ids = (params && params[0]) || [];
        return { rows: (mockFixture.leads || []).filter((l) => ids.indexOf(l.id) >= 0) };
      }
      return { rows: [] };
    }
  }
}));

const { resolveEntityLabels } = require('../server/services/entity-labels');

// The service runs the SQL COALESCEs, so the fixture rows are shaped the way
// Postgres would hand them back: `num` already NULLIF'd to '', `label`
// already COALESCEd to '' when the job has no title and no name.
function jobRow(id, num, label) {
  return { id: id, num: num, label: label };
}

async function labelFor(id) {
  const out = await resolveEntityLabels(1, [{ entity_type: 'job', entity_id: id }]);
  return out.get('job:' + id);
}

beforeEach(() => {
  mockQueries = [];
  mockFixture = { jobs: [], leads: [] };
});

describe('resolveEntityLabels — job labels are composed by js/job-label.js', () => {
  test('number + title → the owner\'s standard, one space', async () => {
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')];
    expect(await labelFor('j1')).toBe('RV2006 Waterside 1 Siding Replacement');
  });

  test('number, no title → the number alone — NOT "RV2006 Job"', async () => {
    // The regression this file exists for.
    mockFixture.jobs = [jobRow('j1', 'RV2006', '')];
    const label = await labelFor('j1');
    expect(label).toBe('RV2006');
    expect(label).not.toMatch(/\bJob\b/);
  });

  test('title, no number → the title alone, no leading space', async () => {
    mockFixture.jobs = [jobRow('j1', '', 'Waterside 1')];
    expect(await labelFor('j1')).toBe('Waterside 1');
  });

  test('neither → the shared module\'s own fallback, never a bare type word', async () => {
    mockFixture.jobs = [jobRow('j1', '', '')];
    const label = await labelFor('j1');
    expect(label).toBe(jobLabel.DEFAULT_FALLBACK);
    expect(label).toBe('Untitled job');
    // Not the raw entity_type, not the id, not a JS non-value.
    expect(label).not.toBe('job');
    expect(label).not.toContain('j1');
    expect(label).not.toMatch(/undefined|null|NaN/);
  });

  test('a job row that no longer exists yields NO entry (caller decides)', async () => {
    mockFixture.jobs = [];
    expect(await labelFor('j_deleted')).toBeUndefined();
  });

  test('the lookup is BY the ids it was handed — it never widens', async () => {
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1'), jobRow('j2', 'RV2010', 'Somebody Else')];
    const out = await resolveEntityLabels(1, [{ entity_type: 'job', entity_id: 'j1' }]);
    expect([...out.keys()]).toEqual(['job:j1']);
    const jobQ = mockQueries.find((q) => /FROM jobs/i.test(q.sql));
    expect(jobQ.params[0]).toEqual(['j1']);
    // A primary-key lookup over a supplied id array, not a scan.
    expect(jobQ.sql).toMatch(/id::text = ANY\(\$1::text\[\]\)/);
  });

  test('an unknown entity type issues no query at all (fails closed)', async () => {
    const out = await resolveEntityLabels(1, [{ entity_type: 'invoice', entity_id: 'x1' }]);
    expect(out.size).toBe(0);
    expect(mockQueries).toHaveLength(0);
  });
});
