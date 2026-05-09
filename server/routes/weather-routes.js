// Weather lookup for the schedule. Given a list of job ids, returns
// a 7-day forecast keyed by job. Address resolution priority:
//   1. job.data.address (top-level on the job blob)
//   2. job.data.buildings[0].address (first building, since most
//      addresses live there in this schema)
// Jobs without either get { status: 'no_address' } so the UI can
// render a placeholder instead of weather.
//
// Geocoding is cached on the jobs row (geocode_lat/lng/status/
// address). Re-geocode runs when:
//   - The job has never been geocoded.
//   - The address changed since last lookup.
// A previous "failed" geocode is sticky for the same address so we
// don't pound Census on every render. Edit the address → next render
// re-tries.
//
// NWS forecast cache is in-memory in server/weather.js; per-coord
// rounded to ~110m, 1-hour TTL. Worker pool of 4 throttles outbound
// calls when many jobs hit the route together.

'use strict';

const express = require('express');
const { pool } = require('../db');
const { requireAuth } = require('../auth');
const { geocodeAddress } = require('../geocoder');
const { getDailyForecast } = require('../weather');

const router = express.Router();

console.log('[weather-routes] mounted at /api/weather (NWS + Census)');

router.use(requireAuth);

function pickAddress(jobData) {
  if (!jobData) return null;
  if (jobData.address && String(jobData.address).trim()) {
    return String(jobData.address).trim();
  }
  const buildings = Array.isArray(jobData.buildings) ? jobData.buildings : [];
  for (let i = 0; i < buildings.length; i++) {
    const b = buildings[i];
    if (b && b.address && String(b.address).trim()) return String(b.address).trim();
  }
  return null;
}

async function ensureGeocode(jobRow) {
  const data = jobRow.data || {};
  const address = pickAddress(data);
  if (!address) return { status: 'no_address' };

  // Cached "ok" geocode for this exact address — reuse it.
  if (jobRow.geocode_status === 'ok' &&
      jobRow.geocode_lat != null && jobRow.geocode_lng != null &&
      jobRow.geocode_address === address) {
    return {
      status: 'ok',
      lat: Number(jobRow.geocode_lat),
      lng: Number(jobRow.geocode_lng),
      address: address
    };
  }

  // Cached "failed" for this exact address — don't retry until the
  // address changes.
  if (jobRow.geocode_status === 'failed' && jobRow.geocode_address === address) {
    return { status: 'failed', address: address };
  }

  // Either never geocoded or address changed — go ask Census.
  const result = await geocodeAddress(address);
  if (!result) {
    await pool.query(
      'UPDATE jobs SET geocode_status=$1, geocode_address=$2, geocode_at=NOW() WHERE id=$3',
      ['failed', address, jobRow.id]
    );
    return { status: 'failed', address: address };
  }
  await pool.query(
    'UPDATE jobs SET geocode_lat=$1, geocode_lng=$2, geocode_status=$3, geocode_address=$4, geocode_at=NOW() WHERE id=$5',
    [result.lat, result.lng, 'ok', address, jobRow.id]
  );
  return { status: 'ok', lat: result.lat, lng: result.lng, address: address };
}

// GET /api/weather/jobs?ids=a,b,c
// Returns { weather: { [jobId]: { status, days?, lat?, lng?, address? } } }
router.get('/jobs', async function(req, res) {
  const idsRaw = String(req.query.ids || '').trim();
  if (!idsRaw) return res.json({ weather: {} });
  const ids = idsRaw.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
  if (!ids.length) return res.json({ weather: {} });

  let rows;
  try {
    const result = await pool.query(
      'SELECT id, data, geocode_lat, geocode_lng, geocode_status, geocode_address ' +
      'FROM jobs WHERE id = ANY($1::text[])',
      [ids]
    );
    rows = result.rows;
  } catch (e) {
    console.error('[weather] job lookup failed:', e.message);
    return res.status(500).json({ error: 'Job lookup failed: ' + e.message });
  }

  const out = {};
  ids.forEach(function(id) { out[id] = { status: 'unknown_job' }; });

  // Worker pool of 4 — bounds outbound call rate without serializing
  // everything. Plenty fast even at 30+ jobs because forecast lookups
  // for nearby jobs share the cache key.
  const queue = rows.slice();
  async function worker() {
    while (queue.length) {
      const row = queue.shift();
      try {
        const geo = await ensureGeocode(row);
        if (geo.status !== 'ok') {
          out[row.id] = { status: geo.status, address: geo.address || null };
          continue;
        }
        const days = await getDailyForecast(geo.lat, geo.lng);
        out[row.id] = {
          status: 'ok',
          lat: geo.lat,
          lng: geo.lng,
          address: geo.address,
          days: days
        };
      } catch (e) {
        console.warn('[weather] forecast failed for job ' + row.id + ':', e.message);
        out[row.id] = { status: 'error', error: e.message };
      }
    }
  }
  await Promise.all([worker(), worker(), worker(), worker()]);
  res.json({ weather: out });
});

module.exports = router;
