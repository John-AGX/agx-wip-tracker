// test/agent-tool-description-cap.test.js — the silent 1024-char cut.
//
// toCustomToolParam truncated every managed-agent tool description at 1024
// chars with a bare `slice()`. emit_payload_file — the Scribe's ONLY tool,
// the one that performs every money write — was 4694 chars, so 3673 were
// discarded on every registration with nothing logged.
//
// And a tail-cut is not neutral about WHAT it deletes: it deletes whatever
// was written most recently. The retired node-graph ops (node_values,
// wire_updates, qb_assignments, graph) sat near the top and survived; task,
// todo, reminder, calendar_event and the target forms were appended later and
// were simply gone. The Assistant baseline was, at the same time, instructing
// scribe_write with entity_type 'calendar_event' and 'task'.
//
// Two things are pinned here: the cap now reports itself, and the live
// description fits inside it.
//
// A valid JWT_SECRET is set BEFORE requiring the AI internals — ai-routes
// pulls in auth.js, which hard-fails without one (A1). This is a local
// value, so the test does not depend on the environment having a secret.
process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const {
  AGENT_TOOL_DESC_CAP, capToolDescription,
} = require('../server/services/agent-tool-description');

describe('capToolDescription', () => {
  test('a description inside the cap passes through untouched and silent', () => {
    const d = 'x'.repeat(AGENT_TOOL_DESC_CAP);
    const r = capToolDescription('some_tool', d);
    expect(r.description).toBe(d);
    expect(r.truncated).toBe(false);
    expect(r.warning).toBeNull();
  });

  test('one char over truncates AND warns — never silently', () => {
    const r = capToolDescription('some_tool', 'x'.repeat(AGENT_TOOL_DESC_CAP + 1));
    expect(r.truncated).toBe(true);
    expect(r.overBy).toBe(1);
    expect(r.warning).toBeTruthy();
    expect(r.description.length).toBe(AGENT_TOOL_DESC_CAP);
  });

  test('the warning names the tool and measures the overflow', () => {
    const r = capToolDescription('emit_payload_file', 'x'.repeat(4694));
    expect(r.warning).toContain('emit_payload_file');
    expect(r.warning).toContain('4694');
    expect(r.warning).toContain(String(4694 - AGENT_TOOL_DESC_CAP));
  });

  test('the warning says the TAIL is what disappears', () => {
    // The whole reason this defect was invisible: people assume truncation
    // costs you detail, not entire capabilities.
    const r = capToolDescription('t', 'x'.repeat(2000));
    expect(r.warning).toMatch(/TAIL/);
    expect(r.warning).toMatch(/INVISIBLE/);
  });

  test('it steers to the system baseline, not to raising the cap', () => {
    const r = capToolDescription('t', 'x'.repeat(2000));
    expect(r.warning).toMatch(/baseline/i);
    expect(r.warning).toMatch(/do NOT raise the cap/i);
  });

  test('the truncated output never exceeds the cap', () => {
    for (const n of [1025, 1500, 4694, 20000]) {
      expect(capToolDescription('t', 'x'.repeat(n)).description.length)
        .toBeLessThanOrEqual(AGENT_TOOL_DESC_CAP);
    }
  });

  test('a missing description is not a crash', () => {
    expect(capToolDescription('t', null).description).toBe('');
    expect(capToolDescription('t', undefined).truncated).toBe(false);
  });
});

describe('emit_payload_file survives registration intact', () => {
  const tool = require('../server/routes/ai-routes-internals')
    .payloadTools()
    .find((t) => t.name === 'emit_payload_file');

  test('it exists', () => {
    expect(tool).toBeDefined();
  });

  test('the description fits under the cap — nothing is cut', () => {
    const r = capToolDescription(tool.name, tool.description);
    expect(r.truncated).toBe(false);
  });

  test('the LIVE vocabulary that used to fall past the cut is present', () => {
    for (const t of ['task', 'todo', 'reminder', 'calendar_event', 'deal_memory',
                     'assembly', 'estimate', 'job', 'schedule', 'report', 'system']) {
      expect(tool.description).toContain(t);
    }
  });

  test('the target forms are present', () => {
    expect(tool.description).toMatch(/upsert/);
    expect(tool.description).toMatch(/bulk/);
    expect(tool.description).toMatch(/move/);
  });

  test('the retired node-graph ops are GONE from the vocabulary', () => {
    for (const dead of ['node_values', 'wire_updates', 'qb_assignments']) {
      expect(tool.description).not.toContain(dead);
    }
  });

  test('the entity_type enum still offers every type the description names', () => {
    const en = tool.input_schema.properties.targets.items.properties.entity_type.enum;
    for (const t of ['estimate', 'job', 'lead', 'client', 'schedule', 'system',
                     'report', 'calendar_event', 'task', 'todo', 'reminder',
                     'assembly', 'deal_memory']) {
      expect(en).toContain(t);
    }
  });
});
