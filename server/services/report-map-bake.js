// Bake a photo-location map into a stored image at PUBLISH time.
//
// WHY BAKE AT ALL. A shared report is read by an anonymous stranger, and a
// Google Static Maps URL carries the API key in the query string. Putting that
// URL in the published snapshot would hand the key to every recipient (and to
// anyone they forward it to), who could then spend it. So the server fetches
// the image itself, stores it, and the snapshot carries a plain image URL with
// no credential in it.
//
// Two things fall out of that, both good:
//   * the shared map keeps working if the key is later rotated, restricted or
//     the Static Maps API is turned off — the client's copy is a real image,
//     not a live call;
//   * the map matches what was published, like every other part of a snapshot.
//
// FAILURE IS NOT FATAL. If the key is missing, the API is not enabled, or the
// fetch fails, this returns null and the section simply has no map_url — the
// renderer then degrades to the photo grid. Publishing a report must never fail
// because a map could not be drawn.
'use strict';

const crypto = require('crypto');

// Server-side key first. GEOCODING_API_KEY is the referrer-unlocked server key;
// GOOGLE_MAPS_API_KEY is the browser one and is usually referrer-restricted,
// so it is only a fallback.
function apiKey() {
  return process.env.GEOCODING_API_KEY || process.env.GOOGLE_MAPS_API_KEY || null;
}

function hasCoords(p) {
  const la = Number(p && p.lat), ln = Number(p && p.lng);
  return Number.isFinite(la) && Number.isFinite(ln) && !(la === 0 && ln === 0) &&
         la >= -90 && la <= 90 && ln >= -180 && ln <= 180;
}

function indexToLetters(i) {
  let n = i, out = '';
  for (;;) {
    out = String.fromCharCode(65 + (n % 26)) + out;
    if (n < 26) break;
    n = Math.floor(n / 26) - 1;
  }
  return out;
}

// Mirrors the client's buildStaticMapsUrl rules so a baked map looks like the
// one the author previewed. Static Maps can only draw a SINGLE character in a
// marker label, so 10+ (and AA+) fall back to a plain coloured dot — the same
// degradation the editor already applies.
function staticMapUrl(photos, pinStyle, key) {
  const pts = photos.filter(hasCoords).slice(0, 60);
  if (!pts.length || !key) return null;

  const markers = pts.map(function (p, idx) {
    // Prefer the document-wide photo number so a pin matches the number printed
    // beside the photo; fall back to position when a photo has no number.
    const seq = (typeof p.num === 'number' && p.num > 0) ? (p.num - 1) : idx;
    let color = '0xef4444';
    let label = '';
    if (pinStyle === 'numbered') {
      color = '0x4f8cff';
      if (seq + 1 <= 9) label = String(seq + 1);
    } else if (pinStyle === 'lettered') {
      color = '0x22d3ee';
      const letters = indexToLetters(seq);
      if (letters.length === 1) label = letters;
    } else {
      color = '0x6b7280';
    }
    const parts = ['color:' + color];
    if (label) parts.push('label:' + label);
    return 'markers=' + parts.join('%7C') + '%7C' + Number(p.lat) + ',' + Number(p.lng);
  });

  return 'https://maps.googleapis.com/maps/api/staticmap' +
    '?size=640x360&maptype=satellite&scale=2' +
    '&' + markers.join('&') +
    '&key=' + encodeURIComponent(key);
}

/**
 * Fetch the static map and store it. Returns a public image URL, or null.
 *
 * @param {object} storage  the storage adapter (put(key, buffer, contentType))
 * @param {Array}  photos   snapshot photos for the section (need lat/lng/num)
 * @param {string} pinStyle
 * @param {string} shareId  used only to namespace the stored object
 * @param {string} sectionId
 */
async function bakeSectionMap(storage, photos, pinStyle, shareId, sectionId) {
  try {
    const key = apiKey();
    if (!key) return null;
    const url = staticMapUrl(photos || [], pinStyle, key);
    if (!url) return null;

    // Node 18+ has fetch built in; guard anyway so an older runtime degrades to
    // "no map" rather than throwing inside a publish.
    if (typeof fetch !== 'function') return null;
    const res = await fetch(url);
    if (!res.ok) {
      // The usual cause is Static Maps not being enabled on the key, which
      // returns 403 with a text body. Log it once — silently shipping a report
      // with a missing map is worse than a line in the logs.
      console.warn('[report-map-bake] static map fetch failed:', res.status);
      return null;
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return null;

    // Content-addressed: the same pins produce the same object, so re-publishing
    // an unchanged report does not accumulate copies.
    const digest = crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16);
    const objectKey = 'report-shares/' + String(shareId || 'share') + '/map_' +
      String(sectionId || 'sec').replace(/[^a-zA-Z0-9_-]/g, '') + '_' + digest + '.png';

    return await storage.put(objectKey, buf, 'image/png');
  } catch (e) {
    console.warn('[report-map-bake] skipped:', e && e.message);
    return null;
  }
}

/**
 * Walk a built snapshot and bake every photo-map section in place.
 * Always resolves; a section that could not be baked simply has no map_url.
 */
async function bakeDocumentMaps(storage, document, shareId) {
  const sections = (document && Array.isArray(document.sections)) ? document.sections : [];
  for (const section of sections) {
    if (section.layout !== 'photo-map') continue;
    const url = await bakeSectionMap(storage, section.photos, section.pin_style, shareId, section.id);
    if (url) section.map_url = url;
  }
  return document;
}

module.exports = { apiKey, staticMapUrl, bakeSectionMap, bakeDocumentMaps, indexToLetters, hasCoords };
