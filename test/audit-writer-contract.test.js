// The writer's contract: never fail silent, never leak, never lie about who.
//
// WHAT THIS SUITE IS FOR. The trail is only worth building if a failure to
// write is LOUDER than a successful write, not quieter. An audit insert that
// throws while the operation proceeds produces an unlogged privileged action,
// and the empty log then reads as "nothing happened" — which is worse than
// having no trail at all, because it is evidence of the wrong thing.
//
// So the properties pinned here are about the two failure modes and the two
// leak surfaces, tested against server/audit.js directly with a pool that can
// be told to break on command:
//
//   1. TIER A FAILS CLOSED  — the promise REJECTS, so the caller can refuse.
//   2. TIER B FAILS LOUD    — the promise RESOLVES (the operation proceeds) and
//                             the COMPLETE row lands on stderr under a stable
//                             [AUDIT-FAIL] prefix. Not the action name alone:
//                             that tells you a record was lost and not what it
//                             said.
//   3. NEVER FAIL SILENT    — there is no path through this module where a
//                             write failure produces neither a throw nor a
//                             scream.
//   4. NO CREDENTIALS       — a detail key that looks like key material is
//                             dropped before the row reaches EITHER the table
//                             or stdout.
//   5. THE ACTOR IS REAL    — act-as attribution is recorded, an explicit
//                             non-user actor is TYPED rather than left NULL.
//   6. DENIALS COALESCE, SUCCESSES DO NOT — a flood of refusals must not be
//                             able to write the table full, and a successful
//                             read of a secret must never be deduplicated away.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-audit-writer-contract-suite-0123456789';

let mockInserts;
let mockBreakWrites;

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => {
      if (mockBreakWrites) throw new Error('pool exhausted');
      mockInserts.push({ sql: String(sql).replace(/\s+/g, ' ').trim(), params: params });
      return { rows: [], rowCount: 1 };
    },
    connect: async () => ({
      query: async (sql, params) => {
        const text = String(sql).replace(/\s+/g, ' ').trim();
        if (/^(BEGIN|COMMIT|ROLLBACK)$/i.test(text)) { mockInserts.push({ sql: text, params: [] }); return { rows: [] }; }
        if (mockBreakWrites) throw new Error('pool exhausted');
        mockInserts.push({ sql: text, params: params });
        return { rows: [], rowCount: 1 };
      },
      release: () => {}
    })
  }
}));

const audit = require('../server/audit');

// A minimal express-shaped request. Enough for buildRow to recognise it as a
// req rather than an actor descriptor.
function reqOf(user, extra) {
  return Object.assign({
    user: user,
    headers: { 'user-agent': 'Mozilla/5.0 (TestBrowser)' },
    ip: '203.0.113.7',
    method: 'GET',
  }, extra || {});
}

const PM = { id: 42, email: 'pm@agx.co', role: 'pm', organization_id: 1 };
const OWNER = { id: 1, email: 'owner@agx.co', role: 'system_admin', organization_id: 1 };

// Column order of the one INSERT. Read off the statement itself rather than
// hardcoded, so a future column added in the middle does not silently shift
// every assertion in this file onto the wrong value.
function rowOf(entry) {
  const cols = entry.sql.match(/\(([^)]*)\)\s*VALUES/i)[1]
    .split(',').map((c) => c.trim().replace(/::\w+$/, ''));
  const out = {};
  cols.forEach((c, i) => { out[c] = entry.params[i]; });
  if (typeof out.detail === 'string') { try { out.detail = JSON.parse(out.detail); } catch (e) { /* raw */ } }
  return out;
}

function auditInserts() {
  return mockInserts.filter((i) => /^INSERT INTO admin_audit_log/i.test(i.sql)).map(rowOf);
}

let errSpy;
let logSpy;

beforeEach(() => {
  mockInserts = [];
  mockBreakWrites = false;
  audit._resetCoalescer();
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => {
  errSpy.mockRestore();
  logSpy.mockRestore();
});

function screams(prefix) {
  return errSpy.mock.calls.filter((c) => String(c[0]).indexOf(prefix) === 0);
}
function mirrored() {
  return logSpy.mock.calls.filter((c) => String(c[0]) === '[AUDIT]').map((c) => JSON.parse(c[1]));
}

describe('never fail silent — the two tiers behave differently ON PURPOSE', () => {
  test('TIER B: the operation proceeds and the write failure SCREAMS the whole row', async () => {
    mockBreakWrites = true;
    // Resolves. A caller that awaits this keeps going — which is the point:
    // blocking a login because an insert failed is a self-inflicted outage and
    // an availability attack on anyone who can pressure the pool.
    await expect(audit.auditLog(reqOf(PM), {
      action: 'auth.login', outcome: 'ok', tier: 'B', targetType: 'user', targetId: '42',
    })).resolves.toBeUndefined();

    const yells = screams('[AUDIT-FAIL]');
    expect(yells.length).toBe(1);
    const payload = JSON.parse(yells[0][1]);
    // The COMPLETE row, not just the action name. A bare name tells you a
    // record was lost and nothing about what it said.
    expect(payload.action).toBe('auth.login');
    expect(payload.actor_email).toBe('pm@agx.co');
    expect(payload.ip).toBe('203.0.113.7');
    expect(payload.target_id).toBe('42');
    expect(payload.error).toBe('pool exhausted');
  });

  test('TIER A: the write failure REJECTS, so the caller can refuse the operation', async () => {
    mockBreakWrites = true;
    await expect(audit.auditCritical(reqOf(OWNER), {
      action: 'role.update', tier: 'A', targetType: 'role', targetId: 'admin',
    })).rejects.toThrow('AUDIT_WRITE_FAILED');
    const yells = screams('[AUDIT-FAIL]');
    expect(yells.length).toBe(1);
    expect(JSON.parse(yells[0][1]).fail_closed).toBe(true);
  });

  test('TIER A in a transaction: the audit failure ROLLS BACK the work', async () => {
    // The strongest form. The row and the operation share one transaction, so
    // there is no window in which a completed operation has no row, and none in
    // which a row exists for an operation that rolled back.
    const work = jest.fn(async (client) => {
      await client.query('DELETE FROM roles WHERE name = $1', ['temp']);
      return { rowCount: 1 };
    });
    mockBreakWrites = false;
    await audit.auditedTransaction(reqOf(OWNER), { action: 'role.delete', tier: 'A' }, work);
    expect(mockInserts.map((i) => i.sql)).toEqual(expect.arrayContaining(['BEGIN', 'COMMIT']));
    expect(work).toHaveBeenCalled();

    // Now break the audit write only.
    mockInserts = [];
    let calls = 0;
    const failingWork = jest.fn(async (client) => {
      await client.query('DELETE FROM roles WHERE name = $1', ['temp']);
      calls++;
      mockBreakWrites = true;      // break AFTER the work, so only the audit fails
    });
    await expect(
      audit.auditedTransaction(reqOf(OWNER), { action: 'role.delete', tier: 'A' }, failingWork)
    ).rejects.toThrow('AUDIT_WRITE_FAILED');
    expect(calls).toBe(1);
    expect(mockInserts.map((i) => i.sql)).toContain('ROLLBACK');
    expect(mockInserts.map((i) => i.sql)).not.toContain('COMMIT');
  });

  test('every audited event mirrors to stdout at write time, whatever the table does', async () => {
    mockBreakWrites = true;
    await audit.auditLog(reqOf(PM), { action: 'settings.read', outcome: 'denied', tier: 'B' });
    // The stdout copy is the only reason a tier-B database failure is
    // tolerable. It fires even when the row never lands.
    const m = mirrored();
    expect(m.length).toBe(1);
    expect(m[0].action).toBe('settings.read');
    expect(m[0].outcome).toBe('denied');
  });

  test('an entry with no action is refused rather than written as a blank row', async () => {
    await audit.auditLog(reqOf(PM), { targetType: 'user' });
    expect(auditInserts().length).toBe(0);
    expect(screams('[AUDIT-FAIL]').length).toBe(1);
  });
});

describe('the log must not become the next leak', () => {
  test('credential-shaped detail keys never reach the table OR stdout', async () => {
    await audit.auditLog(reqOf(OWNER), {
      action: 'settings.write', tier: 'B', targetType: 'app_setting', targetId: 'vapid_keys',
      detail: {
        privateKey: 'BEd0nOtSt0reMe',
        password: 'hunter2',
        api_token: 'sk-ant-live-abc',
        password_hash: '$2a$10$abcdef',
        Authorization: 'Bearer xyz',
        nested: { client_secret: 'shhh', rows_removed: 3 },
        rows_removed: 3,
      },
    });
    const row = auditInserts()[0];
    const serialized = JSON.stringify(row.detail);
    ['BEd0nOtSt0reMe', 'hunter2', 'sk-ant-live-abc', '$2a$10$abcdef', 'Bearer xyz', 'shhh']
      .forEach((leak) => expect(serialized).not.toContain(leak));
    // The SHAPE survives — that is the whole point of recording shape not
    // contents. rows_removed is the blast radius and stays.
    expect(row.detail.rows_removed).toBe(3);
    expect(row.detail.nested.rows_removed).toBe(3);
    // And the same redacted object went to stdout, not the raw one.
    expect(JSON.stringify(mirrored()[0].detail)).not.toContain('hunter2');
    // Redaction is itself an event worth seeing — silence here would mean a
    // call site is shipping credentials and nobody knows.
    expect(screams('[AUDIT-REDACT]').length).toBeGreaterThan(0);
  });

  test('the deliberate SHAPE keys survive the denylist they would otherwise trip', async () => {
    // key_class / key_sha8 both match /key/. They are the record of an
    // enumeration attempt, not contents, and the allowlist has to say so or the
    // acceptance-test row loses the only two fields that make it useful.
    await audit.auditLog(reqOf(PM), {
      action: 'settings.read', outcome: 'denied', tier: 'B',
      detail: { key_class: 'secret', key_sha8: 'a1b2c3d4', declared: true },
    });
    const row = auditInserts()[0];
    expect(row.detail.key_class).toBe('secret');
    expect(row.detail.key_sha8).toBe('a1b2c3d4');
  });

  test('an oversized detail is collapsed rather than copied into the trail', async () => {
    // The copied-payload failure mode arriving. Keep the row (the row IS the
    // evidence) and record that the shape was oversized.
    const huge = { blob: 'x'.repeat(9000) };
    await audit.auditLog(reqOf(OWNER), { action: 'user.update', tier: 'B', detail: huge });
    const row = auditInserts()[0];
    expect(row.detail._truncated).toBe(true);
    expect(JSON.stringify(row.detail)).not.toContain('xxxxxxxxxx');
  });

  test('hashId is one-way and stable — an unresolved identifier aggregates without being stored', () => {
    const a = audit.hashId('NotAnEmail-Probably-A-Password');
    expect(a).toHaveLength(8);
    expect(a).toBe(audit.hashId('NotAnEmail-Probably-A-Password'));
    expect(a).not.toBe(audit.hashId('someone.else@agx.co'));
    expect('NotAnEmail-Probably-A-Password').not.toContain(a);
  });
});

describe('the actor on the row is the real human, and a non-user actor is TYPED', () => {
  test('act-as is attributed: the disguise is recorded, the actor stays the admin', async () => {
    // Without this a role change made under a disguise is byte-identical to one
    // made openly. requireAuth already computes req.actingAs; the writer reads
    // it, so one change covers every call site.
    await audit.auditLog(reqOf(OWNER, { actingAs: { id: 42 } }), {
      action: 'user.role_change', tier: 'A', targetType: 'user', targetId: '9',
    });
    const row = auditInserts()[0];
    expect(row.actor_user_id).toBe(1);              // the REAL admin
    expect(row.actor_email).toBe('owner@agx.co');
    expect(row.on_behalf_of_user_id).toBe(42);      // wearing this identity
  });

  test('an explicit actor descriptor is typed, so a NULL user id is not mistaken for coverage', async () => {
    await audit.auditActor(
      audit.actorFromRequest(reqOf(null), { actorKind: 'invite', actorLabel: 'new@tenant.co', orgId: 7 }),
      { action: 'org.invite_accept', tier: 'A', targetType: 'organization', targetId: '7', organizationId: 7 }
    );
    const row = auditInserts()[0];
    expect(row.actor_kind).toBe('invite');
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_email).toBe('new@tenant.co');
    // The "from where" still comes off the real HTTP request.
    expect(row.ip).toBe('203.0.113.7');
    expect(row.user_agent).toContain('TestBrowser');
  });

  test('scope defaults to platform when there is no target org, and org when there is', async () => {
    // The whole reason the org-tier reader can drop its NULL arm.
    await audit.auditLog(reqOf(OWNER), { action: 'role.update', tier: 'A', targetId: 'admin' });
    await audit.auditLog(reqOf(OWNER), { action: 'user.role_change', tier: 'A', organizationId: 3 });
    const rows = auditInserts();
    expect(rows[0].scope).toBe('platform');
    expect(rows[0].organization_id).toBeNull();
    expect(rows[1].scope).toBe('org');
    expect(rows[1].organization_id).toBe(3);
  });

  test('tier is a property of the ACTION, so two call sites cannot disagree', async () => {
    await audit.auditLog(reqOf(OWNER), { action: 'org.hard_reset', organizationId: 1 });
    await audit.auditLog(reqOf(OWNER), { action: 'user.update', organizationId: 1 });
    const rows = auditInserts();
    expect(rows[0].tier).toBe('A');
    expect(rows[1].tier).toBe('B');
  });
});

describe('a denial flood cannot write the table full, and a success is never deduplicated', () => {
  test('repeated denials collapse to one row per window and carry a repeat count', async () => {
    for (let i = 0; i < 25; i++) {
      await audit.auditLog(reqOf(PM), {
        action: 'settings.read', outcome: 'denied', reason: 'not_entitled', tier: 'B',
        targetType: 'app_setting', targetId: 'vapid_keys',
      });
    }
    expect(auditInserts().length).toBe(1);
    // But the platform log keeps the full sequence — the operation was never
    // rate-limited, only the row.
    expect(mirrored().length).toBe(25);

    // The next window folds the suppressed count into the row that lands.
    audit._resetCoalescer();
    await audit.auditLog(reqOf(PM), {
      action: 'settings.read', outcome: 'denied', reason: 'not_entitled', tier: 'B',
      targetType: 'app_setting', targetId: 'vapid_keys',
    });
    expect(auditInserts().length).toBe(2);
  });

  test('a SUCCESSFUL privileged read is written every single time', async () => {
    // The single row that must never be deduplicated: "who read the secret, and
    // how many times" is the question. Keying the coalescer on outcome without
    // excluding 'ok' would have quietly answered it wrong.
    for (let i = 0; i < 5; i++) {
      await audit.auditLog(reqOf(OWNER), {
        action: 'settings.read', outcome: 'ok', tier: 'B',
        targetType: 'app_setting', targetId: 'agent_skills',
      });
    }
    expect(auditInserts().length).toBe(5);
  });

  test('a tier-A denial is never coalesced away', async () => {
    for (let i = 0; i < 5; i++) {
      await audit.auditLog(reqOf(PM), {
        action: 'role.escalation_denied', outcome: 'denied', tier: 'A',
        targetType: 'role', targetId: 'admin',
      });
    }
    expect(auditInserts().length).toBe(5);
  });

  test('the coalescer is hard-capped, so a stranger varying the identifier cannot grow it forever', async () => {
    // The login path lets an attacker choose the key. An unbounded Map there is
    // a memory leak with a remote trigger.
    for (let i = 0; i < 1200; i++) {
      await audit.auditLog(reqOf(PM), {
        action: 'auth.login', outcome: 'denied', reason: 'no_such_user', tier: 'B',
        targetType: 'user', targetId: 'probe-' + i,
      });
    }
    expect(audit.auditHealth().coalescer_keys).toBeLessThanOrEqual(500);
    expect(audit.auditHealth().coalescer_overflows).toBeGreaterThan(0);
  });
});

describe('a silently failing audit is visible on a dashboard, not only in scrollback', () => {
  test('write failures are counted', async () => {
    const before = audit.auditHealth().write_failures;
    mockBreakWrites = true;
    await audit.auditLog(reqOf(PM), { action: 'auth.login', tier: 'B' });
    const h = audit.auditHealth();
    expect(h.write_failures).toBe(before + 1);
    expect(h.last_failure_action).toBe('auth.login');
    expect(h.last_failure_at).toBeTruthy();
  });
});
