// Site Conditions — what a foreman reads at 6am.
//
// This replaces a 7-card forecast strip whose whole vocabulary was an emoji, a
// high, a low and a precip percentage. In a Florida summer that strip said
// "thunderstorms, 40%" every single day from June to September, which is both
// true and useless: the same day is ALSO mostly sunny, and the 40% is a 40%
// chance of less than a tenth of an inch.
//
// The fix is not a nicer icon. NWS hands us two descriptions of the same period
// and the strip rendered the less useful one:
//
//   shortForecast   "Scattered Showers And Thunderstorms"
//   detailedForecast "…Mostly sunny, with a high near 90. Heat index values as
//                     high as 103. Southwest wind around 7 mph. …New rainfall
//                     amounts less than a tenth of an inch possible."
//
// and the raw gridpoint feed carries the numbers underneath it — sky cover,
// gusts, wet-bulb globe temperature, dew point, thunder probability — none of
// which the old card fetched at all.
//
// THE RECOMMENDATIONS ARE ADVISORY AND SAY SO. Of the four trades here exactly
// one has a defensible numeric cutoff a forecast can compute (wind, against
// OSHA's high-wind definition). Lightning cannot be cleared by a 6am forecast;
// roof-deck surface temperature is not published by anyone; paint limits are
// product-specific and differ by 15°F across three real data sheets. So every
// chip shows THE NUMBER THAT DROVE IT and the panel says out loud that the call
// belongs to the person on site. A confident chip that is wrong once teaches a
// crew to ignore it forever.
(function () {
  'use strict';

  function esc(s) {
    return (typeof window.escapeHTML === 'function')
      ? window.escapeHTML(s)
      : String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
          return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
  }
  function n(v) { return (v == null || isNaN(v)) ? null : Number(v); }
  function or(v, fallback) { return (v == null) ? fallback : v; }

  // ── sky, said plainly ────────────────────────────────────────────────
  // From skyCover PERCENT, not from prose. The old card keyword-matched the
  // summary string, which is why "Scattered Showers And Thunderstorms" always
  // won over the "Mostly sunny" sitting in the detailed text.
  // NWS's DAYTIME bands. It words day periods on a sun scale (Sunny / Mostly
  // sunny / Partly sunny) and night periods on a sky scale (Clear / Mostly
  // clear / Partly cloudy), and the two are NOT the same cutoffs — the
  // night-time table calls 40% "partly cloudy" while the daytime one calls it
  // "mostly sunny". Cross-checked against a live Tampa grid: 40% mean sky
  // cover, NWS's own detailedForecast for that period reads "Mostly sunny".
  // Using the night table here would print "Partly cloudy" directly beside an
  // NWS line saying the opposite, and the panel would lose the argument.
  function skyWord(pct) {
    if (pct == null) return null;
    if (pct <= 25) return 'Sunny';
    if (pct <= 50) return 'Mostly sunny';
    if (pct <= 69) return 'Partly sunny';
    if (pct <= 87) return 'Mostly cloudy';
    return 'Overcast';
  }

  // The precip half, kept SEPARATE from the sky half — that separation is the
  // entire point. "Mostly sunny · scattered storms" is two facts about one day
  // and the card could only ever show one of them.
  function precipPhrase(d) {
    var s = d.site || {};
    var pct = n(or(s.precipPct, d.precipPct));
    if (pct == null || pct < 10) return null;
    var thunder = n(s.thunderPct);
    var inches = n(s.precipIn);
    // NWS's coverage vocabulary, by probability.
    // NWS's own coverage vocabulary by probability, so the panel says the
    // same word the forecast discussion does rather than inventing a scale.
    var cover = pct >= 80 ? 'widespread' : (pct >= 55 ? 'numerous' : (pct >= 25 ? 'scattered' : 'isolated'));
    var what = (thunder != null && thunder >= 25) ? 'storms' : 'showers';
    var txt = cover + ' ' + what + ' ' + pct + '%';
    // A tenth of an inch is not a washout, and saying so is most of the value:
    // it is the difference between "lost the day" and "lost twenty minutes".
    if (inches != null && inches > 0 && inches < 0.1) txt += ' (<0.1")';
    else if (inches != null && inches >= 0.1) txt += ' (' + inches.toFixed(2) + '")';
    return txt;
  }

  // ── advisories ───────────────────────────────────────────────────────
  // Each returns { level: 'good'|'watch'|'poor', why } where `why` ALWAYS
  // carries the number. A verdict with no number is not reviewable.
  //
  // Sources, so these can be argued with rather than trusted:
  //   wind      OSHA 29 CFR 1926 high-wind definition — 40 mph, or 30 mph when
  //             moving or hoisting material.
  //   lightning NOAA 30-30. A forecast cannot clear a cell; probability of
  //             thunder is a planning signal, never an all-clear.
  //   coating   Dew-point spread ≥5°F and RH ≤85% is the common floor across
  //             major manufacturer data sheets; exact minimum air temperature
  //             is product-specific (35/40/50°F seen across three).
  //   concrete  ACI 306 cold-weather below 40°F, ACI 305 hot-weather above 90°F.
  var TRADES = [
    {
      key: 'roofing', label: 'Roofing',
      rule: function (s) {
        var g = n(s.windGustMph), t = n(s.thunderPct), hi = n(s.heatIndexF);
        if (g != null && g >= 30) return { level: 'poor', why: 'gusts ' + g + ' mph' };
        if (t != null && t >= 40) return { level: 'poor', why: t + '% thunder — no forecast clears a cell' };
        if (t != null && t >= 20) return { level: 'watch', why: t + '% thunder' };
        if (g != null && g >= 20) return { level: 'watch', why: 'gusts ' + g + ' mph' };
        if (hi != null && hi >= 103) return { level: 'watch', why: 'heat index ' + hi + '° — deck runs hotter' };
        return { level: 'good', why: g != null ? 'gusts ' + g + ' mph' : 'no wind flag' };
      }
    },
    {
      key: 'paint', label: 'Paint & coatings',
      rule: function (s) {
        var spread = n(s.dewSpreadF), rh = n(s.humidityMaxPct), pct = n(s.precipPct), t = n(s.workTempMinF);
        // The spread rule is the one that actually catches people, and it is
        // the one nobody can eyeball. NOTE it is computed from AIR temp — a
        // shaded wall at dawn is colder than the air, so this reads optimistic.
        // A spread of zero or below is not "close to" the dew point — it is AT
        // it, which means dew forms on the surface rather than merely risking
        // it. Computed worst-case (coldest working-hour air against the highest
        // dew point), which is the right way round for an advisory.
        if (spread != null && spread <= 0) return { level: 'poor', why: 'air reaches the dew point (' + spread + '°) — surface will be wet' };
        if (spread != null && spread < 5) return { level: 'poor', why: 'dew spread ' + spread + '° — surface may sweat' };
        if (rh != null && rh > 85) return { level: 'poor', why: 'RH ' + rh + '%' };
        if (pct != null && pct >= 50) return { level: 'poor', why: pct + '% rain inside the cure window' };
        if (t != null && t < 50) return { level: 'watch', why: t + '° — check the product minimum' };
        if (spread != null && spread < 10) return { level: 'watch', why: 'dew spread ' + spread + '°' };
        if (pct != null && pct >= 25) return { level: 'watch', why: pct + '% rain' };
        return { level: 'good', why: spread != null ? 'dew spread ' + spread + '°' : 'no moisture flag' };
      }
    },
    {
      key: 'height', label: 'Gutters · siding · soffit',
      rule: function (s) {
        // Ladder and lift work. OSHA sets no single numeric ladder wind limit;
        // 30 mph is the hoisting/material threshold and the common site rule.
        var g = n(s.windGustMph), t = n(s.thunderPct);
        if (g != null && g >= 30) return { level: 'poor', why: 'gusts ' + g + ' mph' };
        if (t != null && t >= 40) return { level: 'poor', why: t + '% thunder' };
        if (g != null && g >= 20) return { level: 'watch', why: 'gusts ' + g + ' mph' };
        if (t != null && t >= 20) return { level: 'watch', why: t + '% thunder' };
        return { level: 'good', why: g != null ? 'gusts ' + g + ' mph' : 'no wind flag' };
      }
    },
    {
      key: 'concrete', label: 'Concrete · stucco',
      rule: function (s) {
        var lo = n(s.workTempMinF), hi = n(s.workTempMaxF), pct = n(s.precipPct), rh = n(s.humidityMinPct), g = n(s.windMph);
        if (pct != null && pct >= 50) return { level: 'poor', why: pct + '% rain before set' };
        if (lo != null && lo < 40) return { level: 'poor', why: lo + '° — below ACI 306 cold-weather' };
        if (hi != null && hi > 90) return { level: 'watch', why: hi + '° — ACI 305 hot-weather' };
        // Plastic-shrinkage conditions: hot + dry + windy together.
        if (hi != null && hi > 85 && rh != null && rh < 50 && g != null && g >= 10) {
          return { level: 'watch', why: 'fast evaporation — ' + hi + '°, RH ' + rh + '%, wind ' + g };
        }
        if (pct != null && pct >= 25) return { level: 'watch', why: pct + '% rain' };
        return { level: 'good', why: hi != null ? hi + '° air' : 'no temperature flag' };
      }
    }
  ];

  var LEVEL = {
    good:  { dot: '●', color: '#34d399', word: 'Good' },
    watch: { dot: '●', color: '#fbbf24', word: 'Watch' },
    poor:  { dot: '●', color: '#f87171', word: 'Poor' }
  };

  function adviceHTML(day) {
    var s = day && day.site;
    if (!s) return '';
    var rows = TRADES.map(function (t) {
      var r;
      try { r = t.rule(s); } catch (e) { r = null; }
      if (!r) return '';
      var L = LEVEL[r.level] || LEVEL.good;
      return '<div class="p86-sc-advice-row">' +
        '<span class="p86-sc-advice-trade">' + esc(t.label) + '</span>' +
        '<span class="p86-sc-advice-verdict" style="color:' + L.color + ';">' + L.dot + ' ' + L.word + '</span>' +
        '<span class="p86-sc-advice-why">' + esc(r.why) + '</span>' +
      '</div>';
    }).join('');
    return '<div class="p86-sc-advice">' + rows +
      '<div class="p86-sc-advice-foot">Guidance only, from the forecast — the call belongs to whoever is on site. ' +
      'Lightning and surface temperature can’t be forecast away.</div>' +
    '</div>';
  }

  // ── today ────────────────────────────────────────────────────────────
  function statHTML(icon, label, value, title) {
    if (value == null || value === '') return '';
    return '<div class="p86-sc-stat"' + (title ? ' title="' + esc(title) + '"' : '') + '>' +
      '<span class="p86-sc-stat-i">' + icon + '</span>' +
      '<span class="p86-sc-stat-v">' + esc(value) + '</span>' +
      '<span class="p86-sc-stat-l">' + esc(label) + '</span>' +
    '</div>';
  }

  function todayHTML(day, uv) {
    if (!day) return '';
    var s = day.site || {};
    var sky = skyWord(n(s.skyCoverMeanPct != null ? s.skyCoverMeanPct : s.skyCoverMaxPct));
    var wet = precipPhrase(day);
    // BOTH halves, which is the whole reason this panel exists.
    var headline = [sky, wet].filter(Boolean).join(' · ') || day.summary || '';

    var hi = n(or(s.tempMaxF, day.tempHigh));
    var lo = n(or(s.tempMinF, day.tempLow));
    var feels = n(s.heatIndexF);

    var wind = null;
    if (s.windGustMph != null) wind = s.windMph + '–' + s.windGustMph + ' mph';
    else if (s.windMph != null) wind = s.windMph + ' mph';
    else if (day.windMph != null) wind = day.windMph + ' mph';
    var windLabel = s.windDir ? ('wind ' + s.windDir) : 'wind';

    return '<div class="p86-sc-today">' +
      '<div class="p86-sc-headline">' + esc(headline) + '</div>' +
      '<div class="p86-sc-temps">' +
        (hi != null ? '<span class="p86-sc-hi">' + hi + '°</span>' : '') +
        (lo != null ? '<span class="p86-sc-lo">/ ' + lo + '°</span>' : '') +
        (feels != null && hi != null && Math.abs(feels - hi) >= 3
          ? '<span class="p86-sc-feels">feels ' + feels + '°</span>' : '') +
      '</div>' +
      '<div class="p86-sc-stats">' +
        statHTML('&#x1F4A8;', windLabel, wind, 'Sustained–gust during working hours') +
        statHTML('&#x26A1;', 'thunder', s.thunderPct != null ? s.thunderPct + '%' : null, 'Probability of thunder, working hours') +
        statHTML('&#x1F4A7;', 'humidity', s.humidityMaxPct != null ? s.humidityMinPct + '–' + s.humidityMaxPct + '%' : null) +
        statHTML('&#x1F321;', 'dew spread', s.dewSpreadF != null ? s.dewSpreadF + '°' : null,
                 'Air temperature above the dew point. Under 5° and coatings can sweat. Computed from AIR temp — a shaded surface runs colder.') +
        (uv && uv.peak != null
          ? statHTML('&#x2600;', uvWord(uv.peak) + (uv.peakHour ? ' @' + uv.peakHour : ''), 'UV ' + uv.peak, 'Peak UV index today (EPA)')
          : '') +
        statHTML('&#x1F441;', 'visibility', s.visibilityMi != null ? (s.visibilityMi >= 10 ? '10+ mi' : s.visibilityMi + ' mi') : null) +
      '</div>' +
    '</div>';
  }

  function uvWord(v) {
    if (v == null) return '';
    if (v <= 2) return 'Low';
    if (v <= 5) return 'Moderate';
    if (v <= 7) return 'High';
    if (v <= 10) return 'Very high';
    return 'Extreme';
  }

  // ── alerts ───────────────────────────────────────────────────────────
  function alertsHTML(alerts) {
    if (!alerts || !alerts.length) return '';
    return alerts.slice(0, 3).map(function (a) {
      var severe = /extreme|severe/i.test(a.severity || '');
      return '<div class="p86-sc-alert' + (severe ? ' p86-sc-alert-severe' : '') + '"' +
        (a.what ? ' title="' + esc(a.what) + '"' : '') + '>' +
        '<strong>' + esc(a.event) + '</strong>' +
        (a.headline ? '<span class="p86-sc-alert-when">' + esc(shortHeadline(a.headline)) + '</span>' : '') +
      '</div>';
    }).join('');
  }

  // NWS headlines read "Heat Advisory issued September 12 at 3:52AM EDT until
  // September 12 at 8:00PM EDT by NWS Tampa Bay" — the "until" half is the part
  // anyone needs.
  function shortHeadline(h) {
    var m = /until\s+(.+?)(?:\s+by\s+NWS.*)?$/i.exec(String(h));
    return m ? 'until ' + m[1] : String(h).replace(/\s+by\s+NWS.*$/i, '');
  }

  // ── the 7-day list, vertical ─────────────────────────────────────────
  // For a narrow side rail (the job overview is ~300px), where seven columns
  // would be seven illegible slivers. Same facts, one row per day, and the sky
  // word gets room to be a word rather than an abbreviation.
  function listHTML(days) {
    return '<div class="p86-sc-list">' + days.slice(0, 7).map(function (d) {
      var p = String(d.date || '').split('-');
      var dt = (p.length === 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
      var dow = dt ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : '';
      var s = d.site || {};
      var sky = skyWord(n(s.skyCoverMeanPct != null ? s.skyCoverMeanPct : s.skyCoverMaxPct));
      var pct = n(or(s.precipPct, d.precipPct));
      var border = d.risk === 'red' ? '#f87171' : (d.risk === 'yellow' ? '#fbbf24' : 'transparent');
      var hasAlert = d.alerts && d.alerts.length;
      return '<div class="p86-sc-lrow" style="border-left-color:' + border + ';" title="' +
          esc([d.summary, sky].filter(Boolean).join(' — ')) + '">' +
        '<span class="p86-sc-lrow-day">' + esc(dow) + ' ' +
          (dt ? (dt.getMonth() + 1) + '/' + dt.getDate() : '') +
          (hasAlert ? ' <span style="color:#f87171;">!</span>' : '') + '</span>' +
        '<span class="p86-sc-lrow-sky">' + esc(sky || d.summary || '') + '</span>' +
        '<span class="p86-sc-lrow-temp">' +
          (d.tempHigh != null ? '<strong>' + d.tempHigh + '°</strong>' : '—') +
          (d.tempLow != null ? ' <span class="p86-sc-lrow-lo">' + d.tempLow + '°</span>' : '') +
        '</span>' +
        '<span class="p86-sc-lrow-pop">' + (pct ? pct + '%' : '') + '</span>' +
      '</div>';
    }).join('') + '</div>';
  }

  // ── the 7-day strip ──────────────────────────────────────────────────
  function stripHTML(days) {
    return '<div class="p86-sc-strip">' + days.slice(0, 7).map(function (d) {
      // Calendar day, built from parts — never new Date(iso), which is UTC
      // midnight and renders the day before anywhere west of Greenwich.
      var p = String(d.date || '').split('-');
      var dt = (p.length === 3) ? new Date(+p[0], +p[1] - 1, +p[2]) : null;
      var dow = dt ? ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][dt.getDay()] : '';
      var s = d.site || {};
      var sky = skyWord(n(s.skyCoverMeanPct != null ? s.skyCoverMeanPct : s.skyCoverMaxPct));
      var pct = n(or(s.precipPct, d.precipPct));
      var border = d.risk === 'red' ? '#f87171' : (d.risk === 'yellow' ? '#fbbf24' : 'var(--border,#333)');
      var hasAlert = d.alerts && d.alerts.length;
      return '<div class="p86-sc-day" style="border-top-color:' + border + ';" title="' +
          esc([d.summary, sky].filter(Boolean).join(' — ')) + '">' +
        '<div class="p86-sc-day-dow">' + esc(dow) + (hasAlert ? ' <span style="color:#f87171;">!</span>' : '') + '</div>' +
        '<div class="p86-sc-day-sky">' + esc(sky ? sky.replace('Mostly ', 'M. ').replace('Partly ', 'P. ') : '—') + '</div>' +
        '<div class="p86-sc-day-hi">' + (d.tempHigh != null ? d.tempHigh + '°' : '—') + '</div>' +
        '<div class="p86-sc-day-lo">' + (d.tempLow != null ? d.tempLow + '°' : '') + '</div>' +
        (pct ? '<div class="p86-sc-day-pop">' + pct + '%</div>' : '<div class="p86-sc-day-pop">&nbsp;</div>') +
        '<div class="p86-sc-day-date">' + (dt ? (dt.getMonth() + 1) + '/' + dt.getDate() : '') + '</div>' +
      '</div>';
    }).join('') + '</div>';
  }

  // ── UV, fetched client-side ──────────────────────────────────────────
  // EPA Envirofacts: US government public data, no key, and it sends
  // Access-Control-Allow-Origin: *, so the browser can call it directly and a
  // UV outage cannot delay or fail the forecast request.
  //
  // NOT Open-Meteo, which is the technically nicer API (lat/lng instead of ZIP,
  // hourly, handles America/Phoenix): its free tier is explicitly
  // NON-COMMERCIAL, and this is a commercial ERP.
  //
  // Keys on ZIP, which the lead already stores. No ZIP, no UV stat — the panel
  // simply omits it rather than showing a blank.
  var _uvCache = {};
  function fetchUV(zip) {
    zip = String(zip || '').trim().slice(0, 5);
    if (!/^\d{5}$/.test(zip)) return Promise.resolve(null);
    if (_uvCache[zip]) return Promise.resolve(_uvCache[zip]);
    return fetch('https://data.epa.gov/efservice/getEnvirofactsUVHOURLY/ZIP/' + zip + '/JSON',
                 { signal: AbortSignal.timeout(4000) })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (rows) {
        if (!Array.isArray(rows) || !rows.length) return null;
        var peak = null;
        rows.forEach(function (r) {
          var v = Number(r.UV_VALUE);
          if (isNaN(v)) return;
          if (!peak || v > peak.v) {
            // The DATE_TIME date component is internally inconsistent in this
            // feed (evening rows carry the previous day's date), so only the
            // time-of-day half is trusted.
            var t = /(\d+)\s*(AM|PM)/i.exec(String(r.DATE_TIME) || '');
            peak = { v: v, hour: t ? (Number(t[1]) + t[2].toLowerCase()) : null };
          }
        });
        if (!peak) return null;
        var out = { peak: peak.v, peakHour: peak.hour };
        _uvCache[zip] = out;
        return out;
      })
      .catch(function () { return null; });
  }

  // ── the panel ────────────────────────────────────────────────────────
  function render(host, w, opts) {
    opts = opts || {};
    if (!host) return;
    if (!w || w.status !== 'ok' || !Array.isArray(w.days) || !w.days.length) return false;

    var today = w.days[0];
    // compact = a narrow side rail (the job overview is ~300px). Seven columns
    // there are seven illegible slivers, so the days stack instead.
    var compact = !!opts.compact;
    var paint = function (uv) {
      host.innerHTML =
        alertsHTML(w.alerts) +
        todayHTML(today, uv) +
        adviceHTML(today) +
        (compact ? listHTML(w.days) : stripHTML(w.days)) +
        // Say when the grid did not arrive rather than quietly showing a
        // thinner panel that looks complete.
        ((w.sources && w.sources.grid && !w.sources.grid.ok)
          ? '<div class="p86-sc-degraded">Detailed conditions unavailable right now — showing the basic forecast.</div>'
          : '');
    };
    paint(null);
    if (opts.zip) fetchUV(opts.zip).then(function (uv) { if (uv) paint(uv); });
    return true;
  }

  window.p86SiteConditions = {
    render: render,
    // Exposed for tests — these are the two that turn a number into advice.
    skyWord: skyWord,
    precipPhrase: precipPhrase,
    advise: function (site) {
      var out = {};
      TRADES.forEach(function (t) { out[t.key] = t.rule(site); });
      return out;
    }
  };
})();
