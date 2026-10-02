/* THE CRON EVERY LATER CRON WAS COPIED FROM, AND THE FOUR THINGS IT GOT WRONG.
 *
 * cert-expiry-cron.js is the oldest scheduled job here and the one the others
 * were modelled on. It had no test of its own — the only coverage anywhere was
 * its sender identity (test/email-send-identity.test.js) — so none of the
 * following was ever observed. All four were found by writing a new cron beside
 * it and asking why the model behaved the way it did.
 *
 *   1. THE DRY RUN REPORTED NOTHING. `if (wouldRun && !dry)` meant a preview
 *      never ran the scan, so the one question worth asking of a mail-out — how
 *      many is this about to send — had no answer.
 *   2. A THROW RE-SENT EVERY ORG ALREADY MAILED THAT TICK. The fire log was
 *      saved once, after the loop.
 *   3. THE DEDUPE KEY WAS OFF BY A DAY WEST OF UTC, because it read a DATE
 *      through toISOString and node-postgres hands a DATE back as LOCAL
 *      midnight.
 *   4. TWO REPLICAS BOTH SENT, and this cron mails SUBCONTRACTORS — a duplicate
 *      here is customer-facing.
 *
 * This file exists so none of them can come back.
 */
'use strict';

process.env.JWT_SECRET = process.env.JWT_SECRET
  || 'test-only-secret-with-at-least-32-characters-of-padding';

const fs = require('fs');
const path = require('path');
const { liveLine, liveLines } = require('./helpers/live-line');

let tables;
let settings;
let queries;
let failOrg;          // org id whose scan should throw, emulating a pool blip

jest.mock('../server/db', () => ({
  pool: {
    query: async (sql, params) => mockRunQuery(sql, params),
    connect: async () => {
      const client = {
        _holds: false,
        query: async (sql, params) => {
          const t = String(sql);
          if (/pg_try_advisory_lock/.test(t)) {
            if (mockLock.held) return { rows: [{ got: false }] };
            mockLock.held = true; client._holds = true; mockLock.takes++;
            return { rows: [{ got: true }] };
          }
          if (/pg_advisory_unlock/.test(t)) {
            mockLock.held = false; client._holds = false; mockLock.releases++;
            return { rows: [{ ok: true }] };
          }
          return mockRunQuery(sql, params);
        },
        release: () => { if (client._holds) mockLock.leaked++; },
      };
      return client;
    },
  },
}));

let mockLock;

const sent = [];
jest.mock('../server/email', () => ({
  isEnabled: () => true,
  sendEmail: async () => ({ ok: true }),
  sendForEvent: async (key, payload, opts) => {
    sent.push({ key, payload, to: opts && opts.to });
    return { ok: true };
  },
}));
jest.mock('../server/email-sender', () => ({
  replyToForOrgAdmin: async () => 'admin@agx.test',
  cleanReplyTo: (a) => a || null,
  orgNameFor: async () => 'AG Exteriors',
}));

function rowsOf(n) { return tables[n] || []; }

function mockRunQuery(sql, params) {
  const text = String(sql).replace(/\s+/g, ' ').trim();
  const p = params || [];
  queries.push({ sql: text, params: p });

  if (/FROM organizations WHERE archived_at IS NULL/.test(text)) {
    return { rows: rowsOf('organizations') };
  }
  if (/^SELECT value FROM app_settings WHERE key = \$1/.test(text)) {
    const v = settings[p[0]];
    return { rows: v ? [{ value: v }] : [] };
  }
  if (/^INSERT INTO app_settings/.test(text)) {
    settings[p[0]] = JSON.parse(p[1]);
    return { rows: [], rowCount: 1 };
  }

  if (/FROM sub_certificates sc/.test(text)) {
    const orgId = p[0];
    if (failOrg != null && String(orgId) === String(failOrg)) {
      throw new Error('pool blip on org ' + orgId);
    }
    // The expiry window, read off the statement. Both arms are a band around
    // today, which is WHY this cron can re-fire daily and a past-due scan
    // cannot — see deadline-digest-cron.js.
    const windowed = /reminder_direction = 'before'/.test(text);
    const usesToChar = /to_char\(sc\.expiration_date, 'YYYY-MM-DD'\) AS expiration_iso/.test(text);
    const out = [];
    for (const c of rowsOf('certs')) {
      const sub = rowsOf('subs').find((s) => s.id === c.sub_id);
      if (!sub || String(sub.organization_id) !== String(orgId)) continue;
      if (!sub.email) continue;
      if (windowed && c.outsideWindow) continue;
      const row = {
        cert_id: c.id, cert_type: c.cert_type,
        // node-postgres hands a DATE back as a Date at LOCAL midnight, and that
        // is the whole of bug 3 — so the fixture is a real Date, not a string.
        //
        // `c.asEastOfUtc` gives it the instant a server at UTC+2 would produce
        // for that calendar day (22:00Z the day before). That matters because
        // jest sandboxes process.env.TZ, so a test cannot choose its own
        // timezone — and on a machine WEST of UTC the old toISOString reading
        // happens to give the right answer, so a plain local-midnight fixture
        // would let the bug through here while shipping it to anyone east of
        // Greenwich. The instant is the thing under test, so the fixture
        // states it outright.
        expiration_date: c.asEastOfUtc
          ? new Date(c.asEastOfUtc)
          : new Date(c.expiration + 'T00:00:00'),
        reminder_days: 30, reminder_direction: 'before',
        days_until: 10,
        sub_id: sub.id, sub_name: sub.name, sub_email: sub.email,
        primary_contact_first: sub.first || '',
      };
      if (usesToChar) row.expiration_iso = c.expiration;
      out.push(row);
    }
    return { rows: out };
  }

  return { rows: [], rowCount: 0 };
}

const cron = require('../server/cert-expiry-cron');

// 10:00 America/New_York — past SCAN_HOUR for New York, not yet for Denver.
const MORNING_ET = new Date('2026-10-02T14:00:00Z');

function freshTables() {
  return {
    organizations: [
      { id: 1, name: 'AG Exteriors', timezone: 'America/New_York' },
      { id: 2, name: 'Westside', timezone: 'America/Denver' },
    ],
    subs: [
      { id: 's1', name: 'Acme Roofing', email: 'acme@vendor.test', first: 'Ray', organization_id: 1 },
      { id: 's2', name: 'Bolt Glass', email: 'bolt@vendor.test', first: 'Jo', organization_id: 1 },
      { id: 's3', name: 'Westside Siding', email: 'ws@vendor.test', first: 'Kim', organization_id: 2 },
    ],
    certs: [
      // c1 carries the instant an east-of-UTC server hands back for 2026-10-12.
      // Read through toISOString it names the ELEVENTH; to_char names the 12th.
      { id: 'c1', sub_id: 's1', cert_type: 'liability', expiration: '2026-10-12', asEastOfUtc: '2026-10-11T22:00:00Z' },
      { id: 'c2', sub_id: 's2', cert_type: 'workers_comp', expiration: '2026-10-20' },
      { id: 'c3', sub_id: 's3', cert_type: 'liability', expiration: '2026-10-15' },
    ],
  };
}

beforeEach(() => {
  tables = freshTables();
  settings = {};
  queries = [];
  sent.length = 0;
  failOrg = null;
  mockLock = { held: false, takes: 0, releases: 0, leaked: 0 };
});

const run = (over) => cron.runOnce(Object.assign({ now: MORNING_ET }, over || {}));
const fireKeys = () => Object.keys((settings[cron.FIRE_LOG_KEY] || { fires: {} }).fires || {});

/* ═══════════════════════════════════════════════════════════════════════════
 * 1. THE DRY RUN NOW ANSWERS THE QUESTION
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the dry run', () => {
  test('reports real per-org counts and sends nothing', async () => {
    const r = await run({ dry: true, force: true });
    expect(sent).toHaveLength(0);
    const counted = r.orgs.filter((o) => o.candidates != null);
    expect(counted.length).toBe(2);
    expect(r.fired).toBe(3);                       // 2 in org 1, 1 in org 2
    expect(counted.find((o) => o.orgId === 1).candidates).toBe(2);
  });

  test('it records nothing, so the real tick still sends', async () => {
    await run({ dry: true, force: true });
    expect(settings[cron.FIRE_LOG_KEY]).toBeUndefined();
    await run({ force: true });
    expect(sent.length).toBe(3);
  });

  test('it does not ask for a Reply-To it will never use', async () => {
    // replyToForOrgAdmin is a query per org. A preview that sends nothing has
    // no envelope to address.
    const spy = require('../server/email-sender');
    const calls = [];
    const real = spy.replyToForOrgAdmin;
    spy.replyToForOrgAdmin = async (...a) => { calls.push(a); return real(...a); };
    await run({ dry: true, force: true });
    expect(calls).toHaveLength(0);
    spy.replyToForOrgAdmin = real;
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 2. A FAILED ORG DOES NOT RE-MAIL THE ORGS BEFORE IT
 * ══════════════════════════════════════════════════════════════════════════*/
describe('a blip part-way through a tick', () => {
  test('the orgs already mailed keep their marker', async () => {
    failOrg = 2;                                   // org 1 mails, org 2 throws
    const r = await run({ force: true });
    expect(r.error).toBeTruthy();
    expect(sent.map((s) => s.to).sort()).toEqual(['acme@vendor.test', 'bolt@vendor.test']);
    // The marker for org 1 survived the throw — this is the whole fix.
    const log = settings[cron.FIRE_LOG_KEY];
    expect(log).toBeDefined();
    expect(log.orgRuns['1']).toBe('2026-10-02');
  });

  test('and the next tick does NOT mail them again', async () => {
    failOrg = 2;
    await run({ force: true });
    const firstCount = sent.length;
    failOrg = null;
    sent.length = 0;
    // Not forced: the per-org day marker is what must hold it back.
    await run();
    expect(sent.map((s) => s.to)).not.toContain('acme@vendor.test');
    expect(firstCount).toBe(2);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 3. THE DEDUPE KEY IS THE CALENDAR DAY ON THE RECORD
 * ══════════════════════════════════════════════════════════════════════════*/
describe('the dedupe key', () => {
  test('carries the expiry date as Postgres printed it, in any timezone', async () => {
    await run({ force: true });
    // c1's Date is the instant a UTC+2 server hands back for 2026-10-12.
    // toISOString on it says 2026-10-11; to_char says 2026-10-12. The key must
    // be the calendar day on the record — which is also what a HUMAN reading
    // the certificate would say, in Tampa or in Berlin.
    expect(fireKeys()).toContain('c1|2026-10-12|2026-10-02');
    expect(fireKeys().join(' ')).not.toContain('2026-10-11');
  });

  test('no DATE is converted in JS at all', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'cert-expiry-cron.js'), 'utf8');
    expect(liveLines(src, '.toISOString()')).toEqual([]);
    expect(src).toContain("to_char(sc.expiration_date, 'YYYY-MM-DD')");
  });

  test('the dead todayISO helper is gone — its comment was being quoted as doctrine', () => {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server', 'cert-expiry-cron.js'), 'utf8');
    expect(liveLine(src, 'function todayISO()')).toBe(false);
  });

  test('a cert already fired today is skipped, and tomorrow it fires again', async () => {
    await run({ force: true });
    expect(sent.length).toBe(3);
    sent.length = 0;
    await run({ force: true });              // same local day
    expect(sent.length).toBe(0);
    sent.length = 0;
    await cron.runOnce({ now: new Date('2026-10-03T14:00:00Z'), force: true });
    expect(sent.length).toBe(3);             // the window is a band; this is correct
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * 4. ONE REPLICA SENDS
 * ══════════════════════════════════════════════════════════════════════════*/
describe('two replicas do not both mail a subcontractor', () => {
  test('a tick takes the lock and gives it back', async () => {
    await run({ force: true });
    expect(mockLock.takes).toBe(1);
    expect(mockLock.releases).toBe(1);
    expect(mockLock.held).toBe(false);
    expect(mockLock.leaked).toBe(0);
  });

  test('a second replica skips rather than racing the ledger', async () => {
    mockLock.held = true;
    const r = await run({ force: true });
    expect(r.skippedTick).toBe('locked');
    expect(sent).toHaveLength(0);
    expect(settings[cron.FIRE_LOG_KEY]).toBeUndefined();
  });

  test('the lock comes back even when an org throws', async () => {
    failOrg = 1;
    await run({ force: true });
    expect(mockLock.held).toBe(false);
    expect(mockLock.releases).toBe(1);
    expect(mockLock.leaked).toBe(0);
  });

  test('a dry run takes no lock, so a preview always runs', async () => {
    mockLock.held = true;
    const r = await run({ dry: true, force: true });
    expect(r.skippedTick).toBeUndefined();
    expect(r.fired).toBe(3);
    expect(mockLock.takes).toBe(0);
  });

  test('its key is its own, and below the one the admin reset uses', () => {
    const lock = require('../server/services/cron-tick-lock');
    expect(lock.KEYS.certExpiry).not.toBe(lock.KEYS.deadlineDigest);
    for (const k of Object.values(lock.KEYS)) {
      expect(k).toBeLessThan(0x86 * 1000000);
    }
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * THE WINDOW, WHICH ALSO HAD NO TEST
 * ══════════════════════════════════════════════════════════════════════════*/
describe('each org is scanned on its own local morning', () => {
  test('09:00 is the gate, in the org’s timezone and not the server’s', async () => {
    // 13:00Z = 09:00 New York (in window) and 07:00 Denver (not yet).
    const r = await cron.runOnce({ now: new Date('2026-10-02T13:00:00Z') });
    const ny = r.orgs.find((o) => o.orgId === 1);
    const den = r.orgs.find((o) => o.orgId === 2);
    expect([ny.inWindow, den.inWindow]).toEqual([true, false]);
    expect(sent.map((s) => s.to).sort()).toEqual(['acme@vendor.test', 'bolt@vendor.test']);
  });

  test('later the same day Denver has its turn, and New York is not mailed twice', async () => {
    await cron.runOnce({ now: new Date('2026-10-02T13:00:00Z') });
    sent.length = 0;
    await cron.runOnce({ now: new Date('2026-10-02T16:00:00Z') });   // 10:00 Denver
    expect(sent.map((s) => s.to)).toEqual(['ws@vendor.test']);
  });

  test('the scan hour is a real gate, not an accident of ordering', () => {
    expect(cron.SCAN_HOUR).toBe(9);
  });
});

/* ═══════════════════════════════════════════════════════════════════════════
 * WIRING
 * ══════════════════════════════════════════════════════════════════════════*/
describe('wiring', () => {
  test('the ledger key the module uses is the one the registry declares', () => {
    const keys = require('../server/services/app-settings-keys');
    expect(keys.isDeclaredKey(cron.FIRE_LOG_KEY)).toBe(true);
    expect(keys.classOf(cron.FIRE_LOG_KEY)).toBe('internal');
  });

  test('the lock is shared with the deadline digest, not copied', () => {
    const certSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'cert-expiry-cron.js'), 'utf8');
    const digestSrc = fs.readFileSync(path.join(__dirname, '..', 'server', 'deadline-digest-cron.js'), 'utf8');
    for (const src of [certSrc, digestSrc]) {
      expect(liveLines(src, "require('./services/cron-tick-lock')").length).toBe(1);
      // and neither keeps its own copy of the acquire
      expect(liveLines(src, 'pg_try_advisory_lock')).toEqual([]);
    }
  });

  test('the release sits in a finally in both crons', () => {
    for (const f of ['server/cert-expiry-cron.js', 'server/deadline-digest-cron.js']) {
      const src = fs.readFileSync(path.join(__dirname, '..', f), 'utf8');
      expect([f, liveLine(src, '} finally {')]).toEqual([f, true]);
      expect([f, liveLine(src, 'if (release) await release();')]).toEqual([f, true]);
    }
  });
});
