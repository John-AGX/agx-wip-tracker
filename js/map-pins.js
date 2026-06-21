// Map pins — Project 86 style teardrop markers, typed by entity.
//
// One shared classifier + SVG-pin builder used by every map surface
// (projects-map.js drives the Projects, Jobs, and Leads list maps).
// A pin's TYPE is derived from data we already have — no schema change:
//   • leads list   → 'lead'
//   • projects list→ 'project'
//   • jobs list    → job-number prefix (RV→reno, WO→wo, S→service),
//                    falling back to free-text jobType, else generic 'job'
// (matches getJobType() in jobs.js, the same logic the Jobs list filter uses).
//
// Each type maps to { color, icon } where icon is an agx-icons.js name, so
// pins are drawn from the app's own icon language. Orgs can re-skin any type
// from Admin → Organization → Map pins; the chosen config rides in
// organizations.branding.map_pins and is read back here via the
// already-all-readable GET /api/org/branding (so field crew see the org's
// pins too, not just admins). Missing config falls back to DEFAULTS.

(function () {
  'use strict';

  // Built-in defaults. Colors are straight from the P86 palette
  // (css/styles.css --accent/--green/--orange/--purple, plus slate/teal).
  var DEFAULTS = {
    lead:    { color: '#4f8cff', icon: 'leads' },
    service: { color: '#34d399', icon: 'wrench' },
    reno:    { color: '#fb923c', icon: 'buildings' },
    wo:      { color: '#a78bfa', icon: 'daily-logs' },
    job:     { color: '#94a3b8', icon: 'briefcase' },
    project: { color: '#2dd4bf', icon: 'folder' }
  };

  var TYPE_ORDER  = ['lead', 'service', 'reno', 'wo', 'job', 'project'];
  var TYPE_LABELS = {
    lead: 'Lead', service: 'Service job', reno: 'Reno',
    wo: 'Work order', job: 'Job', project: 'Project'
  };

  // Icon names offered in the admin picker — a curated slice of
  // agx-icons.js that reads well at pin size.
  var ICON_CHOICES = [
    'leads', 'wrench', 'buildings', 'daily-logs', 'briefcase', 'folder',
    'materials', 'phases', 'target', 'banknotes', 'scale', 'photos',
    'node-graph', 'links', 'conversations', 'bookmark', 'detective',
    'beaker', 'cube', 'globe', 'chart-bar', 'funnel', 'clients', 'subs',
    'id-card', 'schedule', 'estimates', 'admin'
  ];

  var HEX_RE = /^#[0-9a-f]{3,8}$/i;

  // Org overrides, loaded once from GET /api/org/branding. null = not yet
  // loaded → callers fall back to DEFAULTS until ensureConfig() resolves.
  var _orgCfg = null;
  var _loadPromise = null;

  // Merge the org overrides over the defaults, per type. Always returns a
  // full config for every known type.
  function getConfig() {
    var out = {};
    TYPE_ORDER.forEach(function (k) {
      var d = DEFAULTS[k];
      var o = (_orgCfg && _orgCfg[k]) || {};
      out[k] = {
        color: (typeof o.color === 'string' && HEX_RE.test(o.color)) ? o.color : d.color,
        icon: (typeof o.icon === 'string' && o.icon) ? o.icon : d.icon
      };
    });
    return out;
  }

  // Classify an entity row to a pin type key.
  function typeForEntity(entity, kind) {
    if (kind === 'lead' || kind === 'leads') return 'lead';
    if (kind === 'project' || kind === 'projects') return 'project';
    // jobs (and anything else) — derive the job sub-type.
    var num = String((entity && (entity.jobNumber || entity.job_number)) || '').toUpperCase().trim();
    if (num.indexOf('RV') === 0) return 'reno';
    if (num.indexOf('WO') === 0) return 'wo';
    if (num.charAt(0) === 'S') return 'service';
    var jt = String((entity && entity.jobType) || '').toLowerCase();
    if (jt.indexOf('reno') >= 0) return 'reno';
    if (jt.indexOf('work') >= 0) return 'wo';
    if (jt.indexOf('serv') >= 0) return 'service';
    return 'job';
  }

  // Build the teardrop pin SVG string. The glyph is the agx-icon of the
  // given name, nested (its own 0 0 24 24 viewBox scales cleanly) and
  // forced white. If the icon is unknown the pin still renders — just the
  // colored teardrop with a white outline.
  function pinSvgString(color, iconName) {
    var glyph = '';
    if (typeof window.p86Icon === 'function') {
      var g = window.p86Icon(iconName);
      if (g) {
        glyph = g
          .replace('<svg ', '<svg x="5.5" y="5.5" width="13" height="13" ')
          .replace(/currentColor/g, '#ffffff');
      }
    }
    return '<svg xmlns="http://www.w3.org/2000/svg" width="28" height="40" viewBox="0 0 24 34">' +
      '<defs><filter id="p" x="-30%" y="-30%" width="160%" height="160%">' +
        '<feDropShadow dx="0" dy="1" stdDeviation="1" flood-opacity="0.35"/>' +
      '</filter></defs>' +
      '<path d="M12 1.2C6.0 1.2 1.2 6.0 1.2 12c0 8 10.8 21 10.8 21S22.8 20 22.8 12C22.8 6.0 18.0 1.2 12 1.2Z" ' +
        'fill="' + color + '" stroke="#ffffff" stroke-width="1.6" filter="url(#p)"/>' +
      glyph +
    '</svg>';
  }

  // Google-Maps icon spec for a type key. `override` ({color, icon}) bypasses
  // the stored config — used by the admin live preview before saving.
  function specForType(typeKey, override) {
    var cfg = override || getConfig()[typeKey] || DEFAULTS.job;
    var svg = pinSvgString(cfg.color, cfg.icon);
    return {
      url: 'data:image/svg+xml;utf8,' + encodeURIComponent(svg),
      ax: 14, ay: 40, w: 28, h: 40  // anchor at the point (bottom-center)
    };
  }

  function specForEntity(entity, kind) {
    return specForType(typeForEntity(entity, kind));
  }

  // Raw pin SVG for inline display (admin preview / legend swatches).
  function previewSvg(typeKey, override) {
    var cfg = override || getConfig()[typeKey] || DEFAULTS.job;
    return pinSvgString(cfg.color, cfg.icon);
  }

  // Load the org's pin overrides once. Always resolves (errors → defaults).
  function ensureConfig() {
    if (_orgCfg !== null) return Promise.resolve();
    if (_loadPromise) return _loadPromise;
    var fetchBranding;
    if (window.p86Api && typeof window.p86Api.get === 'function') {
      fetchBranding = window.p86Api.get('/api/org/branding');
    } else {
      var tok = (window.p86Auth && window.p86Auth.getToken && window.p86Auth.getToken()) ||
                (function () { try { return localStorage.getItem('p86-auth-token'); } catch (e) { return ''; } })();
      fetchBranding = fetch('/api/org/branding', {
        headers: tok ? { Authorization: 'Bearer ' + tok } : {},
        credentials: 'same-origin'
      }).then(function (r) { return r.ok ? r.json() : {}; });
    }
    _loadPromise = fetchBranding.then(function (resp) {
      var mp = resp && resp.branding && resp.branding.map_pins;
      _orgCfg = (mp && typeof mp === 'object') ? mp : {};
    }).catch(function () {
      _orgCfg = {};
    });
    return _loadPromise;
  }

  // Push a fresh config in (admin Save) so open maps pick it up without a
  // reload, and reset the cache so the next ensureConfig() is a no-op.
  function setConfig(cfg) {
    _orgCfg = (cfg && typeof cfg === 'object') ? cfg : {};
    _loadPromise = Promise.resolve();
  }

  // ── Shared status encoding for EVERY map surface ──────────────────
  // Both the per-entity maps (projects-map.js list + info windows) and the
  // combined Summary map (entities-map.js) read status through here, so a
  // color means the same thing everywhere. Leads carry a pipeline status
  // (new→sold); projects/jobs fall back to recency. GREEN is reserved for
  // "sold" — recency never uses green (avoids "green = fresh" vs "green =
  // sold" clashing across surfaces).
  var LEAD_STATUS_COLORS = {
    'new': '#3b82f6', 'in_progress': '#06b6d4', 'sent': '#a855f7',
    'sold': '#22c55e', 'lost': '#ef4444', 'no_opportunity': '#64748b'
  };
  function leadPipeline(status) {
    if (!status) return null;
    var s = String(status).slice(0, 24);
    var c = LEAD_STATUS_COLORS[s];
    if (!c) return null;
    return { color: c, label: s.replace(/_/g, ' ') };
  }
  function recencyColor(updatedAt, archivedAt) {
    if (archivedAt) return '#475569';        // archived — dark slate
    var u = updatedAt ? new Date(updatedAt).getTime() : 0;
    var ageDays = (Date.now() - u) / 86400000;
    if (ageDays <= 7) return '#22d3ee';      // fresh — accent cyan (NOT green)
    return '#94a3b8';                        // aging — slate
  }
  // Dot color for any entity: a lead's pipeline color when it has a real
  // pipeline status, else recency.
  function statusDotColor(entity) {
    entity = entity || {};
    var pl = leadPipeline(entity.status);
    return pl ? pl.color : recencyColor(entity.updated_at, entity.archived_at);
  }
  window.p86MapStatus = {
    LEAD_STATUS_COLORS: LEAD_STATUS_COLORS,
    pipeline: leadPipeline,
    recency: recencyColor,
    dotColor: statusDotColor
  };

  window.p86MapPins = {
    DEFAULTS: DEFAULTS,
    TYPE_ORDER: TYPE_ORDER,
    TYPE_LABELS: TYPE_LABELS,
    ICON_CHOICES: ICON_CHOICES,
    getConfig: getConfig,
    typeForEntity: typeForEntity,
    specForType: specForType,
    specForEntity: specForEntity,
    previewSvg: previewSvg,
    ensureConfig: ensureConfig,
    setConfig: setConfig
  };
})();
