// ── Google Places address autocomplete ─────────────────────────────────
// A thin, reusable wrapper over the MODERN PlaceAutocompleteElement web
// component (the legacy google.maps.places.Autocomplete is closed to GCP
// projects created after 2025-03-01, so we use the future-proof element).
//
// Usage:
//   var h = window.p86AddressAutocomplete.attach({
//     mount: someContainerEl,            // where the search box is appended
//     placeholder: 'Start typing an address…',
//     onPlace: function(result){ ... }   // called after a place is picked
//   });
//   // h.destroy() to unmount (call on modal close).
//
// result = {
//   formatted: 'full one-line address',
//   components: { street_address, city, state, zip },   // '' when absent
//   lat: Number|null, lng: Number|null,                  // picked coordinates
//   placeId: '…'
// }
//
// Picking a place yields BOTH the structured fields and exact lat/lng, so the
// caller can store the coords as geocode_lat/lng and skip a separate geocode.
(function () {
  if (window.p86AddressAutocomplete) return; // idempotent

  // Google's Place classes have drifted (legacy snake_case vs new camelCase,
  // LatLng-as-method vs literal). Read everything defensively so we survive
  // either shape without a runtime version check.
  function readLatLng(loc) {
    if (!loc) return { lat: null, lng: null };
    var lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
    var lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
    lat = Number(lat); lng = Number(lng);
    return { lat: isFinite(lat) ? lat : null, lng: isFinite(lng) ? lng : null };
  }
  function compText(c, wantShort) {
    if (!c) return '';
    if (wantShort) return c.shortText || c.short_name || c.longText || c.long_name || '';
    return c.longText || c.long_name || c.shortText || c.short_name || '';
  }
  function findComp(components, type, wantShort) {
    components = components || [];
    for (var i = 0; i < components.length; i++) {
      var c = components[i], types = c.types || [];
      if (types.indexOf(type) !== -1) return compText(c, wantShort);
    }
    return '';
  }
  function parsePlace(place) {
    var comps = place.addressComponents || place.address_components || [];
    var num = findComp(comps, 'street_number');
    var route = findComp(comps, 'route');
    var street = ((num ? num + ' ' : '') + route).trim();
    var city = findComp(comps, 'locality') || findComp(comps, 'postal_town') ||
               findComp(comps, 'sublocality') || findComp(comps, 'sublocality_level_1');
    var state = findComp(comps, 'administrative_area_level_1', true);
    var zip = findComp(comps, 'postal_code');
    var zipSuffix = findComp(comps, 'postal_code_suffix');
    if (zip && zipSuffix) zip = zip + '-' + zipSuffix;
    var ll = readLatLng(place.location);
    return {
      formatted: place.formattedAddress || place.formatted_address || '',
      components: { street_address: street, city: city, state: state, zip: zip },
      lat: ll.lat, lng: ll.lng,
      placeId: place.id || place.placeId || ''
    };
  }

  function attach(opts) {
    opts = opts || {};
    if (!opts.mount || !window.p86Maps || typeof window.p86Maps.ready !== 'function') return null;
    var handle = {
      element: null,
      _destroyed: false,
      destroy: function () {
        handle._destroyed = true;
        if (handle.element && handle.element.parentNode) handle.element.parentNode.removeChild(handle.element);
      }
    };
    window.p86Maps.ready().then(function (maps) {
      if (handle._destroyed) return;
      if (!maps.places || typeof maps.places.PlaceAutocompleteElement !== 'function') return; // Places lib not loaded
      var pac;
      try {
        pac = new maps.places.PlaceAutocompleteElement({ includedRegionCodes: ['us'] });
      } catch (e) {
        try { pac = new maps.places.PlaceAutocompleteElement(); } catch (_) { return; }
      }
      pac.className = 'p86-addr-ac';
      if (opts.placeholder) { try { pac.placeholder = opts.placeholder; } catch (_) {} }
      opts.mount.appendChild(pac);
      handle.element = pac;
      // 'gmp-select' hands a prediction; we must fetchFields() to get a full Place
      // (forgetting the fetch is the documented footgun → empty components).
      pac.addEventListener('gmp-select', function (ev) {
        var pred = ev && (ev.placePrediction || (ev.detail && ev.detail.placePrediction));
        if (!pred || typeof pred.toPlace !== 'function') return;
        var place = pred.toPlace();
        var p = (place && typeof place.fetchFields === 'function')
          ? place.fetchFields({ fields: ['addressComponents', 'formattedAddress', 'location'] })
          : Promise.resolve();
        p.then(function () {
          if (typeof opts.onPlace === 'function') opts.onPlace(parsePlace(place));
        }).catch(function () {});
      });
    }).catch(function () {});
    return handle;
  }

  window.p86AddressAutocomplete = { attach: attach };
})();
