// A PURCHASE ORDER'S ACCEPTANCE DATE IS A CALENDAR DAY, RESOLVED IN THE
// RECORDER'S ZONE — NEVER THE SERVER CLOCK'S UTC DAY.
//
// The executed PO prints "Accepted by <sub> on <date>". Both server fallbacks
// were new Date().toISOString().slice(0, 10), and Railway runs in UTC, so from
// 8pm Eastern onward that named TOMORROW. The editor sent its own date (also
// the UTC day — fixed separately in js/purchase-order-editor.js), so the
// fallback was latent, but it is the path every caller without a browser clock
// takes.
//
// Everything below EXECUTES: the pure decision in server/timezone.js directly,
// and the route's acceptanceDay lifted out of the shipped file and run against
// a fake pool.
//
// None of it depends on the zone of the machine running jest, and that is
// deliberate: setting process.env.TZ inside a jest test changes nothing (the
// worker's zone is fixed at start). The server code under test always passes
// an EXPLICIT zone to Intl, and toISOString() is UTC everywhere, so pinning
// the instant with fake timers is enough to reproduce the evening case.
'use strict';

const fs = require('fs');
const path = require('path');
const tzUtil = require('../server/timezone');

// 9:30pm on Saturday Sep 19 in New York is 01:30 UTC on Sunday Sep 20.
const EVENING_EASTERN = new Date('2026-09-20T01:30:00.000Z');

describe('calendarDayOr — the pure decision', () => {
  test('the premise: the old spelling really does name tomorrow on a UTC server', () => {
    // A guard whose premise is false is noise. Prove the defect before the fix:
    // at this instant the UTC day and the Eastern day are different days.
    expect(EVENING_EASTERN.toISOString().slice(0, 10)).toBe('2026-09-20');
    expect(tzUtil.localDateInTz('America/New_York', EVENING_EASTERN)).toBe('2026-09-19');
  });

  test('with no date supplied, it is TODAY IN THE ZONE, not the UTC day', () => {
    expect(tzUtil.calendarDayOr(undefined, 'America/New_York', EVENING_EASTERN)).toBe('2026-09-19');
    expect(tzUtil.calendarDayOr('', 'America/Phoenix', EVENING_EASTERN)).toBe('2026-09-19');
    // East of Greenwich it is already the 20th, and it should say so.
    expect(tzUtil.calendarDayOr(null, 'Europe/Paris', EVENING_EASTERN)).toBe('2026-09-20');
  });

  test('a real supplied calendar day is kept exactly as written', () => {
    expect(tzUtil.calendarDayOr('2026-09-14', 'America/New_York', EVENING_EASTERN)).toBe('2026-09-14');
    expect(tzUtil.calendarDayOr(' 2024-02-29 ', 'America/New_York', EVENING_EASTERN)).toBe('2024-02-29');
  });

  test('nothing that is not a real day is persisted as one', () => {
    // Before: acc.date was stored verbatim, whatever string arrived.
    for (const bad of ['2026-02-31', '2025-02-29', '09/19/2026', 'tomorrow', '2026-9-19', '2026-09-19T00:00:00Z']) {
      expect({ bad, out: tzUtil.calendarDayOr(bad, 'America/New_York', EVENING_EASTERN) })
        .toEqual({ bad, out: '2026-09-19' });
    }
    expect(tzUtil.isCalendarDay('2026-02-31')).toBe(false);
    expect(tzUtil.isCalendarDay('2024-02-29')).toBe(true);
  });
});

// ── The route helper, lifted and run ───────────────────────────────────
const ROUTE_SRC = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'purchase-order-routes.js'), 'utf8');

function liftAsync(src, name) {
  const start = src.indexOf('async function ' + name + '(');
  if (start < 0) throw new Error('no ' + name + ' in purchase-order-routes.js');
  let depth = 0;
  for (let i = src.indexOf('{', start); i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
  }
  throw new Error('unbalanced braces lifting ' + name);
}

function makeAcceptanceDay(queryImpl) {
  const calls = [];
  const pool = { query: async (sql, params) => { calls.push({ sql, params }); return queryImpl(sql, params); } };
  // eslint-disable-next-line no-new-func
  const fn = new Function('pool', 'tzUtil', liftAsync(ROUTE_SRC, 'acceptanceDay') + '\nreturn acceptanceDay;')(pool, tzUtil);
  return { fn, calls };
}

describe('acceptanceDay — what the two doors actually persist', () => {
  beforeEach(() => { jest.useFakeTimers().setSystemTime(EVENING_EASTERN); });
  afterEach(() => { jest.useRealTimers(); });

  test('both doors call it; neither still reads the UTC day', () => {
    expect((ROUTE_SRC.match(/await acceptanceDay\(req\.user\.id, req\.user\.organization_id, acc\.date\)/g) || []).length).toBe(2);
    const code = ROUTE_SRC.replace(/\/\/[^\n]*/g, '');
    expect(code).not.toMatch(/toISOString\(\)\.slice\(0, ?10\)/);
  });

  test('no date supplied: resolved in the ORG zone, from the org the caller is in', async () => {
    const { fn, calls } = makeAcceptanceDay(async () => ({ rows: [{ user_tz: null, org_tz: 'America/New_York' }] }));
    expect(await fn(7, 3, undefined)).toBe('2026-09-19');
    // The zone lookup is scoped to the caller's own org.
    expect(calls[0].params).toEqual([7, 3]);
    expect(calls[0].sql).toMatch(/u\.organization_id = \$2/);
  });

  test('a personal zone override beats the org zone', async () => {
    const { fn } = makeAcceptanceDay(async () => ({ rows: [{ user_tz: 'Europe/Paris', org_tz: 'America/New_York' }] }));
    expect(await fn(7, 3, undefined)).toBe('2026-09-20');
  });

  test('a real supplied day is kept and costs no query', async () => {
    const { fn, calls } = makeAcceptanceDay(async () => { throw new Error('should not query'); });
    expect(await fn(7, 3, '2026-09-19')).toBe('2026-09-19');
    expect(calls).toHaveLength(0);
  });

  test('a lookup that fails still yields a LOCAL day, never refuses the signature', async () => {
    const { fn } = makeAcceptanceDay(async () => { throw new Error('db down'); });
    // Platform default zone is America/New_York, so still the 19th — not the UTC 20th.
    expect(await fn(7, 3, 'garbage')).toBe('2026-09-19');
  });
});
