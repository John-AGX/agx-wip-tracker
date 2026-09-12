/**
 * Site Conditions — the numbers, and the advice built on them.
 *
 * The NWS raw grid is METRIC-ONLY (`?units=us` returns HTTP 400 on
 * /gridpoints and 200 on /gridpoints/../forecast), while the periods feed the
 * old card used is already °F. So this panel mixes two unit systems in one
 * object, and the failure mode is not a crash — it is a number that looks
 * completely reasonable and is wrong. 32 °C read as 32 °F is a frosty morning
 * instead of 90°. Most of this file is about that.
 *
 * The other half is aggregation. A daily rollup hides the hour that hurts
 * someone: a gust maximum averaged across 24 hours, or a heat number taken
 * from 2am, is worse than no number because it carries the authority of one.
 */
'use strict';

const grid = require('../server/weather-grid');

describe('unit conversions — a wrong one ships a plausible wrong number', () => {
  test('celsius to fahrenheit', () => {
    expect(grid.cToF(0)).toBe(32);
    expect(grid.cToF(100)).toBe(212);
    expect(Math.round(grid.cToF(32.2222))).toBe(90);   // the live Tampa high
  });

  test('32 degrees is NOT 32 degrees — the trap this file exists for', () => {
    // A grid value of 32 is 89.6°F. Passed through unconverted it reads as a
    // near-freezing morning, which is a plausible number in Denver in March
    // and would never look like a bug.
    expect(grid.cToF(32)).toBeCloseTo(89.6, 1);
    expect(grid.cToF(32)).not.toBe(32);
  });

  test('km/h to mph — and it must not be the 13%-low inverse', () => {
    expect(grid.kmhToMph(100)).toBeCloseTo(62.14, 1);
    // Dividing by 1.609344 and multiplying by it differ by 13% at 30 mph,
    // and the wrong direction UNDER-reports wind, which is the unsafe way.
    expect(grid.kmhToMph(48.28)).toBeCloseTo(30, 0);
    expect(grid.kmhToMph(48.28)).not.toBeCloseTo(77.7, 0);
  });

  test('mm to inches and metres to miles', () => {
    expect(grid.mmToIn(25.4)).toBeCloseTo(1, 5);
    expect(grid.mToMiles(1609.344)).toBeCloseTo(1, 5);
    expect(grid.mToMiles(16093.44)).toBeCloseTo(10, 5);   // NWS's visibility cap
  });

  test('null in, null out — never 32, never 0', () => {
    // A missing reading converted to 0 reads as "calm" or "freezing", both of
    // which are measurements. Absence has to survive the conversion.
    expect(grid.cToF(null)).toBeNull();
    expect(grid.kmhToMph(null)).toBeNull();
    expect(grid.mmToIn(null)).toBeNull();
  });

  test('compass points', () => {
    expect(grid.degToCompass(0)).toBe('N');
    expect(grid.degToCompass(90)).toBe('E');
    expect(grid.degToCompass(225)).toBe('SW');
    expect(grid.degToCompass(359)).toBe('N');
    expect(grid.degToCompass(null)).toBeNull();
  });
});

describe('ISO-8601 durations', () => {
  test('the forms NWS actually emits', () => {
    expect(grid.durationMs('PT1H')).toBe(3600000);
    expect(grid.durationMs('PT3H')).toBe(3 * 3600000);
    expect(grid.durationMs('P1D')).toBe(24 * 3600000);
    expect(grid.durationMs('P1DT6H')).toBe(30 * 3600000);
    expect(grid.durationMs('PT30M')).toBe(30 * 60000);
  });

  test('an unparseable duration is dropped, not guessed at an hour', () => {
    // Guessing would silently mis-scale an accumulation layer.
    expect(grid.durationMs('banana')).toBeNull();
    expect(grid.durationMs('')).toBeNull();
    expect(grid.durationMs(null)).toBeNull();
  });
});

describe('run-length-encoded layers are intervals, not samples', () => {
  const layer = {
    values: [
      { validTime: '2026-09-12T00:00:00+00:00/PT6H', value: 10 },
      { validTime: '2026-09-12T06:00:00+00:00/PT6H', value: 20 }
    ]
  };

  test('each entry expands to its own span', () => {
    const iv = grid.expandLayer(layer);
    expect(iv).toHaveLength(2);
    expect(iv[0].end - iv[0].start).toBe(6 * 3600000);
  });

  test('a value is found by OVERLAP, not containment', () => {
    // NWS merges equal consecutive values, so one entry can span days — a
    // live heatRisk entry covered 101 hours. Requiring containment drops it
    // from every day it actually covers: measured, that keeps 3 hours of 197.
    const long = grid.expandLayer({
      values: [{ validTime: '2026-09-12T00:00:00+00:00/P5D', value: 3 }]
    });
    const day3 = Date.parse('2026-09-15T00:00:00Z');
    expect(grid.valuesOverlapping(long, day3, day3 + 86400000)).toEqual([3]);
  });

  test('entries with a null value are skipped', () => {
    const iv = grid.expandLayer({ values: [{ validTime: '2026-09-12T00:00:00+00:00/PT1H', value: null }] });
    expect(grid.valuesOverlapping(iv, 0, Date.parse('2030-01-01'))).toEqual([]);
  });
});

describe('a day is a LOCAL calendar day at the site', () => {
  test('a normal day is 24 hours', () => {
    expect(grid.localDayBounds('2026-09-12', 'America/New_York').hours).toBe(24);
  });

  test('the DST fall-back day is 25 hours', () => {
    // Offset arithmetic gets this wrong and silently drops or double-counts an
    // hour of forecast. Walking the zone hour by hour cannot.
    expect(grid.localDayBounds('2026-11-01', 'America/New_York').hours).toBe(25);
  });

  test('the DST spring-forward day is 23 hours', () => {
    expect(grid.localDayBounds('2026-03-08', 'America/New_York').hours).toBe(23);
  });

  test('Arizona has no DST and stays 24 — AGX works Phoenix', () => {
    expect(grid.localDayBounds('2026-11-01', 'America/Phoenix').hours).toBe(24);
    expect(grid.localDayBounds('2026-03-08', 'America/Phoenix').hours).toBe(24);
  });

  test('the same instant is a different local day in different markets', () => {
    // 03:00 UTC is still the previous evening everywhere AGX works.
    const ms = Date.parse('2026-09-13T03:00:00Z');
    expect(grid.localParts(ms, 'America/New_York').date).toBe('2026-09-12');
    expect(grid.localParts(ms, 'America/Denver').date).toBe('2026-09-12');
    expect(grid.localParts(ms, 'UTC').date).toBe('2026-09-13');
  });

  test('the work window is inside the day and shorter than it', () => {
    const day = grid.localDayBounds('2026-09-12', 'America/New_York');
    const work = grid.workWindowBounds('2026-09-12', 'America/New_York', 7, 18);
    expect(work.start).toBeGreaterThanOrEqual(day.start);
    expect(work.end).toBeLessThanOrEqual(day.end);
    expect(work.end - work.start).toBe(11 * 3600000);
  });
});

describe('accumulation is not a rate', () => {
  // quantitativePrecipitation is inches falling IN a 6-hour bucket. Expanding
  // to hourly slices and summing multiplies it by six; counting a straddling
  // bucket whole on both sides reports the same rain twice.
  function qpfFor(dateIso, tz, entries) {
    const props = { quantitativePrecipitation: { values: entries } };
    const out = grid.summarizeGrid(props, tz, [dateIso]);
    return out[dateIso].precipIn;
  }

  test('a 6-hour bucket inside one day counts once, not six times', () => {
    // 25.4mm = exactly 1 inch. Six-fold would report 6.
    const inches = qpfFor('2026-09-12', 'America/New_York', [
      { validTime: '2026-09-12T14:00:00+00:00/PT6H', value: 25.4 }
    ]);
    expect(inches).toBeCloseTo(1, 2);
  });

  test('a bucket straddling local midnight is SPLIT, not counted twice', () => {
    // 8pm-2am Eastern: four hours belong to the 12th, two to the 13th.
    const entries = [{ validTime: '2026-09-13T00:00:00+00:00/PT6H', value: 25.4 }];
    const props = { quantitativePrecipitation: { values: entries } };
    const out = grid.summarizeGrid(props, 'America/New_York', ['2026-09-12', '2026-09-13']);
    const a = out['2026-09-12'].precipIn;
    const b = out['2026-09-13'].precipIn;
    expect(a + b).toBeCloseTo(1, 2);          // the inch is conserved
    expect(a).toBeGreaterThan(0);
    expect(b).toBeGreaterThan(0);
    expect(a).not.toBeCloseTo(1, 2);          // and neither side got it whole
  });
});

describe('NWS sentinel values are not measurements', () => {
  test('ceiling -30.48 m means UNLIMITED, not a ceiling below ground', () => {
    // Converted literally it is -100 ft, which would render as a number.
    const props = { ceilingHeight: { values: [{ validTime: '2026-09-12T12:00:00+00:00/PT6H', value: -30.48 }] } };
    const out = grid.summarizeGrid(props, 'America/New_York', ['2026-09-12'])['2026-09-12'];
    expect(out.ceilingUnlimited).toBe(true);
    expect(out.ceilingFt).toBeNull();
  });

  test('a real ceiling still converts', () => {
    const props = { ceilingHeight: { values: [{ validTime: '2026-09-12T12:00:00+00:00/PT6H', value: 304.8 }] } };
    const out = grid.summarizeGrid(props, 'America/New_York', ['2026-09-12'])['2026-09-12'];
    expect(out.ceilingUnlimited).toBe(false);
    expect(out.ceilingFt).toBe(1000);
  });

  test('a day the grid does not cover is null, never zero', () => {
    // Visibility and ceiling coverage runs out around 48h; days 3-8 have none.
    // Zero would read as "no visibility", which is a forecast of fog.
    const out = grid.summarizeGrid({}, 'America/New_York', ['2026-09-20'])['2026-09-20'];
    expect(out.visibilityMi).toBeNull();
    expect(out.windGustMph).toBeNull();
    expect(out.heatIndexF).toBeNull();
  });
});

describe('the advisories are guidance, and every one shows its number', () => {
  let SC;
  beforeAll(() => {
    global.window = { escapeHTML: (s) => String(s == null ? '' : s) };
    global.AbortSignal = { timeout: () => null };
    global.fetch = () => Promise.reject(new Error('no net'));
    jest.isolateModules(() => { require('../js/site-conditions.js'); });
    SC = global.window.p86SiteConditions;
  });

  const CALM = {
    skyCoverMeanPct: 10, precipPct: 0, precipIn: 0, thunderPct: 0,
    windMph: 4, windGustMph: 6, windDir: 'N', heatIndexF: 78,
    humidityMinPct: 40, humidityMaxPct: 55, dewSpreadF: 20,
    workTempMinF: 68, workTempMaxF: 78
  };

  test('a calm day reads good across the board', () => {
    const a = SC.advise(CALM);
    for (const k of Object.keys(a)) expect(a[k].level).toBe('good');
  });

  test('EVERY verdict carries the number that drove it', () => {
    // A bare verdict cannot be argued with, and an advisory that cannot be
    // argued with is one a foreman either obeys blindly or ignores.
    for (const site of [CALM, Object.assign({}, CALM, { windGustMph: 35, thunderPct: 60 })]) {
      const a = SC.advise(site);
      for (const k of Object.keys(a)) expect(a[k].why).toMatch(/\d/);
    }
  });

  test('gusts at 30 mph read poor for both work-at-height trades', () => {
    const a = SC.advise(Object.assign({}, CALM, { windGustMph: 32 }));
    expect(a.roofing.level).toBe('poor');
    expect(a.height.level).toBe('poor');
    expect(a.roofing.why).toContain('32');
  });

  test('thunder never reads good, because a forecast cannot clear a cell', () => {
    const a = SC.advise(Object.assign({}, CALM, { thunderPct: 45 }));
    expect(a.roofing.level).toBe('poor');
    expect(a.height.level).toBe('poor');
    expect(a.roofing.why).toMatch(/clear/i);
  });

  test('a tight dew-point spread stops painting even on a sunny day', () => {
    // The live Tampa case: 1°F spread under a mostly-sunny sky. Nothing else
    // on the panel would have told anyone.
    const a = SC.advise(Object.assign({}, CALM, { dewSpreadF: 1 }));
    expect(a.paint.level).toBe('poor');
    expect(a.paint.why).toContain('1°');
    // …and it is specifically a PAINT problem, not a general one.
    expect(a.roofing.level).toBe('good');
  });

  test('high humidity stops painting', () => {
    expect(SC.advise(Object.assign({}, CALM, { humidityMaxPct: 92 })).paint.level).toBe('poor');
  });

  test('freezing stops concrete, per ACI cold-weather', () => {
    const a = SC.advise(Object.assign({}, CALM, { workTempMinF: 34, workTempMaxF: 44 }));
    expect(a.concrete.level).toBe('poor');
    expect(a.concrete.why).toContain('34');
  });

  test('missing data never fabricates a verdict', () => {
    // An empty site object must not read as a calm, safe day.
    const a = SC.advise({});
    for (const k of Object.keys(a)) {
      expect(a[k].why).toMatch(/no .* flag|no moisture|no temperature/);
    }
  });
});

describe('the headline says BOTH halves of the day', () => {
  let SC;
  beforeAll(() => {
    global.window = { escapeHTML: (s) => String(s == null ? '' : s) };
    global.AbortSignal = { timeout: () => null };
    global.fetch = () => Promise.reject(new Error('no net'));
    jest.isolateModules(() => { require('../js/site-conditions.js'); });
    SC = global.window.p86SiteConditions;
  });

  test('sky uses the DAYTIME band, matching NWS wording', () => {
    // 40% cover: NWS's own detailedForecast for that live period said "Mostly
    // sunny". The night-time table would say "partly cloudy" and the panel
    // would contradict the source printed beside it.
    expect(SC.skyWord(40)).toBe('Mostly sunny');
    expect(SC.skyWord(10)).toBe('Sunny');
    expect(SC.skyWord(95)).toBe('Overcast');
    expect(SC.skyWord(null)).toBeNull();
  });

  test('a 40% chance of a trace says so', () => {
    // The whole complaint: this day rendered as a storm icon and nothing else.
    const p = SC.precipPhrase({ site: { precipPct: 41, precipIn: 0.03, thunderPct: 41 } });
    expect(p).toContain('41%');
    expect(p).toContain('<0.1"');
    expect(p).toContain('storms');
  });

  test('a real soaking is not dressed down', () => {
    const p = SC.precipPhrase({ site: { precipPct: 90, precipIn: 1.4, thunderPct: 10 } });
    expect(p).toContain('widespread');
    expect(p).toContain('1.40"');
  });

  test('a dry day contributes no precipitation half at all', () => {
    expect(SC.precipPhrase({ site: { precipPct: 3 } })).toBeNull();
  });
});

describe('the compact rail variant, and the negative dew spread', () => {
  let SC;
  beforeAll(() => {
    global.window = { escapeHTML: (s) => String(s == null ? '' : s) };
    global.AbortSignal = { timeout: () => null };
    global.fetch = () => Promise.reject(new Error('no net'));
    jest.isolateModules(() => { require('../js/site-conditions.js'); });
    SC = global.window.p86SiteConditions;
  });

  test('a spread at or below zero says the surface WILL be wet, not may', () => {
    // Real reading from Altamonte Springs: coldest working-hour air two degrees
    // UNDER the highest dew point. That is dew forming, not a near miss, and
    // "may sweat" would understate it.
    const a = SC.advise({ dewSpreadF: -2, humidityMaxPct: 97, precipPct: 61, workTempMinF: 76 });
    expect(a.paint.level).toBe('poor');
    expect(a.paint.why).toMatch(/will be wet/);
    expect(a.paint.why).toContain('-2');
  });

  test('a small positive spread still warns, in the softer wording', () => {
    const a = SC.advise({ dewSpreadF: 2, humidityMaxPct: 70, precipPct: 0, workTempMinF: 70 });
    expect(a.paint.level).toBe('poor');
    expect(a.paint.why).toMatch(/may sweat/);
  });

  test('compact renders a stacked day list, wide renders the column strip', () => {
    const days = [{
      date: '2026-09-12', risk: 'red', tempHigh: 91, tempLow: 76, precipPct: 61, summary: 'Storms',
      site: { skyCoverMeanPct: 40, precipPct: 61, thunderPct: 60, windMph: 5, windGustMph: 10, dewSpreadF: -2 }
    }];
    const w = { status: 'ok', days: days };

    const tall = { innerHTML: '' };
    SC.render(tall, w, { compact: true });
    expect(tall.innerHTML).toContain('p86-sc-list');
    expect(tall.innerHTML).not.toContain('p86-sc-strip');

    const wide = { innerHTML: '' };
    SC.render(wide, w, {});
    expect(wide.innerHTML).toContain('p86-sc-strip');
    expect(wide.innerHTML).not.toContain('p86-sc-list');
  });

  test('render refuses a payload it cannot paint, so the caller can fall back', () => {
    // The job widget and the lead editor both keep their original renderer as
    // the fallback path; it only runs if this returns falsy.
    const host = { innerHTML: '' };
    expect(SC.render(host, { status: 'failed' }, {})).toBe(false);
    expect(SC.render(host, null, {})).toBe(false);
    expect(SC.render(host, { status: 'ok', days: [] }, {})).toBe(false);
  });
});
