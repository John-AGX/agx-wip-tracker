/**
 * @jest-environment jsdom
 */
/* ──────────────────────────────────────────────────────────────────────────
 * test/estimate-null-line-resilience.test.js
 *
 * THE PROPERTY:
 *
 *     For ANY estimate whose stored lines[] contains a hole, every entry
 *     point either works or fails LOUDLY. None of them may silently
 *     mislabel a record as changed, and none of them may take an unrelated
 *     record's save down with it.
 *
 * WHY THIS IS THE SHAPE OF THE TEST. `estimateSliceSig` answers one
 * question — "is this row different from what the server has?" — and its
 * catch returned `'unserializable:' + Date.now() + ':' + Math.random()`.
 * A random answer to a change-detection question is not a degraded answer,
 * it is the WRONG answer with a stable sign: YES, FOREVER. And because
 * `appData.estimateLines` is ONE flat portfolio-wide array, the filter that
 * throws sits inside EVERY estimate's signature, so one hole in one record
 * marks the whole portfolio permanently dirty.
 *
 * Worse, and this is what the file actually pins: the SAME unguarded filter
 * builds the push payload (js/app.js pushToServer). It throws BEFORE
 * notifyPushStatus('saving') and AFTER the jobs payload is assembled — so
 * one hole in one estimate is a total save outage for the portfolio, jobs
 * included, and the three flush listeners (pagehide / beforeunload /
 * visibilitychange) each wrap the call in `catch (e) {}`. The tab closes,
 * the exception is eaten, the edit is gone, and nothing appears on screen.
 *
 * ── THE FIXTURE RULE ─────────────────────────────────────────────────────
 * The record is built by a REAL producer (payload-dispatcher's
 * applyLineAdds, the server-side door behind every 86/Scribe line write).
 * The hole is then produced the way storage actually produces one: an
 * `undefined` slot in the array, serialised to JSON — which is precisely
 * what a JSONB round-trip does to it — and handed back through
 * hydrateFromServerEstimates via the harness's model of GET /api/estimates.
 * Nothing here is a literal `null` typed into a fixture array.
 *
 * ── WHAT MAY NOT BE "FIXED" ──────────────────────────────────────────────
 * Section membership in an estimate is ARRAY ORDER: a line belongs to the
 * nearest `__section_header__` above it and nothing else records it. So a
 * hole may be SUBSTITUTED one-for-one but never REMOVED — removing it
 * reindexes the array and moves money between scopes while the cost total
 * sits still. Every scenario below asserts membership survives.
 * ────────────────────────────────────────────────────────────────────────── */
'use strict';

// jsdom's global object has no TextEncoder/TextDecoder, and `pg` (pulled in
// by server/db.js, which payload-dispatcher requires) reaches for them at
// load. Node's own implementations, installed before the require. Nothing
// under test touches them; this only lets the REAL producer be imported into
// the environment js/app.js has to run in.
const { TextEncoder, TextDecoder } = require('util');
if (typeof global.TextEncoder === 'undefined') global.TextEncoder = TextEncoder;
if (typeof global.TextDecoder === 'undefined') global.TextDecoder = TextDecoder;

const fs = require('fs');
const path = require('path');
const { makeServer, boot, settle, jobRow } = require('./helpers/save-harness');
const dispatcher = require('../server/services/payload-dispatcher').internals;

const EST_ROUTES = fs.readFileSync(
  path.join(__dirname, '..', 'server', 'routes', 'estimate-routes.js'), 'utf8');

beforeEach(() => { jest.useRealTimers(); });
const tick = (ms) => new Promise((r) => setTimeout(r, ms));
afterEach(async () => { await tick(50); });

const BASE_ALT = 'alt_default';

/* A REAL record from a REAL producer. Four sections, mixed markups, so
 * ARRAY POSITION is what decides money. */
function producedRecord(estId) {
  const data = {
    id: estId, title: 'Produced ' + estId, defaultMarkup: 0,
    feeFlat: 500, feePct: 2, taxPct: 7,
    alternates: [{ id: BASE_ALT, name: 'Base', isDefault: true, scope: '' }],
    activeAlternateId: BASE_ALT,
    lines: [],
  };
  dispatcher.applyLineAdds(data, [
    { description: 'Slab prep', qty: 1, unit: 'ls', unit_cost: 3400, section_name: 'General Conditions' },
    { description: 'Rebar #4', qty: 800, unit: 'lf', unit_cost: 1.15, section_name: 'Materials & Supplies Costs', markup_pct: 15 },
    { description: 'Concrete pump', qty: 1, unit: 'day', unit_cost: 1250, section_name: 'Subcontractors Costs' },
    { description: 'Finishers', qty: 32, unit: 'hr', unit_cost: 62, section_name: 'Direct Labor', markup_pct: 25 },
    { description: 'Sealer', qty: 40, unit: 'gal', unit_cost: 38, section_name: 'Materials & Supplies Costs' },
  ]);
  data.lines.filter((l) => l.section === '__section_header__')
    .forEach((h, i) => { h.markup = [10, 20, 30, 40][i % 4]; });
  return data;
}

/* THE HOLE, produced the way storage produces one: an `undefined` slot,
 * serialised. JSON.stringify renders a hole/undefined as null, which is
 * exactly what a JSONB column stores and hands back. */
function withHoleAt(rec, idx) {
  const copy = JSON.parse(JSON.stringify(rec));
  copy.lines.splice(idx, 0, undefined);
  const stored = JSON.parse(JSON.stringify(copy));
  // Prove the fixture really is what we claim before anything is asserted on it.
  if (stored.lines[idx] !== null) throw new Error('fixture did not produce a stored null');
  return stored;
}

/* Membership signature — the money-safety clause, stated positionally.
 * A line belongs to the nearest __section_header__ ABOVE it in the array and
 * nothing on the line records that, so this is the only way to see a
 * re-sectioning. Keyed by description + ordinal so it survives a legitimate
 * id change and catches a positional one. Same shape as the helper in
 * test/helpers/estimate-editor-harness.js, inlined because that helper pulls
 * jsdom in and this file already runs IN jsdom. */
function membership(lines) {
  const out = [];
  let header = null;
  let n = 0;
  (lines || []).forEach((l) => {
    if (!l || typeof l !== 'object') return;            // the hole itself…
    if (l.section === '__section_header__') { header = l.description || '(unnamed)'; return; }
    if (!l.description) return;                          // …and its $0 stand-in
    out.push('#' + (n++) + ' ' + (l.description || '') + ' :: ' + (header === null ? '(no section)' : header));
  });
  return out;
}

/* The shared pricing module, not a re-derivation of it. js/pricing-pipeline.js
 * is the single pricing implementation in this repo and forking it is
 * forbidden — an id or a hole is an internal key, and the only way to say
 * "nothing repriced" is to ask the thing that does the pricing. */
const P = require('../js/pricing-pipeline.js');
function priceGroup(est, lines, altId) {
  const group = (lines || []).filter((l) => l && l.alternateId === altId);
  const per = P.computeForLines(est, group);
  const markedUp = P.resolveMarkedUp(per, est);
  const ft = P.applyFeesAndTax(P.num(markedUp), est);
  return { cost: per.subtotal.toFixed(2), sell: P.num(markedUp).toFixed(2), total: ft.total.toFixed(2) };
}

/* Positions that matter structurally, derived from the record rather than
 * guessed: the very front, above a header, between two headers, under the
 * last header, and the very end. */
function positions(rec) {
  const hdr = rec.lines.map((l, i) => (l.section === '__section_header__' ? i : -1)).filter((i) => i >= 0);
  return [
    ['front of the array', 0],
    ['directly above a section header', hdr[1]],
    ['between two headers', hdr[1] + 1],
    ['under the last header', hdr[hdr.length - 1] + 1],
    ['the very end', rec.lines.length],
  ];
}

const PROBE = producedRecord('probe');

describe.each(positions(PROBE))('a stored hole %s', (_label, idx) => {
  async function bootWithHole() {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    // THREE estimates. Only e2 carries the hole. The other two are the
    // control: the defect's signature is that they go dirty too.
    server.seedEstimate('e1', producedRecord('e1'));
    server.seedEstimate('e2', withHoleAt(producedRecord('e2'), idx));
    server.seedEstimate('e3', producedRecord('e3'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle(20);
    return server;
  }

  test('no user edit ⇒ NOTHING is dirty, and the answer is the same twice', async () => {
    await bootWithHole();
    const first = window.p86SaveState();
    const second = window.p86SaveState();
    expect(first.estimateIds).toEqual([]);
    expect(first.jobIds).toEqual([]);
    // A random signature does not merely over-report; it re-randomises, so
    // "is this changed?" is not even a function. Asked twice, same answer.
    expect(second.estimateIds).toEqual(first.estimateIds);
  });

  test('an UNRELATED job edit still reaches the server', async () => {
    const server = await bootWithHole();
    window.appData.jobs[0].contractAmount = 999999;
    await window.p86FlushSave();
    await settle(40);
    expect(server.jobs.get('j1').data.contractAmount).toBe(999999);
  });

  test('a flush shaped like the pagehide listener does not swallow a throw', async () => {
    await bootWithHole();
    window.appData.jobs[0].contractAmount = 424242;
    // The three real listeners are `try { flushPendingSave(); } catch (e) {}`.
    // If the flush throws, the tab closes with the edit gone and nothing on
    // screen — so the throw itself is the defect, not the swallow.
    let threw = null;
    try { window.p86FlushSave(); } catch (e) { threw = e; }
    expect(threw).toBeNull();
    await settle(40);
  });

  test('an edit to the holed estimate round-trips with every array position intact', async () => {
    const server = await bootWithHole();
    const before = JSON.parse(JSON.stringify(server.estimates.get('e2').data.lines));
    const target = window.appData.estimateLines
      .find((l) => l && l.estimateId === 'e2' && l.description === 'Sealer');
    expect(target).toBeTruthy();
    target.unitCost = 41.5;
    await window.p86FlushSave();
    await settle(40);

    const after = server.estimates.get('e2').data.lines;
    // One-for-one. Never shorter — a removed hole reindexes the array and
    // re-sections the estimate.
    expect(after.length).toBe(before.length);
    expect(membership(after)).toEqual(membership(before));
    expect(after.find((l) => l && l.description === 'Sealer').unitCost).toBe(41.5);
    // The hole is SUBSTITUTED, not removed and not left: a real, addressable,
    // $0 line at the same index, which is what keeps every line after it under
    // the header it was already under.
    expect(before[idx]).toBeNull();
    expect(after[idx]).toEqual(expect.objectContaining({
      estimateId: 'e2', description: '', qty: 0, unitCost: 0,
    }));
    expect(String(after[idx].id || '')).not.toBe('');
    // …and it moved no money. Priced through the shared module, the record is
    // what it was, to the cent, apart from the one edit above.
    const est = window.appData.estimates.find((e) => e.id === 'e2');
    const asStored = before.map((l) => (l && l.description === 'Sealer' ? Object.assign({}, l, { unitCost: 41.5 }) : l));
    expect(priceGroup(est, after, BASE_ALT)).toEqual(priceGroup(est, asStored, BASE_ALT));
    // …and the two clean estimates were not dragged onto the wire with it.
    const sent = server.wire.estPayloads[server.wire.estPayloads.length - 1];
    expect(sent.estimates.map((e) => e.id)).toEqual(['e2']);
  });

  test('the clean estimates in the same portfolio are never pushed', async () => {
    const server = await bootWithHole();
    window.appData.jobs[0].contractAmount = 12345;
    await window.p86FlushSave();
    await settle(40);
    const pushedEstimateIds = server.wire.estPayloads
      .reduce((acc, p) => acc.concat((p.estimates || []).map((e) => e.id)), []);
    expect(pushedEstimateIds).toEqual([]);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * THE ONE DOOR THAT CANNOT REPAIR A HOLE — the localStorage cache.
 *
 * hydrateFromServerEstimates repairs holes because it still knows whose they
 * are: they are inside `e.lines`. The boot cache does not have that. It stores
 * appData.estimateLines FLAT, portfolio-wide, and a hole carries no
 * estimateId — so it can be survived but never attributed, and every guard
 * downstream is what the survival is made of.
 *
 * This is not a hypothetical window either. It is the documented Railway
 * deploy window: the boot GET 502s, the client runs on cache with
 * _baselineSource === 'cache', and the hold's own push runs off that memory
 * BEFORE any hydrate has landed.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('a hole seeded from the localStorage cache', () => {
  function seedFrom(recs, holeAt) {
    const flat = [];
    recs.forEach((r) => Array.prototype.push.apply(flat, r.lines));
    flat.splice(holeAt, 0, undefined);
    const wire = JSON.parse(JSON.stringify(flat));
    if (wire[holeAt] !== null) throw new Error('fixture did not produce a stored null');
    return function (ls) {
      ls.setItem('p86-jobs-jobs', JSON.stringify([jobRow('j1')]));
      ['buildings', 'phases', 'subs', 'changeorders', 'purchaseorders', 'invoices']
        .forEach((k) => ls.setItem('p86-jobs-' + k, '[]'));
      ls.setItem('p86-estimates', JSON.stringify(recs.map((r) => {
        const meta = Object.assign({}, r);
        delete meta.lines;
        return meta;
      })));
      ls.setItem('p86-estimate-lines', JSON.stringify(wire));
    };
  }

  async function bootOnCacheAfterAFailedGet() {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    const e1 = producedRecord('e1');
    const e2 = producedRecord('e2');
    server.seedEstimate('e1', e1);
    server.seedEstimate('e2', e2);
    // The cache is what a PREVIOUS successful session left behind, so its
    // estimates carry the server's updated_at — that is what gives a failed
    // boot a real base version instead of a forced write.
    const snap = server.listEstimates().estimates.map((e) => Object.assign({}, e, {
      lines: undefined, alternates: e.alternates,
    }));
    const withLines = snap.map((s) => Object.assign({}, s, {
      lines: (s.id === 'e1' ? e1 : e2).lines,
    }));
    let call = 0;
    boot(server, {
      seedCache: seedFrom(withLines, 3),
      estimatesList: () => {
        call++;
        if (call === 1) return Promise.reject(Object.assign(new Error('Bad Gateway'), { status: 502 }));
        return Promise.resolve(server.listEstimates());
      },
    });
    await window.p86Data.reloadFromServer();
    await settle(20);
    return server;
  }

  test('running on the cache marks NOTHING dirty', async () => {
    await bootOnCacheAfterAFailedGet();
    const st = window.p86SaveState();
    expect(st.baselineSource).toBe('cache');
    expect(st.writable).toBe(false);          // a failed boot may not push
    expect(st.estimateIds).toEqual([]);
    expect(st.jobIds).toEqual([]);
  });

  test('an edit made in that window is SEEN, and names exactly its own estimate', async () => {
    await bootOnCacheAfterAFailedGet();
    const line = window.appData.estimateLines
      .find((l) => l && l.estimateId === 'e1' && l.description === 'Sealer');
    expect(line).toBeTruthy();
    line.unitCost = 77.25;
    // The whole point of a signature. With the hole unguarded the filter
    // throws and the answer is a coin flip; with the throw swallowed into a
    // CONSTANT the answer is "nothing changed" and the edit is never sent.
    // Only a computed signature can name e1 and not e2.
    expect(window.p86SaveState().estimateIds).toEqual(['e1']);
  });

  test('when the server comes back, the held push carries that edit to it', async () => {
    const server = await bootOnCacheAfterAFailedGet();
    const line = window.appData.estimateLines
      .find((l) => l && l.estimateId === 'e1' && l.description === 'Sealer');
    line.unitCost = 77.25;

    // The recovery load. e1 is dirty, so the hydrate is HELD and the held
    // branch pushes directly — off memory that still holds the cached hole,
    // because no hydrate has landed yet. This is the exact instant the
    // unguarded payload builder threw, silently, inside a promise chain whose
    // catch says nothing.
    await window.p86Data.reloadFromServer();
    await settle(60);

    const stored = server.estimates.get('e1').data.lines;
    expect(stored.find((l) => l && l.description === 'Sealer').unitCost).toBe(77.25);
    // …and e2, which this client never touched, was not rewritten from cache.
    const pushedIds = server.wire.estPayloads
      .reduce((acc, p) => acc.concat((p.estimates || []).map((e) => e.id)), []);
    expect(pushedIds).toEqual(['e1']);
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * WHEN A SIGNATURE GENUINELY CANNOT BE COMPUTED.
 *
 * The hole is now guarded everywhere, so the catch is no longer the hole's
 * exit — but it is still the contract for any row this client cannot
 * describe, and "answer at random" is the wrong contract for a
 * change-detection question. What is DIRECTLY observable from outside is the
 * announcement, and that is what is pinned here: the row is NAMED, once,
 * however many times the question is asked.
 *
 * Stated plainly rather than dressed up: the determinism of the value itself
 * is not independently observable through the public save path, because a row
 * whose signature cannot be serialised cannot be serialised into the push
 * payload either — so it stays dirty under both implementations. The value
 * matters at ONE other call site (handleSaveConflicts compares beforeSig
 * against the post-reload signature to decide whether to tell the user their
 * work was lost, js/app.js), and a random value makes that comparison answer
 * "lost" every single time.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('an estimate this client cannot describe', () => {
  test('is NAMED once, not announced at random and not silently churned', async () => {
    const server = makeServer();
    server.seedJob('j1', jobRow('j1'));
    server.seedEstimate('e1', producedRecord('e1'));
    server.seedEstimate('e2', producedRecord('e2'));
    boot(server);
    await window.p86Data.reloadFromServer();
    await settle(20);

    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      // A cycle in live memory. _stripPrivate copies own keys by value, so the
      // cycle survives the copy and JSON.stringify throws — which is the only
      // way into the catch now that the hole is guarded.
      const e1 = window.appData.estimates.find((e) => e.id === 'e1');
      e1.cycle = e1;

      const asked = [
        window.p86SaveState().estimateIds,
        window.p86SaveState().estimateIds,
        window.p86SaveState().estimateIds,
      ];
      // Only the row that is actually broken, and the same answer every time.
      asked.forEach((a) => expect(a).toEqual(['e1']));

      const named = warn.mock.calls
        .map((c) => c.join(' '))
        .filter((s) => /cannot compute a change signature/.test(s));
      expect(named).toHaveLength(1);
      expect(named[0]).toContain('estimate e1');
    } finally {
      warn.mockRestore();
    }
  });
});

/* ══════════════════════════════════════════════════════════════════════════
 * ROUTE FIDELITY — the server twin of the same filter.
 *
 * server/routes/estimate-routes.js partitions the flat estimateLines array
 * back into per-estimate blobs with the same predicate the client uses. It
 * is unreachable without express + pg, so the PREDICATE ITSELF is lifted out
 * of the shipped source and EXECUTED. Not a substring match: the text that
 * ships is the text that runs here.
 * ═════════════════════════════════════════════════════════════════════════ */
describe('route fidelity — the bulk-save line partition', () => {
  test("estimate-routes' own predicate survives a hole in the incoming array", () => {
    const m = EST_ROUTES.match(/lines:\s*\(estimateLines \|\| \[\]\)\.filter\(([\s\S]*?)\),[\r\n]/);
    expect(m).toBeTruthy();
    const predicate = new Function('est', 'return (' + m[1] + ');')({ id: 'e1' });
    const incoming = [{ estimateId: 'e1' }, null, { estimateId: 'e2' }];
    expect(() => incoming.filter(predicate)).not.toThrow();
    expect(incoming.filter(predicate)).toEqual([{ estimateId: 'e1' }]);
  });

  test('the harness model uses the same guard, so the end-to-end runs are not fiction', () => {
    const MODEL = fs.readFileSync(path.join(__dirname, 'helpers', 'save-harness.js'), 'utf8');
    const m = MODEL.match(/lines:\s*\(body\.estimateLines \|\| \[\]\)\.filter\(([\s\S]*?)\)\s*\}/);
    expect(m).toBeTruthy();
    const predicate = new Function('est', 'return (' + m[1] + ');')({ id: 'e1' });
    expect(() => [null, { estimateId: 'e1' }].filter(predicate)).not.toThrow();
  });
});
