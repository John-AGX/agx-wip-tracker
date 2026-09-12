// NWS raw gridpoint parsing — the numeric half of Site Conditions.
//
// /gridpoints/{wfo}/{x},{y} is a different animal from the /forecast endpoint
// the 7-day card has always used, and it is easy to get wrong in ways that
// still look plausible. Three facts drive everything in this file:
//
//  1. IT IS METRIC-ONLY. `?units=us` works on /gridpoints/.../forecast and
//     returns HTTP 400 "Query parameter units is not recognized" on the raw
//     /gridpoints. So the periods feed arrives in °F and every layer here
//     arrives in °C / km·h⁻¹ / mm / m. A 32 that is really 32°C reads as a
//     cold morning instead of 90°F. Every value leaves this module converted,
//     and the field names say the unit.
//
//  2. VALUES ARE RUN-LENGTH ENCODED. Each entry is
//     { validTime: "<ISO start>/<ISO 8601 duration>", value } and the API
//     "will merge consecutive values that are equal" to save bandwidth. The
//     entries TILE — they are intervals, not samples. Treating one as a point
//     in time throws most of the forecast away: measured against a live grid,
//     heatRisk keeps 3 hours out of 197 (2%), probabilityOfThunder 55 of 191
//     (29%). One heatRisk entry spanned 101 hours.
//
//  3. A DAY IS A LOCAL CALENDAR DAY AT THE SITE. Not UTC, and not the
//     browser's timezone — AGX works Tampa, Orlando, Denver, Phoenix and
//     Texas, and Arizona does not observe DST. /points/{lat,lng} already
//     returns properties.timeZone ("America/New_York"); the wrapper kept only
//     .forecast and threw it away. See the calendar-dates-vs-instants rule:
//     a DATE is a calendar day and must never be shifted by a UTC offset.
'use strict';

// ── units ──────────────────────────────────────────────────────────────
// Named so a caller cannot forget which side they are on.
function cToF(c) { return c == null ? null : (c * 9) / 5 + 32; }
function kmhToMph(k) { return k == null ? null : k * 0.621371; }
function mmToIn(mm) { return mm == null ? null : mm / 25.4; }
function mToFt(m) { return m == null ? null : m * 3.28084; }
function mToMiles(m) { return m == null ? null : m / 1609.344; }

// NWS sentinels. These are real values in the feed that mean "not a
// measurement" and convert into confident nonsense if taken literally:
// ceilingHeight −30.48 m is exactly −100 ft and designates an unlimited
// ceiling; visibility 16093.44 m is exactly 10.00 statute miles, the top of
// the reported scale rather than a forecast of precisely ten miles.
const CEILING_UNLIMITED_M = -30.48;

function round(n, places) {
  if (n == null || isNaN(n)) return null;
  const f = Math.pow(10, places || 0);
  return Math.round(n * f) / f;
}

// ── ISO-8601 durations ─────────────────────────────────────────────────
// NWS emits PT1H, PT3H, P1D, P1DT6H and occasionally minutes. Returns
// milliseconds, or null for anything unparseable — a caller must never
// silently treat an unknown duration as an hour.
function durationMs(iso) {
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(String(iso || ''));
  if (!m) return null;
  const d = parseFloat(m[1] || 0), h = parseFloat(m[2] || 0);
  const min = parseFloat(m[3] || 0), s = parseFloat(m[4] || 0);
  const ms = ((d * 24 + h) * 60 + min) * 60 * 1000 + s * 1000;
  return ms > 0 ? ms : null;
}

// Expand one run-length-encoded layer into explicit [start, end) intervals in
// epoch ms. Unparseable entries are DROPPED, never guessed at.
function expandLayer(layer) {
  const out = [];
  const values = (layer && layer.values) || [];
  for (const entry of values) {
    if (!entry || entry.validTime == null) continue;
    const slash = String(entry.validTime).lastIndexOf('/');
    if (slash < 0) continue;
    const startMs = Date.parse(String(entry.validTime).slice(0, slash));
    const dur = durationMs(String(entry.validTime).slice(slash + 1));
    if (isNaN(startMs) || dur == null) continue;
    out.push({ start: startMs, end: startMs + dur, value: entry.value });
  }
  return out;
}

// Every value whose interval OVERLAPS [startMs, endMs). Overlap, not
// containment: a 101-hour entry contains no single day, and requiring
// containment would drop it from every day it actually covers.
function valuesOverlapping(intervals, startMs, endMs) {
  const out = [];
  for (const iv of intervals) {
    if (iv.value == null) continue;
    if (iv.start < endMs && iv.end > startMs) out.push(iv.value);
  }
  return out;
}

function maxOf(a) { return a.length ? a.reduce((x, y) => (y > x ? y : x)) : null; }
function minOf(a) { return a.length ? a.reduce((x, y) => (y < x ? y : x)) : null; }

// ACCUMULATION layers are not rates. quantitativePrecipitation is "inches that
// fall during this 6-hour bucket", so it may only be summed ONCE, and a bucket
// that straddles local midnight belongs to both days in proportion — counting
// it whole on each side reports the same rain twice and turns a wet evening
// into a wet evening AND a wet morning.
//
// The other trap in the same field is the opposite error: expanding the bucket
// to hourly slices and summing the slices multiplies it by six. Neither is done
// here — the entry is prorated by the fraction of ITS OWN span that lies inside
// the day.
// Duration-weighted MEAN over a window. Needed for sky cover: NWS words its
// forecast from a representative value, so keying our sentence off the MAX
// makes the panel say 'Partly cloudy' beside an NWS line reading 'Mostly
// sunny' — and a panel that contradicts the source printed next to it has no
// credibility left to spend. Weighted by overlap, so a 6h entry counts six
// times a 1h entry rather than once.
function meanWeighted(intervals, startMs, endMs) {
  let num = 0, den = 0;
  for (const iv of intervals) {
    if (iv.value == null) continue;
    const overlap = Math.min(iv.end, endMs) - Math.max(iv.start, startMs);
    if (overlap <= 0) continue;
    num += iv.value * overlap; den += overlap;
  }
  return den > 0 ? num / den : null;
}

function sumProrated(intervals, startMs, endMs) {
  let total = null;
  for (const iv of intervals) {
    if (iv.value == null) continue;
    const overlap = Math.min(iv.end, endMs) - Math.max(iv.start, startMs);
    if (overlap <= 0) continue;
    const span = iv.end - iv.start;
    const share = span > 0 ? overlap / span : 1;
    total = (total == null ? 0 : total) + iv.value * share;
  }
  return total;
}

// ── local calendar days ────────────────────────────────────────────────
// Intl is the only dependency-free way to ask "what local date is this
// instant, in THAT timezone" — and it is correct across DST and across
// America/Phoenix, which has none.
function localParts(ms, timeZone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timeZone || 'UTC',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', hour12: false
  });
  const parts = {};
  for (const p of fmt.formatToParts(new Date(ms))) parts[p.type] = p.value;
  return {
    date: parts.year + '-' + parts.month + '-' + parts.day,
    hour: parseInt(parts.hour === '24' ? '0' : parts.hour, 10)
  };
}

// The [start, end) epoch bounds of a local calendar day. Walks hour by hour
// from a UTC anchor rather than doing offset arithmetic, so a DST transition
// (a 23- or 25-hour day) is handled by construction.
function localDayBounds(dateIso, timeZone) {
  const anchor = Date.parse(dateIso + 'T12:00:00Z');
  if (isNaN(anchor)) return null;
  const DAY = 86400000, HOUR = 3600000;
  let start = anchor;
  while (localParts(start - HOUR, timeZone).date === dateIso) start -= HOUR;
  while (localParts(start, timeZone).date !== dateIso) start += HOUR;
  let end = anchor;
  while (localParts(end, timeZone).date === dateIso) end += HOUR;
  return { start, end, hours: Math.round((end - start) / HOUR), day: DAY };
}

// The working window inside a local day — what a foreman actually cares
// about. A 24-hour maximum can hang a heat number on a day whose heat all
// happened at 2am, and a 24-hour gust max can condemn an afternoon because of
// an overnight squall.
function workWindowBounds(dateIso, timeZone, startHour, endHour) {
  const b = localDayBounds(dateIso, timeZone);
  if (!b) return null;
  const HOUR = 3600000;
  let ws = null, we = null;
  for (let t = b.start; t < b.end; t += HOUR) {
    const h = localParts(t, timeZone).hour;
    if (h >= startHour && h < endHour) {
      if (ws == null) ws = t;
      we = t + HOUR;
    }
  }
  return (ws == null) ? b : { start: ws, end: we };
}

// ── the per-day rollup ─────────────────────────────────────────────────
// Every field carries its unit in its name. Anything the grid does not cover
// for a given day comes back null so the UI can print "—" instead of a zero
// that reads like a measurement. Days 3-8 genuinely have no visibility or
// ceiling data; that is coverage, not an error.
const WORK_START = 7;   // 7am local
const WORK_END = 18;    // 6pm local

function summarizeGrid(gridProps, timeZone, dateIsos, opts) {
  opts = opts || {};
  const L = {};
  const layers = [
    'maxTemperature', 'minTemperature', 'temperature', 'apparentTemperature',
    'heatIndex', 'wetBulbGlobeTemperature', 'windChill', 'dewpoint',
    'relativeHumidity', 'skyCover', 'windSpeed', 'windGust', 'windDirection',
    'probabilityOfPrecipitation', 'probabilityOfThunder',
    'quantitativePrecipitation', 'visibility', 'ceilingHeight',
    'transportWindSpeed'
  ];
  for (const name of layers) L[name] = expandLayer(gridProps && gridProps[name]);

  const out = {};
  for (const dateIso of dateIsos) {
    const day = localDayBounds(dateIso, timeZone);
    if (!day) continue;
    const work = workWindowBounds(dateIso, timeZone, opts.workStart || WORK_START, opts.workEnd || WORK_END);

    const over = (name, a, b) => valuesOverlapping(L[name] || [], a, b);

    // Headline high/low come from maxTemperature/minTemperature, NOT from the
    // hourly temperature layer. On a live grid max(temperature) was 89°F while
    // maxTemperature was exactly 90.0°F — using the wrong one puts this panel
    // one degree away from the header chip for no reason.
    const hiC = maxOf(over('maxTemperature', day.start, day.end));
    const loC = minOf(over('minTemperature', day.start, day.end));

    // Working-hours aggregates. Gust and thunder are the two that must never
    // be averaged — the worst hour is the whole point.
    const gustKmh = maxOf(over('windGust', work.start, work.end));
    const windKmh = maxOf(over('windSpeed', work.start, work.end));
    const dirDeg = over('windDirection', work.start, work.end);
    const thunderPct = maxOf(over('probabilityOfThunder', work.start, work.end));
    const popPct = maxOf(over('probabilityOfPrecipitation', day.start, day.end));
    const rhMax = maxOf(over('relativeHumidity', work.start, work.end));
    const rhMin = minOf(over('relativeHumidity', work.start, work.end));
    const dewC = maxOf(over('dewpoint', work.start, work.end));
    const heatIdxC = maxOf(over('heatIndex', work.start, work.end));
    const wbgtC = maxOf(over('wetBulbGlobeTemperature', work.start, work.end));
    const skyPct = maxOf(over('skyCover', work.start, work.end));
    const skyMin = minOf(over('skyCover', work.start, work.end));
    // Prorated, not summed: see sumProrated. A 6h bucket straddling local
    // midnight is split between the two days it actually covers.
    const qpfMm = sumProrated(L.quantitativePrecipitation || [], day.start, day.end);
    const visM = minOf(over('visibility', work.start, work.end));
    const ceilM = minOf(over('ceilingHeight', work.start, work.end));

    // Air temp during working hours — the number that gates concrete and
    // coatings, which is not the same as the day's headline high.
    const workHiC = maxOf(over('temperature', work.start, work.end));
    const workLoC = minOf(over('temperature', work.start, work.end));

    out[dateIso] = {
      tempMaxF: round(cToF(hiC), 0),
      tempMinF: round(cToF(loC), 0),
      workTempMaxF: round(cToF(workHiC), 0),
      workTempMinF: round(cToF(workLoC), 0),
      heatIndexF: round(cToF(heatIdxC), 0),
      wbgtF: round(cToF(wbgtC), 0),
      dewpointF: round(cToF(dewC), 0),
      humidityMaxPct: round(rhMax, 0),
      humidityMinPct: round(rhMin, 0),
      // The spread a coating cares about: surface must sit above the dew
      // point. We only have AIR temp, so this is an optimistic proxy and the
      // UI must say so — a shaded wall at dawn is colder than the air.
      dewSpreadF: (workLoC != null && dewC != null) ? round(cToF(workLoC) - cToF(dewC), 0) : null,
      windMph: round(kmhToMph(windKmh), 0),
      windGustMph: round(kmhToMph(gustKmh), 0),
      windDirDeg: dirDeg.length ? round(dirDeg[0], 0) : null,
      thunderPct: round(thunderPct, 0),
      precipPct: round(popPct, 0),
      precipIn: qpfMm == null ? null : round(mmToIn(qpfMm), 2),
      skyCoverMaxPct: round(skyPct, 0),
      skyCoverMeanPct: round(meanWeighted(L.skyCover || [], work.start, work.end), 0),
      skyCoverMinPct: round(skyMin, 0),
      visibilityMi: visM == null ? null : round(mToMiles(visM), 1),
      // −30.48 m is NWS for "unlimited", not a ceiling below ground.
      ceilingFt: (ceilM == null) ? null : (ceilM <= CEILING_UNLIMITED_M ? null : round(mToFt(ceilM), 0)),
      ceilingUnlimited: ceilM != null && ceilM <= CEILING_UNLIMITED_M
    };
  }
  return out;
}

// Compass point from degrees — NWS gives windDirection in true degrees on the
// grid, while the periods feed gives an already-worded "SW".
const COMPASS = ['N','NNE','NE','ENE','E','ESE','SE','SSE','S','SSW','SW','WSW','W','WNW','NW','NNW'];
function degToCompass(deg) {
  if (deg == null || isNaN(deg)) return null;
  return COMPASS[Math.round((((deg % 360) + 360) % 360) / 22.5) % 16];
}

module.exports = {
  durationMs,
  expandLayer,
  valuesOverlapping,
  localParts,
  localDayBounds,
  workWindowBounds,
  summarizeGrid,
  degToCompass,
  cToF, kmhToMph, mmToIn, mToFt, mToMiles,
  WORK_START, WORK_END
};
