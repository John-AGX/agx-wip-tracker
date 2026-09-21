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

describe('conditions on BOTH maps — which rows are asked about, and where', () => {
  // A fake weather API that records what it was asked and answers a calm day
  // for every id, except ids listed in `fail` (a rejected batch) or `stormy`.
  function fakeApi(o) {
    o = o || {};
    const calls = { jobs: [], leads: [] };
    const answer = (ids) => ({
      weather: Object.fromEntries(ids.map((id) => [id, {
        status: 'ok',
        days: [{ site: (o.stormy || []).includes(id)
          ? { windGustMph: 38, thunderPct: 70, precipPct: 80 }
          : { windGustMph: 6, thunderPct: 0, precipPct: 5, heatIndexF: 85 } }],
      }])),
    });
    return {
      calls,
      jobs(ids, opts) {
        calls.jobs.push({ ids: ids.slice(), opts });
        return (o.fail || []).some((f) => ids.includes(f)) ? Promise.reject(new Error('503')) : Promise.resolve(answer(ids));
      },
      leads(ids) {
        calls.leads.push({ ids: ids.slice() });
        if ((o.fail || []).some((f) => ids.includes(f))) return Promise.reject(new Error('503'));
        const a = answer(ids);
        if (o.inject) a.weather[o.inject] = answer([o.inject]).weather[o.inject];
        return Promise.resolve(a);
      },
    };
  }

  test('the Leads map asks the LEADS endpoint, about OPEN leads only', async () => {
    const api = fakeApi();
    const rows = [
      lead({ id: 'L1', status: 'new' }), lead({ id: 'L2', status: 'in_progress' }),
      lead({ id: 'L3', status: 'sent' }), lead({ id: 'L4', status: 'sold' }),
      lead({ id: 'L5', status: 'lost' }), lead({ id: 'L6', status: 'no_opportunity' }),
    ];
    const r = await P.fetchConditions('lead', rows, api);
    expect(api.calls.jobs).toEqual([]);
    expect(api.calls.leads.map((c) => c.ids)).toEqual([['L1', 'L2', 'L3']]);
    expect(Object.keys(r.byKey).sort()).toEqual(['lead:L1', 'lead:L2', 'lead:L3']);
    expect(r.byKey['lead:L1'].level).toBe('good');
    expect(r.asked).toBe(3);
  });

  test('the Jobs map still asks the JOBS endpoint for site numbers, about ACTIVE jobs only', async () => {
    const api = fakeApi();
    const rows = [job({ id: 'J1', status: 'In Progress' }), job({ id: 'J2', status: 'Completed' }),
      job({ id: 'J3', status: 'On Hold' })];
    const r = await P.fetchConditions('job', rows, api);
    expect(api.calls.leads).toEqual([]);
    expect(api.calls.jobs).toEqual([{ ids: ['J1', 'J3'], opts: { site: true } }]);
    expect(Object.keys(r.byKey).sort()).toEqual(['job:J1', 'job:J3']);
  });

  test('a storm at a lead reads poor and names the trades it rules out', async () => {
    const api = fakeApi({ stormy: ['L1'] });
    const r = await P.fetchConditions('lead', [lead({ id: 'L1' })], api);
    expect(r.byKey['lead:L1'].level).toBe('poor');
    expect(r.byKey['lead:L1'].bad).toEqual(expect.arrayContaining(['roofing']));
  });

  test('a lead and a job with the SAME id cannot share conditions', () => {
    expect(P.condKey(lead({ id: '7' }))).not.toBe(P.condKey(job({ id: '7' })));
  });

  test('asks in batches of 30 (the server caps a call at 120)', async () => {
    const api = fakeApi();
    const rows = Array.from({ length: 65 }, (_, i) => lead({ id: 'L' + i, status: 'new' }));
    const r = await P.fetchConditions('lead', rows, api);
    expect(api.calls.leads.map((c) => c.ids.length)).toEqual([30, 30, 5]);
    expect(Object.keys(r.byKey).length).toBe(65);
  });

  test('a failed batch leaves ITS rows unknown and never rejects', async () => {
    const api = fakeApi({ fail: ['L0'] });
    const rows = Array.from({ length: 35 }, (_, i) => lead({ id: 'L' + i, status: 'new' }));
    const r = await P.fetchConditions('lead', rows, api);
    expect(r.byKey['lead:L0']).toBeUndefined();   // first batch of 30 failed
    expect(r.byKey['lead:L29']).toBeUndefined();
    expect(r.byKey['lead:L30'].level).toBe('good'); // second batch landed
  });

  test('an answer for an id nobody asked about is ignored', async () => {
    const api = fakeApi({ inject: 'L-not-on-this-map' });
    const r = await P.fetchConditions('lead', [lead({ id: 'L1' })], api);
    expect(Object.keys(r.byKey)).toEqual(['lead:L1']);
  });

  test('nothing to ask is a finished answer, and no endpoint is no layer', async () => {
    const api = fakeApi();
    const r = await P.fetchConditions('lead', [lead({ id: 'L1', status: 'sold' })], api);
    expect(r).toEqual(expect.objectContaining({ asked: 0 }));
    expect(api.calls.leads).toEqual([]);
    // The Summary card's combined map (no `only`) and a missing endpoint ask nothing.
    expect(P.fetchConditions(undefined, [lead({})], api)).toBeNull();
    expect(P.fetchConditions('lead', [lead({})], { jobs: api.jobs })).toBeNull();
  });

  describe('the Leads map shows them', () => {
    const src = fs.readFileSync(path.join(REPO, 'js/entities-map.js'), 'utf8');
    const between = (a, b) => {
      const i = src.indexOf(a); const j = src.indexOf(b, i + a.length);
      if (i < 0 || j < 0) throw new Error('anchor missing: ' + (i < 0 ? a : b));
      return src.slice(i, j);
    };

    test('the loader in the map DELEGATES to fetchConditions for either kind', () => {
      const loader = between('function loadConditions(onDone) {', 'var COND_COLOR');
      expect(loader).toMatch(/fetchConditions\(opts\.only, opts\.only === 'lead' \? data\.leads : data\.jobs/);
      // no second copy of the per-kind rule inside the mount
      expect(loader).not.toMatch(/ACTIVE_JOB_STATUSES|OPEN_LEAD_STATUSES|p86Api\.weather\.jobs\(/);
    });

    test('lead rows carry the conditions badge (it was gated off for leads)', () => {
      const badge = between('function condBadge(r) {', 'function rowHTML(');
      expect(badge).not.toMatch(/isLead/);
      expect(badge).toMatch(/condById\[condKey\(r\)\]/);
    });

    test('the lead pin card carries today and "Bad for"', () => {
      const card = between('function showLeadDetail(it) {', 'function showGroupDetail(');
      expect(card).toMatch(/stats: leadStats\.concat\(condStatsFor\(it\)\)/);
    });

    test('the Conditions filter renders on both maps; Crew on site stays jobs-only', () => {
      const filters = between('function paintFilters() {', 'function paintList() {');
      const condAt = filters.indexOf("html += '<div class=\"emap-frow\"><div class=\"emap-flabel\">' + condLabel");
      const gateAt = filters.indexOf('if (!isLead) {');
      expect(condAt).toBeGreaterThan(-1);
      expect(gateAt).toBeGreaterThan(-1);
      expect(condAt).toBeLessThan(gateAt);                        // conditions come BEFORE the jobs-only gate
      expect(filters.slice(gateAt)).toMatch(/Crew on site/);     // crew is behind it
      expect(filters.slice(0, gateAt)).not.toMatch(/Crew on site/);
    });
  });
});

describe('saved views', () => {
  test('both maps are registered pages for per-user saved views', () => {
    const lv = fs.readFileSync(path.join(REPO, 'server/routes/list-views-routes.js'), 'utf8');
    expect(lv).toMatch(/'jobs_map'/);
    expect(lv).toMatch(/'leads_map'/);
  });
});
