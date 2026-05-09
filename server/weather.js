// NWS forecast wrapper — free, no API key, US-only, 7-day forecast.
// Two-step API: GET /points/{lat,lng} returns metadata including a
// forecast URL; that URL returns the periods array (12-hour day +
// night chunks for ~7 days).
//
// Per-coordinate cache rounded to 3 decimals (~110 m precision) so
// nearby buildings share entries. 1-hour TTL — NWS updates forecasts
// hourly anyway, so finer caching doesn't help. Cache lives in this
// module's closure; survives until process restart, which is the
// right scope for an idempotent forecast lookup.
//
// rollupByDay() collapses the 12-hour periods into per-day summaries
// the schedule UI can paint as a chip per entry: { date, risk,
// tempHigh, tempLow, precipPct, windMph, summary }.

'use strict';

const UA = 'AGX/Project86 weather lookup (project86.net)';
const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map(); // key: "lat,lng" rounded — value: { fetchedAt, periods }

function cacheKey(lat, lng) {
  return Number(lat).toFixed(3) + ',' + Number(lng).toFixed(3);
}

async function fetchJson(url) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' }
  });
  if (!res.ok) {
    const body = await res.text().catch(function() { return ''; });
    throw new Error('NWS ' + res.status + ' ' + url + ' ' + body.slice(0, 120));
  }
  return res.json();
}

async function fetchPeriods(lat, lng) {
  const points = await fetchJson('https://api.weather.gov/points/' + lat + ',' + lng);
  const forecastUrl = points && points.properties && points.properties.forecast;
  if (!forecastUrl) throw new Error('NWS no forecast URL for ' + lat + ',' + lng);
  const fc = await fetchJson(forecastUrl);
  return (fc && fc.properties && fc.properties.periods) || [];
}

async function getPeriods(lat, lng) {
  const key = cacheKey(lat, lng);
  const hit = cache.get(key);
  if (hit && (Date.now() - hit.fetchedAt) < TTL_MS) return hit.periods;
  const periods = await fetchPeriods(lat, lng);
  cache.set(key, { fetchedAt: Date.now(), periods: periods });
  return periods;
}

// Hard rules for now — tune as the team flags missed conditions.
// "thunder/lightning/severe/tornado/hurricane" in the forecast text
// is always red because outdoor crews need to be off-roof regardless
// of the precip percentage NWS attaches to it.
function classifyRisk(precipPct, windMph, text) {
  const lower = (text || '').toLowerCase();
  if (/tornado|hurricane|severe|thunder|lightning/.test(lower)) return 'red';
  if (precipPct >= 50 || windMph >= 25) return 'red';
  if (precipPct >= 25 || windMph >= 15) return 'yellow';
  return 'green';
}

function pickWorse(a, b) {
  const order = { green: 0, yellow: 1, red: 2 };
  return (order[a] || 0) >= (order[b] || 0) ? a : b;
}

// Roll the alternating day/night periods into one summary per
// calendar day. Daytime period drives the canonical numbers
// (temp high, summary text) since that's what crews work in;
// nighttime period only contributes the low temp and can upgrade
// the day's risk if a storm rolls through after dark.
function rollupByDay(periods) {
  const days = {};
  periods.forEach(function(p) {
    const dateIso = (p.startTime || '').slice(0, 10);
    if (!dateIso) return;
    const text = (p.shortForecast || '') + ' ' + (p.detailedForecast || '');
    const precipObj = p.probabilityOfPrecipitation || {};
    const precipPct = (precipObj.value == null ? 0 : Number(precipObj.value)) || 0;
    const windMatch = String(p.windSpeed || '').match(/(\d+)/);
    const windMph = windMatch ? parseInt(windMatch[1], 10) : 0;
    const risk = classifyRisk(precipPct, windMph, text);
    const isDay = !!p.isDaytime;

    let cur = days[dateIso];
    if (!cur) {
      cur = days[dateIso] = {
        date: dateIso,
        risk: risk,
        tempHigh: null,
        tempLow: null,
        precipPct: 0,
        windMph: 0,
        summary: ''
      };
    }
    if (isDay) {
      cur.tempHigh = p.temperature;
      cur.summary = p.shortForecast || cur.summary;
      cur.precipPct = precipPct;
      cur.windMph = windMph;
      cur.risk = pickWorse(cur.risk, risk);
    } else {
      cur.tempLow = p.temperature;
      // Storms that show up only at night still escalate the day's
      // risk — better to over-warn than miss thunder forecasts.
      cur.risk = pickWorse(cur.risk, risk);
      // If the daytime period hasn't been seen yet (forecast slice
      // starts at night), use night data as a fallback.
      if (!cur.summary) cur.summary = p.shortForecast || '';
      if (!cur.precipPct) cur.precipPct = precipPct;
      if (!cur.windMph) cur.windMph = windMph;
    }
  });
  return Object.keys(days).sort().map(function(k) { return days[k]; });
}

async function getDailyForecast(lat, lng) {
  const periods = await getPeriods(lat, lng);
  return rollupByDay(periods);
}

module.exports = {
  getDailyForecast,
  // Exposed for tests / admin tooling — drops the entire forecast cache.
  clearCache: function() { cache.clear(); }
};
