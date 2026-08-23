/**
 * @jest-environment jsdom
 */
// test/job-info-card-save-invariant.test.js
//
// THE INVARIANT: no control in the Job Information card may change a value
// the user did not touch.
//
// Not "job type survives a save", and not "pm survives a save". Those are two
// call sites of the same rule, and 6ab945f8 fixed one of them — it gave the
// job-TYPE picker a real source that unions in the record's value, and left
// the two <select>s fifteen lines away in the SAME `FIELDS` literal, read by
// the SAME save loop, still built from hardcoded arrays:
//
//   'job-info-pm':     opts(['John', 'Noah', 'Henry'], job.pm)
//   'job-info-status': opts(['New','Backlog','In Progress',...], job.status)
//
// The pm one was LIVE. A <select> that does not contain the record's value
// resolves to its FIRST option, and the save read that select straight back
// into the job, so any job whose project manager was not one of three
// hardcoded first names — including a job with NO pm at all — was reassigned
// to John by the act of opening the card to fix a title.
//
// So this suite does not test three fields by name. It DISCOVERS every field
// the card renders and every field the save reads, straight out of js/jobs.js,
// and asserts the property over all of them — a field added next month is
// covered the day it is added, and a field that is NOT covered shows up as a
// named failing row rather than being averaged away.
//
// It drives the REAL toggleEditJobInfo() in a real jsdom document: the bug
// lives in the browser's option-selection behaviour, so asserting on the
// generated HTML string would miss it entirely.

const fs = require('fs');
const path = require('path');

const SRC = (f) => fs.readFileSync(path.join(__dirname, '..', 'js', f), 'utf8');
const JOBS_JS = SRC('jobs.js');
const APP_JS = SRC('app.js');

/* ── Lifting the real functions out of a 7k-line browser script ──────────
 * js/jobs.js is not a module and has no export seam. Rather than model the
 * save (a model of the buggy code would have been green all along), the
 * function TEXT is extracted and evaluated with its free variables injected.
 * Anything that changes inside toggleEditJobInfo changes what these tests
 * run. */
function extractFunction(src, name) {
  const start = src.indexOf('function ' + name + '(');
  if (start === -1) throw new Error('extractFunction: no function ' + name);
  let depth = 0;
  for (let j = src.indexOf('{', start); j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}' && --depth === 0) return src.slice(start, j + 1);
  }
  throw new Error('extractFunction: unbalanced braces in ' + name);
}

const TOGGLE_SRC = extractFunction(JOBS_JS, 'toggleEditJobInfo');
const ESCAPE_SRC = extractFunction(APP_JS, 'escapeHTML'); // the real one, not a stand-in

function buildToggle(deps) {
  const factory = new Function(
    'appState', 'appData', 'window', 'document', 'saveData', 'renderJobDetail', 'MUTATE',
    ESCAPE_SRC + '\n' + TOGGLE_SRC + '\nreturn toggleEditJobInfo;'
  );
  return factory(deps.appState, deps.appData, deps.window, deps.document, deps.saveData, deps.renderJobDetail);
}

/* ── What the card is made of, read off the source ────────────────────── */
const FIELDS_SRC = (() => {
  const i = JOBS_JS.indexOf('const FIELDS = {');
  const j = JOBS_JS.indexOf('\n                };', i);
  if (i === -1 || j === -1) throw new Error('cannot find the FIELDS literal');
  return JOBS_JS.slice(i, j);
})();

// Every cell the card swaps into a control: cell id → { inputId, tag }.
// Each entry runs from its own key to the next one (or to the end), so the
// LAST entry is not silently dropped for want of a terminator.
const RENDERED = (() => {
  const keys = [];
  const re = /'(job-info-[a-z-]+)':/g;
  let m;
  while ((m = re.exec(FIELDS_SRC))) keys.push({ cellId: m[1], at: m.index });
  return keys.map((k, i) => {
    const body = FIELDS_SRC.slice(k.at, i + 1 < keys.length ? keys[i + 1].at : FIELDS_SRC.length);
    const id = (body.match(/id="(edit-[A-Za-z]+)"/) || [])[1];
    const tag = /<select/.test(body) ? 'select' : /<textarea/.test(body) ? 'textarea' : 'input';
    return id ? { cellId: k.cellId, inputId: id, tag } : null;
  }).filter(Boolean);
})();

// Every control the SAVE reads, and the job property it writes:
//   if ((v = gv('edit-jobPM')) !== null) job.pm = v;
const SAVED = (() => {
  const out = [];
  const re = /gv\('(edit-[A-Za-z]+)'\)\)\s*!==\s*null\)\s*job\.([A-Za-z]+)\s*=/g;
  let m;
  while ((m = re.exec(JOBS_JS))) out.push({ inputId: m[1], prop: m[2] });
  return out;
})();

const propFor = (inputId) => (SAVED.find((s) => s.inputId === inputId) || {}).prop;

// The rows these tests run over: every control the card renders AND the save
// reads back. Named per field so a gap is visible, not averaged away.
const COVERED = RENDERED.filter((f) => propFor(f.inputId)).map((f) => ({ ...f, prop: propFor(f.inputId) }));
const SELECTS = COVERED.filter((f) => f.tag === 'select');
const row = (f) => [f.cellId + ' → job.' + f.prop, f];

/* ── The world the card runs in ───────────────────────────────────────── */
// The real job-type source. Requiring it in jsdom runs its IIFE, which warms
// the registry off window.p86Api — absent here, so it settles on the product
// defaults. Deterministic, and it is the same helper the browser calls.
const JF = require('../js/job-finalize.js');

// Values no list in this card offers. One per select-backed field, so a
// round trip that "works" by landing on a real option cannot pass by luck.
const OFF_LIST = {
  pm: 'Sarah Whitfield',
  jobType: 'Service & Repair',
  market: 'Sarasota',
  status: 'Awaiting Permit',
};
const offListFor = (prop) => OFF_LIST[prop] || 'ZZ ' + prop + ' nobody offers';

function makeWorld(jobOverrides) {
  const job = {
    id: 'J1',
    jobNumber: 'M0001',
    title: 'Fairways clubhouse',
    client: 'Fairways HOA',
    pm: 'Sarah Whitfield',
    jobType: 'Service & Repair',
    workType: 'Repair',
    market: 'Sarasota',
    contractAmount: 125000,
    estimatedCosts: 90000,
    totalProductionDays: 30,
    startDate: '2026-03-02',
    endDate: '2026-05-01',
    status: 'Awaiting Permit',
    notes: 'Gate code 1122',
    ...jobOverrides,
  };
  const saveData = jest.fn();
  const renderJobDetail = jest.fn();

  // Neither list offers what this job holds — the live shape of the defect.
  window.p86Admin = { getActivePMs: () => [{ name: 'John' }, { name: 'Noah' }, { name: 'Henry' }] };
  window.p86MarketNames = () => ['Orlando', 'Tampa', 'Denver'];
  window.p86JobTypeOptions = JF.typeOptionsHTML;

  document.body.innerHTML =
    '<button id="edit-job-info-btn" data-editing="0"></button>' +
    RENDERED.map((f) => '<div id="' + f.cellId + '"></div>').join('');

  const toggle = buildToggle({
    appState: { currentJobId: 'J1' },
    appData: { jobs: [job] },
    window,
    document,
    saveData,
    renderJobDetail,
  });
  return { job, toggle, saveData, renderJobDetail, before: JSON.parse(JSON.stringify(job)) };
}

const ctl = (f) => document.getElementById(f.inputId);

/* ══ 1 · the property, per field ═════════════════════════════════════════
 * A stored value the control's list does not contain must survive a round
 * trip through a real element and back out of the real save. */
describe('a stored value the picker cannot offer survives the save', () => {
  test.each(SELECTS.map(row))('%s', (_label, f) => {
    const stored = offListFor(f.prop);
    const w = makeWorld({ [f.prop]: stored });
    w.toggle();                       // open the card
    w.toggle();                       // close it, touching nothing
    expect(w.job[f.prop]).toBe(stored);
  });

  test.each(SELECTS.map(row))('%s — and the control SHOWS it', (_label, f) => {
    const stored = offListFor(f.prop);
    const w = makeWorld({ [f.prop]: stored });
    w.toggle();
    // The display half of the same rule: a control that cannot show the
    // stored value is lying to the person deciding whether to change it.
    expect(ctl(f).value).toBe(stored);
    expect(Array.from(ctl(f).options).filter((o) => o.value === stored)).toHaveLength(1);
  });

  test.each(SELECTS.map(row))('%s — a job with NO value is not given one', (_label, f) => {
    const w = makeWorld({ [f.prop]: '' });
    w.toggle();
    expect(ctl(f).value).toBe('');    // not the first real option
    w.toggle();
    expect(w.job[f.prop]).toBe('');
  });

  test.each(SELECTS.map(row))('%s — an EMPTY list still cannot change anything', (_label, f) => {
    // Cold cache / a source that failed to load. The degenerate case is the
    // one that used to be silently destructive.
    window.p86Admin = { getActivePMs: () => [] };
    window.p86MarketNames = () => [];
    const stored = offListFor(f.prop);
    const w = makeWorld({ [f.prop]: stored });
    window.p86Admin = { getActivePMs: () => [] };
    window.p86MarketNames = () => [];
    w.toggle();
    w.toggle();
    expect(w.job[f.prop]).toBe(stored);
  });
});

/* ══ 2 · the property over the WHOLE card ════════════════════════════════ */
describe('opening and closing the card without touching it writes nothing', () => {
  test('every field the save reads is byte-identical afterwards', () => {
    const w = makeWorld();
    w.toggle();
    w.toggle();
    expect(w.job).toEqual(w.before);          // includes: no updatedAt appeared
  });

  test('it does not even call saveData — leaving edit mode is not an edit', () => {
    // A no-op write is not harmless: it stamps updatedAt, which is the
    // version the bulk-save conflict check compares against.
    const w = makeWorld();
    w.toggle();
    w.toggle();
    expect(w.saveData).not.toHaveBeenCalled();
    expect(w.job.updatedAt).toBeUndefined();
  });

  test('a job carrying values NOTHING offers still round-trips whole', () => {
    const odd = {
      pm: '', jobType: '', market: 'Sarasota', status: 'Awaiting Permit',
      workType: '', notes: '', startDate: '', endDate: '',
      jobNumber: 'ZZ0001', title: 'A & B <x> "y"', client: '',
    };
    const w = makeWorld(odd);
    w.toggle();
    w.toggle();
    expect(w.job).toEqual(w.before);
  });
});

/* ══ 3 · the guarantee is not "the save does nothing" ════════════════════ */
describe('a value the user actually changes is still written', () => {
  test.each(SELECTS.map(row))('%s — picking a different option writes it', (_label, f) => {
    const w = makeWorld();
    w.toggle();
    const sel = ctl(f);
    const other = Array.from(sel.options).map((o) => o.value).find((v) => v !== sel.value);
    expect(other).toBeDefined();       // the list must offer something else
    sel.value = other;
    w.toggle();
    expect(w.job[f.prop]).toBe(other);
    expect(w.saveData).toHaveBeenCalledTimes(1);
    expect(typeof w.job.updatedAt).toBe('string');
  });

  test('changing ONE field leaves every other field alone', () => {
    const w = makeWorld();
    w.toggle();
    document.getElementById('edit-jobTitle').value = 'Fairways clubhouse — phase 2';
    w.toggle();
    expect(w.job.title).toBe('Fairways clubhouse — phase 2');
    expect(w.job).toEqual({ ...w.before, title: 'Fairways clubhouse — phase 2', updatedAt: w.job.updatedAt });
    expect(w.saveData).toHaveBeenCalledTimes(1);
  });

  test('clearing a field the user means to clear still clears it', () => {
    // The guard is "did the user touch this", not "is the new value truthy".
    const w = makeWorld();
    w.toggle();
    document.getElementById('edit-jobNotes').value = '';
    w.toggle();
    expect(w.job.notes).toBe('');
    expect(w.saveData).toHaveBeenCalledTimes(1);
  });
});

/* ══ 4 · coverage — a field this suite does NOT cover must be visible ════ */
describe('the card is covered field by field, not by name', () => {
  test('every control the save reads is one the card renders', () => {
    const rendered = RENDERED.map((f) => f.inputId);
    expect(SAVED.map((s) => s.inputId).filter((id) => !rendered.includes(id))).toEqual([]);
  });

  test('the discovered card is the whole card', () => {
    // No count is pinned — the relationship is. The card and the save loop
    // are 1:1 (two independent parsers over two separate stretches of
    // source), so a parser that quietly stopped finding fields shows up as a
    // mismatch rather than as everything above passing vacuously. An empty
    // discovery cannot pass either: test.each([]) is a hard error.
    expect(COVERED.length).toBe(RENDERED.length);
    expect(RENDERED.map((f) => f.inputId).sort()).toEqual(SAVED.map((s) => s.inputId).sort());
    expect(SELECTS.map((f) => f.inputId).sort())
      .toEqual(['edit-jobMarket', 'edit-jobPM', 'edit-jobStatus', 'edit-jobType']);
    // The four properties a picker can destroy, by name, so a rename that
    // drops one out of the card is a red row and not a quieter suite.
    expect(SELECTS.map((f) => f.prop).sort()).toEqual(['jobType', 'market', 'pm', 'status']);
  });

  test('every control is stamped with what it was RENDERED with', () => {
    // The stamp IS the enforcement point: it is what lets the save tell a
    // value the user chose from one the browser chose for them. A future
    // FIELDS entry rendered outside that loop would show up here.
    const w = makeWorld();
    w.toggle();
    COVERED.forEach((f) => {
      const e = ctl(f);
      expect(e).not.toBeNull();
      expect(e.dataset.p86Initial).toBe(e.value);
    });
  });

  test('no list in this card is built without going through opts()', () => {
    // opts() is where the union lives now. A new entry that hand-rolls
    // '<option>' markup would be back to per-call-site enforcement.
    const handRolled = FIELDS_SRC.match(/<option/g) || [];
    expect(handRolled).toEqual([]);
    expect(FIELDS_SRC).not.toMatch(/opts\(\['John', 'Noah', 'Henry'\]/);
  });

  test('the PM list comes from the users table, not three first names', () => {
    expect(JOBS_JS).toMatch(/p86Admin[\s\S]{0,120}getActivePMs/);
    expect(FIELDS_SRC).toMatch(/id="edit-jobPM"[\s\S]{0,120}opts\(pmNames\(\)/);
  });
});
