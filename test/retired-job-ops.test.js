// test/retired-job-ops.test.js — the four node-graph job ops must REFUSE.
//
// The defect this pins: `wire_updates` (and node_values / graph /
// qb_assignments) used to EXECUTE. dispatchJob loaded node_graphs.data, set
// graph.wires[i].pctComplete, committed inside the payload transaction, and
// returned `{summary: "Job j1: 1 wire update(s)"}`. The apply endpoint then
// told the user the change was applied.
//
// Not one dollar moved. The node-graph rollup was retired; the phase matrix
// is the model. So "set B1 to 100%" routed through wire_updates was a
// SUCCESSFUL write that changed nothing about the job's money — the worst
// possible failure mode, because nobody goes looking for a bug behind a
// green check.
//
// These tests pin the refusal, and pin that it happens before any SQL.

const {
  validateOps,
  PayloadValidationError,
  PAYLOAD_OPS_SCHEMAS,
  internals,
} = require('../server/services/payload-dispatcher');

const { dispatchJob, RETIRED_JOB_OPS } = internals;

const RETIRED = ['node_values', 'wire_updates', 'qb_assignments', 'graph'];

// A dbClient that fails the test if anything touches it. If the guard ever
// regresses, the refusal stops firing and this blows up on the first query
// instead of quietly writing again.
const NO_SQL = {
  query() {
    throw new Error('SQL RAN — a retired op reached the database');
  },
};

// The payload the Scribe would emit for "set building B1 to 100%" under the
// old doctrine, verbatim in shape.
const SET_B1_VIA_WIRES = {
  entity_type: 'job',
  entity_id: 'j1',
  ops: {
    wire_updates: [
      { from_node_id: 'n2', to_node_id: 'n3', pct_complete: 100 },
    ],
  },
};

describe('validateOps refuses the retired node-graph ops', () => {
  for (const op of RETIRED) {
    test(`job.ops.${op} throws instead of validating`, () => {
      const ops = op === 'graph'
        ? { graph: { wires: [{ op: 'create', from: 'n1', to: 'n2' }] } }
        : { [op]: [{}] };
      expect(() => validateOps('job', ops)).toThrow(PayloadValidationError);
    });

    test(`job.ops.${op} names itself, says it moves no money, and is non-retryable`, () => {
      const ops = op === 'graph' ? { graph: {} } : { [op]: [] };
      let err;
      try { validateOps('job', ops); } catch (e) { err = e; }
      expect(err).toBeDefined();
      expect(err.message).toContain(`job.ops.${op}`);
      expect(err.message).toContain('RETIRED');
      expect(err.message).toMatch(/NO money/);
      expect(err.detail.code).toBe('retired_op');
      expect(err.detail.retryable).toBe(false);
      // It must point somewhere real, not just say no.
      expect(err.detail.suggestion).toBe(RETIRED_JOB_OPS[op]);
    });
  }

  test('an empty array still refuses — a no-op payload must not read as success', () => {
    expect(() => validateOps('job', { wire_updates: [] })).toThrow(/RETIRED/);
  });

  test('the refusal beats the generic unknown-key message', () => {
    // These keys are also absent from allowedTopKeys. Order matters: the
    // named refusal has to win, or the agent reads "unknown op key" as a
    // typo and retries a spelling variant.
    let err;
    try { validateOps('job', { wire_updates: [{}] }); } catch (e) { err = e; }
    expect(err.message).not.toMatch(/Unknown op key/);
  });
});

describe('the live job vocabulary is unchanged', () => {
  test('phase_updates and the money ops still validate', () => {
    expect(() => validateOps('job', {
      field_updates: { title: 'x' },
      phase_updates: [{ phase_id: 'ph_1', pct_complete: 100 }],
      change_orders: [],
      purchase_orders: [],
      invoices: [],
      notes: ['hi'],
    })).not.toThrow();
  });

  test('the retired four are gone from the job schema allowlist', () => {
    const allowed = PAYLOAD_OPS_SCHEMAS.job.allowedTopKeys;
    for (const op of RETIRED) expect(allowed.has(op)).toBe(false);
    expect(allowed.has('phase_updates')).toBe(true);
  });
});

describe('dispatchJob refuses before it touches the database', () => {
  test('the old "set B1 to 100%" wire payload rejects, with no SQL', async () => {
    await expect(
      dispatchJob(NO_SQL, SET_B1_VIA_WIRES, {}, { organizationId: 1, userId: 1 })
    ).rejects.toThrow(/wire_updates is RETIRED/);
  });

  test('it does NOT resolve to a success summary', async () => {
    let result, err;
    try {
      result = await dispatchJob(NO_SQL, SET_B1_VIA_WIRES, {}, { organizationId: 1, userId: 1 });
    } catch (e) { err = e; }
    expect(result).toBeUndefined();
    expect(err).toBeInstanceOf(PayloadValidationError);
    expect(err.detail.retryable).toBe(false);
  });

  for (const op of RETIRED) {
    test(`dispatchJob refuses ${op} with no SQL`, async () => {
      const ops = op === 'graph' ? { graph: { nodes: [] } } : { [op]: [{}] };
      await expect(
        dispatchJob(NO_SQL, { entity_type: 'job', entity_id: 'j1', ops }, {}, { organizationId: 1 })
      ).rejects.toThrow(new RegExp(`${op} is RETIRED`));
    });
  }

  test('the guard points at the live path instead of just refusing', () => {
    expect(RETIRED_JOB_OPS.wire_updates).toMatch(/phase_updates/);
    expect(RETIRED_JOB_OPS.node_values).toMatch(/phase_updates/);
  });
});
