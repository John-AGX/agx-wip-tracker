/**
 * @jest-environment jsdom
 */
// A job's phase write, rendered.
//
// THE BUG THIS FIXES. `phase_updates` is the only lever on % complete and
// therefore on revenue earned — the highest-stakes write an agent makes. A
// phase lives in jobs.data.phases and the dispatcher snapshots the whole row,
// so the before/after was always there. But scalarFieldOps SKIPs `data`
// wholesale and returns early on any nested object, so a phase-only write
// produced ZERO ops, diffChangeset filtered the empty group out, and the user
// was told "nothing in it comes out as a change this view can list" about a
// write that moved the job's money.
//
// The first test below is the regression: it fails on the old differ.

jest.useFakeTimers();

let LW;

beforeAll(() => {
  global.fetch = jest.fn(() =>
    Promise.resolve({ ok: true, json: () => Promise.resolve({ payloads: [] }) })
  );
  global.localStorage = { getItem: () => null, setItem: () => {} };
  require('../js/live-writer.js');
  LW = window.p86LiveWriter;
});

// A phase as the app really stores it: the scope NAME lives in `phase`, and
// there is no `name` or `title` field at all.
const P = (id, over) => Object.assign({
  id, phase: 'Framing', jobId: 'j1', pctComplete: 40, phaseBudget: 10000
}, over || {});

const job = (phases, over) => Object.assign({
  id: 'j1', data: Object.assign({ title: 'Harbor Point', status: 'active', phases }, over || {})
}, {});

const entry = (beforePhases, afterPhases, bOver, aOver) => ({
  entity_type: 'job', id: 'j1',
  before: job(beforePhases, bOver),
  after: job(afterPhases, aOver)
});

describe('a phase write is listable at all', () => {
  test('REGRESSION: pctComplete moving produces ops (was zero)', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops.length).toBeGreaterThan(0);
    expect(d.entity_type).toBe('job');
  });

  test('the op is PAINTABLE — it carries the phase id as lineId', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].lineId).toBe('p1');
  });

  test('it is named from `phase`, not the raw id', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].label).toBe('Framing');
    expect(d.ops[0].label).not.toMatch(/^p1$/);
  });

  test('camelCase is humanised — "% complete", not "pctComplete"', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1', { pctComplete: 60 })]));
    expect(d.ops[0].detail).toContain('% complete 40% → 60%');
    expect(d.ops[0].detail).not.toContain('pctComplete');
  });

  test('ONE op per phase, not one per field', () => {
    // Three fields move on one phase. The flash merges on kind + lineId, so
    // three ops would collapse to one paint and only inflate the strip count.
    const d = LW._diffEntry(entry(
      [P('p1')],
      [P('p1', { pctComplete: 60, materials: 500, labor: 250 })]
    ));
    expect(d.ops.length).toBe(1);
    expect(d.ops[0].detail).toContain('materials');
    expect(d.ops[0].detail).toContain('labor');
  });

  test('two phases moving yields two ops, each addressed to its own row', () => {
    const d = LW._diffEntry(entry(
      [P('p1'), P('p2', { phase: 'Stucco' })],
      [P('p1', { pctComplete: 60 }), P('p2', { phase: 'Stucco', pctComplete: 75 })]
    ));
    expect(d.ops.length).toBe(2);
    expect(d.ops.map(o => o.lineId).sort()).toEqual(['p1', 'p2']);
    expect(d.ops.map(o => o.label).sort()).toEqual(['Framing', 'Stucco']);
  });
});

describe('money, and the three-field mirror', () => {
  // phaseRevenue is a TRUTHY chain: asSoldRevenue || asSoldPhaseBudget ||
  // phaseBudget. Because the read stops at the first non-zero, a write can
  // change the stored bytes and move no money at all.
  test('revenue is reported ONCE, derived, when it actually moves', () => {
    const d = LW._diffEntry(entry(
      [P('p1', { phaseBudget: 10000 })],
      [P('p1', { phaseBudget: 12000 })]
    ));
    expect(d.ops[0].detail).toContain('revenue');
    expect(d.ops[0].amount).toBe(2000);
    expect(d.impact).toBe(2000);
  });

  test('THE MIRROR TRAP: a budget field moves but revenue does NOT — no money line', () => {
    // asSoldRevenue is non-zero, so the truthy chain never reaches
    // asSoldPhaseBudget. Moving it changes bytes and moves zero money.
    // Printing a field delta here would be true AND financially false.
    const before = P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 4250 });
    const after  = P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 9999 });
    const d = LW._diffEntry(entry([before], [after]));
    expect(d.ops.length).toBe(1);                       // still reported
    expect(d.ops[0].detail).toMatch(/revenue unchanged/);
    expect(d.ops[0].detail).not.toMatch(/revenue \$/);  // no money delta claimed
    expect(d.ops[0].amount).toBeNull();
    expect(d.impact).toBe(0);
  });

  test('a mirror write that DOES move the chain reports the real delta', () => {
    // asSoldRevenue is the first link, so moving it moves the money.
    const d = LW._diffEntry(entry(
      [P('p1', { asSoldRevenue: 4250, asSoldPhaseBudget: 4250 })],
      [P('p1', { asSoldRevenue: 7500, asSoldPhaseBudget: 4250 })]
    ));
    expect(d.ops[0].amount).toBe(3250);                 // the Oak Bridge number
  });
});

describe('adds, deletes, and not stealing other writes', () => {
  test('a new phase is an add and carries its revenue', () => {
    const d = LW._diffEntry(entry([P('p1')], [P('p1'), P('p2', { phase: 'Paint', phaseBudget: 5000 })]));
    const add = d.ops.find(o => o.kind === 'add');
    expect(add.lineId).toBe('p2');
    expect(add.label).toBe('Paint');
    expect(d.impact).toBe(5000);
  });

  test('a removed phase is a delete and subtracts', () => {
    const d = LW._diffEntry(entry([P('p1'), P('p2', { phase: 'Paint', phaseBudget: 5000 })], [P('p1')]));
    const del = d.ops.find(o => o.kind === 'delete');
    expect(del.lineId).toBe('p2');
    expect(d.impact).toBe(-5000);
  });

  test('SECOND REGRESSION: a field-only job write is listable too', () => {
    // Found by this very test while building the phase fix. The jobs table is
    // `id + data JSONB` plus a few FK columns, so status / title /
    // contractAmount all live INSIDE data — and scalarFieldOps SKIPs data
    // wholesale. So an ordinary job edit reported as nothing either. Fixing
    // only phases would have left this one standing.
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { status: 'active' }),
      after:  job([P('p1')], { status: 'complete' })
    });
    expect(d.ops.length).toBeGreaterThan(0);
    expect(d.ops[0].detail).toContain('active → complete');
    // A job field has no row on the page, so it is correctly
    // reportable-but-not-paintable: no lineId means surface C declines it.
    expect(d.ops.every(o => !o.lineId)).toBe(true);
  });

  test('money-ish job fields are formatted as money', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { contractAmount: 250000 }),
      after:  job([P('p1')], { contractAmount: 275000 })
    });
    expect(d.ops[0].detail).toMatch(/\$250,000.*\$275,000/);
  });

  test('a phase AND a field moving reports both, and only the phase is paintable', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: job([P('p1')], { status: 'active' }),
      after:  job([P('p1', { pctComplete: 90 })], { status: 'complete' })
    });
    const paintable = d.ops.filter(o => o.lineId);
    expect(paintable.length).toBe(1);
    expect(paintable[0].lineId).toBe('p1');
    expect(d.ops.length).toBeGreaterThan(1);           // the field op is there too
  });

  test('a job snapshot with no phases array at all is left to the field differ', () => {
    const d = LW._diffEntry({
      entity_type: 'job', id: 'j1',
      before: { id: 'j1', data: { title: 'Harbor Point', status: 'active' } },
      after:  { id: 'j1', data: { title: 'Harbor Point', status: 'complete' } }
    });
    expect(d.ops.every(o => !o.lineId)).toBe(true);
  });

  test('an estimate is untouched by any of this', () => {
    const d = LW._diffEntry({
      entity_type: 'estimate', id: 'e1',
      before: { id: 'e1', title: 'E', data: { lines: [{ id: 'l1', description: 'X', qty: 1, unitCost: 10 }] } },
      after:  { id: 'e1', title: 'E', data: { lines: [{ id: 'l1', description: 'X', qty: 2, unitCost: 10 }] } }
    });
    expect(d.entity_type).toBe('estimate');
  });
});

// ── the job page as a viewer ──────────────────────────────────────────────
// The scope row is ONE card per scope name aggregating that scope's phase
// record in every building, so it carries all of their ids in data-line-ids.
function mountJobPage(jobId, rowIds) {
  document.body.innerHTML =
    '<div id="job-overview-phases">' +
      rowIds.map(ids => '<div class="p86-sc-row" data-line-ids="' + ids.join(' ') + '"></div>').join('') +
    '</div>' +
    // an identical address outside the root — must never be painted
    '<div id="insp-phases"><div class="p86-sc-row" data-line-ids="p1 p2"></div></div>';
  LW.registerViewer({
    entityType: 'job',
    currentId: () => jobId,
    root: () => document.getElementById('job-overview-phases')
  });
}

describe('the job page glows the scope row that moved', () => {
  afterEach(() => {
    LW.dismiss();
    LW.flashViewerRows();
    document.body.innerHTML = '';
    jest.clearAllTimers();
  });

  test('a phase write claims, and paints the ROW that aggregates that record', () => {
    // p2 is Framing in building 2; its row also stands for p1 (building 1).
    mountJobPage('j1', [['p1', 'p2'], ['p3']]);
    const e = LW.ingest([{ entity_type: 'job', id: 'j1',
      before: job([P('p1'), P('p2'), P('p3', { phase: 'Paint' })]),
      after:  job([P('p1'), P('p2', { pctComplete: 90 }), P('p3', { phase: 'Paint' })]) }],
      { payloadId: 'jp1', state: 'applied' });
    expect(e.claimedBy).toContain('editor-flash');
    expect(LW.flashViewerRows('job', 'j1')).toBeGreaterThan(0);
    const rows = document.querySelectorAll('#job-overview-phases .p86-sc-row');
    expect(rows[0].className).toMatch(/p86lw-flash-/);   // the Framing row, via ~=
    // Not `className === ''` — a row always carries its own p86-sc-row class.
    expect(rows[1].className).not.toMatch(/p86lw-flash-/);      // Paint did not move
    // the Site Plan host carries the same address and must stay dark
    expect(document.querySelector('#insp-phases .p86-sc-row').className).not.toMatch(/p86lw-flash-/);
  });

  test('ONE glow per row, even when several of its records moved', () => {
    // "Set B1 and B2 Framing to 100%" moves two records that share one row.
    mountJobPage('j1', [['p1', 'p2']]);
    const row = document.querySelector('#job-overview-phases .p86-sc-row');
    const add = jest.spyOn(row.classList, 'add');
    LW.ingest([{ entity_type: 'job', id: 'j1',
      before: job([P('p1'), P('p2')]),
      after:  job([P('p1', { pctComplete: 100 }), P('p2', { pctComplete: 100 })]) }],
      { payloadId: 'jp2', state: 'applied' });
    LW.flashViewerRows('job', 'j1');
    jest.advanceTimersByTime(1200);                      // past every stagger
    const flashes = add.mock.calls.filter(c => /^p86lw-flash-/.test(c[0])).length;
    expect(flashes).toBe(1);                             // not a stutter of two
  });

  test('a job that is not on screen does not claim', () => {
    document.body.innerHTML = '';
    LW.registerViewer({ entityType: 'job', currentId: () => null, root: () => null });
    const e = LW.ingest([{ entity_type: 'job', id: 'j1',
      before: job([P('p1')]), after: job([P('p1', { pctComplete: 70 })]) }],
      { payloadId: 'jp3', state: 'applied' });
    expect(e.claimedBy).not.toContain('editor-flash');
    // and the strip still reports it
    expect(document.getElementById('p86-live-writer')).not.toBeNull();
  });

  test('the strip names the job by number and title, never "job"', () => {
    const d = LW._diffEntry({ entity_type: 'job', id: 'j1783286666833',
      before: { id: 'j1783286666833', data: { jobNumber: 'RV2041', title: 'Harbor Point', phases: [P('p1')] } },
      after:  { id: 'j1783286666833', data: { jobNumber: 'RV2041', title: 'Harbor Point', phases: [P('p1', { pctComplete: 50 })] } } });
    expect(d.name).toBe('RV2041 · Harbor Point');
  });
});

describe('jobs.js wiring', () => {
  const fs = require('fs'), path = require('path');
  const JOBS = fs.readFileSync(path.join(__dirname, '..', 'js', 'jobs.js'), 'utf8');

  test('the scope row carries every record id, via the SAME encoder the lookup uses', () => {
    expect(JOBS).toMatch(/window\.p86DomRef\.enc\(p\.id\)/);
    expect(JOBS).toMatch(/data-line-ids="' \+ _lineIds \+ '"/);
    // a whitespace token can never match ~=, so it must not be written
    // Plain string, not a regex: a regex for a regex is where this assertion
    // went wrong the first time (\s silently meant "any whitespace").
    expect(JOBS.includes('return t && !/\\s/.test(t);')).toBe(true);
  });

  test('the flash fires AFTER the repaint, never off the event', () => {
    const fn = JOBS.slice(JOBS.indexOf('window.p86JobDetailRefresh = function'),
                          JOBS.indexOf('function renderJobDetail('));
    const render = fn.indexOf('renderJobDetail(id);');
    const flash = fn.indexOf("flashViewerRows('job', id)");
    expect(render).toBeGreaterThan(-1);
    expect(flash).toBeGreaterThan(render);
  });

  test('the typing retry is bounded by a COUNT, not the wall clock', () => {
    const fn = JOBS.slice(JOBS.indexOf('function scheduleJobTypingRetry'),
                          JOBS.indexOf('window.p86JobDetailRefresh = function'));
    expect(fn).toMatch(/_jobTypingTries >= JOB_TYPING_MAX_TRIES/);
    expect(fn).not.toMatch(/Date\.now\(\)/);
    const tries = Number((JOBS.match(/JOB_TYPING_MAX_TRIES = (\d+)/) || [])[1]);
    expect(tries * 1200).toBeLessThan(60000);            // under the flash TTL
  });

  test('the viewer is scoped to the classic overview host, not the Site Plan', () => {
    expect(JOBS).toMatch(/entityType: 'job',[\s\S]{0,120}root: function \(\) \{ return document\.getElementById\('job-overview-phases'\); \}/);
    // registered from the render, because this file loads before live-writer.js
    expect(JOBS).toMatch(/function renderJobDetail\(jobId\) \{[\s\S]{0,160}registerJobLiveWriterViewer\(\);/);
  });
});
