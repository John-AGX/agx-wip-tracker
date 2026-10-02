// PRODUCTION PLANNING — the rules behind the service manager's Thursday sheet.
//
// John, 2026-10-02: the service manager checks off progress on the open
// service jobs before the WIP meeting, so the WIP numbers can be run Thursday
// night. Two of his decisions are load-bearing and are what this file pins:
//
//   1. The manager's percent is the MANAGER'S percent. It is not the job's.
//      A job's percent is derived from its scope cells by js/progress-core.js,
//      and the scalar that caches it drives PO/sub cost accrual on BOTH sides
//      and is the single figure an outside owner sees in a money-redacted Live
//      Room. Nothing on the way in may move any of that.
//
//   2. Applying a row writes the job's SCOPE LINE — John's call over setting
//      the job's manual override (which freezes that job out of its own scope
//      rollup) and over writing nothing. Where a job has several scope lines,
//      applying REFUSES and names them rather than inventing a split.
//
// The module requires nothing — no pool, no express, no env — so all of this
// is testable without a database or a JWT_SECRET. That is the same reason
// services/service-tickets.js is shaped this way.

'use strict';

const P = require('../server/services/production-planning');

const job = (over) => Object.assign({
  jobNumber: 'S2240', title: 'Citi Lakes Garage Repair G48', status: 'In Progress', phases: [],
}, over || {});

describe('which jobs are on the sheet', () => {
  // There are already THREE competing definitions of an "open" job in this
  // codebase and they disagree about blank statuses and about case. This uses
  // Schedule's — the only positive allow-list, and the one already described
  // as "the jobs PMs schedule production for". A fourth is not invented.
  test('the statuses are Schedule\'s, not a fourth opinion', () => {
    expect(P.PLANNING_STATUSES).toEqual(['New', 'In Progress', 'Backlog', 'Warranty']);
  });

  test.each(['New', 'In Progress', 'Backlog', 'Warranty'])('%s is on the sheet', (status) => {
    expect(P.isPlannable(job({ status }))).toBe(true);
  });

  test.each(['Completed', 'Archived', 'On Hold'])('%s is NOT', (status) => {
    expect(P.isPlannable(job({ status }))).toBe(false);
  });

  test('a blank or unknown status is NOT on the sheet', () => {
    // The alternative — treating an unknown status as open — is how a finished
    // job ends up in front of the service manager being asked for a percent.
    expect(P.isPlannable(job({ status: '' }))).toBe(false);
    expect(P.isPlannable(job({ status: 'Snoozed' }))).toBe(false);
    expect(P.isPlannable(job({ status: null }))).toBe(false);
  });

  test('status matching is case-insensitive', () => {
    // One of the three existing predicates is case-sensitive and lets a job
    // stored as 'archived' through. Not repeated.
    expect(P.isPlannable(job({ status: 'in progress' }))).toBe(true);
    expect(P.isPlannable(job({ status: 'IN PROGRESS' }))).toBe(true);
  });

  test('it is the SERVICE work — S and M only', () => {
    expect(P.isPlannable(job({ jobNumber: 'S2240' }))).toBe(true);
    expect(P.isPlannable(job({ jobNumber: 'M1002' }))).toBe(true);
    expect(P.isPlannable(job({ jobNumber: 'RV2008' }))).toBe(false);
    expect(P.isPlannable(job({ jobNumber: 'R2006' }))).toBe(false);
    expect(P.isPlannable(job({ jobNumber: '437775' }))).toBe(false);
    expect(P.isPlannable(job({ jobNumber: '' }))).toBe(false);
  });

  test('the prefix is the whole letter RUN — M is not matched inside a longer one', () => {
    // The same rule every prefix lookup in this repo uses, and the reason
    // R2006 never resolves to RV2006.
    expect(P.prefixOf('RV2008')).toBe('RV');
    expect(P.prefixOf('S2240')).toBe('S');
    expect(P.prefixOf('MX1000')).toBe('MX');
    expect(P.isPlannable(job({ jobNumber: 'MX1000' }))).toBe(false);
  });

  test('the caller can widen it, but the default is not the caller\'s to forget', () => {
    expect(P.isPlannable(job({ jobNumber: 'RV2008' }), { prefixes: ['RV'] })).toBe(true);
    expect(P.isPlannable(job({ status: 'Completed' }), { statuses: ['Completed'] })).toBe(true);
    // An empty override falls back to the default rather than matching nothing.
    expect(P.isPlannable(job({}), { prefixes: [], statuses: [] })).toBe(true);
  });
});

describe('a work order is a job with WO at the end of its name', () => {
  // John, 2026-10-02: "Work order is indicated at the end of the job name with
  // WO in buildertrend". It is a naming convention with NOTHING in the schema
  // recording it, so it is derived every time and never stored.
  test.each([
    ['Fairway Leak 4210 WO', true],
    ['Heatherwood 215 Clays Walkway Repair WO15', true],
    ['Heatherwood – Multi Light Issues WO 77', true],
    ['Verandah Trash Clean Out WO', true],
    ['Citi Lakes Garage Repair G48', false],
    ['Saddlebrook Deck Repair - Enclosed', false],
    ['WO is not at the end', false],
    ['', false],
  ])('%s -> %s', (title, want) => {
    expect(P.isWorkOrder({ title })).toBe(want);
  });

  test('a WOrd that merely starts with WO does not count', () => {
    expect(P.isWorkOrder({ title: 'Replace the WOOD' })).toBe(false);
    expect(P.isWorkOrder({ title: 'Fence Preparation and Painting' })).toBe(false);
  });
});

describe('the percent is the control the manager actually uses', () => {
  test('the steps are the five on the sheet', () => {
    expect(P.PCT_STEPS).toEqual([0, 25, 50, 75, 100]);
  });

  test('anything else is snapped to the nearest step, never refused', () => {
    // A sheet that rejects a value a person could not have typed is a sheet
    // that loses their answer.
    expect(P.snapPct(0)).toBe(0);
    expect(P.snapPct(37)).toBe(25);
    expect(P.snapPct(38)).toBe(50);
    expect(P.snapPct(90)).toBe(100);
    expect(P.snapPct(100)).toBe(100);
  });

  test('out of range and nonsense clamp instead of throwing', () => {
    expect(P.snapPct(-5)).toBe(0);
    expect(P.snapPct(1e9)).toBe(100);
    expect(P.snapPct('50')).toBe(50);
    expect(P.snapPct(null)).toBe(0);
    expect(P.snapPct(undefined)).toBe(0);
    expect(P.snapPct(NaN)).toBe(0);
    expect(P.snapPct('banana')).toBe(0);
  });
});

describe('done and percent cannot disagree', () => {
  // The rule lived in the reference design's checkbox. It is here, once,
  // because TWO doors write these fields — the signed-in one and the guest
  // one — and a rule implemented twice diverges.
  test('ticking done means 100', () => {
    expect(P.normalizeEntry({ done: true }, { pct: 50, done: false }))
      .toEqual({ pct: 100, done: true, note: null });
  });

  test('setting 100 ticks done', () => {
    expect(P.normalizeEntry({ pct: 100 }, { pct: 0, done: false }))
      .toEqual({ pct: 100, done: true, note: null });
  });

  test('dropping off 100 un-ticks done', () => {
    expect(P.normalizeEntry({ pct: 50 }, { pct: 100, done: true }))
      .toEqual({ pct: 50, done: false, note: null });
  });

  test('un-ticking done steps back to 75, NOT to zero', () => {
    // Dropping to 0 would throw away everything the manager had recorded.
    expect(P.normalizeEntry({ done: false }, { pct: 100, done: true }))
      .toEqual({ pct: 75, done: false, note: null });
  });

  test('un-ticking a job that was never at 100 leaves its percent alone', () => {
    expect(P.normalizeEntry({ done: false }, { pct: 25, done: false }))
      .toEqual({ pct: 25, done: false, note: null });
  });

  test('a note alone moves nothing else', () => {
    expect(P.normalizeEntry({ note: 'waiting on the gate code' }, { pct: 50, done: false }))
      .toEqual({ pct: 50, done: false, note: 'waiting on the gate code' });
  });

  test('an empty note is cleared, not stored as an empty string', () => {
    expect(P.normalizeEntry({ note: '   ' }, { pct: 50, note: 'old' }).note).toBeNull();
  });

  test('a note is capped and trimmed', () => {
    const long = 'x'.repeat(P.NOTE_CAP + 500);
    expect(P.normalizeEntry({ note: long }, {}).note).toHaveLength(P.NOTE_CAP);
    expect(P.normalizeEntry({ note: '  hi  ' }, {}).note).toBe('hi');
  });
});

describe('a writer may move three fields and no others', () => {
  test('the three are taken and everything else is named back', () => {
    const { patch, refused } = P.splitEntryPatch({
      pct: 50, done: true, note: 'x',
      job_id: 'j_other', contract_amount: 1, applied_at: 'now', organization_id: 9,
    });
    expect(Object.keys(patch).sort()).toEqual(['done', 'note', 'pct']);
    expect(refused.sort()).toEqual(['applied_at', 'contract_amount', 'job_id', 'organization_id']);
  });

  test('an empty patch takes nothing', () => {
    expect(P.splitEntryPatch({}).patch).toEqual({});
    expect(P.splitEntryPatch(null).patch).toEqual({});
  });
});

describe('applying a row to the job', () => {
  test('one scope line — exact, and the job keeps its own clock', () => {
    const r = P.planApply(job({ phases: [{ id: 'p1', pctComplete: 25 }] }), 50);
    expect(r).toEqual({ ok: true, phaseId: 'p1', from: 25, to: 50, changed: true });
  });

  test('applying the same number again is a no-op, and says so', () => {
    const r = P.planApply(job({ phases: [{ id: 'p1', pctComplete: 50 }] }), 50);
    expect([r.ok, r.changed]).toEqual([true, false]);
  });

  test('SEVERAL scope lines REFUSE and name them', () => {
    // Splitting one number across lines carrying different revenue would
    // invent a distribution nobody decided, and the lines are what the WIP
    // actually reads.
    const r = P.planApply(job({ phases: [
      { id: 'p1', phase: 'Paint', pctComplete: 10 },
      { id: 'p2', phase: 'Carpentry', buildingId: 'b1', pctComplete: 0 },
    ] }), 75);
    expect(r.ok).toBe(false);
    expect(r.reason).toBe('several_scope_lines');
    expect(r.choices.map((c) => c.id)).toEqual(['p1', 'p2']);
    expect(r.choices[1]).toMatchObject({ label: 'Carpentry', buildingId: 'b1' });
    expect(r.message).toMatch(/invent a split nobody decided/);
  });

  test('NO scope line refuses with what to do about it', () => {
    const r = P.planApply(job({ phases: [] }), 50);
    expect([r.ok, r.reason]).toEqual([false, 'no_scope_line']);
    expect(r.message).toMatch(/Add a scope on the job first/);
  });

  test('a phase with no id is not a scope line', () => {
    // The blob has no constraints; a half-written phase must not become the
    // thing a percent lands on.
    const r = P.planApply(job({ phases: [{ pctComplete: 10 }, { id: 'p2' }] }), 50);
    expect(r).toMatchObject({ ok: true, phaseId: 'p2' });
  });

  test('the applied value is snapped, so a junk percent cannot reach the job', () => {
    expect(P.planApply(job({ phases: [{ id: 'p1' }] }), 37).to).toBe(25);
    expect(P.planApply(job({ phases: [{ id: 'p1' }] }), 1e9).to).toBe(100);
  });
});

describe('what a link holder sees — projection by INCLUSION', () => {
  const row = {
    id: 'r1', job_id: 'j1', job_number: 'S2240', job_title: 'Citi Lakes Garage Repair WO',
    client_label: 'PAC - Citi Lakes', address: '12024 Meadow Bend Loop',
    contract_amount: 9500, pct: 50, done: false, note: 'waiting on parts',
    updated_at: 'T', updated_actor: 'Link — Dave', applied_at: null,
    // Everything below is on the table and must NOT appear.
    organization_id: 7, checklist_id: 'c1', updated_by: 11, applied_by: 12,
    applied_pct: 25, sort_key: 'z', created_at: 'T0', secret_future_column: 'boom',
  };

  test('money is hidden by default', () => {
    const out = P.publicRow(row, { hideFinancials: true });
    expect(out).not.toHaveProperty('contract_amount');
  });

  test('contract value is the ONLY money that can ever appear', () => {
    // John, 2026-10-02: "contract value only". There is no cost, margin or
    // profit field on this projection to leak.
    const out = P.publicRow(row, { hideFinancials: false });
    expect(out.contract_amount).toBe(9500);
    const keys = Object.keys(out).filter((k) => /cost|margin|profit|price|revenue/i.test(k));
    expect(keys).toEqual([]);
  });

  test('a column added to the table later does NOT reach a link holder', () => {
    // The whole point of projecting by inclusion rather than by deletion.
    const out = P.publicRow(row, { hideFinancials: true });
    expect(out).not.toHaveProperty('secret_future_column');
    expect(out).not.toHaveProperty('organization_id');
    expect(out).not.toHaveProperty('checklist_id');
    expect(out).not.toHaveProperty('updated_by');
    expect(out).not.toHaveProperty('applied_by');
  });

  test('the row still carries what the sheet is for', () => {
    const out = P.publicRow(row, { hideFinancials: true });
    expect(out).toMatchObject({
      id: 'r1', job_number: 'S2240', client_label: 'PAC - Citi Lakes',
      pct: 50, done: false, note: 'waiting on parts', is_work_order: true,
    });
  });

  test('the sheet tells the page what this link may do, rather than it guessing', () => {
    const view = P.publicChecklist({ id: 'c1', title: 'T' }, [row], { scope: 'view', hideFinancials: true });
    const upd = P.publicChecklist({ id: 'c1', title: 'T' }, [row], { scope: 'update', hideFinancials: false });
    expect([view.can_update, view.shows_money]).toEqual([false, false]);
    expect([upd.can_update, upd.shows_money]).toEqual([true, true]);
  });
});

describe('the tally bar', () => {
  test('counts done, in progress and not started', () => {
    expect(P.summarize([{ pct: 100 }, { pct: 50 }, { pct: 0 }, { pct: 25 }]))
      .toEqual({ total: 4, done: 1, in_progress: 2, not_started: 1, overall_pct: 44 });
  });

  test('an empty sheet is 0%, not NaN', () => {
    expect(P.summarize([])).toEqual({ total: 0, done: 0, in_progress: 0, not_started: 0, overall_pct: 0 });
  });

  test('overall is the MEAN, deliberately not weighted by contract value', () => {
    // This is a progress checklist, not a WIP number. Weighting it by money
    // would make it look like one.
    const even = P.summarize([{ pct: 100, contract_amount: 1 }, { pct: 0, contract_amount: 1000000 }]);
    expect(even.overall_pct).toBe(50);
  });
});

describe('the link itself', () => {
  test('a token is 256 bits of hex and is stored hashed', () => {
    const t = P.genToken();
    expect(t).toMatch(/^[a-f0-9]{64}$/);
    expect(P.isWellFormedToken(t)).toBe(true);
    const h = P.hashToken(t);
    expect(h).toMatch(/^[a-f0-9]{64}$/);
    expect(h).not.toBe(t);
    expect(P.hashToken(t)).toBe(h);     // stable, so lookup is one indexed equality
  });

  test('a malformed token never reaches a lookup', () => {
    ['', 'abc', null, undefined, 'Z'.repeat(64), 'a'.repeat(63), 'a'.repeat(65)]
      .forEach((t) => expect(P.isWellFormedToken(t)).toBe(false));
  });

  test('scope is view or update — there is deliberately no edit', () => {
    expect(P.SHARE_SCOPES).toEqual(['view', 'update']);
    expect(P.normalizeScope('update')).toBe('update');
    expect(P.normalizeScope('UPDATE')).toBe('update');
    // Anything unrecognised falls to the SAFE end, never the permissive one.
    expect(P.normalizeScope('edit')).toBe('view');
    expect(P.normalizeScope('admin')).toBe('view');
    expect(P.normalizeScope('')).toBe('view');
    expect(P.normalizeScope(null)).toBe('view');
  });

  test('every link expires, and the expiry is capped', () => {
    // A link with no expiry is a password that never rotates.
    const now = new Date('2026-10-02T00:00:00Z');
    const day = 24 * 60 * 60 * 1000;
    expect(P.shareExpiry(7, now) - now).toBe(7 * day);
    expect(P.shareExpiry(undefined, now) - now).toBe(P.DEFAULT_SHARE_DAYS * day);
    expect(P.shareExpiry(0, now) - now).toBe(P.DEFAULT_SHARE_DAYS * day);
    expect(P.shareExpiry(-5, now) - now).toBe(P.DEFAULT_SHARE_DAYS * day);
    expect(P.shareExpiry(99999, now) - now).toBe(P.MAX_SHARE_DAYS * day);
  });

  test('a refusal names the real reason — revoked and expired are different facts', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(P.shareRefusal(null)).toBe('not_found');
    expect(P.shareRefusal({ expires_at: future, revoked_at: new Date().toISOString() })).toBe('revoked');
    expect(P.shareRefusal({ expires_at: past })).toBe('expired');
    expect(P.shareRefusal({ expires_at: null })).toBe('expired');
    expect(P.shareRefusal({ expires_at: future })).toBeNull();
  });

  test('revoked beats expired — the holder is told the one that is true', () => {
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(P.shareRefusal({ expires_at: past, revoked_at: past })).toBe('revoked');
  });

  test('mayUpdate needs BOTH the scope and a live link', () => {
    const future = new Date(Date.now() + 86400000).toISOString();
    const past = new Date(Date.now() - 86400000).toISOString();
    expect(P.mayUpdate({ scope: 'update', expires_at: future })).toBe(true);
    expect(P.mayUpdate({ scope: 'view', expires_at: future })).toBe(false);
    expect(P.mayUpdate({ scope: 'update', expires_at: past })).toBe(false);
    expect(P.mayUpdate({ scope: 'update', expires_at: future, revoked_at: past })).toBe(false);
    expect(P.mayUpdate(null)).toBe(false);
  });
});

describe('the module stays free of the things that make it untestable', () => {
  test('it requires nothing but crypto', () => {
    // Same rule services/service-tickets.js states: the rules that decide what
    // a stranger holding a link may see and change must be testable with no
    // database and no JWT_SECRET.
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'production-planning.js'), 'utf8');
    const requires = (src.match(/require\(['"][^'"]+['"]\)/g) || [])
      .map((r) => r.replace(/require\(['"]|['"]\)/g, ''));
    expect(requires).toEqual(['crypto']);
  });

  test('no money word other than contract reaches the projection', () => {
    const fs = require('fs');
    const path = require('path');
    const src = fs.readFileSync(
      path.join(__dirname, '..', 'server', 'services', 'production-planning.js'), 'utf8')
      .replace(/\/\/[^\n]*/g, '');          // strip comments — they discuss money by name
    const at = src.indexOf('function publicRow');
    const body = src.slice(at, src.indexOf('function publicChecklist'));
    expect(at).toBeGreaterThan(0);
    expect(body).not.toMatch(/cost|margin|profit|revenue|unit_price/i);
  });
});
