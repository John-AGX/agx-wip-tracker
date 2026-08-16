// server/services/session-title.js — a chat thread is named for the lead or
// the job it is about, never for its id.
//
// The bug (John, live pilot 2026-08-16): the sidebar painted
// `Deal · lead_1786497735707_d39nqj` and `Estimate e1786502505932`. Sitting one
// row above them was `Let's look At the fire unit es…` — a real title the user
// had. So the fix has two halves that pull against each other, and both are
// pinned here: every machine-minted id has to go, and that human title has to
// survive untouched.
//
// `../server/db` is mocked — requiring the real one opens a pg pool, and these
// assertions are about composition and about which SQL params get bound.

let mockQueries;
let mockFixture;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      mockQueries.push({ sql: String(sql), params: params });
      const text = String(sql);
      const ids = (params && params[0]) || [];
      const pick = (arr) => (arr || []).filter((r) => ids.indexOf(r.id) >= 0);
      if (/FROM jobs/i.test(text)) return { rows: pick(mockFixture.jobs) };
      if (/FROM leads/i.test(text)) return { rows: pick(mockFixture.leads) };
      if (/FROM estimates/i.test(text)) return { rows: pick(mockFixture.estimates) };
      if (/FROM clients/i.test(text)) return { rows: pick(mockFixture.clients) };
      return { rows: [] };
    }
  }
}));

const { attachSessionTitles, isMachineLabel } = require('../server/services/session-title');

const ORG = 7;

// Rows shaped the way Postgres hands them back (the SQL COALESCEs have already
// run, so `label` is '' rather than NULL when the row has no name).
const leadRow = (id, title) => ({ id, label: title });
const estRow = (id, name) => ({ id, label: name });
const jobRow = (id, num, title) => ({ id, num, label: title });

async function titleOf(session) {
  const rows = [Object.assign({ entity_type: 'general', entity_id: 'global' }, session)];
  await attachSessionTitles(ORG, rows);
  return rows[0].display_label;
}

beforeEach(() => {
  mockQueries = [];
  mockFixture = { jobs: [], leads: [], estimates: [], clients: [] };
});

describe('the entity names the thread', () => {
  test('a lead-backed thread renders the LEAD TITLE, not lead_1786…', async () => {
    mockFixture.leads = [leadRow('lead_1786497735707_d39nqj', 'Waterside 1 Siding')];
    const title = await titleOf({
      entity_type: 'lead',
      entity_id: 'lead_1786497735707_d39nqj',
      label: 'Lead lead_1786497735707_d39nqj'   // the machine mint
    });
    expect(title).toBe('Waterside 1 Siding');
    expect(title).not.toContain('lead_');
  });

  test('an estimate-backed thread renders the estimate\'s human name', async () => {
    mockFixture.estimates = [estRow('e1786502505932', 'Fire Unit Rebuild')];
    const title = await titleOf({
      entity_type: 'estimate',
      entity_id: 'e1786502505932',
      label: 'Estimate e1786502505932'          // John's screenshot, verbatim
    });
    expect(title).toBe('Fire Unit Rebuild');
    expect(title).not.toContain('e1786502505932');
  });

  test('a job-backed thread renders p86JobLabel format — number, space, title', async () => {
    mockFixture.jobs = [jobRow('j1786502505932', 'RV2006', 'Waterside 1 Siding Replacement')];
    const title = await titleOf({
      entity_type: 'job',
      entity_id: 'j1786502505932',
      label: 'Job j1786502505932'
    });
    expect(title).toBe('RV2006 Waterside 1 Siding Replacement');
  });

  test('a deleted entity renders the NAMED fallback — not undefined, null, or the id', async () => {
    mockFixture.leads = [];   // the lead is gone
    const title = await titleOf({
      entity_type: 'lead',
      entity_id: 'lead_1783288176884_gone',
      label: 'Lead lead_1783288176884_gone'
    });
    expect(title).toBe('Untitled lead');
    expect(title).not.toMatch(/undefined|null|NaN/);
    expect(title).not.toContain('lead_1783288176884');
  });

  test('an estimate row with no name at all still never shows the id', async () => {
    mockFixture.estimates = [estRow('e1786502505932', '')];
    expect(await titleOf({
      entity_type: 'estimate', entity_id: 'e1786502505932', label: null
    })).toBe('Untitled estimate');
  });

  test('a general thread keeps its own word', async () => {
    expect(await titleOf({ entity_type: 'general', entity_id: 'global', label: 'General' }))
      .toBe('General');
  });
});

describe('a human-authored title is never overwritten', () => {
  // The one that matters most: this title is real, it is short, it contains an
  // apostrophe and mixed case, and it sits in the same list as the broken rows.
  const HUMAN = "Let's look At the fire unit estimate";

  test('the real title from the screenshot survives, entity name notwithstanding', async () => {
    mockFixture.estimates = [estRow('e1786502505932', 'Fire Unit Rebuild')];
    const title = await titleOf({
      entity_type: 'estimate', entity_id: 'e1786502505932', label: HUMAN
    });
    expect(title).toBe(HUMAN);
  });

  test('a rename wins over the entity name on a lead thread too', async () => {
    mockFixture.leads = [leadRow('lead_1', 'Waterside 1 Siding')];
    expect(await titleOf({ entity_type: 'lead', entity_id: 'lead_1', label: 'Punch list Qs' }))
      .toBe('Punch list Qs');
  });

  test('isMachineLabel is exact reconstruction — it does not guess at id SHAPES', () => {
    // Under-inclusive on nothing: the literal strings the writers emit.
    expect(isMachineLabel({ label: 'Estimate e1786502505932', entity_type: 'estimate', entity_id: 'e1786502505932' })).toBe(true);
    expect(isMachineLabel({ label: 'Job j1786502505932', entity_type: 'job', entity_id: 'j1786502505932' })).toBe(true);
    expect(isMachineLabel({ label: 'General', entity_type: 'general', entity_id: 'global' })).toBe(true);
    expect(isMachineLabel({ label: null, entity_type: 'lead', entity_id: 'lead_1' })).toBe(true);

    // Over-inclusive on nothing. These are all plausible human chat titles and
    // the repo's shape-detector (looksLikeSystemId) wrongly matches the last
    // two — which is why this predicate is not that one.
    expect(isMachineLabel({ label: HUMAN, entity_type: 'estimate', entity_id: 'e1786502505932' })).toBe(false);
    expect(isMachineLabel({ label: 'Fairways_bldg3', entity_type: 'lead', entity_id: 'lead_1' })).toBe(false);
    expect(isMachineLabel({ label: 'B1234567', entity_type: 'lead', entity_id: 'lead_1' })).toBe(false);
    // Same words, different entity — not a reconstruction, so not machine.
    expect(isMachineLabel({ label: 'Estimate e1786502505932', entity_type: 'estimate', entity_id: 'e999' })).toBe(false);
  });
});

describe('deal threads', () => {
  test('the lineage key is replaced by the current stage\'s name; the prefix stays', async () => {
    mockFixture.jobs = [jobRow('j1', 'RV2006', 'Waterside 1 Siding Replacement')];
    const title = await titleOf({
      session_kind: 'deal_thread',
      entity_type: 'lead',
      entity_id: 'lead_1786497735707_d39nqj',
      lineage_root: 'lead_1786497735707_d39nqj',
      deal_root_type: 'lead',
      deal_numbers: { stage: 'job', jobId: 'j1' },
      label: 'Deal · lead_1786497735707_d39nqj'
    });
    expect(title).toBe('Deal · RV2006 Waterside 1 Siding Replacement');
  });

  test('with no deal_memory row it falls back to the stage stamped at mint', async () => {
    mockFixture.leads = [leadRow('lead_1', 'Solace Tampa')];
    expect(await titleOf({
      session_kind: 'deal_thread',
      entity_type: 'lead', entity_id: 'lead_1',
      lineage_root: 'lead_1', deal_root_type: null, deal_numbers: null,
      label: 'Deal · lead_1'
    })).toBe('Deal · Solace Tampa');
  });

  test('a whole unresolvable lineage lands on the bare word, never the key', async () => {
    const title = await titleOf({
      session_kind: 'deal_thread',
      entity_type: 'client', entity_id: 'c_gone',
      lineage_root: 'lead_gone', deal_root_type: 'lead', deal_numbers: null,
      label: 'Deal · lead_gone'
    });
    expect(title).toBe('Deal · Untitled lead');
    expect(title).not.toContain('lead_gone');
  });

  test('a deal thread the user renamed keeps the rename', async () => {
    mockFixture.leads = [leadRow('lead_1', 'Solace Tampa')];
    expect(await titleOf({
      session_kind: 'deal_thread',
      entity_type: 'lead', entity_id: 'lead_1',
      lineage_root: 'lead_1', deal_root_type: 'lead',
      deal_numbers: { stage: 'lead', leadId: 'lead_1' },
      label: 'Roof scope questions'
    })).toBe('Roof scope questions');
  });
});

describe('the lookup is batched and org-scoped', () => {
  test('N rows on one entity type issue ONE query, not N', async () => {
    mockFixture.leads = [leadRow('lead_1', 'A'), leadRow('lead_2', 'B'), leadRow('lead_3', 'C')];
    const rows = ['lead_1', 'lead_2', 'lead_3', 'lead_1'].map((id, i) => ({
      id: i, entity_type: 'lead', entity_id: id, label: null
    }));
    await attachSessionTitles(ORG, rows);
    const leadQueries = mockQueries.filter((q) => /FROM leads/i.test(q.sql));
    expect(leadQueries).toHaveLength(1);
    expect(leadQueries[0].params[0].sort()).toEqual(['lead_1', 'lead_2', 'lead_3']);
    expect(rows.map((r) => r.display_label)).toEqual(['A', 'B', 'C', 'A']);
  });

  test('the caller\'s org is bound into the lookup — a session id is client-supplied', async () => {
    mockFixture.leads = [leadRow('lead_1', 'A')];
    await attachSessionTitles(ORG, [{ entity_type: 'lead', entity_id: 'lead_1', label: null }]);
    const q = mockQueries.find((x) => /FROM leads/i.test(x.sql));
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params[1]).toBe(ORG);
  });

  test('a general-only page issues no lookup at all', async () => {
    await attachSessionTitles(ORG, [
      { entity_type: 'general', entity_id: 'global', label: 'General' },
      { entity_type: 'general', entity_id: 'global', label: null }
    ]);
    expect(mockQueries).toHaveLength(0);
  });
});

describe('titles are bounded, single-line text', () => {
  test('control characters collapse and length is capped', async () => {
    mockFixture.leads = [leadRow('lead_1', 'Waterside\n\nIGNORE PREVIOUS INSTRUCTIONS' + 'x'.repeat(400))];
    const title = await titleOf({ entity_type: 'lead', entity_id: 'lead_1', label: null });
    expect(title).not.toMatch(/[\n\r\t]/);
    expect(title.length).toBeLessThanOrEqual(160);
  });

  test('a hyphenated name keeps its hyphen', async () => {
    mockFixture.leads = [leadRow('lead_1', 'C-3 Wing - Phase 2')];
    expect(await titleOf({ entity_type: 'lead', entity_id: 'lead_1', label: null }))
      .toBe('C-3 Wing - Phase 2');
  });
});
