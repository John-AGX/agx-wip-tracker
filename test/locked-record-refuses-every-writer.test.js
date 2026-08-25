// test/locked-record-refuses-every-writer.test.js
//
// A MUTATING ACTION ON A LOCKED RECORD REFUSES BECAUSE THE RECORD IS LOCKED,
// AND SAYS SO. INSPECTION KEEPS WORKING.
//
// John: "fix the locked record explode". Release 1.22 disclosed it as open —
// a SOLD estimate and an APPROVED change order both accepted "⇣ Explode to
// editable lines" and were mutated. Explode was not the only one, and it was
// not the worst.
//
// WHAT WAS ACTUALLY WRONG, measured on the shipped bytes rather than inferred.
// Both editors paint a record lock as a CSS class — .ee-locked / .co-locked —
// whose ENTIRE selector list is:
//
//     input, textarea, select, [contenteditable="true"]
//
// A <span> is none of those. Neither is a <button>, and neither is the <div>
// that carries the drag handle. So on a signed-off record the assembly strip's
// "⟳ Reprice from recipe", "⇣ Explode to editable lines", the row's delete
// button and the drag handle were all fully live. They rewrote the record in
// memory; the save then declined afterwards, silently.
//
// THE PASSTHROUGH ATTRIBUTE IS NOT THE CAUSE, and this is asserted below
// rather than assumed. css/edit-gate.css forces pointer-events on
// [data-edit-gate-passthrough] and its descendants, and the estimate's strip
// carries it — but that attribute governs the TOUCH row gate
// ([data-row-edit-gate]), not the record lock, and the change-order editor
// contains ZERO occurrences of it while carrying the identical defect. The
// lock CSS never matched a span with or without it.
//
// SO THE FIX IS NOT IN THE CSS. Widening that selector list to cover spans and
// buttons is enumerating control TYPES again — the same mistake one size
// larger — and it would kill INSPECTION: opening the strip and reading the
// breakdown on a sold estimate is a thing people need to do, and is not
// editing. PRESENTATION IS NOT A PERMISSION. pointer-events, hidden, disabled
// and a missing attribute are all styling; a mutation must refuse because the
// RECORD is locked. Each editor now asks ONE predicate — eeLockReason() /
// coLockReason() — in front of the state, and every writer routes through one
// guarded door (eeMutate/eeRefuse/eeAssertEditable, coMutate/coRefuse/
// coAssertEditable) so a control added next month inherits the refusal.
//
// THE CHANGE-ORDER PREDICATE WAS ALSO WRONG, not just unasked. The server
// (server/routes/change-order-routes.js) asks `status === 'applied'` FIRST and
// `is_locked` second, for two different reasons and with two different
// messages. The client asked only the second. That gap is REACHABLE: PUT
// /change-orders/:id/lock never looks at status, so an admin can clear the
// lock on an APPLIED change order — and the editor then painted no banner, no
// .co-locked and every input live, while every save 409'd. P5 executes the
// real route to prove the client now asks the server's question.
//
// NOTHING STORED WAS EVER MUTATED. The server refuses the change-order PUT
// with 409 and issues no UPDATE (P5 measures this). The damage was a lie on
// screen: an exploded record displayed under a lock banner that said
// read-only. On the ESTIMATE side the residue is realer — js/app.js saveData()
// calls writeToLocalStorage() as its FIRST statement, before any lock, auth or
// push check, so a mutated sold estimate reached the local cache as soon as
// anything else in the app saved.
//
// THE PROPERTIES. Each is a statement about EVERY control and BOTH states, and
// each is RED against the bytes named in PRIOR_SHA — asserted here by booting
// that blob beside the current one, because a suite that only passes proves
// nothing about what it caught.
//
//   P1  A LOCKED RECORD REFUSES EVERY WRITER  — the record is byte-identical
//   P2  AN UNLOCKED RECORD IS UNTOUCHED       — byte-identical to PRIOR bytes
//   P3  INSPECTION WORKS IN BOTH STATES       — locked reads exactly like open
//   P4  A REFUSAL SAYS WHY AND ARMS NO SAVE   — in words, where the user is
//   P5  THE CLIENT ASKS THE SERVER'S QUESTION — measured against the real route
//   P6  RED AGAINST THE SHIPPED BYTES         — every writer mutated, before

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const EE = require('./helpers/estimate-editor-harness.js');
const CO = require('./helpers/change-order-editor-harness.js');

const ROOT = path.join(__dirname, '..');

// The bytes this repair was written on — release 1.22's cut plus the photo
// viewer commit. Both editors carry the defect here, which is measured, not
// described.
const PRIOR_SHA = '7be68cc9434555b952d4d2100362e5c0396cb97c';

function prior(rel) {
  try {
    return execFileSync('git', ['show', PRIOR_SHA + ':' + rel], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 64 * 1024 * 1024,
    }).split('\r\n').join('\n');
  } catch (e) { return null; }
}

// The prior editors have to be FILES for the harnesses to load them as
// <script>, and they must not land anywhere inside the shared working tree.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'p86-prior-lock-'));
function priorFile(rel, name) {
  const src = prior(rel);
  if (!src) return null;
  const p = path.join(TMP, name);
  fs.writeFileSync(p, src);
  return p;
}
const PRIOR_EE = priorFile('js/estimate-editor.js', 'estimate-editor.js');
const PRIOR_CO = priorFile('js/change-order-editor.js', 'change-order-editor.js');

afterAll(() => { EE.closeAll(); CO.closeAll(); });

// ══════════════════════════════════════════════════════════════════════
// FIXTURES — one assembly rollup, because that is the line the strip paints.
// ══════════════════════════════════════════════════════════════════════
const RECIPE = [
  { description: 'Extrusion', qty_per_unit: 12, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
  { description: 'Crew day', qty_per_unit: 1, unit_cost: 1280, cost_code: 'labor', unit: 'day' },
];
// The catalog has MOVED since this record was signed off. Repricing against it
// is the thing that must never happen to something already saved.
const MOVED_CATALOG = () => Promise.resolve({
  ok: true,
  json: () => Promise.resolve({
    assembly: { unit_cost: 5100 },
    flat: [
      { description: 'Extrusion', qty_per_unit: 19, unit_cost: 100, cost_code: 'materials', unit: 'ea' },
      { description: 'Crew day', qty_per_unit: 1, unit_cost: 1410, cost_code: 'labor', unit: 'day' },
    ],
  }),
});

function estimateRecord(locked) {
  return {
    id: 'e1', title: 'Screen enclosure', is_locked: locked, activeAlternateId: 'alt_default',
    lines: [
      { id: 'h1', estimateId: 'e1', alternateId: 'alt_default', section: '__section_header__',
        description: 'Materials & Supplies Costs' },
      { id: 'l1', estimateId: 'e1', alternateId: 'alt_default', section: null,
        description: 'Screen enclosure (assembly)', qty: 1, unitCost: 4000, unit: 'ea',
        sourceAssemblyId: 7, assemblyBreakdown: JSON.parse(JSON.stringify(RECIPE)) },
    ],
  };
}
function coRecord(status, locked) {
  return {
    id: 'co1', job_id: 'job1', status: status, is_locked: locked, title: 'CO 1',
    lines: [
      { id: 'h1', section: '__section_header__', description: 'Materials' },
      { id: 'l1', description: 'Screen enclosure (assembly)', qty: 1, unitCost: 4000, unit: 'ea',
        sourceAssemblyId: 7, assemblyBreakdown: JSON.parse(JSON.stringify(RECIPE)) },
    ],
  };
}

const settle = () => new Promise((r) => setTimeout(r, 50));

// ══════════════════════════════════════════════════════════════════════
// THE WRITERS — each driven through the path the person's finger drives.
//
// Nothing here calls a guard. Every driver reaches for the control the painter
// produced and uses it, so a writer that stopped being guarded shows up as a
// mutated record rather than as a missing call.
// ══════════════════════════════════════════════════════════════════════
const EE_WRITERS = {
  explode:  async (h) => { h.w.__confirm = true; h.w.eeAsmExplode('l1'); await settle(); },
  reprice:  async (h) => { h.w.fetch = MOVED_CATALOG; h.w.eeAsmRefresh('l1'); await settle(); },
  delete:   async (h) => { h.w.__confirm = true; h.w.deleteLineFromEditor('l1'); await settle(); },
  reorder:  async (h) => {
    h.w.onLineDragStart({ dataTransfer: {}, target: { closest: () => null } }, 'l1');
    h.w.onLineDrop({ preventDefault() {} }, 'h1');
    await settle();
  },
  fieldEdit: async (h) => { h.w.updateLineField('l1', 'qty', 99); await settle(); },
  bulkAdd:   async (h) => {
    try {
      h.w.estimateEditorAPI.applyBulkAddLineItems([
        { description: 'Smuggled line', qty: 1, unit_cost: 500, cost_code: 'materials' },
      ]);
    } catch (e) { /* the throw IS the refusal on this surface */ }
    await settle();
  },
  agentDeleteLine: async (h) => {
    try { h.w.estimateEditorAPI.applyDeleteLine({ line_id: 'l1' }); } catch (e) {}
    await settle();
  },
  agentUpdateLine: async (h) => {
    try { h.w.estimateEditorAPI.applyUpdateLine({ line_id: 'l1', qty: 42 }); } catch (e) {}
    await settle();
  },
};

const CO_WRITERS = {
  explode:  async (h) => { h.w.__confirm = true; h.click('[data-asm-explode]'); await settle(); },
  reprice:  async (h) => { h.w.fetch = MOVED_CATALOG; h.click('[data-asm-refresh]'); await settle(); },
  delete:   async (h) => { h.click('[data-line-del]'); await settle(); },
  fieldEdit: async (h) => {
    const input = h.w.document.querySelector('tr[data-line-id="l1"] [data-line-field="qty"]');
    if (input) { input.value = '99'; input.dispatchEvent(new h.w.Event('input', { bubbles: true })); }
    await settle();
  },
  // THE MATERIALS-DRAWER / AGENT DOOR. Reached through the editor's own
  // lineTarget contract — the object openCatalogDrawer() publishes as
  // window.p86ActiveLineTarget. A first draft of this driver guessed at
  // `window.p86ChangeOrders.lineTarget`, which does not exist, so it wrote
  // nothing and P1 and P2 both passed on a locked AND an unlocked record
  // without touching either. Removing BOTH guards behind it changed no test,
  // which is how the vacuum was found.
  bulkAdd: async (h) => {
    try {
      h.T.lineTarget.applyBulkAddLineItems([
        { description: 'Smuggled line', qty: 1, unit_cost: 500, cost_code: 'materials' },
      ]);
    } catch (e) { /* the throw IS the refusal on this surface */ }
    await settle();
  },
};

// Open the strip first for the writers that live inside it.
async function openStripEE(h) { h.w.eeToggleAsmBreakdown('l1'); }
async function openStripCO(h) { h.click('[data-asm-toggle]'); }

function bootEE(locked, editorFile) {
  const h = EE.boot(editorFile ? { editorFile } : {});
  const seen = [];
  h.w.p86Alert = (o) => { seen.push(o); return Promise.resolve(true); };
  h.w.__confirm = true;
  h.hydrate(estimateRecord(locked)).open('e1');
  h.notices = () => seen;
  return h;
}
function bootCO(status, locked, editorFile) {
  const h = CO.boot(editorFile ? { editorFile } : {});
  h.setCo(coRecord(status, locked));
  return h;
}

// ══════════════════════════════════════════════════════════════════════
// P1 — A LOCKED RECORD REFUSES EVERY WRITER
// ══════════════════════════════════════════════════════════════════════
describe('P1 — for ANY locked record, no control in the editor mutates it', () => {
  for (const name of Object.keys(EE_WRITERS)) {
    test(`estimate · SOLD · ${name} leaves the record byte-identical`, async () => {
      const h = bootEE(true);
      await openStripEE(h);
      const before = JSON.stringify(h.lines());
      await EE_WRITERS[name](h);
      expect(JSON.stringify(h.lines())).toBe(before);
    });
  }
  // BOTH change-order lock shapes, because they are two different questions.
  for (const [label, status, locked] of [['APPROVED', 'approved', true], ['APPLIED', 'applied', false]]) {
    for (const name of Object.keys(CO_WRITERS)) {
      test(`change order · ${label} · ${name} leaves the record byte-identical`, async () => {
        const h = bootCO(status, locked);
        await openStripCO(h);
        const before = JSON.stringify(h.co());
        await CO_WRITERS[name](h);
        expect(JSON.stringify(h.co())).toBe(before);
      });
    }
  }
});

// ══════════════════════════════════════════════════════════════════════
// P2 — AN UNLOCKED RECORD IS UNTOUCHED
//
// Measured against the PRIOR bytes running the same driver on the same
// fixture, not against a description of what they used to do. A draft must
// still explode, reprice, delete and reorder exactly as it did.
// ══════════════════════════════════════════════════════════════════════
describe('P2 — for ANY unlocked record, every control still works exactly as before', () => {
  for (const name of Object.keys(EE_WRITERS)) {
    test(`estimate · DRAFT · ${name} produces the same record as the shipped bytes`, async () => {
      const now = bootEE(false);
      await openStripEE(now);
      await EE_WRITERS[name](now);

      expect(PRIOR_EE).toBeTruthy();
      const was = bootEE(false, PRIOR_EE);
      await openStripEE(was);
      await EE_WRITERS[name](was);

      // Ids are minted per run; everything else must match to the byte.
      expect(EE.withoutIds(now.lines())).toEqual(EE.withoutIds(was.lines()));
      // Section membership is ARRAY ORDER — the money-safety signature.
      expect(EE.membership(now.lines())).toEqual(EE.membership(was.lines()));
      // And it must actually have DONE something, or this proves nothing.
      const untouched = JSON.stringify(EE.withoutIds(estimateRecord(false).lines));
      expect(JSON.stringify(EE.withoutIds(now.lines()))).not.toBe(untouched);
    });
  }
  for (const name of Object.keys(CO_WRITERS)) {
    test(`change order · DRAFT · ${name} produces the same record as the shipped bytes`, async () => {
      const now = bootCO('draft', false);
      await openStripCO(now);
      await CO_WRITERS[name](now);

      expect(PRIOR_CO).toBeTruthy();
      const was = bootCO('draft', false, PRIOR_CO);
      await openStripCO(was);

      // NAMED UNCOVERED PATH — stated, not skipped quietly. The bulk adder is
      // reached in the browser through window.p86ActiveLineTarget, which ONLY
      // openCatalogDrawer() sets; the prior bytes expose no other door to it,
      // so "the same as before" cannot be measured for that one driver. Its
      // locked-record refusal IS measured (P1), and what is asserted here
      // instead is that a draft still gains exactly the line asked for.
      if (name === 'bulkAdd') {
        expect(was.T.lineTarget).toBeUndefined();   // the reason, asserted
        const added = now.lines().filter((l) => l.description === 'Smuggled line');
        expect(added).toHaveLength(1);
        expect(added[0].unitCost).toBe(500);
        return;
      }

      await CO_WRITERS[name](was);
      expect(CO.withoutIds(now.lines())).toEqual(CO.withoutIds(was.lines()));
      // ANTI-VACUITY. Two records that are equal because NEITHER driver did
      // anything prove nothing at all — and that is not hypothetical: the
      // bulkAdd driver reached a name that did not exist, so this comparison
      // passed on two untouched records until a both-layers mutation exposed
      // it. Every driver must have MOVED the draft.
      const untouched = JSON.stringify(CO.withoutIds(coRecord('draft', false).lines));
      expect(JSON.stringify(CO.withoutIds(now.lines()))).not.toBe(untouched);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════
// P3 — INSPECTION WORKS IN BOTH STATES
//
// The constraint that rules out every presentation-shaped fix. If a sold
// estimate got harder to READ, the repair is wrong.
// ══════════════════════════════════════════════════════════════════════
describe('P3 — inspection works in both states', () => {
  test('estimate · the assembly strip opens and reads the same locked as unlocked', async () => {
    const sold = bootEE(true);
    const draft = bootEE(false);
    await openStripEE(sold);
    await openStripEE(draft);
    const soldHTML = sold.w.document.getElementById('ee-lines-container').innerHTML;
    const draftHTML = draft.w.document.getElementById('ee-lines-container').innerHTML;

    for (const html of [soldHTML, draftHTML]) {
      expect(html).toContain('Extrusion');
      expect(html).toContain('Crew day');
      expect(html).toContain('Explode to editable lines');
      expect(html).toContain('Refresh price from recipe');
      expect(html).toContain('Open assembly');
    }
    // Every component row and both money columns are present on the sold one.
    expect((soldHTML.match(/Extrusion|Crew day/g) || []).length)
      .toBe((draftHTML.match(/Extrusion|Crew day/g) || []).length);
  });

  test('estimate · opening a SOLD estimate raises no dialog at all', async () => {
    // ensureAlternates() calls debouncedSave() from inside openEstimateEditor,
    // so a refusal dialog in that funnel fires on merely OPENING a sold
    // estimate. This is why the save-side refusal is a console warning and the
    // sentence lives at the control instead.
    const h = bootEE(true);
    expect(h.notices()).toEqual([]);
    expect(h.w.__alerts).toEqual([]);
    // …and inspecting still raises nothing.
    await openStripEE(h);
    expect(h.notices()).toEqual([]);
  });

  test('change order · the assembly strip opens and reads the same in every lock state', async () => {
    const states = [['approved', true], ['applied', false], ['draft', false]];
    const htmls = [];
    for (const [status, locked] of states) {
      const h = bootCO(status, locked);
      await openStripCO(h);
      const html = h.html();
      expect(html).toContain('Extrusion');
      expect(html).toContain('Crew day');
      expect(html).toContain('Explode to editable lines');
      expect(html).toContain('Reprice from recipe');
      htmls.push((html.match(/Extrusion|Crew day/g) || []).length);
    }
    expect(htmls[0]).toBe(htmls[2]);
    expect(htmls[1]).toBe(htmls[2]);
  });
});

// ══════════════════════════════════════════════════════════════════════
// P4 — A REFUSAL SAYS WHY, IN WORDS, AND ARMS NO SAVE
//
// "A control that silently does nothing is indistinguishable from a broken
// app." The refusal names the RECORD's state and the way out of it.
// ══════════════════════════════════════════════════════════════════════
describe('P4 — a refused action says why and arms no save', () => {
  test('estimate · SOLD · explode refuses in words, before any confirm', async () => {
    const h = bootEE(true);
    await openStripEE(h);
    await EE_WRITERS.explode(h);
    const n = h.notices();
    expect(n.length).toBeGreaterThan(0);
    expect(String(n[0].title)).toMatch(/Sold|locked/i);
    expect(String(n[0].message)).toMatch(/read-only|locked/i);
    // It tells the person how to proceed rather than only that they cannot.
    expect(String(n[0].message)).toMatch(/Unlock to edit|change order/i);
    // And the explode's own confirm was never raised — nobody is asked to
    // approve a change that cannot happen.
    expect(h.w.__lastConfirm == null || !/Explode/.test(String(h.w.__lastConfirm.message || ''))).toBe(true);
  });

  test('estimate · SOLD · reprice refuses in words — it used to be silent', async () => {
    const h = bootEE(true);
    await openStripEE(h);
    await EE_WRITERS.reprice(h);
    expect(h.notices().length).toBeGreaterThan(0);
    expect(String(h.notices()[0].message)).toMatch(/read-only|locked/i);
  });

  test('change order · APPROVED · refusal names the approval and offers the unlock', async () => {
    const h = bootCO('approved', true);
    await openStripCO(h);
    await CO_WRITERS.explode(h);
    const n = h.notices();
    expect(n.length).toBeGreaterThan(0);
    expect(String(n[0].title)).toMatch(/Approved/i);
    expect(String(n[0].message)).toMatch(/Unlock to edit|Draft/i);
    expect(h.puts()).toHaveLength(0);
  });

  test('change order · APPLIED · refusal is a DIFFERENT sentence and offers no unlock', async () => {
    const h = bootCO('applied', false);
    await openStripCO(h);
    await CO_WRITERS.explode(h);
    const n = h.notices();
    expect(n.length).toBeGreaterThan(0);
    expect(String(n[0].title)).toMatch(/Applied/i);
    // "the WIP has consumed this" is not "unlock it to correct it" — and
    // unlocking an applied CO genuinely does not help, so it is not offered.
    expect(String(n[0].message)).toMatch(/WIP|reported/i);
    expect(String(n[0].message)).not.toMatch(/Unlock to edit/i);
    expect(h.puts()).toHaveLength(0);
  });

  test('change order · a refused writer fires NO PUT and leaves the save pill alone', async () => {
    for (const [status, locked] of [['approved', true], ['applied', false]]) {
      for (const name of Object.keys(CO_WRITERS)) {
        const h = bootCO(status, locked);
        await openStripCO(h);
        await CO_WRITERS[name](h);
        // The 700ms debounce would have fired by now if a save were armed.
        await new Promise((r) => setTimeout(r, 800));
        expect({ name, status, puts: h.puts().length }).toEqual({ name, status, puts: 0 });
      }
    }
  }, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// P5 — THE CLIENT ASKS THE SERVER'S QUESTION
//
// Executed against the REAL route over an instrumented pool, for all four
// (status × is_locked) combinations, so "the client agrees with the server" is
// measured rather than asserted from reading both.
// ══════════════════════════════════════════════════════════════════════
describe('P5 — the client predicate is the server predicate', () => {
  const COMBOS = [
    { status: 'draft', is_locked: false },
    { status: 'approved', is_locked: true },
    { status: 'approved', is_locked: false },  // admin unlocked to correct it
    { status: 'applied', is_locked: false },   // admin unlocked an APPLIED one
    { status: 'applied', is_locked: true },
  ];

  test('for every (status × is_locked), client refusal === server refusal', async () => {
    // The real router over an instrumented pool. EVERYTHING is patched BEFORE
    // the route module is required, because router.put() captures requireAuth
    // by value at definition time — patching afterwards (or resetting modules
    // in between) hands the route the untouched middleware and every request
    // 401s. A first draft of this test did exactly that and reported
    // "serverRefuses: false" for all five combinations, which would have read
    // as "the server does not refuse" when it had never been asked.
    jest.resetModules();

    // Mutable state the stub pool reads, so one app serves every combination.
    let row = null;
    let updateIssued = false;

    const db = require('../server/db');
    const auth = require('../server/auth');
    const realQuery = db.pool.query;
    const realAuth = auth.requireAuth;
    const realCap = auth.requireCapability;

    db.pool.query = async (text, params) => {
      const t = String(text);
      if (/SELECT co\.status, co\.is_locked/i.test(t)) {
        return { rowCount: 1, rows: [{ status: row.status, is_locked: row.is_locked }] };
      }
      if (/^\s*UPDATE job_change_orders/i.test(t)) {
        updateIssued = true;
        if (params && params[0]) row.data = params[0];
        row.updated_at = 'MOVED';
        return { rowCount: 1, rows: [row] };
      }
      if (/FROM job_change_orders/i.test(t)) return { rowCount: 1, rows: [row] };
      if (/FROM jobs/i.test(t)) return { rowCount: 1, rows: [{ id: 'job1', organization_id: 1 }] };
      return { rowCount: 0, rows: [] };
    };
    auth.requireAuth = (req, _res, next) => {
      req.user = { id: 1, organization_id: 1, role: 'admin', capabilities: ['ESTIMATES_EDIT'] };
      next();
    };
    auth.requireCapability = () => (_req, _res, next) => next();

    const express = require('express');
    const router = require('../server/routes/change-order-routes.js');
    const app = express();
    app.use(express.json());
    app.use('/api', router);

    const results = [];
    try {
      for (const combo of COMBOS) {
        row = {
          id: 'co1', job_id: 'job1', status: combo.status, is_locked: combo.is_locked,
          data: { title: 'CO 1', lines: [{ id: 'l1', description: 'Screen enclosure (assembly)' }] },
          updated_at: 'ORIGINAL',
        };
        updateIssued = false;

        const before = JSON.stringify(row.data);
        const res = await new Promise((resolve) => {
          const srv = app.listen(0, () => {
            const payload = JSON.stringify({ title: 'CO 1', lines: [{ id: 'x', description: 'EXPLODED' }] });
            const req = require('http').request({
              port: srv.address().port, path: '/api/change-orders/co1', method: 'PUT',
              headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
            }, (r) => {
              let b = ''; r.on('data', (c) => (b += c));
              r.on('end', () => { srv.close(); resolve({ status: r.statusCode, body: b }); });
            });
            req.on('error', () => { srv.close(); resolve({ status: 0, body: '' }); });
            req.end(payload);
          });
        });

        // The CLIENT's answer for the same row, from the shipped editor.
        const h = bootCO(combo.status, combo.is_locked);
        const clientRefuses = (() => {
          const b = JSON.stringify(h.co());
          const del = h.w.document.querySelector('tr[data-line-id="l1"] [data-line-del]');
          if (del) del.click();
          return JSON.stringify(h.co()) === b;
        })();

        results.push({
          status: combo.status, is_locked: combo.is_locked,
          serverRefuses: res.status === 409,
          serverIssuedUpdate: updateIssued,
          serverLeftRowIdentical: JSON.stringify(row.data) === before,
          clientRefuses,
        });
      }
    } finally {
      db.pool.query = realQuery;
      auth.requireAuth = realAuth;
      auth.requireCapability = realCap;
    }

    // THE AGREEMENT — one row per combination, so a disagreement names itself.
    expect(results).toEqual([
      { status: 'draft',    is_locked: false, serverRefuses: false, serverIssuedUpdate: true,  serverLeftRowIdentical: false, clientRefuses: false },
      { status: 'approved', is_locked: true,  serverRefuses: true,  serverIssuedUpdate: false, serverLeftRowIdentical: true,  clientRefuses: true },
      { status: 'approved', is_locked: false, serverRefuses: false, serverIssuedUpdate: true,  serverLeftRowIdentical: false, clientRefuses: false },
      { status: 'applied',  is_locked: false, serverRefuses: true,  serverIssuedUpdate: false, serverLeftRowIdentical: true,  clientRefuses: true },
      { status: 'applied',  is_locked: true,  serverRefuses: true,  serverIssuedUpdate: false, serverLeftRowIdentical: true,  clientRefuses: true },
    ]);
  }, 30000);
});

// ══════════════════════════════════════════════════════════════════════
// P6 — RED AGAINST THE SHIPPED BYTES
//
// Every property above is worthless unless it FAILS on the code it was written
// against. So the prior blob is booted and driven with the same drivers on the
// same locked fixtures, and each writer is asserted to have MUTATED it.
// ══════════════════════════════════════════════════════════════════════
describe('P6 — against the shipped bytes, every one of these writers mutated a locked record', () => {
  test('estimate · SOLD · the shipped bytes mutated on explode, reprice, delete, reorder and field edit', async () => {
    expect(PRIOR_EE).toBeTruthy();
    const mutatedThen = {};
    for (const name of ['explode', 'reprice', 'delete', 'reorder', 'fieldEdit']) {
      const h = bootEE(true, PRIOR_EE);
      await openStripEE(h);
      const before = JSON.stringify(h.lines());
      await EE_WRITERS[name](h);
      mutatedThen[name] = JSON.stringify(h.lines()) !== before;
    }
    expect(mutatedThen).toEqual({
      explode: true, reprice: true, delete: true, reorder: true, fieldEdit: true,
    });

    // …and the same drivers on the same fixture mutate nothing now.
    const mutatedNow = {};
    for (const name of ['explode', 'reprice', 'delete', 'reorder', 'fieldEdit']) {
      const h = bootEE(true);
      await openStripEE(h);
      const before = JSON.stringify(h.lines());
      await EE_WRITERS[name](h);
      mutatedNow[name] = JSON.stringify(h.lines()) !== before;
    }
    expect(mutatedNow).toEqual({
      explode: false, reprice: false, delete: false, reorder: false, fieldEdit: false,
    });
  }, 30000);

  test('estimate · SOLD · the shipped bytes repriced a sold estimate SILENTLY', async () => {
    const h = bootEE(true, PRIOR_EE);
    await openStripEE(h);
    await EE_WRITERS.reprice(h);
    const line = h.lines().find((l) => l.id === 'l1');
    // The catalog moved and the sold estimate followed it — with no dialog.
    expect(line.unitCost).toBe(5100);
    expect(h.notices()).toEqual([]);

    const fixed = bootEE(true);
    await openStripEE(fixed);
    await EE_WRITERS.reprice(fixed);
    expect(fixed.lines().find((l) => l.id === 'l1').unitCost).toBe(4000);
    expect(fixed.notices().length).toBeGreaterThan(0);
  });

  test('change order · APPROVED and APPLIED · the shipped bytes mutated and fired a PUT', async () => {
    expect(PRIOR_CO).toBeTruthy();
    for (const [status, locked] of [['approved', true], ['applied', false]]) {
      const h = bootCO(status, locked, PRIOR_CO);
      await openStripCO(h);
      const before = JSON.stringify(h.co());
      await CO_WRITERS.explode(h);
      expect(JSON.stringify(h.co())).not.toBe(before);
      // …and it reached the API. The server 409s it (P5), which is why nothing
      // stored was ever mutated — but the editor went on showing the explode.
      await new Promise((r) => setTimeout(r, 800));
      expect(h.puts().length).toBe(1);
    }
  }, 30000);

  test('change order · the LOCK PAINT asks the same question the writers do', async () => {
    // The visible half of the divergence, held behaviourally because a
    // mutation that reverted this paint to `is_locked` alone survived every
    // other property in this file. The banner IS the answer to "why can I not
    // edit this", so an APPLIED change order that paints no banner is a record
    // whose refusal has no explanation anywhere on screen.
    const host = (h) => h.w.document.querySelector('#co-editor-overlay .p86-co-host');
    const banner = (h) => h.w.document.getElementById('co-lock-banner');

    const approved = bootCO('approved', true);
    approved.T.applyCoLockState();
    expect(host(approved).classList.contains('co-locked')).toBe(true);
    expect(banner(approved).textContent).toMatch(/Approved/i);
    expect(banner(approved).querySelector('#co-unlock-btn')).toBeTruthy();

    // APPLIED but UNLOCKED — reachable, because PUT /change-orders/:id/lock
    // never looks at status. This painted NOTHING before.
    const applied = bootCO('applied', false);
    applied.T.applyCoLockState();
    expect(host(applied).classList.contains('co-locked')).toBe(true);
    expect(banner(applied).textContent).toMatch(/Applied/i);
    expect(banner(applied).textContent).toMatch(/WIP|reported/i);
    // …and NO unlock button, because unlocking an applied CO does not help:
    // the server refuses it on status alone. A button into a wall is worse
    // than no button.
    expect(banner(applied).querySelector('#co-unlock-btn')).toBeNull();

    // A draft paints no lock at all.
    const draft = bootCO('draft', false);
    draft.T.applyCoLockState();
    expect(host(draft).classList.contains('co-locked')).toBe(false);
    expect(banner(draft)).toBeNull();
  });

  test('change order · APPLIED-but-unlocked painted as fully editable before', async () => {
    // The reachable divergence: the lock route never looks at status, so an
    // admin can unlock an APPLIED change order. The old client asked only
    // is_locked, so it painted no lock at all on a row the server refuses.
    const was = bootCO('applied', false, PRIOR_CO);
    const now = bootCO('applied', false);
    const host = (h) => h.w.document.querySelector('#co-editor-overlay .p86-co-host');

    // Both editors only paint the lock when applyCoLockState runs, which the
    // real open path does; the measurable difference here is the predicate's
    // own answer, expressed as whether a writer is refused.
    const bWas = JSON.stringify(was.co());
    await openStripCO(was); await CO_WRITERS.delete(was);
    expect(JSON.stringify(was.co())).not.toBe(bWas);      // shipped: mutated

    const bNow = JSON.stringify(now.co());
    await openStripCO(now); await CO_WRITERS.delete(now);
    expect(JSON.stringify(now.co())).toBe(bNow);          // now: refused
    expect(host(now)).toBeTruthy();
  });
});
