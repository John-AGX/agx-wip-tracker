// The one code path allowed to erase evidence.
//
// Retention pulls against the question that started this. "If no one got the
// keys yet, is it safe now?" was about SEVEN WEEKS — any window shorter than
// the longest plausible investigation reintroduces the exact failure the trail
// was built to fix. And a purge job is, by construction, the only thing in the
// codebase that can delete the record of a privileged action.
//
// So three properties, and they are the whole file:
//   1. TIER A IS NEVER DELETED, and neither is a row whose tier was never
//      recorded — guessing a retention class for a row that has none is the
//      failure mode the one other genuine retention job in this server
//      (purgeTrash) already avoids by skipping NULLs rather than guessing.
//   2. THE PURGE AUDITS ITSELF, FAIL-CLOSED, BEFORE IT DELETES. If the record
//      of the deletion cannot be written, nothing is deleted.
//   3. IT UNLOCKS THE APPEND-ONLY TRIGGER WITH `SET LOCAL`, inside the
//      transaction — not `SET`, which would leak the escape hatch onto the next
//      borrower of a pooled connection.

process.env.JWT_SECRET = process.env.JWT_SECRET ||
  'test-secret-for-audit-retention-suite-0123456789';

let mockLog;
let mockBreakAudit;
let mockRows;

jest.mock('../server/db', () => {
  const run = async (sql, params) => {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    mockLog.push({ sql: text, params: params || [] });
    if (mockBreakAudit && /INSERT INTO admin_audit_log/i.test(text)) throw new Error('pool exhausted');
    if (/^SELECT/i.test(text)) return { rows: mockRows, rowCount: mockRows.length };
    if (/^DELETE FROM admin_audit_log/i.test(text)) return { rows: [], rowCount: 7 };
    return { rows: [], rowCount: 0 };
  };
  return {
    pool: {
      query: run,
      connect: async () => ({ query: run, release: () => {} }),
    },
  };
});

const { purgeExpiredAudit, DENIED_RETENTION_DAYS, ROUTINE_RETENTION_DAYS } =
  require('../server/services/audit-retention');

let errSpy, logSpy;
beforeEach(() => {
  mockLog = [];
  mockBreakAudit = false;
  mockRows = [{ denied: 3, routine: 4 }];
  errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
});
afterEach(() => { errSpy.mockRestore(); logSpy.mockRestore(); });

function sqls() { return mockLog.map((q) => q.sql); }
function firstIndexMatching(re) { return sqls().findIndex((s) => re.test(s)); }

describe('the purge cannot delete evidence of itself being run', () => {
  test('it writes its own audit row BEFORE the DELETE, and inside the same transaction', async () => {
    const r = await purgeExpiredAudit();
    expect(r.ok).toBe(true);
    expect(r.deleted).toBe(7);
    const iBegin = firstIndexMatching(/^BEGIN$/i);
    const iAudit = firstIndexMatching(/^INSERT INTO admin_audit_log/i);
    const iUnlock = firstIndexMatching(/SET LOCAL app\.audit_purge/i);
    const iDelete = firstIndexMatching(/^DELETE FROM admin_audit_log/i);
    const iCommit = firstIndexMatching(/^COMMIT$/i);
    expect(iBegin).toBeGreaterThanOrEqual(0);
    expect(iAudit).toBeGreaterThan(iBegin);
    expect(iDelete).toBeGreaterThan(iAudit);     // record first, then erase
    expect(iUnlock).toBeGreaterThan(iBegin);
    expect(iUnlock).toBeLessThan(iDelete);
    expect(iCommit).toBeGreaterThan(iDelete);
  });

  test('the row it writes is tier A, so a later run can never delete it', async () => {
    await purgeExpiredAudit();
    const ins = mockLog.find((q) => /^INSERT INTO admin_audit_log/i.test(q.sql));
    const cols = ins.sql.match(/\(([^)]*)\)\s*VALUES/i)[1].split(',').map((c) => c.trim().replace(/::\w+$/, ''));
    const row = {}; cols.forEach((c, i) => { row[c] = ins.params[i]; });
    expect(row.action).toBe('audit.purge');
    expect(row.tier).toBe('A');
    // No req exists here — a cron has no request. The actor is TYPED rather
    // than logged as a NULL user, which would read as coverage.
    expect(row.actor_kind).toBe('system');
    expect(row.actor_email).toBe('audit-retention');
    expect(JSON.parse(row.detail).denied_expired).toBe(3);
  });

  test('FAIL CLOSED: if the record cannot be written, NOTHING is deleted', async () => {
    mockBreakAudit = true;
    const r = await purgeExpiredAudit();
    expect(r.ok).toBe(false);
    expect(r.deleted).toBe(0);
    expect(sqls().some((s) => /^DELETE FROM admin_audit_log/i.test(s))).toBe(false);
    expect(sqls()).toContain('ROLLBACK');
    expect(sqls()).not.toContain('COMMIT');
  });

  test('a failure is loud and says nothing was deleted', async () => {
    mockBreakAudit = true;
    await purgeExpiredAudit();
    const said = errSpy.mock.calls.map((c) => String(c[0])).join(' ');
    expect(said).toContain('[audit-purge]');
    expect(said).toMatch(/nothing was deleted/i);
  });
});

describe('what it will and will not delete', () => {
  test('the DELETE predicate is tier B only — tier A and an unrecorded tier survive', async () => {
    await purgeExpiredAudit();
    const del = mockLog.find((q) => /^DELETE FROM admin_audit_log/i.test(q.sql)).sql;
    expect(del).toMatch(/tier = 'B'/);
    // `tier = 'B'` also excludes NULL in SQL, which is the point: a row written
    // before the column existed has no recorded class, and guessing one for it
    // is how a retention job quietly eats the oldest evidence — the exact rows
    // a seven-week question needs.
    expect(del).not.toMatch(/tier IS NULL/);
    expect(del).not.toMatch(/tier = 'A'/);
  });

  test('denials outlive routine successes, and both outlive the question that prompted this', async () => {
    // 400 days is eight times the seven weeks. A 30-day window — the reflexive
    // choice — would already have been useless for the original incident.
    expect(ROUTINE_RETENTION_DAYS).toBeGreaterThan(365);
    expect(DENIED_RETENTION_DAYS).toBeGreaterThan(ROUTINE_RETENTION_DAYS);
    await purgeExpiredAudit();
    const del = mockLog.find((q) => /^DELETE FROM admin_audit_log/i.test(q.sql));
    expect(del.params).toEqual([String(DENIED_RETENTION_DAYS), String(ROUTINE_RETENTION_DAYS)]);
  });

  test('nothing expired means no transaction is opened at all', async () => {
    mockRows = [{ denied: 0, routine: 0 }];
    const r = await purgeExpiredAudit();
    expect(r.deleted).toBe(0);
    expect(sqls()).not.toContain('BEGIN');
    expect(sqls().some((s) => /^DELETE FROM/i.test(s))).toBe(false);
  });

  test('a dry run counts and touches nothing', async () => {
    const r = await purgeExpiredAudit({ dryRun: true });
    expect(r.dry_run).toBe(true);
    expect(r.plan.denied_expired).toBe(3);
    expect(sqls().some((s) => /^DELETE FROM|^INSERT INTO/i.test(s))).toBe(false);
  });
});
