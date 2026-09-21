/**
 * The org Jobs map and Leads map filters.
 *
 * Neither map had a filter before this. The ⚙ Filter drawer only rendered when
 * `!opts.only`, and both org maps pass `only`, so it existed solely on the
 * Summary card's combined map. Where it did exist, its status chips were
 * explicitly skipped for jobs ("jobs carry free-text statuses"), and the
 * sidebar listed every row regardless of what the pins were filtered to —
 * twelve pins beside a list reading "Jobs 84".
 *
 * What is pinned here is the rule, run through the functions the map itself
 * calls (window.p86EntitiesMap._pure), not a restatement of it:
 *   1. one predicate decides a row for pins, list and counts alike
 *   2. a chip's count respects every OTHER active filter
 *   3. unknown conditions never read as good
 *   4. "overall" conditions discriminate — it must not paint a normal Florida
 *      summer afternoon red for every job
 *   5. per-trade conditions come from the SAME rules as the Site Conditions
 *      panel, so the map and the job page cannot disagree
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const REPO = path.join(__dirname, '..');

function load() {
  const sandbox = {
    window: { escapeHTML: (s) => String(s == null ? '' : s) },
    document: { getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    console: { log() {}, warn() {}, error() {} },
    AbortSignal: { timeout: () => null },
    fetch: () => Promise.reject(new Error('no net')),
    setTimeout, clearTimeout, Math, JSON, Date, Object, Array, String, Number, isNaN
  };
  sandbox.window.window = sandbox.window;
  vm.createContext(sandbox);
  const run = (rel) => vm.runInContext(fs.readFileSync(path.join(REPO, rel), 'utf8'), sandbox, { filename: rel });
  // Site Conditions first: the map's per-trade verdicts come from it.
  run('js/site-conditions.js');
  run('js/entities-map.js');
  return sandbox.window;
}

const W = load();
const P = W.p86EntitiesMap._pure;
const SC = W.p86SiteConditions;

const job = (o) => Object.assign({ kind: 'job', status: 'In Progress', jobType: 'Renovation' }, o);
const lead = (o) => Object.assign({ kind: 'lead', status: 'new', projectType: 'Roofing' }, o);

describe('the pure pieces are really the map\'s', () => {
  test('they are exposed from the shipped module', () => {
    expect(typeof P.sideMatch).toBe('function');
    expect(typeof P.condFor).toBe('function');
  });

  test('the in-mount predicate DELEGATES rather than re-implementing', () => {
    // If a second copy of the rule reappears, the tests below stop describing
    // what the map actually does.
    const src = fs.readFileSync(path.join(REPO, 'js/entities-map.js'), 'utf8');
    expect(src).toMatch(/function matchesSideFilter\(it, exceptKey\) \{[\s\S]{0,300}return sideMatch\(/);
    expect((src.match(/exceptKey !== 'status'/g) || []).length).toBe(1);
  });
});

describe('status and type', () => {
  test('no filter matches everything', () => {
    expect(P.sideMatch(job({}), null)).toBe(true);
  });

  test('a job status filter applies to JOBS — it used to be skipped for them', () => {
    const f = { status: ['In Progress'] };
    expect(P.sideMatch(job({ status: 'In Progress' }), f)).toBe(true);
    expect(P.sideMatch(job({ status: 'Completed' }), f)).toBe(false);
  });

  test('a status the app does not know still matches itself', () => {
    // Statuses are free text; a hand-typed one must be filterable, not vanish.
    expect(P.sideMatch(job({ status: 'Punch list' }), { status: ['Punch list'] })).toBe(true);
  });

  test('a job with no status is reachable as "(none)"', () => {
    expect(P.statusOf(job({ status: '' }))).toBe('(none)');
    expect(P.sideMatch(job({ status: '' }), { status: ['(none)'] })).toBe(true);
  });

  test('type reads jobType for jobs and projectType for leads', () => {
    expect(P.typeOf(job({ jobType: 'Work Order' }))).toBe('Work Order');
    expect(P.typeOf(lead({ projectType: 'Renovation' }))).toBe('Renovation');
    expect(P.sideMatch(job({ jobType: 'Service' }), { type: ['Service'] })).toBe(true);
    expect(P.sideMatch(job({ jobType: 'Service' }), { type: ['Renovation'] })).toBe(false);
  });

  test('filters AND together', () => {
    const f = { status: ['In Progress'], type: ['Renovation'] };
    expect(P.sideMatch(job({}), f)).toBe(true);
    expect(P.sideMatch(job({ jobType: 'Service' }), f)).toBe(false);
    expect(P.sideMatch(job({ status: 'On Hold' }), f)).toBe(false);
  });
});

describe('chip counts respect every OTHER filter', () => {
  test('exceptKey skips only its own dimension', () => {
    // The Status chips' counts must reflect the Type filter, and vice versa —
    // otherwise "Renovation 30" is a number clicking it will not produce.
    const f = { status: ['In Progress'], type: ['Renovation'] };
    const svc = job({ jobType: 'Service' });
    expect(P.sideMatch(svc, f)).toBe(false);          // excluded overall
    expect(P.sideMatch(svc, f, null, 'type')).toBe(true);   // counted for the Type chips
    expect(P.sideMatch(svc, f, null, 'status')).toBe(false); // still out on type
  });
});

describe('conditions', () => {
  test('a job whose conditions have not loaded is EXCLUDED, never counted good', () => {
    // Absence must not read as safe: filtering to "Good" before the forecast
    // arrives must not show every job as good.
    expect(P.sideMatch(job({}), { cond: ['good'] }, null)).toBe(false);
    expect(P.sideMatch(job({}), { cond: ['good'] }, 'good')).toBe(true);
    expect(P.sideMatch(job({}), { cond: ['good'] }, 'poor')).toBe(false);
  });

  test('a calm day is good', () => {
    const c = P.condFor({ windGustMph: 8, thunderPct: 0, precipPct: 5, heatIndexF: 88 });
    expect(c.level).toBe('good');
  });

  test('high winds read poor and SAY high winds', () => {
    const c = P.condFor({ windGustMph: 34, thunderPct: 0, precipPct: 0 });
    expect(c.level).toBe('poor');
    expect(c.why).toMatch(/High winds 34 mph/);
  });

  test('overall DISCRIMINATES on a normal Florida summer afternoon', () => {
    // 41% thunder: the live Tampa reading. Worst-of-four-trades would call this
    // poor (it sinks roofing), which would paint nearly every Florida job red
    // all summer and make the filter useless. Overall calls it watch.
    const tampa = P.condFor({ windGustMph: 9, thunderPct: 41, precipPct: 41, heatIndexF: 103, dewSpreadF: 1 });
    expect(tampa.level).toBe('watch');
    // ...while a genuine washout is still poor.
    const washout = P.condFor({ windGustMph: 12, thunderPct: 70, precipPct: 85 });
    expect(washout.level).toBe('poor');
  });

  test('the trades it rules out are named', () => {
    // The Tampa day: roofing out on thunder, paint out on a 1° dew spread.
    const c = P.condFor({ windGustMph: 9, thunderPct: 41, precipPct: 41, heatIndexF: 103,
      dewSpreadF: 1, humidityMaxPct: 91, workTempMinF: 78, workTempMaxF: 90 });
    expect(c.bad).toEqual(expect.arrayContaining(['roofing', 'paint']));
  });

  test('per-trade verdicts are the Site Conditions panel\'s own', () => {
    // One rule set. If the map computed trades itself, a job could read
    // "good for roofing" on the map and "poor" on its own page.
    const site = { windGustMph: 32, thunderPct: 10, precipPct: 10, dewSpreadF: 20, humidityMaxPct: 60,
      workTempMinF: 70, workTempMaxF: 82 };
    const fromMap = P.condFor(site).trades;
    const fromPanel = SC.advise(site);
    for (const k of Object.keys(fromPanel)) expect(fromMap[k].level).toBe(fromPanel[k].level);
  });

  test('the trades are named in words a crew uses, never internal keys', () => {
    // "Bad for roofing, height" meant nothing: 'height' is the key for
    // gutters / siding / soffit work. Every trade the panel can rule out must
    // have a plain name, so a new trade added there cannot leak its key here.
    const named = { roofing: 'roofing', paint: 'paint', height: 'gutters / siding', concrete: 'concrete' };
    expect(Object.keys(SC.advise({})).sort()).toEqual(Object.keys(named).sort());
    for (const k of Object.keys(named)) expect(P.tradeWords([k])).toBe(named[k]);
    expect(P.tradeWords(['roofing', 'height'])).toBe('roofing, gutters / siding');
  });

  test('no site data means no conditions, not a guess', () => {
    expect(P.condFor(null)).toBeNull();
    expect(P.condFor(undefined)).toBeNull();
  });
});

describe('crew on site and overdue', () => {
  test('crew-on-site filters on real data only', () => {
    // No job carries crewOnSite until time clocks exist, so turning the filter
    // on shows nothing rather than guessing "running" from a status.
    expect(P.sideMatch(job({ crewOnSite: null }), { crew: true })).toBe(false);
    expect(P.sideMatch(job({ crewOnSite: true }), { crew: true })).toBe(true);
  });

  test('overdue is decided by the caller-supplied flag', () => {
    expect(P.sideMatch(lead({}), { overdue: true }, null, null, true)).toBe(true);
    expect(P.sideMatch(lead({}), { overdue: true }, null, null, false)).toBe(false);
  });
});

describe('the endpoint carries what the filters need — and no money', () => {
  const route = fs.readFileSync(path.join(REPO, 'server/routes/map-routes.js'), 'utf8');

  test('jobs carry a type derived from the job NUMBER, not a copied label', () => {
    // The converted-job-type invariant: a job's type must agree with its
    // number's prefix. Reading data.jobType first would let the map disagree.
    expect(route).toMatch(/jobTypes\.labelForNumber\(num, orgJobTypes\)/);
  });

  test('leads carry project type and follow-up date', () => {
    expect(route).toMatch(/projectType: r\.project_type/);
    expect(route).toMatch(/followupAt: r\.next_followup_at/);
  });

  test('crewOnSite is an explicit null hook, not an inferred value', () => {
    expect(route).toMatch(/crewOnSite: null/);
  });

  test('no financial field is added to a requireAuth-only endpoint', () => {
    // This endpoint is gated on authentication alone, so anyone in the org —
    // field crew included — can read it. Money does not belong on it.
    expect(route).not.toMatch(/contractAmount|contract_amount|estimatedCosts|profit/i);
  });
});

describe('saved views', () => {
  test('both maps are registered pages for per-user saved views', () => {
    const lv = fs.readFileSync(path.join(REPO, 'server/routes/list-views-routes.js'), 'utf8');
    expect(lv).toMatch(/'jobs_map'/);
    expect(lv).toMatch(/'leads_map'/);
  });
});
