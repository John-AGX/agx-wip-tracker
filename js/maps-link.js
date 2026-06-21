// Shared Google-Maps deep-link helper.
//
//   window.p86MapLink.url(addressOrObj[, lng])  -> a maps URL string ('' if nothing usable)
//   window.p86MapLink.linkHTML(label, addressOrLatLng, opts) -> a safe <a> string
//
// One primitive — a Google Maps "search" deep link — reused by chat
// (86/assistant), the combined map's info windows, and detail-page
// address lines. It only builds URL strings; it does NOT depend on the
// Google Maps JS SDK, so it can load before maps-loader.js with no
// ordering hazard. Deliberately a SEPARATE namespace from window.p86Maps
// (the SDK loader) so neither can clobber the other regardless of script
// order.
//
// Coords-vs-address rule: prefer "lat,lng" when both are finite, in range,
// and not (0,0); otherwise fall back to the address string. Coords are
// precise and need no geocoder; the address string is the universal
// fallback and still works for rows whose geocode failed.

(function () {
  'use strict';

  var BASE = 'https://www.google.com/maps/search/?api=1&query=';

  function isUsableCoord(lat, lng) {
    return Number.isFinite(lat) && Number.isFinite(lng) &&
      !(lat === 0 && lng === 0) &&
      lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
  }

  // Accepts:
  //   url("123 Main St, Denver, CO 80202")   — address string
  //   url({ lat, lng, address })             — object (coords win, address fallback)
  //   url(40.71, -74.0)                       — positional coords
  function url(addressOrObj, maybeLng) {
    var lat, lng, addr;
    if (addressOrObj && typeof addressOrObj === 'object') {
      lat = Number(addressOrObj.lat);
      lng = Number(addressOrObj.lng);
      addr = addressOrObj.address;
    } else if (maybeLng !== undefined && maybeLng !== null && maybeLng !== '') {
      lat = Number(addressOrObj);
      lng = Number(maybeLng);
    } else {
      addr = addressOrObj;
    }
    if (isUsableCoord(lat, lng)) return BASE + encodeURIComponent(lat + ',' + lng);
    if (addr != null && String(addr).trim()) return BASE + encodeURIComponent(String(addr).trim());
    return '';
  }

  // mapsLinkHTML(label, addressOrLatLng, opts)
  //   label            : visible text (usually the address itself)
  //   addressOrLatLng  : address string OR {lat,lng,address}
  //   opts.lat/opts.lng: coords to prefer over the address
  //   opts.iconOnly    : render just the 📍 pin (tight rows)
  //   opts.noIcon      : render the label with no leading pin
  //   opts.style       : inline-style override for the <a>
  // Returns '' when there's nothing to link (and, when not iconOnly,
  // falls back to the escaped label so callers can always interpolate it).
  function linkHTML(label, addressOrLatLng, opts) {
    opts = opts || {};
    var target = addressOrLatLng;
    if ((Number.isFinite(opts.lat) && Number.isFinite(opts.lng)) &&
        !(addressOrLatLng && typeof addressOrLatLng === 'object')) {
      target = { lat: opts.lat, lng: opts.lng, address: addressOrLatLng };
    }
    var href = url(target);
    var labelText = (label != null) ? label
      : (typeof addressOrLatLng === 'string' ? addressOrLatLng : '');
    if (!href) return opts.iconOnly ? '' : esc(labelText);
    var style = opts.style || 'color:#4f8cff;text-decoration:none;cursor:pointer;';
    var inner = opts.iconOnly ? '📍'
      : (opts.noIcon ? esc(labelText) : ('📍 ' + esc(labelText)));
    return '<a href="' + escAttr(href) + '" target="_blank" rel="noopener noreferrer" ' +
      'style="' + style + '" title="Open in Google Maps">' + inner + '</a>';
  }

  function esc(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function escAttr(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
  }

  window.p86MapLink = { url: url, linkHTML: linkHTML, isUsableCoord: isUsableCoord };
})();
