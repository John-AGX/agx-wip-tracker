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
});

describe('the three layers that were dropping the job’s date', () => {
  test('layer 1: the reader names createdDate', () => {
    const j = fieldMap.readJob({ jobId: '1', jobName: 'RV2006', createdDate: '2023-05-11T14:03:00Z' });
    expect(j.createdDate).toBe('2023-05-11T14:03:00Z');
  });

  test('layer 2: the matcher’s enumerated job view carries it', () => {
    // That view is built by naming fields one at a time; a key missing from it
    // is read and thrown away again, which is what happened here.
    const src = read('server/services/clickr/bt-match.js');
    const at = src.indexOf('projectedStart: str(v.projectedStart)');
    expect(at).toBeGreaterThan(-1);
    expect(src.slice(at, at + 600)).toContain('createdDate: str(v.createdDate)');
  });

  test('layer 3: the applier writes it to a column', () => {
    const src = read('server/services/clickr/sync-apply.js');
    expect(src).toContain('INSERT INTO jobs (id, owner_id, data, organization_id, bt_job_id, client_id, bt_created_at, bt_synced_at)');
    expect(src).toContain('match.btInstant(bt.createdDate)');
  });

  test('a lead is written the same way', () => {
    const src = read('server/services/clickr/sync-apply.js');
    expect(src).toContain('bt_lead_id, bt_created_at, bt_synced_at)');
  });
});

describe('repairing the records already imported', () => {
  const src = read('server/services/clickr/sync-apply.js');

  test('the backfill only ever FILLS — it cannot overwrite a date', () => {
    const at = src.indexOf('async function healBtDates');
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, at + 700);
    expect(body).toContain('bt_created_at IS NULL');
    // and it refuses to write anything when the date will not parse
    expect(body).toContain('if (!iso) return;');
  });

  test('it runs BEFORE the "nothing to correct" early return', () => {
    // That return is taken by exactly the rows the backfill is for: a job long
    // since in step with Buildertrend has no field to apply. Called after it,
    // the backfill would never reach a single one of them.
    const heal = src.indexOf("healBtDates(db, 'jobs'");
    const early = src.indexOf('if (!applied.length && wasLinked && !nextBtStatus) return');
    expect(heal).toBeGreaterThan(-1);
    expect(early).toBeGreaterThan(-1);
    expect(heal).toBeLessThan(early);
  });

  test('it is only ever pointed at tables this file names itself', () => {
    // The table name is interpolated, so it must never come from a record.
    const calls = src.match(/healBtDates\(db, '[a-z_]+'/g) || [];
    expect(calls.length).toBeGreaterThan(0);
    expect(new Set(calls.map((c) => c.split("'")[1]))).toEqual(new Set(['jobs', 'leads']));
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
