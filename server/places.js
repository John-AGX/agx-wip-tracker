'use strict';
// server/places.js — Google Places (New) "nearby" lookups for the client
// property-intel dossier. Slice 1: nearest hospital + fire station for the
// safety block. Reuses the referrer-unlocked server GEOCODING_API_KEY (Places
// New must be enabled on that key). No SDK — clones the fetch pattern in
// geocoder.js. Straight-line miles from the property (drive time via Distance
// Matrix / Routes is a later slice).

const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';

function apiKey() { return process.env.GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY || null; }
function hasKey() { return !!apiKey(); }

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Nearest place of a Places(New) type. Returns {name,address,lat,lng,miles},
// null (none found), or {error} (API/network). Never throws.
// opts.take: how many distance-ranked results to pull (default 1).
// opts.preferName: regex — return the NEAREST result whose name matches,
// falling back to the overall nearest. Needed because Google's 'hospital'
// type includes clinics/health centers; the safety card must point at a
// real hospital/ER, not whatever clinic happens to be closest.
async function nearest(lat, lng, includedType, opts) {
  opts = opts || {};
  const key = apiKey();
  if (key == null || lat == null || lng == null) return { error: 'no_key_or_coords' };
  const body = {
    includedTypes: [includedType],
    maxResultCount: Math.min(20, opts.take || 1),
    rankPreference: 'DISTANCE',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } }
  };
  let r;
  try {
    r = await fetch(NEARBY_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location'
      },
      body: JSON.stringify(body)
    });
  } catch (e) { return { error: 'network', detail: e && e.message }; }
  if (!r.ok) {
    let msg = 'places_' + r.status;
    try { const eb = await r.json(); if (eb && eb.error && eb.error.message) msg = eb.error.message; } catch (e) {}
    return { error: msg };
  }
  let j; try { j = await r.json(); } catch (e) { return { error: 'bad_json' }; }
  const list = (j && j.places) || [];
  let p = list[0];
  if (opts.preferName) {
    const hit = list.find((x) => x && x.displayName && opts.preferName.test(x.displayName.text || ''));
    if (hit) p = hit;
  }
  if (!p || !p.location) return null;
  const plat = p.location.latitude, plng = p.location.longitude;
  return {
    name: (p.displayName && p.displayName.text) || null,
    address: p.formattedAddress || null,
    lat: plat, lng: plng,
    miles: (plat != null && plng != null) ? Math.round(haversineMiles(lat, lng, plat, plng) * 10) / 10 : null
  };
}

async function nearbySafety(lat, lng) {
  const [hospital, fire] = await Promise.all([
    nearest(lat, lng, 'hospital', {
      take: 10,
      preferName: /(hospital|medical center|emergency|regional medical|health system)/i
    }),
    nearest(lat, lng, 'fire_station')
  ]);
  return { hospital, fire };
}

module.exports = { nearbySafety, nearest, haversineMiles, hasKey };
