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
async function nearest(lat, lng, includedType) {
  const key = apiKey();
  if (key == null || lat == null || lng == null) return { error: 'no_key_or_coords' };
  const body = {
    includedTypes: [includedType],
    maxResultCount: 1,
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
  const p = j && j.places && j.places[0];
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
    nearest(lat, lng, 'hospital'),
    nearest(lat, lng, 'fire_station')
  ]);
  return { hospital, fire };
}

module.exports = { nearbySafety, nearest, haversineMiles, hasKey };
