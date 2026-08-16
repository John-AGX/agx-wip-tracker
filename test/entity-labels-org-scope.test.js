// server/services/entity-labels.js — the tenant guard.
//
// Why this file exists: the ids handed to this resolver are not trustworthy.
// ai_sessions.entity_id is whatever the caller POSTed (ai-sessions-routes.js
// stores `b.entity_id` with no existence or ownership check), and the session
// list now resolves those ids into NAMES. Unscoped, that is a batched
// cross-tenant name oracle — mint N sessions pointing at another org's leads,
// read the list back, collect the titles. Every table below carries
// organization_id, indexed, and the single-row twin in ai-routes.js
// (resolveTaskEntityLabel) already guards this way.
//
// The guard is applied only when the caller supplies an org, so the four
// pre-existing callers that pass `|| null` on a legacy token keep working
// exactly as they did — tighten where the tenant is known, never break where
// it isn't.

let mockQueries;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      mockQueries.push({ sql: String(sql), params: params });
      return { rows: [] };
    }
  }
}));

const { resolveEntityLabels } = require('../server/services/entity-labels');

const SCOPED_TYPES = ['lead', 'client', 'sub', 'estimate', 'job'];

function queryFor(type) {
  const table = type === 'sub' ? 'subs' : type + 's';
  return mockQueries.find((q) => new RegExp('FROM ' + table + '\\b', 'i').test(q.sql));
}

beforeEach(() => { mockQueries = []; });

describe('org scoping', () => {
  test.each(SCOPED_TYPES)('%s binds the caller org into the lookup', async (type) => {
    await resolveEntityLabels(42, [{ entity_type: type, entity_id: 'x1' }]);
    const q = queryFor(type);
    expect(q).toBeDefined();
    expect(q.sql).toMatch(/organization_id = \$2/);
    expect(q.params[1]).toBe(42);
  });

  test('projects stay STRICTLY scoped — no OR-IS-NULL arm, as before', async () => {
    await resolveEntityLabels(42, [{ entity_type: 'project', entity_id: '9' }]);
    const q = mockQueries.find((x) => /FROM projects/i.test(x.sql));
    expect(q.sql).toMatch(/AND organization_id = \$2/);
    expect(q.sql).not.toMatch(/organization_id IS NULL/);
  });

  test('a null org leaves the query as it was — no silent empty result', async () => {
    await resolveEntityLabels(null, [{ entity_type: 'lead', entity_id: 'lead_1' }]);
    const q = queryFor('lead');
    expect(q.sql).not.toMatch(/organization_id/);
    expect(q.params).toHaveLength(1);
  });
});

describe('an estimate with no name yields empty, not the bare word', () => {
  test("the SQL COALESCEs to '' — same reasoning as the job branch", async () => {
    await resolveEntityLabels(42, [{ entity_type: 'estimate', entity_id: 'e1' }]);
    const q = queryFor('estimate');
    // A synthetic type word reaching a forward-facing surface as if it were a
    // real name is the "RV2006 Job" defect the job branch already fixed.
    expect(q.sql).toContain("data->>'title', '')");
    expect(q.sql).not.toContain("'Estimate'");
  });
});
