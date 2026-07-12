'use strict';
// server/places.js — Google Places (New) "nearby" lookups for the client
// property-intel dossier. Slice 1: nearest hospital + fire station for the
// safety block. Reuses the referrer-unlocked server GEOCODING_API_KEY (Places
// New must be enabled on that key). No SDK — clones the fetch pattern in
// geocoder.js. Straight-line miles from the property (drive time via Distance
// Matrix / Routes is a later slice).

const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby';
const TEXT_URL = 'https://places.googleapis.com/v1/places:searchText';

function apiKey() { return process.env.GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY || null; }
function hasKey() { return !!apiKey(); }

function haversineMiles(lat1, lng1, lat2, lng2) {
  const R = 3958.8, toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shared Places(New) POST. Returns { list } or { error }. Never throws.
async function placesPost(url, body) {
  const key = apiKey();
  if (key == null) return { error: 'no_key' };
  let r;
  try {
    r = await fetch(url, {
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
  return { list: (j && j.places) || [] };
}

function shape(p, lat, lng) {
  if (!p || !p.location) return null;
  const plat = p.location.latitude, plng = p.location.longitude;
  return {
    name: (p.displayName && p.displayName.text) || null,
    address: p.formattedAddress || null,
    lat: plat, lng: plng,
    miles: (plat != null && plng != null) ? Math.round(haversineMiles(lat, lng, plat, plng) * 10) / 10 : null
  };
}

// Nearest place of a Places(New) type. Returns {name,address,lat,lng,miles},
// null (none found), or {error} (API/network). Never throws.
// opts.take: how many distance-ranked results to pull (default 1).
// opts.preferName: regex — return the NEAREST result whose name matches,
// falling back to the overall nearest.
async function nearest(lat, lng, includedType, opts) {
  opts = opts || {};
  if (lat == null || lng == null) return { error: 'no_coords' };
  const out = await placesPost(NEARBY_URL, {
    includedTypes: [includedType],
    maxResultCount: Math.min(20, opts.take || 1),
    rankPreference: 'DISTANCE',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } }
  });
  if (out.error) return out;
  let p = out.list[0];
  if (opts.preferName) {
    const hit = out.list.find((x) => x && x.displayName && opts.preferName.test(x.displayName.text || ''));
    if (hit) p = hit;
  }
  return shape(p, lat, lng);
}

// ── "Nearest ER / hospital" triage ──────────────────────────────────
// Google's 'hospital' place type is a grab bag: dialysis centers, clinics,
// imaging labs, health centers all carry it. A jobsite safety card must
// point at somewhere you'd actually drive a hurt crew member: a real
// hospital, an ER, or an urgent care. Names that look like specialty /
// outpatient facilities are excluded OUTRIGHT (no fallback to them).
const HOSPITAL_POS = /(hospital|emergency|medical center|medical ctr|regional medical|urgent care|health system)/i;
// Two flavors of impostor: standalone specialty facilities (dialysis,
// imaging, rehab) AND hospital-branded satellites that carry the hospital's
// name but have no ER ("... Hospital Lab", "... Breast Care Center",
// "... Primary Care and Hospitalists", "... Outpatient Center").
const HOSPITAL_NEG = /(dialysis|davita|fresenius|planned parenthood|surger|rehab|imaging|radiolog|dermatolog|oncolog|cancer|behavioral|psychiatric|hospice|nursing|assisted living|animal|veterinar|dental|orthodont|chiroprac|therapy|wellness|optometr|eye institute|eye center|foot|podiatr|fertility|weight loss|med spa|hospitalist|primary care|family medicine|family practice|internal medicine|breast|outpatient|pharmacy|\blab\b|laborator|sleep center|wound)/i;

function pickHospital(list) {
  const nameOf = (p) => (p && p.displayName && p.displayName.text) || '';
  return list.find((p) => HOSPITAL_POS.test(nameOf(p)) && !HOSPITAL_NEG.test(nameOf(p))) || null;
}

// Two-pass lookup: distance-ranked 'hospital' type scan filtered by name,
// then a text search for an actual emergency room if the scan found only
// specialty facilities. Returns shaped result, null, or {error}.
async function nearestHospital(lat, lng) {
  if (lat == null || lng == null) return { error: 'no_coords' };
  const near = await placesPost(NEARBY_URL, {
    includedTypes: ['hospital'],
    maxResultCount: 20,
    rankPreference: 'DISTANCE',
    locationRestriction: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } }
  });
  if (near.error) return near;
  let p = pickHospital(near.list);

  if (!p) {
    // No credible hospital in the 20 nearest 'hospital'-typed places —
    // ask for an ER by name instead (text search, still distance-ranked).
    const txt = await placesPost(TEXT_URL, {
      textQuery: 'hospital emergency room',
      maxResultCount: 8,
      rankPreference: 'DISTANCE',
      locationBias: { circle: { center: { latitude: lat, longitude: lng }, radius: 50000 } }
    });
    if (!txt.error && txt.list.length) {
      p = pickHospital(txt.list) || txt.list.find((x) => !HOSPITAL_NEG.test((x.displayName && x.displayName.text) || '')) || null;
    }
  }

  // Last resort: nearest non-excluded place from the type scan. Never
  // return an excluded name — "no result" beats "DaVita Dialysis".
  if (!p) p = near.list.find((x) => !HOSPITAL_NEG.test((x.displayName && x.displayName.text) || '')) || null;
  return shape(p, lat, lng);
}

async function nearbySafety(lat, lng) {
  const [hospital, fire] = await Promise.all([
    nearestHospital(lat, lng),
    nearest(lat, lng, 'fire_station')
  ]);
  return { hospital, fire };
}

module.exports = { nearbySafety, nearestHospital, nearest, haversineMiles, hasKey };
