'use strict';

/**
 * read-result-budget.test.js — the allocator that decides what a read tool's
 * answer drops.
 *
 * Every test here is written to FAIL under a specific plausible mistake, named
 * in the test. The one that matters most is the direction: an allocator that
 * spends oldest-first still bounds the answer, still reports honestly, and
 * still throws away the only message anybody asked about.
 */

const B = require('../server/services/read-result-budget');

describe('allocate — bounds', () => {
  test('nothing is touched when the whole list fits', () => {
    const a = B.allocate([100, 200, 300], { budget: 10000, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([100, 200, 300]);
    expect(a.truncated).toBe(false);
    expect(a.clipped).toBe(0);
    expect(a.omitted).toBe(0);
    expect(a.keptTotal).toBe(600);
    expect(a.originalTotal).toBe(600);
    expect(B.notice(a, { noun: 'message' })).toBeNull();
  });

  test('keptTotal never exceeds the budget, over a spread of shapes', () => {
    // Deterministic pseudo-random: a seeded LCG, so a failure here is a
    // failure anybody can reproduce. Math.random would make this test lie
    // differently on every run.
    let seed = 12345;
    const next = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
    for (let trial = 0; trial < 200; trial++) {
      const n = 1 + Math.floor(next() * 40);
      const sizes = Array.from({ length: n }, () => Math.floor(next() * 20000));
      const budget = Math.floor(next() * 50000);
      const a = B.allocate(sizes, { budget: budget, maxPer: 6000, minSlice: 600 });
      expect(a.keptTotal).toBeLessThanOrEqual(budget);
      // And no item is ever given more than it has, or more than maxPer.
      a.kept.forEach((k, i) => {
        expect(k).toBeLessThanOrEqual(Math.min(sizes[i], 6000));
        expect(k).toBeGreaterThanOrEqual(0);
      });
    }
  });

  test('a single item longer than maxPer is cut to maxPer, not to the budget', () => {
    const a = B.allocate([50000], { budget: 48000, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([6000]);
    expect(a.clipped).toBe(1);
    expect(a.truncated).toBe(true);
  });

  test('a zero-length item is not counted as omitted — it had nothing to print', () => {
    const a = B.allocate([0, 0, 500], { budget: 100, maxPer: 6000, minSlice: 600 });
    // 500 wants to print but 100 < minSlice 600, so it is omitted. The two
    // empties are not: an empty body is not a dropped body.
    expect(a.omitted).toBe(1);
    expect(a.kept).toEqual([0, 0, 0]);
  });

  test('sizes that are not positive numbers are read as zero, never as NaN', () => {
    const a = B.allocate([null, undefined, 'abc', -40, 1.9, 200], { budget: 5000, maxPer: 6000, minSlice: 1 });
    expect(a.kept).toEqual([0, 0, 0, 0, 1, 200]);
    expect(Number.isFinite(a.keptTotal)).toBe(true);
    expect(a.keptTotal).toBe(201);
  });
});

describe('allocate — direction', () => {
  test('the budget is spent NEWEST first: the LAST item is the one served', () => {
    // MUTANT: from:'start' (or forgetting the reverse) passes every other
    // test in this file and throws away the message the question is about.
    const a = B.allocate([6000, 6000, 6000], { budget: 6000, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([0, 0, 6000]);
    expect(a.omitted).toBe(2);
  });

  test('kept is aligned to the INPUT order, not the allocation order', () => {
    // MUTANT: returning the reversed `kept` array. Sizes are distinct so the
    // alignment is provable: only index 2 can hold 300.
    const a = B.allocate([100, 200, 300], { budget: 450, maxPer: 6000, minSlice: 10 });
    expect(a.kept[2]).toBe(300);   // newest, served first, in full
    expect(a.kept[1]).toBe(150);   // what was left
    expect(a.kept[0]).toBe(0);     // nothing left, and 0 < minSlice anyway
    expect(a.clipped).toBe(1);
    expect(a.omitted).toBe(1);
  });

  test("from:'start' exists and reverses the direction", () => {
    const a = B.allocate([6000, 6000, 6000], { budget: 6000, maxPer: 6000, minSlice: 600, from: 'start' });
    expect(a.kept).toEqual([6000, 0, 0]);
  });
});

describe('allocate — minSlice', () => {
  test('a leftover below minSlice omits the item instead of printing a stub', () => {
    // MUTANT: dropping the minSlice check prints kept=[100,...] — a greeting
    // that reads like the whole message. That is the failure mode this whole
    // module exists to prevent, so it gets its own test.
    const a = B.allocate([5000, 5000], { budget: 5100, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([0, 5000]);
    expect(a.omitted).toBe(1);
    expect(a.clipped).toBe(0);
  });

  test('a leftover at exactly minSlice is spent, not wasted', () => {
    const a = B.allocate([5000, 5000], { budget: 5600, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([600, 5000]);
    expect(a.clipped).toBe(1);
    expect(a.omitted).toBe(0);
  });

  test('a budget of zero omits everything and says so', () => {
    // A cap of 0 means ZERO, not "use the default" — the same rule
    // agent-prompt-caps.js states for its caps.
    const a = B.allocate([500, 500], { budget: 0, maxPer: 6000, minSlice: 600 });
    expect(a.kept).toEqual([0, 0]);
    expect(a.omitted).toBe(2);
    expect(a.keptTotal).toBe(0);
    expect(B.notice(a, { noun: 'message', reopen: 'pass message=N' })).toContain('left out entirely');
  });
});

describe('notice', () => {
  const trunc = () => B.allocate([6000, 6000, 6000], { budget: 6000, maxPer: 6000, minSlice: 600 });

  test('names the counts, the direction, and the way back', () => {
    const n = B.notice(trunc(), {
      noun: 'message', nounPlural: 'messages',
      whole: 'conversation', whatIsOldest: 'part of the thread',
      reopen: 'call read_email_inbox with message=N',
    });
    expect(n).toContain('THIS IS NOT ALL OF IT');
    expect(n).toContain('18,000 chars available');
    expect(n).toContain('6,000 kept');
    expect(n).toContain('2 messages left out entirely');
    expect(n).toContain('OLDEST');
    expect(n).toContain('Do not describe this as the complete conversation');
    expect(n).toContain('call read_email_inbox with message=N');
  });

  test('a bound with no way back SAYS it is a dead end rather than hiding it', () => {
    // MUTANT: silently omitting the reopen clause. A budget that cannot be
    // reopened is data loss; the notice must admit which kind it is.
    const n = B.notice(trunc(), { noun: 'message' });
    expect(n).toContain('NO WAY TO READ THE REST IS OFFERED');
  });

  test('singular and plural are both correct — a count of 1 does not read as "1 messages"', () => {
    // The 300-char OLDEST message is the one left out: the newest takes the
    // whole budget, and 0 remaining is under minSlice.
    const a = B.allocate([300, 6000], { budget: 6000, maxPer: 6000, minSlice: 600 });
    const n = B.notice(a, { noun: 'message', nounPlural: 'messages', reopen: 'x' });
    expect(a.omitted).toBe(1);
    expect(n).toContain('1 message left out entirely');
    expect(n).not.toContain('1 messages');
  });

  test('null when nothing was cut', () => {
    expect(B.notice(B.allocate([10], { budget: 1000 }), { noun: 'message' })).toBeNull();
    expect(B.notice(null, {})).toBeNull();
  });
});

describe('itemMarker', () => {
  test('null for an item printed whole', () => {
    expect(B.itemMarker(500, 500, {})).toBeNull();
    expect(B.itemMarker(600, 500, {})).toBeNull();
    expect(B.itemMarker(0, 0, {})).toBeNull();
  });

  test('a clipped item says how much of how much', () => {
    const m = B.itemMarker(1200, 8400, { reopen: 'message=3 reads it in full' });
    expect(m).toContain('1,200 of 8,400 chars');
    expect(m).toContain('message=3 reads it in full');
  });

  test('an omitted item says it is absent, not short', () => {
    // MUTANT: one marker for both cases. "cut short: 0 of 8,400" reads as a
    // formatting glitch; "left out" reads as the fact it is.
    const m = B.itemMarker(0, 8400, { noun: 'body', reopen: 'message=1 reads it' });
    expect(m).toContain('body left out to stay in budget');
    expect(m).toContain('8,400 chars not shown');
    expect(m).not.toContain('cut short');
  });
});

describe('clipTexts', () => {
  test('slices to exactly what was allocated and returns the notice with it', () => {
    const texts = ['a'.repeat(5000), 'b'.repeat(5000), 'c'.repeat(5000)];
    const r = B.clipTexts(texts, {
      budget: 6000, maxPer: 6000, minSlice: 600,
      noun: 'message', nounPlural: 'messages', reopen: 'message=N',
    });
    expect(r.items[2].text).toBe('c'.repeat(5000));
    expect(r.items[2].marker).toBeNull();
    expect(r.items[1].text).toBe('b'.repeat(1000));
    expect(r.items[1].marker).toContain('1,000 of 5,000');
    expect(r.items[0].text).toBe('');
    expect(r.items[0].omitted).toBe(true);
    expect(r.notice).toContain('THIS IS NOT ALL OF IT');
    // The sum of what is printed is the budget, not a byte more.
    expect(r.items.reduce((n, i) => n + i.text.length, 0)).toBeLessThanOrEqual(6000);
  });

  test('null and non-string entries become empty text, never "null"', () => {
    const r = B.clipTexts([null, undefined, 'ok'], { budget: 1000, minSlice: 1 });
    expect(r.items[0].text).toBe('');
    expect(r.items[1].text).toBe('');
    expect(r.items[2].text).toBe('ok');
    expect(r.notice).toBeNull();
  });
});

describe('the defaults are the ones the email thread needs', () => {
  test("today's realistic thread is unaffected by the budget", () => {
    // Three 6,000-char bodies — the old per-message ceiling, three times
    // over. If this ever starts truncating, the change took something away
    // from conversations 86 reads now, which is not what the budget is for.
    const a = B.allocate([6000, 6000, 6000], {
      budget: B.THREAD_BODY_BUDGET,
      maxPer: B.THREAD_BODY_MAX_PER_MESSAGE,
      minSlice: B.THREAD_BODY_MIN_SLICE,
    });
    expect(a.truncated).toBe(false);
    expect(a.keptTotal).toBe(18000);
  });

  test('the old worst case is bounded to a fraction of what it was', () => {
    // 100 messages × 6,000 chars — exactly what the old code would have
    // returned, and the measured reason this file exists.
    const a = B.allocate(Array.from({ length: 100 }, () => 6000), {
      budget: B.THREAD_BODY_BUDGET,
      maxPer: B.THREAD_BODY_MAX_PER_MESSAGE,
      minSlice: B.THREAD_BODY_MIN_SLICE,
    });
    expect(a.originalTotal).toBe(600000);
    expect(a.keptTotal).toBe(48000);
    expect(a.omitted).toBe(92);
    // The eight served are the EIGHT NEWEST.
    expect(a.kept.slice(0, 92).every((k) => k === 0)).toBe(true);
    expect(a.kept.slice(92).every((k) => k === 6000)).toBe(true);
  });

  test('attachment text has its own budget so a PDF cannot evict the bodies', () => {
    expect(B.ATTACHMENT_TEXT_BUDGET).toBeLessThan(B.THREAD_BODY_BUDGET);
    expect(B.ATTACHMENT_TEXT_MAX_PER_FILE).toBe(4000);
  });
});
