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

const grid = require('./weather-grid');
const UA = 'AGX/Project86 weather lookup (project86.net)';
const TTL_MS = 60 * 60 * 1000; // 1 hour
const cache = new Map(); // key: "lat,lng" rounded — value: { fetchedAt, periods }

function cacheKey(lat, lng) {
  return Number(lat).toFixed(3) + ',' + Number(lng).toFixed(3);
}

// timeoutMs is not optional in spirit. There was no timeout anywhere on this
// path, so a slow NWS left the request hanging on the socket for as long as the
// platform allowed — and Promise.allSettled over several calls isolates a
// REJECTION but not LATENCY: it still waits for the slowest. Every outbound
// call now carries its own deadline, and the extras carry short ones because
// the panel is allowed to come back without them.
async function fetchJson(url, timeoutMs) {
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, 'Accept': 'application/geo+json' },
    signal: AbortSignal.timeout(timeoutMs || 8000)
  });
  if (!res.ok) {
    const body = await res.text().catch(function() { return ''; });
    throw new Error('NWS ' + res.status + ' ' + url + ' ' + body.slice(0, 120));
  }
  return res.json();
}

// /points is the gateway call: it hands back the forecast URL, the RAW GRID
// url, and — the part this wrapper used to throw away — properties.timeZone,
// the IANA zone of the SITE. Without it a "day" is the server's day or the
// browser's day, and AGX works five zones, one of which (America/Phoenix) has
// no DST. Cached alongside the periods since it changes essentially never.
const pointsCache = new Map();

async function getPoints(lat, lng) {
  const key = cacheKey(lat, lng);
  const hit = pointsCache.get(key);
  if (hit && (Date.now() - hit.fetchedAt) < TTL_MS) return hit.value;
  const points = await fetchJson('https://api.weather.gov/points/' + lat + ',' + lng, 8000);
  const props = (points && points.properties) || {};
  const value = {
    forecastUrl: props.forecast || null,
    gridUrl: props.forecastGridData || null,
    timeZone: props.timeZone || null,
    gridRef: (props.gridId != null)
      ? { id: props.gridId, x: props.gridX, y: props.gridY }
      : null
  };
  pointsCache.set(key, { fetchedAt: Date.now(), value: value });
  return value;
}

async function fetchPeriods(lat, lng) {
  const pts = await getPoints(lat, lng);
  if (!pts.forecastUrl) throw new Error('NWS no forecast URL for ' + lat + ',' + lng);
  const fc = await fetchJson(pts.forecastUrl, 8000);
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
    // NWS writes wind as a single value ("7 mph") OR a range ("15 to 30 mph").
    // Matching the FIRST number took the LOW bound of every range, so a day
    // forecast at "15 to 30 mph" was carried as 15 — under classifyRisk's 25
    // mph red line and its 15 mph yellow line both. The day that most needed
    // flagging was scored as the calmest reading it could be given.
    // Take the HIGH bound: the gust a crew has to work in is the number that
    // decides, and erring toward the worse reading is the safe direction.
    const windNums = String(p.windSpeed || '').match(/\d+/g);
    const windMph = windNums ? Math.max.apply(null, windNums.map(Number)) : 0;
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


// ── Active watches & warnings ──────────────────────────────────────────
//
// A DENYLIST, not an allowlist. The obvious design is to name the events an
// exterior contractor cares about — and it fails closed in the wrong
// direction: NWS retires and renames event types (what everyone still calls
// an "Excessive Heat Warning" is now an "Extreme Heat Warning"), so an
// allowlist silently stops matching the single most relevant alert in Florida
// and nobody notices, because absence looks exactly like fine weather.
// So: drop the marine and recreational families, surface everything else.
const ALERT_IGNORE = /small craft|gale|marine|surf|beach hazard|rip current|hurricane force wind warning|lake wind|low water|ashfall|volcan/i;

const SEVERITY_RANK = { Extreme: 4, Severe: 3, Moderate: 2, Minor: 1, Unknown: 0 };

async function fetchAlerts(lat, lng) {
  const url = 'https://api.weather.gov/alerts/active?point=' + lat + ',' + lng;
  const j = await fetchJson(url, 3000);
  const features = (j && j.features) || [];
  const out = [];
  for (const f of features) {
    const p = (f && f.properties) || {};
    if (p.status === 'Test' || p.status === 'Draft') continue;
    const event = String(p.event || '');
    if (!event || ALERT_IGNORE.test(event)) continue;
    // `expires` is NOT the end of the event — it is when this MESSAGE goes
    // stale and gets superseded, and it is routinely in the past while the
    // event itself is still running. `ends` is the real end and is legitimately
    // null for an open-ended event. Prefer ends, fall back to expires, and
    // treat null as "still on" rather than as "over".
    const endsMs = p.ends ? Date.parse(p.ends) : (p.expires ? Date.parse(p.expires) : null);
    out.push({
      id: f.id || p.id || null,
      event: event,
      severity: p.severity || 'Unknown',
      urgency: p.urgency || null,
      certainty: p.certainty || null,
      headline: p.headline || null,
      onsetMs: p.onset ? Date.parse(p.onset) : (p.effective ? Date.parse(p.effective) : null),
      endsMs: (endsMs != null && !isNaN(endsMs)) ? endsMs : null,
      // Kept short: the full NWS description is several paragraphs of prose
      // and this rides in a payload the browser caches.
      what: String(p.description || '').replace(/\s+/g, ' ').trim().slice(0, 400) || null
    });
  }
  out.sort(function (a, b) {
    return (SEVERITY_RANK[b.severity] || 0) - (SEVERITY_RANK[a.severity] || 0);
  });
  return out;
}

// Is this alert in force during the window a crew would actually be working?
//
// The naive test is `onset <= now`, and it is blind at exactly the hour the
// panel exists for: at 6am, a Severe Thunderstorm Warning that starts at 2pm
// has a future onset and would be filed under "later" — or dropped — on the
// morning someone is deciding whether to send a crew. Overlap with the work
// window is the question, not whether it has started yet.
function alertOverlapsWindow(alert, startMs, endMs) {
  const onset = (alert.onsetMs == null) ? -Infinity : alert.onsetMs;
  const ends = (alert.endsMs == null) ? Infinity : alert.endsMs;
  return onset < endMs && ends > startMs;
}

// ── the rich per-site call ─────────────────────────────────────────────
//
// Used ONLY by the two single-site routes that back the Site Conditions panel.
// /jobs and /projects keep calling getDailyForecast, which is still one NWS
// round trip per site: this makes three, and those routes loop over thirty-odd
// jobs in a four-worker pool. Rich data there would multiply a page load by the
// slowest of three upstreams, thirty times over.
//
// Every extra is BEST-EFFORT and independently timed out. The panel degrades to
// whatever arrived: no grid means no numbers but the 7-day strip still paints,
// no alerts means no banner. A failure of an extra must never cost the caller
// the forecast it already had.
async function getSiteConditions(lat, lng) {
  const sources = {
    periods: { ok: false, error: null },
    grid: { ok: false, error: null },
    alerts: { ok: false, error: null }
  };

  // The periods feed is the only REQUIRED call — it is what the existing strip
  // is made of. Let it throw; the routes already handle that.
  const periods = await getPeriods(lat, lng);
  sources.periods.ok = true;
  const days = rollupByDay(periods);

  const pts = await getPoints(lat, lng).catch(function () { return {}; });
  const tzId = pts.timeZone || null;

  const settled = await Promise.allSettled([
    pts.gridUrl ? getGrid(pts.gridUrl) : Promise.reject(new Error('no grid url')),
    fetchAlerts(lat, lng)
  ]);

  // GRID — the numbers. Bucketed into the SITE's local days.
  if (settled[0].status === 'fulfilled' && settled[0].value) {
    try {
      const dateIsos = days.map(function (d) { return d.date; });
      const summary = grid.summarizeGrid(settled[0].value, tzId || 'UTC', dateIsos);
      for (const d of days) {
        const s = summary[d.date];
        if (s) {
          d.site = s;
          // The compass point, from true degrees on the grid. The periods feed
          // words it ("SW") but only for the 12-hour period; this is the work
          // window's own direction.
          d.site.windDir = grid.degToCompass(s.windDirDeg);
        }
      }
      sources.grid.ok = true;
    } catch (e) {
      sources.grid.error = e && e.message;
    }
  } else if (settled[0].status === 'rejected') {
    sources.grid.error = settled[0].reason && settled[0].reason.message;
  }

  // ALERTS — ranked, with each day told whether one covers ITS work window.
  let alerts = null;
  if (settled[1].status === 'fulfilled') {
    alerts = settled[1].value;
    sources.alerts.ok = true;
    if (tzId) {
      for (const d of days) {
        const w = grid.workWindowBounds(d.date, tzId, grid.WORK_START, grid.WORK_END);
        if (!w) continue;
        d.alerts = alerts
          .filter(function (a) { return alertOverlapsWindow(a, w.start, w.end); })
          .map(function (a) { return a.event; });
      }
    }
  } else {
    sources.alerts.error = settled[1].reason && settled[1].reason.message;
  }

  return {
    days: days,
    tzId: tzId,
    gridRef: pts.gridRef || null,
    alerts: alerts,
    sources: sources
  };
}

// Raw grid, cached on its own URL (which is the ~2.5 km NWS cell, so every
// address in the same cell shares one entry — unlike the periods cache, whose
// key rounds lat/lng to ~110 m and therefore misses for every distinct address
// in the same cell).
const gridCache = new Map();

async function getGrid(gridUrl) {
  const hit = gridCache.get(gridUrl);
  if (hit && (Date.now() - hit.fetchedAt) < TTL_MS) return hit.value;
  const j = await fetchJson(gridUrl, 5000);
  const props = (j && j.properties) || null;
  gridCache.set(gridUrl, { fetchedAt: Date.now(), value: props });
  return props;
}
async function getDailyForecast(lat, lng) {
  const periods = await getPeriods(lat, lng);
  return rollupByDay(periods);
}

module.exports = {
  getDailyForecast,
  // The rich single-site call behind Site Conditions: forecast + grid
  // numbers + site timezone + active alerts, each extra best-effort.
  getSiteConditions,
  // Exposed for tests / admin tooling — drops the entire forecast cache.
  clearCache: function() { cache.clear(); }
};
