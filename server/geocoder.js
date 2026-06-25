// Address → lat/lng geocoder. Census first (free, no key, US-only), then
// a Google Geocoding API fallback for the addresses Census can't match
// (unit-only, PO boxes, new construction). Google is only attempted when
// a server-usable key is set (GEOCODING_API_KEY preferred — a dedicated
// server key restricted to the Geocoding API with NO HTTP-referrer
// restriction; falls back to GOOGLE_MAPS_API_KEY, which is the browser
// Maps key and is usually referrer-locked so it WON'T work server-side).
//
// Result shape: { lat, lng, matchedAddress, provider } on hit, null on miss
// (no match from either provider, network error, malformed response).
// Callers decide what to do with a miss — the leads route persists a
// "geocode_status='failed'" so we don't retry the same bad address forever.

'use strict';

const CENSUS_ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const GOOGLE_ENDPOINT = 'https://maps.googleapis.com/maps/api/geocode/json';
const UA = 'AGX/Project86 geocode lookup (project86.net)';

// ── US Census (free) ────────────────────────────────────────────────
async function geocodeViaCensus(address) {
  if (!address || typeof address !== 'string') return null;
  const cleaned = address.trim();
  if (!cleaned) return null;

  const url = new URL(CENSUS_ENDPOINT);
  url.searchParams.set('address', cleaned);
  url.searchParams.set('benchmark', 'Public_AR_Current');
  url.searchParams.set('format', 'json');

  let res;
  try {
    res = await fetch(url.toString(), {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' }
    });
  } catch (e) {
    return null;
  }
  if (!res.ok) return null;

  let body;
  try { body = await res.json(); } catch (e) { return null; }
  const matches = body && body.result && body.result.addressMatches;
  if (!Array.isArray(matches) || !matches.length) return null;

  // Census returns coordinates as { x: longitude, y: latitude } — flip
  // to the lat/lng order the rest of the app uses.
  const c = matches[0].coordinates;
  if (!c || typeof c.x !== 'number' || typeof c.y !== 'number') return null;
  return {
    lat: c.y,
    lng: c.x,
    matchedAddress: matches[0].matchedAddress || cleaned,
    provider: 'census'
  };
}

// ── Google Geocoding API (fallback, needs key) ──────────────────────
// Returns a status-rich object so callers/diagnostics can tell WHY it
// missed: { ok, status, lat?, lng?, matchedAddress?, error? }. status is
// Google's own ('OK','ZERO_RESULTS','REQUEST_DENIED','OVER_QUERY_LIMIT',…)
// or a local marker ('NO_KEY','EMPTY','NETWORK','BAD_JSON','NO_LOCATION').
async function geocodeViaGoogle(address) {
  const key = process.env.GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY || null;
  if (!key) return { ok: false, status: 'NO_KEY' };
  const cleaned = (address || '').trim();
  if (!cleaned) return { ok: false, status: 'EMPTY' };

  const url = new URL(GOOGLE_ENDPOINT);
  url.searchParams.set('address', cleaned);
  url.searchParams.set('key', key);

  let res;
  try {
    res = await fetch(url.toString(), { headers: { 'Accept': 'application/json' } });
  } catch (e) {
    return { ok: false, status: 'NETWORK', error: e && e.message };
  }
  let body;
  try { body = await res.json(); } catch (e) { return { ok: false, status: 'BAD_JSON' }; }

  const status = (body && body.status) || 'NO_STATUS';
  if (status !== 'OK' || !body.results || !body.results.length) {
    // Surface error_message (e.g. referrer-restriction / API-not-enabled text).
    return { ok: false, status, error: body && body.error_message };
  }
  const loc = body.results[0].geometry && body.results[0].geometry.location;
  if (!loc || typeof loc.lat !== 'number' || typeof loc.lng !== 'number') {
    return { ok: false, status: 'NO_LOCATION' };
  }
  return {
    ok: true,
    status: 'OK',
    lat: loc.lat,
    lng: loc.lng,
    matchedAddress: body.results[0].formatted_address || cleaned,
    provider: 'google'
  };
}

// ── Combined: Census first, Google fallback ─────────────────────────
async function geocodeAddress(address) {
  const census = await geocodeViaCensus(address);
  if (census) return census;
  const g = await geocodeViaGoogle(address);
  if (g && g.ok) {
    return { lat: g.lat, lng: g.lng, matchedAddress: g.matchedAddress, provider: 'google' };
  }
  return null;
}

module.exports = { geocodeAddress, geocodeViaCensus, geocodeViaGoogle };
