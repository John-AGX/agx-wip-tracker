// The agent-reachable writes: the door with the least human review.
//
// F4's tell, restated. field_tools has THREE create doors. The human one
// (field-tools-routes.js) stamps organization_id. BOTH agent doors —
// ai-routes.js's approval executor and payload-dispatcher.js's field_tool_ops —
// did not, so the table already holds non-uniform data in production. That is
// what tells you these were never audited as a set.
//
// Two consequences, not one. An un-stamped row is not hidden from everyone: it
// is visible to EVERY tenant, because the edit and delete arms carry
// `OR organization_id IS NULL` to keep legacy tools reachable. And the unique
// index is on (organization_id, name) — in Postgres NULLs never collide, so
// agent-created tools could pile up under one name and could never conflict
// with a real org's tool of the same name.
//
// AND WORSE THAN THE SCAN REPORTED. The dispatcher's edit/delete arms have
// carried the org predicate and an `is_system = false` guard since P0-2. The
// ai-routes copies of the same two operations had NEITHER, so one agent path
// could edit or DELETE a built-in tool, or another tenant's tool, by id. A
// finding that counts un-stamped INSERTs cannot see that; only reading the
// doors as a set can.
//
// F5 is here too: resolveJobTarget's "is this already a canonical row id"
// probe. Every downstream write carries a predicate, so it was never a write —
// but it answered TRUE for another tenant's job and FALSE for a string that is
// nothing, which is an existence oracle over the jobs table from an agent
// payload.

const fs = require('fs');
const path = require('path');

const read = (...p) => fs.readFileSync(path.join(__dirname, '..', ...p), 'utf8');
const AI = read('server', 'routes', 'ai-routes.js');
const MSG = read('server', 'routes', 'message-routes.js');
const FIELD_TOOLS = read('server', 'routes', 'field-tools-routes.js');

const { internals } = require('../server/services/payload-dispatcher');
const { resolveJobTarget, dispatchSystem } = internals;

// A runner that records every statement and answers from a fixture.
function recorder(answers) {
  const queries = [];
  return {
    queries,
    query: async (sql, params) => {
      queries.push({ sql: String(sql), params: params || [] });
      for (const key of Object.keys(answers || {})) {
        if (String(sql).includes(key)) return answers[key](String(sql), params || []);
      }
      return { rows: [], rowCount: 0 };
    }
  };
}

/* ═══════════════════════════════════════════════════════════════════════════
 * F5 — the probe nobody wrote to.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('resolveJobTarget cannot confirm another tenant\'s job id', () => {
  test('the id probe binds the caller org', async () => {
    const r = recorder({ 'SELECT 1 FROM jobs': () => ({ rowCount: 1, rows: [{}] }) });
    await resolveJobTarget(r, 'j1778', 7);
    const probe = r.queries[0];
    expect(probe.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(probe.params[1]).toBe(7);
  });

  test('an in-org id still passes straight through', async () => {
    const r = recorder({ 'SELECT 1 FROM jobs': () => ({ rowCount: 1, rows: [{}] }) });
    expect(await resolveJobTarget(r, 'j1778', 7)).toBe('j1778');
  });

  test('a foreign id falls through to the jobNumber branch and out, like a typo', async () => {
    // The scoped probe returns nothing, so the id is NOT treated as canonical.
    // The jobNumber lookup has been org-scoped since it was written, so it
    // finds nothing either, and the caller gets "Job not found".
    const r = recorder({
      'SELECT 1 FROM jobs': () => ({ rowCount: 0, rows: [] }),
      "data->>'jobNumber'": () => ({ rowCount: 0, rows: [] })
    });
    expect(await resolveJobTarget(r, 'j_theirs', 7)).toBe('j_theirs');
    const byNum = r.queries.find((q) => /jobNumber/.test(q.sql));
    expect(byNum.sql).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
  });

  test('a $ref and an empty id are untouched — no statement at all', async () => {
    const r = recorder({});
    expect(await resolveJobTarget(r, '$ref:job1', 7)).toBe('$ref:job1');
    expect(await resolveJobTarget(r, '', 7)).toBe('');
    expect(r.queries.length).toBe(0);
  });

  test('the ambiguous-jobNumber refusal still fires', async () => {
    const r = recorder({
      'SELECT 1 FROM jobs': () => ({ rowCount: 0, rows: [] }),
      "data->>'jobNumber'": () => ({ rowCount: 2, rows: [{ id: 'a' }, { id: 'b' }] })
    });
    await expect(resolveJobTarget(r, 'RV2000', 7)).rejects.toThrow(/Ambiguous job number/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F4 — the field_tools agent door in the dispatcher.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('field_tool_ops (payload dispatcher)', () => {
  const target = (ops) => ({ entity_type: 'system', entity_id: null, ops });

  test('create stamps the org from ctx', async () => {
    const r = recorder({});
    await dispatchSystem(r, target({
      field_tool_ops: [{ op: 'create', fields: { name: 'Pitch calc', html_body: '<p>x</p>' } }]
    }), {}, { userId: 3, organizationId: 7 });
    const ins = r.queries.find((q) => /INSERT INTO field_tools/i.test(q.sql));
    expect(ins.sql).toMatch(/organization_id\)/);
    expect(ins.params[6]).toBe(7);
  });

  test('the org is never taken from the payload fields', async () => {
    const r = recorder({});
    await dispatchSystem(r, target({
      field_tool_ops: [{ op: 'create', fields: { name: 'X', html_body: '<p>x</p>', organization_id: 999 } }]
    }), {}, { userId: 3, organizationId: 7 });
    const ins = r.queries.find((q) => /INSERT INTO field_tools/i.test(q.sql));
    expect(ins.params).not.toContain(999);
    expect(ins.params[6]).toBe(7);
  });

  test('no resolvable org REFUSES rather than writing NULL', async () => {
    // A NULL-org tool is visible to every tenant and cannot collide on the
    // (organization_id, name) unique index. "I could not tell" has to stop the
    // write, not pick the permissive answer.
    const r = recorder({});
    await expect(dispatchSystem(r, target({
      field_tool_ops: [{ op: 'create', fields: { name: 'X', html_body: '<p>x</p>' } }]
    }), {}, { userId: 3, organizationId: null })).rejects.toThrow(/organization/i);
    expect(r.queries.some((q) => /INSERT INTO field_tools/i.test(q.sql))).toBe(false);
  });

  test('edit and delete keep the org predicate and the is_system guard', async () => {
    const r = recorder({ 'field_tools': () => ({ rowCount: 1, rows: [{}] }) });
    await dispatchSystem(r, target({
      field_tool_ops: [
        { op: 'edit', tool_id: 'ft_1', fields: { name: 'Y' } },
        { op: 'delete', tool_id: 'ft_2' }
      ]
    }), {}, { userId: 3, organizationId: 7 });
    const u = r.queries.find((q) => /UPDATE field_tools/i.test(q.sql));
    const d = r.queries.find((q) => /DELETE FROM field_tools/i.test(q.sql));
    for (const q of [u, d]) {
      expect(q.sql).toMatch(/organization_id = \$\d+ OR organization_id IS NULL/);
      expect(q.sql).toMatch(/is_system = false/);
      expect(q.params).toContain(7);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F4 — the OTHER field_tools agent door, in ai-routes.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('execFieldToolApproval (ai-routes)', () => {
  // Not exported, and requiring ai-routes for one function pulls the whole
  // agent surface in. Asserted against the source of that one function.
  function fnBody(src, name) {
    const start = src.indexOf('async function ' + name + '(');
    expect(start).toBeGreaterThan(-1);
    const rest = src.slice(start);
    const end = rest.search(/\r?\n\}\r?\n/);
    expect(end).toBeGreaterThan(-1);
    return rest.slice(0, end);
  }
  const FN = fnBody(AI, 'execFieldToolApproval');

  test('it takes an orgId at all — the signature is the fix', () => {
    expect(FN.slice(0, 200)).toMatch(/execFieldToolApproval\(name, input, userId, orgId\)/);
  });

  test('the create stamps it, and refuses without one', () => {
    expect(FN).toMatch(/INSERT INTO field_tools \(id, name, description, category, html_body, created_by, organization_id\)/);
    expect(FN).toMatch(/if \(!orgId\) throw new Error\(/);
  });

  test('the update is scoped and cannot touch a system tool', () => {
    const seg = FN.slice(FN.indexOf("propose_update_field_tool"), FN.indexOf('propose_delete_field_tool'));
    expect(seg).toMatch(/organization_id = \$\$\{params\.length\} OR organization_id IS NULL/);
    expect(seg).toMatch(/is_system = false/);
    expect(seg).not.toMatch(/WHERE id = \$\$\{p\} RETURNING/);   // the unscoped form is gone
  });

  test('the delete is scoped and cannot touch a system tool', () => {
    const seg = FN.slice(FN.indexOf("propose_delete_field_tool"));
    expect(seg).toMatch(/organization_id = \$2 OR organization_id IS NULL/);
    expect(seg).toMatch(/is_system = false/);
    expect(AI).not.toMatch(/DELETE FROM field_tools WHERE id = \$1 RETURNING name/);
  });

  test('the caller hands it a SERVER-derived org, not one from the tool input', () => {
    expect(AI).toMatch(
      /execFieldToolApproval\(r\.name, r\.input \|\| \{\}, req\.user\.id, req\.organization && req\.organization\.id\)/);
  });

  test('the human door it now matches has always stamped', () => {
    // Stated as a test so the three doors stay in agreement.
    expect(FIELD_TOOLS).toMatch(/INSERT INTO field_tools \([^)]*organization_id/);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * F4 — messages, both doors.
 * ══════════════════════════════════════════════════════════════════════════*/
describe('messages are stamped off the author', () => {
  const STAMP = /INSERT INTO messages \(id, thread_key, user_id, body, organization_id\)\s*\r?\n?\s*VALUES \(\$1, \$2, \$3, \$4, \(SELECT organization_id FROM users WHERE id = \$3\)\)/;

  test('the human door (message-routes) stamps', () => {
    expect(MSG).toMatch(STAMP);
    expect(MSG).not.toMatch(/INSERT INTO messages \(id, thread_key, user_id, body\) VALUES/);
  });

  test('the agent door (ai-routes add_photo_comment) stamps identically', () => {
    expect(AI).toMatch(STAMP);
    expect(AI).not.toMatch(/INSERT INTO messages \(id, thread_key, user_id, body\) VALUES/);
  });

  test('the stamp is a subselect, so the two pointers cannot disagree', () => {
    // A caller-derived org is forgeable through user_id and can disagree with
    // the row it names. This is the same rule a243b76 applied to job_subs.
    expect(STAMP.source).toMatch(/SELECT organization_id FROM users WHERE id = \\\$3/);
  });
});
