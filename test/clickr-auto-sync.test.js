// THE UNATTENDED RUN — what it does without being asked, and what it will not
// do even when it is on.
//
// The decisions under test are the owner's, not this file's: Buildertrend is
// the source of truth and Project 86 follows it completely, money included.
// What this file pins is that the run is OFF until somebody turns it on, that
// it reconciles parents before children, that every write it makes is
// journalled so it can be taken back, and the one carve-out — an offer whose
// press cannot be undone by putting a column value back is left for a person.
'use strict';

const auto = require('../server/services/clickr/auto-sync');

// A preview row, only as far as the runner reads it.
const row = (cls, btId, o) => Object.assign({
  class: cls,
  bt: { btId: btId },
  corrections: [],
  heldBack: [],
}, o || {});

describe('the switch', () => {
  test('OFF unless it is turned on, and every spelling of on is accepted', () => {
    for (const v of [undefined, '', 'off', '0', 'false', 'no', 'maybe']) {
      expect([v, auto.enabled({ BT_AUTO_SYNC: v })]).toEqual([v, false]);
    }
    for (const v of ['on', 'ON', '1', 'true', 'TRUE', 'yes']) {
      expect([v, auto.enabled({ BT_AUTO_SYNC: v })]).toEqual([v, true]);
    }
  });

  test('a run refuses to start while it is off, and says so rather than failing', async () => {
    const r = await auto.runOnce({ env: {}, pool: null });
    expect(r.skipped).toMatch(/BT_AUTO_SYNC is not on/);
  });

  test('a MANUAL run is not held back by the switch \u2014 the switch is for the clock, not for a person', async () => {
    const r = await auto.runOnce({ env: {}, pool: null, manual: true });
    // Past the switch, stopped only by the missing key.
    expect(r.skipped).toMatch(/No Clickr key/);
  });

  test('on, but with no Clickr key, is still a refusal and not a crash', async () => {
    const r = await auto.runOnce({ env: { BT_AUTO_SYNC: 'on' }, pool: null });
    expect(r.skipped).toMatch(/No Clickr key/);
  });
});

describe('parents before children', () => {
  test('clients and jobs are reconciled before anything that hangs off a job', () => {
    const at = (k) => auto.ORDER.indexOf(k);
    expect(at('clients')).toBeGreaterThanOrEqual(0);
    for (const child of ['changeOrders', 'purchaseOrders', 'bills', 'estimates', 'tasks']) {
      // A child read before its job would find no job to hang on and wait for
      // a second run that never comes in the same tick.
      expect([child, at('jobs') < at(child)]).toEqual([child, true]);
    }
    expect(at('clients')).toBeLessThan(at('jobs'));
  });

  test('every dataset the preview reads is in the order exactly once', () => {
    const preview = require('../server/services/clickr/sync-preview');
    expect([...auto.ORDER].sort()).toEqual([...preview.PREVIEW_KINDS].sort());
    expect(new Set(auto.ORDER).size).toBe(auto.ORDER.length);
  });
});

describe('what it ticks', () => {
  test('it ticks the corrections and the applicable held-back money', () => {
    const r = row('conflict', '111', {
      corrections: [{ field: 'street' }, { field: 'city' }],
      heldBack: [{ field: 'amount', applicable: true, money: true }],
    });
    expect(auto.ticksFor(r)).toEqual(['street', 'city', 'amount']);
  });

  test('it does NOT tick an item the preview itself says is not applicable', () => {
    const r = row('conflict', '111', {
      heldBack: [{ field: 'amount', applicable: false, money: true }, { field: 'cost', applicable: true }],
    });
    expect(auto.ticksFor(r)).toEqual(['cost']);
  });

  test('a PERMANENT offer is left for a person, and counted so the run can say so', () => {
    // Closing a purchase order: the row says a closed PO cannot be edited,
    // unlocked, revised by addendum or deleted by anyone. Putting the status
    // column back does not put that back, so the undo spine cannot cover it.
    const rows = [
      row('matched', '1', { heldBack: [{ field: 'close', applicable: true, reason: 'permanent' }] }),
      row('matched', '2', { heldBack: [{ field: 'cost', applicable: true, money: true }] }),
      row('matched', '3', { heldBack: [{ field: 'close', applicable: false, reason: 'permanent' }] }),
    ];
    expect(auto.ticksFor(rows[0])).toEqual([]);
    expect(auto.ticksFor(rows[1])).toEqual(['cost']);
    // Only the one that was actually on offer is counted.
    expect(auto.permanentCount(rows)).toBe(1);
  });

  test('a field named twice is named once', () => {
    const r = row('conflict', '111', {
      corrections: [{ field: 'amount' }],
      heldBack: [{ field: 'amount', applicable: true }],
    });
    expect(auto.ticksFor(r)).toEqual(['amount']);
  });
});

describe('which rows the money pass names', () => {
  const rows = [
    row('matched', 'a', { heldBack: [{ field: 'amount', applicable: true }] }),
    row('conflict', 'b', { corrections: [{ field: 'street' }] }),
    row('new', 'c', { heldBack: [{ field: 'amount', applicable: true }] }),
    row('ambiguous', 'd', { heldBack: [{ field: 'amount', applicable: true }] }),
    row('matched', 'e', {}),                                   // nothing to say
    row('matched', null, { heldBack: [{ field: 'amount', applicable: true }] }),
  ];

  test('only rows that are already matched, carry something, and have an id', () => {
    expect(auto.moneyTargets(rows).map((t) => t.btId)).toEqual(['a', 'b']);
  });

  test('a NEW row is the create pass’s business and an AMBIGUOUS row is nobody’s', () => {
    const ids = auto.moneyTargets(rows).map((t) => t.btId);
    expect(ids).not.toContain('c');
    expect(ids).not.toContain('d');
  });

  test('one call carries every field, and apply() filters it per row', () => {
    const b = auto.batchFor(auto.moneyTargets(rows));
    expect(b.btIds).toEqual(['a', 'b']);
    expect([...b.fields].sort()).toEqual(['amount', 'street']);
  });

  test('nothing to say means no call at all', () => {
    expect(auto.moneyTargets([row('matched', 'z', {})])).toEqual([]);
    expect(auto.batchFor([]).btIds).toEqual([]);
  });
});
