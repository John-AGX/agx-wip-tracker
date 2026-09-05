// The share-link decision layer. These are the rules that decide what an
// anonymous stranger holding a forwarded URL may see, so they are tested
// without a database, a JWT secret or an express app — the module requires
// nothing, which is the whole point of it living in services/.
'use strict';

const assert = require('assert');
const s = require('../server/services/report-shares');

let failures = 0;
function test(name, fn) {
  try { fn(); console.log('  ok  ' + name); }
  catch (e) { failures++; console.error('  FAIL ' + name + '\n       ' + e.message); }
}

console.log('report-shares');

// ── Token ───────────────────────────────────────────────────────────────
test('token is 64 hex chars and unique per call', function () {
  const a = s.genToken(), b = s.genToken();
  assert.ok(s.HEX64.test(a), 'not hex64: ' + a);
  assert.notStrictEqual(a, b);
});

test('token shape gate rejects junk before any lookup', function () {
  assert.ok(s.isWellFormedToken('a'.repeat(64)));
  assert.ok(!s.isWellFormedToken('A'.repeat(64)), 'uppercase must not pass');
  assert.ok(!s.isWellFormedToken('a'.repeat(63)));
  assert.ok(!s.isWellFormedToken(''));
  assert.ok(!s.isWellFormedToken(null));
  assert.ok(!s.isWellFormedToken("' OR 1=1 --"));
});

test('hashToken is stable, and is NOT the token', function () {
  const t = s.genToken();
  assert.strictEqual(s.hashToken(t), s.hashToken(t));
  assert.notStrictEqual(s.hashToken(t), t);
  assert.ok(/^[a-f0-9]{64}$/.test(s.hashToken(t)));
});

// ── Scope: unknown must NARROW, never widen ─────────────────────────────
test('unknown / future / hostile scopes fall back to view', function () {
  ['edit', 'admin', 'owner', 'editor', 'write', '', null, undefined, 0, {}, []].forEach(function (v) {
    assert.strictEqual(s.normalizeScope(v), 'view', 'widened on: ' + JSON.stringify(v));
  });
});

test('scope is recognised case-insensitively but only for known values', function () {
  assert.strictEqual(s.normalizeScope('View'), 'view');
  assert.strictEqual(s.normalizeScope(' COMMENT '), 'comment');
});

test('view cannot comment; comment can view', function () {
  assert.ok(s.scopeAllows('view', 'view'));
  assert.ok(!s.scopeAllows('view', 'comment'), 'view must NOT be allowed to comment');
  assert.ok(s.scopeAllows('comment', 'view'));
  assert.ok(s.scopeAllows('comment', 'comment'));
});

test('an unknown scope cannot comment', function () {
  assert.ok(!s.scopeAllows('edit', 'comment'), 'a future scope must not grant writes');
});

// ── Financials: only an explicit false reveals ──────────────────────────
test('financials hidden unless hide_financials is exactly false', function () {
  assert.strictEqual(s.hidesFinancials({ hide_financials: false }), false, 'explicit false should reveal');
  [true, null, undefined, 'f', 'false', 0, 1, ''].forEach(function (v) {
    assert.strictEqual(s.hidesFinancials({ hide_financials: v }), true, 'revealed on: ' + JSON.stringify(v));
  });
  assert.strictEqual(s.hidesFinancials(null), true);
  assert.strictEqual(s.hidesFinancials({}), true);
});

// ── Expiry ──────────────────────────────────────────────────────────────
test('ttl clamps to 1..90 and defaults sanely', function () {
  assert.strictEqual(s.clampTtlDays(14), 14);
  assert.strictEqual(s.clampTtlDays(0), 1);
  assert.strictEqual(s.clampTtlDays(-5), 1);
  assert.strictEqual(s.clampTtlDays(9999), 90);
  assert.strictEqual(s.clampTtlDays('abc'), s.DEFAULT_TTL_DAYS);
  assert.strictEqual(s.clampTtlDays(undefined), s.DEFAULT_TTL_DAYS);
  assert.strictEqual(s.clampTtlDays(7.9), 7);
});

test('expiry is absolute and honours the clamp', function () {
  const now = new Date('2026-01-01T00:00:00Z');
  const d = s.expiryFrom(10, now);
  assert.strictEqual(d.toISOString(), '2026-01-11T00:00:00.000Z');
  // A hostile 10-year request is capped, not honoured.
  assert.strictEqual(s.expiryFrom(3650, now).toISOString(), '2026-04-01T00:00:00.000Z');
});

// ── Lifecycle ───────────────────────────────────────────────────────────
test('lifecycle: revoked beats expired beats opened beats sent', function () {
  const now = Date.parse('2026-06-01T00:00:00Z');
  const past = '2026-05-01T00:00:00Z', future = '2026-07-01T00:00:00Z';
  assert.strictEqual(s.shareLifecycle({ revoked_at: past, expires_at: past, opened_at: past }, now), 'revoked');
  assert.strictEqual(s.shareLifecycle({ expires_at: past, opened_at: past }, now), 'expired');
  assert.strictEqual(s.shareLifecycle({ expires_at: future, opened_at: past }, now), 'opened');
  assert.strictEqual(s.shareLifecycle({ expires_at: future }, now), 'sent');
});

test('a revoked or expired share is not live', function () {
  const now = Date.parse('2026-06-01T00:00:00Z');
  assert.ok(!s.isLive({ revoked_at: '2026-05-01T00:00:00Z', expires_at: '2026-07-01T00:00:00Z' }, now));
  assert.ok(!s.isLive({ expires_at: '2026-05-01T00:00:00Z' }, now));
  assert.ok(s.isLive({ expires_at: '2026-07-01T00:00:00Z' }, now));
});

// ── The guest envelope is a WHITELIST ───────────────────────────────────
test('publicShare exposes exactly four keys and never a secret', function () {
  const row = {
    id: 'rs_1', token_hash: 'DEADBEEF', organization_id: 'org_1', report_id: 'rep_1',
    created_by: 'usr_1', recipient_email: 'client@example.com', recipient_name: 'Client',
    scope: 'view', hide_financials: true, expires_at: '2026-07-01T00:00:00Z',
    document: { secret: 1 }, view_count: 3, internal_note: 'do not show'
  };
  const out = s.publicShare(row);
  assert.deepStrictEqual(Object.keys(out).sort(), ['expires_at', 'hide_financials', 'recipient_name', 'scope']);
  const json = JSON.stringify(out);
  ['DEADBEEF', 'org_1', 'usr_1', 'client@example.com', 'internal_note', 'rs_1', 'rep_1']
    .forEach(function (leak) {
      assert.ok(json.indexOf(leak) < 0, 'LEAKED ' + leak + ' in ' + json);
    });
});

test('publicShare narrows a hostile scope on the way out', function () {
  assert.strictEqual(s.publicShare({ scope: 'edit' }).scope, 'view');
});

console.log(failures ? '\nreport-shares: ' + failures + ' FAILED' : '\nreport-shares: all passed');
process.exit(failures ? 1 : 0);
