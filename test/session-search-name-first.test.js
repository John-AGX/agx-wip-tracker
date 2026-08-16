// server/services/session-search.js — searching the name you can SEE.
//
// A thread's title is composed per response and stored NOWHERE: `label` holds
// human intent only and is NULL for every derived title, so the old predicate
// `s.label ILIKE '%uptown%'` evaluates NULL on exactly the rows the sidebar
// now titles "Deal · Uptown - Dumpster Pad Repair". The gap was total, not
// partial — only the LLM-written summary and the accident of the name landing
// in a message body could still match.
//
// The fix inverts the lookup instead of denormalising a display_label column
// (which would be the same stale-derived-string defect one column to the
// left). These tests pin the four properties that matters hangs on:
//   1. a derived entity name finds its thread,
//   2. the label / summary / message paths still work,
//   3. the org binding is on the DISCOVERY query, where the caller supplies a
//      name and would otherwise learn whether another tenant has one,
//   4. ranking happens BEFORE the trim, so a name hit cannot be evicted by
//      message-body hits that merely arrived first.

let mockQueries;
let mockRoutes;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      const text = String(sql);
      mockQueries.push({ sql: text, params: params });
      for (const r of mockRoutes) {
        if (r.re.test(text)) return { rows: r.rows(params, text) || [] };
      }
      return { rows: [] };
    }
  }
}));

const { searchSessions } = require('../server/services/session-search');

// ── SQL shape matchers. Discovery reads the same tables resolveEntityLabels
// does, so they are told apart by ILIKE vs `id::text = ANY`.
const DISCOVER = (table) => new RegExp('FROM ' + table + ' WHERE[\\s\\S]*ILIKE');
const RESOLVE = (table) => new RegExp('FROM ' + table + ' WHERE id::text = ANY');
const WALK_JOB_EST = /estimate_id IS NOT NULL/;
const WALK_EST_LEAD = /data->>'lead_id' IS NOT NULL/;
const BRANCH_META = /CASE WHEN s\.label ILIKE/;
const BRANCH_MSG = /JOIN ai_messages/;
const BRANCH_ENTITY = /'entity'::text AS match_kind/;

function route(re, rows) { mockRoutes.push({ re: re, rows: typeof rows === 'function' ? rows : () => rows }); }
function ran(re) { return mockQueries.filter((q) => re.test(q.sql)); }

function session(over) {
  return Object.assign({
    id: 1,
    label: null,
    summary: null,
    entity_type: 'general',
    entity_id: 'global',
    pinned: false,
    last_used_at: '2026-08-16T12:00:00Z',
    turn_count: 3,
    session_kind: 'legacy_partitioned',
    lineage_root: null,
    deal_numbers: null,
    deal_root_type: null,
    match_kind: 'meta',
    match_rank: 2,
    snippet: null
  }, over || {});
}

beforeEach(() => { mockQueries = []; mockRoutes = []; });

// ──────────────────────────────────────────────────────────────────────────
describe('a thread is found by the DERIVED name the sidebar shows', () => {
  test('lead title → candidate id → session anchored to it', async () => {
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    route(BRANCH_ENTITY, [session({
      id: 7, entity_type: 'lead', entity_id: 'lead_1',
      match_kind: 'entity', match_rank: 1
    })]);
    route(RESOLVE('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);

    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(7);
    // The label column is NULL — this row is findable ONLY through the entity.
    expect(results[0].label).toBeNull();
    expect(results[0].display_label).toBe('Uptown - Dumpster Pad Repair');

    // The candidate id really did drive the session query, paired with its type.
    const [entityQ] = ran(BRANCH_ENTITY);
    expect(entityQ.params[1]).toEqual(['lead']);
    expect(entityQ.params[2]).toEqual(['lead_1']);
  });

  test('the entity arm pairs type WITH id — a job id cannot light up a lead thread', async () => {
    route(DISCOVER('jobs'), [{ id: '17', num: 'RV2006', label: 'Waterside' }]);
    route(BRANCH_ENTITY, []);
    await searchSessions({ userId: 5, orgId: 42, q: 'Waterside' });
    const [entityQ] = ran(BRANCH_ENTITY);
    // Row-wise (entity_type, entity_id) against parallel arrays — never a
    // concatenated key, which no index could serve, and never a bare id list,
    // which would collide across types.
    expect(entityQ.sql).toMatch(/\(s\.entity_type, s\.entity_id\) IN/);
    expect(entityQ.sql).not.toMatch(/entity_type \|\| ':'/);
    expect(entityQ.params[1]).toEqual(['job']);
    expect(entityQ.params[2]).toEqual(['17']);
  });

  test('a job matches on number AND title independently (the jobLabel straddle)', async () => {
    route(DISCOVER('jobs'), []);
    await searchSessions({ userId: 5, orgId: 42, q: 'RV2006 Waterside' });
    const [jobQ] = ran(DISCOVER('jobs'));
    // "RV2006 Waterside" exists only as a js/job-label.js composition, in no
    // column — so the tokens are AND-ed across the two component columns
    // rather than matched contiguously against a re-authored concatenation.
    expect(jobQ.params).toEqual([42, '%RV2006%', '%Waterside%']);
    expect(jobQ.sql).toMatch(/ILIKE \$2[\s\S]*AND[\s\S]*ILIKE \$3/);
    expect(jobQ.sql).not.toMatch(/\|\|/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('the paths that already worked still work', () => {
  test('a human-authored label still matches, and outranks a summary hit', async () => {
    route(BRANCH_META, [
      session({ id: 2, label: null, summary: 'siding punch list', match_rank: 2 }),
      session({ id: 3, label: 'Siding notes', match_rank: 1 })
    ]);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'siding' });
    expect(results.map((r) => r.id)).toEqual([3, 2]);
    expect(results[0].display_label).toBe('Siding notes');
  });

  test('a message body still matches, and carries its snippet', async () => {
    route(BRANCH_MSG, [session({
      id: 4, match_kind: 'message', match_rank: 3, snippet: 'we talked about siding on Tuesday'
    })]);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'siding' });
    expect(results).toHaveLength(1);
    expect(results[0].snippet).toBe('we talked about siding on Tuesday');
    expect(results[0].display_label).toBe('General');
  });

  test('the metadata predicate is unchanged — only a rank literal was added', async () => {
    await searchSessions({ userId: 5, orgId: 42, q: 'siding' });
    const [metaQ] = ran(BRANCH_META);
    expect(metaQ.sql).toMatch(/AND \(s\.label ILIKE \$2 OR s\.summary ILIKE \$2\)/);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('org isolation — the discovery query is where the name is probed', () => {
  test('every entity table binds the caller org', async () => {
    await searchSessions({ userId: 5, orgId: 42, q: 'uptown' });
    ['leads', 'clients', 'subs', 'estimates', 'jobs'].forEach((t) => {
      const [q] = ran(DISCOVER(t));
      expect(q).toBeDefined();
      expect(q.sql).toMatch(/\(organization_id = \$1 OR organization_id IS NULL\)/);
      expect(q.params[0]).toBe(42);
    });
  });

  test('projects stay STRICTLY scoped — no OR-IS-NULL arm', async () => {
    await searchSessions({ userId: 5, orgId: 42, q: 'uptown' });
    const [q] = ran(DISCOVER('projects'));
    expect(q.sql).toMatch(/AND organization_id = \$1/);
    expect(q.sql).not.toMatch(/organization_id IS NULL/);
  });

  test("another org's entity name yields no candidates and no results", async () => {
    // The row exists, but it belongs to org 42 and the caller is org 99.
    route(DISCOVER('leads'), (params) => (
      params[0] === 42 ? [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }] : []
    ));
    route(BRANCH_ENTITY, [session({ id: 7, match_kind: 'entity', match_rank: 1 })]);

    const { results } = await searchSessions({ userId: 5, orgId: 99, q: 'Uptown' });
    expect(results).toEqual([]);
    // Not merely filtered afterwards — the session query never ran, so there
    // is no count and no timing signal either.
    expect(ran(BRANCH_ENTITY)).toHaveLength(0);
  });

  test('a null org probes NOTHING — the reverse of the read-side rule', async () => {
    // resolveEntityLabels keeps its unscoped behaviour when the tenant is
    // unknown because the caller already holds the id. Here the caller
    // supplies the NAME, so unscoped means a cross-tenant existence oracle.
    // Declining costs nothing: before this branch existed, a name matched no
    // entity at all.
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown' }]);
    const { results } = await searchSessions({ userId: 5, orgId: null, q: 'Uptown' });
    expect(ran(DISCOVER('leads'))).toHaveLength(0);
    expect(ran(BRANCH_ENTITY)).toHaveLength(0);
    expect(results).toEqual([]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('deal threads', () => {
  test('found by the lineage ROOT entity, and told what matched', async () => {
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    route(BRANCH_ENTITY, [session({
      id: 11, session_kind: 'deal_thread', lineage_root: 'lead_1',
      entity_type: 'job', entity_id: 'j9',
      deal_numbers: { stage: 'job', jobId: 'j9' }, deal_root_type: 'lead',
      match_kind: 'entity', match_rank: 1
    })]);
    route(RESOLVE('jobs'), [{ id: 'j9', num: 'RV2011', label: 'Phase 2' }]);

    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });

    expect(results).toHaveLength(1);
    // The deal has advanced to a job, so it is CALLED by its job — and it is
    // still findable by the lead it started as.
    expect(results[0].display_label).toBe('Deal · RV2011 Phase 2');
    // The title cannot explain this hit, so the row says what did.
    expect(results[0].snippet).toBe('matched lead: Uptown - Dumpster Pad Repair');
    const [entityQ] = ran(BRANCH_ENTITY);
    expect(entityQ.params[3]).toContain('lead_1');
  });

  test('no snippet when the title already contains the term', async () => {
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    route(BRANCH_ENTITY, [session({
      id: 12, entity_type: 'lead', entity_id: 'lead_1',
      match_kind: 'entity', match_rank: 1
    })]);
    route(RESOLVE('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });
    expect(results[0].snippet).toBeNull();
  });

  test('the INTERMEDIATE stage is reachable — computeNumbers writes only one id', async () => {
    // A lead-rooted deal now at job stage carries {stage:'job', jobId} and no
    // estimateId at all, so matching lineage_root + the numbers keys alone
    // would leave the estimate unreachable by name. The walk closes it.
    route(DISCOVER('estimates'), [{ id: 'e5', label: 'Uptown Estimate' }]);
    route(WALK_EST_LEAD, [{ parent: 'lead_1' }]);
    route(BRANCH_ENTITY, []);

    await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });

    const [entityQ] = ran(BRANCH_ENTITY);
    expect(entityQ.params[3].sort()).toEqual(['e5', 'lead_1']);
    // The walk is org-guarded even though its input ids are already verified.
    const [walk] = ran(WALK_EST_LEAD);
    expect(walk.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(walk.params[1]).toBe(42);
  });

  test('a matched job walks up through its estimate to the lead root', async () => {
    route(DISCOVER('jobs'), [{ id: 'j9', num: 'RV2011', label: 'Uptown Rebuild' }]);
    route(WALK_JOB_EST, [{ parent: 'e5' }]);
    route(WALK_EST_LEAD, [{ parent: 'lead_1' }]);
    route(BRANCH_ENTITY, []);
    await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });
    const [entityQ] = ran(BRANCH_ENTITY);
    expect(entityQ.params[3].sort()).toEqual(['e5', 'j9', 'lead_1']);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('ranking decides what SURVIVES, not just what sorts', () => {
  test('a name hit is not evicted by message hits that merely arrived first', async () => {
    // The old code merged [...msgRows, ...metaRows] and trimmed by array
    // position, so this is exactly the pathology a third branch would have
    // made real: message-body fan-out filling every slot.
    route(BRANCH_MSG, [
      session({ id: 21, match_kind: 'message', match_rank: 3, snippet: 'uptown-ish chatter' }),
      session({ id: 22, match_kind: 'message', match_rank: 3, snippet: 'more chatter' })
    ]);
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    route(BRANCH_ENTITY, [session({
      id: 23, entity_type: 'lead', entity_id: 'lead_1', match_kind: 'entity', match_rank: 1
    })]);
    route(RESOLVE('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);

    const { results, total } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown', limit: 2 });

    expect(total).toBe(3);
    expect(results).toHaveLength(2);
    expect(results[0].id).toBe(23);
    expect(results.map((r) => r.id)).not.toContain(22);
  });

  test('dedupe keeps the strongest match and carries the message snippet onto it', async () => {
    route(DISCOVER('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);
    route(BRANCH_ENTITY, [session({
      id: 30, entity_type: 'lead', entity_id: 'lead_1', match_kind: 'entity', match_rank: 1
    })]);
    route(BRANCH_MSG, [session({
      id: 30, entity_type: 'lead', entity_id: 'lead_1',
      match_kind: 'message', match_rank: 3, snippet: 'the uptown pad is cracked'
    })]);
    route(RESOLVE('leads'), [{ id: 'lead_1', label: 'Uptown - Dumpster Pad Repair' }]);

    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });
    expect(results).toHaveLength(1);
    expect(results[0].match_kind).toBe('entity');
    // The reason the old code preferred the message row survives the reorder.
    expect(results[0].snippet).toBe('the uptown pad is cracked');
  });

  test('a pinned thread edges out an unpinned one at the same rank and title score', async () => {
    route(BRANCH_META, [
      session({ id: 41, label: 'Siding A', match_rank: 1, pinned: false, last_used_at: '2026-08-16T12:00:00Z' }),
      session({ id: 42, label: 'Siding B', match_rank: 1, pinned: true, last_used_at: '2026-08-01T12:00:00Z' })
    ]);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'siding' });
    expect(results.map((r) => r.id)).toEqual([42, 41]);
  });
});

// ──────────────────────────────────────────────────────────────────────────
describe('degrades without crashing', () => {
  test('a deleted entity leaves the thread findable and titled by a fallback', async () => {
    // The name no longer exists, so it is not searchable BY that name — but
    // the thread still matches on its summary and must not blow up when the
    // resolver returns nothing for its dangling entity_id.
    route(BRANCH_META, [session({
      id: 51, entity_type: 'lead', entity_id: 'lead_gone', summary: 'uptown pad notes', match_rank: 2
    })]);
    route(RESOLVE('leads'), []);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'uptown' });
    expect(results).toHaveLength(1);
    expect(results[0].display_label).toBe('Untitled lead');
  });

  test('a failing discovery query falls back to the old behaviour, not a 500', async () => {
    mockRoutes.push({ re: DISCOVER('leads'), rows: () => { throw new Error('boom'); } });
    route(BRANCH_META, [session({ id: 52, label: 'Uptown notes', match_rank: 1 })]);
    const { results } = await searchSessions({ userId: 5, orgId: 42, q: 'Uptown' });
    expect(results.map((r) => r.id)).toEqual([52]);
  });

  test('an all-short term probes no entity tables at all', async () => {
    // A trigram index cannot serve a pattern with fewer than three extractable
    // characters, and the search box fires on a 180ms debounce with no minimum
    // length — so short tokens are dropped rather than sequential-scanning the
    // jobs/estimates JSONB heaps on every keystroke.
    await searchSessions({ userId: 5, orgId: 42, q: 'up' });
    expect(ran(DISCOVER('jobs'))).toHaveLength(0);
    expect(ran(DISCOVER('estimates'))).toHaveLength(0);
    expect(ran(BRANCH_ENTITY)).toHaveLength(0);
    // The label / summary / body branches are untouched by that gate.
    expect(ran(BRANCH_META)).toHaveLength(1);
  });

  test('the candidate ceiling is deterministic, not heap order', async () => {
    await searchSessions({ userId: 5, orgId: 42, q: 'repair' });
    const [q] = ran(DISCOVER('leads'));
    expect(q.sql).toMatch(/ORDER BY id LIMIT 200/);
  });

  test('an empty query does no work', async () => {
    const { results, total } = await searchSessions({ userId: 5, orgId: 42, q: '   ' });
    expect(results).toEqual([]);
    expect(total).toBe(0);
    expect(mockQueries).toHaveLength(0);
  });
});
