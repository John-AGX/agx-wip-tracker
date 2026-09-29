/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * A SYNCED RECORD'S AGE IS BUILDERTREND'S, NOT THE IMPORT'S.
 *
 * created_at on an imported row is the instant of the sync. Measured on the
 * live org: 609 of 687 jobs carried 2026-09-25, because that is the day the
 * big import ran. Sorting by age ranked records by when we fetched them.
 *
 * Buildertrend sends the real date (jobs.createdDate: non-empty on all 729
 * records, 729 distinct values). It was being read by field-map.js, permitted
 * by the allowlist, and then dropped at TWO further layers — the reader never
 * named it and the matcher's enumerated view never carried it. The file even
 * warns about exactly that, one line above where the key was missing.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');

const read = (p) => fs.readFileSync(path.join(__dirname, '..', p), 'utf8');
const btMatch = require('../server/services/clickr/bt-match');
const fieldMap = require('../server/services/clickr/field-map');
// A needle that a COMMENTED-OUT line satisfies proves nothing about the code
// that runs; see test/helpers/live-line.js.
const { liveLine, liveLines } = require('./helpers/live-line');

describe('reading a Buildertrend date', () => {
  const t = btMatch.btInstant;

  test('a real date comes through as an instant', () => {
    expect(t('2023-05-11T14:03:00Z')).toBe('2023-05-11T14:03:00.000Z');
    expect(t('2024-03-14')).toBe('2024-03-14T00:00:00.000Z');
  });

  test('an unparseable value is NULL, never "now"', () => {
    // The whole defect is a date that silently becomes the current moment.
    // A fallback to new Date() would be invisible, because "now" always looks
    // like a plausible date.
    for (const bad of [null, undefined, '', '   ', 'not a date', {}, []]) {
      expect(t(bad)).toBeNull();
    }
  });

  test('Buildertrend’s "unset" sentinels are refused', () => {
    // 0001 and 1900 are what it sends for a date that was never filled in.
    // Accepted, they pin themselves to the top of an oldest-first list for ever.
    expect(t('0001-01-01T00:00:00')).toBeNull();
    expect(t('1900-01-01')).toBeNull();
    expect(t('1969-12-31')).toBeNull();
  });

  test('a date in the future is refused', () => {
    expect(t('2999-01-01')).toBeNull();
    // but today is fine
    expect(t(new Date().toISOString())).not.toBeNull();
  });

  test('BUILDERTREND SENDS NO TIME ZONE, and the answer must not depend on the machine', () => {
    // The live shape, exactly: jobs.createdDate is "2025-02-01T18:05:21.037".
    // ECMAScript reads a date-TIME with no designator as LOCAL, so without the
    // pin the same record lands on a different instant on every machine that
    // parses it. Found by a fixture: a 10:00 value stored as 15:00Z on a
    // US-Eastern machine and 10:00Z on the UTC server this runs on.
    expect(t('2025-02-01T18:05:21.037')).toBe('2025-02-01T18:05:21.037Z');
    expect(t('2026-03-01T10:00:00.00')).toBe('2026-03-01T10:00:00.000Z');
    expect(t('2026-03-01T10:00:00')).toBe('2026-03-01T10:00:00.000Z');
    expect(t('2026-03-01T10:00')).toBe('2026-03-01T10:00:00.000Z');
    // A space instead of the T is the same value.
    expect(t('2026-03-01 10:00:00')).toBe('2026-03-01T10:00:00.000Z');
    // This machine's own zone, so the assertion above says something.
    expect(new Date('2026-03-01T10:00:00').toISOString() === '2026-03-01T10:00:00.000Z')
      .toBe(new Date().getTimezoneOffset() === 0);
  });

  test('a zone that IS stated is obeyed, and a bare date is left alone', () => {
    // The pin must not overwrite a real offset, and a DATE with no time is
    // already UTC by the same spec — rewriting it would shift nothing but
    // would mean this function had two rules for one shape.
    expect(t('2023-05-11T14:03:00Z')).toBe('2023-05-11T14:03:00.000Z');
    expect(t('2023-05-11T14:03:00-05:00')).toBe('2023-05-11T19:03:00.000Z');
    expect(t('2023-05-11T14:03:00+02:00')).toBe('2023-05-11T12:03:00.000Z');
    expect(t('2024-03-14')).toBe('2024-03-14T00:00:00.000Z');
  });
});

describe('the three layers that were dropping the job’s date', () => {
  test('layer 1: the reader names createdDate', () => {
    const j = fieldMap.readJob({ jobId: '1', jobName: 'RV2006', createdDate: '2023-05-11T14:03:00Z' });
    expect(j.createdDate).toBe('2023-05-11T14:03:00Z');
  });

  test('layer 2: the matcher’s enumerated job view carries it', () => {
    // That view is built by naming fields one at a time; a key missing from it
    // is read and thrown away again, which is what happened here.
    const src = read('server/services/clickr/bt-match.js').replace(/\r\n/g, '\n');
    const at = src.indexOf('projectedStart: str(v.projectedStart)');
    expect(at).toBeGreaterThan(-1);
    expect(liveLines(src.slice(at, at + 600), 'createdDate: str(v.createdDate)').length).toBe(1);
  });

  test('layer 3: the applier writes it to a column', () => {
    const src = read('server/services/clickr/sync-apply.js');
    expect(liveLines(src, 'INSERT INTO jobs (id, owner_id, data, organization_id, bt_job_id, client_id, bt_created_at, bt_synced_at)').length).toBe(1);
    expect(liveLines(src, 'match.btInstant(bt.createdDate)').length).toBe(2);   // the job INSERT and the lead INSERT
  });

  test('a lead is written the same way', () => {
    const src = read('server/services/clickr/sync-apply.js');
    expect(liveLines(src, 'bt_lead_id, bt_created_at, bt_synced_at)').length).toBe(1);
  });
});

describe('repairing the records already imported', () => {
  const src = read('server/services/clickr/sync-apply.js');

  test('BOTH backfills only ever FILL — neither can overwrite, neither guesses', () => {
    // Two functions, not one: healBtDates scopes strictly (jobs, leads) and
    // healBtDatesLoose carries the OR-IS-NULL arm for the four kinds that hang
    // off a job. The first version of this test took a 700-BYTE WINDOW from
    // the first match, which ended inside the comment above the loose one — so
    // a `|| new Date().toISOString()` fallback in the function all four new
    // record types use passed straight through it. Sliced by NAME now, and
    // both are checked.
    for (const sig of ['async function healBtDates(', 'async function healBtDatesLoose(']) {
      const at = src.indexOf(sig);
      expect([sig, at > -1]).toEqual([sig, true]);
      const body = src.slice(at, src.indexOf('\n}', at));
      expect([sig, liveLines(body, 'bt_created_at IS NULL').length]).toEqual([sig, 1]);
      // and it writes nothing at all when the date will not parse
      expect([sig, liveLine(body, 'if (!iso) return;')]).toEqual([sig, true]);
      // no fallback to "now" anywhere in either body — the defect they exist to fix
      expect([sig, /new Date\(\)/.test(body)]).toEqual([sig, false]);
    }
  });

  /* IT RUNS BEFORE THE EARLY RETURN — IN EVERY APPLIER, NOT JUST THE JOB ONE.
   *
   * That return is taken by exactly the rows the backfill is for: a record long
   * since in step with Buildertrend has no field to apply. Called after it, the
   * backfill would never reach one of them — which on the live org is 609 of
   * 687 jobs, 50 of 58 change orders, 55 of 108 estimates.
   *
   * This used to check the job applier alone, and the needle it used
   * ("healBtDates(db, 'jobs'") cannot match "healBtDatesLoose(db, ...", so all
   * four of the kinds that hang off a job were unpinned: moving any of those
   * calls below its early return left every test in the repo green.
   *
   * Each applier's own return is named, because they are not the same
   * sentence — an estimate's is the lifecycle lock, which refuses every other
   * write to a document that went to a client.
   */
  const APPLIERS = [
    ['applyJob', "healBtDates(db, 'jobs'", 'if (!applied.length && wasLinked && !nextBtStatus) return'],
    ['applyLead', "healBtDates(db, 'leads'", 'if (!applied.length && wasLinked) return'],
    ['applyChangeOrder', "healBtDatesLoose(db, 'job_change_orders'", 'if (!applied.length && wasLinked && !nextBtStatus) return'],
    ['applyPurchaseOrder', "healBtDatesLoose(db, 'job_purchase_orders'", 'if (!applied.length && wasLinked'],
    ['applyBill', "healBtDatesLoose(db, 'job_vendor_bills'", 'if (!applied.length && wasLinked'],
    ['applyEstimate', "healBtDatesLoose(db, 'estimates'", 'const locked = estimateMatch.lifecycleLock(view);'],
  ];

  test.each(APPLIERS)('%s heals before its own early return', (fn, healNeedle, returnNeedle) => {
    const from = src.indexOf('async function ' + fn + '(');
    expect([fn, from > -1]).toEqual([fn, true]);
    const heal = src.indexOf(healNeedle, from);
    const early = src.indexOf(returnNeedle, from);
    expect([fn, heal > -1, early > -1]).toEqual([fn, true, true]);
    expect([fn, heal < early]).toEqual([fn, true]);
  });

  test('every applier heals BELOW its "already linked to another record" guard', () => {
    // A Buildertrend record already linked to a DIFFERENT P86 record must not
    // leave its creation date behind on the one it is then refused. applyLead
    // used to heal above that guard while the other five healed below it;
    // reachable, because two P86 records matching one Buildertrend record is
    // the possible_duplicate class and the live org has 18 leads in it.
    const GUARDS = [
      ['applyJob', "healBtDates(db, 'jobs'", 'Another P86 job is already linked'],
      ['applyLead', "healBtDates(db, 'leads'", 'Another P86 lead is already linked'],
      ['applyChangeOrder', "healBtDatesLoose(db, 'job_change_orders'", 'Another P86 change order is already linked'],
      ['applyPurchaseOrder', "healBtDatesLoose(db, 'job_purchase_orders'", 'Another P86 purchase order is already linked'],
      ['applyBill', "healBtDatesLoose(db, 'job_vendor_bills'", 'Another P86 bill is already linked'],
      ['applyEstimate', "healBtDatesLoose(db, 'estimates'", 'Another P86 estimate is already linked'],
    ];
    for (const [fn, healNeedle, guard] of GUARDS) {
      const from = src.indexOf('async function ' + fn + '(');
      const heal = src.indexOf(healNeedle, from);
      const g = src.indexOf(guard, from);
      expect([fn, heal > -1, g > -1]).toEqual([fn, true, true]);
      expect([fn, g < heal]).toEqual([fn, true]);
    }
  });

  test('it is only ever pointed at tables this file names itself', () => {
    // The table name is interpolated, so it must never come from a record.
    const calls = src.match(/healBtDates(?:Loose)?\(db, '[a-z_]+'/g) || [];
    expect(calls.length).toBe(6);
    expect(new Set(calls.map((c) => c.split("'")[1]))).toEqual(new Set(['jobs', 'leads',
      'job_change_orders', 'job_purchase_orders', 'job_vendor_bills', 'estimates']));
  });

  test('the columns exist, on both tables', () => {
    const db = read('server/db.js');
    for (const tbl of ['jobs', 'leads']) {
      expect(db).toMatch(new RegExp('ALTER TABLE ' + tbl + '\\s+ADD COLUMN IF NOT EXISTS bt_created_at TIMESTAMPTZ;'));
      expect(db).toMatch(new RegExp('ALTER TABLE ' + tbl + '\\s+ADD COLUMN IF NOT EXISTS bt_synced_at\\s+TIMESTAMPTZ;'));
    }
  });
});

describe('what a list shows and sorts on', () => {
  let B;
  beforeAll(() => {
    window.eval(read('js/bt-badge.js'));
    B = window.p86BtBadge;
  });

  test('Buildertrend’s date wins when we have it', () => {
    expect(B.createdInstant({ bt_created_at: '2023-05-11T00:00:00Z', created_at: '2026-09-25T12:13:34Z' }))
      .toBe('2023-05-11T00:00:00Z');
  });

  test('a record made in Project 86 keeps its own date', () => {
    // The fallback is not cosmetic: without it, every P86-born record would
    // have no date at all and the two kinds could not sort in one list.
    expect(B.createdInstant({ created_at: '2026-01-04T00:00:00Z' })).toBe('2026-01-04T00:00:00Z');
  });

  test('a record synced before the columns existed still shows a date', () => {
    // It falls back until the next sync heals it — it must not go blank.
    expect(B.createdInstant({ bt_job_id: '1', created_at: '2026-09-25T12:13:34Z' }))
      .toBe('2026-09-25T12:13:34Z');
  });

  test('synced-at is null when nothing was ever synced, not the creation date', () => {
    expect(B.syncedInstant({ created_at: '2026-01-04T00:00:00Z' })).toBeNull();
    expect(B.syncedInstant({ bt_synced_at: '2026-09-25T12:00:00Z' })).toBe('2026-09-25T12:00:00Z');
  });

  test('an unknown date sorts LAST, not as 1970', () => {
    expect(B.createdSortKey({ bt_created_at: '2023-05-11T00:00:00Z' })).toBe(Date.parse('2023-05-11T00:00:00Z'));
    expect(B.createdSortKey({})).toBeNull();
    expect(B.createdSortKey({ created_at: 'nonsense' })).toBeNull();
  });

  test('the real ordering: imported records spread out instead of clumping', () => {
    // Three leads that all arrived in one sync, with three different
    // Buildertrend dates. Sorted on created_at alone they are indistinguishable.
    const synced = '2026-09-25T12:00:00Z';
    const leads = [
      { id: 'c', bt_created_at: '2025-02-01T00:00:00Z', created_at: synced },
      { id: 'a', bt_created_at: '2023-01-01T00:00:00Z', created_at: synced },
      { id: 'b', bt_created_at: '2024-06-15T00:00:00Z', created_at: synced },
      { id: 'd', created_at: '2026-03-03T00:00:00Z' },   // born here
    ];
    const order = leads.slice().sort((x, y) => {
      const a = B.createdSortKey(x), b = B.createdSortKey(y);
      if (a == null && b == null) return 0;
      if (a == null) return 1;
      if (b == null) return -1;
      return a - b;
    }).map((l) => l.id);
    expect(order).toEqual(['a', 'b', 'c', 'd']);
    // and on the raw column they would not have sorted at all
    const raw = new Set(leads.slice(0, 3).map((l) => l.created_at));
    expect(raw.size).toBe(1);
  });
});

describe('a Buildertrend worksheet is dated by the line that started it', () => {
  // A Buildertrend estimate record is one LINE. The worksheet was made when
  // its FIRST line was, so the date is the earliest across its lines — not the
  // first in the array (that is display order) and not the latest, which would
  // move every time somebody added a line and make the column meaningless.
  const { worksheetCreated } = require('../server/services/clickr/estimate-match');

  test('the earliest wins, whatever order the lines arrive in', () => {
    const w = { all: [
      { dateAdded: '2026-05-02T09:00:00' },
      { dateAdded: '2026-03-01T10:00:00' },   // the one that started it
      { dateAdded: '2026-07-11T16:30:00' },
    ] };
    expect(worksheetCreated(w)).toBe('2026-03-01T10:00:00');
  });

  test('a DELETED line still dates the worksheet', () => {
    // The opening line being removed since does not change the day the
    // worksheet began, so this reads w.all and not the live lines.
    const w = { all: [
      { dateAdded: '2026-03-01T10:00:00', isDeleted: true },
      { dateAdded: '2026-06-01T10:00:00' },
    ] };
    expect(worksheetCreated(w)).toBe('2026-03-01T10:00:00');
  });

  test('a worksheet with no usable date says so, rather than guessing', () => {
    expect(worksheetCreated({ all: [{}, { dateAdded: '' }, { dateAdded: 'nonsense' }] })).toBe('');
    expect(worksheetCreated({ all: [] })).toBe('');
    expect(worksheetCreated(null)).toBe('');
  });

  test('one unreadable line does not hide the rest', () => {
    const w = { all: [{ dateAdded: 'nonsense' }, { dateAdded: '2026-03-01T10:00:00' }] };
    expect(worksheetCreated(w)).toBe('2026-03-01T10:00:00');
  });
});

describe('the backfill is not an edit anybody made', () => {
  /* IT RUNS INSIDE THE JOURNAL WINDOW.
   *
   * apply() snapshots the row before the applier and calls journal.capture()
   * after it, for every result that is not `skipped` — `unchanged` included.
   * The heal happens in between. So unless bt_created_at is named as noise,
   * the first scheduled run after these columns ship records a change on every
   * healed record — on the live org 609 jobs, 911 leads, 50 change orders, 41
   * purchase orders, 31 bills and 55 estimates — each attributing an edit to
   * the sync on a record it did not edit, and each offering an "undo" that
   * would put the NULL back.
   *
   * The code comment claimed it was "deliberately not journalled". It was not,
   * until this test existed.
   */
  const journal = require('../server/services/clickr/sync-journal');

  test('a row that only gained its Buildertrend dates produces NO change rows', () => {
    const before = { id: 'j-1', data: { title: 'A' }, bt_created_at: null, bt_synced_at: null, updated_at: '2026-01-01T00:00:00.000Z' };
    const after = { id: 'j-1', data: { title: 'A' }, bt_created_at: new Date('2025-02-01T18:05:21.037Z'), bt_synced_at: new Date('2026-09-29T12:00:00.000Z'), updated_at: '2026-09-29T12:00:00.000Z' };
    expect(journal.diffColumns(before, after)).toEqual([]);
  });

  test('a real edit in the same write is still recorded', () => {
    // The exemption must not swallow the change beside it.
    const before = { id: 'j-1', status: 'open', bt_created_at: null };
    const after = { id: 'j-1', status: 'closed', bt_created_at: new Date('2025-02-01T18:05:21.037Z') };
    expect(journal.diffColumns(before, after).map((c) => c.column)).toEqual(['status']);
  });

  test('both dates are named, and nothing else was quietly added to the exemption', () => {
    // NOISE is an exemption list, and widening one is how a real change stops
    // being recorded. These four are the whole of it.
    expect([...journal.NOISE].sort()).toEqual(['bt_created_at', 'bt_synced_at', 'updated_at']);
  });
});
