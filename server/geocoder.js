// US Census Geocoder wrapper — free, no API key, no rate limits worth
// worrying about for our scale. Used by the weather route to resolve
// a job's address into lat/lng before asking NWS for a forecast.
//
// Result shape: { lat, lng, matchedAddress } on hit, null on miss
// (no match, network error, malformed response). Callers decide what
// to do with a miss — typically the weather route persists a
// "geocode_status='failed'" so we don't retry the same bad address
// on every page load.

'use strict';

const ENDPOINT = 'https://geocoding.geo.census.gov/geocoder/locations/onelineaddress';
const UA = 'AGX/Project86 weather lookup (project86.net)';

async function geocodeAddress(address) {
  if (!address || typeof address !== 'string') return null;
  const cleaned = address.trim();
  if (!cleaned) return null;

  const url = new URL(ENDPOINT);
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
    matchedAddress: matches[0].matchedAddress || cleaned
  };
}

module.exports = { geocodeAddress };
