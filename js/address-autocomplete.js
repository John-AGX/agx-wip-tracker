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
//   // Convenience for a single free-text address <input>: inserts a search
//   // box above it and fills it on pick (idempotent — wires once per field).
//   window.p86AddressAutocomplete.attachToField(inputEl, {
//     mode: 'formatted' | 'street', placeholder, onPlace
//   });
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
    // New Places puts coords on .location; the legacy Autocomplete puts them
    // on .geometry.location. Read both so one parser serves either API.
    var ll = readLatLng(place.location || (place.geometry && place.geometry.location));
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

  // Bind predictions DIRECTLY to an existing <input> — no second search box.
  //
  // This is the only way to get "type in the street field and see suggestions":
  // PlaceAutocompleteElement is a web component that renders and owns its own
  // input, so it can never decorate a field you already have. The legacy
  // places.Autocomplete does attach to a real input, which also means the field
  // stays a plain <input> — typing an address Google doesn't know still works,
  // and collect() keeps reading the same node it always did.
  //
  // Trade-off worth knowing: places.Autocomplete is Google's LEGACY API. It
  // still functions and is supported for existing usage, but new capability
  // goes to the element. We fall back to the mounted element automatically if
  // the legacy class ever disappears, so this degrades rather than breaks.
  function bindInput(inputEl, opts) {
    opts = opts || {};
    if (!inputEl || inputEl.dataset.p86AcBound) return null;
    if (!window.p86Maps || typeof window.p86Maps.ready !== 'function') return null;
    inputEl.dataset.p86AcBound = '1';
    var handle = { ac: null, _destroyed: false, destroy: function () { handle._destroyed = true; } };
    window.p86Maps.ready().then(function (maps) {
      if (handle._destroyed) return;
      if (!maps.places || typeof maps.places.Autocomplete !== 'function') {
        // No legacy class — let the caller fall back to the mounted element.
        delete inputEl.dataset.p86AcBound;
        if (typeof opts.onUnavailable === 'function') opts.onUnavailable();
        return;
      }
      var ac = new maps.places.Autocomplete(inputEl, {
        fields: ['address_components', 'formatted_address', 'geometry'],
        types: ['address'],
        componentRestrictions: { country: 'us' }
      });
      handle.ac = ac;
      ac.addListener('place_changed', function () {
        var place = ac.getPlace();
        if (!place || !(place.address_components || place.geometry)) return;  // typed, never picked
        if (typeof opts.onPlace === 'function') opts.onPlace(parsePlace(place));
      });
      // The dropdown renders in a body-level .pac-container. Inside a modal
      // with its own stacking context it lands underneath unless lifted.
      ensurePacCss();
    }).catch(function () { delete inputEl.dataset.p86AcBound; });
    return handle;
  }

  function ensurePacCss() {
    if (document.getElementById('p86-pac-css')) return;
    var s = document.createElement('style'); s.id = 'p86-pac-css';
    s.textContent =
      '.pac-container{z-index:100000 !important;border-radius:8px;border:1px solid var(--border,#2a2f3e);' +
      'background:var(--card-bg,#141419);box-shadow:0 10px 28px rgba(0,0,0,.5);font-family:inherit;padding:4px 0;}' +
      '.pac-item{border-top:0;padding:7px 11px;font-size:12.5px;color:var(--text-dim,#9d9da8);cursor:pointer;}' +
      '.pac-item:hover,.pac-item-selected{background:rgba(255,255,255,.06);}' +
      '.pac-item-query{font-size:13px;color:var(--text,#e9ecf5);}' +
      '.pac-matched{color:#4f8cff;}' +
      '.pac-icon{display:none;}' +                    /* Google's sprite pin reads as a broken image on dark */
      '.hdpi .pac-icon{display:none;}' +
      'body.light-mode .pac-container{background:#fff;border-color:#d5dae5;}' +
      'body.light-mode .pac-item{color:#475569;} body.light-mode .pac-item-query{color:#0f172a;}';
    document.head.appendChild(s);
  }

  // Convenience: decorate a single free-text address <input>. Inserts a search
  // box immediately before it; on pick, writes the chosen address into the input
  // (formatted by default, or just the street line) and fires input/change so
  // existing listeners run. Idempotent per field via a data flag.
  function attachToField(fieldEl, opts) {
    opts = opts || {};
    if (!fieldEl || fieldEl.dataset.p86AcWired) return null;
    fieldEl.dataset.p86AcWired = '1';
    var row = document.createElement('div');
    row.className = 'p86-addr-ac-row';
    if (fieldEl.parentNode) fieldEl.parentNode.insertBefore(row, fieldEl);
    return attach({
      mount: row,
      placeholder: opts.placeholder || 'Search address…',
      onPlace: function (r) {
        var v = (opts.mode === 'street') ? (r.components.street_address || r.formatted) : r.formatted;
        if (v) {
          fieldEl.value = v;
          try {
            fieldEl.dispatchEvent(new Event('input', { bubbles: true }));
            fieldEl.dispatchEvent(new Event('change', { bubbles: true }));
          } catch (_) {}
        }
        if (typeof opts.onPlace === 'function') opts.onPlace(r);
      }
    });
  }

  window.p86AddressAutocomplete = { attach: attach, attachToField: attachToField, bindInput: bindInput };
})();
