/* Project 86 — settings registry renderer + the Markets pane.
   ─────────────────────────────────────────────────────────────
   window.p86Settings.renderForm(host, spec, values, onSave)
   window.renderAdminMarkets()            — the pane, first consumer

   The form is GENERIC: it renders whatever the server's settings registry
   declares, grouped, typed. Nothing here knows what a market is. Adding a
   setting to a feature is a declaration in
   server/services/settings-registry.js — not a form to hand-build — which
   is the whole point: the reason so much shipped with no settings is that
   every one used to cost a UI.

   The same declaration the server validates against is the one the client
   renders from, so a field cannot drift into rendering, submitting, and
   being silently dropped. */
(function () {
  'use strict';
  if (window.p86Settings) return;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  var TZ = ['America/New_York', 'America/Chicago', 'America/Denver',
            'America/Phoenix', 'America/Los_Angeles'];

  function injectStyle() {
    if (document.getElementById('p86set-style')) return;
    var s = document.createElement('style');
    s.id = 'p86set-style';
    s.textContent = [
      '.p86set-grp{margin:0 0 18px;}',
      '.p86set-grph{font-size:9px;letter-spacing:1.1px;text-transform:uppercase;font-weight:600;',
      'color:var(--text-dim,#7f8699);margin:0 0 8px;}',
      '.p86set-fields{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,230px),1fr));gap:10px;}',
      '.p86set-f{min-width:0;display:flex;flex-direction:column;gap:4px;}',
      '.p86set-l{font-size:11px;color:var(--text-dim,#9aa0b4);text-transform:none;letter-spacing:normal;',
      'font-weight:500;margin:0;}',
      '.p86set-f input,.p86set-f select{width:100%;font-size:12.5px;}',
      '.p86set-h{font-size:10.5px;color:var(--text-dim,#7f8699);line-height:1.35;}',
      '.p86set-h.warn{color:#c79a4e;}',
      '.p86set-bar{display:flex;align-items:center;gap:10px;margin-top:4px;}',
      '.p86set-msg{font-size:11.5px;color:var(--text-dim,#7f8699);}',
      '.p86set-msg.ok{color:var(--green,#34d399);} .p86set-msg.bad{color:var(--red,#f87171);}',
      // markets list
      '.p86mk-list{display:flex;flex-direction:column;gap:6px;margin-bottom:14px;}',
      '.p86mk-row{display:flex;align-items:center;gap:11px;padding:9px 11px;border-radius:8px;cursor:pointer;',
      'background:var(--card-bg,#12151f);border:1px solid var(--border,#2a2f3e);font-size:12.5px;}',
      '.p86mk-row:hover{border-color:#3c465c;}',
      '.p86mk-row.on{border-color:#3f6bb8;background:var(--surface2,#151d2c);}',
      '.p86mk-sw{width:9px;height:9px;border-radius:2px;flex:0 0 auto;}',
      '.p86mk-nm{font-weight:600;color:var(--text,#e9ecf5);}',
      '.p86mk-cd{color:var(--text-dim,#7f8699);font-size:11px;}',
      '.p86mk-sp{flex:1;}',
      '.p86mk-done{font-size:10.5px;font-variant-numeric:tabular-nums;color:var(--text-dim,#7f8699);}',
      '.p86mk-done.gap{color:#f4cf94;}'
    ].join('');
    document.head.appendChild(s);
  }

  // ── generic field render ────────────────────────────────────────────
  function field(s, v) {
    var id = 'set_' + s.key;
    var val = (v == null ? '' : v);
    var input;
    if (s.type === 'tz') {
      input = '<select id="' + id + '" data-k="' + esc(s.key) + '">' +
        TZ.map(function (z) {
          return '<option value="' + esc(z) + '"' + (String(val) === z ? ' selected' : '') + '>' + esc(z) + '</option>';
        }).join('') +
        (TZ.indexOf(String(val)) < 0 && val ? '<option value="' + esc(val) + '" selected>' + esc(val) + '</option>' : '') +
        '</select>';
    } else if (s.type === 'bool') {
      input = '<input type="checkbox" id="' + id + '" data-k="' + esc(s.key) + '"' + (val ? ' checked' : '') + '>';
    } else if (s.type === 'date') {
      // Date values arrive as full ISO from Postgres; the input needs the
      // date part only or it silently refuses to populate.
      input = '<input type="date" id="' + id + '" data-k="' + esc(s.key) + '" value="' +
        esc(String(val).slice(0, 10)) + '">';
    } else if (s.type === 'color') {
      input = '<input type="text" id="' + id + '" data-k="' + esc(s.key) + '" value="' + esc(val) + '" placeholder="#378add">';
    } else if (s.type === 'number' || s.type === 'money' || s.type === 'percent') {
      input = '<input type="number" step="any" id="' + id + '" data-k="' + esc(s.key) + '" value="' + esc(val) + '"' +
        (s.type === 'percent' ? ' placeholder="whole points, e.g. 7"' : '') + '>';
    } else {
      input = '<input type="text" id="' + id + '" data-k="' + esc(s.key) + '" value="' + esc(val) + '"' +
        (s.max ? ' maxlength="' + s.max + '"' : '') + '>';
    }
    var warn = s.help && /NOT YET APPLIED/i.test(s.help);
    return '<div class="p86set-f"><label class="p86set-l" for="' + id + '">' + esc(s.label) +
      (s.required ? ' *' : '') + '</label>' + input +
      (s.help ? '<div class="p86set-h' + (warn ? ' warn' : '') + '">' + esc(s.help) + '</div>' : '') +
      '</div>';
  }

  /** Render a registry spec as a grouped form. onSave(patch) -> Promise. */
  function renderForm(host, spec, values, onSave) {
    if (!host || !spec) return;
    injectStyle();
    values = values || {};
    var html = spec.groups.map(function (g) {
      var fields = spec.settings.filter(function (s) { return s.group === g; });
      if (!fields.length) return '';
      return '<div class="p86set-grp"><div class="p86set-grph">' + esc(g) + '</div>' +
        '<div class="p86set-fields">' + fields.map(function (s) { return field(s, values[s.key]); }).join('') +
        '</div></div>';
    }).join('');
    html += '<div class="p86set-bar"><button type="button" class="ee-btn" id="p86set-save">Save</button>' +
      '<span class="p86set-msg" id="p86set-msg"></span></div>';
    host.innerHTML = html;

    host.querySelector('#p86set-save').addEventListener('click', function () {
      var msg = host.querySelector('#p86set-msg');
      var patch = {};
      spec.settings.forEach(function (s) {
        var el = host.querySelector('[data-k="' + s.key + '"]');
        if (!el) return;
        patch[s.key] = (s.type === 'bool') ? el.checked : el.value;
      });
      msg.className = 'p86set-msg'; msg.textContent = 'Saving…';
      Promise.resolve(onSave(patch)).then(function () {
        msg.className = 'p86set-msg ok'; msg.textContent = 'Saved';
        setTimeout(function () { if (msg) msg.textContent = ''; }, 2500);
      }).catch(function (e) {
        msg.className = 'p86set-msg bad';
        msg.textContent = (e && e.message) || 'Save failed';
      });
    });
  }

  // ── Markets pane — the registry's first consumer ────────────────────
  var _spec = null, _markets = [], _openId = null;

  function completeness(m) {
    if (!_spec) return null;
    var optional = _spec.settings.filter(function (s) { return !s.required; });
    var set = optional.filter(function (s) {
      var v = m[s.key];
      return v !== null && v !== undefined && v !== '';
    }).length;
    return { set: set, total: optional.length };
  }

  function paint() {
    var host = document.getElementById('admin-markets-host');
    if (!host) return;
    injectStyle();
    var rows = _markets.map(function (m) {
      var c = completeness(m);
      var gap = c && c.set === 0;
      return '<div class="p86mk-row' + (String(_openId) === String(m.id) ? ' on' : '') + '" data-id="' + esc(m.id) + '">' +
        '<span class="p86mk-sw" style="background:' + esc(m.color || '#4f8cff') + '"></span>' +
        '<span class="p86mk-nm">' + esc(m.name) + '</span>' +
        '<span class="p86mk-cd">' + esc(m.code || '') + (m.state ? ' · ' + esc(m.state) : '') + '</span>' +
        '<span class="p86mk-sp"></span>' +
        (c ? '<span class="p86mk-done' + (gap ? ' gap' : '') + '">' + c.set + ' / ' + c.total + ' set</span>' : '') +
        '</div>';
    }).join('');
    host.innerHTML = '<div class="p86mk-list">' + rows + '</div><div id="admin-market-form"></div>';

    host.querySelector('.p86mk-list').addEventListener('click', function (e) {
      var r = e.target.closest('.p86mk-row'); if (!r) return;
      var id = r.getAttribute('data-id');
      _openId = (String(_openId) === String(id)) ? null : id;
      paint();
    });

    if (_openId) {
      var m = _markets.filter(function (x) { return String(x.id) === String(_openId); })[0];
      var formHost = document.getElementById('admin-market-form');
      if (m && formHost && _spec) {
        renderForm(formHost, _spec, m, function (patch) {
          return window.p86Api.patch('/api/markets/' + encodeURIComponent(m.id), patch)
            .then(function (res) {
              // Re-read from the SERVER's response, not the patch we sent —
              // it coerces types and nulls blanks, so echoing the form back
              // would show values the database does not actually hold.
              var saved = (res && res.market) || null;
              if (saved) {
                _markets = _markets.map(function (x) {
                  return String(x.id) === String(saved.id) ? saved : x;
                });
              }
              paint();
            });
        });
      }
    }
  }

  function render() {
    var host = document.getElementById('admin-markets-host');
    if (!host) return;
    host.innerHTML = '<div class="p86set-msg">Loading markets…</div>';
    Promise.all([
      window.p86Api.get('/api/markets/registry'),
      window.p86Api.get('/api/markets?include_inactive=true')
    ]).then(function (r) {
      _spec = r[0];
      _markets = (r[1] && (r[1].markets || r[1])) || [];
      if (!Array.isArray(_markets)) _markets = [];
      paint();
    }).catch(function (e) {
      host.innerHTML = '<div class="p86set-msg bad">Could not load markets: ' +
        esc((e && e.message) || 'error') + '</div>';
    });
  }

  window.p86Settings = { renderForm: renderForm, injectStyle: injectStyle };
  window.renderAdminMarkets = render;
})();
