// ── Reusable map location picker ─────────────────────────────────────────
// window.p86MapPicker.open(opts) → Promise<{lat,lng,address}|null>
//
// Opens a full-screen modal with a Google map. The user drops / drags a pin
// (or searches an address) and confirms. Resolves the chosen {lat,lng} (plus a
// best-effort reverse-geocoded address), or null if cancelled.
//
//   opts.lat, opts.lng        start marker here (an existing pin)
//   opts.fallbackLat/Lng      center here with a suggested marker when no pin
//                             (e.g. the linked job's location)
//   opts.address              geocode this to center when no coords are given
//   opts.title                header text (default "Pick a location")
//
// Depends on window.p86Maps (SDK loader) at call time; reuses
// window.p86AddressAutocomplete for the in-picker address search when present.
(function () {
  'use strict';
  if (window.p86MapPicker) return;

  var US_CENTER = { lat: 39.5, lng: -98.35 }; // continental-US fallback center

  function num(v) { var n = Number(v); return isFinite(n) ? n : null; }
  function usable(lat, lng) {
    return window.p86MapLink ? window.p86MapLink.isUsableCoord(lat, lng)
      : (isFinite(lat) && isFinite(lng) && !(lat === 0 && lng === 0));
  }

  function injectCss() {
    if (document.getElementById('p86-mappick-css')) return;
    var s = document.createElement('style'); s.id = 'p86-mappick-css';
    s.textContent =
      '.p86-mappick-back{position:fixed;inset:0;z-index:2147483200;background:rgba(6,9,17,.62);' +
        'display:flex;align-items:center;justify-content:center;padding:16px;}' +
      '.p86-mappick-card{width:min(760px,96vw);max-height:92vh;display:flex;flex-direction:column;' +
        'background:var(--card-bg,#12161f);border:1px solid var(--border,#2a3140);border-radius:14px;' +
        'overflow:hidden;box-shadow:0 24px 70px rgba(0,0,0,.5);}' +
      '.p86-mappick-hd{display:flex;align-items:center;gap:10px;padding:12px 14px;border-bottom:1px solid var(--border,#2a3140);}' +
      '.p86-mappick-hd h3{margin:0;font-size:14px;font-weight:700;color:var(--text,#e9ecf5);flex:1;}' +
      '.p86-mappick-x{background:transparent;border:0;color:var(--text-dim,#9aa3b2);font-size:20px;cursor:pointer;line-height:1;padding:2px 6px;}' +
      '.p86-mappick-search{padding:10px 14px 0;}' +
      '.p86-mappick-search .p86-addr-ac{width:100%;color-scheme:dark;}' +
      '.p86-mappick-map{flex:1;min-height:340px;height:56vh;margin:10px 14px 0;border-radius:10px;overflow:hidden;background:#0f1420;}' +
      '.p86-mappick-map .gm-style{border-radius:10px;}' +
      '.p86-mappick-read{padding:8px 14px;font-size:12px;color:var(--text-dim,#9aa3b2);min-height:18px;}' +
      '.p86-mappick-read b{color:var(--text,#e9ecf5);font-weight:600;}' +
      '.p86-mappick-ft{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:12px 14px;border-top:1px solid var(--border,#2a3140);}' +
      '.p86-mappick-hint{font-size:11px;color:var(--text-dim,#9aa3b2);}' +
      '.p86-mappick-btn{border:1px solid var(--border,#2a3140);background:transparent;color:var(--text,#e9ecf5);' +
        'border-radius:8px;padding:8px 14px;font-size:13px;cursor:pointer;font-family:inherit;}' +
      '.p86-mappick-btn.primary{background:#4f8cff;border-color:#4f8cff;color:#fff;}' +
      '.p86-mappick-btn:disabled{opacity:.5;cursor:not-allowed;}' +
      'body.light-mode .p86-mappick-card{background:#fff;border-color:#d5dae5;}' +
      'body.light-mode .p86-mappick-hd h3,body.light-mode .p86-mappick-read b{color:#0f172a;}';
    document.head.appendChild(s);
  }

  function open(opts) {
    opts = opts || {};
    injectCss();
    return new Promise(function (resolve) {
      var chosen = null;      // {lat,lng}
      var settled = false;
      function finish(val) { if (settled) return; settled = true; cleanup(); resolve(val); }

      var back = document.createElement('div');
      back.className = 'p86-mappick-back';
      back.innerHTML =
        '<div class="p86-mappick-card" role="dialog" aria-modal="true">' +
          '<div class="p86-mappick-hd"><h3>' + esc(opts.title || 'Pick a location') + '</h3>' +
            '<button type="button" class="p86-mappick-x" data-x aria-label="Close">&times;</button></div>' +
          '<div class="p86-mappick-search"><div data-acmount></div></div>' +
          '<div class="p86-mappick-map" data-map></div>' +
          '<div class="p86-mappick-read" data-read>Loading map…</div>' +
          '<div class="p86-mappick-ft">' +
            '<span class="p86-mappick-hint">Tap the map or drag the pin to set the exact spot.</span>' +
            '<span><button type="button" class="p86-mappick-btn" data-cancel>Cancel</button> ' +
            '<button type="button" class="p86-mappick-btn primary" data-use disabled>Use this location</button></span>' +
          '</div>' +
        '</div>';
      document.body.appendChild(back);

      var mapEl = back.querySelector('[data-map]');
      var readEl = back.querySelector('[data-read]');
      var useBtn = back.querySelector('[data-use]');
      var acMount = back.querySelector('[data-acmount]');

      var onKey = function (e) { if (e.key === 'Escape') finish(null); };
      document.addEventListener('keydown', onKey, true);
      back.addEventListener('click', function (e) { if (e.target === back) finish(null); });
      back.querySelector('[data-x]').addEventListener('click', function () { finish(null); });
      back.querySelector('[data-cancel]').addEventListener('click', function () { finish(null); });

      var _cleanupFns = [];
      function cleanup() {
        document.removeEventListener('keydown', onKey, true);
        _cleanupFns.forEach(function (fn) { try { fn(); } catch (e) {} });
        if (back.parentNode) back.parentNode.removeChild(back);
      }

      if (!window.p86Maps || !window.p86Maps.ready) {
        readEl.textContent = 'Map unavailable on this device.';
        return;
      }

      window.p86Maps.ready().then(function (maps) {
        var start = usable(num(opts.lat), num(opts.lng)) ? { lat: num(opts.lat), lng: num(opts.lng) } : null;
        var fallback = usable(num(opts.fallbackLat), num(opts.fallbackLng))
          ? { lat: num(opts.fallbackLat), lng: num(opts.fallbackLng) } : null;
        var center = start || fallback || US_CENTER;
        var initialMarker = start || fallback || null; // suggest the job spot when no own pin

        var map = new maps.Map(mapEl, {
          center: center,
          zoom: (start || fallback) ? 18 : 4,
          mapTypeId: maps.MapTypeId.HYBRID,
          mapTypeControl: true,
          streetViewControl: false,
          fullscreenControl: false,
          gestureHandling: 'greedy'
        });
        // Force a resize once laid out so the map never renders as a grey box.
        setTimeout(function () { try { maps.event.trigger(map, 'resize'); map.setCenter(center); } catch (e) {} }, 60);

        var geocoder = null;
        try { geocoder = new maps.Geocoder(); } catch (e) { geocoder = null; }
        var marker = null;

        function reverseGeocode(lat, lng) {
          if (!geocoder) return;
          try {
            geocoder.geocode({ location: { lat: lat, lng: lng } }, function (res, status) {
              if (settled) return;
              if (status === 'OK' && res && res[0]) {
                chosen.address = res[0].formatted_address;
                readEl.innerHTML = '<b>' + esc(res[0].formatted_address) + '</b> · ' + lat.toFixed(6) + ', ' + lng.toFixed(6);
              }
            });
          } catch (e) {}
        }

        function setPoint(lat, lng, opt) {
          opt = opt || {};
          chosen = { lat: lat, lng: lng, address: '' };
          if (!marker) {
            marker = new maps.Marker({ position: { lat: lat, lng: lng }, map: map, draggable: true });
            marker.addListener('dragend', function (e) { setPoint(e.latLng.lat(), e.latLng.lng()); });
          } else {
            marker.setPosition({ lat: lat, lng: lng });
          }
          useBtn.disabled = false;
          readEl.innerHTML = '<b>' + lat.toFixed(6) + ', ' + lng.toFixed(6) + '</b>';
          if (opt.pan) map.panTo({ lat: lat, lng: lng });
          reverseGeocode(lat, lng);
        }

        // Seed the suggested marker (existing pin, or the job's location).
        if (initialMarker) {
          setPoint(initialMarker.lat, initialMarker.lng);
          readEl.innerHTML = (start ? 'Current pin — ' : 'Suggested (job location) — ') +
            '<b>' + initialMarker.lat.toFixed(6) + ', ' + initialMarker.lng.toFixed(6) + '</b>. Drag or tap to adjust.';
        } else if (opts.address && geocoder) {
          readEl.textContent = 'Tap the map to drop a pin.';
          try {
            geocoder.geocode({ address: String(opts.address) }, function (res, status) {
              if (settled) return;
              if (status === 'OK' && res && res[0] && res[0].geometry) {
                var loc = res[0].geometry.location;
                map.setCenter(loc); map.setZoom(17);
              }
            });
          } catch (e) {}
        } else {
          readEl.textContent = 'Tap the map to drop a pin.';
        }

        map.addListener('click', function (e) { setPoint(e.latLng.lat(), e.latLng.lng()); });

        // Address search inside the picker (reuse the Places helper).
        if (window.p86AddressAutocomplete && window.p86AddressAutocomplete.attach && acMount) {
          try {
            window.p86AddressAutocomplete.attach({
              mount: acMount,
              placeholder: 'Search an address…',
              onPlace: function (r) {
                if (r && r.lat != null && r.lng != null) setPoint(Number(r.lat), Number(r.lng), { pan: true });
                if (map && r && r.lat != null) map.setZoom(18);
              }
            });
          } catch (e) {}
        } else if (acMount) {
          acMount.parentNode.style.display = 'none';
        }

        useBtn.addEventListener('click', function () {
          if (chosen && usable(chosen.lat, chosen.lng)) finish({ lat: chosen.lat, lng: chosen.lng, address: chosen.address || '' });
        });
      }).catch(function (err) {
        readEl.textContent = 'Map failed to load: ' + ((err && err.message) || 'unknown error');
      });
    });
  }

  function esc(s) {
    if (typeof window.escapeHTML === 'function') return window.escapeHTML(s);
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  window.p86MapPicker = { open: open };
})();
