/* ──────────────────────────────────────────────────────────────────────────
 * test/estimate-duplicate.test.js — window.duplicateEstimate, driven for real.
 *
 * Duplicating an estimate is mostly a question of what must NOT be copied. An
 * estimate carries ~22 lifecycle columns plus a JSONB blob recording that THIS
 * one was sent, viewed, approved, declined, signed, locked and converted; a
 * copy wearing any of it shows as "Won" in the list, opens read-only, or names
 * a real person as having approved a proposal they never saw.
 *
 * So the assertions here are mostly absence assertions, plus one ROT GUARD:
 * every key on the source blob must be either deliberately reset or present on
 * the copy. Without that, the next field added to estimates silently stops
 * being copied and nobody finds out — which is exactly the live defect in
 * attachment-routes.js's copy route, whose allowlist omits folder_id, so every
 * file copied through it lands invisible to the Explorer.
 *
 * The clock is FROZEN throughout. Id uniqueness here has to be a property of
 * the code (mintId's taken-map + retry suffix), not of the millisecond.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const REPO = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');

const SRC_ID = 'e_source';
const OTHER_ID = 'e_other';
const BASE_ALT = 'alt_default';

// A sold estimate wearing the full sales history — the exact record this
// feature exists to copy, and the one most dangerous to copy naively.
function sourceEstimate() {
  return {
    id: SRC_ID,
    title: 'Building 3 Roof Replacement',
    client: 'Sunset Ridge Management',
    client_id: 'c_99',
    community: 'Sunset Ridge COA',
    issue: 'Roof Replacement',
    propertyAddr: '400 Gulf Blvd, Clearwater, FL 33767',
    street_address: '400 Gulf Blvd', city: 'Clearwater', state: 'FL', zip: '33767',
    billingAddr: 'PO Box 55, Clearwater, FL 33758',
    managerName: 'Dana Reyes', managerEmail: 'dana@example.test', managerPhone: '727-555-0100',
    jobType: 'Roofing', nickName: 'B3 roof', scopeOfWork: 'Tear off and re-roof.',
    taxPct: 7, feeFlat: 500, feePct: 2, roundTo: 5, defaultMarkup: 18,
    targetMargin: 32, laborRate: 55, market_id: '3',
    workbook: { sheets: [{ name: 'Takeoff', cells: { A1: 42 } }] },
    alternates: [
      { id: BASE_ALT, name: 'Base', isDefault: true, scope: 'Roofing scope.' },
      { id: 'alt_b', name: 'Gutters', scope: 'Gutter scope.', excludeFromTotal: true },
    ],
    activeAlternateId: BASE_ALT,

    // ── everything below must NOT survive the copy ───────────────────
    name: 'Sabal Palms — Ph 2 Repaint',
    bt_export_status: 'accepted',
    btExportStatus: 'accepted',
    estimate_number: 'EST-2',
    bid_due_date: '2026-04-10',
    expires_on: '2026-05-01',
    totalProposal: 98765,
    job_id: 'j_777',
    lead_id: 'l_555',
    status: 'sold',
    is_locked: true,
    approval_status: 'approved',
    approved_at: '2026-04-02T10:00:00.000Z',
    approved_by: 'Dana Reyes',
    approval_method: 'email',
    declined_at: null,
    decline_reason: 'priced too high',
    sent_at: '2026-03-28T09:00:00.000Z',
    sent_count: 3,
    sent_to: 'dana@example.test',
    sent_method: 'email',
    viewed_at: '2026-03-28T11:00:00.000Z',
    accepted_at: '2026-04-02T10:00:00.000Z',
    signature: { typed: 'Dana Reyes', ip: '203.0.113.9' },
    sign_token: 'tok_abc123',
    geocode_lat: 27.97, geocode_lng: -82.82,
    geocode_status: 'ok', geocode_at: '2026-03-01T00:00:00.000Z', geocode_addr: '400 Gulf Blvd',
    owner_id: 4,
    organization_id: 1,
    created_at: '2026-03-01T00:00:00.000Z',
    updated_at: '2026-04-02T10:00:00.000Z',
    __totals: { proposalTotal: 123 },
    aiPhase: 'build',
    created: '3-1-2026',
    _canEdit: true,
    _updatedAt: '2026-04-02T10:00:00.000Z',
  };
}

// Section membership is ARRAY POSITION between '__section_header__' rows —
// nothing else records it — so order is part of the payload, not a detail.
function sourceLines() {
  const L = (o) => Object.assign({ estimateId: SRC_ID, alternateId: BASE_ALT, unit: 'EA', markup: '' }, o);
  return [
    L({ id: 'h1', section: '__section_header__', description: 'Materials & Supplies Costs', markup: 20, btCategory: 'materials' }),
    L({ id: 'l1', description: 'Architectural shingles', qty: 42, unit: 'SQ', unitCost: 118.5 }),
    L({ id: 'l2', description: 'Synthetic underlayment', qty: 42, unit: 'SQ', unitCost: 22 }),
    L({ id: 'h2', section: '__section_header__', description: 'Direct Labor', markup: 35, btCategory: 'labor' }),
    L({
      id: 'l3', description: 'Install shingle roof system', qty: 42, unit: 'SQ', unitCost: 210,
      sourceAssemblyId: 9, assemblyBucket: 'labor',
      assemblyBreakdown: [{ description: 'Roofer hours', qty_per_unit: 2.5, unit: 'HR', unit_cost: 46, cost_code: 'labor' }],
    }),
    L({ id: 'h3', alternateId: 'alt_b', section: '__section_header__', description: 'Materials & Supplies Costs', markup: 20 }),
    L({ id: 'l4', alternateId: 'alt_b', description: '6" seamless gutter', qty: 380, unit: 'LF', unitCost: 6.4 }),
    // A neighbouring estimate's line. The portfolio array is ONE flat array, so
    // a single-estimate fixture cannot see a cross-record write.
    { id: 'x1', estimateId: OTHER_ID, alternateId: BASE_ALT, description: 'Unrelated', qty: 1, unitCost: 5 },
  ];
}

function boot() {
  const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only' });
  const w = dom.window;

  w.eval('Date.now = function(){ return 1787530000000; };');

  w.appData = { estimates: [sourceEstimate(), { id: OTHER_ID, title: 'Other', alternates: [] }], estimateLines: sourceLines() };
  w.saveCount = 0;
  w.debouncedSaveCount = 0;
  w.saveData = function () { w.saveCount++; };
  w.debouncedSave = function () { w.debouncedSaveCount++; };
  w.renderEstimatesList = function () {};
  w.p86Toast = function () {};
  w.navigatedTo = null;
  w.p86Router = { navigate: function (o) { w.navigatedTo = o; } };
  w.promptDefault = null;
  w.promptAnswer = 'My Copy';
  w.p86Prompt = function (opts) { w.promptDefault = opts.defaultValue; return Promise.resolve(w.promptAnswer); };
  w.p86Alert = function () {};
  // saveEstimateNow is the flush; the real one is safe on a locked source
  // because it routes to saveData(), not debouncedSave().
  w.flushed = 0;
  w.saveEstimateNow = function () { w.flushed++; return Promise.resolve(); };

  w.eval(read('js/line-identity.js'));
  w.eval(read('js/estimates.js'));
  return { dom, w };
}

let H;
beforeEach(() => { H = boot(); });
afterEach(() => { try { H.dom.window.close(); } catch (e) {} });

const linesOf = (w, id) => w.appData.estimateLines.filter((l) => l && l.estimateId === id);
const copyOf = (w) => w.appData.estimates.find((e) => e.id !== SRC_ID && e.id !== OTHER_ID);

describe('duplicateEstimate', () => {
  test('is exported', () => {
    expect(typeof H.w.duplicateEstimate).toBe('function');
  });

  test('creates a copy with a new id and the prompted title', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c).toBeTruthy();
    expect(c.id).not.toBe(SRC_ID);
    expect(c.title).toBe('My Copy');
    expect(H.w.promptDefault).toBe('Building 3 Roof Replacement (copy)');
  });

  test('strips EVERY piece of sales history, lock and conversion state', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    [
      'job_id', 'status', 'lead_id', 'is_locked',
      'name', 'bt_export_status', 'btExportStatus',
      'estimate_number', 'bid_due_date', 'expires_on', 'totalProposal',
      'approval_status', 'approved_at', 'approved_by', 'approval_method',
      'declined_at', 'decline_reason',
      'sent_at', 'sent_count', 'sent_to', 'sent_method', 'viewed_at', 'accepted_at',
      'signature', 'sign_token',
      'geocode_lat', 'geocode_lng', 'geocode_status', 'geocode_at', 'geocode_addr',
      'owner_id', 'organization_id', 'created_at', 'updated_at',
      '__totals', 'aiPhase', 'created',
    ].forEach((k) => {
      expect(Object.prototype.hasOwnProperty.call(c, k)).toBe(false);
    });
  });

  test('drops every client-private underscore key', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(Object.keys(c).filter((k) => k.charAt(0) === '_')).toEqual([]);
  });

  test('omitting updated_at is what lets the row be INSERTed rather than refused', async () => {
    // The client sets a base version from e.updated_at; bulk/save treats the
    // ABSENCE of a base version as the only authorisation to insert a new id.
    // A copy carrying the source's updated_at claims to be a row the server
    // already has and comes back as conflict 'deleted' — silently never created.
    await H.w.duplicateEstimate(SRC_ID);
    expect(copyOf(H.w).updated_at).toBeUndefined();
  });

  test('carries the money rules, the client and the workspace', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c.taxPct).toBe(7);
    expect(c.feeFlat).toBe(500);
    expect(c.feePct).toBe(2);
    expect(c.roundTo).toBe(5);
    expect(c.targetMargin).toBe(32);
    expect(c.defaultMarkup).toBe(18);
    expect(c.laborRate).toBe(55);
    expect(c.market_id).toBe('3');
    expect(c.client).toBe('Sunset Ridge Management');
    expect(c.client_id).toBe('c_99');
    expect(c.workbook).toEqual({ sheets: [{ name: 'Takeoff', cells: { A1: 42 } }] });
    // The structured address must ride along WITH the combined string —
    // convert falls back to street_address, and a job born without it has no
    // map, no weather and nothing to geocode.
    expect(c.street_address).toBe('400 Gulf Blvd');
    expect(c.city).toBe('Clearwater');
    expect(c.zip).toBe('33767');
  });

  test('ROT GUARD: every source key is either deliberately reset or copied', async () => {
    // The whole point of a denylist. If someone adds a field to estimates and
    // it is neither provenance nor copied, this fails and names it.
    const RESET = new Set([
      'id', 'updated_at', 'created_at', 'owner_id', 'organization_id', 'is_locked',
      'approval_status', 'approved_at', 'approved_by', 'approval_method',
      'declined_at', 'decline_reason', 'sent_at', 'sent_count', 'sent_to',
      'sent_method', 'viewed_at', 'accepted_at', 'signature', 'sign_token',
      'geocode_lat', 'geocode_lng', 'geocode_status', 'geocode_at', 'geocode_addr',
      'job_id', 'status', 'lead_id', '__totals', 'aiPhase', 'created',
      'name', 'bt_export_status', 'btExportStatus', 'estimate_number',
      'bid_due_date', 'expires_on', 'totalProposal', 'lines', 'workbook',
    ]);
    const src = sourceEstimate();
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    const unaccounted = Object.keys(src).filter(
      (k) => k.charAt(0) !== '_' && !RESET.has(k) && !Object.prototype.hasOwnProperty.call(c, k)
    );
    expect(unaccounted).toEqual([]);
  });

  test('keeps group ids and their excludeFromTotal flags verbatim', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c.alternates.map((a) => a.id)).toEqual([BASE_ALT, 'alt_b']);
    expect(c.activeAlternateId).toBe(BASE_ALT);
    // NOT forced true the way a duplicated GROUP is — that would silently drop
    // priced groups out of the copy's total.
    expect(c.alternates[0].excludeFromTotal).toBeUndefined();
    expect(c.alternates[1].excludeFromTotal).toBe(true);
  });

  test('deep-clones groups so editing the copy cannot mutate a SOLD original', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    const src = H.w.appData.estimates.find((e) => e.id === SRC_ID);
    expect(c.alternates).not.toBe(src.alternates);
    c.alternates[0].name = 'RENAMED ON THE COPY';
    expect(src.alternates[0].name).toBe('Base');
  });

  test('deep-clones assemblyBreakdown so the copy does not share the array', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    const copied = linesOf(H.w, c.id).find((l) => l.sourceAssemblyId === 9);
    const orig = linesOf(H.w, SRC_ID).find((l) => l.sourceAssemblyId === 9);
    expect(copied.assemblyBreakdown).not.toBe(orig.assemblyBreakdown);
    copied.assemblyBreakdown[0].unit_cost = 999;
    expect(orig.assemblyBreakdown[0].unit_cost).toBe(46);
  });

  test('copies every line, repoints estimateId, and preserves section order', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    const src = linesOf(H.w, SRC_ID);
    const cop = linesOf(H.w, c.id);
    expect(cop).toHaveLength(src.length);
    cop.forEach((l) => expect(l.estimateId).toBe(c.id));
    // Order and structure, not just count — membership IS position.
    expect(cop.map((l) => [l.section || '', l.description]))
      .toEqual(src.map((l) => [l.section || '', l.description]));
    expect(cop.map((l) => l.alternateId)).toEqual(src.map((l) => l.alternateId));
  });

  test('leaves the source estimate and its lines untouched', async () => {
    const beforeEst = JSON.parse(JSON.stringify(H.w.appData.estimates.find((e) => e.id === SRC_ID)));
    const beforeLines = JSON.parse(JSON.stringify(linesOf(H.w, SRC_ID)));
    await H.w.duplicateEstimate(SRC_ID);
    // No back-pointer, no counter: any mutation makes a SOLD source dirty and
    // ships it on the same push, returning a 'locked' conflict on a row the
    // user never touched.
    expect(H.w.appData.estimates.find((e) => e.id === SRC_ID)).toEqual(beforeEst);
    expect(linesOf(H.w, SRC_ID)).toEqual(beforeLines);
  });

  test('does not disturb a neighbouring estimate', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    expect(linesOf(H.w, OTHER_ID).map((l) => l.id)).toEqual(['x1']);
  });

  test('persists through the GLOBAL saveData, never the editor debouncedSave', async () => {
    // debouncedSave consults the lock of whatever the EDITOR has open — the
    // locked source at this instant — and returns with only a console.warn, so
    // the copy would never be scheduled and would vanish on the next reload.
    await H.w.duplicateEstimate(SRC_ID);
    expect(H.w.saveCount).toBeGreaterThan(0);
    expect(H.w.debouncedSaveCount).toBe(0);
  });

  test('flushes pending edits before copying', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    expect(H.w.flushed).toBe(1);
  });

  test('navigates to the copy', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    expect(H.w.navigatedTo).toEqual({ top: 'estimates', estId: copyOf(H.w).id });
  });

  test('records provenance on the COPY only', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c.duplicatedFromEstimateId).toBe(SRC_ID);
    expect(typeof c.duplicatedAt).toBe('string');
    expect(H.w.appData.estimates.find((e) => e.id === SRC_ID).duplicatedFromEstimateId).toBeUndefined();
  });

  test('a cancelled prompt creates nothing', async () => {
    H.w.promptAnswer = null;
    const before = H.w.appData.estimates.length;
    await H.w.duplicateEstimate(SRC_ID);
    expect(H.w.appData.estimates).toHaveLength(before);
    expect(H.w.saveCount).toBe(0);
  });

  test('a whitespace-only name creates nothing', async () => {
    H.w.promptAnswer = '   ';
    const before = H.w.appData.estimates.length;
    await H.w.duplicateEstimate(SRC_ID);
    expect(H.w.appData.estimates).toHaveLength(before);
  });

  test('an unknown source id is a no-op', async () => {
    const before = H.w.appData.estimates.length;
    await H.w.duplicateEstimate('nope');
    expect(H.w.appData.estimates).toHaveLength(before);
  });
});

// ══════════════════════════════════════════════════════════════════════════
// THE FOUR THINGS AN ADVERSARIAL READ CAUGHT
// Each of these shipped in the first cut of duplicateEstimate and each is
// silent — no error, no toast, nothing on screen that looks wrong.
// ══════════════════════════════════════════════════════════════════════════
describe('regressions found by adversarial review', () => {
  test('`name` is dropped, because it BEATS title on every estimate picker', async () => {
    // The list renders est.title, but the job link-estimate picker and the lead
    // convert picker both read `e.name || e.title`. Keeping `name` makes the
    // copy read "X (copy)" in the list and byte-identical to the sold original
    // in exactly the two controls that decide which estimate becomes SOLD.
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c.name).toBeUndefined();
    expect(c.name || c.title).toBe('My Copy');
  });

  test('the Buildertrend pipeline status is cleared under BOTH spellings', async () => {
    // Blob-only with no shadowing column, so no reload ever corrects it. And
    // clearing `status` is not enough: the agent list query reads
    // COALESCE(btExportStatus, status, 'draft'), consulting the camelCase key
    // FIRST — so the copy would still report "accepted" with status gone.
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c.bt_export_status).toBeUndefined();
    expect(c.btExportStatus).toBeUndefined();
  });

  test('a hydrate DURING the name prompt aborts instead of building a broken copy', async () => {
    // p86Prompt is a DOM overlay, not a blocking call. A hydrate replaces every
    // object in appData.estimates while the estimator types. Building from the
    // captured (now detached) object while cloning lines from the FRESH array
    // yields lines whose alternateId names a group the copy does not have —
    // in no group at all, so invisible on screen AND worth $0 in the total.
    H.w.p86Prompt = function () {
      // the hydrate: every estimate object replaced
      H.w.appData.estimates = H.w.appData.estimates.map((e) => Object.assign({}, e));
      return Promise.resolve('My Copy');
    };
    const before = H.w.appData.estimates.length;
    await H.w.duplicateEstimate(SRC_ID);
    // Re-resolving by id finds the fresh object, so this still succeeds —
    // and critically the copy's groups and lines agree with each other.
    const c = copyOf(H.w);
    expect(H.w.appData.estimates.length).toBe(before + 1);
    const groupIds = new Set(c.alternates.map((a) => a.id));
    linesOf(H.w, c.id).forEach((l) => expect(groupIds.has(l.alternateId)).toBe(true));
  });

  test('an estimate that DISAPPEARS during the prompt creates nothing', async () => {
    H.w.p86Prompt = function () {
      H.w.appData.estimates = H.w.appData.estimates.filter((e) => e.id !== SRC_ID);
      return Promise.resolve('My Copy');
    };
    await H.w.duplicateEstimate(SRC_ID);
    expect(copyOf(H.w)).toBeUndefined();
    expect(H.w.saveCount).toBe(0);
  });

  test('the workbook is fetched from the server, not read from the stale mirror', async () => {
    // js/workspace.js reads and writes the workbook through its own endpoints
    // and never touches appData.estimates (0 references), so a takeoff built
    // this session is simply not in the in-memory record.
    const fresh = { sheets: [{ name: 'Takeoff', cells: { A1: 'BUILT THIS SESSION' } }] };
    let asked = null;
    H.w.fetch = function (url) {
      asked = url;
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ workbook: fresh }) });
    };
    await H.w.duplicateEstimate(SRC_ID);
    expect(asked).toContain('/workbook');
    expect(copyOf(H.w).workbook).toEqual(fresh);
  });

  test('a failed workbook fetch falls back to the mirror rather than failing the copy', async () => {
    H.w.fetch = function () { return Promise.resolve({ ok: false }); };
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    expect(c).toBeTruthy();
    expect(c.workbook).toEqual({ sheets: [{ name: 'Takeoff', cells: { A1: 42 } }] });
  });

  test('a throwing workbook fetch still produces a copy', async () => {
    H.w.fetch = function () { return Promise.reject(new Error('offline')); };
    await H.w.duplicateEstimate(SRC_ID);
    expect(copyOf(H.w)).toBeTruthy();
  });

  test('copied groups do not carry the SOURCE estimate id', async () => {
    H.w.appData.estimates[0].alternates[0].estimateId = SRC_ID;
    await H.w.duplicateEstimate(SRC_ID);
    copyOf(H.w).alternates.forEach((a) => expect(a.estimateId).toBeUndefined());
  });
});

// ══════════════════════════════════════════════════════════════════════════
// UNIQUENESS IS A PROPERTY OF THE CODE, NOT OF THE CLOCK
// ══════════════════════════════════════════════════════════════════════════
describe('with Date.now() frozen to a single millisecond', () => {
  test('duplicating TWICE yields portfolio-wide unique estimate and line ids', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    H.w.promptAnswer = 'Second Copy';
    await H.w.duplicateEstimate(SRC_ID);

    const estIds = H.w.appData.estimates.map((e) => String(e.id));
    expect(estIds).toHaveLength(4); // source + other + 2 copies
    expect(new Set(estIds).size).toBe(estIds.length);

    const lineIds = H.w.appData.estimateLines.map((l) => String(l.id));
    expect(new Set(lineIds).size).toBe(lineIds.length);
  });

  test('the second copy is complete and independent of the first', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const first = copyOf(H.w);
    H.w.promptAnswer = 'Second Copy';
    await H.w.duplicateEstimate(SRC_ID);
    const second = H.w.appData.estimates.find(
      (e) => e.id !== SRC_ID && e.id !== OTHER_ID && e.id !== first.id
    );
    expect(second).toBeTruthy();
    expect(linesOf(H.w, second.id)).toHaveLength(linesOf(H.w, SRC_ID).length);
    expect(linesOf(H.w, first.id)).toHaveLength(linesOf(H.w, SRC_ID).length);
  });

  test('a copy of a copy is still clean and unique', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const first = copyOf(H.w);
    H.w.promptAnswer = 'Third Gen';
    await H.w.duplicateEstimate(first.id);
    const ids = H.w.appData.estimateLines.map((l) => String(l.id));
    expect(new Set(ids).size).toBe(ids.length);
  });

  test('section headers keep an s-prefix and content lines an l-prefix', async () => {
    await H.w.duplicateEstimate(SRC_ID);
    const c = copyOf(H.w);
    linesOf(H.w, c.id).forEach((l) => {
      const expected = l.section === '__section_header__' ? 's' : 'l';
      expect(String(l.id).charAt(0)).toBe(expected);
    });
  });
});
